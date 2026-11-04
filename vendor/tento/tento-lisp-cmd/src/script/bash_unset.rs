//! The `unset` builtin with bash's rules: `-f`/`-v`/`-n`, array elements,
//! readonly refusal, namerefs, and locals that stay local once unset. It
//! works on the current scope (`host.env`), so a subshell or command
//! substitution never unsets the parent's variable.
use serde_json::Value as JsonValue;
use tento_lisp::{Function, Value as LispValue};

use super::bash_arrays;
use super::interp::LispHost;
use super::runner::TshScriptErrorKind;

type Result<T> = std::result::Result<T, TshScriptErrorKind>;

#[derive(Clone, Copy, PartialEq)]
enum Target {
  Either,
  Variable,
  Function,
}

impl LispHost {
  pub(super) fn unset_shell_names(&mut self, operands: &[String], line: usize) -> Result<Option<JsonValue>> {
    let mut functions = false;
    let mut variables = false;
    let mut nameref = false;
    let mut index = 0;
    while let Some(arg) = operands.get(index) {
      if arg == "--" {
        index += 1;
        break;
      }
      if !arg.starts_with('-') || arg.len() == 1 {
        break;
      }
      for flag in arg[1..].chars() {
        match flag {
          'f' => functions = true,
          'v' => variables = true,
          'n' => nameref = true,
          _ => {
            self.report_shell_diagnostic(format!(
              "tsh: line {line}: unset: -{flag}: invalid option\nunset: usage: unset [-f] [-v] [-n] [name ...]"
            ));
            self.set_shell_status(2);
            return Ok(None);
          }
        }
      }
      index += 1;
    }
    if functions && variables {
      self.report_shell_diagnostic(format!(
        "tsh: line {line}: unset: cannot simultaneously unset a function and a variable"
      ));
      self.set_shell_status(1);
      return Ok(None);
    }
    let target = if functions {
      Target::Function
    } else if variables {
      Target::Variable
    } else {
      Target::Either
    };
    let mut status = 0;
    for name in &operands[index..] {
      if target == Target::Function {
        if super::bash_type::readonly_function(name) {
          self.report_shell_diagnostic(format!("tsh: line {line}: unset: {name}: cannot unset: readonly function"));
          status = 1;
          continue;
        }
        if self.shell_compound.functions.remove(name).is_some() {
          self.unexport_function(name);
        }
        continue;
      }
      if let Some((array, subscript)) = name.strip_suffix(']').and_then(|n| n.split_once('[')) {
        if identifier(array) {
          status |= self.unset_array_element(array, subscript, line)?;
        }
        continue;
      }
      // bash ignores names that are not identifiers, silently.
      if !identifier(name) {
        continue;
      }
      let resolved = if nameref {
        name.clone()
      } else {
        self.refresh_shell_symbols();
        super::bash_attributes::nameref_target(
          &self.shell_compound.commands.attributes,
          &self.shell_symbols,
          &self.env,
          name,
        )
      };
      if !self.shell_variable_exists(&resolved) {
        if target == Target::Either && self.shell_compound.functions.contains_key(name) {
          if super::bash_type::readonly_function(name) {
            self.report_shell_diagnostic(format!("tsh: line {line}: unset: {name}: cannot unset: readonly function"));
            status = 1;
          } else {
            self.shell_compound.functions.remove(name);
            self.unexport_function(name);
          }
          continue;
        }
      }
      status |= self.unset_shell_variable(&resolved, line);
    }
    self.set_shell_status(status);
    Ok(None)
  }

  fn refuse_readonly_unset(&mut self, name: &str, line: usize) -> i32 {
    self.report_shell_diagnostic(format!("tsh: line {line}: unset: {name}: cannot unset: readonly variable"));
    1
  }

  pub(super) fn shell_variable_exists(&mut self, name: &str) -> bool {
    let symbol = self.interp.string_interner().get_or_intern(name);
    let bound = self.env.borrow().get(symbol);
    match bound {
      Some(LispValue::Function(Function::NativeClosure(marker))) => {
        !self.shell_compound.commands.unset_value.as_ref().is_some_and(|unset| std::rc::Rc::ptr_eq(unset, &marker))
      }
      Some(_) => true,
      None => tento_env::global_env_map().is_some_and(|map| map.get(name).is_some()),
    }
  }

  /// Unset one variable in the current scope. A local of the running
  /// function stays local and unset, as in bash: the global it shadows is
  /// not uncovered.
  fn unset_shell_variable(&mut self, name: &str, line: usize) -> i32 {
    if self.shell_readonly(name) {
      return self.refuse_readonly_unset(name, line);
    }
    if let Some(map) = tento_env::global_env_map() {
      map.remove(name);
    }
    super::bash_attributes::forget_dynamic_variable(name);
    let symbol = self.interp.string_interner().get_or_intern(name);
    self.refresh_shell_symbols();
    let local = self.shell_compound.calls > 0
      && self.shell_compound.locals.last().is_some_and(|frame| frame.contains_key(name));
    match (&self.shell_compound.commands.unset_value, local) {
      (Some(unset), true) => {
        let marker = LispValue::Function(Function::NativeClosure(unset.clone()));
        self.env.borrow_mut().define(symbol, marker);
      }
      _ => self.env.borrow_mut().undefine(symbol),
    }
    let mut attributes = self.shell_compound.commands.attributes.borrow_mut();
    if let Some(attr) = attributes.get_mut(name) {
      // The variable is gone; only `local` keeps a declared slot.
      if local {
        *attr = bash_arrays::VarAttributes::default();
      } else {
        attributes.remove(name);
      }
    }
    0
  }

  /// `unset 'a[i]'`: an indexed subscript is arithmetic (negative counts
  /// from the end), `@`/`*` empties the array, an associative key is
  /// literal, and `v[0]` on a scalar unsets it.
  fn unset_array_element(&mut self, name: &str, subscript: &str, line: usize) -> Result<i32> {
    if self.shell_readonly(name) {
      return Ok(self.refuse_readonly_unset(name, line));
    }
    let symbol = self.interp.string_interner().get_or_intern(name);
    let bound = self.env.borrow().get(symbol);
    let Some(bound) = bound else { return Ok(0) };
    if let Some(mut entries) = bash_arrays::associative_entries(&bound) {
      entries.remove(subscript);
      self.set_shell_binding(symbol, bash_arrays::associative_value(entries));
      return Ok(0);
    }
    let entries = bash_arrays::entries(&bound);
    if matches!(subscript, "@" | "*") {
      if entries.is_some() {
        self.set_shell_binding(symbol, bash_arrays::value(Default::default()));
        return Ok(0);
      }
      return Ok(self.unset_shell_variable(name, line));
    }
    let index = self.integer_shell_value(subscript)?;
    let index: i64 = index.trim().parse().unwrap_or(0);
    let Some(mut entries) = entries else {
      if index == 0 {
        return Ok(self.unset_shell_variable(name, line));
      }
      self.report_shell_diagnostic(format!("tsh: line {line}: unset: {name}: not an array variable"));
      return Ok(1);
    };
    let index = if index < 0 { entries.last_key_value().map_or(0, |(n, _)| n + 1) + index } else { index };
    if index < 0 {
      self.report_shell_diagnostic(format!("tsh: line {line}: unset: [{subscript}]: bad array subscript"));
      return Ok(1);
    }
    entries.remove(&index);
    self.set_shell_binding(symbol, bash_arrays::value(entries));
    Ok(0)
  }

  fn set_shell_binding(&mut self, symbol: super::interp::Sym, value: LispValue<super::interp::Sym>) {
    if self.env.borrow_mut().set(symbol, value.clone()).is_err() {
      self.env.borrow_mut().define(symbol, value);
    }
  }
}

fn identifier(name: &str) -> bool {
  !name.is_empty()
    && !name.as_bytes()[0].is_ascii_digit()
    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}
