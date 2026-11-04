//! Type predicates: `nil?`, `bool?`, `number?`, `int?`, `float?`, `string?`,
//! `list?`, `map?`, `fn?`.
//!
//! Each takes exactly one value of any type and answers `true` or `false`;
//! none errors on an unexpected type, so a polymorphic API can branch on what
//! it was given without a `try` probe. They test the runtime shape only:
//! `nil?` is true for `nil` alone (`null?` also accepts the empty list), and
//! `int?` is false for `2.0`, which is a float.

use super::*;

fn one<'a, S: Symbol>(args: &'a [Value<S>], name: &str) -> Result<&'a Value<S>, RuntimeError> {
  match args {
    [value] => Ok(value),
    _ => Err(RuntimeError::ArityError {
      detail: format!("{name} takes 1 arg"),
    }),
  }
}

macro_rules! predicate {
  ($fn_name:ident, $lisp:literal, $pattern:pat) => {
    #[doc = concat!("`(", $lisp, " VALUE)`")]
    pub fn $fn_name<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
      Ok(Value::Boolean(matches!(one(&args, $lisp)?, $pattern)))
    }
  };
}

predicate!(is_nil, "nil?", Value::Nil);
predicate!(is_bool, "bool?", Value::Boolean(_));
predicate!(is_number, "number?", Value::Integer(_) | Value::Float(_));
predicate!(is_int, "int?", Value::Integer(_));
predicate!(is_float, "float?", Value::Float(_));
predicate!(is_string, "string?", Value::String(_));
predicate!(is_list, "list?", Value::List(_));
predicate!(is_map, "map?", Value::Map(_));
predicate!(is_fn, "fn?", Value::Function(_));

/// Every predicate name, for the tests that sweep them all.
#[cfg(test)]
pub(super) const ALL: &[&str] = &[
  "nil?", "bool?", "number?", "int?", "float?", "string?", "list?", "map?", "fn?",
];

#[cfg(test)]
mod tests {
  use string_interner::symbol::SymbolU32;

  use crate::{Runtime, Value};

  /// Every predicate against one value of each kind, as a row of booleans in
  /// [`super::ALL`] order.
  #[test]
  fn each_predicate_accepts_exactly_its_kind() {
    let cases: &[(&str, &str)] = &[
      ("nil", "nil?"),
      ("true", "bool?"),
      ("false", "bool?"),
      ("3", "number? int?"),
      ("2.0", "number? float?"),
      (r#""s""#, "string?"),
      // A quoted symbol evaluates to its name as a string, so no `symbol?`.
      ("'sym", "string?"),
      ("(list 1 2)", "list?"),
      ("(list)", "list?"),
      ("(hash-map \"k\" 1)", "map?"),
      ("(lambda (x) x)", "fn?"),
      ("+", "fn?"),
      ("(try (car 1))", ""),
    ];
    for (value, expected) in cases {
      let expected: Vec<&str> = expected.split_whitespace().collect();
      for name in super::ALL {
        let source = format!("({name} {value})");
        let got =
          Runtime::<SymbolU32>::eval(None, &source).unwrap_or_else(|e| panic!("{source}: {e:?}"));
        let want = expected.contains(name);
        assert!(
          matches!(got.as_slice(), [Value::Boolean(b)] if *b == want),
          "{source}: {got:?}, wanted {want}"
        );
      }
    }
  }

  #[test]
  fn predicates_take_exactly_one_argument() {
    for name in super::ALL {
      assert!(
        Runtime::<SymbolU32>::eval(None, &format!("({name})")).is_err(),
        "{name}"
      );
      assert!(
        Runtime::<SymbolU32>::eval(None, &format!("({name} 1 2)")).is_err(),
        "{name}"
      );
    }
  }
}
