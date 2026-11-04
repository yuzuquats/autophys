//! Span-bucket → renderer projection, shared by every log surface.
//!
//! [`SpanRow`]s recomposed into [`SpanTree`]s project here into the
//! [`LjsonEntry`]s the canonical terminal formatter
//! ([`render_entry`](super::terminal::render_entry)) draws. The TUI span-log
//! pane and the fleet-console `--op logs` CLI both consume this module, so a
//! trace renders identically on both surfaces.
//!
//! The projection is **zoom-leveled**: [`LogZoom`] picks one of three
//! projections of the SAME records — deeper zoom only reveals more of each
//! record, never different data. Identical out-of-band runs coalesce via
//! [`plan`]; folded trees carry a `▸N` badge via [`entry_suffix`].

use std::collections::HashMap;

use chrono::{DateTime, Local, Utc};
use tento_logger_spans::{SpanRow, SpanTree};
use uuid::Uuid;

use crate::ljson::{LjsonChild, LjsonEntry, LjsonEvent, LjsonLevel, LjsonLocation, LjsonSpan};
use crate::render::terminal::{GRAY, RESET};

/// Minimum run length before identical consecutive out-of-band events
/// coalesce into one `(×N)` line — two genuine occurrences stay visible.
pub const COALESCE_MIN: usize = 3;

/// Zoom level for the rendered log — three projections of the SAME records;
/// deeper zoom only reveals more of each record, never different data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogZoom {
  /// One line per trace: the root line only (the renderer's folded request
  /// line for HTTP roots), with a `▸N` badge for folded children. Identical
  /// out-of-band runs coalesce hardest here.
  Collapsed,
  /// DEFAULT: root line + child span/event MESSAGE lines under tree glyphs —
  /// the transcript idiom. No attribute field trees.
  Messages,
  /// Everything: each node also reveals its attribute field tree
  /// (`├ key: value`), minus the `message` key that duplicates the line
  /// itself. (`--op logs --json` remains the full raw-record floor.)
  Fields,
}

impl LogZoom {
  pub fn label(self) -> &'static str {
    match self {
      LogZoom::Collapsed => "collapsed",
      LogZoom::Messages => "messages",
      LogZoom::Fields => "fields",
    }
  }
  pub fn zoom_in(self) -> Self {
    match self {
      LogZoom::Collapsed => LogZoom::Messages,
      _ => LogZoom::Fields,
    }
  }
  pub fn zoom_out(self) -> Self {
    match self {
      LogZoom::Fields => LogZoom::Messages,
      _ => LogZoom::Collapsed,
    }
  }
  pub fn from_label(s: &str) -> Option<Self> {
    match s {
      "collapsed" => Some(LogZoom::Collapsed),
      "messages" => Some(LogZoom::Messages),
      "fields" => Some(LogZoom::Fields),
      _ => None,
    }
  }
}

/// One renderable unit of a [`plan`]: a tree plus its coalesced-run state.
pub struct PlanItem<'a> {
  pub tree: &'a SpanTree,
  /// Index of `tree` in the slice passed to [`plan`] — callers that carry
  /// per-tree sidecar data (the CLI's stream tags) recover it here.
  pub index: usize,
  /// `Some((n, last_start_ts))` when this item stands in for `n` identical
  /// consecutive trees (only the first is rendered).
  pub repeat: Option<(usize, DateTime<Utc>)>,
}

/// A banner-only row from the PRE-run-tree restart logger (a full line of
/// `‾`, decoration that used to mark a command start in the stream). The
/// producer stopped writing these in server-app 1.0.53 — the run-group ROOT row
/// carries that meaning now — so this skip only hides legacy rows until
/// retention ages them out, then matches nothing.
fn is_legacy_banner(name: &str) -> bool {
  !name.is_empty() && name.chars().all(|c| c == '‾')
}

/// Walk `trees` with run-coalescing: consecutive childless single-row trees
/// with the same `(name, level, kind)` collapse to one [`PlanItem`] with
/// `repeat = Some((n, last_ts))` once the run reaches [`COALESCE_MIN`].
/// Zoom `Fields` shows every occurrence (it's the reveal-everything level).
/// Legacy banner rows are dropped entirely (see [`is_legacy_banner`]).
pub fn plan(trees: &[SpanTree], zoom: LogZoom) -> Vec<PlanItem<'_>> {
  let mut items = Vec::with_capacity(trees.len());
  let mut k = 0;
  while k < trees.len() {
    let t = &trees[k];
    if t.children.is_empty() && is_legacy_banner(&t.row.name) {
      k += 1;
      continue;
    }
    let coalescible = zoom != LogZoom::Fields && t.children.is_empty();
    let mut run_end = k + 1;
    if coalescible {
      while run_end < trees.len()
        && trees[run_end].children.is_empty()
        && trees[run_end].row.name == t.row.name
        && trees[run_end].row.level == t.row.level
        && trees[run_end].row.kind == t.row.kind
      {
        run_end += 1;
      }
    }
    let n = run_end - k;
    if n >= COALESCE_MIN {
      items.push(PlanItem {
        tree: t,
        index: k,
        repeat: Some((n, trees[run_end - 1].row.start_ts)),
      });
    } else {
      for (off, tree) in trees[k..run_end].iter().enumerate() {
        items.push(PlanItem {
          tree,
          index: k + off,
          repeat: None,
        });
      }
    }
    k = run_end;
  }
  items
}

/// The dimmed suffix appended to an item's LAST rendered line: the coalesce
/// counter (`(×N, last HH:MM:SS)`), and at `Collapsed` zoom the folded-tree
/// badge (`▸N` descendants). `None` when the item needs neither. Shared so
/// the pane and the CLI annotate identically.
pub fn entry_suffix(item: &PlanItem<'_>, zoom: LogZoom) -> Option<String> {
  if let Some((n, last)) = item.repeat {
    return Some(format!(
      "  {GRAY}(×{n}, last {}){RESET}",
      last.with_timezone(&Local).format("%H:%M:%S")
    ));
  }
  if zoom == LogZoom::Collapsed {
    let folded = tree_size(item.tree) - 1;
    if folded > 0 {
      return Some(format!("  {GRAY}▸{folded}{RESET}"));
    }
  }
  None
}

fn tree_size(t: &SpanTree) -> usize {
  1 + t.children.iter().map(tree_size).sum::<usize>()
}

/// Deterministic `span_id (String) → u64` so we can populate `LjsonSpan.id`
/// without minting random ids per render.
fn stable_id(s: &str) -> u64 {
  use std::hash::{Hash, Hasher};
  let mut h = std::collections::hash_map::DefaultHasher::new();
  s.hash(&mut h);
  h.finish()
}

/// A row's `attributes` JSON object, parsed + sorted by key for stable
/// rendering across runs.
fn parsed_attrs(r: &SpanRow) -> Vec<(String, serde_json::Value)> {
  let mut attrs: Vec<(String, serde_json::Value)> =
    serde_json::from_str::<serde_json::Value>(&r.attributes)
      .ok()
      .and_then(|v| v.as_object().cloned())
      .map(|m| m.into_iter().collect())
      .unwrap_or_default();
  attrs.sort_by(|a, b| a.0.cmp(&b.0));
  attrs
}

/// Break a row's attributes out into **child events** (one per key, with
/// `message = "key: value"`), so the formatter's tree path renders them as
/// `├`/`└` children — same UX as a tracing span with attached events. The
/// `message` attribute is skipped when it duplicates the row's own `name`
/// (true for every tracing event), which previously printed each line twice.
/// For HTTP-request roots the keys the renderer inlines into the folded
/// request line (`http.*`/`otel.*`/`span.kind`/dev-mode) are skipped too.
fn attr_children(r: &SpanRow, level: &LjsonLevel, skip_http: bool) -> Vec<LjsonChild> {
  parsed_attrs(r)
    .into_iter()
    .filter(|(k, v)| !(k == "message" && v.as_str() == Some(r.name.as_str())))
    .filter(|(k, _)| {
      !(skip_http
        && (k.starts_with("http.")
          || k.starts_with("otel.")
          || k == "span.kind"
          || k == "app.dev_mode"
          // COMPATIBILITY SHIM: pre-rename rows carry `yuzu.dev_mode`, and
          // hiding only the new name would make every one of them sprout a
          // visible attribute child. Delete once no stored log predates the
          // rename.
          || k == "yuzu.dev_mode"
          || k == "version.dev_flag"))
    })
    .map(|(k, v)| {
      let v_str = match v {
        serde_json::Value::String(s) => s,
        other => serde_json::to_string(&other).unwrap_or_default(),
      };
      let mut event_attrs = HashMap::new();
      event_attrs.insert(
        "message".to_string(),
        serde_json::Value::String(format!("{k}: {v_str}")),
      );
      LjsonChild::Event(LjsonEvent {
        level: level.clone(),
        location: LjsonLocation {
          file: None,
          line: None,
        },
        attributes: event_attrs,
      })
    })
    .collect()
}

/// True when this row is an HTTP-request root (the tracing middleware's
/// `root_span!` stamps `span.kind == "request"`); the renderer folds its
/// `http.*` attrs into one colored request line.
fn is_request_root(r: &SpanRow) -> bool {
  parsed_attrs(r)
    .iter()
    .any(|(k, v)| k == "span.kind" && v.as_str() == Some("request"))
}

/// A recomposed [`SpanTree`] as one [`LjsonEntry`] the canonical formatter
/// can render: the root row becomes the entry's root span, descendant spans
/// recurse as `LjsonChild::Span`, descendant `kind == "event"` leaves become
/// `LjsonChild::Event` (with the row name as `message`). The root's parsed
/// attributes ride along on the `LjsonSpan` (minus `message`), so the
/// renderer's native paths fire: `span.kind == "request"` roots take
/// `render_request_span`'s colored folded line, and `server.*_ms` attrs
/// surface as the gray timing summary. `location` is blank until `SpanRow`
/// carries `file`/`line` (a follow-up producer schema migration).
pub fn tree_to_entry(tree: &SpanTree, zoom: LogZoom) -> LjsonEntry {
  let r = &tree.row;
  // RUN TREES get their timing derived here (see `run_total_ms`): native
  // entries are written at close so `entry.ts` is the END and the renderer
  // shows `ts − duration` as the start; mirror that by shifting `ts` to
  // `start + total`, keeping the displayed start on the root's true start.
  let ts = match run_total_ms(tree) {
    Some(total) => r.start_ts + chrono::Duration::milliseconds(total),
    None => r.start_ts,
  };
  LjsonEntry {
    v: 1,
    ts,
    session_id: Uuid::parse_str(&r.session_id).unwrap_or_else(|_| Uuid::nil()),
    origin: None,
    root_span: tree_to_span(tree, zoom),
  }
}

/// Derived total for a synthesized RUN TREE — a root `kind == "event"` row
/// with children (only stream run groups look like this; native tracing
/// roots are spans with real durations). The rows carry no duration, but
/// their timestamps already hold the timing: total = the latest descendant's
/// `start_ts` minus the root's. Presentation computed from structure — the
/// startup stream's elapsed column stops being blank.
fn run_total_ms(tree: &SpanTree) -> Option<i64> {
  if tree.row.kind != "event" || tree.children.is_empty() {
    return None;
  }
  fn max_ts(t: &SpanTree) -> chrono::DateTime<Utc> {
    t.children
      .iter()
      .map(max_ts)
      .max()
      .map_or(t.row.start_ts, |m| m.max(t.row.start_ts))
  }
  Some((max_ts(tree) - tree.row.start_ts).num_milliseconds().max(0))
}

fn tree_to_span(tree: &SpanTree, zoom: LogZoom) -> LjsonSpan {
  let r = &tree.row;
  let level = LjsonLevel::from_str(&r.level).unwrap_or(LjsonLevel::Info);
  // Run-tree children render their OFFSET from the run root in the gray
  // child-elapsed column (`perf.elapsed` — the key `render_event` already
  // reads), so inter-phase gaps are scannable.
  let run_total = run_total_ms(tree);
  let child_offset = |child: &SpanTree| -> Option<i64> {
    run_total?;
    Some((child.row.start_ts - r.start_ts).num_milliseconds().max(0))
  };
  let mut children = Vec::new();
  if zoom == LogZoom::Fields {
    children.extend(attr_children(r, &level, is_request_root(r)));
  }
  if zoom != LogZoom::Collapsed {
    for child in &tree.children {
      let is_leaf_event = child.row.kind == "event" && child.children.is_empty();
      if !is_leaf_event {
        children.push(LjsonChild::Span(tree_to_span(child, zoom)));
        continue;
      }
      // The formatter only displays an event's `message` — extra fields on
      // an LjsonEvent are invisible. At `Fields` zoom an attr-bearing event
      // therefore becomes a span NODE so its field tree nests beneath its
      // message line; otherwise it stays a plain message event.
      let child_level = LjsonLevel::from_str(&child.row.level).unwrap_or(LjsonLevel::Info);
      let fields = if zoom == LogZoom::Fields {
        attr_children(&child.row, &child_level, false)
      } else {
        Vec::new()
      };
      if fields.is_empty() {
        let mut event = event_node(&child.row);
        if let Some(offset) = child_offset(child) {
          event
            .attributes
            .insert("perf.elapsed".to_string(), serde_json::json!(offset));
        }
        children.push(LjsonChild::Event(event));
      } else {
        children.push(LjsonChild::Span(LjsonSpan {
          id: stable_id(&child.row.span_id),
          name: child.row.name.clone(),
          level: child_level,
          duration_ms: child.row.duration_ms.or_else(|| child_offset(child)),
          location: LjsonLocation {
            file: None,
            line: None,
          },
          attributes: HashMap::new(),
          children: fields,
        }));
      }
    }
  }
  // Pass the row's attributes through (minus `message`, whose inline print
  // would re-double event-shaped rows) so the renderer's attribute-driven
  // paths — the folded request line, the timing summary — see them.
  let attributes: HashMap<String, serde_json::Value> = parsed_attrs(r)
    .into_iter()
    .filter(|(k, _)| k != "message")
    .collect();
  LjsonSpan {
    id: stable_id(&r.span_id),
    name: r.name.clone(),
    level,
    duration_ms: r.duration_ms.or(run_total),
    location: LjsonLocation {
      file: None,
      line: None,
    },
    attributes,
    children,
  }
}

fn event_node(r: &SpanRow) -> LjsonEvent {
  let level = LjsonLevel::from_str(&r.level).unwrap_or(LjsonLevel::Info);
  let mut attributes: HashMap<String, serde_json::Value> = HashMap::new();
  attributes.insert(
    "message".to_string(),
    serde_json::Value::String(r.name.clone()),
  );
  LjsonEvent {
    level,
    location: LjsonLocation {
      file: None,
      line: None,
    },
    attributes,
  }
}
