//! The `export` builtin: `declare -x` (or `+x` for `-n`) on each operand,
//! and `export`/`export -p` list the environment in `declare -x` form.
//! `export -f` puts a function in the environment as bash 5 does
//! (bash_functions.rs).
use serde_json::Value as JsonValue;
use tento_lisp::Value as LispValue;

use super::interp::LispHost;
use super::runner::TshScriptErrorKind;

type Result<T> = std::result::Result<T, TshScriptErrorKind>;

const USAGE: &str = "export: usage: export [-fn] [name[=value] ...] or export -p [-f]";

impl LispHost {
  pub(super) fn export_shell_names(&mut self, operands: &[String], line: usize) -> Result<Option<JsonValue>> {
    let mut functions = false;
    let mut unexport = false;
    let mut print = false;
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
          'n' => unexport = true,
          'p' => print = true,
          _ => {
            self.report_shell_diagnostic(format!("tsh: line {line}: export: -{flag}: invalid option\n{USAGE}"));
            self.set_shell_status(2);
            return Ok(None);
          }
        }
      }
      index += 1;
    }
    let names = &operands[index..];
    if functions {
      if names.is_empty() {
        return self.declare_functions("export", false, true, &[('x', true)], &[], line);
      }
      let mut status = 0;
      for name in names {
        if !self.shell_compound.functions.contains_key(name) {
          self.report_shell_diagnostic(format!("tsh: line {line}: export: {name}: not a function"));
          status = 1;
        } else if unexport {
          self.unexport_function(name);
        } else if !self.export_function(name) {
          self.report_shell_diagnostic(format!("tsh: line {line}: export: {name}: function body source unavailable"));
          status = 1;
        }
      }
      self.set_shell_status(status);
      return Ok(None);
    }
    if names.is_empty() {
      return self.print_exported_variables();
    }
    // bash ignores -p when names are given.
    let _ = print;
    let mut args = vec![if unexport { "+x" } else { "-x" }.to_string(), "--".into()];
    args.extend(names.iter().cloned());
    self.declare_shell_variables("export", &args, line)
  }

  /// `export -p`: every exported variable, sorted, as bash prints it.
  fn print_exported_variables(&mut self) -> Result<Option<JsonValue>> {
    let mut names: Vec<String> = tento_env::global_env_map()
      .map(|map| map.snapshot().into_iter().map(|(name, _)| name).collect())
      .unwrap_or_default();
    names.extend(
      self
        .shell_compound
        .commands
        .attributes
        .borrow()
        .iter()
        .filter(|(_, attr)| attr.exported)
        .map(|(name, _)| name.clone()),
    );
    names.retain(|name| identifier(name));
    names.sort();
    names.dedup();
    let mut text = String::new();
    for name in names {
      let attr = self.shell_compound.commands.attributes.borrow().get(&name).copied();
      let symbol = self.interp.string_interner().get_or_intern(&name);
      let bound = self.env.borrow().get(symbol);
      let value = match bound {
        Some(LispValue::String(value)) => Some(value.into_string()),
        Some(_) => None,
        None => tento_env::effective_var(&name),
      };
      let mut flags = String::new();
      if let Some(attr) = attr {
        for (flag, on) in [('i', attr.integer), ('n', attr.nameref), ('r', attr.readonly)] {
          if on {
            flags.push(flag);
          }
        }
      }
      flags.push('x');
      if let Some(attr) = attr {
        for (flag, on) in [('l', attr.lower), ('u', attr.upper)] {
          if on {
            flags.push(flag);
          }
        }
      }
      text.push_str(&format!("declare -{flags} {name}"));
      if let Some(value) = value {
        text.push('=');
        text.push_str(&super::bash_compound::declaration_quote(&value));
      }
      text.push('\n');
    }
    let output = self.shell_output.borrow().clone();
    output.write_bytes(self, text.as_bytes());
    self.set_shell_status(0);
    Ok(None)
  }
}

impl LispHost {
  /// `declare`, `declare -p` and `declare -x`/`-a`/… with no names: every
  /// shell variable (bindings holding shell data, declared attributes and
  /// the environment), sorted. `declare -p` prints `declare` commands;
  /// bare `declare` prints `name=value` as `set` does.
  pub(super) fn list_shell_variables(
    &mut self,
    command: &str,
    declare_form: bool,
    filter: &[(char, bool)],
  ) -> Result<Option<JsonValue>> {
    self.refresh_shell_symbols();
    let mut names = std::collections::BTreeSet::new();
    for (name, symbol) in self.shell_symbols.borrow().iter() {
      if identifier(name)
        && matches!(self.env.borrow().get(*symbol), Some(LispValue::String(_) | LispValue::List(_)))
      {
        names.insert(name.clone());
      }
    }
    names.extend(self.shell_compound.commands.attributes.borrow().keys().cloned());
    if let Some(map) = tento_env::global_env_map() {
      names.extend(map.snapshot().into_iter().map(|(name, _)| name));
    }
    let mut text = String::new();
    for name in names.into_iter().filter(|name| identifier(name)) {
      let attr = self.shell_compound.commands.attributes.borrow().get(&name).copied().unwrap_or_default();
      let symbol = self.interp.string_interner().get_or_intern(&name);
      let bound = self.env.borrow().get(symbol);
      let environment = tento_env::effective_var(&name);
      let indexed = bound.as_ref().is_some_and(|v| super::bash_arrays::entries(v).is_some());
      let associative = bound.as_ref().is_some_and(|v| super::bash_arrays::associative_entries(v).is_some());
      let keep = filter.iter().all(|(flag, _)| match flag {
        'a' => indexed,
        'A' => associative,
        'i' => attr.integer,
        'r' => attr.readonly,
        'x' => attr.exported || environment.is_some(),
        'l' => attr.lower,
        'u' => attr.upper,
        'n' => attr.nameref,
        't' => attr.trace,
        _ => true,
      });
      if !keep {
        continue;
      }
      if declare_form {
        let output = self.shell_output.borrow().clone();
        output.write_bytes(self, text.as_bytes());
        text.clear();
        self.declare_shell_variables("declare", &["-p".to_string(), name.clone()], 0)?;
        continue;
      }
      match bound.or_else(|| environment.map(|value| LispValue::String(value.into()))) {
        Some(LispValue::String(value)) => text.push_str(&format!("{name}={}\n", set_quote(&value))),
        Some(value) if indexed => {
          let entries = super::bash_arrays::entries(&value).unwrap_or_default();
          let items: Vec<String> = entries
            .into_iter()
            .map(|(key, value)| format!("[{key}]={}", super::bash_compound::declaration_quote(&value)))
            .collect();
          text.push_str(&format!("{name}=({})\n", items.join(" ")));
        }
        Some(value) if associative => {
          let entries = super::bash_arrays::associative_entries(&value).unwrap_or_default();
          let items: Vec<String> = entries
            .into_iter()
            .map(|(key, value)| format!("[{}]={}", super::shell_printf::quote(&key), super::bash_compound::declaration_quote(&value)))
            .collect();
          text.push_str(&format!("{name}=({} )\n", items.join(" ")));
        }
        _ => {}
      }
    }
    let output = self.shell_output.borrow().clone();
    output.write_bytes(self, text.as_bytes());
    // bash also prints every function after the variables.
    if !declare_form && !self.shell_compound.functions.is_empty() {
      return self.declare_functions(command, false, false, &[], &[], 0);
    }
    self.set_shell_status(0);
    Ok(None)
  }
}

/// `set`/`declare` listing quotes: bare when safe, else single quotes, and
/// `$'…'` for control characters.
fn set_quote(value: &str) -> String {
  if value.chars().any(|c| c.is_control()) {
    return super::shell_printf::quote(value);
  }
  if !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || "_./:@%+=,-".contains(c)) {
    return value.to_string();
  }
  format!("'{}'", value.replace('\'', "'\\''"))
}

fn identifier(name: &str) -> bool {
  !name.is_empty()
    && !name.as_bytes()[0].is_ascii_digit()
    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}
