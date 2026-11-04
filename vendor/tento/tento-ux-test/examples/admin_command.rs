//! Qualify a configured admin command through the same HostPort as spec setup.
//! Usage: admin_command /absolute/config.json <verb> < params.json
//! Only read/non-sensitive bindings can be configured in this first slice.
use std::io::Read;
use tento_ux_test::{HostPort, command_port::Config};

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::process::ExitCode {
  match run().await {
    Ok(()) => std::process::ExitCode::SUCCESS,
    Err(error) => {
      eprintln!("{error}");
      std::process::ExitCode::FAILURE
    }
  }
}

async fn run() -> anyhow::Result<()> {
  let args: Vec<_> = std::env::args().skip(1).collect();
  anyhow::ensure!(
    args.len() == 2 && std::path::Path::new(&args[0]).is_absolute(),
    "usage: admin_command /absolute/config.json <verb> < params.json"
  );
  let config = Config::load(std::path::Path::new(&args[0]))?;
  let port = HostPort::from_commands(config)?;
  let mut bytes = Vec::new();
  std::io::stdin()
    .take(1024 * 1024 + 1)
    .read_to_end(&mut bytes)?;
  anyhow::ensure!(bytes.len() <= 1024 * 1024, "admin input too large");
  let params =
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid admin JSON input"))?;
  let result = port.execute_verb(&args[1], params).await?;
  println!("{}", serde_json::to_string(&result)?);
  Ok(())
}
