//! Runtime for the core Bash reader, installed on every LispHost. Word
//! splitting and command-output trimming are iterative host operations.
use super::*;

impl LispHost {
  pub(crate) fn shell_case_matches(&self, pattern: &str, word: &str) -> bool {
    if self.shell_compound.commands.nocasematch {
      // `shopt -s nocasematch`: case and [[ ]] patterns ignore case.
      let (pattern, word) = (pattern.to_lowercase(), word.to_lowercase());
      return pattern_matches(&compile_component(pattern.as_bytes()), word.as_bytes(), false);
    }
    pattern_matches(&compile_component(pattern.as_bytes()), word.as_bytes(), false)
  }

  fn named_call(&mut self, value: &LispValue<Sym>, name: &str) -> bool {
    matches!(value, LispValue::List(list) if matches!(list.items.first(),
      Some(LispValue::Symbol(s)) if self.interp.string_interner().resolve(s.as_symbol()) == Some(name)))
  }

  pub(super) fn is_split_application(&mut self, value: &LispValue<Sym>) -> bool {
    if !self.named_call(value, "apply") {
      return false;
    }
    matches!(value, LispValue::List(list) if list.items.len() == 3
      && matches!(list.items[1], LispValue::Symbol(_)) && self.named_call(&list.items[2], "append"))
  }

  pub(crate) fn refresh_shell_symbols(&mut self) {
    let mut names = self.shell_symbols.borrow_mut();
    let known = names.len();
    for (symbol, name) in self.interp.string_interner().iter().skip(known) {
      names.insert(name.to_string(), symbol);
    }
  }

  pub(super) fn register_bash_expansion_natives(&mut self) {
    self.register_shell_option_natives();
    // A private identity marks a declared-but-unset local. Nil remains a
    // bound typed value, including the whole-word null escape hatch.
    let unset: NativeClosure<Sym> = Rc::new(|_, _| Ok(LispValue::Nil));
    self.shell_compound.commands.unset_value = Some(unset.clone());
    let nounset = self.shell_compound.commands.nounset.clone();
    let rematch = self.shell_compound.commands.rematch.clone();
    let names = self.shell_symbols.clone();
    let nameref_attributes = self.shell_compound.commands.attributes.clone();
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let status_127 = self.shell_compound.commands.expansion_failure_127.clone();
    let lookup: NativeClosure<Sym> = Rc::new(move |env, args| {
      if !(1..=2).contains(&args.len()) {
        return Err(RuntimeError::Other(
          "std.sh.var: expected NAME [DEFAULT]".into(),
        ));
      }
      let LispValue::String(name) = &args[0] else {
        return Err(RuntimeError::Other("std.sh.var: NAME must be a string".into()));
      };
      // A nameref (`declare -n`) reads the variable it names.
      let name = &crate::script::bash_attributes::nameref_target(&nameref_attributes, &names, &env, name);
      // `$_` is the shell's, never the `_` a parent left in the environment.
      if name == "_" {
        if let Some(last) = crate::script::bash_attributes::dynamic_variable("_") {
          return Ok(LispValue::String(last.into()));
        }
      }
      if name == "BASH_REMATCH" {
        return Ok(LispValue::String(rematch.borrow().first().cloned().unwrap_or_default().into()));
      }
      // Consult bindings without evaluating arbitrary code or mistaking a
      // bound empty value for an absent one. The symbol index tracks every
      // parse's newly interned names, including lambda-local bindings.
      if let Some(symbol) = names.borrow().get(name).copied() {
        if let Some(value) = env.borrow().get(symbol) {
          if matches!(&value, LispValue::Function(Function::NativeClosure(marker))
            if Rc::ptr_eq(marker, &unset)) {
            if nounset.get() && args.len() == 1 {
              return Err(parameter_fatal(&failure, &status_127, format!("{name}: unbound variable")));
            }
            return Ok(args.get(1).cloned().unwrap_or_else(|| LispValue::String(String::new().into())));
          }
          return Ok(crate::script::bash_arrays::scalar(value));
        }
      }
      let value = if tento_env::global_env_map().is_some() {
        tento_env::effective_var(name)
      } else {
        std::env::var(name).ok()
      };
      if let Some(value) = value {
        return Ok(LispValue::String(value.into()));
      }
      // $LINENO, $RANDOM, $SECONDS: computed on every read until unset.
      if let Some(value) = crate::script::bash_attributes::dynamic_variable(name) {
        return Ok(LispValue::String(value.into()));
      }
      if nounset.get() && args.len() == 1 {
        return Err(parameter_fatal(&failure, &status_127, format!("{name}: unbound variable")));
      }
      Ok(
        args
          .get(1)
          .cloned()
          .unwrap_or_else(|| LispValue::String(String::new().into())),
      )
    });
    let symbol = self.interp.string_interner().get_or_intern("std.sh.var");
    self.env.borrow_mut().define(
      symbol,
      LispValue::Function(Function::NativeClosure(lookup.clone())),
    );
    let tilde = tilde_native(lookup.clone(), self.shell_symbols.clone());
    let symbol = self.interp.string_interner().get_or_intern("std.sh.tilde");
    self.env.borrow_mut().define(symbol, LispValue::Function(Function::NativeClosure(tilde)));
    let positional = self.shell_compound.positional.clone();
    let zero = self.shell_compound.zero.clone();
    let positional_failure = self.shell_compound.commands.expansion_failure.clone();
    let positional_127 = self.shell_compound.commands.expansion_failure_127.clone();
    let pid = self.shell_compound.commands.last_pid.clone();
    let nounset = self.shell_compound.commands.nounset.clone();
    let flags = self.shell_compound.flags.clone();
    let positional_lookup = lookup.clone();
    let positional_native: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(name)] = args.as_slice() else {
        return Err(RuntimeError::Other("std.sh.positional: expected NAME".into()));
      };
      let args = positional.borrow();
      Ok(match name.as_str() {
        "@" => LispValue::List(tento_lisp::List { items: args.iter().cloned().map(|value| LispValue::String(value.into())).collect() }),
        "#" => LispValue::String(args.len().to_string().into()),
        "@word" => LispValue::String(args.join(" ").into()),
        "*" | "*fields" => {
          let ifs = positional_lookup(env, vec![LispValue::String("IFS".into()), LispValue::String(" ".into())])?;
          let ifs = scalar_text(ifs)?;
          if name == "*fields" && ifs.is_empty() {
            LispValue::List(tento_lisp::List { items: args.iter().cloned().map(|value| LispValue::String(value.into())).collect() })
          } else {
            let separator = ifs.chars().next().map(|c| c.to_string()).unwrap_or_default();
            LispValue::String(args.join(&separator).into())
          }
        }
        "0" => LispValue::String(zero.borrow().as_str().into()),
        "$" => LispValue::String(std::process::id().to_string().into()),
        "!" => {
          if pid.get() == 0 && nounset.get() { return Err(parameter_fatal(&positional_failure, &positional_127, "$!: unbound variable".into())); }
          LispValue::String(if pid.get() == 0 { String::new().into() } else { pid.get().to_string().into() })
        }
        "-" => LispValue::String(flags.borrow().as_str().into()),
        name => {
          let value = name.parse::<usize>().ok().and_then(|n| n.checked_sub(1)).and_then(|n| args.get(n)).cloned();
          if value.is_none() && nounset.get() { return Err(parameter_fatal(&positional_failure, &positional_127, format!("${name}: unbound variable"))); }
          LispValue::String(value.unwrap_or_default().into())
        }
      })
    });
    let symbol = self.interp.string_interner().get_or_intern("std.sh.positional");
    self.env.borrow_mut().define(symbol, LispValue::Function(Function::NativeClosure(positional_native)));
    self.register_bash_parameters(lookup.clone());
    self.register_bash_array_natives(lookup.clone());
    let noglob = self.shell_compound.noglob.clone();
    let disabled = noglob.clone();
    let toggle: NativeClosure<Sym> = Rc::new(move |_env, args| {
      let [LispValue::Boolean(value)] = args.as_slice() else {
        return Err(RuntimeError::Other("std.sh.noglob: expected BOOLEAN".into()));
      };
      disabled.set(*value);
      Ok(LispValue::Nil)
    });
    let symbol = self.interp.string_interner().get_or_intern("std.sh.noglob");
    self
      .env
      .borrow_mut()
      .define(symbol, LispValue::Function(Function::NativeClosure(toggle)));
    let options = self.shell_compound.commands.glob.clone();
    let glob_failure = self.shell_compound.commands.expansion_failure.clone();
    let split: NativeClosure<Sym> = Rc::new(move |env, mut args| {
      if args.len() != 1 {
        return Err(RuntimeError::Other("std.sh.split: expected PARTS".into()));
      }
      let LispValue::List(parts) = args.remove(0) else {
        return Err(RuntimeError::Other("std.sh.split: PARTS must be a list".into()));
      };
      // Use the same lookup as std.sh.var at the caller's scope, on every
      // expansion. An absent IFS and an explicitly empty IFS are different.
      let ifs = lookup(
        env.clone(),
        vec![
          LispValue::String("IFS".into()),
          LispValue::String(" \t\n".into()),
        ],
      )?;
      let ifs = scalar_text(ifs)?;
      let category = |category: &str| -> Result<String, RuntimeError> {
        for name in ["LC_ALL", category, "LANG"] {
          let value = lookup(env.clone(), vec![LispValue::String(name.into()), LispValue::String(String::new().into())])?;
          let locale = scalar_text(value)?;
          if !locale.is_empty() { return Ok(locale); }
        }
        Ok("C".into())
      };
      let locale = category("LC_COLLATE")?;
      let ctype = category("LC_CTYPE")?;
      let default_locale = category("LANG")?;
      let ignore = scalar_text(lookup(env.clone(), vec![LispValue::String("GLOBIGNORE".into()), LispValue::String(String::new().into())])?)?;
      expand_word_collated(parts.items.into_inner(), &ifs, !noglob.get(), options.get(), &locale, &ctype, &default_locale, &ignore)
        .map_err(|error| {
          // failglob: bash reports `no match: PATTERN` and runs nothing.
          if let RuntimeError::Fatal { detail } = &error { glob_failure.replace(Some(detail.clone())); }
          error
        })
    });
    let symbol = self.interp.string_interner().get_or_intern("std.sh.split");
    self
      .env
      .borrow_mut()
      .define(symbol, LispValue::Function(Function::NativeClosure(split.clone())));
    let redirect: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::List(parts), LispValue::String(source)] = args.as_slice() else {
        return Err(RuntimeError::Other(
          "std.sh.redirect-word: expected PARTS SOURCE".into(),
        ));
      };
      let fields = split(env, vec![LispValue::List(parts.clone())])?;
      let LispValue::List(mut fields) = fields else {
        unreachable!()
      };
      if fields.items.len() != 1 {
        return Err(RuntimeError::Command {
          detail: format!("{source}: ambiguous redirect"),
        });
      }
      Ok(fields.items.remove(0))
    });
    let symbol = self
      .interp
      .string_interner()
      .get_or_intern("std.sh.redirect-word");
    self.native_defs.push("std.sh.redirect-word".into());
    self.env.borrow_mut().define(
      symbol,
      LispValue::Function(Function::NativeClosure(redirect)),
    );
    let sub: NativeClosure<Sym> = Rc::new(|_env, mut args| {
      if args.len() != 1 {
        return Err(RuntimeError::Other("std.sh.sub: expected VALUE".into()));
      }
      Ok(match args.remove(0) {
        LispValue::String(text) => {
          let keep = text.trim_end_matches('\n').len();
          if keep == text.len() {
            LispValue::String(text)
          } else {
            // Truncate in place: a uniquely held output is not copied.
            let mut owned = text.into_string();
            owned.truncate(keep);
            LispValue::String(owned.into())
          }
        }
        // A quiet command has no output. Structured results and other
        // non-string values travel intact until a word requires a join.
        LispValue::Nil => LispValue::String(String::new().into()),
        value => value,
      })
    });
    // `$(< file)`: the file's text, as a command substitution would capture it.
    let read_file: NativeClosure<Sym> = Rc::new(|_env, args| {
      let [LispValue::String(path)] = args.as_slice() else {
        return Err(RuntimeError::Other("std.sh.read-file: expected PATH".into()));
      };
      let mut bytes = std::fs::read(path.as_str()).map_err(|error| {
        let message = error.to_string();
        let message = message.split(" (os error ").next().unwrap_or(&message);
        RuntimeError::Command { detail: format!("{path}: {message}") }
      })?;
      // A shell word cannot hold NUL; bash drops it.
      bytes.retain(|byte| *byte != 0);
      let mut text = String::from_utf8(bytes).map_err(|_| RuntimeError::Command {
        detail: "command substitution is not UTF-8".into(),
      })?;
      text.truncate(text.trim_end_matches('\n').len());
      Ok(LispValue::String(text.into()))
    });
    let read_file_symbol = self.interp.string_interner().get_or_intern("std.sh.read-file");
    self.env.borrow_mut().define(read_file_symbol, LispValue::Function(Function::NativeClosure(read_file)));
    let symbol = self.interp.string_interner().get_or_intern("std.sh.sub");
    self
      .env
      .borrow_mut()
      .define(symbol, LispValue::Function(Function::NativeClosure(sub)));
  }
}

/// `(std.sh.tilde PREFIX)`: a tilde prefix the reader lowered, resolved when its
/// word is expanded. `""` is `$HOME` as it stands (the passwd home only when
/// HOME is unset), `+`/`-` are `PWD`/`OLDPWD`, `N`/`+N`/`-N` index the
/// directory stack as `dirs` counts it, anything else is a login name. With
/// nothing to name — an unset variable, an index past the stack, an unknown
/// user — the prefix stays literal, as in bash. One variable read per word.
fn tilde_native(lookup: NativeClosure<Sym>, names: Rc<RefCell<HashMap<String, Sym>>>) -> NativeClosure<Sym> {
  Rc::new(move |env, args| {
    let [LispValue::String(prefix)] = args.as_slice() else {
      return Err(RuntimeError::Other("std.sh.tilde: expected PREFIX".into()));
    };
    // `std.sh.var NAME nil`: the shell's own lookup (bindings, then the session
    // environment), with an unset variable seen as nil, never a nounset error.
    let var = |name: &str| -> Result<Option<String>, RuntimeError> {
      match lookup(env.clone(), vec![LispValue::String(name.into()), LispValue::Nil])? {
        LispValue::Nil => Ok(None),
        value => scalar_text(value).map(Some),
      }
    };
    let resolved = match prefix.as_str() {
      "" => var("HOME")?.or_else(crate::script::bash_dirs::login_home),
      "+" => var("PWD")?,
      "-" => var("OLDPWD")?,
      _ => {
        let (from_bottom, digits) = match prefix.as_bytes()[0] {
          b'+' => (false, &prefix[1..]),
          b'-' => (true, &prefix[1..]),
          _ => (false, prefix.as_str()),
        };
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
          let stack = names.borrow().get("DIRSTACK").copied()
            .and_then(|symbol| env.borrow().get(symbol))
            .and_then(|value| crate::script::bash_arrays::entries(&value))
            .unwrap_or_default();
          let entries: Vec<_> = stack.into_values().collect();
          digits.parse::<usize>().ok()
            .and_then(|n| if from_bottom { entries.len().checked_sub(n + 1) } else { Some(n) })
            .and_then(|index| entries.get(index).cloned())
        } else {
          crate::script::bash_dirs::user_home(prefix)
        }
      }
    };
    Ok(LispValue::String(resolved.unwrap_or_else(|| format!("~{prefix}")).into()))
  })
}

fn scalar_text(value: LispValue<Sym>) -> Result<String, RuntimeError> {
  match value {
    LispValue::List(list) if fragments(&list.items).is_some() => {
      let mut result = String::new();
      for descriptor in fragments(&list.items).unwrap() {
        let LispValue::List(pair) = descriptor else { return Err(parameter_error("invalid word fragment")); };
        let value = pair.items.get(1).ok_or_else(|| parameter_error("invalid word fragment"))?;
        if let LispValue::List(values) = value {
          if fragments(&values.items).is_none() {
            let fields = values.items.iter().cloned().map(scalar_text).collect::<Result<Vec<_>, _>>()?;
            result.push_str(&fields.join(" "));
            continue;
          }
        }
        result.push_str(&scalar_text(value.clone())?);
      }
      Ok(result)
    }
    LispValue::String(text) => Ok(text.into_string()),
    LispValue::Integer(n) => Ok(n.to_string()),
    LispValue::Float(n) => Ok(n.to_string()),
    LispValue::Boolean(b) => Ok(b.to_string()),
    LispValue::Nil => Ok("nil".into()),
    value => Err(RuntimeError::TypeError {
      expected: "scalar (in std.sh.split word join)".into(),
      got: format!("{:?}", value.as_type()),
    }),
  }
}

const FRAGMENTS: &str = "std.sh.word-fragments/v1";

fn fragments(items: &[LispValue<Sym>]) -> Option<&[LispValue<Sym>]> {
  matches!(items.first(), Some(LispValue::String(tag)) if tag == FRAGMENTS).then(|| &items[1..])
}

fn parameter_error(detail: &str) -> RuntimeError { RuntimeError::Command { detail: detail.into() } }

fn unicode_shell_locale() -> bool {
  let locale = ["LC_ALL", "LC_CTYPE", "LANG"].into_iter().find_map(|name| {
    let value = if tento_env::global_env_map().is_some() { tento_env::effective_var(name) } else { std::env::var(name).ok() };
    value.filter(|value| !value.is_empty())
  }).unwrap_or_default().to_ascii_lowercase();
  locale.contains("utf-8") || locale.contains("utf8")
}

fn descriptor_parts(value: &LispValue<Sym>) -> Result<&[LispValue<Sym>], RuntimeError> {
  let LispValue::List(list) = value else { return Err(parameter_error("parameter word: expected parts")); };
  Ok(&list.items)
}

fn pattern_text(value: &LispValue<Sym>) -> Result<String, RuntimeError> {
  let mut pattern = String::new();
  for part in descriptor_parts(value)? {
    let LispValue::List(pair) = part else { return Err(parameter_error("parameter pattern: expected part")); };
    let text = scalar_text(pair.items.get(1).cloned().ok_or_else(|| parameter_error("parameter pattern: missing value"))?)?;
    let active = matches!(pair.items.get(2), Some(LispValue::Boolean(true)));
    for c in text.chars() { if !active { pattern.push('\\'); } pattern.push(c); }
  }
  Ok(pattern)
}

fn word_fragments(parts: &LispValue<Sym>) -> Result<LispValue<Sym>, RuntimeError> {
  let mut items = vec![LispValue::String(FRAGMENTS.into())];
  items.extend_from_slice(descriptor_parts(parts)?);
  Ok(LispValue::List(tento_lisp::List { items: items.into() }))
}

fn replacement_text(parts: &LispValue<Sym>, matched: &str) -> Result<String, RuntimeError> {
  let mut result = String::new();
  for part in descriptor_parts(parts)? {
    let LispValue::List(pair) = part else { return Err(parameter_error("parameter replacement: expected part")); };
    let text = scalar_text(pair.items.get(1).cloned().ok_or_else(|| parameter_error("parameter replacement: missing value"))?)?;
    let active = matches!(pair.items.get(2), Some(LispValue::Boolean(true)));
    for c in text.chars() { if active && c == '&' { result.push_str(matched); } else { result.push(c); } }
  }
  Ok(result)
}

impl LispHost {
  pub(super) fn prepare_arithmetic_literals(&mut self, value: &LispValue<Sym>) -> Result<(), LispHostError> {
    let head = self.application_head(value);
    if head.as_deref() == Some("quote") { return Ok(()); }
    if let LispValue::List(list) = value {
      if head.as_deref() == Some("std.sh.arith") {
        if let Some(LispValue::String(source)) = list.items.get(1) {
          self.prepare_shell_arithmetic(source).map_err(LispHostError::Command)?;
        }
      }
      for item in list.items.iter().skip(1) { self.prepare_arithmetic_literals(item)?; }
    }
    Ok(())
  }

  pub(crate) fn prepare_shell_arithmetic(&mut self, source: &str) -> Result<(), String> {
    let mut pending = vec![source.to_string()];
    let mut seen = HashSet::new();
    while let Some(source) = pending.pop() {
      for name in tento_lisp::bash_arith::variable_names(&source) {
        if !seen.insert(name.clone()) { continue; }
        if seen.len() > 16_384 { return Err("expression recursion level exceeded".into()); }
        let symbol = self.interp.string_interner().get_or_intern(&name);
        let bound = self.env.borrow().get(symbol);
        if let Some(LispValue::String(value)) = bound { pending.push(value.into_string()); }
        else if let Some(value) = tento_env::effective_var(&name) { pending.push(value); }
      }
    }
    self.refresh_shell_symbols();
    Ok(())
  }

  pub(crate) fn refresh_shell_flags(&mut self) {
    let mut flags = String::new();
    for (flag, enabled) in [('e', self.shell_errexit), ('f', self.shell_compound.noglob.get()),
      ('h', true),
      ('u', self.shell_compound.commands.nounset.get()), ('x', self.shell_compound.commands.xtrace),
      ('B', !self.shell_compound.commands.brace_disabled.get()), ('C', self.shell_compound.commands.noclobber)] {
      if enabled { flags.push(flag); }
    }
    flags.push_str(&self.shell_compound.invocation_flags);
    self.shell_compound.flags.replace(flags);
  }

  pub fn set_shell_invocation_flags(&mut self, command: bool, stdin: bool, interactive: bool) {
    self.shell_compound.invocation_flags = format!("{}{}{}", if command { "c" } else { "" }, if stdin { "s" } else { "" }, if interactive { "i" } else { "" });
    self.refresh_shell_flags();
  }

  fn register_bash_parameters(&mut self, lookup: NativeClosure<Sym>) {
    let positional = self.shell_compound.positional.clone();
    let zero = self.shell_compound.zero.clone();
    let pid = self.shell_compound.commands.last_pid.clone();
    let flags = self.shell_compound.flags.clone();
    let status = self.shell_status.clone();
    let variable = lookup.clone();
    let parameter: NativeClosure<Sym> = Rc::new(move |env, args| {
      let Some(LispValue::String(name)) = args.first() else { return Err(parameter_error("parameter: expected name")); };
      let positional = positional.borrow();
      Ok(match name.as_str() {
        "0" => LispValue::String(zero.borrow().as_str().into()),
        "@" | "*" => LispValue::String(positional.join(" ").into()),
        "#" => LispValue::String(positional.len().to_string().into()),
        "?" => LispValue::String(status.get().to_string().into()),
        "$" => LispValue::String(std::process::id().to_string().into()),
        "!" => if pid.get() == 0 { LispValue::Nil } else { LispValue::String(pid.get().to_string().into()) },
        "-" => LispValue::String(flags.borrow().as_str().into()),
        name if name.bytes().all(|c| c.is_ascii_digit()) => {
          name.parse::<usize>().ok().and_then(|n| n.checked_sub(1)).and_then(|n| positional.get(n)).cloned().map(|value| LispValue::String(value.into())).unwrap_or(LispValue::Nil)
        }
        _ => variable(env, vec![LispValue::String(name.clone()), LispValue::Nil])?,
      })
    });
    let indirect_lookup = parameter.clone();
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let indirect_names = self.shell_symbols.clone();
    let indirect: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(name)] = args.as_slice() else {
        return Err(parameter_error("std.sh.indirect: expected NAME"));
      };
      let target = indirect_lookup(env.clone(), vec![LispValue::String(name.clone())])?;
      // bash: an unset reference is an invalid indirection; a set but empty
      // one names the empty variable (`: invalid variable name`).
      if matches!(target, LispValue::Nil) {
        return Err(expansion_fatal(&failure, format!("{name}: invalid indirect expansion")));
      }
      let target = scalar_text(target)?;
      if target.is_empty() {
        return Err(expansion_fatal(&failure, ": invalid variable name".into()));
      }
      let identifier = |name: &str| name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
      // `r='a[1]'; ${!r}` names one array element.
      if let Some((array, index)) = target.strip_suffix(']').and_then(|target| target.split_once('[')).filter(|(array, _)| identifier(array)) {
        return Ok(LispValue::String(arithmetic_element(&env, &indirect_names, array, index, None).ok().flatten().unwrap_or_default().into()));
      }
      if !identifier(&target) && !target.bytes().all(|c| c.is_ascii_digit()) && !matches!(target.as_str(), "@" | "*" | "#" | "?" | "$" | "!" | "-") {
        return Err(expansion_fatal(&failure, format!("{target}: invalid variable name")));
      }
      let value = indirect_lookup(env, vec![LispValue::String(target.into())])?;
      Ok(if matches!(value, LispValue::Nil) {
        LispValue::String(String::new().into())
      } else {
        value
      })
    });
    let test_lookup = parameter.clone();
    let test: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(name), LispValue::Boolean(colon), LispValue::Boolean(plus)] = args.as_slice() else { return Err(parameter_error("std.sh.param-test: expected NAME COLON PLUS")); };
      let value = test_lookup(env, vec![LispValue::String(name.clone())])?;
      let exists = !matches!(value, LispValue::Nil) && (!*colon || !scalar_text(value)?.is_empty());
      Ok(LispValue::Boolean(if *plus { exists } else { !exists }))
    });
    let names = self.shell_symbols.clone();
    let attributes = self.shell_compound.commands.attributes.clone();
    let names_lookup = lookup.clone();
    let prefix_names: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(prefix), LispValue::String(selector)] = args.as_slice() else {
        return Err(parameter_error("std.sh.names: expected PREFIX SELECTOR"));
      };
      let mut values = std::collections::BTreeSet::new();
      for (name, symbol) in names.borrow().iter() {
        if !name.starts_with(prefix.as_str()) || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') { continue; }
        if let Some(value) = env.borrow().get(*symbol) {
          if !matches!(value, LispValue::Function(_)) || attributes.borrow().contains_key(name) {
            values.insert(name.clone());
          }
        } else if attributes.borrow().contains_key(name) { values.insert(name.clone()); }
      }
      let exported = if let Some(map) = tento_env::global_env_map() { map.snapshot() } else { std::env::vars().collect() };
      for (name, _) in exported {
        if name.starts_with(prefix.as_str()) && !name.is_empty() && !name.as_bytes()[0].is_ascii_digit()
          && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') { values.insert(name); }
      }
      crate::script::bash_arrays::array_fields(env, values.into_iter().collect(), selector, "", &names_lookup)
    });
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let status_127 = self.shell_compound.commands.expansion_failure_127.clone();
    let array_word: NativeClosure<Sym> = Rc::new(move |_, args| {
      let [LispValue::String(name), LispValue::String(selector), LispValue::String(op), parts] = args.as_slice() else {
        return Err(parameter_error("std.sh.array-word: expected NAME SELECTOR OP PARTS"));
      };
      if op == "=" || op == "?" {
        let detail = if op == "=" { "bad array subscript".to_string() } else {
          let text = scalar_text(word_fragments(parts)?)?;
          if text.is_empty() { "parameter null or not set".into() } else { text }
        };
        let selector = if selector == "*fields" { "*" } else { selector };
        let detail = format!("{name}[{selector}]: {detail}");
        failure.replace(Some(detail.clone()));
        status_127.set(op == "?");
        return Err(RuntimeError::Fatal { detail });
      }
      word_fragments(parts)
    });
    let names = self.shell_symbols.clone();
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let status_127 = self.shell_compound.commands.expansion_failure_127.clone();
    let attributes = self.shell_compound.commands.attributes.clone();
    let arithmetic_symbol = self.interp.string_interner().get_or_intern("std.sh.arith");
    let word: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(name), LispValue::String(op), parts] = args.as_slice() else { return Err(parameter_error("std.sh.param-word: expected NAME OP PARTS")); };
      let value = word_fragments(parts)?;
      if op == "?" || op == ":?" {
        let detail = scalar_text(value)?;
        let detail = format!(
          "{name}: {}",
          if !detail.is_empty() {
            &detail
          } else if op == "?" {
            "parameter not set"
          } else {
            "parameter null or not set"
          }
        );
        failure.replace(Some(detail.clone()));
        status_127.set(true);
        return Err(RuntimeError::Fatal { detail });
      }
      if op == "=" {
        let symbol = names.borrow().get(name.as_str()).copied().ok_or_else(|| parameter_error("parameter assignment requires a variable"))?;
        let attr = attributes.borrow().get(name.as_str()).copied().unwrap_or_default();
        if attr.readonly {
          let detail = format!("{name}: readonly variable");
          failure.replace(Some(detail.clone()));
          return Err(RuntimeError::Fatal { detail });
        }
        let mut text = scalar_text(value.clone())?;
        if attr.integer {
          let native = env.borrow().get(arithmetic_symbol);
          if let Some(LispValue::Function(Function::NativeClosure(native))) = native {
            text = scalar_text(native(env.clone(), vec![LispValue::String(text.into())])?)?;
          }
        }
        let assigned = LispValue::String(text.as_str().into());
        if env.borrow_mut().set(symbol, assigned.clone()).is_err() { tento_lisp::Env::root_of(&env).borrow_mut().define(symbol, assigned); }
        if let Some(map) = tento_env::global_env_map().filter(|map| map.get(name).is_some()) { map.set(name, text); }
      }
      Ok(value)
    });
    let arith_lookup = lookup.clone();
    let names = self.shell_symbols.clone();
    let attributes = self.shell_compound.commands.attributes.clone();
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let arithmetic_failure = self.shell_compound.commands.expansion_failure_arithmetic.clone();
    let arithmetic: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(source)] = args.as_slice() else { return Err(parameter_error("std.sh.arith: expected EXPRESSION")); };
      let result = tento_lisp::bash_arith::evaluate(source, &mut |name, assigned| {
        if let Some((array, index)) = name.strip_suffix(']').and_then(|name| name.split_once('[')) {
          if assigned.is_some() && attributes.borrow().get(array).is_some_and(|attr| attr.readonly) {
            let detail = format!("{array}: readonly variable");
            failure.replace(Some(detail.clone()));
            return Err(detail);
          }
          return arithmetic_element(&env, &names, array, index, assigned);
        }
        if let Some(value) = assigned {
          if attributes
            .borrow()
            .get(name)
            .is_some_and(|attr| attr.readonly)
          {
            let detail = format!("{name}: readonly variable");
            failure.replace(Some(detail.clone()));
            return Err(detail);
          }
          let symbol = names.borrow().get(name).copied().ok_or_else(|| format!("{name}: arithmetic variable is missing"))?;
          let text = value.to_string();
          let value = LispValue::String(text.as_str().into());
          if env.borrow_mut().set(symbol, value.clone()).is_err() { tento_lisp::Env::root_of(&env).borrow_mut().define(symbol, value); }
          if let Some(map) = tento_env::global_env_map().filter(|map| map.get(name).is_some()) { map.set(name, text); }
        }
        let value = arith_lookup(env.clone(), vec![LispValue::String(name.into())]).map_err(|e| e.to_string())?;
        scalar_text(value).map(Some).map_err(|e| e.to_string())
      }).map_err(|error| {
        // Reported by the command that expands it, as bash does; `let` and
        // `((…))` report it themselves.
        failure.replace(Some(error.clone()));
        arithmetic_failure.set(true);
        parameter_error(&error)
      })?;
      Ok(LispValue::String(result.to_string().into()))
    });
    let nounset = self.shell_compound.commands.nounset.clone();
    let transform_lookup = parameter.clone();
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let status_127 = self.shell_compound.commands.expansion_failure_127.clone();
    let attributes = self.shell_compound.commands.attributes.clone();
    let transform: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(name), LispValue::String(op), pattern, replacement] = args.as_slice() else { return Err(parameter_error("std.sh.param-transform: expected NAME OP PATTERN REPLACEMENT")); };
      let value = transform_lookup(env, vec![LispValue::String(name.clone())])?;
      if matches!(value, LispValue::Nil) && nounset.get() { return Err(parameter_fatal(&failure, &status_127, format!("{name}: unbound variable"))); }
      if let Some(op) = op.strip_prefix('@') {
        let display = scalar_text(replacement.clone())?;
        if !AT_OPERATORS.contains(&op) { return Err(parameter_fatal(&failure, &status_127, format!("{display}: bad substitution"))); }
        // An unset parameter transforms to nothing, quoted or not.
        if matches!(value, LispValue::Nil) { return Ok(LispValue::String(String::new().into())); }
        let value = scalar_text(crate::script::bash_arrays::scalar(value))?;
        let attr = attributes.borrow().get(name.as_str()).copied().unwrap_or_default();
        let flags = attribute_flags(&attr, name);
        return Ok(LispValue::String(match op {
          "a" => flags.into(),
          "A" if flags.is_empty() => format!("{name}={}", at_transform(&value, "Q")).into(),
          "A" => format!("declare -{flags} {name}={}", at_transform(&value, "Q")).into(),
          op => at_transform(&value, op).into(),
        }));
      }
      let value = if matches!(value, LispValue::Nil) { String::new() } else { scalar_text(value)? };
      let pattern = pattern_text(pattern)?;
      Ok(LispValue::String(parameter_transform(&value, op, &pattern, replacement)?.into()))
    });
    let each = self.parameter_each(parameter.clone(), lookup.clone());
    let nounset = self.shell_compound.commands.nounset.clone();
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let status_127 = self.shell_compound.commands.expansion_failure_127.clone();
    let substring_failure = self.shell_compound.commands.expansion_failure_arithmetic.clone();
    let slice: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(name), offset, length] = args.as_slice() else { return Err(parameter_error("std.sh.param-slice: expected NAME OFFSET LENGTH")); };
      let value = parameter(env, vec![LispValue::String(name.clone())])?;
      if matches!(value, LispValue::Nil) && nounset.get() { return Err(parameter_fatal(&failure, &status_127, format!("{name}: unbound variable"))); }
      let value = if matches!(value, LispValue::Nil) { String::new() } else { scalar_text(value)? };
      let boundaries: Vec<_> = if unicode_shell_locale() {
        value.char_indices().map(|(i, _)| i).chain(std::iter::once(value.len())).collect()
      } else { (0..=value.len()).collect() };
      let count = boundaries.len() as i64 - 1;
      let offset = scalar_text(offset.clone())?.parse::<i64>().map_err(|_| parameter_error("invalid substring offset"))?;
      let start = if offset < 0 { count + offset } else { offset };
      if start < 0 || start > count { return Ok(LispValue::String(String::new().into())); }
      let end = if matches!(length, LispValue::Nil) { count } else {
        let length = scalar_text(length.clone())?.parse::<i64>().map_err(|_| parameter_error("invalid substring length"))?;
        if length < 0 { count + length } else { start.saturating_add(length) }
      };
      if end < start {
        substring_failure.set(true);
        return Err(expansion_fatal(&failure, format!("{}: substring expression < 0", scalar_text(length.clone())?)));
      }
      let first = boundaries[start as usize];
      let last = boundaries[end.min(count) as usize];
      if !value.is_char_boundary(first) || !value.is_char_boundary(last) {
        return Err(parameter_error("substring is not UTF-8 — byte-valued variables are not supported yet"));
      }
      Ok(LispValue::String(value[first..last].into()))
    });
    let scalar: NativeClosure<Sym> = Rc::new(|_, args| {
      let [value] = args.as_slice() else { return Err(parameter_error("std.sh.scalar: expected VALUE")); };
      if matches!(value, LispValue::List(list) if fragments(&list.items).is_some()) { Ok(LispValue::String(scalar_text(value.clone())?.into())) } else { Ok(value.clone()) }
    });
    let array_scalar: NativeClosure<Sym> = Rc::new(|_, args| {
      let [value] = args.as_slice() else { return Err(parameter_error("std.sh.array-scalar: expected VALUE")); };
      if let LispValue::List(list) = value {
        if fragments(&list.items).is_none() {
          let values = list.items.iter().cloned().map(scalar_text).collect::<Result<Vec<_>, _>>()?;
          return Ok(LispValue::String(values.join(" ").into()));
        }
      }
      Ok(LispValue::String(scalar_text(value.clone())?.into()))
    });
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let bad_substitution: NativeClosure<Sym> = Rc::new(move |_, args| {
      let [LispValue::String(source)] = args.as_slice() else { return Err(parameter_error("std.sh.bad-substitution: expected SOURCE")); };
      Err(expansion_fatal(&failure, format!("{source}: bad substitution")))
    });
    for (name, native) in [
      ("std.sh.bad-substitution", bad_substitution),
      ("std.sh.indirect", indirect),
      ("std.sh.param-test", test),
      ("std.sh.names", prefix_names),
      ("std.sh.array-word", array_word),
      ("std.sh.param-word", word),
      ("std.sh.arith", arithmetic),
      ("std.sh.param-transform", transform),
      ("std.sh.param-each", each),
      ("std.sh.param-slice", slice),
      ("std.sh.scalar", scalar),
      ("std.sh.array-scalar", array_scalar),
    ] {
      let symbol = self.interp.string_interner().get_or_intern(name);
      self.env.borrow_mut().define(symbol, LispValue::Function(Function::NativeClosure(native)));
    }
    self.refresh_shell_flags();
  }
}

/// The `${x@OP}` operators bash 5.3 knows; any other is a `bad substitution`.
const AT_OPERATORS: [&str; 10] = ["Q", "E", "P", "A", "K", "a", "U", "u", "L", "k"];

/// `$((a[i]))` and `$((a[i]=v))`: one element of an indexed (or, by its
/// key text, associative) array, read or assigned by the arithmetic door.
fn arithmetic_element(
  env: &Rc<RefCell<tento_lisp::Env<Sym>>>,
  names: &Rc<RefCell<HashMap<String, Sym>>>,
  name: &str,
  index: &str,
  assigned: Option<i64>,
) -> Result<Option<String>, String> {
  use crate::script::bash_arrays::{associative_entries, associative_value, entries, value};
  let symbol = names.borrow().get(name).copied().ok_or_else(|| format!("{name}: arithmetic variable is missing"))?;
  let bound = env.borrow().get(symbol);
  if let Some(mut map) = bound.as_ref().and_then(associative_entries) {
    let Some(assigned) = assigned else { return Ok(map.get(index).cloned()) };
    map.insert(index.into(), assigned.to_string());
    let array = associative_value(map);
    if env.borrow_mut().set(symbol, array.clone()).is_err() { tento_lisp::Env::root_of(env).borrow_mut().define(symbol, array); }
    return Ok(Some(assigned.to_string()));
  }
  let mut map = match &bound {
    Some(LispValue::String(text)) => std::collections::BTreeMap::from([(0, text.to_string())]),
    Some(bound) => entries(bound).unwrap_or_default(),
    None => Default::default(),
  };
  let index: i64 = index.parse().map_err(|_| format!("{name}[{index}]: bad array subscript"))?;
  let index = if index < 0 { map.last_key_value().map_or(0, |(n, _)| n + 1) + index } else { index };
  if index < 0 { return Err(format!("{name}[{index}]: bad array subscript")); }
  let Some(assigned) = assigned else { return Ok(map.get(&index).cloned()) };
  map.insert(index, assigned.to_string());
  let array = value(map);
  if env.borrow_mut().set(symbol, array.clone()).is_err() { tento_lisp::Env::root_of(env).borrow_mut().define(symbol, array); }
  Ok(Some(assigned.to_string()))
}

/// A fatal expansion error the flow reports as bash does (`NAME: detail`)
/// before it ends the script.
fn expansion_fatal(failure: &Rc<RefCell<Option<String>>>, detail: String) -> RuntimeError {
  failure.replace(Some(detail.clone()));
  RuntimeError::Fatal { detail }
}

/// [`expansion_fatal`] for a parameter error, which ends `bash -c` with 127.
fn parameter_fatal(failure: &Rc<RefCell<Option<String>>>, status_127: &Rc<std::cell::Cell<bool>>, detail: String) -> RuntimeError {
  status_127.set(true);
  expansion_fatal(failure, detail)
}

impl LispHost {
  /// The status a reported expansion failure ends the shell with: 127 for a
  /// parameter error in a top-level `-c` string (bash 5.3), else 1.
  pub(in crate::script) fn expansion_failure_status(&mut self) -> i32 {
    let parameter = self.shell_compound.commands.expansion_failure_127.replace(false);
    let symbol = self.interp.string_interner().get("BASH_SUBSHELL");
    let nested = symbol.and_then(|symbol| self.env.borrow().get(symbol))
      .is_some_and(|level| !matches!(level, LispValue::String(level) if level == "0"));
    if parameter && !nested && self.shell_compound.invocation_flags.contains('c') { 127 } else { 1 }
  }
}

/// `${x@a}`: the attribute letters, in bash's order.
fn attribute_flags(attr: &crate::script::bash_arrays::VarAttributes, name: &str) -> String {
  let exported = attr.exported || tento_env::global_env_map().is_some_and(|map| map.get(name).is_some());
  [(attr.indexed, 'a'), (attr.associative, 'A'), (attr.integer, 'i'), (attr.readonly, 'r'), (exported, 'x')]
    .into_iter().filter(|(on, _)| *on).map(|(_, flag)| flag).collect()
}

/// One value through a `${x@OP}` operator that does not need the variable.
fn at_transform(value: &str, op: &str) -> String {
  let unicode = unicode_shell_locale();
  match op {
    "Q" | "K" | "k" => crate::script::shell_printf::quote_alternate(value),
    "E" => expand_escapes(value),
    "P" => prompt_escapes(value),
    "U" if unicode => value.to_uppercase(),
    "U" => value.to_ascii_uppercase(),
    "L" if unicode => value.to_lowercase(),
    "L" => value.to_ascii_lowercase(),
    "u" => {
      let mut chars = value.chars();
      match chars.next() {
        Some(first) if unicode => first.to_uppercase().chain(chars).collect(),
        Some(first) => std::iter::once(first.to_ascii_uppercase()).chain(chars).collect(),
        None => String::new(),
      }
    }
    _ => value.into(),
  }
}

/// `${x@E}`: the backslash escapes of `$'…'`; an unknown escape stays as written.
fn expand_escapes(value: &str) -> String {
  let chars: Vec<char> = value.chars().collect();
  let mut bytes = Vec::new();
  let mut i = 0;
  let number = |i: &mut usize, radix: u32, limit: usize| {
    let start = *i;
    let mut value = 0u32;
    while *i < chars.len() && *i - start < limit {
      let Some(digit) = chars[*i].to_digit(radix).filter(|_| chars[*i].is_ascii()) else { break };
      value = value * radix + digit;
      *i += 1;
    }
    (*i > start).then_some(value)
  };
  while i < chars.len() {
    let c = chars[i];
    i += 1;
    if c != '\\' || i == chars.len() {
      bytes.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
      continue;
    }
    let escape = chars[i];
    i += 1;
    let decoded = match escape {
      'a' => '\u{7}',
      'b' => '\u{8}',
      'e' | 'E' => '\u{1b}',
      'f' => '\u{c}',
      'n' => '\n',
      'r' => '\r',
      't' => '\t',
      'v' => '\u{b}',
      '\\' | '\'' | '"' | '?' => escape,
      'c' if i < chars.len() && chars[i].is_ascii() => {
        let control = chars[i];
        i += 1;
        bytes.push(if control == '?' { 0x7f } else { control as u8 & 0x1f });
        continue;
      }
      '0'..='7' => {
        i -= 1;
        bytes.push(number(&mut i, 8, 3).unwrap_or(0) as u8);
        continue;
      }
      'x' | 'u' | 'U' => {
        let limit = match escape { 'x' => 2, 'u' => 4, _ => 8 };
        match number(&mut i, 16, limit) {
          Some(value) if escape == 'x' => {
            bytes.push(value as u8);
            continue;
          }
          Some(value) => char::from_u32(value).unwrap_or('\u{fffd}'),
          None => {
            bytes.push(b'\\');
            escape
          }
        }
      }
      _ => {
        bytes.push(b'\\');
        escape
      }
    };
    bytes.extend_from_slice(decoded.encode_utf8(&mut [0; 4]).as_bytes());
  }
  // A shell word cannot hold NUL: it ends the value.
  if let Some(nul) = bytes.iter().position(|b| *b == 0) { bytes.truncate(nul); }
  String::from_utf8_lossy(&bytes).into_owned()
}

/// `${x@P}`: the prompt backslash escapes that do not need a terminal or the
/// host (`\a \e \n \r \\ \$ \[ \] \NNN`); other escapes stay as written.
/// Prompt parameter expansion (`promptvars`) is not applied.
fn prompt_escapes(value: &str) -> String {
  let chars: Vec<char> = value.chars().collect();
  let mut result = String::new();
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    i += 1;
    if c != '\\' || i == chars.len() {
      result.push(c);
      continue;
    }
    let escape = chars[i];
    i += 1;
    match escape {
      'a' => result.push('\u{7}'),
      'e' => result.push('\u{1b}'),
      'n' => result.push('\n'),
      'r' => result.push('\r'),
      '\\' => result.push('\\'),
      // SAFETY: geteuid has no preconditions and cannot fail.
      '$' => result.push(if unsafe { libc::geteuid() } == 0 { '#' } else { '$' }),
      '[' | ']' => {}
      '0'..='7' => {
        let start = i - 1;
        let end = (start..chars.len().min(start + 3)).take_while(|&j| chars[j].is_digit(8)).last().map_or(start, |j| j + 1);
        let code = chars[start..end].iter().fold(0u32, |n, d| n * 8 + d.to_digit(8).unwrap_or(0));
        result.push(char::from_u32(code & 0xff).unwrap_or('\u{fffd}'));
        i = end;
      }
      other => {
        result.push('\\');
        result.push(other);
      }
    }
  }
  result
}

impl LispHost {
  /// `std.sh.param-each NAME SELECTOR OP PATTERN REPLACEMENT`: one parameter
  /// operator over each element of an array, or of the positionals (`@`),
  /// joined or split by SELECTOR as `${a[@]}` is. A slice (`:`) carries its
  /// offset and length in PATTERN and REPLACEMENT.
  fn parameter_each(&self, parameter: NativeClosure<Sym>, lookup: NativeClosure<Sym>) -> NativeClosure<Sym> {
    use crate::script::bash_arrays::{array_fields, associative_entries, entries};
    let names = self.shell_symbols.clone();
    let positional = self.shell_compound.positional.clone();
    let zero = self.shell_compound.zero.clone();
    let attributes = self.shell_compound.commands.attributes.clone();
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let status_127 = self.shell_compound.commands.expansion_failure_127.clone();
    Rc::new(move |env, args| {
      let [LispValue::String(name), LispValue::String(selector), LispValue::String(op), pattern, replacement] = args.as_slice() else {
        return Err(parameter_error("std.sh.param-each: expected NAME SELECTOR OP PATTERN REPLACEMENT"));
      };
      let positionals = name == "@";
      let bound = (!positionals).then(|| names.borrow().get(name.as_str()).and_then(|symbol| env.borrow().get(*symbol))).flatten();
      // Each element's key and value, in key order.
      let (associative, elements): (bool, Vec<(i64, String, String)>) = if positionals {
        (false, positional.borrow().iter().enumerate().map(|(i, v)| (i as i64 + 1, (i + 1).to_string(), v.clone())).collect())
      } else if let Some(map) = bound.as_ref().and_then(associative_entries) {
        (true, map.into_iter().enumerate().map(|(i, (k, v))| (i as i64, k, v)).collect())
      } else if let Some(map) = bound.as_ref().and_then(entries) {
        (false, map.into_iter().map(|(k, v)| (k, k.to_string(), v)).collect())
      } else {
        let value = parameter(env.clone(), vec![LispValue::String(name.clone())])?;
        (false, if matches!(value, LispValue::Nil) { Vec::new() } else { vec![(0, "0".into(), scalar_text(value)?)] })
      };
      let fields = |values: Vec<String>| array_fields(env.clone(), values, selector, "", &lookup);
      if op == ":" {
        let offset = scalar_text(pattern.clone())?.parse::<i64>().map_err(|_| parameter_error("invalid substring offset"))?;
        let length = if matches!(replacement, LispValue::Nil) { None } else {
          let length = scalar_text(replacement.clone())?.parse::<i64>().map_err(|_| parameter_error("invalid substring length"))?;
          if length < 0 { return Err(expansion_fatal(&failure, format!("{length}: substring expression < 0"))); }
          Some(length as usize)
        };
        // `${@:0}` starts with `$0`; a negative offset counts back from the
        // end (past the last index for an array).
        let mut elements = elements;
        if positionals { elements.insert(0, (0, "0".into(), zero.borrow().clone())); }
        let end = if positionals { elements.len() as i64 } else { elements.last().map_or(0, |(k, _, _)| k + 1) };
        let start = if offset < 0 { end + offset } else { offset };
        if start < 0 { return fields(Vec::new()); }
        let values = elements.into_iter().filter(|(k, _, _)| *k >= start).map(|(_, _, v)| v);
        return fields(match length { Some(n) => values.take(n).collect(), None => values.collect() });
      }
      if let Some(op) = op.strip_prefix('@') {
        let display = scalar_text(replacement.clone())?;
        if !AT_OPERATORS.contains(&op) { return Err(parameter_fatal(&failure, &status_127, format!("{display}: bad substitution"))); }
        let array = !positionals && (bound.as_ref().is_some_and(|value| associative_entries(value).is_some() || entries(value).is_some()));
        let mut attr = attributes.borrow().get(name.as_str()).copied().unwrap_or_default();
        attr.associative |= associative;
        attr.indexed |= array && !associative;
        let flags = attribute_flags(&attr, name);
        let values: Vec<String> = match op {
          "a" => elements.iter().map(|_| flags.clone()).collect(),
          "k" if array => elements.into_iter().flat_map(|(_, k, v)| [k, v]).collect(),
          "K" if array => {
            let pairs: Vec<_> = elements.iter().map(|(_, k, v)| format!("{k} {}", double_quote(v))).collect();
            return Ok(LispValue::String(if associative { pairs.iter().map(|pair| format!("{pair} ")).collect::<String>().into() } else { pairs.join(" ").into() }));
          }
          "A" if array => {
            let pairs: Vec<_> = elements.iter().map(|(_, k, v)| format!("[{k}]={}", double_quote(v))).collect();
            let body: String = if associative { pairs.iter().map(|pair| format!("{pair} ")).collect() } else { pairs.join(" ") };
            vec!["declare".into(), format!("-{flags}"), format!("{name}=({body})")]
          }
          "A" if positionals => ["set".to_string(), "--".to_string()].into_iter()
            .chain(elements.iter().map(|(_, _, v)| at_transform(v, "Q"))).collect(),
          "A" => elements.iter().map(|(_, _, v)| if flags.is_empty() { format!("{name}={}", at_transform(v, "Q")) }
            else { format!("declare -{flags} {name}={}", at_transform(v, "Q")) }).collect(),
          op => elements.iter().map(|(_, _, v)| at_transform(v, op)).collect(),
        };
        return fields(values);
      }
      let pattern = pattern_text(pattern)?;
      let values = elements.iter().map(|(_, _, v)| parameter_transform(v, op, &pattern, replacement)).collect::<Result<Vec<_>, _>>()?;
      fields(values)
    })
  }
}

/// A value as bash prints it inside `${a[@]@K}` and `@A`: double-quoted, with
/// `\ " $` and backquote escaped.
fn double_quote(value: &str) -> String {
  let mut quoted = String::from("\"");
  for c in value.chars() {
    if matches!(c, '\\' | '"' | '$' | '`') { quoted.push('\\'); }
    quoted.push(c);
  }
  quoted.push('"');
  quoted
}

fn parameter_transform(value: &str, op: &str, pattern: &str, replacement: &LispValue<Sym>) -> Result<String, RuntimeError> {
  let unicode = unicode_shell_locale();
  if op == "length" { return Ok(if unicode { value.chars().count() } else { value.len() }.to_string()); }
  let tokens = compile_component(pattern.as_bytes());
  let bytes = value.as_bytes();
  let matches = |word: &[u8]| pattern_matches(&tokens, word, false);
  let to_text = |bytes: &[u8]| String::from_utf8(bytes.to_vec()).map_err(|_| parameter_error("parameter result is not UTF-8 — byte-valued variables are not supported yet"));
  let boundaries: Vec<_> = if unicode {
    value.char_indices().map(|(i, _)| i).chain(std::iter::once(value.len())).collect()
  } else { (0..=value.len()).collect() };
  if matches!(op, "#" | "##" | "%" | "%%") {
    let mut candidates = boundaries.clone();
    if op == "##" || op == "%" { candidates.reverse(); }
    for i in candidates {
      if op.starts_with('#') && matches(&bytes[..i]) { return to_text(&bytes[i..]); }
      if op.starts_with('%') && matches(&bytes[i..]) { return to_text(&bytes[..i]); }
    }
    return Ok(value.into());
  }
  if matches!(op, "^" | "^^" | "," | ",,") {
    let mut result = String::new();
    for (i, c) in value.chars().enumerate() {
      if (op.len() == 2 || i == 0) && (pattern.is_empty() || matches(c.to_string().as_bytes())) {
        let mapped = if unicode {
          if op.starts_with('^') {
            let mut upper = c.to_uppercase();
            let first = upper.next().unwrap_or(c);
            if upper.next().is_some() { c } else { first }
          } else { c.to_lowercase().next().unwrap_or(c) }
        } else if op.starts_with('^') { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() };
        result.push(mapped);
      } else { result.push(c); }
    }
    return Ok(result);
  }
  let mut result = Vec::new();
  let mut cursor = 0;
  let mut index = 0;
  if pattern.is_empty() { return Ok(value.into()); }
  while index < boundaries.len() {
    let start = boundaries[index];
    if cursor == value.len() && !result.is_empty() { break; }
    if op == "/#" && start != 0 { break; }
    let end = boundaries[index..].iter().rev().copied().find(|end| {
      (op != "/%" || *end == value.len()) && matches(&bytes[start..*end])
    });
    if let Some(end) = end {
      result.extend_from_slice(&bytes[cursor..start]);
      let matched = std::str::from_utf8(&bytes[start..end]);
      if matched.is_err() {
        for part in descriptor_parts(replacement)? {
          let LispValue::List(pair) = part else { return Err(parameter_error("parameter replacement: expected part")); };
          if matches!(pair.items.get(2), Some(LispValue::Boolean(true)))
            && scalar_text(pair.items[1].clone())?.contains('&') {
            return Err(parameter_error("parameter match is not UTF-8 — byte-valued variables are not supported yet"));
          }
        }
      }
      result.extend_from_slice(replacement_text(replacement, matched.unwrap_or(""))?.as_bytes());
      cursor = end;
      if op != "//" { break; }
      if end == start {
        // Empty matches advance by one character, preventing an infinite loop.
        if let Some(next) = boundaries.get(index + 1).copied() { result.extend_from_slice(&bytes[end..next]); cursor = next; }
        index += 1;
      } else { index = boundaries.binary_search(&end).unwrap(); }
    } else { index += 1; }
  }
  result.extend_from_slice(&bytes[cursor..]);
  to_text(&result)
}

struct WordField {
  text: String,
  pattern: String,
}

impl WordField {
  fn new() -> Self {
    Self {
      text: String::new(),
      pattern: String::new(),
    }
  }

  fn push(&mut self, c: char, glob: bool) {
    self.text.push(c);
    // Protected characters remain literal even inside a bracket expression.
    if !glob && c != '/' {
      self.pattern.push('\\');
    }
    self.pattern.push(c);
  }
}

fn expand_word(
  parts: Vec<LispValue<Sym>>,
  ifs: &str,
  globbing: bool,
) -> Result<LispValue<Sym>, RuntimeError> {
  expand_word_with_options(parts, ifs, globbing, crate::script::bash_compound::GlobOptions::default())
}

fn expand_fragments(
  parts: Vec<LispValue<Sym>>, protection: Option<(bool, bool)>, depth: usize,
) -> Result<Vec<LispValue<Sym>>, RuntimeError> {
  if depth > 128 { return Err(parameter_error("parameter word nesting exceeded")); }
  let mut result = Vec::new();
  for part in parts {
    let LispValue::List(mut pair) = part else { return Err(parameter_error("word: expected descriptor")); };
    if !(2..=4).contains(&pair.items.len()) || !matches!(pair.items.first(), Some(LispValue::Boolean(_))) {
      return Err(parameter_error("word: invalid descriptor"));
    }
    let split = matches!(pair.items.first(), Some(LispValue::Boolean(true)));
    let glob = matches!(pair.items.get(2), Some(LispValue::Boolean(true))) || pair.items.len() == 2 && split;
    if let Some(LispValue::List(value)) = pair.items.get(1) {
      if let Some(inner) = fragments(&value.items) {
        let inherited = protection.map_or((split, glob), |(ps, pg)| (ps && split, pg && glob));
        result.extend(expand_fragments(inner.to_vec(), Some(inherited), depth + 1)?);
        continue;
      }
    }
    if let Some((ps, pg)) = protection {
      pair.items[0] = LispValue::Boolean(split && ps);
      if pair.items.len() >= 3 { pair.items[2] = LispValue::Boolean(glob && pg); }
    }
    result.push(LispValue::List(pair));
  }
  Ok(result)
}

fn expand_word_with_options(
  parts: Vec<LispValue<Sym>>, ifs: &str, globbing: bool,
  options: crate::script::bash_compound::GlobOptions,
) -> Result<LispValue<Sym>, RuntimeError> {
  expand_word_collated(parts, ifs, globbing, options, "C", "C", "C", "")
}

#[cfg(test)]
fn sort_pathnames(locale: &str, names: &mut [String]) {
  sort_pathnames_with_ctype(locale, locale, names);
}

#[cfg(test)]
fn sort_pathnames_with_ctype(locale: &str, ctype: &str, names: &mut [String]) {
  sort_pathnames_in_locale(locale, ctype, "C", names);
}

fn sort_pathnames_in_locale(locale: &str, ctype: &str, default_locale: &str, names: &mut [String]) {
  names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
  if names.len() < 2 || matches!(locale, "" | "C" | "POSIX") { return; }
  #[cfg(unix)]
  {
    use std::ffi::CString;
    // libc does not expose strcoll_l on all of our Unix targets.
    unsafe extern "C" {
      fn strcoll_l(a: *const libc::c_char, b: *const libc::c_char, locale: libc::locale_t) -> libc::c_int;
    }
    struct Locale(libc::locale_t);
    impl Drop for Locale {
      fn drop(&mut self) { unsafe { libc::freelocale(self.0); } }
    }
    let (Ok(name), Ok(ctype), Ok(default_locale)) =
      (CString::new(locale), CString::new(ctype), CString::new(default_locale)) else { return; };
    // Darwin's strcoll_l decodes multibyte text using LC_CTYPE. Set both
    // categories so the host process locale cannot leak into a shell's sort.
    // Bash resets categories to LANG before applying LC_*; a failed category
    // override keeps that default. An unavailable default falls back to C.
    // libc omits LC_ALL_MASK on musl; its six standard categories have
    // the same individual masks. Other targets retain their native mask.
    #[cfg(target_env = "musl")]
    let all_mask = libc::LC_CTYPE_MASK | libc::LC_NUMERIC_MASK | libc::LC_TIME_MASK
      | libc::LC_COLLATE_MASK | libc::LC_MONETARY_MASK | libc::LC_MESSAGES_MASK;
    #[cfg(not(target_env = "musl"))]
    let all_mask = libc::LC_ALL_MASK;
    let mut raw = unsafe { libc::newlocale(all_mask, default_locale.as_ptr(), std::ptr::null_mut()) };
    if raw.is_null() {
      raw = unsafe { libc::newlocale(all_mask, c"C".as_ptr(), std::ptr::null_mut()) };
    }
    if raw.is_null() { return; }
    let mut locale = Locale(raw);
    let raw = unsafe { libc::newlocale(libc::LC_CTYPE_MASK, ctype.as_ptr(), locale.0) };
    if !raw.is_null() { locale.0 = raw; }
    let raw = unsafe { libc::newlocale(libc::LC_COLLATE_MASK, name.as_ptr(), locale.0) };
    if !raw.is_null() { locale.0 = raw; }
    names.sort_by(|a, b| {
      let bytes = a.as_bytes().cmp(b.as_bytes());
      let (Ok(a), Ok(b)) = (CString::new(a.as_str()), CString::new(b.as_str())) else { return bytes; };
      unsafe { strcoll_l(a.as_ptr(), b.as_ptr(), locale.0) }.cmp(&0).then(bytes)
    });
  }
}

/// `ignore` is `GLOBIGNORE`: colon-separated patterns whose matches pathname
/// expansion drops; a nonempty value also matches dot files, as bash does.
#[allow(clippy::too_many_arguments)]
fn expand_word_collated(
  parts: Vec<LispValue<Sym>>, ifs: &str, globbing: bool,
  mut options: crate::script::bash_compound::GlobOptions, locale: &str, ctype: &str, default_locale: &str,
  ignore: &str,
) -> Result<LispValue<Sym>, RuntimeError> {
  options.dotglob |= !ignore.is_empty();
  let parts = expand_fragments(parts, None, 0)?;
  let mut descriptors = Vec::with_capacity(parts.len());
  for part in parts {
    let LispValue::List(pair) = part else {
      return Err(RuntimeError::Other(
        "std.sh.split: each part must be [unquoted? value [glob?]]".into(),
      ));
    };
    let (eligible, value, glob, positional) = match pair.items.as_slice() {
      [LispValue::Boolean(eligible), value] => (*eligible, value.clone(), *eligible, false),
      [
        LispValue::Boolean(eligible),
        value,
        LispValue::Boolean(glob),
      ] => (*eligible, value.clone(), *glob, false),
      [LispValue::Boolean(eligible), value, LispValue::Boolean(glob), LispValue::Boolean(positional)] => (*eligible, value.clone(), *glob, *positional),
      _ => {
        return Err(RuntimeError::Other(
          "std.sh.split: each part must be [unquoted? value [glob?]]".into(),
        ));
      }
    };
    descriptors.push((eligible, value, glob, positional));
  }
  // Keep the typed whole-word escape hatch; joined words require scalar text.
  if descriptors.len() == 1 && descriptors[0].0 && !descriptors[0].3 && !matches!(descriptors[0].1, LispValue::String(_))
  {
    return Ok(LispValue::List(tento_lisp::List {
      items: vec![descriptors.pop().unwrap().1].into(),
    }));
  }
  let delimiters: HashSet<char> = ifs.chars().collect();
  let mut fields = Vec::new();
  let mut word = WordField::new();
  let mut active = false;
  let mut pending_space = false;
  for (eligible, value, glob, positional) in descriptors {
    if positional && matches!(value, LispValue::List(_)) {
      let LispValue::List(values) = value else {
        return Err(RuntimeError::Other("std.sh.split: positional fields must be a list".into()));
      };
      // $@ and empty-IFS $* contribute separate fields. With nonempty IFS,
      // $* is a scalar joined before splitting. Prefix/suffix text attaches
      // only to the first/last positional field.
      let mut first = true;
      for value in values.items {
        let descriptor = LispValue::List(tento_lisp::List { items: vec![
          LispValue::Boolean(eligible), value, LispValue::Boolean(glob),
        ].into() });
        let LispValue::List(expanded) = expand_word(vec![descriptor], ifs, false)? else { unreachable!() };
        for value in expanded.items {
          if !first && active {
            fields.push(std::mem::replace(&mut word, WordField::new()));
          }
          if pending_space && active {
            fields.push(std::mem::replace(&mut word, WordField::new()));
          }
          let text = scalar_text(value)?;
          for c in text.chars() { word.push(c, glob); }
          active = true; pending_space = false; first = false;
        }
      }
      continue;
    }
    let text = scalar_text(value)?;
    // Empty quotes anchor a field on their side of an IFS boundary.
    if !eligible && text.is_empty() {
      if pending_space && active {
        fields.push(std::mem::replace(&mut word, WordField::new()));
      }
      active = true;
      pending_space = false;
    }
    for c in text.chars() {
      if eligible && delimiters.contains(&c) {
        if matches!(c, ' ' | '\t' | '\n') {
          pending_space = true;
        } else {
          fields.push(std::mem::replace(&mut word, WordField::new()));
          active = false;
          pending_space = false;
        }
      } else {
        if pending_space && active {
          fields.push(std::mem::replace(&mut word, WordField::new()));
        }
        word.push(c, glob);
        active = true;
        pending_space = false;
      }
    }
  }
  if active {
    fields.push(word);
  }
  let mut values = Vec::new();
  for field in fields {
    let mut matches = if globbing {
      pathname_matches_with_options(&field.pattern, options)?
    } else {
      Vec::new()
    };
    if !ignore.is_empty() {
      matches.retain(|path| {
        let name = path.rsplit('/').next().unwrap_or(path);
        // bash matches each pattern against the whole path, `/` by `/`.
        name != "." && name != ".." && !ignore.split(':').filter(|pattern| !pattern.is_empty())
          .any(|pattern| {
            let patterns: Vec<_> = pattern.split('/').collect();
            let parts: Vec<_> = path.split('/').collect();
            patterns.len() == parts.len() && patterns.iter().zip(&parts)
              .all(|(pattern, part)| pattern_matches(&compile_component(pattern.as_bytes()), part.as_bytes(), false))
          })
      });
    }
    sort_pathnames_in_locale(locale, ctype, default_locale, &mut matches);
    if matches.is_empty() {
      let active = globbing && field.pattern.split('/').any(|part| component_has_pattern(&compile_component(part.as_bytes())));
      if active && options.failglob {
        return Err(RuntimeError::Fatal { detail: format!("no match: {}", field.text) });
      }
      if active && options.nullglob { continue; }
      values.push(LispValue::String(field.text.into()));
    } else {
      values.extend(matches.into_iter().map(|value| LispValue::String(value.into())));
    }
  }
  Ok(LispValue::List(tento_lisp::List { items: values.into() }))
}

#[path = "bash_extglob.rs"]
mod bash_extglob;

#[derive(Debug)]
pub(super) enum GlobToken {
  Literal(u8),
  Any,
  Star,
  Bracket(bool, Vec<BracketItem>),
  /// An extended glob group: its operator (`?*+@!`) and alternatives
  /// (bash_extglob.rs).
  Group(u8, Vec<Vec<GlobToken>>),
}

#[derive(Debug, Clone)]
pub(super) enum BracketItem {
  Byte(u8),
  Range(u8, u8),
  Class(Vec<u8>),
}

pub(super) fn bracket(pattern: &[u8], start: usize) -> Option<(GlobToken, usize)> {
  let mut i = start + 1;
  let negated = matches!(pattern.get(i), Some(b'!' | b'^'));
  if negated {
    i += 1;
  }
  // The first ] is data. A later unescaped ] closes the expression.
  let mut atoms: Vec<(BracketItem, bool)> = Vec::new();
  while i < pattern.len() {
    if pattern[i] == b']' && !atoms.is_empty() {
      let mut items = Vec::new();
      let mut atoms = atoms.into_iter().peekable();
      while let Some((atom, _)) = atoms.next() {
        if let BracketItem::Byte(first) = atom {
          if matches!(atoms.peek(), Some((BracketItem::Byte(b'-'), false))) {
            // A trailing - is literal; ranges require a byte at both ends.
            let mut probe = atoms.clone();
            probe.next();
            if let Some((BracketItem::Byte(last), _)) = probe.next() {
              atoms.next();
              atoms.next();
              items.push(BracketItem::Range(first, last));
              continue;
            }
          }
          items.push(BracketItem::Byte(first));
        } else {
          items.push(atom);
        }
      }
      return Some((GlobToken::Bracket(negated, items), i + 1));
    }
    // `[.a.]` and `[=a=]` name one character in the C locale.
    if pattern[i] == b'[' && matches!(pattern.get(i + 1), Some(b'.' | b'=')) {
      let delimiter = pattern[i + 1];
      if pattern.get(i + 3) == Some(&delimiter) && pattern.get(i + 4) == Some(&b']') {
        atoms.push((BracketItem::Byte(pattern[i + 2]), true));
        i += 5;
        continue;
      }
    }
    if pattern[i] == b'[' && pattern.get(i + 1) == Some(&b':') {
      let mut end = i + 2;
      let mut class = Vec::new();
      while end + 1 < pattern.len() {
        // Bash permits quoting class-name bytes and the closing colon, but
        // the opening [: and closing ] must remain active syntax.
        if pattern[end] == b'\\' {
          end += 1;
        }
        if pattern[end] == b':' && pattern.get(end + 1) == Some(&b']') {
          atoms.push((BracketItem::Class(class), false));
          i = end + 2;
          break;
        }
        class.push(pattern[end]);
        end += 1;
      }
      if i == end + 2 {
        continue;
      }
    }
    let escaped = pattern[i] == b'\\' && i + 1 < pattern.len();
    if escaped {
      i += 1;
    }
    atoms.push((BracketItem::Byte(pattern[i]), escaped));
    i += 1;
  }
  None
}

pub(super) fn compile_component(pattern: &[u8]) -> Vec<GlobToken> {
  let mut tokens = Vec::new();
  let mut i = 0;
  while i < pattern.len() {
    if let Some((group, end)) = bash_extglob::group(pattern, i) {
      tokens.push(group);
      i = end;
      continue;
    }
    match pattern[i] {
      b'\\' if i + 1 < pattern.len() => {
        i += 1;
        tokens.push(GlobToken::Literal(pattern[i]));
      }
      b'*' => {
        if !matches!(tokens.last(), Some(GlobToken::Star)) {
          tokens.push(GlobToken::Star);
        }
      }
      b'?' => tokens.push(GlobToken::Any),
      b'[' => {
        if let Some((token, end)) = bracket(pattern, i) {
          tokens.push(token);
          i = end;
          continue;
        }
        tokens.push(GlobToken::Literal(b'['));
      }
      byte => tokens.push(GlobToken::Literal(byte)),
    }
    i += 1;
  }
  tokens
}

fn class_matches(class: &[u8], byte: u8) -> bool {
  match class {
    b"alnum" => byte.is_ascii_alphanumeric(),
    b"alpha" => byte.is_ascii_alphabetic(),
    b"blank" => matches!(byte, b' ' | b'\t'),
    b"cntrl" => byte.is_ascii_control(),
    b"digit" => byte.is_ascii_digit(),
    b"graph" => byte.is_ascii_graphic(),
    b"lower" => byte.is_ascii_lowercase(),
    b"print" => byte == b' ' || byte.is_ascii_graphic(),
    b"punct" => byte.is_ascii_punctuation(),
    b"space" => byte.is_ascii_whitespace() || byte == 0x0b,
    b"upper" => byte.is_ascii_uppercase(),
    b"xdigit" => byte.is_ascii_hexdigit(),
    _ => false,
  }
}

fn component_has_pattern(tokens: &[GlobToken]) -> bool {
  tokens.iter().any(|t| !matches!(t, GlobToken::Literal(_)))
}

fn component_matches(tokens: &[GlobToken], name: &[u8]) -> bool {
  pattern_matches(tokens, name, true)
}

fn pattern_matches(tokens: &[GlobToken], name: &[u8], pathname: bool) -> bool {
  if pathname && (name.contains(&b'/')
    || (name.first() == Some(&b'.') && !matches!(tokens.first(), Some(GlobToken::Literal(b'.')))))
  {
    return false;
  }
  if tokens.iter().any(|token| matches!(token, GlobToken::Group(..))) {
    return bash_extglob::matches(tokens, name);
  }
  // Rolling dynamic-programming rows avoid recursion and exponential backtracking.
  let mut previous = vec![false; name.len() + 1];
  previous[0] = true;
  for token in tokens {
    let mut next = vec![false; name.len() + 1];
    if matches!(token, GlobToken::Star) {
      next[0] = previous[0];
      for i in 1..=name.len() {
        next[i] = previous[i] || next[i - 1];
      }
    } else {
      for (i, byte) in name.iter().copied().enumerate() {
        let matches = match token {
          GlobToken::Literal(literal) => byte == *literal,
          GlobToken::Any => true,
          GlobToken::Bracket(negated, items) => {
            let matched = items.iter().any(|item| match item {
              BracketItem::Byte(literal) => byte == *literal,
              BracketItem::Range(first, last) => *first <= byte && byte <= *last,
              BracketItem::Class(class) => class_matches(class, byte),
            });
            matched != *negated
          }
          GlobToken::Star | GlobToken::Group(..) => unreachable!(),
        };
        next[i + 1] = previous[i] && matches;
      }
    }
    previous = next;
  }
  previous[name.len()]
}

/// Whether one non-star, non-group token matches BYTE.
pub(super) fn single_matches(token: &GlobToken, byte: u8) -> bool {
  match token {
    GlobToken::Literal(literal) => byte == *literal,
    GlobToken::Any => true,
    GlobToken::Bracket(negated, items) => {
      let matched = items.iter().any(|item| match item {
        BracketItem::Byte(literal) => byte == *literal,
        BracketItem::Range(first, last) => *first <= byte && byte <= *last,
        BracketItem::Class(class) => class_matches(class, byte),
      });
      matched != *negated
    }
    GlobToken::Star | GlobToken::Group(..) => false,
  }
}

/// A whole-string (non-pathname) match of PATTERN against NAME.
#[cfg(test)]
pub(super) fn pattern_text_matches(pattern: &str, name: &str) -> bool {
  pattern_matches(&compile_component(pattern.as_bytes()), name.as_bytes(), false)
}

fn pathname_matches(pattern: &str) -> Result<Vec<String>, RuntimeError> {
  pathname_matches_with_options(pattern, crate::script::bash_compound::GlobOptions::default())
}

// Globstar never follows directory symlinks recursively, so a link cycle cannot
// turn a finite pathname expansion into an unbounded filesystem walk.
fn globstar_paths(
  directory: &std::path::Path,
  prefix: &[u8],
  separator: bool,
  dots: bool,
  files: bool,
  result: &mut Vec<(std::path::PathBuf, Vec<u8>)>,
) {
  let Ok(entries) = std::fs::read_dir(directory) else {
    return;
  };
  for entry in entries.flatten() {
    let name = entry.file_name();
    #[cfg(unix)]
    let bytes = {
      use std::os::unix::ffi::OsStrExt;
      name.as_os_str().as_bytes()
    };
    #[cfg(not(unix))]
    let bytes = name.to_str().unwrap_or("").as_bytes();
    if !dots && bytes.starts_with(b".") {
      continue;
    }
    let mut presented = prefix.to_vec();
    if separator {
      presented.push(b'/');
    }
    presented.extend_from_slice(bytes);
    let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
    if files || is_dir {
      result.push((entry.path(), presented.clone()));
    }
    if is_dir {
      globstar_paths(&entry.path(), &presented, true, dots, files, result);
    }
  }
}

fn pathname_matches_with_options(pattern: &str, options: crate::script::bash_compound::GlobOptions) -> Result<Vec<String>, RuntimeError> {
  // Keep large ordinary expansion results off the pattern compiler's path.
  if !pattern.bytes().any(|b| matches!(b, b'*' | b'?' | b'['))
    && !pattern.as_bytes().windows(2).any(|pair| matches!(pair, [b'+' | b'@' | b'!', b'(']))
  {
    return Ok(Vec::new());
  }
  // Patterns and filesystem names are bytes under the suite's LC_ALL=C.
  let components: Vec<_> = pattern
    .split('/')
    .map(|p| compile_component(if options.nocaseglob { p.to_ascii_lowercase() } else { p.to_string() }.as_bytes()))
    .collect();
  if !components.iter().any(|c| component_has_pattern(c)) {
    return Ok(Vec::new());
  }
  let absolute = pattern.starts_with('/');
  let mut paths = vec![(
    std::path::PathBuf::from(if absolute { "/" } else { "." }),
    Vec::<u8>::new(),
  )];
  for (index, component) in components.iter().enumerate() {
    if absolute && index == 0 {
      continue;
    }
    let mut next = Vec::new();
    for (directory, mut prefix) in paths {
      if options.globstar && pattern.split('/').nth(index) == Some("**") {
        if index + 1 < components.len() {
          next.push((directory.clone(), prefix.clone()));
        } else if index != 0 && !prefix.is_empty() {
          // A final `**` matches zero directories too: `d/**` holds `d/`.
          let mut itself = prefix.clone();
          itself.push(b'/');
          next.push((directory.clone(), itself));
        }
        globstar_paths(
          &directory,
          &prefix,
          index != 0 && (!prefix.is_empty() || absolute),
          options.dotglob,
          index + 1 == components.len(),
          &mut next,
        );
        continue;
      }
      if index != 0 && (!prefix.is_empty() || absolute) {
        prefix.push(b'/');
      }
      if component.is_empty() {
        if directory.is_dir() {
          next.push((directory, prefix));
        }
      } else if component_has_pattern(component) || options.nocaseglob {
        let Ok(entries) = std::fs::read_dir(&directory) else {
          continue;
        };
        for entry in entries.flatten() {
          let name = entry.file_name();
          #[cfg(unix)]
          let bytes = {
            use std::os::unix::ffi::OsStrExt;
            name.as_os_str().as_bytes()
          };
          #[cfg(not(unix))]
          let bytes = name.to_str().unwrap_or("").as_bytes();
          let folded = if options.nocaseglob { bytes.to_ascii_lowercase() } else { bytes.to_vec() };
          let matched = if options.dotglob {
            !folded.contains(&b'/') && pattern_matches(component, &folded, false)
          } else { component_matches(component, &folded) };
          if bytes == b"." || bytes == b".." || !matched {
            continue;
          }
          let mut presented = prefix.clone();
          presented.extend_from_slice(bytes);
          next.push((entry.path(), presented));
        }
      } else {
        let bytes: Vec<u8> = component
          .iter()
          .map(|t| match t {
            GlobToken::Literal(byte) => *byte,
            _ => unreachable!(),
          })
          .collect();
        let name = String::from_utf8(bytes).map_err(|_| RuntimeError::Command {
          detail: "pathname expansion pattern is not UTF-8".into(),
        })?;
        let path = directory.join(&name);
        // A dangling symlink is still a pathname, while intermediate components
        // must be readable directories (checked on the next walk iteration).
        if std::fs::symlink_metadata(&path).is_ok() {
          prefix.extend_from_slice(name.as_bytes());
          next.push((path, prefix));
        }
      }
    }
    paths = next;
    if paths.is_empty() {
      break;
    }
  }
  let mut names: Vec<_> = paths.into_iter().map(|(_, name)| name).collect();
  names.sort();
  names.dedup();
  names
    .into_iter()
    .map(|name| {
      String::from_utf8(name).map_err(|_| RuntimeError::Command {
        detail: "pathname expansion filename is not UTF-8".into(),
      })
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::script::{PipelineFuture, ShellCapture, ShellIo};

  pub(super) fn host() -> LispHost {
    let mut host = LispHost::new();
    host.eval_posix_line("LC_ALL=C").unwrap();
    host.register_native_special("args", |args| {
      Ok(LispValue::List(tento_lisp::List { items: args.into() }))
    });
    host
  }

  pub(super) struct GlobTree(pub(super) std::path::PathBuf);

  impl GlobTree {
    pub(super) fn new() -> Self {
      static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
      let root = std::env::temp_dir().join(format!(
        "tento-04q-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
      ));
      std::fs::create_dir(&root).unwrap();
      for dir in ["d", "d/sub", "empty", ".hidden-dir"] {
        std::fs::create_dir(root.join(dir)).unwrap();
      }
      for file in [
        "a.txt",
        "b.txt",
        "c.txt",
        "a1.log",
        ".hidden",
        "premidZ",
        "pre*midZ",
        "d/a.txt",
        "d/.secret",
        "d/sub/z.txt",
        "punct.-",
        "punct.C",
        "literal*",
        "bracket[",
        "utf8-μ",
        "space name.txt",
        "backslash\\a.txt",
      ] {
        std::fs::write(root.join(file), "").unwrap();
      }
      Self(root)
    }

    pub(super) fn pattern(&self, suffix: &str) -> String {
      format!("{}/{suffix}", self.0.display())
    }

    fn matches(&self, suffix: &str) -> Vec<String> {
      pathname_matches(&self.pattern(suffix))
        .unwrap()
        .into_iter()
        .map(|p| {
          p.strip_prefix(&format!("{}/", self.0.display()))
            .unwrap()
            .to_string()
        })
        .collect()
    }
  }

  impl Drop for GlobTree {
    fn drop(&mut self) {
      std::fs::remove_dir_all(&self.0).unwrap();
    }
  }

  #[test]
  fn pathname_globs_match_bash_components_classes_dots_and_byte_order() {
    let tree = GlobTree::new();
    for (pattern, expected) in [
      ("?.txt", vec!["a.txt", "b.txt", "c.txt"]),
      ("[a-c].txt", vec!["a.txt", "b.txt", "c.txt"]),
      ("[!a].txt", vec!["b.txt", "c.txt"]),
      ("[^a].txt", vec!["b.txt", "c.txt"]),
      ("[[:alpha:]].txt", vec!["a.txt", "b.txt", "c.txt"]),
      ("a[[:digit:]].log", vec!["a1.log"]),
      ("punct.[[:punct:]C]", vec!["punct.-", "punct.C"]),
      (r"punct.[C\-D]", vec!["punct.-", "punct.C"]),
      ("d/*", vec!["d/a.txt", "d/sub"]),
      ("d/*/*.txt", vec!["d/sub/z.txt"]),
      ("*/", vec!["d/", "empty/"]),
      (".*", vec![".hidden", ".hidden-dir"]),
      ("[.]hidden", vec![]),
      ("d/.*", vec!["d/.secret"]),
      ("empty/*", vec![]),
      ("missing*", vec![]),
      (r"literal\*", vec![]),
      ("utf8-?", vec![]), // LC_ALL=C: ? consumes one byte, not a UTF-8 scalar.
      ("utf8-??", vec!["utf8-μ"]),
    ] {
      assert_eq!(tree.matches(pattern), expected, "{pattern}");
    }
    let all = tree.matches("*");
    assert!(!all.iter().any(|p| p.starts_with('.')));
    assert!(!all.iter().any(|p| p.contains('/')));
    assert!(all.windows(2).all(|p| p[0].as_bytes() < p[1].as_bytes()));
    assert_eq!(tree.matches("./.*"), vec!["./.hidden", "./.hidden-dir"]);
    assert_eq!(
      tree.matches("d/../.*"),
      vec!["d/../.hidden", "d/../.hidden-dir"]
    );
  }

  #[test]
  fn pathname_classes_decode_escapes_in_class_names_and_the_closing_colon() {
    for (class, byte) in [
      ("alnum", b'a'), ("alpha", b'a'), ("blank", b' '), ("cntrl", b'\n'),
      ("digit", b'1'), ("graph", b'-'), ("lower", b'a'), ("print", b' '),
      ("punct", b'-'), ("space", b'\t'), ("upper", b'A'), ("xdigit", b'f'),
    ] {
      for pattern in [format!("[[:{class}:]]"), format!("[[:{class}\\:]]"), format!("[[:\\{class}:]]")] {
        assert!(component_matches(&compile_component(pattern.as_bytes()), &[byte]), "{pattern}");
      }
    }
    assert!(!component_matches(&compile_component(br"[[\:punct:]]"), b"-"));
    assert!(!component_matches(&compile_component(br"[\[:punct:]]"), b"-"));
  }

  #[cfg(unix)]
  #[test]
  fn pathname_walk_preserves_slashes_and_follows_directory_symlinks() {
    use std::os::unix::fs::symlink;
    let tree = GlobTree::new();
    symlink(tree.0.join("d"), tree.0.join("link")).unwrap();
    symlink(tree.0.join("missing"), tree.0.join("dangling")).unwrap();
    assert_eq!(tree.matches("link/*.txt"), vec!["link/a.txt"]);
    assert_eq!(tree.matches("dangl*"), vec!["dangling"]);
    assert_eq!(tree.matches("dangl*/"), Vec::<String>::new());
    for separators in ["/", "//", "///"] {
      let pattern = format!("d{separators}*.txt");
      assert_eq!(tree.matches(&pattern), vec![format!("d{separators}a.txt")]);
      let pattern = format!("d{separators}*/");
      assert_eq!(tree.matches(&pattern), vec![format!("d{separators}sub/")]);
      let pattern = format!("{0}{separators}d{separators}*.txt", tree.0.display());
      assert_eq!(pathname_matches(&pattern).unwrap(),
        vec![format!("{0}{separators}d{separators}a.txt", tree.0.display())]);
    }
    assert_eq!(tree.matches("**/*.txt"), vec!["d/a.txt", "link/a.txt"]);
    assert_eq!(tree.matches("d/./*.txt"), vec!["d/./a.txt"]);
    let options = crate::script::bash_compound::GlobOptions {
      globstar: true, ..Default::default()
    };
    for separators in ["/", "//", "///"] {
      let pattern = format!("{0}{separators}d{separators}**/*.txt", tree.0.display());
      assert_eq!(pathname_matches_with_options(&pattern, options).unwrap(), vec![
        format!("{0}{separators}d{separators}a.txt", tree.0.display()),
        format!("{0}{separators}d{separators}sub/z.txt", tree.0.display()),
      ]);
    }
  }

  #[cfg(unix)]
  fn filename_encoding_refused(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::EILSEQ)
  }

  #[cfg(unix)]
  #[test]
  fn non_utf8_fixture_skips_only_a_filesystem_encoding_refusal() {
    assert!(filename_encoding_refused(
      &std::io::Error::from_raw_os_error(libc::EILSEQ)
    ));
    assert!(!filename_encoding_refused(
      &std::io::Error::from_raw_os_error(libc::EACCES)
    ));
  }

  #[test]
  fn shell_expanded_argv_keeps_colon_prefixed_fields_verbatim() {
    let mut host = host();
    host.eval_posix_line("IFS=:").unwrap();
    host.eval_posix_line("word=a:").unwrap();
    let value = host.read_posix_line_value("external ${word}:b").unwrap();
    assert_eq!(
      host.application_to_argv(&value).unwrap(),
      vec!["external", "a", ":b"]
    );
    let value = host
      .read_posix_line_value("external ${word} --some-flag ':literal'")
      .unwrap();
    assert_eq!(
      host.application_to_argv(&value).unwrap(),
      vec!["external", "a", "--some-flag", ":literal"]
    );
    host.eval_posix_line("cmd=external").unwrap();
    let value = host
      .read_posix_line_value("$cmd --some-flag ':literal'")
      .unwrap();
    assert_eq!(
      host.application_to_argv(&value).unwrap(),
      vec!["external", "--some-flag", ":literal"]
    );
  }

  #[test]
  fn tilde_follows_a_bash_home_assignment() {
    // Operator ruling 2026-10-06: `~` is $HOME as it stands (POSIX and the
    // macOS /bin/bash), not the home the shell started with.
    let map = tento_env::EnvMap::new();
    map.set("HOME", "/fixture/home");
    tento_env::with_env_map(map.clone(), || {
      let mut host = host();
      assert_eq!(host.eval_posix_line("args ~").unwrap(), serde_json::json!(["/fixture/home"]));
      host.eval_posix_line("HOME='foo bar'").unwrap();
      assert_eq!(host.eval_posix_line("args ~").unwrap(), serde_json::json!(["foo bar"]));
      assert_eq!(
        host.eval_posix_line("args $HOME").unwrap(),
        serde_json::json!(["foo", "bar"])
      );
      assert_eq!(map.get("HOME").as_deref(), Some("foo bar"));
    });
  }

  #[test]
  fn unset_splits_names_and_expanded_builtin_heads_use_the_same_helpers() {
    let mut host = host();
    host.eval_posix_line("first=one").unwrap();
    host.eval_posix_line("second=two").unwrap();
    host.eval_posix_line("names='first second'").unwrap();
    host.eval_posix_line("unset $names").unwrap();
    assert_eq!(
      host.eval_posix_line(r#"args "$first" "$second""#).unwrap(),
      serde_json::json!(["", ""])
    );
    host.eval_posix_line("cmd=unset").unwrap();
    host.eval_posix_line("$cmd names").unwrap();
    assert_eq!(
      host.eval_posix_line(r#"args "$names""#).unwrap(),
      serde_json::json!([""])
    );
    host.eval_posix_line("cmd=set").unwrap();
    host.eval_posix_line("$cmd -f").unwrap();
    host.eval_posix_line("$cmd +f").unwrap();
  }

  #[tokio::test]
  async fn expanded_heads_reach_external_async_and_concurrent_pipeline_dispatch_once() {
    let mut host = host();
    host.async_commands.borrow_mut().insert(
      "async.args".into(),
      Rc::new(|argv| Ok(Box::pin(async move { Ok(serde_json::json!(argv)) }))),
    );
    host.eval_posix_line("cmd=async.args").unwrap();
    assert_eq!(
      host.eval_posix_line_async("$cmd tail").await.unwrap(),
      serde_json::json!(["async.args", "tail"])
    );
    struct External(Rc<RefCell<Vec<Vec<Vec<String>>>>>);
    impl ExternalCommands for External {
      fn lookup(&self, _: &str) -> ExternalLookup {
        ExternalLookup::Runs
      }
      fn run(&self, argv: Vec<String>) -> AsyncCommandFut {
        Box::pin(async move { Ok(serde_json::json!(argv)) })
      }
      fn suggest(&self, _: &str) -> Option<String> {
        None
      }
      fn run_pipeline_with_io(
        &self,
        argv: Vec<Vec<String>>,
        _: Option<Vec<u8>>,
        _: bool,
        _: Vec<Option<ShellIo>>,
      ) -> PipelineFuture {
        self.0.borrow_mut().push(argv);
        Box::pin(async {
          Ok(ShellCapture {
            stdout: b"pipeline\n".to_vec(),
            status: 0,
            statuses: Vec::new(),
            start_errors: vec![],
          })
        })
      }
    }
    let pipelines = Rc::new(RefCell::new(Vec::new()));
    host.set_external_commands(Rc::new(External(pipelines.clone())));
    host.eval_posix_line("cmd=outside").unwrap();
    assert_eq!(
      host.eval_posix_line_async("$cmd ':tail'").await.unwrap(),
      serde_json::json!(["outside", ":tail"])
    );
    let calls = Rc::new(std::cell::Cell::new(0));
    let count = calls.clone();
    host.register_native_special("choose", move |_| {
      count.set(count.get() + 1);
      Ok(LispValue::String("outside".into()))
    });
    let captured = host
      .capture_shell_source("$(choose) first | $cmd second | echo end")
      .await
      .unwrap();
    assert_eq!(captured.status, 0);
    assert_eq!(calls.get(), 1);
    assert_eq!(
      *pipelines.borrow(),
      vec![vec![
        vec!["outside".to_string(), "first".into()],
        vec!["outside".into(), "second".into()]
      ]]
    );
  }

  #[test]
  fn expanded_command_heads_dispatch_after_splitting_and_pathname_expansion() {
    use futures::executor::block_on;
    let mut host = host();
    host.eval_posix_line("cmd='args first'").unwrap();
    assert_eq!(
      host.eval_posix_line("$cmd last").unwrap(),
      serde_json::json!(["first", "last"])
    );
    host.eval_posix_line("cmd=args").unwrap();
    assert_eq!(
      block_on(host.eval_posix_line_async(r#""$cmd" last"#)).unwrap(),
      serde_json::json!(["last"])
    );
    assert_eq!(
      block_on(host.eval_posix_line_async("$(echo args) last")).unwrap(),
      serde_json::json!(["last"])
    );
    host.eval_posix_line("cmd=true").unwrap();
    block_on(host.eval_posix_line_async("$cmd")).unwrap();
    assert_eq!(host.shell_status(), 0);
    let tree = GlobTree::new();
    for name in ["a.txt", "b.txt", "c.txt"] {
      host.register_native_special(&tree.pattern(name), |args| {
        Ok(LispValue::List(tento_lisp::List { items: args.into() }))
      });
    }
    assert_eq!(
      host
        .eval_posix_line(&format!("{} tail", tree.pattern("[abc].txt")))
        .unwrap(),
      serde_json::json!([tree.pattern("b.txt"), tree.pattern("c.txt"), "tail"])
    );
  }

  #[cfg(unix)]
  #[test]
  fn pathname_non_utf8_matches_fail_loudly() {
    use std::os::unix::ffi::OsStringExt;
    let tree = GlobTree::new();
    let name = std::ffi::OsString::from_vec(vec![b'b', b'a', b'd', 0xff]);
    if let Err(error) = std::fs::write(tree.0.join(name), "") {
      if filename_encoding_refused(&error) {
        eprintln!("skipping non-UTF-8 filename: filesystem refuses it: {error}");
        return;
      }
      panic!("creating non-UTF-8 fixture: {error}");
    }
    assert!(matches!(pathname_matches(&tree.pattern("bad*")),
      Err(RuntimeError::Command { detail }) if detail.contains("not UTF-8")));
  }

  #[test]
  fn pathname_all_c_locale_classes_ranges_and_backslashes() {
    for (class, yes, no) in [
      ("alnum", b'4', b'_'),
      ("alpha", b'z', b'4'),
      ("blank", b'\t', b'\n'),
      ("cntrl", 0x7f, b' '),
      ("digit", b'4', b'z'),
      ("graph", b'_', b' '),
      ("lower", b'z', b'Z'),
      ("print", b' ', 0x7f),
      ("punct", b'_', b'4'),
      ("space", 0x0b, b'z'),
      ("upper", b'Z', b'z'),
      ("xdigit", b'F', b'G'),
    ] {
      let tokens = compile_component(format!("[[:{class}:]]").as_bytes());
      assert!(component_matches(&tokens, &[yes]), "{class}");
      assert!(!component_matches(&tokens, &[no]), "{class}");
    }
    assert!(!component_matches(&compile_component(b"[z-a]"), b"m"));
    assert!(component_matches(&compile_component(b"[a-]"), b"-"));
    assert!(component_matches(
      &compile_component(br"*\*.txt"),
      b"literal*.txt"
    ));
    assert!(!component_matches(
      &compile_component(br"*\*.txt"),
      b"literal.txt"
    ));
    assert!(component_matches(
      &compile_component(br"*\\*.txt"),
      br"literal\a.txt"
    ));
  }

  #[test]
  fn pathname_brackets_keep_invalid_patterns_and_escaped_literals() {
    for (pattern, name, expected) in [
      ("[]", "[]", true),
      ("[bin", "[bin", true),
      ("[!bin", "[!bin", true),
      ("[]z]", "]", true),
      ("[[z]", "[", true),
      (r"[\[z]", "[", true),
      (r"[\]z]", "]", true),
      ("[^[z]", "[", false),
      ("[^]z]", "]", false),
      (r"[[:punct\:]]", "-", true),
      ("*", "a/b", false),
    ] {
      assert_eq!(
        component_matches(&compile_component(pattern.as_bytes()), name.as_bytes()),
        expected,
        "{pattern} {name}"
      );
    }
  }

  #[test]
  fn bash_pathname_quote_matrix_and_splitting_preserve_patterns() {
    let tree = GlobTree::new();
    let mut host = host();
    let prefix = tree.0.display();
    let files: Vec<_> = [
      "a.txt",
      "b.txt",
      "backslash\\a.txt",
      "c.txt",
      "space name.txt",
    ]
    .into_iter()
    .map(|n| tree.pattern(n))
    .collect();
    for suffix in ["*.txt", "[abc].txt", "?.txt"] {
      let expected = if suffix == "*.txt" {
        files.clone()
      } else {
        ["a.txt", "b.txt", "c.txt"]
          .into_iter()
          .map(|n| tree.pattern(n))
          .collect()
      };
      assert_eq!(
        host
          .eval_posix_line(&format!("args {prefix}/{suffix}"))
          .unwrap(),
        serde_json::json!(expected)
      );
    }
    for suffix in [r#""*.txt""#, r"\*.txt", "'*.txt'", "$'*.txt'"] {
      assert_eq!(
        host
          .eval_posix_line(&format!("args {prefix}/{suffix}"))
          .unwrap(),
        serde_json::json!([tree.pattern("*.txt")])
      );
    }
    host
      .eval_posix_line(&format!("x='{prefix}/*.txt'"))
      .unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!(files)
    );
    assert_eq!(
      host.eval_posix_line(r#"args "$x""#).unwrap(),
      serde_json::json!([tree.pattern("*.txt")])
    );
    assert_eq!(
      host
        .eval_posix_line(&format!(r#"args {prefix}/pre*"mid"?"#))
        .unwrap(),
      serde_json::json!([tree.pattern("pre*midZ"), tree.pattern("premidZ")])
    );
    assert_eq!(
      host
        .eval_posix_line(&format!(r#"args {prefix}/pre"*"mid?"#))
        .unwrap(),
      serde_json::json!([tree.pattern("pre*midZ")])
    );
    assert_eq!(
      host
        .eval_posix_line(&format!("args {prefix}/missing*"))
        .unwrap(),
      serde_json::json!([tree.pattern("missing*")])
    );
    host
      .eval_posix_line(&format!("x='{prefix}/a*.txt {prefix}/b*.txt'"))
      .unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!([
        tree.pattern("a.txt"),
        tree.pattern("b.txt"),
        tree.pattern("backslash\\a.txt")
      ])
    );
    host.eval_posix_line("saved=*").unwrap();
    assert_eq!(
      host.eval_posix_line(r#"args "$saved""#).unwrap(),
      serde_json::json!(["*"])
    );
    assert_eq!(
      host.eval_to_json(r#"(args "*")"#).unwrap(),
      serde_json::json!(["*"])
    );
    host.eval_posix_line(&format!("x='{prefix}/*\\*'")).unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!([tree.pattern("literal*")])
    );
    host
      .eval_posix_line(&format!("x='{prefix}/missing\\*'"))
      .unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!([tree.pattern(r"missing\*")])
    );
  }

  #[test]
  fn bash_pathname_substitution_noglob_and_host_isolation() {
    let tree = GlobTree::new();
    let mut first = host();
    first.register_native_special("pattern", move |_| Ok(LispValue::String("?.txt\n".into())));
    assert_eq!(
      first
        .eval_posix_line(&format!("args {}/$(pattern)", tree.0.display()))
        .unwrap(),
      serde_json::json!([
        tree.pattern("a.txt"),
        tree.pattern("b.txt"),
        tree.pattern("c.txt")
      ])
    );
    assert_eq!(
      first
        .eval_posix_line(&format!(r#"args {}/"$(pattern)""#, tree.0.display()))
        .unwrap(),
      serde_json::json!([tree.pattern("?.txt")])
    );
    for off in ["set -f", "set -o noglob"] {
      first.eval_posix_line(off).unwrap();
      assert_eq!(
        first
          .eval_posix_line(&format!("args {}", tree.pattern("?.txt")))
          .unwrap(),
        serde_json::json!([tree.pattern("?.txt")])
      );
      let mut second = host();
      assert_eq!(
        second
          .eval_posix_line(&format!("args {}", tree.pattern("?.txt")))
          .unwrap(),
        serde_json::json!([
          tree.pattern("a.txt"),
          tree.pattern("b.txt"),
          tree.pattern("c.txt")
        ])
      );
      first.eval_posix_line("set +f").unwrap();
      assert_eq!(
        first
          .eval_posix_line(&format!("args {}", tree.pattern("?.txt")))
          .unwrap(),
        serde_json::json!([
          tree.pattern("a.txt"),
          tree.pattern("b.txt"),
          tree.pattern("c.txt")
        ])
      );
    }
  }

  #[tokio::test]
  async fn fixes_redirect_globs_keep_shell_prefix_and_status() {
    let tree = GlobTree::new();
    let mut host = host();
    host.set_shell_file_opener(Rc::new(|_, _, _| panic!("ambiguous redirect must not open")));
    for glob in ["*.txt", "?.txt"] {
      host.collect_shell_diagnostics();
      let target = tree.pattern(glob);
      let result = host.capture_shell_source(&format!("echo must-not-run >{target}; echo $?")).await.unwrap();
      assert_eq!(result.stdout, b"1\n");
      assert_eq!(host.take_shell_diagnostics(), vec![format!("tsh: line 1: {target}: ambiguous redirect")]);
    }
  }

  #[tokio::test]
  async fn bash_redirect_glob_ambiguity_sets_status_one_before_any_effect() {
    let tree = GlobTree::new();
    let mut host = host();
    let calls = Rc::new(std::cell::Cell::new(0));
    let observed = calls.clone();
    host.register_native_special("effect", move |_| {
      observed.set(observed.get() + 1);
      Ok(LispValue::Nil)
    });
    host.set_shell_file_opener(Rc::new(|_, _, _| {
      panic!("ambiguous redirect must not open a file")
    }));
    host.collect_shell_diagnostics();
    let result = host
      .capture_shell_source(&format!("effect >{}", tree.pattern("?.txt")))
      .await
      .unwrap();
    assert_eq!(result.status, 1);
    assert_eq!(calls.get(), 0);
    assert!(
      host
        .take_shell_diagnostics()
        .iter()
        .any(|s| s.contains("ambiguous redirect"))
    );
    for name in ["a.txt", "b.txt", "c.txt"] {
      assert_eq!(std::fs::read(tree.0.join(name)).unwrap(), b"");
    }
  }

  #[tokio::test]
  async fn bash_noglob_changes_apply_in_execution_order_in_lists_and_units() {
    let tree = GlobTree::new();
    let mut host = host();
    let seen = Rc::new(RefCell::new(Vec::new()));
    let observed = seen.clone();
    host.register_native_special("observe", move |args| {
      observed.borrow_mut().push(args.len());
      Ok(LispValue::Nil)
    });
    let pattern = tree.pattern("?.txt");
    let result = host
      .capture_shell_source(&format!(
        "observe {pattern}; set -f; observe {pattern}; set +f; observe {pattern}"
      ))
      .await
      .unwrap();
    assert_eq!(result.status, 0);
    assert_eq!(*seen.borrow(), vec![3, 1, 3]);
    host.capture_shell_source("set -o noglob").await.unwrap();
    host
      .capture_shell_source(&format!("observe {pattern}"))
      .await
      .unwrap();
    assert_eq!(*seen.borrow(), vec![3, 1, 3, 1]);
  }

  #[test]
  fn redirect_pathnames_share_globbing_quotes_and_noglob() {
    let tree = GlobTree::new();
    let mut host = host();
    let part = |text: String, glob: bool| {
      LispValue::List(tento_lisp::List {
        items: vec![
          LispValue::Boolean(false),
          LispValue::String(text.into()),
          LispValue::Boolean(glob),
        ].into(),
      })
    };
    let eval = |host: &mut LispHost, text: String, glob: bool| {
      let symbol = host
        .interp
        .string_interner()
        .get_or_intern("std.sh.redirect-word");
      let function = host.env.borrow().get(symbol).unwrap();
      let LispValue::Function(Function::NativeClosure(f)) = function else {
        panic!("redirect native")
      };
      f(
        host.env.clone(),
        vec![
          LispValue::List(tento_lisp::List {
            items: vec![part(text, glob)].into(),
          }),
          LispValue::String("target".into()),
        ],
      )
    };
    assert!(matches!(eval(&mut host, tree.pattern("?.txt"), true),
      Err(RuntimeError::Command { detail }) if detail == "target: ambiguous redirect"));
    assert!(matches!(eval(&mut host, tree.pattern("a?.log"), true),
      Ok(LispValue::String(s)) if s == tree.pattern("a1.log")));
    assert!(matches!(eval(&mut host, tree.pattern("*.txt"), false),
      Ok(LispValue::String(s)) if s == tree.pattern("*.txt")));
    host.eval_posix_line("set -f").unwrap();
    assert!(matches!(eval(&mut host, tree.pattern("?.txt"), true),
      Ok(LispValue::String(s)) if s == tree.pattern("?.txt")));
  }

  #[test]
  fn sh_var_does_not_fall_back_to_launch_env_after_unset() {
    let mut host = host();
    let map = tento_env::EnvMap::from_process();
    map.remove("PATH");
    tento_env::with_env_map(map, || {
      assert_eq!(host.eval_to_json(r#"(std.sh.var "PATH")"#).unwrap(), "");
      assert_eq!(
        host.eval_to_json(r#"(std.sh.var "PATH" "absent")"#).unwrap(),
        "absent"
      );
    });
  }

  #[test]
  fn sh_var_prefers_bindings_then_environment_then_empty() {
    let mut host = host();
    // No process-wide env mutation: select a key already present in this process.
    let (name, value) = std::env::vars()
      .find(|(key, _)| {
        key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
          && !key.is_empty()
          && !key.as_bytes()[0].is_ascii_digit()
          && tento_env::effective_var(key).is_none()
      })
      .expect("test process has an environment variable");
    let query = format!("(std.sh.var {})", serde_json::to_string(&name).unwrap());
    assert_eq!(host.eval_to_json(&query).unwrap(), serde_json::json!(value));
    host
      .eval_stmt(&format!("(let {name} \"binding\")"))
      .unwrap();
    assert_eq!(host.eval_to_json(&query).unwrap(), "binding");
    host.eval_stmt(&format!("(let {name} \"\")")).unwrap();
    assert_eq!(host.eval_to_json(&query).unwrap(), "");
    assert_eq!(
      host
        .eval_to_json(r#"(std.sh.var "TSH_PHASE_04D_UNSET_6B34A59")"#)
        .unwrap(),
      ""
    );
    assert_eq!(
      host
        .eval_to_json(r#"(std.sh.var "TSH_PHASE_04D_UNSET_6B34A59" "fallback")"#)
        .unwrap(),
      "fallback"
    );
    assert_eq!(
      host
        .eval_to_json(r#"(let ((local "scope")) (std.sh.var "local"))"#)
        .unwrap(),
      "scope"
    );
  }

  #[test]
  fn sh_split_default_ifs_removes_implicit_empty_fields() {
    let mut host = host();
    host.eval_stmt(r#"(let IFS " \t\n")"#).unwrap();
    host.eval_posix_line("x=' c d '").unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!(["c", "d"])
    );
    assert_eq!(
      host.eval_posix_line(r#"args "a b"$x"#).unwrap(),
      serde_json::json!(["a b", "c", "d"])
    );
    host.eval_posix_line("x='c d'").unwrap();
    assert_eq!(
      host.eval_posix_line(r#"args "a b"$x"#).unwrap(),
      serde_json::json!(["a bc", "d"])
    );
    assert_eq!(
      host.eval_posix_line(r#"args "$x""#).unwrap(),
      serde_json::json!(["c d"])
    );
    host.eval_posix_line("x=' \t\n '").unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!([])
    );
    host.eval_posix_line("x=").unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!([])
    );
    assert_eq!(
      host.eval_posix_line(r#"args ""$x"#).unwrap(),
      serde_json::json!([""])
    );
    assert_eq!(
      host.eval_posix_line(r#"args "$x""#).unwrap(),
      serde_json::json!([""])
    );
  }

  #[test]
  fn split_parts_join_across_adjacent_expansions_and_protect_quoted_values() {
    let mut host = host();
    host.eval_posix_line("IFS=' '").unwrap();
    host.eval_posix_line("x='a '").unwrap();
    host.eval_posix_line("y=' b'").unwrap();
    assert_eq!(
      host.eval_posix_line("args $x$y").unwrap(),
      serde_json::json!(["a", "b"])
    );
    assert_eq!(
      host.eval_posix_line(r#"args $x"$y""#).unwrap(),
      serde_json::json!(["a", " b"])
    );
    assert_eq!(
      host.eval_posix_line(r#"args $x"""#).unwrap(),
      serde_json::json!(["a", ""])
    );
    host.eval_posix_line("IFS=:").unwrap();
    host.eval_posix_line("x='a:'").unwrap();
    host.eval_posix_line("y=':b'").unwrap();
    assert_eq!(
      host.eval_posix_line("args $x$y").unwrap(),
      serde_json::json!(["a", "", "b"])
    );
    assert_eq!(
      host.eval_posix_line(r#"args $x"""#).unwrap(),
      serde_json::json!(["a", ""])
    );
  }

  #[test]
  fn sh_split_custom_and_empty_ifs_preserve_bash_null_fields() {
    let mut host = host();
    host.eval_posix_line("IFS=': '").unwrap();
    host.eval_posix_line("x=' :a:: b: '").unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!(["", "a", "", "b"])
    );
    assert_eq!(
      host.eval_posix_line(r#"args "$x""#).unwrap(),
      serde_json::json!([" :a:: b: "])
    );
    host.eval_posix_line("IFS=").unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!([" :a:: b: "])
    );
    host.eval_posix_line("x=").unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!([])
    );
  }

  #[test]
  fn sh_split_empty_quotes_anchor_fields_on_each_side_of_delimiters() {
    let mut host = host();
    for (ifs, value, source, expected) in [
      (
        " ",
        " a ",
        r#"args ""$x"""#,
        serde_json::json!(["", "a", ""]),
      ),
      (" ", " ", r#"args ""$x"""#, serde_json::json!(["", ""])),
      (":", ":", "args $x", serde_json::json!([""])),
      (":", "::", "args $x", serde_json::json!(["", ""])),
      (":", "::", r#"args $x"""#, serde_json::json!(["", "", ""])),
      (
        ": ",
        " :a:: b: ",
        "args pre$x-post",
        serde_json::json!(["pre", "a", "", "b", "-post"]),
      ),
      (
        "界",
        "界a界界b界",
        "args $x",
        serde_json::json!(["", "a", "", "b"]),
      ),
    ] {
      host
        .define_lisp_scalar("IFS", HostValue::from_json(serde_json::json!(ifs)))
        .unwrap();
      host
        .define_lisp_scalar("x", HostValue::from_json(serde_json::json!(value)))
        .unwrap();
      assert_eq!(
        host.eval_posix_line(source).unwrap(),
        expected,
        "IFS={ifs:?}, x={value:?}, {source}"
      );
    }
  }

  #[test]
  fn command_substitution_strips_only_trailing_newlines_and_joins_once() {
    let mut host = host();
    let count = Rc::new(std::cell::Cell::new(0));
    let calls = count.clone();
    host.register_native_special("pick", move |_| {
      calls.set(calls.get() + 1);
      Ok(LispValue::String("a\nb \t\n\n".into()))
    });
    assert_eq!(
      host.eval_posix_line(r#"args "$(pick)z""#).unwrap(),
      serde_json::json!(["a\nb \tz"])
    );
    assert_eq!(count.get(), 1);
    assert_eq!(
      host.eval_posix_line(r#"args "`pick`z""#).unwrap(),
      serde_json::json!(["a\nb \tz"])
    );
    assert_eq!(count.get(), 2);
    host.eval_posix_line("x=$(pick)z").unwrap();
    assert_eq!(host.eval_to_json("x").unwrap(), "a\nb \tz");
    assert_eq!(count.get(), 3);
    host.register_native_special("quiet", |_| Ok(LispValue::Nil));
    assert_eq!(
      host.eval_posix_line(r#"args "$(quiet)""#).unwrap(),
      serde_json::json!([""])
    );
    assert_eq!(
      host.eval_posix_line("args $(quiet)").unwrap(),
      serde_json::json!([])
    );
  }

  #[test]
  fn expansion_runtime_handles_words_beyond_the_range_primitive_limit() {
    let mut host = host();
    let text = "a".repeat(65_537);
    host
      .define_lisp_scalar("large", HostValue::from_json(serde_json::json!(text)))
      .unwrap();
    assert_eq!(
      host.eval_posix_line("args $large").unwrap(),
      serde_json::json!([text])
    );
    // Bound, not written as a literal: a debug build's lexer recurses per
    // character, so a 65k-character token overflows its stack before the
    // runtime under test ever runs.
    host
      .define_lisp_scalar(
        "padded",
        HostValue::from_json(serde_json::json!("a".to_owned() + &"\n".repeat(65_537))),
      )
      .unwrap();
    assert_eq!(host.eval_to_json("(std.sh.sub padded)").unwrap(), "a");
  }

  #[test]
  fn expansion_runtime_handles_one_mib_words_and_one_hundred_thousand_fields() {
    let mut host = host();
    host.eval_stmt(r#"(let IFS " \t\n")"#).unwrap();
    let text = "界".repeat(349_525) + "a";
    assert_eq!(text.len(), 1_048_576);
    host
      .define_lisp_scalar("large", HostValue::from_json(serde_json::json!(text)))
      .unwrap();
    assert_eq!(
      host.eval_posix_line("args $large").unwrap(),
      serde_json::json!([text])
    );
    let text = "a ".repeat(100_000);
    host
      .define_lisp_scalar("fields", HostValue::from_json(serde_json::json!(text)))
      .unwrap();
    assert_eq!(
      host.eval_posix_line("args $fields").unwrap(),
      serde_json::json!(vec!["a"; 100_000])
    );
    let text = "a".to_owned() + &"\n".repeat(1_048_576);
    host
      .define_lisp_scalar("output", HostValue::from_json(serde_json::json!(text)))
      .unwrap();
    assert_eq!(host.eval_to_json("(std.sh.sub output)").unwrap(), "a");
  }

  #[test]
  fn native_bash_word_runtime_constructs_and_splits_words() {
    let mut host = host();
    host.register_native_special("echo", |args| {
      let text = args
        .into_iter()
        .map(scalar_text)
        .collect::<Result<Vec<_>, _>>()
        .map_err(runtime_host_error)?;
      Ok(LispValue::String(text.join(" ").into()))
    });
    host.eval_posix_line("x='c d'").unwrap();
    host.eval_posix_line("IFS=' '").unwrap();
    host.register_native_special("collect", |args| {
      Ok(LispValue::List(tento_lisp::List { items: args.into() }))
    });
    assert_eq!(
      host.eval_posix_line(r#"collect "a b"$x"#).unwrap(),
      serde_json::json!(["a bc", "d"])
    );
    assert_eq!(host.eval_posix_line(r#"echo "a $x b""#).unwrap(), "a c d b");
    assert_eq!(host.eval_posix_line("echo $(echo hi)x").unwrap(), "hix");
    host.eval_posix_line("x=").unwrap();
    assert_eq!(host.eval_posix_line(r#"echo "$x""#).unwrap(), "");
    assert_eq!(host.eval_posix_line("echo $x").unwrap(), "");
  }

  #[test]
  fn sh_split_reads_ifs_from_the_expansion_scope_each_time() {
    let mut host = host();
    host.eval_posix_line("x='a:b c'").unwrap();
    host.eval_posix_line("IFS=:").unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!(["a", "b c"])
    );
    host.eval_posix_line("IFS=' '").unwrap();
    assert_eq!(
      host.eval_posix_line("args $x").unwrap(),
      serde_json::json!(["a:b", "c"])
    );
    assert_eq!(
      host
        .eval_to_json(r#"(let ((IFS ":")) (std.sh.split (list (list true "a:b c"))))"#)
        .unwrap(),
      serde_json::json!(["a", "b c"])
    );
  }

  #[test]
  fn bound_null_is_one_typed_argument_even_under_nounset() {
    let mut host = host();
    host.define_lisp_scalar("typed", HostValue::from_json(serde_json::Value::Null)).unwrap();
    host.eval_posix_line("set -u").unwrap();
    assert_eq!(host.eval_posix_line("args $typed").unwrap(), serde_json::json!([null]));
  }

  #[test]
  fn whole_unquoted_values_pass_through_and_structured_joins_refuse() {
    let mut host = host();
    for value in [
      serde_json::json!({"id": "first"}),
      serde_json::json!([1, "two"]),
      serde_json::json!(7),
      serde_json::json!(false),
      serde_json::Value::Null,
    ] {
      host
        .define_lisp_scalar("typed", HostValue::from_json(value.clone()))
        .unwrap();
      assert_eq!(
        host.eval_posix_line("args $typed").unwrap(),
        serde_json::json!([value])
      );
    }
    host.register_native_special("record", |_| {
      Ok(json_to_lisp(&serde_json::json!({"id": "first"})))
    });
    assert_eq!(
      host.eval_posix_line("args $(record)").unwrap(),
      serde_json::json!([{"id": "first"}])
    );
    host.eval_posix_line("saved=$(record)").unwrap();
    assert_eq!(
      host.eval_posix_line("args $saved").unwrap(),
      serde_json::json!([{"id": "first"}])
    );
    for source in [
      "args pre$saved",
      "args $saved$saved",
      r#"args ""$saved"#,
      r#"args "$saved""#,
      "args $(record)tail",
      "saved=$(record)tail",
    ] {
      let err = host.eval_posix_line(source).unwrap_err();
      assert!(err.to_string().contains("scalar"), "{source}: {err}");
      assert!(err.to_string().contains("Map"), "{source}: {err}");
    }
  }

  #[test]
  fn embedder_sources_work_without_loading_a_prelude() {
    let mut host = host();
    host.eval_posix_line("captured=plain/path").unwrap();
    // A Lisp stdlib function is not a bash command: the commands here are
    // natives the embedder registers.
    host.register_native_special("joined", |args| {
      let parts = args.into_iter().map(scalar_text).collect::<Result<String, _>>().map_err(runtime_host_error)?;
      Ok(LispValue::String(parts.into()))
    });
    assert_eq!(
      host
        .eval_posix_line("joined $captured '|' '~/literal'")
        .unwrap(),
      "plain/path|~/literal"
    );
    host.register_native_special("getfield", |args| match args.as_slice() {
      [LispValue::Map(map), LispValue::String(key)] => map
        .get(key.as_str())
        .cloned()
        .ok_or_else(|| LispHostError::Runtime(format!("getfield: no `{key}`"))),
      _ => Err(LispHostError::Runtime("getfield: expected MAP KEY".into())),
    });
    host.register_native_special("link", |args| {
      Ok(LispValue::List(tento_lisp::List { items: args.into() }))
    });
    host
      .define_lisp_scalar(
        "prev",
        HostValue::from_json(serde_json::json!({"id": {"nested": [1, 2]}})),
      )
      .unwrap();
    assert_eq!(
      host
        .eval_posix_line("    link --parent $(getfield $prev id) --label first")
        .unwrap(),
      // A1: option words reach the native as written.
      serde_json::json!(["--parent", {"nested": [1, 2]}, "--label", "first"])
    );
  }

  #[test]
  fn sh_sub_preserves_internal_newlines_cr_and_non_string_values() {
    let mut host = host();
    assert_eq!(
      host.eval_to_json(r#"(std.sh.sub "a\nb\r\n\n")"#).unwrap(),
      "a\nb\r"
    );
    host
      .define_lisp_scalar("typed", HostValue::from_json(serde_json::json!({"id": 1})))
      .unwrap();
    assert_eq!(
      host.eval_to_json("(std.sh.sub typed)").unwrap(),
      serde_json::json!({"id": 1})
    );
    assert_eq!(host.eval_to_json("(std.sh.sub 7)").unwrap(), 7);
    assert_eq!(host.eval_to_json("(std.sh.sub nil)").unwrap(), "");
  }

  #[test]
  fn bash_expansion_natives_reject_invalid_arguments() {
    let mut host = host();
    for source in [
      "(std.sh.split)",
      "(std.sh.split (list) (list))",
      "(std.sh.split 1)",
      "(std.sh.split (list 1))",
      "(std.sh.split (list (list true)))",
      r#"(std.sh.split (list (list 1 "x")))"#,
      "(std.sh.sub)",
      r#"(std.sh.sub "a" "b")"#,
    ] {
      assert!(host.eval_to_json(source).is_err(), "{source}");
    }
  }

  #[tokio::test]
  async fn glob_words_reach_external_and_async_dispatch_as_argv() {
    let tree = GlobTree::new();
    let mut host = host();
    host.async_commands.borrow_mut().insert(
      "async.args".into(),
      Rc::new(|argv| Ok(Box::pin(async move { Ok(serde_json::json!(argv)) }))),
    );
    let files = [
      tree.pattern("a.txt"),
      tree.pattern("b.txt"),
      tree.pattern("c.txt"),
    ];
    assert_eq!(
      host
        .eval_posix_line_async(&format!("async.args {}", tree.pattern("?.txt")))
        .await
        .unwrap(),
      serde_json::json!(["async.args", files[0], files[1], files[2]])
    );
    struct External;
    impl ExternalCommands for External {
      fn lookup(&self, _: &str) -> ExternalLookup {
        ExternalLookup::Runs
      }
      fn run(&self, argv: Vec<String>) -> AsyncCommandFut {
        Box::pin(async move { Ok(serde_json::json!(argv)) })
      }
      fn suggest(&self, _: &str) -> Option<String> {
        None
      }
    }
    host.set_external_commands(Rc::new(External));
    assert_eq!(
      host
        .eval_posix_line_async(&format!("outside {}", tree.pattern("?.txt")))
        .await
        .unwrap(),
      serde_json::json!(["outside", files[0], files[1], files[2]])
    );
  }

  #[tokio::test]
  async fn split_words_reach_external_and_async_dispatch_as_argv() {
    let mut host = host();
    host.eval_posix_line("x='a b'").unwrap();
    host.async_commands.borrow_mut().insert(
      "async.args".into(),
      Rc::new(|argv| Ok(Box::pin(async move { Ok(serde_json::json!(argv)) }))),
    );
    assert_eq!(
      host
        .eval_posix_line_async(r#"async.args pre$x "tail""#)
        .await
        .unwrap(),
      serde_json::json!(["async.args", "prea", "b", "tail"])
    );
    struct External;
    impl ExternalCommands for External {
      fn lookup(&self, _: &str) -> ExternalLookup {
        ExternalLookup::Runs
      }
      fn run(&self, argv: Vec<String>) -> AsyncCommandFut {
        Box::pin(async move { Ok(serde_json::json!(argv)) })
      }
      fn suggest(&self, _: &str) -> Option<String> {
        None
      }
    }
    host.set_external_commands(Rc::new(External));
    assert_eq!(
      host.eval_posix_line_async("outside pre$x").await.unwrap(),
      serde_json::json!(["outside", "prea", "b"])
    );
  }
}

#[cfg(test)]
mod corpus_collation_tests {
  use super::*;

  fn reference_bash() -> std::process::Command {
    let path = if cfg!(target_os = "macos") { "/opt/homebrew/bin/bash" } else { "bash" };
    let version = std::process::Command::new(path).arg("--version").output().unwrap();
    assert!(version.status.success());
    // Both patch releases are installed on the fleet. Keep the behavior
    // comparison below; a newer patch must still match the same contract.
    let reference_version = String::from_utf8_lossy(&version.stdout);
    assert!(
      ["GNU bash, version 5.3.9(", "GNU bash, version 5.3.20("]
        .iter()
        .any(|prefix| reference_version.starts_with(prefix)),
      "unsupported Bash reference: {reference_version}"
    );
    let mut command = std::process::Command::new(path);
    command.args(["--noprofile", "--norc"]).env_remove("BASH_ENV")
      .env("LC_ALL", "").env("LC_COLLATE", "").env("LC_CTYPE", "").env("LANG", "C");
    command
  }

  #[test]
  fn fixes_collation_uses_explicit_ctype_and_independent_locale_categories() {
    let tree = tests::GlobTree::new();
    for name in ["a-b", "a_b", "A", "é"] {
      std::fs::write(tree.0.join(name), b"").unwrap();
    }
    for (collate, ctype) in [("en_US.UTF-8", "C"), ("en_US.UTF-8", "en_US.UTF-8"), ("C", "en_US.UTF-8")] {
      let mut names = pathname_matches(&tree.pattern("*")).unwrap();
      sort_pathnames_with_ctype(collate, ctype, &mut names);
      let expected = reference_bash().args(["-c", "printf '%s\\n' \"$1\"/*", "bash"])
        .arg(&tree.0).env("LC_COLLATE", collate).env("LC_CTYPE", ctype)
        .output().unwrap();
      assert!(expected.status.success(), "{collate}/{ctype}: {:?}", expected.stderr);
      let expected: Vec<_> = String::from_utf8(expected.stdout).unwrap()
        .lines().map(str::to_string).collect();
      assert_eq!(names, expected, "{collate}/{ctype}");
    }
  }

  #[test]
  fn corpus_collation_matches_host_bash_and_falls_back_to_bytes() {
    let tree = tests::GlobTree::new();
    for name in ["a-b", "a_b", "A", "a", "z", "é"] {
      std::fs::write(tree.0.join(name), b"").unwrap();
    }
    for locale in ["C", "POSIX", "", "en_US.UTF-8", "no-such-04uv2-locale"] {
      let mut empty = Vec::new();
      sort_pathnames(locale, &mut empty);
      assert!(empty.is_empty());
      let mut single = vec!["a-b".to_string()];
      sort_pathnames(locale, &mut single);
      assert_eq!(single, ["a-b"]);
      let mut names = pathname_matches(&tree.pattern("*")).unwrap();
      sort_pathnames(locale, &mut names);
      let expected = reference_bash()
        .args(["-c", "printf '%s\\n' \"$1\"/*", "bash"])
        .arg(&tree.0)
        .env("LC_ALL", locale).env("LC_COLLATE", "").env("LANG", "C")
        .output().unwrap();
      assert!(expected.status.success());
      let expected: Vec<_> = String::from_utf8(expected.stdout).unwrap()
        .lines().map(str::to_string).collect();
      assert_eq!(names, expected, "{locale}");
    }
  }

  #[tokio::test]
  async fn corpus_collation_reads_shell_bindings_and_locale_precedence() {
    let tree = tests::GlobTree::new();
    for name in ["a-b.txt", "a_b.txt", "A.txt", "é.txt"] {
      std::fs::write(tree.0.join(name), b"").unwrap();
    }
    for startup in ["C", "en_US.UTF-8"] {
      for bindings in [
        "LC_ALL=''; LC_COLLATE=en_US.UTF-8; LANG=C",
        "LC_ALL=en_US.UTF-8; LC_COLLATE=C; LANG=C",
        "LC_ALL=C; LC_COLLATE=en_US.UTF-8; LANG=en_US.UTF-8",
        "LC_ALL=''; LC_COLLATE=''; LANG=en_US.UTF-8",
        "LC_ALL=''; LC_COLLATE=no-such-04uv2-locale; LANG=en_US.UTF-8",
        "LC_ALL=''; LC_COLLATE=en_US.UTF-8; LC_CTYPE=C; LANG=en_US.UTF-8",
        "LC_ALL=''; LC_COLLATE=C; LC_CTYPE=en_US.UTF-8; LANG=C",
      ] {
        let mut host = tests::host();
        host.eval_posix_line(&format!("LC_ALL=''; LC_COLLATE=''; LC_CTYPE=''; LANG={startup}")).unwrap();
        let source = format!("{bindings}; echo {}", tree.pattern("*.txt"));
        let result = host.capture_shell_source(&source).await.unwrap();
        // In-shell assignments change categories separately; setting LC_ALL
        // in the process environment is a different oracle on macOS.
        let expected = reference_bash()
          .args(["-c", &format!("{bindings}; echo \"$1\"/*.txt"), "bash"])
          .arg(&tree.0).env("LANG", startup).output().unwrap();
        assert!(expected.status.success(), "{startup}: {bindings}: {:?}", expected.stderr);
        assert_eq!(result.status, 0, "{startup}: {bindings}");
        assert_eq!(result.stdout, expected.stdout, "{startup}: {bindings}");
        assert!(host.take_shell_diagnostics().is_empty());
      }
    }
    // A missing locale falls back to bytes from a fresh C-locale host.
    let mut host = tests::host();
    let bindings = "LC_ALL=''; LC_COLLATE=no-such-04uv2-locale; LC_CTYPE=C; LANG=C";
    let source = format!("{bindings}; echo {}", tree.pattern("*.txt"));
    let result = host.capture_shell_source(&source).await.unwrap();
    let expected = reference_bash()
      .args(["-c", &format!("{bindings}; echo \"$1\"/*.txt"), "bash"])
      .arg(&tree.0).output().unwrap();
    assert!(expected.status.success());
    assert_eq!(result.status, 0);
    assert_eq!(result.stdout, expected.stdout);
  }
}
