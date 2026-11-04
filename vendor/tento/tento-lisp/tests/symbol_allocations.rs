//! Count allocations only on the evaluating thread, after parsing and setup.
//! Other tests and the test harness must not contribute to the measurement.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use string_interner::{backend::StringBackend, symbol::SymbolU32};
use tento_lisp::{Interpreter, Runtime, Value};

thread_local! {
  static COUNT: Cell<Option<usize>> = const { Cell::new(None) };
}

struct CountingAllocator;

fn count_allocation() {
  let _ = COUNT.try_with(|count| {
    if let Some(n) = count.get() {
      count.set(Some(n + 1));
    }
  });
}

// SAFETY: every allocation and deallocation forwards the unchanged arguments
// to System. The thread-local counter neither allocates nor touches the memory.
unsafe impl GlobalAlloc for CountingAllocator {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    count_allocation();
    unsafe { System.alloc(layout) }
  }

  unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
    unsafe { System.dealloc(ptr, layout) }
  }

  unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
    count_allocation();
    unsafe { System.realloc(ptr, layout, size) }
  }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn allocations<T>(f: impl FnOnce() -> T) -> (T, usize) {
  struct Reset;
  impl Drop for Reset {
    fn drop(&mut self) {
      COUNT.set(None);
    }
  }
  COUNT.set(Some(0));
  let reset = Reset;
  let result = f();
  let count = COUNT.get().unwrap();
  drop(reset);
  (result, count)
}

#[test]
fn bound_scalar_symbols_and_special_form_dispatch_do_not_allocate() {
  let mut interpreter = Interpreter::<SymbolU32, StringBackend>::new();
  let env = interpreter.default_env();
  let symbol = interpreter.string_interner().get_or_intern("answer");
  env.borrow_mut().define(symbol, Value::Integer(42));
  let mut counts = Vec::new();
  for source in [
    "answer",
    "(quote 42)",
    "(if true answer never-evaluated)",
    "nil",
  ] {
    let ast = Runtime::parse(None, source, interpreter.string_interner()).unwrap();
    let value = Value::from_sexpression(&ast[0]).unwrap();
    let (result, count) = allocations(|| interpreter.eval_expression(env.clone(), &value));
    let result = result.unwrap();
    if source == "nil" {
      assert!(matches!(result, Value::Nil));
    } else {
      assert!(matches!(result, Value::Integer(42)));
    }
    counts.push((source, count));
  }
  assert!(
    counts.iter().all(|(_, count)| *count == 0),
    "interned-name copies: {counts:?}"
  );
}


/// An owned string literal moves into the shared storage a `Value::String`
/// holds (`Text`, an `Rc<String>`), which is one allocation for the count;
/// every later clone of the value is a reference count. A tagged string
/// still moves its two strings and allocates nothing.
#[test]
fn owned_reader_literals_move_into_shared_text_with_one_allocation() {
  use tento_lisp::{Literal, SExpression};
  let literals = [
    (Literal::String("a nonempty command argument".into()), 1),
    (
      Literal::TaggedString {
        tag: "json".into(),
        payload: "{\"x\":[1,2,3]}".into(),
      },
      0,
    ),
  ];
  for (literal, copies) in literals {
    let ast = SExpression::<SymbolU32>::Literal(literal);
    let expected = Value::from_sexpression(&ast).unwrap();
    let (actual, count) = allocations(|| Value::from_owned_sexpression(ast));
    assert_eq!(format!("{:?}", actual.unwrap()), format!("{expected:?}"));
    assert_eq!(
      count, copies,
      "an owned string literal moves into shared text (one allocation, the count); a tagged string allocates nothing"
    );
  }
}

#[test]
fn owned_reader_conversion_matches_borrowed_conversion() {
  use tento_lisp::{Literal, SExpression};
  let mut interpreter = Interpreter::<SymbolU32, StringBackend>::new();
  let symbol = interpreter.string_interner().get_or_intern("fixture");
  let literals = [
    Literal::Boolean(true),
    Literal::Boolean(false),
    Literal::Integer(-42),
    Literal::Float(1.25),
    Literal::String("é\n\0text".into()),
    Literal::Symbol(symbol),
    Literal::TaggedString {
      tag: "json".into(),
      payload: "{}".into(),
    },
  ];
  let mut trees: Vec<_> = literals.into_iter().map(SExpression::Literal).collect();
  trees.push(SExpression::List(vec![]));
  trees.push(SExpression::List(trees.clone()));
  trees.push(SExpression::List(vec![SExpression::List(trees.clone())]));
  for tree in trees {
    let expected = Value::from_sexpression(&tree).unwrap();
    let actual = Value::from_owned_sexpression(tree).unwrap();
    assert_eq!(format!("{actual:?}"), format!("{expected:?}"));
  }
}
