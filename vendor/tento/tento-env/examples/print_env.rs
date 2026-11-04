//! Example demonstrating the PrintEnv trait for debugging environment configs.
//!
//! Run with: cargo run -p tento_env --example print_env

use tento_env::{Env, EnvGroup, FromEnv, FromEnvRoot, PrintEnv, env_kv};

env_kv!("APP_NAME", String, default = "MyApp".to_string());
env_kv!("APP_PORT", u16, default = 8080);
env_kv!("APP_DEBUG", bool, default = false);

env_kv!("DB_HOST", String, default = "localhost".to_string());
env_kv!("DB_PORT", u16, default = 5432);
env_kv!("DB_NAME", String, default = "myapp_dev".to_string());

env_kv!("CACHE_HOST", String, default = "localhost".to_string());
env_kv!("CACHE_PORT", u16, default = 6379);

env_kv!("API_KEY", String);

#[derive(Debug, FromEnv)]
struct DatabaseConfig {
  db_host: Env<DbHost>,
  db_port: Env<DbPort>,
  db_name: Env<DbName>,
}

#[derive(Debug, FromEnv)]
struct CacheConfig {
  cache_host: Env<CacheHost>,
  cache_port: Env<CachePort>,
}

#[derive(Debug, FromEnv)]
struct ApiConfig {
  api_key: Env<ApiKey>,
}

#[derive(Debug, FromEnv)]
struct AppConfig {
  app_name: Env<AppName>,
  app_port: Env<AppPort>,
  app_debug: Env<AppDebug>,
  database: EnvGroup<DatabaseConfig>,
  cache: EnvGroup<CacheConfig>,
  api: Option<EnvGroup<ApiConfig>>,
}

fn main() {
  let config = AppConfig::from_env_root().assert_envars();
  config.print_env();
}
