use super::*;
use std::cell::RefCell;
use std::io::{Cursor, Read};

#[derive(Clone)]
struct SharedInput(Rc<RefCell<Cursor<Vec<u8>>>>);

impl Read for SharedInput {
  fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
    assert_eq!(bytes.len(), 1, "source reader must not read ahead");
    self.0.borrow_mut().read(bytes)
  }
}

#[test]
fn reader_stops_at_complete_commands_and_preserves_the_rest() {
  for command in [
    "read x; echo \"got [$x]\"\n",
    "echo ab\\\ncd\n",
    "echo 'open\nquote'\n",
    "if true; then\necho yes\nfi\n",
    "for x in a b; do\necho $x\ndone\n",
    "cat <<EOF\nhello\nEOF\n",
    "cat <<-'EOF'\n\thello\n\tEOF\n",
    "echo yes &&\necho after\n",
    "(let x\n 1)\n",
    "# quote ' <<EOF \\\n",
  ] {
    let source = format!("{command}REST\n");
    let input = SharedInput(Rc::new(RefCell::new(Cursor::new(source.into_bytes()))));
    let mut reader = CommandReader::new(input.clone());
    let (line, chunk, _, _) = reader.next().unwrap().unwrap();
    assert_eq!(line, 1);
    assert_eq!(chunk, command.trim_end_matches('\n'));
    assert_eq!(input.0.borrow().position(), command.len() as u64, "{command}");
  }
}

#[test]
fn reader_eof_retains_continuations_and_detects_stdin_shebang() {
  for source in ["echo yes", "echo hi \\\n", "cat <<EOF\nhi\n"] {
    let mut reader = CommandReader::new(Cursor::new(source.as_bytes()));
    let (_, chunk, _, _) = reader.next().unwrap().unwrap();
    assert_eq!(chunk, source);
    assert!(reader.next().is_none());
  }
  let mut reader = CommandReader::new(Cursor::new(b"#!/bin/sh\n(true); echo after\n"));
  assert!(reader.next().unwrap().unwrap().2);
  assert!(reader.next().unwrap().unwrap().2);
}

#[tokio::test]
async fn reader_runs_before_reading_next_command_and_keeps_one_host() {
  let input = SharedInput(Rc::new(RefCell::new(Cursor::new(
    b"(take-line)\nhello\n(let after 1)\n".to_vec(),
  ))));
  let child_input = input.clone();
  let mut host = LispHost::new();
  host.register_native_special("take-line", move |_args| {
    let mut cursor = child_input.0.borrow_mut();
    let mut data = Vec::new();
    let mut byte = [0];
    while cursor.read(&mut byte).unwrap() != 0 {
      data.push(byte[0]);
      if byte[0] == b'\n' { break; }
    }
    assert_eq!(data, b"hello\n");
    Ok(super::super::LispValue::Nil)
  });
  run_reader_on_host(&mut host, input, &Scripts::new(()), &HashMap::new(), &[],
    RunOptions { on_error: OnError::Bash, ..Default::default() },
  ).await.unwrap();
  assert_eq!(host.eval_to_json("after").unwrap(), JsonValue::from(1));
}

#[tokio::test]
async fn reader_command_can_consume_all_remaining_script_bytes() {
  let input = SharedInput(Rc::new(RefCell::new(Cursor::new(
    b"(take-rest)\n(let never 1)\n".to_vec(),
  ))));
  let child_input = input.clone();
  let mut host = LispHost::new();
  host.register_native_special("take-rest", move |_args| {
    let mut data = String::new();
    child_input.0.borrow_mut().read_to_string(&mut data).unwrap();
    assert_eq!(data, "(let never 1)\n");
    Ok(super::super::LispValue::Nil)
  });
  run_reader_on_host(&mut host, input, &Scripts::new(()), &HashMap::new(), &[],
    RunOptions { on_error: OnError::Bash, ..Default::default() },
  ).await.unwrap();
  assert!(host.eval_to_json("never").is_err());
}

#[tokio::test]
async fn reader_keeps_output_order_runs_exit_trap_once_and_stops_on_exit() {
  let mut host = LispHost::new();
  let bytes = Rc::new(RefCell::new(Vec::new()));
  let output = bytes.clone();
  host.set_shell_byte_output(Rc::new(move |data| output.borrow_mut().extend_from_slice(data)));
  run_reader_on_host(&mut host,
    Cursor::new(b"trap 'echo DONE' EXIT\necho before\necho after\n"),
    &Scripts::new(()), &HashMap::new(), &[],
    RunOptions { on_error: OnError::Bash, ..Default::default() },
  ).await.unwrap();
  assert_eq!(&*bytes.borrow(), b"before\nafter\nDONE\n");
  let mut host = LispHost::new();
  let mut input = Cursor::new(b"exit 7\n(let never 1)\n");
  let error = run_reader_on_host(&mut host, &mut input,
    &Scripts::new(()), &HashMap::new(), &[],
    RunOptions { on_error: OnError::Bash, ..Default::default() },
  ).await.unwrap_err();
  assert_eq!(error.process_status(), Some(7));
  assert_eq!(input.position(), b"exit 7\n".len() as u64);
  assert!(host.eval_to_json("never").is_err());
}

#[tokio::test]
async fn reader_errors_keep_starting_line_and_pending_forms() {
  let mut host = LispHost::new();
  let error = run_reader_on_host(&mut host, Cursor::new(b"# header\n\n(let missing\n"),
    &Scripts::new(()), &HashMap::new(), &[], RunOptions::default(),
  ).await.unwrap_err();
  assert_eq!(error.line, 3);
  assert!(error.is_parse_error());
  let mut host = LispHost::new();
  let error = run_reader_on_host(&mut host, Cursor::new(b"echo \xff\n"),
    &Scripts::new(()), &HashMap::new(), &[], RunOptions::default(),
  ).await.unwrap_err();
  assert!(matches!(error.kind, TshScriptErrorKind::Input(_)));
}

/// A single `;` after a form makes the line bash (I10); only the legacy
/// `>` prefix, which rules bash out, refuses it, before the form runs.
#[tokio::test]
async fn single_semicolon_refusal_has_usage_status_and_no_effects() {
  let mut host = LispHost::new();
  let error = run_source_on_host(&mut host, "> (let touched 1); echo AFTER",
    &Scripts::new(()), &HashMap::new(), &[], RunOptions::default(),
  ).await.unwrap_err();
  assert!(error.is_parse_error());
  assert_eq!(error.line, 1);
  assert!(error.to_string().contains("a single `;` is not lisp: `(let touched 1)` is followed by `; echo AFTER`; write `;;` for a comment"), "{error}");
  assert!(host.eval_to_json("touched").is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn stdin_builtin_read_leaves_later_commands_on_the_descriptor() {
  const CHILD: &str = "TENTO_P1A_STDIN_READ_CHILD";
  if std::env::var_os(CHILD).is_none() {
    use std::io::Write as _;
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
      .args(["--exact", "script::runner::reader_tests::stdin_builtin_read_leaves_later_commands_on_the_descriptor"])
      .env(CHILD, "1")
      .stdin(std::process::Stdio::piped())
      .spawn().unwrap();
    child.stdin.take().unwrap().write_all(b"read x\nhello\n(let after 1)\n").unwrap();
    assert!(child.wait().unwrap().success());
    return;
  }
  use std::os::fd::FromRawFd as _;
  let fd = unsafe { libc::fcntl(0, libc::F_DUPFD_CLOEXEC, 3) };
  assert!(fd >= 0);
  let input = unsafe { std::fs::File::from_raw_fd(fd) };
  let mut host = LispHost::new();
  run_reader_on_host(&mut host, input, &Scripts::new(()), &HashMap::new(), &[],
    RunOptions { on_error: OnError::Bash, ..Default::default() },
  ).await.unwrap();
  assert_eq!(host.eval_to_json("(std.sh.var \"x\")").unwrap(), JsonValue::from("hello"));
  assert_eq!(host.eval_to_json("after").unwrap(), JsonValue::from(1));
}

/// p1d-a hook: a caller that decided the language (I8/I9) overrides the
/// suffix and `#!` inference, on both the whole-source and streaming paths.
#[tokio::test]
async fn forced_language_overrides_suffix_and_shebang() {
  let forced = |bash, path: &str| RunOptions { bash: Some(bash), source_path: Some(path.into()), ..RunOptions::default() };
  let mut host = LispHost::new();
  run_source_on_host(&mut host, "(let a 1)", &Scripts::new(()), &HashMap::new(), &[], forced(false, "x.sh"))
    .await.unwrap();
  assert_eq!(host.eval_to_json("a").unwrap(), 1);
  let mut host = LispHost::new();
  run_reader_on_host(&mut host, Cursor::new(b"#!/bin/bash\n(let b 2)\n"),
    &Scripts::new(()), &HashMap::new(), &[], forced(false, "-")).await.unwrap();
  assert_eq!(host.eval_to_json("b").unwrap(), 2);
  let mut host = LispHost::new();
  let _ = run_source_on_host(&mut host, "(c=3)", &Scripts::new(()), &HashMap::new(), &[], forced(true, "x.tsh")).await;
  assert!(host.shell_last_statement_bash(), "a forced bash source reads `(` as a subshell");
}

/// A native's status-carrying failure reaches the process status unchanged,
/// through nested calls, and `try` does not swallow it.
#[tokio::test]
async fn status_carrying_native_error_sets_the_process_status() {
  for source in ["(boom)", "(begin (boom) 1)", "(try (boom))"] {
    let mut host = LispHost::new();
    host.register_native_special("boom", |_| Err(LispHostError::Exit { status: 7, message: String::new() }));
    let error = run_source_on_host(&mut host, source, &Scripts::new(()), &HashMap::new(), &[], RunOptions::default())
      .await.unwrap_err();
    assert_eq!(error.process_status(), Some(7), "{source}: {error}");
  }
  let mut host = LispHost::new();
  host.register_native_special("boom", |_| Err(LispHostError::Exit { status: 9, message: "child failed".into() }));
  let error = host.eval_posix_line_async("(boom)").await.unwrap_err();
  assert_eq!(error.process_status(), Some(9), "{error}");
}
