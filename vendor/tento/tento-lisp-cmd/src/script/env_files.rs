//! The reads behind `env.from-file` and `env.from-json`, shared by the
//! runtime natives (registered in `interp.rs`) and tsh's text loader, so the
//! two can never disagree about what a secret file yields.

use std::path::{Path, PathBuf};

/// A path an rc names, resolved against the declaring file's directory:
/// absolute stays absolute; a relative path joins `dir`.
pub fn resolve_declared_path(dir: Option<&Path>, value: &str) -> PathBuf {
  let path = PathBuf::from(value);
  match dir {
    Some(dir) if path.is_relative() => dir.join(path),
    _ => path,
  }
}

/// `(env.from-file "NAME" PATH)`: the file's contents with trailing
/// whitespace trimmed. A credential written by `echo` or an editor ends in a
/// newline, and a key with one appended fails auth looking like a bad key.
pub fn read_env_file(name: &str, path: &Path) -> Result<String, String> {
  let raw = std::fs::read_to_string(path)
    .map_err(|error| format!("(env.from-file {name:?}): {}: {error}", path.display()))?;
  warn_if_secret_is_readable(path);
  Ok(raw.trim_end().to_string())
}

/// `(env.from-json "NAME" PATH "dotted.key")`: one string inside a JSON file
/// another tool owns (reading it, not copying it, survives that tool's
/// rotations). A key containing a literal `.` is not addressable; an
/// unreachable path names the segment that failed.
pub fn read_env_json(name: &str, path: &Path, key: &str) -> Result<String, String> {
  let raw = std::fs::read_to_string(path)
    .map_err(|error| format!("(env.from-json {name:?}): {}: {error}", path.display()))?;
  warn_if_secret_is_readable(path);
  let doc: serde_json::Value = serde_json::from_str(&raw)
    .map_err(|error| format!("(env.from-json {name:?}): {}: {error}", path.display()))?;
  let mut cursor = &doc;
  for segment in key.split('.') {
    cursor = cursor.get(segment).ok_or_else(|| {
      format!(
        "(env.from-json {name:?}): {}: no `{segment}` in path `{key}`",
        path.display()
      )
    })?;
  }
  cursor.as_str().map(str::to_string).ok_or_else(|| {
    format!(
      "(env.from-json {name:?}): {}: `{key}` is {}, expected a string",
      path.display(),
      match cursor {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a bool",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
        serde_json::Value::String(_) => unreachable!(),
      }
    )
  })
}

/// Warn when a file read as a secret is readable beyond its owner.
pub fn warn_if_secret_is_readable(path: &Path) {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
      let mode = meta.permissions().mode();
      if mode & 0o077 != 0 {
        eprintln!(
          "warning: {} is readable beyond its owner (mode {:04o}) — `chmod 600` it if it holds a secret",
          path.display(),
          mode & 0o7777
        );
      }
    }
  }
  #[cfg(not(unix))]
  let _unix_only = path;
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_relative_path_joins_the_declaring_dir() {
    let dir = Path::new("/home/u/.config/tsh");
    assert_eq!(resolve_declared_path(Some(dir), "k.env"), dir.join("k.env"));
    assert_eq!(resolve_declared_path(Some(dir), "/etc/k"), PathBuf::from("/etc/k"));
    assert_eq!(resolve_declared_path(None, "k.env"), PathBuf::from("k.env"));
  }

  #[test]
  fn json_reads_one_dotted_string_and_names_the_failing_segment() {
    let dir = std::env::temp_dir().join(format!("env-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("auth.json");
    std::fs::write(&path, r#"{"a":{"b":"tok","n":3}}"#).unwrap();
    assert_eq!(read_env_json("K", &path, "a.b").unwrap(), "tok");
    assert!(read_env_json("K", &path, "a.c").unwrap_err().contains("no `c` in path `a.c`"));
    assert!(read_env_json("K", &path, "a.n").unwrap_err().contains("is a number"));
    std::fs::write(dir.join("k.env"), "secret\n\n").unwrap();
    assert_eq!(read_env_file("K", &dir.join("k.env")).unwrap(), "secret");
    std::fs::remove_dir_all(&dir).unwrap();
  }
}
