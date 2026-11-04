//! Bash's function printer (`print_cmd.c`): `declare -f`, `type` and the
//! `BASH_FUNC_name%%` environment form of an exported function, rebuilt
//! from the function's source the way bash re-prints its parse tree —
//! commands one per line with four-space indentation, `elif` as a nested
//! `else if`, redirections after the words in canonical spelling, comments
//! dropped and words kept as written. Bash 5.2+ also re-prints the inside of
//! `$(…)`; 3.2 keeps it verbatim. Here-document bodies are not kept by the
//! reader, so a here-document prints its operator only.
use super::*;

/// How a function is printed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FunctionStyle {
  /// `declare -f`/`type`: `name () \n{ \n    body\n}`.
  Declare,
  /// The value of an exported function's `BASH_FUNC_name%%` variable:
  /// `() {  body\n}` with one-space indentation.
  Environment,
}

/// Print function NAME whose body (a compound command, with any
/// redirections) is BODY source text. `None` when the body does not parse.
pub fn format_shell_function(name: &str, body: &str, style: FunctionStyle) -> Option<String> {
  let body = Reader::new(body)?.function_body()?;
  let mut printer = Printer::new();
  Some(printer.named_function(name, &body, style))
}

/// Re-print a command list on one line as bash 5.3 prints a command
/// substitution's body; `None` when it does not parse.
fn format_inline(source: &str) -> Option<String> {
  let mut reader = Reader::new(source)?;
  let list = reader.list(&[])?;
  if reader.pos != reader.tokens.len() {
    return None;
  }
  let mut printer = Printer::new();
  printer.command(list.as_deref());
  Some(printer.out)
}

const RESERVED: &[&str] = &[
  "if", "then", "elif", "else", "fi", "case", "esac", "for", "select", "while", "until", "do", "done",
  "in", "function", "time", "{", "}", "!", "[[", "]]", "coproc",
];

#[derive(Debug)]
struct Command {
  kind: Kind,
  invert: bool,
  /// `Some(posix)` for `time` / `time -p`.
  time: Option<bool>,
  redirects: Vec<String>,
}

#[derive(Debug)]
enum Kind {
  Simple(Vec<String>),
  /// Bare `time`: nothing to run.
  Empty,
  Connection(Box<Command>, &'static str, Option<Box<Command>>),
  For { select: bool, name: String, words: Vec<String>, body: Option<Box<Command>> },
  ArithFor { parts: [String; 3], body: Option<Box<Command>> },
  While { until: bool, test: Option<Box<Command>>, body: Option<Box<Command>> },
  If { test: Option<Box<Command>>, yes: Option<Box<Command>>, no: Option<Box<Command>> },
  Case { word: String, clauses: Vec<(Vec<String>, Option<Box<Command>>, String)> },
  Group(Option<Box<Command>>),
  Subshell(Option<Box<Command>>),
  Arith(String),
  Cond(String),
  Function { name: String, body: Box<Command> },
}

impl Command {
  fn new(kind: Kind) -> Self {
    Command { kind, invert: false, time: None, redirects: Vec::new() }
  }
}

struct Reader {
  tokens: Vec<String>,
  pos: usize,
}

impl Reader {
  fn new(source: &str) -> Option<Self> {
    let normalized: String = bash_line_chars(source).ok()?.into_iter().collect();
    let tokens = compound::lex(&normalized).ok()?.into_iter().map(|token| token.text).collect();
    Some(Reader { tokens, pos: 0 })
  }

  fn peek(&self) -> &str {
    self.tokens.get(self.pos).map_or("", String::as_str)
  }

  fn eat(&mut self, word: &str) -> bool {
    let found = self.peek() == word;
    if found {
      self.pos += 1;
    }
    found
  }

  fn expect(&mut self, word: &str) -> Option<()> {
    self.eat(word).then_some(())
  }

  fn lines(&mut self) {
    while self.eat("\n") {}
  }

  fn separators(&mut self) {
    while matches!(self.peek(), ";" | "\n") {
      self.pos += 1;
    }
  }

  fn function_body(&mut self) -> Option<Command> {
    self.lines();
    let body = self.command()?;
    self.lines();
    (self.pos == self.tokens.len()).then_some(body)
  }

  /// A list up to one of `stops`; `None` inside the option means empty.
  fn list(&mut self, stops: &[&str]) -> Option<Option<Box<Command>>> {
    self.lines();
    let mut result: Option<Command> = None;
    let join = |left: Option<Command>, op: &'static str, right: Option<Command>| -> Option<Command> {
      match left {
        None => right,
        Some(left) => Some(Command::new(Kind::Connection(Box::new(left), op, right.map(Box::new)))),
      }
    };
    let mut pending: Option<&'static str> = None;
    while self.pos < self.tokens.len() && !stops.contains(&self.peek()) {
      let item = self.and_or()?;
      result = match pending.take() {
        Some(op) => join(result, op, Some(item)),
        None => Some(item),
      };
      if self.eat("&") {
        pending = Some("&");
        self.lines();
        if self.pos >= self.tokens.len() || stops.contains(&self.peek()) {
          // A trailing `&` belongs to the last command alone.
          result = result.map(|command| async_last(command));
          pending = None;
        }
        continue;
      }
      if matches!(self.peek(), ";" | "\n") {
        self.separators();
        pending = Some(";");
      } else {
        break;
      }
    }
    Some(result.map(Box::new))
  }

  fn and_or(&mut self) -> Option<Command> {
    let mut left = self.pipeline()?;
    while matches!(self.peek(), "&&" | "||") {
      let op = if self.eat("&&") { "&&" } else {
        self.pos += 1;
        "||"
      };
      self.lines();
      let right = self.pipeline()?;
      left = Command::new(Kind::Connection(Box::new(left), op, Some(Box::new(right))));
    }
    Some(left)
  }

  fn pipeline(&mut self) -> Option<Command> {
    let mut time = None;
    let mut invert = false;
    loop {
      if self.eat("time") {
        time = Some(self.eat("-p"));
      } else if self.eat("!") {
        invert = !invert;
      } else {
        break;
      }
    }
    if time.is_some() && matches!(self.peek(), "" | ";" | "\n") {
      let mut empty = Command::new(Kind::Empty);
      empty.time = time;
      empty.invert = invert;
      return Some(empty);
    }
    let mut stages = vec![self.command()?];
    while matches!(self.peek(), "|" | "|&") {
      if self.eat("|&") {
        stages.last_mut()?.redirects.push("2>&1".into());
      } else {
        self.pos += 1;
      }
      self.lines();
      stages.push(self.command()?);
    }
    let mut stages = stages.into_iter();
    let mut result = stages.next()?;
    for stage in stages {
      result = Command::new(Kind::Connection(Box::new(result), "|", Some(Box::new(stage))));
    }
    result.invert = invert;
    result.time = time;
    Some(result)
  }

  fn command(&mut self) -> Option<Command> {
    let head = self.peek().to_string();
    let compound = match head.as_str() {
      "if" => {
        self.pos += 1;
        Some(self.conditional()?)
      }
      "while" | "until" => {
        self.pos += 1;
        let test = self.list(&["do"])?;
        self.expect("do")?;
        let body = self.list(&["done"])?;
        self.expect("done")?;
        Some(Command::new(Kind::While { until: head == "until", test, body }))
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
        Some(Command::new(Kind::Group(body)))
      }
      "(" => {
        self.pos += 1;
        let body = self.list(&[")"])?;
        self.expect(")")?;
        Some(Command::new(Kind::Subshell(body)))
      }
      "function" => {
        self.pos += 1;
        let name = self.peek().to_string();
        self.pos += 1;
        if self.eat("(") {
          self.expect(")")?;
        }
        self.lines();
        let body = self.command()?;
        Some(Command::new(Kind::Function { name, body: Box::new(body) }))
      }
      _ if head.starts_with("((") && head.ends_with("))") => {
        self.pos += 1;
        Some(Command::new(Kind::Arith(head[2..head.len() - 2].to_string())))
      }
      _ if head.starts_with("[[") && head.ends_with("]]") => {
        self.pos += 1;
        Some(Command::new(Kind::Cond(head[2..head.len() - 2].trim().to_string())))
      }
      _ if !head.is_empty() && self.tokens.get(self.pos + 1).is_some_and(|t| t == "(")
        && self.tokens.get(self.pos + 2).is_some_and(|t| t == ")") =>
      {
        self.pos += 3;
        self.lines();
        let body = self.command()?;
        Some(Command::new(Kind::Function { name: head, body: Box::new(body) }))
      }
      _ => None,
    };
    if let Some(mut command) = compound {
      let pieces = self.simple_tokens();
      for piece in pieces {
        match piece {
          Piece::Redirect(text) => command.redirects.push(text),
          Piece::Word(_) => return None,
        }
      }
      return Some(command);
    }
    let pieces = self.simple_tokens();
    if pieces.is_empty() {
      return None;
    }
    let mut words = Vec::new();
    let mut command = Command::new(Kind::Empty);
    for piece in pieces {
      match piece {
        Piece::Word(word) => words.push(reformat_substitutions(&word)),
        Piece::Redirect(text) => command.redirects.push(text),
      }
    }
    command.kind = Kind::Simple(words);
    Some(command)
  }

  /// The words and redirections up to the next operator.
  fn simple_tokens(&mut self) -> Vec<Piece> {
    let mut raw = Vec::new();
    while self.pos < self.tokens.len()
      && !matches!(self.peek(), ";" | "\n" | "&&" | "||" | "|" | "|&" | ";;" | ";&" | ";;&" | "&" | "(" | ")")
    {
      raw.push(self.peek().to_string());
      self.pos += 1;
    }
    pieces(&raw)
  }

  fn conditional(&mut self) -> Option<Command> {
    let test = self.list(&["then"])?;
    self.expect("then")?;
    let yes = self.list(&["elif", "else", "fi"])?;
    let no = if self.eat("elif") {
      Some(Box::new(self.conditional()?))
    } else {
      let no = if self.eat("else") { self.list(&["fi"])? } else { None };
      self.expect("fi")?;
      no
    };
    Some(Command::new(Kind::If { test, yes, no }))
  }

  fn for_loop(&mut self, select: bool) -> Option<Command> {
    let header = self.peek().to_string();
    if !select && header.starts_with("((") && header.ends_with("))") {
      self.pos += 1;
      let inner = &header[2..header.len() - 2];
      let fields: Vec<&str> = inner.splitn(3, ';').collect();
      if fields.len() != 3 {
        return None;
      }
      let part = |field: &str| {
        let field = field.trim_start();
        if field.is_empty() { "1".to_string() } else { field.to_string() }
      };
      let parts = [part(fields[0]), part(fields[1]), part(fields[2])];
      self.separators();
      self.expect("do")?;
      let body = self.list(&["done"])?;
      self.expect("done")?;
      return Some(Command::new(Kind::ArithFor { parts, body }));
    }
    let name = header;
    self.pos += 1;
    self.lines();
    let words = if self.eat("in") {
      let mut words = Vec::new();
      while self.pos < self.tokens.len() && !matches!(self.peek(), ";" | "\n") {
        words.push(reformat_substitutions(self.peek()));
        self.pos += 1;
      }
      words
    } else {
      vec!["\"$@\"".to_string()]
    };
    self.separators();
    self.expect("do")?;
    let body = self.list(&["done"])?;
    self.expect("done")?;
    Some(Command::new(Kind::For { select, name, words, body }))
  }

  fn case(&mut self) -> Option<Command> {
    let word = self.peek().to_string();
    self.pos += 1;
    self.lines();
    self.expect("in")?;
    self.lines();
    let mut clauses = Vec::new();
    while !self.eat("esac") {
      if self.peek().is_empty() {
        return None;
      }
      self.eat("(");
      let mut patterns = Vec::new();
      loop {
        patterns.push(self.peek().to_string());
        self.pos += 1;
        if !self.eat("|") {
          break;
        }
      }
      self.expect(")")?;
      let body = self.list(&[";;", ";&", ";;&", "esac"])?;
      let ending = if matches!(self.peek(), ";;" | ";&" | ";;&") {
        let ending = self.peek().to_string();
        self.pos += 1;
        ending
      } else {
        ";;".into()
      };
      clauses.push((patterns, body, ending));
      self.lines();
    }
    Some(Command::new(Kind::Case { word, clauses }))
  }
}

/// `a; b &`: only the last command of a list runs asynchronously.
fn async_last(command: Command) -> Command {
  match command {
    Command { kind: Kind::Connection(left, ";", Some(right)), invert: false, time: None, redirects } if redirects.is_empty() => {
      Command {
        kind: Kind::Connection(left, ";", Some(Box::new(async_last(*right)))),
        invert: false,
        time: None,
        redirects,
      }
    }
    other => Command::new(Kind::Connection(Box::new(other), "&", None)),
  }
}

enum Piece {
  Word(String),
  Redirect(String),
}

/// Split raw command tokens into words and canonical redirections.
fn pieces(raw: &[String]) -> Vec<Piece> {
  let mut result = Vec::new();
  let mut i = 0;
  while i < raw.len() {
    let token = &raw[i];
    i += 1;
    match split_redirect(token) {
      None => result.push(Piece::Word(token.clone())),
      Some((before, fd, op, target)) => {
        if !before.is_empty() {
          result.push(Piece::Word(before));
        }
        let target = if target.is_empty() && op != "<<" && op != "<<-" {
          let next = raw.get(i).cloned().unwrap_or_default();
          i += 1;
          next
        } else {
          target
        };
        result.push(Piece::Redirect(canonical_redirect(&fd, &op, &target)));
      }
    }
  }
  result
}

/// The first unquoted redirection in TOKEN: the word before it, the
/// descriptor prefix (digits or `{name}`), the operator and its attached
/// target (possibly empty).
fn split_redirect(token: &str) -> Option<(String, String, String, String)> {
  let chars: Vec<char> = token.chars().collect();
  let mut i = 0;
  let mut found = None;
  while i < chars.len() {
    if let Ok(Some(end)) = redirection::protected_end(&chars, i) {
      // `<(…)`/`>(…)` are process substitutions, not redirections.
      i = end;
      continue;
    }
    if matches!(chars[i], '<' | '>') || chars[i] == '&' && chars.get(i + 1) == Some(&'>') {
      found = Some(i);
      break;
    }
    i += 1;
  }
  let at = found?;
  let before: String = chars[..at].iter().collect();
  // A descriptor prefix is all digits or `{name}` touching the operator.
  let (word, fd) = if !before.is_empty() && before.chars().all(|c| c.is_ascii_digit())
    || before.starts_with('{') && before.ends_with('}') && before.len() > 2
  {
    (String::new(), before)
  } else {
    (before, String::new())
  };
  let rest: String = chars[at..].iter().collect();
  const OPERATORS: &[&str] = &["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">>", ">|", ">&", "<", ">"];
  let op = OPERATORS.iter().find(|op| rest.starts_with(**op))?;
  let target = rest[op.len()..].to_string();
  Some((word, fd, op.to_string(), target))
}

/// Bash's `print_redirection` spelling.
fn canonical_redirect(fd: &str, op: &str, target: &str) -> String {
  let digits = |default: &str| if fd.is_empty() { default.to_string() } else { fd.to_string() };
  let shown = |default: &str| if fd.is_empty() || fd == default { String::new() } else { fd.to_string() };
  let numeric = !target.is_empty() && target.chars().all(|c| c.is_ascii_digit());
  match op {
    ">" | ">>" | ">|" => format!("{}{op} {target}", shown("1")),
    "<" | "<>" | "<<<" => format!("{}{op} {target}", shown("0")),
    "&>" | "&>>" => format!("{op} {target}"),
    "<<" | "<<-" => format!("{}{op}{target}", shown("0")),
    ">&" | "<&" if target == "-" => format!("{}>&-", digits(if op == ">&" { "1" } else { "0" })),
    ">&" if numeric => format!("{}>&{target}", digits("1")),
    "<&" if numeric => format!("{}<&{target}", digits("0")),
    ">&" => format!("{}>&{target}", shown("1")),
    "<&" => format!("{}<&{target}", shown("0")),
    _ => format!("{fd}{op}{target}"),
  }
}

/// Bash 5.3 re-prints each `$(…)` body on one line (`$( ls )` → `$(ls)`).
fn reformat_substitutions(word: &str) -> String {
  let chars: Vec<char> = word.chars().collect();
  let mut out = String::new();
  let mut i = 0;
  let mut single = false;
  while i < chars.len() {
    let c = chars[i];
    if single {
      out.push(c);
      single = c != '\'';
      i += 1;
      continue;
    }
    match c {
      '\'' => {
        single = true;
        out.push(c);
        i += 1;
      }
      '\\' => {
        out.extend(chars[i..(i + 2).min(chars.len())].iter());
        i += 2;
      }
      '$' if chars.get(i + 1) == Some(&'(') && chars.get(i + 2) != Some(&'(') => {
        let Ok(close) = scan_balanced(&chars, i + 2) else {
          out.extend(chars[i..].iter());
          break;
        };
        let inner: String = chars[i + 2..close].iter().collect();
        match format_inline(&inner) {
          Some(text) => {
            out.push_str("$(");
            out.push_str(&text);
            out.push(')');
          }
          None => out.extend(chars[i..=close].iter()),
        }
        i = close + 1;
      }
      '$' if chars.get(i + 1) == Some(&'\'') => {
        let end = redirection::protected_end(&chars, i).ok().flatten().unwrap_or(chars.len());
        out.extend(chars[i..end].iter());
        i = end;
      }
      '`' => {
        let end = redirection::protected_end(&chars, i).ok().flatten().unwrap_or(chars.len());
        out.extend(chars[i..end].iter());
        i = end;
      }
      _ => {
        out.push(c);
        i += 1;
      }
    }
  }
  out
}

/// `make_command_string_internal`'s state.
struct Printer {
  out: String,
  indentation: usize,
  amount: usize,
  skip: usize,
  in_function: usize,
}

impl Printer {
  fn new() -> Self {
    Printer { out: String::new(), indentation: 0, amount: 4, skip: 0, in_function: 0 }
  }

  fn indent(&mut self) {
    for _ in 0..self.indentation {
      self.out.push(' ');
    }
  }

  fn newline(&mut self, text: &str) {
    self.out.push('\n');
    self.indent();
    self.out.push_str(text);
  }

  fn semicolon(&mut self) {
    if self.out.ends_with('&') || self.out.ends_with('\n') {
      return;
    }
    self.out.push(';');
  }

  fn named_function(&mut self, name: &str, body: &Command, style: FunctionStyle) -> String {
    let (saved_indentation, saved_amount) = (self.indentation, self.amount);
    if style == FunctionStyle::Declare {
      if RESERVED.contains(&name) {
        self.out.push_str("function ");
      }
      self.out.push_str(name);
      self.out.push(' ');
    }
    self.out.push_str("() ");
    if style == FunctionStyle::Environment {
      self.indentation = 1;
      self.amount = 0;
    } else {
      self.out.push('\n');
      self.indentation += self.amount;
    }
    self.in_function += 1;
    self.out.push_str(if style == FunctionStyle::Declare { "{ \n" } else { "{ " });
    let redirects = self.function_contents(body);
    self.indentation = saved_indentation;
    self.amount = saved_amount;
    self.in_function -= 1;
    self.close_function(redirects);
    std::mem::take(&mut self.out)
  }

  /// A function body without its group braces: a group's redirections are
  /// the caller's to print after the closing brace.
  fn function_contents<'a>(&mut self, body: &'a Command) -> &'a [String] {
    match &body.kind {
      Kind::Group(inner) if !body.invert && body.time.is_none() => {
        self.command(inner.as_deref());
        &body.redirects
      }
      _ => {
        self.command(Some(body));
        &[]
      }
    }
  }

  fn close_function(&mut self, redirects: &[String]) {
    if redirects.is_empty() {
      self.newline("}");
    } else {
      self.newline("} ");
      self.out.push_str(&redirects.join(" "));
    }
  }

  fn command(&mut self, command: Option<&Command>) {
    let Some(command) = command else {
      return;
    };
    if self.skip > 0 {
      self.skip -= 1;
    } else {
      self.indent();
    }
    if let Some(posix) = command.time {
      self.out.push_str("time ");
      if posix {
        self.out.push_str("-p ");
      }
    }
    if command.invert {
      self.out.push_str("! ");
    }
    let amount = self.amount;
    match &command.kind {
      Kind::Empty => {}
      Kind::Simple(words) => {
        self.out.push_str(&words.join(" "));
        if !command.redirects.is_empty() {
          if !words.is_empty() {
            self.out.push(' ');
          }
          self.out.push_str(&command.redirects.join(" "));
        }
        return;
      }
      Kind::Connection(first, op, second) => {
        self.skip += 1;
        self.command(Some(first));
        match *op {
          "&" | "|" => {
            self.out.push(' ');
            self.out.push_str(op);
            if *op != "&" || second.is_some() {
              self.out.push(' ');
              self.skip += 1;
            }
          }
          "&&" | "||" => {
            self.out.push(' ');
            self.out.push_str(op);
            self.out.push(' ');
            if second.is_some() {
              self.skip += 1;
            }
          }
          _ => {
            self.out.push(';');
            if self.in_function > 0 {
              self.out.push('\n');
            } else {
              self.out.push(' ');
              if second.is_some() {
                self.skip += 1;
              }
            }
          }
        }
        self.command(second.as_deref());
      }
      Kind::For { select, name, words, body } => {
        self.out.push_str(&format!("{} {name} in {}", if *select { "select" } else { "for" }, words.join(" ")));
        self.out.push(';');
        self.newline("do\n");
        self.indentation += amount;
        self.command(body.as_deref());
        self.semicolon();
        self.indentation -= amount;
        self.newline("done");
      }
      Kind::ArithFor { parts, body } => {
        self.out.push_str(&format!("for (({}; {}; {}))", parts[0], parts[1], parts[2]));
        self.newline("do\n");
        self.indentation += amount;
        self.command(body.as_deref());
        self.semicolon();
        self.indentation -= amount;
        self.newline("done");
      }
      Kind::While { until, test, body } => {
        self.out.push_str(if *until { "until " } else { "while " });
        self.skip += 1;
        self.command(test.as_deref());
        self.semicolon();
        self.out.push_str(" do\n");
        self.indentation += amount;
        self.command(body.as_deref());
        self.indentation -= amount;
        self.semicolon();
        self.newline("done");
      }
      Kind::If { test, yes, no } => {
        self.out.push_str("if ");
        self.skip += 1;
        self.command(test.as_deref());
        self.semicolon();
        self.out.push_str(" then\n");
        self.indentation += amount;
        self.command(yes.as_deref());
        self.indentation -= amount;
        if let Some(no) = no {
          self.semicolon();
          self.newline("else\n");
          self.indentation += amount;
          self.command(Some(no));
          self.indentation -= amount;
        }
        self.semicolon();
        self.newline("fi");
      }
      Kind::Case { word, clauses } => {
        self.out.push_str(&format!("case {word} in "));
        self.indentation += amount;
        for (patterns, body, ending) in clauses {
          self.newline("");
          self.out.push_str(&patterns.join(" | "));
          self.out.push_str(")\n");
          self.indentation += amount;
          self.command(body.as_deref());
          self.indentation -= amount;
          self.newline(ending);
        }
        self.indentation -= amount;
        self.newline("esac");
      }
      Kind::Group(body) => {
        self.out.push_str("{ ");
        if self.in_function == 0 {
          self.skip += 1;
        } else {
          self.out.push('\n');
          self.indentation += amount;
        }
        self.command(body.as_deref());
        if self.in_function > 0 {
          self.out.push('\n');
          self.indentation -= amount;
          self.indent();
        } else {
          self.semicolon();
          self.out.push(' ');
        }
        self.out.push('}');
      }
      Kind::Subshell(body) => {
        self.out.push_str("( ");
        self.skip += 1;
        self.command(body.as_deref());
        self.out.push_str(" )");
      }
      Kind::Arith(expression) => self.out.push_str(&format!("(({expression}))")),
      Kind::Cond(expression) => self.out.push_str(&format!("[[ {expression} ]]")),
      Kind::Function { name, body } => {
        self.out.push_str(&format!("function {name} () \n"));
        self.indent();
        self.out.push_str("{ \n");
        self.in_function += 1;
        self.indentation += amount;
        let redirects = self.function_contents(body);
        self.indentation -= amount;
        self.in_function -= 1;
        self.close_function(redirects);
      }
    }
    if !command.redirects.is_empty() {
      self.out.push(' ');
      self.out.push_str(&command.redirects.join(" "));
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn declare(name: &str, body: &str) -> String {
    format_shell_function(name, body, FunctionStyle::Declare).unwrap()
  }

  // Expectations printed by bash 5.3's `declare -f`.
  #[test]
  fn function_printer_matches_bash_for_common_constructs() {
    assert_eq!(declare("h", "{ echo a\n  # comment\n  echo b\n}"), "h () \n{ \n    echo a;\n    echo b\n}");
    assert_eq!(
      declare("f", "{ if true; then echo a; elif false; then :; else echo b; fi; }"),
      "f () \n{ \n    if true; then\n        echo a;\n    else\n        if false; then\n            :;\n        else\n            echo b;\n        fi;\n    fi\n}"
    );
    assert_eq!(
      declare("f", "{ for i in 1 2; do echo $i; done; while false; do :; done; until true; do :; done; }"),
      "f () \n{ \n    for i in 1 2;\n    do\n        echo $i;\n    done;\n    while false; do\n        :;\n    done;\n    until true; do\n        :;\n    done\n}"
    );
    assert_eq!(
      declare("k", "{ case $1 in\n  a) echo a ;&\n  b) echo b ;;&\n  c) ;;\nesac; }"),
      "k () \n{ \n    case $1 in \n        a)\n            echo a\n        ;&\n        b)\n            echo b\n        ;;&\n        c)\n\n        ;;\n    esac\n}"
    );
    assert_eq!(
      declare("f", "{ (cd /; ls) | wc -l > /dev/null 2>&1; { echo g; } ; x=1 y=2 cmd \"q w\" 'z' && echo and || echo or; ! true; echo bg & echo after; }"),
      "f () \n{ \n    ( cd /;\n    ls ) | wc -l > /dev/null 2>&1;\n    { \n        echo g\n    };\n    x=1 y=2 cmd \"q w\" 'z' && echo and || echo or;\n    ! true;\n    echo bg & echo after\n}"
    );
    assert_eq!(declare("g", "( echo sub )"), "g () \n{ \n    ( echo sub )\n}");
    assert_eq!(declare("f8", "{ echo a; } >out 2>&1"), "f8 () \n{ \n    echo a\n} > out 2>&1");
    assert_eq!(
      declare("f", "{ function g { :; }; }"),
      "f () \n{ \n    function g () \n    { \n        :\n    }\n}"
    );
  }

  #[test]
  fn function_printer_spells_redirections_like_bash() {
    assert_eq!(
      declare("f2", "{ cat <&3; echo >&2 x; echo 1>&2; exec 3>&-; exec 4<&-; echo &>f; echo &>>f; echo >|f; cat <>f; echo 2>>f; read -u 3 <&0; echo {fd}>f; echo 3<f 4>f 5>>f; cat <<<\"$x\" 2>&-; echo >&$fd; }"),
      "f2 () \n{ \n    cat 0<&3;\n    echo x 1>&2;\n    echo 1>&2;\n    exec 3>&-;\n    exec 4>&-;\n    echo &> f;\n    echo &>> f;\n    echo >| f;\n    cat <> f;\n    echo 2>> f;\n    read -u 3 0<&0;\n    echo {fd}> f;\n    echo 3< f 4> f 5>> f;\n    cat <<< \"$x\" 2>&-;\n    echo >&$fd\n}"
    );
    assert_eq!(declare("f", "{ echo >>out 2>&1 <in; >o echo; }"), "f () \n{ \n    echo >> out 2>&1 < in;\n    echo > o\n}");
  }

  #[test]
  fn function_printer_pipelines_time_and_arithmetic() {
    assert_eq!(
      declare("f3", "{ a |& b; a | b | c; ! a | b; time -p a | b; time; ! time a; a && b || c; a & }"),
      "f3 () \n{ \n    a 2>&1 | b;\n    a | b | c;\n    ! a | b;\n    time -p a | b;\n    time ;\n    time ! a;\n    a && b || c;\n    a &\n}"
    );
    assert_eq!(
      declare("f4", "{ for ((i = 0 ; i < 2 ; i++)); do :; done; for ((;;)); do break; done; ((x+=1)); (( y = 2 )); [[ ! -f x || ( a == b && c != d ) ]]; }"),
      "f4 () \n{ \n    for ((i = 0 ; i < 2 ; i++))\n    do\n        :;\n    done;\n    for ((1; 1; 1))\n    do\n        break;\n    done;\n    ((x+=1));\n    (( y = 2 ));\n    [[ ! -f x || ( a == b && c != d ) ]]\n}"
    );
    assert_eq!(
      declare("f13", "{ x=1; select y in a b; do :; done; for z; do :; done; }"),
      "f13 () \n{ \n    x=1;\n    select y in a b;\n    do\n        :;\n    done;\n    for z in \"$@\";\n    do\n        :;\n    done\n}"
    );
    assert_eq!(declare("f10", "{ a; b & c; }"), "f10 () \n{ \n    a;\n    b & c\n}");
    assert_eq!(
      declare("f12", "{ if a; then b; else c; fi > out; { a; b; } | c; (a) & }"),
      "f12 () \n{ \n    if a; then\n        b;\n    else\n        c;\n    fi > out;\n    { \n        a;\n        b\n    } | c;\n    ( a ) &\n}"
    );
  }

  #[test]
  fn function_printer_reprints_command_substitutions_and_reserved_names() {
    assert_eq!(
      declare("f", "{ echo $(echo a;echo b) \"$( ls )\" `x  y` '$( z )'; }"),
      "f () \n{ \n    echo $(echo a; echo b) \"$(ls)\" `x  y` '$( z )'\n}"
    );
    assert_eq!(declare("time", "{ :; }"), "function time () \n{ \n    :\n}");
  }

  #[test]
  fn exported_function_environment_form_matches_bash() {
    let env = |body: &str| format_shell_function("a", body, FunctionStyle::Environment).unwrap();
    assert_eq!(env("{ echo a; }"), "() {  echo a\n}");
    assert_eq!(env("{ echo a; if x; then y; fi; }"), "() {  echo a;\n if x; then\n y;\n fi\n}");
  }
}
