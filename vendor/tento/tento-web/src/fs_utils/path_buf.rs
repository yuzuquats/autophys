use actix_web::{ResponseError, http::StatusCode};
use derive_more::Display;
use std::{
  path::{Component, Path, PathBuf},
  str::FromStr,
};

#[derive(Debug, PartialEq, Eq, Display)]
#[non_exhaustive]
pub enum UriSegmentError {
  /// Segment started with the wrapped invalid character.
  #[display("segment started with invalid character: ('{_0}')")]
  BadStart(char),

  /// Segment contained the wrapped invalid character.
  #[display("segment contained invalid character ('{_0}')")]
  BadChar(char),

  /// Segment ended with the wrapped invalid character.
  #[display("segment ended with invalid character: ('{_0}')")]
  BadEnd(char),

  /// Path is not a valid UTF-8 string after percent-decoding.
  #[display("path is not a valid UTF-8 string after percent-decoding")]
  NotValidUtf8,
}

impl ResponseError for UriSegmentError {
  /// Returns `400 Bad Request`.
  fn status_code(&self) -> StatusCode {
    StatusCode::BAD_REQUEST
  }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PathBufWrap(PathBuf);

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

    // equivalent to `path.split('/').count()`
    let mut segment_count = path.matches('/').count() + 1;

    // we can decode the whole path here (instead of per-segment decoding)
    // because we will reject `%2F` in paths using `segment_count`.
    let path = percent_encoding::percent_decode_str(path)
      .decode_utf8()
      .map_err(|_| UriSegmentError::NotValidUtf8)?;

    // disallow decoding `%2F` into `/`
    if segment_count != path.matches('/').count() + 1 {
      return Err(UriSegmentError::BadChar('/'));
    }

    for segment in path.split('/') {
      if segment == ".." {
        segment_count -= 1;
        buf.pop();
      } else if !hidden_files && segment.starts_with('.') {
        return Err(UriSegmentError::BadStart('.'));
      } else if segment.starts_with('*') {
        return Err(UriSegmentError::BadStart('*'));
      } else if segment.ends_with(':') {
        return Err(UriSegmentError::BadEnd(':'));
      } else if segment.ends_with('>') {
        return Err(UriSegmentError::BadEnd('>'));
      } else if segment.ends_with('<') {
        return Err(UriSegmentError::BadEnd('<'));
      } else if segment.is_empty() {
        segment_count -= 1;
        continue;
      } else if cfg!(windows) && segment.contains('\\') {
        return Err(UriSegmentError::BadChar('\\'));
      } else if cfg!(windows) && segment.contains(':') {
        return Err(UriSegmentError::BadChar(':'));
      } else {
        buf.push(segment)
      }
    }

    // make sure we agree with stdlib parser
    for (i, component) in buf.components().enumerate() {
      assert!(
        matches!(component, Component::Normal(_)),
        "component `{:?}` is not normal",
        component
      );
      assert!(i < segment_count);
    }

    Ok(PathBufWrap(buf))
  }
}

impl AsRef<Path> for PathBufWrap {
  fn as_ref(&self) -> &Path {
    self.0.as_ref()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_path_buf() {
    assert_eq!(
      PathBufWrap::from_str("/test/.tt").map(|t| t.0),
      Err(UriSegmentError::BadStart('.'))
    );
    assert_eq!(
      PathBufWrap::from_str("/test/*tt").map(|t| t.0),
      Err(UriSegmentError::BadStart('*'))
    );
    assert_eq!(
      PathBufWrap::from_str("/test/tt:").map(|t| t.0),
      Err(UriSegmentError::BadEnd(':'))
    );
    assert_eq!(
      PathBufWrap::from_str("/test/tt<").map(|t| t.0),
      Err(UriSegmentError::BadEnd('<'))
    );
    assert_eq!(
      PathBufWrap::from_str("/test/tt>").map(|t| t.0),
      Err(UriSegmentError::BadEnd('>'))
    );
    assert_eq!(
      PathBufWrap::from_str("/seg1/seg2/").unwrap().0,
      PathBuf::from_iter(vec!["seg1", "seg2"])
    );
    assert_eq!(
      PathBufWrap::from_str("/seg1/../seg2/").unwrap().0,
      PathBuf::from_iter(vec!["seg2"])
    );
  }

  #[test]
  fn test_parse_path() {
    assert_eq!(
      PathBufWrap::parse_path("/test/.tt", false).map(|t| t.0),
      Err(UriSegmentError::BadStart('.'))
    );

    assert_eq!(
      PathBufWrap::parse_path("/test/.tt", true).unwrap().0,
      PathBuf::from_iter(vec!["test", ".tt"])
    );
  }

  #[test]
  fn path_traversal() {
    assert_eq!(
      PathBufWrap::parse_path("/../README.md", false).unwrap().0,
      PathBuf::from_iter(vec!["README.md"])
    );

    assert_eq!(
      PathBufWrap::parse_path("/../README.md", true).unwrap().0,
      PathBuf::from_iter(vec!["README.md"])
    );

    assert_eq!(
      PathBufWrap::parse_path("/../../../../../../../../../../etc/passwd", false)
        .unwrap()
        .0,
      PathBuf::from_iter(vec!["etc/passwd"])
    );
  }

  #[test]
  #[cfg_attr(windows, should_panic)]
  fn windows_drive_traversal() {
    // detect issues in windows that could lead to path traversal
    // see <https://github.com/SergioBenitez/Rocket/issues/1949

    assert_eq!(
      PathBufWrap::parse_path("C:test.txt", false).unwrap().0,
      PathBuf::from_iter(vec!["C:test.txt"])
    );

    assert_eq!(
      PathBufWrap::parse_path("C:../whatever", false).unwrap().0,
      PathBuf::from_iter(vec!["C:../whatever"])
    );

    assert_eq!(
      PathBufWrap::parse_path(":test.txt", false).unwrap().0,
      PathBuf::from_iter(vec![":test.txt"])
    );
  }
}
