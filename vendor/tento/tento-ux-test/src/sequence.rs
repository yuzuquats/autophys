//! A test as a high-level sequence diagram, and a run as the same diagram
//! with its divergences marked.
//!
//! A spec already says, in pieces, what a run should look like: the runner
//! presses these things in this order (`steps[].actions`), the page should say
//! these things after that step, in order (`success_log`, then `logs`), and
//! never that (`failure_log`), and
//! across the run these logs must appear, in this order, and these must not
//! (`verification`). Read as prose it is a checklist; drawn as three lifelines
//! — runner, page, server — it is the conversation the test expects. That is
//! [`expected`].
//!
//! A run is the conversation that actually happened: when each action ran
//! (`steps.json`, the runner's record), and what the page and server said
//! (`logs.ljson`, `server.ljson`). [`compare`] lays the two on one diagram. An
//! expectation the run met keeps its place and gets a tick; one it missed is
//! drawn where it should have been, marked missing; something the spec forbids
//! is drawn where it happened, marked unexpected; the action that threw is the
//! failure point, and everything planned after it is not reached. A reader
//! scrolls to the first mark instead of reading 400 log rows to find it.
//!
//! **One diagram: the spec's.** Every row is a message the spec declares; the
//! run only overlays its marks on them. What the run did that the spec says
//! nothing about is not drawn — the log view holds it, one click away —
//! except where it is a mismatch: a forbidden log, or an error the spec does
//! not tolerate. A step the spec gives no log to is a gap nothing can
//! confirm, and is drawn as one, so the way to a clean diagram is to log the
//! step in the app and declare it in the spec.
//!
//! **Matching is the judge's.** Every pattern goes through
//! [`crate::orchestration`]'s matcher, so a tick here and a pass in
//! `verification.json` cannot disagree about what a pattern means.
//!
//! **Clocks.** The runner and the page share a machine, so an action and the
//! log it caused order correctly. Server spans are on the server's clock and
//! are placed by it; on a remote target a server row can land a step early or
//! late by the skew.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tento_logger::ljson::{LjsonEntry, LjsonLevel};
use tento_openapi::ToSchema;

use crate::orchestration::{
  entry_matches_pattern, is_http_pattern, navigation_aborted_call, pattern_matches,
};
use crate::spec::{ExecutableAction, LogPattern, TestSpec};

/// One lifeline.
#[derive(Serialize, ToSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Lane {
  /// The headless runner, or the person following the steps.
  Runner,
  /// The app in the browser.
  Page,
  /// The app's server.
  Server,
}

/// What a message IS, independent of how the run treated it.
#[derive(Serialize, ToSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
  /// Something the runner does to the page (or asks the host for).
  Action,
  /// A log the spec requires.
  Expect,
  /// A log the spec forbids.
  Forbid,
  /// A request the page made.
  Request,
  /// A page load or in-app navigation.
  Navigation,
  /// An error-level entry.
  Error,
  /// A step a person performs.
  Manual,
}

/// How the run treated a message. The divergences are `missing`, `moved`,
/// `failed` and `unexpected`; everything else is context.
#[derive(Serialize, ToSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Mark {
  /// The spec's diagram, with no run to compare against.
  Expected,
  /// Expected, and it happened where the spec put it.
  Matched,
  /// Expected, and it happened — in a different step than the spec put it.
  Moved,
  /// Expected, and it never happened.
  Missing,
  /// The action that threw: the point the run stopped.
  Failed,
  /// Happened, and the spec forbids it.
  Unexpected,
  /// Planned after the run stopped, or after the first manual step.
  NotReached,
  /// Happened, and the spec says nothing about it either way.
  Observed,
  /// A planned action of a run whose runner recorded no step timings — it
  /// predates `steps.json` — so whether and when it ran is unknown.
  Unrecorded,
}

impl Mark {
  pub fn is_divergence(self) -> bool {
    matches!(
      self,
      Mark::Missing | Mark::Moved | Mark::Failed | Mark::Unexpected
    )
  }
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
  pub id: String,
  pub from: Lane,
  pub to: Lane,
  pub kind: Kind,
  pub mark: Mark,
  /// The arrow's label: an action in short, a request line, or a pattern's
  /// description.
  pub label: String,
  /// Why the mark is what it is — the pattern, the error, where it was seen.
  pub detail: Option<String>,
  /// `hh:mm:ss.mmm` UTC, when the run did it. Absent for what never happened.
  pub at: Option<String>,
  /// RFC 3339 of the same instant, for jumping to the log.
  pub ts: Option<String>,
  /// Consecutive identical observations folded into this arrow.
  pub count: u32,
}

/// A band of the diagram: before the first step, one per spec step, and the
/// expectations that belong to the whole run.
#[serde_with::skip_serializing_none]
#[derive(Serialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Section {
  pub id: String,
  pub title: String,
  /// The step's instruction, for a step band.
  pub subtitle: Option<String>,
  pub messages: Vec<Message>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SequenceDiagram {
  /// `false` for a spec's diagram alone; `true` when a run was laid over it.
  pub observed: bool,
  /// Whether the run carried `steps.json`. A compared run without it can still
  /// tick logs, but cannot say which step anything happened in.
  pub steps_recorded: bool,
  pub sections: Vec<Section>,
  /// Messages whose mark [`Mark::is_divergence`].
  pub divergences: usize,
  /// The first of them in reading order — where a reader should look.
  pub first_divergence: Option<String>,
}

/// The runner's `steps.json`, as `tento-ux-runner/lib/step-record.ts` writes it.
#[derive(Deserialize, Clone, Debug)]
pub struct StepManifest {
  pub steps: Vec<StepEntry>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StepEntry {
  pub index: usize,
  pub started_at: DateTime<Utc>,
  #[serde(default)]
  pub ok: Option<bool>,
  #[serde(default)]
  pub error: Option<String>,
}

/// `steps.json` → its entries. `None` for a run that has none or a file that
/// will not parse: either way the run cannot place its actions.
pub fn parse_steps(raw: &str) -> Option<StepManifest> {
  serde_json::from_str(raw).ok()
}

/// NDJSON of [`LjsonEntry`] → entries, skipping lines that will not parse — a
/// run captured mid-write must not lose its whole diagram.
pub fn parse_entries(raw: &str, fallback_origin: &str) -> Vec<LjsonEntry> {
  raw
    .lines()
    .filter(|line| !line.trim().is_empty())
    .filter_map(|line| serde_json::from_str::<LjsonEntry>(line).ok())
    .map(|mut entry| {
      if entry.origin.is_none() {
        entry.origin = Some(fallback_origin.to_string());
      }
      entry
    })
    .collect()
}

/// The spec's diagram, with nothing to compare it against.
pub fn expected(spec: &TestSpec) -> SequenceDiagram {
  Builder::new(spec, None, &[], false).finish()
}

/// The spec's diagram with a run laid over it. `steps` is the run's
/// `steps.json`; `entries` are its client and server log entries together.
pub fn compare(
  spec: &TestSpec,
  steps: Option<&StepManifest>,
  entries: &[LjsonEntry],
) -> SequenceDiagram {
  Builder::new(spec, steps, entries, true).finish()
}

// ── Building ────────────────────────────────────────────────────────────────

/// Where a message sits inside its band. Heads keep plan order ahead of
/// anything timed, timed messages sort by when they happened, and tails — what
/// should have happened and did not — close the band in plan order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Slot {
  Head,
  Timed(DateTime<Utc>),
  Tail,
}

struct Placed {
  section: usize,
  slot: Slot,
  seq: usize,
  msg: Message,
}

struct Builder<'a> {
  spec: &'a TestSpec,
  entries: Vec<&'a LjsonEntry>,
  /// `entries` indices in the judge's order — by completion stamp, ties in
  /// trace order. Ordered walks (step logs, sequences, navigations) go by this,
  /// so a command that starts first and completes after the requests it
  /// issued is found where the judge finds it. Placement still goes by start.
  walk: Vec<usize>,
  observed: bool,
  /// Plan index → (spec step index, action).
  outline: Vec<(usize, ExecutableAction)>,
  steps: Option<BTreeMap<usize, &'a StepEntry>>,
  /// Each automated spec step's window start: the first time one of its
  /// actions began. Sorted by step.
  windows: Vec<(usize, DateTime<Utc>)>,
  placed: Vec<Placed>,
  /// Entries some expectation claimed, so context does not draw them twice.
  claimed: Vec<bool>,
}

impl<'a> Builder<'a> {
  fn new(
    spec: &'a TestSpec,
    steps: Option<&'a StepManifest>,
    entries: &'a [LjsonEntry],
    observed: bool,
  ) -> Self {
    let mut indexed: Vec<(usize, &LjsonEntry)> = entries.iter().enumerate().collect();
    indexed.sort_by_key(|(_, e)| start_of(e));
    let mut walk: Vec<usize> = (0..indexed.len()).collect();
    walk.sort_by_key(|&i| (indexed[i].1.ts, indexed[i].0));
    let entries: Vec<&LjsonEntry> = indexed.into_iter().map(|(_, e)| e).collect();
    let outline = spec.headless_plan_outline();
    let steps = steps.map(|m| {
      m.steps
        .iter()
        .map(|s| (s.index, s))
        .collect::<BTreeMap<_, _>>()
    });
    let mut windows: Vec<(usize, DateTime<Utc>)> = Vec::new();
    if let Some(steps) = &steps {
      for (index, (step, _)) in outline.iter().enumerate() {
        if let Some(record) = steps.get(&index) {
          if windows.last().is_none_or(|(s, _)| s != step) {
            windows.push((*step, record.started_at));
          }
        }
      }
    }
    let claimed = vec![false; entries.len()];
    Builder {
      spec,
      entries,
      walk,
      observed,
      outline,
      steps,
      windows,
      placed: Vec::new(),
      claimed,
    }
  }

  // Band indices: 0 is before the first step, 1..=n the spec's steps, n+1 the
  // run's observations when no step timings place them, n+2 the whole run.
  fn boot(&self) -> usize {
    0
  }
  fn step_band(&self, step: usize) -> usize {
    1 + step
  }
  fn unplaced_band(&self) -> usize {
    1 + self.spec.steps.len()
  }
  fn across_band(&self) -> usize {
    2 + self.spec.steps.len()
  }

  /// The band an instant falls in: the last step whose window began at or
  /// before it, else before the first step. Without step timings there are no
  /// windows, and everything observed shares one band.
  fn band_at(&self, at: DateTime<Utc>) -> usize {
    if self.steps.is_none() {
      return self.unplaced_band();
    }
    // The runner opens `initial_path` for the first step, so the page's boot —
    // everything before that step's first action — is the first step's too. A
    // step that only waits for the page to render is confirmed by the render.
    // Strictly after: the runner starts a step in the same millisecond the
    // last one's final action ends, and a report that action posted is
    // stamped in that millisecond too. A tie belongs to the step that was
    // running, not the one just starting.
    match self.windows.iter().rev().find(|(_, start)| *start < at) {
      Some((step, _)) => self.step_band(*step),
      None => self
        .windows
        .first()
        .map_or(self.boot(), |(step, _)| self.step_band(*step)),
    }
  }

  fn place(&mut self, section: usize, slot: Slot, msg: Message) {
    let seq = self.placed.len();
    self.placed.push(Placed {
      section,
      slot,
      seq,
      msg,
    });
  }

  fn finish(mut self) -> SequenceDiagram {
    self.actions();
    self.manual_steps();
    self.step_logs();
    if let Some(verification) = self.spec.verification.clone() {
      self.required(&verification.required_logs);
      self.forbidden(&verification.forbidden_logs, None);
      self.sequences(&verification.sequences);
      self.navigations(&verification.required_navigations);
      if self.observed {
        self.errors(
          verification.auto_fail_on_errors,
          &verification.error_allowlist,
        );
      }
    }
    self.assemble()
  }

  /// One arrow per planned action. Compared, each takes the mark its
  /// `steps.json` entry earns.
  fn actions(&mut self) {
    let failed_at = self.steps.as_ref().and_then(|steps| {
      steps
        .values()
        .find(|s| s.ok == Some(false))
        .map(|s| s.index)
    });
    for (index, (step, action)) in self.outline.clone().into_iter().enumerate() {
      let (from, to, label) = describe_action(&action);
      let mut msg = message(
        format!("action-{index}"),
        from,
        to,
        Kind::Action,
        Mark::Expected,
        label,
      );
      let band = self.step_band(step);
      if !self.observed {
        self.place(band, Slot::Head, msg);
        continue;
      }
      let Some(steps) = &self.steps else {
        msg.mark = Mark::Unrecorded;
        msg.detail = Some("this run recorded no step timings".to_string());
        self.place(band, Slot::Head, msg);
        continue;
      };
      match steps.get(&index) {
        Some(record) => {
          let failed = record.ok == Some(false);
          msg.mark = if failed { Mark::Failed } else { Mark::Matched };
          msg.detail = record
            .error
            .clone()
            .or_else(|| (record.ok.is_none()).then(|| "started, never finished".to_string()));
          if record.ok.is_none() {
            msg.mark = Mark::Failed;
          }
          stamp(&mut msg, record.started_at);
          let started = record.started_at;
          self.place(band, Slot::Timed(started), msg);
        }
        None => {
          msg.mark = Mark::NotReached;
          msg.detail = Some(match failed_at {
            Some(at) if at < index => format!("the run stopped at action {}", at + 1),
            _ => "the run ended before this action".to_string(),
          });
          self.place(band, Slot::Tail, msg);
        }
      }
    }
  }

  /// A step a person performs is a note on the runner's line. A headless run
  /// stops at the first one, so on a compared run it and every step after it
  /// are not reached — a partial, not a failure.
  fn manual_steps(&mut self) {
    let first_manual = self.spec.first_manual_step().map(|(i, _)| i);
    let spec = self.spec;
    for (i, step) in spec.steps.iter().enumerate() {
      if first_manual.is_none_or(|m| i < m) {
        continue;
      }
      if step.is_automatable() {
        // Automatable but after a manual step: its actions were never planned.
        for action in step.actions.iter().flatten() {
          let (from, to, label) = describe_action(action);
          let mut msg = message(
            format!("manual-{i}-{label}"),
            from,
            to,
            Kind::Action,
            Mark::Expected,
            label,
          );
          if self.observed {
            msg.mark = Mark::NotReached;
            msg.detail = Some("a headless run stops at the first manual step".to_string());
          }
          self.place(self.step_band(i), Slot::Head, msg);
        }
        continue;
      }
      let mut msg = message(
        format!("manual-{i}"),
        Lane::Runner,
        Lane::Runner,
        Kind::Manual,
        Mark::Expected,
        "a person performs this step".to_string(),
      );
      msg.detail = step.manual_reason.clone().or_else(|| step.expected.clone());
      if self.observed {
        msg.mark = Mark::NotReached;
        msg.detail = Some("manual — a headless run stops here".to_string());
      }
      self.place(self.step_band(i), Slot::Head, msg);
    }
  }

  /// Each step's logs — its `success_log`, then its `logs` in order — belong
  /// in that step, and its `failure_log` must not appear in it.
  ///
  /// The step logs are walked as ONE ordered sequence across the plan, as the
  /// judge walks them: each is looked for after the one before it, so a log
  /// that only appears out of order is missing here exactly as it fails
  /// there. A step that drives the page but names no log is a step nothing
  /// can confirm, and is drawn as a gap in the spec — missing, with the reason.
  /// The gaps are exactly the trace judge's (`TestSpec::unlogged_steps`): the
  /// planned steps before the first manual one. A host step after the manual
  /// ones is run by the operator beside the session, so no log of this run
  /// can confirm it, and the trace judge does not ask for one either.
  fn step_logs(&mut self) {
    let spec = self.spec;
    let unlogged: Vec<usize> = spec.unlogged_steps().into_iter().map(|(i, _)| i).collect();
    let mut cursor = 0;
    for (i, step) in spec.steps.iter().enumerate() {
      let mut patterns: Vec<(String, String)> = Vec::new();
      if let Some(pattern) = &step.success_log {
        patterns.push((format!("success-{i}"), spec.substitute_params(pattern)));
      }
      for (k, pattern) in step.logs.iter().flatten().enumerate() {
        patterns.push((format!("log-{i}-{k}"), spec.substitute_params(pattern)));
      }
      if unlogged.contains(&i) {
        let mut gap = message(
          format!("unlogged-{i}"),
          Lane::Page,
          Lane::Page,
          Kind::Expect,
          Mark::Missing,
          "no log confirms this step".to_string(),
        );
        gap.detail = Some("the spec names no `logs` for it, so the run fails".to_string());
        self.place(self.step_band(i), Slot::Tail, gap);
      }
      for (id, pattern) in patterns {
        let lanes = pattern_lanes(&pattern, None);
        let mut msg = message(
          id,
          lanes.0,
          lanes.1,
          Kind::Expect,
          Mark::Expected,
          pattern.clone(),
        );
        msg.detail = step.expected.clone();
        if !self.observed {
          self.place(self.step_band(i), Slot::Tail, msg);
          continue;
        }
        let Some((pos, hit)) = self.find(&pattern, None, cursor) else {
          msg.mark = Mark::Missing;
          if self.find(&pattern, None, 0).is_some() {
            msg.detail = Some("seen, but before the log the step expected ahead of it".to_string());
          }
          self.place(self.step_band(i), Slot::Tail, msg);
          continue;
        };
        cursor = pos + 1;
        let at = start_of(self.entries[hit]);
        let band = self.band_at(at);
        let expected_band = self.step_band(i);
        msg.mark = if self.steps.is_none() || band == expected_band {
          Mark::Matched
        } else {
          Mark::Moved
        };
        if msg.mark == Mark::Moved {
          msg.detail = Some(format!(
            "expected in step {}, seen {}",
            step.id,
            self.band_name(band)
          ));
        }
        stamp(&mut msg, at);
        self.claimed[hit] = true;
        // Placed where it HAPPENED: a moved log drawn in the step it was
        // expected in would hide exactly what the mark is saying.
        let band = if self.steps.is_none() {
          expected_band
        } else {
          band
        };
        self.place(band, Slot::Timed(at), msg);
      }
      if let Some(pattern) = &step.failure_log {
        let pattern = spec.substitute_params(pattern);
        let forbid = LogPattern {
          pattern,
          source: None,
          max_duration_ms: None,
          count: None,
          description: None,
          after: None,
        };
        self.forbidden(std::slice::from_ref(&forbid), Some(i));
      }
    }
  }

  fn required(&mut self, patterns: &[LogPattern]) {
    for (n, required) in patterns.iter().enumerate() {
      let pattern = self.spec.substitute_params(&required.pattern);
      let source = required.source.as_deref();
      let lanes = pattern_lanes(&pattern, source);
      let label = required
        .description
        .clone()
        .unwrap_or_else(|| pattern.clone());
      let mut msg = message(
        format!("required-{n}"),
        lanes.0,
        lanes.1,
        Kind::Expect,
        Mark::Expected,
        label,
      );
      msg.detail = Some(describe_pattern(&pattern, required.count.as_deref()));
      if !self.observed {
        self.place(self.across_band(), Slot::Tail, msg);
        continue;
      }
      let Some(opened) = self.scope(required.after.as_deref(), source) else {
        msg.mark = Mark::Missing;
        msg.detail = Some(never_opened(required.after.as_deref()));
        self.place(self.across_band(), Slot::Tail, msg);
        continue;
      };
      let hits = self.find_all_from(&pattern, source, opened);
      let ok = match required.count.as_deref() {
        Some(expr) => count_ok(expr, hits.len()),
        None => !hits.is_empty(),
      };
      if let Some(count) = required.count.as_deref() {
        msg.detail = Some(format!("{pattern} — expected {count}, saw {}", hits.len()));
      }
      match (ok, hits.first()) {
        (true, Some(&first)) => {
          msg.mark = Mark::Matched;
          let at = start_of(self.entries[first]);
          stamp(&mut msg, at);
          msg.count = hits.len() as u32;
          for &hit in &hits {
            self.claimed[hit] = true;
          }
          self.place(self.band_at(at), Slot::Timed(at), msg);
        }
        (true, None) => {
          // A count of zero, met by absence.
          msg.mark = Mark::Matched;
          self.place(self.across_band(), Slot::Tail, msg);
        }
        (false, _) => {
          msg.mark = Mark::Missing;
          self.place(self.across_band(), Slot::Tail, msg);
        }
      }
    }
  }

  /// Forbidden patterns, run-wide (`step` = `None`) or a step's `failure_log`.
  /// Every violation is drawn where it happened; a guard that held is one
  /// quiet line closing its band.
  fn forbidden(&mut self, patterns: &[LogPattern], step: Option<usize>) {
    for (n, forbidden) in patterns.iter().enumerate() {
      let pattern = self.spec.substitute_params(&forbidden.pattern);
      let source = forbidden.source.as_deref();
      let lanes = pattern_lanes(&pattern, source);
      let label = forbidden
        .description
        .clone()
        .unwrap_or_else(|| pattern.clone());
      let id = match step {
        Some(i) => format!("failure-{i}"),
        None => format!("forbidden-{n}"),
      };
      let home = match step {
        Some(i) => self.step_band(i),
        None => self.across_band(),
      };
      let mut msg = message(
        id.clone(),
        lanes.0,
        lanes.1,
        Kind::Forbid,
        Mark::Expected,
        label.clone(),
      );
      msg.detail = Some(format!("must not appear: {pattern}"));
      if !self.observed {
        self.place(home, Slot::Tail, msg);
        continue;
      }
      // A forbid over a scope that never opened checked nothing, and the
      // judge fails it for that.
      let Some(opened) = self.scope(forbidden.after.as_deref(), source) else {
        msg.mark = Mark::Missing;
        msg.detail = Some(never_opened(forbidden.after.as_deref()));
        self.place(home, Slot::Tail, msg);
        continue;
      };
      let hits: Vec<usize> = self
        .find_all_from(&pattern, source, opened)
        .into_iter()
        // A step's failure_log is about THAT step; seen elsewhere, it is
        // somebody else's business.
        .filter(|&hit| {
          step.is_none()
            || self.steps.is_none()
            || self.band_at(start_of(self.entries[hit])) == home
        })
        .collect();
      let allowed = forbidden
        .count
        .as_deref()
        .is_some_and(|expr| count_ok(expr, hits.len()));
      if hits.is_empty() || allowed {
        msg.mark = Mark::Matched;
        msg.detail = Some(format!("absent, as required: {pattern}"));
        self.place(home, Slot::Tail, msg);
        continue;
      }
      for (k, &hit) in hits.iter().enumerate() {
        let at = start_of(self.entries[hit]);
        let mut seen = message(
          format!("{id}-{k}"),
          lanes.0,
          lanes.1,
          Kind::Forbid,
          Mark::Unexpected,
          label.clone(),
        );
        seen.detail = Some(format!("forbidden — {}", entry_text(self.entries[hit])));
        stamp(&mut seen, at);
        self.claimed[hit] = true;
        let band = self.band_at(at);
        self.place(band, Slot::Timed(at), seen);
      }
    }
  }

  /// Ordered assertions, walked exactly as the judge walks them: the first
  /// pattern that cannot be found after its predecessor breaks the sequence.
  fn sequences(&mut self, sequences: &[crate::spec::LogSequence]) {
    for (n, seq) in sequences.iter().enumerate() {
      let name = seq
        .description
        .clone()
        .unwrap_or_else(|| format!("sequence {}", n + 1));
      let source = seq.source.as_deref();
      let total = seq.patterns.len();
      let mut cursor = 0;
      let mut broken = false;
      for (k, raw) in seq.patterns.iter().enumerate() {
        let pattern = self.spec.substitute_params(raw);
        let lanes = pattern_lanes(&pattern, source);
        let mut msg = message(
          format!("sequence-{n}-{k}"),
          lanes.0,
          lanes.1,
          Kind::Expect,
          Mark::Expected,
          pattern.clone(),
        );
        msg.detail = Some(format!("{name} · {} of {total}", k + 1));
        if !self.observed {
          self.place(self.across_band(), Slot::Tail, msg);
          continue;
        }
        let hit = if broken {
          None
        } else {
          self.find(&pattern, source, cursor)
        };
        match hit {
          Some((pos, hit)) => {
            cursor = pos + 1;
            msg.mark = Mark::Matched;
            let at = start_of(self.entries[hit]);
            stamp(&mut msg, at);
            self.claimed[hit] = true;
            self.place(self.band_at(at), Slot::Timed(at), msg);
          }
          None => {
            msg.mark = Mark::Missing;
            if broken {
              msg.detail = Some(format!(
                "{name} · {} of {total}, after the sequence broke",
                k + 1
              ));
            } else {
              msg.detail = Some(format!("{name} · {} of {total} — not seen in order", k + 1));
            }
            broken = true;
            self.place(self.across_band(), Slot::Tail, msg);
          }
        }
      }
    }
  }

  /// `required_navigations`, in order, against `navigation` and `page-load`
  /// spans — the judge's reading.
  fn navigations(&mut self, paths: &[String]) {
    let mut cursor = 0;
    for (n, path) in paths.iter().enumerate() {
      let mut msg = message(
        format!("navigation-{n}"),
        Lane::Page,
        Lane::Page,
        Kind::Navigation,
        Mark::Expected,
        format!("navigate {path}"),
      );
      msg.detail = Some("a required navigation".to_string());
      if !self.observed {
        self.place(self.across_band(), Slot::Tail, msg);
        continue;
      }
      let hit = (cursor..self.walk.len()).find(|&w| {
        let span = &self.entries[self.walk[w]].root_span;
        (span.name == "navigation" || span.name == "page-load")
          && (span
            .get_str("to")
            .is_some_and(|to| to.contains(path.as_str()))
            || span
              .get_str("path")
              .is_some_and(|p| p.contains(path.as_str())))
      });
      match hit {
        Some(w) => {
          cursor = w + 1;
          let hit = self.walk[w];
          msg.mark = Mark::Matched;
          let at = start_of(self.entries[hit]);
          stamp(&mut msg, at);
          self.claimed[hit] = true;
          self.place(self.band_at(at), Slot::Timed(at), msg);
        }
        None => {
          msg.mark = Mark::Missing;
          self.place(self.across_band(), Slot::Tail, msg);
        }
      }
    }
  }

  /// Error-level root entries the spec does not tolerate. Under
  /// `auto_fail_on_errors` each one the allowlist does not cover is a
  /// mismatch, as it is for the judge, and is overlaid where it happened. An
  /// allowlisted error, an aborted request, or any error when the spec does
  /// not fail on them is not in the spec's diagram and is not drawn: the
  /// diagram is the spec's, with only the run's divergences laid over it.
  fn errors(&mut self, auto_fail: bool, allowlist: &[String]) {
    let all: Vec<LjsonEntry> = self.entries.iter().map(|e| (*e).clone()).collect();
    for i in 0..self.entries.len() {
      let entry = self.entries[i];
      if entry.root_span.level != LjsonLevel::Error || self.claimed[i] {
        continue;
      }
      let label = entry_text(entry);
      let allowed = allowlist
        .iter()
        .any(|allow| pattern_matches(&label, allow, regex::Regex::new(allow).ok().as_ref()));
      let aborted = navigation_aborted_call(entry, &all).is_some();
      if !auto_fail || allowed || aborted {
        continue;
      }
      let lane = lane_of(entry);
      let (from, to) = if is_request(entry) {
        (Lane::Page, Lane::Server)
      } else {
        (lane, lane)
      };
      let mut msg = message(
        format!("error-{i}"),
        from,
        to,
        Kind::Error,
        Mark::Unexpected,
        label,
      );
      msg.detail = Some("error — the spec fails on unexpected errors".to_string());
      let at = start_of(entry);
      stamp(&mut msg, at);
      self.claimed[i] = true;
      self.place(self.band_at(at), Slot::Timed(at), msg);
    }
  }

  fn band_name(&self, band: usize) -> String {
    if band == self.boot() {
      "before the first step".to_string()
    } else if band <= self.spec.steps.len() {
      format!("in step {}", self.spec.steps[band - 1].id)
    } else {
      "elsewhere in the run".to_string()
    }
  }

  fn assemble(self) -> SequenceDiagram {
    let n = self.spec.steps.len();
    let mut sections: Vec<Section> = Vec::with_capacity(n + 3);
    sections.push(Section {
      id: "boot".to_string(),
      title: "Before the first step".to_string(),
      subtitle: None,
      messages: Vec::new(),
    });
    for step in &self.spec.steps {
      sections.push(Section {
        id: format!("step-{}", step.id),
        title: step.id.clone(),
        subtitle: Some(self.spec.substitute_params(&step.instruction)),
        messages: Vec::new(),
      });
    }
    sections.push(Section {
      id: "run".to_string(),
      title: "The run".to_string(),
      subtitle: Some("No step timings — these are in time order, unplaced.".to_string()),
      messages: Vec::new(),
    });
    sections.push(Section {
      id: "across".to_string(),
      title: "Across the run".to_string(),
      subtitle: Some("What the verification block asks of the whole run.".to_string()),
      messages: Vec::new(),
    });
    let mut placed = self.placed;
    placed.sort_by(|a, b| (a.section, a.slot, a.seq).cmp(&(b.section, b.slot, b.seq)));
    for p in placed {
      sections[p.section].messages.push(p.msg);
    }
    // A step band stays even when empty — it is the spec's shape — but the
    // three run-level bands appear only when something is in them.
    let sections: Vec<Section> = sections
      .into_iter()
      .enumerate()
      .filter(|(i, s)| (1..=n).contains(i) || !s.messages.is_empty())
      .map(|(_, s)| s)
      .collect();
    let divergent: Vec<&Message> = sections
      .iter()
      .flat_map(|s| &s.messages)
      .filter(|m| m.mark.is_divergence())
      .collect();
    SequenceDiagram {
      observed: self.observed,
      steps_recorded: self.steps.is_some(),
      divergences: divergent.len(),
      first_divergence: divergent.first().map(|m| m.id.clone()),
      sections,
    }
  }

  /// The first entry at or after walk position `from` matching `pattern`
  /// (and `source`): `(walk position, entry index)`. The walk is the judge's
  /// order, so a cursor advanced past one hit lands where the judge's does.
  fn find(&self, pattern: &str, source: Option<&str>, from: usize) -> Option<(usize, usize)> {
    (from..self.walk.len())
      .map(|w| (w, self.walk[w]))
      .find(|&(_, i)| matches_entry(self.entries[i], pattern, source))
  }

  fn find_all(&self, pattern: &str, source: Option<&str>) -> Vec<usize> {
    self.find_all_from(pattern, source, None)
  }

  /// [`find_all`](Self::find_all) over the entries that completed at or after
  /// `opened` — a pattern's `after:` scope, as the judge cuts it.
  fn find_all_from(
    &self,
    pattern: &str,
    source: Option<&str>,
    opened: Option<DateTime<Utc>>,
  ) -> Vec<usize> {
    (0..self.entries.len())
      .filter(|&i| opened.is_none_or(|at| self.entries[i].ts >= at))
      .filter(|&i| matches_entry(self.entries[i], pattern, source))
      .collect()
  }

  /// Where a pattern's `after:` scope opens: the earliest START of an entry
  /// matching the anchor. `Some(None)` with no anchor (the whole trace);
  /// `None` when the anchor never appears — the judge fails that pattern.
  fn scope(&self, anchor: Option<&str>, source: Option<&str>) -> Option<Option<DateTime<Utc>>> {
    let Some(anchor) = anchor else {
      return Some(None);
    };
    let anchor = self.spec.substitute_params(anchor);
    self
      .entries
      .iter()
      .filter(|entry| matches_entry(entry, &anchor, source))
      .map(|entry| start_of(entry))
      .min()
      .map(Some)
  }
}

fn never_opened(anchor: Option<&str>) -> String {
  format!(
    "scope never opened: no entry matches after: {}",
    anchor.unwrap_or_default()
  )
}

fn matches_entry(entry: &LjsonEntry, pattern: &str, source: Option<&str>) -> bool {
  let source_ok = match source {
    Some("client") => entry.is_client(),
    Some("server") => !entry.is_client(),
    _ => true,
  };
  source_ok && entry_matches_pattern(entry, pattern)
}

/// When an entry STARTED: its completion stamp less its duration. A request
/// the click issued belongs to the click's step even when it returns in the
/// next one.
fn start_of(entry: &LjsonEntry) -> DateTime<Utc> {
  match entry.root_span.duration_ms {
    Some(ms) if ms > 0 => entry.ts - chrono::Duration::milliseconds(ms),
    _ => entry.ts,
  }
}

fn is_request(entry: &LjsonEntry) -> bool {
  entry.root_span.name == "api-call" || entry.root_span.get_str("http.method").is_some()
}

fn lane_of(entry: &LjsonEntry) -> Lane {
  if entry.is_client() {
    Lane::Page
  } else {
    Lane::Server
  }
}

/// Where a pattern's arrow runs: a request line crosses from page to server, a
/// server pattern stays on the server, anything else is the page talking.
fn pattern_lanes(pattern: &str, source: Option<&str>) -> (Lane, Lane) {
  // The judge's HTTP test reads status-first lines (`200 POST …`); a request
  // line that leads with its method is a request too.
  let method_first = ["GET ", "POST ", "PUT ", "PATCH ", "DELETE "]
    .iter()
    .any(|method| pattern.starts_with(method));
  if is_http_pattern(pattern) || method_first {
    return (Lane::Page, Lane::Server);
  }
  match source {
    Some("server") => (Lane::Server, Lane::Server),
    _ => (Lane::Page, Lane::Page),
  }
}

fn describe_pattern(pattern: &str, count: Option<&str>) -> String {
  match count {
    Some(count) => format!("{pattern} — expected {count}"),
    None => pattern.to_string(),
  }
}

/// The judge's count grammar: `3`, `3+`, `1..5`.
fn count_ok(expr: &str, actual: usize) -> bool {
  let expr = expr.trim();
  if let Some((lo, hi)) = expr.split_once("..") {
    let lo: usize = lo.trim().parse().unwrap_or(0);
    let hi: usize = hi.trim().parse().unwrap_or(usize::MAX);
    return actual >= lo && actual <= hi;
  }
  if let Some(min) = expr.strip_suffix('+') {
    return actual >= min.trim().parse().unwrap_or(0);
  }
  actual == expr.parse().unwrap_or(0)
}

/// An entry as one line: its message when it has one, else its name.
fn entry_text(entry: &LjsonEntry) -> String {
  let span = &entry.root_span;
  match span.message() {
    Some(msg) if !msg.is_empty() => format!("{}: {msg}", span.name),
    _ => span.name.clone(),
  }
}

/// An action as an arrow: who it runs between, and a label short enough to sit
/// on one.
fn describe_action(action: &ExecutableAction) -> (Lane, Lane, String) {
  use ExecutableAction as A;
  let page = |label: String| (Lane::Runner, Lane::Page, label);
  match action {
    A::Navigate { path } => page(format!("navigate {path}")),
    A::WaitForSelector { selector, .. } => page(format!("wait for {}", clip(selector, 48))),
    A::Wait { ms } => (Lane::Runner, Lane::Runner, format!("wait {ms}ms")),
    A::Click { selector, .. } => page(format!("click {}", clip(selector, 48))),
    A::Hover { selector } => page(format!("hover {}", clip(selector, 48))),
    A::Drag {
      from_selector,
      to_selector,
      dx,
      dy,
      ..
    } => page(match to_selector {
      Some(to) => format!("drag {} → {}", clip(from_selector, 24), clip(to, 24)),
      None => format!(
        "drag {} by {},{}",
        clip(from_selector, 32),
        dx.unwrap_or(0),
        dy.unwrap_or(0)
      ),
    }),
    A::Scroll { selector, dx, dy } => page(format!(
      "scroll {}{},{}",
      selector
        .as_deref()
        .map(|s| format!("{} ", clip(s, 32)))
        .unwrap_or_default(),
      dx.unwrap_or(0),
      dy.unwrap_or(0)
    )),
    A::Type { selector, text } => page(format!(
      "type “{}” into {}",
      clip(text, 20),
      clip(selector, 28)
    )),
    A::Keyboard { key } => page(format!("press {key}")),
    A::Evaluate { js } => page(format!("evaluate {}", clip(js, 40))),
    A::Dispatch { command } => {
      let name = command
        .get("type")
        .or_else(|| command.get("command"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| clip(&command.to_string(), 40));
      page(format!("dispatch {name}"))
    }
    A::Host { verb, .. } => (Lane::Runner, Lane::Server, format!("host {verb}")),
    A::SetViewport { width, height } => page(match height {
      Some(h) => format!("viewport {width}×{h}"),
      None => format!("viewport {width}"),
    }),
    A::Screenshot { suffix, .. } => page(format!(
      "screenshot {}",
      suffix.as_deref().unwrap_or("shot")
    )),
    A::ScrollBurst { target, steps, .. } => page(format!(
      "scroll {} × {steps}",
      target
        .as_deref()
        .map(|t| clip(t, 32))
        .unwrap_or_else(|| "the page".to_string())
    )),
  }
}

fn clip(s: &str, max: usize) -> String {
  if s.chars().count() <= max {
    s.to_string()
  } else {
    format!("{}…", s.chars().take(max).collect::<String>())
  }
}

fn message(id: String, from: Lane, to: Lane, kind: Kind, mark: Mark, label: String) -> Message {
  Message {
    id,
    from,
    to,
    kind,
    mark,
    label,
    detail: None,
    at: None,
    ts: None,
    count: 1,
  }
}

fn stamp(msg: &mut Message, at: DateTime<Utc>) {
  msg.at = Some(at.format("%H:%M:%S%.3f").to_string());
  msg.ts = Some(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
}

#[cfg(test)]
mod tests {
  use super::*;

  const SPEC: &str = r#"
id: pays-with-card
name: Checkout pays with a card
timeout: 120
params:
  sku: "lamp-01"
instructions: []
steps:
- id: add
  instruction: Add {{sku}} to the cart.
  success_log: cart/added
  actions:
  - action: navigate
    path: /p/{{sku}}
  - action: click
    selector: "[data-testid=add-to-cart]"
- id: pay
  instruction: Pay with the test card.
  failure_log: checkout/declined
  logs: ["POST /api/pay"]
  actions:
  - action: click
    selector: "button[type=submit]"
  - action: wait_for_selector
    selector: "[data-testid=order-confirmation]"
- id: eyeball
  instruction: Check the receipt email.
  manual: true
  manual_reason: needs an inbox
verification:
  required_logs:
  - pattern: checkout/paid
    source: client
    description: the client reported the payment
  forbidden_logs:
  - pattern: checkout/retry
    source: client
  sequences: []
  auto_fail_on_errors: true
  error_allowlist: [ResizeObserver]
  required_navigations: [/checkout]
"#;

  fn spec() -> TestSpec {
    TestSpec::from_yaml(SPEC).unwrap()
  }

  fn entry(ts: &str, name: &str, level: &str, attrs: serde_json::Value) -> LjsonEntry {
    serde_json::from_value(serde_json::json!({
      "v": 1,
      "ts": ts,
      "sessionId": "d54404f6-3850-4d88-a700-51787e8c42ce",
      "origin": "client",
      "rootSpan": {
        "id": 1, "name": name, "level": level,
        "location": {"file": "x", "line": 1},
        "attributes": attrs, "children": []
      }
    }))
    .unwrap()
  }

  fn steps(raw: serde_json::Value) -> StepManifest {
    parse_steps(&raw.to_string()).unwrap()
  }

  fn all(d: &SequenceDiagram) -> Vec<&Message> {
    d.sections.iter().flat_map(|s| &s.messages).collect()
  }

  fn by_id<'d>(d: &'d SequenceDiagram, id: &str) -> &'d Message {
    all(d)
      .into_iter()
      .find(|m| m.id == id)
      .unwrap_or_else(|| panic!("no message {id}"))
  }

  #[test]
  fn a_spec_draws_its_actions_expectations_and_guards() {
    let d = expected(&spec());
    assert!(!d.observed);
    assert_eq!(d.divergences, 0);
    let titles: Vec<&str> = d.sections.iter().map(|s| s.title.as_str()).collect();
    assert_eq!(titles, vec!["add", "pay", "eyeball", "Across the run"]);
    // Params are substituted, actions run runner → page.
    let first = &d.sections[0].messages[0];
    assert_eq!(
      (first.from, first.to, first.label.as_str()),
      (Lane::Runner, Lane::Page, "navigate /p/lamp-01")
    );
    assert_eq!(
      d.sections[0].subtitle.as_deref(),
      Some("Add lamp-01 to the cart.")
    );
    // The step's success log closes its band; its failure log is a guard.
    assert_eq!(d.sections[0].messages.last().unwrap().label, "cart/added");
    assert_eq!(by_id(&d, "failure-1").kind, Kind::Forbid);
    assert_eq!(by_id(&d, "manual-2").kind, Kind::Manual);
    assert!(all(&d).iter().all(|m| m.mark == Mark::Expected));
  }

  #[test]
  fn a_clean_run_ticks_everything_and_places_logs_in_their_steps() {
    let s = spec();
    let rec = steps(serde_json::json!({"v":1,"steps":[
      {"index":0,"action":"navigate","startedAt":"2026-10-10T10:00:00.000Z","endedAt":"2026-10-10T10:00:01.000Z","ok":true},
      {"index":1,"action":"click","startedAt":"2026-10-10T10:00:01.000Z","endedAt":"2026-10-10T10:00:01.100Z","ok":true},
      {"index":2,"action":"click","startedAt":"2026-10-10T10:00:02.000Z","endedAt":"2026-10-10T10:00:02.100Z","ok":true},
      {"index":3,"action":"wait_for_selector","startedAt":"2026-10-10T10:00:02.100Z","endedAt":"2026-10-10T10:00:03.000Z","ok":true}
    ]}));
    let entries = vec![
      entry(
        "2026-10-10T10:00:01.500Z",
        "cart/added",
        "info",
        serde_json::json!({}),
      ),
      entry(
        "2026-10-10T10:00:01.800Z",
        "navigation",
        "info",
        serde_json::json!({"to": "/checkout"}),
      ),
      entry(
        "2026-10-10T10:00:02.300Z",
        "api-call",
        "info",
        serde_json::json!({"http.method":"post","http.path":"/api/pay?x=1","http.status":200}),
      ),
      entry(
        "2026-10-10T10:00:02.400Z",
        "api-call",
        "info",
        serde_json::json!({"http.method":"post","http.path":"/api/pay","http.status":200}),
      ),
      entry(
        "2026-10-10T10:00:02.900Z",
        "checkout/paid",
        "info",
        serde_json::json!({}),
      ),
      entry(
        "2026-10-10T10:00:02.950Z",
        "ResizeObserver loop",
        "error",
        serde_json::json!({}),
      ),
    ];
    let d = compare(&s, Some(&rec), &entries);
    assert!(d.observed && d.steps_recorded);
    assert_eq!(d.divergences, 0, "{:#?}", all(&d));
    let add = &d.sections[0];
    assert_eq!(add.title, "add");
    let labels: Vec<&str> = add.messages.iter().map(|m| m.label.as_str()).collect();
    // Time order: the two actions, then the log they caused, then the
    // navigation the required check claimed.
    assert_eq!(
      labels,
      vec![
        "navigate /p/lamp-01",
        "click [data-testid=add-to-cart]",
        "cart/added",
        "navigate /checkout"
      ]
    );
    assert_eq!(by_id(&d, "success-0").mark, Mark::Matched);
    // The required log lands in the step it happened in.
    let paid = by_id(&d, "required-0");
    assert_eq!(paid.mark, Mark::Matched);
    assert!(d.sections[1].messages.iter().any(|m| m.id == "required-0"));
    // The step's declared log is the request, ticked in its step.
    let pay = by_id(&d, "log-1-0");
    assert_eq!(
      (pay.mark, pay.from, pay.to),
      (Mark::Matched, Lane::Page, Lane::Server)
    );
    assert!(d.sections[1].messages.iter().any(|m| m.id == "log-1-0"));
    // One diagram, the spec's: the second request and the allowlisted error
    // are in the log, not drawn here.
    assert!(
      all(&d)
        .iter()
        .all(|m| m.kind != Kind::Request && m.kind != Kind::Error)
    );
    // The manual step is a partial, not a failure.
    assert_eq!(by_id(&d, "manual-2").mark, Mark::NotReached);
  }

  #[test]
  fn a_failed_run_marks_the_failure_point_the_misses_and_the_forbidden() {
    let s = spec();
    let rec = steps(serde_json::json!({"v":1,"steps":[
      {"index":0,"action":"navigate","startedAt":"2026-10-10T10:00:00.000Z","endedAt":"2026-10-10T10:00:01.000Z","ok":true},
      {"index":1,"action":"click","startedAt":"2026-10-10T10:00:01.000Z","endedAt":"2026-10-10T10:00:01.100Z","ok":true},
      {"index":2,"action":"click","startedAt":"2026-10-10T10:00:02.000Z","endedAt":"2026-10-10T10:00:12.000Z","ok":false,"error":"no node for button[type=submit]"}
    ]}));
    let entries = vec![
      // The success log arrives during the NEXT step: moved.
      entry(
        "2026-10-10T10:00:02.500Z",
        "cart/added",
        "info",
        serde_json::json!({}),
      ),
      entry(
        "2026-10-10T10:00:03.000Z",
        "checkout/retry",
        "warn",
        serde_json::json!({}),
      ),
      entry(
        "2026-10-10T10:00:03.500Z",
        "checkout/declined",
        "warn",
        serde_json::json!({}),
      ),
      entry(
        "2026-10-10T10:00:04.000Z",
        "boom",
        "error",
        serde_json::json!({"message": "card form crashed"}),
      ),
    ];
    let d = compare(&s, Some(&rec), &entries);
    assert_eq!(by_id(&d, "action-2").mark, Mark::Failed);
    assert_eq!(
      by_id(&d, "action-2").detail.as_deref(),
      Some("no node for button[type=submit]")
    );
    assert_eq!(by_id(&d, "action-3").mark, Mark::NotReached);
    let moved = by_id(&d, "success-0");
    assert_eq!(moved.mark, Mark::Moved);
    assert_eq!(
      moved.detail.as_deref(),
      Some("expected in step add, seen in step pay")
    );
    assert_eq!(by_id(&d, "forbidden-0-0").mark, Mark::Unexpected);
    assert_eq!(by_id(&d, "failure-1-0").mark, Mark::Unexpected);
    assert_eq!(by_id(&d, "error-3").mark, Mark::Unexpected);
    assert_eq!(by_id(&d, "required-0").mark, Mark::Missing);
    assert_eq!(by_id(&d, "navigation-0").mark, Mark::Missing);
    assert_eq!(by_id(&d, "log-1-0").mark, Mark::Missing);
    // moved + failed + 2 forbidden + error + 3 missing.
    assert_eq!(d.divergences, 8);
    // The first divergence in reading order is in step `pay`, at the failure.
    assert_eq!(d.first_divergence.as_deref(), Some("action-2"));
  }

  #[test]
  fn a_run_without_step_timings_still_ticks_logs_but_cannot_place_them() {
    let entries = vec![entry(
      "2026-10-10T10:00:01.500Z",
      "cart/added",
      "info",
      serde_json::json!({}),
    )];
    let d = compare(&spec(), None, &entries);
    assert!(!d.steps_recorded);
    assert_eq!(by_id(&d, "action-0").mark, Mark::Unrecorded);
    assert_eq!(by_id(&d, "success-0").mark, Mark::Matched);
  }

  #[test]
  fn a_step_with_no_declared_log_is_a_gap_in_the_spec() {
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: open\n  instruction: Open it.\n  actions:\n  - action: navigate\n    path: /\n",
    )
    .unwrap();
    // Drawn as a gap on the spec alone, and a divergence on any run of it.
    assert_eq!(by_id(&expected(&spec), "unlogged-0").mark, Mark::Missing);
    let d = compare(&spec, None, &[]);
    assert_eq!(by_id(&d, "unlogged-0").mark, Mark::Missing);
    assert_eq!(d.divergences, 1);
  }

  #[test]
  fn a_host_step_after_a_manual_one_is_no_gap_as_the_trace_judge_agrees() {
    // analytics-signup-attribution: the browser is driven by hand, then the
    // operator runs the host assertion beside the session.
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: signup\n  instruction: Sign up.\n  manual: true\n  manual_reason: OAuth.\n- id: assert\n  instruction: Assert.\n  actions:\n  - action: host\n    verb: assert_it\n    params: {}\n",
    )
    .unwrap();
    assert!(spec.unlogged_steps().is_empty());
    let d = compare(&spec, None, &[]);
    assert!(all(&d).into_iter().all(|m| m.id != "unlogged-1"));
  }

  #[test]
  fn step_logs_are_one_ordered_sequence_and_the_judge_agrees() {
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: open\n  instruction: Open it.\n  logs: [board/corpus, board/rail]\n  actions:\n  - action: navigate\n    path: /\nverification:\n  required_logs: []\n",
    )
    .unwrap();
    // The rail logged before the corpus: present, but out of order.
    let entries = vec![
      entry(
        "2026-10-10T10:00:01.000Z",
        "board/rail",
        "info",
        serde_json::json!({}),
      ),
      entry(
        "2026-10-10T10:00:02.000Z",
        "board/corpus",
        "info",
        serde_json::json!({}),
      ),
    ];
    let d = compare(&spec, None, &entries);
    assert_eq!(by_id(&d, "log-0-0").mark, Mark::Matched);
    let rail = by_id(&d, "log-0-1");
    assert_eq!(rail.mark, Mark::Missing);
    assert_eq!(
      rail.detail.as_deref(),
      Some("seen, but before the log the step expected ahead of it")
    );
    // The judge is handed the same order as a sequence.
    let judged = spec.judged_verification().unwrap();
    assert_eq!(
      judged.sequences.last().unwrap().patterns,
      vec!["board/corpus", "board/rail"]
    );
  }

  #[test]
  fn the_judge_fails_a_step_no_log_confirms() {
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: open\n  instruction: Open it.\n  actions:\n  - action: navigate\n    path: /\n- id: read\n  instruction: Read it.\n  logs: [board/corpus]\n  actions:\n  - action: wait\n    ms: 1\nverification:\n  required_logs: []\n",
    )
    .unwrap();
    let judged = spec.judged_verification().unwrap();
    assert_eq!(judged.unlogged_steps, vec!["open"]);
    // Every declared log is there; the unlogged step still fails the run.
    let line = r#"{"v":1,"ts":"2026-10-10T10:00:01.000Z","sessionId":"3033fd1b-bd66-4373-a4a6-7364097b7d12","origin":"client","rootSpan":{"id":1,"name":"board/corpus","level":"info","location":{},"attributes":{},"children":[]}}"#;
    let path = std::env::temp_dir().join(format!("ux-unlogged-{}.ljson", uuid::Uuid::new_v4()));
    std::fs::write(&path, format!("{line}\n")).unwrap();
    let passed = crate::orchestration::verify_trace_results(&path, &judged).unwrap();
    std::fs::remove_file(&path).ok();
    assert!(!passed);
  }

  #[test]
  fn a_log_in_the_wrong_step_passes_the_trace_judge_and_fails_the_diagram() {
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: open\n  instruction: Open it.\n  logs: [board/corpus]\n  actions:\n  - action: navigate\n    path: /\n- id: read\n  instruction: Read it.\n  logs: [board/rail]\n  actions:\n  - action: wait\n    ms: 1\nverification:\n  required_logs: []\n",
    )
    .unwrap();
    // `board/corpus` lands after `read` began: in order, but in the wrong step.
    let line = |ts: &str, name: &str| {
      format!(
        r#"{{"v":1,"ts":"{ts}","sessionId":"3033fd1b-bd66-4373-a4a6-7364097b7d12","origin":"client","rootSpan":{{"id":1,"name":"{name}","level":"info","location":{{}},"attributes":{{}},"children":[]}}}}"#
      )
    };
    let dir = std::env::temp_dir().join(format!("ux-moved-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let trace = dir.join("trace.ljson");
    std::fs::write(
      &trace,
      format!(
        "{}\n{}\n",
        line("2026-10-10T10:00:02.500Z", "board/corpus"),
        line("2026-10-10T10:00:02.600Z", "board/rail")
      ),
    )
    .unwrap();
    std::fs::write(
      dir.join("steps.json"),
      serde_json::json!({"v":1,"steps":[
        {"index":0,"action":"navigate","startedAt":"2026-10-10T10:00:00.000Z","endedAt":"2026-10-10T10:00:01.000Z","ok":true},
        {"index":1,"action":"wait","startedAt":"2026-10-10T10:00:02.000Z","endedAt":"2026-10-10T10:00:03.000Z","ok":true}
      ]})
      .to_string(),
    )
    .unwrap();
    let judged = spec.judged_verification().unwrap();
    let trace_ok = crate::orchestration::verify_trace_results(&trace, &judged).unwrap();
    let diagram_ok = crate::orchestration::verify_sequence(&spec, &trace).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    assert!(trace_ok, "order alone is satisfied");
    assert!(
      !diagram_ok,
      "the diagram marks board/corpus moved, and that fails"
    );
  }

  #[test]
  fn a_server_span_in_the_materialized_trace_is_not_counted_as_a_client_entry() {
    // `materialize_trace` writes client entries with `"origin":"client"` and the
    // server's request spans with no origin. The trace judge reads the latter as
    // server; the diagram labelled them client, so a `source: client` count saw
    // one POST twice (settings/api-key-create, run 2026-10-19_api-key-create_316b04:
    // "Exactly one key created — expected 1, saw 2" beside a passing trace judge).
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: create\n  instruction: Create it.\n  logs: ['200 POST .*/api/user/api-keys']\n  actions:\n  - action: wait\n    ms: 1\nverification:\n  required_logs:\n  - pattern: '200 POST .*/api/user/api-keys'\n    source: client\n    count: '1'\n",
    )
    .unwrap();
    let client = r#"{"v":1,"ts":"2026-10-19T07:35:38.947Z","sessionId":"3033fd1b-bd66-4373-a4a6-7364097b7d12","origin":"client","rootSpan":{"id":1,"name":"api-call","level":"info","location":{},"attributes":{"http.method":"post","http.status":200,"http.path":"/api/user/api-keys"},"children":[]}}"#;
    let server = r#"{"v":1,"ts":"2026-10-19T07:35:38.930Z","sessionId":"3033fd1b-bd66-4373-a4a6-7364097b7d12","rootSpan":{"id":2,"name":"HTTP request","level":"info","location":{},"attributes":{"http.method":"POST","http.status_code":200,"http.target":"/api/user/api-keys"},"children":[]}}"#;
    let dir = std::env::temp_dir().join(format!("ux-origin-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let trace = dir.join("trace.ljson");
    std::fs::write(&trace, format!("{server}\n{client}\n")).unwrap();
    std::fs::write(
      dir.join("steps.json"),
      serde_json::json!({"v":1,"steps":[
        {"index":0,"action":"wait","startedAt":"2026-10-19T07:35:38.000Z","endedAt":"2026-10-19T07:35:39.500Z","ok":true}
      ]})
      .to_string(),
    )
    .unwrap();
    let judged = spec.judged_verification().unwrap();
    let trace_ok = crate::orchestration::verify_trace_results(&trace, &judged).unwrap();
    let diagram_ok = crate::orchestration::verify_sequence(&spec, &trace).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    assert!(trace_ok, "the trace judge counts one client POST");
    assert!(diagram_ok, "the diagram counts the same one client POST");
  }

  #[test]
  fn a_success_log_joins_the_judged_sequence_ahead_of_its_logs() {
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: open\n  instruction: Open it.\n  success_log: board/ready\n  logs: [board/rail]\n  actions:\n  - action: navigate\n    path: /\nverification:\n  required_logs: []\n",
    )
    .unwrap();
    let judged = spec.judged_verification().unwrap();
    assert!(judged.unlogged_steps.is_empty());
    assert_eq!(
      judged.sequences.last().unwrap().patterns,
      vec!["board/ready", "board/rail"]
    );
  }

  #[test]
  fn a_forbid_scoped_by_after_only_sees_the_trace_from_its_anchor() {
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: open\n  instruction: Open it.\n  logs: [cell/write]\n  actions:\n  - action: navigate\n    path: /\nverification:\n  forbidden_logs:\n  - pattern: sheet/cover\n    after: cell/write\n",
    )
    .unwrap();
    // The cover painted the sheet before the first write: out of scope.
    let entries = vec![
      entry(
        "2026-10-10T10:00:01.000Z",
        "sheet/cover",
        "info",
        serde_json::json!({}),
      ),
      entry(
        "2026-10-10T10:00:02.000Z",
        "cell/write",
        "info",
        serde_json::json!({}),
      ),
    ];
    let d = compare(&spec, None, &entries);
    assert_eq!(by_id(&d, "forbidden-0").mark, Mark::Matched);
    assert_eq!(d.divergences, 0, "{:#?}", all(&d));
    // A cover after the write is in scope, and fails.
    let mut late = entries.clone();
    late.push(entry(
      "2026-10-10T10:00:03.000Z",
      "sheet/cover",
      "info",
      serde_json::json!({}),
    ));
    let d = compare(&spec, None, &late);
    assert_eq!(by_id(&d, "forbidden-0-0").mark, Mark::Unexpected);
    // No anchor at all: the scope never opened, and that is a divergence too.
    let d = compare(&spec, None, &entries[..1]);
    assert_eq!(by_id(&d, "forbidden-0").mark, Mark::Missing);
  }

  #[test]
  fn ordered_walks_go_by_completion_like_the_judge() {
    // A command that STARTS first but COMPLETES after the request it issued:
    // the judge orders by completion, so `POST /api/sheets` comes first.
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: open\n  instruction: Open it.\n  logs: ['POST /api/sheets$', app-command/addHabitRow]\n  actions:\n  - action: navigate\n    path: /\nverification:\n  required_logs: []\n",
    )
    .unwrap();
    let mut command = entry(
      "2026-10-10T10:00:01.300Z",
      "app-command/addHabitRow",
      "info",
      serde_json::json!({}),
    );
    command.root_span.duration_ms = Some(300);
    let request = entry(
      "2026-10-10T10:00:01.200Z",
      "api-call",
      "info",
      serde_json::json!({"http.method":"post","http.path":"/api/sheets","http.status":200}),
    );
    // Trace order puts the command first; it also started first.
    let d = compare(&spec, None, &[command, request]);
    assert_eq!(by_id(&d, "log-0-0").mark, Mark::Matched);
    assert_eq!(by_id(&d, "log-0-1").mark, Mark::Matched, "{:#?}", all(&d));
  }

  #[test]
  fn the_page_boot_belongs_to_the_first_step() {
    // The render the first step waits for happens before its first action.
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: loads\n  instruction: The page loads.\n  logs: [promos/ledger-state/live]\n  actions:\n  - action: wait\n    ms: 1\nverification:\n  required_logs: []\n",
    )
    .unwrap();
    let rec = steps(serde_json::json!({"v":1,"steps":[
      {"index":0,"action":"wait","startedAt":"2026-10-10T10:00:02.000Z","endedAt":"2026-10-10T10:00:02.001Z","ok":true}
    ]}));
    let entries = vec![entry(
      "2026-10-10T10:00:01.000Z",
      "promos/ledger-state/live",
      "info",
      serde_json::json!({}),
    )];
    let d = compare(&spec, Some(&rec), &entries);
    assert_eq!(by_id(&d, "log-0-0").mark, Mark::Matched, "{:#?}", all(&d));
    assert_eq!(d.divergences, 0);
  }

  #[test]
  fn a_log_stamped_as_the_next_step_starts_stays_with_its_step() {
    let spec = TestSpec::from_yaml(
      "id: t\nname: t\ninstructions: []\nsteps:\n- id: one\n  instruction: One.\n  logs: ['report:one done']\n  actions:\n  - action: wait\n    ms: 1\n- id: two\n  instruction: Two.\n  logs: ['report:two done']\n  actions:\n  - action: wait\n    ms: 1\nverification:\n  required_logs: []\n",
    )
    .unwrap();
    let rec = steps(serde_json::json!({"v":1,"steps":[
      {"index":0,"action":"wait","startedAt":"2026-10-10T10:00:01.000Z","endedAt":"2026-10-10T10:00:02.000Z","ok":true},
      {"index":1,"action":"wait","startedAt":"2026-10-10T10:00:02.000Z","endedAt":"2026-10-10T10:00:03.000Z","ok":true}
    ]}));
    let entries = vec![
      entry(
        "2026-10-10T10:00:02.000Z",
        "app-command/uxTrace",
        "info",
        serde_json::json!({"report": "one done"}),
      ),
      entry(
        "2026-10-10T10:00:02.500Z",
        "app-command/uxTrace",
        "info",
        serde_json::json!({"report": "two done"}),
      ),
    ];
    let d = compare(&spec, Some(&rec), &entries);
    assert_eq!(by_id(&d, "log-0-0").mark, Mark::Matched, "{:#?}", all(&d));
    assert_eq!(d.divergences, 0);
  }

  #[test]
  fn the_plan_outline_names_each_actions_step() {
    let outline = spec().headless_plan_outline();
    let steps: Vec<usize> = outline.iter().map(|(s, _)| *s).collect();
    assert_eq!(steps, vec![0, 0, 1, 1]);
    assert_eq!(outline.len(), spec().headless_plan_actions().len());
  }

  #[test]
  fn count_grammar_matches_the_judge() {
    assert!(count_ok("2", 2) && !count_ok("2", 3));
    assert!(count_ok("2+", 5) && !count_ok("2+", 1));
    assert!(count_ok("1..3", 3) && !count_ok("1..3", 4));
  }
}
