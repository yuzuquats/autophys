//! Agent-driven `--auto` runs: a spec with `manual: true` steps, handed to an
//! agent job on the host's durable queue instead of the headless runner.
//!
//! The headless runner stops at the first step a spec declares manual, because
//! no script can do it. An agent can — a Google account chooser, a consent
//! screen, a Stripe iframe — so when the host names an agent lane
//! ([`AGENT_LANE_ENV`]) `ux-test run --auto` enqueues ONE agent job through
//! `tento-agent-queue` (tsh runs it: one saved tsh session per attempt) and
//! waits for two things at once: the job to end, and the in-page harness to
//! complete the session. The verdict is still `verification.json`, judged by
//! the same finalize path an operator-driven run takes; the agent's own
//! `RESULT` line is recorded beside it in `agent.json`, never trusted as one.
//!
//! **This process owns the browser.** It launches it with the tester's
//! signed-in profile and a DevTools endpoint when the job starts running, and
//! closes it when the run ends — on success, failure, timeout, or an error in
//! between (the guard's `Drop`). The alternative, the agent launching its own
//! browser, puts a long-lived process in the hands of a session that may be
//! cancelled mid-turn, and the cleanup of a profile lock then depends on a
//! turn that never finishes. One process that starts the browser and the
//! only one that stops it is the whole lifecycle.
//!
//! Serialisation is the lane's: one signed-in profile means the host declares
//! the lane with `max-running 1`, and the browser is launched only once the
//! queue has dispatched this job — so two specs never share the profile. The
//! one exception is the sign-in pre-step below, which must finish before its
//! job is enqueued; the profile is then held by [`ProfileLock`] from the
//! pre-step until the agent's browser has closed.
//!
//! **Google sign-in pre-step** ([`GOOGLE_PASSWORD_FILE_ENV`]). A profile with no
//! live Google session makes Google ask for a password, which the agent must
//! never type. When the host names a password file, the profile is first used
//! for a deterministic sign-in: it is opened on a PRIVATE DevTools port (not
//! the one the prompt names), `google-signin.deno.ts` signs in with the
//! password on its stdin and an allowlisted environment, and that browser is
//! closed again before the agent's browser opens the same profile. The agent
//! never sees the password page, the password, or the port — and is not even
//! running yet: the pre-step finishes BEFORE the job is enqueued, because that
//! port is an unauthenticated loopback listener from which any local process
//! could read the password field. A sign-in that needs a human ends the run
//! before a job exists, `unfinished` with blocker `google-signin-<status>`.
//! Enqueueing afterwards means the lane cannot say the profile is free, so
//! [`ProfileLock`] does, from the pre-step until the agent's browser closes.
//!
//! **Microsoft sign-in pre-step** ([`MICROSOFT_PASSWORD_FILE_ENV`]). The same,
//! with `microsoft-signin.deno.ts`, after Google's when both are configured
//! ([`SigninSequence`]). It drives only the account, password, "stay signed
//! in" and consent screens; anything else Microsoft shows ends the run before a
//! job exists, `unfinished` with blocker [`MICROSOFT_CHALLENGE_BLOCKER`].
//!
//! **`fill_secret`** ([`crate::fill_secret`]). When the profile's Google
//! session does not cover the spec's account (a chooser row marked "Signed
//! out"), Google asks for that account's password mid-run, after the agent's
//! browser opened. The agent asks the harness by name through its workspace,
//! and the harness — never the agent — checks the name against the spec's
//! account, reads the file and types it into Google's password field.
//!
//! **Harness-post sink** ([`HarnessSinkStart`]). The in-page harness posts
//! `/_/ux-test/logs` and `/_/ux-test/complete` to the page origin. Under a
//! named profile that origin is a remote server whose store never heard of
//! this session, so the agent's completion was lost there and the run ended
//! `agent-no-completion` (c37, 2026-09-26). Under exactly the profiles the
//! headless runner sinks for ([`crate::headless::harness_sink_for`]), this
//! process opens the agent's browser on `about:blank`, starts
//! `harness-sink.deno.ts` on its DevTools port — which pauses only
//! `*/_/ux-test/*` requests browser-wide, answers this session's posts into
//! the run dir the completion poll reads, and then opens the launch URL — and
//! stops it after the browser closes. A sink that cannot start, or exits while
//! the agent drives, ends the run `unfinished` with blocker
//! `harness-sink-failed` / `harness-sink-exited`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use serde::Serialize;
use tento_agent_queue::{AgentQueue, AgentSpec, CancelReason, Job, JobPolicy, JobState, NewJob};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::{info, warn};

use crate::env_profile::{EnvProfile, Resolver};
use crate::orchestration::{HostPort, SessionCompletionResult, await_session_completion};
use crate::session::LLMLogger;
use crate::spec::TestSpec;

/// The agent lane this host's queue declares for UX runs. Set ⇒ an `--auto`
/// run of a spec with a `manual: true` step is driven by an agent job in this
/// lane. Unset or empty ⇒ today's headless behaviour, exactly.
pub const AGENT_LANE_ENV: &str = "UX_AGENT_LANE";
/// How long a job may wait in the queue before it starts, in seconds. Default:
/// the spec's own timeout. The lane runs one browser at a time, so a batch's
/// later specs legitimately queue behind the earlier ones.
pub const QUEUE_WAIT_ENV: &str = "UX_AGENT_QUEUE_WAIT_SECS";
/// The browser binary (the same variable the Deno runner reads). Required for
/// an agent-driven run.
pub const BROWSER_ENV: &str = "PUPPETEER_EXECUTABLE_PATH";
/// The persistent browser profile holding the tester's signed-in session (the
/// same variable the Deno runner reads). Unset ⇒ a fresh profile in the run's
/// work dir, which carries no sign-in. Required with
/// [`GOOGLE_PASSWORD_FILE_ENV`]: a signed-in profile never lives in the agent's
/// workspace.
pub const USER_DATA_DIR_ENV: &str = "UX_USER_DATA_DIR";
/// The address the browser resolves the app's hosts to (the same variable the
/// Deno runner reads). Set ⇒ the corpus manifest's resolve patterns and the
/// run's own host map to it under any profile, so a driver host whose own name
/// resolution points the app at the wrong machine still reaches the server
/// under test. Unset or empty ⇒ the profile alone decides, exactly as before.
pub const RESOLVE_IP_ENV: &str = "LONA_UX_RESOLVE_IP";
/// Who enqueues: the queue's dedupe identity is `(producer, session id)`.
pub const PRODUCER: &str = "tento-ux-test";
/// The lane `:env` key naming the ONE `deno.json` the agent may run scripts
/// under — tsh's `allow-workspace` permission rule allows `deno run --config`
/// of exactly this file. The rule is tsh's (see the README), not this crate's.
pub const DENO_CONFIG_ENV: &str = "TSH_WORKSPACE_DENO_CONFIG";
/// The file this module writes into the run dir.
pub const AGENT_RECORD: &str = "agent.json";
/// The prompt template. Checked in, so what the agent is told is reviewed with
/// the code that tells it.
pub const PROMPT_TEMPLATE: &str = include_str!("agent_prompt.md");
/// A file holding the Google password of [`GOOGLE_ACCOUNT_ENV`] (mode 0600,
/// outside every repo; only its PATH is ever in the environment). Set ⇒ the
/// sign-in pre-step runs before the agent's browser starts. Unset or empty ⇒
/// no pre-step, exactly as before.
pub const GOOGLE_PASSWORD_FILE_ENV: &str = "UX_GOOGLE_PASSWORD_FILE";
/// The Google account the password file belongs to. Required with
/// [`GOOGLE_PASSWORD_FILE_ENV`]: a password is never guessed onto an account.
pub const GOOGLE_ACCOUNT_ENV: &str = "UX_GOOGLE_ACCOUNT";
/// The sign-in script's file name, written beside the run from
/// [`GOOGLE_SIGNIN_SOURCE`].
pub const GOOGLE_SIGNIN_SCRIPT: &str = "google-signin.deno.ts";
/// The script itself, embedded so the one that runs is the one this binary was
/// reviewed with — the runner directory a candidate ships is another tree.
pub const GOOGLE_SIGNIN_SOURCE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../tento-ux-runner/google-signin.deno.ts"
));
/// The prefix of the script's one stdout status line.
pub const GOOGLE_SIGNIN_STATUS: &str = "google-signin:";
/// A file holding the Microsoft password of [`MICROSOFT_ACCOUNT_ENV`] (mode
/// 0600, outside every repo; only its PATH is ever in the environment). Set ⇒
/// the Microsoft sign-in pre-step runs before the agent's browser starts (after
/// Google's, when both are set). Unset or empty ⇒ no pre-step, exactly as
/// before.
pub const MICROSOFT_PASSWORD_FILE_ENV: &str = "UX_MICROSOFT_PASSWORD_FILE";
/// The Microsoft account the password file belongs to. Required with
/// [`MICROSOFT_PASSWORD_FILE_ENV`].
pub const MICROSOFT_ACCOUNT_ENV: &str = "UX_MICROSOFT_ACCOUNT";
/// The Microsoft sign-in script's file name, written beside the run from
/// [`MICROSOFT_SIGNIN_SOURCE`].
pub const MICROSOFT_SIGNIN_SCRIPT: &str = "microsoft-signin.deno.ts";
/// The Microsoft script, embedded for the Google script's reason.
pub const MICROSOFT_SIGNIN_SOURCE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../tento-ux-runner/microsoft-signin.deno.ts"
));
const MICROSOFT_OAUTH_START_SCRIPT: &str = "microsoft-oauth-start.ts";
const MICROSOFT_OAUTH_START_SOURCE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../tento-ux-runner/microsoft-oauth-start.ts"
));
/// The prefix of the Microsoft script's one stdout status line.
pub const MICROSOFT_SIGNIN_STATUS: &str = "microsoft-signin:";
/// The blocker of a Microsoft pre-step that met anything but the account,
/// password, "stay signed in" and consent screens: an operator step.
pub const MICROSOFT_CHALLENGE_BLOCKER: &str = "microsoft-challenge";

/// Which identity provider a sign-in pre-step signs the profile into. Both
/// run the same way: a password file named by the host, a script embedded in
/// this binary, one status line.
///
/// A spec names them in `signin_providers:` as `google` / `microsoft`.
#[derive(
  Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, tento_openapi::ToSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum SigninProvider {
  Google,
  Microsoft,
}

impl SigninProvider {
  /// Whether `spec` needs this provider's pre-step. A spec that declares
  /// `signin_providers:` gets exactly the pre-steps it lists, whatever its
  /// steps say (review K-8: the text match below misses "Hotmail", "Office
  /// 365" or "Entra"). Without the field, the old rule: Google's runs for
  /// every agent-driven spec, as it always has, and Microsoft's only when a
  /// step the agent drives (one with no actions) names Microsoft or Outlook in
  /// its id, instruction or reason: its timeout used to cancel Google-only
  /// specs before the agent started (returning-active-user c61084, 2026-10-09).
  pub fn needed_by(self, spec: &TestSpec) -> bool {
    if let Some(declared) = &spec.signin_providers {
      return declared.contains(&self);
    }
    match self {
      Self::Google => true,
      Self::Microsoft => spec
        .steps
        .iter()
        .filter(|step| !step.is_automatable())
        .any(|step| {
          [
            Some(step.id.as_str()),
            Some(step.instruction.as_str()),
            step.manual_reason.as_deref(),
          ]
          .into_iter()
          .flatten()
          .any(|text| {
            let text = text.to_lowercase();
            text.contains("microsoft") || text.contains("outlook")
          })
        }),
    }
  }

  pub fn password_file_env(self) -> &'static str {
    match self {
      Self::Google => GOOGLE_PASSWORD_FILE_ENV,
      Self::Microsoft => MICROSOFT_PASSWORD_FILE_ENV,
    }
  }

  pub fn account_env(self) -> &'static str {
    match self {
      Self::Google => GOOGLE_ACCOUNT_ENV,
      Self::Microsoft => MICROSOFT_ACCOUNT_ENV,
    }
  }

  pub fn script(self) -> &'static str {
    match self {
      Self::Google => GOOGLE_SIGNIN_SCRIPT,
      Self::Microsoft => MICROSOFT_SIGNIN_SCRIPT,
    }
  }

  pub fn source(self) -> &'static str {
    match self {
      Self::Google => GOOGLE_SIGNIN_SOURCE,
      Self::Microsoft => MICROSOFT_SIGNIN_SOURCE,
    }
  }

  /// The status-line prefix, `google-signin:` / `microsoft-signin:`.
  pub fn status(self) -> &'static str {
    match self {
      Self::Google => GOOGLE_SIGNIN_STATUS,
      Self::Microsoft => MICROSOFT_SIGNIN_STATUS,
    }
  }

  /// `google-signin` / `microsoft-signin`: the pre-step's directory beside the
  /// run, and what a run it ended records as its `end` and `canceled`.
  pub fn label(self) -> &'static str {
    match self {
      Self::Google => "google-signin",
      Self::Microsoft => "microsoft-signin",
    }
  }

  pub fn display_name(self) -> &'static str {
    match self {
      Self::Google => "Google",
      Self::Microsoft => "Microsoft",
    }
  }

  /// The provider a blocker belongs to.
  pub fn of_blocker(blocker: &str) -> Self {
    if blocker.starts_with("microsoft") {
      Self::Microsoft
    } else {
      Self::Google
    }
  }

  /// The run's blocker for a status `kind`. A Microsoft `challenge` is
  /// [`MICROSOFT_CHALLENGE_BLOCKER`]; everything else is `<label>-<kind>`.
  fn blocker(self, kind: &str) -> String {
    match (self, kind) {
      (Self::Microsoft, "challenge") => MICROSOFT_CHALLENGE_BLOCKER.to_string(),
      _ => format!("{}-{kind}", self.label()),
    }
  }
}

/// The lane from the environment's raw value: trimmed, empty ⇒ none.
pub fn lane_from(raw: Option<String>) -> Option<String> {
  raw
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

/// [`AGENT_LANE_ENV`], read once per run.
pub fn lane_from_env() -> Option<String> {
  lane_from(std::env::var(AGENT_LANE_ENV).ok())
}

/// Whether an `--auto` run of `spec` is agent-driven: only when a lane is
/// configured AND the spec has a step a machine cannot do. A fully automatable
/// spec keeps the headless runner, which is faster and needs no agent.
pub fn drives(auto: bool, spec: &TestSpec, lane: Option<&str>) -> bool {
  auto && lane.is_some() && spec.first_manual_step().is_some()
}

// ===========================================================================
// Configuration
// ===========================================================================

/// Everything an agent-driven run needs from the host, resolved BEFORE the
/// spec's setup runs — a host that cannot drive agents must fail without
/// creating a user it will then not tear down.
#[derive(Clone, Debug)]
pub struct AgentConfig {
  pub lane: String,
  pub browser: PathBuf,
  pub user_data_dir: Option<PathBuf>,
  pub queue_wait: Option<Duration>,
  /// The Google sign-in pre-step, when the host configures one.
  pub google_signin: Option<SigninConfig>,
  /// The Microsoft sign-in pre-step, when the host configures one.
  pub microsoft_signin: Option<SigninConfig>,
}

impl AgentConfig {
  pub fn from_env(lane: String) -> Result<Self> {
    let mut config = Self::resolve(
      lane,
      std::env::var(BROWSER_ENV).ok(),
      std::env::var(USER_DATA_DIR_ENV).ok(),
      std::env::var(QUEUE_WAIT_ENV).ok(),
    )?;
    config.google_signin = SigninConfig::from_env(SigninProvider::Google)?;
    config.microsoft_signin = SigninConfig::from_env(SigninProvider::Microsoft)?;
    config.require_profile_for_signin()?;
    Ok(config)
  }

  /// The configured pre-steps, in the order they run: Google, then Microsoft.
  pub fn signins(&self) -> impl Iterator<Item = &SigninConfig> {
    self
      .google_signin
      .iter()
      .chain(self.microsoft_signin.iter())
  }

  /// The configured pre-steps `spec` needs ([`SigninProvider::needed_by`]),
  /// in the order they run.
  pub fn signins_for<'a>(&'a self, spec: &'a TestSpec) -> impl Iterator<Item = &'a SigninConfig> {
    self
      .signins()
      .filter(move |signin| signin.provider.needed_by(spec))
  }

  /// A sign-in pre-step writes a live session into the profile. Without
  /// [`USER_DATA_DIR_ENV`] that profile is the run's `chrome-profile` inside
  /// the agent's own workspace — cookies the agent could read, copy or replay
  /// — so a host that names a password file must name a profile too.
  fn require_profile_for_signin(&self) -> Result<()> {
    if let Some(signin) = self.signins().next() {
      anyhow::ensure!(
        self.user_data_dir.is_some(),
        "{} is set, which needs {USER_DATA_DIR_ENV}: the signed-in profile must live outside \
         the agent's workspace",
        signin.provider.password_file_env()
      );
    }
    Ok(())
  }

  fn resolve(
    lane: String,
    browser: Option<String>,
    user_data_dir: Option<String>,
    queue_wait: Option<String>,
  ) -> Result<Self> {
    let browser = browser
      .filter(|raw| !raw.trim().is_empty())
      .map(PathBuf::from)
      .with_context(|| {
        format!("{AGENT_LANE_ENV}={lane} drives this spec with an agent, which needs {BROWSER_ENV}")
      })?;
    anyhow::ensure!(
      browser.is_file(),
      "{BROWSER_ENV} does not name a file: {}",
      browser.display()
    );
    let user_data_dir = user_data_dir
      .filter(|raw| !raw.trim().is_empty())
      .map(PathBuf::from);
    let queue_wait = queue_wait
      .filter(|raw| !raw.trim().is_empty())
      .map(|raw| {
        raw
          .trim()
          .parse::<u64>()
          .map(Duration::from_secs)
          .with_context(|| format!("{QUEUE_WAIT_ENV} must be whole seconds, got {raw:?}"))
      })
      .transpose()?;
    Ok(Self {
      lane,
      browser,
      user_data_dir,
      queue_wait,
      google_signin: None,
      microsoft_signin: None,
    })
  }
}

/// Where a sign-in pre-step's password lives, whose it is, and which provider
/// it signs into. Holds the file's PATH, never its contents: the bytes are read
/// only to be written to the script's stdin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SigninConfig {
  pub provider: SigninProvider,
  pub account: String,
  pub password_file: PathBuf,
}

/// The Google pre-step's configuration (the name it had before Microsoft's).
pub type GoogleSigninConfig = SigninConfig;

impl SigninConfig {
  pub fn from_env(provider: SigninProvider) -> Result<Option<Self>> {
    Self::resolve(
      provider,
      std::env::var(provider.password_file_env()).ok(),
      std::env::var(provider.account_env()).ok(),
    )
  }

  fn resolve(
    provider: SigninProvider,
    password_file: Option<String>,
    account: Option<String>,
  ) -> Result<Option<Self>> {
    let file_env = provider.password_file_env();
    let account_env = provider.account_env();
    let Some(password_file) = password_file
      .map(|raw| raw.trim().to_string())
      .filter(|raw| !raw.is_empty())
      .map(PathBuf::from)
    else {
      return Ok(None);
    };
    let account = account
      .map(|raw| raw.trim().to_string())
      .filter(|raw| !raw.is_empty())
      .with_context(|| {
        format!("{file_env} is set, which needs {account_env}: the account it belongs to")
      })?;
    let meta = std::fs::metadata(&password_file)
      .with_context(|| format!("{file_env}: {}", password_file.display()))?;
    anyhow::ensure!(
      meta.is_file(),
      "{file_env} does not name a file: {}",
      password_file.display()
    );
    {
      use std::os::unix::fs::PermissionsExt;
      let mode = meta.permissions().mode() & 0o777;
      anyhow::ensure!(
        mode & 0o077 == 0,
        "{file_env} {} is mode {mode:o}; a password file must be 0600",
        password_file.display()
      );
    }
    Ok(Some(Self {
      provider,
      account,
      password_file,
    }))
  }
}

// ===========================================================================
// Prompt
// ===========================================================================

/// What the prompt names. Every field is a fact the agent cannot derive.
#[derive(Clone, Debug)]
pub struct PromptInputs {
  pub spec_id: String,
  pub spec_path: PathBuf,
  pub session_id: String,
  pub env: String,
  pub target_origin: String,
  pub launch_url: String,
  pub devtools_url: String,
  pub account: Option<String>,
  pub run_dir: PathBuf,
  pub work_dir: PathBuf,
  /// The headless runner's Deno project, whose cached puppeteer the agent
  /// imports without fetching. `None` when this host has none.
  pub runner_dir: Option<PathBuf>,
  pub timeout_secs: u64,
  /// The secret the harness fills for ACCOUNT on Google's password page
  /// ([`crate::fill_secret::secret_for_account`]), when there is one.
  pub fill_secret: Option<String>,
}

/// Fill [`PROMPT_TEMPLATE`]. Plain `{{KEY}}` substitution: the template is
/// prose, and a template engine would be one more thing to review.
pub fn render_prompt(inputs: &PromptInputs) -> String {
  let account = inputs
    .account
    .clone()
    .unwrap_or_else(|| "the account the browser profile is signed in as".to_string());
  [
    ("SPEC_ID", inputs.spec_id.clone()),
    ("SPEC_PATH", inputs.spec_path.display().to_string()),
    ("SESSION_ID", inputs.session_id.clone()),
    ("ENV", inputs.env.clone()),
    ("TARGET_ORIGIN", inputs.target_origin.clone()),
    ("LAUNCH_URL", inputs.launch_url.clone()),
    ("DEVTOOLS_URL", inputs.devtools_url.clone()),
    ("ACCOUNT", account),
    ("RUN_DIR", inputs.run_dir.display().to_string()),
    ("WORK_DIR", inputs.work_dir.display().to_string()),
    ("TIMEOUT_SECS", inputs.timeout_secs.to_string()),
    (
      "FILL_SECRET",
      inputs
        .fill_secret
        .clone()
        .unwrap_or_else(|| "none for this account".to_string()),
    ),
    (
      "RUNNER_DIR",
      inputs
        .runner_dir
        .as_ref()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|| "none on this host".to_string()),
    ),
  ]
  .into_iter()
  .fold(PROMPT_TEMPLATE.to_string(), |text, (key, value)| {
    text.replace(&format!("{{{{{key}}}}}"), &value)
  })
}

/// The one job this run enqueues: kind agent, the configured lane, one
/// attempt, the spec's own timeout. The session id is the request id, so a
/// retried `run` that reuses a session cannot enqueue a second driver for it.
///
/// The job names ONLY its workspace (`work_dir`, absolute) and the one deno
/// config its scripts may use (the headless runner's, when this host has
/// one): the harness and its permissions stay the host's queue declaration.
/// The workspace is the lane's working directory, so everything the agent
/// writes and runs is inside it.
pub fn new_job(
  lane: &str,
  prompt: String,
  spec: &TestSpec,
  session_id: &str,
  work_dir: &Path,
  deno_config: Option<&Path>,
) -> NewJob {
  let mut agent = AgentSpec::new().cwd(work_dir.display().to_string());
  if let Some(config) = deno_config {
    agent = agent.env(DENO_CONFIG_ENV, config.display().to_string());
  }
  NewJob::agent(lane, prompt)
    .title(format!("ux-test {} ({session_id})", spec.id))
    .policy(JobPolicy {
      max_attempts: 1,
      timeout_ms: Some(spec.timeout.saturating_mul(1000)),
      retryable_classes: Vec::new(),
    })
    .agent_spec(agent)
    .producer(PRODUCER)
    .request(session_id.to_string())
    .with_payload("uxSession", session_id.to_string())
    .with_payload("uxSpec", spec.id.clone())
}

// ===========================================================================
// Browser
// ===========================================================================

/// How to start the run's browser.
#[derive(Clone, Debug)]
pub struct BrowserLaunch {
  pub executable: PathBuf,
  pub user_data_dir: PathBuf,
  pub url: String,
  pub devtools_port: u16,
  pub args: Vec<String>,
  /// Where the browser's stdout/stderr go (the work dir), so a crash can be
  /// quoted afterwards.
  pub log_path: PathBuf,
  /// How long the DevTools endpoint may take to answer. Generous: a macOS host
  /// scans a never-seen executable on its first exec for 30–46 s.
  pub ready_within: Duration,
}

impl BrowserLaunch {
  /// The launch for one run. `resolve_domains` are the corpus manifest's
  /// loopback patterns; they matter only under a loopback profile.
  pub fn for_run(
    config: &AgentConfig,
    profile: &EnvProfile,
    host_only: &str,
    resolve_domains: &[String],
    url: String,
    work_dir: &Path,
    devtools_port: u16,
  ) -> Self {
    let user_data_dir = config
      .user_data_dir
      .clone()
      .unwrap_or_else(|| work_dir.join("chrome-profile"));
    Self {
      executable: config.browser.clone(),
      user_data_dir,
      args: browser_args(
        &config.browser,
        profile.resolver,
        profile.ignore_https_errors(),
        host_only,
        resolve_domains,
      ),
      url,
      devtools_port,
      log_path: work_dir.join("browser.log"),
      ready_within: Duration::from_secs(120),
    }
  }

  /// `browserURL` for `puppeteer.connect`.
  pub fn devtools_url(&self) -> String {
    format!("http://127.0.0.1:{}", self.devtools_port)
  }
}

/// The browser's flags, apart from the profile, the port and the URL.
///
/// No user agent, no stealth, no automation switches beyond DevTools itself:
/// a provider that refuses this browser is a result, not a thing to evade.
///
/// [`RESOLVE_IP_ENV`] is read here, as the headless runner reads it.
pub fn browser_args(
  executable: &Path,
  resolver: Resolver,
  ignore_https_errors: bool,
  host_only: &str,
  resolve_domains: &[String],
) -> Vec<String> {
  let resolve_ip = resolve_ip_from(std::env::var(RESOLVE_IP_ENV).ok());
  browser_args_resolving(
    executable,
    resolver,
    ignore_https_errors,
    host_only,
    resolve_domains,
    resolve_ip.as_deref(),
  )
}

/// [`RESOLVE_IP_ENV`]'s value, when it names an address. Empty counts as unset.
pub fn resolve_ip_from(value: Option<String>) -> Option<String> {
  value
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

/// [`browser_args`] with the resolve address given rather than read.
///
/// The host-resolver rule matches the headless runner's: a loopback profile
/// maps the patterns to `resolve_ip`, or to 127.0.0.1 without one; a public
/// profile maps nothing unless `resolve_ip` is given, and then maps the same
/// patterns to it. The patterns are the manifest's resolve patterns followed
/// by the run's host; nothing else (the bare apex included) is mapped.
pub fn browser_args_resolving(
  executable: &Path,
  resolver: Resolver,
  ignore_https_errors: bool,
  host_only: &str,
  resolve_domains: &[String],
  resolve_ip: Option<&str>,
) -> Vec<String> {
  let mut args = vec![
    "--no-first-run".to_string(),
    "--no-default-browser-check".to_string(),
    "--window-size=1280,900".to_string(),
    // Deterministic name resolution, as the headless runner does. And no
    // back/forward cache: the agent connects a fresh puppeteer client per
    // script, and a bfcached document's cross-origin iframe (the Stripe
    // checkout after its return redirect) stays a discoverable target that
    // nothing auto-attaches, so puppeteer 22.7.1's connect() waits on it
    // forever. One flag string: Chrome honours only the last
    // --disable-features, so a second one would drop the DNS features.
    "--disable-features=DnsOverHttps,DnsHttpsSvcb,EncryptedClientHello,BackForwardCache"
      .to_string(),
    // The signed-in profiles on the ux hosts (UX_USER_DATA_DIR) were made by
    // a Chrome launched with the mock keychain, so their cookies are sealed
    // with its fixed key. Without it Chrome asks the macOS keychain for a
    // different key, cannot read the Google session, and Google asks for an
    // email as if nobody were signed in. It says where the profile's key
    // lives; it changes nothing a site can see.
    "--use-mock-keychain".to_string(),
    // An earlier run's browser was killed, so the profile reads as crashed;
    // no "Restore pages?" prompt over the page the agent drives.
    "--hide-crash-restore-bubble".to_string(),
  ];
  // chrome-headless-shell has no windowed mode to leave; a full Chrome needs
  // to be told, or it opens a window on the host's desktop.
  let is_headless_shell = executable
    .file_name()
    .and_then(|name| name.to_str())
    .is_some_and(|name| name.contains("headless-shell"));
  if !is_headless_shell {
    args.push("--headless=new".to_string());
  }
  let mut ignore_certs = ignore_https_errors;
  let loopback = resolver == Resolver::Loopback;
  if loopback || resolve_ip.is_some() {
    let ip = resolve_ip.unwrap_or("127.0.0.1");
    let rules = resolve_domains
      .iter()
      .map(String::as_str)
      .chain(std::iter::once(host_only))
      .map(|pattern| format!("MAP {pattern} {ip}"))
      .collect::<Vec<_>>()
      .join(", ");
    args.push(format!("--host-resolver-rules={rules}"));
  }
  if loopback {
    // A loopback target is a dev server behind a self-signed certificate. A
    // public one pinned to an address keeps its own certificate checks.
    ignore_certs = true;
  }
  if ignore_certs {
    args.push("--ignore-certificate-errors".to_string());
    args.push("--allow-insecure-localhost".to_string());
  }
  args
}

/// Put `:port` on the URL's host, unless it already names one. The headless
/// plan does the same for its boot URL; a loopback profile's dev server
/// listens on the port, and the browser's first navigation must carry it.
pub fn with_port(url: &str, port: Option<&str>) -> String {
  let Some(port) = port.filter(|port| !port.is_empty()) else {
    return url.to_string();
  };
  let Some((scheme, rest)) = url.split_once("://") else {
    return url.to_string();
  };
  let (host, tail) = match rest.find(['/', '?']) {
    Some(i) => (&rest[..i], &rest[i..]),
    None => (rest, ""),
  };
  if host.contains(':') {
    url.to_string()
  } else {
    format!("{scheme}://{host}:{port}{tail}")
  }
}

/// A free loopback port for DevTools. Picked here rather than by the browser
/// (`--remote-debugging-port=0`) because the prompt names it before the
/// browser exists: the browser starts only once the queue dispatches the job.
pub fn free_loopback_port() -> Result<u16> {
  let listener =
    std::net::TcpListener::bind("127.0.0.1:0").context("reserve a loopback port for DevTools")?;
  Ok(
    listener
      .local_addr()
      .context("read the reserved port")?
      .port(),
  )
}

/// Starts the run's browser. A seam so the queue logic is testable without one.
#[async_trait]
pub trait LaunchBrowser: Send + Sync {
  async fn launch(&self, launch: &BrowserLaunch) -> Result<BrowserGuard>;
}

/// The running browser. Dropping it kills the browser; [`Self::shutdown`]
/// asks it to exit first, so the profile's session is written back.
pub struct BrowserGuard {
  child: Option<tokio::process::Child>,
  /// The DevTools port, for tab housekeeping. `None` for a detached guard.
  devtools_port: Option<u16>,
}

impl BrowserGuard {
  /// A guard with no process behind it — what a test's launcher returns. Its
  /// tab housekeeping does nothing.
  pub fn detached() -> Self {
    Self {
      child: None,
      devtools_port: None,
    }
  }

  /// Open `url` in a fresh tab and close every other page, so the agent finds
  /// exactly one tab and it is this run's. Returns how many pages it closed.
  pub async fn open_alone(&self, url: &str) -> Result<usize> {
    match self.devtools_port {
      Some(port) => open_alone(port, url).await,
      None => Ok(0),
    }
  }

  /// Close every page that is not blank — what a browser that has not opened
  /// anything yet should have. Returns how many pages it closed.
  pub async fn close_stray_pages(&self) -> Result<usize> {
    match self.devtools_port {
      Some(port) => close_pages(port, |target| target.url == "about:blank").await,
      None => Ok(0),
    }
  }

  /// SIGTERM, a grace period, then SIGKILL.
  pub async fn shutdown(mut self) {
    let Some(child) = self.child.take() else {
      return;
    };
    if terminate(child, Duration::from_secs(10)).await {
      info!("  Browser closed");
    } else {
      warn!("browser did not exit within 10s of SIGTERM; killed it");
    }
  }
}

/// SIGTERM, up to `grace` for the child to exit, then SIGKILL. `true` when it
/// exited on the SIGTERM.
async fn terminate(mut child: tokio::process::Child, grace: Duration) -> bool {
  if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
    // SAFETY: plain kill(2) on a pid this process spawned and still holds
    // (the `Child` has not been reaped, so the pid cannot have been reused).
    unsafe {
      libc::kill(pid, libc::SIGTERM);
    }
  }
  match tokio::time::timeout(grace, child.wait()).await {
    Ok(_) => true,
    Err(_) => {
      let _ = child.kill().await;
      false
    }
  }
}

impl Drop for BrowserGuard {
  fn drop(&mut self) {
    if let Some(child) = self.child.as_mut() {
      // An error path that never reached `shutdown`: the browser must not
      // outlive the run and hold the profile's lock.
      let _ = child.start_kill();
    }
  }
}

/// The real launcher: spawn the browser, wait for DevTools to answer.
pub struct ChromeLauncher;

#[async_trait]
impl LaunchBrowser for ChromeLauncher {
  async fn launch(&self, launch: &BrowserLaunch) -> Result<BrowserGuard> {
    std::fs::create_dir_all(&launch.user_data_dir)
      .with_context(|| format!("create {}", launch.user_data_dir.display()))?;
    let cleared = clear_session_restore(&launch.user_data_dir)?;
    if !cleared.is_empty() {
      info!(
        "  Cleared {} session-restore file(s) from {}",
        cleared.len(),
        launch.user_data_dir.display()
      );
    }
    let log = std::fs::File::create(&launch.log_path)
      .with_context(|| format!("create {}", launch.log_path.display()))?;
    let log_err = log.try_clone().context("clone the browser log handle")?;
    info!(
      "  Launching browser {} (DevTools 127.0.0.1:{}, profile {})",
      launch.executable.display(),
      launch.devtools_port,
      launch.user_data_dir.display()
    );
    let child = tokio::process::Command::new(&launch.executable)
      .arg(format!("--remote-debugging-port={}", launch.devtools_port))
      .arg("--remote-debugging-address=127.0.0.1")
      .arg(format!(
        "--user-data-dir={}",
        launch.user_data_dir.display()
      ))
      .args(&launch.args)
      .arg(&launch.url)
      .stdin(Stdio::null())
      .stdout(Stdio::from(log))
      .stderr(Stdio::from(log_err))
      .kill_on_drop(true)
      .spawn()
      .with_context(|| format!("spawn {}", launch.executable.display()))?;
    let mut guard = BrowserGuard {
      child: Some(child),
      devtools_port: Some(launch.devtools_port),
    };

    let deadline = Instant::now() + launch.ready_within;
    loop {
      if devtools_answers(launch.devtools_port).await {
        info!("  DevTools answering at {}", launch.devtools_url());
        return Ok(guard);
      }
      if let Some(child) = guard.child.as_mut()
        && let Ok(Some(status)) = child.try_wait()
      {
        guard.child = None;
        return Err(anyhow!(
          "the browser exited ({status}) before DevTools answered — is the profile {} in use? \
           see {}",
          launch.user_data_dir.display(),
          launch.log_path.display()
        ));
      }
      if Instant::now() >= deadline {
        guard.shutdown().await;
        return Err(anyhow!(
          "DevTools did not answer on 127.0.0.1:{} within {}s; see {}",
          launch.devtools_port,
          launch.ready_within.as_secs(),
          launch.log_path.display()
        ));
      }
      tokio::time::sleep(Duration::from_millis(500)).await;
    }
  }
}

/// Whether `GET /json/version` answers 200 on the DevTools port.
async fn devtools_answers(port: u16) -> bool {
  let probe = async {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
    stream
      // HTTP/1.1: Chrome's DevTools server refuses 1.0 outright.
      .write_all(b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
      .await
      .ok()?;
    let mut head = [0u8; 16];
    let read = stream.read(&mut head).await.ok()?;
    Some(head[..read].starts_with(b"HTTP/1.1 200"))
  };
  matches!(
    tokio::time::timeout(Duration::from_secs(2), probe).await,
    Ok(Some(true))
  )
}

/// The tab state Chrome restores on startup, relative to the profile's
/// `Default` directory. Everything else in the profile — `Cookies` (the Google
/// session), `Login Data`, `Preferences`, `Local State` — is left alone.
const SESSION_RESTORE_FILES: &[&str] = &[
  "Current Session",
  "Current Tabs",
  "Last Session",
  "Last Tabs",
];

/// Remove the profile's session-restore state (`Default/Sessions/*` and the
/// legacy `Default/{Current,Last} {Session,Tabs}` files) so the browser starts
/// with no tab from an earlier run. A leftover tab is not inert: an old
/// `rc--calendar` tab reloading `promo-status` consumes the single-use promo
/// cookie the spec depends on, and an agent that picks the first matching tab
/// may drive a stale one (c37, onboarding/promo-cookie-api). Returns what it
/// removed.
pub fn clear_session_restore(user_data_dir: &Path) -> Result<Vec<PathBuf>> {
  let default = user_data_dir.join("Default");
  let mut removed = Vec::new();
  let sessions = default.join("Sessions");
  if sessions.is_dir() {
    for entry in
      std::fs::read_dir(&sessions).with_context(|| format!("read {}", sessions.display()))?
    {
      let path = entry
        .with_context(|| format!("read {}", sessions.display()))?
        .path();
      if path.is_dir() {
        std::fs::remove_dir_all(&path)
      } else {
        std::fs::remove_file(&path)
      }
      .with_context(|| format!("remove {}", path.display()))?;
      removed.push(path);
    }
  }
  for name in SESSION_RESTORE_FILES {
    let path = default.join(name);
    if std::fs::symlink_metadata(&path).is_ok() {
      std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
      removed.push(path);
    }
  }
  Ok(removed)
}

/// One DevTools target, as `/json/list` and `/json/new` describe it.
#[derive(Clone, Debug, serde::Deserialize)]
struct DevtoolsTarget {
  id: String,
  #[serde(rename = "type")]
  kind: String,
  #[serde(default)]
  url: String,
}

/// One request to the DevTools HTTP endpoint; the response body. Reads to
/// the response's `Content-Length` rather than to EOF: Chrome may keep the
/// connection open after answering.
async fn devtools_http(port: u16, method: &str, path: &str) -> Result<String> {
  let exchange = async {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    stream
      .write_all(
        format!(
          "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\
           Connection: close\r\n\r\n"
        )
        .as_bytes(),
      )
      .await?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
      let read = stream.read(&mut chunk).await?;
      raw.extend_from_slice(&chunk[..read]);
      if read == 0 || http_response_complete(&raw) {
        break;
      }
    }
    anyhow::Ok(raw)
  };
  let raw = tokio::time::timeout(Duration::from_secs(10), exchange)
    .await
    .map_err(|_| anyhow!("DevTools {method} {path} timed out"))??;
  let text = String::from_utf8_lossy(&raw);
  let (head, body) = text
    .split_once("\r\n\r\n")
    .with_context(|| format!("DevTools {method} {path}: no HTTP response"))?;
  anyhow::ensure!(
    head.starts_with("HTTP/1.1 200"),
    "DevTools {method} {path}: {}",
    head.lines().next().unwrap_or_default()
  );
  Ok(body.to_string())
}

/// Whether `raw` holds a whole response: its head, and as many body bytes as
/// its `Content-Length` says (none said ⇒ read to EOF).
fn http_response_complete(raw: &[u8]) -> bool {
  let Some(end) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
    return false;
  };
  let head = String::from_utf8_lossy(&raw[..end]);
  head
    .lines()
    .find_map(|line| {
      let (name, value) = line.split_once(':')?;
      name
        .trim()
        .eq_ignore_ascii_case("content-length")
        .then(|| value.trim().parse::<usize>().ok())
        .flatten()
    })
    .is_some_and(|length| raw.len() >= end + 4 + length)
}

/// Percent-encode everything but RFC 3986 unreserved characters. Chrome
/// unescapes `/json/new`'s query once, so this hands it the URL byte for byte.
fn encode_query(url: &str) -> String {
  url
    .bytes()
    .map(|byte| match byte {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
        (byte as char).to_string()
      }
      _ => format!("%{byte:02X}"),
    })
    .collect()
}

/// Close every page target `keep` rejects. A target that is already gone is
/// not an error. Returns how many it closed.
async fn close_pages(port: u16, keep: impl Fn(&DevtoolsTarget) -> bool) -> Result<usize> {
  let targets: Vec<DevtoolsTarget> =
    serde_json::from_str(&devtools_http(port, "GET", "/json/list").await?)
      .context("parse DevTools /json/list")?;
  let mut closed = 0;
  for target in targets
    .iter()
    .filter(|target| target.kind == "page" && !keep(target))
  {
    match devtools_http(port, "GET", &format!("/json/close/{}", target.id)).await {
      Ok(_) => {
        info!("  Closed a leftover tab ({})", target.url);
        closed += 1;
      }
      Err(error) => warn!("closing tab {}: {error:#}", target.id),
    }
  }
  Ok(closed)
}

/// Open `url` in a new tab, then close every other page.
async fn open_alone(port: u16, url: &str) -> Result<usize> {
  let opened: DevtoolsTarget = serde_json::from_str(
    &devtools_http(port, "PUT", &format!("/json/new?{}", encode_query(url))).await?,
  )
  .context("parse DevTools /json/new")?;
  close_pages(port, |target| target.id == opened.id).await
}

// ===========================================================================
// Google sign-in pre-step
// ===========================================================================

/// What the pre-step decided, from the script's status line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SigninOutcome {
  /// `already-signed-in` or `signed-in`, exit 0: start the agent's browser.
  Proceed { line: String },
  /// Anything else: the run ends `unfinished` with `blocker`.
  Blocked { blocker: String, line: String },
}

impl SigninOutcome {
  fn blocked_for(provider: SigninProvider, kind: &str, line: String) -> Self {
    Self::Blocked {
      blocker: provider.blocker(kind),
      line,
    }
  }

  /// The status line, for `agent.json` and the run's reason.
  pub fn line(&self) -> &str {
    match self {
      Self::Proceed { line } | Self::Blocked { line, .. } => line,
    }
  }

  /// Belt and braces: the script never prints the password, and if it ever
  /// did, it would not reach a record from here.
  fn redacted(self, secret: &[u8]) -> Self {
    let Some(secret) = std::str::from_utf8(secret).ok().filter(|s| !s.is_empty()) else {
      return self;
    };
    let clean = |line: String| {
      if line.contains(secret) {
        line.replace(secret, "[redacted]")
      } else {
        line
      }
    };
    match self {
      Self::Proceed { line } => Self::Proceed { line: clean(line) },
      Self::Blocked { blocker, line } => Self::Blocked {
        blocker,
        line: clean(line),
      },
    }
  }
}

/// How a script's process ended, as the status-line parsers report it: its
/// exit code, or the signal that killed it by number. A bare
/// `ExitStatus::code()` made deno 2.7.14's startup SIGSEGV read
/// `exit a signal`, which named nothing to look for (lane DN).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChildExit {
  Code(i32),
  Signal(i32),
  /// Only the absence of a code is known (a caller holding `code()` alone).
  Unknown,
}

impl ChildExit {
  pub fn code(self) -> Option<i32> {
    match self {
      Self::Code(code) => Some(code),
      Self::Signal(_) | Self::Unknown => None,
    }
  }

  /// `exit 4`, `signal 11`, or `exit a signal` when only that is known.
  pub fn label(self) -> String {
    match self {
      Self::Code(code) => format!("exit {code}"),
      Self::Signal(signal) => format!("signal {signal}"),
      Self::Unknown => "exit a signal".to_string(),
    }
  }
}

impl From<std::process::ExitStatus> for ChildExit {
  fn from(status: std::process::ExitStatus) -> Self {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
      (Some(code), _) => Self::Code(code),
      (None, Some(signal)) => Self::Signal(signal),
      (None, None) => Self::Unknown,
    }
  }
}

impl From<Option<i32>> for ChildExit {
  fn from(code: Option<i32>) -> Self {
    code.map_or(Self::Unknown, Self::Code)
  }
}

/// Decide from the script's exit and stdout. Only its LAST
/// `google-signin:` line counts; a success word with a failing exit is an
/// error, and no line at all is `google-signin-no-status`, which names the
/// exit code or the signal.
pub fn signin_outcome(exit: impl Into<ChildExit>, stdout: &str) -> SigninOutcome {
  signin_outcome_for(SigninProvider::Google, exit, stdout)
}

/// [`signin_outcome`] for either provider. Google's human step is
/// `needs-human`; Microsoft's is `challenge`, recorded as
/// [`MICROSOFT_CHALLENGE_BLOCKER`].
pub fn signin_outcome_for(
  provider: SigninProvider,
  exit: impl Into<ChildExit>,
  stdout: &str,
) -> SigninOutcome {
  let exit = exit.into();
  let status = provider.status();
  let Some(line) = stdout
    .lines()
    .rev()
    .map(str::trim)
    .find(|line| line.starts_with(status))
  else {
    return SigninOutcome::blocked_for(
      provider,
      "no-status",
      format!("{status} no-status ({})", exit.label()),
    );
  };
  let line: String = line.chars().take(240).collect();
  let kind = line[status.len()..]
    .split_whitespace()
    .next()
    .unwrap_or_default()
    .to_string();
  let human = match provider {
    SigninProvider::Google => "needs-human",
    SigninProvider::Microsoft => "challenge",
  };
  match (kind.as_str(), exit.code()) {
    ("already-signed-in" | "signed-in", Some(0)) => SigninOutcome::Proceed { line },
    (kind, _) if kind == human => SigninOutcome::blocked_for(provider, kind, line),
    ("timeout" | "error", _) => SigninOutcome::blocked_for(provider, &kind, line),
    _ => SigninOutcome::blocked_for(provider, "error", line),
  }
}

/// Runs the pre-step against a browser already listening on `devtools_port`.
/// A seam so the drive is testable without Deno, a browser or Google.
#[async_trait]
pub trait SignIn: Send + Sync {
  /// `out_dir` receives the script, its stderr log and any screenshot.
  /// `workspace` is the agent's work dir: a real pre-step refuses to run a
  /// deno that would load code from inside it ([`deno_outside_workspace`]).
  async fn sign_in(&self, devtools_port: u16, out_dir: &Path, workspace: &Path) -> SigninOutcome;

  /// [`Self::sign_in`], plus the startup-crash retries it took on the way,
  /// for `agent.json` ([`AgentRecord::signin_retries`]). A pre-step that
  /// never retries need not override it.
  async fn sign_in_recorded(
    &self,
    devtools_port: u16,
    out_dir: &Path,
    workspace: &Path,
  ) -> (SigninOutcome, Vec<SigninRetry>) {
    (
      self.sign_in(devtools_port, out_dir, workspace).await,
      Vec::new(),
    )
  }

  /// The pre-step's directory beside the run.
  fn dir_name(&self) -> &str {
    SigninProvider::Google.label()
  }
}

/// One retry of a pre-step whose deno died at startup ([`startup_crash`]):
/// which pre-step, the signal that killed the first attempt, and how long
/// after exec it died. Recorded in `agent.json`, so a run that passed only on
/// the retry is told apart from a clean one (review L34 F3, operator Q12).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigninRetry {
  /// The pre-step's label (`google-signin`, `microsoft-signin`).
  pub provider: &'static str,
  pub signal: i32,
  pub elapsed_ms: u64,
}

/// Several pre-steps on the one private browser, in order (Google, then
/// Microsoft). Each writes into its own directory under the sequence's, the
/// first that does not sign in ends it, and the outcome's line holds every
/// status line that ran, one per line.
pub struct SigninSequence<'a> {
  pub steps: Vec<&'a dyn SignIn>,
}

/// The directory a [`SigninSequence`] writes under, beside the run.
pub const SIGNIN_SEQUENCE_DIR: &str = "signin";

#[async_trait]
impl SignIn for SigninSequence<'_> {
  async fn sign_in(&self, devtools_port: u16, out_dir: &Path, workspace: &Path) -> SigninOutcome {
    self
      .sign_in_recorded(devtools_port, out_dir, workspace)
      .await
      .0
  }

  async fn sign_in_recorded(
    &self,
    devtools_port: u16,
    out_dir: &Path,
    workspace: &Path,
  ) -> (SigninOutcome, Vec<SigninRetry>) {
    let mut lines = Vec::new();
    let mut retries = Vec::new();
    for step in &self.steps {
      let (outcome, retried) = step
        .sign_in_recorded(devtools_port, &out_dir.join(step.dir_name()), workspace)
        .await;
      retries.extend(retried);
      lines.push(outcome.line().to_string());
      if let SigninOutcome::Blocked { blocker, .. } = outcome {
        let blocked = SigninOutcome::Blocked {
          blocker,
          line: lines.join("\n"),
        };
        return (blocked, retries);
      }
    }
    let proceed = SigninOutcome::Proceed {
      line: lines.join("\n"),
    };
    (proceed, retries)
  }

  fn dir_name(&self) -> &str {
    SIGNIN_SEQUENCE_DIR
  }
}

/// The pre-step for one drive: who signs in, and where its files go.
pub struct PreSignin<'a> {
  pub signer: &'a dyn SignIn,
  pub out_dir: PathBuf,
  /// The agent's work dir, which the pre-step's deno must not load from.
  pub workspace: PathBuf,
}

/// The real pre-step: `deno run` of the provider's embedded script
/// ([`GOOGLE_SIGNIN_SOURCE`], [`MICROSOFT_SIGNIN_SOURCE`]) under the
/// runner's `deno.json`, cached modules only, network only to the private
/// DevTools port, files only in `out_dir`, the password on stdin, and nothing
/// of this process's environment but [`SIGNIN_ENV_ALLOWLIST`].
#[derive(Clone, Debug)]
pub struct DenoSignin {
  pub provider: SigninProvider,
  pub deno: PathBuf,
  /// The runner's `deno.json`; `None` when this host has no runner.
  pub deno_config: Option<PathBuf>,
  pub account: String,
  pub password_file: PathBuf,
  /// Tested app URL, used only to start Microsoft OAuth through the app.
  pub app_url: Option<String>,
  pub timeout: Duration,
}

impl DenoSignin {
  pub fn new(config: &SigninConfig, runner_dir: Option<&Path>, app_url: &str) -> Self {
    Self {
      provider: config.provider,
      deno: PathBuf::from("deno"),
      deno_config: runner_dir.and_then(|dir| std::fs::canonicalize(dir.join("deno.json")).ok()),
      account: config.account.clone(),
      password_file: config.password_file.clone(),
      app_url: (config.provider == SigninProvider::Microsoft).then(|| app_url.to_string()),
      // The script gives up at 75 s; this is the kill behind it.
      timeout: Duration::from_secs(100),
    }
  }

  /// The child's command line: the script, the DevTools URL, the account and
  /// the output dir. Nothing about the password is in its argv or its env; it
  /// goes to stdin in [`Self::run`]. The environment is this process's, cut
  /// down to [`SIGNIN_ENV_ALLOWLIST`].
  pub fn command(
    &self,
    deno_config: &Path,
    devtools_port: u16,
    out_dir: &Path,
  ) -> tokio::process::Command {
    self.command_with_env(deno_config, devtools_port, out_dir, std::env::vars_os())
  }

  /// [`Self::command`] over an explicit parent environment, so a test can hand
  /// in one with `DEBUG` set without touching this process's own.
  pub fn command_with_env(
    &self,
    deno_config: &Path,
    devtools_port: u16,
    out_dir: &Path,
    parent_env: impl IntoIterator<Item = (OsString, OsString)>,
  ) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(&self.deno);
    command
      .arg("run")
      .arg("--no-prompt")
      .arg("--cached-only")
      .arg("--config")
      .arg(deno_config)
      .arg(format!("--allow-net=127.0.0.1:{devtools_port}"))
      .arg(format!("--allow-read={}", out_dir.display()))
      .arg(format!("--allow-write={}", out_dir.display()))
      .arg("--allow-env")
      .arg(out_dir.join(self.provider.script()))
      .arg(format!("http://127.0.0.1:{devtools_port}"))
      .arg(&self.account)
      .arg(out_dir)
      // Nothing inherited but the allowlist: not the password file's path (the
      // script has no business reading it), and not `DEBUG`, under which
      // puppeteer-core logs every `Input.dispatchKeyEvent` it sends — the
      // password, key by key — into `<provider>-signin.log`.
      .env_clear()
      .envs(signin_env(parent_env))
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .kill_on_drop(true);
    if self.provider == SigninProvider::Microsoft {
      if let Some(app_url) = &self.app_url {
        command.arg(app_url);
      }
    }
    command
  }

  async fn run(
    &self,
    devtools_port: u16,
    out_dir: &Path,
    workspace: &Path,
  ) -> Result<(SigninOutcome, Vec<SigninRetry>)> {
    let deno_config = self
      .deno_config
      .as_deref()
      .context("this host has no ux runner deno.json to run the sign-in script under")?;
    // X-D2: nothing this deno loads may sit where the agent writes. Checked
    // before anything is written, read or spawned, over the very environment
    // the child gets.
    let parent_env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let child_env = signin_env(parent_env.iter().cloned());
    deno_outside_workspace(workspace, &self.deno, deno_config, &child_env, &parent_env)?;
    std::fs::create_dir_all(out_dir).with_context(|| format!("create {}", out_dir.display()))?;
    let script = out_dir.join(self.provider.script());
    std::fs::write(&script, self.provider.source())
      .with_context(|| format!("write {}", script.display()))?;
    if self.provider == SigninProvider::Microsoft {
      let helper = out_dir.join(MICROSOFT_OAUTH_START_SCRIPT);
      std::fs::write(&helper, MICROSOFT_OAUTH_START_SOURCE)
        .with_context(|| format!("write {}", helper.display()))?;
    }
    let log_path = out_dir.join(format!("{}.log", self.provider.label()));

    let mut password = read_password(&self.password_file)?;
    let attempt = || {
      self.attempt(
        deno_config,
        devtools_port,
        out_dir,
        &log_path,
        &parent_env,
        &password,
      )
    };
    let started = Instant::now();
    let mut ended = attempt().await;
    let elapsed = started.elapsed();
    let mut retries = Vec::new();
    // Lane DN: deno 2.7.14 sometimes dies on SIGSEGV ~20 ms after exec, on a
    // tokio worker, before it runs a line of the script. Such a run never
    // reached the browser, so Google saw nothing and one retry is free. Once,
    // and recorded (agent.json `signinRetries`).
    if let Ok(Some((exit, stdout))) = &ended
      && startup_crash(*exit, stdout, &log_path, elapsed)
      && let ChildExit::Signal(signal) = *exit
    {
      retries.push(SigninRetry {
        provider: self.provider.label(),
        signal,
        elapsed_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
      });
      warn!(
        "  {} deno died on {} with no output and an empty log, before the script ran \
         (deno's startup crash); retrying the pre-step once",
        self.provider.label(),
        exit.label()
      );
      ended = attempt().await;
    }
    let outcome = match ended {
      Ok(Some((exit, stdout))) => {
        signin_outcome_for(self.provider, exit, &String::from_utf8_lossy(&stdout))
      }
      Ok(None) => SigninOutcome::blocked_for(
        self.provider,
        "timeout",
        format!(
          "{} timeout the script ran past {}s",
          self.provider.status(),
          self.timeout.as_secs()
        ),
      ),
      Err(error) => {
        password.fill(0);
        return Err(error);
      }
    }
    .redacted(&password);
    password.fill(0);
    Ok((outcome, retries))
  }

  /// One run of the script with a fresh, empty stderr log at `log_path`: how
  /// it ended and its stdout, or `None` when it ran past [`Self::timeout`]
  /// and was killed.
  async fn attempt(
    &self,
    deno_config: &Path,
    devtools_port: u16,
    out_dir: &Path,
    log_path: &Path,
    parent_env: &[(OsString, OsString)],
    password: &[u8],
  ) -> Result<Option<(ChildExit, Vec<u8>)>> {
    let log =
      std::fs::File::create(log_path).with_context(|| format!("create {}", log_path.display()))?;
    let mut command = self.command_with_env(
      deno_config,
      devtools_port,
      out_dir,
      parent_env.iter().cloned(),
    );
    command.stderr(Stdio::from(log));
    let mut child = command
      .spawn()
      .with_context(|| format!("spawn {} (is `deno` on PATH?)", self.deno.display()))?;
    if let Some(mut stdin) = child.stdin.take() {
      // A script that exits before reading (a usage error) closes the pipe;
      // its status line says why, so a failed write is not the story.
      let _ = stdin.write_all(password).await;
      let _ = stdin.shutdown().await;
    }
    match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
      Ok(output) => {
        let output = output.context("wait for the sign-in script")?;
        Ok(Some((output.status.into(), output.stdout)))
      }
      // Dropping the wait drops the child: `kill_on_drop`.
      Err(_) => Ok(None),
    }
  }
}

/// How soon after exec a deno crash still counts as [`startup_crash`].
pub const STARTUP_CRASH_WINDOW: Duration = Duration::from_secs(5);

/// Whether a pre-step's deno died the way deno 2.7.14 does at startup, and so
/// provably before it reached the browser: killed by SIGSEGV or SIGBUS with
/// nothing on stdout and nothing in its stderr log. Both scripts write a
/// `started` line to stderr before they read the password or open DevTools,
/// and deno's own `Initialize` lines land there earlier still, so an empty log
/// means the script never ran. It must also have died within
/// [`STARTUP_CRASH_WINDOW`] of exec (the crash comes at ~20 ms), so a retry
/// never doubles the pre-step's deadline. Any other end is the script's own
/// story. The `started` line is pinned by
/// `the_sign_in_scripts_say_started_before_anything_else`.
pub fn startup_crash(exit: ChildExit, stdout: &[u8], log: &Path, elapsed: Duration) -> bool {
  elapsed < STARTUP_CRASH_WINDOW
    && matches!(exit, ChildExit::Signal(libc::SIGSEGV | libc::SIGBUS))
    && stdout.is_empty()
    && std::fs::metadata(log).is_ok_and(|meta| meta.len() == 0)
}

#[async_trait]
impl SignIn for DenoSignin {
  async fn sign_in(&self, devtools_port: u16, out_dir: &Path, workspace: &Path) -> SigninOutcome {
    self
      .sign_in_recorded(devtools_port, out_dir, workspace)
      .await
      .0
  }

  async fn sign_in_recorded(
    &self,
    devtools_port: u16,
    out_dir: &Path,
    workspace: &Path,
  ) -> (SigninOutcome, Vec<SigninRetry>) {
    match self.run(devtools_port, out_dir, workspace).await {
      Ok(ran) => ran,
      Err(error) => (
        SigninOutcome::blocked_for(
          self.provider,
          "error",
          format!("{} error {error:#}", self.provider.status()),
        ),
        Vec::new(),
      ),
    }
  }

  fn dir_name(&self) -> &str {
    self.provider.label()
  }
}

/// The Google pre-step's runner (the name it had before Microsoft's).
pub type DenoGoogleSignin = DenoSignin;

/// The only variables the sign-in script's process inherits. The script reads
/// none of its own; Deno needs `PATH`, `HOME`, `DENO_DIR` and `XDG_CACHE_HOME`
/// to find its module cache, `TMPDIR` for scratch and `LANG`/`LC_ALL` for text.
/// Everything else — `DEBUG` above all, and any `*_PROXY` — is dropped.
pub const SIGNIN_ENV_ALLOWLIST: &[&str] = &[
  "PATH",
  "HOME",
  "DENO_DIR",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
];

/// The part of `parent_env` on [`SIGNIN_ENV_ALLOWLIST`].
pub(crate) fn signin_env(
  parent_env: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
  parent_env
    .into_iter()
    .filter(|(key, _)| {
      key
        .to_str()
        .is_some_and(|key| SIGNIN_ENV_ALLOWLIST.contains(&key))
    })
    .collect()
}

/// Review K-11, operator decision X-D2 (a): refuse to start a deno that is
/// handed a password (a sign-in pre-step, the `fill_secret` typist) when any
/// code or cache it loads sits inside the agent's work dir — the one
/// directory the agent (and so a spec) may write.
///
/// Judged, each by every name it is reached through (the entry under its
/// resolved parent, its final target, and every link met on the way by its
/// own location, review O-3; a path that does not exist yet by its deepest
/// existing ancestor): the runner dir, its `deno.json` and
/// `node_modules`, the child's `DENO_DIR` (deno's own default when unset) and
/// the deno binary (looked up on the child's `PATH` when bare, as the spawn
/// does). `child_env` is the environment the child gets ([`signin_env`]);
/// `harness_env` is the harness's own, as the caller read it from this
/// process (review AA-D2: passed in, so a test can tell the two apart).
/// Anything that cannot be resolved is refused, not guessed.
///
/// Operator decision OQ-1 (review O-5a): the same holds for the temp dirs a
/// sandboxed agent may also write — the child's `TMPDIR` (when unset, the
/// platform default it falls back to), the harness's own `TMPDIR` (review
/// L10 Z1) and [`DENO_TEMP_ROOTS`]. The error names the path, what it is and
/// the root it is under. A root that sits inside a judged path is refused as
/// well (review L10 Z3), since the agent could then write into it.
///
/// What this does not do: it does not pin what those directories hold. A
/// lockfile cannot (deno checks an npm package's integrity only when it
/// extracts it), so the guarantee rests on the agent being unable to write
/// outside its work dir — see the module doc of [`crate::fill_secret`].
pub fn deno_outside_workspace(
  workspace: &Path,
  deno: &Path,
  deno_config: &Path,
  child_env: &[(OsString, OsString)],
  harness_env: &[(OsString, OsString)],
) -> Result<()> {
  let runner = match deno_config.parent() {
    Some(dir) if !dir.as_os_str().is_empty() => dir.to_path_buf(),
    _ => PathBuf::from("."),
  };
  let node_modules = runner.join("node_modules");
  deno_loads_outside_writable_roots(
    workspace,
    deno,
    &[
      ("the runner dir", &runner),
      ("the runner's deno.json", deno_config),
      ("the runner's node_modules", &node_modules),
    ],
    child_env,
    harness_env,
  )
}

/// [`deno_outside_workspace`] for the harness sink (OQ-1, review O-5c),
/// which runs `--no-config`: its code is the sidecar the harness writes into
/// `script_dir`, plus `DENO_DIR` and the binary, judged against the same
/// roots. `child_env` is the environment the sidecar is spawned with,
/// `harness_env` the harness's own (as for [`deno_outside_workspace`]). The
/// sidecar's dir is `<run dir>/harness-sink/`, so a refusal of it names the
/// run dir: a run dir (the ux-test log root) under a temp dir fails here
/// (review L10 Z2).
pub fn deno_script_outside_workspace(
  workspace: &Path,
  deno: &Path,
  script_dir: &Path,
  child_env: &[(OsString, OsString)],
  harness_env: &[(OsString, OsString)],
) -> Result<()> {
  deno_loads_outside_writable_roots(
    workspace,
    deno,
    &[("the sidecar's script dir in the run dir", script_dir)],
    child_env,
    harness_env,
  )
}

/// The temp dirs a Codex `workspace-write` lane may write besides its cwd and
/// `$TMPDIR` (macOS keeps `/tmp` and the per-user temp dirs under
/// `/private`), refused for anything a password-handling or result-writing
/// deno loads.
pub const DENO_TEMP_ROOTS: &[&str] = &[
  "/tmp",
  "/var/tmp",
  "/private/tmp",
  "/private/var/folders",
  "/var/folders",
];

/// The checks behind [`deno_outside_workspace`]: `code`, the child's
/// `DENO_DIR` and the binary, each by every name it is reached through,
/// against every root the agent may write ([`writable_roots`]).
fn deno_loads_outside_writable_roots(
  workspace: &Path,
  deno: &Path,
  code: &[(&str, &Path)],
  child_env: &[(OsString, OsString)],
  harness_env: &[(OsString, OsString)],
) -> Result<()> {
  let work = std::fs::canonicalize(workspace).with_context(|| {
    format!(
      "refusing to run deno: cannot resolve the agent work dir {}",
      workspace.display()
    )
  })?;
  let roots = writable_roots(work, child_env, harness_env)?;
  let deno_dir = deno_dir_of(child_env)?;
  let binary = deno_binary_of(deno, child_env)?;
  let judged = code.iter().copied().chain([
    ("DENO_DIR (deno's module cache)", deno_dir.as_path()),
    ("the deno binary", binary.as_path()),
  ]);
  for (what, path) in judged {
    let names = resolved_names(path).with_context(|| {
      format!(
        "refusing to run deno: cannot resolve {what} {}",
        path.display()
      )
    })?;
    for root in &roots {
      if let Some(inside) = names.iter().find(|name| name.starts_with(&root.path)) {
        let shown = if inside.as_path() == path {
          format!("{what} {}", path.display())
        } else if is_link(inside) {
          format!(
            "{what} {} goes through the link {}",
            path.display(),
            inside.display()
          )
        } else {
          format!("{what} {} resolves to {}", path.display(), inside.display())
        };
        anyhow::bail!("refusing to run deno: {shown}, inside {}", root.label);
      }
      // Review L10 Z3: the other way round, a root inside what deno loads
      // lets the agent write into it.
      if let Some(outer) = names.iter().find(|name| root.path.starts_with(name)) {
        let shown = if outer.as_path() == path {
          format!("{what} {}", path.display())
        } else {
          format!(
            "{what} {} (resolves to {})",
            path.display(),
            outer.display()
          )
        };
        anyhow::bail!("refusing to run deno: {} sits inside {shown}", root.label);
      }
    }
  }
  Ok(())
}

fn is_link(path: &Path) -> bool {
  std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// A directory the agent may write, resolved, and how a refusal names it.
struct WritableRoot {
  path: PathBuf,
  label: String,
}

/// The agent work dir (already canonical), the child's temp dir and
/// [`DENO_TEMP_ROOTS`], each resolved as [`resolve_existing`] resolves a
/// path (one that does not exist yet by its nearest existing ancestor).
///
/// The child's temp dir is what `std::env::temp_dir` (and so deno) answers in
/// the child: its `TMPDIR` when set, else `/tmp`, or on macOS the per-user
/// `confstr(_CS_DARWIN_USER_TEMP_DIR)` dir, which lies under `/var/folders`
/// (falling back to `/tmp`). It is read from `child_env`, never from this
/// process. An empty `TMPDIR` counts as unset, as `DENO_DIR` does.
///
/// Review L10 Z1: the harness's own `TMPDIR` (from `harness_env`) is a root
/// as well, apart from the child's. The agent lane is not this process's
/// child (the host queue runs it), so its env cannot be read here; but a
/// lane started from the same session shares that `TMPDIR`, and a fenced tsh
/// lane's private temp dir is made under it (`<TMPDIR>/tsh-lanes-<uid>/`).
/// When it is unset the lane's default is `/tmp` or `/var/folders`, already
/// fixed roots.
fn writable_roots(
  work: PathBuf,
  child_env: &[(OsString, OsString)],
  harness_env: &[(OsString, OsString)],
) -> Result<Vec<WritableRoot>> {
  let mut roots = vec![WritableRoot {
    label: format!("the agent work dir {}", work.display()),
    path: work,
  }];
  let temp = match env_path(child_env, "TMPDIR") {
    Some(dir) => (dir.clone(), format!("the child's TMPDIR {}", dir.display())),
    None => {
      let dir = PathBuf::from(if cfg!(target_vendor = "apple") {
        "/var/folders"
      } else {
        "/tmp"
      });
      let label = format!(
        "the child's default temp dir {} (TMPDIR unset)",
        dir.display()
      );
      (dir, label)
    }
  };
  let harness_temp = env_path(harness_env, "TMPDIR").map(|dir| {
    let label = format!("the harness's TMPDIR {}", dir.display());
    (dir, label)
  });
  let fixed = DENO_TEMP_ROOTS
    .iter()
    .map(|root| (PathBuf::from(root), format!("the temp dir {root}")));
  for (raw, label) in std::iter::once(temp).chain(harness_temp).chain(fixed) {
    let absolute = if raw.is_absolute() {
      raw.clone()
    } else {
      std::env::current_dir()
        .context("read the current dir")?
        .join(&raw)
    };
    let path = resolve_existing(&absolute)
      .with_context(|| format!("refusing to run deno: cannot resolve {label}"))?;
    if roots.iter().any(|root| root.path == path) {
      continue;
    }
    let label = if path == raw {
      label
    } else {
      format!("{label} ({})", path.display())
    };
    roots.push(WritableRoot { path, label });
  }
  Ok(roots)
}

/// A variable of `env`, as a path; empty counts as unset (as deno reads it).
fn env_path(env: &[(OsString, OsString)], key: &str) -> Option<PathBuf> {
  env
    .iter()
    .find(|(name, _)| name.as_os_str() == key)
    .map(|(_, value)| PathBuf::from(value))
    .filter(|path| !path.as_os_str().is_empty())
}

/// Where a deno started with `env` keeps its cache: `DENO_DIR`, else deno's
/// default (`$XDG_CACHE_HOME/deno` or `$HOME/.cache/deno` on Linux,
/// `$HOME/Library/Caches/deno` on macOS).
fn deno_dir_of(env: &[(OsString, OsString)]) -> Result<PathBuf> {
  if let Some(dir) = env_path(env, "DENO_DIR") {
    return Ok(dir);
  }
  let home = env_path(env, "HOME");
  let cache = if cfg!(target_os = "macos") {
    home.map(|home| home.join("Library/Caches"))
  } else {
    env_path(env, "XDG_CACHE_HOME")
      .filter(|dir| dir.is_absolute())
      .or_else(|| home.map(|home| home.join(".cache")))
  };
  cache.map(|dir| dir.join("deno")).context(
    "refusing to run deno: cannot tell where DENO_DIR (deno's module cache) is: \
     the child has neither DENO_DIR nor HOME",
  )
}

/// The file the spawn runs: `deno` itself when it names a path, else the
/// first executable `deno` on the child's `PATH`.
fn deno_binary_of(deno: &Path, env: &[(OsString, OsString)]) -> Result<PathBuf> {
  if deno.is_absolute() || deno.components().count() != 1 {
    return Ok(deno.to_path_buf());
  }
  let path = env
    .iter()
    .find(|(name, _)| name.as_os_str() == "PATH")
    .map(|(_, value)| value.clone())
    .with_context(|| {
      format!(
        "refusing to run deno: the child has no PATH to find {} on",
        deno.display()
      )
    })?;
  std::env::split_paths(&path)
    .map(|dir| dir.join(deno))
    .find(|candidate| {
      use std::os::unix::fs::PermissionsExt;
      std::fs::metadata(candidate)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    })
    .with_context(|| {
      format!(
        "refusing to run deno: no executable {} on the child's PATH",
        deno.display()
      )
    })
}

/// Every name `path` is reached through: the entry itself under its resolved
/// parent (a link there can be re-pointed by whoever writes that dir), when
/// it exists its final target, and the own location of every link met on the
/// way, hop by hop (review O-3, operator decision OQ-3): a link in the work
/// dir that a path passes through mid-way can be re-pointed by the agent,
/// wherever the path ends up.
///
/// One walk (review L11-3): the parent is resolved once, and the final
/// target is reached from it, so each link is recorded and counted toward
/// [`MAX_LINK_HOPS`] once.
fn resolved_names(path: &Path) -> Result<Vec<PathBuf>> {
  let path = absolute(path)?;
  let exists = std::fs::symlink_metadata(&path).is_ok();
  let mut names = Vec::new();
  let mut links = Vec::new();
  let mut hops = 0;
  if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
    let dir = walk_links(parent, false, &mut links, &mut hops)?;
    names.push(dir.join(name));
    if exists {
      names.push(
        walk_on(dir, Path::new(name), true, &mut links, &mut hops)
          .with_context(|| format!("{} leads nowhere", path.display()))?,
      );
    }
  } else if exists {
    names.push(
      walk_links(&path, true, &mut links, &mut hops)
        .with_context(|| format!("{} leads nowhere", path.display()))?,
    );
  } else {
    names.push(walk_links(&path, false, &mut links, &mut hops)?);
  }
  names.extend(links);
  Ok(names)
}

/// `path` resolved through its deepest existing ancestor, the missing rest
/// appended as named. An entry that exists but does not resolve (a dangling
/// link) and a missing rest with `..` in it are refused.
fn resolve_existing(path: &Path) -> Result<PathBuf> {
  walk_links(&absolute(path)?, false, &mut Vec::new(), &mut 0)
}

fn absolute(path: &Path) -> Result<PathBuf> {
  Ok(if path.is_absolute() {
    path.to_path_buf()
  } else {
    std::env::current_dir()
      .context("read the current dir")?
      .join(path)
  })
}

/// How many links one resolution follows before it gives up (Linux's own
/// `MAXSYMLINKS`).
const MAX_LINK_HOPS: usize = 40;

/// Resolve the absolute `path` one component at a time, as the kernel does:
/// each link met is recorded in `links` by its own location (its parent
/// already resolved) and then followed, its target resolved the same way and
/// required to exist. Once a component is missing (allowed only when
/// `must_exist` is false), the rest is appended as named; `..` there is
/// refused. Each existing component takes its on-disk spelling
/// ([`on_disk`], a link's own name [`link_on_disk`]), so the result equals
/// `canonicalize` for a path that exists, on a case-insensitive filesystem
/// too (review L11-2).
fn walk_links(
  path: &Path,
  must_exist: bool,
  links: &mut Vec<PathBuf>,
  hops: &mut usize,
) -> Result<PathBuf> {
  walk_on(PathBuf::from("/"), path, must_exist, links, hops)
}

/// [`walk_links`] onward from `real`, a dir it already resolved (existing,
/// link-free, on-disk spelling), through the components of `path`.
fn walk_on(
  mut real: PathBuf,
  path: &Path,
  must_exist: bool,
  links: &mut Vec<PathBuf>,
  hops: &mut usize,
) -> Result<PathBuf> {
  use std::path::Component;
  let mut missing = false;
  for part in path.components() {
    match part {
      Component::Prefix(_) | Component::RootDir | Component::CurDir => {}
      Component::ParentDir if missing => {
        anyhow::bail!("{} cannot be resolved", path.display())
      }
      Component::ParentDir => {
        real.pop();
      }
      Component::Normal(name) => {
        let next = real.join(name);
        if missing {
          real = next;
          continue;
        }
        match std::fs::symlink_metadata(&next) {
          Ok(meta) if meta.file_type().is_symlink() => {
            let next = link_on_disk(&real, name, &meta)?;
            *hops += 1;
            if *hops > MAX_LINK_HOPS {
              anyhow::bail!("{} leads nowhere: too many links", next.display());
            }
            let target = std::fs::read_link(&next)
              .with_context(|| format!("{} leads nowhere", next.display()))?;
            links.push(next.clone());
            // A relative target is relative to the link's (resolved) dir.
            real = walk_links(&real.join(target), true, links, hops)
              .with_context(|| format!("{} leads nowhere", next.display()))?;
          }
          Ok(meta) => real = on_disk(&real, name, &meta)?,
          Err(_) if must_exist => anyhow::bail!("{} does not exist", next.display()),
          Err(_) => {
            missing = true;
            real = next;
          }
        }
      }
    }
  }
  Ok(real)
}

/// `dir.join(name)` by the entry's on-disk spelling (review L11-2), for an
/// entry that is not a link. On a case-insensitive filesystem (macOS APFS)
/// `name` can reach an entry spelled otherwise (`/users` for `/Users`), while
/// the work dir root is `canonicalize`d to the on-disk spelling, so a path
/// into it spelled otherwise would not be `starts_with` it. `dir` is already
/// resolved and link-free, so `canonicalize` of the entry only corrects its
/// spelling, and needs no read permission on `dir` (review L12-1). Should it
/// answer anything but an entry of `dir` with `meta`'s device and inode (a
/// race, or a hard link's twin), the entry is looked up by [`link_on_disk`]'s
/// scan. On other systems `name` as written.
fn on_disk(dir: &Path, name: &std::ffi::OsStr, meta: &std::fs::Metadata) -> Result<PathBuf> {
  #[cfg(target_vendor = "apple")]
  if let Ok(real) = std::fs::canonicalize(dir.join(name))
    && real.parent() == Some(dir)
    && same_entry(&real, meta)
  {
    return Ok(real);
  }
  link_on_disk(dir, name, meta)
}

/// `dir.join(name)` by the on-disk spelling of a link's own name, which
/// `canonicalize` cannot tell (it follows the link): the entry of `dir` named
/// exactly `name`, else the one with `meta`'s device and inode. On Apple a
/// `dir` that cannot be listed, or holds no such entry, is refused rather
/// than the name kept as written (review L12-1). On other systems `name` as
/// written.
fn link_on_disk(dir: &Path, name: &std::ffi::OsStr, meta: &std::fs::Metadata) -> Result<PathBuf> {
  #[cfg(target_vendor = "apple")]
  {
    let names: Vec<OsString> = std::fs::read_dir(dir)
      .and_then(|entries| {
        entries
          .map(|entry| entry.map(|entry| entry.file_name()))
          .collect()
      })
      .with_context(|| {
        format!(
          "{} cannot be listed to tell the on-disk spelling of {}",
          dir.display(),
          dir.join(name).display()
        )
      })?;
    if names.iter().any(|entry| entry.as_os_str() == name) {
      return Ok(dir.join(name));
    }
    names
      .iter()
      .map(|entry| dir.join(entry))
      .find(|entry| same_entry(entry, meta))
      .with_context(|| {
        format!(
          "{} has no entry for {}",
          dir.display(),
          dir.join(name).display()
        )
      })
  }
  #[cfg(not(target_vendor = "apple"))]
  {
    let _ = meta;
    Ok(dir.join(name))
  }
}

/// Whether `path` (not followed) is the entry `meta` describes.
#[cfg(target_vendor = "apple")]
fn same_entry(path: &Path, meta: &std::fs::Metadata) -> bool {
  use std::os::unix::fs::MetadataExt;
  std::fs::symlink_metadata(path)
    .is_ok_and(|other| other.dev() == meta.dev() && other.ino() == meta.ino())
}

/// The password file's bytes, less ONE trailing newline (`\n` or `\r\n`).
pub(crate) fn read_password(path: &Path) -> Result<Vec<u8>> {
  let mut bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
  if bytes.ends_with(b"\r\n") {
    bytes.truncate(bytes.len() - 2);
  } else if bytes.ends_with(b"\n") {
    bytes.truncate(bytes.len() - 1);
  }
  Ok(bytes)
}

/// Sign in on a browser of the run's own: the same profile and flags as the
/// agent's, a private DevTools port and `about:blank`. It is shut down before
/// this returns, whatever happened, so the agent's browser can open the
/// profile. `Err` is how the drive ends.
async fn pre_sign_in(
  pre: &PreSignin<'_>,
  launcher: &dyn LaunchBrowser,
  launch: &BrowserLaunch,
  run: &mut AgentRun,
) -> std::result::Result<(), AgentEnd> {
  let browser_failed = |error: anyhow::Error| AgentEnd::BrowserFailed(format!("{error:#}"));
  std::fs::create_dir_all(&pre.out_dir)
    .with_context(|| format!("create {}", pre.out_dir.display()))
    .map_err(browser_failed)?;
  let port = free_loopback_port().map_err(browser_failed)?;
  let private = BrowserLaunch {
    url: "about:blank".to_string(),
    devtools_port: port,
    log_path: pre.out_dir.join("browser.log"),
    ..launch.clone()
  };
  info!("  Sign-in pre-step on a private DevTools port");
  let browser = launcher.launch(&private).await.map_err(browser_failed)?;
  if let Err(error) = browser.close_stray_pages().await {
    browser.shutdown().await;
    return Err(browser_failed(error));
  }
  let (outcome, retries) = pre
    .signer
    .sign_in_recorded(port, &pre.out_dir, &pre.workspace)
    .await;
  browser.shutdown().await;
  run.signin_retries = retries;
  for line in outcome.line().lines() {
    info!("  {line}");
  }
  run.signin = Some(outcome.line().to_string());
  match outcome {
    SigninOutcome::Proceed { .. } => Ok(()),
    SigninOutcome::Blocked { blocker, line } => Err(AgentEnd::SigninBlocked { blocker, line }),
  }
}

/// The file whose lock makes a profile this run's, in the profile dir beside
/// Chrome's own `SingletonLock`.
pub const PROFILE_LOCK_FILE: &str = "ux-test.lock";

/// Exclusive use of the browser profile, from the sign-in pre-step until the
/// agent's browser has closed. The pre-step runs before its job is enqueued
/// (no agent may be running while its private DevTools port is open), which
/// is before the lane's `max-running 1` can say the profile is free — so this
/// says it instead. An advisory `flock`: released when the guard drops, and by
/// the kernel when this process dies.
pub struct ProfileLock {
  _file: std::fs::File,
}

impl ProfileLock {
  /// Take the lock on `user_data_dir`, waiting up to `within` and retrying
  /// every `poll`. `Ok(None)`: another run held it throughout.
  pub async fn acquire(
    user_data_dir: &Path,
    within: Duration,
    poll: Duration,
  ) -> Result<Option<Self>> {
    std::fs::create_dir_all(user_data_dir)
      .with_context(|| format!("create {}", user_data_dir.display()))?;
    let path = user_data_dir.join(PROFILE_LOCK_FILE);
    let file = std::fs::OpenOptions::new()
      .create(true)
      .truncate(false)
      .write(true)
      .open(&path)
      .with_context(|| format!("open {}", path.display()))?;
    let deadline = Instant::now() + within;
    loop {
      match file.try_lock() {
        Ok(()) => return Ok(Some(Self { _file: file })),
        Err(std::fs::TryLockError::WouldBlock) => {}
        Err(std::fs::TryLockError::Error(error)) => {
          return Err(error).with_context(|| format!("lock {}", path.display()));
        }
      }
      if Instant::now() >= deadline {
        return Ok(None);
      }
      tokio::time::sleep(poll).await;
    }
  }
}

/// Take the profile, then sign in on it — all before a job exists. `Err` is
/// how the drive ends; there is no job to cancel, so `canceled` records why
/// the agent never got one.
async fn sign_in_before_enqueue(
  pre: &PreSignin<'_>,
  launcher: &dyn LaunchBrowser,
  launch: &BrowserLaunch,
  timing: &Timing,
  run: &mut AgentRun,
) -> std::result::Result<ProfileLock, AgentEnd> {
  let lock = match ProfileLock::acquire(&launch.user_data_dir, timing.queue_wait, timing.poll).await
  {
    Ok(Some(lock)) => lock,
    Ok(None) => {
      warn!(
        "  The profile {} stayed in use for {}s",
        launch.user_data_dir.display(),
        timing.queue_wait.as_secs()
      );
      run.canceled = Some("profile-wait");
      return Err(AgentEnd::TimedOut { phase: "queued" });
    }
    Err(error) => {
      run.canceled = Some("browser-failed");
      return Err(AgentEnd::BrowserFailed(format!("{error:#}")));
    }
  };
  if let Err(end) = pre_sign_in(pre, launcher, launch, run).await {
    run.canceled = Some(match &end {
      AgentEnd::SigninBlocked { blocker, .. } => SigninProvider::of_blocker(blocker).label(),
      _ => "browser-failed",
    });
    return Err(end);
  }
  Ok(lock)
}

// ===========================================================================
// Harness-post sink
// ===========================================================================

/// The sidecar's file name, written into [`HarnessSinkPlan::out_dir`] from
/// [`HARNESS_SINK_SOURCE`].
pub const HARNESS_SINK_SCRIPT: &str = "harness-sink.deno.ts";
/// The sidecar, embedded for the sign-in script's reason: the runner directory
/// a candidate ships is another tree, and the one that runs must be the one
/// this binary was reviewed with.
pub const HARNESS_SINK_SOURCE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../tento-ux-runner/harness-sink.deno.ts"
));
/// The one module the sidecar imports, at the relative path it imports it
/// from. The headless runner's `lib/browser.ts` answers the same posts with
/// the same code.
pub const HARNESS_SINK_LIB: &str = "lib/harness-sink.ts";
pub const HARNESS_SINK_LIB_SOURCE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../tento-ux-runner/lib/harness-sink.ts"
));
/// The prefix of the sidecar's stdout status lines.
pub const HARNESS_SINK_STATUS: &str = "harness-sink:";

/// Which session's posts the sidecar answers, and where they land.
#[derive(Clone, Debug)]
pub struct HarnessSinkPlan {
  pub session_id: String,
  /// The session dir the completion poll reads: `session.json`,
  /// `logs.ljson`, `complete.json`. The only files the sidecar may touch.
  pub run_dir: PathBuf,
  /// The corpus manifest's app domains, as the headless plan carries them.
  /// The drive adds the launch URL's host and its subdomains
  /// ([`Self::with_launch_host`]). The sidecar answers posts only on these
  /// hosts, and takes them (with CORS) only from a page on them.
  pub app_domains: Vec<String>,
  /// Where the sidecar is written, with its log.
  pub out_dir: PathBuf,
  /// The agent's work dir. The sidecar decides the run's result, so it
  /// refuses to start a deno that would load code from where the agent
  /// writes ([`deno_script_outside_workspace`]).
  pub workspace: PathBuf,
}

impl HarnessSinkPlan {
  /// This plan with the launch URL's host, and its subdomains, among the app
  /// domains unless they already are — so a corpus that declares no domains
  /// is scoped to the app it launched rather than to every host.
  pub fn with_launch_host(&self, launch_url: &str) -> Self {
    let mut plan = self.clone();
    if let Some(host) = url_host(launch_url) {
      if !owns_host(&plan.app_domains, &host) {
        plan.app_domains.push(host.clone());
      }
      let is_ip = host.parse::<std::net::IpAddr>().is_ok();
      if !is_ip && !owns_host(&plan.app_domains, &format!("x.{host}")) {
        plan.app_domains.push(format!("*.{host}"));
      }
    }
    plan
  }
}

/// `AppManifest::owns_host` over a bare list: `*.example.com` matches any
/// subdomain and not the apex; a bare entry matches itself.
fn owns_host(domains: &[String], host: &str) -> bool {
  let host = host.to_ascii_lowercase();
  domains.iter().any(|domain| {
    let domain = domain.to_ascii_lowercase();
    match domain.strip_prefix("*.") {
      Some(suffix) => host.ends_with(&format!(".{suffix}")),
      None => host == domain,
    }
  })
}

/// The lower-cased host of an absolute URL, without userinfo or port.
fn url_host(url: &str) -> Option<String> {
  let (_, rest) = url.split_once("://")?;
  let authority = rest.split(['/', '?', '#']).next()?;
  let authority = authority
    .rsplit_once('@')
    .map_or(authority, |(_, host)| host);
  let host = match authority.strip_prefix('[') {
    Some(v6) => v6.split(']').next()?,
    None => authority.split(':').next()?,
  };
  (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Starts the sidecar on a browser already answering DevTools; returns once it
/// is intercepting. A seam so the drive is testable without Deno or a browser.
#[async_trait]
pub trait StartHarnessSink: Send + Sync {
  async fn start(&self, devtools_port: u16, plan: &HarnessSinkPlan) -> Result<HarnessSinkGuard>;
}

/// The sink for one drive: what starts it, and what it answers for. `None` in
/// [`drive`] ⇒ the page origin keeps the session (the `local` profile).
pub struct HarnessSinkStart<'a> {
  pub starter: &'a dyn StartHarnessSink,
  pub plan: HarnessSinkPlan,
}

/// The running sidecar. Dropping it kills the process; [`Self::shutdown`]
/// asks it to exit first.
pub struct HarnessSinkGuard {
  child: Option<tokio::process::Child>,
}

impl HarnessSinkGuard {
  /// A guard with no process behind it: it never exits on its own.
  pub fn detached() -> Self {
    Self { child: None }
  }

  /// A guard over a running process — what a test uses to make one exit.
  pub fn from_child(child: tokio::process::Child) -> Self {
    Self { child: Some(child) }
  }

  /// Resolves when the sidecar exits on its own, with how it exited; never,
  /// for a detached guard.
  pub async fn exited(&mut self) -> String {
    match self.child.as_mut() {
      Some(child) => match child.wait().await {
        Ok(status) => status.to_string(),
        Err(error) => format!("wait failed: {error}"),
      },
      None => std::future::pending().await,
    }
  }

  /// SIGTERM, a short grace period, then SIGKILL.
  pub async fn shutdown(mut self) {
    let Some(child) = self.child.take() else {
      return;
    };
    if terminate(child, Duration::from_secs(5)).await {
      info!("  Harness sink stopped");
    } else {
      warn!("harness sink did not exit within 5s of SIGTERM; killed it");
    }
  }
}

impl Drop for HarnessSinkGuard {
  fn drop(&mut self) {
    if let Some(child) = self.child.as_mut() {
      let _ = child.start_kill();
    }
  }
}

/// The real sidecar: `deno run` of [`HARNESS_SINK_SOURCE`], no config, no
/// fetches, network only to the DevTools port, files only the three the
/// completion poll reads. It reads `logs.ljson` as well as writing it: the
/// page resends a batch whose reply it could not read, and a sidecar that
/// restarts mid-run seeds its de-duplication from the lines already there.
#[derive(Clone, Debug)]
pub struct DenoHarnessSink {
  pub deno: PathBuf,
  /// How long the sidecar may take to say `ready`.
  pub ready_within: Duration,
}

impl Default for DenoHarnessSink {
  fn default() -> Self {
    Self {
      deno: PathBuf::from("deno"),
      ready_within: Duration::from_secs(30),
    }
  }
}

impl DenoHarnessSink {
  /// The child's command line. `--no-config`: the sidecar imports nothing
  /// but its own `lib/harness-sink.ts`, so it needs no runner on this host.
  /// The environment is this process's, whole.
  pub fn command(&self, devtools_port: u16, plan: &HarnessSinkPlan) -> tokio::process::Command {
    self.command_with_env(devtools_port, plan, std::env::vars_os())
  }

  /// [`Self::command`] over an explicit environment: the child gets exactly
  /// `child_env`, so the env the layout check judges is the one it runs with.
  pub fn command_with_env(
    &self,
    devtools_port: u16,
    plan: &HarnessSinkPlan,
    child_env: impl IntoIterator<Item = (OsString, OsString)>,
  ) -> tokio::process::Command {
    let file = |name: &str| plan.run_dir.join(name).display().to_string();
    let mut command = tokio::process::Command::new(&self.deno);
    command
      .arg("run")
      .arg("--no-prompt")
      .arg("--cached-only")
      .arg("--no-config")
      .arg("--no-lock")
      .arg(format!("--allow-net=127.0.0.1:{devtools_port}"))
      .arg(format!(
        "--allow-read={},{}",
        file("session.json"),
        file("logs.ljson")
      ))
      .arg(format!(
        "--allow-write={},{},{}",
        file("session.json"),
        file("logs.ljson"),
        file("complete.json")
      ))
      .arg(plan.out_dir.join(HARNESS_SINK_SCRIPT))
      .arg(format!("http://127.0.0.1:{devtools_port}"))
      .arg(&plan.session_id)
      .arg(&plan.run_dir)
      .args(&plan.app_domains)
      .env_clear()
      .envs(child_env)
      .stdin(Stdio::null())
      .kill_on_drop(true);
    command
  }

  async fn spawn(&self, devtools_port: u16, plan: &HarnessSinkPlan) -> Result<HarnessSinkGuard> {
    self
      .spawn_with_env(devtools_port, plan, std::env::vars_os().collect())
      .await
  }

  /// [`Self::spawn`] over an explicit environment, the one the child gets.
  pub async fn spawn_with_env(
    &self,
    devtools_port: u16,
    plan: &HarnessSinkPlan,
    child_env: Vec<(OsString, OsString)>,
  ) -> Result<HarnessSinkGuard> {
    // OQ-1 (review O-5c): the sidecar writes the files that decide the
    // run's result, so nothing its deno loads may sit where the agent
    // writes. Checked before anything is written or spawned, over the very
    // environment the child gets.
    let harness_env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    deno_script_outside_workspace(
      &plan.workspace,
      &self.deno,
      &plan.out_dir,
      &child_env,
      &harness_env,
    )
    .map_err(|error| anyhow!("{HARNESS_SINK_STATUS} error {error:#}"))?;
    let lib = plan.out_dir.join(HARNESS_SINK_LIB);
    if let Some(dir) = lib.parent() {
      std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let script = plan.out_dir.join(HARNESS_SINK_SCRIPT);
    std::fs::write(&script, HARNESS_SINK_SOURCE)
      .with_context(|| format!("write {}", script.display()))?;
    std::fs::write(&lib, HARNESS_SINK_LIB_SOURCE)
      .with_context(|| format!("write {}", lib.display()))?;
    let log_path = plan.out_dir.join("harness-sink.log");
    let log =
      std::fs::File::create(&log_path).with_context(|| format!("create {}", log_path.display()))?;
    let log_err = log
      .try_clone()
      .context("clone the harness sink log handle")?;
    let child = self
      .command_with_env(devtools_port, plan, child_env)
      .stdout(Stdio::from(log))
      .stderr(Stdio::from(log_err))
      .spawn()
      .with_context(|| format!("spawn {} (is `deno` on PATH?)", self.deno.display()))?;
    let mut guard = HarnessSinkGuard::from_child(child);

    let deadline = Instant::now() + self.ready_within;
    loop {
      let log = std::fs::read_to_string(&log_path).unwrap_or_default();
      match sink_readiness(&log) {
        Some(Ok(())) => {
          info!(
            "  Harness posts are answered into {}",
            plan.run_dir.display()
          );
          return Ok(guard);
        }
        Some(Err(line)) => {
          guard.shutdown().await;
          return Err(anyhow!("{line} (see {})", log_path.display()));
        }
        None => {}
      }
      if let Some(child) = guard.child.as_mut()
        && let Ok(Some(status)) = child.try_wait()
      {
        guard.child = None;
        return Err(anyhow!(
          "{HARNESS_SINK_STATUS} error exited ({status}) before ready; see {}",
          log_path.display()
        ));
      }
      if Instant::now() >= deadline {
        guard.shutdown().await;
        return Err(anyhow!(
          "{HARNESS_SINK_STATUS} error not ready within {}s; see {}",
          self.ready_within.as_secs(),
          log_path.display()
        ));
      }
      tokio::time::sleep(Duration::from_millis(100)).await;
    }
  }
}

/// Whether the sidecar's log says it started: `Some(Ok)` once it printed
/// `ready` (answered posts may already follow it), `Some(Err(line))` when it
/// printed `error …` instead, `None` while it has said neither.
pub fn sink_readiness(log: &str) -> Option<std::result::Result<(), String>> {
  let ready = format!("{HARNESS_SINK_STATUS} ready");
  let error = format!("{HARNESS_SINK_STATUS} error");
  log.lines().map(str::trim).find_map(|line| {
    if line.starts_with(&ready) {
      Some(Ok(()))
    } else if line.starts_with(&error) {
      Some(Err(line.chars().take(240).collect()))
    } else {
      None
    }
  })
}

#[async_trait]
impl StartHarnessSink for DenoHarnessSink {
  async fn start(&self, devtools_port: u16, plan: &HarnessSinkPlan) -> Result<HarnessSinkGuard> {
    self.spawn(devtools_port, plan).await
  }
}

/// Resolves when the drive's sink exits on its own; never, without one.
async fn sink_exit(sink: &mut Option<HarnessSinkGuard>) -> String {
  match sink.as_mut() {
    Some(guard) => guard.exited().await,
    None => std::future::pending().await,
  }
}

// ===========================================================================
// The drive
// ===========================================================================

/// How long each phase may take.
#[derive(Clone, Debug)]
pub struct Timing {
  /// Queued → running.
  pub queue_wait: Duration,
  /// Running → the session completes or the job ends: the spec's timeout plus
  /// slack for the queue's own settle.
  pub run_budget: Duration,
  /// After the job ends with no completion: how long the harness may still be
  /// flushing a completion the agent posted just before it exited.
  pub completion_grace: Duration,
  /// After the session completes: how long the agent may take to finish its
  /// notes and its RESULT line before its job is cancelled.
  pub job_grace: Duration,
  pub poll: Duration,
}

impl Timing {
  pub fn for_spec(timeout_secs: u64, queue_wait: Option<Duration>) -> Self {
    let timeout = Duration::from_secs(timeout_secs);
    Self {
      queue_wait: queue_wait.unwrap_or(timeout),
      run_budget: timeout + Duration::from_secs(60),
      completion_grace: Duration::from_secs(20),
      job_grace: Duration::from_secs(120),
      poll: Duration::from_secs(1),
    }
  }
}

/// How an agent-driven run ended, before finalize judges it.
pub enum AgentEnd {
  /// The in-page harness completed the session — the one ending finalize can
  /// judge.
  SessionCompleted(SessionCompletionResult),
  /// The job ended and no completion followed.
  JobEnded,
  /// The job did not start, or did not finish, within its budget. It was
  /// cancelled. `queued` also covers a profile another run held for the whole
  /// wait, before the sign-in pre-step (no job was enqueued then).
  TimedOut { phase: &'static str },
  /// The browser could not be started. The job was cancelled.
  BrowserFailed(String),
  /// The queue refused the job or could not be reached.
  EnqueueFailed(String),
  /// The session ended some other way (the operator's Skip).
  SessionError(String),
  /// A sign-in pre-step (Google or Microsoft) did not sign in. No job was
  /// enqueued.
  SigninBlocked { blocker: String, line: String },
  /// The harness-post sink could not start on the agent's browser. The job was
  /// cancelled: its completion could only have been lost.
  HarnessSinkFailed(String),
  /// The harness-post sink exited while the agent drove (the browser went
  /// away, or the sidecar died). The job was cancelled.
  HarnessSinkExited(String),
}

impl AgentEnd {
  pub fn label(&self) -> &'static str {
    match self {
      Self::SessionCompleted(_) => "session-completed",
      Self::JobEnded => "job-ended",
      Self::TimedOut { .. } => "timeout",
      Self::BrowserFailed(_) => "browser-failed",
      Self::EnqueueFailed(_) => "enqueue-failed",
      Self::SessionError(_) => "session-error",
      Self::SigninBlocked { blocker, .. } => SigninProvider::of_blocker(blocker).label(),
      Self::HarnessSinkFailed(_) => "harness-sink-failed",
      Self::HarnessSinkExited(_) => "harness-sink-exited",
    }
  }
}

/// Everything the drive learned: the job, how it ended, and the agent's line.
pub struct AgentRun {
  pub queue: String,
  pub backend: &'static str,
  pub lane: String,
  pub job_id: Option<String>,
  /// The job as last read — its final state when it ended.
  pub job: Option<Job>,
  pub end: AgentEnd,
  /// Why this process cancelled the job, when it did — or, when the sign-in
  /// pre-step ended the run first, why it never enqueued one.
  pub canceled: Option<&'static str>,
  pub devtools_url: String,
  /// The sign-in pre-steps' status lines, one per line, when any ran.
  pub signin: Option<String>,
  /// The startup-crash retries those pre-steps took, in order.
  pub signin_retries: Vec<SigninRetry>,
  /// The harness-post sink's status, when the profile called for one.
  pub harness_sink: Option<String>,
}

/// Sign the profile in (when configured), enqueue the job, launch the browser
/// once it runs, and wait for the session or the job — whichever settles the
/// run. Never returns an error: every ending is an [`AgentEnd`], so the caller
/// always tears down and records.
#[allow(clippy::too_many_arguments)]
pub async fn drive(
  queue: &AgentQueue,
  job: NewJob,
  launcher: &dyn LaunchBrowser,
  launch: &BrowserLaunch,
  logger: &LLMLogger,
  port: &HostPort,
  session_id: &str,
  timing: &Timing,
  signin: Option<PreSignin<'_>>,
  sink: Option<HarnessSinkStart<'_>>,
) -> AgentRun {
  let mut run = AgentRun {
    queue: queue.queue_name().to_string(),
    backend: queue.backend_name(),
    lane: job.lane.clone(),
    job_id: None,
    job: None,
    end: AgentEnd::JobEnded,
    canceled: None,
    devtools_url: launch.devtools_url(),
    signin: None,
    signin_retries: Vec::new(),
    harness_sink: None,
  };

  // The sign-in pre-step, BEFORE the job exists: its browser listens on an
  // unauthenticated loopback DevTools port while Google's password page is
  // open, and no agent may be running then. The profile lock stands in for
  // the lane's `max-running 1` and is held until this drive returns, after
  // the agent's browser has closed.
  let _profile_lock = match &signin {
    None => None,
    Some(pre) => match sign_in_before_enqueue(pre, launcher, launch, timing, &mut run).await {
      Ok(lock) => Some(lock),
      Err(end) => {
        run.end = end;
        return run;
      }
    },
  };

  let enqueued = match queue.enqueue(job).await {
    Ok(enqueued) => enqueued,
    Err(error) => {
      run.end = AgentEnd::EnqueueFailed(format!("{error:#}"));
      return run;
    }
  };
  let id = enqueued.job.id.clone();
  info!(
    "  Enqueued agent job {id} (queue {}, lane {}, {} backend){}",
    run.queue,
    run.lane,
    run.backend,
    if enqueued.duplicate {
      " — already enqueued for this session"
    } else {
      ""
    }
  );
  run.job_id = Some(id.clone());
  run.job = Some(enqueued.job);

  // Queued → running. The lane runs one browser at a time, so this can be a
  // real wait in a batch.
  let started = match wait_until(queue, &id, timing.queue_wait, timing.poll, |state| {
    !matches!(state, JobState::Queued | JobState::RetryWait)
  })
  .await
  {
    Some(job) => job,
    None => {
      cancel(queue, &id, CancelReason::Timeout, &mut run, "queue-wait").await;
      run.end = AgentEnd::TimedOut { phase: "queued" };
      return settle(queue, run).await;
    }
  };
  let started_terminal = started.state.is_terminal();
  run.job = Some(started);
  if started_terminal {
    // Ended before this process saw it run: an operator cancel, a refused
    // lane, an agent that exited at once. The browser never opened here, but
    // the session is the verdict's source, so read it rather than assume.
    let grace = timing.completion_grace.as_secs().max(1);
    run.end = match await_session_completion(logger, port, session_id, grace).await {
      Ok(completed) => AgentEnd::SessionCompleted(completed),
      Err(_) => AgentEnd::JobEnded,
    };
    return run;
  }

  // The browser opens blank. LAUNCH_URL is opened below, alone, once any
  // harness sink is intercepting — so the app's first harness post cannot race
  // past the sink, and the agent finds one tab, this run's.
  let blank = BrowserLaunch {
    url: "about:blank".to_string(),
    ..launch.clone()
  };
  let browser = match launcher.launch(&blank).await {
    Ok(browser) => browser,
    Err(error) => {
      cancel(
        queue,
        &id,
        CancelReason::Operator,
        &mut run,
        "browser-failed",
      )
      .await;
      run.end = AgentEnd::BrowserFailed(format!("{error:#}"));
      return settle(queue, run).await;
    }
  };

  let mut harness_sink = None;
  if let Some(start) = &sink {
    let plan = start.plan.with_launch_host(&launch.url);
    match start.starter.start(launch.devtools_port, &plan).await {
      Ok(guard) => {
        run.harness_sink = Some(format!(
          "{HARNESS_SINK_STATUS} ready ({})",
          start.plan.out_dir.display()
        ));
        harness_sink = Some(guard);
      }
      Err(error) => {
        let line = format!("{error:#}");
        warn!("  {line}");
        run.harness_sink = Some(line.clone());
        cancel(queue, &id, CancelReason::Operator, &mut run, "harness-sink").await;
        browser.shutdown().await;
        run.end = AgentEnd::HarnessSinkFailed(line);
        return settle(queue, run).await;
      }
    }
  }

  if let Err(error) = browser.open_alone(&launch.url).await {
    cancel(
      queue,
      &id,
      CancelReason::Operator,
      &mut run,
      "browser-failed",
    )
    .await;
    browser.shutdown().await;
    if let Some(guard) = harness_sink {
      guard.shutdown().await;
    }
    run.end = AgentEnd::BrowserFailed(format!("open the launch URL: {error:#}"));
    return settle(queue, run).await;
  }

  let budget_secs = timing.run_budget.as_secs().max(1);
  let running_since = Instant::now();
  let completion = await_session_completion(logger, port, session_id, budget_secs);
  let terminal = wait_until(
    queue,
    &id,
    timing.run_budget,
    timing.poll,
    JobState::is_terminal,
  );
  tokio::pin!(completion, terminal);
  run.end = tokio::select! {
    completed = &mut completion => match completed {
      Ok(completed) => AgentEnd::SessionCompleted(completed),
      Err(_) if running_since.elapsed() >= timing.run_budget => AgentEnd::TimedOut { phase: "running" },
      Err(error) => AgentEnd::SessionError(format!("{error:#}")),
    },
    ended = &mut terminal => match ended {
      Some(job) => {
        run.job = Some(job);
        // The agent may have completed the harness a moment before its turn
        // ended; give the completion a short window to land.
        let grace = timing.completion_grace.as_secs().max(1);
        match await_session_completion(logger, port, session_id, grace).await {
          Ok(completed) => AgentEnd::SessionCompleted(completed),
          Err(_) => AgentEnd::JobEnded,
        }
      }
      None => AgentEnd::TimedOut { phase: "running" },
    },
    exit = sink_exit(&mut harness_sink) => {
      let line = format!("{HARNESS_SINK_STATUS} exited while the agent drove ({exit})");
      warn!("  {line}");
      run.harness_sink = Some(line.clone());
      AgentEnd::HarnessSinkExited(line)
    },
  };

  match &run.end {
    AgentEnd::SessionCompleted(_) => {
      // The run is decided; the agent is only writing its notes now.
      let ended = wait_until(
        queue,
        &id,
        timing.job_grace,
        timing.poll,
        JobState::is_terminal,
      )
      .await;
      match ended {
        Some(job) => run.job = Some(job),
        None => {
          cancel(
            queue,
            &id,
            CancelReason::Operator,
            &mut run,
            "after-completion",
          )
          .await
        }
      }
    }
    AgentEnd::TimedOut { .. } => {
      cancel(queue, &id, CancelReason::Timeout, &mut run, "timeout").await;
    }
    AgentEnd::SessionError(_) => {
      cancel(
        queue,
        &id,
        CancelReason::Operator,
        &mut run,
        "session-ended",
      )
      .await;
    }
    AgentEnd::HarnessSinkExited(_) => {
      cancel(queue, &id, CancelReason::Operator, &mut run, "harness-sink").await;
    }
    _ => {}
  }
  browser.shutdown().await;
  // After the browser: a post the page sent while closing is still answered.
  if let Some(guard) = harness_sink {
    guard.shutdown().await;
  }
  settle(queue, run).await
}

/// Poll the job until `done(state)` or `within` elapses. A transport error is
/// retried until the deadline: the queue being briefly unreachable is not the
/// job ending.
async fn wait_until(
  queue: &AgentQueue,
  id: &str,
  within: Duration,
  poll: Duration,
  done: impl Fn(JobState) -> bool,
) -> Option<Job> {
  let deadline = Instant::now() + within;
  loop {
    match queue.show(id).await {
      Ok(job) if done(job.state) => return Some(job),
      Ok(_) => {}
      Err(error) => warn!("reading agent job {id}: {error:#}"),
    }
    if Instant::now() >= deadline {
      return None;
    }
    tokio::time::sleep(poll).await;
  }
}

/// Cancel the job, recording why. A cancel that is refused because the job
/// already finished is not an error.
async fn cancel(
  queue: &AgentQueue,
  id: &str,
  reason: CancelReason,
  run: &mut AgentRun,
  why: &'static str,
) {
  info!("  Cancelling agent job {id} ({why})");
  match queue
    .backend_handle()
    .cancel(queue.queue_name(), id, reason)
    .await
  {
    Ok(job) => {
      run.job = Some(job);
      run.canceled = Some(why);
    }
    Err(error) => warn!("cancel agent job {id}: {error:#}"),
  }
}

/// Read the job one last time, for the record.
async fn settle(queue: &AgentQueue, mut run: AgentRun) -> AgentRun {
  if let Some(id) = run.job_id.clone()
    && let Ok(job) = queue.show(&id).await
  {
    run.job = Some(job);
  }
  run
}

// ===========================================================================
// The agent's RESULT line
// ===========================================================================

/// What the agent said about its own run, parsed from its `RESULT` line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultLine {
  pub line: String,
  /// `completed`, `product-failure` or `unfinished`.
  pub kind: String,
  /// The blocker slug of an `unfinished` line.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub blocker: Option<String>,
}

impl ResultLine {
  pub fn parse(line: &str) -> Option<Self> {
    let line = line.trim().trim_matches('`').trim();
    let mut words = line.split_whitespace();
    if words.next()? != "RESULT" {
      return None;
    }
    let _spec = words.next()?;
    let kind = words.next()?.to_string();
    let blocker = (kind == "unfinished")
      .then(|| words.next().map(str::to_string))
      .flatten();
    Some(Self {
      line: line.to_string(),
      kind,
      blocker,
    })
  }

  /// The last `RESULT` line in a block of text.
  pub fn last_in(text: &str) -> Option<Self> {
    text.lines().rev().find_map(Self::parse)
  }
}

/// The agent's `RESULT` line: from the attempt's raw final message first (the
/// queue decodes the first JSON value out of a result, which can hide a
/// trailing line), then the decoded result, then `WORK_DIR/RESULT`.
pub fn result_line(job: Option<&Job>, work_dir: &Path) -> Option<ResultLine> {
  let texts = job.into_iter().flat_map(|job| {
    let raw = job.attempts.iter().rev().filter_map(|attempt| {
      attempt
        .outcome
        .as_ref()
        .and_then(|outcome| outcome.pointer("/record/value"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
    });
    let decoded = job.result.as_ref().and_then(|result| match &result.value {
      serde_json::Value::String(text) => Some(text.clone()),
      serde_json::Value::Object(object) => object
        .get("result")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string),
      _ => None,
    });
    raw.chain(decoded).collect::<Vec<_>>()
  });
  texts
    .into_iter()
    .find_map(|text| ResultLine::last_in(&text))
    .or_else(|| {
      std::fs::read_to_string(work_dir.join("RESULT"))
        .ok()
        .and_then(|text| ResultLine::last_in(&text))
    })
}

// ===========================================================================
// agent.json
// ===========================================================================

/// `agent.json` — the job behind an agent-driven run, beside its verdict.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
  #[serde(rename = "type")]
  pub kind: &'static str,
  pub queue: String,
  pub backend: &'static str,
  pub lane: String,
  pub job_id: Option<String>,
  /// The job's final state as last read (`succeeded`, `failed`, `canceled`, …).
  pub state: Option<JobState>,
  pub error: Option<tento_agent_queue::JobError>,
  /// The tsh sessions that carried the attempts — the transcripts.
  pub attempt_sessions: Vec<String>,
  /// How the drive ended: `session-completed`, `job-ended`, `timeout`, …
  pub end: &'static str,
  /// Why this process cancelled the job, when it did — or, when the sign-in
  /// pre-step ended the run first, why it never enqueued one.
  pub canceled: Option<&'static str>,
  pub result: Option<ResultLine>,
  /// The verification outcome finalize wrote, when it ran.
  pub verification: Option<crate::folder::VerificationOutcome>,
  /// The one-line reason the run did or did not pass.
  pub reason: String,
  pub devtools_url: String,
  pub work_dir: PathBuf,
  /// The Google sign-in pre-step's status line — never anything it was given.
  /// Absent when no pre-step is configured.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub google_signin: Option<String>,
  /// The Microsoft sign-in pre-step's status line, likewise.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub microsoft_signin: Option<String>,
  /// Each sign-in pre-step retry after deno died at startup ([`SigninRetry`]):
  /// a run that passed only on a retry says so here. Absent when none.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub signin_retries: Vec<SigninRetry>,
  /// The harness-post sink's status. Absent when the page origin keeps the
  /// session (the `local` profile).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub harness_sink: Option<String>,
  /// One audit line per `fill_secret` request (`secret-fill <name> <origin>
  /// <run id>`, or `secret-fill-refused …`) — never a value. Absent when the
  /// agent asked for none.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub secret_fills: Vec<String>,
}

pub const AGENT_RECORD_TYPE: &str = "ux-test.agent-run/v1";

/// `provider`'s status line out of the pre-steps' lines.
fn signin_line(lines: Option<&str>, provider: SigninProvider) -> Option<String> {
  lines?
    .lines()
    .find(|line| line.starts_with(provider.status()))
    .map(str::to_string)
}

impl AgentRecord {
  /// `end` is passed rather than read off `run`, because the caller has by
  /// then taken the completion out of `run.end` to finalize it.
  pub fn new(
    run: &AgentRun,
    end: &'static str,
    result: Option<ResultLine>,
    verification: Option<crate::folder::VerificationOutcome>,
    reason: String,
    work_dir: &Path,
  ) -> Self {
    Self {
      kind: AGENT_RECORD_TYPE,
      queue: run.queue.clone(),
      backend: run.backend,
      lane: run.lane.clone(),
      job_id: run.job_id.clone(),
      state: run.job.as_ref().map(|job| job.state),
      error: run.job.as_ref().and_then(|job| job.error.clone()),
      attempt_sessions: run
        .job
        .as_ref()
        .map(|job| {
          job
            .attempts
            .iter()
            .filter_map(|attempt| attempt.session_id.clone())
            .collect()
        })
        .unwrap_or_default(),
      end,
      canceled: run.canceled,
      result,
      verification,
      reason,
      devtools_url: run.devtools_url.clone(),
      work_dir: work_dir.to_path_buf(),
      google_signin: signin_line(run.signin.as_deref(), SigninProvider::Google),
      microsoft_signin: signin_line(run.signin.as_deref(), SigninProvider::Microsoft),
      signin_retries: run.signin_retries.clone(),
      harness_sink: run.harness_sink.clone(),
      secret_fills: Vec::new(),
    }
  }

  pub fn write(&self, run_dir: &Path) -> Result<PathBuf> {
    let path = run_dir.join(AGENT_RECORD);
    let mut body = serde_json::to_string_pretty(self).context("serialise agent.json")?;
    body.push('\n');
    std::fs::write(&path, body).with_context(|| format!("write {}", path.display()))?;
    Ok(path)
  }
}

/// A fresh scratch dir for a test that plants a fake deno, runner or cache.
/// It sits in the target dir (`<target>/<profile>/ux-test-scratch/`, as
/// cargo's own `CARGO_TARGET_TMPDIR` does), not under a temp dir: the deno
/// layout check refuses anything under `/tmp`, `$TMPDIR` and their kin. The
/// caller removes it.
#[cfg(test)]
pub(crate) fn test_scratch_dir(label: &str) -> PathBuf {
  let exe = std::env::current_exe().expect("the test binary's path");
  let profile = exe
    .parent()
    .and_then(Path::parent)
    .expect("the test binary sits in <target>/<profile>/deps");
  let dir = profile.join("ux-test-scratch").join(format!(
    "{label}-{}-{}",
    std::process::id(),
    rand::random::<u32>()
  ));
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::Value;
  use std::sync::{Arc, Mutex};

  fn spec(yaml: &str) -> TestSpec {
    TestSpec::from_yaml(yaml).expect("fixture spec parses")
  }

  pub(crate) const MANUAL_SPEC: &str = "id: consent\nname: Consent\ntimeout: 60\nsteps:\n  - id: drive\n    \
    instruction: do\n    actions:\n      - action: wait\n        ms: 10\n  - id: sign-in\n    \
    instruction: sign in\n    manual: true\n    manual_reason: third-party consent screen\n\
    verification:\n  required_logs:\n    - pattern: x\n";

  const AUTOMATABLE_SPEC: &str = "id: plain\nname: Plain\nsteps:\n  - id: drive\n    \
    instruction: do\n    actions:\n      - action: wait\n        ms: 10\n\
    verification:\n  required_logs:\n    - pattern: x\n";

  #[test]
  fn only_a_configured_lane_and_a_manual_step_make_a_run_agent_driven() {
    let manual = spec(MANUAL_SPEC);
    let plain = spec(AUTOMATABLE_SPEC);
    assert!(drives(true, &manual, Some("ux-browser")));
    // No lane: today's headless path, exactly.
    assert!(!drives(true, &manual, None));
    // Nothing manual: the headless runner is the faster driver.
    assert!(!drives(true, &plain, Some("ux-browser")));
    // Not --auto: an operator drives.
    assert!(!drives(false, &manual, Some("ux-browser")));
  }

  #[test]
  fn an_empty_lane_is_no_lane() {
    assert_eq!(lane_from(None), None);
    assert_eq!(lane_from(Some("  ".into())), None);
    assert_eq!(
      lane_from(Some(" ux-browser \n".into())),
      Some("ux-browser".into())
    );
  }

  #[test]
  fn the_prompt_names_every_fact_and_leaves_no_placeholder() {
    let prompt = render_prompt(&PromptInputs {
      spec_id: "consent".into(),
      spec_path: "/runs/s1/spec.yaml".into(),
      session_id: "2026-09-26_consent_abc123".into(),
      env: "rc".into(),
      target_origin: "https://rc.example.test".into(),
      launch_url: "https://rc.example.test/signin?ux=s1&tid=t1".into(),
      devtools_url: "http://127.0.0.1:9333".into(),
      account: Some("tester@example.test".into()),
      run_dir: "/runs/s1".into(),
      work_dir: "/runs/s1/agent".into(),
      runner_dir: Some("/opt/ux-runner".into()),
      timeout_secs: 900,
      fill_secret: Some("tester.google-password".into()),
    });
    assert!(!prompt.contains("{{"), "unfilled placeholder in:\n{prompt}");
    assert!(
      prompt.contains("never `fullPage: true`"),
      "the driver is told to keep mid-flow screenshots to the viewport"
    );
    for fact in [
      "SPEC_ID: consent",
      "SESSION_ID: 2026-09-26_consent_abc123",
      "LAUNCH_URL: https://rc.example.test/signin?ux=s1&tid=t1",
      "DEVTOOLS: http://127.0.0.1:9333",
      "ACCOUNT: tester@example.test",
      "WORK_DIR: /runs/s1/agent",
      "TIMEOUT_SECS: 900",
      "RUNNER_DIR: /opt/ux-runner",
    ] {
      assert!(prompt.contains(fact), "missing {fact:?}");
    }
    // The hard rules ride every prompt.
    assert!(prompt.contains("Never type, print or look for a password"));
    assert!(prompt.contains("Never override the user agent"));
    assert!(prompt.contains("window.__lonaUxComplete(\"success\")"));
    assert!(prompt.contains("RESULT SPEC_ID completed SESSION_ID"));
    // A Google password page is the harness's to fill, by name, through the
    // workspace; every other challenge still stops the run.
    assert!(prompt.contains("FILL_SECRET: tester.google-password"));
    assert!(prompt.contains("fill-secret-1.request"));
    assert!(prompt.contains("{\"secret\": \"FILL_SECRET\"}"));
    assert!(prompt.contains("Never read the value of a password field"));
    for challenge in ["phone number", "SMS code", "\"tap yes\""] {
      assert!(prompt.contains(challenge), "missing {challenge:?}");
    }
    assert!(prompt.contains("unfinished needs-human"));
  }

  #[test]
  fn an_account_with_no_fillable_secret_is_told_so() {
    let prompt = render_prompt(&PromptInputs {
      spec_id: "consent".into(),
      spec_path: "/runs/s1/spec.yaml".into(),
      session_id: "s1".into(),
      env: "dev".into(),
      target_origin: "https://dev.example.test".into(),
      launch_url: "https://dev.example.test/signin".into(),
      devtools_url: "http://127.0.0.1:9333".into(),
      account: Some("someone@example.test".into()),
      run_dir: "/runs/s1".into(),
      work_dir: "/runs/s1/agent".into(),
      runner_dir: None,
      timeout_secs: 60,
      fill_secret: None,
    });
    assert!(prompt.contains("FILL_SECRET: none for this account"));
  }

  #[test]
  fn the_job_is_one_attempt_in_the_lane_bounded_by_the_spec() {
    let job = new_job(
      "ux-browser",
      "p".into(),
      &spec(MANUAL_SPEC),
      "s1",
      Path::new("/runs/s1/agent"),
      Some(Path::new("/opt/ux-runner/deno.json")),
    );
    assert_eq!(job.lane, "ux-browser");
    assert_eq!(job.kind, tento_agent_queue::JobKind::Agent);
    assert_eq!(job.policy.max_attempts, 1);
    assert_eq!(job.policy.timeout_ms, Some(60_000));
    assert_eq!(job.producer_id.as_deref(), Some(PRODUCER));
    assert_eq!(job.request_id.as_deref(), Some("s1"));
    // The workspace is the job's; the harness and permissions are the host's.
    assert_eq!(job.agent.cwd.as_deref(), Some("/runs/s1/agent"));
    assert_eq!(job.agent.handler, None);
    assert_eq!(job.agent.permissions, None);
    assert_eq!(
      job.agent.env.get(DENO_CONFIG_ENV).map(String::as_str),
      Some("/opt/ux-runner/deno.json")
    );
  }

  #[test]
  fn result_lines_parse_and_the_last_one_wins() {
    let text = "notes...\nRESULT consent unfinished needs-human google asked for a password\n";
    let line = ResultLine::last_in(text).unwrap();
    assert_eq!(line.kind, "unfinished");
    assert_eq!(line.blocker.as_deref(), Some("needs-human"));

    let text = "RESULT consent unfinished x\n`RESULT consent completed s1`";
    let line = ResultLine::last_in(text).unwrap();
    assert_eq!(line.kind, "completed");
    assert_eq!(line.blocker, None);
    assert_eq!(line.line, "RESULT consent completed s1");
    assert_eq!(ResultLine::last_in("no result here"), None);
  }

  #[test]
  fn the_result_line_is_read_from_the_raw_attempt_before_the_decoded_value() {
    let job: Job = serde_json::from_value(serde_json::json!({
      "id": "j1", "state": "succeeded",
      // The queue decoded a JSON object out of the message and lost the line.
      "result": {"datatype": "tsh.value/v1", "value": {"ok": true}, "parsed": true},
      "attempts": [{"n": 1, "outcome": {"ok": true, "record": {
        "ok": true, "value": "{\"ok\": true}\nRESULT consent completed s1"}}}]
    }))
    .unwrap();
    let dir = std::env::temp_dir();
    assert_eq!(result_line(Some(&job), &dir).unwrap().kind, "completed");
  }

  #[test]
  fn a_full_chrome_is_told_to_be_headless_and_a_shell_is_not() {
    let full = browser_args(
      Path::new("/x/Google Chrome"),
      Resolver::Public,
      false,
      "rc.example.test",
      &[],
    );
    assert!(full.contains(&"--headless=new".to_string()));
    assert!(
      !full
        .iter()
        .any(|arg| arg.starts_with("--host-resolver-rules"))
    );
    assert!(!full.iter().any(|arg| arg.contains("user-agent")));
    // The profile's cookies are sealed with the mock keychain's key.
    assert!(full.contains(&"--use-mock-keychain".to_string()));
    // A per-script connect() must not wait on a bfcached iframe target, and
    // the DNS features stay in the same (only) --disable-features flag.
    let disabled: Vec<&String> = full
      .iter()
      .filter(|arg| arg.starts_with("--disable-features="))
      .collect();
    assert_eq!(disabled.len(), 1);
    assert!(disabled[0].contains("BackForwardCache"));
    assert!(disabled[0].contains("DnsOverHttps"));
    let shell = browser_args(
      Path::new("/x/chrome-headless-shell"),
      Resolver::Loopback,
      false,
      "dev.example.test",
      &["*.example.test".to_string()],
    );
    assert!(!shell.contains(&"--headless=new".to_string()));
    assert!(
      shell.contains(
        &"--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP dev.example.test 127.0.0.1"
          .to_string()
      )
    );
    assert!(shell.contains(&"--ignore-certificate-errors".to_string()));
  }

  fn resolver_rules(args: &[String]) -> Vec<&String> {
    args
      .iter()
      .filter(|arg| arg.starts_with("--host-resolver-rules"))
      .collect()
  }

  #[test]
  fn a_resolve_address_pins_the_apps_hosts_as_the_headless_runner_does() {
    let chrome = Path::new("/x/Google Chrome");
    let domains = ["*.example.test".to_string()];
    // Unset: the reader adds nothing of its own, a public profile maps nothing
    // and a loopback one keeps its single 127.0.0.1 rule.
    if resolve_ip_from(std::env::var(RESOLVE_IP_ENV).ok()).is_none() {
      for resolver in [Resolver::Public, Resolver::Loopback] {
        assert_eq!(
          browser_args(chrome, resolver, false, "dev.example.test", &domains),
          browser_args_resolving(chrome, resolver, false, "dev.example.test", &domains, None),
        );
      }
    }
    let public_unset = browser_args_resolving(
      chrome,
      Resolver::Public,
      false,
      "dev.example.test",
      &domains,
      None,
    );
    assert!(resolver_rules(&public_unset).is_empty());
    let loopback_unset = browser_args_resolving(
      chrome,
      Resolver::Loopback,
      false,
      "dev.example.test",
      &domains,
      None,
    );
    assert_eq!(
      resolver_rules(&loopback_unset),
      vec![
        &"--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP dev.example.test 127.0.0.1"
          .to_string()
      ]
    );

    // Set: one rule, the manifest's patterns then the run's host, at the address.
    let public = browser_args_resolving(
      chrome,
      Resolver::Public,
      false,
      "dev.example.test",
      &domains,
      Some("192.0.2.7"),
    );
    assert_eq!(
      resolver_rules(&public),
      vec![
        &"--host-resolver-rules=MAP *.example.test 192.0.2.7, MAP dev.example.test 192.0.2.7"
          .to_string()
      ]
    );
    // A public target keeps its certificate checks.
    assert!(!public.contains(&"--ignore-certificate-errors".to_string()));
    // Nothing else moves.
    let mut without_rule = public.clone();
    without_rule.retain(|arg| !arg.starts_with("--host-resolver-rules"));
    assert_eq!(without_rule, public_unset);

    // Loopback: unset is the 127.0.0.1 rule, as before; set replaces the
    // address and still emits one rule.
    let loopback = browser_args_resolving(
      chrome,
      Resolver::Loopback,
      false,
      "dev.example.test",
      &domains,
      Some("192.0.2.7"),
    );
    assert_eq!(
      resolver_rules(&loopback),
      vec![
        &"--host-resolver-rules=MAP *.example.test 192.0.2.7, MAP dev.example.test 192.0.2.7"
          .to_string()
      ]
    );
    assert!(loopback.contains(&"--ignore-certificate-errors".to_string()));

    assert_eq!(resolve_ip_from(None), None);
    assert_eq!(resolve_ip_from(Some("  ".into())), None);
    assert_eq!(
      resolve_ip_from(Some(" 192.0.2.7\n".into())).as_deref(),
      Some("192.0.2.7")
    );
  }

  #[test]
  fn the_launch_url_carries_a_loopback_port_and_keeps_its_own() {
    assert_eq!(
      with_port("https://dev.example.test/a?ux=1", Some("8443")),
      "https://dev.example.test:8443/a?ux=1"
    );
    assert_eq!(
      with_port("https://dev.example.test:9/a", Some("8443")),
      "https://dev.example.test:9/a"
    );
    assert_eq!(
      with_port("https://rc.example.test/a", None),
      "https://rc.example.test/a"
    );
  }

  /// The real launcher against a real browser: DevTools answers on the port
  /// the prompt names, and shutdown leaves nothing listening. Needs a browser:
  /// `PUPPETEER_EXECUTABLE_PATH=… cargo test -p tento-ux-test -- --ignored real_browser`.
  #[tokio::test]
  #[ignore = "launches the browser named by PUPPETEER_EXECUTABLE_PATH"]
  async fn a_real_browser_answers_devtools_and_closes() {
    let browser = PathBuf::from(std::env::var(BROWSER_ENV).expect("PUPPETEER_EXECUTABLE_PATH"));
    let work = std::env::temp_dir().join(format!("ux-agent-browser-{}", std::process::id()));
    std::fs::create_dir_all(&work).unwrap();
    let port = free_loopback_port().unwrap();
    let launch = BrowserLaunch {
      args: browser_args(&browser, Resolver::Public, false, "example.test", &[]),
      executable: browser,
      user_data_dir: work.join("profile"),
      url: "about:blank".into(),
      devtools_port: port,
      log_path: work.join("browser.log"),
      ready_within: Duration::from_secs(120),
    };
    let guard = ChromeLauncher
      .launch(&launch)
      .await
      .expect("browser starts");
    assert!(devtools_answers(port).await);
    // One tab, at the URL asked for, byte for byte.
    let url = "data:text/html,<title>ux%20a&b</title>";
    assert_eq!(guard.open_alone(url).await.unwrap(), 1);
    let pages: Vec<DevtoolsTarget> =
      serde_json::from_str(&devtools_http(port, "GET", "/json/list").await.unwrap()).unwrap();
    let pages: Vec<_> = pages.into_iter().filter(|t| t.kind == "page").collect();
    assert_eq!(pages.len(), 1, "{pages:?}");
    assert_eq!(pages[0].url, url);
    guard.shutdown().await;
    assert!(
      !devtools_answers(port).await,
      "DevTools still answering after shutdown"
    );
    let _ = std::fs::remove_dir_all(&work);
  }

  #[test]
  fn the_config_needs_a_browser_and_reads_whole_seconds() {
    assert!(AgentConfig::resolve("l".into(), None, None, None).is_err());
    let exe = std::env::current_exe().unwrap().display().to_string();
    let config = AgentConfig::resolve(
      "l".into(),
      Some(exe.clone()),
      Some(" ".into()),
      Some("90".into()),
    )
    .unwrap();
    assert_eq!(config.user_data_dir, None);
    assert_eq!(config.queue_wait, Some(Duration::from_secs(90)));
    assert!(AgentConfig::resolve("l".into(), Some(exe), None, Some("soon".into())).is_err());
  }

  /// A fake password, in a 0600 temp file that is removed on drop.
  struct FakeSecret {
    dir: PathBuf,
    file: PathBuf,
  }

  const FAKE_PASSWORD: &str = "fake-pw-7c1e not-a-real-secret";

  impl FakeSecret {
    fn new(contents: &str) -> Self {
      use std::os::unix::fs::PermissionsExt;
      // Not under a temp dir: its fake deno and runner must pass the layout
      // check. The runner is `runner/`, so the work dir is not inside it.
      let dir = test_scratch_dir("ux-google-signin");
      std::fs::create_dir_all(dir.join("runner")).unwrap();
      let file = dir.join("password");
      std::fs::write(&file, contents).unwrap();
      std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
      Self { dir, file }
    }

    /// The agent's work dir for a pre-step under test: beside the fake
    /// deno and runner (`runner/deno.json`), never containing them nor inside
    /// them (review L10 Z3).
    fn workspace(&self) -> PathBuf {
      let workspace = self.dir.join("agent");
      std::fs::create_dir_all(&workspace).unwrap();
      workspace
    }
  }

  impl Drop for FakeSecret {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.dir);
    }
  }

  #[test]
  fn no_password_file_is_no_pre_step_and_a_file_needs_an_account_and_0600() {
    // Unset or empty: exactly today's run.
    assert_eq!(
      SigninConfig::resolve(SigninProvider::Google, None, None).unwrap(),
      None
    );
    assert_eq!(
      SigninConfig::resolve(
        SigninProvider::Google,
        Some(" ".into()),
        Some("a@example.test".into())
      )
      .unwrap(),
      None
    );
    let secret = FakeSecret::new(FAKE_PASSWORD);
    let path = secret.file.display().to_string();
    // A password is never guessed onto an account.
    assert!(SigninConfig::resolve(SigninProvider::Google, Some(path.clone()), None).is_err());
    let config = SigninConfig::resolve(
      SigninProvider::Google,
      Some(path.clone()),
      Some(" a@example.test ".into()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(config.account, "a@example.test");
    assert_eq!(config.password_file, secret.file);
    // Readable by the group or the world: refused.
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(&secret.file, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    let error = SigninConfig::resolve(
      SigninProvider::Google,
      Some(path),
      Some("a@example.test".into()),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("0600"), "{error}");
    assert!(!error.contains(FAKE_PASSWORD));
    assert!(
      SigninConfig::resolve(
        SigninProvider::Google,
        Some("/nonexistent/pw".into()),
        Some("a@example.test".into())
      )
      .is_err()
    );
  }

  #[test]
  fn the_status_line_decides_proceed_or_unfinished() {
    let proceed = |line: &str| SigninOutcome::Proceed { line: line.into() };
    let blocked = |blocker: &str, line: &str| SigninOutcome::Blocked {
      blocker: blocker.into(),
      line: line.into(),
    };
    assert_eq!(
      signin_outcome(Some(0), "noise\ngoogle-signin: already-signed-in\n"),
      proceed("google-signin: already-signed-in")
    );
    assert_eq!(
      signin_outcome(Some(0), "google-signin: signed-in"),
      proceed("google-signin: signed-in")
    );
    assert_eq!(
      signin_outcome(Some(3), "google-signin: needs-human challenge-totp\n"),
      blocked(
        "google-signin-needs-human",
        "google-signin: needs-human challenge-totp"
      )
    );
    assert_eq!(
      signin_outcome(
        Some(1),
        "google-signin: timeout password accounts.google.com/x"
      ),
      blocked(
        "google-signin-timeout",
        "google-signin: timeout password accounts.google.com/x"
      )
    );
    assert_eq!(
      signin_outcome(Some(1), "google-signin: error connect ECONNREFUSED"),
      blocked(
        "google-signin-error",
        "google-signin: error connect ECONNREFUSED"
      )
    );
    // A success word is not a success without exit 0.
    assert_eq!(
      signin_outcome(Some(1), "google-signin: signed-in"),
      blocked("google-signin-error", "google-signin: signed-in")
    );
    assert_eq!(
      signin_outcome(None, ""),
      blocked(
        "google-signin-no-status",
        "google-signin: no-status (exit a signal)"
      )
    );
    // The last status line wins.
    assert_eq!(
      signin_outcome(
        Some(3),
        "google-signin: signed-in\ngoogle-signin: needs-human wrong-account"
      ),
      blocked(
        "google-signin-needs-human",
        "google-signin: needs-human wrong-account"
      )
    );
  }

  fn signer(secret: &FakeSecret, deno: PathBuf, config: PathBuf) -> DenoGoogleSignin {
    DenoGoogleSignin {
      provider: SigninProvider::Google,
      deno,
      deno_config: Some(config),
      account: "tester@example.test".into(),
      password_file: secret.file.clone(),
      app_url: None,
      timeout: Duration::from_secs(20),
    }
  }

  #[test]
  fn the_password_is_never_in_the_command_line_or_its_environment() {
    let secret = FakeSecret::new(&format!("{FAKE_PASSWORD}\n"));
    let out = secret.dir.join("out");
    let signin = signer(
      &secret,
      "deno".into(),
      PathBuf::from("/opt/ux-runner/deno.json"),
    );
    let command = signin.command(Path::new("/opt/ux-runner/deno.json"), 9333, &out);
    let command = command.as_std();
    let args: Vec<String> = command
      .get_args()
      .map(|arg| arg.to_string_lossy().into_owned())
      .collect();
    for arg in &args {
      assert!(!arg.contains("fake-pw"), "the password in argv: {arg:?}");
      assert!(
        !arg.contains(&secret.file.display().to_string()),
        "the password file in argv"
      );
    }
    for (key, value) in command.get_envs() {
      let value = value.map(|v| v.to_string_lossy().into_owned());
      assert!(
        !value.as_deref().unwrap_or_default().contains("fake-pw"),
        "the password in env {key:?}"
      );
    }
    // Not even the file's path: the environment is cleared, and only the
    // allowlist is set again.
    assert!(command.get_envs().all(|(key, _)| {
      key
        .to_str()
        .is_some_and(|key| SIGNIN_ENV_ALLOWLIST.contains(&key))
    }));
    // Cached modules only, under the runner's config, network only to DevTools.
    for expected in [
      "run",
      "--no-prompt",
      "--cached-only",
      "--config",
      "/opt/ux-runner/deno.json",
      "--allow-net=127.0.0.1:9333",
      "http://127.0.0.1:9333",
      "tester@example.test",
    ] {
      assert!(args.iter().any(|arg| arg == expected), "missing {expected}");
    }
    assert!(!args.iter().any(|arg| arg == "-A" || arg == "--allow-all"));
  }

  /// A stand-in for `deno`: records its stdin beside the script it was handed
  /// (Google: last argument; Microsoft: penultimate) and prints `status`.
  fn fake_deno(secret: &FakeSecret, status: &str) -> PathBuf {
    fake_deno_for(secret, GOOGLE_SIGNIN_SCRIPT, status)
  }

  /// Write an executable a test will run, from a separate `sh`, so that no
  /// test thread ever holds a write fd on it. One held here leaks into any
  /// child another test thread forks at that moment, and exec of a file open
  /// for writing fails with ETXTBSY ("Text file busy").
  fn write_executable(path: &Path, contents: &str) {
    let mut child = std::process::Command::new("sh")
      .args(["-c", "cat > \"$1\" && chmod 700 \"$1\"", "sh"])
      .arg(path)
      .stdin(Stdio::piped())
      .spawn()
      .unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), contents.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success(), "write {}", path.display());
  }

  fn fake_deno_for(secret: &FakeSecret, script: &str, status: &str) -> PathBuf {
    let path = secret.dir.join("fake-deno");
    write_executable(
      &path,
      &format!(
        "#!/bin/sh\nulimit -c 0\nprevious=\nlast=\nfor arg; do previous=$last; last=$arg; done\n{out_arg}\ncat > \"$last/stdin.bin\"\n\
         test -f \"$last/{script}\" || exit 9\n{status}\n",
        out_arg = if script == MICROSOFT_SIGNIN_SCRIPT {
          "last=$previous"
        } else {
          ":"
        },
      ),
    );
    path
  }

  #[tokio::test]
  async fn the_password_goes_to_stdin_less_one_newline_and_the_status_line_decides() {
    let secret = FakeSecret::new(&format!("{FAKE_PASSWORD}\n"));
    let out = secret.dir.join("out");
    let config = secret.dir.join("runner/deno.json");
    std::fs::write(&config, "{}").unwrap();
    let deno = fake_deno(&secret, "echo 'google-signin: signed-in'");
    let outcome = signer(&secret, deno, config.clone())
      .sign_in(9333, &out, &secret.workspace())
      .await;
    assert_eq!(
      outcome,
      SigninOutcome::Proceed {
        line: "google-signin: signed-in".into()
      }
    );
    assert_eq!(
      std::fs::read(out.join("stdin.bin")).unwrap(),
      FAKE_PASSWORD.as_bytes()
    );
    // The embedded script was written for the run.
    assert_eq!(
      std::fs::read_to_string(out.join(GOOGLE_SIGNIN_SCRIPT)).unwrap(),
      GOOGLE_SIGNIN_SOURCE
    );

    // A script that echoed its stdin cannot put it into a record.
    let deno = fake_deno(
      &secret,
      "echo \"google-signin: error $(cat \"$last/stdin.bin\")\"; exit 1",
    );
    let outcome = signer(&secret, deno, config.clone())
      .sign_in(9333, &out, &secret.workspace())
      .await;
    assert_eq!(
      outcome,
      SigninOutcome::Blocked {
        blocker: "google-signin-error".into(),
        line: "google-signin: error [redacted]".into()
      }
    );

    let deno = fake_deno(
      &secret,
      "echo 'google-signin: needs-human verify-its-you'; exit 3",
    );
    let outcome = signer(&secret, deno, config)
      .sign_in(9333, &out, &secret.workspace())
      .await;
    assert!(matches!(
      outcome,
      SigninOutcome::Blocked { ref blocker, .. } if blocker == "google-signin-needs-human"
    ));
  }

  #[tokio::test]
  async fn a_host_without_a_runner_cannot_sign_in() {
    let secret = FakeSecret::new(FAKE_PASSWORD);
    let signin = DenoGoogleSignin {
      deno_config: None,
      ..signer(&secret, "deno".into(), PathBuf::new())
    };
    let outcome = signin
      .sign_in(9333, &secret.dir.join("out"), &secret.workspace())
      .await;
    assert!(matches!(
      outcome,
      SigninOutcome::Blocked { ref blocker, ref line }
        if blocker == "google-signin-error" && line.contains("no ux runner")
    ));
  }

  // ---- lane DN: deno 2.7.14 segfaults at startup, now and then ----------

  /// How many times a fake deno that appends to `attempts` ran in `out`.
  fn attempts(out: &Path) -> usize {
    std::fs::read_to_string(out.join("attempts")).map_or(0, |text| text.lines().count())
  }

  /// One pre-step with a fake deno running `body`, in a fresh `out-<name>`.
  async fn sign_in_with(
    secret: &FakeSecret,
    name: &str,
    body: &str,
  ) -> (SigninOutcome, PathBuf, Vec<i32>) {
    let config = secret.dir.join("runner/deno.json");
    std::fs::write(&config, "{}").unwrap();
    let out = secret.dir.join(format!("out-{name}"));
    let deno = fake_deno(secret, &format!("echo x >> \"$last/attempts\"\n{body}"));
    let (outcome, retries) = signer(secret, deno, config)
      .sign_in_recorded(9333, &out, &secret.workspace())
      .await;
    // Review L34 F3: a retry is in the record, and only a retry is.
    assert_eq!(
      retries.len(),
      attempts(&out).saturating_sub(1),
      "{name}: {retries:?}"
    );
    for retry in &retries {
      assert_eq!(retry.provider, "google-signin", "{name}");
      assert!(
        retry.elapsed_ms < STARTUP_CRASH_WINDOW.as_millis() as u64,
        "{name}"
      );
    }
    let signals = retries.iter().map(|retry| retry.signal).collect();
    (outcome, out, signals)
  }

  fn no_status(signal: i32) -> SigninOutcome {
    SigninOutcome::Blocked {
      blocker: "google-signin-no-status".into(),
      line: format!("google-signin: no-status (signal {signal})"),
    }
  }

  #[tokio::test]
  async fn a_silent_startup_crash_is_retried_once_and_the_retry_decides() {
    let secret = FakeSecret::new(FAKE_PASSWORD);
    // The first run dies on SIGSEGV having written nothing anywhere, as
    // deno 2.7.14 does 20 ms after exec; the second signs in.
    for (name, signal) in [("segv", "SEGV"), ("bus", "BUS")] {
      let (outcome, out, retried) = sign_in_with(
        &secret,
        name,
        &format!(
          "test -f \"$last/crashed\" || {{ touch \"$last/crashed\"; kill -{signal} $$; }}\n\
           echo 'google-signin: signed-in'"
        ),
      )
      .await;
      assert_eq!(
        outcome,
        SigninOutcome::Proceed {
          line: "google-signin: signed-in".into()
        },
        "{name}"
      );
      assert_eq!(attempts(&out), 2, "{name}");
      let expected = if signal == "SEGV" {
        libc::SIGSEGV
      } else {
        libc::SIGBUS
      };
      assert_eq!(retried, [expected], "{name}");
      // The retry was handed the password too.
      assert_eq!(
        std::fs::read(out.join("stdin.bin")).unwrap(),
        FAKE_PASSWORD.as_bytes()
      );
    }
    // A deno that always crashes is retried once, not again, and the line
    // names the signal by number.
    let (outcome, out, retried) = sign_in_with(&secret, "always", "kill -SEGV $$").await;
    assert_eq!(outcome, no_status(11));
    assert_eq!(attempts(&out), 2);
    assert_eq!(retried, [libc::SIGSEGV]);
  }

  #[tokio::test]
  async fn a_crash_after_any_output_or_on_another_signal_is_not_retried() {
    let secret = FakeSecret::new(FAKE_PASSWORD);
    for (name, body, expected) in [
      // Anything on stderr (the log) means deno got as far as running.
      ("stderr", "echo started >&2; kill -SEGV $$", no_status(11)),
      // Anything on stdout too.
      ("stdout", "echo partial; kill -SEGV $$", no_status(11)),
      // Only SIGSEGV and SIGBUS are the startup crash.
      ("abort", "kill -ABRT $$", no_status(6)),
      ("term", "kill -TERM $$", no_status(15)),
      ("kill", "kill -KILL $$", no_status(9)),
    ] {
      let (outcome, out, retried) = sign_in_with(&secret, name, body).await;
      assert_eq!(outcome, expected, "{name}");
      assert_eq!(attempts(&out), 1, "{name}");
      assert!(retried.is_empty(), "{name}");
    }
    // An exit code is still an exit code.
    let (outcome, out, retried) = sign_in_with(&secret, "code", "exit 4").await;
    assert_eq!(
      outcome,
      SigninOutcome::Blocked {
        blocker: "google-signin-no-status".into(),
        line: "google-signin: no-status (exit 4)".into()
      }
    );
    assert_eq!(attempts(&out), 1);
    assert!(retried.is_empty());
  }

  #[test]
  fn a_startup_crash_is_only_a_quick_silent_segv_or_bus() {
    let dir = test_scratch_dir("ux-startup-crash");
    let empty = dir.join("empty.log");
    std::fs::write(&empty, "").unwrap();
    let written = dir.join("written.log");
    std::fs::write(&written, "google-signin.deno.ts started\n").unwrap();
    let quick = Duration::from_millis(30);
    assert!(startup_crash(
      ChildExit::Signal(libc::SIGSEGV),
      b"",
      &empty,
      quick
    ));
    assert!(startup_crash(
      ChildExit::Signal(libc::SIGBUS),
      b"",
      &empty,
      quick
    ));
    // Anything else is not.
    assert!(!startup_crash(
      ChildExit::Signal(libc::SIGSEGV),
      b"",
      &written,
      quick
    ));
    assert!(!startup_crash(
      ChildExit::Signal(libc::SIGSEGV),
      b"x",
      &empty,
      quick
    ));
    assert!(!startup_crash(
      ChildExit::Signal(libc::SIGSEGV),
      b"",
      &dir.join("missing.log"),
      quick
    ));
    assert!(!startup_crash(
      ChildExit::Signal(libc::SIGSEGV),
      b"",
      &empty,
      STARTUP_CRASH_WINDOW
    ));
    assert!(!startup_crash(
      ChildExit::Signal(libc::SIGABRT),
      b"",
      &empty,
      quick
    ));
    assert!(!startup_crash(ChildExit::Code(0), b"", &empty, quick));
    assert!(!startup_crash(ChildExit::Code(139), b"", &empty, quick));
    assert!(!startup_crash(ChildExit::Unknown, b"", &empty, quick));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Review L34 F1: the retry's proof that Google was never contacted is an
  /// empty log, which holds only while each script's `main` says `started` on
  /// stderr before anything else, and nothing at module level does I/O.
  #[test]
  fn the_sign_in_scripts_say_started_before_anything_else() {
    for provider in [SigninProvider::Google, SigninProvider::Microsoft] {
      let source = provider.source();
      let script = provider.script();
      let name = format!("{script}: ");
      let main = "async function main(): Promise<number> {\n";
      let body = &source[source.find(main).expect("main") + main.len()..];
      let first = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("//"))
        .unwrap();
      assert_eq!(
        first,
        format!("console.error(\"{script} started\");"),
        "{name}main must start by saying so"
      );
      // Module level: declarations only, and the one entry point.
      for line in source.lines() {
        let line = line.strip_prefix("export ").unwrap_or(line);
        if line.is_empty() || line.starts_with([' ', '/', '}', ')', ']']) {
          continue;
        }
        let declaration = [
          "import ",
          "async function ",
          "function ",
          "type ",
          "interface ",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix));
        let constant = line.starts_with("const ")
          && !["await", "Deno.", "fetch(", "puppeteer."]
            .iter()
            .any(|call| line.contains(call));
        assert!(
          declaration || constant || line == "if (import.meta.main) {",
          "{name}module-level statement {line:?}"
        );
      }
      assert!(
        source.ends_with("if (import.meta.main) {\n  Deno.exit(await main());\n}\n"),
        "{name}the entry point is only `main`"
      );
    }
  }

  // ---- X-D2 (a): deno never loads from the agent's work dir --------------

  /// A temp layout: `<root>/agent` is the agent's work dir; everything else
  /// under `<root>` is outside it. Removed on drop.
  struct Layout {
    root: PathBuf,
    ws: PathBuf,
  }

  impl Layout {
    fn new(label: &str) -> Self {
      // Not under a temp dir, which the check refuses as a whole.
      let root = test_scratch_dir(&format!("ux-deno-layout-{label}"));
      let ws = root.join("agent");
      std::fs::create_dir_all(&ws).unwrap();
      // Canonical, so the names the refusal prints are the ones asserted.
      let root = std::fs::canonicalize(root).unwrap();
      let ws = root.join("agent");
      Self { root, ws }
    }

    /// An executable file at `path`, parents created.
    fn file(&self, path: PathBuf) -> PathBuf {
      use std::os::unix::fs::PermissionsExt;
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(&path, "#!/bin/sh\n").unwrap();
      std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
      path
    }

    fn dir(&self, path: PathBuf) -> PathBuf {
      std::fs::create_dir_all(&path).unwrap();
      path
    }

    fn link(&self, target: &Path, link: PathBuf) -> PathBuf {
      std::fs::create_dir_all(link.parent().unwrap()).unwrap();
      std::os::unix::fs::symlink(target, &link).unwrap();
      link
    }

    /// A sane host: runner, cache and binary all beside the work dir.
    fn sane(&self) -> (PathBuf, PathBuf, Vec<(OsString, OsString)>) {
      let config = self.file(self.root.join("runner/deno.json"));
      self.dir(self.root.join("runner/node_modules"));
      let deno = self.file(self.root.join("bin/deno"));
      let cache = self.dir(self.root.join("cache"));
      (deno, config, layout_env(&[("DENO_DIR", &cache)]))
    }
  }

  impl Drop for Layout {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.root);
    }
  }

  fn layout_env(pairs: &[(&str, &Path)]) -> Vec<(OsString, OsString)> {
    pairs
      .iter()
      .map(|(key, value)| (OsString::from(key), value.as_os_str().to_os_string()))
      .collect()
  }

  /// The harness env the public checks get in production: this process's.
  fn process_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os().collect()
  }

  /// The check's refusal, as the step's error line would show it.
  fn refusal(result: Result<()>) -> String {
    format!("{:#}", result.expect_err("the layout check must refuse"))
  }

  #[test]
  fn a_runner_cache_and_deno_outside_the_work_dir_pass() {
    let layout = Layout::new("outside");
    let (deno, config, env) = layout.sane();
    deno_outside_workspace(&layout.ws, &deno, &config, &env, &process_env())
      .expect("a sane layout passes");
    // A cache that does not exist yet (deno creates it) is judged by where
    // it will be.
    let fresh = layout_env(&[("DENO_DIR", &layout.root.join("not-yet/deno"))]);
    deno_outside_workspace(&layout.ws, &deno, &config, &fresh, &process_env())
      .expect("a fresh cache outside");
  }

  #[test]
  fn a_runner_cache_or_deno_inside_the_work_dir_fails_and_names_the_path() {
    let layout = Layout::new("inside");
    let (deno, config, env) = layout.sane();

    let inner_config = layout.file(layout.ws.join("runner/deno.json"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &inner_config,
      &env,
      &process_env(),
    ));
    assert!(error.contains("runner"), "{error}");
    assert!(
      error.contains(&layout.ws.join("runner").display().to_string()),
      "{error}"
    );

    let inner_cache = layout.ws.join("deno-cache");
    let inner_env = layout_env(&[("DENO_DIR", &inner_cache)]);
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &inner_env,
      &process_env(),
    ));
    assert!(error.contains("DENO_DIR"), "{error}");
    assert!(
      error.contains(&inner_cache.display().to_string()),
      "{error}"
    );

    let inner_deno = layout.file(layout.ws.join("bin/deno"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &inner_deno,
      &config,
      &env,
      &process_env(),
    ));
    assert!(error.contains("deno binary"), "{error}");
    assert!(error.contains(&inner_deno.display().to_string()), "{error}");
    assert!(error.contains("agent work dir"), "{error}");
  }

  #[test]
  fn a_path_outside_by_name_but_inside_through_a_link_fails() {
    let layout = Layout::new("links");
    let (deno, config, env) = layout.sane();
    let ws_runner = layout.dir(layout.ws.join("runner"));
    layout.file(ws_runner.join("deno.json"));

    // The runner, through a link outside the work dir that points into it.
    let runner_link = layout.link(&ws_runner, layout.root.join("runner-link"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &runner_link.join("deno.json"),
      &env,
      &process_env(),
    ));
    assert!(error.contains(&ws_runner.display().to_string()), "{error}");

    // The runner's node_modules, linked into the work dir.
    let nm_config = layout.file(layout.root.join("runner2/deno.json"));
    let ws_nm = layout.dir(layout.ws.join("node_modules"));
    layout.link(&ws_nm, layout.root.join("runner2/node_modules"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &nm_config,
      &env,
      &process_env(),
    ));
    assert!(error.contains("node_modules"), "{error}");
    assert!(error.contains(&ws_nm.display().to_string()), "{error}");

    // DENO_DIR under a linked parent.
    let ws_cache = layout.dir(layout.ws.join("cache"));
    let cache_link = layout.link(&ws_cache, layout.root.join("cache-link"));
    let linked_env = layout_env(&[("DENO_DIR", &cache_link.join("deno"))]);
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &linked_env,
      &process_env(),
    ));
    assert!(
      error.contains(&ws_cache.join("deno").display().to_string()),
      "{error}"
    );

    // The deno binary, a link outside to a file inside.
    let ws_deno = layout.file(layout.ws.join("deno"));
    let deno_link = layout.link(&ws_deno, layout.root.join("bin2/deno"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno_link,
      &config,
      &env,
      &process_env(),
    ));
    assert!(error.contains(&ws_deno.display().to_string()), "{error}");

    // A link that lives in the work dir is the agent's to re-point, even
    // while it points outside.
    let outside_cache = layout.dir(layout.root.join("cache2"));
    let planted = layout.link(&outside_cache, layout.ws.join("cache-out"));
    let planted_env = layout_env(&[("DENO_DIR", &planted)]);
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &planted_env,
      &process_env(),
    ));
    assert!(error.contains(&planted.display().to_string()), "{error}");

    // The work dir itself named through a link.
    let ws_link = layout.link(&layout.ws, layout.root.join("ws-link"));
    let inner_env = layout_env(&[("DENO_DIR", &layout.ws.join("c"))]);
    refusal(deno_outside_workspace(
      &ws_link,
      &deno,
      &config,
      &inner_env,
      &process_env(),
    ));
    // A dangling link cannot be judged, so it is refused.
    let dangling = layout.link(&layout.root.join("gone"), layout.root.join("dangling"));
    let dangling_env = layout_env(&[("DENO_DIR", &dangling)]);
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &dangling_env,
      &process_env(),
    ));
    assert!(error.contains(&dangling.display().to_string()), "{error}");
  }

  #[test]
  fn an_unset_deno_dir_is_judged_where_deno_would_put_it() {
    let layout = Layout::new("default");
    let (deno, config, _) = layout.sane();
    let default_under = |home: &Path| {
      if cfg!(target_os = "macos") {
        home.join("Library/Caches/deno")
      } else {
        home.join(".cache/deno")
      }
    };

    let inner_home = layout.dir(layout.ws.join("home"));
    let env = layout_env(&[("HOME", &inner_home)]);
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &env,
      &process_env(),
    ));
    assert!(error.contains("DENO_DIR"), "{error}");
    assert!(
      error.contains(&default_under(&inner_home).display().to_string()),
      "{error}"
    );

    let outer_home = layout.dir(layout.root.join("home"));
    let env = layout_env(&[("HOME", &outer_home)]);
    deno_outside_workspace(&layout.ws, &deno, &config, &env, &process_env())
      .expect("default cache outside");

    if !cfg!(target_os = "macos") {
      // On Linux an absolute XDG_CACHE_HOME moves deno's default.
      let xdg = layout.ws.join("xdg");
      let env = layout_env(&[("HOME", &outer_home), ("XDG_CACHE_HOME", &xdg)]);
      let error = refusal(deno_outside_workspace(
        &layout.ws,
        &deno,
        &config,
        &env,
        &process_env(),
      ));
      assert!(
        error.contains(&xdg.join("deno").display().to_string()),
        "{error}"
      );
    }

    // An empty DENO_DIR is unset, as deno reads it.
    let empty = PathBuf::new();
    let env = layout_env(&[("DENO_DIR", &empty), ("HOME", &inner_home)]);
    refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &env,
      &process_env(),
    ));

    // Nothing to tell where the cache is: refused, not guessed.
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &[],
      &process_env(),
    ));
    assert!(error.contains("DENO_DIR"), "{error}");
  }

  #[test]
  fn a_bare_deno_is_the_one_on_the_childs_path() {
    let layout = Layout::new("path");
    let (_, config, env) = layout.sane();
    let inner_bin = layout.ws.join("bin");
    let inner_deno = layout.file(inner_bin.join("deno"));
    let outer_bin = layout.root.join("bin");
    let cache = layout.root.join("cache");
    let path = std::env::join_paths([&inner_bin, &outer_bin]).unwrap();
    let mut first_inside = layout_env(&[("DENO_DIR", &cache)]);
    first_inside.push(("PATH".into(), path));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      Path::new("deno"),
      &config,
      &first_inside,
      &process_env(),
    ));
    assert!(error.contains(&inner_deno.display().to_string()), "{error}");

    let mut outside = env.clone();
    outside.push(("PATH".into(), outer_bin.clone().into_os_string()));
    deno_outside_workspace(
      &layout.ws,
      Path::new("deno"),
      &config,
      &outside,
      &process_env(),
    )
    .expect("the deno on PATH is outside");

    // A non-executable `deno` is not what a PATH lookup runs.
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(&inner_deno, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    deno_outside_workspace(
      &layout.ws,
      Path::new("deno"),
      &config,
      &first_inside,
      &process_env(),
    )
    .expect("the first EXECUTABLE deno on PATH is the one judged");

    let mut missing = env;
    missing.push(("PATH".into(), layout.root.join("nowhere").into_os_string()));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      Path::new("deno"),
      &config,
      &missing,
      &process_env(),
    ));
    assert!(error.contains("PATH"), "{error}");
  }

  /// Review O-2: a path that does not exist yet is judged under the real
  /// path of its deepest existing ancestor, so a fresh DENO_DIR behind a
  /// link into the work dir fails like an existing one.
  #[test]
  fn a_missing_path_behind_a_link_into_the_work_dir_fails() {
    let layout = Layout::new("tail");
    let (deno, config, _) = layout.sane();
    let alias = layout.link(&layout.ws, layout.root.join("ws-alias"));
    let env = layout_env(&[("DENO_DIR", &alias.join("not-yet/deno"))]);
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &env,
      &process_env(),
    ));
    assert!(
      error.contains(&layout.ws.join("not-yet/deno").display().to_string()),
      "{error}"
    );
  }

  /// Review O-2: deno ignores a relative `XDG_CACHE_HOME` (its default is
  /// then `$HOME/.cache/deno`), and so does the check.
  #[test]
  fn a_relative_xdg_cache_home_is_ignored_as_deno_ignores_it() {
    if cfg!(target_os = "macos") {
      return;
    }
    let layout = Layout::new("xdg-relative");
    let (deno, config, _) = layout.sane();
    let inner_home = layout.dir(layout.ws.join("home"));
    let env = layout_env(&[
      ("HOME", &inner_home),
      ("XDG_CACHE_HOME", Path::new("relative-cache")),
    ]);
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &env,
      &process_env(),
    ));
    assert!(
      error.contains(&inner_home.join(".cache/deno").display().to_string()),
      "{error}"
    );
  }

  /// The call site: a pre-step whose deno sits in the work dir is blocked
  /// before anything is spawned, written or read.
  #[tokio::test]
  async fn the_pre_step_refuses_to_spawn_a_deno_inside_the_work_dir() {
    let secret = FakeSecret::new(&format!("{FAKE_PASSWORD}\n"));
    let out = secret.dir.join("out");
    let config = secret.dir.join("runner/deno.json");
    std::fs::write(&config, "{}").unwrap();
    let workspace = secret.workspace();
    let outside = fake_deno(&secret, "echo 'google-signin: signed-in'");
    let planted = workspace.join("fake-deno");
    std::fs::rename(&outside, &planted).unwrap();
    let outcome = signer(&secret, planted.clone(), config)
      .sign_in(9333, &out, &workspace)
      .await;
    let SigninOutcome::Blocked { blocker, line } = outcome else {
      panic!("a deno in the work dir must block the pre-step, got {outcome:?}");
    };
    assert_eq!(blocker, "google-signin-error");
    assert!(line.contains(&planted.display().to_string()), "{line}");
    assert!(!out.join("stdin.bin").exists(), "deno was spawned");
    assert!(
      !out.join(GOOGLE_SIGNIN_SCRIPT).exists(),
      "the script was written"
    );
  }

  // ---- OQ-1 (review O-5a): nor from a temp dir an agent's sandbox opens --

  /// The fixed temp roots, each with a path under it that does not exist
  /// (judged by its nearest existing ancestor, like any other path).
  fn under_temp_roots() -> Vec<(&'static str, PathBuf)> {
    let tag = format!(
      "ux-deno-layout-{}-{}",
      std::process::id(),
      rand::random::<u32>()
    );
    // Spelled out, not read from the code under test: dropping one there
    // must fail here.
    [
      "/tmp",
      "/var/tmp",
      "/private/tmp",
      "/private/var/folders",
      "/var/folders",
    ]
    .into_iter()
    .map(|root| (root, Path::new(root).join(&tag).join("deno")))
    .collect()
  }

  /// Whether `error` says the path is inside the temp root `root`: by its
  /// name, or by the real path it resolves to (macOS: /tmp -> /private/tmp).
  fn inside_temp_root(error: &str, root: &str) -> bool {
    let real = resolve_existing(Path::new(root)).unwrap();
    error.contains(&format!("inside the temp dir {root}"))
      || error.contains(&format!("inside the temp dir {}", real.display()))
      || (error.contains("inside the temp dir ")
        && error.contains(&format!("({})", real.display())))
  }

  fn with_var(env: &[(OsString, OsString)], key: &str, value: &Path) -> Vec<(OsString, OsString)> {
    env
      .iter()
      .filter(|(name, _)| name.as_os_str() != key)
      .cloned()
      .chain([(OsString::from(key), value.as_os_str().to_os_string())])
      .collect()
  }

  #[test]
  fn a_runner_cache_or_deno_under_a_temp_dir_fails_and_names_the_root() {
    let layout = Layout::new("temp-roots");
    let (deno, config, env) = layout.sane();
    let tmpdir = layout.dir(layout.root.join("tmpdir"));
    let env = with_var(&env, "TMPDIR", &tmpdir);
    deno_outside_workspace(&layout.ws, &deno, &config, &env, &process_env())
      .expect("a sane layout, with its TMPDIR beside it, passes");
    for (root, path) in under_temp_roots() {
      let error = refusal(deno_outside_workspace(
        &layout.ws,
        &deno,
        &config,
        &with_var(&env, "DENO_DIR", &path),
        &process_env(),
      ));
      assert!(error.contains("DENO_DIR"), "{error}");
      assert!(error.contains(&path.display().to_string()), "{error}");
      assert!(inside_temp_root(&error, root), "{root}: {error}");

      let runner = path.with_file_name("runner");
      let error = refusal(deno_outside_workspace(
        &layout.ws,
        &deno,
        &runner.join("deno.json"),
        &env,
        &process_env(),
      ));
      assert!(error.contains("the runner dir"), "{error}");
      assert!(error.contains(&runner.display().to_string()), "{error}");
      assert!(inside_temp_root(&error, root), "{root}: {error}");

      let error = refusal(deno_outside_workspace(
        &layout.ws,
        &path,
        &config,
        &env,
        &process_env(),
      ));
      assert!(error.contains("the deno binary"), "{error}");
      assert!(inside_temp_root(&error, root), "{root}: {error}");
    }

    // Outside by name, under /tmp through a link.
    let link = layout.link(Path::new("/tmp"), layout.root.join("cache-link"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &link.join("deno")),
      &process_env(),
    ));
    assert!(error.contains("resolves to"), "{error}");
    assert!(inside_temp_root(&error, "/tmp"), "{error}");
  }

  /// The child's TMPDIR is judged from the env the child gets, not from
  /// this process's (whose temp dir is elsewhere).
  #[test]
  fn the_childs_tmpdir_is_a_temp_root_judged_from_the_childs_env() {
    let layout = Layout::new("tmpdir");
    let (deno, config, env) = layout.sane();
    let tmpdir = layout.dir(layout.root.join("tmpdir"));
    let env = with_var(&env, "TMPDIR", &tmpdir);

    let cache = tmpdir.join("deno");
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &cache),
      &process_env(),
    ));
    assert!(error.contains("DENO_DIR"), "{error}");
    assert!(
      error.contains(&format!("inside the child's TMPDIR {}", tmpdir.display())),
      "{error}"
    );

    let inner_deno = layout.file(tmpdir.join("bin/deno"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &inner_deno,
      &config,
      &env,
      &process_env(),
    ));
    assert!(error.contains("the deno binary"), "{error}");
    assert!(error.contains("TMPDIR"), "{error}");

    // A TMPDIR named through a link is judged where it leads.
    let real = layout.dir(layout.root.join("real-tmp"));
    let tmp_link = layout.link(&real, layout.root.join("tmp-link"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(
        &with_var(&env, "TMPDIR", &tmp_link),
        "DENO_DIR",
        &real.join("deno"),
      ),
      &process_env(),
    ));
    assert!(
      error.contains(&format!(
        "TMPDIR {} ({})",
        tmp_link.display(),
        real.display()
      )),
      "{error}"
    );

    // A TMPDIR that does not exist yet: judged by its nearest existing
    // ancestor, as deno would create it.
    let fresh = layout.root.join("not-yet/tmp");
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(
        &with_var(&env, "TMPDIR", &fresh),
        "DENO_DIR",
        &fresh.join("deno"),
      ),
      &process_env(),
    ));
    assert!(error.contains("TMPDIR"), "{error}");

    // A TMPDIR that leads nowhere: refused, not guessed.
    let dangling = layout.link(&layout.root.join("gone"), layout.root.join("dangling-tmp"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "TMPDIR", &dangling),
      &process_env(),
    ));
    assert!(error.contains("TMPDIR"), "{error}");
  }

  /// An unset (or empty) TMPDIR leaves the child at the platform default,
  /// which is judged in its place.
  #[test]
  fn an_unset_tmpdir_is_judged_at_the_platform_default() {
    let layout = Layout::new("tmpdir-default");
    let (deno, config, env) = layout.sane();
    assert!(!env.iter().any(|(key, _)| key == "TMPDIR"));
    deno_outside_workspace(&layout.ws, &deno, &config, &env, &process_env())
      .expect("a sane layout passes");
    let default = if cfg!(target_vendor = "apple") {
      "/var/folders"
    } else {
      "/tmp"
    };
    let cache = Path::new(default)
      .join(format!("ux-deno-layout-{}", rand::random::<u32>()))
      .join("deno");
    for env in [env.clone(), with_var(&env, "TMPDIR", Path::new(""))] {
      let error = refusal(deno_outside_workspace(
        &layout.ws,
        &deno,
        &config,
        &with_var(&env, "DENO_DIR", &cache),
        &process_env(),
      ));
      assert!(error.contains("DENO_DIR"), "{error}");
      assert!(
        error.contains(&format!("default temp dir {default}")),
        "{error}"
      );
      assert!(error.contains("TMPDIR unset"), "{error}");
    }
  }

  /// Review L10 Z1: the agent lane's temp dir lives under the harness's own
  /// `TMPDIR` (tsh puts a fenced lane's in `<TMPDIR>/tsh-lanes-<uid>/`), which
  /// is judged apart from the child's: a child given a private `TMPDIR` does
  /// not take the lane's out of the check.
  #[test]
  fn the_harness_tmpdir_is_judged_apart_from_the_childs() {
    let layout = Layout::new("harness-tmpdir");
    let (deno, config, env) = layout.sane();
    let child_tmp = layout.dir(layout.root.join("child-tmp"));
    let child_env = with_var(&env, "TMPDIR", &child_tmp);
    let lane_tmp = layout.dir(layout.root.join("lane-tmp"));
    let harness = layout_env(&[("TMPDIR", &lane_tmp)]);
    deno_outside_workspace(&layout.ws, &deno, &config, &child_env, &harness)
      .expect("a sane layout passes beside the harness's TMPDIR");

    let lane_deno = layout.file(lane_tmp.join("tsh-lanes-501/s-p/deno"));
    let error = refusal(deno_outside_workspace(
      &layout.ws, &lane_deno, &config, &child_env, &harness,
    ));
    assert!(error.contains("the deno binary"), "{error}");
    assert!(error.contains(&lane_deno.display().to_string()), "{error}");
    assert!(
      error.contains(&format!(
        "inside the harness's TMPDIR {}",
        lane_tmp.display()
      )),
      "{error}"
    );

    let lane_cache = lane_tmp.join("cache/deno");
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&child_env, "DENO_DIR", &lane_cache),
      &harness,
    ));
    assert!(error.contains("DENO_DIR"), "{error}");
    assert!(error.contains("inside the harness's TMPDIR"), "{error}");

    // The sink's sibling judges it too.
    let error = refusal(deno_loads_outside_writable_roots(
      &layout.ws,
      &deno,
      &[(
        "the sidecar's script dir in the run dir",
        &lane_tmp.join("run/harness-sink"),
      )],
      &child_env,
      &harness,
    ));
    assert!(error.contains("inside the harness's TMPDIR"), "{error}");

    // A harness without a TMPDIR adds nothing: its default is a fixed root.
    deno_outside_workspace(&layout.ws, &lane_deno, &config, &child_env, &[])
      .expect("lane-tmp is just a dir when the harness has no TMPDIR");
  }

  /// Review L10 Z3 (lane Z's Z-D7 limit): a root the agent may write that
  /// sits INSIDE a judged dir is refused too, since the agent then writes
  /// into that dir: a work dir inside DENO_DIR or the runner dir, a TMPDIR
  /// inside DENO_DIR.
  #[test]
  fn a_root_inside_a_judged_dir_is_refused() {
    let layout = Layout::new("root-inside");
    let (deno, config, env) = layout.sane();

    // The work dir inside DENO_DIR.
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &layout.root),
      &process_env(),
    ));
    assert!(
      error.contains(&format!(
        "the agent work dir {} sits inside DENO_DIR (deno's module cache) {}",
        layout.ws.display(),
        layout.root.display()
      )),
      "{error}"
    );

    // The work dir inside the runner dir.
    let outer_config = layout.file(layout.root.join("deno.json"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &outer_config,
      &env,
      &process_env(),
    ));
    assert!(
      error.contains(&format!(
        "the agent work dir {} sits inside the runner dir {}",
        layout.ws.display(),
        layout.root.display()
      )),
      "{error}"
    );

    // The child's TMPDIR inside DENO_DIR, through a link to it.
    let cache = layout.dir(layout.root.join("cache"));
    let tmp = layout.dir(cache.join("tmp"));
    let tmp_link = layout.link(&tmp, layout.root.join("tmp-link"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "TMPDIR", &tmp_link),
      &process_env(),
    ));
    assert!(error.contains("the child's TMPDIR"), "{error}");
    assert!(
      error.contains(&format!(
        "sits inside DENO_DIR (deno's module cache) {}",
        cache.display()
      )),
      "{error}"
    );

    // The harness's TMPDIR inside the runner dir.
    let runner_tmp = layout.dir(layout.root.join("runner/tmp"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &env,
      &layout_env(&[("TMPDIR", &runner_tmp)]),
    ));
    assert!(
      error.contains("the harness's TMPDIR") && error.contains("sits inside the runner dir"),
      "{error}"
    );

    // Beside each other, as a sane host has them, still passes.
    deno_outside_workspace(&layout.ws, &deno, &config, &env, &process_env())
      .expect("a sane layout passes");
  }

  /// Review O-3, operator decision OQ-3 (fix hop by hop): a link met
  /// mid-path is judged by its own location, not only by where the path
  /// ends up. `<root>/x -> <work>/l -> <root>/real` passes through a link the
  /// agent can re-point, so a cache, runner or binary reached through it is
  /// refused (reviewer O's probe, made a test).
  #[test]
  fn a_hop_through_a_link_in_the_work_dir_is_refused() {
    let layout = Layout::new("hop");
    let (deno, config, env) = layout.sane();
    let real = layout.dir(layout.root.join("real"));
    let inner = layout.link(&real, layout.ws.join("l"));
    let hop = layout.link(&inner, layout.root.join("x"));

    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &hop.join("deno")),
      &process_env(),
    ));
    assert!(error.contains("DENO_DIR"), "{error}");
    assert!(
      error.contains(&format!("goes through the link {}", inner.display())),
      "{error}"
    );
    assert!(error.contains("inside the agent work dir"), "{error}");

    let hop_config = layout.file(real.join("runner/deno.json"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &hop.join("runner/deno.json"),
      &env,
      &process_env(),
    ));
    assert!(error.contains("the runner"), "{error}");
    assert!(error.contains("inside the agent work dir"), "{error}");
    assert!(hop_config.exists());

    let hop_deno = layout.file(real.join("bin/deno"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &hop.join("bin/deno"),
      &config,
      &env,
      &process_env(),
    ));
    assert!(error.contains("the deno binary"), "{error}");
    assert!(error.contains("inside the agent work dir"), "{error}");
    assert!(hop_deno.exists());

    // A relative hop is judged the same: <root>/y -> x (relative).
    let relative = layout.link(Path::new("x"), layout.root.join("y"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &relative.join("deno")),
      &process_env(),
    ));
    assert!(error.contains("inside the agent work dir"), "{error}");

    // A chain of links that stays outside passes.
    let far = layout.dir(layout.root.join("far"));
    let mid = layout.link(&far, layout.root.join("mid"));
    let near = layout.link(Path::new("mid"), layout.root.join("near"));
    assert!(mid.exists());
    deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &near.join("deno")),
      &process_env(),
    )
    .expect("links that stay outside pass");

    // A link loop is refused, not walked forever.
    let looped = layout.link(Path::new("loop"), layout.root.join("loop"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &looped.join("deno")),
      &process_env(),
    ));
    assert!(error.contains("cannot resolve DENO_DIR"), "{error}");
  }

  /// Review L11-2: on a case-insensitive filesystem (macOS APFS) a path
  /// spelled in another case reaches the same entries, while the work dir
  /// root is `canonicalize`d to its on-disk spelling. Every name the walk
  /// yields must carry the on-disk spelling too, or a path into the work dir
  /// spelled `/users/...` is not `starts_with` the root and passes. Skipped
  /// on a case-sensitive filesystem, where the other spelling is another
  /// (absent) path.
  #[test]
  fn a_path_spelled_in_another_case_is_judged_by_its_on_disk_spelling() {
    let layout = Layout::new("case");
    let (deno, config, env) = layout.sane();
    let swap = |path: &Path| {
      let name = path.file_name().unwrap().to_str().unwrap().to_uppercase();
      path.with_file_name(name)
    };
    let root = swap(&layout.root);
    if std::fs::symlink_metadata(&root).is_err() {
      eprintln!("case-sensitive filesystem: nothing to judge");
      return;
    }
    let ws = swap(&root.join("agent"));

    // A cache that does not exist yet, under the work dir spelled otherwise.
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &ws.join("deno-cache")),
      &process_env(),
    ));
    assert!(error.contains("DENO_DIR"), "{error}");
    assert!(error.contains("inside the agent work dir"), "{error}");

    // A runner that exists, inside the work dir spelled otherwise.
    layout.file(layout.ws.join("runner/deno.json"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &ws.join("RUNNER/deno.json"),
      &env,
      &process_env(),
    ));
    assert!(error.contains("the runner dir"), "{error}");
    assert!(error.contains("inside the agent work dir"), "{error}");

    // A hop through a link in the work dir, the link spelled otherwise: the
    // link is named by its on-disk location.
    let real = layout.dir(layout.root.join("real"));
    let inner = layout.link(&real, layout.ws.join("l"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &ws.join("L/deno")),
      &process_env(),
    ));
    assert!(
      error.contains(&format!("goes through the link {}", inner.display())),
      "{error}"
    );
    assert!(error.contains("inside the agent work dir"), "{error}");

    // A link outside whose target spells the work dir otherwise.
    let outer = layout.link(&ws, layout.root.join("x"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &outer.join("deno")),
      &process_env(),
    ));
    assert!(error.contains("inside the agent work dir"), "{error}");

    // The sane layout, spelled otherwise, still passes.
    let cache = swap(&root.join("cache"));
    deno_outside_workspace(
      &layout.ws,
      &swap(&root.join("bin")).join("DENO"),
      &swap(&root.join("runner")).join("deno.json"),
      &with_var(&env, "DENO_DIR", &cache),
      &process_env(),
    )
    .expect("a sane layout spelled otherwise passes");
  }

  /// Review L12-1: a dir on the path that can be entered but not listed
  /// (mode 0311) still yields the on-disk spelling of a plain entry in it
  /// (`canonicalize` needs no read permission), and a link in it, whose own
  /// name a scan must find, is refused on Apple rather than kept as written.
  /// Skipped on a case-sensitive filesystem, as above.
  #[test]
  fn a_dir_that_cannot_be_listed_still_yields_the_on_disk_spelling() {
    use std::os::unix::fs::PermissionsExt;
    let layout = Layout::new("unlistable");
    let (deno, config, env) = layout.sane();
    let locked = layout.dir(layout.root.join("locked"));
    let ws = layout.dir(locked.join("agent"));
    layout.dir(locked.join("cache"));
    let link = layout.link(&layout.root.join("cache"), locked.join("link"));
    if std::fs::symlink_metadata(locked.join("AGENT")).is_err() {
      eprintln!("case-sensitive filesystem: nothing to judge");
      return;
    }
    /// Gives the dir its mode back, so the layout can be removed.
    struct Unlock(PathBuf);
    impl Drop for Unlock {
      fn drop(&mut self) {
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
      }
    }
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o311)).unwrap();
    let _unlock = Unlock(locked.clone());
    let upper = locked.join("AGENT");

    // A cache under the work dir spelled otherwise, missing and existing.
    for dir in [upper.join("cache"), upper.clone()] {
      let error = refusal(deno_outside_workspace(
        &ws,
        &deno,
        &config,
        &with_var(&env, "DENO_DIR", &dir),
        &process_env(),
      ));
      assert!(error.contains("DENO_DIR"), "{error}");
      assert!(
        error.contains(&format!("inside the agent work dir {}", ws.display())),
        "{error}"
      );
    }

    // A plain dir beside the work dir, spelled otherwise, still passes.
    deno_outside_workspace(
      &ws,
      &deno,
      &config,
      &with_var(&env, "DENO_DIR", &locked.join("CACHE")),
      &process_env(),
    )
    .expect("a cache beside the work dir passes");

    // A link's own name can only be told by listing its dir: refused.
    if std::fs::read_dir(&locked).is_err() {
      let error = refusal(deno_outside_workspace(
        &ws,
        &deno,
        &config,
        &with_var(&env, "DENO_DIR", &link),
        &process_env(),
      ));
      assert!(error.contains("DENO_DIR"), "{error}");
      assert!(error.contains("cannot be listed"), "{error}");
    }
  }

  /// Review L11-3: a path is walked once, its parent's links recorded and
  /// counted once. A parent reached through a chain of 25 links (more than
  /// half of [`MAX_LINK_HOPS`], fewer than macOS's own 32) resolves, and
  /// each link appears once among the names.
  #[test]
  fn a_parent_behind_many_links_is_walked_once() {
    let layout = Layout::new("many-links");
    let (deno, _, env) = layout.sane();
    let real = layout.dir(layout.root.join("real"));
    let config = layout.file(real.join("deno.json"));
    let chain = layout.dir(layout.root.join("chain"));
    let count = 25;
    for at in 0..count {
      let target = if at + 1 == count {
        PathBuf::from("../real")
      } else {
        PathBuf::from(format!("l{}", at + 1))
      };
      layout.link(&target, chain.join(format!("l{at}")));
    }
    let path = chain.join("l0/deno.json");
    let names = resolved_names(&path).expect("25 links are within the limit");
    assert_eq!(names[0], real.join("deno.json"), "{names:?}");
    assert_eq!(names[1], config, "{names:?}");
    let links: Vec<PathBuf> = (0..count).map(|at| chain.join(format!("l{at}"))).collect();
    assert_eq!(names[2..], links[..], "each link once, in walk order");

    // The check over that runner passes, its own links outside the work dir.
    deno_outside_workspace(&layout.ws, &deno, &path, &env, &process_env())
      .expect("a runner behind 25 links");
  }

  /// Review AA-D2: the public checks judge the harness env they are given,
  /// apart from the child's. Only the harness's `TMPDIR` holds this binary,
  /// so a check that judged the child's env (or this process's) in its
  /// place lets it through.
  #[test]
  fn the_public_checks_judge_the_harness_env_they_are_given() {
    let layout = Layout::new("harness-param");
    let (deno, config, env) = layout.sane();
    let child_tmp = layout.dir(layout.root.join("child-tmp"));
    let child_env = with_var(&env, "TMPDIR", &child_tmp);
    let lane_tmp = layout.dir(layout.root.join("lane-tmp"));
    let harness = layout_env(&[("TMPDIR", &lane_tmp)]);
    let sink = layout.root.join("run/harness-sink");
    deno_outside_workspace(&layout.ws, &deno, &config, &child_env, &harness)
      .expect("a sane layout passes");
    deno_script_outside_workspace(&layout.ws, &deno, &sink, &child_env, &harness)
      .expect("a sane sink passes");

    let lane_deno = layout.file(lane_tmp.join("tsh-lanes-501/s-p/deno"));
    let inside = format!("inside the harness's TMPDIR {}", lane_tmp.display());
    let error = refusal(deno_outside_workspace(
      &layout.ws, &lane_deno, &config, &child_env, &harness,
    ));
    assert!(error.contains(&inside), "{error}");
    let error = refusal(deno_script_outside_workspace(
      &layout.ws, &lane_deno, &sink, &child_env, &harness,
    ));
    assert!(error.contains(&inside), "{error}");

    // And the child's TMPDIR is judged as the child's.
    let child_deno = layout.file(child_tmp.join("deno"));
    let error = refusal(deno_outside_workspace(
      &layout.ws,
      &child_deno,
      &config,
      &child_env,
      &harness,
    ));
    assert!(error.contains("inside the child's TMPDIR"), "{error}");
    let error = refusal(deno_script_outside_workspace(
      &layout.ws,
      &child_deno,
      &sink,
      &child_env,
      &harness,
    ));
    assert!(error.contains("inside the child's TMPDIR"), "{error}");
  }

  /// The pre-step's call site gets the temp roots too: a deno under
  /// `/var/tmp` is refused before anything is written or spawned.
  #[tokio::test]
  async fn the_pre_step_refuses_to_spawn_a_deno_under_a_temp_dir() {
    let secret = FakeSecret::new(&format!("{FAKE_PASSWORD}\n"));
    let out = secret.dir.join("out");
    let config = secret.dir.join("runner/deno.json");
    std::fs::write(&config, "{}").unwrap();
    let in_tmp = Path::new("/var/tmp")
      .join(format!("ux-google-signin-{}", rand::random::<u32>()))
      .join("deno");
    let outcome = signer(&secret, in_tmp.clone(), config)
      .sign_in(9333, &out, &secret.workspace())
      .await;
    let SigninOutcome::Blocked { blocker, line } = outcome else {
      panic!("a deno under /var/tmp must block the pre-step, got {outcome:?}");
    };
    assert_eq!(blocker, "google-signin-error");
    assert!(line.contains("refusing to run deno"), "{line}");
    assert!(line.contains(&in_tmp.display().to_string()), "{line}");
    assert!(line.contains("inside the temp dir"), "{line}");
    assert!(
      !out.join(GOOGLE_SIGNIN_SCRIPT).exists(),
      "the script was written"
    );
  }

  #[tokio::test]
  async fn the_sign_in_script_inherits_only_the_allowlist_never_debug() {
    let secret = FakeSecret::new(FAKE_PASSWORD);
    let out = secret.dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    // A stand-in for `deno` that records the environment it was started with.
    let deno = secret.dir.join("env-deno");
    write_executable(
      &deno,
      "#!/bin/sh\nfor last; do :; done\n/usr/bin/env > \"$last/env.txt\"\n",
    );
    let config = secret.dir.join("runner/deno.json");
    let parent = std::env::vars_os().chain([
      (OsString::from("DEBUG"), OsString::from("puppeteer:*")),
      (
        OsString::from(GOOGLE_PASSWORD_FILE_ENV),
        secret.file.clone().into_os_string(),
      ),
      (
        OsString::from("HTTPS_PROXY"),
        OsString::from("http://proxy.example.test:3128"),
      ),
    ]);
    let output = signer(&secret, deno, config.clone())
      .command_with_env(&config, 9333, &out, parent)
      .output()
      .await
      .unwrap();
    assert!(output.status.success(), "{output:?}");
    let env = std::fs::read_to_string(out.join("env.txt")).unwrap();
    let keys: Vec<&str> = env
      .lines()
      .filter_map(|line| line.split_once('=').map(|(key, _)| key))
      .collect();
    for forbidden in ["DEBUG", GOOGLE_PASSWORD_FILE_ENV, "HTTPS_PROXY"] {
      assert!(
        !keys.contains(&forbidden),
        "{forbidden} reached the sign-in script"
      );
    }
    // Nothing else of this process's environment either (`sh` adds its few).
    for key in &keys {
      assert!(
        SIGNIN_ENV_ALLOWLIST.contains(key) || ["PWD", "OLDPWD", "SHLVL", "_"].contains(key),
        "{key} was inherited"
      );
    }
    assert!(!env.contains("fake-pw"));
  }

  #[test]
  fn a_password_file_needs_a_profile_outside_the_workspace() {
    let exe = std::env::current_exe().unwrap().display().to_string();
    let secret = FakeSecret::new(FAKE_PASSWORD);
    let signin = GoogleSigninConfig {
      provider: SigninProvider::Google,
      account: "a@example.test".into(),
      password_file: secret.file.clone(),
    };
    let mut config = AgentConfig::resolve("l".into(), Some(exe.clone()), None, None).unwrap();
    // No pre-step: the work dir's fresh profile is fine.
    config.require_profile_for_signin().unwrap();
    config.google_signin = Some(signin.clone());
    let error = config.require_profile_for_signin().unwrap_err().to_string();
    assert!(error.contains(USER_DATA_DIR_ENV), "{error}");
    assert!(!error.contains(FAKE_PASSWORD));
    let mut config =
      AgentConfig::resolve("l".into(), Some(exe), Some("/profiles/tester".into()), None).unwrap();
    config.google_signin = Some(signin);
    config.require_profile_for_signin().unwrap();
  }

  // -------------------------------------------------------------------------
  // Microsoft sign-in pre-step
  // -------------------------------------------------------------------------

  #[test]
  fn the_microsoft_pre_step_is_configured_like_googles_under_its_own_names() {
    let microsoft = SigninProvider::Microsoft;
    // Unset or empty: exactly today's run.
    assert_eq!(SigninConfig::resolve(microsoft, None, None).unwrap(), None);
    assert_eq!(
      SigninConfig::resolve(microsoft, Some(" ".into()), Some("a@example.test".into())).unwrap(),
      None
    );
    let secret = FakeSecret::new(FAKE_PASSWORD);
    let path = secret.file.display().to_string();
    let error = SigninConfig::resolve(microsoft, Some(path.clone()), None)
      .unwrap_err()
      .to_string();
    assert!(error.contains(MICROSOFT_ACCOUNT_ENV), "{error}");
    let config =
      SigninConfig::resolve(microsoft, Some(path.clone()), Some("a@example.test".into()))
        .unwrap()
        .unwrap();
    assert_eq!(config.provider, microsoft);
    assert_eq!(config.account, "a@example.test");
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(&secret.file, std::fs::Permissions::from_mode(0o640)).unwrap();
    }
    let error = SigninConfig::resolve(microsoft, Some(path), Some("a@example.test".into()))
      .unwrap_err()
      .to_string();
    assert!(
      error.contains(MICROSOFT_PASSWORD_FILE_ENV) && error.contains("0600"),
      "{error}"
    );
    assert!(!error.contains(FAKE_PASSWORD));

    // It needs a profile outside the workspace too, and runs after Google's.
    let exe = std::env::current_exe().unwrap().display().to_string();
    let mut agent = AgentConfig::resolve("l".into(), Some(exe.clone()), None, None).unwrap();
    agent.microsoft_signin = Some(config.clone());
    let error = agent.require_profile_for_signin().unwrap_err().to_string();
    assert!(error.contains(MICROSOFT_PASSWORD_FILE_ENV) && error.contains(USER_DATA_DIR_ENV));
    let google = SigninConfig {
      provider: SigninProvider::Google,
      ..config.clone()
    };
    agent.google_signin = Some(google);
    let order: Vec<SigninProvider> = agent.signins().map(|signin| signin.provider).collect();
    assert_eq!(order, [SigninProvider::Google, SigninProvider::Microsoft]);
  }

  /// The Microsoft pre-step ran for every agent spec on a host that names a
  /// Microsoft password file, Google-only ones too, and its 100 s timeout
  /// cancelled them before the agent started (returning-active-user c61084,
  /// 2026-10-09). It runs only for a spec whose manual steps name Microsoft
  /// (or Outlook, its calendar); Google's is unchanged.
  #[test]
  fn the_microsoft_pre_step_runs_only_for_specs_whose_manual_steps_need_it() {
    let spec = |manual: &str| {
      TestSpec::from_yaml(&format!(
        "id: t\nname: T\nsteps:\n  - id: open\n    instruction: open the app\n    actions:\n      - action: wait\n        ms: 1\n{manual}"
      ))
      .unwrap()
    };
    let google_only = spec(
      "  - id: signin\n    instruction: Sign in with Google as a@example.test\n    manual: true\n    manual_reason: Google OAuth on accounts.google.com\n",
    );
    let outlook = spec(
      "  - id: signin-microsoft\n    instruction: Click Continue with Microsoft, pick the account tile\n    manual: true\n    manual_reason: Microsoft OAuth on login.live.com\n",
    );
    let outlook_by_reason = spec(
      "  - id: verify-grant\n    instruction: Read the grant\n    manual: true\n    manual_reason: the OUTLOOK grant is only visible after sign-in\n",
    );
    // Microsoft named only in an automated step is not the agent's to need.
    let automated_mention = spec(
      "  - id: signin\n    instruction: Sign in with Google\n    manual: true\n    manual_reason: Google OAuth\n  - id: done\n    instruction: check Microsoft badge\n    actions:\n      - action: wait\n        ms: 1\n",
    );

    let microsoft = SigninProvider::Microsoft;
    assert!(!microsoft.needed_by(&google_only));
    assert!(microsoft.needed_by(&outlook));
    assert!(microsoft.needed_by(&outlook_by_reason));
    assert!(!microsoft.needed_by(&automated_mention));
    assert!(SigninProvider::Google.needed_by(&google_only));
    assert!(SigninProvider::Google.needed_by(&outlook));

    let exe = std::env::current_exe().unwrap().display().to_string();
    let mut agent = AgentConfig::resolve("l".into(), Some(exe), None, None).unwrap();
    let config = |provider| SigninConfig {
      provider,
      account: "a@example.test".into(),
      password_file: PathBuf::from("/nonexistent/password"),
    };
    agent.google_signin = Some(config(SigninProvider::Google));
    agent.microsoft_signin = Some(config(SigninProvider::Microsoft));
    let for_spec = |spec: &TestSpec| -> Vec<SigninProvider> {
      agent
        .signins_for(spec)
        .map(|signin| signin.provider)
        .collect()
    };
    assert_eq!(for_spec(&google_only), [SigninProvider::Google]);
    assert_eq!(
      for_spec(&outlook),
      [SigninProvider::Google, SigninProvider::Microsoft]
    );
  }

  /// K-8: a spec may declare the sign-in pre-steps its agent-driven steps
  /// need (`signin_providers:`). Present ⇒ the list decides, for both
  /// providers, whatever the steps' text says; absent ⇒ Google always and
  /// Microsoft by the text match above, exactly as before.
  #[test]
  fn a_declared_signin_providers_list_decides_the_pre_steps_over_the_text() {
    let spec = |head: &str, manual: &str| {
      TestSpec::from_yaml(&format!(
        "id: t\nname: T\n{head}steps:\n  - id: open\n    instruction: open the app\n    actions:\n      - action: wait\n        ms: 1\n{manual}"
      ))
      .unwrap()
    };
    // Microsoft in words the text match does not know.
    let hotmail = "  - id: connect\n    instruction: Connect the Hotmail calendar of the Office 365 work account\n    manual: true\n    manual_reason: Entra consent screen\n";
    let outlook = "  - id: signin-microsoft\n    instruction: Click Continue with Microsoft\n    manual: true\n    manual_reason: Microsoft OAuth on login.live.com\n";
    let (google, microsoft) = (SigninProvider::Google, SigninProvider::Microsoft);

    // Absent: the old behaviour, including its blind spot.
    assert!(!microsoft.needed_by(&spec("", hotmail)));
    assert!(microsoft.needed_by(&spec("", outlook)));
    assert!(google.needed_by(&spec("", hotmail)));

    // Present and naming the provider: needed although the text never says so.
    let declared = spec("signin_providers: [google, microsoft]\n", hotmail);
    assert!(microsoft.needed_by(&declared));
    assert!(google.needed_by(&declared));
    // The camelCase spelling the serializer emits loads the same way.
    assert!(microsoft.needed_by(&spec("signinProviders: [microsoft]\n", hotmail)));

    // Present without the provider: not needed although the text names it.
    let google_only = spec("signin_providers: [google]\n", outlook);
    assert!(!microsoft.needed_by(&google_only));
    assert!(google.needed_by(&google_only));
    let microsoft_only = spec("signin_providers: [microsoft]\n", outlook);
    assert!(microsoft.needed_by(&microsoft_only));
    assert!(!google.needed_by(&microsoft_only));
    let none = spec("signin_providers: []\n", outlook);
    assert!(!microsoft.needed_by(&none));
    assert!(!google.needed_by(&none));

    // A misspelt provider is a spec error, not a silent skip.
    assert!(
      TestSpec::from_yaml("id: t\nname: T\nsignin_providers: [microsfot]\nsteps: []\n").is_err()
    );

    // The declaration survives a re-emit (the serializer writes camelCase).
    let reloaded = TestSpec::from_yaml(&serde_yml::to_string(&google_only).unwrap()).unwrap();
    assert!(!microsoft.needed_by(&reloaded));
    assert!(google.needed_by(&reloaded));
  }

  #[test]
  fn a_microsoft_challenge_is_an_operator_step_and_nothing_else_proceeds() {
    let microsoft = SigninProvider::Microsoft;
    let blocked = |blocker: &str, line: &str| SigninOutcome::Blocked {
      blocker: blocker.into(),
      line: line.into(),
    };
    assert_eq!(
      signin_outcome_for(microsoft, Some(0), "microsoft-signin: already-signed-in\n"),
      SigninOutcome::Proceed {
        line: "microsoft-signin: already-signed-in".into()
      }
    );
    assert_eq!(
      signin_outcome_for(microsoft, Some(0), "microsoft-signin: signed-in"),
      SigninOutcome::Proceed {
        line: "microsoft-signin: signed-in".into()
      }
    );
    assert_eq!(
      signin_outcome_for(
        microsoft,
        Some(3),
        "microsoft-signin: challenge protect-your-account"
      ),
      blocked(
        MICROSOFT_CHALLENGE_BLOCKER,
        "microsoft-signin: challenge protect-your-account"
      )
    );
    assert_eq!(
      signin_outcome_for(
        microsoft,
        Some(1),
        "microsoft-signin: timeout password login.live.com/x"
      ),
      blocked(
        "microsoft-signin-timeout",
        "microsoft-signin: timeout password login.live.com/x"
      )
    );
    // Google's words are not Microsoft's, and a Google line is not a status.
    assert_eq!(
      signin_outcome_for(microsoft, Some(3), "microsoft-signin: needs-human x"),
      blocked("microsoft-signin-error", "microsoft-signin: needs-human x")
    );
    assert_eq!(
      signin_outcome_for(microsoft, Some(0), "google-signin: signed-in"),
      blocked(
        "microsoft-signin-no-status",
        "microsoft-signin: no-status (exit 0)"
      )
    );
    assert_eq!(
      signin_outcome_for(microsoft, Some(1), "microsoft-signin: signed-in"),
      blocked("microsoft-signin-error", "microsoft-signin: signed-in")
    );
    // The blocker names its provider, for `end` and `canceled`.
    assert_eq!(
      SigninProvider::of_blocker(MICROSOFT_CHALLENGE_BLOCKER).label(),
      "microsoft-signin"
    );
    assert_eq!(
      SigninProvider::of_blocker("google-signin-needs-human").label(),
      "google-signin"
    );
  }

  fn microsoft_signer(secret: &FakeSecret, deno: PathBuf, config: PathBuf) -> DenoSignin {
    DenoSignin {
      provider: SigninProvider::Microsoft,
      app_url: Some("https://dev--calendar.lona.so/".into()),
      ..signer(secret, deno, config)
    }
  }

  #[test]
  fn only_microsoft_receives_the_tested_app_url() {
    let app = "https://rc--calendar.lona.so/test?ux=fixture";
    for provider in [SigninProvider::Google, SigninProvider::Microsoft] {
      let config = SigninConfig {
        provider,
        account: "tester@example.test".into(),
        password_file: "/fixture/password".into(),
      };
      let signer = DenoSignin::new(&config, None, app);
      let command = signer.command_with_env(
        Path::new("/fixture/deno.json"),
        9333,
        Path::new("/fixture/out"),
        [],
      );
      let args: Vec<_> = command
        .as_std()
        .get_args()
        .map(|v| v.to_string_lossy().into_owned())
        .collect();
      assert_eq!(
        args.iter().any(|v| v == app),
        provider == SigninProvider::Microsoft
      );
      if provider == SigninProvider::Microsoft {
        assert_eq!(args.last().unwrap(), app);
        assert_eq!(args[args.len() - 2], "/fixture/out");
      } else {
        assert_eq!(args.last().unwrap(), "/fixture/out");
      }
    }
  }

  #[tokio::test]
  async fn the_microsoft_password_goes_only_to_its_scripts_stdin() {
    let secret = FakeSecret::new(&format!("{FAKE_PASSWORD}\r\n"));
    let out = secret.dir.join("out");
    let config = secret.dir.join("runner/deno.json");
    std::fs::write(&config, "{}").unwrap();

    // The command line: its own script, the password nowhere.
    let signin = microsoft_signer(&secret, "deno".into(), config.clone());
    let command = signin.command(&config, 9333, &out);
    let command = command.as_std();
    let args: Vec<String> = command
      .get_args()
      .map(|arg| arg.to_string_lossy().into_owned())
      .collect();
    assert!(
      args
        .iter()
        .any(|arg| arg.ends_with(MICROSOFT_SIGNIN_SCRIPT))
    );
    assert!(!args.iter().any(|arg| arg.ends_with(GOOGLE_SIGNIN_SCRIPT)));
    for arg in &args {
      assert!(!arg.contains("fake-pw"), "the password in argv: {arg:?}");
      assert!(!arg.contains(&secret.file.display().to_string()));
    }
    assert!(command.get_envs().all(|(key, value)| {
      key
        .to_str()
        .is_some_and(|key| SIGNIN_ENV_ALLOWLIST.contains(&key))
        && !value.is_some_and(|value| value.to_string_lossy().contains("fake-pw"))
    }));

    let deno = fake_deno_for(
      &secret,
      MICROSOFT_SIGNIN_SCRIPT,
      "echo 'microsoft-signin: signed-in'",
    );
    let outcome = microsoft_signer(&secret, deno, config.clone())
      .sign_in(9333, &out, &secret.workspace())
      .await;
    assert_eq!(
      outcome,
      SigninOutcome::Proceed {
        line: "microsoft-signin: signed-in".into()
      }
    );
    assert_eq!(
      std::fs::read(out.join("stdin.bin")).unwrap(),
      FAKE_PASSWORD.as_bytes()
    );
    assert_eq!(
      std::fs::read_to_string(out.join(MICROSOFT_SIGNIN_SCRIPT)).unwrap(),
      MICROSOFT_SIGNIN_SOURCE
    );
    assert_eq!(
      std::fs::read_to_string(out.join(MICROSOFT_OAUTH_START_SCRIPT)).unwrap(),
      MICROSOFT_OAUTH_START_SOURCE
    );
    assert!(out.join("microsoft-signin.log").is_file());

    // A script that echoed its stdin cannot put it into a record.
    let deno = fake_deno_for(
      &secret,
      MICROSOFT_SIGNIN_SCRIPT,
      "echo \"microsoft-signin: challenge $(cat \"$last/stdin.bin\")\"; exit 3",
    );
    let outcome = microsoft_signer(&secret, deno, config)
      .sign_in(9333, &out, &secret.workspace())
      .await;
    assert_eq!(
      outcome,
      SigninOutcome::Blocked {
        blocker: MICROSOFT_CHALLENGE_BLOCKER.into(),
        line: "microsoft-signin: challenge [redacted]".into()
      }
    );
  }

  struct FixedSignIn {
    provider: SigninProvider,
    outcome: SigninOutcome,
    seen: std::sync::Mutex<Vec<PathBuf>>,
  }

  #[async_trait]
  impl SignIn for FixedSignIn {
    async fn sign_in(
      &self,
      _devtools_port: u16,
      out_dir: &Path,
      _workspace: &Path,
    ) -> SigninOutcome {
      self.seen.lock().unwrap().push(out_dir.to_path_buf());
      self.outcome.clone()
    }

    fn dir_name(&self) -> &str {
      self.provider.label()
    }
  }

  #[tokio::test]
  async fn google_then_microsoft_each_in_its_own_dir_and_the_first_block_ends_it() {
    let fixed = |provider: SigninProvider, outcome: SigninOutcome| FixedSignIn {
      provider,
      outcome,
      seen: Default::default(),
    };
    let google = fixed(
      SigninProvider::Google,
      SigninOutcome::Proceed {
        line: "google-signin: already-signed-in".into(),
      },
    );
    let microsoft = fixed(
      SigninProvider::Microsoft,
      SigninOutcome::Blocked {
        blocker: MICROSOFT_CHALLENGE_BLOCKER.into(),
        line: "microsoft-signin: challenge code".into(),
      },
    );
    let sequence = SigninSequence {
      steps: vec![&google, &microsoft],
    };
    assert_eq!(sequence.dir_name(), SIGNIN_SEQUENCE_DIR);
    let out = Path::new("/run/signin");
    let outcome = sequence.sign_in(9333, out, Path::new("/run/agent")).await;
    assert_eq!(
      outcome,
      SigninOutcome::Blocked {
        blocker: MICROSOFT_CHALLENGE_BLOCKER.into(),
        line: "google-signin: already-signed-in\nmicrosoft-signin: challenge code".into(),
      }
    );
    assert_eq!(
      *google.seen.lock().unwrap(),
      [PathBuf::from("/run/signin/google-signin")]
    );
    assert_eq!(
      *microsoft.seen.lock().unwrap(),
      [PathBuf::from("/run/signin/microsoft-signin")]
    );
    // agent.json carries each provider's own line.
    let lines = Some("google-signin: already-signed-in\nmicrosoft-signin: challenge code");
    assert_eq!(
      signin_line(lines, SigninProvider::Google).as_deref(),
      Some("google-signin: already-signed-in")
    );
    assert_eq!(
      signin_line(lines, SigninProvider::Microsoft).as_deref(),
      Some("microsoft-signin: challenge code")
    );
    assert_eq!(
      signin_line(Some("google-signin: signed-in"), SigninProvider::Microsoft),
      None
    );

    // A blocked Google step never runs Microsoft's.
    let google = fixed(
      SigninProvider::Google,
      SigninOutcome::Blocked {
        blocker: "google-signin-needs-human".into(),
        line: "google-signin: needs-human captcha".into(),
      },
    );
    let microsoft = fixed(
      SigninProvider::Microsoft,
      SigninOutcome::Proceed {
        line: "microsoft-signin: signed-in".into(),
      },
    );
    let sequence = SigninSequence {
      steps: vec![&google, &microsoft],
    };
    assert!(matches!(
      sequence.sign_in(9333, out, Path::new("/run/agent")).await,
      SigninOutcome::Blocked { ref blocker, .. } if blocker == "google-signin-needs-human"
    ));
    assert!(microsoft.seen.lock().unwrap().is_empty());
  }

  #[test]
  fn the_microsoft_script_never_screenshots_a_filled_password_and_names_its_statuses() {
    for status in [
      "microsoft-signin: already-signed-in",
      "microsoft-signin: signed-in",
      "microsoft-signin: challenge",
      "microsoft-signin: timeout",
      "microsoft-signin: error",
    ] {
      assert!(MICROSOFT_SIGNIN_SOURCE.contains(status), "{status}");
    }
    // Every screenshot is behind the emptied-password check, as Google's is.
    assert_eq!(
      MICROSOFT_SIGNIN_SOURCE.matches("page.screenshot(").count(),
      1
    );
    assert!(MICROSOFT_SIGNIN_SOURCE.contains("if (await passwordFieldsEmpty(page))"));
    // The password is never printed.
    assert!(!MICROSOFT_SIGNIN_SOURCE.contains("console.log(password"));
    assert!(!MICROSOFT_SIGNIN_SOURCE.contains("${password}"));
  }

  #[tokio::test]
  async fn the_profile_lock_is_one_runs_until_it_drops() {
    let scratch = SinkScratch::new();
    let profile = scratch.0.join("profile");
    let poll = Duration::from_millis(10);
    let held = ProfileLock::acquire(&profile, Duration::ZERO, poll)
      .await
      .unwrap()
      .expect("a free profile");
    assert!(profile.join(PROFILE_LOCK_FILE).is_file());
    assert!(
      ProfileLock::acquire(&profile, Duration::from_millis(50), poll)
        .await
        .unwrap()
        .is_none()
    );
    drop(held);
    // Released at once; the wait only covers a child another test forks at
    // that moment, which shares the open file until its exec closes it.
    assert!(
      ProfileLock::acquire(&profile, Duration::from_secs(2), poll)
        .await
        .unwrap()
        .is_some()
    );
  }

  /// A launcher with no browser behind it, counting launches.
  #[derive(Default)]
  struct CountingLauncher(std::sync::atomic::AtomicUsize);

  #[async_trait]
  impl LaunchBrowser for CountingLauncher {
    async fn launch(&self, _launch: &BrowserLaunch) -> Result<BrowserGuard> {
      self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
      Ok(BrowserGuard::detached())
    }
  }

  /// A pre-step that notes how many jobs the queue held while it ran.
  struct QueueWatchingSignIn {
    queue: AgentQueue,
    jobs_seen: Mutex<Option<usize>>,
    outcome: SigninOutcome,
    retries: Vec<SigninRetry>,
  }

  #[async_trait]
  impl SignIn for QueueWatchingSignIn {
    async fn sign_in(
      &self,
      _devtools_port: u16,
      _out_dir: &Path,
      _workspace: &Path,
    ) -> SigninOutcome {
      let jobs = self
        .queue
        .history()
        .await
        .map_or(usize::MAX, |jobs| jobs.len());
      *self.jobs_seen.lock().unwrap() = Some(jobs);
      self.outcome.clone()
    }

    async fn sign_in_recorded(
      &self,
      devtools_port: u16,
      out_dir: &Path,
      workspace: &Path,
    ) -> (SigninOutcome, Vec<SigninRetry>) {
      let outcome = self.sign_in(devtools_port, out_dir, workspace).await;
      (outcome, self.retries.clone())
    }
  }

  /// Everything a drive needs that a blocked pre-step never reaches.
  struct DriveRig {
    scratch: SinkScratch,
    queue: AgentQueue,
    launch: BrowserLaunch,
    logger: LLMLogger,
    port: HostPort,
  }

  impl DriveRig {
    fn new() -> Self {
      let scratch = SinkScratch::new();
      let launch = BrowserLaunch {
        executable: PathBuf::from("/nonexistent/browser"),
        user_data_dir: scratch.0.join("profile"),
        url: "https://rc.example.test/?ux=s1&tid=t1".into(),
        devtools_port: 9333,
        args: Vec::new(),
        log_path: scratch.0.join("browser.log"),
        ready_within: Duration::from_secs(1),
      };
      let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
      Self {
        queue: AgentQueue::fixture(|_: &NewJob| Ok(serde_json::json!("never ran")), PRODUCER),
        logger: LLMLogger::new(scratch.0.join("runs")),
        port: HostPort::new(Vec::new(), tx),
        launch,
        scratch,
      }
    }

    fn signin(&self, outcome: SigninOutcome) -> QueueWatchingSignIn {
      QueueWatchingSignIn {
        queue: self.queue.clone(),
        jobs_seen: Mutex::new(None),
        outcome,
        retries: Vec::new(),
      }
    }

    async fn drive(
      &self,
      launcher: &CountingLauncher,
      signin: &QueueWatchingSignIn,
      queue_wait: Duration,
    ) -> AgentRun {
      let timing = Timing {
        queue_wait,
        run_budget: Duration::from_secs(1),
        completion_grace: Duration::from_secs(1),
        job_grace: Duration::from_secs(1),
        poll: Duration::from_millis(10),
      };
      let job = NewJob::agent("ux-browser", "prompt")
        .producer(PRODUCER)
        .request("s1");
      drive(
        &self.queue,
        job,
        launcher,
        &self.launch,
        &self.logger,
        &self.port,
        "s1",
        &timing,
        Some(PreSignin {
          signer: signin,
          out_dir: self.scratch.0.join("google-signin"),
          workspace: self.scratch.0.join("agent"),
        }),
        None,
      )
      .await
    }
  }

  /// Review L34 F3 (operator, Q12): a pre-step that needed its one retry says
  /// so in agent.json, and one that did not carries no such field.
  #[tokio::test]
  async fn a_retried_pre_step_is_in_agent_json() {
    let rig = DriveRig::new();
    let retry = SigninRetry {
      provider: "google-signin",
      signal: libc::SIGSEGV,
      elapsed_ms: 21,
    };
    let signin = QueueWatchingSignIn {
      retries: vec![retry.clone()],
      ..rig.signin(SigninOutcome::Blocked {
        blocker: "google-signin-needs-human".into(),
        line: "google-signin: needs-human challenge-totp".into(),
      })
    };
    let launcher = CountingLauncher::default();
    let run = rig.drive(&launcher, &signin, Duration::from_secs(2)).await;
    assert_eq!(run.signin_retries, [retry]);
    let record = AgentRecord::new(
      &run,
      "signin-blocked",
      None,
      None,
      "r".into(),
      Path::new("/w"),
    );
    let json = serde_json::to_value(&record).unwrap();
    assert_eq!(
      json["signinRetries"],
      serde_json::json!([{"provider": "google-signin", "signal": 11, "elapsedMs": 21}])
    );

    let plain = rig.signin(SigninOutcome::Blocked {
      blocker: "google-signin-needs-human".into(),
      line: "google-signin: needs-human challenge-totp".into(),
    });
    let run = rig.drive(&launcher, &plain, Duration::from_secs(2)).await;
    let record = AgentRecord::new(
      &run,
      "signin-blocked",
      None,
      None,
      "r".into(),
      Path::new("/w"),
    );
    let json = serde_json::to_value(&record).unwrap();
    assert!(json.get("signinRetries").is_none(), "{json}");
  }

  #[tokio::test]
  async fn the_sign_in_runs_before_any_job_exists_and_a_blocked_one_enqueues_none() {
    let rig = DriveRig::new();
    let signin = rig.signin(SigninOutcome::Blocked {
      blocker: "google-signin-needs-human".into(),
      line: "google-signin: needs-human challenge-totp".into(),
    });
    let launcher = CountingLauncher::default();
    let run = rig.drive(&launcher, &signin, Duration::from_secs(2)).await;
    // No job existed while the private DevTools port was open, and none after.
    assert_eq!(*signin.jobs_seen.lock().unwrap(), Some(0));
    assert!(rig.queue.history().await.unwrap().is_empty());
    assert!(run.job_id.is_none());
    assert!(matches!(
      run.end,
      AgentEnd::SigninBlocked { ref blocker, .. } if blocker == "google-signin-needs-human"
    ));
    assert_eq!(run.canceled, Some("google-signin"));
    assert_eq!(
      run.signin.as_deref(),
      Some("google-signin: needs-human challenge-totp")
    );
    // Only the pre-step's browser started.
    assert_eq!(launcher.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    // The drive let go of the profile (the wait: see the lock test above).
    assert!(
      ProfileLock::acquire(
        &rig.launch.user_data_dir,
        Duration::from_secs(2),
        Duration::from_millis(10)
      )
      .await
      .unwrap()
      .is_some()
    );
  }

  #[tokio::test]
  async fn a_profile_another_run_holds_ends_the_wait_before_any_sign_in_or_job() {
    let rig = DriveRig::new();
    let _other_run = ProfileLock::acquire(
      &rig.launch.user_data_dir,
      Duration::ZERO,
      Duration::from_millis(10),
    )
    .await
    .unwrap()
    .expect("a free profile");
    let signin = rig.signin(SigninOutcome::Proceed {
      line: "google-signin: already-signed-in".into(),
    });
    let launcher = CountingLauncher::default();
    let run = rig
      .drive(&launcher, &signin, Duration::from_millis(100))
      .await;
    assert!(matches!(run.end, AgentEnd::TimedOut { phase: "queued" }));
    assert_eq!(run.canceled, Some("profile-wait"));
    assert_eq!(*signin.jobs_seen.lock().unwrap(), None);
    assert_eq!(launcher.0.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(rig.queue.history().await.unwrap().is_empty());
  }

  #[test]
  fn the_sink_is_scoped_to_the_launch_host_as_well_as_the_manifest() {
    let plan = sink_plan(Path::new("/runs/s1"));
    // Already the app's: nothing added.
    assert_eq!(
      plan
        .with_launch_host("https://rc.lona.so/?ux=s1")
        .app_domains,
      ["lona.so", "*.lona.so"]
    );
    // A corpus with no domains is scoped to the app it launched.
    let bare = HarnessSinkPlan {
      app_domains: Vec::new(),
      ..plan.clone()
    };
    assert_eq!(
      bare
        .with_launch_host("https://user@RC.Example.test:8443/signin?ux=s1")
        .app_domains,
      ["rc.example.test", "*.rc.example.test"]
    );
    assert_eq!(
      bare.with_launch_host("http://127.0.0.1:4000/").app_domains,
      ["127.0.0.1"]
    );
    assert!(bare.with_launch_host("not a url").app_domains.is_empty());
  }

  fn sink_plan(root: &Path) -> HarnessSinkPlan {
    HarnessSinkPlan {
      session_id: "2026-09-26_onboarding_abc123".into(),
      run_dir: root.to_path_buf(),
      app_domains: vec!["lona.so".into(), "*.lona.so".into()],
      out_dir: root.join("harness-sink"),
      workspace: root.join("agent"),
    }
  }

  #[test]
  fn the_sink_runs_on_devtools_alone_and_touches_only_the_session_files() {
    let plan = sink_plan(Path::new("/runs/s1"));
    let command = DenoHarnessSink::default().command(9333, &plan);
    let args: Vec<String> = command
      .as_std()
      .get_args()
      .map(|arg| arg.to_string_lossy().into_owned())
      .collect();
    assert_eq!(
      args,
      [
        "run",
        "--no-prompt",
        "--cached-only",
        "--no-config",
        "--no-lock",
        "--allow-net=127.0.0.1:9333",
        "--allow-read=/runs/s1/session.json,/runs/s1/logs.ljson",
        "--allow-write=/runs/s1/session.json,/runs/s1/logs.ljson,/runs/s1/complete.json",
        "/runs/s1/harness-sink/harness-sink.deno.ts",
        "http://127.0.0.1:9333",
        "2026-09-26_onboarding_abc123",
        "/runs/s1",
        "lona.so",
        "*.lona.so",
      ]
    );
    assert!(!args.iter().any(|arg| arg == "-A" || arg == "--allow-all"));
  }

  #[test]
  fn the_sink_is_ready_on_its_ready_line_even_after_posts_followed_it() {
    assert_eq!(sink_readiness(""), None);
    assert_eq!(sink_readiness("deno noise\n"), None);
    assert_eq!(
      sink_readiness("harness-sink: ready\nharness-sink: sunk /_/ux-test/logs\n"),
      Some(Ok(()))
    );
    assert_eq!(
      sink_readiness("harness-sink: error connect refused\n"),
      Some(Err("harness-sink: error connect refused".into()))
    );
  }

  /// A scratch dir for a sidecar stand-in, removed on drop.
  struct SinkScratch(PathBuf);

  impl SinkScratch {
    fn new() -> Self {
      // Not under a temp dir, so its fake deno passes the layout check; with
      // the agent's work dir beside the sidecar's, as a run has it.
      let dir = std::fs::canonicalize(test_scratch_dir("ux-harness-sink")).unwrap();
      std::fs::create_dir_all(dir.join("agent")).unwrap();
      Self(dir)
    }

    /// A stand-in for `deno` that checks the embedded files were written
    /// where its argv says, then runs `body`.
    fn fake_deno(&self, body: &str) -> PathBuf {
      let path = self.0.join("fake-deno");
      write_executable(
        &path,
        &format!(
          "#!/bin/sh\nscript=\"$9\"\ntest -f \"$script\" || exit 9\n\
           test -f \"$(dirname \"$script\")/{HARNESS_SINK_LIB}\" || exit 9\n{body}\n"
        ),
      );
      path
    }
  }

  impl Drop for SinkScratch {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn sidecar(deno: PathBuf) -> DenoHarnessSink {
    DenoHarnessSink {
      deno,
      ready_within: Duration::from_secs(5),
    }
  }

  #[tokio::test]
  async fn a_ready_sidecar_is_kept_running_until_it_is_stopped() {
    let scratch = SinkScratch::new();
    let plan = sink_plan(&scratch.0);
    let deno = scratch.fake_deno("echo 'harness-sink: ready'\nexec sleep 30");
    let mut guard = sidecar(deno).start(9333, &plan).await.expect("ready");
    // The embedded sidecar was written for the run, byte for byte.
    assert_eq!(
      std::fs::read_to_string(plan.out_dir.join(HARNESS_SINK_SCRIPT)).unwrap(),
      HARNESS_SINK_SOURCE
    );
    assert_eq!(
      std::fs::read_to_string(plan.out_dir.join(HARNESS_SINK_LIB)).unwrap(),
      HARNESS_SINK_LIB_SOURCE
    );
    // Still running: `exited` does not resolve.
    assert!(
      tokio::time::timeout(Duration::from_millis(200), guard.exited())
        .await
        .is_err()
    );
    guard.shutdown().await;
  }

  #[tokio::test]
  async fn a_sidecar_that_says_error_or_exits_first_or_never_answers_is_refused() {
    let scratch = SinkScratch::new();
    let plan = sink_plan(&scratch.0);
    let error =
      sidecar(scratch.fake_deno("echo 'harness-sink: error connect ECONNREFUSED'\nexec sleep 30"))
        .start(9333, &plan)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
      error.starts_with("harness-sink: error connect ECONNREFUSED"),
      "{error}"
    );

    let error = sidecar(scratch.fake_deno("exit 1"))
      .start(9333, &plan)
      .await
      .err()
      .unwrap()
      .to_string();
    assert!(error.contains("before ready"), "{error}");

    let mut slow = sidecar(scratch.fake_deno("exec sleep 30"));
    slow.ready_within = Duration::from_millis(300);
    let error = slow.start(9333, &plan).await.err().unwrap().to_string();
    assert!(error.contains("not ready within"), "{error}");

    let error = sidecar(scratch.0.join("no-such-deno"))
      .start(9333, &plan)
      .await
      .err()
      .unwrap();
    assert!(
      format!("{error:#}").contains("is `deno` on PATH"),
      "{error:#}"
    );
  }

  /// OQ-1 (review O-5c): the sidecar writes the files that decide the run's
  /// result, so its deno gets the layout check too, over the env it is
  /// spawned with. A deno, a cache or the sidecar's own dir in the agent's
  /// work dir, or a deno under a temp dir, is refused before anything is
  /// written or spawned.
  #[tokio::test]
  async fn the_harness_sink_refuses_to_spawn_a_deno_that_loads_from_the_work_dir() {
    let scratch = SinkScratch::new();
    let plan = sink_plan(&scratch.0);
    let marker = scratch.0.join("spawned");
    let seen = scratch.0.join("deno-dir.txt");
    let outside = scratch.fake_deno(&format!(
      "touch '{}'\nprintf %s \"$DENO_DIR\" > '{}'\necho 'harness-sink: ready'\nexec sleep 30",
      marker.display(),
      seen.display()
    ));
    let parent: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let nothing_ran = |plan: &HarnessSinkPlan| {
      assert!(!marker.exists(), "deno was spawned");
      assert!(!plan.out_dir.exists(), "the sidecar was written");
    };

    let planted = plan.workspace.join("deno");
    std::fs::copy(&outside, &planted).unwrap();
    let error = format!(
      "{:#}",
      sidecar(planted.clone())
        .start(9333, &plan)
        .await
        .err()
        .expect("a deno in the work dir is refused")
    );
    assert!(
      error.starts_with("harness-sink: error refusing to run deno: the deno binary"),
      "{error}"
    );
    assert!(error.contains(&planted.display().to_string()), "{error}");
    assert!(error.contains("inside the agent work dir"), "{error}");
    nothing_ran(&plan);

    // A cache in the work dir, in the env the child would get.
    let inner_cache = plan.workspace.join("cache");
    let error = format!(
      "{:#}",
      sidecar(outside.clone())
        .spawn_with_env(9333, &plan, with_var(&parent, "DENO_DIR", &inner_cache))
        .await
        .err()
        .expect("a cache in the work dir is refused")
    );
    assert!(error.contains("DENO_DIR"), "{error}");
    assert!(
      error.contains(&inner_cache.display().to_string()),
      "{error}"
    );
    nothing_ran(&plan);

    // The sidecar's own dir in the work dir.
    let inside = HarnessSinkPlan {
      out_dir: plan.workspace.join("harness-sink"),
      ..plan.clone()
    };
    let error = format!(
      "{:#}",
      sidecar(outside.clone())
        .start(9333, &inside)
        .await
        .err()
        .expect("a sidecar dir in the work dir is refused")
    );
    assert!(error.contains("the sidecar's script dir"), "{error}");
    nothing_ran(&inside);

    // A deno under a temp dir.
    let in_tmp = Path::new("/var/tmp")
      .join(format!("ux-harness-sink-{}", rand::random::<u32>()))
      .join("deno");
    let error = format!(
      "{:#}",
      sidecar(in_tmp.clone())
        .start(9333, &plan)
        .await
        .err()
        .expect("a deno under /var/tmp is refused")
    );
    assert!(error.contains("refusing to run deno"), "{error}");
    assert!(error.contains(&in_tmp.display().to_string()), "{error}");
    assert!(error.contains("inside the temp dir"), "{error}");
    nothing_ran(&plan);

    // A sane layout spawns, with the env it was judged under.
    let cache = scratch.0.join("cache");
    let guard = sidecar(outside)
      .spawn_with_env(9333, &plan, with_var(&parent, "DENO_DIR", &cache))
      .await
      .expect("a sane sidecar starts");
    assert!(marker.exists());
    assert_eq!(
      std::fs::read_to_string(&seen).unwrap(),
      cache.display().to_string()
    );
    guard.shutdown().await;
  }

  /// Review L10 Z2: the sidecar's dir sits in the run dir (the ux-test log
  /// root), so a run dir under a temp dir fails the sink, and the error says
  /// that it is the run dir that is misplaced.
  #[tokio::test]
  async fn a_run_dir_under_a_temp_dir_fails_the_sink_and_names_the_run_dir() {
    let scratch = SinkScratch::new();
    let marker = scratch.0.join("spawned");
    let deno = scratch.fake_deno(&format!(
      "touch '{}'\necho 'harness-sink: ready'\nexec sleep 30",
      marker.display()
    ));
    let run_dir = Path::new("/var/tmp").join(format!("ux-run-{}", rand::random::<u32>()));
    let plan = HarnessSinkPlan {
      run_dir: run_dir.clone(),
      out_dir: run_dir.join("harness-sink"),
      ..sink_plan(&scratch.0)
    };
    let error = format!(
      "{:#}",
      sidecar(deno)
        .start(9333, &plan)
        .await
        .err()
        .expect("a run dir under /var/tmp is refused")
    );
    assert!(
      error.starts_with(
        "harness-sink: error refusing to run deno: the sidecar's script dir in the run dir"
      ),
      "{error}"
    );
    assert!(
      error.contains(&plan.out_dir.display().to_string()),
      "{error}"
    );
    assert!(error.contains("inside the temp dir /var/tmp"), "{error}");
    assert!(!marker.exists(), "deno was spawned");
    assert!(!run_dir.exists(), "the sidecar was written");
  }

  #[test]
  fn the_embedded_sidecar_is_the_runner_file_and_asks_only_for_harness_paths() {
    assert!(HARNESS_SINK_SOURCE.contains("from \"./lib/harness-sink.ts\""));
    assert!(HARNESS_SINK_SOURCE.contains("urlPattern: \"*/_/ux-test/*\""));
    assert!(HARNESS_SINK_LIB_SOURCE.contains("export async function sinkHarnessPost"));
    // The lib stands alone: the sidecar runs with `--no-config`.
    assert!(
      !HARNESS_SINK_LIB_SOURCE
        .lines()
        .any(|line| line.trim_start().starts_with("import "))
    );
    // Only Fetch: it never opens, closes, navigates or activates a page.
    for forbidden in ["Target.", "Page.", "Runtime.", "Emulation."] {
      assert!(
        !HARNESS_SINK_SOURCE
          .lines()
          .filter(|line| !line.trim_start().starts_with("//"))
          .any(|line| line.contains(forbidden)),
        "{forbidden}"
      );
    }
  }

  #[test]
  fn session_restore_state_goes_and_the_sign_in_stays() {
    let profile = SinkScratch::new();
    let default = profile.0.join("Default");
    let sessions = default.join("Sessions");
    std::fs::create_dir_all(sessions.join("nested")).unwrap();
    std::fs::write(sessions.join("Session_13400000000000000"), "tabs").unwrap();
    std::fs::write(sessions.join("Tabs_13400000000000000"), "tabs").unwrap();
    std::fs::write(sessions.join("nested").join("x"), "x").unwrap();
    for name in SESSION_RESTORE_FILES {
      std::fs::write(default.join(name), "legacy").unwrap();
    }
    let kept = [
      default.join("Cookies"),
      default.join("Login Data"),
      default.join("Preferences"),
      profile.0.join("Local State"),
    ];
    for path in &kept {
      std::fs::write(path, "keep").unwrap();
    }

    let removed = clear_session_restore(&profile.0).unwrap();
    assert_eq!(removed.len(), 3 + SESSION_RESTORE_FILES.len());
    // The directory stays (Chrome writes into it); its contents go.
    assert!(sessions.is_dir());
    assert_eq!(std::fs::read_dir(&sessions).unwrap().count(), 0);
    for name in SESSION_RESTORE_FILES {
      assert!(!default.join(name).exists(), "{name}");
    }
    for path in &kept {
      assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "keep",
        "{}",
        path.display()
      );
    }
    // A fresh profile has nothing to clear.
    let fresh = SinkScratch::new();
    assert!(clear_session_restore(&fresh.0).unwrap().is_empty());
  }

  #[test]
  fn the_launch_url_reaches_json_new_byte_for_byte() {
    assert_eq!(
      encode_query("https://rc--calendar.lona.so/trynow?promo=a%2Fb&ux=s1"),
      "https%3A%2F%2Frc--calendar.lona.so%2Ftrynow%3Fpromo%3Da%252Fb%26ux%3Ds1"
    );
  }

  /// A DevTools HTTP endpoint that answers `/json/new` with a new page, lists
  /// `pages` plus that one (and a service worker), and records every request.
  async fn fake_devtools(
    pages: Vec<(&'static str, &'static str)>,
  ) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
      loop {
        let Ok((mut stream, _)) = listener.accept().await else {
          return;
        };
        let mut buf = vec![0u8; 4096];
        let read = stream.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..read]).to_string();
        let line = request.lines().next().unwrap_or_default().to_string();
        log.lock().unwrap().push(line.clone());
        let body = if line.starts_with("PUT /json/new?") {
          serde_json::json!({"id": "NEW", "type": "page", "url": "about:blank"}).to_string()
        } else if line.starts_with("GET /json/list") {
          let mut list: Vec<Value> = pages
            .iter()
            .map(|(id, url)| serde_json::json!({"id": id, "type": "page", "url": url}))
            .collect();
          list.push(serde_json::json!({"id": "NEW", "type": "page", "url": "https://rc.example.test/?ux=s1"}));
          list.push(serde_json::json!({"id": "SW", "type": "service_worker", "url": "https://rc.example.test/sw.js"}));
          Value::Array(list).to_string()
        } else {
          "Target is closing".to_string()
        };
        let response = format!(
          "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
          body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
      }
    });
    (port, seen)
  }

  #[tokio::test]
  async fn the_launch_url_opens_alone_and_every_leftover_tab_closes() {
    let (port, seen) = fake_devtools(vec![
      ("BLANK", "about:blank"),
      ("OLD", "https://rc.example.test/signin?promo=x"),
    ])
    .await;
    let closed = open_alone(port, "https://rc.example.test/?ux=s1")
      .await
      .unwrap();
    assert_eq!(closed, 2);
    let seen = seen.lock().unwrap().clone();
    assert_eq!(
      seen,
      [
        "PUT /json/new?https%3A%2F%2Frc.example.test%2F%3Fux%3Ds1 HTTP/1.1",
        "GET /json/list HTTP/1.1",
        "GET /json/close/BLANK HTTP/1.1",
        "GET /json/close/OLD HTTP/1.1",
      ]
    );
  }

  #[tokio::test]
  async fn the_sign_in_browser_keeps_only_blank_pages() {
    let (port, seen) = fake_devtools(vec![("BLANK", "about:blank")]).await;
    // The fixture's extra page (NEW) is not blank: it goes, the blank stays.
    assert_eq!(
      close_pages(port, |t| t.url == "about:blank").await.unwrap(),
      1
    );
    assert_eq!(
      seen.lock().unwrap().last().unwrap(),
      "GET /json/close/NEW HTTP/1.1"
    );
  }

  #[test]
  fn the_embedded_script_is_the_runner_file() {
    assert!(GOOGLE_SIGNIN_SOURCE.contains("google-signin: already-signed-in"));
    assert!(GOOGLE_SIGNIN_SOURCE.contains("Deno.stdin"));
    // No evasion: a refusal is a result.
    for forbidden in ["setUserAgent", "Emulation.", "stealth"] {
      assert!(
        !GOOGLE_SIGNIN_SOURCE
          .lines()
          .filter(|line| !line.trim_start().starts_with("//"))
          .any(|line| line.contains(forbidden)),
        "{forbidden}"
      );
    }
  }
}
