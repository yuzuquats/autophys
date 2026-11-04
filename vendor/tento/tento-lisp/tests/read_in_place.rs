//! `get`, `nth`, `first`, `length`/`count` and `empty?` on a bound name, or
//! on a `get`, `nth` or `first` of one, read the value where it is bound
//! rather than copy it first. Each case here is evaluated twice: as written,
//! and with the collection behind `(begin …)`, which is not a place and so
//! always takes the ordinary path. Both must answer alike, errors included.

use std::{cell::RefCell, rc::Rc};

use string_interner::{backend::StringBackend, symbol::SymbolU32};
use tento_lisp::{Env, Interpreter, Runtime, RuntimeError, Value};

type Interp = Interpreter<SymbolU32, StringBackend>;

fn run(interp: &mut Interp, env: &Rc<RefCell<Env<SymbolU32>>>, source: &str) -> Result<Value<SymbolU32>, RuntimeError> {
  let asts = Runtime::<SymbolU32, StringBackend>::parse(None, source, interp.string_interner()).expect("parse");
  let mut last = Value::Nil;
  for ast in asts {
    last = interp.eval_expression(env.clone(), &Value::from_sexpression(&ast).expect("from_sexpression"))?;
  }
  Ok(last)
}

const SETUP: &str = r#"
  (define thread (hash-map "title" "Ship it" "warm" true "waits" (list (hash-map "kind" "agent" "age" "3m")) "n" 0))
  (define line (hash-map "thread" thread "tag" ""))
  (define rows (list 10 20 30))
  (define word "hello")
  (define key "title")
  (define nothing nil)
"#;

/// `form` with `{}` once as `place` and once as `(begin place)`.
fn same(form: &str, place: &str) {
  let mut interp = Interp::new();
  let env = Interp::default_env(&mut interp);
  run(&mut interp, &env, SETUP).expect("setup");
  let fast = run(&mut interp, &env, &form.replace("{}", place));
  let slow = run(&mut interp, &env, &form.replace("{}", &format!("(begin {place})")));
  match (&fast, &slow) {
    (Ok(a), Ok(b)) => assert_eq!(format!("{a:?}"), format!("{b:?}"), "{form} on {place}"),
    (Err(a), Err(b)) => assert_eq!(a.to_string(), b.to_string(), "{form} on {place}"),
    _ => panic!("{form} on {place}: {fast:?} vs {slow:?}"),
  }
}

#[test]
fn get_reads_a_field_of_a_bound_record_as_before() {
  for form in [
    r#"(get {} "title")"#,
    r#"(get {} "missing")"#,
    r#"(get {} "missing" "fallback")"#,
    r#"(get {} :title)"#,
    r#"(get {} key)"#,
    r#"(get {} "waits")"#,
    r#"(get {} 0)"#,
    r#"(get {} unbound-key)"#,
  ] {
    same(form, "thread");
  }
}

#[test]
fn a_chain_of_reads_over_a_bound_name_answers_as_before() {
  for form in [
    r#"(get {} "title")"#,
    r#"(length {})"#,
    r#"(empty? {})"#,
    r#"(get (first {}) "kind")"#,
  ] {
    same(form, r#"(get line "thread")"#);
    same(form, r#"(get (get line "thread") "waits")"#);
  }
  same(r#"(get (nth {} 0) "age")"#, r#"(get (get line "thread") "waits")"#);
  same(r#"(get {} "x" "d")"#, r#"(get line "nope")"#);
}

#[test]
fn list_reads_answer_as_before() {
  for form in [
    "(nth {} 1)",
    "(nth {} 9)",
    r#"(nth {} "a")"#,
    "(first {})",
    "(length {})",
    "(count {})",
    "(empty? {})",
    "(get {} 2)",
    "(get {} -1)",
    r#"(get {} "x" 5)"#,
  ] {
    same(form, "rows");
  }
}

#[test]
fn reads_of_other_values_answer_as_before() {
  for place in ["word", "nothing", "42", "unbound-name", ":keyword", "nil"] {
    for form in [
      "(length {})",
      "(empty? {})",
      "(first {})",
      "(nth {} 0)",
      r#"(get {} "k")"#,
      r#"(get {} "k" 1)"#,
    ] {
      same(form, place);
    }
  }
}

#[test]
fn a_read_returns_a_copy_the_binding_does_not_share() {
  let mut interp = Interp::new();
  let env = Interp::default_env(&mut interp);
  run(&mut interp, &env, SETUP).expect("setup");
  let out = run(&mut interp, &env, r#"(define w (get thread "waits")) (set w (append w (list 1))) (length (get thread "waits"))"#);
  assert!(matches!(out.expect("evaluates"), Value::Integer(1)));
}

#[test]
fn a_user_function_named_like_a_builtin_is_still_called() {
  let mut interp = Interp::new();
  let env = Interp::default_env(&mut interp);
  run(&mut interp, &env, SETUP).expect("setup");
  let out = run(&mut interp, &env, r#"(let ((get (lambda (m k) "mine"))) (get thread "title"))"#);
  assert!(matches!(out.expect("evaluates"), Value::String(s) if s == "mine"));
  let out = run(&mut interp, &env, r#"(let ((get (lambda (m k) "mine"))) (length (get thread "title")))"#);
  assert!(matches!(out.expect("evaluates"), Value::Integer(4)));
}

#[test]
fn wrong_arity_answers_as_before() {
  for form in ["(get {})", r#"(get {} "a" "b" "c")"#, "(length {} 1)", "(first {} 1)", "(nth {})"] {
    same(form, "thread");
    same(form, "rows");
  }
}

/// A name the fast path would need first is unbound: the missing-symbol hook
/// may change bindings, so the call is left to the ordinary path, which
/// evaluates the collection before the key, hooks in that order.
#[test]
fn an_unbound_argument_leaves_hooks_to_the_ordinary_order() {
  let mut interp = Interp::new();
  let env = Interp::default_env(&mut interp);
  run(&mut interp, &env, "(define rows (list 10 20))").expect("setup");
  let ninety_nine = run(&mut interp, &env, "(list 99)").expect("list");
  interp.set_missing_symbol_hook(Rc::new(move |name: &str| {
    (name == "key").then(|| vec![("key".to_string(), Value::Integer(0)), ("rows".to_string(), ninety_nine.clone())])
  }));
  let out = run(&mut interp, &env, "(get rows key)").expect("evaluates");
  assert!(matches!(out, Value::Integer(10)), "{out:?}");
}

/// A nested read whose head is a special form's name is that special form,
/// whatever the name is bound to.
#[test]
fn a_special_form_head_is_never_read_as_a_place() {
  let mut interp = Interp::new();
  let env = Interp::default_env(&mut interp);
  let out = run(&mut interp, &env, "(let ((rows (list (list 10 20))) (if first)) (length (if rows)))");
  let error = out.expect_err("if with one argument is an arity error");
  assert!(error.to_string().contains("if takes 2 or 3 args"), "{error}");
}

/// Reads in place cost the budget what the ordinary call would, and stop
/// where it would. `(first … (first rows))` nested `n` deep evaluates `rows`
/// `n + 1` frames down, so under a depth limit of 10 a nest of 9 answers
/// and a nest of 10 or more is refused, the same answers the builtins give
/// without reads in place.
#[test]
fn a_read_too_deep_for_the_budget_is_refused_as_before() {
  for nesting in [3usize, 8, 9, 10, 60] {
    let mut interp = Interp::new();
    let env = Interp::default_env(&mut interp);
    let deep = (0..nesting).fold("42".to_string(), |inner, _| format!("(list {inner})"));
    run(&mut interp, &env, &format!("(define rows {deep})")).expect("setup");
    interp.replace_eval_budget(Some(tento_lisp::EvalBudget { max_steps: 1_000_000, deadline: None, max_depth: 10 }));
    let form = (0..nesting).fold("rows".to_string(), |inner, _| format!("(first {inner})"));
    match run(&mut interp, &env, &form) {
      Ok(Value::Integer(42)) => assert!(nesting <= 9, "nesting {nesting} answered"),
      Err(error) => assert!(nesting >= 10 && error.to_string().contains("recursion too deep"), "nesting {nesting}: {error}"),
      other => panic!("nesting {nesting}: {other:?}"),
    }
  }
}

/// The interpreter's own nesting ceiling, with no budget engaged, stops a
/// read in place where it stops the ordinary call: under a ceiling of 10 a
/// nest of 9 answers and a nest of 10 or more is the soft, catchable error.
/// The ordinary path is the same nest over `(begin rows)`, one frame deeper,
/// so it runs under a ceiling one higher.
#[test]
fn a_read_too_deep_for_the_interpreter_ceiling_is_refused_as_before() {
  for nesting in [3usize, 8, 9, 10, 60] {
    let answer = |place: &str, ceiling: u32| {
      let mut interp = Interp::new();
      let env = Interp::default_env(&mut interp);
      let deep = (0..nesting).fold("42".to_string(), |inner, _| format!("(list {inner})"));
      run(&mut interp, &env, &format!("(define rows {deep})")).expect("setup");
      interp.set_max_eval_depth(ceiling);
      let form = (0..nesting).fold(place.to_string(), |inner, _| format!("(first {inner})"));
      let out = run(&mut interp, &env, &form);
      // `(if (try …))` holds the read two frames deeper.
      interp.set_max_eval_depth(ceiling + 2);
      let caught = run(&mut interp, &env, &format!(r#"(if (try {form}) "answered" "caught")"#));
      assert_eq!(interp.eval_depth(), 0, "nesting {nesting} on {place}");
      (out, caught)
    };
    let (fast, fast_caught) = answer("rows", 10);
    let (slow, slow_caught) = answer("(begin rows)", 11);
    match (&fast, &slow) {
      (Ok(a), Ok(b)) => {
        assert!(nesting <= 9 && matches!(a, Value::Integer(42)), "nesting {nesting} answered {a:?}");
        assert_eq!(format!("{a:?}"), format!("{b:?}"), "nesting {nesting}");
      }
      (Err(a), Err(b)) => {
        assert!(nesting >= 10, "nesting {nesting}: {a}");
        for e in [a, b] {
          assert!(!e.is_hard() && e.to_string().contains("eval recursion too deep"), "nesting {nesting}: {e}");
        }
      }
      _ => panic!("nesting {nesting}: {fast:?} vs {slow:?}"),
    }
    let caught = |v: &Result<Value<SymbolU32>, RuntimeError>| matches!(v, Ok(Value::String(s)) if s == "caught");
    assert_eq!(caught(&fast_caught), nesting >= 10, "nesting {nesting}: {fast_caught:?}");
    assert_eq!(caught(&slow_caught), nesting >= 10, "nesting {nesting}: {slow_caught:?}");
  }
}
