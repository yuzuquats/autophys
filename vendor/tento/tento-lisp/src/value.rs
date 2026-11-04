use indexmap::IndexMap;

use crate::{
  eval::{Function, List, RuntimeError, Sym, Type},
  grammar::{Literal, SExpression},
  symbol::Symbol,
};

#[derive(Clone, Debug)]
pub enum Value<S: Symbol> {
  /// Non-serializable, host-owned authority with shared revocation.
  Resource(crate::resource::Resource),
  Nil,
  Boolean(bool),
  Integer(i64),
  Float(f64),
  String(Text),
  Symbol(Sym<S>),
  List(List<S>),
  /// Insertion-ordered string-keyed map. JSON-object equivalent in
  /// JS Lisp. Preserved order matters for `json-stringify` round-trips.
  Map(Shared<IndexMap<String, Value<S>>>),
  /// Tagged-string literal. Evaluates to the parsed JSON value when
  /// `tag == "json"`, else to a 2-element list `[tag, payload]`.
  /// Quote produces the 2-element list form uniformly.
  TaggedString {
    tag: String,
    payload: String,
  },
  Function(Function<S>),
  Type(std::rc::Rc<crate::types::TypeExpr>),
  Trait(std::rc::Rc<crate::types::TraitDef>),
  Module(std::rc::Rc<crate::types::Module<S>>),
  /// A first-class error value — the soft-error seam (Phase 2). Constructed
  /// ONLY by the `(try …)` special form (the sole in-language constructor), so
  /// it can never appear by accident. Deliberately falsy (see `is_truthy`).
  /// Boxed: it is the largest payload, and every `Value` on an eval frame
  /// pays for the largest variant.
  Error(Box<ErrorValue>),
}

/// The text of a [`Value::String`], shared between the values that hold it.
///
/// A name lookup copies the value it finds, and strings flow through `let`,
/// `prev`, function arguments, lists and scene renders all the time. With the
/// bytes behind an [`Rc`](std::rc::Rc), each such copy is a reference
/// count, as it already is for a [`List`] or a [`Value::Map`]; a 64 MiB file
/// read back through `prev` is no longer copied a second time.
///
/// Lisp strings are immutable: every operation that changes text builds a new
/// string. So there is no `make_mut`; a `Text` is built once, from a `String`
/// or a `&str`, and read through `Deref<Target = str>`.
///
/// The `Rc` holds a `String`, not a `str`: a `String` a native produced (a
/// 64 MiB file just read) moves in without a copy, where an `Rc<str>` would
/// copy it into the reference-counted allocation, and a unique holder gets
/// the `String` back without a copy (`into_string`). The cost is one more
/// pointer hop on every read.
#[derive(Clone, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Text(std::rc::Rc<String>);

impl Text {
  /// The text as a string slice.
  pub fn as_str(&self) -> &str {
    &self.0
  }

  /// The text as an owned `String`: moved out when this is the last holder,
  /// copied once when the text is shared.
  pub fn into_string(self) -> String {
    std::rc::Rc::try_unwrap(self.0).unwrap_or_else(|shared| (*shared).clone())
  }
}

impl std::ops::Deref for Text {
  type Target = str;
  fn deref(&self) -> &str {
    &self.0
  }
}

impl AsRef<str> for Text {
  fn as_ref(&self) -> &str {
    &self.0
  }
}

impl std::borrow::Borrow<str> for Text {
  fn borrow(&self) -> &str {
    &self.0
  }
}

impl std::fmt::Debug for Text {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    std::fmt::Debug::fmt(self.0.as_str(), f)
  }
}

impl std::fmt::Display for Text {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    std::fmt::Display::fmt(self.0.as_str(), f)
  }
}

impl PartialEq<str> for Text {
  fn eq(&self, other: &str) -> bool {
    self.0.as_str() == other
  }
}

impl PartialEq<&str> for Text {
  fn eq(&self, other: &&str) -> bool {
    self.0.as_str() == *other
  }
}

impl PartialEq<String> for Text {
  fn eq(&self, other: &String) -> bool {
    self.0.as_str() == other.as_str()
  }
}

impl PartialEq<Text> for str {
  fn eq(&self, other: &Text) -> bool {
    self == other.0.as_str()
  }
}

impl PartialEq<Text> for &str {
  fn eq(&self, other: &Text) -> bool {
    *self == other.0.as_str()
  }
}

impl PartialEq<Text> for String {
  fn eq(&self, other: &Text) -> bool {
    self.as_str() == other.0.as_str()
  }
}

impl From<String> for Text {
  fn from(value: String) -> Self {
    Text(std::rc::Rc::new(value))
  }
}

impl From<&str> for Text {
  fn from(value: &str) -> Self {
    Text(std::rc::Rc::new(value.to_owned()))
  }
}

impl From<&String> for Text {
  fn from(value: &String) -> Self {
    Text(std::rc::Rc::new(value.clone()))
  }
}

impl From<std::rc::Rc<str>> for Text {
  fn from(value: std::rc::Rc<str>) -> Self {
    Text(std::rc::Rc::new(String::from(&*value)))
  }
}

impl From<Box<str>> for Text {
  fn from(value: Box<str>) -> Self {
    Text(std::rc::Rc::new(value.into_string()))
  }
}

impl From<Text> for String {
  fn from(value: Text) -> Self {
    value.into_string()
  }
}

impl From<&Text> for String {
  fn from(value: &Text) -> Self {
    String::from(value.as_str())
  }
}

/// The payload of a [`Value::Error`]: a captured soft runtime error rendered as
/// data. `kind` is a short machine tag (`"unbound"`, `"type"`, `"error"`);
/// `message` is the human text; `origin` is the rendered source form that
/// failed (when cheaply available); `chain` is reserved for future cause
/// threading (empty in Phase 2). `host`, `hint`, `next` and `output` are
/// present only when the failing command reported them ([`crate::eval::ReportedFailure`]): the
/// machine it was talking to, and the one thing to do about it.
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorValue {
  pub kind: String,
  pub message: String,
  pub origin: Option<String>,
  pub chain: Vec<String>,
  pub host: Option<String>,
  /// Plain-language advice the failing command gave a person.
  pub hint: Option<String>,
  pub next: Option<String>,
  /// What the failing command printed before it failed (its last lines).
  pub output: Option<String>,
  /// The failing command's display fields (`shape`, `rows`, …), as it
  /// reported them ([`crate::eval::ReportedFailure::display`]).
  pub display: Option<serde_json::Map<String, serde_json::Value>>,
}

impl ErrorValue {
  /// The `error/v1` record this value crosses a JSON boundary as. `host`,
  /// `next` and the display fields appear only when set, so an ordinary
  /// failure's record is exactly what it was before they existed.
  pub fn to_record(&self) -> serde_json::Value {
    let mut record = serde_json::json!({
      "type": "error/v1",
      "kind": self.kind,
      "message": self.message,
      "origin": self.origin,
      "chain": self.chain,
    });
    for (key, value) in [
      ("host", &self.host),
      ("hint", &self.hint),
      ("next", &self.next),
      ("output", &self.output),
    ] {
      if let Some(value) = value {
        record[key] = serde_json::Value::String(value.clone());
      }
    }
    for (key, value) in self.display.iter().flatten() {
      // In-process error.next can expose structured advice. ErrorRecord's
      // existing wire `next` field remains text (Next.text), never a record.
      if key == "next" && value.is_object() {
        if let Some(text) = value.get("text").and_then(serde_json::Value::as_str) {
          record["next"] = serde_json::Value::String(text.to_string());
        }
        continue;
      }
      record[key.as_str()] = value.clone();
    }
    record
  }
}

impl<S: Symbol> Value<S> {
  /// Consume a reader tree, moving its strings into executable values.
  /// Use [`Self::from_sexpression`] when the caller needs to retain the tree.
  ///
  /// Walks the tree with an explicit stack, never the native one, so a form
  /// nested as deep as the reader admits converts in constant stack.
  pub fn from_owned_sexpression(sexpression: SExpression<S>) -> crate::SyntaxResult<Value<S>> {
    let elements = match sexpression {
      SExpression::Literal(literal) => return Ok(Self::from_owned_literal(literal)),
      SExpression::List(elements) => elements,
    };
    let mut open = vec![(Vec::with_capacity(elements.len()), elements.into_iter())];
    loop {
      let next = open.last_mut().and_then(|(_, rest)| rest.next());
      match next {
        Some(SExpression::Literal(literal)) => {
          let value = Self::from_owned_literal(literal);
          open.last_mut().expect("a list is open").0.push(value);
        }
        Some(SExpression::List(children)) => {
          open.push((Vec::with_capacity(children.len()), children.into_iter()))
        }
        None => {
          let (items, _) = open.pop().expect("a list is open");
          let value = Value::List(List { items: items.into() });
          match open.last_mut() {
            Some((parent, _)) => parent.push(value),
            None => return Ok(value),
          }
        }
      }
    }
  }

  /// Convert a reader tree the caller keeps. Iterative, like
  /// [`Self::from_owned_sexpression`].
  pub fn from_sexpression(sexpression: &SExpression<S>) -> crate::SyntaxResult<Value<S>> {
    let elements = match sexpression {
      SExpression::Literal(literal) => return Ok(Value::from_literal(literal)),
      SExpression::List(elements) => elements,
    };
    let mut open = vec![(Vec::with_capacity(elements.len()), elements.iter())];
    loop {
      let next = open.last_mut().and_then(|(_, rest)| rest.next());
      match next {
        Some(SExpression::Literal(literal)) => {
          let value = Value::from_literal(literal);
          open.last_mut().expect("a list is open").0.push(value);
        }
        Some(SExpression::List(children)) => {
          open.push((Vec::with_capacity(children.len()), children.iter()))
        }
        None => {
          let (items, _) = open.pop().expect("a list is open");
          let value = Value::List(List { items: items.into() });
          match open.last_mut() {
            Some((parent, _)) => parent.push(value),
            None => return Ok(value),
          }
        }
      }
    }
  }

  fn from_owned_literal(literal: Literal<S>) -> Value<S> {
    match literal {
      Literal::Boolean(value) => Value::Boolean(value),
      Literal::Integer(value) => Value::Integer(value),
      Literal::Float(value) => Value::Float(value),
      Literal::String(value) => Value::String(value.into()),
      Literal::Symbol(value) => Value::Symbol(value.into()),
      Literal::TaggedString { tag, payload } => Value::TaggedString { tag, payload },
    }
  }

  fn from_literal(literal: &Literal<S>) -> Value<S> {
    match literal {
      Literal::Boolean(val) => Value::Boolean(*val),
      Literal::Integer(val) => Value::Integer(*val),
      Literal::Float(val) => Value::Float(*val),
      Literal::String(val) => Value::String(val.as_str().into()),
      Literal::Symbol(sym) => Value::Symbol(sym.into()),
      Literal::TaggedString { tag, payload } => Value::TaggedString {
        tag: tag.clone(),
        payload: payload.clone(),
      },
    }
  }

  /// JS-aligned: only `nil` and `false` are falsy. `0`, `0.0`, `""`,
  /// empty lists, empty maps are all truthy. (See JS
  /// `Lisp.Utils.isTruthy` at `lisp.ts:642`.)
  ///
  /// A `Value::Error` is ALSO falsy — deliberately. This lets
  /// `(if (try (f)) ok-path fallback-path)` take the fallback on failure
  /// without an explicit `error?` test. It is safe *only because `(try …)` is
  /// the sole constructor of an error value*: a predicate can never accidentally
  /// return one, so nothing can smuggle a falsy error into a conditional.
  pub fn is_truthy(&self) -> bool {
    !matches!(self, Value::Nil | Value::Boolean(false) | Value::Error(_))
  }
}

/// A list's items or a map's entries, shared between the values that hold
/// them and copied only when one of them changes them.
///
/// A name lookup copies the value it finds, and a scene looks names up all
/// the time: handing a record to a lambda, binding it in `let`, mapping over
/// a list. With the elements behind an [`Rc`](std::rc::Rc), each such copy
/// is a reference count. Reads go through `Deref`; a write through
/// `DerefMut` first takes its own copy if another value still shares the
/// elements ([`Rc::make_mut`](std::rc::Rc::make_mut)), so no value ever
/// sees another's change.
///
/// Dropping the last holder lets go of nested elements iteratively
/// ([`Teardown`]): a list a million levels deep drops in constant native
/// stack, where the derived drop glue would recurse once per level.
#[derive(Default)]
pub struct Shared<T: Teardown>(std::rc::Rc<T>, Option<std::rc::Rc<crate::types::TypeExpr>>);

#[cfg(test)]
thread_local! {
  /// Copies a [`Shared`] write or [`Shared::into_inner`] made because another
  /// value held the elements, counted per thread so a test can state that an
  /// idiom copies nothing.
  pub(crate) static SHARED_COPIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How the last holder of a [`Shared`] container lets go of its elements.
///
/// The drop glue of a nested container recurses once per nesting level, and
/// Lisp code builds data far deeper than the native stack holds (a `reduce`
/// that wraps its accumulator a million times). A container of values
/// implements this by moving every uniquely-held nested container's elements
/// onto one heap work list, so each value is dropped while it holds nothing
/// that could recurse. Elements another value still shares only lose a
/// reference. The default does nothing: ordinary drop glue is fine for
/// elements that cannot nest.
pub trait Teardown {
  fn teardown(&mut self) {}
}

impl<S: Symbol> Teardown for Vec<Value<S>> {
  fn teardown(&mut self) {
    if self.iter().any(Value::holds_shared_elements) {
      drop_iteratively(std::mem::take(self));
    }
  }
}

impl<S: Symbol> Teardown for IndexMap<String, Value<S>> {
  fn teardown(&mut self) {
    if self.values().any(Value::holds_shared_elements) {
      drop_iteratively(std::mem::take(self).into_values().collect());
    }
  }
}

/// Drop `pending` and everything it uniquely holds, using `pending` itself as
/// the work list. A value is dropped only after its unique children have been
/// moved out, so its own drop finds an empty container and goes no deeper.
fn drop_iteratively<S: Symbol>(mut pending: Vec<Value<S>>) {
  while let Some(mut value) = pending.pop() {
    match &mut value {
      Value::List(list) => {
        if let Some(items) = std::rc::Rc::get_mut(&mut list.items.0) {
          pending.append(items);
        }
      }
      Value::Map(map) => {
        if let Some(entries) = std::rc::Rc::get_mut(&mut map.0) {
          pending.extend(entries.drain(..).map(|(_, value)| value));
        }
      }
      _ => {}
    }
  }
}

impl<S: Symbol> Value<S> {
  /// Whether dropping this value could reach further nested elements.
  fn holds_shared_elements(&self) -> bool {
    match self {
      Value::List(list) => !list.items.is_empty(),
      Value::Map(map) => !map.is_empty(),
      _ => false,
    }
  }
}

impl<T: Teardown> Drop for Shared<T> {
  fn drop(&mut self) {
    if let Some(elements) = std::rc::Rc::get_mut(&mut self.0) {
      elements.teardown();
    }
  }
}

impl<T: Clone + Teardown> Shared<T> {
  pub fn new(value: T) -> Self {
    Shared(std::rc::Rc::new(value), None)
  }

  /// Constructor identity is deliberately absent from map contents and JSON.
  pub(crate) fn with_record_type(mut self, ty: std::rc::Rc<crate::types::TypeExpr>) -> Self {
    self.1 = Some(ty);
    self
  }

  pub(crate) fn record_type(&self) -> Option<&std::rc::Rc<crate::types::TypeExpr>> {
    self.1.as_ref()
  }

  /// The elements, without a copy unless another value shares them.
  pub fn into_inner(mut self) -> T
  where
    T: Default,
  {
    match std::rc::Rc::get_mut(&mut self.0) {
      Some(elements) => std::mem::take(elements),
      None => {
        #[cfg(test)]
        SHARED_COPIES.with(|copies| copies.set(copies.get() + 1));
        (*self.0).clone()
      }
    }
  }

  /// Whether `self` and `other` hold the very same elements.
  pub fn ptr_eq(&self, other: &Self) -> bool {
    std::rc::Rc::ptr_eq(&self.0, &other.0)
  }

  /// Whether another value holds these elements too.
  pub fn is_shared(&self) -> bool {
    std::rc::Rc::strong_count(&self.0) > 1
  }
}

impl<T: Teardown> Clone for Shared<T> {
  fn clone(&self) -> Self {
    Shared(self.0.clone(), self.1.clone())
  }
}

impl<T: Teardown> std::ops::Deref for Shared<T> {
  type Target = T;
  fn deref(&self) -> &T {
    &self.0
  }
}

impl<T: Clone + Teardown> std::ops::DerefMut for Shared<T> {
  fn deref_mut(&mut self) -> &mut T {
    #[cfg(test)]
    if std::rc::Rc::strong_count(&self.0) > 1 {
      SHARED_COPIES.with(|copies| copies.set(copies.get() + 1));
    }
    std::rc::Rc::make_mut(&mut self.0)
  }
}

impl<T: Clone + Teardown> From<T> for Shared<T> {
  fn from(value: T) -> Self {
    Shared::new(value)
  }
}

/// How many [`Shared`] containers deep `{:?}` descends before it writes `…`.
///
/// Derived `Debug` recurses once per level, measured at under 1 KiB of
/// native stack each in a debug build, and Lisp data nests far deeper than
/// any stack. `{:?}` also runs inside evaluation (error details), where the
/// evaluator's stack grower guarantees only a 256 KiB red zone; 128 levels
/// fit in that and still print every realistic value whole.
pub const DEBUG_DEPTH_LIMIT: usize = 128;

thread_local! {
  static DEBUG_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl<T: std::fmt::Debug + Teardown> std::fmt::Debug for Shared<T> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    struct Level(usize);
    impl Drop for Level {
      fn drop(&mut self) {
        DEBUG_DEPTH.set(self.0);
      }
    }
    let depth = DEBUG_DEPTH.get();
    if depth >= DEBUG_DEPTH_LIMIT {
      return f.write_str("…");
    }
    DEBUG_DEPTH.set(depth + 1);
    let _restore = Level(depth);
    self.0.fmt(f)
  }
}

impl<T: PartialEq + Teardown> PartialEq for Shared<T> {
  fn eq(&self, other: &Self) -> bool {
    std::rc::Rc::ptr_eq(&self.0, &other.0) || *self.0 == *other.0
  }
}

impl<A: Clone> FromIterator<A> for Shared<Vec<A>>
where
  Vec<A>: Teardown,
{
  fn from_iter<I: IntoIterator<Item = A>>(iter: I) -> Self {
    Shared::new(iter.into_iter().collect())
  }
}

impl<K: std::hash::Hash + Eq + Clone, V: Clone> FromIterator<(K, V)> for Shared<IndexMap<K, V>>
where
  IndexMap<K, V>: Teardown,
{
  fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
    Shared::new(iter.into_iter().collect())
  }
}

impl<A: Clone> IntoIterator for Shared<Vec<A>>
where
  Vec<A>: Teardown,
{
  type Item = A;
  type IntoIter = std::vec::IntoIter<A>;
  fn into_iter(self) -> Self::IntoIter {
    self.into_inner().into_iter()
  }
}

impl<'a, A> IntoIterator for &'a Shared<Vec<A>>
where
  Vec<A>: Teardown,
{
  type Item = &'a A;
  type IntoIter = std::slice::Iter<'a, A>;
  fn into_iter(self) -> Self::IntoIter {
    self.0.iter()
  }
}

impl<'a, A: Clone> IntoIterator for &'a mut Shared<Vec<A>>
where
  Vec<A>: Teardown,
{
  type Item = &'a mut A;
  type IntoIter = std::slice::IterMut<'a, A>;
  fn into_iter(self) -> Self::IntoIter {
    std::rc::Rc::make_mut(&mut self.0).iter_mut()
  }
}

impl<K: Clone, V: Clone> IntoIterator for Shared<IndexMap<K, V>>
where
  IndexMap<K, V>: Teardown,
{
  type Item = (K, V);
  type IntoIter = indexmap::map::IntoIter<K, V>;
  fn into_iter(self) -> Self::IntoIter {
    self.into_inner().into_iter()
  }
}

impl<'a, K, V> IntoIterator for &'a Shared<IndexMap<K, V>>
where
  IndexMap<K, V>: Teardown,
{
  type Item = (&'a K, &'a V);
  type IntoIter = indexmap::map::Iter<'a, K, V>;
  fn into_iter(self) -> Self::IntoIter {
    self.0.iter()
  }
}

impl<S: Symbol> Default for Value<S> {
  fn default() -> Self {
    Self::Nil
  }
}

impl<S: Symbol> Value<S> {
  pub fn as_type(&self) -> Type {
    match self {
      Value::Resource(..) => Type::Resource,
      Value::Nil => Type::Nil,
      Value::Boolean(..) => Type::Boolean,
      Value::Integer(..) => Type::Integer,
      Value::Float(..) => Type::Float,
      Value::String(..) => Type::String,
      Value::Symbol(..) => Type::Symbol,
      Value::List(..) => Type::List,
      Value::Map(..) => Type::Map,
      Value::TaggedString { .. } => Type::TaggedString,
      Value::Function(..) => Type::Function,
      Value::Type(..) => Type::Type,
      Value::Trait(..) => Type::Trait,
      Value::Module(..) => Type::Module,
      Value::Error(..) => Type::Error,
    }
  }
}

impl Type {
  pub fn error(got: Type, expected: Type) -> RuntimeError {
    RuntimeError::TypeError {
      expected: format!("{:?}", expected),
      got: format!("{:?}", got),
    }
  }
}

impl<S: Symbol> TryFrom<Value<S>> for bool {
  type Error = RuntimeError;

  fn try_from(value: Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::Boolean(val) => Ok(val),
      _ => Err(Type::error(value.as_type(), Type::Boolean)),
    }
  }
}

impl<S: Symbol> TryFrom<&Value<S>> for bool {
  type Error = RuntimeError;

  fn try_from(value: &Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::Boolean(val) => Ok(*val),
      _ => Err(Type::error(value.as_type(), Type::Boolean)),
    }
  }
}

impl<S: Symbol> TryFrom<Value<S>> for i64 {
  type Error = RuntimeError;

  fn try_from(value: Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::Integer(val) => Ok(val),
      _ => Err(Type::error(value.as_type(), Type::Integer)),
    }
  }
}

impl<S: Symbol> TryFrom<&Value<S>> for i64 {
  type Error = RuntimeError;

  fn try_from(value: &Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::Integer(val) => Ok(*val),
      _ => Err(Type::error(value.as_type(), Type::Integer)),
    }
  }
}

impl<S: Symbol> TryFrom<Value<S>> for String {
  type Error = RuntimeError;

  fn try_from(value: Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::String(val) => Ok(val.into_string()),
      _ => Err(Type::error(value.as_type(), Type::String)),
    }
  }
}

impl<'a, S: Symbol> TryFrom<&'a Value<S>> for &'a str {
  type Error = RuntimeError;

  fn try_from(value: &'a Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::String(val) => Ok(val),
      _ => Err(Type::error(value.as_type(), Type::String)),
    }
  }
}

impl<S: Symbol> TryFrom<Value<S>> for f64 {
  type Error = RuntimeError;

  fn try_from(value: Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::Float(val) => Ok(val),
      Value::Integer(val) => Ok(val as f64),
      _ => Err(Type::error(value.as_type(), Type::Float)),
    }
  }
}

impl<S: Symbol> TryFrom<&Value<S>> for f64 {
  type Error = RuntimeError;

  fn try_from(value: &Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::Float(val) => Ok(*val),
      Value::Integer(val) => Ok(*val as f64),
      _ => Err(Type::error(value.as_type(), Type::Float)),
    }
  }
}

impl<S: Symbol> TryFrom<Value<S>> for Function<S> {
  type Error = RuntimeError;

  fn try_from(value: Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::Function(val) => Ok(val),
      _ => Err(Type::error(value.as_type(), Type::Function)),
    }
  }
}

impl<'a, S: Symbol> TryFrom<&'a Value<S>> for &'a Function<S> {
  type Error = RuntimeError;

  fn try_from(value: &'a Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::Function(val) => Ok(val),
      _ => Err(Type::error(value.as_type(), Type::Function)),
    }
  }
}

impl<S: Symbol> TryFrom<Value<S>> for Sym<S> {
  type Error = RuntimeError;

  fn try_from(value: Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::Symbol(val) => Ok(val),
      _ => Err(Type::error(value.as_type(), Type::Symbol)),
    }
  }
}

impl<'a, S: Symbol> TryFrom<&'a Value<S>> for &'a Sym<S> {
  type Error = RuntimeError;

  fn try_from(value: &'a Value<S>) -> std::result::Result<Self, Self::Error> {
    match value {
      Value::Symbol(val) => Ok(val),
      _ => Err(Type::error(value.as_type(), Type::Symbol)),
    }
  }
}

#[cfg(test)]
mod shared_tests {
  use super::{Shared, Teardown};

  impl Teardown for Vec<i64> {}

  /// A copy shares the elements until one side changes them; the change
  /// then lands on its own copy, never on the other.
  #[test]
  fn a_change_to_a_shared_copy_leaves_the_other_alone() {
    let a: Shared<Vec<i64>> = vec![1, 2].into();
    let mut b = a.clone();
    assert!(a.ptr_eq(&b));
    b.push(3);
    assert!(!a.ptr_eq(&b));
    assert_eq!(*a, vec![1, 2]);
    assert_eq!(*b, vec![1, 2, 3]);
    // The last holder takes the elements without a copy.
    let only: Shared<Vec<i64>> = vec![4].into();
    assert_eq!(only.into_inner(), vec![4]);
  }
}
