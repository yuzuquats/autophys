use super::super::LispValue;
use super::bash_tests::{bash, host};
use super::*;

#[tokio::test]
async fn compound_status_and_errexit_conditions() {
  let mut host = host();
  for (source, status) in [
    ("if false; then false; fi", 0),
    ("if true; then false; fi", 1),
    ("while false; do false; done", 0),
    ("until true; do false; done", 0),
    ("for x in a b; do false; done", 1),
    ("for x in; do false; done", 0),
    ("case x in y) false ;; esac", 0),
    ("case x in x) false ;; esac", 1),
    ("set -e; if false; then false; else true; fi", 0),
    ("set -e; while false; do false; done", 0),
    ("set -e; false && false; true", 0),
  ] {
    bash(&mut host, source).await.unwrap();
    assert_eq!(host.shell_status(), status, "{source}");
    host.shell_errexit = false;
  }
}

#[tokio::test]
async fn compound_functions_positionals_dynamic_local_and_return() {
  let mut host = host();
  let capture = host.capture_shell_source(
    "set -- a 'b c'; x=global; f() { local x=local; echo \"$#:$1:$2\"; g; return 7; echo bad; }; g() { echo $x; }; f \"$@\"; echo $x; echo $?"
  ).await.unwrap();
  assert_eq!(capture.stdout, b"2:a:b c\nlocal\nglobal\n0\n");
  bash(&mut host, "f").await.unwrap();
  assert_eq!(host.shell_status(), 7);
}

#[tokio::test]
async fn compound_nested_break_continue_and_iterative_deep_loop() {
  let mut host = host();
  let out = host
    .capture_shell_source(
      "for x in a b; do for y in c d; do echo $x$y; continue 2; done; echo bad; done",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"ac\nbc\n");
  let count = Rc::new(std::cell::Cell::new(0));
  let steps = count.clone();
  host.register_native_special("step", move |_| {
    let next = steps.get() + 1;
    steps.set(next);
    if next <= 100_000 {
      Ok(super::super::LispValue::Nil)
    } else {
      Err(LispHostError::Command("finished".into()))
    }
  });
  bash(&mut host, "while step; do :; done").await.unwrap();
  assert_eq!(count.get(), 100_001);
  assert_eq!(host.shell_status(), 0);
}

#[tokio::test]
async fn compound_read_pipes_ifs_backslashes_eof_and_case_quotes() {
  let mut host = host();
  let out = host
    .capture_shell_source("echo -e ' a  b c\\nlast' | while read -r x y; do echo \"$x:$y\"; done")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"a:b c\nlast:\n");
  let out = host
    .capture_shell_source("case a/b in 'a*') echo bad ;; a*) echo yes ;; esac")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"yes\n");
  let out = host
    .capture_shell_source("read -r x <<'EOF'\nvalue\nEOF\necho $x")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"value\n");
}

#[tokio::test]
async fn compound_exit_is_typed_and_stops_source() {
  let mut host = host();
  let error = bash(&mut host, "exit 9\nx=bad").await.unwrap_err();
  assert!(matches!(
    error.kind,
    TshScriptErrorKind::Control(super::super::bash_compound::ControlSignal::Exit(9))
  ));
  assert_eq!(host.shell_status(), 9);
}

#[tokio::test]
async fn compound_case_fallthrough_retest_and_status() {
  let mut host = host();
  let out = host
    .capture_shell_source("case a in a) echo a ;& b) echo b ;;& a*) echo c ;; *) echo bad ;; esac")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"a\nb\nc\n");
  assert_eq!(out.status, 0);
  let out = host
    .capture_shell_source("case .hidden/path in *) echo yes ;; esac")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"yes\n");
}

#[tokio::test]
async fn compound_positional_ifs_empty_fields_shift_and_script_context() {
  let mut host = host();
  host.set_shell_positionals(
    "script.sh".into(),
    vec!["a".into(), "b c".into(), "".into()],
  );
  let out = host.capture_shell_source(
    "echo \"$0:$#:$1\"; for x; do echo \"[$x]\"; done; IFS=:; echo \"$*\"; shift 2; echo \"$#:$1\""
  ).await.unwrap();
  assert_eq!(out.stdout, b"script.sh:3:a\n[a]\n[b c]\n[]\na:b c:\n1:\n");
  host.register_native_special("argc", |args| Ok(LispValue::Integer(args.len() as i64)));
  let out = host
    .capture_shell_source("set --; argc \"$@\"; set -- '' ''; argc \"$@\"")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"0\n2\n");
  let out = host
    .capture_shell_source("set -- a 'b c'; x=\"$@\"; echo \"$x\"")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"a b c\n");
}

#[tokio::test]
async fn compound_function_positional_isolation_and_recursion() {
  let mut host = host();
  host.register_native_special("test_nonempty", |args| {
    if matches!(args.first(), Some(LispValue::String(value)) if !value.is_empty()) {
      Ok(LispValue::Nil)
    } else {
      Err(LispHostError::Command("empty".into()))
    }
  });
  let out = host.capture_shell_source(
    "set -- outer; f() { echo $1; shift; if test_nonempty \"$1\"; then f \"$@\"; fi; }; f a b c; echo $1"
  ).await.unwrap();
  assert_eq!(out.stdout, b"a\nb\nc\nouter\n");
}

#[tokio::test]
async fn compound_read_backslash_continuation_remainder_and_partial_eof() {
  let mut host = host();
  let out = host
    .capture_shell_source("read a b <<'EOF'\n one\\ two three\\\n four five\nEOF\necho \"$a:$b\"")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"one two:three four five\n");
  host.replace_shell_stdin(Some(b"partial".to_vec()));
  bash(&mut host, "read x").await.unwrap();
  assert_eq!(host.shell_status(), 1);
  let out = host.capture_shell_source("echo $x").await.unwrap();
  assert_eq!(out.stdout, b"partial\n");
  host.replace_shell_stdin(None);
  let out = host
    .capture_shell_source("IFS=:; read a b <<< 'one:two:three'; echo \"$a|$b\"")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"one|two:three\n");
}

#[tokio::test]
async fn compound_read_refuses_unknown_flags_and_errexit_body_stops() {
  let mut host = host();
  bash(&mut host, "read -z x").await.unwrap();
  assert_eq!(host.shell_status(), 2);
  for source in [
    "set -e; if true; then false; fi",
    "set -e; for x in a; do false; done",
    "set -e; f() { false; }; f",
    "set -e; case a in a) false ;; esac",
  ] {
    assert!(
      matches!(
        bash(&mut host, source).await.unwrap_err().kind,
        TshScriptErrorKind::BashStatus(1)
      ),
      "{source}"
    );
  }
  bash(
    &mut host,
    "set -e; f() { false; echo yes; }; if f; then true; fi",
  )
  .await
  .unwrap();
  assert_eq!(host.shell_status(), 0);
}

#[tokio::test]
async fn compound_redirected_groups_loops_and_function_bodies() {
  let mut host = host();
  host.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .truncate(!read && !append)
      .append(!read && append)
      .open(path)
      .map_err(|error| LispHostError::Command(error.to_string()))
  }));
  let path = std::env::temp_dir().join(format!("tento-04r-{}", std::process::id()));
  let quoted = serde_json::to_string(&path.to_string_lossy()).unwrap();
  let out = host
    .capture_shell_source(&format!(
      "{{ for x in a b; do echo $x; done; }} >{quoted}; while read x; do echo $x; done <{quoted}"
    ))
    .await
    .unwrap();
  assert_eq!(out.stdout, b"a\nb\n");
  let out = host
    .capture_shell_source(&format!(
      "f() {{ echo called; }} >{quoted}; echo before; f; std.io.stdin_text <{quoted}"
    ))
    .await
    .unwrap();
  assert_eq!(out.stdout, b"before\ncalled\n\n");
  std::fs::remove_file(path).unwrap();
}

#[test]
fn compound_chunker_preserves_lisp_forms_and_closes_nested_shell_bodies() {
  let source =
    "for x in a b\ndo\nif true; then\necho $x\nfi\ndone\necho after\n(let f\n (lambda () 'if))";
  let chunks: Vec<_> = coalesce_balanced_lines(source).collect();
  assert_eq!(chunks.len(), 3);
  assert_eq!(chunks[0].0, 1);
  assert!(chunks[0].1.ends_with("done"));
  assert_eq!(chunks[1].0, 7);
  assert_eq!(chunks[2].0, 8);
}

#[tokio::test]
async fn compound_read_last_field_separator_and_remainder() {
  let mut host = host();
  for (input, expected) in [
    ("a:", "a|"),
    ("a:b:", "a|b"),
    ("a:b:c:", "a|b:c:"),
    ("a:::", "a|::"),
  ] {
    let out = host
      .capture_shell_source(&format!("IFS=:; read a b <<< '{input}'; echo \"$a|$b\""))
      .await
      .unwrap();
    assert_eq!(
      String::from_utf8(out.stdout).unwrap(),
      format!("{expected}\n")
    );
  }
}

#[tokio::test]
async fn compound_pipeline_shell_scope_and_exit_are_isolated() {
  let mut host = host();
  let out = host.capture_shell_source(
    "x=outer; set -- original; { x=inner; set -- changed; echo data; } | while read x; do echo $x; done; echo $x:$1"
  ).await.unwrap();
  assert_eq!(out.stdout, b"data\nouter:original\n");
  let out = host
    .capture_shell_source("{ echo before; exit 9; echo bad; } | read x; echo $x")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"outer\n");
  let out = host
    .capture_shell_source("for x in a; do echo $x; done | { read x; exit 7; }; echo after")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"after\n");
}

#[tokio::test]
async fn compound_for_data_words_preserve_options_and_case_word_is_unsplit() {
  let mut host = host();
  let out = host.capture_shell_source(
    "for x in --mode=value --json --help; do echo \"$x\"; done; x='a b'; case $x in 'a b') echo yes ;; *) echo bad ;; esac; case --mode=value in --mode=*) echo option ;; esac"
  ).await.unwrap();
  assert_eq!(out.stdout, b"--mode=value\n--json\n--help\nyes\noption\n");
}

#[tokio::test]
async fn compound_async_host_call_uses_function_arguments_and_status() {
  let mut host = host();
  host
    .capture_shell_source("f() { echo \"$1\"; return 7; }")
    .await
    .unwrap();
  let bytes = Rc::new(std::cell::RefCell::new(Vec::new()));
  let written = bytes.clone();
  host.set_shell_byte_output(Rc::new(move |value| {
    written.borrow_mut().extend_from_slice(value)
  }));
  assert_eq!(
    host.eval_posix_line_async("f argument").await.unwrap(),
    JsonValue::Null
  );
  assert_eq!(host.shell_status(), 7);
  assert_eq!(*bytes.borrow(), b"argument\n");
}

#[tokio::test]
async fn compound_expansion_captures_words_and_case_patterns_lazily() {
  let mut host = host();
  let out = host.capture_shell_source(
    "for x in $(echo 'a b'); do echo \"[$x]\"; done; case $(echo a) in $(echo a)) echo match ;& $(echo ignored >&2)) echo fall ;; esac"
  ).await.unwrap();
  assert_eq!(out.stdout, b"[a]\n[b]\nmatch\nfall\n");
  assert!(host.take_shell_diagnostics().is_empty());
}

#[tokio::test]
async fn compound_function_and_set_arguments_are_verbatim_words() {
  let mut host = host();
  let out = host.capture_shell_source(
    "f(){ echo \"$#:$1:$2:$3\"; }; f --key=value --json --help; set -- --key=value --json --help; f \"$@\""
  ).await.unwrap();
  assert_eq!(
    out.stdout,
    b"3:--key=value:--json:--help\n3:--key=value:--json:--help\n"
  );
  let out = host
    .capture_shell_source("f --key=value --json --help")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"3:--key=value:--json:--help\n");
  let out = host
    .capture_shell_source("cmd=f; $cmd --key=value --json --help")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"3:--key=value:--json:--help\n");
}

#[tokio::test]
async fn compound_read_ifs_prefix_is_temporary_and_utf8_delimiters_are_characters() {
  let mut host = host();
  let out = host
    .capture_shell_source(
      "IFS=' '; IFS=é read a b <<< 'oneétwoéthree'; echo \"$a|$b\"; echo \"[$IFS]\"",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"one|two\xc3\xa9three\n[ ]\n");
}

#[tokio::test]
async fn compound_locals_restore_exported_values_and_read_updates_exports() {
  let mut host = host();
  let map = tento_env::EnvMap::new();
  map.set("x", "outer");
  host.register_native_special("child_x", |_| {
    Ok(LispValue::String(tento_env::effective_var("x").unwrap().into()))
  });
  let out = tento_env::with_env_map_async(
    map.clone(),
    host.capture_shell_source(
      "x=outer; f(){ local x=inner; child_x; return 0; }; f; child_x; read x <<<new; child_x",
    ),
  )
  .await
  .unwrap();
  assert_eq!(out.stdout, b"inner\nouter\nnew\n");
  assert_eq!(map.get("x").as_deref(), Some("new"));
}

#[tokio::test]
async fn compound_repeated_negation_preserves_status_and_errexit_exemption() {
  let mut host = host();
  let out = host
    .capture_shell_source("set -e; if ! ! false; then echo bad; else echo yes; fi")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"yes\n");
}

#[tokio::test]
async fn compound_declaration_words_expand_only_nonassignments_normally() {
  let mut host = host();
  let out = host.capture_shell_source(
    "f(){ local foo=$1; echo \"$foo\"; }; f 'void *'"
  ).await.unwrap();
  assert_eq!(out.stdout, b"void *\n");
  let out = host.capture_shell_source(
    "x='a b'; f(){ names='first second'; local foo=$x $names; echo \"$foo\"; echo \"[$first][$second]\"; }; f"
  ).await.unwrap();
  assert_eq!(out.stdout, b"a b\n[][]\n");
}

#[tokio::test]
async fn compound_assignment_substitution_status_survives_assignment() {
  let mut host = host();
  let out = host.capture_shell_source(
    "x=$(false); echo $?; x=plain; echo $?; x=$(true)$(false); echo $?; x=$(false)$(true); echo $?; f(){ local x; x=$(false); echo $?; }; f"
  ).await.unwrap();
  assert_eq!(out.stdout, b"1\n0\n1\n0\n1\n");
  let error = bash(&mut host, "set -e; x=$(false); echo missed").await.unwrap_err();
  assert!(matches!(error.kind, TshScriptErrorKind::BashStatus(1)));
}

#[tokio::test]
async fn compound_open_failure_has_only_target_and_strerror() {
  let mut host = host();
  host.set_shell_file_opener(Rc::new(|_, _, _| {
    Err(LispHostError::Command("std.io.open_write: Operation not permitted (os error 1)".into()))
  }));
  let out = host.capture_shell_source(
    "{ echo out; echo err >&2; } 2>&1 >/dev/null | { read -r message; echo \"$message\"; }"
  ).await.unwrap();
  assert_eq!(out.stdout, b"tsh: line 1: /dev/null: Operation not permitted\n");
  assert!(host.take_shell_diagnostics().is_empty());
}

#[tokio::test]
async fn compound_scalar_declare_assigns_glob_literal_and_keeps_function_scope() {
  let mut host = host();
  let out = host.capture_shell_source(
    "x='void *'; declare foo=$x; echo \"$foo\"; f(){ declare foo=$1; echo \"$foo\"; }; f 'local *'; echo \"$foo\""
  ).await.unwrap();
  assert_eq!(out.stdout, b"void *\nlocal *\nvoid *\n");
}

#[tokio::test]
async fn compound_unquoted_star_keeps_nonempty_ifs_join_then_split() {
  let mut host = host();
  host.register_native_special("args", |args| Ok(LispValue::List(tento_lisp::List { items: args.into() })));
  let out = host.capture_shell_source(
    "set -- a '' b; IFS=:; args $*; IFS=''; args $*; args $@"
  ).await.unwrap();
  // Inspect argv directly, avoiding formatter dependence for list values.
  host.set_shell_positionals("tsh".into(), vec!["a".into(), "".into(), "b".into()]);
  host.eval_posix_line("IFS=:").unwrap();
  assert_eq!(host.eval_posix_line("args $*").unwrap(), serde_json::json!(["a", "", "b"]));
  host.eval_posix_line("IFS=''").unwrap();
  assert_eq!(host.eval_posix_line("args $*").unwrap(), serde_json::json!(["a", "b"]));
  assert_eq!(host.eval_posix_line("args $@").unwrap(), serde_json::json!(["a", "b"]));
  assert_eq!(out.status, 0);
}

#[tokio::test]
async fn assignment_word_list_remembers_last_substitution_across_plain_bindings() {
  let mut host = host();
  let out = host.capture_shell_source(
    "a=$(false) b=literal; echo $?; a=$(false) b=$?; echo \"$?:$b\"; a=$(false) b=$(true) c=literal; echo $?"
  ).await.unwrap();
  assert_eq!(out.stdout, b"1\n1:1\n0\n");
  let error = bash(&mut host, "set -e; a=$(false) b=$(true); echo yes").await;
  assert!(error.is_ok(), "errexit tests the assignment command's final status");
}

#[tokio::test]
async fn dev_descriptor_aliases_duplicate_without_opening_the_alias_path() {
  let mut host = host();
  let opens = Rc::new(std::cell::Cell::new(0));
  let count = opens.clone();
  host.set_shell_file_opener(Rc::new(move |path, read, append| {
    assert!(!path.starts_with("/dev/"), "descriptor aliases bypass path opens");
    count.set(count.get() + 1);
    std::fs::OpenOptions::new().read(read).write(!read).create(!read)
      .truncate(!read && !append).append(!read && append).open(path)
      .map_err(|error| LispHostError::Command(error.to_string()))
  }));
  let out = host.capture_shell_source(
    "echo -n hi >/dev/stdout; { echo -n err >/dev/stderr; } 2>&1"
  ).await.unwrap();
  assert_eq!(out.stdout, b"hierr");
  assert_eq!(opens.get(), 0);
  host.replace_shell_stdin(Some(b"input".to_vec()));
  let out = host.capture_shell_source("std.io.stdin_text </dev/stdin").await.unwrap();
  assert_eq!(out.stdout, b"input\n");
  host.replace_shell_stdin(None);
  let path = std::env::temp_dir().join(format!("tento-04r2-fd-{}", std::process::id()));
  let quoted = serde_json::to_string(&path.to_string_lossy()).unwrap();
  host.capture_shell_source(&format!("echo -n hi 3>{quoted} >/dev/fd/3")).await.unwrap();
  assert_eq!(std::fs::read(&path).unwrap(), b"hi");
  assert_eq!(opens.get(), 1);
  std::fs::remove_file(path).unwrap();
  host.collect_shell_diagnostics();
  let out = host.capture_shell_source("echo bad 3>&- >/dev/fd/3").await.unwrap();
  assert_eq!(out.status, 1);
  assert!(out.stdout.is_empty());
  assert!(host.take_shell_diagnostics().iter().any(|d| d == "tsh: line 1: /dev/fd/3: Bad file descriptor"));
}

#[tokio::test]
async fn function_external_leaf_receives_binary_pipeline_input_without_capture() {
  use super::super::interp::{AsyncCommandFut, ExternalCommands, ExternalLookup};
  struct BytesProgram(Rc<std::cell::RefCell<Vec<Vec<u8>>>>);
  impl ExternalCommands for BytesProgram {
    fn lookup(&self, head: &str) -> ExternalLookup {
      if head == "bytes-program" { ExternalLookup::Runs } else { ExternalLookup::NotFound }
    }
    fn suggest(&self, _: &str) -> Option<String> { None }
    fn run(&self, _: Vec<String>) -> AsyncCommandFut {
      Box::pin(async { Err(Error::Other(anyhow::anyhow!("buffered stdin must use the pipeline door"))) })
    }
    fn run_pipeline_with_io(
      &self, argv: Vec<Vec<String>>, input: Option<Vec<u8>>, capture: bool,
      _: Vec<Option<super::super::ShellIo>>,
    ) -> super::super::PipelineFuture {
      let inputs = self.0.clone();
      Box::pin(async move {
        assert_eq!(argv[0][0], "bytes-program");
        assert!(!capture);
        inputs.borrow_mut().push(input.expect("function body retains the pipe input"));
        Ok(super::super::ShellCapture { stdout: Vec::new(), status: 0, statuses: Vec::new(), start_errors: Vec::new() })
      })
    }
  }
  let mut host = host();
  let inputs = Rc::new(std::cell::RefCell::new(Vec::new()));
  host.set_external_commands(Rc::new(BytesProgram(inputs.clone())));
  bash(&mut host, "show_bytes(){ bytes-program; }; echo -n $'\\c0\\c9-\\ca\\cz\\cA\\cZ\\c-\\c+\\c\"' | show_bytes").await.unwrap();
  assert_eq!(*inputs.borrow(), vec![vec![0x10, 0x19, b'-', 0x01, 0x1a, 0x01, 0x1a, 0x0d, 0x0b, 0x02]]);
  assert_eq!(host.shell_status(), 0);
}
