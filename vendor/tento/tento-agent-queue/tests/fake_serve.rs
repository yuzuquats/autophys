//! The tsh backend against tsh-web's `fake_serve.py`, which speaks the same
//! `tsh.serve/v2` framing and answers `plugin.call {method: "show"}` with a
//! canned job record.
//!
//! Gated on `TENTO_AGENT_QUEUE_FAKE_SERVE` naming that script: it lives in
//! the tsh checkout, which is not this repository's to assume. Without the
//! key the test reports why it did nothing and passes — an unrunnable
//! integration test must not read as a broken one.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use tento_agent_queue::{JobState, TshBackend};

struct FakeServe {
  child: Child,
  socket: PathBuf,
}

impl FakeServe {
  fn start(script: &str) -> FakeServe {
    let mut child = Command::new("python3")
      .arg(script)
      .arg("-")
      .env("FAKE_SERVE_QUIET", "1")
      .stdout(Stdio::piped())
      .spawn()
      .expect("start fake_serve.py");
    // It prints the socket path it bound, then blocks.
    let stdout = child.stdout.take().expect("fake serve stdout");
    let mut line = String::new();
    BufReader::new(stdout)
      .read_line(&mut line)
      .expect("fake serve announced its socket");
    FakeServe {
      child,
      socket: PathBuf::from(line.trim()),
    }
  }
}

impl Drop for FakeServe {
  fn drop(&mut self) {
    let _ = self.child.kill();
    let _ = self.child.wait();
  }
}

fn script() -> Option<String> {
  // Read through tento-env, like every other key this crate reads.
  tento_env::env_kv!(FakeServeScript, "TENTO_AGENT_QUEUE_FAKE_SERVE", String);
  use tento_env::FromEnvVar;
  FakeServeScript::from_env()
    .ok()
    .map(|value| value.into_value().0)
    .filter(|path| !path.is_empty())
}

#[tokio::test]
async fn the_backend_speaks_the_serve_contract() {
  let Some(script) = script() else {
    eprintln!(
      "skipped: set TENTO_AGENT_QUEUE_FAKE_SERVE to tsh/crates/tsh-web/tests/fake_serve.py"
    );
    return;
  };
  let fake = FakeServe::start(&script);
  let backend = TshBackend::new(&fake.socket).with_serve_dir(fake.socket.parent().unwrap());

  let hello = backend.hello().await.expect("hello");
  assert_eq!(hello["schema"], "tsh.serve/v2");

  // `plugin.call` is forwarded verbatim, so what comes back is the daemon's
  // own job record — the shape this crate's model has to read.
  let job = backend
    .plugin_call("show", serde_json::json!({"job": "job-7"}))
    .await
    .expect("plugin.call show");
  let job: tento_agent_queue::Job = serde_json::from_value(job).expect("a job record");
  assert_eq!(job.id, "job-7");
  assert_eq!(job.state, JobState::Running);
  assert_eq!(job.policy.max_attempts, 3);
  assert_eq!(job.attempts.len(), 2);
  assert_eq!(job.result.expect("a result").datatype, "demo/v1");

  // A subscription seeds from the snapshot without inventing a change.
  let changes = futures::StreamExt::take(backend_changes(&backend), 1);
  let seen = tokio::time::timeout(
    Duration::from_millis(400),
    futures::StreamExt::count(changes),
  )
  .await
  .unwrap_or(0);
  assert_eq!(seen, 0, "the seed snapshot is not a movement");
}

fn backend_changes(
  backend: &TshBackend,
) -> std::pin::Pin<Box<dyn futures::Stream<Item = tento_agent_queue::Change> + Send>> {
  use tento_agent_queue::Backend;
  backend.changes()
}
