//! `ux-test.run-report/v1` — what `ux-test run` did, as data.
//!
//! The release pipeline used to decide a candidate by regex-scraping the run's
//! human output: the `=== batch run: N passed / … ===` tally, the
//! `no tests to run … all N were skipped` line, and anything shaped like a run
//! id. Every one of those is a sentence written for a person, and each time one
//! changed (or a group printed its usage block first) the verdict silently lost
//! a fact. This module is the same facts as types: `ux-test run --json` prints a
//! [`RunReport`], `--json-out <path>` writes it while stdout stays human.
//!
//! It also carries [`SpecAccounts`] — `ux-test spec.accounts` — which answers
//! "which account does each spec name" with the crate's real YAML parser rather
//! than a hand-written subset reader.
//!
//! The human output is unchanged by any of this; [`tally_line`] and
//! [`nothing_to_run_reason`] are the exact strings it prints, kept here so the
//! report's counts and the printed tally are computed by one piece of code.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ledger::ArtifactIdentity;
use crate::spec::TestSpec;

/// The `type` tag of a [`RunReport`].
pub const RUN_REPORT_TYPE: &str = "ux-test.run-report/v1";

/// The `type` tag of a [`SpecAccounts`] document.
pub const SPEC_ACCOUNTS_TYPE: &str = "ux-test.spec-accounts/v1";

/// Env var a pipeline sets to stamp every result of a run with the artifact it
/// measured: a JSON [`ArtifactIdentity`] object. `--artifact-*` flags win.
pub const ARTIFACT_ENV: &str = "TENTO_UX_ARTIFACT";

/// One `ux-test run` invocation, every `--env` profile included.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
  /// Always [`RUN_REPORT_TYPE`].
  #[serde(rename = "type")]
  pub kind: String,
  /// The status the command exits with: `0` when it returned success, `1`
  /// when it returned an error.
  pub exit_code: i32,
  pub started_at: DateTime<Utc>,
  pub ended_at: DateTime<Utc>,
  pub runner: RunnerIdentity,
  /// The artifact the whole run was stamped with, when one was.
  pub artifact: Option<ArtifactIdentity>,
  /// Why the command failed before or around the profiles — an unknown `--env`,
  /// a malformed artifact stamp. A profile's own failure is on the profile.
  pub error: Option<String>,
  /// One per `--env` profile, in the order given.
  pub profiles: Vec<ProfileReport>,
}

impl RunReport {
  pub fn new(started_at: DateTime<Utc>, runner: RunnerIdentity) -> Self {
    Self {
      kind: RUN_REPORT_TYPE.to_string(),
      exit_code: 0,
      started_at,
      ended_at: started_at,
      runner,
      artifact: None,
      error: None,
      profiles: Vec::new(),
    }
  }
}

/// Which runner produced a report.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerIdentity {
  /// The machine that drove the run (`hostname`).
  pub host: String,
  /// The `tento-ux-test` crate version compiled into the runner. Not the host
  /// binary's version: the crate is mounted by several hosts and is not told
  /// theirs.
  pub version: String,
}

impl RunnerIdentity {
  pub fn local() -> Self {
    Self {
      host: crate::ledger::local_hostname(),
      version: env!("CARGO_PKG_VERSION").to_string(),
    }
  }
}

/// How a run chose its specs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SelectionKind {
  /// `--group <name>`.
  Group,
  /// `--test <id>`.
  Test,
  /// `--all`.
  All,
  /// `--file <path>`, a spec file or a directory of them.
  File,
  /// `--name` + `--instructions`.
  Ephemeral,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
  pub kind: SelectionKind,
  /// The group, test id, path or ephemeral name. Absent for `--all`.
  pub name: Option<String>,
}

/// How one profile's run stands.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProfileOutcome {
  /// Every driven spec passed or stopped at a declared-manual step.
  Passed,
  /// A spec failed, or the profile errored before or while running them.
  /// Independent of the exit code: a manual batch with a red spec exits 0 (a
  /// human reads it) and is still `failed` here.
  Failed,
  /// The selection had nothing to drive — every spec was skipped, or none
  /// matched. The command exits non-zero, but nothing broke.
  NothingToRun,
}

/// The four numbers the human tally prints, from the same specs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
  pub passed: usize,
  pub partial: usize,
  pub failed: usize,
  pub skipped: usize,
}

impl Counts {
  pub fn of(specs: &[SpecReport]) -> Self {
    let mut counts = Counts::default();
    for spec in specs {
      match spec.outcome {
        SpecOutcome::Passed => counts.passed += 1,
        SpecOutcome::Partial => counts.partial += 1,
        SpecOutcome::Failed => counts.failed += 1,
        SpecOutcome::Skipped => counts.skipped += 1,
      }
    }
    counts
  }
}

/// A selection that drove nothing.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NothingToRun {
  /// How many specs matched and were skipped. `0` when none matched at all.
  pub skipped: usize,
  /// The exact line the runner printed.
  pub reason: String,
}

/// One `--env` profile's run.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileReport {
  /// The profile name (`local` for the built-in).
  pub env: String,
  /// The origin every driven spec in this profile agreed on. Absent when none
  /// was driven or they drove different origins (a multi-origin product) —
  /// each spec's own `target` is authoritative.
  pub target: Option<String>,
  pub selection: Selection,
  /// The label in the human tally line (`group events · env rc`).
  pub label: Option<String>,
  pub outcome: ProfileOutcome,
  pub counts: Counts,
  pub nothing_to_run: Option<NothingToRun>,
  /// The error the profile returned, when it did.
  pub error: Option<String>,
  pub specs: Vec<SpecReport>,
}

impl ProfileReport {
  pub fn new(env: String, selection: Selection) -> Self {
    Self {
      env,
      target: None,
      selection,
      label: None,
      outcome: ProfileOutcome::Passed,
      counts: Counts::default(),
      nothing_to_run: None,
      error: None,
      specs: Vec::new(),
    }
  }

  /// Derive the counts, the shared target and the outcome from the specs and
  /// the profile's result. Called once, after the profile ran.
  pub fn settle(&mut self, error: Option<String>) {
    self.counts = Counts::of(&self.specs);
    let mut origins = self.specs.iter().filter_map(|s| s.target.as_deref());
    self.target = origins.next().and_then(|first| {
      let mut rest = origins;
      rest.all(|o| o == first).then(|| first.to_string())
    });
    self.outcome = if self.nothing_to_run.is_some() {
      ProfileOutcome::NothingToRun
    } else if error.is_some() || self.counts.failed > 0 {
      ProfileOutcome::Failed
    } else {
      ProfileOutcome::Passed
    };
    self.error = error;
  }
}

/// How one spec counts.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpecOutcome {
  Passed,
  /// Drove the automatable prefix, stopped at a declared-manual step.
  Partial,
  Failed,
  /// Never started: `--auto` had nothing headless to drive.
  Skipped,
}

/// Why `--auto` skipped a spec.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
  /// No `verification` block, no steps, or a step with neither `actions` nor
  /// a reasoned `manual: true`.
  NotAutoRunnable,
  /// The first step is declared manual — the automatable prefix is empty.
  FirstStepManual,
  /// The spec.yaml is missing or does not parse.
  Unparseable,
}

/// Where the account a run drove came from.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UserSource {
  /// `--user`.
  Flag,
  /// The spec's `params.user_email` (after setup actions ran).
  Spec,
  /// The host's default account.
  HostDefault,
}

/// One spec in one profile.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpecReport {
  /// The test id (a path for a directory `--file` run whose spec did not load).
  pub id: String,
  pub group: Option<String>,
  pub outcome: SpecOutcome,
  pub skip_reason: Option<SkipReason>,
  /// The declared reason of the manual step that stopped or skipped the spec.
  pub manual_reason: Option<String>,
  /// The session run id (`<date>_<test>_<hex>`) — absent when no session was
  /// created (a skip, or an error before Phase 2).
  pub run: Option<String>,
  pub session_dir: Option<PathBuf>,
  /// The absolute origin the session drove.
  pub target: Option<String>,
  /// The account the headless browser authenticated as. Absent on a manual
  /// run: the operator drives in their own browser and the runner picks no one.
  pub user: Option<String>,
  pub user_source: Option<UserSource>,
  /// Wall time of this spec, absent when it was skipped.
  pub duration_ms: Option<u64>,
  /// The short result the human summary row prints.
  pub result: Option<String>,
  /// The failure feedback — the same text the ledger entry's `note` carries.
  pub note: Option<String>,
  pub blocker: Option<String>,
  pub artifact: Option<ArtifactIdentity>,
}

impl SpecReport {
  pub fn new(id: String, group: Option<String>) -> Self {
    Self {
      id,
      group,
      outcome: SpecOutcome::Failed,
      skip_reason: None,
      manual_reason: None,
      run: None,
      session_dir: None,
      target: None,
      user: None,
      user_source: None,
      duration_ms: None,
      result: None,
      note: None,
      blocker: None,
      artifact: None,
    }
  }

  pub fn skipped(id: String, group: Option<String>, skip: AutoSkip) -> Self {
    let mut report = Self::new(id, group);
    report.outcome = SpecOutcome::Skipped;
    report.skip_reason = Some(skip.reason);
    report.manual_reason = skip.manual_reason;
    report
  }
}

/// The batch summary line, exactly as `ux-test run` prints it.
pub fn tally_line(counts: Counts, label: &str) -> String {
  format!(
    "\n=== batch run: {} passed / {} partial / {} failed / {} skipped ({label}) ===",
    counts.passed, counts.partial, counts.failed, counts.skipped
  )
}

/// The error a selection with nothing to drive returns, exactly as printed.
pub fn nothing_to_run_reason(label: &str, skipped: usize) -> String {
  if skipped > 0 {
    format!("no tests to run ({label}) — all {skipped} were skipped")
  } else {
    format!("no tests to run ({label})")
  }
}

/// Why `--auto` would not drive a spec — `None` when it would.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutoSkip {
  pub reason: SkipReason,
  pub manual_reason: Option<String>,
}

/// The one judgement `run --all --auto` and `spec.accounts` share about whether
/// a spec has anything headless to drive. `spec` is `None` when it could not be
/// loaded.
pub fn auto_skip(spec: Option<&TestSpec>) -> Option<AutoSkip> {
  let Some(spec) = spec else {
    return Some(AutoSkip {
      reason: SkipReason::Unparseable,
      manual_reason: None,
    });
  };
  if !spec.is_auto_runnable() {
    return Some(AutoSkip {
      reason: SkipReason::NotAutoRunnable,
      manual_reason: None,
    });
  }
  match spec.first_manual_step() {
    Some((0, step)) => Some(AutoSkip {
      reason: SkipReason::FirstStepManual,
      manual_reason: step.manual_reason.clone(),
    }),
    _ => None,
  }
}

// ===========================================================================
// spec.accounts
// ===========================================================================

/// What a spec says about its account — the three answers release-ci's lane
/// scheduler distinguishes (`account` / `none` / `unknown`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpecAccount {
  /// `params.user_email` names this account.
  Account { email: String },
  /// The spec parsed and declares no `params.user_email`: the runner picks
  /// (`--user`, else the host default).
  #[serde(rename = "none")]
  NoAccount,
  /// Cannot be told. The spec does not parse — in which case the runner cannot
  /// run it either — or its `user_email` is empty or templated.
  Unknown { reason: String },
}

impl SpecAccount {
  /// Read the account a spec's text declares, with the same parser the runner
  /// loads it with.
  pub fn of_yaml(text: &str) -> Self {
    match TestSpec::from_yaml(text) {
      Ok(spec) => Self::of_spec(&spec),
      Err(e) => Self::Unknown {
        reason: format!("{e:#}"),
      },
    }
  }

  pub fn of_spec(spec: &TestSpec) -> Self {
    match spec.params.get("user_email") {
      None => Self::NoAccount,
      Some(email) if email.trim().is_empty() => Self::Unknown {
        // The runner would pass "" verbatim, and refuse any `--user` beside it.
        reason: "params.user_email is empty".to_string(),
      },
      Some(email) if email.contains("{{") => Self::Unknown {
        reason: format!("params.user_email is templated ({email})"),
      },
      Some(email) => Self::Account {
        email: email.clone(),
      },
    }
  }

  /// The flat `user` field: the email, `null`, or the string `"unknown"`.
  pub fn user_value(&self) -> serde_json::Value {
    match self {
      Self::Account { email } => serde_json::Value::String(email.clone()),
      Self::NoAccount => serde_json::Value::Null,
      Self::Unknown { .. } => serde_json::Value::String("unknown".to_string()),
    }
  }
}

/// One spec's line in `spec.accounts`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpecAccountEntry {
  pub id: String,
  pub group: Option<String>,
  /// Whether `--auto` skips it — the same judgement `run --all --auto` makes.
  pub manual: bool,
  pub manual_reason: Option<String>,
  pub skip_reason: Option<SkipReason>,
  /// `"<email>"`, `null` (names none) or `"unknown"`.
  pub user: serde_json::Value,
  /// The same answer, tagged, with the reason when unknown.
  pub account: SpecAccount,
}

impl SpecAccountEntry {
  /// Build the entry for one spec's text.
  pub fn from_yaml(id: String, group: Option<String>, text: Option<&str>) -> Self {
    let spec = text.map(TestSpec::from_yaml);
    let account = match &spec {
      Some(Ok(spec)) => SpecAccount::of_spec(spec),
      Some(Err(e)) => SpecAccount::Unknown {
        reason: format!("{e:#}"),
      },
      None => SpecAccount::Unknown {
        reason: "spec.yaml is unreadable".to_string(),
      },
    };
    let skip = auto_skip(spec.as_ref().and_then(|s| s.as_ref().ok()));
    Self {
      id,
      group,
      manual: skip.is_some(),
      manual_reason: skip.as_ref().and_then(|s| s.manual_reason.clone()),
      skip_reason: skip.map(|s| s.reason),
      user: account.user_value(),
      account,
    }
  }
}

/// `ux-test spec.accounts` output.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpecAccounts {
  /// Always [`SPEC_ACCOUNTS_TYPE`].
  #[serde(rename = "type")]
  pub kind: String,
  pub root: PathBuf,
  pub specs: Vec<SpecAccountEntry>,
}

#[cfg(test)]
mod tests {
  use super::*;

  fn artifact() -> ArtifactIdentity {
    ArtifactIdentity {
      product: "lona".to_string(),
      version: "1.0.87".to_string(),
      git_hash: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12".to_string(),
      fingerprint: None,
      stem: Some("lona-1.0.87-macos-arm64".to_string()),
    }
  }

  /// The two-spec example the README shows, built the way `run` builds it.
  fn two_spec_report() -> RunReport {
    let started = "2026-09-24T18:00:00Z".parse().expect("fixture time");
    let mut report = RunReport::new(
      started,
      RunnerIdentity {
        host: "rwc-04".to_string(),
        version: "0.1.0".to_string(),
      },
    );
    report.ended_at = "2026-09-24T18:01:30Z".parse().expect("fixture time");
    report.artifact = Some(artifact());

    let mut profile = ProfileReport::new(
      "rc".to_string(),
      Selection {
        kind: SelectionKind::Group,
        name: Some("events".to_string()),
      },
    );
    profile.label = Some("group events · env rc".to_string());

    let mut pass = SpecReport::new("event-flow-create".to_string(), Some("events".to_string()));
    pass.outcome = SpecOutcome::Passed;
    pass.run = Some("2026-09-24_event-flow-create_a5c3cf".to_string());
    pass.session_dir = Some(PathBuf::from(
      "/corpus/events/event-flow-create/runs/2026-09-24_event-flow-create_a5c3cf",
    ));
    pass.target = Some("https://rc--calendar.lona.so".to_string());
    pass.user = Some("operator-tester@lona.so".to_string());
    pass.user_source = Some(UserSource::Spec);
    pass.duration_ms = Some(41_250);
    pass.result = Some("success (auto, verify=true)".to_string());
    pass.artifact = Some(artifact());
    profile.specs.push(pass);

    profile.specs.push(SpecReport::skipped(
      "event-flow-oauth".to_string(),
      Some("events".to_string()),
      AutoSkip {
        reason: SkipReason::FirstStepManual,
        manual_reason: Some("third-party consent screen".to_string()),
      },
    ));
    profile.settle(None);
    report.profiles.push(profile);
    report
  }

  #[test]
  fn run_report_serialises_to_the_documented_shape() {
    let json = serde_json::to_value(two_spec_report()).expect("serialise");
    let golden = serde_json::json!({
      "type": "ux-test.run-report/v1",
      "exitCode": 0,
      "startedAt": "2026-09-24T18:00:00Z",
      "endedAt": "2026-09-24T18:01:30Z",
      "runner": {"host": "rwc-04", "version": "0.1.0"},
      "artifact": {
        "product": "lona",
        "version": "1.0.87",
        "gitHash": "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
        "stem": "lona-1.0.87-macos-arm64"
      },
      "profiles": [{
        "env": "rc",
        "target": "https://rc--calendar.lona.so",
        "selection": {"kind": "group", "name": "events"},
        "label": "group events · env rc",
        "outcome": "passed",
        "counts": {"passed": 1, "partial": 0, "failed": 0, "skipped": 1},
        "specs": [
          {
            "id": "event-flow-create",
            "group": "events",
            "outcome": "passed",
            "run": "2026-09-24_event-flow-create_a5c3cf",
            "sessionDir": "/corpus/events/event-flow-create/runs/2026-09-24_event-flow-create_a5c3cf",
            "target": "https://rc--calendar.lona.so",
            "user": "operator-tester@lona.so",
            "userSource": "spec",
            "durationMs": 41250,
            "result": "success (auto, verify=true)",
            "artifact": {
              "product": "lona",
              "version": "1.0.87",
              "gitHash": "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
              "stem": "lona-1.0.87-macos-arm64"
            }
          },
          {
            "id": "event-flow-oauth",
            "group": "events",
            "outcome": "skipped",
            "skipReason": "first_step_manual",
            "manualReason": "third-party consent screen"
          }
        ]
      }]
    });
    assert_eq!(json, golden);

    // And it reads back as itself: the pipeline deserialises what we write.
    let back: RunReport = serde_json::from_value(json).expect("deserialise");
    assert_eq!(back, two_spec_report());
  }

  /// The report's counts and the printed tally come from one function, and the
  /// line still says what release-ci's `BATCH_TALLY` regex reads.
  #[test]
  fn report_counts_equal_the_human_tally() {
    let outcomes = [
      SpecOutcome::Passed,
      SpecOutcome::Passed,
      SpecOutcome::Partial,
      SpecOutcome::Failed,
      SpecOutcome::Skipped,
      SpecOutcome::Passed,
      SpecOutcome::Skipped,
    ];
    let mut profile = ProfileReport::new(
      "ci".to_string(),
      Selection {
        kind: SelectionKind::All,
        name: None,
      },
    );
    for (i, outcome) in outcomes.into_iter().enumerate() {
      let mut spec = SpecReport::new(format!("t{i}"), None);
      spec.outcome = outcome;
      profile.specs.push(spec);
    }
    profile.settle(None);

    let line = tally_line(profile.counts, "corpus (--all) · env ci");
    assert_eq!(
      line,
      "\n=== batch run: 3 passed / 1 partial / 1 failed / 2 skipped (corpus (--all) · env ci) ==="
    );
    let tally = regex::Regex::new(
      r"batch run:\s*(\d+) passed\s*/\s*(\d+) partial\s*/\s*(\d+) failed\s*/\s*(\d+) skipped",
    )
    .expect("regex");
    let caps = tally
      .captures(&line)
      .expect("the pipeline's regex reads it");
    let n = |i: usize| caps[i].parse::<usize>().expect("count");
    assert_eq!(
      Counts {
        passed: n(1),
        partial: n(2),
        failed: n(3),
        skipped: n(4),
      },
      profile.counts
    );
    assert_eq!(profile.outcome, ProfileOutcome::Failed);
  }

  #[test]
  fn nothing_to_run_keeps_the_printed_sentence() {
    assert_eq!(
      nothing_to_run_reason("group extraction · env ci", 1),
      "no tests to run (group extraction · env ci) — all 1 were skipped"
    );
    assert_eq!(nothing_to_run_reason("g", 0), "no tests to run (g)");
  }

  #[test]
  fn a_shared_target_is_reported_only_when_every_spec_agrees() {
    let mut profile = ProfileReport::new(
      "dev".to_string(),
      Selection {
        kind: SelectionKind::All,
        name: None,
      },
    );
    for origin in ["https://dev.lona.so", "https://dev--calendar.lona.so"] {
      let mut spec = SpecReport::new("t".to_string(), None);
      spec.outcome = SpecOutcome::Passed;
      spec.target = Some(origin.to_string());
      profile.specs.push(spec);
    }
    profile.settle(None);
    assert_eq!(profile.target, None);
    profile.specs.pop();
    profile.settle(None);
    assert_eq!(profile.target.as_deref(), Some("https://dev.lona.so"));
  }

  const NAMES_ONE: &str =
    "id: a\nname: A\ninstructions: []\nparams:\n  user_email: operator-tester@lona.so\n";
  const NAMES_NONE: &str =
    "id: b\nname: B\ninstructions: []\nparams:\n  server_url: https://dev.lona.so\n";
  const BROKEN: &str = "id: c\nname: C\nparams: &p\n  user_email: [not, a, string\n";

  #[test]
  fn spec_accounts_reports_value_null_and_unknown() {
    let one = SpecAccountEntry::from_yaml("a".to_string(), None, Some(NAMES_ONE));
    assert_eq!(one.user, serde_json::json!("operator-tester@lona.so"));
    assert_eq!(
      one.account,
      SpecAccount::Account {
        email: "operator-tester@lona.so".to_string()
      }
    );

    let none =
      SpecAccountEntry::from_yaml("b".to_string(), Some("g".to_string()), Some(NAMES_NONE));
    assert_eq!(none.user, serde_json::Value::Null);
    assert_eq!(none.account, SpecAccount::NoAccount);
    // No steps, no verification: `--auto` would skip it.
    assert!(none.manual);
    assert_eq!(none.skip_reason, Some(SkipReason::NotAutoRunnable));

    let broken = SpecAccountEntry::from_yaml("c".to_string(), None, Some(BROKEN));
    assert_eq!(broken.user, serde_json::json!("unknown"));
    assert!(matches!(broken.account, SpecAccount::Unknown { .. }));
    assert_eq!(broken.skip_reason, Some(SkipReason::Unparseable));

    // `null` stays on the wire — the lane scheduler must see "names none",
    // not a missing key.
    let wire = serde_json::to_value(&none).expect("serialise");
    assert_eq!(wire["user"], serde_json::Value::Null);
    assert_eq!(wire["account"], serde_json::json!({"kind": "none"}));
    let wire = serde_json::to_value(&broken).expect("serialise");
    assert_eq!(wire["account"]["kind"], "unknown");
  }

  #[test]
  fn an_empty_or_templated_user_email_is_unknown() {
    let empty =
      SpecAccount::of_yaml("id: e\nname: E\ninstructions: []\nparams:\n  user_email: ''\n");
    assert!(matches!(empty, SpecAccount::Unknown { .. }), "{empty:?}");
    let templated =
      SpecAccount::of_yaml("id: t\nname: T\ninstructions: []\nparams:\n  user_email: '{{who}}'\n");
    assert!(
      matches!(templated, SpecAccount::Unknown { .. }),
      "{templated:?}"
    );
  }

  #[test]
  fn auto_skip_matches_the_batch_runner() {
    let yaml = |first_manual: bool| {
      let (first, second) = if first_manual {
        ("consent", "drive")
      } else {
        ("drive", "consent")
      };
      let step = |id: &str| {
        if id == "consent" {
          "  - id: consent\n    instruction: approve\n    manual: true\n    \
           manual_reason: third-party consent screen\n"
            .to_string()
        } else {
          "  - id: drive\n    instruction: do\n    actions:\n      - action: wait\n        ms: 10\n"
            .to_string()
        }
      };
      format!(
        "id: t\nname: T\nsteps:\n{}{}verification:\n  required_logs:\n    - pattern: x\n",
        step(first),
        step(second)
      )
    };

    let manual_first = TestSpec::from_yaml(&yaml(true)).expect("fixture parses");
    assert_eq!(
      auto_skip(Some(&manual_first)),
      Some(AutoSkip {
        reason: SkipReason::FirstStepManual,
        manual_reason: Some("third-party consent screen".to_string()),
      })
    );
    // A drivable prefix is not skipped — it runs and reports `partial`.
    let manual_later = TestSpec::from_yaml(&yaml(false)).expect("fixture parses");
    assert_eq!(auto_skip(Some(&manual_later)), None);
    assert_eq!(
      auto_skip(None).map(|s| s.reason),
      Some(SkipReason::Unparseable)
    );
  }
}
