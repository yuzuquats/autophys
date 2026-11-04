use crate::{
  lexer::{LexingError, TemplatePart, TemplateString, Token, TokenLocation},
  result::{Location, SyntaxError},
  symbol::{Backend, Symbol},
};
use line_col::LineColLookup;
use logos::{Logos, Span};
use string_interner::StringInterner;

#[derive(Debug, Clone, PartialEq)]
pub enum Literal<S: Symbol> {
  Boolean(bool),
  Integer(i64),
  Float(f64),
  String(String),
  Symbol(S),
  TaggedString { tag: String, payload: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum SExpression<S: Symbol> {
  Literal(Literal<S>),
  List(Vec<SExpression<S>>),
}

pub struct TokenStream<'source> {
  filename: Option<std::path::PathBuf>,
  size: usize,
  tokens: Vec<(Token, Span)>,
  linecol_lookup: LineColLookup<'source>,
}

impl<'source> TokenStream<'source> {
  pub fn new(
    filename: Option<std::path::PathBuf>,
    input: &'source str,
  ) -> crate::result::SyntaxResult<Self> {
    let linecol_lookup = LineColLookup::new(input);
    let mut tokens = vec![];
    for (token, span) in Token::lexer(input).spanned() {
      match token {
        Ok(token) => {
          tokens.push((token, span));
        }
        Err(err) => {
          let (line, col) = linecol_lookup.get(span.start);
          let loc = Location {
            filename,
            linecol: (line, col),
          };
          if matches!(
            err,
            LexingError::SingleSemicolon | LexingError::UnterminatedBlockComment
          ) {
            return Err(SyntaxError::InvalidComment {
              message: err.to_string(),
              loc,
            });
          }
          if matches!(
            err,
            LexingError::UnknownStringEscape(_) | LexingError::TrailingStringBackslash
          ) {
            return Err(SyntaxError::InvalidStringEscape {
              message: err.to_string(),
              loc,
            });
          }
          return Err(SyntaxError::InvalidToken {
            token: err.to_string(),
            loc,
          });
        }
      }
    }

    check_nesting(&tokens, &linecol_lookup, &filename)?;

    Ok(Self {
      filename,
      size: input.len(),
      tokens,
      linecol_lookup,
    })
  }
}

/// The deepest nesting the reader accepts: open `(`, `[` and `{` plus
/// pending `'` quotes around the current position.
///
/// The PEG reader, the reader tree's derived drop/`Debug`/`PartialEq` and the
/// renderers recurse once per level on the native stack, outside the
/// evaluator's stack grower. Measured in a debug build, parsing costs 1 to
/// 1.5 KiB of native stack per level: 1,000 levels parse in 1.5 MiB but not
/// 1 MiB, and 2,000 need 3 MiB. 1,000 levels therefore fit the 2 MiB of a
/// spawned (or test) thread as well as the 8 MiB main thread, in an
/// unoptimised build (`tests/deep_values.rs` checks the limit on 2 MiB).
/// Real code nests a few dozen levels; data deeper than this is built at run
/// time, not written as source. Input past the limit is a
/// [`SyntaxError::TooDeep`], never a stack overflow.
pub const MAX_NESTING_DEPTH: usize = 1_000;

/// Reject input that nests deeper than [`MAX_NESTING_DEPTH`] before the
/// recursive reader sees it. One pass, tracking the open brackets and the
/// quotes still waiting for their expression.
fn check_nesting(
  tokens: &[(Token, Span)],
  linecol_lookup: &LineColLookup<'_>,
  filename: &Option<std::path::PathBuf>,
) -> crate::result::SyntaxResult<()> {
  #[derive(PartialEq)]
  enum Open {
    Bracket,
    Quote,
  }
  let mut open: Vec<Open> = Vec::new();
  for (token, span) in tokens {
    match token {
      Token::ParenOpen | Token::BracketOpen | Token::BraceOpen => open.push(Open::Bracket),
      Token::Quote => open.push(Open::Quote),
      Token::ParenClose | Token::BracketClose | Token::BraceClose => {
        if open.last() == Some(&Open::Bracket) {
          open.pop();
        }
        while open.last() == Some(&Open::Quote) {
          open.pop();
        }
        continue;
      }
      _ => {
        while open.last() == Some(&Open::Quote) {
          open.pop();
        }
        continue;
      }
    }
    if open.len() > MAX_NESTING_DEPTH {
      return Err(SyntaxError::TooDeep {
        message: format!("input nests deeper than {MAX_NESTING_DEPTH} levels"),
        loc: Location {
          filename: filename.clone(),
          linecol: linecol_lookup.get(span.start),
        },
      });
    }
  }
  Ok(())
}

impl<'source> peg::Parse for TokenStream<'source> {
  type PositionRepr = TokenLocation;

  fn start<'input>(&'input self) -> usize {
    0
  }

  fn is_eof<'input>(&'input self, pos: usize) -> bool {
    pos >= self.tokens.len()
  }

  fn position_repr<'input>(&'input self, pos: usize) -> Self::PositionRepr {
    let (token, linecol) = match self.tokens.get(pos) {
      Some((token, span)) => (Some(token.clone()), self.linecol_lookup.get(span.start)),
      None => (None, self.linecol_lookup.get(self.size)),
    };

    Self::PositionRepr {
      loc: Location {
        filename: self.filename.clone(),
        linecol,
      },
      token,
    }
  }
}

impl<'source, 'input> peg::ParseElem<'input> for TokenStream<'source> {
  type Element = &'input Token;

  fn parse_elem(&'input self, pos: usize) -> peg::RuleResult<Self::Element> {
    match self.tokens.get(pos) {
      Some((token, _)) => peg::RuleResult::Matched(pos + 1, token),
      _ => peg::RuleResult::Failed,
    }
  }
}

impl<'source> peg::ParseLiteral for TokenStream<'source> {
  fn parse_string_literal(&self, pos: usize, literal: &str) -> peg::RuleResult<()> {
    match self.tokens.get(pos) {
      Some((Token::Symbol(sym), _)) if sym == literal => peg::RuleResult::Matched(pos + 1, ()),
      _ => peg::RuleResult::Failed,
    }
  }
}

impl<'source, 'input> peg::ParseSlice<'input> for TokenStream<'source> {
  type Slice = Vec<&'input Token>;

  fn parse_slice(&'input self, begin_pos: usize, end_pos: usize) -> Self::Slice {
    self.tokens[begin_pos..end_pos]
      .into_iter()
      .map(|(token, _)| token)
      .collect()
  }
}

peg::parser! {
  pub grammar module_parser<'source>() for TokenStream<'source> {
    pub rule module<S: Symbol, B: Backend<S>>(
      interner: &mut StringInterner<B>
    ) -> Vec<SExpression<S>>
      = exprs:s_expression(interner)*
      { exprs }

    rule s_expression<S: Symbol, B: Backend<S>>(
      interner: &mut StringInterner<B>
    ) -> SExpression<S>
      = quoted(interner)
      / raw_macro(interner)
      / vector(interner)
      / map_literal(interner)
      / list(interner)
      / literal(interner)

    rule list<S: Symbol, B: Backend<S>>(
      interner: &mut StringInterner<B>
    ) -> SExpression<S>
      = [Token::ParenOpen] children:s_expression(interner)* [Token::ParenClose]
      { SExpression::List(children) }

    /// `(sh! BODY)` => `(sh! "BODY")`: the macro receives its raw text.
    rule raw_macro<S: Symbol, B: Backend<S>>(
      interner: &mut StringInterner<B>
    ) -> SExpression<S>
      = [Token::RawMacro(m)]
      {
        let head = interner.get_or_intern(&m.head);
        SExpression::List(vec![
          SExpression::Literal(Literal::Symbol(head)),
          SExpression::Literal(Literal::String(m.body.clone())),
        ])
      }

    /// `'expr` => `(quote expr)`
    rule quoted<S: Symbol, B: Backend<S>>(
      interner: &mut StringInterner<B>
    ) -> SExpression<S>
      = [Token::Quote] inner:s_expression(interner)
      {
        let q = interner.get_or_intern("quote");
        SExpression::List(vec![
          SExpression::Literal(Literal::Symbol(q)),
          inner,
        ])
      }

    /// `[a b c]` => `(vector a b c)`
    rule vector<S: Symbol, B: Backend<S>>(
      interner: &mut StringInterner<B>
    ) -> SExpression<S>
      = [Token::BracketOpen] children:s_expression(interner)* [Token::BracketClose]
      {
        let v = interner.get_or_intern("vector");
        let mut items = Vec::with_capacity(children.len() + 1);
        items.push(SExpression::Literal(Literal::Symbol(v)));
        items.extend(children);
        SExpression::List(items)
      }

    /// `{k v ...}` => `(hash-map k v ...)`
    rule map_literal<S: Symbol, B: Backend<S>>(
      interner: &mut StringInterner<B>
    ) -> SExpression<S>
      = [Token::BraceOpen] children:s_expression(interner)* [Token::BraceClose]
      {
        let h = interner.get_or_intern("hash-map");
        let mut items = Vec::with_capacity(children.len() + 1);
        items.push(SExpression::Literal(Literal::Symbol(h)));
        items.extend(children);
        SExpression::List(items)
      }

    rule literal<S: Symbol, B: Backend<S>>(
      interner: &mut StringInterner<B>
    ) -> SExpression<S>
      = literal_boolean()
      / literal_float()
      / literal_integer()
      / literal_string()
      / literal_tagged_string()
      / template_string(interner)
      / literal_operator(interner)
      / literal_symbol(interner)

    /// `` `a ${b} c` `` => `(str.concat "a " b " c")` — see
    /// `desugar_template_string`.
    rule template_string<S: Symbol, B: Backend<S>>(
      interner: &mut StringInterner<B>
    ) -> SExpression<S>
      = [Token::TemplateString(t)]
      {? desugar_template_string(t, interner) }

    rule literal_tagged_string<S: Symbol>() -> SExpression<S>
      = [Token::TaggedString(t)]
      {
        SExpression::Literal(Literal::TaggedString {
          tag: t.tag.clone(),
          payload: t.payload.clone(),
        })
      }

    rule literal_float<S: Symbol>() -> SExpression<S>
      = [Token::Float(n)]
      { SExpression::Literal(Literal::Float(*n)) }

    rule literal_operator<S: Symbol, B: Backend<S>>(interner: &mut StringInterner<B>) -> SExpression<S>
      = [Token::Operator(n)]
      {
        let sym = interner.get_or_intern(n);
        SExpression::Literal(Literal::Symbol(sym))
      }

    rule literal_boolean<S: Symbol>() -> SExpression<S>
      = literal_boolean_true()
      / literal_boolean_false()

    rule literal_boolean_true<S: Symbol>() -> SExpression<S>
      = [Token::Bool(true)]
      { SExpression::Literal(Literal::Boolean(true)) }

    rule literal_boolean_false<S: Symbol>() -> SExpression<S>
      = [Token::Bool(false)]
      { SExpression::Literal(Literal::Boolean(false)) }

    rule literal_integer<S: Symbol>() -> SExpression<S>
      // = literal_integer_2()
      // / literal_integer_8()
      = literal_integer_10()
      // / literal_integer_16()

    rule literal_integer_10<S: Symbol>() -> SExpression<S>
      = [Token::Integer(n)]
      { SExpression::Literal(Literal::Integer(*n)) }

    rule literal_string<S: Symbol>() -> SExpression<S>
      = [Token::String(s)]
      { SExpression::Literal(Literal::String(s.to_string())) }

    rule literal_symbol<S: Symbol, B: Backend<S>>(
      interner: &mut StringInterner<B>
    ) -> SExpression<S>
      = [Token::Symbol(s)]
      {
        let sym = interner.get_or_intern(s);
        SExpression::Literal(Literal::Symbol(sym))
      }
  }
}

/// Desugar a scanned template literal:
///
/// - No holes → a plain string literal (the empty template is `""`).
/// - Otherwise `(str.concat …)` over the parts in order — text runs
///   become string literals, and each hole's raw source is re-parsed
///   as exactly one s-expression.
fn desugar_template_string<S: Symbol, B: Backend<S>>(
  template: &TemplateString,
  interner: &mut StringInterner<B>,
) -> Result<SExpression<S>, &'static str> {
  let has_holes = template
    .parts
    .iter()
    .any(|p| matches!(p, TemplatePart::Hole(_)));
  if !has_holes {
    let text = template
      .parts
      .iter()
      .map(|p| match p {
        TemplatePart::Text(s) => s.as_str(),
        TemplatePart::Hole(_) => unreachable!(),
      })
      .collect::<String>();
    return Ok(SExpression::Literal(Literal::String(text)));
  }

  let concat = interner.get_or_intern("str.concat");
  let mut items = Vec::with_capacity(template.parts.len() + 1);
  items.push(SExpression::Literal(Literal::Symbol(concat)));
  for part in &template.parts {
    match part {
      TemplatePart::Text(s) => items.push(SExpression::Literal(Literal::String(s.clone()))),
      TemplatePart::Hole(src) => {
        let stream = TokenStream::new(None, src).map_err(|_| "invalid token in template hole")?;
        let mut exprs = module_parser::module(&stream, interner)
          .map_err(|_| "invalid expression in template hole")?;
        if exprs.len() != 1 {
          return Err("template hole must contain exactly one expression");
        }
        items.push(exprs.pop().unwrap());
      }
    }
  }
  Ok(SExpression::List(items))
}
