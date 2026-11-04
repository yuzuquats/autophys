//! Syntax-facing structural declarations and reflection.
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};
use crate::{Backend, Env, Interpreter, List, RuntimeError, Symbol, Value};
use crate::types::{checked, ParamKind, Parameter, Signature, TraitDef, TypeExpr};

pub type ModuleDiscovery<S> = Rc<dyn Fn() -> Result<Vec<(String, Value<S>)>, RuntimeError>>;

impl<S: Symbol + std::fmt::Debug + 'static, B: Backend<S>> Interpreter<S, B> {
  pub fn set_module_discovery(&mut self, hook: ModuleDiscovery<S>) { self.module_discovery = Some(hook); }

  pub(crate) fn syntax_name(&self, value: &Value<S>) -> Result<String, RuntimeError> {
    match value {
      Value::Symbol(sym) => Ok(self.interner.resolve(sym.as_symbol()).unwrap_or("").to_string()),
      _ => Err(RuntimeError::Other("expected a symbol in type declaration".into())),
    }
  }
  pub(crate) fn type_expression(&self, env: &Rc<RefCell<Env<S>>>, value: &Value<S>) -> Result<TypeExpr, RuntimeError> {
    match value {
      Value::Type(ty) => Ok((**ty).clone()),
      Value::Symbol(sym) => match env.borrow().get(sym.as_symbol()) {
        Some(Value::Type(ty)) => Ok((*ty).clone()),
        _ => Err(RuntimeError::Other(format!("unknown type {}", self.syntax_name(value)?))),
      },
      Value::List(list) if !list.items.is_empty() => {
        let name = self.syntax_name(&list.items[0])?;
        match (name.as_str(), &list.items[1..]) {
          ("option", [inner]) => Ok(TypeExpr::Option(Box::new(self.type_expression(env, inner)?))),
          ("list", [inner]) => Ok(TypeExpr::List(Box::new(self.type_expression(env, inner)?))),
          ("enum", cases) if !cases.is_empty() => {
            let mut names = vec![];
            for case in cases {
              let Value::String(name) = case else { return Err(RuntimeError::Other("enum cases must be string literals".into())); };
              if names.iter().any(|n| n == name) { return Err(RuntimeError::Other(format!("duplicate enum case {name}"))); }
              names.push(name.to_string());
            }
            Ok(TypeExpr::Enum(names))
          },
          _ => Err(RuntimeError::Other(format!("invalid type expression {name}"))),
        }
      },
      _ => Err(RuntimeError::Other("expected a type expression".into())),
    }
  }

  fn return_type_expression(&self, env: &Rc<RefCell<Env<S>>>, value: &Value<S>) -> Result<TypeExpr, RuntimeError> {
    if let Value::List(list) = value {
      if let [head, ok, failure] = list.items.as_slice() {
        if self.syntax_name(head).ok().as_deref() == Some("either") {
          let failure = self.type_expression(env, failure)?;
          if failure != TypeExpr::Error {
            return Err(RuntimeError::Other("either result requires error as its second alternative".into()));
          }
          return Ok(TypeExpr::Either(Box::new(self.type_expression(env, ok)?), Box::new(failure)));
        }
      }
    }
    self.type_expression(env, value)
  }

  pub(crate) fn parse_signature(
    &mut self, env: Rc<RefCell<Env<S>>>, name: &str,
    params: &[Value<S>], result: &Value<S>,
  ) -> Result<Signature, RuntimeError> {
    let (mut signature, defaults) = self.parse_signature_expressions(env.clone(), name, params, result)?;
    // Trait defaults are data contracts, not executable user-function bodies.
    for (param, expression) in signature.params.iter_mut().zip(defaults) {
      if let Some(expression) = expression {
        let value = self.eval_expression(env.clone(), &expression)?;
        let mut errors = vec![];
        param.ty.check(&value, &format!("{name}.{}.default", param.name), &mut errors);
        checked(errors)?;
        param.default = Some(crate::types::data_json(&value)?);
        param.default_expression = None;
      }
    }
    Ok(signature)
  }

  fn parse_signature_expressions(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    name: &str,
    params: &[Value<S>],
    result: &Value<S>,
  ) -> Result<(Signature, Vec<Option<Value<S>>>), RuntimeError> {
    let mut parameters: Vec<Parameter> = vec![];
    let mut defaults = vec![];
    let mut i = 0;
    while i < params.len() {
      let param_name = self.syntax_name(&params[i])?;
      let (param_name, kind) = match param_name.strip_suffix(':') {
        Some(name) if !name.is_empty() => (name.to_string(), ParamKind::Named),
        _ => match param_name.strip_prefix("...") {
          Some(name) if !name.is_empty() => (name.to_string(), ParamKind::Variadic),
          _ => (param_name, ParamKind::Positional),
        },
      };
      let implicit_self = i == 0 && param_name == "self" && kind == ParamKind::Positional
        && (params.get(i + 1).is_none() || params.get(i + 1).and_then(|p| self.syntax_name(p).ok()).is_some_and(|name| name.ends_with(':')));
      let ty = if implicit_self {
        i += 1;
        TypeExpr::Any
      } else {
        let ty = self.type_expression(&env, params.get(i + 1).ok_or_else(|| RuntimeError::Other(format!("missing type for {param_name}")))?)?;
        i += 2;
        ty
      };
      let default = if params.get(i).is_some_and(|v| self.syntax_name(v).ok().as_deref() == Some("=")) {
        let expression = params.get(i + 1).ok_or_else(|| RuntimeError::Other("missing default expression".into()))?;
        i += 2;
        Some(expression.clone())
      } else { None };
      if parameters.iter().any(|p| p.name == param_name) { return Err(RuntimeError::Other(format!("duplicate parameter {param_name}"))); }
      parameters.push(Parameter { name: param_name, kind, ty, default: None,
        default_expression: default.as_ref().map(|value| self.default_source(value)) });
      defaults.push(default);
    }
    let signature = Signature { params: parameters, result: self.return_type_expression(&env, result)? };
    let mut errors = vec![];
    signature.check_metadata(name, &mut errors);
    checked(errors)?;
    Ok((signature, defaults))
  }

  /// Describe a default without running it; preserve strings as quoted syntax.
  fn default_source(&self, value: &Value<S>) -> String {
    match value {
      Value::String(text) => serde_json::to_string(text.as_str()).expect("string serialization"),
      Value::Float(number) => serde_json::to_string(number).expect("float serialization"),
      Value::List(list) => format!("({})", list.items.iter().map(|v| self.default_source(v)).collect::<Vec<_>>().join(" ")),
      Value::Map(map) => format!("{{{}}}", map.iter().map(|(k,v)| format!("{} {}", serde_json::to_string(k).expect("string key"), self.default_source(v))).collect::<Vec<_>>().join(" ")),
      _ => self.format_value(value),
    }
  }

  /// The result arrow explicitly selects typed parameter syntax. Without it,
  /// preserve legacy parameter parsing and body evaluation.
  pub(crate) fn user_lambda(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    name: &str,
    parameters: &[Value<S>],
    body: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    let typed = body.first().is_some_and(|v| self.syntax_name(v).ok().as_deref() == Some("->"));
    let (params, signature, defaults, body) = if typed {
      if body.len() < 3 {
        return Err(RuntimeError::Other("typed function needs -> Result and a body".into()));
      }
      let (signature, defaults) = self.parse_signature_expressions(env.clone(), name, parameters, &body[1])?;
      let params = signature.params.iter().map(|p| self.interner.get_or_intern(&p.name)).collect();
      (params, Some(signature), defaults, &body[2..])
    } else {
      let params = parameters.iter().map(|p| match p {
        Value::Symbol(s) => Ok(s.as_symbol()),
        _ => Err(RuntimeError::TypeError { expected: "Symbol".into(), got: format!("{:?}", p.as_type()) }),
      }).collect::<Result<Vec<_>, _>>()?;
      (params, None, vec![], body)
    };
    for param in &params {
      self.check_internal_binding(*param)?;
    }
    // The closure may read any binding it can reach, now or after the
    // scope's lambda has returned: none of them may be released early.
    crate::eval::mark_observed(&env);
    Ok(Value::Function(crate::Function::Lambda(Rc::new(crate::Lambda {
      params, signature, defaults, body: body.to_vec(), captured_env: Some(env),
    }))))
  }

  pub(crate) fn structural_declaration(
    &mut self,
    kind: &str,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    let Some(Value::Symbol(symbol)) = args.first() else { return Err(RuntimeError::Other(format!("{kind} requires a name"))); };
    self.check_binding(symbol.as_symbol())?;
    let name = self.syntax_name(&args[0])?;
    let value = match kind {
      "type" => {
        if args.len() != 2 { return Err(RuntimeError::Other("type requires a name and type expression".into())); }
        if let Value::Symbol(source) = &args[1] {
          let source = env.borrow().get(source.as_symbol());
          if let Some(value @ Value::Type(_)) = source {
            env.borrow_mut().define(symbol.as_symbol(), value.clone());
            return Ok(value);
          }
        }
        Value::Type(Rc::new(self.type_expression(&env, &args[1])?))
      },
      "struct" => {
        let mut fields = BTreeMap::new();
        if (args.len() - 1) % 2 != 0 { return Err(RuntimeError::Other("struct fields use name: Type pairs".into())); }
        for pair in args[1..].chunks(2) {
          let field = self.syntax_name(&pair[0])?;
          let field = field.strip_suffix(':').filter(|s| !s.is_empty()).ok_or_else(|| RuntimeError::Other("struct fields require trailing-colon names".into()))?;
          if fields.insert(field.to_string(), self.type_expression(&env, &pair[1])?).is_some() { return Err(RuntimeError::Other(format!("duplicate field {field}"))); }
        }
        let owner = self.interner.get("__module_bundle").and_then(|s| env.borrow().get(s));
        let owner = match owner { Some(Value::String(owner)) => Some(owner.to_string()), _ => None };
        let key = (owner.clone(), name.clone());
        let mut ty = Rc::new(TypeExpr::Record { name, fields });
        let mut registry = self.record_shapes.borrow_mut();
        if let Some(previous) = registry.types.get(&key) {
          if owner.is_some() {
            if previous.as_ref() != ty.as_ref() {
              return Err(RuntimeError::Other(format!("struct {}.{} changed its registered definition", owner.as_deref().unwrap(), key.1)));
            }
            ty = previous.clone();
          }
        }
        if let TypeExpr::Record { fields, .. } = ty.as_ref() {
          if let Some(TypeExpr::Enum(cases)) = fields.get("shape") {
            if let [shape] = cases.as_slice() {
              if let Some(previous) = registry.shapes.get(shape) {
                if previous != &key {
                  return Err(RuntimeError::Other(format!(
                    "struct shape {shape} belongs to {}.{}, cannot register for {}.{}",
                    previous.0.as_deref().unwrap_or("<REPL>"), previous.1,
                    owner.as_deref().unwrap_or("<REPL>"), key.1,
                  )));
                }
              }
            }
          }
        }
        registry.shapes.retain(|_, registered| registered != &key);
        if let TypeExpr::Record { fields, .. } = ty.as_ref() {
          if let Some(TypeExpr::Enum(cases)) = fields.get("shape") {
            if let [shape] = cases.as_slice() { registry.shapes.insert(shape.clone(), key.clone()); }
          }
        }
        registry.types.insert(key, ty.clone());
        Value::Type(ty)
      }
      "trait" => {
        let mut methods = BTreeMap::new();
        for method in &args[1..] {
          let Value::List(method) = method else { return Err(RuntimeError::Other("trait members must be fn signatures".into())); };
          let [head, method_name, Value::List(params), arrow, result] = method.items.as_slice() else {
            return Err(RuntimeError::Other("trait method syntax: (fn name (arg: Type) -> Result)".into()));
          };
          if self.syntax_name(head)? != "fn" || self.syntax_name(arrow)? != "->" { return Err(RuntimeError::Other("expected fn signature and -> result".into())); }
          let method_name = self.syntax_name(method_name)?;
          let signature = self.parse_signature(env.clone(), &method_name, &params.items, result)?;
          if methods.insert(method_name.clone(), signature).is_some() { return Err(RuntimeError::Other(format!("duplicate method {method_name}"))); }
        }
        if methods.is_empty() { return Err(RuntimeError::Other("trait requires at least one method".into())); }
        Value::Trait(Rc::new(TraitDef { name, methods }))
      },
      _ => unreachable!(),
    };
    env.borrow_mut().define(symbol.as_symbol(), value.clone());
    Ok(value)
  }

  pub(crate) fn named_inputs(&mut self, env: Rc<RefCell<Env<S>>>, args: &[Value<S>]) -> Result<Vec<(Option<String>, Value<S>)>, RuntimeError> {
    let mut inputs = vec![];
    let mut i = 0;
    while i < args.len() {
      let keyword = match &args[i] {
        Value::Symbol(_) => self.syntax_name(&args[i])?.strip_suffix(':').filter(|s| !s.is_empty()).map(str::to_string),
        _ => None,
      };
      if let Some(name) = keyword {
        let expression = args.get(i + 1).ok_or_else(|| RuntimeError::Other(format!("missing value after {name}:")))?;
        inputs.push((Some(name), self.eval_expression(env.clone(), expression)?));
        i += 2;
      } else {
        inputs.push((None, self.eval_expression(env.clone(), &args[i])?));
        i += 1;
      }
    }
    Ok(inputs)
  }

  pub(crate) fn construct_struct(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    ty: &Rc<TypeExpr>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    let TypeExpr::Record { fields, .. } = ty.as_ref() else {
      return Err(RuntimeError::Other(
        "only record types are callable constructors".into(),
      ));
    };
    let params = fields
      .iter()
      .map(|(name, field)| {
        let default = match (name.as_str(), field) {
          ("shape", TypeExpr::Enum(cases)) if cases.len() == 1 => Some(serde_json::json!(cases[0])),
          _ => None,
        };
        Parameter {
          name: name.clone(),
          kind: ParamKind::Named,
          ty: field.clone(),
          default,
          default_expression: None,
        }
      })
      .collect();
    let signature = Signature {
      params,
      result: (**ty).clone(),
    };
    let inputs = self.named_inputs(env, args)?;
    let values = signature.bind(inputs)?;
    Ok(Value::Map(
      crate::Shared::new(
        fields
          .keys()
          .cloned()
          .zip(values)
          .collect::<indexmap::IndexMap<_, _>>(),
      )
      .with_record_type(ty.clone()),
    ))
  }

  pub(crate) fn structural_reflection(
    &mut self,
    operation: &str,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if operation == "module.bundle" && args.is_empty() {
      return self
        .interner
        .get("__module_bundle")
        .and_then(|symbol| env.borrow().get(symbol))
        .ok_or_else(|| {
          RuntimeError::Other("module.bundle with no argument requires a bundle module body".into())
        });
    }
    let expected = if matches!(operation, "trait.conforms" | "trait.check") { 2 } else { 1 };
    if args.len() != expected { return Err(RuntimeError::Other(format!("{operation} takes {expected} arguments"))); }
    let first = self.eval_expression(env.clone(), &args[0])?;
    if operation == "module.name" || operation == "module.bundle" {
      return match first {
        Value::Module(module) if operation == "module.bundle" => Ok(module.bundle_name.as_deref().map(|name| Value::String(name.into())).unwrap_or(Value::Nil)),
        Value::Module(module) => Ok(Value::String(module.name.as_str().into())),
        _ => Err(RuntimeError::Other(format!("{operation} requires a module value"))),
      };
    }
    let Value::Trait(trait_def) = first else { return Err(RuntimeError::Other(format!("{operation} requires a trait value as its first argument"))); };
    if operation == "trait.describe" { return Ok(crate::json_to_value(trait_def.describe())); }
    if matches!(operation, "trait.conforms" | "trait.check") {
      let source = self.eval_expression(env.clone(), &args[1])?;
      let implementations = self.trait_impls.borrow();
      let modules: Vec<_> = implementations
        .iter()
        .filter(|entry| Rc::ptr_eq(&entry.trait_def, &trait_def))
        .filter(|entry| match &source {
          Value::Type(ty) => Rc::ptr_eq(ty, &entry.ty),
          Value::Map(record) => record
            .record_type()
            .is_some_and(|ty| Rc::ptr_eq(ty, &entry.ty)),
          // A module keeps its explicit method contract even when it also
          // exports a struct that has a separate nominal implementation.
          Value::Module(module) => module.exports.values().any(|value|
            matches!(value, Value::Module(export) if Rc::ptr_eq(export, &entry.module))),
          _ => false,
        })
        .map(|entry| entry.module.clone())
        .collect();
      let errors = if !modules.is_empty() {
        modules
          .iter()
          .flat_map(|module| trait_def.check(module))
          .collect()
      } else if let Value::Module(module) = source {
        trait_def.check(&module)
      } else {
        vec![crate::types::Mismatch {
          path: trait_def.name.clone(),
          reason: "no registered impl for this struct".into(),
        }]
      };
      return Ok(if operation == "trait.conforms" { Value::Boolean(errors.is_empty()) }
        else if errors.is_empty() { Value::String("ok".into()) } else { diagnostics(errors) });
    }
    // Discovery returns definitions, not provider results. Failures propagate.
    if let Some(discover) = self.module_discovery.clone() {
      let root = Env::root_of(&env);
      for (name, value) in discover()? {
        let symbol = self.interner.get_or_intern(name);
        root.borrow_mut().define(symbol, value);
      }
    }
    let mut modules = BTreeMap::new();
    for entry in self
      .trait_impls
      .borrow()
      .iter()
      .filter(|entry| Rc::ptr_eq(&entry.trait_def, &trait_def))
    {
      modules.insert(entry.module.name.clone(), entry.module.clone());
    }
    for value in env.borrow().visible_values() {
      if let Value::Module(module) = value { modules.insert(module.name.clone(), module); }
    }
    let mut items = vec![];
    for module in modules.into_values() {
      if !trait_def.methods.keys().any(|name| module.method_names.contains(name)) { continue; }
      let errors = trait_def.check(&module);
      if operation == "trait.impls" {
        if errors.is_empty() { items.push(Value::Module(module)); }
      } else if trait_def.methods.keys().any(|name| module.method_names.contains(name)) {
        items.push(Value::Map([
          ("name".into(), Value::String(module.name.as_str().into())),
          ("conforms".into(), Value::Boolean(errors.is_empty())),
          ("errors".into(), diagnostics(errors)),
        ].into_iter().collect()));
      }
    }
    Ok(Value::List(List { items: items.into() }))
  }
}
fn diagnostics<S: Symbol>(errors: Vec<crate::types::Mismatch>) -> Value<S> {
  crate::json_to_value(serde_json::Value::Array(errors.into_iter().map(|e| serde_json::json!({"path":e.path,"reason":e.reason})).collect()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{Runtime, types::{Module, TypedNative}};
  use std::cell::Cell;
  use string_interner::{backend::StringBackend, symbol::SymbolU32};
  type S = SymbolU32;
  type I = Interpreter<S, StringBackend>;
  fn eval(interp: &mut I, env: &Rc<RefCell<Env<S>>>, source: &str) -> Result<Value<S>, String> {
    let asts = Runtime::<S>::parse(None, source, interp.string_interner()).map_err(|e| format!("{e:?}"))?;
    let mut last = Value::Nil;
    for ast in asts {
      last = interp.eval_expression(env.clone(), &Value::from_owned_sexpression(ast).unwrap()).map_err(|e| e.to_string())?;
    }
    Ok(last)
  }
  fn mount(interp: &mut I, env: &Rc<RefCell<Env<S>>>, name: &str, signature: Signature, body: crate::NativeClosure<S>) {
    let module = Module::new(name.into(), [("accounts".into(), Rc::new(TypedNative { name: format!("{name}.accounts"), signature, body }))].into_iter().collect());
    let symbol = interp.string_interner().get_or_intern(name);
    env.borrow_mut().define(symbol, Value::Module(Rc::new(module)));
  }
  fn declaration(interp: &mut I, env: &Rc<RefCell<Env<S>>>) -> Rc<TraitDef> {
    let value = eval(interp, env, r#"
      (struct Window used: f64 resets: (option s64))
      (struct Report provider: string usage: (list Window))
      (trait AccountSource (fn accounts (hosts: (option string) refresh: bool = false) -> Report))
    "#).unwrap();
    let Value::Trait(def) = value else { panic!("trait value"); };
    def
  }
  #[test]
  fn structural_type_arrow_is_not_a_shell_redirection() {
    for source in [
      "(trait Source (fn accounts (refresh: bool = false) -> string))",
      "(bundle (m) (trait Source (fn accounts () -> string)) (m.export 'status))",
    ] { assert!(!crate::bash_paren_statement(source), "{source}"); }
    assert!(crate::bash_paren_statement("(echo ->file)"));
  }
  #[test]
  fn structural_checked_dynamic_calls_and_reflection() {
    let mut i = I::new(); let env = i.default_env();
    let def = declaration(&mut i, &env);
    let calls = Rc::new(Cell::new(0)); let called = calls.clone();
    mount(&mut i, &env, "independent", def.methods["accounts"].clone(), Rc::new(move |_, args| {
      called.set(called.get() + 1);
      assert!(matches!(&args[0], Value::String(s) if s == "--help"));
      assert!(matches!(args[1], Value::Boolean(false)));
      Ok(crate::json_to_value(serde_json::json!({"provider":"other","usage":[{"used":25,"resets":null}],"extra":true})))
    }));
    assert!(matches!(eval(&mut i, &env, "(trait.conforms AccountSource independent)").unwrap(), Value::Boolean(true)));
    assert!(matches!(eval(&mut i, &env, "(trait.check AccountSource independent)").unwrap(), Value::String(s) if s == "ok"));
    assert_eq!(calls.get(), 0, "reflection must not execute bodies");
    let result = eval(&mut i, &env, r#"(let src (first (trait.impls AccountSource))) (src.accounts hosts: "--help")"#).unwrap();
    assert!(matches!(result, Value::Map(_)));
    assert_eq!(calls.get(), 1);
    assert!(matches!(eval(&mut i, &env, "(module.name src)").unwrap(), Value::String(s) if s == "independent"));
    let describe = eval(&mut i, &env, "(trait.describe AccountSource)").unwrap();
    assert!(matches!(describe, Value::Map(_)));
    for source in ["(src.accounts unknown: 1)", "(src.accounts refresh: true refresh: false)", "(src.accounts refresh: 1)"] {
      assert!(eval(&mut i, &env, source).is_err(), "{source}");
    }
    assert_eq!(calls.get(), 1, "bad arguments must not execute bodies");
  }
  #[test]
  fn lying_provider_fails_at_nested_result_path() {
    let mut i = I::new(); let env = i.default_env();
    let def = declaration(&mut i, &env);
    mount(&mut i, &env, "liar", def.methods["accounts"].clone(), Rc::new(|_, _| Ok(crate::json_to_value(serde_json::json!({"provider":"liar","usage":[{"used":"unknown","resets":null}]})))));
    let error = eval(&mut i, &env, "(liar.accounts)").unwrap_err();
    assert!(error.contains("liar.accounts.result.usage[0].used"), "{error}");
  }
  #[test]
  fn constructors_type_aliases_and_defaults_check_values() {
    let mut i = I::new(); let env = i.default_env();
    let v = eval(&mut i, &env, r#"(type Labels (list string)) (struct Report labels: Labels at: (option s64)) (Report labels: (list "x"))"#).unwrap();
    assert_eq!(crate::types::data_json(&v).unwrap(), serde_json::json!({"labels":["x"],"at":null}));
    assert!(eval(&mut i, &env, "(Report labels: (list 42))").unwrap_err().contains("arguments.labels[0]"));
    assert!(eval(&mut i, &env, "(trait Wrong (fn f (a: bool = 1) -> string))").unwrap_err().contains("f.a.default"));
    assert!(eval(&mut i, &env, "(struct Dup a: string a: string)").is_err());
  }
  #[test]
  fn arguments_evaluate_once_and_strings_are_not_keyword_markers() {
    let mut i = I::new(); let env = i.default_env();
    let def = declaration(&mut i, &env);
    mount(&mut i, &env, "source", def.methods["accounts"].clone(), Rc::new(|_, _| Ok(crate::json_to_value(serde_json::json!({"provider":"source","usage":[]})))));
    let v = eval(&mut i, &env, r#"(let n 0) (source.accounts hosts: (begin (set n (+ n 1)) "fleet")) n"#).unwrap();
    assert!(matches!(v, Value::Integer(1)));
    assert!(eval(&mut i, &env, r#"(source.accounts "hosts:" "fleet")"#).unwrap_err().contains("positional"));
  }
  #[test]
  fn near_misses_stay_in_report() {
    let mut i = I::new(); let env = i.default_env();
    let def = declaration(&mut i, &env);
    let mut sig = def.methods["accounts"].clone(); sig.result = TypeExpr::Any;
    mount(&mut i, &env, "near", sig, Rc::new(|_, _| panic!("inspection executed body")));
    assert!(matches!(eval(&mut i, &env, "(trait.impls AccountSource)").unwrap(), Value::List(l) if l.items.is_empty()));
    let Value::List(report) = eval(&mut i, &env, "(trait.report AccountSource)").unwrap() else { panic!(); };
    assert_eq!(report.items.len(), 1);
    let Value::Map(row) = &report.items[0] else { panic!(); };
    assert!(matches!(row["conforms"], Value::Boolean(false)));
  }
}
