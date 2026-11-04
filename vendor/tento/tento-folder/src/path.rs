//! Path-safe joining under a folder root.
//!
//! Serving or reading folder entries by caller-supplied relative path must not
//! escape the folder — [`safe_join`] is the one traversal guard, shared by
//! every consumer that maps request paths onto a folder on disk.

use std::path::{Component, Path, PathBuf};

use thiserror::Error;

/// Why a relative path was rejected by [`safe_join`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum JoinError {
  #[error("path is empty")]
  Empty,
  #[error("path must be relative")]
  Absolute,
  #[error("path contains traversal")]
  Traversal,
}

/// Join `rel` under `root`, rejecting empties, absolutes, and traversal
/// (`..` or prefix/root components). `.` segments are stripped, not rejected.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, JoinError> {
  if rel.is_empty() {
    return Err(JoinError::Empty);
  }
  let rel_path = Path::new(rel);
  if rel_path.is_absolute() {
    return Err(JoinError::Absolute);
  }

  let mut out = root.to_path_buf();
  for component in rel_path.components() {
    match component {
      Component::Normal(part) => out.push(part),
      Component::CurDir => {}
      _ => return Err(JoinError::Traversal),
    }
  }

  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn safe_join_rejects_traversal_and_absolute() {
    let root = Path::new("/tmp/lib");
    assert!(safe_join(root, "captures/a.png").is_ok());
    assert_eq!(safe_join(root, ""), Err(JoinError::Empty));
    assert_eq!(safe_join(root, "/etc/passwd"), Err(JoinError::Absolute));
    assert_eq!(safe_join(root, "../escape"), Err(JoinError::Traversal));
    assert_eq!(
      safe_join(root, "captures/../../escape"),
      Err(JoinError::Traversal)
    );
    // CurDir segments are stripped, not rejected.
    assert_eq!(
      safe_join(root, "./captures/a.png").unwrap(),
      root.join("captures/a.png")
    );
  }
}
