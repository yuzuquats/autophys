use super::*;
use string_interner::{backend::StringBackend, symbol::SymbolU32};

fn plan(source: &str) -> Result<serde_json::Value, PosixReadError> {
  let mut interner = StringInterner::<StringBackend>::new();
  let form = read_shell_plan::<SymbolU32, _>(source, &mut interner)?;
  Ok(sexpr_to_json(&form, &interner))
}

#[test]
fn corpus_process_substitutions_are_named_before_flow_lexing() {
  for source in [
    "diff <(printf a | cat) <(printf b)",
    "check() { for r in a b; do cat <(printf %s $r) | cat; done; }; check",
    "cat \\\n <(printf x)",
    "cat >(cat)",
    "echo $(cat <(printf x))",
  ] {
    let form = plan(source).unwrap();
    assert!(form.to_string().contains("\"sym\":\"std.sh.process-sub\""), "{source}: {form}");
  }
  let form = plan("diff <(printf a | cat) <(printf b)").unwrap();
  assert_eq!(form["list"][0], serde_json::json!({"sym": "std.sh.cmd"}));
  assert_eq!(form["list"][1], serde_json::json!({"str": "diff"}));
  assert_eq!(form["list"][2]["list"][1]["list"][1], serde_json::json!({"bool": false}));
  assert_eq!(form["list"][2]["list"][1]["list"][2]["list"][0],
    serde_json::json!({"sym": "std.sh.pipe"}));
  let form = plan("cat >(cat)").unwrap();
  assert_eq!(form["list"][2]["list"][1]["list"][1], serde_json::json!({"bool": true}));
  // `select` is read since Q7/Q8; coproc is still deferred.
  assert!(plan("select x in a; do :; done").is_ok());
  for source in ["coproc cat"] {
    assert!(matches!(plan(source), Err(PosixReadError::ShellOperatorUnsupported(_))), "{source}");
  }
  for source in ["echo '<(x)'", "echo \"<(x)\"", "echo \\<\\(x\\)"] {
    assert!(plan(source).is_ok(), "{source}");
  }
}

#[test]
fn corpus_lists_allow_newlines_after_semicolons_and_flow_operators() {
  for source in [
    "A=one;\ncd $A/x;\nls .",
    "echo a;\n# a comment\necho b",
    "echo a &&\necho b",
    "echo a |\ncat",
    "f() { for r in a b; do printf %s $r | cat; done; echo end; }; f",
  ] {
    assert!(plan(source).is_ok(), "{source}: {:?}", plan(source));
  }
}

#[test]
fn corpus_substitution_balance_handles_comments_and_case_patterns() {
  for source in [
    "echo $(printf x # unmatched ( in comment\n)",
    "echo $(case x in x) printf yes ;; *) printf no ;; esac)",
    "echo $(case x in (x|y) printf yes ;; esac)",
  ] {
    assert!(plan(source).is_ok(), "{source}: {:?}", plan(source));
  }
}

#[test]
fn corpus_eof_heredocs_read_with_a_warning_plan() {
  for source in [
    "cat <<'END'",
    "cat <<'END'\nbody",
    "cat <<END\n",
    "cat <<A <<B\nrest",
  ] {
    let form = plan(source).unwrap();
    assert!(
      form.to_string().contains("std.sh.heredoc-warning"),
      "{source}: {form}"
    );
  }
  assert!(
    !plan("cat <<END\nbody\nEND")
      .unwrap()
      .to_string()
      .contains("std.sh.heredoc-warning")
  );
}

#[test]
fn corpus_heredoc_expansion_failures_refuse_by_name() {
  for source in ["cat <<END\n`f()`\nEND", "cat <<END\n`unclosed\nEND"] {
    assert!(
      matches!(plan(source), Err(PosixReadError::ShellExpansionUnsupported(ref name))
      if name == "here-document expansion"),
      "{source}: {:?}",
      plan(source)
    );
  }
}

#[test]
fn corpus_numeric_command_before_combined_redirect_is_separate() {
  let form = plan("2&>1").unwrap().to_string();
  assert!(form.contains("\"str\":\"2\""), "{form}");
  assert!(form.contains("\"str\":\"&>\""), "{form}");
}

#[test]
fn corpus_named_descriptors_require_a_word_boundary() {
  let form = plan("echo {myvar}>out").unwrap().to_string();
  assert!(form.contains("\"str\":\"myvar\""), "{form}");
  for source in [
    "echo x={myvar}>out",
    "echo +{myvar}>out",
    "echo '{myvar}'>out",
  ] {
    let form = plan(source).unwrap().to_string();
    assert!(!form.contains("\"str\":\"myvar\""), "{source}: {form}");
  }
}

#[test]
fn corpus_indexed_arrays_and_pipeline_status_read() {
  for source in [
    "a=(one 'two three'); echo \"${a[@]}\"",
    "a[3]=word; echo ${a[3]} ${#a[@]}",
    "a+=(next); echo ${a[*]}",
    "false | true; echo ${PIPESTATUS[0]} ${PIPESTATUS[@]}",
    "echo ${pipestatus[1]}",
    "a=(); echo \"${a[@]}\"",
    "echo $(( $(printf 2) + 3 ))",
    "echo ${a[@]:1}",
  ] {
    assert!(plan(source).is_ok(), "{source}: {:?}", plan(source));
  }
  assert_eq!(plan("declare -A a").unwrap(),
    serde_json::json!({"list": [{"sym": "std.sh.cmd"}, {"str": "declare"}, {"str": "-A"}, {"str": "a"}]}));
  let form = plan("a=([key]=value)").unwrap();
  assert!(form.to_string().contains("\"sym\":\"std.sh.array-index\""), "{form}");
  for source in ["echo ${!a:-d}"] {
    assert!(
      matches!(
        plan(source),
        Err(
          PosixReadError::ShellOperatorUnsupported(_)
            | PosixReadError::ShellExpansionUnsupported(_)
        )
      ),
      "{source}: {:?}",
      plan(source)
    );
  }
}

#[test]
fn corpus_stderr_pipes_duplicate_after_explicit_redirections() {
  for source in ["echo x 2>err |& cat", "{ echo x; } 2>err |& cat"] {
    let form = plan(source).unwrap().to_string();
    assert!(form.contains("std.sh.pipe"), "{source}: {form}");
    assert!(
      form.find("err").unwrap() < form.find(">&").unwrap(),
      "{source}: {form}"
    );
  }
}

#[test]
fn corpus_old_style_substitution_parse_failures_are_named() {
  assert!(matches!(plan("echo \"`echo >`\""),
    Err(PosixReadError::ShellExpansionUnsupported(ref name)) if name == "backtick substitution"));
}
