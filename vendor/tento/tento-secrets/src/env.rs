//! Minimal `.env` parser for bootstrapping secret values.

use std::collections::HashMap;

use anyhow::Result;

/// Parse a `.env` file into a `KEY -> VALUE` map. See [`parse_str`] for the
/// accepted syntax. Values stay in memory — never logged, never on a command
/// line.
pub fn parse_file(path: &str) -> Result<HashMap<String, String>> {
  let raw =
    std::fs::read_to_string(path).map_err(|e| anyhow::anyhow!("read env file {path}: {e}"))?;
  Ok(parse_str(&raw))
}

/// Parse `.env` text: `KEY=VALUE` per line. Skips blank lines and `#`
/// comments, tolerates a leading `export `, and strips one layer of matching
/// surrounding quotes from the value.
pub fn parse_str(raw: &str) -> HashMap<String, String> {
  let mut map = HashMap::new();
  for line in raw.lines() {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
      continue;
    }
    let line = line.strip_prefix("export ").unwrap_or(line);
    let Some((key, value)) = line.split_once('=') else {
      continue;
    };
    let key = key.trim().to_string();
    if key.is_empty() {
      continue;
    }
    let value = value.trim();
    let value = value
      .strip_prefix('"')
      .and_then(|v| v.strip_suffix('"'))
      .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
      .unwrap_or(value)
      .to_string();
    map.insert(key, value);
  }
  map
}

#[cfg(test)]
mod tests {
  use super::parse_str;

  #[test]
  fn parses_env_with_comments_export_and_quotes() {
    let raw = "# comment\n\nAPI_KEY=plain\nexport DB_URL=\"quoted value\"\nTOKEN='single'\nBARE=  spaced  \nNOEQ\n";
    let env = parse_str(raw);
    assert_eq!(env.get("API_KEY").unwrap(), "plain");
    assert_eq!(env.get("DB_URL").unwrap(), "quoted value");
    assert_eq!(env.get("TOKEN").unwrap(), "single");
    assert_eq!(env.get("BARE").unwrap(), "spaced");
    assert!(!env.contains_key("NOEQ"));
  }
}
