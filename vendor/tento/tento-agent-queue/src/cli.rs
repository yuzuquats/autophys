//! `tento-agent-queue` — the queue from a shell.
//!
//! The same client a product links, as commands: an operator or an agent can
//! queue work, watch it, read its result and cancel it without a product in
//! the middle. Every answer is a `agent-queue.<name>/v1` envelope, so a
//! caller parses one shape.
//!
//! ```sh
//! tento-agent-queue queue.enqueue --lane normal --form '(begin 1)' --wait
//! tento-agent-queue queue.list --state succeeded --limit 5
//! tento-agent-queue queue.show <job>
//! ```

use std::time::Duration;

use anyhow::anyhow;
use serde::Deserialize;
use serde_json::{Value, json};
use tento_sh::{CommandArg, Scripts, command};

use crate::backend::ListFilter;
use crate::env::QueueEnv;
use crate::model::{JobPolicy, JobState};
use crate::new_job::NewJob;
use crate::queue::AgentQueue;
use crate::tsh::TshBackend;

/// The default producer id for work queued from a shell: it marks the job as
/// hand-made rather than a product's, which is what a listing wants to show.
const CLI_PRODUCER: &str = "tento-agent-queue-cli";

#[derive(Clone)]
pub struct Context {
  env: QueueEnv,
}

impl Context {
  /// Resolving the socket reads no file and opens no connection, so a
  /// reflection call (`--help --json`) never touches the queue.
  fn queue(&self, producer: Option<&str>) -> anyhow::Result<AgentQueue> {
    Ok(AgentQueue::from_env(
      &self.env,
      producer.unwrap_or(CLI_PRODUCER),
    )?)
  }

  fn backend(&self) -> anyhow::Result<TshBackend> {
    Ok(TshBackend::new(self.env.socket_path()?))
  }
}

pub fn scripts(env: QueueEnv) -> Scripts<Context> {
  Scripts::new(Context { env })
    .add_command(queue_enqueue)
    .add_command(queue_list)
    .add_command(queue_show)
    .add_command(queue_wait)
    .add_command(queue_cancel)
    .add_command(queue_retry)
    .add_command(queue_status)
}

/// The command framework carries an `anyhow::Error`; a queue error becomes
/// one here, at the shell boundary, and nowhere else.
fn sh(error: crate::error::QueueError) -> tento_sh::Error {
  anyhow::Error::from(error).into()
}

fn output(name: &str, value: impl serde::Serialize) -> tento_sh::Result<Value> {
  Ok(json!({
    "type": format!("agent-queue.{name}/v1"),
    "data": serde_json::to_value(value).map_err(|error| anyhow!(error))?,
  }))
}

fn parse_state(word: &str) -> anyhow::Result<JobState> {
  serde_json::from_value(Value::String(word.to_string()))
    .map_err(|_| anyhow!("unknown state {word:?}"))
}

#[derive(CommandArg, Deserialize)]
pub struct EnqueueArgs {
  /// The lane to run in; must be one the host declared on this queue.
  lane: Option<String>,
  /// An agent job: the prompt to deliver to the lane.
  prompt: Option<String>,
  /// A control job: one Lisp form to run on the session's control pane.
  form: Option<String>,
  /// What an operator reading a task list should see.
  title: Option<String>,
  /// The contract the result should satisfy, e.g. `news.summary/v1`.
  datatype: Option<String>,
  /// How many tries this job gets (default 1).
  max_attempts: Option<u32>,
  /// Give up on an attempt after this many milliseconds.
  timeout_ms: Option<u64>,
  /// Failure classes that may consume another attempt, comma separated.
  retryable: Option<String>,
  /// Which queue, when not the default.
  queue: Option<String>,
  /// Who is asking (default the CLI's own id).
  producer: Option<String>,
  /// A caller-chosen id; the same producer and request twice is one job.
  request: Option<String>,
  /// Block until the job finishes rather than answering with the queued job.
  #[serde(default)]
  wait: bool,
  /// How long `--wait` waits, in seconds (default 900).
  wait_seconds: Option<u64>,
}

#[command(
  name = "queue.enqueue",
  description = "Queue one job — an agent prompt or a control form — and answer with the job record",
  transport = "streaming"
)]
async fn queue_enqueue(context: Context, args: EnqueueArgs) -> tento_sh::Result<Value> {
  let lane = args.lane.unwrap_or_else(|| "normal".to_string());
  let mut job = match (&args.prompt, &args.form) {
    (Some(prompt), None) => NewJob::agent(lane, prompt),
    (None, Some(form)) => NewJob::ctl(lane, form),
    (Some(_), Some(_)) => {
      return Err(anyhow!("a job is either a --prompt or a --form, not both").into());
    }
    (None, None) => return Err(anyhow!("a job needs a --prompt or a --form").into()),
  };
  if let Some(title) = args.title {
    job = job.title(title);
  }
  if let Some(datatype) = args.datatype {
    job = job.datatype(datatype);
  }
  if let Some(queue) = args.queue {
    job = job.queue(queue);
  }
  if let Some(request) = args.request {
    job = job.request(request);
  }
  job = job.policy(JobPolicy {
    max_attempts: args.max_attempts.unwrap_or(1),
    timeout_ms: args.timeout_ms,
    retryable_classes: args
      .retryable
      .as_deref()
      .map(|classes| {
        classes
          .split(',')
          .map(str::trim)
          .filter(|class| !class.is_empty())
          .map(str::to_string)
          .collect()
      })
      .unwrap_or_default(),
  });

  let queue = context.queue(args.producer.as_deref())?;
  let enqueued = queue.enqueue(job).await.map_err(sh)?;
  if !args.wait {
    return output("enqueue", enqueued);
  }
  let settled = queue
    .wait(
      &enqueued.job.id,
      Duration::from_secs(args.wait_seconds.unwrap_or(900)),
    )
    .await.map_err(sh)?;
  output("enqueue", json!({"job": settled, "duplicate": enqueued.duplicate}))
}

#[derive(CommandArg, Deserialize)]
pub struct ListArgs {
  /// Which queue, when not the default.
  queue: Option<String>,
  /// Only this producer's jobs.
  producer: Option<String>,
  /// Only jobs in this state, e.g. `running`, `succeeded`, `retry_wait`.
  state: Option<String>,
  /// At most this many (default 50).
  limit: Option<u32>,
}

#[command(
  name = "queue.list",
  description = "List jobs, newest movement first"
)]
async fn queue_list(context: Context, args: ListArgs) -> tento_sh::Result<Value> {
  let queue = context.queue(None)?;
  let mut filter = ListFilter::default()
    .queue(args.queue.unwrap_or_else(|| queue.queue_name().to_string()))
    .limit(args.limit.unwrap_or(50));
  if let Some(producer) = args.producer {
    filter = filter.producer(producer);
  }
  if let Some(state) = args.state.as_deref() {
    filter = filter.state(parse_state(state)?);
  }
  let jobs = queue.list(filter).await.map_err(sh)?;
  output("list", json!({"count": jobs.len(), "jobs": jobs}))
}

#[derive(CommandArg, Deserialize)]
pub struct JobArgs {
  /// The job id.
  job: String,
  /// Which queue, when not the default.
  queue: Option<String>,
}

#[command(
  name = "queue.show",
  description = "One job with its attempts, the session each ran in, and its result"
)]
async fn queue_show(context: Context, args: JobArgs) -> tento_sh::Result<Value> {
  let queue = with_queue(context.queue(None)?, args.queue);
  output("show", queue.show(&args.job).await.map_err(sh)?)
}

#[derive(CommandArg, Deserialize)]
pub struct WaitArgs {
  /// The job id.
  job: String,
  /// Which queue, when not the default.
  queue: Option<String>,
  /// Give up after this many seconds (default 900).
  seconds: Option<u64>,
}

#[command(
  name = "queue.wait",
  description = "Wait for a job to finish and answer with what it became",
  transport = "streaming"
)]
async fn queue_wait(context: Context, args: WaitArgs) -> tento_sh::Result<Value> {
  let queue = with_queue(context.queue(None)?, args.queue);
  let settled = queue
    .wait(
      &args.job,
      Duration::from_secs(args.seconds.unwrap_or(900)),
    )
    .await.map_err(sh)?;
  output("wait", settled)
}

#[command(
  name = "queue.cancel",
  description = "Ask a job to stop; it settles once its session confirms"
)]
async fn queue_cancel(context: Context, args: JobArgs) -> tento_sh::Result<Value> {
  let queue = with_queue(context.queue(None)?, args.queue);
  output("cancel", queue.cancel(&args.job).await.map_err(sh)?)
}

#[command(
  name = "queue.retry",
  description = "Re-queue a job that has finished"
)]
async fn queue_retry(context: Context, args: JobArgs) -> tento_sh::Result<Value> {
  let queue = with_queue(context.queue(None)?, args.queue);
  output("retry", queue.retry(&args.job).await.map_err(sh)?)
}

#[command(
  name = "queue.status",
  description = "Whether the queue answers, and what is behind it"
)]
async fn queue_status(context: Context, _: Option<()>) -> tento_sh::Result<Value> {
  let backend = context.backend()?;
  let socket = backend.socket().display().to_string();
  // Reachability is the whole question, so an unreachable queue is a report,
  // not an error: `status` on a host with nothing running must still answer.
  let (reachable, detail) = match backend.hello().await {
    Ok(hello) => (true, hello),
    Err(error) => (false, json!({"error": error.to_string()})),
  };
  output(
    "status",
    json!({
      "backend": "tsh",
      "bundle": crate::tsh::BUNDLE,
      "queue": context.env.queue_name(),
      "socket": socket,
      "reachable": reachable,
      "serve": detail,
    }),
  )
}

fn with_queue(queue: AgentQueue, name: Option<String>) -> AgentQueue {
  match name {
    Some(name) => AgentQueue::new(queue.backend_handle(), name, queue.producer().to_string()),
    None => queue,
  }
}
