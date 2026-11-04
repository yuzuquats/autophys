use std::{cell::RefCell, rc::Rc};
use string_interner::{backend::StringBackend, symbol::SymbolU32};
use crate::{Env, Interpreter, Runtime, Value};

type I = Interpreter<SymbolU32, StringBackend>;

#[test]
fn typed_variadic_parameters_collect_data_and_validate_every_element() {
  let mut i = I::new(); let env = i.default_env();
  assert_eq!(json(&mut i, &env, r#"
    (fn collect (name string ...values (list s64)) -> any (list name values))
    (list (collect "none") (collect "two" 1 2) (apply collect (list "applied" 3 4)))
  "#), serde_json::json!([["none",[]],["two",[1,2]],["applied",[3,4]]]));
  assert!(eval(&mut i, &env, "(collect \"bad\" 1 \"two\")").unwrap_err().contains("arguments.values[1]"));
  assert!(eval(&mut i, &env, "(fn invalid (...values (list s64) next s64) -> any values)").unwrap_err().contains("variadic parameter must be last"));
}
fn eval(i: &mut I, env: &Rc<RefCell<Env<SymbolU32>>>, source: &str) -> Result<Value<SymbolU32>, String> {
  let forms = Runtime::parse(None, source, &mut i.interner).map_err(|e| format!("{e:?}"))?;
  let mut value = Value::Nil;
  for form in forms {
    let form = Value::from_owned_sexpression(form).map_err(|e| format!("{e:?}"))?;
    value = i.eval_expression(env.clone(), &form).map_err(|e| e.to_string())?;
  }
  Ok(value)
}
fn json(i: &mut I, env: &Rc<RefCell<Env<SymbolU32>>>, source: &str) -> serde_json::Value {
  crate::types::data_json(&eval(i, env, source).unwrap()).unwrap()
}

#[test]
fn typed_functions_bind_mixed_inputs_defaults_and_optional_values() {
  let mut i = I::new(); let env = i.default_env();
  let result = json(&mut i, &env, r#"
    (fn sample (prefix string count: s64 = 2 flag: bool = false note: (option string)) -> any
      (list prefix count flag note))
    (list (sample "--help") (sample note: "literal:" flag: true "ok" count: 3))
  "#);
  assert_eq!(result, serde_json::json!([["--help",2,false,null],["ok",3,true,"literal:"]]));
}

#[test]
fn typed_inputs_reject_before_body_and_strings_never_become_controls() {
  let mut i = I::new(); let env = i.default_env();
  eval(&mut i, &env, r#"(define calls 0)
    (fn f (x: s64) -> s64 (set! calls (+ calls 1)) x)"#).unwrap();
  for (source, message) in [
    ("(f)", "missing argument x"),
    ("(f x: 1 x: 2)", "duplicate argument x"),
    ("(f other: 1)", "unknown named argument other"),
    ("(f 1)", "too many positional arguments"),
    ("(f x: \"1\")", "arguments.x"),
    ("(f \"x:\" 1)", "too many positional arguments"),
    ("(f x:)", "missing value after x:"),
  ] {
    let error = eval(&mut i, &env, source).unwrap_err();
    assert!(error.contains(message), "{source}: {error}");
    assert_eq!(json(&mut i, &env, "calls"), 0);
  }
  assert_eq!(json(&mut i, &env, "(f x: 4)"), 4);
  assert_eq!(json(&mut i, &env, "calls"), 1);
}

#[test]
fn typed_results_validate_nested_records_and_every_list_element() {
  let mut i = I::new(); let env = i.default_env();
  eval(&mut i, &env, r#"
    (struct Row id: string)
    (struct Report rows: (list Row))
    (fn good () -> Report {"rows" (list {"id" "a" "extra" true}) "extra" 1})
    (fn bad () -> Report {"rows" (list {"id" "a"} {"id" 7})})
    (fn missing () -> Report {})
  "#).unwrap();
  assert!(json(&mut i, &env, "(good)")["extra"] == 1);
  assert!(eval(&mut i, &env, "(bad)").unwrap_err().contains("result.rows[1].id"));
  assert!(eval(&mut i, &env, "(missing)").unwrap_err().contains("result.rows"));
  assert_eq!(json(&mut i, &env, "(+ 1 2)"), 3);
}

#[test]
fn typed_closures_keep_lexical_state_after_factory_scope_release() {
  let mut i = I::new(); let env = i.default_env();
  assert_eq!(json(&mut i, &env, r#"
    (define (factory start)
      (lambda (step: s64 = 1) -> s64
        (set! start (+ start step)) start))
    (define next (factory 10))
    (list (next) (next step: 3) (next))
  "#), serde_json::json!([11,14,15]));
}

#[test]
fn typed_functions_work_in_recursion_map_apply_and_aliases() {
  let mut i = I::new(); let env = i.default_env();
  assert_eq!(json(&mut i, &env, r#"
    (fn fact (n s64) -> s64 (if (= n 0) 1 (* n (fact (- n 1)))))
    (define alias fact)
    (define (plus x s64 y s64 = 1) -> s64 (+ x y))
    (defun negate (x s64) -> s64 (- 0 x))
    (list (alias 5) (map plus (list 1 2 3)) (apply plus (list 4 5)) (negate 6))
  "#), serde_json::json!([120,[2,3,4],9,-6]));
  assert!(eval(&mut i, &env, r#"(map plus (list 1 "bad"))"#).unwrap_err().contains("arguments.x"));
  assert!(eval(&mut i, &env, r#"(apply plus (list 1 2 3))"#).unwrap_err().contains("too many positional"));
  assert!(eval(&mut i, &env, r#"(map (lambda (x s64) -> string x) (list 1))"#).unwrap_err().contains("result"));
}

#[test]
fn typed_defaults_run_only_when_omitted_and_follow_live_lexical_state() {
  let mut i = I::new(); let env = i.default_env();
  assert_eq!(json(&mut i, &env, r#"
    (define defaults 0)
    (define current 5)
    (fn f (x: s64 = (begin (set defaults (+ defaults 1)) current)) -> s64 x)
    (set current 9)
    (list defaults (f x: 3) defaults (f) (f) defaults)
  "#), serde_json::json!([0,3,0,9,9,2]));
}

#[test]
fn typed_defaults_see_earlier_parameters_in_declaration_order() {
  let mut i = I::new(); let env = i.default_env();
  assert_eq!(json(&mut i, &env, r#"
    (define current 5)
    (fn sample (x: s64 = current doubled: s64 = (* x 2)) -> s64 doubled)
    (set current 9)
    (define (positional x s64 y s64 = (+ x 1)) -> s64 y)
    (list (sample) (sample x: 3) (sample doubled: 20 x: 3)
      (map positional (list 1 2)) (apply positional (list 4)))
  "#), serde_json::json!([18,6,20,[2,3],5]));
}

#[test]
fn typed_defaults_keep_captured_factory_state_and_use_fresh_values() {
  let mut i = I::new(); let env = i.default_env();
  assert_eq!(json(&mut i, &env, r#"
    (define (factory start)
      (lambda (value: (list s64) = (list start)) -> (list s64)
        (set start (+ start 1)) value))
    (define next (factory 10))
    (list (next) (next) (next value: (list 99)) (next))
  "#), serde_json::json!([[10],[11],[99],[13]]));
}

#[test]
fn explicit_nil_and_false_zero_empty_values_do_not_trigger_defaults() {
  let mut i = I::new(); let env = i.default_env();
  assert_eq!(json(&mut i, &env, r#"
    (define calls 0)
    (fn f (x: (option s64) = (begin (set calls (+ calls 1)) 7)
           flag: bool = true count: s64 = 4 text: string = "fallback") -> any
      (list x flag count text))
    (list (f x: nil flag: false count: 0 text: "") calls (f) calls)
  "#), serde_json::json!([[null,false,0,""],0,[7,true,4,"fallback"],1]));
  eval(&mut i, &env, "(fn required (x: s64 = 7) -> s64 x)").unwrap();
  assert!(eval(&mut i, &env, "(required x: nil)").unwrap_err().contains("arguments.x"));
}

#[test]
fn bad_defaults_fail_at_call_before_body_and_supplied_arguments_skip_them() {
  let mut i = I::new(); let env = i.default_env();
  eval(&mut i, &env, r#"
    (define body-calls 0)
    (fn invalid (x: s64 = "bad") -> s64 (set body-calls (+ body-calls 1)) x)
    (fn unresolved (x: s64 = missing-default-value) -> s64 x)
  "#).unwrap();
  assert!(eval(&mut i, &env, "(invalid)").unwrap_err().contains("arguments.x.default"));
  assert_eq!(json(&mut i, &env, "body-calls"), serde_json::json!(0));
  assert_eq!(json(&mut i, &env, "(list (invalid x: 2) (unresolved x: 3) body-calls)"), serde_json::json!([2,3,1]));
  assert!(eval(&mut i, &env, "(unresolved)").unwrap_err().contains("missing-default-value"));
}

#[test]
fn malformed_calls_reject_before_default_side_effects() {
  let mut i = I::new(); let env = i.default_env();
  eval(&mut i, &env, r#"
    (define defaults 0)
    (fn f (x: s64 = (begin (set defaults (+ defaults 1)) 7) needed: s64) -> s64 x)
  "#).unwrap();
  for source in ["(f)", "(f needed: 1 unknown: 2)", "(f needed: 1 needed: 2)", "(f needed: nil)", "(f 1 needed: 2)"] {
    assert!(eval(&mut i, &env, source).is_err(), "{source}");
    assert_eq!(json(&mut i, &env, "defaults"), serde_json::json!(0));
  }
}

#[test]
fn pending_parameters_shadow_outer_names_without_running_host_fallbacks() {
  let mut i = I::new(); let env = i.default_env();
  eval(&mut i, &env, r#"
    (define x 99) (define y 88)
    (fn selfref (x: s64 = x) -> s64 x)
    (fn forward (x: s64 = y y: s64 = 1) -> s64 x)
    (fn callforward (x: s64 = (y) y: s64 = 1) -> s64 x)
    (fn mutate (x: s64 = (begin (set y 0) 1) y: s64 = 2) -> s64 x)
  "#).unwrap();
  i.set_missing_symbol_hook(Rc::new(|_| panic!("pending parameter reached symbol fallback")));
  i.set_call_head_hook(Rc::new(|_, _| panic!("pending parameter reached command fallback")));
  for source in ["(selfref)", "(forward)", "(forward y: 3)", "(callforward)"] {
    assert!(eval(&mut i, &env, source).unwrap_err().contains("before initialization"), "{source}");
  }
  assert!(eval(&mut i, &env, "(mutate)").is_err());
  assert_eq!(json(&mut i, &env, "(list x y (forward x: 4))"), serde_json::json!([99,88,4]));
}

#[test]
fn default_descriptions_preserve_expressions_without_executing_them() {
  let mut i = I::new(); let env = i.default_env();
  let value = eval(&mut i, &env, r#"
    (define calls 0)
    (fn describe (x: string = (begin (set calls (+ calls 1)) "hello")) -> string x)
  "#).unwrap();
  let Value::Function(crate::Function::Lambda(lambda)) = value else { panic!("expected lambda") };
  let description = lambda.signature.as_ref().unwrap().describe();
  assert_eq!(description["parameters"][0]["required"], false);
  assert_eq!(description["parameters"][0]["default_expression"], r#"(begin (set calls (+ calls 1)) "hello")"#);
  assert_eq!(json(&mut i, &env, "calls"), serde_json::json!(0));
}

#[test]
fn typed_signature_errors_remain_definition_errors() {
  let mut i = I::new(); let env = i.default_env();
  for (source, message) in [
    ("(fn duplicate (x s64 x: s64) -> s64 x)", "duplicate parameter x"),
    ("(fn no-type (x:) -> s64 1)", "missing type for x"),
    ("(fn unknown (x: Missing) -> s64 1)", "unknown type Missing"),
    ("(lambda (x s64) -> s64)", "needs -> Result and a body"),
  ] {
    let error = eval(&mut i, &env, source).unwrap_err();
    assert!(error.contains(message), "{source}: {error}");
  }
}

#[test]
fn legacy_untyped_forms_keep_their_calling_convention() {
  let mut i = I::new(); let env = i.default_env();
  assert_eq!(json(&mut i, &env, r#"
    (fn f (x) (+ x 1))
    (define (g x) (+ x 2))
    (list (f 3) (g 3) ((lambda (x) (+ x 3)) 3))
  "#), serde_json::json!([4,5,6]));
}


#[test]
fn typed_recursion_still_stops_at_the_evaluation_budget() {
  let mut i = I::new(); let env = i.default_env();
  i.replace_eval_budget(Some(crate::EvalBudget {
    max_steps: 50_000, deadline: None, max_depth: 200,
  }));
  let error = eval(&mut i, &env, "(fn boom () -> s64 (boom)) (try (boom))").unwrap_err();
  assert!(error.contains("recursion too deep") || error.contains("budget exceeded"), "{error}");
}

#[test]
fn typed_parameters_have_no_reserved_help_or_json_names() {
  let mut i = I::new(); let env = i.default_env();
  assert_eq!(json(&mut i, &env, r#"
    (fn normal (help: bool json: string) -> any (list help json))
    (normal help: true json: "--help")
  "#), serde_json::json!([true,"--help"]));
}
