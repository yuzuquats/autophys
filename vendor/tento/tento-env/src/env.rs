use std::fmt::{self, Display, Formatter};
use std::ops::Deref;

use serde::{Deserialize, Serialize};

/// A wrapper that tracks the environment variable key alongside its value.
///
/// Every field in a config struct should be wrapped in `Env<T>` to maintain
/// an audit trail of where values originated from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Env<T> {
  #[serde(skip)]
  key: &'static str,
  value: T,
}

impl<T> Env<T> {
  /// Create a new Env wrapper with the given key and value.
  pub fn new(key: &'static str, value: T) -> Self {
    Env { key, value }
  }

  /// Get the environment variable key.
  pub fn key(&self) -> &'static str {
    self.key
  }

  /// Get a reference to the inner value.
  pub fn value(&self) -> &T {
    &self.value
  }

  /// Consume the wrapper and return the inner value.
  pub fn into_value(self) -> T {
    self.value
  }

  /// Map the inner value to a new type.
  pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Env<U> {
    Env {
      key: self.key,
      value: f(self.value),
    }
  }
}

impl<T> Deref for Env<T> {
  type Target = T;

  fn deref(&self) -> &T {
    &self.value
  }
}

impl<T: Display> Display for Env<T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "{}: {}", self.key, self.value)
  }
}

impl<T> Env<Option<T>> {
  /// Format the optional value for audit trail output.
  pub fn display_opt(&self) -> EnvOptDisplay<'_, T> {
    EnvOptDisplay { env: self }
  }
}

/// Display helper for `Env<Option<T>>`.
pub struct EnvOptDisplay<'a, T> {
  env: &'a Env<Option<T>>,
}

impl<T: Display> Display for EnvOptDisplay<'_, T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    match &self.env.value {
      Some(v) => write!(f, "{}: {}", self.env.key, v),
      None => write!(f, "{}: <not set>", self.env.key),
    }
  }
}

impl<T: Default> Default for Env<T> {
  fn default() -> Self {
    Env {
      key: "",
      value: T::default(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_env_new() {
    let env: Env<String> = Env::new("DATABASE_URL", "postgres://localhost".to_string());
    assert_eq!(env.key(), "DATABASE_URL");
    assert_eq!(env.value(), "postgres://localhost");
  }

  #[test]
  fn test_env_deref() {
    let env: Env<String> = Env::new("PORT", "8080".to_string());
    // Deref allows using &Env<String> as &String
    let s: &str = &env;
    assert_eq!(s, "8080");
  }

  #[test]
  fn test_env_display() {
    let env: Env<String> = Env::new("ACME_JS", "/path/to/acme-js".to_string());
    assert_eq!(format!("{}", env), "ACME_JS: /path/to/acme-js");
  }

  #[test]
  fn test_env_option_display_some() {
    let env: Env<Option<String>> = Env::new("DEBUG_MODE", Some("true".to_string()));
    assert_eq!(format!("{}", env.display_opt()), "DEBUG_MODE: true");
  }

  #[test]
  fn test_env_option_display_none() {
    let env: Env<Option<String>> = Env::new("TEST_OPT", None);
    assert_eq!(format!("{}", env.display_opt()), "TEST_OPT: <not set>");
  }

  #[test]
  fn test_env_into_value() {
    let env: Env<u16> = Env::new("PORT", 8080);
    let port: u16 = env.into_value();
    assert_eq!(port, 8080);
  }

  #[test]
  fn test_env_map() {
    let env: Env<String> = Env::new("PORT", "8080".to_string());
    let mapped: Env<usize> = env.map(|s| s.len());
    assert_eq!(mapped.key(), "PORT");
    assert_eq!(*mapped, 4);
  }
}
