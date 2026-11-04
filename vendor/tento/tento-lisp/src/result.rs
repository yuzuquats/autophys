use crate::{eval::RuntimeError, lexer::TokenLocation};

pub type EvalResult<T> = std::result::Result<T, EvalError>;
pub type SyntaxResult<T> = std::result::Result<T, SyntaxError>;
pub type ParseError = peg::error::ParseError<TokenLocation>;

#[derive(Debug)]
pub enum EvalError {
  RuntimeError(RuntimeError),
  SyntaxError(SyntaxError),
}

#[derive(Debug)]
pub enum SyntaxError {
  InvalidStringEscape { message: String, loc: Location },
  /// A single `;` after code, or an unterminated `(; … ;)` block.
  InvalidComment { message: String, loc: Location },
  InvalidToken { token: String, loc: Location },
  UnexpectedToken { token: String, loc: Location },
  /// The input nests deeper than [`crate::MAX_NESTING_DEPTH`].
  TooDeep { message: String, loc: Location },
}

impl From<ParseError> for SyntaxError {
  fn from(err: ParseError) -> Self {
    let TokenLocation { token, loc } = err.location;

    Self::UnexpectedToken {
      token: token.map(|tok| tok.to_string()).unwrap_or("<>".to_string()),
      loc,
    }
  }
}

/// Human text: the reader's sentence and where it happened, e.g.
/// `unexpected end of input at line 1, column 5`. The fields (and `Debug`)
/// are unchanged; only this rendering is for people.
impl std::fmt::Display for SyntaxError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let (what, loc) = match self {
      Self::InvalidStringEscape { message, loc }
      | Self::InvalidComment { message, loc }
      | Self::TooDeep { message, loc } => (message.clone(), loc),
      Self::InvalidToken { token, loc } => (invalid_token_text(token), loc),
      Self::UnexpectedToken { token, loc } if token == "<>" => ("unexpected end of input".to_string(), loc),
      Self::UnexpectedToken { token, loc } => (format!("unexpected token {token:?}"), loc),
    };
    write!(f, "{what} at {}", loc.human())
  }
}

impl std::fmt::Display for EvalError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::RuntimeError(e) => write!(f, "{e}"),
      Self::SyntaxError(e) => write!(f, "{e}"),
    }
  }
}

/// An `InvalidToken`'s text is the lexer's message; the lexer errors without a
/// sentence of their own arrive as `Err(<Variant>)` and are named here.
fn invalid_token_text(token: &str) -> String {
  let Some(variant) = token.strip_prefix("Err(").and_then(|t| t.strip_suffix(')')) else {
    return token.to_string();
  };
  match variant {
    "NumberParseError" => "invalid number",
    "UnterminatedTaggedString" => "unterminated tagged string",
    "UnterminatedTemplateString" => "unterminated template string",
    "EmptyTemplateHole" => "empty template hole `${}`",
    "NestedBacktickInTemplateHole" => "a backtick string nested inside a template hole",
    _ => "invalid token",
  }
  .to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Location {
  pub filename: Option<std::path::PathBuf>,
  pub linecol: (usize, usize),
}

impl std::fmt::Display for Location {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let (line, col) = self.linecol;
    let filename = self
      .filename
      .as_ref()
      .and_then(|path| path.to_str())
      .unwrap_or("<>");

    write!(f, "{}[{};{}]", filename, line, col)
  }
}

impl Location {
  /// `line L, column C`, prefixed with `FILE ` when the file is known.
  pub fn human(&self) -> String {
    let (line, col) = self.linecol;
    match self.filename.as_ref().and_then(|path| path.to_str()) {
      Some(file) => format!("{file} line {line}, column {col}"),
      None => format!("line {line}, column {col}"),
    }
  }
}
