use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tento_openapi::ToSchema;
use uuid::Uuid;

use crate::folder::RunStore;
use crate::spec::TestSpec;

#[derive(Clone)]
pub struct LLMLogger {
  runs: RunStore,
}

/// Read + parse a run dir's `session.json`; `None` if absent/malformed.
fn read_session_at(dir: &Path) -> Option<Session> {
  serde_json::from_str(&fs::read_to_string(dir.join("session.json")).ok()?).ok()
}

#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[serde_with::skip_serializing_none]
pub struct Session {
  pub id: String,
  pub prefix: String,
  /// Instructions as an array of steps.
  pub instructions: Vec<String>,
  pub metadata: Option<serde_json::Value>,
  pub status: SessionStatus,
  pub created_at: DateTime<Utc>,
  /// If set, this is a flaky test - always visible, logs buffered until completion.
  /// The string contains context about what problem is being debugged.
  pub flaky: Option<String>,
  /// UUID linking this session to client/server tracing entries in loaf.ljson.
  /// Used by `ux-test trace` to filter and graft the unified trace.
  pub tracing_uuid: Option<Uuid>,
  /// Curated params to display in the UX test overlay (label + resolved value).
  pub display_params: Option<Vec<SessionParam>>,
  /// The test this run belongs to (== `spec.id`); the run nests under
  /// `<ux_tests_root>/<test_id>/runs/<id>/`. Optional for back-compat with
  /// legacy flat sessions that predate the per-test layout (missing ⇒ `None`).
  pub test_id: Option<String>,
  /// Checked step indices, server-owned. Written only by
  /// [`LLMLogger::set_step`]; the popover hydrates from this rather than the
  /// cross-subdomain cookie, so every surface a session crosses agrees on
  /// which steps are done. Defaulted for sessions predating the field.
  #[serde(default)]
  pub completed_steps: Vec<usize>,
}

#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionParam {
  pub label: String,
  pub value: String,
  /// Index into the `instructions` array where this param should appear.
  #[serde(default)]
  pub step_index: usize,
}

#[derive(Serialize, Deserialize, ToSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
  Pending,
  InProgress,
  Completed,
  Abandoned,
}

#[derive(Serialize, Deserialize, ToSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionResult {
  Success,
  Failure,
}

#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[serde_with::skip_serializing_none]
pub struct SessionCompletion {
  pub result: SessionResult,
  pub feedback: Option<String>,
}

impl LLMLogger {
  /// Flat-mode logger over a single base dir (the legacy global store).
  /// Equivalent to the pre-`.ux-tests` behavior — used where no `.ux-tests`
  /// root is configured (e.g. production, which authors no specs).
  pub fn new(base_dir: PathBuf) -> Self {
    Self {
      runs: RunStore::new(None, Some(base_dir)),
    }
  }

  /// Logger rooted at a `.ux-tests` tree, with the legacy flat store dual-read
  /// so historical + in-flight flat sessions keep resolving during the
  /// transition.
  pub fn new_rooted(ux_tests_root: PathBuf, legacy_flat: Option<PathBuf>) -> Self {
    Self {
      runs: RunStore::new(Some(ux_tests_root), legacy_flat),
    }
  }

  /// The underlying run store (resolve / enumerate / test-centric listing).
  pub fn runs(&self) -> &RunStore {
    &self.runs
  }

  pub fn get_first_pending(&self) -> Result<Option<Session>> {
    for path in self.runs.all_run_dirs() {
      let Some(session) = read_session_at(&path) else {
        continue;
      };
      // Only return non-flaky pending sessions (flaky ones are handled separately)
      if session.status == SessionStatus::Pending && session.flaky.is_none() {
        return Ok(Some(session));
      }
    }
    Ok(None)
  }

  /// Get all pending flaky sessions.
  pub fn get_all_pending_flaky(&self) -> Result<Vec<Session>> {
    let mut sessions = Vec::new();
    for path in self.runs.all_run_dirs() {
      let Some(session) = read_session_at(&path) else {
        continue;
      };
      if session.status == SessionStatus::Pending && session.flaky.is_some() {
        sessions.push(session);
      }
    }
    Ok(sessions)
  }

  pub fn get_pending_count(&self) -> Result<usize> {
    let mut count = 0;
    for path in self.runs.all_run_dirs() {
      let Some(session) = read_session_at(&path) else {
        continue;
      };
      // Only count non-flaky pending sessions
      if session.status == SessionStatus::Pending && session.flaky.is_none() {
        count += 1;
      }
    }
    Ok(count)
  }

  pub fn append_ljson_entries(
    &self,
    session_id: &str,
    entries: &[serde_json::Value],
  ) -> Result<()> {
    let session_dir = self.find_session_dir(session_id)?;
    let ljson_file = session_dir.join("logs.ljson");

    let mut file = OpenOptions::new()
      .create(true)
      .append(true)
      .open(&ljson_file)
      .context("Failed to open logs.ljson")?;

    for entry in entries {
      let line = serde_json::to_string(entry).context("Failed to serialize LJSON entry")?;
      writeln!(file, "{}", line).context("Failed to write LJSON entry")?;
    }

    Ok(())
  }

  pub fn mark_complete(
    &self,
    session_id: &str,
    result: SessionResult,
    feedback: Option<String>,
  ) -> Result<()> {
    self.update_status(session_id, SessionStatus::Completed)?;

    let session_dir = self.find_session_dir(session_id)?;

    // Write complete.json with result and feedback
    let completion = SessionCompletion {
      result,
      feedback: feedback.filter(|f| !f.is_empty()),
    };
    let complete_file = session_dir.join("complete.json");
    let complete_json =
      serde_json::to_string_pretty(&completion).context("Failed to serialize completion")?;
    fs::write(&complete_file, complete_json).context("Failed to write complete.json")?;

    // Refresh the per-test status rollup (nested mode) now that this run's
    // outcome is final.
    self.refresh_status(session_id);

    Ok(())
  }

  /// Persist the authoritative verdict for a run, beside its trace.
  ///
  /// Deliberately a separate file from `complete.json`. That one is written by
  /// whoever *finished* the session — an operator clicking Works, or the
  /// headless runner posting a neutral `headless: N steps executed`. This one
  /// is written by the judges, and it is the only artifact that records what
  /// they decided. Lives on `LLMLogger` rather than the CLI because the
  /// `complete` route audits completions too, not just the runner.
  ///
  /// Callers follow this with [`refresh_status`](Self::refresh_status): the
  /// rollup that ran at `mark_complete` time predates this record, and
  /// `status.json` would stay frozen at the pre-verdict reading otherwise.
  pub fn write_verification_record(
    &self,
    session_id: &str,
    outcome: crate::folder::VerificationOutcome,
    detail: Option<String>,
  ) -> Result<()> {
    self.write_record(session_id, outcome, detail, false)
  }

  /// The server's completion audit: a provisional verdict that the run's
  /// owner (the runner's Phase 5, or `finalize`) replaces. An audit that lands
  /// after the owner's final record leaves it alone; replacing it would make a
  /// retried `finalize` tear the run down and ledger it a second time.
  pub fn write_completion_audit(
    &self,
    session_id: &str,
    outcome: crate::folder::VerificationOutcome,
    detail: Option<String>,
  ) -> Result<()> {
    if crate::folder::has_final_verification(&self.session_dir(session_id)?) {
      return Ok(());
    }
    self.write_record(session_id, outcome, detail, true)
  }

  fn write_record(
    &self,
    session_id: &str,
    outcome: crate::folder::VerificationOutcome,
    detail: Option<String>,
    provisional: bool,
  ) -> Result<()> {
    let dir = self.session_dir(session_id)?;
    let record = crate::folder::VerificationRecord {
      outcome,
      at: Utc::now(),
      detail,
      provisional,
    };
    let path = dir.join("verification.json");
    fs::write(
      &path,
      serde_json::to_string_pretty(&record).context("serializing verification record")?,
    )
    .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
  }

  pub fn read_completion(&self, session_id: &str) -> Result<Option<SessionCompletion>> {
    let session_dir = self.find_session_dir(session_id)?;
    let complete_file = session_dir.join("complete.json");

    if !complete_file.exists() {
      return Ok(None);
    }

    let content = fs::read_to_string(&complete_file).context("Failed to read complete.json")?;
    let completion: SessionCompletion =
      serde_json::from_str(&content).context("Failed to parse complete.json")?;
    Ok(Some(completion))
  }

  pub fn read_feedback(&self, session_id: &str) -> Result<Option<String>> {
    let completion = self.read_completion(session_id)?;
    Ok(completion.and_then(|c| c.feedback))
  }

  pub fn mark_in_progress(&self, session_id: &str) -> Result<()> {
    self.update_status(session_id, SessionStatus::InProgress)
  }

  /// Idempotent, server-owned step marking. The popover posts the *desired*
  /// state; the server updates `completed_steps` in `session.json` and
  /// appends the authoritative `step-marker` entry to the trace itself. A
  /// post that matches current state is a no-op — no session write, no
  /// duplicate marker — which is what makes repeated or stale-UI clicks safe.
  /// Single writer: the client no longer emits step-markers through the
  /// Tracing batch (they arrived out of order and oscillated when the popover
  /// UI lagged the cookie).
  pub fn set_step(
    &self,
    session_id: &str,
    step_index: usize,
    step_text: &str,
    checked: bool,
  ) -> Result<()> {
    let session_dir = self.find_session_dir(session_id)?;
    let session_file = session_dir.join("session.json");
    let content = fs::read_to_string(&session_file).context("Failed to read session.json")?;
    let mut session: Session =
      serde_json::from_str(&content).context("Failed to parse session.json")?;

    let had = session.completed_steps.contains(&step_index);
    if checked == had {
      return Ok(());
    }
    if checked {
      session.completed_steps.push(step_index);
      session.completed_steps.sort_unstable();
    } else {
      session.completed_steps.retain(|s| *s != step_index);
    }
    let updated = serde_json::to_string_pretty(&session).context("Failed to serialize session")?;
    fs::write(&session_file, updated).context("Failed to write session.json")?;

    // Same entry shape the client used to emit, so every downstream reader
    // (trace verifiers, run reviews) keeps working unchanged. `origin` says
    // who actually wrote it.
    let entry = serde_json::json!({
      "origin": "server",
      "rootSpan": {
        "id": (Uuid::new_v4().as_u128() >> 64) as u64,
        "attributes": {
          "stepIndex": step_index,
          "stepText": step_text,
          "checked": checked,
        },
        "children": [],
        "durationMs": 0,
        "level": "info",
        "location": {},
        "name": "step-marker",
      },
      "sessionId": session
        .tracing_uuid
        .map(|u| u.to_string())
        .unwrap_or_else(|| session_id.to_string()),
      "ts": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
      "v": 1,
    });
    self.append_ljson_entries(session_id, &[entry])
  }

  /// The `timeout` the session's own spec declares, if it has one. Every run
  /// snapshots its `spec.yaml` beside `session.json`, so this is the run's
  /// contract rather than the corpus's current copy — a spec edited after the
  /// run started must not change what the waiter waits for. `None` for an
  /// ephemeral session (no spec) or an unreadable one; callers fall back.
  pub fn spec_timeout(&self, session_id: &str) -> Option<u64> {
    let dir = self.find_session_dir(session_id).ok()?;
    crate::spec::TestSpec::from_yaml_file(&dir.join("spec.yaml"))
      .ok()
      .map(|s| s.timeout)
  }

  /// Terminal, verdict-less end: the operator clicked Skip. No `complete.json`
  /// is written — an abandoned run has no pass/fail to record — but the rollup
  /// is refreshed like [`mark_complete`](Self::mark_complete) does, so the test
  /// stops reporting a run that is still in flight.
  pub fn mark_abandoned(&self, session_id: &str) -> Result<()> {
    self.update_status(session_id, SessionStatus::Abandoned)?;
    self.refresh_status(session_id);
    Ok(())
  }

  fn update_status(&self, session_id: &str, status: SessionStatus) -> Result<()> {
    let session_dir = self.find_session_dir(session_id)?;
    let session_file = session_dir.join("session.json");

    let content = fs::read_to_string(&session_file).context("Failed to read session.json")?;
    let mut session: Session =
      serde_json::from_str(&content).context("Failed to parse session.json")?;

    session.status = status;

    let updated = serde_json::to_string_pretty(&session).context("Failed to serialize session")?;
    fs::write(&session_file, updated).context("Failed to write session.json")?;

    Ok(())
  }

  /// Resolve a session's run directory. Delegates to [`RunStore::resolve`]
  /// (exact name wins, then a unique substring) across the nested per-test
  /// layout and the legacy flat store.
  fn find_session_dir(&self, session_id: &str) -> Result<PathBuf> {
    self.runs.resolve(session_id)
  }

  /// Get the directory path for a session.
  pub fn session_dir(&self, session_id: &str) -> Result<PathBuf> {
    self.find_session_dir(session_id)
  }

  pub fn get_session(&self, session_id: &str) -> Result<Session> {
    let session_dir = self.find_session_dir(session_id)?;
    let session_file = session_dir.join("session.json");

    let content = fs::read_to_string(&session_file).context("Failed to read session.json")?;
    let session: Session =
      serde_json::from_str(&content).context("Failed to parse session.json")?;

    Ok(session)
  }

  /// Read LJSON entries for a session.
  ///
  /// Returns the parsed LJSON entries, or an empty Vec if no logs.ljson exists.
  pub fn read_logs_ljson(&self, session_id: &str) -> Result<Vec<tento_logger::ljson::LjsonEntry>> {
    let session_dir = self.find_session_dir(session_id)?;
    let ljson_file = session_dir.join("logs.ljson");

    if !ljson_file.exists() {
      return Ok(Vec::new());
    }

    let file = fs::File::open(&ljson_file).context("Failed to open logs.ljson")?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();

    for (index, line) in reader.lines().enumerate() {
      let line = line.context("Failed to read LJSON line")?;
      if line.trim().is_empty() {
        continue;
      }
      let entry = crate::ljson_line::parse_ljson_line(&line).with_context(|| {
        format!(
          "Failed to parse LJSON entry ({}:{})",
          ljson_file.display(),
          index + 1
        )
      })?;
      entries.push(entry);
    }

    Ok(entries)
  }

  /// Get the path to the LJSON log file for a session.
  pub fn ljson_path(&self, session_id: &str) -> Result<PathBuf> {
    let session_dir = self.find_session_dir(session_id)?;
    Ok(session_dir.join("logs.ljson"))
  }

  /// Read the grafted trace LJSON entries for a session (client + server).
  ///
  /// Returns entries from `trace.ljson` if it exists, otherwise empty Vec.
  pub fn read_trace_ljson(&self, session_id: &str) -> Result<Vec<tento_logger::ljson::LjsonEntry>> {
    let session_dir = self.find_session_dir(session_id)?;
    let trace_file = session_dir.join("trace.ljson");

    if !trace_file.exists() {
      return Ok(Vec::new());
    }

    let file = fs::File::open(&trace_file).context("Failed to open trace.ljson")?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();

    for (index, line) in reader.lines().enumerate() {
      let line = line.context("Failed to read trace.ljson line")?;
      if line.trim().is_empty() {
        continue;
      }
      let entry = crate::ljson_line::parse_ljson_line(&line).with_context(|| {
        format!(
          "Failed to parse trace.ljson entry ({}:{})",
          trace_file.display(),
          index + 1
        )
      })?;
      entries.push(entry);
    }

    Ok(entries)
  }

  /// Get all sessions (for admin listing).
  /// Returns sessions sorted by `created_at` descending (newest first).
  /// Optionally includes completion status from `complete.json`.
  pub fn get_all_sessions(&self) -> Result<Vec<(Session, Option<SessionCompletion>)>> {
    let mut sessions = Vec::new();

    for path in self.runs.all_run_dirs() {
      let Some(session) = read_session_at(&path) else {
        continue;
      };
      let completion = fs::read_to_string(path.join("complete.json"))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok());
      sessions.push((session, completion));
    }

    // Sort by created_at descending (newest first)
    sessions.sort_by(|a, b| b.0.created_at.cmp(&a.0.created_at));

    Ok(sessions)
  }

  pub fn delete_session(&self, session_id: &str) -> Result<()> {
    let session_dir = self.find_session_dir(session_id)?;
    fs::remove_dir_all(&session_dir).context("Failed to delete session directory")?;
    Ok(())
  }

  pub fn read_result(&self, session_id: &str) -> Result<Option<SessionResult>> {
    let completion = self.read_completion(session_id)?;
    Ok(completion.map(|c| c.result))
  }

  /// Save a test spec to the session directory.
  pub fn save_spec(&self, session_id: &str, spec: &TestSpec) -> Result<()> {
    let session_dir = self.find_session_dir(session_id)?;
    let spec_file = session_dir.join("spec.yaml");

    let spec_yaml = serde_yml::to_string(spec).context("Failed to serialize test spec")?;
    fs::write(&spec_file, spec_yaml).context("Failed to write spec.yaml")?;

    Ok(())
  }

  /// Read a test spec from the session directory.
  pub fn read_spec(&self, session_id: &str) -> Result<Option<TestSpec>> {
    let session_dir = self.find_session_dir(session_id)?;
    let spec_file = session_dir.join("spec.yaml");

    if !spec_file.exists() {
      return Ok(None);
    }

    let content = fs::read_to_string(&spec_file).context("Failed to read spec.yaml")?;
    let spec: TestSpec = serde_yml::from_str(&content).context("Failed to parse spec.yaml")?;
    Ok(Some(spec))
  }

  /// Create a session directory with both session.json and spec.yaml.
  ///
  /// This is a convenience method that creates both files atomically.
  pub fn create_session_with_spec(&self, session: &Session, spec: &TestSpec) -> Result<PathBuf> {
    // The run nests under its owning test. The caller may pre-set `test_id`
    // (e.g. `.scratch` for ephemeral runs); otherwise it's the spec id. In flat
    // mode the RunStore ignores the test-id and writes `<legacy>/<session.id>/`.
    let test_id = session.test_id.clone().unwrap_or_else(|| spec.id.clone());
    let session_dir = self.runs.create_run_dir(&test_id, &session.id)?;

    // Stamp the run with its owning test so it's self-describing on disk.
    let session = Session {
      test_id: Some(test_id.clone()),
      ..session.clone()
    };
    let session_json =
      serde_json::to_string_pretty(&session).context("Failed to serialize session")?;
    fs::write(session_dir.join("session.json"), session_json)
      .context("Failed to write session.json")?;

    // The run keeps its own spec.yaml snapshot.
    let spec_yaml = serde_yml::to_string(spec).context("Failed to serialize test spec")?;
    fs::write(session_dir.join("spec.yaml"), &spec_yaml).context("Failed to write spec.yaml")?;

    // Seed the test's canonical spec.yaml only if absent — never clobber a
    // checked-in spec (that is `migrate`'s / the author's job).
    if let Some(canonical) = self.runs.test_spec_path(&test_id) {
      if !canonical.is_file() {
        if let Some(parent) = canonical.parent() {
          let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&canonical, &spec_yaml);
      }
    }

    Ok(session_dir)
  }

  /// Best-effort refresh of a test's `status.json` rollup from its runs, so
  /// `ux-test ls` reads per-test status in O(1). No-op in flat mode or if the
  /// run isn't self-describing (legacy session without a `test_id`).
  ///
  /// Public because the rollup is derived from `verification.json` as well as
  /// `complete.json`, and the verdict lands *after* the completion that
  /// triggered [`mark_complete`](Self::mark_complete)'s refresh. Whoever writes
  /// a verdict re-runs this, or the board keeps serving the pre-verdict
  /// reading (an audited run stuck at `Unknown`).
  pub fn refresh_status(&self, session_id: &str) {
    let Ok(dir) = self.runs.resolve(session_id) else {
      return;
    };
    let Some(test_id) = read_session_at(&dir).and_then(|s| s.test_id) else {
      return;
    };
    let (Some(status_path), Some(tests)) = (
      self.runs.test_status_path(&test_id),
      self.runs.tests_folder(),
    ) else {
      return;
    };
    if let Ok(Some(test)) = tests.test(&test_id) {
      if let Ok(status) = test.derive_status() {
        if let Ok(json) = serde_json::to_string_pretty(&status) {
          let _ = fs::write(&status_path, json);
        }
      }
    }
  }
}

/// `LLMLogger` is the harness's implementation of the wire contract's store.
///
/// Pure forwarding, and deliberately so: the trait was derived from the methods
/// [`crate::http`] already called, so every signature here matches the inherent
/// one it delegates to and the routes' behaviour is unchanged. The value of the
/// impl is the direction of the dependency — the routes now name an interface
/// this type satisfies, instead of naming this type.
#[cfg(feature = "http")]
impl crate::http::SessionStore for LLMLogger {
  fn get_first_pending(&self) -> Result<Option<Session>> {
    LLMLogger::get_first_pending(self)
  }

  fn get_pending_count(&self) -> Result<usize> {
    LLMLogger::get_pending_count(self)
  }

  fn get_all_pending_flaky(&self) -> Result<Vec<Session>> {
    LLMLogger::get_all_pending_flaky(self)
  }

  fn append_ljson_entries(&self, session_id: &str, entries: &[serde_json::Value]) -> Result<()> {
    LLMLogger::append_ljson_entries(self, session_id, entries)
  }

  fn mark_complete(
    &self,
    session_id: &str,
    result: SessionResult,
    feedback: Option<String>,
  ) -> Result<()> {
    LLMLogger::mark_complete(self, session_id, result, feedback)
  }

  fn set_step(
    &self,
    session_id: &str,
    step_index: usize,
    step_text: &str,
    checked: bool,
  ) -> Result<()> {
    LLMLogger::set_step(self, session_id, step_index, step_text, checked)
  }

  fn mark_abandoned(&self, session_id: &str) -> Result<()> {
    LLMLogger::mark_abandoned(self, session_id)
  }

  fn get_session(&self, session_id: &str) -> Result<Session> {
    LLMLogger::get_session(self, session_id)
  }

  fn read_logs_ljson(&self, session_id: &str) -> Result<Vec<tento_logger::ljson::LjsonEntry>> {
    LLMLogger::read_logs_ljson(self, session_id)
  }

  fn read_trace_ljson(&self, session_id: &str) -> Result<Vec<tento_logger::ljson::LjsonEntry>> {
    LLMLogger::read_trace_ljson(self, session_id)
  }

  fn get_all_sessions(&self) -> Result<Vec<(Session, Option<SessionCompletion>)>> {
    LLMLogger::get_all_sessions(self)
  }

  fn delete_session(&self, session_id: &str) -> Result<()> {
    LLMLogger::delete_session(self, session_id)
  }
}

#[cfg(test)]
mod step_marker_schema_tests {
  use super::*;

  #[test]
  fn authoritative_step_markers_are_valid_distinct_spans_and_idempotent() {
    let root = std::env::temp_dir().join(format!("ux-step-schema-{}", Uuid::new_v4()));
    let run = root.join("run");
    fs::create_dir_all(&run).unwrap();
    let session = Session {
      id: "run".into(),
      prefix: "test".into(),
      instructions: vec!["Continue".into()],
      metadata: None,
      status: SessionStatus::InProgress,
      created_at: Utc::now(),
      flaky: None,
      tracing_uuid: Some(Uuid::new_v4()),
      display_params: None,
      test_id: None,
      completed_steps: Vec::new(),
    };
    fs::write(
      run.join("session.json"),
      serde_json::to_vec(&session).unwrap(),
    )
    .unwrap();
    let logger = LLMLogger::new(root.clone());
    logger.set_step("run", 0, "Continue", true).unwrap();
    logger.set_step("run", 0, "Continue", true).unwrap();
    logger.set_step("run", 0, "Continue", false).unwrap();
    let raw = fs::read_to_string(run.join("logs.ljson")).unwrap();
    let entries: Vec<tento_logger::ljson::LjsonEntry> = raw
      .lines()
      .map(|line| serde_json::from_str(line).unwrap())
      .collect();
    assert_eq!(entries.len(), 2);
    assert_ne!(entries[0].root_span.id, entries[1].root_span.id);
    assert_eq!(entries[0].root_span.attributes["checked"], true);
    assert_eq!(entries[1].root_span.attributes["checked"], false);
    assert!(
      logger
        .get_session("run")
        .unwrap()
        .completed_steps
        .is_empty()
    );
    fs::remove_dir_all(root).unwrap();
  }
}
