//! Raw-tokenizing macros (operator Refinement 7, 2026-10-05).
//!
//! A `name!` head is reserved for macros, Rust-style. A *raw* macro owns
//! the text of its form up to the closing `)`: the lisp reader does not
//! tokenize it. `(sh! …)` is the one raw macro today; its body is bash, so
//! its closing `)` is found by the bash front end exactly as the end of a
//! `$(…)` substitution is (quotes, nested parens, `case` patterns,
//! here-documents and comments all follow bash).

use super::{PosixReadError, scan_balanced};

/// Heads whose forms are read raw, up to their bash-balanced `)`.
pub const RAW_MACROS: &[&str] = &["sh!"];

/// When `chars[open]` is a `(` opening a raw macro form (`(sh! …`, the head
/// written right after the paren, as the lisp lexer reads it), the char
/// index just past the head.
pub(crate) fn raw_macro_head_at(chars: &[char], open: usize) -> Option<usize> {
  if chars.get(open) != Some(&'(') {
    return None;
  }
  let i = open + 1;
  RAW_MACROS.iter().find_map(|name| {
    let end = i + name.chars().count();
    let matches = chars.len() >= end && chars[i..end].iter().copied().eq(name.chars());
    let bounded = chars.get(end).is_none_or(|c| c.is_whitespace() || *c == ')');
    (matches && bounded).then_some(end)
  })
}

/// When `source` starts with a raw macro form, the byte offset just past
/// its head (`(sh!`).
pub fn raw_macro_head(source: &str) -> Option<usize> {
  let chars: Vec<char> = source.chars().take(64).collect();
  let end = raw_macro_head_at(&chars, 0)?;
  Some(chars[..end].iter().map(|c| c.len_utf8()).sum())
}

/// Byte offset, within `body`, of the `)` that closes a raw macro whose
/// body starts at the beginning of `body` (bash rules, as for `$(…)`).
pub fn raw_macro_close(body: &str) -> Result<usize, PosixReadError> {
  let chars: Vec<char> = body.chars().collect();
  let end = scan_balanced(&chars, 0)?;
  Ok(chars[..end].iter().map(|c| c.len_utf8()).sum())
}

/// `source` with the body of every raw macro form blanked to spaces
/// (newlines kept, char count kept), so a lisp-level scanner (paren
/// balance, the bash-line test) sees `(sh!   …   )` and never reads the
/// bash inside. An unterminated body is blanked to the end, which leaves
/// its `(` open. Lisp strings and comments outside a macro are honored, so
/// a `"(sh! x)"` string is not a form.
pub fn mask_raw_macros(source: &str) -> std::borrow::Cow<'_, str> {
  if !RAW_MACROS.iter().any(|name| source.contains(name)) {
    return std::borrow::Cow::Borrowed(source);
  }
  let mut chars: Vec<char> = source.chars().collect();
  let mut i = 0;
  let mut string = false;
  while i < chars.len() {
    let c = chars[i];
    if string {
      match c {
        '\\' => i += 1,
        '"' => string = false,
        _ => {}
      }
      i += 1;
      continue;
    }
    match c {
      '"' => string = true,
      ';' => {
        while i < chars.len() && chars[i] != '\n' {
          i += 1;
        }
        continue;
      }
      '(' if chars.get(i + 1) == Some(&';') => {
        i = super::block_comment_end(&chars, i);
        continue;
      }
      '(' => {
        if let Some(body) = raw_macro_head_at(&chars, i) {
          let close = scan_balanced(&chars, body).unwrap_or(chars.len());
          for slot in &mut chars[body..close] {
            if *slot != '\n' {
              *slot = ' ';
            }
          }
          i = close + 1;
          continue;
        }
      }
      _ => {}
    }
    i += 1;
  }
  std::borrow::Cow::Owned(chars.into_iter().collect())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn head_needs_a_boundary() {
    assert_eq!(raw_macro_head("(sh! ls)"), Some(4));
    assert_eq!(raw_macro_head("( sh! ls)"), None);
    assert_eq!(raw_macro_head("(sh!)"), Some(4));
    assert_eq!(raw_macro_head("(sh!x)"), None);
    assert_eq!(raw_macro_head("(shx ls)"), None);
    assert_eq!(raw_macro_head("(set x 1)"), None);
  }

  #[test]
  fn close_follows_bash_quoting_and_nesting() {
    fn close(s: &str) -> Result<&str, PosixReadError> { raw_macro_close(s).map(|at| &s[..at]) }
    assert_eq!(close(r#" echo "a)b" | wc -c) tail"#), Ok(r#" echo "a)b" | wc -c"#));
    assert_eq!(close(" echo 'a)b')"), Ok(" echo 'a)b'"));
    assert_eq!(close(" echo $(date) (x))"), Ok(" echo $(date) (x)"));
    assert_eq!(close(" case x in a) echo;; esac)"), Ok(" case x in a) echo;; esac"));
    assert_eq!(close(" alias ll='ls -la')"), Ok(" alias ll='ls -la'"));
    assert!(raw_macro_close(" echo 'open").is_err());
  }

  #[test]
  fn mask_blanks_bodies_only() {
    assert_eq!(mask_raw_macros("(sh! echo 'a)b' | wc)"), format!("(sh!{})", " ".repeat(" echo 'a)b' | wc".len())));
    assert_eq!(mask_raw_macros("(let x 1)"), "(let x 1)");
    assert_eq!(mask_raw_macros(r#"(f "(sh! a|b)")"#), r#"(f "(sh! a|b)")"#);
    assert_eq!(mask_raw_macros("(sh! echo 'a\nb')"), format!("(sh!{}\n{})", " ".repeat(" echo 'a".len()), " ".repeat("b'".len())));
    // Unterminated: blanked to the end, its paren left open.
    assert_eq!(mask_raw_macros("(sh! echo 'x"), format!("(sh!{}", " ".repeat(" echo 'x".len())));
  }

  fn parse(source: &str) -> Result<Vec<String>, String> {
    let mut interner = string_interner::StringInterner::<string_interner::backend::StringBackend>::new();
    crate::Runtime::<string_interner::symbol::SymbolU32, _>::parse(None, source, &mut interner)
      .map(|forms| forms.iter().map(|form| crate::render_lisp(form, &interner)).collect())
      .map_err(|error| format!("{error:?}"))
  }

  #[test]
  fn the_reader_hands_the_raw_body_to_the_macro() {
    let mut interner = string_interner::StringInterner::<string_interner::backend::StringBackend>::new();
    let forms = crate::Runtime::<string_interner::symbol::SymbolU32, _>::parse(
      None, r#"(sh! echo "a)b" | wc -c)"#, &mut interner).unwrap();
    let crate::SExpression::List(items) = &forms[0] else { panic!("{forms:?}") };
    assert_eq!(items[1], crate::SExpression::Literal(crate::Literal::String(r#"echo "a)b" | wc -c"#.into())));
    // Round trip: the renderer writes the raw text back.
    assert_eq!(parse(r#"(sh! echo "a)b" | wc -c)"#).unwrap(), vec![r#"(sh! echo "a)b" | wc -c)"#]);
    assert_eq!(parse("(sh! alias ll='ls -la')").unwrap(), vec!["(sh! alias ll='ls -la')"]);
    assert_eq!(parse("(let x 1) (sh! ls {x}) (+ 1 2)").unwrap(), vec!["(let x 1)", "(sh! ls {x})", "(+ 1 2)"]);
    assert_eq!(parse("(let s (sh! date))").unwrap(), vec!["(let s (sh! date))"]);
    assert_eq!(parse("(sh! if true; then\n  echo (a)\nfi)").unwrap(), vec!["(sh! if true; then\n  echo (a)\nfi)"]);
    assert_eq!(parse("(sh!)").unwrap(), vec!["(sh!)"]);
    assert_eq!(parse("(set x 1) (sh x) (s) ( + 1 3 )").unwrap(), vec!["(set x 1)", "(sh x)", "(s)", "(+ 1 3)"]);
    assert!(parse("(sh! echo 'open)").unwrap_err().contains("UnterminatedRawMacro") || parse("(sh! echo 'open)").is_err());
    // A string holding the text is just a string.
    assert_eq!(parse(r#"(f "(sh! a)")"#).unwrap(), vec![r#"(f "(sh! a)")"#]);
  }

  #[test]
  fn a_macro_body_never_makes_its_line_bash() {
    assert!(!crate::bash_paren_statement("(sh! echo a | wc -c)"));
    assert!(!crate::bash_paren_statement("(sh! cd /tmp && ls; echo done)"));
    assert!(!crate::bash_paren_statement("(let x (sh! a > b))"));
    assert!(crate::bash_paren_statement("(cd /tmp && ls)"));
    assert_eq!(crate::lisp_single_semicolon("(sh! a; b)"), None);
  }

  #[test]
  fn datum_lines_are_lisp_and_command_lines_are_not() {
    for lisp in [r#""claude transcript components""#, r#""a\.b""#, "42", "-3", "true", "'(a b)", "[1 2]", "{:a 1}", "`x`"] {
      assert!(crate::lisp_datum_line(lisp), "{lisp}");
    }
    for bash in ["ls -la", "show", "x=1", "/bin/sh -c 'exit 5'", "[ -f x ]", "{ echo hi; }", "user.train --user a"] {
      assert!(!crate::lisp_datum_line(bash), "{bash}");
    }
  }
}
