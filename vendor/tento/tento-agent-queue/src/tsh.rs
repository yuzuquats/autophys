//! The queue tsh runs, reached through `tsh serve`.
//!
//! Every call is one `plugin.call` on serve's socket, forwarded verbatim to
//! the `tsh-agent-queue` daemon, which gives each attempt its own saved tsh
//! session and owns dispatch, retries, timeouts, cancellation and result
//! decoding. This crate adds no policy on top of that: it translates a job
//! request into the daemon's parameters and its record back into [`Job`].
//!
//! Changes come from serve's task stream (`tasks.subscribe`), which is the
//! one place a host publishes what its work is doing — so a product learns
//! that a job moved without polling, and an operator's terminal sees the same
//! movement in the same feed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::auth::{Connection, RemoteError};
use crate::backend::{Backend, BoxStream, Change, Enqueued, ListFilter};
use crate::error::{QueueError, Result};
use crate::model::{Job, JobState};
use crate::new_job::{CancelReason, NewJob};

/// The plugin that runs the jobs. One name, in one place.
pub const BUNDLE: &str = "tsh-agent-queue";

/// How this client names itself to serve.
const BRIDGE: &str = "tento-agent-queue/1";

const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// How long to wait before reconnecting a dropped subscription, and the
/// ceiling that backoff climbs to.
const RETRY_MIN: Duration = Duration::from_millis(500);
const RETRY_MAX: Duration = Duration::from_secs(10);

pub struct TshBackend {
  socket: PathBuf,
  serve_dir: PathBuf,
}

impl TshBackend {
  pub fn new(socket: impl Into<PathBuf>) -> Self {
    Self {
      socket: socket.into(),
      serve_dir: operator_serve_dir(),
    }
  }

  pub fn socket(&self) -> &Path {
    &self.socket
  }

  /// Serve's own greeting — what a health check asks for, because it proves
  /// the socket answers without touching a job.
  pub fn with_serve_dir(mut self, path: impl Into<PathBuf>) -> Self {
    self.serve_dir = path.into();
    self
  }
  pub async fn hello(&self) -> Result<Value> {
    self.call("hello", json!({"bridge":BRIDGE})).await
  }
  async fn call(&self, method: &str, params: Value) -> Result<Value> {
    let socket = self.socket.clone();
    let dir = self.serve_dir.clone();
    let method = method.to_string();
    with_timeout(async move {
      tokio::task::spawn_blocking(move || {
        let mut conn = Connection::open(&socket, &dir).map_err(map_error)?;
        conn.call(&method, params, None).map_err(map_error)
      })
      .await
      .map_err(|e| QueueError::Unavailable(e.to_string()))?
    })
    .await
  }
  pub async fn plugin_call(&self, method: &str, params: Value) -> Result<Value> {
    self
      .call(
        "plugin.call",
        json!({"bundle":BUNDLE,"method":method,"params":params}),
      )
      .await
  }

  async fn job_call(&self, method: &str, params: Value) -> Result<Job> {
    let answer = self.plugin_call(method, params).await?;
    serde_json::from_value(answer).map_err(QueueError::decode("a job record"))
  }
}

fn operator_serve_dir() -> PathBuf {
  // The same passwd-home directory tsh fences, independent of lane HOME.
  unsafe {
    let mut pwd: libc::passwd = std::mem::zeroed();
    let mut buffer = vec![0u8; 65536];
    let mut result = std::ptr::null_mut();
    if libc::getpwuid_r(
      libc::geteuid(),
      &mut pwd,
      buffer.as_mut_ptr().cast(),
      buffer.len(),
      &mut result,
    ) == 0
      && !result.is_null()
      && !pwd.pw_dir.is_null()
    {
      return PathBuf::from(
        std::ffi::CStr::from_ptr(pwd.pw_dir)
          .to_string_lossy()
          .as_ref(),
      )
      .join(".local/share/tento/tsh-serve");
    }
  }
  PathBuf::from("/nonexistent/operator-home/tsh-serve")
}
fn map_error(error: anyhow::Error) -> QueueError {
  if let Some(RemoteError(value)) = error.downcast_ref::<RemoteError>() {
    return QueueError::from_rpc(
      value["code"].as_i64().unwrap_or(-32000) as i32,
      value["message"].as_str().unwrap_or("serve error").into(),
      value.get("data").cloned(),
    );
  }
  QueueError::Unavailable(format!("authenticated tsh serve: {error:#}"))
}

async fn with_timeout<T>(work: impl Future<Output = Result<T>>) -> Result<T> {
  tokio::time::timeout(CALL_TIMEOUT, work)
    .await
    .map_err(|_| QueueError::Timeout(CALL_TIMEOUT))?
}

#[async_trait]
impl Backend for TshBackend {
  fn name(&self) -> &'static str {
    "tsh"
  }

  async fn enqueue(&self, job: NewJob) -> Result<Enqueued> {
    let queue = job.queue.clone().unwrap_or_else(|| "default".into());
    let producer = job.producer_id.clone().unwrap_or_default();
    let answer = self
      .plugin_call("enqueue", job.enqueue_params(&queue, &producer))
      .await?;
    // The daemon answers the job record with `duplicate` alongside it; the
    // two are separated here so what this crate publishes is a nested shape
    // a schema can describe.
    let duplicate = answer
      .get("duplicate")
      .and_then(Value::as_bool)
      .unwrap_or(false);
    let job = serde_json::from_value(answer).map_err(QueueError::decode("an enqueued job"))?;
    Ok(Enqueued { job, duplicate })
  }

  async fn show(&self, queue: &str, id: &str) -> Result<Job> {
    // The daemon keys a job by `job`, not `id`.
    self
      .job_call("show", json!({"queue": queue, "job": id}))
      .await
  }

  async fn list(&self, filter: ListFilter) -> Result<Vec<Job>> {
    let mut params = json!({"limit": filter.limit.unwrap_or(200)});
    let object = params.as_object_mut().expect("json! built an object");
    if let Some(queue) = &filter.queue {
      object.insert("queue".into(), Value::String(queue.clone()));
    }
    // Filters must precede the daemon's limit; newer unrelated jobs must
    // never hide this producer's older active work.
    if let Some(producer) = &filter.producer {
      object.insert("producer".into(), Value::String(producer.clone()));
    }
    if !filter.states.is_empty() {
      object.insert("states".into(), json!(filter.states));
    }
    let answer = self.plugin_call("list", params).await?;
    let jobs: Vec<Job> = serde_json::from_value(
      answer
        .get("jobs")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new())),
    )
    .map_err(QueueError::decode("a job listing"))?;
    Ok(jobs.into_iter().filter(|job| filter.matches(job)).collect())
  }

  async fn cancel(&self, queue: &str, id: &str, reason: CancelReason) -> Result<Job> {
    self
      .job_call(
        "cancel",
        json!({"queue": queue, "job": id, "reason": reason.as_str()}),
      )
      .await
  }

  async fn retry(&self, queue: &str, id: &str) -> Result<Job> {
    self
      .job_call("retry", json!({"queue": queue, "job": id}))
      .await
  }

  fn changes(&self) -> BoxStream<Change> {
    let socket = self.socket.clone();
    let serve_dir = self.serve_dir.clone();
    let (sender, receiver) = mpsc::channel(64);
    let task = tokio::task::spawn_blocking(move || watch(socket, serve_dir, sender));
    Box::pin(futures::stream::unfold(
      (receiver, AbortOnDrop(task)),
      |(mut receiver, task)| async move {
        receiver
          .recv()
          .await
          .map(|change| (change, (receiver, task)))
      },
    ))
  }
}

/// Dropping the change stream stops the connection behind it; a subscription
/// nobody reads is a socket nobody closes.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
  fn drop(&mut self) {
    self.0.abort();
  }
}

/// Hold a subscription for as long as anyone is listening, across restarts of
/// whatever is on the other end.
fn watch(socket: PathBuf, serve_dir: PathBuf, sender: mpsc::Sender<Change>) {
  let mut seen: HashMap<String, (JobState, u64)> = HashMap::new();
  let mut backoff = RETRY_MIN;
  while !sender.is_closed() {
    if subscribe(&socket, &serve_dir, &sender, &mut seen).is_ok() {
      backoff = RETRY_MIN;
    }
    if sender.is_closed() {
      break;
    }
    std::thread::sleep(backoff);
    backoff = (backoff * 2).min(RETRY_MAX);
  }
}
fn subscribe(
  socket: &Path,
  serve_dir: &Path,
  sender: &mpsc::Sender<Change>,
  seen: &mut HashMap<String, (JobState, u64)>,
) -> Result<()> {
  let mut conn = Connection::open(socket, serve_dir).map_err(map_error)?;
  let snapshot = conn
    .call("tasks.snapshot", json!({}), None)
    .map_err(map_error)?;
  let first = seen.is_empty();
  for change in diff(&snapshot, seen) {
    if !first && sender.blocking_send(change).is_err() {
      return Ok(());
    }
  }
  conn
    .call("tasks.subscribe", json!({}), None)
    .map_err(map_error)?;
  while !sender.is_closed() {
    let Some(message) = conn.poll().map_err(map_error)? else {
      continue;
    };
    if message["method"] != "tasks.changed" {
      continue;
    }
    for change in diff(&message["params"], seen) {
      if sender.blocking_send(change).is_err() {
        return Ok(());
      }
    }
  }
  Ok(())
}

/// The queue's jobs in a task payload that differ from what was last seen.
fn diff(payload: &Value, seen: &mut HashMap<String, (JobState, u64)>) -> Vec<Change> {
  let Some(tasks) = payload.get("tasks").and_then(Value::as_array) else {
    return Vec::new();
  };
  let mut changes = Vec::new();
  for task in tasks {
    if task.get("source").and_then(Value::as_str) != Some(BUNDLE) {
      continue;
    }
    let Some(id) = task.get("id").and_then(Value::as_str) else {
      continue;
    };
    // `<bundle>:<queue>:<job id>` — the job id may itself contain no colon,
    // and splitting from the left keeps a queue name that does.
    let Some((queue, job_id)) = id
      .strip_prefix(BUNDLE)
      .and_then(|rest| rest.strip_prefix(':'))
      .and_then(|rest| rest.split_once(':'))
    else {
      continue;
    };
    let Some(state) = task
      .get("state")
      .and_then(|state| serde_json::from_value::<JobState>(state.clone()).ok())
    else {
      continue;
    };
    let updated_at = task
      .get("updated_ms")
      .and_then(Value::as_u64)
      .unwrap_or_default();
    let key = id.to_string();
    if seen.get(&key) == Some(&(state, updated_at)) {
      continue;
    }
    seen.insert(key, (state, updated_at));
    changes.push(Change {
      queue: queue.to_string(),
      job_id: job_id.to_string(),
      state,
      updated_at,
    });
  }
  changes
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Serve's task payload, as the contract documents it: this queue's jobs
  /// beside the host's plain sessions.
  const TASKS: &str = r#"{"revision": "9", "tasks": [
    {"id": "tsh:lin-1", "source": "tsh", "title": "inspect matches",
     "state": "live", "created_ms": 1757000000000, "updated_ms": 1757000600000},
    {"id": "tsh-agent-queue:default:job-7", "source": "tsh-agent-queue",
     "title": "classify fallen leaves", "state": "running",
     "created_ms": 1757000100000, "updated_ms": 1757000700000}
  ]}"#;

  #[test]
  fn only_this_queues_jobs_are_changes() {
    let payload: Value = serde_json::from_str(TASKS).unwrap();
    let mut seen = HashMap::new();
    let changes = diff(&payload, &mut seen);
    // The plain tsh session is not a job, and `live` is not a job state.
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].queue, "default");
    assert_eq!(changes[0].job_id, "job-7");
    assert_eq!(changes[0].state, JobState::Running);
    assert_eq!(changes[0].updated_at, 1_757_000_700_000);
  }

  #[test]
  fn a_job_that_has_not_moved_is_not_reported_again() {
    let payload: Value = serde_json::from_str(TASKS).unwrap();
    let mut seen = HashMap::new();
    assert_eq!(diff(&payload, &mut seen).len(), 1);
    assert!(diff(&payload, &mut seen).is_empty());

    // The same job, later and settled: that is a movement.
    let moved: Value = serde_json::from_str(
      r#"{"tasks": [{"id": "tsh-agent-queue:default:job-7", "source": "tsh-agent-queue",
           "state": "succeeded", "updated_ms": 1757000800000}]}"#,
    )
    .unwrap();
    let changes = diff(&moved, &mut seen);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].state, JobState::Succeeded);
  }

  #[test]
  fn a_queue_name_with_a_colon_keeps_its_job_id() {
    let payload: Value = serde_json::from_str(
      r#"{"tasks": [{"id": "tsh-agent-queue:team:alpha:job-9", "source": "tsh-agent-queue",
           "state": "queued", "updated_ms": 1}]}"#,
    )
    .unwrap();
    let changes = diff(&payload, &mut HashMap::new());
    assert_eq!(changes[0].queue, "team");
    assert_eq!(changes[0].job_id, "alpha:job-9");
  }

  #[tokio::test]
  async fn a_missing_socket_is_unavailable_not_a_panic() {
    let backend = TshBackend::new("/nonexistent/tento-agent-queue/serve.sock");
    let error = backend.hello().await.unwrap_err();
    assert!(matches!(error, QueueError::Unavailable(_)), "{error:?}");
    assert!(error.to_string().contains("tsh serve"), "{error}");
  }
}
