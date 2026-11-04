//! One constructor for every typed glob member.
//!
//! A `"*": Glob<…>` entry admits four typed inner forms — `File<C>`,
//! `module::Folder`, and either of those behind `Valid<…>` / `Unchecked<…>`.
//! They differ in exactly two ways: whether the pattern claims file or
//! directory children, and what constructing a member costs (eager handles
//! load; path-only wrappers just record the path). [`GlobEntry`] states both,
//! so the `folder!` macro's glob walk emits a single branch per entry through
//! this trait instead of one bespoke code block per grammar form. The untyped
//! members (`Glob<File::Binary>` and friends, bare `Glob<Folder>`) stay
//! outside: their variant lives in a runtime `FileType` VALUE on one shared
//! node type, which a per-type associated const cannot carry.

use std::path::{Path, PathBuf};

use crate::error::FolderError;
use crate::file::{FileContent, Typed};
use crate::unchecked::{Checkable, Unchecked};
use crate::valid::Valid;

/// Which directory children a glob entry claims: files or directories.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GlobMatch {
  Files,
  Dirs,
}

impl GlobMatch {
  pub fn matches(self, path: &Path) -> bool {
    match self {
      GlobMatch::Files => path.is_file(),
      GlobMatch::Dirs => path.is_dir(),
    }
  }
}

/// A type that can be one member of a typed glob: it knows which children it
/// claims and how to produce itself for one matched child. Implemented by
/// [`Typed<C>`] (files, eager load), by every `folder!`-generated `Folder`
/// (dirs, construct-only — tier-1 already proved the tree), and by the two
/// path-only wrappers, which inherit `MATCHES` from what they wrap.
pub trait GlobEntry: Sized {
  const MATCHES: GlobMatch;
  fn at(path: PathBuf) -> Result<Self, FolderError>;
}

impl<C: FileContent> GlobEntry for Typed<C> {
  const MATCHES: GlobMatch = GlobMatch::Files;
  fn at(path: PathBuf) -> Result<Self, FolderError> {
    Self::load(path)
  }
}

impl<T: GlobEntry + Checkable> GlobEntry for Valid<T> {
  const MATCHES: GlobMatch = T::MATCHES;
  fn at(path: PathBuf) -> Result<Self, FolderError> {
    Ok(Self::new(path))
  }
}

impl<T: GlobEntry + Checkable> GlobEntry for Unchecked<T> {
  const MATCHES: GlobMatch = T::MATCHES;
  fn at(path: PathBuf) -> Result<Self, FolderError> {
    Ok(Self::new(path))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn glob_match_distinguishes_files_from_dirs() {
    let root = std::env::temp_dir().join(format!("tento_folder_glob_entry_{}", std::process::id()));
    let (file, dir) = (root.join("file.txt"), root.join("dir"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&file, "").unwrap();
    assert!(GlobMatch::Files.matches(&file));
    assert!(!GlobMatch::Files.matches(&dir));
    assert!(GlobMatch::Dirs.matches(&dir));
    assert!(!GlobMatch::Dirs.matches(&file));
    let _ = std::fs::remove_dir_all(&root);
  }
}
