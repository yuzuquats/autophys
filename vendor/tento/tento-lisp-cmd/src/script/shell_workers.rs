//! Unix children for compiled shell plans. Pipes remain descriptors, never files.
use super::bash_flow::{FlowOutput, eval_flow};
use super::interp::{LispHost, LispHostError, Sym};
use super::runner::TshScriptErrorKind;
use super::{FdTarget, ShellCapture, ShellIo, ShellJob};
use tento_lisp::Value as LispValue;

#[cfg(unix)]
pub(super) fn pipe() -> std::io::Result<(std::fs::File, std::fs::File)> {
  use std::os::fd::FromRawFd;
  let mut descriptors = [-1; 2];
  if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
    return Err(std::io::Error::last_os_error());
  }
  for fd in descriptors {
    unsafe {
      libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
    }
  }
  Ok(unsafe {
    (
      std::fs::File::from_raw_fd(descriptors[0]),
      std::fs::File::from_raw_fd(descriptors[1]),
    )
  })
}

/// True in a process made by `fork_shell_plan`. The fork copied only the
/// forking thread, so a lock another parent thread held at that instant is
/// held in the child forever. std's thread start and exit take such a lock
/// (the stack-overflow guard registry, the thread registry), so a child never
/// starts a std or Tokio blocking-pool thread: it uses [`spawn_thread`], which
/// is a bare pthread there.
#[cfg(unix)]
static FORKED_CHILD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(unix)]
pub(super) fn in_forked_child() -> bool {
  FORKED_CHILD.load(std::sync::atomic::Ordering::Relaxed)
}

/// Start `work` on a bare pthread with `stack` bytes of stack; `detached`
/// threads are never joined. `false`: the thread could not be created.
#[cfg(unix)]
fn start_bare_thread(
  work: Box<dyn FnOnce() + Send + 'static>,
  stack: usize,
  detached: bool,
) -> Option<libc::pthread_t> {
  extern "C" fn start(work: *mut libc::c_void) -> *mut libc::c_void {
    // SAFETY: `work` is the box leaked below, reclaimed exactly once here.
    let work = unsafe { Box::from_raw(work.cast::<Box<dyn FnOnce() + Send>>()) };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work));
    std::ptr::null_mut()
  }
  let work = Box::into_raw(Box::new(work)).cast::<libc::c_void>();
  // SAFETY: pthread initializes the attribute and the thread handle before
  // they are read, and `start` takes ownership of `work`.
  unsafe {
    let mut attributes = std::mem::MaybeUninit::<libc::pthread_attr_t>::uninit();
    if libc::pthread_attr_init(attributes.as_mut_ptr()) != 0 {
      drop(Box::from_raw(work.cast::<Box<dyn FnOnce() + Send>>()));
      return None;
    }
    libc::pthread_attr_setstacksize(attributes.as_mut_ptr(), stack);
    if detached {
      libc::pthread_attr_setdetachstate(attributes.as_mut_ptr(), libc::PTHREAD_CREATE_DETACHED);
    }
    let mut thread = std::mem::MaybeUninit::<libc::pthread_t>::uninit();
    let created = libc::pthread_create(thread.as_mut_ptr(), attributes.as_ptr(), start, work);
    libc::pthread_attr_destroy(attributes.as_mut_ptr());
    if created != 0 {
      drop(Box::from_raw(work.cast::<Box<dyn FnOnce() + Send>>()));
      return None;
    }
    Some(thread.assume_init())
  }
}

/// Run `work` on a new bare pthread and wait for it: a forked child's way to
/// get a thread without std's thread start (see `fork_shell_plan`). The stack
/// is generous, as the evaluator recurses.
#[cfg(unix)]
fn run_on_fresh_thread(work: impl FnOnce() + Send + 'static) {
  // A panic in the child's evaluator ends the child.
  let work = move || {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).is_err() {
      unsafe { libc::_exit(1) };
    }
  };
  match start_bare_thread(Box::new(work), 16 * 1024 * 1024, false) {
    // SAFETY: the thread was created joinable and is joined once.
    Some(thread) => unsafe {
      libc::pthread_join(thread, std::ptr::null_mut());
    },
    None => unsafe { libc::_exit(1) },
  }
}

/// A helper thread whose start is safe in a forked child: a std thread
/// anywhere else, a bare pthread in the child.
pub(super) struct WorkerThread<T> {
  kind: WorkerKind<T>,
}

enum WorkerKind<T> {
  Failed,
  Std(std::thread::JoinHandle<T>),
  #[cfg(unix)]
  Bare(libc::pthread_t, std::sync::Arc<std::sync::Mutex<Option<T>>>),
}

// SAFETY: pthread_t is an opaque join handle, never dereferenced by this
// wrapper. pthread_join may run on a different thread, and consuming join()
// joins the owned handle once. The result slot and std JoinHandle are Send
// when T is Send. musl represents pthread_t as a pointer rather than an integer.
#[cfg(unix)]
unsafe impl<T: Send> Send for WorkerThread<T> {}

impl<T: Send + 'static> WorkerThread<T> {
  /// Wait for the thread. `Err`: the thread panicked or never started.
  pub(super) fn join(self) -> Result<T, ()> {
    match self.kind {
      WorkerKind::Failed => Err(()),
      WorkerKind::Std(handle) => handle.join().map_err(|_| ()),
      #[cfg(unix)]
      WorkerKind::Bare(thread, slot) => {
        // SAFETY: the thread was created joinable and is joined once.
        unsafe { libc::pthread_join(thread, std::ptr::null_mut()) };
        let value = slot.lock().ok().and_then(|mut slot| slot.take());
        value.ok_or(())
      }
    }
  }
}

/// Start a joinable helper thread (see [`WorkerThread`]).
pub(super) fn spawn_thread<T: Send + 'static>(
  work: impl FnOnce() -> T + Send + 'static,
) -> WorkerThread<T> {
  #[cfg(unix)]
  if in_forked_child() {
    let slot = std::sync::Arc::new(std::sync::Mutex::new(None));
    let result = slot.clone();
    let started = start_bare_thread(
      Box::new(move || {
        let value = work();
        if let Ok(mut slot) = result.lock() {
          *slot = Some(value);
        }
      }),
      2 * 1024 * 1024,
      false,
    );
    if let Some(thread) = started {
      return WorkerThread {
        kind: WorkerKind::Bare(thread, slot),
      };
    }
    // The thread could not start; the join reports it.
    return WorkerThread {
      kind: WorkerKind::Failed,
    };
  }
  WorkerThread {
    kind: WorkerKind::Std(std::thread::spawn(work)),
  }
}

/// Start a thread nothing joins, as a bare pthread: for a forked child.
#[cfg(unix)]
pub(super) fn spawn_detached_bare(work: impl FnOnce() + Send + 'static) {
  // A failed start abandons the work; whoever waits for it sees its channel
  // close.
  let _ = start_bare_thread(Box::new(work), 2 * 1024 * 1024, true);
}

/// The process-wide locks a forked shell's child takes: std's stdout and
/// stderr (every flush and every inherited write), and the job registries.
/// The fork copies only the forking thread, so a lock another thread held at
/// that instant stays held in the child forever. The forking thread therefore
/// holds them across `fork` and lets go in both processes, which leaves every
/// one free in the child and no write half-done in either.
///
/// The owned-I/O gate's leaf mutex comes last: while it is held no owned
/// payload can be created, and the fork is refused if one is live. The child
/// starts a new gate epoch before letting it go.
#[cfg(unix)]
struct ForkLocks<'a> {
  // Declared first, so it is released first.
  gate: tento_lisp::owned_io_gate::ForkPermit<'a>,
  _stdout: std::io::StdoutLock<'static>,
  _stderr: std::io::StderrLock<'static>,
  _jobs: super::shell_jobs::JobLocks,
}

#[cfg(unix)]
impl<'a> ForkLocks<'a> {
  fn acquire(
    permission: &'a tento_lisp::owned_io_gate::ForkReservation,
  ) -> Result<Self, tento_lisp::owned_io_gate::GateError> {
    let stdout = std::io::stdout().lock();
    let stderr = std::io::stderr().lock();
    let jobs = super::shell_jobs::JobLocks::acquire();
    let gate = permission.lock_for_fork()?;
    Ok(Self {
      gate,
      _stdout: stdout,
      _stderr: stderr,
      _jobs: jobs,
    })
  }

  /// In the child, before the locks are let go: authority copied from the
  /// parent counts for nothing in the child's new gate epoch.
  fn reset_gate_in_child(&mut self) {
    // SAFETY: called only in the child of the fork made while holding it.
    unsafe { self.gate.reset_after_fork_in_child() };
  }
}

impl LispHost {
  /// Run `stage` in a forked shell. A `background` child is an asynchronous
  /// command without job control: SIGINT and SIGQUIT are ignored, and an
  /// inherited stdin reads `/dev/null`. `permission` (`fork_permission`) is
  /// held across the fork, so no owned I/O is live in this process then.
  #[cfg(unix)]
  pub(super) fn fork_shell_plan(
    &mut self,
    stage: &LispValue<Sym>,
    line: usize,
    mut io: ShellIo,
    capture: bool,
    background: bool,
    permission: &tento_lisp::owned_io_gate::ForkReservation,
  ) -> Result<ShellJob, LispHostError> {
    use std::os::fd::AsRawFd;
    use std::sync::Arc;
    let capture = capture && matches!(io.target(1), FdTarget::Inherit(1));
    let (mut reader, mut writer) = if capture {
      let (reader, writer) = pipe().map_err(|e| LispHostError::Command(e.to_string()))?;
      (Some(reader), Some(writer))
    } else {
      (None, None)
    };
    let environment = super::shell_redirect::environment_map(&io.1).fork();
    let new_group = background && super::shell_jobs::control::new_group_requested();
    let _ = super::flush_shell_output();
    let mut locks =
      ForkLocks::acquire(permission).map_err(|error| LispHostError::Command(error.to_string()))?;
    let pid = unsafe { libc::fork() };
    if pid == 0 {
      locks.reset_gate_in_child();
    }
    // Free in the parent, and free in the child before its first use of them.
    drop(locks);
    if pid < 0 {
      return Err(LispHostError::Command(
        std::io::Error::last_os_error().to_string(),
      ));
    }
    if pid == 0 {
      FORKED_CHILD.store(true, std::sync::atomic::Ordering::Relaxed);
      if new_group {
        // A job of an interactive shell leads its own process group, so a
        // stop or a signal for the job reaches it and nothing else.
        unsafe { libc::setpgid(0, 0) };
      }
      drop(reader.take());
      if let Some(writer) = writer.take() {
        io.0.insert(1, FdTarget::File(Arc::new(writer)));
      }
      // Release the other substitutions' pipe ends without invalidating File
      // owners retained by the inherited host and flow restore guards.
      let null = match std::fs::File::open("/dev/null") {
        Ok(file) => file,
        Err(_) => unsafe { libc::_exit(1) },
      };
      for fd in self.shell_compound.commands.process_fds.borrow().iter() {
        if !io
          .0
          .values()
          .any(|target| matches!(target, FdTarget::File(file) if file.as_raw_fd() == *fd))
        {
          unsafe {
            if libc::dup2(null.as_raw_fd(), *fd) < 0
              || libc::fcntl(*fd, libc::F_SETFD, libc::FD_CLOEXEC) < 0
            {
              libc::_exit(1);
            }
          }
        }
      }
      if background {
        // SAFETY: the forked child is single-threaded here; signal(2) and
        // dup2(2) are async-signal-safe. A job under job control keeps the
        // keyboard's signals (its group is signalled while in the foreground).
        let disposition = if new_group {
          libc::SIG_DFL
        } else {
          libc::SIG_IGN
        };
        unsafe {
          libc::signal(libc::SIGINT, disposition);
          libc::signal(libc::SIGQUIT, disposition);
          if new_group {
            libc::signal(libc::SIGTSTP, libc::SIG_DFL);
          }
        }
        if matches!(io.target(0), FdTarget::Inherit(0)) {
          if unsafe { libc::dup2(null.as_raw_fd(), 0) } < 0 {
            unsafe { libc::_exit(1) };
          }
          self.replace_shell_stdin(None);
        }
      }
      drop(null);
      self.detach_shell_worker_io();
      if let Some(external) = self.external.clone() {
        self.set_external_commands(std::rc::Rc::new(WorkerPrograms(external)));
      }
      self.shell_compound.commands.signals.clear();
      self.shell_compound.commands.jobs.clear();
      self.reset_fork_cover_in_child();
      self
        .shell_compound
        .commands
        .process_fds
        .borrow_mut()
        .clear();
      *self.shell_io.borrow_mut() = Some(io);
      // The forked address space has exclusive ownership of this host. A new
      // thread gives Tokio fresh TLS and a fresh reactor; inherited runtime
      // drivers and background tasks must never run in the child. It is a
      // bare pthread: std's thread start takes a registry lock that another
      // parent thread, starting or exiting at the fork, may have held, and
      // the child's copy of that lock would never be released.
      let host = self as *mut LispHost as usize;
      let stage = stage as *const LispValue<Sym> as usize;
      run_on_fresh_thread(move || {
        let host = unsafe { &mut *(host as *mut LispHost) };
        let stage = unsafe { &*(stage as *const LispValue<Sym>) };
        let runtime = match tokio::runtime::Builder::new_current_thread()
          .enable_all()
          .build()
        {
          Ok(runtime) => runtime,
          Err(_) => unsafe { libc::_exit(1) },
        };
        let status = runtime.block_on(tento_env::with_env_map_async(environment, async {
          let output = FlowOutput::default();
          let result = eval_flow(host, stage, line, false, output.clone(), false).await;
          match result {
            Ok(value) => {
              output.flush_value(host, value);
              host.shell_status()
            }
            Err(TshScriptErrorKind::Control(
              super::ControlSignal::Exit(status)
              | super::ControlSignal::ExecExit(status)
              | super::ControlSignal::Return(status)
              | super::ControlSignal::Discard(status),
            ))
            | Err(TshScriptErrorKind::BashStatus(status)) => status,
            Err(error) => {
              host.report_shell_diagnostic(format!("tsh: line {line}: {error}"));
              1
            }
          }
        }));
        let _ = super::flush_shell_output();
        unsafe { libc::_exit(status) }
      });
      unsafe { libc::_exit(1) }
    }
    drop(writer);
    // Start reaping immediately, even when the script never calls wait. The
    // reaper runs off this thread, so the job settles whether or not this
    // thread's runtime is polled (a blocking Lisp wait relies on that). The
    // capture reader drains before waitpid; the pipe closes when the child
    // exits, so a large job cannot deadlock on a full pipe.
    let (send, receive) = tokio::sync::oneshot::channel();
    // The capture drains on a thread of its own, so the wait for the child
    // sees it stop and not only exit.
    let drained = reader.map(|mut reader| {
      let (sent, drained) = std::sync::mpsc::channel();
      super::shell_jobs::spawn_reaper(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        let _ = sent.send(reader.read_to_end(&mut bytes).map(|_| bytes));
      });
      drained
    });
    super::shell_jobs::spawn_reaper(move || {
      let result = (|| -> crate::Result<ShellCapture> {
        // Stops and continues on the way are noted, not settled.
        let status = super::shell_jobs::control::wait_child(pid as u32)
          .map_err(|e| crate::Error::Other(e.into()))?;
        let mut stdout = Vec::new();
        if let Some(drained) = drained {
          stdout = drained
            .recv()
            .map_err(|e| crate::Error::Other(e.into()))?
            .map_err(|e| crate::Error::Other(e.into()))?;
        }
        let status = if libc::WIFEXITED(status) {
          libc::WEXITSTATUS(status)
        } else {
          super::shell_jobs::note_termination(pid as u32, libc::WTERMSIG(status));
          128 + libc::WTERMSIG(status)
        };
        Ok(ShellCapture {
          stdout,
          status,
          statuses: vec![status],
          start_errors: Vec::new(),
        })
      })();
      let _ = send.send(result);
    });
    let completion = Box::pin(async move {
      receive
        .await
        .map_err(|e| crate::Error::Other(e.into()))?
    });
    Ok(ShellJob {
      pid: pid as u32,
      completion,
    })
  }

  #[cfg(not(unix))]
  pub(super) fn fork_shell_plan(
    &mut self,
    _: &LispValue<Sym>,
    _: usize,
    _: ShellIo,
    _: bool,
    _: bool,
    _: &tento_lisp::owned_io_gate::ForkReservation,
  ) -> Result<ShellJob, LispHostError> {
    Err(LispHostError::Command(
      "shell children require a Unix host".into(),
    ))
  }

  #[cfg(unix)]
  pub(super) fn process_substitution(
    &mut self,
    stage: &LispValue<Sym>,
    write: bool,
    line: usize,
  ) -> Result<String, LispHostError> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::sync::Arc;
    // Before the pipe: a refused fork allocates nothing.
    let permission = self.fork_permission("process substitution", line)?;
    let (reader, writer) = pipe().map_err(|e| LispHostError::Command(e.to_string()))?;
    let (parent, child) = if write {
      (writer, reader)
    } else {
      (reader, writer)
    };
    // Bash presents 63, 62, ... in argv and utility diagnostics. Duplicate
    // atomically; never overwrite an occupied OS or logical shell descriptor.
    let io = self.shell_io.borrow().clone().unwrap_or_default();
    let mut fd = -1;
    for candidate in (10..=63).rev() {
      if io.0.contains_key(&candidate) {
        continue;
      }
      let copy = unsafe { libc::fcntl(parent.as_raw_fd(), libc::F_DUPFD_CLOEXEC, candidate) };
      if copy < 0 {
        return Err(LispHostError::Command(std::io::Error::last_os_error().to_string()));
      }
      if copy == candidate {
        fd = copy;
        break;
      }
      unsafe { libc::close(copy); }
    }
    if fd < 0 {
      // 10..=63 are all taken (a host with many runtimes and pipes open, such
      // as a busy test process): take the lowest free descriptor above them.
      let copy = unsafe { libc::fcntl(parent.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
      if copy >= 0 && !io.0.contains_key(&copy) {
        fd = copy;
      } else if copy >= 0 {
        unsafe { libc::close(copy); }
      }
    }
    if fd < 0 {
      return Err(LispHostError::Command("process substitution: no free file descriptor".into()));
    }
    drop(parent);
    let parent = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut child_io = self.shell_io.borrow().clone().unwrap_or_default();
    // The child does not inherit the outer command's process-substitution ends.
    child_io.0.retain(|descriptor, _| {
      !self
        .shell_compound
        .commands
        .process_fds
        .borrow()
        .contains(descriptor)
    });
    child_io
      .0
      .insert(if write { 0 } else { 1 }, FdTarget::File(Arc::new(child)));
    self
      .shell_compound
      .commands
      .process_fds
      .borrow_mut()
      .push(fd);
    let forked = self.fork_shell_plan(stage, line, child_io, false, false, &permission);
    drop(permission);
    let job = match forked {
      Ok(job) => job,
      Err(error) => {
        self.shell_compound.commands.process_fds.borrow_mut().pop();
        return Err(error);
      }
    };
    self.submit_process_substitution(job);
    let mut io = self.shell_io.borrow().clone().unwrap_or_default();
    io.0.insert(fd, FdTarget::File(Arc::new(parent)));
    *self.shell_io.borrow_mut() = Some(io);
    Ok(format!("/dev/fd/{fd}"))
  }
}

/// Close only the process-substitution descriptors allocated in this command.
/// Nested flow scopes preserve their caller's descriptor table.
pub(super) struct ProcessScope {
  io: std::rc::Rc<std::cell::RefCell<Option<ShellIo>>>,
  saved: Option<ShellIo>,
  fds: std::rc::Rc<std::cell::RefCell<Vec<i32>>>,
  count: usize,
}
impl ProcessScope {
  pub(super) fn enter(host: &LispHost) -> Self {
    Self {
      io: host.shell_io.clone(),
      saved: host.shell_io.borrow().clone(),
      fds: host.shell_compound.commands.process_fds.clone(),
      count: host.shell_compound.commands.process_fds.borrow().len(),
    }
  }
}
impl Drop for ProcessScope {
  fn drop(&mut self) {
    if self.fds.borrow().len() > self.count {
      *self.io.borrow_mut() = self.saved.take();
      self.fds.borrow_mut().truncate(self.count);
    }
  }
}

// A fork must not reuse Tokio's process-wide SIGCHLD registry. Workers launch
// their own children with blocking waitpid through std::process; OS pipes still
// connect every stage concurrently. The worker's thread owns all shell state.
#[cfg(unix)]
struct WorkerPrograms(std::rc::Rc<dyn super::interp::ExternalCommands>);
#[cfg(unix)]
impl super::interp::ExternalCommands for WorkerPrograms {
  fn lookup(&self, head: &str) -> super::interp::ExternalLookup {
    self.0.lookup(head)
  }
  fn suggest(&self, head: &str) -> Option<String> {
    self.0.suggest(head)
  }
  fn not_executable(&self, head: &str) -> bool {
    self.0.not_executable(head)
  }
  fn run_blocking(&self, argv: Vec<String>) -> Option<crate::Result<serde_json::Value>> {
    self.0.run_blocking(argv)
  }
  fn run(&self, argv: Vec<String>) -> super::interp::AsyncCommandFut {
    Box::pin(async move {
      let result = worker_pipeline(vec![argv], None, false, vec![])?;
      if result.status == 0 {
        Ok(serde_json::Value::Null)
      } else {
        Err(crate::Error::ProcessExit {
          status: Some(result.status),
          signal: None,
          detail: format!("exit status {}", result.status),
        })
      }
    })
  }
  fn run_pipeline(
    &self,
    argv: Vec<Vec<String>>,
    input: Option<Vec<u8>>,
    capture: bool,
  ) -> super::PipelineFuture {
    self.run_pipeline_with_io(argv, input, capture, Vec::new())
  }
  fn run_pipeline_with_io(
    &self,
    argv: Vec<Vec<String>>,
    input: Option<Vec<u8>>,
    capture: bool,
    io: Vec<Option<ShellIo>>,
  ) -> super::PipelineFuture {
    Box::pin(async move { worker_pipeline(argv, input, capture, io) })
  }
  fn start_background(
    &self,
    argv: Vec<String>,
    io: Option<ShellIo>,
    capture: bool,
  ) -> crate::Result<ShellJob> {
    use std::process::{Command, Stdio};
    let mut command = Command::new(worker_program(&argv[0]));
    command.args(&argv[1..]);
    command.env_clear().envs(
      tento_env::global_env_map()
        .map(|map| map.snapshot_os())
        .unwrap_or_else(|| std::env::vars_os().collect()),
    );
    // An asynchronous command's inherited stdin is /dev/null.
    command.stdin(Stdio::null());
    if capture {
      command.stdout(Stdio::piped());
    }
    let writers = if let Some(mut io) = io {
      if matches!(io.target(0), FdTarget::Inherit(0)) {
        io.0.remove(&0);
      }
      command.envs(io.1.iter().cloned());
      super::process_pipeline::configure_std_descriptors(&mut command, &io)?
    } else {
      vec![]
    };
    if super::shell_jobs::control::new_group_requested() {
      use std::os::unix::process::CommandExt;
      command.process_group(0);
    }
    LispHost::inherit_ignored_sigchld(&mut command);
    let mut child = command.spawn().map_err(|e| crate::Error::Other(e.into()))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let (send, receive) = tokio::sync::oneshot::channel();
    let drained = stdout.map(|mut stdout| {
      spawn_thread(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
      })
    });
    spawn_thread(move || {
      let writers = worker_writers(writers);
      let result = (|| -> crate::Result<ShellCapture> {
        let status = {
          use std::os::unix::process::ExitStatusExt;
          std::process::ExitStatus::from_raw(
            super::shell_jobs::control::wait_child(pid)
              .map_err(|e| crate::Error::Other(e.into()))?,
          )
        };
        let bytes = match drained {
          Some(drained) => drained
            .join()
            .map_err(|_| crate::Error::Other(anyhow::anyhow!("capture reader failed")))?
            .map_err(|e| crate::Error::Other(e.into()))?,
          None => Vec::new(),
        };
        for writer in writers {
          let _ = writer.join();
        }
        {
          use std::os::unix::process::ExitStatusExt;
          if let Some(signal) = status.signal() {
            super::shell_jobs::note_termination(pid, signal);
          }
        }
        let status = worker_status(status);
        Ok(ShellCapture {
          stdout: bytes,
          status,
          statuses: vec![status],
          start_errors: vec![],
        })
      })();
      let _ = send.send(result);
    });
    Ok(ShellJob {
      pid,
      completion: Box::pin(
        async move { receive.await.map_err(|e| crate::Error::Other(e.into()))? },
      ),
    })
  }
}

#[cfg(unix)]
fn worker_program(name: &str) -> std::path::PathBuf {
  if name.contains('/') {
    return name.into();
  }
  tento_env::effective_var("PATH")
    .unwrap_or_else(|| "/usr/bin:/bin".into())
    .split(':')
    .map(|dir| std::path::Path::new(if dir.is_empty() { "." } else { dir }).join(name))
    .find(|path| path.is_file())
    .unwrap_or_else(|| name.into())
}

#[cfg(unix)]
fn worker_status(status: std::process::ExitStatus) -> i32 {
  use std::os::unix::process::ExitStatusExt;
  status
    .code()
    .unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
}
#[cfg(unix)]
fn worker_writers(writers: Vec<(std::fs::File, Vec<u8>)>) -> Vec<WorkerThread<()>> {
  writers
    .into_iter()
    .map(|(mut file, bytes)| {
      spawn_thread(move || {
        use std::io::Write;
        let _ = file.write_all(&bytes);
      })
    })
    .collect()
}

/// A stage's captured stderr, replayed on the shell's own. A forked child
/// writes descriptor 2 directly: std's stderr lock may be held forever in it.
#[cfg(unix)]
fn write_stderr(bytes: &[u8]) {
  use std::io::Write;
  if !in_forked_child() {
    let _ = std::io::stderr().lock().write_all(bytes);
    return;
  }
  let mut rest = bytes;
  while !rest.is_empty() {
    // SAFETY: write(2) reads `rest.len()` bytes from a live slice.
    let written = unsafe { libc::write(2, rest.as_ptr().cast(), rest.len()) };
    if written <= 0 {
      break;
    }
    rest = &rest[written as usize..];
  }
}

#[cfg(unix)]
fn worker_pipeline(
  argv: Vec<Vec<String>>,
  input: Option<Vec<u8>>,
  capture: bool,
  io: Vec<Option<ShellIo>>,
) -> crate::Result<ShellCapture> {
  use std::io::{Read, Write};
  use std::process::{Command, Stdio};
  let count = argv.len();
  let mut statuses = vec![0; count];
  let mut errors = Vec::new();
  let mut children = Vec::new();
  let mut previous = None;
  let mut readers = Vec::new();
  let mut writers = Vec::new();
  let mut last_stdout = None;
  for (index, argv) in argv.into_iter().enumerate() {
    if argv.is_empty() {
      statuses[index] = 1;
      previous = Some(Stdio::null());
      continue;
    }
    let mut command = Command::new(worker_program(&argv[0]));
    command.args(&argv[1..]);
    command.env_clear().envs(
      tento_env::global_env_map()
        .map(|map| map.snapshot_os())
        .unwrap_or_else(|| std::env::vars_os().collect()),
    );
    if let Some(stdin) = previous.take() {
      command.stdin(stdin);
    } else if input.is_some() {
      command.stdin(Stdio::piped());
    }
    if index + 1 < count || capture {
      command.stdout(Stdio::piped());
    }
    if io.get(index).is_some_and(Option::is_some) {
      command.stderr(Stdio::piped());
    }
    if let Some(Some(io)) = io.get(index) {
      command.envs(io.1.iter().cloned());
      writers.extend(worker_writers(
        super::process_pipeline::configure_std_descriptors(&mut command, io)?,
      ));
    }
    LispHost::inherit_ignored_sigchld(&mut command);
    let mut child = match command.spawn() {
      Ok(child) => child,
      Err(error) => {
        let status = if error.kind() == std::io::ErrorKind::NotFound {
          127
        } else {
          126
        };
        statuses[index] = status;
        errors.push((status, format!("{}: {error}", argv[0])));
        previous = Some(Stdio::null());
        continue;
      }
    };
    if index == 0 {
      if let (Some(mut stdin), Some(bytes)) = (child.stdin.take(), input.clone()) {
        writers.push(spawn_thread(move || {
          let _ = stdin.write_all(&bytes);
        }));
      }
    }
    if index + 1 < count {
      previous = Some(
        child
          .stdout
          .take()
          .map(Stdio::from)
          .unwrap_or_else(Stdio::null),
      );
    } else {
      last_stdout = child.stdout.take();
    }
    if let Some(mut stderr) = child.stderr.take() {
      readers.push(spawn_thread(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
      }));
    }
    children.push((index, child));
  }
  drop(previous);
  let mut stdout = Vec::new();
  if let Some(mut reader) = last_stdout {
    reader
      .read_to_end(&mut stdout)
      .map_err(|e| crate::Error::Other(e.into()))?;
  }
  for reader in readers {
    if let Ok(bytes) = reader.join() {
      write_stderr(&bytes);
    }
  }
  for (index, mut child) in children {
    statuses[index] = worker_status(child.wait().map_err(|e| crate::Error::Other(e.into()))?);
  }
  for writer in writers {
    let _ = writer.join();
  }
  Ok(ShellCapture {
    stdout,
    status: statuses.last().copied().unwrap_or(0),
    statuses,
    start_errors: errors,
  })
}
