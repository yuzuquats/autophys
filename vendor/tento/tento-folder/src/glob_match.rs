//! Tiny shell-style glob matcher.
//!
//! Supports `*` (matches zero or more characters) and `?` (matches
//! exactly one character). No character classes, no `**`, no escape
//! sequences. Used by [`crate::Schema::validate_with`] to dispatch
//! `SchemaKind::FolderGlob` / `SchemaKind::FileGlob` entries.
//!
//! If the use case grows beyond `*` / `?`, swap to `globset`.

/// Returns whether `name` matches the shell-style `pattern`.
///
/// - `*` matches any (possibly empty) sequence of characters.
/// - `?` matches exactly one character.
/// - Every other character matches itself.
pub fn matches(pattern: &str, name: &str) -> bool {
  // Classic recursive matcher with backtracking on `*`. Iterative
  // implementation avoids stack issues on long inputs.
  let pat: Vec<char> = pattern.chars().collect();
  let txt: Vec<char> = name.chars().collect();

  let mut pi = 0usize;
  let mut ti = 0usize;
  let mut star_pi: Option<usize> = None;
  let mut star_ti = 0usize;

  while ti < txt.len() {
    if pi < pat.len() && pat[pi] == '*' {
      star_pi = Some(pi);
      star_ti = ti;
      pi += 1;
    } else if pi < pat.len() && (pat[pi] == '?' || pat[pi] == txt[ti]) {
      pi += 1;
      ti += 1;
    } else if let Some(spi) = star_pi {
      pi = spi + 1;
      star_ti += 1;
      ti = star_ti;
    } else {
      return false;
    }
  }

  while pi < pat.len() && pat[pi] == '*' {
    pi += 1;
  }

  pi == pat.len()
}

#[cfg(test)]
mod tests {
  use super::matches;

  #[test]
  fn star_matches_empty() {
    assert!(matches("*", ""));
    assert!(matches("*.app", ".app"));
  }

  #[test]
  fn star_matches_any() {
    assert!(matches("*.app", "ServerApp.app"));
    assert!(matches("*.app", "ServerApp-1.0.0.app"));
    assert!(matches("ServerApp-*", "ServerApp-dev"));
    assert!(matches("ServerApp-*.app", "ServerApp-dev.app"));
  }

  #[test]
  fn star_in_middle() {
    assert!(matches(
      "ServerApp-*.app",
      "ServerApp-1.0.40-7d2cbef-6344b409.app"
    ));
    assert!(matches("ServerApp-*-*.app", "ServerApp-1.0.40-7d2cbef.app"));
  }

  #[test]
  fn multi_star_version_pattern() {
    assert!(matches("ServerApp-1.*.*.app", "ServerApp-1.0.40.app"));
    assert!(matches(
      "ServerApp-1.*.*.app",
      "ServerApp-1.0.40-7d2cbef-6344b409.app"
    ));
    assert!(!matches("ServerApp-1.*.*.app", "ServerApp-2.0.0.app"));
  }

  #[test]
  fn question_matches_single_char() {
    assert!(matches("?ello", "hello"));
    assert!(!matches("?ello", "ello"));
    assert!(!matches("?", ""));
  }

  #[test]
  fn no_wildcard_means_exact() {
    assert!(matches("ServerApp-dev.app", "ServerApp-dev.app"));
    assert!(!matches("ServerApp-dev.app", "ServerApp-latest.app"));
  }

  #[test]
  fn empty_pattern_only_matches_empty() {
    assert!(matches("", ""));
    assert!(!matches("", "x"));
  }
}
