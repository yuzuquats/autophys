use super::super::interp::{AsyncCommandFut, ExternalCommands, ExternalLookup};
use super::*;

fn redirection_temp_path(name: &str) -> std::path::PathBuf {
  static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
  let counter = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
  std::env::temp_dir().join(format!("tento-04j-{name}-{}-{counter}", std::process::id()))
}

struct Programs;

impl ExternalCommands for Programs {
  fn lookup(&self, head: &str) -> ExternalLookup {
    if matches!(head, "false" | "true" | "exit-seven" | "noexec") {
      ExternalLookup::Runs
    } else {
      ExternalLookup::NotFound
    }
  }

  fn run(&self, argv: Vec<String>) -> AsyncCommandFut {
    Box::pin(async move {
      let status = match argv[0].as_str() {
        "false" => 1,
        "exit-seven" => 7,
        "noexec" => 126,
        _ => return Ok(JsonValue::Null),
      };
      Err(Error::ProcessExit {
        status: Some(status),
        signal: None,
        detail: format!("{} exited {status}", argv[0]),
      })
    })
  }

  fn suggest(&self, _typed: &str) -> Option<String> {
    None
  }
}

pub(super) fn host() -> LispHost {
  let mut host = LispHost::new();
  host.set_external_commands(Rc::new(Programs));
  host
}

pub(super) async fn bash(host: &mut LispHost, source: &str) -> Result<Option<JsonValue>, TshScriptError> {
  run_source_on_host(
    host,
    source,
    &Scripts::new(()),
    &HashMap::new(),
    &[],
    RunOptions {
      on_error: OnError::Bash,
      ..RunOptions::default()
    },
  )
  .await
}

#[tokio::test]
async fn bash_continues_after_false_and_records_last_status() {
  let mut host = host();
  assert_eq!(
    bash(&mut host, "false\n(std.sh.status)").await.unwrap(),
    Some(1.into())
  );
  assert_eq!(host.shell_status(), 1);
  assert_eq!(bash(&mut host, "false\ntrue").await.unwrap(), None);
  assert_eq!(host.shell_status(), 0);
  bash(&mut host, "exit-seven\n# trailer\n").await.unwrap();
  assert_eq!(host.shell_status(), 7);
}

#[tokio::test]
async fn bash_not_found_has_status_127_and_bash_diagnostic() {
  let mut host = host();
  bash(&mut host, "# header\nmissing").await.unwrap();
  assert_eq!(host.shell_status(), 127);
  assert_eq!(
    bash_command_diagnostic(
      2,
      &Error::CommandNotFound {
        name: "missing".into(),
        suggestion: Some("other".into()),
        available: vec!["other".into()],
      }
    ),
    Some("tsh: line 2: missing: command not found".into())
  );
  bash(&mut host, "missing\ntrue").await.unwrap();
  assert_eq!(host.shell_status(), 0);
}

#[tokio::test]
async fn bash_errexit_stops_with_child_status_and_plus_e_resumes() {
  let mut host = host();
  for option in ["set -e", "set -o errexit"] {
    let err = bash(&mut host, &format!("{option}\nexit-seven\n(let missed 1)"))
      .await
      .unwrap_err();
    assert_eq!(err.process_status(), Some(7));
    assert!(err.is_bash_status());
    assert_eq!(err.line, 2);
    assert!(host.eval_to_json("missed").is_err());
    assert_eq!(host.shell_status(), 7);
    bash(&mut host, "set +e\nfalse\ntrue").await.unwrap();
    assert_eq!(host.shell_status(), 0);
  }
  bash(&mut host, "set -e\nset +o errexit\nfalse\ntrue")
    .await
    .unwrap();
  assert_eq!(host.shell_status(), 0);
}

#[tokio::test]
async fn bash_lisp_error_and_unsupported_set_still_halt() {
  let mut host = host();
  for source in [
    "(missing)\n(let missed 1)",
    "set -a\n(let missed 1)",
    "set -o allexport\n(let missed 1)",
  ] {
    let err = bash(&mut host, source).await.unwrap_err();
    assert_eq!(err.line, 1);
    assert!(!err.is_bash_status());
    if source.starts_with("set") {
      assert!(err.to_string().contains("unsupported option"));
    }
    assert!(host.eval_to_json("missed").is_err());
  }
}

#[tokio::test]
async fn bash_typed_failure_records_one_and_continues() {
  let mut host = host();
  host.register_native_special("bad", |_| {
    Err(LispHostError::Command("bad: failure".into()))
  });
  assert_eq!(
    bash(&mut host, "bad\n(std.sh.status)").await.unwrap(),
    Some(1.into())
  );
  bash(&mut host, "bad\ntrue").await.unwrap();
  assert_eq!(host.shell_status(), 0);
  bash(&mut host, "noexec").await.unwrap();
  assert_eq!(host.shell_status(), 126);
}

#[tokio::test]
async fn bash_parse_error_halts_instead_of_becoming_command_failure() {
  let mut host = host();
  let err = bash(&mut host, "true 'unterminated\n(let missed 1)")
    .await
    .unwrap_err();
  assert!(err.is_parse_error());
  assert!(host.eval_to_json("missed").is_err());
}

#[tokio::test]
async fn bash_status_and_errexit_are_host_local_and_persist_between_units() {
  let mut first = host();
  let second = host();
  bash(&mut first, "false").await.unwrap();
  assert_eq!(first.shell_status(), 1);
  assert_eq!(second.shell_status(), 0);
  bash(&mut first, "set -e").await.unwrap();
  assert!(
    bash(&mut first, "false")
      .await
      .unwrap_err()
      .is_bash_status()
  );
}

#[test]
fn bash_replay_restores_the_unit_entry_status_and_errexit() {
  let mut host = host();
  host.set_shell_status(7);
  host.begin_shell_unit(1);
  host.shell_errexit = true;
  host.set_shell_status(0);
  host.begin_shell_unit(1);
  assert_eq!(host.shell_status(), 7);
  assert!(!host.shell_errexit);
  host.shell_errexit = true;
  host.set_shell_status(3);
  host.begin_shell_unit(2);
  assert_eq!(host.shell_status(), 3);
  assert!(host.shell_errexit);
}

#[test]
fn bash_child_exit_codes_do_not_produce_synthetic_stderr() {
  for status in [1, 7, 126, 127] {
    assert_eq!(
      bash_command_diagnostic(
        1,
        &Error::ProcessExit {
          status: Some(status),
          signal: None,
          detail: format!("child exited {status}"),
        }
      ),
      None
    );
  }
}

#[tokio::test]
async fn bash_suspension_does_not_run_trailing_statements() {
  struct Pending;
  impl ExternalCommands for Pending {
    fn lookup(&self, _head: &str) -> ExternalLookup {
      ExternalLookup::Runs
    }
    fn run(&self, _argv: Vec<String>) -> AsyncCommandFut {
      Box::pin(async { Ok(JsonValue::Null) })
    }
    fn suggest(&self, _head: &str) -> Option<String> {
      None
    }
    fn suspended(&self) -> bool {
      true
    }
  }
  let mut host = LispHost::new();
  host.set_external_commands(Rc::new(Pending));
  host.set_shell_status(7);
  let stopped = bash(&mut host, "pending\n(let missed 1)")
    .await
    .unwrap_err();
  assert!(stopped.is_bash_status());
  assert_eq!(host.shell_status(), 7);
  assert!(host.eval_to_json("missed").is_err());
}

#[tokio::test]
async fn bash_missing_command_without_external_hook_records_127() {
  let mut host = LispHost::new();
  bash(&mut host, "missing").await.unwrap();
  assert_eq!(host.shell_status(), 127);
}

#[tokio::test]
async fn bash_existing_non_executable_is_distinct_from_a_child_exit() {
  struct Blocked;
  impl ExternalCommands for Blocked {
    fn lookup(&self, _head: &str) -> ExternalLookup {
      ExternalLookup::NotFound
    }
    fn run(&self, _argv: Vec<String>) -> AsyncCommandFut {
      panic!("not executable")
    }
    fn suggest(&self, _head: &str) -> Option<String> {
      None
    }
    fn not_executable(&self, _head: &str) -> bool {
      true
    }
  }
  let mut host = LispHost::new();
  host.set_external_commands(Rc::new(Blocked));
  bash(&mut host, "blocked").await.unwrap();
  assert_eq!(host.shell_status(), 126);
  assert_eq!(
    bash_command_diagnostic(
      3,
      &Error::ProcessStart {
        status: 126,
        detail: "blocked: Permission denied".into(),
      }
    ),
    Some("tsh: line 3: blocked: Permission denied".into())
  );
}

async fn recording_bash(
  source: &str,
  keep_final: bool,
) -> (
  Result<Option<JsonValue>, TshScriptError>,
  Vec<(JsonValue, bool)>,
) {
  let writes = Rc::new(std::cell::RefCell::new(Vec::new()));
  let recorded = writes.clone();
  let mut host = host();
  host.register_native_special("say", |args| Ok(args[0].clone()));
  // The next statement observes the callback's write, so collecting values
  // after the unit completes would not satisfy the test.
  let observed = writes.clone();
  host.register_native_special("check-written", move |_| {
    assert_eq!(observed.borrow().len(), 1);
    Ok(tento_lisp::Value::Nil)
  });
  let result = run_source_on_host(
    &mut host,
    source,
    &Scripts::new(()),
    &HashMap::new(),
    &[],
    RunOptions {
      on_error: OnError::Bash,
      bash_output: Some(Rc::new(move |_line, value, final_statement| {
        if keep_final && final_statement {
          return false;
        }
        recorded.borrow_mut().push((value.clone(), final_statement));
        true
      })),
      ..RunOptions::default()
    },
  )
  .await;
  let writes = writes.borrow().clone();
  (result, writes)
}

#[tokio::test]
async fn bash_output_writes_each_value_before_the_next_statement() {
  let (result, writes) = recording_bash("say a\ncheck-written\nsay b\n# trailer\n", false).await;
  assert_eq!(result.unwrap(), None);
  assert_eq!(writes, vec![("a".into(), false), ("b".into(), true)]);
}

/// An assignment binds without printing, as in bash; the binding is visible
/// to the next line.
#[tokio::test]
async fn bash_assignment_binds_without_output() {
  let (result, writes) = recording_bash("v=hello\nsay $v\nw=last", false).await;
  assert_eq!(result.unwrap(), None);
  assert_eq!(writes, vec![("hello".into(), false)]);
}

#[tokio::test]
async fn bash_output_mixed_units_keep_only_the_final_lisp_value() {
  let (result, writes) =
    recording_bash("say a\n(say \"hidden\")\nsay b\n(say \"last\")", false).await;
  assert_eq!(result.unwrap(), Some("last".into()));
  assert_eq!(writes, vec![("a".into(), false), ("b".into(), false)]);
  let (result, writes) = recording_bash("(say \"hidden\")\nsay b", false).await;
  assert_eq!(result.unwrap(), None);
  assert_eq!(writes, vec![("b".into(), true)]);
}

#[tokio::test]
async fn bash_multiline_lisp_def_between_bash_lines_survives_comments() {
  let source = "say before\n;; the producer's rows \"open\n(let joined\n  (concat \"a\" \"b\"))\n;; <<EOF\nsay $joined";
  let (result, writes) = recording_bash(source, false).await;
  assert_eq!(result.unwrap(), None);
  assert_eq!(writes, vec![("before".into(), false), ("ab".into(), true)]);
}

#[tokio::test]
async fn bash_lisp_string_with_heredoc_marker_keeps_lisp_reader() {
  let source = "say before\n(let marker\n  (concat \"<<'EOF\" \" (body)\"))\nsay \"$marker\"";
  let (result, writes) = recording_bash(source, false).await;
  assert_eq!(result.unwrap(), None);
  assert_eq!(
    writes,
    vec![("before".into(), false), ("<<'EOF (body)".into(), true)]
  );
}

#[tokio::test]
async fn bash_heredoc_body_starting_with_parens_is_literal() {
  let mut h = host();
  h.register_native_special("say", |args| Ok(args[0].clone()));
  let source = "std.io.stdin_text <<'EOF'\n(unclosed\n(let fake 1))\nEOF\nsay after";
  let captured = h.capture_shell_source(source).await.unwrap();
  assert_eq!(captured.status, 0);
  assert_eq!(captured.stdout, b"(unclosed\n(let fake 1))\n\nafter\n");
  assert!(h.eval_to_json("fake").is_err());
}

#[tokio::test]
async fn bash_output_survives_failed_lines_and_errexit() {
  let (result, writes) = recording_bash("false\nsay continued\nmissing\nsay after", false).await;
  assert_eq!(result.unwrap(), None);
  assert_eq!(
    writes,
    vec![("continued".into(), false), ("after".into(), true)]
  );
  let (result, writes) = recording_bash("set -e\nsay a\nfalse\nsay missed", false).await;
  assert_eq!(result.unwrap_err().process_status(), Some(1));
  assert_eq!(writes, vec![("a".into(), false)]);
}

#[tokio::test]
async fn bash_output_control_policy_preserves_final_value_and_nil_trailers() {
  let (result, writes) = recording_bash("say a\nsay b\n# trailer", true).await;
  assert_eq!(result.unwrap(), Some("b".into()));
  assert_eq!(writes, vec![("a".into(), false)]);
  let (result, writes) = recording_bash("say a\ntrue", true).await;
  assert_eq!(result.unwrap(), None);
  assert_eq!(writes, vec![("a".into(), false)]);
}

#[tokio::test]
async fn flow_short_circuit_status_truth_table() {
  for (source, status, stdout) in [
    ("false && say missed", 1, vec![]),
    ("true && say yes", 0, vec![("yes".into(), true)]),
    ("false || say yes", 0, vec![("yes".into(), true)]),
    ("true || say missed", 0, vec![]),
    ("exit-seven && say missed", 7, vec![]),
    ("! false", 0, vec![]),
    ("! true", 1, vec![]),
    (
      "say a; say b;",
      0,
      vec![("a".into(), false), ("b".into(), true)],
    ),
  ] {
    let mut h = host();
    h.register_native_special("say", |args| Ok(args[0].clone()));
    let writes = Rc::new(std::cell::RefCell::new(Vec::new()));
    let out = writes.clone();
    run_source_on_host(
      &mut h,
      source,
      &Scripts::new(()),
      &HashMap::new(),
      &[],
      RunOptions {
        on_error: OnError::Bash,
        bash_output: Some(Rc::new(move |_, value, last| {
          out.borrow_mut().push((value.clone(), last));
          true
        })),
        ..RunOptions::default()
      },
    )
    .await
    .unwrap();
    assert_eq!(h.shell_status(), status, "{source}");
    assert_eq!(*writes.borrow(), stdout, "{source}");
  }
}

#[tokio::test]
async fn flow_errexit_exemptions_and_final_operand() {
  for source in [
    "false && true; true",
    "false || true",
    "! true; true",
    "false && true || true",
    "true || false && true",
  ] {
    let mut h = host();
    bash(&mut h, &format!("set -e\n{source}")).await.unwrap();
    assert_eq!(h.shell_status(), 0, "{source}");
  }
  for source in ["true && false", "false || exit-seven", "true; false; true"] {
    let mut h = host();
    assert!(
      bash(&mut h, &format!("set -e\n{source}"))
        .await
        .unwrap_err()
        .is_bash_status()
    );
  }
}

#[tokio::test]
async fn flow_writes_before_next_stage_and_lisp_errors_warn() {
  let (result, writes) = recording_bash("say a; check-written; say b", false).await;
  assert_eq!(result.unwrap(), None);
  assert_eq!(writes, vec![("a".into(), false), ("b".into(), true)]);
  let mut h = host();
  // Q6 item 18: a native failing in a bash line warns and continues.
  h.register_native_special("broken", |_| Err(LispHostError::Runtime("boom".into())));
  h.collect_shell_diagnostics();
  assert!(bash(&mut h, "broken || true; true").await.is_ok());
  assert_eq!(h.take_shell_diagnostics(), ["tsh: line 1: lisp error: broken: boom"]);
}

#[tokio::test]
async fn flow_typed_pipeline_stdin_and_capture_formatter() {
  let mut h = host();
  h.register_native_special("say", |args| Ok(args[0].clone()));
  h.set_shell_formatter(Rc::new(|v| v.as_str().map(|s| format!("render:{s}\n"))));
  assert_eq!(
    bash(&mut h, "say hello | std.io.stdin_text").await.unwrap(),
    Some("render:hello\n".into())
  );
  assert_eq!(
    bash(&mut h, "say hello | say ignored").await.unwrap(),
    Some("ignored".into())
  );
  assert_eq!(h.eval_to_json("(std.io.stdin_text)").unwrap(), "");
  let captured = h.capture_shell_source("say a; say b").await.unwrap();
  assert_eq!(captured.stdout, b"render:a\nrender:b\n");
  assert_eq!(captured.status, 0);
}

#[cfg(unix)]
struct PipePrograms;

#[cfg(unix)]
impl ExternalCommands for PipePrograms {
  fn lookup(&self, head: &str) -> ExternalLookup {
    if matches!(
      head,
      "/usr/bin/true"
        | "/usr/bin/false"
        | "/usr/bin/printf"
        | "/usr/bin/sort"
        | "/usr/bin/head"
        | "/usr/bin/yes"
        | "/usr/bin/wc"
    ) {
      ExternalLookup::Runs
    } else {
      ExternalLookup::NotFound
    }
  }

  fn run(&self, argv: Vec<String>) -> AsyncCommandFut {
    Box::pin(async move {
      Err(Error::Other(anyhow::anyhow!(
        "expected pipeline route: {}",
        argv[0]
      )))
    })
  }

  fn run_pipeline(
    &self,
    argv: Vec<Vec<String>>,
    input: Option<Vec<u8>>,
    capture: bool,
  ) -> super::super::PipelineFuture {
    Box::pin(super::super::run_process_pipeline(
      argv
        .into_iter()
        .map(|argv| (std::path::PathBuf::from(&argv[0]), argv))
        .collect(),
      input,
      capture,
      None,
      None,
    ))
  }

  fn suggest(&self, _: &str) -> Option<String> {
    None
  }

  fn run_pipeline_with_io(&self, argv: Vec<Vec<String>>, input: Option<Vec<u8>>, capture: bool,
    io: Vec<Option<super::super::ShellIo>>) -> super::super::PipelineFuture {
    Box::pin(super::super::run_process_pipeline_with_io(
      argv.into_iter().map(|argv| (argv.first().map(std::path::PathBuf::from).unwrap_or_default(), argv)).collect(),
      input, capture, None, None, io,
    ))
  }
}

#[tokio::test]
async fn redirection_typed_files_inputs_order_and_failure() {
  let mut h = host();
  h.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .truncate(!read && !append)
      .append(!read && append)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  h.register_native_special("say", |args| Ok(args[0].clone()));
  let path = redirection_temp_path("typed");
  let quoted = serde_json::to_string(&path.to_string_lossy()).unwrap();
  for op in [">", ">|", "&>", "3>"] {
    let dup = if op == "3>" { " >&3" } else { "" };
    let source = format!("say hello {op}{quoted}{dup}");
    assert!(
      h.capture_shell_source(&source)
        .await
        .unwrap()
        .stdout
        .is_empty()
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"hello\n", "{source}");
  }
  h.capture_shell_source(&format!("say more >>{quoted}"))
    .await
    .unwrap();
  assert_eq!(std::fs::read(&path).unwrap(), b"hello\nmore\n");
  let input = h
    .capture_shell_source(&format!("std.io.stdin_text <{quoted}"))
    .await
    .unwrap();
  assert_eq!(input.stdout, b"hello\nmore\n\n");
  for redirect in [
    format!("0<{quoted}"),
    format!("3<{quoted} 0<&3"),
    format!("3<{quoted} </dev/fd/3"),
  ] {
    let input = h
      .capture_shell_source(&format!("std.io.stdin_text {redirect}"))
      .await
      .unwrap();
    assert_eq!(input.stdout, b"hello\nmore\n\n", "{redirect}");
  }
  for (source, expected) in [
    (
      "std.io.stdin_text <<'EOF'\n$(bad `code\nEOF\n",
      "$(bad `code\n\n",
    ),
    ("std.io.stdin_text <<-\"EOF\"\n\thi\n\tEOF\n", "hi\n\n"),
    ("std.io.stdin_text <<< 'a b'", "a b\n\n"),
    ("x=hello; std.io.stdin_text <<EOF\n$x\nEOF\n", "hello\n\n"),
  ] {
    assert_eq!(
      h.capture_shell_source(source).await.unwrap().stdout,
      expected.as_bytes(),
      "{source}"
    );
  }
  let captured = h
    .capture_shell_source(&format!("no-04j-command >{quoted} 2>&1"))
    .await
    .unwrap();
  assert_eq!(captured.status, 127);
  assert!(captured.stdout.is_empty());
  assert_eq!(
    std::fs::read(&path).unwrap(),
    b"tsh: line 1: no-04j-command: command not found\n"
  );
  let captured = h
    .capture_shell_source(&format!("no-04j-command 2>&1 >{quoted}"))
    .await
    .unwrap();
  assert_eq!(
    captured.stdout,
    b"tsh: line 1: no-04j-command: command not found\n"
  );
  assert_eq!(std::fs::read(&path).unwrap(), b"");
  assert!(
    h.capture_shell_source("no-04j-command 2>/dev/null")
      .await
      .unwrap()
      .stdout
      .is_empty()
  );
  assert!(
    h.capture_shell_source("say closed 1>&- 2>/dev/null")
      .await
      .unwrap()
      .status
      == 1
  );
  let failed = h
    .capture_shell_source("say must-not-run 2>/dev/null < /no-such-04j-input")
    .await
    .unwrap();
  assert_eq!(failed.status, 1);
  let failed = h
    .capture_shell_source("x='a b'; say must-not-run >$x 2>/dev/null")
    .await
    .unwrap();
  assert_eq!(failed.status, 1);
  let failed = h
    .capture_shell_source("say must-not-run < /no-such-04j-input")
    .await
    .unwrap();
  assert_eq!(failed.status, 1);
  assert!(failed.stdout.is_empty());
  assert_eq!(h.eval_to_json("(std.io.stdin_text)").unwrap(), "");
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn redirected_not_found_uses_the_stderr_copy_at_duplication_time() {
  let mut h = host();
  h.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .truncate(!read && !append)
      .append(!read && append)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let path = redirection_temp_path("stderr-copy");
  let quoted = serde_json::to_string(&path.to_string_lossy()).unwrap();
  let diagnostic = b"tsh: line 1: missing-04m2: command not found\n";
  for (redirect, stdout, file) in [
    (
      format!("2>&1 >{quoted}"),
      diagnostic.as_slice(),
      b"".as_slice(),
    ),
    (
      format!(">{quoted} 2>&1"),
      b"".as_slice(),
      diagnostic.as_slice(),
    ),
    (
      format!("3>&1 >{quoted} 2>&3"),
      diagnostic.as_slice(),
      b"".as_slice(),
    ),
    (
      format!("2>/dev/null >{quoted}"),
      b"".as_slice(),
      b"".as_slice(),
    ),
  ] {
    h.collect_shell_diagnostics();
    let captured = h
      .capture_shell_source(&format!("missing-04m2 {redirect}"))
      .await
      .unwrap();
    assert_eq!(captured.status, 127, "{redirect}");
    assert_eq!(captured.stdout, stdout, "{redirect}");
    assert_eq!(std::fs::read(&path).unwrap(), file, "{redirect}");
    assert!(h.take_shell_diagnostics().is_empty(), "{redirect}");
  }
  std::fs::remove_file(path).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn redirection_external_real_descriptors_and_concurrent_pipe() {
  let mut h = LispHost::new();
  h.set_external_commands(Rc::new(PipePrograms));
  h.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .truncate(!read && !append)
      .append(!read && append)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let path = redirection_temp_path("external");
  let quoted = serde_json::to_string(&path.to_string_lossy()).unwrap();
  for op in [">", "1>", ">>", "1>>", "3>", "&>", "&>>", ">|"] {
    std::fs::write(&path, "before").unwrap();
    let dup = if op == "3>" { " >&3" } else { "" };
    let source = format!("/usr/bin/printf hi {op}{quoted}{dup}");
    let result = h.capture_shell_source(&source).await.unwrap();
    assert_eq!(result.status, 0, "{source}");
    assert!(result.stdout.is_empty());
    assert_eq!(
      std::fs::read(&path).unwrap(),
      if op.contains(">>") {
        b"beforehi".as_slice()
      } else {
        b"hi".as_slice()
      }
    );
  }
  std::fs::write(&path, "b\na\n").unwrap();
  for redirect in [
    format!("<{quoted}"),
    format!("0<{quoted}"),
    format!("3<{quoted} <&3"),
  ] {
    let source = format!("/usr/bin/sort {redirect}");
    let result = h.capture_shell_source(&source).await.unwrap();
    assert_eq!(result.status, 0);
    assert_eq!(result.stdout, b"a\nb\n", "{source}");
  }
  for (source, expected) in [
    ("/usr/bin/printf hi 2>&1", "hi"),
    ("/usr/bin/printf hi 3>&1 >&3", "hi"),
    ("/usr/bin/printf hi >&2 2>&1", ""),
    ("/usr/bin/printf hi 2>&-", "hi"),
    ("/usr/bin/sort <<'EOF'\nb\na\nEOF\n", "a\nb\n"),
    ("/usr/bin/sort <<< 'hi'", "hi\n"),
  ] {
    let result = h.capture_shell_source(source).await.unwrap();
    assert_eq!(result.status, 0, "{source}");
    assert_eq!(result.stdout, expected.as_bytes(), "{source}");
  }
  let result = tokio::time::timeout(
    std::time::Duration::from_secs(5),
    h.capture_shell_source("/usr/bin/yes x 2>/dev/null | /usr/bin/head -n 1"),
  )
  .await
  .expect("redirected external stages remain concurrent")
  .unwrap();
  assert_eq!(result.status, 0);
  assert_eq!(result.stdout, b"x\n");
  let result = tokio::time::timeout(
    std::time::Duration::from_secs(5),
    h.capture_shell_source(
      "/usr/bin/yes x | /usr/bin/sort 2>/dev/null </no-such-04j-input | /usr/bin/head -n 1",
    ),
  )
  .await
  .expect("failed open closes the upstream reader")
  .unwrap();
  assert_eq!(result.status, 0);
  assert!(result.stdout.is_empty());
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn redirection_hosted_replay_does_not_reopen_or_retruncate() {
  let mut h = host();
  let count = Rc::new(std::cell::Cell::new(0));
  let opened = count.clone();
  h.register_native_special("say", |args| Ok(args[0].clone()));
  h.set_shell_file_opener(Rc::new(move |path, read, append| {
    opened.set(opened.get() + 1);
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .truncate(!read && !append)
      .append(!read && append)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let path = redirection_temp_path("replay");
  let source = format!(
    ">{}",
    serde_json::to_string(&path.to_string_lossy()).unwrap()
  );
  h.begin_shell_unit(41);
  h.capture_shell_source(&source).await.unwrap();
  std::fs::write(&path, "settled-child-output").unwrap();
  h.begin_shell_unit(41);
  h.capture_shell_source(&source).await.unwrap();
  assert_eq!(count.get(), 1);
  assert_eq!(std::fs::read(&path).unwrap(), b"settled-child-output");
  h.begin_shell_unit(42);
  h.capture_shell_source(&source).await.unwrap();
  assert_eq!(count.get(), 2);
  assert!(std::fs::read(&path).unwrap().is_empty());
  let output = format!(
    "say hello >{}",
    serde_json::to_string(&path.to_string_lossy()).unwrap()
  );
  for _ in 0..2 {
    h.begin_shell_unit(43);
    h.capture_shell_source(&output).await.unwrap();
  }
  assert_eq!(std::fs::read(&path).unwrap(), b"hello\n");
  let input = format!(
    "std.io.stdin_text <{}",
    serde_json::to_string(&path.to_string_lossy()).unwrap()
  );
  for _ in 0..2 {
    h.begin_shell_unit(44);
    assert_eq!(
      h.capture_shell_source(&input).await.unwrap().stdout,
      b"hello\n\n"
    );
  }
  let diagnostic = format!(
    "no-04j-command 2>{}",
    serde_json::to_string(&path.to_string_lossy()).unwrap()
  );
  for _ in 0..2 {
    h.begin_shell_unit(45);
    h.capture_shell_source(&diagnostic).await.unwrap();
  }
  assert_eq!(
    std::fs::read(&path).unwrap(),
    b"tsh: line 1: no-04j-command: command not found\n"
  );
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn redirection_words_quote_split_and_glob_without_running_ambiguous_commands() {
  let mut h = host();
  h.eval_posix_line("LC_ALL=C").unwrap();
  let ran = Rc::new(std::cell::Cell::new(0));
  let calls = ran.clone();
  h.register_native_special("say", move |args| {
    calls.set(calls.get() + 1);
    Ok(args[0].clone())
  });
  h.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .truncate(!read && !append)
      .append(!read && append)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let dir = redirection_temp_path("words");
  std::fs::create_dir(&dir).unwrap();
  std::fs::write(dir.join("a.txt"), "preimage-a").unwrap();
  std::fs::write(dir.join("b.txt"), "preimage-b").unwrap();
  h.collect_shell_diagnostics();
  for source in [
    format!("say no >{}/*.txt", dir.display()),
    "x='a b'; say no >$x".into(),
  ] {
    let result = h.capture_shell_source(&source).await.unwrap();
    assert_eq!(result.status, 1, "{source}");
    assert!(result.stdout.is_empty());
    assert_eq!(ran.get(), 0);
  }
  assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"preimage-a");
  assert_eq!(std::fs::read(dir.join("b.txt")).unwrap(), b"preimage-b");
  assert!(
    h.take_shell_diagnostics()
      .iter()
      .all(|d| d.contains("ambiguous redirect"))
  );
  let source = format!("say selected >{}/a.t?t", dir.display());
  assert_eq!(h.capture_shell_source(&source).await.unwrap().status, 0);
  assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"selected\n");
  let file = dir.join("with space");
  let source = format!(
    "x={}; say hi >\"$x\"",
    serde_json::to_string(&file.to_string_lossy()).unwrap()
  );
  assert_eq!(h.capture_shell_source(&source).await.unwrap().status, 0);
  assert_eq!(std::fs::read(&file).unwrap(), b"hi\n");
  let source = format!("say literal >{}/\"*\".txt", dir.display());
  assert_eq!(h.capture_shell_source(&source).await.unwrap().status, 0);
  assert_eq!(std::fs::read(dir.join("*.txt")).unwrap(), b"literal\n");
  std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn flow_real_pipeline_capture_status_and_errexit() {
  let mut h = LispHost::new();
  h.set_external_commands(Rc::new(PipePrograms));
  h.register_native_special("say", |args| Ok(args[0].clone()));
  for (source, status, bytes) in [
    ("/usr/bin/printf 'b\\na\\n' | /usr/bin/sort", 0, "a\nb\n"),
    ("/usr/bin/false | /usr/bin/true", 0, ""),
    ("/usr/bin/true | /usr/bin/false", 1, ""),
    ("! /usr/bin/false | /usr/bin/true", 1, ""),
    ("say b | /usr/bin/sort", 0, "b\n"),
  ] {
    let captured = h.capture_shell_source(source).await.unwrap();
    assert_eq!(captured.status, status, "{source}");
    assert_eq!(captured.stdout, bytes.as_bytes(), "{source}");
  }
  assert_eq!(
    bash(&mut h, "/usr/bin/printf raw | std.io.stdin_text")
      .await
      .unwrap(),
    Some("raw".into())
  );
  bash(&mut h, "set -e\n/usr/bin/false | /usr/bin/true\nsay after")
    .await
    .unwrap();
  let err = bash(&mut h, "/usr/bin/true | /usr/bin/false\nsay missed")
    .await
    .unwrap_err();
  assert!(err.is_bash_status());
  assert_eq!(err.process_status(), Some(1));
}

#[tokio::test]
async fn flow_native_command_failures_remain_statuses() {
  let mut h = host();
  h.register_native_special("bad", |_| {
    Err(LispHostError::Command("bad: failure".into()))
  });
  h.register_native_special("say", |args| Ok(args[0].clone()));
  assert_eq!(
    bash(&mut h, "bad || say recovered").await.unwrap(),
    Some("recovered".into())
  );
  assert_eq!(h.shell_status(), 0);
  bash(&mut h, "set -e; bad && say missed").await.unwrap();
  assert_eq!(h.shell_status(), 1);
}

#[tokio::test]
async fn flow_async_host_door_preserves_unevaluated_operands() {
  let mut h = host();
  h.register_native_special("say", |args| Ok(args[0].clone()));
  assert_eq!(
    h.eval_posix_line_async("false && no-such-command || say yes")
      .await
      .unwrap(),
    "yes"
  );
  assert_eq!(h.shell_status(), 0);
  assert_eq!(h.eval_lisp_line("(and false 7)").unwrap(), false);
}

#[tokio::test]
async fn flow_lisp_forms_are_host_special_forms() {
  let mut h = host();
  h.register_native_special("say", |args| Ok(args[0].clone()));
  // In lisp text `false` is the boolean, not the command, so the failing
  // stage is a native that fails.
  h.register_native_special("bad", |_| {
    Err(LispHostError::Command("bad: failure".into()))
  });
  assert_eq!(
    bash(&mut h, "(std.sh.or (bad) (say \"yes\"))")
      .await
      .unwrap(),
    Some("yes".into())
  );
  assert_eq!(
    h.eval_lisp_line("(std.sh.and (bad) (say \"missed\"))")
      .unwrap(),
    JsonValue::Null
  );
  assert_eq!(h.shell_status(), 1);
}


#[tokio::test]
async fn flow_newline_continues_an_incomplete_operator() {
  let mut h = host();
  h.register_native_special("say", |args| Ok(args[0].clone()));
  assert_eq!(
    bash(&mut h, "false ||\n# continuation\nsay yes")
      .await
      .unwrap(),
    Some("yes".into())
  );
  assert_eq!(h.shell_status(), 0);
  let error = bash(&mut h, "true &&\n").await.unwrap_err();
  assert_eq!(error.line, 1);
}

#[tokio::test]
async fn corpus_numeric_command_combined_redirect_matches_reference_status_127() {
  // Oils 0e9d9a57d7e5 reference: 2&>1; echo status=$? -> status=127.
  let mut host = host();
  host.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new().read(read).write(!read).create(!read)
      .append(append).truncate(!read && !append).open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let path = redirection_temp_path("numeric-command");
  let captured = host.capture_shell_source(&format!("2&>{}\necho status=$?", path.display())).await.unwrap();
  assert_eq!(captured.stdout, b"status=127\n");
  assert_eq!(captured.status, 0);
  assert!(std::fs::read_to_string(&path).unwrap().contains("2: command not found"));
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn corpus_named_descriptors_persist_and_only_allocate_at_word_boundaries() {
  let mut host = host();
  let path = redirection_temp_path("named-descriptor");
  host.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new().read(read).write(!read).create(!read)
      .append(append).truncate(!read && !append).open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let source = format!("echo {{myvar}}>{}\nstarting_fd=$myvar\n\
    echo x={{myvar}}>/dev/stdout\necho $((myvar-starting_fd))\n\
    echo x= {{myvar}}>/dev/stdout\necho $((myvar-starting_fd))\n\
    echo +{{myvar}}>/dev/stdout\necho $((myvar-starting_fd))\n\
    echo + {{myvar}}>/dev/stdout\necho $((myvar-starting_fd))\n\
    echo stored >&$starting_fd\n{{myvar}}>&-", path.display());
  let captured = host.capture_shell_source(&source).await.unwrap();
  assert_eq!(captured.stdout, b"\nx={myvar}\n0\nx=\n1\n+{myvar}\n1\n+\n2\n");
  assert_eq!(std::fs::read(&path).unwrap(), b"stored\n");
  assert_eq!(captured.status, 0);
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn corpus_eof_heredoc_warns_and_chunker_keeps_complete_bodies() {
  let mut host = host();
  host.collect_shell_diagnostics();
  let captured = host.capture_shell_source("std.io.stdin_text <<'END'\nbody").await.unwrap();
  // bash ends the cut-short body line with a newline, as a terminated one.
  assert_eq!(captured.stdout, b"body\n\n");
  assert!(host.take_shell_diagnostics().iter().any(|s| s.contains("warning: here-document") && s.contains("END")));
  host.collect_shell_diagnostics();
  let captured = host.capture_shell_source("std.io.stdin_text <<'END'\nbody\nEND\necho next").await.unwrap();
  assert_eq!(captured.stdout, b"body\n\nnext\n");
  assert!(host.take_shell_diagnostics().is_empty());
}

#[tokio::test]
async fn corpus_indexed_array_words_and_sparse_assignment() {
  let mut host = host();
  let captured = host.capture_shell_source(
    "a=(one 'two three'); a[4]=four; a+=(five); echo \"${a[@]}\"; \
    echo ${#a[@]}:${a[4]}:${a[-1]}; echo \"${a[*]}\"; \
    a=(); echo left\"${a[@]}\"right; echo ${pipestatus[1]}"
  ).await.unwrap();
  assert_eq!(captured.stdout, b"one two three four five\n4:four:five\none two three four five\nleftright\n\n");
}

#[tokio::test]
async fn corpus_pipeline_status_is_an_indexed_array_snapshot() {
  let mut host = host();
  let captured = host.capture_shell_source("false | true; echo \"${PIPESTATUS[@]}\"; echo \"${PIPESTATUS[@]}\"").await.unwrap();
  assert_eq!(captured.stdout, b"1 0\n0\n");
}

#[tokio::test]
async fn corpus_arrays_keep_literal_flags_and_scalar_assignment_updates_element_zero() {
  let mut host = host();
  let captured = host.capture_shell_source("a=(--help --key=value two); a=first; x=${a[@]}; echo \"$x\"; echo ${#a[@]}").await.unwrap();
  assert_eq!(captured.stdout, b"first --key=value two\n3\n");
}

#[cfg(unix)]
#[tokio::test]
async fn corpus_stderr_pipe_overrides_explicit_stderr_redirection() {
  let mut host = host();
  host.eval_posix_line("LC_ALL=C").unwrap();
  host.set_external_commands(Rc::new(PipePrograms));
  host.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new().read(read).write(!read).create(!read)
      .append(append).truncate(!read && !append).open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let captured = host.capture_shell_source(
    "/usr/bin/sort /no-such-04u-input 2>/dev/null |& /usr/bin/head -n1"
  ).await.unwrap();
  assert_eq!(captured.status, 0);
  let bash = if cfg!(target_os = "macos") { "/opt/homebrew/bin/bash" } else { "bash" };
  let version = std::process::Command::new(bash).arg("--version").output().unwrap();
  assert!(version.status.success());
  // Both patch releases are installed on the fleet. Keep the behavior
  // comparison below; a newer patch must still match the same contract.
  let reference_version = String::from_utf8_lossy(&version.stdout);
  assert!(
    ["GNU bash, version 5.3.9(", "GNU bash, version 5.3.20("]
      .iter()
      .any(|prefix| reference_version.starts_with(prefix)),
    "unsupported Bash reference: {reference_version}"
  );
  let expected = std::process::Command::new(bash)
    .args(["--noprofile", "--norc", "-c", "/usr/bin/sort /no-such-04u-input 2>/dev/null |& /usr/bin/head -n1"])
    .env_remove("BASH_ENV").env("PATH", "/usr/bin:/bin").env("LC_ALL", "C").output().unwrap();
  assert!(expected.status.success(), "bash reference failed: {:?}", expected.stderr);
  assert!(!expected.stdout.is_empty());
  assert_eq!(captured.stdout, expected.stdout);
}

#[tokio::test]
async fn fixes_substitution_case_arms_reach_the_compound_reader() {
  let mut host = host();
  for source in [
    "echo $(case x in x) printf yes ;; *) printf no ;; esac)",
    "echo $(case x in (x|y) echo yes ;; esac)",
    "echo $(case x in x) case y in y) echo yes ;; esac ;; esac)",
  ] {
    // echo keeps this test within the host's builtin surface.
    let source = source.replace("printf yes", "echo yes").replace("printf no", "echo no");
    let captured = host.capture_shell_source(&source).await.unwrap();
    assert_eq!(captured.stdout, b"yes\n", "{source}");
    assert_eq!(captured.status, 0, "{source}");
  }
}

#[tokio::test]
async fn fixes_pipeline_status_starts_empty_and_case_preserves_last_pipeline() {
  for (source, expected) in [
    ("echo initial ${PIPESTATUS[@]}", "initial\n"),
    ("case x in y) true ;; esac; echo pipestatus ${PIPESTATUS[@]}", "pipestatus\n"),
    ("false; case x in x) ;; esac; echo ${PIPESTATUS[@]}:$?", "1:0\n"),
    ("false | true; case x in x) ;; esac; echo ${PIPESTATUS[@]}:$?", "1 0:0\n"),
    ("false; case x in y) true ;; esac; echo ${PIPESTATUS[@]}:$?", "1:0\n"),
    ("false; case x in x) ;& y) ;; esac; echo ${PIPESTATUS[@]}:$?", "1:0\n"),
    ("false | true; case x in x) false | true ;; esac; echo ${PIPESTATUS[@]}", "1 0\n"),
    ("false | true; echo ${PIPESTATUS[@]}; echo ${PIPESTATUS[@]}", "1 0\n0\n"),
    ("a=value; echo ${PIPESTATUS[@]}; false; echo ${PIPESTATUS[@]}", "0\n1\n"),
  ] {
    let mut host = host();
    let result = host.capture_shell_source(source).await.unwrap();
    assert_eq!(result.stdout, expected.as_bytes(), "{source}");
  }
}

#[tokio::test]
async fn fixes_shell_str_binding_does_not_shadow_compiled_word_joining() {
  let mut host = host();
  let captured = host.capture_shell_source(
    "str=s; array=(a1 a2); echo bare 'sq' $str \"-${str}-\" \"${array[@]}\" $((1+2)) $(echo c) `echo c`"
  ).await.unwrap();
  assert_eq!(captured.stdout, b"bare sq s -s- a1 a2 3 c c\n");
  let captured = host.capture_shell_source("str=s; x=\"-${str}-\"; echo \"$x\"").await.unwrap();
  assert_eq!(captured.stdout, b"-s-\n");
  assert_eq!(host.eval_lisp_line("(str.concat \"a\" \"b\")").unwrap(), "ab");
}
