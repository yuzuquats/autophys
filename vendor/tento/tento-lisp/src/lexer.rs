use logos::Logos;
use std::fmt::Display;

use crate::result::Location;

/// What the lexer noticed while skipping comments.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct CommentNotes {
  /// Byte offset of the first single-`;` line comment: the deprecated
  /// spelling of `;;`, still skipped during the transition.
  pub deprecated_line_comment: Option<usize>,
}

#[derive(Logos, Debug, Clone, PartialEq)]
#[logos(skip r"[ \t\n\f]+", error = LexingError, extras = CommentNotes)]
// Comments follow WAT: `;;` to the end of the line, and nestable `(; … ;)`.
#[logos(skip r";;[^\n]*")]
pub enum Token {
  /// A single `;`. Never produced: at the start of a line it is the
  /// deprecated line comment (skipped and noted), and after code it is a
  /// lexing error, because a single `;` is not lisp.
  #[regex(r";([^;\n][^\n]*)?", lex_single_semicolon)]
  SingleSemicolon,

  /// `(;` opens a block comment, skipped through its matching `;)`.
  #[token("(;", lex_block_comment)]
  BlockComment,

  /// `(sh! …)`: a raw macro form (the head right after the paren). The macro owns its text up to the
  /// closing `)` (found by the bash front end, as for `$(…)`); the token
  /// carries the body, trimmed. See `posix_reader::raw_macro`.
  #[token("(sh!", lex_raw_macro)]
  RawMacro(RawMacro),

  #[token("(")]
  ParenOpen,

  #[token(")")]
  ParenClose,

  /// `[` — vector-literal opener. Desugared to `(vector ...)`.
  #[token("[")]
  BracketOpen,

  #[token("]")]
  BracketClose,

  /// `{` — map-literal opener. Desugared to `(hash-map ...)`.
  #[token("{")]
  BraceOpen,

  #[token("}")]
  BraceClose,

  /// `'` — quote shorthand. Desugared to `(quote …)`.
  #[token("'")]
  Quote,

  #[token("false", |_| false)]
  #[token("true", |_| true)]
  Bool(bool),

  // ASCII digit classes only: a Unicode `\d` lets the DFA stop between the
  // bytes of a multibyte char (fuzz finding F3 — `2\u{650}`), after which
  // `slice()` is not valid UTF-8.
  #[regex(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", |lex| lex.slice().parse::<f64>().unwrap())]
  Float(f64),

  #[regex(r"[+-]?(0|[1-9][_0-9]*)", |lex| {
    parse_int::parse::<i64>(lex.slice())
  }, priority = 3)]
  Integer(i64),

  // Scan in a callback: the overlapping complete/unterminated regexes make
  // Logos 0.14 generate input-length recursion in unoptimized builds.
  #[token("\"", lex_string)]
  String(String),

  /// Tagged-string literal: `tag\`payload\`` (short) or
  /// `tag\`\`\`payload\`\`\`` (long, allows embedded `\``).
  /// Lexed via a callback that scans the full payload.
  #[regex(r"[a-zA-Z_][a-zA-Z0-9_\-]*`", lex_tagged_string)]
  TaggedString(TaggedString),

  /// Identifiers — accept JS-permissive symbol characters so that
  /// fixtures relying on Common-Lisp / Scheme quote-text idioms
  /// (`'(a . b)`, `'#t`, `'#hash`, `'(,unquote)`, `'($special)`,
  /// `'object.property`, etc.) round-trip through quote with the
  /// same string representation as JS Lisp.
  ///
  /// - Start: alpha / `_` / `:` / `#` / `$` / `@` / `.` / `,` / `%`
  /// - Cont: alphanumeric / `_` / `:` / `-` / `#` / `$` / `@` / `.`
  ///         / `,` / `%` / `/`
  /// - Optional trailing `?` or `!`
  ///
  /// `/` is a cont-char (so e.g. `:host-a/host-health` is one keyword)
  /// but not a start-char, so a standalone `/` still lexes as the
  /// division operator below — `(/ 10 2)` keeps working.
  ///
  /// Float literals don't conflict because their regex requires a
  /// leading digit (`-?(?:0|[1-9]\d*)`), and symbol can't start with
  /// a digit. `priority = 2` outranks the single-char Operator regex
  /// for cases like `%here` where both could match.
  #[regex("[a-zA-Z_:#$@.,%][a-zA-Z0-9_:\\-#$@.,%/]*[?!]?", |lex| lex.slice().to_owned(), priority = 2)]
  Symbol(String),

  #[regex(r#"[\+\-\*\/<>=!%]+"#, |lex| lex.slice().to_owned(), priority = 1)]
  Operator(String),

  /// Template-string literal: `` `text ${expr} text` `` — a BARE
  /// leading backtick opens a TS-style template literal with `${…}`
  /// interpolation holes. Tagged strings are unaffected: their
  /// backtick only opens a payload after a tag, and the tag+backtick
  /// regex above out-munches this single-char regex. Desugared in the
  /// grammar to `(str.concat …)`; see `lex_template_string` for the
  /// escape and hole-scanning rules.
  #[regex(r"`", lex_template_string)]
  TemplateString(TemplateString),
}

/// Scan through the closing quote before decoding, so malformed escapes keep
/// the complete token's span and unterminated strings keep their EOF error.
/// Advancing by characters keeps every bump on a UTF-8 boundary.
fn lex_string(lex: &mut logos::Lexer<Token>) -> Result<String, LexingError> {
  let mut escaped = false;
  for (offset, ch) in lex.remainder().char_indices() {
    if escaped {
      escaped = false;
    } else if ch == '\\' {
      escaped = true;
    } else if ch == '"' {
      lex.bump(offset + 1);
      return unescape_string_literal(lex.slice());
    }
  }
  lex.bump(lex.remainder().len());
  Err(if escaped {
    LexingError::TrailingStringBackslash
  } else {
    LexingError::Other
  })
}

/// A raw macro form's head and its unparsed body.
#[derive(Debug, Clone, PartialEq)]
pub struct RawMacro {
  pub head: String,
  pub body: String,
}

/// Logos callback for `(sh!`: the head must end at whitespace or `)`; the
/// body runs to the bash-balanced `)`, which the token consumes.
fn lex_raw_macro(lex: &mut logos::Lexer<Token>) -> Result<RawMacro, LexingError> {
  let head = lex.slice()[1..].to_string();
  let rest = lex.remainder();
  if !(rest.is_empty() || rest.starts_with(|c: char| c.is_whitespace() || c == ')')) {
    return Err(LexingError::Other);
  }
  match crate::posix_reader::raw_macro_close(rest) {
    Ok(close) => {
      let body = rest[..close].trim().to_string();
      lex.bump(close + 1);
      Ok(RawMacro { head, body })
    }
    Err(_) => {
      lex.bump(rest.len());
      Err(LexingError::UnterminatedRawMacro)
    }
  }
}

/// Whether `source`, a top-level line that does not open with `(`, is
/// still lisp: it starts with a datum that is not a symbol — a string, number, boolean, `'quote`, template, or a `[`/`{`
/// literal not followed by a space (`[ -f x ]` and `{ cmd; }` are bash).
/// A strict lisp file refuses any other such line as bash.
pub fn datum_line(source: &str) -> bool {
  let source = source.trim();
  let mut lex = Token::lexer(source);
  match lex.next() {
    // A malformed string is still lisp: its reader error is the one to show.
    Some(Err(_)) => source.starts_with(['"', '`']),
    None => false,
    Some(Ok(first)) => match first {
      Token::Symbol(_) | Token::Operator(_) | Token::ParenClose | Token::BracketClose | Token::BraceClose => false,
      Token::BracketOpen | Token::BraceOpen => !source[1..].starts_with(char::is_whitespace),
      _ => true,
    },
  }
}

/// Logos callback for a single `;`: skipped when only indentation precedes
/// it on its line, refused after code.
fn lex_single_semicolon(lex: &mut logos::Lexer<Token>) -> logos::FilterResult<(), LexingError> {
  let start = lex.span().start;
  let line = &lex.source()[..start];
  let line = &line[line.rfind('\n').map_or(0, |at| at + 1)..];
  if line.chars().all(|c| c == ' ' || c == '\t') {
    lex.extras.deprecated_line_comment.get_or_insert(start);
    logos::FilterResult::Skip
  } else {
    logos::FilterResult::Error(LexingError::SingleSemicolon)
  }
}

/// Logos callback for `(;`: skip to the matching `;)`, counting nested
/// openers. Strings are not special inside a block comment, as in WAT.
fn lex_block_comment(lex: &mut logos::Lexer<Token>) -> logos::FilterResult<(), LexingError> {
  match block_comment_end(lex.remainder().as_bytes()) {
    Some(end) => {
      lex.bump(end);
      logos::FilterResult::Skip
    }
    None => {
      lex.bump(lex.remainder().len());
      logos::FilterResult::Error(LexingError::UnterminatedBlockComment)
    }
  }
}

/// Bytes after an opening `(;` up to and including its matching `;)`.
pub(crate) fn block_comment_end(bytes: &[u8]) -> Option<usize> {
  let mut depth = 1usize;
  let mut i = 0;
  while i + 1 < bytes.len() {
    match (bytes[i], bytes[i + 1]) {
      (b'(', b';') => {
        depth += 1;
        i += 2;
      }
      (b';', b')') => {
        depth -= 1;
        i += 2;
        if depth == 0 {
          return Some(i);
        }
      }
      _ => i += 1,
    }
  }
  None
}

/// Byte offset of the first deprecated single-`;` line comment in lisp
/// `source`, so a host can warn `deprecated: use ;;` once.
pub fn deprecated_line_comment(source: &str) -> Option<usize> {
  if !source.contains(';') {
    return None;
  }
  let mut lex = Token::lexer(source);
  while lex.next().is_some() {}
  lex.extras.deprecated_line_comment
}

/// True when lisp `source` lexes cleanly to no tokens: only whitespace and
/// comments, such as a whole-line `(; … ;)` block.
pub fn comment_only(source: &str) -> bool {
  Token::lexer(source).next().is_none()
}

/// Byte offset of the first single `;` after code in lisp `source`: the
/// text a lisp reader refuses, and which makes a line plainly bash.
pub fn single_semicolon(source: &str) -> Option<usize> {
  if !source.contains(';') {
    return None;
  }
  let mut lex = Token::lexer(source);
  while let Some(token) = lex.next() {
    if token == Err(LexingError::SingleSemicolon) {
      return Some(lex.span().start);
    }
  }
  None
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaggedString {
  pub tag: String,
  pub payload: String,
}

/// Logos callback: at this point `lex.slice()` is `tag\``. We need to
/// scan ahead to find the closing backtick (short form) or the
/// closing triple backtick (long form), and consume it.
fn lex_tagged_string(lex: &mut logos::Lexer<Token>) -> Result<TaggedString, LexingError> {
  let slice = lex.slice();
  // slice ends with one `\``. Strip it to recover the tag.
  let tag = slice[..slice.len() - 1].to_string();
  let rest = lex.remainder();
  let bytes = rest.as_bytes();

  // Long form: opener was followed by two more `\``.
  if bytes.len() >= 2 && bytes[0] == b'`' && bytes[1] == b'`' {
    // Scan for closing `\`\`\``.
    let mut i = 2;
    while i + 3 <= bytes.len() {
      if bytes[i] == b'`' && bytes[i + 1] == b'`' && bytes[i + 2] == b'`' {
        let payload = String::from_utf8_lossy(&bytes[2..i]).to_string();
        // Bump the lexer past the closing `\`\`\`` (i.e., `i + 3` bytes
        // beyond the opener). The opener single backtick is part of
        // the slice; the additional two and the trailing three are in
        // `rest`.
        lex.bump(i + 3);
        return Ok(TaggedString { tag, payload });
      }
      i += 1;
    }
    return Err(LexingError::UnterminatedTaggedString);
  }

  // Short form: scan to next `\``.
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'`' {
      let payload = String::from_utf8_lossy(&bytes[..i]).to_string();
      lex.bump(i + 1);
      return Ok(TaggedString { tag, payload });
    }
    i += 1;
  }
  Err(LexingError::UnterminatedTaggedString)
}

/// One segment of a template-string literal: literal text (escapes
/// already resolved) or the raw lisp source of a `${…}` hole.
#[derive(Debug, Clone, PartialEq)]
pub enum TemplatePart {
  Text(String),
  Hole(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct TemplateString {
  pub parts: Vec<TemplatePart>,
}

/// Logos callback: `lex.slice()` is the opening backtick of a template
/// literal. Scan to the closing backtick, splitting the payload into
/// literal text runs and `${…}` holes.
///
/// - Escapes in text: `\$` → `$` (so `\${` is a literal `${`),
///   `` \` `` → `` ` ``, `\\` → `\`. Any other backslash sequence is
///   kept verbatim (backslash included) — plain `"…"` string escaping
///   is NOT applied here.
/// - A lone `$` not followed by `{` is literal text (TS behavior).
/// - Holes are scanned balanced: nested `{`/`}` and `"…"` string
///   literals (with their backslash escapes) are tracked so `}` inside
///   either never closes the hole.
/// - Backticks INSIDE a hole are rejected (`NestedBacktickInTemplateHole`)
///   — no nested template literals or tagged strings in holes; bind
///   the value outside the template instead.
/// - An empty (or whitespace-only) hole `${}` is an error.
fn lex_template_string(lex: &mut logos::Lexer<Token>) -> Result<TemplateString, LexingError> {
  let rest = lex.remainder();
  let bytes = rest.as_bytes();
  let mut parts = vec![];
  let mut text: Vec<u8> = vec![];
  let flush_text = |text: &mut Vec<u8>, parts: &mut Vec<TemplatePart>| {
    if !text.is_empty() {
      parts.push(TemplatePart::Text(
        String::from_utf8_lossy(&std::mem::take(text)).to_string(),
      ));
    }
  };

  let mut i = 0;
  while i < bytes.len() {
    match bytes[i] {
      b'\\' => match bytes.get(i + 1) {
        Some(c @ (b'$' | b'`' | b'\\')) => {
          text.push(*c);
          i += 2;
        }
        _ => {
          text.push(b'\\');
          i += 1;
        }
      },
      b'`' => {
        flush_text(&mut text, &mut parts);
        lex.bump(i + 1);
        return Ok(TemplateString { parts });
      }
      b'$' if bytes.get(i + 1) == Some(&b'{') => {
        let (hole, next) = scan_template_hole(bytes, i + 2)?;
        if hole.trim().is_empty() {
          return Err(LexingError::EmptyTemplateHole);
        }
        flush_text(&mut text, &mut parts);
        parts.push(TemplatePart::Hole(hole));
        i = next;
      }
      c => {
        text.push(c);
        i += 1;
      }
    }
  }
  Err(LexingError::UnterminatedTemplateString)
}

/// Scan the body of a `${…}` hole starting just past the `{`. Returns
/// the hole's raw source and the index just past the closing `}`.
fn scan_template_hole(bytes: &[u8], start: usize) -> Result<(String, usize), LexingError> {
  let mut depth = 0usize;
  let mut i = start;
  while i < bytes.len() {
    match bytes[i] {
      b'{' => depth += 1,
      b'}' => {
        if depth == 0 {
          let hole = String::from_utf8_lossy(&bytes[start..i]).to_string();
          return Ok((hole, i + 1));
        }
        depth -= 1;
      }
      // Skip over a `"…"` string literal so braces (and backticks)
      // inside it stay inert — e.g. `${(env "A{B}")}`.
      b'"' => {
        i += 1;
        loop {
          match bytes.get(i) {
            None => return Err(LexingError::UnterminatedTemplateString),
            Some(b'\\') => i += 1, // skip the escaped char too
            Some(b'"') => break,
            Some(_) => {}
          }
          i += 1;
        }
      }
      b'`' => return Err(LexingError::NestedBacktickInTemplateHole),
      _ => {}
    }
    i += 1;
  }
  Err(LexingError::UnterminatedTemplateString)
}

impl std::fmt::Display for Token {
  fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
    write!(f, "{:?}", self)
  }
}

pub struct TokenLocation {
  pub token: Option<Token>,
  pub loc: Location,
}

impl Display for TokenLocation {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{:?} {}", self.token, self.loc)
  }
}

#[derive(Debug, PartialEq, Clone, Default)]
pub enum LexingError {
  NumberParseError,
  UnknownStringEscape(char),
  TrailingStringBackslash,
  UnterminatedTaggedString,
  UnterminatedTemplateString,
  EmptyTemplateHole,
  NestedBacktickInTemplateHole,
  /// A single `;` after code: only `;;` and `(; … ;)` are lisp comments.
  SingleSemicolon,
  /// A raw macro (`(sh! …`) whose bash body never reaches its `)`.
  UnterminatedRawMacro,
  UnterminatedBlockComment,
  #[default]
  Other,
}

impl Display for LexingError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::UnknownStringEscape(c) => {
        let escape = c.escape_debug();
        write!(
          f,
          r"unknown escape `\{escape}` in a double-quoted string — write `\\{escape}` for a backslash, or use single quotes"
        )
      }
      Self::TrailingStringBackslash => f.write_str(
        r"trailing backslash in a double-quoted string — write `\\` for a backslash, or use single quotes",
      ),
      Self::SingleSemicolon => f.write_str(
        "a single `;` is not lisp — write `;;` for a comment, or `(; … ;)` for a block",
      ),
      Self::UnterminatedBlockComment => f.write_str("unterminated block comment — close `(;` with `;)`"),
      Self::UnterminatedRawMacro => f.write_str(
        "unterminated (sh! …): its bash body never reaches a closing `)` (check its quotes and parens)",
      ),
      _ => write!(f, "{:?}", Err::<(), _>(self)),
    }
  }
}

impl From<std::num::ParseIntError> for LexingError {
  fn from(_: std::num::ParseIntError) -> Self {
    LexingError::NumberParseError
  }
}

impl From<std::num::ParseFloatError> for LexingError {
  fn from(_: std::num::ParseFloatError) -> Self {
    LexingError::NumberParseError
  }
}

/// Both readers use the Lisp string escape table. Unicode escapes are not
/// part of the string syntax; unknown escapes name the rejected character.
pub(crate) fn decode_string_escape(c: char) -> Result<char, LexingError> {
  match c {
    '"' => Ok('"'),
    '\\' => Ok('\\'),
    'b' => Ok('\u{0008}'),
    'n' => Ok('\n'),
    'f' => Ok('\u{000C}'),
    'r' => Ok('\r'),
    't' => Ok('\t'),
    _ => Err(LexingError::UnknownStringEscape(c)),
  }
}

/// Strip the surrounding `"` and decode its escapes through the shared table.
fn unescape_string_literal(slice: &str) -> Result<String, LexingError> {
  let inner = &slice[1..slice.len() - 1];
  let mut out = String::with_capacity(inner.len());
  let mut chars = inner.chars();
  while let Some(c) = chars.next() {
    if c != '\\' {
      out.push(c);
      continue;
    }
    out.push(decode_string_escape(
      chars.next().ok_or(LexingError::TrailingStringBackslash)?,
    )?);
  }
  Ok(out)
}

#[cfg(test)]
mod test {

  use super::*;

  #[test]
  pub fn test_basic() {
    let expr = r#"(a b (c d) "hello world" (+ 1 2))"#;
    let lex = Token::lexer(expr);

    let tokens: Vec<_> = lex.filter_map(|r| r.as_ref().ok().cloned()).collect();
    // let tokens = lex.collect::<Vec<Result<Token, _>>>();
    println!("{:#?}", tokens);
  }

  #[test]
  fn digit_then_multibyte_char_lexes_without_splitting_it() {
    // fuzz finding F3: these produced a slice ending inside U+0650 / U+065F,
    // which the number callbacks then read as a str.
    for src in [
      "(2\u{650} 0",
      "(33\u{65f}:r.r00 E00)",
      "1\u{660}",
      "-0.5\u{661}e1",
    ] {
      for tok in Token::lexer(src).flatten() {
        if let Token::Symbol(s) | Token::Operator(s) = &tok {
          assert!(std::str::from_utf8(s.as_bytes()).is_ok());
        }
      }
    }
  }

  fn lex_one(src: &str) -> Token {
    let tokens: Vec<_> = Token::lexer(src).collect();
    assert_eq!(tokens.len(), 1, "expected one token: {tokens:?}");
    tokens.into_iter().next().unwrap().expect("lexes cleanly")
  }

  fn lex_err(src: &str) -> LexingError {
    Token::lexer(src)
      .find_map(|r| r.err())
      .expect("expected a lexing error")
  }

  #[test]
  fn plain_string_escape_contract() {
    for (escape, value) in [
      (r"\b", "\u{0008}"),
      (r"\n", "\n"),
      (r"\f", "\u{000C}"),
      (r"\r", "\r"),
      (r"\t", "\t"),
      (r"\\", "\\"),
      (r#"\""#, "\""),
    ] {
      assert_eq!(
        lex_one(&format!("\"{escape}\"")),
        Token::String(value.into())
      );
    }
    for escape in [
      r"\.", r"\$", r"\a", r"\v", r"\0", r"\/", r"\x41", r"\u0041", "\\\n", "\\λ",
    ] {
      assert_eq!(
        lex_err(&format!("\"{escape}\"")),
        LexingError::UnknownStringEscape(escape.chars().nth(1).unwrap()),
        "{escape}"
      );
    }
    assert_eq!(lex_one(r#""u0041""#), Token::String("u0041".into()));
  }

  #[test]
  fn plain_string_escape_errors_teach_literal_backslashes() {
    assert_eq!(
      lex_err(r#""a\.b""#).to_string(),
      r"unknown escape `\.` in a double-quoted string — write `\\.` for a backslash, or use single quotes"
    );
    assert_eq!(lex_err(r#""a\λb""#), LexingError::UnknownStringEscape('λ'));
    assert_eq!(lex_one(r#""a\\.b""#), Token::String(r"a\.b".into()));
  }

  #[test]
  fn plain_string_trailing_backslash_has_its_own_diagnostic() {
    for source in ["\"a\\", "\"α\\", "\"a\\\\\\"] {
      let err = lex_err(source);
      assert_eq!(err, LexingError::TrailingStringBackslash, "{source}");
      assert_eq!(
        err.to_string(),
        r"trailing backslash in a double-quoted string — write `\\` for a backslash, or use single quotes"
      );
    }
    // A pair of backslashes is complete; only the closing quote is missing.
    assert_eq!(lex_err("\"a\\\\"), LexingError::Other);
    assert_eq!(lex_one(r#""a\\""#), Token::String("a\\".into()));
  }

  #[test]
  fn long_plain_strings_use_bounded_stack_and_preserve_spans() {
    // Original 64 KiB crash, plus mixed UTF-8 and escapes on the normal test stack.
    for (body, decoded) in [
      ("x".repeat(65_536), "x".repeat(65_536)),
      (r#"λ🦀\n\\\""#.repeat(65_536), "λ🦀\n\\\"".repeat(65_536)),
    ] {
      let source = format!("  \"{body}\")");
      let mut lex = Token::lexer(&source);
      assert_eq!(lex.next(), Some(Ok(Token::String(decoded))));
      assert_eq!(lex.span(), 2..body.len() + 4);
      assert_eq!(lex.next(), Some(Ok(Token::ParenClose)));
      assert_eq!(lex.span(), body.len() + 4..source.len());
      assert_eq!(lex.next(), None);
    }
  }

  #[test]
  fn malformed_plain_strings_keep_errors_and_byte_spans() {
    for (source, error) in [
      ("\"", LexingError::Other),
      ("\"λ🦀", LexingError::Other),
      ("\"λ\\q", LexingError::Other),
      ("\"λ\\q\\", LexingError::TrailingStringBackslash),
      ("\"λ\\\\", LexingError::Other),
      ("\"λ\\\\\\", LexingError::TrailingStringBackslash),
      ("\"λ\\q\"", LexingError::UnknownStringEscape('q')),
      ("\"λ\\🦀\"", LexingError::UnknownStringEscape('🦀')),
      ("\"λ\\\n\"", LexingError::UnknownStringEscape('\n')),
    ] {
      let mut lex = Token::lexer(source);
      assert_eq!(lex.next(), Some(Err(error)), "{source:?}");
      assert_eq!(lex.span(), 0..source.len(), "{source:?}");
      assert_eq!(lex.next(), None, "{source:?}");
    }
    for (suffix, error) in [
      ("", LexingError::Other),
      ("\\", LexingError::TrailingStringBackslash),
      ("\\\\", LexingError::Other),
      ("\\q\"", LexingError::UnknownStringEscape('q')),
    ] {
      let source = format!("\"{}{suffix}", "λ".repeat(65_536));
      let mut lex = Token::lexer(&source);
      assert_eq!(lex.next(), Some(Err(error)));
      assert_eq!(lex.span(), 0..source.len());
      assert_eq!(lex.next(), None);
    }
  }

  fn text(s: &str) -> TemplatePart {
    TemplatePart::Text(s.to_string())
  }

  fn hole(s: &str) -> TemplatePart {
    TemplatePart::Hole(s.to_string())
  }

  #[test]
  fn template_string_splits_text_and_holes() {
    match lex_one("`a ${b} c${(d 1)}`") {
      Token::TemplateString(t) => assert_eq!(
        t.parts,
        vec![text("a "), hole("b"), text(" c"), hole("(d 1)")]
      ),
      other => panic!("expected TemplateString, got {other:?}"),
    }
  }

  #[test]
  fn empty_template_string_has_no_parts() {
    match lex_one("``") {
      Token::TemplateString(t) => assert!(t.parts.is_empty()),
      other => panic!("expected TemplateString, got {other:?}"),
    }
  }

  /// Hole scanning is balanced: `{}` from map literals and braces
  /// inside `"…"` string arguments never close the hole.
  #[test]
  fn template_hole_tracks_braces_and_strings() {
    match lex_one(r#"`${(f {"k" 1} "A{B}")}`"#) {
      Token::TemplateString(t) => {
        assert_eq!(t.parts, vec![hole(r#"(f {"k" 1} "A{B}")"#)])
      }
      other => panic!("expected TemplateString, got {other:?}"),
    }
  }

  /// `\$` → `$`, `` \` `` → `` ` ``, `\\` → `\`; a lone `$` (including
  /// at the very end) is literal text.
  #[test]
  fn template_string_escapes_and_bare_dollars() {
    match lex_one(r"`\${x} \` \\ $5 end$`") {
      Token::TemplateString(t) => {
        assert_eq!(t.parts, vec![text("${x} ` \\ $5 end$")])
      }
      other => panic!("expected TemplateString, got {other:?}"),
    }
  }

  #[test]
  fn template_string_errors() {
    assert_eq!(lex_err("`abc"), LexingError::UnterminatedTemplateString);
    assert_eq!(lex_err("`${(f 1)"), LexingError::UnterminatedTemplateString);
    assert_eq!(lex_err("`${}`"), LexingError::EmptyTemplateHole);
    assert_eq!(lex_err("`${  }`"), LexingError::EmptyTemplateHole);
    // Documented choice: NO backticks inside holes — neither nested
    // template literals nor tagged strings. Bind the value outside.
    assert_eq!(
      lex_err("`${`x`}`"),
      LexingError::NestedBacktickInTemplateHole
    );
    assert_eq!(
      lex_err("`${json`{}`}`"),
      LexingError::NestedBacktickInTemplateHole
    );
  }

  /// Regression: tagged strings coexist with template literals — the
  /// backtick after a tag still opens a RAW payload, `${…}` included.
  #[test]
  fn tagged_strings_are_unchanged() {
    match lex_one("x`a ${b} c`") {
      Token::TaggedString(t) => {
        assert_eq!(t.tag, "x");
        assert_eq!(t.payload, "a ${b} c");
      }
      other => panic!("expected TaggedString, got {other:?}"),
    }
    // Long form still allows embedded backticks (and raw `${…}`).
    match lex_one("x```a `tick` ${b}```") {
      Token::TaggedString(t) => {
        assert_eq!(t.tag, "x");
        assert_eq!(t.payload, "a `tick` ${b}");
      }
      other => panic!("expected TaggedString, got {other:?}"),
    }
  }

  fn lex_ok(src: &str) -> Vec<Token> {
    Token::lexer(src).map(|t| t.expect("lexes cleanly")).collect()
  }

  /// I10: `;;` runs to the end of the line and `(; … ;)` nests, as in WAT.
  #[test]
  fn wat_line_and_nested_block_comments_are_skipped() {
    let sym = |s: &str| Token::Symbol(s.into());
    assert_eq!(lex_ok("a ;; b (c\nd"), vec![sym("a"), sym("d")]);
    assert_eq!(lex_ok(";;; heading\n  ;; indented\ne"), vec![sym("e")]);
    assert_eq!(
      lex_ok("(a (; one (; two ;) still one ;) b)"),
      vec![Token::ParenOpen, sym("a"), sym("b"), Token::ParenClose]
    );
    assert_eq!(lex_ok("(;\n\"(; ;)\" ;)x"), vec![sym("x")]);
    assert_eq!(lex_ok(r#""a; b ;; c (; d""#), vec![Token::String("a; b ;; c (; d".into())]);
    assert_eq!(lex_err("(a (; open (; nested ;)"), LexingError::UnterminatedBlockComment);
  }

  /// I10 transition: a single `;` that starts a line is the deprecated line
  /// comment; after code it is not lisp, and the error names `;;`.
  #[test]
  fn single_semicolon_is_a_deprecated_line_comment_or_an_error() {
    let mut lex = Token::lexer("(a\n  ; old comment\n b)");
    let tokens: Vec<_> = lex.by_ref().collect();
    assert!(tokens.iter().all(Result::is_ok), "{tokens:?}");
    assert_eq!(tokens.len(), 4);
    assert_eq!(lex.extras.deprecated_line_comment, Some(5));
    assert_eq!(deprecated_line_comment("; x\n(a)"), Some(0));
    assert_eq!(deprecated_line_comment(";; x\n(a) ;; y"), None);

    for source in ["(a) ; comment", "(a ; comment\n b)", "(a);", "(echo x); echo y"] {
      assert_eq!(lex_err(source), LexingError::SingleSemicolon, "{source}");
      assert_eq!(single_semicolon(source), source.find(';'), "{source}");
    }
    assert!(comment_only("  (; a (; b ;) ;) ;; c\n ; d"));
    assert!(!comment_only("(; a ;) b") && !comment_only("(; open"));
    assert_eq!(single_semicolon("(a) ;; fine\n; fine\n(\"b;\")"), None);
    assert_eq!(
      LexingError::SingleSemicolon.to_string(),
      "a single `;` is not lisp — write `;;` for a comment, or `(; … ;)` for a block"
    );
  }

  /// Regression: plain `"…"` strings stay 100% literal — `${…}` and
  /// backticks inside them mean nothing.
  #[test]
  fn plain_strings_are_untouched() {
    match lex_one(r#""${x} `not a template`""#) {
      Token::String(s) => assert_eq!(s, "${x} `not a template`"),
      other => panic!("expected String, got {other:?}"),
    }
  }
}
