use serde::{Deserialize, Serialize};
use std::fmt;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use tento_openapi::ToSchema;

/// A wrapper around a string that may contain characters unsafe for filesystem operations.
///
/// This type is intended to safely handle potentially unsafe user input that will be used
/// in filesystem operations, such as filenames or path components. It provides methods to
/// sanitize the string for various use cases to prevent path traversal attacks and other
/// security issues.
#[derive(Debug, Clone, PartialEq, Eq, Hash, ToSchema)]
pub struct ScaryUserString(String);

impl ScaryUserString {
  /// Creates a new `ScaryUserString` from any type that can be converted into a `String`.
  ///
  /// # Examples
  ///
  /// ```
  /// use tento_core::validate::ScaryUserString;
  ///
  /// let sus = ScaryUserString::new("potentially/unsafe/input.txt");
  /// ```
  pub fn new(s: impl Into<String>) -> Self {
    Self(s.into())
  }

  /// Gets the raw string without any sanitization.
  ///
  /// # Warning
  ///
  /// This method is deliberately named with a long, cautionary name to discourage its use.
  /// In most cases, you should use one of the sanitizing methods instead.
  ///
  /// # Returns
  ///
  /// A reference to the raw, unsanitized string.
  pub fn scary_string_you_probably_dont_need_this(&self) -> &str {
    &self.0
  }

  /// Sanitizes the string for use as a filename by removing path separator characters.
  ///
  /// This method removes slashes, backslashes, and NUL bytes, but does not handle
  /// other potentially problematic characters like colons, question marks, etc.
  /// For more thorough sanitization, use `as_sanitized_path_component`.
  ///
  /// # Returns
  ///
  /// A sanitized string safe to use as a filename.
  ///
  /// # Examples
  ///
  /// ```
  /// use tento_core::validate::ScaryUserString;
  ///
  /// let sus = ScaryUserString::new("file/with/slashes.txt");
  /// assert_eq!(sus.as_sanitized_filename(), "filewithslashes.txt");
  /// ```
  pub fn as_sanitized_filename(&self) -> String {
    // Remove slashes, backslashes, and NUL bytes.
    self
      .0
      .chars()
      .filter(|&c| c != '/' && c != '\\' && c != '\0')
      .collect()
  }

  /// Sanitizes the string for use as a path component, protecting against path traversal.
  ///
  /// This method performs more thorough sanitization than `as_sanitized_filename`:
  /// 1. Removes directory traversal patterns (e.g., "..")
  /// 2. Removes relative path indicators (e.g., "./")
  /// 3. Removes a wide range of characters that are problematic in filesystems
  ///
  /// # Returns
  ///
  /// A sanitized string safe to use as a path component.
  ///
  /// # Examples
  ///
  /// ```
  /// use tento_core::validate::ScaryUserString;
  ///
  /// let sus = ScaryUserString::new("../attempt/to/escape.txt");
  /// assert_eq!(sus.as_sanitized_path_component(), "attempttoescape.txt");
  /// ```
  pub fn as_sanitized_path_component(&self) -> String {
    // Sanitize more thoroughly for path components
    // Remove dangerous path characters and patterns

    // First replace any potential directory traversal patterns with empty strings
    let without_traversal = self
      .0
      .replace("..", "")
      .replace("./", "")
      .replace(".\\", "");

    // Then filter out any dangerous characters
    without_traversal
      .chars()
      .filter(|&c| {
        c != '/'
          && c != '\\'
          && c != '\0'
          && c != ':'
          && c != '*'
          && c != '?'
          && c != '"'
          && c != '<'
          && c != '>'
          && c != '|'
      })
      .collect()
  }

  /// Safely joins this string as a sanitized path component to a base path.
  ///
  /// This method first sanitizes the string using `as_sanitized_path_component`,
  /// then joins it to the base path. This ensures that:
  /// 1. Path traversal attacks are prevented
  /// 2. Invalid characters are removed
  /// 3. The resulting path is a valid child of the base path
  ///
  /// # Parameters
  ///
  /// * `base_path` - The base path to join the sanitized component to
  ///
  /// # Returns
  ///
  /// A `PathBuf` containing the base path joined with the sanitized path component.
  ///
  /// # Examples
  ///
  /// ```
  /// use tento_core::validate::ScaryUserString;
  /// use std::path::Path;
  ///
  /// let sus = ScaryUserString::new("../attempt/to/escape.txt");
  /// let path = sus.join_to_path("/safe/directory");
  /// assert_eq!(path.to_string_lossy(), "/safe/directory/attempttoescape.txt");
  /// ```
  pub fn join_to_path(&self, base_path: impl AsRef<Path>) -> PathBuf {
    let sanitized = self.as_sanitized_path_component();
    let mut path = base_path.as_ref().to_path_buf();
    path.push(sanitized);
    path
  }

  pub fn eqs(&self, s: &str) -> bool {
    self.0 == s
  }
}

/// Implements serialization to JSON as a string.
///
/// The string is serialized as-is without any sanitization.
impl Serialize for ScaryUserString {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    serializer.serialize_str(&self.0)
  }
}

/// Implements deserialization from JSON string.
///
/// This allows `ScaryUserString` to be used with serde_json and other serde-compatible
/// serialization formats.
impl<'de> Deserialize<'de> for ScaryUserString {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    let s = String::deserialize(deserializer)?;
    Ok(Self(s))
  }
}

/// Implements conversion to `&str` reference.
///
/// This allows `ScaryUserString` to be used with functions that accept `AsRef<str>`.
/// Note that this returns the raw, unsanitized string.
impl AsRef<str> for ScaryUserString {
  fn as_ref(&self) -> &str {
    &self.0
  }
}

/// Implements dereferencing to `str`.
///
/// This allows `ScaryUserString` to be used with methods on `str` directly.
/// Note that this returns the raw, unsanitized string.
impl Deref for ScaryUserString {
  type Target = str;

  fn deref(&self) -> &Self::Target {
    &self.0
  }
}

/// Implements string formatting.
///
/// This allows `ScaryUserString` to be used with `format!`, `println!`, etc.
/// Note that this formats the raw, unsanitized string.
impl fmt::Display for ScaryUserString {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}", self.0)
  }
}

/// Implements conversion from `String` to `ScaryUserString`.
///
/// This allows you to use `into()` on a `String` to convert it to a `ScaryUserString`.
impl From<String> for ScaryUserString {
  fn from(s: String) -> Self {
    Self(s)
  }
}

/// Implements conversion from `&str` to `ScaryUserString`.
///
/// This allows you to use `into()` on a `&str` to convert it to a `ScaryUserString`.
impl From<&str> for ScaryUserString {
  fn from(s: &str) -> Self {
    Self(s.to_string())
  }
}
