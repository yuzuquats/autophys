//! getopts keeps its cluster cursor in the shell, alongside OPTIND.
use super::*;

impl LispHost {
  pub(in crate::script) fn get_shell_options(
    &mut self,
    args: &[String],
    line: usize,
  ) -> Result<Option<JsonValue>> {
    let failure = |host: &mut Self, detail: &str| {
      host.report_shell_diagnostic(format!("tsh: line {line}: getopts: {detail}"));
      host.set_shell_status(2);
      Ok(None)
    };
    let [optstring, name, rest @ ..] = args else {
      // bash prints the usage line bare.
      self.report_shell_diagnostic("getopts: usage: getopts optstring name [arg ...]".into());
      self.set_shell_status(2);
      return Ok(None);
    };
    if !shell_identifier(name) {
      let _: Result<Option<JsonValue>> = failure(self, &format!("`{name}': not a valid identifier"));
      self.set_shell_status(1);
      return Ok(None);
    }
    let words = if rest.is_empty() {
      self.shell_compound.positional.borrow().clone()
    } else {
      rest.to_vec()
    };
    let symbol = self.interp.string_interner().get_or_intern("OPTIND");
    let bound = self
      .env
      .borrow()
      .get(symbol)
      .map(super::super::bash_arrays::scalar);
    let mut index = match bound {
      Some(LispValue::String(value)) => value.parse::<usize>().unwrap_or(1).max(1),
      _ => 1,
    };
    let mut offset = self.shell_compound.commands.getopts_offset;
    if index != self.shell_compound.commands.getopts_index {
      offset = 0;
    }
    let silent = optstring.starts_with(':');
    let options: Vec<_> = optstring.trim_start_matches(':').chars().collect();
    let mut option = "?".to_string();
    let mut argument = None;
    let mut status = 0;
    let word = words.get(index - 1);
    if word.is_none_or(|word| !word.starts_with('-') || word == "-" || word == "--") {
      index = index.min(words.len() + 1);
      if word.is_some_and(|word| word == "--") {
        index += 1;
      }
      offset = 0;
      status = 1;
    } else {
      let cluster: Vec<_> = word.unwrap().chars().skip(1).collect();
      let current = cluster.get(offset).copied().unwrap_or('?');
      offset += 1;
      let found = options.iter().position(|c| *c == current && current != ':');
      if let Some(found) = found {
        option = current.to_string();
        if options.get(found + 1) == Some(&':') {
          if offset < cluster.len() {
            argument = Some(cluster[offset..].iter().collect::<String>());
            index += 1;
          } else if let Some(next) = words.get(index) {
            argument = Some(next.clone());
            index += 2;
          } else {
            index += 1;
            option = if silent { ":".into() } else { "?".into() };
            if silent {
              argument = Some(current.to_string());
            } else {
              self.getopts_diagnostic(&format!("option requires an argument -- {current}"));
            }
          }
          offset = 0;
        }
      } else if silent {
        argument = Some(current.to_string());
      } else {
        self.getopts_diagnostic(&format!("illegal option -- {current}"));
      }
      if offset >= cluster.len() {
        index += 1;
        offset = 0;
      }
    }
    for variable in [name.as_str(), "OPTIND", "OPTARG"] {
      if self
        .shell_compound
        .commands
        .attributes
        .borrow()
        .get(variable)
        .is_some_and(|a| a.readonly)
      {
        self.report_shell_diagnostic(format!("tsh: line {line}: {variable}: readonly variable"));
        self.set_shell_status(2);
        return Ok(None);
      }
    }
    self.assign_shell_variable(name, option, false);
    self.assign_shell_variable("OPTIND", index.to_string(), false);
    let symbol = self.interp.string_interner().get_or_intern("OPTARG");
    if let Some(argument) = argument {
      self.assign_shell_variable("OPTARG", argument, false);
    } else {
      let unset = self
        .shell_compound
        .commands
        .unset_value
        .as_ref()
        .expect("shell expansion natives are installed")
        .clone();
      let unset = LispValue::Function(tento_lisp::Function::NativeClosure(unset));
      if self.env.borrow_mut().set(symbol, unset.clone()).is_err() {
        Env::root_of(&self.env).borrow_mut().define(symbol, unset);
      }
      if let Some(map) = tento_env::global_env_map() {
        map.remove("OPTARG");
      }
    }
    self.shell_compound.commands.getopts_index = index;
    self.shell_compound.commands.getopts_offset = offset;
    self.set_shell_status(status);
    Ok(None)
  }

  fn getopts_diagnostic(&mut self, detail: &str) {
    let symbol = self.interp.string_interner().get_or_intern("OPTERR");
    if matches!(self.env.borrow().get(symbol), Some(LispValue::String(value)) if value == "0") {
      return;
    }
    let zero = self.shell_compound.zero.borrow().clone();
    self.report_shell_diagnostic(format!("{zero}: {detail}"));
  }
}
