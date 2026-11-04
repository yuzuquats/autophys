use super::*;
use string_interner::{backend::StringBackend, symbol::SymbolU32};

fn plan(source: &str) -> Result<String, PosixReadError> {
  let mut interner = StringInterner::<StringBackend>::new();
  let expr = read_statement::<SymbolU32, _>(source, &mut interner)?;
  Ok(format!("{expr:?}"))
}

#[test]
fn paren_lisp_comments_do_not_complete_a_shell_subshell() {
  for source in [
    "(bundle (m)\n (define x true) ;; double comment\n ;; unmatched ) | < >",
    "(bundle (m)\n (define x true) ;; double comment\n ; unmatched ) | < >",
    "(bundle (m)\n (define x true) ;; unmatched ) | < >",
    "(bundle (m) (; a block ) | < ; (; nested ;) ;)\n (define x true))",
    r#"(list '("a > b") "\"" "|" "<")"#,
  ] {
    assert!(!bash_paren_statement(source), "{source}");
  }
  for source in ["(a; b)", "(a; b) > out", "(a || b)", "(case x in x) a ;; esac)"] {
    assert!(bash_paren_statement(source), "{source}");
  }
}

/// I10 / A2: a single `;` after code is not lisp, so the statement is bash;
/// several forms and `;;` comments on one line stay lisp.
#[test]
fn paren_single_semicolon_after_code_is_bash() {
  for source in [
    "(true); echo AFTER",
    "(let x 1) ; trailing comment",
    "(let x ; comment\n 1)",
    "(echo 'x) y'; echo ok)",
    "(bundle (m)\n (define x true) ; single comment\n ;; unmatched ) | < >",
  ] {
    assert!(bash_paren_statement(source), "{source}");
  }
  for source in [
    "(let a 1) (let b 2)",
    "(let a 1) (let b 2) ;; both",
    "(let x ;; comment\n 1)",
    "(let x\n  ; deprecated line comment\n 1)",
    r#"(echo "a; b")"#,
  ] {
    assert!(!bash_paren_statement(source), "{source}");
  }
}

#[test]
fn compound_reader_accepts_single_and_multiline_grammar() {
  for source in [
    "(echo a; echo b)",
    "true && (false || echo yes)",
    "((i++))",
    "for ((i=0;i<3;i++)); do :; done",
    "(echo a; echo b) >out",
    "({ echo a; } >out)",
    "if true; then echo yes; fi",
    "if false; then :; elif true; then :; else :; fi",
    "if true\nthen\necho yes\nfi",
    "for x in a 'b c'; do echo $x; done",
    "for x\ndo echo $x\ndone",
    "while false; do :; done",
    "until true; do :; done",
    "case x in (a|b) : ;; x) echo yes ;; esac",
    "case x in x) : ;& *) : ;;& y) : ;; esac",
    "{ echo yes; }",
    "{\necho yes\n}",
    "f() { echo yes; }",
    "function f () { :; }",
    "function f if true; then :; fi",
    "f()\n{ :; }",
    "while read -r x; do echo $x; done < input",
    "{ echo hi; } > out",
    "if true; then :; fi 2>&1",
    "echo hi | while read x; do echo $x; done",
    "for x in b a; do echo $x; done | sort",
    "if ! false && true; then : || :; fi",
    "echo if for while case function done fi esac then do in",
    "echo hi;\n",
  ] {
    assert!(plan(source).is_ok(), "{source}: {:?}", plan(source));
  }
}

#[test]
fn compound_reader_reports_incomplete_named_constructs() {
  for (source, wanted) in [
    ("if true; then :", "fi"),
    ("for x in a; do :", "done"),
    ("while true; do :", "done"),
    ("case x in x) : ;;", "esac"),
    ("{ :;", "}"),
  ] {
    assert!(
      matches!(plan(source), Err(PosixReadError::IncompleteCompound(ref name)) if name == wanted)
    );
  }
}

#[test]
fn compound_reader_refuses_deferred_constructs_by_name() {
  for (source, name) in [
    ("coproc echo x", "coproc"),
  ] {
    let error = plan(source).unwrap_err().to_string();
    assert!(error.contains(name), "{source}: {error}");
  }
  let mut interner = StringInterner::<StringBackend>::new();
  let declaration = read_statement::<SymbolU32, _>("declare -A a", &mut interner).unwrap();
  assert_eq!(
    sexpr_to_json(&declaration, &interner),
    serde_json::json!({"list": [{"sym": "std.sh.cmd"}, {"str": "declare"}, {"str": "-A"}, {"str": "a"}]})
  );
}

#[test]
fn compound_reader_preserves_plain_shapes_and_continuations() {
  for source in [
    "echo hi",
    "echo if",
    "echo '--help'",
    "echo 'if; then'",
    "echo $x",
    "x=value",
  ] {
    let mut interner = StringInterner::<StringBackend>::new();
    let simple = read_simple_statement::<SymbolU32, _>(source, &mut interner, None).unwrap();
    assert_eq!(
      read_statement::<SymbolU32, _>(source, &mut interner).unwrap(),
      simple
    );
  }
  assert!(plan("i\\\nf true; then echo yes; fi").is_ok());
  assert!(plan("if true; then { echo yes; } >|out; fi").is_ok());
  assert!(plan("if true; then x=(a b); fi").is_ok());
}

#[test]
fn compound_reader_rejects_missing_bodies_and_accepts_shell_function_names() {
  for source in [
    "if true; then fi",
    "if then :; fi",
    "while true; do done",
    "{ }",
  ] {
    assert!(plan(source).is_err(), "{source}");
  }
  assert!(plan("f-with-dash() { :; }; f-with-dash").is_ok());
}

#[test]
fn compound_reader_reserves_array_assignments_only_in_command_position() {
  assert!(plan("echo a[0]=value").is_ok());
  assert!(plan("if true; then a[0]=value; fi").is_ok());
}

#[test]
fn compound_reader_accepts_attached_closing_word_redirections() {
  for source in [
    "while false; do :; done<input",
    "for x in a; do echo $x; done>>out",
    "if true; then :; fi>out",
    "{ echo yes; }>out",
    "case a in a) :;; esac>out",
  ] {
    assert!(plan(source).is_ok(), "{source}: {:?}", plan(source));
  }
}

#[test]
fn compound_reader_accepts_both_stream_redirections_after_closing_words() {
  for source in [
    "{ printf a; printf b >&2; } &>out; cat out",
    "{ :; }&>>out",
    "if true; then :; fi&>out",
    "while false; do :; done &>>out",
    "case a in a) :;; esac&>out",
  ] {
    assert!(plan(source).is_ok(), "{source}: {:?}", plan(source));
  }
}

/// Q8/Q9 (2026-10-06): every list member that starts on a later physical
/// line than its enclosing command carries `(std.sh.line DELTA …)`, so
/// `$LINENO`, diagnostics and the ERR trap name the failing simple command's
/// line. Deltas are relative to the enclosing marked member; a one-line
/// chunk keeps its unmarked shape.
#[test]
fn compound_reader_marks_members_on_later_lines() {
  fn lines(source: &str) -> Vec<i64> {
    let mut interner = StringInterner::<StringBackend>::new();
    let expr = read_statement::<SymbolU32, _>(source, &mut interner).unwrap();
    let mut found = Vec::new();
    fn walk(expr: &SExpression<SymbolU32>, interner: &StringInterner<StringBackend>, base: i64, found: &mut Vec<i64>) {
      let SExpression::List(items) = expr else { return };
      let marked = match items.as_slice() {
        [SExpression::Literal(Literal::Symbol(head)), SExpression::Literal(Literal::Integer(delta)), _]
          if interner.resolve(*head) == Some("std.sh.line") => Some(base + delta),
        _ => None,
      };
      if let Some(line) = marked { found.push(line); }
      for item in items { walk(item, interner, marked.unwrap_or(base), found); }
    }
    walk(&expr, &interner, 0, &mut found);
    found
  }
  assert_eq!(lines("if true; then echo a; fi"), Vec::<i64>::new());
  assert_eq!(lines("if true; then\n  echo a\n  false\nfi"), vec![1, 2]);
  assert_eq!(lines("f() {\n  echo a\n  if x; then\n    y\n  fi\n}"), vec![1, 2, 3]);
  // A continuation joins two physical lines; a heredoc body is lifted out.
  assert_eq!(lines("{\n  echo a \\\n    b\n  c\n}"), vec![1, 3]);
  assert_eq!(lines("{\n  cat <<EOF\nx\ny\nEOF\n  d\n}"), vec![1, 5]);
  assert_eq!(lines("{\n  cat <<-EOF\n\tx\n\tEOF\n  d\n  e\n}"), vec![1, 4, 5]);
  // Background jobs keep `&` innermost, so the job is still a plain stage.
  let mut interner = StringInterner::<StringBackend>::new();
  let expr = read_statement::<SymbolU32, _>("{\n  sleep 1 &\n}", &mut interner).unwrap();
  let json = sexpr_to_json(&expr, &interner).to_string();
  let marker = json.find("std.sh.line").unwrap();
  assert!(json[marker..].find("std.jobs.spawn").is_some(), "{json}");
}

/// A flow operator at the end of a multi-line list asks for more input
/// (`-c`/stdin pipelines split after `|`, `&&`, `||`, `!`), as the flow
/// reader did before multi-line lists took the compound parser.
#[test]
fn compound_reader_operator_at_end_of_input_is_incomplete() {
  for (source, operator) in [
    ("cat notes.txt |\n  sort |", "|"),
    ("true\nfalse &&", "&&"),
    ("true\nfalse ||", "||"),
    ("true\n!", "!"),
  ] {
    assert_eq!(plan(source).unwrap_err(), PosixReadError::MissingFlowOperand(operator), "{source}");
  }
  for source in ["cat notes.txt |\n  sort |\n  head -2", "true &&\n  echo and", "false ||\n  echo or", "echo a \\\n  b\necho c"] {
    assert!(plan(source).is_ok(), "{source}: {:?}", plan(source));
  }
}

/// A token where none belongs is bash's `syntax error near unexpected token`,
/// naming that token; an operator at the end of the input stays a missing
/// operand, which a line reader takes as "read the next line".
#[test]
fn an_unexpected_token_is_named_and_a_trailing_operator_continues() {
  for (source, token) in [
    ("echo a\n|echo b\n", "|"),
    ("cat <<EOF \\\n1\nEOF\n| tac\n", "|"),
    ("command [ --version\ncommand [ -z '' -a '(' ! -z) x ')' ] && echo true\n", ")"),
    ("cat <<EOF\na\nEOF\n\n)", ")"),
  ] {
    let error = plan(source).unwrap_err();
    assert_eq!(error, PosixReadError::UnexpectedToken(token.into()), "{source:?}");
    assert_eq!(
      error.to_string(),
      format!("syntax error near unexpected token `{token}'"),
      "{source:?}"
    );
  }
  assert_eq!(
    PosixReadError::UnexpectedToken(String::new()).to_string(),
    "syntax error: unexpected end of file"
  );
  assert_eq!(
    PosixReadError::UnexpectedToken("\n".into()).to_string(),
    "syntax error near unexpected token `newline'"
  );
  for (source, op) in [("echo a |", "|"), ("true &&", "&&"), ("false ||", "||")] {
    assert_eq!(plan(source).unwrap_err(), PosixReadError::MissingFlowOperand(op), "{source:?}");
  }
}
