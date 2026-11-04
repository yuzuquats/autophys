//! Example demonstrating the error output when assert_envars() fails with nested EnvGroups.
//!
//! This example intentionally triggers a failure to show the colored error format.
//!
//! Run with: cargo run -p tento_env --example assert_envars_failure

use tento_env::{Env, EnvGroup, FromEnv, FromEnvRoot, env_kv};

// App config
env_kv!("APP_NAME", String);
env_kv!("APP_DEBUG", bool, default = false);

// Database config (nested)
env_kv!("DB_HOST", String, default = "localhost".to_string());
env_kv!("DB_PORT", u16, default = 5432);
env_kv!("DB_NAME", String);
env_kv!("DB_PASSWORD", String);

// Redis config (nested)
env_kv!("REDIS_HOST", String, default = "localhost".to_string());
env_kv!("REDIS_PORT", u16, default = 6379);
env_kv!("REDIS_PASSWORD", String);

#[derive(Debug, FromEnv)]
struct DatabaseConfig {
  db_host: Env<DbHost>,
  db_port: Env<DbPort>,
  db_name: Env<DbName>,
  db_password: Env<DbPassword>,
}

#[derive(Debug, FromEnv)]
struct RedisConfig {
  redis_host: Env<RedisHost>,
  redis_port: Env<RedisPort>,
  redis_password: Env<RedisPassword>,
}

#[derive(Debug, FromEnv)]
struct AppConfig {
  app_name: Env<AppName>,
  app_debug: Env<AppDebug>,
  database: EnvGroup<DatabaseConfig>,
  redis: EnvGroup<RedisConfig>,
}

fn main() {
  // Intentionally NOT setting required env vars (APP_NAME, DB_NAME, DB_PASSWORD, REDIS_PASSWORD)
  // to trigger a failure with colored error output
  let _config = AppConfig::from_env_root().assert_envars();
}
