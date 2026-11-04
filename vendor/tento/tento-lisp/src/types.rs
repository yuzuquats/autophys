//! Structural contracts independent of native command metadata or provider names.
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};
use crate::{Env, NativeClosure, RuntimeError, Symbol, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TypeExpr {
  Any,
  Bool,
  S64,
  U64,
  F64,
  String,
  Error,
  Either(Box<TypeExpr>, Box<TypeExpr>),
  /// A nominal record type value, used by constrained record hydration.
  StructType,
  Option(Box<TypeExpr>),
  List(Box<TypeExpr>),
  Record {
    name: String,
    fields: BTreeMap<String, TypeExpr>,
  },
  Enum(Vec<String>),
  /// Missing or unsupported metadata never establishes conformance.
  Unknown(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mismatch {
  pub path: String,
  pub reason: String,
}
fn mismatch(out: &mut Vec<Mismatch>, path: &str, reason: impl Into<String>) {
  out.push(Mismatch { path: path.into(), reason: reason.into() });
}

impl TypeExpr {
  pub fn describe(&self) -> serde_json::Value {
    use serde_json::json;
    match self {
      Self::Any => json!({"kind":"any"}), Self::Bool => json!({"kind":"bool"}),
      Self::S64 => json!({"kind":"s64"}), Self::U64 => json!({"kind":"u64"}),
      Self::F64 => json!({"kind":"f64"}), Self::String => json!({"kind":"string"}),
      Self::StructType => json!({"kind":"struct-type"}),
      Self::Error => json!({"kind":"error"}),
      Self::Either(a, b) => json!({"kind":"either","cases":[a.describe(),b.describe()]}),
      Self::Option(of) => json!({"kind":"option","of":of.describe()}),
      Self::List(of) => json!({"kind":"list","of":of.describe()}),
      Self::Record { name, fields } => json!({"kind":"record","name":name,"fields": fields.iter().map(|(name, ty)| json!({"name":name,"type":ty.describe()})).collect::<Vec<_>>()}),
      Self::Enum(cases) => json!({"kind":"enum","cases":cases}),
      Self::Unknown(reason) => json!({"kind":"unknown","reason":reason}),
    }
  }
  pub fn optional(&self) -> bool { matches!(self, Self::Option(_)) }

  fn contains_either(&self) -> bool {
    match self {
      Self::Either(_, _) => true,
      Self::Option(inner) | Self::List(inner) => inner.contains_either(),
      Self::Record { fields, .. } => fields.values().any(Self::contains_either),
      _ => false,
    }
  }

  /// `self` is produced; `required` is consumed. Record names are documentary.
  pub fn subtype(&self, required: &Self, path: &str, out: &mut Vec<Mismatch>) {
    use TypeExpr::*;
    match (self, required) {
      (Unknown(reason), _) | (_, Unknown(reason)) => mismatch(out, path, reason.clone()),
      (_, Any) => {},
      (Either(a, b), want) => { a.subtype(want, path, out); b.subtype(want, path, out); },
      (got, Either(a, b)) => {
        let mut left = vec![];
        let mut right = vec![];
        got.subtype(a, path, &mut left);
        got.subtype(b, path, &mut right);
        if !left.is_empty() && !right.is_empty() {
          mismatch(out, path, "type matches neither result alternative");
        }
      },
      (Option(a), Option(b)) | (List(a), List(b)) => a.subtype(b, path, out),
      (a, Option(b)) if !a.optional() => a.subtype(b, path, out),
      (Record { fields: actual, .. }, Record { fields: expected, .. }) => {
        for (name, ty) in expected {
          let at = format!("{path}.{name}");
          match actual.get(name) {
            Some(got) => got.subtype(ty, &at, out),
            None if ty.optional() => {},
            None => mismatch(out, &at, "missing field"),
          }
        }
      },
      (Enum(a), Enum(b)) if a.iter().all(|case| b.contains(case)) => {},
      (Enum(_), String) => {},
      (Bool, Bool) | (S64, S64) | (U64, U64) | (F64, F64) | (String, String) | (Error, Error) | (StructType, StructType) => {},
      _ => mismatch(out, path, format!("{} is not a subtype of {}", self.describe(), required.describe())),
    }
  }

  pub fn check<S: Symbol>(&self, value: &Value<S>, path: &str, out: &mut Vec<Mismatch>) {
    match (self, value) {
      (Self::Unknown(reason), _) => mismatch(out, path, reason.clone()),
      (Self::Any, value) if data_value(value) => {},
      (Self::Error, Value::Error(_)) => {},
      (Self::Either(a, b), value) => {
        let mut left = vec![];
        let mut right = vec![];
        a.check(value, path, &mut left);
        b.check(value, path, &mut right);
        if !left.is_empty() && !right.is_empty() {
          mismatch(out, path, "value matches neither result alternative");
        }
      },
      (Self::StructType, Value::Type(ty)) if matches!(ty.as_ref(), Self::Record { .. }) => {},
      (Self::Bool, Value::Boolean(_)) | (Self::S64, Value::Integer(_)) |
      (Self::String, Value::String(_)) => {},
      (Self::U64, Value::Integer(n)) if *n >= 0 => {},
      (Self::F64, Value::Float(n)) if n.is_finite() => {},
      // JSON may encode a whole-valued f64 without a decimal point.
      (Self::F64, Value::Integer(n)) if n.unsigned_abs() <= (1u64 << 53) => {},
      (Self::Option(_), Value::Nil) => {},
      (Self::Option(ty), v) => ty.check(v, path, out),
      (Self::List(ty), Value::List(items)) => {
        for (i, item) in items.items.iter().enumerate() { ty.check(item, &format!("{path}[{i}]"), out); }
      },
      (Self::Record { fields, .. }, Value::Map(map)) => {
        for (name, ty) in fields {
          let at = format!("{path}.{name}");
          match map.get(name) {
            Some(value) => ty.check(value, &at, out),
            None if ty.optional() => {},
            None => mismatch(out, &at, "missing field"),
          }
        }
      },
      (Self::Enum(cases), Value::String(case)) if cases.iter().any(|c| c == case) => {},
      _ => mismatch(out, path, format!("expected {}, got {:?}", self.describe(), value.as_type())),
    }
  }
}

fn data_value<S: Symbol>(value: &Value<S>) -> bool {
  match value {
    Value::Nil | Value::Boolean(_) | Value::Integer(_) | Value::String(_) => true,
    Value::Float(n) => n.is_finite(),
    Value::List(l) => l.items.iter().all(data_value),
    Value::Map(m) => m.values().all(data_value),
    _ => false,
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParamKind { Positional, Named, Variadic }
#[derive(Clone, Debug)]
pub struct Parameter {
  pub name: String,
  pub kind: ParamKind,
  pub ty: TypeExpr,
  pub default: Option<serde_json::Value>,
  /// Declarative source for a call-time default; the executable AST belongs
  /// to its lexical closure, never to native/provider metadata.
  pub default_expression: Option<String>,
}
impl Parameter {
  pub fn required(&self) -> bool { self.default.is_none() && self.default_expression.is_none() && !self.ty.optional() && self.kind != ParamKind::Variadic }
}
#[derive(Clone, Debug)]
pub struct Signature {
  pub params: Vec<Parameter>,
  pub result: TypeExpr,
}
impl Signature {
  pub fn describe(&self) -> serde_json::Value {
    serde_json::json!({"parameters":self.params.iter().map(|p| serde_json::json!({"name":p.name,"kind":match p.kind { ParamKind::Named => "named", ParamKind::Positional => "positional", ParamKind::Variadic => "variadic" },"type":p.ty.describe(),"required":p.required(),"default":p.default,"default_expression":p.default_expression})).collect::<Vec<_>>(),"result":self.result.describe()})
  }
  pub fn check_metadata(&self, path: &str, out: &mut Vec<Mismatch>) {
    let valid_result = match &self.result {
      TypeExpr::Either(ok, failure) => !ok.contains_either() && **failure == TypeExpr::Error,
      ty => !ty.contains_either(),
    };
    if !valid_result { mismatch(out, &format!("{path}.result"), "either is supported only as a whole (either T error) result"); }
    self.result.subtype(&self.result, &format!("{path}.result"), out);
    let mut names = std::collections::HashSet::new();
    for (index, param) in self.params.iter().enumerate() {
      let at = format!("{path}.parameters.{}", param.name);
      if param.ty.contains_either() { mismatch(out, &at, "either is supported only in return position"); }
      if !names.insert(&param.name) { mismatch(out, &at, "duplicate parameter in descriptor"); }
      if param.kind == ParamKind::Variadic && index + 1 != self.params.len() { mismatch(out, &at, "variadic parameter must be last"); }
      param.ty.subtype(&param.ty, &at, out);
      if param.default.is_some() && param.default_expression.is_some() {
        mismatch(out, &at, "parameter cannot have both a value and expression default");
      }
      if let Some(default) = &param.default {
        param.ty.check(&crate::json_to_value::<string_interner::symbol::SymbolU32>(default.clone()), &format!("{at}.default"), out);
      }
    }
  }
  pub fn conforms(&self, required: &Self, path: &str, out: &mut Vec<Mismatch>) {
    self.check_metadata(path, out);
    for (index, want) in required.params.iter().enumerate() {
      let at = format!("{path}.parameters.{}", want.name);
      let got = self.params.iter().find(|p| p.name == want.name);
      let Some(got) = got else { mismatch(out, &at, "missing parameter"); continue; };
      if got.kind != want.kind || (want.kind != ParamKind::Named && self.params.get(index).map(|p| &p.name) != Some(&want.name)) {
        mismatch(out, &at, "parameter calling kind or position differs");
      }
      // The provider must accept every value the trait permits.
      want.ty.subtype(&got.ty, &at, out);
      if !want.required() && got.required() { mismatch(out, &at, "provider requires a parameter the trait allows omitting"); }
      let want_default = want.default.clone().or_else(|| want.ty.optional().then_some(serde_json::Value::Null));
      let got_default = got.default.clone().or_else(|| got.ty.optional().then_some(serde_json::Value::Null));
      if want.default_expression.is_some() || (want_default.is_some() && (got.default_expression.is_some() || want_default != got_default)) {
        mismatch(out, &at, "default differs from trait contract or expression equivalence cannot be established");
      }
    }
    for got in &self.params {
      if got.required() && !required.params.iter().any(|p| p.name == got.name) {
        mismatch(out, &format!("{path}.parameters.{}", got.name), "extra required parameter");
      }
    }
    self.result.subtype(&required.result, &format!("{path}.result"), out);
  }

  /// Names arrive from syntax, never from the contents of string values.
  pub(crate) fn bind_inputs<S: Symbol>(&self, inputs: Vec<(Option<String>, Value<S>)>) -> Result<Vec<Option<Value<S>>>, RuntimeError> {
    let mut values: Vec<Option<Value<S>>> = vec![None; self.params.len()];
    let positional: Vec<usize> = self.params.iter().enumerate().filter(|(_, p)| p.kind != ParamKind::Named).map(|(i, _)| i).collect();
    let mut next = 0;
    for (name, value) in inputs {
      let index = match name {
        Some(name) => self.params.iter().position(|p| p.kind == ParamKind::Named && p.name == name)
          .ok_or_else(|| RuntimeError::Other(format!("unknown named argument {name}")))?,
        None => *positional.get(next).ok_or_else(|| RuntimeError::Other("too many positional arguments".into()))?,
      };
      if self.params[index].kind == ParamKind::Variadic {
        let slot = values[index].get_or_insert_with(|| Value::List(crate::List { items: vec![].into() }));
        if let Value::List(list) = slot { list.items.push(value); }
      } else {
        if values[index].is_some() { return Err(RuntimeError::Other(format!("duplicate argument {}", self.params[index].name))); }
        values[index] = Some(value);
        if self.params[index].kind == ParamKind::Positional { next += 1; }
      }
    }
    // Diagnose malformed calls and supplied values before executing defaults.
    for (param, value) in self.params.iter().zip(&values) {
      if let Some(value) = value {
        let mut errors = vec![];
        param.ty.check(value, &format!("arguments.{}", param.name), &mut errors);
        checked(errors)?;
      } else if param.required() {
        return Err(RuntimeError::Other(format!("missing argument {}", param.name)));
      }
    }
    Ok(values)
  }

  pub fn bind<S: Symbol>(&self, inputs: Vec<(Option<String>, Value<S>)>) -> Result<Vec<Value<S>>, RuntimeError> {
    let values = self.bind_inputs(inputs)?;
    let mut out = Vec::with_capacity(values.len());
    for (param, value) in self.params.iter().zip(values) {
      let value = match value {
        Some(value) => value,
        None if param.default_expression.is_some() => return Err(RuntimeError::Other(format!("arguments.{}: expression default requires its Lisp closure", param.name))),
        None => match &param.default {
          Some(value) => crate::json_to_value(value.clone()),
          None if param.ty.optional() => Value::Nil,
          None if param.kind == ParamKind::Variadic => Value::List(crate::List { items: vec![].into() }),
          None => return Err(RuntimeError::Other(format!("missing argument {}", param.name))),
        },
      };
      let mut errors = vec![];
      param.ty.check(&value, &format!("arguments.{}", param.name), &mut errors);
      checked(errors)?;
      out.push(value);
    }
    Ok(out)
  }
}

pub fn checked(errors: Vec<Mismatch>) -> Result<(), RuntimeError> {
  if errors.is_empty() { Ok(()) } else {
    Err(RuntimeError::Other(errors.iter().map(|e| format!("{}: {}", e.path, e.reason)).collect::<Vec<_>>().join("; ")))
  }
}
#[derive(Clone, Debug)]
pub struct TraitDef { pub name: String, pub methods: BTreeMap<String, Signature> }
impl TraitDef {
  pub fn describe(&self) -> serde_json::Value {
    serde_json::json!({"name":self.name,"methods":self.methods.iter().map(|(name,sig)| (name.clone(),sig.describe())).collect::<serde_json::Map<_,_>>()})
  }
  pub fn check<S: Symbol>(&self, module: &Module<S>) -> Vec<Mismatch> {
    let mut out = vec![];
    for (name, signature) in &self.methods {
      match module.signature(name) {
        Some(actual) => actual.conforms(signature, name, &mut out),
        None => mismatch(&mut out, name, "missing callable member"),
      }
    }
    out
  }
}
/// Module identity is cheap to mount. Command schemas are decoded once, only
/// when reflection or a member lookup needs them; imports do not copy opaque help.
#[derive(Clone)]
pub struct Module<S: Symbol> {
  pub name: String,
  /// Stable installed bundle id, independent of the user's mount alias.
  pub bundle_name: Option<String>,
  pub method_names: std::collections::BTreeSet<String>,
  methods: std::cell::OnceCell<BTreeMap<String, Rc<TypedNative<S>>>>,
  loader: Option<Rc<dyn Fn() -> BTreeMap<String, Rc<TypedNative<S>>>>>,
  /// Ordinary Lisp exports retain their lexical closures and checked signatures.
  pub exports: BTreeMap<String, Value<S>>,
}
impl<S: Symbol> Module<S> {
  pub fn new(name: String, methods: BTreeMap<String, Rc<TypedNative<S>>>) -> Self {
    Self { name, bundle_name: None, method_names: methods.keys().cloned().collect(), methods: methods.into(), loader: None, exports: BTreeMap::new() }
  }
  pub fn lazy(name: String, method_names: std::collections::BTreeSet<String>, loader: Rc<dyn Fn() -> BTreeMap<String, Rc<TypedNative<S>>>>) -> Self {
    Self { name, bundle_name: None, method_names, methods: std::cell::OnceCell::new(), loader: Some(loader), exports: BTreeMap::new() }
  }
  pub fn with_bundle_name(mut self, name: String) -> Self { self.bundle_name = Some(name); self }
  pub fn with_exports(mut self, exports: BTreeMap<String, Value<S>>) -> Self {
    self.method_names.extend(exports.keys().cloned());
    self.exports = exports;
    self
  }
  pub fn signature(&self, name: &str) -> Option<Signature> {
    match self.exports.get(name) {
      Some(Value::Function(crate::Function::Lambda(lambda))) => lambda.signature.clone().map(|mut signature| {
        // Reflection may establish a literal default's data equivalence without
        // executing it. Keep the closure's call-time defaults unchanged.
        for param in &mut signature.params {
          if let Some(value) = param.default_expression.as_deref().and_then(|source| serde_json::from_str::<serde_json::Value>(source).ok()) {
            param.default = Some(value);
            param.default_expression = None;
          }
        }
        signature
      }),
      Some(Value::Function(crate::Function::TypedNative(native))) => Some(native.signature.clone()),
      Some(_) => None,
      None => self.methods().get(name).map(|method| method.signature.clone()),
    }
  }
  pub fn methods(&self) -> &BTreeMap<String, Rc<TypedNative<S>>> {
    self.methods.get_or_init(|| self.loader.as_ref().expect("lazy module loader")())
  }
}
impl<S: Symbol> std::fmt::Debug for Module<S> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("Module").field("name", &self.name).field("methods", &self.method_names).finish()
  }
}
#[derive(Clone)]
pub struct TypedNative<S: Symbol> {
  pub name: String,
  pub signature: Signature,
  /// Receives arguments in declaration order, after binding and validation.
  pub body: NativeClosure<S>,
}
impl<S: Symbol> std::fmt::Debug for TypedNative<S> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("TypedNative").field("name", &self.name).field("signature", &self.signature).finish()
  }
}
impl<S: Symbol> TypedNative<S> {
  pub fn invoke(&self, env: Rc<RefCell<Env<S>>>, inputs: Vec<(Option<String>, Value<S>)>) -> Result<Value<S>, RuntimeError> {
    // Unknown metadata is diagnosed before any command side effect, including
    // when an optional unknown parameter happens to be supplied as nil.
    let mut metadata_errors = vec![];
    self.signature.check_metadata(&self.name, &mut metadata_errors);
    checked(metadata_errors)?;
    let args = self.signature.bind(inputs)?;
    let result = (self.body)(env, args)?;
    let mut errors = vec![];
    self.signature.result.check(&result, &format!("{}.result", self.name), &mut errors);
    checked(errors)?;
    Ok(result)
  }
}

/// Serialize data without silently turning a callable/module/type into null.
pub fn data_json<S: Symbol>(value: &Value<S>) -> Result<serde_json::Value, RuntimeError> {
  use serde_json::Value as J;
  Ok(match value {
    Value::Nil => J::Null,
    Value::Boolean(b) => J::Bool(*b),
    Value::Integer(n) => J::from(*n),
    Value::Float(n) => J::Number(serde_json::Number::from_f64(*n).ok_or_else(|| RuntimeError::Other("non-finite number is not JSON data".into()))?),
    Value::String(s) => J::String(s.to_string()),
    Value::List(l) => J::Array(l.items.iter().map(data_json).collect::<Result<_, _>>()?),
    Value::Map(m) => J::Object(m.iter().map(|(k,v)| Ok((k.clone(),data_json(v)?))).collect::<Result<_, RuntimeError>>()?),
    _ => return Err(RuntimeError::Other(format!("{:?} is not JSON data", value.as_type()))),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  fn record(name: &str, fields: Vec<(&str, TypeExpr)>) -> TypeExpr {
    TypeExpr::Record { name: name.into(), fields: fields.into_iter().map(|(k,v)| (k.into(),v)).collect() }
  }
  fn conforms(actual: &TypeExpr, expected: &TypeExpr) -> bool {
    let mut errors = vec![]; actual.subtype(expected, "result", &mut errors); errors.is_empty()
  }
  #[test]
  fn structural_names_extra_fields_option_list_and_enum() {
    let narrow = record("ProviderA", vec![("id", TypeExpr::String), ("extra", TypeExpr::Bool)]);
    let wide = record("ProviderB", vec![("id", TypeExpr::String)]);
    assert!(conforms(&narrow, &wide)); assert!(!conforms(&wide, &narrow));
    assert!(conforms(&TypeExpr::String, &TypeExpr::Option(Box::new(TypeExpr::String))));
    assert!(!conforms(&TypeExpr::Option(Box::new(TypeExpr::String)), &TypeExpr::String));
    assert!(conforms(&TypeExpr::List(Box::new(narrow)), &TypeExpr::List(Box::new(wide))));
    assert!(conforms(&TypeExpr::Enum(vec!["ok".into()]), &TypeExpr::Enum(vec!["ok".into(), "bad".into()])));
    assert!(!conforms(&TypeExpr::Any, &TypeExpr::String));
    assert!(!conforms(&TypeExpr::Unknown("no schema".into()), &TypeExpr::Any));
  }
  #[test]
  fn missing_optional_field_checks_as_nil_but_required_fields_still_fail() {
    let ty = record("R", vec![("at", TypeExpr::Option(Box::new(TypeExpr::S64)))]);
    let value: Value<string_interner::symbol::SymbolU32> = crate::json_to_value(serde_json::json!({}));
    let mut errors = vec![]; ty.check(&value, "result", &mut errors);
    assert!(errors.is_empty());
    assert!(conforms(&record("Old", vec![]), &ty));
    let required = record("Required", vec![("at", TypeExpr::S64)]);
    assert!(!conforms(&record("Old", vec![]), &required));
    required.check(&value, "result", &mut errors);
    assert_eq!(errors[0].path, "result.at");
    errors.clear();
    ty.check(&crate::json_to_value::<string_interner::symbol::SymbolU32>(serde_json::json!({"at":null})), "result", &mut errors);
    assert!(errors.is_empty());
  }
  #[test]
  fn invalid_metadata_rejects_before_native_dispatch() {
    type S = string_interner::symbol::SymbolU32;
    let calls = Rc::new(std::cell::Cell::new(0));
    let invoked = calls.clone();
    let body: NativeClosure<S> = Rc::new(move |_, _| {
      invoked.set(invoked.get() + 1);
      Ok(Value::Nil)
    });
    let mut signature = Signature {
      params: vec![Parameter { name: "optional".into(), kind: ParamKind::Named,
        ty: TypeExpr::Option(Box::new(TypeExpr::Unknown("missing schema".into()))), default: None, default_expression: None }],
      result: TypeExpr::Option(Box::new(TypeExpr::String)),
    };
    let mut interpreter = crate::Interpreter::<S, string_interner::backend::StringBackend>::new();
    let env = interpreter.default_env();
    let method = TypedNative { name: "source.accounts".into(), signature: signature.clone(), body: body.clone() };
    assert!(method.invoke(env.clone(), vec![]).unwrap_err().to_string().contains("missing schema"));
    signature.params[0].ty = TypeExpr::Bool;
    signature.params[0].default = Some(serde_json::json!("false"));
    let method = TypedNative { name: "source.accounts".into(), signature, body };
    assert!(method.invoke(env, vec![]).unwrap_err().to_string().contains("default"));
    assert_eq!(calls.get(), 0);
  }
  #[test]
  fn deferred_defaults_cannot_impersonate_data_contracts() {
    let required = Signature { params: vec![Parameter {
      name: "refresh".into(), kind: ParamKind::Named, ty: TypeExpr::Bool,
      default: Some(serde_json::json!(false)), default_expression: None,
    }], result: TypeExpr::Bool };
    let mut deferred = required.clone();
    deferred.params[0].default = None;
    deferred.params[0].default_expression = Some("(get-current-refresh)".into());
    assert!(!deferred.params[0].required());
    let mut errors = vec![];
    deferred.conforms(&required, "accounts", &mut errors);
    assert!(errors.iter().any(|e| e.reason.contains("expression equivalence")));
    assert!(deferred.bind::<string_interner::symbol::SymbolU32>(vec![]).unwrap_err().to_string().contains("requires its Lisp closure"));
    deferred.params[0].default = Some(serde_json::json!(false));
    errors.clear();
    deferred.check_metadata("accounts", &mut errors);
    assert!(errors.iter().any(|e| e.reason.contains("both a value and expression")));
  }

  #[test]
  fn method_variance_defaults_and_extra_required_arguments() {
    let required = Signature { params: vec![Parameter { name:"host".into(),kind:ParamKind::Named,ty:TypeExpr::String,default:None,default_expression:None }], result:TypeExpr::Option(Box::new(TypeExpr::String)) };
    let mut actual = required.clone(); actual.params[0].ty = TypeExpr::Option(Box::new(TypeExpr::String)); actual.result = TypeExpr::String;
    let mut errors = vec![]; actual.conforms(&required,"accounts",&mut errors); assert!(errors.is_empty());
    required.conforms(&actual,"accounts",&mut errors); assert!(!errors.is_empty());
    errors.clear(); actual.params.push(Parameter { name:"extra".into(),kind:ParamKind::Named,ty:TypeExpr::Bool,default:None,default_expression:None });
    actual.conforms(&required,"accounts",&mut errors); assert!(errors.iter().any(|e| e.reason == "extra required parameter"));
    errors.clear(); actual.params[1].default=Some(serde_json::json!(false));
    actual.conforms(&required,"accounts",&mut errors); assert!(errors.is_empty());
  }
}
