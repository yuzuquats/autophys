//! Integration tests for context-aware environment loading.
//!
//! Note: from_env_test() and TestContext are not available in integration tests
//! because tento_env is compiled as a library (not in test mode) when used
//! as a dependency. This is the intended behavior - from_env_test() is designed
//! for unit tests within the crate that uses it.
//!
//! This test file verifies that from_env_root() works correctly from outside the
//! crate (simulating production usage).

use tento_env::{Env, EnvGroup, FromEnv, FromEnvRoot, PrintEnv, env_kv};

env_kv!(
  "TEST_ROOT_VAR",
  String,
  default = "root_default".to_string()
);
env_kv!("TEST_OPTIONAL_VAR", String);
env_kv!("NESTED_VAR_A", String, default = "nested_a".to_string());
env_kv!("NESTED_VAR_B", u16, default = 42);

#[derive(Debug, FromEnv)]
struct NestedConfig {
  nested_var_a: Env<NestedVarA>,
  nested_var_b: Env<NestedVarB>,
}

#[derive(Debug, FromEnv)]
struct RootTestConfig {
  test_root_var: Env<TestRootVar>,
  test_optional_var: Option<Env<TestOptionalVar>>,
}

#[derive(Debug, FromEnv)]
struct ConfigWithNested {
  test_root_var: Env<TestRootVar>,
  nested: EnvGroup<NestedConfig>,
}

#[test]
fn test_from_env_root_works_from_integration_test() {
  // from_env_root() is available because tento_env is compiled as a library
  // (not in test mode) when used as a dependency
  let config = RootTestConfig::from_env_root().assert_envars();
  assert_eq!(**config.test_root_var, "root_default");
}

/// Serializes the two tests that mutate the SHARED process-global
/// `TEST_OPTIONAL_VAR`: the default parallel harness let one test's
/// `remove_var` race the other's `set_var`, flaking whichever read second.
static OPTIONAL_VAR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn test_print_env_formats_correctly() {
  let _guard = OPTIONAL_VAR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  // Clear env var to ensure test isolation from the sibling setter.
  unsafe {
    std::env::remove_var("TEST_OPTIONAL_VAR");
  }

  let config = RootTestConfig::from_env_root().assert_envars();
  let output = config.fmt_env();

  assert!(output.contains("RootTestConfig:"));
  assert!(output.contains("TEST_ROOT_VAR"));
  assert!(output.contains("root_default"));
  // Output now includes color codes, so check for components separately
  assert!(output.contains("TEST_OPTIONAL_VAR"));
  assert!(output.contains("<not set>") || output.contains("not set"));
}

#[test]
fn test_print_env_with_optional_set() {
  let _guard = OPTIONAL_VAR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  unsafe {
    std::env::set_var("TEST_OPTIONAL_VAR", "optional_value");
  }

  let config = RootTestConfig::from_env_root().assert_envars();
  let output = config.fmt_env();

  assert!(output.contains("  TEST_OPTIONAL_VAR:"));
  assert!(output.contains("optional_value"));
  assert!(!output.contains("<not set>"));

  unsafe {
    std::env::remove_var("TEST_OPTIONAL_VAR");
  }
}

#[test]
fn test_print_env_with_nested_config() {
  let config = ConfigWithNested::from_env_root().assert_envars();
  let output = config.fmt_env();

  // Should show struct name
  assert!(output.contains("ConfigWithNested:"));

  // Should show root var indented
  assert!(output.contains("  TEST_ROOT_VAR:"));

  // Should show nested field name
  assert!(output.contains("  nested:"));

  // Should show nested vars with extra indentation
  assert!(output.contains("    NESTED_VAR_A:"));
  assert!(output.contains("    NESTED_VAR_B:"));

  // Verify values
  assert!(output.contains("root_default"));
  assert!(output.contains("nested_a"));
  assert!(output.contains("42"));

  println!("Nested output:\n{}", output);
}
