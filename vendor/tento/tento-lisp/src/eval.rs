use indexmap::IndexMap;
use std::{cell::RefCell, collections::HashMap, fmt::Debug, rc::Rc};

use string_interner::StringInterner;

use crate::{
  symbol::{Backend, Symbol},
  value::Value,
};

#[derive(Debug, Clone)]
pub enum RuntimeError {
  TypeError {
    expected: String,
    got: String,
  },
  UndefinedSymbol {
    detail: String,
  },
  ExpectedToken {
    detail: String,
  },
  ArityError {
    detail: String,
  },
  /// A **hard** error that must halt evaluation — it is never captured at the
  /// `(try …)` seam into a `Value::Error`, and it halts a `WarnContinue` unit
  /// immediately. The eval-budget/deadline/depth rails and the deliberate
  /// escalations (`assert`, `(unwrap …)`/`(expect …)`) construct this so a runaway or
  /// invariant-violating script always halts rather than soft-failing through.
  Fatal {
    detail: String,
  },
  /// A **command's own** returned failure (a dispatched command / native
  /// command, e.g. `ls -t` → "ls: -t … not implemented yet"), as opposed to an
  /// interpreter-proper fault (`TypeError`, `UndefinedSymbol`, arity). Carried
  /// distinctly so the host boundary can render it WITHOUT the `lisp error:`
  /// label the interpreter faults keep — the command already self-identifies
  /// (`ls: …`), so re-labelling it `lisp error:` stutters. Soft (capturable at
  /// `(try …)` exactly like [`Self::Other`]).
  Command {
    detail: String,
  },
  /// A native's failure that carries the process status the caller should
  /// exit with (a child tsh that exited N makes its caller exit N). Hard: a
  /// `(try …)` does not capture it.
  Exit {
    status: i32,
    detail: String,
  },
  /// A command's failure it reported as data — a plugin's `{"error": {...}}`
  /// record — rather than as text. Soft, like [`Self::Other`]; `(try …)`
  /// turns it into an `error/v1` value carrying the reported fields.
  Reported(Box<ReportedFailure>),
  Other(String),
}

/// What a command reported about its own failure. `message` is the sentence;
/// `kind`, `host`, `hint` and `next` are the optional `error/v1` fields — what
/// kind of failure, which machine it was talking to, plain-language advice for
/// a person, and the one call to make next. `output` is what the command
/// printed before it failed (the last lines of a streaming command): the
/// transcript already showed it, so the text never repeats it, but `(try …)`
/// and scripts can read it.
/// `display` is what the command drew before it failed (acme's kind
/// `partial`): the record's display fields ([`Self::DISPLAY_FIELDS`]), copied
/// verbatim, for the embedding shell to draw the way it draws the same fields
/// on a success record. The text ([`std::fmt::Display`]) never includes it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReportedFailure {
  pub message: String,
  pub kind: Option<String>,
  pub host: Option<String>,
  pub hint: Option<String>,
  pub next: Option<String>,
  pub output: Option<String>,
  pub display: Option<serde_json::Map<String, serde_json::Value>>,
}

impl ReportedFailure {
  /// The display fields a failure record may carry: the same ones a success
  /// record draws with. `shape` and `rows` are required for any of them.
  pub const DISPLAY_FIELDS: [&'static str; 6] = ["shape", "rows", "title", "columns", "header_style", "gap"];
}

impl std::fmt::Display for ReportedFailure {
  /// The message, then each field on its own labelled line — `kind: …`,
  /// `host: …`, `hint: …`, and `try: …` for the next call. Absent fields add
  /// no line; `output` is never repeated.
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}", self.message)?;
    for (label, field) in [
      ("kind", &self.kind),
      ("host", &self.host),
      ("hint", &self.hint),
      ("try", &self.next),
    ] {
      if let Some(value) = field {
        write!(f, "\n{label}: {value}")?;
      }
    }
    Ok(())
  }
}

impl RuntimeError {
  /// Whether this error is *hard* — propagates through `(try …)` unchanged and
  /// halts a `WarnContinue` unit — rather than *soft*, capturable at the seam
  /// into a falsy `Value::Error`.
  ///
  /// Hard: structural misuse (`ExpectedToken`, `ArityError`) and deliberate
  /// escalations (`Fatal`: eval budget/deadline/depth, `assert`, `unwrap`/`expect`).
  /// Soft: recoverable runtime failures — `TypeError`, `UndefinedSymbol`, and
  /// native/command `Other`.
  pub fn is_hard(&self) -> bool {
    matches!(
      self,
      RuntimeError::ExpectedToken { .. }
        | RuntimeError::ArityError { .. }
        | RuntimeError::Fatal { .. }
        | RuntimeError::Exit { .. }
    )
  }
}

impl std::fmt::Display for RuntimeError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      RuntimeError::TypeError { expected, got } => {
        write!(f, "type error: expected {expected}, got {got}")
      }
      RuntimeError::UndefinedSymbol { detail } => write!(f, "undefined symbol `{detail}`"),
      RuntimeError::ExpectedToken { detail } => write!(f, "expected token: {detail}"),
      RuntimeError::ArityError { detail } => write!(f, "arity error: {detail}"),
      // `Fatal` carries a fully-formed sentence (budget/assert/unwrap/expect text), so
      // it renders bare like `Other` — no re-prefixing.
      RuntimeError::Fatal { detail } => write!(f, "{detail}"),
      // Renders bare — the command self-identifies (`ls: …`); the host boundary
      // decides the label, and it deliberately omits `lisp error:`.
      RuntimeError::Command { detail } => write!(f, "{detail}"),
      RuntimeError::Exit { detail, .. } => write!(f, "{detail}"),
      RuntimeError::Reported(failure) => write!(f, "{failure}"),
      RuntimeError::Other(detail) => write!(f, "{detail}"),
    }
  }
}

impl std::error::Error for RuntimeError {}

#[derive(Debug, Clone, PartialEq)]
pub enum Type {
  Resource,
  Nil,
  Boolean,
  Integer,
  Float,
  String,
  Symbol,
  List,
  Map,
  TaggedString,
  Function,
  Type,
  Trait,
  Module,
  Error,
}

#[derive(Clone, Debug)]
pub struct Sym<S: Symbol>(S);

impl<S: Symbol> Sym<S> {
  pub fn as_symbol(&self) -> S {
    self.0
  }
}

impl<S: Symbol> From<S> for Sym<S> {
  fn from(sym: S) -> Self {
    Self(sym)
  }
}

impl<S: Symbol> From<&S> for Sym<S> {
  fn from(sym: &S) -> Self {
    Self(*sym)
  }
}

/// Environment bindings hash with an Fx-style multiply-fold, not SipHash:
/// symbols are our own interner-dense integers, so DoS-resistant hashing
/// buys nothing, and the profiler put SipHash rounds under `hashbrown`
/// `find` among the interpreter's hottest frames on a scene-render
/// workload — every symbol reference is one of these probes.
#[derive(Default, Clone, Copy)]
pub struct SymBuildHasher;

pub struct SymHasher(u64);

const SYM_HASH_K: u64 = 0x517cc1b727220a95;

impl std::hash::BuildHasher for SymBuildHasher {
  type Hasher = SymHasher;
  fn build_hasher(&self) -> SymHasher {
    SymHasher(0)
  }
}

impl std::hash::Hasher for SymHasher {
  fn finish(&self) -> u64 {
    self.0
  }
  fn write(&mut self, bytes: &[u8]) {
    for &b in bytes {
      self.0 = (self.0.rotate_left(5) ^ b as u64).wrapping_mul(SYM_HASH_K);
    }
  }
  fn write_u16(&mut self, v: u16) {
    self.write_u64(v as u64);
  }
  fn write_u32(&mut self, v: u32) {
    self.write_u64(v as u64);
  }
  fn write_u64(&mut self, v: u64) {
    self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(SYM_HASH_K);
  }
  fn write_usize(&mut self, v: usize) {
    self.write_u64(v as u64);
  }
}

type SymMap<S, V> = HashMap<S, V, SymBuildHasher>;

/// Environment bindings, hybrid: a lambda application's child env holds its
/// parameters — one to a handful of symbols — and allocating a hash table
/// per call made the allocator the interpreter's top profile family (a
/// 55-row scene repaint applies thousands of lambdas). Small envs live in a
/// linear vector (no allocation until first insert, no hashing at all);
/// crossing [`SMALL_ENV_MAX`] promotes to the hashed table, which module
/// and closure scopes with many definitions still get.
const SMALL_ENV_MAX: usize = 8;

enum Bindings<S: Symbol> {
  Small(Vec<(S, Value<S>)>),
  Table(SymMap<S, Value<S>>),
}

impl<S: Symbol> Bindings<S> {
  fn get(&self, symbol: S) -> Option<&Value<S>> {
    match self {
      Bindings::Small(pairs) => pairs
        .iter()
        .find(|(name, _)| *name == symbol)
        .map(|(_, value)| value),
      Bindings::Table(map) => map.get(&symbol),
    }
  }

  fn contains(&self, symbol: S) -> bool {
    self.get(symbol).is_some()
  }

  fn insert(&mut self, symbol: S, value: Value<S>) {
    match self {
      Bindings::Small(pairs) => {
        if let Some(slot) = pairs.iter_mut().find(|(name, _)| *name == symbol) {
          slot.1 = value;
          return;
        }
        if pairs.len() < SMALL_ENV_MAX {
          pairs.push((symbol, value));
          return;
        }
        let mut map = SymMap::default();
        for (name, held) in pairs.drain(..) {
          map.insert(name, held);
        }
        map.insert(symbol, value);
        *self = Bindings::Table(map);
      }
      Bindings::Table(map) => {
        map.insert(symbol, value);
      }
    }
  }

  fn remove(&mut self, symbol: S) {
    match self {
      Bindings::Small(pairs) => {
        pairs.retain(|(name, _)| *name != symbol);
      }
      Bindings::Table(map) => {
        map.remove(&symbol);
      }
    }
  }

  fn values(&self) -> Box<dyn Iterator<Item = &Value<S>> + '_> {
    match self {
      Bindings::Small(pairs) => Box::new(pairs.iter().map(|(_, value)| value)),
      Bindings::Table(map) => Box::new(map.values()),
    }
  }
}

/// How many values a scope-capture count will visit before giving up: a
/// scope holding a fleet-sized list is cheaper to leave alone than to walk
/// on every exit.
const CAPTURE_WALK_LIMIT: usize = 100_000;

/// Live scopes, counted in tests so a release can be observed from outside
/// the interpreter (a `Weak` to a scope the language never hands out).
#[cfg(test)]
pub(crate) static LIVE_SCOPES: std::sync::atomic::AtomicUsize =
  std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
impl<S: Symbol> Drop for Env<S> {
  fn drop(&mut self) {
    LIVE_SCOPES.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
  }
}

pub struct Env<S: Symbol> {
  parent: Option<Rc<RefCell<Env<S>>>>,
  values: Bindings<S>,
  /// Parameter names shadow outer bindings before their defaults initialize.
  uninitialized: Vec<S>,
  /// Whether code the interpreter cannot vouch for has seen this scope or a
  /// scope below it: a closure captured it, or it was handed to a native,
  /// hook or callee that may read or keep it ([`mark_observed`]). An
  /// observed scope never releases a binding early ([`crate::tail`]). A
  /// root scope starts observed: hosts hold it.
  observed: std::cell::Cell<bool>,
}

/// Mark `env` and every scope above it observed, stopping at the first that
/// already is (its ancestors are too).
pub(crate) fn mark_observed<S: Symbol>(env: &Rc<RefCell<Env<S>>>) {
  let mut scope = env.clone();
  loop {
    let parent = {
      let held = scope.borrow();
      if held.observed.get() {
        return;
      }
      held.observed.set(true);
      held.parent.clone()
    };
    match parent {
      Some(parent) => scope = parent,
      None => return,
    }
  }
}

impl<S: Symbol> Env<S> {
  /// A lexical module binding outranks root-level dotted adapters. Ordinary
  /// root modules retain the flat command compatibility path.
  pub(crate) fn lexical_module(&self, symbol: S) -> Option<Rc<crate::types::Module<S>>> {
    let parent = self.parent.as_ref()?;
    if let Some(value) = self.values.get(symbol) {
      return match value { Value::Module(module) => Some(module.clone()), _ => None };
    }
    if self.uninitialized.contains(&symbol) { return None; }
    parent.borrow().lexical_module(symbol)
  }

  /// The outermost frame of `env`'s parent chain — where a definition that
  /// must be visible to every scope goes (a lazily mounted command, say).
  pub fn root_of(env: &Rc<RefCell<Env<S>>>) -> Rc<RefCell<Env<S>>> {
    let mut current = env.clone();
    loop {
      let parent = current.borrow().parent.clone();
      match parent {
        Some(p) => current = p,
        None => return current,
      }
    }
  }
  pub fn default_env<B>(interner: &mut StringInterner<B>) -> Env<S>
  where
    B: Backend<S>,
  {
    let mut env = Env::new();
    crate::stdlib::register_builtins(&mut env, interner);
    use crate::types::TypeExpr;
    for (name, ty) in [("any", TypeExpr::Any), ("bool", TypeExpr::Bool),
      ("s64", TypeExpr::S64), ("i64", TypeExpr::S64), ("u64", TypeExpr::U64),
      ("f64", TypeExpr::F64), ("string", TypeExpr::String), ("error", TypeExpr::Error)] {
      env.define(interner.get_or_intern(name), Value::Type(Rc::new(ty)));
    }
    env
  }

  pub fn extend(parent: Rc<RefCell<Env<S>>>) -> Self {
    #[cfg(test)]
    LIVE_SCOPES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Self {
      parent: Some(parent),
      values: Bindings::Small(Vec::new()),
      uninitialized: Vec::new(),
      observed: std::cell::Cell::new(false),
    }
  }

  /// How many lambdas held by THIS scope (directly, or inside its lists and
  /// maps) captured `scope` — the references a scope makes to itself. With
  /// `Rc::strong_count`, that is what tells a scope nothing outside can reach
  /// (only its own lambdas hold it) from one a closure escaped from. `None`
  /// once the walk passes [`CAPTURE_WALK_LIMIT`] values: unknown, so keep —
  /// and `None` too the moment a capturing lambda turns out to be held by
  /// more than this scope's own binding of it, because that copy is the
  /// escape: `(let ((peek (lambda () secret))) peek)` binds the closure AND
  /// returns it, so the binding count alone cannot tell it apart from a
  /// helper that dies with the frame.
  pub fn captures_of(&self, scope: &Rc<RefCell<Env<S>>>) -> Option<usize> {
    /// Whether `value` holds, at any depth, a lambda that captured `scope`;
    /// `None` once the walk's budget runs out: unknown.
    fn holds_capture<S: Symbol>(value: &Value<S>, scope: &Rc<RefCell<Env<S>>>, budget: &mut usize) -> Option<bool> {
      if *budget == 0 {
        return None;
      }
      *budget -= 1;
      let mut any = |items: &mut dyn Iterator<Item = &Value<S>>| -> Option<bool> {
        for item in items {
          if holds_capture(item, scope, budget)? {
            return Some(true);
          }
        }
        Some(false)
      };
      match value {
        Value::Function(Function::Lambda(lambda)) => {
          Some(lambda.captured_env.as_ref().is_some_and(|captured| Rc::ptr_eq(captured, scope)))
        }
        Value::List(list) => any(&mut list.items.iter()),
        Value::Map(map) => any(&mut map.values()),
        _ => Some(false),
      }
    }
    fn walk<S: Symbol>(
      value: &Value<S>,
      scope: &Rc<RefCell<Env<S>>>,
      budget: &mut usize,
      found: &mut usize,
    ) -> bool {
      if *budget == 0 {
        return false;
      }
      *budget -= 1;
      match value {
        Value::Function(Function::Lambda(lambda)) => {
          if lambda
            .captured_env
            .as_ref()
            .is_some_and(|captured| Rc::ptr_eq(captured, scope))
          {
            // Held by anything besides this binding — the caller's result,
            // a list/map that outlives the frame, a host callback — means a
            // live closure still needs these bindings.
            if Rc::strong_count(lambda) > 1 {
              return false;
            }
            *found += 1;
          }
          true
        }
        // A list or map another value also holds may be the very copy that
        // escaped (`(let ((box (list (lambda () secret)))) box)` binds the
        // list and returns it): what it holds counts as held elsewhere.
        // Out of budget is unknown, which keeps the scope.
        Value::List(list) if list.items.is_shared() => holds_capture(value, scope, budget) == Some(false),
        Value::Map(map) if map.is_shared() => holds_capture(value, scope, budget) == Some(false),
        Value::List(list) => list
          .items
          .iter()
          .all(|item| walk(item, scope, budget, found)),
        Value::Map(map) => map.values().all(|item| walk(item, scope, budget, found)),
        _ => true,
      }
    }
    let mut budget = CAPTURE_WALK_LIMIT;
    let mut found = 0;
    self
      .values
      .values()
      .all(|value| walk(value, scope, &mut budget, &mut found))
      .then_some(found)
  }

  /// Visible bindings, with lexical shadowing applied before module discovery.
  pub(crate) fn visible_bindings(&self) -> Vec<(S, Value<S>)> {
    fn collect<S: Symbol>(env: &Env<S>, into: &mut SymMap<S, Value<S>>) {
      if let Some(parent) = &env.parent { collect(&parent.borrow(), into); }
      for symbol in &env.uninitialized { into.remove(symbol); }
      match &env.values {
        Bindings::Small(pairs) => { for (name, value) in pairs { into.insert(*name, value.clone()); } },
        Bindings::Table(map) => { for (name, value) in map { into.insert(*name, value.clone()); } },
      }
    }
    let mut values = SymMap::default();
    collect(self, &mut values);
    values.into_iter().collect()
  }

  pub fn visible_values(&self) -> Vec<Value<S>> {
    self
      .visible_bindings()
      .into_iter()
      .map(|(_, value)| value)
      .collect()
  }

  /// [`Env::get`] without the copy: `read` sees the bound value where it
  /// lives.
  pub(crate) fn with_value<R>(&self, symbol: S, read: impl FnOnce(&Value<S>) -> R) -> Option<R> {
    if let Some(val) = self.values.get(symbol) {
      Some(read(val))
    } else if self.uninitialized.contains(&symbol) {
      None
    } else if let Some(parent) = &self.parent {
      parent.borrow().with_value(symbol, read)
    } else {
      None
    }
  }

  pub fn get(&self, symbol: S) -> Option<Value<S>> {
    if let Some(val) = self.values.get(symbol) {
      Some(val.clone())
    } else if self.uninitialized.contains(&symbol) {
      None
    } else if let Some(parent) = &self.parent {
      parent.borrow().get(symbol)
    } else {
      None
    }
  }

  pub(crate) fn reserve_parameters(&mut self, symbols: &[S]) {
    self.uninitialized.extend_from_slice(symbols);
  }

  pub(crate) fn is_uninitialized(&self, symbol: S) -> bool {
    if self.values.contains(symbol) { false }
    else if self.uninitialized.contains(&symbol) { true }
    else { self.parent.as_ref().is_some_and(|parent| parent.borrow().is_uninitialized(symbol)) }
  }

  pub fn set(&mut self, symbol: S, value: Value<S>) -> Result<(), S> {
    if self.uninitialized.contains(&symbol) { return Err(symbol); }
    if self.values.contains(symbol) {
      self.values.insert(symbol, value);
      Ok(())
    } else if let Some(parent) = &self.parent {
      parent.borrow_mut().set(symbol, value)
    } else {
      Err(symbol)
    }
  }

  /// Set `symbol` to `nil` if THIS scope binds it, so its value loses this
  /// holder; whether it did. A `nil` binding, not a removal: a later lookup
  /// must not fall through to an outer binding of the same name.
  pub(crate) fn release_own(&mut self, symbol: S) -> bool {
    if !self.values.contains(symbol) {
      return false;
    }
    self.values.insert(symbol, Value::Nil);
    true
  }

  pub(crate) fn observed(&self) -> bool {
    self.observed.get()
  }

  /// `test` of the value THIS scope binds `symbol` to, or `None` when the
  /// binding is not here.
  pub(crate) fn own_binding(&self, symbol: S, test: impl FnOnce(&Value<S>) -> bool) -> Option<bool> {
    self.values.get(symbol).map(test)
  }

  pub(crate) fn parent(&self) -> Option<Rc<RefCell<Env<S>>>> {
    self.parent.clone()
  }

  pub(crate) fn parent_ref(&self) -> Option<&Rc<RefCell<Env<S>>>> {
    self.parent.as_ref()
  }

  pub fn define(&mut self, symbol: S, value: Value<S>) {
    self.uninitialized.retain(|name| *name != symbol);
    self.values.insert(symbol, value);
  }

  pub fn undefine(&mut self, symbol: S) {
    if self.values.contains(symbol) {
      self.values.remove(symbol);
    } else if let Some(parent) = &self.parent {
      parent.borrow_mut().undefine(symbol);
    }
  }

  /// Drop every binding of THIS scope (the parent is untouched). A lambda
  /// defined into the scope it captured — every top-level `(let f (lambda …))`
  /// — makes an `Rc` cycle (scope → lambda → scope) that `Drop` alone never
  /// frees; an owner that is done with a scope clears it to break them. A
  /// script host run once per fleet refresh leaked its whole run this way
  /// (2026-09-09: 5–8 MB per run, a gigabyte an hour in a sidebar).
  pub fn clear(&mut self) {
    self.values = Bindings::Small(Vec::new());
    self.uninitialized.clear();
  }
}

impl<S: Symbol> Env<S> {
  pub fn new() -> Self {
    #[cfg(test)]
    LIVE_SCOPES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Self {
      parent: None,
      values: Bindings::Small(Vec::new()),
      uninitialized: Vec::new(),
      observed: std::cell::Cell::new(true),
    }
  }
}

/// A scope whose body has run. When every reference to it besides the
/// caller's comes from lambdas the scope itself holds — a recursive helper
/// bound by `let`, a render's frame of helper lambdas beside the rows it
/// built — the scope is a cycle nothing outside can reach, and `Rc` would
/// keep it, and everything it binds, forever: a sidebar leaked ~3 MB per
/// keypress this way (2026-09-09). Clear it. A scope a closure escaped from
/// (returned, stored in a global) is left alone: the count says something
/// outside still needs it.
pub fn release_scope<S: Symbol>(scope: &Rc<RefCell<Env<S>>>) {
  let others = Rc::strong_count(scope) - 1;
  if others == 0 {
    return;
  }
  let Ok(held) = scope.try_borrow().map(|env| env.captures_of(scope)) else {
    return;
  };
  if held == Some(others) {
    if let Ok(mut env) = scope.try_borrow_mut() {
      env.clear();
    }
  }
}

#[derive(Clone)]
pub struct Lambda<S: Symbol> {
  pub params: Vec<S>,
  /// Present only for explicitly typed user functions. Untyped closures keep
  /// their existing positional calling convention.
  pub signature: Option<crate::types::Signature>,
  /// Unevaluated defaults, aligned with params; evaluated in the call frame.
  pub defaults: Vec<Option<Value<S>>>,
  /// Body forms — evaluated in sequence, last value is the result.
  /// Multi-form bodies are common for `(define (f x) … …)` and
  /// `(lambda (x) … …)`.
  pub body: Vec<Value<S>>,
  /// Env captured at `(lambda ...)` evaluation time. `None` for
  /// lambdas that don't carry a closure (built or registered without
  /// going through `eval`).
  pub captured_env: Option<Rc<RefCell<Env<S>>>>,
}

impl<S: Symbol + std::fmt::Debug> std::fmt::Debug for Lambda<S> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("Lambda")
      .field("params", &self.params)
      .finish()
  }
}

/// A native function of its arguments alone.
///
/// It never sees the caller's scope, so calling one leaves a lambda's frame
/// releasable ([`crate::tail`]). A native that needs the scope is a
/// [`NativeClosure`].
pub type NativeFn<S> = fn(Vec<Value<S>>) -> std::result::Result<Value<S>, RuntimeError>;

/// Reference-counted closure-bearing native. Use this when the registered
/// function needs to capture host state (a `RefCell<TuiState>`, a tokio
/// `Handle`, etc.) — `NativeFn` is a bare `fn` pointer and can't.
///
/// `Rc<dyn Fn>` is `Clone` (cheap clone of the refcount), which keeps
/// `Function<S>: Clone` derivable.
pub type NativeClosure<S> =
  Rc<dyn Fn(Rc<RefCell<Env<S>>>, Vec<Value<S>>) -> std::result::Result<Value<S>, RuntimeError>>;

/// One thing a receiver registered, paired with the inverse that removes it.
///
/// The member list IS the disposer list: `@import` mounts a bundle's receiver,
/// and unmounting runs these in reverse — the VS Code `context.subscriptions`
/// shape. A registration with no `undo` is a review reject; that is the rule
/// core-boundary guarantee 1 states, made structural.
pub struct Member {
  /// The selector that created it, for reporting what a dispose gave back.
  pub selector: String,
  /// A human label (the lane name, the palette entry id …).
  pub label: String,
  /// The inverse. `None` marks an ESCAPED registration — one that cannot be
  /// taken back (a spawned child, a listener on a port). Dispose reports these
  /// by name rather than pretending; see the tier-3 rule.
  pub undo: Option<Box<dyn FnOnce()>>,
}

/// A RECEIVER: the object registrations are methods on.
///
/// The session root and a mounted bundle are the same kind of thing, differing
/// only in which selectors their table carries — that is how a prohibition
/// becomes API shape rather than a name check. A bundle receiver simply has no
/// `:lane.declare` entry, so it cannot declare a lane; there is nothing to
/// enforce and no string to compare.
///
/// The receiver reaches the language as a `Function::NativeClosure` so it is
/// callable in head position with no parser change: `(m :palette.add …)`
/// dispatches on the first argument, Obj-C `[recv sel:arg]`.
pub struct ReceiverState<S: Symbol> {
  /// What this receiver is called in errors (`shell`, or a bundle's alias).
  pub name: String,
  /// Selector → implementation. Absence IS the prohibition.
  pub selectors: IndexMap<String, NativeClosure<S>>,
  /// What was registered through it, in order. Dispose walks it backwards.
  pub members: RefCell<Vec<Member>>,
}

impl<S: Symbol> ReceiverState<S> {
  /// The selector names this receiver answers, sorted — the `respondsTo`
  /// half, used to make a miss teach rather than merely refuse.
  pub fn selector_names(&self) -> Vec<String> {
    let mut names: Vec<String> = self.selectors.keys().cloned().collect();
    names.sort();
    names
  }
}

#[derive(Clone)]
pub enum Function<S: Symbol> {
  NativeFn(NativeFn<S>),
  NativeClosure(NativeClosure<S>),
  TypedNative(Rc<crate::types::TypedNative<S>>),
  /// Rc'd: a lambda VALUE is cloned on every environment lookup that
  /// resolves it (`Env::get` returns owned), which used to deep-copy the
  /// whole body AST per call — the interpreter's dominant clone churn on a
  /// scene-render workload (a six-cell row lambda re-copied hundreds of
  /// times per repaint). The body is immutable after construction, so an
  /// Rc bump is the whole cost now.
  Lambda(Rc<Lambda<S>>),
}

impl<S: Symbol + Debug> Debug for Function<S> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Function::NativeFn(fp) => f
        .debug_tuple("NativeFn")
        .field(&format_args!("{:p}", fp))
        .finish(),
      Function::NativeClosure(rc) => f
        .debug_tuple("NativeClosure")
        .field(&format_args!("{:p}", Rc::as_ptr(rc)))
        .finish(),
      Function::TypedNative(native) => native.fmt(f),
      Function::Lambda(l) => f.debug_tuple("Lambda").field(l).finish(),
    }
  }
}

#[derive(Clone, Debug)]
pub struct List<S: Symbol> {
  pub items: crate::value::Shared<Vec<Value<S>>>,
}

#[cfg(test)]
mod eval_bench {
  /// Scene-shaped eval microbench: a cell/row lambda pair mapped over a
  /// 55-row viewport of records, repeated — the shape of one terminals
  /// keystroke repaint, engine-local so interpreter wins are attributable
  /// without any scene machinery in the loop.
  ///
  /// `EVAL_BENCH_PAINTS=N cargo test -p tento-lisp eval_bench --release --
  /// --ignored --nocapture`
  #[test]
  #[ignore]
  fn eval_bench_scene_workload() {
    use string_interner::symbol::SymbolU32;
    let paints: usize = std::env::var("EVAL_BENCH_PAINTS")
      .ok()
      .and_then(|v| v.parse().ok())
      .unwrap_or(200);
    let src = format!(
      r#"
      (define (cell text style) (hash-map "text" text "style" style))
      (define (row s i cursor)
        (let ((id (get s "id"))
              (current (get s "current"))
              (at (= i cursor)))
          ((cell (if current "x" "") (if current "green" (if at "white" "none")))
           (cell (concat "> " id) (if at "white" "none"))
           (cell (get s "state") "green")
           (cell (get s "engine") "green")
           (cell (concat "" (get s "panes")) "none")
           (cell "3d" "dimmed"))))
      (define records
        (map
          (lambda (i)
            (hash-map "id" (concat "term-" i) "state" "live" "engine" "live"
                      "panes" 1 "current" (= i 0)))
          (range 60)))
      (map
        (lambda (k)
          (length (map (lambda (i) (row (nth records i) i 3)) (range 55))))
        (range {paints}))
    "#
    );
    let started = std::time::Instant::now();
    let values = crate::Runtime::<SymbolU32>::eval(None, &src).expect("bench evals");
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    assert!(matches!(&values.last(), Some(crate::Value::List(_))));
    eprintln!(
      "[eval-bench] {paints} paints of 55 rows: {ms:.1}ms total, {:.3}ms/paint",
      ms / paints as f64
    );
  }
}
