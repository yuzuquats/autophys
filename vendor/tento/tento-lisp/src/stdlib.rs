//! Built-in functions registered in the default env. Special forms
//! (`if`, `define`, `lambda`, `let`, …) are NOT registered here —
//! they're hardcoded in the interpreter so they can decide their own
//! evaluation strategy. See `interpreter.rs`.

use std::cell::RefCell;

use string_interner::StringInterner;

use crate::{
  eval::{Env, Function, NativeFn, RuntimeError, Type},
  symbol::{Backend, Symbol},
  value::Value,
};

mod pattern;
mod predicates;
mod text;

/// Register all native built-ins in `env`.
pub fn register_builtins<S: Symbol, B: Backend<S>>(
  env: &mut Env<S>,
  interner: &mut StringInterner<B>,
) {
  let mut reg = |name: &str, f: NativeFn<S>| {
    let sym = interner.get_or_intern(name);
    env.define(sym, Value::Function(Function::NativeFn(f)));
  };

  // Arithmetic
  reg("+", arith::iadd);
  reg("-", arith::isub);
  reg("*", arith::imul);
  reg("/", arith::idiv);
  reg("%", arith::imod);
  reg("//", arith::ifloordiv);
  reg("**", arith::ipow);

  // Comparison
  reg("=", cmp::eq);
  reg("!=", cmp::neq);
  reg(">", cmp::gt);
  reg("<", cmp::lt);
  reg(">=", cmp::ge);
  reg("<=", cmp::le);

  // Boolean
  reg("not", logic::not);
  reg("null?", logic::is_null);
  reg("atom?", logic::is_atom);

  // Type predicates: one value of any type in, a boolean out, never an error,
  // so polymorphic code can branch on shape without a `try` probe.
  reg("nil?", predicates::is_nil);
  reg("bool?", predicates::is_bool);
  reg("number?", predicates::is_number);
  reg("int?", predicates::is_int);
  reg("float?", predicates::is_float);
  reg("string?", predicates::is_string);
  reg("list?", predicates::is_list);
  reg("map?", predicates::is_map);
  reg("fn?", predicates::is_fn);

  // Invariants: `(assert COND [MESSAGE])` errors with MESSAGE (or a default)
  // when COND is falsy, else returns COND (so it composes). `invariant` is an
  // alias.
  reg("assert", logic::assert_);
  reg("invariant", logic::assert_);

  // Lists concatenate as lists; scalar arguments keep their string coercion.
  reg("concat", strings::concat_values);
  // Strings
  reg("str", strings::str_);
  // Desugar target for template literals: `` `a ${b}` `` parses to
  // `(str.concat "a " b)`. Same scalar coercion as `concat`.
  reg("str.concat", strings::concat);
  // `(str.lines text)` — split on `\n` into a list of lines.
  reg("str.lines", strings::lines);
  // `(str.find text needle)` — Unicode-scalar index of the first match, or
  // false. This pairs with `str.slice` for small user-land parsers.
  reg("str.find", strings::find);
  // Character-indexed primitives used by user-land text editors. These use
  // Unicode scalar positions, matching `length` rather than JS UTF-16 `len`.
  reg("str.slice", strings::slice);
  // Trimming. Composing a line out of optional parts leaves stray edge
  // whitespace that `str.slice` cannot remove without the caller re-deriving
  // where the run ends; these do it by Unicode whitespace, like Rust's `trim`.
  // `(str.repeat "─" 40)` — rules, box edges and pad runs. Building these by
  // folding `concat` over a range is quadratic and reads like an accident.
  reg("str.repeat", strings::repeat);
  reg("str.trim", strings::trim);
  reg("str.trim-start", strings::trim_start);
  reg("str.trim-end", strings::trim_end);
  reg("str.terminal-safe", strings::terminal_safe);
  reg("str.lower", strings::lower);
  // Literal split / replace / join, and a one-pass character list. See
  // `stdlib/text.rs`; `str.join` is the inverse of `str.split`.
  reg("str.split", text::split);
  reg("str.replace", text::replace);
  reg("str.join", text::join);
  reg("str.chars", text::chars);
  // Regular expressions (Rust `regex` syntax, linear-time). `str.re-X` is the
  // pattern form of the literal `str.X`. See `stdlib/pattern.rs`.
  reg("str.re-match?", pattern::is_match);
  reg("str.re-find", pattern::find);
  reg("str.re-find-all", pattern::find_all);
  reg("str.re-captures", pattern::captures);
  reg("str.re-captures-all", pattern::captures_all);
  reg("str.re-split", pattern::split);
  reg("str.re-replace", pattern::replace);
  reg("len", strings::len);

  // Lists
  reg("list", lists::list);
  reg("vector", lists::list); // alias
  reg("first", lists::first);
  reg("car", lists::first);
  reg("rest", lists::rest);
  reg("cdr", lists::rest);
  reg("nth", lists::nth);
  reg("length", lists::length);
  reg("count", lists::length);
  reg("append", lists::append);
  reg("cons", lists::cons);
  reg("empty?", lists::is_empty);
  reg("reverse", lists::reverse);
  reg("range", lists::range);
  reg("includes", lists::includes);
  reg("take", lists::take);
  reg("drop", lists::drop);
  reg("slice", lists::slice);
  reg("conj", lists::conj);
  reg("sort-by", lists::sort_by);

  // Maps / JSON
  reg("hash-map", maps::hash_map);
  reg("json", maps::hash_map);
  reg("get", maps::get);
  reg("assoc", maps::assoc);
  reg("dissoc", maps::dissoc);
  reg("keys", maps::keys);
  reg("vals", maps::vals);
  reg("json-get", maps::json_get);
  reg("json-set", maps::json_set);
  reg("json-keys", maps::keys);
  reg("json-values", maps::vals);
  reg("json-has-key", maps::json_has_key);
  reg("json-remove", maps::dissoc);
  reg("json-merge", maps::json_merge);
  reg("json-size", maps::json_size);
  reg("json-empty?", maps::json_empty);
  reg("json-stringify", maps::json_stringify);
  reg("json-parse", maps::json_parse);
  // `json-from-list` is registered as a special form in
  // `interpreter.rs` — it needs interpreter access to re-evaluate
  // list-with-symbol-head values (matching JS behavior where
  // `(json-from-list '(person (json :name "Eve")))` recursively
  // evaluates the inner `(json …)` form).
  reg("json-to-list", maps::json_to_list);
  reg("json-get-in", maps::json_get_in);
  reg("json-set-in", maps::json_set_in);
  reg("field", maps::get);

  // Error inspection (safe on ANY value — never a TypeError). `(try …)` is the
  // only constructor; these are plain read-only accessors. Dotted names are
  // ordinary symbols (`.` is a legal symbol char).
  reg("error?", errors::is_error);
  reg("error.kind", errors::error_kind);
  reg("error.message", errors::error_message);
  reg("error.origin", errors::error_origin);
  reg("error.chain", errors::error_chain);
  reg("error.host", errors::error_host);
  reg("error.next", errors::error_next);
  reg("error.reason", errors::error_reason);

  // Math
  reg("abs", math::abs_);
  reg("min", math::min_);
  reg("max", math::max_);
  reg("mod", arith::imod);
  // Float-to-integer rounding. An integer passes through unchanged; a float
  // returns an Integer (so the result can index a list), and a NaN, an
  // infinity or a float beyond the i64 range is an error, never a wrapped
  // number.
  reg("floor", math::floor);
  reg("ceil", math::ceil);
  reg("round", math::round);
  reg("trunc", math::trunc);
}

pub mod arith {
  use super::*;

  /// Numeric arg: an integer or a float. We distinguish to preserve
  /// integer-only results when no float is involved.
  fn collect_nums<S: Symbol>(
    args: &[Value<S>],
    name: &str,
  ) -> Result<(Vec<f64>, bool), RuntimeError> {
    let mut out = Vec::with_capacity(args.len());
    let mut all_int = true;
    for v in args {
      match v {
        &Value::Integer(i) => out.push(i as f64),
        &Value::Float(f) => {
          out.push(f);
          all_int = false;
        }
        _ => {
          return Err(RuntimeError::TypeError {
            expected: format!("number (in {})", name),
            got: format!("{:?}", v.as_type()),
          });
        }
      }
    }
    Ok((out, all_int))
  }

  fn pack<S: Symbol>(value: f64, all_int: bool) -> Value<S> {
    if all_int && value.fract() == 0.0 && value.is_finite() {
      Value::Integer(value as i64)
    } else {
      Value::Float(value)
    }
  }

  pub fn iadd<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.iter().all(|v| matches!(v, Value::Integer(_))) {
      let value = args.iter().try_fold(0_i64, |acc, v| {
        let Value::Integer(v) = v else { unreachable!() };
        acc
          .checked_add(*v)
          .ok_or_else(|| RuntimeError::Other("integer overflow in +".into()))
      })?;
      return Ok(Value::Integer(value));
    }
    let (xs, all_int) = collect_nums(&args, "+")?;
    Ok(pack(xs.into_iter().sum(), all_int))
  }

  pub fn isub<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if !args.is_empty() && args.iter().all(|v| matches!(v, Value::Integer(_))) {
      let Value::Integer(first) = args[0] else {
        unreachable!()
      };
      let overflow = || RuntimeError::Other("integer overflow in -".into());
      let value = if args.len() == 1 {
        first.checked_neg().ok_or_else(overflow)?
      } else {
        args[1..].iter().try_fold(first, |acc, v| {
          let Value::Integer(v) = v else { unreachable!() };
          acc.checked_sub(*v).ok_or_else(overflow)
        })?
      };
      return Ok(Value::Integer(value));
    }
    let (xs, all_int) = collect_nums(&args, "-")?;
    let mut it = xs.into_iter();
    let first = it.next().ok_or(RuntimeError::ArityError {
      detail: "- needs at least one arg".into(),
    })?;
    if it.len() == 0 {
      return Ok(pack(-first, all_int));
    }
    Ok(pack(it.fold(first, |a, b| a - b), all_int))
  }

  pub fn imul<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.iter().all(|v| matches!(v, Value::Integer(_))) {
      let value = args.iter().try_fold(1_i64, |acc, v| {
        let Value::Integer(v) = v else { unreachable!() };
        acc
          .checked_mul(*v)
          .ok_or_else(|| RuntimeError::Other("integer overflow in *".into()))
      })?;
      return Ok(Value::Integer(value));
    }
    let (xs, all_int) = collect_nums(&args, "*")?;
    Ok(pack(xs.into_iter().product(), all_int))
  }

  pub fn idiv<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    let (xs, _) = collect_nums(&args, "/")?;
    let mut it = xs.into_iter();
    let first = it.next().ok_or(RuntimeError::ArityError {
      detail: "/ needs at least one arg".into(),
    })?;
    if it.len() == 0 {
      // Single arg => reciprocal, JS-style.
      if first == 0.0 {
        return Err(RuntimeError::Other("division by zero".into()));
      }
      return Ok(Value::Float(1.0 / first));
    }
    let mut acc = first;
    for x in it {
      if x == 0.0 {
        // Division by zero is a catchable error, the same kind `//` and
        // `%` raise; it never yields nil or an infinity.
        return Err(RuntimeError::Other("division by zero".into()));
      }
      acc /= x;
    }
    // Always float — `/` is true division (JS aligned).
    Ok(Value::Float(acc))
  }

  fn as_int<S: Symbol>(v: &Value<S>, name: &str) -> Result<i64, RuntimeError> {
    match v {
      &Value::Integer(i) => Ok(i),
      // Truncates toward zero; a float with no i64 value (NaN, an
      // infinity, or beyond ±2^63) is an error, never a saturated value.
      &Value::Float(f) => {
        if f.is_finite() && f >= -9_223_372_036_854_775_808.0 && f < 9_223_372_036_854_775_808.0 {
          Ok(f as i64)
        } else {
          Err(RuntimeError::Other(format!("float {f:?} is out of integer range in {name}")))
        }
      }
      _ => Err(RuntimeError::TypeError {
        expected: format!("Integer (in {})", name),
        got: format!("{:?}", v.as_type()),
      }),
    }
  }

  pub fn imod<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "% takes 2 args".into(),
      });
    }
    let a = as_int(&args[0], "%")?;
    let b = as_int(&args[1], "%")?;
    if b == 0 {
      return Err(RuntimeError::Other("modulo by zero".into()));
    }
    Ok(Value::Integer(a.checked_rem(b).ok_or_else(|| {
      RuntimeError::Other("integer overflow in %".into())
    })?))
  }

  pub fn ifloordiv<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "// takes 2 args".into(),
      });
    }
    let a = as_int(&args[0], "//")?;
    let b = as_int(&args[1], "//")?;
    if b == 0 {
      return Err(RuntimeError::Other("floor-div by zero".into()));
    }
    Ok(Value::Integer(a.checked_div_euclid(b).ok_or_else(
      || RuntimeError::Other("integer overflow in //".into()),
    )?))
  }

  pub fn ipow<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "** takes 2 args".into(),
      });
    }
    // Two integers with a non-negative exponent: exact, checked integer
    // exponentiation; overflow is the same error `*` raises.
    if let (&Value::Integer(base), &Value::Integer(exp)) = (&args[0], &args[1]) {
      if exp >= 0 {
        let overflow = || RuntimeError::Other("integer overflow in **".into());
        let value = match u32::try_from(exp) {
          Ok(exp) => base.checked_pow(exp).ok_or_else(overflow)?,
          // Only 0, 1 and -1 survive an exponent past u32::MAX.
          Err(_) => match base {
            0 | 1 => base,
            -1 => if exp % 2 == 0 { 1 } else { -1 },
            _ => return Err(overflow()),
          },
        };
        return Ok(Value::Integer(value));
      }
    }
    let all_int = matches!((&args[0], &args[1]), (Value::Integer(_), Value::Integer(_)));
    let a: f64 = match &args[0] {
      &Value::Integer(i) => i as f64,
      &Value::Float(f) => f,
      _ => return Err(Type::error(args[0].as_type(), Type::Float)),
    };
    let b: f64 = match &args[1] {
      &Value::Integer(i) => i as f64,
      &Value::Float(f) => f,
      _ => return Err(Type::error(args[1].as_type(), Type::Float)),
    };
    let result = a.powf(b);
    if all_int && result.fract() == 0.0 && result.is_finite() {
      Ok(Value::Integer(result as i64))
    } else {
      Ok(Value::Float(result))
    }
  }
}

pub mod cmp {
  use super::*;

  fn require_2<S: Symbol>(args: &[Value<S>], name: &str) -> Result<(), RuntimeError> {
    if args.len() != 2 {
      Err(RuntimeError::ArityError {
        detail: format!("{} takes 2 args", name),
      })
    } else {
      Ok(())
    }
  }

  /// Variadic chained comparison: `(< 1 2 3)` is true iff every
  /// adjacent pair satisfies `<`. Mirrors JS Lisp's chained
  /// comparator semantics.
  fn chained<S: Symbol>(
    args: &[Value<S>],
    name: &str,
    pred: fn(std::cmp::Ordering) -> bool,
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 {
      return Err(RuntimeError::ArityError {
        detail: format!("{} needs at least 2 args", name),
      });
    }
    for pair in args.windows(2) {
      let ord = cmp_pair(&pair[0], &pair[1])?;
      if !pred(ord) {
        return Ok(Value::Boolean(false));
      }
    }
    Ok(Value::Boolean(true))
  }

  pub fn eq<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 {
      return Err(RuntimeError::ArityError {
        detail: "= needs at least 2 args".into(),
      });
    }
    let first = &args[0];
    Ok(Value::Boolean(
      args.iter().skip(1).all(|v| values_equal(first, v)),
    ))
  }

  pub fn neq<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    require_2(&args, "!=")?;
    Ok(Value::Boolean(!values_equal(&args[0], &args[1])))
  }


  /// Compare without rounding an exact i64 into a float first. Within i64's
  /// range, truncation is safe; compare the integral part before the fraction.
  fn compare_integer_float(x: i64, y: f64) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    if y.is_nan() {
      return None;
    }
    if y >= 9_223_372_036_854_775_808.0 {
      return Some(Ordering::Less);
    }
    if y < -9_223_372_036_854_775_808.0 {
      return Some(Ordering::Greater);
    }
    match x.cmp(&(y as i64)) {
      Ordering::Equal => 0.0_f64.partial_cmp(&y.fract()),
      order => Some(order),
    }
  }

  pub(super) fn cmp_pair<S: Symbol>(
    a: &Value<S>,
    b: &Value<S>,
  ) -> Result<std::cmp::Ordering, RuntimeError> {
    let order = match (a, b) {
      (&Value::Integer(x), &Value::Integer(y)) => Some(x.cmp(&y)),
      (Value::Float(x), Value::Float(y)) => x.partial_cmp(y),
      (&Value::Integer(x), &Value::Float(y)) => compare_integer_float(x, y),
      (&Value::Float(x), &Value::Integer(y)) => compare_integer_float(y, x).map(std::cmp::Ordering::reverse),
      (Value::String(x), Value::String(y)) => Some(x.cmp(y)),
      _ => return Err(Type::error(b.as_type(), Type::Integer)),
    };
    order.ok_or_else(|| RuntimeError::Other("cannot order NaN".into()))
  }

  pub fn gt<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    chained(&args, ">", |o| o == std::cmp::Ordering::Greater)
  }

  pub fn lt<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    chained(&args, "<", |o| o == std::cmp::Ordering::Less)
  }

  pub fn ge<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    chained(&args, ">=", |o| o != std::cmp::Ordering::Less)
  }

  pub fn le<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    chained(&args, "<=", |o| o != std::cmp::Ordering::Greater)
  }

  /// Structural equality. Lists and maps being compared wait on a heap
  /// stack, never the native one, so values nested a million levels deep
  /// compare in constant native stack.
  pub(crate) fn values_equal<S: Symbol>(a: &Value<S>, b: &Value<S>) -> bool {
    enum Open<'a, S: Symbol> {
      List(std::iter::Zip<std::slice::Iter<'a, Value<S>>, std::slice::Iter<'a, Value<S>>>),
      Map(indexmap::map::Iter<'a, String, Value<S>>, &'a indexmap::IndexMap<String, Value<S>>),
    }
    let mut open: Vec<Open<'_, S>> = Vec::new();
    let mut next = Some((a, b));
    loop {
      if let Some((a, b)) = next.take() {
        let same = match (a, b) {
          (Value::Nil, Value::Nil) => true,
          (Value::Boolean(x), Value::Boolean(y)) => x == y,
          (Value::Integer(x), Value::Integer(y)) => x == y,
          (Value::Float(x), Value::Float(y)) => x == y,
          (Value::Integer(x), Value::Float(y)) => compare_integer_float(*x, *y) == Some(std::cmp::Ordering::Equal),
          (Value::Float(x), Value::Integer(y)) => compare_integer_float(*y, *x) == Some(std::cmp::Ordering::Equal),
          (Value::String(x), Value::String(y)) => x == y,
          (Value::List(x), Value::List(y)) => {
            let same = x.items.len() == y.items.len();
            if same {
              open.push(Open::List(x.items.iter().zip(y.items.iter())));
            }
            same
          }
          (Value::Map(x), Value::Map(y)) => {
            let same = x.len() == y.len();
            if same {
              open.push(Open::Map(x.iter(), y));
            }
            same
          }
          _ => false,
        };
        if !same {
          return false;
        }
      }
      let Some(top) = open.last_mut() else { return true };
      match top {
        Open::List(pairs) => match pairs.next() {
          Some(pair) => next = Some(pair),
          None => {
            open.pop();
          }
        },
        Open::Map(entries, other) => match entries.next() {
          Some((key, value)) => match other.get(key) {
            Some(theirs) => next = Some((value, theirs)),
            None => return false,
          },
          None => {
            open.pop();
          }
        },
      }
    }
  }
}

mod logic {
  use super::*;

  pub fn not<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "not takes 1 arg".into(),
      });
    }
    Ok(Value::Boolean(!args[0].is_truthy()))
  }

  /// `(assert COND [MESSAGE])` — raise a runtime error when `COND` is falsy
  /// (nil / false / empty list), else return `COND` so it composes. `MESSAGE`,
  /// when a string, is the error text; otherwise a default is used. Lets scripts
  /// state invariants (e.g. a required config field) and fail loudly.
  pub fn assert_<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.is_empty() {
      return Err(RuntimeError::ArityError {
        detail: "assert takes a condition (+ optional message)".into(),
      });
    }
    if args[0].is_truthy() {
      return Ok(args[0].clone());
    }
    let msg = match args.get(1) {
      Some(Value::String(s)) => s.to_string(),
      _ => "assertion failed".to_string(),
    };
    // Hard: a violated invariant must halt — `(try …)` cannot defuse it.
    Err(RuntimeError::Fatal { detail: msg })
  }

  pub fn is_null<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "null? takes 1 arg".into(),
      });
    }
    let null = match &args[0] {
      Value::Nil => true,
      Value::List(l) => l.items.is_empty(),
      _ => false,
    };
    Ok(Value::Boolean(null))
  }

  pub fn is_atom<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "atom? takes 1 arg".into(),
      });
    }
    Ok(Value::Boolean(!matches!(args[0], Value::List(_))))
  }
}

mod errors {
  use super::*;

  /// Every accessor takes exactly one argument. Inspection is safe on *any*
  /// value: a non-error yields `Nil` (or `false` for `error?`), NEVER a
  /// `TypeError`, so a script can probe a value without first knowing its type.
  fn arg1<'a, S: Symbol>(args: &'a [Value<S>], name: &str) -> Result<&'a Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: format!("{name} takes 1 arg"),
      });
    }
    Ok(&args[0])
  }

  pub fn is_error<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    Ok(Value::Boolean(matches!(
      arg1(&args, "error?")?,
      Value::Error(_)
    )))
  }

  pub fn error_kind<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    Ok(match arg1(&args, "error.kind")? {
      Value::Error(e) => Value::String(e.kind.as_str().into()),
      _ => Value::Nil,
    })
  }

  pub fn error_message<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    Ok(match arg1(&args, "error.message")? {
      Value::Error(e) => Value::String(e.message.as_str().into()),
      _ => Value::Nil,
    })
  }

  pub fn error_origin<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    Ok(match arg1(&args, "error.origin")? {
      Value::Error(e) => e.origin.clone().map(|origin| Value::String(origin.into())).unwrap_or(Value::Nil),
      _ => Value::Nil,
    })
  }

  pub fn error_chain<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    Ok(match arg1(&args, "error.chain")? {
      Value::Error(e) => Value::List(crate::eval::List {
        items: e.chain.iter().map(|s| Value::String(s.as_str().into())).collect(),
      }),
      _ => Value::Nil,
    })
  }

  pub fn error_host<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    Ok(match arg1(&args, "error.host")? {
      Value::Error(e) => e.host.as_ref().map(|v| Value::String(v.as_str().into())).unwrap_or(Value::Nil),
      _ => Value::Nil,
    })
  }

  pub fn error_next<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    Ok(match arg1(&args, "error.next")? {
      Value::Error(e) => {
        if let Some(next) = e.display.as_ref().and_then(|d| d.get("next")).filter(|v| v.is_object()) {
          crate::json_to_value(next.clone())
        } else if let Some(text) = &e.next {
          // Keep the error/v1 wire field textual; expose its advice as Next.
          crate::json_to_value(serde_json::json!({"shape":"next/v1", "command":null,
            "args":null, "text":text, "form":null,
            "reason":e.display.as_ref().and_then(|d| d.get("reason")), "operator_only":null}))
        } else { Value::Nil }
      },
      _ => Value::Nil,
    })
  }

  pub fn error_reason<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    Ok(match arg1(&args, "error.reason")? {
      Value::Error(e) => e.display.as_ref().and_then(|d| d.get("reason")).and_then(serde_json::Value::as_str)
        .map(|s| Value::String(s.into())).unwrap_or(Value::Nil),
      _ => Value::Nil,
    })
  }
}

pub mod strings {
  use super::*;

  pub fn concat_values<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if !args.is_empty() && args.iter().all(|value| matches!(value, Value::List(_))) {
      let mut items = Vec::new();
      for value in args {
        let Value::List(list) = value else {
          return Err(RuntimeError::TypeError {
            expected: "list".into(),
            got: format!("{:?}", value.as_type()),
          });
        };
        items.extend(list.items.iter().cloned());
      }
      return Ok(Value::List(crate::eval::List {
        items: items.into(),
      }));
    }
    concat(args)
  }

  pub fn concat<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    let mut out = String::new();
    for a in &args {
      match a {
        Value::String(s) => out.push_str(s.as_str()),
        Value::Integer(i) => out.push_str(&i.to_string()),
        Value::Float(f) => out.push_str(&f.to_string()),
        Value::Boolean(b) => out.push_str(&b.to_string()),
        Value::Nil => out.push_str("nil"),
        _ => {
          return Err(RuntimeError::TypeError {
            expected: "scalar".into(),
            got: format!("{:?}", a.as_type()),
          });
        }
      }
    }
    Ok(Value::String(out.into()))
  }

  pub fn str_<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    concat(args)
  }

  /// `(str.repeat TEXT N)` → TEXT concatenated N times. A negative or zero N
  /// yields the empty string rather than an error, so a saturating width
  /// calculation upstream needs no guard of its own.
  pub fn repeat<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "str.repeat takes 2 args (text, count)".into(),
      });
    }
    let text = match &args[0] {
      Value::String(s) => s.clone(),
      Value::Nil => "".into(),
      other => {
        return Err(RuntimeError::TypeError {
          expected: "String (in str.repeat)".into(),
          got: format!("{:?}", other.as_type()),
        });
      }
    };
    let count = match &args[1] {
      Value::Integer(n) => *n,
      other => {
        return Err(RuntimeError::TypeError {
          expected: "Integer (in str.repeat)".into(),
          got: format!("{:?}", other.as_type()),
        });
      }
    };
    let count = usize::try_from(count).unwrap_or(0);
    let bytes = text
      .len()
      .checked_mul(count)
      .filter(|n| *n <= 8 * 1024 * 1024)
      .ok_or_else(|| RuntimeError::Other("str.repeat exceeds the 8 MiB output limit".into()))?;
    if bytes == 0 {
      return Ok(Value::String(String::new().into()));
    }
    Ok(Value::String(text.repeat(count).into()))
  }

  /// `(str.trim TEXT)` / `(str.trim-start …)` / `(str.trim-end …)` — drop
  /// Unicode whitespace from both ends, the front, or the back.
  ///
  /// `nil` trims to the empty string rather than erroring, so a missing field
  /// threads through a composition without a guard at every step.
  fn trim_with<S: Symbol>(
    args: Vec<Value<S>>,
    name: &str,
    f: fn(&str) -> &str,
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: format!("{name} takes 1 arg"),
      });
    }
    match &args[0] {
      Value::String(s) => Ok(Value::String(f(s).into())),
      Value::Nil => Ok(Value::String(String::new().into())),
      other => Err(RuntimeError::TypeError {
        expected: format!("String (in {name})"),
        got: format!("{:?}", other.as_type()),
      }),
    }
  }

  /// `(str.lower TEXT)` — the case fold a substring search needs. Without it
  /// every "does this contain that" in user-land is case-SENSITIVE, which is
  /// wrong for anything a person types at a name they only half remember.
  /// Nil folds to `""`, like the trims: a missing string is an empty one.
  pub fn lower<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "str.lower takes 1 arg".into(),
      });
    }
    match &args[0] {
      Value::String(s) => Ok(Value::String(s.to_lowercase().into())),
      Value::Nil => Ok(Value::String(String::new().into())),
      other => Err(RuntimeError::TypeError {
        expected: "String (in str.lower)".into(),
        got: format!("{:?}", other.as_type()),
      }),
    }
  }

  pub fn trim<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    trim_with(args, "str.trim", str::trim)
  }

  pub fn trim_start<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    trim_with(args, "str.trim-start", str::trim_start)
  }

  pub fn trim_end<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    trim_with(args, "str.trim-end", str::trim_end)
  }

  pub fn lines<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "str.lines takes 1 arg".into(),
      });
    }
    match &args[0] {
      // `\n` splits; a trailing newline yields no empty final line (like
      // Rust's `str::lines`). CRLF input keeps its `\r` — callers strip it.
      Value::String(s) => Ok(Value::List(crate::eval::List {
        items: s
          .lines()
          .map(|line| Value::String(line.into()))
          .collect(),
      })),
      Value::Nil => Ok(Value::List(crate::eval::List { items: vec![].into() })),
      _ => Err(Type::error(args[0].as_type(), Type::String)),
    }
  }

  /// `(str.find text needle)` — character index of NEEDLE's first occurrence,
  /// or `false` when absent. The index is Unicode-scalar based so it can be
  /// handed directly to [`slice`].
  pub fn find<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "str.find takes 2 args".into(),
      });
    }
    let text = match &args[0] {
      Value::String(text) => text,
      _ => return Err(Type::error(args[0].as_type(), Type::String)),
    };
    let needle = match &args[1] {
      Value::String(needle) => needle,
      _ => return Err(Type::error(args[1].as_type(), Type::String)),
    };
    Ok(match text.find(needle.as_str()) {
      Some(byte) => Value::Integer(text[..byte].chars().count() as i64),
      None => Value::Boolean(false),
    })
  }

  /// `(str.slice text start [end])` — take Unicode scalar positions with the
  /// same negative-index convention as the list `slice` primitive.
  pub fn slice<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 || args.len() > 3 {
      return Err(RuntimeError::ArityError {
        detail: "str.slice takes 2 or 3 args".into(),
      });
    }
    let text = match &args[0] {
      Value::String(text) => text,
      _ => return Err(Type::error(args[0].as_type(), Type::String)),
    };
    // A position walk, not a decode: collecting every char per call made
    // character-at-a-time reading quadratic (about 1 s per 12 KB).
    let len = if args[1..].iter().any(|i| matches!(i, Value::Integer(n) if *n < 0)) {
      text::char_len(text) as i64
    } else {
      i64::MAX
    };
    let normalize = |index: i64| {
      if index < 0 {
        (len + index).max(0)
      } else {
        index.min(len)
      }
    };
    let start = normalize((&args[1]).try_into()?);
    let end = if let Some(end) = args.get(2) {
      normalize(end.try_into()?)
    } else {
      len
    };
    if end <= start {
      return Ok(Value::String(String::new().into()));
    }
    let (start, end) = text::byte_span(text, start as usize, end as usize);
    Ok(Value::String(text[start..end].into()))
  }

  /// Make untrusted text safe to return as raw terminal lines while preserving
  /// newlines and tabs. Control bytes become visible text instead of terminal
  /// commands; carriage return gets a compact control picture.
  pub fn terminal_safe<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "str.terminal-safe takes 1 arg".into(),
      });
    }
    let text = match &args[0] {
      Value::String(text) => text,
      _ => return Err(Type::error(args[0].as_type(), Type::String)),
    };
    let mut safe = String::with_capacity(text.len());
    for ch in text.chars() {
      match ch {
        '\n' | '\t' => safe.push(ch),
        '\r' => safe.push('↵'),
        ch if ch.is_control() => safe.push_str(&format!("\\u{{{:x}}}", ch as u32)),
        ch => safe.push(ch),
      }
    }
    Ok(Value::String(safe.into()))
  }

  pub fn len<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "len takes 1 arg".into(),
      });
    }
    match &args[0] {
      // JS uses UTF-16 length (`.length` on a JS string), so a single
      // emoji like 😀 returns 2.
      Value::String(s) => Ok(Value::Integer(s.encode_utf16().count() as i64)),
      Value::List(l) => Ok(Value::Integer(l.items.len() as i64)),
      Value::Map(m) => Ok(Value::Integer(m.len() as i64)),
      Value::Nil => Ok(Value::Integer(0)),
      // JS coerces numbers to their decimal string representation.
      Value::Integer(i) => Ok(Value::Integer(i.to_string().len() as i64)),
      Value::Float(f) => Ok(Value::Integer(f.to_string().len() as i64)),
      Value::Boolean(b) => Ok(Value::Integer(b.to_string().len() as i64)),
      _ => Err(Type::error(args[0].as_type(), Type::String)),
    }
  }
}

mod math {
  use super::*;

  /// Shared body of `floor` / `ceil` / `round` / `trunc`: integers pass
  /// through; a float is rounded by `f` and must land inside i64.
  fn to_integer<S: Symbol>(args: &[Value<S>], name: &str, f: fn(f64) -> f64) -> Result<Value<S>, RuntimeError> {
    let [value] = args else {
      return Err(RuntimeError::ArityError {
        detail: format!("{name} takes 1 arg"),
      });
    };
    match value {
      Value::Integer(i) => Ok(Value::Integer(*i)),
      Value::Float(x) => {
        let rounded = f(*x);
        // `i64::MAX as f64` rounds up to 2^63, which is out of range, hence `<`.
        if rounded.is_finite() && rounded >= i64::MIN as f64 && rounded < i64::MAX as f64 {
          Ok(Value::Integer(rounded as i64))
        } else {
          Err(RuntimeError::Other(format!("{name}: {x} has no integer value")))
        }
      }
      other => Err(RuntimeError::TypeError {
        expected: format!("number (in {name})"),
        got: format!("{:?}", other.as_type()),
      }),
    }
  }

  /// `(floor X)` — the greatest integer not above X.
  pub fn floor<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    to_integer(&args, "floor", f64::floor)
  }

  /// `(ceil X)` — the least integer not below X.
  pub fn ceil<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    to_integer(&args, "ceil", f64::ceil)
  }

  /// `(round X)` — the nearest integer, halves away from zero (2.5 → 3,
  /// -2.5 → -3), as Rust's `f64::round` and C's `round` do. JS `Math.round`
  /// rounds halves up instead (-2.5 → -2).
  pub fn round<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    to_integer(&args, "round", f64::round)
  }

  /// `(trunc X)` — X with its fraction dropped, toward zero.
  pub fn trunc<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    to_integer(&args, "trunc", f64::trunc)
  }

  fn as_f64<S: Symbol>(v: &Value<S>) -> Result<f64, RuntimeError> {
    match v {
      Value::Integer(i) => Ok(*i as f64),
      Value::Float(f) => Ok(*f),
      _ => Err(Type::error(v.as_type(), Type::Float)),
    }
  }

  pub fn abs_<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "abs takes 1 arg".into(),
      });
    }
    match &args[0] {
      Value::Integer(i) => i
        .checked_abs()
        .map(Value::Integer)
        .ok_or_else(|| RuntimeError::Other("integer overflow in abs".into())),
      Value::Float(f) => Ok(Value::Float(f.abs())),
      v => Err(Type::error(v.as_type(), Type::Float)),
    }
  }

  pub fn min_<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.is_empty() {
      return Err(RuntimeError::ArityError {
        detail: "min needs at least one arg".into(),
      });
    }
    let mut best = as_f64(&args[0])?;
    let mut all_int = matches!(args[0], Value::Integer(_));
    for v in &args[1..] {
      let f = as_f64(v)?;
      if f < best {
        best = f;
      }
      if !matches!(v, Value::Integer(_)) {
        all_int = false;
      }
    }
    if all_int {
      Ok(Value::Integer(best as i64))
    } else {
      Ok(Value::Float(best))
    }
  }

  pub fn max_<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.is_empty() {
      return Err(RuntimeError::ArityError {
        detail: "max needs at least one arg".into(),
      });
    }
    let mut best = as_f64(&args[0])?;
    let mut all_int = matches!(args[0], Value::Integer(_));
    for v in &args[1..] {
      let f = as_f64(v)?;
      if f > best {
        best = f;
      }
      if !matches!(v, Value::Integer(_)) {
        all_int = false;
      }
    }
    if all_int {
      Ok(Value::Integer(best as i64))
    } else {
      Ok(Value::Float(best))
    }
  }
}

pub(crate) mod maps {
  use super::*;
  use indexmap::IndexMap;

  fn key_string<S: Symbol>(v: &Value<S>) -> Result<String, RuntimeError> {
    match v {
      Value::String(s) => Ok(s.to_string()),
      Value::Symbol(_) => Err(RuntimeError::Other(
        "hash-map keys must be strings or :keywords (got bare symbol)".into(),
      )),
      _ => Err(Type::error(v.as_type(), Type::String)),
    }
  }

  /// Pair adjacent args as (k v k v …). Strips a leading `:` from
  /// keyword keys, matching JS `hash-map`.
  pub fn hash_map<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() % 2 != 0 {
      return Err(RuntimeError::ArityError {
        detail: "hash-map needs an even number of args".into(),
      });
    }
    let mut out: IndexMap<String, Value<S>> = IndexMap::new();
    let mut iter = args.into_iter();
    while let (Some(k), Some(v)) = (iter.next(), iter.next()) {
      let mut key = match k {
        Value::String(s) => s.into_string(),
        Value::Integer(i) => i.to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Nil => "nil".to_string(),
        _ => {
          return Err(RuntimeError::Other(
            "hash-map keys must be strings/integers/keywords".into(),
          ));
        }
      };
      if let Some(stripped) = key.strip_prefix(':') {
        key = stripped.to_string();
      }
      out.insert(key, v);
    }
    Ok(Value::Map(out.into()))
  }

  pub fn get<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 || args.len() > 3 {
      return Err(RuntimeError::ArityError {
        detail: "get takes 2 or 3 args (coll, key, [default])".into(),
      });
    }
    let default = args.get(2).cloned().unwrap_or(Value::Nil);
    match (&args[0], &args[1]) {
      (Value::Map(m), key) => {
        let k = key_string(key)?;
        // `:x` keyword keys are stored stripped of the leading colon
        // (matches `hash-map` insertion). Look up both forms.
        let stripped = k.strip_prefix(':').unwrap_or(&k);
        Ok(m.get(stripped).cloned().unwrap_or(default))
      }
      // A list answers any key: an in-range index gives its element, and a
      // negative or past-the-end index, or a key that is not an index at all
      // (a string looked up on a list), gives the default. Defensive lookups
      // on data of uncertain shape need no `try`.
      (Value::List(l), key) => Ok(match key {
        &Value::Integer(i) => usize::try_from(i).ok().and_then(|i| l.items.get(i)).cloned(),
        _ => None,
      }
      .unwrap_or(default)),
      (Value::Nil, _) => Ok(default),
      _ => Err(RuntimeError::Other("get: bad collection or key".into())),
    }
  }

  pub fn assoc<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() < 3 || args.len() % 2 == 0 {
      return Err(RuntimeError::ArityError {
        detail: "assoc takes coll + (k v)…".into(),
      });
    }
    let mut iter = args.into_iter();
    let coll = iter.next().unwrap();
    let mut m = match coll {
      Value::Map(m) => m,
      Value::Nil => IndexMap::new().into(),
      other => return Err(Type::error(other.as_type(), Type::Map)),
    };
    while let (Some(k), Some(v)) = (iter.next(), iter.next()) {
      let key = key_string(&k)?;
      let key = key.strip_prefix(':').unwrap_or(&key).to_string();
      m.insert(key, v);
    }
    Ok(Value::Map(m))
  }

  pub fn dissoc<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 {
      return Err(RuntimeError::ArityError {
        detail: "dissoc takes coll + key…".into(),
      });
    }
    let mut iter = args.into_iter();
    let coll = iter.next().unwrap();
    let mut m = match coll {
      Value::Map(m) => m,
      _ => return Err(RuntimeError::Other("dissoc: not a map".into())),
    };
    for k in iter {
      let key = key_string(&k)?;
      let key = key.strip_prefix(':').unwrap_or(&key).to_string();
      m.shift_remove(&key);
    }
    Ok(Value::Map(m))
  }

  pub fn keys<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "keys takes 1 arg".into(),
      });
    }
    match &args[0] {
      Value::Map(m) => Ok(Value::List(crate::eval::List {
        items: m.keys().map(|k| Value::String(k.as_str().into())).collect(),
      })),
      _ => Err(RuntimeError::Other("keys: not a map".into())),
    }
  }

  pub fn vals<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "vals takes 1 arg".into(),
      });
    }
    match &args[0] {
      Value::Map(m) => Ok(Value::List(crate::eval::List {
        items: m.values().cloned().collect(),
      })),
      _ => Err(RuntimeError::Other("vals: not a map".into())),
    }
  }

  pub fn json_get<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    get(args)
  }

  pub fn json_set<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    assoc(args)
  }

  pub fn json_has_key<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "json-has-key takes 2 args".into(),
      });
    }
    let k = key_string(&args[1])?;
    let k = k.strip_prefix(':').unwrap_or(&k).to_string();
    let present = match &args[0] {
      Value::Map(m) => m.contains_key(&k),
      _ => false,
    };
    Ok(Value::Boolean(present))
  }

  pub fn json_merge<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    let mut out: IndexMap<String, Value<S>> = IndexMap::new();
    for a in args {
      match a {
        Value::Map(m) => out.extend(m),
        _ => return Err(RuntimeError::Other("json-merge: arg is not a map".into())),
      }
    }
    Ok(Value::Map(out.into()))
  }

  pub fn json_size<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "json-size takes 1 arg".into(),
      });
    }
    match &args[0] {
      Value::Map(m) => Ok(Value::Integer(m.len() as i64)),
      _ => Err(RuntimeError::Other("json-size: not a map".into())),
    }
  }

  pub fn json_empty<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "json-empty? takes 1 arg".into(),
      });
    }
    match &args[0] {
      Value::Map(m) => Ok(Value::Boolean(m.is_empty())),
      _ => Err(RuntimeError::Other("json-empty?: not a map".into())),
    }
  }

  pub fn json_stringify<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "json-stringify takes 1 arg".into(),
      });
    }
    Ok(Value::String(stringify(&args[0])?.into()))
  }

  pub fn json_parse<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "json-parse takes 1 arg".into(),
      });
    }
    let text = match &args[0] {
      Value::String(s) => s,
      _ => return Err(Type::error(args[0].as_type(), Type::String)),
    };
    let parsed: serde_json::Value =
      serde_json::from_str(text).map_err(|e| RuntimeError::Other(format!("json-parse: {}", e)))?;
    Ok(json_to_value(parsed))
  }

  fn json_to_value<S: Symbol>(v: serde_json::Value) -> Value<S> {
    use serde_json::Value as J;
    match v {
      J::Null => Value::Nil,
      J::Bool(b) => Value::Boolean(b),
      J::Number(n) => {
        if let Some(i) = n.as_i64() {
          Value::Integer(i)
        } else {
          n.as_f64().map(Value::Float).unwrap_or(Value::Nil)
        }
      }
      J::String(s) => Value::String(s.into()),
      J::Array(a) => Value::List(crate::eval::List {
        items: a.into_iter().map(json_to_value).collect(),
      }),
      J::Object(o) => {
        let mut m = IndexMap::new();
        for (k, v) in o {
          m.insert(k, json_to_value(v));
        }
        Value::Map(m.into())
      }
    }
  }

  /// `(json-to-list m)` — flatten a map back into `[k v k v …]`.
  pub fn json_to_list<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "json-to-list takes 1 arg".into(),
      });
    }
    let m = match &args[0] {
      Value::Map(m) => m,
      _ => return Err(RuntimeError::Other("json-to-list: not a map".into())),
    };
    let mut items = Vec::with_capacity(m.len() * 2);
    for (k, v) in m {
      items.push(Value::String(k.as_str().into()));
      items.push(v.clone());
    }
    Ok(Value::List(crate::eval::List { items: items.into() }))
  }

  /// `(json-get-in m (list "a" "b" "c"))` — nested path access. A string
  /// (or `:keyword`) step looks up a map key; an integer step indexes a
  /// list (0-based), as `get` does. A missing key, a negative or
  /// past-the-end index, a string on a list, or a step into a scalar yields
  /// nil; a non-string key on a map is the same error `get` raises.
  pub fn json_get_in<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "json-get-in takes 2 args (map, path-list)".into(),
      });
    }
    let path = match &args[1] {
      Value::List(l) => &l.items,
      _ => return Err(Type::error(args[1].as_type(), Type::List)),
    };
    let mut cur = args[0].clone();
    for step in path {
      cur = match cur {
        Value::Map(m) => {
          let key = key_string(step)?;
          let key = key.strip_prefix(':').unwrap_or(&key);
          m.get(key).cloned().unwrap_or(Value::Nil)
        }
        Value::List(l) => match step {
          &Value::Integer(i) => usize::try_from(i).ok().and_then(|i| l.items.get(i).cloned()).unwrap_or(Value::Nil),
          _ => Value::Nil,
        },
        _ => return Ok(Value::Nil),
      };
    }
    Ok(cur)
  }

  /// `(json-set-in m (list "a" "b") value)` — nested path set.
  pub fn json_set_in<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 3 {
      return Err(RuntimeError::ArityError {
        detail: "json-set-in takes 3 args (map, path-list, value)".into(),
      });
    }
    let mut path: Vec<String> = match &args[1] {
      Value::List(l) => l
        .items
        .iter()
        .map(|v| key_string(v).map(|s| s.strip_prefix(':').unwrap_or(&s).to_string()))
        .collect::<Result<_, _>>()?,
      _ => return Err(Type::error(args[1].as_type(), Type::List)),
    };
    if path.is_empty() {
      return Ok(args[2].clone());
    }
    let new_value = args[2].clone();
    let root = match args.into_iter().next().unwrap() {
      Value::Map(m) => m.into_inner(),
      Value::Nil => IndexMap::new(),
      v => return Err(Type::error(v.as_type(), Type::Map)),
    };
    let head = path.remove(0);
    fn insert<S: Symbol>(
      mut m: IndexMap<String, Value<S>>,
      head: String,
      rest: Vec<String>,
      value: Value<S>,
    ) -> IndexMap<String, Value<S>> {
      if rest.is_empty() {
        m.insert(head, value);
        return m;
      }
      let next = m.swap_remove(&head).unwrap_or(Value::Map(IndexMap::new().into()));
      let next_map = match next {
        Value::Map(nm) => nm.into_inner(),
        _ => IndexMap::new(),
      };
      let mut rest_iter = rest.into_iter();
      let next_head = rest_iter.next().unwrap();
      let nested = insert(next_map, next_head, rest_iter.collect(), value);
      m.insert(head, Value::Map(nested.into()));
      m
    }
    Ok(Value::Map(insert(root, head, path, new_value).into()))
  }

  /// JSON text for `v`. Open lists and maps wait on a heap stack, so a value
  /// nested a million levels deep stringifies in constant native stack.
  fn stringify<S: Symbol>(v: &Value<S>) -> Result<String, RuntimeError> {
    enum Open<'a, S: Symbol> {
      List(std::slice::Iter<'a, Value<S>>, bool),
      Map(indexmap::map::Iter<'a, String, Value<S>>, bool),
    }
    let mut out = String::new();
    let mut open: Vec<Open<'_, S>> = Vec::new();
    let mut next = Some(v);
    loop {
      match next.take() {
        Some(Value::List(l)) => {
          out.push('[');
          open.push(Open::List(l.items.iter(), true));
        }
        Some(Value::Map(m)) => {
          out.push('{');
          open.push(Open::Map(m.iter(), true));
        }
        Some(leaf) => out.push_str(&stringify_leaf(leaf)?),
        None => {}
      }
      let Some(top) = open.last_mut() else { return Ok(out) };
      match top {
        Open::List(items, first) => match items.next() {
          Some(item) => {
            if !std::mem::take(first) {
              out.push(',');
            }
            next = Some(item);
          }
          None => {
            out.push(']');
            open.pop();
          }
        },
        Open::Map(entries, first) => match entries.next() {
          Some((k, item)) => {
            if !std::mem::take(first) {
              out.push(',');
            }
            out.push_str(&serde_json::to_string(k).expect("keys serialize as JSON"));
            out.push(':');
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

  /// JSON text for a value that holds no further values.
  fn stringify_leaf<S: Symbol>(v: &Value<S>) -> Result<String, RuntimeError> {
    Ok(match v {
      Value::Nil => "null".to_string(),
      Value::Boolean(b) => b.to_string(),
      Value::Integer(i) => i.to_string(),
      // JSON has no NaN or infinity (`json-parse` rejects them), so a
      // non-finite float is refused rather than written as `NaN`/`inf`.
      Value::Float(f) if !f.is_finite() => {
        return Err(RuntimeError::Other(format!(
          "json-stringify: non-finite number {f} is not JSON"
        )));
      }
      Value::Float(f) => f.to_string(),
      Value::String(s) => serde_json::to_string(s.as_str()).expect("strings serialize as JSON"),
      Value::List(_) | Value::Map(_) => unreachable!("containers are walked by stringify"),
      // Explicit arm (NOT the silent `_ => "null"` trap): an error value
      // serializes as a tagged `error/v1` record, matching the repo's
      // `<name>/v1` type-tag convention. Serialized from a serde value, never
      // hand-built.
      Value::Resource(_) => return Err(RuntimeError::Other("json-stringify: opaque resources cannot cross a JSON boundary".into())),
      Value::Error(e) => e.to_record().to_string(),
      _ => "null".to_string(),
    })
  }
}

pub(crate) mod lists {
  use super::*;
  use crate::eval::List;

  /// Memory a single `range` list may occupy.
  pub(super) const RANGE_BYTES: usize = 256 * 1024 * 1024;

  /// `(sort-by rows "field" [descending?])` orders maps by one scalar key.
  /// Keys are extracted once, and the stable sort keeps equal-key rows in
  /// their input order in either direction.
  pub fn sort_by<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if !(2..=3).contains(&args.len()) {
      return Err(RuntimeError::ArityError {
        detail: "sort-by takes rows, a field name, and optional descending boolean".into(),
      });
    }
    let mut args = args.into_iter();
    let rows = match args.next().unwrap() {
      Value::List(rows) => rows.items,
      other => return Err(Type::error(other.as_type(), Type::List)),
    };
    let field = match args.next().unwrap() {
      Value::String(field) => field,
      other => return Err(Type::error(other.as_type(), Type::String)),
    };
    let descending = match args.next() {
      None => false,
      Some(Value::Boolean(descending)) => descending,
      Some(other) => return Err(Type::error(other.as_type(), Type::Boolean)),
    };

    let mut keyed = Vec::with_capacity(rows.len());
    let mut numeric: Option<bool> = None;
    for (index, row) in rows.into_iter().enumerate() {
      let Value::Map(map) = &row else {
        return Err(RuntimeError::Other(format!("sort-by: row {index} is not a map")));
      };
      let key = map
        .get(field.as_str())
        .ok_or_else(|| {
          RuntimeError::Other(format!("sort-by: row {index} is missing field {field:?}"))
        })?
        .clone();
      let kind = match &key {
        Value::Integer(_) | Value::Float(_) => true,
        Value::String(_) => false,
        _ => return Err(RuntimeError::Other(format!(
          "sort-by: row {index} field {field:?} must be a number or string"
        ))),
      };
      if numeric.is_some_and(|expected| expected != kind) {
        return Err(RuntimeError::Other(format!(
          "sort-by: row {index} field {field:?} mixes numbers and strings"
        )));
      }
      // A one-row list must reject NaN too, before the comparator runs.
      cmp::cmp_pair(&key, &key)?;
      numeric = Some(kind);
      keyed.push((key, row));
    }
    keyed.sort_by(|(left, _), (right, _)| {
      let order = cmp::cmp_pair(left, right).expect("sort-by validated all key types");
      if descending {
        order.reverse()
      } else {
        order
      }
    });
    Ok(Value::List(List {
      items: keyed.into_iter().map(|(_, row)| row).collect(),
    }))
  }

  pub fn list<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    Ok(Value::List(List { items: args.into() }))
  }

  pub fn first<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "first/car takes 1 arg".into(),
      });
    }
    match &args[0] {
      Value::List(l) => Ok(l.items.first().cloned().unwrap_or(Value::Nil)),
      _ => Err(Type::error(args[0].as_type(), Type::List)),
    }
  }

  pub fn rest<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "rest/cdr takes 1 arg".into(),
      });
    }
    match &args[0] {
      Value::List(l) => Ok(Value::List(List {
        items: l.items.iter().skip(1).cloned().collect(),
      })),
      _ => Err(Type::error(args[0].as_type(), Type::List)),
    }
  }

  pub fn nth<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "nth takes 2 args".into(),
      });
    }
    let n: i64 = (&args[1]).try_into()?;
    match &args[0] {
      Value::List(l) => Ok(l.items.get(n as usize).cloned().unwrap_or(Value::Nil)),
      _ => Err(Type::error(args[0].as_type(), Type::List)),
    }
  }

  pub fn length<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "length/count takes 1 arg".into(),
      });
    }
    match &args[0] {
      Value::List(l) => Ok(Value::Integer(l.items.len() as i64)),
      Value::String(s) => Ok(Value::Integer(s.chars().count() as i64)),
      Value::Map(m) => Ok(Value::Integer(m.len() as i64)),
      Value::Nil => Ok(Value::Integer(0)),
      _ => Err(Type::error(args[0].as_type(), Type::List)),
    }
  }

  pub fn append<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    let mut args = args.into_iter();
    // A first list nothing else holds is extended in place, so appending to
    // an accumulator does not copy it ([`crate::value::Shared::into_inner`]).
    let mut items = match args.next() {
      Some(Value::List(l)) => l.items.into_inner(),
      Some(other) => vec![other],
      None => Vec::new(),
    };
    for a in args {
      match a {
        Value::List(l) => items.extend(l.items),
        other => items.push(other),
      }
    }
    Ok(Value::List(List { items: items.into() }))
  }

  pub fn cons<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "cons takes 2 args".into(),
      });
    }
    let mut items = Vec::with_capacity(2);
    items.push(args[0].clone());
    match &args[1] {
      Value::List(l) => items.extend(l.items.iter().cloned()),
      _ => {
        return Err(Type::error(args[1].as_type(), Type::List));
      }
    }
    Ok(Value::List(List { items: items.into() }))
  }

  pub fn is_empty<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "empty? takes 1 arg".into(),
      });
    }
    Ok(Value::Boolean(match &args[0] {
      Value::List(l) => l.items.is_empty(),
      Value::String(s) => s.is_empty(),
      Value::Map(m) => m.is_empty(),
      Value::Nil => true,
      _ => false,
    }))
  }

  pub fn reverse<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "reverse takes 1 arg".into(),
      });
    }
    match &args[0] {
      Value::List(l) => {
        let mut items = l.items.clone();
        items.reverse();
        Ok(Value::List(List { items }))
      }
      _ => Err(Type::error(args[0].as_type(), Type::List)),
    }
  }

  pub fn range<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    let (start, end, step): (i64, i64, i64) = match args.len() {
      1 => (0i64, (&args[0]).try_into()?, 1i64),
      2 => ((&args[0]).try_into()?, (&args[1]).try_into()?, 1i64),
      3 => (
        (&args[0]).try_into()?,
        (&args[1]).try_into()?,
        (&args[2]).try_into()?,
      ),
      _ => {
        return Err(RuntimeError::ArityError {
          detail: "range takes 1-3 args".into(),
        });
      }
    };
    if step == 0 {
      return Err(RuntimeError::Other("range step cannot be zero".into()));
    }
    // Compute cardinality in i128 before allocating or iterating; the last
    // step can overflow i64 even when every returned element is representable.
    let distance = if step > 0 {
      i128::from(end) - i128::from(start)
    } else {
      i128::from(start) - i128::from(end)
    };
    let stride = i128::from(step).abs();
    let count = if distance <= 0 {
      0
    } else {
      (distance + stride - 1) / stride
    };
    // Bounded by memory, not by an element count picked for small loops: the
    // list may take up to RANGE_BYTES (2,796,202 elements of 96-byte values),
    // enough for a DP table or a 4 MB file's character positions, while a
    // mistaken `(range 1000000000000)` still fails as an error instead of an abort.
    let limit = (RANGE_BYTES / std::mem::size_of::<Value<S>>()) as i128;
    if count > limit {
      return Err(RuntimeError::Other(format!(
        "range of {count} elements exceeds the {limit} element limit ({} MiB of list)",
        RANGE_BYTES / (1024 * 1024)
      )));
    }
    let mut items = Vec::new();
    items.try_reserve_exact(count as usize).map_err(|_| {
      RuntimeError::Other(format!("range of {count} elements: out of memory"))
    })?;
    for offset in 0..count {
      items.push(Value::Integer(
        (i128::from(start) + offset * i128::from(step)) as i64,
      ));
    }
    Ok(Value::List(List { items: items.into() }))
  }

  pub fn includes<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "includes takes 2 args".into(),
      });
    }
    match &args[0] {
      Value::List(l) => {
        let needle = &args[1];
        Ok(Value::Boolean(l.items.iter().any(|v| values_eq(v, needle))))
      }
      Value::String(s) => {
        if let Value::String(needle) = &args[1] {
          Ok(Value::Boolean(s.contains(needle.as_str())))
        } else {
          Err(RuntimeError::Other(
            "includes: string haystack needs string needle".into(),
          ))
        }
      }
      _ => Err(RuntimeError::Other("includes: bad collection".into())),
    }
  }

  pub fn take<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "take takes 2 args (n list)".into(),
      });
    }
    let n: i64 = (&args[0]).try_into()?;
    match &args[1] {
      Value::List(l) => Ok(Value::List(List {
        items: l.items.iter().take(n.max(0) as usize).cloned().collect(),
      })),
      _ => Err(Type::error(args[1].as_type(), Type::List)),
    }
  }

  pub fn drop<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "drop takes 2 args (n list)".into(),
      });
    }
    let n: i64 = (&args[0]).try_into()?;
    match &args[1] {
      Value::List(l) => Ok(Value::List(List {
        items: l.items.iter().skip(n.max(0) as usize).cloned().collect(),
      })),
      _ => Err(Type::error(args[1].as_type(), Type::List)),
    }
  }

  /// `(slice list start [end])` — JS `Array.prototype.slice` style.
  pub fn slice<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 || args.len() > 3 {
      return Err(RuntimeError::ArityError {
        detail: "slice takes 2 or 3 args".into(),
      });
    }
    let list = match &args[0] {
      Value::List(l) => l,
      _ => return Err(Type::error(args[0].as_type(), Type::List)),
    };
    let len = list.items.len() as i64;
    let normalize = |i: i64| {
      if i < 0 { (len + i).max(0) } else { i.min(len) }
    };
    let start = normalize((&args[1]).try_into()?);
    let end = if let Some(e) = args.get(2) {
      normalize(e.try_into()?)
    } else {
      len
    };
    if end <= start {
      return Ok(Value::List(List { items: vec![].into() }));
    }
    Ok(Value::List(List {
      items: list.items[start as usize..end as usize].to_vec().into(),
    }))
  }

  /// `(conj list item)` — append item to the end of list.
  pub fn conj<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 {
      return Err(RuntimeError::ArityError {
        detail: "conj takes coll + items".into(),
      });
    }
    let mut iter = args.into_iter();
    let coll = iter.next().unwrap();
    match coll {
      Value::List(mut l) => {
        for item in iter {
          l.items.push(item);
        }
        Ok(Value::List(l))
      }
      _ => Err(RuntimeError::Other("conj: not a list".into())),
    }
  }

  fn values_eq<S: Symbol>(a: &Value<S>, b: &Value<S>) -> bool {
    match (a, b) {
      (Value::Integer(x), Value::Integer(y)) => x == y,
      (Value::Float(x), Value::Float(y)) => x == y,
      (Value::String(x), Value::String(y)) => x == y,
      (Value::Boolean(x), Value::Boolean(y)) => x == y,
      (Value::Nil, Value::Nil) => true,
      _ => false,
    }
  }
}

#[cfg(test)]
mod tests {
  use string_interner::symbol::SymbolU32;

  use crate::{Runtime, Value};

  fn is_true(source: &str) {
    let values = Runtime::<SymbolU32>::eval(None, source).unwrap();
    assert!(
      matches!(values.as_slice(), [Value::Boolean(true)]),
      "{source}: {values:?}"
    );
  }

  #[test]
  fn sort_by_preserves_ties_in_both_directions() {
    for (descending, ids) in [
      ("false", "(list \"b\" \"d\" \"a\" \"c\")"),
      ("true", "(list \"a\" \"c\" \"b\" \"d\")"),
    ] {
      let source = format!(
        r#"(= (map (lambda (row) (get row "id"))
        (sort-by (list (hash-map "k" 2 "id" "a") (hash-map "k" 1 "id" "b")
                       (hash-map "k" 2 "id" "c") (hash-map "k" 1 "id" "d")) "k" {descending})) {ids})"#
      );
      is_true(&source);
    }
    is_true(r#"(= (map (lambda (row) (get row "id"))
      (sort-by (list (hash-map "k" 2 "id" "a") (hash-map "k" 1 "id" "b")) "k"))
      (list "b" "a"))"#);
  }

  #[test]
  fn sort_by_uses_exact_numeric_and_lexical_string_order() {
    is_true(r#"(= (map (lambda (row) (get row "id"))
      (sort-by (list (hash-map "k" 9007199254740993 "id" "large")
                     (hash-map "k" 9007199254740992.0 "id" "small")
                     (hash-map "k" -0.0 "id" "zero-a")
                     (hash-map "k" 0 "id" "zero-b")) "k"))
      (list "zero-a" "zero-b" "small" "large"))"#);
    is_true(r#"(= (map (lambda (row) (get row "k"))
      (sort-by (list (hash-map "k" "😀") (hash-map "k" "a") (hash-map "k" "é")) "k"))
      (list "a" "é" "😀"))"#);
  }

  #[test]
  fn sort_by_orders_integer_bounds_and_infinities() {
    let rows = r#"(list (hash-map "k" (** 0 -1) "id" "pos-inf")
      (hash-map "k" 9223372036854775808.0 "id" "above-max")
      (hash-map "k" -9223372036854775808 "id" "min-int")
      (hash-map "k" -9223372036854775808.0 "id" "min-float")
      (hash-map "k" 9223372036854775807 "id" "max-int")
      (hash-map "k" (- (** 0 -1)) "id" "neg-inf"))"#;
    for (descending, ids) in [
      ("false", r#"(list "neg-inf" "min-int" "min-float" "max-int" "above-max" "pos-inf")"#),
      ("true", r#"(list "pos-inf" "above-max" "max-int" "min-int" "min-float" "neg-inf")"#),
    ] {
      is_true(&format!(r#"(= (map (lambda (row) (get row "id"))
        (sort-by {rows} "k" {descending})) {ids})"#));
    }
  }

  #[test]
  fn sort_by_keeps_integer_float_ties_in_both_directions() {
    let rows = r#"(list (hash-map "k" 1 "id" "one-int")
      (hash-map "k" 2 "id" "two")
      (hash-map "k" 1.0 "id" "one-float")
      (hash-map "k" 1 "id" "one-int-again"))"#;
    for (descending, ids) in [
      ("false", r#"(list "one-int" "one-float" "one-int-again" "two")"#),
      ("true", r#"(list "two" "one-int" "one-float" "one-int-again")"#),
    ] {
      is_true(&format!(r#"(= (map (lambda (row) (get row "id"))
        (sort-by {rows} "k" {descending})) {ids})"#));
    }
  }

  #[test]
  fn sort_by_rejects_invalid_rows_and_keys_before_sorting() {
    for (source, reason) in [
      (r#"(sort-by 3 "k")"#, "List"),
      (r#"(sort-by (list 3) "k")"#, "row 0 is not a map"),
      (r#"(sort-by (list (hash-map "x" 1)) "k")"#, "missing field"),
      (r#"(sort-by (list (hash-map "k" nil)) "k")"#, "must be a number or string"),
      (r#"(sort-by (list (hash-map "k" 1) (hash-map "k" "1")) "k")"#, "mixes numbers and strings"),
      (r#"(sort-by (list (hash-map "k" (** -1 0.5))) "k")"#, "cannot order NaN"),
      (r#"(sort-by (list) "k" "true")"#, "Boolean"),
    ] {
      is_true(&format!("(error? (try {source}))"));
      let checked = format!("(error.message (try {source}))");
      let values = Runtime::<SymbolU32>::eval(None, &checked).unwrap();
      let [Value::String(detail)] = values.as_slice() else {
        panic!("{source}: expected a captured error message, got {values:?}");
      };
      assert!(detail.contains(reason), "{source}: {detail}");
    }
  }

  #[test]
  fn sort_by_handles_two_thousand_rows_without_script_recursion() {
    is_true(
      r#"(= (map (lambda (row) (get row "score"))
      (sort-by (map (lambda (score) (hash-map "score" score)) (range 2000 0 -1)) "score"))
      (range 1 2001))"#,
    );
  }


  #[test]
  fn mixed_numeric_comparisons_preserve_integer_boundaries() {
    for (source, expected) in [
      ("(= 9007199254740993 9007199254740992.0)", false),
      ("(> 9007199254740993 9007199254740992.0)", true),
      ("(< 9007199254740992.0 9007199254740993)", true),
      ("(= 9223372036854775807 9223372036854775808.0)", false),
      ("(< 9223372036854775807 9223372036854775808.0)", true),
      ("(= -9223372036854775808 -9223372036854775808.0)", true),
      ("(< -1 -0.5)", true),
      ("(> 1 0.5)", true),
      ("(= 0 -0.0)", true),
      ("(= 1 1.0)", true),
    ] {
      let values = Runtime::<SymbolU32>::eval(None, source).unwrap();
      assert!(matches!(values[0], Value::Boolean(v) if v == expected), "{source}: {:?}", values[0]);
    }
  }

  #[test]
  fn unordered_numeric_values_do_not_compare_as_equal() {
    for operator in ["<", ">", "<=", ">="] {
      let source = format!("({operator} (** -1 0.5) 1)");
      assert!(Runtime::<SymbolU32>::eval(None, &source).is_err(), "{source}");
    }
  }

  #[test]
  fn native_work_is_bounded_and_integer_overflow_is_an_error() {
    for source in [
      r#"(str.repeat "abc" 9223372036854775807)"#,
      "(range 9223372036854775807)",
      "(+ 9223372036854775807 1)",
      "(* 9223372036854775807 2)",
      "(- -9223372036854775808)",
      "(% -9223372036854775808 -1)",
      "(// -9223372036854775808 -1)",
    ] {
      assert!(
        Runtime::<SymbolU32>::eval(None, source).is_err(),
        "{source}"
      );
    }
    let values = Runtime::<SymbolU32>::eval(None,
      r#"(+ 9007199254740992 1) (range 9223372036854775806 9223372036854775807 2) (str.repeat "" 9223372036854775807)"#).unwrap();
    assert!(matches!(values[0], Value::Integer(9007199254740993)));
    assert!(matches!(&values[1], Value::List(v) if v.items.len() == 1));
    assert!(matches!(&values[2], Value::String(v) if v.is_empty()));
  }

  #[test]
  fn rounding_returns_integers_and_passes_integers_through() {
    for (source, expected) in [
      ("(floor 2.7)", 2),
      ("(floor -2.5)", -3),
      ("(ceil 2.1)", 3),
      ("(ceil -2.7)", -2),
      ("(round 2.5)", 3),
      ("(round -2.5)", -3),
      ("(round 2.49)", 2),
      ("(trunc -2.7)", -2),
      ("(trunc 2.7)", 2),
      ("(floor 7)", 7),
      ("(round -9223372036854775808)", i64::MIN),
      ("(nth (list 10 20 30) (floor 1.9))", 20),
    ] {
      let values = Runtime::<SymbolU32>::eval(None, source).unwrap();
      assert!(matches!(values[0], Value::Integer(n) if n == expected), "{source}: {:?}", values[0]);
    }
    for source in ["(floor (** -1 0.5))", "(ceil (** 0 -1))", "(round 1e19)", "(floor \"1\")", "(floor nil)"] {
      is_true(&format!("(error? (try {source}))"));
    }
    assert!(Runtime::<SymbolU32>::eval(None, "(floor 1 2)").is_err());
  }

  #[test]
  fn not_reads_nil_as_false() {
    is_true("(not nil)");
    is_true("(not (not 0))");
    is_true(r#"(not (get (hash-map) "absent"))"#);
  }

  #[test]
  fn get_on_a_list_gives_the_default_for_any_missing_index() {
    is_true("(= (get (list 1 2) 0) 1)");
    is_true("(null? (get (list 1 2) 2))");
    is_true("(null? (get (list 1 2) -1))");
    is_true(r#"(null? (get (list 1 2) "name"))"#);
    is_true(r#"(= (get (list 1 2) "name" 0) 0)"#);
    is_true(r#"(= (get (list 1 2) 5 "d") "d")"#);
    is_true(r#"(= (get (hash-map "a" 1) :a) 1)"#);
    assert!(Runtime::<SymbolU32>::eval(None, r#"(get 5 "a")"#).is_err());
  }

  #[test]
  fn range_is_bounded_by_memory_not_by_sixty_five_thousand_elements() {
    let limit = super::lists::RANGE_BYTES / std::mem::size_of::<Value<SymbolU32>>();
    assert!(limit >= 1_000_000, "{limit}");
    is_true("(= (length (range 100000)) 100000)");
    eprintln!("range limit: {limit} elements");
    let over = format!("(error.message (try (range {})))", limit + 1);
    let values = Runtime::<SymbolU32>::eval(None, &over).unwrap();
    assert!(matches!(&values[0], Value::String(m) if m.contains("element limit")), "{values:?}");
  }

  #[test]
  fn string_slice_uses_unicode_scalar_positions() {
    let values =
      Runtime::<SymbolU32>::eval(None, r#"(str.slice "a😀bc" 1 3) (str.slice "a😀bc" -2)"#)
        .unwrap();
    assert!(matches!(&values[0], Value::String(text) if text == "😀b"));
    assert!(matches!(&values[1], Value::String(text) if text == "bc"));
  }

  #[test]
  fn string_find_returns_a_slice_compatible_character_index() {
    let values = Runtime::<SymbolU32>::eval(
      None,
      r#"(str.find "a😀bc; tail" ";") (str.find "a😀bc" "missing")"#,
    )
    .unwrap();
    assert!(matches!(values[0], Value::Integer(4)));
    assert!(matches!(values[1], Value::Boolean(false)));
  }

  #[test]
  fn terminal_safe_preserves_layout_but_neutralizes_controls() {
    let values =
      Runtime::<SymbolU32>::eval(None, "(str.terminal-safe \"a\\n\\t\\r\u{1b}b\")").unwrap();
    assert!(matches!(&values[0], Value::String(text) if text == "a\n\t↵\\u{1b}b"));
  }
  #[test]
  fn json_stringify_roundtrips_control_characters_and_keys() {
    let key = "quote\"\\\n\t\u{0000}😀";
    let text = "line one\r\nline two\t\\end\"\u{001b}\u{0008}";
    let mut map = indexmap::IndexMap::new();
    map.insert(key.to_string(), Value::<SymbolU32>::String(text.into()));
    let encoded = super::maps::json_stringify(
      vec![Value::Map(map.into())],
    ).unwrap();
    let Value::String(encoded) = encoded else { panic!("expected JSON text") };
    let parsed: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(parsed[key], text);
    assert!(!encoded.chars().any(|c| c.is_control()));
  }
}
