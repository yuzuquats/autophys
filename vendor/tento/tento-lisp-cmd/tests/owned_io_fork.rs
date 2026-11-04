//! The owned-I/O fork gate through the shell. A command unit whose own
//! preparation can fork this host without exec (a process substitution, a
//! compound background job) reserves before its own effects, is refused while
//! owned I/O is live in any host of the process, and releases its reservation
//! when that preparation ends. Owned payloads are simulated with live tokens
//! (`fixture.own`); tsh's owned natives take the same process gate.
//!
//! The gate is process-global, so every test takes `serial()`, which also
//! checks the gate is idle when each test starts. A debug build of the
//! library asserts that no fork runs uncovered; `uncovered_shell_forks`
//! checks the same in any build. Every wait is bounded.
#![cfg(unix)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, mpsc};
use std::time::{Duration, Instant};

use serde_json::Value as JsonValue;
use tento_lisp_cmd::owned_io_gate::{self, ForkReservation, GateError, LiveIo};
use tento_lisp_cmd::script::{
  AsyncCommandFut, ExternalCommands, ExternalLookup, JobAdmission, JobHost, JobOutcome, JobPlan,
  LispHost, LispHostError, LispValue, PipelineFuture, ShellIo, ShellJob, Sym,
  run_process_pipeline_with_io, settled_outcome, start_process_background, uncovered_shell_forks,
};

static SERIAL: Mutex<()> = Mutex::new(());

/// One test at a time, each starting with an idle gate.
fn serial() -> MutexGuard<'static, ()> {
  let guard = SERIAL
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  assert_eq!(
    owned_io_gate::ensure_idle(),
    Ok(()),
    "gate state leaked into this test"
  );
  guard
}

/// Set only while the race test's owner holds its token. A forked child
/// reads the copy it was forked with.
static OWNER_HOLDS: AtomicBool = AtomicBool::new(false);

/// Absolute programs only; a job host that counts admissions and can replay.
#[derive(Default)]
struct Programs {
  admissions: Cell<usize>,
  replay: Cell<bool>,
}

impl ExternalCommands for Programs {
  fn lookup(&self, head: &str) -> ExternalLookup {
    if head.starts_with('/') && Path::new(head).is_file() {
      ExternalLookup::Runs
    } else {
      ExternalLookup::NotFound
    }
  }
  fn suggest(&self, _: &str) -> Option<String> {
    None
  }
  fn run(&self, _: Vec<String>) -> AsyncCommandFut {
    Box::pin(async { Ok(JsonValue::Null) })
  }
  fn run_pipeline_with_io(
    &self,
    argv: Vec<Vec<String>>,
    input: Option<Vec<u8>>,
    capture: bool,
    io: Vec<Option<ShellIo>>,
  ) -> PipelineFuture {
    // An empty argv is an inert failed stage; the runner gives it status 1.
    let programs = argv
      .into_iter()
      .map(|argv| (argv.first().map(PathBuf::from).unwrap_or_default(), argv))
      .collect();
    Box::pin(run_process_pipeline_with_io(
      programs, input, capture, None, None, io,
    ))
  }
  fn start_background(
    &self,
    argv: Vec<String>,
    io: Option<ShellIo>,
    capture: bool,
  ) -> tento_lisp_cmd::Result<ShellJob> {
    start_process_background(PathBuf::from(&argv[0]), argv, io, capture, None)
  }
}

impl JobHost for Programs {
  fn admit(&self, _: &JobPlan) -> Option<JobAdmission> {
    self.admissions.set(self.admissions.get() + 1);
    self.replay.get().then(|| JobAdmission::Replayed {
      execution: "fixture/1.0".into(),
      pid: std::process::id(),
      settled: settled_outcome(JobOutcome {
        status: 0,
        signal: None,
        statuses: vec![0],
        stdout: Rc::new(Vec::new()),
      }),
    })
  }
}

struct Fixture {
  host: LispHost,
  programs: Rc<Programs>,
  events: Rc<RefCell<Vec<String>>>,
}

fn word(args: &[LispValue<Sym>]) -> String {
  match args.first() {
    Some(LispValue::String(text)) => text.as_str().to_string(),
    _ => String::new(),
  }
}

/// What a forked child finds: a new gate epoch, where an owned payload can be
/// created and then refuses the child's own fork.
fn child_gate_report() -> String {
  let token = match LiveIo::acquire("child payload") {
    Ok(token) => token,
    Err(error) => return format!("child refused: {error}"),
  };
  let refused = matches!(
    ForkReservation::acquire("child fork"),
    Err(GateError::LiveIo(_))
  );
  let owned_here = token.check_process().is_ok();
  drop(token);
  let free = ForkReservation::acquire("child fork").is_ok();
  if refused && owned_here && free {
    "child epoch fresh".into()
  } else {
    "child gate inconsistent".into()
  }
}

impl Fixture {
  fn new() -> Self {
    let mut host = LispHost::new();
    let programs = Rc::new(Programs::default());
    host.set_external_commands(programs.clone());
    host.set_job_host(programs.clone());
    host.collect_shell_diagnostics();
    host.set_shell_formatter(Rc::new(|value: &JsonValue| {
      value.as_str().map(|text| format!("{text}\n"))
    }));
    host.set_shell_file_opener(Rc::new(|path, read, append| {
      std::fs::OpenOptions::new()
        .read(read)
        .write(!read)
        .create(!read)
        .append(append)
        .truncate(!read && !append)
        .open(path)
        .map_err(|error| LispHostError::Command(error.to_string()))
    }));
    let events = Rc::new(RefCell::new(Vec::new()));
    let owned: Rc<RefCell<HashMap<String, LiveIo>>> = Rc::default();
    {
      // An owned constructor: it takes its live token before any effect, as
      // the tsh owned natives do. A busy gate is recorded, not raised.
      let (events, owned) = (events.clone(), owned.clone());
      host.register_native_special("fixture.own", move |args| {
        let name = word(&args);
        match LiveIo::acquire(format!("fixture payload {name}")) {
          Ok(token) => {
            owned.borrow_mut().insert(name.clone(), token);
            events.borrow_mut().push(format!("own {name}"));
          }
          Err(error) => events.borrow_mut().push(format!("{name}: {error}")),
        }
        Ok(LispValue::Nil)
      });
    }
    host.register_native_special("fixture.close", move |args| {
      owned.borrow_mut().remove(&word(&args));
      Ok(LispValue::Nil)
    });
    host.register_native_special("fixture.child", |_| {
      Ok(LispValue::String(child_gate_report().into()))
    });
    host.register_native_special("fixture.flag", |_| {
      let copied = OWNER_HOLDS.load(Ordering::SeqCst);
      Ok(LispValue::String(
        if copied { "inherited" } else { "clean" }.into(),
      ))
    });
    Self {
      host,
      programs,
      events,
    }
  }

  async fn run(&mut self, source: &str) -> (String, i32) {
    let captured = tokio::time::timeout(
      Duration::from_secs(20),
      self.host.capture_shell_source(source),
    )
    .await
    .unwrap_or_else(|_| panic!("{source}: timed out"))
    .unwrap_or_else(|error| panic!("{source}: {error}"));
    (String::from_utf8(captured.stdout).unwrap(), captured.status)
  }

  async fn fails(&mut self, source: &str) -> String {
    match tokio::time::timeout(
      Duration::from_secs(20),
      self.host.capture_shell_source(source),
    )
    .await
    {
      Ok(Err(error)) => error.to_string(),
      Ok(Ok(captured)) => panic!("{source}: succeeded with status {}", captured.status),
      Err(_) => panic!("{source}: timed out"),
    }
  }

  /// The diagnostics so far; collection continues (taking them stops it).
  fn diagnostics(&mut self) -> String {
    let diagnostics = self.host.take_shell_diagnostics().join("\n");
    self.host.collect_shell_diagnostics();
    diagnostics
  }

  fn events(&self) -> Vec<String> {
    std::mem::take(&mut *self.events.borrow_mut())
  }
}

fn runtime() -> tokio::runtime::Runtime {
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap()
}

/// Another host's live owned payload, held on its own thread until dropped.
struct OtherHost {
  release: mpsc::SyncSender<()>,
  thread: Option<std::thread::JoinHandle<()>>,
}

impl OtherHost {
  fn hold(owner: &'static str) -> Self {
    let (ready, ready_rx) = mpsc::sync_channel(0);
    let (release, release_rx) = mpsc::sync_channel::<()>(0);
    let thread = std::thread::spawn(move || {
      let token = LiveIo::acquire(owner).expect("the other host's payload");
      ready.send(()).unwrap();
      let _ = release_rx.recv_timeout(Duration::from_secs(60));
      drop(token);
    });
    ready_rx
      .recv_timeout(Duration::from_secs(5))
      .expect("the other host holds its payload");
    Self {
      release,
      thread: Some(thread),
    }
  }
}

impl Drop for OtherHost {
  fn drop(&mut self) {
    let _ = self.release.send(());
    if let Some(thread) = self.thread.take() {
      thread.join().unwrap();
    }
  }
}

struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    let path =
      std::env::temp_dir().join(format!("tento-owned-io-fork-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    Self(path)
  }
  fn file(&self, name: &str, contents: &str) -> PathBuf {
    let path = self.0.join(name);
    std::fs::write(&path, contents).unwrap();
    path
  }
  fn fifo(&self, name: &str) -> PathBuf {
    let path = self.0.join(name);
    let raw = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: a NUL-terminated path that outlives the call.
    assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0, "mkfifo");
    path
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}

fn q(path: &Path) -> String {
  format!("'{}'", path.display())
}

fn read(path: &Path) -> String {
  std::fs::read_to_string(path).unwrap()
}

/// Poll `probe` until it yields, for at most five seconds.
fn eventually<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
  let deadline = Instant::now() + Duration::from_secs(5);
  loop {
    if let Some(value) = probe() {
      return value;
    }
    assert!(Instant::now() < deadline, "timed out waiting for {what}");
    std::thread::sleep(Duration::from_millis(5));
  }
}

/// Open `fifo` for writing once a reader waits on it, for at most five
/// seconds: until then a non-blocking open fails instead of blocking.
fn open_fifo_writer(fifo: &Path) -> std::fs::File {
  use std::os::unix::fs::OpenOptionsExt;
  eventually("a FIFO reader", || {
    std::fs::OpenOptions::new()
      .write(true)
      .custom_flags(libc::O_NONBLOCK)
      .open(fifo)
      .ok()
  })
}

#[tokio::test]
async fn another_hosts_payload_refuses_forking_units_before_their_own_effects() {
  let _serial = serial();
  let dir = TempDir::new("refuse");
  let target = dir.file("target", "original\n");
  let job = dir.file("job", "original\n");
  let nested = dir.file("nested", "original\n");
  let mut f = Fixture::new();
  let other = OtherHost::hold("other host reader");

  // A process substitution in the words, in a redirection target and in a
  // prefix assignment: each command is refused before its own redirection.
  for source in [
    format!("/bin/cat <(echo new) > {}", q(&target)),
    format!("echo new > >(/bin/cat > {})", q(&target)),
    format!("X=$(/bin/cat <(echo x)) /bin/echo new > {}", q(&target)),
    format!("x=$(/bin/cat <(echo x)) > {}", q(&target)),
  ] {
    let (out, status) = f.run(&source).await;
    assert_eq!((out.as_str(), status), ("", 1), "{source}");
    let diagnostics = f.diagnostics();
    assert!(
      diagnostics.contains("owned I/O prevents shell fork in this process"),
      "{source}: {diagnostics}"
    );
    assert!(
      diagnostics.contains("other host reader"),
      "{source}: {diagnostics}"
    );
    assert_eq!(
      read(&target),
      "original\n",
      "{source}: the refusing command's own target"
    );
  }

  // A compound job and the nesting regression `diff <(a) "$(cat <(b))" > out &`
  // are refused before admission and before their redirections.
  let admissions = f.programs.admissions.get();
  for (source, path) in [
    (format!("{{ echo new; }} > {} &", q(&job)), &job),
    (
      format!(
        "/usr/bin/diff <(echo a) \"$(/bin/cat <(echo /dev/null))\" > {} &",
        q(&nested)
      ),
      &nested,
    ),
  ] {
    let error = f.fails(&source).await;
    assert!(
      error.contains("owned I/O prevents shell fork in this process"),
      "{source}: {error}"
    );
    assert_eq!(
      f.programs.admissions.get(),
      admissions,
      "{source}: a refused job is never admitted"
    );
    assert_eq!(read(path), "original\n", "{source}");
  }

  // External commands, foreground or background, keep their behavior.
  let (out, status) = f
    .run(&format!(
      "/bin/echo external > {t}; /bin/cat {t}",
      t = q(&target)
    ))
    .await;
  assert_eq!((out.as_str(), status), ("external\n", 0));
  let (out, status) = f
    .run(&format!(
      "/bin/echo spawned > {j} & wait; /bin/cat {j}",
      j = q(&job)
    ))
    .await;
  assert_eq!((out.as_str(), status), ("spawned\n", 0));
  assert_eq!(f.programs.admissions.get(), admissions + 1);
  let (_, status) = f.run("std.jobs.spawn /usr/bin/true; wait").await;
  assert_eq!(status, 0);
  assert_eq!(f.programs.admissions.get(), admissions + 2);

  // Once the payload closes, the same commands run.
  drop(other);
  let (out, status) = f
    .run(&format!(
      "/bin/cat <(echo new) > {t}; /bin/cat {t}",
      t = q(&target)
    ))
    .await;
  assert_eq!((out.as_str(), status), ("new\n", 0));
  let (out, _) = f
    .run(&format!(
      "{{ echo job; }} > {j} & wait; /bin/cat {j}",
      j = q(&job)
    ))
    .await;
  assert_eq!(out, "job\n");
  // The nesting regression's job is admitted now. (Its program cannot read
  // a word's process substitution: background jobs take their descriptors
  // before word expansion, an existing limitation. `:` writes nothing.)
  let (_, status) = f
    .run(&format!(
      "/bin/sh -c : <(:) \"$(/bin/cat <(echo /dev/null))\" > {} & wait",
      q(&nested)
    ))
    .await;
  assert_eq!(status, 0);
  assert_eq!(f.programs.admissions.get(), admissions + 4);
  let (out, _) = f
    .run(&format!(
      "/usr/bin/diff <(echo a) \"$(/bin/cat <(echo /dev/null))\" > {n}; /bin/cat {n}",
      n = q(&nested)
    ))
    .await;
  assert_eq!(out, "1d0\n< a\n");
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
  assert_eq!(uncovered_shell_forks(), 0);
}

#[tokio::test]
async fn earlier_stages_and_enclosing_commands_keep_their_completed_effects() {
  let _serial = serial();
  let dir = TempDir::new("stages");
  let first = dir.file("first", "original\n");
  let second = dir.file("second", "original\n");
  let inner = dir.file("inner", "original\n");
  let outer = dir.file("outer", "original\n");
  let mut f = Fixture::new();
  let other = OtherHost::hold("other host reader");
  // `a > out | b <(y)`: each external stage is its own unit. The first
  // stage's redirection and output stand; the refusing stage leaves its own
  // target alone.
  let (_, status) = f
    .run(&format!(
      "/bin/echo first > {} | /bin/cat <(echo x) > {}",
      q(&first),
      q(&second)
    ))
    .await;
  assert_eq!(status, 1);
  assert_eq!(read(&first), "first\n");
  assert_eq!(read(&second), "original\n");
  assert!(f.diagnostics().contains("owned I/O prevents shell fork"));
  // `f > out`: the scan does not predict a function's commands, so `out` is
  // truncated before the function's own process substitution refuses.
  let (_, status) = f
    .run(&format!(
      "g() {{ /bin/cat <(echo x) > {}; }}; g > {}",
      q(&inner),
      q(&outer)
    ))
    .await;
  assert_eq!(status, 1);
  assert_eq!(read(&outer), "");
  assert_eq!(read(&inner), "original\n");
  assert!(f.diagnostics().contains("owned I/O prevents shell fork"));
  drop(other);
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
}

#[tokio::test]
async fn reservations_nest_and_end_with_preparation_not_execution() {
  let _serial = serial();
  let mut f = Fixture::new();
  // `while …; done < <(producer)`: released once the redirection is
  // prepared, so the loop body constructs owned I/O.
  let (out, status) = f
    .run("while read -r n; do fixture.own loop-$n; fixture.close loop-$n; echo got $n; done < <(printf '%s\\n' 1 2)")
    .await;
  assert_eq!((out.as_str(), status), ("got 1\ngot 2\n", 0));
  assert_eq!(f.events(), ["own loop-1", "own loop-2"]);
  // Inside the reserved command's own expansion an owned open is busy:
  // `cat <(p) "$(f)"` and `x=$(f; cat <(y))`.
  for (source, name, expected) in [
    (
      "/bin/cat <(echo p) \"$(fixture.own in-words; echo /dev/null)\"",
      "in-words",
      "p\n",
    ),
    (
      "x=$(fixture.own in-sub; /bin/cat <(echo y)); echo $x",
      "in-sub",
      "y\n",
    ),
  ] {
    let (out, _) = f.run(source).await;
    assert_eq!(out, expected, "{source}");
    let events = f.events();
    assert_eq!(events.len(), 1, "{source}: {events:?}");
    assert!(
      events[0].starts_with(&format!(
        "{name}: owned I/O busy: shell fork preparation in progress"
      )),
      "{source}: {events:?}"
    );
  }
  // The command's execution follows its expansion: no reservation remains.
  let (_, status) = f.run("fixture.own after-expansion <(:)").await;
  assert_eq!(status, 0);
  assert_eq!(f.events(), ["own after-expansion"]);
  assert!(ForkReservation::acquire("while owned").is_err());
  f.run("fixture.close after-expansion").await;
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
  // Nested reservations in one command, `diff <(a) "$(cat <(b))" > out`,
  // in the foreground and as a job (see the descriptor note above).
  let dir = TempDir::new("nest");
  let out_path = dir.file("out", "");
  let (out, _) = f
    .run(&format!(
      "/usr/bin/diff <(echo a) \"$(/bin/cat <(echo /dev/null))\" > {p}; /bin/cat {p}",
      p = q(&out_path)
    ))
    .await;
  assert_eq!(out, "1d0\n< a\n");
  let admissions = f.programs.admissions.get();
  let (_, status) = f
    .run(&format!(
      "/bin/sh -c : <(:) \"$(/bin/cat <(echo /dev/null))\" > {} & wait",
      q(&out_path)
    ))
    .await;
  assert_eq!(status, 0);
  assert_eq!(f.programs.admissions.get(), admissions + 1);
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
  assert_eq!(uncovered_shell_forks(), 0);
}

#[test]
fn a_fifo_blocked_reservation_keeps_constructors_busy_and_a_blocked_open_refuses_forks() {
  let _serial = serial();
  let dir = TempDir::new("fifo");
  // A reservation blocked on a FIFO: another host's constructor returns busy
  // at once, for as long as the redirection blocks.
  let fifo = dir.fifo("input");
  let out = dir.file("out", "");
  let source = format!("/bin/cat <(echo procsub) < {} > {}", q(&fifo), q(&out));
  let (done, done_rx) = mpsc::channel();
  let shell = std::thread::spawn(move || {
    let mut f = Fixture::new();
    let (_, status) = runtime().block_on(f.run(&source));
    done.send(status).unwrap();
  });
  let busy = eventually("the reservation", || {
    LiveIo::acquire("other host constructor").err()
  });
  assert!(matches!(busy, GateError::Busy(_)), "{busy}");
  assert!(
    busy.to_string().contains("redirected command on line 1"),
    "{busy}"
  );
  std::thread::sleep(Duration::from_millis(100));
  let asked = Instant::now();
  assert!(matches!(
    LiveIo::acquire("other host constructor"),
    Err(GateError::Busy(_))
  ));
  assert!(asked.elapsed() < Duration::from_secs(1), "busy is prompt");
  assert!(
    done_rx.try_recv().is_err(),
    "the command still blocks on the FIFO"
  );
  drop(open_fifo_writer(&fifo));
  let status = done_rx
    .recv_timeout(Duration::from_secs(20))
    .expect("the command completes once the FIFO opens");
  shell.join().unwrap();
  assert_eq!(status, 0);
  assert_eq!(read(&out), "procsub\n");
  drop(LiveIo::acquire("after the reservation").unwrap());

  // An owned open blocked on a FIFO already holds its token: this host's
  // fork is refused promptly instead of waiting for it.
  let blocked = dir.fifo("owned");
  let (ready, ready_rx) = mpsc::sync_channel(0);
  let path = blocked.clone();
  let opener = std::thread::spawn(move || {
    let token = LiveIo::acquire("blocked owned open").unwrap();
    ready.send(()).unwrap();
    let file = std::fs::File::open(&path);
    drop(file);
    drop(token);
  });
  ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
  let target = dir.file("target", "original\n");
  let runtime = runtime();
  let mut f = Fixture::new();
  let asked = Instant::now();
  let (_, status) = runtime.block_on(f.run(&format!("/bin/cat <(echo x) > {}", q(&target))));
  assert_eq!(status, 1);
  assert!(
    asked.elapsed() < Duration::from_secs(5),
    "the refusal is prompt"
  );
  assert!(f.diagnostics().contains("blocked owned open"));
  assert_eq!(read(&target), "original\n");
  drop(open_fifo_writer(&blocked));
  opener.join().unwrap();
  let (_, status) = runtime.block_on(f.run(&format!("/bin/cat <(echo x) > {}", q(&target))));
  assert_eq!(status, 0);
  assert_eq!(read(&target), "x\n");
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
}

#[tokio::test]
async fn forked_children_start_a_new_gate_epoch() {
  let _serial = serial();
  let dir = TempDir::new("epoch");
  let job = dir.file("job", "");
  let mut f = Fixture::new();
  // The parent's unit reservation and fork lease were live at the fork; the
  // child's gate starts empty, so its own payload and fork work.
  let (out, status) = f.run("/bin/cat <(fixture.child)").await;
  assert_eq!((out.as_str(), status), ("child epoch fresh\n", 0));
  let (out, _) = f
    .run(&format!(
      "{{ fixture.child; }} > {j} & wait; /bin/cat {j}",
      j = q(&job)
    ))
    .await;
  assert_eq!(out, "child epoch fresh\n");
  // A child's own nested fork is covered by the child's own units.
  let (out, _) = f.run("/bin/cat <(/bin/cat <(echo deep))").await;
  assert_eq!(out, "deep\n");
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
  assert_eq!(uncovered_shell_forks(), 0);
}

/// Wait for one forked child, at most ten seconds; kill it if it hangs.
fn wait_child(pid: libc::pid_t) -> libc::c_int {
  let deadline = Instant::now() + Duration::from_secs(10);
  let mut status = 0;
  loop {
    // SAFETY: waits only for the child this test forked.
    let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    if waited == pid {
      return status;
    }
    assert_eq!(waited, 0, "waitpid");
    if Instant::now() > deadline {
      // SAFETY: kill and reap only this test's stuck child.
      unsafe {
        libc::kill(pid, libc::SIGKILL);
        libc::waitpid(pid, &mut status, 0);
      }
      panic!("forked child timed out");
    }
    std::thread::sleep(Duration::from_millis(5));
  }
}

#[test]
fn a_real_fork_under_the_permit_resets_the_process_gate_in_the_child() {
  let _serial = serial();
  let reservation = ForkReservation::acquire("test fork").unwrap();
  let mut permit = reservation.lock_for_fork().unwrap();
  // SAFETY: the child calls only gate functions, then _exit.
  let pid = unsafe { libc::fork() };
  assert!(pid >= 0, "fork");
  if pid == 0 {
    // SAFETY: this is the child of the fork made while holding `permit`.
    unsafe { permit.reset_after_fork_in_child() };
    drop(permit);
    let code = match LiveIo::acquire("child payload") {
      Ok(token) => {
        let consistent = token.check_process().is_ok()
          && matches!(owned_io_gate::ensure_idle(), Err(GateError::LiveIo(_)));
        drop(token);
        if consistent { 0 } else { 2 }
      }
      Err(_) => 3,
    };
    // The copied reservation is inert here.
    drop(reservation);
    let code = if owned_io_gate::ensure_idle().is_ok() {
      code
    } else {
      4
    };
    // SAFETY: end the forked child without running the parent's code.
    unsafe { libc::_exit(code) };
  }
  drop(permit);
  // The child's new epoch did not release the parent's reservation.
  assert!(matches!(
    LiveIo::acquire("parent payload"),
    Err(GateError::Busy(_))
  ));
  let status = wait_child(pid);
  assert!(libc::WIFEXITED(status), "child signalled: {status}");
  assert_eq!(libc::WEXITSTATUS(status), 0, "the child's gate check");
  drop(reservation);
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
}

#[test]
fn concurrent_construction_and_forks_never_overlap() {
  let _serial = serial();
  const ROUNDS: usize = 40;
  // Bounded rendezvous: each round starts both sides together and ends when
  // the owner has released.
  let (start, start_rx) = mpsc::sync_channel::<()>(1);
  let (done, done_rx) = mpsc::sync_channel::<()>(1);
  let owner = std::thread::spawn(move || {
    let mut owned = 0;
    for round in 0..ROUNDS {
      if start_rx.recv_timeout(Duration::from_secs(20)).is_err() {
        break;
      }
      // Sweep the start, so either side reaches the gate first.
      std::thread::sleep(Duration::from_micros(125 * round as u64));
      if let Ok(token) = LiveIo::acquire("racing owner") {
        OWNER_HOLDS.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_micros(300));
        OWNER_HOLDS.store(false, Ordering::SeqCst);
        drop(token);
        owned += 1;
      }
      let _ = done.send(());
    }
    owned
  });
  let runtime = runtime();
  let mut f = Fixture::new();
  let (mut forked, mut refused) = (0, 0);
  for _ in 0..ROUNDS {
    start.send(()).unwrap();
    // The child reports the owner's flag as it was at the fork.
    let (out, status) = runtime.block_on(f.run("/bin/cat <(fixture.flag)"));
    match (out.as_str(), status) {
      ("clean\n", 0) => forked += 1,
      ("", 1) => {
        let diagnostics = f.diagnostics();
        assert!(diagnostics.contains("racing owner"), "{diagnostics}");
        refused += 1;
      }
      round => panic!("a child inherited live owned authority or failed: {round:?}"),
    }
    let _ = f.diagnostics();
    done_rx
      .recv_timeout(Duration::from_secs(20))
      .expect("the owner finished its round");
  }
  let owned = owner.join().unwrap();
  assert_eq!(forked + refused, ROUNDS);
  assert!(
    forked > 0,
    "no round forked (owned {owned}, refused {refused})"
  );
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
  assert_eq!(uncovered_shell_forks(), 0);
}

#[tokio::test]
async fn every_fork_seam_runs_under_a_command_unit_reservation() {
  let _serial = serial();
  let dir = TempDir::new("seams");
  let out = q(&dir.file("out", ""));
  let mut f = Fixture::new();
  let cases: Vec<(String, &str)> = vec![
    ("/bin/cat <(echo words)".into(), "words\n"),
    (
      format!("echo target > >(/bin/cat > {out}); wait; /bin/cat {out}"),
      "target\n",
    ),
    (
      "X=$(/bin/cat <(echo prefix)) /bin/sh -c 'echo $X'".into(),
      "prefix\n",
    ),
    (
      "x=$(/bin/cat <(echo assigned)); echo $x".into(),
      "assigned\n",
    ),
    (
      "echo ${owned_io_unset:-$(/bin/cat <(echo default))}".into(),
      "default\n",
    ),
    (
      "echo \"$(/bin/cat <(echo substituted))\"".into(),
      "substituted\n",
    ),
    (
      format!("/bin/echo simple-job > >(/bin/cat > {out}) & wait; /bin/cat {out}"),
      "simple-job\n",
    ),
    // A job's word substitution forks under the job's reservation (its
    // program cannot read it: the descriptor limitation noted above).
    ("/bin/sh -c : <(:) & wait".into(), ""),
    (
      format!("{{ echo compound-job; }} > {out} & wait; /bin/cat {out}"),
      "compound-job\n",
    ),
    (
      format!("echo $( {{ echo inner-job > {out}; }} & wait ); /bin/cat {out}"),
      "\ninner-job\n",
    ),
    (
      "for w in $(/bin/cat <(echo a b)); do echo $w; done".into(),
      "a\nb\n",
    ),
    (
      "case $(/bin/cat <(echo yes)) in yes) echo matched;; esac".into(),
      "matched\n",
    ),
    (
      "(( $(/bin/cat <(echo 1)) )) && echo arithmetic".into(),
      "arithmetic\n",
    ),
    (
      "[[ $(/bin/cat <(echo a)) == a ]] && echo condition".into(),
      "condition\n",
    ),
    (
      "arr=( $(/bin/cat <(echo x y)) ); echo ${arr[1]}".into(),
      "y\n",
    ),
    ("arr[$(/bin/cat <(echo 0))]=z; echo ${arr[0]}".into(), "z\n"),
    (
      format!("/bin/echo piped > >(/bin/cat > {out}) | /bin/cat; wait; /bin/cat {out}"),
      "piped\n",
    ),
    // An external pipeline stage's word substitution forks under the stage's
    // reservation (the stage takes its descriptors before word expansion,
    // an existing limitation, so its program cannot read it).
    ("/bin/sh -c : <(:) | /bin/cat".into(), ""),
    (
      "/bin/cat <<EOF\n$(/bin/cat <(echo heredoc))\nEOF".into(),
      "heredoc\n",
    ),
    (
      "exec 3< <(echo exec); read -r v <&3; exec 3<&-; echo $v".into(),
      "exec\n",
    ),
    (
      "while read -r l; do echo $l; done < <(echo loop)".into(),
      "loop\n",
    ),
    ("eval '/bin/cat <(echo evaluated)'".into(), "evaluated\n"),
    (
      "fn() { /bin/cat <(echo function); }; fn".into(),
      "function\n",
    ),
    ("( /bin/cat <(echo subshell) )".into(), "subshell\n"),
    ("cmd=/bin/cat; $cmd <(echo computed)".into(), "computed\n"),
    (
      "set -x; PS4='$(/bin/cat <(echo +)) '; echo traced; set +x".into(),
      "traced\n",
    ),
    (
      "set -x; traced=( $(/bin/cat <(echo t)) ); set +x; echo ${traced[0]}".into(),
      "t\n",
    ),
    (
      "trap '/bin/cat <(echo trapped)' EXIT; echo body".into(),
      "body\ntrapped\n",
    ),
  ];
  for (source, expected) in cases {
    let (stdout, status) = f.run(&source).await;
    assert_eq!(
      (stdout.as_str(), status),
      (expected, 0),
      "{source}: {}",
      f.diagnostics()
    );
    let _ = f.diagnostics();
    assert_eq!(
      owned_io_gate::ensure_idle(),
      Ok(()),
      "{source}: a reservation outlived its command"
    );
  }
  // `select` words: the menu shows the expanded word. (This host's select
  // does not read the here-string; it ends at end of input.)
  f.run("select s in $(/bin/cat <(echo pick)); do break; done <<< 1")
    .await;
  let menu = f.diagnostics();
  assert!(menu.contains("1) pick"), "{menu}");
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
  assert_eq!(uncovered_shell_forks(), 0);
}

#[tokio::test]
async fn replays_and_failures_release_exactly_their_reservations() {
  let _serial = serial();
  let mut f = Fixture::new();
  let missing = "/nonexistent-owned-io-fork-dir/out";
  // A redirected command whose preparation fails after it reserved.
  let (_, status) = f.run(&format!("/bin/cat <(echo x) > {missing}")).await;
  assert_eq!(status, 1);
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
  // A compound job whose redirection fails after admission.
  let error = f.fails(&format!("{{ echo x; }} > {missing} &")).await;
  assert!(!error.contains("owned I/O"), "{error}");
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
  // An expansion error after this command's process substitution forked.
  let _ = tokio::time::timeout(
    Duration::from_secs(20),
    f.host
      .capture_shell_source("/bin/cat <(:) ${owned_io_unset?gone}"),
  )
  .await
  .expect("bounded");
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
  // An admission replay starts nothing and ends its reservation.
  f.programs.replay.set(true);
  let admissions = f.programs.admissions.get();
  let (_, status) = f.run("{ echo replayed; } &").await;
  assert_eq!(status, 0);
  assert_eq!(f.programs.admissions.get(), admissions + 1);
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
  let _ = f.diagnostics();
  assert_eq!(uncovered_shell_forks(), 0);
}
