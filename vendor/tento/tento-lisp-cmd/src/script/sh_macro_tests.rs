//! `(sh! …)` and strict lisp sources (operator Refinements 6, 7, 9, 10, 11).
use super::*;

#[test]
fn single_form_body_is_the_whole_statement_only() {
  assert_eq!(single_form_body("(sh! ls -la)"), Some("ls -la"));
  assert_eq!(single_form_body("  (sh! echo \"a)b\" | wc -c)  ;; count"), Some("echo \"a)b\" | wc -c"));
  assert_eq!(single_form_body("(sh! if true; then\n  echo hi\nfi)"), Some("if true; then\n  echo hi\nfi"));
  assert_eq!(single_form_body("(sh! a) (sh! b)"), None);
  assert_eq!(single_form_body("(let x (sh! a))"), None);
  assert_eq!(single_form_body("(sh!x)"), None);
}

#[test]
fn strict_refusals_name_bash_prefix_and_hash_lines() {
  let source = "#!/usr/bin/env tsh\n;; ok\n(let x 1)\n\"loaded\"\nls -la\n> (let y 2)\n# note\n(cd /tmp && ls)\n(sh! ls | wc -l)\n";
  let found: Vec<(usize, StrictRefusal)> = strict_refusals(source).into_iter().map(|(line, refusal, _)| (line, refusal)).collect();
  assert_eq!(found, vec![
    (5, StrictRefusal::Bash),
    (6, StrictRefusal::LegacyPrompt),
    (7, StrictRefusal::HashComment),
    (8, StrictRefusal::Bash),
  ]);
  let path = std::path::Path::new("/x/a.tsh");
  assert_eq!(
    strict_refusal_message(StrictRefusal::Bash, "ls -la", Some(path), 5),
    "/x/a.tsh:5: `ls -la` looks like bash; wrap it: (sh! …) — (sh! ls -la) in a lisp file (.tsh, rc, tsh run)"
  );
  assert_eq!(
    strict_refusal_message(StrictRefusal::LegacyPrompt, "> (let y 2)", Some(path), 6),
    "/x/a.tsh:6: a leading `>` is not lisp (the legacy `> (form)` prefix is gone): write `(let y 2)`"
  );
  assert_eq!(
    strict_refusal_message(StrictRefusal::HashComment, "# note", Some(path), 7),
    "/x/a.tsh:7: comments in lisp files are `;;`: write `;; note`"
  );
  // A `#!` is a comment only on line 1.
  assert_eq!(strict_refusal("#!/bin/sh", 2), Some(StrictRefusal::HashComment));
  assert_eq!(strict_refusal("#!/usr/bin/env tsh", 1), None);
}

#[test]
fn seed_blanking_keeps_line_numbers() {
  let (source, refused) = blank_refusals("(let a 1)\nls\n(let b 2)\n");
  assert_eq!(source, "(let a 1)\n\n(let b 2)");
  assert_eq!(refused.len(), 1);
  assert_eq!(refused[0].0, 2);
}

fn expand(host: &mut LispHost, body: &str) -> Result<String, String> {
  host.expand_sh_macro(body).map_err(|error| error.to_string())
}

fn host_with(bindings: &str) -> LispHost {
  let mut host = LispHost::new();
  host.eval_stmt(bindings).expect("bindings");
  host
}

#[test]
fn holes_are_one_quoted_word_each() {
  let mut host = host_with(r#"(let msg "it's a b") (let n 3) (let files ["a b" "c"]) (let empty [])"#);
  assert_eq!(expand(&mut host, "echo {msg}").unwrap(), r#"echo 'it'\''s a b'"#);
  assert_eq!(expand(&mut host, "head -n {n} x").unwrap(), "head -n '3' x");
  assert_eq!(expand(&mut host, "ls {files...} -d").unwrap(), "ls 'a b' 'c' -d");
  assert_eq!(expand(&mut host, "ls {empty...}").unwrap(), "ls ");
  // Inside double quotes the value is escaped for them, still one word.
  assert_eq!(expand(&mut host, r#"echo "say: {msg} $HOME""#).unwrap(), r#"echo "say: it's a b $HOME""#);
  // Joined into a larger word, still that one word.
  assert_eq!(expand(&mut host, "cmd --file={msg}").unwrap(), r#"cmd --file='it'\''s a b'"#);
}

#[test]
fn bash_braces_stay_bash() {
  let mut host = host_with("(let x 1)");
  for body in [
    "echo ${x} ${HOME:-${USER}}",
    "echo {a,b} {1..3} {a..c}",
    "{ echo hi; }",
    r"find . -exec echo {} \;",
    "echo '{x}'",
    "echo $'{x}'",
    "echo \\{x}",
  ] {
    assert_eq!(expand(&mut host, body).unwrap(), body, "{body}");
  }
}

#[test]
fn double_braces_are_literal() {
  let mut host = host_with("(let x 1)");
  assert_eq!(expand(&mut host, "git rev-parse @{{upstream}}").unwrap(), "git rev-parse @{upstream}");
  assert_eq!(expand(&mut host, "echo {{x}} {x}").unwrap(), "echo {x} '1'");
}

#[test]
fn an_unbound_hole_is_loud_and_points_at_double_braces() {
  let mut host = host_with("(let x 1)");
  let error = expand(&mut host, "git log @{upstream}").unwrap_err();
  assert!(error.contains("`upstream` is not a bound lisp name"), "{error}");
  assert!(error.contains("@{{upstream}}"), "{error}");
  let error = expand(&mut host, "echo {x...}").unwrap_err();
  assert!(error.contains("needs a list"), "{error}");
  let mut host = host_with("(let xs [1 2])");
  let error = expand(&mut host, "echo {xs}").unwrap_err();
  assert!(error.contains("{xs...}"), "{error}");
  let error = expand(&mut host, "echo \"{xs...}\"").unwrap_err();
  assert!(error.contains("whole unquoted word"), "{error}");
}
