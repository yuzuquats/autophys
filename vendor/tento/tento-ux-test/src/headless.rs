//! Headless (`--auto`) UX-test execution.
//!
//! Emits a fully params-resolved action plan and drives it through the Deno
//! `tento-ux-runner`, which loads the app, performs each step via
//! `window.__dispatchApp`, and completes the session through the in-browser
//! `@tento-ui/llm-logger` harness (which posts `/_/ux-test/complete`, flipping
//! the session to `Completed`). The existing trace verification
//! ([`crate::orchestration::verify_trace_results`]) stays the authoritative
//! judge — the harness `result` the runner posts is only a "steps executed"
//! signal.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tracing::info;
use uuid::Uuid;

use crate::env_profile::{EnvProfile, Resolver, Scheme};
use crate::manifest::AppManifest;
use crate::orchestration::{HostPort, UxTestCtx};
use crate::spec::{ExecutableAction, HeadlessAuth, TestSpec};

/// Default post-dispatch settle, in milliseconds.
const DEFAULT_SETTLE_MS: u64 = 400;

/// Loopback endpoint for fixture calls made between browser actions.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostBridge {
  pub hostname: String,
  pub port: u16,
}

/// The browser-side credential for a run, resolved from the corpus manifest.
///
/// It is a COOKIE and not a header because the WebSocket handshake cannot carry
/// an Authorization header but cookies ride it automatically — without this the
/// page authenticates its fetches and never syncs live data.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthCookie {
  pub name: String,
  /// The domain to scope the cookie to, or `None` for the exact origin.
  pub domain: Option<String>,
  /// Whether the runner also stamps the credential as `Authorization: Bearer`
  /// on the app's requests. True for a minted API key, which is a bearer
  /// token first and a cookie only for the WebSocket. False for a provided
  /// session cookie, which is not a bearer token and has no business in that
  /// header.
  pub bearer_header: bool,
}

/// Env var carrying a ready-made browser credential as `name=value`, used
/// INSTEAD of minting an API key through this process's host port.
///
/// It exists for targets whose login this process cannot mint: a remote
/// server's session cookie is sealed with a key that only that server's host
/// holds, so something with shell access there mints it and hands it over.
/// Env, like the minted key, so the value is never in argv or the plan file,
/// and it is never logged — only its cookie name is.
pub const PROVIDED_AUTH_COOKIE_ENV: &str = "UX_PROVIDED_AUTH_COOKIE";

/// Trusted host configuration, never executable text from a test spec. A JSON
/// argv is invoked without a shell after setup, with {user, ttlSeconds, origin}
/// on stdin. The issuer writes only name=value to stdout. In Lona the configured
/// helper uses SSH to the existing harness-only, expiring login-cookie issuer.
pub const BROWSER_SESSION_COMMAND_ENV: &str = "UX_BROWSER_SESSION_COMMAND";

async fn issue_browser_session(
  command_json: &str,
  user: &str,
  ttl_secs: i64,
  origin: &str,
) -> Result<ProvidedCookie> {
  let argv: Vec<String> = serde_json::from_str(command_json)
    .map_err(|_| anyhow!("{BROWSER_SESSION_COMMAND_ENV} must be a JSON argv array"))?;
  let program = argv
    .first()
    .filter(|s| !s.is_empty())
    .context("browser-session issuer argv is empty")?;
  let mut child = tokio::process::Command::new(program)
    .args(&argv[1..])
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    // The command can fail after producing a credential; never forward its
    // stdout/stderr into the transcript, plan or verification records.
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true)
    .spawn()
    .map_err(|_| anyhow!("could not start browser-session issuer"))?;
  let request = serde_json::to_vec(&serde_json::json!({
    "user": user, "ttlSeconds": ttl_secs, "origin": origin,
  }))?;
  let output = tokio::time::timeout(std::time::Duration::from_secs(60), async {
    let mut input = child
      .stdin
      .take()
      .context("browser-session issuer has no stdin")?;
    input
      .write_all(&request)
      .await
      .context("write browser-session request")?;
    drop(input);
    child
      .wait_with_output()
      .await
      .context("wait for browser-session issuer")
  })
  .await
  .map_err(|_| anyhow!("browser-session issuer timed out"))??;
  anyhow::ensure!(output.status.success(), "browser-session issuer failed");
  let raw = String::from_utf8(output.stdout)
    .map_err(|_| anyhow!("browser-session issuer returned non-UTF-8 output"))?;
  anyhow::ensure!(
    raw.len() <= 8192,
    "browser-session issuer output is too large"
  );
  provided_auth_cookie(Some(raw))
    .map_err(|_| anyhow!("browser-session issuer returned an invalid cookie"))?
    .context("browser-session issuer returned no cookie")
}

/// The browser credential a headless run carries.
enum Credential {
  /// Minted here for this run through the host port; revoked afterwards.
  Minted(String),
  /// Handed in via [`PROVIDED_AUTH_COOKIE_ENV`]. Not ours to revoke.
  Provided(ProvidedCookie),
}

impl Credential {
  fn value(&self) -> &str {
    match self {
      Credential::Minted(token) => token,
      Credential::Provided(cookie) => &cookie.value,
    }
  }
}

#[derive(Debug, PartialEq)]
struct ProvidedCookie {
  name: String,
  value: String,
}

/// Parse [`PROVIDED_AUTH_COOKIE_ENV`]. Unset or empty ⇒ `None`. A malformed
/// value is an error rather than a fallback to minting: someone meant to
/// provide a credential, and quietly driving as a different one would report
/// that account's results under theirs. Errors never echo the value.
fn provided_auth_cookie(raw: Option<String>) -> Result<Option<ProvidedCookie>> {
  let Some(raw) = raw.filter(|raw| !raw.trim().is_empty()) else {
    return Ok(None);
  };
  let (name, value) = raw
    .trim()
    .split_once('=')
    .ok_or_else(|| anyhow!("{PROVIDED_AUTH_COOKIE_ENV} must be `name=value`"))?;
  let name = name.trim();
  anyhow::ensure!(
    !name.is_empty() && !name.contains([';', ' ', ',']),
    "{PROVIDED_AUTH_COOKIE_ENV} has an invalid cookie name"
  );
  anyhow::ensure!(
    !value.is_empty() && !value.contains([';', ' ', ',']),
    "{PROVIDED_AUTH_COOKIE_ENV} for cookie `{name}` has an empty or invalid value"
  );
  Ok(Some(ProvidedCookie {
    name: name.to_string(),
    value: value.to_string(),
  }))
}

/// The cookie the plan tells the runner to install. A provided credential
/// names its own cookie — the manifest's name belongs to the minted kind — and
/// is never stamped as a bearer header.
fn plan_auth_cookie(
  manifest_cookie: &str,
  domain: Option<String>,
  credential: Option<&Credential>,
) -> AuthCookie {
  match credential {
    Some(Credential::Provided(cookie)) => AuthCookie {
      name: cookie.name.clone(),
      domain,
      bearer_header: false,
    },
    _ => AuthCookie {
      name: manifest_cookie.to_string(),
      domain,
      bearer_header: true,
    },
  }
}

/// The fully-resolved plan handed to the Deno runner, written into the session
/// directory as `headless-plan.json`.
///
/// Credentials are deliberately NOT part of the plan — they ride in the child
/// process environment so they are neither persisted nor exposed in argv.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessPlan {
  pub session_id: String,
  /// Port-qualified launch URL incl. `?ux=<id>&tid=<uuid>` — the top-level goto
  /// that activates the in-browser harness.
  pub boot_url: String,
  /// Origin incl. `:devPort`, used by the runner to resolve in-app `navigate`
  /// steps.
  pub base_url: String,
  /// The port `base_url` carries, echoed for the runner's sub-resource rewrite.
  /// Empty when the run declares no dev port — the runner rewrites nothing.
  /// Always empty under [`Resolver::Public`], where the URL already carries
  /// whatever port the remote server listens on.
  pub dev_port: String,
  /// How the runner's Chrome resolves the product's hostnames: `loopback`
  /// installs the `MAP *.lona.so 127.0.0.1` rule, `public` uses real DNS.
  pub resolver: Resolver,
  /// Whether certificate errors fail the run. `false` ⇒ the runner passes
  /// `--ignore-certificate-errors` (a dev server's self-signed cert).
  pub strict_tls: bool,
  /// Hostname patterns the loopback resolver maps to `127.0.0.1`, from the
  /// corpus manifest. Empty ⇒ the runner maps only the run's own target, which
  /// is what a corpus that has declared no domains is entitled to.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub resolve_domains: Vec<String>,
  /// The hostnames that ARE the app under test, from the corpus manifest. The
  /// runner rewrites a port-less sub-resource only for these — never for a
  /// third-party origin the page happens to reference.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub app_domains: Vec<String>,
  /// The credential cookie the runner installs before navigating. Absent ⇒ no
  /// cookie is set, and a run that needed one fails visibly at the app's own
  /// auth rather than silently rendering a signed-out page.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub auth_cookie: Option<AuthCookie>,
  pub settle_ms: u64,
  pub timeout_ms: u64,
  pub host_bridge: HostBridge,
  pub steps: Vec<ExecutableAction>,
  /// The spec's `gpu`: launch on the real GPU and fail on a software renderer.
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub gpu: bool,
  /// Who keeps the session store the in-page harness posts into. `None` ⇒
  /// the page origin (the built-in `local` profile: the daemon on this host,
  /// whose store IS this run's directory). `Some("runner")` for every named
  /// profile: the target is another server with a store of its own, so the
  /// Deno runner answers `/_/ux-test/logs` and `/_/ux-test/complete` itself
  /// and writes the run dir this process polls. Before this, every run
  /// against a named profile finished its steps and then timed out waiting
  /// for a completion that had been posted to the wrong host.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub harness_sink: Option<&'static str>,
}

/// The sink a profile calls for: only the built-in `local` profile shares this
/// process's session store with the page origin.
pub fn harness_sink_for(profile: &EnvProfile) -> Option<&'static str> {
  if profile.name == "local" { None } else { Some("runner") }
}

#[derive(Deserialize)]
struct HostBridgeRequest {
  token: String,
  verb: String,
  #[serde(default)]
  params: serde_json::Value,
}

#[derive(Serialize)]
#[serde(untagged)]
enum HostBridgeResponse {
  Ok { ok: bool, result: serde_json::Value },
  Err { ok: bool, error: String },
}

/// Write the plan into `session_dir`; returns the path to the written file.
pub fn write_headless_plan(session_dir: &Path, plan: &HeadlessPlan) -> Result<PathBuf> {
  let path = session_dir.join("headless-plan.json");
  let json = serde_json::to_string_pretty(plan).context("serialize headless plan")?;
  std::fs::write(&path, json).with_context(|| format!("write {}", path.display()))?;
  Ok(path)
}

/// Inject `:port` into the host of an `https://host[/path][?query]` URL. A no-op
/// if the URL is not `https://` or already carries a port.
fn inject_port(url: &str, port: &str) -> String {
  // Split on the URL's own `://` rather than matching a literal scheme. The
  // first version of this matched `https://` and returned the URL untouched for
  // anything else — which, once an env profile could say `scheme: http`, meant
  // an http run's boot URL silently kept port 80 while `base_url` was built
  // with the port. The browser then loaded the document from one server and
  // every port-less sub-resource from another, and the run reported a verdict
  // about a page that was never assembled from one build.
  let Some((scheme, rest)) = url.split_once("://") else {
    return url.to_string();
  };
  // A fragment ends the authority too (`https://host#x`), or the port lands
  // after it.
  let (host, tail) = match rest.find(['/', '?', '#']) {
    Some(i) => (&rest[..i], &rest[i..]),
    None => (rest, ""),
  };
  if host.contains(':') {
    url.to_string()
  } else {
    format!("{scheme}://{host}:{port}{tail}")
  }
}

/// The `(base_url, boot_url)` pair the plan carries, for a given effective dev
/// port.
///
/// `full_host` may carry a path (e.g. `dev.lona.so/calendar`); the origin used
/// by in-app `navigate` steps strips it. `dev_port` is the run's, not the
/// harness's: a host that serves its app on the default port declares none, a
/// `public` profile suppresses it outright, and in both cases the two URLs stay
/// untouched — no port is invented for a server that does not listen on one.
fn plan_urls(
  full_host: &str,
  url: &str,
  dev_port: Option<&str>,
  scheme: Scheme,
) -> (String, String) {
  let host_only = full_host.split('/').next().unwrap_or(full_host);
  let scheme = scheme.as_str();
  match dev_port {
    Some(port) => (
      format!("{scheme}://{host_only}:{port}"),
      inject_port(url, port),
    ),
    None => (format!("{scheme}://{host_only}"), url.to_string()),
  }
}

/// Mint auth (when the app has any), write the plan, and run the Deno runner
/// against `session_id`.
///
/// Returns `true` if the runner exited 0 (every step executed). The runner drives
/// the in-browser harness to completion, so the caller's
/// [`await_session_completion`](crate::orchestration::await_session_completion)
/// returns shortly after this resolves.
///
/// `profile` decides the run's network identity — resolver, port injection, and
/// TLS strictness — and reaches the runner through the plan. Note that key
/// **minting** still goes through this process's own host port: a public-mode
/// run only works where the local backend is the target's backend.
pub async fn drive_headless(
  ctx: &UxTestCtx,
  session_dir: &Path,
  session_id: &str,
  spec: &TestSpec,
  full_host: &str,
  url: &str,
  user: Option<&str>,
  profile: &EnvProfile,
) -> Result<bool> {
  let dev_port = profile.dev_port(ctx.env().dev_port());
  let (base_url, boot_url) = plan_urls(full_host, url, dev_port.as_deref(), profile.scheme);

  let ux_runner_dir = ctx
    .env()
    .ux_runner_dir()
    .context("this host does not expose a ux-runner directory (headless --auto unavailable)")?;

  // The corpus says what its app is; nothing here does. A corpus with no
  // manifest yields empty domains and no cookie, and the runner degrades to
  // mapping only the target it was already given.
  let manifest = AppManifest::resolve(ctx.env().ux_tests_dir().as_deref())
    .context("read the corpus app manifest")?;

  // Whether this app authenticates AT ALL is the manifest's `auth:` block —
  // the same field that decides whether the plan carries a cookie. Asking the
  // question once, here, is what stops the two halves disagreeing.
  //
  // It used to be unconditional: every headless run demanded an account and
  // minted a key before it read the corpus. An app with no account model could
  // only satisfy that by naming a fake one, so tento.localhost's adapter
  // answered `mint_api_key` with the string "tento-localhost-has-no-auth" and
  // `revoke_api_key` with `true` — a placeholder that authorises nothing,
  // sitting in run reports looking exactly like a credential. A corpus should
  // not have to tell a lie to be driven.
  let authenticates = manifest
    .as_ref()
    .is_some_and(|manifest| manifest.auth.is_some());

  let mut provided = provided_auth_cookie(std::env::var(PROVIDED_AUTH_COOKIE_ENV).ok())?;
  let ttl_secs = (spec.timeout as i64) + 120;
  if spec.headless_auth == HeadlessAuth::BrowserSession {
    anyhow::ensure!(
      authenticates,
      "browser_session requires a corpus auth declaration"
    );
    if provided.is_none() {
      let command = std::env::var(BROWSER_SESSION_COMMAND_ENV).with_context(|| format!(
        "browser_session requires {PROVIDED_AUTH_COOKIE_ENV} or {BROWSER_SESSION_COMMAND_ENV}; refusing to mint an API key"
      ))?;
      provided = Some(
        issue_browser_session(
          &command,
          user.context("browser_session requires a test account")?,
          ttl_secs,
          &base_url,
        )
        .await?,
      );
    }
  }
  let credential = match (authenticates, provided) {
    (false, Some(_)) => {
      return Err(anyhow!(
        "{PROVIDED_AUTH_COOKIE_ENV} is set, but this corpus's app.yaml declares no `auth:` block"
      ));
    }
    (false, None) => {
      info!("  No auth: this corpus's app.yaml declares no `auth:` block");
      None
    }
    (true, Some(cookie)) => {
      info!(
        "  Using provided auth cookie `{}` from {PROVIDED_AUTH_COOKIE_ENV} (value not logged)",
        cookie.name
      );
      Some(Credential::Provided(cookie))
    }
    (true, None) => {
      let user = user.context(
        "no account to drive headless: pass --user, declare params.user_email, or run on a \
host that provides a default account",
      )?;
      let token = ctx
        .port()
        .mint_api_key(user, ttl_secs)
        .await
        .context("mint api key for headless run")?;
      info!("  Minted temporary API key for {user} ({ttl_secs}s TTL)");
      Some(Credential::Minted(token))
    }
  };

  let (host_bridge, bridge_token, bridge_task) = start_host_bridge(ctx.port().clone()).await?;

  let plan = HeadlessPlan {
    session_id: session_id.to_string(),
    boot_url,
    base_url: base_url.clone(),
    dev_port: dev_port.unwrap_or_default(),
    resolver: profile.resolver,
    strict_tls: !profile.ignore_https_errors(),
    resolve_domains: manifest
      .as_ref()
      .map(AppManifest::resolve_patterns)
      .unwrap_or_default(),
    app_domains: manifest
      .as_ref()
      .map(|manifest| manifest.domains.clone())
      .unwrap_or_default(),
    auth_cookie: manifest.as_ref().and_then(|manifest| {
      manifest
        .auth
        .as_ref()
        .map(|auth| plan_auth_cookie(&auth.cookie, manifest.cookie_domain(), credential.as_ref()))
    }),
    settle_ms: DEFAULT_SETTLE_MS,
    timeout_ms: spec.timeout * 1000,
    host_bridge,
    steps: spec.headless_plan_actions(),
    gpu: spec.gpu,
    harness_sink: harness_sink_for(profile),
  };
  let plan_path = match write_headless_plan(session_dir, &plan) {
    Ok(path) => path,
    Err(error) => {
      bridge_task.abort();
      return Err(error);
    }
  };

  let status = run_runner(
    &ux_runner_dir,
    &plan_path,
    credential.as_ref().map(Credential::value).unwrap_or(""),
    &base_url,
    &bridge_token,
  )
  .await;
  bridge_task.abort();

  // Best-effort revoke regardless of the runner's outcome (the key also TTLs
  // out). Nothing to revoke when nothing was minted — and calling it anyway is
  // what made an app with no auth implement a `revoke_api_key` that reports
  // success for having done nothing. A provided cookie is not ours to revoke.
  if let Some(Credential::Minted(token)) = credential.as_ref() {
    match ctx.port().revoke_api_key(token).await {
      Ok(true) => info!("  Revoked temporary API key"),
      Ok(false) => {}
      Err(e) => info!("  Warning: failed to revoke headless api key: {e:#}"),
    }
  }

  let status = status?;
  if !status.success() {
    info!("  Headless runner exited non-zero: {status}");
  }
  Ok(status.success())
}

/// Spawn the Deno `tento-ux-runner` and wait for it to exit.
async fn run_runner(
  ux_runner_dir: &Path,
  plan_path: &Path,
  token: &str,
  base_url: &str,
  bridge_token: &str,
) -> Result<std::process::ExitStatus> {
  let script = ux_runner_dir.join("ux-runner.deno.ts");
  let config = ux_runner_dir.join("deno.json");
  info!("  Spawning ux-runner: deno run {}", script.display());
  tokio::process::Command::new("deno")
    .arg("run")
    .arg("-A")
    .arg("--config")
    .arg(&config)
    .arg(&script)
    .arg("--plan")
    .arg(plan_path)
    .arg("--base-url")
    .arg(base_url)
    .env("UX_API_TOKEN", token)
    .env("UX_HOST_BRIDGE_TOKEN", bridge_token)
    // The runner receives the credential once, as UX_API_TOKEN; a second copy
    // inherited under its original name is one more place to leak it from.
    .env_remove(PROVIDED_AUTH_COOKIE_ENV)
    .spawn()
    .context("spawn deno ux-runner (is `deno` on PATH?)")?
    .wait()
    .await
    .context("wait for deno ux-runner")
}

/// Start a process-local fixture bridge on an ephemeral loopback port.
///
/// The random capability stays in the child process environment rather than
/// the persisted plan. The listener is aborted as soon as the runner exits.
async fn start_host_bridge(
  port: HostPort,
) -> Result<(HostBridge, String, tokio::task::JoinHandle<()>)> {
  let listener = TcpListener::bind("127.0.0.1:0")
    .await
    .context("bind UX host bridge to loopback")?;
  let addr = listener
    .local_addr()
    .context("read UX host bridge address")?;
  let token = Uuid::new_v4().to_string();
  let task_token = token.clone();
  let task = tokio::spawn(async move {
    loop {
      let Ok((stream, _)) = listener.accept().await else {
        break;
      };
      if let Err(error) = handle_host_bridge_request(stream, &port, &task_token).await {
        info!("  UX host bridge request failed: {error:#}");
      }
    }
  });
  Ok((
    HostBridge {
      hostname: "127.0.0.1".to_string(),
      port: addr.port(),
    },
    token,
    task,
  ))
}

async fn handle_host_bridge_request(
  stream: TcpStream,
  port: &HostPort,
  expected_token: &str,
) -> Result<()> {
  let mut reader = BufReader::new(stream);
  let mut line = String::new();
  let bytes = reader
    .read_line(&mut line)
    .await
    .context("read UX host bridge request")?;
  if bytes == 0 {
    return Err(anyhow!("empty UX host bridge request"));
  }

  let request: HostBridgeRequest =
    serde_json::from_str(&line).context("parse UX host bridge request")?;
  let response = if request.token != expected_token {
    HostBridgeResponse::Err {
      ok: false,
      error: "unauthorized host bridge request".to_string(),
    }
  } else if !port.verbs().iter().any(|verb| verb == &request.verb) {
    HostBridgeResponse::Err {
      ok: false,
      error: format!("host verb '{}' is not corpus-callable", request.verb),
    }
  } else {
    match port.execute_verb(&request.verb, request.params).await {
      Ok(result) => HostBridgeResponse::Ok { ok: true, result },
      Err(error) => HostBridgeResponse::Err {
        ok: false,
        error: format!("{error:#}"),
      },
    }
  };

  let mut payload = serde_json::to_vec(&response).context("serialize UX host bridge response")?;
  payload.push(b'\n');
  reader
    .get_mut()
    .write_all(&payload)
    .await
    .context("write UX host bridge response")?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn inject_port_adds_port_to_host() {
    assert_eq!(
      inject_port("https://dev.lona.so/calendar?ux=1&tid=2", "8443"),
      "https://dev.lona.so:8443/calendar?ux=1&tid=2"
    );
    assert_eq!(
      inject_port("https://dev.lona.so?ux=1", "8443"),
      "https://dev.lona.so:8443?ux=1"
    );
    assert_eq!(
      inject_port("https://dev.lona.so", "8443"),
      "https://dev.lona.so:8443"
    );
  }

  /// A boot URL that keeps an initial path's fragment gets its port on the
  /// host, not inside the fragment.
  #[test]
  fn inject_port_leaves_a_fragment_where_it_is() {
    assert_eq!(
      inject_port("https://rc--ui.lona.so/?ux=1&tid=2#tab:chat", "8443"),
      "https://rc--ui.lona.so:8443/?ux=1&tid=2#tab:chat"
    );
    assert_eq!(
      inject_port("https://app.example.test#tab:chat", "8443"),
      "https://app.example.test:8443#tab:chat"
    );
  }

  /// A host that already names a port keeps it: the URL is more specific than
  /// the profile's default, and overwriting it would silently retarget the run.
  #[test]
  fn inject_port_is_noop_when_the_host_already_names_one() {
    assert_eq!(
      inject_port("https://dev.lona.so:9000/x", "8443"),
      "https://dev.lona.so:9000/x"
    );
    assert_eq!(
      inject_port("http://tento.localhost:8791/x", "8443"),
      "http://tento.localhost:8791/x"
    );
  }

  /// This assertion used to run the other way round — `inject_port` matched a
  /// literal `https://` and returned an http URL untouched, which was harmless
  /// only while no profile could ask for http. It is the half of `scheme: http`
  /// that was missing: without it the document loads from `:8791` and every
  /// port-less sub-resource from `:80`.
  #[test]
  fn inject_port_carries_an_http_url_too() {
    assert_eq!(
      inject_port("http://tento.localhost/hosts?ux=1", "8791"),
      "http://tento.localhost:8791/hosts?ux=1"
    );
  }

  /// Both halves of the plan, from one profile: an http corpus gets an http
  /// `base_url` AND an http boot URL, each carrying the reserved port. Getting
  /// one right and the other wrong is the failure this pair exists to catch.
  #[test]
  fn an_http_profile_plans_http_urls_on_both_halves() {
    let profile = EnvProfile::builtin_local();
    let (base_url, boot_url) = plan_urls(
      "tento.localhost",
      "http://tento.localhost/hosts?ux=s1&tid=t1",
      Some("8791"),
      Scheme::Http,
    );
    assert_eq!(base_url, "http://tento.localhost:8791");
    assert_eq!(boot_url, "http://tento.localhost:8791/hosts?ux=s1&tid=t1");
    // and the default is untouched
    assert_eq!(profile.scheme, Scheme::Https);
  }

  /// The invariant every reviewer checks first: no `--env` ⇒ the plan the
  /// harness built before profiles existed.
  #[test]
  fn builtin_local_plan_keeps_the_hosts_dev_port() {
    let profile = EnvProfile::builtin_local();
    let dev_port = profile.dev_port(Some("8443".to_string()));
    let (base_url, boot_url) = plan_urls(
      "dev.lona.so/calendar",
      "https://dev.lona.so/calendar?ux=s1&tid=t1",
      dev_port.as_deref(),
      profile.scheme,
    );

    assert_eq!(base_url, "https://dev.lona.so:8443");
    assert_eq!(boot_url, "https://dev.lona.so:8443/calendar?ux=s1&tid=t1");
    assert_eq!(dev_port.unwrap_or_default(), "8443");
    assert_eq!(profile.resolver, Resolver::Loopback);
    assert!(profile.ignore_https_errors(), "local must not be strict-TLS");
  }

  /// A public profile drives the real host: no port anywhere in the plan, and a
  /// resolver the runner reads as "do not MAP anything to loopback".
  #[test]
  fn only_the_local_profile_lets_the_page_origin_keep_the_session() {
    let local = EnvProfile::builtin_local();
    assert_eq!(harness_sink_for(&local), None);
    let mut rc = EnvProfile::builtin_local();
    rc.name = "rc".to_string();
    assert_eq!(harness_sink_for(&rc), Some("runner"));
  }

  #[test]
  fn public_plan_carries_no_port_and_a_public_resolver() {
    let root = std::env::temp_dir().join(format!(
      "ux-headless-public-{}",
      Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(root.join(crate::env_profile::ENVS_DIR)).unwrap();
    std::fs::write(
      root.join(crate::env_profile::ENVS_DIR).join("dev.yaml"),
      "resolver: public\ntls: strict\nserver_host: dev\n",
    )
    .unwrap();

    let profile = EnvProfile::load(&root, "dev").unwrap();
    // The host still declares 8443; the profile is what suppresses it.
    let dev_port = profile.dev_port(Some("8443".to_string()));
    let (base_url, boot_url) = plan_urls(
      "dev--calendar.lona.so/calendar",
      "https://dev--calendar.lona.so/calendar?ux=s1&tid=t1",
      dev_port.as_deref(),
      profile.scheme,
    );

    assert_eq!(base_url, "https://dev--calendar.lona.so");
    assert_eq!(boot_url, "https://dev--calendar.lona.so/calendar?ux=s1&tid=t1");
    assert_eq!(dev_port.clone().unwrap_or_default(), "");
    assert_eq!(profile.resolver, Resolver::Public);
    assert!(!profile.ignore_https_errors());

    // And the serialized plan the runner reads uses the camelCase field names.
    let plan = HeadlessPlan {
      session_id: "s1".to_string(),
      boot_url,
      base_url,
      dev_port: dev_port.unwrap_or_default(),
      resolver: profile.resolver,
      strict_tls: !profile.ignore_https_errors(),
      resolve_domains: Vec::new(),
      app_domains: Vec::new(),
      auth_cookie: None,
      settle_ms: DEFAULT_SETTLE_MS,
      timeout_ms: 1000,
      host_bridge: HostBridge {
        hostname: "127.0.0.1".to_string(),
        port: 1,
      },
      steps: Vec::new(),
      gpu: false,
      harness_sink: harness_sink_for(&profile),
    };
    let json: serde_json::Value = serde_json::to_value(&plan).unwrap();
    // No GPU request ⇒ the field is absent and the runner launches as before.
    assert!(json.get("gpu").is_none());
    let gpu_plan = HeadlessPlan { gpu: true, ..plan };
    assert_eq!(serde_json::to_value(&gpu_plan).unwrap()["gpu"], json!(true));
    // A named profile is another server with its own store: the runner keeps
    // this run's session and answers the page's harness posts itself.
    assert_eq!(json["harnessSink"], json!("runner"));
    assert_eq!(json["resolver"], json!("public"));
    assert_eq!(json["strictTls"], json!(true));
    assert_eq!(json["devPort"], json!(""));
  }

  #[test]
  fn provided_cookie_parses_name_and_value() {
    let parsed = provided_auth_cookie(Some(" id=sealed.value+/= \n".to_string())).unwrap();
    assert_eq!(
      parsed,
      Some(ProvidedCookie {
        name: "id".to_string(),
        value: "sealed.value+/=".to_string(),
      })
    );
  }

  #[test]
  fn unset_or_blank_provided_cookie_means_mint() {
    assert_eq!(provided_auth_cookie(None).unwrap(), None);
    assert_eq!(provided_auth_cookie(Some("  ".to_string())).unwrap(), None);
  }

  #[test]
  fn a_malformed_provided_cookie_fails_without_echoing_the_value() {
    for raw in ["no-equals-sign-secret", "=secretvalue", "id=", "id=se cret", "bad name=secretvalue"] {
      let error = provided_auth_cookie(Some(raw.to_string()))
        .expect_err(raw)
        .to_string();
      assert!(!error.contains("secret"), "{raw:?} leaked into: {error}");
    }
  }

  #[test]
  fn a_provided_cookie_names_itself_and_is_never_a_bearer() {
    let provided = Credential::Provided(ProvidedCookie {
      name: "id".to_string(),
      value: "sealed".to_string(),
    });
    let cookie = plan_auth_cookie("x_api_token", Some(".lona.so".to_string()), Some(&provided));
    let json = serde_json::to_value(&cookie).unwrap();
    assert_eq!(json, json!({"name": "id", "domain": ".lona.so", "bearerHeader": false}));
    // The value rides only in the runner's env, never in the plan.
    assert!(!json.to_string().contains("sealed"));

    let minted = Credential::Minted("key".to_string());
    let cookie = plan_auth_cookie("x_api_token", None, Some(&minted));
    assert_eq!(cookie.name, "x_api_token");
    assert!(cookie.bearer_header);
  }

  #[tokio::test]
  async fn browser_session_issuer_receives_context_without_shell_interpolation() {
    // A local stand-in for the SSH helper: checks the request and emits only
    // its credential. The user is data on stdin, never shell text or argv.
    let command = serde_json::to_string(&vec![
      "python3",
      "-c",
      "import json,sys; r=json.load(sys.stdin); assert r == {'user':'ux-fixture@invalid', 'ttlSeconds':420, 'origin':'https://rc.example.test'}; print('id=fixture-cookie')",
    ]).unwrap();
    let cookie = issue_browser_session(
      &command,
      "ux-fixture@invalid",
      420,
      "https://rc.example.test",
    )
    .await
    .unwrap();
    assert_eq!(cookie.name, "id");
    assert_eq!(cookie.value, "fixture-cookie");
  }

  #[tokio::test]
  async fn failed_browser_session_issuer_never_exposes_its_output() {
    let command = serde_json::to_string(&vec![
      "python3", "-c",
      "import sys; sys.stdin.read(); print('id=private-cookie'); print('private-cookie',file=sys.stderr); sys.exit(1)",
    ]).unwrap();
    let error = issue_browser_session(&command, "test", 420, "https://rc.example.test")
      .await
      .unwrap_err()
      .to_string();
    assert_eq!(error, "browser-session issuer failed");
  }

  #[tokio::test]
  async fn host_bridge_forwards_an_authorized_fixture_verb() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let host = HostPort::new(vec!["fixture".to_string()], tx);
    let host_task = tokio::spawn(async move {
      let request = rx.recv().await.expect("bridge should send one request");
      assert_eq!(request.action, "fixture");
      assert_eq!(request.params, json!({ "state": "active" }));
      request.reply.send(Ok(json!({ "changed": true }))).unwrap();
    });
    let (bridge, token, bridge_task) = start_host_bridge(host).await.unwrap();

    let stream = TcpStream::connect((bridge.hostname.as_str(), bridge.port))
      .await
      .unwrap();
    let mut reader = BufReader::new(stream);
    let request = json!({
      "token": token,
      "verb": "fixture",
      "params": { "state": "active" },
    });
    reader
      .get_mut()
      .write_all(format!("{request}\n").as_bytes())
      .await
      .unwrap();
    let mut response = String::new();
    reader.read_line(&mut response).await.unwrap();

    assert_eq!(
      serde_json::from_str::<serde_json::Value>(&response).unwrap(),
      json!({ "ok": true, "result": { "changed": true } })
    );
    host_task.await.unwrap();
    bridge_task.abort();
  }
}
