use super::bash_tests::{bash, host};
use super::*;

#[tokio::test]
async fn paren_subshell_isolates_variables_functions_positionals_and_options() {
  let mut host = host();
  let out = host.capture_shell_source(
    "x=outer; set -- original; f(){ echo outer; }; (x=inner; set -- changed; set -f; f(){ echo inner; }; echo $x:$1); echo $x:$1; f"
  ).await.unwrap();
  assert_eq!(out.stdout, b"inner:changed\nouter:original\nouter\n");
  assert!(!host.shell_compound.noglob.get());
  let out = host
    .capture_shell_source("(echo before; exit 7; echo bad); echo $?")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"before\n7\n");
}

#[tokio::test]
async fn paren_group_keeps_state_and_subshell_status_reaches_lists() {
  let mut host = host();
  let out = host
    .capture_shell_source(
      "x=outer; { x=group; }; echo $x; true && (echo child; false) || echo failed; echo $x",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"group\nchild\nfailed\ngroup\n");
  assert!(
    bash(&mut host, "set -e; (false; echo bad); echo bad")
      .await
      .is_err()
  );
}

#[tokio::test]
async fn paren_arithmetic_commands_assignment_short_circuit_and_for() {
  let mut host = host();
  let out = host.capture_shell_source(
    "((1)); echo $?; ((0)); echo $?; x=2; echo $((x+=3)); let 'x++'; echo $x; echo $((0 && (x=99))); echo $x; for ((i=0; i<3; i++)); do echo $i; done"
  ).await.unwrap();
  assert_eq!(out.stdout, b"0\n1\n5\n6\n0\n6\n0\n1\n2\n");
}

#[tokio::test]
async fn paren_parameter_default_is_lazy_and_preserves_inner_quotes() {
  let mut host = host();
  host.register_native_special("argv", |args| {
    Ok(super::super::LispValue::List(tento_lisp::List {
      items: args.into(),
    }))
  });
  assert_eq!(
    host.eval_posix_line(r#"argv ${missing:-"a b" c}"#).unwrap(),
    serde_json::json!(["a b", "c"])
  );
  assert_eq!(
    host.eval_posix_line(r#"argv "${missing:-a b c}""#).unwrap(),
    serde_json::json!(["a b c"])
  );
  let out = host.capture_shell_source(
    "x=present; echo ${x:-$(echo bad >&2)}; echo ${unset:=${other:-fallback}}; echo $unset; empty=''; echo ${empty-no}:${empty:-yes}:${empty+set}:${empty:+no}"
  ).await.unwrap();
  assert_eq!(out.stdout, b"present\nfallback\nfallback\n:yes:set:\n");
  assert!(host.take_shell_diagnostics().is_empty());
}

#[tokio::test]
async fn paren_parameter_patterns_substrings_case_and_specials() {
  let mut host = host();
  let out = host.capture_shell_source(
    "x=abcabc; echo ${#x}:${x#a*}:${x##a*}:${x%c*}:${x%%c*}; echo ${x/a/X}:${x//a/X}:${x/#a/X}:${x/%c/X}; echo ${x:1:3}:${x: -2}; x=aBc; echo ${x^}:${x^^}:${x,}:${x,,}; echo $$"
  ).await.unwrap();
  assert_eq!(
    String::from_utf8(out.stdout).unwrap(),
    format!(
      "6:bcabc::abcab:ab\nXbcabc:XbcXbc:Xbcabc:abcabX\nbca:bc\nABc:ABC:aBc:abc\n{}\n",
      std::process::id()
    )
  );
}

#[test]
fn paren_chunker_balances_shell_quotes_and_lisp_comments() {
  let chunks: Vec<_> =
    coalesce_balanced_lines("(echo ')' ;\necho ok)\necho after\n> (let x ;; ignored )\n 1)")
      .collect();
  assert_eq!(chunks.len(), 3);
  assert_eq!(chunks[1].0, 3);
  assert_eq!(chunks[2].0, 4);
}

#[tokio::test]
async fn paren_subshell_cwd() {
  // cwd is process-global. Run this one assertion in a child test process so
  // concurrently running reader/host tests cannot observe its temporary cd.
  if std::env::var_os("TENTO_04P_CWD_CHILD").is_none() {
    let status = std::process::Command::new(std::env::current_exe().unwrap())
      .args([
        "--exact",
        "script::runner::paren_tests::paren_subshell_cwd",
        "--nocapture",
      ])
      .env("TENTO_04P_CWD_CHILD", "1")
      .status()
      .unwrap();
    assert!(status.success());
    return;
  }
  let original = std::env::current_dir().unwrap();
  let mut host = host();
  host.register_native_special("cd", |args| {
    let [super::super::LispValue::String(path)] = args.as_slice() else {
      unreachable!()
    };
    std::env::set_current_dir(path.as_str()).map_err(|e| LispHostError::Command(e.to_string()))?;
    Ok(super::super::LispValue::Nil)
  });
  host.register_native_special("pwd", |_| {
    Ok(super::super::LispValue::String(
      std::env::current_dir().unwrap().display().to_string().into(),
    ))
  });
  let out = host.capture_shell_source("(cd /; pwd); pwd").await.unwrap();
  assert_eq!(
    out.stdout,
    format!("/\n{}\n", original.display()).as_bytes()
  );
  assert_eq!(std::env::current_dir().unwrap(), original);
}

#[tokio::test]
async fn paren_whole_list_redirections_and_option_restoration() {
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
  let path = std::env::temp_dir().join(format!("tento-04p-redirection-{}", std::process::id()));
  let quoted = serde_json::to_string(&path.to_string_lossy()).unwrap();
  let out = host
    .capture_shell_source(&format!(
      "(echo one; echo two) >{quoted}; {{ echo three; echo four; }} >>{quoted}; echo after"
    ))
    .await
    .unwrap();
  assert_eq!(out.stdout, b"after\n");
  assert_eq!(std::fs::read(&path).unwrap(), b"one\ntwo\nthree\nfour\n");
  std::fs::remove_file(path).unwrap();
  let out = host
    .capture_shell_source("(set -u; set -f; echo child); echo $missing")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"child\n\n");
  assert!(!host.shell_compound.commands.nounset.get());
  assert!(!host.shell_compound.noglob.get());
}

#[tokio::test]
async fn paren_nounset_default_error_and_arithmetic_zero_divisor_are_loud() {
  let mut host = host();
  let out = host
    .capture_shell_source("set -u; echo ${unset:-safe}; echo ${unset+no}")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"safe\n\n");
  assert!(bash(&mut host, "echo $unset").await.is_err());
  host.shell_compound.commands.nounset.set(false);
  assert!(
    bash(&mut host, "echo ${unset:?required}")
      .await
      .unwrap_err()
      .to_string()
      .contains("required")
  );
  host.collect_shell_diagnostics();
  let out = host.capture_shell_source("((1/0)); echo $?").await.unwrap();
  assert_eq!(out.stdout, b"1\n");
  assert!(
    host
      .take_shell_diagnostics()
      .iter()
      .any(|error| error.contains("division by 0"))
  );
}

#[tokio::test]
async fn paren_fallback_positionals_pattern_quotes_and_zero_length_matches() {
  let mut host = host();
  host.register_native_special("argv", |args| {
    Ok(super::super::LispValue::List(tento_lisp::List {
      items: args.into(),
    }))
  });
  host.set_shell_positionals("tsh".into(), vec!["a b".into(), "".into(), "c".into()]);
  assert_eq!(
    host.eval_posix_line(r#"argv ${missing:-"$@"}"#).unwrap(),
    serde_json::json!(["a b", "", "c"])
  );
  let out = host
    .capture_shell_source(
      r#"x=abc; echo "${x#'a*'}:${x#a*}"; echo ${x//*/R}; echo ${x//}; echo "${missing:-'a b'}"; echo "${x/a/'R'}:${x/a/&}:${x/a/"&"}""#,
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"abc:bc\nR\nabc\n'a b'\nRbc:abc:&bc\n");
}

#[tokio::test]
async fn paren_arithmetic_for_continue_break_and_empty_headers() {
  let mut host = host();
  let out = host.capture_shell_source(
    "for ((i=0;i<3;i++)); do if ((i==1)); then continue; fi; echo $i; done; for ((;;)); do echo once; break; done"
  ).await.unwrap();
  assert_eq!(out.stdout, b"0\n2\nonce\n");
}

#[tokio::test]
async fn paren_expansions_assign_in_word_order_and_recursive_arithmetic_can_assign() {
  let mut host = host();
  let out = host.capture_shell_source(
    "echo ${x:=2} $((x++)) $x; formula='next=7'; echo $((formula)) $next; echo $((x=5)) $x"
  ).await.unwrap();
  assert_eq!(out.stdout, b"2 2 3\n7 7\n5 5\n");
}

#[tokio::test]
async fn paren_parameter_length_slice_and_case_respect_c_locale() {
  let mut host = host();
  let map = tento_env::EnvMap::new();
  map.set("LC_ALL", "C");
  let out = tento_env::with_env_map_async(map.clone(), host.capture_shell_source(
    "x=éé; echo ${#x}:${x:2:2}:${x^^}"
  )).await.unwrap();
  assert_eq!(out.stdout, "4:é:éé\n".as_bytes());
  map.set("LC_ALL", "en_US.UTF-8");
  let out = tento_env::with_env_map_async(map, host.capture_shell_source(
    "x=éé; echo ${#x}:${x:1:1}:${x^^}"
  )).await.unwrap();
  assert_eq!(out.stdout, "2:é:ÉÉ\n".as_bytes());
}

#[tokio::test]
async fn paren_explicit_bash_file_and_shebang_choose_bash_for_bare_parens() {
  let mut host = host();
  run_source_on_host(
    &mut host,
    "(true)",
    &Scripts::new(()),
    &HashMap::new(),
    &[],
    RunOptions {
      source_path: Some("source.sh".into()),
      on_error: OnError::Bash,
      ..Default::default()
    },
  )
  .await
  .unwrap();
  assert!(host.shell_last_statement_bash());
  bash(&mut host, "#!/usr/bin/env bash\n(false)")
    .await
    .unwrap();
  assert_eq!(host.shell_status(), 1);
}

fn lisp_file(path: &str) -> RunOptions {
  RunOptions { source_path: Some(path.into()), on_error: OnError::Bash, ..Default::default() }
}

/// I10: `;;`, nested `(; … ;)` blocks (inline or spanning lines) and several
/// forms on one line all run as lisp. A single `;` that starts a line is
/// still a comment, warned once per source.
#[tokio::test]
async fn wat_comments_run_and_a_single_semicolon_comment_warns_once_per_source() {
  let mut host = host();
  host.collect_shell_diagnostics();
  let source = "; old comment\n(let a \"one\") (let b \"two\") ;; both run\n(; a block\n   (; nested ;) ;)\n  ; again\n(let c (; inline ;) (list a\n  ; inside a form\n  b))\n";
  let scripts = Scripts::new(());
  run_source_on_host(&mut host, source, &scripts, &HashMap::new(), &[], lisp_file("x.tsh")).await.unwrap();
  assert_eq!(host.eval_to_json("c").unwrap(), serde_json::json!(["one", "two"]));
  assert_eq!(
    host.take_shell_diagnostics(),
    vec!["tsh: x.tsh: line 1: deprecated: use ;; for a comment (a single ; is not lisp)".to_string()]
  );
  host.collect_shell_diagnostics();
  run_source_on_host(&mut host, source, &scripts, &HashMap::new(), &[], lisp_file("x.tsh")).await.unwrap();
  assert!(host.take_shell_diagnostics().is_empty(), "one warning per source");
  host.collect_shell_diagnostics();
  run_source_on_host(&mut host, "(let d\n  ; inside\n 1)", &scripts, &HashMap::new(), &[], lisp_file("y.tsh"))
    .await.unwrap();
  assert_eq!(
    host.take_shell_diagnostics(),
    vec!["tsh: y.tsh: line 2: deprecated: use ;; for a comment (a single ; is not lisp)".to_string()]
  );
  // Migrated sources and bash files never warn.
  host.collect_shell_diagnostics();
  run_source_on_host(&mut host, ";; new\n(let e 1)", &scripts, &HashMap::new(), &[], lisp_file("z.tsh")).await.unwrap();
  run_source_on_host(&mut host, "; true", &scripts, &HashMap::new(), &[], lisp_file("w.sh")).await.ok();
  let diagnostics = host.take_shell_diagnostics();
  assert!(diagnostics.iter().all(|d| !d.contains("deprecated")), "{diagnostics:?}");
}

/// A2 correction: a single `;` after a lisp form makes the line bash, so the
/// rest of the line runs, as in bash; nothing is dropped.
#[tokio::test]
async fn paren_single_semicolon_after_a_form_runs_the_line_as_bash() {
  let mut host = host();
  let out = host.capture_shell_source("(true); echo AFTER").await.unwrap();
  assert_eq!(out.stdout, b"AFTER\n");
  let out = host.capture_shell_source("(x=inner); echo \"[$x]\"").await.unwrap();
  assert_eq!(out.stdout, b"[]\n");
  let error = bash(&mut host, "> (let touched 1); echo AFTER").await.unwrap_err();
  assert!(error.to_string().contains("a single `;` is not lisp"), "{error}");
  assert!(host.eval_to_json("touched").is_err());
}

/// The lisp reader names `;;` when it meets a single `;` after code.
#[test]
fn lisp_reader_refuses_a_single_semicolon_after_code() {
  let mut host = host();
  let error = host.eval_stmt("(let x 1) ; comment").unwrap_err().to_string();
  assert!(error.contains("a single `;` is not lisp — write `;;` for a comment"), "{error}");
  assert!(host.eval_to_json("x").is_err());
}
