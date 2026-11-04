use anyhow::Context;
use uuid::Uuid;

pub struct PrefixedUuid;

impl PrefixedUuid {
  pub fn parse(prefix: &str, s: &str) -> anyhow::Result<Uuid> {
    if !s.starts_with(prefix) {
      return Uuid::parse_str(s).context("uuid doesn't start with prefix");
    }

    let s = &s[prefix.len()..];
    if s.len() != 32 {
      return Err(anyhow::anyhow!(
        "invalid prefixed uuid length for prefix `{}`: expected 32 chars after prefix, got {}",
        prefix,
        s.len()
      ));
    }

    let formatted_s = format!(
      "{}-{}-{}-{}-{}",
      &s[0..8],
      &s[8..12],
      &s[12..16],
      &s[16..20],
      &s[20..32]
    );

    Uuid::parse_str(&formatted_s).context("uuid invalid")
  }

  pub fn display(id: &Uuid, prefix: &str) -> String {
    // todo: good candidate to speed this up
    //
    let s = id.to_string();
    let parts: Vec<&str> = s.split("-").into_iter().collect();
    format!("{prefix}{}", parts.join(""))
  }
}
