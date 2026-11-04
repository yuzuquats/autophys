//! Basic example showing successful parsing and error display.
//!
//! Run with: cargo run -p tento_env --example basic

use std::fmt::{self, Display};
use std::path::PathBuf;

use tento_env::{Env, EnvError, EnvGroupBuilder, EnvGroupResult, FromEnvVar, ParseEnvValue};

#[derive(Debug, Clone)]
struct DatabaseUrl(String);

impl Display for DatabaseUrl {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}", self.0)
  }
}

impl FromEnvVar for DatabaseUrl {
  const KEY: &'static str = "DATABASE_URL";

  fn parse_value(s: &str) -> Result<Self, EnvError> {
    Ok(DatabaseUrl(s.to_string()))
  }
}

#[derive(Debug, Clone)]
struct Port(u16);

impl Display for Port {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}", self.0)
  }
}

impl FromEnvVar for Port {
  const KEY: &'static str = "PORT";

  fn parse_value(s: &str) -> Result<Self, EnvError> {
    let val = u16::parse_env_value(Self::KEY, s)?;
    Ok(Port(val))
  }
}

#[derive(Debug, Clone)]
struct LonaJs(PathBuf);

impl Display for LonaJs {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}", self.0.display())
  }
}

impl FromEnvVar for LonaJs {
  const KEY: &'static str = "LONA_JS";

  fn parse_value(s: &str) -> Result<Self, EnvError> {
    Ok(LonaJs(PathBuf::from(s)))
  }
}

#[allow(dead_code)]
#[derive(Debug)]
struct AppConfig {
  database_url: Env<DatabaseUrl>,
  port: Env<Port>,
  lona_js: Env<LonaJs>,
  debug_mode: Option<bool>,
}

impl AppConfig {
  fn from_env() -> EnvGroupResult<Self> {
    let mut builder = EnvGroupBuilder::new();

    let db = builder.require(
      "DATABASE_URL",
      DatabaseUrl::from_env().map(|e| e.into_value()),
    );
    let port = builder.require("PORT", Port::from_env().map(|e| e.into_value()));
    let lona_js = builder.require("LONA_JS", LonaJs::from_env().map(|e| e.into_value()));
    let debug = builder.optional("DEBUG_MODE", load_bool("DEBUG_MODE"));

    builder.finish(|| {
      Some(AppConfig {
        database_url: Env::new("DATABASE_URL", db.clone()?),
        port: Env::new("PORT", port.clone()?),
        lona_js: Env::new("LONA_JS", lona_js.clone()?),
        debug_mode: debug,
      })
    })
  }
}

fn load_bool(key: &'static str) -> Result<bool, EnvError> {
  match std::env::var(key) {
    Ok(s) => bool::parse_env_value(key, &s),
    Err(std::env::VarError::NotPresent) => Err(EnvError::missing(key)),
    Err(_) => Err(EnvError::parse(key, "<invalid>", "bool")),
  }
}

fn main() {
  // SAFETY: Example code, single-threaded
  unsafe {
    std::env::set_var("DATABASE_URL", "postgres://localhost/mydb");
    std::env::set_var("PORT", "8080");
    std::env::set_var("LONA_JS", "/home/user/lona-js");
    std::env::set_var("DEBUG_MODE", "true");
  }

  let config = AppConfig::from_env().assert_envars();
  eprintln!("{:?}", config);

  // Cleanup
  unsafe {
    std::env::remove_var("DATABASE_URL");
    std::env::remove_var("PORT");
    std::env::remove_var("LONA_JS");
    std::env::remove_var("DEBUG_MODE");
  }
}
