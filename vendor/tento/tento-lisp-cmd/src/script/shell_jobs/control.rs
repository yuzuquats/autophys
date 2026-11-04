//! Job control at the prompt: stopped and resumed jobs, `fg`, `bg`, and the
//! typed `std.jobs.foreground`, `std.jobs.resume` and `std.jobs.stop`.
//!
//! The reapers (`wait_child`) wait for a job with `WUNTRACED | WCONTINUED`, so
//! a stop or a continue is seen the moment it happens, wherever it came from
//! (Ctrl-Z, `kill -STOP`, `bg`). They record it in a process-wide table of live
//! children and tell the job's observer; the shell's jobs table folds that
//! record into the job's state when it is next polled. A reaper never resolves
//! a job's settlement on a stop: `wait` still means "until it exits".
//!
//! Job control belongs to interactive lines only (`shell_prompt`, or forced on
//! through `LispHost::set_job_control`): there `cmd &` starts the job in its own
//! process group, so a stop or a signal reaches the job and nothing else.
//! Scripts and `-c` keep the bash contract of monitor off: `fg` and `bg`
//! answer "no job control".

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use super::*;

/// What a reaper saw happen to a child besides its exit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcEvent {
  /// The child stopped, by this signal.
  Stopped(i32),
  /// A stopped child continued.
  Continued,
}

/// Told of each [`ProcEvent`] of one job, from its reaper's thread.
pub type ProcObserver = Arc<dyn Fn(u32, ProcEvent) + Send + Sync>;

#[derive(Default)]
struct Live {
  /// The signal of the stop the child is in, if it is stopped.
  stopped: Option<i32>,
  observer: Option<ProcObserver>,
  /// Events that came before an observer did.
  backlog: Vec<ProcEvent>,
  /// Woken on every change, for the shell awaiting a foreground job.
  notify: Arc<tokio::sync::Notify>,
}

static LIVE: LazyLock<Mutex<HashMap<u32, Live>>> = LazyLock::new(Mutex::default);

fn live<T>(work: impl FnOnce(&mut HashMap<u32, Live>) -> T) -> T {
  let mut live = LIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  work(&mut live)
}

/// The live table's lock, for a forking thread (see `shell_workers`).
pub(in crate::script) struct LiveLock(std::sync::MutexGuard<'static, HashMap<u32, Live>>);

impl LiveLock {
  pub(in crate::script) fn acquire() -> Self {
    Self(LIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
  }
}

/// A child stopped. Repeats of the same stop are one event.
pub(in crate::script) fn note_stopped(pid: u32, signal: i32) {
  record(pid, Some(signal));
}

/// A stopped child continued (or was told to).
pub(in crate::script) fn note_continued(pid: u32) {
  record(pid, None);
}

fn record(pid: u32, stopped: Option<i32>) {
  let (event, observer, notify) = live(|live| {
    let entry = live.entry(pid).or_default();
    if entry.stopped == stopped {
      return (None, None, entry.notify.clone());
    }
    entry.stopped = stopped;
    let event = match stopped {
      Some(signal) => ProcEvent::Stopped(signal),
      None => ProcEvent::Continued,
    };
    let observer = entry.observer.clone();
    if observer.is_none() {
      entry.backlog.push(event);
    }
    (Some(event), observer, entry.notify.clone())
  });
  if let (Some(event), Some(observer)) = (event, observer) {
    observer(pid, event);
  }
  notify.notify_waiters();
}

/// Tell `observer` of every stop and continue of `pid` from now on, and of
/// those that came before it was installed.
pub(in crate::script) fn observe(pid: u32, observer: ProcObserver) {
  let backlog = live(|live| {
    let entry = live.entry(pid).or_default();
    entry.observer = Some(observer.clone());
    std::mem::take(&mut entry.backlog)
  });
  for event in backlog {
    observer(pid, event);
  }
}

/// The signal of the stop `pid` is in, if it is stopped.
pub(in crate::script) fn stopped_signal(pid: u32) -> Option<i32> {
  live(|live| live.get(&pid).and_then(|entry| entry.stopped))
}

fn notifier(pid: u32) -> Arc<tokio::sync::Notify> {
  live(|live| live.entry(pid).or_default().notify.clone())
}

/// The child is gone: forget it, waking anyone waiting on it.
fn finish(pid: u32) {
  if let Some(entry) = live(|live| live.remove(&pid)) {
    entry.notify.notify_waiters();
  }
}

/// Wait for `pid` to exit and return its raw wait status, noting every stop
/// and continue on the way. The one reaper loop of every background job.
#[cfg(unix)]
pub(in crate::script) fn wait_child(pid: u32) -> std::io::Result<libc::c_int> {
  loop {
    let mut status = 0;
    // SAFETY: waitpid writes one c_int through the pointer it is given.
    let reaped = unsafe {
      libc::waitpid(
        pid as libc::pid_t,
        &mut status,
        libc::WUNTRACED | libc::WCONTINUED,
      )
    };
    if reaped < 0 {
      let error = std::io::Error::last_os_error();
      if error.kind() == std::io::ErrorKind::Interrupted {
        continue;
      }
      finish(pid);
      return Err(error);
    }
    if libc::WIFSTOPPED(status) {
      // macOS reports a continue as a stop by SIGCONT, which no stop is.
      if libc::WSTOPSIG(status) == libc::SIGCONT {
        note_continued(pid);
      } else {
        note_stopped(pid, libc::WSTOPSIG(status));
      }
      continue;
    }
    if libc::WIFCONTINUED(status) {
      note_continued(pid);
      continue;
    }
    finish(pid);
    return Ok(status);
  }
}

thread_local! {
  static NEW_GROUP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// While alive on this thread, the background process being started gets its
/// own process group. Held only around the synchronous start (never across an
/// await), so no other task of this thread can see it.
pub(in crate::script) struct GroupScope(bool);

impl GroupScope {
  pub(in crate::script) fn enter(on: bool) -> Self {
    Self(NEW_GROUP.with(|flag| flag.replace(on)))
  }
}

impl Drop for GroupScope {
  fn drop(&mut self) {
    NEW_GROUP.with(|flag| flag.set(self.0));
  }
}

/// Whether the process being started should lead a new process group.
pub(in crate::script) fn new_group_requested() -> bool {
  NEW_GROUP.with(std::cell::Cell::get)
}

/// Whether the program the embedder is starting right now belongs to a line
/// with job control (an interactive prompt): a session engine hosts it as a
/// stoppable job on its pty. Read synchronously inside
/// `ExternalCommands::run`; see [`GroupScope`].
pub fn job_control_requested() -> bool {
  new_group_requested()
}

/// An embedder's report that the job `pid` (which leads its own process
/// group) stopped by `signal`, for a job it watches itself (a hosted
/// terminal): the same record a reaper makes.
pub fn note_job_stopped(pid: u32, signal: i32) {
  note_stopped(pid, signal);
}

/// The embedder's job `pid` continued.
pub fn note_job_continued(pid: u32) {
  note_continued(pid);
}

/// The embedder's job `pid` is gone.
pub fn note_job_finished(pid: u32) {
  finish(pid);
}

/// Tell `observer` of each stop and continue of job `pid`, however it was
/// caused (the shell's `fg`/`bg` note their own continue).
pub fn observe_job(pid: u32, observer: ProcObserver) {
  observe(pid, observer);
}

/// A foreground program that stopped while an embedder ran it (a hosted
/// terminal's Ctrl-Z): the shell makes it a numbered, stopped job.
pub struct StoppedJob {
  /// The program's pid; it leads its process group.
  pub pid: u32,
  pub command: String,
  /// The embedder's execution id, when it records one.
  pub execution: Option<String>,
  /// Resolves when the program finally exits.
  pub settled: JobOutcomeFuture,
  pub signal: i32,
}

thread_local! {
  static ADOPTED: std::cell::RefCell<Vec<StoppedJob>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Hand the shell running on this thread a foreground program that stopped
/// (see [`StoppedJob`]); it is adopted when the command returns.
pub fn adopt_stopped_job(job: StoppedJob) {
  ADOPTED.with(|adopted| adopted.borrow_mut().push(job));
}

/// Signal a job's process group, or its process when it leads none.
#[cfg(unix)]
fn signal_job(pid: u32, pgid: Option<u32>, signal: i32) -> std::io::Result<()> {
  let target = match pgid {
    Some(pgid) => -i64::from(pgid),
    None => i64::from(pid),
  };
  send_signal(target, signal)
}

impl JobTable {
  fn command_of(&self, pid: u32) -> Option<String> {
    self
      .0
      .borrow()
      .processes
      .iter()
      .find(|process| process.pid == pid)
      .map(|process| process.command.clone())
  }

  fn pgid_of(&self, pid: u32) -> Option<u32> {
    self
      .0
      .borrow()
      .processes
      .iter()
      .find(|process| process.pid == pid)
      .and_then(|process| process.pgid)
  }

  /// The pid or negated group a signal for the job goes to.
  pub(in crate::script) fn signal_target(&self, pid: u32) -> i64 {
    match self.pgid_of(pid) {
      Some(pgid) => -i64::from(pgid),
      None => i64::from(pid),
    }
  }

  pub(in crate::script) fn set_group(&self, pid: u32, pgid: Option<u32>) {
    if let Some(process) = self
      .0
      .borrow_mut()
      .processes
      .iter_mut()
      .find(|process| process.pid == pid)
    {
      process.pgid = pgid;
    }
  }

  fn set_foreground(&self, pid: u32, foreground: bool) {
    if let Some(process) = self
      .0
      .borrow_mut()
      .processes
      .iter_mut()
      .find(|process| process.pid == pid)
    {
      process.foreground = foreground;
    }
  }

  fn set_noticed(&self, pid: u32, kind: NoticeKind) {
    if let Some(process) = self
      .0
      .borrow_mut()
      .processes
      .iter_mut()
      .find(|process| process.pid == pid)
    {
      process.notified = Some(kind);
    }
  }

  pub(in crate::script) fn is_stopped(&self, pid: u32) -> bool {
    self
      .0
      .borrow()
      .processes
      .iter()
      .any(|process| process.pid == pid && process.state == ExecState::Stopped)
  }

  /// Whether `pid` is stopped as bash tells it: only a job started under job
  /// control is ever reported stopped (monitor off, bash's `jobs` says Running).
  pub(in crate::script) fn is_held(&self, pid: u32) -> bool {
    self.0.borrow().processes.iter().any(|process| {
      process.pid == pid && process.state == ExecState::Stopped && process.pgid.is_some()
    })
  }

  pub(in crate::script) fn monitor(&self) -> bool {
    self.0.borrow().monitor
  }

  pub(in crate::script) fn set_monitor(&self, on: bool) {
    self.0.borrow_mut().monitor = on;
  }

  /// bash's notices before a prompt: each job that finished, or stopped, since
  /// it was last told of, in bash's `jobs` text. A finished job leaves the
  /// table once it is told of.
  pub(in crate::script) fn take_notices(&self) -> Vec<String> {
    self.poll();
    let due: Vec<(u32, NoticeKind)> = self
      .0
      .borrow()
      .processes
      .iter()
      .filter(|process| process.number.is_some())
      .filter_map(|process| {
        let kind = if process.outcome.is_some() {
          NoticeKind::Finished
        } else if process.state == ExecState::Stopped && process.pgid.is_some() {
          NoticeKind::Stopped
        } else {
          return None;
        };
        (process.notified != Some(kind)).then_some((process.pid, kind))
      })
      .collect();
    let mut lines = Vec::new();
    for (pid, kind) in due {
      lines.extend(self.bash_line(pid, false));
      self.set_noticed(pid, kind);
      if kind == NoticeKind::Finished {
        self.forget_job(pid);
      }
    }
    lines
  }

  /// Continue a job: SIGCONT to its group. A group that is already gone, or
  /// that is all zombies on its way out (macOS answers EPERM to a signal for
  /// those), has nothing to continue and is not an error.
  #[cfg(unix)]
  fn resume(&self, pid: u32) -> std::io::Result<()> {
    match signal_job(pid, self.pgid_of(pid), libc::SIGCONT) {
      Err(error) if matches!(error.raw_os_error(), Some(libc::ESRCH | libc::EPERM)) => {}
      other => other?,
    }
    if self.is_stopped(pid) {
      note_continued(pid);
    }
    Ok(())
  }
}

/// Signals a job to stop and makes the shell its foreground: SIGINT to the
/// job's group if the wait for it is cancelled (the viewer's Ctrl-C).
struct ForegroundGuard {
  jobs: JobTable,
  pid: u32,
  armed: bool,
}

impl Drop for ForegroundGuard {
  fn drop(&mut self) {
    self.jobs.set_foreground(self.pid, false);
    #[cfg(unix)]
    if self.armed && !self.jobs.finished(self.pid) {
      let _ = send_signal(self.jobs.signal_target(self.pid), libc::SIGINT);
    }
  }
}

/// How the shell's wait on a foreground job ended.
enum Foreground {
  Finished,
  Stopped(i32),
}

/// Wait until `pid` exits or stops; a `stop` request (Ctrl-Z) stops it.
async fn await_exit_or_stop(
  jobs: &JobTable,
  pid: u32,
  mut stop: Option<LocalBoxFuture<'static, ()>>,
) -> Foreground {
  let Some(settled) = jobs.settled_future(pid) else {
    return Foreground::Finished;
  };
  let notify = notifier(pid);
  let mut settled = settled.fuse();
  loop {
    // Subscribe before reading the state, so a change in between wakes us.
    let changed = notify.notified();
    tokio::pin!(changed);
    changed.as_mut().enable();
    jobs.poll();
    if jobs.finished(pid) {
      return Foreground::Finished;
    }
    if let Some(signal) = stopped_signal(pid) {
      return Foreground::Stopped(signal);
    }
    let requested = async {
      match stop.as_mut() {
        Some(request) => request.await,
        None => std::future::pending::<()>().await,
      }
    };
    tokio::select! {
      _ = &mut settled => {}
      _ = &mut changed => {}
      _ = requested => {
        stop = None;
        #[cfg(unix)]
        let _ = signal_job(pid, jobs.pgid_of(pid), libc::SIGTSTP);
      }
    }
  }
}

impl LispHost {
  /// Force job control on (`set -m`, tests) for every line of this host; an
  /// interactive prompt line has it on without this.
  pub fn set_job_control(&mut self, on: bool) {
    self.shell_compound.commands.jobs.set_monitor(on);
  }

  /// Whether the running line has job control: an interactive prompt, or
  /// forced on through [`Self::set_job_control`].
  pub(in crate::script) fn job_control(&self) -> bool {
    self.shell_prompt || self.shell_compound.commands.jobs.monitor()
  }

  /// bash's notices before the next prompt, in its `jobs` text: `[1]+  Done
  /// …`, `[2]-  Stopped …`. Each is returned once; a finished job leaves the
  /// table with its notice. A session shows these as live rows instead.
  pub fn job_notices(&mut self) -> Vec<String> {
    self.shell_compound.commands.jobs.take_notices()
  }

  /// How many jobs in the table are stopped (what bash's `exit` checks).
  pub fn stopped_jobs(&mut self) -> usize {
    let jobs = self.shell_compound.commands.jobs.clone();
    jobs.poll();
    jobs
      .job_pids()
      .into_iter()
      .filter(|pid| jobs.is_held(*pid))
      .count()
  }

  /// Leaving the shell with stopped jobs: each is sent SIGTERM and then
  /// SIGCONT, so it ends instead of staying stopped forever with nobody to
  /// continue it (bash's `terminate_stopped_jobs`).
  pub fn terminate_stopped_jobs(&mut self) {
    let jobs = self.shell_compound.commands.jobs.clone();
    jobs.poll();
    #[cfg(unix)]
    for pid in jobs.job_pids() {
      if jobs.is_held(pid) {
        let target = jobs.signal_target(pid);
        let _ = send_signal(target, libc::SIGTERM);
        let _ = send_signal(target, libc::SIGCONT);
      }
    }
  }

  /// The job a `fg`/`bg` operand names (the current job without one), as bash
  /// names it, reporting bash's diagnostics.
  fn job_operand(&mut self, line: usize, builtin: &str, operand: Option<&String>) -> Option<u32> {
    let jobs = self.shell_compound.commands.jobs.clone();
    let Some(operand) = operand else {
      return match jobs.current(false) {
        Some(pid) => Some(pid),
        None => {
          self.job_diagnostic(line, builtin, "current: no such job");
          None
        }
      };
    };
    if operand.starts_with('%') {
      return self.resolve_job_spec(line, builtin, operand);
    }
    self.job_diagnostic(
      line,
      builtin,
      &format!("warning: {operand}: job specification requires leading `%'"),
    );
    match jobs.resolve(&format!("%{operand}")) {
      Ok(pid) => Some(pid),
      Err(NoSuchJob(messages)) => {
        for message in messages {
          let message = message.replacen(&format!("%{operand}"), operand, 1);
          self.job_diagnostic(line, builtin, &message);
        }
        None
      }
    }
  }

  /// bash `fg [%JOB]`: continue the job if it is stopped, show its command,
  /// and wait for it. Ctrl-Z (the embedder's stop request) stops it again and
  /// returns the prompt.
  pub(in crate::script) async fn fg_builtin(
    &mut self,
    args: &[String],
    line: usize,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    if !self.job_control() {
      self.job_diagnostic(line, "fg", "no job control");
      self.set_shell_status(1);
      return Ok(None);
    }
    self.shell_compound.commands.jobs.poll();
    let Some(pid) = self.job_operand(line, "fg", args.first()) else {
      self.set_shell_status(1);
      return Ok(None);
    };
    self.foreground_job(pid, line, "fg", &output).await?;
    Ok(None)
  }

  /// Bring `pid` to the foreground and wait for it; sets the shell status.
  async fn foreground_job(
    &mut self,
    pid: u32,
    line: usize,
    builtin: &str,
    output: &FlowOutput,
  ) -> Result<()> {
    let jobs = self.shell_compound.commands.jobs.clone();
    jobs.poll();
    if jobs.finished(pid) {
      self.job_diagnostic(line, builtin, "job has terminated");
      self.set_shell_status(1);
      return Ok(());
    }
    let command = jobs.command_of(pid).unwrap_or_default();
    output.write_bytes(self, format!("{command}\n").as_bytes());
    let _ = super::super::flush_shell_output();
    // The job's output follows the shell here for as long as it is in front
    // (attached before it continues, so nothing it prints is missed).
    let attached = jobs.host().and_then(|host| host.attach_foreground(pid));
    // At a terminal the shell owns, the job gets the terminal, and the modes
    // it had when it stopped, before it continues (bash's `fg`).
    let terminal = super::terminal::owned();
    if terminal {
      super::terminal::give_to(jobs.pgid_of(pid).unwrap_or(pid));
      super::terminal::restore_job_modes(pid);
    }
    #[cfg(unix)]
    if let Err(error) = jobs.resume(pid) {
      if terminal {
        super::terminal::reclaim(pid, false);
      }
      self.job_diagnostic(line, builtin, &error.to_string());
      self.set_shell_status(1);
      return Ok(());
    }
    jobs.set_foreground(pid, true);
    let mut guard = ForegroundGuard {
      jobs: jobs.clone(),
      pid,
      armed: true,
    };
    let ended = self.await_foreground(pid).await;
    guard.armed = false;
    drop(guard);
    drop(attached);
    if terminal {
      super::terminal::reclaim(pid, matches!(ended, Foreground::Stopped(_)));
    }
    match ended {
      Foreground::Finished => {
        super::terminal::forget_job(pid);
        let outcome = self.wait_job(pid, output).await?;
        match outcome {
          Ok(outcome) => {
            if let Some(signal) = outcome.signal {
              // bash tells of a job a signal ended, except the keyboard's own.
              #[cfg(unix)]
              if signal != libc::SIGINT && signal != libc::SIGPIPE {
                self.report_shell_diagnostic(signal_description(signal));
              }
              #[cfg(not(unix))]
              let _ = signal;
            }
            self.set_shell_status(outcome.status);
          }
          Err(_) => self.set_shell_status(127),
        }
      }
      Foreground::Stopped(signal) => {
        self.report_stopped_job(pid, signal);
        self.set_shell_status(128 + signal);
      }
    }
    Ok(())
  }

  /// bash's notice for a foreground job that just stopped: a fresh line
  /// after the terminal's `^Z`, then `[1]+  Stopped  vim`. Told once.
  fn report_stopped_job(&mut self, pid: u32, signal: i32) {
    let jobs = self.shell_compound.commands.jobs.clone();
    jobs.poll();
    jobs.0.borrow_mut().stopped_current(pid);
    jobs.set_noticed(pid, NoticeKind::Stopped);
    if let Some(notice) = jobs.bash_line(pid, false) {
      #[cfg(unix)]
      let keyboard = signal == libc::SIGTSTP && super::terminal::owned();
      #[cfg(not(unix))]
      let keyboard = false;
      let _ = signal;
      self.report_shell_diagnostic(if keyboard { format!("\n{notice}") } else { notice });
    }
  }

  /// Adopt the stopped programs an embedder handed over while the last
  /// command ran ([`adopt_stopped_job`]): each becomes a numbered, stopped
  /// job, told once (`[1]+  Stopped  vim`). A replayed hand-over of a job
  /// already in the table changes nothing.
  pub(in crate::script) fn adopt_stopped_jobs(&mut self) {
    let adopted = ADOPTED.with(|adopted| std::mem::take(&mut *adopted.borrow_mut()));
    for job in adopted {
      let jobs = self.shell_compound.commands.jobs.clone();
      if jobs.knows(job.pid) {
        continue;
      }
      jobs.submit(job.pid, job.execution, job.command, job.settled, false);
      jobs.set_group(job.pid, Some(job.pid));
      jobs.number_job(job.pid);
      self.report_stopped_job(job.pid, job.signal);
      self.set_shell_status(128 + job.signal);
    }
  }

  /// Run one external program from a command line. At the terminal an
  /// interactive shell owns it is a foreground job ([`Self::run_foreground_job`]);
  /// elsewhere the embedder runs it, told whether the line has job control
  /// (a session hosts a prompt's program as a stoppable job), and any
  /// program that stopped meanwhile is adopted as a job.
  pub(in crate::script) async fn run_external_argv(
    &mut self,
    external: Rc<dyn ExternalCommands>,
    argv: Vec<String>,
  ) -> crate::Result<JsonValue> {
    if self.job_control() && super::terminal::owned() {
      let command = pipeline_text(std::slice::from_ref(&argv));
      if let Some(started) = external.start_foreground(vec![argv.clone()], vec![None]) {
        let captured = self.run_foreground_job(started?, command).await?;
        if let Some((status, detail)) = captured.start_errors.first() {
          return Err(crate::Error::ProcessStart {
            status: *status,
            detail: detail.clone(),
          });
        }
        if captured.status == 0 {
          return Ok(json!({
            "datatype": "process.result/v1",
            "argv": argv,
            "status": 0,
            "signal": JsonValue::Null,
            "ok": true,
          }));
        }
        let head = argv.first().cloned().unwrap_or_default();
        return Err(crate::Error::ProcessExit {
          status: Some(captured.status),
          signal: None,
          detail: format!("{head} exited {}", captured.status),
        });
      }
    }
    let run = {
      let _group = GroupScope::enter(self.job_control());
      external.run(argv)
    };
    let result = run.await;
    self.adopt_stopped_jobs();
    result
  }

  /// A foreground pipeline the interactive shell started at its terminal
  /// ([`super::start_process_foreground`]): wait for it with the terminal
  /// in its hands, then take the terminal back. A job that stops (Ctrl-Z,
  /// a program suspending itself) becomes a numbered, stopped job, as bash's
  /// does: `[1]+  Stopped  vim`, status 128 + the signal, and `fg` gives it
  /// the terminal again.
  pub(in crate::script) async fn run_foreground_job(
    &mut self,
    job: super::super::ShellJob,
    command: String,
  ) -> crate::Result<super::super::ShellCapture> {
    let pid = job.pid;
    if pid == 0 {
      // No stage started: only start errors to report.
      return job.completion.await;
    }
    let capture = job
      .completion
      .map(|result| result.map(Rc::new).map_err(|error| error.to_string()))
      .boxed_local()
      .shared();
    let settled: JobOutcomeFuture = capture
      .clone()
      .map(move |result| {
        result.map(|captured| JobOutcome {
          status: captured.status,
          signal: take_termination(pid).filter(|signal| captured.status == 128 + signal),
          statuses: captured.statuses.clone(),
          stdout: Rc::default(),
        })
      })
      .boxed_local()
      .shared();
    let jobs = self.shell_compound.commands.jobs.clone();
    jobs.submit(pid, None, command, settled, false);
    jobs.set_group(pid, Some(pid));
    jobs.set_foreground(pid, true);
    let ended = await_exit_or_stop(&jobs, pid, None).await;
    jobs.set_foreground(pid, false);
    match ended {
      Foreground::Finished => {
        super::terminal::reclaim(pid, false);
        super::terminal::forget_job(pid);
        let outcome = jobs.reap(pid).await;
        #[cfg(unix)]
        if let Ok(JobOutcome {
          signal: Some(signal),
          ..
        }) = &outcome
        {
          // bash tells of a foreground job a signal ended, except the
          // keyboard's interrupt and a broken pipe.
          if *signal != libc::SIGINT && *signal != libc::SIGPIPE {
            self.report_shell_diagnostic(signal_description(*signal));
          }
        }
        let _ = outcome;
        capture
          .await
          .map(|captured| super::super::ShellCapture {
            stdout: captured.stdout.clone(),
            status: captured.status,
            statuses: captured.statuses.clone(),
            start_errors: captured.start_errors.clone(),
          })
          .map_err(|error| crate::Error::Other(anyhow::anyhow!(error)))
      }
      Foreground::Stopped(signal) => {
        super::terminal::reclaim(pid, true);
        jobs.number_job(pid);
        self.report_stopped_job(pid, signal);
        Ok(super::super::ShellCapture {
          stdout: Vec::new(),
          status: 128 + signal,
          statuses: vec![128 + signal],
          start_errors: Vec::new(),
        })
      }
    }
  }

  /// Wait until the job exits, or stops (by itself or because the embedder
  /// asked it to).
  async fn await_foreground(&mut self, pid: u32) -> Foreground {
    let jobs = self.shell_compound.commands.jobs.clone();
    let stop = jobs.host().and_then(|host| host.foreground_stop());
    await_exit_or_stop(&jobs, pid, stop).await
  }

  /// bash `bg [%JOB ...]`: continue stopped jobs in the background.
  pub(in crate::script) fn bg_builtin(
    &mut self,
    args: &[String],
    line: usize,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    if !self.job_control() {
      self.job_diagnostic(line, "bg", "no job control");
      self.set_shell_status(1);
      return Ok(None);
    }
    let jobs = self.shell_compound.commands.jobs.clone();
    jobs.poll();
    let operands: Vec<Option<&String>> = if args.is_empty() {
      vec![None]
    } else {
      args.iter().map(Some).collect()
    };
    let mut status = 0;
    for operand in operands {
      let Some(pid) = self.job_operand(line, "bg", operand) else {
        status = 1;
        continue;
      };
      let number = jobs.0.borrow().number_of(pid).unwrap_or_default();
      if jobs.finished(pid) {
        self.job_diagnostic(line, "bg", "job has terminated");
        status = 1;
        continue;
      }
      if !jobs.is_stopped(pid) {
        self.job_diagnostic(line, "bg", &format!("job {number} already in background"));
        continue;
      }
      #[cfg(unix)]
      if let Err(error) = jobs.resume(pid) {
        self.job_diagnostic(line, "bg", &error.to_string());
        status = 1;
        continue;
      }
      let mark = match jobs.mark(pid) {
        Mark::Current => '+',
        Mark::Previous => '-',
        Mark::Other => ' ',
      };
      let command = jobs.command_of(pid).unwrap_or_default();
      output.write_bytes(self, format!("[{number}]{mark} {command} &\n").as_bytes());
    }
    self.set_shell_status(status);
    Ok(None)
  }

  /// `(std.jobs.foreground JOB)`, as a shell line: the typed `fg`. It returns
  /// the job's value once the job exits or stops.
  pub(in crate::script) async fn foreground_line(
    &mut self,
    args: &[String],
    line: usize,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    let jobs = self.shell_compound.commands.jobs.clone();
    if !self.job_control() {
      return Err(command_error(
        "std.jobs.foreground: no job control here".into(),
      ));
    }
    let [reference] = args else {
      return Err(command_error(
        "std.jobs.foreground: expected one job".into(),
      ));
    };
    let pid = jobs
      .find(&JsonValue::String(reference.clone()))
      .map_err(|error| command_error(format!("std.jobs.foreground: {error}")))?;
    self
      .foreground_job(pid, line, "std.jobs.foreground", &output)
      .await?;
    Ok(Some(jobs.view(pid).unwrap_or(JsonValue::Null)))
  }

  /// `std.jobs.resume` and `std.jobs.stop`: SIGCONT and SIGTSTP (or another
  /// signal) to a job, by value, execution id or pid.
  #[cfg(unix)]
  pub(in crate::script) fn register_control_natives(&mut self) {
    let jobs = self.shell_compound.commands.jobs.clone();
    let lisp = |value: Option<JsonValue>| {
      super::super::interp::value_from_json(&value.unwrap_or(JsonValue::Null))
    };
    {
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.resume", move |args| {
        let [job] = args.as_slice() else {
          return Err(native_error("std.jobs.resume: expected one job".into()));
        };
        let pid = jobs
          .find(&super::super::interp::value_to_json(job))
          .map_err(|error| native_error(format!("std.jobs.resume: {error}")))?;
        jobs.poll();
        if !jobs.finished(pid) {
          jobs
            .resume(pid)
            .map_err(|error| native_error(format!("std.jobs.resume: ({pid}) - {error}")))?;
          jobs.poll();
        }
        Ok(lisp(jobs.view(pid)))
      });
    }
    {
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.stop", move |args| {
        let (job, signal) = match args.as_slice() {
          [job] => (job, libc::SIGTSTP),
          [job, LispValue::String(signal)] => (
            job,
            signal_number(signal).ok_or_else(|| {
              native_error(format!(
                "std.jobs.stop: {signal}: invalid signal specification"
              ))
            })?,
          ),
          _ => {
            return Err(native_error(
              "std.jobs.stop: expected (std.jobs.stop JOB [SIGNAL])".into(),
            ));
          }
        };
        let pid = jobs
          .find(&super::super::interp::value_to_json(job))
          .map_err(|error| native_error(format!("std.jobs.stop: {error}")))?;
        jobs.poll();
        if !jobs.finished(pid) {
          send_signal(jobs.signal_target(pid), signal)
            .map_err(|error| native_error(format!("std.jobs.stop: ({pid}) - {error}")))?;
          // The reaper reports the stop a moment later; a caller that reads
          // the job straight away should see it stopped.
          if signal == libc::SIGTSTP || signal == libc::SIGSTOP {
            for _ in 0..200 {
              if stopped_signal(pid).is_some() || jobs.finished(pid) {
                break;
              }
              std::thread::sleep(std::time::Duration::from_millis(5));
            }
          }
          jobs.poll();
        }
        Ok(lisp(jobs.view(pid)))
      });
    }
    {
      // The Lisp door blocks until the job exits or stops; the shell line
      // (`std.jobs.foreground JOB`) awaits instead, and Ctrl-Z reaches it.
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.foreground", move |args| {
        let [job] = args.as_slice() else {
          return Err(native_error("std.jobs.foreground: expected one job".into()));
        };
        let pid = jobs
          .find(&super::super::interp::value_to_json(job))
          .map_err(|error| native_error(format!("std.jobs.foreground: {error}")))?;
        jobs.poll();
        if !jobs.finished(pid) {
          jobs
            .resume(pid)
            .map_err(|error| native_error(format!("std.jobs.foreground: ({pid}) - {error}")))?;
          jobs.set_foreground(pid, true);
          let ended = futures::executor::block_on(await_exit_or_stop(&jobs, pid, None));
          jobs.set_foreground(pid, false);
          if matches!(ended, Foreground::Finished) {
            let _ = jobs.reap_blocking(pid);
            jobs.forget_job(pid);
          }
        }
        Ok(lisp(jobs.view(pid)))
      });
    }
    {
      let jobs = jobs.clone();
      self.register_native_special("std.jobs.notices", move |args| {
        if !args.is_empty() {
          return Err(native_error(
            "std.jobs.notices: expected no arguments".into(),
          ));
        }
        Ok(lisp(Some(JsonValue::Array(
          jobs
            .take_notices()
            .into_iter()
            .map(JsonValue::String)
            .collect(),
        ))))
      });
    }
  }

  #[cfg(not(unix))]
  pub(in crate::script) fn register_control_natives(&mut self) {}
}
