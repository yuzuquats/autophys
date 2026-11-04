//! Lisp ↔ bash command words (operator rulings Q6/Q8, 2026-10-06).
//!
//! Bash functions are command words and Lisp names are Lisp: a function
//! defined with `f() { …; }` never becomes the Lisp name `f`. Lisp reaches
//! it, or any other command word (builtin, program), through one form:
//!
//! - `(std.sh.call "f" ARG…)` runs the word by bash's lookup (function,
//!   builtin, then `PATH`) with ARG… as its operands; its output goes where
//!   the shell's does and the form's value is the exit status.
//! - `(std.sh.call {:capture true} "f" ARG…)` captures stdout instead and
//!   returns `{:status N :stdout "…"}`, trailing newlines kept.
//!
//! The call runs in the current shell, so a function's assignments and
//! `cd` persist. The Lisp evaluator cannot suspend inside an expression, so
//! the form runs as a statement: the whole top-level form, or the value of
//! a top-level `let`, `set` or `define`. Anywhere deeper it is a loud error
//! naming those places.
//!
//! In a strict Lisp file (`.tsh`, rc, `tsh run`), a bash word used as a
//! Lisp head with no Lisp binding — `(cd "/")`, `(ls "/")`, `(export …)` —
//! is a loud error pointing at the Lisp spelling and at `std.sh.call`.
use indexmap::IndexMap;
use tento_lisp::Value as LispValue;

use super::bash_flow::{FlowOutput, eval_flow};
use super::interp::{LispHost, LispHostError, Sym};
use super::runner::TshScriptErrorKind;

pub(super) const SHELL_CALL: &str = "std.sh.call";

thread_local! {
  /// Whether the source now running is strict Lisp (a `.tsh` file, an rc,
  /// `tsh run`) rather than the prompt's mixed dialect.
  static STRICT_LISP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Mark the source about to run as strict Lisp or not; returns the previous
/// setting for the caller to restore.
pub(super) fn set_strict_lisp(strict: bool) -> bool {
  STRICT_LISP.with(|cell| cell.replace(strict))
}

pub(super) fn strict_lisp() -> bool {
  STRICT_LISP.with(std::cell::Cell::get)
}

/// Bash builtins a strict Lisp file may write as a head by habit, beyond the
/// unix names in [`UNIX_NAMES`].
const BASH_WORDS: &[&str] = &[
  // Words Lisp also uses (`let`, `eval`, `true`, `return`, `type`, …) are
  // left out: an unbound one is a Lisp error, not a bash habit.
  "cd", "pushd", "popd", "dirs", "export", "unset", "alias", "unalias", "source", "shopt", "local",
  "declare", "typeset", "readonly", "exec", "exit", "trap", "umask", "ulimit", "wait", "jobs", "fg",
  "bg", "kill", "disown", "shift", "getopts", "hash", "builtin", "printf", "history", "fc", "caller",
  "mapfile", "readarray",
];

/// Unix names with a typed Lisp spelling (the operator's 2026-10-04 table;
/// the utilities are `std.coreutil.*`: ruling R-2, 2026-10-18, moved under
/// `std` by the operator, 2026-10-19).
const UNIX_NAMES: &[(&str, &str)] = &[
  ("ls", "std.coreutil.ls"),
  ("cd", "std.process.chdir"),
  ("cat", "std.coreutil.cat"),
  ("mkdir", "std.coreutil.mkdir"),
  ("rm", "std.coreutil.rm"),
  ("mv", "std.coreutil.mv"),
  ("cp", "std.coreutil.cp"),
  ("pwd", "std.process.cwd"),
  ("echo", "std.io.echo"),
  ("head", "std.coreutil.head"),
  ("tail", "std.coreutil.tail"),
];

/// The typed Lisp spelling of a bash word, where one exists.
fn lisp_equivalent(word: &str) -> Option<&'static str> {
  UNIX_NAMES.iter().find(|(name, _)| *name == word).map(|(_, target)| *target)
}

/// The loud teaching error for bash WORD written as a Lisp head.
pub(super) fn bash_word_hint(word: &str, args: &[String]) -> String {
  let quoted: Vec<String> = args.iter().map(|arg| format!("{arg:?}")).collect();
  let operands = if quoted.is_empty() { String::new() } else { format!(" {}", quoted.join(" ")) };
  let word_text = format!("{word:?}");
  let shell = format!("(std.sh.call {word_text}{operands})");
  match lisp_equivalent(word) {
    Some(target) => format!(
      "`{word}` is a bash command word, not a lisp name: in lisp write ({target}{operands}), or run the shell's `{word}` with {shell}"
    ),
    None => format!("`{word}` is a bash command word, not a lisp name: run it with {shell}"),
  }
}

/// tento-lisp's special forms (`interpreter.rs`): never bash words, bound
/// or not (`(let a 1)` is the binding form, not bash's `let`).
const LISP_FORMS: &[&str] = &[
  "@import", "and", "apply", "begin", "cond", "def", "define", "defun", "fn", "expect", "filter", "fold",
  "group-by", "if", "json-from-list", "lambda", "let", "map", "match", "or", "quote", "reduce", "set", "set!",
  "try", "unwrap", "use",
];

/// Whether WORD is a bash word that strict Lisp refuses as a bare head.
pub(super) fn is_bash_word(word: &str) -> bool {
  !LISP_FORMS.contains(&word) && (BASH_WORDS.contains(&word) || lisp_equivalent(word).is_some())
}

impl LispHost {
  /// The nested-use refusal: a `std.sh.call` the statement door did not run.
  pub(super) fn register_shell_call_native(&mut self) {
    self.register_native_special(SHELL_CALL, |_args| {
      Err(LispHostError::Runtime(format!(
        "{SHELL_CALL} runs a shell command word as a statement: write it as a whole top-level form, or as the value of a top-level let, set or define (it cannot run inside a larger lisp expression yet)"
      )))
    });
  }

  /// In a strict Lisp source, refuse a top-level form whose head is an
  /// unbound bash word.
  pub(super) fn refuse_bash_word_head(&mut self, value: &LispValue<Sym>) -> Result<(), TshScriptErrorKind> {
    if !strict_lisp() {
      return Ok(());
    }
    let Some(head) = self.application_head(value) else { return Ok(()) };
    if !is_bash_word(&head) {
      return Ok(());
    }
    let symbol = self.interp.string_interner().get_or_intern(&head);
    if self.env.borrow().get(symbol).is_some() {
      return Ok(());
    }
    let LispValue::List(list) = value else { return Ok(()) };
    let args: Vec<String> = list.items[1..].iter().map(|arg| match arg {
      LispValue::String(text) => text.to_string(),
      other => self.render_lisp_value(other),
    }).collect();
    Err(TshScriptErrorKind::Lisp(LispHostError::Runtime(bash_word_hint(&head, &args))))
  }

  fn render_lisp_value(&mut self, value: &LispValue<Sym>) -> String {
    match value {
      LispValue::Symbol(symbol) => self.interp.string_interner().resolve(symbol.as_symbol()).unwrap_or("").to_string(),
      LispValue::Integer(n) => n.to_string(),
      other => super::interp::value_to_json(other).to_string(),
    }
  }

  /// Run the statement-position `std.sh.call`s of a top-level form, leaving
  /// `(quote RESULT)` in their place.
  pub(super) async fn run_statement_shell_calls(&mut self, value: &mut LispValue<Sym>) -> Result<(), TshScriptErrorKind> {
    let head = self.application_head(value);
    if head.as_deref() == Some(SHELL_CALL) {
      let result = self.shell_call(value).await?;
      *value = self.quoted(result);
      return Ok(());
    }
    // `(sh! …)` as one form among several on a line: it runs as a statement.
    if head.as_deref() == Some(super::sh_macro::SH_MACRO) {
      self.run_sh_macro_value(value).await?;
      *value = self.quoted(LispValue::Nil);
      return Ok(());
    }
    if matches!(head.as_deref(), Some("let" | "set" | "set!" | "define")) {
      let LispValue::List(list) = value else { return Ok(()) };
      let value_head = if list.items.len() == 3 { self.application_head(&list.items[2]) } else { None };
      if value_head.as_deref() == Some(super::sh_macro::SH_MACRO) {
        let call = list.items[2].clone();
        let status = self.run_sh_macro_value(&call).await?;
        let quoted = self.quoted(status);
        if let LispValue::List(list) = value { list.items[2] = quoted; }
      } else if value_head.as_deref() == Some(SHELL_CALL) {
        let call = list.items[2].clone();
        let result = self.shell_call(&call).await?;
        let quoted = self.quoted(result);
        if let LispValue::List(list) = value { list.items[2] = quoted; }
      }
    }
    self.refuse_nested_sh_macro(value)
  }

  fn quoted(&mut self, value: LispValue<Sym>) -> LispValue<Sym> {
    let quote = self.interp.string_interner().get_or_intern("quote");
    LispValue::List(tento_lisp::List { items: vec![LispValue::Symbol(quote.into()), value].into() })
  }

  /// `(std.sh.call [OPTIONS] WORD ARG…)`: evaluate the operands as Lisp,
  /// then run WORD by bash's lookup in this shell.
  async fn shell_call(&mut self, form: &LispValue<Sym>) -> Result<LispValue<Sym>, TshScriptErrorKind> {
    let LispValue::List(list) = form else { unreachable!() };
    let usage = || TshScriptErrorKind::Lisp(LispHostError::Runtime(format!(
      "{SHELL_CALL}: expected ({SHELL_CALL} [{{:capture true}}] \"WORD\" ARG…)"
    )));
    let mut operands = Vec::with_capacity(list.items.len());
    for operand in &list.items[1..] {
      let value = self
        .interp
        .eval_expression(self.env.clone(), operand)
        .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Runtime(error.to_string())))?;
      operands.push(value);
    }
    let mut capture = false;
    if let Some(LispValue::Map(options)) = operands.first() {
      for (key, value) in options {
        match key.trim_start_matches(':') {
          "capture" => capture = value.is_truthy(),
          other => return Err(TshScriptErrorKind::Lisp(LispHostError::Runtime(format!(
            "{SHELL_CALL}: unknown option :{other} (the option is :capture)"
          )))),
        }
      }
      operands.remove(0);
    }
    let Some(LispValue::String(word)) = operands.first() else { return Err(usage()) };
    let word = word.clone();
    let argv = super::lisp_args_to_argv(&word, operands.split_off(1));
    let mut items = vec![LispValue::Symbol(self.interp.string_interner().get_or_intern(super::shell_cmd::SHELL_COMMAND).into())];
    items.extend(argv.into_iter().map(|value| LispValue::String(value.into())));
    let mut command = LispValue::List(tento_lisp::List { items: items.into() });
    self.lower_commands(&mut command);
    let buffer = capture.then(|| std::rc::Rc::new(std::cell::RefCell::new(Vec::new())));
    let output = FlowOutput { capture: buffer.clone(), ..FlowOutput::default() };
    let line = super::bash_attributes::current_line();
    let value = eval_flow(self, &command, line, true, output.clone(), false).await?;
    output.flush_value(self, value);
    let status = i64::from(self.shell_status());
    Ok(match buffer {
      None => LispValue::Integer(status),
      Some(buffer) => {
        let stdout = String::from_utf8_lossy(&buffer.borrow()).into_owned();
        let mut result = IndexMap::new();
        result.insert("status".to_string(), LispValue::Integer(status));
        result.insert("stdout".to_string(), LispValue::String(stdout.into()));
        LispValue::Map(result.into())
      }
    })
  }
}
