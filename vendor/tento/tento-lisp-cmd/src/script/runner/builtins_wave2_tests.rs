//! Wave-2 builtins (operator rulings Q7/Q8): `printf`, `time`, `select`,
//! printed function bodies, `export -f` and extended globs. Expectations were
//! printed by GNU bash 5.3 (`/opt/homebrew/bin/bash`).
use super::bash_tests::host;

async fn stdout(source: &str) -> String {
  let mut h = host();
  let out = h.capture_shell_source(source).await.unwrap();
  String::from_utf8(out.stdout).unwrap()
}

#[tokio::test]
async fn printf_is_the_builtin_with_bash_formats_and_status() {
  assert_eq!(
    stdout("printf '[%5.2f|%x|%-4s|%b]\\n' 3.14159 255 ab 'a\\tb'; printf '%d\\n' 12abc; echo s=$?").await,
    "[ 3.14|ff|ab  |a\tb]\n12\ns=1\n"
  );
  assert_eq!(stdout("x=$(printf '%s,' a b c); echo $x").await, "a,b,c,\n");
  assert_eq!(stdout("printf -v 'v[1]' '%03d' 7; echo ${v[1]}; printf 'ab%nc\\n' n; echo $n").await, "007\nabc\n2\n");
}

#[tokio::test]
async fn time_reports_on_the_shells_stderr_in_timeformat() {
  assert_eq!(stdout("TIMEFORMAT='t:%0R'; { time echo x 2>&1; } 2>&1").await, "x\nt:0\n");
  assert_eq!(stdout("TIMEFORMAT=; { time true; } 2>&1; echo done").await, "done\n");
  assert_eq!(stdout("TIMEFORMAT=x; { time false; } 2>&1; echo $?; { ! time false; } 2>&1; echo $?").await, "x\n1\nx\n0\n");
}

#[tokio::test]
async fn select_reads_reply_and_sets_the_name() {
  assert_eq!(
    stdout("{ select v in apple banana; do echo \"[$v][$REPLY]\"; done <<< $'2\\nx'; } 2>&1; echo st=$?").await,
    "1) apple\n2) banana\n#? [banana][2]\n#? [][x]\n#? \nst=1\n"
  );
  assert_eq!(stdout("PS3='> '; { select v in a b; do break; done <<< 1; } 2>&1").await, "1) a\n2) b\n> ");
}

#[tokio::test]
async fn function_bodies_print_in_bash_layout_and_export() {
  assert_eq!(
    stdout("f() { if true; then echo a; fi; for i in 1; do :; done; }; declare -f f; type f").await,
    "f () \n{ \n    if true; then\n        echo a;\n    fi;\n    for i in 1;\n    do\n        :;\n    done\n}\nf is a function\nf () \n{ \n    if true; then\n        echo a;\n    fi;\n    for i in 1;\n    do\n        :;\n    done\n}\n"
  );
  assert_eq!(stdout("g() { :; }; declare -F; readonly -f g; declare -F g; declare -f nosuch; echo $?").await, "declare -f g\ng\n1\n");
}

#[tokio::test]
async fn extended_globs_match_in_case_conditions_and_parameters() {
  assert_eq!(
    stdout("for x in foo bar abbc abc; do case $x in @(foo|bar)) echo fb;; a!(b)c) echo neg;; *) echo other;; esac; done").await,
    "fb\nfb\nneg\nother\n"
  );
  assert_eq!(stdout("[[ 123 == +([0-9]) ]] && echo y; v=foo.tar.gz; echo ${v%.@(gz|bz2)} ${v//@(o|a)/_}").await, "y\nfoo.tar f__.t_r.gz\n");
  assert_eq!(stdout("shopt extglob; echo '@(a)'").await, "extglob             \ton\n@(a)\n");
}
