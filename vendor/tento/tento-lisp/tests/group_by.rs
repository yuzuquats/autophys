//! Group indexing must preserve equality, callback evaluation and stable order.
use string_interner::symbol::SymbolU32;
use tento_lisp::{Runtime, Value};

fn check(source: &str) {
    let values = Runtime::<SymbolU32>::eval(None, source).expect("eval");
    assert!(matches!(values.last(), Some(Value::Boolean(true))), "{values:?}");
}

#[test]
fn string_groups_keep_first_occurrence_and_member_order() {
    check(r#"
      (= (group-by first (list (list "β" 1) (list "" 2) (list "a" 3)
                              (list "β" 4) (list "" 5) (list "😀" 6)))
         (list (list "β" (list (list "β" 1) (list "β" 4)))
               (list "" (list (list "" 2) (list "" 5)))
               (list "a" (list (list "a" 3)))
               (list "😀" (list (list "😀" 6)))))
    "#);
}

#[test]
fn mixed_keys_keep_numeric_and_structural_equality() {
    check(r#"
      (= (map (lambda (pair) (list (first pair) (length (nth pair 1))))
           (group-by (lambda (x) x)
             (list "1" 1 nil (list 1) true 1.0 "1" (list 1.0)
               (hash-map "a" 1 "b" 2) (hash-map "b" 2 "a" 1.0) nil false)))
         (list (list "1" 2) (list 1 2) (list nil 2) (list (list 1) 2)
               (list true 1) (list (hash-map "a" 1 "b" 2) 2) (list false 1)))
    "#);
}

#[test]
fn callback_runs_once_per_item_in_input_order_and_can_mutate_input_binding() {
    check(r#"
      (let input (list "b" "a" "b"))
      (let seen (list))
      (let result (group-by (lambda (x)
        (set seen (append seen (list x)))
        (set input (list "replacement"))
        x) input))
      (and (= seen (list "b" "a" "b"))
           (= input (list "replacement"))
           (= result (list (list "b" (list "b" "b")) (list "a" (list "a")))))
    "#);
}

#[test]
fn callback_error_stops_before_later_items() {
    check(r#"
      (let seen (list))
      (let result (try (group-by (lambda (x)
        (set seen (append seen (list x)))
        (if (= x "bad") (/ 1 0) x)) (list "a" "bad" "later"))))
      (and (error? result) (= seen (list "a" "bad")))
    "#);
}

#[test]
fn empty_and_invalid_inputs_keep_their_contract() {
    check(r#"
      (and (= (group-by (lambda (x) x) nil) (list))
           (= (group-by (lambda (x) x) (list)) (list))
           (error? (try (group-by (lambda (x) x) 3)))
           (error? (try (group-by 3 (list)))))
    "#);
    assert!(Runtime::<SymbolU32>::eval(None, "(group-by (lambda (x) x))").is_err());
}

#[test]
fn many_interleaved_string_keys_preserve_every_group_and_item() {
    check(r#"
      (let rows (map (lambda (i) (list (str (mod i 257)) i)) (range 1028)))
      (let grouped (group-by first rows))
      (and (= (length grouped) 257)
           (= grouped (map (lambda (i)
             (list (str i) (list (list (str i) i) (list (str i) (+ i 257))
                                (list (str i) (+ i 514)) (list (str i) (+ i 771)))))
             (range 257))))
    "#);
}

#[test]
fn non_reflexive_keys_still_form_separate_groups() {
    check(r#"
      (let f (lambda (x) x))
      (let nan (** -1 0.5))
      (= (map (lambda (pair) (length (nth pair 1)))
           (group-by (lambda (x) x) (list "a" nan f "a" nan f)))
         (list 2 1 1 1 1))
    "#);
}
