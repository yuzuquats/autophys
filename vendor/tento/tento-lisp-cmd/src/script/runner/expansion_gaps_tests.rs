//! Bash expansion rules closed by the p1h conformance-gap job (`exp`: the
//! expansion and lexical areas). Every expectation was taken from GNU bash
//! 5.3 (`/opt/homebrew/bin/bash`) under `LC_ALL=C`.
use super::super::ControlSignal;
use super::bash_tests::host;
use super::*;

async fn stdout(source: &str) -> String {
  let mut h = host();
  let out = h.capture_shell_source(source).await.unwrap();
  String::from_utf8(out.stdout).unwrap()
}

/// The status and diagnostics of a source that ends in an expansion error
/// (an exit, or the discard of the command: error_policy_tests tells the
/// two apart), run as a `-c` string when `command` holds.
async fn failure(source: &str, command: bool) -> (Option<i32>, Vec<String>) {
  let mut h = host();
  h.set_shell_invocation_flags(command, false, false);
  h.collect_shell_diagnostics();
  let result = h.capture_shell_source(source).await;
  let status = match result {
    Err(TshScriptErrorKind::Control(ControlSignal::Exit(status) | ControlSignal::Discard(status))) => Some(status),
    _ => None,
  };
  (status, h.take_shell_diagnostics())
}

#[tokio::test]
async fn transform_operators_quote_expand_and_change_case() {
  assert_eq!(stdout(r#"x="a'b"; echo "${x@Q}""#).await, "'a'\\''b'\n");
  assert_eq!(stdout(r#"x='a\tb'; echo "${x@E}""#).await, "a\tb\n");
  assert_eq!(stdout(r"x='a\\b'; echo ${x@P}").await, "a\\b\n");
  assert_eq!(stdout("x=v; echo ${x@A}").await, "x='v'\n");
  assert_eq!(
    stdout("x=abc; echo ${x@U} ${x@u}; x=ABC; echo ${x@L}").await,
    "ABC Abc\nabc\n"
  );
  // An unset parameter transforms to nothing, not to `''`.
  assert_eq!(stdout(r#"unset x; echo "[${x@Q}]""#).await, "[]\n");
}

#[tokio::test]
async fn transform_attributes_and_key_value_forms() {
  assert_eq!(
    stdout(r#"declare -i n=1; declare -r r=1; echo "${n@a}" "${r@a}" "${n@A}""#).await,
    "i r declare -i n='1'\n"
  );
  assert_eq!(
    stdout(r#"declare -A m=([k]=v); echo "${m[@]@K}""#).await,
    "k \"v\" \n"
  );
  assert_eq!(
    stdout(r#"declare -A m=([k]=v); echo "${m[@]@k}""#).await,
    "k v\n"
  );
  assert_eq!(
    stdout(r#"a=(x "y z"); a[5]=w; echo "${a[@]@K}"; echo "${a[@]@A}""#).await,
    "0 \"x\" 1 \"y z\" 5 \"w\"\ndeclare -a a=([0]=\"x\" [1]=\"y z\" [5]=\"w\")\n"
  );
  assert_eq!(
    stdout(r#"set -- a "b c"; echo "${@@Q}" "${*@A}""#).await,
    "'a' 'b c' set -- 'a' 'b c'\n"
  );
}

#[tokio::test]
async fn unknown_transform_is_a_bad_substitution_that_ends_c_with_127() {
  let (status, diagnostics) = failure(r#"x=v; echo "${x@Z}"; echo after"#, false).await;
  assert_eq!(status, Some(1));
  assert_eq!(diagnostics, ["tsh: line 1: ${x@Z}: bad substitution"]);
  assert_eq!(failure(r#"x=v; echo "${x@Z}""#, true).await.0, Some(127));
}

#[tokio::test]
async fn operators_apply_to_each_array_element_and_positional() {
  assert_eq!(stdout(r#"a=(x.c y.c); echo "${a[@]%.c}""#).await, "x y\n");
  assert_eq!(stdout(r#"a=(ab cb); echo "${a[@]//b}""#).await, "a c\n");
  assert_eq!(stdout(r#"a=(ab cd); echo "${a[@]^}""#).await, "Ab Cd\n");
  assert_eq!(
    stdout(r#"set -- a.txt b.txt; echo "${@%.txt}""#).await,
    "a b\n"
  );
  assert_eq!(stdout(r#"set -- ab cb; echo "${@/b/X}""#).await, "aX cX\n");
  // Each element stays its own word.
  assert_eq!(
    stdout(r#"a=("a b" c); for w in "${a[@]#a}"; do echo "[$w]"; done"#).await,
    "[ b]\n[c]\n"
  );
}

#[tokio::test]
async fn slices_of_arrays_and_positionals_select_elements() {
  assert_eq!(
    stdout(r#"set -- a b c d; echo "${@:2}"; echo "${@:2:2}"; echo "${@: -1}""#).await,
    "b c d\nb c\nd\n"
  );
  assert_eq!(
    stdout(r#"set -- 'a b' c; for w in "${@:1:1}"; do echo "[$w]"; done"#).await,
    "[a b]\n"
  );
  assert_eq!(
    stdout(r#"a=(x y z); echo "${a[@]:1}" "${a[@]: -1}""#).await,
    "y z z\n"
  );
  // A sparse array slices by index, not by position.
  assert_eq!(stdout(r#"a=(x y); a[5]=w; echo "${a[@]:2}""#).await, "w\n");
  assert_eq!(
    stdout(r#"set -- a b c; echo "${#}" "${#@}" "${#*}""#).await,
    "3 3 3\n"
  );
}

#[tokio::test]
async fn parameter_errors_end_a_c_string_with_127_and_others_with_1() {
  let (status, diagnostics) = failure(r#"unset x; echo "${x:?gone}"; echo after"#, false).await;
  assert_eq!(
    (status, diagnostics),
    (Some(1), vec!["tsh: line 1: x: gone".to_string()])
  );
  assert_eq!(
    failure(r#"unset x; echo "${x:?gone}""#, true).await.0,
    Some(127)
  );
  assert_eq!(
    failure("set -u; unset x; echo \"${x^^}\"", true).await.0,
    Some(127)
  );
  assert_eq!(failure("set -u; unset x; echo $x", true).await.0, Some(127));
  // A function is not a subshell; a subshell's error is its own status.
  assert_eq!(failure("f() { echo ${x:?m}; }; f", true).await.0, Some(127));
  // Arithmetic and substring errors end with 1 under every door.
  assert_eq!(failure("echo $((1/0))", true).await.0, Some(1));
  let (status, diagnostics) = failure(r#"x=abc; echo "${x:2:-3}""#, true).await;
  assert_eq!(
    (status, diagnostics),
    (
      Some(1),
      vec!["tsh: line 1: -3: substring expression < 0".to_string()]
    )
  );
}

#[tokio::test]
async fn required_parameter_default_message_depends_on_the_colon() {
  assert_eq!(
    failure(r#"unset x; echo "${x?}""#, false).await.1,
    ["tsh: line 1: x: parameter not set"]
  );
  assert_eq!(
    failure(r#"unset x; echo "${x:?}""#, false).await.1,
    ["tsh: line 1: x: parameter null or not set"]
  );
}

#[tokio::test]
async fn nounset_errors_report_as_bash_does() {
  for source in [
    "set -u; unset x; echo \"${#x}\"",
    "set -u; unset x; echo \"${x#a}\"",
    "set -u; unset x; echo $x",
  ] {
    assert_eq!(
      failure(source, false).await,
      (
        Some(1),
        vec!["tsh: line 1: x: unbound variable".to_string()]
      ),
      "{source}"
    );
  }
}

#[tokio::test]
async fn arithmetic_errors_name_the_error_token() {
  for (source, diagnostic) in [
    ("echo $((1/0))", "1/0: division by 0 (error token is \"0\")"),
    (
      "echo $(( 1 / 0 + 2 ))",
      "1 / 0 + 2 : division by 0 (error token is \"0 + 2 \")",
    ),
    ("echo $((1%0))", "1%0: division by 0 (error token is \"0\")"),
    (
      "echo $((2**-1))",
      "2**-1: exponent less than 0 (error token is \"1\")",
    ),
    (
      "echo $((08))",
      "08: value too great for base (error token is \"08\")",
    ),
    (
      "echo $((2#2))",
      "2#2: value too great for base (error token is \"2#2\")",
    ),
    (
      "echo $((99#1))",
      "99#1: invalid arithmetic base (error token is \"99#1\")",
    ),
    (
      "echo $((1 2))",
      "1 2: arithmetic syntax error in expression (error token is \"2\")",
    ),
    (
      "echo $((1+))",
      "1+: arithmetic syntax error: operand expected (error token is \"+\")",
    ),
    (
      "echo $((1=2))",
      "1=2: attempted assignment to non-variable (error token is \"=2\")",
    ),
    (
      "echo $((1 ? 2))",
      "1 ? 2: `:' expected for conditional expression (error token is \"2\")",
    ),
    (
      "n=1/0; echo $((n))",
      "1/0: division by 0 (error token is \"0\")",
    ),
  ] {
    let (status, diagnostics) = failure(source, false).await;
    assert_eq!(status, Some(1), "{source}");
    assert_eq!(
      diagnostics,
      [format!("tsh: line 1: {diagnostic}")],
      "{source}"
    );
  }
}

#[tokio::test]
async fn arithmetic_reads_and_assigns_array_elements_and_removes_double_quotes() {
  assert_eq!(
    stdout("a=(1 2 3); i=1; echo $((a[1] + a[2])) $((a[i+1])) $((a[0]=9)) ${a[0]} $((a[5])) $((b[2]+=3)) ${b[2]}").await,
    "5 3 9 9 0 3 3\n"
  );
  assert_eq!(stdout(r#"x=4; echo $(( "$x" + 1 ))"#).await, "5\n");
  assert_eq!(stdout("echo $((0x)) $(( ))").await, "0 0\n");
}

#[tokio::test]
async fn bracket_arithmetic_is_dollar_double_paren() {
  assert_eq!(
    stdout(r#"echo $[2*3] "[$[1+1]]" x$[ 1 + 2 ]y"#).await,
    "6 [2] x3y\n"
  );
}

#[tokio::test]
async fn indirect_expansion_names_elements_and_rejects_bad_names() {
  assert_eq!(stdout(r#"a=(x y); r='a[1]'; echo "${!r}""#).await, "y\n");
  assert_eq!(stdout("set -- p q; n=2; echo ${!n}").await, "q\n");
  assert_eq!(
    failure(r#"x=1bad; echo "${!x}""#, true).await,
    (
      Some(1),
      vec!["tsh: line 1: 1bad: invalid variable name".to_string()]
    )
  );
  assert_eq!(
    failure(r#"unset x; echo "${!x}""#, false).await.1,
    ["tsh: line 1: x: invalid indirect expansion"]
  );
}

#[tokio::test]
async fn tilde_prefixes_in_assignments_and_pwd_forms() {
  let map = tento_env::EnvMap::new();
  map.set("HOME", "/h");
  map.set("PWD", "/w");
  map.set("OLDPWD", "/o");
  let mut h = host();
  let out = tento_env::with_env_map_async(map, h.capture_shell_source(
    r#"x=~:~/b:c~; echo "$x"; x=a:~nosuchuser_zz:~; echo "$x"; declare y=~ z=a:~; echo "$y $z"; echo x=~ x=~/b a+=~ "a"=~ --o=~; echo ~"/b" ~/"b" ~\/b; echo ~+ ~+/x ~-"#,
  )).await.unwrap();
  assert_eq!(
    String::from_utf8(out.stdout).unwrap(),
    "/h:/h/b:c~\na:~nosuchuser_zz:/h\n/h a:/h\nx=/h x=/h/b a+=/h a=~ --o=~\n~/b /h/b ~/b\n/w /w/x /o\n"
  );
}

#[tokio::test]
async fn tilde_reads_home_when_the_word_expands() {
  // Operator ruling Q9.10: `~` follows an in-script HOME= everywhere — the
  // same line, a function body, a compound, a here-string and declaration
  // values — because it reads $HOME when its word expands.
  let map = tento_env::EnvMap::new();
  map.set("HOME", "/start");
  let mut h = host();
  let out = tento_env::with_env_map_async(map, h.capture_shell_source(concat!(
    "HOME=/h; echo ~ ~/x; f() { echo ~; }; HOME=/f; f; if true; then HOME=/c; echo ~; fi\n",
    "HOME=/s; read -r v <<< ~; echo \"$v\"; declare d=~; export e=a:~; echo \"$d $e\"\n",
    // One unsplit, unglobbed field, empty when HOME is empty.
    // (bash 3.2 drops the empty field; 5.3 reads the passwd home for HOME=.)
    "HOME='a b'; printf '[%s]' ~ ~/*; echo; HOME=; printf '[%s]' ~ ~/x; echo\n",
    // A command's own prefix assignment is not seen by its words, as in bash.
    "HOME=/k; HOME=/p printf '%s\\n' ~\n",
  ))).await.unwrap();
  assert_eq!(
    String::from_utf8(out.stdout).unwrap(),
    "/h /h/x\n/f\n/c\n/s\n/s a:/s\n[a b][a b/*]\n[][/x]\n/k\n"
  );
}

#[tokio::test]
async fn tilde_without_home_or_a_stack_entry_falls_back_like_bash() {
  // Unset HOME: the passwd home. A stack index past the end, or an unset
  // PWD/OLDPWD, leaves the prefix literal.
  let map = tento_env::EnvMap::new();
  map.set("HOME", "/start");
  let mut h = host();
  // The stack `pushd /c; pushd /b` leaves, without changing directory.
  h.shell_dir_stack = vec!["/c".into(), "/b".into()];
  h.refresh_dir_stack();
  let out = tento_env::with_env_map_async(map, h.capture_shell_source(concat!(
    "unset HOME; echo ~\n",
    "echo ~1 ~2 ~3 ~+1 ~-0 ~-1 ~-3 ~+9 ~1/x x=~2:~7\n",
    "unset OLDPWD; echo ~-\n",
  ))).await.unwrap();
  let login = crate::script::bash_dirs::login_home().unwrap_or_else(|| "~".into());
  assert_eq!(
    String::from_utf8(out.stdout).unwrap(),
    format!("{login}\n/b /c ~3 /b /c /b ~-3 ~+9 /b/x x=/c:~7\n~-\n")
  );
}

#[tokio::test]
async fn file_substitution_reads_the_file_and_empty_substitutions_are_nothing() {
  let path = std::env::temp_dir().join(format!("p1h-exp-read-{}", std::process::id()));
  std::fs::write(&path, "a\nb\n\n").unwrap();
  let source = format!(
    r#"f={}; echo "[$(< $f)]" "[$(<$f )]"; set -- `` $( ); echo $#"#,
    path.display()
  );
  assert_eq!(stdout(&source).await, "[a\nb] [a\nb]\n0\n");
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn a_brace_word_runs_as_the_command_and_a_trailing_backslash_stays() {
  assert_eq!(stdout("{echo,hi}; echo a\\").await, "hi\na\\\n");
}

#[tokio::test]
async fn pathname_collating_symbols_globignore_and_globstar() {
  let root = std::env::temp_dir().join(format!("p1h-exp-glob-{}", std::process::id()));
  std::fs::create_dir_all(root.join("d/e")).unwrap();
  for file in ["a", "b", ".h", "d/f", "d/e/g", "x.log"] {
    std::fs::write(root.join(file), "").unwrap();
  }
  let r = root.display();
  let source = format!(
    "echo {r}/[[.a.]] {r}/[[=b=]]; GLOBIGNORE='{r}/*.log'; echo {r}/*; GLOBIGNORE=; shopt -s globstar; echo {r}/d/**"
  );
  let out = stdout(&source).await;
  std::fs::remove_dir_all(&root).unwrap();
  // GLOBIGNORE drops its matches and shows dot files; `d/**` holds `d/`.
  assert_eq!(
    out,
    format!("{r}/a {r}/b\n{r}/.h {r}/a {r}/b {r}/d\n{r}/d/ {r}/d/e {r}/d/e/g {r}/d/f\n")
  );
}

#[tokio::test]
async fn failglob_reports_no_match_as_bash_does() {
  let (status, diagnostics) = failure("shopt -s failglob; echo /p1h-exp-none/*.zz", false).await;
  assert_eq!(
    (status, diagnostics),
    (
      Some(1),
      vec!["tsh: line 1: no match: /p1h-exp-none/*.zz".to_string()]
    )
  );
}

#[tokio::test]
async fn a_parameter_without_a_valid_name_is_a_bad_substitution() {
  // bash 5.3 ends with 1 here under every door, `-c` included.
  for source in [r#"echo "${:-d}"; echo after"#, r#"echo "${1x:+a}""#] {
    let (status, diagnostics) = failure(source, true).await;
    assert_eq!(status, Some(1), "{source}");
    assert!(
      diagnostics[0].ends_with(": bad substitution"),
      "{diagnostics:?}"
    );
  }
}
