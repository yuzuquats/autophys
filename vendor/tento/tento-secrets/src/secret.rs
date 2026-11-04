//! `Secret<T>` — a tainted value. The wrapper is the in-process half of the
//! design's taint depth 2: a secret can be *used* (handed to a child env, a
//! file, a cipher) but never *shown* by accident. `Debug` and `Display` are
//! redacted, the bytes are zeroed on drop, and the only way to the plaintext
//! is an explicit [`Secret::expose`] call that reads as such at the call site.

use std::fmt;

use zeroize::Zeroize;

/// A value that must not leak through tsh's own sinks.
pub struct Secret<T: Zeroize + Default>(T);

impl<T: Zeroize + Default> Secret<T> {
  pub fn new(value: T) -> Self {
    Secret(value)
  }

  /// Borrow the plaintext. Named so a grep for `expose(` finds every sink.
  pub fn expose(&self) -> &T {
    &self.0
  }

  /// Consume the wrapper and take the plaintext (e.g. to hand to a cipher).
  /// The wrapper's drop then zeroes only the empty placeholder.
  pub fn into_inner(mut self) -> T {
    std::mem::take(&mut self.0)
  }
}

impl<T: Zeroize + Default> Drop for Secret<T> {
  fn drop(&mut self) {
    self.0.zeroize();
  }
}

impl<T: Zeroize + Default> fmt::Debug for Secret<T> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("Secret([REDACTED])")
  }
}

impl<T: Zeroize + Default> fmt::Display for Secret<T> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("[REDACTED]")
  }
}

impl<T: Zeroize + Default> From<T> for Secret<T> {
  fn from(value: T) -> Self {
    Secret(value)
  }
}

/// The common payload: raw secret bytes.
pub type SecretBytes = Secret<Vec<u8>>;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn debug_and_display_never_show_the_value() {
    let s: SecretBytes = Secret::new(b"hunter2".to_vec());
    assert_eq!(format!("{s:?}"), "Secret([REDACTED])");
    assert_eq!(format!("{s}"), "[REDACTED]");
    assert_eq!(s.expose(), b"hunter2");
    assert_eq!(s.into_inner(), b"hunter2".to_vec());
  }
}
