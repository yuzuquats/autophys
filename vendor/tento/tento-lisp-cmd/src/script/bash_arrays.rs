//! Indexed arrays are shell data in the scoped environment, never Lisp list semantics.
use super::interp::{LispHost, LispHostError, Sym};
use super::runner::TshScriptErrorKind;
use std::collections::BTreeMap;
use std::rc::Rc;
use tento_lisp::{Env, Function, List, NativeClosure, RuntimeError, Value as LispValue};

const TAG: &str = "std.sh.indexed-array/v1";

#[derive(Clone, Copy, Default)]
pub(super) struct VarAttributes {
  pub indexed: bool,
  pub associative: bool,
  pub integer: bool,
  pub readonly: bool,
  pub exported: bool,
  /// `declare -l` / `-u`: every assignment is case-converted (bash keeps
  /// at most one of them).
  pub lower: bool,
  pub upper: bool,
  /// `declare -n`: the value is the name of the variable it refers to.
  pub nameref: bool,
  /// `declare -t`: recorded and printed; tsh has no DEBUG/RETURN tracing
  /// that would read it.
  pub trace: bool,
}

const ASSOC: &str = "std.sh.associative-array/v1";
pub(super) fn associative_entries(value: &LispValue<Sym>) -> Option<BTreeMap<String, String>> {
  let LispValue::List(list) = value else {
    return None;
  };
  if !matches!(list.items.first(), Some(LispValue::String(tag)) if tag == ASSOC) {
    return None;
  }
  let mut result = BTreeMap::new();
  for item in list.items.iter().skip(1) {
    if let LispValue::List(pair) = item {
      if let [LispValue::String(key), LispValue::String(value)] = pair.items.as_slice() {
        result.insert(key.to_string(), value.to_string());
      }
    }
  }
  Some(result)
}
pub(super) fn associative_value(entries: BTreeMap<String, String>) -> LispValue<Sym> {
  let mut items = vec![LispValue::String(ASSOC.into())];
  items.extend(entries.into_iter().map(|(key, value)| {
    LispValue::List(List {
      items: vec![LispValue::String(key.into()), LispValue::String(value.into())].into(),
    })
  }));
  LispValue::List(List { items: items.into() })
}

pub(super) fn entries(value: &LispValue<Sym>) -> Option<BTreeMap<i64, String>> {
  let LispValue::List(list) = value else {
    return None;
  };
  if !matches!(list.items.first(), Some(LispValue::String(tag)) if tag == TAG) {
    return None;
  }
  let mut result = BTreeMap::new();
  for item in list.items.iter().skip(1) {
    if let LispValue::List(pair) = item {
      if let [LispValue::Integer(index), LispValue::String(value)] = pair.items.as_slice() {
        result.insert(*index, value.to_string());
      }
    }
  }
  Some(result)
}

pub(super) fn value(entries: BTreeMap<i64, String>) -> LispValue<Sym> {
  let mut items = vec![LispValue::String(TAG.into())];
  items.extend(entries.into_iter().map(|(index, value)| {
    LispValue::List(List {
      items: vec![LispValue::Integer(index), LispValue::String(value.into())].into(),
    })
  }));
  LispValue::List(List { items: items.into() })
}

pub(super) fn scalar(value: LispValue<Sym>) -> LispValue<Sym> {
  if let Some(entries) = associative_entries(&value) {
    return LispValue::String(entries.get("0").cloned().unwrap_or_default().into());
  }
  entries(&value).map_or(value, |entries| {
    LispValue::String(entries.get(&0).cloned().unwrap_or_default().into())
  })
}

fn index(raw: &str, entries: &BTreeMap<i64, String>) -> Result<i64, RuntimeError> {
  let index = raw.parse::<i64>().map_err(|_| RuntimeError::Command {
    detail: "array: invalid subscript".into(),
  })?;
  let index = if index < 0 {
    entries.last_key_value().map_or(0, |(n, _)| n + 1) + index
  } else {
    index
  };
  if index < 0 {
    return Err(RuntimeError::Command {
      detail: "array: bad array subscript".into(),
    });
  }
  Ok(index)
}

impl LispHost {
  pub(super) fn set_pipeline_statuses(&mut self, statuses: &[i32]) {
    self.shell_compound.pipeline_status_known.set(true);
    let symbol = self.interp.string_interner().get_or_intern("PIPESTATUS");
    self.env.borrow_mut().define(
      symbol,
      value(
        statuses
          .iter()
          .enumerate()
          .map(|(i, status)| (i as i64, status.to_string()))
          .collect(),
      ),
    );
  }

  pub(super) fn register_bash_array_natives(&mut self, lookup: NativeClosure<Sym>) {
    let names = self.shell_symbols.clone();
    let nounset = self.shell_compound.commands.nounset.clone();
    let known = self.shell_compound.pipeline_status_known.clone();
    let array_lookup = lookup.clone();
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let status_127 = self.shell_compound.commands.expansion_failure_127.clone();
    let array: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [
        LispValue::String(name),
        subscript,
        LispValue::Boolean(length),
      ] = args.as_slice()
      else {
        return Err(RuntimeError::Other(
          "std.sh.array-get: expected NAME INDEX LENGTH".into(),
        ));
      };
      if name == "PIPESTATUS" && !known.get() {
        return Err(RuntimeError::Command {
          detail: "PIPESTATUS: external host did not return stage statuses".into(),
        });
      }
      let bound = names
        .borrow()
        .get(name.as_str())
        .and_then(|symbol| env.borrow().get(*symbol));
      if let Some(entries) = bound.as_ref().and_then(associative_entries) {
        let subscript = match subscript {
          LispValue::String(s) => s.clone(),
          LispValue::Integer(n) => n.to_string().into(),
          _ => {
            return Err(RuntimeError::Command {
              detail: "array: invalid subscript".into(),
            });
          }
        };
        if matches!(subscript.as_str(), "@" | "*" | "*fields" | "@word") {
          if *length {
            return Ok(LispValue::String(entries.len().to_string().into()));
          }
          let values: Vec<_> = entries.into_values().collect();
          if subscript == "@" || subscript == "*fields" {
            return Ok(LispValue::List(List {
              items: values.into_iter().map(|value| LispValue::String(value.into())).collect(),
            }));
          }
          let ifs = array_lookup(
            env,
            vec![
              LispValue::String("IFS".into()),
              LispValue::String(" ".into()),
            ],
          )?;
          let separator = if let LispValue::String(ifs) = ifs {
            ifs
              .chars()
              .next()
              .map(|c| c.to_string())
              .unwrap_or_default()
          } else {
            " ".into()
          };
          return Ok(LispValue::String(values.join(&separator).into()));
        }
        if subscript.is_empty() {
          return Err(RuntimeError::Command {
            detail: format!("{name}: bad array subscript"),
          });
        }
        let value = entries.get(subscript.as_str());
        if value.is_none() && nounset.get() {
          return Err(unbound_fatal(&failure, &status_127, format!("{name}[{subscript}]: unbound variable")));
        }
        let text = value.cloned().unwrap_or_default();
        return Ok(LispValue::String(if *length {
          text.len().to_string().into()
        } else {
          text.into()
        }));
      }
      let entries = bound
        .as_ref()
        .and_then(entries)
        .unwrap_or_else(|| match bound {
          Some(LispValue::String(value)) => BTreeMap::from([(0, value.into_string())]),
          _ => BTreeMap::new(),
        });
      let subscript = match subscript {
        LispValue::String(value) => value.clone(),
        LispValue::Integer(value) => value.to_string().into(),
        _ => {
          return Err(RuntimeError::Command {
            detail: "array: invalid subscript".into(),
          });
        }
      };
      if matches!(subscript.as_str(), "@" | "@word" | "*" | "*fields") {
        if *length {
          return Ok(LispValue::String(entries.len().to_string().into()));
        }
        if subscript == "@word" {
          return Ok(LispValue::String(
            entries.into_values().collect::<Vec<_>>().join(" ").into(),
          ));
        }
        let ifs = array_lookup(
          env,
          vec![
            LispValue::String("IFS".into()),
            LispValue::String(" ".into()),
          ],
        )?;
        let ifs = match ifs {
          LispValue::String(value) => value,
          _ => " ".into(),
        };
        if subscript == "@" || subscript == "*fields" && ifs.is_empty() {
          return Ok(LispValue::List(List {
            items: entries.into_values().map(|value| LispValue::String(value.into())).collect(),
          }));
        }
        return Ok(LispValue::String(
          entries.into_values().collect::<Vec<_>>().join(
            &ifs
              .chars()
              .next()
              .map(|c| c.to_string())
              .unwrap_or_default(),
          ).into(),
        ));
      }
      let index = index(&subscript, &entries)?;
      let text = entries.get(&index);
      if text.is_none() && nounset.get() {
        return Err(unbound_fatal(&failure, &status_127, format!("{name}[{index}]: unbound variable")));
      }
      let text = text.cloned().unwrap_or_default();
      let mut locale = String::new();
      if *length {
        for name in ["LC_ALL", "LC_CTYPE", "LANG"] {
          if let LispValue::String(value) = array_lookup(
            env.clone(),
            vec![
              LispValue::String(name.into()),
              LispValue::String(String::new().into()),
            ],
          )? {
            locale = value.to_ascii_lowercase();
            if !locale.is_empty() {
              break;
            }
          }
        }
      }
      let size = if locale.contains("utf-8") || locale.contains("utf8") {
        text.chars().count()
      } else {
        text.len()
      };
      Ok(LispValue::String(if *length {
        size.to_string().into()
      } else {
        text.into()
      }))
    });
    let attributes = self.shell_compound.commands.attributes.clone();
    let arithmetic = self.interp.string_interner().get_or_intern("std.sh.arith");
    let index: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(name), LispValue::String(raw)] = args.as_slice() else {
        return Err(RuntimeError::Other(
          "std.sh.array-index: expected NAME SUBSCRIPT".into(),
        ));
      };
      if attributes.borrow().get(name.as_str()).is_some_and(|a| a.associative) {
        return Ok(LispValue::String(raw.clone()));
      }
      let native = env.borrow().get(arithmetic);
      let Some(LispValue::Function(Function::NativeClosure(native))) = native else {
        return Err(RuntimeError::Other(
          "array: arithmetic native is missing".into(),
        ));
      };
      native(env, vec![LispValue::String(raw.clone())])
    });
    let index_symbol = self
      .interp
      .string_interner()
      .get_or_intern("std.sh.array-index");
    self.env.borrow_mut().define(
      index_symbol,
      LispValue::Function(Function::NativeClosure(index)),
    );
    let symbol = self.interp.string_interner().get_or_intern("std.sh.array-get");
    self
      .env
      .borrow_mut()
      .define(symbol, LispValue::Function(Function::NativeClosure(array)));
    let names = self.shell_symbols.clone();
    let keys_lookup = lookup.clone();
    let keys: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(name), LispValue::String(selector)] = args.as_slice() else {
        return Err(RuntimeError::Other("std.sh.array-keys: expected NAME SELECTOR".into()));
      };
      let bound = names.borrow().get(name.as_str()).and_then(|symbol| env.borrow().get(*symbol));
      let keys = if let Some(data) = bound.as_ref().and_then(associative_entries) {
        data.into_keys().collect::<Vec<_>>()
      } else if let Some(data) = bound.as_ref().and_then(entries) {
        data.into_keys().map(|key| key.to_string()).collect()
      } else if matches!(bound, Some(LispValue::String(_))) { vec!["0".into()] }
      else { Vec::new() };
      array_fields(env, keys, selector, " ", &keys_lookup)
    });
    let symbol = self.interp.string_interner().get_or_intern("std.sh.array-keys");
    self.env.borrow_mut().define(symbol, LispValue::Function(Function::NativeClosure(keys)));
    let names = self.shell_symbols.clone();
    let next: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(name)] = args.as_slice() else {
        return Err(RuntimeError::Other("std.sh.array-next: expected NAME".into()));
      };
      let bound = names.borrow().get(name.as_str()).and_then(|symbol| env.borrow().get(*symbol));
      let data = bound.as_ref().and_then(entries).unwrap_or_default();
      Ok(LispValue::String(data.last_key_value().map_or(0, |(key, _)| key + 1).to_string().into()))
    });
    let symbol = self.interp.string_interner().get_or_intern("std.sh.array-next");
    self.env.borrow_mut().define(symbol, LispValue::Function(Function::NativeClosure(next)));
    let names = self.shell_symbols.clone();
    let test_lookup = lookup.clone();
    let test: NativeClosure<Sym> = Rc::new(move |env, args| {
      let [LispValue::String(name), LispValue::String(selector), LispValue::Boolean(colon), LispValue::Boolean(plus)] = args.as_slice() else {
        return Err(RuntimeError::Other("std.sh.array-test: expected NAME SELECTOR COLON PLUS".into()));
      };
      let bound = names.borrow().get(name.as_str()).and_then(|symbol| env.borrow().get(*symbol));
      let values = if let Some(data) = bound.as_ref().and_then(associative_entries) {
        data.into_values().collect::<Vec<_>>()
      } else if let Some(data) = bound.as_ref().and_then(entries) {
        data.into_values().collect()
      } else if let Some(LispValue::String(value)) = bound { vec![value.into_string()] }
      else { Vec::new() };
      let nonnull = if selector == "@" {
        values.len() > 1 || values.first().is_some_and(|value| !value.is_empty())
      } else {
        let joined = array_fields(env, values.clone(), "*", "", &test_lookup)?;
        matches!(joined, LispValue::String(value) if !value.is_empty())
      };
      let exists = !values.is_empty() && (!colon || nonnull);
      Ok(LispValue::Boolean(if *plus { exists } else { !exists }))
    });
    let symbol = self.interp.string_interner().get_or_intern("std.sh.array-test");
    self.env.borrow_mut().define(symbol, LispValue::Function(Function::NativeClosure(test)));
    self.set_pipeline_statuses(&[]);
  }

  pub(super) fn assign_array_scalar(&mut self, symbol: Sym, text: String) -> bool {
    let bound = self.env.borrow().get(symbol);
    if let Some(mut data) = bound.as_ref().and_then(associative_entries) {
      data.insert("0".into(), text);
      return self
        .env
        .borrow_mut()
        .set(symbol, associative_value(data))
        .is_ok();
    }
    let Some(mut data) = bound.as_ref().and_then(entries) else {
      return false;
    };
    data.insert(0, text);
    if self.env.borrow_mut().set(symbol, value(data)).is_err() {
      return false;
    }
    true
  }

  pub(super) async fn assign_shell_array(
    &mut self,
    args: &[LispValue<Sym>],
    line: usize,
  ) -> Result<Option<serde_json::Value>, TshScriptErrorKind> {
    let [
      LispValue::String(name),
      subscript,
      LispValue::Boolean(append),
      words,
    ] = args
    else {
      return Err(TshScriptErrorKind::Lisp(LispHostError::Command(
        "array assignment: invalid operands".into(),
      )));
    };
    if self
      .shell_compound
      .commands
      .attributes
      .borrow()
      .get(name.as_str())
      .is_some_and(|a| a.readonly)
    {
      self.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly variable"));
      self.set_shell_status(1);
      return Err(TshScriptErrorKind::Control(self.assignment_error_signal(1)));
    }
    let writes = self.shell_status_writes();
    let symbol = self.interp.string_interner().get_or_intern(name);
    // The natives find variables by name: `${!r}` may name this array.
    self.refresh_shell_symbols();
    let existing = self.env.borrow().get(symbol);
    let mut data = existing
      .as_ref()
      .and_then(entries)
      .unwrap_or_else(|| match existing {
        Some(LispValue::String(value)) => BTreeMap::from([(0, value.into_string())]),
        _ => BTreeMap::new(),
      });
    // The subscript and the words are this assignment's own expansion.
    let forks = super::owned_io_fork::words_fork(self, subscript)
      || super::owned_io_fork::words_fork(self, words);
    let unit = self
      .reserve_fork_unit(forks, "array assignment", line)
      .map_err(|e| TshScriptErrorKind::Lisp(LispHostError::Command(e)))?;
    let subscript = super::shell_redirect::resolve_target(self, subscript, line)
      .await
      .map_err(|e| TshScriptErrorKind::Lisp(LispHostError::Command(e)))?;
    let subscript = self
      .evaluate_shell_data(&subscript)
      .map_err(TshScriptErrorKind::Lisp)?;
    let subscript = subscript
      .as_str()
      .map(str::to_string)
      .unwrap_or_else(|| subscript.to_string());
    let words = super::shell_redirect::resolve_target(self, words, line)
      .await
      .map_err(|e| TshScriptErrorKind::Lisp(LispHostError::Command(e)))?;
    drop(unit);
    let words = self
      .evaluate_shell_data(&words)
      .map_err(TshScriptErrorKind::Lisp)?;
    let words = words.as_array().ok_or_else(|| {
      TshScriptErrorKind::Lisp(LispHostError::Command(
        "array assignment: expected words".into(),
      ))
    })?;
    if self
      .shell_compound
      .commands
      .attributes
      .borrow()
      .get(name.as_str())
      .is_some_and(|a| a.associative)
    {
      if subscript.is_empty() {
        if !words.is_empty() {
          return Err(TshScriptErrorKind::Lisp(LispHostError::Command(format!(
            "{name}: bad array subscript"
          ))));
        }
        if !*append {
          let assigned = associative_value(BTreeMap::new());
          if self.env.borrow_mut().set(symbol, assigned.clone()).is_err() {
            Env::root_of(&self.env)
              .borrow_mut()
              .define(symbol, assigned);
          }
        }
        self.set_shell_status(0);
        return Ok(None);
      }
      let existing = self.env.borrow().get(symbol);
      let mut data = existing
        .as_ref()
        .and_then(associative_entries)
        .unwrap_or_default();
      let mut text = words
        .first()
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
      let integer = self
        .shell_compound
        .commands
        .attributes
        .borrow()
        .get(name.as_str())
        .is_some_and(|a| a.integer);
      if integer {
        text = self.integer_shell_value(&text)?;
        if *append {
          text = self.integer_shell_value(&format!(
            "({})+({text})",
            data.get(&subscript).map(String::as_str).unwrap_or("0")
          ))?;
        }
      }
      if *append && !integer {
        data.entry(subscript).or_default().push_str(&text);
      } else {
        data.insert(subscript, text);
      }
      let assigned = associative_value(data);
      if self.env.borrow_mut().set(symbol, assigned.clone()).is_err() {
        Env::root_of(&self.env)
          .borrow_mut()
          .define(symbol, assigned);
      }
      self.set_shell_status(if writes == self.shell_status_writes() {
        0
      } else {
        self.shell_status()
      });
      return Ok(None);
    }
    if subscript.is_empty() {
      if !append {
        data.clear();
      }
      let start = data.last_key_value().map_or(0, |(index, _)| index + 1);
      for (offset, word) in words.iter().enumerate() {
        let mut text = word
          .as_str()
          .map(str::to_string)
          .unwrap_or_else(|| word.to_string());
        if self
          .shell_compound
          .commands
          .attributes
          .borrow()
          .get(name.as_str())
          .is_some_and(|a| a.integer)
        {
          text = self.integer_shell_value(&text)?;
        }
        data.insert(start + offset as i64, text);
      }
    } else {
      let index = index(&subscript, &data)
        .map_err(|e| TshScriptErrorKind::Lisp(LispHostError::Command(e.to_string())))?;
      let mut text = words
        .first()
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
      let integer = self
        .shell_compound
        .commands
        .attributes
        .borrow()
        .get(name.as_str())
        .is_some_and(|a| a.integer);
      if integer {
        text = self.integer_shell_value(&text)?;
        if *append {
          text = self.integer_shell_value(&format!(
            "({})+({text})",
            data.get(&index).map(String::as_str).unwrap_or("0")
          ))?;
        }
      }
      if *append && !integer {
        data.entry(index).or_default().push_str(&text);
      } else {
        data.insert(index, text);
      }
    }
    let assigned = value(data);
    if self.env.borrow_mut().set(symbol, assigned.clone()).is_err() {
      Env::root_of(&self.env)
        .borrow_mut()
        .define(symbol, assigned);
    }
    let status = if writes == self.shell_status_writes() {
      0
    } else {
      self.shell_status()
    };
    self.set_shell_status(status);
    Ok(None)
  }
}

/// The words of a name list (`${!prefix@}`, `${!a[@]}`) for `selector`: `@`
/// keeps one field per name; `*` joins with IFS's first character. Unquoted
/// `*` (`*fields`) under a null IFS is not split, as bash 5.3 does it: the
/// names join into one word with `null_ifs_join`, which is "" for
/// `${!prefix*}` and " " for `${!a[*]}` (`IFS=''; a=(x y z)` gives `0 1 2`).
pub(super) fn array_fields(env: Rc<std::cell::RefCell<Env<Sym>>>, values: Vec<String>, selector: &str, null_ifs_join: &str, lookup: &NativeClosure<Sym>) -> Result<LispValue<Sym>, RuntimeError> {
  let ifs = lookup(env, vec![LispValue::String("IFS".into()), LispValue::String(" ".into())])?;
  let ifs = match ifs { LispValue::String(value) => value, _ => " ".into() };
  if selector == "@" {
    Ok(LispValue::List(List { items: values.into_iter().map(|value| LispValue::String(value.into())).collect() }))
  } else if selector == "*fields" && ifs.is_empty() {
    Ok(LispValue::String(values.join(null_ifs_join).into()))
  } else {
    let separator = ifs.chars().next().map(|c| c.to_string()).unwrap_or_default();
    Ok(LispValue::String(values.join(&separator).into()))
  }
}

/// A `set -u` failure the flow reports, ending the script as bash does
/// (`bash_expansion::parameter_fatal`).
fn unbound_fatal(failure: &Rc<std::cell::RefCell<Option<String>>>, status_127: &Rc<std::cell::Cell<bool>>, detail: String) -> RuntimeError {
  status_127.set(true);
  failure.replace(Some(detail.clone()));
  RuntimeError::Fatal { detail }
}
