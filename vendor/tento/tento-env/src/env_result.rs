use std::fmt::{self, Display, Formatter};

use crate::{Env, EnvError};

/// Result type that discriminates between three states for environment variables:
/// - **Present**: Variable loaded and parsed successfully
/// - **Missing**: Variable not set in environment
/// - **Malformed**: Variable set but failed to parse
///
/// This enables explicit handling where "not set" may be acceptable but
/// "set but invalid" is always an error.
///
/// # Example
/// ```ignore
/// use tento_env::{env_kv, EnvResult, FromEnvVar};
///
/// env_kv!("CACHE_URL", String);
///
/// let result: EnvResult<CacheUrl> = CacheUrl::from_env().into();
/// match result {
///   EnvResult::Present(env) => println!("Using cache: {}", env.value()),
///   EnvResult::Missing { key } => println!("{} not set, caching disabled", key),
///   EnvResult::Malformed(err) => panic!("Invalid cache config: {}", err),
/// }
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvResult<T> {
  /// Variable successfully loaded and parsed.
  Present(Env<T>),

  /// Variable not set in environment.
  Missing { key: &'static str },

  /// Variable set but failed to parse.
  Malformed(EnvError),
}

impl<T> EnvResult<T> {
  /// Returns `true` if the result is `Present`.
  pub fn is_present(&self) -> bool {
    matches!(self, EnvResult::Present(_))
  }

  /// Returns `true` if the result is `Missing`.
  pub fn is_missing(&self) -> bool {
    matches!(self, EnvResult::Missing { .. })
  }

  /// Returns `true` if the result is `Malformed`.
  pub fn is_malformed(&self) -> bool {
    matches!(self, EnvResult::Malformed(_))
  }

  /// Get a reference to the value if present.
  pub fn value(&self) -> Option<&T> {
    match self {
      EnvResult::Present(env) => Some(env.value()),
      _ => None,
    }
  }

  /// Get a reference to the Env wrapper if present.
  pub fn env(&self) -> Option<&Env<T>> {
    match self {
      EnvResult::Present(env) => Some(env),
      _ => None,
    }
  }

  /// Get the key for this result.
  pub fn key(&self) -> &'static str {
    match self {
      EnvResult::Present(env) => env.key(),
      EnvResult::Missing { key } => key,
      EnvResult::Malformed(err) => err.key(),
    }
  }

  /// Convert to Option, treating both Missing and Malformed as None.
  ///
  /// Use this when you want to silently ignore any failure.
  pub fn into_option(self) -> Option<Env<T>> {
    match self {
      EnvResult::Present(env) => Some(env),
      _ => None,
    }
  }

  /// Convert to Result, treating Missing as an error.
  ///
  /// Use this when the variable is required.
  pub fn into_result(self) -> Result<Env<T>, EnvError> {
    match self {
      EnvResult::Present(env) => Ok(env),
      EnvResult::Missing { key } => Err(EnvError::missing(key)),
      EnvResult::Malformed(err) => Err(err),
    }
  }

  /// Get the value if present, treating Missing as None but returning
  /// an error for Malformed.
  ///
  /// Use this for optional fields where "not set" is OK but "invalid" is not.
  pub fn ok_or_malformed(self) -> Result<Option<Env<T>>, EnvError> {
    match self {
      EnvResult::Present(env) => Ok(Some(env)),
      EnvResult::Missing { .. } => Ok(None),
      EnvResult::Malformed(err) => Err(err),
    }
  }

  /// Map the inner value to a new type if present.
  pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> EnvResult<U> {
    match self {
      EnvResult::Present(env) => EnvResult::Present(env.map(f)),
      EnvResult::Missing { key } => EnvResult::Missing { key },
      EnvResult::Malformed(err) => EnvResult::Malformed(err),
    }
  }
}

impl<T> From<Result<Env<T>, EnvError>> for EnvResult<T> {
  fn from(result: Result<Env<T>, EnvError>) -> Self {
    match result {
      Ok(env) => EnvResult::Present(env),
      Err(EnvError::Missing { key }) => EnvResult::Missing { key },
      Err(err) => EnvResult::Malformed(err),
    }
  }
}

impl<T: Display> Display for EnvResult<T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    match self {
      EnvResult::Present(env) => write!(f, "{}", env),
      EnvResult::Missing { key } => write!(f, "{}: <not set>", key),
      EnvResult::Malformed(err) => write!(f, "{}", err),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_present() {
    let env = Env::new("TEST_KEY", "value".to_string());
    let result: EnvResult<String> = EnvResult::Present(env);

    assert!(result.is_present());
    assert!(!result.is_missing());
    assert!(!result.is_malformed());
    assert_eq!(result.value(), Some(&"value".to_string()));
    assert_eq!(result.key(), "TEST_KEY");
  }

  #[test]
  fn test_missing() {
    let result: EnvResult<String> = EnvResult::Missing { key: "MISSING_KEY" };

    assert!(!result.is_present());
    assert!(result.is_missing());
    assert!(!result.is_malformed());
    assert_eq!(result.value(), None);
    assert_eq!(result.key(), "MISSING_KEY");
  }

  #[test]
  fn test_malformed() {
    let err = EnvError::parse("BAD_KEY", "invalid", "u32");
    let result: EnvResult<u32> = EnvResult::Malformed(err);

    assert!(!result.is_present());
    assert!(!result.is_missing());
    assert!(result.is_malformed());
    assert_eq!(result.value(), None);
    assert_eq!(result.key(), "BAD_KEY");
  }

  #[test]
  fn test_from_result_ok() {
    let env = Env::new("TEST", 42u32);
    let result: EnvResult<u32> = Ok(env).into();

    assert!(result.is_present());
    assert_eq!(result.value(), Some(&42));
  }

  #[test]
  fn test_from_result_missing() {
    let err = EnvError::missing("MISSING");
    let result: EnvResult<String> = Err(err).into();

    assert!(result.is_missing());
    assert_eq!(result.key(), "MISSING");
  }

  #[test]
  fn test_from_result_parse_error() {
    let err = EnvError::parse("BAD", "xyz", "i32");
    let result: EnvResult<i32> = Err(err).into();

    assert!(result.is_malformed());
  }

  #[test]
  fn test_into_option() {
    let present: EnvResult<String> = EnvResult::Present(Env::new("K", "v".into()));
    assert!(present.into_option().is_some());

    let missing: EnvResult<String> = EnvResult::Missing { key: "K" };
    assert!(missing.into_option().is_none());

    let malformed: EnvResult<String> = EnvResult::Malformed(EnvError::parse("K", "x", "bool"));
    assert!(malformed.into_option().is_none());
  }

  #[test]
  fn test_into_result() {
    let present: EnvResult<String> = EnvResult::Present(Env::new("K", "v".into()));
    assert!(present.into_result().is_ok());

    let missing: EnvResult<String> = EnvResult::Missing { key: "K" };
    assert!(missing.into_result().is_err());

    let malformed: EnvResult<String> = EnvResult::Malformed(EnvError::parse("K", "x", "bool"));
    assert!(malformed.into_result().is_err());
  }

  #[test]
  fn test_ok_or_malformed() {
    let present: EnvResult<String> = EnvResult::Present(Env::new("K", "v".into()));
    assert!(matches!(present.ok_or_malformed(), Ok(Some(_))));

    let missing: EnvResult<String> = EnvResult::Missing { key: "K" };
    assert!(matches!(missing.ok_or_malformed(), Ok(None)));

    let malformed: EnvResult<String> = EnvResult::Malformed(EnvError::parse("K", "x", "bool"));
    assert!(malformed.ok_or_malformed().is_err());
  }

  #[test]
  fn test_display() {
    let present: EnvResult<String> = EnvResult::Present(Env::new("KEY", "value".into()));
    assert_eq!(format!("{}", present), "KEY: value");

    let missing: EnvResult<String> = EnvResult::Missing { key: "KEY" };
    assert_eq!(format!("{}", missing), "KEY: <not set>");

    let malformed: EnvResult<String> = EnvResult::Malformed(EnvError::parse("KEY", "bad", "u32"));
    assert_eq!(format!("{}", malformed), "KEY: \"bad\" (expected: u32)");
  }

  #[test]
  fn test_map() {
    let present: EnvResult<String> = EnvResult::Present(Env::new("LEN", "hello".into()));
    let mapped = present.map(|s| s.len());
    assert_eq!(mapped.value(), Some(&5));

    let missing: EnvResult<String> = EnvResult::Missing { key: "K" };
    let mapped = missing.map(|s| s.len());
    assert!(mapped.is_missing());
  }
}
