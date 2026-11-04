//! Nominal dispatch layered on the existing structural record and module contracts.
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

use crate::types::{Module, TraitDef, TypeExpr, checked};
use crate::{Backend, Env, Function, Interpreter, Lambda, List, RuntimeError, Symbol, Value};

#[derive(Clone)]
pub(crate) struct StructImpl<S: Symbol> {
  pub trait_def: Rc<TraitDef>,
  pub ty: Rc<TypeExpr>,
  pub module: Rc<Module<S>>,
  /// Unevaluated method syntax, including literal kinds and interned symbols.
  declaration: String,
}

/// Nominal types belong to a bundle and a declaration name, not an install path.
#[derive(Clone, Default)]
pub(crate) struct RecordRegistry {
  pub types: BTreeMap<(Option<String>, String), Rc<TypeExpr>>,
  pub shapes: BTreeMap<String, (Option<String>, String)>,
}

/// Opaque snapshot used by bundle hosts to roll back a failed initialization.
pub struct DeclarationCheckpoint<S: Symbol> {
  implementations: Vec<StructImpl<S>>,
  shapes: RecordRegistry,
}

impl<S: Symbol + std::fmt::Debug + 'static, B: Backend<S>> Interpreter<S, B> {
  pub fn declaration_checkpoint(&self) -> DeclarationCheckpoint<S> {
    DeclarationCheckpoint {
      implementations: self.trait_impls.borrow().clone(),
      shapes: self.record_shapes.borrow().clone(),
    }
  }

  pub fn restore_declarations(&mut self, checkpoint: DeclarationCheckpoint<S>) {
    *self.trait_impls.borrow_mut() = checkpoint.implementations;
    *self.record_shapes.borrow_mut() = checkpoint.shapes;
  }

  pub(crate) fn special_impl(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    let [trait_name, marker, struct_name, methods @ ..] = args else {
      return Err(RuntimeError::Other(
        "impl syntax: (impl Trait for Struct (fn method (self …) -> Type …))".into(),
      ));
    };
    if self.syntax_name(marker)? != "for" {
      return Err(RuntimeError::Other("impl requires `for Struct`".into()));
    }
    let Value::Trait(trait_def) = self.eval_expression(env.clone(), trait_name)? else {
      return Err(RuntimeError::Other("impl requires a trait".into()));
    };
    let Value::Type(ty) = self.eval_expression(env.clone(), struct_name)? else {
      return Err(RuntimeError::Other("impl requires a struct type".into()));
    };
    let TypeExpr::Record { name, .. } = ty.as_ref() else {
      return Err(RuntimeError::Other("impl requires a struct type".into()));
    };
    let bundle = self
      .interner
      .get("__module_bundle")
      .and_then(|s| env.borrow().get(s));
    let bundle = match bundle {
      Some(Value::String(bundle)) => Some(bundle.to_string()),
      _ => None,
    };
    let declaration = format!("{methods:?}");
    let previous = self
      .trait_impls
      .borrow()
      .iter()
      .find(|entry| Rc::ptr_eq(&entry.trait_def, &trait_def) && Rc::ptr_eq(&entry.ty, &ty))
      .cloned();
    if let Some(previous) = previous {
      if bundle.is_some() && previous.module.bundle_name == bundle {
        if previous.declaration != declaration {
          return Err(RuntimeError::Other(format!(
            "changed impl {} for {name} in bundle {}",
            trait_def.name,
            bundle.as_deref().unwrap()
          )));
        }
        let symbol = self
          .interner
          .get_or_intern(format!("{}.{name}", trait_def.name));
        env
          .borrow_mut()
          .define(symbol, Value::Module(previous.module.clone()));
        return Ok(Value::Module(previous.module));
      }
      return Err(RuntimeError::Other(format!(
        "duplicate impl {} for {name}",
        trait_def.name
      )));
    }
    let mut exports = BTreeMap::new();
    for method in methods {
      let Value::List(method) = method else {
        return Err(RuntimeError::Other(
          "impl members must be fn definitions".into(),
        ));
      };
      let [head, method_name, Value::List(params), body @ ..] = method.items.as_slice() else {
        return Err(RuntimeError::Other(
          "impl members must be fn definitions".into(),
        ));
      };
      let method_name = self.syntax_name(method_name)?;
      if self.syntax_name(head)? != "fn"
        || params
          .items
          .first()
          .and_then(|p| self.syntax_name(p).ok())
          .as_deref()
          != Some("self")
      {
        return Err(RuntimeError::Other(
          "impl methods require (fn name (self …) -> Type …)".into(),
        ));
      }
      if !trait_def.methods.contains_key(&method_name) {
        return Err(RuntimeError::Other(format!(
          "unknown {} method {method_name}",
          trait_def.name
        )));
      }
      let function = self.user_lambda(env.clone(), &method_name, &params.items, body)?;
      if exports.insert(method_name.clone(), function).is_some() {
        return Err(RuntimeError::Other(format!(
          "duplicate impl method {method_name}"
        )));
      }
    }
    let local_name = format!("{}.{name}", trait_def.name);
    let qualified = match &bundle {
      Some(bundle) => format!("{bundle}.{local_name}"),
      _ => local_name.clone(),
    };
    let mut module = Module::new(qualified, BTreeMap::new()).with_exports(exports);
    module.bundle_name = bundle;
    let module = Rc::new(module);
    checked(trait_def.check(&module))?;
    self.trait_impls.borrow_mut().push(StructImpl {
      trait_def,
      ty,
      module: module.clone(),
      declaration,
    });
    let symbol = self.interner.get_or_intern(local_name);
    env
      .borrow_mut()
      .define(symbol, Value::Module(module.clone()));
    Ok(Value::Module(module))
  }

  /// Return an ordinary typed lambda: argument/default/result handling stays
  /// on the same path as user functions, including first-class method values.
  pub(crate) fn trait_method(&mut self, trait_def: Rc<TraitDef>, method: &str) -> Option<Value<S>> {
    let signature = trait_def.methods.get(method)?.clone();
    if signature.params.first()?.name != "self" {
      return None;
    }
    let implementations = self.trait_impls.clone();
    let method = method.to_string();
    let lookup = Value::Function(Function::NativeClosure(Rc::new(move |_, values| {
      let [value @ Value::Map(record)] = values.as_slice() else {
        return Err(RuntimeError::Other(format!(
          "{}.{} requires a constructed struct as self",
          trait_def.name, method
        )));
      };
      let implementation = implementations.borrow();
      let implementation = implementation
        .iter()
        .find(|entry| {
          Rc::ptr_eq(&entry.trait_def, &trait_def)
            && record
              .record_type()
              .is_some_and(|ty| Rc::ptr_eq(ty, &entry.ty))
        })
        .ok_or_else(|| {
          RuntimeError::Other(format!(
            "no impl {} for self; hydrate JSON records with std.record.hydrate",
            trait_def.name
          ))
        })?;
      let mut errors = Vec::new();
      implementation.ty.check(value, "self", &mut errors);
      checked(errors)?;
      Ok(implementation.module.exports[&method].clone())
    })));
    let params: Vec<S> = signature
      .params
      .iter()
      .map(|p| self.interner.get_or_intern(&p.name))
      .collect();
    let symbol_value = |s: S| Value::Symbol(crate::Sym::from(&s));
    let mut call = vec![Value::List(List {
      items: vec![lookup, symbol_value(params[0])].into(),
    })];
    for (param, symbol) in signature.params.iter().zip(&params) {
      if param.kind == crate::types::ParamKind::Named {
        call.push(symbol_value(
          self.interner.get_or_intern(format!("{}:", param.name)),
        ));
      }
      call.push(symbol_value(*symbol));
    }
    let defaults = signature
      .params
      .iter()
      .map(|p| p.default.clone().map(crate::json_to_value))
      .collect();
    Some(Value::Function(Function::Lambda(Rc::new(Lambda {
      params,
      signature: Some(signature),
      defaults,
      body: vec![Value::List(List { items: call.into() })],
      captured_env: None,
    }))))
  }
}
