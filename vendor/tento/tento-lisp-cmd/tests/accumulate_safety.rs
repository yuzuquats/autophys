//! A still-readable binding survives accumulator release in the real tsh host.
use serde_json::{Value, json};
use tento_lisp_cmd::script::LispHost;

fn check(source: &str, expected: Value) {
  let mut host = LispHost::new();
  assert_eq!(host.eval_to_json(source).unwrap(), expected, "{source}");
}

#[test]
fn an_inner_shadow_does_not_hide_a_later_dynamic_reader() {
  check(
    r#"(let f std.sh.var)
       ((lambda (a) (list (let ((f len)) (conj a 4)) (f "a"))) [1 2 3])"#,
    json!([[1, 2, 3, 4], [1, 2, 3]]),
  );
}

#[test]
fn a_captured_writer_cannot_hide_a_later_dynamic_reader() {
  check(
    r#"(let f len)
       (define (g x) (set f std.sh.var) x)
       ((lambda (a) (list (g a) (f "a"))) [1 2 3])"#,
    json!([[1, 2, 3], [1, 2, 3]]),
  );
}

#[test]
fn a_writer_in_an_enclosing_call_cannot_hide_a_later_reader() {
  check(
    r#"(let f len)
       (define (g x) (set f std.sh.var) x)
       ((lambda (a) (list (g (conj a 4)) (f "a"))) [1 2 3])"#,
    json!([[1, 2, 3, 4], [1, 2, 3]]),
  );
}

#[test]
fn nested_later_calls_cannot_retarget_a_checked_reader() {
  check(
    r#"(let f len)
       (define (g x) (set f std.sh.var) x)
       ((lambda (a) (list (conj a 4) (list (g 0) (f "a")))) [1 2 3])"#,
    json!([[1, 2, 3, 4], [0, [1, 2, 3]]]),
  );
}

#[test]
fn a_direct_dynamic_read_keeps_its_binding() {
  check(
    r#"((lambda (a) (list (conj a 4) (std.sh.var "a"))) [1 2 3])"#,
    json!([[1, 2, 3, 4], [1, 2, 3]]),
  );
}
