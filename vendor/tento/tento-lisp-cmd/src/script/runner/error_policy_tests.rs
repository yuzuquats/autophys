//! Q6 rulings (2026-10-06) on bash runtime errors: an expansion error
//! discards only the current top-level command (item 17), diagnostics carry
//! bash's `$0: line N:` prolog (item 12), a native failing in a bash line
//! warns and continues (item 18), and `set -e` inside a subshell ends only
//! the subshell. Every expectation was taken from GNU bash 5.3
//! (`/opt/homebrew/bin/bash`), run as a file, `-c` and stdin.
use super::bash_tests::host;
use super::*;

struct Run {
  result: Result<Option<JsonValue>, TshScriptError>,
  /// One entry per `say` line, its arguments joined by spaces.
  said: Vec<String>,
  diagnostics: Vec<String>,
  host: LispHost,
}

async fn bash_run_with(source: &str, setup: impl FnOnce(&mut LispHost)) -> Run {
  let said = Rc::new(std::cell::RefCell::new(Vec::new()));
  let recorded = said.clone();
  let mut host = host();
  host.register_native_special("say", |args| {
    let words: Vec<String> = args
      .iter()
      .map(|arg| match arg {
        tento_lisp::Value::String(text) => text.to_string(),
        tento_lisp::Value::Integer(n) => n.to_string(),
        other => format!("{other:?}"),
      })
      .collect();
    Ok(tento_lisp::Value::String(words.join(" ").into()))
  });
  host.collect_shell_diagnostics();
  setup(&mut host);
  let result = run_source_on_host(
    &mut host,
    source,
    &Scripts::new(()),
    &HashMap::new(),
    &[],
    RunOptions {
      on_error: OnError::Bash,
      bash_output: Some(Rc::new(move |_line, value, _final| {
        recorded.borrow_mut().push(value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()));
        true
      })),
      ..RunOptions::default()
    },
  )
  .await;
  let diagnostics = host.take_shell_diagnostics();
  let said = said.borrow().clone();
  Run { result, said, diagnostics, host }
}

async fn bash_run(source: &str) -> Run {
  bash_run_with(source, |_| {}).await
}

#[tokio::test]
async fn an_arithmetic_error_discards_the_rest_of_the_line_only() {
  let run = bash_run("say $((1/0)); say same\nsay after $?").await;
  assert!(run.result.is_ok(), "{:?}", run.result);
  assert_eq!(run.said, ["after 1"]);
  assert_eq!(run.diagnostics, ["tsh: line 1: 1/0: division by 0 (error token is \"0\")"]);
}

#[tokio::test]
async fn expansion_errors_discard_and_the_script_continues_with_status_one() {
  for (source, diagnostic) in [
    ("x=abc; say ${x:1:-5}; say same", "tsh: line 1: -5: substring expression < 0"),
    ("say ${:-d}; say same", "tsh: line 1: ${:-d}: bad substitution"),
    ("x=; say ${!x}; say same", "tsh: line 1: : invalid variable name"),
    ("say ${!unset_tsh_reference}; say same", "tsh: line 1: unset_tsh_reference: invalid indirect expansion"),
    ("y='a b'; say ${!y}; say same", "tsh: line 1: a b: invalid variable name"),
    ("shopt -s failglob; say *.no-such-tsh-file; say same", "tsh: line 1: no match: *.no-such-tsh-file"),
    ("x=$((1/0)); say same", "tsh: line 1: 1/0: division by 0 (error token is \"0\")"),
    ("say $((1+)); say same", "tsh: line 1: 1+: arithmetic syntax error: operand expected (error token is \"+\")"),
  ] {
    let run = bash_run(&format!("{source}\nsay after $?")).await;
    assert!(run.result.is_ok(), "{source}: {:?}", run.result);
    assert_eq!(run.said, ["after 1"], "{source}");
    assert_eq!(run.diagnostics, [diagnostic], "{source}");
  }
}

#[tokio::test]
async fn a_discard_unwinds_compounds_and_functions_to_the_top_level_command() {
  for source in [
    "if true; then\n say $((1/0))\n say inner\nfi",
    "f() {\n say $((1/0))\n say inf\n}\nf; say same",
    "for i in 1 2; do\n say $((i/0))\n say in$i\ndone",
    "{ say $((1/0)); say ingroup; }",
    "say $((1/0)) && say and",
  ] {
    let run = bash_run(&format!("{source}\nsay after $?")).await;
    assert!(run.result.is_ok(), "{source}: {:?}", run.result);
    assert_eq!(run.said, ["after 1"], "{source}");
    assert_eq!(run.diagnostics.len(), 1, "{source}: {:?}", run.diagnostics);
  }
}

#[tokio::test]
async fn subshells_substitutions_eval_and_source_contain_a_discard() {
  let run = bash_run("(say $((1/0)); say insub)\nsay after $?").await;
  assert_eq!(run.said, ["after 1"]);
  let run = bash_run("say \"[$(say $((1/0)); say insub)]\"\nsay after $?").await;
  assert_eq!(run.said, ["[]", "after 0"]);
  let run = bash_run("eval 'say $((1/0)); say ineval'; say same $?\nsay after $?").await;
  assert_eq!(run.said, ["same 1", "after 0"]);
  let file = std::env::temp_dir().join(format!("tento-q6-source-{}.sh", std::process::id()));
  std::fs::write(&file, "say $((1/0)); say insrc\n").unwrap();
  let run = bash_run_with(&format!(". {}; say same $?\nsay after $?", file.display()), |host| {
    host.set_shell_file_opener(Rc::new(|path, _read, _append| {
      std::fs::File::open(path).map_err(|error| LispHostError::Command(error.to_string()))
    }));
  })
  .await;
  std::fs::remove_file(&file).unwrap();
  assert_eq!(run.said, ["same 1", "after 0"]);
  assert_eq!(
    run.diagnostics,
    [format!("{}: line 1: 1/0: division by 0 (error token is \"0\")", file.display())]
  );
}

#[tokio::test]
async fn a_discard_neither_trips_errexit_nor_skips_the_exit_trap() {
  let run = bash_run("set -e; say $((1/0))\nsay after $?").await;
  assert!(run.result.is_ok(), "{:?}", run.result);
  assert_eq!(run.said, ["after 1"]);
  let run = bash_run("trap 'say trap $?' EXIT; say $((1/0))\nsay after $?").await;
  assert_eq!(run.said, ["after 1", "trap 0"]);
}

/// Under `set -e`, bash 5.3 still only discards for an arithmetic error,
/// but leaves the shell for its other expansion and assignment errors, even
/// where errexit is otherwise ignored.
#[tokio::test]
async fn errexit_ends_the_script_for_non_arithmetic_expansion_errors() {
  for source in [
    "x=$((1/0)); say same",
    "x=abc; say ${x:1:-5}; say same",
    "f() { say $((1/0)); }; f; say same",
  ] {
    let run = bash_run(&format!("set -e; {source}\nsay after $?")).await;
    assert!(run.result.is_ok(), "{source}: {:?}", run.result);
    assert_eq!(run.said, ["after 1"], "{source}");
  }
  for source in [
    "say ${:-d}; say same",
    "shopt -s failglob; say *.no-such-tsh-file",
    "x=; say ${!x}",
    "a=(); say ${a[@]=x}",
    "readonly r=1; r=2",
    "readonly a=(1); a=(2)",
    "say ${:-d} || say or",
    "if say ${:-d}; then say t; fi",
    "readonly r=1; (r=2; say insub); say same $?",
  ] {
    let run = bash_run(&format!("set -e; {source}; say same\nsay after $?")).await;
    assert_eq!(run.result.as_ref().map_err(|error| error.process_status()).err(), Some(Some(1)), "{source}: {:?}", run.result);
    assert!(run.said.is_empty(), "{source}: {:?}", run.said);
  }
}

#[tokio::test]
async fn a_readonly_assignment_discards_the_command() {
  let run = bash_run("readonly r=1; r=2; say same $?\nsay after $?").await;
  assert!(run.result.is_ok(), "{:?}", run.result);
  assert_eq!(run.said, ["after 1"]);
  assert_eq!(run.diagnostics, ["tsh: line 1: r: readonly variable"]);
}

/// bash exits a non-interactive shell for these; tsh keeps that.
#[tokio::test]
async fn parameter_errors_still_end_the_script() {
  for (source, diagnostic) in [
    ("set -u; say $zz", "tsh: line 1: zz: unbound variable"),
    ("say ${x:?unset}", "tsh: line 1: x: unset"),
  ] {
    let run = bash_run(&format!("{source}\nsay after")).await;
    let error = run.result.unwrap_err();
    assert_eq!(error.process_status(), Some(1), "{source}");
    assert!(run.said.is_empty(), "{source}: {:?}", run.said);
    assert_eq!(run.diagnostics, [diagnostic], "{source}");
  }
}

#[tokio::test]
async fn set_e_in_a_subshell_ends_only_the_subshell() {
  let run = bash_run("(set -e; false; say in); say after $?").await;
  assert!(run.result.is_ok(), "{:?}", run.result);
  assert_eq!(run.said, ["after 1"]);
  let run = bash_run("(set -e; false; say in) || say or $?; say after").await;
  assert_eq!(run.said, ["in", "after"]);
  let run = bash_run("set -e; (false; say in); say after $?").await;
  assert_eq!(run.result.unwrap_err().process_status(), Some(1));
  assert!(run.said.is_empty(), "{:?}", run.said);
  let run = bash_run("set -e; f() { false; say inf; }; (f); say after $?").await;
  assert_eq!(run.result.unwrap_err().process_status(), Some(1));
  assert!(run.said.is_empty(), "{:?}", run.said);
}

#[tokio::test]
async fn command_substitution_clears_errexit_unless_inherited() {
  let run = bash_run("set -e; x=$(false; say in); say \"after [$x] $?\"").await;
  assert!(run.result.is_ok(), "{:?}", run.result);
  assert_eq!(run.said, ["after [in] 0"]);
  let run = bash_run("set -e; shopt -s inherit_errexit; x=$(false; say in); say \"after [$x] $?\"").await;
  assert_eq!(run.result.unwrap_err().process_status(), Some(1));
  assert!(run.said.is_empty(), "{:?}", run.said);
  let run = bash_run("set -e; x=$(set -e; false; say in); say after").await;
  assert_eq!(run.result.unwrap_err().process_status(), Some(1));
}

#[tokio::test]
async fn an_unreadable_file_substitution_warns_and_the_command_runs() {
  let run = bash_run("x=$(< /no/such/tsh-file); say after $?").await;
  assert!(run.result.is_ok(), "{:?}", run.result);
  assert_eq!(run.said, ["after 1"]);
  assert_eq!(run.diagnostics, ["tsh: line 1: /no/such/tsh-file: No such file or directory"]);
  let run = bash_run("say \"[$(< /no/such/tsh-file)]\"; say after $?").await;
  assert_eq!(run.said, ["[]", "after 0"]);
  let run = bash_run("set -e; x=$(< /no/such/tsh-file); say same").await;
  assert_eq!(run.result.unwrap_err().process_status(), Some(1));
  assert!(run.said.is_empty());
}

#[tokio::test]
async fn a_native_runtime_failure_in_a_bash_line_warns_and_continues() {
  let run = bash_run_with("broken; say after $?", |host| {
    host.register_native_special("broken", |_| Err(LispHostError::Runtime("boom".into())));
  })
  .await;
  assert!(run.result.is_ok(), "{:?}", run.result);
  assert_eq!(run.said, ["after 1"]);
  assert_eq!(run.diagnostics.len(), 1);
  assert!(run.diagnostics[0].starts_with("tsh: line 1: ") && run.diagnostics[0].contains("boom"), "{:?}", run.diagnostics);
}

/// tsh-core-shell(14) PE-6 (operator, 2026-11-01): at the interactive prompt
/// too, a failing native command (a plugin command typed as a bare word) is a
/// failed bash command; the line runs on, and `&&` still stops it.
#[tokio::test]
async fn a_native_failure_at_the_prompt_continues_the_line_like_bash() {
  let setup = |host: &mut LispHost| {
    host.shell_prompt = true;
    host.register_native_special("broken", |_| Err(LispHostError::Command("boom".into())));
  };
  let run = bash_run_with("broken; say after $?", setup).await;
  assert!(run.result.is_ok(), "{:?}", run.result);
  assert_eq!(run.said, ["after 1"]);
  assert_eq!(run.diagnostics.len(), 1);
  assert!(run.diagnostics[0].contains("boom"), "{:?}", run.diagnostics);
  let run = bash_run_with("broken && say missed; say after $?", setup).await;
  assert_eq!(run.said, ["after 1"]);
}

/// Review B2: a bare-word failure that reported what it drew (lona's kind
/// `partial`) still draws that grid, as this statement's output, ahead of
/// its diagnostic.
#[tokio::test]
async fn a_partial_failure_at_the_prompt_still_draws_its_grid() {
  let run = bash_run_with("partialnat; say after $?", |host| {
    host.shell_prompt = true;
    host.register_native_special("partialnat", |_| {
      let display = serde_json::json!({"shape": "term.block/v1", "rows": [{"spans": [{"text": "Count"}]}]});
      Err(LispHostError::Reported(Box::new(tento_lisp::ReportedFailure {
        message: "part did not load".into(),
        kind: Some("partial".into()),
        display: display.as_object().cloned(),
        ..Default::default()
      })))
    });
  })
  .await;
  assert!(run.result.is_ok(), "{:?}", run.result);
  assert_eq!(run.said.len(), 2, "{:?}", run.said);
  assert!(run.said[0].contains("term.block/v1") && run.said[0].contains("Count"), "{:?}", run.said);
  assert_eq!(run.said[1], "after 1");
  assert!(run.diagnostics[0].contains("part did not load") && !run.diagnostics[0].contains("lisp error"), "{:?}", run.diagnostics);
}

#[tokio::test]
async fn diagnostics_name_dollar_zero_and_the_prompt_drops_the_line() {
  let run = bash_run_with("missing-tsh-command; say after $?", |host| {
    host.set_shell_positionals("script.sh".into(), Vec::new());
  })
  .await;
  assert_eq!(run.said, ["after 127"]);
  assert_eq!(run.diagnostics, ["script.sh: line 1: missing-tsh-command: command not found"]);
  let run = bash_run_with("say $((1/0))", |host| {
    host.set_shell_positionals("/path/to/tsh-alias".into(), Vec::new());
  })
  .await;
  assert_eq!(run.diagnostics, ["/path/to/tsh-alias: line 1: 1/0: division by 0 (error token is \"0\")"]);
  let mut host = host();
  host.collect_shell_diagnostics();
  host.shell_prompt = true;
  host.report_shell_diagnostic("tsh: line 4: foo: command not found".into());
  host.report_shell_diagnostic("tsh: write error: closed".into());
  assert_eq!(host.take_shell_diagnostics(), ["tsh: foo: command not found", "tsh: write error: closed"]);
}

#[tokio::test]
async fn a_missing_command_path_is_no_such_file_not_command_not_found() {
  let run = bash_run("./no-such-tsh-program; say after $?\n/no/such/tsh-program\nsay after $?").await;
  assert_eq!(run.said, ["after 127", "after 127"]);
  assert_eq!(run.diagnostics, [
    "tsh: line 1: ./no-such-tsh-program: No such file or directory",
    "tsh: line 2: /no/such/tsh-program: No such file or directory",
  ]);
}

/// bash expands a simple command's words before applying its redirections,
/// so the expansion error reaches the outer stderr; a group's redirection
/// applies first and catches it.
#[tokio::test]
async fn an_expansion_error_ignores_the_failed_commands_own_redirections() {
  let run = with_files("say $((1/0)) 2>/dev/null\nsay after $?").await;
  assert_eq!(run.said, ["after 1"]);
  assert_eq!(run.diagnostics, ["tsh: line 1: 1/0: division by 0 (error token is \"0\")"]);
  let run = with_files("{ say $((1/0)); } 2>/dev/null\nsay after $?").await;
  assert_eq!(run.said, ["after 1"]);
  assert!(run.diagnostics.is_empty(), "{:?}", run.diagnostics);
  let run = with_files("f() { say $((1/0)); }; f 2>/dev/null\nsay after $?").await;
  assert!(run.diagnostics.is_empty(), "{:?}", run.diagnostics);
  let run = with_files("x=$(< /no/such/tsh-file) 2>/dev/null; say after $?").await;
  assert_eq!(run.said, ["after 1"]);
  assert_eq!(run.diagnostics, ["tsh: line 1: /no/such/tsh-file: No such file or directory"]);
}

async fn with_files(source: &str) -> Run {
  bash_run_with(source, |host| {
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
  })
  .await
}

#[tokio::test]
async fn every_unbound_variable_ends_the_script() {
  for (source, diagnostic) in [
    ("set -u; say $1", "tsh: line 1: $1: unbound variable"),
    ("set -u; say $!", "tsh: line 1: $!: unbound variable"),
    ("set -u; say ${a[0]}", "tsh: line 1: a[0]: unbound variable"),
    ("set -u; a=(1); say ${a[3]}", "tsh: line 1: a[3]: unbound variable"),
  ] {
    let run = bash_run(&format!("{source}\nsay after")).await;
    assert_eq!(run.result.map_err(|error| error.process_status()).err(), Some(Some(1)), "{source}");
    assert!(run.said.is_empty(), "{source}: {:?}", run.said);
    assert_eq!(run.diagnostics, [diagnostic], "{source}");
  }
}
