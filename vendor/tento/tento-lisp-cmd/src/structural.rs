//! Bridge existing native schemas to language contracts. No provider calls for discovery.
use std::{collections::BTreeMap, rc::Rc};
use tento_lisp::{Function, NativeClosure, RuntimeError, Value};
use tento_lisp::types::{Module, ParamKind, Parameter, Signature, TypeExpr, TypedNative, data_json};
use crate::{CommandDoc, OptionKind, schema::TypeDesc, script::Sym};

pub fn type_expression(ty: &TypeDesc) -> TypeExpr {
  match ty {
    TypeDesc::String => TypeExpr::String, TypeDesc::Bool => TypeExpr::Bool,
    TypeDesc::S64 => TypeExpr::S64, TypeDesc::U64 => TypeExpr::U64,
    TypeDesc::F64 => TypeExpr::F64, TypeDesc::Any => TypeExpr::Any,
    TypeDesc::Option { of } => TypeExpr::Option(Box::new(type_expression(of))),
    TypeDesc::List { of } => TypeExpr::List(Box::new(type_expression(of))),
    TypeDesc::Record { name, fields } => TypeExpr::Record { name: name.clone(), fields: fields.iter().map(|f| (f.name.clone(), type_expression(&f.ty))).collect() },
    TypeDesc::Enum { cases, .. } => TypeExpr::Enum(cases.clone()),
    TypeDesc::Variant { .. } => TypeExpr::Unknown("payload variants are not supported by structural traits yet".into()),
  }
}

pub fn signature(doc: &CommandDoc) -> Signature {
  Signature {
    params: doc.options.iter().map(|option| Parameter {
      name: option.name.clone(),
      kind: match option.kind { OptionKind::Named | OptionKind::Flag => ParamKind::Named, OptionKind::Positional => ParamKind::Positional, OptionKind::Variadic => ParamKind::Variadic },
      ty: option.schema.as_ref().map(type_expression).unwrap_or_else(|| {
        if option.kind == OptionKind::Flag { TypeExpr::Bool }
        else { TypeExpr::Unknown(format!("{} has no structured parameter schema", option.name)) }
      }),
      default: option.default.clone().or_else(|| (option.kind == OptionKind::Flag).then(|| serde_json::json!(false))),
      default_expression: None,
    }).collect(),
    result: doc.result.as_ref().map(|r| type_expression(&r.ty)).unwrap_or_else(|| TypeExpr::Unknown("command has no result schema".into())),
  }
}

/// The existing argv transport coerces literal words. Refuse any value it
/// cannot preserve rather than silently mutating a typed argument. This seam
/// can later use a versioned bind-document transport without changing Lisp.
fn argv(signature: &Signature, values: Vec<Value<Sym>>) -> Result<Vec<Value<Sym>>, RuntimeError> {
  let mut named = vec![];
  let mut positionals = vec![];
  for (param, value) in signature.params.iter().zip(values) {
    if matches!(value, Value::Nil) && param.ty.optional() && param.default.as_ref().is_none_or(|v| v.is_null()) { continue; }
    let json = data_json(&value)?;
    let encode = |json: serde_json::Value| -> Result<String, RuntimeError> {
      let word = match &json { serde_json::Value::String(s) => s.clone(), _ => json.to_string() };
      let legacy_keyword = param.kind != ParamKind::Named && word.strip_prefix(':')
        .is_some_and(|rest| rest.chars().next().is_some_and(|c| c.is_ascii_alphabetic()));
      if legacy_keyword || crate::command_arg::parse_value(&word) != json {
        return Err(RuntimeError::Other(format!("arguments.{}: current provider argv transport cannot preserve this value; a typed bind-document transport is required", param.name)));
      }
      Ok(word)
    };
    match param.kind {
      ParamKind::Named => named.push(Value::String(format!("--{}={}", param.name, encode(json)?).into())),
      ParamKind::Positional => positionals.push(Value::String(encode(json)?.into())),
      ParamKind::Variadic => {
        let serde_json::Value::Array(items) = json else { return Err(RuntimeError::Other("variadic argument must be a list".into())); };
        for item in items { positionals.push(Value::String(encode(item)?.into())); }
      },
    }
  }
  if !positionals.is_empty() {
    named.push(Value::String("--".into()));
    named.extend(positionals);
  }
  Ok(named)
}

/// Make a first-class module alongside the unchanged flat adapters. Malformed
/// descriptors stay visible as unknown signatures in trait.report.
pub fn module_value(
  namespace: &str,
  docs: impl IntoIterator<Item = (String, serde_json::Value)>,
  mounts: &[(String, Value<Sym>)],
) -> Value<Sym> {
  let docs: Vec<_> = docs.into_iter().collect();
  Value::Module(Rc::new(Module::new(namespace.to_string(), module_methods(namespace, docs.iter().map(|(name, wire)| (name.clone(), wire)), mounts))))
}

// Decode only the contract; serde skips opaque help and descriptions.
#[derive(serde::Deserialize)]
struct Contract {
  #[serde(default)] options: Vec<crate::OptionDoc>,
  result: Option<crate::shape::ResultDoc>,
}
fn contract_signature(name: &str, contract: Result<Contract, serde_json::Error>) -> Signature {
  match contract {
    Ok(contract) => signature(&CommandDoc { name: name.into(), description: String::new(), long_description: None, options: contract.options, result: contract.result }),
    Err(error) => Signature { params: vec![], result: TypeExpr::Unknown(format!("invalid command descriptor: {error}")) },
  }
}
pub fn module_methods<'a>(
  namespace: &str,
  docs: impl IntoIterator<Item = (String, &'a serde_json::Value)>,
  mounts: &[(String, Value<Sym>)],
) -> BTreeMap<String, Rc<TypedNative<Sym>>> {
  checked_methods(namespace, docs.into_iter().map(|(name, wire)| {
    let sig = contract_signature(&name, <Contract as serde::Deserialize>::deserialize(wire));
    (name, sig)
  }), mounts)
}
/// Installed manifests keep descriptors as raw text. Do not materialize their
/// presentation fields merely to inspect callable signatures.
pub fn module_methods_json<'a>(
  namespace: &str,
  docs: impl IntoIterator<Item = (String, &'a str)>,
  mounts: &[(String, Value<Sym>)],
) -> BTreeMap<String, Rc<TypedNative<Sym>>> {
  checked_methods(namespace, docs.into_iter().map(|(name, wire)| {
    let sig = contract_signature(&name, serde_json::from_str(wire));
    (name, sig)
  }), mounts)
}
fn checked_methods(
  namespace: &str,
  signatures: impl IntoIterator<Item = (String, Signature)>,
  mounts: &[(String, Value<Sym>)],
) -> BTreeMap<String, Rc<TypedNative<Sym>>> {
  let mut methods = BTreeMap::new();
  for (name, sig) in signatures {
    let full = format!("{namespace}.{name}");
    let Some((_, Value::Function(Function::NativeClosure(raw)))) = mounts.iter().find(|(n, _)| n == &full) else { continue; };
    let raw = raw.clone();
    let binding = sig.clone();
    let body: NativeClosure<Sym> = Rc::new(move |env, values| raw(env, argv(&binding, values)?));
    methods.insert(name, Rc::new(TypedNative { name: full, signature: sig, body }));
  }
  methods
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::{Cell, RefCell};
  use crate::script::{ImportMounts, ImportResolver, LispHost};
  use serde_json::json;

  fn doc(result: serde_json::Value) -> serde_json::Value {
    json!({"name":"accounts","description":"independent report", "options":[
      {"name":"hosts","kind":"named","schema":{"kind":"option","of":{"kind":"string"}}},
      {"name":"refresh","kind":"flag","schema":{"kind":"bool"},"default":false}
    ],"result":{"type":result}})
  }
  fn record() -> serde_json::Value { json!({"kind":"record","name":"IndependentReport","fields":[{"name":"provider","type":{"kind":"string"}},{"name":"extra","type":{"kind":"bool"}}]}) }
  fn mounts(namespace: &str, calls: Rc<RefCell<Vec<Vec<String>>>>) -> ImportMounts {
    let native: NativeClosure<Sym> = Rc::new(move |_, args| {
      calls.borrow_mut().push(args.into_iter().map(|v| match v { Value::String(s) => s.into_string(), _ => panic!("argv string") }).collect());
      Ok(crate::script::value_from_json(&json!({"provider":"independent","extra":true})))
    });
    let mut mounts = vec![(format!("{namespace}.accounts"), Value::Function(Function::NativeClosure(native)))];
    let module = module_value(namespace, [("accounts".into(),doc(record()))], &mounts);
    mounts.push((namespace.into(),module));
    ImportMounts { mounts, async_mounts:vec![],ui_scripts:vec![],rc_scripts:vec![] }
  }
  const CONTRACT: &str = "(struct Report provider: string) (trait Source (fn accounts (hosts: (option string) refresh: bool = false) -> Report))";

  #[test]
  fn typed_module_bridge_preserves_controls_defaults_and_reflection() {
    let calls: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
    let mut host = LispHost::new();
    host.mount(mounts("other",calls.clone()),"other");
    host.eval_value(CONTRACT).unwrap();
    assert_eq!(host.eval_to_json("(trait.conforms Source other)").unwrap(),json!(true));
    assert_eq!(host.eval_to_json("(trait.check Source other)").unwrap(),json!("ok"));
    assert!(calls.borrow().is_empty());
    let value = host.eval_to_json(r#"(let src (first (trait.impls Source))) (src.accounts hosts: "--help")"#).unwrap();
    assert_eq!(value["provider"],json!("independent"));
    assert_eq!(calls.borrow()[0],vec!["--hosts=--help","--refresh=false"]);
    host.eval_to_json("(src.accounts)").unwrap();
    assert_eq!(calls.borrow()[1],vec!["--refresh=false"]);
    assert!(host.eval_to_json(r#"(src.accounts hosts: "false")"#).unwrap_err().to_string().contains("cannot preserve"));
    assert_eq!(calls.borrow().len(),2);
  }
  struct Resolver {
    calls: Rc<RefCell<Vec<Vec<String>>>>,
    resolves: Rc<Cell<usize>>,
    fail: Rc<Cell<bool>>,
  }
  impl ImportResolver for Resolver {
    fn resolve(&self, _: &str, namespace: &str, _: Option<&str>, _: Rc<RefCell<Option<String>>>) -> Result<ImportMounts, RuntimeError> {
      self.resolves.set(self.resolves.get()+1);
      if namespace == "zfail" && self.fail.get() { return Err(RuntimeError::Other("temporarily unavailable".into())); }
      Ok(mounts(namespace,self.calls.clone()))
    }
    fn lazy_eligible(&self, _: &str, _: Option<&str>) -> bool { true }
  }
  #[test]
  fn lazy_discovery_resolves_without_invoking_and_retries_without_losing_modules() {
    let calls: Rc<RefCell<Vec<Vec<String>>>> = Rc::default(); let resolves = Rc::new(Cell::new(0)); let fail = Rc::new(Cell::new(true));
    let mut host = LispHost::with_resolver(Rc::new(Resolver { calls:calls.clone(),resolves:resolves.clone(),fail:fail.clone() }));
    host.enable_lazy_imports();
    host.eval_value(r#"(@import "first" :as "a") (@import "second" :as "zfail")"#).unwrap();
    host.eval_value(CONTRACT).unwrap();
    assert_eq!(resolves.get(),0);
    assert!(host.eval_value("(trait.impls Source)").unwrap_err().to_string().contains("zfail"));
    assert!(calls.borrow().is_empty());
    fail.set(false);
    let values = host.eval_to_json("(map (lambda (m) (module.name m)) (trait.impls Source))").unwrap();
    assert_eq!(values,json!(["a","zfail"]));
    assert!(calls.borrow().is_empty());
  }
  #[test]
  fn bare_lazy_module_reference_and_malformed_metadata_are_visible() {
    let mut host = LispHost::with_resolver(Rc::new(Resolver { calls:Rc::default(),resolves:Rc::new(Cell::new(0)),fail:Rc::new(Cell::new(false)) }));
    host.enable_lazy_imports();
    host.eval_value(r#"(@import "a" :as "renamed")"#).unwrap();
    assert_eq!(host.eval_to_json("(module.name renamed)").unwrap(),json!("renamed"));
    let mut imported = mounts("broken",Rc::default());
    let module = module_value("broken",[("accounts".into(),json!({"options":42}))],&imported.mounts);
    imported.mounts.retain(|(name,_)| name != "broken");
    imported.mounts.push(("broken".into(),module));
    host.mount(imported,"broken");
    host.eval_value(CONTRACT).unwrap();
    let report = host.eval_to_json("(trait.report Source)").unwrap();
    let broken = report.as_array().unwrap().iter().find(|row| row["name"] == "broken").unwrap();
    assert_eq!(broken["conforms"],json!(false));
    assert!(broken["errors"].as_array().unwrap().iter().any(|e| e["reason"].as_str().unwrap().contains("invalid command descriptor")));
    // Directly selecting a typed member with bad metadata also refuses before
    // dispatch; callers need not go through trait.impls to get this boundary.
    assert!(host.eval_to_json("(let selected broken) (selected.accounts)").unwrap_err().to_string().contains("invalid command descriptor"));
  }
}

#[cfg(test)]
mod auth_integration {
  use super::*;
  use std::{cell::Cell, path::PathBuf};
  use crate::{schema::Schema, script::{ImportMounts, LispHost}};
  use serde_json::json;

  #[allow(dead_code)]
  #[derive(crate::schema::Schema)]
  struct Window { label: String, used_percent: f64, resets_at: Option<i64> }
  #[allow(dead_code)]
  #[derive(crate::schema::Schema)]
  struct Account { id: String, nick: String, login: String, login_detail: Option<String>, login_expires_at: Option<i64>, usage_as_of: Option<i64>, usage: Vec<Window>, usage_state: String }
  #[allow(dead_code)]
  #[derive(crate::schema::Schema)]
  struct IndependentReport { provider: String, active: Option<String>, accounts: Vec<Account> }
  #[allow(dead_code)]
  #[derive(crate::CommandArg, serde::Deserialize)]
  struct Args { hosts: Option<String>, #[arg(default = false)] refresh: bool }
  /// A host-local provider: no hosts to name.
  #[allow(dead_code)]
  #[derive(crate::CommandArg, serde::Deserialize)]
  struct AccountsArgs { #[arg(default = false)] refresh: bool }

  #[test]
  fn derived_provider_descriptors_preserve_structural_types() {
    let doc = CommandDoc { name:"accounts".into(),description:String::new(),long_description:None,options:<Args as crate::CommandArg>::arg_docs(),result:Some(crate::shape::ResultDoc { ty:IndependentReport::schema(),shape:None,columns:vec![],cases:vec![] }) };
    let sig = signature(&doc);
    assert!(matches!(sig.params[0].ty,TypeExpr::Option(_)));
    assert!(matches!(sig.params[1].ty,TypeExpr::Bool));
    assert_eq!(sig.params[1].default,Some(json!(false)));
    assert!(matches!(sig.result,TypeExpr::Record { .. }));
    for hosts in ["fleet", "--help", ":help", "rwc-01,rwc-05", "rwc-01 rwc-05"] {
      let values = sig.bind(vec![(Some("hosts".into()),Value::String(hosts.into()))]).unwrap();
      let mut words = vec!["accounts".to_string()];
      words.extend(argv(&sig,values).unwrap().into_iter().map(|v| match v { Value::String(s) => s.into_string(), _ => panic!() }));
      let parsed = crate::parse_arguments::<Args>(words).unwrap();
      assert_eq!(parsed.hosts.as_deref(),Some(hosts));
      assert!(!parsed.refresh);
    }
  }

  /// Explicit owner-workspace integration. The caller supplies the provider
  /// thread's current file; the language crate does not vendor that source.
  #[test]
  #[ignore = "set TSH_AUTH_RC to the current auth bundle source"]
  fn auth_bundle_current_source() {
    let path = PathBuf::from(std::env::var("TSH_AUTH_RC").expect("TSH_AUTH_RC is required"));
    assert!(path.is_file(),"{}",path.display());
    let mut host = LispHost::new();
    host.register_native_special("std.time.unix", |_| Ok(Value::Integer(1700000000)));
    let count = Rc::new(Cell::new(0));
    let broken = Rc::new(Cell::new(false));
    let called = count.clone(); let lie = broken.clone();
    let raw: NativeClosure<Sym> = Rc::new(move |_, values| {
      called.set(called.get()+1);
      assert_eq!(values.len(), 1);
      assert!(matches!(&values[0], Value::String(s) if s == "--refresh=false"));
      let value = json!({"provider":"independent","active":"test@example.invalid","accounts":[{"id":"test@example.invalid","nick":"test","login":"ok","login_detail":null,"login_expires_at":null,"usage_as_of":1699999940,"usage":[{"label":"5h","used_percent":if lie.get() { json!("invalid") } else { json!(25.0) },"resets_at":1700000300}],"usage_state":"available"}]});
      Ok(crate::script::value_from_json(&value))
    });
    let doc = CommandDoc { name:"accounts".into(),description:String::new(),long_description:None,options:<AccountsArgs as crate::CommandArg>::arg_docs(),result:Some(crate::shape::ResultDoc { ty:IndependentReport::schema(),shape:None,columns:vec![],cases:vec![] }) };
    let mut mounts = vec![("renamed.accounts".into(),Value::Function(Function::NativeClosure(raw)))];
    let module = module_value("renamed",[("accounts".into(),serde_json::to_value(doc).unwrap())],&mounts);
    mounts.push(("renamed".into(),module));
    host.mount(ImportMounts { mounts,async_mounts:vec![],ui_scripts:vec![],rc_scripts:vec![] },"renamed");
    host.mount(ImportMounts { mounts:vec![],async_mounts:vec![],ui_scripts:vec![],rc_scripts:vec![path] },"auth");
    host.process_pending_rc().unwrap();
    let contract = host.eval_to_json("(auth.contract)").unwrap();
    assert_eq!(contract["name"],json!("AccountSource"));
    let check = host.eval_to_json("(auth.check)").unwrap();
    assert_eq!(check[0]["name"],json!("renamed"));
    assert_eq!(check[0]["conforms"],json!(true));
    assert_eq!(count.get(),0,"contract and check must never run a provider");
    let report = host.eval_to_json("(auth.status (hash-map))").unwrap();
    assert_eq!(report["shape"],json!("sections/v1"));
    assert!(report.to_string().contains("test@example.invalid"),"{report}");
    assert_eq!(count.get(),1);
    broken.set(true);
    let report = host.eval_to_json("(auth.status (hash-map))").unwrap();
    assert!(report.to_string().contains("renamed.accounts.result.accounts[0].usage[0].used_percent"),"{report}");
  }
}
