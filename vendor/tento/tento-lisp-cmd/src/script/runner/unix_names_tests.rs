use super::super::interp::{AsyncCommandFut, ExternalCommands, ExternalLookup};
use super::*;

struct Utility;
impl ExternalCommands for Utility {
  fn lookup(&self, name: &str) -> ExternalLookup {
    if name == "ls" {
      ExternalLookup::Runs
    } else {
      ExternalLookup::NotFound
    }
  }
  fn run(&self, _: Vec<String>) -> AsyncCommandFut {
    Box::pin(async { Ok(JsonValue::Null) })
  }
  fn run_pipeline(
    &self,
    _: Vec<Vec<String>>,
    _: Option<Vec<u8>>,
    _: bool,
  ) -> super::super::PipelineFuture {
    Box::pin(async {
      Ok(super::super::ShellCapture {
        stdout: b"plain\n".to_vec(),
        status: 0,
        statuses: Vec::new(),
        start_errors: Vec::new(),
      })
    })
  }
  fn run_pipeline_with_io(
    &self,
    argv: Vec<Vec<String>>,
    input: Option<Vec<u8>>,
    capture: bool,
    _: Vec<Option<super::super::ShellIo>>,
  ) -> super::super::PipelineFuture {
    self.run_pipeline(argv, input, capture)
  }
  fn suggest(&self, _: &str) -> Option<String> {
    None
  }
}

#[tokio::test]
async fn unix_names_destination_matrix_and_each_prompt_line() {
  for prompt in [false, true] {
    for (source, shaped) in [
      ("ls", true),
      ("ls; ls", true),
      ("true && ls", true),
      ("false || ls", true),
      ("ls; true", false),
      ("ls | ls", false),
      ("saved=$(ls)", false),
      ("ls >/dev/null", false),
      ("ls -la", false),
      ("ls\nls", true),
    ] {
      let mut host = LispHost::new();
      let calls = Rc::new(std::cell::Cell::new(0));
      let count = calls.clone();
      host.register_native_special("std.fixture.list", move |_| {
        count.set(count.get() + 1);
        Ok(super::super::LispValue::String("shaped".into()))
      });
      host.eval_stmt("(let ls std.fixture.list)").unwrap();
      host.register_shell_alias("ls", "std.fixture.list");
      host.set_shell_command_admission(Rc::new(|_, args| args.is_empty()));
      host.set_external_commands(Rc::new(Utility));
      host.set_shell_file_opener(Rc::new(|path, read, append| {
        std::fs::OpenOptions::new()
          .read(read)
          .write(!read)
          .append(append)
          .open(path)
          .map_err(|error| super::super::LispHostError::Command(error.to_string()))
      }));
      run_source_on_host(
        &mut host,
        source,
        &Scripts::new(()),
        &HashMap::new(),
        &[],
        RunOptions {
          on_error: OnError::Bash,
          prompt,
          ..RunOptions::default()
        },
      )
      .await
      .unwrap();
      assert_eq!(
        calls.get(),
        if prompt && shaped {
          if source == "ls\nls" { 2 } else { 1 }
        } else {
          0
        },
        "prompt={prompt}: {source}"
      );
      if source == "saved=$(ls)" {
        assert_eq!(host.eval_to_json("saved").unwrap(), "plain");
      }
      // The shell dispatch must never replace the Lisp binding.
      assert_eq!(host.eval_to_json("(ls)").unwrap(), "shaped");
    }
  }
}

/// At the prompt, with no utility on PATH and arguments the admission does
/// not take, the declaration answers with the utility's bytes; a script gets
/// `command not found`.
#[tokio::test]
async fn unix_names_missing_utility_uses_plain_projection_only_at_the_prompt() {
  let mut host = LispHost::new();
  host.register_native_special("std.fixture.list", |_| {
    Ok(super::super::value_from_json(
      &serde_json::json!({"datatype":"fs.dir/v1", "records":[{"name":"a"},{"name":"d/"}]}),
    ))
  });
  host.register_shell_alias("ls", "std.fixture.list");
  host.set_external_commands(Rc::new(Path(&[])));
  let (status, stdout, _) = run_line(&mut host, "ls", true).await;
  assert_eq!((status, stdout.as_str()), (0, "a\nd\n"));
  let (status, stdout, _) = run_line(&mut host, "ls", false).await;
  assert_eq!((status, stdout.as_str()), (127, ""));
}

#[tokio::test]
async fn bash_echo_bytes_and_noop_do_not_use_typed_echo() {
  let mut host = LispHost::new();
  for (source, expected) in [
    ("echo -n hi", b"hi".as_slice()),
    (r#"echo -e 'a\nb'"#, b"a\nb\n".as_slice()),
    (r#"echo -e -E 'a\nb'"#, b"a\\nb\n".as_slice()),
    ("echo --help", b"--help\n".as_slice()),
    ("echo", b"\n".as_slice()),
    (": whatever", b"".as_slice()),
  ] {
    let captured = host.capture_shell_source(source).await.unwrap();
    assert_eq!(captured.stdout, expected, "{source}");
    assert_eq!(captured.status, 0);
  }
}

#[tokio::test]
async fn bash_builtin_effects_replay_once_per_unit() {
  let mut host = LispHost::new();
  let calls = Rc::new(std::cell::Cell::new(0));
  let count = calls.clone();
  host.set_shell_builtin(Rc::new(move |argv, _| {
    if argv[0] != "rm" {
      return None;
    }
    count.set(count.get() + 1);
    Some(Ok(super::super::ShellBuiltinOutput::default()))
  }));
  for _ in 0..2 {
    host.begin_shell_unit(17);
    run_source_on_host(
      &mut host,
      "rm operand",
      &Scripts::new(()),
      &HashMap::new(),
      &[],
      RunOptions {
        on_error: OnError::Bash,
        ..Default::default()
      },
    )
    .await
    .unwrap();
  }
  assert_eq!(calls.get(), 1);
  host.begin_shell_unit(18);
  run_source_on_host(
    &mut host,
    "rm operand",
    &Scripts::new(()),
    &HashMap::new(),
    &[],
    RunOptions {
      on_error: OnError::Bash,
      ..Default::default()
    },
  )
  .await
  .unwrap();
  assert_eq!(calls.get(), 2);
}

#[tokio::test]
async fn async_lisp_alias_stays_typed() {
  let mut host = LispHost::new();
  host.register_native_special("std.fixture.list", |_| {
    Ok(super::super::LispValue::String("shaped".into()))
  });
  host.eval_stmt("(let ls std.fixture.list)").unwrap();
  host.register_shell_alias("ls", "std.fixture.list");
  host.set_external_commands(Rc::new(Utility));
  assert_eq!(host.eval_posix_line_async("(ls)").await.unwrap(), "shaped");
}

#[tokio::test]
async fn async_lisp_alias_keeps_lisp_strings_at_each_source_door() {
  let mut host = LispHost::new();
  host.register_native_special("std.fixture.echo", |args| Ok(args[0].clone()));
  host.eval_stmt("(let echo std.fixture.echo)").unwrap();
  host.register_shell_alias("echo", "std.fixture.echo");
  host.set_external_commands(Rc::new(Utility));
  let source = r#"  (echo "a\nb")"#;
  assert_eq!(host.eval_posix_line_async(source).await.unwrap(), "a\nb");
  assert_eq!(host.eval_prompt_source_async(source).await.unwrap(), "a\nb");
  assert_eq!(
    run_source_on_host(
      &mut host,
      source,
      &Scripts::new(()),
      &HashMap::new(),
      &[],
      RunOptions {
        on_error: OnError::Bash,
        ..Default::default()
      }
    )
    .await
    .unwrap(),
    Some(JsonValue::String("a\nb".into()))
  );
}

#[tokio::test]
async fn bash_inline_comments_use_the_flow_reader_even_without_an_operator() {
  let mut host = LispHost::new();
  for (source, expected) in [
    ("echo keep # drop this", "keep\n"),
    ("echo 'keep # quoted'", "keep # quoted\n"),
    (r#"echo keep\#escaped"#, "keep#escaped\n"),
    ("echo keep#word", "keep#word\n"),
  ] {
    assert_eq!(
      host.capture_shell_source(source).await.unwrap().stdout,
      expected.as_bytes(),
      "{source}"
    );
  }
}

#[tokio::test]
async fn bash_env_uses_the_utility_while_lisp_env_keeps_its_binding() {
  struct EnvUtility;
  impl ExternalCommands for EnvUtility {
    fn lookup(&self, name: &str) -> ExternalLookup {
      if name == "env" {
        ExternalLookup::Runs
      } else {
        ExternalLookup::NotFound
      }
    }
    fn run(&self, _: Vec<String>) -> AsyncCommandFut {
      Box::pin(async { panic!("env must use the byte utility door") })
    }
    fn run_pipeline_with_io(
      &self,
      argv: Vec<Vec<String>>,
      _: Option<Vec<u8>>,
      _: bool,
      _: Vec<Option<super::super::ShellIo>>,
    ) -> super::super::PipelineFuture {
      assert_eq!(
        argv,
        vec![vec![
          "env",
          "-u",
          "HOME",
          "sh",
          "-c",
          "echo ${HOME:-nohome}"
        ]]
      );
      Box::pin(async {
        Ok(super::super::ShellCapture {
          stdout: b"nohome\n".to_vec(),
          status: 0,
          statuses: Vec::new(),
          start_errors: Vec::new(),
        })
      })
    }
    fn suggest(&self, _: &str) -> Option<String> {
      None
    }
  }
  let mut host = LispHost::new();
  host.register_native_special("env", |_| {
    Ok(super::super::LispValue::String("typed".into()))
  });
  host.set_external_commands(Rc::new(EnvUtility));
  assert_eq!(
    host
      .capture_shell_source("env -u HOME sh -c 'echo ${HOME:-nohome}'")
      .await
      .unwrap()
      .stdout,
    b"nohome\n"
  );
  assert_eq!(host.eval_posix_line_async("(env)").await.unwrap(), "typed");
  assert_eq!(
    host
      .eval_posix_line_async("env -u HOME sh -c 'echo ${HOME:-nohome}'")
      .await
      .unwrap(),
    JsonValue::Null
  );
  assert_eq!(
    host
      .eval_posix_argv_async(
        vec!["env", "-u", "HOME", "sh", "-c", "echo ${HOME:-nohome}"]
          .into_iter()
          .map(str::to_string)
          .collect()
      )
      .await
      .unwrap(),
    JsonValue::Null
  );
}

#[tokio::test]
async fn bash_env_missing_does_not_read_the_lisp_environment() {
  let mut host = LispHost::new();
  host.register_native_special("env", |_| {
    panic!("a Bash env call must not read the Lisp environment")
  });
  host.set_external_commands(Rc::new(Utility));
  host.collect_shell_diagnostics();
  let captured = host.capture_shell_source("env -u HOME").await.unwrap();
  assert_eq!(captured.status, 127);
  assert!(captured.stdout.is_empty());
  assert_eq!(
    host.take_shell_diagnostics(),
    vec!["tsh: line 1: env: command not found"]
  );
}

#[tokio::test]
async fn prompt_failure_api_keeps_status_independent_of_presentation() {
  let mut host = LispHost::new();
  for mode in ["off", "mark", "status"] {
    host
      .eval_stmt(&format!("(tsh.failure-display \"{mode}\")"))
      .unwrap();
    for (source, status) in [("false", 1), ("set -e; false", 1)] {
      let error = host.eval_prompt_source_async(source).await.unwrap_err();
      assert_eq!(error.process_status(), Some(status), "{mode}: {source}");
      assert_eq!(host.shell_status(), status);
    }
    assert_eq!(
      host.eval_prompt_source_async("").await.unwrap(),
      JsonValue::Null
    );
    assert_eq!(
      host.eval_prompt_source_async("true").await.unwrap(),
      JsonValue::Null
    );
    host.eval_prompt_source_async("set +e").await.unwrap();
    assert_eq!(
      host
        .eval_prompt_source_async("false\n(std.sh.status)")
        .await
        .unwrap(),
      1
    );
  }
}

// ---------------------------------------------------------------------------
// Prelude declarations (operator rulings 18/19, 2026-10-06): `(let ls
// std.fs.list_dir)` is an ordinary binding; at the interactive prompt it is
// also a command, looked up function → builtin → declaration → PATH. Scripts,
// pipes, captures and redirects always use PATH.

/// An external host with the given programs on PATH.
struct Path(&'static [&'static str]);
impl ExternalCommands for Path {
  fn lookup(&self, name: &str) -> ExternalLookup {
    if self.0.contains(&name) { ExternalLookup::Runs } else { ExternalLookup::NotFound }
  }
  fn run(&self, _: Vec<String>) -> AsyncCommandFut {
    Box::pin(async { Ok(JsonValue::Null) })
  }
  fn run_pipeline(&self, _: Vec<Vec<String>>, _: Option<Vec<u8>>, _: bool) -> super::super::PipelineFuture {
    Box::pin(async {
      Ok(super::super::ShellCapture { stdout: b"utility\n".to_vec(), status: 0, statuses: Vec::new(), start_errors: Vec::new() })
    })
  }
  fn run_pipeline_with_io(
    &self,
    argv: Vec<Vec<String>>,
    input: Option<Vec<u8>>,
    capture: bool,
    _: Vec<Option<super::super::ShellIo>>,
  ) -> super::super::PipelineFuture {
    self.run_pipeline(argv, input, capture)
  }
  fn suggest(&self, _: &str) -> Option<String> {
    None
  }
}

/// A host whose seed declares `ls` (and `other` is a second typed command),
/// counting the typed calls, with `path` on PATH.
fn declaring_host(path: &'static [&'static str]) -> (LispHost, Rc<std::cell::Cell<usize>>) {
  let mut host = LispHost::new();
  let calls = Rc::new(std::cell::Cell::new(0));
  for name in ["std.fixture.list", "std.fixture.other"] {
    let count = calls.clone();
    host.register_native_special(name, move |_| {
      count.set(count.get() + 1);
      Ok(super::super::LispValue::String("typed".into()))
    });
  }
  host.set_shell_command_admission(Rc::new(|_, args| args.is_empty()));
  host.set_external_commands(Rc::new(Path(path)));
  assert!(host.eval_seed("(let ls std.fixture.list)", &[]).is_empty());
  (host, calls)
}

/// Run `source` as a prompt line or a script; its status, stdout bytes and
/// diagnostics.
async fn run_line(host: &mut LispHost, source: &str, prompt: bool) -> (i32, String, Vec<String>) {
  let out = Rc::new(std::cell::RefCell::new(Vec::new()));
  let sink = out.clone();
  host.set_shell_byte_output(Rc::new(move |bytes| sink.borrow_mut().extend_from_slice(bytes)));
  host.collect_shell_diagnostics();
  let _ = run_source_on_host(
    host,
    source,
    &Scripts::new(()),
    &HashMap::new(),
    &[],
    RunOptions { on_error: OnError::Bash, prompt, ..RunOptions::default() },
  )
  .await;
  let stdout = String::from_utf8_lossy(&out.borrow()).into_owned();
  (host.shell_status(), stdout, host.take_shell_diagnostics())
}

#[tokio::test]
async fn a_declaration_is_a_command_only_at_the_prompt() {
  let (mut host, calls) = declaring_host(&["ls"]);
  run_line(&mut host, "ls", true).await;
  assert_eq!(calls.get(), 1, "the prompt renders through the declaration");
  for script in ["ls", "ls | ls", "x=$(ls)", "ls >/dev/null"] {
    run_line(&mut host, script, false).await;
    assert_eq!(calls.get(), 1, "a script runs PATH's ls: {script}");
  }
  for prompt_line in ["ls | ls", "x=$(ls)", "ls >/dev/null", "ls -l"] {
    run_line(&mut host, prompt_line, true).await;
    assert_eq!(calls.get(), 1, "an unrendered or unadmitted prompt line runs PATH's ls: {prompt_line}");
  }
  // The Lisp name is an ordinary binding everywhere.
  assert_eq!(host.eval_to_json("(ls)").unwrap(), "typed");
}

#[tokio::test]
async fn a_missing_utility_outside_the_prompt_is_command_not_found() {
  let (mut host, calls) = declaring_host(&[]);
  for script in ["ls", "ls | ls", "x=$(ls)"] {
    let (status, _, diagnostics) = run_line(&mut host, script, false).await;
    assert_eq!(status, 127, "{script}: {diagnostics:?}");
    assert!(diagnostics.iter().any(|d| d.ends_with("ls: command not found")), "{script}: {diagnostics:?}");
  }
  assert_eq!(calls.get(), 0, "no silent stand-in");
  // At the prompt the declaration sits before PATH.
  let (status, _, _) = run_line(&mut host, "ls", true).await;
  assert_eq!((status, calls.get()), (0, 1));
}

#[tokio::test]
async fn command_and_backslash_always_run_the_utility() {
  let (mut host, calls) = declaring_host(&["ls"]);
  for line in ["command ls", "\\ls", "'ls'", "c=ls; $c"] {
    let (status, _, diagnostics) = run_line(&mut host, line, true).await;
    assert_eq!(status, 0, "{line}: {diagnostics:?}");
    assert_eq!(calls.get(), 0, "{line} runs the raw utility");
  }
  let (mut host, calls) = declaring_host(&[]);
  let (status, _, _) = run_line(&mut host, "command ls", true).await;
  assert_eq!((status, calls.get()), (127, 0), "command never falls back to the declaration");
}

#[tokio::test]
async fn functions_and_builtins_come_before_a_declaration() {
  let (mut host, calls) = declaring_host(&["ls"]);
  run_line(&mut host, "ls() { echo fn; }", true).await;
  let (_, stdout, _) = run_line(&mut host, "ls", true).await;
  assert_eq!((stdout.as_str(), calls.get()), ("fn\n", 0));
  // `echo` is a builtin: its declaration is a Lisp name only.
  host.register_native_special("std.fixture.echo", |_| Ok(super::super::LispValue::String("typed".into())));
  host.eval_stmt("(let echo std.fixture.echo)").unwrap();
  let (_, stdout, _) = run_line(&mut host, "echo hi", true).await;
  assert_eq!(stdout, "hi\n");
}

#[tokio::test]
async fn an_rc_let_overrides_or_removes_a_declaration() {
  let (mut host, calls) = declaring_host(&[]);
  host.eval_stmt("(let ls std.fixture.other)").unwrap();
  run_line(&mut host, "ls", true).await;
  assert_eq!(calls.get(), 1, "the override answers");
  let (_, stdout, _) = run_line(&mut host, "type ls", true).await;
  assert_eq!(stdout, "ls is declared in this session (std.fixture.other)\n");
  // Bound to data, `ls` is no command at all.
  host.eval_stmt("(let ls 5)").unwrap();
  let (status, _, _) = run_line(&mut host, "ls", true).await;
  assert_eq!((status, calls.get()), (127, 1));
  // A user's new declaration works the same way.
  host.eval_stmt("(let lister std.fixture.list)").unwrap();
  run_line(&mut host, "lister", true).await;
  assert_eq!(calls.get(), 2);
}

#[tokio::test]
async fn type_reports_a_declaration_only_at_the_prompt() {
  let (mut host, _) = declaring_host(&["ls"]);
  let (status, stdout, _) = run_line(&mut host, "type ls", true).await;
  assert_eq!((status, stdout.as_str()), (0, "ls is declared in the prelude (std.fixture.list)\n"));
  let (_, stdout, _) = run_line(&mut host, "type -t ls", true).await;
  assert_eq!(stdout, "declared\n");
  let (_, stdout, _) = run_line(&mut host, "type ls", false).await;
  assert!(!stdout.contains("declared"), "a script sees PATH only: {stdout}");
  let (_, stdout, _) = run_line(&mut host, "command -v ls", true).await;
  assert!(!stdout.contains("declared"), "command -v reports the PATH file: {stdout}");
}

#[tokio::test]
async fn imports_and_tsh_names_bind_lisp_names_only() {
  let (mut host, calls) = declaring_host(&[]);
  host.register_native_special("tsh.fixture", |_| Ok(super::super::LispValue::String("tsh".into())));
  assert!(host.eval_seed("(use std.fixture.list as: lister)\n(let plugins tsh.fixture)\n(let setup (lambda () 1))", &[]).is_empty());
  for word in ["lister", "plugins", "setup"] {
    let (status, _, diagnostics) = run_line(&mut host, word, true).await;
    assert_eq!(status, 127, "{word} is no command word: {diagnostics:?}");
  }
  assert_eq!(calls.get(), 0);
  assert_eq!(host.eval_to_json("(lister)").unwrap(), "typed");
  assert_eq!(host.eval_to_json("(plugins)").unwrap(), "tsh");
}


/// An older prelude's `(let ls std.fs.list_dir)` binds a retired command's
/// bare name, the replacement partially applied: it still declares `ls`, and
/// the prompt runs the replacement with the leading arguments first, `--help`
/// included.
#[tokio::test]
async fn a_retired_commands_bare_name_still_declares_its_word() {
  for path in [&[][..], &["ls"][..]] {
    let mut host = LispHost::new();
    let calls: Rc<std::cell::RefCell<Vec<Vec<String>>>> = Rc::default();
    let record = calls.clone();
    host.register_native_special("std.coreutil.ls", move |args| {
      let words = args.iter().map(|arg| match arg {
        super::super::LispValue::String(word) => word.to_string(),
        other => format!("{other:?}"),
      });
      record.borrow_mut().push(words.collect());
      Ok(super::super::LispValue::String("typed".into()))
    });
    host.add_deprecated_call("std.fs.list_dir", "std.coreutil.ls", &["-l"]);
    host.set_shell_command_admission(Rc::new(|_, args| args.is_empty()));
    host.set_external_commands(Rc::new(Path(path)));
    let diagnostics = host.eval_seed("(let ls std.fs.list_dir)", &[]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(host.declared_target("ls").as_deref(), Some("std.fs.list_dir"));
    for line in ["ls", "ls --help"] {
      let (status, _, diagnostics) = run_line(&mut host, line, true).await;
      assert_eq!(status, 0, "{line} on PATH {path:?}: {diagnostics:?}");
    }
    assert_eq!(*calls.borrow(), [vec!["-l"], vec!["-l", "--help"]], "PATH {path:?}");
    // The embedder's prompt door reaches it too.
    assert_eq!(host.eval_prompt_source_async("ls --help").await.unwrap(), "typed");
    assert_eq!(calls.borrow().last().unwrap(), &["-l", "--help"]);
  }
}
