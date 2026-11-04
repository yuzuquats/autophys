//! A call as lisp source text: how one process starts another tsh at one of
//! its process entry points, as one argv word.
//!
//! tsh's internal entry points (the session engine, the session daemon, the
//! `session new` spawner, `serve`) are `tsh.*` lisp natives, not argv verbs
//! (operator ruling Q14, 2026-10-07). A spawner hands the child one operand
//! that opens with `(`, which tsh reads as a lisp program:
//!
//! ```text
//! tsh '(tsh.session.engine :root "/sessions/a b" :opened true)'
//! ```
//!
//! [`call`] is the one place that spelling is built, so every spawn site (in
//! tsh and in the tento programs that start tsh) escapes a path the same way,
//! and it lives beside the reader that reads it back. A string argument becomes a `"…"` literal
//! with the reader's escapes (`\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`);
//! every other character, `$`, `{`, `;` and non-ASCII included, is literal
//! inside a double-quoted lisp string. A keyword argument is `:name VALUE`,
//! so a flag is `:name true`.

use std::fmt::Write as _;

/// One argument of a [`call`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Arg {
  /// A positional string.
  Str(String),
  /// A positional integer.
  Int(i64),
  /// A positional boolean.
  Bool(bool),
  /// `:name VALUE`.
  Key(String, Box<Arg>),
}

impl Arg {
  /// `:name "value"`.
  pub fn key(name: &str, value: impl Into<String>) -> Arg {
    Arg::Key(name.to_string(), Box::new(Arg::Str(value.into())))
  }

  /// `:name true`: a flag.
  pub fn flag(name: &str) -> Arg {
    Arg::Key(name.to_string(), Box::new(Arg::Bool(true)))
  }

  /// `:name N`.
  pub fn key_int(name: &str, value: i64) -> Arg {
    Arg::Key(name.to_string(), Box::new(Arg::Int(value)))
  }
}

/// `(NAME ARG…)`, each argument written so the tento-lisp reader reads back
/// exactly the value given. `name` is a symbol and is written as is.
pub fn call(name: &str, args: &[Arg]) -> String {
  let mut out = String::with_capacity(name.len() + 2 + args.len() * 16);
  out.push('(');
  out.push_str(name);
  for arg in args {
    out.push(' ');
    write_arg(arg, &mut out);
  }
  out.push(')');
  out
}

fn write_arg(arg: &Arg, out: &mut String) {
  match arg {
    Arg::Str(text) => write_string(text, out),
    Arg::Int(n) => {
      let _ = write!(out, "{n}");
    }
    Arg::Bool(true) => out.push_str("true"),
    Arg::Bool(false) => out.push_str("false"),
    Arg::Key(name, value) => {
      out.push(':');
      out.push_str(name);
      out.push(' ');
      write_arg(value, out);
    }
  }
}

/// A `"…"` literal with the reader's escape table.
pub fn write_string(text: &str, out: &mut String) {
  out.push('"');
  for c in text.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\n' => out.push_str("\\n"),
      '\r' => out.push_str("\\r"),
      '\t' => out.push_str("\\t"),
      '\u{0008}' => out.push_str("\\b"),
      '\u{000C}' => out.push_str("\\f"),
      c => out.push(c),
    }
  }
  out.push('"');
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_call_writes_keywords_flags_and_escaped_strings() {
    assert_eq!(
      call(
        "tsh.session.engine",
        &[Arg::key("root", "/s/a \"b\"\\c$HOME\n"), Arg::flag("opened")]
      ),
      r#"(tsh.session.engine :root "/s/a \"b\"\\c$HOME\n" :opened true)"#
    );
    assert_eq!(call("tsh.serve", &[]), "(tsh.serve)");
    assert_eq!(
      call("f", &[Arg::Str("é😀".into()), Arg::Int(-3), Arg::Bool(false), Arg::key_int("n", 7)]),
      "(f \"é😀\" -3 false :n 7)"
    );
  }

  /// What [`call`] writes, the reader reads back as exactly the values
  /// given: quotes, spaces, backslashes, `$`, `${…}`, newlines, control
  /// characters, `;`, parens and unicode included.
  #[test]
  fn the_reader_reads_a_call_back_exactly() {
    use crate::{Literal, Runtime, SExpression};
    use string_interner::{StringInterner, backend::StringBackend, symbol::SymbolU32};
    for text in [
      "/plain",
      "/with space/and \"quotes\"",
      r"C:\back\slash\",
      "/dollar/$HOME/${x}/$(id)/`tick`",
      "/new\nline\r\tand\u{8}\u{c}bell\u{7}\u{1b}",
      "/semi;colon (paren) ;; [brack] {brace} (; block ;)",
      "/unicode/東京/é/😀",
      "",
      ":keyword-looking",
      "\\",
    ] {
      let source = call("f", &[Arg::key("root", text), Arg::flag("opened"), Arg::Int(-3)]);
      let mut interner = StringInterner::<StringBackend>::new();
      let forms = Runtime::<SymbolU32, StringBackend>::parse(None, &source, &mut interner)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"));
      let [SExpression::List(items)] = forms.as_slice() else { panic!("{source}: one list") };
      let symbol = |item: &SExpression<SymbolU32>| match item {
        SExpression::Literal(Literal::Symbol(sym)) => interner.resolve(*sym).map(str::to_string),
        _ => None,
      };
      assert_eq!(symbol(&items[0]).as_deref(), Some("f"));
      assert_eq!(symbol(&items[1]).as_deref(), Some(":root"));
      assert_eq!(items[2], SExpression::Literal(Literal::String(text.to_string())), "{source}");
      assert_eq!(symbol(&items[3]).as_deref(), Some(":opened"));
      assert_eq!(items[4], SExpression::Literal(Literal::Boolean(true)));
      assert_eq!(items[5], SExpression::Literal(Literal::Integer(-3)));
    }
  }
}
