use anyhow::Context;
use serde_json::json;
use tokio::process::Command;

use super::rpc::SubprocessRpc;

/// Calculator client that uses our subprocess RPC
pub struct Calculator {
  subprocess: SubprocessRpc,
}

impl Default for Calculator {
  fn default() -> Self {
    Self::new()
  }
}

impl Calculator {
  /// Create a new calculator instance with error handling and lazy initialization
  pub fn new() -> Self {
    let subprocess = SubprocessRpc::new("Calculator".to_string(), || {
      let mut c = Command::new("python3");
      c.args(["calculator.py"]);
      // `calculator.py` ships beside this file, so locate it from the crate
      // rather than from an absolute path: the previous literal pointed at one
      // developer's Linux home and could not resolve on any other machine,
      // which is why both RPC tests failed with ENOENT rather than a spawn
      // error worth reading.
      c.current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/src/subprocess"));
      c.env("PYTHONUNBUFFERED", "1");
      c
    });
    Calculator { subprocess }
  }

  /// Helper method to handle common result parsing
  async fn call_operation(&self, method: &str, n: i64, d: i64) -> anyhow::Result<f64> {
    let result = self
      .subprocess
      .call(
        method.to_string(),
        json!({
            "n": n,
            "d": d,
        }),
      )
      .await
      .context(format!("{}/error", method))?;

    let parsed = result.response;

    // Check for error
    if let Some(error) = parsed.get("error").and_then(|e| e.as_str()) {
      return Err(anyhow::anyhow!("RPC error: {}", error));
    }

    // Get value (allow for both integer and float results)
    if let Some(value) = parsed.get("value").and_then(|v| v.as_f64()) {
      Ok(value)
    } else if let Some(value) = parsed.get("value").and_then(|v| v.as_i64()) {
      Ok(value as f64)
    } else {
      Err(anyhow::anyhow!(
        "Result did not contain a valid numeric value"
      ))
    }
  }

  /// Add two numbers
  pub async fn add(&self, n: i64, d: i64) -> anyhow::Result<i64> {
    let result = self.call_operation("add", n, d).await?;
    Ok(result as i64)
  }

  /// Subtract d from n
  pub async fn subtract(&self, n: i64, d: i64) -> anyhow::Result<i64> {
    let result = self.call_operation("subtract", n, d).await?;
    Ok(result as i64)
  }

  /// Multiply n and d
  pub async fn multiply(&self, n: i64, d: i64) -> anyhow::Result<i64> {
    let result = self.call_operation("multiply", n, d).await?;
    Ok(result as i64)
  }

  /// Divide n by d
  pub async fn divide(&self, n: i64, d: i64) -> anyhow::Result<f64> {
    self.call_operation("divide", n, d).await
  }
}
