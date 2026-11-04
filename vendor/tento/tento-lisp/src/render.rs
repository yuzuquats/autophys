//! Rendering an [`SExpression`] back to source — the inverse of the readers,
//! for inspection and round-trip checks.
//!
//! - [`render_lisp`] is the **canonical** form: lisp is the unambiguous syntax,
//!   so parsing the output yields an s-expression equal to the input for *any*
//!   expression (strings, symbols, keywords, numbers, booleans, nested forms).
//! - [`render_posix`] is the **command-line** form: `(ls :all "/tmp")` →
//!   `ls --all /tmp`, a `:keyword` → `--flag`, a reference `Symbol` → `$name`, a
//!   nested call → `$(…)`, a `(let name …)` → `name=…`. It is *idempotent on the
//!   posix-producible subset* (`read_posix(render_posix(read_posix(line)))` ==
//!   `read_posix(line)`): the posix reader makes every arg a string, so a
//!   rendered numeric/boolean re-reads as that string — the same asymmetry the
//!   reader already documents, not a new loss.
//!   Bash words cannot contain NUL, so strings containing NUL have no lossless
//!   command-line representation.

use crate::grammar::{Literal, SExpression};
use crate::posix_reader::is_dollar_ident;
use crate::symbol::{Backend, Symbol};
use string_interner::StringInterner;

/// Render `expr` as canonical lisp source. A `String` literal is quoted and
/// escaped; a `Symbol` (a head, a `:keyword`, a reference) is bare; a list is
/// parenthesized and space-separated. `parse(render_lisp(e)) == e`.
pub fn render_lisp<S, B>(expr: &SExpression<S>, interner: &StringInterner<B>) -> String
where
  S: Symbol,
  B: Backend<S>,
{
  let mut out = String::new();
  write_lisp(expr, interner, &mut out);
  out
}

fn write_lisp<S, B>(expr: &SExpression<S>, interner: &StringInterner<B>, out: &mut String)
where
  S: Symbol,
  B: Backend<S>,
{
  match expr {
    SExpression::Literal(lit) => match lit {
      Literal::Boolean(b) => out.push_str(if *b { "true" } else { "false" }),
      Literal::Integer(n) => out.push_str(&n.to_string()),
      Literal::Float(x) => out.push_str(&render_float(*x)),
      Literal::String(s) => {
        out.push('"');
        escape_lisp_string(s, out);
        out.push('"');
      }
      Literal::Symbol(sym) => out.push_str(interner.resolve(*sym).unwrap_or("")),
      Literal::TaggedString { tag, payload } => {
        // The short form ends at the first backtick, so a payload holding one
        // must render in the long form (fuzz finding F4). A payload holding
        // ``` has no representation in either form.
        let fence = if payload.contains('`') { "```" } else { "`" };
        out.push_str(tag);
        out.push_str(fence);
        out.push_str(payload);
        out.push_str(fence);
      }
    },
    // A raw macro reads back from its raw text, not from a string literal.
    SExpression::List(items)
      if matches!(items.as_slice(), [SExpression::Literal(Literal::Symbol(head)), SExpression::Literal(Literal::String(_))]
        if crate::posix_reader::RAW_MACROS.contains(&interner.resolve(*head).unwrap_or(""))) =>
    {
      let [SExpression::Literal(Literal::Symbol(head)), SExpression::Literal(Literal::String(body))] = items.as_slice() else {
        unreachable!()
      };
      out.push('(');
      out.push_str(interner.resolve(*head).unwrap_or(""));
      if !body.is_empty() {
        out.push(' ');
        out.push_str(body);
      }
      out.push(')');
    }
    SExpression::List(items) => {
      out.push('(');
      for (i, it) in items.iter().enumerate() {
        if i > 0 {
          out.push(' ');
        }
        write_lisp(it, interner, out);
      }
      out.push(')');
    }
  }
}

/// Render `expr` as a posix command line. A top-level `(let name value)` becomes
/// the assignment `name=value`; any other list is `head arg…`. See the module
/// docs for the idempotence contract. A bare (non-list) expression has no
/// command-line form, so its canonical lisp form is returned.
pub fn render_posix<S, B>(expr: &SExpression<S>, interner: &StringInterner<B>) -> String
where
  S: Symbol,
  B: Backend<S>,
{
  match expr {
    SExpression::List(items) => {
      // `(let <name-symbol> <value>)` is the posix assignment `name=value` —
      // the inverse of `read_statement`'s capture lowering.
      if let [head, name, value] = items.as_slice() {
        if symbol_is(head, "let", interner) {
          if let SExpression::Literal(Literal::Symbol(n)) = name {
            let mut out = String::new();
            out.push_str(interner.resolve(*n).unwrap_or(""));
            out.push('=');
            write_posix_value(value, interner, &mut out);
            return out;
          }
        }
      }
      let mut out = String::new();
      write_posix_command(items, interner, &mut out);
      out
    }
    SExpression::Literal(_) => render_lisp(expr, interner),
  }
}

#[derive(Default)]
struct Heredocs {
  bodies: Vec<String>,
  eof: std::collections::VecDeque<String>,
  closed_before_eof: usize,
}

/// `head arg…`: the head is a bare command word, each later item a posix value.
fn write_posix_command<S, B>(
  items: &[SExpression<S>],
  interner: &StringInterner<B>,
  out: &mut String,
) where
  S: Symbol,
  B: Backend<S>,
{
  let mut heredocs = Heredocs::default();
  if write_shell_form(items, interner, out, &mut heredocs) {
    if !heredocs.bodies.is_empty() {
      out.push('\n');
      for body in heredocs.bodies {
        out.push_str(&body);
      }
    }
    return;
  }
  if let [head, command, SExpression::List(argv)] = items {
    if symbol_is(head, "apply", interner)
      && argv
        .first()
        .is_some_and(|h| symbol_is(h, "append", interner))
    {
      write_posix_command(std::slice::from_ref(command), interner, out);
      for word in &argv[1..] {
        out.push(' ');
        if let SExpression::List(single) = word {
          if let [head, value] = single.as_slice() {
            if symbol_is(head, "list", interner) {
              write_posix_value(value, interner, out);
              continue;
            }
          }
        }
        write_posix_value(word, interner, out);
      }
      return;
    }
  }
  for (i, it) in items.iter().enumerate() {
    if i > 0 {
      out.push(' ');
    }
    if i == 0 {
      // The head is a bare command word — quoted only when bare text would
      // not read back as one word (empty, or holding whitespace/quotes: fuzz
      // finding F5, `""` rendered to nothing). Computed heads use the same
      // quoted-expansion rules as arguments.
      match it {
        SExpression::Literal(Literal::Symbol(s)) => {
          write_posix_word(interner.resolve(*s).unwrap_or(""), out)
        }
        other => write_posix_value(other, interner, out),
      }
    } else {
      write_posix_value(it, interner, out);
    }
  }
}

/// A posix arg / assignment rhs: a nested call → `$(…)`; a `:keyword` Symbol →
/// `--flag`; any other Symbol → a `$ref`; a `String` → a (quoted-if-needed)
/// word; a scalar → its bare text (re-read as a string, per the reader's rule).
fn write_posix_value<S, B>(expr: &SExpression<S>, interner: &StringInterner<B>, out: &mut String)
where
  S: Symbol,
  B: Backend<S>,
{
  match expr {
    SExpression::List(items) => {
      // A quoted command word stays quoted, so it reads back as the marker.
      if let [head, SExpression::Literal(Literal::String(word))] = items.as_slice() {
        if symbol_is(head, crate::posix_reader::QUOTED_WORD, interner) {
          out.push('\'');
          out.push_str(&word.replace('\'', "'\\''"));
          out.push('\'');
          return;
        }
      }
      if items.first().is_some_and(|h|
        symbol_is(h, "str", interner) || symbol_is(h, "str.concat", interner)) {
        if items[1..].iter().any(|part| process_substitution(part, interner).is_some()) {
          // Process substitutions are word fragments outside quotes. Keep the
          // other fragments protected without adding an empty literal part.
          let mut quoted = false;
          for part in &items[1..] {
            if process_substitution(part, interner).is_some() {
              if quoted { out.push('"'); quoted = false; }
              write_expansion(part, interner, out);
            } else {
              if !quoted { out.push('"'); quoted = true; }
              write_quoted_part(part, interner, out);
            }
          }
          if quoted { out.push('"'); }
        } else {
          out.push('"');
          for part in &items[1..] {
            write_quoted_part(part, interner, out);
          }
          out.push('"');
        }
        return;
      }
      if let [head, SExpression::List(parts)] = items.as_slice() {
        if symbol_is(head, "std.sh.split", interner) {
          for part in &parts[1..] {
            if let SExpression::List(descriptor) = part {
              match descriptor.as_slice() {
                [_, SExpression::Literal(Literal::Boolean(unquoted)), value] => {
                  write_word_part(value, *unquoted, false, interner, out);
                }
                [
                  _,
                  SExpression::Literal(Literal::Boolean(unquoted)),
                  value,
                  SExpression::Literal(Literal::Boolean(glob)),
                  ..
                ] => {
                  write_word_part(value, *unquoted, *glob, interner, out);
                }
                _ => {}
              }
            }
          }
          return;
        }
      }
      if write_expansion(expr, interner, out) {
        return;
      }
      out.push_str("$(");
      write_posix_command(items, interner, out);
      out.push(')');
    }
    SExpression::Literal(lit) => match lit {
      Literal::Symbol(s) => {
        let name = interner.resolve(*s).unwrap_or("");
        if let Some(flag) = name.strip_prefix(':') {
          out.push_str("--");
          out.push_str(flag);
        } else if let Some(directive) = name.strip_prefix('#') {
          // The reader's reserved `--json` / `--help` directives (fuzz finding
          // F9: `#json` rendered as the `$#json` reference, re-read as a word).
          out.push_str("--");
          out.push_str(directive);
        } else {
          out.push('$');
          out.push_str(name);
        }
      }
      Literal::String(s) => write_posix_word(s, out),
      Literal::Boolean(b) => out.push_str(if *b { "true" } else { "false" }),
      Literal::Integer(n) => out.push_str(&n.to_string()),
      Literal::Float(x) => out.push_str(&render_float(*x)),
      Literal::TaggedString { .. } => out.push_str(&render_lisp(expr, interner)),
    },
  }
}

fn write_word_part<S, B>(
  value: &SExpression<S>,
  unquoted: bool,
  glob: bool,
  interner: &StringInterner<B>,
  out: &mut String,
) where
  S: Symbol,
  B: Backend<S>,
{
  if process_substitution(value, interner).is_some() {
    write_expansion(value, interner, out);
  } else if unquoted {
    if !write_expansion(value, interner, out) {
      write_posix_value(value, interner, out);
    }
  } else if glob {
    if let SExpression::Literal(Literal::String(text)) = value {
      // This run came from unquoted source. Quoted or escaped characters
      // have their own protected descriptor and are printed separately.
      out.push_str(text);
    } else {
      write_posix_value(value, interner, out);
    }
  } else if let SExpression::Literal(Literal::String(text)) = value {
    out.push('"');
    write_quoted_text(text, out);
    out.push('"');
  } else {
    out.push('"');
    write_quoted_part(value, interner, out);
    out.push('"');
  }
}

fn write_plan_expr<S, B>(
  expr: &SExpression<S>,
  interner: &StringInterner<B>,
  out: &mut String,
  heredocs: &mut Heredocs,
) where
  S: Symbol,
  B: Backend<S>,
{
  let SExpression::List(items) = expr else {
    write_posix_value(expr, interner, out);
    return;
  };
  // Precedence and left association are already represented by the plan.
  // Only an explicit std.sh.group may add a source group.
  if !write_shell_form(items, interner, out, heredocs) {
    write_posix_command(items, interner, out);
  }
}

// The reader's execution plans are syntax. Print their Bash spellings rather
// than treating a flow, descriptor list or builtin helper as a substitution.
fn write_shell_form<S, B>(
  items: &[SExpression<S>],
  interner: &StringInterner<B>,
  out: &mut String,
  heredocs: &mut Heredocs,
) -> bool
where
  S: Symbol,
  B: Backend<S>,
{
  let Some(head) = items.first() else {
    return false;
  };
  if let [_, SExpression::Literal(Literal::Symbol(name)), value] = items {
    if symbol_is(head, "let", interner) {
      out.push_str(interner.resolve(*name).unwrap_or(""));
      out.push('=');
      write_posix_value(value, interner, out);
      return true;
    }
  }
  if let [_, SExpression::Literal(Literal::String(name)), index,
    SExpression::Literal(Literal::Boolean(append)), values] = items {
    if symbol_is(head, "std.sh.array-assign", interner) {
      out.push_str(name);
      let initializer = matches!(index, SExpression::Literal(Literal::String(text)) if text.is_empty());
      if !initializer {
        out.push('[');
        write_array_subscript(index, interner, out);
        out.push(']');
      }
      out.push_str(if *append { "+=" } else { "=" });
      if initializer {
        out.push('(');
        if let SExpression::List(words) = values {
          if words.first().is_some_and(|h| symbol_is(h, "apply", interner)) {
            if let Some(SExpression::List(args)) = words.get(2) {
              for (index, word) in args[1..].iter().enumerate() {
                if index > 0 { out.push(' '); }
                write_array_word(word, interner, out);
              }
            }
          } else {
            for (index, word) in words[1..].iter().enumerate() {
              if index > 0 { out.push(' '); }
              write_posix_value(word, interner, out);
            }
          }
        }
        out.push(')');
      } else if let SExpression::List(words) = values {
        if let Some(word) = words.get(1) { write_posix_value(word, interner, out); }
      }
      return true;
    }
  }
  if symbol_is(head, "std.sh.seq", interner) {
    let mut start = 1;
    while let Some(SExpression::List(warning)) = items.get(start) {
      let [h, SExpression::Literal(Literal::String(delimiter))] = warning.as_slice() else { break; };
      if !symbol_is(h, "std.sh.heredoc-warning", interner) { break; }
      // Keep the original unterminated delimiter and body: adding a closing
      // marker would remove the EOF warning and can add a byte to the body.
      heredocs.eof.push_back(delimiter.clone());
      start += 1;
    }
    if start > 1 {
      let total: usize = items[start..].iter().map(|stage| count_heredocs(stage, interner)).sum();
      heredocs.closed_before_eof = total.saturating_sub(heredocs.eof.len());
      for (index, stage) in items[start..].iter().enumerate() {
        if index > 0 { out.push_str("; "); }
        write_plan_expr(stage, interner, out, heredocs);
      }
      return true;
    }
  }
  if symbol_is(head, "std.sh.unset", interner) {
    out.push_str("unset");
    for arg in &items[1..] {
      out.push(' ');
      write_posix_value(arg, interner, out);
    }
    return true;
  }
  if let [_, SExpression::Literal(Literal::Boolean(disabled))] = items {
    if symbol_is(head, "std.sh.noglob", interner) {
      out.push_str(if *disabled { "set -f" } else { "set +f" });
      return true;
    }
  }
  // A computed command word (`$cmd args`, or a quoted word the prompt must
  // not expand): `(std.sh.cmd (append (list w) fields …))` (std.sh.cmd merged
  // into std.sh.cmd, argv.md I17).
  if let [_, SExpression::List(fields)] = items {
    if symbol_is(head, "std.sh.cmd", interner) && fields.first().is_some_and(|h| symbol_is(h, "append", interner)) {
      for (index, word) in fields[1..].iter().enumerate() {
        if index > 0 {
          out.push(' ');
        }
        if let SExpression::List(single) = word {
          if let [h, value] = single.as_slice() {
            if symbol_is(h, "list", interner) {
              write_posix_value(value, interner, out);
              continue;
            }
          }
        }
        write_posix_value(word, interner, out);
      }
      return true;
    }
  }
  // A bash simple command is its words: `(std.sh.cmd "echo" "a b")` → `echo "a b"`.
  if symbol_is(head, "std.sh.cmd", interner) && items.len() > 1 {
    for (index, word) in items[1..].iter().enumerate() {
      if index > 0 {
        out.push(' ');
      }
      match word {
        // An unmarked name was unquoted in its source (a quoted one carries
        // `std.sh.word.quoted`), so print it bare whenever bash reads it back.
        SExpression::Literal(Literal::String(name)) if index == 0 && bare_command_word(name) => {
          out.push_str(name);
        }
        _ => write_posix_value(word, interner, out),
      }
    }
    return true;
  }
  // The prompt's display marker is invisible in Bash source.
  if let [_, body] = items {
    if symbol_is(head, "std.sh.display", interner) {
      write_plan_expr(body, interner, out, heredocs);
      return true;
    }
  }
  // An array assignment's xtrace text is its source: `name=(words)` whole,
  // or `name[SUB]=` before the value word.
  if let [_, SExpression::Literal(Literal::String(trace)), body] = items {
    if symbol_is(head, "std.sh.array-traced", interner) {
      out.push_str(trace);
      if trace.ends_with('=') {
        if let SExpression::List(assign) = body {
          if let Some(SExpression::List(values)) = assign.get(4) {
            if let Some(value) = values.get(1) { write_posix_value(value, interner, out); }
          }
        }
      }
      return true;
    }
  }
  // So is a member's source-line marker.
  if let [_, SExpression::Literal(Literal::Integer(_)), body] = items {
    if symbol_is(head, "std.sh.line", interner) {
      write_plan_expr(body, interner, out, heredocs);
      return true;
    }
  }
  if let [_, body] = items {
    if symbol_is(head, "std.sh.group", interner) {
      out.push_str("{ ");
      write_plan_expr(body, interner, out, heredocs);
      out.push_str("; }");
      return true;
    }
  }
  let separator = if symbol_is(head, "std.sh.assign", interner) {
    Some(" ")
  } else if symbol_is(head, "std.sh.seq", interner) {
    Some("; ")
  } else if symbol_is(head, "std.sh.and", interner) {
    Some(" && ")
  } else if symbol_is(head, "std.sh.or", interner) {
    Some(" || ")
  } else if symbol_is(head, "std.sh.pipe", interner) {
    Some(" | ")
  } else {
    None
  };
  if let Some(separator) = separator {
    for (index, stage) in items[1..].iter().enumerate() {
      if index > 0 {
        out.push_str(separator);
      }
      write_plan_expr(stage, interner, out, heredocs);
    }
    return true;
  }
  if let [_, stage] = items {
    if symbol_is(head, "std.sh.not", interner) {
      out.push_str("! ");
      write_plan_expr(stage, interner, out, heredocs);
      return true;
    }
  }
  if let [_, stage, SExpression::List(specs)] = items {
    if symbol_is(head, "std.sh.redirect", interner) {
      // Environment prefixes stay inside a surrounding descriptor scope, in
      // their original order; the reader reconstructs the same nested plans.
      for spec in &specs[1..] {
        if let SExpression::List(fields) = spec {
          if let [
            _,
            SExpression::Literal(Literal::String(kind)),
            SExpression::Literal(Literal::String(key)),
            value,
          ] = fields.as_slice()
          {
            if kind == "env" && !key.starts_with(['<', '>', '&']) {
              out.push_str(key);
              out.push('=');
              write_posix_value(value, interner, out);
              out.push(' ');
            }
          }
        }
      }
      if matches!(stage, SExpression::List(values) if values.len() == 1 && symbol_is(&values[0], "begin", interner))
      {
        out.push(':');
      } else {
        write_plan_expr(stage, interner, out, heredocs);
      }
      for spec in &specs[1..] {
        let SExpression::List(fields) = spec else {
          continue;
        };
        let [_, fd, SExpression::Literal(Literal::String(op)), target] = fields.as_slice()
        else {
          continue;
        };
        if matches!(fd, SExpression::Literal(Literal::String(kind)) if kind == "env")
          && !op.starts_with(['<', '>', '&']) {
          continue;
        }
        out.push(' ');
        match fd {
          SExpression::Literal(Literal::Integer(fd)) if *fd >= 0 => out.push_str(&fd.to_string()),
          SExpression::Literal(Literal::String(name)) => {
            out.push('{'); out.push_str(name); out.push('}');
          }
          _ => {}
        }
        out.push_str(op);
        if op == "<<" {
          let literal = matches!(target, SExpression::Literal(Literal::String(_)));
          let mut body = String::new();
          write_heredoc_value(target, interner, &mut body, literal);
          let eof = if heredocs.closed_before_eof > 0 {
            heredocs.closed_before_eof -= 1;
            None
          } else {
            heredocs.eof.pop_front()
          };
          let mut ordinal = heredocs.bodies.len();
          let mut marker = eof.clone().unwrap_or_else(|| format!("TSH_RENDER_HEREDOC_{ordinal}"));
          while eof.is_none() && body.lines().any(|line| line == marker) {
            ordinal += 1;
            marker = format!("TSH_RENDER_HEREDOC_{ordinal}");
          }
          if literal {
            out.push('\'');
          }
          if literal {
            out.push_str(&marker.replace('\'', "'\\''"));
          } else {
            out.push_str(&marker);
          }
          if literal {
            out.push('\'');
          }
          if eof.is_none() {
            if !body.is_empty() && !body.ends_with('\n') { body.push('\n'); }
            body.push_str(&marker);
            body.push('\n');
          }
          heredocs.bodies.push(body);
        } else if let SExpression::List(word) = target {
          if let [h, _, SExpression::Literal(Literal::String(source))] = word.as_slice() {
            if symbol_is(h, "std.sh.redirect-word", interner) || symbol_is(h, "std.sh.redirect-fields", interner) {
              out.push_str(source);
              continue;
            }
          }
          write_posix_value(target, interner, out);
        } else {
          write_posix_value(target, interner, out);
        }
      }
      return true;
    }
  }
  false
}

fn count_heredocs<S, B>(expr: &SExpression<S>, interner: &StringInterner<B>) -> usize
where S: Symbol, B: Backend<S> {
  let SExpression::List(items) = expr else { return 0; };
  if let [head, stage, SExpression::List(specs)] = items.as_slice() {
    if symbol_is(head, "std.sh.redirect", interner) {
      return count_heredocs(stage, interner) + specs[1..].iter().filter(|spec|
        matches!(spec, SExpression::List(fields) if matches!(fields.get(2),
          Some(SExpression::Literal(Literal::String(op))) if op == "<<"))).count();
    }
  }
  if matches!(items.first(), Some(SExpression::Literal(Literal::Symbol(head)))
    if interner.resolve(*head).is_some_and(|name| crate::posix_reader::SH_FLOW_FORMS.contains(&name)
      || name == crate::posix_reader::SPAWN_FORM)) {
    items[1..].iter().map(|stage| count_heredocs(stage, interner)).sum()
  } else {
    0
  }
}

fn write_array_word<S, B>(expr: &SExpression<S>, interner: &StringInterner<B>, out: &mut String)
where S: Symbol, B: Backend<S> {
  if let SExpression::List(word) = expr {
    if let [head, value] = word.as_slice() {
      if symbol_is(head, "list", interner) {
        write_posix_value(value, interner, out);
        return;
      }
    }
  }
  write_posix_value(expr, interner, out);
}

fn write_array_subscript<S, B>(expr: &SExpression<S>, interner: &StringInterner<B>, out: &mut String)
where S: Symbol, B: Backend<S> {
  if let SExpression::List(items) = expr {
    if let [head, _, source] = items.as_slice() {
      if symbol_is(head, "std.sh.array-index", interner) {
        write_array_subscript(source, interner, out);
        return;
      }
    }
    if items.first().is_some_and(|head| symbol_is(head, "str.concat", interner)) {
      for part in &items[1..] { write_array_subscript(part, interner, out); }
      return;
    }
    if let [head, value] = items.as_slice() {
      if symbol_is(head, "std.sh.scalar", interner) {
        write_posix_value(value, interner, out);
        return;
      }
    }
  }
  write_arithmetic_source(expr, interner, out);
}

fn write_arithmetic_source<S, B>(expr: &SExpression<S>, interner: &StringInterner<B>, out: &mut String)
where S: Symbol, B: Backend<S> {
  if let SExpression::List(items) = expr {
    if let [head, source] = items.as_slice() {
      if symbol_is(head, "std.sh.arith", interner) {
        write_arithmetic_source(source, interner, out);
        return;
      }
    }
    if items.first().is_some_and(|head| symbol_is(head, "str.concat", interner)) {
      for part in &items[1..] { write_arithmetic_source(part, interner, out); }
      return;
    }
  }
  if let SExpression::Literal(Literal::String(source)) = expr {
    out.push_str(source);
  } else {
    write_expansion(expr, interner, out);
  }
}

fn write_heredoc_value<S, B>(
  value: &SExpression<S>,
  interner: &StringInterner<B>,
  out: &mut String,
  quoted: bool,
) where
  S: Symbol,
  B: Backend<S>,
{
  if let SExpression::Literal(Literal::String(text)) = value {
    for c in text.chars() {
      if !quoted && matches!(c, '\\' | '$' | '`') {
        out.push('\\');
      }
      out.push(c);
    }
  } else if let SExpression::List(parts) = value {
    if parts.first().is_some_and(|h|
      symbol_is(h, "str", interner) || symbol_is(h, "str.concat", interner)) {
      for part in &parts[1..] {
        write_heredoc_value(part, interner, out, quoted);
      }
    } else {
      write_expansion(value, interner, out);
    }
  }
}

fn write_quoted_text(text: &str, out: &mut String) {
  for c in text.chars() {
    if matches!(c, '"' | '\\' | '$' | '`') {
      out.push('\\');
    }
    out.push(c);
  }
}

fn write_quoted_part<S, B>(expr: &SExpression<S>, interner: &StringInterner<B>, out: &mut String)
where
  S: Symbol,
  B: Backend<S>,
{
  if let SExpression::Literal(Literal::String(text)) = expr {
    write_quoted_text(text, out);
  } else if !write_expansion(expr, interner, out) {
    write_posix_value(expr, interner, out);
  }
}

fn process_substitution<'a, S, B>(
  expr: &'a SExpression<S>,
  interner: &StringInterner<B>,
) -> Option<(bool, &'a SExpression<S>)>
where
  S: Symbol,
  B: Backend<S>,
{
  if let SExpression::List(items) = expr {
    if let [head, SExpression::Literal(Literal::Boolean(output)), body] = items.as_slice() {
      if symbol_is(head, "std.sh.process-sub", interner) {
        return Some((*output, body));
      }
    }
  }
  None
}

fn write_expansion<S, B>(
  expr: &SExpression<S>,
  interner: &StringInterner<B>,
  out: &mut String,
) -> bool
where
  S: Symbol,
  B: Backend<S>,
{
  let SExpression::List(items) = expr else {
    return false;
  };
  if let Some((output, body)) = process_substitution(expr, interner) {
    out.push_str(if output { ">(" } else { "<(" });
    out.push_str(&render_posix(body, interner));
    out.push(')');
    return true;
  }
  if let [head, SExpression::Literal(Literal::String(name))] = items.as_slice() {
    if symbol_is(head, "std.sh.var", interner) {
      out.push_str("${");
      out.push_str(name);
      out.push('}');
      return true;
    }
    // A tilde prefix renders as the reader's own `${~PREFIX}` spelling.
    if symbol_is(head, "std.sh.tilde", interner) {
      out.push_str("${~");
      out.push_str(name);
      out.push('}');
      return true;
    }
  }
  if let [head, SExpression::Literal(Literal::String(name))] = items.as_slice() {
    if symbol_is(head, "std.sh.positional", interner) {
      out.push_str("${");
      out.push_str(match name.as_str() { "*fields" => "*", "@word" => "@", name => name });
      out.push('}');
      return true;
    }
  }
  if let [head, SExpression::Literal(Literal::String(name)), index,
    SExpression::Literal(Literal::Boolean(length))] = items.as_slice() {
    if symbol_is(head, "std.sh.array-get", interner) {
      out.push_str("${");
      if *length { out.push('#'); }
      out.push_str(name);
      out.push('[');
      if let SExpression::Literal(Literal::String(index)) = index {
        out.push_str(if index == "*fields" { "*" } else { index });
      } else {
        write_array_subscript(index, interner, out);
      }
      out.push_str("]}");
      return true;
    }
  }
  if let [head, source] = items.as_slice() {
    if symbol_is(head, "std.sh.arith", interner) {
      out.push_str("$((");
      write_arithmetic_source(source, interner, out);
      out.push_str("))");
      return true;
    }
  }
  if let [head, command] = items.as_slice() {
    if symbol_is(head, "std.sh.sub", interner) {
      out.push_str("$(");
      out.push_str(&render_posix(command, interner));
      out.push(')');
      return true;
    }
  }
  if let [head] = items.as_slice() {
    if symbol_is(head, "std.sh.status", interner) {
      out.push_str("$?");
      return true;
    }
  }
  false
}

/// Write a string as a posix word: bare when it re-reads to the same literal,
/// else double-quoted (ANSI-C quoted for control characters). Quoting is forced
/// for a word that would otherwise read as a flag (`--all`), a reference (`$f`),
/// a substitution (`$(…)`), the empty
/// string, or that carries any shell-active character.
fn write_posix_word(s: &str, out: &mut String) {
  if s.chars().any(char::is_control) {
    out.push_str("$'");
    for c in s.chars() {
      match c {
        '\u{0007}' => out.push_str("\\a"),
        '\u{0008}' => out.push_str("\\b"),
        '\u{001b}' => out.push_str("\\e"),
        '\u{000c}' => out.push_str("\\f"),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        '\u{000b}' => out.push_str("\\v"),
        '\\' => out.push_str("\\\\"),
        '\'' => out.push_str("\\'"),
        c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
        c => out.push(c),
      }
    }
    out.push('\'');
  } else if posix_needs_quote(s) {
    out.push('"');
    for c in s.chars() {
      if matches!(c, '"' | '\\' | '$' | '`') {
        out.push('\\');
      }
      out.push(c);
    }
    out.push('"');
  } else {
    out.push_str(s);
  }
}

/// A char that, unquoted, would make the reader do something other than
/// extend a plain word — start a reference/substitution (`$`), split or
/// redirect (`&| ;<>`), open a quote/escape, shift `$(…)` balance (`()`), or
/// otherwise carry shell meaning (`` ` ``, `{}`, globs). Any of these forces
/// the word to be quoted so it re-reads as the exact literal (fuzz findings
/// F5/F9/F12/F16 were all bare words that re-read as a different form).
fn posix_char_is_active(c: char) -> bool {
  c.is_whitespace()
    || c.is_control()
    || matches!(
      c,
      '\''
        | '"'
        | '\\'
        | '$'
        | '`'
        | '('
        | ')'
        | '&'
        | '|'
        | ';'
        | '<'
        | '>'
        | '{'
        | '}'
        | '*'
        | '?'
        | '['
        | ']'
        | '!'
        | '#'
        | '='
    )
}

/// Whether `name` printed bare in command position reads back as the same
/// unquoted word. Decided by the bash reader itself, so reserved words,
/// assignments, patterns, braces and comments all fall back to quoting.
fn bare_command_word(name: &str) -> bool {
  use string_interner::{backend::StringBackend, symbol::SymbolU32};
  if name.is_empty() || name.starts_with('~') || name.chars().any(|c| c.is_whitespace() || c.is_control()) {
    return false;
  }
  // Read with an argument after it: a reserved word or `!` changes meaning
  // once words follow, and a bare name must hold whatever follows it.
  let mut interner = StringInterner::<StringBackend>::new();
  let line = format!("{name} x");
  let Ok(form) = crate::posix_reader::read_shell_plan::<SymbolU32, _>(&line, &mut interner) else {
    return false;
  };
  matches!(&form, SExpression::List(items) if matches!(items.as_slice(),
    [head, SExpression::Literal(Literal::String(word)), SExpression::Literal(Literal::String(x))]
      if word == name && x == "x" && symbol_is(head, "std.sh.cmd", &interner)))
}

fn posix_needs_quote(s: &str) -> bool {
  s.is_empty()
    || is_dollar_ident(s)
    || s.starts_with("$(")
    // A leading `:` (keyword), `-` (flag), or `~` (tilde) re-reads as
    // something other than a plain word.
    || s.starts_with([':', '-', '~'])
    || s.chars().any(posix_char_is_active)
}

fn symbol_is<S, B>(expr: &SExpression<S>, name: &str, interner: &StringInterner<B>) -> bool
where
  S: Symbol,
  B: Backend<S>,
{
  matches!(expr, SExpression::Literal(Literal::Symbol(s)) if interner.resolve(*s) == Some(name))
}

/// Escape a string for a lisp `"…"` literal (the lexer's escape set).
fn escape_lisp_string(s: &str, out: &mut String) {
  for c in s.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\n' => out.push_str("\\n"),
      '\t' => out.push_str("\\t"),
      '\r' => out.push_str("\\r"),
      _ => out.push(c),
    }
  }
}

/// Format a float so it re-reads as a `Float`, not an `Integer` — a value with
/// no `.`/exponent (e.g. `1.0`) gets a `.0` suffix.
fn render_float(x: f64) -> String {
  // `inf` is not a literal (it re-lexes as a symbol; `-inf` as `-` + symbol):
  // fuzz finding F10. `1e999` is the shortest literal the reader turns back
  // into infinity. NaN has no source form at all and stays `NaN`.
  if x.is_infinite() {
    return if x > 0.0 {
      "1e999".into()
    } else {
      "-1e999".into()
    };
  }
  let s = format!("{x}");
  if s.contains(['.', 'e', 'E']) || s.contains("NaN") {
    s
  } else {
    format!("{s}.0")
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::Runtime;
  use crate::posix_reader::{read_statement, sexpr_to_json};
  use string_interner::{StringInterner, backend::StringBackend, symbol::SymbolU32};

  fn assert_process_substitution_round_trip(source: &str, expected: &str) {
    for plan in [false, true] {
      let mut i = intern();
      let read = if plan {
        crate::posix_reader::read_shell_plan::<SymbolU32, _>
      } else {
        read_statement::<SymbolU32, _>
      };
      let original = read(source, &mut i).unwrap();
      let rendered = render_posix(&original, &i);
      assert_eq!(rendered, expected, "{source:?}, plan={plan}");
      let reread = read(&rendered, &mut i)
        .unwrap_or_else(|error| panic!("{source:?} via {rendered:?}: {error}"));
      assert_eq!(original, reread, "{source:?} via {rendered:?}, plan={plan}");
    }
  }

  #[test]
  fn process_substitution_input_renders_unquoted_and_round_trips() {
    for source in ["cat <(echo x)", "diff <(sort a.txt) <(sort b.txt)"] {
      assert_process_substitution_round_trip(source, source);
    }
  }

  #[test]
  fn process_substitution_output_renders_unquoted_and_round_trips() {
    assert_process_substitution_round_trip("tee >(cat)", "tee >(cat)");
  }

  #[test]
  fn process_substitution_word_fragments_round_trip_without_quoting_the_substitution() {
    for (source, expected) in [
      ("echo pre<(echo x)post", r#"echo "pre"<(echo x)"post""#),
      ("echo pre>(cat)post", r#"echo "pre">(cat)"post""#),
      ("echo <(echo x)>(cat)", "echo <(echo x)>(cat)"),
      (r#"echo "two words"<(echo x)"$y""#, r#"echo "two words"<(echo x)"${y}""#),
      ("echo $x<(echo x)", "echo ${x}<(echo x)"),
      ("echo <(echo x)*", "echo <(echo x)*"),
      ("echo ''<(echo x)", r#"echo ""<(echo x)"#),
      (r#"echo "<(echo x)""#, r#"echo "<(echo x)""#),
      (r#"echo "$(echo x)""#, r#"echo "$(echo x)""#),
    ] {
      assert_process_substitution_round_trip(source, expected);
    }
  }

  #[test]
  fn process_substitution_pipeline_bodies_and_nested_substitutions_round_trip() {
    for source in [
      "cat <(printf x | cat)",
      "tee >(cat | cat)",
      "diff <(sort a.txt | cat) <(sort b.txt | cat)",
      "cat <(cat <(echo x))",
      "echo $(cat <(echo x))",
    ] {
      assert_process_substitution_round_trip(source, source);
    }
  }

  #[test]
  fn shell_plans_glob_prefix_redirect_and_builtin_forms_round_trip() {
    for source in [
      "cmd a*b",
      r#"cmd pre*"mid"?"#,
      r"cmd a\[*",
      "cmd [[:alpha:]]",
      "cmd *\"\"",
      "cmd $x*",
      "cmd *$x",
      "cmd [a\"]\"]",
      "$SH -c 'echo hi'",
      r#""$cmd" args"#,
      "./tool* args",
      "K=$x OTHER=two cmd *.rs >out 2>&1",
      "cmd >*.log",
      "cmd <<<\"hi\"",
      "cat <<'EOF'\n$x literal\nEOF\n",
      "cat <<EOF\n$x\nEOF\n",
      "x=one y=two",
      "unset x",
      "unset -v x",
      "unset $names",
      "unset *",
      "set -f",
      "set +o noglob",
      "echo a; echo b && echo c || echo d",
      "echo hi | cat",
      "! false",
      "{ echo hi >first; } >second",
      "{ echo a; echo b; } >out",
      "echo hi >out; cat <<'EOF'\nTSH_RENDER_HEREDOC_0\nEOF\n",
      "cat <<EOF\nliteral \\$x \\`tick\\` $y\nEOF\n",
    ] {
      let mut i = intern();
      let original = read_statement::<SymbolU32, _>(source, &mut i).unwrap();
      let rendered = render_posix(&original, &i);
      let reread = read_statement::<SymbolU32, _>(&rendered, &mut i)
        .unwrap_or_else(|e| panic!("{source:?} via {rendered:?}: {e}"));
      assert_eq!(original, reread, "{source:?} via {rendered:?}");
    }
  }

  #[test]
  fn fixes_quoted_expansions_render_as_words_including_command_heads() {
    for (source, expected) in [
      (r#"echo "$HOME""#, r#"echo "${HOME}""#),
      (r#""$cmd" args"#, r#""${cmd}" args"#),
      (r#"echo "$f""#, r#"echo "${f}""#),
    ] {
      let mut i = intern();
      let original = read_statement::<SymbolU32, _>(source, &mut i).unwrap();
      let rendered = render_posix(&original, &i);
      assert_eq!(rendered, expected, "{source}");
      assert_eq!(original, read_statement::<SymbolU32, _>(&rendered, &mut i).unwrap());
    }
  }

  #[test]
  fn fixes_arrays_named_descriptors_stderr_pipes_and_eof_heredocs_round_trip() {
    for source in [
      "a=()", "a=(one 'two words' --help)", "a+=($x '*.txt')",
      "a[2]=value", "a[1+2]+=\"$x\"", "a=($((1+2)) $(echo hi))",
      "echo ${a[2]} ${a[@]} ${a[*]} ${#a[@]}",
      r#"echo "${a[@]}" "${a[*]}" "x${a[@]}y""#,
      "echo hi {fd}>out", "echo hi {fd}>&-", "cat <&$fd",
      "K=$x echo hi {fd}>out", "echo hi {env}>out", r#"echo hi >"${a[@]}""#,
      "echo hi 2>err |& cat", "{ echo hi; } 2>err |& cat",
      "cat <<'END'\nEND\n", "cat <<END\nEND\n",
      "cat <<'END'", "cat <<'END'\nbody", "cat <<END\n$x",
      "cat <<END\n$x\n", "cat <<A <<B\nrest",
      "cat <<A <<B\nfirst\nA\nrest", "cat <<\"can't\"\nbody",
    ] {
      let mut i = intern();
      let original = crate::posix_reader::read_shell_plan::<SymbolU32, _>(source, &mut i).unwrap();
      let rendered = render_posix(&original, &i);
      let reread = crate::posix_reader::read_shell_plan::<SymbolU32, _>(&rendered, &mut i)
        .unwrap_or_else(|error| panic!("{source:?} via {rendered:?}: {error}"));
      assert_eq!(original, reread, "{source:?} via {rendered:?}");
    }
  }

  #[test]
  fn array_subscript_sources_render_without_losing_index_fragments() {
    for source in [
      "a[2]=value", "a[1+2]+=value", "a[$i]=value", "a[$((1+2))]=value",
      "a[$(echo 2)]=value", "echo ${a[2]} ${a[$i]}",
      "a['two words']=value",
    ] {
      let mut i = intern();
      let original = crate::posix_reader::read_shell_plan::<SymbolU32, _>(source, &mut i).unwrap();
      let rendered = render_posix(&original, &i);
      assert!(!rendered.contains("[]"), "{source:?} via {rendered:?}");
      let reread = crate::posix_reader::read_shell_plan::<SymbolU32, _>(&rendered, &mut i)
        .unwrap_or_else(|error| panic!("{source:?} via {rendered:?}: {error}"));
      assert_eq!(original, reread, "{source:?} via {rendered:?}");
    }
  }

  #[test]
  fn and_or_lists_round_trip_without_synthetic_groups() {
    for source in [
      "echo a; echo b && echo c || echo d",
      "a=$(false) b=literal",
      "echo a || echo b && echo c | cat",
      "! false && echo yes || echo no",
      "{ echo a && echo b; } || echo c",
      "echo a && { echo b || echo c; }",
      "{ { echo a; } || echo b; } >out",
    ] {
      let mut i = intern();
      let original = read_statement::<SymbolU32, _>(source, &mut i).unwrap();
      let rendered = render_posix(&original, &i);
      let reread = read_statement::<SymbolU32, _>(&rendered, &mut i).unwrap();
      assert_eq!(original, reread, "{source:?} via {rendered:?}");
      assert_eq!(source.matches('{').count(), rendered.matches('{').count(), "{rendered}");
    }
  }

  #[test]
  fn bash_quoted_values_round_trip_through_posix_rendering() {
    let mut i = intern();
    let mut values = vec![
      "".to_string(),
      "plain".to_string(),
      "\\".to_string(),
      "\"".to_string(),
      "$".to_string(),
      "`".to_string(),
      "'".to_string(),
      "a\tb\nc\rd\u{001b}".to_string(),
      "αéβ".to_string(),
      "quote' slash\\ dollar$ tick`\nend".to_string(),
    ];
    // NUL has no Bash word representation; cover every other control character.
    values.extend(
      ('\u{0001}'..='\u{009f}')
        .filter(|c| c.is_control())
        .map(|c| format!("a{c}b")),
    );
    for value in values {
      let expr = SExpression::List(vec![
        SExpression::Literal(Literal::Symbol(i.get_or_intern("std.sh.cmd"))),
        SExpression::Literal(Literal::String("echo".into())),
        SExpression::Literal(Literal::String(value.clone())),
      ]);
      let text = render_posix(&expr, &i);
      if value.chars().any(char::is_control) {
        assert!(text.starts_with("echo $'"), "{value:?}: {text}");
        assert!(!text.chars().any(char::is_control), "{text:?}");
      }
      let back = crate::read_posix::<SymbolU32, _>(&text, &mut i).unwrap();
      assert_eq!(sexpr_to_json(&expr, &i), sexpr_to_json(&back, &i), "{text}");
    }
  }

  #[test]
  fn posix_double_quotes_escape_bash_active_characters() {
    let mut out = String::new();
    write_posix_word("a\"b\\c$d`e", &mut out);
    assert_eq!(out, r#""a\"b\\c\$d\`e""#);
    out.clear();
    write_posix_word("a\tb\nc\rd\u{001b}'\\", &mut out);
    assert_eq!(out, r"$'a\tb\nc\rd\e\'\\'");
  }

  #[test]
  fn posix_words_with_shell_metachars_round_trip() {
    // fuzz finding F16: a string like `$dst=$troup` rendered bare and re-read
    // as a reference/assignment. Any shell-active char forces quoting.
    for line in [
      "cmd $dst=$troup",
      "cmd a=b",
      // Unquoted, these are shell operators the reader refuses; quoted,
      // they are strings the renderer must quote again.
      "cmd 'a&b'",
      "cmd 'a|b'",
      "cmd 'a;b'",
      "cmd 'a<b>c'",
      "cmd '`x`'",
      "cmd a*b",
      "cmd '#hash'",
      "cmd $(inner $x=y)",
    ] {
      let mut interner = StringInterner::<StringBackend>::new();
      let form = crate::read_posix::<SymbolU32, _>(line, &mut interner).unwrap();
      let text = render_posix(&form, &interner);
      let mut again = StringInterner::<StringBackend>::new();
      let back = crate::read_posix::<SymbolU32, _>(&text, &mut again)
        .unwrap_or_else(|e| panic!("{line:?} rendered to unreadable {text:?}: {e:?}"));
      assert_eq!(
        render_lisp(&form, &interner),
        render_lisp(&back, &again),
        "{line:?} -> {text:?}"
      );
    }
  }

  #[test]
  fn posix_words_with_parens_round_trip_inside_substitution() {
    // fuzz finding F12: a string arg holding `(`/`)` rendered bare and broke
    // the enclosing `$(…)` balance (a bare `)` even re-read as a wrong form).
    for line in [
      "a $(b \"(\")",
      "a $(b \")\")",
      "a $(b \"c(d\")",
      "outer $(inner \"a)b(c\" plain)",
    ] {
      let mut interner = StringInterner::<StringBackend>::new();
      let form = crate::read_posix::<SymbolU32, _>(line, &mut interner).unwrap();
      let text = render_posix(&form, &interner);
      let mut again = StringInterner::<StringBackend>::new();
      let back = crate::read_posix::<SymbolU32, _>(&text, &mut again)
        .unwrap_or_else(|e| panic!("{line:?} rendered to unreadable {text:?}: {e:?}"));
      assert_eq!(
        render_lisp(&form, &interner),
        render_lisp(&back, &again),
        "{line:?} -> {text:?}"
      );
    }
  }

  #[test]
  fn infinite_floats_render_as_literals_that_read_back() {
    // fuzz finding F10: `(* 222222 -inf)` came back as `(* 222222 - inf)`.
    for src in ["(f 1e999)", "(f -1e999)", "(f 1e309 -2e400)"] {
      let mut interner = StringInterner::<StringBackend>::new();
      let forms = Runtime::<SymbolU32, StringBackend>::parse(None, src, &mut interner).unwrap();
      let text = render_lisp(&forms[0], &interner);
      let mut again = StringInterner::<StringBackend>::new();
      let back = Runtime::<SymbolU32, StringBackend>::parse(None, &text, &mut again).unwrap();
      assert_eq!(render_lisp(&back[0], &again), text, "{src}");
      assert!(!text.contains("inf"), "{src} -> {text}");
    }
  }

  #[test]
  fn posix_literal_options_round_trip() {
    // Option words are literal strings, including reflection spellings.
    for (line, expect) in [
      ("ls --json", r#"ls "--json""#),
      ("ls -h", r#"ls "-h""#),
      ("ls --help x", r#"ls "--help" x"#),
    ] {
      let mut interner = StringInterner::<StringBackend>::new();
      let form = crate::read_posix::<SymbolU32, _>(line, &mut interner).unwrap();
      let text = render_posix(&form, &interner);
      assert_eq!(text, expect);
      let mut again = StringInterner::<StringBackend>::new();
      let back = crate::read_posix::<SymbolU32, _>(&text, &mut again).unwrap();
      assert_eq!(render_lisp(&form, &interner), render_lisp(&back, &again));
    }
  }

  #[test]
  fn posix_head_that_needs_quoting_round_trips() {
    // fuzz finding F5: `""` read to a call whose head symbol is "", which
    // rendered to an empty line (re-read: Empty). Same class: `"a b"`.
    for line in ["\"\"", "\"\"\"\"\"\"", "\"a b\" c", "'x\"y'"] {
      let mut interner = StringInterner::<StringBackend>::new();
      let form = crate::read_posix::<SymbolU32, _>(line, &mut interner).unwrap();
      let text = render_posix(&form, &interner);
      let mut again = StringInterner::<StringBackend>::new();
      let back = crate::read_posix::<SymbolU32, _>(&text, &mut again)
        .unwrap_or_else(|e| panic!("{line:?} rendered to unreadable {text:?}: {e:?}"));
      assert_eq!(
        render_lisp(&form, &interner),
        render_lisp(&back, &again),
        "{line:?} -> {text:?}"
      );
    }
  }

  #[test]
  fn tagged_string_with_a_backtick_renders_in_the_long_form() {
    // fuzz finding F4: `pr`#``h`` re-read as tag `pr` + payload `#` + a template.
    let mut interner = StringInterner::<StringBackend>::new();
    let forms =
      crate::Runtime::<SymbolU32, StringBackend>::parse(None, "(pr```#``h```)", &mut interner)
        .unwrap();
    let text = render_lisp(&forms[0], &interner);
    assert_eq!(text, "(pr```#``h```)");
    let mut again = StringInterner::<StringBackend>::new();
    let back = crate::Runtime::<SymbolU32, StringBackend>::parse(None, &text, &mut again).unwrap();
    assert_eq!(render_lisp(&back[0], &again), text);
  }

  fn intern() -> StringInterner<StringBackend> {
    StringInterner::<StringBackend>::new()
  }

  fn parse_one(src: &str, i: &mut StringInterner<StringBackend>) -> SExpression<SymbolU32> {
    let forms = Runtime::<SymbolU32, StringBackend>::parse(None, src, i).expect("lisp parse");
    assert_eq!(forms.len(), 1, "expected one form: {src}");
    forms.into_iter().next().unwrap()
  }

  // === render_lisp: canonical, exact inverse of the lisp reader ==============

  #[test]
  fn lisp_round_trips_every_fixture() {
    let path = concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/tests/fixtures/reader_parity.json"
    );
    let raw = std::fs::read_to_string(path).expect("read fixtures");
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("parse fixtures");
    for case in doc["cases"].as_array().expect("cases") {
      let Some(src) = case.get("lisp").and_then(|v| v.as_str()) else {
        continue;
      };
      let desc = case["desc"].as_str().unwrap_or("?");
      let mut i = intern();
      let original = parse_one(src, &mut i);
      let rendered = render_lisp(&original, &i);
      let reparsed = parse_one(&rendered, &mut i);
      assert_eq!(
        sexpr_to_json(&original, &i),
        sexpr_to_json(&reparsed, &i),
        "lisp round-trip `{src}` ({desc}) via `{rendered}`"
      );
    }
  }

  #[test]
  fn lisp_renders_keyword_and_string_distinctly() {
    let mut i = intern();
    let e = parse_one("(ls :all \"/tmp\")", &mut i);
    assert_eq!(render_lisp(&e, &i), "(ls :all \"/tmp\")");
  }

  #[test]
  fn lisp_escapes_quotes_and_newlines() {
    let mut i = intern();
    let e = parse_one("(echo \"a\\\"b\\nc\")", &mut i);
    // The inner string is  a"b<newline>c ; it must escape back to a re-readable form.
    let rendered = render_lisp(&e, &i);
    let reparsed = parse_one(&rendered, &mut i);
    assert_eq!(
      sexpr_to_json(&e, &i),
      sexpr_to_json(&reparsed, &i),
      "via `{rendered}`"
    );
  }

  #[test]
  fn lisp_float_keeps_a_decimal_point() {
    let mut i = intern();
    let e = parse_one("(f 1.0)", &mut i);
    assert_eq!(
      render_lisp(&e, &i),
      "(f 1.0)",
      "1.0 must not render as 1 (an int)"
    );
  }

  // === render_posix: idempotent on the posix-producible subset ===============

  #[test]
  fn expanded_words_round_trip_with_quote_and_split_boundaries() {
    for source in [
      r#"echo "$HOME""#,
      r#"echo "a $x b""#,
      r#"echo "${x}y""#,
      r#"echo "$(pick a)""#,
      r#"echo "`pick a`""#,
      "echo pre$HOME",
      "echo ${HOME}",
      "echo $(echo hi)x",
      r#"echo "a b"$x"#,
      r#"echo ""$x"#,
      r#"echo $x"q"$y"#,
      r#"echo "a\$b $x""#,
      "x=$HOME",
      "x=$(pick a)",
      "x=$(pick a)y",
      "echo $?",
      r#"echo "${?}""#,
      "echo $(pick $(other))",
    ] {
      let mut i = intern();
      let original = read_statement::<SymbolU32, _>(source, &mut i).unwrap();
      let rendered = render_posix(&original, &i);
      let reread = read_statement::<SymbolU32, _>(&rendered, &mut i).unwrap();
      assert_eq!(original, reread, "{source} via {rendered}");
    }
  }

  #[test]
  fn posix_round_trips_every_fixture() {
    let path = concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/tests/fixtures/reader_parity.json"
    );
    let raw = std::fs::read_to_string(path).expect("read fixtures");
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("parse fixtures");
    for case in doc["cases"].as_array().expect("cases") {
      let Some(src) = case.get("posix").and_then(|v| v.as_str()) else {
        continue;
      };
      let desc = case["desc"].as_str().unwrap_or("?");
      let mut i = intern();
      let original = read_statement::<SymbolU32, _>(src, &mut i)
        .unwrap_or_else(|e| panic!("posix read `{src}` ({desc}): {e}"));
      let rendered = render_posix(&original, &i);
      let reread = read_statement::<SymbolU32, _>(&rendered, &mut i)
        .unwrap_or_else(|e| panic!("re-read `{rendered}` ({desc}): {e}"));
      assert_eq!(
        sexpr_to_json(&original, &i),
        sexpr_to_json(&reread, &i),
        "posix round-trip `{src}` ({desc}) via `{rendered}`"
      );
    }
  }

  #[test]
  fn posix_renders_the_command_line_shapes() {
    let mut i = intern();
    // literal option → quoted word, string → bare path
    let e = read_statement::<SymbolU32, _>("ls --all /tmp", &mut i).unwrap();
    assert_eq!(render_posix(&e, &i), r#"ls "--all" /tmp"#);
    // reference symbol → $name
    let e = read_statement::<SymbolU32, _>("cat $f", &mut i).unwrap();
    assert_eq!(render_posix(&e, &i), r#"cat ${f}"#);
    // nested call → $(…)
    let e = read_statement::<SymbolU32, _>("cat $(ls /tmp)", &mut i).unwrap();
    assert_eq!(render_posix(&e, &i), "cat $(ls /tmp)");
    // def → assignment
    let e = read_statement::<SymbolU32, _>("files=$(ls /tmp)", &mut i).unwrap();
    assert_eq!(render_posix(&e, &i), "files=$(ls /tmp)");
  }

  #[test]
  fn posix_quotes_a_flag_like_string() {
    // The conservative renderer quotes dash-leading words on both doors.
    let mut i = intern();
    let e = read_statement::<SymbolU32, _>("ls \"--all\"", &mut i).unwrap();
    assert_eq!(render_posix(&e, &i), "ls \"--all\"");
    // round-trip holds
    let reread = read_statement::<SymbolU32, _>(&render_posix(&e, &i), &mut i).unwrap();
    assert_eq!(sexpr_to_json(&e, &i), sexpr_to_json(&reread, &i));
  }

  #[test]
  fn posix_quotes_a_dollar_ident_string() {
    // A literal "$f" (not a reference) must stay quoted.
    let mut i = intern();
    let e = read_statement::<SymbolU32, _>(r#"echo "\$f""#, &mut i).unwrap();
    assert_eq!(render_posix(&e, &i), r#"echo "\$f""#);
  }

  #[test]
  fn posix_quotes_spaces() {
    let mut i = intern();
    let e = read_statement::<SymbolU32, _>("echo \"a b\" c", &mut i).unwrap();
    assert_eq!(render_posix(&e, &i), "echo \"a b\" c");
  }
}
