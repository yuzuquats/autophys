use std::path::{Path, PathBuf};

use thiserror::Error;

/// Unified error type for build and load failures.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum FolderError {
  /// A required entry was missing under [`crate::ValidationMode::Strict`].
  #[error("missing {expected}: {}", path.display())]
  Missing { path: PathBuf, expected: NodeKind },

  /// An entry was present but the wrong kind (e.g. expected a file,
  /// found a directory).
  #[error(
    "wrong kind at {}: expected {expected:?}, found {found:?}",
    path.display()
  )]
  WrongKind {
    path: PathBuf,
    expected: NodeKind,
    found: NodeKind,
  },

  /// A typed-content file failed its content contract — the
  /// [`FileContent`](crate::FileContent) impl named by its `File<C>` /
  /// `Valid<File<C>>` / `Unchecked<File<C>>` slot rejected the bytes.
  ///
  /// tento-folder names the file and nothing else: it does not know
  /// the file's format, so whether this was a syntax error or a
  /// structural mismatch is the `source` message's to tell. The
  /// bundled format markers ([`crate::formats`]) parse in two phases
  /// precisely so that distinction survives: `"malformed JSON: …"` vs
  /// `"well-formed JSON, but not a …"`.
  #[error("content contract failed for {}: {source}", path.display())]
  Shape {
    path: PathBuf,
    #[source]
    source: Box<dyn std::error::Error + Send + Sync>,
  },

  /// An entry a closed [`crate::Spec`] folder does not declare.
  #[error("unexpected entry: {}", path.display())]
  Unexpected { path: PathBuf },

  /// An entry a [`crate::Spec`] `none` entry forbids — `pattern` is the
  /// literal or glob it matched.
  #[error("forbidden entry: {} (matches `{pattern}`)", path.display())]
  Forbidden { path: PathBuf, pattern: String },

  /// Underlying I/O failure.
  #[error("I/O error at {}: {source}", path.display())]
  Io {
    path: PathBuf,
    #[source]
    source: std::io::Error,
  },

  /// Caller-defined invariant failure raised by a tier-2
  /// [`crate::ValidateFolder`] implementation. Used for cross-file
  /// invariants the lower-lib structural / content validator can't
  /// see (e.g. "VERSION file format parses", "secrets/{host}/ covers
  /// every declared app").
  #[error("invariant failed at {}: {message}", path.display())]
  Invariant { path: PathBuf, message: String },

  /// Multiple errors collected by a [`crate::Validator`].
  #[error("multiple errors:\n{}", format_errors(.0))]
  Multiple(Vec<FolderError>),
}

fn format_errors(errors: &[FolderError]) -> String {
  errors
    .iter()
    .map(|e| format!("  - {}", e))
    .collect::<Vec<_>>()
    .join("\n")
}

/// Kind of node a path refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
  File,
  Folder,
  Symlink,
}

impl std::fmt::Display for NodeKind {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      NodeKind::File => write!(f, "file"),
      NodeKind::Folder => write!(f, "folder"),
      NodeKind::Symlink => write!(f, "symlink"),
    }
  }
}

impl FolderError {
  pub fn missing_file(path: impl Into<PathBuf>) -> Self {
    Self::Missing {
      path: path.into(),
      expected: NodeKind::File,
    }
  }

  pub fn missing_folder(path: impl Into<PathBuf>) -> Self {
    Self::Missing {
      path: path.into(),
      expected: NodeKind::Folder,
    }
  }

  pub fn expected_file_found_folder(path: impl Into<PathBuf>) -> Self {
    Self::WrongKind {
      path: path.into(),
      expected: NodeKind::File,
      found: NodeKind::Folder,
    }
  }

  pub fn expected_folder_found_file(path: impl Into<PathBuf>) -> Self {
    Self::WrongKind {
      path: path.into(),
      expected: NodeKind::Folder,
      found: NodeKind::File,
    }
  }

  /// Construct a tier-2 invariant failure for a [`crate::ValidateFolder`]
  /// implementation.
  pub fn invariant(path: impl Into<PathBuf>, message: impl Into<String>) -> Self {
    Self::Invariant {
      path: path.into(),
      message: message.into(),
    }
  }

  /// All paths flagged as `Missing` in this error tree.
  pub fn missing_paths(&self) -> Vec<&Path> {
    match self {
      FolderError::Missing { path, .. } => vec![path.as_path()],
      FolderError::Multiple(errors) => errors.iter().flat_map(|e| e.missing_paths()).collect(),
      _ => vec![],
    }
  }

  /// Flatten nested [`FolderError::Multiple`]s into their leaf errors.
  pub fn leaves(&self) -> Vec<&FolderError> {
    match self {
      FolderError::Multiple(errors) => errors.iter().flat_map(|e| e.leaves()).collect(),
      leaf => vec![leaf],
    }
  }

  pub fn has_missing(&self) -> bool {
    match self {
      FolderError::Missing { .. } => true,
      FolderError::Multiple(errors) => errors.iter().any(|e| e.has_missing()),
      _ => false,
    }
  }

  /// Collapse a vector of errors into a single error.
  ///
  /// - `[]` → `None`
  /// - `[e]` → `Some(e)`
  /// - `[a, b, ...]` → `Some(FolderError::Multiple(...))`
  pub fn combine(errors: Vec<FolderError>) -> Option<Self> {
    match errors.len() {
      0 => None,
      1 => errors.into_iter().next(),
      _ => Some(FolderError::Multiple(errors)),
    }
  }
}
