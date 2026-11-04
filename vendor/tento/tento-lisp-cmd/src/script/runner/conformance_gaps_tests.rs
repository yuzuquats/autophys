//! Bash attribute and parameter rules closed by the p1h conformance-gap job.
//! Every expectation was taken from GNU bash 5.3 (`/opt/homebrew/bin/bash`).
use super::bash_tests::host;

async fn stdout(source: &str) -> String {
  let mut h = host();
  let out = h.capture_shell_source(source).await.unwrap();
  String::from_utf8(out.stdout).unwrap()
}

#[tokio::test]
async fn declare_lowercase_and_uppercase_apply_on_every_assignment() {
  assert_eq!(
    stdout("declare -l s=HeLLo; echo $s; s=ABC; echo $s; s+=XY; echo $s").await,
    "hello\nabc\nabcxy\n"
  );
  assert_eq!(stdout("declare -u s=HeLLo; echo $s; s=abc; echo $s").await, "HELLO\nABC\n");
}

#[tokio::test]
async fn declare_case_attributes_replace_each_other_and_print_in_bash_order() {
  // bash: -u after -l drops -l; `declare -p` orders flags a A i n r x l u.
  assert_eq!(
    stdout("declare -l s; declare -u s; s=aB; echo $s; declare -x -u t=ab; declare -p t").await,
    "AB\ndeclare -xu t=\"AB\"\n"
  );
  assert_eq!(stdout("declare -u s=ab; declare +u s; s=cD; echo $s").await, "cD\n");
}

#[tokio::test]
async fn declare_nameref_reads_and_writes_its_target() {
  assert_eq!(stdout("t=hello; declare -n r=t; echo $r").await, "hello\n");
  assert_eq!(stdout("t=hello; declare -n r=t; r=new; echo $t").await, "new\n");
  assert_eq!(
    stdout("t=a; declare -n r=t; t=b; echo $r; unset t; echo \"[${r-unset}]\"").await,
    "b\n[unset]\n"
  );
  assert_eq!(stdout("t=1; declare -n r=t; declare -p r").await, "declare -n r=\"t\"\n");
}

#[tokio::test]
async fn nameref_in_a_function_names_the_callers_variable() {
  assert_eq!(
    stdout("set_it() { local -n out=$1; out=done; }; set_it result; echo $result").await,
    "done\n"
  );
}

#[tokio::test]
async fn shift_past_the_end_fails_silently_and_keeps_the_parameters() {
  assert_eq!(stdout("set -- a b; shift 3; echo \"$? $# $1\"").await, "1 2 a\n");
  assert_eq!(stdout("set --; shift; echo $?").await, "1\n");
}

#[tokio::test]
async fn shift_rejects_negative_and_non_numeric_counts() {
  assert_eq!(stdout("set -- a; shift -1; echo \"$? $#\"").await, "1 1\n");
  assert_eq!(stdout("set -- a b; shift 1+1; echo \"$? $#\"").await, "2 2\n");
  assert_eq!(stdout("set -- a b; shift -- 1; echo \"$? $1\"").await, "0 b\n");
}

#[tokio::test]
async fn unset_refuses_readonly_and_continues_with_other_names() {
  assert_eq!(
    stdout("readonly v=1; w=2; unset v w; echo \"$?:$v:[${w-gone}]\"").await,
    "1:1:[gone]\n"
  );
}

#[tokio::test]
async fn unset_removes_array_elements_by_subscript() {
  assert_eq!(
    stdout("a=(x y z); unset 'a[1]'; echo \"${#a[@]} ${!a[@]}\"; unset 'a[-1]'; echo ${a[@]}").await,
    "2 0 2\nx\n"
  );
  assert_eq!(stdout("a=(1 2); unset 'a[@]'; declare -p a").await, "declare -a a=()\n");
  assert_eq!(
    stdout("declare -A m=([x]=1 [y]=2); unset 'm[x]'; declare -p m").await,
    "declare -A m=([y]=\"2\" )\n"
  );
}

#[tokio::test]
async fn unset_options_select_functions_variables_or_namerefs() {
  assert_eq!(
    stdout("f() { echo fn; }; f=1; unset f; echo \"[${f-gone}]\"; f; unset f; f; echo $?").await,
    "[gone]\nfn\n127\n"
  );
  assert_eq!(stdout("t=1; declare -n r=t; unset r; echo \"${t-tgone}\"").await, "tgone\n");
  assert_eq!(
    stdout("t=1; declare -n r=t; unset -n r; echo \"${t-tgone} [${r-rgone}]\"").await,
    "1 [rgone]\n"
  );
  assert_eq!(stdout("unset -v -f v; echo $?; unset -z; echo $?").await, "1\n2\n");
}

#[tokio::test]
async fn unset_of_a_local_keeps_the_global_hidden_and_subshells_do_not_leak() {
  assert_eq!(
    stdout("v=g; f() { local v=l; unset v; echo \"[${v-gone}]\"; }; f; echo $v").await,
    "[gone]\ng\n"
  );
  assert_eq!(
    stdout("v=1; (unset v; echo \"[${v-sub}]\"); x=$(unset v; echo \"[${v-sub}]\"); echo \"$x $v\"").await,
    "[sub]\n[sub] 1\n"
  );
}

#[tokio::test]
async fn declare_array_conversions_follow_bash() {
  assert_eq!(stdout("v=x; declare -a v; declare -p v").await, "declare -a v=([0]=\"x\")\n");
  assert_eq!(stdout("declare -a a; declare -p a; b=(); declare -p b").await, "declare -a a\ndeclare -a b=()\n");
  assert_eq!(stdout("declare -a a=(1 2); declare +a a; echo $?; declare -p a").await, "1\ndeclare -a a=([0]=\"1\" [1]=\"2\")\n");
  assert_eq!(stdout("declare -A -a both; echo $?").await, "2\n");
  assert_eq!(stdout("declare -l -u v=aBc; echo $v").await, "aBc\n");
  assert_eq!(stdout("declare -r v=1; declare +r v; echo \"$? $v\"").await, "1 1\n");
}

#[tokio::test]
async fn random_and_seconds_are_computed_until_unset() {
  let out = stdout("a=$RANDOM; b=$RANDOM; [ $a -le 32767 ] && [ $b -ge 0 ] && echo ok; echo $SECONDS").await;
  assert_eq!(out, "ok\n0\n");
  assert_eq!(stdout("unset RANDOM; echo \"[${RANDOM-gone}]\"").await, "[gone]\n");
}

#[tokio::test]
async fn assignment_to_a_declared_unset_array_sets_element_zero() {
  assert_eq!(stdout("declare -a a; a=x; declare -p a").await, "declare -a a=([0]=\"x\")\n");
}

#[tokio::test]
async fn test_v_sees_variables_elements_keys_and_positionals() {
  assert_eq!(
    stdout("v=; test -v v; echo $?; unset v; [ -v v ]; echo $?; set -- a; test -v 1; echo $?; test -v 2; echo $?").await,
    "0\n1\n0\n1\n"
  );
  assert_eq!(
    stdout("a=(x y); test -v 'a[1]'; echo $?; test -v 'a[5]'; echo $?; declare -A m=([k]=); [[ -v m[k] ]] && echo k; [[ -v m[z] ]] || echo no-z").await,
    "0\n1\nk\nno-z\n"
  );
}

#[tokio::test]
async fn test_o_and_r_ask_the_shell() {
  assert_eq!(
    stdout("test -o noclobber; echo $?; set -C; test -o noclobber; echo $?; test -o nosuch; echo $?").await,
    "1\n0\n1\n"
  );
  assert_eq!(stdout("v=1; declare -n r=v; test -R r; echo $?; test -R v; echo $?").await, "0\n1\n");
}

#[tokio::test]
async fn export_options_follow_bash() {
  assert_eq!(
    stdout("export v=1; export -n v; echo \"$v\"; export w=a; export w+=b; echo $w").await,
    "1\nab\n"
  );
  assert_eq!(stdout("export 1x ok=1; echo $?; export -z; echo $?").await, "1\n2\n");
  assert_eq!(stdout("a=(x y); export a; declare -p a").await, "declare -ax a=([0]=\"x\" [1]=\"y\")\n");
}

fn scratch_file(name: &str) -> String {
  let path = std::env::temp_dir().join(format!("tsh-p1h-{}-{name}", std::process::id()));
  let _ = std::fs::remove_file(&path);
  path.display().to_string()
}

/// A host that opens redirection files for real.
async fn file_stdout(source: &str) -> String {
  let mut h = host();
  h.set_shell_file_opener(std::rc::Rc::new(|path, read, append| {
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .truncate(!read && !append)
      .append(!read && append)
      .open(path)
      .map_err(|e| crate::script::LispHostError::Command(e.to_string()))
  }));
  let out = h.capture_shell_source(source).await.unwrap();
  String::from_utf8(out.stdout).unwrap()
}

#[tokio::test]
async fn descriptor_move_closes_the_source() {
  let f = scratch_file("move");
  let out = file_stdout(&format!(
    "exec 3>{f}; exec 4>&3-; echo hi >&4; echo late >&3; echo \"status=$?\"; exec 4>&-"
  ))
  .await;
  assert_eq!(out, "status=1\n");
  assert_eq!(std::fs::read_to_string(&f).unwrap(), "hi\n");
  assert_eq!(stdout(": 3>&3-; echo $?").await, "0\n");
  let _ = std::fs::remove_file(&f);
}

#[tokio::test]
async fn greater_and_a_word_redirects_both_streams() {
  let f = scratch_file("both");
  file_stdout(&format!("{{ echo out; echo err >&2; }} >&{f}")).await;
  assert_eq!(std::fs::read_to_string(&f).unwrap(), "out\nerr\n");
  let _ = std::fs::remove_file(&f);
}

#[tokio::test]
async fn exec_in_a_subshell_leaves_the_parents_descriptors() {
  let f = scratch_file("subshell");
  file_stdout(&format!("exec 3>{f}; ( exec 3>&- ); echo kept >&3; exec 3>&-")).await;
  assert_eq!(std::fs::read_to_string(&f).unwrap(), "kept\n");
  let _ = std::fs::remove_file(&f);
}

#[tokio::test]
async fn read_options_follow_bash() {
  assert_eq!(stdout("read -a arr <<<\"p q r\"; echo \"${#arr[@]} ${arr[2]}\"").await, "3 r\n");
  assert_eq!(stdout("IFS=, read -a arr <<<\"a,b,,c\"; echo \"${#arr[@]}\"").await, "4\n");
  assert_eq!(stdout("read -d , v <<<\"x,y\"; echo \"[$v]\"").await, "[x]\n");
  assert_eq!(stdout("read -n 2 v <<<\"abcd\"; echo \"[$v]\"; read -N 4 w <<<\"  ab\"; echo \"[$w]\"").await, "[ab]\n[  ab]\n");
  assert_eq!(stdout("read -n 0 v <<<\"abc\"; echo \"$? [${v-unset}]\"").await, "0 []\n");
  assert_eq!(stdout("read 'a[2]' <<<x; echo \"${a[2]}\"; read -ra arr <<<'a\\b c'; echo \"${arr[0]}|${arr[1]}\"").await, "x\na\\b|c\n");
  assert_eq!(stdout("read -z v <<<a; echo $?; read 1x <<<a; echo $?; read -u 9 v; echo $?").await, "2\n1\n1\n");
  assert_eq!(stdout("read -t 5 v <<<quick; echo \"[$v] $?\"; read -t abc v <<<x; echo $?").await, "[quick] 0\n1\n");
}

#[tokio::test]
async fn type_and_command_see_functions_keywords_and_builtins() {
  assert_eq!(
    stdout("f() { :; }; type -t f; type -t if; type -t cd; type cd; type -t nosuch; echo $?").await,
    "function\nkeyword\nbuiltin\ncd is a shell builtin\n1\n"
  );
  assert_eq!(stdout("echo() { :; }; type -ft echo; command -v echo; command -V if").await, "builtin\necho\nif is a shell keyword\n");
  assert_eq!(stdout("f() { echo fn; }; command f; echo $?; command echo hi").await, "127\nhi\n");
  assert_eq!(stdout("type -z; echo $?; command -z; echo $?").await, "2\n2\n");
}

#[tokio::test]
async fn mapfile_options_follow_bash() {
  assert_eq!(
    stdout("mapfile -s 1 -n 1 -t a <<<$'1\\n2\\n3'; declare -p a; { mapfile -n 1 -t b; mapfile -t c; } <<<$'1\\n2\\n3'; declare -p b c").await,
    "declare -a a=([0]=\"2\")\ndeclare -a b=([0]=\"1\")\ndeclare -a c=([0]=\"2\" [1]=\"3\")\n"
  );
  assert_eq!(
    stdout("a=(x y z); mapfile -O 1 -t a <<<$'1\\n2'; declare -p a; mapfile -d : b <<<\"a:b\"; declare -p b").await,
    "declare -a a=([0]=\"x\" [1]=\"1\" [2]=\"2\")\ndeclare -a b=([0]=\"a:\" [1]=$'b\\n')\n"
  );
  assert_eq!(stdout("mapfile -n -1 a; echo $?; mapfile -z; echo $?; mapfile -t 1x <<<a; echo $?").await, "1\n2\n1\n");
}

#[tokio::test]
async fn printf_v_assigns_instead_of_printing() {
  assert_eq!(
    // The test host has no external printf; %q is formatted natively.
    stdout("printf -v v '%q' 'a b'; echo \"[$v]\"; printf -v 'a[2]' '%q' x; echo \"${a[2]}\"; printf -v 1x x; echo $?").await,
    "[a\\ b]\nx\n2\n"
  );
}

#[tokio::test]
async fn declare_f_names_and_readonly_functions() {
  assert_eq!(
    stdout("f() { :; }; declare -F f nosuch; echo $?; declare -F; readonly -f nofunc; echo $?").await,
    "f\n1\ndeclare -f f\n1\n"
  );
  assert_eq!(
    stdout("f() { echo one; }; readonly -f f; f() { echo two; }; echo $?; f; unset -f f; echo $?; declare -F").await,
    "1\none\n1\ndeclare -fr f\n"
  );
}

#[tokio::test]
async fn break_continue_return_and_exit_follow_bash_counts() {
  assert_eq!(stdout("f() { break; }; for i in 1 2; do f; echo in$i; done; echo end").await, "in1\nin2\nend\n");
  assert_eq!(stdout("for i in 1; do for j in 1; do break 0; echo in; done; echo mid; done; echo \"after $?\"").await, "after 1\n");
  assert_eq!(stdout("f() { return abc; echo no; }; f; echo \"after $?\"; exit ' 7x'; echo \"still $?\"").await, "after 2\nstill 2\n");
}

#[tokio::test]
async fn eval_options_blanks_and_syntax_errors_follow_bash() {
  assert_eq!(
    stdout("false; eval '  '; echo $?; eval -- echo hi; eval -x; echo $?; eval 'echo \"open'; echo $?").await,
    "0\nhi\n2\n2\n"
  );
}

#[tokio::test]
async fn source_reports_like_bash_and_keeps_changed_parameters() {
  let f = scratch_file("source.sh");
  std::fs::write(&f, "set -- changed\n").unwrap();
  let out = file_stdout(&format!("set -- orig; . {f} arg; echo \"$1\"; source; echo $?; . -- {f}; echo $1")).await;
  assert_eq!(out, "changed\n2\nchanged\n");
  std::fs::write(&f, "# only a comment\n").unwrap();
  assert_eq!(file_stdout(&format!("false; . {f}; echo $?")).await, "0\n");
  let _ = std::fs::remove_file(&f);
}

#[tokio::test]
async fn exec_options_follow_bash() {
  assert_eq!(stdout("exec -z; echo $?; exec -a; echo $?; exec --; echo $?").await, "2\n2\n0\n");
}

#[tokio::test]
async fn declare_inherit_trace_and_listing_follow_bash() {
  assert_eq!(
    stdout("declare -i n=1; v=outer; f() { declare -I n v; declare -p n; echo $v; }; f; declare -t t=1; declare -p t").await,
    "declare -i n=\"1\"\nouter\ndeclare -t t=\"1\"\n"
  );
  assert_eq!(stdout("readonly v=1; f() { local v=2; echo $v; }; f; echo $?; readonly -n v; echo $?; declare -p v").await, "1\n0\n0\ndeclare -r v=\"1\"\n");
  let listing = stdout("zz1='a b'; zz2=2; arr=(x); declare -p zz1 zz2; declare").await;
  assert!(listing.contains("zz1='a b'\nzz2=2\n"), "{listing}");
  assert!(listing.contains("arr=([0]=\"x\")\n"), "{listing}");
}

#[tokio::test]
async fn getopts_refusal_statuses_follow_bash() {
  assert_eq!(
    stdout("getopts a 1x -a; echo $?; getopts; echo $?; readonly o; getopts a o -a; echo \"$? [${o-unset}]\"").await,
    "1\n2\n2 [unset]\n"
  );
}

#[tokio::test]
async fn local_dash_restores_set_options_at_return() {
  assert_eq!(
    stdout("f() { local -; set -f; }; f; case $- in *f*) echo leaked;; *) echo restored;; esac").await,
    "restored\n"
  );
}

#[tokio::test]
async fn underscore_is_the_previous_commands_last_word() {
  assert_eq!(stdout(": hello world; echo \"$_\"; : a b; echo $_").await, "world\nb\n");
}

#[tokio::test]
async fn prefix_assignments_expand_left_to_right() {
  // bash 5: each prefix assignment sees the ones before it, and the shell's
  // own variable is untouched afterwards.
  assert_eq!(
    stdout("f(){ echo $A $FOO; }; FOO=x; FOO=y A=$FOO f; echo $FOO").await,
    "y y\nx\n"
  );
  assert_eq!(stdout("g(){ echo $B; }; B+=1 B+=2 g").await, "12\n");
}
