//! Q8/Q9/Q6 rulings (2026-10-06): per-simple-command line numbers, bash's
//! call-stack variables and `caller`, xtrace as bash prints source words,
//! the Lisp ↔ shell-function bridge, and the strict-Lisp bash-word hint.
//! Every bash expectation was taken from GNU bash 5.3 run on a file named
//! `s.sh` (`/opt/homebrew/bin/bash s.sh`).
use super::bash_tests::host;
use super::*;

/// Run SOURCE as the file `s.sh`: stdout, and diagnostics (stderr lines).
async fn file(source: &str) -> (String, Vec<String>) {
  let mut host = host();
  host.collect_shell_diagnostics();
  host.set_script_path(Some("s.sh".into()));
  host.begin_shell_main(Some("s.sh".into()));
  let out = host.capture_shell_source(source).await.unwrap();
  let diagnostics = host.take_shell_diagnostics();
  (String::from_utf8(out.stdout).unwrap(), diagnostics)
}

#[tokio::test]
async fn lineno_err_trap_and_diagnostics_name_the_failing_simple_command() {
  let (out, diagnostics) = file(
    "echo \"top $LINENO\"\nif true; then\n  echo \"if $LINENO\"\n  false\n  echo \"after $LINENO\"\nfi\ntrap 'echo \"ERR at $LINENO\"' ERR\nfor i in 1; do\n  echo x\n  false\ndone\n{\n  echo a\n  nosuchcmd_abc\n}\n",
  )
  .await;
  assert_eq!(out, "top 1\nif 3\nafter 5\nx\nERR at 10\na\nERR at 14\n");
  assert!(diagnostics.iter().any(|d| d.ends_with("line 14: nosuchcmd_abc: command not found")), "{diagnostics:?}");
}

#[tokio::test]
async fn function_bodies_count_lines_from_their_definition() {
  let (out, _) = file("f() {\n  echo \"f $LINENO\"\n}\ng() { echo \"g $LINENO\"; }\n\n\nf\ng\ncat <<EOF >/dev/null\nx\nEOF\n{\n  echo \"after heredoc $LINENO\"\n  echo \"joined \\\n $LINENO\"\n  echo $LINENO\n}\n").await;
  assert_eq!(out, "f 2\ng 4\nafter heredoc 13\njoined  14\n16\n");
}

#[tokio::test]
async fn call_stack_variables_and_caller_match_bash() {
  let (out, _) = file(
    "echo \"main ${FUNCNAME[*]-unset} ${BASH_LINENO[*]} ${BASH_SOURCE[*]}\"\nf() {\n  echo \"f ${FUNCNAME[*]} ${BASH_LINENO[*]} ${BASH_SOURCE[*]}\"\n  caller\n  caller 0\n  g\n}\ng() { echo \"g ${FUNCNAME[*]} ${BASH_LINENO[*]}\"; caller 1; caller 2; echo \"c=$?\"; }\nf\ncaller; echo \"top=$?\"\n",
  )
  .await;
  assert_eq!(
    out,
    "main unset 0 s.sh\nf f main 9 0 s.sh s.sh\n9 s.sh\n9 main s.sh\ng g f main 6 9 0\n9 main s.sh\nc=1\n0 NULL\ntop=0\n"
  );
}

#[tokio::test]
async fn caller_without_a_file_and_bad_operands() {
  let mut host = host();
  host.collect_shell_diagnostics();
  // `-c`/stdin: no `main` frame, so `caller` at the top fails.
  let out = host.capture_shell_source("caller; echo $?; f() { caller; caller 0; echo $?; caller x; echo $?; }; f").await.unwrap();
  assert_eq!(String::from_utf8(out.stdout).unwrap(), "1\n1 NULL\n1\n2\n");
  let diagnostics = host.take_shell_diagnostics();
  assert!(diagnostics.iter().any(|d| d.contains("caller: x: invalid number\ncaller: usage: caller [expr]")), "{diagnostics:?}");
}

#[tokio::test]
async fn bash_version_is_never_set() {
  let (out, _) = file("echo \"${BASH_VERSION-unset} ${#BASH_VERSINFO[@]}\"\n").await;
  assert_eq!(out, "unset 0\n");
}

#[tokio::test]
async fn xtrace_prints_source_words_not_lowered_forms() {
  let (_, trace) = file(
    "set -x\nx=1\nx+=5\narr=( a 'b c' )\narr[x-5]=$x\narr+=(z)\ndeclare -a d=(1 2)\ndeclare -A m=([k]=v)\ncase $x in 15) :;; esac\nfor i in $(echo 1); do :; done\nexport E=1\ndeclare -l lo; lo=ABC\nPS4='>> '\necho 'a b'\n",
  )
  .await;
  assert_eq!(
    trace,
    [
      "+ x=1", "+ x+=5", "+ arr=(a 'b c')", "+ arr[x-5]=15", "+ arr+=(z)", "+ d=('1' '2')", "+ declare -a d",
      "+ m=(['k']='v')", "+ declare -A m", "+ case $x in", "+ :", "++ echo 1", "+ for i in $(echo 1)", "+ :",
      "+ export E=1", "+ E=1", "+ declare -l lo", "+ lo=ABC", "+ PS4='>> '", ">> echo 'a b'",
    ]
  );
}

#[tokio::test]
async fn xtrace_ps4_lineno_follows_the_command() {
  let (_, trace) = file("PS4='+$LINENO: '\nset -x\nif true; then\n  :\nfi\n").await;
  assert_eq!(trace, ["+3: true", "+4: :"]);
}

async fn lisp(host: &mut LispHost, source: &str, path: &str) -> Result<Option<JsonValue>, TshScriptError> {
  run_source_on_host(
    host,
    source,
    &Scripts::new(()),
    &HashMap::new(),
    &[],
    RunOptions { bash: Some(false), source_path: Some(path.into()), on_error: OnError::Bash, ..RunOptions::default() },
  )
  .await
}

#[tokio::test]
async fn std_sh_call_runs_a_shell_function_from_lisp() {
  let mut host = host();
  host.capture_shell_source("f() { g=set-by-f; echo \"f:$1:$2\"; return 3; }").await.unwrap();
  // Status by default; the function's assignments persist.
  lisp(&mut host, "(let r (std.sh.call \"f\" \"a\" 2))", "t.tsh").await.unwrap();
  assert_eq!(host.eval_to_json("r").unwrap(), serde_json::json!(3));
  let out = host.capture_shell_source("echo $g").await.unwrap();
  assert_eq!(out.stdout, b"set-by-f\n");
  // Captured stdout only when asked.
  lisp(&mut host, "(let c (std.sh.call {:capture true} \"f\" \"x\"))", "t.tsh").await.unwrap();
  assert_eq!(host.eval_to_json("c").unwrap(), serde_json::json!({"status": 3, "stdout": "f:x:\n"}));
  // A shell function is not a Lisp name, and the call is a statement.
  assert!(lisp(&mut host, "(list 1 (std.sh.call \"f\"))", "t.tsh").await.unwrap_err().to_string().contains("as a statement"));
}

#[tokio::test]
async fn strict_lisp_refuses_bash_words_as_heads_with_a_hint() {
  let mut host = host();
  let error = lisp(&mut host, "(cd \"/\")", "t.tsh").await.unwrap_err().to_string();
  assert!(error.contains("`cd` is a bash command word, not a lisp name"), "{error}");
  assert!(error.contains("(std.process.chdir \"/\")") && error.contains("(std.sh.call \"cd\" \"/\")"), "{error}");
  let error = lisp(&mut host, "(let x (ls \"/\"))", "t.tsh").await.unwrap_err().to_string();
  assert!(error.contains("(std.coreutil.ls \"/\")"), "{error}");
  // Regression: Lisp's own forms are never bash words (`let` is the binding).
  lisp(&mut host, "(let a 1)\n(set a (if true 2 0))", "t.tsh").await.unwrap();
  assert_eq!(host.eval_to_json("a").unwrap(), serde_json::json!(2));
}
