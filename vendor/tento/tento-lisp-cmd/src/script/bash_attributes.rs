//! Bash variable attributes that change what an assignment stores or which
//! variable a name means: `declare -l`/`-u` case conversion and `declare -n`
//! namerefs. A nameref keeps its target's name as its own value, as bash
//! does, so `declare -p` and `unset -n` see an ordinary variable. Also the
//! dynamic variables bash computes on each read (`$LINENO`, `$RANDOM`,
//! `$SECONDS`) and the default `IFS`.
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Instant;

use tento_lisp::{Env, Value as LispValue};

use super::bash_arrays::VarAttributes;
use super::interp::{LispHost, Sym};
use super::runner::TshScriptErrorKind;

thread_local! {
  /// The source line of the command being run, for `$LINENO`.
  static LINE: Cell<usize> = const { Cell::new(0) };
  static STARTED: Instant = Instant::now();
  static RANDOM_STATE: Cell<u64> = Cell::new(random_seed());
  /// Dynamic variables a script unset; bash then treats them as ordinary.
  static UNSET: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
  /// `$_`: the last word of the previous simple command.
  static LAST_ARGUMENT: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// The dynamic-variable state an in-process subshell must not leak to its
/// parent: what it unset, `$_`, the `RANDOM` sequence and `local -`
/// snapshots. Taken before `( … )` runs and put back after it, as bash's
/// fork would.
pub(super) struct SpecialsSnapshot {
  unset: HashSet<String>,
  last_argument: Option<String>,
  random: u64,
  local_options: HashMap<usize, SavedOptions>,
  readonly_functions: HashSet<String>,
}

pub(super) fn save_specials() -> SpecialsSnapshot {
  SpecialsSnapshot {
    unset: UNSET.with(|unset| unset.borrow().clone()),
    last_argument: LAST_ARGUMENT.with(|slot| slot.borrow().clone()),
    random: RANDOM_STATE.with(Cell::get),
    local_options: LOCAL_OPTIONS.with(|map| map.borrow().clone()),
    readonly_functions: super::bash_type::readonly_functions(),
  }
}

pub(super) fn restore_specials(saved: SpecialsSnapshot) {
  UNSET.with(|unset| *unset.borrow_mut() = saved.unset);
  LAST_ARGUMENT.with(|slot| *slot.borrow_mut() = saved.last_argument);
  RANDOM_STATE.with(|state| state.set(saved.random));
  LOCAL_OPTIONS.with(|map| *map.borrow_mut() = saved.local_options);
  super::bash_type::set_readonly_functions(saved.readonly_functions);
}

/// Record a resolved simple command's last word for `$_`. Only a fully
/// literal argv counts, so nothing is evaluated twice.
pub(super) fn remember_last_argument(command: &LispValue<Sym>) {
  let LispValue::List(list) = command else { return };
  let words = list.items.get(1..).unwrap_or(&[]);
  if words.is_empty() || !words.iter().all(|word| matches!(word, LispValue::String(_))) {
    return;
  }
  if let Some(LispValue::String(last)) = words.last() {
    LAST_ARGUMENT.with(|slot| *slot.borrow_mut() = Some(last.to_string()));
  }
}

fn random_seed() -> u64 {
  let nanos = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_or(0, |elapsed| elapsed.as_nanos() as u64);
  nanos ^ (u64::from(std::process::id()) << 32) | 1
}

/// Record the line `$LINENO` reports.
pub(super) fn set_current_line(line: usize) {
  LINE.with(|current| current.set(line));
}

/// The line of the command now running.
pub(super) fn current_line() -> usize {
  LINE.with(Cell::get)
}

/// A dynamic variable's value when NAME is one and the script has not
/// unset it (or bound it: bindings are consulted first).
pub(super) fn dynamic_variable(name: &str) -> Option<String> {
  if name == "_" {
    return LAST_ARGUMENT.with(|slot| slot.borrow().clone());
  }
  if !matches!(name, "LINENO" | "RANDOM" | "SECONDS" | "IFS")
    || UNSET.with(|unset| unset.borrow().contains(name))
  {
    return None;
  }
  Some(match name {
    // bash starts every shell with IFS set to space, tab, newline.
    "IFS" => " \t\n".to_string(),
    "LINENO" => LINE.with(Cell::get).to_string(),
    "SECONDS" => STARTED.with(|started| started.elapsed().as_secs()).to_string(),
    _ => RANDOM_STATE.with(|state| {
      // xorshift64*; bash's range is 0..=32767.
      let mut x = state.get();
      x ^= x >> 12;
      x ^= x << 25;
      x ^= x >> 27;
      state.set(x);
      (x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 49) % 32768
    })
    .to_string(),
  })
}

/// How long ago this shell started (`$SECONDS`' clock).
pub(super) fn shell_elapsed() -> std::time::Duration {
  STARTED.with(|started| started.elapsed())
}

/// `unset LINENO` (and the others) drops the special behaviour for good.
pub(super) fn forget_dynamic_variable(name: &str) {
  if matches!(name, "LINENO" | "RANDOM" | "SECONDS" | "IFS") {
    UNSET.with(|unset| unset.borrow_mut().insert(name.to_string()));
  }
}

/// How many namerefs a lookup follows; bash refuses deeper chains as
/// circular.
const NAMEREF_DEPTH: usize = 8;

/// The value an assignment stores under `-l`/`-u`.
pub(super) fn case_converted(attr: &VarAttributes, text: String) -> String {
  if attr.lower {
    text.to_lowercase()
  } else if attr.upper {
    text.to_uppercase()
  } else {
    text
  }
}

/// The variable `name` means after following its namerefs.
pub(super) fn nameref_target(
  attributes: &RefCell<HashMap<String, VarAttributes>>,
  names: &RefCell<HashMap<String, Sym>>,
  env: &Rc<RefCell<Env<Sym>>>,
  name: &str,
) -> String {
  let mut name = name.to_string();
  for _ in 0..NAMEREF_DEPTH {
    if !attributes.borrow().get(&name).is_some_and(|attr| attr.nameref) {
      break;
    }
    let Some(symbol) = names.borrow().get(&name).copied() else { break };
    match env.borrow().get(symbol) {
      Some(LispValue::String(target)) if !target.is_empty() && target != name => name = target.into_string(),
      _ => break,
    }
  }
  name
}

impl LispHost {
  /// Point an assignment form `(let NAME …)` / `(std.sh.append NAME …)` at the
  /// variable a nameref names.
  pub(super) fn follow_nameref_assignment(&mut self, value: &mut LispValue<Sym>) {
    let LispValue::List(list) = value else { return };
    let Some(LispValue::Symbol(symbol)) = list.items.get(1) else { return };
    let Some(name) = self.interp.string_interner().resolve(symbol.as_symbol()).map(str::to_string)
    else {
      return;
    };
    if !self.shell_compound.commands.attributes.borrow().get(&name).is_some_and(|a| a.nameref) {
      return;
    }
    self.refresh_shell_symbols();
    let target = nameref_target(
      &self.shell_compound.commands.attributes,
      &self.shell_symbols,
      &self.env,
      &name,
    );
    if target != name {
      let target = self.interp.string_interner().get_or_intern(&target);
      // Lookups find variables through the symbol index.
      self.refresh_shell_symbols();
      list.items[1] = LispValue::Symbol(target.into());
    }
  }

  /// Store a plain assignment to a `-l`/`-u` variable case-converted, and
  /// one to a declared but unset array as its element 0. Returns false
  /// when neither applies.
  /// `trace` is the expanded xtrace prefix under `set -x`: the assignment
  /// then shows its word before the case conversion (`lo=ABC`).
  pub(super) fn assign_case_attribute(
    &mut self,
    value: &LispValue<Sym>,
    trace: Option<&str>,
  ) -> Result<bool, TshScriptErrorKind> {
    let LispValue::List(list) = value else { return Ok(false) };
    let [_, LispValue::Symbol(symbol), rhs] = list.items.as_slice() else { return Ok(false) };
    let Some(name) = self.interp.string_interner().resolve(symbol.as_symbol()).map(str::to_string)
    else {
      return Ok(false);
    };
    let attr = self.shell_compound.commands.attributes.borrow().get(&name).copied();
    let Some(attr) = attr else { return Ok(false) };
    let unset_array =
      (attr.indexed || attr.associative) && self.env.borrow().get(symbol.as_symbol()).is_none();
    if !(attr.lower || attr.upper || unset_array) {
      return Ok(false);
    }
    let assigned = self.evaluate_shell_data(rhs).map_err(TshScriptErrorKind::Lisp)?;
    let text = assigned.as_str().map(str::to_string).unwrap_or_else(|| assigned.to_string());
    if let Some(prefix) = trace { self.write_assignment_trace(prefix, &name, &text, false); }
    let text = case_converted(&attr, text);
    if unset_array {
      let array = if attr.associative {
        super::bash_arrays::associative_value([("0".to_string(), text)].into())
      } else {
        super::bash_arrays::value([(0, text)].into())
      };
      if self.env.borrow_mut().set(symbol.as_symbol(), array.clone()).is_err() {
        Env::root_of(&self.env).borrow_mut().define(symbol.as_symbol(), array);
      }
    } else if !self.assign_array_scalar(symbol.as_symbol(), text.clone()) {
      self.assign_shell_variable(&name, text, false);
    }
    Ok(true)
  }
}

/// The `set` options `local -` saves for the running function.
#[derive(Clone, Copy)]
struct SavedOptions {
  errexit: bool,
  noglob: bool,
  nounset: bool,
  xtrace: bool,
  brace_disabled: bool,
  pipefail: bool,
  noclobber: bool,
  glob: super::bash_compound::GlobOptions,
}

thread_local! {
  /// `local -` snapshots, by function call depth.
  static LOCAL_OPTIONS: RefCell<HashMap<usize, SavedOptions>> = RefCell::new(HashMap::new());
}

impl LispHost {
  /// `local -`: the shell options come back when this function returns.
  pub(super) fn save_local_options(&mut self) {
    let commands = &self.shell_compound.commands;
    let saved = SavedOptions {
      errexit: self.shell_errexit,
      noglob: self.shell_compound.noglob.get(),
      nounset: commands.nounset.get(),
      xtrace: commands.xtrace,
      brace_disabled: commands.brace_disabled.get(),
      pipefail: commands.pipefail,
      noclobber: commands.noclobber,
      glob: commands.glob.get(),
    };
    let depth = self.shell_compound.calls;
    LOCAL_OPTIONS.with(|map| {
      map.borrow_mut().entry(depth).or_insert(saved);
    });
  }

  /// At a function's return: restore what its `local -` saved.
  pub(super) fn restore_local_options(&mut self) {
    let depth = self.shell_compound.calls;
    let Some(saved) = LOCAL_OPTIONS.with(|map| map.borrow_mut().remove(&depth)) else { return };
    self.shell_errexit = saved.errexit;
    self.shell_compound.noglob.set(saved.noglob);
    let commands = &mut self.shell_compound.commands;
    commands.nounset.set(saved.nounset);
    commands.xtrace = saved.xtrace;
    commands.brace_disabled.set(saved.brace_disabled);
    commands.pipefail = saved.pipefail;
    commands.noclobber = saved.noclobber;
    commands.glob.set(saved.glob);
    self.refresh_shell_flags();
  }
}
