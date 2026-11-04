//! Destination-aware dispatch over the host's declared shell aliases.
use super::{LispHost, LispHostError, LispValue, Sym};
use serde_json::Value as JsonValue;
use std::rc::Rc;

pub type ShellCommandAdmission = Rc<dyn Fn(&str, &[String]) -> bool>;
pub type ShellBuiltin = Rc<dyn Fn(Vec<String>, bool) -> Option<crate::Result<ShellBuiltinOutput>>>;

#[derive(Clone, Debug, Default)]
pub struct ShellBuiltinOutput {
  pub stdout: Vec<u8>,
  pub status: i32,
  pub diagnostics: Vec<String>,
}
impl ShellBuiltinOutput {
  pub fn success(stdout: Vec<u8>) -> Self {
    Self {
      stdout,
      ..Default::default()
    }
  }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ShellFailureDisplay {
  #[default]
  Off,
  Mark,
  Status,
}

impl LispHost {
  pub(super) fn evaluate_environment_value(
    &mut self,
    value: &LispValue<Sym>,
    preceding: &[(String, String)],
  ) -> Result<JsonValue, LispHostError> {
    let mut env = tento_lisp::Env::extend(self.env.clone());
    for (key, value) in preceding {
      let symbol = self.interp.string_interner().get_or_intern(key);
      env.define(symbol, LispValue::String(value.as_str().into()));
    }
    self.refresh_shell_symbols();
    self
      .interp
      .eval_expression(Rc::new(std::cell::RefCell::new(env)), value)
      .map(|value| super::interp::value_to_json(&value))
      .map_err(|error| LispHostError::Command(error.to_string()))
  }

  /// `(let NAME VALUE)`, the binding form a posix `name=value` lowers to
  /// (operator ruling 19 retired `def`). Bash's `let EXPR…` builtin reads with
  /// string operands, never a symbol NAME, so the shape tells the two apart.
  pub(super) fn is_let_binding(&mut self, value: &LispValue<Sym>) -> bool {
    let LispValue::List(list) = value else { return false };
    let [LispValue::Symbol(head), LispValue::Symbol(_), _] = list.items.as_slice() else { return false };
    self.interp.string_interner().resolve(head.as_symbol()) == Some("let")
  }

  /// [`Self::shell_compound_command`] for a whole value: a `(let NAME VALUE)`
  /// binding stays lisp; only Bash's `let EXPR…` builtin takes the shell door.
  pub(super) fn shell_compound_value(&mut self, head: Option<&str>, value: &LispValue<Sym>) -> bool {
    self.shell_compound_command(head) && !self.is_let_binding(value)
  }

  pub(super) fn update_exported_assignment(&mut self, value: &LispValue<Sym>) -> crate::Result<()> {
    if !self.is_let_binding(value) {
      return Ok(());
    }
    let LispValue::List(list) = value else {
      return Ok(());
    };
    let Some(LispValue::Symbol(symbol)) = list.items.get(1) else {
      return Ok(());
    };
    let Some(name) = self
      .interp
      .string_interner()
      .resolve(symbol.as_symbol())
      .map(str::to_string)
    else {
      return Ok(());
    };
    // `export v` of an unset v exports it at its first assignment.
    let exported = self.shell_compound.commands.attributes.borrow().get(&name).is_some_and(|a| a.exported);
    if let Some(map) = tento_env::global_env_map().filter(|map| exported || map.get(&name).is_some()) {
      let call = self.shell_literal_call(&["std.sh.var".into(), name.clone()], "std.sh.var", false);
      let value = self
        .evaluate_shell_data(&call)
        .map_err(|e| crate::Error::Other(anyhow::anyhow!("{e}")))?;
      map.set(
        name,
        value
          .as_str()
          .map(str::to_string)
          .unwrap_or_else(|| value.to_string()),
      );
    }
    Ok(())
  }

  pub(super) fn shell_export_argv(&mut self, argv: &mut [String]) -> crate::Result<()> {
    for arg in argv.iter_mut().skip(1) {
      if !arg.contains('=') && !arg.starts_with('-') {
        let call = self.shell_literal_call(&["std.sh.var".into(), arg.clone()], "std.sh.var", false);
        let value = self
          .evaluate_shell_data(&call)
          .map_err(|error| crate::Error::Other(anyhow::anyhow!("{error}")))?;
        *arg = format!(
          "{arg}={}",
          value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string())
        );
      }
      if let Some((key, value)) = arg.split_once('=') {
        if !key.is_empty()
          && !key.as_bytes()[0].is_ascii_digit()
          && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
          self
            .define_lisp_scalar(
              key,
              super::HostValue::from_json(JsonValue::String(value.into())),
            )
            .map_err(|error| crate::Error::Other(anyhow::anyhow!("{error}")))?;
        }
      }
    }
    Ok(())
  }

  pub fn set_shell_builtin_gate(&mut self, gate: Rc<dyn Fn(&str) -> crate::Result<()>>) {
    self.shell_builtin_gate = Some(gate);
  }

  pub fn set_shell_byte_output(&mut self, output: Rc<dyn Fn(&[u8])>) {
    self.shell_byte_output = Some(output);
  }

  /// Stream stderr bytes and diagnostics at the write site, before later children.
  pub fn set_shell_stderr_output(&mut self, output: Rc<dyn Fn(&[u8])>) {
    self.shell_stderr_output = Some(output);
  }

  /// Explicit REPL entrypoint; independent lines each select their destination.
  pub async fn eval_prompt_source_async(&mut self, source: &str) -> crate::Result<JsonValue> {
    let status_writes = self.shell_status_writes();
    let formatter = self.shell_formatter.clone();
    let writer = Rc::new(move |_line, value: &JsonValue, last| {
      if last {
        return false;
      }
      let text = if let Some(formatter) = &formatter {
        formatter(value)
      } else {
        crate::run_loop::format_cli_value(value, None).map(|text| format!("{text}\n"))
      };
      if let Some(text) = text {
        let _ = super::shell_redirect::write_target(&super::FdTarget::Inherit(1), text.as_bytes());
      }
      true
    });
    let value = super::run_source_on_host(
      self,
      source,
      &crate::Scripts::new(()),
      &std::collections::HashMap::new(),
      &[],
      super::RunOptions {
        on_error: super::OnError::Bash,
        prompt: true,
        bash_output: Some(writer),
        ..Default::default()
      },
    )
    .await
    .map_err(|error| match error {
      super::TshScriptError {
        kind: super::TshScriptErrorKind::Command(error),
        ..
      } => error,
      super::TshScriptError {
        kind: super::TshScriptErrorKind::BashStatus(status),
        ..
      } => crate::Error::ProcessExit {
        status: Some(status),
        signal: None,
        detail: format!("exit status {status}"),
      },
      error => crate::Error::Other(anyhow::anyhow!("{error}")),
    })?;
    if self.shell_status_writes() != status_writes
      && self.shell_last_statement_bash()
      && self.shell_status() != 0
    {
      return Err(crate::Error::ProcessExit {
        status: Some(self.shell_status()),
        signal: None,
        detail: format!("exit status {}", self.shell_status()),
      });
    }
    Ok(value.unwrap_or(JsonValue::Null))
  }

  pub(super) async fn eval_shell_destination_async(
    &mut self,
    value: &LispValue<Sym>,
    shaped: bool,
  ) -> crate::Result<JsonValue> {
    self.shell_prompt = shaped;
    let result = super::bash_flow::eval_flow(
      self,
      value,
      1,
      false,
      super::bash_flow::FlowOutput {
        shaped,
        ..Default::default()
      },
      true,
    )
    .await
    .map_err(|error| match error {
      super::TshScriptErrorKind::Command(error) => error,
      error => crate::Error::Other(anyhow::anyhow!("{error}")),
    })?;
    if self.shell_status() != 0 {
      return Err(crate::Error::ProcessExit {
        status: Some(self.shell_status()),
        signal: None,
        detail: format!("exit status {}", self.shell_status()),
      });
    }
    Ok(result.unwrap_or(JsonValue::Null))
  }

  pub(super) fn shell_utility_missing(&self, name: &str) -> bool {
    self
      .external
      .as_ref()
      .is_none_or(|external| matches!(external.lookup(name), super::ExternalLookup::NotFound))
  }

  /// A bash spelling and its typed value. Lisp env bindings are untouched.
  pub fn register_shell_alias(&mut self, name: &str, target: &str) {
    self.shell_aliases.insert(name.into(), target.into());
  }

  /// Argument admission must be effect-free: rejecting the shape runs the utility.
  pub fn set_shell_command_admission(&mut self, accept: ShellCommandAdmission) {
    self.shell_command_admission = Some(accept);
  }

  pub fn set_shell_builtin(&mut self, builtin: ShellBuiltin) {
    self.shell_builtin = Some(builtin);
    // DIRSTACK always holds the current directory, as bash's does.
    self.refresh_dir_stack();
  }

  pub fn shell_failure_display(&self) -> ShellFailureDisplay {
    self.shell_failure_display.get()
  }

  /// An operator interrupt (Ctrl-C) ended the running Bash line: `$?` is 130,
  /// the status bash gives a line its SIGINT ended.
  pub fn record_shell_interrupt(&mut self) {
    self.set_shell_status(130);
  }

  pub(super) fn register_shell_presentation(&mut self) {
    let env = self.env.clone();
    let names = self.shell_symbols.clone();
    self.register_native_special("std.sh.unset", move |args| {
      let mut arguments = args.iter();
      if matches!(args.first(), Some(LispValue::String(flag)) if flag == "-v" || flag == "--") {
        arguments.next();
      }
      for arg in arguments {
        let LispValue::String(name) = arg else {
          return Err(LispHostError::Command(
            "unset: expected variable names".into(),
          ));
        };
        if let Some(map) = tento_env::global_env_map() {
          map.remove(name);
        }
        if let Some(symbol) = names.borrow().get(name.as_str()).copied() {
          env.borrow_mut().undefine(symbol);
        }
      }
      Ok(LispValue::Nil)
    });
    let setting = self.shell_failure_display.clone();
    self.register_native_special("tsh.failure-display", move |args| {
      let [LispValue::String(value)] = args.as_slice() else {
        return Err(LispHostError::Command(
          "tsh.failure-display: expected off, mark or status".into(),
        ));
      };
      setting.set(match value.as_str() {
        "off" => ShellFailureDisplay::Off,
        "mark" => ShellFailureDisplay::Mark,
        "status" => ShellFailureDisplay::Status,
        _ => {
          return Err(LispHostError::Command(
            "tsh.failure-display: expected off, mark or status".into(),
          ));
        }
      });
      Ok(LispValue::Nil)
    });
  }

  /// Whether a bash line runs `name` as a host utility even though a Lisp
  /// binding shares the word: `env` (the Lisp environment helper is not the
  /// Unix env utility), and every declared name that is not a bash builtin
  /// (`ls` while the prelude says `(let ls std.fs.list_dir)`).
  pub(super) fn shell_utility(&mut self, name: &str) -> bool {
    name == "env"
      || !matches!(
        name,
        "cd" | "pwd" | "echo" | "printf" | "rm" | "export" | "set" | "test" | "[" | ":" | "true" | "false"
      ) && self.declared_target(name).is_some()
  }

  /// The typed command a prompt line `argv` renders through: its prompt
  /// declaration, when this is the interactive prompt, the output is
  /// rendered (`shaped`: not piped, captured or redirected) and the coreutils
  /// admission accepts the arguments. Anything else runs PATH's utility.
  pub(super) fn shell_typed_target(&mut self, argv: &[String], shaped: bool) -> Option<String> {
    let name = argv.first()?;
    if !shaped || !self.shell_prompt {
      return None;
    }
    let target = self.declared_target(name)?;
    let help = argv
      .iter()
      .skip(1)
      .take_while(|arg| arg.as_str() != "--")
      .any(|arg| arg == "--help");
    (help
      || self
        .shell_command_admission
        .as_ref()
        .is_some_and(|accept| accept(name, &argv[1..])))
    .then_some(target)
  }

  pub(super) fn shell_literal_call(
    &mut self,
    argv: &[String],
    target: &str,
    _help: bool,
  ) -> LispValue<Sym> {
    let mut items = vec![LispValue::Symbol(
      self.interp.string_interner().get_or_intern(super::shell_cmd::builtin_head(target)).into(),
    )];
    items.extend(argv.iter().skip(1).cloned().map(|value| LispValue::String(value.into())));
    LispValue::List(tento_lisp::List { items: items.into() })
  }

  pub(super) fn shell_builtin_bytes(
    &mut self,
    argv: Vec<String>,
    line: usize,
  ) -> Option<ShellBuiltinOutput> {
    let name = argv.first()?.as_str();
    if !matches!(
      name,
      ":" | "true" | "false" | "echo" | "printf" | "cd" | "pwd" | "rm" | "export" | "test" | "["
        | "pushd" | "popd" | "dirs"
    ) {
      return None;
    }
    let ordinal = self.shell_builtin_cache.as_mut().map(|(cursor, cache)| {
      let index = *cursor;
      *cursor += 1;
      (index, cache.get(index).cloned())
    });
    if let Some((_, Some(cached))) = &ordinal {
      return Some(cached.clone());
    }
    let admitted = self
      .shell_builtin_gate
      .as_ref()
      .map_or(Ok(()), |gate| gate(name));
    let result = match admitted {
      Err(error) => Err(error),
      Ok(()) => match name {
        ":" | "true" => Ok(ShellBuiltinOutput::default()),
        "false" => Ok(ShellBuiltinOutput {
          status: 1,
          ..Default::default()
        }),
        "echo" => Ok(ShellBuiltinOutput::success(echo_bytes(&argv[1..]))),
        // Always the builtin (bash_printf.rs), never the platform's printf.
        "printf" => Ok(self.printf_run(&argv[1..], line).1),
        "test" | "[" => Ok(shell_test(name, &self.answer_test_primaries(&argv[1..]))),
        "pushd" | "popd" | "dirs" => Ok(self.dir_stack_builtin(name, &argv[1..], line)),
        _ => match if name == "cd" {
          self.hosted_cd(&argv[1..])
        } else {
          self
            .shell_builtin
            .as_ref()
            .and_then(|builtin| builtin(argv, self.shell_prompt))
        } {
          Some(result) => result,
          None => {
            // A host that does not own this builtin leaves no replay slot.
            if let Some((cursor, _)) = &mut self.shell_builtin_cache {
              *cursor -= 1;
            }
            return None;
          }
        },
      },
    };
    let output = match result {
      Ok(output) => output,
      Err(error) => ShellBuiltinOutput {
        status: error.process_status().unwrap_or(1),
        diagnostics: super::runner::bash_command_diagnostic(line, &error)
          .into_iter()
          .collect(),
        ..Default::default()
      },
    };
    if !self.shell_suspended() {
      if let (Some((index, _)), Some((_, cache))) = (ordinal, &mut self.shell_builtin_cache) {
        if index == cache.len() {
          cache.push(output.clone());
        }
      }
    }
    Some(output)
  }
}

pub(super) fn plain_value(name: &str, value: &JsonValue) -> Vec<u8> {
  if name == "ls" {
    let mut text = String::new();
    let stored = value
      .get("source")
      .filter(|source| source["kind"] == "file")
      .and_then(|source| source.get("path").and_then(JsonValue::as_str))
      .and_then(|path| std::fs::read_to_string(path).ok())
      .map(|text| {
        text
          .lines()
          .filter_map(|line| serde_json::from_str::<JsonValue>(line).ok())
          .collect::<Vec<_>>()
      });
    if let Some(records) = value
      .get("records")
      .and_then(JsonValue::as_array)
      .or(stored.as_ref())
    {
      for record in records {
        if let Some(name) = record.get("name").and_then(JsonValue::as_str) {
          text.push_str(name.strip_suffix('/').unwrap_or(name));
          text.push('\n');
        }
      }
    }
    text.into_bytes()
  } else if matches!(name, "mkdir" | "touch" | "cp" | "mv" | "rm" | "cd") {
    Vec::new()
  } else if let Some(text) = value.as_str() {
    text.as_bytes().to_vec()
  } else {
    Vec::new()
  }
}

pub(super) fn echo_bytes(args: &[String]) -> Vec<u8> {
  let mut newline = true;
  let mut escapes = false;
  let mut index = 0;
  while let Some(arg) = args.get(index) {
    let Some(flags) = arg.strip_prefix('-') else {
      break;
    };
    if flags.is_empty() || !flags.chars().all(|c| matches!(c, 'n' | 'e' | 'E')) {
      break;
    }
    for flag in flags.chars() {
      match flag {
        'n' => newline = false,
        'e' => escapes = true,
        'E' => escapes = false,
        _ => unreachable!(),
      }
    }
    index += 1;
  }
  let text = args[index..].join(" ");
  let mut output = Vec::new();
  let mut chars = text.chars().peekable();
  while let Some(ch) = chars.next() {
    if !escapes || ch != '\\' {
      let mut bytes = [0; 4];
      output.extend_from_slice(ch.encode_utf8(&mut bytes).as_bytes());
      continue;
    }
    let Some(ch) = chars.next() else {
      output.push(b'\\');
      break;
    };
    match ch {
      'a' => output.push(7),
      'b' => output.push(8),
      'e' | 'E' => output.push(27),
      'f' => output.push(12),
      'n' => output.push(b'\n'),
      'r' => output.push(b'\r'),
      't' => output.push(b'\t'),
      'v' => output.push(11),
      '\\' => output.push(b'\\'),
      'c' => return output,
      '0' | 'x' | 'u' | 'U' => {
        let (radix, limit) = match ch {
          '0' => (8, 3),
          'x' => (16, 2),
          'u' => (16, 4),
          _ => (16, 8),
        };
        let mut value = 0u32;
        let mut count = 0;
        while count < limit {
          let Some(digit) = chars.peek().and_then(|c| c.to_digit(radix)) else {
            break;
          };
          chars.next();
          value = value * radix + digit;
          count += 1;
        }
        if ch == '0' || count > 0 {
          if matches!(ch, 'u' | 'U') {
            if let Some(ch) = char::from_u32(value) {
              let mut bytes = [0; 4];
              output.extend_from_slice(ch.encode_utf8(&mut bytes).as_bytes());
            }
          } else {
            output.push(value as u8);
          }
        } else {
          output.extend_from_slice(&[b'\\', ch as u8]);
        }
      }
      _ => {
        output.push(b'\\');
        let mut bytes = [0; 4];
        output.extend_from_slice(ch.encode_utf8(&mut bytes).as_bytes());
      }
    }
  }
  if newline {
    output.push(b'\n');
  }
  output
}

use std::path::Path;
pub fn shell_test(name: &str, args: &[String]) -> ShellBuiltinOutput {
  match test(name, args) {
    Ok(stdout) => ShellBuiltinOutput::success(stdout),
    Err(error) if error.process_status() == Some(1) => ShellBuiltinOutput {
      status: 1,
      ..Default::default()
    },
    Err(error) => ShellBuiltinOutput {
      status: 2,
      diagnostics: vec![error.to_string()],
      ..Default::default()
    },
  }
}

fn test(name: &str, args: &[String]) -> crate::Result<Vec<u8>> {
  let args = if name == "[" {
    if args.last().map(String::as_str) != Some("]") {
      return Err(anyhow::anyhow!("tsh: [: missing `]'").into());
    }
    &args[..args.len() - 1]
  } else {
    args
  };
  let truth = test_truth(name, args)?;
  if truth {
    Ok(Vec::new())
  } else {
    Err(crate::Error::ProcessExit {
      status: Some(1),
      signal: None,
      detail: "exit status 1".into(),
    })
  }
}

fn test_binary(op: &str) -> bool {
  matches!(op, "=" | "==" | "!=" | "<" | ">" | "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge" | "-nt" | "-ot" | "-ef")
}

fn test_truth(name: &str, args: &[String]) -> crate::Result<bool> {
  // POSIX's argument-count decisions precede the general expression grammar.
  match args {
    [] => return Ok(false),
    [value] => return Ok(!value.is_empty()),
    [op, value] if op == "!" => return Ok(value.is_empty()),
    [op, value] => return test_unary(name, op, value),
    [left, op, right] if test_binary(op) => return test_compare(name, left, op, right),
    [left, op, right] if op == "-a" || op == "-o" => {
      return Ok(if op == "-a" { !left.is_empty() && !right.is_empty() } else { !left.is_empty() || !right.is_empty() });
    }
    [op, rest @ ..] if args.len() <= 4 && op == "!" => return Ok(!test_truth(name, rest)?),
    [open, inner @ .., close] if args.len() <= 4 && open == "(" && close == ")" => return test_truth(name, inner),
    _ => {}
  }
  struct Parser<'a> { name: &'a str, args: &'a [String], pos: usize }
  impl Parser<'_> {
    fn peek(&self) -> &str { self.args.get(self.pos).map_or("", String::as_str) }
    fn or(&mut self) -> crate::Result<bool> {
      let mut value = self.and()?;
      while self.peek() == "-o" { self.pos += 1; let rhs = self.and()?; value |= rhs; }
      Ok(value)
    }
    fn and(&mut self) -> crate::Result<bool> {
      let mut value = self.term()?;
      while self.peek() == "-a" { self.pos += 1; let rhs = self.term()?; value &= rhs; }
      Ok(value)
    }
    fn term(&mut self) -> crate::Result<bool> {
      if self.pos == self.args.len() { return Err(anyhow::anyhow!("tsh: {}: argument expected", self.name).into()); }
      if self.peek() == "!" { self.pos += 1; return Ok(!self.term()?); }
      if self.peek() == "(" {
        self.pos += 1; let value = self.or()?;
        if self.peek() != ")" { return Err(anyhow::anyhow!("tsh: {}: `)' expected", self.name).into()); }
        self.pos += 1; return Ok(value);
      }
      let left = &self.args[self.pos]; self.pos += 1;
      if self.pos + 1 < self.args.len() && test_binary(self.peek()) {
        let op = &self.args[self.pos]; let right = &self.args[self.pos + 1]; self.pos += 2;
        return test_compare(self.name, left, op, right);
      }
      if left.starts_with('-') && left.len() == 2 && self.pos < self.args.len() {
        if self.pos + 1 < self.args.len() && !matches!(self.args[self.pos + 1].as_str(), "-a" | "-o" | ")") {
          return Err(anyhow::anyhow!("tsh: {}: {}: binary operator expected", self.name, self.peek()).into());
        }
        let value = &self.args[self.pos]; self.pos += 1;
        return test_unary(self.name, left, value);
      }
      Ok(!left.is_empty())
    }
  }
  let mut parser = Parser { name, args, pos: 0 };
  let value = parser.or()?;
  if parser.pos != args.len() { return Err(anyhow::anyhow!("tsh: {name}: too many arguments").into()); }
  Ok(value)
}

fn test_unary(name: &str, op: &str, value: &str) -> crate::Result<bool> {
  Ok(match op {
    "-n" => !value.is_empty(), "-z" => value.is_empty(),
    "-e" | "-a" => Path::new(value).exists(),
    "-f" => Path::new(value).is_file(), "-d" => Path::new(value).is_dir(),
    "-L" | "-h" => std::fs::symlink_metadata(value).is_ok_and(|m| m.file_type().is_symlink()),
    "-s" => std::fs::metadata(value).is_ok_and(|m| m.len() > 0),
    #[cfg(unix)]
    "-r" | "-w" | "-x" => {
      let path = std::ffi::CString::new(value).ok();
      let mode = match op { "-r" => libc::R_OK, "-w" => libc::W_OK, _ => libc::X_OK };
      path.is_some_and(|path| unsafe { libc::access(path.as_ptr(), mode) == 0 })
    }
    #[cfg(unix)]
    "-t" => {
      let fd = value.trim().parse::<i64>()
        .map_err(|_| anyhow::anyhow!("tsh: {name}: {value}: integer expected"))?;
      i32::try_from(fd).is_ok_and(|fd| unsafe { libc::isatty(fd) == 1 })
    }
    #[cfg(unix)]
    "-b" | "-c" | "-p" | "-S" | "-O" | "-G" | "-u" | "-g" | "-k" => {
      use std::os::unix::fs::{FileTypeExt, MetadataExt};
      std::fs::metadata(value).is_ok_and(|m| match op {
        "-b" => m.file_type().is_block_device(), "-c" => m.file_type().is_char_device(),
        "-p" => m.file_type().is_fifo(), "-S" => m.file_type().is_socket(),
        "-O" => m.uid() == unsafe { libc::geteuid() }, "-G" => m.gid() == unsafe { libc::getegid() },
        "-u" => m.mode() & 0o4000 != 0, "-g" => m.mode() & 0o2000 != 0, _ => m.mode() & 0o1000 != 0,
      })
    }
    _ => return Err(anyhow::anyhow!("tsh: {name}: {op}: unary operator expected").into()),
  })
}

fn test_compare(name: &str, left: &str, op: &str, right: &str) -> crate::Result<bool> {
  Ok(match op {
    "=" | "==" => left == right, "!=" => left != right, "<" => left < right, ">" => left > right,
    "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge" => {
      let a = left.trim_matches(|c: char| c.is_ascii_whitespace()).parse::<i64>().map_err(|_| anyhow::anyhow!("tsh: {name}: {left}: integer expression expected"))?;
      let b = right.trim_matches(|c: char| c.is_ascii_whitespace()).parse::<i64>().map_err(|_| anyhow::anyhow!("tsh: {name}: {right}: integer expression expected"))?;
      match op { "-eq" => a == b, "-ne" => a != b, "-lt" => a < b, "-le" => a <= b, "-gt" => a > b, _ => a >= b }
    }
    "-nt" | "-ot" => {
      let a = std::fs::metadata(left).and_then(|m| m.modified()).ok();
      let b = std::fs::metadata(right).and_then(|m| m.modified()).ok();
      if op == "-nt" { a.is_some() && (b.is_none() || a > b) } else { b.is_some() && (a.is_none() || a < b) }
    }
    #[cfg(unix)]
    "-ef" => {
      use std::os::unix::fs::MetadataExt;
      std::fs::metadata(left).ok().zip(std::fs::metadata(right).ok()).is_some_and(|(a,b)| a.dev() == b.dev() && a.ino() == b.ino())
    }
    _ => return Err(anyhow::anyhow!("tsh: {name}: {op}: binary operator expected").into()),
  })
}
