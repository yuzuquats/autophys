//! Secret addresses: `namespace/name`, both kebab-case. Key families are
//! sibling names (`codex/api-key`, `codex/api-key-work`); a bind table maps an
//! address to the env var a lane wants, so the address never has to look like
//! `OPENAI_API_KEY`.

use std::fmt;

use anyhow::{Result, bail};

/// A validated `namespace/name`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Address {
  namespace: String,
  name: String,
}

fn kebab_ok(s: &str) -> bool {
  !s.is_empty()
    && !s.starts_with('-')
    && !s.ends_with('-')
    && !s.contains("--")
    && s
      .bytes()
      .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl Address {
  /// Parse `ns/name`. Errors teach the shape.
  pub fn parse(raw: &str) -> Result<Address> {
    let Some((ns, name)) = raw.split_once('/') else {
      bail!("secret address `{raw}`: expected `namespace/name` (e.g. deepseek/api-key)");
    };
    if !kebab_ok(ns) || !kebab_ok(name) {
      bail!(
        "secret address `{raw}`: namespace and name are kebab-case (lowercase letters, digits, single dashes)"
      );
    }
    Ok(Address {
      namespace: ns.to_string(),
      name: name.to_string(),
    })
  }

  pub fn namespace(&self) -> &str {
    &self.namespace
  }

  pub fn name(&self) -> &str {
    &self.name
  }
}

impl fmt::Display for Address {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}/{}", self.namespace, self.name)
  }
}

#[cfg(test)]
mod tests {
  use super::Address;

  #[test]
  fn parses_and_rejects() {
    let a = Address::parse("deepseek/api-key").unwrap();
    assert_eq!(a.namespace(), "deepseek");
    assert_eq!(a.name(), "api-key");
    assert_eq!(a.to_string(), "deepseek/api-key");
    for bad in [
      "deepseek",
      "Deep/Seek",
      "a//b",
      "a/-b",
      "a/b--c",
      "/x",
      "x/",
    ] {
      assert!(Address::parse(bad).is_err(), "{bad} should fail");
    }
  }
}
