//! Deep recursion through the host tsh scripts run in (`LispHost`).
//!
//! The host installs a stack grower, so recursion no longer overflows the
//! evaluating thread: these tests run on the test harness's ordinary 2 MB
//! thread, where 300 frames used to be the end of an unoptimised build and
//! about 2,000 the end of a release build on an 8 MB main thread.

use serde_json::{Value, json};
use tento_lisp_cmd::script::LispHost;

const COUNT_DOWN: &str = "(let depth (lambda (n) (if (= n 0) 0 (+ 1 (depth (- n 1))))))\n";

fn eval(source: &str) -> Value {
  LispHost::new()
    .eval_to_json(source)
    .unwrap_or_else(|error| panic!("{source}: {error:?}"))
}

#[test]
fn recursion_runs_far_past_the_thread_stack() {
  assert_eq!(eval(&format!("{COUNT_DOWN}(depth 20000)")), json!(20000));
}

#[test]
fn mutual_recursion_runs_deep() {
  let source = "(let even? (lambda (n) (if (= n 0) true (odd? (- n 1)))))\n\
                (let odd? (lambda (n) (if (= n 0) false (even? (- n 1)))))\n\
                (even? 30001)";
  assert_eq!(eval(source), json!(false));
}
