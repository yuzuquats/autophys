use core::mem;
use std::fmt::{Display, Formatter};

#[derive(Debug)]
pub enum TokenizeError {
  /// Quote was never closed.
  MissingClosingQuote,
  /// `$(...)` had no matching `)`.
  UnbalancedInterp,
  /// Interpolation callback returned an error.
  InterpFailed(String),
}

impl Display for TokenizeError {
  fn fmt(&self, f: &mut Formatter) -> std::fmt::Result {
    match self {
      TokenizeError::MissingClosingQuote => f.write_str("missing closing quote"),
      TokenizeError::UnbalancedInterp => f.write_str("unbalanced `$(...)` interpolation"),
      TokenizeError::InterpFailed(s) => write!(f, "interpolation failed: {}", s),
    }
  }
}

impl std::error::Error for TokenizeError {}

enum State {
  /// Within a delimiter.
  Delimiter,
  /// After backslash, but before starting word.
  Backslash,
  /// Within an unquoted word.
  Unquoted,
  /// After backslash in an unquoted word.
  UnquotedBackslash,
  /// Within a single quoted word.
  SingleQuoted,
  /// Within a double quoted word.
  DoubleQuoted,
  /// After backslash inside a double quoted word.
  DoubleQuotedBackslash,
}

pub trait IntoArgs {
  fn try_into_args(&self) -> Result<Vec<String>, TokenizeError>;
  fn try_into_args_with_interp<F>(&self, interp: F) -> Result<Vec<String>, TokenizeError>
  where
    F: FnMut(&str) -> Result<String, anyhow::Error>;
}

impl<S: std::ops::Deref<Target = str>> IntoArgs for S {
  fn try_into_args(&self) -> Result<Vec<String>, TokenizeError> {
    self.try_into_args_with_interp(|_| {
      Err(anyhow::anyhow!(
        "interpolation `$(...)` not supported in this context"
      ))
    })
  }

  fn try_into_args_with_interp<F>(&self, mut interp: F) -> Result<Vec<String>, TokenizeError>
  where
    F: FnMut(&str) -> Result<String, anyhow::Error>,
  {
    use State::*;

    let bytes = self.as_bytes();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut state = Delimiter;
    let mut i = 0usize;

    while i <= bytes.len() {
      let c = if i < bytes.len() {
        Some(bytes[i] as char)
      } else {
        None
      };

      // `$(...)` is recognized only outside single-quoted regions and
      // outside backslash-escape states.
      if matches!(state, Unquoted | DoubleQuoted | Delimiter)
        && c == Some('$')
        && i + 1 < bytes.len()
        && bytes[i + 1] == b'('
      {
        let start = i + 2;
        let end = scan_balanced(bytes, start)?;
        let body = std::str::from_utf8(&bytes[start..end])
          .map_err(|_| TokenizeError::InterpFailed("non-utf8 in `$(...)`".to_string()))?;
        let replacement = interp(body).map_err(|e| TokenizeError::InterpFailed(e.to_string()))?;
        match state {
          Delimiter => {
            word.push_str(&replacement);
            state = Unquoted;
          }
          Unquoted | DoubleQuoted => {
            word.push_str(&replacement);
          }
          _ => unreachable!(),
        }
        i = end + 1;
        continue;
      }

      state = match state {
        Delimiter => match c {
          None => break,
          Some('\'') => SingleQuoted,
          Some('\"') => DoubleQuoted,
          Some('\\') => Backslash,
          Some('\t') | Some(' ') | Some('\n') => Delimiter,
          Some(c) => {
            word.push(c);
            Unquoted
          }
        },
        Backslash => match c {
          None => {
            word.push('\\');
            words.push(mem::take(&mut word));
            break;
          }
          Some('\n') => Delimiter,
          Some(c) => {
            word.push(c);
            Unquoted
          }
        },
        Unquoted => match c {
          None => {
            words.push(mem::take(&mut word));
            break;
          }
          Some('\'') => SingleQuoted,
          Some('\"') => DoubleQuoted,
          Some('\\') => UnquotedBackslash,
          Some('\t') | Some(' ') | Some('\n') => {
            words.push(mem::take(&mut word));
            Delimiter
          }
          Some(c) => {
            word.push(c);
            Unquoted
          }
        },
        UnquotedBackslash => match c {
          None => {
            word.push('\\');
            words.push(mem::take(&mut word));
            break;
          }
          Some('\n') => Unquoted,
          Some(c) => {
            word.push(c);
            Unquoted
          }
        },
        SingleQuoted => match c {
          None => return Err(TokenizeError::MissingClosingQuote),
          Some('\'') => Unquoted,
          Some(c) => {
            word.push(c);
            SingleQuoted
          }
        },
        DoubleQuoted => match c {
          None => return Err(TokenizeError::MissingClosingQuote),
          Some('\"') => Unquoted,
          Some('\\') => DoubleQuotedBackslash,
          Some(c) => {
            word.push(c);
            DoubleQuoted
          }
        },
        DoubleQuotedBackslash => match c {
          None => return Err(TokenizeError::MissingClosingQuote),
          Some('\n') => DoubleQuoted,
          Some(c @ '$') | Some(c @ '`') | Some(c @ '"') | Some(c @ '\\') => {
            word.push(c);
            DoubleQuoted
          }
          Some(c) => {
            word.push('\\');
            word.push(c);
            DoubleQuoted
          }
        },
      };
      i += 1;
    }

    Ok(words)
  }
}

/// Scan from `bytes[start..]` until the matching `)` for a `$(` opener,
/// respecting `"..."` and `'...'` so embedded parens don't break the
/// depth counter. Returns the index of the closing `)`.
fn scan_balanced(bytes: &[u8], start: usize) -> Result<usize, TokenizeError> {
  let mut depth: i32 = 1;
  let mut i = start;
  let mut in_dquote = false;
  let mut in_squote = false;
  let mut escape = false;
  while i < bytes.len() {
    let c = bytes[i] as char;
    if escape {
      escape = false;
      i += 1;
      continue;
    }
    if in_dquote {
      match c {
        '\\' => escape = true,
        '"' => in_dquote = false,
        _ => {}
      }
      i += 1;
      continue;
    }
    if in_squote {
      if c == '\'' {
        in_squote = false;
      }
      i += 1;
      continue;
    }
    match c {
      '"' => in_dquote = true,
      '\'' => in_squote = true,
      '(' => depth += 1,
      ')' => {
        depth -= 1;
        if depth == 0 {
          return Ok(i);
        }
      }
      _ => {}
    }
    i += 1;
  }
  Err(TokenizeError::UnbalancedInterp)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn plain_tokenize_unchanged() {
    assert_eq!(
      "echo hello world".try_into_args().unwrap(),
      vec!["echo", "hello", "world"]
    );
    assert_eq!(
      r#"cmd --label "row 1""#.try_into_args().unwrap(),
      vec!["cmd", "--label", "row 1"]
    );
  }

  #[test]
  fn interp_unquoted() {
    let out = "cmd --id $(prev.id) --x 1"
      .try_into_args_with_interp(|body| Ok(format!("[{}]", body)))
      .unwrap();
    assert_eq!(out, vec!["cmd", "--id", "[prev.id]", "--x", "1"]);
  }

  #[test]
  fn interp_inside_double_quotes() {
    let out = r#"cmd --label "row $(idx)""#
      .try_into_args_with_interp(|body| {
        assert_eq!(body, "idx");
        Ok("7".to_string())
      })
      .unwrap();
    assert_eq!(out, vec!["cmd", "--label", "row 7"]);
  }

  #[test]
  fn interp_balanced_nested_parens() {
    let captured = std::cell::RefCell::new(None);
    let out = "cmd --x $(foo (bar baz))"
      .try_into_args_with_interp(|body| {
        *captured.borrow_mut() = Some(body.to_string());
        Ok("ok".to_string())
      })
      .unwrap();
    assert_eq!(captured.borrow().as_deref(), Some("foo (bar baz)"));
    assert_eq!(out, vec!["cmd", "--x", "ok"]);
  }

  #[test]
  fn interp_paren_inside_lisp_string_is_ignored() {
    let captured = std::cell::RefCell::new(None);
    let out = r#"cmd --x $(concat ")" "x")"#
      .try_into_args_with_interp(|body| {
        *captured.borrow_mut() = Some(body.to_string());
        Ok("done".to_string())
      })
      .unwrap();
    assert_eq!(captured.borrow().as_deref(), Some(r#"concat ")" "x""#));
    assert_eq!(out, vec!["cmd", "--x", "done"]);
  }

  #[test]
  fn interp_unbalanced_errors() {
    let r = "cmd $(no closing".try_into_args_with_interp(|_| Ok("".to_string()));
    assert!(matches!(r, Err(TokenizeError::UnbalancedInterp)));
  }

  #[test]
  fn interp_callback_error_propagates() {
    let r = "cmd $(boom)".try_into_args_with_interp(|_| Err(anyhow::anyhow!("eval failed")));
    match r {
      Err(TokenizeError::InterpFailed(s)) => assert!(s.contains("eval failed")),
      other => panic!("unexpected: {:?}", other),
    }
  }

  #[test]
  fn interp_in_single_quotes_is_literal() {
    // `$(...)` inside single quotes should NOT be interpolated.
    let out = "cmd --x '$(literal)'"
      .try_into_args_with_interp(|_| panic!("should not be called"))
      .unwrap();
    assert_eq!(out, vec!["cmd", "--x", "$(literal)"]);
  }
}
