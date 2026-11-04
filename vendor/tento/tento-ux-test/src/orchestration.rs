//! UX-test orchestration: the host-agnostic core of the `ux-test` commands.
//!
//! The session model + spec live in [`crate::session`] / [`crate::spec`]. This
//! module owns the test lifecycle (setup → session → wait → snapshot → teardown
//! → verify), real-time step monitoring, and trace verification — all
//! parameterized over [`UxTestCtx`] so it carries no dependency on the host's
//! application context, admin API, or HTTP client.

use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use tokio::time::sleep;
use tracing::info;
use uuid::Uuid;

use tento_logger::ljson::LjsonEntry;
use tento_logger::render::project::{LogZoom, tree_to_entry};
use tento_logger_spans::{SpanRow, recompose, render_order_key};
use tento_timeseries::TimeSeriesStore;

use crate::session::{LLMLogger, SessionCompletion, SessionResult, SessionStatus};
use crate::spec::{
  ExecutableAction, RowExpectation, SetupAction, TeardownAction, TestSpec, Verification,
};

// ===========================================================================
// Host context abstraction
// ===========================================================================

/// Read-only environment the orchestration needs from its host.
pub trait UxTestEnv: Send + Sync {
  /// Base directory holding per-session `session.json` / `spec.yaml` / `logs.ljson`.
  fn llm_logger_dir(&self) -> PathBuf;
  /// Directory holding the global `loaf.ljson` (server+client trace stream), if known.
  fn loaf_logs_dir(&self) -> Option<PathBuf>;
  /// Server host slug ("dev", "aws-09") used to resolve session URLs, if known.
  fn server_host(&self) -> Option<String>;
  /// Resolve a host-specific URL pattern into the browser target for a session.
  ///
  /// Product domains, fleet prefixes, and default hosts belong to the host
  /// adapter. The shared UX-test core only needs the resolved host/path shape.
  ///
  /// `server_host_override` is the run's env profile speaking: `Some(slug)`
  /// replaces the host slug this environment would otherwise derive
  /// (lona: the `dev` in `dev--calendar.lona.so`), which is how a run on one
  /// machine targets a server on another. `None` ⇒ the host's own slug, exactly
  /// as before profiles existed.
  fn resolve_session_target(
    &self,
    url_pattern: &Option<String>,
    initial_path: Option<&str>,
    server_host_override: Option<&str>,
  ) -> Result<SessionTarget>;
  /// Derive a `--url` host pattern from the origin a spec declares in
  /// `params.server_url`, so a spec that names its own origin is driven there
  /// without the caller repeating it on the command line. `None` ⇒ nothing is
  /// derived and the host's own default origin stands.
  ///
  /// Which origin shapes are derivable is the host's question: the mapping has
  /// to survive a spec authored against one environment being run in another,
  /// and only the host knows which label in its hostnames is the environment.
  fn url_pattern_from_server_url(&self, _server_url: &str) -> Option<String> {
    None
  }
  /// Derive a `--url` host pattern from the route a spec enters on, overriding
  /// the origin the spec declares. `None` ⇒ no override.
  ///
  /// This is for hosts that are multi-origin: an entry route may live on a
  /// different origin than the app the rest of the spec drives.
  fn url_pattern_from_initial_path(&self, _initial_path: Option<&str>) -> Option<String> {
    None
  }
  /// The account the headless (`--auto`) browser authenticates as when neither
  /// `--user` nor the spec's `params.user_email` names one. `None` ⇒ such a spec
  /// cannot be driven headless on this host and the run stops before minting
  /// anything.
  fn default_user(&self) -> Option<String> {
    None
  }
  /// Port the headless browser reaches the host's dev server on. The top-level
  /// `page.goto` must be port-qualified — the runner's request rewrite only
  /// covers sub-resource requests, not the initial navigation. `None` ⇒ the URL
  /// is driven as-is on the default port and the runner rewrites nothing.
  fn dev_port(&self) -> Option<String> {
    None
  }
  /// Directory of the `lona-ux-runner` Deno project (holds `ux-runner.deno.ts` +
  /// `deno.json`). `None` ⇒ headless (`--auto`) runs are unavailable on this host.
  fn ux_runner_dir(&self) -> Option<PathBuf> {
    None
  }
  /// Directory of the checked-in `.ux-tests/` corpus — one folder per test, with
  /// that test's runs nested inside it. `Some` enables the per-test layout +
  /// discovery + status rollups; `None` ⇒ the legacy flat session store
  /// (`llm_logger_dir`) is used directly (production authors no specs).
  fn ux_tests_dir(&self) -> Option<PathBuf> {
    None
  }
}

/// One verb, on its way to the host, with the channel its answer comes back on.
///
/// A request is plain data — a name, a JSON bag, and a oneshot. That is the
/// whole point of the shape: closures and futures are what drag `Send` bounds
/// around, and a serialized verb has none.
pub struct VerbRequest {
  /// The verb's name. Core verbs (`mint_api_key`, `read_cells`, …) use the
  /// well-known names the typed helpers below send.
  pub action: String,
  /// The verb's fields, `{{param}}`-substituted, as a JSON object.
  pub params: serde_json::Value,
  /// Where the host sends the outcome. Dropping it (host loop gone, verb
  /// panicked) surfaces as a loud error at the caller, never a hang.
  pub reply: tokio::sync::oneshot::Sender<Result<serde_json::Value>>,
}

/// The host end of the UX-test seam: a verb vocabulary plus a channel into the
/// host's own receive loop.
///
/// This replaces the trait hosts used to implement. Only **data** crosses here,
/// so `HostPort` is `Send + Sync` by construction — `mpsc::Sender` and
/// `oneshot::Receiver` are `Send` regardless of what the host does on the far
/// side — and the machinery's futures are `Send` without the host's futures
/// being anything in particular. A host whose interior is `?Send` (lona's
/// `PermittedTo` permission layer is) runs its loop on whatever runtime suits
/// it and answers with JSON; nothing about that reaches this crate.
///
/// `verbs` is the lint's source of truth: the corpus-callable action names this
/// host answers, checked offline by `ux-test lint` and again before any run's
/// setup runs.
#[derive(Clone)]
pub struct HostPort {
  verbs: Arc<Vec<String>>,
  tx: tokio::sync::mpsc::UnboundedSender<VerbRequest>,
  commands: Option<Arc<crate::command_port::Client>>,
  /// True when this port's verbs execute on a REMOTE server whose session
  /// store is not this process's filesystem. The in-browser harness posts
  /// its logs and completion to the page origin — that remote server — so a
  /// remote-target run must sync session state down through the port before
  /// the local store can observe completion (see
  /// [`await_session_completion`]).
  remote_session_source: bool,
}

impl HostPort {
  pub fn new(verbs: Vec<String>, tx: tokio::sync::mpsc::UnboundedSender<VerbRequest>) -> Self {
    Self {
      verbs: Arc::new(verbs),
      tx,
      commands: None,
      remote_session_source: false,
    }
  }

  /// Explicitly select CLI administration instead of a host receive loop.
  /// Construction/lint are offline. First use pins the advertised boot and
  /// preflights every binding; no command failure falls back to another port.
  /// SSH does not imply page-origin session authority.
  pub fn from_commands(config: crate::command_port::Config) -> Result<Self> {
    let client = crate::command_port::Client::new(config)?;
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    Ok(Self {
      verbs: Arc::new(client.verbs()),
      tx,
      commands: Some(Arc::new(client)),
      remote_session_source: false,
    })
  }

  /// Validate the selected command endpoint before setup. Legacy ports have
  /// their own preflight; this method does not dispatch a fixture operation.
  pub async fn preflight_commands(&self) -> Result<()> {
    if let Some(client) = &self.commands {
      client.preflight().await?;
    }
    Ok(())
  }

  /// Mark this port as fronting a remote server's session store.
  pub fn with_remote_session_source(mut self) -> Self {
    self.remote_session_source = true;
    self
  }

  pub fn remote_session_source(&self) -> bool {
    self.remote_session_source
  }

  /// The corpus-callable verbs this host answers.
  pub fn verbs(&self) -> &[String] {
    &self.verbs
  }

  /// Send a verb to the host loop and await its result.
  pub async fn execute_verb(
    &self,
    action: &str,
    params: serde_json::Value,
  ) -> Result<serde_json::Value> {
    if let Some(client) = &self.commands {
      return client.execute(action, params).await.map_err(Into::into);
    }
    let (reply, answer) = tokio::sync::oneshot::channel();
    self
      .tx
      .send(VerbRequest {
        action: action.to_string(),
        params,
        reply,
      })
      .map_err(|_| anyhow!("the host verb loop is gone; cannot run '{action}'"))?;
    answer
      .await
      .map_err(|_| anyhow!("the host verb loop dropped '{action}' without answering"))?
  }

  /// Mint a short-lived bearer API key for `user` so the headless (`--auto`)
  /// browser can load the authenticated app. Returns the raw token.
  pub async fn mint_api_key(&self, user: &str, ttl_secs: i64) -> Result<String> {
    let result = self
      .execute_verb(
        "mint_api_key",
        serde_json::json!({ "user": user, "ttl_secs": ttl_secs }),
      )
      .await?;
    result
      .as_str()
      .map(str::to_string)
      .ok_or_else(|| anyhow!("mint_api_key must return a token string, got {result}"))
  }

  /// Best-effort revoke of a token minted by [`mint_api_key`](Self::mint_api_key).
  /// Returns whether a key was revoked.
  pub async fn revoke_api_key(&self, token: &str) -> Result<bool> {
    let result = self
      .execute_verb("revoke_api_key", serde_json::json!({ "token": token }))
      .await?;
    result
      .as_bool()
      .ok_or_else(|| anyhow!("revoke_api_key must return a bool, got {result}"))
  }

  /// Read `user`'s cells for `row_key` across an inclusive `YYYY-MM-DD` window,
  /// as the **canonical row store** serves them — the same path the UI reads.
  ///
  /// Deliberately not a provider read. Finding `ux-test(10)` is a case where two
  /// read paths disagree (the UI and the source rows agree; `events.query`
  /// disagrees with both), so a verb that silently picked one would make that
  /// class of bug inexpressible. "Do the provider and our rows agree?" is a
  /// different question and earns its own verb when a spec needs it.
  pub async fn read_cells(
    &self,
    user: &str,
    row_key: &str,
    start: &str,
    end: &str,
  ) -> Result<Vec<serde_json::Value>> {
    let result = self
      .execute_verb(
        "read_cells",
        serde_json::json!({
          "user": user,
          "row_key": row_key,
          "start": start,
          "end": end,
        }),
      )
      .await?;
    match result {
      serde_json::Value::Array(cells) => Ok(cells),
      other => Err(anyhow!("read_cells must return an array of cells, got {other}")),
    }
  }
}

/// Every host verb a spec calls that the mounted host does not answer, deduped
/// and in first-seen order.
///
/// The closed enum used to reject `craete_trial_user` at parse time; the
/// catch-all parses it happily and would fail at dispatch — possibly inside a
/// teardown, whose failures are deliberately non-fatal. This is where that
/// safety comes back, and both callers matter: `ux-test lint` runs it over the
/// whole corpus offline, and `run` runs it before Phase 1 so no spec can create
/// a user and then discover its third verb was a typo.
pub fn unknown_host_actions(spec: &TestSpec, known: &[String]) -> Vec<String> {
  let setup = spec.setup.iter().filter_map(|a| match a {
    SetupAction::Host { action, .. } => Some(action),
    _ => None,
  });
  let teardown = spec.teardown.iter().filter_map(|a| match a {
    TeardownAction::Host { action, .. } => Some(action),
    _ => None,
  });
  let steps = spec.steps.iter().flat_map(|step| {
    step
      .actions
      .iter()
      .flatten()
      .filter_map(|action| match action {
        ExecutableAction::Host { verb, .. } => Some(verb),
        _ => None,
      })
  });

  let mut unknown: Vec<String> = Vec::new();
  for action in setup.chain(steps).chain(teardown) {
    if !known.iter().any(|k| k == action) && !unknown.iter().any(|u| u == action) {
      unknown.push(action.clone());
    }
  }
  unknown
}

/// The context passed to every `ux-test` command: a host environment + the
/// port its verbs travel over.
///
/// Boxed (not generic) because `#[tento_sh::command]` binds each command to a
/// concrete first-parameter type and cannot express generic commands.
#[derive(Clone)]
pub struct UxTestCtx {
  env: Arc<dyn UxTestEnv>,
  port: HostPort,
}

impl UxTestCtx {
  pub fn new(env: Arc<dyn UxTestEnv>, port: HostPort) -> Self {
    Self { env, port }
  }
  pub fn env(&self) -> &dyn UxTestEnv {
    self.env.as_ref()
  }
  pub fn port(&self) -> &HostPort {
    &self.port
  }
  /// Construct an [`LLMLogger`]. With a `.ux-tests` root configured, runs nest
  /// per-test and the legacy flat dir is dual-read; otherwise it's the flat
  /// legacy store.
  pub fn logger(&self) -> LLMLogger {
    match self.env.ux_tests_dir() {
      Some(root) => LLMLogger::new_rooted(root, Some(self.env.llm_logger_dir())),
      None => LLMLogger::new(self.env.llm_logger_dir()),
    }
  }
}

// ===========================================================================
// Session completion
// ===========================================================================

/// Result of a completed session.
pub struct SessionCompletionResult {
  pub logs: Vec<LjsonEntry>,
  pub completion: Option<SessionCompletion>,
}

/// Poll for session completion.
pub async fn await_session_completion(
  logger: &LLMLogger,
  port: &HostPort,
  session_id: &str,
  timeout_secs: u64,
) -> Result<SessionCompletionResult> {
  let start = std::time::Instant::now();
  let timeout = Duration::from_secs(timeout_secs);
  let poll_interval = Duration::from_secs(2);

  loop {
    if start.elapsed() > timeout {
      anyhow::bail!("Timeout waiting for session to complete");
    }

    // Remote-target runs: the harness posted logs + completion to the page
    // origin (the remote server), never here. Pull that server's view of the
    // session down into the local store first, so the local checks below —
    // and everything downstream of them (trace snapshot, verification, the
    // ledger) — read the same files they always have. Best-effort per poll:
    // a transient pull failure just polls again.
    if port.remote_session_source() {
      if let Err(e) = sync_remote_session(port, logger, session_id).await {
        tracing::warn!("remote session sync failed (will retry): {e:#}");
      }
    }

    let session = logger.get_session(session_id)?;

    match session.status {
      SessionStatus::Completed => {
        let logs = logger.read_logs_ljson(session_id)?;
        let completion = logger.read_completion(session_id)?;
        return Ok(SessionCompletionResult { logs, completion });
      }
      SessionStatus::Abandoned => {
        anyhow::bail!("Session was abandoned (user clicked Skip)");
      }
      SessionStatus::Pending | SessionStatus::InProgress => {
        sleep(poll_interval).await;
      }
    }
  }
}

/// How long a headless run still waits for a completion once its runner has
/// exited without executing every step. A failure the runner managed to post
/// (or a remote store's copy of it) lands within a poll or two; anything
/// longer is the spec's timeout spent waiting on a process that is gone.
pub const RUNNER_EXIT_GRACE_SECS: u64 = 15;

/// What the headless runner writes into the run dir when a step, or the boot
/// navigation, throws: `{"step", "error", "url", "title"}`. Written before it
/// tries the in-page completion, which is exactly what a failed navigation
/// leaves no hook for (`tento-ux-runner/lib/harness.ts`, `writeRunnerFailure`).
pub const RUNNER_FAILURE_FILE: &str = "runner-failure.json";

/// The completion of a headless run whose runner exited non-zero.
///
/// Waits [`await_session_completion`] for `grace_secs` only. When the runner
/// posted nothing — a refused or unresolvable navigation leaves a
/// `chrome-error://` page with no `__uxComplete` — the session is completed
/// here as a `failure` whose feedback is the error the runner recorded in
/// [`RUNNER_FAILURE_FILE`], so the run ends red at once with its cause, rather
/// than as "Timeout waiting for session to complete" after the spec's whole
/// timeout. A completion that did arrive is kept as posted; an abandoned
/// session stays an error.
pub async fn await_completion_after_runner_failure(
  logger: &LLMLogger,
  port: &HostPort,
  session_id: &str,
  grace_secs: u64,
) -> Result<SessionCompletionResult> {
  if let Ok(done) = await_session_completion(logger, port, session_id, grace_secs).await {
    return Ok(done);
  }
  match logger.get_session(session_id)?.status {
    SessionStatus::Abandoned => anyhow::bail!("Session was abandoned (user clicked Skip)"),
    SessionStatus::Completed => {}
    SessionStatus::Pending | SessionStatus::InProgress => {
      let feedback = runner_failure_feedback(&logger.session_dir(session_id)?);
      info!("  {feedback}");
      logger.mark_complete(session_id, SessionResult::Failure, Some(feedback))?;
    }
  }
  Ok(SessionCompletionResult {
    logs: logger.read_logs_ljson(session_id)?,
    completion: logger.read_completion(session_id)?,
  })
}

/// The failure feedback for a runner that exited without completing its
/// session: the recorded error and the page it was on, or a plain statement
/// that there is no record.
pub fn runner_failure_feedback(session_dir: &Path) -> String {
  let record = std::fs::read_to_string(session_dir.join(RUNNER_FAILURE_FILE))
    .ok()
    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
  let Some(record) = record else {
    return format!(
      "headless: the runner exited without completing the session (no {RUNNER_FAILURE_FILE})"
    );
  };
  let step = record
    .get("step")
    .and_then(serde_json::Value::as_i64)
    .map_or_else(|| "?".to_string(), |step| step.to_string());
  let error = record
    .get("error")
    .and_then(serde_json::Value::as_str)
    .unwrap_or("no error recorded");
  let page = record
    .get("url")
    .and_then(serde_json::Value::as_str)
    .filter(|url| !url.is_empty())
    .map(|url| format!(" (page {url})"))
    .unwrap_or_default();
  format!(
    "headless: step {step} failed and the runner exited without completing the session: {error}{page}"
  )
}

/// One remote→local session sync: ask the port's server for the session's
/// status, completion, and client log entries (`read_session_state`), and
/// materialize any TERMINAL state into the local store. Non-terminal states
/// sync nothing — the poll continues. Entries are written only into an empty
/// local logs.ljson (on a remote run nothing else writes it; the guard keeps
/// a re-poll from duplicating lines).
async fn sync_remote_session(
  port: &HostPort,
  logger: &LLMLogger,
  session_id: &str,
) -> Result<()> {
  let state = port
    .execute_verb(
      "read_session_state",
      serde_json::json!({ "session": session_id }),
    )
    .await?;
  let status = state.get("status").and_then(|s| s.as_str()).unwrap_or("");
  let completion = state.get("completion").cloned().filter(|c| !c.is_null());
  let terminal = match (status, &completion) {
    ("abandoned", _) => true,
    // Completed-without-a-completion-record is a half-written state on the
    // remote side; keep polling rather than fabricating a result.
    ("completed", Some(_)) => true,
    _ => false,
  };
  if !terminal {
    return Ok(());
  }
  if let Some(entries) = state.get("entries").and_then(|e| e.as_array()) {
    if logger.read_logs_ljson(session_id)?.is_empty() {
      logger.append_ljson_entries(session_id, entries)?;
    } else if !entries.is_empty() {
      tracing::warn!(
        "local logs.ljson for {session_id} is non-empty; skipping remote entry \
         sync to avoid duplication"
      );
    }
  }
  if status == "abandoned" {
    logger.mark_abandoned(session_id)?;
    return Ok(());
  }
  let completion: SessionCompletion = serde_json::from_value(
    completion.expect("terminal completed state carries a completion"),
  )
  .context("parse remote completion")?;
  logger.mark_complete(session_id, completion.result, completion.feedback)?;
  Ok(())
}

/// Format a completion's result as an uppercase label for logging.
pub fn result_label(completion: &Option<SessionCompletion>) -> &'static str {
  match completion {
    Some(c) => match c.result {
      SessionResult::Success => "SUCCESS",
      SessionResult::Failure => "FAILURE",
    },
    None => "UNKNOWN",
  }
}

/// Format a completion's result as a lowercase string for JSON output.
pub fn result_str(completion: &Option<SessionCompletion>) -> Option<&'static str> {
  completion.as_ref().map(|c| match c.result {
    SessionResult::Success => "success",
    SessionResult::Failure => "failure",
  })
}

// ===========================================================================
// Session target assembly
// ===========================================================================

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionTarget {
  pub full_host: String,
  pub host_only: String,
  pub target_path: String,
  /// Private on purpose: a host adapter builds targets with
  /// [`from_full_host`](Self::from_full_host) and knows nothing about which
  /// scheme the run is measuring over. The env profile sets it afterwards via
  /// [`with_scheme`](Self::with_scheme).
  scheme: crate::env_profile::Scheme,
}

impl SessionTarget {
  pub fn from_full_host(full_host: String, initial_path: Option<&str>) -> Self {
    let (host_only, host_path) = match full_host.split_once('/') {
      Some((h, p)) => (h.to_string(), format!("/{p}")),
      None => (full_host.clone(), String::new()),
    };
    let target_path = initial_path
      .filter(|p| p.starts_with('/'))
      .map(str::to_string)
      .unwrap_or_else(|| {
        if host_path.is_empty() {
          "/".to_string()
        } else {
          host_path
        }
      });

    Self {
      full_host,
      host_only,
      target_path,
      scheme: crate::env_profile::Scheme::Https,
    }
  }

  /// The scheme this target is reached over. Set by the RUN's env profile
  /// through [`with_scheme`](Self::with_scheme), not by the host adapter — an
  /// adapter knows the URL grammar, the profile knows which server is being
  /// measured and how.
  pub fn origin(&self) -> String {
    format!("{}://{}", self.scheme.as_str(), self.host_only)
  }

  /// Apply an env profile's scheme. Defaults to `https` when never called, so
  /// every existing host adapter and corpus is unaffected.
  pub fn with_scheme(mut self, scheme: crate::env_profile::Scheme) -> Self {
    self.scheme = scheme;
    self
  }

  pub fn url(
    &self,
    session_id: &str,
    tracing_uuid: Option<Uuid>,
    initial_path: Option<&str>,
  ) -> String {
    // `prefix` is emitted verbatim; `tail` is the part that may already carry
    // a query (and a fragment) the session params have to join.
    let (prefix, tail) = match initial_path {
      Some(path) => (
        format!("{}://{}", self.scheme.as_str(), self.full_host),
        path,
      ),
      // The url pattern itself may carry a path + query string (e.g.
      // `calendar.lona.so/sheet?title=...`) — appending `?ux=` to it
      // would bury the ux param inside the last query value and the
      // session never attaches.
      None => (
        format!("{}://", self.scheme.as_str()),
        self.full_host.as_str(),
      ),
    };
    // The session params belong to the QUERY, which ends where a fragment
    // begins. Appended after a `#` they are part of the fragment: the server
    // and `location.search` never see `ux`, the harness never attaches, and
    // the page reads a hash it does not know (`/#tab:chat?ux=…`, candidate.8
    // chat-storybooks). So they go before the `#`, and the fragment is put
    // back after them.
    let (tail, fragment) = match tail.split_once('#') {
      Some((before, after)) => (before, Some(after)),
      None => (tail, None),
    };
    let sep = if tail.contains('?') { "&" } else { "?" };
    let mut url = format!("{prefix}{tail}{sep}ux={session_id}");
    if let Some(tid) = tracing_uuid {
      url.push_str(&format!("&tid={}", tid));
    }
    if let Some(fragment) = fragment {
      url.push('#');
      url.push_str(fragment);
    }
    url
  }
}

// ===========================================================================
// Setup / teardown action execution
// ===========================================================================

/// The generic contract for what a host verb hands back.
///
/// The core never interprets a host result structurally; it only feeds params.
/// Two rules, and they are the same two the typed variants used to encode
/// one-by-one:
///
/// - a **map** result publishes each of its string entries as a spec param.
///   This is how `create_promo_key`'s implicit `promo_code` keeps working: lona
///   returns `{"promo_code": "…"}` and the next step's `{{promo_code}}` resolves.
/// - `store_as`, if the entry declared one, names the param a **string** result
///   lands in. `store_as` is spec plumbing, stripped before dispatch — the host
///   never sees it and no host has to implement it.
fn absorb_verb_result(
  spec: &mut TestSpec,
  action: &str,
  store_as: Option<String>,
  result: serde_json::Value,
) -> Result<()> {
  if let serde_json::Value::Object(map) = &result {
    for (key, value) in map {
      if let serde_json::Value::String(text) = value {
        spec.params.insert(key.clone(), text.clone());
      }
    }
  }
  if let Some(param_name) = store_as {
    let serde_json::Value::String(text) = &result else {
      return Err(anyhow!(
        "'{action}' declares store_as: {param_name} but returned {result}, not a string"
      ));
    };
    spec.params.insert(param_name, text.clone());
  }
  Ok(())
}

/// Resolve a host verb's params against the spec, lifting out the machinery's
/// own `store_as` field.
fn host_params(spec: &TestSpec, params: &serde_json::Value) -> (serde_json::Value, Option<String>) {
  let mut params = params.clone();
  spec.substitute_value(&mut params);
  let store_as = match &mut params {
    serde_json::Value::Object(map) => map
      .remove("store_as")
      .and_then(|v| v.as_str().map(str::to_string)),
    _ => None,
  };
  (params, store_as)
}

/// Execute a setup action: the machinery's own verbs inline, everything else
/// dispatched to the host.
pub async fn execute_setup_action(
  port: &HostPort,
  spec: &mut TestSpec,
  action: &SetupAction,
) -> Result<()> {
  info!("  Setup: {}", action.name());

  match action {
    SetupAction::Wait { seconds } => {
      sleep(Duration::from_secs(*seconds)).await;
    }
    SetupAction::StartLogCapture { .. } | SetupAction::CreateUxSession { .. } => {
      // These are handled internally by the test runner
      info!("    Skipped (handled internally): {}", action.name());
    }
    SetupAction::Host { action, params } => {
      let (params, store_as) = host_params(spec, params);
      let result = port
        .execute_verb(action, params)
        .await
        .with_context(|| format!("setup action '{action}' failed"))?;
      absorb_verb_result(spec, action, store_as, result)?;
      info!("    Done: {}", action);
    }
  }

  Ok(())
}

/// Execute a teardown action. Same dispatch as setup, with one difference that
/// is the whole reason teardown has its own function: a host verb's failure is
/// **logged, not propagated**. Cleanup is best-effort by design — a failed
/// delete must not mask the test's own verdict.
pub async fn execute_teardown_action(
  port: &HostPort,
  spec: &TestSpec,
  action: &TeardownAction,
) -> Result<()> {
  info!("  Teardown: {}", action.name());

  match action {
    TeardownAction::Wait { seconds } => {
      sleep(Duration::from_secs(*seconds)).await;
    }
    TeardownAction::StopLogCapture | TeardownAction::DeleteUxSession { .. } => {
      // Handled internally by the test runner
      info!("    Skipped (handled internally): {}", action.name());
    }
    TeardownAction::Host { action, params } => {
      let (params, _) = host_params(spec, params);
      match port.execute_verb(action, params).await {
        Ok(_) => info!("    Done: {}", action),
        Err(e) => info!("    Failed (ok, teardown is best-effort): {} — {:#}", action, e),
      }
    }
  }

  Ok(())
}

// ===========================================================================
// Trace snapshot + LJSON IO
// ===========================================================================

/// Does this entry belong to the session? Client entries match by `session_id`;
/// server entries match by the `tracing_session.id` attribute (set from the
/// browser's `X-Tracing-Session-Id` header).
fn entry_in_session(entry: &LjsonEntry, tracing_uuid: Uuid) -> bool {
  entry.session_id == tracing_uuid
    || entry
      .root_span
      .attributes
      .get("tracing_session.id")
      .and_then(|v| v.as_str())
      .and_then(|s| s.parse::<Uuid>().ok())
      .map(|u| u == tracing_uuid)
      .unwrap_or(false)
}

/// Read this session's server entries from the local loaf span bucket.
pub fn server_entries_from_buckets(tracing_uuid: Uuid) -> Result<Vec<LjsonEntry>> {
  let bucket_dir = tento_buckets::bucket_dir(
    tento_buckets::default_buckets_root(),
    &tento_buckets::host_id(),
    "loaf",
    "spans",
  );
  if !bucket_dir.join("meta.json").exists() {
    return Ok(Vec::new());
  }
  let store: TimeSeriesStore<SpanRow> = TimeSeriesStore::new(bucket_dir);
  let now = chrono::Utc::now();
  let rows = store.range(now - chrono::Duration::days(30), now);
  Ok(
    span_rows_to_entries(rows)
      .into_iter()
      .filter(|e| entry_in_session(e, tracing_uuid))
      .collect(),
  )
}

/// Write LJSON entries (one JSON object per line) to `path`.
fn write_ljson(path: &Path, entries: &[LjsonEntry]) -> Result<()> {
  let mut out = File::create(path).with_context(|| format!("create {}", path.display()))?;
  for e in entries {
    let line = serde_json::to_string(e).context("serialize LJSON entry")?;
    writeln!(out, "{}", line).context("write LJSON entry")?;
  }
  Ok(())
}

/// Materialize the session's unified `trace.ljson`: the client `logs.ljson`
/// entries + this session's server entries pulled from the local loaf span
/// bucket. Server bucket reads are best-effort (warns, doesn't fail, if
/// absent/unreadable — e.g. no server running).
pub fn materialize_trace(
  logger: &LLMLogger,
  session_id: &str,
  tracing_uuid: Uuid,
) -> Result<PathBuf> {
  let mut entries = logger.read_logs_ljson(session_id).unwrap_or_default();
  let server = materialize_server_entries(tracing_uuid);
  entries.extend(server);
  let session_dir = logger.session_dir(session_id)?;
  let trace_path = session_dir.join("trace.ljson");
  write_ljson(&trace_path, &entries)?;
  info!(
    "  Materialized {} entries (client + server) to {}",
    entries.len(),
    trace_path.display()
  );
  Ok(trace_path)
}

/// Materialize a session-scoped `server.ljson` (server entries only, from the
/// local loaf span bucket). Used by the live two-file view (client `logs.ljson`
/// tails live; this is a point-in-time server snapshot). Returns the path.
pub fn materialize_server_ljson(
  logger: &LLMLogger,
  session_id: &str,
  tracing_uuid: Uuid,
) -> Result<PathBuf> {
  let entries = materialize_server_entries(tracing_uuid);
  let session_dir = logger.session_dir(session_id)?;
  let path = session_dir.join("server.ljson");
  write_ljson(&path, &entries)?;
  Ok(path)
}

/// Best-effort read of this session's server entries from the local span bucket.
fn materialize_server_entries(tracing_uuid: Uuid) -> Vec<LjsonEntry> {
  match server_entries_from_buckets(tracing_uuid) {
    Ok(entries) => entries,
    Err(e) => {
      info!("  Warning: failed to read server span bucket: {:#}", e);
      Vec::new()
    }
  }
}

fn span_rows_to_entries(mut rows: Vec<SpanRow>) -> Vec<LjsonEntry> {
  rows.sort_by_cached_key(render_order_key);
  let mut entries = Vec::new();
  let mut i = 0;
  while i < rows.len() {
    let mut j = i + 1;
    while j < rows.len() && rows[j].trace_id == rows[i].trace_id {
      j += 1;
    }
    let group: Vec<SpanRow> = rows[i..j].to_vec();
    for tree in recompose(group) {
      entries.push(tree_to_entry(&tree, LogZoom::Messages));
    }
    i = j;
  }
  entries.sort_by_key(|e| e.ts);
  entries
}

/// Read LJSON entries from a file, skipping malformed lines.
///
/// A line whose only fault is an unpaired surrogate escape is repaired, not
/// skipped (see [`crate::ljson_line`]): skipping it silently dropped a probe
/// line the verification judge then reported as "Required MISSING".
pub fn read_ljson_file(path: &Path) -> Result<Vec<LjsonEntry>> {
  let file = File::open(path).context("Failed to open LJSON file")?;
  let reader = BufReader::new(file);
  let mut entries = Vec::new();

  for line in reader.lines() {
    let line = line.context("Failed to read LJSON line")?;
    if line.trim().is_empty() {
      continue;
    }
    if let Ok(entry) = crate::ljson_line::parse_ljson_line(&line) {
      entries.push(entry);
    }
  }

  Ok(entries)
}

// ===========================================================================
// Verification
// ===========================================================================

/// Verify test results using LJSON entries (client + server).
///
/// Checks LJSON entries against required/forbidden patterns. Patterns with
/// `source: "client"` or `source: "server"` are filtered accordingly. Patterns
/// without a source match any entry.
/// Run every `assert_rows` entry against the canonical row store.
///
/// This is the half of verification that can observe whether a write actually
/// landed. It runs after completion, alongside `verify_trace_results`, and both
/// must pass — a spec that asserts rows but dispatches nothing still fails on
/// the trace side.
///
/// Each assertion polls until it holds or `retry_for_ms` elapses, because a
/// provider write can still be in flight when the steps finish. A false red is
/// cheaper than today's false green but not free: it trains people to ignore
/// verdicts, which is the failure this surface exists to end.
pub async fn verify_row_assertions(
  port: &HostPort,
  spec: &TestSpec,
  verification: &Verification,
) -> Result<bool> {
  if verification.assert_rows.is_empty() {
    return Ok(true);
  }
  info!("  Row assertions ({}):", verification.assert_rows.len());

  let mut passed = true;
  for assertion in &verification.assert_rows {
    let user = spec.substitute_params(&assertion.user);
    let row_key = spec.substitute_params(&assertion.row_key);
    let start = spec.substitute_params(&assertion.range.start);
    let end = spec.substitute_params(&assertion.range.end);
    let deadline =
      std::time::Instant::now() + Duration::from_millis(assertion.retry_for_ms.unwrap_or(5000));

    let mut last: Result<Vec<serde_json::Value>> = Ok(Vec::new());
    let mut ok = false;
    loop {
      last = port.read_cells(&user, &row_key, &start, &end).await;
      if let Ok(cells) = &last {
        if expectation_holds(&assertion.expect, cells) {
          ok = true;
          break;
        }
      }
      if std::time::Instant::now() >= deadline {
        break;
      }
      sleep(Duration::from_millis(500)).await;
    }

    if ok {
      info!("    ✓ {}", assertion.description);
      continue;
    }
    passed = false;
    // Print what was actually read, not just that it mismatched: every
    // debugging session on a failed assertion should start from the report
    // rather than from re-running the test by hand.
    match last {
      Ok(cells) => {
        info!("    ✗ {}", assertion.description);
        info!("        row   {row_key}  (user {user})");
        info!("        range {start} .. {end}");
        info!("        want  {}", describe_expectation(&assertion.expect));
        info!("        got   {} cell(s)", cells.len());
        for cell in cells.iter().take(5) {
          info!("              {}", truncate_json(cell, 160));
        }
      }
      Err(e) => {
        info!("    ✗ {} — read failed: {:#}", assertion.description, e);
      }
    }
  }
  Ok(passed)
}

/// Does this set of cells satisfy the expectation?
fn expectation_holds(expect: &RowExpectation, cells: &[serde_json::Value]) -> bool {
  if let Some(want) = expect.count {
    if cells.len() != want {
      return false;
    }
  }
  if let Some(absent) = expect.absent.as_ref() {
    if !absent.is_empty() {
      // No cell may carry every declared key/value. An empty map asserts
      // nothing rather than matching every cell vacuously.
      let found = cells
        .iter()
        .any(|cell| absent.iter().all(|(k, v)| json_contains_pair(cell, k, v)));
      if found {
        return false;
      }
    }
  }
  let Some(contains) = expect.contains.as_ref() else {
    return true;
  };
  if contains.is_empty() {
    return true;
  }
  // At least one cell must carry every declared key/value, anywhere in its JSON
  // — cells nest their payload under `data`, and a spec should not have to know
  // which layer a field lives on.
  cells.iter().any(|cell| {
    contains
      .iter()
      .all(|(k, v)| json_contains_pair(cell, k, v))
  })
}

/// Is `key: value` present anywhere in this JSON tree?
fn json_contains_pair(value: &serde_json::Value, key: &str, want: &serde_json::Value) -> bool {
  match value {
    serde_json::Value::Object(map) => {
      if map.get(key).is_some_and(|v| v == want) {
        return true;
      }
      map.values().any(|v| json_contains_pair(v, key, want))
    }
    serde_json::Value::Array(items) => {
      items.iter().any(|v| json_contains_pair(v, key, want))
    }
    _ => false,
  }
}

fn describe_expectation(expect: &RowExpectation) -> String {
  let mut parts = Vec::new();
  if let Some(c) = expect.count {
    parts.push(format!("{c} cell(s)"));
  }
  if let Some(contains) = expect.contains.as_ref() {
    if !contains.is_empty() {
      let pairs: Vec<String> = contains
        .iter()
        .map(|(k, v)| format!("{k}={}", truncate_json(v, 40)))
        .collect();
      parts.push(format!("containing {}", pairs.join(", ")));
    }
  }
  if let Some(absent) = expect.absent.as_ref() {
    if !absent.is_empty() {
      let pairs: Vec<String> = absent
        .iter()
        .map(|(k, v)| format!("{k}={}", truncate_json(v, 40)))
        .collect();
      parts.push(format!("no cell carrying {}", pairs.join(", ")));
    }
  }
  if parts.is_empty() {
    "anything".to_string()
  } else {
    parts.join(", ")
  }
}

fn truncate_json(value: &serde_json::Value, max: usize) -> String {
  let s = value.to_string();
  if s.chars().count() <= max {
    return s;
  }
  format!("{}…", s.chars().take(max).collect::<String>())
}

/// The run's sequence diagram, as a judge: every divergence it draws — a log
/// missing, early or in the wrong step, a step's `failure_log`, a forbidden
/// log, an error the spec fails on, the action that threw, a step no log
/// confirms — fails the run. The trace judge and this one both have to pass,
/// so a verdict can never read green over a diagram that shows red.
///
/// `ljson_path` is the trace the trace judge read; `steps.json` beside it, when
/// the runner wrote one, is what places each log in its step.
pub fn verify_sequence(spec: &TestSpec, ljson_path: &Path) -> Result<bool> {
  let raw = std::fs::read_to_string(ljson_path).context("Failed to read the trace")?;
  // The materialized trace stamps its client entries `"origin":"client"` and
  // leaves the server's request spans unstamped (`materialize_trace`), which is
  // how the trace judge (`LjsonEntry::is_client`) tells them apart; the diagram
  // must read them the same way. Only the client-only `logs.ljson` fallback,
  // written by the browser, means client by default.
  let is_trace = ljson_path.file_name().is_some_and(|name| name == "trace.ljson");
  let entries = crate::sequence::parse_entries(&raw, if is_trace { "server" } else { "client" });
  let steps = ljson_path
    .parent()
    .and_then(|dir| std::fs::read_to_string(dir.join("steps.json")).ok())
    .and_then(|raw| crate::sequence::parse_steps(&raw));
  let diagram = crate::sequence::compare(spec, steps.as_ref(), &entries);
  for section in &diagram.sections {
    for message in section.messages.iter().filter(|m| m.mark.is_divergence()) {
      let word = serde_json::to_value(message.mark)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
      let detail = message.detail.as_deref().map(|d| format!(" — {d}")).unwrap_or_default();
      info!("  ✗ Diagram, {}: {} {}{detail}", section.title, word, message.label);
    }
  }
  if diagram.divergences == 0 {
    info!("  ✓ The run matches its sequence diagram");
  }
  Ok(diagram.divergences == 0)
}

pub fn verify_trace_results(ljson_path: &Path, verification: &Verification) -> Result<bool> {
  let entries = read_ljson_file(ljson_path)?;
  validate_patterns(verification)?;
  let mut passed = true;

  // A step that drives the page and names no log is unconfirmed, whatever
  // the trace says: the spec has to say what the app logs when it works.
  for step in &verification.unlogged_steps {
    info!("  ✗ Step {step}: no log confirms it (the spec names no `logs`)");
    passed = false;
  }

  // Check required logs
  for required in &verification.required_logs {
    let desc = required.description.as_deref().unwrap_or(&required.pattern);
    let source_filter = required.source.as_deref();
    let max_dur = required.max_duration_ms.map(|d| d as i64);
    let Some(entries) = scoped_entries(&entries, required.after.as_deref(), source_filter) else {
      info!(
        "  ✗ Required SCOPE NEVER OPENED: {} (no entry matches after: {:?})",
        desc,
        required.after.as_deref().unwrap_or_default()
      );
      passed = false;
      continue;
    };

    if let Some(ref count_expr) = required.count {
      let actual = count_matches_in_entries(&entries, &required.pattern, source_filter, max_dur);
      let (ok, detail) = check_count(count_expr, actual);
      if ok {
        info!("  ✓ Required: {} ({})", desc, detail);
      } else {
        info!("  ✗ Required COUNT MISMATCH: {} ({})", desc, detail);
        passed = false;
      }
    } else {
      let found = entry_matches_in_entries(&entries, &required.pattern, source_filter, max_dur);
      if found {
        info!("  ✓ Required: {}", desc);
      } else {
        info!("  ✗ Required MISSING: {}", desc);
        passed = false;
      }
    }
  }

  // Check forbidden logs
  for forbidden in &verification.forbidden_logs {
    let desc = forbidden
      .description
      .as_deref()
      .unwrap_or(&forbidden.pattern);
    let source_filter = forbidden.source.as_deref();
    let Some(entries) = scoped_entries(&entries, forbidden.after.as_deref(), source_filter) else {
      info!(
        "  ✗ Forbidden SCOPE NEVER OPENED: {} (no entry matches after: {:?}, so nothing was checked)",
        desc,
        forbidden.after.as_deref().unwrap_or_default()
      );
      passed = false;
      continue;
    };

    if let Some(ref count_expr) = forbidden.count {
      let actual = count_matches_in_entries(&entries, &forbidden.pattern, source_filter, None);
      let (ok, detail) = check_count(count_expr, actual);
      if ok {
        info!("  ✓ Forbidden: {} ({})", desc, detail);
      } else {
        info!("  ✗ Forbidden COUNT MISMATCH: {} ({})", desc, detail);
        passed = false;
      }
    } else {
      let found = entry_matches_in_entries(&entries, &forbidden.pattern, source_filter, None);
      if found {
        info!("  ✗ Forbidden FOUND: {}", desc);
        passed = false;
      } else {
        info!("  ✓ Forbidden absent: {}", desc);
      }
    }
  }

  // Check sequences
  for seq in &verification.sequences {
    let desc = seq.description.as_deref().unwrap_or("(unnamed sequence)");
    let source_filter = seq.source.as_deref();

    // Sort entries by timestamp for ordering
    let mut sorted: Vec<&LjsonEntry> = entries.iter().collect();
    sorted.sort_by_key(|e| e.ts);

    // Filter by source
    let filtered: Vec<&&LjsonEntry> = sorted
      .iter()
      .filter(|entry| {
        if let Some(src) = source_filter {
          match src {
            "client" => entry.is_client(),
            "server" => !entry.is_client(),
            _ => true,
          }
        } else {
          true
        }
      })
      .collect();

    let mut cursor = 0;
    let mut all_found = true;
    let mut missing_pattern: Option<&str> = None;

    for pattern in &seq.patterns {
      let mut found = false;
      while cursor < filtered.len() {
        if entry_matches_pattern(filtered[cursor], pattern) {
          found = true;
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if !found {
        all_found = false;
        missing_pattern = Some(pattern);
        break;
      }
    }

    if all_found {
      info!("  ✓ Sequence: {}", desc);
    } else {
      info!(
        "  ✗ Sequence BROKEN: {} (stuck at pattern: {:?})",
        desc,
        missing_pattern.unwrap_or("?")
      );
      passed = false;
    }
  }

  // Auto-fail on error-level entries
  if verification.auto_fail_on_errors {
    use tento_logger::ljson::LjsonLevel;

    let mut unexpected_errors: Vec<String> = Vec::new();
    let mut navigation_aborts: Vec<String> = Vec::new();
    for entry in &entries {
      if entry.root_span.level == LjsonLevel::Error {
        let name = &entry.root_span.name;
        let msg = entry.root_span.message().unwrap_or("");
        let label = if msg.is_empty() {
          name.clone()
        } else {
          format!("{}: {}", name, msg)
        };

        // Check allowlist
        let allowed = verification
          .error_allowlist
          .iter()
          .any(|allow| pattern_matches(&label, allow, regex::Regex::new(allow).ok().as_ref()));

        if allowed {
          continue;
        }

        // A fetch the browser killed on unload is not an application error;
        // classify it (and still show it) rather than failing the run.
        if let Some(abort) = navigation_aborted_call(entry, &entries) {
          navigation_aborts.push(format!(
            "  ~ Skipped: api-call aborted by navigation ({}), {} +{}ms",
            abort.path, abort.marker, abort.delta_ms
          ));
          continue;
        }

        unexpected_errors.push(label);
      }
    }

    for line in &navigation_aborts {
      info!("{line}");
    }

    if unexpected_errors.is_empty() {
      info!("  ✓ No unexpected error-level entries");
    } else {
      for err in &unexpected_errors {
        info!("  ✗ Unexpected ERROR: {}", err);
      }
      passed = false;
    }
  }

  // Check required navigations
  if !verification.required_navigations.is_empty() {
    // Sort entries by timestamp
    let mut sorted: Vec<&LjsonEntry> = entries.iter().collect();
    sorted.sort_by_key(|e| e.ts);

    // Filter to navigation and page-load spans
    let nav_entries: Vec<&&LjsonEntry> = sorted
      .iter()
      .filter(|e| e.root_span.name == "navigation" || e.root_span.name == "page-load")
      .collect();

    let mut cursor = 0;
    let mut all_found = true;
    let mut missing_path: Option<&str> = None;

    for path in &verification.required_navigations {
      let mut found = false;
      while cursor < nav_entries.len() {
        let span = &nav_entries[cursor].root_span;
        // Check navigation span "to" attribute
        if let Some(to) = span.get_str("to") {
          if to.contains(path.as_str()) {
            found = true;
            cursor += 1;
            break;
          }
        }
        // Check page-load span "path" attribute
        if let Some(p) = span.get_str("path") {
          if p.contains(path.as_str()) {
            found = true;
            cursor += 1;
            break;
          }
        }
        cursor += 1;
      }
      if !found {
        all_found = false;
        missing_path = Some(path);
        break;
      }
    }

    if all_found {
      info!(
        "  ✓ Required navigations: all {} paths found in order",
        verification.required_navigations.len()
      );
    } else {
      info!(
        "  ✗ Required navigation MISSING: {:?}",
        missing_path.unwrap_or("?")
      );
      passed = false;
    }
  }

  // Check performance budgets
  if let Some(ref budget) = verification.performance {
    let api_entries: Vec<&LjsonEntry> = entries
      .iter()
      .filter(|e| e.root_span.name == "api-call" || e.root_span.get_str("http.method").is_some())
      .collect();

    if let Some(max_single) = budget.max_api_single_ms {
      let max_single_i64 = max_single as i64;
      let slowest = api_entries
        .iter()
        .filter_map(|e| e.root_span.duration_ms)
        .max()
        .unwrap_or(0);

      if slowest <= max_single_i64 {
        info!("  ✓ API single: {}ms <= {}ms budget", slowest, max_single);
      } else {
        info!(
          "  ✗ API single EXCEEDED: {}ms > {}ms budget",
          slowest, max_single
        );
        passed = false;
      }
    }

    if let Some(max_total) = budget.max_api_total_ms {
      let max_total_i64 = max_total as i64;
      let total: i64 = api_entries
        .iter()
        .filter_map(|e| e.root_span.duration_ms)
        .sum();

      if total <= max_total_i64 {
        info!("  ✓ API total: {}ms <= {}ms budget", total, max_total);
      } else {
        info!(
          "  ✗ API total EXCEEDED: {}ms > {}ms budget",
          total, max_total
        );
        passed = false;
      }
    }

    if let Some(max_total_s) = budget.max_total_duration_s {
      if let (Some(first_ts), Some(last_ts)) = (
        entries.iter().map(|e| e.ts).min(),
        entries.iter().map(|e| e.ts).max(),
      ) {
        let wall_secs = (last_ts - first_ts).num_seconds();
        if wall_secs <= max_total_s as i64 {
          info!(
            "  ✓ Total duration: {}s <= {}s budget",
            wall_secs, max_total_s
          );
        } else {
          info!(
            "  ✗ Total duration EXCEEDED: {}s > {}s budget",
            wall_secs, max_total_s
          );
          passed = false;
        }
      }
    }
  }

  Ok(passed)
}

/// The log file the trace judge reads for a run: the unified client+server
/// `trace.ljson` once [`materialize_trace`] has snapshotted it, else the
/// client-only `logs.ljson` the browser streamed. `None` when neither exists.
///
/// Shared so the runner's Phase 5 and the `complete` route's audit judge the
/// *same* bytes — a manual completion that fell back to `logs.ljson` and a
/// headless run that read `trace.ljson` would otherwise disagree by
/// construction rather than by evidence.
pub fn trace_judge_source(session_dir: &Path) -> Option<PathBuf> {
  let trace = session_dir.join("trace.ljson");
  if trace.exists() {
    return Some(trace);
  }
  let logs = session_dir.join("logs.ljson");
  logs.exists().then_some(logs)
}

/// How long after a statusless `api-call` error an unload marker still vouches
/// for it. Gaps in the recorded corpus run 0–51ms; 500ms is slack, not a
/// blanket — the marker still has to be there.
const NAVIGATION_ABORT_WINDOW_MS: i64 = 500;

/// Entries that only exist because the document was being torn down.
/// `page-load` is the new document announcing itself; the pagehide flush is the
/// old one draining pending writes on its way out.
const NAVIGATION_ABORT_MARKERS: [&str; 2] = ["page-load", "cell-persist/pagehide-flush"];

/// Why one error-level `api-call` entry was not counted as a failure.
pub(crate) struct NavigationAbort<'a> {
  /// Path the aborted call was issued against.
  path: &'a str,
  /// Name of the unload marker that vouches for it.
  marker: &'a str,
  /// How long after the error that marker landed.
  delta_ms: i64,
}

/// Classify an error-level entry as a `fetch()` the browser rejected because the
/// document unloaded underneath it — not an application failure.
///
/// The signature, all of which must hold: an `api-call` span at `level: error`,
/// carrying `http.path` but **no `http.status`**, with a `page-load` (or
/// `cell-persist/pagehide-flush`) entry landing within
/// [`NAVIGATION_ABORT_WINDOW_MS`] *after* it in the same session log. That is
/// what a spec rotating identity with `location.replace` leaves behind: the
/// in-flight request is killed mid-flight, the promise rejects with
/// `TypeError: Failed to fetch`, and the span closes having never seen a
/// response. The same path re-issues in the new document and returns 200.
///
/// It cannot hide a real failure. A server that answered at all sets
/// `http.status` on the span before the level is raised, so every non-2xx —
/// including the 500s already in the corpus — keeps its status and stays
/// counted. And the unload has to have actually happened: a statusless
/// `api-call` error with no page-load behind it is still reported. Neither
/// condition is something a failing request can manufacture for itself.
pub(crate) fn navigation_aborted_call<'a>(
  entry: &'a LjsonEntry,
  entries: &'a [LjsonEntry],
) -> Option<NavigationAbort<'a>> {
  if entry.root_span.name != "api-call" {
    return None;
  }
  if entry.root_span.attributes.contains_key("http.status") {
    return None;
  }
  let Some(path) = entry.root_span.get_str("http.path") else {
    return None;
  };

  // Rank markers so the report cites the strongest evidence: a `page-load`
  // beats a pagehide flush even when the flush landed first.
  let mut best: Option<((u8, i64), &str, i64)> = None;
  for other in entries {
    let name = other.root_span.name.as_str();
    if !NAVIGATION_ABORT_MARKERS.contains(&name) {
      continue;
    }
    let delta_ms = (other.ts - entry.ts).num_milliseconds();
    if delta_ms < 0 || delta_ms > NAVIGATION_ABORT_WINDOW_MS {
      continue;
    }
    let rank = (u8::from(name != "page-load"), delta_ms);
    if best.as_ref().is_none_or(|(prev, _, _)| rank < *prev) {
      best = Some((rank, name, delta_ms));
    }
  }

  let (_, marker, delta_ms) = best?;
  Some(NavigationAbort {
    path,
    marker,
    delta_ms,
  })
}

/// Check if a single entry matches pattern + source + duration constraints.
fn entry_matches_constraints(
  entry: &LjsonEntry,
  pattern: &str,
  source_filter: Option<&str>,
  max_duration_ms: Option<i64>,
) -> bool {
  // Filter by source if specified
  if let Some(src) = source_filter {
    match src {
      "client" => {
        if !entry.is_client() {
          return false;
        }
      }
      "server" => {
        if entry.is_client() {
          return false;
        }
      }
      _ => {}
    }
  }

  if !entry_matches_pattern(entry, pattern) {
    return false;
  }

  // Check duration constraint
  if let Some(max_ms) = max_duration_ms {
    let Some(duration) = entry.root_span.duration_ms else {
      return false;
    };
    if duration > max_ms {
      return false;
    }
  }

  true
}

/// The entries a pattern with `after: <anchor>` is judged over (see
/// [`LogPattern::after`](crate::spec::LogPattern::after)): every entry that
/// completed at or after the first anchor entry started. `None` when the
/// trace holds no anchor entry, which the caller reports as a failure. No
/// anchor declared ⇒ the whole trace, unchanged.
fn scoped_entries<'a>(
  entries: &'a [LjsonEntry],
  anchor: Option<&str>,
  source_filter: Option<&str>,
) -> Option<std::borrow::Cow<'a, [LjsonEntry]>> {
  let Some(anchor) = anchor else {
    return Some(std::borrow::Cow::Borrowed(entries));
  };
  let opened = entries
    .iter()
    .filter(|entry| entry_matches_constraints(entry, anchor, source_filter, None))
    .map(|entry| {
      let started_ms = entry.root_span.duration_ms.unwrap_or(0).max(0);
      entry.ts - chrono::Duration::milliseconds(started_ms)
    })
    .min()?;
  Some(std::borrow::Cow::Owned(
    entries
      .iter()
      .filter(|entry| entry.ts >= opened)
      .cloned()
      .collect(),
  ))
}

/// Check if any LJSON entry matches the pattern with optional source filtering.
fn entry_matches_in_entries(
  entries: &[LjsonEntry],
  pattern: &str,
  source_filter: Option<&str>,
  max_duration_ms: Option<i64>,
) -> bool {
  entries
    .iter()
    .any(|entry| entry_matches_constraints(entry, pattern, source_filter, max_duration_ms))
}

/// Count how many LJSON entries match the pattern with optional source filtering.
fn count_matches_in_entries(
  entries: &[LjsonEntry],
  pattern: &str,
  source_filter: Option<&str>,
  max_duration_ms: Option<i64>,
) -> usize {
  entries
    .iter()
    .filter(|entry| entry_matches_constraints(entry, pattern, source_filter, max_duration_ms))
    .count()
}

/// Parse a count expression and check if the actual count satisfies it.
///
/// Supported formats:
/// - `"3"` — exactly 3
/// - `"3+"` — at least 3
/// - `"0"` — zero (equivalent to forbidden)
/// - `"1..5"` — range (1 to 5 inclusive)
fn check_count(expr: &str, actual: usize) -> (bool, String) {
  let expr = expr.trim();

  // Range: "1..5"
  if let Some((lo, hi)) = expr.split_once("..") {
    let lo: usize = lo.trim().parse().unwrap_or(0);
    let hi: usize = hi.trim().parse().unwrap_or(usize::MAX);
    let pass = actual >= lo && actual <= hi;
    (pass, format!("expected {}..{}, got {}", lo, hi, actual))
  }
  // At least: "3+"
  else if let Some(prefix) = expr.strip_suffix('+') {
    let min: usize = prefix.trim().parse().unwrap_or(0);
    let pass = actual >= min;
    (pass, format!("expected {}+, got {}", min, actual))
  }
  // Exact: "3"
  else {
    let expected: usize = expr.parse().unwrap_or(0);
    let pass = actual == expected;
    (pass, format!("expected {}, got {}", expected, actual))
  }
}

/// Check if a string matches a pattern, using regex if valid, otherwise substring.
/// Reject a spec whose patterns cannot compile, before any of them is matched.
///
/// `entry_matches_pattern` falls back to a substring match when a pattern is not
/// valid regex. That fallback is deliberate — most patterns are plain span
/// names — but it is silent, and silence is the problem. A **forbidden** pattern
/// with a typo (`POST /api/sheets[`) compiles to nothing, degrades to a
/// substring that never occurs, and the guard is simply off: the spec goes green
/// while the thing it was written to catch happens freely.
///
/// A pattern that cannot compile is an authoring error either way, so this is a
/// hard failure rather than a warning. The distinguishing test is whether the
/// pattern contains regex metacharacters: a plain string like
/// `event-overlay/project` is valid regex and compiles fine, so only genuinely
/// malformed patterns reach the error.
fn validate_patterns(verification: &Verification) -> Result<()> {
  let mut bad: Vec<String> = Vec::new();
  let mut check = |kind: &str, p: &str| {
    if let Err(e) = regex::Regex::new(p) {
      bad.push(format!("  {kind}: {p:?}\n    {e}"));
    }
  };
  for r in &verification.required_logs {
    check("required_logs", &r.pattern);
    if let Some(a) = r.after.as_deref() {
      check("required_logs.after", a);
    }
  }
  for f in &verification.forbidden_logs {
    check("forbidden_logs", &f.pattern);
    if let Some(a) = f.after.as_deref() {
      check("forbidden_logs.after", a);
    }
  }
  for s in &verification.sequences {
    for p in &s.patterns {
      check("sequences", p);
    }
  }
  for p in &verification.error_allowlist {
    check("error_allowlist", p);
  }
  if bad.is_empty() {
    return Ok(());
  }
  anyhow::bail!(
    "spec has {} verification pattern(s) that are not valid regex; they would \
     silently degrade to substring matches, turning any forbidden_logs guard \
     among them off:\n{}",
    bad.len(),
    bad.join("\n")
  )
}

pub(crate) fn pattern_matches(text: &str, pattern: &str, regex: Option<&regex::Regex>) -> bool {
  if let Some(re) = regex {
    re.is_match(text)
  } else {
    text.contains(pattern)
  }
}

/// Check if a single LJSON entry matches a pattern string.
///
/// Tries regex first; falls back to substring match if the pattern isn't valid regex.
/// Checks span name, message attribute, HTTP summary line, and serialized attributes.
pub(crate) fn entry_matches_pattern(entry: &LjsonEntry, pattern: &str) -> bool {
  let regex = regex::Regex::new(pattern).ok();
  let re_ref = regex.as_ref();
  span_matches_pattern(&entry.root_span, pattern, re_ref)
}

fn span_matches_pattern(
  s: &tento_logger::ljson::LjsonSpan,
  pattern: &str,
  re_ref: Option<&regex::Regex>,
) -> bool {
  // Check span name
  if pattern_matches(&s.name, pattern, re_ref) {
    return true;
  }

  // Check message attribute
  if let Some(msg) = s.message() {
    if pattern_matches(msg, pattern, re_ref) {
      return true;
    }
  }

  // Build HTTP summary line — server format (http.status_code + http.target)
  if let (Some(status), Some(method), Some(target)) = (
    s.get_u64("http.status_code"),
    s.get_str("http.method"),
    s.get_str("http.target"),
  ) {
    let summary = format!("{} {} {}", status, method, target);
    if pattern_matches(&summary, pattern, re_ref) {
      return true;
    }
  }

  // Build HTTP summary line — client format (http.status + http.path, lowercase method)
  if let (Some(status), Some(method), Some(path)) = (
    s.get_u64("http.status"),
    s.get_str("http.method"),
    s.get_str("http.path"),
  ) {
    let summary = format!("{} {} {}", status, method.to_uppercase(), path);
    if pattern_matches(&summary, pattern, re_ref) {
      return true;
    }
  }

  // Page-load spans: build "GET {path}" from the `path` attribute
  if s.name == "page-load" {
    if let Some(path) = s.get_str("path") {
      let summary = format!("GET {}", path);
      if pattern_matches(&summary, pattern, re_ref) {
        return true;
      }
    }
  }

  // Structured attributes, one LEAF at a time as `dotted.key.path:value`.
  // `Tracing.log(label, data)` puts `data` here — not in the message — so a
  // spec gating on payload content (`skip@0 ` in a divergence detail, a
  // `verdict:loud` referee gate) matches nothing without this sweep. Leaves
  // are checked individually, never as one concatenated blob, so a `.*`
  // regex cannot bridge two unrelated attributes into a false positive
  // (`(401|403|500) .*/api/user/signin` must keep meaning "one HTTP summary
  // line", not "a 500 somewhere and a signin path elsewhere in the payload").
  for (key, value) in &s.attributes {
    if attribute_leaves_match(key, value, pattern, re_ref) {
      return true;
    }
  }

  // Recurse into children
  for child in &s.children {
    if let tento_logger::ljson::LjsonChild::Span(child_span) = child {
      if span_matches_pattern(child_span, pattern, re_ref) {
        return true;
      }
    }
  }

  false
}

/// Walk one attribute's value tree and match the pattern against each leaf,
/// rendered `dotted.key.path:value`. Objects extend the path; arrays keep
/// their parent path (element order carries no key); null never matches.
fn attribute_leaves_match(
  path: &str,
  value: &serde_json::Value,
  pattern: &str,
  re_ref: Option<&regex::Regex>,
) -> bool {
  match value {
    serde_json::Value::Null => false,
    serde_json::Value::String(v) => {
      pattern_matches(&format!("{}:{}", path, v), pattern, re_ref)
    }
    serde_json::Value::Number(v) => {
      pattern_matches(&format!("{}:{}", path, v), pattern, re_ref)
    }
    serde_json::Value::Bool(v) => {
      pattern_matches(&format!("{}:{}", path, v), pattern, re_ref)
    }
    serde_json::Value::Array(items) => items
      .iter()
      .any(|item| attribute_leaves_match(path, item, pattern, re_ref)),
    serde_json::Value::Object(map) => map.iter().any(|(key, item)| {
      attribute_leaves_match(&format!("{}.{}", path, key), item, pattern, re_ref)
    }),
  }
}

// ===========================================================================
// Real-time step monitoring
// ===========================================================================

/// Status of a monitored step.
#[derive(Clone, Debug)]
enum StepStatus {
  Pending,
  Validated,
  Failed,
}

/// A step being monitored.
#[derive(Clone, Debug)]
struct MonitoredStep {
  id: String,
  #[allow(dead_code)]
  instruction: String,
  success_pattern: String,
  failure_pattern: Option<String>,
  status: StepStatus,
}

/// Monitor a UX test session with real-time log validation.
///
/// Reads step patterns from the session's spec.yaml and matches them against
/// both client logs (logs.ljson) and server logs. Displays a live status table
/// that updates as log patterns are matched.
pub async fn run_monitor(
  logger: &LLMLogger,
  session_id: &str,
  server_log_path: &Path,
) -> Result<()> {
  // Read the spec to get step patterns
  let spec = logger
    .read_spec(session_id)?
    .context("No spec.yaml found for session")?;

  // Build list of steps with success_log patterns
  let mut monitored_steps: Vec<MonitoredStep> = spec
    .steps
    .iter()
    .filter(|step| step.success_log.is_some())
    .map(|step| MonitoredStep {
      id: step.id.clone(),
      instruction: step.instruction.clone(),
      success_pattern: spec.substitute_params(step.success_log.as_ref().unwrap()),
      failure_pattern: step.failure_log.as_ref().map(|p| spec.substitute_params(p)),
      status: StepStatus::Pending,
    })
    .collect();

  if monitored_steps.is_empty() {
    println!("No steps with success_log patterns found in spec.");
    return Ok(());
  }

  let poll_interval = Duration::from_secs(2);

  // Track server log position
  let mut server_log_position: u64 = if server_log_path.exists() {
    std::fs::metadata(server_log_path)
      .map(|m| m.len())
      .unwrap_or(0)
  } else {
    0
  };

  println!();
  print_monitor_header();
  print_monitor_table(&monitored_steps, session_id, "pending");

  loop {
    // Check session status
    let session = logger.get_session(session_id)?;
    let session_status = match session.status {
      SessionStatus::Pending => "pending",
      SessionStatus::InProgress => "in_progress",
      SessionStatus::Completed => "completed",
      SessionStatus::Abandoned => "abandoned",
    };

    // Read client LJSON entries
    let client_entries = logger.read_logs_ljson(session_id)?;

    // Read new server log entries since last check
    let server_logs = read_server_logs_since(server_log_path, server_log_position)?;
    if let Some(new_pos) = server_logs.1 {
      server_log_position = new_pos;
    }

    // Check each pending step against logs
    for step in &mut monitored_steps {
      if !matches!(step.status, StepStatus::Pending) {
        continue;
      }

      // Determine if pattern is for server or client logs
      let is_server_pattern = is_http_pattern(&step.success_pattern);

      // Check success pattern
      let success_matched = if is_server_pattern {
        matches_pattern_in_lines(&server_logs.0, &step.success_pattern)
      } else {
        matches_pattern_in_ljson(&client_entries, &step.success_pattern)
      };

      if success_matched {
        step.status = StepStatus::Validated;
        continue;
      }

      // Check failure pattern if present
      if let Some(ref fail_pattern) = step.failure_pattern {
        let is_server_fail = is_http_pattern(fail_pattern);
        let failure_matched = if is_server_fail {
          matches_pattern_in_lines(&server_logs.0, fail_pattern)
        } else {
          matches_pattern_in_ljson(&client_entries, fail_pattern)
        };

        if failure_matched {
          step.status = StepStatus::Failed;
        }
      }
    }

    // Clear and reprint status table
    print_clear_table(monitored_steps.len());
    print_monitor_table(&monitored_steps, session_id, session_status);

    // Exit if session completed or abandoned
    if session.status == SessionStatus::Completed || session.status == SessionStatus::Abandoned {
      println!();
      print_final_summary(&monitored_steps);
      break;
    }

    sleep(poll_interval).await;
  }

  Ok(())
}

/// Check if a pattern looks like an HTTP log pattern (for server logs).
pub(crate) fn is_http_pattern(pattern: &str) -> bool {
  // HTTP patterns typically start with status codes or contain HTTP methods
  let pattern_lower = pattern.to_lowercase();
  pattern.starts_with("200 ")
    || pattern.starts_with("201 ")
    || pattern.starts_with("400 ")
    || pattern.starts_with("401 ")
    || pattern.starts_with("403 ")
    || pattern.starts_with("404 ")
    || pattern.starts_with("500 ")
    || pattern.starts_with('(') // Regex group like (401|403|500)
    || pattern_lower.contains(" post ")
    || pattern_lower.contains(" get ")
    || pattern_lower.contains(" put ")
    || pattern_lower.contains(" delete ")
}

/// Read server log lines since a byte position.
fn read_server_logs_since(path: &Path, position: u64) -> Result<(Vec<String>, Option<u64>)> {
  use std::io::{Seek, SeekFrom};

  if !path.exists() {
    return Ok((Vec::new(), None));
  }

  let file = File::open(path).context("Failed to open server log")?;
  let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);

  let mut reader = BufReader::new(file);
  reader.seek(SeekFrom::Start(position))?;

  let mut lines = Vec::new();
  for line in reader.lines() {
    let line = line.context("Failed to read log line")?;
    lines.push(line);
  }

  Ok((lines, Some(file_len)))
}

/// Check if any line matches the regex pattern.
fn matches_pattern_in_lines(lines: &[String], pattern: &str) -> bool {
  let Ok(regex) = regex::Regex::new(pattern) else {
    // Fall back to substring match if regex is invalid
    return lines.iter().any(|line| line.contains(pattern));
  };

  lines.iter().any(|line| regex.is_match(line))
}

/// Check if any LJSON entry matches the pattern.
fn matches_pattern_in_ljson(entries: &[LjsonEntry], pattern: &str) -> bool {
  let regex = regex::Regex::new(pattern).ok();

  entries.iter().any(|entry| {
    // Match against span name
    let name_matches = if let Some(ref re) = regex {
      re.is_match(&entry.root_span.name)
    } else {
      entry.root_span.name.contains(pattern)
    };

    if name_matches {
      return true;
    }

    // Match against serialized attributes
    let attrs_str = serde_json::to_string(&entry.root_span.attributes).unwrap_or_default();
    if let Some(ref re) = regex {
      if re.is_match(&attrs_str) {
        return true;
      }
    } else if attrs_str.contains(pattern) {
      return true;
    }

    false
  })
}

/// Print the monitor header.
fn print_monitor_header() {
  println!("Step Validation Status");
  println!("{}", "─".repeat(70));
  println!(" {:^7} │ {:^20} │ {}", "Status", "Step", "Pattern");
  println!("{}", "─".repeat(70));
}

/// Print the monitor table.
fn print_monitor_table(steps: &[MonitoredStep], _session_id: &str, status: &str) {
  for step in steps {
    let (icon, color) = match step.status {
      StepStatus::Pending => ("○", "\x1b[90m"),   // gray
      StepStatus::Validated => ("✓", "\x1b[32m"), // green
      StepStatus::Failed => ("✗", "\x1b[31m"),    // red
    };

    // Truncate step ID and pattern for display
    let step_id = if step.id.len() > 20 {
      format!("{}...", &step.id[..17])
    } else {
      step.id.clone()
    };

    let pattern = if step.success_pattern.len() > 35 {
      format!("{}...", &step.success_pattern[..32])
    } else {
      step.success_pattern.clone()
    };

    println!(
      "{}   {}   │ {:^20} │ {}\x1b[0m",
      color, icon, step_id, pattern
    );
  }
  println!("{}", "─".repeat(70));
  println!("Monitoring... (session: {})", status);
}

/// Clear the table by moving cursor up.
fn print_clear_table(num_steps: usize) {
  // Move up: header (4 lines) + steps + footer (2 lines)
  let lines_to_clear = 4 + num_steps + 2;
  print!("\x1b[{}A", lines_to_clear);
  for _ in 0..lines_to_clear {
    print!("\x1b[2K\n");
  }
  print!("\x1b[{}A", lines_to_clear);
}

/// Print final summary after session completes.
fn print_final_summary(steps: &[MonitoredStep]) {
  let validated = steps
    .iter()
    .filter(|s| matches!(s.status, StepStatus::Validated))
    .count();
  let failed = steps
    .iter()
    .filter(|s| matches!(s.status, StepStatus::Failed))
    .count();
  let pending = steps
    .iter()
    .filter(|s| matches!(s.status, StepStatus::Pending))
    .count();

  println!("Final Results:");
  println!("  \x1b[32m✓ Validated: {}\x1b[0m", validated);
  if failed > 0 {
    println!("  \x1b[31m✗ Failed: {}\x1b[0m", failed);
  }
  if pending > 0 {
    println!("  \x1b[90m○ Not matched: {}\x1b[0m", pending);
  }
}

#[cfg(test)]
mod host_verb_tests {
  use super::*;
  use serde_json::json;

  fn spec(yaml: &str) -> TestSpec {
    TestSpec::from_yaml(yaml).unwrap()
  }

  fn known(verbs: &[&str]) -> Vec<String> {
    verbs.iter().map(|v| v.to_string()).collect()
  }

  /// The lint's whole job: a typo parses fine and would only surface at
  /// dispatch, so it has to be caught reading the spec.
  #[test]
  fn unknown_verbs_are_found_in_all_phases_and_deduped() {
    let s = spec(
      r#"id: t
name: t
setup:
  - action: create_trial_user
    user: a
  - action: craete_trial_user
    user: b
  - action: wait
    seconds: 1
steps:
  - id: fixture
    instruction: fixture
    actions:
      - action: host
        verb: set_subscription_fixture
        params:
          user: a
          state: active_pro
teardown:
  - action: craete_trial_user
    user: c
  - action: reset_for_test
    user: d
  - action: stop_log_capture
instructions:
  - x
"#,
    );
    assert_eq!(
      unknown_host_actions(
        &s,
        &known(&[
          "create_trial_user",
          "reset_for_test",
          "set_subscription_fixture",
        ]),
      ),
      vec!["craete_trial_user".to_string()]
    );
    // Core verbs are never host verbs, so an empty host vocabulary is fine for
    // a spec that only sleeps and captures logs.
    let core_only = spec(
      "id: t\nname: t\nsetup:\n  - action: wait\n    seconds: 1\nteardown:\n  - action: stop_log_capture\ninstructions:\n  - x\n",
    );
    assert!(unknown_host_actions(&core_only, &[]).is_empty());
  }

  /// How `create_promo_key`'s implicit `promo_code` param survives losing its
  /// typed variant: the host returns a map, and every string entry becomes a
  /// spec param. No per-verb code anywhere.
  #[test]
  fn a_map_result_publishes_its_string_entries_as_params() {
    let mut s = spec("id: t\nname: t\ninstructions:\n  - x\n");
    absorb_verb_result(
      &mut s,
      "create_promo_key",
      None,
      json!({ "promo_code": "ABC-123", "count": 1 }),
    )
    .unwrap();
    assert_eq!(s.params.get("promo_code").map(String::as_str), Some("ABC-123"));
    assert!(s.params.get("count").is_none(), "non-strings are not params");
    assert_eq!(s.substitute_params("/trynow?promo={{promo_code}}"), "/trynow?promo=ABC-123");
  }

  /// `store_as` is spec plumbing: the machinery strips it before dispatch and
  /// applies it to the result, so no host implements it.
  #[test]
  fn store_as_names_the_param_a_string_result_lands_in() {
    let mut s = spec("id: t\nname: t\ninstructions:\n  - x\n");
    absorb_verb_result(&mut s, "add_product_key", Some("key".to_string()), json!("K-9"))
      .unwrap();
    assert_eq!(s.params.get("key").map(String::as_str), Some("K-9"));

    // A verb that declares store_as and hands back something that cannot be
    // substituted into a string is an authoring/host disagreement, not a param.
    let err = absorb_verb_result(&mut s, "add_product_key", Some("key".to_string()), json!({}))
      .unwrap_err()
      .to_string();
    assert!(err.contains("store_as"), "{err}");
  }

  /// Params are `{{param}}`-substituted and `store_as` never reaches the host.
  #[test]
  fn host_params_are_substituted_and_store_as_is_lifted_out() {
    let mut s = spec("id: t\nname: t\ninstructions:\n  - x\n");
    s.params.insert("user_email".to_string(), "a@b.com".to_string());
    let (params, store_as) = host_params(
      &s,
      &json!({ "user": "{{user_email}}", "tier": "Pro", "store_as": "key" }),
    );
    assert_eq!(params, json!({ "user": "a@b.com", "tier": "Pro" }));
    assert_eq!(store_as.as_deref(), Some("key"));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // A headless runner that dies before the harness can post completion (a
  // boot navigation refused, a DNS failure, any net::ERR_*) used to leave the
  // CLI polling for the spec's whole timeout: 120-600 s per spec on rwc-04
  // (ux-sweep 2026-10-09, nav-clear-selected hit the 600 s alarm). Once the
  // runner has exited, the wait is a short grace, and the run ends red with
  // the error the runner recorded.

  use crate::session::Session;
  use crate::spec::TestSpec;

  fn runner_failure_rig(tag: &str) -> (PathBuf, LLMLogger, HostPort, String) {
    let root = std::env::temp_dir().join(format!(
      "ux-runner-failure-{tag}-{}",
      Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let logger = LLMLogger::new(root.join("runs"));
    let session = Session {
      id: "s-runner-failure".to_string(),
      prefix: "t".to_string(),
      instructions: Vec::new(),
      metadata: None,
      status: SessionStatus::Pending,
      created_at: chrono::Utc::now(),
      flaky: None,
      tracing_uuid: None,
      display_params: None,
      test_id: None,
      completed_steps: Vec::new(),
    };
    let spec = TestSpec::ephemeral("t".to_string(), "t".to_string(), vec![]);
    logger.create_session_with_spec(&session, &spec).unwrap();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    (root, logger, HostPort::new(Vec::new(), tx), session.id)
  }

  #[tokio::test]
  async fn a_runner_that_exited_without_completing_ends_the_run_red_with_its_error() {
    let (root, logger, port, id) = runner_failure_rig("recorded");
    std::fs::write(
      logger.session_dir(&id).unwrap().join(RUNNER_FAILURE_FILE),
      r#"{"step":-1,"error":"Error: net::ERR_CONNECTION_REFUSED at https://dev.example.test/?ux=s","url":"chrome-error://chromewebdata/","title":"dev.example.test"}"#,
    )
    .unwrap();
    let started = std::time::Instant::now();
    let done = await_completion_after_runner_failure(&logger, &port, &id, 1)
      .await
      .unwrap();
    assert!(
      started.elapsed() < Duration::from_secs(10),
      "{:?}",
      started.elapsed()
    );
    let completion = done.completion.expect("a failure completion is written");
    assert_eq!(completion.result, SessionResult::Failure);
    let feedback = completion.feedback.unwrap();
    assert!(
      feedback.contains("net::ERR_CONNECTION_REFUSED"),
      "{feedback}"
    );
    assert!(feedback.contains("step -1"), "{feedback}");
    assert!(matches!(
      logger.get_session(&id).unwrap().status,
      SessionStatus::Completed
    ));
    let _ = std::fs::remove_dir_all(root);
  }

  #[tokio::test]
  async fn a_runner_that_left_no_record_still_ends_the_run_red_promptly() {
    let (root, logger, port, id) = runner_failure_rig("unrecorded");
    let done = await_completion_after_runner_failure(&logger, &port, &id, 1)
      .await
      .unwrap();
    let completion = done.completion.unwrap();
    assert_eq!(completion.result, SessionResult::Failure);
    assert!(
      completion
        .feedback
        .unwrap()
        .contains("without completing the session"),
    );
    let _ = std::fs::remove_dir_all(root);
  }

  #[tokio::test]
  async fn a_completion_the_runner_did_post_is_kept_as_posted() {
    let (root, logger, port, id) = runner_failure_rig("posted");
    logger
      .mark_complete(
        &id,
        SessionResult::Failure,
        Some("headless: step 3 failed: x".into()),
      )
      .unwrap();
    let done = await_completion_after_runner_failure(&logger, &port, &id, 1)
      .await
      .unwrap();
    assert_eq!(
      done.completion.unwrap().feedback.as_deref(),
      Some("headless: step 3 failed: x")
    );
    let _ = std::fs::remove_dir_all(root);
  }

  /// Review K-7: the grace wait's error branch. A session that is abandoned
  /// (Skip), or that the store cannot read, after the runner exits is an
  /// `Err`. It is not a synthesized red completion. So `run_single` takes the
  /// one `Err` arm that it shares with the spec-timeout wait: teardown, then
  /// the error (scripts.rs
  /// `agent_drive_tests::teardown_runs_when_the_completion_wait_errors`).
  #[tokio::test]
  async fn a_session_abandoned_or_unreadable_after_a_runner_exit_is_an_error() {
    let (root, logger, port, id) = runner_failure_rig("abandoned");
    logger.mark_abandoned(&id).unwrap();
    let err = await_completion_after_runner_failure(&logger, &port, &id, 1)
      .await
      .err()
      .expect("an abandoned session is no completion");
    assert!(format!("{err:#}").contains("abandoned"), "{err:#}");
    assert!(
      logger.read_completion(&id).unwrap().is_none(),
      "no failure completion is synthesized over a Skip"
    );
    assert!(
      await_completion_after_runner_failure(&logger, &port, "s-no-such-session", 1)
        .await
        .is_err(),
      "a session the store cannot read is an error"
    );
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn target_uses_initial_path_when_provided() {
    let target = SessionTarget::from_full_host(
      "app.example.test".to_string(),
      Some("/sheet/ss_7465d204336648dcac2b56d88f2cafb0"),
    );

    assert_eq!(target.full_host, "app.example.test");
    assert_eq!(target.host_only, "app.example.test");
    assert_eq!(
      target.target_path,
      "/sheet/ss_7465d204336648dcac2b56d88f2cafb0"
    );
    assert_eq!(
      target.url(
        "2026-06-30_cell-persist-refresh-debug_1be240",
        None,
        Some("/sheet/ss_7465d204336648dcac2b56d88f2cafb0"),
      ),
      "https://app.example.test/sheet/ss_7465d204336648dcac2b56d88f2cafb0?ux=2026-06-30_cell-persist-refresh-debug_1be240",
    );
  }

  #[test]
  fn target_uses_host_path_when_initial_path_is_absent() {
    let target =
      SessionTarget::from_full_host("app.example.test/sheet?title=Health".to_string(), None);

    assert_eq!(target.full_host, "app.example.test/sheet?title=Health");
    assert_eq!(target.host_only, "app.example.test");
    assert_eq!(target.target_path, "/sheet?title=Health");
    assert_eq!(
      target.url("session", None, None),
      "https://app.example.test/sheet?title=Health&ux=session",
    );
  }

  #[test]
  fn target_defaults_to_root_path() {
    let target = SessionTarget::from_full_host("app.example.test".to_string(), None);

    assert_eq!(target.full_host, "app.example.test");
    assert_eq!(target.host_only, "app.example.test");
    assert_eq!(target.target_path, "/");
    assert_eq!(
      target.url("session", None, None),
      "https://app.example.test?ux=session"
    );
  }

  /// The whole point of the scheme field: an http-only app gets http URLs, in
  /// the origin AND in the boot URL. Getting one right and the other wrong
  /// would send the browser somewhere that does not answer.
  #[test]
  fn an_http_profile_builds_http_urls() {
    let target = SessionTarget::from_full_host("tento.localhost:4720".to_string(), None)
      .with_scheme(crate::env_profile::Scheme::Http);
    assert_eq!(target.origin(), "http://tento.localhost:4720");
    assert_eq!(
      target.url("session", None, Some("/hosts")),
      "http://tento.localhost:4720/hosts?ux=session"
    );
  }

  /// An initial path that routes by hash (`/#tab:chat`) keeps its fragment,
  /// and the session params land in the query before it. Appending them after
  /// the `#` put them inside the fragment, where the page never sees `ux`
  /// (candidate.8 chat-storybooks: `/#tab:chat?ux=…&tid=…`, boot timeout).
  #[test]
  fn session_params_go_before_the_initial_paths_fragment() {
    let tid = Uuid::parse_str("6f1c1f3e-8d7a-4c1b-9a51-2f0e3c4d5b6a").unwrap();
    let target = SessionTarget::from_full_host("rc--ui.lona.so".to_string(), Some("/#tab:chat"));
    assert_eq!(
      target.url("s1", Some(tid), Some("/#tab:chat")),
      "https://rc--ui.lona.so/?ux=s1&tid=6f1c1f3e-8d7a-4c1b-9a51-2f0e3c4d5b6a#tab:chat",
    );
    // a query already in the path is joined with `&`, still before the `#`
    assert_eq!(
      target.url("s1", None, Some("/sheet?title=Health#row:3")),
      "https://rc--ui.lona.so/sheet?title=Health&ux=s1#row:3",
    );
    // a `?` that only appears inside the fragment is not the query
    assert_eq!(
      target.url("s1", None, Some("/#tab:chat?x=1")),
      "https://rc--ui.lona.so/?ux=s1#tab:chat?x=1",
    );
  }

  /// The same rule for a url pattern that carries its own fragment.
  #[test]
  fn session_params_go_before_the_url_patterns_fragment() {
    let target = SessionTarget::from_full_host("app.example.test/#tab:chat".to_string(), None);
    assert_eq!(
      target.url("session", None, None),
      "https://app.example.test/?ux=session#tab:chat",
    );
  }

  /// A target nobody set a scheme on stays https, so every host adapter that
  /// predates the field keeps working untouched.
  #[test]
  fn a_target_defaults_to_https() {
    let target = SessionTarget::from_full_host("app.example.test".to_string(), None);
    assert_eq!(target.origin(), "https://app.example.test");
  }
}

#[cfg(test)]
mod row_assertion_tests {
  use super::*;
  use crate::spec::RowExpectation;
  use serde_json::json;

  fn pairs_map(
    pairs: &[(&str, serde_json::Value)],
  ) -> Option<std::collections::BTreeMap<String, serde_json::Value>> {
    if pairs.is_empty() {
      return None;
    }
    Some(
      pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect(),
    )
  }

  fn expect(count: Option<usize>, pairs: &[(&str, serde_json::Value)]) -> RowExpectation {
    RowExpectation {
      count,
      contains: pairs_map(pairs),
      absent: None,
    }
  }

  fn expect_absent(
    count: Option<usize>,
    absent: &[(&str, serde_json::Value)],
  ) -> RowExpectation {
    RowExpectation {
      count,
      contains: None,
      absent: pairs_map(absent),
    }
  }

  /// The move-to-calendar shape: the destination must hold it, the source must
  /// not. `count: 0` is the assertion a trace-only judge could never make.
  #[test]
  fn count_zero_is_the_empty_assertion() {
    assert!(expectation_holds(&expect(Some(0), &[]), &[]));
    assert!(!expectation_holds(&expect(Some(0), &[]), &[json!({"x": 1})]));
  }

  #[test]
  fn count_must_match_exactly() {
    let cells = vec![json!({"a": 1}), json!({"a": 2})];
    assert!(expectation_holds(&expect(Some(2), &[]), &cells));
    assert!(!expectation_holds(&expect(Some(1), &[]), &cells));
    assert!(!expectation_holds(&expect(Some(3), &[]), &cells));
  }

  /// A cell nests its payload under `data`, and a spec should not have to know
  /// which layer a field lives on.
  #[test]
  fn contains_reaches_nested_fields() {
    let cells = vec![json!({
      "date": "ymd-2026-08-07",
      "data": { "title": "UX drag persist", "source": "google" }
    })];
    assert!(expectation_holds(
      &expect(None, &[("title", json!("UX drag persist"))]),
      &cells
    ));
    assert!(expectation_holds(
      &expect(Some(1), &[("source", json!("google"))]),
      &cells
    ));
    assert!(!expectation_holds(
      &expect(None, &[("title", json!("something else"))]),
      &cells
    ));
  }

  /// Every declared pair must hold in the SAME cell — two half-matches across
  /// two cells is not a match, or "one event moved" would pass while two
  /// unrelated ones sat there.
  #[test]
  fn contains_pairs_must_hold_in_one_cell() {
    let cells = vec![
      json!({"data": {"title": "A", "calendar": "primary"}}),
      json!({"data": {"title": "B", "calendar": "events"}}),
    ];
    assert!(expectation_holds(
      &expect(None, &[("title", json!("A")), ("calendar", json!("primary"))]),
      &cells
    ));
    assert!(!expectation_holds(
      &expect(None, &[("title", json!("A")), ("calendar", json!("events"))]),
      &cells
    ));
  }

  #[test]
  fn no_expectation_is_satisfied_by_anything() {
    assert!(expectation_holds(&expect(None, &[]), &[]));
    assert!(expectation_holds(&expect(None, &[]), &[json!({"a": 1})]));
  }

  /// The shape every events cleanup check actually wants. The two recurring
  /// MASTER cells below are what a real account returns for *any* window (their
  /// stored end date is the 9999 recurrence horizon and the range filter is an
  /// overlap test), so `count: 0` could never hold — but "my event is gone" can.
  #[test]
  fn absent_holds_when_no_cell_carries_the_title() {
    let cells = vec![
      json!({"date": "ymd-2027-09-22", "data": {"t": "groovy", "rec": true}}),
      json!({"date": "ymd-2027-09-22", "data": {"t": "shanna", "rec": true}}),
    ];
    assert!(expectation_holds(
      &expect_absent(None, &[("t", json!("UX Delete"))]),
      &cells
    ));
    assert!(expectation_holds(
      &expect_absent(None, &[("t", json!("UX Delete"))]),
      &[]
    ));
  }

  #[test]
  fn absent_is_violated_by_a_matching_cell() {
    let cells = vec![
      json!({"data": {"t": "groovy"}}),
      json!({"data": {"t": "UX Delete", "st": "14:00"}}),
    ];
    assert!(!expectation_holds(
      &expect_absent(None, &[("t", json!("UX Delete"))]),
      &cells
    ));
  }

  /// Mirror of `contains_pairs_must_hold_in_one_cell`: a cell that carries only
  /// some of the declared pairs is not the cell being ruled out.
  #[test]
  fn absent_pairs_must_all_hold_in_one_cell_to_violate() {
    let cells = vec![
      json!({"data": {"t": "UX Delete", "cal": "work"}}),
      json!({"data": {"t": "groovy", "cal": "primary"}}),
    ];
    assert!(expectation_holds(
      &expect_absent(None, &[("t", json!("UX Delete")), ("cal", json!("primary"))]),
      &cells
    ));
    assert!(!expectation_holds(
      &expect_absent(None, &[("t", json!("UX Delete")), ("cal", json!("work"))]),
      &cells
    ));
  }

  /// Set fields compose as an AND — a spec that pins both the window size and
  /// the missing event fails if either half is wrong.
  #[test]
  fn absent_composes_with_count() {
    let cells = vec![json!({"data": {"t": "groovy"}}), json!({"data": {"t": "shanna"}})];
    assert!(expectation_holds(
      &expect_absent(Some(2), &[("t", json!("UX Delete"))]),
      &cells
    ));
    // count wrong, absent right
    assert!(!expectation_holds(
      &expect_absent(Some(3), &[("t", json!("UX Delete"))]),
      &cells
    ));
    // count right, absent violated
    assert!(!expectation_holds(
      &expect_absent(Some(2), &[("t", json!("groovy"))]),
      &cells
    ));
  }

  /// An empty map asserts nothing. The alternative — every cell matching the
  /// empty pair set vacuously — would fail any non-empty window, which is the
  /// unsatisfiable behavior this field exists to retire.
  #[test]
  fn empty_absent_asserts_nothing() {
    let empty = RowExpectation {
      count: None,
      contains: None,
      absent: Some(std::collections::BTreeMap::new()),
    };
    assert!(expectation_holds(&empty, &[json!({"data": {"t": "groovy"}})]));
  }

  /// The wire shape the five events specs now carry, parsed the way the runner
  /// parses them.
  #[test]
  fn absent_parses_from_spec_yaml() {
    let expect: RowExpectation = serde_yml::from_str("absent:\n  t: UX Delete\n").unwrap();
    assert!(expect.count.is_none());
    assert!(!expectation_holds(
      &expect,
      &[json!({"data": {"t": "UX Delete"}})]
    ));
    assert!(expectation_holds(
      &expect,
      &[json!({"data": {"t": "groovy"}})]
    ));
    assert_eq!(describe_expectation(&expect), "no cell carrying t=\"UX Delete\"");
  }

  fn pat(p: &str) -> crate::spec::LogPattern {
    serde_json::from_value(json!({ "pattern": p })).unwrap()
  }

  /// A guard that cannot compile is a guard that is off. The substring fallback
  /// makes that silent, so the pattern is rejected before it can be trusted.
  #[test]
  fn malformed_forbidden_pattern_is_rejected_not_degraded() {
    let mut v: Verification = serde_json::from_value(json!({})).unwrap();
    v.forbidden_logs = vec![pat("POST /api/sheets[")];
    let err = validate_patterns(&v).unwrap_err().to_string();
    assert!(err.contains("forbidden_logs"), "{err}");
    assert!(err.contains("POST /api/sheets["), "{err}");
  }

  #[test]
  fn a_malformed_after_anchor_is_rejected_too() {
    let mut v: Verification = serde_json::from_value(json!({})).unwrap();
    v.forbidden_logs = vec![serde_json::from_value(json!({
      "pattern": "effect:cell-content-column",
      "after": "app-command/setEphemeralCells("
    }))
    .unwrap()];
    let err = validate_patterns(&v).unwrap_err().to_string();
    assert!(err.contains("forbidden_logs.after"), "{err}");
  }

  /// Plain span names are valid regex and must keep working — the corpus is
  /// mostly these, and rejecting them would be worse than the bug.
  #[test]
  fn plain_span_name_patterns_still_validate() {
    let mut v: Verification = serde_json::from_value(json!({})).unwrap();
    v.required_logs = vec![
      pat("event-overlay/project"),
      pat("app-command/showCreateEventFormModal"),
      pat("200 POST /api/rows"),
      pat("(401|403|500) .*/api/user/signin"),
      pat("POST /api/sheets$"),
    ];
    assert!(validate_patterns(&v).is_ok());
  }

  #[test]
  fn malformed_patterns_are_reported_together_with_their_kind() {
    let mut v: Verification = serde_json::from_value(json!({})).unwrap();
    v.required_logs = vec![pat("good"), pat("bad(")];
    v.sequences = vec![serde_json::from_value(json!({
      "patterns": ["also-bad["]
    }))
    .unwrap()];
    let err = validate_patterns(&v).unwrap_err().to_string();
    assert!(err.contains("2 verification pattern(s)"), "{err}");
    assert!(err.contains("required_logs"), "{err}");
    assert!(err.contains("sequences"), "{err}");
  }

  /// Build an entry the same shape the client trace writer emits, with the
  /// given attributes on the root span.
  fn entry_with_attributes(name: &str, attributes: serde_json::Value) -> LjsonEntry {
    serde_json::from_value(json!({
      "v": 1,
      "ts": "2026-08-29T08:32:41.418Z",
      "sessionId": "3033fd1b-bd66-4373-a4a6-7364097b7d12",
      "origin": "client",
      "rootSpan": {
        "id": 1,
        "name": name,
        "level": "info",
        "location": {},
        "attributes": attributes,
        "children": []
      }
    }))
    .unwrap()
  }

  /// `Tracing.log(label, data)` puts `data` in attributes, not the message.
  /// A payload-content gate (referee-zero's `skip@0 `) must reach a nested
  /// leaf, or the forbidden pattern is silently vacuous.
  #[test]
  fn nested_attribute_leaf_matches_payload_pattern() {
    let entry = entry_with_attributes(
      "scene/cell-referee",
      json!({
        "verdict": "loud",
        "firstDivergence": {
          "index": 0,
          "reason": "cursor-would-repaint",
          "detail": "skip@0 but the render cursor would repaint this row"
        }
      }),
    );
    assert!(entry_matches_pattern(&entry, "skip@0 "));
    assert!(entry_matches_pattern(&entry, "verdict:loud"));
    assert!(entry_matches_pattern(&entry, "firstDivergence.reason:cursor-would-repaint"));
    assert!(!entry_matches_pattern(&entry, "verdict:exact"));
  }

  /// Leaves are matched one at a time — a `.*` regex must not bridge two
  /// unrelated attributes into a false positive (the corpus's HTTP-status
  /// forbidden patterns rely on this).
  #[test]
  fn attribute_sweep_does_not_bridge_across_leaves() {
    let entry = entry_with_attributes(
      "api-call",
      json!({
        "durationBudget": 500,
        "path": "/api/user/signin",
        "status": 200
      }),
    );
    assert!(!entry_matches_pattern(&entry, "(401|403|500) .*/api/user/signin"));
    assert!(entry_matches_pattern(&entry, "durationBudget:500"));
  }

  /// Numeric and array leaves participate; null never matches anything.
  #[test]
  fn numeric_array_and_null_attribute_leaves() {
    let entry = entry_with_attributes(
      "render-next/column-shape",
      json!({
        "cellVerdict": null,
        "lr6": { "divergences": 3 },
        "kinds": ["mount", "recycle"]
      }),
    );
    assert!(entry_matches_pattern(&entry, "lr6.divergences:3"));
    assert!(entry_matches_pattern(&entry, "kinds:recycle"));
    assert!(!entry_matches_pattern(&entry, "cellVerdict:null"));
  }
}

// ===========================================================================
// Completion audit
// ===========================================================================

/// Judge a just-completed session against its spec's `verification` block and
/// persist the verdict as `verification.json`.
///
/// Runs only for `success` completions. The record OUTRANKS `complete.json` in
/// `RunFolder::result`, so auditing a "Still broken" could launder an
/// operator-reported failure into a green — a failure claim stands unaudited.
/// Trace judge only: row assertions need the runner's port context, which this
/// route does not have. When the runner drove the session, its Phase 5
/// overwrites this record with the full two-judge verdict moments later.
///
/// Best-effort by design: a bookkeeping error must never fail the completion
/// POST that carried it, so the fallible body lives in
/// [`try_audit_completion`] and errors degrade to a server-log warning.
///
/// Lives here, not in [`crate::http`]: it reads `spec.yaml` and re-runs the
/// trace judge, so it is harness, not wire contract. The `complete` route
/// reaches it as a [`crate::http::CompletionAudit`] the mount registers.
pub fn audit_completion(logger: &LLMLogger, session_id: &str) {
  if let Err(e) = try_audit_completion(logger, session_id) {
    tracing::warn!("completion audit skipped for {session_id}: {e:#}");
  }
}

fn try_audit_completion(logger: &LLMLogger, session_id: &str) -> anyhow::Result<()> {
  use crate::folder::VerificationOutcome;

  let dir = logger.session_dir(session_id)?;
  // Ephemeral sessions carry no spec, and a spec without a `verification`
  // block asserted nothing. Neither gets a record — its absence preserves
  // today's reading of the bare completion.
  let Ok(spec) = TestSpec::from_yaml_file(&dir.join("spec.yaml")) else {
    return Ok(());
  };
  let Some(verification) = spec.judged_verification() else {
    return Ok(());
  };
  let verification = &verification;
  // Same bytes the runner's Phase 5 judges: the unified trace when it has been
  // materialized, the client-only log (the norm for popover completions) when
  // it has not.
  let Some(verify_path) = trace_judge_source(&dir) else {
    return Ok(());
  };
  let trace_ok = verify_trace_results(&verify_path, verification)?;
  let diagram_ok = verify_sequence(&spec, &verify_path)?;
  let (outcome, detail) = if trace_ok && diagram_ok {
    (
      VerificationOutcome::Passed,
      Some(
        "judged at completion — trace judge only (row assertions run only under the runner)"
          .to_string(),
      ),
    )
  } else {
    (
      VerificationOutcome::Failed,
      Some("trace judge failed at completion (operator reported success)".to_string()),
    )
  };
  logger.write_completion_audit(session_id, outcome, detail)?;
  // `mark_complete`'s rollup refresh ran before this record existed; refresh
  // again or the board keeps reporting the unaudited completion.
  logger.refresh_status(session_id);
  Ok(())
}

#[cfg(test)]
mod navigation_abort_tests {
  use super::*;
  use serde_json::json;

  /// Build a client entry the same shape the trace writer emits.
  fn entry(ts: &str, name: &str, level: &str, attributes: serde_json::Value) -> LjsonEntry {
    serde_json::from_value(json!({
      "v": 1,
      "ts": ts,
      "sessionId": "3033fd1b-bd66-4373-a4a6-7364097b7d12",
      "origin": "client",
      "rootSpan": {
        "id": 1,
        "name": name,
        "level": level,
        "location": {},
        "attributes": attributes,
        "children": []
      }
    }))
    .unwrap()
  }

  /// An `api-call` error with `http.method`/`http.path` and no `http.status`.
  fn aborted_call(ts: &str, path: &str) -> LjsonEntry {
    entry(
      ts,
      "api-call",
      "error",
      json!({ "http.method": "get", "http.path": path }),
    )
  }

  /// The exact shape `.ux-tests/cow/cow-edit-keeps-focus` produces when the
  /// spec rotates identity: statusless error, pagehide flush +1ms, page-load
  /// +43ms. The report cites the page-load, the stronger evidence.
  #[test]
  fn statusless_api_call_followed_by_page_load_is_classified() {
    let entries = vec![
      aborted_call("2026-09-02T11:34:03.429Z", "/api/rows/{rowKey}/cells"),
      entry(
        "2026-09-02T11:34:03.430Z",
        "cell-persist/pagehide-flush",
        "info",
        json!({ "flushers": 1 }),
      ),
      entry(
        "2026-09-02T11:34:03.472Z",
        "page-load",
        "info",
        json!({ "url": "https://dev.lona.so:8443/sheet" }),
      ),
    ];
    let abort = navigation_aborted_call(&entries[0], &entries).expect("classified");
    assert_eq!(abort.path, "/api/rows/{rowKey}/cells");
    assert_eq!(abort.marker, "page-load");
    assert_eq!(abort.delta_ms, 43);
  }

  /// The pagehide flush alone still vouches — a document draining its writes
  /// is a document going away.
  #[test]
  fn pagehide_flush_alone_is_enough() {
    let entries = vec![
      aborted_call("2026-09-02T11:34:03.429Z", "/api/sync/warm"),
      entry(
        "2026-09-02T11:34:03.429Z",
        "cell-persist/pagehide-flush",
        "info",
        json!({ "flushers": 1 }),
      ),
    ];
    let abort = navigation_aborted_call(&entries[0], &entries).expect("classified");
    assert_eq!(abort.marker, "cell-persist/pagehide-flush");
    assert_eq!(abort.delta_ms, 0);
  }

  /// The load-bearing half: a server that answered sets `http.status`, so the
  /// corpus's 500s stay counted even with a page-load right behind them.
  #[test]
  fn a_call_with_http_status_is_never_classified() {
    let entries = vec![
      entry(
        "2026-09-02T11:34:03.429Z",
        "api-call",
        "error",
        json!({ "http.method": "post", "http.path": "/api/sheets", "http.status": 500 }),
      ),
      entry(
        "2026-09-02T11:34:03.472Z",
        "page-load",
        "info",
        json!({ "url": "https://dev.lona.so:8443/sheet" }),
      ),
    ];
    assert!(navigation_aborted_call(&entries[0], &entries).is_none());
  }

  /// The other load-bearing half: no unload, no excuse.
  #[test]
  fn a_statusless_call_with_no_unload_marker_is_not_classified() {
    let entries = vec![
      aborted_call("2026-09-02T11:34:03.429Z", "/api/rows/{rowKey}"),
      entry(
        "2026-09-02T11:34:03.472Z",
        "log/ui",
        "info",
        json!({ "message": "scroll/rebind" }),
      ),
    ];
    assert!(navigation_aborted_call(&entries[0], &entries).is_none());
  }

  /// Direction and window both bind: a page-load *before* the error, or one
  /// past the window, is not evidence for it.
  #[test]
  fn markers_before_the_error_or_past_the_window_do_not_count() {
    let earlier = vec![
      entry(
        "2026-09-02T11:34:03.400Z",
        "page-load",
        "info",
        json!({ "url": "https://dev.lona.so:8443/sheet" }),
      ),
      aborted_call("2026-09-02T11:34:03.429Z", "/_/auth/id"),
    ];
    assert!(navigation_aborted_call(&earlier[1], &earlier).is_none());

    let too_late = vec![
      aborted_call("2026-09-02T11:34:03.429Z", "/_/auth/id"),
      entry(
        "2026-09-02T11:34:03.930Z",
        "page-load",
        "info",
        json!({ "url": "https://dev.lona.so:8443/sheet" }),
      ),
    ];
    assert!(navigation_aborted_call(&too_late[0], &too_late).is_none());
  }

  /// Only `api-call` spans are eligible — an unrelated error next to a
  /// page-load stays an error.
  #[test]
  fn non_api_call_errors_are_never_classified() {
    let entries = vec![
      entry(
        "2026-09-02T11:34:03.429Z",
        "witness/watchdog",
        "error",
        json!({ "http.path": "/api/rows" }),
      ),
      entry(
        "2026-09-02T11:34:03.472Z",
        "page-load",
        "info",
        json!({ "url": "https://dev.lona.so:8443/sheet" }),
      ),
    ];
    assert!(navigation_aborted_call(&entries[0], &entries).is_none());
  }
}

#[cfg(test)]
mod after_scope_tests {
  use super::*;
  use serde_json::json;

  /// A root entry with optional `plan/covered` child, the shape
  /// `sheet-invalidation.ts` emits (candidate.8 invalidation-narrow-stays-narrow).
  fn line(ts: &str, name: &str, duration_ms: i64, covered_effect: Option<&str>) -> String {
    let children = match covered_effect {
      Some(effect) => json!([{
        "type": "span", "id": 2, "name": "plan/covered", "level": "info", "durationMs": 0,
        "location": {}, "attributes": { "owner": "cell-content-structure", "effect": effect },
        "children": []
      }]),
      None => json!([]),
    };
    json!({
      "v": 1, "ts": ts, "sessionId": "db95c62f-e600-48c3-abc3-4b6c2b9164a8", "origin": "client",
      "rootSpan": {
        "id": 1, "name": name, "level": "info", "durationMs": duration_ms,
        "location": {}, "attributes": {}, "children": children
      }
    })
    .to_string()
  }

  fn judge(tag: &str, lines: &[String], verification: serde_json::Value) -> bool {
    let path = std::env::temp_dir().join(format!(
      "tento-ux-test-after-scope-{}-{tag}.ljson",
      std::process::id()
    ));
    std::fs::write(&path, lines.join("\n")).unwrap();
    let verification: Verification = serde_json::from_value(verification).unwrap();
    let verdict = verify_trace_results(&path, &verification).unwrap();
    std::fs::remove_file(&path).unwrap();
    verdict
  }

  fn forbid_after(anchor: Option<&str>) -> serde_json::Value {
    let mut pattern = json!({ "pattern": "effect:cell-content-column", "source": "client" });
    if let Some(anchor) = anchor {
      pattern["after"] = json!(anchor);
    }
    json!({ "forbidden_logs": [pattern] })
  }

  /// candidate.8: the only cover was on the fixture's open frame, 29ms before
  /// the first write. Scoped to the writes, the forbid is quiet; unscoped it
  /// trips exactly as it did on rc.
  #[test]
  fn a_cover_before_the_anchor_is_out_of_scope() {
    let trace = [
      line("2026-09-24T07:25:41.980Z", "effect/cell-content-column", 0, Some("cell-content-column")),
      line("2026-09-24T07:25:42.009Z", "app-command/setEphemeralCells", 1, None),
      line("2026-09-24T07:25:42.040Z", "effect/cell-content-column", 0, None),
    ];
    assert!(judge("before", &trace, forbid_after(Some("app-command/setEphemeralCells"))));
    assert!(!judge("unscoped", &trace, forbid_after(None)));
  }

  #[test]
  fn a_cover_after_the_anchor_still_fails() {
    let trace = [
      line("2026-09-24T07:25:42.009Z", "app-command/setEphemeralCells", 1, None),
      line("2026-09-24T07:25:43.284Z", "app-command/setEphemeralCells", 3, None),
      line("2026-09-24T07:25:43.300Z", "effect/cell-content-column", 0, Some("cell-content-column")),
    ];
    assert!(!judge("after", &trace, forbid_after(Some("app-command/setEphemeralCells"))));
  }

  /// The scope opens when the anchor STARTED, so an entry that completed
  /// while the anchor span was still open is judged.
  #[test]
  fn the_scope_opens_at_the_anchors_start_not_its_completion() {
    let trace = [
      line("2026-09-24T07:25:42.006Z", "effect/cell-content-column", 0, Some("cell-content-column")),
      line("2026-09-24T07:25:42.009Z", "app-command/setEphemeralCells", 5, None),
    ];
    assert!(!judge("inside", &trace, forbid_after(Some("app-command/setEphemeralCells"))));
  }

  /// No anchor, no verdict: a forbid over a scope that never opened would
  /// pass without looking, so it fails; a scoped requirement fails too.
  #[test]
  fn a_missing_anchor_fails_the_pattern() {
    let trace = [line("2026-09-24T07:25:42.040Z", "effect/cell-content-column", 0, None)];
    assert!(!judge("noanchor-forbid", &trace, forbid_after(Some("app-command/setEphemeralCells"))));
    assert!(!judge(
      "noanchor-require",
      &trace,
      json!({ "required_logs": [{
        "pattern": "effect/cell-content-column",
        "after": "app-command/setEphemeralCells"
      }] })
    ));
    assert!(judge(
      "unscoped-require",
      &trace,
      json!({ "required_logs": [{ "pattern": "effect/cell-content-column" }] })
    ));
  }
}
