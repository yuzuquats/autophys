//! `set -x` lines for assignments, as bash 5.3 prints them: the source
//! operator (`=` or `+=`) and the expanded word quoted for re-reading, never
//! the lowered form tsh evaluates (`x+=5` stays `x+=5`, not `x=15`).
use tento_lisp::Value as LispValue;

use super::bash_compound::trace_word;
use super::interp::{LispHost, LispHostError, Sym};
use super::runner::TshScriptErrorKind;

/// An assignment word's value as xtrace shows it: empty stays empty
/// (`n=`), anything else is quoted like a command word.
pub(super) fn assignment_word(value: &str) -> String {
  if value.is_empty() { String::new() } else { trace_word(value) }
}

impl LispHost {
  /// Write `PREFIX NAME=WORD` (or `NAME+=WORD`) with a prefix expanded
  /// before the assignment ran.
  pub(super) fn write_assignment_trace(&mut self, prefix: &str, name: &str, word: &str, append: bool) {
    let op = if append { "+=" } else { "=" };
    self.write_trace(format!("{prefix}{name}{op}{}", assignment_word(word)));
  }

  /// `export NAME=VALUE`/`readonly NAME=VALUE` under `set -x`: bash shows
  /// each assignment word on its own line after the command (`local`,
  /// `declare` and `typeset` show only the command).
  pub(super) async fn trace_declaration_assignments(&mut self, argv: &[String], line: usize) -> Result<(), TshScriptErrorKind> {
    if !matches!(argv.first().map(String::as_str), Some("export" | "readonly")) {
      return Ok(());
    }
    let mut options = true;
    for word in &argv[1..] {
      if options && word.starts_with('-') && word.len() > 1 {
        if word == "--" { options = false; }
        // Functions are not variables.
        if word.contains('f') { return Ok(()); }
        continue;
      }
      options = false;
      let Some((name, value)) = word.split_once('=') else { continue };
      let (name, append) = match name.strip_suffix('+') { Some(name) => (name, true), None => (name, false) };
      if identifier(name) {
        let prefix = self.shell_trace_prefix(line).await?;
        self.write_assignment_trace(&prefix, name, value, append);
      }
    }
    Ok(())
  }

  /// Trace an assignment already made: the appended word when it was `+=`,
  /// else the variable's new value.
  pub(super) fn trace_assigned_variable(
    &mut self,
    prefix: &str,
    name: &str,
    appended: Option<&str>,
  ) -> Result<(), TshScriptErrorKind> {
    if let Some(word) = appended {
      self.write_assignment_trace(prefix, name, word, true);
      return Ok(());
    }
    let call = self.shell_literal_call(&["std.sh.var".into(), name.into()], "std.sh.var", false);
    let assigned = self
      .evaluate_shell_data(&call)
      .map_err(TshScriptErrorKind::Lisp)?;
    let text = assigned.as_str().map(str::to_string).unwrap_or_else(|| assigned.to_string());
    self.write_assignment_trace(prefix, name, &text, false);
    Ok(())
  }
}

/// An array assignment's expanded parts: the form rebuilt with them as
/// literals (so nothing expands twice), its subscript and its words.
pub(super) struct ExpandedArrayAssign {
  pub form: LispValue<Sym>,
  pub subscript: String,
  pub words: Vec<String>,
}

fn identifier(name: &str) -> bool {
  name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn text(value: &serde_json::Value) -> String {
  value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())
}

impl LispHost {
  /// Expand an `(std.sh.array-assign NAME SUBSCRIPT APPEND WORDS)` once.
  /// `None` for any other form.
  pub(super) async fn expand_array_assign(
    &mut self,
    form: &LispValue<Sym>,
    line: usize,
  ) -> Result<Option<ExpandedArrayAssign>, TshScriptErrorKind> {
    if self.application_head(form).as_deref() != Some("std.sh.array-assign") {
      return Ok(None);
    }
    let LispValue::List(list) = form else { return Ok(None) };
    let [head, name @ LispValue::String(_), subscript, append @ LispValue::Boolean(_), words] = list.items.as_slice() else {
      return Ok(None);
    };
    let fail = |error: String| TshScriptErrorKind::Lisp(LispHostError::Command(error));
    // The subscript and the words are this assignment's own expansion.
    let forks = super::owned_io_fork::words_fork(self, subscript)
      || super::owned_io_fork::words_fork(self, words);
    let unit = self.reserve_fork_unit(forks, "array assignment", line).map_err(fail)?;
    // The subscript's text is its expanded source: the declaration may
    // yet make NAME associative, so the form keeps evaluating it.
    let subscript_text = match subscript {
      LispValue::String(text) if text.is_empty() => String::new(),
      subscript => {
        let raw = match subscript {
          LispValue::List(index) if self.application_head(subscript).as_deref() == Some("std.sh.array-index") => {
            index.items.get(2).cloned().unwrap_or_else(|| subscript.clone())
          }
          subscript => subscript.clone(),
        };
        let resolved = super::shell_redirect::resolve_target(self, &raw, line).await.map_err(fail)?;
        text(&self.evaluate_shell_data(&resolved).map_err(TshScriptErrorKind::Lisp)?)
      }
    };
    let resolved = super::shell_redirect::resolve_target(self, words, line).await.map_err(fail)?;
    drop(unit);
    let words: Vec<String> = match self.evaluate_shell_data(&resolved).map_err(TshScriptErrorKind::Lisp)? {
      serde_json::Value::Array(words) => words.iter().map(text).collect(),
      other => vec![text(&other)],
    };
    let list_symbol = self.interp.string_interner().get_or_intern("list");
    let mut literal = vec![LispValue::Symbol(list_symbol.into())];
    literal.extend(words.iter().cloned().map(|value| LispValue::String(value.into())));
    let form = LispValue::List(tento_lisp::List { items: vec![
      head.clone(), name.clone(), subscript.clone(), append.clone(),
      LispValue::List(tento_lisp::List { items: literal.into() }),
    ].into() });
    Ok(Some(ExpandedArrayAssign { form, subscript: subscript_text, words }))
  }

  /// `(std.sh.array-traced TRACE FORM)` under `set -x`: `name=(words)` prints
  /// as written before it runs; `name[SUB]=` prints with the value word
  /// expanded (its substitutions trace first), as bash 5.3 does. Returns
  /// the form to run.
  pub(super) async fn trace_array_statement(
    &mut self,
    trace: &str,
    form: &LispValue<Sym>,
    line: usize,
  ) -> Result<(LispValue<Sym>, Option<i32>), TshScriptErrorKind> {
    let prefix = self.shell_trace_prefix(line).await?;
    if !trace.ends_with('=') {
      self.write_trace(format!("{prefix}{trace}"));
      return Ok((form.clone(), None));
    }
    let writes = self.shell_status_writes();
    let Some(expanded) = self.expand_array_assign(form, line).await? else {
      self.write_trace(format!("{prefix}{trace}"));
      return Ok((form.clone(), None));
    };
    // A substitution's status survives the assignment, as it would have
    // had the expansion run inside it.
    let status = (writes != self.shell_status_writes()).then(|| self.shell_status());
    let word = expanded.words.first().map(String::as_str).unwrap_or("");
    self.write_trace(format!("{prefix}{trace}{}", assignment_word(word)));
    Ok((expanded.form, status))
  }

  /// `declare -a d=(1 2)` under `set -x`: bash expands each initializer
  /// first and shows it as `d=('1' '2')` (every word quoted, `[k]=` kept),
  /// then the declaration. Returns the initializers rebuilt with literal
  /// words, so they do not expand again.
  pub(super) async fn trace_declaration_initializers(
    &mut self,
    initializers: &[LispValue<Sym>],
    line: usize,
  ) -> Result<Vec<LispValue<Sym>>, TshScriptErrorKind> {
    let quote = |word: &str| format!("'{}'", word.replace('\'', "'\\''"));
    let mut rebuilt = Vec::with_capacity(initializers.len());
    for initializer in initializers {
      let LispValue::List(pair) = initializer else {
        rebuilt.push(initializer.clone());
        continue;
      };
      let [list, LispValue::String(name), value] = pair.items.as_slice() else {
        rebuilt.push(initializer.clone());
        continue;
      };
      // One assignment, or a `std.sh.seq` of keyed ones.
      let (stages, seq) = match value {
        LispValue::List(seq) if self.application_head(value).as_deref() == Some("std.sh.seq") => {
          (seq.items[1..].to_vec(), Some(seq.items[0].clone()))
        }
        value => (vec![value.clone()], None),
      };
      let mut words = Vec::new();
      let mut literal = Vec::with_capacity(stages.len());
      for stage in &stages {
        match self.expand_array_assign(stage, line).await? {
          Some(expanded) => {
            // Implicit keys after an explicit one are `(K)+1` arithmetic.
            let implicit = expanded.subscript.is_empty()
              || expanded.subscript.starts_with('(') && expanded.subscript.ends_with(")+1");
            for word in &expanded.words {
              words.push(if implicit { quote(word) } else { format!("[{}]={}", quote(&expanded.subscript), quote(word)) });
            }
            literal.push(expanded.form);
          }
          None => literal.push(stage.clone()),
        }
      }
      let prefix = self.shell_trace_prefix(line).await?;
      self.write_trace(format!("{prefix}{name}=({})", words.join(" ")));
      let value = match seq {
        Some(head) => LispValue::List(tento_lisp::List { items: std::iter::once(head).chain(literal).collect() }),
        None => literal.pop().unwrap_or_else(|| value.clone()),
      };
      rebuilt.push(LispValue::List(tento_lisp::List { items: vec![list.clone(), LispValue::String(name.clone()), value].into() }));
    }
    Ok(rebuilt)
  }
}
