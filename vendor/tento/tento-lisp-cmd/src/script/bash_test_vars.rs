//! The `test`/`[`/`[[` primaries that ask the shell rather than the file
//! system: `-v NAME` (set, including `a[i]`, `m[k]` and positionals), `-R
//! NAME` (a nameref) and `-o OPTION` (a `set -o` option is on). The pure
//! `test` evaluator has no shell state, so the host answers these first and
//! hands it the equivalent `-n` primary.
use tento_lisp::Value as LispValue;

use super::bash_arrays;
use super::interp::LispHost;

impl LispHost {
  /// `test` arguments with every shell-state primary answered.
  pub(super) fn answer_test_primaries(&mut self, args: &[String]) -> Vec<String> {
    let mut args = args.to_vec();
    let mut index = 0;
    while index + 1 < args.len() {
      let unary_position = index == 0 || matches!(args[index - 1].as_str(), "!" | "(" | "-a" | "-o");
      let binary_next =
        index + 2 < args.len() && matches!(args[index + 1].as_str(), "=" | "==" | "!=" | "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge");
      // A leading `-o` is the option primary; elsewhere it is "or".
      let op = args[index].as_str();
      let answer = match op {
        "-v" | "-R" if unary_position && !binary_next => Some(op == "-v"),
        "-o" if (index == 0 || matches!(args[index - 1].as_str(), "!" | "(")) && !binary_next => Some(false),
        _ => None,
      };
      if let Some(variable) = answer {
        let operand = args[index + 1].clone();
        let truth = match op {
          "-o" => self.shell_option_enabled(&operand),
          _ if variable => self.shell_variable_is_set(&operand),
          _ => self.shell_compound.commands.attributes.borrow().get(&operand).is_some_and(|a| a.nameref),
        };
        args[index] = "-n".into();
        args[index + 1] = if truth { "1".into() } else { String::new() };
        index += 2;
      } else {
        index += 1;
      }
    }
    args
  }

  /// `-o NAME`: whether a `set -o` option is on.
  pub(super) fn shell_option_enabled(&mut self, name: &str) -> bool {
    let letter = match name {
      "allexport" => 'a',
      "braceexpand" => 'B',
      "errexit" => 'e',
      "hashall" => 'h',
      "noclobber" => 'C',
      "noglob" => 'f',
      "nounset" => 'u',
      "xtrace" => 'x',
      "pipefail" => return self.shell_compound.commands.pipefail,
      _ => return false,
    };
    self.refresh_shell_flags();
    self.shell_compound.flags.borrow().contains(letter)
  }

  /// `-v WORD`: a set variable, array element, associative key or
  /// positional parameter. A nameref asks about its target.
  pub(super) fn shell_variable_is_set(&mut self, word: &str) -> bool {
    if !word.is_empty() && word.bytes().all(|c| c.is_ascii_digit()) {
      let index: usize = word.parse().unwrap_or(usize::MAX);
      return index == 0 || index <= self.shell_compound.positional.borrow().len();
    }
    let (name, subscript) = match word.strip_suffix(']').and_then(|w| w.split_once('[')) {
      Some((name, subscript)) => (name, Some(subscript)),
      None => (word, None),
    };
    self.refresh_shell_symbols();
    let name = super::bash_attributes::nameref_target(
      &self.shell_compound.commands.attributes,
      &self.shell_symbols,
      &self.env,
      name,
    );
    let Some(subscript) = subscript else {
      return self.shell_variable_exists(&name)
        || super::bash_attributes::dynamic_variable(&name).is_some();
    };
    let symbol = self.interp.string_interner().get_or_intern(&name);
    let bound = self.env.borrow().get(symbol);
    let Some(bound) = bound else { return false };
    if let Some(entries) = bash_arrays::associative_entries(&bound) {
      return if matches!(subscript, "@" | "*") {
        !entries.is_empty()
      } else {
        entries.contains_key(subscript)
      };
    }
    let entries = bash_arrays::entries(&bound);
    if matches!(subscript, "@" | "*") {
      return entries.is_none_or(|entries| !entries.is_empty());
    }
    let Ok(index) = self.integer_shell_value(subscript) else { return false };
    let index: i64 = index.trim().parse().unwrap_or(0);
    match entries {
      Some(entries) => {
        let index =
          if index < 0 { entries.last_key_value().map_or(0, |(n, _)| n + 1) + index } else { index };
        entries.contains_key(&index)
      }
      None => index == 0 && matches!(bound, LispValue::String(_)),
    }
  }
}
