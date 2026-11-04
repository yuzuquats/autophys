//! tento-shell app bundles.
//!
//! A command group ships as a portable `*.tsh.app` folder that carries its own
//! spec (`manifest.json`) next to its `bin/`. The shell resolves a bundle by
//! name on a `PATH`-like search and dispatches its commands out-of-process.
//! This is the registry + transport slice of the tento-shell pilot (see
//! `tento-shell.project.docs`).
//!
//! Transports: `oneshot` (spawn `bin <cmd> --json …`, capture JSON stdout, exit),
//! `daemon` (connect to a long-lived socket, `tento-kol`), and `streaming`
//! (spawn `bin <cmd> …` with the terminal's stdio inherited so output streams
//! live — for subprocess-wrapping commands). Any other transport name (the
//! reserved `pooled` included) is refused when the manifest loads, naming it.
//! A host with no terminal of its own hands a streaming command to its
//! [`crate::foreground`] runner instead. Resolution is driven by
//! `$TSH_APP_PATH`; production adds per-user + fleet-deploy defaults.

use std::collections::BTreeMap;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::Command;

use std::cell::RefCell;
use std::rc::Rc;

#[path = "bundle_dependencies.rs"]
mod bundle_dependencies;

use serde::Deserialize;
use serde_json::Value;
use tento_lisp::{Function, NativeClosure, RuntimeError, Value as LispValue};
use tento_lisp_cmd::{DaemonScope, ProvideEntry, ServiceDecl, TSH_APP_SCHEMA};

use tento_lisp_cmd::script::{
  AsyncDispatch, ImportMounts, ImportResolver, LispHost, Sym, lisp_args_to_argv, value_from_json,
};

use crate::daemon_rpc::ServiceLease;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
  #[error("app `{0}` not found on the tsh app search path ($TSH_APP_PATH)")]
  NotFound(String),
  #[error("reading manifest for `{0}`: {1}")]
  Manifest(String, String),
  #[error("spawning `{0}`: {1}")]
  Spawn(String, String),
  #[error("`{0}` exited with code {1}{}", colon_detail(.2))]
  CommandFailed(String, i32, String),
  /// A `streaming` command exited non-zero. The third field is the last lines
  /// it printed: the caller's transcript already drew them, so the error's
  /// text leaves them out, and [`command_failure`] keeps them as the error
  /// value's `output` for `(try …)` and scripts (tsh-core-shell(14) PE-16).
  #[error("`{0}` exited with code {1}")]
  StreamFailed(String, i32, String),
  #[error("parsing `{0}` output as JSON: {1}")]
  Parse(String, String),
  #[error("daemon call `{0}` failed: {1}")]
  Daemon(String, String),
  #[error(
    "bundle `{0}` declares manifest type `{1}`, but this binary reads `{2}` — \
     the bundle was built for a newer tsh; update tsh or rebuild the bundle"
  )]
  UnsupportedType(String, String, &'static str),
  #[error("invalid manifest for `{0}`: {1}")]
  InvalidManifest(String, String),
  /// A `streaming` command that needs the user's terminal, dispatched where no
  /// terminal can take it (a session engine with no viewer attached).
  /// The second field is the host's reason and remedy.
  #[error("`{0}` needs an attached terminal: {1}")]
  NeedsTerminal(String, String),
}

/// `: <detail>` after a failed command's exit code, or nothing when there is
/// no detail to quote (a streaming command's output already went to the
/// caller's terminal), so the sentence never ends on a bare colon.
fn colon_detail(detail: &str) -> String {
  if detail.is_empty() {
    String::new()
  } else {
    format!(": {detail}")
  }
}

/// The transports a manifest may name. Anything else is refused at load, so a
/// misspelt `"streaming"` never runs silently as a captured oneshot.
pub const TRANSPORTS: [&str; 4] = ["oneshot", "streaming", "interactive", "daemon"];

impl AppError {
  /// The shell status this error stands for, when it has one of its own:
  /// `126` (found but cannot be run here) for [`Self::NeedsTerminal`].
  pub fn status(&self) -> Option<i32> {
    match self {
      Self::NeedsTerminal(..) => Some(126),
      _ => None,
    }
  }
}

/// A bundle's spec, read from `<app>.tsh.app/manifest.json`. The bundle carries
/// this, so reading it never executes the binary and is fingerprint-consistent
/// with it by construction.
#[derive(Debug, Clone, Deserialize)]
pub struct AppManifest {
  /// Required public contract version. Missing and unknown versions are both
  /// rejected at the bundle loading boundary.
  pub schema: String,
  /// Portable identifier, independent of its executable file name: ASCII
  /// letters/digits followed by letters/digits, `.`, `_`, or `-`; no trailing
  /// dot or Windows device names (including device names with extensions).
  pub name: String,
  pub version: String,
  #[serde(default, deserialize_with = "required_tsh_string")]
  pub requires_tsh: Option<String>,
  /// Relative executable path inside the bundle, normally `bin/<name>`.
  pub entrypoint: String,
  #[serde(default = "default_transport")]
  pub transport: String,
  /// Daemon connection details, present when `transport == "daemon"`: where to
  /// connect and how to lazily start it. See [`DaemonManifest`].
  #[serde(default)]
  pub daemon: Option<DaemonManifest>,
  /// command name → its help/arg metadata (opaque here; the shell renders it).
  /// Decoded on first read — see [`LazyValue`].
  #[serde(default)]
  pub commands: BTreeMap<String, LazyValue>,
  /// Optional native render shape for root help; command metadata stays authoritative.
  #[serde(default)]
  pub help: Option<LazyValue>,
  /// Per-command transport overrides: full space-joined command path
  /// (`"acme.releases changelog show"`) → transport (`"oneshot"`/`"streaming"`/
  /// `"daemon"`). Lets a single bundle mix transports — a shape-returning command
  /// runs oneshot (host renders) while live-output commands stream. Resolved in
  /// [`crate::remote_group::RemoteGroup`]; absent ⇒ the bundle-level `transport`.
  #[serde(default)]
  pub transports: BTreeMap<String, String>,
  /// The CAPABILITIES the bundle's binary declared, cached here by the packager
  /// from root `--help --json` — never hand-authored. A host reads them to route
  /// work (tsh's `highlight` picks a `syntax.provider/v1` by extension) WITHOUT
  /// spawning anything: this is a file read, so an installed-but-unmounted
  /// bundle costs nothing and an entry whose `type` this host doesn't know is
  /// simply skipped ([`tento_lisp_cmd::ProvideEntry`] keeps it readable).
  #[serde(default)]
  pub provides: Vec<ProvideEntry>,
  /// The long-running SERVICES the bundle's binary declared, cached here by the
  /// packager from root `--help --json` — never hand-authored, same chain as
  /// [`Self::provides`]. A supervisor reads them to know what it may bring up
  /// out of an INSTALLED bundle without spawning it, and a service whose `kind`
  /// it cannot supervise is simply skipped ([`tento_lisp_cmd::ServiceDecl`]
  /// keeps it readable). Additive: every manifest written before this field
  /// existed still loads, as a bundle that serves nothing.
  #[serde(default)]
  pub services: Vec<ServiceDecl>,
  /// Required runtime bundles (legacy list or `{bundles: {name: range}}`).
  #[serde(default)]
  pub requires: Value,
  /// Runtime bundle version ranges; optional dependencies are not installed by import.
  #[serde(default)]
  pub dependencies: BTreeMap<String, Value>,
}

/// The `daemon` block of a bundle manifest (mirrors `tento_sh::DaemonSpec` /
/// `reflect::DaemonDoc`): the socket the client connects to and the argv to
/// lazily start the daemon.
#[derive(Debug, Clone, Deserialize)]
pub struct DaemonManifest {
  #[serde(default)]
  pub socket: String,
  #[serde(default)]
  pub start: Vec<String>,
  /// Lifecycle scope: absent = a DETACHED daemon at the fixed `socket` (today's
  /// behavior); `"session"` = a session-leased service whose socket is derived
  /// under the session dir. Serde default so older manifests parse as detached.
  #[serde(default)]
  pub scope: Option<DaemonScope>,
}

// NOTE: the manifest carries NO `namespace`. The mount site names the group —
// `(@import "<bundle>" :as "<ns>")` in a `.tshrc` — so a bundle's namespace is
// an explicit, per-import choice, never derived from the bundle or its folder.
// A `"namespace"` key in an older manifest is simply ignored on load.

fn default_transport() -> String {
  "oneshot".to_string()
}

fn valid_bundle_name(name: &str) -> bool {
  if !name
    .as_bytes()
    .first()
    .is_some_and(u8::is_ascii_alphanumeric)
    || !name
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    || name.ends_with('.')
  {
    return false;
  }
  // Windows treats these as devices even with an extension, so appending
  // `.tsh.app` does not make them ordinary directory names. Check on ALL hosts.
  let stem = name
    .split('.')
    .next()
    .unwrap_or_default()
    .to_ascii_uppercase();
  !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
    && !(stem.len() == 4
      && (stem.starts_with("COM") || stem.starts_with("LPT"))
      && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// Older packagers derived identity from the installed folder and executable.
/// Recognize only their complete envelopes; malformed current manifests and
/// unknown schema/type versions still fail the normal loader validation.
/// A manifest subtree held as JSON text until something reads it.
///
/// The packager writes each command's pre-rendered help into the manifest
/// (a 21-command bundle: 45 KB, 0.21 ms to decode into a [`Value`] tree on an
/// M-series core), and a launch that only routes a call — or never
/// touches the bundle — read none of it. Keeping the text costs a token scan;
/// the tree is built once, on the first index or [`LazyValue::value`].
#[derive(Clone)]
pub struct LazyValue {
  raw: Box<serde_json::value::RawValue>,
  decoded: std::cell::OnceCell<Value>,
}

impl LazyValue {
  /// The decoded tree (built on the first call).
  pub fn value(&self) -> &Value {
    self.decoded.get_or_init(|| {
      serde_json::from_str(self.raw.get()).expect("a RawValue holds one valid JSON value")
    })
  }

  /// The JSON text as written in the manifest.
  pub fn raw(&self) -> &str {
    self.raw.get()
  }

  #[cfg(test)]
  fn is_decoded(&self) -> bool {
    self.decoded.get().is_some()
  }
}

impl From<Value> for LazyValue {
  fn from(value: Value) -> Self {
    LazyValue {
      raw: serde_json::value::RawValue::from_string(value.to_string())
        .expect("a serialized Value is valid JSON"),
      decoded: std::cell::OnceCell::from(value),
    }
  }
}

impl std::fmt::Debug for LazyValue {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(self.raw.get())
  }
}

impl std::ops::Index<&str> for LazyValue {
  type Output = Value;
  fn index(&self, key: &str) -> &Value {
    &self.value()[key]
  }
}

impl<'de> Deserialize<'de> for LazyValue {
  fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    Box::<serde_json::value::RawValue>::deserialize(deserializer).map(|raw| LazyValue {
      raw,
      decoded: std::cell::OnceCell::new(),
    })
  }
}

/// The manifest text split once: the small envelope as a [`Value`] map (it
/// still goes through [`installed_manifest`]), the bulky `commands` and
/// `help` subtrees as text.
struct SplitManifest {
  rest: serde_json::Map<String, Value>,
  commands: Option<Box<serde_json::value::RawValue>>,
  help: Option<LazyValue>,
}

fn split_manifest(text: &str) -> Result<SplitManifest, serde_json::Error> {
  struct Visitor;
  impl<'de> serde::de::Visitor<'de> for Visitor {
    type Value = SplitManifest;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
      // The derived deserializer's wording, so a non-object manifest reads
      // as it always has.
      f.write_str("struct AppManifest")
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<SplitManifest, A::Error> {
      let mut split = SplitManifest {
        rest: serde_json::Map::new(),
        commands: None,
        help: None,
      };
      // A repeated key keeps its last value, as a `Value` parse of the same
      // text would — so `commands` is decoded only once the last one is known,
      // by `decode_manifest`.
      while let Some(key) = map.next_key::<String>()? {
        match key.as_str() {
          "commands" => {
            split.commands = Some(map.next_value()?);
            // Hold its place among the envelope keys, so a malformed
            // `commands` is reported in text order, as the derived
            // deserializer reports it.
            split.rest.insert(key, Value::Null);
          }
          "help" => split.help = map.next_value()?,
          _ => {
            let value = map.next_value()?;
            split.rest.insert(key, value);
          }
        }
      }
      Ok(split)
    }
  }
  let mut deserializer = serde_json::Deserializer::from_str(text);
  let split = serde::Deserializer::deserialize_map(&mut deserializer, Visitor)?;
  deserializer.end()?;
  Ok(split)
}

fn installed_manifest(mut wire: Value, folder_name: &str) -> Value {
  let Some(map) = wire.as_object_mut() else {
    return wire;
  };
  // An identity field is unstamped when absent or `""` (what a library that
  // reflects identity wrote before it learned to omit an unset one).
  let unstamped = |key: &str| match map.get(key) {
    None => true,
    Some(Value::String(s)) => s.is_empty(),
    Some(_) => false,
  };
  let known_envelope = match (map.get("schema"), map.get("type")) {
    // Current tag, no identity: a binary built on a library that reflects
    // identity, packaged by a packager that predates it (it adds `version`
    // only). Both fields must be unstamped: a half-stamped identity is the
    // manifest's own claim, and the name/entrypoint gates judge it as written.
    (Some(Value::String(tag)), None) => {
      tag == TSH_APP_SCHEMA && unstamped("name") && unstamped("entrypoint")
    }
    (Some(_), _) => false,
    _ if map.contains_key("name") || map.contains_key("entrypoint") => false,
    (None, Some(Value::String(tag))) => tag == TSH_APP_SCHEMA,
    (None, None) => map.get("source_dir").and_then(Value::as_str).is_some(),
    (None, Some(_)) => false,
  };
  let complete = map.get("version").and_then(Value::as_str).is_some()
    && map.get("commands").is_some_and(Value::is_object)
    && map
      .get("transport")
      .and_then(Value::as_str)
      .is_some_and(|t| TRANSPORTS.contains(&t));
  if known_envelope && complete {
    map.remove("type");
    map.insert("schema".into(), Value::String(TSH_APP_SCHEMA.into()));
    map.insert("name".into(), Value::String(folder_name.into()));
    map.insert(
      "entrypoint".into(),
      Value::String(format!("bin/{folder_name}")),
    );
  }
  wire
}

/// Deserialize typed fields without rebuilding already-parsed opaque JSON.
/// Leave malformed command fields in place so serde reports its usual error.
fn decode_manifest(text: &str, folder_name: &str) -> Result<AppManifest, serde_json::Error> {
  let split = split_manifest(text)?;
  let mut wire = Value::Object(split.rest);
  let commands = match split.commands {
    None => None,
    Some(raw) => match serde_json::from_str::<BTreeMap<String, LazyValue>>(raw.get()) {
      // `installed_manifest` recognises a complete legacy envelope by (among
      // other things) an object-valued `commands`; stand in for the subtree
      // the split kept as text.
      Ok(commands) => {
        wire["commands"] = Value::Object(serde_json::Map::new());
        Some(Ok(commands))
      }
      // Malformed: decode it with the envelope, in its place, so the first
      // error in text order is the one reported.
      Err(error) => {
        wire["commands"] = serde_json::from_str(raw.get())?;
        Some(Err(error))
      }
    },
  };
  let mut manifest: AppManifest = serde_json::from_value(installed_manifest(wire, folder_name))?;
  manifest.commands = commands.transpose()?.unwrap_or_default();
  manifest.help = split.help;
  Ok(manifest)
}

/// A resolved bundle on disk.
#[derive(Debug, Clone)]
pub struct TshApp {
  /// Bundle name (folder minus `.tsh.app`), e.g. `tento-whoop`.
  pub name: String,
  pub dir: PathBuf,
  pub bin: PathBuf,
  /// Shared: one parse per bundle per process (see [`TshApp::load`]); a
  /// `TshApp` clone is a pointer bump, so the shell mount and the rc's
  /// `@import` of the same bundle no longer each decode the manifest.
  pub manifest: Rc<AppManifest>,
  /// Per-import environment bindings, shared only by this import's commands.
  pub child_env: crate::app_env::Bindings,
}

thread_local! {
  // `bundle_is_script_free` verdicts by bundle directory, with the manifest
  // stamp they were decided at.
  static SCRIPT_FREE: std::cell::RefCell<
    std::collections::HashMap<PathBuf, (ManifestStamp, bool)>,
  > = std::cell::RefCell::new(std::collections::HashMap::new());
  // Parsed bundles by directory, with the manifest stamp they were read at —
  // see `TshApp::load`.
  static LOADED_BUNDLES: std::cell::RefCell<
    std::collections::HashMap<PathBuf, (Option<ManifestStamp>, TshApp)>,
  > = std::cell::RefCell::new(std::collections::HashMap::new());
}

/// A manifest file's (mtime, length): what the per-process caches key on.
type ManifestStamp = (Option<std::time::SystemTime>, u64);

static RUNTIME_TSH_VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub const RUNTIME_TSH_VERSION_ENV: &str = "TSH_RUNTIME_VERSION";

/// Set the embedding tsh's compiled version before loading any bundles.
/// Required for every embedder that loads bundles declaring `requires_tsh`.
/// Call once, before loading bundles, with the compatible tsh runtime version;
/// an unset version refuses every such bundle, with the reason in `AppError`.
pub fn set_runtime_tsh_version(version: &str) {
  let _ = RUNTIME_TSH_VERSION.set(version.to_string());
}

// An absent field is optional; an explicitly present null is malformed.
fn required_tsh_string<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
  String::deserialize(deserializer).map(Some)
}

fn check_runtime_tsh_version(manifest: &AppManifest) -> Result<(), AppError> {
  if let Some(required) = &manifest.requires_tsh {
    tento_bundle_contract::range::check_requires_tsh(&manifest.name, required,
      RUNTIME_TSH_VERSION.get().map(String::as_str).unwrap_or("unknown"))
      .map_err(|e| AppError::InvalidManifest(manifest.name.clone(), e.to_string()))?;
  }
  Ok(())
}

fn pass_runtime_tsh_version(command: &mut Command) {
  if let Some(version) = RUNTIME_TSH_VERSION.get() {
    command.env(RUNTIME_TSH_VERSION_ENV, version);
  }
}

impl TshApp {
  /// Load + parse a bundle directory (`…/<name>.tsh.app`). Pure file reads.
  ///
  /// Reads the current [`TSH_APP_SCHEMA`] and the two earlier installed bundle
  /// envelopes. All formats require a portable bundle name, a
  /// non-empty version, and a relative entrypoint without parent traversal.
  /// Invalid metadata is rejected before the bundle can be installed or mounted.
  pub fn load(dir: &Path) -> Result<Self, AppError> {
    let manifest_path = dir.join("manifest.json");
    // One parse per bundle per process. A tsh invocation resolves every
    // imported bundle twice — once to mount its command group while the shell
    // is built, once more when the rc's `(@import …)` line runs — and each
    // resolution read and decoded the manifest again (~0.1 ms a bundle, seven
    // bundles in the stock rc). With the manifest behind an `Rc` a hand-out
    // is a pointer bump. Keyed by the manifest's (mtime, len), so a bundle
    // reinstalled mid-process is re-read.
    let stamp = std::fs::metadata(&manifest_path)
      .ok()
      .map(|m| (m.modified().ok(), m.len()));
    if let Some(app) = LOADED_BUNDLES.with(|cache| {
      cache
        .borrow()
        .get(dir)
        .filter(|(seen, _)| *seen == stamp)
        .map(|(_, app)| app.clone())
    }) {
      check_runtime_tsh_version(&app.manifest)?;
      return Ok(app);
    }
    let app = Self::load_uncached(dir)?;
    check_runtime_tsh_version(&app.manifest)?;
    LOADED_BUNDLES.with(|cache| {
      cache
        .borrow_mut()
        .insert(dir.to_path_buf(), (stamp, app.clone()));
    });
    Ok(app)
  }

  fn load_uncached(dir: &Path) -> Result<Self, AppError> {
    let folder_name = dir
      .file_name()
      .and_then(|s| s.to_str())
      .unwrap_or_default()
      .trim_end_matches(".tsh.app")
      .to_string();
    let manifest_path = dir.join("manifest.json");
    let timing = std::env::var_os("TENTO_STARTUP_TIMING").is_some();
    let started = std::time::Instant::now();
    let text = std::fs::read_to_string(&manifest_path)
      .map_err(|e| AppError::Manifest(folder_name.clone(), e.to_string()))?;
    let read_ms = started.elapsed().as_secs_f64() * 1e3;
    let manifest = Self::parse_manifest(&text, &folder_name)?;
    if timing {
      eprintln!(
        "startup: bundle.load {folder_name} {:.2} ms (read {read_ms:.2} ms, {} B, {} commands)",
        started.elapsed().as_secs_f64() * 1e3,
        text.len(),
        manifest.commands.len()
      );
    }
    let name = manifest.name.clone();
    let bin = dir.join(Path::new(&manifest.entrypoint));
    Ok(TshApp {
      name,
      dir: dir.to_path_buf(),
      bin,
      manifest: Rc::new(manifest),
      child_env: Default::default(),
    })
  }

  /// Parse and VALIDATE a bundle's `manifest.json` text — the pure core of
  /// [`Self::load`], split out so it can be unit-tested and fuzzed without a
  /// bundle on disk. `folder_name` is the bundle folder name minus
  /// `.tsh.app` (older installed envelopes derive `name`/`entrypoint` from it).
  /// Enforces the loading-boundary security predicates: a known schema, a
  /// portable bundle name, a non-empty version, and a relative entrypoint with
  /// no parent traversal.
  pub fn parse_manifest(text: &str, folder_name: &str) -> Result<AppManifest, AppError> {
    let manifest = decode_manifest(text, folder_name)
      .map_err(|e| AppError::Manifest(folder_name.to_string(), e.to_string()))?;
    if manifest.schema != TSH_APP_SCHEMA {
      return Err(AppError::UnsupportedType(
        folder_name.to_string(),
        manifest.schema.clone(),
        TSH_APP_SCHEMA,
      ));
    }
    if !valid_bundle_name(&manifest.name) {
      return Err(AppError::InvalidManifest(
        folder_name.to_string(),
        format!(
          "unsafe bundle name {:?}: expected a portable identifier (ASCII letters/digits, dots, underscores, hyphens; starts with a letter/digit, no trailing dot or Windows device name)",
          manifest.name
        ),
      ));
    }
    if manifest.version.trim().is_empty() {
      return Err(AppError::InvalidManifest(
        folder_name.to_string(),
        "`version` must be non-empty".to_string(),
      ));
    }
    if let Some(required) = &manifest.requires_tsh {
      tento_bundle_contract::range::Range::parse(required)
        .map_err(|e| AppError::InvalidManifest(folder_name.to_string(), format!("invalid requires_tsh: {e}")))?;
    }
    let entrypoint = Path::new(&manifest.entrypoint);
    let safe_entrypoint = !entrypoint.as_os_str().is_empty()
      && !entrypoint.is_absolute()
      && entrypoint.components().all(|component| {
        matches!(
          component,
          std::path::Component::Normal(_) | std::path::Component::CurDir
        )
      });
    if !safe_entrypoint {
      return Err(AppError::InvalidManifest(
        folder_name.to_string(),
        format!("unsafe entrypoint `{}`", manifest.entrypoint),
      ));
    }
    // A transport this binary does not implement is the manifest's error, not
    // a silent oneshot: name it, and the command path that declares it.
    let unknown = std::iter::once((None, &manifest.transport))
      .chain(
        manifest
          .transports
          .iter()
          .map(|(path, transport)| (Some(path), transport)),
      )
      .find(|(_, transport)| !TRANSPORTS.contains(&transport.as_str()));
    if let Some((path, transport)) = unknown {
      let site = match path {
        Some(path) => format!("`transports` entry `{path}`"),
        None => "`transport`".to_string(),
      };
      return Err(AppError::InvalidManifest(
        folder_name.to_string(),
        format!(
          "{site} names unknown transport `{transport}` (expected one of: {})",
          TRANSPORTS.join(", ")
        ),
      ));
    }
    // A provider is either a command the host spawns or an rc export it calls,
    // never both and never neither: a host must know which door to use.
    for entry in &manifest.provides {
      let lisp = entry.lisp.as_deref().filter(|s| !s.trim().is_empty());
      if entry.command.trim().is_empty() == lisp.is_none() {
        return Err(AppError::InvalidManifest(
          folder_name.to_string(),
          format!(
            "provides `{}` ({}): set exactly one of `command` and `lisp`",
            entry.id, entry.type_tag
          ),
        ));
      }
    }
    Ok(manifest)
  }

  /// The bundle's import-time UI scripts: `ui/*.tsh`, sorted for a
  /// deterministic registration order. Empty when the bundle ships no UI (the
  /// common case). Pure file listing — nothing is read or evaluated here; the
  /// shell evaluates these in the **gated registration context** at `@import`
  /// (define-only: contributions stage inert until a `(use-ui …)` activates
  /// them — F11, no auto-activation).
  /// The bundle's rc scripts: `rc/*.tshrc`, sorted. Each must be a single
  /// `(bundle (m) …)` form; the HOST evaluates them at `@import` (hoisted
  /// before later host lines, once per file) and mounts the exports under the
  /// import alias. Pure file listing — nothing is read here.
  pub fn rc_scripts(&self) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(self.dir.join("rc")) else {
      return Vec::new();
    };
    let mut scripts: Vec<PathBuf> = entries
      .filter_map(|e| e.ok().map(|e| e.path()))
      .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "tshrc"))
      .collect();
    scripts.sort();
    scripts
  }

  pub fn ui_scripts(&self) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(self.dir.join("ui")) else {
      return Vec::new();
    };
    let mut scripts: Vec<PathBuf> = entries
      .filter_map(|e| e.ok().map(|e| e.path()))
      .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "tsh"))
      .collect();
    scripts.sort();
    scripts
  }

  /// Dispatch one command oneshot: spawn `bin <command> --json [--key value…]`,
  /// capture stdout, parse it as JSON (raw data or a tagged render shape).
  ///
  /// Errors are transport-native: a non-zero exit surfaces as
  /// [`AppError::CommandFailed`] carrying the code + stderr. Secrets never ride
  /// argv — auth is delegated via `$TENTO_SESSION_DIR`, which the child
  /// **inherits** from the shell's environment (the app sets it up at startup;
  /// this library neither reads nor re-sets it).
  ///
  /// Pilot uses a blocking spawn; production would use `tokio::process` and
  /// honor the manifest's `transport` tier.
  pub fn call_oneshot(&self, command: &str, args: &Value) -> Result<Value, AppError> {
    let mut cmd = Command::new(&self.bin);
    cmd.arg(command).arg("--json");
    if let Value::Object(map) = args {
      for (k, v) in map {
        cmd.arg(format!("--{k}"));
        match v {
          Value::Null => {}
          Value::String(s) => {
            cmd.arg(s);
          }
          other => {
            cmd.arg(other.to_string());
          }
        }
      }
    }
    self.finish(cmd, command)
  }

  /// Like [`Self::call_oneshot`] but forwards **raw CLI argv**
  /// (`bin <command> --json <extra…>`) instead of a JSON arg map. Both the
  /// CLI/REPL mount ([`crate::remote_group::RemoteGroup`]) AND the Lisp `@import`
  /// mounts route through this argv form (the latter lowers its evaluated Lisp
  /// args to argv first), so a bundle sees the same argv the user typed —
  /// `tsh whoop user-profile --foo x` is byte-identical to
  /// `tento-whoop user-profile --foo x`. The map-based [`Self::call_oneshot`] is
  /// now used only by the offline help round-trip test.
  pub fn call_oneshot_args(&self, command: &str, extra: &[String]) -> Result<Value, AppError> {
    let mut cmd = Command::new(&self.bin);
    cmd.arg(command).arg("--json").args(extra);
    self.finish(cmd, command)
  }

  /// Daemon transport: connect to the group's daemon socket (lazily spawning it
  /// via the manifest's `start` argv when absent), and dispatch `command` +
  /// `extra` as a JSON-RPC call. The daemon reconstructs the *same* argv a
  /// oneshot child would receive (`bin <command> --json <extra…>` ≡
  /// `[command, extra…]`), so a command behaves identically across transports —
  /// the only difference is that the daemon holds its `Info` (warm state) across
  /// calls instead of rebuilding it. Errors are transport-native (a JSON-RPC
  /// error surfaces here just as a non-zero oneshot exit does).
  ///
  /// Scope routing: a `scope == "session"` daemon is a **session-leased
  /// service** — its socket is DERIVED under the session dir
  /// (`<session>/services/<app>.sock`) and, when absent, the child is spawned +
  /// owned by the engine via `lease` (`kill_on_drop`) rather than the detached
  /// null-stdio spawn. A session-scoped call with no `lease` (a bare CLI, no
  /// session) is a clear error. Only an absent scope means detached; an unknown
  /// scope is rejected rather than silently receiving the wrong lifetime.
  pub async fn call_daemon_args(
    &self,
    command: &str,
    extra: &[String],
    lease: Option<&dyn crate::daemon_rpc::ServiceLease>,
  ) -> Result<Value, AppError> {
    let label = format!("{} {}", self.name, command);
    let daemon = self.manifest.daemon.as_ref().ok_or_else(|| {
      AppError::Daemon(
        label.clone(),
        "manifest declares transport=daemon but carries no `daemon` section".to_string(),
      )
    })?;

    let binding=crate::auth::app_binding(self).map_err(|e|AppError::Daemon(label.clone(),e.to_string()))?;
    let mut service_name=self.name.clone();
    let mut service_bin=self.bin.clone();
    let mut service_start=daemon.start.clone();
    let mut service_socket=PathBuf::from(&daemon.socket);
    if let Some(binding)=binding {
      service_name=format!("{}-{}",self.name,binding.profile.id);
      let mut prefix=Vec::new();
      for key in binding.launch.remove_env {prefix.extend(["-u".into(),key]);}
      for (key,value) in binding.launch.env {prefix.push(format!("{key}={value}"));}
      prefix.push(self.bin.to_string_lossy().into_owned());prefix.extend(service_start);
      service_start=prefix;service_bin=PathBuf::from("/usr/bin/env");
      service_socket.set_file_name(format!("{service_name}.sock"));
    }
    if matches!(daemon.scope.as_ref(), Some(DaemonScope::Session)) {
      let lease = lease.ok_or_else(|| {
        AppError::Daemon(
          label.clone(),
          format!(
            "`{}` is a session-scoped service and needs a live session — run it \
             inside a tsh session, not a bare CLI",
            self.name
          ),
        )
      })?;
      let socket = lease
        .service_socket(&service_name)
        .map_err(|e| AppError::Daemon(label.clone(), e.to_string()))?;
      return crate::daemon_rpc::Client::call_leased(
        &socket,
        lease,
        &service_name,
        &service_bin,
        &service_start,
        command,
        extra,
      )
      .await
      .map_err(|e| AppError::Daemon(label, e.to_string()));
    }

    if let Some(scope) = &daemon.scope {
      return Err(AppError::Daemon(
        label,
        format!("unsupported daemon scope `{}`", scope.as_str()),
      ));
    }

    let socket = service_socket.as_path();
    let start = (!service_start.is_empty()).then_some(service_start.as_slice());
    crate::daemon_rpc::Client::call(socket, start, &service_bin, command, extra)
      .await
      .map_err(|e| AppError::Daemon(label, e.to_string()))
  }

  /// Streaming transport: spawn `bin <command> <extra…>` with the terminal's
  /// stdio **inherited** (not captured) and wait. Unlike the oneshot path, this
  /// passes **no `--json`** — the child runs in normal human mode and its output
  /// (a wrapped `deno`/`tsc` run, a build, …) streams straight to the terminal.
  /// There is therefore no JSON channel to parse: success returns
  /// [`Value::Null`] (the run loop renders nothing) and a non-zero exit surfaces
  /// as [`AppError::CommandFailed`] (no captured stderr — it already streamed).
  ///
  /// When this thread's host installed a [`crate::foreground::ForegroundRunner`]
  /// (a host with no terminal of its own: tsh's session engine), the prepared
  /// command goes to it instead — same argv, same environment, the terminal is
  /// the host's. A runner with no terminal to offer fails the call at once
  /// ([`AppError::NeedsTerminal`]) rather than leaving the child waiting on a
  /// prompt nobody can see.
  pub fn call_streaming_args(&self, command: &str, extra: &[String]) -> Result<Value, AppError> {
    self.call_terminal_args(command, extra, false)
  }

  /// Terminal input/diagnostics with JSON stdout returned to the Lisp caller.
  pub fn call_interactive_args(&self, command: &str, extra: &[String]) -> Result<Value, AppError> {
    self.call_terminal_args(command, extra, true)
  }

  fn call_terminal_args(
    &self,
    command: &str,
    extra: &[String],
    capture_json: bool,
  ) -> Result<Value, AppError> {
    let label = format!("{} {}", self.name, command);
    let runner = crate::foreground::foreground_runner();
    let mut cmd = Command::new(&self.bin);
    cmd
      .arg(command)
      .args(extra)
      .stdin(std::process::Stdio::inherit())
      .stdout(std::process::Stdio::inherit())
      .stderr(std::process::Stdio::inherit());
    if capture_json {
      cmd.arg("--json");
      cmd.stdout(std::process::Stdio::piped());
    }
    // Hermetic spawn: with the session EnvMap installed the child's
    // environment IS the declared session env (env_clear + snapshot). Hosts
    // that never installed a map keep plain inheritance.
    let hermetic = tento_env::hermetic_child_env_os();
    let cleared = hermetic.is_some();
    if let Some(envs) = hermetic {
      cmd.env_clear();
      cmd.envs(envs);
    }
    self
      .child_env
      .apply(&mut cmd)
      .map_err(|e| AppError::Spawn(self.name.clone(), format!("environment binding: {e}")))?;
    crate::auth::apply_app_binding(self,&mut cmd).map_err(|e|AppError::Spawn(self.name.clone(),format!("profile binding: {e}")))?;
    // The child inherits our stdio, but `colored`'s atty detection on the
    // inherited fd is unreliable through mosh/tmux/ssh layers — so a streaming
    // command's structured render shapes (`table/v1`/`sections/v1`) lose their
    // color intermittently. We own the user-facing terminal decision: when OUR
    // stdout is a real terminal (and the user hasn't opted out via `NO_COLOR`
    // — a declared map entry, never a process-env read), tell the child to
    // colorize deterministically. Piped output → not forced → the child's own
    // detection keeps it plain. CLICOLOR_FORCE stays a mechanism-set var on
    // top of the hermetic snapshot. A foreground runner's terminal is a real
    // one by definition, so it counts as ours.
    pass_runtime_tsh_version(&mut cmd);
    let terminal = runner.is_some() || std::io::stdout().is_terminal();
    if terminal && tento_env::effective_var("NO_COLOR").is_none() {
      cmd.env("CLICOLOR_FORCE", "1");
    }
    if let Some(runner) = runner {
      let value = self.run_in_foreground(&*runner, label, &cmd, cleared, capture_json)?;
      if capture_json {
        crate::remote_group::note_declared_result(self, command, &value);
      }
      return Ok(value);
    }
    if capture_json {
      let out = cmd
        .output()
        .map_err(|e| AppError::Spawn(self.bin.display().to_string(), e.to_string()))?;
      if !out.status.success() {
        return Err(AppError::CommandFailed(
          label,
          out.status.code().unwrap_or(-1),
          String::new(),
        ));
      }
      let value = parse_interactive_result(&label, &String::from_utf8_lossy(&out.stdout))?;
      crate::remote_group::note_declared_result(self, command, &value);
      return Ok(value);
    }
    let status = cmd
      .status()
      .map_err(|e| AppError::Spawn(self.bin.display().to_string(), e.to_string()))?;
    if !status.success() {
      let code = status.code().unwrap_or(-1);
      return Err(AppError::CommandFailed(label, code, String::new()));
    }
    Ok(Value::Null)
  }

  /// Hand the prepared streaming `cmd` to `runner`. The child's environment is
  /// read back off `cmd`, so the runner's spawn sees exactly what the inherit
  /// spawn would have: the snapshot (or, with no map installed, the process
  /// environment the child would have inherited) with every binding applied.
  fn run_in_foreground(
    &self,
    runner: &dyn crate::foreground::ForegroundRunner,
    label: String,
    cmd: &Command,
    cleared: bool,
    capture_json: bool,
  ) -> Result<Value, AppError> {
    use crate::foreground::{ForegroundCommand, ForegroundError, ForegroundRun};
    let mut env: BTreeMap<std::ffi::OsString, std::ffi::OsString> = if cleared {
      BTreeMap::new()
    } else {
      tento_env::EnvMap::from_process()
        .snapshot_os()
        .into_iter()
        .collect()
    };
    for (key, value) in cmd.get_envs() {
      match value {
        Some(value) => env.insert(key.to_os_string(), value.to_os_string()),
        None => env.remove(key),
      };
    }
    let cwd = std::env::current_dir()
      .map_err(|e| AppError::Spawn(self.name.clone(), format!("working directory: {e}")))?;
    let argv = std::iter::once(self.name.clone())
      .chain(cmd.get_args().map(|arg| arg.to_string_lossy().into_owned()))
      .collect();
    let request = ForegroundCommand {
      label: label.clone(),
      program: self.bin.clone(),
      argv,
      cwd,
      env: env.into_iter().collect(),
      capture_json,
    };
    match runner.run(request) {
      Ok(ForegroundRun::Parked) => Ok(Value::Null),
      Ok(ForegroundRun::Exited { success: true,
        output,
        .. }) => {
        if capture_json {
          parse_interactive_result(&label, &output)
        } else {
          Ok(Value::Null)
        }
      }
      Ok(ForegroundRun::Exited { code, output, .. }) => {
        Err(AppError::StreamFailed(label, code.unwrap_or(-1), output))
      }
      Err(ForegroundError::NoTerminal(reason)) => Err(AppError::NeedsTerminal(label, reason)),
      Err(ForegroundError::Failed(reason)) => Err(AppError::Spawn(label, reason)),
    }
  }

  /// Resolve the transport for `command` + `extra`: a per-command override in
  /// `manifest.transports` (keyed by the full space-joined invocation path, so
  /// `changelog show` can differ from the bundle default) wins, else the
  /// bundle-level `manifest.transport` (default `oneshot`). The single place
  /// both the CLI/REPL [`crate::remote_group::RemoteGroup`] and the Lisp
  /// `@import` mounts decide a command's transport.
  pub fn resolve_transport(&self, command: &str, extra: &[String]) -> String {
    let argv: Vec<&str> = std::iter::once(command)
      .chain(extra.iter().map(String::as_str))
      .collect();
    // Overrides name command paths, not complete invocations. Match whole argv
    // elements and prefer the most specific path; trailing options/arguments
    // must not make a streaming login fall back to captured oneshot output.
    self
      .manifest
      .transports
      .iter()
      .filter_map(|(path, transport)| {
        let parts: Vec<&str> = path.split_whitespace().collect();
        (!parts.is_empty() && argv.starts_with(&parts)).then_some((parts.len(), transport))
      })
      .max_by_key(|(length, _)| *length)
      .map(|(_, transport)| transport.clone())
      .unwrap_or_else(|| self.manifest.transport.clone())
  }

  /// Dispatch `command` + `extra` over its [resolved transport](Self::resolve_transport),
  /// returning the result future. `oneshot`/`streaming` run synchronously inside
  /// the (immediately-ready) future; `daemon` connects to the group socket
  /// (session-leased via `lease` when `scope = session`) and awaits the JSON-RPC
  /// round trip. Shared by [`crate::remote_group::RemoteGroup::call_with_argv`]
  /// and the `@import` mounts so a command routes identically across both mount
  /// surfaces — the transport match lives here, not duplicated at each call site.
  pub fn dispatch_argv(
    &self,
    command: String,
    extra: Vec<String>,
    lease: Option<Rc<dyn crate::daemon_rpc::ServiceLease>>,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, AppError>>>> {
    Rc::new(self.clone()).dispatch_shared_argv(command, extra, lease)
  }

  /// Mounted callers already own an immutable shared descriptor. Keep it alive
  /// for the future instead of copying every command's metadata on each call.
  pub(crate) fn dispatch_shared_argv(
    self: Rc<Self>,
    command: String,
    extra: Vec<String>,
    lease: Option<Rc<dyn crate::daemon_rpc::ServiceLease>>,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, AppError>>>> {
    let transport = self.resolve_transport(&command, &extra);
    let app = self;
    Box::pin(async move {
      crate::auth::ensure_app_instance(&app).await.map_err(|e|AppError::Spawn(app.name.clone(),format!("profile binding: {e}")))?;
      match transport.as_str() {
        "daemon" => {
          app
            .call_daemon_args(&command, &extra, lease.as_deref())
            .await
        }
        "streaming" => app.call_streaming_args(&command, &extra),
        "interactive" => app.call_interactive_args(&command, &extra),
        "oneshot" => app.call_oneshot_args(&command, &extra),
        other => Err(unknown_transport(&app, &command, other)),
      }
    })
  }

  /// Spawn `cmd`, capture stdout, and parse it as JSON (raw data or a tagged
  /// render shape). Shared tail of the oneshot transport. With the session
  /// EnvMap installed the child is HERMETIC — `env_clear()` + the declared map
  /// (which carries `TENTO_SESSION_DIR` as a spawn-protocol entry); a host
  /// without a map keeps plain inheritance. Errors are transport-native: a
  /// non-zero exit surfaces as [`AppError::CommandFailed`] carrying the code +
  /// stderr.
  fn finish(&self, mut cmd: Command, command: &str) -> Result<Value, AppError> {
    if let Some(envs) = tento_env::hermetic_child_env_os() {
      cmd.env_clear();
      cmd.envs(envs);
    }
    self
      .child_env
      .apply(&mut cmd)
      .map_err(|e| AppError::Spawn(self.name.clone(), format!("environment binding: {e}")))?;
    crate::auth::apply_app_binding(self,&mut cmd).map_err(|e|AppError::Spawn(self.name.clone(),format!("profile binding: {e}")))?;
    pass_runtime_tsh_version(&mut cmd);
    let label = format!("{} {}", self.name, command);
    let out = cmd
      .output()
      .map_err(|e| AppError::Spawn(self.bin.display().to_string(), e.to_string()))?;
    if !out.status.success() {
      let code = out.status.code().unwrap_or(-1);
      let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
      return Err(AppError::CommandFailed(label, code, stderr));
    }
    // A bundle's stdout is the `--json` JSON channel, so its human/diagnostic
    // output rides **stderr** (per the protocol). On success surface any stderr
    // as a `kind="stderr"` trace row rather than dropping it — without it a
    // bundle command has no way to show diagnostics under tsh.
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stderr = stderr.trim();
    if !stderr.is_empty() {
      tracing::warn!(kind = "stderr", app = %self.name, command = %command, message = %stderr);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
      return Ok(Value::Null);
    }
    let value: Value = serde_json::from_str(trimmed).map_err(|e| AppError::Parse(label, e.to_string()))?;
    crate::remote_group::note_declared_result(self, command, &value);
    Ok(value)
  }
}

/// A mounted command's failure as the Lisp error it raises. A plugin that
/// wrote its failure as a record on stderr — `{"error": {...}}`, the shape
/// `--json` asks it for, or a bare `error/v1` record — raises a
/// [`RuntimeError::Reported`], so `(try …)` keeps its `kind`, `host` and
/// `next`; anything else keeps the plain text it always had. `namespace` is
/// the alias the bundle is mounted under, which a structured `next` is
/// written in.
fn command_failure(namespace: &str, command: &str, error: AppError) -> RuntimeError {
  if let AppError::CommandFailed(label, code, stderr) = &error {
    if let Some(mut failure) = reported_failure(namespace, stderr) {
      failure.message = format!("{command}: `{label}` exited with code {code}: {}", failure.message);
      return RuntimeError::Reported(Box::new(failure));
    }
  }
  if let AppError::StreamFailed(_, _, output) = &error {
    // What the command printed is the value's `output`, not more text.
    return RuntimeError::Reported(Box::new(tento_lisp::ReportedFailure {
      message: format!("{command}: {error}"),
      output: (!output.trim().is_empty()).then(|| output.clone()),
      ..tento_lisp::ReportedFailure::default()
    }));
  }
  RuntimeError::Other(format!("{command}: {error}"))
}

/// The failure record a plugin's whole stderr holds, if it holds one: a JSON
/// object that is `{"error": {...}}` or itself an `error/v1` record, with a
/// non-empty string `message`. `kind` and `host` are read when they are
/// non-empty strings. `next` is structured — `{"command", "args", "text"}` —
/// and becomes the tsh call that does it ([`next_call`]), or its `text` when
/// it names no command; a plain string `next` is taken as that text. A
/// record whose `shape` is a string and whose `rows` is an array also carries
/// its display fields ([`tento_lisp::ReportedFailure::DISPLAY_FIELDS`]),
/// copied verbatim: the grid a command drew before it failed (acme's kind
/// `partial`). Every other field is ignored.
pub fn reported_failure(namespace: &str, stderr: &str) -> Option<tento_lisp::ReportedFailure> {
  let value: Value = serde_json::from_str(stderr.trim()).ok()?;
  let record = match value.get("error") {
    Some(inner) if inner.is_object() => inner,
    _ if value.get("type").and_then(Value::as_str) == Some("error/v1") => &value,
    _ => return None,
  };
  let text = |value: Option<&Value>| {
    value
      .and_then(Value::as_str)
      .map(str::trim)
      .filter(|text| !text.is_empty())
      .map(str::to_string)
  };
  let hint = text(record.get("hint"));
  let next = match record.get("next") {
    Some(next @ Value::Object(_)) => next_call(namespace, next).or_else(|| text(next.get("text"))),
    other => text(other),
  };
  let display = (record.get("shape").is_some_and(Value::is_string)
    && record.get("rows").is_some_and(Value::is_array))
  .then(|| {
    tento_lisp::ReportedFailure::DISPLAY_FIELDS
      .iter()
      .filter_map(|key| Some((key.to_string(), record.get(*key)?.clone())))
      .collect()
  });
  Some(tento_lisp::ReportedFailure {
    message: text(record.get("message"))?,
    kind: text(record.get("kind")),
    host: text(record.get("host")),
    hint,
    next,
    output: None,
    display,
  })
}

/// A structured `next` written as the tsh call that does it, in the alias
/// the bundle is mounted under: `{"command": "cells.get", "args": {"row":
/// "notes", "json": true}}` under `acme` is `(acme.cells.get :json true
/// :row "notes")`. `args` is an object of keyword flags (`:flag value`, in
/// key order), or an array whose scalars are positional and whose objects
/// are keyword flags, which fixes the order — `["sheet/1", {"json": true}]` is
/// `(acme.cells.get "sheet/1" :json true)`. Values are JSON scalars; a
/// command name that is not a plain dotted name, or an argument that is not
/// a scalar, writes no call, so the record's `text` is used instead. So does
/// a value the written call would not carry faithfully: a string tsh lowers to
/// a flag (`":notes"`, `"--notes"`, `"--"`; see `lisp_args_to_argv`), a string
/// with a control character tento-lisp has no escape for, or an integer above
/// `i64::MAX`.
pub fn next_call(namespace: &str, next: &Value) -> Option<String> {
  let command = next.get("command").and_then(Value::as_str)?.trim();
  let plain = |name: &str| {
    !name.is_empty()
      && name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
  };
  if !plain(command) || !plain(namespace) {
    return None;
  }
  fn scalar(value: &Value) -> Option<String> {
    match value {
      Value::String(text) => {
        // tsh's argv lowering reads these as options, whatever the quoting.
        let rest = text.strip_prefix(':').or_else(|| text.strip_prefix("--"));
        let option = rest.is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_alphabetic()));
        // serde_json writes these as `\u00XX`, which tento-lisp does not read.
        let unescapable = text
          .chars()
          .any(|c| c.is_ascii_control() && !matches!(c, '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' | '\u{7f}'));
        if option || text == "--" || unescapable {
          return None;
        }
        serde_json::to_string(text).ok()
      }
      Value::Number(number) if number.is_u64() && number.as_i64().is_none() => None,
      Value::Number(number) => Some(number.to_string()),
      Value::Bool(flag) => Some(flag.to_string()),
      Value::Null => Some("nil".to_string()),
      _ => None,
    }
  }
  fn flags(words: &mut Vec<String>, map: &serde_json::Map<String, Value>) -> Option<()> {
    for (key, value) in map {
      let ok = !key.is_empty()
        && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
      if !ok {
        return None;
      }
      words.push(format!(":{key}"));
      words.push(scalar(value)?);
    }
    Some(())
  }
  let mut words = vec![format!("{namespace}.{command}")];
  match next.get("args") {
    None | Some(Value::Null) => {}
    Some(Value::Object(map)) => flags(&mut words, map)?,
    Some(Value::Array(items)) => {
      for item in items {
        match item {
          Value::Object(map) => flags(&mut words, map)?,
          other => words.push(scalar(other)?),
        }
      }
    }
    Some(_) => return None,
  }
  Some(format!("({})", words.join(" ")))
}

/// The dispatch-time refusal of a transport this binary does not implement.
/// [`TshApp::parse_manifest`] already refuses one at load; this covers a
/// manifest built in memory.
fn unknown_transport(app: &TshApp, command: &str, transport: &str) -> AppError {
  AppError::InvalidManifest(
    app.name.clone(),
    format!(
      "`{command}` resolves to unknown transport `{transport}` (expected one of: {})",
      TRANSPORTS.join(", ")
    ),
  )
}

/// Resolve `name` → the first `<dir>/<name>.tsh.app` across `dirs` (a
/// `PATH`-like search; earlier entries shadow later ones).
///
/// The search dirs are **injected by the caller**, never read from the
/// environment here. The application declares its app path once in `main.rs`
/// as typed `tento_env` config (e.g. a `TSH_APP_PATH` `env_kv!`/`FromEnv`
/// field) and passes the resolved dirs down — library code does not ask for
/// one-off env vars.
pub fn resolve(name: &str, dirs: &[PathBuf]) -> Result<TshApp, AppError> {
  for dir in dirs {
    let candidate = dir.join(format!("{name}.tsh.app"));
    if candidate.join("manifest.json").is_file() {
      return TshApp::load(&candidate);
    }
  }
  Err(AppError::NotFound(name.to_string()))
}

/// Enumerate every `*.tsh.app` bundle across `dirs` and load each — a listing
/// of what's **importable** (e.g. for a future `tsh apps`). It is NOT the mount
/// mechanism: mounting is driven by explicit `(@import "<bundle>" :as "<ns>")`
/// declarations in a `.tshrc` (see [`parse_import_decls`]), so a bundle's
/// namespace is chosen at the import site, not derived here.
///
/// `dirs` is a `PATH`-like search: earlier dirs **shadow** later ones by bundle
/// name (first wins, matching `resolve`). A bundle with a bad/missing manifest
/// is **skipped with a warning** to stderr rather than aborting — one broken
/// bundle never takes down the listing. A missing/unreadable search dir is
/// silently ignored (an empty or not-yet-created app dir is normal).
///
/// As with [`resolve`], `dirs` is injected by the caller; this never reads the
/// environment.
pub fn discover_apps(dirs: &[PathBuf]) -> Vec<TshApp> {
  let mut seen = std::collections::HashSet::new();
  let mut apps = Vec::new();
  for dir in dirs {
    let Ok(entries) = std::fs::read_dir(dir) else {
      continue; // missing/unreadable search dir — not fatal
    };
    // Deterministic order within a dir (read_dir order is OS-dependent).
    let mut bundles: Vec<PathBuf> = entries
      .filter_map(|e| e.ok().map(|e| e.path()))
      .filter(|p| {
        p.is_dir()
          && p
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|n| n.ends_with(".tsh.app"))
      })
      .collect();
    bundles.sort();
    for bundle in bundles {
      match TshApp::load(&bundle) {
        // earlier dir wins: skip a bundle name already seen from a prior dir
        Ok(app) if seen.insert(app.name.clone()) => apps.push(app),
        Ok(_) => {}
        Err(e) => eprintln!("warning: skipping tsh app `{}`: {e}", bundle.display()),
      }
    }
  }
  apps
}

/// One `(@import "<bundle>" :as "<ns>" [:from "<dir>"])` declaration extracted
/// from a `.tshrc`.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportDecl {
  /// The bundle name to `resolve` (e.g. `tento-whoop`).
  pub bundle: String,
  /// The explicit mount namespace (the `:as` value, e.g. `whoop`).
  pub namespace: String,
  /// Optional search dir (the `:from` value) where this import's bundle lives —
  /// searched before the global app path, so an rc can be self-contained (no
  /// `$TSH_APP_PATH` needed). `None` falls back to the configured app dirs.
  pub from: Option<String>,
  /// The bare `:optional` flag — this import is HOST-DEPENDENT. A bundle that
  /// does not resolve is the declared case, so the mount is skipped silently
  /// instead of warning. Without it a missing bundle still warns.
  pub optional: bool,
}

/// Scan a `.tshrc` source for its `(@import "<bundle>" :as "<ns>")` declarations
/// — the **link phase** that lets `tsh` main mount CLI namespaces *before* the
/// run loop (the shell's `subcommands` map is fixed once the loop starts). This
/// is a lightweight structural scan, not a full evaluation: it pulls the two
/// string literals out of each top-level `@import` form and ignores everything
/// else (comments, `login` command lines, other lisp). Malformed `@import`
/// lines (missing `:as`, non-string args) are skipped — the same line, run for
/// real through the lisp host afterward, surfaces the precise error.
pub fn parse_import_decls(source: &str) -> Vec<ImportDecl> {
  let mut decls = Vec::new();
  for raw in source.lines() {
    let line = raw.trim();
    let Some(rest) = line.strip_prefix("(@import") else {
      continue;
    };
    // Pull the quoted string literals in order: [bundle, namespace, from?]. A
    // correct `(@import "b" :as "ns")` yields two; with `:from "dir"`, three (in
    // that canonical order). Require `:as`; treat the 3rd literal as `:from`.
    let strings = double_quoted_literals(rest);
    if strings.len() >= 2 && rest.contains(":as") {
      let from = if rest.contains(":from") && strings.len() >= 3 {
        Some(strings[2].clone())
      } else {
        None
      };
      decls.push(ImportDecl {
        bundle: strings[0].clone(),
        namespace: strings[1].clone(),
        from,
        optional: rest.contains(":optional"),
      });
    }
  }
  decls
}

/// Extract the contents of each `"…"` double-quoted literal in `s`, in order.
/// Honors `\"` escapes inside a literal. Used by [`parse_import_decls`] to read
/// the bundle + namespace out of an `@import` form without a full lisp parse.
fn double_quoted_literals(s: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut chars = s.chars().peekable();
  while let Some(c) = chars.next() {
    if c != '"' {
      continue;
    }
    let mut lit = String::new();
    while let Some(c) = chars.next() {
      match c {
        '\\' => {
          if let Some(next) = chars.next() {
            lit.push(next); // keep the escaped char verbatim (e.g. \" → ")
          }
        }
        '"' => break,
        _ => lit.push(c),
      }
    }
    out.push(lit);
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  mod allocation_probe {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;
    thread_local! { static BYTES: Cell<Option<usize>> = const { Cell::new(None) }; }
    struct Allocator;
    fn count(size: usize) {
      let _ = BYTES.try_with(|bytes| {
        if let Some(n) = bytes.get() {
          bytes.set(Some(n + size));
        }
      });
    }
    // SAFETY: forward all allocation arguments unchanged to System; the
    // thread-local counter neither allocates nor accesses the managed memory.
    unsafe impl GlobalAlloc for Allocator {
      unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        unsafe { System.alloc(layout) }
      }
      unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
      }
      unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count(size);
        unsafe { System.realloc(ptr, layout, size) }
      }
    }
    #[global_allocator]
    static ALLOCATOR: Allocator = Allocator;
    pub fn allocated_bytes<T>(f: impl FnOnce() -> T) -> (T, usize) {
      struct Reset;
      impl Drop for Reset {
        fn drop(&mut self) {
          BYTES.set(None);
        }
      }
      BYTES.set(Some(0));
      let reset = Reset;
      let value = f();
      let bytes = BYTES.get().unwrap();
      drop(reset);
      (value, bytes)
    }
  }

  fn import_fixture(metadata: Value) -> TshApp {
    TshApp {
      name: "fixture".into(),
      dir: "/nonexistent/tsh-perf-import".into(),
      bin: "/nonexistent/tsh-perf-import/bin/fixture".into(),
      manifest: Rc::new(serde_json::from_value(serde_json::json!({
        "schema": "tsh.app/v1", "name": "fixture", "version": "1",
        "entrypoint": "bin/fixture", "commands": {"run": metadata}
      }))
      .unwrap()),
      child_env: Default::default(),
    }
  }

  #[test]
  fn owned_import_does_not_copy_opaque_metadata() {
    let app = import_fixture(serde_json::json!({"description": "x".repeat(1_048_576)}));
    let registration = Rc::new(RefCell::new(None));
    let (mounts, bytes) = allocation_probe::allocated_bytes(|| {
      owned_app_to_import_mounts(app, "fixture", registration, None, Default::default())
    });
    assert!(mounts.mounts.iter().any(|(name, _)| name == "fixture.run"));
    assert!(
      bytes < 65_536,
      "mounting copied unrelated metadata: {bytes} allocated bytes"
    );
  }

  /// tsh-core-shell(14) item 2: the stderr records a plugin failure may be.
  #[test]
  fn a_plugin_failure_record_is_read_from_its_whole_stderr() {
    let envelope = reported_failure(
      "acme",
      r#" {"error":{"kind":"auth","message":"key rejected","host":"acme.so","next":{"text":"re-store the key"},"exitCode":2,"status":401}} "#,
    )
    .expect("the --json error envelope");
    assert_eq!(envelope.message, "key rejected");
    assert_eq!(envelope.kind.as_deref(), Some("auth"));
    assert_eq!(envelope.host.as_deref(), Some("acme.so"));
    assert_eq!(envelope.next.as_deref(), Some("re-store the key"), "no command: its text");
    let bare = reported_failure("acme", r#"{"type":"error/v1","kind":"usage","message":"--limit is 1 to 100"}"#)
      .expect("a bare error/v1 record");
    assert_eq!((bare.kind.as_deref(), bare.host, bare.next), (Some("usage"), None, None));
    let plain = reported_failure("acme", r#"{"error":{"message":"m","next":"run setup"}}"#).unwrap();
    assert_eq!(plain.next.as_deref(), Some("run setup"), "a string next is its text");
    // Text, a record with no message, an empty field, and JSON that is not a
    // failure record all stay text.
    assert!(reported_failure("acme", "acme: no Acme API key").is_none());
    assert!(reported_failure("acme", r#"{"error":{"kind":"auth"}}"#).is_none());
    assert!(reported_failure("acme", r#"{"error":"just text"}"#).is_none());
    assert!(reported_failure("acme", r#"{"ok":false}"#).is_none());
    let blank = reported_failure("acme", r#"{"error":{"message":"m","host":"  "}}"#).unwrap();
    assert_eq!(blank.host, None, "a blank field is absent");
    assert_eq!(blank.display, None, "no display fields");
    // A record that drew a grid (acme's kind `partial`) carries its display
    // fields verbatim; `shape` without `rows` is not a grid.
    let partial = reported_failure(
      "acme",
      r#"{"error":{"kind":"partial","message":"m","shape":"term.block/v1","rows":[{"spans":[{"text":"Count"}]}],"title":"t","exitCode":3}}"#,
    )
    .unwrap();
    let display = partial.display.expect("display fields");
    assert_eq!(display.keys().collect::<Vec<_>>(), ["rows", "shape", "title"]);
    assert_eq!(display["rows"][0]["spans"][0]["text"], "Count");
    let shape_only = reported_failure("acme", r#"{"error":{"message":"m","shape":"term.block/v1"}}"#).unwrap();
    assert_eq!(shape_only.display, None);
    // The raised error's text puts the fields on their own lines, with a
    // structured next written as a tsh call under the mount's alias.
    let raised = command_failure("acme", "sheets.get", AppError::CommandFailed("acme sheets.get".into(), 2,
      r#"{"error":{"kind":"not-found","message":"Sheet was not found","host":"127.0.0.1:47900","hint":"The sheet may have been deleted.","next":{"command":"sheets.list","args":{},"text":"list your sheets"}}}"#.into()));
    assert_eq!(
      raised.to_string(),
      "sheets.get: `acme sheets.get` exited with code 2: Sheet was not found\n\
       kind: not-found\n\
       host: 127.0.0.1:47900\n\
       hint: The sheet may have been deleted.\n\
       try: (acme.sheets.list)"
    );
    let text = command_failure("acme", "sheets.get", AppError::CommandFailed("acme sheets.get".into(), 2, "acme: boom".into()));
    assert_eq!(text.to_string(), "sheets.get: `acme sheets.get` exited with code 2: acme: boom");
    // PE-16: a streaming command's printed lines are the value's `output`,
    // never repeated in its text.
    let streamed = command_failure("acme", "sync", AppError::StreamFailed("acme sync".into(), 1, "a\nacme: lost the server".into()));
    assert_eq!(streamed.to_string(), "sync: `acme sync` exited with code 1");
    let RuntimeError::Reported(failure) = streamed else { panic!("a reported failure") };
    assert_eq!(failure.output.as_deref(), Some("a\nacme: lost the server"));
  }

  /// A structured `next` is written in tsh's own syntax under the alias.
  #[test]
  fn a_structured_next_is_written_as_a_tsh_call() {
    let call = |ns: &str, next: Value| next_call(ns, &next);
    assert_eq!(
      call("acme", serde_json::json!({"command":"cells.get","args":{"row":"notes","start":"2026-09-01","json":true,"limit":5}})),
      Some(r#"(acme.cells.get :json true :limit 5 :row "notes" :start "2026-09-01")"#.into()),
      "an object's flags are written in key order"
    );
    assert_eq!(
      call("l", serde_json::json!({"command":"cells.get","args":["sheet/1 \"x\"", {"json": true}]})),
      Some(r#"(l.cells.get "sheet/1 \"x\"" :json true)"#.into()),
      "positional strings are quoted and escaped; the alias is the mount's"
    );
    assert_eq!(call("acme", serde_json::json!({"command":"sheets.list"})), Some("(acme.sheets.list)".into()));
    for unwritable in [
      serde_json::json!({"text":"no command"}),
      serde_json::json!({"command":"rm -rf /","text":"x"}),
      serde_json::json!({"command":"cells.get","args":{"row":{"nested":1}}}),
      serde_json::json!({"command":"cells.get","args":{"bad key":1}}),
      serde_json::json!({"command":"cells.get","args":"row"}),
    ] {
      assert_eq!(call("acme", unwritable.clone()), None, "{unwritable}");
    }
  }

  /// A value the call would not carry faithfully writes no call, so the
  /// record's `text` is shown: a string tsh lowers to a flag, a control
  /// character the lexer has no escape for, an integer above `i64::MAX`.
  #[test]
  fn a_structured_next_refuses_values_tsh_would_misread() {
    for args in [
      serde_json::json!({"row":":notes"}),
      serde_json::json!([":notes"]),
      serde_json::json!({"row":"--notes"}),
      serde_json::json!(["--"]),
      serde_json::json!({"row":"a\u{1b}[31mb"}),
      serde_json::json!(["\u{0}"]),
      serde_json::json!({"limit":u64::MAX}),
    ] {
      let next = serde_json::json!({"command":"cells.get","args":args,"text":"fallback"});
      assert_eq!(next_call("acme", &next), None, "{args}");
      let record = serde_json::json!({"type":"error/v1","message":"m","next":next}).to_string();
      let failure = reported_failure("acme", &record).unwrap();
      assert_eq!(failure.next.as_deref(), Some("fallback"), "{args}");
    }
    // Values that do round-trip through the reader are still written.
    let values = serde_json::json!([":", ":1", "-x", "a\tb", i64::MAX, -3, 1.5]);
    let written = next_call("acme", &serde_json::json!({"command":"cells.get","args":values})).unwrap();
    assert_eq!(written, format!(r#"(acme.cells.get ":" ":1" "-x" "a\tb" {} -3 1.5)"#, i64::MAX));
    let list = format!("(list{}", &written["(acme.cells.get".len()..]);
    assert_eq!(LispHost::new().eval_to_json(&list).unwrap(), values);
  }

  #[test]
  fn structural_module_reflection_does_not_start_the_bundle_or_copy_descriptions() {
    let mut app = import_fixture(serde_json::json!({
      "name":"run", "description":"x".repeat(1_048_576), "options":[],
      "result":{"type":{"kind":"string"}}
    }));
    let raw = app.manifest.commands["run"].raw().to_string();
    Rc::make_mut(&mut app.manifest).commands.insert("run".into(), serde_json::from_str(&raw).unwrap());
    assert!(!app.manifest.commands["run"].is_decoded());
    let mut host = LispHost::new();
    let mounts = owned_app_to_import_mounts(app, "renamed", host.registration_guard(), None, Default::default());
    let module = mounts.mounts.iter().find_map(|(_, value)| match value {
      LispValue::Module(module) => Some(module.clone()), _ => None,
    }).unwrap();
    let (_, bytes) = allocation_probe::allocated_bytes(|| {
      assert_eq!(module.methods()["run"].signature.result, tento_lisp::types::TypeExpr::String);
    });
    assert!(bytes < 65_536, "reflection copied unrelated descriptions: {bytes}");
    host.mount(mounts, "renamed");
    host.eval_value("(trait Runner (fn run () -> string))").unwrap();
    assert_eq!(host.eval_to_json("(trait.conforms Runner renamed)").unwrap(), serde_json::json!(true));
    assert_eq!(host.eval_to_json("(module.name (first (trait.impls Runner)))").unwrap(), serde_json::json!("renamed"));
  }

  #[test]
  fn imported_help_reads_the_manifest_without_starting_the_bundle() {
    let doc = serde_json::json!({"type":"command.doc/v1", "name":"run", "description":"Run", "options":[]});
    let mut app = import_fixture(doc.clone());
    Rc::make_mut(&mut app.manifest).transport = "daemon".into();
    let mut host = LispHost::new();
    let mounts = owned_app_to_import_mounts(app, "fixture", host.registration_guard(), None, Default::default());
    host.mount(mounts, "fixture");
    assert_eq!(host.eval_to_json("(fixture.run :help)").unwrap(), doc);
    assert_eq!(host.eval_posix_line("fixture.run --help").unwrap(), doc);
  }

  #[test]
  fn owned_import_keeps_environment_bindings_local() {
    let app = import_fixture(Value::Null);
    let original = app.child_env.clone();
    original
      .set(
        LispValue::Map(
          [("ORIGINAL".into(), LispValue::String("kept".into()))]
            .into_iter()
            .collect(),
        ),
        crate::app_env::Authority::Script,
      )
      .unwrap();
    let mut host = LispHost::new();
    let mounts = owned_app_to_import_mounts(
      app,
      "fixture",
      host.registration_guard(),
      None,
      Default::default(),
    );
    host.mount(mounts, "fixture");
    host
      .eval_stmt(r#"(fixture.env.bind json`{"MOUNT_ONLY":"local"}`)"#)
      .unwrap();
    let mut command = std::process::Command::new("unused");
    original.apply(&mut command).unwrap();
    let entries: Vec<_> = command
      .get_envs()
      .map(|(k, v)| {
        (
          k.to_string_lossy().into_owned(),
          v.unwrap().to_string_lossy().into_owned(),
        )
      })
      .collect();
    assert_eq!(entries, vec![("ORIGINAL".into(), "kept".into())]);
  }

  thread_local! {
    static RC_POLICY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
  }

  /// The host probe every test in this binary installs: a per-thread flag, so
  /// tests running in parallel never see each other's answer.
  fn rc_policy_probe() -> bool {
    RC_POLICY.with(std::cell::Cell::get)
  }

  /// `<ns>.env.bind` asks the host whether its caller is rc policy. A secret
  /// token from anything else is refused (the declaration whole — see
  /// `app_env::tests::only_rc_policy_binds_a_secret` for what stays bound);
  /// plain values bind from anywhere; and the same secret binds while the
  /// host says rc policy is evaluating.
  #[test]
  fn env_bind_takes_a_secret_only_from_host_rc_policy() {
    crate::app_env::set_rc_policy_probe(rc_policy_probe);
    let mut host = LispHost::new();
    host.register_native_special("secret", |args| match args.into_iter().next() {
      Some(LispValue::String(address)) => Ok(LispValue::TaggedString {
        tag: "secret".into(),
        payload: address.into_string(),
      }),
      other => Err(tento_lisp_cmd::script::LispHostError::Runtime(format!(
        "secret: {other:?}"
      ))),
    });
    let mounts = owned_app_to_import_mounts(
      import_fixture(Value::Null),
      "fixture",
      host.registration_guard(),
      None,
      Default::default(),
    );
    host.mount(mounts, "fixture");
    let bind_secret = r#"(fixture.env.bind {"ACCESS_TOKEN" (secret "test/key") "MODE" "x"})"#;

    host
      .eval_stmt(r#"(fixture.env.bind {"MODE" "plain"})"#)
      .expect("a plain binding needs no authority");
    let refused = host
      .eval_stmt(bind_secret)
      .expect_err("a script cannot bind a secret")
      .to_string();
    assert!(
      refused.contains("only rc policy") && refused.contains("test/key"),
      "{refused}"
    );

    RC_POLICY.with(|flag| flag.set(true));
    let bound = host.eval_stmt(bind_secret);
    RC_POLICY.with(|flag| flag.set(false));
    bound.expect("rc policy binds the secret");
  }

  #[test]
  fn manifest_decode_keeps_command_docs_as_text_until_read() {
    let text = r#"{
      "schema": "tsh.app/v1", "name": "fixture", "version": "1",
      "entrypoint": "bin/fixture",
      "commands": {"run": {"args": ["one", {"nested": [1, 2, 3]}]}, "stop": {"args": []}},
      "help": {"rows": [["one", "two"], ["three", "four"]]}
    }"#;
    let manifest = decode_manifest(text, "fixture").unwrap();
    assert_eq!(manifest.commands.len(), 2);
    assert!(!manifest.commands["run"].is_decoded());
    assert_eq!(
      manifest.commands["run"].raw(),
      r#"{"args": ["one", {"nested": [1, 2, 3]}]}"#
    );
    assert_eq!(manifest.commands["run"]["args"][1]["nested"][2], 3);
    assert!(manifest.commands["run"].is_decoded());
    assert!(!manifest.commands["stop"].is_decoded());
    let help = manifest.help.as_ref().unwrap();
    assert!(!help.is_decoded());
    assert_eq!(help["rows"][1][0], "three");
    // A tree handed in already decoded stays decoded and round-trips its text.
    let given = LazyValue::from(serde_json::json!({"a": [1, 2]}));
    assert!(given.is_decoded());
    assert_eq!(given.raw(), r#"{"a":[1,2]}"#);
    assert_eq!(given["a"][1], 2);
  }

  #[test]
  fn manifest_decode_matches_derived_values_and_errors() {
    let base = serde_json::json!({
      "schema": "tsh.app/v1", "name": "fixture", "version": "1",
      "entrypoint": "bin/fixture", "transport": "oneshot"
    });
    let values = [
      Value::Null,
      serde_json::json!(true),
      serde_json::json!(42),
      serde_json::json!("text"),
      serde_json::json!([1, {"x": [false, null]}]),
      serde_json::json!({"run": {"args": ["x"], "custom": {"a": 1}}, "empty": null}),
    ];
    // The derived deserializer reports text positions; the split decoder
    // parses the envelope from a tree and so cannot. Compare the message.
    let message = |e: serde_json::Error| {
      let text = e.to_string();
      match text.find(" at line ") {
        Some(at) => text[..at].to_string(),
        None => text,
      }
    };
    let check = |wire: Value| {
      let text = wire.to_string();
      let expected = serde_json::from_str::<AppManifest>(&text);
      let actual = decode_manifest(&text, "fixture");
      match (expected, actual) {
        (Ok(expected), Ok(actual)) => assert_eq!(format!("{expected:?}"), format!("{actual:?}")),
        (Err(expected), Err(actual)) => assert_eq!(message(expected), message(actual), "{text}"),
        (expected, actual) => panic!("decode mismatch for {text}: {expected:?} vs {actual:?}"),
      }
    };
    check(base.clone());
    for commands in &values {
      for help in &values {
        let mut wire = base.clone();
        wire["commands"] = commands.clone();
        wire["help"] = help.clone();
        check(wire.clone());
        // Preserve validation, including errors outside the opaque fields.
        for key in [
          "schema",
          "name",
          "version",
          "entrypoint",
          "transport",
          "daemon",
          "transports",
          "provides",
          "services",
        ] {
          let mut invalid = wire.clone();
          invalid[key] = serde_json::json!(42);
          check(invalid);
        }
      }
    }
    // A non-object manifest is an error either way; the derived deserializer
    // would accept a positional sequence, so only the outcome is compared.
    for wire in values {
      let text = wire.to_string();
      assert!(serde_json::from_str::<AppManifest>(&text).is_err(), "{text}");
      assert!(decode_manifest(&text, "fixture").is_err(), "{text}");
    }
    // Duplicate keys: the last occurrence wins, at every level, as a `Value`
    // parse of the same text would have it.
    let duplicate = r#"{"schema":"tsh.app/v1","name":"fixture","version":"1","entrypoint":"bin/fixture","commands":false,"commands":{"x":{"a":1,"a":2}},"help":1,"help":null}"#;
    let manifest = decode_manifest(duplicate, "fixture").unwrap();
    assert_eq!(manifest.commands.len(), 1);
    assert_eq!(manifest.commands["x"]["a"], 2);
    assert!(manifest.help.is_none());
  }

  #[test]
  fn transport_overrides_match_command_paths_with_arguments() {
    let manifest: AppManifest = serde_json::from_value(serde_json::json!({
      "schema": "tsh.app/v1", "name": "fixture", "version": "0.0.0",
      "entrypoint": "bin/fixture", "transport": "oneshot", "commands": {},
      "transports": {"auth.login": "streaming", "changelog": "daemon",
                     "changelog show": "streaming"}
    }))
    .unwrap();
    let app = TshApp {
      name: "fixture".into(),
      dir: PathBuf::new(),
      bin: PathBuf::new(),
      child_env: Default::default(),
      manifest: Rc::new(manifest),
    };
    let resolve = |command, extra: &[&str]| {
      app.resolve_transport(
        command,
        &extra.iter().map(|arg| arg.to_string()).collect::<Vec<_>>(),
      )
    };
    assert_eq!(resolve("auth.login", &[]), "streaming");
    assert_eq!(
      resolve("auth.login", &["--account", "fixture@example.com"]),
      "streaming"
    );
    assert_eq!(
      resolve("gmail.search", &["--query", "auth.login"]),
      "oneshot"
    );
    assert_eq!(resolve("auth.login.extra", &[]), "oneshot");
    assert_eq!(
      resolve("changelog", &["show", "--since", "yesterday"]),
      "streaming"
    );
    assert_eq!(resolve("changelog", &["showcase"]), "daemon");
    assert_eq!(resolve("changelog", &["show --since yesterday"]), "daemon");
  }

  /// A session-scoped app whose service is already listening: the client
  /// connects to the DERIVED per-session socket and dispatches WITHOUT ever
  /// asking the lease to spawn (the lease's `ensure_service` flips a flag we
  /// assert stayed unset). Then, with no lease (a bare CLI), a session-scoped
  /// call returns the clear "needs a live session" error.
  #[tokio::test]
  #[cfg(unix)] // binds a real Unix socket via serve_scripts
  async fn session_scoped_call_uses_derived_socket_and_errors_without_a_session() {
    use crate::daemon_rpc::ServiceLease;
    use crate::serve::serve_scripts;
    use std::cell::Cell;
    use std::path::Path;
    use tento_lisp_cmd::{CommandArg, Scripts, command};

    #[derive(CommandArg, serde::Deserialize, Clone)]
    pub struct EchoArgs {
      pub text: String,
    }
    #[command(name = "echo", description = "echo the text back")]
    async fn echo(_ctx: (), args: EchoArgs) -> tento_lisp_cmd::Result<Value> {
      Ok(serde_json::json!({ "echoed": args.text }))
    }

    // A lease pointing at a temp session dir; `ensure_service` must NOT run when
    // the socket is already live.
    struct TestLease {
      dir: std::path::PathBuf,
      spawned: std::rc::Rc<Cell<bool>>,
    }
    impl ServiceLease for TestLease {
      fn service_socket(&self, app: &str) -> anyhow::Result<std::path::PathBuf> {
        Ok(self.dir.join("services").join(format!("{app}.sock")))
      }
      fn ensure_service(&self, _: &str, _: &Path, _: &Path, _: &[String]) -> anyhow::Result<()> {
        self.spawned.set(true);
        Ok(())
      }
    }

    // Short dir: the bound Unix socket path must stay under the platform's
    // `SUN_LEN` (~104 bytes on macOS), so no long nonce here (pid-only, like the
    // serve round-trip test).
    let dir = std::env::temp_dir().join(format!("tn-sc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let app_name = "svc";
    let socket = dir.join("services").join(format!("{app_name}.sock"));

    // A session-scoped daemon app, constructed directly (no bundle on disk).
    let app = TshApp {
      name: app_name.to_string(),
      dir: dir.clone(),
      bin: std::path::PathBuf::from("unused-bin"),
      child_env: Default::default(),
      manifest: Rc::new(AppManifest {
        schema: TSH_APP_SCHEMA.to_string(),
        name: app_name.to_string(),
        version: "0.0.0-test".to_string(),
        requires_tsh: None,
        entrypoint: "bin/unused-bin".to_string(),
        transport: "daemon".to_string(),
        daemon: Some(DaemonManifest {
          socket: String::new(),
          start: vec!["serve".to_string()],
          scope: Some(DaemonScope::Session),
        }),
        commands: BTreeMap::new(),
        help: None,
        transports: BTreeMap::new(),
        provides: Vec::new(),
        services: Vec::new(),
        requires: Value::Null,
        dependencies: BTreeMap::new(),
      }),
    };

    let local = tokio::task::LocalSet::new();
    local
      .run_until(async {
        let serve_socket = socket.clone();
        tokio::task::spawn_local(async move {
          let scripts = Scripts::new(()).add_command(echo);
          let _ = serve_scripts(scripts, &serve_socket).await;
        });
        for _ in 0..50 {
          if socket.exists() {
            break;
          }
          tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        // Live socket → the client connects + dispatches, no spawn.
        let spawned = std::rc::Rc::new(Cell::new(false));
        let lease = TestLease {
          dir: dir.clone(),
          spawned: spawned.clone(),
        };
        let out = app
          .call_daemon_args(
            "echo",
            &["--text".to_string(), "hi".to_string()],
            Some(&lease),
          )
          .await
          .expect("session-scoped call reaches the live derived socket");
        assert_eq!(out, serde_json::json!({ "echoed": "hi" }));
        assert!(
          !spawned.get(),
          "a live socket must not trigger a lease spawn"
        );

        // No lease (bare CLI) → the clear session-required error.
        let err = app
          .call_daemon_args("echo", &[], None)
          .await
          .expect_err("session-scoped with no session errors");
        assert!(
          err.to_string().contains("session"),
          "error names the missing session: {err}"
        );

        // A future scope is preserved by manifest parsing but cannot silently
        // fall through to the detached path in this older router.
        let unsupported = TshApp {
          name: "future-svc".to_string(),
          dir: dir.clone(),
          bin: std::path::PathBuf::from("unused-bin"),
          child_env: Default::default(),
          manifest: Rc::new(AppManifest {
            schema: TSH_APP_SCHEMA.to_string(),
            name: "future-svc".to_string(),
            version: "0.0.0-test".to_string(),
            requires_tsh: None,
            entrypoint: "bin/unused-bin".to_string(),
            transport: "daemon".to_string(),
            daemon: Some(DaemonManifest {
              socket: "/must-not-be-used.sock".to_string(),
              start: vec![],
              scope: Some(DaemonScope::Other("workspace".to_string())),
            }),
            commands: BTreeMap::new(),
            help: None,
            transports: BTreeMap::new(),
            provides: Vec::new(),
            services: Vec::new(),
            requires: Value::Null,
            dependencies: BTreeMap::new(),
          }),
        };
        let err = unsupported
          .call_daemon_args("echo", &[], None)
          .await
          .expect_err("unknown scope must not fall through to detached");
        assert!(
          err
            .to_string()
            .contains("unsupported daemon scope `workspace`"),
          "error preserves the unknown scope: {err}"
        );
      })
      .await;
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Proves the oneshot transport end to end, offline: resolve the whoop
  /// bundle from `$TSH_APP_PATH`, read its bundled spec (no exec), then call
  /// the no-auth `help` command — spawning exactly one child — and parse the
  /// command-tree JSON it returns. Skips (does not fail) when the bundle isn't
  /// on the path, so the suite stays green without the pilot bundle present.
  #[test]
  fn oneshot_help_roundtrip() {
    // The test is the "application" boundary: it locates the bundle dir via
    // tento-env's sanctioned test/tooling accessor and injects it into the
    // (env-free) library. Skips — does not fail — when TSH_APP_PATH is unset.
    let Some(path) = tento_env::test_env("TSH_APP_PATH") else {
      eprintln!("skipping oneshot_help_roundtrip: TSH_APP_PATH not set");
      return;
    };
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    let app = match resolve("tento-whoop", &dirs) {
      Ok(a) => a,
      Err(e) => {
        eprintln!("skipping oneshot_help_roundtrip: {e}");
        return;
      }
    };
    // Bundled spec read without executing the binary. The manifest carries NO
    // namespace — that's the import site's `:as` choice — only transport +
    // commands.
    assert_eq!(app.manifest.transport, "oneshot");
    assert!(app.manifest.commands.contains_key("user-profile"));

    // Transport: spawn `tento-whoop help --json`, parse the JSON it prints.
    let out = app
      .call_oneshot("help", &Value::Null)
      .expect("help oneshot should succeed (no auth needed)");
    assert!(
      out.get("user-profile").is_some(),
      "expected the command tree to contain user-profile, got: {out}"
    );
  }

  /// The emitter's `tsh.app/v1` (`tento_lisp_cmd::AppSelfDoc`) and this loader's
  /// `AppManifest` are ONE wire shape — no translation layer: a manifest the
  /// emitter produces deserializes into the loader with `transport` + flat
  /// command-name keys + each entry's `description` intact. Locks the two against
  /// drift.
  #[test]
  fn app_self_doc_round_trips_into_the_loader_manifest() {
    use tento_lisp_cmd::{CommandDoc, CommandEntry};
    let mut app = packaged_self_doc("oneshot");
    app.commands.insert(
      "user-profile".to_string(),
      CommandEntry::Doc(CommandDoc {
        name: "user-profile".to_string(),
        description: "the whoop profile".to_string(),
        long_description: None,
        result: None,
        options: vec![],
      }),
    );
    let json = serde_json::to_string(&app).expect("emit tsh.app/v1");
    let manifest: AppManifest =
      serde_json::from_str(&json).expect("loader reads the emitted shape");
    assert_eq!(manifest.transport, "oneshot");
    assert!(manifest.commands.contains_key("user-profile"));
    assert_eq!(
      manifest.commands["user-profile"]
        .value()
        .get("description")
        .and_then(Value::as_str),
      Some("the whoop profile"),
    );
  }

  /// A root self-doc as an installed bundle carries it: the packager stamps
  /// the identity. An unset identity is omitted from the wire, and is completed
  /// only by the loading door (`unstamped_current_manifest_…`), not by serde.
  fn packaged_self_doc(transport: &str) -> tento_lisp_cmd::AppSelfDoc {
    let mut app = tento_lisp_cmd::AppSelfDoc::new(transport);
    app.name = "fixture".into();
    app.version = "1.0.0".into();
    app.entrypoint = "bin/fixture".into();
    app
  }

  /// The same no-translation-layer guarantee for PROVIDES: what the emitter
  /// declares at the builder is what the loader hands a host — kind tag,
  /// extensions, command, and return datatype, unchanged.
  #[test]
  fn app_self_doc_provides_round_trip_into_the_loader_manifest() {
    use tento_lisp_cmd::{ProvideEntry, SYNTAX_PROVIDER_V1};
    let mut app = packaged_self_doc("oneshot");
    app
      .provides
      .push(ProvideEntry::syntax_provider("go", "tokens", "syntax.tokens/v1").extensions(["go"]));
    let json = serde_json::to_string(&app).expect("emit tsh.app/v1");
    let manifest: AppManifest =
      serde_json::from_str(&json).expect("loader reads the emitted shape");
    assert_eq!(manifest.schema, TSH_APP_SCHEMA);
    assert_eq!(manifest.provides.len(), 1);
    assert_eq!(manifest.provides[0].type_tag, SYNTAX_PROVIDER_V1);
    assert_eq!(manifest.provides[0].extensions, vec!["go".to_string()]);
    assert_eq!(manifest.provides[0].command, "tokens");
    assert_eq!(manifest.provides[0].returns, "syntax.tokens/v1");
  }

  /// The same no-translation-layer guarantee for SERVICES: what the emitter
  /// declares at the builder is what the loader hands a supervisor — id,
  /// command, kind, and the optional health probe, unchanged. A manifest
  /// written before the field existed loads as a bundle that serves nothing.
  #[test]
  fn app_self_doc_services_round_trip_into_the_loader_manifest() {
    use tento_lisp_cmd::{SERVICE_KIND_HTTP, ServiceDecl};
    let mut app = packaged_self_doc("oneshot");
    app
      .services
      .push(ServiceDecl::http("board", "serve").health_path("/health"));
    let json = serde_json::to_string(&app).expect("emit tsh.app/v1");
    let manifest: AppManifest =
      serde_json::from_str(&json).expect("loader reads the emitted shape");
    assert_eq!(manifest.services.len(), 1);
    assert_eq!(manifest.services[0].id, "board");
    assert_eq!(manifest.services[0].command, "serve");
    assert_eq!(manifest.services[0].kind, SERVICE_KIND_HTTP);
    assert_eq!(manifest.services[0].health_path.as_deref(), Some("/health"));

    // Capabilities remain optional even though bundle identity is required.
    let older: AppManifest = serde_json::from_str(
      r#"{"schema":"tsh.app/v1","name":"older","version":"1.0.0","entrypoint":"bin/older","transport":"oneshot"}"#,
    )
    .expect("a manifest without services still loads");
    assert!(older.services.is_empty());
  }

  /// A provider names exactly one door: a `command` to spawn or a `lisp`
  /// export to call. Executable entries serialize exactly as before.
  #[test]
  fn provides_entry_is_a_command_or_a_lisp_export_never_both() {
    let manifest = |provides: &str| {
      format!(
        r#"{{"schema":"tsh.app/v1","name":"p","version":"1.0.0","entrypoint":"bin/p","commands":{{}},"provides":[{provides}]}}"#
      )
    };
    let lisp = TshApp::parse_manifest(
      &manifest(r#"{"type":"terminal.launch/v1","id":"tmux","lisp":"launch","returns":"terminal.launch.report/v1"}"#),
      "p",
    )
    .expect("a lisp-backed entry loads");
    assert_eq!(lisp.provides[0].lisp.as_deref(), Some("launch"));
    assert_eq!(lisp.provides[0].command, "");

    let command = TshApp::parse_manifest(
      &manifest(r#"{"type":"terminal.launch/v1","id":"kitty","command":"launch","returns":"terminal.launch.report/v1"}"#),
      "p",
    )
    .expect("an executable entry still loads");
    assert_eq!(command.provides[0].lisp, None);

    for bad in [
      r#"{"type":"terminal.launch/v1","id":"both","command":"launch","lisp":"launch","returns":"r"}"#,
      r#"{"type":"terminal.launch/v1","id":"neither","returns":"r"}"#,
      r#"{"type":"terminal.launch/v1","id":"blank","lisp":"  ","returns":"r"}"#,
    ] {
      let err = TshApp::parse_manifest(&manifest(bad), "p").expect_err(bad);
      assert!(err.to_string().contains("exactly one of `command` and `lisp`"), "{err}");
    }

    // Byte-identical JSON for an executable entry: no `lisp` key appears.
    let entry = ProvideEntry::syntax_provider("go", "tokens", "syntax.tokens/v1");
    let json = serde_json::to_string(&entry).unwrap();
    assert!(!json.contains("lisp"), "{json}");
    assert!(json.contains(r#""command":"tokens""#), "{json}");
    // And a lisp entry carries no empty `command`.
    let json = serde_json::to_string(&ProvideEntry::lisp_provider(
      "terminal.launch/v1",
      "tmux",
      "launch",
      "terminal.launch.report/v1",
    ))
    .unwrap();
    assert!(!json.contains("command"), "{json}");
    assert!(json.contains(r#""lisp":"launch""#), "{json}");
  }

  /// The schema gate at the one door every mount goes through. Missing and
  /// future schemas are both refused; the current schema loads.
  #[test]
  fn manifest_schema_gate_requires_current_version() {
    let base = std::env::temp_dir().join(format!("tn-type-gate-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let write = |name: &str, manifest: &str| {
      let dir = base.join(format!("{name}.tsh.app"));
      std::fs::create_dir_all(&dir).unwrap();
      std::fs::write(dir.join("manifest.json"), manifest).unwrap();
      dir
    };

    // Incomplete envelope: do not guess its version or identity.
    let old = write("old", r#"{"transport":"oneshot","commands":{}}"#);
    assert!(TshApp::load(&old).is_err());

    // Current type: loads, and the cached provides come through.
    let current = write(
      "current",
      r#"{"schema":"tsh.app/v1","name":"current","version":"1.0.0","entrypoint":"bin/current","transport":"oneshot","commands":{},
          "provides":[{"type":"syntax.provider/v1","id":"go","extensions":["go"],
                       "interpreters":[],"command":"tokens","returns":"syntax.tokens/v1"}]}"#,
    );
    let app = TshApp::load(&current).expect("the current type loads");
    assert_eq!(app.manifest.schema, TSH_APP_SCHEMA);
    assert_eq!(app.manifest.provides[0].id, "go");

    // A future type: hard error naming what was found AND what we read.
    let future = write(
      "future",
      r#"{"schema":"tsh.app/v2","name":"future","version":"2.0.0","entrypoint":"bin/future","commands":{}}"#,
    );
    let err = TshApp::load(&future).expect_err("a future type must be refused");
    let msg = err.to_string();
    assert!(msg.contains("tsh.app/v2"), "names the found version: {msg}");
    assert!(msg.contains(TSH_APP_SCHEMA), "names our version: {msg}");
    assert!(msg.contains("future"), "names the bundle: {msg}");

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn installed_manifest_compatibility_is_limited_to_known_complete_envelopes() {
    let tagged = serde_json::json!({"type":"tsh.app/v1", "version":"0.1.0", "transport":"oneshot", "commands":{"list":{"description":"list"}}});
    let untagged = serde_json::json!({"source_dir":"/old/build/checkout", "version":"0.1.0", "transport":"streaming", "commands":{}});
    for envelope in [tagged.clone(), untagged] {
      let manifest: AppManifest =
        serde_json::from_value(installed_manifest(envelope, "existing")).unwrap();
      assert_eq!(manifest.schema, TSH_APP_SCHEMA);
      assert_eq!(manifest.name, "existing");
      assert_eq!(manifest.entrypoint, "bin/existing");
    }
    for (key, value) in [
      ("type", serde_json::json!("tsh.app/v2")),
      ("schema", serde_json::json!("tsh.app/v2")),
      ("entrypoint", serde_json::json!("../outside")),
      ("transport", serde_json::json!("unsupported")),
      ("commands", serde_json::json!([])),
    ] {
      let mut invalid = tagged.clone();
      invalid[key] = value;
      assert_eq!(installed_manifest(invalid.clone(), "existing"), invalid);
    }
    let mut incomplete = tagged;
    incomplete.as_object_mut().unwrap().remove("version");
    assert_eq!(
      installed_manifest(incomplete.clone(), "existing"),
      incomplete
    );
  }

  /// The manifest a packager that predates bundle identity writes for a binary
  /// whose library reflects it: root `--help --json` copied verbatim plus
  /// `version`, so `schema` is current and the identity is unset — `""` from a
  /// library that wrote an unset identity, absent from one that omits it. That
  /// packager always lays the bundle out as `<name>.tsh.app/bin/<name>`, so the
  /// folder supplies the identity, as it does for the older envelopes.
  #[test]
  fn unstamped_current_manifest_takes_its_identity_from_the_folder() {
    let written = serde_json::json!({
      "schema": TSH_APP_SCHEMA, "name": "", "version": "0.1.0", "entrypoint": "",
      "transport": "streaming",
      "commands": {"cells.get": {"description": "read a cell"}},
    });
    let mut omitted = written.clone();
    for key in ["name", "entrypoint"] {
      omitted.as_object_mut().unwrap().remove(key);
    }
    for wire in [written.clone(), omitted.clone()] {
      let manifest = TshApp::parse_manifest(&wire.to_string(), "weather").expect("loads");
      assert_eq!(manifest.schema, TSH_APP_SCHEMA);
      assert_eq!(manifest.name, "weather");
      assert_eq!(manifest.entrypoint, "bin/weather");
      assert_eq!(manifest.version, "0.1.0");
      assert!(manifest.commands.contains_key("cells.get"));
    }

    // Through the loading door, where the folder name comes from the path.
    let base = std::env::temp_dir().join(format!("tn-unstamped-{}", std::process::id()));
    let dir = base.join("weather.tsh.app");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), written.to_string()).unwrap();
    let app = TshApp::load(&dir).expect("an unstamped current manifest loads");
    assert_eq!(app.name, "weather");
    let _ = std::fs::remove_dir_all(&base);

    // Only a wholly unstamped identity is completed: a half-stamped one is the
    // manifest's own claim, and the name and entrypoint gates judge it as written.
    for (key, value, refusal) in [
      ("name", "weather", "unsafe entrypoint"),
      ("entrypoint", "bin/weather", "unsafe bundle name"),
    ] {
      let mut half = written.clone();
      half[key] = serde_json::json!(value);
      assert_eq!(installed_manifest(half.clone(), "weather"), half);
      let err = TshApp::parse_manifest(&half.to_string(), "weather").expect_err(key);
      assert!(err.to_string().contains(refusal), "{key}: {err}");
    }
    // And only a complete one, under the current tag alone.
    for (key, value) in [
      ("transport", serde_json::json!("unsupported")),
      ("commands", serde_json::json!([])),
      ("schema", serde_json::json!("tsh.app/v2")),
      ("type", serde_json::json!(TSH_APP_SCHEMA)),
    ] {
      let mut invalid = omitted.clone();
      invalid[key] = value;
      assert_eq!(
        installed_manifest(invalid.clone(), "weather"),
        invalid,
        "{key}"
      );
    }
    let mut unversioned = omitted;
    unversioned.as_object_mut().unwrap().remove("version");
    assert_eq!(
      installed_manifest(unversioned.clone(), "weather"),
      unversioned
    );
  }

  #[test]
  fn manifest_names_must_be_portable_identifiers() {
    let base = std::env::temp_dir().join(format!("tn-name-gate-{}", std::process::id()));
    let write = |name: &str, manifest: &str| {
      let dir = base.join(format!("{name}.tsh.app"));
      std::fs::create_dir_all(&dir).unwrap();
      std::fs::write(dir.join("manifest.json"), manifest).unwrap();
      dir
    };

    // Exercise the loading boundary, not only the identifier predicate. The
    // folder/entrypoint remain harmless while the manifest controls the name.
    for name in [
      "",
      " ",
      ".",
      "..",
      "../escaped",
      "a/../../escaped",
      "/absolute",
      "a/b",
      "a\\b",
      "..\\escaped",
      "C:\\absolute",
      "C:relative",
      "\\\\server\\share",
      "name:stream",
      "name.",
      "name ",
      "two words",
      ".hidden",
      "-option",
      "bad\nname",
      "bad\0name",
      "caf\u{e9}",
      "CON",
      "con.txt",
      "PrN",
      "AUX",
      "NUL",
      "COM1",
      "com9.ext",
      "LPT1",
      "lpt9",
      "COM\u{b9}",
    ] {
      let dir = write(
        "unsafe",
        &serde_json::json!({
          "schema": TSH_APP_SCHEMA, "name": name, "version": "1.0.0",
          "entrypoint": "bin/safe",
        })
        .to_string(),
      );
      let err = TshApp::load(&dir).expect_err(name);
      assert!(
        matches!(err, AppError::InvalidManifest(_, _)),
        "{name:?}: {err}"
      );
      assert!(
        err.to_string().contains("unsafe bundle name"),
        "{name:?}: {err}"
      );
    }
    for name in [
      "weather",
      "tento-weather",
      "dev--tsh",
      "org.example_app",
      "App2",
      "1",
      "COM10",
      "console",
    ] {
      let dir = write(
        "safe",
        &serde_json::json!({
          "schema": TSH_APP_SCHEMA, "name": name, "version": "1.0.0",
          "entrypoint": "bin/safe",
        })
        .to_string(),
      );
      assert_eq!(TshApp::load(&dir).expect(name).name, name);
    }

    let _ = std::fs::remove_dir_all(&base);
  }

  /// The bare `:optional` flag rides alongside `:from` in either order, and is
  /// absent by default — a plain import stays a warned failure when it does not
  /// resolve, which is what makes `:optional` a deliberate declaration rather
  /// than a blanket softening of every import.
  #[test]
  fn parse_import_decls_reads_the_optional_flag() {
    let rc = r#"
      (@import "plain" :as "p")
      (@import "host-dep" :as "h" :optional)
      (@import "both" :as "b" :from "/opt/apps" :optional)
    "#;
    let decls = parse_import_decls(rc);
    assert_eq!(decls.len(), 3);
    assert!(!decls[0].optional, "absent by default");
    assert!(decls[1].optional, "bare :optional recognized");
    assert!(decls[2].optional, ":optional composes with :from");
    assert_eq!(decls[2].from.as_deref(), Some("/opt/apps"));
    assert_eq!(
      decls[2].namespace, "b",
      ":optional is not read as a literal"
    );
  }

  /// `.tshrc` link-phase scan: pull `(bundle, namespace, from?)` from each
  /// `@import`, ignore everything else, and skip malformed import lines.
  #[test]
  fn parse_import_decls_extracts_bundle_namespace_and_from() {
    let rc = r#"
      ; a comment
      (@import "tento-whoop" :as "whoop")
      acme.user login --email a@b.com
      (@import "tento-kol" :as "kol" :from "/Users/alice/ssd-mount/tsh-apps")
      (@import "tento-broken")          ; no :as → skipped
    "#;
    let decls = parse_import_decls(rc);
    assert_eq!(
      decls,
      vec![
        ImportDecl {
          bundle: "tento-whoop".into(),
          namespace: "whoop".into(),
          from: None,
          optional: false,
        },
        ImportDecl {
          bundle: "tento-kol".into(),
          namespace: "kol".into(),
          from: Some("/Users/alice/ssd-mount/tsh-apps".into()),
          optional: false,
        },
      ]
    );
  }
}

// ---------------------------------------------------------------------------
// The `@import` bundle resolver — the bundle-aware boundary between the generic
// command host (`crate::script::ImportResolver`) and the `.tsh.app` transport.
// Relocated here from the host (carve 3a) so the host carries no bundle
// reference; moves to the bundle crate in carve 3b.
// ---------------------------------------------------------------------------

/// The default `ImportResolver`: resolves `(@import "name")` against a list of
/// `.tsh.app` search dirs (with any `:from` dir searched first) and mounts the
/// bundle's commands via the oneshot transport.
pub struct TshAppResolver {
  app_dirs: Vec<PathBuf>,
  /// The engine's session-service lease (`Some` inside a live tsh session), so a
  /// `scope = session` daemon bundle command mounted via `(@import …)` leases +
  /// engine-owns its service child through the same door
  /// [`crate::remote_group::RemoteGroup`] uses. `None` for a bare CLI/REPL host:
  /// a session-scoped call then errors clearly on dispatch.
  lease: Option<Rc<dyn ServiceLease>>,
  /// The import sites' bindings this host shares with its shell's word
  /// mounts. `None`: each import binds for itself alone.
  envs: Option<crate::app_env::ImportEnvs>,
  dependency_lock: Option<PathBuf>,
}

impl TshAppResolver {
  /// A resolver with no session-service lease (bare CLI/REPL: a session-scoped
  /// bundle command errors clearly when dispatched).
  pub fn new(app_dirs: Vec<PathBuf>) -> Self {
    Self {
      app_dirs,
      lease: None,
      envs: None,
      dependency_lock: default_dependency_lock(),
    }
  }

  /// A resolver carrying the engine's session-service `lease`, so `@import`ed
  /// `scope = session` daemon commands lease their service child.
  pub fn with_lease(app_dirs: Vec<PathBuf>, lease: Option<Rc<dyn ServiceLease>>) -> Self {
    Self {
      app_dirs,
      lease,
      envs: None,
      dependency_lock: default_dependency_lock(),
    }
  }

  /// Share each import site's bindings through `envs` — the handle the
  /// host's shell mounted its word groups with — so `<ns>.env.bind` reaches
  /// `tsh <ns> <cmd>` too.
  pub fn sharing_import_envs(mut self, envs: crate::app_env::ImportEnvs) -> Self {
    self.envs = Some(envs);
    self
  }
  /// An explicit resolution record, also useful for hermetic package tests.
  pub fn with_dependency_lock(mut self, path: PathBuf) -> Self {
    self.dependency_lock = Some(path);
    self
  }
}

fn default_dependency_lock() -> Option<PathBuf> {
  tento_env::effective_var("XDG_CONFIG_HOME").map(PathBuf::from)
    .or_else(|| tento_env::effective_var("HOME").map(|home| PathBuf::from(home).join(".config")))
    .map(|config| config.join("tsh/tsh.lock"))
}

/// Build the default `.tsh.app`-bundle import resolver for a `PATH`-like search
/// with no session-service lease. The generic engine threads
/// `Rc<dyn ImportResolver>`; the public `*_with_apps` wrappers call this to turn
/// an `app_dirs` list into a resolver.
pub fn resolver_for(app_dirs: Vec<PathBuf>) -> Rc<dyn ImportResolver> {
  Rc::new(TshAppResolver::new(app_dirs))
}

/// Like [`resolver_for`] but carrying the engine's session-service `lease`, so
/// `@import`ed session/daemon bundle commands lease their service child (the
/// control-actor path inside a live tsh session).
pub fn resolver_for_with_lease(
  app_dirs: Vec<PathBuf>,
  lease: Option<Rc<dyn ServiceLease>>,
) -> Rc<dyn ImportResolver> {
  Rc::new(TshAppResolver::with_lease(app_dirs, lease))
}

/// Build a `LispHost` wired to resolve `(@import …)` against `app_dirs` — the
/// bundle-aware counterpart to the generic `LispHost::new`/`with_resolver`. No
/// session-service lease (see [`lisp_host_with_apps_and_lease`] for the leased
/// control-actor variant).
pub fn lisp_host_with_apps(app_dirs: Vec<PathBuf>) -> LispHost {
  LispHost::with_resolver(resolver_for(app_dirs))
}

/// Like [`lisp_host_with_apps`] but threading the engine's session-service
/// `lease`, so a `@import`ed `scope = session` daemon bundle command spawns +
/// leases its service child under the session (the tsh control actor's host).
pub fn lisp_host_with_apps_and_lease(
  app_dirs: Vec<PathBuf>,
  lease: Option<Rc<dyn ServiceLease>>,
) -> LispHost {
  LispHost::with_resolver(resolver_for_with_lease(app_dirs, lease))
}

/// A resolver whose imports share their bindings with the word mounts built
/// on `envs` (see [`crate::app_env::ImportEnvs`]) — the host that runs an rc
/// beside the shell that mounted the same rc's imports.
pub fn resolver_sharing_import_envs(
  app_dirs: Vec<PathBuf>,
  lease: Option<Rc<dyn ServiceLease>>,
  envs: crate::app_env::ImportEnvs,
) -> Rc<dyn ImportResolver> {
  Rc::new(TshAppResolver::with_lease(app_dirs, lease).sharing_import_envs(envs))
}

/// Mount a resolved bundle under `namespace` directly into `host` — the
/// host-side test seam that skips the env search; production drives this through
/// `(@import …)`. No session-service lease (a session/daemon command errors on
/// dispatch); the leased path arrives via the resolver.
pub fn import_app(host: &mut LispHost, app: &TshApp, namespace: &str) {
  let resolved = owned_app_to_import_mounts(
    app.clone(),
    namespace,
    host.registration_guard(),
    None,
    Default::default(),
  );
  host.mount(resolved, namespace);
}

/// Whether the bundle `name` resolves under `dirs` to a directory that mounts
/// with no side effects — no `rc/*.tshrc`, no `ui/*.tsh` — so it may be
/// mounted on first reference rather than at its `(@import …)` line. Decided
/// from the directory alone: nothing here reads the manifest.
pub fn bundle_is_script_free(name: &str, dirs: &[PathBuf]) -> bool {
  let Some((dir, stamp)) = dirs.iter().find_map(|d| {
    let candidate = d.join(format!("{name}.tsh.app"));
    let manifest = std::fs::metadata(candidate.join("manifest.json")).ok()?;
    manifest
      .is_file()
      .then(|| (candidate, (manifest.modified().ok(), manifest.len())))
  }) else {
    return false;
  };
  // Every rc import is probed twice per process (once mounting the shell,
  // once at its `(@import …)` line) and a stock rc carries ten; the verdict
  // is remembered per bundle dir under the manifest's (mtime, len), the same
  // stamp that re-reads a reinstalled bundle's manifest.
  if let Some(free) = SCRIPT_FREE.with(|cache| {
    cache
      .borrow()
      .get(&dir)
      .filter(|(seen, _)| *seen == stamp)
      .map(|(_, free)| *free)
  }) {
    return free;
  }
  let has_scripts = |sub: &str, ext: &str| {
    std::fs::read_dir(dir.join(sub)).is_ok_and(|entries| {
      entries.filter_map(Result::ok).any(|e| {
        let path = e.path();
        let is_file = match e.file_type() {
          // A symlinked script counts by what it points at.
          Ok(kind) if kind.is_symlink() => path.is_file(),
          Ok(kind) => kind.is_file(),
          Err(_) => path.is_file(),
        };
        is_file && path.extension().is_some_and(|x| x == ext)
      })
    })
  };
  let free = !has_scripts("rc", "tshrc") && !has_scripts("ui", "tsh");
  SCRIPT_FREE.with(|cache| {
    cache.borrow_mut().insert(dir, (stamp, free));
  });
  free
}

impl ImportResolver for TshAppResolver {
  fn resolve_dependencies(
    &self,
    name: &str,
    namespace: &str,
    from: Option<&str>,
    registration: Rc<RefCell<Option<String>>>,
  ) -> Result<Vec<(String, ImportMounts)>, RuntimeError> {
    let search = self.dependency_search(from);
    let app = resolve(name, &search).map_err(|e| RuntimeError::Other(format!("@import {name}: {e}")))?;
    if app.manifest.name != name {
      return Err(RuntimeError::Other(format!("@import {name}: manifest identifies {}", app.manifest.name)));
    }
    self.dependency_graph(&app, namespace, &search)?.into_iter().map(|(private, app)| {
      let bindings = self.envs.as_ref().map(|envs| envs.for_import(&private, &app.dir)).unwrap_or_default();
      let mounts = owned_app_to_import_mounts(app, &private, registration.clone(), self.lease.clone(), bindings);
      Ok((private, mounts))
    }).collect()
  }

  fn lazy_eligible(&self, name: &str, from: Option<&str>) -> bool {
    let mut search: Vec<PathBuf> = Vec::new();
    if let Some(dir) = from {
      search.push(PathBuf::from(dir));
    }
    search.extend(self.app_dirs.iter().cloned());
    bundle_is_script_free(name, &search)
  }

  fn resolve(
    &self,
    name: &str,
    namespace: &str,
    from: Option<&str>,
    registration: Rc<RefCell<Option<String>>>,
  ) -> Result<ImportMounts, RuntimeError> {
    // `:from <dir>` (if given) is searched first; configured dirs are the fallback.
    let mut search: Vec<PathBuf> = Vec::new();
    if let Some(dir) = from {
      search.push(PathBuf::from(dir));
    }
    search.extend(self.app_dirs.iter().cloned());
    let app =
      resolve(name, &search).map_err(|e| RuntimeError::Other(format!("@import {name}: {e}")))?;
    if app.manifest.name != name {
      return Err(RuntimeError::Other(format!("@import {name}: manifest identifies {}", app.manifest.name)));
    }
    // Fail closed before any of this bundle's rc/UI scripts are queued.
    self.dependency_graph(&app, namespace, &search)?;
    let child_env = self
      .envs
      .as_ref()
      .map(|envs| envs.for_import(namespace, &app.dir))
      .unwrap_or_default();
    // The namespace is the explicit `:as` value from the import site.
    Ok(owned_app_to_import_mounts(
      app,
      namespace,
      registration,
      self.lease.clone(),
      child_env,
    ))
  }
}

/// Build the mounts for a resolved bundle mounted under `namespace`. Each
/// manifest command becomes `<namespace>.<command>`, bound BOTH as:
///   * a **sync env native** (for nested/in-process Lisp calls) that resolves
///     the command's transport and dispatches — `oneshot`/`streaming` run
///     synchronously; a `daemon` command can't be awaited on the sync engine, so
///     it errors telling the caller to run it as a shell line (the top-level
///     door leases it); and
///   * an **async dispatcher** IFF the command's transport is (or can be)
///     `daemon` — registered into the host's async table so the top-level await
///     door drives + leases it (mirroring a registry subcommand group's daemon
///     transport). Oneshot/streaming bundles carry no async mounts.
///
/// No process spawns here — closures dispatch on call. `lease` is the engine's
/// session-service lease threaded into the async (daemon) dispatchers.
fn owned_app_to_import_mounts(
  mut app: TshApp,
  namespace: &str,
  registration: Rc<RefCell<Option<String>>>,
  lease: Option<Rc<dyn ServiceLease>>,
  child_env: crate::app_env::Bindings,
) -> ImportMounts {
  // Environment bindings belong to this import site even when the descriptor
  // was supplied by a caller that retained a bindings handle: fresh, or the
  // site's handle from the host's [`crate::app_env::ImportEnvs`].
  app.child_env = child_env;
  // ONE shared descriptor. Each mounted command used to capture its own deep
  // copy of the whole `TshApp` — manifest BTreeMap included — three times over
  // (sync closure, async dispatcher, env.bind), making startup allocation
  // quadratic in a bundle's command count. Move the resolver's descriptor
  // into that shared handle; no metadata copy is needed at the mount boundary.
  let app = Rc::new(app);
  let namespace = namespace.to_string();
  let mut mounts: Vec<(String, LispValue<Sym>)> = Vec::new();
  let mut async_mounts: Vec<(String, AsyncDispatch)> = Vec::new();
  if !app.rc_scripts().is_empty() || !app.manifest.dependencies.is_empty() || !app.manifest.requires.is_null() {
    mounts.push((format!("{namespace}.__requires"), value_from_json(
      &bundle_dependencies::receiver_requirements(&app, &namespace))));
  }
  for command in app.manifest.commands.keys() {
    let symbol = format!("{namespace}.{command}");

    // Sync env native — nested/in-process Lisp calls resolve the symbol here.
    {
      let app = Rc::clone(&app);
      let command = command.clone();
      let namespace = namespace.clone();
      let registration = registration.clone();
      let closure: NativeClosure<Sym> = std::rc::Rc::new(move |_env, args| {
        // F11 chokepoint: a ui registration script defines, it never spawns.
        if let Some(ns) = registration.borrow().as_deref() {
          return Err(RuntimeError::Other(format!(
            "{command}: cannot run commands during `{ns}`'s ui registration — \
             registration is define-only; move the call into a mode/key handler"
          )));
        }
        // Lower the evaluated Lisp args to argv (dropping the head), resolve the
        // transport, and dispatch. oneshot/streaming are synchronous; a daemon
        // command's future can't be driven here (the sync engine), so it errors
        // pointing at the shell-line door (which awaits + leases it).
        let argv = lisp_args_to_argv(&command, args);
        let extra: Vec<String> = argv.into_iter().skip(1).collect();
        if extra.iter().take_while(|word| word.as_str() != "--").any(|word| word == "--help") {
          let mut doc = app.manifest.commands[&command].value().clone();
          if !doc.is_object() { doc = serde_json::json!({}); }
          let fields = doc.as_object_mut().unwrap();
          fields.insert("type".into(), Value::String("command.doc/v1".into()));
          fields.entry("name").or_insert_with(|| Value::String(command.clone()));
          fields.entry("description").or_insert_with(|| Value::String(String::new()));
          fields.entry("options").or_insert_with(|| Value::Array(Vec::new()));
          return Ok(value_from_json(&doc));
        }
        match app.resolve_transport(&command, &extra).as_str() {
          "daemon" => Err(RuntimeError::Other(format!(
            "{command}: a session/daemon command — run it as a shell line, not inside Lisp"
          ))),
          "streaming" => app
            .call_streaming_args(&command, &extra)
            .map(|v| value_from_json(&v))
            .map_err(|e| command_failure(&namespace, &command, e)),
          "interactive" => app
            .call_interactive_args(&command, &extra)
            .map(|v| value_from_json(&v))
            .map_err(|e| command_failure(&namespace, &command, e)),
          "oneshot" => app
            .call_oneshot_args(&command, &extra)
            .map(|v| value_from_json(&v))
            .map_err(|e| command_failure(&namespace, &command, e)),
          other => Err(RuntimeError::Other(format!(
            "{command}: {}",
            unknown_transport(&app, &command, other)
          ))),
        }
      });
      mounts.push((
        symbol.clone(),
        LispValue::Function(Function::NativeClosure(closure)),
      ));
    }

    // Async dispatcher — only for a command whose transport is (or can be)
    // `daemon`, the case that MUST ride the top-level await door to lease.
    if command_can_daemon(&app.manifest, command) {
      let app = Rc::clone(&app);
      let command = command.clone();
      let lease = lease.clone();
      let dispatch: AsyncDispatch = std::rc::Rc::new(move |argv: Vec<String>| {
        // argv[0] is the canonical dotted mount symbol; the bundle command is
        // `command` and everything after argv[0] is its verbatim tail.
        let extra: Vec<String> = argv.into_iter().skip(1).collect();
        let fut = Rc::clone(&app).dispatch_shared_argv(command.clone(), extra, lease.clone());
        let boxed: tento_lisp_cmd::script::AsyncCommandFut = Box::pin(async move {
          fut.await.map_err(|e| match e.status() {
            Some(status) => tento_lisp_cmd::Error::ProcessStart {
              status,
              detail: e.to_string(),
            },
            None => tento_lisp_cmd::Error::Other(anyhow::anyhow!("{e}")),
          })
        });
        Ok(boxed)
      });
      async_mounts.push((symbol, dispatch));
    }
  }
  // Keep descriptor decoding off the ordinary import path. A module's identity
  // and member names are available without copying opaque help metadata.
  let module_app = app.clone();
  let module_namespace = namespace.clone();
  let module_mounts = mounts.clone();
  let module = tento_lisp::types::Module::lazy(
    namespace.clone(),
    app.manifest.commands.keys().cloned().collect(),
    Rc::new(move || tento_lisp_cmd::structural::module_methods_json(
      &module_namespace,
      module_app.manifest.commands.iter().map(|(name, doc)| (name.clone(), doc.raw())),
      &module_mounts,
    )),
  );
  mounts.push((namespace.clone(), LispValue::Module(Rc::new(module.with_bundle_name(app.manifest.name.clone())))));
  // Host rc binds a vault address to this receiver, without placing a key in
  // the session EnvMap. Plugin registration remains define-only, and only the
  // host's rc policy may bind a secret (see `app_env`): the caller's authority
  // is the host probe's answer at the moment of the call.
  if !app.manifest.commands.contains_key("env.bind") {
    let bound_app = Rc::clone(&app);
    let registration = registration.clone();
    let closure: NativeClosure<Sym> = Rc::new(move |_env, args| {
      if registration.borrow().is_some() {
        return Err(RuntimeError::Other(
          "env.bind: plugin registration cannot bind host credentials".into(),
        ));
      }
      if bound_app.manifest.transport == "daemon"
        || bound_app
          .manifest
          .transports
          .values()
          .any(|t| t == "daemon")
      {
        return Err(RuntimeError::Other(
          "env.bind: daemon child environment bindings are not supported".into(),
        ));
      }
      if args.len() != 1 {
        return Err(RuntimeError::Other(
          "env.bind expects one environment map".into(),
        ));
      }
      bound_app
        .child_env
        .set(
          args.into_iter().next().unwrap(),
          crate::app_env::caller_authority(),
        )
        .map_err(|e| RuntimeError::Other(e.to_string()))?;
      Ok(value_from_json(&Value::Null))
    });
    mounts.push((
      format!("{namespace}.env.bind"),
      LispValue::Function(Function::NativeClosure(closure)),
    ));
  }
  ImportMounts {
    mounts,
    async_mounts,
    ui_scripts: app.ui_scripts(),
    rc_scripts: app.rc_scripts(),
  }
}

/// Whether `command` can dispatch over the `daemon` transport — the bundle
/// default is `daemon`, or a per-command `transports` override for this command
/// (its first invocation-path token) is `daemon`. Such a command needs an async
/// mount so the top-level await door can lease it; a purely oneshot/streaming
/// command needs only the sync native.
fn command_can_daemon(manifest: &AppManifest, command: &str) -> bool {
  if manifest.transport == "daemon" {
    return true;
  }
  manifest.transports.iter().any(|(path, transport)| {
    transport == "daemon" && path.split_whitespace().next() == Some(command)
  })
}

#[cfg(test)]
mod bundle_memo_tests {
  /// A bundle's manifest is parsed once per process and a rewrite is seen:
  /// the second load of an unchanged bundle shares the first's manifest, a
  /// manifest rewritten with a new length is re-read.
  #[test]
  fn a_bundle_is_parsed_once_until_its_manifest_changes() {
    let dir = std::env::temp_dir().join(format!("memo-bundle-{}.tsh.app", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = |desc: &str| format!(
      r#"{{"schema":"{}","name":"memo-bundle","version":"0.0.1","entrypoint":"bin/x","commands":{{"ping":{{"type":"command.doc/v1","name":"ping","description":"{desc}"}}}}}}"#,
      super::TSH_APP_SCHEMA
    );
    std::fs::write(dir.join("manifest.json"), manifest("one")).unwrap();
    let first = super::TshApp::load(&dir).unwrap();
    let again = super::TshApp::load(&dir).unwrap();
    assert!(std::rc::Rc::ptr_eq(&first.manifest, &again.manifest), "the second load shares the parse");
    assert_eq!(first.manifest.commands["ping"]["description"], "one");
    std::fs::write(dir.join("manifest.json"), manifest("two — longer")).unwrap();
    let changed = super::TshApp::load(&dir).unwrap();
    assert_eq!(changed.manifest.commands["ping"]["description"], "two — longer", "a rewritten manifest is re-read");
    let _ = std::fs::remove_dir_all(&dir);
  }
}

#[cfg(test)]
mod lazy_eligibility_tests {
  use std::path::PathBuf;

  fn bundle(tag: &str, with_rc: bool, with_ui: bool) -> (PathBuf, String) {
    let root = std::env::temp_dir().join(format!("lazy-elig-{}-{tag}", std::process::id()));
    let name = format!("app-{tag}");
    let dir = root.join(format!("{name}.tsh.app"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), "{}").unwrap();
    if with_rc {
      std::fs::create_dir_all(dir.join("rc")).unwrap();
      std::fs::write(dir.join("rc/boot.tshrc"), "(+ 1 1)").unwrap();
    }
    if with_ui {
      std::fs::create_dir_all(dir.join("ui")).unwrap();
      std::fs::write(dir.join("ui/keys.tsh"), "(+ 1 1)").unwrap();
    }
    (root, name)
  }

  /// Only a bundle with nothing to run at import time may mount lazily; a
  /// bundle that is not on the search path is not eligible either (its
  /// eager import is what reports the error).
  #[test]
  fn only_script_free_bundles_on_the_path_are_lazy() {
    let (plain_root, plain) = bundle("plain", false, false);
    let (rc_root, with_rc) = bundle("rc", true, false);
    let (ui_root, with_ui) = bundle("ui", false, true);
    assert!(super::bundle_is_script_free(&plain, &[plain_root.clone()]));
    assert!(!super::bundle_is_script_free(&with_rc, &[rc_root.clone()]));
    assert!(!super::bundle_is_script_free(&with_ui, &[ui_root.clone()]));
    assert!(!super::bundle_is_script_free(&plain, &[rc_root.clone()]), "not on this path");
    for r in [plain_root, rc_root, ui_root] {
      let _ = std::fs::remove_dir_all(r);
    }
  }
}

/// An interactive command must supply its structured result; no transcript
/// fallback can turn missing/truncated JSON into an apparent successful null.
fn parse_interactive_result(label: &str, stdout: &str) -> Result<Value, AppError> {
  serde_json::from_str(stdout.trim()).map_err(|e| AppError::Parse(label.to_owned(), e.to_string()))
}
