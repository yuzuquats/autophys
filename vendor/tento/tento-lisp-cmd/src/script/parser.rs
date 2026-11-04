/// Classification of a single script line. Borrowed from the source so
/// the runner can attach line numbers / echo lines without copying.
#[derive(Debug, PartialEq, Eq)]
pub enum LineKind<'a> {
  Blank,
  Comment,
  /// A lisp form — the line opens with `(` (or the legacy `>` prefix).
  /// `def` / `if` / `cond` / command calls all flow through here to one
  /// evaluator; there is no longer a special `(when …)` guard or `> (let …)`
  /// form — they are just ordinary lisp.
  LispStmt(&'a str),
  /// A posix line: a command (`ls -la /tmp`) or a `name=$(…)` capture. Read by
  /// the unified posix reader into the same s-expression a lisp line produces.
  Plain(&'a str),
  /// A `>`-prefixed lisp statement with a single `;` after code: the prefix
  /// rules out bash, and a single `;` is not lisp (I10), so it is refused.
  Refused { form: &'a str, rest: &'a str },
}

/// The line mode-selector. A line is blank, a comment (`#`, `;;`, a whole
/// `(; … ;)` block, or the deprecated single `;`), a lisp form (opens with
/// `(`, or the legacy `>` prefix), or otherwise a posix line read by the
/// unified reader. The language of a line is decided from its text alone,
/// before it runs: a `(` line is lisp unless it is plainly bash, and a single
/// `;` after code is plainly bash, like `&&` or `|` (I10). Several forms on a
/// line stay lisp, and nothing on a line is dropped.
pub fn classify(raw: &str) -> LineKind<'_> {
  classify_in(raw, false)
}

/// File dispatch can declare an all-Bash source without changing the prompt.
pub fn bash_source(path: Option<&std::path::Path>, source: &str) -> bool {
  if path.and_then(std::path::Path::extension).and_then(|s| s.to_str())
    .is_some_and(|ext| matches!(ext, "sh" | "bash")) { return true; }
  let Some(shebang) = source.lines().next().and_then(|s| s.strip_prefix("#!")) else { return false; };
  let mut words = shebang.split_whitespace();
  let basename = |word: &str| std::path::Path::new(word).file_name().and_then(|s| s.to_str()).map(str::to_string);
  match words.next().and_then(basename).as_deref() {
    Some("bash" | "sh") => true,
    Some("env") => {
      while let Some(word) = words.next() {
        if matches!(word, "-u" | "--unset") { words.next(); continue; }
        if word.starts_with('-') || word.contains('=') { continue; }
        return matches!(basename(word).as_deref(), Some("bash" | "sh"));
      }
      false
    }
    _ => false,
  }
}

pub fn classify_in(raw: &str, bash: bool) -> LineKind<'_> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return LineKind::Blank;
  }
  // Both comment conventions: `#` (shell-style) and `;;` (the Lisp `.tsh`
  // form, after WAT). A leading single `;` is the deprecated spelling.
  if trimmed.starts_with('#') || !bash && trimmed.starts_with(';') {
    return LineKind::Comment;
  }
  if !bash && trimmed.starts_with("(;") && tento_lisp::lisp_comment_only(trimmed) {
    return LineKind::Comment;
  }
  // Preserve the legacy `> (form)` prefix; `>file` is a Bash redirection.
  if let Some(rest) = trimmed.strip_prefix('>').filter(|_| !bash) {
    let body = rest.trim_start();
    if rest.starts_with(char::is_whitespace) && body.starts_with('(') {
      return classify_lisp(body);
    }
  }
  // A parenthesised statement is Lisp unless the shared scanner finds Bash.
  if !bash && trimmed.starts_with('(') && !tento_lisp::bash_paren_statement(trimmed) {
    return LineKind::LispStmt(trimmed);
  }
  LineKind::Plain(raw.trim_start())
}

fn classify_lisp(body: &str) -> LineKind<'_> {
  match first_form_trailer(body) {
    Some((form, rest)) => LineKind::Refused { form, rest },
    None => LineKind::LispStmt(body),
  }
}

/// Split lisp `body` at its first single `;` after code, the text a lisp
/// reader refuses (I10): the code before it, and the rest from the `;`.
/// `None` when every `;` is inside a string or a `;;` / `(; … ;)` comment.
pub fn first_form_trailer(body: &str) -> Option<(&str, &str)> {
  let body = body.trim_start();
  let at = tento_lisp::lisp_single_semicolon(body)?;
  Some((body[..at].trim_end(), body[at..].trim_end()))
}

pub fn lisp_trailer_message(form: &str, rest: &str) -> String {
  format!("a single `;` is not lisp: `{form}` is followed by `{rest}`; write `;;` for a comment")
}

#[cfg(test)]
mod tests {
  use super::*;

  /// A2 correction: a single `;` after code makes a `(` line plainly bash,
  /// like `&&`; several forms and `;;` comments on one line stay lisp.
  #[test]
  fn single_semicolon_after_code_is_bash_and_several_forms_stay_lisp() {
    for source in [
      "(true); rm -f marker; echo AFTER",
      "(true); echo AFTER",
      "( true ); echo AFTER",
      "(let x ; ) ignored\n 1); echo AFTER",
      "(let x 1) ; comment",
    ] {
      assert_eq!(classify(source), LineKind::Plain(source), "{source}");
    }
    for source in [
      "(let x 1) (echo x)",
      "(let x 1) ;; comment",
      "(echo \"a;)\") (echo b)",
      "(let x ;; comment\n 1)",
      "(let x\n  ; deprecated comment\n 1)",
      "(let x (; inline block ;) 1)",
      "(true)  ",
    ] {
      assert_eq!(classify(source), LineKind::LispStmt(source.trim()), "{source}");
    }
    for source in ["(; a whole-line block ;)", "  (; nested (; block ;) ;)  ", ";; doubled"] {
      assert_eq!(classify(source), LineKind::Comment, "{source}");
    }
    assert_eq!(classify("(; block ;) (let x 1)"), LineKind::LispStmt("(; block ;) (let x 1)"));
    // The legacy `>` prefix rules out bash, so the single `;` is refused.
    assert_eq!(
      classify("> (let x 1); echo AFTER"),
      LineKind::Refused { form: "(let x 1)", rest: "; echo AFTER" }
    );
    assert_eq!(classify("> (let x 1) (echo x)"), LineKind::LispStmt("(let x 1) (echo x)"));
  }

  #[test]
  fn paren_classifier_boundary_table() {
    for source in ["(ls)", "(cd src)", "(let x 1)", "((lambda () 1))", r#"(echo "a|b; >")"#, r#"(let x (str ";" "&&"))"#, "(echo \\|)"] {
      assert_eq!(classify(source), LineKind::LispStmt(source), "{source}");
    }
    for source in ["(ls | head)", "(cd src && make)", "(false || true)", "(echo a; echo b)", "(echo a &)", "(echo a >out)", "(echo a 2>&1)", "((1))", "((x+=2))", "((0 && (x=2)))"] {
      assert_eq!(classify(source), LineKind::Plain(source), "{source}");
    }
    assert_eq!(classify("(let x ;; comment\n 1)"), LineKind::LispStmt("(let x ;; comment\n 1)"));
    assert_eq!(classify("> (let x ;; comment\n 1)"), LineKind::LispStmt("(let x ;; comment\n 1)"));
    assert_eq!(classify("(let x ; comment\n 1)"), LineKind::Plain("(let x ; comment\n 1)"));
  }

  #[test]
  fn paren_lisp_heads_comments_and_nested_strings() {
    for source in [
      "(> a b)", "(< a b)", "(>= a b)", "(<= a b)",
      "(if (> (get prev \"count\") 0) (delete))",
      "(let f (lambda (x y) (cond ((< x y) true) (true false))))",
      "(let x ;; comment with > < && | and )\n 1)",
      "(let x ;; incomplete comment",
      "(let x (; block with > < && | and ) ;)\n 1)",
      "(list '(a b) (> 2 1))",
      r#"(let x (str "a; > |" "b < &&"))"#,
    ] {
      assert_eq!(classify(source), LineKind::LispStmt(source), "{source}");
    }
    for source in ["(cd x; make)", "(echo a >out; cat out)", "(echo a | cat)", "(echo x) 2>&1 | cat", "(echo 'x) y'; echo ok)"] {
      assert_eq!(classify(source), LineKind::Plain(source), "{source}");
    }
  }

  #[test]
  fn paren_explicit_bash_source_hook() {
    assert_eq!(classify_in("(ls)", true), LineKind::Plain("(ls)"));
    assert!(bash_source(Some(std::path::Path::new("x.sh")), "(ls)"));
    assert!(bash_source(None, "#!/usr/bin/env bash\n(ls)"));
    assert!(!bash_source(None, "#!/usr/bin/tsh\n(ls)"));
    assert!(!bash_source(None, "#!/usr/bin/python sh\n(ls)"));
    assert!(!bash_source(None, "#!/usr/bin/env tsh bash\n(ls)"));
    assert!(bash_source(None, "#!/usr/bin/env -S bash -e\n(ls)"));
  }

  #[test]
  fn blank_and_comment() {
    assert_eq!(classify(""), LineKind::Blank);
    assert_eq!(classify("   "), LineKind::Blank);
    assert_eq!(classify("# hello"), LineKind::Comment);
    assert_eq!(classify("   # hello"), LineKind::Comment);
    assert_eq!(classify("; acme tsh profile"), LineKind::Comment);
    assert_eq!(classify("  ;; doubled"), LineKind::Comment);
  }

  #[test]
  fn bash_classifier_preserves_escaped_trailing_whitespace() {
    for source in ["printf \\ ", "echo tail\\\t", "printf 'tail '", "echo tail\\ \\ "] {
      assert_eq!(classify(source), LineKind::Plain(source), "{source:?}");
      assert_eq!(classify_in(source, true), LineKind::Plain(source), "{source:?}");
    }
  }

  #[test]
  fn posix_line_is_plain() {
    assert_eq!(classify("ls -la /tmp"), LineKind::Plain("ls -la /tmp"));
    assert_eq!(
      classify("files=$(ls /tmp)"),
      LineKind::Plain("files=$(ls /tmp)")
    );
  }

  #[test]
  fn lisp_form_opens_with_paren() {
    assert_eq!(
      classify("(let name (concat \"a\" \"b\"))"),
      LineKind::LispStmt("(let name (concat \"a\" \"b\"))")
    );
    assert_eq!(
      classify("(if (deployed?) (echo \"go\"))"),
      LineKind::LispStmt("(if (deployed?) (echo \"go\"))")
    );
    // The legacy `>` prefix still routes to a lisp form.
    assert_eq!(
      classify("> (println \"hi\")"),
      LineKind::LispStmt("(println \"hi\")")
    );
  }

  #[test]
  fn leading_redirections_are_plain_and_legacy_lisp_prefix_survives() {
    for source in [">out echo hi", "> out echo hi", ">>out echo hi", ">", ">(cmd)"] {
      assert_eq!(classify(source), LineKind::Plain(source));
    }
    assert_eq!(classify("> (echo \"hi\")"), LineKind::LispStmt("(echo \"hi\")"));
  }
}
