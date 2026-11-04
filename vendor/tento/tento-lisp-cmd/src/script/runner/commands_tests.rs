use super::bash_tests::{bash, host};

fn redirection_temp_path(name: &str) -> std::path::PathBuf {
  std::env::temp_dir().join(format!(
    "tento-04t-{name}-{}-{}",
    std::process::id(),
    {
      static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
      NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }
  ))
}
use super::*;

#[tokio::test]
async fn fixes_local_without_value_is_unset_and_restores_outer() {
  let mut h = host();
  let out = h.capture_shell_source("x=outer; f(){ local x; echo [${x-unset}]; local x=inner; local x; echo $x; }; f; echo $x").await.unwrap();
  assert_eq!(out.stdout, b"[unset]\ninner\nouter\n");
}

#[tokio::test]
async fn fixes_unset_local_expansion_stays_empty_and_assignments_restore_it() {
  let mut h = host();
  let out = h.capture_shell_source("x=outer; f(){ local x; echo [$x]; (echo [${x-unset}]; echo [$x]); x=inner; echo [$x]; }; f; echo [$x]").await.unwrap();
  assert_eq!(out.stdout, b"[]\n[unset]\n[]\n[inner]\n[outer]\n");
}

#[tokio::test]
async fn fixes_parameter_word_closing_braces_and_escapes() {
  let mut h = host();
  let out = h.capture_shell_source(r#"echo "${var-}}"; echo "${var-\}}"; echo "${var-'}'}"; echo "${var-"}"}"; echo "${var-{x}}"; echo "${var-"\}"}"; child=set; echo "${var-${child-\}}}""#).await.unwrap();
  assert_eq!(out.stdout, b"}\n}\n'}'\n}\n{x}\n}\nset\n");
}

#[tokio::test]
async fn fixes_pipeline_dynamic_command_assignment_stays_in_child() {
  let mut h = host();
  h.set_external_commands(Rc::new(FixPipelinePrograms));
  let out = h.capture_shell_source("${cmd=echo} hi | /usr/bin/wc -l; echo cmd=$cmd").await.unwrap();
  let text = String::from_utf8(out.stdout).unwrap();
  assert_eq!(text.lines().map(str::trim).collect::<Vec<_>>(), ["1", "cmd="]);
}

struct FixPipelinePrograms;
impl super::super::ExternalCommands for FixPipelinePrograms {
  fn lookup(&self, name: &str) -> super::super::ExternalLookup {
    if matches!(name, "/usr/bin/printf" | "/usr/bin/wc") { super::super::ExternalLookup::Runs }
    else { super::super::ExternalLookup::NotFound }
  }
  fn run(&self, _: Vec<String>) -> super::super::AsyncCommandFut {
    Box::pin(async { Ok(JsonValue::Null) })
  }
  fn suggest(&self, _: &str) -> Option<String> { None }
  fn run_pipeline_with_io(&self, argv: Vec<Vec<String>>, input: Option<Vec<u8>>, capture: bool,
    io: Vec<Option<super::super::ShellIo>>) -> super::super::PipelineFuture {
    Box::pin(super::super::run_process_pipeline_with_io(
      argv.into_iter().map(|argv| (std::path::PathBuf::from(&argv[0]), argv)).collect(),
      input, capture, None, None, io,
    ))
  }
}

#[tokio::test]
async fn fixes_external_pipeline_arguments_expand_in_independent_children() {
  let mut h = host();
  h.set_external_commands(Rc::new(FixPipelinePrograms));
  let out = h.capture_shell_source("/usr/bin/printf '%s\\n' ${arg=child} | /usr/bin/wc -l; echo arg=$arg").await.unwrap();
  let text = String::from_utf8(out.stdout).unwrap();
  assert_eq!(text.lines().map(str::trim).collect::<Vec<_>>(), ["1", "arg="]);
}

#[tokio::test]
async fn fixes_ambiguous_redirect_diagnostics_and_no_command_effect() {
  let mut h = host();
  h.set_shell_file_opener(Rc::new(|_, _, _| panic!("ambiguous redirects must not open")));
  for source in ["x='a b'; echo must-not-run >$x; echo $?", "set -- a b; echo must-not-run >\"$@\"; echo $?", "set -- a b; echo must-not-run 1>&\"$@\"; echo $?"] {
    h.collect_shell_diagnostics();
    let out = h.capture_shell_source(source).await.unwrap();
    assert_eq!(out.stdout, b"1\n", "{source}");
    let diagnostics = h.take_shell_diagnostics();
    assert_eq!(diagnostics.len(), 1);
    assert!(diagnostics[0].starts_with("tsh: line 1: "), "{diagnostics:?}");
    assert!(diagnostics[0].ends_with(": ambiguous redirect"), "{diagnostics:?}");
  }
}

#[tokio::test]
async fn fixes_quoted_positionals_redirect_returns_one_and_obeys_errexit() {
  for target in [">\"$@\"", "1>&\"$@\""] {
    let mut h = host();
    h.collect_shell_diagnostics();
    h.set_shell_file_opener(Rc::new(|_, _, _| panic!("ambiguous redirects must not open")));
    let out = h.capture_shell_source(&format!("set -- a b; echo must-not-run {target}")).await.unwrap();
    assert_eq!(out.status, 1, "{target}");
    assert!(out.stdout.is_empty(), "{target}");
    assert_eq!(h.take_shell_diagnostics().len(), 1);
    h.collect_shell_diagnostics();
    let err = h.capture_shell_source(&format!("set -e; echo must-not-run {target}; echo missed")).await.unwrap_err();
    assert!(matches!(err, TshScriptErrorKind::BashStatus(1)), "{err}");
    assert_eq!(h.take_shell_diagnostics().len(), 1);
  }
}

#[test]
fn fixes_test_extra_unary_operands_report_binary_operator() {
  for last in ["]", "y"] {
    let out = super::super::shell_test("test", &["-n".into(), "x".into(), last.into()]);
    assert_eq!(out.status, 2);
    assert_eq!(out.diagnostics, vec!["tsh: test: x: binary operator expected"]);
  }
}

#[test]
fn fixes_test_terminal_requires_an_integer() {
  let out = super::super::shell_test("[", &["-t".into(), "invalid".into(), "]".into()]);
  assert_eq!(out.status, 2);
  assert_eq!(out.diagnostics, vec!["tsh: [: invalid: integer expected"]);
  assert_eq!(super::super::shell_test("[", &["-t".into(), "-1".into(), "]".into()]).status, 1);
}

#[tokio::test]
async fn fixes_bracket_globs_are_words_outside_condition_position() {
  let mut h = host();
  h.eval_posix_line("LC_ALL=C").unwrap();
  let out = h.capture_shell_source(r#"echo [\[z] [\]z]; echo [[z] []z]"#).await.unwrap();
  assert_eq!(out.stdout, b"[[z] []z]\n[[z] []z]\n");
}

#[tokio::test]
async fn fixes_both_redirect_captures_stdout_and_diagnostics() {
  let mut h = host();
  h.set_shell_file_opener(Rc::new(|path, _, append| {
    std::fs::OpenOptions::new().write(true).create(true).truncate(!append).append(append)
      .open(path).map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let path = redirection_temp_path("04pt2-both");
  let q = serde_json::to_string(&path.to_string_lossy()).unwrap();
  let out = h.capture_shell_source(&format!("{{ echo STDOUT; missing; }} &>{q}")).await.unwrap();
  assert!(out.stdout.is_empty());
  let bytes = std::fs::read(&path).unwrap();
  assert!(bytes.starts_with(b"STDOUT\n"));
  assert!(String::from_utf8(bytes).unwrap().contains("missing: command not found"));
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn fixes_number_before_both_redirect_is_command_and_reports_127() {
  let mut h = host();
  h.set_shell_file_opener(Rc::new(|path, _, _| {
    std::fs::File::create(path).map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let path = redirection_temp_path("04pt2-number");
  let q = serde_json::to_string(&path.to_string_lossy()).unwrap();
  let out = h.capture_shell_source(&format!("2&>{q}; echo status=$?")).await.unwrap();
  assert_eq!(out.stdout, b"status=127\n");
  assert_eq!(std::fs::read_to_string(&path).unwrap(), "tsh: line 1: 2: command not found\n");
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn commands_braces_before_expansion_and_runtime_toggle() {
  let mut h = host();
  let out = h.capture_shell_source(r#"x='a,b'; echo pre{a,{b,c}}post {03..-1..2} {e..a..2} '{$x}' {$x,z}; set +B; echo {a,b}; set -B; echo {a,b}"#).await.unwrap();
  assert_eq!(
    out.stdout,
    b"preapost prebpost precpost 03 01 -1 e c a {$x} a,b z\n{a,b}\na b\n"
  );
}

#[tokio::test]
async fn commands_set_options_positionals_and_named_refusals() {
  let mut h = host();
  let out = h
    .capture_shell_source("set -efB; set +e +f; set -- a b c; shift 2; echo \"$#:$1\"")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"1:c\n");
  // Changing an option tsh does not implement is refused; extglob is always
  // on (Q7/Q8), so `shopt -u extglob` is refused and `shopt -s` is a no-op.
  for source in [
    "set -o unknown",
    "shopt -u extglob",
  ] {
    assert!(h.capture_shell_source(source).await.is_err(), "{source}");
  }
  let out = h.capture_shell_source("shopt -s globstar; echo $?").await.unwrap();
  assert_eq!(out.stdout, b"0\n");
  assert!(h.shell_compound.commands.glob.get().globstar);
  let out = h.capture_shell_source("shopt -u globstar; echo $?").await.unwrap();
  assert_eq!(out.stdout, b"0\n");
  assert!(!h.shell_compound.commands.glob.get().globstar);
  let out = h
    .capture_shell_source(
      "set -o pipefail; false | true; echo $?; set +o pipefail; false | true; echo $?",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"1\n0\n");
}

#[tokio::test]
async fn commands_double_brackets_preserve_words_patterns_and_logic() {
  let mut h = host();
  let out = h.capture_shell_source(r#"x='a b'; [[ $x == a* && ( -n $x || -z x ) ]]; echo $?; [[ $x == 'a*' ]]; echo $?; [[ ! a > b ]]; echo $?; [[ abc =~ (b.) ]]; echo "${BASH_REMATCH[0]}:${BASH_REMATCH[1]}""#).await.unwrap();
  assert_eq!(out.stdout, b"0\n1\n0\nbc:bc\n");
}

#[tokio::test]
async fn commands_eval_exec_and_traps_share_shell_state() {
  let mut h = host();
  let out = h
    .capture_shell_source(
      "x=old; eval 'x=new; echo $x'; trap 'echo err:$?' ERR; false; trap - ERR; echo $x",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"new\nerr:1\nnew\n");
  let out = h
    .capture_shell_source("trap 'echo bye:$?' EXIT; echo body")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"body\nbye:0\n");
  let error = bash(&mut h, "exec false; echo missed").await.unwrap_err();
  assert_eq!(error.process_status(), Some(1));
}

#[tokio::test]
async fn commands_exec_persists_descriptors_and_noclobber_override() {
  let mut h = host();
  h.set_shell_options_file_opener(Rc::new(|path, options| {
    std::fs::OpenOptions::new()
      .read(options.read)
      .write(options.write)
      .create(options.write)
      .create_new(options.exclusive)
      .truncate(options.truncate)
      .append(options.append)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let path = redirection_temp_path("04t-exec");
  let q = serde_json::to_string(&path.to_string_lossy()).unwrap();
  let out = h
    .capture_shell_source(&format!(
      "exec 3>{q}; echo first >&3; exec 3>&-; set -C; echo lost >{q}; echo $?; echo kept >|{q}"
    ))
    .await
    .unwrap();
  assert_eq!(out.stdout, b"1\n");
  assert_eq!(std::fs::read(&path).unwrap(), b"kept\n");
  std::fs::remove_file(path).unwrap();
}

struct Jobs;
impl super::super::ExternalCommands for Jobs {
  fn lookup(&self, name: &str) -> super::super::ExternalLookup {
    if name.starts_with("/usr/bin/") || name == "/bin/cat" {
      super::super::ExternalLookup::Runs
    } else {
      super::super::ExternalLookup::NotFound
    }
  }
  fn run(&self, _: Vec<String>) -> super::super::AsyncCommandFut {
    Box::pin(async { Ok(JsonValue::Null) })
  }
  fn suggest(&self, _: &str) -> Option<String> {
    None
  }
  fn start_background(
    &self,
    argv: Vec<String>,
    io: Option<super::super::ShellIo>,
    capture: bool,
  ) -> crate::Result<super::super::ShellJob> {
    super::super::start_process_background(
      std::path::PathBuf::from(&argv[0]),
      argv,
      io,
      capture,
      None,
    )
  }
}

#[tokio::test]
async fn commands_background_wait_status_and_last_pid() {
  let mut h = host();
  h.set_external_commands(Rc::new(Jobs));
  let out = h
    .capture_shell_source("false & p=$!; wait $p; echo $?; echo done & wait; echo $?")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"1\ndone\n0\n");
  assert!(h
    .capture_shell_source("read value &")
    .await
    .unwrap_err()
    .to_string()
    .contains("background read"));
}

#[tokio::test]
async fn commands_nounset_xtrace_ps4_and_option_reset() {
  let mut h = host();
  h.collect_shell_diagnostics();
  let out = h
    .capture_shell_source("PS4='TRACE '; set -x; echo 'a b'; set +x; echo done")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"a b\ndone\n");
  assert_eq!(
    h.take_shell_diagnostics(),
    vec!["TRACE echo 'a b'", "TRACE set +x"]
  );
  h.capture_shell_source("set -u").await.unwrap();
  h.collect_shell_diagnostics();
  let error = h
    .capture_shell_source("echo $TSH_PHASE_04T_MISSING_BCA251")
    .await
    .unwrap_err();
  // bash reports the expansion error as `NAME: unbound variable` and exits.
  assert!(h.take_shell_diagnostics().iter().any(|line| line.contains("unbound variable")), "{error}");
  h.capture_shell_source("set +u; echo $TSH_PHASE_04T_MISSING_BCA251")
    .await
    .unwrap();
}

#[tokio::test]
async fn commands_shopt_globs_and_runtime_refusals() {
  let root = redirection_temp_path("glob");
  std::fs::create_dir(&root).unwrap();
  std::fs::write(root.join(".hidden"), "").unwrap();
  std::fs::write(root.join("UPPER.TXT"), "").unwrap();
  let pattern = |p: &str| format!("{}/{p}", root.display());
  let mut h = host();
  h.eval_posix_line("LC_ALL=C").unwrap();
  let out = h.capture_shell_source(&format!("shopt -s nullglob; echo before {} after; shopt -u nullglob; shopt -s dotglob nocaseglob; echo {}; echo {}", pattern("missing*"), pattern(".*"), pattern("*.txt"))).await.unwrap();
  assert_eq!(
    String::from_utf8(out.stdout).unwrap(),
    format!(
      "before after\n{}\n{}\n",
      root.join(".hidden").display(),
      root.join("UPPER.TXT").display()
    )
  );
  h.capture_shell_source("shopt -s failglob").await.unwrap();
  h.collect_shell_diagnostics();
  let error = h.capture_shell_source(&format!("echo {}", pattern("missing*"))).await.unwrap_err();
  // bash reports `no match: PATTERN` and runs nothing.
  assert!(h.take_shell_diagnostics().iter().any(|line| line.contains("no match: ")), "{error}");
  std::fs::remove_file(root.join(".hidden")).unwrap();
  std::fs::remove_file(root.join("UPPER.TXT")).unwrap();
  std::fs::remove_dir(root).unwrap();
}

/// argv.md D2a: aliases never expand until macros, so `shopt -s
/// expand_aliases` is refused loudly with the function to write instead, and
/// turning it off (already off) stays a no-op.
#[tokio::test]
async fn commands_shopt_expand_aliases_is_refused_with_a_function_hint() {
  let mut h = host();
  let error = h.capture_shell_source("shopt -s expand_aliases").await.unwrap_err().to_string();
  assert!(error.contains("aliases do not expand until macros; define a function"), "{error}");
  h.capture_shell_source("shopt -u expand_aliases").await.unwrap();
}

/// A host whose `(note "x")` records `x`, for observing which callee ran.
fn noting_host() -> (LispHost, Rc<std::cell::RefCell<Vec<String>>>) {
  let mut h = host();
  let notes: Rc<std::cell::RefCell<Vec<String>>> = Rc::default();
  let record = notes.clone();
  h.register_native_special("note", move |args| {
    for arg in args {
      if let tento_lisp::Value::String(word) = arg {
        record.borrow_mut().push(word.into_string());
      }
    }
    Ok(tento_lisp::Value::Nil)
  });
  (h, notes)
}

/// Operator ruling 14 (2026-10-06): a prelude `(let NAME (lambda …))` is a
/// Lisp name only, never a command word; bash lookup never consults it.
#[tokio::test]
async fn commands_prelude_lambda_is_a_lisp_name_only() {
  let (mut h, notes) = noting_host();
  assert!(h.eval_seed(r#"(let greet (lambda () (note "prelude")))"#, &[]).is_empty());
  assert!(h.shadowed_by_lisp_binding("greet"), "a prelude function is not a command");
  let _ = bash(&mut h, "greet").await;
  assert!(notes.borrow().is_empty(), "bash lookup skipped the Lisp binding");
  h.eval_stmt("(greet)").unwrap();
  assert_eq!(*notes.borrow(), ["prelude"], "Lisp calls it");
}

/// Operator ruling 2026-10-04: a name in tsh's command namespace is never
/// shadowed. An rc `@import … :as NAME` whose NAME the prelude binds, a
/// registry command or `std` owns is refused (the rc loader reports the line)
/// and the owner keeps the name; a free name still mounts.
#[tokio::test]
async fn commands_an_import_never_takes_a_command_name() {
  let (mut h, notes) = noting_host();
  assert!(h.eval_seed(r#"(let apps (lambda () (note "prelude")))"#, &[]).is_empty());
  let error = h.eval_stmt(r#"(@import "tsh-apps" :as "apps")"#).unwrap_err().to_string();
  assert!(
    error.contains("`apps` is already a prelude name; mount tsh-apps under another name, e.g. :as \"tsh-apps\""),
    "{error}"
  );
  h.eval_stmt("(apps)").unwrap();
  assert_eq!(*notes.borrow(), ["prelude"], "the owner keeps the name");
  let error = h.eval_stmt(r#"(@import "tsh-std" :as "std")"#).unwrap_err().to_string();
  assert!(error.contains("`std` is already std (read-only)"), "{error}");
  // The utilities live under `std` (`std.coreutil.*`, operator, 2026-10-19),
  // so `std.coreutil` is refused by the `std` rule and `coreutil` is free.
  let error = h.eval_stmt(r#"(@import "tsh-std" :as "std.coreutil")"#).unwrap_err().to_string();
  assert!(error.contains("`std.coreutil` is already std (read-only)"), "{error}");
  let error = h.eval_stmt(r#"(@import "tsh-coreutil" :as "coreutil")"#).unwrap_err().to_string();
  assert!(!error.contains("is already"), "{error}");
  // A free name reaches the resolver (which, on this host, has no bundles).
  let error = h.eval_stmt(r#"(@import "tsh-free" :as "free")"#).unwrap_err().to_string();
  assert!(!error.contains("is already"), "{error}");
}

/// A subshell's changes never reach its parent, dynamic variables included
/// (bash 5.3: `(unset RANDOM); echo ${RANDOM:+set}` prints `set`).
#[tokio::test]
async fn commands_a_subshell_unset_of_a_dynamic_variable_stays_inside() {
  let mut h = host();
  let out = h
    .capture_shell_source("(unset RANDOM); echo ${RANDOM:+set}; (readonly -f f 2>/dev/null; :); f() { echo redefined; }; f")
    .await
    .unwrap();
  assert_eq!(String::from_utf8(out.stdout).unwrap(), "set\nredefined\n");
}

#[tokio::test]
async fn commands_exec_update_shares_offset_and_preserves_file_tail() {
  let path = redirection_temp_path("update");
  std::fs::write(&path, "abcdef\n").unwrap();
  let q = serde_json::to_string(&path.to_string_lossy()).unwrap();
  let mut h = host();
  h.set_shell_options_file_opener(Rc::new(|path, options| {
    std::fs::OpenOptions::new()
      .read(options.read)
      .write(options.write)
      .create(options.write)
      .create_new(options.exclusive)
      .append(options.append)
      .truncate(options.truncate)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let out = h
    .capture_shell_source(&format!(
      "exec 3<>{q}; echo -n xyz >&3; read -r tail <&3; exec 3>&-; echo $tail"
    ))
    .await
    .unwrap();
  assert_eq!(out.stdout, b"def\n");
  assert_eq!(std::fs::read(&path).unwrap(), b"xyzdef\n");
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn commands_exit_err_signal_traps_and_reset_ignore() {
  let mut h = host();
  let out = h
    .capture_shell_source(
      "trap 'echo err:$?' ERR; false || :; ! false; trap '' ERR; false; trap - ERR; false; echo ok",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"ok\n");
  h.capture_shell_source("trap 'echo term' TERM; trap '' INT")
    .await
    .unwrap();
  let bytes = Rc::new(std::cell::RefCell::new(Vec::new()));
  let output = super::super::bash_flow::FlowOutput {
    capture: Some(bytes.clone()),
    ..Default::default()
  };
  h.run_shell_trap("TERM", 1, output.clone()).await.unwrap();
  h.run_shell_trap("INT", 1, output).await.unwrap();
  assert_eq!(*bytes.borrow(), b"term\n");
  let out = Rc::new(std::cell::RefCell::new(Vec::new()));
  let sink = out.clone();
  h.set_shell_byte_output(Rc::new(move |bytes| {
    sink.borrow_mut().extend_from_slice(bytes)
  }));
  let error = bash(&mut h, "trap 'echo end:$?' EXIT; exit 7; echo missed")
    .await
    .unwrap_err();
  assert_eq!(error.process_status(), Some(7));
  assert_eq!(*out.borrow(), b"end:7\n");
}

#[tokio::test]
async fn commands_brace_substitutions_are_selected_before_execution() {
  let mut h = host();
  let count = Rc::new(std::cell::Cell::new(0));
  let calls = count.clone();
  h.register_native_special("bump", move |_| {
    calls.set(calls.get() + 1);
    Ok(super::super::LispValue::String("x".into()))
  });
  let out = h
    .capture_shell_source("echo {$(bump),plain}; set +B; echo {$(bump),plain}")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"x plain\n{x,plain}\n");
  assert_eq!(count.get(), 2);
  let out = h
    .capture_shell_source("set -B; v={a,b}; echo \"$v\"; for x in {1..5..2}; do echo $x; done")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"{a,b}\n1\n3\n5\n");
}

#[tokio::test]
async fn commands_condition_ere_quoting_file_tests_and_invalid_regex() {
  let mut h = host();
  let path = redirection_temp_path("condition");
  std::fs::write(&path, "bytes").unwrap();
  let q = serde_json::to_string(&path.to_string_lossy()).unwrap();
  let out = h.capture_shell_source(&format!("n=2; [[ n+1 -eq 3 && -s {q} ]]; echo $?; [[ abc =~ 'a.c' ]]; echo $?; [[ abc =~ a.c ]]; echo \"$?:$BASH_REMATCH\"; [[ x =~ [ ]]; echo $?")).await.unwrap();
  assert_eq!(out.stdout, b"0\n1\n0:abc\n2\n");
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn commands_conditional_whole_status_controls_err_and_errexit() {
  let mut h = host();
  let out = h
    .capture_shell_source(
      "trap 'echo err:$?' ERR; [[ ! yes ]]; echo after; [[ '' && yes ]]; echo done",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"err:1\nafter\nerr:1\ndone\n");
  let error = h
    .capture_shell_source("set -e; [[ '' && yes ]]; echo missed")
    .await
    .unwrap_err();
  assert!(matches!(error, TshScriptErrorKind::BashStatus(1)), "{error:?}");
}

#[tokio::test]
async fn commands_condition_multiple_eres_keep_grouping_words() {
  let mut h = host();
  let out = h
    .capture_shell_source("[[ abc =~ (b.) && ( xyz =~ (y.) ) ]]; echo \"$?:${BASH_REMATCH[1]}\"")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"0:yz\n");
}

#[tokio::test]
async fn commands_xtrace_expands_ps4_in_current_shell() {
  let mut h = host();
  h.collect_shell_diagnostics();
  let out = h
    .capture_shell_source("prefix=TRACE; PS4='$prefix '; set -x; echo body; set +x")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"body\n");
  assert_eq!(
    h.take_shell_diagnostics(),
    ["TRACE echo body", "TRACE set +x"]
  );
}
