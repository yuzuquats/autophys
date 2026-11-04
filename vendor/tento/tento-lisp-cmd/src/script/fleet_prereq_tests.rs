use super::*;
use crate::schema::Schema;
use tento_lisp::types::{ParamKind, Parameter, Signature, TypeExpr};

#[test]
fn optional_fields_and_returned_errors_keep_their_contracts() {
  let mut host = LispHost::new();
  assert_eq!(
    host
      .eval_to_json(
        r#"
    (struct Reply value: string detail: (option string))
    (fn reply () -> Reply {"value" "ok"})
    (fn result (fail bool) -> (either (list Reply) error)
      (if fail (try missing-fleet-value) [(reply)]))
    [(get (reply) "detail") (error? (result true))
      (get (first (result false)) "value")]
  "#
      )
      .unwrap(),
    serde_json::json!([null, true, "ok"])
  );
  assert!(
    host
      .eval_stmt("(fn bad (x (either string error)) -> bool true)")
      .is_err()
  );
  assert!(host.eval_stmt("(type Bad (either string error))").is_err());
  assert!(
    host
      .eval_stmt("(fn bad () -> (either string bool) true)")
      .is_err()
  );
  assert!(
    host
      .eval_to_json("(begin (fn wrong () -> (either string error) 42) (wrong))")
      .is_err()
  );
  assert!(
    host
      .eval_stmt(r#"(fn wire () -> error {"type" "error/v1"}) (wire)"#)
      .is_err()
  );
  assert!(
    host
      .eval_stmt("(trait ResultSource (fn result () -> (either string error)))")
      .is_ok()
  );
}

#[test]
fn error_readers_preserve_wire_text_and_expose_next_records() {
  let mut host = LispHost::new();
  host.register_native_special("failure", |_| {
    Ok(LispValue::Error(Box::new(tento_lisp::ErrorValue {
      kind: "unavailable".into(),
      message: "failed".into(),
      origin: None,
      chain: vec![],
      host: Some("rwc-04".into()),
      hint: None,
      next: Some("try later".into()),
      output: None,
      display: Some(
        serde_json::json!({"reason":"no route is available"})
          .as_object()
          .unwrap()
          .clone(),
      ),
    })))
  });
  assert_eq!(
    host
      .eval_to_json(
        r#"(let e (failure))
    [(error.host e) (get (error.next e) "text") (get (error.next e) "shape")
     (error.reason e) (get (json-parse (json-stringify e)) "next")
     (get (error.next e) "reason")
     (error.host nil) (error.next 1) (error.reason false)]"#
      )
      .unwrap(),
    serde_json::json!([
      "rwc-04",
      "try later",
      "next/v1",
      "no route is available",
      "try later",
      "no route is available",
      null,
      null,
      null
    ])
  );
  host.register_native_special("structured", |_| {
    Ok(LispValue::Error(Box::new(tento_lisp::ErrorValue {
      kind: "unavailable".into(),
      message: "failed".into(),
      origin: None,
      chain: vec![],
      host: None,
      hint: None,
      next: None,
      output: None,
      display: Some(
        serde_json::json!({"next":{"shape":"next/v1","text":"inspect","reason":"routes"}})
          .as_object()
          .unwrap()
          .clone(),
      ),
    })))
  });
  assert_eq!(
    host
      .eval_to_json(r#"(get (error.next (structured)) "reason")"#)
      .unwrap(),
    "routes"
  );
  assert_eq!(
    host
      .eval_to_json(r#"(get (json-parse (json-stringify (structured))) "next")"#)
      .unwrap(),
    "inspect"
  );
}

#[test]
fn error_type_cannot_be_rebound_at_the_root() {
  for source in ["(let error 1)", "(set error 1)"] {
    let mut host = LispHost::new();
    let error = host.eval_stmt(source).unwrap_err().to_string();
    assert!(error.contains("read-only"), "{source}: {error}");
    assert_eq!(
      host
        .eval_to_json("(fn f () -> error (try absent)) (error? (f))")
        .unwrap(),
      true
    );
  }
}

#[test]
fn error_record_projects_structured_text_and_preserves_text_fallback() {
  let mut error = tento_lisp::ErrorValue {
    kind: "unavailable".into(),
    message: "failed".into(),
    origin: None,
    chain: vec![],
    host: None,
    hint: None,
    next: Some("fallback".into()),
    output: None,
    display: Some(
      serde_json::json!({"next":{"reason":"routes"}})
        .as_object()
        .unwrap()
        .clone(),
    ),
  };
  assert_eq!(error.to_record()["next"], "fallback");
  error.next = None;
  assert!(error.to_record().get("next").is_none());
  error.next = Some("fallback".into());
  error.display.as_mut().unwrap().get_mut("next").unwrap()["text"] = "structured".into();
  assert_eq!(error.to_record()["next"], "structured");
}

#[test]
fn stream_with_closes_in_reverse_order_and_preserves_body_result_or_raise() {
  let mut host = LispHost::new();
  let closed = Rc::new(RefCell::new(vec![]));
  let observed = closed.clone();
  host.set_stream_callbacks(
    |token| {
      if ["outer", "inner"].contains(&token) {
        Ok(())
      } else {
        Err(LispHostError::Runtime("not a live token".into()))
      }
    },
    move |token| {
      observed.borrow_mut().push(token.to_string());
      Ok(())
    },
  );
  assert_eq!(
    host
      .eval_to_json(
        r#"(let s "outside")
    (std.stream.with (s "outer")
      (std.stream.with (t "inner") [s t]))"#
      )
      .unwrap(),
    serde_json::json!(["outer", "inner"])
  );
  assert_eq!(&*closed.borrow(), &["inner", "outer"]);
  assert_eq!(host.eval_to_json("s").unwrap(), "outside");
  closed.borrow_mut().clear();
  assert!(
    host
      .eval_stmt(r#"(std.stream.with (s "outer") (unwrap (try missing-stream-body)))"#)
      .is_err()
  );
  assert_eq!(&*closed.borrow(), &["outer"]);
  closed.borrow_mut().clear();
  assert_eq!(
    host
      .eval_to_json("(error? (std.stream.with (s (try missing-dial)) false))")
      .unwrap(),
    true
  );
  assert!(closed.borrow().is_empty());
  for source in [
    r#"(std.stream.with (s 42) true)"#,
    r#"(std.stream.with (s "closed") true)"#,
    "(std.stream.with (s) true)",
    "(std.stream.with (s 1))",
  ] {
    assert!(host.eval_stmt(source).is_err(), "{source}");
  }
  assert!(closed.borrow().is_empty());
}

#[test]
fn stream_close_failure_preserves_the_body_and_unauthorized_tokens_never_close() {
  let mut host = LispHost::new();
  let closed = Rc::new(RefCell::new(Vec::new()));
  let seen = closed.clone();
  host.set_stream_callbacks(
    |token| {
      if token == "owned" {
        Ok(())
      } else {
        Err(LispHostError::Runtime("stream capability denied".into()))
      }
    },
    move |token| {
      seen.borrow_mut().push(token.to_string());
      Err(LispHostError::Runtime("close failed".into()))
    },
  );
  assert_eq!(
    host
      .eval_to_json(r#"(std.stream.with (s "owned") "body")"#)
      .unwrap(),
    "body"
  );
  let error = host
    .eval_stmt(r#"(std.stream.with (s "owned") (unwrap (try missing-body)))"#)
    .unwrap_err()
    .to_string();
  assert!(error.contains("missing-body"), "{error}");
  assert!(
    host
      .eval_stmt(r#"(std.stream.with (s "peer") true)"#)
      .unwrap_err()
      .to_string()
      .contains("stream capability denied")
  );
  assert_eq!(&*closed.borrow(), &["owned", "owned"]);
}

#[test]
fn schema_types_are_constructible_and_sealed_before_script_execution() {
  #[derive(Schema)]
  #[serde(rename = "std.probe.Entry")]
  struct Entry {
    label: String,
    count: Option<i64>,
  }
  let mut host = LispHost::new();
  host.define_type(Entry::schema()).unwrap();
  assert!(host.define_type(Entry::schema()).is_err());
  assert_eq!(
    host
      .eval_to_json(
        r#"(let row (std.probe.Entry label: "test"))
    (fn validate (value std.probe.Entry) -> std.probe.Entry value)
    [(get (validate row) "label") row.count]"#
      )
      .unwrap(),
    serde_json::json!(["test", null])
  );
  assert!(
    host
      .define_type(Entry::schema())
      .unwrap_err()
      .to_string()
      .contains("sealed")
  );
  assert!(host.eval_stmt("(let std.probe.Entry 1)").is_err());
  assert!(host.eval_stmt("(set std.probe.Entry 1)").is_err());
}

#[test]
fn typed_native_keywords_share_function_binding_and_return_errors_as_values() {
  let mut host = LispHost::new();
  let calls = Rc::new(Cell::new(0));
  let observed = calls.clone();
  host.register_typed_native(
    "std.probe.call",
    Signature {
      params: vec![
        Parameter {
          name: "source".into(),
          kind: ParamKind::Positional,
          ty: TypeExpr::String,
          default: None,
          default_expression: None,
        },
        Parameter {
          name: "apply".into(),
          kind: ParamKind::Named,
          ty: TypeExpr::Bool,
          default: Some(JsonValue::Bool(false)),
          default_expression: None,
        },
        Parameter {
          name: "cwd".into(),
          kind: ParamKind::Named,
          ty: TypeExpr::Option(Box::new(TypeExpr::String)),
          default: Some(JsonValue::Null),
          default_expression: None,
        },
      ],
      result: TypeExpr::Either(
        Box::new(TypeExpr::List(Box::new(TypeExpr::Any))),
        Box::new(TypeExpr::Error),
      ),
    },
    move |args| {
      observed.set(observed.get() + 1);
      Ok(LispValue::List(tento_lisp::List { items: args.into() }))
    },
  );
  assert_eq!(
    host
      .eval_to_json(
        r#"[(std.probe.call "x")
    (std.probe.call "y" cwd: "/tmp" apply: true)]"#
      )
      .unwrap(),
    serde_json::json!([["x", false, null], ["y", true, "/tmp"]])
  );
  for source in [
    r#"(std.probe.call "x" unknown: true)"#,
    r#"(std.probe.call "x" apply: true apply: false)"#,
    r#"(std.probe.call "x" apply: "yes")"#,
    r#"(std.probe.call "x" cwd:)"#,
  ] {
    assert!(host.eval_stmt(source).is_err(), "{source}");
  }
  assert_eq!(calls.get(), 2);
  host.register_typed_native(
    "std.probe.failure",
    Signature {
      params: vec![],
      result: TypeExpr::Either(Box::new(TypeExpr::String), Box::new(TypeExpr::Error)),
    },
    |_| {
      Ok(LispValue::Error(Box::new(tento_lisp::ErrorValue {
        kind: "unavailable".into(),
        message: "offline".into(),
        origin: None,
        chain: vec![],
        host: None,
        hint: None,
        next: None,
        output: None,
        display: None,
      })))
    },
  );
  assert_eq!(
    host.eval_to_json("(error? (std.probe.failure))").unwrap(),
    true
  );
}
