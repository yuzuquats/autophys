//! Bash's `printf` builtin, in process: the whole format language of bash
//! 5.3 (`printf.def`), never the platform's `/usr/bin/printf`.
//!
//! Numeric conversions are handed to the C library's `snprintf` with the
//! same specification bash builds, so flags, widths and precisions print
//! byte-for-byte as bash's do; arguments are read with `strtoll`/`strtoull`
//! /`strtod` for the same reason. Strings are measured in bytes, as bash's
//! `%s` and `%b` are. Differences from bash 3.2: 3.2 has no `%(fmt)T`, no
//! `%Q`, no `-v` array elements, prints `0` (not the partial value) after an
//! invalid number, only warns (status 0) on an out-of-range number, reads
//! `'c` as a signed byte and has no `\u`/`\U` escapes.
use std::ffi::{CStr, CString};

/// One `printf` run: the bytes it printed, its diagnostics (bodies after the
/// `printf: ` prefix, or a whole line for the usage text), its status and the
/// `%n` assignments it asked for.
#[derive(Debug, Default)]
pub(super) struct Printed {
  pub stdout: Vec<u8>,
  pub errors: Vec<Diagnostic>,
  pub status: i32,
  pub assignments: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum Diagnostic {
  /// `printf: DETAIL`, prefixed with the shell's location by the caller.
  Error(String),
  /// A whole line printed as is (the usage line).
  Plain(String),
}

pub(super) const USAGE: &str = "printf: usage: printf [-v var] format [arguments]";

/// The parsed command line: `-v NAME` and the format's index.
pub(super) enum Invocation<'a> {
  Run { variable: Option<String>, format: &'a str, args: &'a [String] },
  /// Option or usage error; already-built diagnostics and status 2.
  Refused(Printed),
}

/// Parse `printf`'s options like bash's `internal_getopt (list, "v:")`.
pub(super) fn parse(args: &[String]) -> Invocation<'_> {
  let mut variable = None;
  let mut index = 0;
  while let Some(arg) = args.get(index) {
    if arg == "--" {
      index += 1;
      break;
    }
    if !arg.starts_with('-') || arg == "-" {
      break;
    }
    let Some(rest) = arg.strip_prefix("-v") else {
      let flag: String = arg.chars().take(2).collect();
      return refused(vec![Diagnostic::Error(format!("{flag}: invalid option")), Diagnostic::Plain(USAGE.into())]);
    };
    if !rest.is_empty() {
      variable = Some(rest.to_string());
      index += 1;
      continue;
    }
    let Some(name) = args.get(index + 1) else {
      return refused(vec![
        Diagnostic::Error("-v: option requires an argument".into()),
        Diagnostic::Plain(USAGE.into()),
      ]);
    };
    variable = Some(name.clone());
    index += 2;
  }
  let Some(format) = args.get(index) else {
    return refused(vec![Diagnostic::Plain(USAGE.into())]);
  };
  Invocation::Run { variable, format, args: &args[index + 1..] }
}

/// The `-v` operand, when the command line names one.
pub(super) fn variable_operand(args: &[String]) -> Option<String> {
  match parse(args) {
    Invocation::Run { variable, .. } => variable,
    Invocation::Refused(_) => None,
  }
}

fn refused(errors: Vec<Diagnostic>) -> Invocation<'static> {
  Invocation::Refused(Printed { errors, status: 2, ..Default::default() })
}

/// Settings read from the shell at the moment `printf` runs.
#[derive(Clone, Debug, Default)]
pub(super) struct Context {
  /// The locale decodes multibyte characters (`'é` is 233, not 195).
  pub utf8: bool,
  /// Seconds since the epoch at which the shell started, for `%(…)T` -2.
  pub started: i64,
}

impl Context {
  /// The locale and start time as the shell sees them now.
  pub(super) fn current() -> Self {
    let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
      .into_iter()
      .find_map(|name| {
        let value = if tento_env::global_env_map().is_some() {
          tento_env::effective_var(name)
        } else {
          std::env::var(name).ok()
        };
        value.filter(|value| !value.is_empty())
      })
      .unwrap_or_default()
      .to_ascii_lowercase();
    let now = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map_or(0, |elapsed| elapsed.as_secs() as i64);
    Context {
      utf8: locale.contains("utf-8") || locale.contains("utf8"),
      started: now - super::bash_attributes::shell_elapsed().as_secs() as i64,
    }
  }
}

/// Format `format` over `args`, reusing the format while arguments remain.
pub(super) fn format(format: &str, args: &[String], context: &Context) -> Printed {
  let mut run = Run { out: Vec::new(), printed: Printed::default(), args, next: 0, context, conversion_error: false };
  if format.is_empty() {
    return run.printed;
  }
  loop {
    let consumed_before = run.next;
    match run.pass(format.as_bytes()) {
      Flow::Continue => {}
      Flow::Stop(status) => {
        run.printed.status = status;
        run.printed.stdout = run.out;
        return run.printed;
      }
    }
    if run.next >= args.len() || run.next == consumed_before {
      break;
    }
  }
  run.printed.status = i32::from(run.conversion_error);
  run.printed.stdout = run.out;
  run.printed
}

enum Flow {
  Continue,
  /// Stop printing (an error, or `\c` in `%b`) with this status.
  Stop(i32),
}

struct Run<'a> {
  out: Vec<u8>,
  printed: Printed,
  args: &'a [String],
  next: usize,
  context: &'a Context,
  conversion_error: bool,
}

/// One conversion's flags, width and precision as bash parsed them.
struct Spec {
  flags: String,
  /// `Some` when the width was given (digits or `*`).
  width: Option<i64>,
  /// `Some` when the precision was given; a negative one means none.
  precision: Option<i64>,
}

impl Spec {
  /// The C specification for conversion `conversion` (with `length`).
  fn c_format(&self, length: &str, conversion: char) -> CString {
    let mut flags = self.flags.clone();
    let mut text = String::from("%");
    let width = self.width.map(|width| {
      if width < 0 {
        if !flags.contains('-') {
          flags.push('-');
        }
        width.unsigned_abs()
      } else {
        width as u64
      }
    });
    text.push_str(&flags);
    if let Some(width) = width {
      text.push_str(&width.to_string());
    }
    if let Some(precision) = self.precision.filter(|precision| *precision >= 0) {
      text.push('.');
      text.push_str(&precision.to_string());
    }
    text.push_str(length);
    text.push(conversion);
    CString::new(text).expect("printf specification has no NUL")
  }
}

impl Run<'_> {
  fn error(&mut self, detail: String) {
    self.printed.errors.push(Diagnostic::Error(detail));
  }

  fn arg(&mut self) -> Option<&str> {
    let arg = self.args.get(self.next)?;
    self.next += 1;
    Some(arg.as_str())
  }

  fn pass(&mut self, format: &[u8]) -> Flow {
    let mut i = 0;
    while i < format.len() {
      let byte = format[i];
      if byte == b'\\' {
        i += 1;
        let (bytes, used) = self.escape(&format[i..], false);
        self.out.extend_from_slice(&bytes);
        i += used;
        continue;
      }
      if byte != b'%' {
        self.out.push(byte);
        i += 1;
        continue;
      }
      let start = i;
      i += 1;
      if format.get(i) == Some(&b'%') {
        self.out.push(b'%');
        i += 1;
        continue;
      }
      let flags_start = i;
      while format.get(i).is_some_and(|ch| b"#'-+ 0".contains(ch)) {
        i += 1;
      }
      let flags = String::from_utf8_lossy(&format[flags_start..i]).into_owned();
      let mut spec = Spec { flags, width: None, precision: None };
      if format.get(i) == Some(&b'*') {
        i += 1;
        spec.width = Some(self.int_argument());
      } else {
        let digits = i;
        while format.get(i).is_some_and(u8::is_ascii_digit) {
          i += 1;
        }
        if i > digits {
          spec.width = Some(parse_digits(&format[digits..i]));
        }
      }
      if format.get(i) == Some(&b'.') {
        i += 1;
        if format.get(i) == Some(&b'*') {
          i += 1;
          spec.precision = Some(self.int_argument());
        } else {
          let negative = format.get(i) == Some(&b'-');
          if negative {
            i += 1;
          }
          let digits = i;
          while format.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
          }
          let value = parse_digits(&format[digits..i]);
          spec.precision = Some(if negative { -1 } else { value });
        }
      }
      while format.get(i).is_some_and(|ch| b"hjlLtz".contains(ch)) {
        i += 1;
      }
      let Some(&conversion) = format.get(i) else {
        self.error(format!("`{}': missing format character", String::from_utf8_lossy(&format[start..])));
        return Flow::Stop(1);
      };
      i += 1;
      match conversion {
        b'c' => {
          let byte = self.arg().and_then(|arg| arg.as_bytes().first().copied()).unwrap_or(0);
          let spec = spec.c_format("", 'c');
          self.out.extend(c_print(&spec, CArg::Int(i32::from(byte))));
        }
        b's' => {
          let text = self.arg().unwrap_or("").to_string();
          let spec = spec.c_format("", 's');
          self.out.extend(c_print(&spec, CArg::Str(c_string(&text))));
        }
        b'n' => {
          let name = self.arg().unwrap_or("").to_string();
          if !name.is_empty() {
            if !valid_identifier(&name) {
              self.error(format!("`{name}': not a valid identifier"));
              return Flow::Stop(1);
            }
            let written = self.out.len().to_string();
            self.printed.assignments.push((name, written));
          }
        }
        b'b' => {
          let text = self.arg().unwrap_or("").to_string();
          let (bytes, stop) = self.expand_b(text.as_bytes());
          print_padded(&mut self.out, &spec, &bytes);
          if stop {
            return Flow::Stop(i32::from(self.conversion_error));
          }
        }
        b'q' | b'Q' => {
          let mut raw = self.arg().unwrap_or("").to_string();
          if conversion == b'Q' {
            if let Some(precision) = spec.precision.filter(|precision| *precision >= 0) {
              let cut = (precision as usize).min(raw.len());
              raw = String::from_utf8_lossy(&raw.as_bytes()[..cut]).into_owned();
            }
          }
          let quoted = if spec.flags.contains('#') {
            super::shell_printf::quote_alternate(&raw)
          } else {
            super::shell_printf::quote(&raw)
          };
          let spec = if conversion == b'Q' { Spec { precision: None, ..spec } } else { spec };
          print_padded(&mut self.out, &spec, quoted.as_bytes());
        }
        b'(' => self.time(format, &mut i, start, &spec),
        b'd' | b'i' => {
          let value = self.int_argument_wide();
          let spec = spec.c_format("ll", conversion as char);
          self.out.extend(c_print(&spec, CArg::Long(value)));
        }
        b'o' | b'u' | b'x' | b'X' => {
          let value = self.uint_argument();
          let spec = spec.c_format("ll", conversion as char);
          self.out.extend(c_print(&spec, CArg::ULong(value)));
        }
        b'e' | b'E' | b'f' | b'F' | b'g' | b'G' | b'a' | b'A' => {
          let value = self.float_argument();
          let spec = spec.c_format("", conversion as char);
          self.out.extend(c_print(&spec, CArg::Double(value)));
        }
        other => {
          let text = if other.is_ascii() {
            (other as char).to_string()
          } else {
            String::from_utf8_lossy(&format[i - 1..i]).into_owned()
          };
          self.error(format!("`{text}': invalid format character"));
          return Flow::Stop(1);
        }
      }
    }
    Flow::Continue
  }

  /// `%(FMT)T`: `i` is just past the `(` and moves past the `T`. An invalid
  /// specification prints its `%` and rescans from the character after it.
  fn time(&mut self, format: &[u8], i: &mut usize, start: usize, spec: &Spec) {
    let mut depth = 1;
    let mut end = *i;
    while end < format.len() {
      match format[end] {
        b'(' => depth += 1,
        b')' => depth -= 1,
        _ => {}
      }
      if depth == 0 {
        break;
      }
      end += 1;
    }
    let mut time_format = format[*i..end.min(format.len())].to_vec();
    if format.get(end + 1) != Some(&b'T') {
      let found = format.get(end + 1).map_or(String::new(), |ch| (*ch as char).to_string());
      self.printed.errors.push(Diagnostic::Error(format!("warning: `{found}': invalid time format specification")));
      self.out.push(b'%');
      *i = start + 1;
      return;
    }
    *i = end + 2;
    if time_format.is_empty() {
      time_format = b"%X".to_vec();
    }
    let seconds = if self.next < self.args.len() { self.int_argument_wide() } else { -1 };
    let seconds = match seconds {
      -1 => std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64),
      -2 => self.context.started,
      other => other,
    };
    let text = strftime(&time_format, seconds);
    print_padded(&mut self.out, spec, &text);
  }

  /// One backslash escape (the backslash already consumed): the bytes and
  /// how much of `rest` it used. `in_b` selects `%b`'s rules.
  fn escape(&mut self, rest: &[u8], in_b: bool) -> (Vec<u8>, usize) {
    let Some(&c) = rest.first() else {
      return (b"\\".to_vec(), 0);
    };
    let simple = |byte: u8| (vec![byte], 1);
    match c {
      b'a' => simple(0x07),
      b'b' => simple(0x08),
      b'e' | b'E' => simple(0x1b),
      b'f' => simple(0x0c),
      b'n' => simple(b'\n'),
      b'r' => simple(b'\r'),
      b't' => simple(b'\t'),
      b'v' => simple(0x0b),
      b'0'..=b'7' => {
        let mut value = u32::from(c - b'0');
        let mut more = if value == 0 && in_b { 3 } else { 2 };
        let mut used = 1;
        while more > 0 && rest.get(used).is_some_and(|ch| (b'0'..=b'7').contains(ch)) {
          value = value * 8 + u32::from(rest[used] - b'0');
          used += 1;
          more -= 1;
        }
        (vec![(value & 0xff) as u8], used)
      }
      b'x' => {
        let mut value = 0u32;
        let mut used = 1;
        while used < 3 && rest.get(used).is_some_and(u8::is_ascii_hexdigit) {
          value = value * 16 + (rest[used] as char).to_digit(16).unwrap();
          used += 1;
        }
        if used == 1 {
          self.error("missing hex digit for \\x".into());
          return (b"\\".to_vec(), 0);
        }
        (vec![(value & 0xff) as u8], used)
      }
      b'u' | b'U' => {
        let limit = if c == b'u' { 4 } else { 8 };
        let mut value = 0u32;
        let mut used = 1;
        while used <= limit && rest.get(used).is_some_and(u8::is_ascii_hexdigit) {
          value = value.wrapping_mul(16) + (rest[used] as char).to_digit(16).unwrap();
          used += 1;
        }
        if used == 1 {
          self.error(format!("missing unicode digit for \\{}", c as char));
          return (b"\\".to_vec(), 0);
        }
        let bytes = match char::from_u32(value) {
          Some(ch) => ch.to_string().into_bytes(),
          None => {
            // bash prints an unencodable code point in its escaped form.
            let width = if value > 0xffff { 8 } else { 4 };
            format!("\\{}{value:0width$X}", if width == 8 { 'U' } else { 'u' }).into_bytes()
          }
        };
        (bytes, used)
      }
      b'\\' => simple(b'\\'),
      b'\'' | b'"' | b'?' if !in_b => simple(c),
      _ => (b"\\".to_vec(), 0),
    }
  }

  /// `%b`'s argument with escapes expanded; `true` when `\c` ends output.
  fn expand_b(&mut self, text: &[u8]) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
      let byte = text[i];
      i += 1;
      if byte != b'\\' || i == text.len() {
        out.push(byte);
        continue;
      }
      if text[i] == b'c' {
        return (out, true);
      }
      let (bytes, used) = self.escape(&text[i..], true);
      out.extend_from_slice(&bytes);
      i += used;
    }
    (out, false)
  }

  fn invalid_number(&mut self, word: &str) {
    let bytes = word.as_bytes();
    let detail = if bytes.first() == Some(&b'0') && bytes.get(1).is_some_and(u8::is_ascii_digit) {
      "invalid octal number"
    } else if bytes.first() == Some(&b'0') && bytes.get(1) == Some(&b'x') {
      "invalid hex number"
    } else {
      "invalid number"
    };
    self.error(format!("{word}: {detail}"));
    self.conversion_error = true;
  }

  fn out_of_range(&mut self, word: &str) {
    self.error(format!("{word}: Result too large"));
    self.conversion_error = true;
  }

  /// A character constant (`'c` or `"c`) as bash's `asciicode` reads it.
  fn character_code(&self, word: &str) -> Option<u64> {
    let rest = word.strip_prefix(['\'', '"'])?;
    Some(if self.context.utf8 {
      rest.chars().next().map_or(0, u64::from)
    } else {
      rest.as_bytes().first().copied().map_or(0, u64::from)
    })
  }

  /// `getint`: a `*` width or precision, clamped to `int`.
  fn int_argument(&mut self) -> i64 {
    let Some(word) = self.args.get(self.next).cloned() else {
      return 0;
    };
    let value = self.int_argument_wide();
    if value > i64::from(i32::MAX) {
      self.out_of_range(&word);
      i64::from(i32::MAX)
    } else if value < i64::from(i32::MIN) {
      self.out_of_range(&word);
      i64::from(i32::MIN)
    } else {
      value
    }
  }

  /// `getintmax`.
  fn int_argument_wide(&mut self) -> i64 {
    let Some(word) = self.arg().map(str::to_string) else {
      return 0;
    };
    if let Some(code) = self.character_code(&word) {
      return code as i64;
    }
    let (value, consumed, range) = c_strtoll(&word);
    if consumed == 0 || consumed < word.len() {
      self.invalid_number(&word);
    } else if range {
      self.out_of_range(&word);
    }
    value
  }

  /// `getuintmax`.
  fn uint_argument(&mut self) -> u64 {
    let Some(word) = self.arg().map(str::to_string) else {
      return 0;
    };
    if let Some(code) = self.character_code(&word) {
      return code;
    }
    let (value, consumed, range) = c_strtoull(&word);
    if consumed == 0 || consumed < word.len() {
      self.invalid_number(&word);
    } else if range {
      self.out_of_range(&word);
    }
    value
  }

  /// `getfloatmax`.
  fn float_argument(&mut self) -> f64 {
    let Some(word) = self.arg().map(str::to_string) else {
      return 0.0;
    };
    if let Some(code) = self.character_code(&word) {
      return code as f64;
    }
    let (value, consumed, range) = c_strtod(&word);
    if consumed == 0 || consumed < word.len() {
      self.invalid_number(&word);
    } else if range {
      self.out_of_range(&word);
    }
    value
  }
}

/// `printf ARGS` outside a shell line (a nested Lisp call): no `-v` or `%n`
/// variables, diagnostics prefixed `tsh: printf:`.
pub(super) fn run_detached(args: &[String]) -> super::ShellBuiltinOutput {
  let report = |errors: &[Diagnostic]| -> Vec<String> {
    errors
      .iter()
      .map(|error| match error {
        Diagnostic::Error(detail) => format!("tsh: printf: {detail}"),
        Diagnostic::Plain(text) => text.clone(),
      })
      .collect()
  };
  match parse(args) {
    Invocation::Refused(printed) => {
      super::ShellBuiltinOutput { status: printed.status, diagnostics: report(&printed.errors), stdout: Vec::new() }
    }
    Invocation::Run { variable: Some(_), .. } => super::ShellBuiltinOutput {
      status: 2,
      diagnostics: vec!["tsh: printf: -v: cannot assign inside a Lisp expression".into()],
      stdout: Vec::new(),
    },
    Invocation::Run { variable: None, format: text, args } => {
      let printed = format(text, args, &Context::current());
      super::ShellBuiltinOutput { stdout: printed.stdout, status: printed.status, diagnostics: report(&printed.errors) }
    }
  }
}

impl super::interp::LispHost {
  /// `printf ARGS` in process: the variable named by `-v` (when given) and
  /// what the builtin printed and reported. `%n` assignments are made here.
  pub(super) fn printf_run(&mut self, args: &[String], line: usize) -> (Option<String>, super::ShellBuiltinOutput) {
    let report = |errors: &[Diagnostic]| -> Vec<String> {
      errors
        .iter()
        .map(|error| match error {
          Diagnostic::Error(detail) => format!("tsh: line {line}: printf: {detail}"),
          Diagnostic::Plain(text) => text.clone(),
        })
        .collect()
    };
    let (variable, format_text, rest) = match parse(args) {
      Invocation::Refused(printed) => {
        return (None, super::ShellBuiltinOutput { status: printed.status, diagnostics: report(&printed.errors), stdout: Vec::new() });
      }
      Invocation::Run { variable, format, args } => (variable, format.to_string(), args.to_vec()),
    };
    // The shell's own locale variables count even when not exported, as
    // bash's `sv_locale` makes them; the zone is the exported `TZ`.
    let map = tento_env::global_env_map().map(|map| map.fork()).unwrap_or_else(tento_env::EnvMap::from_process);
    for name in ["LC_ALL", "LC_CTYPE", "LANG"] {
      let symbol = self.interp.string_interner().get_or_intern(name);
      if let Some(tento_lisp::Value::String(value)) = self.env.borrow().get(symbol) {
        map.set(name, value);
      }
    }
    let printed = tento_env::with_env_map(map, || format(&format_text, &rest, &Context::current()));
    for (name, value) in &printed.assignments {
      self.assign_shell_variable(name, value.clone(), false);
    }
    let output = super::ShellBuiltinOutput { stdout: printed.stdout, status: printed.status, diagnostics: report(&printed.errors) };
    (variable, output)
  }
}

fn parse_digits(digits: &[u8]) -> i64 {
  digits.iter().fold(0i64, |value, digit| value.saturating_mul(10).saturating_add(i64::from(digit - b'0')))
}

fn valid_identifier(name: &str) -> bool {
  let mut chars = name.chars();
  chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
    && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// bash's `printstr`: flags, width and precision over raw bytes, padding
/// with spaces only.
fn print_padded(out: &mut Vec<u8>, spec: &Spec, bytes: &[u8]) {
  let mut left = spec.flags.contains('-');
  let mut width = spec.width.unwrap_or(0);
  if width < 0 {
    left = true;
    width = -width;
  }
  let count = match spec.precision {
    Some(precision) if precision >= 0 => (precision as usize).min(bytes.len()),
    _ => bytes.len(),
  };
  let pad = (width as usize).saturating_sub(count);
  if !left {
    out.extend(std::iter::repeat_n(b' ', pad));
  }
  out.extend_from_slice(&bytes[..count]);
  if left {
    out.extend(std::iter::repeat_n(b' ', pad));
  }
}

fn c_string(text: &str) -> CString {
  let bytes = text.as_bytes();
  let end = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
  CString::new(&bytes[..end]).expect("NUL removed")
}

enum CArg {
  Int(i32),
  Long(i64),
  ULong(u64),
  Double(f64),
  Str(CString),
}

/// `snprintf(spec, arg)` into owned bytes.
fn c_print(spec: &CStr, arg: CArg) -> Vec<u8> {
  // SAFETY: `spec` is a NUL-terminated conversion with exactly one argument
  // of the matching C type (built by `Spec::c_format`); a null buffer of
  // size 0 only measures, and the second call writes at most `len + 1`.
  unsafe {
    let call = |buffer: *mut libc::c_char, size: usize| -> libc::c_int {
      match &arg {
        CArg::Int(value) => libc::snprintf(buffer, size, spec.as_ptr(), *value as libc::c_int),
        CArg::Long(value) => libc::snprintf(buffer, size, spec.as_ptr(), *value as libc::c_longlong),
        CArg::ULong(value) => libc::snprintf(buffer, size, spec.as_ptr(), *value as libc::c_ulonglong),
        CArg::Double(value) => libc::snprintf(buffer, size, spec.as_ptr(), *value as libc::c_double),
        CArg::Str(value) => libc::snprintf(buffer, size, spec.as_ptr(), value.as_ptr()),
      }
    };
    let len = call(std::ptr::null_mut(), 0);
    if len <= 0 {
      return Vec::new();
    }
    let mut buffer = vec![0u8; len as usize + 1];
    call(buffer.as_mut_ptr().cast(), buffer.len());
    buffer.truncate(len as usize);
    buffer
  }
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
fn errno_location() -> *mut libc::c_int {
  // SAFETY: always valid for the calling thread.
  unsafe { libc::__error() }
}

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd")))]
fn errno_location() -> *mut libc::c_int {
  // SAFETY: always valid for the calling thread.
  unsafe { libc::__errno_location() }
}

/// Run a C `strto*` conversion: its value, how many bytes it consumed and
/// whether it reported `ERANGE`.
fn c_convert<T>(word: &str, convert: impl FnOnce(*const libc::c_char, *mut *mut libc::c_char) -> T) -> (T, usize, bool) {
  let text = c_string(word);
  let mut end: *mut libc::c_char = std::ptr::null_mut();
  // SAFETY: errno is thread-local; `text` outlives the call and `end` points
  // into it (or at its start) afterwards.
  unsafe {
    *errno_location() = 0;
    let value = convert(text.as_ptr(), &mut end);
    let range = *errno_location() == libc::ERANGE;
    let consumed = end.offset_from(text.as_ptr()) as usize;
    // A word with a NUL never parses completely.
    let consumed = if text.as_bytes().len() < word.len() { consumed.min(word.len() - 1) } else { consumed };
    (value, consumed, range)
  }
}

fn c_strtoll(word: &str) -> (i64, usize, bool) {
  // SAFETY: see `c_convert`.
  c_convert(word, |text, end| unsafe { libc::strtoll(text, end, 0) })
}

fn c_strtoull(word: &str) -> (u64, usize, bool) {
  // SAFETY: see `c_convert`.
  c_convert(word, |text, end| unsafe { libc::strtoull(text, end, 0) })
}

fn c_strtod(word: &str) -> (f64, usize, bool) {
  // SAFETY: see `c_convert`.
  c_convert(word, |text, end| unsafe { libc::strtod(text, end) })
}

/// `strftime(FORMAT, localtime(SECONDS))` in the shell's `TZ`.
fn strftime(format: &[u8], seconds: i64) -> Vec<u8> {
  let Ok(format) = CString::new(format.iter().copied().take_while(|byte| *byte != 0).collect::<Vec<_>>()) else {
    return Vec::new();
  };
  let _zone = ZoneGuard::enter();
  // SAFETY: `tm` is plain data filled by `localtime_r`; the buffer bounds
  // are passed to `strftime`.
  unsafe {
    let mut tm: libc::tm = std::mem::zeroed();
    let mut time = seconds as libc::time_t;
    if libc::localtime_r(&time, &mut tm).is_null() {
      time = 0;
      libc::localtime_r(&time, &mut tm);
    }
    let mut buffer = vec![0u8; 4096];
    let len = libc::strftime(buffer.as_mut_ptr().cast(), buffer.len(), format.as_ptr(), &tm);
    buffer.truncate(len);
    buffer
  }
}

/// bash syncs the shell's `TZ` into the C library before `localtime`
/// (`sv_tz`). The process zone is switched only when the shell's differs,
/// and restored afterwards.
struct ZoneGuard {
  saved: Option<Option<std::ffi::OsString>>,
}

unsafe extern "C" {
  fn tzset();
}

impl ZoneGuard {
  fn enter() -> Self {
    let shell = if tento_env::global_env_map().is_some() { tento_env::effective_var("TZ") } else { None };
    let process = std::env::var_os("TZ");
    let wanted = match &shell {
      Some(zone) => Some(std::ffi::OsString::from(zone)),
      None if tento_env::global_env_map().is_some() => None,
      None => process.clone(),
    };
    if wanted == process {
      // SAFETY: re-reads the unchanged process zone.
      unsafe { tzset() };
      return ZoneGuard { saved: None };
    }
    set_zone(wanted.as_deref());
    ZoneGuard { saved: Some(process) }
  }
}

impl Drop for ZoneGuard {
  fn drop(&mut self) {
    if let Some(saved) = self.saved.take() {
      set_zone(saved.as_deref());
    }
  }
}

fn set_zone(zone: Option<&std::ffi::OsStr>) {
  // SAFETY: the shell interpreter runs on one thread; the zone is put back
  // before `printf` returns.
  unsafe {
    match zone {
      Some(zone) => std::env::set_var("TZ", zone),
      None => std::env::remove_var("TZ"),
    }
    tzset();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn run(format_text: &str, args: &[&str]) -> (String, Vec<String>, i32) {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let context = Context { utf8: true, started: 1_000 };
    let printed = format(format_text, &args, &context);
    let errors = printed
      .errors
      .iter()
      .map(|error| match error {
        Diagnostic::Error(text) | Diagnostic::Plain(text) => text.clone(),
      })
      .collect();
    (String::from_utf8_lossy(&printed.stdout).into_owned(), errors, printed.status)
  }

  fn out(format_text: &str, args: &[&str]) -> String {
    run(format_text, args).0
  }

  // Every expectation below was printed by bash 5.3 (/opt/homebrew/bin/bash).
  #[test]
  fn printf_integer_conversions_match_bash() {
    assert_eq!(out("[%x %o %X %u]\n", &["255", "8", "255", "-1"]), "[ff 10 FF 18446744073709551615]\n");
    assert_eq!(out("%i %d\n", &["010", "0x1f"]), "8 31\n");
    assert_eq!(out("%+d % d %05d %-5d|\n", &["5", "5", "5", "5"]), "+5  5 00005 5    |\n");
    assert_eq!(out("%#x %#o\n", &["255", "8"]), "0xff 010\n");
    assert_eq!(out("%ld %lld %hd %zd\n", &["1", "2", "3", "4"]), "1 2 3 4\n");
    assert_eq!(out("%.3d|%8.3x|\n", &["5", "255"]), "005|     0ff|\n");
    assert_eq!(out("%d\n", &["-0x10"]), "-16\n");
    assert_eq!(out("[%d]\n", &["'A", "\"B", "'"]), "[65]\n[66]\n[0]\n");
    assert_eq!(out("%d\n", &["'é"]), "233\n");
    assert_eq!(out("%-+08.3d|\n", &["12"]), "+012    |\n");
  }

  #[test]
  fn printf_invalid_numbers_warn_print_the_partial_value_and_fail() {
    assert_eq!(run("[%d]\n", &["abc"]), ("[0]\n".into(), vec!["abc: invalid number".into()], 1));
    assert_eq!(run("[%d]\n", &["12abc"]), ("[12]\n".into(), vec!["12abc: invalid number".into()], 1));
    assert_eq!(run("%d\n", &["08"]), ("0\n".into(), vec!["08: invalid octal number".into()], 1));
    assert_eq!(run("%d\n", &[""]), ("0\n".into(), vec![": invalid number".into()], 1));
    assert_eq!(run("%d\n", &[" 42"]), ("42\n".into(), vec![], 0));
    assert_eq!(
      run("%d\n", &["99999999999999999999"]),
      ("9223372036854775807\n".into(), vec!["99999999999999999999: Result too large".into()], 1)
    );
    assert_eq!(run("%x\n", &["3.5"]).0, "3\n");
    assert_eq!(run("%f\n", &["abc"]), ("0.000000\n".into(), vec!["abc: invalid number".into()], 1));
  }

  #[test]
  fn printf_float_conversions_match_bash() {
    assert_eq!(
      out("[%5.2f|%-8.3e|%g|%G|%a]\n", &["3.14159", "1234.5", "0.0001", "1e20", "1"]),
      "[ 3.14|1.234e+03|0.0001|1E+20|0x1p+0]\n"
    );
    assert_eq!(out("%f\n", &["0x10"]), "16.000000\n");
    assert_eq!(out("%f\n", &["'a"]), "97.000000\n");
    assert_eq!(out("%.0f %.1f\n", &["2.5", "0.05"]), "2 0.1\n");
    assert_eq!(out("%08.3f|\n", &["-3.5"]), "-003.500|\n");
    assert_eq!(out("%.3g|%#g|%#.0f\n", &["3.14159", "1.0", "3"]), "3.14|1.00000|3.\n");
    assert_eq!(out("%F %E\n", &["1.5", "1.5"]), "1.500000 1.500000E+00\n");
    assert_eq!(out("%f\n", &["nan"]), "nan\n");
  }

  #[test]
  fn printf_strings_reuse_the_format_and_default_missing_arguments() {
    assert_eq!(out("[%s]\n", &["a", "b", "c"]), "[a]\n[b]\n[c]\n");
    assert_eq!(out("[%s %s]\n", &["a", "b", "c"]), "[a b]\n[c ]\n");
    assert_eq!(out("none\n", &["a", "b"]), "none\n");
    assert_eq!(out("%s %d\n", &["x"]), "x 0\n");
    assert_eq!(out("%.3s|%5s|%-5s|\n", &["abcdef", "ab", "ab"]), "abc|   ab|ab   |\n");
    assert_eq!(out("%05s|%-05s|\n", &["a", "b"]), "0000a|b    |\n");
    assert_eq!(out("%.2s\n", &["éé"]), "é\n");
    assert_eq!(out("%c%c|\n", &["hello", ""]), "h\0|\n");
    assert_eq!(out("%5c|%-3c|\n", &["a", "b"]), "    a|b  |\n");
    assert_eq!(out("%d %s\n", &["1", "a", "2"]), "1 a\n2 \n");
  }

  #[test]
  fn printf_star_width_and_precision_come_from_arguments() {
    assert_eq!(out("[%*d|%-*d|%.*f]\n", &["5", "42", "4", "7", "2", "3.14159"]), "[   42|7   |3.14]\n");
    assert_eq!(out("%*s|\n", &["-5", "a"]), "a    |\n");
    assert_eq!(out("%.*s|\n", &["-1", "abc"]), "abc|\n");
    assert_eq!(out("%*.*s|\n", &["6", "2", "abcdef"]), "    ab|\n");
    assert_eq!(run("%*d|\n", &["x", "5"]), ("5|\n".into(), vec!["x: invalid number".into()], 1));
  }

  #[test]
  fn printf_format_escapes_match_bash() {
    assert_eq!(out("\\x41\\101\\u00e9\\e[0m\\c?\\q\n", &[]), "AAé\x1b[0m\\c?\\q\n");
    assert_eq!(out("a\\0101b\n", &[]), "a\x081b\n");
    assert_eq!(out("\\\"\\?\\a\n", &[]), "\"?\x07\n");
    assert_eq!(out("x\\", &[]), "x\\");
    assert_eq!(out("\\8\n", &[]), "\\8\n");
    assert_eq!(out("\\U0001F600\n", &[]), "😀\n");
    assert_eq!(run("\\x|\n", &[]), ("\\x|\n".into(), vec!["missing hex digit for \\x".into()], 0));
    assert_eq!(run("\\u|\n", &[]), ("\\u|\n".into(), vec!["missing unicode digit for \\u".into()], 0));
    assert_eq!(run("%%d %5%|\n", &[]), ("%d ".into(), vec!["`%': invalid format character".into()], 1));
  }

  #[test]
  fn printf_b_expands_arguments_and_c_stops_everything() {
    assert_eq!(out("[%b]\n", &["a\\tb\\c", "zzz"]), "[a\tb");
    assert_eq!(out("%b|", &["\\0", "a\\0b", "\\1010"]), "\0|a\0b|A0|");
    assert_eq!(out("%b\n", &["\\\"\\?\\'"]), "\\\"\\?\\'\n");
    assert_eq!(out("%5b|\n", &["a\\n"]), "   a\n|\n");
    assert_eq!(out("%.2b|\n", &["abc"]), "ab|\n");
    assert_eq!(out("%b\n", &["\\u263a"]), "☺\n");
  }

  #[test]
  fn printf_format_errors_stop_with_status_one() {
    assert_eq!(run("%z\\n", &["x"]), (String::new(), vec!["`\\': invalid format character".into()], 1));
    assert_eq!(run("abc%", &[]), ("abc".into(), vec!["`%': missing format character".into()], 1));
    assert_eq!(run("ab%5", &[]), ("ab".into(), vec!["`%5': missing format character".into()], 1));
    assert_eq!(run("%2$s\n", &["a"]), (String::new(), vec!["`$': invalid format character".into()], 1));
    assert_eq!(run("%v\n", &["1"]).2, 1);
  }

  #[test]
  fn printf_q_and_n_conversions() {
    assert_eq!(out("%q\n", &["a b"]), "a\\ b\n");
    assert_eq!(out("%Q\n", &["a b"]), "a\\ b\n");
    assert_eq!(out("%.1Q|%.1q\n", &["a b", "a b"]), "a|a\n");
    assert_eq!(out("%Lf %lf %hhd %qd\n", &["1", "2", "3", "4"]), "1.000000 2.000000 3 4d\n");
    let args = vec!["cnt".to_string()];
    let printed = format("a%nb\n", &args, &Context::default());
    assert_eq!(printed.assignments, vec![("cnt".to_string(), "1".to_string())]);
  }

  #[test]
  fn printf_time_conversion_formats_epoch_seconds() {
    let _zone = TestZone::utc();
    assert_eq!(out("%(%Y-%m-%d)T\n", &["86400"]), "1970-01-02\n");
    assert_eq!(out("[%(%%)T]\n", &[]), "[%]\n");
    assert_eq!(out("%(%H:%M)T|%(%s)T\n", &["3600", "5"]), "01:00|5\n");
    assert_eq!(out("%10(%Y)T|%-10(%Y)T|%.2(%Y)T|\n", &["0", "0", "0"]), "      1970|1970      |19|\n");
    assert_eq!(out("%()T|\n", &["0"]), "00:00:00|\n");
    assert_eq!(out("%(%s)T\n", &["-2"]), "1000\n");
    let (text, errors, status) = run("%(%Y)X\n", &["0"]);
    assert_eq!(text, "%(");
    assert_eq!(errors, vec!["warning: `X': invalid time format specification".to_string(), "`Y': invalid format character".into()]);
    assert_eq!(status, 1);
  }

  struct TestZone;
  impl TestZone {
    fn utc() -> Self {
      set_zone(Some(std::ffi::OsStr::new("UTC")));
      TestZone
    }
  }

  #[test]
  fn printf_options_parse_like_bash() {
    let words = |list: &[&str]| list.iter().map(|word| (*word).to_string()).collect::<Vec<_>>();
    let refusal = |list: &[&str]| match parse(&words(list)) {
      Invocation::Refused(printed) => (printed.errors, printed.status),
      Invocation::Run { .. } => panic!("{list:?} ran"),
    };
    assert_eq!(
      refusal(&["-x"]),
      (vec![Diagnostic::Error("-x: invalid option".into()), Diagnostic::Plain(USAGE.into())], 2)
    );
    assert_eq!(
      refusal(&["-%s\n", "x"]),
      (vec![Diagnostic::Error("-%: invalid option".into()), Diagnostic::Plain(USAGE.into())], 2)
    );
    assert_eq!(refusal(&[]), (vec![Diagnostic::Plain(USAGE.into())], 2));
    assert_eq!(refusal(&["-v", "x"]), (vec![Diagnostic::Plain(USAGE.into())], 2));
    let args = words(&["-vx", "a%s", "b"]);
    assert!(matches!(parse(&args), Invocation::Run { variable: Some(name), format: "a%s", .. } if name == "x"));
    let args = words(&["--", "--"]);
    assert!(matches!(parse(&args), Invocation::Run { variable: None, format: "--", .. }));
    let args = words(&["-"]);
    assert!(matches!(parse(&args), Invocation::Run { format: "-", .. }));
  }
}
