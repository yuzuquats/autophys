use serde_json::Value as JsonValue;
use std::rc::Rc;

#[derive(Clone, Debug)]
pub enum LispScalar {
  Boolean(bool),
  Integer(i64),
  Float(f64),
  String(String),
}

#[derive(Clone, Debug)]
pub enum HostValue {
  Lisp(LispScalar),
  Json(Rc<JsonValue>),
}

impl HostValue {
  pub fn from_json(v: JsonValue) -> Self {
    HostValue::Json(Rc::new(v))
  }

  pub fn to_shell_arg(&self) -> String {
    match self {
      HostValue::Lisp(LispScalar::Boolean(b)) => b.to_string(),
      HostValue::Lisp(LispScalar::Integer(i)) => i.to_string(),
      HostValue::Lisp(LispScalar::Float(f)) => f.to_string(),
      HostValue::Lisp(LispScalar::String(s)) => s.clone(),
      HostValue::Json(j) => match j.as_ref() {
        JsonValue::Null => "null".to_string(),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::String(s) => s.clone(),
        other => other.to_string(),
      },
    }
  }

  /// Format the value as a self-contained lisp source expression so
  /// it can be substituted directly into a `(when COND)` body or
  /// other top-level lisp form. Strings get JSON-escaped + quoted
  /// (so `"foo"` becomes `"foo"`, not a bare symbol); numbers and
  /// booleans stay bare; complex JSON falls back to `serde_json`
  /// serialization — which produces a valid lisp literal for
  /// strings/numbers/booleans but not for arrays/objects (those
  /// can't legally appear in a lisp comparison anyway).
  pub fn to_lisp_source(&self) -> String {
    match self {
      HostValue::Lisp(LispScalar::Boolean(b)) => b.to_string(),
      HostValue::Lisp(LispScalar::Integer(i)) => i.to_string(),
      HostValue::Lisp(LispScalar::Float(f)) => f.to_string(),
      HostValue::Lisp(LispScalar::String(s)) => serde_json::Value::String(s.clone()).to_string(),
      HostValue::Json(j) => match j.as_ref() {
        JsonValue::Null => "()".to_string(),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::String(_) => j.to_string(),
        other => other.to_string(),
      },
    }
  }

  pub fn truthy(&self) -> bool {
    match self {
      HostValue::Lisp(LispScalar::Boolean(b)) => *b,
      HostValue::Lisp(LispScalar::Integer(i)) => *i != 0,
      HostValue::Lisp(LispScalar::Float(f)) => *f != 0.0,
      HostValue::Lisp(LispScalar::String(s)) => !s.is_empty(),
      HostValue::Json(j) => match j.as_ref() {
        JsonValue::Null => false,
        JsonValue::Bool(b) => *b,
        JsonValue::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        JsonValue::String(s) => !s.is_empty(),
        JsonValue::Array(a) => !a.is_empty(),
        JsonValue::Object(o) => !o.is_empty(),
      },
    }
  }
}
