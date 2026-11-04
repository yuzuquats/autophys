//! Where the queue is, and which one.
//!
//! Two keys, both optional: a host that runs `tsh serve` in its usual place
//! and one queue needs neither. They are `env_kv!` newtypes so a file or
//! store backend is seen, and a product embeds [`QueueEnv`] in its own
//! `FromEnv` struct as an `EnvGroup<QueueEnv>` — one load, every bad key
//! named at once.

use std::path::PathBuf;

use tento_env::{Env, FromEnv, env_kv};

use crate::error::QueueError;

env_kv!(TshServeSocket, "TSH_SERVE_SOCKET", PathBuf);
env_kv!(AgentQueueName, "TENTO_AGENT_QUEUE", String);

#[derive(Debug, Clone, FromEnv)]
pub struct QueueEnv {
  pub socket: Option<Env<TshServeSocket>>,
  pub queue: Option<Env<AgentQueueName>>,
}

impl QueueEnv {
  pub fn load() -> crate::Result<Self> {
    Self::from_env()
      .into_result()
      .map_err(|error| QueueError::Invalid(error.to_string()))
  }

  /// `tsh serve`'s socket: `TSH_SERVE_SOCKET`, else the path serve binds by
  /// default (`~/.local/share/tento/tsh-serve/serve.sock`).
  pub fn socket_path(&self) -> crate::Result<PathBuf> {
    match &self.socket {
      Some(value) => Ok(value.value().0.clone()),
      None => Ok(
        tento_env::app_data_dir("tsh-serve", None)
          .map_err(|error| QueueError::Invalid(format!("resolve the tsh-serve data dir: {error}")))?
          .join("serve.sock"),
      ),
    }
  }

  /// The queue to enqueue into. A host runs several: lanes and concurrency
  /// caps are declared per queue by the host's rc, never by a product.
  pub fn queue_name(&self) -> String {
    self
      .queue
      .as_ref()
      .map(|value| value.value().0.clone())
      .unwrap_or_else(|| "default".to_string())
  }
}
