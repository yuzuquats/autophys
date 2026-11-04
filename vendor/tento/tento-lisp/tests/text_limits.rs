//! List-returning text builtins share `range`'s memory budget for one list.
//!
//! `str.chars` of an 8 MiB string made about 0.9 GiB of values, and
//! `str.split` of 64 MiB of commas about 6 GiB, which aborts the process
//! rather than failing as an error `try` can catch. Each builtin must refuse a
//! list past the element limit with a catchable error naming it.

use string_interner::symbol::SymbolU32;
use tento_lisp::{Runtime, Value};

/// `range`'s budget: 256 MiB of list.
fn limit() -> usize {
  256 * 1024 * 1024 / std::mem::size_of::<Value<SymbolU32>>()
}

/// An in-language expression for `count` commas (`str.repeat` stops at 8 MiB).
fn commas(count: usize) -> String {
  const CHUNK: usize = 8 * 1024 * 1024;
  let mut parts = vec![format!("(str.repeat \",\" {CHUNK})"); count / CHUNK];
  parts.push(format!("(str.repeat \",\" {})", count % CHUNK));
  format!("(str.join (list {}))", parts.join(" "))
}

fn error_message(source: &str) -> String {
  let values = Runtime::<SymbolU32>::eval(None, &format!("(error.message (try {source}))"))
    .unwrap_or_else(|e| panic!("{source}: {e:?}"));
  match values.last() {
    Some(Value::String(message)) => message.to_string(),
    other => panic!("no error: {other:?}"),
  }
}

fn assert_refused(name: &str, source: &str) {
  let message = error_message(source);
  assert!(
    message.contains(name) && message.contains("element limit"),
    "{name}: {message}"
  );
}

/// One test, run in sequence: each case builds up to the 256 MiB budget
/// before it fails, and running them side by side would multiply that.
#[test]
fn list_builtins_fail_catchably_past_the_element_limit() {
  let over = commas(limit() + 1);
  assert_refused("str.chars", &format!("(str.chars {over})"));
  assert_refused("str.split", &format!("(str.split {over} \",\")"));
  assert_refused(
    "str.split",
    &format!("(str.split {over} \",\" {})", limit() + 5),
  );
  assert_refused(
    "str.re-find-all",
    &format!("(str.re-find-all {over} \",\")"),
  );
  assert_refused("str.re-split", &format!("(str.re-split {over} \",\")"));
  // Each match is a list of three values (the list, the match, one group).
  let third = commas(limit() / 3 + 1);
  assert_refused(
    "str.re-captures-all",
    &format!("(str.re-captures-all {third} \"(,)\")"),
  );
  // Within the limit nothing changes.
  let values = Runtime::<SymbolU32>::eval(
    None,
    &format!(
      "(length (str.split {} \",\")) (length (str.chars {}))",
      commas(100_000),
      commas(100_000)
    ),
  )
  .unwrap();
  assert!(
    matches!(
      values[..],
      [Value::Integer(100_001), Value::Integer(100_000)]
    ),
    "{values:?}"
  );
}
