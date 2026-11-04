//! Remaining history builtins share the host's environment and file-effect door.
use super::*;

impl LispHost {
  pub(in crate::script) async fn source_shell_file(
    &mut self,
    name: &str,
    args: &[String],
    line: usize,
    ignored: bool,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    // bash: `-p PATH` searches PATH instead of $PATH, `--` ends options.
    let usage = format!("{name}: usage: {name} [-p path] filename [arguments]");
    let mut search = None;
    let mut args = args;
    while let Some(arg) = args.first().filter(|arg| arg.starts_with('-') && arg.len() > 1) {
      if arg == "--" {
        args = &args[1..];
        break;
      }
      if arg == "-p" && args.len() > 1 {
        search = Some(args[1].clone());
        args = &args[2..];
        continue;
      }
      self.report_shell_diagnostic(format!("tsh: line {line}: {name}: {arg}: invalid option\n{usage}"));
      self.set_shell_status(2);
      return Ok(None);
    }
    let Some(file) = args.first() else {
      self.report_shell_diagnostic(format!(
        "tsh: line {line}: {name}: filename argument required\n{usage}"
      ));
      self.set_shell_status(2);
      return Ok(None);
    };
    let path = if file.contains('/') {
      std::path::PathBuf::from(file)
    } else {
      search.or_else(|| tento_env::effective_var("PATH"))
        .unwrap_or_default()
        .split(':')
        .map(|dir| std::path::Path::new(if dir.is_empty() { "." } else { dir }).join(file))
        .find(|path| path.is_file())
        .unwrap_or_else(|| file.into())
    };
    let source = (|| -> std::result::Result<String, LispHostError> {
      let open = self
        .shell_compound
        .commands
        .open
        .as_ref()
        .ok_or_else(|| LispHostError::Command("source: file opener is not installed".into()))?;
      let mut file = open(
        &path.to_string_lossy(),
        super::super::ShellOpenOptions {
          read: true,
          write: false,
          append: false,
          exclusive: false,
          truncate: false,
        },
      )?;
      let mut source = String::new();
      file
        .read_to_string(&mut source)
        .map_err(|e| LispHostError::Command(e.to_string()))?;
      Ok(source)
    })();
    if path.is_dir() {
      self.report_shell_diagnostic(format!("tsh: line {line}: {name}: {file}: is a directory"));
      self.set_shell_status(1);
      return Ok(None);
    }
    let source = match source {
      Ok(source) => source,
      Err(error) => {
        // bash names the OS error without Rust's "(os error N)" suffix.
        let error = error.to_string();
        let error = error.split(" (os error").next().unwrap_or(&error).to_string();
        self.report_shell_diagnostic(format!("tsh: line {line}: {file}: {error}"));
        self.set_shell_status(1);
        return Ok(None);
      }
    };
    // A file of blanks and comments runs nothing and succeeds.
    if source.lines().all(|text| matches!(text.trim_start().chars().next(), None | Some('#'))) {
      self.set_shell_status(0);
      return Ok(None);
    }
    let saved_args = if args.len() > 1 {
      Some(self.shell_compound.positional.replace(args[1..].to_vec()))
    } else {
      None
    };
    let source_name = path.display().to_string();
    let saved_path = self.set_script_path(Some(path));
    self.shell_compound.sources += 1;
    self.push_call_frame("source".into(), source_name, line);
    let result = match self.read_posix_line_value(&source) {
      Ok(body) => eval_flow(self, &body, 1, ignored, output.clone().plain(), false).await,
      // A syntax error fails the `.` command (status 2), not the script.
      Err(error) => {
        self.report_shell_diagnostic(format!("tsh: line {line}: {file}: {error}"));
        self.set_shell_status(2);
        Ok(None)
      }
    };
    self.pop_call_frame();
    self.shell_compound.sources -= 1;
    self.set_script_path(saved_path);
    // The caller's parameters come back unless the file replaced them
    // with `set` (a `shift` only drops a prefix of the file's arguments).
    if let Some(saved) = saved_args {
      if args[1..].ends_with(&self.shell_compound.positional.borrow()) {
        self.shell_compound.positional.replace(saved);
      }
    }
    match result {
      // An expansion error abandons the sourced file, not the caller.
      Err(TshScriptErrorKind::Control(ControlSignal::Return(status) | ControlSignal::Discard(status))) => {
        self.set_shell_status(status);
        Ok(None)
      }
      Ok(value) => {
        output.flush_value(self, value);
        Ok(None)
      }
      result => result,
    }
  }

  pub(in crate::script) fn mapfile_command(
    &mut self,
    args: &[String],
    line: usize,
  ) -> Result<Option<JsonValue>> {
    // bash's full option set lives with `read` (bash_read.rs).
    self.mapfile_builtin(args, line)
  }
}

impl LispHost {
  pub(in crate::script) fn integer_shell_value(&mut self, source: &str) -> Result<String> {
    self
      .prepare_shell_arithmetic(source)
      .map_err(|e| TshScriptErrorKind::Lisp(LispHostError::Command(e)))?;
    let call = self.shell_literal_call(&["std.sh.arith".into(), source.into()], "std.sh.arith", false);
    self
      .evaluate_shell_data(&call)
      .map(|value| text(&value))
      .map_err(TshScriptErrorKind::Lisp)
  }

  pub(in crate::script) fn declare_shell_variables(
    &mut self,
    command: &str,
    args: &[String],
    line: usize,
  ) -> Result<Option<JsonValue>> {
    use super::super::bash_arrays::{self, VarAttributes};
    if command == "local" && self.shell_compound.calls == 0 {
      self.report_shell_diagnostic(format!(
        "tsh: line {line}: local: can only be used in a function"
      ));
      self.set_shell_status(1);
      return Ok(None);
    }
    let readonly = command == "readonly";
    let mut changes = if readonly { vec![('r', true)] } else { Vec::new() };
    let mut global = false;
    let mut print = false;
    let mut functions = None;
    let mut inherit = false;
    let mut index = 0;
    while let Some(arg) = args.get(index) {
      if arg == "--" {
        index += 1;
        break;
      }
      if !arg.starts_with(['-', '+']) || arg.len() == 1 {
        break;
      }
      let enabled = arg.starts_with('-');
      for flag in arg[1..].chars() {
        match flag {
          'g' => global = enabled,
          'p' => print = enabled,
          'f' | 'F' if enabled => functions = Some(flag == 'F' || functions == Some(true)),
          'a' | 'A' | 'i' | 'r' | 'x' | 'l' | 'u' | 'n' | 't' => changes.push((flag, enabled)),
          'I' => inherit = enabled,
          _ => {
            self.report_shell_diagnostic(format!(
              "tsh: line {line}: {command}: -{flag}: invalid option{}",
              declaration_usage(command)
            ));
            self.set_shell_status(2);
            return Ok(None);
          }
        }
      }
      index += 1;
    }
    // bash refuses -a with -A as an invalid -a, and a variable given both
    // -l and -u in one command gets neither.
    if changes.contains(&('a', true)) && changes.contains(&('A', true)) {
      self.report_shell_diagnostic(format!(
        "tsh: line {line}: {command}: -a: invalid option{}",
        declaration_usage(command)
      ));
      self.set_shell_status(2);
      return Ok(None);
    }
    if changes.contains(&('l', true)) && changes.contains(&('u', true)) {
      changes.retain(|change| !matches!(change, ('l' | 'u', true)));
    }
    if let Some(names_only) = functions {
      return self.declare_functions(command, names_only, print, &changes, &args[index..], line);
    }
    let mut operands = args[index..].to_vec();
    // Like bash, readonly -p prints only when no names were supplied.
    if readonly { print = operands.is_empty(); }
    // `declare`, `declare -p` and `declare -x` with no names list the
    // shell's variables (filtered by the attribute flags given).
    if operands.is_empty() && !readonly && command != "export" && command != "local" && (print || changes.iter().all(|(_, on)| *on)) {
      return self.list_shell_variables(command, print || !changes.is_empty(), &changes);
    }
    if operands.is_empty() && print {
      operands = self
        .shell_compound
        .commands
        .attributes
        .borrow()
        .iter()
        .filter(|(_, attr)| !readonly || attr.readonly)
        .map(|(name, _)| name.clone())
        .collect();
      operands.sort();
    }
    let local = !readonly && command != "export" && !global && self.shell_compound.calls > 0;
    let mut status = 0;
    for operand in operands {
      if operand == "-" && command == "local" {
        self.save_local_options();
        continue;
      }
      let (key, rhs) = operand
        .split_once('=')
        .map_or((operand.as_str(), None), |(name, value)| {
          (name, Some(value))
        });
      let append = rhs.is_some() && key.ends_with('+');
      let key = if append { &key[..key.len() - 1] } else { key };
      // An attribute change on a nameref applies to the variable it names.
      let target;
      let key = if !print && !changes.iter().any(|(flag, _)| *flag == 'n')
        && self.shell_compound.commands.attributes.borrow().get(key).is_some_and(|a| a.nameref)
      {
        self.refresh_shell_symbols();
        target = super::super::bash_attributes::nameref_target(
          &self.shell_compound.commands.attributes,
          &self.shell_symbols,
          &self.env,
          key,
        );
        target.as_str()
      } else {
        key
      };
      if key == "OPTIND" && rhs.is_some() { self.shell_compound.commands.getopts_offset = 0; }
      if !shell_identifier(key) {
        self.report_shell_diagnostic(format!(
          "tsh: line {line}: {command}: `{operand}': not a valid identifier"
        ));
        status = 1;
        continue;
      }
      let symbol = self.interp.string_interner().get_or_intern(key);
      self.refresh_shell_symbols();
      let previous = self
        .shell_compound
        .commands
        .attributes
        .borrow()
        .get(key)
        .copied();
      if print {
        // A variable only in the environment prints as exported.
        let from_environment = tento_env::effective_var(key);
        let mut previous = previous;
        let bound = self.env.borrow().get(symbol).or_else(|| {
          let value = from_environment.clone()?;
          previous.get_or_insert_with(VarAttributes::default).exported = true;
          Some(LispValue::String(value.into()))
        });
        if previous.is_none() && bound.is_none() {
          self.report_shell_diagnostic(format!("tsh: line {line}: {command}: {key}: not found"));
          status = 1;
          continue;
        }
        let mut attr = previous.unwrap_or_default();
        if let Some(value) = &bound {
          attr.associative = bash_arrays::associative_entries(value).is_some();
          attr.indexed = bash_arrays::entries(value).is_some();
        }
        let mut flags = String::new();
        if attr.associative {
          flags.push('A');
        } else if attr.indexed {
          flags.push('a');
        }
        if attr.integer {
          flags.push('i');
        }
        if attr.nameref {
          flags.push('n');
        }
        if attr.readonly {
          flags.push('r');
        }
        if attr.trace {
          flags.push('t');
        }
        if attr.exported {
          flags.push('x');
        }
        if attr.lower {
          flags.push('l');
        }
        if attr.upper {
          flags.push('u');
        }
        if flags.is_empty() {
          flags.push('-');
        }
        let rendered = match bound {
          Some(value) if bash_arrays::entries(&value).is_some() => {
            let entries = bash_arrays::entries(&value).unwrap();
            if entries.is_empty() {
              "=()".into()
            } else {
              format!(
                "=({})",
                entries
                  .into_iter()
                  .map(|(key, value)| format!("[{key}]={}", declaration_quote(&value)))
                  .collect::<Vec<_>>()
                  .join(" ")
              )
            }
          }
          Some(value) if bash_arrays::associative_entries(&value).is_some() => {
            let entries = bash_arrays::associative_entries(&value).unwrap();
            if entries.is_empty() {
              "=()".into()
            } else {
              format!(
                "=({} )",
                entries
                  .into_iter()
                  .map(|(key, value)| format!(
                    "[{}]={}",
                    super::super::shell_printf::quote(&key),
                    declaration_quote(&value)
                  ))
                  .collect::<Vec<_>>()
                  .join(" ")
              )
            }
          }
          Some(LispValue::String(value)) => format!("={}", declaration_quote(&value)),
          _ => String::new(),
        };
        let output = self.shell_output.borrow().clone();
        output.write_bytes(
          self,
          format!("declare -{flags} {key}{rendered}\n").as_bytes(),
        );
        continue;
      }
      let already_local = self
        .shell_compound
        .locals
        .last()
        .is_some_and(|frame| frame.contains_key(key));
      if local && !already_local {
        let exported = tento_env::global_env_map().and_then(|map| map.get(key));
        if let Some(frame) = self.shell_compound.locals.last_mut() {
          frame.insert(key.into(), exported);
        }
        if let Some(frame) = self.shell_compound.local_attributes.last_mut() {
          frame.insert(key.into(), previous);
        }
      }
      // A new local hides the caller's variable; `-I` copies its value and
      // attributes, and a readonly one cannot be shadowed.
      if local && !already_local && previous.is_some_and(|a| a.readonly) {
        self.report_shell_diagnostic(format!("tsh: line {line}: {command}: {key}: readonly variable"));
        status = 1;
        continue;
      }
      let inherited = (local && !already_local && inherit).then(|| self.env.borrow().get(symbol)).flatten();
      let mut attr = if local && !already_local && !inherit {
        VarAttributes::default()
      } else {
        previous.unwrap_or_default()
      };
      let bound = if local && !already_local { inherited.clone() } else { self.env.borrow().get(symbol) };
      if let Some(value) = &bound {
        attr.indexed |= bash_arrays::entries(value).is_some();
        attr.associative |= bash_arrays::associative_entries(value).is_some();
      }
      if tento_env::global_env_map().is_some_and(|map| map.get(key).is_some()) {
        attr.exported = true;
      }
      if let Some(refusal) = attribute_refusal(&attr, &changes) {
        self.report_shell_diagnostic(format!("tsh: line {line}: {command}: {key}: {refusal}"));
        status = 1;
        continue;
      }
      for (flag, enabled) in &changes {
        match flag {
          'a' if *enabled => {
            attr.indexed = true;
            attr.associative = false;
          }
          'A' if *enabled => {
            attr.associative = true;
            attr.indexed = false;
          }
          'i' => attr.integer = *enabled,
          'r' if *enabled => attr.readonly = true,
          'x' => attr.exported = *enabled,
          // bash keeps one case attribute: the later flag wins.
          'l' => {
            attr.lower = *enabled;
            attr.upper &= !*enabled;
          }
          'u' => {
            attr.upper = *enabled;
            attr.lower &= !*enabled;
          }
          // A value that cannot name a variable keeps its plain meaning.
          'n' if *enabled => {
            attr.nameref = match (&rhs, &bound) {
              (Some(target), _) => !target.is_empty(),
              (None, Some(LispValue::String(target))) => shell_identifier(target),
              _ => true,
            }
          }
          'n' => attr.nameref = false,
          't' => attr.trace = *enabled,
          _ => {}
        }
      }
      if rhs.is_some() && previous.is_some_and(|a| a.readonly) && !(local && !already_local) {
        self.report_shell_diagnostic(format!("tsh: line {line}: {key}: readonly variable"));
        status = 1;
        continue;
      }
      let current = bound.clone().map(bash_arrays::scalar);
      let current = match current { Some(LispValue::String(value)) => value, _ => String::new().into() };
      let rhs = if attr.integer {
        rhs.map(|rhs| {
          let expression = if append { format!("({})+({})", if current.is_empty() { "0" } else { &current }, if rhs.is_empty() { "0" } else { rhs }) } else { rhs.to_string() };
          self.integer_shell_value(&expression)
        }).transpose()?
      } else if append {
        rhs.map(|rhs| format!("{current}{rhs}"))
      } else {
        rhs.map(str::to_string)
      };
      let rhs = rhs.map(|text| super::super::bash_attributes::case_converted(&attr, text));
      // A scalar converted to an array becomes its element 0; `declare -a`
      // alone leaves a new global array declared but unset, as bash does.
      let scalar = match &bound {
        Some(LispValue::String(text)) => Some(text.to_string()),
        _ => None,
      };
      let unset_array = rhs.is_none() && bound.is_none() && !local;
      let value = if attr.associative && unset_array {
        None
      } else if attr.associative {
        let mut entries = bound
          .as_ref()
          .and_then(bash_arrays::associative_entries)
          .unwrap_or_default();
        if let Some(value) = rhs.or(scalar) {
          entries.insert("0".into(), value);
        }
        Some(bash_arrays::associative_value(entries))
      } else if attr.indexed && unset_array {
        None
      } else if attr.indexed {
        let mut entries = bound
          .as_ref()
          .and_then(bash_arrays::entries)
          .unwrap_or_default();
        if let Some(value) = rhs.or(scalar) {
          entries.insert(0, value);
        }
        Some(bash_arrays::value(entries))
      } else if let Some(value) = rhs {
        Some(LispValue::String(value.into()))
      } else if let Some(value) = inherited {
        Some(value)
      } else if local && !already_local {
        Some(LispValue::Function(tento_lisp::Function::NativeClosure(
          self
            .shell_compound
            .commands
            .unset_value
            .as_ref()
            .expect("shell expansion natives are installed")
            .clone(),
        )))
      } else {
        None
      };
      if let Some(value) = value {
        if global {
          Env::root_of(&self.env).borrow_mut().define(symbol, value);
        } else if local {
          self.env.borrow_mut().define(symbol, value);
        } else if self.env.borrow_mut().set(symbol, value.clone()).is_err() {
          Env::root_of(&self.env).borrow_mut().define(symbol, value);
        }
      }
      self
        .shell_compound
        .commands
        .attributes
        .borrow_mut()
        .insert(key.into(), attr);
      if let Some(map) = tento_env::global_env_map() {
        // bash never puts an array in the environment.
        if attr.exported && !(attr.indexed || attr.associative) {
          let value = self.env.borrow().get(symbol).map(bash_arrays::scalar);
          if let Some(LispValue::String(value)) = value {
            map.set(key, value);
          }
        } else if changes
          .iter()
          .any(|(flag, enabled)| *flag == 'x' && !enabled)
          || local && !already_local
        {
          map.remove(key);
        }
      }
    }
    self.set_shell_status(status);
    Ok(None)
  }
}

/// The usage line bash prints after an invalid option.
fn declaration_usage(command: &str) -> String {
  let usage = match command {
    "declare" => "[-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]",
    "typeset" => "[-aAfFgiIlnrtux] name[=value] ... or typeset -p [-aAfFilnrtux] [name ...]",
    "local" => "[option] name[=value] ...",
    "readonly" => "[-aAf] [name[=value] ...] or readonly -p",
    _ => return String::new(),
  };
  format!("\n{command}: usage: {command} {usage}")
}

/// Attribute changes bash refuses on an existing variable.
fn attribute_refusal(
  attr: &super::super::bash_arrays::VarAttributes,
  changes: &[(char, bool)],
) -> Option<&'static str> {
  if (attr.indexed || attr.associative) && changes.iter().any(|c| matches!(c, ('a' | 'A', false))) {
    return Some("cannot destroy array variables in this way");
  }
  if attr.readonly && changes.contains(&('r', false)) {
    return Some("readonly variable");
  }
  if attr.indexed && changes.contains(&('A', true)) {
    return Some("cannot convert indexed to associative array");
  }
  None
}

pub(in crate::script) fn declaration_quote(value: &str) -> String {
  if value.chars().any(|c| c.is_control()) {
    return super::super::shell_printf::quote(value);
  }
  format!(
    "\"{}\"",
    value
      .replace('\\', "\\\\")
      .replace('\"', "\\\"")
      .replace('$', "\\$")
      .replace('`', "\\`")
  )
}
