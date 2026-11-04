//! On-host secret store: one `0600` file per secret under a `0700` per-service
//! directory. This is the canonical convention a deployed service reads its
//! secrets from at startup, and that `secret-set`/`secret-check` operate on.
//!
//! Layout: `<base>/<service>/<KEY>`, where `<base>` is `$TSH_SECRETS_DIR` or
//! `$HOME/.local/share/tsh/secrets` — falling back to the pre-neutralization
//! `$LONA_SECRETS_DIR` / `$HOME/.local/share/lona/secrets` while a host still
//! has one. Kept out of the package bundle so a redeploy / rescind never
//! wipes it.

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// A config value for the store: the DECLARED session env first
/// ([`tento_env::effective_var`], the installed `EnvMap`), then the process
/// environment. The declared map must win — a tsh session's
/// `(env.set "TSH_SECRETS_DIR" …)` exists precisely so a sandboxed session
/// does not read the operator's live store; reading the process env first
/// silently ignored it (found the hard way: a test session minted a real
/// key). The process-env fallback keeps deployed services and plain
/// binaries — where no map is ever installed — working unchanged.
fn config_var(name: &str) -> Option<String> {
  tento_env::effective_var(name).or_else(|| std::env::var(name).ok())
}

/// Root of the on-host secret store: `$TSH_SECRETS_DIR` (declared env, then
/// process env) or `$HOME/.local/share/tsh/secrets`, with a fallback to the
/// pre-neutralization name and path — see [`resolve_base_dir`].
pub fn base_dir() -> Result<PathBuf> {
  let (neutral, legacy, home) = inputs(config_var);
  resolve_base_dir(neutral, legacy, home, |path| path.exists())
}

/// The store's inputs, from a variable lookup: the neutral override, the
/// legacy override, and `HOME`.
fn inputs(
  var: impl Fn(&str) -> Option<String>,
) -> (Option<String>, Option<String>, Option<String>) {
  (var("TSH_SECRETS_DIR"), var("LONA_SECRETS_DIR"), var("HOME"))
}

/// A place a secret store may live, and why it is one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretsBase {
  pub path: PathBuf,
  /// `TSH_SECRETS_DIR`, `legacy secrets variable`, `secrets base` (the
  /// neutral default under HOME) or `legacy secrets base`.
  pub source: &'static str,
}

/// The neutral store root under HOME.
const NEUTRAL_HOME: &str = ".local/share/tsh/secrets";

/// Every root [`resolve_base_dir`] could choose, in its precedence order:
/// the neutral override, the legacy override, the neutral default under
/// HOME, the legacy default under HOME.
fn ordered_bases(
  neutral_override: Option<String>,
  legacy_override: Option<String>,
  home: Option<&Path>,
) -> Vec<SecretsBase> {
  let mut out = Vec::new();
  if let Some(dir) = neutral_override {
    out.push(SecretsBase {
      path: PathBuf::from(dir),
      source: "TSH_SECRETS_DIR",
    });
  }
  if let Some(dir) = legacy_override {
    out.push(SecretsBase {
      path: PathBuf::from(dir),
      source: "legacy secrets variable",
    });
  }
  if let Some(home) = home {
    out.push(SecretsBase {
      path: home.join(NEUTRAL_HOME),
      source: "secrets base",
    });
    out.push(SecretsBase {
      path: home.join(".local/share/lona/secrets"),
      source: "legacy secrets base",
    });
  }
  out
}

/// Every secret-store root on this host, in [`base_dir`]'s precedence order,
/// that exists, each once. [`base_dir`] picks one root to write to; a reader
/// looking for something another tool keeps beside its secrets (a store of
/// its own under a base) tries these in order instead.
pub fn candidate_base_dirs() -> Vec<SecretsBase> {
  candidate_base_dirs_with(config_var, |path| path.exists())
}

/// [`candidate_base_dirs`] with its lookups passed in: `var` answers
/// `TSH_SECRETS_DIR`, the legacy override and `HOME`. Roots that resolve to
/// the same directory are listed once, first place kept.
pub fn candidate_base_dirs_with(
  var: impl Fn(&str) -> Option<String>,
  exists: impl Fn(&Path) -> bool,
) -> Vec<SecretsBase> {
  let (neutral, legacy, home) = inputs(var);
  let mut seen: Vec<PathBuf> = Vec::new();
  let mut out = Vec::new();
  for base in ordered_bases(neutral, legacy, home.as_deref().map(Path::new)) {
    if !exists(&base.path) {
      continue;
    }
    let key = std::fs::canonicalize(&base.path).unwrap_or_else(|_| base.path.clone());
    if seen.contains(&key) {
      continue;
    }
    seen.push(key);
    out.push(base);
  }
  out
}

/// The store-root rule, with its inputs passed in so it can be tested without
/// a real home directory.
///
/// COMPATIBILITY SHIM. Two fallbacks, and both are load-bearing today:
///
/// * `$LONA_SECRETS_DIR` is still what sets the root on existing services —
///   the legacy package launcher exports it, and the service console's
///   `packages.rs` relies on it, and several node tests set it to redirect
///   themselves away from the operator's live store. A build that only read
///   `TSH_SECRETS_DIR` would ignore all of that: deployed services would look
///   in the default root and find nothing, and those tests would quietly start
///   reading — and writing — the *real* store. That is the exact footgun that
///   minted a live key on 2026-08-27.
/// * The default path moves from the legacy name to `tsh`, but deployed hosts'
///   secrets remain under the older root. So an existing legacy store wins over a
///   neutral root that does not exist yet; a host with both (already migrated)
///   gets the neutral one, and only a fresh install creates it.
///
/// Deletable once every fleet host's store has been moved to
/// `~/.local/share/tsh/secrets` and every setter — the package launcher, console,
/// package.node, secrets_pipeline, the file backend's tests — exports
/// `TSH_SECRETS_DIR`. Until then, removing either arm loses secrets rather
/// than failing to find them.
fn resolve_base_dir(
  neutral_override: Option<String>,
  legacy_override: Option<String>,
  home: Option<String>,
  exists: impl Fn(&Path) -> bool,
) -> Result<PathBuf> {
  // An override wins outright, the neutral one first — but only an absolute
  // one. A relative root resolves against whatever directory the process
  // happens to run in, so secrets land somewhere nobody looks for them.
  if let Some(dir) = neutral_override {
    return absolute_override("TSH_SECRETS_DIR", dir);
  }
  if let Some(dir) = legacy_override {
    return absolute_override("LONA_SECRETS_DIR", dir);
  }
  let home = PathBuf::from(
    home.ok_or_else(|| anyhow::anyhow!("HOME not set; cannot resolve secret store"))?,
  );
  // The first root under HOME that exists, else the neutral one (which a
  // fresh install creates).
  let under_home = ordered_bases(None, None, Some(&home));
  Ok(
    under_home
      .iter()
      .find(|base| exists(&base.path))
      .unwrap_or(&under_home[0])
      .path
      .clone(),
  )
}

/// An override taken as the store root, refused unless it is an absolute path.
/// Empty and the literal `nil` are the usual culprits: an rc that renders an
/// unset variable with `(str "TSH_SECRETS_DIR=" (env ...))` hands the child
/// `nil`, and the store would otherwise create `<cwd>/nil/` and write OAuth
/// secrets there. The value is a path, never a secret, so it is safe to name.
fn absolute_override(name: &str, dir: String) -> Result<PathBuf> {
  let path = PathBuf::from(&dir);
  if !path.is_absolute() {
    anyhow::bail!(
      "{name}={dir:?} is not an absolute path; refusing it as the secret store root \
       (unset {name} to use the default under HOME)"
    );
  }
  Ok(path)
}

/// Per-service secret directory: `<base>/<service>` (`0700`).
pub fn service_dir(service: &str) -> Result<PathBuf> {
  Ok(base_dir()?.join(service))
}

/// Per-key secret file: `<base>/<service>/<KEY>` (`0600`).
pub fn secret_path(service: &str, key: &str) -> Result<PathBuf> {
  Ok(service_dir(service)?.join(key))
}

/// Write a secret value: `0700` dir, `0600` file, atomic temp + rename. The
/// value is never logged.
#[cfg(unix)]
pub fn write(service: &str, key: &str, value: &[u8]) -> Result<()> {
  let dir = service_dir(service)?;
  std::fs::create_dir_all(&dir).with_context(|| format!("create secret dir {}", dir.display()))?;
  std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
    .with_context(|| format!("chmod 0700 {}", dir.display()))?;

  let path = secret_path(service, key)?;
  let tmp = path.with_extension("tmp");
  std::fs::write(&tmp, value).with_context(|| format!("write {}", tmp.display()))?;
  std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
    .with_context(|| format!("chmod 0600 {}", tmp.display()))?;
  std::fs::rename(&tmp, &path)
    .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
  Ok(())
}

/// The store's confidentiality guarantee IS the owner-only mode bits, so a
/// platform without them refuses to write rather than store secrets openly.
/// (A Windows arm needs a current-user DACL, not a silent no-op.)
#[cfg(not(unix))]
pub fn write(_service: &str, _key: &str, _value: &[u8]) -> Result<()> {
  anyhow::bail!("secret store requires owner-only file modes; unsupported on this platform")
}

/// Whether a secret exists and is non-empty.
pub fn present(service: &str, key: &str) -> Result<bool> {
  match std::fs::metadata(secret_path(service, key)?) {
    Ok(m) => Ok(m.len() > 0),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(e) => Err(anyhow::anyhow!("stat secret {service}/{key}: {e}")),
  }
}

/// List the keys present (non-empty) in a service bucket, sorted. A missing
/// bucket yields an empty list (not an error). Skips the atomic-write `.tmp`
/// staging files. Values are never read — this is the inventory enumeration the
/// `secrets-store` fleet node uses to flag orphans.
pub fn list(service: &str) -> Result<Vec<String>> {
  let dir = service_dir(service)?;
  let entries = match std::fs::read_dir(&dir) {
    Ok(entries) => entries,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => return Err(anyhow::anyhow!("list secrets {}: {e}", dir.display())),
  };
  let mut keys = Vec::new();
  for entry in entries {
    let entry = entry.with_context(|| format!("read dir entry under {}", dir.display()))?;
    let Some(name) = entry.file_name().to_str().map(str::to_string) else {
      continue;
    };
    if name.ends_with(".tmp") {
      continue;
    }
    match entry.metadata() {
      Ok(m) if m.is_file() && m.len() > 0 => keys.push(name),
      _ => {}
    }
  }
  keys.sort();
  Ok(keys)
}

/// Read a secret value if present and non-empty.
pub fn read(service: &str, key: &str) -> Result<Option<Vec<u8>>> {
  match std::fs::read(secret_path(service, key)?) {
    Ok(b) if !b.is_empty() => Ok(Some(b)),
    Ok(_) => Ok(None),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(anyhow::anyhow!("read secret {service}/{key}: {e}")),
  }
}

/// Remove a secret if present. Idempotent: a missing secret is `Ok(())`.
pub fn delete(service: &str, key: &str) -> Result<()> {
  match std::fs::remove_file(secret_path(service, key)?) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(anyhow::anyhow!("delete secret {service}/{key}: {e}")),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn resolve(
    neutral: Option<&str>,
    legacy: Option<&str>,
    present: &'static [&'static str],
  ) -> PathBuf {
    resolve_base_dir(
      neutral.map(str::to_string),
      legacy.map(str::to_string),
      Some("/home/op".to_string()),
      move |path| present.iter().any(|p| Path::new(p) == path),
    )
    .expect("HOME is set")
  }

  /// The store root's resolution order, pinned end to end. Every case except
  /// the first and the last exists only because the fleet has not migrated;
  /// when it has, cases 2 and 4 go away with the fallback arms.
  #[test]
  fn the_store_root_prefers_the_neutral_name_but_never_abandons_an_existing_store() {
    // 1. The neutral override wins outright.
    assert_eq!(
      resolve(Some("/explicit/tsh"), Some("/explicit/legacy"), &[]),
      PathBuf::from("/explicit/tsh")
    );

    // 2. Only the legacy override is set — the case every deployed service
    //    and several node tests are in today.
    assert_eq!(
      resolve(None, Some("/explicit/legacy"), &[]),
      PathBuf::from("/explicit/legacy")
    );

    // 3. No override, no store on disk: a fresh install gets the new default.
    assert_eq!(
      resolve(None, None, &[]),
      PathBuf::from("/home/op/.local/share/tsh/secrets")
    );

    // 4. No override, but this host already has a legacy store: keep using it.
    //    Choosing the new default here is what would lose the secrets.
    assert_eq!(
      resolve(None, None, &["/home/op/.local/share/lona/secrets"]),
      PathBuf::from("/home/op/.local/share/lona/secrets")
    );

    // 5. Both roots exist — a migrated host — so the neutral one wins and the
    //    fallback does not drag it back.
    assert_eq!(
      resolve(
        None,
        None,
        &[
          "/home/op/.local/share/tsh/secrets",
          "/home/op/.local/share/lona/secrets"
        ]
      ),
      PathBuf::from("/home/op/.local/share/tsh/secrets")
    );
  }

  /// Every candidate root, in the order `base_dir` prefers them, existing
  /// only and each once.
  #[test]
  fn candidate_roots_follow_the_store_order_and_skip_missing_and_repeated_ones() {
    let home = "/home/op";
    let under = |base: &str| {
      ordered_bases(None, None, Some(Path::new(home)))
        .into_iter()
        .find(|b| b.source == base)
        .unwrap()
        .path
    };
    let neutral = under("secrets base");
    let legacy = under("legacy secrets base");
    let vars = |neutral_var: Option<&str>, legacy_var: Option<&str>| {
      let (neutral_var, legacy_var) = (
        neutral_var.map(str::to_owned),
        legacy_var.map(str::to_owned),
      );
      move |name: &str| match name {
        "TSH_SECRETS_DIR" => neutral_var.clone(),
        "HOME" => Some(home.to_owned()),
        _ => legacy_var.clone(),
      }
    };
    let listed = |var: &dyn Fn(&str) -> Option<String>, present: &[&Path]| {
      candidate_base_dirs_with(var, |p| present.contains(&p))
        .into_iter()
        .map(|b| (b.path, b.source))
        .collect::<Vec<_>>()
    };
    let all = [
      Path::new("/explicit/tsh"),
      Path::new("/explicit/old"),
      neutral.as_path(),
      legacy.as_path(),
    ];
    assert_eq!(
      listed(&vars(Some("/explicit/tsh"), Some("/explicit/old")), &all),
      vec![
        (PathBuf::from("/explicit/tsh"), "TSH_SECRETS_DIR"),
        (PathBuf::from("/explicit/old"), "legacy secrets variable"),
        (neutral.clone(), "secrets base"),
        (legacy.clone(), "legacy secrets base"),
      ]
    );
    // Missing roots are skipped; an override naming a default is listed once.
    assert_eq!(
      listed(
        &vars(Some(&legacy.to_string_lossy()), None),
        &[legacy.as_path()]
      ),
      vec![(legacy.clone(), "TSH_SECRETS_DIR")]
    );
    assert_eq!(listed(&vars(None, None), &[]), vec![]);
    // `base_dir` still chooses among the same roots in the same order.
    assert_eq!(
      resolve_base_dir(None, None, Some(home.into()), |p| p == legacy).unwrap(),
      legacy
    );
    assert_eq!(
      resolve_base_dir(None, None, Some(home.into()), |_| false).unwrap(),
      neutral
    );
  }

  /// B5: an override must be an absolute path. Unset still means the default
  /// under HOME; empty, the rendered-nil `nil` and any relative path are
  /// refused with the variable and value named, never used as a root.
  #[test]
  fn an_override_that_is_not_an_absolute_path_is_refused() {
    let resolve_with = |neutral: Option<&str>, legacy: Option<&str>| {
      resolve_base_dir(
        neutral.map(str::to_string),
        legacy.map(str::to_string),
        Some("/home/op".to_string()),
        |_| false,
      )
    };
    // Unset: the default root under HOME.
    assert_eq!(
      resolve_with(None, None).unwrap(),
      PathBuf::from("/home/op/.local/share/tsh/secrets")
    );
    // Absolute: used as given.
    assert_eq!(
      resolve_with(Some("/srv/vault"), None).unwrap(),
      PathBuf::from("/srv/vault")
    );
    for bad in ["", "nil", "foo/bar", "./vault"] {
      let err = resolve_with(Some(bad), None).expect_err(bad).to_string();
      assert!(err.contains("TSH_SECRETS_DIR"), "{err}");
      assert!(err.contains(&format!("{bad:?}")), "{err}");
      assert!(err.contains("not an absolute path"), "{err}");
      // A bad neutral override is refused, not skipped in favour of the
      // legacy one: the operator asked for a root and gets told why not.
      resolve_with(Some(bad), Some("/explicit/legacy")).expect_err(bad);
      let err = resolve_with(None, Some(bad)).expect_err(bad).to_string();
      assert!(err.contains("LONA_SECRETS_DIR"), "{err}");
    }
  }

  #[test]
  fn a_missing_home_is_still_an_error_rather_than_a_relative_path() {
    let err = resolve_base_dir(None, None, None, |_| false).expect_err("HOME is required");
    assert!(err.to_string().contains("HOME not set"), "{err}");
  }
}
