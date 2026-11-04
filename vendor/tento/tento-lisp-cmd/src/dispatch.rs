//! Generic command-dispatch primitives — the reedline/run-loop-free core shared
//! by both the script host and the shell runtime. These types carry no
//! interactive-runtime dependency (no `Shell`, no `run_loop`, no reedline), so
//! they form the dispatch surface that the generic command crate owns when
//! `tento-sh` is carved. `Scripts`/`Shell` (which DO drive the run loop) stay in
//! `shell.rs`.

use colored::Colorize;
use futures::Future;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::error::Error;

pub trait Callable {
  fn call_with_argv(
    &self,
    argv: Vec<String>,
  ) -> crate::Result<std::pin::Pin<Box<dyn Future<Output = crate::Result<Value>>>>>;

  fn print_help(&self, include_args: bool);

  /// Structured help for this callable as the JSON shape consumed by
  /// the TUI's help-tree renderer (a nested map of `{key → {description,
  /// args?, _open?} | {nested commands}}`). Default: empty Object, so a
  /// nested namespace that doesn't expose its inner commands still
  /// shows up as a leaf placeholder. `Scripts<T>` overrides this to
  /// expose its own `build_help_value` tree.
  fn help_value(&self) -> Value {
    Value::Object(serde_json::Map::new())
  }

  /// Full command path (`"ns sub cmd"`, space-joined to match how `tsh` joins
  /// `argv`) → its transport override, for every command in this callable's tree
  /// that sets one (via `#[command(transport = "…")]`). `prefix` is the
  /// namespace path this callable is mounted under. Default: none — a callable
  /// that doesn't expose per-command transports contributes nothing, so its
  /// commands inherit the bundle transport. `Scripts<T>` overrides this to walk
  /// its commands + nested subcommands.
  fn command_transports(&self, _prefix: &[String]) -> Vec<(String, String)> {
    Vec::new()
  }
}

/// Whether a gated subcommand group's precondition (e.g. a capability's env
/// vars being present) is met. Drives [`crate::shell::Shell::add_gated_subcommand`]: a
/// satisfied group mounts normally; an unsatisfied one mounts a visible
/// placeholder carrying the reason instead of silently vanishing.
pub enum GateOutcome {
  Available,
  Unavailable(String),
}

/// A placeholder for a subcommand group whose gate is unsatisfied. It stays
/// visible in `help` (carrying the reason) and, when invoked, fails loudly with
/// that reason — so the operator sees "why can't I run this?" instead of an
/// opaque `no command`. Env-agnostic: the reason string is computed by the
/// caller (e.g. acme-console maps a capability's missing keys to it).
pub struct UnavailableGroup {
  pub name: String,
  pub reason: String,
}

impl Callable for UnavailableGroup {
  fn call_with_argv(
    &self,
    _argv: Vec<String>,
  ) -> crate::Result<std::pin::Pin<Box<dyn Future<Output = crate::Result<Value>>>>> {
    Err(Error::Other(anyhow::anyhow!(
      "`{}` unavailable: {}",
      self.name,
      self.reason
    )))
  }

  fn print_help(&self, _include_args: bool) {
    println!("    {} — {}", self.name.bold(), self.reason);
  }

  fn help_value(&self) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert(
      "description".to_string(),
      Value::String(format!("unavailable: {}", self.reason)),
    );
    obj.insert(
      "unavailable".to_string(),
      Value::String(self.reason.clone()),
    );
    Value::Object(obj)
  }
}

/// How a command group is run out-of-process once packaged as a `.tsh.app`
/// bundle. The group **declares** this in its Rust (via [`crate::Scripts::transport`]);
/// it is emitted in the binary's root `--help --json` (`tsh.app/v1`) and recorded
/// in the bundle's `manifest.json`, so the packager reads it from the binary rather than a
/// sidecar config. `Oneshot`, `Daemon`, and `Streaming` are implemented;
/// `Pooled` is reserved (see `tento-shell.project.docs` process-lifecycle).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Transport {
  /// Spawn `bin <cmd> --json …` per call; **capture** stdout as the `--json` JSON
  /// channel; the process exits. The default. For request/response data
  /// commands whose value is a returned `Value`.
  #[default]
  Oneshot,
  /// A reusable child kept warm across calls (reserved, not yet built).
  Pooled,
  /// A long-lived shared daemon connected over a socket (`tento-kol`).
  Daemon,
  /// Spawn `bin <cmd> …` per call but **inherit** the terminal's stdio (no
  /// capture, no JSON channel); the command's value is its live terminal output
  /// + exit status, not a returned `Value`. For subprocess-wrapping /
  /// long-running commands (test runners, builds) where the user watches output
  /// stream — the oneshot capture model can't stream (it buffers stdout to parse
  /// it as JSON). See [`crate::Scripts::streaming`].
  Streaming,
}

impl Transport {
  /// The wire token used in `manifest.json` / root `--help --json`.
  pub fn as_str(&self) -> &'static str {
    match self {
      Transport::Oneshot => "oneshot",
      Transport::Pooled => "pooled",
      Transport::Daemon => "daemon",
      Transport::Streaming => "streaming",
    }
  }
}

/// The lifetime policy for a daemon transport.
///
/// This is `#[non_exhaustive]` so downstream crates must keep a fallback arm
/// when new scopes are added. Unknown wire tokens are preserved in
/// [`DaemonScope::Other`] instead of making a newer manifest unreadable or
/// silently treating it as a detached daemon.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonScope {
  /// One service instance per live tsh session, owned by that session's engine.
  Session,
  /// A scope introduced by a newer producer and not understood by this build.
  Other(String),
}

impl DaemonScope {
  /// The stable string token carried by `tsh.app/v1` manifests.
  pub fn as_str(&self) -> &str {
    match self {
      Self::Session => "session",
      Self::Other(value) => value,
    }
  }
}

impl Serialize for DaemonScope {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: Serializer,
  {
    serializer.serialize_str(self.as_str())
  }
}

impl<'de> Deserialize<'de> for DaemonScope {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: Deserializer<'de>,
  {
    let value = String::deserialize(deserializer)?;
    Ok(match value.as_str() {
      "session" => Self::Session,
      _ => Self::Other(value),
    })
  }
}

/// Connection details a [`Transport::Daemon`] group declares: where the daemon's
/// socket lives and how to lazily start it. Declared via [`crate::Scripts::daemon`],
/// emitted in root `--help --json`, recorded in the bundle `manifest.json`, and read by
/// the tsh client (`RemoteGroup`'s daemon branch → `daemon_rpc::Client`).
#[derive(Debug, Clone)]
pub struct DaemonSpec {
  /// Absolute path to the daemon's listening Unix socket. The daemon resolves
  /// this from its own config/env; declaring it here lets the packaged manifest
  /// carry a concrete path the client can connect to (no env reads in the shell).
  pub socket: String,
  /// argv passed to the bundle binary to lazily start the daemon when the socket
  /// is absent (e.g. `["jvmp.run"]`). Empty = externally-managed only (the
  /// client errors clearly rather than spawning).
  pub start: Vec<String>,
  /// Lifecycle scope: `None`/absent = a DETACHED daemon (today's behavior — a
  /// fire-and-forget child at a fixed `socket`, owning its own lifecycle).
  /// `Some(DaemonScope::Session)` = a SESSION-leased service — the `socket` is
  /// DERIVED under the session dir (`<session>/services/<app>.sock`, so
  /// `socket` is left empty here) and the engine OWNS the child (`kill_on_drop`;
  /// it dies with the session). Set via [`crate::Scripts::daemon_session`].
  pub scope: Option<DaemonScope>,
}
