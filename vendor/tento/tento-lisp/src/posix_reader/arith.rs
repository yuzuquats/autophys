//! Bash's signed 64-bit integer grammar; no Lisp numeric semantics change.
use super::*;

pub(super) fn lower<S: Symbol, B: Backend<S>>(
  source: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<SExpression<S>, PosixReadError> {
  for name in variable_names(source) {
    interner.get_or_intern(&name);
  }
  let chars: Vec<_> = source.chars().collect();
  let mut parts = Vec::new();
  let mut literal = String::new();
  let mut i = 0;
  while i < chars.len() {
    let expansion = if chars[i] == '$' {
      read_expansion(&chars, i, interner, home)?
    } else if chars[i] == '`' {
      let (inner, end) = backtick_source(&chars, i + 1)?;
      let command = read_statement_with_home(&inner, interner, home)?;
      Some((call("std.sh.sub", vec![command], interner), end + 1))
    } else {
      None
    };
    if let Some((value, end)) = expansion {
      if !literal.is_empty() {
        parts.push(SExpression::Literal(Literal::String(std::mem::take(
          &mut literal,
        ))));
      }
      parts.push(value);
      i = end;
    } else {
      // Quote removal: `$(( "$x" + 1 ))` is `$(( 4 + 1 ))`.
      if chars[i] != '"' {
        literal.push(chars[i]);
      }
      i += 1;
    }
  }
  parts.push(SExpression::Literal(Literal::String(literal)));
  let source = if parts.len() == 1 {
    parts.pop().unwrap()
  } else {
    call("str.concat", parts, interner)
  };
  Ok(call("std.sh.arith", vec![source], interner))
}

#[derive(Clone, Debug)]
enum Expr {
  Number(i64),
  /// A name, or `name[subscript]` with the subscript's own expression.
  Variable(String, Option<String>),
  Unary(String, Box<Expr>),
  /// The operator, its operands, the offset just past the operator and the
  /// lookahead after the right operand: bash reports an evaluation error at
  /// one of them.
  Binary(String, Box<Expr>, Box<Expr>, (usize, usize)),
  Conditional(Box<Expr>, Box<Expr>, Box<Expr>),
  Postfix(String, Box<Expr>),
}

const OPERATORS: &[&str] = &[
  "<<=", ">>=", "**", "++", "--", "*=", "/=", "%=", "+=", "-=", "<<", ">>", "<=", ">=", "==", "!=",
  "&&", "||", "&=", "^=", "|=", "+", "-", "*", "/", "%", "<", ">", "&", "^", "|", "!", "~", "=",
  "?", ":", ",", "(", ")",
];

/// An expression error as bash reports it: the expression, the message and,
/// when there is one, the source from the token where bash stopped.
fn error(source: &str, message: &str, at: usize) -> String {
  let token = source.get(at..).unwrap_or("");
  if token.is_empty() {
    format!("{}: {message}", source.trim_start())
  } else {
    format!("{}: {message} (error token is \"{token}\")", source.trim_start())
  }
}

/// Tokens with their byte offsets in `source`. `name[subscript]` is one
/// token; its subscript is an expression of its own.
fn tokens(source: &str) -> Result<Vec<(String, usize)>, String> {
  let mut result = Vec::new();
  let mut at = source.len() - source.trim_start().len();
  while at < source.len() {
    let rest = &source[at..];
    if let Some(word) = rest.strip_prefix("${") {
      let end = word.find('}').ok_or_else(|| error(source, "bad substitution", at))?;
      result.push((word[..end].to_string(), at));
      at += 2 + end + 1;
    } else if rest.starts_with('$') {
      at += 1;
      continue;
    } else {
      let end = rest
        .bytes()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'#' | b'@'))
        .count();
      if end > 0 {
        let mut end = end;
        if super::compound::identifier(&rest[..end]) && rest[end..].starts_with('[') {
          let mut depth = 0;
          let close = rest[end..].char_indices().find(|(_, c)| {
            match c {
              '[' => depth += 1,
              ']' => depth -= 1,
              _ => {}
            }
            depth == 0
          });
          let Some((close, _)) = close else {
            return Err(error(source, "missing `]'", at));
          };
          end += close + 1;
        }
        result.push((rest[..end].into(), at));
        at += end;
      } else if let Some(op) = OPERATORS.iter().find(|op| rest.starts_with(**op)) {
        result.push(((*op).into(), at));
        at += op.len();
      } else {
        let message = "arithmetic syntax error: invalid arithmetic operator";
        return Err(error(source, message, at));
      }
    }
    at = source.len() - source[at..].trim_start().len();
  }
  Ok(result)
}

fn number(source: &str, word: &str, at: usize) -> Result<i64, String> {
  let (base, digits) = if let Some((base, digits)) = word.split_once('#') {
    let base = base.parse::<u32>().ok().filter(|base| (2..=64).contains(base));
    (base.ok_or_else(|| error(source, "invalid arithmetic base", at))?, digits)
  } else if word.starts_with("0x") || word.starts_with("0X") {
    (16, &word[2..])
  } else if word.len() > 1 && word.starts_with('0') {
    (8, &word[1..])
  } else {
    (10, word)
  };
  if digits.is_empty() {
    // `0x` is 0, as in bash; `2#` has no digits.
    return if base == 16 { Ok(0) } else { Err(error(source, "invalid integer constant", at)) };
  }
  let mut value = 0i64;
  for c in digits.bytes() {
    let digit = match c {
      b'0'..=b'9' => u32::from(c - b'0'),
      b'a'..=b'z' => u32::from(c - b'a') + 10,
      b'A'..=b'Z' => u32::from(c - b'A') + if base <= 36 { 10 } else { 36 },
      b'@' => 62,
      b'_' => 63,
      _ => base,
    };
    if digit >= base {
      return Err(error(source, "value too great for base", at));
    }
    value = value
      .wrapping_mul(i64::from(base))
      .wrapping_add(i64::from(digit));
  }
  Ok(value)
}

fn binding(op: &str) -> Option<(u8, u8)> {
  Some(match op {
    "," => (1, 2),
    "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "<<=" | ">>=" | "&=" | "^=" | "|=" => (2, 2),
    "?" => (3, 3),
    "||" => (4, 5),
    "&&" => (5, 6),
    "|" => (6, 7),
    "^" => (7, 8),
    "&" => (8, 9),
    "==" | "!=" => (9, 10),
    "<" | "<=" | ">" | ">=" => (10, 11),
    "<<" | ">>" => (11, 12),
    "+" | "-" => (12, 13),
    "*" | "/" | "%" => (13, 14),
    "**" => (15, 15),
    _ => return None,
  })
}

struct Parser<'a> {
  source: &'a str,
  tokens: Vec<(String, usize)>,
  pos: usize,
}
impl Parser<'_> {
  fn peek(&self) -> &str {
    self.tokens.get(self.pos).map_or("", |(token, _)| token.as_str())
  }
  /// Where bash's last-read token starts: the lookahead, or at the end the
  /// last token.
  fn last(&self) -> usize {
    self.tokens.get(self.pos.min(self.tokens.len().saturating_sub(1))).map_or(self.source.len(), |(_, at)| *at)
  }
  fn fail(&self, message: &str, at: usize) -> String {
    error(self.source, message, at)
  }
  fn eat(&mut self, token: &str) -> bool {
    if self.peek() == token {
      self.pos += 1;
      true
    } else {
      false
    }
  }
  fn expr(&mut self, min: u8, depth: usize) -> Result<Expr, String> {
    if depth > 256 {
      return Err(self.fail("expression recursion level exceeded", self.last()));
    }
    let at = self.last();
    let token = self.peek().to_string();
    self.pos += 1;
    let mut left = match token.as_str() {
      "(" => {
        let value = self.expr(1, depth + 1)?;
        if !self.eat(")") {
          return Err(self.fail("missing `)'", self.last()));
        }
        value
      }
      "+" | "-" | "!" | "~" | "++" | "--" => {
        Expr::Unary(token, Box::new(self.expr(16, depth + 1)?))
      }
      _ if token.as_bytes().first().is_some_and(u8::is_ascii_digit) => {
        Expr::Number(number(self.source, &token, at)?)
      }
      _ if super::compound::identifier(&token) => Expr::Variable(token, None),
      _ if token.ends_with(']') && token.split_once('[').is_some_and(|(name, _)| super::compound::identifier(name)) => {
        let (name, subscript) = token.split_once('[').unwrap();
        let subscript = &subscript[..subscript.len() - 1];
        parse(subscript)?;
        Expr::Variable(name.into(), Some(subscript.into()))
      }
      _ => return Err(self.fail("arithmetic syntax error: operand expected", at)),
    };
    loop {
      if matches!(self.peek(), "++" | "--") {
        let op = self.peek().to_string();
        self.pos += 1;
        left = Expr::Postfix(op, Box::new(left));
        continue;
      }
      let Some((lb, rb)) = binding(self.peek()) else {
        break;
      };
      if lb < min {
        break;
      }
      let op_at = self.last();
      let op = self.peek().to_string();
      self.pos += 1;
      if op == "?" {
        let yes = self.expr(1, depth + 1)?;
        if !self.eat(":") {
          return Err(self.fail("`:' expected for conditional expression", self.last()));
        }
        let no = self.expr(rb, depth + 1)?;
        left = Expr::Conditional(Box::new(left), Box::new(yes), Box::new(no));
      } else {
        if op.ends_with('=')
          && !matches!(op.as_str(), "==" | "!=" | "<=" | ">=")
          && !matches!(left, Expr::Variable(..))
        {
          return Err(self.fail("attempted assignment to non-variable", op_at));
        }
        let right = self.expr(rb, depth + 1)?;
        left = Expr::Binary(op.clone(), Box::new(left), Box::new(right), (op_at + op.len(), self.last()));
      }
    }
    Ok(left)
  }
}

fn parse(source: &str) -> Result<Expr, String> {
  let mut parser = Parser {
    source,
    tokens: tokens(source)?,
    pos: 0,
  };
  if parser.tokens.is_empty() {
    return Ok(Expr::Number(0));
  }
  let result = parser.expr(1, 0)?;
  if parser.pos != parser.tokens.len() {
    return Err(parser.fail("arithmetic syntax error in expression", parser.last()));
  }
  Ok(result)
}

pub fn validate(source: &str) -> Result<(), String> {
  parse(source).map(|_| ())
}

pub fn variable_names(source: &str) -> Vec<String> {
  source
    .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
    .filter(|name| super::compound::identifier(name))
    .map(str::to_string)
    .collect()
}

/// A binary operator's value; `Err` carries the message without its source.
fn binary(op: &str, a: i64, b: i64) -> Result<i64, &'static str> {
  Ok(match op {
    "+" => a.wrapping_add(b),
    "-" => a.wrapping_sub(b),
    "*" => a.wrapping_mul(b),
    "/" | "%" if b == 0 => return Err("division by 0"),
    "/" => a.wrapping_div(b),
    "%" => a.wrapping_rem(b),
    "**" => {
      if b < 0 {
        return Err("exponent less than 0");
      }
      let mut result = 1i64;
      let mut base = a;
      let mut exponent = b as u64;
      while exponent > 0 {
        if exponent & 1 != 0 {
          result = result.wrapping_mul(base);
        }
        base = base.wrapping_mul(base);
        exponent >>= 1;
      }
      result
    }
    "<<" => a.wrapping_shl(b as u32),
    ">>" => a.wrapping_shr(b as u32),
    "&" => a & b,
    "^" => a ^ b,
    "|" => a | b,
    "<" => i64::from(a < b),
    "<=" => i64::from(a <= b),
    ">" => i64::from(a > b),
    ">=" => i64::from(a >= b),
    "==" => i64::from(a == b),
    "!=" => i64::from(a != b),
    "&&" => i64::from(a != 0 && b != 0),
    "||" => i64::from(a != 0 || b != 0),
    "," => b,
    _ => return Err("arithmetic syntax error: invalid arithmetic operator"),
  })
}

/// The variable `access` reads and writes: `name`, or `name[index]` with
/// the subscript evaluated.
fn place<F>(name: &str, subscript: &Option<String>, access: &mut F, depth: usize) -> Result<String, String>
where
  F: FnMut(&str, Option<i64>) -> Result<Option<String>, String>,
{
  Ok(match subscript {
    Some(subscript) => format!("{name}[{}]", eval(&parse(subscript)?, subscript, access, depth + 1)?),
    None => name.to_string(),
  })
}

fn eval<F>(expr: &Expr, source: &str, access: &mut F, depth: usize) -> Result<i64, String>
where
  F: FnMut(&str, Option<i64>) -> Result<Option<String>, String>,
{
  if depth > 256 {
    return Err(error(source, "expression recursion level exceeded", source.len()));
  }
  Ok(match expr {
    Expr::Number(value) => *value,
    Expr::Variable(name, subscript) => {
      let name = place(name, subscript, access, depth)?;
      let value = access(&name, None)?.unwrap_or_default();
      if value.trim().is_empty() {
        0
      } else {
        eval(&parse(&value)?, &value, access, depth + 1)?
      }
    }
    Expr::Unary(op, value) | Expr::Postfix(op, value) if matches!(op.as_str(), "++" | "--") => {
      let Expr::Variable(name, subscript) = value.as_ref() else {
        return Err(error(source, "assignment requires a variable", source.len()));
      };
      let name = place(name, subscript, access, depth)?;
      let current = access(&name, None)?.unwrap_or_default();
      let before = if current.trim().is_empty() { 0 } else { eval(&parse(&current)?, &current, access, depth + 1)? };
      let after = if op == "++" {
        before.wrapping_add(1)
      } else {
        before.wrapping_sub(1)
      };
      access(&name, Some(after))?;
      if matches!(expr, Expr::Postfix(_, _)) {
        before
      } else {
        after
      }
    }
    Expr::Unary(op, value) => {
      let value = eval(value, source, access, depth + 1)?;
      match op.as_str() {
        "+" => value,
        "-" => value.wrapping_neg(),
        "!" => i64::from(value == 0),
        "~" => !value,
        _ => unreachable!(),
      }
    }
    Expr::Binary(op, left, right, (op_end, after)) => {
      let assignment = op.ends_with('=') && !matches!(op.as_str(), "==" | "!=" | "<=" | ">=");
      let a = if op == "=" {
        0
      } else {
        eval(left, source, access, depth + 1)?
      };
      if op == "&&" && a == 0 {
        return Ok(0);
      }
      if op == "||" && a != 0 {
        return Ok(1);
      }
      let b = eval(right, source, access, depth + 1)?;
      let operator = if assignment && op != "=" { &op[..op.len() - 1] } else { op.as_str() };
      // Division reports the divisor's text; other errors bash's lookahead.
      let value = if op == "=" { Ok(b) } else { binary(operator, a, b) };
      let value = value.map_err(|message| {
        let at = if message == "division by 0" {
          source.len() - source[*op_end..].trim_start().len()
        } else {
          *after
        };
        error(source, message, at)
      })?;
      if assignment {
        let Expr::Variable(name, subscript) = left.as_ref() else {
          return Err(error(source, "attempted assignment to non-variable", *op_end));
        };
        let name = place(name, subscript, access, depth)?;
        access(&name, Some(value))?;
      }
      value
    }
    Expr::Conditional(condition, yes, no) => {
      if eval(condition, source, access, depth + 1)? != 0 {
        eval(yes, source, access, depth + 1)?
      } else {
        eval(no, source, access, depth + 1)?
      }
    }
    Expr::Postfix(_, _) => unreachable!(),
  })
}

/// Access is one scoped variable door: None reads; Some(value) assigns. A
/// name may be `name[index]`. An error is bash's whole message, starting
/// with the expression; an access error passes through unchanged.
pub fn evaluate<F>(source: &str, access: &mut F) -> Result<i64, String>
where
  F: FnMut(&str, Option<i64>) -> Result<Option<String>, String>,
{
  eval(&parse(source)?, source, access, 0)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;

  #[test]
  fn bash_arithmetic_operator_table() {
    let mut vars = HashMap::new();
    for (source, expected) in [
      ("1+2*3", 7),
      ("2**3**2", 512),
      ("-2**2", 4),
      ("0x10 + 010 + 2#11 + 64#_", 90),
      ("7/2", 3),
      ("7%3", 1),
      ("1<<4 | 3", 19),
      ("~0", -1),
      ("!5", 0),
      ("3>2 && 1<=1", 1),
      ("3==3 ? 11 : 1/0", 11),
      ("0 && 1/0", 0),
      ("1 || 1/0", 1),
      ("x=2, x+=3, x++", 5),
      ("++x", 7),
      ("x*=2", 14),
      ("x>>=1", 7),
      ("x^=3", 4),
      ("x--", 4),
      ("x", 3),
      ("x=9, x-=2", 7),
      ("x/=2", 3),
      ("x%=2", 1),
      ("x<<=3", 8),
      ("x|=3", 11),
      ("x&=6", 2),
      ("x^=7", 5),
      ("x--", 5),
      ("--x", 3),
      ("+3", 3),
      ("1&3", 1),
      ("5^3", 6),
      ("8>>2", 2),
      ("1<2", 1),
      ("1>=2", 0),
      ("1!=2", 1),
      ("0 ? 1/0 : 12", 12),
      ("0 || (x=1)", 1),
      ("16#ff", 255),
      ("9223372036854775807+1", i64::MIN),
    ] {
      assert_eq!(
        evaluate(source, &mut |name, value| {
          if let Some(value) = value {
            vars.insert(name.to_string(), value.to_string());
          }
          Ok(vars.get(name).cloned())
        })
        .unwrap(),
        expected,
        "{source}"
      );
    }
    assert!(
      evaluate("1/0", &mut |_, _| Ok(None))
        .unwrap_err()
        .contains("division by 0")
    );
    assert!(validate("lambda () 1").is_err());
    assert!(validate("x =").is_err());
  }

  #[test]
  fn bash_arithmetic_errors_name_bash_error_token() {
    // bash 5.3: the expression, the message and the source from the token
    // where it stopped (the divisor for a division).
    for (source, message) in [
      ("1/0", "1/0: division by 0 (error token is \"0\")"),
      (" 1 / 0 + 2 ", "1 / 0 + 2 : division by 0 (error token is \"0 + 2 \")"),
      ("2 ** -1 + 3", "2 ** -1 + 3: exponent less than 0 (error token is \"+ 3\")"),
      ("1 2", "1 2: arithmetic syntax error in expression (error token is \"2\")"),
      ("3 +* 4", "3 +* 4: arithmetic syntax error: operand expected (error token is \"* 4\")"),
      ("1 = 2", "1 = 2: attempted assignment to non-variable (error token is \"= 2\")"),
      ("08", "08: value too great for base (error token is \"08\")"),
      ("99#1", "99#1: invalid arithmetic base (error token is \"99#1\")"),
      ("1 ? 2", "1 ? 2: `:' expected for conditional expression (error token is \"2\")"),
    ] {
      assert_eq!(evaluate(source, &mut |_, _| Ok(None)).unwrap_err(), message, "{source:?}");
    }
    // A variable's own expression is the one bash names.
    let mut access = |_: &str, _: Option<i64>| Ok(Some("1/0".to_string()));
    assert_eq!(evaluate("n", &mut access).unwrap_err(), "1/0: division by 0 (error token is \"0\")");
    assert_eq!(evaluate("0x", &mut |_, _| Ok(None)).unwrap(), 0);
  }

  #[test]
  fn bash_arithmetic_subscripts_reach_access_evaluated() {
    let mut vars = HashMap::from([("i".to_string(), "1".to_string()), ("a[2]".to_string(), "7".to_string())]);
    let mut access = |name: &str, value: Option<i64>| {
      if let Some(value) = value {
        vars.insert(name.to_string(), value.to_string());
      }
      Ok(vars.get(name).cloned())
    };
    assert_eq!(evaluate("a[i+1] * 2", &mut access).unwrap(), 14);
    assert_eq!(evaluate("a[0] = 9, a[0] += 1", &mut access).unwrap(), 10);
    assert!(validate("a[1] + a[2]").is_ok());
    assert!(validate("a[1").is_err());
  }

  #[test]
  fn bash_arithmetic_recursive_variables_and_dead_assignments() {
    let mut vars = HashMap::from([
      ("a".to_string(), "b+2".to_string()),
      ("b".to_string(), "3".to_string()),
    ]);
    let mut access = |name: &str, value: Option<i64>| {
      if let Some(value) = value {
        vars.insert(name.to_string(), value.to_string());
      }
      Ok(vars.get(name).cloned())
    };
    assert_eq!(evaluate("a", &mut access).unwrap(), 5);
    assert_eq!(evaluate("0 ? (b=10) : b", &mut access).unwrap(), 3);
    assert_eq!(evaluate("b", &mut access).unwrap(), 3);
  }
}
