//! The `read` builtin with bash's options: `-a ARRAY`, `-d DELIM`, `-n N`,
//! `-N N`, `-t TIMEOUT`, `-u FD`, `-p PROMPT`, `-r`, and the accepted
//! interactive-only `-e`, `-E`, `-i TEXT`, `-s`. Names may be array
//! elements (`read 'a[2]'`).
//!
//! At the interactive prompt of an embedder that draws the terminal itself (a
//! session engine, whose descriptor 0 is not the terminal), a `read` of the
//! terminal asks the embedder for the line ([`TerminalRead`]); the line then
//! takes the same path a piped one does.
use std::io::Read as _;
use std::rc::Rc;
use std::time::{Duration, Instant};

use serde_json::Value as JsonValue;
use tento_lisp::{Env, Value as LispValue};

use super::bash_arrays;
use super::interp::LispHost;
use super::runner::TshScriptErrorKind;
use super::FdTarget;

type Result<T> = std::result::Result<T, TshScriptErrorKind>;

/// A `read` of the terminal at the interactive prompt, as the embedder that
/// collects the line sees it ([`super::ExternalCommands::read_terminal`]).
#[derive(Clone, Debug, PartialEq)]
pub struct TerminalRead {
  /// `-p PROMPT`: shown where the line is typed.
  pub prompt: Option<String>,
  /// `-s`: what is typed is not shown.
  pub secret: bool,
  /// `-t SECONDS` (never zero: `-t 0` only asks whether input is ready).
  pub timeout: Option<Duration>,
}

/// How the embedder answered a [`TerminalRead`].
#[derive(Clone, Debug, PartialEq)]
pub enum TerminalLine {
  /// The line that was sent, without the Enter that ended it.
  Line(String),
  /// End of input (Ctrl-D on an empty line): `read` fails with status 1.
  End,
  /// `-t` elapsed before a line was sent: status 142.
  TimedOut,
  /// The embedder parked the command line to ask for the line; the line
  /// replays once the answer is in, and this `read` unwinds now.
  Parked,
}

const USAGE: &str = "read: usage: read [-Eers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]";

#[derive(Default)]
struct Options {
  raw: bool,
  array: Option<String>,
  delimiter: Option<u8>,
  count: Option<usize>,
  exact: bool,
  timeout: Option<f64>,
  fd: i32,
  prompt: Option<String>,
  secret: bool,
}

enum Byte {
  Some(u8),
  End,
  TimedOut,
}

impl LispHost {
  pub(super) fn read_shell_builtin(&mut self, operands: &[String], line: usize) -> Result<Option<JsonValue>> {
    if let Some(gate) = &self.shell_builtin_gate {
      if let Err(error) = gate("read") {
        self.set_shell_status(error.process_status().unwrap_or(1));
        self.report_shell_diagnostic(format!("tsh: line {line}: read: {error}"));
        return Ok(None);
      }
    }
    let (options, names) = match parse_options(operands) {
      Ok(parsed) => parsed,
      Err(Refusal { message, status }) => {
        self.report_shell_diagnostic(format!("tsh: line {line}: read: {message}"));
        self.set_shell_status(status);
        return Ok(None);
      }
    };
    for name in names.iter().chain(options.array.iter()) {
      if !assignable(name) {
        self.report_shell_diagnostic(format!("tsh: line {line}: read: `{name}': not a valid identifier"));
        self.set_shell_status(1);
        return Ok(None);
      }
    }
    if options.fd != 0 && matches!(self.descriptor(options.fd), FdTarget::Closed) {
      let fd = options.fd;
      self.report_shell_diagnostic(format!(
        "tsh: line {line}: read: {fd}: invalid file descriptor: Bad file descriptor"
      ));
      self.set_shell_status(1);
      return Ok(None);
    }
    let delimiter = options.delimiter.unwrap_or(b'\n');
    // The terminal's answer, when the embedder collects it: its bytes, and
    // what reading past them yields.
    let mut terminal: Option<(std::collections::VecDeque<u8>, bool)> = None;
    if let Some(external) = self.prompt_terminal(options.fd) {
      if options.timeout == Some(0.0) {
        // Nothing is typed ahead at a prompt that waits for its line.
        self.set_shell_status(1);
        return Ok(None);
      }
      let request = TerminalRead {
        prompt: options.prompt.clone(),
        secret: options.secret,
        timeout: options.timeout.and_then(|seconds| Duration::try_from_secs_f64(seconds).ok()),
      };
      match external.read_terminal(&request) {
        None => {}
        Some(TerminalLine::Parked) => return Err(TshScriptErrorKind::BashStatus(self.shell_status())),
        Some(TerminalLine::Line(line)) => {
          // Enter ends the line as the delimiter would.
          let mut bytes: std::collections::VecDeque<u8> = line.into_bytes().into();
          bytes.push_back(delimiter);
          terminal = Some((bytes, false));
        }
        Some(TerminalLine::End) => terminal = Some((Default::default(), false)),
        Some(TerminalLine::TimedOut) => terminal = Some((Default::default(), true)),
      }
    }
    if let Some(prompt) = options.prompt.as_ref().filter(|_| terminal.is_none()) {
      #[cfg(unix)]
      // SAFETY: isatty only inspects descriptor 0.
      if options.fd == 0 && matches!(self.descriptor(0), FdTarget::Inherit(0)) && unsafe { libc::isatty(0) } == 1 {
        eprint!("{prompt}");
      }
    }
    // `-t 0` only asks whether input is ready.
    if options.timeout == Some(0.0) {
      let ready = self.descriptor_ready(options.fd, Duration::ZERO);
      self.set_shell_status(if ready { 0 } else { 1 });
      return Ok(None);
    }
    let deadline = options.timeout.map(|seconds| Instant::now() + Duration::from_secs_f64(seconds));
    let mut bytes = Vec::new();
    let mut protected = Vec::new();
    let mut escaped = false;
    let mut characters = 0;
    let mut pending = 0;
    let mut status = 0;
    if options.count != Some(0) {
      loop {
        if pending == 0 && options.count.is_some_and(|count| characters >= count) {
          break;
        }
        let next = match &mut terminal {
          Some((bytes, timed_out)) => Ok(match bytes.pop_front() {
            Some(byte) => Byte::Some(byte),
            None if *timed_out => Byte::TimedOut,
            None => Byte::End,
          }),
          None => self.read_descriptor_byte(options.fd, deadline),
        };
        let byte = match next {
          Ok(Byte::Some(byte)) => byte,
          Ok(Byte::End) => {
            status = 1;
            break;
          }
          Ok(Byte::TimedOut) => {
            status = 142;
            break;
          }
          Err(error) => {
            self.report_shell_diagnostic(format!("tsh: line {line}: read: {error}"));
            self.set_shell_status(1);
            return Ok(None);
          }
        };
        if pending > 0 {
          pending -= 1;
          bytes.push(byte);
          protected.push(escaped);
          continue;
        }
        if !options.exact {
          if !options.raw && !escaped && byte == b'\\' {
            escaped = true;
            continue;
          }
          if byte == delimiter && !escaped {
            break;
          }
          if escaped && byte == b'\n' {
            escaped = false;
            continue;
          }
        }
        characters += 1;
        pending = utf8_continuations(byte);
        if byte != 0 || options.exact {
          bytes.push(byte);
          protected.push(escaped);
        }
        escaped = false;
      }
    }
    let text = String::from_utf8(bytes).map_err(|_| {
      TshScriptErrorKind::Lisp(super::interp::LispHostError::Command(
        "read: input is not UTF-8 — byte-valued variables are not supported yet".into(),
      ))
    })?;
    let ifs = self.read_ifs();
    let assigned = if let Some(array) = &options.array {
      let fields = if options.exact { vec![text] } else { split_all(&text, &protected, &ifs) };
      self.read_assign_array(array, fields, line)
    } else if names.is_empty() {
      self.read_assign(&"REPLY".to_string(), text, line)
    } else if options.exact {
      // `-N` keeps the input whole: no IFS splitting or trimming.
      let mut ok = self.read_assign(&names[0], text, line);
      for name in &names[1..] {
        ok &= self.read_assign(name, String::new(), line);
      }
      ok
    } else {
      let fields = super::bash_compound::read_fields(&text, &protected, &ifs, names.len());
      let mut ok = true;
      for (name, value) in names.iter().zip(fields.into_iter().chain(std::iter::repeat(String::new()))) {
        ok &= self.read_assign(name, value, line);
        if !ok {
          break;
        }
      }
      ok
    };
    if !assigned {
      self.set_shell_status(1);
      return Ok(None);
    }
    self.set_shell_status(status);
    Ok(None)
  }

  /// The embedder that collects a `read` of `fd` at the interactive prompt:
  /// descriptor 0, not redirected, not fed by a pipe, a here-string or a
  /// file. `None` anywhere else (scripts, `tsh -c`, redirected input), and
  /// where the embedder has no terminal door of its own.
  fn prompt_terminal(&self, fd: i32) -> Option<Rc<dyn super::ExternalCommands>> {
    if fd != 0 || !self.shell_prompt || self.shell_stdin.borrow().is_some() {
      return None;
    }
    if !matches!(self.descriptor(0), FdTarget::Inherit(0)) {
      return None;
    }
    self.external.clone()
  }

  fn read_ifs(&mut self) -> String {
    let prefixed = self
      .shell_io
      .borrow()
      .as_ref()
      .and_then(|io| io.1.iter().rev().find(|(name, _)| name == "IFS").map(|(_, value)| value.clone()));
    let symbol = self.interp.string_interner().get_or_intern("IFS");
    prefixed
      .or_else(|| match self.env.borrow().get(symbol) {
        Some(LispValue::String(text)) => Some(text.into_string()),
        _ => None,
      })
      .or_else(|| tento_env::effective_var("IFS"))
      .unwrap_or_else(|| " \t\n".into())
  }

  fn descriptor(&self, fd: i32) -> FdTarget {
    if let Some(io) = self.shell_io.borrow().as_ref() {
      return io.target(fd);
    }
    if let Some(io) = &self.shell_compound.commands.persistent_io {
      return io.target(fd);
    }
    if (0..3).contains(&fd) { FdTarget::Inherit(fd) } else { FdTarget::Closed }
  }

  fn descriptor_ready(&mut self, fd: i32, wait: Duration) -> bool {
    match self.descriptor(fd) {
      FdTarget::Inherit(raw) if !(fd == 0 && self.shell_stdin.borrow().is_some()) => poll_readable(raw, wait),
      FdTarget::Closed => false,
      _ => true,
    }
  }

  fn read_descriptor_byte(&mut self, fd: i32, deadline: Option<Instant>) -> std::io::Result<Byte> {
    if let Some(deadline) = deadline {
      let wait = deadline.saturating_duration_since(Instant::now());
      if !self.descriptor_ready(fd, wait) {
        return Ok(Byte::TimedOut);
      }
    }
    let byte = if fd == 0 {
      self.read_shell_byte()?
    } else {
      match self.descriptor(fd) {
        FdTarget::File(file) => {
          let mut byte = [0];
          ((&*file).read(&mut byte)? != 0).then_some(byte[0])
        }
        FdTarget::Text(text) => {
          let mut bytes = text.lock().map_err(|_| std::io::Error::other("input lock is poisoned"))?;
          if bytes.is_empty() { None } else { Some(bytes.remove(0)) }
        }
        FdTarget::Closed => return Err(std::io::Error::from_raw_os_error(9)),
        FdTarget::Inherit(raw) => read_raw_byte(raw)?,
      }
    };
    Ok(byte.map_or(Byte::End, Byte::Some))
  }

  /// Assign one read field; false (after a diagnostic) when refused.
  fn read_assign(&mut self, name: &String, value: String, line: usize) -> bool {
    let (base, subscript) = split_subscript(name);
    if self.shell_readonly(base) {
      self.report_shell_diagnostic(format!("tsh: line {line}: {base}: readonly variable"));
      return false;
    }
    let Some(subscript) = subscript else {
      self.assign_shell_variable(name, value, false);
      return true;
    };
    let symbol = self.interp.string_interner().get_or_intern(base);
    self.refresh_shell_symbols();
    let bound = self.env.borrow().get(symbol);
    let associative = self.shell_compound.commands.attributes.borrow().get(base).is_some_and(|a| a.associative);
    let array = if let Some(mut entries) = bound.as_ref().and_then(bash_arrays::associative_entries) {
      entries.insert(subscript.into(), value);
      bash_arrays::associative_value(entries)
    } else if associative {
      bash_arrays::associative_value([(subscript.to_string(), value)].into())
    } else {
      let mut entries = match &bound {
        Some(LispValue::String(text)) => [(0, text.to_string())].into(),
        Some(other) => bash_arrays::entries(other).unwrap_or_default(),
        None => Default::default(),
      };
      let Ok(index) = self.integer_shell_value(subscript) else { return false };
      let index: i64 = index.trim().parse().unwrap_or(0);
      let index = if index < 0 { entries.last_key_value().map_or(0, |(n, _)| n + 1) + index } else { index };
      entries.insert(index, value);
      bash_arrays::value(entries)
    };
    if self.env.borrow_mut().set(symbol, array.clone()).is_err() {
      Env::root_of(&self.env).borrow_mut().define(symbol, array);
    }
    true
  }

  fn read_assign_array(&mut self, name: &str, fields: Vec<String>, line: usize) -> bool {
    if self.shell_readonly(name) {
      self.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly variable"));
      return false;
    }
    let symbol = self.interp.string_interner().get_or_intern(name);
    self.refresh_shell_symbols();
    let array = bash_arrays::value(fields.into_iter().enumerate().map(|(i, field)| (i as i64, field)).collect());
    if self.env.borrow_mut().set(symbol, array.clone()).is_err() {
      Env::root_of(&self.env).borrow_mut().define(symbol, array);
    }
    true
  }
}

impl LispHost {
  /// `printf -v NAME FORMAT [ARG…]`: the formatted text goes to NAME (an
  /// array element too) instead of stdout.
  pub(super) async fn printf_to_variable(&mut self, args: &[String], line: usize, _ignored: bool) -> Result<Option<JsonValue>> {
    // Validate the name before formatting, as bash does (no `%n` effects).
    if let Some(name) = super::bash_printf::variable_operand(args) {
      if !assignable(&name) {
        self.report_shell_diagnostic(format!("tsh: line {line}: printf: `{name}': not a valid identifier"));
        self.set_shell_status(2);
        return Ok(None);
      }
    }
    let (name, output) = self.printf_run(args, line);
    for diagnostic in output.diagnostics {
      self.report_shell_diagnostic(diagnostic);
    }
    let Some(name) = name.filter(|_| output.status != 2) else {
      self.set_shell_status(output.status);
      return Ok(None);
    };
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if !self.read_assign(&name, text, line) {
      self.set_shell_status(1);
      return Ok(None);
    }
    self.set_shell_status(output.status);
    Ok(None)
  }
}

const MAPFILE_USAGE: &str = "mapfile: usage: mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]";

impl LispHost {
  /// `mapfile`/`readarray`: lines (or `-d` records) into an indexed array.
  pub(super) fn mapfile_builtin(&mut self, args: &[String], line: usize) -> Result<Option<JsonValue>> {
    let refuse = |host: &mut Self, message: String, status: i32| {
      host.report_shell_diagnostic(format!("tsh: line {line}: mapfile: {message}"));
      host.set_shell_status(status);
      Ok(None)
    };
    let (mut delimiter, mut limit, mut origin, mut skip, mut trim, mut fd) = (b'\n', 0usize, None, 0usize, false, 0);
    let mut index = 0;
    while let Some(arg) = args.get(index) {
      index += 1;
      if arg == "--" {
        break;
      }
      if !arg.starts_with('-') || arg.len() == 1 {
        index -= 1;
        break;
      }
      let flags: Vec<char> = arg[1..].chars().collect();
      let mut at = 0;
      while at < flags.len() {
        let flag = flags[at];
        at += 1;
        if flag == 't' {
          trim = true;
          continue;
        }
        if !matches!(flag, 'd' | 'n' | 'O' | 's' | 'u' | 'C' | 'c') {
          return refuse(self, format!("-{flag}: invalid option\n{MAPFILE_USAGE}"), 2);
        }
        let value = if at < flags.len() {
          let value: String = flags[at..].iter().collect();
          at = flags.len();
          value
        } else if let Some(value) = args.get(index) {
          index += 1;
          value.clone()
        } else {
          return refuse(self, format!("-{flag}: option requires an argument\n{MAPFILE_USAGE}"), 2);
        };
        let number = value.parse::<usize>();
        match flag {
          'd' => delimiter = value.bytes().next().unwrap_or(0),
          'n' => match number {
            Ok(count) => limit = count,
            Err(_) => return refuse(self, format!("{value}: invalid line count"), 1),
          },
          's' => match number {
            Ok(count) => skip = count,
            Err(_) => return refuse(self, format!("{value}: invalid line count"), 1),
          },
          'O' => match number {
            Ok(start) => origin = Some(start as i64),
            Err(_) => return refuse(self, format!("{value}: invalid array origin"), 1),
          },
          'u' => match value.parse::<i32>() {
            Ok(number) if number >= 0 => fd = number,
            _ => return refuse(self, format!("{value}: invalid file descriptor specification"), 1),
          },
          _ => return refuse(self, format!("-{flag}: callbacks are not supported yet"), 2),
        }
      }
    }
    let name = args.get(index).map_or("MAPFILE", String::as_str);
    if !assignable(name) || name.contains('[') {
      return refuse(self, format!("`{name}': not a valid identifier"), 1);
    }
    let attr = self.shell_compound.commands.attributes.borrow().get(name).copied().unwrap_or_default();
    if attr.readonly {
      self.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly variable"));
      self.set_shell_status(1);
      return Ok(None);
    }
    if attr.associative {
      return refuse(self, format!("{name}: not an indexed array"), 1);
    }
    if fd != 0 && matches!(self.descriptor(fd), FdTarget::Closed) {
      return refuse(self, format!("{fd}: invalid file descriptor: Bad file descriptor"), 1);
    }
    let symbol = self.interp.string_interner().get_or_intern(name);
    self.refresh_shell_symbols();
    // Without -O the array is replaced; with it, earlier elements stay.
    let mut entries = match origin {
      Some(_) => self.env.borrow().get(symbol).and_then(|v| bash_arrays::entries(&v)).unwrap_or_default(),
      None => Default::default(),
    };
    let mut next = origin.unwrap_or(0);
    let (mut read, mut stored) = (0usize, 0usize);
    let mut record = Vec::new();
    let mut truncated = false;
    while limit == 0 || stored < limit {
      let byte = match self.read_descriptor_byte(fd, None) {
        Ok(Byte::Some(byte)) => Some(byte),
        Ok(_) => None,
        Err(error) => return refuse(self, error.to_string(), 1),
      };
      let end = byte.is_none_or(|byte| byte == delimiter);
      if let Some(byte) = byte {
        // A record is a C string: bytes after a NUL are dropped.
        if byte == 0 && delimiter != 0 {
          truncated = true;
        } else if !truncated && !(trim && end) {
          record.push(byte);
        }
      }
      if !end {
        continue;
      }
      if byte.is_none() && record.is_empty() && !truncated {
        break;
      }
      read += 1;
      let text = String::from_utf8(std::mem::take(&mut record))
        .map_err(|_| TshScriptErrorKind::Lisp(super::interp::LispHostError::Command("mapfile: input is not UTF-8".into())))?;
      truncated = false;
      if read > skip {
        entries.insert(next, text);
        next += 1;
        stored += 1;
      }
      if byte.is_none() {
        break;
      }
    }
    let value = bash_arrays::value(entries);
    if self.env.borrow_mut().set(symbol, value.clone()).is_err() {
      Env::root_of(&self.env).borrow_mut().define(symbol, value);
    }
    self.shell_compound.commands.attributes.borrow_mut().entry(name.into()).or_default().indexed = true;
    self.set_shell_status(0);
    Ok(None)
  }
}

struct Refusal {
  message: String,
  status: i32,
}

fn parse_options(operands: &[String]) -> std::result::Result<(Options, Vec<String>), Refusal> {
  let mut options = Options::default();
  let mut index = 0;
  let invalid = |flag: char| Refusal { message: format!("-{flag}: invalid option\n{USAGE}"), status: 2 };
  while let Some(arg) = operands.get(index) {
    index += 1;
    if arg == "--" {
      break;
    }
    if !arg.starts_with('-') || arg.len() == 1 {
      index -= 1;
      break;
    }
    let flags: Vec<char> = arg[1..].chars().collect();
    let mut at = 0;
    while at < flags.len() {
      let flag = flags[at];
      at += 1;
      match flag {
        'r' => options.raw = true,
        'e' | 'E' => {}
        's' => options.secret = true,
        'a' | 'd' | 'i' | 'n' | 'N' | 'p' | 't' | 'u' => {
          let value = if at < flags.len() {
            let value: String = flags[at..].iter().collect();
            at = flags.len();
            value
          } else if let Some(value) = operands.get(index) {
            index += 1;
            value.clone()
          } else {
            return Err(Refusal { message: format!("-{flag}: option requires an argument\n{USAGE}"), status: 2 });
          };
          match flag {
            'a' => options.array = Some(value),
            'd' => options.delimiter = Some(value.bytes().next().unwrap_or(0)),
            'i' => {}
            'p' => options.prompt = Some(value),
            'n' | 'N' => {
              let count = value.parse::<usize>().map_err(|_| Refusal {
                message: format!("{value}: invalid number"),
                status: 1,
              })?;
              options.count = Some(count);
              options.exact = flag == 'N';
            }
            't' => {
              let seconds = value.parse::<f64>().ok().filter(|s| s.is_finite() && *s >= 0.0).ok_or_else(|| Refusal {
                message: format!("{value}: invalid timeout specification"),
                status: 1,
              })?;
              options.timeout = Some(seconds);
            }
            _ => {
              options.fd = value.parse::<i32>().ok().filter(|fd| *fd >= 0).ok_or_else(|| Refusal {
                message: format!("{value}: invalid file descriptor specification"),
                status: 1,
              })?;
            }
          }
        }
        _ => return Err(invalid(flag)),
      }
    }
  }
  Ok((options, operands[index..].to_vec()))
}

fn split_subscript(name: &str) -> (&str, Option<&str>) {
  match name.strip_suffix(']').and_then(|n| n.split_once('[')) {
    Some((base, subscript)) => (base, Some(subscript)),
    None => (name, None),
  }
}

fn assignable(name: &str) -> bool {
  let (base, _) = split_subscript(name);
  !base.is_empty()
    && !base.as_bytes()[0].is_ascii_digit()
    && base.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn utf8_continuations(byte: u8) -> usize {
  match byte {
    0xC0..=0xDF => 1,
    0xE0..=0xEF => 2,
    0xF0..=0xF7 => 3,
    _ => 0,
  }
}

/// Every IFS field, as `read -a` assigns them: IFS whitespace is trimmed and
/// coalesces, and a delimiter that ends the input adds no empty field.
fn split_all(text: &str, protected: &[bool], ifs: &str) -> Vec<String> {
  let chars: Vec<(usize, char)> = text.char_indices().collect();
  let delimiter = |i: usize| !protected.get(chars[i].0).copied().unwrap_or(false) && ifs.contains(chars[i].1);
  let whitespace = |i: usize| delimiter(i) && matches!(chars[i].1, ' ' | '\t' | '\n');
  let (mut start, mut end) = (0, chars.len());
  while start < end && whitespace(start) {
    start += 1;
  }
  while end > start && whitespace(end - 1) {
    end -= 1;
  }
  let mut fields = Vec::new();
  let mut current = String::new();
  let mut open = false;
  let mut i = start;
  while i < end {
    if delimiter(i) {
      fields.push(std::mem::take(&mut current));
      open = false;
      let ws = whitespace(i);
      i += 1;
      while i < end && whitespace(i) {
        i += 1;
      }
      if ws && i < end && delimiter(i) && !whitespace(i) {
        i += 1;
        while i < end && whitespace(i) {
          i += 1;
        }
      }
      continue;
    }
    current.push(chars[i].1);
    open = true;
    i += 1;
  }
  if open {
    fields.push(current);
  }
  fields
}

#[cfg(unix)]
fn poll_readable(fd: i32, wait: Duration) -> bool {
  let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
  let millis = i32::try_from(wait.as_millis()).unwrap_or(i32::MAX);
  // SAFETY: one valid pollfd for the duration of the call.
  unsafe { libc::poll(&mut poll, 1, millis) > 0 }
}

#[cfg(not(unix))]
fn poll_readable(_fd: i32, _wait: Duration) -> bool {
  true
}

#[cfg(unix)]
fn read_raw_byte(fd: i32) -> std::io::Result<Option<u8>> {
  let mut byte = [0u8];
  loop {
    // SAFETY: reads at most one byte into a live buffer.
    let count = unsafe { libc::read(fd, byte.as_mut_ptr().cast(), 1) };
    if count >= 0 {
      return Ok((count != 0).then_some(byte[0]));
    }
    let error = std::io::Error::last_os_error();
    if error.kind() != std::io::ErrorKind::Interrupted {
      return Err(error);
    }
  }
}

#[cfg(not(unix))]
fn read_raw_byte(_fd: i32) -> std::io::Result<Option<u8>> {
  Err(std::io::Error::other("read -u is not supported on this platform"))
}

#[cfg(test)]
mod tests {
  use super::split_all;
  use super::{TerminalLine, TerminalRead};
  use crate::script::{AsyncCommandFut, ExternalCommands, ExternalLookup, LispHost, OnError, RunOptions};
  use std::cell::RefCell;
  use std::rc::Rc;

  /// An embedder whose terminal is not descriptor 0: it records each ask and
  /// answers from a script, parking while the script is empty.
  #[derive(Default)]
  struct Viewer {
    asked: RefCell<Vec<TerminalRead>>,
    answers: RefCell<Vec<TerminalLine>>,
    parked: std::cell::Cell<bool>,
  }

  impl ExternalCommands for Viewer {
    fn lookup(&self, _head: &str) -> ExternalLookup {
      ExternalLookup::NotFound
    }
    fn run(&self, _argv: Vec<String>) -> AsyncCommandFut {
      Box::pin(async { Ok(serde_json::Value::Null) })
    }
    fn suggest(&self, _typed: &str) -> Option<String> {
      None
    }
    fn suspended(&self) -> bool {
      self.parked.get()
    }
    fn read_terminal(&self, request: &TerminalRead) -> Option<TerminalLine> {
      self.asked.borrow_mut().push(request.clone());
      let mut answers = self.answers.borrow_mut();
      if answers.is_empty() {
        self.parked.set(true);
        return Some(TerminalLine::Parked);
      }
      Some(answers.remove(0))
    }
  }

  async fn line(host: &mut LispHost, source: &str, prompt: bool) -> Result<(), crate::script::TshScriptError> {
    crate::script::run_source_on_host(
      host,
      source,
      &crate::shell::Scripts::new(()),
      &std::collections::HashMap::new(),
      &[],
      RunOptions { on_error: OnError::Bash, prompt, ..RunOptions::default() },
    )
    .await
    .map(|_| ())
  }

  fn text(host: &mut LispHost, name: &str) -> String {
    match host.eval_to_json(name) {
      Ok(serde_json::Value::String(text)) => text,
      Ok(other) => other.to_string(),
      Err(_) => String::new(),
    }
  }

  #[tokio::test]
  async fn a_prompt_read_of_the_terminal_asks_the_embedder() {
    let viewer = Rc::new(Viewer::default());
    let mut host = LispHost::new();
    host.set_external_commands(viewer.clone());
    viewer.answers.borrow_mut().extend([TerminalLine::Line("one  two three".into()), TerminalLine::End]);
    line(&mut host, "read -s -p 'who? ' a b; s1=$?; read c; s2=$?", true).await.unwrap();
    assert_eq!(text(&mut host, "a"), "one");
    assert_eq!(text(&mut host, "b"), "two three");
    assert_eq!(text(&mut host, "s1"), "0");
    assert_eq!(text(&mut host, "s2"), "1", "end of input fails the read");
    let asked = viewer.asked.borrow();
    assert_eq!(asked[0], TerminalRead { prompt: Some("who? ".into()), secret: true, timeout: None });
    assert_eq!(asked[1].prompt, None);
  }

  #[tokio::test]
  async fn a_parked_read_unwinds_the_line_and_other_input_never_asks() {
    let viewer = Rc::new(Viewer::default());
    let mut host = LispHost::new();
    host.set_external_commands(viewer.clone());
    let stopped = line(&mut host, "read x; after=1", true).await.unwrap_err();
    assert!(stopped.is_bash_status(), "a parked read unwinds as a suspension");
    assert!(host.eval_to_json("after").is_err(), "nothing after the read ran");
    viewer.parked.set(false);
    viewer.asked.borrow_mut().clear();
    line(&mut host, "read y <<< word; echo hi | { read z; }; read -t 0 w; t=$?", true).await.unwrap();
    assert_eq!(text(&mut host, "y"), "word");
    assert_eq!(text(&mut host, "t"), "1", "nothing is typed ahead at a waiting prompt");
    line(&mut host, "read -t 0 v", false).await.unwrap();
    assert!(viewer.asked.borrow().is_empty(), "only the prompt's terminal reads ask");
  }

  #[test]
  fn read_a_fields_keep_empty_middles_and_drop_a_trailing_delimiter() {
    let split = |text: &str, ifs: &str| split_all(text, &vec![false; text.len()], ifs);
    assert_eq!(split("a,b,,c", ","), ["a", "b", "", "c"]);
    assert_eq!(split("a,b,", ","), ["a", "b"]);
    assert_eq!(split("  p q  r ", " \t\n"), ["p", "q", "r"]);
    assert!(split("", " \t\n").is_empty());
  }
}
