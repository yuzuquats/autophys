//! The `ux-test` subcommand group.
//!
//! Commands — `run`, `log`, `await`, `finalize`, `logs`, `render`, `trace`, `view`,
//! `monitor`, `delete`, `ls`, `lint`, `verb`, `report` — built into a [`Scripts`]
//! registry over [`UxTestCtx`]. The host (e.g. the `scripts` crate) implements
//! [`UxTestEnv`] and hands over a [`HostPort`](crate::HostPort) fed by its own
//! verb loop, then mounts this group via `add_subcommand("ux-test", ...)`, yielding
//! `./run ux-test run`, `./run ux-test trace --session ...`, etc.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use anyhow::Context;
use chrono::Utc;
use serde::Deserialize;
use tento_sh::{CommandArg, Scripts};
use tracing::{info, warn};
use uuid::Uuid;

use tento_term::pad::Align;
use tento_term::table::TableBody;
use tento_term::{Cell, Column, Style, Table};

use crate::agent::{self, AgentEnd, AgentRecord, LaunchBrowser};
use crate::env_profile::EnvProfile;
use crate::folder::{
  RunResult, SCRATCH_TEST_ID, TestEntry, TestStatus, VerificationOutcome, VerificationRecord,
  has_final_verification, ux_run,
};
use crate::ledger::{self, ArtifactIdentity, Draft, Driver, Verdict};
use crate::orchestration::{
  self, UxTestCtx, await_session_completion, execute_setup_action, execute_teardown_action,
  run_monitor, trace_judge_source, verify_trace_results,
};
use crate::report::{
  self as run_report, ARTIFACT_ENV, NothingToRun, ProfileReport, RunReport, RunnerIdentity,
  SPEC_ACCOUNTS_TYPE, Selection, SelectionKind, SpecAccountEntry, SpecAccounts, SpecOutcome,
  SpecReport, UserSource,
};
use crate::session::{LLMLogger, Session, SessionParam, SessionStatus};
use crate::spec::{ExecutableAction, TestSpec};

/// Build the `ux-test` subcommand group.
pub fn scripts(ctx: UxTestCtx) -> Scripts<UxTestCtx> {
  Scripts::new(ctx)
    .add_command(run)
    .add_command(log_run)
    .add_command(await_session)
    .add_command(finalize_session)
    .add_command(read_logs)
    .add_command(render_logs)
    .add_command(trace_session)
    .add_command(view)
    .add_command(monitor_session)
    .add_command(delete_session)
    .add_command(list_tests)
    .add_command(lint)
    .add_command(verb)
    .add_command(report)
    .add_command(list_sessions)
    .add_command(spec_accounts)
    .add_command(migrate)
}

// ===========================================================================
// ux-test ls
// ===========================================================================

/// Arguments for `ux-test ls` — the test-centric listing.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct ListTestsArgs {
  /// Filter by latest-run status: success / failure / running / never-run.
  status: Option<String>,
  /// Only tests in this group (top-level group dir; `-` or empty = ungrouped;
  /// `.scratch` = the throwaway zone).
  group: Option<String>,
  /// Also list the gitignored `.scratch` throwaway zone's kept-local tests.
  #[serde(default)]
  scratch: bool,
  /// Show everything, including `.scratch` (today: same as --scratch). CLI: `--all`.
  #[serde(default)]
  all: bool,
  /// Max rows to show (default: 200).
  limit: Option<usize>,
}

/// List the UX tests in the `.ux-tests` corpus, one row per test with its
/// latest-run status — the "is test X green?" view. Falls back to the per-run
/// listing in flat mode (no `.ux-tests` configured). Returns an inline
/// `table/v1` so the shell trace pane and the CLI render the same table.
#[tento_sh::command(
  name = "ls",
  description = "List UX tests with their latest-run status"
)]
pub async fn list_tests(
  ctx: UxTestCtx,
  args: Option<ListTestsArgs>,
) -> tento_sh::Result<TableBody> {
  let args = args.unwrap_or_default();
  let logger = ctx.logger();

  // No checked-in corpus (flat mode) ⇒ fall back to the per-run listing.
  let Some(folder) = logger.runs().tests_folder() else {
    return runs_table(
      &logger,
      args.status.as_deref(),
      None,
      args.limit.unwrap_or(30),
    );
  };

  let limit = args.limit.unwrap_or(200);
  let want = args.status.as_deref().map(str::to_lowercase);
  // The `.scratch` throwaway zone is off by default; --scratch / --all / an
  // explicit `--group .scratch` opts it in.
  let group_filter = args.group.as_deref();
  let include_scratch = args.scratch || args.all || group_filter == Some(SCRATCH_TEST_ID);

  let mut entries: Vec<TestEntry> = folder
    .tests()
    .map_err(|e| anyhow::anyhow!("read .ux-tests: {e}"))?;
  if include_scratch {
    entries.extend(
      folder
        .scratch_tests()
        .map_err(|e| anyhow::anyhow!("read .ux-tests/.scratch: {e}"))?,
    );
  }

  // Group filter: `-` or empty ⇒ ungrouped (no group); otherwise exact group name.
  if let Some(g) = group_filter {
    let want_ungrouped = g.is_empty() || g == "-";
    entries.retain(|e| {
      if want_ungrouped {
        e.group.is_none()
      } else {
        e.group.as_deref() == Some(g)
      }
    });
  }

  let mut tests: Vec<(String, Option<String>, TestStatus)> = entries
    .into_iter()
    .filter_map(|e| e.folder.status().ok().map(|st| (e.id, e.group, st)))
    .collect();
  if let Some(want) = &want {
    tests.retain(|(_, _, st)| run_result_label(st.latest_result) == want.as_str());
  }
  // Most-recent activity first; never-run (no latest_at) sort last.
  tests.sort_by(|a, b| b.2.latest_at.cmp(&a.2.latest_at));
  let total = tests.len();
  tests.truncate(limit);

  let title = if total == 0 {
    "ux-tests — none found".to_string()
  } else if total > tests.len() {
    format!(
      "ux-tests — {} of {total} (use --limit for more)",
      tests.len()
    )
  } else {
    "ux-tests".to_string()
  };

  let mut table = Table::new(vec![
    Column::new("STATUS").priority(0),
    Column::new("LATEST").align(Align::Right).priority(3),
    Column::new("RUNS").align(Align::Right).priority(4),
    Column::new("GROUP").priority(2),
    Column::new("TEST").flex(1).priority(1),
  ])
  .title(title);

  for (id, group, st) in &tests {
    let latest = st
      .latest_at
      .map(humanize_age)
      .unwrap_or_else(|| "-".to_string());
    table.push_row(vec![
      Cell::new(
        run_result_label(st.latest_result),
        run_result_style(st.latest_result),
      ),
      Cell::plain(latest),
      Cell::plain(st.run_count.to_string()),
      Cell::plain(group.clone().unwrap_or_default()),
      Cell::plain(id.clone()),
    ]);
  }

  Ok(table.into_body())
}

/// Arguments for `ux-test lint` — the offline corpus check.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct LintArgs {
  /// Also lint the gitignored `.scratch` throwaway zone.
  #[serde(default)]
  scratch: bool,
}

/// Check every corpus spec's verbs against the mounted host's vocabulary.
///
/// This is the safety the closed setup/teardown enums used to provide and a
/// catch-all cannot: `craete_trial_user` parses fine and fails at dispatch —
/// possibly in a teardown, whose failures are deliberately non-fatal, which is
/// exactly how `reset_for_test` and `delete_user_if_exists` once sat in nine
/// specs doing nothing at all. Parse-time safety returns here as lint-time
/// safety, in the same layer that validates verification patterns, and offline:
/// no server, no database, no browser.
///
/// It also lists every planned step that names no log (no `logs`, no
/// `success_log`): the judge fails such a run, so a spec that will fail
/// whatever the app does is reported here, before anything runs.
///
/// Exits non-zero when anything is unknown or unlogged, so it can gate.
#[tento_sh::command(
  name = "lint",
  description = "Check every corpus spec's verbs against this host's vocabulary, and that every step names its logs"
)]
pub async fn lint(ctx: UxTestCtx, args: Option<LintArgs>) -> tento_sh::Result<()> {
  let args = args.unwrap_or_default();
  let logger = ctx.logger();
  let store = logger.runs();

  let folder = store
    .tests_folder()
    .context("no .ux-tests root is configured on this host")?;
  let mut entries: Vec<TestEntry> = folder
    .tests()
    .map_err(|e| anyhow::anyhow!("read .ux-tests: {e}"))?;
  if args.scratch {
    entries.extend(
      folder
        .scratch_tests()
        .map_err(|e| anyhow::anyhow!("read .ux-tests/.scratch: {e}"))?,
    );
  }

  let known = ctx.port().verbs();
  let mut unknown_lines: Vec<String> = Vec::new();
  let mut unlogged_lines: Vec<String> = Vec::new();
  let mut unparsed: Vec<String> = Vec::new();
  let mut checked = 0usize;

  for entry in &entries {
    let Some(path) = store.test_spec_path(&entry.id) else {
      continue;
    };
    // A spec that will not parse is its own kind of unknown verb — report it
    // here rather than letting the next run be the one that finds out.
    let spec = match TestSpec::from_yaml_file(&path) {
      Ok(spec) => spec,
      Err(e) => {
        unparsed.push(format!("{}: does not parse — {e:#}", entry.id));
        continue;
      }
    };
    checked += 1;
    for action in orchestration::unknown_host_actions(&spec, known) {
      unknown_lines.push(format!("{}: unknown verb '{action}'", entry.id));
    }
    for (_, step) in spec.unlogged_steps() {
      unlogged_lines.push(format!("{}: step '{}' names no log", entry.id, step.id));
    }
  }

  for line in unparsed.iter().chain(&unknown_lines).chain(&unlogged_lines) {
    println!("{line}");
  }

  if unknown_lines.is_empty() && unparsed.is_empty() && unlogged_lines.is_empty() {
    println!("ux-test lint: {checked} spec(s) checked, every verb is known and every step names its logs.");
    println!("  host verbs: {}", known.join(", "));
    return Ok(());
  }

  Err(
    anyhow::anyhow!(
      "ux-test lint: {} unknown verb(s), {} unlogged step(s) and {} unparsable spec(s) across \
       {checked} spec(s)\n  host verbs: {}",
      unknown_lines.len(),
      unlogged_lines.len(),
      unparsed.len(),
      known.join(", ")
    )
    .into(),
  )
}

// ===========================================================================
// ux-test verb
// ===========================================================================

/// Arguments for `ux-test verb` — one host verb, outside any spec.
///
/// `ux-test verb delete_user_if_exists --params '{"user":"ux-lane1-0a1b2c3d@lona.so"}'`.
/// The verb name may also be spelled `--action <verb>`.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct VerbArgs {
  /// The host verb to run, e.g. `delete_user_if_exists`. Must be one of the
  /// corpus-callable verbs `ux-test lint` checks specs against.
  action: String,

  /// The verb's params as a JSON object — exactly the fields a spec's
  /// setup/teardown step writes beside `action:`. Absent ⇒ `{}`.
  ///
  /// Typed as a JSON value rather than a string because the arg layer already
  /// parses an object-shaped flag value into an object; a string (the
  /// positional form, or malformed JSON) is parsed here.
  #[serde(default)]
  params: Option<serde_json::Value>,
}

/// Run ONE host verb, the way a spec's setup step does, and print its JSON
/// result on stdout.
///
/// For callers that need a fixture outside a spec — release-ci's pool teardown
/// deletes each per-run pool account with
/// `ux-test verb delete_user_if_exists --params '{"user":"…"}'`. The verb goes
/// through the same [`HostPort::execute_verb`](crate::HostPort::execute_verb)
/// a setup step uses, so every guard the host puts on a verb applies unchanged
/// (lona refuses to delete a protected or non-throwaway account). This command
/// adds no flag of its own that loosens any of them, and it is stricter than a
/// spec step in one way: the protected-account opt-ins
/// (`allow_destroy_protected_user`, `allow_mutate_protected_user`) are refused
/// outright, for every verb, before anything is sent. Those opt-ins are a
/// reviewed spec step's decision; a lone
/// command line has no review behind it, and a teardown only ever deletes
/// throwaway accounts.
///
/// Where the verb executes is the host mount's business, not a flag here: the
/// in-process host loop against the process env, or the server named by the
/// host's verb-endpoint setting. `--env` profiles do not apply — they pick the
/// server a BROWSER measures, and a lone verb drives no browser (a `run
/// --env rc` executes its setup verbs in this same process for the same reason).
///
/// Exits non-zero when the verb is unknown, the params are not a JSON object
/// (or carry `store_as` or a protected-account opt-in), or the host answers
/// with an error — unlike a spec teardown, where a failed
/// verb is logged and swallowed, a lone verb's failure is the whole answer.
#[tento_sh::command(
  name = "verb",
  description = "Run ONE host verb (as a spec setup step would) and print its JSON result"
)]
pub async fn verb(ctx: UxTestCtx, args: Option<VerbArgs>) -> tento_sh::Result<()> {
  let args = args.context("usage: ux-test verb <action> [--params '<json object>']")?;
  let result = run_lone_verb(ctx.port(), &args.action, args.params).await?;
  println!(
    "{}",
    serde_json::to_string(&result).context("serialize the verb's result")?
  );
  Ok(())
}

/// The body of `ux-test verb`, over a bare port so it is testable without a host
/// environment: refuse an unknown verb before anything is sent, shape the
/// params, dispatch, and hand back the host's answer (or its error).
async fn run_lone_verb(
  port: &crate::HostPort,
  action: &str,
  params: Option<serde_json::Value>,
) -> anyhow::Result<serde_json::Value> {
  let known = port.verbs();
  if !known.iter().any(|known_verb| known_verb == action) {
    anyhow::bail!(
      "unknown verb '{action}': this host answers {} (the vocabulary `ux-test lint` checks \
       specs against)",
      known.join(", ")
    );
  }
  let params = lone_verb_params(params)?;
  port
    .execute_verb(action, params)
    .await
    .with_context(|| format!("verb '{action}' failed"))
}

/// Shape `--params` into the JSON object a spec step would carry.
///
/// A step's params are always an object (the step's fields minus `action:`),
/// so anything else is refused rather than forwarded. `store_as` is refused
/// too: in a spec it is the machinery's own plumbing, stripped before the host
/// ever sees it, and a lone verb has no later step for it to feed.
///
/// [`PROTECTED_DELETE_OPT_IN`] is refused for every verb, whatever its value:
/// it is the spec-step opt-in that lets lona destroy even a protected account,
/// and a standalone command offers no reviewed spec to carry that decision.
/// There is deliberately no flag that re-enables it here.
fn lone_verb_params(params: Option<serde_json::Value>) -> anyhow::Result<serde_json::Value> {
  let params = match params {
    None => serde_json::Value::Object(serde_json::Map::new()),
    Some(serde_json::Value::String(text)) => {
      serde_json::from_str(&text).with_context(|| format!("--params is not valid JSON: {text}"))?
    }
    Some(value) => value,
  };
  let serde_json::Value::Object(map) = &params else {
    anyhow::bail!("--params must be a JSON object (a spec step's fields), got {params}");
  };
  if map.contains_key("store_as") {
    anyhow::bail!(
      "--params carries `store_as`, which is spec plumbing (it names a later step's param); a \
       lone verb has no later step"
    );
  }
  if let Some(opt_in) = PROTECTED_OPT_INS.iter().find(|k| map.contains_key(**k)) {
    anyhow::bail!(
      "--params carries `{opt_in}`, which `ux-test verb` refuses: touching a protected account \
       is a reviewed spec step's opt-in, never a lone command's; nothing was sent to the host"
    );
  }
  Ok(params)
}

/// The params fields with which a spec step opts in to destroying or mutating
/// a protected account (lona's `guard_destroy` and `guard_mutate`). `ux-test
/// verb` never forwards either.
const PROTECTED_OPT_INS: [&str; 2] = [
  "allow_destroy_protected_user",
  "allow_mutate_protected_user",
];

/// Arguments for `ux-test report` — the corpus-wide rollup.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct ReportArgs {
  /// Only tests in this group (`-` or empty = ungrouped).
  group: Option<String>,
  /// Include the gitignored `.scratch` throwaway zone.
  #[serde(default)]
  scratch: bool,
}

/// Where the corpus stands, in one screen: how many tests are green, how many
/// are red, how many have never run at all — and which ones.
///
/// This exists because the verdict record used to be answered by a git-tracked
/// `status.json` per test, written only by the host that ran the test and
/// therefore never committed. The rollup now comes from the run store on
/// demand, so the answer is correct wherever it is asked rather than being a
/// month-old snapshot someone forgot to push.
///
/// `ls` shows one row per test; this shows the shape of the whole corpus, which
/// is the thing you actually want before a release.
#[tento_sh::command(
  name = "report",
  description = "Corpus-wide UX-test rollup: pass/fail/never-run counts and the outliers"
)]
pub async fn report(ctx: UxTestCtx, args: Option<ReportArgs>) -> tento_sh::Result<TableBody> {
  let args = args.unwrap_or_default();
  let logger = ctx.logger();

  let folder = logger
    .runs()
    .tests_folder()
    .context("no .ux-tests root is configured on this host")?;

  let mut entries: Vec<TestEntry> = folder
    .tests()
    .map_err(|e| anyhow::anyhow!("read .ux-tests: {e}"))?;
  if args.scratch {
    entries.extend(
      folder
        .scratch_tests()
        .map_err(|e| anyhow::anyhow!("read .ux-tests/.scratch: {e}"))?,
    );
  }
  if let Some(g) = args.group.as_deref() {
    let ungrouped = g.is_empty() || g == "-";
    entries.retain(|e| {
      if ungrouped {
        e.group.is_none()
      } else {
        e.group.as_deref() == Some(g)
      }
    });
  }

  let rolled: Vec<(String, TestStatus)> = entries
    .into_iter()
    .filter_map(|e| e.folder.status().ok().map(|st| (e.id, st)))
    .collect();

  let count = |r: RunResult| {
    rolled
      .iter()
      .filter(|(_, st)| st.latest_result == r)
      .count()
  };
  let total = rolled.len();
  let newest = rolled.iter().filter_map(|(_, st)| st.latest_at).max();

  let mut table = Table::new(vec![
    Column::new("STATUS").priority(0),
    Column::new("N").align(Align::Right).priority(1),
    Column::new("TESTS").flex(1).priority(2),
  ])
  .title(match newest {
    Some(at) => format!(
      "ux-test report — {total} tests, newest run {}",
      humanize_age(at)
    ),
    None => format!("ux-test report — {total} tests, none ever run"),
  });

  // Name the outliers inline: a bare count of failures is not actionable, and
  // "never run" is the number that quietly decides how much the suite is worth.
  for r in [
    RunResult::Pass,
    RunResult::Fail,
    RunResult::Unknown,
    RunResult::Abandoned,
    RunResult::Running,
    RunResult::NeverRun,
  ] {
    let n = count(r);
    let names = if matches!(r, RunResult::Pass) || n == 0 {
      String::new()
    } else {
      rolled
        .iter()
        .filter(|(_, st)| st.latest_result == r)
        .map(|(id, _)| id.as_str())
        .collect::<Vec<_>>()
        .join(", ")
    };
    table.push_row(vec![
      Cell::new(run_result_label(r), run_result_style(r)),
      Cell::plain(n.to_string()),
      Cell::plain(names),
    ]);
  }

  Ok(table.into_body())
}

/// Arguments for `ux-test runs` — the per-run (session) listing.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct ListSessionsArgs {
  /// Filter by status: pending / running / completed / success / failure / abandoned / unknown.
  status: Option<String>,
  /// Only runs of this test (by test-id).
  test: Option<String>,
  /// Max rows to show (default: 30).
  limit: Option<usize>,
}

/// List individual UX-test runs (sessions), newest first — optionally scoped to
/// one test via `--test <id>`. This is the old `ls` view; `ls` is now
/// test-centric.
#[tento_sh::command(
  name = "runs",
  description = "List UX-test runs (sessions), newest first"
)]
pub async fn list_sessions(
  ctx: UxTestCtx,
  args: Option<ListSessionsArgs>,
) -> tento_sh::Result<TableBody> {
  let args = args.unwrap_or_default();
  runs_table(
    &ctx.logger(),
    args.status.as_deref(),
    args.test.as_deref(),
    args.limit.unwrap_or(30),
  )
}

/// Build the per-run (session) table — shared by `ux-test runs` and the
/// flat-mode fallback of `ux-test ls`.
fn runs_table(
  logger: &LLMLogger,
  status: Option<&str>,
  test: Option<&str>,
  limit: usize,
) -> tento_sh::Result<TableBody> {
  let want = status.map(str::to_lowercase);
  // Read the same authoritative verdict as the test rollup. A headless
  // completion records execution, not whether the verification judges passed.
  let mut rows: Vec<_> = logger
    .runs()
    .all_run_dirs()
    .into_iter()
    .filter_map(|path| {
      let run_folder = ux_run::Folder::load_unchecked(&path).ok()?;
      Some((run_folder.session()?, run_folder.result()))
    })
    .collect();
  rows.sort_by(|a, b| b.0.created_at.cmp(&a.0.created_at));
  if let Some(test) = test {
    rows.retain(|(s, _)| s.test_id.as_deref() == Some(test));
  }
  if let Some(want) = &want {
    rows.retain(|(s, result)| status_label(&s.status, *result) == want);
  }
  let total = rows.len();
  rows.truncate(limit);

  let title = if total == 0 {
    "ux-test runs — none found".to_string()
  } else if total > rows.len() {
    format!(
      "ux-test runs — {} of {total} (use --limit for more)",
      rows.len()
    )
  } else {
    "ux-test runs".to_string()
  };

  // STATUS stays in the grid longest; SESSION (the long id) flexes to fill
  // spare width and is the first to drop to a per-row sub-line when narrow.
  let mut table = Table::new(vec![
    Column::new("STATUS").priority(0),
    Column::new("AGE").align(Align::Right).priority(1),
    Column::new("STEPS").align(Align::Right).priority(2),
    Column::new("TID").priority(3),
    Column::new("SESSION").flex(1).priority(4),
  ])
  .title(title);

  for (s, result) in &rows {
    let tid = s
      .tracing_uuid
      .map(|u| u.to_string()[..8].to_string())
      .unwrap_or_else(|| "-".to_string());
    table.push_row(vec![
      Cell::new(
        status_label(&s.status, *result),
        status_style(&s.status, *result),
      ),
      Cell::plain(humanize_age(s.created_at)),
      Cell::plain(s.instructions.len().to_string()),
      Cell::plain(tid),
      Cell::plain(s.id.to_string()),
    ]);
  }

  Ok(table.into_body())
}

/// `RunResult` → the same status vocabulary `ux-test runs` uses.
fn run_result_label(r: RunResult) -> &'static str {
  match r {
    RunResult::Pass => "success",
    RunResult::Fail => "failure",
    RunResult::Abandoned => "abandoned",
    RunResult::Running => "running",
    RunResult::NeverRun => "never-run",
    RunResult::Unknown => "unknown",
  }
}

/// Cell style for a `RunResult`: success green, failure red, running yellow,
/// abandoned and never-run dimmed (both mean "no verdict here").
///
/// `Unknown` is yellow rather than dimmed. It is not a quiet absence like
/// never-run — it is a run that finished and told us nothing, which is a thing
/// somebody has to go look at.
fn run_result_style(r: RunResult) -> Style {
  match r {
    RunResult::Pass => Style::Green,
    RunResult::Fail => Style::Red,
    RunResult::Running | RunResult::Unknown => Style::Yellow,
    RunResult::Abandoned | RunResult::NeverRun => Style::Dimmed,
  }
}

/// Refuse a run whose two account channels disagree.
///
/// `--user` sets the account the browser drives as. `params.user_email` sets
/// that *and* the identity `assert_rows` reads back. Supply both with different
/// values and the run drives as one while asserting against the other: it is
/// well-formed, it produces a verdict, and the verdict is meaningless. That is
/// the misconfiguration behind the 2026-08-12 events results, and it took a week
/// to spot precisely because nothing looked wrong.
///
/// Silently preferring one channel is what made it invisible, so this refuses
/// instead of picking a winner. Passing only one is always fine.
fn check_account_agreement(flag: Option<&str>, declared: Option<&str>) -> anyhow::Result<()> {
  match (flag, declared) {
    (Some(f), Some(d)) if f != d => anyhow::bail!(
      "account mismatch: --user is {f:?} but the spec declares \
       params.user_email = {d:?}.\n  The run would drive as {f:?} and assert \
       rows against {d:?}, which cannot be meaningful.\n  Pass --user {d:?}, \
       drop --user to use the declared account, or change the spec."
    ),
    _ => Ok(()),
  }
}

/// Preserve unjudged lifecycle labels; a recorded verdict always takes priority.
fn status_label(status: &SessionStatus, result: RunResult) -> &'static str {
  match (result, status) {
    (RunResult::Running, SessionStatus::Pending) => "pending",
    (RunResult::Running, SessionStatus::Completed) => "completed",
    _ => run_result_label(result),
  }
}

/// Verdict colors match the test rollup; lifecycle-only pending stays dimmed.
fn status_style(status: &SessionStatus, result: RunResult) -> Style {
  match (result, status) {
    (RunResult::Running, SessionStatus::Pending) => Style::Dimmed,
    (RunResult::Running, SessionStatus::Completed) => Style::None,
    _ => run_result_style(result),
  }
}

/// Compact "time since" label (e.g. `2h`, `3d`) for a session's creation time.
fn humanize_age(created: chrono::DateTime<Utc>) -> String {
  let secs = (Utc::now() - created).num_seconds().max(0);
  if secs < 60 {
    format!("{secs}s")
  } else if secs < 3600 {
    format!("{}m", secs / 60)
  } else if secs < 86_400 {
    format!("{}h", secs / 3600)
  } else {
    format!("{}d", secs / 86_400)
  }
}

// ===========================================================================
// ux-test await
// ===========================================================================

/// Arguments for awaiting a session.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct AwaitSessionArgs {
  /// Session ID or path to session directory.
  session: String,

  /// Timeout in seconds (default: the session's own spec timeout, else 300).
  timeout: Option<u64>,
}

/// Wait for a UX test session to complete.
#[tento_sh::command(name = "await", description = "Wait for a UX test session to complete")]
pub async fn await_session(ctx: UxTestCtx, args: Option<AwaitSessionArgs>) -> tento_sh::Result<()> {
  let args = args.context("Arguments required")?;
  let logger = ctx.logger();

  // A flat 300s default was wrong for most of the corpus — 25 of 46 tracked
  // specs declare longer, up to 3600 — so a bare `await` abandoned the wait
  // while the test was still legitimately running, and the operator read the
  // timeout as a failure of the test rather than of the waiter. Prefer the
  // session's own declared timeout; 300 stays the floor for ephemeral sessions
  // that have no spec. An explicit `--timeout` still wins.
  let timeout_secs = args
    .timeout
    .or_else(|| logger.spec_timeout(&args.session))
    .unwrap_or(300);
  info!(
    "Waiting for session {} to complete (timeout: {}s)...",
    args.session, timeout_secs
  );

  let completion =
    await_session_completion(&logger, ctx.port(), &args.session, timeout_secs).await?;

  info!(
    "Session completed: {} ({} log entries)",
    orchestration::result_label(&completion.completion),
    completion.logs.len()
  );

  // Print result, feedback, and logs as JSON
  let output = serde_json::json!({
    "result": orchestration::result_str(&completion.completion),
    "feedback": completion.completion.as_ref().and_then(|c| c.feedback.as_ref()),
    "logs": completion.logs,
  });
  println!(
    "{}",
    serde_json::to_string_pretty(&output).context("Failed to serialize output")?
  );

  Ok(())
}

/// Arguments for finishing a session created with `run --no-wait`.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct FinalizeSessionArgs {
  /// Session ID or path to session directory.
  session: String,

  /// Timeout in seconds (default: the session's snapshotted spec timeout).
  timeout: Option<u64>,

  /// How the browser was driven: `agent` or `human`. Defaults from terminal use.
  by: Option<String>,
}

/// Finish the phases deliberately deferred by `run --no-wait`.
///
/// `await` is an observer: it prints completion but must not mutate the run.
/// `finalize` is the lifecycle owner for an externally-driven browser session:
/// wait, snapshot, teardown, verify, and append the tracked ledger exactly once.
#[tento_sh::command(
  name = "finalize",
  description = "Finish a --no-wait session: snapshot, teardown, verify, and record"
)]
pub async fn finalize_session(
  ctx: UxTestCtx,
  args: Option<FinalizeSessionArgs>,
) -> tento_sh::Result<()> {
  let args = args.context("Arguments required")?;
  let logger = ctx.logger();
  let session = logger.get_session(&args.session)?;
  let spec = logger
    .read_spec(&args.session)?
    .context("session has no spec.yaml, so teardown and verification are unknowable")?;
  let session_dir = logger.session_dir(&args.session)?;
  let driver = infer_driver(args.by.as_deref())?;
  if driver == Driver::Cli {
    return Err(
      anyhow::anyhow!(
        "finalize closes an externally-driven browser session; --by must be agent or human"
      )
      .into(),
    );
  }

  // A final `verification.json` is written only after teardown and
  // verification. Its presence makes retries safe: do not delete the user twice
  // or append a second ledger row for the same browser run. A checked-in test is
  // not fully finalized until its ledger also contains this run, though —
  // surface that interrupted boundary instead of silently accepting it. The
  // server's provisional completion audit is not a finalize: adopt the run.
  if has_final_verification(&session_dir) {
    return match ledger_contains_run(&logger, &spec.id, &args.session)? {
      Some(true) | None => {
        info!("Session {} is already finalized", args.session);
        Ok(())
      }
      Some(false) => Err(
        anyhow::anyhow!(
          "session {} was verified but is missing from the `{}` ledger; recover with `ux-test log \
         --test {} --run {} --verdict <pass|fail> --by {}`",
          args.session,
          spec.id,
          spec.id,
          args.session,
          driver.label()
        )
        .into(),
      ),
    };
  }

  let target_origin = session_target_origin(&session, &spec)?;
  let tracing_uuid = session
    .tracing_uuid
    .context("session has no tracingUuid, so its unified trace cannot be snapshotted")?;

  let timeout_secs = args.timeout.unwrap_or(spec.timeout);
  info!(
    "Finalizing session {} (timeout: {}s)...",
    args.session, timeout_secs
  );
  let completion =
    await_session_completion(&logger, ctx.port(), &args.session, timeout_secs).await?;

  finalize_completed_run(
    &ctx,
    &logger,
    &args.session,
    &spec,
    tracing_uuid,
    target_origin,
    completion,
    FinalizeMode {
      auto: false,
      steps_executed: true,
      driver,
      // `finalize` adopts a session it did not start, and nothing in the session
      // record names an environment — so this says "unknown" rather than
      // asserting the built-in.
      env: None,
      human: Human::STDOUT,
      artifact: None,
    },
  )
  .await?;

  if matches!(
    ledger_contains_run(&logger, &spec.id, &args.session)?,
    Some(false)
  ) {
    return Err(
      anyhow::anyhow!(
        "session {} finished verification but could not be recorded in the `{}` ledger; recover \
       with `ux-test log --test {} --run {} --verdict <pass|fail> --by {}`",
        args.session,
        spec.id,
        spec.id,
        args.session,
        driver.label()
      )
      .into(),
    );
  }
  Ok(())
}

// ===========================================================================
// ux-test logs
// ===========================================================================

/// Arguments for reading session logs.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct ReadLogsArgs {
  /// Session ID or path to session directory.
  session: String,
}

/// Read logs from a UX test session (JSON format).
#[tento_sh::command(name = "logs", description = "Read logs from a UX test session (JSON)")]
pub async fn read_logs(ctx: UxTestCtx, args: Option<ReadLogsArgs>) -> tento_sh::Result<()> {
  let args = args.context("Arguments required")?;
  let logger = ctx.logger();

  let entries = logger.read_logs_ljson(&args.session)?;

  let json = serde_json::to_string_pretty(&entries).context("Failed to serialize entries")?;
  println!("{}", json);

  Ok(())
}

// ===========================================================================
// ux-test render
// ===========================================================================

/// Arguments for rendering session logs.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct RenderLogsArgs {
  /// Session ID or path to session directory.
  session: String,
  /// Comma-separated visible column list, in render order
  /// (e.g. `ts,level,origin`). Empty / unset = all known columns.
  columns: Option<String>,
  /// Comma-separated columns to hide (e.g. `ip,user`). Wins over `--columns`.
  hide: Option<String>,
}

/// Render UX test session logs to terminal.
#[tento_sh::command(
  name = "render",
  description = "Render UX test session logs to terminal"
)]
pub async fn render_logs(ctx: UxTestCtx, args: Option<RenderLogsArgs>) -> tento_sh::Result<()> {
  let args = args.context("Arguments required")?;
  let logger = ctx.logger();

  let entries = logger.read_logs_ljson(&args.session)?;

  if entries.is_empty() {
    info!("No logs found for session: {}", args.session);
    return Ok(());
  }

  info!(
    "Rendering {} entries for session: {}\n",
    entries.len(),
    args.session
  );

  let viz = crate::render::ux_trace_columns(args.columns.as_deref(), args.hide.as_deref());
  print!("{}", crate::render::render_unified(&entries, &viz));

  Ok(())
}

// ===========================================================================
// ux-test trace
// ===========================================================================

/// Arguments for the trace command.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct TraceSessionArgs {
  /// Session ID to render grafted trace for.
  session: String,
  /// Comma-separated visible column list, in render order
  /// (e.g. `ts,level,origin`). Empty / unset = all known columns.
  columns: Option<String>,
  /// Comma-separated columns to hide (e.g. `ip,user`). Wins over `--columns`.
  hide: Option<String>,
}

/// Render a grafted client+server trace for a UX test session.
///
/// Materializes the unified trace from the client `logs.ljson` + this session's
/// server entries pulled from the local loaf span bucket, then renders the
/// grafted tree via `render_unified`.
#[tento_sh::command(
  name = "trace",
  description = "Render grafted client+server trace for a UX test session"
)]
pub async fn trace_session(ctx: UxTestCtx, args: Option<TraceSessionArgs>) -> tento_sh::Result<()> {
  let args = args.context("Arguments required")?;
  let logger = ctx.logger();

  let session = logger.get_session(&args.session)?;
  let tracing_uuid = session
    .tracing_uuid
    .context("Session has no tracing UUID (created before tracing integration)")?;

  info!(
    "Loading trace for session {} (tracing UUID: {})",
    args.session, tracing_uuid
  );

  // Materialize fresh (client logs.ljson + server span bucket); fall back to
  // any existing trace.ljson when the bucket has no matching rows.
  orchestration::materialize_trace(&logger, &args.session, tracing_uuid)?;
  let mut entries = logger.read_trace_ljson(&args.session)?;

  if entries.is_empty() {
    info!("No trace entries found for tracing UUID: {}", tracing_uuid);
    return Ok(());
  }

  entries.sort_by_key(|e| e.ts);

  info!(
    "Rendering {} entries ({} client, {} server)\n",
    entries.len(),
    entries.iter().filter(|e| e.is_client()).count(),
    entries.iter().filter(|e| !e.is_client()).count(),
  );

  let viz = crate::render::ux_trace_columns(args.columns.as_deref(), args.hide.as_deref());
  print!("{}", crate::render::render_unified(&entries, &viz));

  Ok(())
}

// ===========================================================================
// ux-test view
// ===========================================================================

/// Arguments for the view command.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct ViewSessionArgs {
  /// Session ID or path to session directory.
  session: String,

  /// Live mode: tail the client `logs.ljson` + a point-in-time server bucket
  /// snapshot scoped to this session.
  #[serde(default)]
  follow: bool,

  /// Comma-separated visible column list, in render order
  /// (e.g. `ts,level,origin`). Empty / unset = all known columns.
  columns: Option<String>,
  /// Comma-separated columns to hide (e.g. `ip,user`). Wins over `--columns`.
  /// Trace default (no flags): hides `ip` and `user` since they're usually
  /// blank for client-heavy UX-test traces.
  hide: Option<String>,
}

/// Open a session's unified client+server trace in the interactive TUI.
///
/// Thin delegator: the server side is materialized from the local loaf span
/// bucket into an ljson file, then the **generic** `tento-tui` runner renders
/// it — `tento-tui` is product-less, so the view is just a scene + a `--config`
/// path binding, not a bespoke renderer.
///
/// - default: a unified `trace.ljson` (client `logs.ljson` + this session's
///   server bucket entries) via the `unified-trace` preset.
/// - `--follow`: the live client `logs.ljson` (tails) + a `server.ljson`
///   materialized from buckets (point-in-time; re-run to refresh the server side).
/// Resolve the best-available *snapshot* trace file for a session: a fresh
/// unified `trace.ljson` (client logs + server bucket rows) when materializable,
/// an existing `trace.ljson`, else the client-only `logs.ljson`. Shared by
/// the interactive (`--scene`/`--config`) and inline-render paths of `view`.
fn resolve_snapshot_trace(
  logger: &LLMLogger,
  session: &str,
  session_dir: &Path,
  tracing_uuid: Option<Uuid>,
) -> tento_sh::Result<PathBuf> {
  let trace = session_dir.join("trace.ljson");
  // A 0-byte `trace.ljson` stub (the orchestrator can create one on session
  // start before any data is written) is functionally "no trace yet" — treat
  // it like a missing file so we re-materialize from buckets (or fall back to
  // client-only logs) instead of rendering nothing.
  let has_content = trace.metadata().map(|m| m.len() > 0).unwrap_or(false);
  let path = if has_content {
    trace
  } else if let Some(uuid) = tracing_uuid {
    orchestration::materialize_trace(logger, session, uuid)?
  } else {
    let logs = session_dir.join("logs.ljson");
    if !logs.exists() {
      return Err(
        anyhow::anyhow!(
          "No trace data for session '{}' yet (run the test first)",
          session
        )
        .into(),
      );
    }
    // `println!` (not `info!`): an info event nested under the `shell.exec`
    // span isn't rendered (body: None), so any user-facing fallback notice
    // must go through stdout — TurnCapture promotes captured stdout into a
    // standalone `kind = "stdout"` event that the TracePane displays.
    println!("No tracing UUID; showing client-only logs.ljson (no server graft).");
    logs
  };
  Ok(path)
}

/// Render a session's grafted trace to stdout as text — the fallback when no
/// interactive terminal is available to host the fullscreen `tento-tui`.
///
/// Uses `print!` / `println!` (not `info!`): when invoked inside another TUI
/// (e.g. `tento-sh-tui`'s captured shell.exec turn), tracing events emitted
/// during the turn become children of a `BodyShape::None` shell.exec span and
/// don't render. Stdout is captured by `TurnCapture` and re-emitted as a
/// standalone `kind = "stdout"` event after the span closes, which the
/// TracePane *does* render.
fn render_trace_inline(
  path: &Path,
  session: &str,
  viz: &crate::render::ColumnVisibility,
) -> tento_sh::Result<()> {
  let mut entries = orchestration::read_ljson_file(path)?;
  entries.sort_by_key(|e| e.ts);
  if entries.is_empty() {
    println!("No trace entries to render for session {session}");
  } else {
    print!("{}", crate::render::render_unified(&entries, viz));
  }
  Ok(())
}

#[tento_sh::command(
  name = "view",
  description = "Open a session's unified client+server trace in the interactive TUI"
)]
pub async fn view(ctx: UxTestCtx, args: Option<ViewSessionArgs>) -> tento_sh::Result<()> {
  let args = args.context("Arguments required")?;
  let logger = ctx.logger();
  let session_dir = logger.session_dir(&args.session)?;
  let tracing_uuid = logger.get_session(&args.session)?.tracing_uuid;

  // A fullscreen child TUI must own the terminal. When stdout isn't a TTY —
  // piped, or running *inside* another TUI like `tento-sh` that redirects
  // fd 1 to a capture pipe — we can't hand it the screen: the child's
  // terminal setup fails (ENXIO) or fights the parent for the display. Render
  // the trace inline instead, which still surfaces in the parent's trace pane.
  if !std::io::stdout().is_terminal() {
    if args.follow {
      // `println!` (not `info!`): see the rationale on `render_trace_inline`.
      println!(
        "--follow needs an interactive terminal; rendering a point-in-time snapshot inline."
      );
    }
    let path = resolve_snapshot_trace(&logger, &args.session, &session_dir, tracing_uuid)?;
    let viz = crate::render::ux_trace_columns(args.columns.as_deref(), args.hide.as_deref());
    return render_trace_inline(&path, &args.session, &viz);
  }

  // The viewer is `tsh <scene.tsh>` — write the session's scene file and hand it
  // the path. The scene authoring (against the `unified-trace` preset) lives in
  // `crate::render`.
  let scene_src = if args.follow {
    // Live: client logs.ljson (tails) + server.ljson materialized from buckets.
    let tracing = tracing_uuid.ok_or_else(|| {
      anyhow::anyhow!(
        "session '{}' has no tracing UUID (created before tracing integration)",
        args.session
      )
    })?;
    let client = session_dir.join("logs.ljson");
    let server = orchestration::materialize_server_ljson(&logger, &args.session, tracing)?;
    crate::render::unified_trace_scene_follow(&client, &server)
  } else {
    // Snapshot: reuse an existing trace.ljson, else materialize a fresh unified
    // one (client logs.ljson + server bucket rows), else client-only logs.ljson.
    let path = resolve_snapshot_trace(&logger, &args.session, &session_dir, tracing_uuid)?;
    crate::render::unified_trace_scene_snapshot(&path)
  };
  let scene_path = session_dir.join("view.tsh");
  std::fs::write(&scene_path, &scene_src).context("Failed to write the session's view.tsh")?;

  info!(
    "Opening trace for session {}:\n  tsh {}",
    args.session,
    scene_path.display()
  );

  // Launch the scene shell. Find `tsh` next to this executable (same workspace
  // target dir); if absent, the printed invocation above is runnable.
  let tsh_bin = std::env::current_exe()
    .ok()
    .and_then(|p| p.parent().map(|d| d.join("tsh")))
    .filter(|p| p.exists());
  let Some(bin) = tsh_bin else {
    info!("`tsh` binary not found next to this executable — run the command above.");
    return Ok(());
  };
  let status = std::process::Command::new(bin)
    .arg(&scene_path)
    .status()
    .context("Failed to launch tsh")?;
  if !status.success() {
    return Err(anyhow::anyhow!("tsh exited with {status}").into());
  }
  Ok(())
}

// ===========================================================================
// ux-test monitor
// ===========================================================================

/// Arguments for the monitor command.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct MonitorSessionArgs {
  /// Session ID to monitor.
  session: String,

  /// Path to server logs (default: __logs/loaf.log). CLI: `--server-log`.
  // (No serde rename: the arg parser normalizes `--server-log` → `server_log`.)
  server_log: Option<String>,
}

/// Monitor a UX test session with real-time log validation.
#[tento_sh::command(
  name = "monitor",
  description = "Monitor a UX test session with real-time log validation"
)]
pub async fn monitor_session(
  ctx: UxTestCtx,
  args: Option<MonitorSessionArgs>,
) -> tento_sh::Result<()> {
  let args = args.context("Arguments required")?;
  let logger = ctx.logger();

  let server_log_path = PathBuf::from(args.server_log.as_deref().unwrap_or("__logs/loaf.log"));

  run_monitor(&logger, &args.session, &server_log_path).await?;

  Ok(())
}

// ===========================================================================
// ux-test delete
// ===========================================================================

/// Arguments for deleting a session.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct DeleteSessionArgs {
  /// Session ID or path to session directory.
  session: String,
}

/// Delete a UX test session.
#[tento_sh::command(name = "delete", description = "Delete a UX test session")]
pub async fn delete_session(
  ctx: UxTestCtx,
  args: Option<DeleteSessionArgs>,
) -> tento_sh::Result<()> {
  let args = args.context("Arguments required")?;
  let logger = ctx.logger();

  logger.delete_session(&args.session)?;
  info!("Deleted session: {}", args.session);

  Ok(())
}

// ===========================================================================
// ux-test run
// ===========================================================================

/// Arguments for the unified ux-test run command.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct UxTestRunArgs {
  /// Run a checked-in test by id — loads `.ux-tests/<test>/spec.yaml`. The
  /// per-test alternative to `--file`.
  test: Option<String>,

  /// Path to a .user-test.yaml file.
  file: Option<String>,

  /// Batch-run every test in this group (top-level group dir; `-` = ungrouped,
  /// `.scratch` = the throwaway zone). With `--auto`, only auto-runnable specs
  /// run and the run is CI-shaped (non-zero exit if any fail).
  group: Option<String>,

  /// Batch-run the whole tracked corpus (every group + ungrouped, never
  /// `.scratch`). With `--auto` this is the CI command. CLI: `--all`.
  #[serde(default)]
  all: bool,

  /// Short name for ephemeral tests (used when --file is not provided).
  name: Option<String>,

  /// Instructions as a JSON array of strings, e.g.
  /// `--instructions '["Click Save", "Verify the toast appears"]'` (used when
  /// `--file` is not provided). Parsed natively as an array by the arg layer —
  /// no leading-space / quoted-scalar workaround needed.
  instructions: Option<Vec<String>>,

  /// Prefix shown in the UI toast title. CLI: `--testing-prefix`.
  // (No serde rename: the arg parser normalizes `--testing-prefix` → `testing_prefix`.)
  testing_prefix: Option<String>,

  /// Timeout in seconds (default: 300).
  timeout: Option<u64>,

  /// Base URL pattern (e.g. "lona.so", "lona.so/calendar"), resolved against the
  /// running server host by the host's `resolve_session_target` (e.g. "dev" +
  /// "lona.so/calendar" → "dev.lona.so/calendar"). Absent ⇒ the pattern the host
  /// derives from the spec, and finally the host's own default origin.
  url: Option<String>,

  /// Parameter overrides as JSON object (e.g., '{"user_email": "test@example.com"}').
  #[serde(rename = "params")]
  param_overrides: Option<String>,

  /// Mark as flaky test with context about what's being debugged.
  flaky: Option<String>,

  /// Don't wait for session completion (just create and print URL). Finish later
  /// with `ux-test finalize --session <id>`. CLI: `--no-wait`.
  // The arg parser normalizes `--no-wait` → `no_wait`, so the field name (not a
  // kebab serde rename) is what must match — a `rename = "no-wait"` silently breaks it.
  #[serde(default)]
  no_wait: bool,

  /// Drive the test headless via the Deno `lona-ux-runner` instead of waiting for
  /// an operator. Requires an auto-runnable spec (every step has `actions` and a
  /// `verification` block). Additive — absent ⇒ today's manual flow. CLI: `--auto`.
  #[serde(default)]
  auto: bool,

  /// User the headless browser authenticates as (mints a short-lived API key,
  /// mirroring the screenshot harness). Absent ⇒ the spec's declared
  /// `params.user_email`, then the host's default account.
  user: Option<String>,

  /// Named environment profile(s) from `<.ux-tests>/.envs/<name>.yaml` — which
  /// server this run actually measures (resolver, port, TLS, host slug). Absent
  /// ⇒ the built-in `local` profile: the loopback map + the host's dev port,
  /// byte-identical to the behaviour before profiles existed.
  ///
  /// A comma-separated list runs the SAME selection once per profile, in the
  /// order given — `--env dev,rc,prod --all --auto` is the whole corpus against
  /// every environment, and each run's ledger entry names the origin it drove,
  /// which is how the board's per-environment columns fill. Every name is
  /// resolved before anything runs, so a typo fails the command, not the third
  /// environment of forty tests. CLI: `--env`.
  env: Option<String>,

  /// Replay a recorded session's device-local environment before the spec's
  /// own actions: reads the latest `env/manifest` breadcrumb from that
  /// session's trail and plants its debug flags + `lona-layout-memory` blob
  /// into localStorage (then reloads) and matches its viewport. Makes
  /// "operator clicked Broken" -> "headless boots as their device" one flag —
  /// a fresh profile is a different program when `debug-flag:*` state gates
  /// code paths (the 2026-08-06 header hunt). CLI: `--env-from <sessionId>`.
  ///
  /// Device state, not the network profile: [`env`](Self::env) picks WHICH
  /// server a run measures; this picks WHAT the browser looks like when it
  /// gets there. The two compose.
  env_from: Option<String>,

  /// Print the run as a `ux-test.run-report/v1` JSON document on stdout. The
  /// human output this command normally prints moves to stderr. Note the Deno
  /// runner's own output under `--auto` still inherits stdout — a pipeline
  /// that parses the document should use `--json-out`. CLI: `--json`.
  #[serde(default)]
  json: bool,

  /// Write the same `ux-test.run-report/v1` document to this path (atomically,
  /// on every exit path after argument parsing) while stdout stays exactly the
  /// human output. The form a pipeline uses. CLI: `--json-out <path>`.
  json_out: Option<String>,

  /// The product of the built artifact this run measures — stamped on every
  /// ledger entry and report spec. With `--artifact-version` and
  /// `--artifact-sha`, all three required together. Absent ⇒ the
  /// `TENTO_UX_ARTIFACT` env var (a JSON object), else no stamp.
  /// CLI: `--artifact-product`.
  artifact_product: Option<String>,
  /// The artifact's version string. CLI: `--artifact-version`.
  artifact_version: Option<String>,
  /// The commit the artifact was built from. CLI: `--artifact-sha`.
  artifact_sha: Option<String>,
  /// The artifact's channel file stem. CLI: `--artifact-stem`.
  artifact_stem: Option<String>,
  /// A content fingerprint of the artifact. CLI: `--artifact-fingerprint`.
  artifact_fingerprint: Option<String>,
}

/// The `--artifact-*` flags, shared by `run` and `log`.
struct ArtifactFlags<'a> {
  product: Option<&'a str>,
  version: Option<&'a str>,
  sha: Option<&'a str>,
  stem: Option<&'a str>,
  fingerprint: Option<&'a str>,
}

impl ArtifactFlags<'_> {
  fn any(&self) -> bool {
    [
      self.product,
      self.version,
      self.sha,
      self.stem,
      self.fingerprint,
    ]
    .iter()
    .any(Option::is_some)
  }
}

/// Resolve the artifact a run measured: the `--artifact-*` flags when any is
/// given (then product, version and sha are all required), else the
/// `TENTO_UX_ARTIFACT` JSON, else none. A malformed stamp is an error, never a
/// silent "no artifact": someone meant to stamp these results, and recording
/// them unstamped would file a candidate's passes under nobody.
fn resolve_artifact(
  flags: &ArtifactFlags<'_>,
  env: Option<String>,
) -> anyhow::Result<Option<ArtifactIdentity>> {
  let artifact = if flags.any() {
    let need = |value: Option<&str>, flag: &str| {
      value
        .map(str::to_string)
        .with_context(|| format!("--{flag} is required when any --artifact-* flag is given"))
    };
    ArtifactIdentity {
      product: need(flags.product, "artifact-product")?,
      version: need(flags.version, "artifact-version")?,
      git_hash: need(flags.sha, "artifact-sha")?,
      fingerprint: flags.fingerprint.map(str::to_string),
      stem: flags.stem.map(str::to_string),
    }
  } else {
    let Some(raw) = env.filter(|raw| !raw.trim().is_empty()) else {
      return Ok(None);
    };
    serde_json::from_str::<ArtifactIdentity>(&raw).with_context(|| {
      format!(
        "{ARTIFACT_ENV} must be a JSON object {{product, version, gitHash, stem?, fingerprint?}}"
      )
    })?
  };
  artifact.validate()?;
  Ok(Some(artifact))
}

/// Where the human output of a run goes: stdout, or stderr when `--json` has
/// claimed stdout for the report. `Copy`, so it rides every call below.
#[derive(Clone, Copy, Debug)]
struct Human {
  to_stderr: bool,
}

impl Human {
  const STDOUT: Human = Human { to_stderr: false };

  fn line(self, text: impl std::fmt::Display) {
    if self.to_stderr {
      eprintln!("{text}");
    } else {
      println!("{text}");
    }
  }
}

/// What every spec of one `run` invocation shares.
struct RunCtx {
  human: Human,
  artifact: Option<ArtifactIdentity>,
}

/// Which selection mode a `run` invocation is, for the report.
fn selection_of(args: &UxTestRunArgs) -> Selection {
  let (kind, name) = if args.all || args.group.is_some() {
    match &args.group {
      Some(group) => (SelectionKind::Group, Some(group.clone())),
      None => (SelectionKind::All, None),
    }
  } else if let Some(test) = &args.test {
    (SelectionKind::Test, Some(test.clone()))
  } else if let Some(file) = &args.file {
    (SelectionKind::File, Some(file.clone()))
  } else {
    (SelectionKind::Ephemeral, args.name.clone())
  };
  Selection { kind, name }
}

/// Which account the headless browser drives, and where that came from:
/// `--user` › the spec's `params.user_email` › the host's default account.
fn resolve_user(
  flag: Option<&str>,
  declared: Option<&str>,
  host_default: impl FnOnce() -> Option<String>,
) -> Option<(String, UserSource)> {
  flag
    .map(|u| (u.to_string(), UserSource::Flag))
    .or_else(|| declared.map(|u| (u.to_string(), UserSource::Spec)))
    .or_else(|| host_default().map(|u| (u, UserSource::HostDefault)))
}

/// Write the report to `path` via a sibling temp file and a rename, so a reader
/// polling the path never sees half a document.
fn write_report(path: &Path, document: &RunReport) -> anyhow::Result<()> {
  let mut body = serde_json::to_string_pretty(document).context("serialise the run report")?;
  body.push('\n');
  if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
    std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
  }
  let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
  std::fs::write(&tmp, body).with_context(|| format!("write {}", tmp.display()))?;
  std::fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
  Ok(())
}

/// Split `--env` into the profile names it asks for, in order.
///
/// `None` and the empty string both mean "the built-in local profile, once" —
/// represented as a single `None` so the caller resolves it exactly the way it
/// always has. Blank items (`dev,,rc`, trailing commas) and repeats are dropped
/// rather than rejected: the author's intent is unambiguous, and a batch that
/// ran rc twice would double every ledger for nothing.
fn env_names(arg: Option<&str>) -> Vec<Option<String>> {
  let mut names: Vec<Option<String>> = Vec::new();
  for raw in arg.unwrap_or_default().split(',') {
    let name = raw.trim();
    if name.is_empty() {
      continue;
    }
    if !names.iter().any(|n| n.as_deref() == Some(name)) {
      names.push(Some(name.to_string()));
    }
  }
  if names.is_empty() {
    names.push(None);
  }
  names
}

/// Run a UX test session.
///
/// Unified entry point for running UX tests. Accepts either `--file` to run a
/// persisted test from YAML, or `--name` + `--instructions` for an ephemeral test.
#[tento_sh::command(
  name = "run",
  description = "Run a UX test (ephemeral or from YAML file)"
)]
pub async fn run(ctx: UxTestCtx, args: Option<UxTestRunArgs>) -> tento_sh::Result<()> {
  let args = args.context("Arguments required")?;
  let human = Human {
    to_stderr: args.json,
  };
  let mut document = RunReport::new(Utc::now(), RunnerIdentity::local());

  let result = run_reported(&ctx, &args, human, &mut document).await;

  // The report is written on every exit path after the arguments parsed — a
  // pipeline reading it must be able to tell "red" from "never started", and a
  // missing file says neither.
  document.ended_at = Utc::now();
  document.exit_code = if result.is_ok() { 0 } else { 1 };
  if document.error.is_none() && document.profiles.is_empty() {
    document.error = result.as_ref().err().map(|e| format!("{e:#}"));
  }
  let mut result = result;
  if let Some(path) = args.json_out.as_deref()
    && let Err(e) = write_report(Path::new(path), &document)
  {
    // A pipeline that asked for the file and did not get it must not read a
    // green exit as success.
    eprintln!("error: could not write the run report: {e:#}");
    if result.is_ok() {
      result = Err(e.into());
    }
  }
  if args.json {
    println!(
      "{}",
      serde_json::to_string_pretty(&document).context("serialise the run report")?
    );
  }
  result
}

/// The `run` command's body, filling `report` as it goes.
async fn run_reported(
  ctx: &UxTestCtx,
  args: &UxTestRunArgs,
  human: Human,
  document: &mut RunReport,
) -> tento_sh::Result<()> {
  let artifact = resolve_artifact(
    &ArtifactFlags {
      product: args.artifact_product.as_deref(),
      version: args.artifact_version.as_deref(),
      sha: args.artifact_sha.as_deref(),
      stem: args.artifact_stem.as_deref(),
      fingerprint: args.artifact_fingerprint.as_deref(),
    },
    std::env::var(ARTIFACT_ENV).ok(),
  )
  .inspect_err(|e| document.error = Some(format!("{e:#}")))?;
  document.artifact = artifact.clone();
  let rc = RunCtx { human, artifact };

  // Resolve EVERY `--env` name ONCE, before any selection or side effect: a
  // typo'd profile must fail the command outright, not fail forty tests one at
  // a time, and a batch must not be able to drive half its specs at one
  // environment — nor two of its three environments and silently skip the third.
  let corpus_root = ctx.env().ux_tests_dir();
  let profiles = env_names(args.env.as_deref())
    .into_iter()
    .map(|name| EnvProfile::resolve(corpus_root.as_deref(), name.as_deref()))
    .collect::<Result<Vec<_>, _>>()
    .inspect_err(|e| document.error = Some(format!("{e:#}")))?;

  // One profile is exactly the command it always was. Several are that command
  // repeated per environment, with two rules a loop would otherwise get wrong:
  // a red environment must not stop the next one from running (the report is
  // "how does each stand", and an rc failure says nothing about prod), and the
  // exit status still has to be red if ANY of them was — so the errors are held
  // and the first is returned after the last environment finishes.
  let mut errors: Vec<(String, tento_sh::Error)> = Vec::new();
  let total = profiles.len();
  for (index, profile) in profiles.iter().enumerate() {
    if total > 1 {
      info!("═══ env {} ({}/{total}) ═══", profile.name, index + 1);
    }
    let mut profile_report = ProfileReport::new(profile.name.clone(), selection_of(args));
    let result = run_with_profile(ctx, args.clone(), profile, &rc, &mut profile_report).await;
    profile_report.settle(result.as_ref().err().map(|e| format!("{e:#}")));
    document.profiles.push(profile_report);
    if let Err(error) = result {
      if total > 1 {
        info!("  env {}: {:#}", profile.name, error);
      }
      errors.push((profile.name.clone(), error));
    }
  }
  if total > 1 {
    human.line(format!(
      "\n=== environments: {} green / {} red of {total} ({}) ===",
      total - errors.len(),
      errors.len(),
      profiles
        .iter()
        .map(|p| p.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
    ));
    for (name, error) in &errors {
      human.line(format!("  [red] {name} — {error:#}"));
    }
  }
  match errors.into_iter().next() {
    Some((name, error)) if total > 1 => Err(anyhow::anyhow!("env {name} failed: {error:#}").into()),
    Some((_, error)) => Err(error),
    None => Ok(()),
  }
}

/// The `run` command's body for ONE resolved profile — the selection modes and
/// their exit semantics, exactly as they were before `--env` took a list.
async fn run_with_profile(
  ctx: &UxTestCtx,
  args: UxTestRunArgs,
  profile: &EnvProfile,
  rc: &RunCtx,
  profile_out: &mut ProfileReport,
) -> tento_sh::Result<()> {
  // Batch modes over the corpus: `--all` (whole tracked corpus) or `--group <name>`
  // (one group / `.scratch`). With `--auto` this is the CI-shaped path.
  if args.all || args.group.is_some() {
    return run_corpus(ctx, args, profile, rc, profile_out).await;
  }

  // A directory `--file` runs every spec (`*.user-test.yaml` or `spec.yaml`) under
  // it (recursive) as a sequential suite — "running a folder runs all its tests".
  if let Some(file) = &args.file {
    if Path::new(file).is_dir() {
      return run_folder(ctx, PathBuf::from(file), args, profile, rc, profile_out).await;
    }
  }

  // One spec, reported as a batch of one.
  let (id, group) = match (&args.test, &args.file, &args.name) {
    (Some(test), _, _) => (test.clone(), test_group(ctx, test)),
    (None, Some(file), _) => (file.clone(), None),
    (None, None, name) => (name.clone().unwrap_or_default(), None),
  };
  let mut spec_report = SpecReport::new(id, group);
  let started = std::time::Instant::now();
  let result = run_single(ctx, args.clone(), profile, rc, &mut spec_report).await;
  spec_report.duration_ms = Some(elapsed_ms(started));
  match &result {
    Ok(outcome) => outcome.fill(&mut spec_report),
    Err(e) => {
      spec_report.outcome = SpecOutcome::Failed;
      spec_report.note = Some(format!("{e:#}"));
    }
  }
  profile_out.specs.push(spec_report);
  let outcome = result?;
  // A single `--auto` run is CI-shaped: a failed drive or verdict is a non-zero
  // exit. Manual runs always return Ok — a human read the result. An INCOMPLETE
  // run exits 0 for the same reason the batch tally does not count it against
  // the total: stopping at a step the spec itself declares manual is the
  // designed behaviour, not a failure to report upward.
  if args.auto && outcome.outcome == Outcome::Fail {
    // An agent-driven run says why in one line; it was never headless.
    if let Some(why) = &outcome.agent {
      return Err(anyhow::anyhow!("agent-driven run did not pass: {why}").into());
    }
    return Err(anyhow::anyhow!("headless run failed").into());
  }
  Ok(())
}

// ===========================================================================
// ux-test log
// ===========================================================================

/// Arguments for `ux-test log` — append one run to a test's tracked ledger.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct LogRunArgs {
  /// The test this run was of, as it appears in the corpus.
  test: Option<String>,

  /// What happened: `pass`, `fail`, `abandoned`, or `unfinished`.
  verdict: Option<String>,

  /// Why it is red. **Required on `fail`** — a red entry with no reason records
  /// only that something happened.
  note: Option<String>,

  /// Why the attempt could not proceed, as a short slug (`no-app-command`,
  /// `wrong-account`). Required on `abandoned` and `unfinished`.
  blocker: Option<String>,

  /// The run id, when this host has a `runs/<id>/` folder to point at. Minted
  /// in the same `<date>_<test>_<hex>` shape when it does not.
  run: Option<String>,

  /// How the run was driven: `cli`, `agent`, or `human`. Defaults to `human` on
  /// a terminal and `agent` without one.
  by: Option<String>,

  /// The absolute origin and path the run drove. Defaults to the spec's
  /// `params.server_url`, which is the only place the corpus records one.
  target: Option<String>,

  /// Where the evidence lives. Defaults to this machine's hostname.
  host: Option<String>,

  /// The env profile this run was driven under. Omit it when you do not know:
  /// an unrecorded environment reads as "unknown" downstream, which is true,
  /// whereas guessing `local` reads as a fact.
  env: Option<String>,

  /// When the run started, RFC 3339. Defaults to now.
  at: Option<String>,

  /// The assertion survived a full page load, not just an in-session read.
  /// Absent means nobody re-checked — which is different from re-checking and
  /// finding it gone. CLI: `--reload-verified`.
  #[serde(default)]
  reload_verified: bool,

  /// The built artifact the run measured — the same flags, env fallback
  /// (`TENTO_UX_ARTIFACT`) and rules as `ux-test run`. CLI: `--artifact-product`.
  artifact_product: Option<String>,
  /// CLI: `--artifact-version`.
  artifact_version: Option<String>,
  /// CLI: `--artifact-sha`.
  artifact_sha: Option<String>,
  /// CLI: `--artifact-stem`.
  artifact_stem: Option<String>,
  /// CLI: `--artifact-fingerprint`.
  artifact_fingerprint: Option<String>,
}

/// Record a run someone already drove.
///
/// `ux-test run` writes to the record only when it drove the session itself,
/// which leaves every run driven by a human or an agent through a browser —
/// currently all of the interesting ones — unrecordable. This is the verb that
/// closes that gap, and the ledger it appends to is **tracked**, so the answer
/// travels to checkouts that have never run anything.
///
/// It has to stay a one-liner. The 2026-08 sweeps did not skip the record out
/// of carelessness; there was simply no command to run, and a verb that costs
/// more than the run it describes will be skipped exactly the same way:
///
/// ```text
/// ux-test log --test event-flow-create --verdict pass --reload-verified
/// ux-test log --test event-flow-update --verdict fail --note "drag never persisted"
/// ```
#[tento_sh::command(
  name = "log",
  description = "Record a UX-test run someone drove by hand into the tracked ledger"
)]
pub async fn log_run(ctx: UxTestCtx, args: Option<LogRunArgs>) -> tento_sh::Result<()> {
  let args = args.context("Arguments required")?;
  let logger = ctx.logger();

  let test_id = args.test.context("--test is required")?;
  let verdict = parse_verdict(args.verdict.as_deref().context("--verdict is required")?)?;

  let folder = logger
    .runs()
    .tests_folder()
    .context("no .ux-tests root is configured on this host, so there is nowhere to record")?;
  let test = folder
    .test(&test_id)
    .map_err(|e| anyhow::anyhow!("read .ux-tests: {e}"))?
    .with_context(|| format!("no test `{test_id}` in the corpus"))?;

  let by = infer_driver(args.by.as_deref())?;

  // Everything this verb does NOT know is resolved by `Folder::record` — the
  // run id, the target, the host, the timestamp. This function deliberately
  // owns no defaults of its own; see that method for why.
  let mut draft = Draft::new(verdict, by);
  draft.run = args.run;
  draft.target = args.target;
  draft.host = args.host;
  draft.env = args.env;
  draft.at = match args.at.as_deref() {
    Some(raw) => Some(
      raw
        .parse::<chrono::DateTime<Utc>>()
        .with_context(|| format!("--at must be RFC 3339; got `{raw}`"))?,
    ),
    None => None,
  };
  // Absent, not `false`, when nobody re-checked: a reader must be able to tell
  // "not re-checked" from "re-checked and gone".
  draft.reload_verified = args.reload_verified.then_some(true);
  draft.note = args.note;
  draft.blocker = args.blocker;
  draft.artifact = resolve_artifact(
    &ArtifactFlags {
      product: args.artifact_product.as_deref(),
      version: args.artifact_version.as_deref(),
      sha: args.artifact_sha.as_deref(),
      stem: args.artifact_stem.as_deref(),
      fingerprint: args.artifact_fingerprint.as_deref(),
    },
    std::env::var(ARTIFACT_ENV).ok(),
  )?;

  let entry = test.record(draft)?;
  // A record with no `--run` names no session, and says so rather than printing
  // an id the reader could paste into a console that would find nothing.
  let session = entry
    .run
    .clone()
    .unwrap_or_else(|| "no session".to_string());
  info!(
    "recorded {} {} — {} by {} on {}",
    test_id,
    entry.verdict.label(),
    session,
    entry.by.label(),
    entry.host
  );
  println!(
    "{} {}  {}  ({} on {})",
    entry.verdict.label(),
    test_id,
    session,
    entry.by.label(),
    entry.host
  );
  println!("appended to {}", test.ledger_path().display());
  Ok(())
}

fn parse_verdict(raw: &str) -> tento_sh::Result<Verdict> {
  Ok(match raw.to_ascii_lowercase().as_str() {
    "pass" | "success" => Verdict::Pass,
    "fail" | "failure" => Verdict::Fail,
    "abandoned" | "skip" | "skipped" => Verdict::Abandoned,
    "unfinished" => Verdict::Unfinished,
    other => {
      return Err(
        anyhow::anyhow!(
          "unknown verdict `{other}` — one of pass, fail, abandoned, unfinished. `running` and \
           `never-run` are deliberately not verdicts: they are the absence of an outcome and the \
           absence of a run, and neither is something to append"
        )
        .into(),
      );
    }
  })
}

fn parse_driver(raw: &str) -> tento_sh::Result<Driver> {
  Ok(match raw.to_ascii_lowercase().as_str() {
    "cli" => Driver::Cli,
    "agent" => Driver::Agent,
    "human" | "operator" => Driver::Human,
    other => return Err(anyhow::anyhow!("unknown driver `{other}` — cli, agent, or human").into()),
  })
}

/// Infer who drove an externally-completed browser session.
///
/// A person at a terminal is a person; a non-interactive caller is an agent.
/// `cli` remains explicit because it means the deterministic runner drove the
/// behavior, not merely that a CLI wrote the record.
fn infer_driver(raw: Option<&str>) -> tento_sh::Result<Driver> {
  match raw {
    Some(raw) => parse_driver(raw),
    None if std::io::stdin().is_terminal() => Ok(Driver::Human),
    None => Ok(Driver::Agent),
  }
}

fn session_target_origin(session: &Session, spec: &TestSpec) -> tento_sh::Result<String> {
  session
    .metadata
    .as_ref()
    .and_then(|metadata| metadata.get("targetOrigin"))
    .and_then(serde_json::Value::as_str)
    .map(str::to_string)
    .or_else(|| spec.params.get("server_url").cloned())
    .context("session records no metadata.targetOrigin and its spec declares no params.server_url")
    .map_err(Into::into)
}

/// Whether a corpus test's ledger already names this session. `None` means the
/// run is ephemeral (or this host has no corpus), so there is no tracked ledger
/// to require.
fn ledger_contains_run(
  logger: &LLMLogger,
  test_id: &str,
  session_id: &str,
) -> anyhow::Result<Option<bool>> {
  let Some(folder) = logger.runs().tests_folder() else {
    return Ok(None);
  };
  let Some(test) = folder
    .test(test_id)
    .map_err(|e| anyhow::anyhow!("read .ux-tests: {e}"))?
  else {
    return Ok(None);
  };
  Ok(Some(
    test
      .ledger()?
      .iter()
      .any(|entry| entry.run.as_deref() == Some(session_id)),
  ))
}

/// Append a completed session to its test's tracked ledger, so `run`, `finalize`,
/// and `log` share one format and the `by` field honestly says who drove it.
///
/// Failing to record is reported, never fatal: a run that passed must not exit
/// non-zero because the record could not be written. Nothing here is silent,
/// though — an unrecorded run is exactly the gap this file exists to close.
///
/// Ephemeral (`--name`) runs have no corpus test and are skipped: they bucket
/// under `.scratch/`, which is gitignored, so there is no tracked ledger to
/// append to and nothing durable to say about them.
fn record_run(
  logger: &LLMLogger,
  test_id: &str,
  session_id: &str,
  target: String,
  driver: Driver,
  verdict: Verdict,
  note: Option<String>,
  blocker: Option<String>,
  env: Option<&str>,
  artifact: Option<&ArtifactIdentity>,
) {
  let recorded = (|| -> anyhow::Result<Option<PathBuf>> {
    let Some(folder) = logger.runs().tests_folder() else {
      return Ok(None); // flat mode: no corpus, nothing tracked
    };
    let Some(test) = folder
      .test(test_id)
      .map_err(|e| anyhow::anyhow!("read .ux-tests: {e}"))?
    else {
      return Ok(None); // ephemeral / not in the corpus
    };

    // A retry of `finalize` must not append the same browser run twice. The
    // run id is the durable identity shared by the session folder and ledger.
    if ledger_contains_run(logger, test_id, session_id)? == Some(true) {
      info!(
        "run {session_id} is already recorded in {}",
        test.ledger_path().display()
      );
      return Ok(Some(test.ledger_path()));
    }

    let mut draft = Draft::new(verdict, driver);
    // This one knows all four: it drove the run, so the id, the origin, the
    // host and the start time are facts rather than defaults.
    draft.run = Some(session_id.to_string());
    draft.target = Some(target);
    draft.host = Some(ledger::local_hostname());
    // The run drove this profile; it does not have to be inferred from the URL
    // afterwards. See `LedgerEntry::env`.
    draft.env = env.map(str::to_string);
    draft.artifact = artifact.cloned();
    draft.at = logger.get_session(session_id).map(|s| s.created_at).ok();
    // The CLI never re-checks through a full page load, so it has nothing to
    // claim here. Absent is the honest value; a `false` would read as
    // "re-checked and gone".
    draft.note = note;
    draft.blocker = blocker;
    draft.evidence = logger
      .session_dir(session_id)
      .ok()
      .and_then(|d| evidence_at(&d));
    test.record(draft)?;
    Ok(Some(test.ledger_path()))
  })();

  match recorded {
    Ok(Some(path)) => info!(
      "recorded {test_id} {} in {}",
      verdict.label(),
      path.display()
    ),
    Ok(None) => {}
    Err(e) => eprintln!("warning: run completed but was NOT recorded to the ledger: {e:#}"),
  }
}

/// A manifest of what this host holds for a run — counts and sizes, never the
/// bytes. Small enough to commit, which is the whole point: a reader elsewhere
/// gets "89 spans and 41KB of log on yuzuquats" instead of a blank pane.
fn evidence_at(run_dir: &Path) -> Option<crate::ledger::Evidence> {
  // No directory, no manifest. An `Evidence { shots: 0 }` over a path that does
  // not exist is a manifest of nothing that reads exactly like a manifest of an
  // empty run, and the console offers a tunnel for both.
  if !run_dir.is_dir() {
    return None;
  }
  let bytes = |name: &str| std::fs::metadata(run_dir.join(name)).ok().map(|m| m.len());
  Some(crate::ledger::Evidence {
    log: bytes("logs.ljson").map(|bytes| crate::ledger::LogEvidence {
      bytes,
      // Nothing on disk records a dropped batch today, so this claims only what
      // it can see. It is a field rather than an omission because a log CAN be
      // missing its middle — batches over actix's 32KB default were rejected
      // with a 400 while the run carried on.
      truncated: false,
    }),
    trace: std::fs::read_to_string(run_dir.join("trace.ljson"))
      .ok()
      .map(|raw| crate::ledger::TraceEvidence {
        spans: raw.lines().filter(|l| !l.trim().is_empty()).count(),
      }),
    server: bytes("server.ljson").map(|bytes| crate::ledger::ServerEvidence { bytes }),
    // The runner's own count, off `media.json`. Absent file, no frames — which
    // is every run before the capture sink existed, and it says 0 for them
    // exactly as it did when 0 was hardcoded.
    shots: std::fs::read_to_string(run_dir.join("media.json"))
      .ok()
      .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
      .and_then(|v| v.get("shots").and_then(|s| s.as_array()).map(Vec::len))
      .unwrap_or(0),
  })
}

/// `--env-from`: prepend environment-replay actions to the spec's first step,
/// built from the newest `env/manifest` breadcrumb in a recorded session's
/// trail (see `lib/core/app/env-manifest.ts`). The plant sets every enabled
/// `debug-flag:*` key and the `lona-layout-memory` blob byte-exact, reloads
/// (flags are read once at boot), and matches the recorded viewport. Fails
/// loudly when the session has no manifest — silently replaying nothing would
/// recreate the exact trap this exists to close (a fresh profile posing as
/// the operator's device).
fn apply_env_manifest(
  spec: &mut TestSpec,
  logger: &LLMLogger,
  session_id: &str,
) -> anyhow::Result<()> {
  let entries = logger.read_logs_ljson(session_id)?;
  // Prefer the newest manifest carrying actual device signal (flags or a
  // layout blob): a session's trail can also hold manifests from incidental
  // fresh contexts (a runner's verification load boots with empty storage),
  // and "what made this env special" is the flagged one. Fall back to the
  // newest manifest of any kind — an all-default env is a valid replay.
  let manifests: Vec<_> = entries
    .iter()
    .filter(|e| e.root_span.name == "env/manifest")
    .map(|e| &e.root_span.attributes)
    .collect();
  fn has_signal(a: &std::collections::HashMap<String, serde_json::Value>) -> bool {
    a.get("flags")
      .and_then(|v| v.as_array())
      .is_some_and(|f| !f.is_empty())
      || a.get("layoutMemory").is_some_and(|v| !v.is_null())
  }
  let manifest = manifests
    .iter()
    .rev()
    .find(|a| has_signal(a))
    .or_else(|| manifests.last())
    .map(|a| (**a).clone())
    .with_context(|| {
      format!(
        "session {session_id} has no env/manifest breadcrumb (the trail predates \
         the breadcrumb, or the tab never booted the calendar app)"
      )
    })?;

  let flags: Vec<String> = manifest
    .get("flags")
    .and_then(|v| v.as_array())
    .map(|a| {
      a.iter()
        .filter_map(|f| f.as_str().map(str::to_string))
        .collect()
    })
    .unwrap_or_default();
  let layout_memory = manifest.get("layoutMemory").and_then(|v| v.as_str());
  let width = manifest
    .get("iw")
    .and_then(|v| v.as_u64())
    .map(|w| w as u32);
  let height = manifest
    .get("ih")
    .and_then(|v| v.as_u64())
    .map(|h| h as u32);

  let plant_js = format!(
    "const flags = {};\n\
     for (const k of flags) localStorage.setItem(\"debug-flag:\" + k, \"true\");\n\
     const lm = {};\n\
     if (lm != null) localStorage.setItem(\"lona-layout-memory\", lm);\n\
     location.reload();",
    serde_json::to_string(&flags)?,
    serde_json::to_string(&layout_memory)?,
  );

  let mut prelude: Vec<ExecutableAction> = Vec::new();
  if let Some(width) = width {
    prelude.push(ExecutableAction::SetViewport { width, height });
  }
  // The app must have booted once before localStorage is writable at the app
  // origin; the plant then reloads so boot-time flag reads see the values.
  prelude.push(ExecutableAction::Wait { ms: 1200 });
  prelude.push(ExecutableAction::Evaluate { js: plant_js });
  prelude.push(ExecutableAction::Wait { ms: 1800 });

  let step = spec
    .steps
    .first_mut()
    .context("--env-from needs a spec with at least one step")?;
  let actions = step.actions.get_or_insert_with(Vec::new);
  prelude.append(actions);
  *actions = prelude;

  info!(
    "env-from {}: planted {} flag(s){}{}",
    session_id,
    flags.len(),
    if layout_memory.is_some() {
      " + layout-memory"
    } else {
      ""
    },
    width
      .map(|w| format!(
        ", viewport {w}x{}",
        height.map_or("?".to_string(), |h| h.to_string())
      ))
      .unwrap_or_default(),
  );
  Ok(())
}

/// How a finished run counts in a batch tally.
///
/// Three states rather than a boolean, because a run that drove its whole
/// automatable prefix and then stopped at a step its own spec declares manual
/// is neither. Nothing misbehaved — there is simply no machine that can do the
/// next step — so calling it a failure is a lie the tally then repeats: four
/// honest specs read `[FAIL]` in every `--all --auto` summary and pushed the
/// exit code non-zero over work nobody ever claimed was automatable. Calling it
/// a pass would be the worse lie, since the assertions never ran.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Outcome {
  /// Manual: operator clicked "works". Auto: steps drove + verification passed.
  /// `--no-wait`: the session was created, not judged, and counts as a pass.
  Pass,
  /// Drove the whole automatable prefix, then stopped at a declared-manual step.
  /// Verification never ran; nothing failed.
  Partial,
  /// A step failed, verification failed, or the run errored.
  Fail,
}

impl Outcome {
  /// Four-column label for the batch summary rows.
  fn label(self) -> &'static str {
    match self {
      Outcome::Pass => "PASS",
      Outcome::Partial => "PART",
      Outcome::Fail => "FAIL",
    }
  }
}

/// Outcome of a single test run — aggregated into the summary by `run_folder`.
struct RunOutcome {
  /// How this run counts in a batch tally.
  outcome: Outcome,
  /// Short label for the folder-run summary line.
  result: String,
  /// The note the ledger entry carries — the failure feedback on a red run.
  note: Option<String>,
  /// The ledger entry's blocker slug.
  blocker: Option<String>,
  /// The declared reason of the manual step a partial run stopped at.
  manual_reason: Option<String>,
  /// `Some(reason)` when an agent job drove the run (see [`crate::agent`]): a
  /// failure is then reported as the agent run's, never the headless runner's.
  agent: Option<String>,
}

impl RunOutcome {
  /// A bare outcome with nothing recorded beside it.
  fn bare(outcome: Outcome, result: String) -> Self {
    Self {
      outcome,
      result,
      note: None,
      blocker: None,
      manual_reason: None,
      agent: None,
    }
  }

  /// Copy what this outcome says into the spec's report.
  fn fill(&self, spec_out: &mut SpecReport) {
    spec_out.outcome = match self.outcome {
      Outcome::Pass => SpecOutcome::Passed,
      Outcome::Partial => SpecOutcome::Partial,
      Outcome::Fail => SpecOutcome::Failed,
    };
    spec_out.result = Some(self.result.clone());
    spec_out.note = self.note.clone();
    spec_out.blocker = self.blocker.clone();
    spec_out.manual_reason = self.manual_reason.clone();
  }
}

fn elapsed_ms(started: std::time::Instant) -> u64 {
  u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// The group a corpus test lives in, for the report. `None` when it is
/// ungrouped or this host has no corpus.
fn test_group(ctx: &UxTestCtx, test_id: &str) -> Option<String> {
  let folder = ctx.logger().runs().tests_folder()?;
  let mut entries = folder.tests().ok()?;
  entries.extend(folder.scratch_tests().unwrap_or_default());
  entries.into_iter().find(|e| e.id == test_id)?.group
}

/// Run one UX test (a single `--file` spec or an ephemeral `--name` spec) to
/// completion, returning its outcome. The `run` wrapper applies single-run exit
/// semantics; `run_folder` aggregates outcomes across a directory.
///
/// `report` is filled as facts become known — the run id, the session dir, the
/// origin, the account — so a run that errors after its session exists still
/// reports which session it was. The caller fills the outcome.
async fn run_single(
  ctx: &UxTestCtx,
  args: UxTestRunArgs,
  profile: &EnvProfile,
  rc: &RunCtx,
  spec_out: &mut SpecReport,
) -> tento_sh::Result<RunOutcome> {
  let logger = ctx.logger();
  spec_out.artifact = rc.artifact.clone();

  // Ephemeral = neither a checked-in test (`--test`) nor a spec file (`--file`).
  // Its runs are bucketed under `.scratch/` so they never show up as tests.
  let is_ephemeral = args.test.is_none() && args.file.is_none();

  // Build the test spec from --test (the corpus), --file (a path), or CLI args.
  let mut spec = if let Some(test_id) = &args.test {
    let path = logger.runs().test_spec_path(test_id).with_context(|| {
      "no .ux-tests root is configured on this host; --test requires one (use --file)".to_string()
    })?;
    TestSpec::from_yaml_file(&path).with_context(|| {
      format!(
        "Failed to load test '{test_id}' (looked in {})",
        path.display()
      )
    })?
  } else if let Some(file_path) = &args.file {
    let path = PathBuf::from(file_path);
    TestSpec::from_yaml_file(&path)
      .with_context(|| format!("Failed to load test spec from {}", file_path))?
  } else {
    // Ephemeral test - require name and instructions
    let name = args
      .name
      .clone()
      .context("Either --file or --name/--instructions is required")?;
    let instructions = args
      .instructions
      .clone()
      .context("Either --file or --name/--instructions is required")?;

    // Generate session ID for ephemeral test
    let date = Utc::now().format("%Y-%m-%d").to_string();
    let random_suffix = format!("{:06x}", rand::random::<u32>() & 0xFFFFFF);
    let flaky_suffix = if args.flaky.is_some() { ".flaky" } else { "" };
    let session_id = format!("{}_{}_{}{}", date, name, random_suffix, flaky_suffix);

    TestSpec::ephemeral(session_id, name, instructions)
  };
  if !is_ephemeral {
    spec_out.id = spec.id.clone();
  }

  // Apply param overrides if provided
  if let Some(overrides_str) = &args.param_overrides {
    let overrides: std::collections::HashMap<String, String> =
      serde_json::from_str(overrides_str).context("--params must be a JSON object")?;
    for (key, value) in overrides {
      spec.params.insert(key, value);
    }
  }

  // Apply timeout override if provided
  if let Some(timeout) = args.timeout {
    spec.timeout = timeout;
  }

  // Fail fast on `--auto` BEFORE any setup/session side effects: a spec that
  // isn't auto-runnable (a step missing `actions`, or no `verification` block)
  // can't be driven headless, so don't create orphan users/sessions for it.
  // Critical for folder runs, where one manual spec would otherwise strand a
  // session (and run its setup) before erroring.
  if args.auto && !spec.is_auto_runnable() {
    return Err(
      anyhow::anyhow!(
        "--auto requires a `verification` block and every step to declare either \
`actions` or `manual: true` with a `manual_reason`"
      )
      .into(),
    );
  }

  // An agent-driven `--auto` run (a lane configured, a manual step in the
  // spec) resolves everything it needs from the host HERE, before setup: a
  // host that cannot run it must fail without creating a user it would then
  // never tear down. No lane, or nothing manual ⇒ `None`, today's path.
  let agent_drive = match agent::lane_from_env() {
    Some(lane) if agent::drives(args.auto, &spec, Some(&lane)) => {
      let config = agent::AgentConfig::from_env(lane)?;
      let queue_env = tento_agent_queue::QueueEnv::load().context("read the agent queue's env")?;
      let queue = tento_agent_queue::AgentQueue::from_env(&queue_env, agent::PRODUCER)
        .context("locate the agent queue")?;
      Some((config, queue))
    }
    _ => None,
  };

  // Replay a recorded environment (`--env-from`) by prepending plant actions
  // to the first step — headless-only, since the plant rides `actions`. After
  // the auto-runnable gate, so planting actions can never be what makes a spec
  // look drivable.
  if let Some(env_session) = &args.env_from {
    if !args.auto {
      return Err(
        anyhow::anyhow!("--env-from requires --auto (the plant rides headless actions)").into(),
      );
    }
    apply_env_manifest(&mut spec, &logger, env_session)?;
  }

  // Which origin to drive. `--url` wins; absent, the spec's entry route and
  // then its own declared `params.server_url` decide, and only then the host's
  // default origin.
  //
  // Both derivations belong to the host, because both read its hostname
  // grammar. What is generic — and what stays here — is the precedence: a host
  // whose product is single-origin derives nothing and every spec lands on its
  // default, exactly as before this seam existed.
  let url_arg = match &args.url {
    Some(_) => args.url.clone(),
    None => ctx
      .env()
      .url_pattern_from_initial_path(spec.initial_path.as_deref())
      .or_else(|| {
        spec
          .params
          .get("server_url")
          .and_then(|declared| ctx.env().url_pattern_from_server_url(declared))
      }),
  };

  // Resolve the absolute target host early so setup/instructions can reference
  // {{server_url}}. The final URL is resolved again after setup so substituted
  // params in initial_path are reflected in both metadata and the printed URL.
  let target_for_params = ctx
    .env()
    .resolve_session_target(&url_arg, None, profile.server_host.as_deref())?
    .with_scheme(profile.scheme);
  spec.params.insert(
    "server_url".to_string(),
    format!(
      "{}://{}",
      profile.scheme.as_str(),
      target_for_params.full_host
    ),
  );

  info!("Running UX test: {} ({})", spec.name, spec.id);

  // Every host verb this spec calls must be one the mounted host answers —
  // checked BEFORE any setup runs. The catch-all verb parses a typo happily, so
  // without this a spec could create a user, mint a key, and only then discover
  // its third action was `craete_trial_user`. `ux-test lint` is the same check,
  // over the whole corpus, offline.
  let unknown = orchestration::unknown_host_actions(&spec, ctx.port().verbs());
  if !unknown.is_empty() {
    return Err(
      anyhow::anyhow!(
        "spec '{}' calls {} verb(s) this host does not answer: {}\n  known verbs: {}",
        spec.id,
        unknown.len(),
        unknown.join(", "),
        ctx.port().verbs().join(", ")
      )
      .into(),
    );
  }

  // An `--auto` run (headless or agent-driven) drives one account: `--user`
  // and the spec's `params.user_email` must agree. Checked before setup
  // (review J-5): setup may delete the declared account (onboarding-new-user
  // deletes operator-tester@lona.so), and a refusal after it left that
  // account deleted with no teardown.
  if args.auto {
    check_account_agreement(
      args.user.as_deref(),
      spec.params.get("user_email").map(String::as_str),
    )?;
  }

  ctx.port().preflight_commands().await?;

  // Phase 1: Setup
  if !spec.setup.is_empty() {
    info!("Phase 1: Setup ({} actions)", spec.setup.len());
    let setup_actions = spec.setup.clone();
    for action in &setup_actions {
      execute_setup_action(ctx.port(), &mut spec, action).await?;
    }
  }

  // Phase 2: Create browser session
  info!("Phase 2: Creating browser session");

  // Generate session ID if not already set (for file-based tests)
  let session_id = if spec.id.contains('_') && spec.id.chars().filter(|c| *c == '_').count() >= 2 {
    // Already looks like a session ID (date_name_random)
    spec.id.clone()
  } else {
    let date = Utc::now().format("%Y-%m-%d").to_string();
    let random_suffix = format!("{:06x}", rand::random::<u32>() & 0xFFFFFF);
    let flaky_suffix = if args.flaky.is_some() { ".flaky" } else { "" };
    format!("{}_{}_{}{}", date, spec.id, random_suffix, flaky_suffix)
  };

  // Generate tracing UUID for linking client/server spans
  let tracing_uuid = Uuid::new_v4();

  // Collect display params from steps
  let display_params = {
    let resolved = spec.resolved_display_params();
    if resolved.is_empty() {
      None
    } else {
      Some(
        resolved
          .into_iter()
          .map(|(k, v, step_index)| SessionParam {
            label: k,
            value: v,
            step_index,
          })
          .collect(),
      )
    }
  };

  // Substitute params (e.g. {{promo_code}}) in the initial path after setup, so
  // the printed URL and the recorded jump target share the resolved path.
  let substituted_initial_path = spec
    .initial_path
    .as_deref()
    .map(|p| spec.substitute_params(p));
  let target = ctx
    .env()
    .resolve_session_target(
      &url_arg,
      substituted_initial_path.as_deref(),
      profile.server_host.as_deref(),
    )?
    .with_scheme(profile.scheme);
  let full_host = target.full_host.clone();

  // Record the session's absolute jump target (origin + path). The in-app
  // "jump to" link (uxTestJumpUrl) opens this origin directly instead of
  // resolving same-origin against wherever the operator currently is — the
  // calendar app lives only on its own subdomain, so a same-origin jump from
  // the root domain would land on the root home, not the test's page.
  let jump_metadata = serde_json::json!({
    "targetOrigin": target.origin(),
    "targetPath": target.target_path.clone(),
    // Tests that need a specific signed-in user are skipped by the anonymous
    // in-app "jump to newest UX test" (uxTestJumpUrl / jumpToNewestUxTest).
    "requiresUser": spec.requires_user(),
    // Tests that redeem a single-use promo/`trynow` link brick it on access —
    // the operator UI surfaces this so the link is regenerated before re-running.
    "consumesSingleUseLink": spec.consumes_single_use_link(),
  });

  // Create session
  let session = Session {
    id: session_id.clone(),
    prefix: args.testing_prefix.unwrap_or_else(|| spec.name.clone()),
    instructions: spec.substituted_instructions(),
    metadata: Some(jump_metadata),
    status: SessionStatus::Pending,
    created_at: Utc::now(),
    flaky: args.flaky.clone(),
    tracing_uuid: Some(tracing_uuid),
    display_params,
    // Ephemeral runs bucket under `.scratch`; persisted runs are stamped
    // Some(spec.id) by create_session_with_spec below.
    test_id: is_ephemeral.then(|| crate::folder::SCRATCH_TEST_ID.to_string()),
    completed_steps: Vec::new(),
  };

  // Create session directory with both session.json and spec.yaml
  let session_dir = logger.create_session_with_spec(&session, &spec)?;
  info!("Created session: {}", session_dir.display());
  spec_out.run = Some(session_id.clone());
  spec_out.session_dir = Some(session_dir.clone());
  spec_out.target = Some(target.origin());

  // Resolve URL and print it (substituted_initial_path computed above).
  let url = target.url(
    &session_id,
    Some(tracing_uuid),
    substituted_initial_path.as_deref(),
  );
  let output = serde_json::json!({
    "sessionId": session_id,
    "url": url,
  });
  rc.human
    .line(serde_json::to_string_pretty(&output).context("Failed to serialize output")?);

  // If --no-wait, return immediately (session created, not judged).
  if args.no_wait {
    return Ok(RunOutcome::bare(Outcome::Pass, "created".to_string()));
  }

  // Phase 3 (agent): the spec has steps a machine cannot do and the host
  // names an agent lane — hand the whole drive to one agent job.
  if let Some((config, queue)) = agent_drive {
    // The account the tester's profile is signed in as, for the prompt — the
    // same precedence the headless path uses.
    let user = args
      .user
      .clone()
      .or_else(|| spec.params.get("user_email").cloned())
      .or_else(|| ctx.env().default_user());
    let timing = agent::Timing::for_spec(spec.timeout, config.queue_wait);
    // The sign-in pre-steps (Google, then Microsoft), for each provider the
    // host names a password file for. One runs alone, exactly as before; two
    // run in sequence on the same private browser.
    let runner_dir = ctx.env().ux_runner_dir();
    // Only the providers this spec needs (its `signin_providers:`, else its
    // manual steps): a Google-only spec never waits on (or is cancelled by)
    // the Microsoft pre-step.
    for skipped in config
      .signins()
      .filter(|signin| !signin.provider.needed_by(&spec))
    {
      let why = if spec.signin_providers.is_some() {
        "the spec's signin_providers does not list it"
      } else {
        "no manual step of this spec names it"
      };
      info!("  {} pre-step skipped: {why}", skipped.provider.label());
    }
    let signers: Vec<agent::DenoSignin> = config
      .signins_for(&spec)
      .map(|signin| agent::DenoSignin::new(signin, runner_dir.as_deref(), &url))
      .collect();
    let sequence = agent::SigninSequence {
      steps: signers
        .iter()
        .map(|signer| signer as &dyn agent::SignIn)
        .collect(),
    };
    let signin: Option<&dyn agent::SignIn> = match signers.as_slice() {
      [] => None,
      [one] => Some(one),
      _ => Some(&sequence),
    };
    let harness_sink = agent::DenoHarnessSink::default();
    return run_agent_driven(
      ctx,
      &logger,
      AgentDrive {
        config,
        queue,
        launcher: &agent::ChromeLauncher,
        timing,
        signin,
        harness_sink: &harness_sink,
      },
      AgentSession {
        session_id: &session_id,
        spec: &spec,
        tracing_uuid,
        target_origin: target.origin(),
        host_only: target.host_only.clone(),
        url: url.clone(),
        user,
        human: rc.human,
        artifact: rc.artifact.clone(),
      },
      profile,
    )
    .await;
  }

  // Phase 3: obtain completion — either drive the test headless (--auto) or wait
  // for an operator to perform it. Both paths flip the session to Completed; the
  // shared phases 3.5–5 below then snapshot, tear down, and judge identically.
  let steps_executed = if args.auto {
    info!("Phase 3 (auto): driving headless via the Deno runner");
    let session_dir = logger.session_dir(&session_id)?;
    // Which account to drive. `--user` wins; absent, the spec's declared
    // `params.user_email`; only then the host's own default account.
    //
    // A tier-2 spec mutates real user state and so needs a mutable account, but
    // that requirement was recorded in prose ("Pass `--user
    // operator-tester@lona.so`") with no field for `--auto` to read — so it
    // silently drove the host's read-only demo persona, whose calendar is a
    // seeded fixture (`ev-*` ids, no provider rows). `params.user_email` is
    // already how the corpus records an account (`event-flow-create` asserts
    // its row key off it), so honour it here rather than inventing a second
    // channel. `--user` and `params.user_email` were checked to agree before
    // setup.
    // Not required here any more: whether an account is needed at all is the
    // corpus manifest's `auth:` block, and `drive_headless` holds the manifest.
    // Demanding one before reading it is what forced an app with no account
    // model to name a fake account.
    let user = resolve_user(
      args.user.as_deref(),
      spec.params.get("user_email").map(String::as_str),
      || ctx.env().default_user(),
    );
    if let Some((user, source)) = &user {
      spec_out.user = Some(user.clone());
      spec_out.user_source = Some(*source);
    }
    let user = user.map(|(user, _)| user);
    let driven = crate::headless::drive_headless(
      ctx,
      &session_dir,
      &session_id,
      &spec,
      &full_host,
      &url,
      user.as_deref(),
      profile,
    )
    .await;
    match driven {
      Ok(steps_executed) => steps_executed,
      Err(e) => {
        teardown_after_failed_drive(ctx, &spec).await;
        return Err(e.into());
      }
    }
  } else {
    info!(
      "Phase 3: Waiting for operator (timeout: {}s)...",
      spec.timeout
    );
    true
  };

  // A headless runner that exited non-zero has nothing left to post: waiting
  // the spec's whole timeout for it is how a refused boot navigation hung to
  // the 600 s alarm. A short grace, then the run ends red with the runner's
  // recorded error.
  let completion = if args.auto && !steps_executed {
    info!(
      "  The runner exited without executing every step; waiting {}s for its completion, not the spec's {}s",
      orchestration::RUNNER_EXIT_GRACE_SECS,
      spec.timeout
    );
    orchestration::await_completion_after_runner_failure(
      &logger,
      ctx.port(),
      &session_id,
      orchestration::RUNNER_EXIT_GRACE_SECS,
    )
    .await
  } else {
    await_session_completion(&logger, ctx.port(), &session_id, spec.timeout).await
  };
  let completion = match completion {
    Ok(completion) => completion,
    Err(e) => {
      teardown_after_failed_drive(ctx, &spec).await;
      return Err(e.into());
    }
  };
  finalize_completed_run(
    ctx,
    &logger,
    &session_id,
    &spec,
    tracing_uuid,
    target.origin(),
    completion,
    FinalizeMode {
      auto: args.auto,
      steps_executed,
      driver: Driver::Cli,
      env: Some(profile.name.clone()),
      human: rc.human,
      artifact: rc.artifact.clone(),
    },
  )
  .await
}

/// The teardown of a run that setup started and an error ended before
/// [`finalize_completed_run`], which is where a run otherwise tears down: a
/// refused mint, a runner that cannot start, a failed wait for completion.
/// Without it the error skipped the teardown, and on lona a spec whose setup
/// deleted operator-tester@lona.so left it deleted (operator decision N-5a,
/// 2026-10-19). Every action runs, and a failed one is logged, not raised: the
/// run ends with the error that stopped it.
async fn teardown_after_failed_drive(ctx: &UxTestCtx, spec: &TestSpec) {
  if spec.teardown.is_empty() {
    return;
  }
  info!(
    "Teardown after the failed drive ({} actions)",
    spec.teardown.len()
  );
  for action in &spec.teardown {
    if let Err(e) = execute_teardown_action(ctx.port(), spec, action).await {
      warn!("teardown action failed: {e:#}");
    }
  }
}

/// Not `Copy` any more: it carries the profile's NAME. That is deliberate —
/// the alternative was re-deriving the environment downstream from the target
/// URL, which is exactly the guess `LedgerEntry::env` exists to replace.
#[derive(Clone)]
struct FinalizeMode {
  auto: bool,
  steps_executed: bool,
  driver: Driver,
  /// The env profile the run was driven under. `None` from `ux-test finalize`,
  /// which attaches to a session someone else started and is not told.
  env: Option<String>,
  /// Where the result JSON goes — stderr under `run --json`.
  human: Human,
  /// The artifact stamp for the ledger entry. `None` from `ux-test finalize`,
  /// for the same reason as `env`.
  artifact: Option<ArtifactIdentity>,
}

async fn finalize_completed_run(
  ctx: &UxTestCtx,
  logger: &LLMLogger,
  session_id: &str,
  spec: &TestSpec,
  tracing_uuid: Uuid,
  target_origin: String,
  completion: orchestration::SessionCompletionResult,
  mode: FinalizeMode,
) -> tento_sh::Result<RunOutcome> {
  info!(
    "Session completed: {} ({} log entries)",
    orchestration::result_label(&completion.completion),
    completion.logs.len()
  );

  // Phase 3.5: Snapshot the unified trace (client logs.ljson + server bucket rows).
  info!("Phase 3.5: Snapshotting trace");
  if let Err(e) = orchestration::materialize_trace(logger, session_id, tracing_uuid) {
    info!("  Warning: Failed to snapshot trace: {:#}", e);
  }

  // A partial `--auto` run reached a step that needs a human, so the end state
  // the assertions describe was never reached. Verification is SKIPPED rather
  // than run-and-passed: judging a state you did not arrive at is how a suite
  // starts reporting green over work it never did.
  let stopped_at = if mode.auto {
    spec.first_manual_step()
  } else {
    None
  };
  if let Some((i, step)) = stopped_at {
    info!(
      "  Stopped at step {} ({}) — {}",
      i + 1,
      step.id,
      step.manual_reason.as_deref().unwrap_or("declared manual")
    );
    info!("  Verification SKIPPED: the run is INCOMPLETE, not a pass or a fail.");
  }

  // Phase 5: Verification
  // The judges' verdict, plus the reason, so the record written below can say
  // *why* without anyone re-running them. A `Result` until teardown has run:
  // a verification that errors must not strand setup's account.
  let verdict: tento_sh::Result<(VerificationOutcome, Option<String>)> = async {
    Ok(if let Some((i, step)) = stopped_at {
      // Not `Failed`: the product did not misbehave, the drive stopped. That
      // distinction is exactly what a bare boolean could not express.
      (
        VerificationOutcome::NotRun,
        Some(format!(
          "drive stopped at step {i}/{} ({}) — verification never ran",
          spec.steps.len(),
          step.id
        )),
      )
    } else if let Some(ref verification) = spec.judged_verification() {
      info!("Phase 5: Verification");
      let session_dir = logger.session_dir(session_id)?;

      // Independent judges, all of which must pass. The trace says the
      // client did what it was told; the row assertions say the write landed.
      // Neither substitutes for the other — a spec that asserts rows but
      // dispatches nothing still fails on the trace side.
      // The diagram is the third: it judges what the other two cannot see —
      // a log in the wrong step, a step's `failure_log` — so nothing the board
      // draws as a divergence can sit under a green verdict.
      let (trace_ok, diagram_ok) = match trace_judge_source(&session_dir) {
        Some(verify_path) => (
          verify_trace_results(&verify_path, verification)?,
          orchestration::verify_sequence(spec, &verify_path)?,
        ),
        None => {
          info!("  No log files found for verification");
          (true, true)
        }
      };
      let rows_ok = orchestration::verify_row_assertions(ctx.port(), spec, verification).await?;
      if trace_ok && diagram_ok && rows_ok {
        (VerificationOutcome::Passed, None)
      } else {
        (
          VerificationOutcome::Failed,
          Some(format!(
            "trace_ok={trace_ok} diagram_ok={diagram_ok} rows_ok={rows_ok}"
          )),
        )
      }
    } else {
      // No verification block: nothing asserted that this run did what it
      // claimed. Recorded as a pass to preserve today's semantics, but the
      // detail says so — giving every such spec a positive assertion is its own
      // unit of work.
      (
        VerificationOutcome::Passed,
        Some("spec declares no verification block — nothing was asserted".to_string()),
      )
    })
  }
  .await;

  // Phase 6: Teardown, after verification. Verification reads the state setup
  // made (`assert_rows` reads the driving account's rows) and teardown deletes
  // it, so teardown run first took the rows out from under the read, and a
  // spec that asserts rows had to leave its throwaway account behind
  // (pomodoro-basic-flow). It runs whatever the verdict, an error included,
  // which is propagated only after it. The trace was snapshotted in Phase 3.5,
  // so `stop_log_capture` here loses nothing the judges read.
  if !spec.teardown.is_empty() {
    info!("Phase 6: Teardown ({} actions)", spec.teardown.len());
    for action in &spec.teardown {
      execute_teardown_action(ctx.port(), spec, action).await?;
    }
  }
  let (verification_outcome, verification_detail) = verdict?;
  let verification_passed = matches!(verification_outcome, VerificationOutcome::Passed);

  // Persist the verdict beside the trace. Without this file a headless run has
  // no verdict at all — only the neutral `headless: N steps executed` the
  // harness posts to `complete.json` — and `RunFolder::result` read that as a
  // pass, which is how four specs that wrote nothing showed as `success`.
  if let Err(e) = logger.write_verification_record(
    session_id,
    verification_outcome,
    verification_detail.clone(),
  ) {
    // Never fail the run over its own bookkeeping; a missing record degrades
    // to `Unknown`, which is the honest reading anyway.
    warn!("could not write verification.json: {e:#}");
  }
  // The rollup `mark_complete` refreshed ran before this verdict existed, so
  // `status.json` would still read the unaudited completion. Re-derive it.
  logger.refresh_status(session_id);

  // Print result
  let mut output = serde_json::json!({
    "result": orchestration::result_str(&completion.completion),
    "feedback": completion.completion.as_ref().and_then(|c| c.feedback.as_ref()),
    "verificationPassed": verification_passed,
    "logs": completion.logs,
  });
  if mode.auto {
    output["mode"] = serde_json::json!("auto");
    output["stepsExecuted"] = serde_json::json!(mode.steps_executed);
  }
  mode
    .human
    .line(serde_json::to_string_pretty(&output).context("Failed to serialize output")?);

  // The single-run exit semantics (auto failure ⇒ non-zero) live in the `run`
  // wrapper; folder runs aggregate instead. Report the outcome either way.
  let final_result = orchestration::result_str(&completion.completion).unwrap_or("unknown");

  // An INCOMPLETE run is never a pass. Reporting it as one would let a spec
  // launder coverage by marking its hard steps manual, which is exactly the
  // failure the `manual:` marker has to be built against.
  if let Some((i, step)) = stopped_at {
    let total = spec.steps.len();
    let reason = step.manual_reason.as_deref().unwrap_or("declared manual");
    // A prefix that did not drive clean is a failure that happens to sit in
    // front of a manual step, and it must not launder itself into the partial
    // bucket: the runner exited non-zero, so a step this spec claims a machine
    // can do could not be done.
    if !mode.steps_executed {
      record_run(
        logger,
        &spec.id,
        session_id,
        target_origin.clone(),
        mode.driver,
        Verdict::Fail,
        Some(format!(
          "the automatable prefix failed before step {} ({})",
          i + 1,
          step.id
        )),
        None,
        mode.env.as_deref(),
        mode.artifact.as_ref(),
      );
      return Ok(RunOutcome {
        outcome: Outcome::Fail,
        result: format!("failed driving {i} automatable step(s) before {}", step.id),
        note: Some(format!(
          "the automatable prefix failed before step {} ({})",
          i + 1,
          step.id
        )),
        blocker: None,
        manual_reason: step.manual_reason.clone(),
        agent: None,
      });
    }
    // `unfinished`, not `fail`: the product did not misbehave, the drive
    // stopped. That distinction is the one the audit needed and could not
    // express, so it is worth spending a verdict on.
    record_run(
      logger,
      &spec.id,
      session_id,
      target_origin.clone(),
      mode.driver,
      Verdict::Unfinished,
      Some(format!("drove {i}/{total} steps, stopped at {}", step.id)),
      Some(format!("manual-step: {reason}")),
      mode.env.as_deref(),
      mode.artifact.as_ref(),
    );
    return Ok(RunOutcome {
      outcome: Outcome::Partial,
      result: format!(
        "INCOMPLETE (auto, drove {i}/{total} steps, stopped at {}: {reason})",
        step.id
      ),
      note: Some(format!("drove {i}/{total} steps, stopped at {}", step.id)),
      blocker: Some(format!("manual-step: {reason}")),
      manual_reason: step.manual_reason.clone(),
      agent: None,
    });
  }

  let passed = if mode.auto {
    mode.steps_executed && verification_passed
  } else {
    final_result == "success" && verification_passed
  };

  // The operator's Skip ends the attempt without judging the product, so it is
  // `abandoned` — terminal, and distinct from both `fail` and `unfinished`.
  let feedback = completion
    .completion
    .as_ref()
    .and_then(|c| c.feedback.clone());
  let (verdict, blocker) = match (passed, final_result) {
    (true, _) => (Verdict::Pass, None),
    (false, "abandoned") => (Verdict::Abandoned, Some("operator-skipped".to_string())),
    _ => (Verdict::Fail, None),
  };
  // A failure owes a reason. When the session carried none — which is the
  // measured defect, a `failure` with `feedback: null` — say which half
  // objected rather than writing an entry that records only that something
  // happened. A pass carries the operator's words if there were any and
  // nothing if there were not; there is no reason to invent one.
  let note = if verdict == Verdict::Pass {
    feedback
  } else {
    Some(feedback.unwrap_or_else(|| {
      if verification_passed {
        format!("no feedback recorded; session result was {final_result}")
      } else {
        "verification failed; no feedback recorded".to_string()
      }
    }))
  };
  record_run(
    logger,
    &spec.id,
    session_id,
    target_origin.clone(),
    mode.driver,
    verdict,
    note.clone(),
    blocker.clone(),
    mode.env.as_deref(),
    mode.artifact.as_ref(),
  );

  Ok(RunOutcome {
    outcome: if passed { Outcome::Pass } else { Outcome::Fail },
    result: if mode.auto {
      format!("{final_result} (auto, verify={verification_passed})")
    } else {
      final_result.to_string()
    },
    note,
    blocker,
    manual_reason: None,
    agent: None,
  })
}

// ===========================================================================
// Agent-driven --auto (see `crate::agent`)
// ===========================================================================

/// The queue side of an agent-driven run: which lane, which queue, what
/// starts the browser, and how long each phase may take. A struct so a test
/// can hand in a fixture queue, a launcher with no browser, and short clocks.
struct AgentDrive<'a> {
  config: agent::AgentConfig,
  queue: tento_agent_queue::AgentQueue,
  launcher: &'a dyn LaunchBrowser,
  timing: agent::Timing,
  /// The sign-in pre-step (Google, Microsoft, or both in sequence), run
  /// before the job is enqueued and the agent's browser starts. `None` ⇒ no
  /// pre-step.
  signin: Option<&'a dyn agent::SignIn>,
  /// Starts the harness-post sink, for the profiles whose page origin does
  /// not keep this run's session ([`crate::headless::harness_sink_for`]).
  harness_sink: &'a dyn agent::StartHarnessSink,
}

/// The session side: what `run` created and printed.
struct AgentSession<'a> {
  session_id: &'a str,
  spec: &'a TestSpec,
  tracing_uuid: Uuid,
  target_origin: String,
  host_only: String,
  /// The launch URL exactly as printed (`?ux=<id>&tid=<uuid>`).
  url: String,
  /// The account the tester's profile is signed in as, for the prompt.
  user: Option<String>,
  /// Where the run's human output goes (stderr under `run --json`).
  human: Human,
  /// The artifact stamp for the ledger entry and the report.
  artifact: Option<ArtifactIdentity>,
}

/// Phase 3 (agent) through the verdict: enqueue one agent job, launch the
/// browser when it runs, wait for the session or the job, then finalize
/// exactly as `ux-test finalize --by agent` does. Every ending tears down,
/// writes `verification.json` and `agent.json`, and records the ledger; only
/// `verification.json` = passed is a pass.
async fn run_agent_driven(
  ctx: &UxTestCtx,
  logger: &LLMLogger,
  drive: AgentDrive<'_>,
  session: AgentSession<'_>,
  profile: &EnvProfile,
) -> tento_sh::Result<RunOutcome> {
  let AgentSession {
    session_id,
    spec,
    tracing_uuid,
    target_origin,
    host_only,
    url,
    user,
    human,
    artifact,
  } = session;
  info!(
    "Phase 3 (agent): the spec has manual steps; enqueueing one agent job in lane `{}`",
    drive.config.lane
  );
  // `fill_secret` fills only the spec's own declared account's password.
  let spec_account = spec.params.get("user_email").map(String::as_str);
  let run_dir = logger.session_dir(session_id)?;
  let work_dir = run_dir.join("agent");
  std::fs::create_dir_all(&work_dir).with_context(|| format!("create {}", work_dir.display()))?;
  // The job's workspace: the queue refuses a relative one, and the agent's
  // session opens there.
  let work_dir =
    std::fs::canonicalize(&work_dir).with_context(|| format!("resolve {}", work_dir.display()))?;

  let manifest = crate::manifest::AppManifest::resolve(ctx.env().ux_tests_dir().as_deref())
    .context("read the corpus app manifest")?;
  // The page's harness posts to the page origin. Under a named profile that
  // is another server with a store of its own, so — exactly as the headless
  // runner does for the same profiles — the posts are answered beside the
  // browser and land in this run's dir, which the completion poll reads.
  let sink_plan = match crate::headless::harness_sink_for(profile) {
    Some(_) => {
      let run_dir = std::fs::canonicalize(&run_dir)
        .with_context(|| format!("resolve {}", run_dir.display()))?;
      Some(agent::HarnessSinkPlan {
        session_id: session_id.to_string(),
        out_dir: run_dir.join("harness-sink"),
        workspace: work_dir.clone(),
        run_dir,
        app_domains: manifest
          .as_ref()
          .map(|manifest| manifest.domains.clone())
          .unwrap_or_default(),
      })
    }
    None => None,
  };
  let resolve_domains = manifest
    .as_ref()
    .map(crate::manifest::AppManifest::resolve_patterns)
    .unwrap_or_default();
  let dev_port = profile.dev_port(ctx.env().dev_port());
  let launch_url = agent::with_port(&url, dev_port.as_deref());
  let launch = agent::BrowserLaunch::for_run(
    &drive.config,
    profile,
    &host_only,
    &resolve_domains,
    launch_url.clone(),
    &work_dir,
    agent::free_loopback_port()?,
  );
  let prompt = agent::render_prompt(&agent::PromptInputs {
    spec_id: spec.id.clone(),
    // The run's own snapshot: the spec as it ran, params substituted by setup.
    spec_path: run_dir.join("spec.yaml"),
    session_id: session_id.to_string(),
    env: profile.name.clone(),
    target_origin: target_origin.clone(),
    launch_url,
    devtools_url: launch.devtools_url(),
    account: user,
    run_dir: run_dir.clone(),
    work_dir: work_dir.clone(),
    runner_dir: ctx.env().ux_runner_dir(),
    timeout_secs: spec.timeout,
    fill_secret: crate::fill_secret::secret_for_account(spec_account).map(str::to_string),
  });
  if let Err(e) = std::fs::write(work_dir.join("prompt.md"), &prompt) {
    warn!("could not keep the agent prompt beside the run: {e:#}");
  }
  // The runner's deno.json, canonical: the one config tsh's allow-workspace
  // rule lets the agent's scripts run under.
  let deno_config = ctx
    .env()
    .ux_runner_dir()
    .and_then(|dir| std::fs::canonicalize(dir.join("deno.json")).ok());
  let job = agent::new_job(
    &drive.config.lane,
    prompt,
    spec,
    session_id,
    &work_dir,
    deno_config.as_deref(),
  );

  // The agent's `fill_secret` requests are answered while it drives, from
  // its workspace, into Google's password page in its browser.
  let typer = crate::fill_secret::DenoTypeSecret::new(ctx.env().ux_runner_dir().as_deref());
  let fill = crate::fill_secret::FillSecretServer::new(
    crate::fill_secret::FillSecretPlan {
      secret_dir: crate::fill_secret::secret_dir_from_env(),
      account: spec_account.map(str::to_string),
      run_id: session_id.to_string(),
      work_dir: work_dir.clone(),
      out_dir: run_dir.join(crate::fill_secret::FILL_SECRET_OUT_DIR),
      devtools_port: launch.devtools_port,
      trace: Some(crate::fill_secret::AuditTrace {
        logger,
        tracing_uuid,
      }),
    },
    &typer,
  );
  let drive_run = agent::drive(
    &drive.queue,
    job,
    drive.launcher,
    &launch,
    logger,
    ctx.port(),
    session_id,
    &drive.timing,
    // Beside the run, not in the agent's workspace.
    drive.signin.map(|signer| agent::PreSignin {
      signer,
      out_dir: run_dir.join(signer.dir_name()),
      workspace: work_dir.clone(),
    }),
    sink_plan.map(|plan| agent::HarnessSinkStart {
      starter: drive.harness_sink,
      plan,
    }),
  );
  let mut agent_run = tokio::select! {
    driven = drive_run => driven,
    never = fill.serve(std::time::Duration::from_millis(500)) => match never {},
  };
  // The backstop, before anything reads the run's files: no value the
  // harness filled survives in logs.ljson (and so trace.ljson) or in the
  // agent's own notes, scripts and RESULT.
  scrub_filled(&fill, &run_dir);

  let result = agent::result_line(agent_run.job.as_ref(), &work_dir).map(|mut line| {
    line.line = fill.redact(&line.line);
    line.blocker = line.blocker.map(|blocker| fill.redact(&blocker));
    line
  });
  let end_label = agent_run.end.label();
  let job_label = match (&agent_run.job_id, &agent_run.job) {
    (Some(id), Some(job)) => format!("agent job {id} {}", job.state.as_str()),
    (Some(id), None) => format!("agent job {id}"),
    _ => "agent job (not enqueued)".to_string(),
  };
  let mode = FinalizeMode {
    auto: false,
    steps_executed: true,
    driver: Driver::Agent,
    env: Some(profile.name.clone()),
    human,
    artifact,
  };

  let finished = match std::mem::replace(&mut agent_run.end, AgentEnd::JobEnded) {
    // The one ending finalize can judge: the same path `finalize --by agent`
    // takes. Not `auto`: an agent drove EVERY step, manual ones included, so
    // there is no "stopped at a manual step" to report.
    AgentEnd::SessionCompleted(completion) => finalize_completed_run(
      ctx,
      logger,
      session_id,
      spec,
      tracing_uuid,
      target_origin,
      completion,
      mode,
    )
    .await
    .map(|outcome| (outcome, true)),
    unfinished => {
      let (reason, blocker) =
        agent_unfinished(&unfinished, &drive.timing, result.as_ref(), &job_label);
      Ok((
        record_agent_unfinished(
          ctx,
          logger,
          session_id,
          spec,
          tracing_uuid,
          target_origin,
          mode,
          reason,
          blocker,
        )
        .await,
        false,
      ))
    }
  };

  // Whatever happened above, the record of the job is written.
  let verification = logger
    .session_dir(session_id)
    .ok()
    .and_then(|dir| std::fs::read_to_string(dir.join("verification.json")).ok())
    .and_then(|raw| serde_json::from_str::<VerificationRecord>(&raw).ok())
    .map(|record| record.outcome);
  let (outcome, reason) = match finished {
    Ok((mut outcome, completed)) => {
      let reason = match outcome.agent.take() {
        // An unfinished run already carries its reason (teardown failures
        // included).
        Some(reason) if !completed => reason,
        // Only `verification.json` = passed is a pass — whatever the session
        // or the agent said.
        _ if outcome.outcome == Outcome::Pass
          && verification != Some(VerificationOutcome::Passed) =>
        {
          outcome.outcome = Outcome::Fail;
          format!("failed: verification.json reads {verification:?}, not passed ({job_label})")
        }
        _ if outcome.outcome == Outcome::Pass => {
          format!("passed: verification passed ({job_label})")
        }
        _ => format!("failed: {} ({job_label})", outcome.result),
      };
      outcome.agent = Some(fill.redact(&reason));
      (Ok(outcome), reason)
    }
    Err(error) => {
      let reason = format!("finalize failed after the agent completed the session: {error:#}");
      (Err(error), reason)
    }
  };

  let reason = fill.redact(&reason);
  let mut record = AgentRecord::new(
    &agent_run,
    end_label,
    result,
    verification,
    reason.clone(),
    &work_dir,
  );
  record.secret_fills = fill.audit();
  // Again after finalize and teardown wrote trace.ljson, verification.json
  // and the rest — then agent.json, already redacted.
  scrub_filled(&fill, &run_dir);
  match record.write(&run_dir) {
    Ok(path) => info!("  Recorded the agent run in {}", path.display()),
    Err(e) => warn!("could not write agent.json: {e:#}"),
  }
  human.line(format!("agent-driven run: {reason}"));
  outcome
}

/// Redact every value `fill` typed from the files under `run_dir`. A failure
/// is logged, never the value.
fn scrub_filled(fill: &crate::fill_secret::FillSecretServer<'_>, run_dir: &Path) {
  match fill.scrub(run_dir) {
    Ok(rewritten) if !rewritten.is_empty() => warn!(
      "  Redacted a filled secret from {} file(s) of this run",
      rewritten.len()
    ),
    Ok(_) => {}
    Err(error) => warn!("could not scrub the run for filled secrets: {error:#}"),
  }
}

/// The reason and blocker slug of an agent run that never completed the
/// session. The agent's own `unfinished <blocker>` wins when it said one: it
/// was there.
fn agent_unfinished(
  end: &AgentEnd,
  timing: &agent::Timing,
  result: Option<&agent::ResultLine>,
  job_label: &str,
) -> (String, String) {
  let said = result
    .map(|line| format!(" — agent said: {}", line.line))
    .unwrap_or_default();
  // The agent never had a working browser when the sign-in pre-step blocked
  // or the sink could not start, so whatever it said is not the story. A sink
  // that exited mid-run usually means the browser died, which the agent saw.
  let own = match end {
    AgentEnd::SigninBlocked { .. } | AgentEnd::HarnessSinkFailed(_) => None,
    _ => result.and_then(|line| line.blocker.clone()),
  };
  let (reason, blocker) = match end {
    AgentEnd::TimedOut { phase: "queued" } => (
      format!(
        "{job_label} did not start within {}s (the lane is busy or undeclared); cancelled",
        timing.queue_wait.as_secs()
      ),
      "agent-queue-timeout".to_string(),
    ),
    AgentEnd::TimedOut { .. } => (
      format!(
        "{job_label} did not complete the session within {}s; cancelled",
        timing.run_budget.as_secs()
      ),
      "agent-timeout".to_string(),
    ),
    AgentEnd::BrowserFailed(error) => (
      format!("the browser could not be launched: {error}; {job_label} cancelled"),
      "browser-launch".to_string(),
    ),
    AgentEnd::EnqueueFailed(error) => (
      format!("the agent job could not be enqueued: {error}"),
      "agent-queue-unavailable".to_string(),
    ),
    AgentEnd::SessionError(error) => (
      format!("{error}; {job_label} cancelled"),
      "session-ended".to_string(),
    ),
    AgentEnd::SigninBlocked { blocker, line } => (
      format!(
        "the {} sign-in pre-step did not sign in ({}); {job_label} cancelled before its browser \
         started",
        agent::SigninProvider::of_blocker(blocker).display_name(),
        line.lines().collect::<Vec<_>>().join("; ")
      ),
      blocker.clone(),
    ),
    AgentEnd::HarnessSinkFailed(line) => (
      format!(
        "the harness-post sink could not start on the agent's browser ({line}); {job_label} \
         cancelled, since its completion could not have reached this run"
      ),
      "harness-sink-failed".to_string(),
    ),
    AgentEnd::HarnessSinkExited(line) => (
      format!("{line}; {job_label} cancelled"),
      "harness-sink-exited".to_string(),
    ),
    AgentEnd::JobEnded | AgentEnd::SessionCompleted(_) => (
      format!("{job_label} ended without completing the session"),
      "agent-no-completion".to_string(),
    ),
  };
  (
    format!("unfinished: {reason}{said}"),
    own.unwrap_or(blocker),
  )
}

/// Close out an agent run the harness never completed: snapshot what trace
/// there is, run the spec's teardown (setup created state that must not
/// outlive the run), write `verification.json` = not_run, and record the
/// ledger as `unfinished` with its blocker. Never a pass.
#[allow(clippy::too_many_arguments)]
async fn record_agent_unfinished(
  ctx: &UxTestCtx,
  logger: &LLMLogger,
  session_id: &str,
  spec: &TestSpec,
  tracing_uuid: Uuid,
  target_origin: String,
  mode: FinalizeMode,
  mut reason: String,
  blocker: String,
) -> RunOutcome {
  if let Err(e) = orchestration::materialize_trace(logger, session_id, tracing_uuid) {
    info!("  Warning: Failed to snapshot trace: {:#}", e);
  }
  if !spec.teardown.is_empty() {
    info!("Phase 4: Teardown ({} actions)", spec.teardown.len());
    for action in &spec.teardown {
      // Keep going: one failed teardown verb must not strand the rest, and the
      // failure belongs in the record rather than in place of it.
      if let Err(e) = execute_teardown_action(ctx.port(), spec, action).await {
        warn!("teardown action failed: {e:#}");
        reason.push_str(&format!("; teardown failed: {e:#}"));
      }
    }
  }
  if let Err(e) = logger.write_verification_record(
    session_id,
    VerificationOutcome::NotRun,
    Some(format!("the agent did not complete the session — {reason}")),
  ) {
    warn!("could not write verification.json: {e:#}");
  }
  logger.refresh_status(session_id);
  record_run(
    logger,
    &spec.id,
    session_id,
    target_origin,
    mode.driver,
    Verdict::Unfinished,
    Some(reason.clone()),
    Some(blocker.clone()),
    mode.env.as_deref(),
    mode.artifact.as_ref(),
  );
  RunOutcome {
    outcome: Outcome::Fail,
    result: format!("unfinished (agent, {blocker})"),
    note: Some(reason.clone()),
    blocker: Some(blocker),
    manual_reason: None,
    agent: Some(reason),
  }
}

/// One entry of a batch: a spec to drive, or one the selection declined.
enum Job {
  Run {
    /// The name the summary row prints (the test id, or a path).
    name: String,
    group: Option<String>,
    args: UxTestRunArgs,
  },
  /// Skipped before any side effect, with why — counted in the tally.
  Skipped(SpecReport),
}

/// Run a batch of pre-specialized jobs sequentially — one operator-driven (or
/// `--auto`) session at a time — then print a passed / partial / failed /
/// skipped summary. Continues past failures; a single bad test never aborts the
/// batch. Under `--auto` it is CI-shaped: a non-zero exit if any job genuinely
/// **failed**. The skipped jobs are the ones the caller declined to run at all
/// (see [`run_corpus`]) — carried in so the one summary line accounts for every
/// spec the selection considered, rather than leaving the skips in scrollback
/// above it.
///
/// The tally is computed from the same [`SpecReport`]s the run report carries,
/// so the printed line and the document cannot disagree.
async fn run_jobs(
  ctx: &UxTestCtx,
  auto: bool,
  label: String,
  jobs: Vec<Job>,
  profile: &EnvProfile,
  rc: &RunCtx,
  profile_out: &mut ProfileReport,
) -> tento_sh::Result<()> {
  // The environment is part of the label so a three-environment sweep's three
  // summary lines can be told apart in scrollback.
  let label = format!("{label} · env {}", profile.name);
  profile_out.label = Some(label.clone());

  let to_run = jobs.iter().filter(|j| matches!(j, Job::Run { .. })).count();
  if to_run == 0 {
    let skipped = jobs.len();
    profile_out
      .specs
      .extend(jobs.into_iter().filter_map(|j| match j {
        Job::Skipped(spec) => Some(spec),
        Job::Run { .. } => None,
      }));
    // Print the tally ANYWAY, before erroring. A group whose every spec is
    // manual by design — tento-localhost's `extraction` is one — has nothing to
    // drive and legitimately exits non-zero, and this used to return here
    // without a summary line. A reader downstream then cannot tell it apart
    // from a runner that fell over before reaching the specs, because both
    // produce no tally at all; release-ci's verdict recorded `counts: null` and
    // classified the group `failed` on every acceptance, which is how a correct
    // spec came to sit in `corpora_failed` permanently.
    //
    // `0 passed / 0 partial / 0 failed / N skipped` says exactly what happened
    // and is what lets a verdict separate "nothing to run" from "never got
    // there". The non-zero exit stays: a selection that matched nothing is
    // still not a run, and callers rely on that.
    rc.human.line(run_report::tally_line(
      run_report::Counts::of(&profile_out.specs),
      &label,
    ));
    let reason = run_report::nothing_to_run_reason(&label, skipped);
    profile_out.nothing_to_run = Some(NothingToRun {
      skipped,
      reason: reason.clone(),
    });
    return Err(anyhow::anyhow!(reason).into());
  }
  info!("Batch run: {to_run} test(s) — {label}");

  let mut results: Vec<(String, Outcome, String)> = Vec::new();
  for job in jobs {
    let (name, group, a) = match job {
      Job::Skipped(spec) => {
        profile_out.specs.push(spec);
        continue;
      }
      Job::Run { name, group, args } => (name, group, args),
    };
    info!("──▶ {name}");
    let mut spec_report = SpecReport::new(name.clone(), group);
    let started = std::time::Instant::now();
    let outcome = match run_single(ctx, a, profile, rc, &mut spec_report).await {
      Ok(o) => o,
      // An infra error (bad spec, session-create failure, headless crash) fails
      // just this test — record it and keep going.
      Err(e) => {
        info!("  ERROR: {:#}", e);
        let mut o = RunOutcome::bare(Outcome::Fail, format!("error: {e}"));
        o.note = Some(format!("{e:#}"));
        o
      }
    };
    spec_report.duration_ms = Some(elapsed_ms(started));
    outcome.fill(&mut spec_report);
    profile_out.specs.push(spec_report);
    results.push((name, outcome.outcome, outcome.result));
  }

  let counts = run_report::Counts::of(&profile_out.specs);
  let total = results.len();
  rc.human.line(run_report::tally_line(counts, &label));
  for (name, outcome, result) in &results {
    rc.human
      .line(format!("  [{}] {} — {}", outcome.label(), name, result));
  }
  if counts.partial > 0 {
    rc.human.line(format!(
      "  ({} partial = drove every automatable step, then stopped at one the spec declares manual)",
      counts.partial
    ));
  }

  // `--auto` batch runs exit non-zero if any test genuinely failed (CI-shaped).
  // Partials do not gate: the spec asked for a human at that step, and a suite
  // that reports red for being told the truth teaches people to stop reading it.
  // Manual runs always return Ok — a human reads the summary.
  if auto && counts.failed > 0 {
    return Err(anyhow::anyhow!("{}/{total} tests failed", counts.failed).into());
  }
  Ok(())
}

/// Run every spec under `dir` (recursive) as a sequential suite.
async fn run_folder(
  ctx: &UxTestCtx,
  dir: PathBuf,
  args: UxTestRunArgs,
  profile: &EnvProfile,
  rc: &RunCtx,
  profile_out: &mut ProfileReport,
) -> tento_sh::Result<()> {
  let mut files = Vec::new();
  collect_specs(&dir, &mut files)?;
  files.sort();
  if files.is_empty() {
    return Err(
      anyhow::anyhow!(
        "no spec.yaml or *.user-test.yaml found under {}",
        dir.display()
      )
      .into(),
    );
  }
  let jobs = files
    .into_iter()
    .map(|f| {
      let label = f.display().to_string();
      let mut a = args.clone();
      a.file = Some(f.to_string_lossy().into_owned());
      a.group = None;
      a.all = false;
      Job::Run {
        name: label,
        group: None,
        args: a,
      }
    })
    .collect();
  // A folder run selects by path and skips nothing — every spec found is run.
  run_jobs(
    ctx,
    args.auto,
    dir.display().to_string(),
    jobs,
    profile,
    rc,
    profile_out,
  )
  .await
}

/// Batch-run the tracked corpus (`--all`) or one group (`--group <name>`), by id.
/// Under `--auto`, only auto-runnable specs run (others are skipped with a note).
/// `.scratch` is never part of `--all`; it runs only via an explicit
/// `--group .scratch`.
async fn run_corpus(
  ctx: &UxTestCtx,
  args: UxTestRunArgs,
  profile: &EnvProfile,
  rc: &RunCtx,
  profile_out: &mut ProfileReport,
) -> tento_sh::Result<()> {
  let logger = ctx.logger();
  let Some(folder) = logger.runs().tests_folder() else {
    return Err(
      anyhow::anyhow!("no .ux-tests root configured on this host; --all/--group needs one").into(),
    );
  };

  let group = args.group.as_deref();
  let target_scratch = group == Some(SCRATCH_TEST_ID);

  // `.scratch` is opt-in via `--group .scratch`; otherwise start from the tracked corpus.
  let mut entries = if target_scratch {
    folder
      .scratch_tests()
      .map_err(|e| anyhow::anyhow!("read .ux-tests/.scratch: {e}"))?
  } else {
    folder
      .tests()
      .map_err(|e| anyhow::anyhow!("read .ux-tests: {e}"))?
  };
  if let Some(g) = group {
    if !target_scratch {
      let want_ungrouped = g.is_empty() || g == "-";
      entries.retain(|e| {
        if want_ungrouped {
          e.group.is_none()
        } else {
          e.group.as_deref() == Some(g)
        }
      });
    }
  }

  let label = match group {
    Some(g) => format!("group {g}"),
    None => "corpus (--all)".to_string(),
  };

  // A host with an agent lane drives specs whose first step is manual instead
  // of skipping them (see `crate::agent`).
  let agent_lane = agent::lane_from_env().is_some();

  // Build one job per test, discovering the spec by id (group-aware).
  let mut jobs: Vec<Job> = Vec::new();
  let mut skipped = 0usize;
  for e in entries {
    // Under --auto, only run specs the headless runner (or, with a lane, an
    // agent) can actually drive.
    if args.auto {
      let spec = logger
        .runs()
        .test_spec_path(&e.id)
        .and_then(|p| TestSpec::from_yaml_file(&p).ok());
      // Auto-runnable is not the same as having anything to drive. A spec
      // whose FIRST step is declared manual has an empty automatable prefix:
      // `--auto` would mint a key, boot a browser, execute zero actions, then
      // report INCOMPLETE — a session, a run folder and a ledger entry for a
      // test nobody drove. That is the same judgement as "the runner cannot
      // take this spec", so it is reported the same way, by name and with the
      // step that stops it. `run_report::auto_skip` is that judgement, shared with
      // `spec.accounts` so the lane scheduler and the runner agree; `auto_skip`
      // below lets an agent lane take the manual-first specs.
      if let Some(skip) = auto_skip(spec.as_ref(), agent_lane) {
        skipped += 1;
        match (
          &skip.reason,
          spec.as_ref().and_then(TestSpec::first_manual_step),
        ) {
          (run_report::SkipReason::FirstStepManual, Some((_, step))) => info!(
            "  skip (nothing to drive — first step `{}` is manual): {}",
            step.id, e.id
          ),
          _ => info!("  skip (not auto-runnable): {}", e.id),
        }
        jobs.push(Job::Skipped(SpecReport::skipped(e.id, e.group, skip)));
        continue;
      }
    }
    let mut a = args.clone();
    a.test = Some(e.id.clone());
    a.file = None;
    a.name = None;
    a.group = None;
    a.all = false;
    jobs.push(Job::Run {
      name: e.id,
      group: e.group,
      args: a,
    });
  }

  if args.auto && skipped > 0 {
    info!("skipped {skipped} spec(s) with nothing headless to drive in {label}");
  }
  run_jobs(ctx, args.auto, label, jobs, profile, rc, profile_out).await
}

/// Why a batch `--auto` run declines a spec, or `None` when it runs it.
///
/// [`run_report::auto_skip`] is the judgement (see the call site): a spec
/// that does not load, is not auto-runnable, or whose FIRST step is declared
/// manual has nothing headless to drive — unless the host has an agent lane,
/// where an agent drives the manual-first spec. An agent does not make an
/// unreadable or non-auto-runnable spec runnable.
fn auto_skip(spec: Option<&TestSpec>, agent_lane: bool) -> Option<run_report::AutoSkip> {
  run_report::auto_skip(spec)
    .filter(|skip| !(agent_lane && skip.reason == run_report::SkipReason::FirstStepManual))
}

/// Recursively collect runnable specs under `dir` — both the flat legacy
/// `*.user-test.yaml` files and the corpus `spec.yaml` files.
fn collect_specs(dir: &Path, out: &mut Vec<PathBuf>) -> tento_sh::Result<()> {
  for entry in std::fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))? {
    let path = entry.context("read dir entry")?.path();
    if path.is_dir() {
      collect_specs(&path, out)?;
    } else if path
      .file_name()
      .and_then(|n| n.to_str())
      .is_some_and(|n| n.ends_with(".user-test.yaml") || n == "spec.yaml")
    {
      out.push(path);
    }
  }
  Ok(())
}

// ===========================================================================
// ux-test spec.accounts
// ===========================================================================

/// Arguments for `ux-test spec.accounts`.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct SpecAccountsArgs {
  /// The `.ux-tests` corpus root. Absent ⇒ this host's configured corpus.
  root: Option<String>,
  /// Only tests in this group (`-` or empty = ungrouped, `.scratch` = the
  /// throwaway zone).
  group: Option<String>,
  /// Only this test.
  test: Option<String>,
  /// Also include the `.scratch` zone's kept-local tests.
  #[serde(default)]
  scratch: bool,
}

/// For each spec in a selection: its id, group, whether `--auto` would skip it
/// (and why), and the account its `params.user_email` names — `null` when it
/// names none, `"unknown"` when the spec does not parse. Read with the same YAML
/// parser the runner loads specs with, so the lane scheduler and the runner
/// cannot disagree about a spec's account.
#[tento_sh::command(
  name = "spec.accounts",
  description = "List each spec's declared account (params.user_email) and whether --auto skips it"
)]
pub async fn spec_accounts(
  ctx: UxTestCtx,
  args: Option<SpecAccountsArgs>,
) -> tento_sh::Result<serde_json::Value> {
  let args = args.unwrap_or_default();
  let root = match args.root.as_deref() {
    Some(root) => PathBuf::from(root),
    None => ctx
      .env()
      .ux_tests_dir()
      .context("no .ux-tests root is configured on this host; pass --root")?,
  };
  let document = spec_accounts_at(
    &root,
    args.group.as_deref(),
    args.test.as_deref(),
    args.scratch,
  )?;
  Ok(serde_json::to_value(document).context("serialise spec.accounts")?)
}

/// The body of `spec.accounts`, over an explicit corpus root.
fn spec_accounts_at(
  root: &Path,
  group: Option<&str>,
  test: Option<&str>,
  scratch: bool,
) -> anyhow::Result<SpecAccounts> {
  let folder = crate::folder::ux_tests::Folder::load_unchecked(root)
    .map_err(|e| anyhow::anyhow!("load {}: {e}", root.display()))?;
  let include_scratch = scratch || group == Some(SCRATCH_TEST_ID);
  let mut entries = if group == Some(SCRATCH_TEST_ID) {
    Vec::new()
  } else {
    folder
      .tests()
      .map_err(|e| anyhow::anyhow!("read .ux-tests: {e}"))?
  };
  if include_scratch {
    entries.extend(
      folder
        .scratch_tests()
        .map_err(|e| anyhow::anyhow!("read .ux-tests/.scratch: {e}"))?,
    );
  }
  if let Some(g) = group.filter(|g| *g != SCRATCH_TEST_ID) {
    let want_ungrouped = g.is_empty() || g == "-";
    entries.retain(|e| {
      if want_ungrouped {
        e.group.is_none()
      } else {
        e.group.as_deref() == Some(g)
      }
    });
  }
  if let Some(t) = test {
    entries.retain(|e| e.id == t);
  }
  let specs = entries
    .into_iter()
    .map(|e| {
      let text = std::fs::read_to_string(e.folder.root().join("spec.yaml")).ok();
      SpecAccountEntry::from_yaml(e.id, e.group, text.as_deref())
    })
    .collect();
  Ok(SpecAccounts {
    kind: SPEC_ACCOUNTS_TYPE.to_string(),
    root: root.to_path_buf(),
    specs,
  })
}

// ===========================================================================
// ux-test migrate
// ===========================================================================

/// Arguments for the one-shot corpus migration.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct MigrateArgs {
  /// Source dir of legacy `*.user-test.yaml` specs (default: `__user_tests`).
  from: Option<String>,
  /// Parse + report the mapping without writing anything. CLI: `--dry-run`.
  #[serde(default)]
  dry_run: bool,
}

/// Migrate the legacy flat `__user_tests/**.user-test.yaml` corpus into the
/// per-test `.ux-tests/<spec.id>/spec.yaml` layout. Keyed by `spec.id` (stable
/// + already unique), so a re-run is idempotent and path moves in the source
/// don't matter. Refuses to write on any duplicate id. The source tree is left
/// untouched (one release as a fallback).
#[tento_sh::command(
  name = "migrate",
  description = "Migrate __user_tests/*.user-test.yaml into the .ux-tests corpus (keyed by spec.id)"
)]
pub async fn migrate(ctx: UxTestCtx, args: Option<MigrateArgs>) -> tento_sh::Result<()> {
  let args = args.unwrap_or_default();
  let from = PathBuf::from(args.from.as_deref().unwrap_or("__user_tests"));
  let dest = ctx
    .env()
    .ux_tests_dir()
    .context("no .ux-tests root is configured on this host")?;

  let mut files = Vec::new();
  collect_specs(&from, &mut files)?;
  files.sort();
  if files.is_empty() {
    return Err(anyhow::anyhow!("no *.user-test.yaml under {}", from.display()).into());
  }

  // Parse + key by spec.id; collect collisions instead of silently overwriting.
  let mut by_id: std::collections::BTreeMap<String, (PathBuf, TestSpec)> =
    std::collections::BTreeMap::new();
  let mut collisions: Vec<(String, PathBuf, PathBuf)> = Vec::new();
  for file in &files {
    let spec =
      TestSpec::from_yaml_file(file).with_context(|| format!("parse {}", file.display()))?;
    match by_id.get(&spec.id) {
      Some((prev, _)) => collisions.push((spec.id.clone(), prev.clone(), file.clone())),
      None => {
        by_id.insert(spec.id.clone(), (file.clone(), spec));
      }
    }
  }
  if !collisions.is_empty() {
    let mut msg = String::from("duplicate spec ids — refusing to migrate:\n");
    for (id, a, b) in &collisions {
      msg.push_str(&format!("  {id}: {} <> {}\n", a.display(), b.display()));
    }
    return Err(anyhow::anyhow!(msg).into());
  }

  println!(
    "migrate: {} test(s) {} -> {}{}",
    by_id.len(),
    from.display(),
    dest.display(),
    if args.dry_run { "  (dry-run)" } else { "" }
  );
  for (id, (src, spec)) in &by_id {
    let spec_yaml =
      serde_yml::to_string(spec).map_err(|e| anyhow::anyhow!("serialize {id}: {e}"))?;
    let spec_path = dest.join(id).join("spec.yaml");
    if args.dry_run {
      println!("  [dry] {} -> {}/spec.yaml", src.display(), id);
      continue;
    }
    if let Some(parent) = spec_path.parent() {
      std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
    }
    std::fs::write(&spec_path, spec_yaml)
      .with_context(|| format!("write {}", spec_path.display()))?;
    println!("  {} -> {}/spec.yaml", src.display(), id);
  }
  println!(
    "migrate: {} ({} written; {} left in place as fallback).",
    if args.dry_run {
      "dry-run complete"
    } else {
      "done"
    },
    if args.dry_run { 0 } else { by_id.len() },
    from.display()
  );
  Ok(())
}

#[cfg(test)]
mod persona_tests {
  use std::collections::HashMap;

  /// The host's default account. Which address a real host names is its own
  /// business (lona's demo persona is tested next to lona's `UxTestEnv` impl);
  /// what is tested here is the precedence around it.
  const HOST_DEFAULT: &str = "host-default@example.test";

  /// Mirrors the `user` resolution in `run`: `--user` › the spec's declared
  /// `params.user_email` › the host's default account.
  fn resolve(
    user_arg: Option<&str>,
    params: &HashMap<String, String>,
    host_default: Option<&str>,
  ) -> Option<String> {
    super::resolve_user(
      user_arg,
      params.get("user_email").map(String::as_str),
      || host_default.map(str::to_string),
    )
    .map(|(user, _)| user)
  }

  #[test]
  fn the_resolved_account_says_where_it_came_from() {
    use crate::report::UserSource;
    let source = |flag, declared, default: Option<&str>| {
      super::resolve_user(flag, declared, || default.map(str::to_string)).map(|(_, s)| s)
    };
    assert_eq!(
      source(Some("a@b.c"), Some("a@b.c"), None),
      Some(UserSource::Flag)
    );
    assert_eq!(
      source(None, Some("a@b.c"), Some(HOST_DEFAULT)),
      Some(UserSource::Spec)
    );
    assert_eq!(
      source(None, None, Some(HOST_DEFAULT)),
      Some(UserSource::HostDefault)
    );
    assert_eq!(source(None, None, None), None);
  }

  fn with_user(email: &str) -> HashMap<String, String> {
    HashMap::from([("user_email".to_string(), email.to_string())])
  }

  #[test]
  fn declared_account_is_used_when_no_flag_is_passed() {
    assert_eq!(
      resolve(
        None,
        &with_user("operator-tester@lona.so"),
        Some(HOST_DEFAULT)
      )
      .as_deref(),
      Some("operator-tester@lona.so")
    );
  }

  #[test]
  fn explicit_flag_still_overrides_the_spec() {
    assert_eq!(
      resolve(
        Some("someone-else@lona.so"),
        &with_user("operator-tester@lona.so"),
        Some(HOST_DEFAULT)
      )
      .as_deref(),
      Some("someone-else@lona.so")
    );
  }

  #[test]
  fn a_spec_that_declares_nothing_takes_the_hosts_default() {
    assert_eq!(
      resolve(None, &HashMap::new(), Some(HOST_DEFAULT)).as_deref(),
      Some(HOST_DEFAULT)
    );
  }

  /// A host with no default account leaves nothing to drive, and the run has to
  /// stop before minting a key for an account that was never chosen.
  #[test]
  fn a_host_without_a_default_account_resolves_nothing() {
    assert_eq!(resolve(None, &HashMap::new(), None), None);
  }

  /// The 2026-08-12 shape: drive as one account, assert against another. It has
  /// to stop the run, because nothing downstream can tell it went wrong.
  #[test]
  fn disagreeing_account_channels_refuse_to_run() {
    let err =
      super::check_account_agreement(Some("maya.chen@gmail.com"), Some("operator-tester@lona.so"))
        .unwrap_err()
        .to_string();
    assert!(err.contains("account mismatch"), "{err}");
    assert!(err.contains("maya.chen@gmail.com"), "{err}");
    assert!(err.contains("operator-tester@lona.so"), "{err}");
  }

  #[test]
  fn one_channel_or_agreeing_channels_are_fine() {
    let ok = |f, d| super::check_account_agreement(f, d).is_ok();
    assert!(ok(None, None), "neither: falls through to the host default");
    assert!(ok(Some("a@b.c"), None), "--user alone");
    assert!(ok(None, Some("a@b.c")), "declared alone");
    assert!(ok(Some("a@b.c"), Some("a@b.c")), "both, agreeing");
  }
}

#[cfg(test)]
mod report_wiring_tests {
  use super::{ArtifactFlags, resolve_artifact, spec_accounts_at};

  #[test]
  fn spec_accounts_reads_a_corpus_with_the_real_parser() {
    let root = std::env::temp_dir().join(format!("ux-spec-accounts-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let write = |rel: &str, body: &str| {
      let path = root.join(rel).join("spec.yaml");
      std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
      std::fs::write(path, body).expect("write spec");
    };
    write(
      "events/names-one",
      "id: names-one\nname: A\ninstructions: []\nparams:\n  user_email: operator-tester@lona.so\n",
    );
    write(
      "events/names-none",
      "id: names-none\nname: B\ninstructions: []\n",
    );
    write("broken", "id: broken\nname: [unterminated\n");

    let all = spec_accounts_at(&root, None, None, false).expect("spec.accounts");
    let json = serde_json::to_value(&all).expect("serialise");
    assert_eq!(json["type"], "ux-test.spec-accounts/v1");
    let user = |id: &str| {
      json["specs"]
        .as_array()
        .expect("specs")
        .iter()
        .find(|s| s["id"] == id)
        .unwrap_or_else(|| panic!("{id} listed"))["user"]
        .clone()
    };
    assert_eq!(
      user("names-one"),
      serde_json::json!("operator-tester@lona.so")
    );
    assert_eq!(user("names-none"), serde_json::Value::Null);
    assert_eq!(user("broken"), serde_json::json!("unknown"));

    let grouped = spec_accounts_at(&root, Some("events"), None, false).expect("group");
    assert_eq!(grouped.specs.len(), 2);
    assert!(
      grouped
        .specs
        .iter()
        .all(|s| s.group.as_deref() == Some("events"))
    );
    let one = spec_accounts_at(&root, None, Some("broken"), false).expect("test");
    assert_eq!(one.specs.len(), 1);
    assert_eq!(one.specs[0].group, None);

    let _ = std::fs::remove_dir_all(&root);
  }

  fn no_flags() -> ArtifactFlags<'static> {
    ArtifactFlags {
      product: None,
      version: None,
      sha: None,
      stem: None,
      fingerprint: None,
    }
  }

  #[test]
  fn the_artifact_comes_from_flags_then_env_then_nowhere() {
    assert_eq!(resolve_artifact(&no_flags(), None).expect("none"), None);

    let env = r#"{"product":"tsh","version":"0.1.35","sha":"abc123","stem":"tsh-0.1.35"}"#;
    let from_env = resolve_artifact(&no_flags(), Some(env.to_string()))
      .expect("env")
      .expect("stamped");
    assert_eq!(from_env.git_hash, "abc123");
    assert_eq!(from_env.stem.as_deref(), Some("tsh-0.1.35"));

    let flags = ArtifactFlags {
      product: Some("lona"),
      version: Some("1.0.87"),
      sha: Some("def456"),
      ..no_flags()
    };
    let from_flags = resolve_artifact(&flags, Some(env.to_string()))
      .expect("flags")
      .expect("stamped");
    assert_eq!(from_flags.product, "lona", "flags win over the env");

    let partial = ArtifactFlags {
      version: Some("1.0.87"),
      ..no_flags()
    };
    assert!(resolve_artifact(&partial, None).is_err());
    assert!(resolve_artifact(&no_flags(), Some("not json".to_string())).is_err());
    assert!(
      resolve_artifact(
        &no_flags(),
        Some(r#"{"product":"","version":"1","gitHash":"a"}"#.to_string())
      )
      .is_err()
    );
  }
}

#[cfg(test)]
mod env_names_tests {
  use super::env_names;

  #[test]
  fn absent_is_the_builtin_once() {
    assert_eq!(env_names(None), vec![None]);
    assert_eq!(env_names(Some("")), vec![None]);
    assert_eq!(env_names(Some(" , ")), vec![None]);
  }

  #[test]
  fn splits_trims_and_keeps_the_authors_order() {
    assert_eq!(
      env_names(Some("dev, rc,,prod,")),
      vec![
        Some("dev".to_string()),
        Some("rc".to_string()),
        Some("prod".to_string())
      ]
    );
  }

  #[test]
  fn drops_a_repeat_rather_than_running_it_twice() {
    assert_eq!(
      env_names(Some("rc,dev,rc")),
      vec![Some("rc".to_string()), Some("dev".to_string())]
    );
  }
}

#[cfg(test)]
mod verb_tests {
  use serde_json::json;

  use super::{VerbArgs, lone_verb_params, run_lone_verb};
  use crate::HostPort;

  fn argv(words: &[&str]) -> Vec<String> {
    std::iter::once("verb")
      .chain(words.iter().copied())
      .map(str::to_string)
      .collect()
  }

  /// What the dispatcher hands the command: the same `parse_arguments` the
  /// `#[command]` derive calls, into the command's `Option<VerbArgs>`.
  fn parse(words: &[&str]) -> tento_sh::Result<Option<VerbArgs>> {
    tento_sh::parse_arguments::<Option<VerbArgs>>(argv(words))
  }

  /// The release-ci pool-teardown spelling: the verb as a positional, the
  /// params as a flag.
  #[test]
  fn positional_verb_with_params_flag_parses() {
    let args = parse(&[
      "delete_user_if_exists",
      "--params",
      r#"{"user":"ux-lane1-0a1b2c3d@lona.so"}"#,
    ])
    .unwrap()
    .unwrap();
    assert_eq!(args.action, "delete_user_if_exists");
    assert_eq!(
      lone_verb_params(args.params).unwrap(),
      json!({ "user": "ux-lane1-0a1b2c3d@lona.so" })
    );
  }

  #[test]
  fn named_action_form_parses_to_the_same_call() {
    let args = parse(&[
      "--action",
      "delete_user_if_exists",
      "--params",
      r#"{"user":"ux-lane1-0a1b2c3d@lona.so"}"#,
    ])
    .unwrap()
    .unwrap();
    assert_eq!(args.action, "delete_user_if_exists");
    assert_eq!(
      lone_verb_params(args.params).unwrap(),
      json!({ "user": "ux-lane1-0a1b2c3d@lona.so" })
    );
  }

  #[test]
  fn a_bare_verb_takes_empty_params() {
    let args = parse(&["set_payment_testing_mode"]).unwrap().unwrap();
    assert_eq!(args.action, "set_payment_testing_mode");
    assert_eq!(lone_verb_params(args.params).unwrap(), json!({}));
  }

  #[test]
  fn params_that_are_not_a_json_object_are_refused() {
    let err = lone_verb_params(Some(json!("{not json"))).unwrap_err();
    assert!(format!("{err:#}").contains("not valid JSON"), "{err:#}");
    let err = lone_verb_params(Some(json!([1, 2]))).unwrap_err();
    assert!(
      format!("{err:#}").contains("must be a JSON object"),
      "{err:#}"
    );
    let err = lone_verb_params(Some(json!("\"a string\""))).unwrap_err();
    assert!(
      format!("{err:#}").contains("must be a JSON object"),
      "{err:#}"
    );
  }

  #[test]
  fn store_as_is_refused_as_spec_plumbing() {
    let err = lone_verb_params(Some(json!({ "user": "u@x.test", "store_as": "p" }))).unwrap_err();
    assert!(format!("{err:#}").contains("store_as"), "{err:#}");
  }

  /// The protected-delete opt-in is refused whatever its value and however
  /// `--params` arrives (parsed object or raw JSON text).
  #[test]
  fn the_protected_delete_opt_in_is_refused() {
    for params in [
      json!({ "user": "operator-tester@lona.so", "allow_destroy_protected_user": true }),
      json!({ "user": "u@x.test", "allow_destroy_protected_user": false }),
      json!({ "allow_destroy_protected_user": null }),
      json!(r#"{"user":"operator-tester@lona.so","allow_destroy_protected_user":true}"#),
      json!({ "user": "operator-tester@lona.so", "allow_mutate_protected_user": true }),
      json!({ "allow_mutate_protected_user": false }),
    ] {
      let err = lone_verb_params(Some(params.clone())).unwrap_err();
      let text = format!("{err:#}");
      assert!(
        text.contains("_protected_user") && text.contains("refuses"),
        "{params}: {text}"
      );
    }
  }

  /// A fake host: answers `delete_user_if_exists` with the params it was sent,
  /// and anything else with an error, recording every action it saw.
  fn fake_port(
    verbs: &[&str],
  ) -> (
    HostPort,
    tokio::task::JoinHandle<Vec<(String, serde_json::Value)>>,
  ) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<crate::VerbRequest>();
    let port = HostPort::new(verbs.iter().map(|v| v.to_string()).collect(), tx);
    let host = tokio::spawn(async move {
      let mut seen = Vec::new();
      while let Some(request) = rx.recv().await {
        seen.push((request.action.clone(), request.params.clone()));
        let answer = if request.action == "delete_user_if_exists" {
          Ok(json!({ "deleted": true, "echo": request.params }))
        } else {
          Err(anyhow::anyhow!(
            "REFUSED: host said no to '{}'",
            request.action
          ))
        };
        let _ = request.reply.send(answer);
      }
      seen
    });
    (port, host)
  }

  #[tokio::test]
  async fn a_known_verb_reaches_the_host_with_its_params_verbatim() {
    let (port, host) = fake_port(&["delete_user_if_exists", "delete_user"]);
    let result = run_lone_verb(
      &port,
      "delete_user_if_exists",
      Some(json!({ "user": "ux-lane1-0a1b2c3d@lona.so" })),
    )
    .await
    .unwrap();
    assert_eq!(
      result,
      json!({ "deleted": true, "echo": { "user": "ux-lane1-0a1b2c3d@lona.so" } })
    );
    drop(port);
    assert_eq!(
      host.await.unwrap(),
      vec![(
        "delete_user_if_exists".to_string(),
        json!({ "user": "ux-lane1-0a1b2c3d@lona.so" })
      )]
    );
  }

  /// An unknown verb — including the machinery-only ones a host keeps out of
  /// its corpus vocabulary — is refused before anything is sent.
  #[tokio::test]
  async fn an_unknown_verb_is_refused_and_never_sent() {
    let (port, host) = fake_port(&["delete_user_if_exists"]);
    for action in ["delete_user_if_exist", "mint_api_key"] {
      let err = run_lone_verb(&port, action, None).await.unwrap_err();
      let text = format!("{err:#}");
      assert!(text.contains(&format!("unknown verb '{action}'")), "{text}");
      assert!(
        text.contains("delete_user_if_exists"),
        "names the vocabulary: {text}"
      );
    }
    drop(port);
    assert!(host.await.unwrap().is_empty(), "nothing reached the host");
  }

  /// The host's own refusal (lona's protected-account guard, say) is the
  /// command's error — it is not swallowed the way a spec teardown swallows it.
  #[tokio::test]
  async fn a_host_error_is_the_commands_error() {
    let (port, host) = fake_port(&["delete_user"]);
    let err = run_lone_verb(
      &port,
      "delete_user",
      Some(json!({ "user": "someone@gmail.com" })),
    )
    .await
    .unwrap_err();
    let text = format!("{err:#}");
    assert!(text.contains("verb 'delete_user' failed"), "{text}");
    assert!(text.contains("REFUSED"), "{text}");
    drop(port);
    assert_eq!(host.await.unwrap().len(), 1);
  }

  /// P1-UXVERB-O: `allow_destroy_protected_user` never reaches the host — for
  /// the destructive user verbs and for any other known verb alike. The fake
  /// host would answer `delete_user_if_exists` with success, so an empty
  /// record is the only thing that proves `execute_verb` was never called.
  #[tokio::test]
  async fn the_protected_delete_opt_in_is_never_sent_to_the_host() {
    let verbs = [
      "delete_user_if_exists",
      "delete_user",
      "reset_for_test",
      "set_payment_testing_mode",
    ];
    let (port, host) = fake_port(&verbs);
    for action in verbs {
      for params in [
        json!({ "user": "operator-tester@lona.so", "allow_destroy_protected_user": true }),
        json!(r#"{"user":"operator-tester@lona.so","allow_destroy_protected_user":true}"#),
        json!({ "allow_destroy_protected_user": false }),
        json!({ "user": "operator-tester@lona.so", "allow_mutate_protected_user": true }),
      ] {
        let err = run_lone_verb(&port, action, Some(params.clone()))
          .await
          .unwrap_err();
        let text = format!("{err:#}");
        assert!(
          text.contains("_protected_user") && text.contains("nothing was sent"),
          "{action} {params}: {text}"
        );
      }
    }
    drop(port);
    assert!(
      host.await.unwrap().is_empty(),
      "execute_verb must never be called with the protected-delete opt-in"
    );
  }
}

/// The agent driver end to end against a fixture queue: the agent is a
/// closure, the browser is a guard with no process, and the session store is a
/// temp dir — everything else (finalize, teardown, verification, agent.json,
/// the exit mapping) is the code `run --auto` runs.
#[cfg(test)]
mod agent_drive_tests {
  use std::path::PathBuf;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::sync::{Arc, Mutex};
  use std::time::Duration;

  use serde_json::{Value, json};
  use tento_agent_queue::{AgentQueue, FixtureBackend, NewJob};

  use super::*;
  use crate::agent::{AgentConfig, BrowserGuard, BrowserLaunch, Timing};
  use crate::orchestration::{HostPort, SessionTarget, UxTestEnv};
  use crate::session::SessionResult;

  struct TestEnv {
    dir: PathBuf,
  }

  impl UxTestEnv for TestEnv {
    fn llm_logger_dir(&self) -> PathBuf {
      self.dir.clone()
    }
    fn loaf_logs_dir(&self) -> Option<PathBuf> {
      None
    }
    fn server_host(&self) -> Option<String> {
      None
    }
    fn resolve_session_target(
      &self,
      _url_pattern: &Option<String>,
      initial_path: Option<&str>,
      _server_host_override: Option<&str>,
    ) -> anyhow::Result<SessionTarget> {
      Ok(SessionTarget::from_full_host(
        "app.example.test".into(),
        initial_path,
      ))
    }
  }

  /// Hands out guards with no browser behind them, counting launches and
  /// keeping the URL each browser was started on.
  #[derive(Default)]
  struct FakeLauncher {
    launches: AtomicUsize,
    urls: Mutex<Vec<String>>,
    fail: bool,
  }

  #[async_trait::async_trait]
  impl LaunchBrowser for FakeLauncher {
    async fn launch(&self, launch: &BrowserLaunch) -> anyhow::Result<BrowserGuard> {
      self.launches.fetch_add(1, Ordering::SeqCst);
      self.urls.lock().unwrap().push(launch.url.clone());
      if self.fail {
        anyhow::bail!("the profile is in use");
      }
      Ok(BrowserGuard::detached())
    }
  }

  const SPEC: &str = "id: consent\nname: Consent\ntimeout: 2\nsteps:\n  - id: sign-in\n    \
    instruction: sign in with Google\n    manual: true\n    manual_reason: third-party consent screen\n\
    teardown:\n  - action: reset_for_test\n    user: tester@example.test\n\
    verification:\n  auto_fail_on_errors: false\n";

  struct Rig {
    ctx: UxTestCtx,
    logger: LLMLogger,
    spec: TestSpec,
    session_id: String,
    tracing_uuid: Uuid,
    teardown_verbs: Arc<Mutex<Vec<String>>>,
    dir: PathBuf,
  }

  impl Drop for Rig {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.dir);
    }
  }

  fn rig(spec_yaml: &str) -> Rig {
    let dir = std::env::temp_dir().join(format!("ux-agent-drive-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<orchestration::VerbRequest>();
    let teardown_verbs = Arc::new(Mutex::new(Vec::new()));
    let seen = teardown_verbs.clone();
    tokio::spawn(async move {
      while let Some(request) = rx.recv().await {
        seen.lock().unwrap().push(request.action.clone());
        let _ = request.reply.send(Ok(json!(true)));
      }
    });
    let ctx = UxTestCtx::new(
      Arc::new(TestEnv { dir: dir.clone() }),
      HostPort::new(vec!["reset_for_test".to_string()], tx),
    );
    let logger = ctx.logger();
    let spec = TestSpec::from_yaml(spec_yaml).unwrap();
    let session_id = format!(
      "2026-09-26_consent_{}",
      &Uuid::new_v4().simple().to_string()[..6]
    );
    let tracing_uuid = Uuid::new_v4();
    let session = Session {
      id: session_id.clone(),
      prefix: spec.name.clone(),
      instructions: spec.substituted_instructions(),
      metadata: Some(json!({"targetOrigin": "https://app.example.test"})),
      status: SessionStatus::Pending,
      created_at: Utc::now(),
      flaky: None,
      tracing_uuid: Some(tracing_uuid),
      display_params: None,
      test_id: None,
      completed_steps: Vec::new(),
    };
    logger.create_session_with_spec(&session, &spec).unwrap();
    Rig {
      ctx,
      logger,
      spec,
      session_id,
      tracing_uuid,
      teardown_verbs,
      dir,
    }
  }

  fn quick() -> Timing {
    Timing {
      queue_wait: Duration::from_secs(2),
      run_budget: Duration::from_secs(1),
      completion_grace: Duration::from_secs(1),
      job_grace: Duration::from_secs(2),
      poll: Duration::from_millis(20),
    }
  }

  fn config() -> AgentConfig {
    AgentConfig {
      lane: "ux-browser".into(),
      browser: std::env::current_exe().unwrap(),
      user_data_dir: None,
      queue_wait: None,
      google_signin: None,
      microsoft_signin: None,
    }
  }

  /// A sign-in pre-step that answers `outcome` and counts its runs.
  struct FakeSignIn {
    outcome: agent::SigninOutcome,
    runs: AtomicUsize,
  }

  impl FakeSignIn {
    fn new(outcome: agent::SigninOutcome) -> Self {
      Self {
        outcome,
        runs: AtomicUsize::new(0),
      }
    }
  }

  #[async_trait::async_trait]
  impl agent::SignIn for FakeSignIn {
    async fn sign_in(
      &self,
      _devtools_port: u16,
      _out_dir: &Path,
      _workspace: &Path,
    ) -> agent::SigninOutcome {
      self.runs.fetch_add(1, Ordering::SeqCst);
      self.outcome.clone()
    }
  }

  async fn drive(
    rig: &Rig,
    queue: AgentQueue,
    launcher: &FakeLauncher,
    timing: Timing,
  ) -> tento_sh::Result<RunOutcome> {
    drive_with(rig, queue, launcher, timing, None).await
  }

  async fn drive_with(
    rig: &Rig,
    queue: AgentQueue,
    launcher: &FakeLauncher,
    timing: Timing,
    signin: Option<&dyn agent::SignIn>,
  ) -> tento_sh::Result<RunOutcome> {
    drive_on(
      rig,
      queue,
      launcher,
      timing,
      signin,
      &FakeSink::default(),
      &EnvProfile::builtin_local(),
    )
    .await
  }

  async fn drive_on(
    rig: &Rig,
    queue: AgentQueue,
    launcher: &FakeLauncher,
    timing: Timing,
    signin: Option<&dyn agent::SignIn>,
    sink: &FakeSink,
    profile: &EnvProfile,
  ) -> tento_sh::Result<RunOutcome> {
    run_agent_driven(
      &rig.ctx,
      &rig.logger,
      AgentDrive {
        config: config(),
        queue,
        launcher,
        timing,
        signin,
        harness_sink: sink,
      },
      AgentSession {
        session_id: &rig.session_id,
        spec: &rig.spec,
        tracing_uuid: rig.tracing_uuid,
        target_origin: "https://app.example.test".into(),
        host_only: "app.example.test".into(),
        url: format!("https://app.example.test/?ux={}&tid=t", rig.session_id),
        user: Some("tester@example.test".into()),
        human: Human::STDOUT,
        artifact: None,
      },
      profile,
    )
    .await
  }

  /// How a fake sink behaves once started.
  #[derive(Clone, Copy, Default, PartialEq)]
  enum SinkMode {
    /// Ready, and runs until stopped.
    #[default]
    Runs,
    /// Refuses to start.
    Fails,
    /// Ready, then exits on its own a moment later.
    Exits,
  }

  /// A harness-post sink with no Deno behind it, recording what it was asked.
  #[derive(Default)]
  struct FakeSink {
    mode: SinkMode,
    starts: Mutex<Vec<agent::HarnessSinkPlan>>,
  }

  #[async_trait::async_trait]
  impl agent::StartHarnessSink for FakeSink {
    async fn start(
      &self,
      _devtools_port: u16,
      plan: &agent::HarnessSinkPlan,
    ) -> anyhow::Result<agent::HarnessSinkGuard> {
      self.starts.lock().unwrap().push(plan.clone());
      match self.mode {
        SinkMode::Runs => Ok(agent::HarnessSinkGuard::detached()),
        SinkMode::Fails => anyhow::bail!("harness-sink: error connect ECONNREFUSED"),
        SinkMode::Exits => Ok(agent::HarnessSinkGuard::from_child(
          tokio::process::Command::new("sh")
            .args(["-c", "sleep 0.2; exit 1"])
            .kill_on_drop(true)
            .spawn()
            .unwrap(),
        )),
      }
    }
  }

  /// A named profile: the page origin is another server, so a sink runs.
  fn rc_profile() -> EnvProfile {
    let mut profile = EnvProfile::builtin_local();
    profile.name = "rc".to_string();
    profile
  }

  fn agent_json(rig: &Rig) -> Value {
    let dir = rig.logger.session_dir(&rig.session_id).unwrap();
    serde_json::from_str(&std::fs::read_to_string(dir.join("agent.json")).unwrap()).unwrap()
  }

  fn verification(rig: &Rig) -> Value {
    let dir = rig.logger.session_dir(&rig.session_id).unwrap();
    serde_json::from_str(&std::fs::read_to_string(dir.join("verification.json")).unwrap()).unwrap()
  }

  /// The agent that did its job: it completed the in-page harness, then said so.
  fn completing_agent(rig: &Rig, result: SessionResult) -> AgentQueue {
    let logger = rig.logger.clone();
    let session = rig.session_id.clone();
    let backend = FixtureBackend::with_delay(
      move |job: &NewJob| {
        assert!(job.work.contains(&session), "the prompt names the session");
        // The job's workspace is the run's own agent dir, absolute.
        let cwd = PathBuf::from(job.agent.cwd.as_deref().expect("a workspace"));
        assert!(
          cwd.is_absolute() && cwd.ends_with("agent"),
          "{}",
          cwd.display()
        );
        assert!(job.work.contains(&format!("WORK_DIR: {}", cwd.display())));
        // Long enough to be seen running, which is when the browser starts.
        // `block_in_place`: a plain sleep would stall the runtime's timers.
        tokio::task::block_in_place(|| std::thread::sleep(Duration::from_millis(200)));
        logger.mark_complete(&session, result.clone(), None)?;
        Ok(json!(format!("done.\nRESULT consent completed {session}")))
      },
      Duration::from_millis(10),
    );
    AgentQueue::new(Arc::new(backend), "default", agent::PRODUCER)
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn an_agent_that_completes_the_session_passes_on_verification() {
    let rig = rig(SPEC);
    let launcher = FakeLauncher::default();
    let outcome = drive(
      &rig,
      completing_agent(&rig, SessionResult::Success),
      &launcher,
      quick(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.outcome, Outcome::Pass, "{:?}", outcome.agent);
    assert!(outcome.agent.as_deref().unwrap().starts_with("passed:"));
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    assert_eq!(verification(&rig)["outcome"], "passed");
    let record = agent_json(&rig);
    assert_eq!(record["type"], "ux-test.agent-run/v1");
    assert_eq!(record["end"], "session-completed");
    assert_eq!(record["state"], "succeeded");
    assert_eq!(record["lane"], "ux-browser");
    assert_eq!(record["result"]["kind"], "completed");
    assert_eq!(record["verification"], "passed");
    assert!(record["canceled"].is_null());
    // No pre-step configured: agent.json is exactly what it was.
    assert!(record.get("googleSignin").is_none());
    // Finalize ran the spec's teardown.
    assert_eq!(*rig.teardown_verbs.lock().unwrap(), ["reset_for_test"]);
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_signed_in_pre_step_hands_the_profile_to_the_agent() {
    let rig = rig(SPEC);
    let launcher = FakeLauncher::default();
    let signin = FakeSignIn::new(agent::SigninOutcome::Proceed {
      line: "google-signin: signed-in".into(),
    });
    let outcome = drive_with(
      &rig,
      completing_agent(&rig, SessionResult::Success),
      &launcher,
      quick(),
      Some(&signin),
    )
    .await
    .unwrap();
    assert_eq!(outcome.outcome, Outcome::Pass, "{:?}", outcome.agent);
    assert_eq!(signin.runs.load(Ordering::SeqCst), 1);
    // The pre-step's own browser, then the agent's.
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 2);
    let record = agent_json(&rig);
    assert_eq!(record["googleSignin"], "google-signin: signed-in");
    assert_eq!(record["end"], "session-completed");
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_sign_in_that_needs_a_human_ends_the_run_before_the_agent_browser() {
    let rig = rig(SPEC);
    let backend = FixtureBackend::with_delay(
      |_: &NewJob| {
        tokio::task::block_in_place(|| std::thread::sleep(Duration::from_millis(500)));
        Ok(json!(
          "RESULT consent unfinished browser-crash never had a browser"
        ))
      },
      Duration::from_millis(10),
    );
    let queue = AgentQueue::new(Arc::new(backend), "default", agent::PRODUCER);
    let launcher = FakeLauncher::default();
    let signin = FakeSignIn::new(agent::SigninOutcome::Blocked {
      blocker: "google-signin-needs-human".into(),
      line: "google-signin: needs-human challenge-totp".into(),
    });
    let outcome = drive_with(&rig, queue, &launcher, quick(), Some(&signin))
      .await
      .unwrap();
    assert_eq!(outcome.outcome, Outcome::Fail);
    assert_eq!(
      outcome.result,
      "unfinished (agent, google-signin-needs-human)"
    );
    assert!(
      outcome
        .agent
        .as_deref()
        .unwrap()
        .contains("google-signin: needs-human challenge-totp")
    );
    // Only the pre-step's browser: the agent's never started.
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    let record = agent_json(&rig);
    assert_eq!(record["end"], "google-signin");
    assert_eq!(record["canceled"], "google-signin");
    assert_eq!(
      record["googleSignin"],
      "google-signin: needs-human challenge-totp"
    );
    assert_eq!(verification(&rig)["outcome"], "not_run");
    // Setup's state does not outlive it.
    assert_eq!(*rig.teardown_verbs.lock().unwrap(), ["reset_for_test"]);
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_product_failure_the_agent_reported_fails_the_run() {
    let rig = rig(SPEC);
    let outcome = drive(
      &rig,
      completing_agent(&rig, SessionResult::Failure),
      &FakeLauncher::default(),
      quick(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.outcome, Outcome::Fail);
    assert!(outcome.agent.as_deref().unwrap().starts_with("failed:"));
    assert_eq!(agent_json(&rig)["end"], "session-completed");
  }

  /// Verification reads the account the spec's setup made (`assert_rows`), and
  /// teardown deletes that account, so teardown runs after verification: run
  /// first, it took the rows out from under the read (pomodoro-basic-flow kept
  /// its throwaway for this reason; review G2).
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn teardown_runs_after_verification_reads_the_rows() {
    let spec = SPEC.replace(
      "verification:\n  auto_fail_on_errors: false\n",
      "verification:\n  auto_fail_on_errors: false\n  assert_rows:\n    - description: the session cell\n      \
       user: tester@example.test\n      row_key: ':~lona:calendar:pomodoro:events'\n      \
       range:\n        start: '2026-01-01'\n        end: '2099-12-31'\n      \
       expect:\n        count: 1\n      retry_for_ms: 0\n",
    );
    let rig = rig(&spec);
    drive(
      &rig,
      completing_agent(&rig, SessionResult::Success),
      &FakeLauncher::default(),
      quick(),
    )
    .await
    .unwrap();
    assert_eq!(
      *rig.teardown_verbs.lock().unwrap(),
      ["read_cells", "reset_for_test"],
      "the row read runs before the teardown that deletes the account"
    );
  }

  /// A verification that errors (here: the trace cannot be read) still runs
  /// the teardown before the error ends the run, so the throwaway does not
  /// outlive it (review H F-1).
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn teardown_runs_when_verification_errors() {
    let spec = SPEC.replace(
      "verification:\n  auto_fail_on_errors: false\n",
      "verification:\n  required_logs:\n    - pattern: anything\n",
    );
    let rig = rig(&spec);
    // A directory where the trace file belongs: it exists, so verification
    // judges it, and reading it fails.
    std::fs::create_dir_all(
      rig
        .logger
        .session_dir(&rig.session_id)
        .unwrap()
        .join("trace.ljson"),
    )
    .unwrap();
    let outcome = drive(
      &rig,
      completing_agent(&rig, SessionResult::Success),
      &FakeLauncher::default(),
      quick(),
    )
    .await;
    assert!(
      outcome
        .as_ref()
        .map_or(true, |o| o.outcome != Outcome::Pass),
      "an erroring verification is no pass"
    );
    assert_eq!(*rig.teardown_verbs.lock().unwrap(), ["reset_for_test"]);
  }

  /// A headless drive that errors after setup still runs the teardown before
  /// the error ends the run (operator decision N-5a, 2026-10-19). Here the
  /// host has no ux-runner directory; on lona it was the mint, refused
  /// because setup had deleted operator-tester@lona.so, and the skipped
  /// teardown was the step that would have given the persona back.
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn teardown_runs_when_the_headless_drive_errors() {
    let spec = SPEC.replace(
      "steps:\n",
      "setup:\n  - action: reset_for_test\n    user: tester@example.test\nsteps:\n",
    );
    let rig = rig(&spec);
    let file = rig.dir.join("spec.yaml");
    std::fs::write(&file, &spec).unwrap();
    let args = UxTestRunArgs {
      file: Some(file.display().to_string()),
      auto: true,
      ..Default::default()
    };
    let rc = RunCtx {
      human: Human::STDOUT,
      artifact: None,
    };
    let mut spec_report = SpecReport::new(rig.spec.id.clone(), None);
    let err = run_single(
      &rig.ctx,
      args,
      &EnvProfile::builtin_local(),
      &rc,
      &mut spec_report,
    )
    .await
    .err()
    .expect("a host with no runner cannot drive headless");
    assert!(
      format!("{err:#}").contains("ux-runner"),
      "the drive's own error ends the run: {err:#}"
    );
    // Setup's reset, then the teardown's.
    assert_eq!(
      *rig.teardown_verbs.lock().unwrap(),
      ["reset_for_test", "reset_for_test"]
    );
  }

  /// `run_single` over a spec file in the rig's dir, with `args` on top of
  /// `--file` (review J-4/J-5).
  async fn run_file(rig: &Rig, spec: &str, args: UxTestRunArgs) -> tento_sh::Result<RunOutcome> {
    let file = rig.dir.join("spec.yaml");
    std::fs::write(&file, spec).unwrap();
    let args = UxTestRunArgs {
      file: Some(file.display().to_string()),
      ..args
    };
    let rc = RunCtx {
      human: Human::STDOUT,
      artifact: None,
    };
    let mut spec_report = SpecReport::new(rig.spec.id.clone(), None);
    run_single(
      &rig.ctx,
      args,
      &EnvProfile::builtin_local(),
      &rc,
      &mut spec_report,
    )
    .await
  }

  /// The second branch of the same fix (review J-4): the wait for completion
  /// errors (here a manual run nobody completes, past the spec's 2 s
  /// timeout), and the teardown still runs before the error ends the run.
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn teardown_runs_when_the_completion_wait_errors() {
    let spec = SPEC.replace(
      "steps:\n",
      "setup:\n  - action: reset_for_test\n    user: tester@example.test\nsteps:\n",
    );
    let rig = rig(&spec);
    let err = run_file(&rig, &spec, UxTestRunArgs::default())
      .await
      .err()
      .expect("nobody completes the session");
    assert!(
      format!("{err:#}").contains("Timeout waiting for session"),
      "the wait's own error ends the run: {err:#}"
    );
    assert_eq!(
      *rig.teardown_verbs.lock().unwrap(),
      ["reset_for_test", "reset_for_test"]
    );
  }

  /// `--auto --user <other>` against a spec that declares another account is
  /// refused before setup runs (review J-5): setup may delete the declared
  /// account (onboarding-new-user deletes operator-tester@lona.so), and a
  /// refusal after it left that account deleted.
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn an_account_mismatch_is_refused_before_setup() {
    let spec = SPEC.replace(
      "steps:\n",
      "params:\n  user_email: tester@example.test\nsetup:\n  - action: reset_for_test\n    \
       user: '{{user_email}}'\nsteps:\n",
    );
    let rig = rig(&spec);
    let err = run_file(
      &rig,
      &spec,
      UxTestRunArgs {
        auto: true,
        user: Some("someone-else@example.test".into()),
        ..Default::default()
      },
    )
    .await
    .err()
    .expect("the accounts disagree");
    assert!(format!("{err:#}").contains("account mismatch"), "{err:#}");
    assert!(
      rig.teardown_verbs.lock().unwrap().is_empty(),
      "no setup verb ran: {:?}",
      rig.teardown_verbs.lock().unwrap()
    );
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_completed_session_that_fails_verification_is_a_failure() {
    let spec = SPEC.replace(
      "verification:\n  auto_fail_on_errors: false\n",
      "verification:\n  required_logs:\n    - pattern: never-logged-anywhere\n",
    );
    let rig = rig(&spec);
    let outcome = drive(
      &rig,
      completing_agent(&rig, SessionResult::Success),
      &FakeLauncher::default(),
      quick(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.outcome, Outcome::Fail);
    assert_eq!(verification(&rig)["outcome"], "failed");
    assert_eq!(agent_json(&rig)["verification"], "failed");
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn an_agent_that_gives_up_is_unfinished_with_its_own_blocker() {
    let rig = rig(SPEC);
    let backend = FixtureBackend::with_delay(
      |_: &NewJob| {
        Ok(json!(
          "RESULT consent unfinished needs-human google asked for a password"
        ))
      },
      Duration::from_millis(10),
    );
    let queue = AgentQueue::new(Arc::new(backend), "default", agent::PRODUCER);
    let outcome = drive(&rig, queue, &FakeLauncher::default(), quick())
      .await
      .unwrap();
    assert_eq!(outcome.outcome, Outcome::Fail);
    assert_eq!(outcome.result, "unfinished (agent, needs-human)");
    assert!(
      outcome
        .agent
        .as_deref()
        .unwrap()
        .contains("agent said: RESULT consent unfinished")
    );
    assert_eq!(verification(&rig)["outcome"], "not_run");
    let record = agent_json(&rig);
    assert_eq!(record["end"], "job-ended");
    assert_eq!(record["state"], "succeeded");
    assert_eq!(record["result"]["blocker"], "needs-human");
    // Setup's state does not outlive an unfinished run either.
    assert_eq!(*rig.teardown_verbs.lock().unwrap(), ["reset_for_test"]);
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_failed_job_without_a_completion_is_unfinished() {
    let rig = rig(SPEC);
    let backend = FixtureBackend::with_delay(
      |_: &NewJob| anyhow::bail!("claude-agent-acp exited"),
      Duration::from_millis(10),
    );
    let queue = AgentQueue::new(Arc::new(backend), "default", agent::PRODUCER);
    let outcome = drive(&rig, queue, &FakeLauncher::default(), quick())
      .await
      .unwrap();
    assert_eq!(outcome.outcome, Outcome::Fail);
    assert_eq!(outcome.result, "unfinished (agent, agent-no-completion)");
    assert_eq!(agent_json(&rig)["state"], "failed");
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_job_that_outlives_the_spec_timeout_is_cancelled() {
    let rig = rig(SPEC);
    // Longer than the run budget, so only the timeout can end the wait.
    let backend = FixtureBackend::with_delay(
      |_: &NewJob| {
        tokio::task::block_in_place(|| std::thread::sleep(Duration::from_secs(3)));
        Ok(json!("too late"))
      },
      Duration::from_millis(10),
    );
    let queue = AgentQueue::new(Arc::new(backend), "default", agent::PRODUCER);
    let outcome = drive(&rig, queue.clone(), &FakeLauncher::default(), quick())
      .await
      .unwrap();
    assert_eq!(outcome.outcome, Outcome::Fail);
    assert_eq!(outcome.result, "unfinished (agent, agent-timeout)");
    let record = agent_json(&rig);
    assert_eq!(record["end"], "timeout");
    assert_eq!(record["canceled"], "timeout");
    // The fixture settles a running job's cancel when its run returns.
    let state = record["state"].as_str().unwrap();
    assert!(matches!(state, "cancel_requested" | "canceled"), "{state}");
    let job = queue.show(record["jobId"].as_str().unwrap()).await.unwrap();
    assert!(matches!(
      job.state,
      tento_agent_queue::JobState::CancelRequested | tento_agent_queue::JobState::Canceled
    ));
    assert_eq!(verification(&rig)["outcome"], "not_run");
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_browser_that_cannot_start_cancels_the_job() {
    let rig = rig(SPEC);
    let backend = FixtureBackend::with_delay(
      |_: &NewJob| {
        tokio::task::block_in_place(|| std::thread::sleep(Duration::from_millis(500)));
        Ok(json!("never drove"))
      },
      Duration::from_millis(10),
    );
    let queue = AgentQueue::new(Arc::new(backend), "default", agent::PRODUCER);
    let launcher = FakeLauncher {
      fail: true,
      ..FakeLauncher::default()
    };
    let outcome = drive(&rig, queue, &launcher, quick()).await.unwrap();
    assert_eq!(outcome.outcome, Outcome::Fail);
    assert_eq!(outcome.result, "unfinished (agent, browser-launch)");
    assert_eq!(agent_json(&rig)["canceled"], "browser-failed");
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_job_that_never_starts_is_cancelled_without_a_browser() {
    let rig = rig(SPEC);
    // The fixture holds the job queued for 30 s — a busy lane.
    let backend = FixtureBackend::with_delay(|_: &NewJob| Ok(json!("")), Duration::from_secs(30));
    let queue = AgentQueue::new(Arc::new(backend), "default", agent::PRODUCER);
    let launcher = FakeLauncher::default();
    let mut timing = quick();
    timing.queue_wait = Duration::from_millis(200);
    let outcome = drive(&rig, queue, &launcher, timing).await.unwrap();
    assert_eq!(outcome.result, "unfinished (agent, agent-queue-timeout)");
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 0);
    let record = agent_json(&rig);
    assert_eq!(record["state"], "canceled");
    assert_eq!(record["canceled"], "queue-wait");
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn the_local_profile_runs_no_sink_and_the_browser_still_opens_blank() {
    let rig = rig(SPEC);
    let launcher = FakeLauncher::default();
    let sink = FakeSink::default();
    let outcome = drive_on(
      &rig,
      completing_agent(&rig, SessionResult::Success),
      &launcher,
      quick(),
      None,
      &sink,
      &EnvProfile::builtin_local(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.outcome, Outcome::Pass, "{:?}", outcome.agent);
    assert!(sink.starts.lock().unwrap().is_empty());
    // The launch URL is opened alone once the browser is up, never as an arg.
    assert_eq!(*launcher.urls.lock().unwrap(), ["about:blank"]);
    assert!(agent_json(&rig).get("harnessSink").is_none());
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_remote_profile_sinks_this_sessions_posts_into_the_run_dir() {
    let rig = rig(SPEC);
    let launcher = FakeLauncher::default();
    let sink = FakeSink::default();
    let outcome = drive_on(
      &rig,
      completing_agent(&rig, SessionResult::Success),
      &launcher,
      quick(),
      None,
      &sink,
      &rc_profile(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.outcome, Outcome::Pass, "{:?}", outcome.agent);
    let starts = sink.starts.lock().unwrap().clone();
    assert_eq!(starts.len(), 1);
    let run_dir = std::fs::canonicalize(rig.logger.session_dir(&rig.session_id).unwrap()).unwrap();
    assert_eq!(starts[0].session_id, rig.session_id);
    assert_eq!(starts[0].run_dir, run_dir);
    assert_eq!(starts[0].out_dir, run_dir.join("harness-sink"));
    assert_eq!(*launcher.urls.lock().unwrap(), ["about:blank"]);
    let record = agent_json(&rig);
    assert!(
      record["harnessSink"]
        .as_str()
        .unwrap()
        .starts_with("harness-sink: ready"),
      "{record}"
    );
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_sink_that_cannot_start_ends_the_run_unfinished() {
    let rig = rig(SPEC);
    let backend = FixtureBackend::with_delay(
      |_: &NewJob| {
        tokio::task::block_in_place(|| std::thread::sleep(Duration::from_millis(500)));
        Ok(json!("RESULT consent completed never-reached"))
      },
      Duration::from_millis(10),
    );
    let queue = AgentQueue::new(Arc::new(backend), "default", agent::PRODUCER);
    let sink = FakeSink {
      mode: SinkMode::Fails,
      ..FakeSink::default()
    };
    let outcome = drive_on(
      &rig,
      queue,
      &FakeLauncher::default(),
      quick(),
      None,
      &sink,
      &rc_profile(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.outcome, Outcome::Fail);
    assert_eq!(outcome.result, "unfinished (agent, harness-sink-failed)");
    assert!(
      outcome
        .agent
        .as_deref()
        .unwrap()
        .contains("harness-sink: error connect ECONNREFUSED")
    );
    let record = agent_json(&rig);
    assert_eq!(record["end"], "harness-sink-failed");
    assert_eq!(record["canceled"], "harness-sink");
    assert_eq!(verification(&rig)["outcome"], "not_run");
    assert_eq!(*rig.teardown_verbs.lock().unwrap(), ["reset_for_test"]);
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_sink_that_exits_mid_run_cancels_the_job() {
    let rig = rig(SPEC);
    let backend = FixtureBackend::with_delay(
      |_: &NewJob| {
        tokio::task::block_in_place(|| std::thread::sleep(Duration::from_millis(1500)));
        Ok(json!("RESULT consent completed too-late"))
      },
      Duration::from_millis(10),
    );
    let queue = AgentQueue::new(Arc::new(backend), "default", agent::PRODUCER);
    let sink = FakeSink {
      mode: SinkMode::Exits,
      ..FakeSink::default()
    };
    let mut timing = quick();
    timing.run_budget = Duration::from_secs(5);
    let outcome = drive_on(
      &rig,
      queue,
      &FakeLauncher::default(),
      timing,
      None,
      &sink,
      &rc_profile(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.result, "unfinished (agent, harness-sink-exited)");
    let record = agent_json(&rig);
    assert_eq!(record["end"], "harness-sink-exited");
    assert_eq!(record["canceled"], "harness-sink");
    assert!(
      record["harnessSink"]
        .as_str()
        .unwrap()
        .contains("exited while the agent drove"),
      "{record}"
    );
    assert_eq!(verification(&rig)["outcome"], "not_run");
  }

  #[test]
  fn the_corpus_skips_a_manual_first_spec_only_without_a_lane() {
    let spec = TestSpec::from_yaml(SPEC).unwrap();
    // No lane: exactly today's skip.
    assert_eq!(
      auto_skip(Some(&spec), false).map(|skip| skip.reason),
      Some(run_report::SkipReason::FirstStepManual)
    );
    // A lane: the agent drives it.
    assert_eq!(auto_skip(Some(&spec), true), None);
    // An agent does not make an unreadable spec runnable.
    assert_eq!(
      auto_skip(None, true).map(|skip| skip.reason),
      Some(run_report::SkipReason::Unparseable)
    );
    // And the per-spec decision agrees.
    assert!(agent::drives(true, &spec, Some("ux-browser")));
    assert!(!agent::drives(true, &spec, None));
  }
}

#[cfg(test)]
mod finalize_tests {
  use super::*;

  fn dir_with(tag: &str, record: Option<&str>) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ux-test-finalize-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    if let Some(record) = record {
      std::fs::write(dir.join("verification.json"), record).unwrap();
    }
    dir
  }

  /// The server's completion audit judges an externally-driven run before
  /// `finalize` is called; finalize must still adopt it, or teardown and the
  /// ledger never run.
  #[test]
  fn finalize_adopts_a_run_only_the_completion_audit_judged() {
    let audited = r#"{"outcome":"failed","at":"2026-10-27T21:20:02Z","provisional":true}"#;
    let finalized = r#"{"outcome":"failed","at":"2026-10-27T21:20:02Z"}"#;
    for (tag, record, final_) in [
      ("none", None, false),
      ("audited", Some(audited), false),
      ("finalized", Some(finalized), true),
      ("unreadable", Some("{"), true),
    ] {
      let dir = dir_with(tag, record);
      assert_eq!(has_final_verification(&dir), final_, "{tag}");
      std::fs::remove_dir_all(&dir).unwrap();
    }
  }

  /// A completion audit that lands after the owner's verdict must not turn it
  /// back into a provisional record, or a retried finalize tears down twice.
  #[test]
  fn a_late_completion_audit_leaves_the_final_record_alone() {
    let root = std::env::temp_dir().join(format!("ux-test-late-audit-{}", Uuid::new_v4().simple()));
    let logger = LLMLogger::new(root.join("runs"));
    let session = Session {
      id: "s-late-audit".to_string(),
      prefix: "t".to_string(),
      instructions: Vec::new(),
      metadata: None,
      status: SessionStatus::Pending,
      created_at: Utc::now(),
      flaky: None,
      tracing_uuid: None,
      display_params: None,
      test_id: None,
      completed_steps: Vec::new(),
    };
    let spec = TestSpec::ephemeral("t".to_string(), "t".to_string(), vec![]);
    logger.create_session_with_spec(&session, &spec).unwrap();
    let dir = logger.session_dir(&session.id).unwrap();
    let read = || -> VerificationRecord {
      serde_json::from_str(&std::fs::read_to_string(dir.join("verification.json")).unwrap())
        .unwrap()
    };

    logger
      .write_completion_audit(&session.id, VerificationOutcome::Failed, None)
      .unwrap();
    assert!(read().provisional);
    logger
      .write_verification_record(&session.id, VerificationOutcome::Passed, None)
      .unwrap();
    logger
      .write_completion_audit(&session.id, VerificationOutcome::Failed, None)
      .unwrap();
    let record = read();
    assert!(!record.provisional);
    assert_eq!(record.outcome, VerificationOutcome::Passed);
    std::fs::remove_dir_all(&root).unwrap();
  }

  #[test]
  fn a_final_record_omits_the_provisional_flag() {
    let record = VerificationRecord {
      outcome: VerificationOutcome::Passed,
      at: Utc::now(),
      detail: None,
      provisional: false,
    };
    let json = serde_json::to_string(&record).unwrap();
    assert!(!json.contains("provisional"));
  }
}
