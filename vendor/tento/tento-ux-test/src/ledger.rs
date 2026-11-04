//! `ledger.ljson` — the **tracked** per-test run record.
//!
//! One append-only file per test, one JSON object per line, newest last, never
//! rewritten:
//!
//! ```text
//! .ux-tests/<group>/<test-id>/ledger.ljson
//! ```
//!
//! This is the only artifact in the corpus that answers *how do things stand*
//! on a checkout that has never personally run anything. `status.json` and
//! `runs/` are both gitignored and both written only by the host that drove the
//! run, so a reader elsewhere has nothing — which is how the shared repo came
//! to carry a month-stale record while the run host held the real one.
//!
//! The bytes stay host-local. An entry carries a **manifest** of its evidence
//! ([`Evidence`]) — counts and sizes, which are tiny — plus the host that holds
//! it, so a reader elsewhere gets "89 spans and 41KB of log on yuzuquats"
//! rather than a blank pane. Fetching those bytes across hosts is a transport
//! decision this module deliberately does not make.
//!
//! Design: `ux-test-console.project.docs/content/the-record.md`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tento_openapi::ToSchema;
use tracing::warn;

/// What happened to a run somebody started.
///
/// All four are outcomes. `Running` and `NeverRun` — which [`RunResult`] mixes
/// in — are deliberately absent: they are the *absence* of an outcome and the
/// *absence of any run*, and neither is something to append.
///
/// [`RunResult`]: crate::folder::RunResult
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
  Pass,
  Fail,
  /// The operator declined the test outright.
  Abandoned,
  /// Driven partway and stopped — no verdict was reached. The state the
  /// calendar-ux-audit needed and had to describe in prose because the model
  /// had nowhere for it.
  Unfinished,
}

impl Verdict {
  /// The word the CLI and the console both print.
  pub fn label(self) -> &'static str {
    match self {
      Verdict::Pass => "pass",
      Verdict::Fail => "fail",
      Verdict::Abandoned => "abandoned",
      Verdict::Unfinished => "unfinished",
    }
  }

  /// Whether this outcome ends the attempt without judging the product. Those
  /// are the two that owe a [`blocker`](LedgerEntry::blocker).
  pub fn is_non_verdict(self) -> bool {
    matches!(self, Verdict::Abandoned | Verdict::Unfinished)
  }
}

/// How the run was driven. Every run this project has performed was driven by
/// the last two, and neither was recordable before this file existed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Driver {
  /// `ux-test run` drove it.
  Cli,
  /// An agent drove a browser.
  Agent,
  /// A person drove a browser.
  Human,
}

impl Driver {
  pub fn label(self) -> &'static str {
    match self {
      Driver::Cli => "cli",
      Driver::Agent => "agent",
      Driver::Human => "human",
    }
  }
}

/// What the owning host holds for a run — a manifest, never the bytes.
// `skip_serializing_none` is a proc-macro ATTRIBUTE, not a serde attribute: it
// rewrites the fields it sits above, so it has to run before `derive(Serialize)`
// reads them. Below the derive it is silently inert and every absent field
// serializes as an explicit `null`.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
  pub log: Option<LogEvidence>,
  pub trace: Option<TraceEvidence>,
  pub server: Option<ServerEvidence>,
  /// Frames captured — the length of `media.json`'s `shots`, which the headless
  /// runner writes beside `media/`. `0` for every run recorded before the sink
  /// existed, and for a run driven by hand.
  #[serde(default)]
  pub shots: usize,
}

/// `logs.ljson` as the run host holds it.
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogEvidence {
  pub bytes: u64,
  /// Whether the log is known to be missing part of itself. Not decoration:
  /// log batches over actix's 32KB default were rejected with a 400 while the
  /// run carried on, so a stored log can lack its middle with nothing else on
  /// screen to say so.
  #[serde(default)]
  pub truncated: bool,
}

/// `trace.ljson` as the run host holds it.
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TraceEvidence {
  pub spans: usize,
}

/// `server.ljson` as the run host holds it.
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerEvidence {
  pub bytes: u64,
}

/// Which built artifact a run measured — the candidate a release pipeline is
/// deciding on.
///
/// `env` says which *server profile* a run drove; it cannot say which *build*
/// was behind it, and a board that shows "pass on rc" with no version cannot
/// say whether that pass was against the candidate under review or the one
/// before it. The runner never discovers this by itself — a pipeline stamps it
/// (`ux-test run --artifact-*` or `TENTO_UX_ARTIFACT`), so an entry without it
/// means "nobody said", never "no artifact".
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactIdentity {
  /// The product the artifact is a build of (`lona`, `tsh`, `tento-localhost`).
  pub product: String,
  /// The version string the artifact reports (`1.0.87`, a nightly stamp).
  pub version: String,
  /// The source commit it was built from. `sha` and `git_hash` are accepted on
  /// the way in because pipelines already spell it both ways.
  #[serde(alias = "git_hash", alias = "sha")]
  pub git_hash: String,
  /// A content fingerprint of the built bytes, when the pipeline has one.
  pub fingerprint: Option<String>,
  /// The artifact's file stem in the channel (`lona-1.0.87-macos-arm64`).
  pub stem: Option<String>,
}

impl ArtifactIdentity {
  /// Refuse an identity that names nothing: an empty version stamped on every
  /// result of a candidate is worse than no stamp, because it reads as one.
  pub fn validate(&self) -> Result<()> {
    for (field, value) in [
      ("product", &self.product),
      ("version", &self.version),
      ("gitHash", &self.git_hash),
    ] {
      if value.trim().is_empty() {
        anyhow::bail!("an artifact identity needs a non-empty `{field}`");
      }
    }
    Ok(())
  }

  /// `lona 1.0.87 @ab12cd3` — how a board or a log line names it.
  pub fn label(&self) -> String {
    let short = self.git_hash.get(..9).unwrap_or(&self.git_hash);
    format!("{} {} @{short}", self.product, self.version)
  }
}

/// One line of `ledger.ljson` — one run of one test.
///
/// Three fields exist because a session was misread without them.
///
/// - **`target` is an absolute origin and path**, not an environment name. Lona
///   is multi-origin (`dev.lona.so` is marketing, `dev--calendar.lona.so` is
///   the app) and "dev" is not enough to reopen the run. Sessions storing no
///   metadata are exactly why the in-app jump link once sent every operator to
///   the marketing landing.
/// - **`reload_verified` separates two different passes.** An in-session read
///   is not trustworthy against a stale projection, so a pass that was only
///   ever seen live is a weaker claim than one re-checked through a full page
///   load. It is `None` — absent, not `false` — when nobody re-checked.
/// - **`blocker` is what makes a stalled attempt actionable.** Of fifteen
///   pending sessions read on 2026-08-04, one was genuinely runnable; the rest
///   were six different jobs for three different owners, and "pending" said the
///   same thing to all of them.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
  /// The harness session this outcome came out of — the join key to
  /// `runs/<run-id>/` on [`host`](Self::host) — or `None` when nobody captured
  /// one.
  ///
  /// **Optional on purpose, and it is the one field that must never be
  /// invented.** A run id is a claim that a directory of logs exists somewhere;
  /// an agent or a person who drove a browser by hand produced a real verdict
  /// and no such directory. Minting an id for them (which `record` did until
  /// 2026-08-07) writes a pointer to nothing, and every reader downstream then
  /// chases it: the console tunnelled over ssh to a host that had never held
  /// the run and reported "the run directory is gone", which reads as *deleted*
  /// rather than *never existed*.
  pub run: Option<String>,
  /// When the run started, RFC 3339 UTC.
  pub at: DateTime<Utc>,
  pub by: Driver,
  /// The host that wrote this entry — and, when [`run`](Self::run) is set, the
  /// one holding that session's bytes. With no session it is still the useful
  /// half of the fact: it says who was driving.
  pub host: String,
  pub target: String,
  /// The env profile this run was driven under — `--env <name>`, or `local` for
  /// the built-in.
  ///
  /// **Recorded, not derived.** A board that wants per-environment columns used
  /// to recover this by parsing the target's hostname, which works only for a
  /// product whose environments differ by host label. tento.localhost's do not:
  /// `local` and `ci` are the same hostname on different ports, so every run
  /// filed under `local` and the `ci` column could never light up no matter how
  /// many times it went green. The run knows its profile by name; throwing that
  /// away and guessing it back from a URL is the whole bug.
  ///
  /// `None` on every entry written before this field, and on a `finalize` of a
  /// session nobody said the environment of — readers fall back to derivation
  /// there rather than claiming an environment the record does not carry.
  pub env: Option<String>,
  pub verdict: Verdict,
  /// Whether the assertion survived a full page load. Meaningful on a pass.
  pub reload_verified: Option<bool>,
  /// Why it is red. Required on a failure — see [`validate`](Self::validate).
  pub note: Option<String>,
  /// A short slug for why the attempt could not proceed. Required on the two
  /// non-verdicts.
  pub blocker: Option<String>,
  pub evidence: Option<Evidence>,
  /// The built artifact this run measured, when a pipeline stamped one. `None`
  /// on every entry written before the field existed and on every run nobody
  /// stamped — readers must treat absence as "not said", never as a version.
  #[serde(default)]
  pub artifact: Option<ArtifactIdentity>,
}

impl LedgerEntry {
  /// Reject an entry that records that something happened without recording
  /// **what**.
  ///
  /// Both rules answer a measured defect. The audit found a session with
  /// verdict `failure` and `feedback: null` and recorded that *the reason that
  /// session is red exists nowhere in the run store* — it survived only because
  /// somebody wrote it into a different project's docs. And "pending" was the
  /// status on fifteen sessions that needed six different fixes.
  pub fn validate(&self) -> Result<()> {
    // An entry may name no session at all; what it may not do is name an empty
    // one. `""` would satisfy every "is there a run id" check downstream and
    // then resolve to nothing, which is the failure mode `run: None` exists to
    // make visible rather than a second spelling of it.
    if self.run.as_ref().is_some_and(|r| r.trim().is_empty()) {
      anyhow::bail!(
        "a ledger entry's run id is the session's directory name — omit it entirely when no \
         session was captured, rather than recording an empty one"
      );
    }
    if self.target.is_empty() {
      anyhow::bail!("a ledger entry needs a target — an absolute origin and path");
    }
    if self.verdict == Verdict::Fail && self.note.as_ref().is_none_or(|n| n.trim().is_empty()) {
      anyhow::bail!(
        "a failure needs a note saying why it is red — a red entry with no reason is not a record \
         of a failure, it is a record that something happened"
      );
    }
    if self.verdict.is_non_verdict() && self.blocker.as_ref().is_none_or(|b| b.trim().is_empty()) {
      anyhow::bail!(
        "an {} run needs a blocker — the short slug saying why the attempt could not proceed",
        self.verdict.label()
      );
    }
    if let Some(artifact) = &self.artifact {
      artifact.validate()?;
    }
    Ok(())
  }
}

/// What a caller knows about a run. Everything a caller does **not** know is
/// filled in by [`ux_test::Folder::record`], which is the single place those
/// defaults live.
///
/// This type exists so the CLI and the console cannot drift. `ux-test log` and
/// `POST /api/log` are both thin mappings onto a `Draft`; neither mints a run
/// id, resolves a target, or stamps a host of its own. A second implementation
/// of "what does an omitted target mean" is exactly how two writers of one
/// append-only file start disagreeing about its contents.
#[derive(Clone, Debug)]
pub struct Draft {
  pub verdict: Verdict,
  /// How the run was driven. Not defaulted: the CLI infers it from a TTY and a
  /// service reads it off the request, and neither guess is right for the other.
  pub by: Driver,
  /// The harness session behind this outcome. **Not defaulted** — `None` means
  /// nobody captured one, and `record` passes it through untouched. See
  /// [`LedgerEntry::run`] for why there is no mint here.
  pub run: Option<String>,
  /// Defaults to the spec's `params.server_url` — the only origin the corpus
  /// records. An error when the spec has none, rather than a guess: an
  /// environment name is not enough to reopen a run on a multi-origin product.
  pub target: Option<String>,
  /// Defaults to this machine.
  pub host: Option<String>,
  /// The env profile's name. **No default**: `local` is a real profile name, so
  /// filling it in for a caller who did not say would be indistinguishable from
  /// a run that genuinely used the built-in. See [`LedgerEntry::env`].
  pub env: Option<String>,
  /// Defaults to now.
  pub at: Option<DateTime<Utc>>,
  pub reload_verified: Option<bool>,
  pub note: Option<String>,
  pub blocker: Option<String>,
  pub evidence: Option<Evidence>,
  /// The artifact the run measured. **No default**, for the same reason as
  /// [`env`](Self::env): this method cannot know which build a server was
  /// running, and a guess would read exactly like a stamp. See
  /// [`LedgerEntry::artifact`].
  pub artifact: Option<ArtifactIdentity>,
}

impl Draft {
  /// The two facts every caller has. Everything else is a builder-ish field
  /// assignment on the way to `record`.
  pub fn new(verdict: Verdict, by: Driver) -> Self {
    Self {
      verdict,
      by,
      run: None,
      target: None,
      host: None,
      env: None,
      at: None,
      reload_verified: None,
      note: None,
      blocker: None,
      evidence: None,
      artifact: None,
    }
  }
}

// There is deliberately no `mint_run_id` here. It existed so `record` could fill
// an omitted run id, and the ids it produced were well-formed, resolvable by
// `folder::derive_test_id`, and pointed at directories that had never been
// created. The only thing entitled to name a session is the code that creates
// one — the harness, in `LLMLogger`.

/// This machine's name, for the `host` field — the only thing telling a reader
/// elsewhere *where* the evidence it cannot open actually lives.
///
/// Shelled out rather than read from the environment: `HOST`/`HOSTNAME` are
/// shell conveniences a service or a cron job simply does not have, and
/// silently recording an empty host would make the entry's most load-bearing
/// pointer a lie.
pub fn local_hostname() -> String {
  std::process::Command::new("hostname")
    .output()
    .ok()
    .filter(|o| o.status.success())
    .and_then(|o| String::from_utf8(o.stdout).ok())
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "unknown-host".to_string())
}

/// Read a `ledger.ljson`, oldest first. A missing file is an empty ledger — a
/// test that has never been run, which is 23 of the 46 in the corpus.
///
/// Parsing is **tolerant**, matching the rest of this crate: a line that does
/// not parse is warned and skipped rather than poisoning the whole record. The
/// file is append-only and hand-editable, and one bad line must not make a
/// test's entire history unreadable.
pub fn read(path: &Path) -> Result<Vec<LedgerEntry>> {
  let raw = match std::fs::read_to_string(path) {
    Ok(raw) => raw,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
  };

  let mut out = Vec::new();
  for (i, line) in raw.lines().enumerate() {
    if line.trim().is_empty() {
      continue;
    }
    match serde_json::from_str::<LedgerEntry>(line) {
      Ok(entry) => out.push(entry),
      Err(e) => warn!(
        "{}:{}: skipping unparseable ledger line: {e}",
        path.display(),
        i + 1
      ),
    }
  }
  Ok(out)
}

/// Append one entry. Validates first, so an unusable entry is refused at the
/// write rather than discovered by a reader months later.
///
/// The write is one `write_all` of a single line to a file opened `O_APPEND`,
/// which is what keeps concurrent appends from interleaving. Per-test files are
/// what keep them from *conflicting*: a corpus-wide ledger would conflict
/// whenever any two runs anywhere overlapped, and appends are the shape git
/// resolves worst. Two runs of the *same* test still conflict, and there the
/// resolution is unambiguous — keep both lines, sorted by `at`.
pub fn append(path: &Path, entry: &LedgerEntry) -> Result<()> {
  entry.validate()?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
  }
  let mut line = serde_json::to_string(entry).context("serialize ledger entry")?;
  line.push('\n');
  let mut f = OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)
    .with_context(|| format!("open {} for append", path.display()))?;
  f.write_all(line.as_bytes())
    .with_context(|| format!("append to {}", path.display()))?;
  Ok(())
}

/// A test's state, derived from the ledger ∪ the local run store.
///
/// The two sources answer different questions and neither subsumes the other:
/// the ledger is the shared record and is all a fresh checkout has; the run
/// store is host-local and is the only thing that knows about a run happening
/// *right now*. So the rollup carries both, and says which is which.
#[derive(Clone, Debug)]
pub struct Rollup {
  pub test_id: String,
  /// Ledger entries, oldest first, exactly as recorded.
  pub entries: Vec<LedgerEntry>,
  /// Local run ids with no ledger entry and no outcome yet — in flight.
  pub in_flight: Vec<String>,
  /// Local run ids that finished but were never appended. These are the phase-2
  /// backfill list, and on a host that has run things they are the difference
  /// between the record and the truth.
  pub unrecorded: Vec<String>,
}

/// What the console shows in a test's `Latest` column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
  /// The ledger is empty and this host holds no runs.
  NeverRun,
  /// A run this host knows about has not produced an outcome.
  InFlight,
  /// The newest recorded outcome.
  Ran(Verdict),
}

impl Rollup {
  /// The newest recorded entry. Entries are appended in run order, so this is
  /// the last line — not a max over `at`, which would let a backdated backfill
  /// line displace a live run.
  pub fn latest(&self) -> Option<&LedgerEntry> {
    self.entries.last()
  }

  /// Every run this rollup knows about, from either source. The three lists are
  /// disjoint by construction: `in_flight` and `unrecorded` are exactly the
  /// local run ids that no entry names.
  pub fn run_count(&self) -> usize {
    self.entries.len() + self.in_flight.len() + self.unrecorded.len()
  }

  /// A run this host is driving outranks the record, because the record is
  /// necessarily behind it. Otherwise the newest entry decides, and a test with
  /// neither has never run.
  ///
  /// `unrecorded` deliberately does **not** decide the state. A completed local
  /// run with no entry is a gap in the record, and showing its outcome as
  /// though it were recorded would hide exactly the gap this file exists to
  /// close.
  pub fn state(&self) -> State {
    if !self.in_flight.is_empty() {
      return State::InFlight;
    }
    match self.latest() {
      Some(e) => State::Ran(e.verdict),
      None => State::NeverRun,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn entry(verdict: Verdict) -> LedgerEntry {
    LedgerEntry {
      run: Some("2026-08-03_event-flow-create_a5c3cf".to_string()),
      at: "2026-08-03T18:42:11Z".parse().expect("fixture timestamp"),
      by: Driver::Agent,
      host: "yuzuquats".to_string(),
      target: "https://dev--calendar.lona.so/".to_string(),
      env: None,
      verdict,
      reload_verified: None,
      note: None,
      blocker: None,
      evidence: None,
      artifact: None,
    }
  }

  #[test]
  fn a_failure_without_a_reason_is_refused() {
    assert!(entry(Verdict::Fail).validate().is_err());
    let mut e = entry(Verdict::Fail);
    e.note = Some("calendar never repainted after the write".to_string());
    e.validate().expect("a failure with a note is a record");
  }

  #[test]
  fn a_stalled_attempt_without_a_blocker_is_refused() {
    assert!(entry(Verdict::Unfinished).validate().is_err());
    assert!(entry(Verdict::Abandoned).validate().is_err());
    let mut e = entry(Verdict::Unfinished);
    e.blocker = Some("no-app-command".to_string());
    e.validate().expect("a blocker makes it actionable");
  }

  #[test]
  fn round_trips_through_one_line() {
    let dir = std::env::temp_dir().join(format!("ux-ledger-{}", std::process::id()));
    let path = dir.join("ledger.ljson");
    let _ = std::fs::remove_file(&path);

    let mut first = entry(Verdict::Pass);
    first.reload_verified = Some(true);
    append(&path, &first).expect("append");
    let mut second = entry(Verdict::Fail);
    second.run = Some("2026-08-03_event-flow-create_bbbbbb".to_string());
    second.note = Some("did not persist".to_string());
    append(&path, &second).expect("append");

    let read_back = read(&path).expect("read");
    assert_eq!(read_back.len(), 2);
    assert_eq!(read_back[0].verdict, Verdict::Pass);
    assert_eq!(read_back[0].reload_verified, Some(true));
    // Newest LAST — a reader takes the tail, never a max over `at`.
    assert_eq!(read_back[1].verdict, Verdict::Fail);
    // Absent is absent: `reloadVerified` must not serialize as `null` on an
    // entry nobody re-checked, or every reader has to distinguish two nulls.
    let raw = std::fs::read_to_string(&path).expect("raw");
    assert!(
      !raw
        .lines()
        .nth(1)
        .expect("second line")
        .contains("reloadVerified")
    );

    let _ = std::fs::remove_file(&path);
  }

  /// An entry stamped with the artifact it measured round-trips, an unstamped
  /// one writes no `artifact` key at all, and a line written before the field
  /// existed still reads — as "not said".
  #[test]
  fn the_artifact_stamp_round_trips_and_its_absence_is_tolerated() {
    let dir = std::env::temp_dir().join(format!("ux-ledger-artifact-{}", std::process::id()));
    let path = dir.join("ledger.ljson");
    let _ = std::fs::remove_file(&path);

    let stamp = ArtifactIdentity {
      product: "lona".to_string(),
      version: "1.0.87".to_string(),
      git_hash: "ab12cd34ef56".to_string(),
      fingerprint: Some("sha256:00ff".to_string()),
      stem: None,
    };
    let mut stamped = entry(Verdict::Pass);
    stamped.artifact = Some(stamp.clone());
    append(&path, &stamped).expect("append stamped");
    append(&path, &entry(Verdict::Pass)).expect("append unstamped");
    // A line from before the field existed, verbatim.
    std::fs::OpenOptions::new()
      .append(true)
      .open(&path)
      .expect("reopen")
      .write_all(
        b"{\"run\":\"2026-08-03_t_cccccc\",\"at\":\"2026-08-03T18:42:11Z\",\"by\":\"cli\",\
          \"host\":\"yuzuquats\",\"target\":\"https://x/\",\"verdict\":\"pass\"}\n",
      )
      .expect("write legacy line");

    let raw = std::fs::read_to_string(&path).expect("raw");
    let lines: Vec<&str> = raw.lines().collect();
    assert!(
      lines[0].contains(r#""artifact":{"product":"lona","version":"1.0.87","gitHash":"ab12cd34ef56","fingerprint":"sha256:00ff"}"#),
      "{}",
      lines[0]
    );
    assert!(!lines[1].contains("artifact"), "{}", lines[1]);

    let read_back = read(&path).expect("read");
    assert_eq!(read_back.len(), 3);
    assert_eq!(read_back[0].artifact.as_ref(), Some(&stamp));
    assert_eq!(read_back[1].artifact, None);
    assert_eq!(read_back[2].artifact, None);

    // A stamp that names nothing is refused at the write.
    let mut blank = entry(Verdict::Pass);
    blank.artifact = Some(ArtifactIdentity {
      version: " ".to_string(),
      ..stamp
    });
    assert!(append(&path, &blank).is_err());

    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn a_bad_line_costs_only_itself() {
    let dir = std::env::temp_dir().join(format!("ux-ledger-bad-{}", std::process::id()));
    let path = dir.join("ledger.ljson");
    let _ = std::fs::remove_file(&path);

    append(&path, &entry(Verdict::Pass)).expect("append");
    std::fs::OpenOptions::new()
      .append(true)
      .open(&path)
      .expect("reopen")
      .write_all(b"{ not json\n")
      .expect("write junk");
    append(&path, &entry(Verdict::Pass)).expect("append");

    assert_eq!(read(&path).expect("read").len(), 2);
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn a_run_with_no_session_records_the_absence_rather_than_an_id() {
    let mut e = entry(Verdict::Pass);
    e.run = None;
    e.validate()
      .expect("a hand-driven verdict is a record, session or not");

    // Absent, not empty. `""` passes every downstream "is there an id" check
    // and then resolves to no directory, which is the exact confusion `None`
    // exists to prevent.
    e.run = Some("  ".to_string());
    assert!(e.validate().is_err());

    // And absent stays absent on the wire — a reader must not have to tell two
    // spellings of "no session" apart.
    let line = serde_json::to_string(&entry_without_session()).expect("serialize");
    assert!(!line.contains("\"run\""), "{line}");
  }

  fn entry_without_session() -> LedgerEntry {
    let mut e = entry(Verdict::Pass);
    e.run = None;
    e
  }

  #[test]
  fn a_missing_ledger_is_an_empty_one() {
    let path = std::env::temp_dir().join("ux-ledger-absent/ledger.ljson");
    assert!(read(&path).expect("read").is_empty());
  }

  #[test]
  fn an_in_flight_run_outranks_the_record() {
    let recorded = Rollup {
      test_id: "event-flow-create".to_string(),
      entries: vec![entry(Verdict::Pass)],
      in_flight: Vec::new(),
      unrecorded: Vec::new(),
    };
    assert_eq!(recorded.state(), State::Ran(Verdict::Pass));

    let running = Rollup {
      in_flight: vec!["2026-08-07_event-flow-create_ffffff".to_string()],
      ..recorded.clone()
    };
    assert_eq!(running.state(), State::InFlight);
    assert_eq!(running.run_count(), 2);

    // A finished local run nobody appended is a GAP, not a state. Reporting its
    // outcome here would hide the thing the ledger exists to expose.
    let gap = Rollup {
      entries: Vec::new(),
      unrecorded: vec!["2026-07-03_event-flow-create_cccccc".to_string()],
      ..recorded.clone()
    };
    assert_eq!(gap.state(), State::NeverRun);
    assert_eq!(gap.run_count(), 1);
  }
}
