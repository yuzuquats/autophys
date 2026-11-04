//! Package-declared secrets template.
//!
//! A package ships a `secrets.template.toml` inside its bundle declaring the
//! secret keys it requires (names + optional descriptions, never values).
//! Consumers read it to populate a host's required secrets and to drive the
//! `secrets.*` tooling.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

/// Bundle-relative file name of the secrets template.
pub const SECRETS_TEMPLATE_FILE: &str = "secrets.template.toml";

/// Parsed `secrets.template.toml`. Keyed by secret name.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SecretsTemplate {
  #[serde(default)]
  pub secret: BTreeMap<String, SecretDecl>,
}

/// One declared secret. Values are never stored — only metadata.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SecretDecl {
  #[serde(default)]
  pub description: Option<String>,
}

impl SecretsTemplate {
  /// Declared secret keys, sorted (BTreeMap order).
  pub fn keys(&self) -> Vec<String> {
    self.secret.keys().cloned().collect()
  }
}

/// Load + parse `<bundle>/secrets.template.toml`. Returns `None` when the
/// bundle ships no template (declares no secrets).
pub fn load(bundle_path: &Path) -> Result<Option<SecretsTemplate>> {
  let path = bundle_path.join(SECRETS_TEMPLATE_FILE);
  if !path.exists() {
    return Ok(None);
  }
  let raw = std::fs::read_to_string(&path)
    .with_context(|| format!("read secrets template {}", path.display()))?;
  let parsed =
    toml::from_str(&raw).with_context(|| format!("parse secrets template {}", path.display()))?;
  Ok(Some(parsed))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_keys_and_descriptions() {
    let raw = r#"
      [secret.API_KEY]
      description = "the api key"

      [secret.DB_URL]
    "#;
    let t: SecretsTemplate = toml::from_str(raw).unwrap();
    assert_eq!(t.keys(), vec!["API_KEY".to_string(), "DB_URL".to_string()]);
    assert_eq!(
      t.secret["API_KEY"].description.as_deref(),
      Some("the api key")
    );
    assert!(t.secret["DB_URL"].description.is_none());
  }

  #[test]
  fn empty_template_has_no_keys() {
    let t: SecretsTemplate = toml::from_str("").unwrap();
    assert!(t.keys().is_empty());
  }
}
