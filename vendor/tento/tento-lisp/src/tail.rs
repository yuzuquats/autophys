//! Releasing a binding at its last read in a dying frame.
//!
//! A lambda frame dies when its body's last expression finishes, and inside
//! that expression evaluation runs in order: once a call's arguments are
//! evaluated, a name read there for the last time is dead in the frame. The
//! frame still holds its value, though, so the callee gets a second reference
//! and a copy-on-write write (`conj`, `assoc`, `dissoc`) copies the whole
//! collection. `(reduce (lambda (acc x) (conj acc x)) [] xs)` was quadratic
//! for exactly that reason, while `(reduce conj [] xs)` was linear.
//!
//! [`Tail`] is the context of an expression on a lambda body's tail spine:
//! the last body form, through the taken branch of `if` and `cond`, the body
//! of `let` and `begin`, and the arguments of a call on that spine. Before an
//! in-place writer or a captured lambda runs, a call on the spine sets each
//! bare-name argument's binding to `nil` in its dying frame, so the callee
//! holds the only reference. That is sound only when nothing can read the
//! binding afterwards (operator decision A-Q1, 2026-10-20):
//!
//! 1. **Nothing untrusted has seen the frame.** A scope is marked observed
//!    ([`crate::eval::mark_observed`]) when a closure captures it, or when it
//!    is handed to a callee the interpreter cannot vouch for: a native that
//!    is neither tento-lisp's stdlib nor declared env-blind by its host, or a
//!    lambda without a captured scope, which resolves names in its caller's.
//!    A native that kept the scope, or a closure that may run after the
//!    frame returns, is therefore always behind an observed mark.
//! 2. **Only trusted code runs before the frame dies.** Every enclosing call
//!    on the spine is to a trusted callee, and every expression the spine
//!    still evaluates is plain ([`Interpreter::plain`]): a literal, a bound
//!    non-dotted name other than the released one, or a call of a trusted
//!    callee on plain arguments. A later unbound name could reach the
//!    missing-symbol or call-head hooks; a dotted one, the dot sugar or a
//!    deprecated alias of the released name.
//!
//! Every other special form ends the spine.

use std::cell::RefCell;
use std::rc::Rc;

use crate::Value;
use crate::eval::{Env, Function, NativeClosure};
use crate::interpreter::Interpreter;
use crate::symbol::{Backend, Symbol};

/// Where an expression sits on a lambda body's tail spine.
///
/// Borrowed and `Copy`: evaluation is strictly nested, so the nodes it
/// points at ([`LetFrame`], [`Later`]) live on the Rust stack of the forms
/// that opened them, and entering the spine allocates nothing.
#[derive(Clone, Copy)]
pub(crate) struct Tail<'t, S: Symbol> {
  /// The lambda's own frame, which dies with this expression. Identity
  /// only; holding a strong reference would change the count
  /// [`crate::eval::release_scope`] reads.
  frame: *const RefCell<Env<S>>,
  /// The `let` frames opened on the spine, which die with it too.
  lets: Option<&'t LetFrame<'t, S>>,
  /// The enclosing calls on the spine: their later arguments and callees.
  later: Option<&'t Later<'t, S>>,
}

/// A `let` frame opened on the spine, and the ones it is nested in.
pub(crate) struct LetFrame<'t, S: Symbol> {
  scope: *const RefCell<Env<S>>,
  up: Option<&'t LetFrame<'t, S>>,
}

/// One enclosing call on the spine: the arguments it evaluates after the one
/// being evaluated, whether its callee is trusted, and the calls around it.
pub(crate) struct Later<'t, S: Symbol> {
  rest: &'t [Value<S>],
  /// Remaining arguments run in this call's scope, which can differ from
  /// the scope of a nested writer inside a spine `let`.
  env: &'t Rc<RefCell<Env<S>>>,
  /// Its trust is asked only when a release is attempted.
  callee: &'t Function<S>,
  up: Option<&'t Later<'t, S>>,
}

impl<'t, S: Symbol> Tail<'t, S> {
  /// The last form of a lambda's body, evaluated in `scope`.
  pub(crate) fn body(scope: &Rc<RefCell<Env<S>>>) -> Self {
    Tail {
      frame: Rc::as_ptr(scope),
      lets: None,
      later: None,
    }
  }

  /// The node for a `let` frame opened on the spine.
  pub(crate) fn let_frame(&self, scope: &Rc<RefCell<Env<S>>>) -> LetFrame<'t, S> {
    LetFrame {
      scope: Rc::as_ptr(scope),
      up: self.lets,
    }
  }

  /// The body of a `let` on the spine: its frame dies with the spine too.
  pub(crate) fn within<'u>(&self, frame: &'u LetFrame<'t, S>) -> Tail<'u, S>
  where
    't: 'u,
  {
    Tail {
      lets: Some(frame),
      ..*self
    }
  }

  /// The node for a call on the spine whose argument is about to be
  /// evaluated, with `rest` after it.
  pub(crate) fn later(
    &self,
    rest: &'t [Value<S>],
    callee: &'t Function<S>,
    env: &'t Rc<RefCell<Env<S>>>,
  ) -> Later<'t, S> {
    Later {
      rest,
      env,
      callee,
      up: self.later,
    }
  }

  /// An argument of a call on the spine.
  pub(crate) fn argument<'u>(&self, later: &'u Later<'t, S>) -> Tail<'u, S>
  where
    't: 'u,
  {
    Tail {
      later: Some(later),
      ..*self
    }
  }

  fn dies(&self, scope: &RefCell<Env<S>>) -> bool {
    let scope: *const RefCell<Env<S>> = scope;
    if scope == self.frame {
      return true;
    }
    let mut lets = self.lets;
    while let Some(frame) = lets {
      if frame.scope == scope {
        return true;
      }
      lets = frame.up;
    }
    false
  }
}

/// The callees that cannot read or keep the scope they are handed.
///
/// A [`crate::eval::NativeFn`] never does: its type gives it only the
/// arguments. A host declares the
/// closures it builds without the scope ([`Interpreter::declare_env_blind`]);
/// tento-lisp-cmd's `register_native_special` hands its natives only their
/// arguments. Declared closures are kept alive here, so a freed one's address
/// cannot be reused by an untrusted closure.
pub(crate) struct Trust<S: Symbol> {
  closures: PointerSet,
  kept: Vec<NativeClosure<S>>,
}

impl<S: Symbol> Default for Trust<S> {
  fn default() -> Self {
    Trust {
      closures: PointerSet::default(),
      kept: Vec::new(),
    }
  }
}

impl<S: Symbol> Trust<S> {
  pub(crate) fn declare(&mut self, closure: &NativeClosure<S>) {
    if self
      .closures
      .insert(Rc::as_ptr(closure) as *const () as usize)
    {
      self.kept.push(closure.clone());
    }
  }

  fn closure(&self, closure: &NativeClosure<S>) -> bool {
    self
      .closures
      .contains(Rc::as_ptr(closure) as *const () as usize)
  }

  /// Whether `func` can neither read nor keep the scope it is called in.
  pub(crate) fn trusted(&self, func: &Function<S>) -> bool {
    match func {
      Function::NativeFn(_) => true,
      Function::NativeClosure(closure) => self.closure(closure),
      Function::TypedNative(native) => self.closure(&native.body),
      Function::Lambda(lambda) => lambda.captured_env.is_some(),
    }
  }
}

/// A set of addresses, open-addressed: every native call asks it, so a
/// lookup is a multiply, a shift and usually one compare.
#[derive(Default)]
struct PointerSet {
  slots: Vec<usize>,
  len: usize,
}

impl PointerSet {
  fn slot(&self, at: usize) -> usize {
    let bits = self.slots.len().trailing_zeros();
    at.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> (usize::BITS - bits)
  }

  fn contains(&self, at: usize) -> bool {
    if self.slots.is_empty() {
      return false;
    }
    let mask = self.slots.len() - 1;
    let mut index = self.slot(at);
    loop {
      match self.slots[index] {
        0 => return false,
        held if held == at => return true,
        _ => index = (index + 1) & mask,
      }
    }
  }

  /// Add `at` (an address, never 0); whether it was new.
  fn insert(&mut self, at: usize) -> bool {
    if self.contains(at) {
      return false;
    }
    if (self.len + 1) * 2 > self.slots.len() {
      let held: Vec<usize> = self
        .slots
        .iter()
        .copied()
        .filter(|&slot| slot != 0)
        .collect();
      self.slots = vec![0; (self.slots.len() * 2).max(16)];
      self.len = 0;
      for slot in held {
        self.place(slot);
      }
    }
    self.place(at);
    true
  }

  fn place(&mut self, at: usize) {
    let mask = self.slots.len() - 1;
    let mut index = self.slot(at);
    while self.slots[index] != 0 {
      index = (index + 1) & mask;
    }
    self.slots[index] = at;
    self.len += 1;
  }
}

/// Whether releasing an argument before calling `func` can save a copy: a
/// lambda with a captured scope (it may hand the value on down its own
/// spine), or a native that writes its collection argument in place.
pub(crate) fn writes_in_place<S: Symbol>(func: &Function<S>) -> bool {
  use crate::stdlib::{lists, maps};
  match func {
    Function::Lambda(lambda) => lambda.captured_env.is_some(),
    Function::NativeFn(native) => {
      let is = |other: crate::eval::NativeFn<S>| std::ptr::fn_addr_eq(*native, other);
      is(lists::conj::<S>)
        || is(lists::append::<S>)
        || is(maps::assoc::<S>)
        || is(maps::dissoc::<S>)
        || is(maps::json_set::<S>)
        || is(maps::json_set_in::<S>)
    }
    _ => false,
  }
}

/// The special forms' names (`Interpreter::eval_special_form`). A call whose
/// head is one of them is never plain, whatever the name is bound to: the
/// form runs, not the binding. A test keeps this list complete.
pub(crate) const SPECIAL_FORMS: &[&str] = &[
  "struct",
  "trait",
  "impl",
  "type",
  "trait.describe",
  "trait.conforms",
  "trait.check",
  "trait.impls",
  "trait.report",
  "module.name",
  "module.bundle",
  "quote",
  "if",
  "begin",
  "define",
  "def",
  "defun",
  "fn",
  "set",
  "set!",
  "lambda",
  "let",
  "cond",
  "and",
  "or",
  "match",
  "try",
  "std.stream.with",
  "unwrap",
  "expect",
  "map",
  "filter",
  "reduce",
  "fold",
  "group-by",
  "apply",
  "json-from-list",
  "@import",
  "use",
  "cfg?",
  "cfg",
  "@cfg",
];

impl<S: Symbol, B: Backend<S>> Interpreter<S, B> {
  /// Before `func` runs in `env`: mark the scope observed unless `func` is
  /// trusted (rule 1).
  pub(crate) fn note_call(&self, env: &Rc<RefCell<Env<S>>>, func: &Function<S>) {
    // Trust first: most calls are to stdlib natives, and the lookup is
    // cheaper than borrowing the scope.
    if !self.trust.trusted(func) && !env.borrow().observed() {
      crate::eval::mark_observed(env);
    }
  }

  /// Release every bare-name argument in `args` that nothing can read again,
  /// so a `writer` callee holds the only reference to its value. Called after
  /// the arguments are evaluated and before the callee runs.
  pub(crate) fn release_last_reads(
    &self,
    tail: &Tail<'_, S>,
    env: &Rc<RefCell<Env<S>>>,
    writer: bool,
    calls_ok: bool,
    args: &[Value<S>],
  ) {
    if !writer || !self.continuation_trusted(tail) {
      return;
    }
    for arg in args {
      let Value::Symbol(sym) = arg else { continue };
      let sym = sym.as_symbol();
      // Cheapest first: only a list or a map bound in a dying, unobserved
      // frame has a copy-on-write write to save.
      if self.dying_collection(tail, env, sym) && self.later_plain(tail, calls_ok, sym) {
        release_in(env, sym);
      }
    }
  }

  /// Whether every enclosing call on the spine is to a trusted callee.
  fn continuation_trusted(&self, tail: &Tail<'_, S>) -> bool {
    let mut later = tail.later;
    while let Some(node) = later {
      if !self.trust.trusted(node.callee) {
        return false;
      }
      later = node.up;
    }
    true
  }

  /// Whether `sym` resolves in a dying frame nothing untrusted has seen, to
  /// a list or a map. A lookup that reaches a frame which outlives the spine
  /// stops. Borrows only.
  fn dying_collection(&self, tail: &Tail<'_, S>, scope: &RefCell<Env<S>>, sym: S) -> bool {
    if !tail.dies(scope) {
      return false;
    }
    let env = scope.borrow();
    match env.own_binding(sym, |value| matches!(value, Value::List(_) | Value::Map(_))) {
      Some(collection) => collection && !env.observed(),
      None => env
        .parent_ref()
        .is_some_and(|parent| self.dying_collection(tail, parent, sym)),
    }
  }

  /// Whether every expression the spine still evaluates is plain (rule 2).
  /// Calls are admissible only while every intervening callee is a plain
  /// native: a captured lambda can change a previously checked global head.
  fn later_plain(&self, tail: &Tail<'_, S>, mut calls_ok: bool, sym: S) -> bool {
    let mut later = tail.later;
    while let Some(node) = later {
      if !node
        .rest
        .iter()
        .all(|expression| self.plain(node.env, expression, sym, calls_ok))
      {
        return false;
      }
      // The enclosing call runs before the next node's remaining arguments.
      // Captured lambdas and declared env-blind closures may rebind names or
      // run Lisp even though they cannot read this dying frame directly.
      calls_ok &= matches!(node.callee, Function::NativeFn(_));
      later = node.up;
    }
    true
  }

  /// Whether evaluating `expression` in `env` can neither read `sym` nor
  /// reach code that might: a literal, a bound non-dotted name other than
  /// `sym`, or a call of a trusted callee on plain arguments.
  fn plain(
    &self,
    env: &Rc<RefCell<Env<S>>>,
    expression: &Value<S>,
    sym: S,
    calls_ok: bool,
  ) -> bool {
    match expression {
      Value::Nil | Value::Boolean(_) | Value::Integer(_) | Value::Float(_) | Value::String(_) => {
        true
      }
      Value::TaggedString { .. } => true,
      Value::Symbol(name) => self.plain_name(env, name.as_symbol(), sym),
      Value::List(list) => {
        let Some((head, rest)) = list.items.split_first() else {
          return true;
        };
        if !calls_ok {
          return false;
        }
        let Value::Symbol(head) = head else {
          return false;
        };
        let head = head.as_symbol();
        let Some(name) = self.interner.resolve(head) else {
          return false;
        };
        if head == sym || name.contains('.') || SPECIAL_FORMS.contains(&name) {
          return false;
        }
        // Every nested call must also be unable to run Lisp or rebind names:
        // a captured lambda in one argument could change a later argument's
        // head even when the outer call itself is a plain native.
        let callee = env.borrow().with_value(head, |value| {
          matches!(value, Value::Function(Function::NativeFn(_)))
        });
        callee == Some(true) && rest.iter().all(|arg| self.plain(env, arg, sym, true))
      }
      _ => false,
    }
  }

  fn plain_name(&self, env: &Rc<RefCell<Env<S>>>, name: S, sym: S) -> bool {
    if name == sym {
      return false;
    }
    let Some(text) = self.interner.resolve(name) else {
      return false;
    };
    if text.starts_with(':') || text.starts_with('#') || text == "nil" || text == "null" {
      return true;
    }
    !text.contains('.') && env.borrow().with_value(name, |_| ()).is_some()
  }
}

/// Set `sym` to `nil` in the first frame from `scope` up that binds it: the
/// one [`Interpreter::dying_collection`] found.
fn release_in<S: Symbol>(scope: &RefCell<Env<S>>, sym: S) {
  if scope.borrow_mut().release_own(sym) {
    return;
  }
  let parent = scope.borrow().parent();
  if let Some(parent) = parent {
    release_in(&parent, sym);
  }
}

#[cfg(test)]
mod tests {
  use std::cell::RefCell;
  use std::rc::Rc;

  use string_interner::backend::StringBackend;
  use string_interner::symbol::SymbolU32;

  use crate::eval::{Env, Function, Lambda, NativeClosure};
  use crate::value::SHARED_COPIES;
  use crate::{Interpreter, Runtime, Value};

  type Interp = Interpreter<SymbolU32, StringBackend>;
  type Scope = Rc<RefCell<Env<SymbolU32>>>;

  /// The last value of `source`, printed, and how many copies a shared write
  /// made while it ran, after `setup` has prepared the interpreter and scope.
  fn run_with(source: &str, setup: impl FnOnce(&mut Interp, &Scope)) -> (String, usize) {
    let mut interp = Interp::new();
    let env = interp.default_env();
    setup(&mut interp, &env);
    let asts = Runtime::<SymbolU32, StringBackend>::parse(None, source, interp.string_interner())
      .expect("parse");
    let before = SHARED_COPIES.with(|copies| copies.get());
    let mut last = Value::Nil;
    for ast in asts {
      let value = Value::from_sexpression(&ast).expect("from_sexpression");
      last = interp.eval_expression(env.clone(), &value).expect("eval");
    }
    let copies = SHARED_COPIES.with(|copies| copies.get()) - before;
    (format!("{last:?}"), copies)
  }

  fn run(source: &str) -> (String, usize) {
    run_with(source, |_, _| {})
  }

  fn same(program: &str, expected: &str) {
    assert_eq!(run(program).0, run(expected).0, "{program}");
  }

  fn define(interp: &mut Interp, env: &Scope, name: &str, value: Value<SymbolU32>) {
    let sym = interp.string_interner().get_or_intern(name);
    env.borrow_mut().define(sym, value);
  }

  /// A native that reads `a` from the scope it is called in.
  fn spy(interp: &mut Interp, env: &Scope) {
    let a = interp.string_interner().get_or_intern("a");
    let closure: NativeClosure<SymbolU32> =
      Rc::new(move |env, _| Ok(env.borrow().get(a).unwrap_or(Value::Nil)));
    define(
      interp,
      env,
      "spy",
      Value::Function(Function::NativeClosure(closure)),
    );
  }

  /// An accumulation program, and the count it answers for `N` items.
  type Idiom = (&'static str, fn(i64) -> i64);

  /// Each accumulation idiom copies its accumulator the same number of times
  /// at 400 items as at 40, and answers the right count.
  #[test]
  fn accumulating_copies_nothing_per_item() {
    let idioms: [Idiom; 12] = [
      (
        "(len (reduce (lambda (acc x) (conj acc x)) [] (range N)))",
        |n| n,
      ),
      (
        "(len (keys (reduce (lambda (acc x) (assoc acc (str x) x)) {} (range N))))",
        |n| n,
      ),
      (
        "(len (keys (reduce (lambda (acc x) (json-set acc (str x) x)) {} (range N))))",
        |n| n,
      ),
      (
        "(len (reduce (lambda (acc x) (append acc [x])) [] (range N)))",
        |n| n,
      ),
      (
        "(len (reduce (lambda (acc x) (if (= 0 (% x 2)) (conj acc x) acc)) [] (range N)))",
        |n| n / 2,
      ),
      (
        "(len (reduce (lambda (acc x) (cond ((= x -1) acc) (else (conj acc x)))) [] (range N)))",
        |n| n,
      ),
      (
        "(len (reduce (lambda (acc x) (let ((y (* x 2))) (conj acc y))) [] (range N)))",
        |n| n,
      ),
      (
        "(len (reduce (lambda (acc x) (begin (+ x 1) (conj acc x))) [] (range N)))",
        |n| n,
      ),
      (
        "(len (reduce (lambda (acc x) (let y x) (conj acc y)) [] (range N)))",
        |n| n,
      ),
      (
        "(defun build (acc n) (if (= n 0) acc (build (conj acc n) (- n 1))))\n(len (build [] N))",
        |n| n,
      ),
      (
        "(begin (fn step (acc any x s64) -> any (conj acc x)) (len (reduce (lambda (acc x) (step acc x)) [] (range N))))",
        |n| n,
      ),
      (
        "(len (keys (reduce (lambda (m x) (dissoc m (str x))) \
          (reduce (lambda (acc x) (assoc acc (str x) x)) {} (range N)) (range N))))",
        |_| 0,
      ),
    ];
    // The recursion idiom nests 400 calls deep, beyond a debug test
    // thread's stack.
    let check = move || {
      for (idiom, count) in idioms {
        let (small_value, small) = run(&idiom.replace('N', "40"));
        let (large_value, large) = run(&idiom.replace('N', "400"));
        assert_eq!(small_value, run(&count(40).to_string()).0, "{idiom}");
        assert_eq!(large_value, run(&count(400).to_string()).0, "{idiom}");
        assert_eq!(small, large, "copies grow with the item count: {idiom}");
      }
    };
    std::thread::Builder::new()
      .stack_size(256 << 20)
      .spawn(check)
      .unwrap()
      .join()
      .unwrap();
  }

  /// A native its host declared env-blind leaves the frame releasable; an
  /// undeclared one marks it observed, and the accumulation copies again.
  #[test]
  fn only_a_declared_env_blind_native_keeps_the_release() {
    let idiom =
      |n: usize| format!("(len (reduce (lambda (acc x) (conj acc (tag x))) [] (range {n})))");
    let tag = |declare: bool| {
      move |interp: &mut Interp, env: &Scope| {
        let closure: NativeClosure<SymbolU32> =
          Rc::new(|_, args| Ok(args.into_iter().next().unwrap_or(Value::Nil)));
        if declare {
          interp.declare_env_blind(&closure);
        }
        define(
          interp,
          env,
          "tag",
          Value::Function(Function::NativeClosure(closure)),
        );
      }
    };
    let (_, blind_small) = run_with(&idiom(40), tag(true));
    let (_, blind_large) = run_with(&idiom(400), tag(true));
    assert_eq!(
      blind_small, blind_large,
      "a declared env-blind native keeps the accumulation linear"
    );
    let (value, unknown_small) = run_with(&idiom(40), tag(false));
    let (_, unknown_large) = run_with(&idiom(400), tag(false));
    assert_eq!(value, run("40").0);
    assert!(
      unknown_large > unknown_small,
      "an undeclared native must disable the release"
    );
  }

  /// A host's own `NativeFn` (tento-lisp-cmd overrides `=`, `-` and others)
  /// keeps the release, as a stdlib native does: its type, not its address,
  /// makes it trusted.
  #[test]
  fn a_host_native_fn_keeps_the_release() {
    fn host_sub(args: Vec<Value<SymbolU32>>) -> Result<Value<SymbolU32>, crate::RuntimeError> {
      crate::arith::isub(args)
    }
    let host = |interp: &mut Interp, env: &Scope| {
      define(
        interp,
        env,
        "-",
        Value::Function(Function::NativeFn(host_sub)),
      )
    };
    let idiom =
      |n: usize| format!("(len (reduce (lambda (acc x) (conj acc (- x 1))) [] (range {n})))");
    let (value, small) = run_with(&idiom(40), host);
    let (_, large) = run_with(&idiom(400), host);
    assert_eq!(value, run("40").0);
    assert_eq!(small, large, "a host NativeFn must not disable the release");
  }

  /// A name read again after the call keeps its value.
  #[test]
  fn a_later_read_keeps_the_value() {
    same("((lambda (a) (list (conj a 2) a)) [1])", "(list [1 2] [1])");
    same("((lambda (a) (list a (conj a 2))) [1])", "(list [1] [1 2])");
    same("((lambda (a) (conj a a)) [1])", "(list 1 [1])");
    same(
      "((lambda (a) (list (let ((a [9])) (conj a 1)) a)) [1])",
      "(list [9 1] [1])",
    );
  }

  /// Every closure keeps the frame, however it was made (review R1–R3).
  #[test]
  fn a_closure_keeps_the_frame() {
    same(
      "((lambda (a) (let ((g (lambda () a))) (list (conj a 2) (g)))) [1])",
      "(list [1 2] [1])",
    );
    same(
      "((lambda (a) (define (g) a) (list (conj a 2) (g))) [1])",
      "(list [1 2] [1])",
    );
    same(
      "(begin (let saved nil) ((lambda (a) (define (g) a) (set saved g) (conj a 2)) [1]) (saved))",
      "[1]",
    );
    same(
      "((lambda (a any trigger: s64 = (begin (let g (lambda () a)) 0)) -> any (list (conj a 2) (g))) [1])",
      "(list [1 2] [1])",
    );
    same(
      "((lambda (a.b) (let g (lambda () a.b)) (list (conj a.b 2) (g))) [1])",
      "(list [1 2] [1])",
    );
  }

  /// A native that reads the frame, before or after the release, sees the
  /// value (review R4).
  #[test]
  fn a_native_reading_the_frame_keeps_the_value() {
    let expect = |program: &str, expected: &str| {
      assert_eq!(run_with(program, spy).0, run(expected).0, "{program}");
    };
    expect("((lambda (a) (spy (conj a 2))) [1])", "[1]");
    expect(
      "((lambda (a) (list (conj a 2) (spy))) [1])",
      "(list [1 2] [1])",
    );
  }

  #[test]
  fn later_calls_are_checked_in_their_own_scope() {
    for program in [
      "((lambda (a) (list (let ((spy +)) (conj a 2)) (spy))) [1])",
      "((lambda (a) (list (let ((spy +)) (let ((x 3)) (conj a x))) (spy))) [1])",
    ] {
      let expected = if program.contains("x 3") {
        "(list [1 3] [1])"
      } else {
        "(list [1 2] [1])"
      };
      assert_eq!(run_with(program, spy).0, run(expected).0, "{program}");
    }
  }

  #[test]
  fn a_writer_cannot_rebind_a_later_head_after_release() {
    for (body, expected) in [
      ("(list (g a) (f))", "(list [1] [1])"),
      ("(list (g (conj a 2)) (f))", "(list [1 2] [1])"),
    ] {
      let program = format!("(define f +) (define (g x) (set! f spy) x) ((lambda (a) {body}) [1])");
      assert_eq!(run_with(&program, spy).0, run(expected).0, "{program}");
    }
  }

  #[test]
  fn nested_later_arguments_cannot_rebind_each_others_heads() {
    let program = "(define f +) (define (g x) (set! f spy) x) \
      ((lambda (a) (list (conj a 2) (list (g 0) (f)))) [1])";
    assert_eq!(run_with(program, spy).0, run("(list [1 2] (list 0 [1]))").0);
  }

  #[test]
  fn an_env_blind_closure_is_still_a_mutation_boundary() {
    let setup = |interp: &mut Interp, env: &Scope| {
      spy(interp, env);
      let f = interp.string_interner().get_or_intern("f");
      let reader = interp.string_interner().get_or_intern("spy");
      let root = env.clone();
      let closure: NativeClosure<SymbolU32> = Rc::new(move |_, args| {
        let value = root.borrow().get(reader).unwrap();
        root.borrow_mut().define(f, value);
        Ok(args.into_iter().next().unwrap_or(Value::Nil))
      });
      interp.declare_env_blind(&closure);
      define(
        interp,
        env,
        "g",
        Value::Function(Function::NativeClosure(closure)),
      );
    };
    let program = "(define f +) ((lambda (a) (list (g (conj a 2)) (f))) [1])";
    assert_eq!(run_with(program, setup).0, run("(list [1 2] [1])").0);
  }

  /// A lambda without a captured scope resolves names in its caller's
  /// (review R4).
  #[test]
  fn an_uncaptured_lambda_keeps_the_value() {
    let legacy = |interp: &mut Interp, env: &Scope| {
      let a = interp.string_interner().get_or_intern("a");
      let lambda = Lambda {
        params: vec![],
        signature: None,
        defaults: vec![],
        body: vec![Value::Symbol(a.into())],
        captured_env: None,
      };
      define(
        interp,
        env,
        "legacy",
        Value::Function(Function::Lambda(Rc::new(lambda))),
      );
    };
    for (program, expected) in [
      ("((lambda (a) (legacy (conj a 2))) [1])", "[1]"),
      (
        "((lambda (a) (list (conj a 2) (legacy))) [1])",
        "(list [1 2] [1])",
      ),
      ("((lambda (a) (legacy a)) [1])", "[1]"),
    ] {
      assert_eq!(run_with(program, legacy).0, run(expected).0, "{program}");
    }
  }

  /// A frame a native kept, read later by a host hook, keeps its value
  /// (review R4).
  #[test]
  fn a_kept_frame_read_by_a_hook_keeps_the_value() {
    let saved: Rc<RefCell<Option<Scope>>> = Rc::default();
    let hooks = |saved: Rc<RefCell<Option<Scope>>>| {
      move |interp: &mut Interp, env: &Scope| {
        let a = interp.string_interner().get_or_intern("a");
        let keep = saved.clone();
        let remember: NativeClosure<SymbolU32> = Rc::new(move |env, _| {
          *keep.borrow_mut() = Some(env);
          Ok(Value::Nil)
        });
        define(
          interp,
          env,
          "remember",
          Value::Function(Function::NativeClosure(remember)),
        );
        let read = saved.clone();
        interp.set_missing_symbol_hook(Rc::new(move |name| {
          let value = read
            .borrow()
            .as_ref()
            .and_then(|scope| scope.borrow().get(a))?;
          (name == "missing").then(|| vec![("missing".to_string(), value)])
        }));
        let read = saved.clone();
        interp.set_call_head_hook(Rc::new(move |name, _| {
          (name == "unbound-call").then(|| {
            Ok(
              read
                .borrow()
                .as_ref()
                .and_then(|scope| scope.borrow().get(a))
                .unwrap_or(Value::Nil),
            )
          })
        }));
      }
    };
    for program in [
      "((lambda (a) (remember) (list (conj a 2) missing)) [1])",
      "((lambda (a) (remember) (list (conj a 2) (unbound-call))) [1])",
    ] {
      assert_eq!(
        run_with(program, hooks(saved.clone())).0,
        run("(list [1 2] [1])").0,
        "{program}"
      );
    }
  }

  /// A native that kept the frame reads it after the lambda has returned and
  /// sees the value: only the observed mark guards this.
  #[test]
  fn a_frame_kept_past_its_return_keeps_the_value() {
    let kept = |interp: &mut Interp, env: &Scope| {
      let a = interp.string_interner().get_or_intern("a");
      let saved: Rc<RefCell<Option<Scope>>> = Rc::default();
      let keep = saved.clone();
      let remember: NativeClosure<SymbolU32> = Rc::new(move |env, _| {
        *keep.borrow_mut() = Some(env);
        Ok(Value::Nil)
      });
      let recall: NativeClosure<SymbolU32> = Rc::new(move |_, _| {
        Ok(
          saved
            .borrow()
            .as_ref()
            .and_then(|scope| scope.borrow().get(a))
            .unwrap_or(Value::Nil),
        )
      });
      define(
        interp,
        env,
        "remember",
        Value::Function(Function::NativeClosure(remember)),
      );
      define(
        interp,
        env,
        "recall",
        Value::Function(Function::NativeClosure(recall)),
      );
    };
    assert_eq!(
      run_with(
        "(begin ((lambda (a) (remember) (conj a 2)) [1]) (recall))",
        kept
      )
      .0,
      run("[1]").0
    );
  }

  /// A deprecated alias of the name, read later, sees the value (review R5).
  #[test]
  fn a_deprecated_alias_keeps_the_value() {
    let alias = |interp: &mut Interp, _: &Scope| interp.add_deprecated_alias("old.a", "a");
    assert_eq!(
      run_with("((lambda (a) (list (conj a 2) old.a)) [1])", alias).0,
      run("(list [1 2] [1])").0
    );
  }

  /// [`super::SPECIAL_FORMS`] names every form `eval_special_form` dispatches.
  #[test]
  fn special_forms_list_is_complete() {
    let source = include_str!("interpreter.rs");
    let start = source
      .find("  fn eval_special_form(")
      .expect("eval_special_form");
    let end = start
      + source[start..]
        .find("      _ => None,")
        .expect("its fallback arm");
    let quoted = regex::Regex::new(r#""([^"]+)""#).unwrap();
    for line in source[start..end].lines() {
      let Some((pattern, _)) = line.split_once("=>") else {
        continue;
      };
      for name in quoted.captures_iter(pattern) {
        assert!(
          super::SPECIAL_FORMS.contains(&&name[1]),
          "special form `{}` is missing from SPECIAL_FORMS",
          &name[1]
        );
      }
    }
  }
}
