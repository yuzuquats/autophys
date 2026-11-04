//! Path-traversal-guarded request path parsing. Lived in `tento-core` until
//! 2026-09-15; its one `actix_web::ResponseError` impl was the only reason
//! tento-core linked actix (dependency doctrine rule 1).

use actix_web::{ResponseError, http::StatusCode};
use std::{
  path::{Path, PathBuf},
  str::FromStr,
};

#[derive(Debug, PartialEq, Eq)]
pub enum UriSegmentError {
  /// Segment started with the wrapped invalid character.
  BadStart(char),

  /// Segment contained the wrapped invalid character.
  BadChar(char),

  /// Segment ended with the wrapped invalid character.
  BadEnd(char),

  /// Path is not a valid UTF-8 string after percent-decoding.
  NotValidUtf8,
}

impl std::fmt::Display for UriSegmentError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      UriSegmentError::BadStart(c) => {
        write!(f, "segment started with invalid character: ('{}')", c)
      }
      UriSegmentError::BadChar(c) => write!(f, "segment contained invalid character ('{}')", c),
      UriSegmentError::BadEnd(c) => write!(f, "segment ended with invalid character: ('{}')", c),
      UriSegmentError::NotValidUtf8 => {
        write!(f, "path is not a valid UTF-8 string after percent-decoding")
      }
    }
  }
}

impl std::error::Error for UriSegmentError {}

impl ResponseError for UriSegmentError {
  /// Returns `400 Bad Request`.
  fn status_code(&self) -> StatusCode {
    StatusCode::BAD_REQUEST
  }
}

#[derive(Debug, PartialEq, Eq)]
pub struct PathBufWrap(PathBuf);

impl FromStr for PathBufWrap {
  type Err = UriSegmentError;

  fn from_str(path: &str) -> Result<Self, Self::Err> {
    Self::parse_path(path, false)
  }
}

impl PathBufWrap {
  /// Parse a path, giving the choice of allowing hidden files to be considered valid segments.
  ///
  /// Path traversal is guarded by this method.
  pub fn parse_path(path: &str, hidden_files: bool) -> Result<Self, UriSegmentError> {
    let mut buf = PathBuf::new();

    for segment in path.split('/') {
      if segment.is_empty() {
        continue;
      } else if segment == ".." {
        buf.pop();
      } else if segment.starts_with('.') && !hidden_files {
        return Err(UriSegmentError::BadStart('.'));
      } else if segment.starts_with('*') {
        return Err(UriSegmentError::BadStart('*'));
      } else if segment.ends_with(':') {
        return Err(UriSegmentError::BadEnd(':'));
      } else if segment.ends_with('>') {
        return Err(UriSegmentError::BadEnd('>'));
      } else if segment.ends_with('<') {
        return Err(UriSegmentError::BadEnd('<'));
      } else if segment.contains('\\') {
        return Err(UriSegmentError::BadChar('\\'));
      } else if cfg!(windows) && segment.contains(':') {
        return Err(UriSegmentError::BadChar(':'));
      } else {
        buf.push(segment);
      }
    }

    Ok(PathBufWrap(buf))
  }

  pub fn into_inner(self) -> PathBuf {
    self.0
  }
}

impl AsRef<Path> for PathBufWrap {
  fn as_ref(&self) -> &Path {
    self.0.as_ref()
  }
}
