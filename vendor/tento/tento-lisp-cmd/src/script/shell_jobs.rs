//! Background executions and the jobs projection.
//!
//! A background job is an execution: a durable identity (`execution`), a
//! state from [`ExecState`], and a process id while it lives. The shell keeps
//! a [`JobTable`] per host; the bash builtins (`jobs`, `wait`, `kill %N`,
//! `disown`) are thin wrappers that parse bash's arguments and print bash's
//! text over the same operations the typed `std.jobs.*` commands expose as
//! values. `%N` labels are a projection for people: Lisp names a job by its
//! execution id, its pid, or the `job/v1` value itself, and
//! `(std.jobs.resolve "%1")` is the one door from a label to a job.
//!
//! A session embedder installs a [`JobHost`]: it admits each submission into
//! its records (a replayed unit gets the same execution back instead of a
//! second child), streams the job's output into the session, and records the
//! lifecycle transitions. Without one, executions are local to this shell.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use serde_json::{Value as JsonValue, json};
use tento_lisp::Value as LispValue;

use super::bash_flow::FlowOutput;
use super::interp::{ExternalCommands, LispHost, LispHostError, Sym};
use super::runner::TshScriptErrorKind;
use super::{FdTarget, ShellIo, ShellJob};

pub(super) mod control;
pub use control::{
  ProcEvent, ProcObserver, StoppedJob, adopt_stopped_job, job_control_requested, note_job_continued,
  note_job_finished, note_job_stopped, observe_job,
};
mod foreground;
#[cfg(unix)]
pub use foreground::start_process_foreground;
pub(super) mod terminal;
pub use terminal::{claim_interactive as claim_terminal, owned as terminal_owned};

type Result<T> = std::result::Result<T, TshScriptErrorKind>;

/// The states of an execution (architecture.md, "Execution state machine").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ExecState {
  Submitted,
  WaitingApproval,
  Starting,
  Running,
  Stopped,
  Cancelling,
  Succeeded,
  Failed,
  Cancelled,
  Denied,
  HostFailed,
}

/// An edge the state machine does not have. Replaying a transition already
/// committed is not a conflict ([`ExecState::advance`] reports it as a replay).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransitionConflict {
  pub from: ExecState,
  pub to: ExecState,
}

impl std::fmt::Display for TransitionConflict {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(
      f,
      "execution cannot move from {} to {}",
      self.from.name(),
      self.to.name()
    )
  }
}

impl std::error::Error for TransitionConflict {}

/// What committing a transition did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Advance {
  Moved,
  /// The execution was already in that state: an idempotent replay.
  Replayed,
}

impl ExecState {
  pub const ALL: [ExecState; 11] = [
    ExecState::Submitted,
    ExecState::WaitingApproval,
    ExecState::Starting,
    ExecState::Running,
    ExecState::Stopped,
    ExecState::Cancelling,
    ExecState::Succeeded,
    ExecState::Failed,
    ExecState::Cancelled,
    ExecState::Denied,
    ExecState::HostFailed,
  ];

  /// The record name of the state.
  pub fn name(self) -> &'static str {
    match self {
      ExecState::Submitted => "submitted",
      ExecState::WaitingApproval => "waiting_approval",
      ExecState::Starting => "starting",
      ExecState::Running => "running",
      ExecState::Stopped => "stopped",
      ExecState::Cancelling => "cancelling",
      ExecState::Succeeded => "succeeded",
      ExecState::Failed => "failed",
      ExecState::Cancelled => "cancelled",
      ExecState::Denied => "denied",
      ExecState::HostFailed => "host_failed",
    }
  }

  pub fn named(name: &str) -> Option<Self> {
    Self::ALL.into_iter().find(|state| state.name() == name)
  }

  /// No transition leaves a settled state.
  pub fn is_settled(self) -> bool {
    matches!(
      self,
      ExecState::Succeeded
        | ExecState::Failed
        | ExecState::Cancelled
        | ExecState::Denied
        | ExecState::HostFailed
    )
  }

  /// Whether the state machine has the edge `self → to`.
  pub fn allows(self, to: ExecState) -> bool {
    use ExecState::*;
    matches!(
      (self, to),
      (Submitted, WaitingApproval)
        | (Submitted, Starting)
        | (WaitingApproval, Starting)
        | (WaitingApproval, Denied)
        | (Starting, Running)
        | (Starting, HostFailed)
        | (Running, Stopped)
        | (Stopped, Running)
        | (Running, Cancelling)
        | (Stopped, Cancelling)
        | (Cancelling, Cancelled)
        | (Running, Succeeded)
        | (Running, Failed)
    )
  }

  /// Commit `self → to`: a replay of the current state is idempotent, an edge
  /// the machine lacks is a typed conflict.
  pub fn advance(self, to: ExecState) -> std::result::Result<Advance, TransitionConflict> {
    if self == to {
      Ok(Advance::Replayed)
    } else if self.allows(to) {
      Ok(Advance::Moved)
    } else {
      Err(TransitionConflict { from: self, to })
    }
  }

  /// The settled state of a process that exited with `status` or `signal`.
  pub fn of_exit(status: i32, signal: Option<i32>) -> Self {
    if status == 0 && signal.is_none() {
      ExecState::Succeeded
    } else {
      ExecState::Failed
    }
  }
}

/// One committed transition, as a session record value
/// (`exec.lifecycle/v1`). `fields` carries the edge's context: unit, session,
/// principal, cwd, pid, command and, on settlement, status/signal/error.
pub fn lifecycle_record(
  execution: &str,
  from: Option<ExecState>,
  to: ExecState,
  fields: serde_json::Map<String, JsonValue>,
) -> JsonValue {
  let mut record = serde_json::Map::new();
  record.insert("datatype".into(), json!("exec.lifecycle/v1"));
  record.insert("execution".into(), json!(execution));
  record.insert("from".into(), json!(from.map(ExecState::name)));
  record.insert("state".into(), json!(to.name()));
  record.insert("at_ms".into(), json!(now_ms()));
  for (key, value) in fields {
    record.entry(key).or_insert(value);
  }
  JsonValue::Object(record)
}

/// An execution folded from its lifecycle records.
#[derive(Clone, Debug, PartialEq)]
pub struct FoldedExecution {
  pub execution: String,
  pub state: ExecState,
  /// Every field the records carried, the latest value winning.
  pub fields: serde_json::Map<String, JsonValue>,
  /// Records whose edge the state machine refused, in order.
  pub conflicts: Vec<TransitionConflict>,
}

/// Rebuild executions from `exec.lifecycle/v1` records, in first-seen order.
/// Replayed records are idempotent; an impossible edge is kept as a conflict
/// and does not move the state. Other record values are ignored.
pub fn fold_lifecycle<'a>(
  records: impl IntoIterator<Item = &'a JsonValue>,
) -> Vec<FoldedExecution> {
  let mut order: Vec<String> = Vec::new();
  let mut folded: HashMap<String, FoldedExecution> = HashMap::new();
  for record in records {
    if record.get("datatype").and_then(JsonValue::as_str) != Some("exec.lifecycle/v1") {
      continue;
    }
    let (Some(execution), Some(to)) = (
      record.get("execution").and_then(JsonValue::as_str),
      record
        .get("state")
        .and_then(JsonValue::as_str)
        .and_then(ExecState::named),
    ) else {
      continue;
    };
    let entry = folded.entry(execution.to_string()).or_insert_with(|| {
      order.push(execution.to_string());
      FoldedExecution {
        execution: execution.to_string(),
        state: to,
        fields: serde_json::Map::new(),
        conflicts: Vec::new(),
      }
    });
    if entry.state != to {
      match entry.state.advance(to) {
        Ok(_) => entry.state = to,
        Err(conflict) => {
          entry.conflicts.push(conflict);
          continue;
        }
      }
    }
    if let Some(fields) = record.as_object() {
      for (key, value) in fields {
        if !matches!(key.as_str(), "datatype" | "from" | "state") {
          entry.fields.insert(key.clone(), value.clone());
        }
      }
    }
  }
  order
    .into_iter()
    .filter_map(|execution| folded.remove(&execution))
    .collect()
}

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis() as u64)
    .unwrap_or(0)
}

/// How a job's process ended.
#[derive(Clone, Debug, PartialEq)]
pub struct JobOutcome {
  /// The shell status: the exit code, or 128 + the signal.
  pub status: i32,
  pub signal: Option<i32>,
  pub statuses: Vec<i32>,
  /// Captured stdout, for a job started inside a command substitution.
  pub stdout: Rc<Vec<u8>>,
}

/// A job's settlement, shared by everything that waits for it: `wait`, the
/// projection's liveness check and a session's settlement record.
pub type JobOutcomeFuture =
  Shared<LocalBoxFuture<'static, std::result::Result<JobOutcome, String>>>;

/// Writes a background job's output into a session: `(bytes, stderr)`. An
/// empty slice marks the end of that stream. Called from reader threads.
pub type BackgroundOutput = Arc<dyn Fn(&[u8], bool) + Send + Sync>;

/// What is being submitted, for the embedder's records.
#[derive(Clone, Debug)]
pub struct JobPlan {
  pub command: String,
  pub cwd: Option<PathBuf>,
  /// Submitted from an interactive prompt (job control is on): the job gets
  /// its own process group, and its output belongs to the job's pane rather
  /// than the submitting unit's transcript.
  pub interactive: bool,
}

/// The embedder's slot for one fresh submission.
pub trait JobSlot {
  fn execution(&self) -> String;
  /// Where the job's inherited stdout and stderr go (`None`: inherited).
  fn output(&self) -> Option<BackgroundOutput>;
  /// The process started; `settled` resolves when it ends.
  fn started(self: Box<Self>, pid: u32, settled: JobOutcomeFuture);
  /// The process could not start.
  fn failed(self: Box<Self>, error: &str);
  /// The job's `%N` label, once the table has numbered it: before
  /// [`Self::started`], so the embedder's row can carry it.
  fn labelled(&self, number: u32) {
    let _ = number;
  }
  /// Called with each stop and resume the job's reaper observes (from the
  /// reaper's thread). The embedder records `stopped`/`running` transitions
  /// from it; settlement still arrives through [`Self::started`]'s future.
  fn observer(&self) -> Option<ProcObserver> {
    None
  }
}

/// The embedder's answer to a submission.
pub enum JobAdmission {
  Fresh(Box<dyn JobSlot>),
  /// This submission already ran (a replayed unit): the same execution,
  /// never a second child.
  Replayed {
    execution: String,
    pid: u32,
    settled: JobOutcomeFuture,
  },
}

/// The embedder of a shell with background jobs: it runs the programs (as the
/// shell's [`ExternalCommands`]) and owns the records of their executions.
pub trait JobHost: ExternalCommands {
  /// `None`: no session records; the execution is local to this shell.
  fn admit(&self, plan: &JobPlan) -> Option<JobAdmission>;
  /// Resolves when the viewer asks to stop the foreground job (Ctrl-Z).
  /// Asked once per `fg`; `None`: this embedder has no such request.
  fn foreground_stop(&self) -> Option<LocalBoxFuture<'static, ()>> {
    None
  }
  /// `fg` brings job `pid` to the foreground: hold the returned guard for as
  /// long as it is, and the embedder may show the job's output where the
  /// shell is. Dropped when `fg` ends. `None`: nothing to attach.
  fn attach_foreground(&self, pid: u32) -> Option<Box<dyn std::any::Any>> {
    let _ = pid;
    None
  }
}

/// Signals that ended reaped background processes, by pid, until the job's
/// settlement reads them (`ShellCapture` carries only the status).
static TERMINATIONS: std::sync::Mutex<Vec<(u32, i32)>> = std::sync::Mutex::new(Vec::new());

/// The job registries' locks, held by a forking thread so that no other
/// thread holds one when the child's copy of the address space is made.
pub(super) struct JobLocks {
  _terminations: std::sync::MutexGuard<'static, Vec<(u32, i32)>>,
  _live: control::LiveLock,
}

impl JobLocks {
  pub(super) fn acquire() -> Self {
    Self {
      _terminations: TERMINATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()),
      _live: control::LiveLock::acquire(),
    }
  }
}

/// Called by the reaper of a background process killed by `signal`.
pub(super) fn note_termination(pid: u32, signal: i32) {
  if let Ok(mut terminations) = TERMINATIONS.lock() {
    terminations.push((pid, signal));
  }
}

fn take_termination(pid: u32) -> Option<i32> {
  let mut terminations = TERMINATIONS.lock().ok()?;
  let index = terminations.iter().position(|(reaped, _)| *reaped == pid)?;
  Some(terminations.remove(index).1)
}

/// Run a reaper or stream pump off this thread. Inside a runtime it takes a
/// thread from the blocking pool, which keeps its threads between jobs: a
/// thread starting or exiting while the shell forks a compound job can leave
/// std's thread registry locked in the child, so the shell avoids churning
/// threads. Outside a runtime it starts a thread of its own. In a forked
/// child it is a bare pthread.
pub(super) fn spawn_reaper(work: impl FnOnce() + Send + 'static) {
  // A forked child starts no std or pool thread (see `shell_workers`).
  #[cfg(unix)]
  if super::shell_workers::in_forked_child() {
    return super::shell_workers::spawn_detached_bare(work);
  }
  match tokio::runtime::Handle::try_current() {
    Ok(runtime) => {
      runtime.spawn_blocking(work);
    }
    Err(_) => {
      std::thread::spawn(work);
    }
  }
}

/// The shared settlement of a started job.
fn settle(job: ShellJob, pipefail: bool) -> JobOutcomeFuture {
  let pid = job.pid;
  let completion = job.completion;
  async move {
    let captured = completion.await.map_err(|error| error.to_string())?;
    let mut status = captured.status;
    if pipefail {
      status = captured
        .statuses
        .iter()
        .rev()
        .copied()
        .find(|status| *status != 0)
        .unwrap_or(status);
    }
    let signal = take_termination(pid).filter(|signal| status == 128 + signal);
    Ok(JobOutcome {
      status,
      signal,
      statuses: captured.statuses,
      stdout: Rc::new(captured.stdout),
    })
  }
  .boxed_local()
  .shared()
}

/// A settlement that is already known (a test or a replay).
pub fn settled_outcome(outcome: JobOutcome) -> JobOutcomeFuture {
  async move { Ok(outcome) }.boxed_local().shared()
}

struct Process {
  pid: u32,
  execution: String,
  /// The `%N` label while the job is in the jobs table; process
  /// substitutions and removed jobs have none.
  number: Option<u32>,
  command: String,
  cwd: Option<PathBuf>,
  started_ms: u64,
  state: ExecState,
  outcome: Option<std::result::Result<JobOutcome, String>>,
  settled: JobOutcomeFuture,
  stdout_delivered: bool,
  /// The job's own process group (its pid), when it was started with job
  /// control on; signals then go to the whole group.
  pgid: Option<u32>,
  /// Brought to the foreground by `fg` and awaited by the shell.
  foreground: bool,
  /// The signal of the stop being reported (`Stopped (SIGSTOP)`).
  stop_signal: Option<i32>,
  /// The shell already told the user of the job's last change of state.
  notified: Option<NoticeKind>,
}

/// What a job notice already reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NoticeKind {
  Stopped,
  Finished,
}

#[derive(Default)]
struct Table {
  /// Every child this shell started in the background, retained after it is
  /// waited for (`wait PID` reports a reaped child's status again, as bash).
  processes: Vec<Process>,
  /// Submissions so far: a local execution id is unique per shell.
  sequence: u64,
  /// bash's `+` and `-` jobs (pids). They are chosen when a job starts or
  /// when one of them leaves the table, and stay on a job that finishes.
  current: Option<u32>,
  previous: Option<u32>,
  host: Option<Rc<dyn JobHost>>,
  /// Job control forced on (tests, `set -m`); an interactive prompt turns it
  /// on for its own lines.
  monitor: bool,
}

impl Table {
  /// The newest running job numbered below `below` (any, when `None`).
  fn last_running(&self, below: Option<u32>) -> Option<u32> {
    self
      .processes
      .iter()
      .filter(|process| process.outcome.is_none())
      .filter_map(|process| process.number.map(|number| (number, process.pid)))
      .filter(|(number, _)| below.is_none_or(|below| *number < below))
      .max()
      .map(|(_, pid)| pid)
  }

  fn number_of(&self, pid: u32) -> Option<u32> {
    self
      .processes
      .iter()
      .find(|process| process.pid == pid)
      .and_then(|process| process.number)
  }

  /// bash's `set_current_job`: `pid` is current, and the previous job is the
  /// newest running job older than it.
  fn set_current(&mut self, pid: u32) {
    self.current = Some(pid);
    let below = self.number_of(pid);
    self.previous = self.last_running(below).filter(|previous| *previous != pid);
  }

  /// A job that just stopped is current, and the job that was current is
  /// the previous one (bash: the `+` job is the most recently stopped).
  fn stopped_current(&mut self, pid: u32) {
    if self.current != Some(pid) {
      self.previous = self.current.filter(|current| self.number_of(*current).is_some());
    }
    self.current = Some(pid);
  }

  /// Whether `pid` is a job of the table that is stopped under job control.
  fn held(&self, pid: u32) -> bool {
    self.processes.iter().any(|process| {
      process.pid == pid
        && process.number.is_some()
        && process.outcome.is_none()
        && process.state == ExecState::Stopped
        && process.pgid.is_some()
    })
  }

  /// bash's `reset_current`, after the current or previous job left.
  fn reset_current(&mut self) {
    match self.last_running(None) {
      Some(pid) => self.set_current(pid),
      None => {
        self.current = None;
        self.previous = None;
      }
    }
  }
}

/// Which job a label names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::script) enum Mark {
  Current,
  Previous,
  Other,
}

/// The shell's jobs: shared by the host and its `std.jobs.*` natives.
#[derive(Clone, Default)]
pub(in crate::script) struct JobTable(Rc<RefCell<Table>>);

/// Restores the shell's jobs table after a subshell (see [`JobTable::subshell`]).
pub(in crate::script) struct SubshellJobs {
  table: JobTable,
  saved: Option<Table>,
}

impl Drop for SubshellJobs {
  fn drop(&mut self) {
    if let Some(saved) = self.saved.take() {
      *self.table.0.borrow_mut() = saved;
    }
  }
}

/// A `%spec` that names no single job: bash's diagnostics, in order.
#[derive(Debug, PartialEq, Eq)]
pub(in crate::script) struct NoSuchJob(pub Vec<String>);

impl JobTable {
  pub(in crate::script) fn set_host(&self, host: Option<Rc<dyn JobHost>>) {
    self.0.borrow_mut().host = host;
  }

  fn host(&self) -> Option<Rc<dyn JobHost>> {
    self.0.borrow().host.clone()
  }

  /// A forked child starts with no jobs of its own and no session host.
  pub(in crate::script) fn clear(&self) {
    *self.0.borrow_mut() = Table::default();
  }

  /// A `( … )` subshell sees no jobs of the shell (bash clears its table);
  /// the shell's table returns when the guard drops.
  pub(in crate::script) fn subshell(&self) -> SubshellJobs {
    let host = self.host();
    let saved = std::mem::take(&mut *self.0.borrow_mut());
    self.0.borrow_mut().host = host;
    SubshellJobs {
      table: self.clone(),
      saved: Some(saved),
    }
  }

  fn admit(&self, plan: &JobPlan) -> Option<JobAdmission> {
    self.host().and_then(|host| host.admit(plan))
  }

  /// Record a started child. A replayed submission of a pid already present
  /// keeps its job; `numbered` is false for a process substitution.
  fn submit(
    &self,
    pid: u32,
    execution: Option<String>,
    command: String,
    settled: JobOutcomeFuture,
    numbered: bool,
  ) -> Option<u32> {
    // Which older jobs still run decides the new `-` job.
    self.poll();
    let mut table = self.0.borrow_mut();
    let cwd = std::env::current_dir().ok();
    table.sequence += 1;
    let sequence = table.sequence;
    if table.processes.iter().any(|process| process.pid == pid) {
      return table.number_of(pid);
    }
    let number = numbered.then(|| {
      table
        .processes
        .iter()
        .filter_map(|process| process.number)
        .max()
        .unwrap_or(0)
        + 1
    });
    let execution = execution.unwrap_or_else(|| format!("local:{}:{sequence}", std::process::id()));
    table.processes.push(Process {
      pid,
      execution,
      number,
      command,
      cwd,
      started_ms: now_ms(),
      state: ExecState::Running,
      outcome: None,
      settled,
      stdout_delivered: false,
      pgid: None,
      foreground: false,
      stop_signal: None,
      notified: None,
    });
    if numbered {
      // A stopped current job keeps the `+`: the new job is the `-` (bash).
      match table.current {
        Some(current) if table.held(current) => table.previous = Some(pid),
        _ => table.set_current(pid),
      }
    }
    // Retain a bounded history of reaped children that left the jobs table.
    let reaped = table
      .processes
      .iter()
      .filter(|process| process.number.is_none() && process.outcome.is_some())
      .count();
    if reaped > 1024 {
      if let Some(oldest) = table
        .processes
        .iter()
        .position(|process| process.number.is_none() && process.outcome.is_some())
      {
        table.processes.remove(oldest);
      }
    }
    number
  }

  /// Give an unnumbered process (a foreground job that just stopped) the
  /// next `%N` label and make it the current job, as bash numbers a job
  /// when it first has to name it.
  pub(in crate::script) fn number_job(&self, pid: u32) -> Option<u32> {
    let mut table = self.0.borrow_mut();
    let next = table
      .processes
      .iter()
      .filter_map(|process| process.number)
      .max()
      .unwrap_or(0)
      + 1;
    let process = table.processes.iter_mut().find(|process| process.pid == pid)?;
    let number = *process.number.get_or_insert(next);
    table.stopped_current(pid);
    Some(number)
  }

  /// Fold finished processes into their settled state (liveness).
  pub(in crate::script) fn poll(&self) {
    let pending: Vec<(u32, JobOutcomeFuture)> = self
      .0
      .borrow()
      .processes
      .iter()
      .filter(|process| process.outcome.is_none())
      .map(|process| (process.pid, process.settled.clone()))
      .collect();
    for (pid, settled) in pending {
      if let Some(outcome) = settled.now_or_never() {
        self.settle(pid, outcome);
      }
    }
    self.sync_stops();
  }

  /// Fold what the reapers saw (a stop, a continue) into each live job's state.
  fn sync_stops(&self) {
    let mut table = self.0.borrow_mut();
    for process in table
      .processes
      .iter_mut()
      .filter(|process| process.outcome.is_none())
    {
      match (process.state, control::stopped_signal(process.pid)) {
        (ExecState::Running, Some(signal)) => {
          process.state = ExecState::Stopped;
          process.stop_signal = Some(signal);
          process.notified = None;
        }
        (ExecState::Stopped, None) => {
          process.state = ExecState::Running;
          process.stop_signal = None;
          process.notified = None;
        }
        (ExecState::Stopped, Some(signal)) => process.stop_signal = Some(signal),
        _ => {}
      }
    }
  }

  fn settle(&self, pid: u32, outcome: std::result::Result<JobOutcome, String>) {
    let mut table = self.0.borrow_mut();
    let Some(process) = table
      .processes
      .iter_mut()
      .find(|process| process.pid == pid)
    else {
      return;
    };
    if process.outcome.is_some() {
      return;
    }
    let to = match &outcome {
      Ok(outcome) => ExecState::of_exit(outcome.status, outcome.signal),
      Err(_) => ExecState::Failed,
    };
    // A stopped job that is killed ends without a continue being observed.
    if process.state == ExecState::Stopped {
      process.state = ExecState::Running;
    }
    if process.state.advance(to).is_ok() {
      process.state = to;
    }
    process.stop_signal = None;
    process.foreground = false;
    process.outcome = Some(outcome);
  }

  fn settled_future(&self, pid: u32) -> Option<JobOutcomeFuture> {
    self
      .0
      .borrow()
      .processes
      .iter()
      .find(|process| process.pid == pid)
      .map(|process| process.settled.clone())
  }

  /// Wait for `pid` (already known to the table) and record its outcome.
  async fn reap(&self, pid: u32) -> std::result::Result<JobOutcome, String> {
    let settled = self
      .settled_future(pid)
      .ok_or_else(|| format!("pid {pid} is not a child of this shell"))?;
    let outcome = settled.await;
    self.settle(pid, outcome.clone());
    outcome
  }

  /// Blocking twin of [`Self::reap`] for the synchronous Lisp natives. Sound
  /// because every settlement resolves from a reaper thread, never from a
  /// task on this thread's runtime.
  fn reap_blocking(&self, pid: u32) -> std::result::Result<JobOutcome, String> {
    let settled = self
      .settled_future(pid)
      .ok_or_else(|| format!("pid {pid} is not a child of this shell"))?;
    let outcome = futures::executor::block_on(settled);
    self.settle(pid, outcome.clone());
    outcome
  }

  /// The captured stdout of `pid`, once.
  fn take_stdout(&self, pid: u32) -> Rc<Vec<u8>> {
    let mut table = self.0.borrow_mut();
    let Some(process) = table
      .processes
      .iter_mut()
      .find(|process| process.pid == pid)
    else {
      return Rc::default();
    };
    if process.stdout_delivered {
      return Rc::default();
    }
    match &process.outcome {
      Some(Ok(outcome)) => {
        process.stdout_delivered = true;
        outcome.stdout.clone()
      }
      _ => Rc::default(),
    }
  }

  /// Remove `pid` from the jobs table (its label is freed); the process
  /// stays known for `wait PID`.
  fn forget_job(&self, pid: u32) {
    let mut table = self.0.borrow_mut();
    if let Some(process) = table
      .processes
      .iter_mut()
      .find(|process| process.pid == pid)
    {
      process.number = None;
    }
    if table.current == Some(pid) || table.previous == Some(pid) {
      table.reset_current();
    }
  }

  fn knows(&self, pid: u32) -> bool {
    self
      .0
      .borrow()
      .processes
      .iter()
      .any(|process| process.pid == pid)
  }

  fn finished(&self, pid: u32) -> bool {
    self
      .0
      .borrow()
      .processes
      .iter()
      .any(|process| process.pid == pid && process.outcome.is_some())
  }

  /// Pids of the jobs table, by label.
  pub(in crate::script) fn job_pids(&self) -> Vec<u32> {
    let table = self.0.borrow();
    let mut jobs: Vec<(u32, u32)> = table
      .processes
      .iter()
      .filter_map(|process| process.number.map(|number| (number, process.pid)))
      .collect();
    jobs.sort();
    jobs.into_iter().map(|(_, pid)| pid).collect()
  }

  /// Every child not yet waited for: jobs and process substitutions.
  fn unreaped_pids(&self) -> Vec<u32> {
    self
      .0
      .borrow()
      .processes
      .iter()
      .filter(|process| process.number.is_some() || process.outcome.is_none())
      .map(|process| process.pid)
      .collect()
  }

  fn mark(&self, pid: u32) -> Mark {
    let table = self.0.borrow();
    if table.number_of(pid).is_none() {
      Mark::Other
    } else if table.current == Some(pid) {
      Mark::Current
    } else if table.previous == Some(pid) {
      Mark::Previous
    } else {
      Mark::Other
    }
  }

  fn current(&self, previous: bool) -> Option<u32> {
    let table = self.0.borrow();
    let pid = if previous {
      table.previous
    } else {
      table.current
    }?;
    table.number_of(pid).map(|_| pid)
  }

  /// Resolve a bash job spec: `%N`, `%+`/`%%`/`%`, `%-`, `%string` (command
  /// prefix) and `%?string` (command substring).
  pub(in crate::script) fn resolve(&self, spec: &str) -> std::result::Result<u32, NoSuchJob> {
    let missing = || NoSuchJob(vec![format!("{spec}: no such job")]);
    let Some(body) = spec.strip_prefix('%') else {
      return Err(missing());
    };
    match body {
      "" | "%" | "+" => return self.current(false).ok_or_else(missing),
      "-" => return self.current(true).ok_or_else(missing),
      _ => {}
    }
    let table = self.0.borrow();
    let jobs = table
      .processes
      .iter()
      .filter(|process| process.number.is_some());
    if let Ok(number) = body.parse::<u32>() {
      return table
        .processes
        .iter()
        .find(|process| process.number == Some(number))
        .map(|process| process.pid)
        .ok_or_else(missing);
    }
    let (needle, matches): (&str, Vec<u32>) = match body.strip_prefix('?') {
      Some(needle) => (
        needle,
        jobs
          .filter(|process| process.command.contains(needle))
          .map(|process| process.pid)
          .collect(),
      ),
      None => (
        body,
        jobs
          .filter(|process| process.command.starts_with(body))
          .map(|process| process.pid)
          .collect(),
      ),
    };
    match matches.as_slice() {
      [pid] => Ok(*pid),
      [] => Err(missing()),
      _ => Err(NoSuchJob(vec![
        format!("{needle}: ambiguous job spec"),
        format!("{spec}: no such job"),
      ])),
    }
  }

  /// A Lisp job reference: a `job/v1` value, an execution id or a pid.
  fn find(&self, reference: &JsonValue) -> std::result::Result<u32, String> {
    let table = self.0.borrow();
    let by_execution = |execution: &str| {
      table
        .processes
        .iter()
        .find(|process| process.execution == execution)
        .map(|process| process.pid)
    };
    let by_pid = |pid: u64| {
      table
        .processes
        .iter()
        .find(|process| u64::from(process.pid) == pid)
        .map(|process| process.pid)
    };
    let found = match reference {
      JsonValue::Object(job) => job
        .get("execution")
        .and_then(JsonValue::as_str)
        .and_then(by_execution),
      JsonValue::Number(pid) => pid.as_u64().and_then(by_pid),
      JsonValue::String(text) if text.starts_with('%') => {
        return Err(format!(
          "{text}: a job label is not a job; use (std.jobs.resolve \"{text}\")"
        ));
      }
      JsonValue::String(text) => {
        by_execution(text).or_else(|| text.parse::<u64>().ok().and_then(by_pid))
      }
      _ => None,
    };
    found.ok_or_else(|| format!("{reference}: no such job"))
  }

  /// The `job/v1` projection of `pid`.
  pub(in crate::script) fn view(&self, pid: u32) -> Option<JsonValue> {
    let mark = self.mark(pid);
    let table = self.0.borrow();
    let process = table.processes.iter().find(|process| process.pid == pid)?;
    let outcome = match &process.outcome {
      Some(Ok(outcome)) => json!({"status": outcome.status, "signal": outcome.signal}),
      Some(Err(error)) => json!({"error": error}),
      None => JsonValue::Null,
    };
    // bash's status column, for any renderer of the projection.
    let status_text = match &process.outcome {
      Some(Ok(outcome)) => status_text(outcome),
      Some(Err(_)) => "Exit 1".to_string(),
      None if process.state == ExecState::Stopped => stopped_text(process.stop_signal),
      None => "Running".to_string(),
    };
    Some(json!({
      "datatype": "job/v1",
      "execution": process.execution,
      "label": process.number.map(|number| format!("%{number}")),
      "current": process.number.and(match mark {
        Mark::Current => Some("+"),
        Mark::Previous => Some("-"),
        Mark::Other => None,
      }),
      "pid": process.pid,
      "state": process.state.name(),
      "status_text": status_text,
      "command": process.command,
      "cwd": process.cwd.as_ref().map(|cwd| cwd.display().to_string()),
      "started_at_ms": process.started_ms,
      "elapsed_ms": now_ms().saturating_sub(process.started_ms),
      "outcome": outcome,
      "terminal_artifact": JsonValue::Null,
      "attached_viewers": 0,
      "foreground_lease": if process.foreground {
        json!({"holder": "shell"})
      } else {
        JsonValue::Null
      },
      "stop_signal": process.stop_signal,
    }))
  }

  /// bash's `jobs` line for `pid`; `long` adds the pid (`jobs -l`).
  pub(in crate::script) fn bash_line(&self, pid: u32, long: bool) -> Option<String> {
    let mark = match self.mark(pid) {
      Mark::Current => '+',
      Mark::Previous => '-',
      Mark::Other => ' ',
    };
    let table = self.0.borrow();
    let process = table.processes.iter().find(|process| process.pid == pid)?;
    let number = process.number?;
    let (state, running) = match &process.outcome {
      // bash without job control never tells of a stop: the job reads Running.
      // `jobs -l` names the stop by the signal's description (macOS:
      // `Suspended: 18`), as bash's long format does.
      #[cfg(unix)]
      None if process.state == ExecState::Stopped && process.pgid.is_some() && long => (
        signal_description(process.stop_signal.unwrap_or(libc::SIGTSTP)),
        false,
      ),
      None if process.state == ExecState::Stopped && process.pgid.is_some() => {
        (stopped_text(process.stop_signal), false)
      }
      None => ("Running".to_string(), true),
      Some(Ok(outcome)) => (status_text(outcome), false),
      Some(Err(_)) => ("Exit 1".to_string(), false),
    };
    let middle = if long {
      format!(" {:>5} ", process.pid)
    } else {
      "  ".into()
    };
    Some(format!(
      "[{number}]{mark}{middle}{state:<27}{}{}",
      process.command,
      if running { " &" } else { "" }
    ))
  }
}

/// bash's status column for a stopped job: plain `Stopped` after the
/// terminal's SIGTSTP, the signal named otherwise.
fn stopped_text(signal: Option<i32>) -> String {
  #[cfg(unix)]
  {
    return match signal {
      Some(signal) if signal == libc::SIGSTOP => "Stopped (SIGSTOP)".into(),
      Some(signal) if signal == libc::SIGTTIN => "Stopped (SIGTTIN)".into(),
      Some(signal) if signal == libc::SIGTTOU => "Stopped (SIGTTOU)".into(),
      _ => "Stopped".into(),
    };
  }
  #[cfg(not(unix))]
  {
    let _ = signal;
    "Stopped".into()
  }
}

/// bash's status column: `Done`, `Exit N`, or the signal's description.
fn status_text(outcome: &JobOutcome) -> String {
  match outcome.signal {
    Some(signal) => signal_description(signal),
    None if outcome.status == 0 => "Done".into(),
    None => format!("Exit {}", outcome.status),
  }
}

/// bash's status column for a settled job: `Done`, `Exit N`, or the signal's
/// description. For an embedder's rows of the jobs it admitted.
pub fn job_status_text(status: i32, signal: Option<i32>) -> String {
  status_text(&JobOutcome {
    status,
    signal,
    statuses: Vec::new(),
    stdout: Rc::default(),
  })
}

/// bash's status column for a stopped job (`Stopped`, `Stopped (SIGSTOP)`).
pub fn job_stopped_text(signal: Option<i32>) -> String {
  stopped_text(signal)
}

#[cfg(unix)]
fn signal_description(signal: i32) -> String {
  // SAFETY: strsignal returns a pointer to a NUL-terminated static or
  // thread-local string, copied out before any other libc call.
  let text = unsafe { libc::strsignal(signal) };
  if text.is_null() {
    return format!("Signal {signal}");
  }
  unsafe { std::ffi::CStr::from_ptr(text) }
    .to_string_lossy()
    .into_owned()
}

#[cfg(not(unix))]
fn signal_description(signal: i32) -> String {
  format!("Signal {signal}")
}

/// Signal names bash's `kill` accepts, with or without `SIG`.
#[cfg(unix)]
fn signal_number(spec: &str) -> Option<i32> {
  if let Ok(number) = spec.parse::<i32>() {
    return (0..=64).contains(&number).then_some(number);
  }
  let name = spec.to_ascii_uppercase();
  let name = name.strip_prefix("SIG").unwrap_or(&name);
  Some(match name {
    "HUP" => libc::SIGHUP,
    "INT" => libc::SIGINT,
    "QUIT" => libc::SIGQUIT,
    "ILL" => libc::SIGILL,
    "TRAP" => libc::SIGTRAP,
    "ABRT" | "IOT" => libc::SIGABRT,
    "FPE" => libc::SIGFPE,
    "KILL" => libc::SIGKILL,
    "BUS" => libc::SIGBUS,
    "SEGV" => libc::SIGSEGV,
    "SYS" => libc::SIGSYS,
    "PIPE" => libc::SIGPIPE,
    "ALRM" => libc::SIGALRM,
    "TERM" => libc::SIGTERM,
    "URG" => libc::SIGURG,
    "STOP" => libc::SIGSTOP,
    "TSTP" => libc::SIGTSTP,
    "CONT" => libc::SIGCONT,
    "CHLD" => libc::SIGCHLD,
    "TTIN" => libc::SIGTTIN,
    "TTOU" => libc::SIGTTOU,
    "IO" => libc::SIGIO,
    "XCPU" => libc::SIGXCPU,
    "XFSZ" => libc::SIGXFSZ,
    "VTALRM" => libc::SIGVTALRM,
    "PROF" => libc::SIGPROF,
    "WINCH" => libc::SIGWINCH,
    "USR1" => libc::SIGUSR1,
    "USR2" => libc::SIGUSR2,
    _ => return None,
  })
}

#[cfg(unix)]
fn send_signal(pid: i64, signal: i32) -> std::io::Result<()> {
  let pid =
    libc::pid_t::try_from(pid).map_err(|_| std::io::Error::from_raw_os_error(libc::ESRCH))?;
  // SAFETY: kill has no memory effects; failure is reported through errno.
  if unsafe { libc::kill(pid, signal) } == 0 {
    Ok(())
  } else {
    Err(std::io::Error::last_os_error())
  }
}

/// The bash text a job reports as its command: the stage printed back as
/// bash prints it (`( exit 3 )`, `{ a; b; }`, `cmd > file`), words quoted
/// only where they need it; a stage with expansions falls back to the posix
/// renderer.
fn command_text(host: &mut LispHost, stage: &LispValue<Sym>) -> String {
  let head = host.application_head(stage);
  let operands: Vec<LispValue<Sym>> = match stage {
    LispValue::List(list) => list.items.iter().skip(1).cloned().collect(),
    _ => Vec::new(),
  };
  let join = |separator: &str, host: &mut LispHost| {
    operands
      .iter()
      .map(|operand| command_text(host, operand))
      .collect::<Vec<_>>()
      .join(separator)
  };
  match (head.as_deref(), operands.as_slice()) {
    (Some("std.sh.subshell"), [inner]) => return format!("( {} )", command_text(host, inner)),
    (Some("std.sh.group"), [inner]) => {
      let inner = command_text(host, inner);
      let separator = if inner.ends_with(" &") { "" } else { ";" };
      return format!("{{ {inner}{separator} }}");
    }
    (Some("std.sh.not"), [inner]) => return command_text(host, inner),
    (Some(tento_lisp::SPAWN_FORM | "std.sh.background"), [inner]) => {
      return format!("{} &", command_text(host, inner));
    }
    // bash ends a background member with `&`, not `&;`.
    (Some("std.sh.seq"), _) => {
      let mut text = String::new();
      for operand in &operands {
        if !text.is_empty() {
          text.push_str(if text.ends_with(" &") { " " } else { "; " });
        }
        text.push_str(&command_text(host, operand));
      }
      return text;
    }
    (Some("std.sh.and"), _) => return join(" && ", host),
    (Some("std.sh.or"), _) => return join(" || ", host),
    (Some("std.sh.pipe"), _) => return join(" | ", host),
    (Some("std.sh.redirect"), [inner, LispValue::List(specs)]) => {
      let mut text = command_text(host, inner);
      for spec in specs.items.iter().skip(1) {
        let LispValue::List(spec) = spec else {
          continue;
        };
        let [_, LispValue::Integer(fd), LispValue::String(op), target] = spec.items.as_slice()
        else {
          continue;
        };
        let target = match target {
          LispValue::String(target) => quote_word(target),
          other => command_text(host, other),
        };
        let implied = (*fd == 1 && op.starts_with('>')) || (*fd == 0 && op.starts_with('<'));
        let fd = if implied {
          String::new()
        } else {
          fd.to_string()
        };
        if op.ends_with('&') {
          text.push_str(&format!(" {fd}{op}{target}"));
        } else {
          text.push_str(&format!(" {fd}{op} {target}"));
        }
      }
      return text;
    }
    _ => {}
  }
  if let LispValue::List(list) = stage {
    if let Some(LispValue::Symbol(_)) = list.items.first() {
      if list.items[1..]
        .iter()
        .all(|item| matches!(item, LispValue::String(_)))
      {
        let mut words = vec![head.clone().unwrap_or_default()];
        words.extend(list.items[1..].iter().map(|item| match item {
          LispValue::String(word) => quote_word(word),
          _ => unreachable!(),
        }));
        return words.join(" ");
      }
    }
  }
  if let Some(expression) = to_sexpression(stage) {
    return tento_lisp::render_posix(&expression, host.interp.string_interner());
  }
  host
    .application_to_argv(stage)
    .map(|argv| argv.join(" "))
    .unwrap_or_default()
}

/// A foreground pipeline's command, as a job reports it: `vim notes.md`,
/// `git log | less`.
pub(in crate::script) fn pipeline_text(argv: &[Vec<String>]) -> String {
  argv
    .iter()
    .map(|stage| {
      stage
        .iter()
        .map(|word| quote_word(word))
        .collect::<Vec<_>>()
        .join(" ")
    })
    .collect::<Vec<_>>()
    .join(" | ")
}

/// A word as bash would print it from a script: bare when it needs no
/// quoting, else single-quoted.
fn quote_word(word: &str) -> String {
  if !word.is_empty()
    && word
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c))
  {
    word.to_string()
  } else {
    format!("'{}'", word.replace('\'', "'\\''"))
  }
}

fn to_sexpression(value: &LispValue<Sym>) -> Option<tento_lisp::SExpression<Sym>> {
  use tento_lisp::{Literal, SExpression};
  Some(match value {
    LispValue::Boolean(value) => SExpression::Literal(Literal::Boolean(*value)),
    LispValue::Integer(value) => SExpression::Literal(Literal::Integer(*value)),
    LispValue::Float(value) => SExpression::Literal(Literal::Float(*value)),
    LispValue::String(value) => SExpression::Literal(Literal::String(value.to_string())),
    LispValue::Symbol(symbol) => SExpression::Literal(Literal::Symbol(symbol.as_symbol())),
    LispValue::List(list) => SExpression::List(
      list
        .items
        .iter()
        .map(to_sexpression)
        .collect::<Option<Vec<_>>>()?,
    ),
    _ => return None,
  })
}

/// Route a session job's inherited stdout/stderr through pipes into `output`.
#[cfg(unix)]
fn route_output(io: &mut ShellIo, output: &BackgroundOutput) -> std::io::Result<()> {
  for fd in [1, 2] {
    if !matches!(io.target(fd), FdTarget::Inherit(source) if source == fd) {
      continue;
    }
    let (reader, writer) = super::shell_workers::pipe()?;
    io.0.insert(fd, FdTarget::File(Arc::new(writer)));
    let output = output.clone();
    spawn_reaper(move || {
      use std::io::Read;
      let mut reader = reader;
      let mut chunk = [0u8; 8192];
      loop {
        match reader.read(&mut chunk) {
          Ok(0) | Err(_) => break,
          Ok(count) => output(&chunk[..count], fd == 2),
        }
      }
      output(&[], fd == 2);
    });
  }
  Ok(())
}

#[cfg(not(unix))]
fn route_output(_io: &mut ShellIo, _output: &BackgroundOutput) -> std::io::Result<()> {
  Ok(())
}

/// Whether a redirect list names descriptor 0 (`<file`, `<&0`, `0<&-`).
fn redirects_stdin(specs: &LispValue<Sym>) -> bool {
  let LispValue::List(specs) = specs else {
    return false;
  };
  specs.items.iter().any(|spec| {
    matches!(spec, LispValue::List(spec) if matches!(spec.items.get(1), Some(LispValue::Integer(0))))
  })
}

/// A Lisp argument as one argv word.
fn lisp_word(value: &LispValue<Sym>) -> String {
  match value {
    LispValue::String(text) => text.to_string(),
    other => {
      let json = super::interp::value_to_json(other);
      json
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| json.to_string())
    }
  }
}

fn command_error(detail: String) -> TshScriptErrorKind {
  TshScriptErrorKind::Lisp(LispHostError::Command(detail))
}

fn native_error(detail: String) -> LispHostError {
  LispHostError::Runtime(detail)
}

/// bash's `wait` usage line.
const WAIT_USAGE: &str = "wait: usage: wait [-fn] [-p var] [id ...]";

impl LispHost {
  /// Install the session's job host (see [`JobHost`]); it also runs
  /// `(std.jobs.spawn …)`.
  pub fn set_job_host(&mut self, host: Rc<dyn JobHost>) {
    self.shell_compound.commands.jobs.set_host(Some(host));
  }

  /// `cmd &`: submit the stage with no foreground; `$!` is its pid.
  pub(in crate::script) async fn start_shell_job(
    &mut self,
    stage: &LispValue<Sym>,
    line: usize,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    let command = command_text(self, stage);
    self
      .spawn_job(stage, line, output.capture.is_some(), command)
      .await?;
    self.set_shell_status(0);
    Ok(None)
  }

  /// `std.jobs.spawn` for a compiled stage: admit, start and record one job.
  async fn spawn_job(
    &mut self,
    stage: &LispValue<Sym>,
    line: usize,
    capture: bool,
    command: String,
  ) -> Result<u32> {
    // A job whose start forks this host reserves before its admission: a
    // refused job is never admitted and none of its redirections run.
    let forks = super::owned_io_fork::background_forks(self, stage);
    let unit = self
      .reserve_fork_unit(forks, "background job", line)
      .map_err(command_error)?;
    let jobs = self.shell_compound.commands.jobs.clone();
    let interactive = self.job_control();
    let plan = JobPlan {
      command: command.clone(),
      cwd: std::env::current_dir().ok(),
      interactive,
    };
    let slot = match jobs.admit(&plan) {
      Some(JobAdmission::Replayed {
        execution,
        pid,
        settled,
      }) => {
        jobs.submit(pid, Some(execution), command, settled, true);
        self.shell_compound.commands.last_pid.set(pid);
        return Ok(pid);
      }
      Some(JobAdmission::Fresh(slot)) => Some(slot),
      None => None,
    };
    let output = if capture {
      None
    } else {
      slot.as_ref().and_then(|slot| slot.output())
    };
    let started = self
      .start_job_process(stage, line, capture, output, interactive, unit)
      .await;
    let job = match started {
      Ok(job) => job,
      Err(error) => {
        if let Some(slot) = slot {
          slot.failed(&error.to_string());
        }
        return Err(error);
      }
    };
    let pid = job.pid;
    let settled = settle(job, self.shell_compound.commands.pipefail);
    let execution = slot.as_ref().map(|slot| slot.execution());
    let number = jobs.submit(pid, execution, command, settled.clone(), true);
    if interactive {
      jobs.set_group(pid, Some(pid));
    }
    if let Some(slot) = slot {
      let observer = slot.observer();
      if let Some(number) = number {
        slot.labelled(number);
      }
      slot.started(pid, settled);
      // After `started`, so a stop that came first replays onto a running job.
      if let Some(observer) = observer {
        control::observe(pid, observer);
      }
    } else if interactive {
      // No session records to show a row: bash's line, on stderr.
      if let Some(number) = number {
        self.report_shell_diagnostic(format!("[{number}] {pid}"));
      }
    }
    self.shell_compound.commands.last_pid.set(pid);
    Ok(pid)
  }

  /// Start the process for a background stage: a compound plan runs in a
  /// forked shell, a pure builtin as an admitted byte-copy worker, anything
  /// else through the external host. `unit` is the job's fork reservation,
  /// taken before admission and released when its own preparation ends.
  async fn start_job_process(
    &mut self,
    stage: &LispValue<Sym>,
    line: usize,
    capture: bool,
    output: Option<BackgroundOutput>,
    interactive: bool,
    mut unit: Option<super::owned_io_fork::UnitReservation>,
  ) -> Result<ShellJob> {
    let mut explicit_stdin = false;
    let (stage, io) =
      if let Some((stage, specs)) = super::shell_redirect::redirected_stage(self, stage) {
        explicit_stdin = redirects_stdin(specs);
        let io = super::shell_redirect::prepare(self, specs, line)
          .await
          .map_err(|(_, error)| command_error(error))?;
        (stage, Some(io))
      } else {
        (stage, self.shell_io.borrow().clone())
      };
    let mut io = io;
    if explicit_stdin {
      // `cmd <&0 &` keeps the shell's stdin; only an inherited one is /dev/null.
      let mut kept = io.take().unwrap_or_default();
      if matches!(kept.target(0), FdTarget::Inherit(0)) {
        kept.0.insert(
          0,
          self
            .kept_stdin()
            .map_err(|error| command_error(error.to_string()))?,
        );
      }
      io = Some(kept);
    }
    if let Some(output) = &output {
      let mut routed = io.take().unwrap_or_default();
      route_output(&mut routed, output).map_err(|error| command_error(error.to_string()))?;
      io = Some(routed);
    }
    if super::bash_flow::is_flow(self.application_head(stage).as_deref()) {
      let _group = control::GroupScope::enter(interactive);
      let permission = self
        .fork_permission("background job", line)
        .map_err(TshScriptErrorKind::Lisp)?;
      let job = self
        .fork_shell_plan(stage, line, io.unwrap_or_default(), capture, true, &permission)
        .map_err(TshScriptErrorKind::Lisp);
      // The fork was this job's last preparation; the child's copies are inert.
      drop(permission);
      drop(unit);
      return job;
    }
    // Redirections alone: the reservation ends with their preparation.
    if !super::owned_io_fork::words_fork(self, stage) {
      drop(unit.take());
    }
    let resolved = super::shell_redirect::resolve_target(self, stage, line)
      .await
      .map_err(command_error)?;
    // The words were the last of this job's own preparation.
    drop(unit);
    let mut argv = self
      .application_to_argv(&resolved)
      .map_err(TshScriptErrorKind::Command)?;
    if let Some(name) = argv
      .first()
      .cloned()
      .filter(|name| matches!(name.as_str(), "echo" | ":" | "true" | "false"))
    {
      // Compatibility stays in the builtin. An admitted byte-copy worker gives
      // even a pure builtin an actual OS pid and independent output scheduling.
      let result = self
        .shell_builtin_bytes(argv.clone(), line)
        .ok_or_else(|| command_error(format!("background {name}: invalid operands")))?;
      for diagnostic in result.diagnostics {
        self.report_shell_diagnostic(diagnostic);
      }
      if result.status == 0 {
        let mut descriptors = io.unwrap_or_default();
        descriptors.0.insert(
          0,
          FdTarget::Text(Arc::new(std::sync::Mutex::new(result.stdout))),
        );
        io = Some(descriptors);
        argv = vec!["/bin/cat".into()];
      } else {
        argv = vec!["/usr/bin/false".into()];
      }
    } else if !self.shell_external_stage(&resolved) {
      let head = self.application_head(&resolved);
      // A found external may be refused by the host's execution policy.
      // Preserve that refusal instead of mislabelling it as a shell builtin.
      if !Self::shell_background_builtin(head.as_deref())
        && self.posix_value_is_unbound(&resolved)
        && !head.as_ref().is_some_and(|name| self.shell_compound.functions.contains_key(name))
      {
        if let Some(super::interp::ExternalLookup::Undeclared(path)) = head.as_ref()
          .and_then(|name| self.external.as_ref().map(|external| external.lookup(name)))
        {
          return Err(command_error(format!(
            "background {}: external execution is not declared ({path}); declare exec.path or exec.dir in the script",
            head.as_deref().unwrap_or("command")
          )));
        }
      }
      return Err(command_error(format!(
        "background {}: stateful in-process commands and compound jobs are not supported yet",
        head.unwrap_or_else(|| "command".into())
      )));
    }
    let external = self
      .external
      .clone()
      .ok_or_else(|| command_error("background: external host is not installed".into()))?;
    super::shell_printf::prepare_printf_argv(&mut argv);
    let _ = super::flush_shell_output();
    let _group = control::GroupScope::enter(interactive);
    external
      .start_background(argv, io, capture)
      .map_err(TshScriptErrorKind::Command)
  }

  /// The shell's own stdin as an explicit descriptor target: the stage's
  /// typed input when it has one, else a duplicate of descriptor 0.
  #[cfg(unix)]
  fn kept_stdin(&self) -> std::io::Result<FdTarget> {
    use std::os::fd::FromRawFd;
    if let Some(bytes) = self.shell_stdin_bytes() {
      return Ok(FdTarget::Text(Arc::new(std::sync::Mutex::new(bytes))));
    }
    // SAFETY: dup returns a fresh descriptor this File then owns alone.
    let fd = unsafe { libc::dup(0) };
    if fd < 0 {
      return Err(std::io::Error::last_os_error());
    }
    Ok(FdTarget::File(Arc::new(unsafe {
      std::fs::File::from_raw_fd(fd)
    })))
  }

  #[cfg(not(unix))]
  fn kept_stdin(&self) -> std::io::Result<FdTarget> {
    Ok(FdTarget::Inherit(0))
  }

  /// A process substitution's child: waited for by a bare `wait`, never a
  /// numbered job.
  pub(in crate::script) fn submit_process_substitution(&mut self, job: ShellJob) {
    let pid = job.pid;
    let settled = settle(job, false);
    self
      .shell_compound
      .commands
      .jobs
      .submit(pid, None, String::new(), settled, false);
    self.shell_compound.commands.last_pid.set(pid);
  }

  fn job_diagnostic(&mut self, line: usize, builtin: &str, message: &str) {
    self.report_shell_diagnostic(format!("tsh: line {line}: {builtin}: {message}"));
  }

  /// Resolve a `%spec` for `builtin`, reporting bash's diagnostics.
  fn resolve_job_spec(&mut self, line: usize, builtin: &str, spec: &str) -> Option<u32> {
    match self.shell_compound.commands.jobs.resolve(spec) {
      Ok(pid) => Some(pid),
      Err(NoSuchJob(messages)) => {
        for message in messages {
          self.job_diagnostic(line, builtin, &message);
        }
        None
      }
    }
  }

  /// `std.jobs.wait` for one known child: its outcome, its captured stdout
  /// delivered once, and its label freed.
  async fn wait_job(
    &mut self,
    pid: u32,
    output: &FlowOutput,
  ) -> Result<std::result::Result<JobOutcome, String>> {
    let jobs = self.shell_compound.commands.jobs.clone();
    let outcome = jobs.reap(pid).await;
    let stdout = jobs.take_stdout(pid);
    if !stdout.is_empty() {
      output.write_bytes(self, &stdout);
    }
    jobs.forget_job(pid);
    Ok(outcome)
  }

  /// `std.jobs.wait-any`: the first of `pids` to finish (one that already
  /// finished first), or `None` when there are none.
  async fn wait_any_job(&mut self, pids: Vec<u32>) -> Option<u32> {
    let jobs = self.shell_compound.commands.jobs.clone();
    jobs.poll();
    if pids.is_empty() {
      return None;
    }
    if let Some(done) = pids.iter().copied().find(|pid| jobs.finished(*pid)) {
      return Some(done);
    }
    let racers: Vec<_> = pids
      .iter()
      .filter_map(|pid| {
        let pid = *pid;
        jobs
          .settled_future(pid)
          .map(|settled| async move { (pid, settled.await) }.boxed_local())
      })
      .collect();
    if racers.is_empty() {
      return None;
    }
    let ((pid, outcome), _, _) = futures::future::select_all(racers).await;
    jobs.settle(pid, outcome);
    Some(pid)
  }

  /// bash `wait [-fn] [-p VAR] [ID ...]`, over `std.jobs.wait` and
  /// `std.jobs.wait-any`.
  pub(in crate::script) async fn wait_builtin(
    &mut self,
    args: &[String],
    line: usize,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    let mut any = false;
    let mut variable = None;
    let mut index = 0;
    while index < args.len() {
      let arg = &args[index];
      if arg == "--" {
        index += 1;
        break;
      }
      if !arg.starts_with('-') || arg == "-" || arg[1..].parse::<i64>().is_ok() {
        break;
      }
      let mut flags = arg[1..].chars();
      while let Some(flag) = flags.next() {
        match flag {
          'n' => any = true,
          'f' => {}
          'p' => {
            let rest: String = flags.by_ref().collect();
            if !rest.is_empty() {
              variable = Some(rest);
            } else if let Some(name) = args.get(index + 1) {
              variable = Some(name.clone());
              index += 1;
            } else {
              self.job_diagnostic(line, "wait", "-p: option requires an argument");
              self.report_shell_diagnostic(WAIT_USAGE.into());
              self.set_shell_status(2);
              return Ok(None);
            }
          }
          other => {
            self.job_diagnostic(line, "wait", &format!("-{other}: invalid option"));
            self.report_shell_diagnostic(WAIT_USAGE.into());
            self.set_shell_status(2);
            return Ok(None);
          }
        }
      }
      index += 1;
    }
    let ids = &args[index..];
    let jobs = self.shell_compound.commands.jobs.clone();
    jobs.poll();
    if any {
      let mut pids = Vec::new();
      if ids.is_empty() {
        pids = jobs.job_pids();
      } else {
        for id in ids {
          if id.starts_with('%') {
            if let Some(pid) = self.resolve_job_spec(line, "wait", id) {
              pids.push(pid);
            }
          } else if let Ok(pid) = id.parse::<u32>() {
            if jobs.job_pids().contains(&pid) {
              pids.push(pid);
            }
          }
        }
      }
      let status = match self.wait_any_job(pids).await {
        Some(pid) => {
          if let Some(name) = &variable {
            self.assign_shell_variable(name, pid.to_string(), false);
          }
          match self.wait_job(pid, &output).await? {
            Ok(outcome) => outcome.status,
            Err(_) => 127,
          }
        }
        None => 127,
      };
      self.set_shell_status(status);
      return Ok(None);
    }
    if ids.is_empty() {
      for pid in jobs.unreaped_pids() {
        // A bare wait returns 0 whatever its children did.
        let _ = self.wait_job(pid, &output).await?;
        if let Some(name) = &variable {
          self.assign_shell_variable(name, pid.to_string(), false);
        }
      }
      self.set_shell_status(0);
      return Ok(None);
    }
    let mut status = 0;
    for id in ids {
      let pid = if id.starts_with('%') {
        match self.resolve_job_spec(line, "wait", id) {
          Some(pid) => pid,
          None => {
            status = 127;
            continue;
          }
        }
      } else {
        match id.parse::<u32>() {
          Ok(pid) if jobs.knows(pid) => pid,
          Ok(pid) => {
            self.job_diagnostic(
              line,
              "wait",
              &format!("pid {pid} is not a child of this shell"),
            );
            status = 127;
            continue;
          }
          Err(_) => {
            self.job_diagnostic(
              line,
              "wait",
              &format!("`{id}': not a pid or valid job spec"),
            );
            status = 1;
            continue;
          }
        }
      };
      status = match self.wait_job(pid, &output).await? {
        Ok(outcome) => outcome.status,
        Err(_) => 127,
      };
      if let Some(name) = &variable {
        self.assign_shell_variable(name, pid.to_string(), false);
      }
    }
    self.set_shell_status(status);
    Ok(None)
  }

  /// bash `jobs [-lnprs] [JOBSPEC ...]` over `std.jobs.list`: bash's text
  /// unless tsh renders the output, where it is the structured list.
  pub(in crate::script) fn jobs_builtin(
    &mut self,
    args: &[String],
    line: usize,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    let (mut long, mut pids_only, mut running, mut stopped) = (false, false, false, false);
    let mut index = 0;
    while let Some(arg) = args.get(index) {
      if arg == "--" {
        index += 1;
        break;
      }
      if !arg.starts_with('-') || arg == "-" {
        break;
      }
      for flag in arg[1..].chars() {
        match flag {
          'l' => long = true,
          'p' => pids_only = true,
          'r' => running = true,
          's' => stopped = true,
          'n' => {}
          'x' => {
            return Err(command_error("jobs: -x: not supported yet".into()));
          }
          other => {
            self.job_diagnostic(line, "jobs", &format!("-{other}: invalid option"));
            self.report_shell_diagnostic(
              "jobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]".into(),
            );
            self.set_shell_status(2);
            return Ok(None);
          }
        }
      }
      index += 1;
    }
    let jobs = self.shell_compound.commands.jobs.clone();
    jobs.poll();
    let mut status = 0;
    let selected: Vec<u32> = if index >= args.len() {
      jobs.job_pids()
    } else {
      let mut selected = Vec::new();
      for spec in &args[index..] {
        match self.resolve_job_spec(line, "jobs", spec) {
          Some(pid) => selected.push(pid),
          None => status = 1,
        }
      }
      selected
    };
    let selected: Vec<u32> = selected
      .into_iter()
      .filter(|pid| {
        let finished = jobs.finished(*pid);
        let held = jobs.is_held(*pid);
        // `-r` keeps the running jobs, `-s` the stopped ones.
        !(running && (finished || held)) && !(stopped && !held)
      })
      .collect();
    let shaped = output.shaped && output.capture.is_none() && self.stdout_inherited();
    // An empty table prints nothing, rendered or not, as bash's does.
    let result = if shaped && !pids_only && !selected.is_empty() {
      Some(JsonValue::Array(
        selected.iter().filter_map(|pid| jobs.view(*pid)).collect(),
      ))
    } else {
      let mut text = String::new();
      for pid in &selected {
        let entry = if pids_only {
          Some(pid.to_string())
        } else {
          jobs.bash_line(*pid, long)
        };
        if let Some(entry) = entry {
          text.push_str(&entry);
          text.push('\n');
        }
      }
      output.write_bytes(self, text.as_bytes());
      None
    };
    // A finished job is reported once, then leaves the table.
    if !pids_only {
      for pid in selected {
        if jobs.finished(pid) {
          jobs.forget_job(pid);
        }
      }
    }
    self.set_shell_status(status);
    Ok(result)
  }

  fn stdout_inherited(&self) -> bool {
    self
      .shell_io
      .borrow()
      .as_ref()
      .is_none_or(|io| matches!(io.target(1), FdTarget::Inherit(1)))
  }

  /// bash `kill [-s sigspec | -n signum | -sigspec] pid | jobspec ...` and
  /// `kill -l|-L [sigspec]`, a tsh builtin in a bash context (README D:
  /// bash's builtins are tsh builtins). A job spec signals through
  /// `std.jobs.signal`'s target; a signal to this shell is raised on the
  /// current thread, so its trap runs before the next command.
  #[cfg(unix)]
  pub(in crate::script) fn kill_builtin(
    &mut self,
    args: &[String],
    line: usize,
    output: FlowOutput,
  ) -> Option<Result<Option<JsonValue>>> {
    use super::bash_compound::traps::{parse_signal, signal_listing, signal_name};
    const USAGE: &str =
      "kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]";
    let invalid_spec = |host: &mut Self, spec: &str| {
      host.job_diagnostic(line, "kill", &format!("{spec}: invalid signal specification"));
      host.set_shell_status(1);
      Some(Ok(None))
    };
    if args.is_empty() {
      self.report_shell_diagnostic(USAGE.into());
      self.set_shell_status(2);
      return Some(Ok(None));
    }
    let mut signal = libc::SIGTERM;
    let mut index = 0;
    let mut spec_given = None;
    while let Some(arg) = args.get(index) {
      if arg == "--" {
        index += 1;
        break;
      }
      if arg == "-l" || arg == "-L" {
        let mut text = String::new();
        let mut status = 0;
        let operands = &args[index + 1..];
        if operands.is_empty() {
          text = signal_listing();
        }
        for operand in operands {
          let found = match operand.parse::<i32>() {
            Ok(number) => {
              let number = if number > 128 { number - 128 } else { number };
              signal_name(number).map(|name| name.trim_start_matches("SIG").to_string())
            }
            Err(_) => parse_signal(operand).map(|number| number.to_string()),
          };
          match found {
            Some(found) => text.push_str(&format!("{found}\n")),
            None => {
              self.job_diagnostic(line, "kill", &format!("{operand}: invalid signal specification"));
              status = 1;
            }
          }
        }
        output.write_bytes(self, text.as_bytes());
        self.set_shell_status(status);
        return Some(Ok(None));
      }
      if arg == "-s" || arg == "-n" {
        let Some(spec) = args.get(index + 1) else {
          self.job_diagnostic(line, "kill", &format!("{arg}: option requires an argument"));
          self.set_shell_status(1);
          return Some(Ok(None));
        };
        spec_given = Some(spec.clone());
        index += 2;
        continue;
      }
      match arg.strip_prefix('-') {
        Some(spec) if !spec.is_empty() && spec_given.is_none() => {
          spec_given = Some(spec.to_string());
          index += 1;
        }
        _ => break,
      }
    }
    if let Some(spec) = spec_given {
      match if spec == "0" { Some(0) } else { parse_signal(&spec) } {
        Some(number) => signal = number,
        None => return invalid_spec(self, &spec),
      }
    }
    let targets = &args[index.min(args.len())..];
    if targets.is_empty() {
      self.report_shell_diagnostic(USAGE.into());
      self.set_shell_status(2);
      return Some(Ok(None));
    }
    let mut delivered = false;
    for target in targets {
      let pid = if target.starts_with('%') {
        match self.resolve_job_spec(line, "kill", target) {
          Some(pid) => self.shell_compound.commands.jobs.signal_target(pid),
          None => continue,
        }
      } else {
        match target.parse::<i64>() {
          Ok(pid) => pid,
          Err(_) => {
            self.job_diagnostic(line, "kill", &format!("`{target}': not a pid or valid job spec"));
            continue;
          }
        }
      };
      let sent = if signal != 0 && pid == i64::from(std::process::id()) {
        // SAFETY: raise has no memory effects; failure is reported through errno.
        if unsafe { libc::raise(signal) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
      } else {
        send_signal(pid, signal)
      };
      match sent {
        Ok(()) => delivered = true,
        Err(error) => {
          let reason = if error.raw_os_error() == Some(libc::ESRCH) {
            "No such process".to_string()
          } else {
            error.to_string()
          };
          self.job_diagnostic(line, "kill", &format!("({pid}) - {reason}"));
        }
      }
    }
    self.set_shell_status(if delivered { 0 } else { 1 });
    Some(Ok(None))
  }

  #[cfg(not(unix))]
  pub(in crate::script) fn kill_builtin(
    &mut self,
    _args: &[String],
    _line: usize,
    _output: FlowOutput,
  ) -> Option<Result<Option<JsonValue>>> {
    None
  }

  /// bash `disown [-ahr] [JOBSPEC|PID ...]` over `std.jobs.disown`.
  pub(in crate::script) fn disown_builtin(
    &mut self,
    args: &[String],
    line: usize,
  ) -> Result<Option<JsonValue>> {
    let (mut all, mut running, mut keep) = (false, false, false);
    let mut index = 0;
    while let Some(arg) = args.get(index) {
      if arg == "--" {
        index += 1;
        break;
      }
      if !arg.starts_with('-') || arg == "-" {
        break;
      }
      for flag in arg[1..].chars() {
        match flag {
          'a' => all = true,
          'r' => running = true,
          'h' => keep = true,
          other => {
            self.job_diagnostic(line, "disown", &format!("-{other}: invalid option"));
            self.report_shell_diagnostic(
              "disown: usage: disown [-h] [-ar] [jobspec ... | pid ...]".into(),
            );
            self.set_shell_status(2);
            return Ok(None);
          }
        }
      }
      index += 1;
    }
    let jobs = self.shell_compound.commands.jobs.clone();
    jobs.poll();
    let mut status = 0;
    let mut chosen = Vec::new();
    let operands = &args[index..];
    if all || running {
      chosen = jobs
        .job_pids()
        .into_iter()
        .filter(|pid| !running || !jobs.finished(*pid))
        .collect();
    } else if operands.is_empty() {
      match jobs.current(false) {
        Some(pid) => chosen.push(pid),
        None => {
          self.job_diagnostic(line, "disown", "current: no such job");
          status = 1;
        }
      }
    }
    for operand in operands {
      let pid = if operand.starts_with('%') {
        self.resolve_job_spec(line, "disown", operand)
      } else {
        let found = operand
          .parse::<u32>()
          .ok()
          .filter(|pid| jobs.job_pids().contains(pid));
        if found.is_none() {
          self.job_diagnostic(line, "disown", &format!("{operand}: no such job"));
        }
        found
      };
      match pid {
        Some(pid) => chosen.push(pid),
        None => status = 1,
      }
    }
    if !keep {
      for pid in chosen {
        jobs.forget_job(pid);
      }
    }
    self.set_shell_status(status);
    Ok(None)
  }

  /// `std.jobs.spawn`, `std.jobs.wait` and `std.jobs.wait-any` as shell
  /// lines, which await rather than block. `None` for any other head.
  pub(in crate::script) async fn std_jobs_line(
    &mut self,
    argv: &[String],
    line: usize,
    output: FlowOutput,
  ) -> Option<Result<Option<JsonValue>>> {
    let name = argv.first()?.as_str();
    let args = &argv[1..];
    let jobs = self.shell_compound.commands.jobs.clone();
    let references = |args: &[String]| {
      args
        .iter()
        .map(|arg| jobs.find(&JsonValue::String(arg.clone())))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| command_error(format!("{name}: {error}")))
    };
    Some(match name {
      "std.jobs.spawn" => {
        if args.is_empty() {
          return Some(Err(command_error(
            "std.jobs.spawn: expected a program and its arguments".into(),
          )));
        }
        let stage = self.shell_literal_call(args, &args[0], false);
        let command = args
          .iter()
          .map(|word| quote_word(word))
          .collect::<Vec<_>>()
          .join(" ");
        match self.spawn_job(&stage, line, false, command).await {
          Ok(pid) => {
            self.set_shell_status(0);
            Ok(jobs.view(pid))
          }
          Err(error) => Err(error),
        }
      }
      "std.jobs.wait" => {
        let pids = match references(args) {
          Ok(pids) if pids.is_empty() => jobs.unreaped_pids(),
          Ok(pids) => pids,
          Err(error) => return Some(Err(error)),
        };
        let mut views = Vec::new();
        for pid in pids {
          if let Err(error) = self.wait_job(pid, &output).await {
            return Some(Err(error));
          }
          views.extend(jobs.view(pid));
        }
        self.set_shell_status(0);
        Ok(Some(if args.len() == 1 {
          views.pop().unwrap_or(JsonValue::Null)
        } else {
          JsonValue::Array(views)
        }))
      }
      "std.jobs.foreground" => return Some(self.foreground_line(args, line, output).await),
      "std.jobs.wait-any" => {
        let pids = match references(args) {
          Ok(pids) if pids.is_empty() => jobs.job_pids(),
          Ok(pids) => pids,
          Err(error) => return Some(Err(error)),
        };
        let view = match self.wait_any_job(pids).await {
          Some(pid) => {
            if let Err(error) = self.wait_job(pid, &output).await {
              return Some(Err(error));
            }
            jobs.view(pid)
          }
          None => None,
        };
        self.set_shell_status(0);
        Ok(Some(view.unwrap_or(JsonValue::Null)))
      }
      _ => return None,
    })
  }

  /// The typed `std.jobs.*` natives. Lisp names jobs by `job/v1` value,
  /// execution id or pid; `std.jobs.resolve` is the one door from a `%`
  /// label. Waiting from Lisp blocks until the reaper thread settles the job.
  pub(in crate::script) fn register_job_natives(&mut self) {
    let jobs = self.shell_compound.commands.jobs.clone();
    let lisp =
      |value: Option<JsonValue>| super::interp::value_from_json(&value.unwrap_or(JsonValue::Null));
    let reference = |name: &'static str, jobs: &JobTable, args: &[LispValue<Sym>]| {
      let [value] = args else {
        return Err(native_error(format!("{name}: expected one job")));
      };
      jobs
        .find(&super::interp::value_to_json(value))
        .map_err(|error| native_error(format!("{name}: {error}")))
    };
    {
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.list", move |args| {
        if !args.is_empty() {
          return Err(native_error("std.jobs.list: expected no arguments".into()));
        }
        jobs.poll();
        Ok(lisp(Some(JsonValue::Array(
          jobs
            .job_pids()
            .into_iter()
            .filter_map(|pid| jobs.view(pid))
            .collect(),
        ))))
      });
    }
    {
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.show", move |args| {
        let pid = reference("std.jobs.show", &jobs, &args)?;
        jobs.poll();
        Ok(lisp(jobs.view(pid)))
      });
    }
    {
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.resolve", move |args| {
        let [LispValue::String(spec)] = args.as_slice() else {
          return Err(native_error(
            "std.jobs.resolve: expected a job spec such as \"%1\"".into(),
          ));
        };
        jobs.poll();
        let pid = jobs.resolve(spec).map_err(|NoSuchJob(messages)| {
          native_error(format!("std.jobs.resolve: {}", messages.join("; ")))
        })?;
        Ok(lisp(jobs.view(pid)))
      });
    }
    // `std.jobs.last` is bash's `$!` and is defined with the shell's
    // parameters (bash_compound/commands.rs), as `set -u` governs it.
    #[cfg(unix)]
    {
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.signal", move |args| {
        let (job, signal) = match args.as_slice() {
          [job] => (job, libc::SIGTERM),
          [job, LispValue::String(signal)] => (
            job,
            signal_number(signal).ok_or_else(|| {
              native_error(format!(
                "std.jobs.signal: {signal}: invalid signal specification"
              ))
            })?,
          ),
          [job, LispValue::Integer(signal)] => (
            job,
            signal_number(&signal.to_string()).ok_or_else(|| {
              native_error(format!(
                "std.jobs.signal: {signal}: invalid signal specification"
              ))
            })?,
          ),
          _ => {
            return Err(native_error(
              "std.jobs.signal: expected (std.jobs.signal JOB [SIGNAL])".into(),
            ));
          }
        };
        let pid = reference("std.jobs.signal", &jobs, std::slice::from_ref(job))?;
        jobs.poll();
        if !jobs.finished(pid) {
          send_signal(jobs.signal_target(pid), signal)
            .map_err(|error| native_error(format!("std.jobs.signal: ({pid}) - {error}")))?;
        }
        Ok(lisp(jobs.view(pid)))
      });
    }
    {
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.disown", move |args| {
        let pid = reference("std.jobs.disown", &jobs, &args)?;
        jobs.forget_job(pid);
        Ok(lisp(jobs.view(pid)))
      });
    }
    {
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.wait", move |args| {
        let pids = if args.is_empty() {
          jobs.unreaped_pids()
        } else {
          args
            .iter()
            .map(|arg| {
              jobs
                .find(&super::interp::value_to_json(arg))
                .map_err(|error| native_error(format!("std.jobs.wait: {error}")))
            })
            .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut views = Vec::new();
        for pid in &pids {
          jobs
            .reap_blocking(*pid)
            .map_err(|error| native_error(format!("std.jobs.wait: {error}")))?;
          jobs.forget_job(*pid);
          views.extend(jobs.view(*pid));
        }
        Ok(lisp(Some(if args.len() == 1 {
          views.pop().unwrap_or(JsonValue::Null)
        } else {
          JsonValue::Array(views)
        })))
      });
    }
    {
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.wait-any", move |args| {
        let pids = if args.is_empty() {
          jobs.job_pids()
        } else {
          args
            .iter()
            .map(|arg| {
              jobs
                .find(&super::interp::value_to_json(arg))
                .map_err(|error| native_error(format!("std.jobs.wait-any: {error}")))
            })
            .collect::<std::result::Result<Vec<_>, _>>()?
        };
        jobs.poll();
        let done = pids.iter().copied().find(|pid| jobs.finished(*pid));
        let pid = match done {
          Some(pid) => Some(pid),
          None => {
            let racers: Vec<_> = pids
              .iter()
              .filter_map(|pid| {
                let pid = *pid;
                jobs
                  .settled_future(pid)
                  .map(|settled| async move { (pid, settled.await) }.boxed_local())
              })
              .collect();
            if racers.is_empty() {
              None
            } else {
              let ((pid, outcome), _, _) =
                futures::executor::block_on(futures::future::select_all(racers));
              jobs.settle(pid, outcome);
              Some(pid)
            }
          }
        };
        Ok(lisp(pid.and_then(|pid| {
          jobs.forget_job(pid);
          jobs.view(pid)
        })))
      });
    }
    {
      let jobs = jobs.clone();
      let last = self.shell_compound.commands.last_pid.clone();
      self.register_native_special("std.jobs.spawn", move |args| {
        let argv: Vec<String> = match args.as_slice() {
          [LispValue::List(list)] => list.items.iter().map(lisp_word).collect(),
          args => args.iter().map(lisp_word).collect(),
        };
        if argv.is_empty() {
          return Err(native_error(
            "std.jobs.spawn: expected a program and its arguments".into(),
          ));
        }
        let host = jobs.host().ok_or_else(|| {
          native_error("std.jobs.spawn: this host runs no external programs".into())
        })?;
        let command = argv
          .iter()
          .map(|word| quote_word(word))
          .collect::<Vec<_>>()
          .join(" ");
        let plan = JobPlan {
          command: command.clone(),
          cwd: std::env::current_dir().ok(),
          interactive: false,
        };
        let slot = match host.admit(&plan) {
          Some(JobAdmission::Replayed {
            execution,
            pid,
            settled,
          }) => {
            jobs.submit(pid, Some(execution), command, settled, true);
            last.set(pid);
            return Ok(lisp(jobs.view(pid)));
          }
          Some(JobAdmission::Fresh(slot)) => Some(slot),
          None => None,
        };
        let mut io = ShellIo::default();
        if let Some(output) = slot.as_ref().and_then(|slot| slot.output()) {
          route_output(&mut io, &output)
            .map_err(|error| native_error(format!("std.jobs.spawn: {error}")))?;
        }
        let job = match host.start_background(argv, Some(io), false) {
          Ok(job) => job,
          Err(error) => {
            if let Some(slot) = slot {
              slot.failed(&error.to_string());
            }
            return Err(native_error(format!("std.jobs.spawn: {error}")));
          }
        };
        let pid = job.pid;
        let settled = settle(job, false);
        jobs.submit(
          pid,
          slot.as_ref().map(|slot| slot.execution()),
          command,
          settled.clone(),
          true,
        );
        if let Some(slot) = slot {
          slot.started(pid, settled);
        }
        last.set(pid);
        Ok(lisp(jobs.view(pid)))
      });
    }
    self.register_control_natives();
  }
}

#[cfg(test)]
mod tests;
