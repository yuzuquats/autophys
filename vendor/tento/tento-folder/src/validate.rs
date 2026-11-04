//! Strict-only validation helpers used by [`crate::Schema::validate`]
//! and the macro-emitted `Folder::load`.
//!
//! Lenient mode used to live here; it was removed (zero production
//! consumers). Everything is strict: missing required entries error,
//! wrong-kind clashes error.

use std::path::Path;

use crate::error::FolderError;
use crate::node::{FileNode, FileType, FolderNode};

pub fn validate_file(path: &Path) -> Result<(), FolderError> {
  if !path.exists() {
    return Err(FolderError::missing_file(path));
  }
  if path.is_dir() {
    return Err(FolderError::expected_file_found_folder(path));
  }
  Ok(())
}

pub fn validate_folder(path: &Path) -> Result<(), FolderError> {
  if !path.exists() {
    return Err(FolderError::missing_folder(path));
  }
  if path.is_file() {
    return Err(FolderError::expected_folder_found_file(path));
  }
  Ok(())
}

pub fn load_file_required(path: &Path, file_type: FileType) -> Result<FileNode, FolderError> {
  validate_file(path)?;
  Ok(FileNode::new(path.to_path_buf(), file_type))
}

pub fn load_folder_required(path: &Path) -> Result<FolderNode, FolderError> {
  validate_folder(path)?;
  Ok(FolderNode::new(path.to_path_buf()))
}

/// Collects validation errors during a walk of a [`crate::Schema`].
///
/// The macro-generated `Folder::load` and standalone [`crate::Schema::validate`]
/// both construct a `Validator`, drive validation across every declared
/// entry, and call [`Validator::finish`] to return either `Ok(())` or
/// [`FolderError::Multiple`].
#[derive(Debug, Default)]
pub struct Validator {
  errors: Vec<FolderError>,
}

impl Validator {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn check_file(&mut self, path: &Path) {
    if let Err(e) = validate_file(path) {
      self.errors.push(e);
    }
  }

  pub fn check_folder(&mut self, path: &Path) {
    if let Err(e) = validate_folder(path) {
      self.errors.push(e);
    }
  }

  pub fn load_file_required(&mut self, path: &Path, file_type: FileType) -> Option<FileNode> {
    match load_file_required(path, file_type) {
      Ok(node) => Some(node),
      Err(e) => {
        self.errors.push(e);
        None
      }
    }
  }

  pub fn load_folder_required(&mut self, path: &Path) -> Option<FolderNode> {
    match load_folder_required(path) {
      Ok(node) => Some(node),
      Err(e) => {
        self.errors.push(e);
        None
      }
    }
  }

  pub fn push_error(&mut self, error: FolderError) {
    self.errors.push(error);
  }

  pub fn is_valid(&self) -> bool {
    self.errors.is_empty()
  }

  pub fn finish(self) -> Result<(), FolderError> {
    match FolderError::combine(self.errors) {
      Some(e) => Err(e),
      None => Ok(()),
    }
  }

  pub fn into_errors(self) -> Vec<FolderError> {
    self.errors
  }
}
