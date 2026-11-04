//! Example demonstrating the EnvResult type for three-state environment variable handling.
//!
//! `EnvResult<T>` discriminates between:
//! - `Present(Env<T>)`: Variable loaded successfully
//! - `Missing { key }`: Variable not set in environment
//! - `Malformed(EnvError)`: Variable set but failed to parse
//!
//! This enables explicit handling where "not set" is acceptable but "malformed" is not.
//!
//! Run with: cargo run -p tento_env --example env_result

use tento_env::{Env, EnvResult, FromEnv, FromEnvRoot, PrintEnv, env_kv};

env_kv!("CACHE_URL", String);
env_kv!("CACHE_TTL", u32, default = 300);
env_kv!("DATABASE_URL", String);

#[derive(Debug, FromEnv)]
struct AppConfig {
  // Required - must be present
  database_url: Env<DatabaseUrl>,

  // Explicit result - caller handles all three states
  cache_url: EnvResult<CacheUrl>,

  // Has default, so always present
  cache_ttl: Env<CacheTtl>,
}

fn main() {
  // SAFETY: Example code, single-threaded
  unsafe {
    std::env::set_var("DATABASE_URL", "postgres://localhost/mydb");
    // Note: CACHE_URL is intentionally not set to demonstrate Missing state
  }

  let config = AppConfig::from_env_root().assert_envars();
  config.print_env();

  // Handle the three-state cache URL
  match &config.cache_url {
    EnvResult::Present(env) => {
      println!("\nUsing cache at: {}", env.value());
    }
    EnvResult::Missing { key } => {
      println!("\n{} not set - caching disabled", key);
    }
    EnvResult::Malformed(err) => {
      // This would have been caught by assert_envars(), but shown for completeness
      eprintln!("\nInvalid cache config: {}", err);
    }
  }

  // You can also use helper methods for common patterns
  if let Some(cache_url) = config.cache_url.value() {
    println!("Cache URL value: {}", cache_url);
  }

  // Cleanup
  unsafe {
    std::env::remove_var("DATABASE_URL");
  }
}
