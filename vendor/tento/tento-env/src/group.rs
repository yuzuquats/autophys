use std::collections::HashSet;
use std::fmt::{self, Display, Formatter};
use std::ops::Deref;

use colored::Colorize;
use serde::{Deserialize, Serialize};

use crate::env_result::EnvResult;
use crate::error::EnvError;

/// Trait for types that can be loaded from environment variables.
///
/// This trait is implemented by the `#[derive(FromEnv)]` macro for configuration
/// structs. It can also be implemented manually for custom loading logic.
///
/// # Example
///
/// ```ignore
/// use tento_env::{FromEnv, EnvGroupResult};
///
/// #[derive(FromEnv)]
/// struct AppConfig {
///   database_url: Env<DatabaseUrl>,
///   port: Env<Port>,
/// }
///
/// // The derive generates:
/// // impl FromEnv for AppConfig {
/// //   fn from_env() -> EnvGroupResult<Self> { ... }
/// // }
///
/// let config = AppConfig::from_env().into_result()?;
/// ```
pub trait FromEnv: Sized {
  /// Load this type from environment variables.
  ///
  /// Returns an `EnvGroupResult` that can be converted to a `Result` for use with `?`.
  /// On error, contains both successfully loaded values and all errors encountered.
  fn from_env() -> EnvGroupResult<Self>;

  /// Load this config resolving **every** key through `backend` instead of the
  /// process environment. A single backend is used for the whole load — there
  /// is no env/store layering. See [`crate::Backend`].
  fn from_backend<B: crate::Backend + 'static>(backend: B) -> EnvGroupResult<Self> {
    crate::with_backend(backend, || Self::from_env())
  }
}

/// Trait for extracting environment variable key-value pairs.
///
/// This trait is automatically implemented by the `#[derive(FromEnv)]` macro.
/// It provides a way to extract all environment variables from a loaded config
/// as key-value pairs, useful for forwarding to child processes.
///
/// # Example
///
/// ```ignore
/// use tento_env::{FromEnv, EnvVars};
///
/// #[derive(FromEnv)]
/// struct AppConfig {
///   database_url: Env<DatabaseUrl>,
///   port: Env<Port>,
///   nested: EnvGroup<NestedConfig>,
/// }
///
/// let config = AppConfig::from_env().assert_envars();
///
/// // Forward all env vars to a child process
/// let mut cmd = std::process::Command::new("child");
/// for (key, value) in config.env_vars() {
///   cmd.env(key, value);
/// }
/// ```
pub trait EnvVars {
  /// Extract all environment variable key-value pairs from this config.
  ///
  /// Returns a vector of (key, value) pairs where:
  /// - `key` is the environment variable name (e.g., "DATABASE_URL")
  /// - `value` is the string representation of the value
  ///
  /// For nested configs, recursively extracts all env vars.
  /// Optional fields that are `None` are skipped.
  fn env_vars(&self) -> Vec<(&'static str, String)>;
}

/// Trait for printing loaded environment configuration.
///
/// This trait is automatically implemented by the `#[derive(FromEnv)]` macro
/// alongside `FromEnv`. It provides a streamlined way to print loaded config
/// values, similar to `dbg!` but formatted for environment variables.
///
/// # Example
///
/// ```ignore
/// use tento_env::{FromEnv, PrintEnv};
///
/// #[derive(FromEnv)]
/// struct AppConfig {
///   database_url: Env<DatabaseUrl>,
///   port: Env<Port>,
///   nested: EnvGroup<NestedConfig>,
/// }
///
/// let config = AppConfig::from_env().assert_envars();
/// config.print_env();
/// // Output:
/// // AppConfig:
/// //   DATABASE_URL: "postgres://localhost/mydb"
/// //   PORT: "8080"
/// //   nested:
/// //     NESTED_VAR: "value"
/// ```
pub trait PrintEnv {
  /// Print the loaded environment configuration to stderr.
  ///
  /// This provides a clean, formatted view of all environment variables
  /// that were loaded, with their keys and values. Redacted values will
  /// show their redacted form.
  fn print_env(&self);

  /// Format the loaded environment configuration as a string.
  fn fmt_env(&self) -> String;

  /// Format the loaded environment configuration with custom indentation.
  ///
  /// This is used internally for nested configs to maintain proper indentation.
  fn fmt_env_indented(&self, indent: usize) -> String;

  /// Format the loaded environment configuration with custom indentation and deduplication.
  ///
  /// The `seen` set tracks type names that have already been printed to avoid
  /// printing duplicate nested configs multiple times.
  fn fmt_env_with_seen(&self, indent: usize, seen: &mut HashSet<&'static str>) -> String;

  /// Get the type name for this config, used for deduplication.
  fn type_name() -> &'static str
  where
    Self: Sized;
}

/// A wrapper for configuration structs loaded from environment variables.
///
/// Provides a container for config structs with Deref for ergonomic access.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EnvGroup<T> {
  config: T,
}

impl<T> EnvGroup<T> {
  /// Create a new EnvGroup with the given config.
  pub fn new(config: T) -> Self {
    EnvGroup { config }
  }

  /// Get a reference to the inner config.
  pub fn config(&self) -> &T {
    &self.config
  }

  /// Consume the wrapper and return the inner config.
  pub fn into_config(self) -> T {
    self.config
  }
}

impl<T> Deref for EnvGroup<T> {
  type Target = T;

  fn deref(&self) -> &T {
    &self.config
  }
}

/// A successfully loaded environment variable.
#[derive(Debug, Clone)]
pub struct EnvLoaded {
  /// The environment variable key.
  pub key: &'static str,
  /// Display-safe representation of the value (may be redacted).
  pub display_value: String,
  /// Whether this field was required.
  pub required: bool,
}

impl EnvLoaded {
  /// Create a loaded result for a required field.
  pub fn required(key: &'static str, display_value: impl Into<String>) -> Self {
    EnvLoaded {
      key,
      display_value: display_value.into(),
      required: true,
    }
  }

  /// Create a loaded result for an optional field.
  pub fn optional(key: &'static str, display_value: impl Into<String>) -> Self {
    EnvLoaded {
      key,
      display_value: display_value.into(),
      required: false,
    }
  }

  /// Create a loaded result for an optional field that was not set.
  pub fn not_set(key: &'static str) -> Self {
    EnvLoaded {
      key,
      display_value: "<not set>".to_string(),
      required: false,
    }
  }

  /// Format this loaded value with colors for terminal output.
  pub fn fmt_colored(&self) -> String {
    if self.display_value == "<not set>" {
      format!("{}: {}", self.key.green(), "<not set>".dimmed())
    } else {
      format!("{}: {}", self.key.green(), self.display_value.yellow())
    }
  }
}

impl Display for EnvLoaded {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    let tag = if self.required { "req" } else { "opt" };
    write!(f, "[{}] {}: {}", tag, self.key, self.display_value)
  }
}

/// Error containing all environment variable load results.
///
/// Provides comprehensive reporting showing both what was successfully
/// loaded and what failed, enabling better debugging.
#[derive(Debug, Clone)]
pub struct EnvGroupError {
  /// Successfully loaded values (for context in error display).
  loaded: Vec<EnvLoaded>,
  /// Errors that occurred during loading.
  errors: Vec<EnvError>,
}

impl EnvGroupError {
  /// Create a new EnvGroupError.
  pub fn new(loaded: Vec<EnvLoaded>, errors: Vec<EnvError>) -> Self {
    EnvGroupError { loaded, errors }
  }

  /// Get the successfully loaded values.
  pub fn loaded(&self) -> &[EnvLoaded] {
    &self.loaded
  }

  /// Get the errors.
  pub fn errors(&self) -> &[EnvError] {
    &self.errors
  }

  /// Get the number of errors.
  pub fn error_count(&self) -> usize {
    self.errors.len()
  }

  /// Consume and return the loaded values and errors.
  pub fn into_parts(self) -> (Vec<EnvLoaded>, Vec<EnvError>) {
    (self.loaded, self.errors)
  }

  /// Format the error with custom indentation and colors.
  ///
  /// This is useful when displaying errors in a nested context.
  pub fn fmt_indented(&self, indent: usize) -> String {
    let indent_str = " ".repeat(indent);
    let mut output = String::new();

    output.push_str(&format!(
      "{}{}\n",
      indent_str,
      "Environment Variable Errors:".red().bold()
    ));

    Self::fmt_section(
      &mut output,
      &indent_str,
      "Loaded".green().to_string(),
      self.loaded.iter().map(|l| l.fmt_colored()),
    );

    Self::fmt_section(
      &mut output,
      &indent_str,
      "Errors".red().to_string(),
      self.errors.iter().map(|e| e.fmt_colored()),
    );

    output
  }

  fn fmt_section(
    output: &mut String,
    indent_str: &str,
    header: String,
    items: impl Iterator<Item = String>,
  ) {
    let items: Vec<_> = items.collect();
    if items.is_empty() {
      return;
    }
    output.push('\n');
    output.push_str(&format!("{}{}:\n", indent_str, header));
    for item in items {
      output.push_str(&format!("{}  {}\n", indent_str, item));
    }
  }
}

impl Display for EnvGroupError {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "{}", self.fmt_indented(0))
  }
}

impl std::error::Error for EnvGroupError {}

/// Result type for loading an environment group.
///
/// Wraps a standard `Result<T, EnvGroupError>`. The error contains
/// partial results (successfully loaded values) for comprehensive
/// error reporting.
///
/// # Example
///
/// ```ignore
/// let config = load_config().into_result()?;
/// // Or access inner Result directly:
/// let config = load_config().0?;
/// ```
#[derive(Debug, Clone)]
pub struct EnvGroupResult<T>(pub Result<T, EnvGroupError>);

impl<T> EnvGroupResult<T> {
  /// Create a successful result.
  pub fn ok(value: T) -> Self {
    EnvGroupResult(Ok(value))
  }

  /// Create an error result with loaded values and errors.
  pub fn err(loaded: Vec<EnvLoaded>, errors: Vec<EnvError>) -> Self {
    EnvGroupResult(Err(EnvGroupError::new(loaded, errors)))
  }

  /// Check if this is a success.
  pub fn is_ok(&self) -> bool {
    self.0.is_ok()
  }

  /// Check if this is an error.
  pub fn is_err(&self) -> bool {
    self.0.is_err()
  }

  /// Convert to a standard Result for use with `?` operator.
  pub fn into_result(self) -> Result<T, EnvGroupError> {
    self.0
  }

  /// Unwrap the value, panicking if there was an error.
  pub fn unwrap(self) -> T {
    self.0.unwrap()
  }

  /// Unwrap the value with a custom panic message.
  pub fn expect(self, msg: &str) -> T {
    self.0.expect(msg)
  }

  /// Get the error, if any.
  pub fn into_err(self) -> Option<EnvGroupError> {
    self.0.err()
  }

  /// Map the success value.
  pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> EnvGroupResult<U> {
    EnvGroupResult(self.0.map(f))
  }

  /// Chain operations that return EnvGroupResult.
  pub fn and_then<U, F: FnOnce(EnvGroup<T>) -> EnvGroupResult<U>>(self, f: F) -> EnvGroupResult<U> {
    match self.0 {
      Ok(value) => f(EnvGroup::new(value)),
      Err(e) => EnvGroupResult(Err(e)),
    }
  }

  /// Assert that all environment variables loaded successfully.
  ///
  /// On success, returns the loaded value.
  /// On error, logs the detailed `EnvGroupError` to stderr and panics.
  ///
  /// This provides much better debugging output than `.unwrap()` or `.expect()`,
  /// showing which variables were successfully loaded and which failed.
  ///
  /// # Panics
  ///
  /// Panics if any required environment variable is missing or invalid.
  ///
  /// # Example
  ///
  /// ```ignore
  /// let config = AppConfig::from_env().assert_envars();
  /// // On failure, prints:
  /// // Environment Variable Errors:
  /// //
  /// // Loaded:
  /// //   [req] DATABASE_URL: "postgres://..."
  /// //
  /// // Errors:
  /// //   [req] API_KEY: missing
  /// ```
  pub fn assert_envars(self) -> T {
    match self.0 {
      Ok(value) => value,
      Err(error) => {
        eprintln!("\n{}", error);
        panic!(
          "Failed to load environment variables: {} error(s)",
          error.error_count()
        );
      }
    }
  }

  /// Assert that all environment variables loaded successfully, with a custom context.
  ///
  /// Similar to `assert_envars()` but allows providing a context string that
  /// helps users understand what mode or configuration is being validated.
  ///
  /// # Arguments
  ///
  /// * `context` - A description of the configuration context (e.g., "Bundle Mode", "Development Mode")
  ///
  /// # Example
  ///
  /// ```ignore
  /// let config = RuntimeConfig::from_env()
  ///   .assert_envars_with_context("Bundle Mode");
  /// // On failure, prints:
  /// // === Bundle Mode Configuration Error ===
  /// // ...
  /// ```
  pub fn assert_envars_with_context(self, context: &str) -> T {
    match self.0 {
      Ok(value) => value,
      Err(error) => {
        eprintln!("\n=== {} Configuration Error ===\n", context);
        eprintln!("{}", error);
        std::process::exit(1);
      }
    }
  }
}

// Allow using ? operator by converting to Result
impl<T> From<EnvGroupResult<T>> for Result<T, EnvGroupError> {
  fn from(result: EnvGroupResult<T>) -> Self {
    result.0
  }
}

/// Builder for collecting environment variable results.
///
/// Collects both successful values and errors, allowing all fields
/// to be attempted before reporting failures.
#[derive(Debug)]
pub struct EnvGroupBuilder {
  loaded: Vec<EnvLoaded>,
  errors: Vec<EnvError>,
}

impl EnvGroupBuilder {
  /// Create a new builder.
  pub fn new() -> Self {
    EnvGroupBuilder {
      loaded: Vec::new(),
      errors: Vec::new(),
    }
  }

  /// Record a successfully loaded required value.
  pub fn loaded_req(&mut self, key: &'static str, display_value: impl Into<String>) {
    self.loaded.push(EnvLoaded::required(key, display_value));
  }

  /// Record a successfully loaded optional value.
  pub fn loaded_opt(&mut self, key: &'static str, display_value: impl Into<String>) {
    self.loaded.push(EnvLoaded::optional(key, display_value));
  }

  /// Record an optional value that was not set.
  pub fn not_set(&mut self, key: &'static str) {
    self.loaded.push(EnvLoaded::not_set(key));
  }

  /// Record an error.
  pub fn error(&mut self, error: EnvError) {
    self.errors.push(error);
  }

  /// Try to get a required value, recording the result.
  pub fn require<T: Display>(
    &mut self,
    key: &'static str,
    result: Result<T, EnvError>,
  ) -> Option<T> {
    match result {
      Ok(value) => {
        self.loaded_req(key, format!("{}", value));
        Some(value)
      }
      Err(error) => {
        self.error(error);
        None
      }
    }
  }

  /// Try to get an optional value, recording the result.
  /// Missing values are not recorded as errors.
  pub fn optional<T: Display>(
    &mut self,
    key: &'static str,
    result: Result<T, EnvError>,
  ) -> Option<T> {
    match result {
      Ok(value) => {
        self.loaded_opt(key, format!("{}", value));
        Some(value)
      }
      Err(EnvError::Missing { .. }) => {
        self.not_set(key);
        None
      }
      Err(error) => {
        self.error(error);
        None
      }
    }
  }

  /// Record a required EnvResult field.
  ///
  /// All states (Present, Missing, Malformed) are recorded in the audit trail.
  /// Missing and Malformed are recorded as errors.
  pub fn require_result<T: Display>(&mut self, result: &EnvResult<T>) {
    match result {
      EnvResult::Present(env) => {
        self.loaded_req(env.key(), format!("{}", env.value()));
      }
      EnvResult::Missing { key } => {
        self.error(EnvError::missing(key));
      }
      EnvResult::Malformed(err) => {
        self.error(err.clone());
      }
    }
  }

  /// Record an optional EnvResult field.
  ///
  /// Present and Missing are recorded normally (Missing is not an error).
  /// Malformed is still recorded as an error.
  pub fn optional_result<T: Display>(&mut self, result: &EnvResult<T>) {
    match result {
      EnvResult::Present(env) => {
        self.loaded_opt(env.key(), format!("{}", env.value()));
      }
      EnvResult::Missing { key } => {
        self.not_set(key);
      }
      EnvResult::Malformed(err) => {
        self.error(err.clone());
      }
    }
  }

  /// Check if any errors have been collected.
  pub fn has_errors(&self) -> bool {
    !self.errors.is_empty()
  }

  /// Get the number of errors.
  pub fn error_count(&self) -> usize {
    self.errors.len()
  }

  /// Get the loaded values.
  pub fn loaded(&self) -> &[EnvLoaded] {
    &self.loaded
  }

  /// Get the errors.
  pub fn errors(&self) -> &[EnvError] {
    &self.errors
  }

  /// Finish building and create a result.
  ///
  /// If there are no errors, returns `EnvGroupResult::ok` with the provided value.
  /// If there are errors, returns `EnvGroupResult::err` with loaded values and errors.
  pub fn finish<T>(self, value_fn: impl FnOnce() -> Option<T>) -> EnvGroupResult<T> {
    if self.has_errors() {
      return EnvGroupResult::err(self.loaded, self.errors);
    }
    match value_fn() {
      Some(value) => EnvGroupResult::ok(value),
      None => EnvGroupResult::err(self.loaded, self.errors),
    }
  }

  /// Consume and return the loaded values and errors.
  pub fn into_parts(self) -> (Vec<EnvLoaded>, Vec<EnvError>) {
    (self.loaded, self.errors)
  }
}

impl Default for EnvGroupBuilder {
  fn default() -> Self {
    Self::new()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[derive(Debug, Clone, PartialEq)]
  struct TestConfig {
    name: String,
    port: u16,
  }

  #[test]
  fn test_env_group_new() {
    let config = TestConfig {
      name: "test".to_string(),
      port: 8080,
    };
    let group = EnvGroup::new(config.clone());

    assert_eq!(group.config().name, "test");
    assert_eq!(group.config().port, 8080);
  }

  #[test]
  fn test_env_group_deref() {
    let config = TestConfig {
      name: "test".to_string(),
      port: 8080,
    };
    let group = EnvGroup::new(config);

    assert_eq!(group.name, "test");
    assert_eq!(group.port, 8080);
  }

  #[test]
  fn test_env_group_into_config() {
    let config = TestConfig {
      name: "test".to_string(),
      port: 8080,
    };
    let group = EnvGroup::new(config.clone());
    let extracted = group.into_config();

    assert_eq!(extracted, config);
  }

  // EnvLoaded tests

  #[test]
  fn test_env_loaded_required() {
    let loaded = EnvLoaded::required("DATABASE_URL", "postgres://localhost");
    assert!(loaded.required);
    assert_eq!(loaded.key, "DATABASE_URL");

    let display = format!("{}", loaded);
    assert!(display.contains("[req]"));
    assert!(display.contains("DATABASE_URL"));
    assert!(display.contains("postgres://localhost"));
  }

  #[test]
  fn test_env_loaded_optional() {
    let loaded = EnvLoaded::optional("DEBUG", "true");
    assert!(!loaded.required);

    let display = format!("{}", loaded);
    assert!(display.contains("[opt]"));
  }

  #[test]
  fn test_env_loaded_not_set() {
    let loaded = EnvLoaded::not_set("OPTIONAL_VAR");
    assert!(!loaded.required);

    let display = format!("{}", loaded);
    assert!(display.contains("<not set>"));
  }

  // EnvGroupError tests

  #[test]
  fn test_env_group_error_display() {
    let loaded = vec![
      EnvLoaded::required("ACME_JS", "\"/path/to/acme-js\""),
      EnvLoaded::required("TEST_STR", "\"hello\""),
      EnvLoaded::not_set("TEST_OPT"),
    ];
    let errors = vec![
      EnvError::missing("DATABASE_URL"),
      EnvError::parse("PORT", "abc", "u16"),
    ];
    let error = EnvGroupError::new(loaded, errors);

    let display = format!("{}", error);
    assert!(display.contains("Environment Variable Errors:"));
    assert!(display.contains("Loaded:"));
    // Colored format: KEY: VALUE (no [req]/[opt] tags)
    assert!(display.contains("ACME_JS:"));
    assert!(display.contains("TEST_OPT:"));
    assert!(display.contains("Errors:"));
    assert!(display.contains("DATABASE_URL:"));
    assert!(display.contains("PORT:"));

    println!("{display}");
  }

  #[test]
  fn test_env_group_error_count() {
    let loaded = vec![EnvLoaded::required("A", "value")];
    let errors = vec![EnvError::missing("B"), EnvError::missing("C")];
    let error = EnvGroupError::new(loaded, errors);

    assert_eq!(error.error_count(), 2);
  }

  // EnvGroupResult tests

  #[test]
  fn test_env_group_result_ok() {
    let result = EnvGroupResult::ok("success");
    assert!(result.is_ok());
    assert!(!result.is_err());
    assert_eq!(result.unwrap(), "success");
  }

  #[test]
  fn test_env_group_result_err() {
    let result: EnvGroupResult<String> =
      EnvGroupResult::err(vec![], vec![EnvError::missing("FOO")]);
    assert!(result.is_err());
    assert!(!result.is_ok());
  }

  #[test]
  fn test_env_group_result_into_result() {
    let result = EnvGroupResult::ok("value");
    let std_result: Result<_, EnvGroupError> = result.into_result();
    assert!(std_result.is_ok());
  }

  #[test]
  fn test_env_group_result_from_conversion() {
    let result = EnvGroupResult::ok("value");
    let std_result: Result<_, EnvGroupError> = result.into();
    assert!(std_result.is_ok());
  }

  // EnvGroupBuilder tests

  #[test]
  fn test_builder_require_ok() {
    let mut builder = EnvGroupBuilder::new();
    let value = builder.require("NAME", Ok::<_, EnvError>("hello".to_string()));

    assert_eq!(value, Some("hello".to_string()));
    assert!(!builder.has_errors());
    assert_eq!(builder.loaded().len(), 1);
    assert!(builder.loaded()[0].required);
  }

  #[test]
  fn test_builder_require_err() {
    let mut builder = EnvGroupBuilder::new();
    let value: Option<String> = builder.require("FOO", Err(EnvError::missing("FOO")));

    assert_eq!(value, None);
    assert!(builder.has_errors());
    assert_eq!(builder.error_count(), 1);
  }

  #[test]
  fn test_builder_optional_ok() {
    let mut builder = EnvGroupBuilder::new();
    let value = builder.optional("DEBUG", Ok::<_, EnvError>("true".to_string()));

    assert_eq!(value, Some("true".to_string()));
    assert!(!builder.has_errors());
  }

  #[test]
  fn test_builder_optional_missing() {
    let mut builder = EnvGroupBuilder::new();
    let value: Option<String> = builder.optional("FOO", Err(EnvError::missing("FOO")));

    assert_eq!(value, None);
    assert!(!builder.has_errors()); // Missing is not an error for optional

    // But we should have a "not set" result recorded
    assert_eq!(builder.loaded().len(), 1);
    let display = format!("{}", builder.loaded()[0]);
    assert!(display.contains("<not set>"));
  }

  #[test]
  fn test_builder_optional_parse_error() {
    let mut builder = EnvGroupBuilder::new();
    let value: Option<u16> = builder.optional("PORT", Err(EnvError::parse("PORT", "abc", "u16")));

    assert_eq!(value, None);
    assert!(builder.has_errors()); // Parse error IS an error
  }

  #[test]
  fn test_builder_finish_success() {
    let mut builder = EnvGroupBuilder::new();
    let name = builder.require("NAME", Ok::<_, EnvError>("test".to_string()));
    let port = builder.require("PORT", Ok::<_, EnvError>(8080u16));

    let result = builder.finish(|| {
      Some(TestConfig {
        name: name?,
        port: port?,
      })
    });

    assert!(result.is_ok());
    let config = result.unwrap();
    assert_eq!(config.name, "test");
    assert_eq!(config.port, 8080);
  }

  #[test]
  fn test_builder_finish_with_errors() {
    let mut builder = EnvGroupBuilder::new();
    let name = builder.require("NAME", Ok::<_, EnvError>("test".to_string()));
    let _port: Option<u16> = builder.require("PORT", Err(EnvError::missing("PORT")));

    let result = builder.finish(|| {
      Some(TestConfig {
        name: name.clone()?,
        port: 0, // Won't be used
      })
    });

    assert!(result.is_err());
    let error = result.into_result().unwrap_err();
    assert_eq!(error.error_count(), 1);
    // Error should contain the successfully loaded value
    assert_eq!(error.loaded().len(), 1);
    assert_eq!(error.loaded()[0].key, "NAME");
  }

  #[test]
  fn test_full_workflow() {
    // Simulate loading a config with mixed results
    let mut builder = EnvGroupBuilder::new();

    // Successful loads
    let name = builder.require("APP_NAME", Ok::<_, EnvError>("MyApp".to_string()));
    let port = builder.require("PORT", Ok::<_, EnvError>(8080u16));
    let debug = builder.optional("DEBUG", Ok::<_, EnvError>(true));

    // Optional not set
    let _timeout: Option<u32> = builder.optional("TIMEOUT", Err(EnvError::missing("TIMEOUT")));

    let result = builder.finish(|| Some((name.clone()?, port?, debug)));

    assert!(result.is_ok());
    let (app_name, app_port, app_debug) = result.unwrap();
    assert_eq!(app_name, "MyApp");
    assert_eq!(app_port, 8080);
    assert_eq!(app_debug, Some(true));
  }

  #[test]
  fn test_assert_envars_success() {
    let result: EnvGroupResult<String> = EnvGroupResult::ok("success".to_string());
    let value = result.assert_envars();
    assert_eq!(value, "success");
  }

  #[test]
  #[should_panic(expected = "Failed to load environment variables: 1 error(s)")]
  fn test_assert_envars_failure() {
    let result: EnvGroupResult<String> =
      EnvGroupResult::err(vec![], vec![EnvError::missing("MISSING_VAR")]);
    result.assert_envars();
  }
}
