//! Strict lisp sources and the `(sh! …)` macro, end to end through
//! `run_source_on_host` (operator Refinements 6, 7, 9, 10, 11).
use super::*;

/// How a source arrives: a `.tsh` file, an rc unit, the prompt, or bash.
#[derive(Clone, Copy)]
enum Door {
  TshFile,
  Rc,
  Prompt,
  Bash,
}

struct Ran {
  result: Result<Option<JsonValue>, TshScriptError>,
  status: i32,
  stdout: String,
  host: LispHost,
}

async fn run(door: Door, source: &str) -> Ran {
  let mut host = super::bash_tests::host();
  let out = Rc::new(std::cell::RefCell::new(Vec::new()));
  let sink = out.clone();
  host.set_shell_byte_output(Rc::new(move |bytes| sink.borrow_mut().extend_from_slice(bytes)));
  host.collect_shell_diagnostics();
  let options = match door {
    Door::TshFile => RunOptions {
      on_error: OnError::Bash,
      bash: Some(false),
      source_path: Some("/x/script.tsh".into()),
      ..RunOptions::default()
    },
    Door::Rc => RunOptions {
      on_error: OnError::WarnContinue,
      source_path: Some("/x/.tshrc".into()),
      ..RunOptions::default()
    },
    Door::Prompt => RunOptions { on_error: OnError::Bash, prompt: true, ..RunOptions::default() },
    Door::Bash => RunOptions { on_error: OnError::Bash, bash: Some(true), ..RunOptions::default() },
  };
  let result = run_source_on_host(&mut host, source, &Scripts::new(()), &HashMap::new(), &[], options).await;
  let stdout = String::from_utf8_lossy(&out.borrow()).into_owned();
  Ran { result, status: host.shell_status(), stdout, host }
}

fn refusal(ran: &Ran) -> String {
  match &ran.result {
    Err(TshScriptError { kind: TshScriptErrorKind::Refused(message), .. }) => message.clone(),
    other => panic!("expected a refusal, got {other:?}"),
  }
}

#[tokio::test]
async fn sh_macro_reads_its_body_with_bash_quoting() {
  let ran = run(Door::TshFile, r#"(sh! printf '%s\n' "a)b" 'c(d' $(echo "(nested)"))"#).await;
  assert!(ran.result.is_ok(), "{:?}", ran.result);
  assert_eq!(ran.stdout, "a)b\nc(d\n(nested)\n");
}

#[tokio::test]
async fn sh_macro_spans_lines_and_is_followed_by_lisp() {
  let ran = run(Door::TshFile, "(sh! if true; then\n  echo yes\nfi)\n(let after 1)\n(sh! echo after)").await;
  assert!(ran.result.is_ok(), "{:?}", ran.result);
  assert_eq!(ran.stdout, "yes\nafter\n");
}

#[tokio::test]
async fn holes_fill_one_word_each_and_lists_one_word_per_item() {
  let source = r#"(let name "it's me")
(let xs ["a b" "c"])
(sh! printf '[%s]' {name} {xs...} "<{name}>" '{name}' @{{upstream}})"#;
  let ran = run(Door::TshFile, source).await;
  assert!(ran.result.is_ok(), "{:?}", ran.result);
  assert_eq!(ran.stdout, "[it's me][a b][c][<it's me>][{name}][@{upstream}]");
}

#[tokio::test]
async fn an_unbound_hole_is_a_loud_error_that_suggests_double_braces() {
  let ran = run(Door::TshFile, "(sh! echo before)\n(sh! git rev-parse @{upstream})\n(sh! echo after)").await;
  let message = ran.result.expect_err("unbound hole").to_string();
  assert!(message.contains("@{{upstream}}"), "{message}");
  assert_eq!(ran.stdout, "before\n", "the failing statement stops the script");
}

/// A whole-statement `(sh! …)` is exactly the bash line in the mixed
/// dialect: same output, same `$?`, a failure continues without `set -e`.
#[tokio::test]
async fn status_and_output_match_the_mixed_dialect_bash_line() {
  let mixed = run(Door::Prompt, "false\necho after $?\nexit-seven").await;
  let strict = run(Door::TshFile, "(sh! false)\n(sh! echo after $?)\n(sh! exit-seven)").await;
  assert_eq!(strict.stdout, mixed.stdout);
  assert_eq!(strict.stdout, "after 1\n");
  assert_eq!((strict.status, mixed.status), (7, 7));
  let errexit = run(Door::TshFile, "(sh! set -e)\n(sh! false)\n(sh! echo unreachable)").await;
  assert!(errexit.result.is_err());
  assert_eq!(errexit.stdout, "");
}

#[tokio::test]
async fn in_a_let_the_value_is_the_exit_status() {
  let mut ran = run(Door::TshFile, "(let s (sh! exit-seven))\n(let t (sh! true))").await;
  assert!(ran.result.is_ok(), "{:?}", ran.result);
  assert!(ran.host.eval_truthy("(= s 7)").unwrap());
  assert!(ran.host.eval_truthy("(= t 0)").unwrap());
}

#[tokio::test]
async fn nested_inside_an_expression_is_a_loud_error() {
  let ran = run(Door::TshFile, "(if true (sh! echo hi))").await;
  let message = ran.result.expect_err("nested").to_string();
  assert!(message.contains("runs bash as a statement"), "{message}");
}

#[tokio::test]
async fn a_strict_file_refuses_bash_prefix_and_hash_lines_before_running() {
  let ran = run(Door::TshFile, "(sh! echo first)\nls -la /tmp").await;
  let message = refusal(&ran);
  assert_eq!(message, "/x/script.tsh:2: `ls -la /tmp` looks like bash; wrap it: (sh! …) — (sh! ls -la /tmp) in a lisp file (.tsh, rc, tsh run)");
  assert_eq!(ran.stdout, "", "a refused file runs nothing");
  assert!(refusal(&run(Door::TshFile, "> (let x 1)").await).contains("a leading `>` is not lisp"));
  assert!(refusal(&run(Door::TshFile, "(let x 1)\n# note").await).contains("comments in lisp files are `;;`"));
  assert!(refusal(&run(Door::TshFile, "(cd /tmp && ls)").await).contains("looks like bash"));
  let ran = run(Door::TshFile, "#!/usr/bin/env tsh\n;; ok\n\"loaded\"\n(sh! echo ok)").await;
  assert!(ran.result.is_ok(), "{:?}", ran.result);
  assert_eq!(ran.stdout, "ok\n", "a datum line is lisp and prints nothing");
}

#[tokio::test]
async fn an_rc_warns_on_each_refused_line_and_keeps_declaring() {
  let mut ran = run(Door::Rc, "(let a 1)\nalias ll='ls -la'\n(let b 2)\n> (let c 3)\n(sh! alias ll='ls -la')").await;
  let message = ran.result.as_ref().expect_err("refused lines fail the unit").to_string();
  assert!(message.contains("2 of 5 statements failed"), "{message}");
  assert!(message.contains("looks like bash"), "{message}");
  assert!(ran.host.eval_truthy("(= b 2)").unwrap(), "declarations after a refused line still bind");
  assert!(ran.host.eval_truthy("(= a 1)").unwrap());
}

#[tokio::test]
async fn the_prompt_keeps_the_mixed_dialect_and_bash_never_sees_macros() {
  let ran = run(Door::Prompt, "echo plain\n(sh! echo macro)\n> (let x 1)").await;
  assert!(ran.result.is_ok(), "{:?}", ran.result);
  assert_eq!(ran.stdout, "plain\nmacro\n");
  // Bash reads `(sh! …)` as a subshell running a command named `sh!`
  // (bash: 127; tsh's bash reader fails it with status 1 — either way the
  // macro never runs).
  let ran = run(Door::Bash, "(sh! echo hi)").await;
  assert_eq!(ran.stdout, "");
  assert_ne!(ran.status, 0);
}
