//! Data nested far deeper than the native stack is handled without recursion.
//!
//! The evaluator grows its stack on demand, so Lisp code builds data as deep
//! as memory allows: `(reduce (lambda (acc x) (list acc)) () (range N))`
//! wraps its accumulator N times. Everything that walks a value afterwards
//! (drop, the REPL printer, `json-stringify`, `=`) used to recurse once per
//! level and abort the process, which no `(try …)` can catch. Each walk now
//! keeps its open containers on the heap; these tests run them on a 256 KiB
//! thread, where any per-level recursion over a million levels would
//! overflow. The reader is the one walk that stays recursive; it refuses
//! input nested past [`tento_lisp::MAX_NESTING_DEPTH`] with a syntax error.

use std::{cell::RefCell, rc::Rc};

use string_interner::{StringInterner, backend::StringBackend, symbol::SymbolU32};
use tento_lisp::{
  Env, Interpreter, List, MAX_NESTING_DEPTH, Runtime, SyntaxError, Value, cmp, format_value,
};

type Interp = Interpreter<SymbolU32, StringBackend>;
type V = Value<SymbolU32>;

const DEPTH: usize = 1_000_000;

/// A stack far smaller than any per-level walk of [`DEPTH`] levels needs.
const SMALL_STACK: usize = 256 * 1024;

fn on_stack(size: usize, f: impl FnOnce() + Send + 'static) {
  std::thread::Builder::new()
    .stack_size(size)
    .spawn(f)
    .expect("spawn")
    .join()
    .expect("the walk completed without overflowing its stack");
}

fn on_small_stack(f: impl FnOnce() + Send + 'static) {
  on_stack(SMALL_STACK, f)
}

/// `leaf` wrapped in `depth` one-element lists.
fn nest_lists(depth: usize, leaf: V) -> V {
  let mut value = leaf;
  for _ in 0..depth {
    value = Value::List(List { items: vec![value].into() });
  }
  value
}

/// `leaf` wrapped in `depth` one-entry maps under the key `"k"`.
fn nest_maps(depth: usize, leaf: V) -> V {
  let mut value = leaf;
  for _ in 0..depth {
    let mut map = indexmap::IndexMap::new();
    map.insert("k".to_string(), value);
    value = Value::Map(map.into());
  }
  value
}

fn run(interp: &mut Interp, source: &str) -> V {
  let env: Rc<RefCell<Env<SymbolU32>>> = Interp::default_env(interp);
  let asts = Runtime::<SymbolU32, StringBackend>::parse(None, source, interp.string_interner())
    .expect("parse");
  let mut last = Value::Nil;
  for ast in asts {
    last = interp
      .eval_expression(env.clone(), &Value::from_sexpression(&ast).expect("from_sexpression"))
      .expect("eval");
  }
  last
}

fn equal(a: V, b: V) -> bool {
  matches!(cmp::eq(vec![a, b]), Ok(Value::Boolean(true)))
}

#[test]
fn a_million_deep_list_drops_in_constant_stack() {
  on_small_stack(|| drop(nest_lists(DEPTH, Value::Integer(1))));
}

#[test]
fn a_million_deep_map_drops_in_constant_stack() {
  on_small_stack(|| drop(nest_maps(DEPTH, Value::Integer(1))));
}

#[test]
fn dropping_a_deep_value_leaves_a_shared_inner_part_whole() {
  on_small_stack(|| {
    let inner = nest_lists(DEPTH / 2, Value::Integer(7));
    let outer = nest_lists(DEPTH / 2, inner.clone());
    drop(outer);
    // The kept half still holds every level and its leaf.
    let mut cursor = &inner;
    let mut levels = 0;
    while let Value::List(list) = cursor {
      cursor = &list.items[0];
      levels += 1;
    }
    assert_eq!(levels, DEPTH / 2);
    assert!(matches!(cursor, Value::Integer(7)));
    drop(inner);
  });
}

#[test]
fn a_million_deep_value_prints_in_constant_stack() {
  on_small_stack(|| {
    let interner = StringInterner::<StringBackend>::new();
    assert_eq!(format_value(&interner, &nest_lists(2, Value::Nil)), "((nil))");
    let text = format_value(&interner, &nest_lists(DEPTH, Value::Nil));
    assert_eq!(text.len(), 2 * DEPTH + 3);
    assert!(text.starts_with("((((") && text.ends_with("))))"));
    assert_eq!(&text[DEPTH..DEPTH + 3], "nil");
    let text = format_value(&interner, &nest_maps(3, Value::Integer(1)));
    assert_eq!(text, "{k {k {k 1}}}");
  });
}

/// The iterative printer writes exactly what `Interpreter::format_value`
/// writes for ordinary values.
#[test]
fn the_printer_matches_the_interpreter_on_ordinary_values() {
  let mut interp = Interp::new();
  for source in [
    "(list 1 2.5 \"text\" true false nil 'sym (list) (list (list 1) (list 2 3)))",
    "(hash-map \"a\" 1 \"b\" (list 1 (hash-map \"c\" nil)) \"d\" (hash-map))",
    "(list (hash-map) (list) (list (list)) \"\" 'a)",
    "(list (try (error \"boom\")) +)",
  ] {
    let value = run(&mut interp, source);
    assert_eq!(format_value(interp.string_interner(), &value), interp.format_value(&value), "{source}");
  }
}

#[test]
fn a_million_deep_value_compares_in_constant_stack() {
  on_small_stack(|| {
    assert!(equal(nest_lists(DEPTH, Value::Integer(1)), nest_lists(DEPTH, Value::Integer(1))));
    assert!(!equal(nest_lists(DEPTH, Value::Integer(1)), nest_lists(DEPTH, Value::Integer(2))));
    assert!(!equal(nest_lists(DEPTH, Value::Nil), nest_lists(DEPTH - 1, Value::Nil)));
    assert!(equal(nest_maps(DEPTH, Value::Integer(1)), nest_maps(DEPTH, Value::Integer(1))));
    assert!(!equal(nest_maps(DEPTH, Value::Integer(1)), nest_maps(DEPTH, Value::Float(1.5))));
  });
}

#[test]
fn equality_keeps_its_meaning_on_ordinary_values() {
  let mut interp = Interp::new();
  for (source, expected) in [
    ("(= (list 1 (list 2 3)) (list 1 (list 2 3)))", true),
    ("(= (list 1 (list 2 3)) (list 1 (list 2 4)))", false),
    ("(= (list 1 2) (list 1 2 3))", false),
    ("(= (list 1) (list 1.0))", true),
    ("(= (hash-map \"a\" 1 \"b\" 2) (hash-map \"b\" 2 \"a\" 1))", true),
    ("(= (hash-map \"a\" 1) (hash-map \"b\" 1))", false),
    ("(= (hash-map \"a\" (list 1)) (hash-map \"a\" (list 2)))", false),
    ("(= (list) (hash-map))", false),
  ] {
    assert!(matches!(run(&mut interp, source), Value::Boolean(b) if b == expected), "{source}");
  }
}

#[test]
fn debug_output_of_a_deep_value_is_cut_short() {
  on_small_stack(|| {
    let text = format!("{:?}", nest_lists(DEPTH, Value::Nil));
    assert!(text.contains('…'));
    assert!(text.len() < 64 * 1024, "{} bytes", text.len());
    let shallow = format!("{:?}", nest_lists(2, Value::Integer(1)));
    assert_eq!(shallow, "List(List { items: [List(List { items: [Integer(1)] })] })");
  });
}

/// The reported repro, end to end: Lisp builds the nest, then it is
/// stringified, printed, compared and dropped.
#[test]
fn a_nest_built_by_reduce_survives_every_walk() {
  on_small_stack(|| {
    let mut interp = Interp::new();
    let out = run(
      &mut interp,
      "(define deep (reduce (lambda (acc x) (list acc)) () (range 1000000)))
       (list (json-stringify deep) (= deep deep) deep)",
    );
    let Value::List(out) = out else { panic!("expected a list") };
    let [Value::String(json), Value::Boolean(true), deep] = out.items.as_slice() else {
      panic!("unexpected results")
    };
    assert!(json.starts_with("[[[[") && json.ends_with("]]]]"), "{}", &json[..16]);
    let printed = format_value(interp.string_interner(), deep);
    assert!(printed.starts_with("((((") && printed.ends_with("))))"));
    assert_eq!(printed.len(), json.len());
    drop(out);
  });
}

#[test]
fn json_stringify_is_unchanged_for_ordinary_values() {
  let mut interp = Interp::new();
  let value = run(
    &mut interp,
    "(json-stringify (list 1 2.5 \"a\\\"b\" nil true (list) (hash-map) (hash-map \"k\" (list 1 (hash-map \"j\" false)))))",
  );
  let Value::String(text) = value else { panic!("expected JSON text") };
  assert_eq!(text, r#"[1,2.5,"a\"b",null,true,[],{},{"k":[1,{"j":false}]}]"#);
}

fn parse(source: &str) -> Result<usize, SyntaxError> {
  let mut interner = StringInterner::<StringBackend>::new();
  Runtime::<SymbolU32, StringBackend>::parse(None, source, &mut interner).map(|forms| forms.len())
}

#[test]
fn input_nested_past_the_limit_is_a_syntax_error() {
  on_small_stack(|| {
    for source in [
      format!("{}{}", "(".repeat(200_000), ")".repeat(200_000)),
      format!("{}{}", "[".repeat(200_000), "]".repeat(200_000)),
      format!("{}x", "'".repeat(200_000)),
      format!("{}x{}", "'(".repeat(100_000), ")".repeat(100_000)),
      "(".repeat(200_000),
    ] {
      match parse(&source) {
        Err(SyntaxError::TooDeep { message, loc }) => {
          assert!(message.contains(&MAX_NESTING_DEPTH.to_string()), "{message}");
          assert_eq!(loc.linecol.0, 1);
        }
        other => panic!("expected TooDeep, got {other:?}"),
      }
    }
  });
}

/// Quotes count only until their expression ends, and closed lists free
/// their level: wide or long input is never mistaken for deep input.
#[test]
fn long_and_wide_input_is_not_deep() {
  on_small_stack(|| {
    let wide = format!("(list {})", "'a ".repeat(100_000));
    assert_eq!(parse(&wide).unwrap(), 1);
    let long = "(a (b)) 'c ".repeat(50_000);
    assert_eq!(parse(&long).unwrap(), 100_000);
  });
}

/// The deepest input the reader admits parses, converts and drops on the
/// 2 MiB stack of a spawned thread, in an unoptimised build.
#[test]
fn input_at_the_limit_parses_on_a_spawned_thread_stack() {
  on_stack(2 << 20, || {
    let depth = MAX_NESTING_DEPTH;
    let source = format!("{}1{}", "(".repeat(depth), ")".repeat(depth));
    let mut interner = StringInterner::<StringBackend>::new();
    let forms = Runtime::<SymbolU32, StringBackend>::parse(None, &source, &mut interner).expect("parse");
    let value = Value::from_sexpression(&forms[0]).expect("convert");
    drop(forms);
    let text = format_value(&interner, &value);
    assert_eq!(text.len(), 2 * depth + 1);
    let past = format!("{}1{}", "(".repeat(depth + 1), ")".repeat(depth + 1));
    assert!(matches!(parse(&past), Err(SyntaxError::TooDeep { .. })));
  });
}
