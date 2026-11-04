//! The interpreter's own recursion ceiling is an ordinary error.
//!
//! A host's `EvalBudget` depth cap is a rail and halts, but a script with no
//! budget used to have no ceiling at all: it recursed until the native stack
//! overflowed and the process aborted, which no `(try …)` can see. The
//! interpreter now counts nested evaluations itself and refuses past
//! `set_max_eval_depth` with a soft error that `try` catches after the
//! recursion unwinds. (The stack growth that lets the default ceiling sit
//! far past 2,000 frames is the host's `StackGrower`; tento-lisp-cmd's
//! tests exercise it.)

use std::{cell::RefCell, rc::Rc};

use string_interner::{backend::StringBackend, symbol::SymbolU32};
use tento_lisp::{Env, EvalBudget, Interpreter, Runtime, RuntimeError, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};

type Interp = Interpreter<SymbolU32, StringBackend>;

fn run(interp: &mut Interp, source: &str) -> Result<Value<SymbolU32>, RuntimeError> {
  let env: Rc<RefCell<Env<SymbolU32>>> = Interp::default_env(interp);
  let asts = Runtime::<SymbolU32, StringBackend>::parse(None, source, interp.string_interner())
    .expect("parse");
  let mut last = Value::Nil;
  for ast in asts {
    last = interp.eval_expression(
      env.clone(),
      &Value::from_sexpression(&ast).expect("from_sexpression"),
    )?;
  }
  Ok(last)
}

/// Run `f` on a thread with a stack large enough for the ceilings these tests
/// set: no grower is installed here, and unoptimised frames are large.
fn on_big_stack(f: impl FnOnce() + Send + 'static) {
  std::thread::Builder::new()
    .stack_size(256 << 20)
    .spawn(f)
    .expect("spawn")
    .join()
    .expect("test body");
}

const COUNT_DOWN: &str = "(let depth (lambda (n) (if (= n 0) 0 (+ 1 (depth (- n 1))))))\n";

#[test]
fn recursion_within_the_ceiling_runs() {
  on_big_stack(|| {
    let mut interp = Interp::new();
    interp.set_max_eval_depth(10_000);
    let v = run(&mut interp, &format!("{COUNT_DOWN}(depth 200)")).expect("200 frames fit");
    assert!(matches!(v, Value::Integer(200)), "got {v:?}");
  });
}

#[test]
fn crossing_the_ceiling_is_a_soft_error() {
  on_big_stack(|| {
    let mut interp = Interp::new();
    interp.set_max_eval_depth(500);
    let e = run(&mut interp, &format!("{COUNT_DOWN}(depth 10000)")).expect_err("past the ceiling");
    assert!(
      !e.is_hard(),
      "the interpreter's own ceiling is catchable: {e:?}"
    );
    assert!(
      e.to_string().contains("eval recursion too deep"),
      "got: {e}"
    );
  });
}

#[test]
fn try_catches_the_ceiling_and_evaluation_continues() {
  on_big_stack(|| {
    let mut interp = Interp::new();
    interp.set_max_eval_depth(500);
    let v = run(
      &mut interp,
      &format!("{COUNT_DOWN}(let r (try (depth 10000)))\n(if r \"uncaught\" (depth 50))"),
    )
    .expect("try catches, then the unwound stack runs ordinary work");
    assert!(matches!(v, Value::Integer(50)), "got {v:?}");
    assert_eq!(interp.eval_depth(), 0, "the caught ceiling gave back every frame it counted");
  });
}

#[test]
fn infinite_recursion_inside_try_is_caught() {
  on_big_stack(|| {
    let mut interp = Interp::new();
    interp.set_max_eval_depth(2_000);
    let v = run(
      &mut interp,
      "(let boom (lambda () (boom)))\n(if (try (boom)) \"uncaught\" \"caught\")",
    )
    .expect("caught");
    assert!(matches!(&v, Value::String(s) if s == "caught"), "got {v:?}");
  });
}

#[test]
fn a_host_budget_depth_cap_stays_hard() {
  on_big_stack(|| {
    let mut interp = Interp::new();
    interp.replace_eval_budget(Some(EvalBudget {
      max_steps: 1_000_000,
      deadline: None,
      max_depth: 200,
    }));
    let e =
      run(&mut interp, &format!("{COUNT_DOWN}(try (depth 10000))")).expect_err("budget halts");
    assert!(e.is_hard(), "a host's rail still halts through try: {e:?}");
  });
}

/// A host that catches a panic and keeps the interpreter, as the interactive
/// REPL does, finds the counters where they were: no headroom lost under the
/// ceiling, and an unbound top-level head still reported unbound rather than
/// handed to the call-head hook, which answers nested calls only.
#[test]
fn a_panic_unwinding_out_of_an_evaluation_restores_the_counters() {
  let mut interp = Interp::new();
  interp.set_missing_symbol_hook(Rc::new(|name: &str| {
    if name == "boom" {
      panic!("a host hook panicked");
    }
    None
  }));
  let unwound = catch_unwind(AssertUnwindSafe(|| run(&mut interp, "(+ 1 (+ 1 (list boom)))")));
  assert!(unwound.is_err(), "the hook's panic unwinds out of the evaluation");
  assert_eq!(interp.eval_depth(), 0, "the abandoned frames were given back");

  interp.set_call_head_hook(Rc::new(|_: &str, _: &mut _| Some(Ok(Value::Integer(7)))));
  let e = run(&mut interp, "(nope 1)").expect_err("a top-level unbound head");
  assert!(matches!(e, RuntimeError::UndefinedSymbol { .. }), "got {e:?}");
  let v = run(&mut interp, "(+ 1 (nope 1))").expect("the hook answers a nested call");
  assert!(matches!(v, Value::Integer(8)), "got {v:?}");
}

#[test]
fn budget_counter_is_observational_and_resets_with_the_budget() {
  let mut interp = Interp::new();
  assert_eq!(interp.eval_budget_steps(), None);
  interp.replace_eval_budget(Some(EvalBudget { max_steps: 3, max_depth: 32, deadline: None }));
  assert_eq!(interp.eval_budget_steps(), Some(0));
  assert!(matches!(run(&mut interp, "42"), Ok(Value::Integer(42))));
  assert_eq!(interp.eval_budget_steps(), Some(1));
  assert_eq!(interp.eval_budget_steps(), Some(1));
  assert!(run(&mut interp, "42 42").is_ok());
  assert_eq!(interp.eval_budget_steps(), Some(3));
  assert!(run(&mut interp, "42").unwrap_err().is_hard());
  assert_eq!(interp.eval_budget_steps(), Some(4));
  let old = interp.replace_eval_budget(None).unwrap();
  assert_eq!(old.max_steps, 3);
  assert_eq!(interp.eval_budget_steps(), None);
  interp.replace_eval_budget(Some(old));
  assert_eq!(interp.eval_budget_steps(), Some(0));
  assert!(run(&mut interp, "42").is_ok());
}
