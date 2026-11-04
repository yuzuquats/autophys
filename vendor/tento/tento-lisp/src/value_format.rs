//! Printing a [`Value`] the way the REPL shows it, without recursion.
//!
//! Lisp code builds data nested far deeper than the native stack holds, so
//! the printer keeps its open lists and maps on a heap stack: a value a
//! million levels deep prints in constant native stack. The output is the
//! same text `Interpreter::format_value` has always produced.

use std::fmt::Write;

use string_interner::StringInterner;

use crate::{
  eval::Function,
  symbol::{Backend, Symbol},
  value::Value,
};

/// `value` as REPL text: `nil`, `42`, a string's raw text, a symbol's name,
/// `(a b c)` for a list, `{key value …}` for a map, `#<…>` for the rest.
pub fn format_value<S: Symbol, B: Backend<S>>(interner: &StringInterner<B>, value: &Value<S>) -> String {
  format_with(interner, value, false)
}

/// `value` as source text: [`format_value`]'s output, except that a string
/// is written as a double-quoted literal with the reader's escapes, so a
/// form such as an error's origin reads back as the code that was written.
pub fn format_source<S: Symbol, B: Backend<S>>(interner: &StringInterner<B>, value: &Value<S>) -> String {
  format_with(interner, value, true)
}

fn format_with<S: Symbol, B: Backend<S>>(interner: &StringInterner<B>, value: &Value<S>, quote_strings: bool) -> String {
  enum Open<'a, S: Symbol> {
    List(std::slice::Iter<'a, Value<S>>, bool),
    Map(indexmap::map::Iter<'a, String, Value<S>>, bool),
  }
  let mut out = String::new();
  let mut open: Vec<Open<'_, S>> = Vec::new();
  let mut next = Some(value);
  loop {
    match next.take() {
      Some(Value::List(list)) => {
        out.push('(');
        open.push(Open::List(list.items.iter(), true));
      }
      Some(Value::Map(map)) => {
        out.push('{');
        open.push(Open::Map(map.iter(), true));
      }
      Some(Value::String(text)) if quote_strings => write_string_literal(text, &mut out),
      Some(leaf) => format_leaf(interner, leaf, &mut out),
      None => {}
    }
    let Some(top) = open.last_mut() else { return out };
    match top {
      Open::List(items, first) => match items.next() {
        Some(item) => {
          if !std::mem::take(first) {
            out.push(' ');
          }
          next = Some(item);
        }
        None => {
          out.push(')');
          open.pop();
        }
      },
      Open::Map(entries, first) => match entries.next() {
        Some((key, item)) => {
          if !std::mem::take(first) {
            out.push(' ');
          }
          out.push_str(key);
          out.push(' ');
          next = Some(item);
        }
        None => {
          out.push('}');
          open.pop();
        }
      },
    }
  }
}

/// `text` as a double-quoted literal, escaped with the reader's table.
fn write_string_literal(text: &str, out: &mut String) {
  out.push('"');
  for c in text.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\u{0008}' => out.push_str("\\b"),
      '\n' => out.push_str("\\n"),
      '\u{000C}' => out.push_str("\\f"),
      '\r' => out.push_str("\\r"),
      '\t' => out.push_str("\\t"),
      c => out.push(c),
    }
  }
  out.push('"');
}

/// Everything but a list or map: text that holds no further values.
fn format_leaf<S: Symbol, B: Backend<S>>(interner: &StringInterner<B>, value: &Value<S>, out: &mut String) {
  let _ = match value {
    Value::Nil => out.write_str("nil"),
    Value::Boolean(val) => write!(out, "{}", val),
    Value::Integer(val) => write!(out, "{}", val),
    Value::Float(val) => write!(out, "{}", val),
    Value::String(val) => out.write_str(val),
    Value::Symbol(sym) => out.write_str(interner.resolve(sym.as_symbol()).unwrap_or("<>")),
    Value::List(_) | Value::Map(_) => unreachable!("containers are walked by format_value"),
    Value::TaggedString { tag, payload } => {
      if payload.contains('`') {
        write!(out, "{}```{}```", tag, payload)
      } else {
        write!(out, "{}`{}`", tag, payload)
      }
    }
    Value::Resource(resource) => write!(out, "#<resource {}>", resource.kind()),
    Value::Type(ty) => write!(out, "#<type {}>", ty.describe()),
    Value::Trait(ty) => write!(out, "#<trait {}>", ty.name),
    Value::Module(module) => write!(out, "#<module {}>", module.name),
    Value::Function(func) => match func {
      Function::TypedNative(native) => write!(out, "#<function {}>", native.name),
      Function::NativeFn(native_func) => write!(out, "[function {:p}]", native_func),
      Function::NativeClosure(closure) => write!(out, "[function {:p}]", std::rc::Rc::as_ptr(closure)),
      Function::Lambda(lambda) => write!(out, "[function {:p}]", std::rc::Rc::as_ptr(lambda)),
    },
    Value::Error(e) => write!(out, "#<error {}: {}>", e.kind, e.message),
  };
}
