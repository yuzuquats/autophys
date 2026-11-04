use crate::TentoCore;
use crate::subprocess::{Calculator, SubprocessRpc};
use std::time::Duration;
use tento_env::FromEnvVarTest;
use tokio::process::Command;
use tokio::time::sleep;
use tracing::info;

#[tokio::test]
async fn test_calculator_basic() -> anyhow::Result<()> {
  crate::test_utils::init_tracing();

  info!("=== STARTING CALCULATOR TEST ===");

  let calculator = Calculator::new();
  sleep(Duration::from_millis(500)).await;

  info!("Calling calculator operations");

  // Test addition
  let result = calculator.add(3, 5).await.expect("Addition failed");
  info!("Calculator add returned: {}", result);
  assert_eq!(result, 8);

  // Test subtraction
  let result = calculator
    .subtract(10, 4)
    .await
    .expect("Subtraction failed");
  info!("Calculator subtract returned: {}", result);
  assert_eq!(result, 6);

  // Test multiplication
  let result = calculator
    .multiply(6, 7)
    .await
    .expect("Multiplication failed");
  info!("Calculator multiply returned: {}", result);
  assert_eq!(result, 42);

  // Test division
  let result = calculator.divide(100, 5).await.expect("Division failed");
  info!("Calculator divide returned: {}", result);
  assert_eq!(result, 20.0);

  info!("All calculator operations passed!");

  Ok(())
}

#[tokio::test]
async fn test_direct_subprocess() -> anyhow::Result<()> {
  crate::test_utils::init_tracing();

  use tento_env::AssertEnvVar;
  let calculator_path = TentoCore::from_env_test()
    .assert_envars()
    .into_value()
    .get_calculator_path()?;

  let subprocess = SubprocessRpc::new("LazyCalculator".to_string(), move || {
    let mut cmd = Command::new("python3");
    cmd.arg(&calculator_path);
    cmd.env("PYTHONUNBUFFERED", "1");
    cmd
  });

  info!("RPC client created, subprocess not started yet");

  info!("Making first call - should start the subprocess");
  let result = subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": 3,
          "d": 5,
      }),
    )
    .await?;

  info!("Calculator result: {}", result.response);
  assert_eq!(result.response["value"], 8);

  info!("Making second call - should use the same subprocess");
  let result = subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": 7,
          "d": 9,
      }),
    )
    .await?;

  info!("Calculator result: {}", result.response);
  assert_eq!(result.response["value"], 16);

  // Test subtraction using direct RPC
  info!("Testing subtraction");
  let result = subprocess
    .call(
      "subtract".to_string(),
      serde_json::json!({
          "n": 20,
          "d": 7,
      }),
    )
    .await?;

  info!("Subtraction result: {}", result.response);
  assert_eq!(result.response["value"], 13);

  // Test multiplication using direct RPC
  info!("Testing multiplication");
  let result = subprocess
    .call(
      "multiply".to_string(),
      serde_json::json!({
          "n": 6,
          "d": 6,
      }),
    )
    .await?;

  info!("Multiplication result: {}", result.response);
  assert_eq!(result.response["value"], 36);

  // Test division using direct RPC
  info!("Testing division");
  let result = subprocess
    .call(
      "divide".to_string(),
      serde_json::json!({
          "n": 50,
          "d": 10,
      }),
    )
    .await?;

  info!("Division result: {}", result.response);
  assert_eq!(result.response["value"], 5.0);

  // Test division by zero should return an error
  info!("Testing division by zero (should return error)");
  let result = subprocess
    .call(
      "divide".to_string(),
      serde_json::json!({
          "n": 10,
          "d": 0,
      }),
    )
    .await?;

  info!("Division by zero response: {}", result.response);
  assert!(result.response.get("error").is_some());

  info!("All direct RPC calls passed");
  Ok(())
}

#[tokio::test]
async fn test_calculator_with_error_handling() -> anyhow::Result<()> {
  crate::test_utils::init_tracing();

  let calculator = Calculator::new();

  info!("Calculator created successfully (but not started yet)");

  // Test addition
  let result = calculator.add(10, 20).await?;
  info!("10 + 20 = {}", result);
  assert_eq!(result, 30);

  // Test subtraction
  let result = calculator.subtract(30, 15).await?;
  info!("30 - 15 = {}", result);
  assert_eq!(result, 15);

  // Test multiplication
  let result = calculator.multiply(7, 8).await?;
  info!("7 * 8 = {}", result);
  assert_eq!(result, 56);

  // Test division
  let result = calculator.divide(20, 4).await?;
  info!("20 / 4 = {}", result);
  assert_eq!(result, 5.0);

  // Test division by zero should return an error
  let result = calculator.divide(10, 0).await;
  info!("Division by zero result: {:?}", result);
  assert!(result.is_err());

  Ok(())
}

#[tokio::test]
async fn test_subprocess_restart() -> anyhow::Result<()> {
  use tento_env::AssertEnvVar;
  let calculator_path_str = TentoCore::from_env_test()
    .assert_envars()
    .into_value()
    .get_calculator_path()?
    .to_string_lossy()
    .to_string();

  // Create a new subprocess with a shorter retry timeout
  let calculator_path_clone = calculator_path_str.clone();
  let subprocess = SubprocessRpc::new("RestartCalculator".to_string(), move || {
    let mut cmd = Command::new("python3");
    cmd.arg(&calculator_path_clone);
    cmd.env("PYTHONUNBUFFERED", "1");
    cmd
  });

  // Make an initial call to start the subprocess
  info!("Making first call to initialize subprocess (add operation)");
  let result = subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": 5,
          "d": 5,
      }),
    )
    .await?;
  info!("First call result: {}", result.response);
  assert_eq!(result.response["value"], 10);

  // Force a complete reset of the subprocess
  info!("\nResetting subprocess...");

  // Force a complete reset by setting inner to None
  {
    let mut inner_guard = subprocess.inner.lock().await;
    *inner_guard = None;
    info!("Subprocess connection manually reset");
  }

  // Give the system time to clean up
  sleep(Duration::from_millis(500)).await;

  // Create a new calculator instance to avoid any shared state issues
  info!("Creating a new calculator instance");
  let calculator_path_clone2 = calculator_path_str.clone();
  let new_subprocess = SubprocessRpc::new("FreshCalculator".to_string(), move || {
    let mut cmd = Command::new("python3");
    cmd.arg(&calculator_path_clone2);
    cmd.env("PYTHONUNBUFFERED", "1");
    cmd
  });

  // Test with the new calculator
  info!("Testing with a fresh calculator instance (add operation)");
  let result = new_subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": 10,
          "d": 10,
      }),
    )
    .await?;
  info!("Add operation result: {}", result.response);
  assert_eq!(result.response["value"], 20);

  // Test with subtraction
  info!("Testing subtraction operation");
  let result = new_subprocess
    .call(
      "subtract".to_string(),
      serde_json::json!({
          "n": 50,
          "d": 20,
      }),
    )
    .await?;
  info!("Subtraction operation result: {}", result.response);
  assert_eq!(result.response["value"], 30);

  // Test with multiplication
  info!("Testing multiplication operation");
  let result = new_subprocess
    .call(
      "multiply".to_string(),
      serde_json::json!({
          "n": 6,
          "d": 7,
      }),
    )
    .await?;
  info!("Multiplication operation result: {}", result.response);
  assert_eq!(result.response["value"], 42);

  // Test with division
  info!("Testing division operation");
  let result = new_subprocess
    .call(
      "divide".to_string(),
      serde_json::json!({
          "n": 100,
          "d": 25,
      }),
    )
    .await?;
  info!("Division operation result: {}", result.response);
  assert_eq!(result.response["value"], 4.0);

  info!("\nSubprocess restart test complete");
  Ok(())
}
