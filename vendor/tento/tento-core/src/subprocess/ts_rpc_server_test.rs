use crate::TentoCore;
use crate::subprocess::SubprocessRpc;
use std::time::Duration;
use tento_env::FromEnvVarTest;
use tokio::process::Command;
use tokio::time::sleep;
use tracing::info;

/// Test the TypeScript RPC server implementation
#[tokio::test]
async fn test_typescript_rpc_server() -> anyhow::Result<()> {
  crate::test_utils::init_tracing();

  info!("=== STARTING TYPESCRIPT RPC SERVER TEST ===");

  use tento_env::AssertEnvVar;
  let calculator_path = TentoCore::from_env_test()
    .assert_envars()
    .into_value()
    .get_typescript_calculator_path()?;

  // Create a subprocess RPC client for the TypeScript server
  let subprocess = SubprocessRpc::new("TsCalculator".to_string(), move || {
    let mut cmd = Command::new("deno");
    cmd
      .arg("run")
      .arg("--allow-read")
      .arg("--allow-write")
      .arg("--unstable")
      .arg(&calculator_path);
    cmd
  });

  info!("TypeScript RPC client created, subprocess not started yet");

  // Allow time for the server to start up properly
  sleep(Duration::from_millis(500)).await;

  // Test addition
  info!("Testing addition operation");
  let result = subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": 3,
          "d": 5,
      }),
    )
    .await?;

  info!("Addition result: {}", result.response);
  assert_eq!(result.response["value"], 8);

  // Test subtraction
  info!("Testing subtraction operation");
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

  // Test multiplication
  info!("Testing multiplication operation");
  let result = subprocess
    .call(
      "multiply".to_string(),
      serde_json::json!({
          "n": 6,
          "d": 7,
      }),
    )
    .await?;

  info!("Multiplication result: {}", result.response);
  assert_eq!(result.response["value"], 42);

  // Test division
  info!("Testing division operation");
  let result = subprocess
    .call(
      "divide".to_string(),
      serde_json::json!({
          "n": 100,
          "d": 5,
      }),
    )
    .await?;

  info!("Division result: {}", result.response);
  assert_eq!(result.response["value"], 20.0);

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

  // Test behavior with large numbers
  info!("Testing large number addition");
  let result = subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": 1000000,
          "d": 2000000,
      }),
    )
    .await?;

  info!("Large number addition result: {}", result.response);
  assert_eq!(result.response["value"], 3000000);

  // Test behavior with negative numbers
  info!("Testing with negative numbers");
  let result = subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": -50,
          "d": -25,
      }),
    )
    .await?;

  info!("Negative number addition result: {}", result.response);
  assert_eq!(result.response["value"], -75);

  Ok(())
}

#[tokio::test]
async fn test_typescript_rpc_server_nonexistent() -> anyhow::Result<()> {
  crate::test_utils::init_tracing();

  info!("=== STARTING TYPESCRIPT RPC SERVER TEST ===");

  use tento_env::AssertEnvVar;
  let calculator_path = TentoCore::from_env_test()
    .assert_envars()
    .into_value()
    .get_typescript_calculator_path()?;

  // Create a subprocess RPC client for the TypeScript server
  let subprocess = SubprocessRpc::new("TsCalculator".to_string(), move || {
    let mut cmd = Command::new("deno");
    cmd
      .arg("run")
      .arg("--allow-read")
      .arg("--allow-write")
      .arg("--unstable")
      .arg(&calculator_path);
    cmd
  });

  // Test behavior with a non-existent method
  info!("Testing non-existent method (should return error)");
  let result = subprocess
    .call(
      "nonexistent_method".to_string(),
      serde_json::json!({
          "n": 1,
          "d": 2,
      }),
    )
    .await?;

  info!("Non-existent method response: {}", result.response);
  assert!(result.response.get("error").is_some());

  // Test behavior with invalid inputs
  info!("Testing invalid inputs (should return error)");
  let result = subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": "not_a_number",
          "d": 5,
      }),
    )
    .await?;

  info!("Invalid input response: {}", result.response);
  assert!(result.response.get("error").is_some());

  Ok(())
}

#[tokio::test]
async fn test_typescript_rpc_server_restart() -> anyhow::Result<()> {
  crate::test_utils::init_tracing();

  info!("=== STARTING TYPESCRIPT RPC SERVER TEST ===");

  use tento_env::AssertEnvVar;
  let calculator_path = TentoCore::from_env_test()
    .assert_envars()
    .into_value()
    .get_typescript_calculator_path()?;

  // Create a subprocess RPC client for the TypeScript server
  let subprocess = SubprocessRpc::new("TsCalculator".to_string(), move || {
    let mut cmd = Command::new("deno");
    cmd
      .arg("run")
      .arg("--allow-read")
      .arg("--allow-write")
      .arg("--unstable")
      .arg(&calculator_path);
    cmd
  });

  // Test behavior with invalid inputs
  info!("Testing invalid inputs (should return error)");
  let result = subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": "not_a_number",
          "d": 5,
      }),
    )
    .await?;

  info!("Invalid input response: {}", result.response);
  assert!(result.response.get("error").is_some());

  // Test subprocess restart capability
  info!("\nTesting subprocess restart capability...");

  // Force a complete reset by setting inner to None
  {
    let mut inner_guard = subprocess.inner.lock().await;

    // If the subprocess has a child process, try to kill it first
    if let Some(inner) = inner_guard.as_mut() {
      // Try to send SIGTERM to child process
      let _ = inner.child.start_kill();
    }

    *inner_guard = None;
    info!("Subprocess connection manually reset");
  }

  // Give the system time to clean up
  sleep(Duration::from_millis(500)).await;

  // Try a new call, which should restart the subprocess
  info!("Making call after reset (should restart the subprocess)");
  let result = subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": 10,
          "d": 10,
      }),
    )
    .await?;

  info!("Post-restart addition result: {}", result.response);
  assert_eq!(result.response["value"], 20);

  // Kill the child process at the end to ensure cleanup
  {
    let mut inner_guard = subprocess.inner.lock().await;
    if let Some(inner) = inner_guard.as_mut() {
      let _ = inner.child.start_kill();
    }
    *inner_guard = None;
  }

  info!("All TypeScript RPC server tests passed!");
  Ok(())
}

/// Test the interoperability between Rust and TypeScript
#[tokio::test]
async fn test_typescript_pong_response() -> anyhow::Result<()> {
  crate::test_utils::init_tracing();

  info!("=== STARTING TYPESCRIPT PING/PONG TEST ===");

  use tento_env::AssertEnvVar;
  let calculator_path = TentoCore::from_env_test()
    .assert_envars()
    .into_value()
    .get_typescript_calculator_path()?;

  // Create a subprocess RPC client for the TypeScript server
  let subprocess = SubprocessRpc::new("TsPingPongTest".to_string(), move || {
    let mut cmd = Command::new("deno");
    cmd
      .arg("run")
      .arg("--allow-read")
      .arg("--allow-write")
      .arg("--unstable")
      .arg(&calculator_path);
    cmd
  });

  // Send a simple add request to verify basic communication
  info!("Sending initial RPC request to verify connection");
  let result = subprocess
    .call(
      "add".to_string(),
      serde_json::json!({
          "n": 1,
          "d": 1,
      }),
    )
    .await?;

  info!("Initial RPC response: {}", result.response);
  assert_eq!(result.response["value"], 2);

  // Check health status after successful communication
  info!("Checking health status after communication");
  assert!(
    subprocess.is_healthy(),
    "Subprocess should be healthy after successful communication"
  );

  // Ping should be automatically happening, but we can look at how the server responds
  // by checking is_healthy flag after a short delay
  info!("Waiting for automatic ping/pong exchange...");
  sleep(Duration::from_secs(6)).await; // Wait long enough for a ping to be sent (default interval is 5s)

  // Check health status again after ping/pong
  info!("Checking health status after ping/pong exchange");
  assert!(
    subprocess.is_healthy(),
    "Subprocess should still be healthy after ping/pong exchange"
  );

  // Make another RPC call to verify the connection is still working
  info!("Making another RPC call after ping/pong exchange");
  let result = subprocess
    .call(
      "multiply".to_string(),
      serde_json::json!({
          "n": 3,
          "d": 4,
      }),
    )
    .await?;

  info!("Post-ping RPC response: {}", result.response);
  assert_eq!(result.response["value"], 12);

  // Kill the child process at the end to ensure cleanup
  {
    let mut inner_guard = subprocess.inner.lock().await;
    if let Some(inner) = inner_guard.as_mut() {
      let _ = inner.child.start_kill();
    }
    *inner_guard = None;
  }

  info!("TypeScript ping/pong tests passed!");
  Ok(())
}
