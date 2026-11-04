//! Bash's call-stack variables and the `caller` builtin (operator ruling
//! Q9 item 25, 2026-10-06): `FUNCNAME`, `BASH_SOURCE` and `BASH_LINENO` as
//! bash 5.3 maintains them for the main script, sourced files and function
//! calls. tsh never sets `BASH_VERSION`/`BASH_VERSINFO`: it must not pretend
//! to be bash.
//!
//! Frame `i` (innermost first) is the running function or sourced file;
//! `BASH_SOURCE[i]` is the file that defines it, and `BASH_LINENO[i]` the
//! line in `BASH_SOURCE[i+1]` that called it. A file script ends the stack
//! with `main` (line 0); `-c`, stdin and the prompt have no `main` frame.
use std::collections::BTreeMap;

use tento_lisp::Env;

use super::interp::LispHost;

/// One running function or sourced file.
#[derive(Clone, Debug)]
pub(super) struct CallFrame {
  /// The function name, or `source` for a sourced file.
  pub name: String,
  /// Where the function was defined, or the sourced file as named.
  pub source: String,
  /// The line of the call in the caller's file.
  pub line: usize,
}

/// Where a shell function was defined: the definition's line, which its
/// body's relative line markers count from, and its file.
#[derive(Clone, Debug)]
pub(super) struct FunctionOrigin {
  pub line: usize,
  pub source: String,
}

#[derive(Default)]
pub(super) struct CallStack {
  /// Running functions and sourced files, outermost first.
  pub frames: Vec<CallFrame>,
  /// The main script's name as invoked, when a file is running.
  pub main: Option<String>,
  pub origins: std::collections::HashMap<String, FunctionOrigin>,
}

impl LispHost {
  /// The file a command now running was read from, as bash names it in
  /// `BASH_SOURCE`: the innermost sourced file, else the main script, else
  /// `$0` (bash's `-c` and stdin functions report the shell's name).
  pub(super) fn current_shell_source(&self) -> String {
    let stack = &self.shell_compound.call_stack;
    stack.frames.iter().rev().find(|frame| frame.name == "source").map(|frame| frame.source.clone())
      .or_else(|| stack.main.clone())
      .unwrap_or_else(|| self.shell_compound.zero.borrow().clone())
  }

  /// Remember where `name` was defined.
  pub(super) fn record_function_origin(&mut self, name: &str, line: usize) {
    let source = self.current_shell_source();
    self.shell_compound.call_stack.origins.insert(name.to_string(), FunctionOrigin { line, source });
  }

  pub(super) fn function_origin(&self, name: &str) -> Option<FunctionOrigin> {
    self.shell_compound.call_stack.origins.get(name).cloned()
  }

  /// Start a bash run: a file's name heads `BASH_SOURCE` with
  /// `BASH_LINENO` 0; `-c`, stdin and prompt lines have no `main` frame.
  pub(super) fn begin_shell_main(&mut self, main: Option<String>) {
    self.shell_compound.call_stack.main = main;
    if self.shell_compound.call_stack.main.is_some() { self.publish_call_stack(); }
  }

  pub(super) fn push_call_frame(&mut self, name: String, source: String, line: usize) {
    self.shell_compound.call_stack.frames.push(CallFrame { name, source, line });
    self.publish_call_stack();
  }

  pub(super) fn pop_call_frame(&mut self) {
    self.shell_compound.call_stack.frames.pop();
    self.publish_call_stack();
  }

  /// The stack innermost first, with `main` when a file is running.
  fn call_frames(&self) -> Vec<CallFrame> {
    let stack = &self.shell_compound.call_stack;
    let mut frames: Vec<CallFrame> = stack.frames.iter().rev().cloned().collect();
    if let Some(main) = &stack.main {
      frames.push(CallFrame { name: "main".into(), source: main.clone(), line: 0 });
    }
    frames
  }

  /// Write the three arrays into the global scope. `FUNCNAME` exists only
  /// while a function or sourced file runs, as in bash.
  fn publish_call_stack(&mut self) {
    let frames = self.call_frames();
    let array = |values: Vec<String>| {
      super::bash_arrays::value(values.into_iter().enumerate().map(|(i, value)| (i as i64, value)).collect::<BTreeMap<_, _>>())
    };
    let root = Env::root_of(&self.env);
    let interner = self.interp.string_interner();
    let funcname = interner.get_or_intern("FUNCNAME");
    let source = interner.get_or_intern("BASH_SOURCE");
    let lineno = interner.get_or_intern("BASH_LINENO");
    self.refresh_shell_symbols();
    let mut root = root.borrow_mut();
    if self.shell_compound.call_stack.frames.is_empty() {
      root.undefine(funcname);
    } else {
      root.define(funcname, array(frames.iter().map(|frame| frame.name.clone()).collect()));
    }
    root.define(source, array(frames.iter().map(|frame| frame.source.clone()).collect()));
    root.define(lineno, array(frames.iter().map(|frame| frame.line.to_string()).collect()));
  }

  /// bash's `caller [EXPR]`: with no operand, the current call's line and
  /// file (`NULL` when there is no calling file); with frame N, `LINE
  /// FUNCTION FILE` of the call N frames up. Status 1 when there is no
  /// such frame, 2 for an operand that is not a number.
  pub(super) fn caller_builtin(&mut self, operands: &[String], line: usize) -> (String, i32) {
    let frames = self.call_frames();
    let operands = operands.strip_prefix(&["--".to_string()]).unwrap_or(operands);
    let Some(operand) = operands.first() else {
      let Some(frame) = frames.first() else { return (String::new(), 1) };
      let file = frames.get(1).map_or("NULL", |caller| caller.source.as_str());
      return (format!("{} {file}\n", frame.line), 0);
    };
    let Ok(depth) = operand.trim().parse::<usize>() else {
      let detail = if operand.starts_with('-') && operand.len() > 1 { "invalid option" } else { "invalid number" };
      self.report_shell_diagnostic(format!("tsh: line {line}: caller: {operand}: {detail}\ncaller: usage: caller [expr]"));
      return (String::new(), 2);
    };
    match (frames.get(depth), frames.get(depth + 1)) {
      (Some(frame), Some(caller)) => (format!("{} {} {}\n", frame.line, caller.name, caller.source), 0),
      _ => (String::new(), 1),
    }
  }
}
