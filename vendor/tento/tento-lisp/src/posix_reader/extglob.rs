//! Extended globbing groups — `?(…)`, `*(…)`, `+(…)`, `@(…)`, `!(…)` — are
//! always read as part of a word (tsh ruling: `extglob` is always on), the
//! way bash's lexer reads them with `shopt -s extglob`: from the operator
//! character through the matching `)`, so the `(`, `|` and `)` inside are
//! pattern characters, not command syntax. Bash 3.2 only reads them when
//! `extglob` was enabled on an earlier line.

/// When `chars[start]` opens an extended glob group, the index just past its
/// closing `)`; `None` otherwise (including an unbalanced group, which the
/// caller reads as before). `$?(`, `$*(`, `$@(` and `$!(` are parameters.
pub(super) fn end(chars: &[char], start: usize) -> Option<usize> {
  if !matches!(chars.get(start), Some('?' | '*' | '+' | '@' | '!')) || chars.get(start + 1) != Some(&'(') {
    return None;
  }
  if start > 0 && chars[start - 1] == '$' {
    return None;
  }
  let mut depth = 0usize;
  let mut i = start + 1;
  while i < chars.len() {
    match chars[i] {
      '\\' => {
        i += 2;
        continue;
      }
      '\'' => {
        i += 1;
        while i < chars.len() && chars[i] != '\'' {
          i += 1;
        }
      }
      '"' => {
        i += 1;
        while i < chars.len() && chars[i] != '"' {
          if chars[i] == '\\' {
            i += 1;
          }
          i += 1;
        }
      }
      '(' => depth += 1,
      ')' => {
        depth -= 1;
        if depth == 0 {
          return Some(i + 1);
        }
      }
      '\n' => return None,
      _ => {}
    }
    i += 1;
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  fn span(text: &str, start: usize) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    end(&chars, start).map(|end| chars[start..end].iter().collect())
  }

  #[test]
  fn extglob_groups_span_their_balanced_parentheses() {
    assert_eq!(span("@(a|b)c", 0).as_deref(), Some("@(a|b)"));
    assert_eq!(span("x*(a|+(b))y", 1).as_deref(), Some("*(a|+(b))"));
    assert_eq!(span("!(a')'|b)", 0).as_deref(), Some("!(a')'|b)"));
    assert_eq!(span("$@(x)", 1), None);
    assert_eq!(span("@(a", 0), None);
    assert_eq!(span("(a)", 0), None);
  }
}

#[cfg(test)]
mod regression_tests {
  use crate::posix_reader::*;
  use string_interner::{StringInterner, backend::StringBackend, symbol::SymbolU32};

  /// Each must return (Ok or Err) instead of spinning.
  fn reads(source: &'static str) {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
      let mut interner = StringInterner::<StringBackend>::new();
      let _ = read_shell_plan_with_functions::<SymbolU32, _>(source, &mut interner, None, &[]);
      let _ = tx.send(());
    });
    assert!(rx.recv_timeout(std::time::Duration::from_secs(5)).is_ok(), "reader did not finish: {source:?}");
  }

  #[test]
  fn malformed_array_and_extglob_inputs_terminate() {
    reads("declare -a A=('' x \"\" ''|)\nargv.py \"${A[@]}\"\n");
    reads("A=(a | b)");
    reads("A=(a & b ; c)");
    reads("declare -a A=(x <y)");
    reads("echo @(a|b");
    reads("echo !(");
    reads("echo +(a|(b)");
    reads("case x in @(a|b) echo; esac");
    reads("A=(@(a|b) *(c)");
    reads("[[ x == @(a ]]");
    reads("declare A=(x |) B=1");
    reads("declare -a A=(&)");
  }
}
