//! `tento-dirs` — the per-app runtime directory contract for tento mini-apps.
//!
//! Every app gets exactly four directories, resolved the same way everywhere:
//!
//! | dir   | env override         | default                        | policy            |
//! |-------|----------------------|--------------------------------|-------------------|
//! | data  | `TENTO_APP_DATA_DIR` | `~/.local/share/tento/<id>`    | durable, backed up|
//! | state | `TENTO_APP_STATE_DIR`| `~/.local/state/tento/<id>`    | regeneratable     |
//! | cache | `TENTO_APP_CACHE_DIR`| `~/.cache/tento/<id>`          | deletable at will |
//! | run   | `TENTO_APP_RUN_DIR`  | `<state>/run`                  | dies with process |
//!
//! The env overrides are how a supervisor (launchd plist written by a
//! `tento_nodes::Node`) injects paths — apps call [`AppDirs::resolve`] and never
//! invent paths themselves; [`AppDirs::supervisor_env`] produces the pairs the
//! node side injects. XDG base vars (`XDG_DATA_HOME`, `XDG_STATE_HOME`,
//! `XDG_CACHE_HOME`) are honored for the defaults; macOS has no native
//! state/runtime equivalents, so this contract *is* the macOS convention too.
//!
//! [`AppDirs::ensure`] creates the tree and drops a `.tento-app` marker JSON in
//! the data root (the Syncthing `.stfolder` trick: tooling and backups can tell
//! "healthy empty" from "missing mount", and enumerate app data by scanning
//! `~/.local/share/tento/*/.tento-app`).
//!
//! Existing pre-contract roots remain supported by `AppDirs::preferring_legacy`
//! until their owners migrate them. Explicit app-directory overrides take
//! precedence; new installations use the contract paths.
//!
//! Every variable in the table is a typed [`tento_env`] key, loaded together as
//! one env-group ([`DirsEnvGroup`], `#[derive(FromEnv)]`): resolution goes
//! through the active [`tento_env::Backend`] rather than `std::env`, a failed
//! load reports every key at once, and the group carries the standard audit
//! trail ([`tento_env::PrintEnv`]). [`AppDirs::resolve_from`] is a pure
//! function of the loaded group — tests construct a `DirsEnvGroup` literal
//! instead of installing process state.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tento_env::{env_kv, Env, FromEnv, FromEnvVar, Home, XdgCacheHome, XdgDataHome, XdgStateHome};

// The XDG base keys are tento-env's (`common`, declared once for every
// caller); only the four app-contract overrides are ours.
env_kv!(AppDataDir, "TENTO_APP_DATA_DIR", PathBuf);
env_kv!(AppStateDir, "TENTO_APP_STATE_DIR", PathBuf);
env_kv!(AppCacheDir, "TENTO_APP_CACHE_DIR", PathBuf);
env_kv!(AppRunDir, "TENTO_APP_RUN_DIR", PathBuf);


// Compatibility names used by existing native/fleet consumers.
pub const ENV_DATA_DIR: &str = AppDataDir::KEY;
pub const ENV_STATE_DIR: &str = AppStateDir::KEY;
pub const ENV_CACHE_DIR: &str = AppCacheDir::KEY;
pub const ENV_RUN_DIR: &str = AppRunDir::KEY;

/// Marker file written into the data root by [`AppDirs::ensure`].
pub const MARKER_FILENAME: &str = ".tento-app";

/// Contents of the `.tento-app` marker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppMarker {
  pub id: String,
  pub format_version: u32,
}

/// The eight keys as one [`tento_env`] env-group, loaded in a single
/// [`FromEnv::from_env`] pass: a failed load reports every key at once, and the
/// group carries the standard audit surface ([`tento_env::PrintEnv`],
/// [`tento_env::EnvVars`]). Only `HOME` is required.
///
/// An override set to the empty string counts as unset — "no override", so the
/// default chain applies; [`AppDirs::resolve_from`] normalizes where it reads.
#[derive(Debug, FromEnv)]
pub struct DirsEnvGroup {
  pub home: Env<Home>,
  pub data_dir: Option<Env<AppDataDir>>,
  pub state_dir: Option<Env<AppStateDir>>,
  pub cache_dir: Option<Env<AppCacheDir>>,
  pub run_dir: Option<Env<AppRunDir>>,
  pub xdg_data_home: Option<Env<XdgDataHome>>,
  pub xdg_state_home: Option<Env<XdgStateHome>>,
  pub xdg_cache_home: Option<Env<XdgCacheHome>>,
}

/// An optional override's effective value: unset and empty both mean "none".
fn override_path<K: std::ops::Deref<Target = PathBuf>>(loaded: &Option<Env<K>>) -> Option<PathBuf> {
  let path = loaded.as_ref()?.value().deref().clone();
  (!path.as_os_str().is_empty()).then_some(path)
}

/// The four resolved directories for one app. See the crate docs for the
/// resolution table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDirs {
  pub id: String,
  pub data: PathBuf,
  pub state: PathBuf,
  pub cache: PathBuf,
  pub run: PathBuf,
}

impl AppDirs {
  /// Resolve the directory set for `id` from the process environment. Pure —
  /// touches no filesystem; call [`ensure`](Self::ensure) to materialize.
  ///
  /// `id` is the app's stable kebab id (crate dir base, self.toml key):
  /// lowercase alphanumerics and `-` only.
  pub fn resolve(id: &str) -> Result<AppDirs> {
    Self::resolve_from(id, &DirsEnvGroup::from_env().into_result()?)
  }

  /// Resolve a peer app while ignoring the current app's injected directories.
  /// XDG roots still apply; loading uses the active typed environment backend.
  pub fn resolve_peer(id: &str) -> Result<AppDirs> {
    let mut env = DirsEnvGroup::from_env().into_result()?;
    env.data_dir = None;
    env.state_dir = None;
    env.cache_dir = None;
    env.run_dir = None;
    Self::resolve_from(id, &env)
  }

  /// Resolution against an already-loaded [`DirsEnvGroup`] — the testable core
  /// of [`resolve`](Self::resolve). Pure: no environment, no filesystem.
  pub fn resolve_from(id: &str, env: &DirsEnvGroup) -> Result<AppDirs> {
    validate_id(id)?;
    let home = &env.home.value().0;
    let base = |xdg: Option<PathBuf>, home_rel: &[&str]| -> PathBuf {
      match xdg {
        Some(root) => root,
        None => home_rel.iter().fold(home.clone(), |p, seg| p.join(seg)),
      }
    };
    let contract =
      |injected: Option<PathBuf>, xdg: Option<PathBuf>, home_rel: &[&str]| -> PathBuf {
        match injected {
          Some(dir) => dir,
          None => base(xdg, home_rel).join("tento").join(id),
        }
      };

    let data = contract(
      override_path(&env.data_dir),
      override_path(&env.xdg_data_home),
      &[".local", "share"],
    );
    let state = contract(
      override_path(&env.state_dir),
      override_path(&env.xdg_state_home),
      &[".local", "state"],
    );
    let cache = contract(
      override_path(&env.cache_dir),
      override_path(&env.xdg_cache_home),
      &[".cache"],
    );
    let run = match override_path(&env.run_dir) {
      Some(dir) => dir,
      None => state.join("run"),
    };

    Ok(AppDirs {
      id: id.to_string(),
      data,
      state,
      cache,
      run,
    })
  }

  /// Create all four directories and write the `.tento-app` marker into the
  /// data root (idempotent; an existing marker is left untouched).
  pub fn ensure(&self) -> Result<()> {
    for (label, dir) in [
      ("data", &self.data),
      ("state", &self.state),
      ("cache", &self.cache),
      ("run", &self.run),
    ] {
      std::fs::create_dir_all(dir)
        .with_context(|| format!("create {label} dir {}", dir.display()))?;
    }
    let marker_path = self.data.join(MARKER_FILENAME);
    if !marker_path.exists() {
      let marker = AppMarker {
        id: self.id.clone(),
        format_version: 1,
      };
      let json = serde_json::to_string_pretty(&marker)?;
      std::fs::write(&marker_path, json)
        .with_context(|| format!("write marker {}", marker_path.display()))?;
    }
    Ok(())
  }

  /// The env pairs a supervisor injects (launchd plist / systemd unit) so the
  /// supervised process resolves exactly these paths.
  pub fn supervisor_env(&self) -> Vec<(String, String)> {
    [
      (AppDataDir::KEY, &self.data),
      (AppStateDir::KEY, &self.state),
      (AppCacheDir::KEY, &self.cache),
      (AppRunDir::KEY, &self.run),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string_lossy().into_owned()))
    .collect()
  }

  /// Keep an existing pre-contract root until its owner migrates it.
  pub fn preferring_legacy(self, legacy: &Path, env_overridden: bool) -> AppDirs {
    if env_overridden || !legacy.exists() {
      return self;
    }
    tracing::info!(
      app = %self.id,
      legacy = %legacy.display(),
      "using pre-contract legacy dir (move to {} and set TENTO_APP_*_DIR to migrate)",
      self.data.display()
    );
    AppDirs {
      id: self.id,
      data: legacy.to_path_buf(),
      state: legacy.to_path_buf(),
      cache: legacy.join("cache"),
      run: legacy.join("run"),
    }
  }
}

fn validate_id(id: &str) -> Result<()> {
  let ok = !id.is_empty()
    && id
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    && !id.starts_with('-')
    && !id.ends_with('-');
  if !ok {
    bail!("invalid app id {id:?}: expected kebab-case [a-z0-9-]");
  }
  Ok(())
}

mod config;
pub use config::{ConfigDirs, ConfigEnvGroup};

#[cfg(test)]
mod tests {
  use std::collections::HashMap;

  use super::*;

  /// A `DirsEnvGroup` with `home` set and every override unset.
  fn home(path: &str) -> DirsEnvGroup {
    DirsEnvGroup {
      home: Env::new(Home::KEY, Home(PathBuf::from(path))),
      data_dir: None,
      state_dir: None,
      cache_dir: None,
      run_dir: None,
      xdg_data_home: None,
      xdg_state_home: None,
      xdg_cache_home: None,
    }
  }

  /// A set override for group literals.
  fn kv<K: FromEnvVar>(value: K) -> Option<Env<K>> {
    Some(Env::new(K::KEY, value))
  }

  #[test]
  fn defaults_are_xdg_rooted() {
    let d = AppDirs::resolve_from("media", &home("/Users/x")).unwrap();
    assert_eq!(d.data, PathBuf::from("/Users/x/.local/share/tento/media"));
    assert_eq!(d.state, PathBuf::from("/Users/x/.local/state/tento/media"));
    assert_eq!(d.cache, PathBuf::from("/Users/x/.cache/tento/media"));
    assert_eq!(
      d.run,
      PathBuf::from("/Users/x/.local/state/tento/media/run")
    );
  }

  #[test]
  fn xdg_base_vars_reroot_defaults() {
    let d = AppDirs::resolve_from(
      "media",
      &DirsEnvGroup {
        xdg_state_home: kv(XdgStateHome(PathBuf::from("/var/state"))),
        ..home("/Users/x")
      },
    )
    .unwrap();
    assert_eq!(d.state, PathBuf::from("/var/state/tento/media"));
    assert_eq!(d.run, PathBuf::from("/var/state/tento/media/run"));
    assert_eq!(d.data, PathBuf::from("/Users/x/.local/share/tento/media"));
  }

  #[test]
  fn injected_env_wins_over_everything() {
    let d = AppDirs::resolve_from(
      "torrent",
      &DirsEnvGroup {
        data_dir: kv(AppDataDir(PathBuf::from("/opt/t/data"))),
        run_dir: kv(AppRunDir(PathBuf::from("/tmp/t.run"))),
        xdg_data_home: kv(XdgDataHome(PathBuf::from("/ignored"))),
        ..home("/Users/x")
      },
    )
    .unwrap();
    assert_eq!(d.data, PathBuf::from("/opt/t/data"));
    assert_eq!(d.run, PathBuf::from("/tmp/t.run"));
    // Un-overridden dirs still fall back per-dir.
    assert_eq!(
      d.state,
      PathBuf::from("/Users/x/.local/state/tento/torrent")
    );
  }

  /// A `tento_env` backend serving a fixed key/value map — proves resolution
  /// runs through the backend rather than the process environment.
  struct MapBackend(HashMap<&'static str, &'static str>);

  impl tento_env::Backend for MapBackend {
    fn lookup(
      &self,
      key: &'static str,
    ) -> std::result::Result<Option<String>, tento_env::EnvError> {
      Ok(self.0.get(key).map(|v| v.to_string()))
    }
  }

  fn backend(pairs: &[(&'static str, &'static str)]) -> MapBackend {
    MapBackend(pairs.iter().copied().collect())
  }

  fn load(pairs: &[(&'static str, &'static str)]) -> Result<DirsEnvGroup> {
    Ok(tento_env::with_backend(backend(pairs), || {
      DirsEnvGroup::from_env().into_result()
    })?)
  }

  #[test]
  fn from_env_resolves_through_the_active_backend() {
    let env = load(&[
      (Home::KEY, "/h"),
      (AppDataDir::KEY, "/opt/a/data"),
      (XdgCacheHome::KEY, "/var/cache"),
    ])
    .unwrap();
    assert_eq!(env.home.value().0, PathBuf::from("/h"));
    assert_eq!(
      override_path(&env.data_dir),
      Some(PathBuf::from("/opt/a/data"))
    );
    assert_eq!(
      override_path(&env.xdg_cache_home),
      Some(PathBuf::from("/var/cache"))
    );
    assert_eq!(override_path(&env.state_dir), None);
  }

  #[test]
  fn from_env_requires_home() {
    let err = load(&[]).unwrap_err();
    assert!(err.to_string().contains(Home::KEY), "{err}");
  }

  #[test]
  fn empty_env_values_are_unset() {
    // An empty override counts as unset where the fields are read, so the
    // default chain still fires.
    let env = load(&[
      (Home::KEY, "/h"),
      (AppDataDir::KEY, ""),
      (XdgCacheHome::KEY, ""),
    ])
    .unwrap();
    let d = AppDirs::resolve_from("a", &env).unwrap();
    assert_eq!(d.data, PathBuf::from("/h/.local/share/tento/a"));
    assert_eq!(d.cache, PathBuf::from("/h/.cache/tento/a"));
  }

  #[test]
  fn id_validation() {
    assert!(AppDirs::resolve_from("mouse-td", &home("/h")).is_ok());
    for bad in ["", "Media", "a_b", "a b", "-a", "a-", "a/b"] {
      assert!(
        AppDirs::resolve_from(bad, &home("/h")).is_err(),
        "{bad:?} should be rejected"
      );
    }
  }

  #[test]
  fn supervisor_env_round_trips() {
    let d = AppDirs::resolve_from("media", &home("/Users/x")).unwrap();
    let pairs = d.supervisor_env();
    let get = |key: &str| {
      pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| PathBuf::from(v))
    };
    // A different HOME entirely: every dir must come from the injected pairs.
    let injected = DirsEnvGroup {
      data_dir: get(AppDataDir::KEY).map(AppDataDir).and_then(kv),
      state_dir: get(AppStateDir::KEY).map(AppStateDir).and_then(kv),
      cache_dir: get(AppCacheDir::KEY).map(AppCacheDir).and_then(kv),
      run_dir: get(AppRunDir::KEY).map(AppRunDir).and_then(kv),
      ..home("/elsewhere")
    };
    assert_eq!(d, AppDirs::resolve_from("media", &injected).unwrap());
  }

  #[test]
  fn ensure_creates_tree_and_marker() {
    let tmp = std::env::temp_dir().join(format!("tento-dirs-ensure-{}", std::process::id()));
    let d = AppDirs {
      id: "t".into(),
      data: tmp.join("data"),
      state: tmp.join("state"),
      cache: tmp.join("cache"),
      run: tmp.join("run"),
    };
    d.ensure().unwrap();
    d.ensure().unwrap(); // idempotent
    let marker: AppMarker =
      serde_json::from_str(&std::fs::read_to_string(d.data.join(MARKER_FILENAME)).unwrap())
        .unwrap();
    assert_eq!(marker.id, "t");
    assert_eq!(marker.format_version, 1);
    assert!(d.run.is_dir());
    std::fs::remove_dir_all(&tmp).ok();
  }
  #[test]
  fn peer_resolution_uses_backend_and_ignores_self_overrides() {
    let dirs = tento_env::with_backend(backend(&[
      (Home::KEY, "/h"), (AppDataDir::KEY, "/self/data"),
      (AppStateDir::KEY, "/self/state"), (AppCacheDir::KEY, "/self/cache"),
      (AppRunDir::KEY, "/self/run"), (XdgStateHome::KEY, "/xdg/state"),
    ]), || AppDirs::resolve_peer("torrent")).unwrap();
    assert_eq!(dirs.data, PathBuf::from("/h/.local/share/tento/torrent"));
    assert_eq!(dirs.state, PathBuf::from("/xdg/state/tento/torrent"));
    assert_eq!(dirs.cache, PathBuf::from("/h/.cache/tento/torrent"));
    assert_eq!(dirs.run, dirs.state.join("run"));
  }

  #[test]
  fn legacy_roots_survive_until_explicit_migration() {
    let tmp_path = std::env::temp_dir().join(format!("tento-legacy-reconcile-{}", std::process::id()));
    std::fs::create_dir_all(&tmp_path).unwrap();
    let tmp = tmp_path.as_path();
    let dirs = AppDirs::resolve_from("torrent", &home("/h")).unwrap();
    let retained = dirs.clone().preferring_legacy(tmp, false);
    assert_eq!(retained.data, tmp);
    assert_eq!(retained.state, tmp);
    assert_eq!(dirs.clone().preferring_legacy(tmp, true), dirs);
    assert_eq!(dirs.clone().preferring_legacy(&tmp.join("absent"), false), dirs);
  }

}
