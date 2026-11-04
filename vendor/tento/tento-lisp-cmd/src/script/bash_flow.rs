use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use serde_json::Value as JsonValue;
use tento_lisp::Value as LispValue;

use super::interp::{LispHost, LispHostError, Sym};
use super::runner::{TshScriptErrorKind, run_bash_stage};

pub type ShellFormatter = Rc<dyn Fn(&JsonValue) -> Option<String>>;
pub type BashOutput = Rc<dyn Fn(usize, &JsonValue, bool) -> bool>;

/// Captured stdout stays byte-valued until a caller requests stdin text.
#[derive(Debug)]
pub struct ShellCapture {
  pub stdout: Vec<u8>,
  pub status: i32,
  /// Ordered stage statuses, including failed launches, for pipefail.
  pub statuses: Vec<i32>,
  /// Per-child launch failures; the host supplies its source-line diagnostic.
  pub start_errors: Vec<(i32, String)>,
}

pub struct ShellJob {
  pub pid: u32,
  pub completion: PipelineFuture,
}

pub type PipelineFuture = Pin<Box<dyn Future<Output = crate::Result<ShellCapture>>>>;

#[derive(Clone, Default)]
pub(super) struct FlowOutput {
  pub writer: Option<BashOutput>,
  pub shaped: bool,
  pub capture: Option<Rc<RefCell<Vec<u8>>>>,
}

impl FlowOutput {
  pub(super) fn plain(mut self) -> Self {
    self.shaped = false;
    self
  }

  pub(super) fn write_bytes(&self, host: &mut LispHost, bytes: &[u8]) {
    let io = host.shell_io.borrow().clone();
    if let Some(io) = io {
      let target = io.target(1);
      if !matches!(target, super::FdTarget::Inherit(1)) {
        if let Err(error) = host.write_shell_target(&target, bytes) {
          host.set_shell_status(1);
          host.report_shell_diagnostic(format!("tsh: write error: {error}"));
        }
        return;
      }
    }
    self.write_inherited_bytes(host, bytes);
  }

  pub(super) fn write_inherited_bytes(&self, host: &mut LispHost, bytes: &[u8]) {
    if let Some(buffer) = &self.capture {
      buffer.borrow_mut().extend_from_slice(bytes);
    } else if !bytes.is_empty() {
      // The value formatter adds a newline; byte writes must bypass it.
      let _ = host.write_shell_target(&super::FdTarget::Inherit(1), bytes);
    }
  }


  pub(super) fn flush_value(&self, host: &mut LispHost, value: Option<JsonValue>) {
    if let Some(value) = value {
      if let Some(text) = host.render_shell_value(&value) { self.write_bytes(host, text.as_bytes()); }
      host.command_json.set(false);
    }
  }

  fn write(&self, host: &mut LispHost, line: usize, value: JsonValue, last: bool) -> Option<JsonValue> {
    if host.command_json_output() {
      let text = format!("{}\n", value);
      self.write_bytes(host, text.as_bytes());
      host.command_json.set(false);
      return None;
    }

    let io = host.shell_io.borrow().clone();
    if let Some(io) = io {
      let target = io.target(1);
      if !matches!(target, super::FdTarget::Inherit(1)) {
        if let Some(text) = host.render_shell_value(&value) {
          if let Err(error) = host.write_shell_target(&target, text.as_bytes()) {
            host.set_shell_status(1);
            host.report_shell_diagnostic(format!("tsh: line {line}: write error: {}",
              if error.raw_os_error() == Some(9) { "Bad file descriptor".into() } else { error.to_string() }));
          }
        }
        return None;
      }
    }
    if let Some(buffer) = &self.capture {
      if let Some(text) = host.render_shell_value(&value) {
        buffer.borrow_mut().extend_from_slice(text.as_bytes());
      }
      None
    } else if self
      .writer
      .as_ref()
      .is_some_and(|write| write(line, &value, last))
    {
      None
    } else {
      Some(value)
    }
  }
}

pub(super) fn is_flow(head: Option<&str>) -> bool {
  matches!(
    head,
    Some(
      "std.sh.seq"
        | "std.sh.and"
        | "std.sh.or"
        | "std.sh.pipe"
        | "std.sh.not"
        | "std.sh.redirect"
        | "std.sh.if"
        | "std.sh.while"
        | "std.sh.for"
        | "std.sh.case"
        | "std.sh.group"
        | "std.sh.function"
        | "std.sh.test"
        | "std.sh.condition"
        | "std.sh.background"
        | "std.sh.subshell"
        | "std.sh.arithmetic"
        | "std.sh.arithmetic-for"
        | "std.sh.time"
        | "std.sh.select"
        | "std.sh.display"
        | "std.sh.line"
        | "std.sh.cmd"
        | "std.sh.assign"
        | "std.sh.append"
        | "std.sh.heredoc-warning"
        | "std.sh.array-assign"
        | "std.sh.array-traced"
        | "std.sh.declare-initializer"
    )
  )
}

/// `(std.sh.line DELTA BODY)`: the reader's mark on a list member that
/// starts DELTA physical lines below its enclosing command.
pub(super) fn line_marker<'v>(host: &mut LispHost, value: &'v LispValue<Sym>) -> Option<(usize, &'v LispValue<Sym>)> {
  let LispValue::List(list) = value else { return None };
  let [LispValue::Symbol(head), LispValue::Integer(delta), body] = list.items.as_slice() else { return None };
  (host.interp.string_interner().resolve(head.as_symbol()) == Some("std.sh.line"))
    .then(|| (usize::try_from(*delta).unwrap_or(0), body))
}

fn has_substitution(host: &mut LispHost, value: &LispValue<Sym>) -> bool {
  if matches!(host.application_head(value).as_deref(), Some("std.sh.sub" | "std.sh.read-file")) { return true; }
  matches!(value, LispValue::List(list) if list.items.iter().skip(1).any(|item| has_substitution(host, item)))
}

/// The operands are syntax, not evaluated arguments. Every leaf enters the
/// same status/diagnostic door as a standalone Bash line.
pub(super) fn eval_flow<'a>(
  host: &'a mut LispHost,
  value: &'a LispValue<Sym>,
  line: usize,
  ignored: bool,
  output: FlowOutput,
  last: bool,
) -> Pin<Box<dyn Future<Output = Result<Option<JsonValue>, TshScriptErrorKind>> + 'a>> {
  Box::pin(async move {
    // A member the reader found on a later physical line runs at that line.
    if let Some((delta, body)) = line_marker(host, value) {
      return eval_flow(host, body, line + delta, ignored, output, last).await;
    }
    // A redirected command's fork reservation for its words (see
    // `shell_redirect::run`), claimed before anything else can run.
    let mut handoff = host.take_fork_handoff();
    let _output_boundary = super::process_pipeline::OutputBoundary::enter();
    super::bash_attributes::set_current_line(line);
    let _process_scope = super::shell_workers::ProcessScope::enter(host);
    host.refresh_shell_flags();
    host.import_environment_functions();
    let _persistent = if host.shell_io.borrow().is_none() {
      host.shell_compound.commands.persistent_io.clone()
        .map(|io| super::shell_redirect::IoRestore::install(host, io))
    } else { None };
    host.poll_shell_signals(line, output.clone()).await?;
    let _output_restore = OutputRestore {
      slot: host.shell_output.clone(), saved: host.shell_output.replace(output.clone()),
    };
    if let Some((stage, specs)) = super::shell_redirect::redirected_stage(host, value) {
      return super::shell_redirect::run(host, stage, specs, line, ignored, output, last, handoff.take()).await;
    }
    let head = host.application_head(value);
    if !is_flow(head.as_deref()) || matches!(head.as_deref(), Some("std.sh.cmd" | "std.sh.append")) {
      host.command_json.set(false);
      let append = head.as_deref() == Some("std.sh.append");
      let assignment = append || host.is_let_binding(value);
      let substitution = assignment && has_substitution(host, value);
      // Only this command's expansion failures are reported below: one left
      // by `((…))`, `let` or a loop word was already reported there.
      host.shell_compound.commands.expansion_failure.borrow_mut().take();
      host.shell_compound.commands.expansion_failure_127.set(false);
      host.shell_compound.commands.expansion_failure_arithmetic.set(false);
      // Taken here, so the command's own redirections never reach a nested one.
      let expansion_io = host.shell_compound.commands.expansion_io.take();
      let outer_report_io = std::mem::replace(&mut host.shell_compound.commands.expansion_report_io, expansion_io.clone());
      // The command's fork reservation spans its word expansion only. A
      // refusal fails the command as an expansion error, before any of it.
      let reserved = match handoff.take() {
        Some(unit) => Ok(Some(unit)),
        None => {
          let forks = super::owned_io_fork::words_fork(host, value);
          host.reserve_fork_unit(forks, "command", line)
        }
      };
      let resolved = match reserved {
        Ok(unit) => {
          let resolved = super::shell_redirect::resolve_target(host, value, line).await;
          drop(unit);
          resolved
        }
        Err(refused) => Err(refused),
      };
      host.shell_compound.commands.expansion_report_io = outer_report_io;
      let failure = host
        .shell_compound
        .commands
        .expansion_failure
        .borrow_mut()
        .take();
      if let Some(detail) = failure {
        host.report_expansion_diagnostic(expansion_io, format!("tsh: line {line}: {detail}"));
        let status = host.expansion_failure_status_of_command();
        host.set_shell_status(status.0);
        return Err(TshScriptErrorKind::Control(status.1));
      }
      let mut resolved = match resolved {
        Ok(resolved) => resolved,
        // A native failing inside an expansion warns and fails this command
        // only, as a failed bash expansion step does (Q6 item 18).
        Err(error) => {
          if host.shell_suspended() { return Err(TshScriptErrorKind::BashStatus(host.shell_status())); }
          host.report_expansion_diagnostic(expansion_io, format!("tsh: line {line}: {error}"));
          host.set_shell_status(1);
          if !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
          if host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(1)); }
          return Ok(None);
        }
      };
      if assignment { host.follow_nameref_assignment(&mut resolved); } else { super::bash_attributes::remember_last_argument(&resolved); }
      let assignment_status = assignment.then(|| if substitution { host.shell_status() } else { 0 });
      // xtrace shows an assignment as its source operator and expanded
      // word (`x+=5`, not the lowered `x=15`); the prefix is expanded
      // before the assignment, so `PS4=…` traces under the old PS4.
      let mut append_word = None;
      if append {
        if let LispValue::List(list) = &resolved {
          if let [_, LispValue::Symbol(symbol), rhs] = list.items.as_slice() {
            let name = host.interp.string_interner().resolve(symbol.as_symbol()).unwrap_or("").to_string();
            let attr = host.shell_compound.commands.attributes.borrow().get(&name).copied().unwrap_or_default();
            // Readonly is a Bash attribute. The Lisp setter remains unchanged
            // until the cross-dialect assignment decision is made.
            if attr.readonly {
              host.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly variable"));
              host.set_shell_status(1);
              return Err(TshScriptErrorKind::Control(host.assignment_error_signal(1)));
            }
            let assigned = host.evaluate_shell_data(rhs).map_err(TshScriptErrorKind::Lisp)?;
            let text = assigned.as_str().map(str::to_string).unwrap_or_else(|| assigned.to_string());
            append_word = Some(text.clone());
            let current = host.env.borrow().get(symbol.as_symbol()).map(super::bash_arrays::scalar);
            let current = match current {
              Some(LispValue::String(text)) => text,
              _ => tento_env::effective_var(&name).unwrap_or_default().into(),
            };
            let text = if attr.integer {
              host.integer_shell_value(&format!("({})+({})", if current.is_empty() { "0" } else { &current }, if text.is_empty() { "0" } else { &text }))?
            } else { format!("{current}{text}") };
            let binding = host.interp.string_interner().get_or_intern("let");
            resolved = LispValue::List(tento_lisp::List { items: vec![
              LispValue::Symbol(binding.into()), LispValue::Symbol(symbol.clone()), LispValue::String(text.into()),
            ].into() });
          }
        }
      }
      let assign_prefix = if assignment && host.shell_compound.commands.xtrace {
        Some(host.shell_trace_prefix(line).await?)
      } else { None };
      // A command word that was quoted (`\ls`, `'ls'`) or computed (`$cmd`)
      // never reaches a prompt declaration, as bash expands aliases only on
      // an unquoted literal command word.
      let computed_head = host.is_computed_command(value);
      let mut trace_value = None;
      let mut value = &resolved;
      let head = host.application_head(value);
      if !assignment && host.shell_compound.commands.traps.contains_key("DEBUG") {
        if let Ok(argv) = host.application_to_argv(value) {
          host.run_debug_trap(&argv, line, output.clone()).await?;
        }
      }
      if host.shell_compound.commands.xtrace && !assignment {
        let argv = host.application_to_argv(value).map_err(TshScriptErrorKind::Command)?;
        host.trace_shell_command(&argv, line).await?;
        host.trace_declaration_assignments(&argv, line).await?;
        trace_value = Some(host.shell_literal_call(&argv, &argv[0], false));
        value = trace_value.as_ref().unwrap();
      }
      if matches!(head.as_deref(), Some("type" | "command" | "printf")) {
        let argv = host.application_to_argv(value).map_err(TshScriptErrorKind::Command)?;
        if let Some(result) = host.describe_builtin(&argv, line, ignored, output.clone(), last).await {
          let value = result?;
          if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
          if host.shell_status() != 0 && host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(host.shell_status())); }
          return Ok(value);
        }
      }
      if matches!(head.as_deref(), Some("." | "source" | "mapfile" | "readarray" | "exec" | "eval" | "trap" | "umask" | "shopt" | "alias" | "unalias" | "wait" | "jobs" | "kill" | "disown" | "fg" | "bg" | "std.jobs.spawn" | "std.jobs.wait" | "std.jobs.wait-any" | "std.jobs.foreground")) {
        let argv = host.application_to_argv(value).map_err(TshScriptErrorKind::Command)?;
        if let Some(gate) = &host.shell_builtin_gate { gate(&argv[0]).map_err(TshScriptErrorKind::Command)?; }
        if let Some(result) = host.command_builtin(&argv, line, ignored, output.clone()).await {
          let value = result?;
          if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
          if host.shell_status() != 0 && host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(host.shell_status())); }
          return Ok(value);
        }
      }
      // Bash's `let EXPR…` builtin; an assignment is the `(let NAME VALUE)` binding.
      if head.as_deref() == Some("let") && !assignment {
        let argv = host.application_to_argv(value).map_err(TshScriptErrorKind::Command)?;
        host.shell_let(&argv[1..], line)?;
        if host.shell_status() != 0 && host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(host.shell_status())); }
        return Ok(None);
      }
      if let Some(body) = head.as_ref().and_then(|name| host.shell_compound.functions.get(name)).cloned() {
        let argv = host.application_to_argv(value).map_err(TshScriptErrorKind::Command)?;
        let result = host.call_shell_function(body, argv, line, ignored, output.clone(), last).await;
        if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output).await?; }
        return result;
      }
      if head.as_deref() == Some("caller") {
        let argv = host.application_to_argv(value).map_err(TshScriptErrorKind::Command)?;
        let (text, status) = host.caller_builtin(&argv[1..], line);
        output.write_bytes(host, text.as_bytes());
        host.set_shell_status(status);
        if status != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
        if status != 0 && host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(status)); }
        return Ok(None);
      }
      if matches!(head.as_deref(), Some("read" | "local" | "declare" | "typeset" | "readonly" | "getopts" | "shift" | "return" | "break" | "continue" | "exit" | "std.sh.set" | "std.sh.unset" | "export")) {
        let argv = host.application_to_argv(value).map_err(TshScriptErrorKind::Command)?;
        if let Some(result) = host.compound_builtin(&argv, line) {
          let value = result?;
          if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
          if host.shell_status() != 0 && host.shell_errexit && !ignored {
            return Err(TshScriptErrorKind::BashStatus(host.shell_status()));
          }
          return Ok(value);
        }
      }
      if assignment {
        if let LispValue::List(list) = value {
          if let [_, LispValue::Symbol(symbol), rhs] = list.items.as_slice() {
            let name = host
              .interp
              .string_interner()
              .resolve(symbol.as_symbol())
              .unwrap_or("")
              .to_string();
            if name == "OPTIND" { host.shell_compound.commands.getopts_offset = 0; }
            let attr = host
              .shell_compound
              .commands
              .attributes
              .borrow()
              .get(&name)
              .copied();
            if attr.is_some_and(|a| a.readonly) {
              // Bash-only attribute; do not restrict the Lisp setter here.
              host.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly variable"));
              host.set_shell_status(1);
              return Err(TshScriptErrorKind::Control(host.assignment_error_signal(1)));
            }
            if attr.is_some_and(|a| a.integer) {
              let assigned = host
                .evaluate_shell_data(rhs)
                .map_err(TshScriptErrorKind::Lisp)?;
              let assigned = assigned
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| assigned.to_string());
              if let Some(prefix) = &assign_prefix {
                host.write_assignment_trace(prefix, &name, append_word.as_deref().unwrap_or(&assigned), append_word.is_some());
              }
              let assigned = host.integer_shell_value(&assigned)?;
              if !host.assign_array_scalar(symbol.as_symbol(), assigned.clone()) {
                host.assign_shell_variable(&name, assigned, false);
              }
              host.set_shell_status(assignment_status.unwrap_or(0));
              return Ok(None);
            }
          }
        }
      }
      if assignment && host.assign_case_attribute(value, assign_prefix.as_deref())? {
        host.set_shell_status(assignment_status.unwrap_or(0));
        return Ok(None);
      }
      if assignment {
        if let LispValue::List(list) = value {
          if let [_, LispValue::Symbol(symbol), rhs] = list.items.as_slice() {
            let bound = host.env.borrow().get(symbol.as_symbol());
            if (bound.as_ref().and_then(super::bash_arrays::entries).is_some() || bound.as_ref().and_then(super::bash_arrays::associative_entries).is_some()) {
              let assigned = host.evaluate_shell_data(rhs).map_err(TshScriptErrorKind::Lisp)?;
              let text = assigned.as_str().map(str::to_string).unwrap_or_else(|| assigned.to_string());
              if let Some(prefix) = &assign_prefix {
                let name = host.interp.string_interner().resolve(symbol.as_symbol()).unwrap_or("").to_string();
                host.write_assignment_trace(prefix, &name, append_word.as_deref().unwrap_or(&text), append_word.is_some());
              }
              host.assign_array_scalar(symbol.as_symbol(), text);
              host.set_shell_status(assignment_status.unwrap_or(0));
              return Ok(None);
            }
          }
        }
      }
      if head.as_deref() == Some("let") && assignment && host.shell_compound.calls > 0 {
        if let LispValue::List(list) = value {
          if let [_, LispValue::Symbol(symbol), rhs] = list.items.as_slice() {
            let assigned = host.interp.eval_expression(host.env.clone(), rhs)
              .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Runtime(error.to_string())))?;
            if host.env.borrow_mut().set(symbol.as_symbol(), assigned.clone()).is_err() {
              tento_lisp::Env::root_of(&host.env).borrow_mut().define(symbol.as_symbol(), assigned);
            }
            host.update_exported_assignment(value).map_err(TshScriptErrorKind::Command)?;
            if let Some(prefix) = &assign_prefix {
              if let Some(name) = host.interp.string_interner().resolve(symbol.as_symbol()).map(str::to_string) {
                host.trace_assigned_variable(prefix, &name, append_word.as_deref())?;
              }
            }
            host.set_shell_status(assignment_status.unwrap_or(0));
            if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
          if host.shell_status() != 0 && host.shell_errexit && !ignored {
              return Err(TshScriptErrorKind::BashStatus(host.shell_status()));
            }
            return Ok(None);
          }
        }
      }
      // A prompt declaration (`(let ls std.fs.list_dir)` in the prelude):
      // only the interactive prompt consults it (operator ruling 19).
      let alias = host.shell_prompt
        && !computed_head
        && head
          .as_ref()
          .is_some_and(|name| host.declared_target(name).is_some());
      let builtin = matches!(
        head.as_deref(),
        Some(
          "printf"
            | "echo"
            | ":"
            | "true"
            | "false"
            | "cd"
            | "pwd"
            | "rm"
            | "test"
            | "["
            | "export"
            | "pushd"
            | "popd"
            | "dirs"
        )
      );
      let mut typed = None;
      let mut fallback = None;
      let mut expanded_argv = None;
      if head.as_deref() == Some("env") && host.shell_utility_missing("env") {
        host.set_shell_status(127);
        host.report_shell_diagnostic(format!("tsh: line {line}: env: command not found"));
        return if host.shell_errexit && !ignored {
          Err(TshScriptErrorKind::BashStatus(127))
        } else {
          Ok(None)
        };
      }
      if alias || builtin {
        let mut argv = host
          .application_to_argv(value)
          .map_err(TshScriptErrorKind::Command)?;
        if argv[0] == "export" {
          if let Some(name) = argv.iter().skip(1).filter_map(|arg| arg.split_once('=').map(|(name, _)| name))
            .find(|name| host.shell_readonly(name)).map(str::to_string) {
            host.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly variable"));
            host.set_shell_status(1);
            if !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
            if host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(1)); }
            return Ok(None);
          }
          host
            .shell_export_argv(&mut argv)
            .map_err(TshScriptErrorKind::Command)?;
        }
        expanded_argv = Some(argv.clone());
        if let Some(target) = host.shell_typed_target(&argv, output.shaped) {
          typed = Some(host.shell_literal_call(&argv, &target, true));
        } else if let Some(result) = host.shell_builtin_bytes(argv.clone(), line) {
          if host.shell_suspended() {
            return Err(TshScriptErrorKind::BashStatus(host.shell_status()));
          }
          host.set_shell_status(result.status);
          output.write_bytes(host, &result.stdout);
          for diagnostic in result.diagnostics {
            host.report_shell_diagnostic(diagnostic);
          }
          if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
          if host.shell_status() != 0 && host.shell_errexit && !ignored {
            return Err(TshScriptErrorKind::BashStatus(host.shell_status()));
          }
          return Ok(None);
        } else if output.shaped
          && host.shell_prompt
          && host.shell_utility(&argv[0])
          && host.shell_utility_missing(&argv[0])
        {
          // At the prompt the declaration sits before PATH: with no utility
          // to fall through to, the typed command answers, projected as the
          // utility's bytes. Never in a script, pipe, capture or redirect —
          // there a missing utility is `command not found` (status 127).
          if let Some(target) = host.declared_target(&argv[0]) {
            fallback = Some(argv[0].clone());
            typed = Some(host.shell_literal_call(&argv, &target, false));
          }
        }
      }
      if let Some(typed) = &typed {
        value = typed;
      }
      let plain_utility = typed.is_none()
        && head
          .as_ref()
          .is_some_and(|name| host.shell_utility(name) && !host.shell_utility_missing(name));
      if plain_utility
        || (output.capture.is_some() || host.shell_io.borrow().is_some() || host.shell_stdin_bytes().is_some())
          && host.shell_external_stage(value)
      {
        let argv = match expanded_argv {
          Some(argv) => argv,
          None => host
            .application_to_argv(value)
            .map_err(TshScriptErrorKind::Command)?,
        };
        let input = host.shell_stdin_bytes();
        let io = vec![host.shell_io.borrow().clone()];
        let captured = run_external(host, vec![argv], input, output.capture.is_some(), line, io).await?;
        host.set_shell_status(captured.status);
        host.poll_shell_signals(line, output.clone()).await?;
        if let Some(buffer) = &output.capture { buffer.borrow_mut().extend(captured.stdout); }
        if captured.status != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
        if captured.status != 0 && host.shell_errexit && !ignored {
          return Err(TshScriptErrorKind::BashStatus(captured.status));
        }
        return Ok(None);
      }
      let result = run_bash_stage(value, line, host, ignored, true).await?;
      if let Some(prefix) = &assign_prefix {
        if let LispValue::List(list) = value {
          if let Some(LispValue::Symbol(symbol)) = list.items.get(1) {
            if let Some(name) = host.interp.string_interner().resolve(symbol.as_symbol()).map(str::to_string) {
              host.trace_assigned_variable(prefix, &name, append_word.as_deref())?;
            }
          }
        }
      }
      host.poll_shell_signals(line, output.clone()).await?;

      if let Some(status) = assignment_status {
        // A successful binding does not erase the last substitution's status.
        if host.shell_status() == 0 { host.set_shell_status(status); }
      }
      let result = if let Some(name) = fallback {
        if let Some(value) = result {
          output.write_bytes(host, &super::shell_commands::plain_value(&name, &value));
        }
        None
      } else {
        result.and_then(|value| output.write(host, line, value, last))
      };
      if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
      if host.shell_status() != 0 && host.shell_errexit && !ignored {
        return Err(TshScriptErrorKind::BashStatus(host.shell_status()));
      }
      return Ok(result);
    }
    // A compound command's body runs as units of its own.
    drop(handoff);
    let LispValue::List(list) = value else {
      unreachable!()
    };
    let stages = &list.items[1..];
    let name = head.as_deref().unwrap();
    if name == "std.sh.array-traced" {
      let [LispValue::String(trace), form] = stages else {
        return Err(TshScriptErrorKind::Lisp(LispHostError::Command("std.sh.array-traced: expected TRACE FORM".into())));
      };
      if !host.shell_compound.commands.xtrace {
        return eval_flow(host, form, line, ignored, output, last).await;
      }
      let (form, status) = host.trace_array_statement(trace, form, line).await?;
      let result = eval_flow(host, &form, line, ignored, output, last).await?;
      if let Some(status) = status.filter(|_| host.shell_status() == 0) { host.set_shell_status(status); }
      return Ok(result);
    }
    if name == "std.sh.display" {
      // The prompt's display marker is a no-op: it runs its body as written.
      let [body] = stages else {
        return Err(TshScriptErrorKind::Lisp(LispHostError::Command("std.sh.display: expected one command".into())));
      };
      return eval_flow(host, body, line, ignored, output, last).await;
    }
    if name == "std.sh.condition" {
      if stages.len() != 1 { return Err(TshScriptErrorKind::Lisp(LispHostError::Command("[[: expected one condition".into()))); }
      let result = eval_flow(host, &stages[0], line, true, output.clone().plain(), last).await?;
      if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
      if host.shell_status() != 0 && host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(host.shell_status())); }
      return Ok(result);
    }
    if name == "std.sh.test" {
      let result = host.condition_command(stages, line, true, output.clone()).await?;
      if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
      if host.shell_status() != 0 && host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(host.shell_status())); }
      return Ok(result);
    }
    if name == "std.sh.background" {
      if stages.len() != 1 { return Err(TshScriptErrorKind::Lisp(LispHostError::Command("background: expected one job".into()))); }
      return host.start_shell_job(&stages[0], line, output).await;
    }
    if name == "std.sh.time" {
      return host.time_pipeline(stages, line, ignored, output, last).await;
    }
    if name == "std.sh.select" {
      return host.select_loop(stages, line, ignored, output).await;
    }
    if matches!(name, "std.sh.if" | "std.sh.while" | "std.sh.for" | "std.sh.case" | "std.sh.group" | "std.sh.function" | "std.sh.subshell" | "std.sh.arithmetic" | "std.sh.arithmetic-for") {
      return super::bash_compound::evaluate(host, name, stages, line, ignored, output, last).await;
    }
    let valid = match name {
      "std.sh.not" => stages.len() == 1,
      "std.sh.and" | "std.sh.or" | "std.sh.redirect" => stages.len() == 2,
      "std.sh.seq" => true,
      _ => !stages.is_empty(),
    };
    if !valid {
      return Err(TshScriptErrorKind::Lisp(LispHostError::Runtime(format!(
        "{name}: invalid stage count"
      ))));
    }
    match name {
      "std.sh.array-assign" => host.assign_shell_array(stages, line).await,
      "std.sh.declare-initializer" => {
        let [declaration, LispValue::List(initializers)] = stages else {
          return Err(TshScriptErrorKind::Lisp(LispHostError::Command(
            "declare: invalid initializer".into(),
          )));
        };
        let mut existing_readonly = std::collections::HashSet::new();
        for initializer in initializers.items.iter().skip(1) {
          if let LispValue::List(pair) = initializer {
            if let Some(LispValue::String(name)) = pair.items.get(1) {
              if host
                .shell_compound
                .commands
                .attributes
                .borrow()
                .get(name.as_str())
                .is_some_and(|a| a.readonly)
              {
                existing_readonly.insert(name.clone());
              }
            }
          }
        }
        // `set -x` shows the expanded initializers before the declaration.
        let traced = if host.shell_compound.commands.xtrace {
          Some(host.trace_declaration_initializers(&initializers.items[1..], line).await?)
        } else { None };
        eval_flow(
          host,
          declaration,
          line,
          ignored,
          output.clone().plain(),
          false,
        )
        .await?;
        if host.shell_status() != 0 {
          return Ok(None);
        }
        let mut failed = false;
        for initializer in traced.as_deref().unwrap_or(&initializers.items[1..]) {
          let LispValue::List(pair) = initializer else {
            continue;
          };
          let [_, LispValue::String(name), value] = pair.items.as_slice() else {
            continue;
          };
          if existing_readonly.contains(name) {
            host.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly variable"));
            host.set_shell_status(1);
            if host.shell_errexit && !ignored { return Err(TshScriptErrorKind::BashStatus(1)); }
            failed = true;
            continue;
          }
          let readonly = host
            .shell_compound
            .commands
            .attributes
            .borrow()
            .get(name.as_str())
            .is_some_and(|a| a.readonly);
          if let Some(attr) = host
            .shell_compound
            .commands
            .attributes
            .borrow_mut()
            .get_mut(name.as_str())
          {
            attr.readonly = false;
          }
          let result = eval_flow(host, value, line, ignored, output.clone().plain(), false).await;
          if let Some(attr) = host
            .shell_compound
            .commands
            .attributes
            .borrow_mut()
            .get_mut(name.as_str())
          {
            attr.readonly = readonly;
          }
          result?;
        }
        if failed { host.set_shell_status(1); }
        Ok(None)
      }
      "std.sh.heredoc-warning" => {
        let delimiter = host.evaluate_shell_data(&stages[0])
          .map_err(TshScriptErrorKind::Lisp)?;
        let delimiter = delimiter.as_str().ok_or_else(|| TshScriptErrorKind::Lisp(
          LispHostError::Command("here-document: expected delimiter".into())))?;
        host.report_shell_diagnostic(format!(
          "tsh: line {line}: warning: here-document at line {line} delimited by end-of-file (wanted `{delimiter}')"));
        Ok(None)
      }
      "std.sh.assign" => {
        let mut status = 0;
        for stage in stages {
          let substitution = has_substitution(host, stage);
          eval_flow(host, stage, line, true, output.clone().plain(), false).await?;
          if substitution || host.shell_status() != 0 { status = host.shell_status(); }
        }
        host.set_shell_status(status);
        if status != 0 && host.shell_errexit && !ignored {
          Err(TshScriptErrorKind::BashStatus(status))
        } else {
          Ok(None)
        }
      }
      "std.sh.seq" => {
        if stages.is_empty() { host.set_shell_status(0); }
        let mut value = None;
        for (index, stage) in stages.iter().enumerate() {
          value = eval_flow(
            host,
            stage,
            line,
            ignored,
            if index + 1 == stages.len() {
              output.clone()
            } else {
              output.clone().plain()
            },
            last && index + 1 == stages.len(),
          )
          .await?;
        }
        Ok(value)
      }
      "std.sh.and" | "std.sh.or" => {
        let left = eval_flow(host, &stages[0], line, true, output.clone().plain(), false).await?;
        if (host.shell_status() == 0) == (name == "std.sh.and") {
          eval_flow(host, &stages[1], line, ignored, output, last).await
        } else {
          Ok(left)
        }
      }
      "std.sh.not" => {
        let value = eval_flow(host, &stages[0], line, true, output.plain(), last).await?;
        host.set_shell_status(i32::from(host.shell_status() == 0));
        Ok(value)
      }
      "std.sh.pipe" => run_pipeline(host, stages, line, ignored, output.plain(), last).await,
      _ => unreachable!(),
    }
  })
}

async fn run_external(
  host: &mut LispHost,
  argv: Vec<Vec<String>>,
  input: Option<Vec<u8>>,
  capture: bool,
  line: usize,
  io: Vec<Option<super::ShellIo>>,
) -> Result<ShellCapture, TshScriptErrorKind> {
  let result = host.run_shell_pipeline(argv, input, capture, io).await;
  if host.shell_suspended() {
    return Err(TshScriptErrorKind::BashStatus(host.shell_status()));
  }
  match result {
    Ok(mut captured) => {
      for (status, detail) in captured.start_errors.drain(..) {
        let error = crate::Error::ProcessStart { status, detail };
        if let Some(diagnostic) = super::runner::bash_command_diagnostic(line, &error) {
          host.report_shell_diagnostic(diagnostic);
        }
      }
      Ok(captured)
    }
    Err(error) if error.process_status().is_some() => {
      let status = error.process_status().unwrap();
      if let Some(diagnostic) = super::runner::bash_command_diagnostic(line, &error) {
        host.report_shell_diagnostic(diagnostic);
      }
      Ok(ShellCapture {
        stdout: Vec::new(),
        status,
        statuses: Vec::new(),
        start_errors: Vec::new(),
      })
    }
    Err(error) => Err(TshScriptErrorKind::Command(error)),
  }
}

struct StdinRestore {
  slot: Rc<RefCell<Option<Vec<u8>>>>,
  saved: Option<Vec<u8>>,
  io: Rc<RefCell<Option<super::ShellIo>>>,
  saved_io: Option<super::ShellIo>,
}

struct OutputRestore {
  slot: Rc<RefCell<FlowOutput>>,
  saved: FlowOutput,
}
impl Drop for OutputRestore {
  fn drop(&mut self) { *self.slot.borrow_mut() = self.saved.clone(); }
}

impl Drop for StdinRestore {
  fn drop(&mut self) {
    *self.slot.borrow_mut() = self.saved.take();
    *self.io.borrow_mut() = self.saved_io.take();
  }
}

async fn run_pipeline(
  host: &mut LispHost,
  stages: &[LispValue<Sym>],
  line: usize,
  ignored: bool,
  output: FlowOutput,
  last: bool,
) -> Result<Option<JsonValue>, TshScriptErrorKind> {
  let saved = host.shell_stdin_bytes();
  let inherited_io = host.shell_io.borrow().clone();
  let _restore = StdinRestore {
    slot: host.shell_stdin.clone(),
    saved: saved.clone(),
    io: host.shell_io.clone(),
    saved_io: inherited_io.clone(),
  };
  let mut input = saved;
  let mut index = 0;
  let mut failed_status = 0;
  let mut statuses = Vec::new();
  let mut statuses_known = true;
  let result = async {
    let mut value = None;
    while index < stages.len() {
      *host.shell_io.borrow_mut() = pipeline_stage_io(inherited_io.clone(), index, stages.len());
      // Dynamic command heads must expand inside pipeline_stage's isolated
      // shell, just like arguments and assignments in every other stage.
      let stage_value = stages[index].clone();
      if external_leaf(host, &stage_value).is_some() {
        // Consecutive external stages share OS pipes and run concurrently.
        let mut argv = Vec::new();
        let mut io = Vec::new();
        while index < stages.len() {
          *host.shell_io.borrow_mut() = pipeline_stage_io(inherited_io.clone(), index, stages.len());
          let Some((stage, specs)) = external_leaf(host, &stages[index]) else { break; };
          let (fields, descriptors) = prepare_external_pipeline_stage(host, stage, specs, line).await?;
          argv.push(fields);
          io.push(descriptors);
          index += 1;
        }
        let capture = index < stages.len() || output.capture.is_some();
        let count = argv.len();
        let captured = run_external(host, argv, input.take(), capture, line, io).await?;
        if captured.statuses.len() == count { statuses.extend_from_slice(&captured.statuses); }
        else if count == 1 { statuses.push(captured.status); }
        else { statuses_known = false; }
        let group_status = if host.shell_compound.commands.pipefail {
          if captured.statuses.is_empty() && captured.status == 0 && index > 1 {
            return Err(TshScriptErrorKind::Lisp(LispHostError::Command("pipefail: external host did not return stage statuses".into())));
          }
          captured.statuses.iter().rev().copied().find(|status| *status != 0).unwrap_or(captured.status)
        } else { captured.status };
        if group_status != 0 { failed_status = group_status; }
        host.set_shell_status(group_status);
        if index < stages.len() {
          input = Some(captured.stdout);
        } else if let Some(buffer) = &output.capture {
          buffer.borrow_mut().extend(captured.stdout);
        }
        value = None;
      } else {
        host.replace_shell_stdin(input.take());
        if index + 1 < stages.len() {
          let captured = super::bash_compound::capture_pipeline_stage(host, &stage_value, line).await?;
          input = Some(captured);
          value = None;
        } else if host.shell_compound.commands.lastpipe {
          // `shopt -s lastpipe` (job control is off): the last stage runs in
          // the current shell, so its assignments stay.
          value = eval_flow(host, &stage_value, line, true, output.clone(), last).await?;
        } else {
          value = super::bash_compound::pipeline_stage(host, &stage_value, line, output.clone(), last).await?;
        }
        statuses.push(host.shell_status());
        if host.shell_status() != 0 { failed_status = host.shell_status(); }
        index += 1;
      }
    }
    if host.shell_compound.commands.pipefail && failed_status != 0 { host.set_shell_status(failed_status); }
    host.set_pipeline_statuses(&statuses);
    host.shell_compound.pipeline_status_known.set(statuses_known);
    if host.shell_status() != 0 && !ignored { host.run_shell_trap("ERR", line, output.clone()).await?; }
    if host.shell_status() != 0 && host.shell_errexit && !ignored {
      Err(TshScriptErrorKind::BashStatus(host.shell_status()))
    } else {
      Ok(value)
    }
  }
  .await;
  result
}

async fn prepare_external_pipeline_stage(
  host: &mut LispHost,
  stage: &LispValue<Sym>,
  specs: Option<&LispValue<Sym>>,
  line: usize,
) -> Result<(Vec<String>, Option<super::ShellIo>), TshScriptErrorKind> {
  // Each external stage is its own unit: reserved before its redirections
  // when its preparation can fork, so an earlier stage's effects stand.
  let forks = specs.is_some_and(|specs| super::owned_io_fork::words_fork(host, specs))
    || super::owned_io_fork::words_fork(host, stage);
  let unit = match host.reserve_fork_unit(forks, "pipeline stage", line) {
    Ok(unit) => unit,
    Err(error) => {
      let io = host.shell_io.borrow().clone().unwrap_or_default();
      let failed = super::shell_redirect::failed_pipeline_stage(host, io, format!("tsh: line {line}: {error}"));
      return Ok((Vec::new(), Some(failed)));
    }
  };
  // External stages share real OS pipes, but their expansion environments
  // are independent children too. Restore on both success and failure.
  let saved_env = host.env.clone();
  let mut env = tento_lisp::Env::new();
  for (symbol, _) in host.interp.string_interner().iter() {
    if let Some(value) = saved_env.borrow().get(symbol) { env.define(symbol, value); }
  }
  host.env = Rc::new(RefCell::new(env));
  let map = tento_env::global_env_map().map(|map| map.fork())
    .unwrap_or_else(tento_env::EnvMap::from_process);
  let child_map = map.clone();
  let result = tento_env::with_env_map_async(map, async {
    let mut io = if let Some(specs) = specs {
      match super::shell_redirect::prepare(host, specs, line).await {
        Ok(io) => io,
        Err((io, error)) => {
          if host.shell_suspended() { return Err(TshScriptErrorKind::BashStatus(host.shell_status())); }
          return Ok((Vec::new(), Some(super::shell_redirect::failed_pipeline_stage(host, io, error))));
        }
      }
    } else { host.shell_io.borrow().clone().unwrap_or_default() };
    let stage = super::shell_redirect::resolve_target(host, stage, line).await
      .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error)))?;
    let fields = host.application_to_argv(&stage).map_err(TshScriptErrorKind::Command)?;
    host.trace_shell_command(&fields, line).await?;
    // Carry the child's exported values to launch, which happens after the
    // parent environment has been restored. Explicit prefixes still win.
    let prefixes = std::mem::take(&mut io.1);
    io.1 = child_map.snapshot();
    io.1.extend(prefixes);
    Ok((fields, Some(io)))
  }).await;
  host.env = saved_env;
  // Its words were this stage's last preparation.
  drop(unit);
  result
}

fn external_leaf<'a>(host: &mut LispHost, value: &'a LispValue<Sym>)
  -> Option<(&'a LispValue<Sym>, Option<&'a LispValue<Sym>>)> {
  if let Some((stage, specs)) = super::shell_redirect::redirected_stage(host, value) {
    host.shell_external_stage(stage).then_some((stage, Some(specs)))
  } else {
    host.shell_external_stage(value).then_some((value, None))
  }
}

fn pipeline_stage_io(inherited: Option<super::ShellIo>, index: usize, count: usize) -> Option<super::ShellIo> {
  inherited.map(|mut io| {
    if index > 0 { io.0.insert(0, super::FdTarget::Inherit(0)); }
    if index + 1 < count { io.0.insert(1, super::FdTarget::Inherit(1)); }
    io
  })
}

impl LispHost {
  /// How a reported expansion error ends the command (Q6 item 17), with the
  /// status. A parameter error (`set -u`, `${x:?}`) exits a non-interactive
  /// bash. An arithmetic one discards the current top-level command. The
  /// others (bad substitution, bad indirection, failglob, a bad subscript)
  /// discard it too, but end the shell under `set -e`, even where errexit
  /// is otherwise ignored, as bash 5.3 does.
  pub(super) fn expansion_failure_status_of_command(&mut self) -> (i32, super::ControlSignal) {
    let parameter = self.shell_compound.commands.expansion_failure_127.get();
    let arithmetic = self.shell_compound.commands.expansion_failure_arithmetic.replace(false);
    let status = self.expansion_failure_status();
    let signal = if parameter && !self.shell_prompt {
      super::ControlSignal::Exit(status)
    } else if arithmetic {
      super::ControlSignal::Discard(status)
    } else {
      self.assignment_error_signal(status)
    };
    (status, signal)
  }

  /// Report an error raised while a simple command's words expand: to the
  /// descriptors from before its own redirections, when it has any.
  pub(super) fn report_expansion_diagnostic(&mut self, io: Option<Option<super::ShellIo>>, diagnostic: String) {
    match io {
      Some(io) => {
        let current = self.shell_io.replace(io);
        self.report_shell_diagnostic(diagnostic);
        *self.shell_io.borrow_mut() = current;
      }
      None => self.report_shell_diagnostic(diagnostic),
    }
  }

  /// A failed expansion or variable assignment: bash discards the command,
  /// and under `set -e` (non-interactive) leaves the shell.
  pub(super) fn assignment_error_signal(&self, status: i32) -> super::ControlSignal {
    if self.shell_errexit && !self.shell_prompt {
      super::ControlSignal::Exit(status)
    } else {
      super::ControlSignal::Discard(status)
    }
  }

  /// bash's error prolog (`get_name_for_error`, Q6 item 12): a diagnostic
  /// written as `tsh: line N: …` names the sourced file inside `.`, else
  /// `$0` — the script path for a file, tsh's name for `-c` and stdin. An
  /// interactive shell says `tsh: …` without the line.
  pub(super) fn shape_shell_diagnostic(&self, diagnostic: String) -> String {
    let Some(rest) = diagnostic.strip_prefix("tsh: ") else { return diagnostic; };
    if self.shell_prompt {
      let unlined = rest.strip_prefix("line ").and_then(|tail| {
        let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
        (digits > 0).then(|| tail[digits..].strip_prefix(": ")).flatten()
      });
      return match unlined { Some(tail) => format!("tsh: {tail}"), None => diagnostic };
    }
    let sourced = (self.shell_compound.sources > 0)
      .then(|| self.script_path().map(|path| path.to_string_lossy().into_owned()))
      .flatten();
    let name = sourced.unwrap_or_else(|| self.shell_compound.zero.borrow().clone());
    if name.is_empty() || name == "tsh" { diagnostic } else { format!("{name}: {rest}") }
  }

  /// Embedders supply the same formatter used for normal statement output.
  pub fn set_shell_formatter(&mut self, formatter: ShellFormatter) {
    self.shell_formatter = Some(formatter);
  }

  fn render_shell_value(&self, value: &JsonValue) -> Option<String> {
    if self.command_json_output() { return Some(format!("{value}\n")); }
    if let Some(formatter) = &self.shell_formatter {
      formatter(value)
    } else {
      crate::run_loop::format_cli_value(value, None).map(|text| format!("{text}\n"))
    }
  }

  pub(super) fn shell_stdin_bytes(&self) -> Option<Vec<u8>> {
    self.shell_stdin.borrow().clone()
  }

  pub(super) fn replace_shell_stdin(&self, input: Option<Vec<u8>>) {
    *self.shell_stdin.borrow_mut() = input;
  }

  /// One capture boundary for pipelines and future command substitution.
  pub async fn capture_shell_source(
    &mut self,
    source: &str,
  ) -> Result<ShellCapture, TshScriptErrorKind> {
    let value = self
      .read_posix_line_value(source)
      .map_err(TshScriptErrorKind::Lisp)?;
    let captured = self.capture_shell_value(&value, 1, false).await;
    let mut captured = match captured {
      Ok(captured) => captured,
      Err(error) => {
        let output = FlowOutput::default();
        if !matches!(error, TshScriptErrorKind::Control(super::ControlSignal::ExecExit(_))) {
          self.run_shell_trap("EXIT", 1, output).await?;
        }
        return Err(error);
      }
    };
    let bytes = Rc::new(RefCell::new(Vec::new()));
    self.run_shell_trap("EXIT", 1, FlowOutput { capture: Some(bytes.clone()), ..Default::default() }).await?;
    captured.stdout.extend(std::mem::take(&mut *bytes.borrow_mut()));
    captured.status = self.shell_status();
    Ok(captured)
  }

  pub(super) async fn capture_shell_value(
    &mut self,
    value: &LispValue<Sym>,
    line: usize,
    ignored: bool,
  ) -> Result<ShellCapture, TshScriptErrorKind> {
    let bytes = Rc::new(RefCell::new(Vec::new()));
    eval_flow(
      self,
      value,
      line,
      ignored,
      FlowOutput {
        writer: None,
        shaped: false,
        capture: Some(bytes.clone()),
      },
      true,
    )
    .await?;
    let stdout = std::mem::take(&mut *bytes.borrow_mut());
    Ok(ShellCapture {
      stdout,
      status: self.shell_status(),
      statuses: Vec::new(),
      start_errors: Vec::new(),
    })
  }
}
