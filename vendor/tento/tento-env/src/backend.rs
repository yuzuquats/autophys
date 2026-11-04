//! Pluggable resolution backend for typed env loading.
//!
//! By default `tento-env` reads every key from the process environment. A
//! [`Backend`] lets a caller resolve a whole config from a different source
//! instead — passed explicitly via [`crate::FromEnv::from_backend`]. A load
//! resolves **entirely** through one backend; there is no layering or
//! env/store fallback.
//!
//! The disk-backed implementation lives in the separate `tento-env-file-backend`
//! crate so this core crate stays dependency-light.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::collections::btree_map::Entry;
use std::sync::{Arc, OnceLock, RwLock};

use crate::error::EnvError;

/// A source of raw env values keyed by name. Keys are the `&'static str`
/// `FromEnvVar::KEY` consts.
pub trait Backend {
  /// Return the raw string for `key`, or `None` if this backend has no value
  /// for it. Errors are reserved for unrecoverable conditions (e.g. a value
  /// that isn't valid UTF-8).
  fn lookup(&self, key: &'static str) -> Result<Option<String>, EnvError>;
}

/// The process environment — the default when no backend is in scope.
pub struct EnvBackend;

impl Backend for EnvBackend {
  fn lookup(&self, key: &'static str) -> Result<Option<String>, EnvError> {
    env_lookup(key)
  }
}

/// A [`Backend`] that resolves each key through an ordered list of inner
/// backends, returning the first that has a value. The explicit opt-in to
/// *layering* (the default single-backend path has none): a caller puts one or
/// more secret-store buckets ahead of the process env so secrets resolve from
/// the store while structural keys fall through to env/cargo-`[env]`.
///
/// Example: `CompositeBackend::new(vec![Box::new(store_server-app), Box::new(EnvBackend)])`.
///
/// Inner backends are `Send + Sync` so a composite can be installed as the
/// process-global default ([`set_global_backend`]).
pub struct CompositeBackend {
  backends: Vec<Box<dyn Backend + Send + Sync>>,
}

impl CompositeBackend {
  pub fn new(backends: Vec<Box<dyn Backend + Send + Sync>>) -> Self {
    Self { backends }
  }
}

impl Backend for CompositeBackend {
  fn lookup(&self, key: &'static str) -> Result<Option<String>, EnvError> {
    for backend in &self.backends {
      if let Some(value) = backend.lookup(key)? {
        return Ok(Some(value));
      }
    }
    Ok(None)
  }
}

/// The **owned session environment** — env as declared state. Starts EMPTY:
/// no process-env capture, no `.env` file. Mechanism seeds exactly one entry
/// ([`EnvMap::seed_home`]); everything else enters via rc declarations
/// (`env.set` / `env.default` / `env.inherit`) evaluated at load. Installed
/// process-globally via [`set_global_env_map`], it becomes BOTH the typed
/// resolution backend (every `env_kv!`/[`resolve_key`] read is a map read with
/// no process-env fallback) and the snapshot source for **hermetic child
/// spawns** (`Command::env_clear().envs(map.snapshot())`). Cheap to clone —
/// one `Arc` backs every handle.
///
/// # Key case
///
/// Variable names follow the platform's own rule, so the declared map and the
/// child env block agree with what the OS would do:
///
/// * **unix** — names are bytes. `Path` and `PATH` are two variables.
/// * **windows** — names are case-INSENSITIVE (`Path`, `PATH`, `path` are one
///   variable; so are `TEMP`/`Temp`). Every entry is keyed by its
///   ASCII-uppercase fold ([`fold_key`], the Win32 rule), so `set`, `get`,
///   `set_default`, `inherit` and the [`Backend`] impl all agree, a second
///   declaration that differs only in case OVERWRITES the first rather than
///   adding a twin, and [`snapshot`](EnvMap::snapshot) can never hand
///   `CreateProcess` two names differing only by case (which resolves
///   inconsistently). The FIRST-seen spelling is what's stored and exported —
///   `(env.inherit "Path")` then `(env.set "PATH" …)` yields one entry
///   displayed and exported as `Path`.
#[derive(Clone, Default)]
pub struct EnvMap(
  Arc<RwLock<BTreeMap<String, EnvEntry>>>,
  Arc<RwLock<BTreeMap<std::ffi::OsString, std::ffi::OsString>>>,
);

/// One declared variable: its value plus the spelling it was first declared
/// with. The map is keyed by [`fold_key`] of the name (identity on unix), so
/// `name` is the only place the original spelling survives — it is what
/// [`EnvMap::snapshot`] exports to a child.
#[derive(Clone, Debug)]
struct EnvEntry {
  name: String,
  value: String,
}

/// The map key for an env var name: the platform's identity rule for env
/// names, and the ONE place that rule is spelled out.
///
/// Windows compares env names case-insensitively — `Path` and `PATH` name the
/// same variable — so the key is the ASCII uppercase fold, borrowed unless a
/// fold is actually needed. ASCII is the whole practical alphabet for env
/// names (and is what `std::process::Command`'s own windows key folds); a
/// non-ASCII name that Windows' uppercase table would collapse (`über` vs
/// `Über`) stays two entries here — accepted, since no such variable exists
/// in the spawn protocol or in any rc we ship. On unix a name is bytes:
/// identity, always borrowed, so nothing about unix behavior changes.
#[cfg(windows)]
fn fold_key(key: &str) -> Cow<'_, str> {
  if key.bytes().any(|b| b.is_ascii_lowercase()) {
    Cow::Owned(key.to_ascii_uppercase())
  } else {
    Cow::Borrowed(key)
  }
}

/// See the windows arm: on unix an env name is compared byte-for-byte, so the
/// fold is the identity.
#[cfg(not(windows))]
fn fold_key(key: &str) -> Cow<'_, str> {
  Cow::Borrowed(key)
}

/// The pre-EnvMap name for the rc-defaults layer. The overlay semantics
/// (process env wins, overlay fills gaps) are gone — this is now the whole
/// declared environment.
#[deprecated(note = "renamed to EnvMap — env is the declared session state now")]
pub type EnvOverlay = EnvMap;

impl EnvMap {
  /// An EMPTY map. A variable is in the map because a declaration put it
  /// there — nothing is captured from the process environment.
  pub fn new() -> Self {
    Self::default()
  }

  /// Capture the caller's complete environment for a program entrypoint.
  #[allow(clippy::disallowed_methods)]
  pub fn from_process() -> Self {
    let map = Self::new();
    for (key, value) in std::env::vars_os() {
      if let (Some(name), Some(text)) = (key.to_str(), value.to_str()) {
        map.set(name, text);
      } else {
        map
          .1
          .write()
          .unwrap_or_else(|e| e.into_inner())
          .insert(key, value);
      }
    }
    map
  }

  pub fn remove(&self, key: &str) {
    self
      .0
      .write()
      .unwrap_or_else(|e| e.into_inner())
      .remove(fold_key(key).as_ref());
    self
      .1
      .write()
      .unwrap_or_else(|e| e.into_inner())
      .remove(std::ffi::OsStr::new(key));
  }

  /// Replace a boot seed before startup runs, preserving installed handles.
  pub fn replace(&self, other: &Self) {
    let entries = other.0.read().unwrap_or_else(|e| e.into_inner()).clone();
    let raw = other.1.read().unwrap_or_else(|e| e.into_inner()).clone();
    *self.0.write().unwrap_or_else(|e| e.into_inner()) = entries;
    *self.1.write().unwrap_or_else(|e| e.into_inner()) = raw;
  }

  /// An independent copy for a scoped command; clone() shares session state.
  pub fn fork(&self) -> Self {
    let map = Self::new();
    map.replace(self);
    map
  }

  /// Child environment bytes, including non-UTF-8 Unix values and names.
  pub fn snapshot_os(&self) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut values: Vec<_> = self
      .snapshot()
      .into_iter()
      .map(|(key, value)| (key.into(), value.into()))
      .collect();
    values.extend(
      self
        .1
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(key, value)| (key.clone(), value.clone())),
    );
    values
  }

  /// Set `key` unconditionally (rc `env.set`, spawn-protocol vars). On
  /// windows a name that folds onto an existing entry replaces that entry's
  /// VALUE and keeps its first-seen spelling (see the type's "Key case").
  pub fn set(&self, key: impl Into<String>, value: impl Into<String>) {
    let name = key.into();
    let value = value.into();
    self.1.write().unwrap_or_else(|e| e.into_inner()).remove(std::ffi::OsStr::new(&name));
    let mut guard = self.0.write().unwrap_or_else(|e| e.into_inner());
    match guard.entry(fold_key(&name).into_owned()) {
      Entry::Occupied(mut slot) => slot.get_mut().value = value,
      Entry::Vacant(slot) => {
        slot.insert(EnvEntry { name, value });
      }
    }
  }

  /// Set `key` **if unset in the map** (rc `env.default` — first writer wins).
  pub fn set_default(&self, key: impl Into<String>, value: impl Into<String>) {
    let name = key.into();
    if self
      .1
      .read()
      .unwrap_or_else(|e| e.into_inner())
      .contains_key(std::ffi::OsStr::new(&name))
    {
      return;
    }
    self
      .0
      .write()
      .unwrap_or_else(|e| e.into_inner())
      .entry(fold_key(&name).into_owned())
      .or_insert_with(|| EnvEntry {
        name,
        value: value.into(),
      });
  }

  /// A single map value by (dynamically-named) key — the string-keyed
  /// sibling of the [`Backend`] impl's `&'static str` lookup.
  pub fn get(&self, key: &str) -> Option<String> {
    self
      .0
      .read()
      .unwrap_or_else(|e| e.into_inner())
      .get(fold_key(key).as_ref())
      .map(|entry| entry.value.clone())
  }

  /// All map pairs, for materializing into a child process's environment
  /// (`env_clear().envs(map.snapshot())` — the child's environment IS the
  /// declared session env). Each name is its first-seen spelling, and no two
  /// names can differ only by case on windows — one entry per variable, as
  /// the OS sees variables.
  pub fn snapshot(&self) -> Vec<(String, String)> {
    self
      .0
      .read()
      .unwrap_or_else(|e| e.into_inner())
      .values()
      .map(|entry| (entry.name.clone(), entry.value.clone()))
      .collect()
  }

  /// `(env.inherit "K" …)` — copy the NAMED keys from the REAL process
  /// environment into the map, when present there. This is the single
  /// sanctioned process-env read in the system: the *declaration* lives in an
  /// rc file, only the per-key *value* crosses from the launch env, at
  /// rc-load time. Nothing crosses undeclared. Absent keys are skipped
  /// (never set to empty). Last-wins like `set` — a later `env.set` can
  /// still override an inherited value. Windows resolves the named key
  /// case-insensitively on both sides: `std::env::var("PATH")` finds a
  /// process `Path`, and the value lands on the single folded map entry.
  #[allow(clippy::disallowed_methods)]
  pub fn inherit(&self, keys: &[&str]) {
    for key in keys {
      if let Ok(value) = std::env::var(key) {
        self.set(*key, value);
      }
    }
  }

  /// Seed `HOME` — the one documented mechanism entry (user identity, not
  /// configuration; locating `~/.tshrc` precedes any rc).
  ///
  /// The launch env's `HOME` is honoured when it is an absolute directory
  /// **owned by the calling uid** — that is the user's own home by any
  /// reasonable test, and one `stat` costs microseconds. Otherwise the answer
  /// comes from the user database (`getpwuid_r`), whose first call in a fresh
  /// process is a directory-services round trip (~0.5 ms on macOS, measured)
  /// that every tsh invocation used to pay; an env `HOME` that fails the
  /// ownership test (unset, relative, missing, another user's directory) is
  /// ignored exactly as before. The userdb-miss fallback to `$HOME` remains
  /// the documented secondary inside the same single-allow site (e.g. an
  /// NSS-less container).
  pub fn seed_home(&self) {
    if let Some(home) = owned_home_from_env().or_else(home_from_userdb) {
      self.set("HOME", home);
    }
  }
}

/// The launch env's `HOME` when it names an absolute directory owned by the
/// calling uid — see [`EnvMap::seed_home`]. Anything else is `None`.
#[cfg(unix)]
#[allow(clippy::disallowed_methods)]
fn owned_home_from_env() -> Option<String> {
  use std::os::unix::fs::MetadataExt;
  let home = std::env::var_os("HOME")?;
  let path = std::path::Path::new(&home);
  if !path.is_absolute() {
    return None;
  }
  let meta = std::fs::metadata(path).ok()?;
  let uid = unsafe { libc::getuid() };
  (meta.is_dir() && meta.uid() == uid).then(|| home.to_string_lossy().into_owned())
}

#[cfg(not(unix))]
fn owned_home_from_env() -> Option<String> {
  None
}

/// `HOME` from `getpwuid_r` for the current uid; process-env `HOME` as the
/// documented secondary when the userdb misses. See [`EnvMap::seed_home`].
#[cfg(unix)]
#[allow(clippy::disallowed_methods)]
fn home_from_userdb() -> Option<String> {
  unsafe {
    let uid = libc::getuid();
    let mut pw: libc::passwd = std::mem::zeroed();
    let mut buf = vec![0u8; 4096];
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    if libc::getpwuid_r(uid, &mut pw, buf.as_mut_ptr().cast(), buf.len(), &mut out) == 0
      && !out.is_null()
      && !pw.pw_dir.is_null()
    {
      let dir = std::ffi::CStr::from_ptr(pw.pw_dir)
        .to_string_lossy()
        .into_owned();
      if !dir.is_empty() {
        return Some(dir);
      }
    }
  }
  // Secondary (userdb miss only): the launch env's HOME. Still inside the
  // one sanctioned process-env read site.
  std::env::var_os("HOME").map(|v| v.to_string_lossy().into_owned())
}

/// Windows: the profile service's `USERPROFILE` plays the userdb's role — OS
/// identity, not user configuration — with `HOME` as the secondary for
/// environments (MSYS, CI) that set it deliberately.
#[cfg(not(unix))]
#[allow(clippy::disallowed_methods)]
fn home_from_userdb() -> Option<String> {
  std::env::var_os("USERPROFILE")
    .or_else(|| std::env::var_os("HOME"))
    .map(|v| v.to_string_lossy().into_owned())
}

impl Backend for EnvMap {
  fn lookup(&self, key: &'static str) -> Result<Option<String>, EnvError> {
    Ok(
      self
        .0
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(fold_key(key).as_ref())
        .map(|entry| entry.value.clone()),
    )
  }
}

fn env_lookup(key: &'static str) -> Result<Option<String>, EnvError> {
  match std::env::var(key) {
    Ok(s) => Ok(Some(s)),
    Err(std::env::VarError::NotPresent) => Ok(None),
    Err(std::env::VarError::NotUnicode(_)) => {
      Err(EnvError::parse(key, "<invalid unicode>", "String"))
    }
  }
}

thread_local! {
  static ACTIVE: RefCell<Option<Box<dyn Backend>>> = const { RefCell::new(None) };
}

/// Process-global default backend, consulted by [`resolve_key`] when no
/// thread-local [`with_backend`] scope is active. Set once at startup via
/// [`set_global_backend`] (e.g. in `main`, replacing a `.env` loader) to make a
/// secret store the program-wide resolution source across all threads —
/// `with_backend` alone is thread-local and only covers the scope it wraps.
static GLOBAL: OnceLock<Box<dyn Backend + Send + Sync>> = OnceLock::new();

/// Install the process-global default backend (see [`GLOBAL`]). Idempotent:
/// the first call wins; later calls are ignored. Returns `true` if this call
/// installed it.
pub fn set_global_backend<B: Backend + Send + Sync + 'static>(backend: B) -> bool {
  GLOBAL.set(Box::new(backend)).is_ok()
}

/// Process-global handle to the installed [`EnvMap`] — the declared session
/// environment. Set-once; first call wins.
static MAP: OnceLock<EnvMap> = OnceLock::new();

/// Install `map` as the process-global session environment: it becomes the
/// out-of-band handle ([`global_env_map`]) AND the process-global resolution
/// [`Backend`] — so every typed `env_kv!` / [`resolve_key`] read resolves from
/// the map with **no process-env fallback**. Hosts that never install a map
/// keep the default process-env resolution. Idempotent set-once; returns
/// `true` if this call installed it.
pub fn set_global_env_map(map: EnvMap) -> bool {
  let installed = MAP.set(map.clone()).is_ok();
  if installed {
    set_global_backend(map);
  }
  installed
}

/// The process-global [`EnvMap`], if installed — read/write declared state and
/// snapshot it for hermetic child spawns.
pub fn global_env_map() -> Option<EnvMap> {
  SCOPED_MAP
    .with(|map| map.borrow().clone())
    .or_else(|| MAP.get().cloned())
}

thread_local! {
  static SCOPED_MAP: std::cell::RefCell<Option<EnvMap>> = const { std::cell::RefCell::new(None) };
}

/// A command-local environment, restored even on panic. Does not mutate the
/// process environment or the session's map.
pub fn with_env_map<R>(map: EnvMap, run: impl FnOnce() -> R) -> R {
  struct Restore(Option<EnvMap>);
  impl Drop for Restore {
    fn drop(&mut self) {
      SCOPED_MAP.with(|map| *map.borrow_mut() = self.0.take());
    }
  }
  let _restore = Restore(SCOPED_MAP.with(|slot| slot.replace(Some(map))));
  run()
}

/// Install only for each poll: awaiting a child cannot expose its environment
/// to another task on the same executor thread.
pub async fn with_env_map_async<F: std::future::Future>(map: EnvMap, future: F) -> F::Output {
  let mut future = std::pin::pin!(future);
  std::future::poll_fn(|context| with_env_map(map.clone(), || future.as_mut().poll(context))).await
}

/// Pre-EnvMap name: register the global map WITHOUT making it the resolution
/// backend (the old composite carried that). Prefer [`set_global_env_map`].
#[deprecated(note = "use set_global_env_map — it also installs the map as the resolution backend")]
pub fn set_global_overlay(map: EnvMap) -> bool {
  MAP.set(map).is_ok()
}

/// Pre-EnvMap name for [`global_env_map`].
#[deprecated(note = "renamed to global_env_map")]
pub fn global_overlay() -> Option<EnvMap> {
  global_env_map()
}

/// The effective value of a **dynamically-named** env var: a MAP-ONLY read of
/// the installed [`EnvMap`] — never the process environment. For surfaces
/// where the name is data (a lisp `(env NAME)` form) and the typed `env_kv!`
/// resolution can't apply. Without an installed map there is no declared
/// state, so this is `None` — a variable exists because a declaration put it
/// in the map, not because the launching shell exported it.
pub fn effective_var(name: &str) -> Option<String> {
  global_env_map().and_then(|m| m.get(name))
}

/// The env pairs for a spawned child: `Some(snapshot)` when the session
/// [`EnvMap`] is installed — the caller does `cmd.env_clear()` then
/// `cmd.envs(...)`, so the child's environment IS the declared session env.
/// `None` when no map is installed (a host that never adopted the declared
/// model): the caller leaves the child inheriting, preserving legacy hosts.
pub fn hermetic_child_env() -> Option<Vec<(String, String)>> {
  global_env_map().map(|m| m.snapshot())
}

pub fn hermetic_child_env_os() -> Option<Vec<(std::ffi::OsString, std::ffi::OsString)>> {
  global_env_map().map(|m| m.snapshot_os())
}

pub fn hermetic_child_env_os_with(
  overlay: &[(String, String)],
) -> Option<Vec<(std::ffi::OsString, std::ffi::OsString)>> {
  let base = global_env_map();
  if base.is_none() && overlay.is_empty() {
    return None;
  }
  let map = base.map(|map| map.fork()).unwrap_or_default();
  for (key, value) in overlay {
    map.set(key.clone(), value.clone());
  }
  Some(map.snapshot_os())
}

/// [`hermetic_child_env`] with a per-child `overlay` applied LAST (overlay
/// wins over the declared map) — the seam a lane's `:env` binding spawns
/// through: the session map stays untouched, one child sees its own
/// additions. `None` only when there is neither an installed map nor an
/// overlay entry; a non-empty overlay on a map-less host yields exactly the
/// overlay (the child is then hermetic to it — the declared model, not
/// inheritance, is what a lane's `:env` opted into).
pub fn hermetic_child_env_with(overlay: &[(String, String)]) -> Option<Vec<(String, String)>> {
  merge_overlay(hermetic_child_env(), overlay)
}

/// The pure half of [`hermetic_child_env_with`]: `overlay` applied last over
/// an optional base snapshot, preserving base order (an overridden key keeps
/// its position; new keys append in overlay order).
fn merge_overlay(
  base: Option<Vec<(String, String)>>,
  overlay: &[(String, String)],
) -> Option<Vec<(String, String)>> {
  if overlay.is_empty() {
    return base;
  }
  let mut out = base.unwrap_or_default();
  for (key, value) in overlay {
    match out.iter_mut().find(|(existing, _)| existing == key) {
      Some(slot) => slot.1 = value.clone(),
      None => out.push((key.clone(), value.clone())),
    }
  }
  Some(out)
}

/// Deprecated shim: the whole installed map (children get the full declared
/// environment; the old "filtered to keys absent from the process env"
/// overlay semantics are gone). Empty when no map is installed.
#[deprecated(note = "use hermetic_child_env() with env_clear() — children are hermetic now")]
pub fn child_env_overlay() -> Vec<(String, String)> {
  hermetic_child_env().unwrap_or_default()
}

/// Run `f` with `backend` as the active resolution source, restoring the
/// previous backend (if any) on return — including on panic. Nests correctly.
pub fn with_backend<B: Backend + 'static, R>(backend: B, f: impl FnOnce() -> R) -> R {
  struct Restore(Option<Box<dyn Backend>>);
  impl Drop for Restore {
    fn drop(&mut self) {
      ACTIVE.with(|a| *a.borrow_mut() = self.0.take());
    }
  }
  let prev = ACTIVE.with(|a| a.borrow_mut().replace(Box::new(backend)));
  let _restore = Restore(prev);
  f()
}

/// Resolve a key through the active backend, or the process environment when
/// none is in scope. The single resolution primitive used by `FromEnvVar` and
/// by `env_kv!`-generated code (hence `pub` + hidden).
#[doc(hidden)]
pub fn resolve_key(key: &'static str) -> Result<Option<String>, EnvError> {
  if let Some(map) = SCOPED_MAP.with(|map| map.borrow().clone()) {
    return map.lookup(key);
  }
  ACTIVE.with(|a| match a.borrow().as_ref() {
    Some(backend) => backend.lookup(key),
    None => match GLOBAL.get() {
      Some(global) => global.lookup(key),
      None => env_lookup(key),
    },
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;

  #[test]
  fn inherited_environment_copies_all_keys_and_can_remove_them() {
    let map = EnvMap::from_process();
    #[allow(clippy::disallowed_methods)]
    let path = std::env::var("PATH").ok();
    assert_eq!(map.get("PATH"), path);
    map.remove("PATH");
    assert_eq!(map.get("PATH"), None);
  }

  #[cfg(unix)]
  #[test]
  fn os_snapshot_and_scoped_copy_keep_non_utf8_values() {
    use std::os::unix::ffi::OsStringExt;
    let map = EnvMap::new();
    let raw = std::ffi::OsString::from_vec(vec![0xff]);
    map.1.write().unwrap().insert("RAW".into(), raw.clone());
    let scoped = map.fork();
    scoped.set("OTHER", "value");
    assert!(scoped.snapshot_os().contains(&("RAW".into(), raw)));
    assert_eq!(map.get("OTHER"), None);
    scoped.set_default("RAW", "must not replace bytes");
    assert_eq!(scoped.get("RAW"), None);
    scoped.remove("RAW");
    assert!(scoped.snapshot_os().iter().all(|(key, _)| key != "RAW"));
  }

  #[test]
  fn scoped_environment_is_installed_only_while_a_future_is_polled() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    let map = EnvMap::new();
    map.set("SCOPED_ENV", "inside");
    let before = effective_var("SCOPED_ENV");
    let mut polls = 0;
    let future = std::future::poll_fn(|_| {
      assert_eq!(effective_var("SCOPED_ENV").as_deref(), Some("inside"));
      assert_eq!(
        resolve_key("SCOPED_ENV").unwrap().as_deref(),
        Some("inside")
      );
      assert!(
        hermetic_child_env()
          .unwrap()
          .contains(&("SCOPED_ENV".into(), "inside".into()))
      );
      polls += 1;
      if polls == 1 {
        Poll::Pending
      } else {
        Poll::Ready(())
      }
    });
    let mut future = Box::pin(with_env_map_async(map, future));
    let mut context = Context::from_waker(Waker::noop());
    assert!(future.as_mut().poll(&mut context).is_pending());
    assert_eq!(effective_var("SCOPED_ENV"), before);
    assert!(future.as_mut().poll(&mut context).is_ready());
    assert_eq!(effective_var("SCOPED_ENV"), before);
  }

  struct MapBackend(HashMap<String, String>);
  impl Backend for MapBackend {
    fn lookup(&self, key: &'static str) -> Result<Option<String>, EnvError> {
      Ok(self.0.get(key).cloned())
    }
  }

  #[test]
  fn merge_overlay_wins_and_appends_in_order() {
    let base = Some(vec![
      ("PATH".to_string(), "/usr/bin".to_string()),
      ("HOME".to_string(), "/home/a".to_string()),
    ]);
    let overlay = vec![
      ("HOME".to_string(), "/lane/own".to_string()),
      ("API_DIR".to_string(), "/lane/dir".to_string()),
    ];
    let merged = merge_overlay(base, &overlay).expect("some");
    // Overridden key keeps its base position; new key appends.
    assert_eq!(
      merged,
      vec![
        ("PATH".to_string(), "/usr/bin".to_string()),
        ("HOME".to_string(), "/lane/own".to_string()),
        ("API_DIR".to_string(), "/lane/dir".to_string()),
      ]
    );
    // Empty overlay is a no-op passthrough — including None (legacy inherit).
    assert_eq!(merge_overlay(None, &[]), None);
    // A map-less host with an overlay: the child is hermetic to the overlay.
    assert_eq!(merge_overlay(None, &overlay).as_deref(), Some(&overlay[..]));
  }

  #[test]
  fn composite_backend_layers_in_order() {
    let mut store = HashMap::new();
    store.insert("COMPOSITE_SECRET".to_string(), "from-store".to_string());
    let mut env = HashMap::new();
    env.insert("COMPOSITE_STRUCTURAL".to_string(), "from-env".to_string());
    // Same key in both → first backend (store) wins.
    env.insert("COMPOSITE_SECRET".to_string(), "from-env".to_string());

    let composite =
      CompositeBackend::new(vec![Box::new(MapBackend(store)), Box::new(MapBackend(env))]);
    // Secret resolves from the first (store) backend.
    assert_eq!(
      composite.lookup("COMPOSITE_SECRET").unwrap().as_deref(),
      Some("from-store")
    );
    // Structural key falls through to the second (env) backend.
    assert_eq!(
      composite.lookup("COMPOSITE_STRUCTURAL").unwrap().as_deref(),
      Some("from-env")
    );
    // Absent in both → None.
    assert_eq!(composite.lookup("COMPOSITE_ABSENT").unwrap(), None);
  }

  #[test]
  fn env_map_starts_empty_and_set_vs_set_default() {
    // Empty by default: no process-env capture, no dotfile.
    let map = EnvMap::new();
    assert!(map.snapshot().is_empty(), "a fresh EnvMap must be EMPTY");
    assert_eq!(map.get("PATH"), None, "not even PATH leaks in");

    // set_default = set-if-unset; set = last-wins.
    map.set_default("K", "first");
    map.set_default("K", "second");
    assert_eq!(map.get("K").as_deref(), Some("first"));
    map.set("K", "explicit");
    assert_eq!(map.get("K").as_deref(), Some("explicit"));
    map.set_default("K", "late-default-loses");
    assert_eq!(map.get("K").as_deref(), Some("explicit"));
    assert_eq!(
      map.snapshot(),
      vec![("K".to_string(), "explicit".to_string())]
    );
  }

  #[test]
  fn inherit_copies_only_named_present_keys() {
    let map = EnvMap::new();
    // PATH is guaranteed present in the test process env; the bogus key is not.
    map.inherit(&["PATH", "TENTO_ENV_TEST_DEFINITELY_ABSENT"]);
    #[allow(clippy::disallowed_methods)]
    let real_path = std::env::var("PATH").ok();
    assert_eq!(map.get("PATH"), real_path, "named+present key copied");
    assert_eq!(
      map.get("TENTO_ENV_TEST_DEFINITELY_ABSENT"),
      None,
      "absent key is skipped, never set to empty"
    );
    // ONLY the named keys crossed — HOME (present in the process env) did not.
    assert_eq!(map.get("HOME"), None, "unnamed keys never cross");
    assert_eq!(map.snapshot().len(), 1);
  }

  #[test]
  fn seed_home_resolves_from_the_user_database() {
    let map = EnvMap::new();
    map.seed_home();
    let home = map.get("HOME").expect("userdb yields a home dir");
    assert!(
      std::path::Path::new(&home).is_absolute(),
      "home is an absolute path: {home}"
    );
    assert_eq!(map.snapshot().len(), 1, "seed_home adds exactly HOME");
  }

  /// The env's `HOME` is honoured only when it is the caller's own directory;
  /// a relative path, a missing one, and a directory owned by another user
  /// all fall through to the user database. (Process env is global, so this
  /// one test walks the cases in sequence and restores what it found.)
  #[cfg(unix)]
  #[test]
  fn seed_home_honours_only_an_owned_env_home() {
    let saved = std::env::var_os("HOME");
    let userdb = home_from_userdb().expect("a userdb home");
    let mine = std::env::temp_dir().join(format!("tsh-home-{}", std::process::id()));
    std::fs::create_dir_all(&mine).unwrap();
    let cases: Vec<(Option<String>, String, &str)> = vec![
      (Some(mine.display().to_string()), mine.display().to_string(), "an owned absolute dir is honoured"),
      (Some("relative/home".into()), userdb.clone(), "a relative HOME is ignored"),
      (Some(mine.join("missing").display().to_string()), userdb.clone(), "a missing HOME is ignored"),
      (Some("/".into()), userdb.clone(), "a directory owned by another user is ignored"),
      (None, userdb.clone(), "no HOME at all: the userdb answers"),
    ];
    for (env_home, expected, why) in cases {
      match &env_home {
        Some(v) => unsafe { std::env::set_var("HOME", v) },
        None => unsafe { std::env::remove_var("HOME") },
      }
      let map = EnvMap::new();
      map.seed_home();
      assert_eq!(map.get("HOME").as_deref(), Some(expected.as_str()), "{why}");
    }
    match saved {
      Some(v) => unsafe { std::env::set_var("HOME", v) },
      None => unsafe { std::env::remove_var("HOME") },
    }
    let _ = std::fs::remove_dir(&mine);
  }

  /// Map-as-backend resolution is map-only (no process-env fallthrough) —
  /// exercised via the thread-local scope here; the process-GLOBAL install
  /// (`set_global_env_map` → `resolve_key` / `effective_var` /
  /// `hermetic_child_env`) is proven in `tests/global_map.rs`, its own test
  /// process, because installing the global map would break this binary's
  /// process-env-resolution tests.
  #[test]
  fn map_backend_resolution_is_map_only() {
    let map = EnvMap::new();
    with_backend(map.clone(), || {
      // PATH is guaranteed set in the process env; the MAP's absence wins.
      assert_eq!(
        resolve_key("PATH").unwrap(),
        None,
        "no process-env leak through an installed map"
      );
    });
    map.set("PATH", "/declared/bin");
    with_backend(map.clone(), || {
      assert_eq!(
        resolve_key("PATH").unwrap().as_deref(),
        Some("/declared/bin")
      );
    });
  }

  /// The env-name identity rule, asserted per platform so the WINDOWS rule is
  /// checked by the same test everywhere: on unix the fold is the identity
  /// (behavior byte-identical to before this rule existed), on windows it is
  /// the ASCII uppercase fold Win32 applies to env names.
  #[test]
  fn fold_key_is_the_platform_env_name_rule() {
    // Already-folded / caseless names borrow on every platform.
    assert_eq!(fold_key("PATH"), "PATH");
    assert!(matches!(fold_key("PATH"), Cow::Borrowed(_)));
    assert_eq!(fold_key("TENTO_SESSION_DIR_2"), "TENTO_SESSION_DIR_2");

    #[cfg(windows)]
    {
      assert_eq!(fold_key("Path"), "PATH");
      assert_eq!(fold_key("path"), "PATH");
      assert_eq!(fold_key("Temp"), "TEMP");
      // ASCII-only fold: the non-ASCII head is left exactly as written.
      assert_eq!(fold_key("Ünicode_kEy"), "ÜNICODE_KEY");
      assert_eq!(fold_key("Path"), fold_key("PATH"));
    }
    #[cfg(not(windows))]
    {
      assert_eq!(fold_key("Path"), "Path");
      assert_eq!(fold_key("path"), "path");
      assert!(matches!(fold_key("Path"), Cow::Borrowed(_)));
      assert_ne!(fold_key("Path"), fold_key("PATH"));
    }
  }

  /// `Path` vs `PATH` in the MAP: one variable on windows, two on unix. The
  /// windows arm also pins the first-seen spelling — the map keeps `Path`
  /// even though the later write said `PATH`.
  #[test]
  fn map_keys_follow_the_platform_case_rule() {
    let map = EnvMap::new();
    map.set("Path", "/first");
    map.set("PATH", "/second");

    #[cfg(windows)]
    {
      assert_eq!(map.get("path").as_deref(), Some("/second"), "one variable");
      assert_eq!(map.get("PATH").as_deref(), Some("/second"));
      assert_eq!(
        map.snapshot(),
        vec![("Path".to_string(), "/second".to_string())],
        "first-seen spelling survives; the child env block has ONE Path"
      );
    }
    #[cfg(not(windows))]
    {
      assert_eq!(map.get("path"), None, "unix names are bytes");
      assert_eq!(map.get("Path").as_deref(), Some("/first"));
      assert_eq!(map.get("PATH").as_deref(), Some("/second"));
      assert_eq!(map.snapshot().len(), 2, "two distinct unix variables");
    }
  }

  /// `env.default` sees a case-variant declaration as ALREADY SET on windows
  /// (first writer wins across spellings), and the typed [`Backend`] read
  /// resolves through the same fold as `get`.
  #[test]
  fn set_default_and_backend_lookup_share_the_case_rule() {
    let map = EnvMap::new();
    map.set("Temp", "/first");
    map.set_default("TEMP", "/default-loses-on-windows");

    #[cfg(windows)]
    {
      assert_eq!(map.get("TEMP").as_deref(), Some("/first"));
      assert_eq!(map.lookup("TEMP").unwrap().as_deref(), Some("/first"));
      assert_eq!(map.snapshot().len(), 1);
    }
    #[cfg(not(windows))]
    {
      assert_eq!(map.get("Temp").as_deref(), Some("/first"));
      assert_eq!(
        map.get("TEMP").as_deref(),
        Some("/default-loses-on-windows"),
        "a distinct unix variable"
      );
      assert_eq!(
        map.lookup("TEMP").unwrap().as_deref(),
        Some("/default-loses-on-windows"),
        "the Backend read resolves the same byte-exact key as get"
      );
      assert_eq!(map.snapshot().len(), 2);
    }
  }

  /// The export invariant the child spawn depends on: `snapshot()` never
  /// yields two names that `CreateProcess` would treat as the same variable.
  #[test]
  fn snapshot_has_no_case_colliding_names_on_windows() {
    let map = EnvMap::new();
    map.set("Path", "/p");
    map.set("PATH", "/p2");
    map.set("path", "/p3");
    map.set("Temp", "/t");
    map.set("HOME", "/h");

    let mut folded: Vec<String> = map
      .snapshot()
      .into_iter()
      .map(|(k, _)| fold_key(&k).into_owned())
      .collect();
    let before = folded.len();
    folded.sort();
    folded.dedup();
    assert_eq!(
      folded.len(),
      before,
      "no two exported names may differ only by case"
    );
    #[cfg(windows)]
    assert_eq!(before, 3, "Path/PATH/path collapse to one entry");
    #[cfg(not(windows))]
    assert_eq!(before, 5, "unix keeps every distinct byte-spelling");
  }

  #[test]
  fn active_backend_resolves_then_restores() {
    // No backend in scope -> process env path (key absent -> None).
    assert_eq!(resolve_key("TENTO_ENV_BACKEND_TEST_KEY").unwrap(), None);

    let mut m = HashMap::new();
    m.insert(
      "TENTO_ENV_BACKEND_TEST_KEY".to_string(),
      "from-backend".to_string(),
    );

    let got = with_backend(MapBackend(m), || {
      resolve_key("TENTO_ENV_BACKEND_TEST_KEY").unwrap()
    });
    assert_eq!(got.as_deref(), Some("from-backend"));

    // Scope restored: back to process env (absent).
    assert_eq!(resolve_key("TENTO_ENV_BACKEND_TEST_KEY").unwrap(), None);
  }
}
