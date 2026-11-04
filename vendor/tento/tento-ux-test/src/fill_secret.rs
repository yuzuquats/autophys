//! `fill_secret`: an agent-driven run's one way past Google's password page.
//!
//! The agent never types, reads or sees a password. When Google asks for
//! one, it asks the harness instead: it writes `fill-secret-<n>.request`
//! (`{"secret": "<name>"}`) into its workspace — the channel it already
//! writes `RESULT` and `NOTES.md` through — and reads the one-line answer
//! from `fill-secret-<n>.response`: `filled`, or `refused: <reason>`.
//!
//! The harness decides. [`check_allowed`] lets a name through only when it is
//! the Google password of THIS spec's account ([`FILLABLE`]); a Microsoft or
//! Stripe secret never is. Only then is the file read — by the same
//! [`crate::agent::read_password`] the sign-in pre-step uses, under the same
//! 0600 rule — and its bytes go to `fill-secret.deno.ts` on stdin, which
//! types them only into a focused, visible `input[type=password]` on a page
//! whose origin is exactly `https://accounts.google.com` (the script's own
//! refusals are tested beside it). The agent clicks Next itself.
//!
//! Every request is audited (`secret-fill <name> <origin> <run id>`, or
//! `secret-fill-refused <name> <reason> <run id>`) into the run's
//! `logs.ljson`, its log and `agent.json`. A filled value is kept in memory
//! only to be redacted, as a backstop, from everything the run writes
//! ([`FillSecretServer::scrub`], [`FillSecretServer::redact`]), and zeroed
//! when the run is over.
//!
//! The DevTools port the script types through is the agent's own, so the
//! agent COULD read the field after it is filled; the prompt forbids it.
//! That is the trade the operator approved on 2026-10-13 for the one screen
//! the sign-in pre-step cannot reach: the chooser's second account.
//!
//! The workspace is the agent's, so nothing the harness reads or writes
//! there may be a link the agent planted (review K-1, K-2). A request is
//! read only when it opens without following a link, as a regular file with
//! one link; anything else is refused unread. An answer is written to a
//! fresh temp file of the harness's own (`create_new`, no link followed) and
//! renamed into place, which replaces a planted entry instead of writing
//! through it. The typist's source never touches disk: deno runs it as a
//! `data:` URL, so there is no script file to swap between write and spawn,
//! and its log is opened without following a link. A refusal and the audit
//! name a secret only when it is on [`FILLABLE`] (review K-3).
//!
//! ## Why deno's permissions are scoped this way (review K-11, X-D2)
//!
//! This typist and both sign-in pre-steps ([`crate::agent::DenoSignin`]) are
//! handed a password, so what their deno runs must not be anything the agent
//! could have written. Their flags keep deno itself out of the agent's work
//! dir. The typist gets no file access at all and network only to the
//! agent's DevTools port. A pre-step reads and writes only its own directory
//! beside the run. Neither inherits more than
//! [`crate::agent::SIGNIN_ENV_ALLOWLIST`].
//!
//! The flags do not cover what deno LOADS: the runner's `deno.json` and
//! `node_modules`, `DENO_DIR` (npm and remote module caches, emitted JS, the
//! V8 code cache) and the binary. npm loads are not lockfile-pinned. Deno
//! checks an npm package's integrity only when it extracts the tarball,
//! never when it loads an extracted copy, so an edited `node_modules` or npm
//! cache loads even under `--frozen --lock` (lane X's K-11 probes).
//!
//! So the harness rests on an allow-workspace assumption: the agent writes
//! only its work dir. tsh's `allow-workspace` rule confines an ACP agent's
//! file tools, `mkdir` and `deno run --allow-write` to the lane cwd, which
//! is the work dir. A Codex lane's `workspace-write` sandbox lets the agent
//! write its cwd, `/tmp`, `$TMPDIR` and the configured `writable_roots`.
//! [`crate::agent::deno_outside_workspace`] makes the layout half of that
//! assumption fail closed. Before each spawn it resolves the runner dir, its
//! `deno.json` and `node_modules`, the child's `DENO_DIR` (deno's default
//! when unset) and the deno binary (the one on the child's `PATH`). Links
//! are followed hop by hop, each judged by its own location too (review
//! O-3), and a missing path is judged by its deepest existing ancestor. A
//! root the agent may write that sits inside one of them is refused as well
//! (review L10 Z3). If any of them lands inside the work dir, or inside a temp dir
//! a Codex sandbox also opens (the child's `TMPDIR`, or the platform default
//! when it is unset; the harness's own `TMPDIR`, which the agent lane's temp
//! dir lives under, review L10 Z1; `/tmp`, `/var/tmp`, `/private/tmp`,
//! `/private/var/folders`, `/var/folders`; operator decision OQ-1), the step
//! fails with an error naming the path, what it is and the root it is
//! under. Nothing is spawned or written, a pre-step has not yet read its
//! password file, and the typist's secret (already read by the server) goes
//! no further. The harness sink ([`crate::agent::DenoHarnessSink`]) gets no
//! password, but it writes the files that decide the run's result, so the
//! same check runs before it starts, over its sidecar's dir instead of a
//! runner ([`crate::agent::deno_script_outside_workspace`]).
//!
//! It does not guarantee the CONTENTS of those directories; that is the
//! sandbox's job. A lane that lets the agent write outside its work dir and
//! the temp dirs defeats it: a shell, `danger-full-access`, or writable
//! roots that cover the runner, `DENO_DIR` or the binary. Such an agent can
//! already read the password files directly. The remedy there is a
//! harness-private runner install (X-D2 option b), not a stronger check here.

use std::convert::Infallible;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};

use crate::session::LLMLogger;

/// The directory holding the fillable secret files, by name (mode 0600,
/// outside every repo; only its PATH is ever in the environment). Unset ⇒
/// the directory of [`crate::agent::GOOGLE_PASSWORD_FILE_ENV`]'s file, which
/// is where the host keeps them. Neither ⇒ every request is refused.
pub const FILL_SECRET_DIR_ENV: &str = "UX_FILL_SECRET_DIR";
/// The typing script's file name in the runner. The harness never writes it
/// out: deno gets [`FILL_SECRET_SOURCE`] as a `data:` URL ([`typist_module`]).
pub const FILL_SECRET_SCRIPT: &str = "fill-secret.deno.ts";
/// The script, embedded for the sign-in script's reason: the one that runs is
/// the one this binary was reviewed with.
pub const FILL_SECRET_SOURCE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../tento-ux-runner/fill-secret.deno.ts"
));
/// The prefix of the script's one stdout status line.
pub const FILL_SECRET_STATUS: &str = "fill-secret:";
/// The typist's log directory beside the run — never in the agent's workspace.
pub const FILL_SECRET_OUT_DIR: &str = "fill-secret";
/// `fill-secret-<n>.request` in the agent's workspace asks; the harness
/// answers in `fill-secret-<n>.response` beside it.
pub const REQUEST_PREFIX: &str = "fill-secret-";
pub const REQUEST_SUFFIX: &str = ".request";
pub const RESPONSE_SUFFIX: &str = ".response";
/// The only origin a secret is ever typed on.
pub const GOOGLE_ORIGIN: &str = "https://accounts.google.com";
/// What a redacted value reads as.
pub const REDACTED: &str = "[redacted]";
/// What a refusal and the audit say instead of a name off [`FILLABLE`]: the
/// agent's own text is never echoed (review K-3).
pub const UNKNOWN_NAME: &str = "<unknown-name>";
/// The audit's name for a request that was not a plain file of the agent's
/// own, and was refused unread (review K-1).
pub const UNREADABLE_REQUEST: &str = "<unreadable-request>";
/// The most a request file may hold.
const MAX_REQUEST_BYTES: u64 = 4096;
/// Requests one run may make, refusals included. A sign-in is tried at most
/// twice; this leaves room for one wrong field and nothing like a loop.
pub const MAX_REQUESTS: usize = 4;

/// Every fillable secret, and the one account it may be filled for.
pub const FILLABLE: &[(&str, &str)] = &[
  ("operator-tester.google-password", "operator-tester@lona.so"),
  ("l3thal.cow.google-password", "l3thal.cow@gmail.com"),
];

/// The secret the agent may ask for when it drives `account`, if any — what
/// the prompt names.
pub fn secret_for_account(account: Option<&str>) -> Option<&'static str> {
  let account = account?.trim();
  FILLABLE
    .iter()
    .find(|(_, owner)| owner.eq_ignore_ascii_case(account))
    .map(|(name, _)| *name)
}

/// Whether the agent driving `account` may have `name` filled. `Err` is the
/// refusal's reason, sent back to the agent as is; it names `name` only when
/// `name` is on [`FILLABLE`].
pub fn check_allowed(name: &str, account: Option<&str>) -> std::result::Result<(), String> {
  let valid = !name.is_empty()
    && name.len() <= 128
    && !name.starts_with('.')
    && name
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
  if !valid {
    return Err("invalid-secret-name".to_string());
  }
  let lower = name.to_ascii_lowercase();
  if lower.contains("microsoft") || lower.contains("stripe") {
    return Err(format!("never-fillable {UNKNOWN_NAME}"));
  }
  let Some((_, owner)) = FILLABLE.iter().find(|(known, _)| *known == name) else {
    return Err(format!("unknown-secret {UNKNOWN_NAME}"));
  };
  match account.map(str::trim).filter(|account| !account.is_empty()) {
    Some(account) if account.eq_ignore_ascii_case(owner) => Ok(()),
    Some(account) => Err(format!("not-allowlisted {name} for {account}")),
    None => Err(format!("not-allowlisted {name} for no account")),
  }
}

/// `name` as a refusal or the audit may show it: itself when it is on
/// [`FILLABLE`], else [`UNKNOWN_NAME`].
pub fn shown_name(name: &str) -> &str {
  if FILLABLE.iter().any(|(known, _)| *known == name) {
    name
  } else {
    UNKNOWN_NAME
  }
}

/// [`FILL_SECRET_DIR_ENV`]'s value, else the Google password file's directory.
pub fn secret_dir_from(dir: Option<String>, google_file: Option<String>) -> Option<PathBuf> {
  let set = |raw: Option<String>| {
    raw
      .map(|raw| raw.trim().to_string())
      .filter(|raw| !raw.is_empty())
  };
  set(dir)
    .map(PathBuf::from)
    .or_else(|| set(google_file).and_then(|file| Path::new(&file).parent().map(Path::to_path_buf)))
}

/// [`secret_dir_from`] over this process's environment.
pub fn secret_dir_from_env() -> Option<PathBuf> {
  secret_dir_from(
    std::env::var(FILL_SECRET_DIR_ENV).ok(),
    std::env::var(crate::agent::GOOGLE_PASSWORD_FILE_ENV).ok(),
  )
}

/// The secret's file in `dir`, checked as the sign-in pre-step checks its
/// own: a regular file nobody but its owner can read.
fn secret_file(dir: &Path, name: &str) -> std::result::Result<PathBuf, String> {
  use std::os::unix::fs::PermissionsExt;
  let path = dir.join(name);
  let meta = std::fs::metadata(&path).map_err(|_| format!("secret-unavailable {name}"))?;
  if !meta.is_file() {
    return Err(format!("secret-unavailable {name}"));
  }
  if meta.permissions().mode() & 0o077 != 0 {
    return Err(format!("secret-file-not-0600 {name}"));
  }
  Ok(path)
}

/// What one request came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FillOutcome {
  Filled { origin: String },
  Refused { reason: String },
}

impl FillOutcome {
  /// The one line the agent reads back.
  pub fn response(&self) -> String {
    match self {
      Self::Filled { .. } => "filled".to_string(),
      Self::Refused { reason } => format!("refused: {reason}"),
    }
  }
}

/// Decide from the script's exit and stdout. Only its LAST
/// `fill-secret:` line counts, and `filled` counts only with exit 0 and
/// Google's origin. No line at all names the exit code or the signal.
pub fn fill_outcome(exit: impl Into<crate::agent::ChildExit>, stdout: &str) -> FillOutcome {
  let exit = exit.into();
  let Some(line) = stdout
    .lines()
    .rev()
    .map(str::trim)
    .find(|line| line.starts_with(FILL_SECRET_STATUS))
  else {
    return FillOutcome::Refused {
      reason: format!("fill-error no-status ({})", exit.label()),
    };
  };
  let rest: String = line[FILL_SECRET_STATUS.len()..]
    .trim()
    .chars()
    .take(240)
    .collect();
  let mut words = rest.splitn(2, ' ');
  let kind = words.next().unwrap_or_default();
  let detail = words.next().unwrap_or_default().trim();
  match (kind, exit.code()) {
    ("filled", Some(0)) if detail == GOOGLE_ORIGIN => FillOutcome::Filled {
      origin: GOOGLE_ORIGIN.to_string(),
    },
    ("refused", _) => FillOutcome::Refused {
      reason: detail.to_string(),
    },
    _ => FillOutcome::Refused {
      reason: format!("fill-error {rest}"),
    },
  }
}

/// The values this run filled, held only to redact them, zeroed on drop.
#[derive(Default)]
struct Redactor {
  secrets: Vec<Vec<u8>>,
}

impl Redactor {
  fn add(&mut self, secret: &[u8]) {
    if !secret.is_empty() && !self.secrets.iter().any(|known| known == secret) {
      self.secrets.push(secret.to_vec());
    }
  }

  /// `bytes` with every secret replaced, or `None` when none occurs.
  fn redact_bytes(&self, bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out: Option<Vec<u8>> = None;
    for secret in &self.secrets {
      let current = out.as_deref().unwrap_or(bytes);
      if let Some(replaced) = replace_all(current, secret, REDACTED.as_bytes()) {
        out = Some(replaced);
      }
    }
    out
  }
}

impl Drop for Redactor {
  fn drop(&mut self) {
    for secret in &mut self.secrets {
      secret.fill(0);
    }
  }
}

/// `haystack` with every `needle` replaced by `with`; `None` when there is none.
fn replace_all(haystack: &[u8], needle: &[u8], with: &[u8]) -> Option<Vec<u8>> {
  if needle.is_empty() || haystack.len() < needle.len() {
    return None;
  }
  let mut out = Vec::with_capacity(haystack.len());
  let mut found = false;
  let mut i = 0;
  while i < haystack.len() {
    if haystack[i..].starts_with(needle) {
      out.extend_from_slice(with);
      i += needle.len();
      found = true;
    } else {
      out.push(haystack[i]);
      i += 1;
    }
  }
  found.then_some(out)
}

/// Files the backstop does not rewrite: pixel captures hold no text, and a
/// password field only ever paints as dots.
fn is_image(path: &Path) -> bool {
  matches!(
    path
      .extension()
      .and_then(|ext| ext.to_str())
      .map(str::to_ascii_lowercase)
      .as_deref(),
    Some("png" | "jpg" | "jpeg" | "webp" | "gif")
  )
}

/// Types a secret into the agent's browser. A seam so the server is tested
/// without Deno, a browser or Google.
#[async_trait]
pub trait TypeSecret: Send + Sync {
  /// `out_dir` receives the script's stderr log — never the secret.
  /// `workspace` is the agent's work dir: the real typist refuses to run a
  /// deno that would load code from inside it
  /// ([`crate::agent::deno_outside_workspace`]).
  async fn type_secret(
    &self,
    devtools_port: u16,
    secret: &[u8],
    out_dir: &Path,
    workspace: &Path,
  ) -> FillOutcome;
}

/// The typist's main module: [`FILL_SECRET_SOURCE`] as a percent-encoded
/// `data:` URL. Its source goes to deno in argv (it holds no secret), so no
/// script file exists for anyone to swap between the write and the spawn
/// (review K-2) — the code that receives the secret is the reviewed one.
pub fn typist_module() -> String {
  use std::fmt::Write;
  let mut url = String::with_capacity(32 + FILL_SECRET_SOURCE.len() * 2);
  url.push_str("data:application/typescript,");
  for byte in FILL_SECRET_SOURCE.bytes() {
    if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
      url.push(char::from(byte));
    } else {
      let _ = write!(url, "%{byte:02X}");
    }
  }
  url
}

/// The real typist: `deno run` of [`typist_module`] under the runner's
/// `deno.json`, cached modules only, network only to the agent's DevTools
/// port, no file access, the secret on stdin, and nothing of this process's
/// environment but [`crate::agent::SIGNIN_ENV_ALLOWLIST`].
#[derive(Clone, Debug)]
pub struct DenoTypeSecret {
  pub deno: PathBuf,
  /// The runner's `deno.json`; `None` when this host has no runner.
  pub deno_config: Option<PathBuf>,
  pub timeout: Duration,
}

impl DenoTypeSecret {
  pub fn new(runner_dir: Option<&Path>) -> Self {
    Self {
      deno: PathBuf::from("deno"),
      deno_config: runner_dir.and_then(|dir| std::fs::canonicalize(dir.join("deno.json")).ok()),
      // The script's DevTools calls time out at 30 s; this is the kill behind it.
      timeout: Duration::from_secs(60),
    }
  }

  /// The child's command line over an explicit parent environment. Nothing
  /// about the secret is in its argv or its env — and not `DEBUG`, under
  /// which puppeteer-core would log every key it sends.
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
      .arg("--allow-env")
      .arg(typist_module())
      .arg(format!("http://127.0.0.1:{devtools_port}"))
      .arg(out_dir)
      .env_clear()
      .envs(crate::agent::signin_env(parent_env))
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .kill_on_drop(true);
    command
  }

  async fn run(
    &self,
    devtools_port: u16,
    secret: &[u8],
    out_dir: &Path,
    workspace: &Path,
  ) -> Result<FillOutcome> {
    let deno_config = self
      .deno_config
      .as_deref()
      .context("this host has no ux runner deno.json to run the fill script under")?;
    // X-D2: nothing this deno loads may sit where the agent writes. Checked
    // before anything is written or spawned, over the child's own environment.
    let parent_env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let child_env = crate::agent::signin_env(parent_env.iter().cloned());
    crate::agent::deno_outside_workspace(
      workspace,
      &self.deno,
      deno_config,
      &child_env,
      &parent_env,
    )?;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    std::fs::create_dir_all(out_dir).with_context(|| format!("create {}", out_dir.display()))?;
    // The log goes only into a directory of the harness's own, never through
    // a link (or a second name of another file) planted in its place.
    let dir = std::fs::symlink_metadata(out_dir)
      .with_context(|| format!("inspect {}", out_dir.display()))?;
    anyhow::ensure!(
      dir.is_dir(),
      "{} is not a plain directory",
      out_dir.display()
    );
    let log_path = out_dir.join("fill-secret.log");
    let log = std::fs::OpenOptions::new()
      .create(true)
      .append(true)
      .mode(0o600)
      .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
      .open(&log_path)
      .with_context(|| format!("open {} without following a link", log_path.display()))?;
    let meta = log
      .metadata()
      .with_context(|| format!("inspect {}", log_path.display()))?;
    anyhow::ensure!(
      meta.is_file() && meta.nlink() == 1,
      "{} is not a plain file of the harness's own",
      log_path.display()
    );
    let mut command = self.command_with_env(deno_config, devtools_port, out_dir, parent_env);
    command.stderr(Stdio::from(log));
    let mut child = command
      .spawn()
      .with_context(|| format!("spawn {} (is `deno` on PATH?)", self.deno.display()))?;
    if let Some(mut stdin) = child.stdin.take() {
      let _ = stdin.write_all(secret).await;
      let _ = stdin.shutdown().await;
    }
    Ok(
      match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
        Ok(output) => {
          let output = output.context("wait for the fill script")?;
          fill_outcome(output.status, &String::from_utf8_lossy(&output.stdout))
        }
        Err(_) => FillOutcome::Refused {
          reason: format!("fill-error the script ran past {}s", self.timeout.as_secs()),
        },
      },
    )
  }
}

#[async_trait]
impl TypeSecret for DenoTypeSecret {
  async fn type_secret(
    &self,
    devtools_port: u16,
    secret: &[u8],
    out_dir: &Path,
    workspace: &Path,
  ) -> FillOutcome {
    match self.run(devtools_port, secret, out_dir, workspace).await {
      Ok(outcome) => outcome,
      Err(error) => FillOutcome::Refused {
        reason: format!("fill-error {error:#}"),
      },
    }
  }
}

/// Where audit lines go in the run's `logs.ljson`.
pub struct AuditTrace<'a> {
  pub logger: &'a LLMLogger,
  pub tracing_uuid: uuid::Uuid,
}

/// One run's fill service: whose secrets, which browser, which workspace.
pub struct FillSecretPlan<'a> {
  /// Where the secret files live; `None` ⇒ every request is refused.
  pub secret_dir: Option<PathBuf>,
  /// The spec's `params.user_email` — the only account a secret is filled for.
  pub account: Option<String>,
  /// The run id (session id), for the audit lines.
  pub run_id: String,
  /// The agent's workspace, where requests arrive and answers are written.
  pub work_dir: PathBuf,
  /// The script's directory beside the run.
  pub out_dir: PathBuf,
  /// The agent's browser.
  pub devtools_port: u16,
  /// `logs.ljson`, when the run has a session to append to.
  pub trace: Option<AuditTrace<'a>>,
}

/// Answers the agent's `fill_secret` requests for one run, and keeps what it
/// filled for the redaction backstop.
pub struct FillSecretServer<'a> {
  plan: FillSecretPlan<'a>,
  typer: &'a dyn TypeSecret,
  requests: Mutex<usize>,
  /// Requests already served, by path: each is served at most once.
  served: Mutex<std::collections::HashSet<PathBuf>>,
  redactor: Mutex<Redactor>,
  audit: Mutex<Vec<String>>,
}

impl<'a> FillSecretServer<'a> {
  pub fn new(plan: FillSecretPlan<'a>, typer: &'a dyn TypeSecret) -> Self {
    Self {
      plan,
      typer,
      requests: Mutex::new(0),
      served: Mutex::default(),
      redactor: Mutex::default(),
      audit: Mutex::default(),
    }
  }

  /// Fill `name` if it may be filled, and audit the request either way.
  pub async fn handle(&self, name: &str) -> FillOutcome {
    let outcome = if self.over_budget() {
      too_many_requests()
    } else {
      self.fill(name).await
    };
    self.record(shown_name(name), outcome)
  }

  /// Refuse, unread, a request that is not a plain file of the agent's own,
  /// and audit it. It counts against the budget like any other request.
  fn refuse_unreadable(&self) -> FillOutcome {
    let outcome = if self.over_budget() {
      too_many_requests()
    } else {
      FillOutcome::Refused {
        reason: "unreadable-request".to_string(),
      }
    };
    self.record(UNREADABLE_REQUEST, outcome)
  }

  /// Count one request; whether it is past [`MAX_REQUESTS`].
  fn over_budget(&self) -> bool {
    let mut requests = self.requests.lock().unwrap();
    *requests += 1;
    *requests > MAX_REQUESTS
  }

  /// Audit `outcome` under `shown`, which is never a name off [`FILLABLE`].
  fn record(&self, shown: &str, outcome: FillOutcome) -> FillOutcome {
    let line = match &outcome {
      FillOutcome::Filled { origin } => {
        format!("secret-fill {shown} {origin} {}", self.plan.run_id)
      }
      FillOutcome::Refused { reason } => {
        format!("secret-fill-refused {shown} {reason} {}", self.plan.run_id)
      }
    };
    let line = self.redact(&line);
    info!("  {line}");
    self.trace(&line);
    self.audit.lock().unwrap().push(line);
    outcome
  }

  async fn fill(&self, name: &str) -> FillOutcome {
    let refused = |reason: String| FillOutcome::Refused { reason };
    if let Err(reason) = check_allowed(name, self.plan.account.as_deref()) {
      return refused(reason);
    }
    let Some(dir) = &self.plan.secret_dir else {
      return refused("no-secret-dir on this host".to_string());
    };
    let path = match secret_file(dir, name) {
      Ok(path) => path,
      Err(reason) => return refused(reason),
    };
    let mut secret = match crate::agent::read_password(&path) {
      Ok(secret) if !secret.is_empty() => secret,
      _ => return refused(format!("secret-unavailable {name}")),
    };
    let outcome = self
      .typer
      .type_secret(
        self.plan.devtools_port,
        &secret,
        &self.plan.out_dir,
        &self.plan.work_dir,
      )
      .await;
    if matches!(outcome, FillOutcome::Filled { .. }) {
      self.redactor.lock().unwrap().add(&secret);
    }
    // Belt and braces: an answer never carries the value.
    let outcome = match outcome {
      FillOutcome::Refused { reason } => {
        let mut probe = Redactor::default();
        probe.add(&secret);
        let reason = match probe.redact_bytes(reason.as_bytes()) {
          Some(clean) => String::from_utf8_lossy(&clean).into_owned(),
          None => reason,
        };
        FillOutcome::Refused { reason }
      }
      filled => filled,
    };
    secret.fill(0);
    outcome
  }

  /// The audit line as an info entry in `logs.ljson`. Best effort: the run's
  /// own log and `agent.json` carry it too.
  fn trace(&self, line: &str) {
    let Some(trace) = &self.plan.trace else {
      return;
    };
    let entry = serde_json::json!({
      "v": 1,
      "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
      "sessionId": trace.tracing_uuid,
      "origin": "harness",
      "rootSpan": {
        "id": 0,
        "name": "ux-test/secret-fill",
        "level": "info",
        "durationMs": 0,
        "location": {},
        "attributes": { "message": line },
        "children": [],
      },
    });
    if let Err(error) = trace
      .logger
      .append_ljson_entries(&self.plan.run_id, &[entry])
    {
      warn!("could not append the secret-fill audit to logs.ljson: {error:#}");
    }
  }

  /// Answer every request in the workspace that has no answer yet. Returns
  /// how many it answered.
  ///
  /// Every entry named like a request is answered, whatever it is, but only
  /// a plain file of the agent's own is read ([`read_request`]); a link, a
  /// FIFO or a directory is refused unread (review K-1). The answer is
  /// written only to a fresh file of the harness's own and renamed into
  /// place, and an existing `.response` of any kind counts as the answer, so
  /// nothing is ever written through a link the agent planted (review K-2).
  /// A request is served at most once.
  pub async fn serve_once(&self) -> usize {
    let Ok(entries) = std::fs::read_dir(&self.plan.work_dir) else {
      return 0;
    };
    let mut requests: Vec<PathBuf> = entries
      .filter_map(|entry| entry.ok().map(|entry| entry.path()))
      .filter(|path| {
        path
          .file_name()
          .and_then(|name| name.to_str())
          .is_some_and(|name| name.starts_with(REQUEST_PREFIX) && name.ends_with(REQUEST_SUFFIX))
      })
      .collect();
    requests.sort();
    let mut answered = 0;
    for request in requests {
      let response = request.with_extension(&RESPONSE_SUFFIX[1..]);
      if std::fs::symlink_metadata(&response).is_ok()
        || self.served.lock().unwrap().contains(&request)
      {
        continue;
      }
      // The answer's file first: no secret is typed for a request this
      // harness could not answer.
      let (tmp, mut file) = match answer_file(&request) {
        Ok(answer) => answer,
        Err(error) => {
          warn!("could not answer {}: {error:#}", request.display());
          continue;
        }
      };
      self.served.lock().unwrap().insert(request.clone());
      let outcome = match read_request(&request) {
        Ok(name) => self.handle(&name).await,
        Err(()) => self.refuse_unreadable(),
      };
      let written = {
        use std::io::Write;
        file
          .write_all(format!("{}\n", self.redact(&outcome.response())).as_bytes())
          .and_then(|()| file.sync_all())
          .and_then(|()| std::fs::rename(&tmp, &response))
      };
      if let Err(error) = written {
        warn!("could not answer {}: {error:#}", request.display());
        let _ = std::fs::remove_file(&tmp);
      }
      answered += 1;
    }
    answered
  }

  /// [`Self::serve_once`] every `poll`, for as long as the run lasts.
  pub async fn serve(&self, poll: Duration) -> Infallible {
    loop {
      self.serve_once().await;
      tokio::time::sleep(poll).await;
    }
  }

  /// `text` with every value this run filled replaced by [`REDACTED`].
  pub fn redact(&self, text: &str) -> String {
    match self.redactor.lock().unwrap().redact_bytes(text.as_bytes()) {
      Some(clean) => String::from_utf8_lossy(&clean).into_owned(),
      None => text.to_string(),
    }
  }

  /// The backstop: rewrite every file under `dir` (images aside) that holds a
  /// filled value, with the value redacted. Returns the files it rewrote.
  pub fn scrub(&self, dir: &Path) -> Result<Vec<PathBuf>> {
    let redactor = self.redactor.lock().unwrap();
    let mut rewritten = Vec::new();
    if redactor.secrets.is_empty() {
      return Ok(rewritten);
    }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
      let entries = std::fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))?;
      for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
          stack.push(path);
        } else if kind.is_file() && !is_image(&path) {
          let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
          if let Some(clean) = redactor.redact_bytes(&bytes) {
            std::fs::write(&path, clean).with_context(|| format!("write {}", path.display()))?;
            rewritten.push(path);
          }
        }
      }
    }
    Ok(rewritten)
  }

  /// The audit lines, in order.
  pub fn audit(&self) -> Vec<String> {
    self.audit.lock().unwrap().clone()
  }
}

fn too_many_requests() -> FillOutcome {
  FillOutcome::Refused {
    reason: "too-many-requests".to_string(),
  }
}

/// The secret name `request` asks for (`""` when it names none), read only
/// from a plain file of the agent's own. It is opened without following a
/// link and without blocking on a FIFO, then checked on that same descriptor
/// to be a regular file with one link — so a symlink or a hard link to a
/// file elsewhere is never read (review K-1). `Err` ⇒ refuse it unread.
fn read_request(request: &Path) -> std::result::Result<String, ()> {
  use std::io::Read;
  use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
  let file = std::fs::OpenOptions::new()
    .read(true)
    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
    .open(request)
    .map_err(drop)?;
  let meta = file.metadata().map_err(drop)?;
  if !meta.file_type().is_file() || meta.nlink() != 1 {
    return Err(());
  }
  let mut bytes = Vec::new();
  file
    .take(MAX_REQUEST_BYTES + 1)
    .read_to_end(&mut bytes)
    .map_err(drop)?;
  Ok(
    Some(bytes)
      .filter(|bytes| bytes.len() as u64 <= MAX_REQUEST_BYTES)
      .and_then(|bytes| String::from_utf8(bytes).ok())
      .and_then(|text| request_name(&text))
      .unwrap_or_default(),
  )
}

/// A fresh file beside `request` for its answer, of the harness's own: a
/// hidden name with a random part no agent can plant ahead of time, created
/// with `create_new` (never an existing entry, never through a link).
fn answer_file(request: &Path) -> std::io::Result<(PathBuf, std::fs::File)> {
  use std::os::unix::fs::OpenOptionsExt;
  let stem = request
    .file_stem()
    .and_then(|stem| stem.to_str())
    .unwrap_or("fill-secret");
  let tmp = request.with_file_name(format!(
    ".{stem}{RESPONSE_SUFFIX}.{:016x}.tmp",
    rand::random::<u64>()
  ));
  let file = std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .mode(0o644)
    .custom_flags(libc::O_NOFOLLOW)
    .open(&tmp)?;
  Ok((tmp, file))
}

/// The secret name out of a request: `{"secret": "<name>"}`, or the name
/// alone on the first line.
fn request_name(text: &str) -> Option<String> {
  let text = text.trim();
  if text.starts_with('{') {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    return value.get("secret")?.as_str().map(str::to_string);
  }
  text.lines().next().map(|line| line.trim().to_string())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Arc;

  /// A fake secret value, in a 0600 file under a temp dir removed on drop. No
  /// real secret file is ever read by these tests.
  const FAKE: &str = "fake-pw-91d3 not-a-real-secret";
  const OPERATOR: &str = "operator-tester@lona.so";
  const OPERATOR_SECRET: &str = "operator-tester.google-password";
  const L3THAL: &str = "l3thal.cow@gmail.com";
  const L3THAL_SECRET: &str = "l3thal.cow.google-password";

  struct Scratch(PathBuf);

  impl Scratch {
    fn new(label: &str) -> Self {
      // Not under a temp dir: a fake runner here must pass the layout check.
      Self(crate::agent::test_scratch_dir(&format!(
        "ux-fill-secret-{label}"
      )))
    }

    /// `name` in this dir holding `contents` plus a newline, at `mode`.
    fn secret(&self, name: &str, contents: &str, mode: u32) -> PathBuf {
      use std::os::unix::fs::PermissionsExt;
      let file = self.0.join(name);
      std::fs::write(&file, format!("{contents}\n")).unwrap();
      std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
      file
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  /// Records what it was asked to type, and answers `outcome`.
  struct FakeTyper {
    outcome: FillOutcome,
    typed: Arc<Mutex<Vec<Vec<u8>>>>,
  }

  impl FakeTyper {
    fn new(outcome: FillOutcome) -> Self {
      Self {
        outcome,
        typed: Arc::default(),
      }
    }

    fn typed(&self) -> Vec<Vec<u8>> {
      self.typed.lock().unwrap().clone()
    }
  }

  #[async_trait]
  impl TypeSecret for FakeTyper {
    async fn type_secret(
      &self,
      _port: u16,
      secret: &[u8],
      _out_dir: &Path,
      _workspace: &Path,
    ) -> FillOutcome {
      self.typed.lock().unwrap().push(secret.to_vec());
      self.outcome.clone()
    }
  }

  fn filled() -> FillOutcome {
    FillOutcome::Filled {
      origin: GOOGLE_ORIGIN.to_string(),
    }
  }

  fn server<'a>(
    typer: &'a FakeTyper,
    secrets: Option<&Scratch>,
    work: &Scratch,
    account: Option<&str>,
  ) -> FillSecretServer<'a> {
    FillSecretServer::new(
      FillSecretPlan {
        secret_dir: secrets.map(|dir| dir.0.clone()),
        account: account.map(str::to_string),
        run_id: "2026-10-13_operator-tester-restore_abc123".to_string(),
        work_dir: work.0.join("agent"),
        out_dir: work.0.join(FILL_SECRET_OUT_DIR),
        devtools_port: 9333,
        trace: None,
      },
      typer,
    )
  }

  fn refused(outcome: &FillOutcome) -> &str {
    match outcome {
      FillOutcome::Refused { reason } => reason,
      other => panic!("expected a refusal, got {other:?}"),
    }
  }

  #[test]
  fn only_the_spec_accounts_own_google_password_is_allowlisted() {
    assert_eq!(check_allowed(OPERATOR_SECRET, Some(OPERATOR)), Ok(()));
    assert_eq!(check_allowed(L3THAL_SECRET, Some(L3THAL)), Ok(()));
    assert_eq!(
      check_allowed(OPERATOR_SECRET, Some(" Operator-Tester@lona.so ")),
      Ok(())
    );
    // Another account's secret.
    assert_eq!(
      check_allowed(OPERATOR_SECRET, Some(L3THAL)),
      Err(format!("not-allowlisted {OPERATOR_SECRET} for {L3THAL}"))
    );
    assert_eq!(
      check_allowed(L3THAL_SECRET, Some(OPERATOR)),
      Err(format!("not-allowlisted {L3THAL_SECRET} for {OPERATOR}"))
    );
    assert_eq!(
      check_allowed(OPERATOR_SECRET, None),
      Err(format!("not-allowlisted {OPERATOR_SECRET} for no account"))
    );
    // Unknown names, and the files that are never filled.
    assert_eq!(
      check_allowed("operator-tester.github-password", Some(OPERATOR)),
      Err("unknown-secret <unknown-name>".to_string())
    );
    for never in [
      "l3thal.cow.microsoft-password",
      "operator-tester.Microsoft-password",
      "stripe-secret-key",
      "operator-tester.stripe-test-key",
    ] {
      assert_eq!(
        check_allowed(never, Some(L3THAL)),
        Err("never-fillable <unknown-name>".to_string()),
        "{never}"
      );
    }
    // Paths, empties and junk never reach the file system.
    for junk in [
      "",
      "../operator-tester.google-password",
      "a/b",
      ".hidden",
      "x y",
      "pw\n",
    ] {
      assert_eq!(
        check_allowed(junk, Some(OPERATOR)),
        Err("invalid-secret-name".to_string()),
        "{junk:?}"
      );
    }
    assert_eq!(secret_for_account(Some(OPERATOR)), Some(OPERATOR_SECRET));
    assert_eq!(secret_for_account(Some(L3THAL)), Some(L3THAL_SECRET));
    assert_eq!(secret_for_account(Some("someone@example.test")), None);
    assert_eq!(secret_for_account(None), None);
  }

  #[test]
  fn the_secret_dir_is_named_or_beside_the_google_password_file() {
    assert_eq!(
      secret_dir_from(Some(" /s/ux ".into()), Some("/other/pw".into())),
      Some(PathBuf::from("/s/ux"))
    );
    assert_eq!(
      secret_dir_from(None, Some("/s/ux/l3thal.cow.google-password".into())),
      Some(PathBuf::from("/s/ux"))
    );
    assert_eq!(secret_dir_from(Some(" ".into()), Some(" ".into())), None);
    assert_eq!(secret_dir_from(None, None), None);
  }

  #[test]
  fn the_status_line_decides_filled_or_refused() {
    assert_eq!(
      fill_outcome(
        Some(0),
        "noise\nfill-secret: filled https://accounts.google.com\n"
      ),
      filled()
    );
    assert_eq!(
      fill_outcome(
        Some(4),
        "fill-secret: refused wrong-origin https://dev.lona.so"
      ),
      FillOutcome::Refused {
        reason: "wrong-origin https://dev.lona.so".into()
      }
    );
    // A "filled" from a failing exit, or for any origin but Google's, is not.
    assert_eq!(
      refused(&fill_outcome(
        Some(1),
        "fill-secret: filled https://accounts.google.com"
      )),
      "fill-error filled https://accounts.google.com"
    );
    assert_eq!(
      refused(&fill_outcome(
        Some(0),
        "fill-secret: filled https://evil.example"
      )),
      "fill-error filled https://evil.example"
    );
    assert_eq!(
      refused(&fill_outcome(Some(1), "fill-secret: error typing failed")),
      "fill-error error typing failed"
    );
    assert_eq!(
      refused(&fill_outcome(None, "")),
      "fill-error no-status (exit a signal)"
    );
    // Lane DN: a real exit status names the signal that killed the script.
    let segv = std::process::Command::new("sh")
      .args(["-c", "kill -SEGV $$"])
      .status()
      .unwrap();
    assert_eq!(
      refused(&fill_outcome(segv, "")),
      "fill-error no-status (signal 11)"
    );
    let code = std::process::Command::new("sh")
      .args(["-c", "exit 5"])
      .status()
      .unwrap();
    assert_eq!(
      refused(&fill_outcome(code, "")),
      "fill-error no-status (exit 5)"
    );
  }

  #[tokio::test]
  async fn every_refusal_types_nothing_and_answers_refused() {
    let secrets = Scratch::new("refusals-secrets");
    secrets.secret(OPERATOR_SECRET, FAKE, 0o600);
    secrets.secret("l3thal.cow.microsoft-password", FAKE, 0o600);
    let work = Scratch::new("refusals-work");
    let typer = FakeTyper::new(filled());
    let fill = server(&typer, Some(&secrets), &work, Some(L3THAL));
    // Not this spec's account's secret, a Microsoft file, an unknown name.
    assert_eq!(
      refused(&fill.handle(OPERATOR_SECRET).await),
      format!("not-allowlisted {OPERATOR_SECRET} for {L3THAL}")
    );
    assert_eq!(
      refused(&fill.handle("l3thal.cow.microsoft-password").await),
      "never-fillable <unknown-name>"
    );
    assert_eq!(
      refused(&fill.handle("nobody.google-password").await),
      "unknown-secret <unknown-name>"
    );
    // Allowlisted, but this host holds no such file.
    assert_eq!(
      refused(&fill.handle(L3THAL_SECRET).await),
      format!("secret-unavailable {L3THAL_SECRET}")
    );
    assert!(typer.typed().is_empty(), "a refusal typed something");
    // No secrets dir configured at all.
    let none = server(&typer, None, &work, Some(OPERATOR));
    assert_eq!(
      refused(&none.handle(OPERATOR_SECRET).await),
      "no-secret-dir on this host"
    );
    // A file the group or world can read is refused like the pre-step's.
    let loose = Scratch::new("refusals-loose");
    loose.secret(OPERATOR_SECRET, FAKE, 0o644);
    let fill = server(&typer, Some(&loose), &work, Some(OPERATOR));
    assert_eq!(
      refused(&fill.handle(OPERATOR_SECRET).await),
      format!("secret-file-not-0600 {OPERATOR_SECRET}")
    );
    assert!(typer.typed().is_empty());
    // The audit names every refusal and never a value.
    let audit = fill.audit();
    assert!(
      audit
        .iter()
        .all(|line| line.starts_with("secret-fill-refused ")),
      "{audit:?}"
    );
  }

  #[tokio::test]
  async fn a_page_refusal_from_the_typer_is_the_answer_and_nothing_is_kept() {
    let secrets = Scratch::new("page-secrets");
    secrets.secret(OPERATOR_SECRET, FAKE, 0o600);
    let work = Scratch::new("page-work");
    for reason in [
      "wrong-origin https://dev.lona.so",
      "wrong-origin https://accounts.google.com.evil.example",
      "not-a-password-field input[type=email]",
    ] {
      let typer = FakeTyper::new(FillOutcome::Refused {
        reason: reason.to_string(),
      });
      let fill = server(&typer, Some(&secrets), &work, Some(OPERATOR));
      let outcome = fill.handle(OPERATOR_SECRET).await;
      assert_eq!(refused(&outcome), reason);
      assert_eq!(outcome.response(), format!("refused: {reason}"));
      // Only a fill puts a value in the redactor; a refusal is audited.
      assert_eq!(fill.redact(&format!("x {FAKE} y")), format!("x {FAKE} y"));
      assert_eq!(
        fill.audit(),
        vec![format!(
          "secret-fill-refused {OPERATOR_SECRET} {reason} 2026-10-13_operator-tester-restore_abc123"
        )]
      );
    }
  }

  #[tokio::test]
  async fn an_allowlisted_fill_types_the_file_bytes_and_audits_without_the_value() {
    let secrets = Scratch::new("fill-secrets");
    secrets.secret(OPERATOR_SECRET, FAKE, 0o600);
    let work = Scratch::new("fill-work");
    let typer = FakeTyper::new(filled());
    let fill = server(&typer, Some(&secrets), &work, Some(OPERATOR));
    let outcome = fill.handle(OPERATOR_SECRET).await;
    assert_eq!(outcome, filled());
    assert_eq!(outcome.response(), "filled");
    // The file's bytes less its trailing newline, exactly once.
    assert_eq!(typer.typed(), vec![FAKE.as_bytes().to_vec()]);
    assert_eq!(
      fill.audit(),
      vec![format!(
        "secret-fill {OPERATOR_SECRET} https://accounts.google.com 2026-10-13_operator-tester-restore_abc123"
      )]
    );
    assert!(fill.audit().iter().all(|line| !line.contains(FAKE)));
  }

  #[tokio::test]
  async fn the_agent_asks_through_a_request_file_and_reads_the_answer_beside_it() {
    let secrets = Scratch::new("serve-secrets");
    secrets.secret(OPERATOR_SECRET, FAKE, 0o600);
    let work = Scratch::new("serve-work");
    let typer = FakeTyper::new(filled());
    let fill = server(&typer, Some(&secrets), &work, Some(OPERATOR));
    let agent = work.0.join("agent");
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(
      agent.join("fill-secret-1.request"),
      format!("{{\"secret\": \"{OPERATOR_SECRET}\"}}\n"),
    )
    .unwrap();
    std::fs::write(
      agent.join("fill-secret-2.request"),
      "l3thal.cow.microsoft-password\n",
    )
    .unwrap();
    // Not a request: other files in the workspace are left alone.
    std::fs::write(agent.join("NOTES.md"), "notes").unwrap();
    assert_eq!(fill.serve_once().await, 2);
    assert_eq!(
      std::fs::read_to_string(agent.join("fill-secret-1.response")).unwrap(),
      "filled\n"
    );
    assert_eq!(
      std::fs::read_to_string(agent.join("fill-secret-2.response")).unwrap(),
      "refused: never-fillable <unknown-name>\n"
    );
    // An answered request is never served again.
    assert_eq!(fill.serve_once().await, 0);
    assert_eq!(typer.typed().len(), 1);
    // The serve loop answers a request written while it runs.
    std::fs::write(agent.join("fill-secret-3.request"), "{\"secret\": 7}").unwrap();
    let _ = tokio::time::timeout(
      Duration::from_millis(300),
      fill.serve(Duration::from_millis(20)),
    )
    .await;
    assert_eq!(
      std::fs::read_to_string(agent.join("fill-secret-3.response")).unwrap(),
      "refused: invalid-secret-name\n"
    );
  }

  #[tokio::test]
  async fn requests_past_the_budget_are_refused_untyped() {
    let secrets = Scratch::new("budget-secrets");
    secrets.secret(OPERATOR_SECRET, FAKE, 0o600);
    let work = Scratch::new("budget-work");
    let typer = FakeTyper::new(filled());
    let fill = server(&typer, Some(&secrets), &work, Some(OPERATOR));
    for _ in 0..MAX_REQUESTS {
      assert_eq!(fill.handle(OPERATOR_SECRET).await, filled());
    }
    assert_eq!(
      refused(&fill.handle(OPERATOR_SECRET).await),
      "too-many-requests"
    );
    assert_eq!(typer.typed().len(), MAX_REQUESTS);
  }

  #[tokio::test]
  async fn the_backstop_redacts_a_filled_value_from_trace_logs_and_agent_output() {
    let secrets = Scratch::new("redact-secrets");
    secrets.secret(OPERATOR_SECRET, FAKE, 0o600);
    let run = Scratch::new("redact-run");
    let typer = FakeTyper::new(filled());
    let fill = server(&typer, Some(&secrets), &run, Some(OPERATOR));
    assert_eq!(fill.handle(OPERATOR_SECRET).await, filled());

    let agent = run.0.join("agent");
    std::fs::create_dir_all(&agent).unwrap();
    let leak = |what: &str| format!("{{\"what\":\"{what}\",\"value\":\"{FAKE}\"}}\n");
    std::fs::write(run.0.join("logs.ljson"), leak("logs") + &leak("logs again")).unwrap();
    std::fs::write(run.0.join("trace.ljson"), leak("trace")).unwrap();
    std::fs::write(agent.join("NOTES.md"), format!("typed {FAKE} by mistake")).unwrap();
    std::fs::write(
      agent.join("RESULT"),
      format!("RESULT x unfinished needs-human {FAKE}"),
    )
    .unwrap();
    std::fs::write(agent.join("clean.ts"), "nothing here").unwrap();
    let png = [0x89, b'P', b'N', b'G', 0, 1, 2];
    std::fs::write(agent.join("01-shot.png"), png).unwrap();

    let scrubbed = fill.scrub(&run.0).unwrap();
    let mut names: Vec<String> = scrubbed
      .iter()
      .map(|path| path.strip_prefix(&run.0).unwrap().display().to_string())
      .collect();
    names.sort();
    assert_eq!(
      names,
      [
        "agent/NOTES.md",
        "agent/RESULT",
        "logs.ljson",
        "trace.ljson"
      ]
    );
    for file in [
      run.0.join("logs.ljson"),
      run.0.join("trace.ljson"),
      agent.join("NOTES.md"),
      agent.join("RESULT"),
    ] {
      let text = std::fs::read_to_string(&file).unwrap();
      assert!(
        !text.contains(FAKE),
        "{} still holds the value",
        file.display()
      );
      assert!(text.contains(REDACTED), "{}", file.display());
    }
    // The ljson stays one valid object per line.
    for line in std::fs::read_to_string(run.0.join("logs.ljson"))
      .unwrap()
      .lines()
    {
      serde_json::from_str::<serde_json::Value>(line).unwrap();
    }
    assert_eq!(
      std::fs::read_to_string(agent.join("clean.ts")).unwrap(),
      "nothing here"
    );
    assert_eq!(std::fs::read(agent.join("01-shot.png")).unwrap(), png);
    // Strings the run writes itself (agent.json's reason and RESULT line).
    assert_eq!(
      fill.redact(&format!("agent said: {FAKE}")),
      format!("agent said: {REDACTED}")
    );
    // A second scrub finds nothing left.
    assert!(fill.scrub(&run.0).unwrap().is_empty());
  }

  #[test]
  fn the_typing_script_gets_the_allowlisted_env_only_and_no_secret_in_argv() {
    let typer = DenoTypeSecret {
      deno: PathBuf::from("deno"),
      deno_config: Some(PathBuf::from("/runner/deno.json")),
      timeout: Duration::from_secs(60),
    };
    let parent = vec![
      ("PATH".into(), "/bin".into()),
      ("DEBUG".into(), "puppeteer:*".into()),
      ("UX_GOOGLE_PASSWORD_FILE".into(), "/s/pw".into()),
      ("UX_FILL_SECRET_DIR".into(), "/s".into()),
    ];
    let command = typer.command_with_env(
      Path::new("/runner/deno.json"),
      9333,
      Path::new("/run/fill-secret"),
      parent,
    );
    let std = command.as_std();
    let args: Vec<String> = std
      .get_args()
      .map(|arg| arg.to_string_lossy().into_owned())
      .collect();
    assert!(
      args.contains(&"--allow-net=127.0.0.1:9333".to_string()),
      "{args:?}"
    );
    assert!(args.contains(&"--no-prompt".to_string()));
    assert!(args.contains(&"--cached-only".to_string()));
    assert!(args.contains(&"http://127.0.0.1:9333".to_string()));
    let envs: Vec<String> = std
      .get_envs()
      .filter(|(_, value)| value.is_some())
      .map(|(key, _)| key.to_string_lossy().into_owned())
      .collect();
    assert_eq!(envs, vec!["PATH".to_string()]);
  }

  /// The `data:` URL's text, percent-decoded.
  fn data_url_text(url: &str) -> String {
    let (_, encoded) = url.split_once(',').expect("a data: URL has a comma");
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
      if bytes[i] == b'%' {
        let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
        out.push(u8::from_str_radix(hex, 16).unwrap());
        i += 3;
      } else {
        out.push(bytes[i]);
        i += 1;
      }
    }
    String::from_utf8(out).unwrap()
  }

  /// Review K-1: the agent points a request at a file outside its workspace
  /// (a symlink, a hard link, a FIFO, a link to a directory). The harness
  /// refuses each one without reading it, so the decoy's first line reaches
  /// neither the answer nor the audit, and nothing blocks.
  #[tokio::test]
  async fn a_request_that_is_not_a_plain_file_of_its_own_is_refused_unread() {
    use std::os::unix::ffi::OsStrExt;
    const DECOY: &str = "decoyProbeValue_123";
    let outside = Scratch::new("k1-outside");
    let decoy = outside.secret("decoy", DECOY, 0o600);
    let work = Scratch::new("k1-work");
    let typer = FakeTyper::new(filled());
    let fill = server(&typer, None, &work, Some(OPERATOR));
    let agent = work.0.join("agent");
    std::fs::create_dir_all(&agent).unwrap();
    std::os::unix::fs::symlink(&decoy, agent.join("fill-secret-1.request")).unwrap();
    std::fs::hard_link(&decoy, agent.join("fill-secret-2.request")).unwrap();
    let fifo = std::ffi::CString::new(
      agent
        .join("fill-secret-3.request")
        .as_os_str()
        .as_bytes()
        .to_vec(),
    )
    .unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    std::os::unix::fs::symlink(&outside.0, agent.join("fill-secret-4.request")).unwrap();
    let answered = tokio::time::timeout(Duration::from_secs(5), fill.serve_once())
      .await
      .expect("serving a FIFO request blocked");
    for n in 1..=4 {
      let answer =
        std::fs::read_to_string(agent.join(format!("fill-secret-{n}.response"))).unwrap();
      assert_eq!(answer, "refused: unreadable-request\n", "request {n}");
    }
    assert_eq!(answered, 4);
    let audit = fill.audit();
    assert_eq!(audit.len(), 4, "{audit:?}");
    assert!(audit.iter().all(|line| !line.contains(DECOY)), "{audit:?}");
    assert!(
      audit.iter().all(
        |line| line.starts_with("secret-fill-refused <unreadable-request> unreadable-request ")
      ),
      "{audit:?}"
    );
    assert!(typer.typed().is_empty());
    assert_eq!(
      std::fs::read_to_string(&decoy).unwrap(),
      format!("{DECOY}\n")
    );
  }

  /// Review K-2: the agent plants `fill-secret-N.response.tmp` (and a
  /// `.response`) as links to a file outside its workspace. The harness never
  /// writes through either: the outside file keeps its bytes, the planted
  /// links stay as they were, and the answer is a plain file of its own.
  #[tokio::test]
  async fn the_answer_is_never_written_through_a_link_the_agent_planted() {
    let outside = Scratch::new("k2-outside");
    let victim = outside.secret("victim", "outside-original", 0o600);
    let work = Scratch::new("k2-work");
    let typer = FakeTyper::new(filled());
    let fill = server(&typer, None, &work, Some(OPERATOR));
    let agent = work.0.join("agent");
    std::fs::create_dir_all(&agent).unwrap();
    std::os::unix::fs::symlink(&victim, agent.join("fill-secret-2.response.tmp")).unwrap();
    std::fs::write(agent.join("fill-secret-2.request"), "x\n").unwrap();
    // A planted answer counts as the answer: nothing is written through it.
    std::os::unix::fs::symlink(&victim, agent.join("fill-secret-3.response")).unwrap();
    std::fs::write(agent.join("fill-secret-3.request"), "x\n").unwrap();
    assert_eq!(fill.serve_once().await, 1);
    assert_eq!(
      std::fs::read_to_string(&victim).unwrap(),
      "outside-original\n"
    );
    let tmp = std::fs::symlink_metadata(agent.join("fill-secret-2.response.tmp")).unwrap();
    assert!(
      tmp.file_type().is_symlink(),
      "the planted link was replaced"
    );
    let answer = agent.join("fill-secret-2.response");
    assert!(std::fs::symlink_metadata(&answer).unwrap().is_file());
    assert_eq!(
      std::fs::read_to_string(&answer).unwrap(),
      "refused: unknown-secret <unknown-name>\n"
    );
    // No temporary file of the harness's is left beside the answers.
    let mut names: Vec<String> = std::fs::read_dir(&agent)
      .unwrap()
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
      .collect();
    names.sort();
    assert_eq!(
      names,
      [
        "fill-secret-2.request",
        "fill-secret-2.response",
        "fill-secret-2.response.tmp",
        "fill-secret-3.request",
        "fill-secret-3.response",
      ]
    );
  }

  /// Review K-2: the typist's source goes to deno inside its argv as a
  /// `data:` URL, so no script file exists that the agent could swap between
  /// the write and the spawn; deno gets no file access at all; and a log the
  /// agent planted as a link is refused, not appended through.
  #[tokio::test]
  async fn the_typist_runs_the_embedded_source_and_writes_through_no_planted_link() {
    let typer = DenoTypeSecret {
      deno: PathBuf::from("deno"),
      deno_config: Some(PathBuf::from("/runner/deno.json")),
      timeout: Duration::from_secs(60),
    };
    let command = typer.command_with_env(
      Path::new("/runner/deno.json"),
      9333,
      Path::new("/run/fill-secret"),
      Vec::<(OsString, OsString)>::new(),
    );
    let args: Vec<String> = command
      .as_std()
      .get_args()
      .map(|arg| arg.to_string_lossy().into_owned())
      .collect();
    let module = args
      .iter()
      .find(|arg| arg.starts_with("data:application/typescript,"))
      .expect("the main module is a data: URL");
    assert_eq!(data_url_text(module), FILL_SECRET_SOURCE);
    assert!(
      !args.iter().any(|arg| arg.ends_with(FILL_SECRET_SCRIPT)
        || arg.starts_with("--allow-read")
        || arg.starts_with("--allow-write")),
      "{args:?}"
    );

    // A stand-in deno (`true`) that exits without a status line.
    let outside = Scratch::new("k2-typist-outside");
    let victim = outside.secret("victim", "outside-original", 0o600);
    let run = Scratch::new("k2-typist-run");
    let workspace = run.0.join("agent");
    std::fs::create_dir_all(&workspace).unwrap();
    let stand_in = DenoTypeSecret {
      deno: PathBuf::from("true"),
      deno_config: Some(PathBuf::from("/runner/deno.json")),
      timeout: Duration::from_secs(10),
    };
    let out_dir = run.0.join(FILL_SECRET_OUT_DIR);
    let outcome = stand_in
      .type_secret(9333, FAKE.as_bytes(), &out_dir, &workspace)
      .await;
    assert_eq!(refused(&outcome), "fill-error no-status (exit 0)");
    let names: Vec<String> = std::fs::read_dir(&out_dir)
      .unwrap()
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
      .collect();
    assert_eq!(names, ["fill-secret.log"], "no script is written");
    // The agent plants the log as a link: the typist refuses, writes nothing.
    std::fs::remove_file(out_dir.join("fill-secret.log")).unwrap();
    std::os::unix::fs::symlink(&victim, out_dir.join("fill-secret.log")).unwrap();
    let outcome = stand_in
      .type_secret(9333, FAKE.as_bytes(), &out_dir, &workspace)
      .await;
    assert!(refused(&outcome).starts_with("fill-error "), "{outcome:?}");
    assert_eq!(
      std::fs::read_to_string(&victim).unwrap(),
      "outside-original\n"
    );
    // An out dir the agent replaced with a link is refused the same way.
    let linked = Scratch::new("k2-typist-linked");
    let linked_out = linked.0.join(FILL_SECRET_OUT_DIR);
    std::os::unix::fs::symlink(&outside.0, &linked_out).unwrap();
    let outcome = stand_in
      .type_secret(9333, FAKE.as_bytes(), &linked_out, &workspace)
      .await;
    assert!(refused(&outcome).starts_with("fill-error "), "{outcome:?}");
    let mut names: Vec<String> = std::fs::read_dir(&outside.0)
      .unwrap()
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
      .collect();
    names.sort();
    assert_eq!(names, ["victim"]);
  }

  /// X-D2 (a): a typist whose deno sits in the agent's work dir is refused
  /// before anything is spawned or written, and the refusal names the path.
  #[tokio::test]
  async fn the_typist_refuses_to_spawn_a_deno_inside_the_work_dir() {
    use std::os::unix::fs::PermissionsExt;
    let run = Scratch::new("xd2-typist");
    let workspace = run.0.join("agent");
    std::fs::create_dir_all(&workspace).unwrap();
    let workspace = std::fs::canonicalize(&workspace).unwrap();
    let marker = run.0.join("spawned");
    let planted = workspace.join("deno");
    std::fs::write(
      &planted,
      format!(
        "#!/bin/sh\ntouch '{}'\necho 'fill-secret: filled'\n",
        marker.display()
      ),
    )
    .unwrap();
    std::fs::set_permissions(&planted, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config = run.0.join("runner/deno.json");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(&config, "{}").unwrap();
    let typist = DenoTypeSecret {
      deno: planted.clone(),
      deno_config: Some(config),
      timeout: Duration::from_secs(10),
    };
    let out_dir = run.0.join(FILL_SECRET_OUT_DIR);
    let outcome = typist
      .type_secret(9333, FAKE.as_bytes(), &out_dir, &workspace)
      .await;
    let reason = refused(&outcome);
    assert!(reason.starts_with("fill-error "), "{reason}");
    assert!(reason.contains(&planted.display().to_string()), "{reason}");
    assert!(!marker.exists(), "deno was spawned");
    assert!(!out_dir.exists(), "the typist wrote into its out dir");
  }

  /// OQ-1 (review O-5a): the typist's call site gets the temp roots too. A
  /// deno under `/var/tmp` is refused before anything is written or spawned.
  #[tokio::test]
  async fn the_typist_refuses_to_spawn_a_deno_under_a_temp_dir() {
    let run = Scratch::new("oq1-typist");
    let workspace = run.0.join("agent");
    std::fs::create_dir_all(&workspace).unwrap();
    let config = run.0.join("runner/deno.json");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(&config, "{}").unwrap();
    let in_tmp = Path::new("/var/tmp")
      .join(format!("ux-fill-secret-{}", rand::random::<u32>()))
      .join("deno");
    let typist = DenoTypeSecret {
      deno: in_tmp.clone(),
      deno_config: Some(config),
      timeout: Duration::from_secs(10),
    };
    let out_dir = run.0.join(FILL_SECRET_OUT_DIR);
    let outcome = typist
      .type_secret(9333, FAKE.as_bytes(), &out_dir, &workspace)
      .await;
    let reason = refused(&outcome);
    assert!(
      reason.starts_with("fill-error refusing to run deno"),
      "{reason}"
    );
    assert!(reason.contains(&in_tmp.display().to_string()), "{reason}");
    assert!(reason.contains("inside the temp dir"), "{reason}");
    assert!(!out_dir.exists(), "the typist wrote into its out dir");
  }

  /// Review K-3: a name off the allowlist is never echoed, in the answer or
  /// the audit; it is `<unknown-name>`. An allowlisted name still is.
  #[tokio::test]
  async fn a_name_off_the_allowlist_is_never_echoed() {
    let work = Scratch::new("k3-work");
    let typer = FakeTyper::new(filled());
    for name in [
      "decoyProbeValue_123",
      "operator-tester.github-password",
      "l3thal.cow.microsoft-password",
      "stripe-secret-key",
    ] {
      let fill = server(&typer, None, &work, Some(OPERATOR));
      let outcome = fill.handle(name).await;
      let reason = refused(&outcome).to_string();
      assert!(!reason.contains(name), "{reason}");
      assert!(reason.ends_with(" <unknown-name>"), "{reason}");
      let audit = fill.audit();
      assert_eq!(audit.len(), 1);
      assert!(!audit[0].contains(name), "{audit:?}");
      assert!(
        audit[0].starts_with("secret-fill-refused <unknown-name> "),
        "{audit:?}"
      );
    }
    let fill = server(&typer, None, &work, Some(OPERATOR));
    assert_eq!(
      refused(&fill.handle(L3THAL_SECRET).await),
      format!("not-allowlisted {L3THAL_SECRET} for {OPERATOR}")
    );
    assert!(fill.audit()[0].starts_with(&format!("secret-fill-refused {L3THAL_SECRET} ")));
    assert!(typer.typed().is_empty());
  }
}
