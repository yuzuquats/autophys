//! Correctness of integer arithmetic, division by zero, `match` equality,
//! non-callable heads, JSON encoding/paths, error origins and reader messages.

use string_interner::{StringInterner, backend::StringBackend, symbol::SymbolU32};
use tento_lisp::{Interpreter, Runtime, RuntimeError, SyntaxError, Value, format_value};

type Interp = Interpreter<SymbolU32, StringBackend>;

/// Eval `src` form by form; the first runtime error ends it.
fn run_in(interp: &mut Interp, src: &str) -> Result<Value<SymbolU32>, RuntimeError> {
  let env = Interpreter::default_env(interp);
  let asts = Runtime::<SymbolU32, StringBackend>::parse(None, src, interp.string_interner()).expect("parse");
  let mut last = Value::Nil;
  for ast in asts {
    last = interp.eval_expression(env.clone(), &Value::from_sexpression(&ast).expect("value"))?;
  }
  Ok(last)
}

/// `src`'s value as REPL text, or `ERR: <message>`.
fn eval(src: &str) -> String {
  let mut interp = Interp::new();
  match run_in(&mut interp, src) {
    Ok(v) => format_value(interp.string_interner(), &v),
    Err(e) => format!("ERR: {e}"),
  }
}

fn parse_err(src: &str) -> SyntaxError {
  let mut interner = StringInterner::<StringBackend>::new();
  Runtime::<SymbolU32, StringBackend>::parse(None, src, &mut interner).expect_err("expected a syntax error")
}

#[test]
fn integer_power_is_exact_and_checked() {
  assert_eq!(eval("(** 3 34)"), "16677181699666569");
  assert_eq!(eval("(** 2 62)"), "4611686018427387904");
  assert_eq!(eval("(** -2 63)"), "-9223372036854775808");
  assert_eq!(eval("(** 2 0)"), "1");
  assert_eq!(eval("(** 0 0)"), "1");
  assert_eq!(eval("(** -1 9999999999)"), "-1");
  assert_eq!(eval("(** 1 9999999999)"), "1");
  assert_eq!(eval("(** 2 63)"), "ERR: integer overflow in **");
  assert_eq!(eval("(** 3 9999999999)"), "ERR: integer overflow in **");
  // The overflow is soft: `try` captures it like `+`/`*` overflow.
  assert_eq!(eval("(error? (try (** 2 63)))"), "true");
  assert_eq!(eval("(error? (try (* 9223372036854775807 2)))"), "true");
  // Float operands and negative exponents keep float semantics.
  assert_eq!(eval("(** 2 0.5)"), "1.4142135623730951");
  assert_eq!(eval("(** 2.0 3)"), "8");
  assert_eq!(eval("(float? (** 2.0 3))"), "true");
  assert_eq!(eval("(** 2 -1)"), "0.5");
}

#[test]
fn abs_of_the_minimum_integer_is_an_overflow_error() {
  assert_eq!(eval("(abs -9223372036854775808)"), "ERR: integer overflow in abs");
  assert_eq!(eval("(error? (try (abs -9223372036854775808)))"), "true");
  assert_eq!(eval("(abs -9223372036854775807)"), "9223372036854775807");
  assert_eq!(eval("(abs -2.5)"), "2.5");
}

#[test]
fn integer_division_refuses_floats_outside_the_integer_range() {
  assert_eq!(eval("(// 7.5 2)"), "3");
  assert_eq!(eval("(% 7.5 2)"), "1");
  assert_eq!(eval("(// 1e300 1)"), format!("ERR: float {:?} is out of integer range in //", 1e300_f64));
  assert!(eval("(% 1e300 7)").starts_with("ERR: float "));
  assert!(eval("(// (* 1e308 10) 1)").contains("out of integer range in //"));
  assert!(eval("(% 1 (- (* 1e308 10) (* 1e308 10)))").contains("out of integer range in %"));
  assert_eq!(eval("(// 9223372036854775807.0 1)"), format!("ERR: float {:?} is out of integer range in //", 9223372036854775807.0_f64));
  assert_eq!(eval("(// -9223372036854775808.0 1)"), "-9223372036854775808");
  assert_eq!(eval("(error? (try (// 1e300 1)))"), "true");
}

#[test]
fn division_by_zero_is_a_catchable_error() {
  for src in ["(/ 1 0)", "(/ 1.0 0)", "(/ 1 0.0)", "(/ 0)", "(/ 6 2 0)"] {
    assert_eq!(eval(src), "ERR: division by zero", "{src}");
    assert_eq!(eval(&format!("(error? (try {src}))")), "true", "{src}");
  }
  assert_eq!(eval("(// 1 0)"), "ERR: floor-div by zero");
  assert_eq!(eval("(/ 1 2)"), "0.5");
  assert_eq!(eval("(/ 4)"), "0.25");
}

#[test]
fn match_uses_the_same_equality_as_eq() {
  // 2^53 + 1 is not equal to the float 2^53, for `=` and for `match`.
  assert_eq!(eval("(= 9007199254740993 9007199254740992.0)"), "false");
  assert_eq!(eval(r#"(match 9007199254740993 (9007199254740992.0 "same") (_ "diff"))"#), "diff");
  assert_eq!(eval(r#"(match 9007199254740993 ((9007199254740992.0) "same") (_ "diff"))"#), "diff");
  assert_eq!(eval(r#"(match 9007199254740992 (9007199254740992.0 "same") (_ "diff"))"#), "same");
  assert_eq!(eval(r#"(match 1 (1.0 "same") (_ "diff"))"#), "same");
  // List patterns remain any-of; wildcard and boolean guards unchanged.
  assert_eq!(eval(r#"(match 2 ((1 2 3) "small") (_ "big"))"#), "small");
  assert_eq!(eval(r#"(let ok true) (match "x" ("y" 1) (ok 2))"#), "2");
  assert!(eval(r#"(match 5 (1 "one"))"#).starts_with("ERR: match: no clause matched 5"));
}

#[test]
fn a_non_callable_head_evaluates_each_element_once() {
  assert_eq!(eval("(let n 0) ((set n (+ n 1)) 1 2) n"), "1");
  assert_eq!(eval("(let n 0) ((set n (+ n 1)) (set n (+ n 10)) 2)"), "(1 11 2)");
  assert_eq!(eval("(let n 0) ((set n (+ n 1)) (set n (+ n 10))) n"), "11");
  // The documented fallback still returns the evaluated list.
  assert_eq!(eval("(1 2 3)"), "(1 2 3)");
  assert_eq!(eval("(1 (+ 1 1) 3)"), "(1 2 3)");
}

#[test]
fn json_stringify_refuses_non_finite_floats() {
  for src in [
    "(json-stringify (* 1e308 1e308))",
    "(json-stringify (- 0 (* 1e308 1e308)))",
    "(json-stringify (** -1 0.5))",
    "(json-stringify {:a [1 (* 1e308 1e308)]})",
  ] {
    assert!(eval(src).starts_with("ERR: json-stringify: non-finite number"), "{src}: {}", eval(src));
    assert_eq!(eval(&format!("(error? (try {src}))")), "true", "{src}");
  }
  assert_eq!(eval("(json-stringify {:a [1 2.5 nil]})"), r#"{"a":[1,2.5,null]}"#);
}

#[test]
fn json_get_in_steps_into_lists_with_integer_keys() {
  assert_eq!(eval(r#"(json-get-in {:a [{:n 7}]} ["a" 0 "n"])"#), "7");
  assert_eq!(eval(r#"(json-get-in {:a [10 20 30]} [:a 2])"#), "30");
  assert_eq!(eval(r#"(json-get-in {:a [10 20]} ["a" 5])"#), "nil");
  assert_eq!(eval(r#"(json-get-in {:a [10 20]} ["a" -1])"#), "nil");
  // A string never indexes a list, as with `get`.
  assert_eq!(eval(r#"(json-get-in {:a [10 20]} ["a" "0"])"#), "nil");
  assert_eq!(eval(r#"(json-get-in [[1 2] [3 4]] [1 0])"#), "3");
  // A non-string key on a map is still the error `get` raises.
  assert!(eval(r#"(json-get-in {:a 1} [0])"#).starts_with("ERR: type error"));
  assert_eq!(eval(r#"(json-get-in {:a {:b 2}} ["a" "b"])"#), "2");
}

#[test]
fn error_origin_keeps_string_literals_quoted() {
  assert_eq!(eval(r#"(error.origin (try (+ "a b" 7)))"#), r#"(+ "a b" 7)"#);
  assert_eq!(eval(r#"(error.origin (try (+ "q\"t\\n\n" 1)))"#), r#"(+ "q\"t\\n\n" 1)"#);
  assert_eq!(eval(r#"(error.origin (try (+ x 1)))"#), "(+ x 1)");
  // Plain value printing is unchanged.
  assert_eq!(eval(r#"(list "a b" 1)"#), "(a b 1)");
}

#[test]
fn type_errors_say_expected_once() {
  assert_eq!(eval(r#"(* "a" 2)"#), "ERR: type error: expected number (in *), got String");
  assert_eq!(eval(r#"(+ 1.5 "a")"#), "ERR: type error: expected number (in +), got String");
}

#[test]
fn syntax_errors_render_as_human_text() {
  let e = parse_err("(+ 1");
  assert!(matches!(e, SyntaxError::UnexpectedToken { .. }));
  assert_eq!(e.to_string(), "unexpected end of input at line 1, column 5");
  let e = parse_err("(+ 1))");
  assert!(e.to_string().starts_with("unexpected token \""), "{e}");
  assert!(e.to_string().ends_with("at line 1, column 6"), "{e}");
  let e = parse_err("`${`nested`}`");
  assert!(matches!(&e, SyntaxError::InvalidToken { token, .. } if token == "Err(NestedBacktickInTemplateHole)"));
  assert_eq!(e.to_string(), "a backtick string nested inside a template hole at line 1, column 1");
  let mut interner = StringInterner::<StringBackend>::new();
  let e = Runtime::<SymbolU32, StringBackend>::parse(Some("a.tsh".into()), "\n(+ 1", &mut interner).expect_err("syntax error");
  assert_eq!(e.to_string(), "unexpected end of input at a.tsh line 2, column 5");
  // Debug (and so the fields) are unchanged.
  assert!(format!("{:?}", parse_err("(+ 1")).starts_with("UnexpectedToken { token: \"<>\""));
}
