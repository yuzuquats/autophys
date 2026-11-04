//! Content-format validation for File::Json / File::Toml / File::Yaml.
//!
//! `Schema::validate` calls into this module for each File entry whose
//! kind is `Json`, `Toml`, or `Yaml`. The file is read and the value is
//! parsed through the respective workspace parser; failures bubble up
//! as [`FolderError::Malformed`].
//!
//! No typed deserialization: this layer only confirms the bytes
//! round-trip through a permissive Value parser. Typed-content
//! variants (`File::Json<T>`) are future work.

use std::path::Path;

use crate::error::{ContentKind, FolderError};
use crate::node::FileType;

/// Read `path` and confirm its bytes parse as the given file type's
/// content format. No-op for non-text-content types (Binary, Text,
/// Shell — those are existence-checked only).
pub fn check_well_formed(path: &Path, file_type: FileType) -> Result<(), FolderError> {
  let kind = match file_type {
    FileType::Json => ContentKind::Json,
    FileType::Toml => ContentKind::Toml,
    FileType::Yaml => ContentKind::Yaml,
    FileType::Binary | FileType::Text | FileType::Shell => return Ok(()),
  };

  let contents = std::fs::read_to_string(path).map_err(|source| FolderError::Io {
    path: path.to_path_buf(),
    source,
  })?;

  let parse_result: Result<(), Box<dyn std::error::Error + Send + Sync>> = match kind {
    ContentKind::Json => serde_json::from_str::<serde_json::Value>(&contents)
      .map(|_| ())
      .map_err(|e| Box::new(e) as _),
    ContentKind::Toml => toml::from_str::<toml::Value>(&contents)
      .map(|_| ())
      .map_err(|e| Box::new(e) as _),
    ContentKind::Yaml => serde_yml::from_str::<serde_yml::Value>(&contents)
      .map(|_| ())
      .map_err(|e| Box::new(e) as _),
  };

  parse_result.map_err(|source| FolderError::Malformed {
    path: path.to_path_buf(),
    kind,
    source,
  })
}
