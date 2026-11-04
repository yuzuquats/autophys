//! The `select` compound command: `(std.sh.select NAME WORDS BODY)` from
//! the reader. Like bash's `execute_select_command`: the numbered menu goes
//! to standard error in bash's column layout (`COLUMNS`, default 80), then
//! `PS3` (default `#? `); a line is read into `REPLY` as `read` with no
//! names does; an empty line shows the menu again; NAME becomes the chosen
//! word, or empty for anything else; the body runs; `break` ends the loop.
//! End of input prints a newline on standard output and ends the loop with
//! status 1. An empty word list runs nothing (status 0; bash 3.2 refuses
//! `select x in;` as a syntax error).
use serde_json::Value as JsonValue;
use tento_lisp::Value as LispValue;

use super::bash_flow::{FlowOutput, eval_flow};
use super::interp::{LispHost, LispHostError, Sym};
use super::runner::TshScriptErrorKind;

type Result<T> = std::result::Result<T, TshScriptErrorKind>;

/// bash's `print_select_list`: the menu text for WORDS in COLUMNS.
pub(super) fn menu(words: &[String], columns: usize) -> String {
  let count = words.len();
  if count == 0 {
    return "\n".into();
  }
  let number_len = |n: usize| n.to_string().len();
  let indices_len = number_len(count);
  let max_elem_len = words.iter().map(String::len).max().unwrap_or(0) + indices_len + 2 + 2;
  let mut cols = (columns / max_elem_len).max(1);
  let mut rows = count / cols + usize::from(count % cols != 0);
  cols = count / rows + usize::from(count % rows != 0);
  if rows == 1 {
    rows = cols;
    cols = 1;
  }
  let _ = cols;
  let first_len = number_len(rows);
  let mut out = String::new();
  for row in 0..rows {
    let mut index = row;
    loop {
      let width = if index == row { first_len } else { indices_len };
      let entry = format!("{:>width$}) {}", index + 1, words[index]);
      out.push_str(&entry);
      index += rows;
      if index >= count {
        break;
      }
      pad(&mut out, entry.len(), max_elem_len);
    }
    out.push('\n');
  }
  out
}

/// bash's `indent (from, to)` with 8-column tabs.
fn pad(out: &mut String, mut from: usize, to: usize) {
  while from < to {
    if to / 8 > from / 8 {
      out.push('\t');
      from += 8 - from % 8;
    } else {
      out.push(' ');
      from += 1;
    }
  }
}

/// bash's `legal_number` in base 10, surrounding whitespace allowed.
fn choice(reply: &str) -> Option<i64> {
  reply.trim_matches(|c: char| c.is_ascii_whitespace()).parse().ok()
}

impl LispHost {
  /// `(std.sh.select NAME WORDS BODY)`.
  pub(super) async fn select_loop(
    &mut self,
    stages: &[LispValue<Sym>],
    line: usize,
    ignored: bool,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    let [LispValue::String(name), words, body] = stages else {
      return Err(TshScriptErrorKind::Lisp(LispHostError::Runtime("std.sh.select: invalid operands".into())));
    };
    let forks = super::owned_io_fork::words_fork(self, words);
    let unit = self
      .reserve_fork_unit(forks, "select words", line)
      .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error)))?;
    let words = super::shell_redirect::resolve_target(self, words, line)
      .await
      .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error)))?;
    drop(unit);
    let words = self.evaluate_shell_data(&words).map_err(TshScriptErrorKind::Lisp)?;
    let words: Vec<String> = words
      .as_array()
      .map(|items| items.iter().map(|item| item.as_str().map_or_else(|| item.to_string(), str::to_string)).collect())
      .unwrap_or_default();
    if words.is_empty() {
      self.set_shell_status(0);
      return Ok(None);
    }
    self.shell_compound.loops += 1;
    let result = self.select_rounds(name, &words, body, line, ignored, output).await;
    self.shell_compound.loops -= 1;
    result
  }

  async fn select_rounds(
    &mut self,
    name: &str,
    words: &[String],
    body: &LispValue<Sym>,
    line: usize,
    ignored: bool,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    let mut status = 0;
    let mut show_menu = true;
    loop {
      let columns = self.shell_text("COLUMNS").and_then(|text| text.trim().parse::<usize>().ok()).filter(|c| *c > 0);
      let prompt = self.shell_text_if_set("PS3").unwrap_or_else(|| "#? ".into());
      let mut text = if show_menu { menu(words, columns.unwrap_or(80)) } else { String::new() };
      text.push_str(&prompt);
      self.write_shell_stderr(text.as_bytes());
      show_menu = false;
      let read = self.compound_builtin(&["read".to_string()], line);
      if let Some(read) = read {
        read?;
      }
      if self.shell_status() != 0 {
        output.write_bytes(self, b"\n");
        status = 1;
        break;
      }
      let reply = self.shell_text("REPLY").unwrap_or_default();
      if reply.is_empty() {
        show_menu = true;
        continue;
      }
      let chosen = choice(&reply)
        .filter(|n| *n >= 1 && (*n as usize) <= words.len())
        .map_or_else(String::new, |n| words[n as usize - 1].clone());
      if self.shell_readonly(name) {
        self.report_shell_diagnostic(format!("tsh: line {line}: {name}: readonly variable"));
        status = 1;
        break;
      }
      self.assign_shell_variable(name, chosen, false);
      match eval_flow(self, body, line, ignored, output.clone().plain(), false).await {
        Ok(value) => {
          output.flush_value(self, value);
          status = self.shell_status();
        }
        Err(TshScriptErrorKind::Control(super::ControlSignal::Break(1))) => {
          status = self.shell_status();
          break;
        }
        Err(TshScriptErrorKind::Control(super::ControlSignal::Continue(1))) => status = self.shell_status(),
        Err(TshScriptErrorKind::Control(super::ControlSignal::Break(n))) => {
          return Err(TshScriptErrorKind::Control(super::ControlSignal::Break(n - 1)));
        }
        Err(TshScriptErrorKind::Control(super::ControlSignal::Continue(n))) => {
          return Err(TshScriptErrorKind::Control(super::ControlSignal::Continue(n - 1)));
        }
        Err(error) => return Err(error),
      }
    }
    self.set_shell_status(status);
    Ok(None)
  }

  /// A shell variable's text (empty when unset).
  fn shell_text(&mut self, name: &str) -> Option<String> {
    let call = self.shell_literal_call(&["std.sh.var".into(), name.into()], "std.sh.var", false);
    match self.evaluate_shell_data(&call) {
      Ok(JsonValue::String(text)) => Some(text),
      _ => None,
    }
  }

  /// A shell variable's text only when it is set (`PS3=` is an empty prompt).
  fn shell_text_if_set(&mut self, name: &str) -> Option<String> {
    let symbol = self.interp.string_interner().get_or_intern(name);
    let bound = matches!(self.env.borrow().get(symbol), Some(LispValue::String(_)));
    (bound || tento_env::effective_var(name).is_some()).then(|| self.shell_text(name)).flatten()
  }

  /// Raw bytes to the shell's standard error (redirections in force).
  fn write_shell_stderr(&mut self, bytes: &[u8]) {
    let io = self.shell_io.borrow().clone();
    let target = io.map_or(super::FdTarget::Inherit(2), |io| io.target(2));
    match target {
      super::FdTarget::Inherit(1) => {
        let output = self.shell_output.borrow().clone();
        output.write_inherited_bytes(self, bytes);
      }
      super::FdTarget::Closed => {}
      target => {
        let _ = self.write_shell_target(&target, bytes);
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|word| (*word).to_string()).collect()
  }

  // Menus printed by bash 5.3 (`select v in …` with COLUMNS unset or set).
  #[test]
  fn select_menu_matches_bash_layout() {
    assert_eq!(menu(&words(&["apple", "banana", "cherry"]), 80), "1) apple\n2) banana\n3) cherry\n");
    let numbers: Vec<String> = (1..=25).map(|n| n.to_string()).collect();
    assert_eq!(
      menu(&numbers, 80),
      "1) 1\t 4) 4\t 7) 7\t10) 10\t13) 13\t16) 16\t19) 19\t22) 22\t25) 25\n\
       2) 2\t 5) 5\t 8) 8\t11) 11\t14) 14\t17) 17\t20) 20\t23) 23\n\
       3) 3\t 6) 6\t 9) 9\t12) 12\t15) 15\t18) 18\t21) 21\t24) 24\n"
    );
    assert_eq!(
      menu(&words(&["aaaaaaaaaa", "b", "c", "d", "e"]), 20),
      "1) aaaaaaaaaa\n2) b\n3) c\n4) d\n5) e\n"
    );
  }

  #[test]
  fn select_choice_reads_a_decimal_with_surrounding_space() {
    assert_eq!(choice(" 1 "), Some(1));
    assert_eq!(choice("x"), None);
    assert_eq!(choice("0x1"), None);
  }
}
