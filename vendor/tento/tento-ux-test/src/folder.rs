//! Strongly-typed [`tento_folder`] schemas for the `.ux-tests/` tree — one
//! folder per test, with that test's runs nested inside it.
//!
//! Layout (mirrors `tento-session`'s `session/` + `panes/<id>/`):
//!
//! ```text
//! .ux-tests/                  <- ux_tests::Folder
//!   <test-id>/                <- ux_test::Folder   (test-id == spec.id)
//!     spec.yaml               canonical TestSpec   (git-tracked)
//!     status.json?            rollup cache: latest result + count  (gitignored)
//!     runs/                   (gitignored)
//!       <run-id>/             <- ux_run::Folder    (run-id == session id)
//!         session.json spec.yaml logs.ljson trace.ljson server.ljson
//!         complete.json headless-plan.json view.tsh
//! ```
//!
//! `runs/` children and the test folders are dynamically keyed, so — exactly
//! like `tento_session::session::pane_folders` — they are plain `Folder` nodes
//! walked by hand-written, load-tolerant accessors rather than `Glob<…>` fields
//! (a bare-`*` glob would derive an empty Rust ident, and a partially-written
//! run mid-flight must not poison the whole load).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tento_folder::formats::{Json, Yaml};
use tento_folder::{FolderError, folder};
use tracing::warn;

use crate::ledger::{self, LedgerEntry, Rollup};
use crate::session::{Session, SessionCompletion, SessionResult, SessionStatus};

// One run = exactly the files a session dir holds today. `.ljson` is NDJSON, not
// valid JSON, so it is `File::Text` (the same choice tento-session makes).
//
// The structured files are `Valid<File<…>>`: their bytes are proven to parse
// during tier-1 validation, and only the path is kept. Deliberately NOT the
// eager typed form (`File<Json<Session>>`) even though the shapes exist — the
// accessors below are load-TOLERANT by contract (a run mid-write must not
// poison a listing), and eager parsing would make `load` fail instead.
folder!(ux_run, {
  "session.json":        Valid<File<Json>>,
  "spec.yaml":           Valid<File<Yaml>>,
  "logs.ljson"?:         File::Text,
  "trace.ljson"?:        File::Text,
  "server.ljson"?:       File::Text,
  "complete.json"?:      Valid<File<Json>>,
  "verification.json"?:  Valid<File<Json>>,
  "headless-plan.json"?: Valid<File<Json>>,
  "view.tsh"?:           File::Text,
});

// One test = canonical spec + the tracked ledger + an optional host-local
// rollup + a runs/ container. `runs/` is optional because a never-run test (or a
// fresh `git clone`, where runs/ is gitignored) simply has no runs directory;
// `ledger.ljson` is optional because a test nobody has ever run has nothing to
// record. Note which two are gitignored and which one is not: the ledger is the
// only artifact here that a checkout which has never run anything can read.
folder!(ux_test, {
  "spec.yaml":     Valid<File<Yaml>>,
  "ledger.ljson"?: File::Text,
  "status.json"?:  Valid<File<Json>>,
  "runs"?:         Folder,
});

// Root = a directory whose children are ux_test folders keyed by test-id.
// Empty body: validates "is a dir"; children are walked by the accessor below.
folder!(ux_tests, {});

/// What a run with no readable `spec.yaml` snapshot is assumed to have been
/// allowed. Mirrors the spec's own `timeout` default, which is private to
/// [`crate::spec`]; a run that predates the snapshot, or whose snapshot is
/// unreadable, still needs a budget to be overdue against.
const DEFAULT_RUN_TIMEOUT_SECS: u64 = 300;

/// How far past its own timeout an uncompleted run must be before "in flight"
/// stops being a credible reading. A slow verification tail, a suspended
/// laptop, or a clock nudge must never turn a live run terminal, so this is
/// far larger than any spec's timeout — every spec in the corpus declares
/// between 60 and 3600 seconds.
const OVERDUE_RUN_GRACE_SECS: i64 = 60 * 60;

/// Outcome of a test's most-recent run, for the per-test rollup.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunResult {
  Pass,
  Fail,
  /// The operator skipped the run: the session reached `Abandoned` without a
  /// verdict. Terminal — distinct from `Running`, which is still in flight.
  Abandoned,
  /// A run exists but hasn't completed yet (no `complete.json`).
  Running,
  /// The test has never been run (no `runs/` entries).
  NeverRun,
  /// The run finished, but nothing recorded a verdict for it — so we do not
  /// know whether it did what it claimed.
  ///
  /// This is the honest reading of a headless run with no `verification.json`.
  /// The harness `result` such a run posts is a neutral "steps executed"
  /// signal, not a judgement, and reading it as `Pass` is what let four specs
  /// that wrote nothing and failed every required log show as `success`.
  /// Every headless run recorded before `verification.json` existed lands
  /// here — retroactively unknown, rather than retroactively green.
  Unknown,
}

/// What the verification judges decided, as written to `verification.json`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationOutcome {
  Passed,
  Failed,
  /// Verification never ran — the drive stopped at a manual step, so there was
  /// no completed run to judge. Distinct from `Failed`: the product did not
  /// misbehave, we simply have no evidence either way.
  NotRun,
}

/// The authoritative verdict for one run, persisted beside its trace.
///
/// This file is the whole point: the trace and row-assertion judges already
/// computed this value and printed it, and `RunFolder::result` had no way to
/// read it back. `detail` carries the one-line reason so a `Failed` or
/// `NotRun` row can say why without re-running the judges.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRecord {
  pub outcome: VerificationOutcome,
  pub at: DateTime<Utc>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
  /// Written by the server's completion audit (trace judges only), not by a
  /// run's owner. `finalize` replaces it with the full verdict and still runs
  /// teardown and the ledger, which the audit never does. Records that predate
  /// the field read as final.
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub provisional: bool,
}

/// Whether `session_dir` holds a `verification.json` that is not the server's
/// provisional completion audit. An unreadable record counts as final:
/// re-running teardown on a run that may already have had it is the worse
/// mistake.
pub fn has_final_verification(session_dir: &Path) -> bool {
  let Ok(text) = std::fs::read_to_string(session_dir.join("verification.json")) else {
    return false;
  };
  serde_json::from_str::<VerificationRecord>(&text).map_or(true, |r| !r.provisional)
}

/// Per-test status rollup — surfaced by `ux-test ls` and summarised by
/// `ux-test report`. Cached in `<test-id>/status.json` (gitignored, host-local)
/// so the common path skips scanning every run folder; the run folders remain
/// the source of truth and the cache is derived from them when absent or stale.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestStatus {
  pub test_id: String,
  pub latest_result: RunResult,
  pub latest_run: Option<String>,
  pub latest_at: Option<DateTime<Utc>>,
  pub run_count: usize,
}

/// One test folder plus where it sits in the corpus. `group` is the top-level
/// group directory the test lives under: `None` = ungrouped (a `<id>/` directly
/// under the root), `Some("event-flows")` = grouped, `Some(".scratch")` = a
/// kept-local throwaway test in the gitignored zone. Classification is purely by
/// location — no field on the spec.
pub struct TestEntry {
  pub id: String,
  pub group: Option<String>,
  pub folder: ux_test::Folder,
}

impl TestEntry {
  /// Whether this test lives in the gitignored `.scratch` throwaway zone (never
  /// part of a CI/`--all` batch).
  pub fn is_scratch(&self) -> bool {
    self.group.as_deref() == Some(SCRATCH_TEST_ID)
  }
}

impl ux_run::Folder {
  /// Parse `session.json`; `None` if absent/malformed (tolerant — a run
  /// mid-write or a foreign directory just yields `None`).
  pub fn session(&self) -> Option<Session> {
    serde_json::from_value(self.session_json.read().ok()?).ok()
  }

  /// Parse `complete.json`; `None` while the run is still in flight.
  pub fn completion(&self) -> Option<SessionCompletion> {
    let f = self.complete_json.as_ref()?;
    serde_json::from_value(f.read().ok()?).ok()
  }

  /// Parse `verification.json` — the authoritative verdict, when one was
  /// computed and written down. `None` for every run that predates it.
  pub fn verification(&self) -> Option<VerificationRecord> {
    let f = self.verification_json.as_ref()?;
    serde_json::from_value(f.read().ok()?).ok()
  }

  /// Whether this run was driven by the headless runner rather than an
  /// operator. `headless-plan.json` is written only by the headless path, so
  /// its presence is the discriminator — and the distinction matters because
  /// the two write `complete.json` for entirely different reasons.
  pub fn is_headless(&self) -> bool {
    self.headless_plan_json.is_some()
  }

  /// How long this run's own spec allowed it, in seconds. Every run snapshots
  /// its `spec.yaml` beside `session.json`, so this is the contract the run
  /// started under — a spec edited afterwards must not change what counts as
  /// overdue. `None` when the snapshot is missing or unreadable.
  pub fn spec_timeout(&self) -> Option<u64> {
    crate::spec::TestSpec::from_yaml_file(&self.root().join("spec.yaml"))
      .ok()
      .map(|s| s.timeout)
  }

  /// Whether an uncompleted run is past every deadline it could plausibly
  /// still be honouring.
  ///
  /// A driver that dies leaves `session.json` at `pending` forever. Nothing
  /// heals it: `mark_abandoned` is reached only from the server's Skip route
  /// or from a session the server itself reports abandoned, so a CLI that is
  /// killed, crashed, or Ctrl-C'd marks nothing at all. "No completion"
  /// therefore cannot mean "still running" indefinitely — and it must not,
  /// because [`Rollup::state`](crate::ledger::Rollup::state) lets in-flight
  /// outrank the ledger. Observed on rwc-04: 16 abandoned directories, the
  /// oldest six days old, put 12 tests in-flight over ledgers whose newest
  /// entry was a pass.
  ///
  /// The run's own spec says how long it is allowed to take; the grace on top
  /// is deliberately generous, because the two errors are not symmetric.
  /// Calling a live run terminal loses a verdict; waiting an extra hour only
  /// means the board tells the truth an hour later.
  fn is_overdue(&self, session: &Session) -> bool {
    let budget = self.spec_timeout().unwrap_or(DEFAULT_RUN_TIMEOUT_SECS);
    let deadline = session.created_at
      + chrono::TimeDelta::seconds(budget as i64)
      + chrono::TimeDelta::seconds(OVERDUE_RUN_GRACE_SECS);
    Utc::now() > deadline
  }

  /// This run's outcome, in the order that trusts the strongest evidence
  /// first.
  ///
  /// 1. **`verification.json`** — the recorded verdict, if one exists. It is
  ///    computed by the trace + row-assertion judges and outranks everything
  ///    else, including an operator's click.
  /// 2. **`complete.json` from an operator run** — the human *is* the judge
  ///    there, so their Works/Broken is the verdict.
  /// 3. **`complete.json` from a headless run** — [`RunResult::Unknown`]. That
  ///    file carries `headless: N steps executed`, which the runner's own
  ///    source calls a neutral signal; treating it as a pass is precisely the
  ///    laundering this exists to stop.
  /// 4. No completion at all — the session decides. A skipped run is
  ///    `Abandoned` (terminal) rather than `Running`, and so is one whose
  ///    driver died: past [`is_overdue`](Self::is_overdue) nobody is coming
  ///    back to it either. A rollup never sits at "in flight" for a run
  ///    nobody will finish.
  pub fn result(&self) -> RunResult {
    if let Some(v) = self.verification() {
      return match v.outcome {
        VerificationOutcome::Passed => RunResult::Pass,
        VerificationOutcome::Failed => RunResult::Fail,
        // Verification did not get to run — an incomplete run is never a pass,
        // but it is not a product failure either.
        VerificationOutcome::NotRun => RunResult::Unknown,
      };
    }
    match self.completion() {
      Some(_) if self.is_headless() => RunResult::Unknown,
      Some(c) => match c.result {
        SessionResult::Success => RunResult::Pass,
        SessionResult::Failure => RunResult::Fail,
      },
      None => match self.session() {
        Some(s) if s.status == SessionStatus::Abandoned => RunResult::Abandoned,
        Some(s) if self.is_overdue(&s) => RunResult::Abandoned,
        _ => RunResult::Running,
      },
    }
  }
}

impl ux_test::Folder {
  /// Each child of `runs/` as a tolerant `ux_run::Folder`, sorted by run-id.
  /// Dot-prefixed and non-directory children are skipped. No `runs/` ⇒ empty.
  pub fn runs(&self) -> Result<Vec<(String, ux_run::Folder)>, FolderError> {
    let Some(runs) = self.runs.as_ref() else {
      return Ok(Vec::new());
    };
    let mut children = runs.children().map_err(|source| FolderError::Io {
      path: runs.path().to_path_buf(),
      source,
    })?;
    children.sort();

    let mut out = Vec::new();
    for child in children {
      if !child.is_dir() {
        continue;
      }
      let id = file_name(&child);
      if id.starts_with('.') {
        continue;
      }
      out.push((id, ux_run::Folder::load_unchecked(&child)?));
    }
    Ok(out)
  }

  /// The newest run by `session.json` created_at (runs with no parseable
  /// session sort oldest). `None` when the test has never run.
  pub fn latest_run(&self) -> Result<Option<(String, ux_run::Folder)>, FolderError> {
    let mut keyed: Vec<(Option<DateTime<Utc>>, String, ux_run::Folder)> = self
      .runs()?
      .into_iter()
      .map(|(id, run)| (run.session().map(|s| s.created_at), id, run))
      .collect();
    // `Option<DateTime>` orders `None` before `Some`, so the max (newest) is last.
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(keyed.pop().map(|(_, id, run)| (id, run)))
  }

  /// Rollup for this test. Prefers the persisted `status.json` cache, else
  /// derives it from the run folders.
  ///
  /// The cache is **host-local and gitignored**. It was tracked once, which
  /// could not work: the only process that writes it is the one that runs a
  /// test, and that is always the dev host, never a developer's checkout — so
  /// the shared repo carried a month-stale record while the run host held the
  /// real one, uncommitted. The run folders are the source of truth; this file
  /// is only a shortcut past scanning them.
  ///
  /// A cache whose `test_id` disagrees with its directory is a rename that
  /// stranded it (`onboarding-new-user-stripe` was reporting as
  /// `subscription-upgrade`), so it is discarded rather than trusted.
  pub fn status(&self) -> Result<TestStatus, FolderError> {
    let want = file_name(self.root());
    if let Some(f) = self.status_json.as_ref() {
      if let Ok(raw) = f.read() {
        if let Ok(st) = serde_json::from_value::<TestStatus>(raw) {
          if st.test_id == want {
            return Ok(st);
          }
        }
      }
    }
    self.derive_status()
  }

  /// Compute the rollup fresh from the run folders (ignores `status.json`).
  /// This is what `mark_complete` persists.
  pub fn derive_status(&self) -> Result<TestStatus, FolderError> {
    let test_id = file_name(self.root());
    let run_count = self.runs()?.len();
    Ok(match self.latest_run()? {
      None => TestStatus {
        test_id,
        latest_result: RunResult::NeverRun,
        latest_run: None,
        latest_at: None,
        run_count,
      },
      Some((id, run)) => TestStatus {
        latest_result: run.result(),
        latest_at: run.session().map(|s| s.created_at),
        latest_run: Some(id),
        test_id,
        run_count,
      },
    })
  }

  /// Where this test's tracked record lives. Taken from the folder root rather
  /// than the `ledger_ljson` entry, because the entry is `None` exactly when
  /// the file does not exist yet — which is the case an appender is for.
  pub fn ledger_path(&self) -> PathBuf {
    self.root().join("ledger.ljson")
  }

  /// This test's ledger entries, oldest first. Empty for a test nobody has run.
  pub fn ledger(&self) -> Result<Vec<LedgerEntry>> {
    ledger::read(&self.ledger_path())
  }

  /// Append one run to the tracked record.
  pub fn append_ledger(&self, entry: &LedgerEntry) -> Result<()> {
    ledger::append(&self.ledger_path(), entry)
  }

  /// Resolve a [`Draft`] against this test and append it.
  ///
  /// **This is the only place a ledger default lives.** `ux-test log` and the
  /// console's `POST /api/log` both arrive here with a `Draft` and neither
  /// mints a run id, resolves a target or stamps a host of its own — two
  /// writers of one append-only file that disagree about what an omitted field
  /// means is a corrupt record that nothing would flag.
  ///
  /// The one field that is an ERROR rather than a default is `target`. The spec
  /// is the only place the corpus records an origin, and a run driven somewhere
  /// the spec does not name has to say where: Lona is multi-origin, and a
  /// recorded environment *name* is what once sent every operator to the
  /// marketing landing instead of the app.
  ///
  /// The one field with **no** default is `run`. A default is a safe guess at
  /// something the caller knows and did not bother to say; a run id the caller
  /// did not supply is not a guess, it is a fabrication. See
  /// [`LedgerEntry::run`].
  pub fn record(&self, draft: ledger::Draft) -> Result<LedgerEntry> {
    let at = draft.at.unwrap_or_else(Utc::now);
    let target = match draft.target {
      Some(target) => target,
      None => crate::spec::TestSpec::from_yaml_file(&self.root().join("spec.yaml"))
        .ok()
        .and_then(|spec| spec.params.get("server_url").cloned())
        .context(
          "no target: this spec declares no `params.server_url`, and an environment name is not \
           enough to reopen a run on a multi-origin product",
        )?,
    };
    let entry = LedgerEntry {
      // Passed through, never filled in. Every other field here has a defensible
      // default because it describes the RECORDING; a run id describes a
      // directory, and this method has no way to create one.
      run: draft.run,
      at,
      by: draft.by,
      host: draft.host.unwrap_or_else(ledger::local_hostname),
      target,
      // Passed through like `run`, and for the same reason: an environment this
      // method invented would be indistinguishable from one the run reported.
      env: draft.env.filter(|e| !e.trim().is_empty()),
      verdict: draft.verdict,
      reload_verified: draft.reload_verified,
      note: draft.note.filter(|n| !n.trim().is_empty()),
      blocker: draft.blocker.filter(|b| !b.trim().is_empty()),
      evidence: draft.evidence,
      // Passed through like `env`: which build a run measured is the caller's
      // fact, never this method's guess.
      artifact: draft.artifact,
    };
    // `append` validates; doing it here too would just report the same error
    // from a less specific place.
    self.append_ledger(&entry)?;
    Ok(entry)
  }

  /// This test's state, merging the tracked ledger with the host-local run
  /// store — the two sources answer different questions and neither subsumes
  /// the other. The ledger is all a fresh checkout has; the run store is the
  /// only thing that knows a run is happening right now.
  ///
  /// Local runs are partitioned against the entries by run id: one that no
  /// entry names is either **in flight** (no outcome yet) or **unrecorded** (it
  /// finished and nobody appended it). Keeping those apart is the point — an
  /// unrecorded run is a gap in the record, and reporting its outcome as though
  /// it were recorded would hide the gap.
  pub fn rollup(&self) -> Result<Rollup> {
    let test_id = file_name(self.root());
    let entries = self.ledger()?;
    // Only entries that NAME a session can claim one. A hand-driven verdict
    // claims none, so a local run folder is still unrecorded until something
    // records it by id — which is the gap this partition exists to show.
    let recorded: HashSet<&str> = entries.iter().filter_map(|e| e.run.as_deref()).collect();

    let mut in_flight = Vec::new();
    let mut unrecorded = Vec::new();
    for (id, run) in self.runs()? {
      if recorded.contains(id.as_str()) {
        continue;
      }
      // A directory with NO artifacts at all is not a run in progress — nothing
      // ever wrote a session into it. `create_run_dir` makes the directory
      // eagerly, so a runner that dies before its first write leaves one behind,
      // and `result()` reads an empty directory as `Running` because it cannot
      // tell "started and still going" from "never started at all".
      //
      // Counting those as in-flight is not cosmetic: `state()` lets in-flight
      // outrank the ledger, so ONE empty directory hides every recorded verdict
      // a test has. Observed on rwc-04 — 971 empty directories of 1133 put 66 of
      // 73 tests in-flight, which the board drew as "never run" over tests with
      // thirty recorded passes apiece.
      if run.session().is_none() && run.completion().is_none() && run.verification().is_none() {
        continue;
      }
      match run.result() {
        RunResult::Running => in_flight.push(id),
        _ => unrecorded.push(id),
      }
    }

    Ok(Rollup {
      test_id,
      entries,
      in_flight,
      unrecorded,
    })
  }
}

impl ux_tests::Folder {
  /// Every **tracked** test, loaded tolerantly and sorted by id. The top level
  /// is walked one level deep: a non-dot child dir with its own `spec.yaml` is
  /// an ungrouped test (`group: None`); a non-dot child dir WITHOUT a `spec.yaml`
  /// is a **group** whose `<id>/spec.yaml` children are grouped tests
  /// (`group: Some(name)`). Groups do not nest inside groups. `.scratch` and any
  /// other dot-dir are excluded — the gitignored throwaway zone is listed only by
  /// [`scratch_tests`](Self::scratch_tests). Test-ids must be globally unique
  /// across groups (the run-resolution invariant); a duplicate is warned and the
  /// later occurrence dropped so the listing stays single-valued.
  pub fn tests(&self) -> Result<Vec<TestEntry>, FolderError> {
    let mut out: Vec<TestEntry> = Vec::new();
    for child in sorted_dir(self.root())? {
      if !child.is_dir() {
        continue;
      }
      let name = file_name(&child);
      if name.starts_with('.') {
        continue; // .scratch and friends are not tracked tests
      }
      if child.join("spec.yaml").is_file() {
        push_unique(
          &mut out,
          TestEntry {
            id: name,
            group: None,
            folder: ux_test::Folder::load_unchecked(&child)?,
          },
        );
      } else {
        // A group: descend exactly one level to its test folders.
        for gc in sorted_dir(&child)? {
          if gc.is_dir() && gc.join("spec.yaml").is_file() {
            push_unique(
              &mut out,
              TestEntry {
                id: file_name(&gc),
                group: Some(name.clone()),
                folder: ux_test::Folder::load_unchecked(&gc)?,
              },
            );
          }
        }
      }
    }
    Ok(out)
  }

  /// The kept-local named tests in the gitignored `.scratch` throwaway zone
  /// (`.scratch/<id>/spec.yaml`). These are re-runnable by id but never part of
  /// `tests()` or any CI/`--all` batch. The spec-less ephemeral run bucket
  /// (`.scratch/runs/`) is not a test and is not returned here.
  pub fn scratch_tests(&self) -> Result<Vec<TestEntry>, FolderError> {
    let mut out = Vec::new();
    for gc in sorted_dir(&self.root().join(SCRATCH_TEST_ID))? {
      if gc.is_dir() && file_name(&gc) != "runs" && gc.join("spec.yaml").is_file() {
        out.push(TestEntry {
          id: file_name(&gc),
          group: Some(SCRATCH_TEST_ID.to_string()),
          folder: ux_test::Folder::load_unchecked(&gc)?,
        });
      }
    }
    Ok(out)
  }

  /// One test by id, or `None`. Searched across the ungrouped top level, every
  /// group, and the `.scratch` zone (so `run --test <id>` resolves a kept-local
  /// spec too).
  pub fn test(&self, id: &str) -> Result<Option<ux_test::Folder>, FolderError> {
    match find_test_dir(self.root(), id) {
      Some(p) => Ok(Some(ux_test::Folder::load_unchecked(&p)?)),
      None => Ok(None),
    }
  }
}

/// The final path component as an owned `String` (`""` if none).
fn file_name(p: &Path) -> String {
  p.file_name()
    .and_then(|s| s.to_str())
    .unwrap_or_default()
    .to_string()
}

/// Sorted child paths of `dir`. A missing dir yields an empty list (tolerant —
/// a never-run/never-grouped tree simply has nothing there); other IO errors
/// surface as [`FolderError::Io`].
fn sorted_dir(dir: &Path) -> Result<Vec<PathBuf>, FolderError> {
  let rd = match std::fs::read_dir(dir) {
    Ok(rd) => rd,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(source) => {
      return Err(FolderError::Io {
        path: dir.to_path_buf(),
        source,
      });
    }
  };
  let mut children: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
  children.sort();
  Ok(children)
}

/// Locate a test's canonical directory by id, searching (in order) the ungrouped
/// top level (`root/<id>`), the `.scratch` zone (`root/.scratch/<id>`), and every
/// group (`root/<group>/<id>` where `<group>` is a non-dot dir without its own
/// `spec.yaml`). A directory counts only if it holds a `spec.yaml`. Returns
/// `None` when no such test exists — callers writing a NEW test fall back to the
/// ungrouped `root/<id>` location. This is the shared resolver behind
/// `ux_tests::Folder::test` and `RunStore::resolve_test_dir`, so listing and run
/// resolution agree on where a test lives.
fn find_test_dir(root: &Path, test_id: &str) -> Option<PathBuf> {
  let has_spec = |dir: &Path| dir.join("spec.yaml").is_file();

  let direct = root.join(test_id);
  if has_spec(&direct) {
    return Some(direct);
  }
  let scratch = root.join(SCRATCH_TEST_ID).join(test_id);
  if has_spec(&scratch) {
    return Some(scratch);
  }
  for child in sorted_dir(root).unwrap_or_default() {
    let name = file_name(&child);
    // Skip non-dirs, dot-dirs (handled above / not groups), and ungrouped tests
    // (a dir with its own spec.yaml is a test, not a group).
    if !child.is_dir() || name.starts_with('.') || has_spec(&child) {
      continue;
    }
    let candidate = child.join(test_id);
    if has_spec(&candidate) {
      return Some(candidate);
    }
  }
  None
}

/// Append a test entry unless its id already appears — ids must be globally
/// unique across groups (the run-resolution invariant). A collision is warned and
/// the later occurrence dropped so listings stay single-valued.
fn push_unique(out: &mut Vec<TestEntry>, entry: TestEntry) {
  if out.iter().any(|e| e.id == entry.id) {
    warn!(
      "ux-tests: duplicate test-id `{}` (group {:?}) — ignoring the duplicate; ids must be unique across groups",
      entry.id, entry.group
    );
  } else {
    out.push(entry);
  }
}

/// Push every `<test_dir>/runs/<run-id>/` directory into `out`.
fn push_runs_of(test_dir: &Path, out: &mut Vec<PathBuf>) {
  if let Ok(rd) = std::fs::read_dir(test_dir.join("runs")) {
    for run in rd.flatten() {
      let p = run.path();
      if p.is_dir() {
        out.push(p);
      }
    }
  }
}

/// Resolves and enumerates run directories across the new per-test layout
/// (`<ux_tests_root>/<test-id>/runs/<run-id>/`) and the legacy flat store
/// (`<legacy_flat>/<run-id>/`). The legacy store is dual-read so historical and
/// in-flight flat sessions keep resolving during the transition.
///
/// When `ux_tests_root` is `None` (e.g. production, which authors no specs) the
/// store is pure-flat over `legacy_flat` — byte-for-byte the old behavior.
/// Ephemeral runs nest under a single dot-prefixed `.scratch` pseudo-test, which
/// `ux_tests::Folder::tests` skips but `all_run_dirs` still enumerates.
#[derive(Clone, Debug)]
pub struct RunStore {
  ux_tests_root: Option<PathBuf>,
  legacy_flat: Option<PathBuf>,
}

/// Test-id under which ephemeral (`--name`/`--instructions`) runs are bucketed.
/// Dot-prefixed so it never shows up as a real test.
pub const SCRATCH_TEST_ID: &str = ".scratch";

impl RunStore {
  pub fn new(ux_tests_root: Option<PathBuf>, legacy_flat: Option<PathBuf>) -> Self {
    Self {
      ux_tests_root,
      legacy_flat,
    }
  }

  /// Load the root as a typed folder for test-centric listing. `None` in
  /// pure-flat mode (no `.ux-tests` configured).
  ///
  /// `folder!` construction is fallible in general (a typed `File<T>` entry can
  /// reject its bytes), but `ux_tests` declares no entries at all, so the
  /// generated constructor has nothing that can fail — hence the `expect`
  /// rather than a `Result` return that every caller would have to thread.
  pub fn tests_folder(&self) -> Option<ux_tests::Folder> {
    self.ux_tests_root.as_ref().map(|root| {
      ux_tests::Folder::load_unchecked(root)
        .expect("ux_tests declares no typed entries; construction cannot fail")
    })
  }

  /// The directory a test occupies under the `.ux-tests` root, resolving across
  /// the ungrouped top level, every group, and the `.scratch` zone. For a test
  /// that does not exist yet (a brand-new `--file`/`--test` run, or the `.scratch`
  /// ephemeral pseudo-test) it falls back to the ungrouped `root/<test_id>` — so
  /// a new test seeds ungrouped and the spec-less ephemeral bucket stays at
  /// `root/.scratch/`. `None` only in pure-flat mode (no `.ux-tests` root).
  fn resolve_test_dir(&self, test_id: &str) -> Option<PathBuf> {
    let root = self.ux_tests_root.as_ref()?;
    Some(find_test_dir(root, test_id).unwrap_or_else(|| root.join(test_id)))
  }

  /// Canonical spec path for a test (nested mode only) — its existing group/
  /// `.scratch` location if present, else the ungrouped default.
  pub fn test_spec_path(&self, test_id: &str) -> Option<PathBuf> {
    self.resolve_test_dir(test_id).map(|d| d.join("spec.yaml"))
  }

  /// `status.json` path for a test (nested mode only).
  pub fn test_status_path(&self, test_id: &str) -> Option<PathBuf> {
    self
      .resolve_test_dir(test_id)
      .map(|d| d.join("status.json"))
  }

  /// Create (and return) the run directory for a session — nested under the
  /// test's resolved directory (group/`.scratch`/ungrouped) when a `.ux-tests`
  /// root is configured, else flat in the legacy store.
  pub fn create_run_dir(&self, test_id: &str, session_id: &str) -> Result<PathBuf> {
    let dir = match self.resolve_test_dir(test_id) {
      Some(test_dir) => test_dir.join("runs").join(session_id),
      None => self
        .legacy_flat
        .as_ref()
        .context("RunStore has neither a ux_tests_root nor a legacy_flat dir")?
        .join(session_id),
    };
    std::fs::create_dir_all(&dir).with_context(|| format!("create run dir {}", dir.display()))?;
    Ok(dir)
  }

  /// Resolve an existing run directory by session id. Mirrors the old
  /// `find_session_dir`: an exact dir-name match wins, then a unique substring
  /// match, searched across both the nested and legacy stores.
  pub fn resolve(&self, session_id: &str) -> Result<PathBuf> {
    // Fast path: derive the test-id and check its resolved (group-aware) run dir.
    // `resolve_test_dir` falls back to the ungrouped `root/<test-id>`, which also
    // catches a spec-less ephemeral run whose id derives to something not on disk
    // — that simply misses here and drops to the exhaustive scan below.
    if let Some(test_id) = derive_test_id(session_id) {
      if let Some(test_dir) = self.resolve_test_dir(test_id) {
        let p = test_dir.join("runs").join(session_id);
        if p.is_dir() {
          return Ok(p);
        }
      }
    }
    // Fast path: the legacy flat location.
    if let Some(legacy) = &self.legacy_flat {
      let p = legacy.join(session_id);
      if p.is_dir() {
        return Ok(p);
      }
    }
    // Exhaustive: exact name across every run dir, then a unique substring.
    let all = self.all_run_dirs();
    if let Some(p) = all.iter().find(|p| file_name(p) == session_id) {
      return Ok(p.clone());
    }
    let partial: Vec<&PathBuf> = all
      .iter()
      .filter(|p| file_name(p).contains(session_id))
      .collect();
    match partial.len() {
      1 => Ok(partial[0].clone()),
      0 => anyhow::bail!("session_not_found/Session not found: {}", session_id),
      _ => {
        let names: Vec<String> = partial.iter().map(|p| file_name(p)).collect();
        anyhow::bail!(
          "Multiple sessions match '{}': {}",
          session_id,
          names.join(", ")
        )
      }
    }
  }

  /// Every run directory across the grouped per-test layout (ungrouped
  /// `<id>/runs`, `<group>/<id>/runs`, `.scratch/<id>/runs`), the spec-less
  /// `.scratch/runs` ephemeral bucket, and the legacy flat store. The corpus adds
  /// a directory level under groups, so this descends one level into any dir that
  /// is not itself a test (no `runs/` and no `spec.yaml`).
  pub fn all_run_dirs(&self) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(root) = &self.ux_tests_root {
      for child in sorted_dir(root).unwrap_or_default() {
        if !child.is_dir() {
          continue;
        }
        let name = file_name(&child);
        if name == SCRATCH_TEST_ID {
          // `.scratch` holds BOTH the spec-less ephemeral bucket (`.scratch/runs`)
          // and kept-local named tests (`.scratch/<id>/runs`).
          push_runs_of(&child, &mut out);
          for gc in sorted_dir(&child).unwrap_or_default() {
            if gc.is_dir() && file_name(&gc) != "runs" {
              push_runs_of(&gc, &mut out);
            }
          }
          continue;
        }
        if name.starts_with('.') {
          continue; // other dot-dirs are not part of the corpus
        }
        // A leaf test dir has its own `runs/` (once run) or `spec.yaml`; anything
        // else is a group whose `<id>/runs` we collect one level down.
        if child.join("runs").is_dir() || child.join("spec.yaml").is_file() {
          push_runs_of(&child, &mut out);
        } else {
          for gc in sorted_dir(&child).unwrap_or_default() {
            if gc.is_dir() {
              push_runs_of(&gc, &mut out);
            }
          }
        }
      }
    }
    if let Some(legacy) = &self.legacy_flat {
      push_runs_of_flat(legacy, &mut out);
    }
    out
  }
}

/// Push every direct child directory of `dir` into `out` (the legacy flat store
/// keeps run dirs as direct children, not under a `runs/` subdir).
fn push_runs_of_flat(dir: &Path, out: &mut Vec<PathBuf>) {
  if let Ok(rd) = std::fs::read_dir(dir) {
    for run in rd.flatten() {
      let p = run.path();
      if p.is_dir() {
        out.push(p);
      }
    }
  }
}

/// Derive `<test-id>` from a `<date>_<test-id>_<rand>` session id. Returns
/// `None` if the shape doesn't hold (the caller falls back to scanning). Test
/// ids use `-`, not `_`, so the middle segment is unambiguous in practice.
fn derive_test_id(session_id: &str) -> Option<&str> {
  let after_date = session_id.split_once('_')?.1;
  let test_id = after_date.rsplit_once('_')?.0;
  (!test_id.is_empty()).then_some(test_id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::path::PathBuf;

  /// A unique scratch dir under the system temp dir (no tempfile dep).
  fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ux-test-folder-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn write(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
  }

  fn session_json(id: &str, created_at: &str) -> String {
    session_json_status(id, created_at, "completed")
  }

  fn session_json_status(id: &str, created_at: &str, status: &str) -> String {
    format!(
      r#"{{"id":"{id}","prefix":"p","instructions":[],"status":"{status}","createdAt":"{created_at}"}}"#
    )
  }

  #[test]
  fn tests_lists_ungrouped_and_grouped_excluding_scratch() {
    let root = scratch("list");
    // ungrouped tracked tests
    write(&root.join("alpha/spec.yaml"), "id: alpha\n");
    write(&root.join("beta/spec.yaml"), "id: beta\n");
    // a GROUP (no spec.yaml of its own) with two grouped tests + a doc file
    write(
      &root.join("event-flows/ef-create/spec.yaml"),
      "id: ef-create\n",
    );
    write(
      &root.join("event-flows/ef-update/spec.yaml"),
      "id: ef-update\n",
    );
    write(&root.join("event-flows/README.md"), "docs"); // not a test -> skipped
    // .scratch: a named kept-local test + the ephemeral bucket -> both excluded from tests()
    write(
      &root.join(".scratch/scr-probe/spec.yaml"),
      "id: scr-probe\n",
    );
    fs::create_dir_all(root.join(".scratch/runs/2026-06-01_x_aa")).unwrap();
    write(&root.join("loose.txt"), "x"); // stray file -> skipped
    fs::create_dir_all(root.join("empty-group")).unwrap(); // group with no tests -> nothing

    let f = ux_tests::Folder::load_unchecked(&root).unwrap();
    let mut got: Vec<(String, Option<String>)> = f
      .tests()
      .unwrap()
      .into_iter()
      .map(|e| (e.id, e.group))
      .collect();
    got.sort();
    assert_eq!(
      got,
      vec![
        ("alpha".to_string(), None),
        ("beta".to_string(), None),
        ("ef-create".to_string(), Some("event-flows".to_string())),
        ("ef-update".to_string(), Some("event-flows".to_string())),
      ]
    );

    // scratch_tests() surfaces the kept-local named test (never the ephemeral bucket).
    let scr: Vec<String> = f
      .scratch_tests()
      .unwrap()
      .into_iter()
      .map(|e| e.id)
      .collect();
    assert_eq!(scr, vec!["scr-probe".to_string()]);

    // test(id) resolves ungrouped, grouped, and scratch specs.
    assert!(f.test("alpha").unwrap().is_some());
    assert!(f.test("ef-update").unwrap().is_some());
    assert!(f.test("scr-probe").unwrap().is_some());
    assert!(f.test("nope").unwrap().is_none());

    let _ = fs::remove_dir_all(&root);
  }

  /// Build one run folder and read its `result()`. `headless` decides whether
  /// `headless-plan.json` is present, which is what tells an operator run from
  /// a driven one.
  fn run_result_for(
    name: &str,
    complete: Option<&str>,
    verification: Option<&str>,
    headless: bool,
  ) -> (PathBuf, RunResult) {
    let root = scratch(name);
    write(&root.join("t/spec.yaml"), "id: t\n");
    let r = root.join("t/runs/2026-06-01_t_aaa");
    write(
      &r.join("session.json"),
      &session_json("2026-06-01_t_aaa", "2026-06-01T10:00:00Z"),
    );
    if let Some(c) = complete {
      write(&r.join("complete.json"), c);
    }
    if let Some(v) = verification {
      write(&r.join("verification.json"), v);
    }
    if headless {
      write(&r.join("headless-plan.json"), r#"{"steps":[]}"#);
    }
    let f = ux_tests::Folder::load_unchecked(&root).unwrap();
    let run = f.test("t").unwrap().unwrap().runs().unwrap().remove(0).1;
    let res = run.result();
    (root, res)
  }

  /// The defect this whole change exists for: a headless run posts
  /// `complete.json` with a neutral "steps executed" signal, and that was read
  /// as a pass. Four specs that wrote nothing showed as `success` this way.
  #[test]
  fn headless_completion_without_a_verdict_is_unknown_not_pass() {
    let (root, res) = run_result_for(
      "hl-unknown",
      Some(r#"{"result":"success","feedback":"headless: 4 steps executed"}"#),
      None,
      true,
    );
    assert_eq!(res, RunResult::Unknown);
    let _ = fs::remove_dir_all(&root);
  }

  /// An operator run has no `headless-plan.json`, and there the human IS the
  /// judge — their Works/Broken must keep deciding.
  #[test]
  fn operator_completion_without_a_verdict_still_decides() {
    let (root, res) = run_result_for(
      "op-pass",
      Some(r#"{"result":"success"}"#),
      None,
      false,
    );
    assert_eq!(res, RunResult::Pass);
    let _ = fs::remove_dir_all(&root);

    let (root, res) = run_result_for("op-fail", Some(r#"{"result":"failure"}"#), None, false);
    assert_eq!(res, RunResult::Fail);
    let _ = fs::remove_dir_all(&root);
  }

  /// `record` persists the environment the run reported, and leaves it absent
  /// when nobody said — the two cases a board has to tell apart.
  ///
  /// The absent case is the load-bearing one. `local` is a real profile name,
  /// so a default here would be indistinguishable from a run that genuinely
  /// used the built-in, and the console would render a guess in the same ink as
  /// a fact.
  #[test]
  fn record_persists_the_environment_and_never_invents_one() {
    let root = scratch("record-env");
    let dir = root.join("t");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
      dir.join("spec.yaml"),
      "id: t\nname: T\ninstructions: []\nparams:\n  server_url: http://tento.localhost\n",
    )
    .unwrap();
    let test = ux_test::Folder::load_unchecked(&dir).unwrap();

    let mut draft = ledger::Draft::new(ledger::Verdict::Pass, ledger::Driver::Cli);
    draft.run = Some("2026-09-18_t_aaaaaa".to_string());
    draft.env = Some("ci".to_string());
    assert_eq!(test.record(draft).unwrap().env.as_deref(), Some("ci"));

    // Nobody said: absent, not "local".
    let mut silent = ledger::Draft::new(ledger::Verdict::Pass, ledger::Driver::Cli);
    silent.run = Some("2026-09-18_t_bbbbbb".to_string());
    assert_eq!(test.record(silent).unwrap().env, None);

    // Whitespace is nobody saying, too — it must not become an environment
    // whose name is a space.
    let mut blank = ledger::Draft::new(ledger::Verdict::Pass, ledger::Driver::Cli);
    blank.run = Some("2026-09-18_t_cccccc".to_string());
    blank.env = Some("  ".to_string());
    assert_eq!(test.record(blank).unwrap().env, None);

    let _ = fs::remove_dir_all(&root);
  }

  /// A recorded verdict outranks `complete.json` — including a `success` one,
  /// which is exactly the case the four laundered specs were in.
  #[test]
  fn recorded_verification_outranks_the_completion() {
    let (root, res) = run_result_for(
      "verdict-fail",
      Some(r#"{"result":"success","feedback":"headless: 4 steps executed"}"#),
      Some(r#"{"outcome":"failed","at":"2026-06-01T10:05:00Z","detail":"trace_ok=false rows_ok=true"}"#),
      true,
    );
    assert_eq!(res, RunResult::Fail);
    let _ = fs::remove_dir_all(&root);

    let (root, res) = run_result_for(
      "verdict-pass",
      Some(r#"{"result":"success"}"#),
      Some(r#"{"outcome":"passed","at":"2026-06-01T10:05:00Z"}"#),
      true,
    );
    assert_eq!(res, RunResult::Pass);
    let _ = fs::remove_dir_all(&root);
  }

  /// A drive that stopped at a manual step never reached verification. That is
  /// not a product failure, so it is `Unknown` rather than `Fail`.
  #[test]
  fn verification_not_run_is_unknown_rather_than_fail() {
    let (root, res) = run_result_for(
      "verdict-notrun",
      Some(r#"{"result":"success"}"#),
      Some(
        r#"{"outcome":"not_run","at":"2026-06-01T10:05:00Z","detail":"drive stopped at step 2/6"}"#,
      ),
      true,
    );
    assert_eq!(res, RunResult::Unknown);
    let _ = fs::remove_dir_all(&root);
  }

  /// A malformed record must not be read as a verdict — it degrades to the
  /// completion path, and for a headless run that means `Unknown`.
  #[test]
  fn unparseable_verification_degrades_to_unknown() {
    let (root, res) = run_result_for(
      "verdict-garbage",
      Some(r#"{"result":"success"}"#),
      Some("{ not json"),
      true,
    );
    assert_eq!(res, RunResult::Unknown);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn tests_drops_duplicate_id_across_groups() {
    let root = scratch("dup");
    write(&root.join("g1/dupe/spec.yaml"), "id: dupe\n");
    write(&root.join("g2/dupe/spec.yaml"), "id: dupe\n");
    let f = ux_tests::Folder::load_unchecked(&root).unwrap();
    let ids: Vec<String> = f.tests().unwrap().into_iter().map(|e| e.id).collect();
    assert_eq!(ids, vec!["dupe".to_string()]); // single-valued despite the collision
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn status_reflects_latest_run_and_never_run() {
    let root = scratch("status");
    // never-run test
    write(&root.join("nr/spec.yaml"), "id: nr\n");
    // test with two runs; the newer one (later createdAt) failed
    write(&root.join("ev/spec.yaml"), "id: ev\n");
    let r1 = root.join("ev/runs/2026-06-01_ev_aaa");
    write(
      &r1.join("session.json"),
      &session_json("2026-06-01_ev_aaa", "2026-06-01T10:00:00Z"),
    );
    write(&r1.join("complete.json"), r#"{"result":"success"}"#);
    let r2 = root.join("ev/runs/2026-06-02_ev_bbb");
    write(
      &r2.join("session.json"),
      &session_json("2026-06-02_ev_bbb", "2026-06-02T10:00:00Z"),
    );
    write(&r2.join("complete.json"), r#"{"result":"failure"}"#);

    let tests = ux_tests::Folder::load_unchecked(&root).unwrap();

    let ev = tests.test("ev").unwrap().unwrap();
    let st = ev.status().unwrap();
    assert_eq!(st.run_count, 2);
    assert_eq!(st.latest_result, RunResult::Fail);
    assert_eq!(st.latest_run.as_deref(), Some("2026-06-02_ev_bbb"));

    let nr = tests.test("nr").unwrap().unwrap();
    assert_eq!(nr.status().unwrap().latest_result, RunResult::NeverRun);

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn run_in_flight_is_running_not_failed() {
    let root = scratch("inflight");
    write(&root.join("t/spec.yaml"), "id: t\n");
    let r = root.join("t/runs/2026-06-03_t_ccc");
    // session.json but NO complete.json yet. `createdAt` is NOW: a run is only
    // in flight while it is still inside its own budget, so a fixed date in the
    // past would test the overdue path instead.
    write(
      &r.join("session.json"),
      &session_json("2026-06-03_t_ccc", &Utc::now().to_rfc3339()),
    );

    let t = ux_tests::Folder::load_unchecked(&root)
      .unwrap()
      .test("t")
      .unwrap()
      .unwrap();
    assert_eq!(t.status().unwrap().latest_result, RunResult::Running);

    let _ = fs::remove_dir_all(&root);
  }

  /// A run whose driver died is indistinguishable from one still going —
  /// except in time. Nothing ever writes `complete.json` for it and nothing
  /// flips its session to `abandoned` (`mark_abandoned` is reachable only from
  /// the server's Skip route), so without a deadline it stays in flight
  /// forever and outranks every verdict the test has recorded since.
  ///
  /// Observed on rwc-04 2026-09-03: 16 such directories, the oldest six days
  /// old, held 12 tests at in-flight — nine of them over a ledger whose newest
  /// entry was a pass.
  #[test]
  fn an_overdue_run_is_terminal_and_does_not_hide_the_ledger() {
    use crate::ledger::{self, Driver, LedgerEntry, State, Verdict};

    let root = scratch("overdue");
    write(&root.join("t/spec.yaml"), "id: t\ntimeout: 120\n");
    let r = root.join("t/runs/2026-06-04_t_ddd");
    // Still `pending`, its own snapshot allows 120s, and it started a day ago.
    write(&r.join("spec.yaml"), "id: t\ntimeout: 120\n");
    write(
      &r.join("session.json"),
      &session_json_status(
        "2026-06-04_t_ddd",
        &(Utc::now() - chrono::TimeDelta::days(1)).to_rfc3339(),
        "pending",
      ),
    );
    ledger::append(
      &root.join("t/ledger.ljson"),
      &LedgerEntry {
        run: Some("2026-06-05_t_eee".to_string()),
        at: "2026-06-05T10:00:00Z".parse().unwrap(),
        by: Driver::Cli,
        host: "yuzuquats".to_string(),
        target: "https://dev--calendar.lona.so/".to_string(),
        env: None,
        verdict: Verdict::Pass,
        reload_verified: None,
        note: None,
        blocker: None,
        evidence: None,
        artifact: None,
      },
    )
    .unwrap();

    let t = ux_tests::Folder::load_unchecked(&root)
      .unwrap()
      .test("t")
      .unwrap()
      .unwrap();
    let rollup = t.rollup().unwrap();
    assert!(
      rollup.in_flight.is_empty(),
      "a run a day past a 120s budget is not still going"
    );
    // Terminal, but with no verdict of its own — so it lands in `unrecorded`,
    // which deliberately does not decide the state, and the pass survives.
    assert_eq!(rollup.unrecorded, vec!["2026-06-04_t_ddd".to_string()]);
    assert_eq!(rollup.state(), State::Ran(Verdict::Pass));

    let _ = fs::remove_dir_all(&root);
  }

  /// An EMPTY run directory is not a run at all, and must not reach `in_flight`
  /// — where it would outrank every recorded verdict the test has.
  ///
  /// `create_run_dir` makes the directory before anything is written into it, so
  /// a runner that dies first leaves one behind, and there is no artifact left
  /// to say whether it ever started. Observed on rwc-04: 971 of 1133 directories
  /// were empty, which put 66 of 73 tests in-flight and drew the whole board as
  /// "never run" over tests with thirty recorded passes each.
  #[test]
  fn an_empty_run_dir_is_not_in_flight_and_does_not_hide_the_ledger() {
    use crate::ledger::{self, Driver, LedgerEntry, State, Verdict};

    let root = scratch("emptyrun");
    write(&root.join("t/spec.yaml"), "id: t\n");
    // The directory exists and holds nothing — no session, no completion.
    fs::create_dir_all(root.join("t/runs/2026-06-04_t_ddd")).unwrap();
    ledger::append(
      &root.join("t/ledger.ljson"),
      &LedgerEntry {
        run: Some("2026-06-04_t_eee".to_string()),
        at: "2026-06-04T10:00:00Z".parse().unwrap(),
        by: Driver::Agent,
        host: "rwc-04".to_string(),
        target: "https://dev--calendar.lona.so/".to_string(),
        env: None,
        verdict: Verdict::Pass,
        reload_verified: None,
        note: None,
        blocker: None,
        evidence: None,
        artifact: None,
      },
    )
    .unwrap();

    let t = ux_tests::Folder::load_unchecked(&root)
      .unwrap()
      .test("t")
      .unwrap()
      .unwrap();
    let rollup = t.rollup().unwrap();
    assert!(rollup.in_flight.is_empty(), "an empty directory started nothing");
    assert!(rollup.unrecorded.is_empty(), "nor did it finish anything unrecorded");
    // The recorded pass survives, which is the whole point.
    assert_eq!(rollup.state(), State::Ran(Verdict::Pass));

    let _ = fs::remove_dir_all(&root);
  }

  /// A skipped run also has no `complete.json`, but it is finished — nobody is
  /// coming back to it. Reading it as `Running` is what left rollups stuck "in
  /// flight" forever, so the session status has to break the tie.
  #[test]
  fn abandoned_run_is_terminal_not_running() {
    let root = scratch("abandoned");
    write(&root.join("t/spec.yaml"), "id: t\n");
    let r = root.join("t/runs/2026-06-04_t_ddd");
    write(
      &r.join("session.json"),
      &session_json_status("2026-06-04_t_ddd", "2026-06-04T10:00:00Z", "abandoned"),
    );

    let t = ux_tests::Folder::load_unchecked(&root)
      .unwrap()
      .test("t")
      .unwrap()
      .unwrap();
    assert_eq!(t.status().unwrap().latest_result, RunResult::Abandoned);

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn derive_test_id_handles_dash_names_and_flaky() {
    assert_eq!(
      derive_test_id("2026-06-29_events-create-event-headless_db19a0"),
      Some("events-create-event-headless")
    );
    assert_eq!(derive_test_id("2026-06-29_t_ccc.flaky"), Some("t"));
    assert_eq!(derive_test_id("no-underscores"), None);
  }

  #[test]
  fn runstore_resolves_nested_legacy_and_substring() {
    let base = scratch("runstore");
    let uxt = base.join("ux-tests");
    let legacy = base.join("legacy");

    // ungrouped nested run (the test dir carries spec.yaml too)
    write(&uxt.join("alpha/spec.yaml"), "id: alpha\n");
    let nested = uxt.join("alpha/runs/2026-06-10_alpha_n1");
    write(
      &nested.join("session.json"),
      &session_json("2026-06-10_alpha_n1", "2026-06-10T10:00:00Z"),
    );
    // grouped run: event-flows/ef/runs/... (group dir has no spec.yaml of its own)
    write(&uxt.join("event-flows/ef/spec.yaml"), "id: ef\n");
    let grouped = uxt.join("event-flows/ef/runs/2026-06-12_ef_g5");
    write(
      &grouped.join("session.json"),
      &session_json("2026-06-12_ef_g5", "2026-06-12T10:00:00Z"),
    );
    // legacy flat run
    let leg = legacy.join("2026-06-09_beta_g9");
    write(
      &leg.join("session.json"),
      &session_json("2026-06-09_beta_g9", "2026-06-09T10:00:00Z"),
    );
    // scratch (spec-less ephemeral) run — enumerated + resolvable via the exhaustive scan
    let scr = uxt.join(".scratch/runs/2026-06-11_eph_s2");
    write(
      &scr.join("session.json"),
      &session_json("2026-06-11_eph_s2", "2026-06-11T10:00:00Z"),
    );
    // scratch NAMED test run — .scratch/<id>/runs/...
    write(&uxt.join(".scratch/scr-probe/spec.yaml"), "id: scr-probe\n");
    let scrnamed = uxt.join(".scratch/scr-probe/runs/2026-06-13_scr-probe_s7");
    write(
      &scrnamed.join("session.json"),
      &session_json("2026-06-13_scr-probe_s7", "2026-06-13T10:00:00Z"),
    );

    let store = RunStore::new(Some(uxt.clone()), Some(legacy.clone()));

    // exact nested (fast derive path), grouped, legacy, ephemeral, and scratch-named
    assert_eq!(store.resolve("2026-06-10_alpha_n1").unwrap(), nested);
    assert_eq!(store.resolve("2026-06-12_ef_g5").unwrap(), grouped);
    assert_eq!(store.resolve("2026-06-09_beta_g9").unwrap(), leg);
    assert_eq!(store.resolve("2026-06-11_eph_s2").unwrap(), scr);
    assert_eq!(store.resolve("2026-06-13_scr-probe_s7").unwrap(), scrnamed);
    // unique substring
    assert_eq!(store.resolve("alpha_n1").unwrap(), nested);
    // all_run_dirs sees ungrouped + grouped + ephemeral + scratch-named + legacy = 5
    assert_eq!(store.all_run_dirs().len(), 5);
    // create_run_dir nests a grouped test's run under its group dir, not the root
    // (asserted last: it materializes a new run dir).
    assert_eq!(
      store.create_run_dir("ef", "2026-06-14_ef_new").unwrap(),
      uxt.join("event-flows/ef/runs/2026-06-14_ef_new")
    );
    // missing
    assert!(store.resolve("does-not-exist").is_err());

    let _ = fs::remove_dir_all(&base);
  }

  #[test]
  fn runstore_flat_mode_is_legacy_only() {
    let base = scratch("flat");
    let legacy = base.join("legacy");
    let store = RunStore::new(None, Some(legacy.clone()));
    let dir = store
      .create_run_dir("ignored-test-id", "2026-06-12_x_aa")
      .unwrap();
    assert_eq!(dir, legacy.join("2026-06-12_x_aa")); // flat: no test-id nesting
    assert_eq!(store.resolve("2026-06-12_x_aa").unwrap(), dir);
    let _ = fs::remove_dir_all(&base);
  }
}
