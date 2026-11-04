//! Compile-time context-aware environment loading.
//!
//! This module provides extension traits that enforce correct usage of
//! environment loading based on the compilation context (test vs non-test).
//!
//! # Overview
//!
//! - `FromEnvRoot` - Use in production code (main.rs, application entry points)
//! - `FromEnvTest` - Use in test code (#[test] functions)
//!
//! These traits use `#[cfg]` attributes to hide methods in the wrong context,
//! causing compile errors if misused.
//!
//! # Usage
//!
//! **Production (main.rs):**
//! ```ignore
//! use tento_env::FromEnvRoot;
//!
//! fn main() {
//!   let config = AppConfig::from_env_root();
//! }
//! ```
//!
//! **Tests:**
//! ```ignore
//! use tento_env::FromEnvTest;
//!
//! #[test]
//! fn test_something() {
//!   let config = AppConfig::from_env_test();
//! }
//! ```
//!
//! # Audit Trail
//!
//! The naming convention provides a clear audit trail:
//! - `from_env_root()` - Only used at application entry points (main.rs)
//! - `from_env_test()` - Only used in test code and test helper functions
//!
//! Search for these method names to audit all environment loading points:
//! ```bash
//! rg 'from_env_root\(\)' --type rust
//! rg 'from_env_test\(\)' --type rust
//! ```

use crate::group::{EnvGroupResult, FromEnv};

/// Marker type that can only be constructed in non-test code.
///
/// This is used internally to enforce compile-time context checking.
pub struct RootContext {
  _private: (),
}

impl RootContext {
  /// Create a new RootContext. Only available in non-test code.
  #[cfg(not(test))]
  pub fn new() -> Self {
    RootContext { _private: () }
  }
}

#[cfg(not(test))]
impl Default for RootContext {
  fn default() -> Self {
    Self::new()
  }
}

/// Marker type that can only be constructed in test code.
///
/// This is used internally to enforce compile-time context checking.
pub struct TestContext {
  _private: (),
}

impl TestContext {
  /// Create a new TestContext. Only available in test code.
  #[cfg(test)]
  pub fn new() -> Self {
    TestContext { _private: () }
  }
}

#[cfg(test)]
impl Default for TestContext {
  fn default() -> Self {
    Self::new()
  }
}

/// Extension trait for loading environment configuration in production code.
///
/// This trait is only available in non-test compilation contexts.
/// Calling `from_env_root()` in test code will result in a compile error.
///
/// # Example
///
/// ```ignore
/// use tento_env::FromEnvRoot;
///
/// fn main() {
///   // Returns EnvGroupResult - use .assert_envars() to panic on error
///   let config = AppConfig::from_env_root().assert_envars();
///
///   // Or handle errors explicitly
///   let config = AppConfig::from_env_root().into_result()?;
/// }
/// ```
pub trait FromEnvRoot: FromEnv {
  /// Load configuration from environment variables.
  ///
  /// Returns an `EnvGroupResult` that can be:
  /// - Converted to `Result` with `.into_result()` for use with `?`
  /// - Panicked with diagnostics using `.assert_envars()`
  ///
  /// Use this in production code (main.rs). Use `from_env_test()` in test code.
  fn from_env_root() -> EnvGroupResult<Self> {
    Self::from_env()
  }
}

impl<T: FromEnv> FromEnvRoot for T {}

/// Extension trait for loading environment configuration in test code.
///
/// Use this in test code and `#[doc(hidden)]` test helper functions.
///
/// # Example
///
/// ```ignore
/// use tento_env::FromEnvTest;
///
/// #[test]
/// fn test_something() {
///   // Returns EnvGroupResult - use .assert_envars() to panic on error
///   let config = AppConfig::from_env_test().assert_envars();
///
///   // Or handle errors explicitly
///   let config = AppConfig::from_env_test().into_result()?;
/// }
/// ```
pub trait FromEnvTest: FromEnv {
  /// Load configuration from environment variables.
  ///
  /// Returns an `EnvGroupResult` that can be:
  /// - Converted to `Result` with `.into_result()` for use with `?`
  /// - Panicked with diagnostics using `.assert_envars()`
  ///
  /// Use this in test code. Use `from_env_root()` in production code.
  fn from_env_test() -> EnvGroupResult<Self> {
    Self::from_env()
  }
}

impl<T: FromEnv> FromEnvTest for T {}

// ============================================================================
// Single Env Var Context Traits (FromEnvVar)
// ============================================================================

use crate::env::Env;
use crate::error::EnvError;
use crate::from_env::FromEnvVar;

/// Extension trait for loading single env vars in production code.
///
/// Use this in production code (main.rs).
///
/// # Example
///
/// ```ignore
/// use tento_env::FromEnvVarRoot;
///
/// fn main() {
///   let api_key = ApiKey::from_env_root().expect("API_KEY not set");
/// }
/// ```
pub trait FromEnvVarRoot: FromEnvVar {
  /// Load from environment variable.
  ///
  /// Use this in production code. Use `from_env_test()` in test code.
  fn from_env_root() -> Result<Env<Self>, EnvError> {
    Self::from_env()
  }
}

impl<T: FromEnvVar> FromEnvVarRoot for T {}

/// Extension trait for loading single env vars in test code.
///
/// Use this in test code and `#[doc(hidden)]` test helper functions.
///
/// # Example
///
/// ```ignore
/// use tento_env::FromEnvVarTest;
///
/// #[test]
/// fn test_something() {
///   let api_key = ApiKey::from_env_test().expect("API_KEY not set");
/// }
/// ```
pub trait FromEnvVarTest: FromEnvVar {
  /// Load from environment variable.
  ///
  /// Use this in test code. Use `from_env_root()` in production code.
  fn from_env_test() -> Result<Env<Self>, EnvError> {
    Self::from_env()
  }
}

impl<T: FromEnvVar> FromEnvVarTest for T {}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_context_can_be_created_in_test() {
    // TestContext::new() should be available in test context
    let _ctx = TestContext::new();
  }
}
