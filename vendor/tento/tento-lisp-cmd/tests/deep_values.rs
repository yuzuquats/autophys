//! A Lisp value nested past any native stack crosses into JSON safely.
//!
//! `(reduce (lambda (acc x) (list acc)) () (range 1000000))` builds a list a
//! million levels deep. Converting it to JSON used to recurse once per level
//! and abort the process. The conversion now walks on a heap stack, and it
//! stops at `tento_lisp::MAX_NESTING_DEPTH` levels with an `error/v1` record
//! of kind `"depth"`, because the `serde_json::Value` it hands back drops and
//! serializes recursively.

use serde_json::{Value, json};
use tento_lisp::{List, MAX_NESTING_DEPTH};
use tento_lisp_cmd::script::{LispHost, LispValue, value_to_json};

fn on_stack(size: usize, f: impl FnOnce() + Send + 'static) {
  std::thread::Builder::new()
    .stack_size(size)
    .spawn(f)
    .expect("spawn")
    .join()
    .expect("the conversion completed without overflowing its stack");
}

/// Follow single-element arrays down; return how many there were and what
/// sits at the bottom.
fn unwrap_arrays(mut json: &Value) -> (usize, &Value) {
  let mut depth = 0;
  while let Value::Array(items) = json {
    match items.as_slice() {
      [only] => json = only,
      _ => break,
    }
    depth += 1;
  }
  (depth, json)
}

fn assert_cut_at_the_limit(json: &Value) {
  let (depth, bottom) = unwrap_arrays(json);
  assert_eq!(depth, MAX_NESTING_DEPTH);
  assert_eq!(bottom["type"], "error/v1", "{bottom}");
  assert_eq!(bottom["kind"], "depth", "{bottom}");
}

#[test]
fn a_million_deep_value_converts_in_constant_stack() {
  // 256 KiB: far too small for a per-level walk of a million levels, ample
  // for the iterative one and for the cut-off JSON it returns.
  on_stack(256 * 1024, || {
    let mut value = LispValue::Integer(1);
    for _ in 0..1_000_000 {
      value = LispValue::List(List { items: vec![value].into() });
    }
    let json = value_to_json(&value);
    drop(value);
    assert_cut_at_the_limit(&json);
  });
}

#[test]
fn the_cut_json_serializes_and_drops_on_a_spawned_thread() {
  on_stack(2 << 20, || {
    let mut value = LispValue::Nil;
    for _ in 0..1_000_000 {
      value = LispValue::List(List { items: vec![value].into() });
    }
    let json = value_to_json(&value);
    let text = json.to_string();
    assert!(text.starts_with("[[[[") && text.ends_with("]]]]"));
    drop(json);
  });
}

#[test]
fn the_reported_reduce_repro_returns_json() {
  let json = LispHost::new()
    .eval_to_json("(reduce (lambda (acc x) (list acc)) () (range 1000000))")
    .expect("eval");
  assert_cut_at_the_limit(&json);
}

#[test]
fn values_within_the_limit_convert_whole() {
  let mut value = LispValue::Integer(7);
  for _ in 0..MAX_NESTING_DEPTH {
    value = LispValue::List(List { items: vec![value].into() });
  }
  let json = value_to_json(&value);
  let (depth, bottom) = unwrap_arrays(&json);
  assert_eq!((depth, bottom), (MAX_NESTING_DEPTH, &json!(7)));

  let json = LispHost::new()
    .eval_to_json(r#"(list 1 2.5 "s" nil true (list) (hash-map) (hash-map "k" (list 1 (hash-map "j" false))))"#)
    .expect("eval");
  assert_eq!(json, json!([1, 2.5, "s", null, true, [], {}, {"k": [1, {"j": false}]}]));
}
