//! Type-safe environment variable configuration with serde integration.
//!
//! This crate provides macros and types for type-safe environment variable
//! access with support for validation, redaction, and grouping.
//!
//! # Core Types
//!
//! ## `Env<T>`
//!
//! A wrapper that tracks the environment variable key alongside its value.
//! Every field in a config struct should be wrapped in `Env<T>` to maintain
//! an audit trail of where values originated from.
//!
//! ```ignore
//! pub struct Env<T> {
//!   key: &'static str,
//!   value: T,
//! }
//!
//! impl<T> Env<T> {
//!   pub fn key(&self) -> &'static str { self.key }
//!   pub fn value(&self) -> &T { &self.value }
//!   pub fn into_value(self) -> T { self.value }
//! }
//!
//! // Derefs to inner value for ergonomic access
//! impl<T> Deref for Env<T> {
//!   type Target = T;
//!   fn deref(&self) -> &T { &self.value }
//! }
//!
//! // Display for audit trail output
//! impl<T: Display> Display for Env<T> {
//!   fn fmt(&self, f: &mut Formatter) -> fmt::Result {
//!     write!(f, "{}: \"{}\"", self.key, self.value)
//!   }
//! }
//!
//! impl<T: Display> Display for Env<Option<T>> {
//!   fn fmt(&self, f: &mut Formatter) -> fmt::Result {
//!     match &self.value {
//!       Some(v) => write!(f, "{}: \"{}\"", self.key, v),
//!       None => write!(f, "{}: <not set>", self.key),
//!     }
//!   }
//! }
//! ```
//!
//! ## `EnvGroup<T>`
//!
//! A wrapper for configuration structs loaded from environment variables.
//! Provides rich error reporting on load failure.
//!
//! ```ignore
//! pub struct EnvGroup<T> {
//!   config: T,
//! }
//!
//! impl<T> Deref for EnvGroup<T> {
//!   type Target = T;
//!   fn deref(&self) -> &T { &self.config }
//! }
//! ```
//!
//! ## `FromEnvVar` Trait
//!
//! Trait for types that can be parsed from an environment variable string.
//!
//! ```ignore
//! pub trait FromEnvVar: Sized {
//!   fn from_env_var(key: &'static str) -> Result<Self>;
//!   fn parse_value(s: &str) -> Result<Self>;
//! }
//!
//! // Implemented for: String, PathBuf, bool, numeric types,
//! // Option<T>, Redacted<T>
//! ```
//!
//! ## Error Types
//!
//! ### `EnvError`
//!
//! Represents a single environment variable error:
//!
//! ```ignore
//! pub enum EnvError {
//!   /// Environment variable not found
//!   Missing { key: &'static str },
//!
//!   /// Environment variable found but couldn't be parsed
//!   Parse {
//!     key: &'static str,
//!     value: String,
//!     expected_type: &'static str,
//!   },
//! }
//!
//! impl Display for EnvError {
//!   fn fmt(&self, f: &mut Formatter) -> fmt::Result {
//!     match self {
//!       EnvError::Missing { key } =>
//!         write!(f, "{}: missing", key),
//!       EnvError::Parse { key, value, expected_type } =>
//!         write!(f, "{}: \"{}\" (expected: {})", key, value, expected_type),
//!     }
//!   }
//! }
//! ```
//!
//! ### `EnvGroupError`
//!
//! Aggregates multiple errors with context about what was loaded:
//!
//! ```text
//! Environment Variable Errors:
//!
//! Loaded:
//!   [req] ACME_JS: "/path/to/acme-js"
//!   [req] TEST_STR: "hello"
//!   [opt] TEST_OPT: <not set>
//!
//! Errors:
//!   [req] DATABASE_URL: missing
//!   [req] PORT: "abc" (expected: u16)
//! ```
//!
//! # `env_kv!` Macro
//!
//! Creates a newtype struct for a single environment variable.
//!
//! ## Standard Form
//!
//! Derives the struct name from the environment variable key:
//!
//! ```ignore
//! env_kv!("ACME_JS", PathBuf);
//! env_kv!("DATABASE_URL", String);
//! env_kv!("PORT", u16, default = 8080);
//!
//! // Produces:
//! pub struct AcmeJs(pub PathBuf);      // ACME_JS -> AcmeJs
//! pub struct DatabaseUrl(pub String);  // DATABASE_URL -> DatabaseUrl
//! pub struct Port(pub u16);            // PORT -> Port (with default)
//!
//! impl FromEnvVar for AcmeJs { ... }
//! impl Deref for AcmeJs { type Target = PathBuf; ... }
//!
//! // Usage:
//! let acme_js: Env<AcmeJs> = AcmeJs::from_env()?;
//! let db: Env<DatabaseUrl> = DatabaseUrl::from_env()?;
//! let port: Port = Port::from_env()?; // Returns Port(8080) if PORT not set
//! ```
//!
//! ## Named Form (for conflicts)
//!
//! Explicitly specify the struct name when the derived name would conflict:
//!
//! ```ignore
//! // Both would derive to "ApiKey" from standard form
//! env_kv!(StripeApiKey, "API_KEY", String);
//! env_kv!(SendgridApiKey, "API_KEY", String);
//!
//! // Or when you want a different name than the derived one
//! env_kv!(DbConnection, "DATABASE_URL", String);
//! ```
//!
//! # Configuration Structs
//!
//! Define configuration structs using standard serde derives with `Env<T>` wrappers:
//!
//! ```ignore
//! env_kv!("ACME_JS", PathBuf);
//! env_kv!("ACME_JS_CHRONO", PathBuf);
//! env_kv!("PORT", u16, default = 8080);
//!
//! #[derive(Deserialize)]
//! pub struct AppConfig {
//!   // Newtype from env_kv! - type-safe, key derived from type name
//!   acme_js: Env<AcmeJs>,
//!
//!   // Env<T> wrapper - key derived from field name (ACME_JS_CHRONO)
//!   acme_js_chrono: Env<PathBuf>,
//!
//!   // Optional field - None if env var not set
//!   debug_mode: Option<Env<bool>>,
//!
//!   // Redacted sensitive value - safe to log
//!   api_secret: Env<Redacted<String>>,
//!
//!   // Newtype with default value
//!   port: Env<Port>,
//! }
//! ```
//!
//! ## Loading Configuration
//!
//! ```ignore
//! // Direct loading (returns EnvGroup with metadata)
//! let config: EnvGroup<AppConfig> = tento_env::from_env()?;
//!
//! // Access the config
//! println!("Port: {}", config.port);
//!
//! // From JSON (useful for testing or overrides)
//! let config: EnvGroup<AppConfig> = serde_json::from_value(json!({
//!   "acme_js": "/path/to/acme-js",
//!   "port": 3000,
//! }))?;
//! ```
//!
//! # `FromEnv` Derive Macro
//!
//! Automatically generates a `from_env()` method for configuration structs.
//! This eliminates the need to manually implement the builder pattern.
//!
//! ```ignore
//! use tento_env::{env_kv, Env, FromEnv};
//!
//! env_kv!("DATABASE_URL", String);
//! env_kv!("PORT", u16, default = 8080);
//! env_kv!("API_KEY", String);
//!
//! #[derive(FromEnv)]
//! struct AppConfig {
//!   database_url: Env<DatabaseUrl>,   // Required field
//!   port: Env<Port>,                  // Has default, always succeeds
//!   api_key: Option<Env<ApiKey>>,     // Optional field
//! }
//!
//! // The derive generates:
//! // impl AppConfig {
//! //   pub fn from_env() -> EnvGroupResult<Self> { ... }
//! // }
//!
//! // For fallible contexts (can use ?):
//! let config = AppConfig::from_env().into_result()?;
//!
//! // For infallible contexts (panics with detailed error logging):
//! let config = AppConfig::from_env().assert_envars();
//! ```
//!
//! ## Field Types
//!
//! - `Env<T>` - Required field. Uses `T::KEY` and `T::from_env()` to load.
//! - `Option<Env<T>>` - Optional field. Missing values result in `None`.
//! - `EnvResult<T>` - Three-state field for explicit handling of missing vs malformed.
//!
//! The inner type `T` must implement `FromEnvVar`.
//!
//! ## `EnvResult<T>` for Explicit Error Handling
//!
//! Use `EnvResult<T>` when you need to distinguish between:
//! - `Present(Env<T>)`: Variable loaded successfully
//! - `Missing { key }`: Variable not set (may be acceptable)
//! - `Malformed(EnvError)`: Variable set but invalid (always an error)
//!
//! ```ignore
//! #[derive(FromEnv)]
//! struct Config {
//!   // Required
//!   database_url: Env<DatabaseUrl>,
//!
//!   // Optional - missing is okay, but malformed is still an error
//!   cache_url: EnvResult<CacheUrl>,
//! }
//!
//! let config = Config::from_env().assert_envars();
//!
//! match &config.cache_url {
//!   EnvResult::Present(env) => println!("Cache: {}", env.value()),
//!   EnvResult::Missing { .. } => println!("Caching disabled"),
//!   EnvResult::Malformed(err) => unreachable!("caught by assert_envars"),
//! }
//! ```
//!
//! # `env_group_subset!` Macro
//!
//! Declares that one config struct is a subset of another, enabling
//! extraction of partial configs for subsystems. The conversion is
//! **fallible** because the subset may require fields that are optional
//! or missing in the full config.
//!
//! ```ignore
//! #[derive(Deserialize)]
//! pub struct FullConfig {
//!   database_url: Env<Option<DatabaseUrl>>,  // Optional in full
//!   redis_url: Env<RedisUrl>,
//!   api_key: Env<ApiKey>,
//!   port: Env<Port>,
//!   subconfig: EnvGroup<SubConfigGroup>,
//! }
//!
//! #[derive(Deserialize)]
//! pub struct DbConfig {
//!   database_url: Env<DatabaseUrl>,          // Required in subset
//!   redis_url: Env<Option<RedisUrl>>,        // Optional in subset
//! }
//!
//! // Declare subset relationship
//! env_group_subset!(DbConfig subsetof FullConfig);
//!
//! // Produces (fallible conversion):
//! impl TryFrom<&FullConfig> for DbConfig {
//!   type Error = SubsetError;
//!
//!   fn try_from(full: &FullConfig) -> Result<DbConfig, SubsetError> {
//!     Ok(DbConfig {
//!       // Fails if full.database_url is None
//!       database_url: full.database_url.require()?,
//!       // Wraps in Option
//!       redis_url: full.redis_url.as_option(),
//!     })
//!   }
//! }
//!
//! // Usage:
//! let full: EnvGroup<FullConfig> = tento_env::from_env()?;
//! let db: DbConfig = (&*full).try_into()?;
//! pass_to_database_subsystem(db);
//! ```

// Lets this crate use its own `env_kv!` macro, whose generated code references
// `tento_env::…` paths.
extern crate self as tento_env;

mod backend;
mod capability;
mod common;
mod context;
mod env;
mod env_result;
mod error;
mod from_env;
mod group;
mod manifest;
mod preflight;
mod redactable;
mod template;

pub use backend::{
  Backend, CompositeBackend, EnvBackend, EnvMap, effective_var, global_env_map, hermetic_child_env,
  hermetic_child_env_os, hermetic_child_env_os_with, hermetic_child_env_with, resolve_key, set_global_backend,
  set_global_env_map, with_backend, with_env_map, with_env_map_async,
};
// Pre-EnvMap names, kept as deprecated shims until every consumer syncs.
#[allow(deprecated)]
pub use backend::{EnvOverlay, child_env_overlay, global_overlay, set_global_overlay};
pub use capability::{Capability, CapabilityInfo};
pub use common::{Home, XdgCacheHome, XdgConfigHome, XdgDataHome, XdgStateHome, app_data_dir};
pub use context::{
  FromEnvRoot, FromEnvTest, FromEnvVarRoot, FromEnvVarTest, RootContext, TestContext,
};
pub use env::Env;
pub use env_result::EnvResult;
pub use error::EnvError;
pub use from_env::{AssertEnvVar, FromEnvVar, ParseEnvValue, ValueTypeHint};
pub use group::{
  EnvGroup, EnvGroupBuilder, EnvGroupError, EnvGroupResult, EnvLoaded, EnvVars, FromEnv, PrintEnv,
};
pub use manifest::{EnvGroupManifest, EnvManifest, EnvVar};
pub use preflight::{GroupReport, VarReport, preflight};
pub use redactable::{Redactable, Redacted};
pub use template::{EnvGroupMeta, EnvTemplate, EnvVarMeta, format_template, generate_env_template};

// Re-export colored for use in generated code
pub use colored::Colorize;

// Re-export serde and serde_json for use in generated code
pub use serde;
pub use serde_json;

// Re-export the macros
pub use tento_env_macros::FromEnv;
pub use tento_env_macros::env_kv;

/// Capture environment variables based on an EnvTemplate.
///
/// This is the only permitted way to dynamically query environment variables
/// outside of `tento_env`. It uses the template metadata to know which
/// variables to query.
///
/// Returns a list of (key, value) pairs for all env vars that are set.
pub fn capture_template<T: EnvTemplate>() -> Vec<(String, String)> {
  T::env_template()
    .all_vars()
    .into_iter()
    .filter_map(|var| {
      std::env::var(var.key)
        .ok()
        .map(|val| (var.key.to_string(), val))
    })
    .collect()
}

/// Read a single env var ad-hoc — the sanctioned escape hatch for **tests and
/// tooling** that legitimately need a value outside the typed `env_kv!` /
/// `FromEnv` path (so call sites don't reach for raw `std::env`, which acme/server-app
/// crates deny via clippy `disallowed_methods`). Resolved through the active
/// [`Backend`], so `with_backend` overrides apply in tests. Prefer `env_kv!` /
/// `FromEnv` for real configuration.
pub fn test_env(key: &'static str) -> Option<String> {
  resolve_key(key).ok().flatten()
}
