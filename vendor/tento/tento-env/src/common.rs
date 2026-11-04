//! Common, widely-used environment variables, declared once here so callers
//! don't each re-declare them. Resolve at the composition root (a binary
//! `main.rs`) via `Home::from_env()` and pass the value down.

use std::path::{Path, PathBuf};

use crate::env_kv;
use crate::from_env::FromEnvVar;

env_kv!("HOME", PathBuf);

impl Home {
  /// Expand a leading `~` or `~/` in `path` against this home directory.
  ///
  /// Only the bare-tilde forms are handled: `~` becomes the home directory
  /// itself and `~/rest` becomes `<home>/rest`. Everything else — absolute or
  /// relative paths, `~user` forms, non-UTF-8 paths — passes through
  /// untouched.
  pub fn expand(&self, path: &Path) -> PathBuf {
    let Some(s) = path.to_str() else {
      return path.to_path_buf();
    };
    let suffix = if s == "~" {
      ""
    } else if let Some(suffix) = s.strip_prefix("~/") {
      suffix
    } else {
      return path.to_path_buf();
    };
    let mut expanded = self.0.clone();
    if !suffix.is_empty() {
      expanded.push(suffix);
    }
    expanded
  }

  /// Expand a leading `~`/`~/` in `path` against `$HOME`, resolved through
  /// the active backend via [`Home::from_env`] (see [`Home::expand`] for the
  /// exact expansion rules). If `HOME` is unset the path passes through
  /// untouched.
  ///
  /// Convenience for one-off expansion of operator-supplied config paths;
  /// code with many paths to expand should resolve [`Home`] once and call
  /// [`Home::expand`].
  pub fn expand_from_env(path: &Path) -> PathBuf {
    match Home::from_env() {
      Ok(home) => home.value().expand(path),
      Err(_) => path.to_path_buf(),
    }
  }
}

/// Resolve a per-user application data directory from declared environment
/// state. `override_dir` is explicit caller policy; the fallback is
/// `<HOME>/.local/share/tento/<app>`.
pub fn app_data_dir(app: &str, override_dir: Option<&str>) -> Result<PathBuf, crate::EnvError> {
  if let Some(dir) = override_dir.map(str::trim).filter(|dir| !dir.is_empty()) {
    return Ok(PathBuf::from(dir));
  }
  let home = Home::from_env()?;
  Ok(home.into_value().0.join(".local/share/tento").join(app))
}

// XDG base directory for user-specific data (durable, backed up).
// Per the XDG Base Directory spec the convention is `$HOME/.local/share`
// when unset; resolve that fallback at the call site via [`Home`].
env_kv!("XDG_DATA_HOME", PathBuf);

// XDG base directory for user-specific state (logs, history, traces).
// Per the XDG Base Directory spec the convention is `$HOME/.local/state`
// when unset; resolve that fallback at the call site via [`Home`].
env_kv!("XDG_STATE_HOME", PathBuf);

// XDG base directory for user-specific cached data (deletable at will).
// Per the XDG Base Directory spec the convention is `$HOME/.cache` when
// unset; resolve that fallback at the call site via [`Home`].
env_kv!("XDG_CACHE_HOME", PathBuf);

// XDG base directory for user-specific config (rc files, installed presets).
// Per the XDG Base Directory spec the convention is `$HOME/.config` when unset;
// resolve that fallback at the call site via [`Home`].
env_kv!("XDG_CONFIG_HOME", PathBuf);

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn expand_handles_tilde_forms_and_passes_others_through() {
    let home = Home(PathBuf::from("/home/op"));
    let cases = [
      ("~", "/home/op"),
      ("~/", "/home/op"),
      ("~/Library/Logs/a.log", "/home/op/Library/Logs/a.log"),
      ("/absolute/path", "/absolute/path"),
      ("relative/path", "relative/path"),
      ("~user/path", "~user/path"),
    ];
    for (input, expected) in cases {
      assert_eq!(
        home.expand(Path::new(input)),
        PathBuf::from(expected),
        "input {input:?}"
      );
    }
  }
}
