//! Source boundaries for hosts that capture unevaluated top-level policy.

use logos::Logos;
use std::ops::Range;

pub use crate::lexer::{LexingError, RawMacro, TaggedString, TemplatePart, TemplateString, Token};

/// Every token the lisp reader's lexer produces, with its byte span, in
/// order. Whitespace and comments are skipped exactly as the reader skips
/// them, so the text between two spans is whitespace or comment. This is
/// for tooling that must agree with the reader token for token — the
/// `tree-sitter-tsh` conformance test reads source through it.
pub fn lex(source: &str) -> Vec<(Result<Token, LexingError>, Range<usize>)> {
  Token::lexer(source).spanned().collect()
}

/// Lexical ranges of unquoted top-level lists. Strings, templates and
/// comments use the real lexer, so their parentheses cannot end a form.
/// This is not validation: an unfinished list extends to EOF for the caller
/// to diagnose without accidentally executing its contents.
pub fn top_level_lists(source: &str) -> Vec<Range<usize>> {
  let mut ranges = Vec::new();
  let mut depth = 0usize;
  let mut start = None;
  let mut quoted = false;
  for (token, span) in Token::lexer(source).spanned() {
    match token {
      Ok(Token::Quote) if depth == 0 => quoted = true,
      Ok(Token::ParenOpen) => {
        if depth == 0 && !quoted {
          start = Some(span.start);
        }
        depth += 1;
      }
      Ok(Token::BracketOpen | Token::BraceOpen) => {
        depth += 1;
      }
      Ok(Token::BracketClose | Token::BraceClose) => {
        depth = depth.saturating_sub(1);
        if depth == 0 {
          quoted = false;
        }
      }
      Ok(Token::ParenClose) => {
        depth = depth.saturating_sub(1);
        if depth == 0 {
          if let Some(start) = start.take() {
            ranges.push(start..span.end);
          }
          quoted = false;
        }
      }
      _ if depth == 0 => quoted = false,
      _ => {}
    }
  }
  if let Some(start) = start {
    ranges.push(start..source.len());
  }
  ranges
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn top_level_lists_ignore_quoted_forms_and_literal_parentheses() {
    let source =
      ";; (ignored)\n'(quoted) (outer \"a ) b\" (inner)) ;; (line comment)\n[(hidden)] {(map)} (last)";
    let found: Vec<_> = top_level_lists(source)
      .iter()
      .map(|r| &source[r.clone()])
      .collect();
    assert_eq!(found, vec!["(outer \"a ) b\" (inner))", "(last)"]);
  }
  #[test]
  fn unfinished_policy_is_captured_to_eof() {
    let source = "(ok) (unfinished\n (nested)";
    assert_eq!(top_level_lists(source), vec![0..4, 5..source.len()]);
  }
}
