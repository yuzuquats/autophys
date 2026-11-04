//! Lists and maps share their elements ([`tento_lisp::Shared`]): a copy is a
//! reference count until one side changes it. Scope cleanup asks whether a
//! closure a scope made escaped it; a list or map that holds one may be the
//! copy that escaped, so it must keep the closure's bindings alive.

use std::{cell::RefCell, rc::Rc};

use string_interner::{backend::StringBackend, symbol::SymbolU32};
use tento_lisp::{Env, Interpreter, Runtime, RuntimeError, Value};

type Interp = Interpreter<SymbolU32, StringBackend>;

fn run(source: &str) -> Result<Value<SymbolU32>, RuntimeError> {
  let mut interp = Interp::new();
  let env: Rc<RefCell<Env<SymbolU32>>> = Interp::default_env(&mut interp);
  let asts = Runtime::<SymbolU32, StringBackend>::parse(None, source, interp.string_interner()).expect("parse");
  let mut last = Value::Nil;
  for ast in asts {
    last = interp.eval_expression(env.clone(), &Value::from_sexpression(&ast).expect("from_sexpression"))?;
  }
  Ok(last)
}

#[test]
fn a_closure_that_escapes_in_a_list_or_map_keeps_its_bindings() {
  for (form, call) in [
    ("(define escaped (let ((secret 42) (box (list (lambda () secret)))) box))", "((first escaped))"),
    ("(define escaped (let ((secret 42) (box (hash-map \"f\" (lambda () secret)))) box))", "((get escaped \"f\"))"),
    ("(define escaped (let ((secret 42) (box (list (list (lambda () secret))))) box))", "((first (first escaped)))"),
  ] {
    let out = run(&format!("{form}\n{call}"));
    assert!(matches!(out, Ok(Value::Integer(42))), "{form}: {out:?}");
  }
}

#[test]
fn a_change_to_a_copy_is_not_seen_by_the_original() {
  let out = run("(define a (list 1 2)) (define b a) (set b (append b (list 3))) (list (length a) (length b))");
  let Ok(Value::List(list)) = out else { panic!("{out:?}") };
  assert!(matches!(list.items.as_slice(), [Value::Integer(2), Value::Integer(3)]), "{list:?}");
}

/// Scope cleanup's walk is bounded however many times one list is shared
/// inside another: a tree 40 levels deep of a list holding itself twice is
/// 2^40 paths, which an unbounded walk would never finish.
#[test]
fn a_scope_holding_a_deeply_shared_tree_is_left_quickly() {
  let out = run("(let ((tree (list 1)) (helper (lambda () 0)))
                   (set tree (reduce (lambda (a n) (list a a)) tree (range 40)))
                   0)");
  assert!(matches!(out, Ok(Value::Integer(0))), "{out:?}");
}
