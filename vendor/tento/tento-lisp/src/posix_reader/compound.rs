//! Command-position grammar. Word decoding and expansion remain in the word reader.
use super::*;

#[derive(Debug)]
pub(super) struct Token {
  pub(super) text: String,
  pub(super) start: usize,
  pub(super) end: usize,
}

pub(super) fn lex(source: &str) -> Result<Vec<Token>, PosixReadError> {
  let chars: Vec<char> = source.chars().collect();
  let mut tokens = Vec::new();
  let mut i = 0;
  while i < chars.len() {
    if chars[i].is_whitespace() && chars[i] != '\n' {
      i += 1;
      continue;
    }
    if chars[i] == '#' {
      while i < chars.len() && chars[i] != '\n' {
        i += 1;
      }
      continue;
    }
    let start = i;
    if chars[i] == '[' && chars.get(i + 1) == Some(&'[')
      && chars.get(i + 2).is_none_or(|c| c.is_whitespace()) {
      i = condition::end(&chars, i)?;
      tokens.push(Token { text: chars[start..i].iter().collect(), start, end: i });
      continue;
    }
    if chars[i] == '(' && chars.get(i + 1) == Some(&'(') {
      i = scan_balanced(&chars, i + 1)? + 1;
    } else if matches!(chars[i], ';' | '|' | '&' | '(' | ')' | '\n')
      && !(chars[i] == '&' && chars.get(i + 1) == Some(&'>'))
    {
      i += 1;
      if matches!(chars[start], ';' | '|' | '&') && chars.get(i) == Some(&chars[start]) {
        i += 1;
        if chars[start] == ';' && chars.get(i) == Some(&'&') {
          i += 1;
        }
      } else if matches!(chars[start], ';' | '|') && chars.get(i) == Some(&'&') {
        i += 1;
      }
    } else {
      while i < chars.len() {
        if let Some(end) = redirection::protected_end(&chars, i)? {
          i = end;
          continue;
        }
        if chars[i] == '(' {
          let prefix: String = chars[start..i].iter().collect();
          if prefix.strip_suffix('=').is_some_and(|name| identifier(name.strip_suffix('+').unwrap_or(name))) {
            i = scan_balanced(&chars, i + 1)? + 1;
            continue;
          }
        }
        if chars[i].is_whitespace()
          || matches!(chars[i], ';' | '(' | ')')
          || chars[i] == '|' && !(i > start && chars[i - 1] == '>')
        {
          break;
        }
        if i > start
          && (matches!(chars[i], '<' | '>')
            || chars[i] == '&' && chars.get(i + 1) == Some(&'>'))
          && matches!(
            chars[start..i].iter().collect::<String>().as_str(),
            "fi" | "done" | "esac" | "}"
          )
        {
          break;
        }
        if chars[i] == '&'
          && !(i > start && matches!(chars[i - 1], '<' | '>'))
          && chars.get(i + 1) != Some(&'>')
        {
          break;
        }
        i += 1;
      }
    }
    if i == start {
      return Err(PosixReadError::ShellOperatorUnsupported(
        chars[i].to_string(),
      ));
    }
    tokens.push(Token {
      text: chars[start..i].iter().collect(),
      start,
      end: i,
    });
  }
  Ok(tokens)
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
  read_with_lines(source, interner, home, &[], &[])
}

/// [`read`] with the host's function names, on heredoc-prepared text whose `folds` (see
/// `redirection::heredocs_eof_lines`) say where bodies were lifted out.
///
/// A list member that starts on a later physical line than its enclosing
/// command is wrapped in `(std.sh.line DELTA member)`: DELTA is the line
/// distance from the enclosing command (or the chunk's first line), so the
/// marker needs no knowledge of where the chunk sits in its file and a
/// stored function body stays relative to its definition line.
pub(super) fn read_with_lines<S, B>(
  source: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
  functions: &[String],
  folds: &[(usize, isize)],
) -> Result<Option<SExpression<S>>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let mut joined = Vec::new();
  let normalized: String = bash_line_chars_tracking(source, Some(&mut joined))?.into_iter().collect();
  let source = normalized.as_str();
  let tokens = lex(source)?;
  let mut position = true;
  let mut needed = false;
  for (i, token) in tokens.iter().enumerate() {
    if position
      && (matches!(
        token.text.as_str(),
        "if" | "for" | "while" | "until" | "case" | "{" | "function" | "(" | "select" | "time"
      ) || token.text.starts_with("((") || functions.contains(&token.text)
        || tokens.get(i + 1).is_some_and(|t| t.text == "(")
          && tokens.get(i + 2).is_some_and(|t| t.text == ")"))
    {
      needed = true;
      break;
    }
    position = position && split_assignment(&token.text).is_some()
      || matches!(token.text.as_str(), ";" | "\n" | "&" | "&&" | "||" | "|" | "|&" | "!");
  }
  // A command on a later line needs its line marker, so a multi-line list
  // (an `eval` string, a sourced file) takes this parser too.
  needed = needed || tokens.windows(2).any(|pair| pair[0].text == "\n" && pair[1].text != "\n");
  if !needed {
    return Ok(None);
  }
  let chars: Vec<char> = source.chars().collect();
  let physical = physical_lines(&chars, &joined, folds);
  let mut parser = Parser {
    tokens,
    chars,
    physical,
    base: 0,
    pos: 0,
    functions: functions.iter().cloned().collect(),
    symbol: std::marker::PhantomData,
    interner,
    home,
  };
  let result = parser.list(&[])?;
  if parser.pos != parser.tokens.len() {
    return Err(parser.unexpected());
  }
  Ok(Some(result))
}

/// The physical line (0-based, within the chunk) of every normalized char,
/// and one past the end: newlines seen, continuations joined before it and
/// heredoc lines folded before its place in the prepared text.
fn physical_lines(chars: &[char], joined: &[usize], folds: &[(usize, isize)]) -> Vec<usize> {
  let mut lines = Vec::with_capacity(chars.len() + 1);
  let (mut line, mut join, mut fold) = (0isize, 0, 0);
  for index in 0..=chars.len() {
    while joined.get(join).is_some_and(|at| *at <= index) {
      join += 1;
      line += 1;
    }
    // The prepared index: each joined continuation removed two chars.
    let prepared = index + 2 * join;
    while folds.get(fold).is_some_and(|(at, _)| *at <= prepared) {
      line += folds[fold].1;
      fold += 1;
    }
    lines.push(line.max(0) as usize);
    if chars.get(index) == Some(&'\n') { line += 1; }
  }
  lines
}

struct Parser<'a, S: Symbol, B: Backend<S>> {
  tokens: Vec<Token>,
  /// [`physical_lines`] of `chars`.
  physical: Vec<usize>,
  /// The physical line of the innermost enclosing marked command.
  base: usize,
  symbol: std::marker::PhantomData<S>,
  functions: std::collections::HashSet<String>,
  chars: Vec<char>,
  pos: usize,
  interner: &'a mut StringInterner<B>,
  home: Option<&'a str>,
}
impl<S: Symbol, B: Backend<S>> Parser<'_, S, B> {
  fn peek(&self) -> &str {
    self.tokens.get(self.pos).map_or("", |t| t.text.as_str())
  }
  fn eat(&mut self, word: &str) -> bool {
    if self.peek() == word {
      self.pos += 1;
      true
    } else {
      false
    }
  }
  fn unexpected(&self) -> PosixReadError {
    PosixReadError::UnexpectedToken(self.peek().to_string())
  }
  fn expect(&mut self, word: &str) -> Result<(), PosixReadError> {
    if self.eat(word) {
      Ok(())
    } else if self.pos == self.tokens.len() {
      Err(PosixReadError::IncompleteCompound(word.into()))
    } else {
      Err(self.unexpected())
    }
  }
  fn lines(&mut self) {
    while self.eat("\n") {}
  }
  fn separators(&mut self) {
    while matches!(self.peek(), ";" | "\n") {
      self.pos += 1;
    }
  }
  fn form(&mut self, name: &str, args: Vec<SExpression<S>>) -> SExpression<S> {
    call(name, args, self.interner)
  }
  fn text(value: &str) -> SExpression<S> {
    SExpression::Literal(Literal::String(value.into()))
  }
  fn list(&mut self, stops: &[&str]) -> Result<SExpression<S>, PosixReadError> {
    self.lines();
    let mut stages = Vec::new();
    while self.pos < self.tokens.len() && !stops.contains(&self.peek()) {
      let line = self.physical[self.tokens[self.pos].start];
      let outer = std::mem::replace(&mut self.base, line);
      let left = self.and_or();
      self.base = outer;
      let mut left = left?;
      let background = self.eat("&");
      if background { left = self.form(super::SPAWN_FORM, vec![left]); }
      if line != outer {
        left = self.form("std.sh.line", vec![SExpression::Literal(Literal::Integer(line as i64 - outer as i64)), left]);
      }
      stages.push(left);
      if background { self.lines(); continue; }
      if matches!(self.peek(), ";" | "\n") {
        self.separators();
      } else {
        break;
      }
    }
    if stages.is_empty()
      && !self.peek().is_empty()
      && stops.contains(&self.peek())
      && !stops
        .iter()
        .any(|stop| matches!(*stop, ";;" | ";&" | ";;&"))
    {
      return Err(PosixReadError::ShellOperatorUnsupported(format!(
        "empty list before {}",
        self.peek()
      )));
    }
    Ok(if stages.len() == 1 {
      stages.pop().unwrap()
    } else {
      self.form("std.sh.seq", stages)
    })
  }
  fn and_or(&mut self) -> Result<SExpression<S>, PosixReadError> {
    let mut left = self.pipeline()?;
    while matches!(self.peek(), "&&" | "||") {
      let and = self.eat("&&");
      if !and {
        self.expect("||")?;
      }
      self.lines();
      // An operator at the end of the input waits for more lines, as in
      // the flow reader (a multi-line `-c` or stdin list reads here).
      if self.pos == self.tokens.len() {
        return Err(PosixReadError::MissingFlowOperand(if and { "&&" } else { "||" }));
      }
      let right = self.pipeline()?;
      left = self.form(
        if and { "std.sh.and" } else { "std.sh.or" },
        vec![left, right],
      );
    }
    Ok(left)
  }
  fn pipeline(&mut self) -> Result<SExpression<S>, PosixReadError> {
    // `time [-p]` and `!` prefix a pipeline in either order (bash's
    // pipeline_command); a bare `time` before a list terminator times nothing.
    if self.eat("time") {
      let posix = self.eat("-p");
      let timed = if matches!(self.peek(), "" | ";" | "\n") {
        self.form("std.sh.seq", vec![])
      } else {
        self.pipeline()?
      };
      return Ok(self.form("std.sh.time", vec![SExpression::Literal(Literal::Boolean(posix)), timed]));
    }
    let mut negations = 0;
    while self.eat("!") {
      negations += 1;
      self.lines();
    }
    if negations > 0 && self.pos == self.tokens.len() {
      return Err(PosixReadError::MissingFlowOperand("!"));
    }
    if negations > 0 && self.peek() == "time" {
      let mut result = self.pipeline()?;
      for _ in 0..negations {
        result = self.form("std.sh.not", vec![result]);
      }
      return Ok(result);
    }
    self.lines();
    let mut stages = vec![self.command()?];
    while matches!(self.peek(), "|" | "|&") {
      let stderr = self.eat("|&");
      if !stderr { self.expect("|")?; }
      if stderr {
        let stage = stages.last_mut().unwrap();
        let spec = self.form("list", vec![SExpression::Literal(Literal::Integer(2)), Self::text(">&"), Self::text("1")]);
        if is_call(stage, "std.sh.redirect", self.interner) {
          if let SExpression::List(items) = stage {
            if let SExpression::List(specs) = &mut items[2] { specs.push(spec); }
          }
        } else {
          let specs = self.form("list", vec![spec]);
          *stage = self.form("std.sh.redirect", vec![stage.clone(), specs]);
        }
      }
      self.lines();
      if self.pos == self.tokens.len() {
        return Err(PosixReadError::MissingFlowOperand("|"));
      }
      stages.push(self.command()?);
    }
    let mut result = if stages.len() == 1 {
      stages.pop().unwrap()
    } else {
      self.form("std.sh.pipe", stages)
    };
    for _ in 0..negations {
      result = self.form("std.sh.not", vec![result]);
    }
    Ok(result)
  }
  fn command(&mut self) -> Result<SExpression<S>, PosixReadError> {
    let head = self.peek().to_string();
    let compound = match head.as_str() {
      "if" => {
        self.pos += 1;
        Some(self.conditional()?)
      }
      "while" | "until" => {
        self.pos += 1;
        let condition = self.list(&["do"])?;
        self.expect("do")?;
        let body = self.list(&["done"])?;
        self.expect("done")?;
        Some(self.form(
          "std.sh.while",
          vec![
            SExpression::Literal(Literal::Boolean(head == "until")),
            condition,
            body,
          ],
        ))
      }
      "for" | "select" => {
        self.pos += 1;
        Some(self.for_loop(head == "select")?)
      }
      "case" => {
        self.pos += 1;
        Some(self.case()?)
      }
      "{" => {
        self.pos += 1;
        let body = self.list(&["}"])?;
        self.expect("}")?;
        Some(self.form("std.sh.group", vec![body]))
      }
      "function" => {
        self.pos += 1;
        let name = self.peek().to_string();
        if !function_name(&name) {
          return Err(self.unexpected());
        }
        self.pos += 1;
        if self.eat("(") {
          self.expect(")")?;
        }
        self.lines();
        self.functions.insert(name.clone());
        let (body, source) = self.function_body_with_source()?;
        Some(self.form("std.sh.function", vec![Self::text(&name), body, Self::text(&source)]))
      }
      "(" => {
        self.pos += 1;
        let functions = self.functions.clone();
        let body = self.list(&[")"])?;
        self.expect(")")?;
        self.functions = functions;
        Some(self.form("std.sh.subshell", vec![body]))
      }
      _ if head.starts_with("((") => {
        self.pos += 1;
        let raw = head.strip_prefix("((").and_then(|s| s.strip_suffix("))"))
          .ok_or_else(|| self.unexpected())?;
        let expr = arith::lower(raw, self.interner, self.home)?;
        Some(self.form("std.sh.arithmetic", vec![expr]))
      }
      _ if function_name(&head) && self.tokens.get(self.pos + 1).is_some_and(|t| t.text == "(") => {
        self.pos += 2;
        self.expect(")")?;
        self.lines();
        self.functions.insert(head.clone());
        let (body, source) = self.function_body_with_source()?;
        Some(self.form("std.sh.function", vec![Self::text(&head), body, Self::text(&source)]))
      }
      _ => None,
    };
    if let Some(stage) = compound {
      return self.redirect(stage);
    }
    let start = self.pos;
    while self.pos < self.tokens.len()
      && !matches!(
        self.peek(),
        ";" | "\n" | "&&" | "||" | "|" | "|&" | ";;" | ";&" | ";;&" | "&" | "(" | ")"
      )
    {
      self.pos += 1;
    }
    if self.pos == start {
      // An operator where a command starts (`echo a` NEWLINE `| echo b`, a
      // stray `)`) is bash's syntax error naming that token; it is complete
      // input, never a continuation. Only the end of the input is missing
      // its command.
      return Err(if self.pos < self.tokens.len() {
        PosixReadError::UnexpectedToken(self.peek().to_string())
      } else {
        PosixReadError::MissingFlowOperand("command")
      });
    }
    let source: String = self.chars[self.tokens[start].start..self.tokens[self.pos - 1].end]
      .iter()
      .collect();
    let command_head = self.tokens[start..self.pos]
      .iter()
      .find(|word| split_assignment(&word.text).is_none())
      .map(|word| word.text.as_str())
      .unwrap_or(&head);
    let source = if self.functions.contains(command_head) {
      data_arguments(&source)?
    } else {
      source
    };
    read_simple_statement(&source, self.interner, self.home)
  }
  /// The body and its source text, kept so `declare -f` can print it.
  fn function_body_with_source(&mut self) -> Result<(SExpression<S>, String), PosixReadError> {
    let start = self.tokens.get(self.pos).map_or(self.chars.len(), |token| token.start);
    let body = self.function_body()?;
    let end = self.tokens.get(self.pos.wrapping_sub(1)).map_or(start, |token| token.end).max(start);
    Ok((body, self.chars[start..end].iter().collect()))
  }
  fn function_body(&mut self) -> Result<SExpression<S>, PosixReadError> {
    if self.peek().is_empty() {
      return Err(PosixReadError::IncompleteCompound("function body".into()));
    }
    if !matches!(self.peek(), "{" | "(" | "if" | "for" | "while" | "until" | "case") && !self.peek().starts_with("((") {
      return Err(self.unexpected());
    }
    self.command()
  }
  fn conditional(&mut self) -> Result<SExpression<S>, PosixReadError> {
    let condition = self.list(&["then"])?;
    self.expect("then")?;
    let yes = self.list(&["elif", "else", "fi"])?;
    let no = if self.eat("elif") {
      self.conditional()?
    } else {
      let no = if self.eat("else") {
        self.list(&["fi"])?
      } else {
        self.form("std.sh.seq", vec![])
      };
      self.expect("fi")?;
      no
    };
    Ok(self.form("std.sh.if", vec![condition, yes, no]))
  }
  fn word(&mut self, raw: &str) -> Result<SExpression<S>, PosixReadError> {
    let raw = if raw.starts_with("--") {
      format!("''{raw}")
    } else {
      raw.to_string()
    };
    let mut atoms = scan(&raw, self.interner, self.home)?;
    if atoms.len() != 1 {
      return Err(self.unexpected());
    }
    Ok(atom_to_value(atoms.remove(0), self.interner))
  }
  /// `for` (or `select` when `select`) after its keyword.
  fn for_loop(&mut self, select: bool) -> Result<SExpression<S>, PosixReadError> {
    if !select && self.peek().starts_with("((") {
      let header = self.peek().to_string();
      self.pos += 1;
      let raw = &header[2..header.len() - 2];
      let chars: Vec<_> = raw.chars().collect();
      let mut fields = Vec::new();
      let mut start = 0;
      let mut i = 0;
      while i < chars.len() {
        if let Some(end) = redirection::protected_end(&chars, i)? { i = end; continue; }
        if chars[i] == ';' {
          fields.push(chars[start..i].iter().collect::<String>());
          start = i + 1;
        }
        i += 1;
      }
      fields.push(chars[start..].iter().collect());
      if fields.len() != 3 { return Err(self.unexpected()); }
      let init = arith::lower(&fields[0], self.interner, self.home)?;
      let cond = arith::lower(if fields[1].trim().is_empty() { "1" } else { &fields[1] }, self.interner, self.home)?;
      let step = arith::lower(&fields[2], self.interner, self.home)?;
      self.separators();
      self.expect("do")?;
      let body = self.list(&["done"])?;
      self.expect("done")?;
      return Ok(self.form("std.sh.arithmetic-for", vec![init, cond, step, body]));
    }
    let name = self.peek().to_string();
    if !identifier(&name) {
      return Err(self.unexpected());
    }
    self.pos += 1;
    self.lines();
    // The words as written: `set -x` shows `for x in $(ls)` unexpanded.
    let mut written = "\"$@\"".to_string();
    let words = if self.eat("in") {
      let start = self.pos;
      while self.pos < self.tokens.len() && !matches!(self.peek(), ";" | "\n") {
        self.pos += 1;
      }
      written = self.tokens[start..self.pos].iter().map(|word| word.text.as_str()).collect::<Vec<_>>().join(" ");
      // These are data words, not command options. Empty quote prefixes
      // prevent the legacy option-to-keyword rule without quoting wildcards.
      let raw = self.tokens[start..self.pos]
        .iter()
        .map(|word| {
          if word.text.starts_with("--") {
            format!("''{}", word.text)
          } else {
            word.text.clone()
          }
        })
        .collect::<Vec<_>>()
        .join(" ");
      // The words ride the command reader behind a placeholder command name,
      // which is dropped: what is left is the list of fields.
      let expr = read_posix_with_home(&format!("__words {raw}"), self.interner, self.home)?;
      let SExpression::List(items) = expr else {
        unreachable!()
      };
      let words: Vec<_> = items.into_iter().skip(2).collect();
      if words.iter().any(|word| is_fields_word(word, self.interner)) {
        append_fields(words, self.interner)
      } else {
        self.form("list", words)
      }
    } else {
      self.form("std.sh.positional", vec![Self::text("@")])
    };
    self.separators();
    self.expect("do")?;
    let body = self.list(&["done"])?;
    self.expect("done")?;
    if select {
      return Ok(self.form("std.sh.select", vec![Self::text(&name), words, body]));
    }
    Ok(self.form("std.sh.for", vec![Self::text(&name), words, body, Self::text(&written)]))
  }
  fn case(&mut self) -> Result<SExpression<S>, PosixReadError> {
    let raw = self.peek().to_string();
    if raw.is_empty() {
      return Err(PosixReadError::IncompleteCompound("case word".into()));
    }
    self.pos += 1;
    let word = self.word(&raw)?;
    self.lines();
    self.expect("in")?;
    self.lines();
    let mut arms = Vec::new();
    while !self.eat("esac") {
      if self.peek().is_empty() {
        return Err(PosixReadError::IncompleteCompound("esac".into()));
      }
      self.eat("(");
      let mut patterns = Vec::new();
      loop {
        let raw = self.peek().to_string();
        self.pos += 1;
        let parts = redirection::word_parts(&raw, self.interner, self.home)?;
        let descriptors = parts
          .into_iter()
          .map(|(value, _, active)| {
            call(
              "list",
              vec![value, SExpression::Literal(Literal::Boolean(active))],
              self.interner,
            )
          })
          .collect();
        patterns.push(self.form("list", descriptors));
        if !self.eat("|") {
          break;
        }
      }
      self.expect(")")?;
      let body = self.list(&[";;", ";&", ";;&", "esac"])?;
      let ending = if matches!(self.peek(), ";;" | ";&" | ";;&") {
        let end = self.peek().to_string();
        self.pos += 1;
        end
      } else {
        ";;".into()
      };
      let patterns = self.form("list", patterns);
      arms.push(self.form("std.sh.arm", vec![patterns, body, Self::text(&ending)]));
      self.lines();
    }
    let mut args = vec![word];
    args.extend(arms);
    // The word as written, last: `set -x` shows `case $x in`, unexpanded.
    args.push(Self::text(&raw));
    Ok(self.form("std.sh.case", args))
  }
  fn redirect(&mut self, stage: SExpression<S>) -> Result<SExpression<S>, PosixReadError> {
    let start = self.pos;
    if !self.peek().contains('<') && !self.peek().contains('>') {
      return Ok(stage);
    }
    while self.pos < self.tokens.len()
      && !matches!(
        self.peek(),
        ";" | "\n" | "&&" | "||" | "|" | "|&" | "&" | ";;" | ";&" | ";;&" | ")"
      )
    {
      self.pos += 1;
    }
    let raw: String = self.chars[self.tokens[start].start..self.tokens[self.pos - 1].end]
      .iter()
      .collect();
    let mut wrapper = redirection::read(&format!(": {raw}"), self.interner, self.home)?
      .ok_or_else(|| self.unexpected())?;
    if let SExpression::List(items) = &mut wrapper {
      if matches!(items.first(), Some(SExpression::Literal(Literal::Symbol(s))) if self.interner.resolve(*s) == Some("std.sh.redirect"))
      {
        items[1] = stage;
        return Ok(wrapper);
      }
    }
    Err(self.unexpected())
  }
}

pub(super) fn identifier(name: &str) -> bool {
  !name.is_empty()
    && !name.as_bytes()[0].is_ascii_digit()
    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn function_name(name: &str) -> bool {
  !name.is_empty()
    && name
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

pub(super) fn data_arguments(source: &str) -> Result<String, PosixReadError> {
  Ok(
    lex(source)?
      .iter()
      .enumerate()
      .map(|(index, token)| {
        if index > 0 && token.text.starts_with("--") {
          format!("''{}", token.text)
        } else {
          token.text.clone()
        }
      })
      .collect::<Vec<_>>()
      .join(" "),
  )
}
