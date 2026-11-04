//! Traps, signals and subshell environments closed by the p1h conformance-gap
//! job (areas `commands`, `execution`, `options`). Every expectation was
//! taken from GNU bash 5.3 (`/opt/homebrew/bin/bash`).
//!
//! Signal dispositions are process-wide, so the one test that delivers a
//! signal owns `SIGUSR1`, and every other test only sets and lists traps.
use super::bash_tests::host;

async fn stdout(source: &str) -> String {
  let mut h = host();
  let out = h.capture_shell_source(source).await.unwrap();
  String::from_utf8(out.stdout).unwrap()
}

#[tokio::test]
async fn trap_p_lists_exit_then_signals_with_their_sig_names() {
  assert_eq!(
    stdout(
      "trap 'echo a' USR2; trap 'echo b' EXIT; trap -p; trap - USR2; trap -p USR2; echo \"[$?]\""
    )
    .await,
    "trap -- 'echo b' EXIT\ntrap -- 'echo a' SIGUSR2\n[0]\nb\n"
  );
  assert_eq!(
    stdout("trap \"echo it's\" HUP; trap -p HUP; trap -P HUP; trap - HUP").await,
    "trap -- 'echo it'\\''s' SIGHUP\necho it's\n"
  );
}

#[tokio::test]
async fn trap_rejects_an_unknown_condition_and_still_sets_the_rest() {
  assert_eq!(
    stdout("trap 'echo x' NOSUCH usr2; echo \"s=$?\"; trap -p SIGUSR2; trap - USR2; trap -z; echo \"z=$?\"").await,
    "s=1\ntrap -- 'echo x' SIGUSR2\nz=2\n"
  );
}

#[cfg(unix)]
#[tokio::test]
async fn a_trapped_signal_runs_its_action_before_the_next_command() {
  assert_eq!(
    stdout("trap 'echo got; x=set' USR1; (exit 5); kill -USR1 $$; echo \"after $? $x\"; trap '' USR1; kill -USR1 $$; echo ignored; trap - USR1").await,
    "got\nafter 0 set\nignored\n"
  );
}

#[tokio::test]
async fn a_subshell_runs_its_own_exit_trap_and_never_its_parents() {
  assert_eq!(
    stdout("(trap 'echo sub' EXIT; echo in); trap 'echo p' EXIT; (echo x); trap - EXIT").await,
    "in\nsub\nx\n"
  );
  assert_eq!(
    stdout("trap 'echo a' HUP; (trap -p HUP); trap - HUP").await,
    "trap -- 'echo a' SIGHUP\n"
  );
}

#[tokio::test]
async fn return_and_debug_traps_fire_for_their_events() {
  assert_eq!(
    stdout("f() { trap 'echo ret' RETURN; echo body; }; f; trap - RETURN; trap 'echo dbg' DEBUG; echo a; trap - DEBUG").await,
    "body\nret\ndbg\na\ndbg\n"
  );
}

#[tokio::test]
async fn err_trap_sees_a_failed_subshell() {
  assert_eq!(
    stdout("trap 'echo \"st=$?\"' ERR; (exit 4); trap - ERR").await,
    "st=4\n"
  );
}

#[tokio::test]
async fn kill_lists_signals_and_reports_bad_operands() {
  assert_eq!(
    stdout("kill -l 15; kill -l TERM; kill -l 143; kill -s NOSIG $$; echo $?; kill; echo $?; kill abc; echo $?").await,
    "TERM\n15\nTERM\n1\n2\n1\n"
  );
  assert!(
    stdout("kill -l")
      .await
      .starts_with(" 1) SIGHUP\t 2) SIGINT\t")
  );
}

#[tokio::test]
async fn command_substitution_is_a_subshell() {
  assert_eq!(
    stdout("x=1; v=$(x=2; y=3; echo $BASH_SUBSHELL); echo \"$x $v ${y-unset}\"").await,
    "1 1 unset\n"
  );
  assert_eq!(
    stdout("echo $BASH_SUBSHELL; (echo $BASH_SUBSHELL; (echo $BASH_SUBSHELL))").await,
    "0\n1\n2\n"
  );
  assert_eq!(stdout("v=$(exit 3); echo \"$? [$v]\"").await, "3 []\n");
}

#[tokio::test]
async fn errexit_is_cleared_in_a_substitution_unless_inherited() {
  assert_eq!(
    stdout("set -e; v=$(false; echo ran); echo \"[$v]\"").await,
    "[ran]\n"
  );
  let mut h = host();
  let out = h
    .capture_shell_source("set -e; shopt -s inherit_errexit; v=$(false; echo ran); echo \"[$v]\"")
    .await;
  assert!(out.map_or(true, |out| out.stdout.is_empty()));
}

#[cfg(unix)]
#[tokio::test]
async fn umask_is_a_builtin_and_a_subshell_keeps_its_change() {
  assert_eq!(
    stdout("old=$(umask); umask 077; (umask); (umask 022); umask; umask -S; umask $old").await,
    "0077\n0077\nu=rwx,g=,o=\n"
  );
}

async fn stderr(source: &str) -> String {
  let mut h = host();
  h.collect_shell_diagnostics();
  h.capture_shell_source(source).await.unwrap();
  h.take_shell_diagnostics().join("\n")
}

#[tokio::test]
async fn xtrace_shows_compound_commands_and_indirection_levels() {
  assert_eq!(
    stderr("x=1; set -x; ((x + 1)); [[ $x == 1* ]]; for i in a 'b c'; do :; done").await,
    "+ (( x + 1 ))\n+ [[ 1 == 1* ]]\n+ for i in a 'b c'\n+ :\n+ for i in a 'b c'\n+ :"
  );
  assert_eq!(
    stderr("set -x; v=$(echo in); eval 'echo $v'").await,
    "++ echo in\n+ v=in\n+ eval 'echo $v'\n++ echo in"
  );
  assert_eq!(
    stderr("set -x; x=1 true; echo $'a\\tb'").await,
    "+ x=1\n+ true\n+ echo $'a\\tb'"
  );
}

#[tokio::test]
async fn funcname_is_the_call_stack() {
  assert_eq!(
    stdout(
      "f() { echo \"$FUNCNAME ${FUNCNAME[@]}\"; }; g() { f; }; g; echo \"[${FUNCNAME-unset}]\""
    )
    .await,
    "f f g\n[unset]\n"
  );
}

#[tokio::test]
async fn return_outside_a_function_is_status_two() {
  assert_eq!(stdout("return 3; echo \"after $?\"").await, "after 2\n");
}

#[tokio::test]
async fn set_o_lists_every_option_and_set_plus_o_restores_them() {
  let table = stdout("set -o pipefail; set -o").await;
  assert!(table.contains("pipefail       \ton\n"), "{table}");
  assert!(
    table.starts_with("allexport      \toff\nbraceexpand    \ton\n"),
    "{table}"
  );
  let commands = stdout("set -e; set +o").await;
  assert!(
    commands.contains("set -o errexit\nset +o errtrace\n"),
    "{commands}"
  );
}

#[tokio::test]
async fn shopt_queries_bash_names_and_rejects_unknown_ones() {
  assert_eq!(
    stdout("shopt globskipdots extglob; shopt -p nullglob; shopt -q nullglob; echo $?; shopt -s nosuch lastpipe; echo $?").await,
    "globskipdots        \ton\nextglob             \ton\nshopt -u nullglob\n1\n1\n"
  );
}

#[tokio::test]
async fn lastpipe_and_nocasematch_follow_their_options() {
  assert_eq!(
    stdout("shopt -s lastpipe; echo a | { read x; y=$x; }; echo \"[${y-unset}]\"").await,
    "[a]\n"
  );
  assert_eq!(
    stdout("echo a | { read x; y=$x; }; echo \"[${y-unset}]\"").await,
    "[unset]\n"
  );
  assert_eq!(
    stdout("shopt -s nocasematch; case ABC in a*) echo hit;; esac; [[ XyZ == x?z ]] && echo y; shopt -u nocasematch; [[ XyZ == x?z ]] || echo n").await,
    "hit\ny\nn\n"
  );
}

#[tokio::test]
async fn conditional_tests_set_o_options_and_namerefs() {
  assert_eq!(
    stdout("[[ -o errexit ]]; echo $?; set -o pipefail; [[ -o pipefail ]]; echo $?; [[ -o nosuch ]]; echo $?; [[ -N /nonexistent-p1h ]]; echo $?").await,
    "1\n0\n1\n1\n"
  );
  assert_eq!(
    stdout("x=1; declare -n r=x; [[ -R r ]]; echo $?; [[ -R x ]]; echo $?").await,
    "0\n1\n"
  );
}

#[tokio::test]
async fn errtrace_passes_the_err_trap_down() {
  assert_eq!(
    stdout("trap 'echo err' ERR; f() { false; }; f; (false); echo after").await,
    "err\nerr\nafter\n"
  );
  assert_eq!(
    stdout("set -E; trap 'echo err' ERR; f() { false; }; f; (false); echo after").await,
    "err\nerr\nerr\nerr\nafter\n"
  );
  assert_eq!(
    stdout("set -E; trap 'echo err' ERR; x=$(false); echo \"after [$x]\"; trap - ERR").await,
    "err\nafter [err]\n"
  );
  assert_eq!(stdout("(set -E); [[ -o errtrace ]]; echo $?").await, "1\n");
}
