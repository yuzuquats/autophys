//! `(sh! …)` — bash inside a strict lisp source (operator Refinements 6, 7,
//! 9, 10 and 11, 2026-10-05).
//!
//! `.tsh` files, tsh-shebang files, `tsh run FILE` and rc files read lisp
//! only. Bash enters such a file through the `sh!` macro, which owns the text
//! of its form up to the closing `)`: the reader finds that `)` with the
//! bash front end (as for `$(…)`), so `(sh! alias ll='ls -la')` and
//! `(sh! echo "a)b" | wc -c)` are what they look like.
//!
//! Holes, Rust/xshell style, are the only lisp inside the body:
//!
//! - `{name}` is the value of the lisp name `name` as exactly one argv word
//!   (quoted for bash; inside `"…"` it is escaped for the double quotes);
//! - `{list...}` is one word per item of a list (a whole unquoted word);
//! - `{{…}}` is literal braces (`@{{upstream}}` reaches git as `@{upstream}`).
//!
//! Holes take names only — bind an expression with `let` first. Everything
//! else in braces stays bash: `${x}`, `{a,b}`, `{1..3}`, `{ cmd; }`, `{}`.
//! Single quotes are bash's: nothing inside them is a hole. A `{name}` whose
//! name is not bound is a loud error that points at `{{…}}`.
//!
//! **Semantics.** A `(sh! …)` written as a whole top-level statement runs
//! exactly as the same bash line runs in the prompt's mixed dialect: its
//! output goes where the shell's does, it sets `$?`, and a failing command
//! is a failing bash line (it halts only under `set -e`). As the value of a
//! top-level `let`, `set` or `define` its value is the exit status, as for
//! `std.sh.call`; deeper inside an expression it is a loud error, since the
//! evaluator cannot suspend there. Macros are lisp-only: bash lines, `-c`,
//! stdin and `.sh` files never see them.

use tento_lisp::Value as LispValue;

use super::bash_flow::{FlowOutput, eval_flow};
use super::interp::{LispHost, LispHostError, Sym};
use super::parser::{LineKind, classify_in};
use super::runner::TshScriptErrorKind;

/// The bash macro's head.
pub(super) const SH_MACRO: &str = "sh!";

/// The body of `chunk` when the chunk is exactly one `(sh! …)` form (a
/// trailing `;;` comment allowed).
pub(super) fn single_form_body(chunk: &str) -> Option<&str> {
  let trimmed = chunk.trim();
  let head = tento_lisp::raw_macro_head(trimmed)?;
  if !trimmed[1..head].eq(SH_MACRO) {
    return None;
  }
  let body = &trimmed[head..];
  let close = tento_lisp::raw_macro_close(body).ok()?;
  let rest = body[close + 1..].trim();
  (rest.is_empty() || rest.starts_with(";;") && !rest.contains('\n')).then(|| body[..close].trim())
}

/// Why a strict lisp source refuses a top-level chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrictRefusal {
  /// A bash-looking line: wrap it in `(sh! …)`.
  Bash,
  /// The legacy `> (form)` prompt prefix.
  LegacyPrompt,
  /// A `#` comment line (`#!` on line 1 excepted): lisp comments are `;;`.
  HashComment,
}

/// The refusal for top-level `chunk` starting at 1-based `line` of a strict
/// lisp source, if any.
pub fn strict_refusal(chunk: &str, line: usize) -> Option<StrictRefusal> {
  let trimmed = chunk.trim();
  if trimmed.is_empty() {
    return None;
  }
  if trimmed.starts_with('#') {
    return (!(line == 1 && trimmed.starts_with("#!"))).then_some(StrictRefusal::HashComment);
  }
  if let Some(rest) = trimmed.strip_prefix('>') {
    if rest.trim_start().starts_with('(') {
      return Some(StrictRefusal::LegacyPrompt);
    }
  }
  match classify_in(trimmed, false) {
    LineKind::Blank | LineKind::Comment | LineKind::LispStmt(_) => None,
    LineKind::Refused { .. } => Some(StrictRefusal::Bash),
    LineKind::Plain(text) => {
      (text.starts_with('(') || !tento_lisp::lisp_datum_line(text)).then_some(StrictRefusal::Bash)
    }
  }
}

/// Whether strict `chunk` is lisp that the mixed-dialect classifier calls
/// a posix line: a datum line (`"done"`, `42`, `'(a b)`).
pub(super) fn strict_datum(chunk: &str) -> bool {
  matches!(classify_in(chunk, false), LineKind::Plain(text) if !text.starts_with('(') && tento_lisp::lisp_datum_line(text))
}

/// The loud message for `refusal` of `chunk` at `path:line`.
pub fn strict_refusal_message(
  refusal: StrictRefusal,
  chunk: &str,
  path: Option<&std::path::Path>,
  line: usize,
) -> String {
  let at = match path {
    Some(path) => format!("{}:{line}: ", path.display()),
    None => format!("line {line}: "),
  };
  format!("{at}{}", refusal_text(refusal, chunk))
}

/// The refusal's teaching text, without a location.
fn refusal_text(refusal: StrictRefusal, chunk: &str) -> String {
  let text = chunk.trim();
  let first = text.lines().next().unwrap_or_default();
  match refusal {
    StrictRefusal::Bash => {
      let example = if text.contains('\n') || first.chars().count() > 60 {
        "(sh! …)".to_string()
      } else {
        format!("(sh! {first})")
      };
      format!("`{first}` looks like bash; wrap it: (sh! …) — {example} in a lisp file (.tsh, rc, tsh run)")
    }
    StrictRefusal::LegacyPrompt => {
      let form = first.trim_start_matches('>').trim_start();
      format!("a leading `>` is not lisp (the legacy `> (form)` prefix is gone): write `{form}`")
    }
    StrictRefusal::HashComment => {
      let rest = first.trim_start_matches('#');
      format!("comments in lisp files are `;;`: write `;;{rest}`")
    }
  }
}

/// Every refused top-level chunk of strict `source`: (1-based line, refusal).
pub fn strict_refusals(source: &str) -> Vec<(usize, StrictRefusal, String)> {
  super::runner::coalesce_balanced_lines(source)
    .filter_map(|(line, chunk)| strict_refusal(&chunk, line).map(|refusal| (line, refusal, chunk.into_owned())))
    .collect()
}

/// `source` with every refused chunk blanked (its lines kept, so line
/// numbers hold), and the refusal messages. For a seed (the prelude) that
/// is evaluated form by form: a refused line is reported, never evaluated.
pub(super) fn blank_refusals(source: &str) -> (std::borrow::Cow<'_, str>, Vec<(usize, String)>) {
  let refusals = strict_refusals(source);
  if refusals.is_empty() {
    return (std::borrow::Cow::Borrowed(source), Vec::new());
  }
  let mut lines: Vec<String> = source.lines().map(str::to_string).collect();
  let mut messages = Vec::new();
  for (line, refusal, chunk) in refusals {
    for offset in 0..chunk.lines().count().max(1) {
      if let Some(slot) = lines.get_mut(line - 1 + offset) {
        slot.clear();
      }
    }
    messages.push((line, refusal_text(refusal, &chunk)));
  }
  (std::borrow::Cow::Owned(lines.join("\n")), messages)
}

fn runtime(message: String) -> TshScriptErrorKind {
  TshScriptErrorKind::Lisp(LispHostError::Runtime(message))
}

/// Bash's single-quoted spelling of `word`: one word, nothing expanded.
fn single_quoted(word: &str) -> String {
  format!("'{}'", word.replace('\'', r"'\''"))
}

/// `word` escaped for the inside of bash double quotes.
fn double_escaped(word: &str) -> String {
  let mut out = String::with_capacity(word.len());
  for c in word.chars() {
    if matches!(c, '\\' | '"' | '$' | '`') {
      out.push('\\');
    }
    out.push(c);
  }
  out
}

/// A hole name at `chars[at..]`: `[A-Za-z_][A-Za-z0-9_-]*` segments joined
/// by single dots, then an optional `...`, then `}`. Returns (name, list,
/// index just past the `}`).
fn hole_at(chars: &[char], at: usize) -> Option<(String, bool, usize)> {
  let ident_start = |c: char| c.is_ascii_alphabetic() || c == '_';
  let ident = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-');
  let mut i = at;
  let mut name = String::new();
  loop {
    if !chars.get(i).copied().is_some_and(ident_start) {
      return None;
    }
    while let Some(&c) = chars.get(i).filter(|c| ident(**c)) {
      name.push(c);
      i += 1;
    }
    if chars.get(i) == Some(&'.') && chars.get(i + 1).copied().is_some_and(ident_start) {
      name.push('.');
      i += 1;
      continue;
    }
    break;
  }
  let list = chars.get(i..i + 3) == Some(&['.', '.', '.'][..]);
  if list {
    i += 3;
  }
  (chars.get(i) == Some(&'}')).then_some((name, list, i + 1))
}

/// Whether `c` (or the text edge) bounds a bash word.
fn word_edge(c: Option<&char>) -> bool {
  c.is_none_or(|c| c.is_whitespace() || matches!(c, ';' | '|' | '&' | '(' | ')' | '<' | '>'))
}

impl LispHost {
  /// The value of hole `name`: its lisp binding (a dotted name may also be
  /// a member path), or the loud unbound error.
  fn sh_hole_value(&mut self, name: &str) -> Result<LispValue<Sym>, TshScriptErrorKind> {
    let symbol = self.interp.string_interner().get_or_intern(name);
    if let Some(value) = self.env.borrow().get(symbol) {
      return Ok(value);
    }
    if name.contains('.') {
      let expr = LispValue::Symbol(symbol.into());
      if let Ok(value) = self.interp.eval_expression(self.env.clone(), &expr) {
        return Ok(value);
      }
    }
    Err(runtime(format!(
      "sh!: `{{{name}}}` is a hole, and `{name}` is not a bound lisp name: bind it first, (let {name} …), \
       or write `{{{{{name}}}}}` for literal braces (git's `@{{upstream}}` is written `@{{{{upstream}}}}`)"
    )))
  }

  /// One argv word for a hole's scalar value.
  fn sh_hole_word(&mut self, name: &str, value: &LispValue<Sym>) -> Result<String, TshScriptErrorKind> {
    Ok(match value {
      LispValue::String(text) => text.to_string(),
      LispValue::Integer(n) => n.to_string(),
      LispValue::Float(x) => x.to_string(),
      LispValue::Boolean(b) => b.to_string(),
      LispValue::Symbol(symbol) => {
        self.interp.string_interner().resolve(symbol.as_symbol()).unwrap_or_default().to_string()
      }
      LispValue::List(_) => {
        return Err(runtime(format!("sh!: `{{{name}}}` is a list; splice it one word per item with `{{{name}...}}`")));
      }
      LispValue::Nil => return Err(runtime(format!("sh!: `{{{name}}}` is nil; a hole is exactly one word"))),
      _ => return Err(runtime(format!("sh!: `{{{name}}}` is not a string or number; bind the word you mean first"))),
    })
  }

  /// The bash text of a `(sh! BODY)` form: BODY with its holes filled.
  pub(super) fn expand_sh_macro(&mut self, body: &str) -> Result<String, TshScriptErrorKind> {
    if !body.contains('{') {
      return Ok(body.to_string());
    }
    #[derive(Clone, Copy, PartialEq)]
    enum Quote {
      None,
      Single,
      AnsiC,
      Double,
    }
    let chars: Vec<char> = body.chars().collect();
    let mut out = String::with_capacity(body.len());
    let mut quote = Quote::None;
    let mut i = 0;
    while i < chars.len() {
      let c = chars[i];
      match quote {
        Quote::Single => {
          out.push(c);
          if c == '\'' {
            quote = Quote::None;
          }
          i += 1;
          continue;
        }
        Quote::AnsiC => {
          out.push(c);
          if c == '\\' {
            if let Some(&next) = chars.get(i + 1) {
              out.push(next);
              i += 1;
            }
          } else if c == '\'' {
            quote = Quote::None;
          }
          i += 1;
          continue;
        }
        Quote::None | Quote::Double => {}
      }
      match c {
        '\\' => {
          out.push(c);
          if let Some(&next) = chars.get(i + 1) {
            out.push(next);
            i += 1;
          }
        }
        '\'' if quote == Quote::None => {
          quote = Quote::Single;
          out.push(c);
        }
        '$' if quote == Quote::None && chars.get(i + 1) == Some(&'\'') => {
          quote = Quote::AnsiC;
          out.push_str("$'");
          i += 1;
        }
        '"' => {
          quote = if quote == Quote::Double { Quote::None } else { Quote::Double };
          out.push(c);
        }
        // `${…}` is bash's, braces and all.
        '$' if chars.get(i + 1) == Some(&'{') => {
          let mut depth = 0usize;
          let start = i;
          i += 1;
          while i < chars.len() {
            match chars[i] {
              '{' => depth += 1,
              '}' => {
                depth -= 1;
                if depth == 0 {
                  break;
                }
              }
              _ => {}
            }
            i += 1;
          }
          out.extend(&chars[start..(i + 1).min(chars.len())]);
        }
        '{' if chars.get(i + 1) == Some(&'{') => {
          // `{{…}}`: literal braces around the text up to the next `}}`.
          let close = (i + 2..chars.len().saturating_sub(1)).find(|&j| chars[j] == '}' && chars[j + 1] == '}');
          match close {
            Some(close) => {
              out.push('{');
              out.extend(&chars[i + 2..close]);
              out.push('}');
              i = close + 2;
            }
            None => {
              out.push_str("{{");
              i += 2;
            }
          }
          continue;
        }
        '{' => match hole_at(&chars, i + 1) {
          None => out.push(c),
          Some((name, list, next)) => {
            let value = self.sh_hole_value(&name)?;
            if list {
              let whole_word = quote == Quote::None && word_edge(i.checked_sub(1).map(|at| &chars[at])) && word_edge(chars.get(next));
              if !whole_word {
                return Err(runtime(format!(
                  "sh!: `{{{name}...}}` splices one word per item, so it must be a whole unquoted word"
                )));
              }
              let LispValue::List(items) = &value else {
                return Err(runtime(format!("sh!: `{{{name}...}}` needs a list; `{name}` is one value — write `{{{name}}}`")));
              };
              let words = items
                .items
                .iter()
                .map(|item| self.sh_hole_word(&name, item).map(|word| single_quoted(&word)))
                .collect::<Result<Vec<_>, _>>()?;
              out.push_str(&words.join(" "));
            } else {
              let word = self.sh_hole_word(&name, &value)?;
              if quote == Quote::Double {
                out.push_str(&double_escaped(&word));
              } else {
                out.push_str(&single_quoted(&word));
              }
            }
            i = next;
            continue;
          }
        },
        _ => out.push(c),
      }
      i += 1;
    }
    Ok(out)
  }

  /// Refuse a `(sh! …)` left inside `value` (one the statement door did not
  /// run): the evaluator cannot suspend inside an expression. Quoted data
  /// is not code and is left alone.
  pub(super) fn refuse_nested_sh_macro(&mut self, value: &LispValue<Sym>) -> Result<(), TshScriptErrorKind> {
    // Nothing has ever read a `sh!` symbol: no walk needed.
    if self.interp.string_interner().get(SH_MACRO).is_none() {
      return Ok(());
    }
    self.refuse_nested_sh_macro_in(value)
  }

  fn refuse_nested_sh_macro_in(&mut self, value: &LispValue<Sym>) -> Result<(), TshScriptErrorKind> {
    let LispValue::List(list) = value else { return Ok(()) };
    match self.application_head(value).as_deref() {
      Some("quote") => return Ok(()),
      Some(SH_MACRO) => {
        return Err(runtime(
          "(sh! …) runs bash as a statement: write it as a whole top-level form, or as the value of a top-level let, set or define (it cannot run inside a larger lisp expression)".to_string(),
        ));
      }
      _ => {}
    }
    for item in &list.items {
      self.refuse_nested_sh_macro_in(item)?;
    }
    Ok(())
  }

  /// Run `(sh! BODY)` in a statement's value position: the bash text runs
  /// in this shell and the value is its exit status.
  pub(super) async fn run_sh_macro_value(&mut self, form: &LispValue<Sym>) -> Result<LispValue<Sym>, TshScriptErrorKind> {
    let LispValue::List(list) = form else { unreachable!() };
    let Some(LispValue::String(body)) = list.items.get(1) else {
      return Err(runtime("sh!: expected (sh! BASH…)".to_string()));
    };
    let text = self.expand_sh_macro(&body.clone())?;
    if text.trim().is_empty() {
      return Ok(LispValue::Integer(0));
    }
    let parsed = self.read_posix_line_value_in(&text, false).map_err(TshScriptErrorKind::Lisp)?;
    let output = FlowOutput::default();
    let line = super::bash_attributes::current_line();
    let value = eval_flow(self, &parsed, line, false, output.clone(), false).await?;
    output.flush_value(self, value);
    Ok(LispValue::Integer(i64::from(self.shell_status())))
  }
}

#[cfg(test)]
#[path = "sh_macro_tests.rs"]
mod tests;
