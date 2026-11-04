//! Lazy compound execution and typed non-local transfers for compiled shell plans.
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::rc::Rc;

use super::bash_flow::{FlowOutput, eval_flow};
use super::interp::{LispHost, LispHostError, Sym};
use super::runner::TshScriptErrorKind;
use serde_json::Value as JsonValue;
use tento_lisp::{Env, Value as LispValue};

mod commands;
pub(in crate::script) mod traps;
mod umask;
mod last_history;
pub(in crate::script) use last_history::declaration_quote;
mod getopts;
pub(super) use commands::{CommandState, GlobOptions, trace_word};

type Result<T> = std::result::Result<T, TshScriptErrorKind>;

#[derive(Clone, Debug, thiserror::Error)]
pub enum ControlSignal {
  #[error("break {0}")]
  Break(usize),
  #[error("continue {0}")]
  Continue(usize),
  #[error("return {0}")]
  Return(i32),
  #[error("exit status {0}")]
  Exit(i32),
  #[error("exec exit status {0}")]
  ExecExit(i32),
  /// bash's DISCARD: an expansion error (arithmetic, bad substitution, bad
  /// indirection, failglob, a readonly assignment) abandons the rest of the
  /// current top-level command, already reported, with this status. The
  /// script, `eval` and `.` resume at their next command; a subshell, a
  /// command substitution or a pipeline stage ends with the status. Bash
  /// itself exits only in POSIX mode, which tsh does not implement.
  #[error("discarded with status {0}")]
  Discard(i32),
}

#[derive(Default)]
pub(super) struct CompoundState {
  pub commands: CommandState,
  pub functions: HashMap<String, LispValue<Sym>>,
  /// Exported functions in the environment were defined (bash_functions.rs).
  pub functions_imported: bool,
  pub positional: Rc<RefCell<Vec<String>>>,
  pub zero: Rc<RefCell<String>>,
  pub flags: Rc<RefCell<String>>,
  pub invocation_flags: String,
  pub loops: usize,
  pub calls: usize,
  pub sources: usize,
  pub local_attributes: Vec<HashMap<String, Option<super::bash_arrays::VarAttributes>>>,
  pub noglob: Rc<std::cell::Cell<bool>>,
  pub pipeline_status_known: Rc<std::cell::Cell<bool>>,
  pub locals: Vec<HashMap<String, Option<String>>>,
  /// `FUNCNAME`/`BASH_SOURCE`/`BASH_LINENO` frames and function origins.
  pub call_stack: super::bash_callstack::CallStack,
}

async fn data(host: &mut LispHost, value: &LispValue<Sym>, line: usize) -> Result<JsonValue> {
  // A compound word (a `for` list, a `case` word or pattern, an arithmetic
  // expression, a `[[` operand) is a unit: reserved across its expansion.
  let forks = super::owned_io_fork::words_fork(host, value);
  let unit = host
    .reserve_fork_unit(forks, "compound word", line)
    .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error)))?;
  let value = super::shell_redirect::resolve_target(host, value, line)
    .await
    .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error)))?;
  drop(unit);
  host
    .evaluate_shell_data(&value)
    .map_err(TshScriptErrorKind::Lisp)
}
fn text(value: &JsonValue) -> String {
  value
    .as_str()
    .map(str::to_string)
    .unwrap_or_else(|| value.to_string())
}
fn invalid(name: &str) -> TshScriptErrorKind {
  TshScriptErrorKind::Lisp(LispHostError::Runtime(format!("{name}: invalid operands")))
}

async fn arithmetic_value(host: &mut LispHost, value: &LispValue<Sym>, line: usize) -> Result<i64> {
  if host.shell_compound.commands.xtrace {
    // `set -x` shows `(( EXPRESSION ))` with its expansions done.
    if let LispValue::List(list) = value {
      if let [_, source] = list.items.as_slice() {
        if host.application_head(value).as_deref() == Some("std.sh.arith") {
          let source = text(&data(host, source, line).await?);
          let prefix = host.shell_trace_prefix(line).await?;
          host.write_trace(format!("{prefix}(( {source} ))"));
        }
      }
    }
  }
  let value = data(host, value, line).await?;
  text(&value).parse().map_err(|_| invalid("arithmetic value"))
}

impl LispHost {
  pub(super) fn shell_let(&mut self, expressions: &[String], line: usize) -> Result<()> {
    if expressions.is_empty() {
      self.report_shell_diagnostic(format!("tsh: line {line}: let: expression expected"));
      self.set_shell_status(1);
      return Ok(());
    }
    let mut last = 0;
    for source in expressions {
      self.prepare_shell_arithmetic(source).map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error)))?;
      let call = self.shell_literal_call(&["std.sh.arith".into(), source.clone()], "std.sh.arith", false);
      match self.evaluate_shell_data(&call) {
        Ok(value) => last = text(&value).parse().map_err(|_| invalid("let"))?,
        Err(error) => {
          self.report_shell_diagnostic(format!("tsh: line {line}: let: {error}"));
          self.set_shell_status(1);
          return Ok(());
        }
      }
    }
    self.set_shell_status(i32::from(last == 0));
    Ok(())
  }
}

pub(super) async fn evaluate(
  host: &mut LispHost,
  name: &str,
  args: &[LispValue<Sym>],
  line: usize,
  ignored: bool,
  output: FlowOutput,
  _last: bool,
) -> Result<Option<JsonValue>> {
  match (name, args) {
    ("std.sh.if", [condition, yes, no]) => {
      let value = eval_flow(host, condition, line, true, output.clone().plain(), false).await?;
      output.flush_value(host, value);
      let branch = if host.shell_status() == 0 { yes } else { no };
      let value = eval_flow(host, branch, line, ignored, output.clone().plain(), false).await?;
      output.flush_value(host, value);
      Ok(None)
    }
    ("std.sh.group", [body]) => {
      let value = eval_flow(host, body, line, ignored, output.clone().plain(), false).await?;
      output.flush_value(host, value);
      Ok(None)
    }
    ("std.sh.subshell", [body]) => {
      // A subshell starts with no jobs of its own, as bash's does.
      let _jobs = host.shell_compound.commands.jobs.subshell();
      let value = isolated_stage(host, body, line, ignored, output.clone().plain(), false).await?;
      output.flush_value(host, value);
      if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
      if host.shell_status() != 0 && host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(host.shell_status())); }
      Ok(None)
    }
    ("std.sh.arithmetic", [expression]) => {
      match arithmetic_value(host, expression, line).await {
        Ok(value) => host.set_shell_status(i32::from(value == 0)),
        // bash names the command for an expression error (`((: EXPRESSION:
        // message (error token is …)`), not for a readonly or unset name.
        Err(error) => {
          let error = error.to_string();
          let command = if error.contains("(error token is") { "((: " } else { "" };
          host.report_shell_diagnostic(format!("tsh: line {line}: {command}{error}"));
          host.set_shell_status(1);
        }
      }
      if host.shell_status() != 0 && host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(host.shell_status())); }
      Ok(None)
    }
    ("std.sh.arithmetic-for", [init, condition, step, body]) => {
      host.shell_compound.loops += 1;
      let result = async {
        arithmetic_value(host, init, line).await?;
        let mut status = 0;
        while arithmetic_value(host, condition, line).await? != 0 {
          match loop_transfer(eval_flow(host, body, line, ignored, output.clone().plain(), false).await)? {
            LoopTransfer::Break => { status = host.shell_status(); break; }
            LoopTransfer::Continue => status = host.shell_status(),
            LoopTransfer::Value(value) => { output.flush_value(host, value); status = host.shell_status(); }
          }
          arithmetic_value(host, step, line).await?;
        }
        host.set_shell_status(status);
        Ok(None)
      }.await;
      host.shell_compound.loops -= 1;
      result
    }
    ("std.sh.while", [LispValue::Boolean(until), condition, body]) => {
      host.shell_compound.loops += 1;
      let result = async {
        let mut status = 0;
        loop {
          let condition_result =
            eval_flow(host, condition, line, true, output.clone().plain(), false).await;
          match loop_transfer(condition_result)? {
            LoopTransfer::Break => break,
            LoopTransfer::Continue => continue,
            LoopTransfer::Value(value) => output.flush_value(host, value),
          }
          if (host.shell_status() == 0) == *until {
            break;
          }
          match loop_transfer(
            eval_flow(host, body, line, ignored, output.clone().plain(), false).await,
          )? {
            LoopTransfer::Break => {
              status = host.shell_status();
              break;
            }
            LoopTransfer::Continue => status = host.shell_status(),
            LoopTransfer::Value(value) => {
              output.flush_value(host, value);
              status = host.shell_status();
            }
          }
        }
        host.set_shell_status(status);
        Ok(None)
      }
      .await;
      host.shell_compound.loops -= 1;
      result
    }
    ("std.sh.for", [LispValue::String(name), words, body, written @ ..]) => {
      let words = data(host, words, line).await?;
      let words = words.as_array().ok_or_else(|| invalid("std.sh.for"))?;
      // `set -x` shows `for NAME in WORDS` as written before each pass (the
      // reader appends the words' source; a hand-built form shows them
      // expanded).
      let trace = match written {
        [LispValue::String(written)] => format!("for {name} in {written}"),
        _ => format!(
          "for {name} in {}",
          words.iter().map(|word| commands::trace_word(&text(word))).collect::<Vec<_>>().join(" ")
        ),
      };
      host.shell_compound.loops += 1;
      let result = async {
        let mut status = 0;
        for word in words {
          if host.shell_compound.commands.xtrace {
            super::bash_attributes::set_current_line(line);
            let prefix = host.shell_trace_prefix(line).await?;
            host.write_trace(format!("{prefix}{trace}"));
          }
          if host.shell_readonly(name) {
            host.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly variable"));
            host.set_shell_status(1);
            if host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(1)); }
            status = 1;
            break;
          }
          host.assign_shell_variable(name, text(word), false);
          match loop_transfer(
            eval_flow(host, body, line, ignored, output.clone().plain(), false).await,
          )? {
            LoopTransfer::Break => {
              status = host.shell_status();
              break;
            }
            LoopTransfer::Continue => status = host.shell_status(),
            LoopTransfer::Value(value) => {
              output.flush_value(host, value);
              status = host.shell_status();
            }
          }
        }
        host.set_shell_status(status);
        Ok(None)
      }
      .await;
      host.shell_compound.loops -= 1;
      result
    }
    ("std.sh.function", [LispValue::String(name), body, source @ ..]) => {
      if super::bash_type::readonly_function(name) {
        host.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly function"));
        host.set_shell_status(1);
        return Ok(None);
      }
      let source = match source {
        [LispValue::String(source)] => Some(source.as_str()),
        _ => None,
      };
      host.define_shell_function(name, body.clone(), source);
      host.record_function_origin(name, line);
      host.set_shell_status(0);
      Ok(None)
    }
    ("std.sh.case", [word, arms @ ..]) => {
      // The reader appends the word as written: `set -x` shows it unexpanded,
      // before the expansion runs.
      let (arms, written) = match arms {
        [arms @ .., LispValue::String(written)] => (arms, Some(written)),
        arms => (arms, None),
      };
      if let Some(written) = written.filter(|_| host.shell_compound.commands.xtrace) {
        let prefix = host.shell_trace_prefix(line).await?;
        host.write_trace(format!("{prefix}case {written} in"));
      }
      let word = text(&data(host, word, line).await?);
      let mut fallthrough = false;
      let mut status = 0;
      for arm in arms {
        let LispValue::List(arm) = arm else {
          return Err(invalid(name));
        };
        let [_, patterns, body, LispValue::String(ending)] = arm.items.as_slice() else {
          return Err(invalid(name));
        };
        let mut matched = fallthrough;
        if !matched {
          let LispValue::List(patterns) = patterns else {
            return Err(invalid(name));
          };
          for parts in patterns.items.iter().skip(1) {
            let parts = data(host, parts, line).await?;
            let parts = parts.as_array().ok_or_else(|| invalid(name))?;
            let mut pattern = String::new();
            for part in parts {
              let pair = part.as_array().ok_or_else(|| invalid(name))?;
              let value = pair.first().ok_or_else(|| invalid(name))?;
              let active = pair.get(1).and_then(JsonValue::as_bool).unwrap_or(false);
              for c in text(value).chars() {
                if !active {
                  pattern.push('\\');
                }
                pattern.push(c);
              }
            }
            if host.shell_case_matches(&pattern, &word) {
              matched = true;
              break;
            }
          }
        }
        if matched {
          // An empty arm succeeds without executing a pipeline. Evaluating
          // its empty sequence would overwrite the previous PIPESTATUS.
          let empty = matches!(body, LispValue::List(list) if list.items.len() == 1
            && host.application_head(body).as_deref() == Some("std.sh.seq"));
          if !empty {
            let value = eval_flow(host, body, line, ignored, output.clone().plain(), false).await?;
            output.flush_value(host, value);
            status = host.shell_status();
          }
          match ending.as_str() {
            ";&" => fallthrough = true,
            ";;&" => fallthrough = false,
            _ => break,
          }
        }
      }
      // A case with no executed arm leaves PIPESTATUS alone. With a body,
      // it keeps that body's final pipeline, including all stage statuses.
      host.set_compound_status(status);
      Ok(None)
    }
    _ => Err(invalid(name)),
  }
}

enum LoopTransfer {
  Value(Option<JsonValue>),
  Break,
  Continue,
}
fn loop_transfer(result: Result<Option<JsonValue>>) -> Result<LoopTransfer> {
  match result {
    Ok(value) => Ok(LoopTransfer::Value(value)),
    Err(TshScriptErrorKind::Control(ControlSignal::Break(1))) => Ok(LoopTransfer::Break),
    Err(TshScriptErrorKind::Control(ControlSignal::Continue(1))) => Ok(LoopTransfer::Continue),
    Err(TshScriptErrorKind::Control(ControlSignal::Break(n))) => {
      Err(TshScriptErrorKind::Control(ControlSignal::Break(n - 1)))
    }
    Err(TshScriptErrorKind::Control(ControlSignal::Continue(n))) => {
      Err(TshScriptErrorKind::Control(ControlSignal::Continue(n - 1)))
    }
    Err(error) => Err(error),
  }
}

impl LispHost {
  pub(super) fn shell_readonly(&self, name: &str) -> bool {
    // A Bash attribute only; Lisp assignment remains an open project decision.
    self.shell_compound.commands.attributes.borrow().get(name).is_some_and(|attr| attr.readonly)
  }

  pub(super) fn assign_shell_variable(&mut self, name: &str, value: String, local: bool) {
    if name == "OPTIND" { self.shell_compound.commands.getopts_offset = 0; }
    let symbol = self.interp.string_interner().get_or_intern(name);
    self.refresh_shell_symbols();
    let exported_value = value.clone();
    let value = LispValue::String(value.into());
    if local {
      self.env.borrow_mut().define(symbol, value);
    } else if self.env.borrow_mut().set(symbol, value.clone()).is_err() {
      Env::root_of(&self.env).borrow_mut().define(symbol, value);
    }
    if let Some(map) = tento_env::global_env_map().filter(|map| map.get(name).is_some()) {
      map.set(name, exported_value);
    }
  }

  pub(super) async fn call_shell_function(
    &mut self,
    body: LispValue<Sym>,
    argv: Vec<String>,
    line: usize,
    ignored: bool,
    output: FlowOutput,
    last: bool,
  ) -> Result<Option<JsonValue>> {
    let saved_env = self.env.clone();
    self.env = Rc::new(RefCell::new(Env::extend(saved_env.clone())));
    // FUNCNAME/BASH_SOURCE/BASH_LINENO gain this call's frame; the body's
    // lines count from its definition, as bash's `$LINENO` does.
    let name = argv.first().cloned().unwrap_or_default();
    let origin = self.function_origin(&name);
    let body_line = origin.as_ref().map_or(line, |origin| origin.line);
    let source = origin.map_or_else(|| self.current_shell_source(), |origin| origin.source);
    self.push_call_frame(name, source, line);
    let prefixes = self
      .shell_io
      .borrow()
      .as_ref()
      .map(|io| io.1.clone())
      .unwrap_or_default();
    for (key, value) in prefixes {
      self.assign_shell_variable(&key, value, true);
    }
    let saved_args = self
      .shell_compound
      .positional
      .replace(argv.into_iter().skip(1).collect());
    self.shell_compound.calls += 1;
    // A function body does not see its caller's loops: `break` there is
    // "only meaningful in a loop", as in bash.
    let caller_loops = std::mem::replace(&mut self.shell_compound.loops, 0);
    self.shell_compound.locals.push(HashMap::new());
    self.shell_compound.local_attributes.push(HashMap::new());
    let return_trap = self.shell_compound.commands.traps.get("RETURN").cloned();
    let result = eval_flow(self, &body, body_line, ignored, output.clone().plain(), last).await;
    // A RETURN trap is not inherited by functions: it fires for the call
    // that set it.
    let result = if self.shell_compound.commands.traps.get("RETURN") != return_trap.as_ref()
      || self.shell_compound.commands.functrace
    {
      self.run_shell_trap("RETURN", line, output.clone()).await.and(result)
    } else {
      result
    };
    self.restore_local_options();
    self.pop_call_frame();
    self.shell_compound.calls -= 1;
    self.shell_compound.loops = caller_loops;
    if let Some(frame) = self.shell_compound.local_attributes.pop() {
      let mut attributes = self.shell_compound.commands.attributes.borrow_mut();
      for (name, previous) in frame {
        if let Some(previous) = previous {
          attributes.insert(name, previous);
        } else {
          attributes.remove(&name);
        }
      }
    }
    if let Some(locals) = self.shell_compound.locals.pop() {
      if let Some(map) = tento_env::global_env_map() {
        for (key, value) in locals {
          if let Some(value) = value {
            map.set(key, value);
          } else {
            map.remove(&key);
          }
        }
      }
    }
    self.shell_compound.positional.replace(saved_args);
    self.env = saved_env;
    match result {
      Err(TshScriptErrorKind::Control(ControlSignal::Return(status))) => {
        self.set_shell_status(status);
        if status != 0 && self.shell_errexit && !ignored {
          Err(TshScriptErrorKind::BashStatus(status))
        } else {
          Ok(None)
        }
      }
      Ok(value) => {
        output.flush_value(self, value);
        Ok(None)
      }
      result => result,
    }
  }

  pub(super) fn shell_compound_command(&self, head: Option<&str>) -> bool {
    if head == Some("let") { return true; }
    head.is_some_and(|name| self.shell_compound.functions.contains_key(name))
      || matches!(
        head,
        Some(
          "."
            | "source"
            | "mapfile"
            | "readarray"
            | "read"
            | "local"
            | "declare"
            | "typeset"
            | "readonly"
            | "getopts"
            | "shift"
            | "return"
            | "break"
            | "continue"
            | "std.sh.set"
            | "exec"
            | "eval"
            | "trap"
            | "umask"
            | "kill"
            | "shopt"
            | "wait"
            | "jobs"
            | "alias"
            | "unalias"
            | "std.sh.unset"
            | "export"
        )
      )
      || head == Some("exit") && !self.shell_prompt
  }

  pub(super) fn compound_builtin(
    &mut self,
    argv: &[String],
    line: usize,
  ) -> Option<Result<Option<JsonValue>>> {
    let name = argv.first()?.as_str();
    if !matches!(
      name,
      "break" | "continue" | "return" | "exit" | "shift" | "local" | "declare" | "typeset" | "readonly" | "getopts" | "read" | "set"
        | "std.sh.unset" | "export"
    ) || name == "exit" && self.shell_prompt
    {
      return None;
    }

    let failure = |host: &mut Self, status, detail: String| {
      host.set_shell_status(status);
      host.report_shell_diagnostic(format!("tsh: line {line}: {name}: {detail}"));
      Ok(None)
    };
    let operands = &argv[1..];
    let result = match name {
      "break" | "continue" => {
        // bash: a non-number is fatal (status 2), a count below one breaks
        // out of every loop with status 1, a count past the loops is capped.
        let count = operands.first().map_or(Ok(1), |n| n.trim().parse::<i64>());
        match count {
          _ if operands.len() > 1 => failure(self, 2, "too many arguments".into()),
          Err(_) => {
            self.report_shell_diagnostic(format!(
              "tsh: line {line}: {name}: {}: numeric argument required",
              operands[0]
            ));
            self.set_shell_status(2);
            Err(TshScriptErrorKind::Control(ControlSignal::Exit(2)))
          }
          _ if self.shell_compound.loops == 0 => {
            failure(self, 0, "only meaningful in a `for', `while', or `until' loop".into())
          }
          Ok(n) if n < 1 => {
            self.report_shell_diagnostic(format!("tsh: line {line}: {name}: {n}: loop count out of range"));
            self.set_shell_status(1);
            Err(TshScriptErrorKind::Control(ControlSignal::Break(self.shell_compound.loops)))
          }
          Ok(n) => {
            self.set_shell_status(0);
            let n = (n as usize).min(self.shell_compound.loops);
            Err(TshScriptErrorKind::Control(if name == "break" {
              ControlSignal::Break(n)
            } else {
              ControlSignal::Continue(n)
            }))
          }
        }
      }
      "return" | "exit" => {
        if name == "return" && self.shell_compound.calls == 0 && self.shell_compound.sources == 0 {
          failure(
            self,
            2,
            "can only `return' from a function or sourced script".into(),
          )
        } else if operands.len() > 1 {
          failure(self, 1, "too many arguments".into())
        } else {
          // bash accepts surrounding blanks; a non-number is reported and
          // the builtin still acts with status 2 (`exit` then continues).
          let status = operands
            .first()
            .map(|n| n.trim().parse::<i64>())
            .unwrap_or(Ok(i64::from(self.shell_status())));
          match status {
            Ok(status) => {
              let status = status.rem_euclid(256) as i32;
              self.set_shell_status(status);
              Err(TshScriptErrorKind::Control(if name == "exit" {
                ControlSignal::Exit(status)
              } else {
                ControlSignal::Return(status)
              }))
            }
            Err(_) => {
              self.report_shell_diagnostic(format!(
                "tsh: line {line}: {name}: {}: numeric argument required",
                operands[0]
              ));
              self.set_shell_status(2);
              if name == "exit" { Ok(None) } else { Err(TshScriptErrorKind::Control(ControlSignal::Return(2))) }
            }
          }
        }
      }
      "set" => self.set_shell_options(operands),
      "shift" => {
        // bash: a count past the end fails silently (only shift_verbose
        // reports it), a negative count is reported, a non-number is a
        // usage error.
        let operands = operands.strip_prefix(&["--".to_string()]).unwrap_or(operands);
        let count = operands.first().map_or(Ok(1), |n| n.parse::<i64>());
        let available = self.shell_compound.positional.borrow().len();
        match count {
          _ if operands.len() > 1 => failure(self, 2, "too many arguments".into()),
          Err(_) => failure(self, 2, format!("{}: numeric argument required", operands[0])),
          Ok(count) if count < 0 => failure(self, 1, format!("{count}: shift count out of range")),
          Ok(count) if count as usize > available => {
            self.set_shell_status(1);
            Ok(None)
          }
          Ok(count) => {
            self.shell_compound.positional.borrow_mut().drain(..count as usize);
            self.set_shell_status(0);
            Ok(None)
          }
        }
      }
      "local" | "declare" | "typeset" | "readonly" => self.declare_shell_variables(name, operands, line),
      "getopts" => self.get_shell_options(operands, line),
      "read" => self.read_shell_builtin(operands, line),
      "std.sh.unset" => self.unset_shell_names(operands, line),
      "export" => self.export_shell_names(operands, line),
      _ => unreachable!(),
    };
    Some(result)
  }

  pub(in crate::script) fn read_shell_byte(&mut self) -> std::io::Result<Option<u8>> {
    let target = self.shell_io.borrow().as_ref().map(|io| io.target(0));
    match target {
      Some(super::FdTarget::File(file)) => {
        let mut byte = [0];
        Ok(((&*file).read(&mut byte)? != 0).then_some(byte[0]))
      }
      Some(super::FdTarget::Text(text)) => {
        let mut bytes = text
          .lock()
          .map_err(|_| std::io::Error::other("stdin lock is poisoned"))?;
        Ok(if bytes.is_empty() {
          None
        } else {
          Some(bytes.remove(0))
        })
      }
      Some(super::FdTarget::Closed) => Err(std::io::Error::from_raw_os_error(9)),
      _ => {
        if let Some(bytes) = &mut *self.shell_stdin.borrow_mut() {
          return Ok(if bytes.is_empty() {
            None
          } else {
            Some(bytes.remove(0))
          });
        }
        let mut byte = [0];
        // A buffered stdin read would steal later script lines from the
        // incremental source reader and from children inheriting this fd.
        #[cfg(unix)]
        {
          let fd = match target { Some(super::FdTarget::Inherit(fd)) => fd, _ => 0 };
          loop {
            let count = unsafe { libc::read(fd, byte.as_mut_ptr().cast(), 1) };
            if count >= 0 { return Ok((count != 0).then_some(byte[0])); }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted { return Err(error); }
          }
        }
        #[cfg(windows)]
        {
          use std::os::windows::io::{AsHandle as _, FromRawHandle as _, IntoRawHandle as _};
          let handle = std::io::stdin().as_handle().try_clone_to_owned()?;
          let mut input = unsafe { std::fs::File::from_raw_handle(handle.into_raw_handle()) };
          Ok((input.read(&mut byte)? != 0).then_some(byte[0]))
        }
      }
    }
  }

  // Superseded by `read_shell_builtin` (bash_read.rs, p1h); delete once reviewed.
  #[allow(dead_code)]
  fn read_shell_line(&mut self, operands: &[String], line: usize) -> Result<Option<JsonValue>> {
    if let Some(gate) = &self.shell_builtin_gate {
      if let Err(error) = gate("read") {
        self.set_shell_status(error.process_status().unwrap_or(1));
        self.report_shell_diagnostic(format!("tsh: line {line}: read: {error}"));
        return Ok(None);
      }
    }
    let mut raw = false;
    let mut names = Vec::new();
    let mut options = true;
    for operand in operands {
      if options && operand == "--" {
        options = false;
      } else if options && operand == "-r" {
        raw = true;
      } else if options && operand.starts_with('-') {
        self.set_shell_status(2);
        self.report_shell_diagnostic(format!(
          "tsh: line {line}: read: {operand}: unsupported option"
        ));
        return Ok(None);
      } else {
        options = false;
        names.push(operand.as_str());
      }
    }
    if names.iter().any(|name| !shell_identifier(name)) {
      self.set_shell_status(1);
      self.report_shell_diagnostic(format!("tsh: line {line}: read: not a valid identifier"));
      return Ok(None);
    }
    let mut bytes = Vec::new();
    let mut protected = Vec::new();
    let mut escaped = false;
    let newline = loop {
      let byte = match self.read_shell_byte() {
        Ok(Some(byte)) => byte,
        Ok(None) => break false,
        Err(error) => {
          self.set_shell_status(1);
          self.report_shell_diagnostic(format!("tsh: line {line}: read: {error}"));
          return Ok(None);
        }
      };
      if !raw && !escaped && byte == b'\\' {
        escaped = true;
        continue;
      }
      if byte == b'\n' {
        if escaped {
          escaped = false;
          continue;
        }
        break true;
      }
      if byte != 0 {
        bytes.push(byte);
        protected.push(escaped);
      }
      escaped = false;
    };
    let text = String::from_utf8(bytes).map_err(|_| {
      TshScriptErrorKind::Lisp(LispHostError::Command(
        "read: stdin is not UTF-8 — byte-valued variables are not supported yet".into(),
      ))
    })?;
    if names.is_empty() {
      if self.shell_readonly("REPLY") {
        self.report_shell_diagnostic(format!("tsh: line {line}: REPLY: readonly variable"));
        self.set_shell_status(1);
        return Ok(None);
      }
      self.assign_shell_variable("REPLY", text, false);
    } else {
      let symbol = self.interp.string_interner().get_or_intern("IFS");
      let prefixed_ifs = self.shell_io.borrow().as_ref().and_then(|io| {
        io.1
          .iter()
          .rev()
          .find(|(name, _)| name == "IFS")
          .map(|(_, value)| value.clone())
      });
      let ifs = prefixed_ifs
        .or_else(|| {
          self.env.borrow().get(symbol).and_then(|v| {
            if let LispValue::String(s) = v {
              Some(s.into_string())
            } else {
              None
            }
          })
        })
        .or_else(|| tento_env::effective_var("IFS"))
        .unwrap_or_else(|| " \t\n".into());
      let values = read_fields(&text, &protected, &ifs, names.len());
      for (name, value) in names.into_iter().zip(values) {
        if self.shell_readonly(name) {
          self.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly variable"));
          self.set_shell_status(1);
          return Ok(None);
        }
        self.assign_shell_variable(name, value, false);
      }
    }
    self.set_shell_status(if newline { 0 } else { 1 });
    Ok(None)
  }
}

fn shell_identifier(name: &str) -> bool {
  !name.is_empty()
    && !name.as_bytes()[0].is_ascii_digit()
    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub(super) fn read_fields(text: &str, protected: &[bool], ifs: &str, count: usize) -> Vec<String> {
  let chars: Vec<_> = text.char_indices().collect();
  let offset = |i: usize| chars.get(i).map_or(text.len(), |(offset, _)| *offset);
  let delimiter = |i: usize| {
    !protected[offset(i)..offset(i + 1)]
      .iter()
      .any(|value| *value)
      && ifs.contains(chars[i].1)
  };
  let whitespace = |i: usize| delimiter(i) && matches!(chars[i].1, ' ' | '\t' | '\n');
  let mut start = 0;
  let mut end = chars.len();
  while start < end && whitespace(start) {
    start += 1;
  }
  while end > start && whitespace(end - 1) {
    end -= 1;
  }
  let mut fields = Vec::new();
  for index in 0..count {
    let first = start;
    if index + 1 == count {
      // With one field left Bash removes its terminating non-whitespace
      // delimiter. With several fields left the last variable keeps the
      // original remainder, including its separators.
      let last_end = if (first..end).find(|i| delimiter(*i)) == end.checked_sub(1)
        && end > first
        && delimiter(end - 1)
        && !whitespace(end - 1)
      {
        end - 1
      } else {
        end
      };
      fields.push(text[offset(first)..offset(last_end)].to_string());
      break;
    }
    while start < end && !delimiter(start) {
      start += 1;
    }
    fields.push(text[offset(first)..offset(start)].to_string());
    if start < end {
      if whitespace(start) {
        while start < end && whitespace(start) {
          start += 1;
        }
        if start < end && delimiter(start) {
          start += 1;
        }
      } else {
        start += 1;
      }
      while start < end && whitespace(start) {
        start += 1;
      }
    }
  }
  fields
}

/// Pipeline stages execute with copies of shell variables, functions, options
/// and positional parameters, while sharing the stage's descriptor handles.
pub(super) async fn pipeline_stage(
  host: &mut LispHost,
  value: &LispValue<Sym>,
  line: usize,
  output: FlowOutput,
  last: bool,
) -> Result<Option<JsonValue>> {
  isolated_stage(host, value, line, true, output, last).await
}

async fn isolated_stage(
  host: &mut LispHost, value: &LispValue<Sym>, line: usize, ignored: bool,
  output: FlowOutput, last: bool,
) -> Result<Option<JsonValue>> {
  let saved_env = host.env.clone();
  let mut snapshot = Env::new();
  for (symbol, _) in host.interp.string_interner().iter() {
    if let Some(value) = saved_env.borrow().get(symbol) {
      snapshot.define(symbol, value);
    }
  }
  // $BASH_SUBSHELL counts the levels below the top-level shell.
  let level_symbol = host.interp.string_interner().get_or_intern("BASH_SUBSHELL");
  let level = saved_env.borrow().get(level_symbol).and_then(|value| match value { LispValue::String(text) => text.parse::<u32>().ok(), _ => None }).unwrap_or(0);
  snapshot.define(level_symbol, LispValue::String((level + 1).to_string().into()));
  host.env = Rc::new(RefCell::new(snapshot));
  let functions = host.shell_compound.functions.clone();
  let attributes = host.shell_compound.commands.attributes.borrow().clone();
  let local_attributes = host.shell_compound.local_attributes.clone();
  let locals = host.shell_compound.locals.clone();
  let positionals = host.shell_compound.positional.borrow().clone();
  let loops = std::mem::replace(&mut host.shell_compound.loops, 0);
  let errexit = host.shell_errexit;
  let noglob = host.shell_compound.noglob.get();
  let pipeline_status_known = host.shell_compound.pipeline_status_known.get();
  let nounset = host.shell_compound.commands.nounset.get();
  let brace_disabled = host.shell_compound.commands.brace_disabled.get();
  let glob = host.shell_compound.commands.glob.get();
  let xtrace = host.shell_compound.commands.xtrace;
  let pipefail = host.shell_compound.commands.pipefail;
  let noclobber = host.shell_compound.commands.noclobber;
  let shell_options = {
    let c = &host.shell_compound.commands;
    (c.errtrace, c.functrace, c.inherit_errexit, c.nocasematch, c.lastpipe)
  };
  let traps = host.enter_subshell_traps();
  #[cfg(unix)]
  let umask = (current_umask(), host.shell_compound.commands.umask_changes);
  let persistent_io = host.shell_compound.commands.persistent_io.clone();
  // `exec 3>f` in the subshell rewires the live descriptor table too.
  let shell_io = host.shell_io.borrow().clone();
  let pid = host.shell_compound.commands.last_pid.get();
  let calls = host.shell_compound.calls;
  let getopts = (host.shell_compound.commands.getopts_index, host.shell_compound.commands.getopts_offset);
  let zero = host.shell_compound.zero.borrow().clone();
  let specials = super::bash_attributes::save_specials();
  let cwd = std::env::current_dir().ok();
  let map = tento_env::global_env_map()
    .map(|map| map.fork())
    .unwrap_or_else(tento_env::EnvMap::from_process);
  let result = tento_env::with_env_map_async(map, async {
    let result = match eval_flow(host, value, line, ignored, output.clone(), last).await {
      Err(TshScriptErrorKind::Control(
        ControlSignal::Exit(status) | ControlSignal::ExecExit(status) | ControlSignal::Return(status)
          | ControlSignal::Discard(status),
      )) => {
        host.set_shell_status(status);
        Ok(None)
      }
      // `set -e` inside ends only this subshell; the parent sees its status
      // (and applies its own errexit to that). A suspension is the host's.
      Err(TshScriptErrorKind::BashStatus(status)) if !host.shell_suspended() => {
        host.set_shell_status(status);
        Ok(None)
      }
      result => result,
    };
    // The subshell's own EXIT trap runs as it ends; the parent's never does.
    let trap = host.leave_subshell_traps(traps, line, output).await;
    match (result, trap) {
      (Ok(value), Ok(())) => Ok(value),
      (Err(error), _) | (Ok(_), Err(error)) => Err(error),
    }
  })
  .await;
  host.env = saved_env;
  super::bash_attributes::restore_specials(specials);
  host.shell_compound.functions = functions;
  host.shell_compound.commands.attributes.replace(attributes);
  host.shell_compound.local_attributes = local_attributes;
  host.shell_compound.locals = locals;
  host.shell_compound.positional.replace(positionals);
  host.shell_compound.loops = loops;
  host.shell_errexit = errexit;
  host.shell_compound.noglob.set(noglob);
  host.shell_compound.pipeline_status_known.set(pipeline_status_known);
  host.shell_compound.commands.nounset.set(nounset);
  host.shell_compound.commands.brace_disabled.set(brace_disabled);
  host.shell_compound.commands.glob.set(glob);
  host.shell_compound.commands.xtrace = xtrace;
  host.shell_compound.commands.pipefail = pipefail;
  host.shell_compound.commands.noclobber = noclobber;
  {
    let c = &mut host.shell_compound.commands;
    (c.errtrace, c.functrace, c.inherit_errexit, c.nocasematch, c.lastpipe) = shell_options;
  }
  // A `umask` inside the subshell stays there. Only this shell's own change
  // is undone, so another shell in the process keeps its mask.
  #[cfg(unix)]
  if host.shell_compound.commands.umask_changes != umask.1 {
    // SAFETY: umask only replaces the process file-creation mask.
    unsafe { libc::umask(umask.0) };
  }
  host.shell_compound.commands.persistent_io = persistent_io;
  *host.shell_io.borrow_mut() = shell_io;
  host.shell_compound.commands.last_pid.set(pid);
  host.shell_compound.calls = calls;
  (host.shell_compound.commands.getopts_index, host.shell_compound.commands.getopts_offset) = getopts;
  host.shell_compound.zero.replace(zero);
  host.refresh_shell_flags();
  if let Some(cwd) = cwd {
    if std::env::current_dir().ok().as_ref() != Some(&cwd) {
      std::env::set_current_dir(cwd)
        .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error.to_string())))?;
    }
  }
  match result {
    Err(TshScriptErrorKind::Control(
      ControlSignal::Exit(status) | ControlSignal::ExecExit(status) | ControlSignal::Return(status)
        | ControlSignal::Discard(status),
    )) => {
      host.set_shell_status(status);
      Ok(None)
    }
    result => result,
  }
}

/// The process file-creation mask, read without changing it.
#[cfg(unix)]
pub(super) fn current_umask() -> libc::mode_t {
  // SAFETY: umask only swaps the mask; the old one is put straight back.
  unsafe {
    let mask = libc::umask(0o022);
    libc::umask(mask);
    mask
  }
}

/// `$(…)`: the command runs in a subshell and its stdout is captured. bash
/// (outside POSIX mode) clears `-e` there unless `inherit_errexit` is set; an
/// errexit exit ends only the substitution, whose status becomes `$?`.
pub(super) async fn capture_substitution(
  host: &mut LispHost,
  value: &LispValue<Sym>,
  line: usize,
) -> Result<Vec<u8>> {
  let bytes = Rc::new(RefCell::new(Vec::new()));
  let errexit = host.shell_errexit;
  let inherit = errexit && host.shell_compound.commands.inherit_errexit;
  host.shell_errexit = inherit;
  let output = FlowOutput { capture: Some(bytes.clone()), shaped: false, writer: None };
  host.shell_compound.commands.trace_level += 1;
  // Only -e is cleared: the ERR trap (under `set -E`) still fires inside.
  let result = isolated_stage(host, value, line, false, output, false).await;
  host.shell_compound.commands.trace_level -= 1;
  host.shell_errexit = errexit;
  match result {
    Err(TshScriptErrorKind::BashStatus(status)) => host.set_shell_status(status),
    result => {
      result?;
    }
  }
  let captured = std::mem::take(&mut *bytes.borrow_mut());
  Ok(captured)
}

pub(super) async fn capture_pipeline_stage(
  host: &mut LispHost,
  value: &LispValue<Sym>,
  line: usize,
) -> Result<Vec<u8>> {
  let bytes = Rc::new(RefCell::new(Vec::new()));
  pipeline_stage(
    host,
    value,
    line,
    FlowOutput {
      capture: Some(bytes.clone()),
      shaped: false,
      writer: None,
    },
    false,
  )
  .await?;
  let result = std::mem::take(&mut *bytes.borrow_mut());
  Ok(result)
}
