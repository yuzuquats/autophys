//! Example demonstrating EnvResult detecting malformed environment variables.
//!
//! This shows the difference between `Option<Env<T>>` and `EnvResult<T>`:
//! - `Option<Env<T>>`: Both missing AND malformed result in `None` (information lost)
//! - `EnvResult<T>`: Missing is ok, but malformed triggers an error
//!
//! Run with: cargo run -p tento_env --example env_result_malformed

use tento_env::{Env, EnvResult, FromEnv, FromEnvRoot, env_kv};

env_kv!("APP_NAME", String, default = "MyApp".to_string());
env_kv!("PORT", u16);

#[derive(Debug, FromEnv)]
struct AppConfig {
  app_name: Env<AppName>,
  // Port is optional, but if set it MUST be a valid u16
  port: EnvResult<Port>,
}

fn main() {
  // SAFETY: Example code, single-threaded
  unsafe {
    // Set PORT to an invalid value
    std::env::set_var("PORT", "not-a-number");
  }

  println!("Attempting to load config with malformed PORT...\n");

  let result = AppConfig::from_env_root();

  // This will fail because PORT is set but malformed
  match result.into_result() {
    Ok(config) => {
      println!("Config loaded successfully (unexpected)");
      println!("Port: {:?}", config.port);
    }
    Err(error) => {
      // Expected: EnvResult detects the malformed value
      println!("Config failed to load (expected):");
      println!("{}", error);
    }
  }

  // Cleanup
  unsafe {
    std::env::remove_var("PORT");
  }
}
