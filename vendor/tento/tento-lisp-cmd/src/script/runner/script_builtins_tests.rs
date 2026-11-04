use super::bash_tests::{bash, host};
use super::*;

/// `printf '[%s]\n' ARGS…` in shell: one bracketed line per word, `[]` for
/// none. printf is the host's utility, which the test host does not run.
const EACH: &str = "each(){ case $# in 0) set -- '';; esac; for w in \"$@\"; do echo \"[$w]\"; done; }; ";

#[tokio::test]
async fn script_scalar_array_and_local_append() {
  let mut host = host();
  let out = host.capture_shell_source(
    "x=a; x+=b; a=(x 'y z'); a+=(w); declare x+=c; declare a+=(q); f(){ local x=a; local x+=b; local a=(x); local a+=(y); echo \"$x:${a[*]}\"; }; echo \"$x:${a[*]}\"; f"
  ).await.unwrap();
  assert_eq!(out.stdout, b"abc:x y z w q\nab:x y\n");
  let out = host
    .capture_shell_source("declare -i n=2; n+=3; declare n+=4; echo $n")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"9\n");
  let out = host
    .capture_shell_source(
      &[EACH, "a=([2]=x); a+=(z [5]=y w); each \"${!a[@]}\"; each \"${a[@]}\""].concat(),
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"[2]\n[3]\n[5]\n[6]\n[x]\n[z]\n[y]\n[w]\n");
}

/// A5: one variable store. A name made readonly by bash `readonly` stops a
/// bash assignment and every lisp assignment alike, loudly.
#[tokio::test]
async fn script_readonly_binds_bash_and_lisp_assignments_alike() {
  for assignment in ["r=2", "r+=x", "r=(x)", "r+=(x)"] {
    for prefix in ["", "set -e; "] {
      let mut host = host();
      host.collect_shell_diagnostics();
      // bash 5.3 discards the rest of the line, and exits under `set -e`.
      let result = bash(
        &mut host,
        &format!("{prefix}readonly r=1; {assignment}; echo bad"),
      )
      .await;
      if prefix.is_empty() {
        assert!(result.is_ok(), "{assignment}: {result:?}");
      } else {
        assert!(matches!(
          result.unwrap_err().kind,
          TshScriptErrorKind::Control(super::super::bash_compound::ControlSignal::Exit(1))
        ));
      }
      assert_eq!(host.shell_status(), 1);
      assert!(
        host
          .take_shell_diagnostics()
          .iter()
          .any(|s| s.contains("r: readonly variable"))
      );
    }
  }
  for assignment in ["(let r \"lisp\")", "(set r \"lisp\")", "(define (r) 1)", "(defun r () 1)", "(fn r () 1)"] {
    let mut host = host();
    bash(&mut host, "readonly r=1").await.unwrap();
    let error = host.eval_stmt(assignment).unwrap_err();
    assert!(error.to_string().contains("r: readonly variable"), "{assignment}: {error}");
    assert_eq!(host.eval_to_json("r").unwrap(), "1", "{assignment}");
  }
  // An inner `let` may shadow the name; the variable itself is unchanged.
  let mut host = host();
  bash(&mut host, "readonly r=1").await.unwrap();
  assert_eq!(host.eval_to_json("(let ((r 2)) r)").unwrap(), 2);
  assert_eq!(host.eval_to_json("r").unwrap(), "1");
}

#[tokio::test]
async fn script_readonly_declarations_print_and_fail_with_errexit() {
  let mut host = host();
  let out = host
    .capture_shell_source("readonly r=1 s; readonly -p; readonly -p r s; echo $r")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"declare -r r=\"1\"\ndeclare -r s\n1\n");
  let error = bash(&mut host, "set -e; readonly r=2; echo bad")
    .await
    .unwrap_err();
  assert!(matches!(error.kind, TshScriptErrorKind::BashStatus(1)));
}

#[tokio::test]
async fn script_getopts_clusters_arguments_end_and_reset() {
  let mut host = host();
  let out = host.capture_shell_source(
    "set -- -ab value -- tail; while getopts ab: o; do echo \"$o:${OPTARG-unset}:$OPTIND\"; done; echo \"end:$o:${OPTARG-unset}:$OPTIND\"; OPTIND=1; getopts ab o -ab; echo \"$o:$OPTIND\"; OPTIND=1; getopts ab o -ab; echo \"$o:$OPTIND\"; getopts ab o -ab; echo \"$o:$OPTIND\""
  ).await.unwrap();
  assert_eq!(
    out.stdout,
    b"a:unset:1\nb:value:3\nend:?:unset:4\na:1\na:1\nb:2\n"
  );
}

#[tokio::test]
async fn script_getopts_silent_and_diagnostic_errors() {
  let mut host = host();
  host.collect_shell_diagnostics();
  let out = host.capture_shell_source(
    "while getopts :ab: o -z -b; do case $o in '?') echo \"unknown:$OPTARG\" ;; ':') echo \"missing:$OPTARG\" ;; esac; done"
  ).await.unwrap();
  assert_eq!(out.stdout, b"unknown:z\nmissing:b\n");
  assert!(host.take_shell_diagnostics().is_empty());
  host.collect_shell_diagnostics();
  let out = host
    .capture_shell_source("OPTIND=1; getopts ab: o -z; echo \"$o:${OPTARG-unset}:$?\"")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"?:unset:0\n");
  assert!(
    host
      .take_shell_diagnostics()
      .iter()
      .any(|s| s.contains("illegal option -- z"))
  );
}

#[tokio::test]
async fn script_getopts_function_loop_unsets_global_optarg() {
  let mut host = host();
  let out = host.capture_shell_source(
    "set -- -b value; f(){ while getopts ab: o; do echo \"$o:${OPTARG-unset}:$OPTIND\"; done; }; f \"$@\"; echo \"$o:${OPTARG-unset}:$OPTIND\"; OPTIND=1; f -a; echo \"$o:${OPTARG-unset}:$OPTIND\""
  ).await.unwrap();
  assert_eq!(out.stdout, b"b:value:3\n?:unset:3\na:unset:2\n?:unset:2\n");
}

#[tokio::test]
async fn script_array_keys_prefix_names_and_quote_cardinality() {
  let mut host = host();
  let out = host.capture_shell_source(
    &[EACH, "a=([2]=x [5]=y); p1b_one=a; p1b_two=b; IFS=:; each \"${!a[@]}\" \"${!a[*]}\" \"${!p1b_@}\" \"${!p1b_*}\""].concat()
  ).await.unwrap();
  assert_eq!(
    out.stdout,
    b"[2]\n[5]\n[2:5]\n[p1b_one]\n[p1b_two]\n[p1b_one:p1b_two]\n"
  );
  let out = host
    .capture_shell_source(&[EACH, "declare -A m; m[key]=value; each \"${!m[@]}\""].concat())
    .await
    .unwrap();
  assert_eq!(out.stdout, b"[key]\n");
  let out = host.capture_shell_source("a=([2]=x [5]=y); IFS=:; x=\"${!a[@]}\"; echo \"$x\"; a=(x 'y z'); x=\"${a[@]-fallback}\"; echo \"$x\"").await.unwrap();
  assert_eq!(out.stdout, b"2:5\nx y z\n");
}

#[tokio::test]
async fn script_array_default_words_are_lazy_and_preserve_fields() {
  let mut host = host();
  host.collect_shell_diagnostics();
  let out = host.capture_shell_source(
    &[EACH, "a=(); each ${a[@]+\"${a[@]}\"}; a=(x 'y z'); each ${a[@]+\"${a[@]}\"}; each \"${a[@]-${miss:?bad}}\"; a=('' ''); each \"${a[@]:+yes}\"; IFS=''; each \"${a[*]:-no}\""].concat()
  ).await.unwrap();
  assert_eq!(out.stdout, b"[]\n[x]\n[y z]\n[x]\n[y z]\n[yes]\n[no]\n");
  let out = host.capture_shell_source(&[EACH, "a=(x); each \"${a[@]-$(echo bad >&2)}\"; a=(); each ${a[@]+\"$(echo bad >&2)\"}"].concat()).await.unwrap();
  assert_eq!(out.stdout, b"[x]\n[]\n");
  assert!(host.take_shell_diagnostics().is_empty());
  // A bad subscript discards the command; `?` is a parameter error that
  // ends the script (bash 5.3).
  for (source, exits) in [
    ("a=(); echo ${a[@]=x}", false),
    ("a=(''); echo ${a[*]:=x}", false),
    ("a=(); echo ${a[@]?missing}", true),
  ] {
    let mut host = super::bash_tests::host();
    assert_eq!(bash(&mut host, source).await.is_err(), exits, "{source}");
    assert_eq!(host.shell_status(), 1);
  }
}

/// Bash 5.3: unquoted `${!prefix*}` and `${!a[*]}` under a null IFS are one
/// word, joined with "" and " " respectively (oils word-split bug #627),
/// while their `@` forms keep a word per name.
#[tokio::test]
async fn script_name_lists_join_under_a_null_ifs_as_bash_does() {
  let mut host = host();
  let out = host.capture_shell_source(
    &[EACH, "p1b_one=a; p1b_two=b; a=(v1 v2 v3); IFS=''; each ${!p1b_*}; each ${!a[*]}; each ${!p1b_@} ${!a[@]}; set -- ${!p1b_none*}; echo \"$#\""].concat()
  ).await.unwrap();
  assert_eq!(
    out.stdout,
    b"[p1b_onep1b_two]\n[0 1 2]\n[p1b_one]\n[p1b_two]\n[0]\n[1]\n[2]\n0\n"
  );
}

/// An alternative word that is not taken leaves the expansion as it is, as
/// bash 5.3 does: quoted `"${a[@]:+w}"` is one empty word over `a=("")` and
/// none over `a=()`; `"${@:+w}"` and `"${@:-w}"` are `"$@"` when not taken.
#[tokio::test]
async fn script_untaken_alternatives_keep_the_expansion_cardinality() {
  let mut host = host();
  let out = host.capture_shell_source(
    "count(){ echo \"$#\"; }; a=(''); count \"${a[@]:+w}\"; a=(); count \"${a[@]:+w}\"; count \"${a[@]+w}\"; \
     set --; count \"${@:+w}\"; set -- ''; count \"${@:+w}\"; set -- x 'y z'; count \"${@:-w}\"; count \"${@-w}\""
  ).await.unwrap();
  assert_eq!(out.stdout, b"1\n0\n0\n0\n1\n2\n2\n");
}

#[tokio::test]
async fn script_readonly_read_loop_and_prefix_status() {
  for source in [
    "readonly r=1; read r <<<2; echo \"$?:$r\"",
    "readonly r=1; for r in a; do echo bad; done; echo \"$?:$r\"",
    "readonly r=1; r=2 true; echo \"$?:$r\"",
    "readonly r=1; export r=2; echo \"$?:$r\"",
  ] {
    let mut host = host();
    host.collect_shell_diagnostics();
    let out = host.capture_shell_source(source).await.unwrap();
    assert_eq!(out.stdout, b"1:1\n", "{source}");
    assert!(
      host
        .take_shell_diagnostics()
        .iter()
        .any(|s| s.contains("r: readonly variable"))
    );
  }
}

#[tokio::test]
async fn script_array_default_operator_matrix() {
  for (setup, present, nonnull) in [
    ("unset a", false, false),
    ("a=()", false, false),
    ("a=('')", true, false),
    ("a=(x 'y z')", true, true),
  ] {
    for selector in ["@", "*"] {
      for op in ["+", "-", "=", "?", ":+", ":-", ":=", ":?"] {
        let mut host = host();
        let source = format!("{setup}; set -- \"${{a[{selector}]{op}word}}\"; echo \"$#:[$*]\"");
        let exists = if op.starts_with(':') {
          nonnull
        } else {
          present
        };
        let operator = op.chars().last().unwrap();
        let selected = if operator == '+' { exists } else { !exists };
        if selected && matches!(operator, '=' | '?') {
          // `=` discards the command, `?` ends the script (bash 5.3).
          assert_eq!(bash(&mut host, &source).await.is_err(), operator == '?', "{source}");
          assert_eq!(host.shell_status(), 1);
        } else {
          let expected = if selected {
            "1:[word]\n"
          } else if operator == '+' {
            // Not taken, `"${a[@]…}"` is `"${a[@]}"`: one empty word over
            // `a=('')`, none over no elements (bash 5.3).
            if selector == "@" && !present { "0:[]\n" } else { "1:[]\n" }
          } else if nonnull {
            if selector == "@" {
              "2:[x y z]\n"
            } else {
              "1:[x y z]\n"
            }
          } else {
            "1:[]\n"
          };
          let out = host.capture_shell_source(&source).await.unwrap();
          assert_eq!(out.stdout, expected.as_bytes(), "{source}");
        }
      }
    }
  }
}

#[tokio::test]
async fn script_arithmetic_shifts_execute() {
  let mut host = host();
  let out = host
    .capture_shell_source("echo $((1<<3)) $((32>>2)); ((x=1<<4)); echo $x")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"8 8\n16\n");
}
