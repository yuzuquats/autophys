use std::io;
use std::path::{Path, PathBuf};

/// File-kind hint for validation and tooling.
///
/// Deliberately short: tento-folder knows *structure*, not
/// serialization formats. A file whose bytes have a content contract
/// is `Opaque` here, and the contract lives in its
/// [`FileContent`](crate::FileContent) impl.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
  Text,
  Binary,
  /// Shell script — builder writes mode 0755.
  Shell,
  /// A file whose content contract belongs to its declared filetype —
  /// what any `File<C>` / `Valid<File<C>>` / `Unchecked<File<C>>`
  /// entry contributes. Structure only (exists + is a file); the bytes
  /// are checked by `C::parse`, at handle construction (`File<C>`), at
  /// tier-1 through the schema entry's `check` hook
  /// (`Valid<File<C>>`), or never (`Unchecked<File<C>>`).
  Opaque,
}

/// A validated file that exists on disk.
#[derive(Debug, Clone)]
pub struct FileNode {
  path: PathBuf,
  file_type: FileType,
}

impl FileNode {
  pub fn new(path: PathBuf, file_type: FileType) -> Self {
    Self { path, file_type }
  }

  pub fn path(&self) -> &Path {
    &self.path
  }

  pub fn file_type(&self) -> FileType {
    self.file_type
  }

  pub fn exists(&self) -> bool {
    self.path.is_file()
  }

  pub fn read_to_string(&self) -> io::Result<String> {
    std::fs::read_to_string(&self.path)
  }

  pub fn read_bytes(&self) -> io::Result<Vec<u8>> {
    std::fs::read(&self.path)
  }
}

/// A validated folder that exists on disk.
#[derive(Debug, Clone)]
pub struct FolderNode {
  path: PathBuf,
}

impl FolderNode {
  pub fn new(path: PathBuf) -> Self {
    Self { path }
  }

  pub fn path(&self) -> &Path {
    &self.path
  }

  pub fn join(&self, name: impl AsRef<Path>) -> PathBuf {
    self.path.join(name)
  }

  pub fn exists(&self) -> bool {
    self.path.is_dir()
  }

  pub fn children(&self) -> io::Result<Vec<PathBuf>> {
    let mut children = Vec::new();
    for entry in std::fs::read_dir(&self.path)? {
      children.push(entry?.path());
    }
    Ok(children)
  }
}
