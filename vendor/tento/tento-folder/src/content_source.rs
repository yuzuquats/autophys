use std::io;
use std::path::{Path, PathBuf};

use crate::error::FolderError;

/// Where the content for a folder entry comes from at build time.
///
/// Set on each leaf entry through the builder produced by [`folder!`].
///
/// [`folder!`]: crate::folder
#[derive(Debug, Clone)]
pub enum ContentSource {
  /// Copy the source path to the target. File or directory.
  Copy(PathBuf),
  /// Create a symlink at the target pointing to the source path.
  Symlink(PathBuf),
  /// Write the given bytes to the target.
  Bytes(Vec<u8>),
  /// Touch an empty file or create an empty directory, depending on
  /// the declared kind.
  Empty,
}

impl ContentSource {
  pub fn copy(p: impl Into<PathBuf>) -> Self {
    Self::Copy(p.into())
  }

  pub fn symlink(target: impl Into<PathBuf>) -> Self {
    Self::Symlink(target.into())
  }

  pub fn bytes(b: impl Into<Vec<u8>>) -> Self {
    Self::Bytes(b.into())
  }

  /// Convenience wrapper around [`ContentSource::Bytes`] for string input.
  pub fn write_str(s: impl Into<String>) -> Self {
    Self::Bytes(s.into().into_bytes())
  }

  pub fn empty() -> Self {
    Self::Empty
  }

  /// Apply this content source to create a file at `dest`.
  pub fn apply_file(&self, dest: &Path) -> Result<(), FolderError> {
    let io_err = |source: io::Error| FolderError::Io {
      path: dest.to_path_buf(),
      source,
    };
    match self {
      ContentSource::Copy(src) => {
        std::fs::copy(src, dest).map_err(io_err)?;
      }
      ContentSource::Symlink(target) => {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, dest).map_err(io_err)?;
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(target, dest).map_err(io_err)?;
      }
      ContentSource::Bytes(bytes) => {
        std::fs::write(dest, bytes).map_err(io_err)?;
      }
      ContentSource::Empty => {
        std::fs::write(dest, b"").map_err(io_err)?;
      }
    }
    Ok(())
  }

  /// Apply this content source to create a folder at `dest`.
  pub fn apply_folder(&self, dest: &Path) -> Result<(), FolderError> {
    let io_err = |source: io::Error| FolderError::Io {
      path: dest.to_path_buf(),
      source,
    };
    match self {
      ContentSource::Copy(src) => copy_dir_recursive(src, dest).map_err(io_err)?,
      ContentSource::Symlink(target) => {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, dest).map_err(io_err)?;
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(target, dest).map_err(io_err)?;
      }
      ContentSource::Empty => std::fs::create_dir_all(dest).map_err(io_err)?,
      ContentSource::Bytes(_) => {
        return Err(FolderError::Io {
          path: dest.to_path_buf(),
          source: io::Error::new(
            io::ErrorKind::InvalidInput,
            "cannot write bytes content to a folder",
          ),
        });
      }
    }
    Ok(())
  }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> io::Result<()> {
  if !dest.exists() {
    std::fs::create_dir_all(dest)?;
  }
  for entry in std::fs::read_dir(src)? {
    let entry = entry?;
    let src_path = entry.path();
    let dest_path = dest.join(entry.file_name());
    let file_type = std::fs::symlink_metadata(&src_path)?.file_type();
    if file_type.is_symlink() {
      let target = std::fs::read_link(&src_path)?;
      #[cfg(unix)]
      std::os::unix::fs::symlink(target, &dest_path)?;
      #[cfg(windows)]
      if src_path.is_dir() {
        std::os::windows::fs::symlink_dir(target, &dest_path)?;
      } else {
        std::os::windows::fs::symlink_file(target, &dest_path)?;
      }
    } else if file_type.is_dir() {
      copy_dir_recursive(&src_path, &dest_path)?;
    } else {
      std::fs::copy(&src_path, &dest_path)?;
    }
  }
  Ok(())
}
