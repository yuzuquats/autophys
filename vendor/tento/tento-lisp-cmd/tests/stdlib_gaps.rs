//! The standard-library gaps the KoL library port hit, checked through the
//! host tsh scripts run in (`LispHost`), which registers its own natives over
//! the tento-lisp stdlib. A builtin fixed in tento-lisp but shadowed here
//! would still be broken for tsh users; these tests see what they see.

use serde_json::{Value, json};
use tento_lisp_cmd::script::LispHost;

fn eval(source: &str) -> Value {
  LispHost::new()
    .eval_to_json(source)
    .unwrap_or_else(|error| panic!("{source}: {error:?}"))
}

#[test]
fn not_reads_nil_and_values_by_truthiness() {
  assert_eq!(eval("(not nil)"), json!(true));
  assert_eq!(eval("(not false)"), json!(true));
  assert_eq!(eval("(not true)"), json!(false));
  assert_eq!(eval("(not 0)"), json!(false));
  assert_eq!(eval(r#"(not (get (hash-map) "absent"))"#), json!(true));
}

#[test]
fn get_on_a_list_returns_nil_for_a_missing_index_or_a_non_index_key() {
  assert_eq!(eval("(get (list 10 20) 1)"), json!(20));
  assert_eq!(eval("(get (list 10 20) 2)"), json!(null));
  assert_eq!(eval("(get (list 10 20) -1)"), json!(null));
  assert_eq!(eval(r#"(get (list 10 20) "name")"#), json!(null));
  assert_eq!(
    eval(r#"(get (list 10 20) "name" "fallback")"#),
    json!("fallback")
  );
  assert_eq!(eval(r#"(get (hash-map "a" 1) "a")"#), json!(1));
}

#[test]
fn text_and_regex_builtins_reach_scripts() {
  assert_eq!(
    eval(r#"(str.split "a,b,,c" ",")"#),
    json!(["a", "b", "", "c"])
  );
  assert_eq!(
    eval(r#"(str.join (str.split "a.b.c" ".") "/")"#),
    json!("a/b/c")
  );
  assert_eq!(eval(r#"(str.replace "x-y-z" "-" "+")"#), json!("x+y+z"));
  assert_eq!(eval(r#"(str.chars "aé😀")"#), json!(["a", "é", "😀"]));
  assert_eq!(
    eval(r#"(str.re-captures "monster: Knob Goblin (12)" "^(\\w+): (.+) \\((\\d+)\\)$")"#),
    json!(["monster: Knob Goblin (12)", "monster", "Knob Goblin", "12"])
  );
  assert_eq!(
    eval(r##"(str.re-replace "a1b22" "\\d+" "#")"##),
    json!("a#b#")
  );
}

#[test]
fn rounding_predicates_and_large_ranges_reach_scripts() {
  assert_eq!(
    eval("(list (floor -2.5) (ceil 2.1) (round 2.5) (trunc -2.7) (floor 7))"),
    json!([-3, 3, 3, -2, 7])
  );
  assert_eq!(
    eval(
      r#"(list (string? "s") (number? 1.5) (int? 1.5) (list? (list)) (map? (hash-map)) (fn? not) (nil? nil))"#
    ),
    json!([true, true, false, true, true, true, true])
  );
  assert_eq!(eval("(length (range 100000))"), json!(100000));
}
