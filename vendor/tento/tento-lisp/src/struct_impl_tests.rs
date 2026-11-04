use crate::{Env, Interpreter, Runtime, Value};
use std::{cell::RefCell, rc::Rc};
use string_interner::{backend::StringBackend, symbol::SymbolU32};

type I = Interpreter<SymbolU32, StringBackend>;

fn eval(
  i: &mut I,
  env: &Rc<RefCell<Env<SymbolU32>>>,
  source: &str,
) -> Result<Value<SymbolU32>, String> {
  let forms = Runtime::parse(None, source, i.string_interner()).map_err(|e| format!("{e:?}"))?;
  let mut result = Value::Nil;
  for form in forms {
    result = i
      .eval_expression(env.clone(), &Value::from_owned_sexpression(form).unwrap())
      .map_err(|e| e.to_string())?;
  }
  Ok(result)
}
fn json(i: &mut I, env: &Rc<RefCell<Env<SymbolU32>>>, source: &str) -> serde_json::Value {
  crate::types::data_json(&eval(i, env, source).unwrap()).unwrap()
}

#[test]
fn preset_lists_concatenate_without_changing_string_coercion() {
  let mut i = I::new();
  let env = i.default_env();
  assert_eq!(
    json(&mut i, &env, "(concat [1 2] [] [3])"),
    serde_json::json!([1, 2, 3])
  );
  assert_eq!(json(&mut i, &env, "(concat \"x\" 2 true)"), "x2true");
  assert_eq!(json(&mut i, &env, "(concat)"), "");
  assert!(eval(&mut i, &env, "(concat [] \"x\")").is_err());
  assert!(eval(&mut i, &env, "(str.concat [])").is_err());
}

#[test]
fn self_dispatch_is_nominal_checked_and_first_class() {
  let mut i = I::new();
  let env = i.default_env();
  let result = json(
    &mut i,
    &env,
    r#"
    (struct First volume: string)
    (struct Second volume: string)
    (trait Item (fn check (self apply: bool = false) -> string))
    (define prefix "first:")
    (impl Item for First (fn check (self apply: bool = false) -> string
      (concat prefix self.volume (if apply "!" "?"))))
    (impl Item for Second (fn check (self apply: bool = false) -> string self.volume))
    (define value (First volume: "/Data"))
    (define method Item.check)
    (list (Item.check value) (method value apply: true)
      (Item.check (Second volume: "second"))
      (trait.check Item First) (trait.check Item value)
      (count (trait.impls Item)) value.volume (get value "volume"))
  "#,
  );
  assert_eq!(
    result,
    serde_json::json!([
      "first:/Data?",
      "first:/Data!",
      "second",
      "ok",
      "ok",
      2,
      "/Data",
      "/Data"
    ])
  );
  assert!(
    eval(&mut i, &env, "(Item.check value apply: 1)")
      .unwrap_err()
      .contains("arguments.apply")
  );
  assert!(
    eval(&mut i, &env, "(Item.check {\"volume\" \"plain\"})")
      .unwrap_err()
      .contains("no impl")
  );
  assert!(
    eval(
      &mut i,
      &env,
      "(impl Item for First (fn check (self apply: bool = false) -> string \"x\"))"
    )
    .unwrap_err()
    .contains("duplicate impl")
  );
  assert_eq!(
    json(
      &mut i,
      &env,
      "(get {\"nested\" {\"volume\" \"map\"}} \"nested\")"
    ),
    serde_json::json!({"volume":"map"})
  );
  assert_eq!(
    json(
      &mut i,
      &env,
      "(let ((record {\"nested\" {\"volume\" \"map\"}})) record.nested.volume)"
    ),
    "map"
  );
}

#[test]
fn use_resolves_mounted_paths_namespaces_and_selective_aliases() {
  let mut i = I::new();
  let env = i.default_env();
  let module = crate::types::Module::new("a.b.c".into(), Default::default()).with_exports(
    [("answer".into(), Value::Integer(42))]
      .into_iter()
      .collect(),
  );
  let symbol = i.string_interner().get_or_intern("a.b.c");
  env
    .borrow_mut()
    .define(symbol, Value::Module(Rc::new(module)));
  assert_eq!(
    json(
      &mut i,
      &env,
      "(use a.b.c (answer)) (use a.b.c) (list answer c.answer)"
    ),
    serde_json::json!([42, 42])
  );
  assert_eq!(
    json(
      &mut i,
      &env,
      "(define ns.parts.answer 7) (use ns.parts (answer)) (use ns.parts) (list answer parts.answer (module.name parts))"
    ),
    serde_json::json!([7, 7, "ns.parts"])
  );
  assert!(
    eval(&mut i, &env, "(use no.such.module (answer))")
      .unwrap_err()
      .contains("no.such.module.answer")
  );
}

#[test]
fn aliases_of_struct_types_keep_constructor_identity() {
  let mut i = I::new();
  let env = i.default_env();
  assert_eq!(
    json(
      &mut i,
      &env,
      r#"
    (struct Params volume: string)
    (type Alias Params)
    (trait Item (fn check (self) -> string))
    (impl Item for Params (fn check (self) -> string self.volume))
    (Item.check (Alias volume: "/alias"))
  "#
    ),
    "/alias"
  );
}

#[test]
fn implementation_contracts_are_verified_without_running_methods() {
  let mut i = I::new();
  let env = i.default_env();
  eval(
    &mut i,
    &env,
    "(struct Params volume: string) (trait Item (fn check (self apply: bool = false) -> string))",
  )
  .unwrap();
  for (source, message) in [
    ("(impl Item for Params)", "missing callable member"),
    (
      "(impl Item for Params (fn other (self) -> string \"x\"))",
      "unknown Item method",
    ),
    (
      "(impl Item for Params (fn check (self apply: bool = true) -> string \"x\"))",
      "default differs",
    ),
    (
      "(impl Item for Params (fn check (self apply: bool = false) -> s64 1))",
      "result",
    ),
    (
      "(impl Item for Params (fn check (value) -> string \"x\"))",
      "self",
    ),
  ] {
    assert!(
      eval(&mut i, &env, source).unwrap_err().contains(message),
      "{source}"
    );
  }
  eval(
    &mut i,
    &env,
    "(impl Item for Params (fn check (self apply: bool = false) -> string 42))",
  )
  .unwrap();
  assert!(
    eval(&mut i, &env, "(Item.check (Params volume: \"x\"))")
      .unwrap_err()
      .contains("result")
  );
}

#[test]
fn shapes_default_and_hydrate_json_back_to_nominal_records() {
  let mut i = I::new();
  let env = i.default_env();
  let result = json(
    &mut i,
    &env,
    r#"
    (struct Params shape: (enum "item.params/v1") volume: string note: (option string))
    (trait Item (fn check (self) -> string))
    (impl Item for Params (fn check (self) -> string self.volume))
    (define params (Params volume: "/Data"))
    (define copy (std.record.hydrate (json-parse (json-stringify params)) as: Params))
    (list params copy (Item.check copy) (trait.check Item copy)
      (Params shape: "item.params/v1" volume: "/Other"))
  "#,
  );
  assert_eq!(
    result,
    serde_json::json!([
      {"shape":"item.params/v1","volume":"/Data","note":null},
      {"shape":"item.params/v1","volume":"/Data","note":null},"/Data","ok",
      {"shape":"item.params/v1","volume":"/Other","note":null}
    ])
  );
  for (source, expected) in [
    (
      "(std.record.hydrate {\"shape\" \"unknown/v1\"} as: Params)",
      "unknown/v1",
    ),
    ("(std.record.hydrate {\"volume\" \"/Data\"} as: Params)", "shape"),
    (
      "(std.record.hydrate {\"shape\" \"item.params/v1\" \"volume\" 1} as: Params)",
      "volume",
    ),
    (
      "(Params shape: \"wrong\" volume: \"/Data\")",
      "arguments.shape",
    ),
    (
      "(struct Duplicate shape: (enum \"item.params/v1\"))",
      "belongs to <REPL>.Params",
    ),
  ] {
    assert!(
      eval(&mut i, &env, source).unwrap_err().contains(expected),
      "{source}"
    );
  }
  eval(&mut i, &env, "(struct Other mode: (enum \"only\"))").unwrap();
  assert!(
    eval(&mut i, &env, "(Other)")
      .unwrap_err()
      .contains("missing argument mode")
  );
}

#[test]
fn shape_ownership_is_idempotent_and_repl_redefinitions_replace_their_type() {
  let mut i = I::new();
  let env = i.default_env();
  let owner = i.string_interner().get_or_intern("__module_bundle");
  let bundle = Rc::new(RefCell::new(Env::extend(env.clone())));
  bundle
    .borrow_mut()
    .define(owner, Value::String("vendor-a".into()));
  let first = eval(
    &mut i,
    &bundle,
    r#"(struct Params shape: (enum "shared/v1") value: string)"#,
  )
  .unwrap();
  let second = eval(
    &mut i,
    &bundle,
    r#"(struct Params shape: (enum "shared/v1") value: string)"#,
  )
  .unwrap();
  let (Value::Type(first), Value::Type(second)) = (first, second) else {
    panic!()
  };
  assert!(Rc::ptr_eq(&first, &second));
  bundle
    .borrow_mut()
    .define(owner, Value::String("vendor-b".into()));
  let error = eval(
    &mut i,
    &bundle,
    r#"(struct Params shape: (enum "shared/v1") value: string)"#,
  )
  .unwrap_err();
  assert!(
    error.contains("vendor-a.Params") && error.contains("vendor-b.Params"),
    "{error}"
  );
  eval(
    &mut i,
    &env,
    r#"(struct Local shape: (enum "local/v1") value: string)"#,
  )
  .unwrap();
  eval(
    &mut i,
    &env,
    r#"(struct Local shape: (enum "local/v2") count: s64)"#,
  )
  .unwrap();
  assert_eq!(
    json(
      &mut i,
      &env,
      r#"(std.record.hydrate {"shape" "local/v2" "count" 2} as: Local)"#
    ),
    serde_json::json!({"shape":"local/v2","count":2})
  );
  assert!(
    eval(
      &mut i,
      &env,
      r#"(std.record.hydrate {"shape" "local/v1" "value" "x"} as: Local)"#
    )
    .unwrap_err()
    .contains("no registered struct")
  );
}

#[test]
fn hydration_requires_an_explicit_type_or_matching_bundle_owner() {
  let mut i = I::new();
  let env = i.default_env();
  let owner = i.string_interner().get_or_intern("__module_bundle");
  env
    .borrow_mut()
    .define(owner, Value::String("tsh-item-sudoers".into()));
  eval(
    &mut i,
    &env,
    r#"(struct Sudoers shape: (enum "sudoers/v1") value: string)"#,
  )
  .unwrap();
  env
    .borrow_mut()
    .define(owner, Value::String("tsh-item-spotlight".into()));
  eval(
    &mut i,
    &env,
    r#"(struct Spotlight shape: (enum "spotlight/v1") value: string)"#,
  )
  .unwrap();
  let data = r#"{"shape" "sudoers/v1" "value" "forged"}"#;
  for (constraint, expected) in [
    ("", "requires exactly one constraint"),
    (
      "for: \"tsh-item-spotlight\"",
      "not requested bundle tsh-item-spotlight",
    ),
    ("as: Spotlight", "not requested type"),
    (
      "as: Sudoers for: \"tsh-item-sudoers\"",
      "requires exactly one constraint",
    ),
  ] {
    let error = eval(
      &mut i,
      &env,
      &format!("(std.record.hydrate {data} {constraint})"),
    )
    .unwrap_err();
    assert!(error.contains(expected), "{error}");
    if !constraint.is_empty() && !constraint.contains("as: Sudoers for:") {
      assert!(
        error.contains("sudoers/v1") && error.contains("tsh-item-sudoers"),
        "{error}"
      );
    }
  }
  for constraint in ["as: Sudoers", "for: \"tsh-item-sudoers\""] {
    assert_eq!(
      json(
        &mut i,
        &env,
        &format!("(std.record.hydrate {data} {constraint})")
      ),
      serde_json::json!({"shape":"sudoers/v1","value":"forged"})
    );
  }
}

#[test]
fn missing_record_fields_name_the_struct_and_field() {
  let mut i = I::new();
  let env = i.default_env();
  let error = eval(
    &mut i,
    &env,
    "(struct Params value: string) (define self (Params value: \"x\")) self.missing",
  )
  .unwrap_err();
  assert!(
    error.contains("Params") && error.contains("missing"),
    "{error}"
  );
}

#[test]
fn reserved_bundle_identity_cannot_be_redefined() {
  let mut i = I::new();
  let env = i.default_env();
  for source in [
    "(define __module_bundle \"forged\")",
    "(let __module_bundle \"forged\")",
    "(fn __module_bundle () 1)",
    "(let __module_bundle \"forged\" 1)",
    "(let ((__module_bundle \"forged\")) 1)",
    "(let [__module_bundle \"forged\"] 1)",
    "(lambda (__module_bundle) 1)",
    "(fn identity (__module_bundle: string) -> string __module_bundle)",
  ] {
    assert!(
      eval(&mut i, &env, source).unwrap_err().contains("reserved"),
      "{source}"
    );
  }
}

#[test]
fn dotted_receiver_lookup_skips_a_plain_longer_prefix() {
  let mut i = I::new();
  let env = i.default_env();
  let state = crate::ReceiverState {
    name: "a".into(),
    selectors: [(
      ":b.c".into(),
      Rc::new(|_, _| Ok(Value::Integer(42))) as crate::NativeClosure<SymbolU32>,
    )]
    .into_iter()
    .collect(),
    members: RefCell::new(vec![]),
  };
  let receiver = i.make_receiver(Rc::new(state));
  let a = i.string_interner().get_or_intern("a");
  env.borrow_mut().define(a, receiver);
  assert_eq!(json(&mut i, &env, "(define a.b 7) (a.b.c)"), 42);
  assert_eq!(json(&mut i, &env, "(define a.b.c 9) a.b.c"), 9);
}

#[test]
fn namespace_use_scans_visible_bindings_with_shadowing() {
  let mut i = I::new();
  let env = i.default_env();
  eval(&mut i, &env, "(define tools.answer 1)").unwrap();
  // Interned-but-unbound names are not namespace members.
  i.string_interner().get_or_intern("tools.absent");
  let child = Rc::new(RefCell::new(Env::extend(env.clone())));
  assert_eq!(
    json(
      &mut i,
      &child,
      "(define tools.answer 2) (use tools as: local) local.answer"
    ),
    2
  );
  assert!(eval(&mut i, &child, "local.absent").is_err());
}
