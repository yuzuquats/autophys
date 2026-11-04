//! The jobs rules, each stated against GNU bash 5.3's observed behaviour.
//! Jobs are external programs where the rule allows: a compound job forks
//! this multi-threaded test process, and a fork taken while another test
//! holds std's stdout lock leaves the child stuck on it, so only the rules
//! about forked jobs fork.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use serde_json::{Value as JsonValue, json};

use super::super::interp::{AsyncCommandFut, ExternalCommands, ExternalLookup, LispHost};
use super::*;

/// Runs the host's own `/bin` and `/usr/bin` programs; as a [`JobHost`] it
/// either keeps executions local or plays a session that replays one slot.
#[derive(Default)]
struct Programs {
  session: Option<Session>,
  undeclared: bool,
  starts: Cell<usize>,
  /// The viewer's Ctrl-Z arrives this long after `fg` starts waiting.
  stop_after: Option<std::time::Duration>,
}

#[derive(Default)]
struct Session {
  /// The one durable slot every admission maps to (a unit re-run).
  slot: Rc<RefCell<Option<(String, u32, JobOutcomeFuture)>>>,
  records: Rc<RefCell<Vec<String>>>,
  output: Arc<Mutex<Vec<u8>>>,
  admissions: Cell<u32>,
}

fn program(name: &str) -> Option<std::path::PathBuf> {
  if name.contains('/') {
    return Some(name.into()).filter(|path: &std::path::PathBuf| path.is_file());
  }
  ["/bin", "/usr/bin"]
    .iter()
    .map(|dir| std::path::Path::new(dir).join(name))
    .find(|path| path.is_file())
}

impl ExternalCommands for Programs {
  fn lookup(&self, head: &str) -> ExternalLookup {
    if let Some(path) = program(head).filter(|_| self.undeclared) {
      ExternalLookup::Undeclared(path.display().to_string())
    } else if program(head).is_some() {
      ExternalLookup::Runs
    } else {
      ExternalLookup::NotFound
    }
  }

  fn run(&self, _argv: Vec<String>) -> AsyncCommandFut {
    Box::pin(async { Ok(JsonValue::Null) })
  }

  fn suggest(&self, _typed: &str) -> Option<String> {
    None
  }

  fn run_pipeline_with_io(
    &self,
    argv: Vec<Vec<String>>,
    input: Option<Vec<u8>>,
    capture: bool,
    io: Vec<Option<ShellIo>>,
  ) -> super::super::PipelineFuture {
    let programs = argv
      .into_iter()
      .map(|argv| (program(&argv[0]).unwrap_or_default(), argv))
      .collect();
    Box::pin(super::super::run_process_pipeline_with_io(
      programs, input, capture, None, None, io,
    ))
  }

  fn start_background(
    &self,
    argv: Vec<String>,
    io: Option<ShellIo>,
    capture: bool,
  ) -> crate::Result<ShellJob> {
    self.starts.set(self.starts.get() + 1);
    let path = program(&argv[0]).ok_or_else(|| crate::Error::ProcessStart {
      status: 127,
      detail: format!("{}: command not found", argv[0]),
    })?;
    super::super::start_process_background(path, argv, io, capture, None)
  }
}

struct Slot {
  execution: String,
  durable: Rc<RefCell<Option<(String, u32, JobOutcomeFuture)>>>,
  records: Rc<RefCell<Vec<String>>>,
  output: Arc<Mutex<Vec<u8>>>,
}

impl JobSlot for Slot {
  fn execution(&self) -> String {
    self.execution.clone()
  }
  fn output(&self) -> Option<BackgroundOutput> {
    let output = self.output.clone();
    Some(Arc::new(move |bytes, _stderr| {
      output.lock().unwrap().extend_from_slice(bytes)
    }))
  }
  fn started(self: Box<Self>, pid: u32, settled: JobOutcomeFuture) {
    self.records.borrow_mut().push("running".into());
    *self.durable.borrow_mut() = Some((self.execution.clone(), pid, settled));
  }
  fn failed(self: Box<Self>, error: &str) {
    self
      .records
      .borrow_mut()
      .push(format!("host_failed: {error}"));
  }
}

impl JobHost for Programs {
  fn foreground_stop(&self) -> Option<futures::future::LocalBoxFuture<'static, ()>> {
    self
      .stop_after
      .map(|after| async move { tokio::time::sleep(after).await }.boxed_local())
  }

  fn admit(&self, plan: &JobPlan) -> Option<JobAdmission> {
    let session = self.session.as_ref()?;
    session.admissions.set(session.admissions.get() + 1);
    if let Some((execution, pid, settled)) = session.slot.borrow().clone() {
      return Some(JobAdmission::Replayed {
        execution,
        pid,
        settled,
      });
    }
    session
      .records
      .borrow_mut()
      .push(format!("starting: {}", plan.command));
    Some(JobAdmission::Fresh(Box::new(Slot {
      execution: "session/7.0".into(),
      durable: session.slot.clone(),
      records: session.records.clone(),
      output: session.output.clone(),
    })))
  }
}

fn host_with(programs: Programs) -> (LispHost, Rc<Programs>) {
  let mut host = LispHost::new();
  let programs = Rc::new(programs);
  host.set_external_commands(programs.clone());
  host.set_job_host(programs.clone());
  // Plain names reach the host's utilities, as the tsh prelude declares them.
  for name in ["sleep", "sh", "cat"] {
    host.register_shell_alias(name, &format!("test.{name}"));
  }
  host.collect_shell_diagnostics();
  (host, programs)
}

fn host() -> LispHost {
  host_with(Programs::default()).0
}

async fn run(host: &mut LispHost, source: &str) -> String {
  let out = host.capture_shell_source(source).await.unwrap();
  String::from_utf8(out.stdout).unwrap()
}

#[tokio::test]
async fn undeclared_background_program_reports_policy_without_spawning() {
  let (mut host, programs) = host_with(Programs {
    undeclared: true,
    ..Default::default()
  });
  let error = host.capture_shell_source("/bin/sh -c 'exit 0' &").await.unwrap_err();
  let message = error.to_string();
  assert!(message.contains("external execution is not declared"), "{message}");
  assert!(!message.contains("stateful in-process"), "{message}");
  assert_eq!(programs.starts.get(), 0, "policy refusal cannot start a child");
  assert_eq!(host.eval_to_json("(std.jobs.last)").unwrap(), json!(""));
}

#[tokio::test]
async fn background_builtins_keep_the_unsupported_diagnostic_when_external_is_undeclared() {
  for command in ["printf hello &", "pwd &"] {
    let (mut host, programs) = host_with(Programs {
      undeclared: true,
      ..Default::default()
    });
    let error = host.capture_shell_source(command).await.unwrap_err();
    let message = error.to_string();
    assert!(message.contains("stateful in-process"), "{command}: {message}");
    assert!(!message.contains("external execution is not declared"), "{command}: {message}");
    assert_eq!(programs.starts.get(), 0, "{command}: builtin refusal cannot start a child");
    assert_eq!(host.eval_to_json("(std.jobs.last)").unwrap(), json!(""));
  }
}

#[test]
fn the_state_machine_has_exactly_the_documented_edges() {
  use ExecState::*;
  let edges = [
    (Submitted, WaitingApproval),
    (Submitted, Starting),
    (WaitingApproval, Starting),
    (WaitingApproval, Denied),
    (Starting, Running),
    (Starting, HostFailed),
    (Running, Stopped),
    (Stopped, Running),
    (Running, Cancelling),
    (Stopped, Cancelling),
    (Cancelling, Cancelled),
    (Running, Succeeded),
    (Running, Failed),
  ];
  for from in ExecState::ALL {
    for to in ExecState::ALL {
      assert_eq!(
        from.allows(to),
        edges.contains(&(from, to)),
        "{from:?} -> {to:?}"
      );
    }
    assert_eq!(ExecState::named(from.name()), Some(from));
    if from.is_settled() {
      assert!(
        ExecState::ALL.iter().all(|to| !from.allows(*to)),
        "{from:?} is final"
      );
    }
  }
}

#[test]
fn replaying_a_committed_transition_is_idempotent_and_an_impossible_one_conflicts() {
  assert_eq!(
    ExecState::Running.advance(ExecState::Running),
    Ok(Advance::Replayed)
  );
  assert_eq!(
    ExecState::Running.advance(ExecState::Succeeded),
    Ok(Advance::Moved)
  );
  assert_eq!(
    ExecState::Succeeded.advance(ExecState::Running),
    Err(TransitionConflict {
      from: ExecState::Succeeded,
      to: ExecState::Running
    })
  );
}

#[test]
fn records_fold_back_to_the_same_execution_and_outcome() {
  let field = |key: &str, value: JsonValue| {
    let mut fields = serde_json::Map::new();
    fields.insert(key.into(), value);
    fields
  };
  let records = vec![
    lifecycle_record(
      "s/4.0",
      None,
      ExecState::Submitted,
      field("command", json!("sleep 1")),
    ),
    lifecycle_record(
      "s/4.0",
      Some(ExecState::Submitted),
      ExecState::Starting,
      Default::default(),
    ),
    lifecycle_record(
      "s/4.0",
      Some(ExecState::Starting),
      ExecState::Running,
      field("pid", json!(42)),
    ),
    // A replayed unit re-commits running: idempotent.
    lifecycle_record(
      "s/4.0",
      Some(ExecState::Starting),
      ExecState::Running,
      field("pid", json!(42)),
    ),
    json!({"datatype": "term.mode/v1"}),
    lifecycle_record(
      "s/4.0",
      Some(ExecState::Running),
      ExecState::Failed,
      field("status", json!(3)),
    ),
    // Nothing leaves a settled state.
    lifecycle_record(
      "s/4.0",
      Some(ExecState::Failed),
      ExecState::Running,
      Default::default(),
    ),
    lifecycle_record("s/4.1", None, ExecState::Submitted, Default::default()),
  ];
  let folded = fold_lifecycle(&records);
  assert_eq!(folded.len(), 2);
  assert_eq!(folded[0].execution, "s/4.0");
  assert_eq!(folded[0].state, ExecState::Failed);
  assert_eq!(folded[0].fields["pid"], 42);
  assert_eq!(folded[0].fields["status"], 3);
  assert_eq!(folded[0].fields["command"], "sleep 1");
  assert_eq!(
    folded[0].conflicts,
    [TransitionConflict {
      from: ExecState::Failed,
      to: ExecState::Running
    }]
  );
  assert_eq!(folded[1].state, ExecState::Submitted);
}

/// bash: `wait PID` and `wait %N` return that job's status, a bare `wait`
/// returns 0, and a reaped pid can be waited for again.
#[tokio::test]
async fn wait_returns_each_jobs_status() {
  let mut h = host();
  assert_eq!(
    run(
      &mut h,
      "sh -c 'exit 3' & p=$!; sh -c 'exit 5' & wait $p; echo $?; wait %2; echo $?; wait $p; echo $?; wait; echo $?"
    )
    .await,
    "3\n5\n3\n0\n"
  );
}

/// bash: `wait -n` returns the next job to finish (one that already
/// finished first) and 127 when there is none.
#[tokio::test]
async fn wait_n_returns_the_next_finished_job() {
  let mut h = host();
  assert_eq!(
    run(
      &mut h,
      "sh -c 'sleep 0.3; exit 4' & sh -c 'exit 7' & sleep 0.1; wait -n -p who; echo $? ${who:+set}; wait -n; echo $?; wait -n; echo $?"
    )
    .await,
    "7 set\n4\n127\n"
  );
}

/// bash: `wait: pid N is not a child of this shell` and `wait: %3: no such
/// job` are 127; a word that is neither is 1; a missing `-p` operand is 2.
#[tokio::test]
async fn wait_reports_unknown_ids_as_bash_does() {
  let mut h = host();
  assert_eq!(
    run(
      &mut h,
      "wait 999999; echo $?; wait %3; echo $?; wait abc; echo $?; wait -p; echo $?"
    )
    .await,
    "127\n127\n1\n2\n"
  );
  assert_eq!(
    h.take_shell_diagnostics(),
    [
      "tsh: line 1: wait: pid 999999 is not a child of this shell",
      "tsh: line 1: wait: %3: no such job",
      "tsh: line 1: wait: `abc': not a pid or valid job spec",
      "tsh: line 1: wait: -p: option requires an argument",
      "wait: usage: wait [-fn] [-p var] [id ...]",
    ]
  );
}

/// bash: `jobs` prints `[N]±  STATE<27 columns>COMMAND &`, with `+` on the
/// latest job and `-` on the one before.
#[tokio::test]
async fn jobs_prints_bashs_table() {
  let mut h = host();
  let text = run(
    &mut h,
    "sleep 1 & sleep 2 & jobs; jobs -p | /usr/bin/wc -l; kill %1 %2; wait",
  )
  .await;
  assert_eq!(
    text.lines().map(str::trim_start).collect::<Vec<_>>(),
    [
      "[1]-  Running                    sleep 1 &",
      "[2]+  Running                    sleep 2 &",
      "2"
    ]
  );
}

/// bash: a finished job shows once as `Done` (no `&`), then leaves the table;
/// a failing one shows `Exit N`, a signalled one the signal's description.
/// A job started when no older job runs has no `-` job beside it.
#[tokio::test]
async fn jobs_reports_a_finished_job_once() {
  let mut h = host();
  let text = run(&mut h, "true &\nsleep 0.1\nsh -c 'exit 3' &\nsleep 0.1; sleep 5 & sleep 0.1; kill %3; sleep 0.2; jobs; echo after; jobs").await;
  let terminated = signal_description(libc::SIGTERM);
  assert_eq!(
    text,
    format!(
      "[1]   Done                       true\n[2]   Exit 3                     sh -c 'exit 3'\n[3]+  {terminated:<27}sleep 5\nafter\n"
    )
  );
}

/// bash: `%N`, `%+`/`%%`, `%-`, `%string` and `%?string` select jobs; an
/// ambiguous spec reports both lines bash does and the builtin returns 1.
#[tokio::test]
async fn job_specs_resolve_as_bash_does() {
  let mut h = host();
  let text = run(
    &mut h,
    "sleep 1 & sleep 2 & sleep 3 & jobs %+ %- %?2 %% %1; jobs %sleep; echo $?; kill %1 %2 %3; wait",
  )
  .await;
  assert_eq!(
    text.lines().collect::<Vec<_>>(),
    [
      "[3]+  Running                    sleep 3 &",
      "[2]-  Running                    sleep 2 &",
      "[2]-  Running                    sleep 2 &",
      "[3]+  Running                    sleep 3 &",
      "[1]   Running                    sleep 1 &",
      "1"
    ]
  );
  assert_eq!(
    h.take_shell_diagnostics(),
    [
      "tsh: line 1: jobs: sleep: ambiguous job spec",
      "tsh: line 1: jobs: %sleep: no such job"
    ]
  );
}

/// bash: `kill %N` signals the job (wait then reports 128+15); an unknown
/// spec is `kill: %9: no such job`, status 1 unless another target was hit.
#[tokio::test]
async fn kill_signals_job_specs() {
  let mut h = host();
  assert_eq!(
    run(
      &mut h,
      "sleep 5 & kill %1; echo k=$?; wait %1; echo w=$?; kill %9; echo k=$?; sleep 5 & kill -s TERM %1 %9; echo k=$?; wait; kill -s FOO %1; echo k=$?"
    )
    .await,
    "k=0\nw=143\nk=1\nk=0\nk=1\n"
  );
  assert_eq!(
    h.take_shell_diagnostics(),
    [
      "tsh: line 1: kill: %9: no such job",
      "tsh: line 1: kill: %9: no such job",
      "tsh: line 1: kill: FOO: invalid signal specification",
    ]
  );
}

/// bash: `disown` drops the current job from the table (no error), the
/// process is still waitable by pid, and a dropped spec is no such job.
#[tokio::test]
async fn disown_leaves_the_process_waitable_by_pid() {
  let mut h = host();
  assert_eq!(
    run(
      &mut h,
      "sleep 0.2 & p=$!; disown; jobs; echo d=$?; wait $p; echo w=$?; disown %1; echo d=$?; disown; echo d=$?"
    )
    .await,
    "d=0\nw=0\nd=1\nd=1\n"
  );
  assert_eq!(
    h.take_shell_diagnostics(),
    [
      "tsh: line 1: disown: %1: no such job",
      "tsh: line 1: disown: current: no such job"
    ]
  );
}

/// bash: an asynchronous command's inherited stdin is /dev/null, for a
/// compound job and an external alike; an explicit redirect is kept.
#[tokio::test]
async fn an_async_commands_stdin_is_dev_null() {
  let mut h = host();
  h.replace_shell_stdin(Some(b"data\n".to_vec()));
  assert_eq!(
    run(
      &mut h,
      "{ read x; echo \"got[$x]\"; } & wait; cat & wait; echo end"
    )
    .await,
    "got[]\nend\n"
  );
  assert_eq!(
    run(&mut h, "echo kept | { cat <&0 & wait; }").await,
    "kept\n"
  );
}

/// bash: without job control an asynchronous command ignores SIGINT and
/// SIGQUIT, and its children inherit that (`trap` in `sh` shows it).
#[tokio::test]
async fn an_async_command_ignores_sigint_and_sigquit() {
  let mut h = host();
  // A non-interactive sh cannot catch a signal ignored on entry: the
  // signals it sends itself are discarded and it reaches its echo.
  for source in [
    "sh -c 'kill -INT $$; kill -QUIT $$; echo survived' & wait",
    "{ sh -c 'kill -INT $$; kill -QUIT $$; echo survived'; } & wait",
  ] {
    assert_eq!(run(&mut h, source).await, "survived\n", "{source}");
  }
}

/// The typed doors return `job/v1` values; Lisp names jobs by value,
/// execution id or pid, and only `std.jobs.resolve` reads a `%` label.
#[tokio::test]
async fn std_jobs_return_job_values() {
  let mut h = host();
  run(&mut h, "sleep 5 & sh -c 'exit 4' &").await;
  let list = h.eval_to_json("(std.jobs.list)").unwrap();
  assert_eq!(list.as_array().unwrap().len(), 2, "{list}");
  assert_eq!(list[0]["datatype"], "job/v1");
  assert_eq!(list[0]["label"], "%1");
  assert_eq!(list[0]["current"], "-");
  assert_eq!(list[0]["command"], "sleep 5");
  assert_eq!(list[0]["state"], "running");
  let resolved = h.eval_to_json("(std.jobs.resolve \"%2\")").unwrap();
  assert_eq!(resolved["label"], "%2");
  assert_eq!(
    h.eval_to_json("(std.jobs.show (std.jobs.last))").unwrap()["pid"],
    resolved["pid"]
  );
  let execution = resolved["execution"].as_str().unwrap().to_string();
  let waited = h
    .eval_to_json(&format!("(std.jobs.wait \"{execution}\")"))
    .unwrap();
  assert_eq!(waited["state"], "failed");
  assert_eq!(waited["outcome"]["status"], 4);
  assert_eq!(
    waited["label"],
    JsonValue::Null,
    "a waited job leaves the table"
  );
  let error = h
    .eval_to_json("(std.jobs.show \"%1\")")
    .unwrap_err()
    .to_string();
  assert!(error.contains("std.jobs.resolve"), "{error}");
  let signalled = h
    .eval_to_json("(std.jobs.signal (std.jobs.resolve \"%1\") \"KILL\")")
    .unwrap();
  assert_eq!(signalled["label"], "%1");
  let waited = h.eval_to_json("(std.jobs.wait-any)").unwrap();
  assert_eq!(waited["outcome"]["signal"], libc::SIGKILL);
  assert_eq!(h.eval_to_json("(std.jobs.list)").unwrap(), json!([]));
  let spawned = h.eval_to_json("(std.jobs.spawn \"sleep\" \"0\")").unwrap();
  assert_eq!(spawned["command"], "sleep 0");
  // As a shell line it awaits rather than blocks, and returns the job.
  run(&mut h, "std.jobs.wait-any").await;
  assert_eq!(h.shell_status(), 0);
  assert_eq!(
    h.eval_to_json("(std.jobs.show (std.jobs.last))").unwrap()["state"],
    "succeeded"
  );
}

/// argv.md I17: `$!` is `(std.jobs.last)`, bash's parameter as a word: the
/// pid of the most recent background job, empty before any, and kept after
/// the job is waited for. `cmd &` is `(std.jobs.spawn STAGE)`: the stage
/// starts as a job, status 0 at once, and the job tools see it.
#[tokio::test]
async fn std_jobs_last_is_bash_last_pid_and_spawn_is_background() {
  let mut h = host();
  assert_eq!(h.eval_to_json("(std.jobs.last)").unwrap(), json!(""));
  assert_eq!(run(&mut h, "echo \"[$!]\"").await, "[]\n");
  assert_eq!(
    run(&mut h, "sh -c 'exit 4' & pid=$!; wait $pid; echo rc=$? same=$([ \"$pid\" = \"$!\" ] && echo y)").await,
    "rc=4 same=y\n"
  );
  let pid = last_pid(&h);
  assert!(pid > 0);
  // Kept after `wait` reaped the job, as bash keeps `$!`.
  assert_eq!(h.eval_to_json("(std.jobs.last)").unwrap(), json!(pid.to_string()));
  // The compiled spelling is a fixed point (argv.md I6).
  assert_eq!(
    h.eval_lisp_host_line("(std.jobs.spawn (std.sh.cmd \"sleep\" \"30\"))").await.unwrap(),
    JsonValue::Null
  );
  assert_eq!(h.shell_status(), 0);
  assert_ne!(last_pid(&h), pid);
  assert_eq!(
    run(&mut h, "jobs; kill %1; wait %1; echo $?").await,
    "[1]+  Running                    sleep 30 &\n143\n"
  );
  // A job's command prints a background member as bash does (the killed
  // jobs' own children hold the capture open until their short sleeps end).
  assert_eq!(
    run(&mut h, "( sleep 2 & sleep 2 ) & { sleep 2 & sleep 2; } & { sleep 2 & } & jobs; kill %1 %2 %3; wait").await,
    "[1]   Running                    ( sleep 2 & sleep 2 ) &\n[2]-  Running                    { sleep 2 & sleep 2; } &\n[3]+  Running                    { sleep 2 & } &\n"
  );
  // Program words keep the typed command, which returns the job.
  let spawned = h.eval_to_json("(std.jobs.spawn \"sleep\" \"0\")").unwrap();
  assert_eq!(spawned["datatype"], "job/v1");
  assert_eq!(h.eval_to_json("(std.jobs.last)").unwrap(), json!(spawned["pid"].to_string()));
  run(&mut h, "wait").await;
}

/// `set -u`: `$!` before any job is an unbound variable, as in bash.
#[tokio::test]
async fn std_jobs_last_under_nounset_is_unbound_before_a_job() {
  let mut h = host();
  let error = h
    .capture_shell_source("set -u; echo \"[$!]\"; echo after")
    .await
    .unwrap_err();
  assert!(error.to_string().contains("$!: unbound variable"), "{error}");
}

/// A session admits each submission: a replayed unit gets its execution
/// back rather than a second child, and the job's output reaches the session.
#[tokio::test]
async fn a_session_replay_reuses_the_execution() {
  let (mut h, programs) = host_with(Programs {
    session: Some(Session::default()),
    ..Default::default()
  });
  let options = || super::super::RunOptions {
    on_error: super::super::OnError::Bash,
    bash: Some(true),
    ..Default::default()
  };
  let scripts = crate::Scripts::new(());
  let subcommands = std::collections::HashMap::new();
  for _ in 0..2 {
    super::super::run_source_on_host(
      &mut h,
      "sh -c 'echo out; echo err >&2' &",
      &scripts,
      &subcommands,
      &[],
      options(),
    )
    .await
    .unwrap();
  }
  let session = programs.session.as_ref().unwrap();
  assert_eq!(session.admissions.get(), 2);
  let records = session.records.borrow().clone();
  assert_eq!(records.len(), 2, "{records:?}");
  assert_eq!(records[0], "starting: sh -c 'echo out; echo err >&2'");
  assert_eq!(records[1], "running");
  let jobs = h.eval_to_json("(std.jobs.list)").unwrap();
  assert_eq!(jobs.as_array().unwrap().len(), 1, "{jobs}");
  assert_eq!(jobs[0]["execution"], "session/7.0");
  super::super::run_source_on_host(&mut h, "wait", &scripts, &subcommands, &[], options())
    .await
    .unwrap();
  // The reader threads finish after the child exits; give them a moment.
  for _ in 0..50 {
    if session.output.lock().unwrap().len() >= 8 {
      break;
    }
    std::thread::sleep(std::time::Duration::from_millis(10));
  }
  let output = String::from_utf8(session.output.lock().unwrap().clone()).unwrap();
  let mut lines: Vec<_> = output.lines().collect();
  lines.sort();
  assert_eq!(lines, ["err", "out"]);
}

/// bash: a `( … )` subshell starts with an empty jobs table, while a
/// pipeline stage and `$( … )` still list the shell's jobs.
#[tokio::test]
async fn a_subshell_has_no_jobs_but_a_pipeline_stage_lists_them() {
  let mut h = host();
  assert_eq!(
    run(&mut h, "sleep 1 &\n(jobs; wait; echo sub $?); jobs -p | /usr/bin/wc -l | /usr/bin/tr -d ' '; echo $(jobs); kill %1; wait").await,
    "sub 0\n1\n[1]+ Running sleep 1 &\n"
  );
}

/// bash's `+`/`-`: a new job is `+` and the newest older job still running
/// is `-`; when either leaves the table the newest running job is `+`.
#[tokio::test]
async fn current_and_previous_follow_bash() {
  let mut h = host();
  let text = run(
    &mut h,
    "sleep 1 & sleep 1 & sleep 1 & kill %3; wait %3; jobs; kill %2; wait %2; jobs; sleep 1 & jobs; kill %1 %2; wait",
  )
  .await;
  assert_eq!(
    text.lines().collect::<Vec<_>>(),
    [
      "[1]-  Running                    sleep 1 &",
      "[2]+  Running                    sleep 1 &",
      "[1]+  Running                    sleep 1 &",
      "[1]-  Running                    sleep 1 &",
      "[2]+  Running                    sleep 1 &",
    ]
  );
}

// ── job control at the prompt (j2) ───────────────────────────────────────────

/// A host with job control on, as a prompt line has it.
fn controlled_host(stop_after: Option<std::time::Duration>) -> LispHost {
  let (mut host, _) = host_with(Programs {
    stop_after,
    ..Default::default()
  });
  host.set_job_control(true);
  host
}

/// The shell's diagnostics without the `[N] PID` line a prompt job announces
/// (its pid is not stable).
fn notes(host: &mut LispHost) -> Vec<String> {
  host
    .take_shell_diagnostics()
    .into_iter()
    .filter(|line| {
      let announced = line
        .strip_prefix('[')
        .and_then(|rest| rest.split_once("] "))
        .is_some_and(|(number, pid)| {
          number.chars().all(|c| c.is_ascii_digit()) && pid.chars().all(|c| c.is_ascii_digit())
        });
      !announced
    })
    .collect()
}

/// The pid of the job the last `cmd &` started.
fn last_pid(host: &LispHost) -> u32 {
  host.shell_compound.commands.last_pid.get()
}

/// Wait (briefly) for the reaper to see `pid` stopped, then fold it in.
fn await_stopped(host: &LispHost, pid: u32) {
  for _ in 0..400 {
    if control::stopped_signal(pid).is_some() {
      break;
    }
    std::thread::sleep(std::time::Duration::from_millis(5));
  }
  host.shell_compound.commands.jobs.poll();
  assert!(
    control::stopped_signal(pid).is_some(),
    "pid {pid} never reported stopped"
  );
}

/// bash scripts and `-c` run with monitor off: `fg` and `bg` answer
/// "no job control" with status 1, and the job stays a plain child.
#[tokio::test]
async fn fg_and_bg_answer_no_job_control_without_a_prompt() {
  let mut h = host();
  assert_eq!(
    run(&mut h, "sleep 5 & fg; echo $?; bg; echo $?; kill %1; wait").await,
    "1\n1\n"
  );
  assert_eq!(
    notes(&mut h),
    [
      "tsh: line 1: fg: no job control",
      "tsh: line 1: bg: no job control"
    ]
  );
}

/// bash (interactive): `cmd &` prints `[1] PID` on stderr.
#[tokio::test]
async fn a_prompt_job_announces_itself() {
  let mut h = controlled_host(None);
  run(&mut h, "sleep 30 &").await;
  let pid = last_pid(&h);
  assert_eq!(h.take_shell_diagnostics(), [format!("[1] {pid}")]);
  run(&mut h, "kill -KILL %1; wait").await;
  let mut h = host();
  run(&mut h, "sleep 30 &").await;
  assert!(
    h.take_shell_diagnostics().is_empty(),
    "a script announces nothing"
  );
  run(&mut h, "kill -KILL %1; wait").await;
}

/// bash (interactive): a job started with `&` leads its own process group;
/// without job control it shares the shell's.
#[tokio::test]
async fn a_prompt_job_leads_its_own_process_group() {
  let mut h = controlled_host(None);
  run(&mut h, "sleep 30 &").await;
  let pid = last_pid(&h);
  // SAFETY: getpgid only reads process attributes.
  let (job, shell) = unsafe { (libc::getpgid(pid as i32), libc::getpgid(0)) };
  assert_eq!(job as u32, pid, "the job leads its group");
  assert_ne!(job, shell);
  run(&mut h, "kill -KILL %1; wait").await;

  let mut h = host();
  run(&mut h, "sleep 30 &").await;
  let pid = last_pid(&h);
  assert_eq!(unsafe { libc::getpgid(pid as i32) }, unsafe {
    libc::getpgid(0)
  });
  run(&mut h, "kill -KILL %1; wait").await;
}

/// bash: a stopped job is `Stopped` in `jobs` (no `&`), `jobs -s` lists it
/// and `jobs -r` does not; `bg` continues it and prints `[1]+ cmd &`; `bg`
/// on a running job says it already is in the background.
#[tokio::test]
async fn a_stopped_job_is_listed_and_continued_by_bg() {
  let mut h = controlled_host(None);
  run(&mut h, "sleep 30 &").await;
  let pid = last_pid(&h);
  run(&mut h, "kill -TSTP %1").await;
  await_stopped(&h, pid);
  assert_eq!(
    run(&mut h, "jobs; jobs -s; echo --; jobs -r; echo --").await,
    "[1]+  Stopped                    sleep 30\n\
     [1]+  Stopped                    sleep 30\n\
     --\n\
     --\n"
  );
  assert_eq!(
    h.eval_to_json("(std.jobs.list)").unwrap()[0]["state"],
    "stopped"
  );
  assert_eq!(
    run(&mut h, "bg; echo $?; jobs; bg; echo $?").await,
    "[1]+ sleep 30 &\n0\n[1]+  Running                    sleep 30 &\n0\n"
  );
  assert_eq!(
    notes(&mut h),
    ["tsh: line 1: bg: job 1 already in background"]
  );
  run(&mut h, "kill -KILL %1; wait").await;
}

/// bash: `fg` shows the job's command, waits for it, and the job's status is
/// the status; the job leaves the table. With no job it is `fg: current: no
/// such job` (1); a bad spec names itself.
#[tokio::test]
async fn fg_waits_for_the_job_and_returns_its_status() {
  let mut h = controlled_host(None);
  assert_eq!(
    run(
      &mut h,
      "sh -c 'sleep 0.3; exit 3' & fg; echo $?; jobs; fg; echo $?; fg %9; echo $?"
    )
    .await,
    "sh -c 'sleep 0.3; exit 3'\n3\n1\n1\n"
  );
  assert_eq!(
    notes(&mut h),
    [
      "tsh: line 1: fg: current: no such job",
      "tsh: line 1: fg: %9: no such job"
    ]
  );
}

/// bash: Ctrl-Z while a job is in the foreground stops it (SIGTSTP to its
/// group), `fg` returns 128+SIGTSTP and tells `[1]+  Stopped  cmd`; a second
/// `fg` continues the same process, which is stopped again the same way.
#[tokio::test]
async fn ctrl_z_stops_the_foreground_job_and_the_prompt_returns() {
  let mut h = controlled_host(Some(std::time::Duration::from_millis(150)));
  let stopped = format!("st={}", 128 + libc::SIGTSTP);
  assert_eq!(
    run(&mut h, "sleep 30 & fg; echo st=$?; jobs").await,
    format!("sleep 30\n{stopped}\n[1]+  Stopped                    sleep 30\n")
  );
  let pid = last_pid(&h);
  assert!(control::stopped_signal(pid).is_some());
  assert_eq!(notes(&mut h), ["[1]+  Stopped                    sleep 30"]);
  // The same process continues, and is stopped once more.
  assert_eq!(
    run(&mut h, "fg; echo st=$?").await,
    format!("sleep 30\n{stopped}\n")
  );
  assert_eq!(h.eval_to_json("(std.jobs.last)").unwrap(), json!(pid.to_string()));
  run(&mut h, "kill -KILL %1; wait").await;
}

/// bash: Ctrl-C while a job is in the foreground interrupts the job. Here the
/// wait for it is cancelled (the viewer's interrupt); the job gets SIGINT.
#[tokio::test]
async fn cancelling_fg_interrupts_the_job() {
  let mut h = controlled_host(None);
  let waited = tokio::time::timeout(
    std::time::Duration::from_millis(200),
    h.capture_shell_source("sleep 30 & fg"),
  )
  .await;
  assert!(waited.is_err(), "fg waits for the job");
  assert_eq!(run(&mut h, "wait %1; echo $?").await, "130\n");
}

/// The typed doors: `std.jobs.stop` stops a job, `std.jobs.resume`
/// continues it, and `std.jobs.foreground` is `fg` returning the job.
#[tokio::test]
async fn the_typed_doors_stop_resume_and_foreground_a_job() {
  let mut h = controlled_host(None);
  run(&mut h, "sleep 30 &").await;
  let pid = last_pid(&h);
  let stopped = h.eval_to_json("(std.jobs.stop (std.jobs.last))").unwrap();
  assert_eq!(stopped["state"], "stopped", "{stopped}");
  assert_eq!(stopped["stop_signal"], libc::SIGTSTP);
  let resumed = h.eval_to_json("(std.jobs.resume (std.jobs.last))").unwrap();
  assert_eq!(resumed["state"], "running", "{resumed}");
  let error = h
    .eval_to_json("(std.jobs.stop (std.jobs.last) \"NOPE\")")
    .unwrap_err();
  assert!(error.to_string().contains("invalid signal"), "{error}");
  // The Lisp door `std.jobs.foreground` blocks until the job ends.
  run(&mut h, "sleep 0.2 &").await;
  let ended = h
    .eval_to_json("(std.jobs.foreground (std.jobs.last))")
    .unwrap();
  assert_eq!(ended["state"], "succeeded", "{ended}");
  assert_eq!(
    ended["label"],
    JsonValue::Null,
    "a foreground job leaves the table"
  );
  // `std.jobs.foreground` as a shell line awaits like `fg`: a killed job ends it.
  run(&mut h, "kill -KILL %1").await;
  run(&mut h, &format!("std.jobs.foreground {pid}; echo $?")).await;
  assert_eq!(
    h.eval_to_json(&format!("(std.jobs.show {pid})")).unwrap()["state"],
    "failed"
  );
}

/// bash tells of each finished or stopped job once, before the next
/// prompt, in its `jobs` text, and a finished job then leaves the table.
#[tokio::test]
async fn job_notices_report_each_change_once() {
  let mut h = controlled_host(None);
  run(&mut h, "sh -c 'exit 2' & sleep 30 &").await;
  let sleeper = last_pid(&h);
  // Let the first job finish.
  run(&mut h, "wait %1; echo $?").await;
  h.shell_compound.commands.jobs.poll();
  run(&mut h, "sh -c 'exit 2' &").await;
  let pid = last_pid(&h);
  for _ in 0..400 {
    if h.shell_compound.commands.jobs.finished(pid) {
      break;
    }
    h.shell_compound.commands.jobs.poll();
    std::thread::sleep(std::time::Duration::from_millis(5));
  }
  run(&mut h, "kill -TSTP %2").await;
  await_stopped(&h, sleeper);
  let notices = h.job_notices();
  assert_eq!(notices.len(), 2, "{notices:?}");
  assert!(
    notices[0].contains("Stopped") && notices[0].contains("sleep 30"),
    "{notices:?}"
  );
  assert!(
    notices[1].contains("Exit 2") && notices[1].contains("sh -c 'exit 2'"),
    "{notices:?}"
  );
  assert!(h.job_notices().is_empty(), "each is told once");
  let listed = run(&mut h, "jobs").await;
  assert!(
    !listed.contains("Exit 2"),
    "a told job left the table: {listed}"
  );
  run(&mut h, "kill -KILL %2; wait").await;
}

/// bash without job control (a script, `-c`) never tells of a stop: `jobs`
/// still reads Running and `wait` still means until it exits. The typed
/// projection tells the truth, so a prompt component can show it.
#[tokio::test]
async fn a_script_never_reads_a_job_as_stopped() {
  let mut h = host();
  run(&mut h, "sleep 30 &").await;
  let pid = last_pid(&h);
  run(&mut h, "kill -STOP %1").await;
  for _ in 0..400 {
    if control::stopped_signal(pid).is_some() {
      break;
    }
    std::thread::sleep(std::time::Duration::from_millis(5));
  }
  assert_eq!(
    run(&mut h, "jobs; jobs -s; echo --").await,
    "[1]+  Running                    sleep 30 &\n--\n"
  );
  assert_eq!(
    h.eval_to_json("(std.jobs.list)").unwrap()[0]["state"],
    "stopped"
  );
  run(&mut h, "kill -KILL %1; wait").await;
}

/// The docs' example component (`docs/guide/jobs.md`): one line over the
/// typed projection, for a prompt, a scene or a status row. The text here is
/// the text there.
#[tokio::test]
async fn the_documented_jobs_line_component_reads_the_projection() {
  let mut h = controlled_host(None);
  h.eval_to_json(
    "(let jobs.line (lambda () (fold (lambda (line job) (concat line (if (empty? line) \"\" \" · \") (get job \"label\") \" \" (get job \"status_text\") \" \" (get job \"command\"))) \"\" (std.jobs.list))))",
  )
  .unwrap();
  assert_eq!(h.eval_to_json("(jobs.line)").unwrap(), json!(""));
  run(&mut h, "sleep 30 & sleep 31 &").await;
  let pid = last_pid(&h);
  assert_eq!(
    h.eval_to_json("(jobs.line)").unwrap(),
    json!("%1 Running sleep 30 · %2 Running sleep 31")
  );
  h.eval_to_json("(std.jobs.stop (std.jobs.last))").unwrap();
  assert_eq!(
    h.eval_to_json("(jobs.line)").unwrap(),
    json!("%1 Running sleep 30 · %2 Stopped sleep 31")
  );
  let _ = pid;
  run(&mut h, "kill -KILL %1 %2; wait").await;
}

/// A fork copies only the forking thread, so a lock another thread holds at
/// that instant is held in the child for good. std's stdout lock was one: the
/// child flushes stdout when it ends. The forking shell takes the locks first,
/// so the child never inherits one held. Here another thread takes and drops
/// the stdout lock as fast as it can while the shell forks thirty jobs; a
/// child that inherited it held would never end.
#[tokio::test]
async fn a_forked_job_never_inherits_a_held_stdout_lock() {
  let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
  let hammer = {
    let stop = stop.clone();
    std::thread::spawn(move || {
      while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        let stdout = std::io::stdout().lock();
        for _ in 0..2000 {
          std::hint::spin_loop();
        }
        drop(stdout);
        std::thread::yield_now();
      }
    })
  };
  let mut h = host();
  let out = tokio::time::timeout(
    std::time::Duration::from_secs(60),
    h.capture_shell_source(
      "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do { echo child; } & wait; done; echo done",
    ),
  )
  .await;
  stop.store(true, std::sync::atomic::Ordering::Relaxed);
  hammer.join().unwrap();
  let out = out.expect("every forked job ended").unwrap();
  assert!(
    String::from_utf8_lossy(&out.stdout).ends_with("done\n"),
    "{:?}",
    out.stdout
  );
}
