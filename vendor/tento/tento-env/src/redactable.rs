use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};

/// Trait for types that can be redacted when displayed.
///
/// Implementors define how the type should be formatted when
/// its value should be hidden (redacted) vs shown (unredacted).
pub trait Redactable: Display {
  /// Format the value in its redacted form.
  fn redacted_fmt(&self, f: &mut Formatter<'_>) -> fmt::Result;

  /// Format the value in its unredacted (full) form.
  fn unredacted_fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    Display::fmt(self, f)
  }
}

impl Redactable for String {
  fn redacted_fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    let preview: String = self.chars().take(4).collect();
    let suffix = if self.len() > 4 { "..." } else { "" };
    write!(f, "{}{}", preview, suffix)
  }
}

impl Redactable for bool {
  fn redacted_fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "<bool>")
  }
}

impl Redactable for i32 {
  fn redacted_fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "<i32>")
  }
}

impl Redactable for i64 {
  fn redacted_fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "<i64>")
  }
}

impl Redactable for u32 {
  fn redacted_fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "<u32>")
  }
}

impl Redactable for u64 {
  fn redacted_fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "<u64>")
  }
}

/// A wrapper type that redacts its inner value when displayed or debugged.
///
/// Use this to wrap secret values (API keys, tokens, passwords) to prevent
/// accidental logging of sensitive data.
///
/// # Example
/// ```
/// use tento_env::Redacted;
///
/// let secret: Redacted<String> = Redacted::new("my_super_secret_key".into());
///
/// // Display and Debug show redacted form
/// assert_eq!(format!("{}", secret), "redacted[\"my_s...\"]");
/// assert_eq!(format!("{:?}", secret), "redacted[\"my_s...\"]");
///
/// // Extract the actual secret when needed
/// assert_eq!(secret.extract_secret(), "my_super_secret_key");
/// ```
#[derive(Serialize, Deserialize)]
#[serde(transparent)]
pub struct Redacted<T>
where
  T: Redactable,
{
  value: T,
}

impl<T: Redactable> Redacted<T> {
  /// Create a new Redacted wrapper around a value.
  pub fn new(value: T) -> Self {
    Redacted { value }
  }

  /// Extract a reference to the inner secret value.
  pub fn extract_secret(&self) -> &T {
    &self.value
  }

  /// Consume the wrapper and return the inner secret value.
  pub fn into_inner(self) -> T {
    self.value
  }
}

impl<T: Redactable> Display for Redacted<T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "redacted[\"")?;
    self.value.redacted_fmt(f)?;
    write!(f, "\"]")
  }
}

impl<T: Redactable> fmt::Debug for Redacted<T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    Display::fmt(self, f)
  }
}

impl<T: Redactable + Clone> Clone for Redacted<T> {
  fn clone(&self) -> Self {
    Redacted {
      value: self.value.clone(),
    }
  }
}

impl<T: Redactable + PartialEq> PartialEq for Redacted<T> {
  fn eq(&self, other: &Self) -> bool {
    self.value == other.value
  }
}

impl<T: Redactable + Eq> Eq for Redacted<T> {}

impl<T: Redactable + Default> Default for Redacted<T> {
  fn default() -> Self {
    Redacted {
      value: T::default(),
    }
  }
}

impl<T: Redactable> From<T> for Redacted<T> {
  fn from(value: T) -> Self {
    Redacted::new(value)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_string_redaction() {
    let secret: Redacted<String> = Redacted::new("my_super_secret_key".into());

    assert_eq!(format!("{}", secret), "redacted[\"my_s...\"]");
    assert_eq!(format!("{:?}", secret), "redacted[\"my_s...\"]");
    assert_eq!(secret.extract_secret(), "my_super_secret_key");
  }

  #[test]
  fn test_short_string_redaction() {
    let secret: Redacted<String> = Redacted::new("abc".into());

    assert_eq!(format!("{}", secret), "redacted[\"abc\"]");
  }

  #[test]
  fn test_primitive_redaction() {
    let n: Redacted<i32> = Redacted::new(42);
    assert_eq!(format!("{}", n), "redacted[\"<i32>\"]");
    assert_eq!(*n.extract_secret(), 42);

    let b: Redacted<bool> = Redacted::new(true);
    assert_eq!(format!("{}", b), "redacted[\"<bool>\"]");
    assert_eq!(*b.extract_secret(), true);
  }

  #[test]
  fn test_into_inner() {
    let secret: Redacted<String> = Redacted::new("secret".into());
    let inner = secret.into_inner();
    assert_eq!(inner, "secret");
  }

  #[test]
  fn test_from_impl() {
    let secret: Redacted<String> = "my_secret".to_string().into();
    assert_eq!(secret.extract_secret(), "my_secret");
  }

  #[test]
  fn test_equality() {
    let a: Redacted<String> = Redacted::new("secret".into());
    let b: Redacted<String> = Redacted::new("secret".into());
    let c: Redacted<String> = Redacted::new("other".into());

    assert_eq!(a, b);
    assert_ne!(a, c);
  }

  #[test]
  fn test_clone() {
    let a: Redacted<String> = Redacted::new("secret".into());
    let b = a.clone();
    assert_eq!(a, b);
  }

  #[test]
  fn test_serde_roundtrip() {
    let secret: Redacted<String> = Redacted::new("my_api_key".into());
    let json = serde_json::to_string(&secret).unwrap();
    assert_eq!(json, "\"my_api_key\"");

    let parsed: Redacted<String> = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.extract_secret(), "my_api_key");
  }
}
