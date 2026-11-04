//! Example demonstrating the FromEnv derive macro.
//!
//! Run with: cargo run -p tento_env --example derive_from_env

use std::path::PathBuf;

use tento_env::{Env, FromEnv, env_kv};

env_kv!("DATABASE_URL", String);
env_kv!("LONA_JS", PathBuf);
env_kv!("PORT", u16, default = 8080);
env_kv!("DEBUG_MODE", bool, default = false);
env_kv!(StripeSecretKey, "API_KEY", String);

// Use the derive macro to generate from_env()
#[derive(Debug, FromEnv)]
struct AppConfig {
  database_url: Env<DatabaseUrl>,
  lona_js: Env<LonaJs>,
  port: Env<Port>,
  debug_mode: Env<DebugMode>,
  stripe_key: Option<Env<StripeSecretKey>>,
}

fn main() {
  // SAFETY: Example code, single-threaded
  unsafe {
    std::env::set_var("DATABASE_URL", "postgres://localhost/mydb");
    std::env::set_var("LONA_JS", "/home/user/lona-js");
    std::env::set_var("PORT", "3000");
    std::env::set_var("DEBUG_MODE", "true");
    std::env::set_var("API_KEY", "sk_test_abc123");
  }

  let config = AppConfig::from_env().assert_envars();
  eprintln!("{:?}", config);

  // Cleanup
  unsafe {
    std::env::remove_var("DATABASE_URL");
    std::env::remove_var("LONA_JS");
    std::env::remove_var("PORT");
    std::env::remove_var("DEBUG_MODE");
    std::env::remove_var("API_KEY");
  }
}
