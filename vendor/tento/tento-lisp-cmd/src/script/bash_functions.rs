//! Shell function bodies as text: `declare -f`, `type` and exported
//! functions (`export -f`, `declare -fx`).
//!
//! The reader hands each definition's source with its body; the text is
//! kept per body (keyed by the body's printed form, so a subshell's
//! redefinition never leaves a stale text behind) and printed through
//! [`tento_lisp::format_shell_function`], bash's canonical layout.
//!
//! An exported function lives in the environment exactly where bash 5
//! puts it, `BASH_FUNC_name%%=() {  body\n}`, so child bashes (and child
//! tsh) import it. The environment entry is the export flag: redefining an
//! exported function rewrites it, `unset -f`/`export -nf` remove it. A shell
//! starting with such entries in its environment defines those functions,
//! as bash does.
use std::cell::RefCell;
use std::collections::HashMap;

use tento_lisp::{ShellFunctionStyle, Value as LispValue};

use super::interp::{LispHost, Sym};

thread_local! {
  /// Function source text by the body's printed form.
  static SOURCES: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

const PREFIX: &str = "BASH_FUNC_";
const SUFFIX: &str = "%%";

/// The environment variable that carries exported function NAME.
pub(super) fn environment_name(name: &str) -> String {
  format!("{PREFIX}{name}{SUFFIX}")
}

impl LispHost {
  /// Define (or redefine) shell function NAME; SOURCE is the body's text
  /// when the reader kept it.
  pub(super) fn define_shell_function(&mut self, name: &str, body: LispValue<Sym>, source: Option<&str>) {
    if let Some(source) = source {
      SOURCES.with(|sources| sources.borrow_mut().insert(body_key(&body), source.to_string()));
    }
    self.shell_compound.functions.insert(name.to_string(), body);
    if self.function_exported(name) {
      self.export_function(name);
    }
  }

  fn function_source(&self, name: &str) -> Option<String> {
    let body = self.shell_compound.functions.get(name)?;
    SOURCES.with(|sources| sources.borrow().get(&body_key(body)).cloned())
  }

  /// Function NAME as `declare -f` prints it (no trailing newline).
  pub(super) fn function_text(&self, name: &str) -> Option<String> {
    let source = self.function_source(name)?;
    tento_lisp::format_shell_function(name, &source, ShellFunctionStyle::Declare)
  }

  /// `declare -f` text for NAME, or a diagnostic body when tsh kept no
  /// source for it (a function defined before sources were kept).
  pub(super) fn function_text_or_reason(&self, name: &str) -> Result<String, String> {
    self.function_text(name).ok_or_else(|| format!("{name}: function body source unavailable"))
  }

  /// Whether NAME is exported (`BASH_FUNC_NAME%%` is in the environment).
  pub(super) fn function_exported(&self, name: &str) -> bool {
    tento_env::effective_var(&environment_name(name)).is_some()
  }

  /// `export -f NAME`: put the function in the environment.
  pub(super) fn export_function(&mut self, name: &str) -> bool {
    let Some(source) = self.function_source(name) else {
      return false;
    };
    let Some(text) = tento_lisp::format_shell_function(name, &source, ShellFunctionStyle::Environment) else {
      return false;
    };
    match tento_env::global_env_map() {
      Some(map) => map.set(environment_name(name), text),
      None => return false,
    }
    true
  }

  /// `export -nf NAME`, `unset -f NAME`: take the function out of the
  /// environment.
  pub(super) fn unexport_function(&mut self, name: &str) {
    if let Some(map) = tento_env::global_env_map() {
      map.remove(&environment_name(name));
    }
  }

  /// Names of the exported functions, sorted.
  pub(super) fn exported_functions(&self) -> Vec<String> {
    let mut names: Vec<String> = self
      .shell_compound
      .functions
      .keys()
      .filter(|name| self.function_exported(name))
      .cloned()
      .collect();
    names.sort();
    names
  }

  /// Define the functions this shell's environment exports to it
  /// (`BASH_FUNC_name%%=() { … }`), once per host, the way bash imports
  /// them at startup. Only a value that is exactly one function definition
  /// is imported; anything else stays an ordinary environment entry.
  pub(super) fn import_environment_functions(&mut self) {
    if self.shell_compound.functions_imported {
      return;
    }
    self.shell_compound.functions_imported = true;
    let Some(map) = tento_env::global_env_map() else {
      return;
    };
    let mut entries: Vec<(String, String)> = map
      .snapshot()
      .into_iter()
      .filter_map(|(key, value)| {
        let name = key.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?.to_string();
        value.starts_with("() {").then_some((name, value))
      })
      .collect();
    entries.sort();
    for (name, value) in entries {
      if self.shell_compound.functions.contains_key(&name) || !importable_name(&name) {
        continue;
      }
      let Ok(value) = self.read_posix_line_value(&format!("{name} {value}")) else {
        continue;
      };
      let LispValue::List(list) = value else {
        continue;
      };
      if self.application_head(&LispValue::List(list.clone())).as_deref() != Some("std.sh.function") {
        continue;
      }
      if let [_, LispValue::String(defined), body, rest @ ..] = list.items.as_slice() {
        if *defined != name {
          continue;
        }
        let source = match rest {
          [LispValue::String(source)] => Some(source.as_str()),
          _ => None,
        };
        self.shell_compound.functions.insert(name.clone(), body.clone());
        if let Some(source) = source {
          SOURCES.with(|sources| sources.borrow_mut().insert(body_key(&body), source.to_string()));
        }
      }
    }
  }
}

fn importable_name(name: &str) -> bool {
  !name.is_empty()
    && !name.contains(['/', '=', '$', '`', '"', '\'', '\\', ' ', '\t', '\n', '(', ')', ';', '&', '|', '<', '>'])
}

/// The key a body's source is kept under: its full structure.
fn body_key(body: &LispValue<Sym>) -> String {
  format!("{body:?}")
}
