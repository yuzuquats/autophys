//! `[[` has its own word context: expansion without splitting or globbing.
use super::*;

pub(super) fn end(chars: &[char], start: usize) -> Result<usize, PosixReadError> {
  let mut i = start + 2;
  while i < chars.len() {
    if let Some(end) = redirection::protected_end(chars, i)? {
      i = end;
      continue;
    }
    if chars[i] == ']' && chars.get(i + 1) == Some(&']') {
      return Ok(i + 2);
    }
    i += 1;
  }
  Err(PosixReadError::IncompleteCompound("]]".into()))
}

fn tokens(source: &str) -> Result<Vec<String>, PosixReadError> {
  let chars: Vec<_> = source.chars().collect();
  let mut words: Vec<String> = Vec::new();
  let mut i = 0;
  while i < chars.len() {
    if chars[i].is_whitespace() {
      i += 1;
      continue;
    }
    let start = i;
    let regex = words.last().is_some_and(|word| word == "=~");
    if !regex && matches!(chars[i], '(' | ')') {
      i += 1;
    } else {
      while i < chars.len() {
        if let Some(end) = redirection::protected_end(&chars, i)? {
          i = end;
          continue;
        }
        if chars[i].is_whitespace() || !regex && matches!(chars[i], '(' | ')') {
          break;
        }
        i += 1;
      }
    }
    words.push(chars[start..i].iter().collect());
  }
  Ok(words)
}

pub(super) fn read<S, B>(
  source: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<Option<SExpression<S>>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let source = source.trim();
  if !source.starts_with("[[") || !source[2..].starts_with(char::is_whitespace) {
    return Ok(None);
  }
  let chars: Vec<_> = source.chars().collect();
  let end = end(&chars, 0)?;
  if chars[end..].iter().any(|c| !c.is_whitespace()) {
    return Ok(None);
  }
  let body: String = chars[2..end - 2].iter().collect();
  let words = tokens(&body)?;
  let mut parser = Parser {
    words,
    pos: 0,
    interner,
    home,
    _symbol: std::marker::PhantomData,
  };
  let result = parser.or()?;
  if parser.pos != parser.words.len() {
    return Err(parser.error());
  }
  Ok(Some(call(
    "std.sh.condition",
    vec![result],
    parser.interner,
  )))
}

struct Parser<'a, S: Symbol, B: Backend<S>> {
  words: Vec<String>,
  pos: usize,
  interner: &'a mut StringInterner<B>,
  home: Option<&'a str>,
  _symbol: std::marker::PhantomData<S>,
}
impl<S: Symbol, B: Backend<S>> Parser<'_, S, B> {
  fn peek(&self) -> &str {
    self.words.get(self.pos).map_or("", String::as_str)
  }
  fn error(&self) -> PosixReadError {
    PosixReadError::ShellOperatorUnsupported(format!("[[ unexpected `{}`", self.peek()))
  }
  fn or(&mut self) -> Result<SExpression<S>, PosixReadError> {
    let mut value = self.and()?;
    while self.peek() == "||" {
      self.pos += 1;
      let rhs = self.and()?;
      value = call("std.sh.or", vec![value, rhs], self.interner);
    }
    Ok(value)
  }
  fn and(&mut self) -> Result<SExpression<S>, PosixReadError> {
    let mut value = self.term()?;
    while self.peek() == "&&" {
      self.pos += 1;
      let rhs = self.term()?;
      value = call("std.sh.and", vec![value, rhs], self.interner);
    }
    Ok(value)
  }
  fn word(&mut self, pattern: bool) -> Result<SExpression<S>, PosixReadError> {
    if self.pos == self.words.len() {
      return Err(self.error());
    }
    let raw = self.words[self.pos].clone();
    self.pos += 1;
    let parts = redirection::word_parts(&raw, self.interner, self.home)?;
    if pattern {
      let pairs = parts
        .into_iter()
        .map(|(value, _, active)| {
          call(
            "list",
            vec![value, SExpression::Literal(Literal::Boolean(active))],
            self.interner,
          )
        })
        .collect();
      Ok(call("list", pairs, self.interner))
    } else {
      Ok(call(
        "str.concat",
        parts
          .into_iter()
          .map(|(value, _, _)| call("std.sh.scalar", vec![value], self.interner))
          .collect(),
        self.interner,
      ))
    }
  }
  fn term(&mut self) -> Result<SExpression<S>, PosixReadError> {
    if self.peek() == "!" {
      self.pos += 1;
      let value = self.term()?;
      return Ok(call("std.sh.not", vec![value], self.interner));
    }
    if self.peek() == "(" {
      self.pos += 1;
      let value = self.or()?;
      if self.peek() != ")" {
        return Err(self.error());
      }
      self.pos += 1;
      return Ok(value);
    }
    let op = self.peek().to_string();
    if matches!(
      op.as_str(),
      "-z"
        | "-n"
        | "-e"
        | "-a"
        | "-f"
        | "-d"
        | "-L"
        | "-h"
        | "-s"
        | "-r"
        | "-w"
        | "-x"
        | "-b"
        | "-c"
        | "-p"
        | "-S"
        | "-t"
        | "-O"
        | "-G"
        | "-u"
        | "-g"
        | "-k"
        | "-v"
        | "-o"
        | "-R"
        | "-N"
    ) {
      self.pos += 1;
      let value = self.word(false)?;
      return Ok(call(
        "std.sh.test",
        vec![SExpression::Literal(Literal::String(op)), value],
        self.interner,
      ));
    }
    let left = self.word(false)?;
    let op = self.peek().to_string();
    let args = if matches!(
      op.as_str(),
      "="
        | "=="
        | "!="
        | "=~"
        | "<"
        | ">"
        | "-eq"
        | "-ne"
        | "-lt"
        | "-le"
        | "-gt"
        | "-ge"
        | "-nt"
        | "-ot"
        | "-ef"
    ) {
      self.pos += 1;
      let right = self.word(matches!(op.as_str(), "=" | "==" | "!=" | "=~"))?;
      vec![SExpression::Literal(Literal::String(op)), left, right]
    } else {
      vec![SExpression::Literal(Literal::String("-n".into())), left]
    };
    Ok(call("std.sh.test", args, self.interner))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use string_interner::{backend::StringBackend, symbol::SymbolU32};
  #[test]
  fn double_bracket_reader_keeps_condition_operators_and_quoted_patterns() {
    for source in [
      "[[ $x == a* && ( -n $x || -z x ) ]]",
      "[[ abc =~ (b.) ]]",
      "if [[ $x > a ]]; then echo yes; fi",
      // bash's option, nameref and modified-since-read primaries.
      "[[ -o errexit ]]",
      "[[ -R r && ! -N file ]]",
    ] {
      let mut interner = StringInterner::<StringBackend>::new();
      assert!(
        read_statement::<SymbolU32, _>(source, &mut interner).is_ok(),
        "{source}"
      );
    }
  }
}
