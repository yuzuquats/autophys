//! Example demonstrating the assert_envars() method for environment variable loading.
//!
//! `assert_envars()` provides detailed error logging before panicking, making it
//! ideal for application startup where missing env vars should fail fast with
//! clear diagnostics.
//!
//! Run with: cargo run -p tento_env --example assert_envars

use std::path::PathBuf;

use tento_env::{Env, EnvGroup, FromEnv, FromEnvRoot, PrintEnv, env_kv};

env_kv!("LOG_LEVEL", String, default = "info".to_string());
env_kv!("PROJECT_ROOT", PathBuf);

env_kv!("DB_HOST", String, default = "localhost".to_string());
env_kv!("DB_PORT", u16, default = 5432);
env_kv!("DB_NAME", String);
env_kv!("DB_USER", String, default = "postgres".to_string());

env_kv!("REDIS_HOST", String, default = "localhost".to_string());
env_kv!("REDIS_PORT", u16, default = 6379);

#[derive(Debug, FromEnv)]
struct DatabaseConfig {
  db_host: Env<DbHost>,
  db_port: Env<DbPort>,
  db_name: Env<DbName>,
  db_user: Env<DbUser>,
}

#[derive(Debug, FromEnv)]
struct RedisConfig {
  redis_host: Env<RedisHost>,
  redis_port: Env<RedisPort>,
}

#[derive(Debug, FromEnv)]
struct AppConfig {
  log_level: Env<LogLevel>,
  project_root: Env<ProjectRoot>,
  database: EnvGroup<DatabaseConfig>,
  redis: EnvGroup<RedisConfig>,
}

fn main() {
  // SAFETY: Example code, single-threaded
  unsafe {
    std::env::set_var("DB_NAME", "myapp_db");
    std::env::set_var("PROJECT_ROOT", "/home/user/project");
  }

  let config = AppConfig::from_env_root().assert_envars();
  config.print_env();

  // Cleanup
  unsafe {
    std::env::remove_var("DB_NAME");
    std::env::remove_var("PROJECT_ROOT");
  }
}
