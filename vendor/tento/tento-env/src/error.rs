use std::fmt::{self, Display, Formatter};

use colored::Colorize;

/// Represents a single environment variable error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvError {
  /// Environment variable not found.
  Missing { key: &'static str },

  /// Environment variable found but couldn't be parsed.
  Parse {
    key: &'static str,
    value: String,
    expected_type: &'static str,
  },
}

impl EnvError {
  /// Create a new Missing error.
  pub fn missing(key: &'static str) -> Self {
    EnvError::Missing { key }
  }

  /// Create a new Parse error.
  pub fn parse(key: &'static str, value: impl Into<String>, expected_type: &'static str) -> Self {
    EnvError::Parse {
      key,
      value: value.into(),
      expected_type,
    }
  }

  /// Get the key associated with this error.
  pub fn key(&self) -> &'static str {
    match self {
      EnvError::Missing { key } => key,
      EnvError::Parse { key, .. } => key,
    }
  }

  /// Returns true if this error is a Missing error.
  pub fn is_missing(&self) -> bool {
    matches!(self, EnvError::Missing { .. })
  }

  /// Format this error with colors for terminal output.
  pub fn fmt_colored(&self) -> String {
    match self {
      EnvError::Missing { key } => {
        format!("{}: {}", key.green(), "missing".red())
      }
      EnvError::Parse {
        key,
        value,
        expected_type,
      } => {
        format!(
          "{}: {} (expected: {})",
          key.green(),
          format!("\"{}\"", value).yellow(),
          expected_type
        )
      }
    }
  }
}

impl Display for EnvError {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    match self {
      EnvError::Missing { key } => write!(f, "{}: missing", key),
      EnvError::Parse {
        key,
        value,
        expected_type,
      } => write!(f, "{}: \"{}\" (expected: {})", key, value, expected_type),
    }
  }
}

impl std::error::Error for EnvError {}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_missing_display() {
    let err = EnvError::missing("DATABASE_URL");
    assert_eq!(format!("{}", err), "DATABASE_URL: missing");
  }

  #[test]
  fn test_parse_display() {
    let err = EnvError::parse("PORT", "abc", "u16");
    assert_eq!(format!("{}", err), "PORT: \"abc\" (expected: u16)");
  }

  #[test]
  fn test_error_key() {
    let missing = EnvError::missing("FOO");
    assert_eq!(missing.key(), "FOO");

    let parse = EnvError::parse("BAR", "invalid", "bool");
    assert_eq!(parse.key(), "BAR");
  }
}
