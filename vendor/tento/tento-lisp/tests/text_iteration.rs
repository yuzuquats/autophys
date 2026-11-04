//! Character-by-character reading must be linear in the string's length.
//!
//! The KoL library port measured about one second per 12 KB for the idiom
//! `(map (lambda (i) (str.slice text i (+ i 1))) (range (length text)))`:
//! `str.slice` decoded the whole string into a `Vec<char>` on every call, so
//! reading a file one character at a time was quadratic. These tests time a
//! 48 KB walk (four times the reported size) against a bound a quadratic
//! implementation misses by more than an order of magnitude, while a linear
//! one clears it with a wide margin even in an unoptimised test build.
//! What remains is per-call interpreter cost, including the copy of the
//! string a variable lookup makes.

use std::time::{Duration, Instant};

use string_interner::symbol::SymbolU32;
use tento_lisp::{Runtime, Value};

const BYTES: usize = 48 * 1024;
/// The quadratic implementation took 48 s for the ASCII case in a debug
/// build (2.9 s optimised); the linear one takes under 2 s debug.
const BOUND: Duration = Duration::from_secs(10);

fn timed(source: &str) -> (Vec<Value<SymbolU32>>, Duration) {
  let started = Instant::now();
  let values = Runtime::<SymbolU32>::eval(None, source).unwrap();
  (values, started.elapsed())
}

/// The text is built in-language: a 48 KB string literal would measure the
/// reader, not the string primitives.
fn text(unit: &str) -> (String, usize) {
  let reps = BYTES / unit.len();
  (
    format!("(str.repeat \"{unit}\" {reps})"),
    unit.chars().count() * reps,
  )
}

fn assert_count(values: &[Value<SymbolU32>], expected: usize, label: &str, elapsed: Duration) {
  eprintln!("{label}: {expected} chars in {elapsed:?}");
  assert!(
    matches!(values.last(), Some(Value::Integer(n)) if *n as usize == expected),
    "{label}: {:?}",
    values.last()
  );
  assert!(
    elapsed < BOUND,
    "{label}: {expected} chars took {elapsed:?}"
  );
}

#[test]
fn slicing_one_character_at_a_time_is_linear() {
  for (label, unit) in [("ascii slice", "abcdefgh"), ("unicode slice", "aé😀b")] {
    let (text, chars) = text(unit);
    let source = format!(
      "(define text {text})
       (length (filter (lambda (c) (= c \"b\"))
         (map (lambda (i) (str.slice text i (+ i 1))) (range (length text)))))
       (length (map (lambda (i) (str.slice text i (+ i 1))) (range (length text))))"
    );
    let (values, elapsed) = timed(&source);
    assert_count(&values, chars, label, elapsed);
  }
}

#[test]
fn str_chars_walks_a_string_in_one_pass() {
  for (label, unit) in [("ascii chars", "abcdefgh"), ("unicode chars", "aé😀b")] {
    let (text, chars) = text(unit);
    let source = format!(
      "(define text {text})
       (length (filter (lambda (c) (= c \"b\")) (str.chars text)))
       (length (str.chars text))"
    );
    let (values, elapsed) = timed(&source);
    assert_count(&values, chars, label, elapsed);
  }
}
