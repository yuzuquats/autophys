use std::{cell::RefCell, collections::HashMap, fmt::Debug, rc::Rc};

use string_interner::StringInterner;

use crate::{
  tail::Tail,
  eval::{Env, Function, Lambda, NativeClosure, ReceiverState, ReportedFailure, RuntimeError, Type},
  symbol::{Backend, Symbol},
  value::{ErrorValue, Value},
};

/// Host-registered handler for the reserved
/// `(@import "name" :as "ns" [:from "dir"])` special form. The interpreter parses
/// the form and hands the handler the bundle name, the explicit namespace (the
/// `:as` value), and an optional search dir (the `:from` value); the handler
/// resolves + mounts the returned (symbol, value) pairs into the call-site env.
/// The handler is pure: it never touches the env or interner directly — the
/// interpreter owns those.
///
/// The namespace is required (`special_import` errors without `:as`), so the
/// handler always receives a concrete `&str` — the mount site, not the bundle,
/// names the group. `:from` is optional: `Some(dir)` lets an import resolve its
/// own bundle location (a self-contained rc, no reliance on a global app path);
/// `None` falls back to the host's configured search dirs.
pub type ImportHandler<S> =
  Rc<dyn Fn(&str, &str, Option<&str>) -> Result<Vec<(String, Value<S>)>, RuntimeError>>;

/// See [`Interpreter::set_missing_symbol_hook`]: `name` → definitions to
/// install in the root env, or `None` when the hook has nothing for it.
pub type MissingSymbolHook<S> = Rc<dyn Fn(&str) -> Option<Vec<(String, Value<S>)>>>;

/// See [`Interpreter::set_call_head_hook`]: a call whose head names nothing,
/// given the name and a way to evaluate its arguments, answered by the host,
/// or `None` (arguments unevaluated) when the host has nothing for it either.
pub type CallHeadHook<S> = Rc<dyn Fn(&str, &mut CallArgs<'_, S>) -> Option<Result<Value<S>, RuntimeError>>>;

/// Evaluates a nested call's arguments for a [`CallHeadHook`], only once the
/// host has decided to answer the call.
pub type CallArgs<'a, S> = dyn FnMut() -> Result<Vec<CallArg<S>>, RuntimeError> + 'a;

/// One argument of a nested call: a literal `:keyword` as written (a flag by
/// argv.md I11), or any other argument's value.
#[derive(Clone, Debug)]
pub enum CallArg<S: Symbol> {
  Keyword(String),
  Value(Value<S>),
}

/// See [`Interpreter::set_binding_guard`]: a name → why user code may not
/// bind it, or `None` when it may.
pub type BindingGuard = Rc<dyn Fn(&str) -> Option<String>>;

/// The names user code may never bind, each with everything under it: `std`,
/// and `tsh.plugins`, the first family of tsh's platform namespace (argv.md
/// A5). The rest of `tsh.*` is not yet claimed: a scene prelude still defines
/// `tsh.scenes` and `tsh.app-root` itself.
const READ_ONLY_ROOTS: &[&str] = &["std", "tsh.plugins", "error"];

/// The error a `(let …)` form raises: `def` was retired for `let` (operator
/// ruling 19, 2026-10-06) with no deprecation window.
/// A deprecated spelling met while evaluating: `old` as written and the
/// spelling that replaces it. Hosts drain these with
/// [`Interpreter::take_deprecations`] and warn once per site; the old
/// spelling keeps working for one release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deprecation {
  pub old: String,
  pub new: String,
}

impl Deprecation {
  /// `deprecated: `old` is now `new`; …` — the warning body hosts print.
  pub fn message(&self) -> String {
    format!(
      "deprecated: `{}` is now `{}` (the old spelling is removed in the next release)",
      self.old, self.new
    )
  }
}

/// What a deprecated name resolves to: the replacement's name and the
/// arguments a call to the old name puts before its own. Only a retired
/// command declared with [`Interpreter::add_deprecated_call`] has any
/// (`std.fs.list_dir` is `std.coreutil.ls -l`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeprecatedTarget {
  pub name: String,
  pub leading: Vec<String>,
}

impl DeprecatedTarget {
  /// The replacement as the warning spells it: `std.coreutil.ls -l`.
  pub fn spelling(&self) -> String {
    std::iter::once(self.name.as_str())
      .chain(self.leading.iter().map(String::as_str))
      .collect::<Vec<_>>()
      .join(" ")
  }
}

/// One host-declared renamed name: see [`Interpreter::add_deprecated_alias`]
/// and [`Interpreter::add_deprecated_call`].
#[derive(Clone, Debug)]
struct DeprecatedAlias {
  old: String,
  new: String,
  /// Empty for a renamed prefix; a retired command's leading arguments,
  /// which make it match only its own name.
  leading: Vec<String>,
}

pub const DEF_REMOVED: &str =
  "`def` was removed; use (let NAME VALUE) — a function is (let NAME (lambda (params…) body…))";

/// `(@cfg …)` is removed from source before evaluation
/// ([`crate::cfg::resolve_source`]), so reaching it means it sits inside
/// another form, where it has nothing to gate.
pub const CFG_NESTED: &str =
  "(@cfg …) gates the top-level form after it; inside a form, write (when (cfg? …) …)";

/// See [`Interpreter::set_use_hook`]: told about each name a `use` form binds
/// to a value (the name, the path it names, the value, and whether `as:` named
/// it) before anything is bound. An error refuses the form.
pub type UseHook<S> = Rc<dyn Fn(&str, &str, &Value<S>, bool) -> Result<(), RuntimeError>>;

/// An optional ceiling on one evaluation scope (the F8 rail against runaway
/// scripts): a step count, an optional wall-clock deadline, and a recursion
/// depth cap. The depth cap is load-bearing — unbounded lambda recursion
/// would abort the process on stack overflow long before a step ceiling in
/// the millions triggers.
#[derive(Clone, Copy, Debug)]
pub struct EvalBudget {
  /// Maximum `eval_expression` entries before erroring.
  pub max_steps: u64,
  /// Wall-clock cutoff, checked every 1024 steps (an `Instant::now()` per
  /// step would dominate small evals).
  pub deadline: Option<std::time::Instant>,
  /// Maximum eval recursion depth (well under the thread stack limit).
  pub max_depth: u32,
}

/// The interpreter's own ceiling on nested evaluations, engaged whether or
/// not a host set an [`EvalBudget`]. A simple recursive Lisp call nests
/// three evaluations (the call, its body, the argument being computed), so
/// this allows about 50,000 Lisp frames. It bounds memory, not the native
/// thread stack (that is the [`StackGrower`]'s job): a release build uses
/// about 2.3 KB of stack per evaluation, so a runaway recursion peaks near
/// 350 MB before it is refused, and the segments are freed as it unwinds.
pub(crate) const DEFAULT_MAX_EVAL_DEPTH: u32 = 150_000;

/// Runs the closure it is handed with enough native stack left for one
/// evaluation, switching to a fresh stack segment when the current one runs
/// low (a host implements it with `stacker::maybe_grow`).
///
/// Deep Lisp recursion used to overflow whichever thread evaluated it —
/// about 2,000 frames on an 8 MB main thread, fewer on a host's worker
/// thread — and a stack overflow aborts the process, past any `(try …)`.
/// A grower keeps evaluation on the caller's thread (thread-locals and `Rc`
/// state stay valid), so every interpreter in the process gets the same
/// depth whatever stack its thread was spawned with. The language crate
/// carries no stack-switching code itself; without a grower, evaluation
/// runs on the thread's own stack as before.
pub type StackGrower = fn(&mut dyn FnMut());

static STACK_GROWER: std::sync::OnceLock<StackGrower> = std::sync::OnceLock::new();

/// Install the process-wide [`StackGrower`] every interpreter evaluates
/// through. The first install wins; returns whether this one did.
pub fn install_stack_grower(grower: StackGrower) -> bool {
  STACK_GROWER.set(grower).is_ok()
}

/// One [`Interpreter::eval_expression`] entry's share of the nesting
/// counters, given back when it drops, on return and on unwind alike. A host
/// that catches a panic and keeps the interpreter (the interactive REPL does)
/// would otherwise inherit the abandoned frames: less headroom under the
/// ceiling with every panic, and a `call_depth` above 1 that hands an unbound
/// top-level head to the call-head hook instead of reporting it unbound. It
/// owns the `&mut` the evaluation runs through, so nothing else holds one.
struct EvalFrame<'a, S: Symbol, B: Backend<S>> {
  interp: &'a mut Interpreter<S, B>,
  call: u32,
}

impl<S: Symbol, B: Backend<S>> Drop for EvalFrame<'_, S, B> {
  fn drop(&mut self) {
    self.interp.eval_depth -= 1;
    self.interp.call_depth -= self.call;
    if let Some(t) = &mut self.interp.budget {
      t.depth = t.depth.saturating_sub(1);
    }
  }
}

/// The value a retired command's bare name `old` answers: its replacement
/// native `value` with the target's leading arguments put first
/// ([`Interpreter::add_deprecated_call`]). Only a native can be applied
/// outside the evaluator, and every command is one.
fn partially_applied<S: Symbol + 'static>(
  old: &str,
  value: Value<S>,
  target: &DeprecatedTarget,
) -> Result<NativeClosure<S>, RuntimeError> {
  let leading: Vec<Value<S>> = target.leading.iter().map(|arg| Value::String(arg.as_str().into())).collect();
  let with_leading = move |args: Vec<Value<S>>| leading.iter().cloned().chain(args).collect::<Vec<_>>();
  let call: NativeClosure<S> = match value {
    Value::Function(Function::NativeClosure(native)) => Rc::new(move |env, args| native(env, with_leading(args))),
    Value::Function(Function::NativeFn(native)) => Rc::new(move |_, args| native(with_leading(args))),
    Value::Function(Function::TypedNative(native)) => Rc::new(move |env, args| {
      native.invoke(env, with_leading(args).into_iter().map(|arg| (None, arg)).collect())
    }),
    _ => {
      return Err(RuntimeError::Other(format!(
        "`{old}` is now `{}`, and `{}` is not a command",
        target.spelling(),
        target.name
      )));
    }
  };
  Ok(call)
}

/// Whether `a` and `b` are the same native, by identity (a lambda never is:
/// only natives are partially applied).
fn same_native<S: Symbol>(a: &Value<S>, b: &Value<S>) -> bool {
  match (a, b) {
    (Value::Function(Function::NativeClosure(a)), Value::Function(Function::NativeClosure(b))) => Rc::ptr_eq(a, b),
    (Value::Function(Function::NativeFn(a)), Value::Function(Function::NativeFn(b))) => std::ptr::fn_addr_eq(*a, *b),
    (Value::Function(Function::TypedNative(a)), Value::Function(Function::TypedNative(b))) => Rc::ptr_eq(a, b),
    _ => false,
  }
}

/// Evaluate through `grower`. Kept out of line so the no-grower path in
/// [`Interpreter::eval_expression`] keeps its original frame size.
#[inline(never)]
fn grow_stack<R>(grower: StackGrower, f: impl FnOnce() -> R) -> R {
  let mut f = Some(f);
  let mut out = None;
  grower(&mut || out = f.take().map(|f| f()));
  out.expect("a StackGrower must run the closure it is handed exactly once")
}

/// Live counters for an engaged [`EvalBudget`].
struct BudgetTracker {
  budget: EvalBudget,
  steps: u64,
  depth: u32,
}

type NativeScope<S> = Rc<dyn Fn(Vec<Value<S>>) -> Result<(Value<S>, Box<dyn std::any::Any>), RuntimeError>>;
type StreamScope = Rc<dyn Fn(&str) -> Result<Box<dyn std::any::Any>, RuntimeError>>;
type NativeSource<S> = Rc<dyn Fn(Vec<Value<S>>) -> Result<(Value<S>, Option<String>), RuntimeError>>;
/// The call heads a source native may run (for example design §11's advice
/// commands). A head outside the set is refused before anything resolves.
pub type SourceHeads = Rc<dyn Fn(&str) -> bool>;

pub struct Interpreter<S: Symbol, B: Backend<S>> {
  source_root: Option<Rc<RefCell<Env<S>>>>,
  native_scopes: HashMap<usize, (NativeClosure<S>, NativeScope<S>)>,
  native_sources: HashMap<usize, (NativeClosure<S>, NativeSource<S>, Option<SourceHeads>)>,
  stream_scope: Option<StreamScope>,
  pub(crate) interner: StringInterner<B>,
  pub(crate) module_discovery: Option<crate::ModuleDiscovery<S>>,
  pub(crate) trait_impls: Rc<RefCell<Vec<crate::struct_impl::StructImpl<S>>>>,
  pub(crate) record_shapes: Rc<RefCell<crate::struct_impl::RecordRegistry>>,
  import_handler: Option<ImportHandler<S>>,
  /// Consulted when a symbol resolves nowhere (env, then dot-send): given the
  /// symbol's name it may answer with definitions to install in the ROOT env,
  /// after which the lookup is retried once. This is how a host mounts an
  /// imported bundle lazily — nothing is re-executed, the reference that
  /// needed the name simply finds it defined.
  missing_symbol: Option<MissingSymbolHook<S>>,
  call_head: Option<CallHeadHook<S>>,
  /// How many call forms are being evaluated: the outermost one is 1. The
  /// call-head hook answers only nested calls, so a host door keeps its own
  /// fallback for the form it was handed.
  call_depth: u32,
  /// Nested `eval_expression` entries in flight, counted whether or not a
  /// budget is engaged, against `max_eval_depth`.
  eval_depth: u32,
  max_eval_depth: u32,
  binding_guard: Option<BindingGuard>,
  use_hook: Option<UseHook<S>>,
  /// Module names a `(use std.fs)` introduced: `fs` → `std.fs`, so a miss on
  /// `fs.read_dir` resolves `std.fs.read_dir` (R7, R9's module-path rule).
  modules: HashMap<String, String>,
  budget: Option<BudgetTracker>,
  /// Live receivers, keyed by the identity of the closure that fronts them.
  ///
  /// A receiver reaches the language as an ordinary `NativeClosure` (so it is
  /// callable with no parser change), which leaves nothing in the value itself
  /// to distinguish it from any other native. The dot sugar MUST make that
  /// distinction without invoking anything — probing by calling would run an
  /// arbitrary native just to ask what it is — so identity is recorded here at
  /// construction and looked up by pointer.
  receivers: HashMap<usize, Rc<ReceiverState<S>>>,
  /// Host-declared renamed names: a miss on `old` or `old.rest` resolves
  /// `new` / `new.rest` (a retired command: `old` alone, with its leading
  /// arguments) and records a [`Deprecation`].
  deprecated_aliases: Vec<DeprecatedAlias>,
  /// Deprecated spellings met since the host last drained them.
  deprecations: Vec<Deprecation>,
  /// Each retired command's bare-name partial application and the native it
  /// fronts: the same closure answers while that native is unchanged, so a
  /// binding of the old name keeps an identity a host can recognise
  /// ([`Interpreter::deprecated_call_of`]).
  deprecated_calls: HashMap<String, (Value<S>, NativeClosure<S>)>,
  /// The callees that can neither read nor keep the scope they are called
  /// in ([`crate::tail::Trust`]).
  pub(crate) trust: crate::tail::Trust<S>,
  marker: std::marker::PhantomData<S>,
}

impl<S: Symbol, B: Backend<S>> Interpreter<S, B> {
  pub fn new() -> Self {
    Self {
      source_root: None,
      native_scopes: HashMap::new(),
      native_sources: HashMap::new(),
      stream_scope: None,
      interner: StringInterner::new(),
      module_discovery: None,
      trait_impls: Rc::default(),
      record_shapes: Rc::default(),
      import_handler: None,
      missing_symbol: None,
      call_head: None,
      call_depth: 0,
      eval_depth: 0,
      max_eval_depth: DEFAULT_MAX_EVAL_DEPTH,
      binding_guard: None,
      use_hook: None,
      modules: HashMap::new(),
      budget: None,
      receivers: HashMap::new(),
      deprecated_aliases: Vec::new(),
      deprecations: Vec::new(),
      deprecated_calls: HashMap::new(),
      trust: Default::default(),
      marker: std::marker::PhantomData {},
    }
  }

  /// Register the host's `(@import "name")` handler. A host that doesn't set
  /// one gets `RuntimeError::Other("no import handler registered")` if `@import`
  /// is evaluated. The handler is `Fn` (not `FnMut`) so it can be shared via
  /// `Rc` and called from inside the interpreter's eval without re-borrowing.
  pub fn set_import_handler(&mut self, handler: ImportHandler<S>) {
    self.import_handler = Some(handler);
  }

  /// Register a callable scope. Entry returns a thunk and an RAII lifetime;
  /// the same interpreter executes the thunk and drops the lifetime on every
  /// return path (including unwinding). Keeping the closure prevents id reuse.
  pub fn native_scope(&mut self, enter: NativeScope<S>) -> Value<S> {
    let callable: NativeClosure<S> = Rc::new(|_, _| Err(RuntimeError::Other(
      "scoped native requires interpreter dispatch".into())));
    self.native_scopes.insert(Rc::as_ptr(&callable) as *const () as usize, (callable.clone(), enter));
    Value::Function(Function::NativeClosure(callable))
  }

  /// The host validates the token and returns a guard whose drop closes it.
  pub fn set_stream_scope(&mut self, enter: StreamScope) {
    self.stream_scope = Some(enter);
  }

  /// Install the host-owned root used by selected source, apart from user bindings.
  pub fn set_source_root(&mut self, root: Rc<RefCell<Env<S>>>) {
    self.source_root = Some(root);
  }

  /// Only host registrations and admitted plugin exports belong in this root.
  pub fn define_source_binding(&mut self, symbol: S, value: Value<S>) {
    if let Some(root) = &self.source_root {
      root.borrow_mut().define(symbol, value);
    }
  }

  /// Evaluate one host-selected call in a fresh child of the host root and budget.
  pub fn native_source(&mut self, select: NativeSource<S>) -> Value<S> {
    self.native_source_with_heads(select, None)
  }

  /// As [`Self::native_source`], restricted to the call heads `heads` admits.
  /// Every source native refuses a head that is itself a source native.
  pub fn native_source_with_heads(&mut self, select: NativeSource<S>, heads: Option<SourceHeads>) -> Value<S> {
    let callable: NativeClosure<S> = Rc::new(|_, _| Err(RuntimeError::Other(
      "source native requires interpreter dispatch".into())));
    self.native_sources.insert(Rc::as_ptr(&callable) as *const () as usize, (callable.clone(), select, heads));
    Value::Function(Function::NativeClosure(callable))
  }

  /// Declare a native closure that never reads or keeps the scope it is
  /// called in (it ignores its environment argument). Calling it leaves a
  /// lambda's frame unobserved, so an accumulator there can still be
  /// released before an in-place write ([`crate::tail`]). A closure that
  /// uses its environment must not be declared. This does not promise that
  /// captured host state cannot rebind names or run Lisp: continuation
  /// checks still treat a declared closure as a mutation boundary.
  pub fn declare_env_blind(&mut self, closure: &NativeClosure<S>) {
    self.trust.declare(closure);
  }

  pub fn set_missing_symbol_hook(&mut self, hook: MissingSymbolHook<S>) {
    self.missing_symbol = Some(hook);
  }

  /// Declare a renamed name prefix for one deprecation window: `old.rest`
  /// (and `old` itself when dotted) keep resolving as `new.rest` / `new` (only when the old name
  /// is itself unbound), and each use records a [`Deprecation`]. Read-only
  /// roots are untouched: nothing is bound under `old`.
  pub fn add_deprecated_alias(&mut self, old: &str, new: &str) {
    self.add_deprecated(old, new, Vec::new());
  }

  /// Declare a retired command whose meaning is now `new` called with
  /// `leading` arguments first, for one deprecation window: `(old args…)`
  /// runs `(new leading… args…)` and the bare name is that partial
  /// application (`std.fs.list_dir` is `std.coreutil.ls -l`). Only `old`
  /// itself matches, not names under it; each use records a [`Deprecation`]
  /// naming the whole replacement.
  pub fn add_deprecated_call(&mut self, old: &str, new: &str, leading: &[&str]) {
    self.add_deprecated(old, new, leading.iter().map(|arg| arg.to_string()).collect());
  }

  fn add_deprecated(&mut self, old: &str, new: &str, leading: Vec<String>) {
    if !self.deprecated_aliases.iter().any(|alias| alias.old == old) {
      self.deprecated_aliases.push(DeprecatedAlias { old: old.to_string(), new: new.to_string(), leading });
    }
  }

  /// The replacement for a deprecated `name`, if a declared alias covers it.
  pub fn deprecated_target(&self, name: &str) -> Option<DeprecatedTarget> {
    self.deprecated_aliases.iter().find_map(|alias| {
      let target = |name: String| DeprecatedTarget { name, leading: alias.leading.clone() };
      // A dotted prefix also renames itself (`std.apps` → `tsh.plugins`); a
      // bare one (`sh`) only its members, so the word stays free. A retired
      // command is only itself.
      if name == alias.old && (alias.old.contains('.') || !alias.leading.is_empty()) {
        return Some(target(alias.new.clone()));
      }
      if !alias.leading.is_empty() {
        return None;
      }
      let rest = name.strip_prefix(alias.old.as_str())?.strip_prefix('.')?;
      Some(target(format!("{}.{rest}", alias.new)))
    })
  }

  /// The retired command whose bare name answered `f` (`std.fs.list_dir`
  /// for the value `(let ls std.fs.list_dir)` binds), if `f` is one.
  pub fn deprecated_call_of(&self, f: &NativeClosure<S>) -> Option<&str> {
    self
      .deprecated_calls
      .iter()
      .find(|(_, (_, call))| Rc::ptr_eq(call, f))
      .map(|(old, _)| old.as_str())
  }

  /// The bare name `old` of a retired command: `value` (its replacement)
  /// partially applied, the same closure each time while `value` is.
  fn deprecated_call(&mut self, old: &str, value: Value<S>, target: &DeprecatedTarget) -> Result<Value<S>, RuntimeError>
  where
    S: 'static,
  {
    let call = match self.deprecated_calls.get(old) {
      Some((wrapped, call)) if same_native(wrapped, &value) => call.clone(),
      _ => {
        let call = partially_applied(old, value.clone(), target)?;
        self.deprecated_calls.insert(old.to_string(), (value, call.clone()));
        call
      }
    };
    Ok(Value::Function(Function::NativeClosure(call)))
  }

  /// Record that `old` was used where `new` is the spelling now.
  pub fn note_deprecation(&mut self, old: &str, new: &str) {
    if !self.deprecations.iter().any(|d| d.old == old) {
      self.deprecations.push(Deprecation { old: old.to_string(), new: new.to_string() });
    }
  }

  /// The deprecated spellings met since the last call, oldest first.
  pub fn take_deprecations(&mut self) -> Vec<Deprecation> {
    std::mem::take(&mut self.deprecations)
  }

  /// Respell deprecated names in `value` before a host door dispatches it
  /// (its heads may route outside the evaluator): `set!` heads become `set`,
  /// declared alias prefixes become their replacements, and a retired
  /// command's call gains its leading arguments, each recorded. A retired
  /// command's bare name is left for the evaluator, which answers its partial
  /// application. Quoted data is left as written.
  pub fn respell_deprecated(&mut self, value: &mut Value<S>) {
    match value {
      Value::Symbol(sym) => {
        let Some(name) = self.interner.resolve(sym.as_symbol()) else { return };
        let target = if name == "set!" {
          Some("set".to_string())
        } else if self.deprecated_aliases.is_empty() {
          None
        } else {
          self.deprecated_target(name).filter(|target| target.leading.is_empty()).map(|target| target.name)
        };
        if let Some(target) = target {
          let old = name.to_string();
          self.note_deprecation(&old, &target);
          let interned = self.interner.get_or_intern(&target);
          *sym = crate::eval::Sym::from(&interned);
        }
      }
      Value::List(list) => {
        let mut respelled_head = Vec::new();
        if let Some(Value::Symbol(head)) = list.items.first() {
          let head = self.interner.resolve(head.as_symbol());
          if head == Some("quote") {
            return;
          }
          let call = head
            .filter(|_| !self.deprecated_aliases.is_empty())
            .and_then(|head| Some((head.to_string(), self.deprecated_target(head)?)))
            .filter(|(_, target)| !target.leading.is_empty());
          if let Some((old, target)) = call {
            self.note_deprecation(&old, &target.spelling());
            let interned = self.interner.get_or_intern(&target.name);
            respelled_head.push(Value::Symbol(crate::eval::Sym::from(&interned)));
            respelled_head.extend(target.leading.into_iter().map(|arg| Value::String(arg.as_str().into())));
          }
        }
        if !respelled_head.is_empty() {
          list.items.splice(0..1, respelled_head);
        }
        for item in &mut list.items {
          self.respell_deprecated(item);
        }
      }
      _ => {}
    }
  }

  /// Consulted when a NESTED call's head symbol resolves nowhere (env, dot
  /// send, then the missing-symbol hook). The host gets the name and, once it
  /// decides to answer, the arguments: evaluated in order except literal
  /// `:keyword`s, which stay symbols so the host can tell a flag from a string. This is how dynamic
  /// code reaches a command by name (argv.md I13). The outermost form a door
  /// evaluates never reaches it: that door has its own fallback.
  pub fn set_call_head_hook(&mut self, hook: CallHeadHook<S>) {
    self.call_head = Some(hook);
  }

  /// Consulted before `def`/`define`/`defun`/`fn`/`set!` bind a name from source,
  /// after the built-in rule that `std.*` is read-only. A host uses it to make
  /// its readonly variables bind both dialects (A5): one variable store.
  /// Natives the host registers directly are unaffected.
  pub fn set_binding_guard(&mut self, guard: BindingGuard) {
    self.binding_guard = Some(guard);
  }

  /// Consulted by `use` for each name it binds to a value. A host uses it to
  /// keep the names an import binds apart from its own commands (tsh: an
  /// import binds Lisp names only), or to refuse one. Without a hook `use`
  /// only binds.
  pub fn set_use_hook(&mut self, hook: UseHook<S>) {
    self.use_hook = Some(hook);
  }

  /// The full path a dotted name means through a `use`d module name:
  /// `fs.read_dir` → `std.fs.read_dir` after `(use std.fs)`. `None` when its
  /// first segment names no module.
  pub fn module_target(&self, name: &str) -> Option<String> {
    let (head, tail) = name.split_once('.')?;
    let path = self.modules.get(head)?;
    (!tail.is_empty()).then(|| format!("{path}.{tail}"))
  }

  /// Refuse a source-level binding of a read-only name, loudly.
  pub(crate) fn check_binding(&self, name: S) -> Result<(), RuntimeError> {
    self.check_internal_binding(name)?;
    let name = self.interner.resolve(name).unwrap_or("");
    let under = |root: &str| {
      name.strip_prefix(root).is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
    };
    if let Some(root) = READ_ONLY_ROOTS.iter().find(|root| under(root)) {
      return Err(RuntimeError::Other(format!(
        "{name} is read-only: {root} names are defined by the host, not by user code"
      )));
    }
    match self.binding_guard.as_ref().and_then(|guard| guard(name)) {
      Some(detail) => Err(RuntimeError::Other(detail)),
      None => Ok(()),
    }
  }

  pub(crate) fn check_internal_binding(&self, name: S) -> Result<(), RuntimeError> {
    if self.interner.resolve(name) == Some("__module_bundle") {
      return Err(RuntimeError::Other(
        "__module_bundle is reserved for the bundle loader".into(),
      ));
    }
    Ok(())
  }
}

impl<S: Symbol, B: Backend<S>> Interpreter<S, B>
where
  // `'static` is required by the receiver machinery: a receiver and a bound
  // send are both `Rc<dyn Fn>` closures that capture `Value<S>`, so `S` must
  // outlive them. Every real symbol backend is an owned interned type, so this
  // costs nothing in practice.
  S: Debug + 'static,
{
  pub fn default_env(&mut self) -> Rc<RefCell<Env<S>>> {
    let mut env = Env::default_env(&mut self.interner);
    let shapes = self.record_shapes.clone();
    let hydrate: NativeClosure<S> = Rc::new(move |_, args| {
      let [Value::Map(record), expected_type, expected_bundle] = args.as_slice() else {
        return Err(RuntimeError::Other(
          "std.record.hydrate requires one map with a string shape".into(),
        ));
      };
      match (expected_type, expected_bundle) {
        (Value::Type(ty), Value::Nil) if matches!(ty.as_ref(), crate::types::TypeExpr::Record { .. }) => {},
        (Value::Nil, Value::String(_)) => {},
        _ => return Err(RuntimeError::Other("std.record.hydrate requires exactly one constraint: as: StructType or for: \"bundle-id\"".into())),
      }
      let Some(Value::String(shape)) = record.get("shape") else {
        return Err(RuntimeError::Other(
          "std.record.hydrate requires a string shape".into(),
        ));
      };
      let registry = shapes.borrow();
      let key = registry.shapes.get(shape.as_str()).ok_or_else(|| {
          RuntimeError::Other(format!(
            "std.record.hydrate: no registered struct for shape {shape}"
          ))
        })?;
      let ty = registry.types.get(key).expect("registered shape has a type").clone();
      if let Value::String(bundle) = expected_bundle {
        if key.0.as_deref() != Some(bundle.as_str()) {
          return Err(RuntimeError::Other(format!("std.record.hydrate: shape {shape} belongs to {}, not requested bundle {bundle}", key.0.as_deref().unwrap_or("<REPL>"))));
        }
      }
      if let Value::Type(expected) = expected_type {
        if !Rc::ptr_eq(expected, &ty) {
          return Err(RuntimeError::Other(format!("std.record.hydrate: shape {shape} belongs to {}.{}, not requested type {expected:?}", key.0.as_deref().unwrap_or("<REPL>"), key.1)));
        }
      }
      let mut record = record.clone();
      if let crate::types::TypeExpr::Record { fields, .. } = ty.as_ref() {
        for (name, field) in fields {
          if field.optional() {
            record.entry(name.clone()).or_insert(Value::Nil);
          }
        }
      }
      let value = Value::Map(record.with_record_type(ty.clone()));
      let mut errors = Vec::new();
      ty.check(&value, "std.record.hydrate", &mut errors);
      crate::types::checked(errors)?;
      Ok(value)
    });
    self.declare_env_blind(&hydrate);
    let symbol = self.interner.get_or_intern("std.record.hydrate");
    use crate::types::{ParamKind, Parameter, Signature, TypeExpr, TypedNative};
    let parameter = |name: &str, kind, ty, default| Parameter {
      name: name.into(),
      kind,
      ty,
      default,
      default_expression: None,
    };
    env.define(
      symbol,
      Value::Function(Function::TypedNative(Rc::new(TypedNative {
        name: "std.record.hydrate".into(),
        signature: Signature {
          params: vec![
            parameter("data", ParamKind::Positional, TypeExpr::Any, None),
            parameter(
              "as",
              ParamKind::Named,
              TypeExpr::Option(Box::new(TypeExpr::StructType)),
              Some(serde_json::Value::Null),
            ),
            parameter(
              "for",
              ParamKind::Named,
              TypeExpr::Option(Box::new(TypeExpr::String)),
              Some(serde_json::Value::Null),
            ),
          ],
          result: TypeExpr::Any,
        },
        body: hydrate,
      }))),
    );
    Rc::new(RefCell::new(env))
  }

  /// Prints `value` the way the REPL shows it, walking nested lists and maps
  /// on the heap (`value_format`), so a deep value cannot overflow the stack.
  pub fn format_value(&self, value: &Value<S>) -> String {
    crate::value_format::format_value(&self.interner, value)
  }

  pub fn string_interner(&mut self) -> &mut StringInterner<B> {
    &mut self.interner
  }

  /// Engage (or clear) an [`EvalBudget`], returning the previously-set one so
  /// scopes nest by save/restore. Counters reset on every set.
  pub fn replace_eval_budget(&mut self, budget: Option<EvalBudget>) -> Option<EvalBudget> {
    let prev = self.budget.take().map(|t| t.budget);
    self.budget = budget.map(|budget| BudgetTracker {
      budget,
      steps: 0,
      depth: 0,
    });
    prev
  }

  /// Steps charged to the current evaluation budget, without resetting it.
  /// None means no budget is engaged. Reading this adds no evaluation step.
  pub fn eval_budget_steps(&self) -> Option<u64> {
    self.budget.as_ref().map(|tracker| tracker.steps)
  }

  /// The budget checks at the single eval chokepoint. Increments the step
  /// (and depth) counters; errors when any ceiling is crossed.
  fn budget_enter(&mut self) -> Result<(), RuntimeError> {
    let Some(t) = &mut self.budget else {
      return Ok(());
    };
    t.steps += 1;
    if t.steps > t.budget.max_steps {
      // Hard: a blown budget must halt — never soft-fail through a `(try …)`.
      return Err(RuntimeError::Fatal {
        detail: format!(
          "eval budget exceeded ({} steps) — runaway script? simplify, or move the work into a handler/command",
          t.budget.max_steps
        ),
      });
    }
    if t.steps & 1023 == 0 {
      if let Some(deadline) = t.budget.deadline {
        if std::time::Instant::now() > deadline {
          return Err(RuntimeError::Fatal { detail:
            "eval deadline exceeded — runaway script? simplify, or move the work into a handler/command"
              .to_string(),
          });
        }
      }
    }
    t.depth += 1;
    if t.depth > t.budget.max_depth {
      t.depth -= 1;
      return Err(RuntimeError::Fatal {
        detail: format!(
          "eval recursion too deep ({} frames) — unbounded recursion?",
          t.budget.max_depth
        ),
      });
    }
    Ok(())
  }

  /// Set the interpreter's own nesting ceiling (default
  /// [`DEFAULT_MAX_EVAL_DEPTH`]), returning the previous one. Unlike an
  /// [`EvalBudget`]'s `max_depth`, which is a host rail and halts, crossing
  /// this ceiling is an ordinary error: `(try …)` catches it once the
  /// recursion has unwound.
  pub fn set_max_eval_depth(&mut self, max: u32) -> u32 {
    std::mem::replace(&mut self.max_eval_depth, max)
  }

  /// Nested evaluations in flight: 0 between top-level evaluations, a caught
  /// ceiling and a caught panic included.
  pub fn eval_depth(&self) -> u32 {
    self.eval_depth
  }

  pub fn eval_expression(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    expression: &Value<S>,
  ) -> Result<Value<S>, RuntimeError> {
    self.eval_expression_at(env, expression, None)
  }

  /// [`Self::eval_expression`] for an expression on a lambda body's tail
  /// spine when `tail` is given ([`crate::tail`]).
  fn eval_expression_at(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    expression: &Value<S>,
    tail: Option<&Tail<'_, S>>,
  ) -> Result<Value<S>, RuntimeError> {
    if self.eval_depth >= self.max_eval_depth {
      // Soft on purpose: the error unwinds every frame it counted, so the
      // `(try …)` that catches it runs at a shallow depth. A runaway that
      // keeps retrying is still stopped by an engaged step budget.
      return Err(RuntimeError::Other(format!(
        "eval recursion too deep ({} nested evaluations, the interpreter's limit) — unbounded recursion?",
        self.max_eval_depth
      )));
    }
    self.budget_enter()?;
    let call = u32::from(matches!(expression, Value::List(list) if !list.items.is_empty()));
    self.call_depth += call;
    self.eval_depth += 1;
    // The frame lowers the counters again when it drops, so a panic that
    // unwinds through here restores them too (see [`EvalFrame`]).
    let frame = EvalFrame { interp: self, call };
    match STACK_GROWER.get() {
      None => frame.interp.eval_expression_inner(env, expression, tail),
      Some(&grower) => grow_stack(grower, || frame.interp.eval_expression_inner(env, expression, tail)),
    }
  }

  /// Build a RECEIVER value: a callable that dispatches on its first argument.
  ///
  /// `(recv :selector arg…)` looks `:selector` up in the table and calls it with
  /// the remaining arguments. A selector the table does not carry is refused
  /// with the names it does carry — the miss has to TEACH, because "this
  /// receiver cannot do that" is the entire prohibition mechanism and an
  /// operator meeting it needs to know what to reach for instead.
  ///
  /// The returned value is an ordinary `Function::NativeClosure`, so it is
  /// callable in head position with no reader or parser change. Its identity is
  /// recorded in `self.receivers` so the dot sugar can recognise it later
  /// without calling it.
  pub fn make_receiver(&mut self, state: Rc<ReceiverState<S>>) -> Value<S> {
    let dispatch = state.clone();
    let closure: NativeClosure<S> = Rc::new(move |env, args| {
      let mut it = args.into_iter();
      let selector = match it.next() {
        Some(Value::String(s)) if s.starts_with(':') => s,
        Some(other) => {
          return Err(RuntimeError::TypeError {
            expected: format!("{}: a :selector as the first argument", dispatch.name),
            got: format!("{:?}", other.as_type()),
          });
        }
        None => {
          return Err(RuntimeError::ArityError {
            detail: format!(
              "{}: expected a :selector — one of {}",
              dispatch.name,
              dispatch.selector_names().join(" ")
            ),
          });
        }
      };
      match dispatch.selectors.get(selector.as_str()) {
        Some(f) => f(env, it.collect()),
        None => Err(RuntimeError::UndefinedSymbol {
          detail: format!(
            "{} does not answer {} — it answers {}",
            dispatch.name,
            selector,
            dispatch.selector_names().join(" ")
          ),
        }),
      }
    });
    let key = Rc::as_ptr(&closure) as *const () as usize;
    self.receivers.insert(key, state);
    Value::Function(Function::NativeClosure(closure))
  }

  /// The receiver behind a value, if it is one. Pointer identity, no call.
  fn receiver_of(&self, value: &Value<S>) -> Option<Rc<ReceiverState<S>>> {
    match value {
      Value::Function(Function::NativeClosure(c)) => self
        .receivers
        .get(&(Rc::as_ptr(c) as *const () as usize))
        .cloned(),
      _ => None,
    }
  }

  /// The dot sugar, and ONLY on the miss path.
  ///
  /// `shell.lane.declare` is looked up whole first (the caller has already
  /// failed that), so every existing dotted name — `lane.declare`,
  /// `session.cwd`, `std.apps.install` — keeps resolving exactly as before and
  /// this is never consulted for them. That ordering is the compatibility
  /// guarantee: the sugar can only ever fire on a name that was an error.
  ///
  /// On a miss, use the longest bound prefix, then resolve its receiver selector,
  /// module export, trait method or record fields. Exact dotted bindings retain
  /// precedence. A typo still reports where it was written, before a call.
  fn dot_send(
    &mut self,
    env: &Rc<RefCell<Env<S>>>,
    name: &str,
  ) -> Result<Option<Value<S>>, RuntimeError> {
    for (at, _) in name.match_indices('.').rev() {
      let (head, tail) = (&name[..at], &name[at + 1..]);
      if head.is_empty() || tail.is_empty() {
        continue;
      }
      let bound = self
        .interner
        .get(head)
        .and_then(|symbol| env.borrow().get(symbol));
      if let Some(bound) = bound {
        if let Some(value) = self.dot_member(bound, tail)? {
          return Ok(Some(value));
        }
      }
    }
    Ok(None)
  }

  fn dot_member(&mut self, bound: Value<S>, tail: &str) -> Result<Option<Value<S>>, RuntimeError> {
    if let Value::Trait(trait_def) = &bound {
      return Ok(self.trait_method(trait_def.clone(), tail));
    }
    if let Value::Map(_) = &bound {
      let mut value = bound;
      for field in tail.split('.') {
        let Value::Map(record) = value else { return Ok(None); };
        value = match record.get(field) {
          Some(value) => value.clone(),
          None => {
            if let Some(ty) = record.record_type() {
              if let crate::types::TypeExpr::Record { name, fields } = ty.as_ref() {
                if fields.get(field).is_some_and(crate::types::TypeExpr::optional) {
                  return Ok(Some(Value::Nil));
                }
                return Err(RuntimeError::Other(format!("struct {name} has no field {field}")));
              }
            }
            return Ok(None);
          }
        };
      }
      return Ok(Some(value));
    }
    if let Value::Module(module) = &bound {
      if let Some(export) = module.exports.get(tail) { return Ok(Some(export.clone())); }
      return Ok(module.methods().get(tail).map(|method| Value::Function(Function::TypedNative(method.clone()))));
    }
    let Some(state) = self.receiver_of(&bound) else {
      return Ok(None);
    };
    let selector = format!(":{tail}");
    if !state.selectors.contains_key(&selector) {
      return Ok(None);
    }
    // A BOUND SEND: the receiver and selector are captured, the caller's
    // arguments follow. So `(shell.lane.declare "moo" …)` calls the receiver
    // with the selector prepended, and a bare `shell.lane.declare` is a
    // first-class callable like any other function value.
    let recv = bound.clone();
    let sel = selector.clone();
    let closure: NativeClosure<S> = Rc::new(move |env, args| {
      let mut full = Vec::with_capacity(args.len() + 1);
      full.push(Value::String(sel.as_str().into()));
      full.extend(args);
      match &recv {
        Value::Function(Function::NativeClosure(c)) => c(env, full),
        _ => Err(RuntimeError::TypeError {
          expected: "receiver".to_string(),
          got: "non-receiver".to_string(),
        }),
      }
    });
    Ok(Some(Value::Function(Function::NativeClosure(closure))))
  }

  /// A nested `(name arg…)` whose head names nothing: the host's call-head
  /// hook answers it, else the undefined-symbol error stands.
  fn call_unbound_head(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    name: String,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    let hook = self.call_head.clone().expect("checked by the caller");
    let mut evaluate = || {
      let mut values = Vec::with_capacity(args.len());
      for arg in args {
        let keyword = match arg {
          Value::Symbol(sym) => self
            .interner
            .resolve(sym.as_symbol())
            .and_then(|text| text.strip_prefix(':'))
            .map(str::to_string),
          _ => None,
        };
        values.push(match keyword {
          Some(name) => CallArg::Keyword(name),
          None => CallArg::Value(self.eval_expression(env.clone(), arg)?),
        });
      }
      Ok(values)
    };
    hook(&name, &mut evaluate).unwrap_or(Err(RuntimeError::UndefinedSymbol { detail: name }))
  }

  fn eval_expression_inner(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    expression: &Value<S>,
    tail: Option<&Tail<'_, S>>,
  ) -> Result<Value<S>, RuntimeError> {
    match expression {
      Value::Symbol(sym) => {
        let sym = sym.as_symbol();
        let name = self.interner.resolve(sym).unwrap_or("");
        // `:keyword` symbols are self-evaluating strings (matches JS). `#directive`
        // symbols (the reserved runtime class — `#help`/`#version`/`#json`) are
        // self-evaluating the same way, so a call like `(ls #json)` doesn't try to
        // resolve `#json` as a variable; the command-dispatch/reflection layer
        // recognizes the `#`-class and the command body never sees it.
        if name.starts_with(':') || name.starts_with('#') {
          return Ok(Value::String(name.into()));
        }
        // Common literal aliases.
        match name {
          "null" | "nil" => return Ok(Value::Nil),
          _ => {}
        }
        // A lexical module value (for example m.require's private dependency)
        // must not accidentally dispatch through another bundle's public alias.
        if let Some((head, member)) = name.split_once('.') {
          if let Some(module) = self.interner.get(head).and_then(|symbol| env.borrow().lexical_module(symbol)) {
            if let Some(export) = module.exports.get(member) { return Ok(export.clone()); }
            if let Some(method) = module.methods().get(member) {
              return Ok(Value::Function(Function::TypedNative(method.clone())));
            }
            return Err(RuntimeError::UndefinedSymbol { detail: name.to_string() });
          }
        }
        // Otherwise whole-symbol lookup keeps the flat command compatibility path.
        if let Some(found) = env.borrow().get(sym) {
          return Ok(found);
        }
        if env.borrow().is_uninitialized(sym) {
          return Err(RuntimeError::Other(format!("parameter {name} accessed before initialization")));
        }
        // A miss: own the name, since the missing-symbol hook below interns
        // through `self.interner`. The bound fast paths above copy nothing.
        let name = name.to_owned();
        let name = name.as_str();
        // Only now, on a name that was already an error, try the dot sugar.
        if let Some(sent) = self.dot_send(&env, name)? {
          return Ok(sent);
        }
        // A module name `use` introduced: `fs.read_dir` is `std.fs.read_dir`.
        if let Some(target) = self.module_target(name) {
          let target = self.interner.get_or_intern(&target);
          return self.eval_expression_inner(env, &Value::Symbol(crate::eval::Sym::from(&target)), None);
        }
        if let Some(hook) = self.missing_symbol.clone() {
          if let Some(definitions) = hook(name) {
            let root = Env::root_of(&env);
            for (symbol, value) in definitions {
              let s = self.interner.get_or_intern(symbol.as_str());
              self.define_source_binding(s, value.clone());
              root.borrow_mut().define(s, value);
            }
            if let Some(found) = env.borrow().get(sym) {
              return Ok(found);
            }
          }
        }
        // A renamed name the host still answers for one release: resolve
        // the new spelling (a retired command: partially applied to its
        // leading arguments) and record the old one.
        if let Some(target) = self.deprecated_target(name) {
          self.note_deprecation(name, &target.spelling());
          let symbol = self.interner.get_or_intern(&target.name);
          let value = self.eval_expression_inner(env, &Value::Symbol(crate::eval::Sym::from(&symbol)), None)?;
          return if target.leading.is_empty() { Ok(value) } else { self.deprecated_call(name, value, &target) };
        }
        Err(RuntimeError::UndefinedSymbol {
          detail: name.to_owned(),
        })
      }
      Value::List(list) => {
        // Empty list `()` evaluates to itself (matches JS: `()` is
        // a falsy/empty value, not a function call).
        if list.items.is_empty() {
          return Ok(Value::List(crate::eval::List { items: vec![].into() }));
        }
        let func = list.items.first().unwrap();

        let args: &[Value<S>] = &list.items.as_slice()[1..];

        // Special-form dispatch by symbol name. These must NOT have
        // their args evaluated up front.
        if let Value::Symbol(sym) = func {
          let sym = sym.as_symbol();
          if let Some(result) = self.eval_special_form(sym, env.clone(), args, tail) {
            return result;
          }
        }

        let func_eval = match (func, self.eval_expression(env.clone(), func)) {
          (Value::Symbol(sym), Err(RuntimeError::UndefinedSymbol { detail }))
            if self.call_head.is_some()
              && self.call_depth > 1
              && self.interner.resolve(sym.as_symbol()) == Some(detail.as_str()) =>
          {
            return self.call_unbound_head(env, detail, args);
          }
          (_, result) => result?,
        };
        match &func_eval {
          Value::Function(func @ Function::TypedNative(native)) => {
            let inputs = self.named_inputs(env.clone(), args)?;
            self.note_call(&env, func);
            return native.invoke(env, inputs);
          },
          Value::Function(Function::Lambda(lambda)) if lambda.signature.is_some() => {
            return self.eval_typed_lambda_source(env, lambda, args, tail);
          },
          Value::Type(ty) => return self.construct_struct(env, ty, args),
          _ => {},
        }
        // JS lisp falls through to "treat the list as a literal list"
        // when the head doesn't resolve to a callable. Required for
        // `(if (1 2 3) ...)` and similar expressions where a parenned
        // list is intended as a value, not a call.
        let func: Function<S> = match func_eval {
          Value::Function(f) => f,
          head => {
            // Evaluate the list literally — each element on its own,
            // reusing the head already evaluated above so its effects
            // happen once. Mirrors JS behavior for non-callable heads.
            let mut items = Vec::with_capacity(list.items.len());
            items.push(head);
            for item in args {
              items.push(self.eval_expression(env.clone(), item)?);
            }
            return Ok(Value::List(crate::eval::List { items: items.into() }));
          }
        };

        // One byte here, the rest out of line: this frame is on every
        // evaluation's path, and a recursion's depth is measured in it.
        if let Some(read) = Read::of_function(&func) {
          return self.read_or_call(env, read, func, args);
        }

        let mut eval_args = Vec::with_capacity(args.len());
        // A call inside a spine call's argument is on the spine too, with
        // the arguments after it and this callee still to come.
        for (index, arg) in args.iter().enumerate() {
          let later = tail.map(|tail| tail.later(&args[index + 1..], &func, &env));
          let at = match (tail, arg, &later) {
            (Some(tail), Value::List(_), Some(later)) => Some(tail.argument(later)),
            _ => None,
          };
          let arg = self.eval_expression_at(env.clone(), arg, at.as_ref())?;
          eval_args.push(arg);
        }
        if let Some(tail) = tail {
          self.release_last_reads(
            tail,
            &env,
            crate::tail::writes_in_place(&func),
            matches!(&func, Function::NativeFn(_)),
            args,
          );
        }

        self.eval_function(env.clone(), func, eval_args)
      }
      Value::TaggedString { tag, payload } => {
        if tag == "json" {
          let parsed: serde_json::Value = serde_json::from_str(payload)
            .map_err(|e| RuntimeError::Other(format!("invalid JSON in tagged literal: {}", e)))?;
          Ok(json_to_value(parsed))
        } else {
          Ok(Value::List(crate::eval::List {
            items: vec![Value::String(tag.as_str().into()), Value::String(payload.as_str().into())].into(),
          }))
        }
      }
      _ => Ok(expression.clone()),
    }
  }

  // Keep parsing and validation off the ordinary call frame: every recursive
  // Lisp call uses eval_function, while selected-source natives are rare.
  #[inline(never)]
  #[cold]
  fn eval_selected_source(&mut self, source: &str, heads: Option<&SourceHeads>) -> Result<Value<S>, RuntimeError> {
    use logos::Logos;
    let malformed =
      || RuntimeError::Other("source native requires exactly one symbol-headed form".into());
    if !matches!(
      crate::lexer::Token::lexer(source).next(),
      Some(Ok(crate::lexer::Token::ParenOpen))
    ) {
      return Err(malformed());
    }
    let forms = crate::Runtime::<S, B>::parse(None, source, &mut self.interner)
      .map_err(|e| RuntimeError::Other(format!("source native: {e}")))?;
    if forms.len() != 1 {
      return Err(malformed());
    }
    let form = Value::from_owned_sexpression(forms.into_iter().next().unwrap())
      .map_err(|e| RuntimeError::Other(format!("source native: {e}")))?;
    let Value::List(list) = &form else {
      return Err(malformed());
    };
    let Some(Value::Symbol(head)) = list.items.first() else {
      return Err(malformed());
    };
    let callable =
      || RuntimeError::Other("source native requires a non-special callable head".into());
    let name = self.interner.resolve(head.as_symbol()).unwrap_or("").to_owned();
    let name = name.as_str();
    if Self::special_form_name(name) || name == "do" {
      return Err(callable());
    }
    if heads.is_some_and(|admit| !admit(name)) {
      return Err(RuntimeError::Other(format!(
        "source native refuses head {name}: not an admitted command"
      )));
    }
    // Arguments are data: scalars, nil, keywords, named-argument keywords,
    // quoted lists of literals, and the reader's `[...]` / `{...}` sugar
    // (`(vector ...)` / `(hash-map ...)`) over literal children. The sugar is
    // built here, from the parsed data, so no argument is ever evaluated and
    // a shadowed `vector` or `hash-map` cannot run.
    fn quoted<S: Symbol, B: Backend<S>>(value: &Value<S>, interner: &StringInterner<B>) -> bool {
      match value {
        Value::String(_) | Value::Integer(_) | Value::Float(_) | Value::Boolean(_) | Value::Nil => {
          true
        }
        Value::Symbol(s) => interner.resolve(s.as_symbol()).is_some_and(|s| {
          s == "nil" || s == "null" || s.starts_with(':') || (s.len() > 1 && s.ends_with(':'))
        }),
        Value::List(list) => list.items.iter().all(|v| quoted(v, interner)),
        _ => false,
      }
    }
    fn head_is<S: Symbol, B: Backend<S>>(
      list: &crate::eval::List<S>,
      name: &str,
      interner: &StringInterner<B>,
    ) -> bool {
      matches!(list.items.first(), Some(Value::Symbol(s)) if interner.resolve(s.as_symbol()) == Some(name))
    }
    /// The value a literal datum denotes, or None when it is not data.
    fn datum<S: Symbol, B: Backend<S>>(
      value: &Value<S>,
      interner: &StringInterner<B>,
    ) -> Option<Value<S>> {
      match value {
        Value::String(_) | Value::Integer(_) | Value::Float(_) | Value::Boolean(_) | Value::Nil => {
          Some(value.clone())
        }
        Value::Symbol(s) => match interner.resolve(s.as_symbol())? {
          "nil" | "null" => Some(Value::Nil),
          // Matches the evaluator: `:key` is a self-evaluating string.
          name if name.starts_with(':') => Some(Value::String(name.into())),
          _ => None,
        },
        Value::List(list) if list.items.len() == 2 && head_is(list, "quote", interner) => {
          matches!(&list.items[1], Value::List(_))
            .then(|| quoted(&list.items[1], interner).then(|| list.items[1].clone()))
            .flatten()
        }
        Value::List(list) if head_is(list, "vector", interner) => {
          let items = list.items[1..]
            .iter()
            .map(|v| datum(v, interner))
            .collect::<Option<Vec<_>>>()?;
          Some(Value::List(crate::eval::List { items: items.into() }))
        }
        Value::List(list) if head_is(list, "hash-map", interner) => {
          let items = list.items[1..]
            .iter()
            .map(|v| datum(v, interner))
            .collect::<Option<Vec<_>>>()?;
          crate::stdlib::maps::hash_map(items).ok()
        }
        _ => None,
      }
    }
    let refused = || {
      RuntimeError::Other(
        "source native arguments must be literal data; symbols and nested calls are refused".into(),
      )
    };
    let mut items = Vec::with_capacity(list.items.len());
    items.push(list.items[0].clone());
    // A named-argument keyword must be followed by literal data: another
    // keyword in its value position would be evaluated as a root lookup.
    let mut key_pending = false;
    for arg in &list.items[1..] {
      if let Value::Symbol(s) = arg {
        // A named-argument keyword (`items:`) stays a symbol for the call's
        // own named-input handling; every other symbol must be data.
        if self.interner.resolve(s.as_symbol()).is_some_and(|s| s.len() > 1 && s.ends_with(':')) {
          if key_pending {
            return Err(refused());
          }
          key_pending = true;
          items.push(arg.clone());
          continue;
        }
      }
      key_pending = false;
      match datum(arg, &self.interner).ok_or_else(refused)? {
        // A list value in argument position would be evaluated as a call;
        // quote it so it arrives as the list it denotes.
        list @ Value::List(_) => {
          let quote = Value::Symbol(crate::eval::Sym::from(&self.interner.get_or_intern("quote")));
          items.push(Value::List(crate::eval::List { items: vec![quote, list].into() }));
        }
        value => items.push(value),
      }
    }
    if key_pending {
      return Err(refused());
    }
    let form = Value::List(crate::eval::List { items: items.into() });
    let root = self
      .source_root
      .clone()
      .ok_or_else(|| RuntimeError::Other("source native has no host root".into()))?;
    let scope = Rc::new(RefCell::new(Env::extend(root)));
    match self.eval_expression(scope.clone(), &Value::Symbol(head.clone()))? {
      // A source native as the head (std.next.call itself) would select and
      // run further source: advice may never chain.
      Value::Function(Function::NativeClosure(closure))
        if self.native_sources.contains_key(&(Rc::as_ptr(&closure) as *const () as usize)) =>
      {
        return Err(RuntimeError::Other(format!(
          "source native refuses head {name}: a source native cannot be advice"
        )));
      }
      Value::Function(_) => {}
      _ => return Err(callable()),
    }
    self.run_scope_body(&scope, std::slice::from_ref(&form), None)
  }

  /// A native closure may be a plain host closure, a scoped native or a
  /// source native. Kept out of line and cold so the two table lookups and
  /// the `select` result stay out of the frame every Lisp call pays for;
  /// `(define (boom) (boom))` under a depth budget of 200 must trip the
  /// budget before the Rust stack runs out.
  #[inline(never)]
  #[cold]
  fn call_native_closure(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    closure: NativeClosure<S>,
    args: Vec<Value<S>>,
  ) -> Result<Value<S>, RuntimeError> {
    let key = Rc::as_ptr(&closure) as *const () as usize;
    if let Some((_, select, heads)) = self.native_sources.get(&key).cloned() {
      let (value, source) = select(args)?;
      let Some(source) = source else { return Ok(value); };
      return self.eval_selected_source(&source, heads.as_ref());
    }
    if let Some((_, enter)) = self.native_scopes.get(&key).cloned() {
      let (thunk, _lifetime) = enter(args)?;
      let Value::Function(thunk) = thunk else {
        return Err(RuntimeError::Other("scope requires a callable thunk".into()));
      };
      self.eval_function(env, thunk, vec![])
    } else {
      closure(env, args)
    }
  }

  fn eval_function(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    func: Function<S>,
    args: Vec<Value<S>>,
  ) -> Result<Value<S>, RuntimeError> {
    self.note_call(&env, &func);
    match func {
      Function::TypedNative(native) => native.invoke(env, args.into_iter().map(|v| (None, v)).collect()),
      Function::NativeFn(func) => func(args),
      Function::NativeClosure(closure) => self.call_native_closure(env, closure, args),
      Function::Lambda(lambda) => {
        if lambda.signature.is_some() {
          return self.eval_typed_lambda_values(env, &lambda, args);
        }
        // Keep the untyped hot path at its original call-stack depth.
        let parent = lambda.captured_env.clone().unwrap_or_else(|| env.clone());
        let mut child = Env::extend(parent);
        for (name, arg) in std::iter::zip(lambda.params.iter().copied(), args) {
          child.define(name, arg);
        }
        let child_rc = Rc::new(RefCell::new(child));
        let tail = Tail::body(&child_rc);
        self.run_scope_body(&child_rc, &lambda.body, Some(&tail))
      }
    }
  }

  fn eval_typed_lambda_source(
    &mut self, env: Rc<RefCell<Env<S>>>, lambda: &Lambda<S>, args: &[Value<S>], tail: Option<&Tail<'_, S>>,
  ) -> Result<Value<S>, RuntimeError> {
    let inputs = self.named_inputs(env.clone(), args)?;
    // A typed function written in tento-lisp is a callee like any lambda: a
    // bare-name argument may be released into it (A-D3).
    if let Some(tail) = tail {
      self.release_last_reads(tail, &env, lambda.captured_env.is_some(), false, args);
    }
    let bound = lambda.signature.as_ref().unwrap().bind_inputs(inputs)?;
    let result = self.eval_typed_lambda(env, lambda, bound)?;
    Self::check_lambda_result(lambda, result)
  }

  fn eval_typed_lambda_values(
    &mut self, env: Rc<RefCell<Env<S>>>, lambda: &Lambda<S>, args: Vec<Value<S>>,
  ) -> Result<Value<S>, RuntimeError> {
    let inputs = args.into_iter().map(|v| (None, v)).collect();
    let bound = lambda.signature.as_ref().unwrap().bind_inputs(inputs)?;
    let result = self.eval_typed_lambda(env, lambda, bound)?;
    Self::check_lambda_result(lambda, result)
  }

  fn eval_typed_lambda(
    &mut self, env: Rc<RefCell<Env<S>>>, lambda: &Lambda<S>, args: Vec<Option<Value<S>>>,
  ) -> Result<Value<S>, RuntimeError> {
    let parent = lambda.captured_env.clone().unwrap_or(env);
    let mut child = Env::extend(parent);
    child.reserve_parameters(&lambda.params);
    let child = Rc::new(RefCell::new(child));
    if let Err(error) = self.initialize_lambda_parameters(&child, lambda, args) {
      crate::eval::release_scope(&child);
      return Err(error);
    }
    let tail = Tail::body(&child);
    self.run_scope_body(&child, &lambda.body, Some(&tail))
  }

  // Keep default evaluation/diagnostics out of recursive body frames.
  fn initialize_lambda_parameters(
    &mut self, scope: &Rc<RefCell<Env<S>>>, lambda: &Lambda<S>, args: Vec<Option<Value<S>>>,
  ) -> Result<(), RuntimeError> {
    let signature = lambda.signature.as_ref().unwrap();
    for (index, (param, supplied)) in signature.params.iter().zip(args).enumerate() {
      let value = match supplied {
        Some(value) => value,
        None => {
          let value = if let Some(expression) = &lambda.defaults[index] {
            self.eval_expression(scope.clone(), expression)?
          } else if param.kind == crate::types::ParamKind::Variadic {
            Value::List(crate::List { items: Vec::new().into() })
          } else if param.ty.optional() { Value::Nil }
          else { return Err(RuntimeError::Other(format!("missing argument {}", param.name))); };
          let mut errors = vec![];
          param.ty.check(&value, &format!("arguments.{}.default", param.name), &mut errors);
          crate::types::checked(errors)?;
          value
        },
      };
      scope.borrow_mut().define(lambda.params[index], value);
    }
    Ok(())
  }

  // Run validation only after the call frame is released. Keeping this out of
  // eval_typed_lambda avoids growing every recursive frame with result diagnostics.
  fn check_lambda_result(lambda: &Lambda<S>, result: Value<S>) -> Result<Value<S>, RuntimeError> {
    if let Some(signature) = &lambda.signature {
      let mut errors = vec![];
      signature.result.check(&result, "result", &mut errors);
      crate::types::checked(errors)?;
    }
    Ok(result)
  }

  /// Evaluate `forms` in `scope` (last value wins), then release the scope —
  /// see [`crate::eval::release_scope`] — whether or not the body succeeded,
  /// so a failing helper does not keep its frame either.
  fn run_scope_body(
    &mut self,
    scope: &Rc<RefCell<Env<S>>>,
    forms: &[Value<S>],
    tail: Option<&Tail<'_, S>>,
  ) -> Result<Value<S>, RuntimeError> {
    let mut last = Value::Nil;
    let mut outcome = Ok(());
    for (index, form) in forms.iter().enumerate() {
      let at = if index + 1 == forms.len() { tail } else { None };
      match self.eval_expression_at(scope.clone(), form, at) {
        Ok(value) => last = value,
        Err(error) => {
          outcome = Err(error);
          break;
        }
      }
    }
    crate::eval::release_scope(scope);
    outcome.map(|()| last)
  }

  fn special_form_name(name: &str) -> bool {
    matches!(
      name,
      "struct"
        | "trait"
        | "impl"
        | "type"
        | "trait.describe"
        | "trait.conforms"
        | "trait.check"
        | "trait.impls"
        | "trait.report"
        | "module.name"
        | "module.bundle"
        | "quote"
        | "if"
        | "begin"
        | "define"
        | "def"
        | "defun"
        | "fn"
        | "set"
        | "set!"
        | "lambda"
        | "let"
        | "cond"
        | "and"
        | "or"
        | "match"
        | "try"
        | "std.stream.with"
        | "unwrap"
        | "expect"
        | "map"
        | "filter"
        | "reduce"
        | "fold"
        | "group-by"
        | "apply"
        | "json-from-list"
        | "@import"
        | "use"
        | "cfg?"
        | "@cfg"
    )
  }

  /// Returns `Some(...)` if the symbol matched a special form. Mirrors
  /// JS `ControlFlow` operators that need to control evaluation.
  fn eval_special_form(
    &mut self,
    symbol: S,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
    tail: Option<&Tail<'_, S>>,
  ) -> Option<Result<Value<S>, RuntimeError>> {
    // Borrow only for dispatch; evaluation may mutate the interner afterward.
    let name = self.interner.resolve(symbol).unwrap_or("");
    if !Self::special_form_name(name) && !(name == "cfg" && args.is_empty()) {
      return None;
    }
    match name {
      "struct" => Some(self.structural_declaration("struct", env, args)),
      "trait" => Some(self.structural_declaration("trait", env, args)),
      "impl" => Some(self.special_impl(env, args)),
      "type" => Some(self.structural_declaration("type", env, args)),
      name @ ("trait.describe" | "trait.conforms" | "trait.check" | "trait.impls" | "trait.report" | "module.name" | "module.bundle") => {
        let name = name.to_string();
        Some(self.structural_reflection(&name, env, args))
      },
      "quote" => Some(self.special_quote(args)),
      "if" => Some(self.special_if(env, args, tail)),
      "begin" => Some(self.special_begin(env, args, tail)),
      "define" => Some(self.special_define(env, args)),
      // Operator ruling 19 (2026-10-06): `let` is the binding form; `def`
      // is gone with no deprecation window, and says what replaced it.
      "def" => Some(Err(RuntimeError::Other(DEF_REMOVED.into()))),
      "defun" => Some(self.special_defun(env, args, "defun")),
      "fn" => Some(self.special_defun(env, args, "fn")),
      // Refinement 8 (2026-10-05): `set!` became `set`; `!` is reserved for
      // macros. The old spelling works, and warns, for one release.
      "set" => Some(self.special_set(env, args)),
      "set!" => {
        self.note_deprecation("set!", "set");
        Some(self.special_set(env, args))
      }
      "lambda" => Some(self.special_lambda(env, args)),
      "let" => Some(self.special_let(env, args, tail)),
      "cond" => Some(self.special_cond(env, args, tail)),
      "and" => Some(self.special_and(env, args)),
      "or" => Some(self.special_or(env, args)),
      "match" => Some(self.special_match(env, args)),
      // Errors-at-the-seam (Phase 2): `try` is the ONLY constructor of an
      // in-language error value; `unwrap`/`expect` escalate soft to hard.
      "try" => Some(self.special_try(env, args)),
      "std.stream.with" => Some(self.special_stream_with(env, args)),
      "unwrap" => Some(self.special_unwrap(env, args)),
      "expect" => Some(self.special_expect(env, args)),
      // Higher-order helpers — evaluated like normal functions but
      // need interpreter access to invoke the lambda each iteration.
      "map" => Some(self.special_map(env, args)),
      "filter" => Some(self.special_filter(env, args)),
      "reduce" | "fold" => Some(self.special_reduce(env, args)),
      "group-by" => Some(self.special_group_by(env, args)),
      "apply" => Some(self.special_apply(env, args)),
      "json-from-list" => Some(self.special_json_from_list(env, args)),
      "@import" => Some(self.special_import(env, args)),
      "use" => Some(self.special_use(env, args)),
      // Rust-style cfg: `(cfg? P)` is `cfg!(P)` and `(cfg)` every key. Only
      // the zero-argument `(cfg)` is claimed: `cfg` is a common variable name.
      "cfg?" => Some(self.special_cfg_test(args)),
      "cfg" if args.is_empty() => Some(Ok(self.cfg_keys())),
      "@cfg" => Some(Err(RuntimeError::Other(CFG_NESTED.into()))),
      _ => None,
    }
  }

  /// `(@import "name" :as "ns")` — reserved host directive. Evaluates the bundle
  /// name (first arg) and the explicit namespace (the `:as` value), passes both
  /// to the registered `ImportHandler`, then mounts the returned `(symbol,
  /// value)` pairs into the call-site env via the interpreter's own interner.
  /// Returns `Nil`.
  ///
  /// The namespace is **required** and explicit: the mount site (not the bundle)
  /// names the group, so there is no implicit/derived default. The `:as` marker
  /// is a bare symbol — it is matched structurally and never evaluated.
  ///
  /// This stays at the language level (not a runner directive) so the form
  /// reads like normal lisp; the mount itself is host-defined (see
  /// `set_import_handler`).
  fn special_import(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    // Shapes: `(@import <name> :as <ns> [:from <dir>] [:optional])`. `:optional`
    // is a bare flag: the import is HOST-DEPENDENT, so a bundle that does not
    // resolve here is a silent no-op rather than a failure. Everything else
    // about the form is unchanged.
    if args.len() < 3 {
      return Err(RuntimeError::ArityError {
        detail:
          "@import requires `(@import \"name\" :as \"namespace\" [:from \"dir\"] [:optional])`"
            .into(),
      });
    }
    // args[1] must be the bare `:as` marker symbol — matched structurally, NOT
    // evaluated (evaluating `:as` would look it up as an undefined symbol).
    let is_as_marker = matches!(
      &args[1],
      Value::Symbol(sym) if self.interner.resolve(sym.as_symbol()) == Some(":as")
    );
    if !is_as_marker {
      return Err(RuntimeError::Other(
        "@import: expected `:as <namespace>` after the app name".into(),
      ));
    }

    let name = self.eval_string_arg(env.clone(), &args[0], "@import app name")?;
    let namespace = self.eval_string_arg(env.clone(), &args[2], "@import :as namespace")?;

    // The trailing modifiers, in any order: `:from <dir>` (a self-resolving
    // search dir for this import) and the bare `:optional` flag. Scanned rather
    // than positionally matched so the two compose without an arity table.
    let mut from: Option<String> = None;
    let mut optional = false;
    let mut idx = 3;
    while idx < args.len() {
      let marker = match &args[idx] {
        Value::Symbol(sym) => self.interner.resolve(sym.as_symbol()).map(str::to_string),
        _ => None,
      };
      match marker.as_deref() {
        Some(":from") => {
          let Some(dir) = args.get(idx + 1) else {
            return Err(RuntimeError::Other(
              "@import: `:from` needs a directory argument".into(),
            ));
          };
          from = Some(self.eval_string_arg(env.clone(), dir, "@import :from dir")?);
          idx += 2;
        }
        Some(":optional") => {
          optional = true;
          idx += 1;
        }
        _ => {
          return Err(RuntimeError::Other(
            "@import: expected `:from <dir>` and/or `:optional` after the namespace".into(),
          ));
        }
      }
    }

    let handler = self
      .import_handler
      .clone()
      .ok_or_else(|| RuntimeError::Other("@import: no import handler registered".into()))?;
    let mounts = match handler(&name, &namespace, from.as_deref()) {
      Ok(mounts) => mounts,
      Err(e) if e.is_hard() => return Err(e),
      // `:optional` means "mount this where it exists". An unresolvable bundle
      // is then the DECLARED case, not a failure — nothing mounts and the form
      // is a no-op. Without the flag the error propagates exactly as before.
      Err(_) if optional => return Ok(Value::Nil),
      Err(e) => return Err(e),
    };
    for (symbol, value) in mounts {
      let sym = self.interner.get_or_intern(&symbol);
      self.define_source_binding(sym, value.clone());
      env.borrow_mut().define(sym, value);
    }
    Ok(Value::Nil)
  }

  /// Evaluate `arg` and require it to be a `String` (used for `@import`'s name
  /// and namespace). `what` labels the slot in the type error.
  fn eval_string_arg(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    arg: &Value<S>,
    what: &str,
  ) -> Result<String, RuntimeError> {
    match self.eval_expression(env, arg)? {
      Value::String(s) => Ok(s.into_string()),
      other => Err(RuntimeError::TypeError {
        expected: format!("String ({what})"),
        got: format!("{:?}", other.as_type()),
      }),
    }
  }

  /// `use` (R7), the three shapes phase 1 needs. Returns `Nil`.
  ///
  /// - `(use tsh.toolchain as: toolchain)` binds `toolchain` to the
  ///   path's value and tells the host (the use hook) that `as:` named it.
  /// - `(use std.fs)` names the module by its last segment, so `fs.read_dir`
  ///   resolves `std.fs.read_dir`; a path that is itself a value also binds
  ///   that segment as a Lisp name.
  /// - `(use std.fs.(read_dir write))` binds each item as a Lisp name.
  ///
  /// `as:` is B5's key spelling and the only one. The bound name follows the
  /// read-only rules, a path naming nothing is an error naming it, and a
  /// refusal from the hook binds nothing. Plugin packages are `@import`'s.
  /// `(cfg? P)`: whether this process's keys satisfy the predicate `P`,
  /// which is read, not evaluated (`(cfg? session)`, `(cfg? (os = "macos"))`).
  fn special_cfg_test(&mut self, args: &[Value<S>]) -> Result<Value<S>, RuntimeError> {
    let nodes: Vec<crate::cfg::Node> = args.iter().map(|arg| self.cfg_node(arg)).collect();
    let pred = crate::cfg::Pred::from_args(&nodes).map_err(|e| RuntimeError::Other(e.to_string()))?;
    crate::cfg::active()
      .eval(&pred)
      .map(Value::Boolean)
      .map_err(|e| RuntimeError::Other(e.to_string()))
  }

  /// `(cfg)`: every key as a map, a valued key to its value and a bare one to
  /// `true`. A name set with several values maps to a list of them.
  fn cfg_keys(&mut self) -> Value<S> {
    let mut out: indexmap::IndexMap<String, Value<S>> = indexmap::IndexMap::new();
    for (name, value) in crate::cfg::active().keys() {
      let value = value.map_or(Value::Boolean(true), |v| Value::String(v.into()));
      match out.get_mut(name) {
        Some(Value::List(list)) => list.items.push(value),
        Some(prior) => {
          let first = std::mem::replace(prior, Value::Nil);
          *prior = Value::List(crate::eval::List { items: vec![first, value].into() });
        }
        None => {
          out.insert(name.to_owned(), value);
        }
      }
    }
    Value::Map(out.into())
  }

  fn cfg_node(&self, value: &Value<S>) -> crate::cfg::Node {
    use crate::cfg::Node;
    match value {
      Value::Symbol(sym) => Node::Symbol(self.interner.resolve(sym.as_symbol()).unwrap_or("").to_owned()),
      Value::String(s) => Node::String(s.to_string()),
      Value::List(list) => Node::List(list.items.iter().map(|item| self.cfg_node(item)).collect()),
      other => Node::Other(format!("{other:?}")),
    }
  }

  fn special_use(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    let shapes = || {
      RuntimeError::Other(
        "use: expected (use PATH), (use PATH as: NAME), (use PATH (a b)) or (use PATH.(a b))"
          .into(),
      )
    };
    let missing = |path: &str| RuntimeError::Other(format!("use: nothing is named `{path}`"));
    let name_of = |interp: &Self, value: &Value<S>| match value {
      Value::Symbol(sym) => interp.interner.resolve(sym.as_symbol()).map(str::to_string),
      _ => None,
    };
    let first = args.first().ok_or_else(shapes)?;
    if matches!(first, Value::String(_)) {
      return Err(RuntimeError::Other(
        "use: plugin packages still use @import, e.g. (@import \"tsh-tmux\" :as \"mux\")".into(),
      ));
    }
    let path = name_of(self, first).ok_or_else(shapes)?;
    // `std.fs.(read_dir write)` reads as the name `std.fs.` and a list.
    if path.ends_with('.') || matches!(args, [_, Value::List(_)]) {
      let module = path.strip_suffix('.').unwrap_or(&path);
      let [_, Value::List(items)] = args else {
        return Err(shapes());
      };
      let mut bound = Vec::with_capacity(items.items.len());
      for item in &items.items {
        let name = name_of(self, item)
          .ok_or_else(|| RuntimeError::Other(format!("use: each item of `{path}(…)` is a name")))?;
        let full = format!("{module}.{name}");
        let value = self.use_value(&env, &full)?.ok_or_else(|| missing(&full))?;
        bound.push((name, full, value));
      }
      let mut symbols = Vec::with_capacity(bound.len());
      for (name, _, _) in &bound {
        let sym = self.interner.get_or_intern(name);
        self.check_binding(sym)?;
        symbols.push(sym);
      }
      if let Some(hook) = self.use_hook.clone() {
        for (name, full, value) in &bound {
          hook(name, full, value, false)?;
        }
      }
      for (sym, (_, _, value)) in symbols.into_iter().zip(bound) {
        env.borrow_mut().define(sym, value);
      }
      return Ok(Value::Nil);
    }
    let word = match &args[1..] {
      [] => None,
      [marker, rest @ ..] => match name_of(self, marker).as_deref() {
        Some("as:") => match rest {
          [word] => Some(name_of(self, word).ok_or_else(|| {
            RuntimeError::Other("use: `as:` needs a name, e.g. (use std.fs as: fs)".into())
          })?),
          [] => return Err(RuntimeError::Other("use: `as:` needs a name, e.g. (use std.fs as: fs)".into())),
          _ => return Err(shapes()),
        },
        // B5b: `as:toolchain` is `as: toolchain`.
        Some(key) if key.len() > 3 && key.starts_with("as:") && rest.is_empty() => Some(key[3..].to_string()),
        Some(other @ (":as" | "as")) => {
          return Err(RuntimeError::Other(format!("use: write `as: NAME`, not `{other}` (B5's key spelling)")));
        }
        _ => return Err(shapes()),
      },
    };
    let value = self.use_value(&env, &path)?;
    let module = self.names_a_module(&env, &path);
    if value.is_none() && !module {
      return Err(missing(&path));
    }
    let name = match &word {
      Some(word) => word.clone(),
      None => path.rsplit('.').next().unwrap_or(&path).to_string(),
    };
    let sym = self.interner.get_or_intern(&name);
    self.check_binding(sym)?;
    if let (Some(value), Some(hook)) = (&value, self.use_hook.clone()) {
      hook(&name, &path, value, word.is_some())?;
    }
    if let Some(value) = value {
      env.borrow_mut().define(sym, value);
    } else if module {
      let prefix = format!("{path}.");
      let mut exports = std::collections::BTreeMap::new();
      for (symbol, value) in env.borrow().visible_bindings() {
        let Some(member) = self.interner.resolve(symbol).and_then(|name| name.strip_prefix(&prefix)) else { continue; };
        exports.insert(member.to_string(), value);
      }
      let namespace = crate::types::Module::new(path.clone(), Default::default()).with_exports(exports);
      env.borrow_mut().define(sym, Value::Module(Rc::new(namespace)));
    }
    if module {
      self.modules.insert(name, path);
    }
    Ok(Value::Nil)
  }

  /// The value `path` names, or `None` when it names none.
  fn use_value(&mut self, env: &Rc<RefCell<Env<S>>>, path: &str) -> Result<Option<Value<S>>, RuntimeError> {
    let sym = self.interner.get_or_intern(path);
    match self.eval_expression_inner(env.clone(), &Value::Symbol(crate::eval::Sym::from(&sym)), None) {
      Ok(value) => Ok(Some(value)),
      Err(RuntimeError::UndefinedSymbol { .. }) => Ok(None),
      Err(error) => Err(error),
    }
  }

  /// Whether some bound name lives under `path.`: a module to `use`.
  fn names_a_module(&self, env: &Rc<RefCell<Env<S>>>, path: &str) -> bool {
    let prefix = format!("{path}.");
    let env = env.borrow();
    env.visible_bindings().into_iter().any(|(sym, _)| {
      self
        .interner
        .resolve(sym)
        .is_some_and(|name| name.starts_with(&prefix))
    })
  }

  /// Bind a live host token for the body and close it at this scope boundary.
  fn special_stream_with(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    let Some(Value::List(binding)) = args.first() else {
      return Err(RuntimeError::Other("std.stream.with requires (SYM EXPR) and a body".into()));
    };
    let [Value::Symbol(name), expression] = binding.items.as_slice() else {
      return Err(RuntimeError::Other("std.stream.with requires exactly (SYM EXPR)".into()));
    };
    if args.len() < 2 {
      return Err(RuntimeError::Other("std.stream.with requires a body".into()));
    }
    self.check_internal_binding(name.as_symbol())?;
    let value = self.eval_expression(env.clone(), expression)?;
    if matches!(value, Value::Error(_)) { return Ok(value); }
    let Value::String(token) = &value else {
      return Err(RuntimeError::Other("std.stream.with requires a live stream token".into()));
    };
    let enter = self.stream_scope.as_ref().ok_or_else(|| RuntimeError::Other(
      "std.stream.with: this host has no stream table".into()))?.clone();
    let guard = enter(token)?;
    let child = Rc::new(RefCell::new(Env::extend(env)));
    child.borrow_mut().define(name.as_symbol(), value);
    // No tail-frame release may skip this lifetime boundary.
    let result = self.run_scope_body(&child, &args[1..], None);
    drop(guard);
    result
  }

  /// `(try form)` / `(try form :or fallback)` — the ONLY constructor of an
  /// in-language error value. Rust analogs: a `try` block for the plain form,
  /// `unwrap_or_else` for `:or`. Evaluates `form`:
  /// - success → the value, unchanged.
  /// - a HARD error (`is_hard()`: budget/deadline/depth, `assert`, `unwrap`/
  ///   `expect`, structural misuse) → propagated unchanged; never defused.
  /// - a SOFT error → with `:or fallback`, the fallback is evaluated LAZILY
  ///   (only on failure) and returned; without, a falsy `Value::Error`
  ///   capturing the failure is returned.
  ///
  /// **Value-awareness (the family rule, shared with `unwrap`/`expect`):** a
  /// reified `Value::Error` — captured earlier by a `try` — is treated exactly
  /// like an in-flight soft failure by the handling forms, and ONLY by them
  /// (no other call site inspects error values; no contagion). Here: `:or` on
  /// a form that evaluates OK **to** an error value fires the fallback
  /// (`unwrap_or_else` on an `Err`); plain `try` returns the error value
  /// unchanged — `try` is idempotent.
  ///
  /// Misuse of `try` itself — no form, or a non-`:or` third element — is a
  /// structural (hard) error, so a typo can't silently swallow the form.
  fn special_try(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    // Shapes: `(try FORM)` or `(try FORM :or FALLBACK)`.
    if args.is_empty() || args.len() == 2 || args.len() > 3 {
      return Err(RuntimeError::ArityError {
        detail: "try takes `(try form)` or `(try form :or fallback)`".into(),
      });
    }
    let fallback = if args.len() == 3 {
      // args[1] must be the bare `:or` marker — matched structurally, NOT
      // evaluated (like `@import`'s `:as`). A wrong keyword is a hard error.
      let is_or_marker = matches!(
        &args[1],
        Value::Symbol(sym) if self.interner.resolve(sym.as_symbol()) == Some(":or")
      );
      if !is_or_marker {
        return Err(RuntimeError::ExpectedToken {
          detail: "try: expected `:or <fallback>` after the form".into(),
        });
      }
      Some(&args[2])
    } else {
      None
    };
    match self.eval_expression(env.clone(), &args[0]) {
      Ok(v) => {
        // Value-awareness: a reified error value takes the `:or` fallback
        // exactly like an in-flight soft failure would; without `:or` it
        // passes through unchanged (idempotent — `(try (try x))` ≡ `(try x)`).
        if matches!(v, Value::Error(_)) {
          if let Some(fallback) = fallback {
            return self.eval_expression(env, fallback);
          }
        }
        Ok(v)
      }
      Err(e) if e.is_hard() => Err(e),
      Err(e) => {
        if let Some(fallback) = fallback {
          // Lazy: the fallback is only evaluated on a soft error.
          self.eval_expression(env, fallback)
        } else {
          // Built out of line: this frame recurses with every nested
          // `(try …)`, so the error value's fields must not live in it.
          let origin = Some(crate::value_format::format_source(&self.interner, &args[0]));
          Ok(Value::Error(error_value(e, origin)))
        }
      }
    }
  }

  /// `(unwrap form)` — Rust's `.unwrap()`, the function-form precursor of
  /// Phase 3's postfix `!`. Success passes through; a SOFT failure — in-flight
  /// error OR a reified `Value::Error` the form evaluated to (the family rule,
  /// see `special_try`) — escalates to a HARD `Fatal` (`"unwrap failed: …"`),
  /// so a `WarnContinue` unit halts on it and `try` cannot defuse it. A HARD
  /// error propagates unchanged.
  fn special_unwrap(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "unwrap takes exactly 1 arg: `(unwrap form)`".into(),
      });
    }
    match self.eval_expression(env, &args[0]) {
      // Value-awareness: escalate a reified error exactly like an in-flight
      // soft failure, carrying its message (+ origin) so the panic diagnoses.
      Ok(Value::Error(e)) => Err(RuntimeError::Fatal {
        detail: format!("unwrap failed: {}", reified_error_text(&e)),
      }),
      Ok(v) => Ok(v),
      Err(e) if e.is_hard() => Err(e),
      Err(e) => Err(RuntimeError::Fatal {
        detail: format!("unwrap failed: {e}"),
      }),
    }
  }

  /// `(expect form "message")` — Rust's `.expect()`: the message is REQUIRED
  /// (that's the point of `expect` over `unwrap`; use `(unwrap form)` for the
  /// messageless assert). Success passes through; a SOFT failure — in-flight
  /// error OR a reified `Value::Error` the form evaluated to (the family rule,
  /// see `special_try`) — escalates to a HARD `Fatal` with the message as the
  /// prefix. A HARD error propagates unchanged. The message is only evaluated
  /// on the failure path (matches `.expect()`).
  fn special_expect(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail:
          "expect takes `(expect form \"message\")` — for the messageless form use `(unwrap form)`"
            .into(),
      });
    }
    match self.eval_expression(env.clone(), &args[0]) {
      Ok(Value::Error(e)) => {
        let msg = self.eval_string_arg(env, &args[1], "expect message")?;
        Err(RuntimeError::Fatal {
          detail: format!("{msg}: {}", reified_error_text(&e)),
        })
      }
      Ok(v) => Ok(v),
      Err(e) if e.is_hard() => Err(e),
      Err(e) => {
        let msg = self.eval_string_arg(env, &args[1], "expect message")?;
        Err(RuntimeError::Fatal {
          detail: format!("{msg}: {e}"),
        })
      }
    }
  }

  fn special_quote(&self, args: &[Value<S>]) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "quote takes 1 arg".into(),
      });
    }
    // JS represents symbols as plain strings — `(quote a)` returns
    // `"a"`. To match, walk the quoted form and convert every
    // `Value::Symbol` to its interned name as a `Value::String`.
    Ok(self.quote_symbols_to_strings(&args[0]))
  }

  fn quote_symbols_to_strings(&self, v: &Value<S>) -> Value<S> {
    match v {
      Value::Symbol(s) => {
        let name = self
          .interner
          .resolve(s.as_symbol())
          .unwrap_or("")
          .to_string();
        // `null` is a parser-level literal in JS Lisp (lisp.ts:240) —
        // it stays as Nil under quote, never becomes a symbol-name
        // string. `nil` and `undefined` ARE symbols, so they
        // round-trip as their textual name.
        if name == "null" {
          return Value::Nil;
        }
        Value::String(name.into())
      }
      Value::List(l) => Value::List(crate::eval::List {
        items: l
          .items
          .iter()
          .map(|v| self.quote_symbols_to_strings(v))
          .collect(),
      }),
      // Quote of a tagged-string returns its 2-element list form
      // uniformly — even for `json` (no parser invoked under quote).
      Value::TaggedString { tag, payload } => Value::List(crate::eval::List {
        items: vec![Value::String(tag.as_str().into()), Value::String(payload.as_str().into())].into(),
      }),
      _ => v.clone(),
    }
  }

  fn special_if(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
    tail: Option<&Tail<'_, S>>,
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 || args.len() > 3 {
      return Err(RuntimeError::ArityError {
        detail: "if takes 2 or 3 args".into(),
      });
    }
    let cond = self.eval_expression(env.clone(), &args[0])?;
    if cond.is_truthy() {
      self.eval_expression_at(env, &args[1], tail)
    } else if args.len() == 3 {
      self.eval_expression_at(env, &args[2], tail)
    } else {
      // No else: the unit value, as Rust's `if` without `else` is `()`
      // (decision 2a, 2026-10-04; it used to be JS Lisp's `0`).
      Ok(Value::Nil)
    }
  }

  fn special_begin(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
    tail: Option<&Tail<'_, S>>,
  ) -> Result<Value<S>, RuntimeError> {
    self.eval_sequence(env, args, tail)
  }

  /// Evaluate `forms` in order and answer the last value; the last form
  /// keeps `tail`.
  fn eval_sequence(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    forms: &[Value<S>],
    tail: Option<&Tail<'_, S>>,
  ) -> Result<Value<S>, RuntimeError> {
    let mut last = Value::Nil;
    for (index, form) in forms.iter().enumerate() {
      let at = if index + 1 == forms.len() { tail } else { None };
      last = self.eval_expression_at(env.clone(), form, at)?;
    }
    Ok(last)
  }

  fn special_define(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.is_empty() {
      return Err(RuntimeError::ArityError {
        detail: "define needs at least a name".into(),
      });
    }
    // (define name expr) | (define (name params...) body...)
    match &args[0] {
      Value::Symbol(sym) => {
        let name = sym.as_symbol();
        self.check_binding(name)?;
        let value = if args.len() >= 2 {
          self.eval_expression(env.clone(), &args[1])?
        } else {
          Value::Nil
        };
        env.borrow_mut().define(name, value.clone());
        Ok(value)
      }
      Value::List(sig) => {
        // Shorthand: (define (name params...) body...)
        let head = sig
          .items
          .first()
          .ok_or_else(|| RuntimeError::Other("define shorthand needs a name".into()))?;
        let name_sym: crate::eval::Sym<S> = head.clone().try_into()?;
        self.check_binding(name_sym.as_symbol())?;
        let name = self.interner.resolve(name_sym.as_symbol()).unwrap_or("function").to_string();
        let lambda = self.user_lambda(env.clone(), &name, &sig.items[1..], &args[1..])?;
        env
          .borrow_mut()
          .define(name_sym.as_symbol(), lambda.clone());
        Ok(lambda)
      }
      _ => Err(RuntimeError::TypeError {
        expected: "Symbol or List".into(),
        got: format!("{:?}", args[0].as_type()),
      }),
    }
  }

  fn special_defun(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
    spelling: &'static str,
  ) -> Result<Value<S>, RuntimeError> {
    // (defun|fn name (params...) body...)
    if args.len() < 3 {
      return Err(RuntimeError::ArityError {
        detail: format!("{spelling} takes name + params + body"),
      });
    }
    let name_sym: crate::eval::Sym<S> = args[0].clone().try_into()?;
    self.check_binding(name_sym.as_symbol())?;
    let params_list = match &args[1] {
      Value::List(l) => l.items.clone(),
      _ => return Err(Type::list_expected(&args[1])),
    };
    let name = self.interner.resolve(name_sym.as_symbol()).unwrap_or("function").to_string();
    let lambda = self.user_lambda(env.clone(), &name, &params_list, &args[2..])?;
    env
      .borrow_mut()
      .define(name_sym.as_symbol(), lambda.clone());
    Ok(lambda)
  }

  fn special_set(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "set takes 2 args".into(),
      });
    }
    let name = match &args[0] {
      Value::Symbol(s) => s.as_symbol(),
      _ => {
        return Err(RuntimeError::TypeError {
          expected: "Symbol".into(),
          got: format!("{:?}", args[0].as_type()),
        });
      }
    };
    self.check_binding(name)?;
    let value = self.eval_expression(env.clone(), &args[1])?;
    env
      .borrow_mut()
      .set(name, value.clone())
      .map_err(|_| RuntimeError::UndefinedSymbol {
        detail: self.interner.resolve(name).unwrap_or("<>").to_string(),
      })?;
    Ok(value)
  }

  fn special_lambda(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 {
      return Err(RuntimeError::ArityError {
        detail: "lambda needs params + body".into(),
      });
    }
    let params_list = match &args[0] {
      Value::List(l) => l.items.clone(),
      _ => return Err(Type::list_expected(&args[0])),
    };
    self.user_lambda(env, "lambda", &params_list, &args[1..])
  }

  /// `let` is both the binding form and the scoped form; the FIRST argument
  /// decides which (operator rulings 18/19, 2026-10-06):
  ///
  /// - a symbol: `(let NAME VALUE)` binds NAME in the current scope, as Rust's
  ///   `let` does (what `def` did; the same read-only-root guard applies).
  ///   `(let NAME VALUE body…)` binds it only for the body.
  /// - a list of lists: `(let ((a 1) (b 2)) body…)`, sequential bindings in a
  ///   child scope.
  /// - a vector: `(let [a 1 b 2] body…)`, the Clojure spelling of the same.
  ///
  /// A function is `(let NAME (lambda (params…) body…))`; there is no
  /// `(let (NAME params…) …)` shorthand.
  fn special_let(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
    tail: Option<&Tail<'_, S>>,
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 {
      return Err(RuntimeError::ArityError {
        detail: "let needs NAME VALUE, or bindings + body".into(),
      });
    }
    let child = Env::extend(env.clone());
    let child_rc = Rc::new(RefCell::new(child));

    // Common Lisp form: (let ((var1 val1) (var2 val2)) body...)
    // Distinguished from Clojure form by the inner pair being a List.
    if let Value::List(bindings) = &args[0] {
      let cl_form =
        !bindings.items.is_empty() && bindings.items.iter().all(|b| matches!(b, Value::List(_)));
      if cl_form {
        for b in &bindings.items {
          if let Value::List(pair) = b {
            if pair.items.len() < 2 {
              return Err(RuntimeError::Other("let binding needs a value".into()));
            }
            let name = match &pair.items[0] {
              Value::Symbol(s) => s.as_symbol(),
              _ => return Err(Type::sym_expected(&pair.items[0])),
            };
            // Sequential: each binding sees previous ones.
            self.check_internal_binding(name)?;
            let val = self.eval_expression(child_rc.clone(), &pair.items[1])?;
            child_rc.borrow_mut().define(name, val);
          }
        }
        let frame = tail.map(|tail| tail.let_frame(&child_rc));
        let inner = tail.zip(frame.as_ref()).map(|(tail, frame)| tail.within(frame));
        return self.run_scope_body(&child_rc, &args[1..], inner.as_ref());
      }
    }

    // Clojure form: (let [var1 val1 var2 val2 ...] body...)
    // Vector literals desugar to (vector ...) at parse time, so we
    // detect by leading `vector` symbol. Empty vectors `[]` desugar
    // to `(vector)` (no items beyond the head).
    if let Value::List(form) = &args[0] {
      if let Some(Value::Symbol(head)) = form.items.first() {
        let head_name = self.interner.resolve(head.as_symbol()).unwrap_or("");
        if head_name == "vector" {
          let pairs = &form.items[1..];
          if pairs.len() % 2 != 0 {
            return Err(RuntimeError::Other(
              "Clojure-style let needs an even number of binding items".into(),
            ));
          }
          let mut i = 0;
          while i < pairs.len() {
            let name = match &pairs[i] {
              Value::Symbol(s) => s.as_symbol(),
              _ => return Err(Type::sym_expected(&pairs[i])),
            };
            self.check_internal_binding(name)?;
            let val = self.eval_expression(child_rc.clone(), &pairs[i + 1])?;
            child_rc.borrow_mut().define(name, val);
            i += 2;
          }
          let frame = tail.map(|tail| tail.let_frame(&child_rc));
          let inner = tail.zip(frame.as_ref()).map(|(tail, frame)| tail.within(frame));
          return self.run_scope_body(&child_rc, &args[1..], inner.as_ref());
        }
      }
    }

    // Simple form: (let var value [body...])
    if let Value::Symbol(s) = &args[0] {
      if args.len() < 2 {
        return Err(RuntimeError::ArityError {
          detail: "simple let needs at least var + value".into(),
        });
      }
      // No body: the binding form — bind in the CALLING env, so
      // `(begin (let a 5) (* a 2))` and a top-level `(let a 5)` declare `a`.
      if args.len() == 2 {
        self.check_binding(s.as_symbol())?;
      } else {
        self.check_internal_binding(s.as_symbol())?;
      }
      let val = self.eval_expression(env.clone(), &args[1])?;
      if args.len() == 2 {
        env.borrow_mut().define(s.as_symbol(), val.clone());
        return Ok(val);
      }
      // With body: bind in child env, evaluate body forms.
      child_rc.borrow_mut().define(s.as_symbol(), val);
      let frame = tail.map(|tail| tail.let_frame(&child_rc));
      let inner = tail.zip(frame.as_ref()).map(|(tail, frame)| tail.within(frame));
      return self.run_scope_body(&child_rc, &args[2..], inner.as_ref());
    }
    Err(RuntimeError::Other("unrecognized let form".into()))
  }

  fn special_cond(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
    tail: Option<&Tail<'_, S>>,
  ) -> Result<Value<S>, RuntimeError> {
    for clause in args {
      let pair = match clause {
        Value::List(l) => l,
        _ => return Err(Type::list_expected(clause)),
      };
      if pair.items.is_empty() {
        continue;
      }
      // `(else expr...)` always fires.
      if let Value::Symbol(s) = &pair.items[0] {
        let name = self.interner.resolve(s.as_symbol()).unwrap_or("");
        if name == "else" {
          return self.eval_sequence(env, &pair.items[1..], tail);
        }
      }
      let cond = self.eval_expression(env.clone(), &pair.items[0])?;
      if cond.is_truthy() {
        if pair.items.len() == 1 {
          return Ok(cond);
        }
        return self.eval_sequence(env, &pair.items[1..], tail);
      }
    }
    Ok(Value::Nil)
  }

  fn special_and(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    // JS Lisp: returns `false` if any arg is falsy, else `true`. Does
    // NOT return the last value (unlike Common Lisp / Scheme).
    if args.is_empty() {
      return Ok(Value::Boolean(true));
    }
    for a in args {
      let v = self.eval_expression(env.clone(), a)?;
      if !v.is_truthy() {
        return Ok(Value::Boolean(false));
      }
    }
    Ok(Value::Boolean(true))
  }

  fn special_or(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    // JS Lisp: returns `true` if any arg is truthy, else `false`.
    if args.is_empty() {
      return Ok(Value::Boolean(false));
    }
    for a in args {
      let v = self.eval_expression(env.clone(), a)?;
      if v.is_truthy() {
        return Ok(Value::Boolean(true));
      }
    }
    Ok(Value::Boolean(false))
  }

  fn special_map(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "map takes 2 args (fn, list)".into(),
      });
    }
    let func = self.eval_expression(env.clone(), &args[0])?;
    let list = self.eval_expression(env.clone(), &args[1])?;
    let func: Function<S> = func.try_into()?;
    let items = match list {
      Value::List(l) => l.items,
      Value::Nil => return Ok(Value::List(crate::eval::List { items: vec![].into() })),
      // Map a function over a single non-list value — JS Lisp
      // treats it as a single-element list (matches
      // `optimizedMap` line 165).
      other => return self.eval_function(env, func, vec![other]),
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
      let v = self.eval_function(env.clone(), func.clone(), vec![item])?;
      out.push(v);
    }
    Ok(Value::List(crate::eval::List { items: out.into() }))
  }

  fn special_filter(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "filter takes 2 args (fn, list)".into(),
      });
    }
    let func = self.eval_expression(env.clone(), &args[0])?;
    let list = self.eval_expression(env.clone(), &args[1])?;
    let func: Function<S> = func.try_into()?;
    let items = match list {
      Value::List(l) => l.items,
      _ => {
        return Err(RuntimeError::TypeError {
          expected: "List".into(),
          got: "non-list".into(),
        });
      }
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
      let kept = self.eval_function(env.clone(), func.clone(), vec![item.clone()])?;
      if kept.is_truthy() {
        out.push(item);
      }
    }
    Ok(Value::List(crate::eval::List { items: out.into() }))
  }

  fn special_reduce(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 || args.len() > 3 {
      return Err(RuntimeError::ArityError {
        detail: "reduce/fold takes 2 or 3 args (fn, [init,] list)".into(),
      });
    }
    let func = self.eval_expression(env.clone(), &args[0])?;
    let func: Function<S> = func.try_into()?;
    let (mut acc, items) = if args.len() == 3 {
      let init = self.eval_expression(env.clone(), &args[1])?;
      let list = self.eval_expression(env.clone(), &args[2])?;
      let items = match list {
        Value::List(l) => l.items,
        _ => {
          return Err(RuntimeError::TypeError {
            expected: "List".into(),
            got: "non-list".into(),
          });
        }
      };
      (init, items)
    } else {
      let list = self.eval_expression(env.clone(), &args[1])?;
      let mut items = match list {
        Value::List(l) => l.items,
        _ => {
          return Err(RuntimeError::TypeError {
            expected: "List".into(),
            got: "non-list".into(),
          });
        }
      };
      if items.is_empty() {
        return Ok(Value::Nil);
      }
      let head = items.remove(0);
      (head, items)
    };
    for item in items {
      acc = self.eval_function(env.clone(), func.clone(), vec![acc, item])?;
    }
    Ok(acc)
  }

  /// `(group-by key-fn list)` → a list of `[key, [items…]]` pairs. `key-fn`
  /// is applied to each item; items with an equal key (by value) share a
  /// bucket. Buckets are returned in first-occurrence order of the key, so a
  /// pre-sorted input yields sorted buckets. Mirrors the JS `group-by`.
  fn special_group_by(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() != 2 {
      return Err(RuntimeError::ArityError {
        detail: "group-by takes 2 args (key-fn, list)".into(),
      });
    }
    let func = self.eval_expression(env.clone(), &args[0])?;
    let list = self.eval_expression(env.clone(), &args[1])?;
    let func: Function<S> = func.try_into()?;
    let items = match list {
      Value::List(l) => l.items,
      Value::Nil => return Ok(Value::List(crate::eval::List { items: vec![].into() })),
      _ => {
        return Err(RuntimeError::TypeError {
          expected: "List".into(),
          got: "non-list".into(),
        });
      }
    };
    // Insertion-ordered groups so a pre-sorted input gives sorted buckets.
    let mut groups: Vec<(Value<S>, Vec<Value<S>>)> = Vec::new();
    // Scene folders and host/project joins use string keys. Index just those
    // keys: strings only compare equal to strings, while numeric cross-type
    // equality and structural list/map equality retain the general path.
    // Keep output in `groups`, never in hash iteration order.
    let mut strings = HashMap::new();
    for item in items {
      let key = self.eval_function(env.clone(), func.clone(), vec![item.clone()])?;
      let existing = match &key {
        Value::String(text) => strings.get(text).copied(),
        _ => groups.iter().position(|(k, _)| crate::stdlib::cmp::values_equal(k, &key)),
      };
      match existing {
        Some(index) => groups[index].1.push(item),
        None => {
          if let Value::String(text) = &key {
            strings.insert(text.clone(), groups.len());
          }
          groups.push((key, vec![item]));
        }
      }
    }
    let out = groups
      .into_iter()
      .map(|(key, group_items)| {
        Value::List(crate::eval::List {
          items: vec![key, Value::List(crate::eval::List { items: group_items.into() })].into(),
        })
      })
      .collect();
    Ok(Value::List(crate::eval::List { items: out }))
  }

  /// `(match value (pat result...) ...)`
  ///
  /// - Pattern `_` (a symbol named "_") is a wildcard.
  /// - List pattern `(a b c)` is "any-of": the case fires if any
  ///   element evaluates equal to the target. Mirrors JS lisp.
  /// - Anything else is evaluated and compared via `=`.
  fn special_match(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.is_empty() {
      return Err(RuntimeError::ArityError {
        detail: "match needs a value + clauses".into(),
      });
    }
    let target = self.eval_expression(env.clone(), &args[0])?;
    for clause in &args[1..] {
      let pair = match clause {
        Value::List(l) => l,
        _ => return Err(Type::list_expected(clause)),
      };
      if pair.items.len() < 2 {
        continue;
      }
      let test = &pair.items[0];
      let body = &pair.items[1..];
      let matched = match test {
        // Wildcard
        Value::Symbol(s) if self.interner.resolve(s.as_symbol()).unwrap_or("") == "_" => true,
        // Any-of list
        Value::List(opts) => {
          let mut any = false;
          for o in &opts.items {
            let ev = self.eval_expression(env.clone(), o)?;
            if crate::stdlib::cmp::values_equal(&ev, &target) {
              any = true;
              break;
            }
          }
          any
        }
        // Single-value compare
        other => {
          let ev = self.eval_expression(env.clone(), other)?;
          crate::stdlib::cmp::values_equal(&ev, &target) || matches!(ev, Value::Boolean(true))
        }
      };
      if matched {
        let mut last = Value::Nil;
        for b in body {
          last = self.eval_expression(env.clone(), b)?;
        }
        return Ok(last);
      }
    }
    // No clause matched: a forgotten case, so say so loudly, as Rust rejects a
    // non-exhaustive match (decision 2b, 2026-10-04; it used to return `0`).
    // Typed code makes this a compile error once exhaustiveness checking lands.
    Err(RuntimeError::Other(format!(
      "match: no clause matched {}",
      self.format_value(&target)
    )))
  }

  /// `(json-from-list '(k1 v1 k2 v2 …))` — like `hash-map` but the
  /// args are pre-packed in a list. JS additionally re-evaluates
  /// any value that's a `(<fn-name> args…)` shape, so:
  ///
  /// `(json-from-list '(person (json :name "Eve")))` → `{"person": {"name": "Eve"}}`
  ///
  /// rather than `{"person": ["json", ":name", "Eve"]}`.
  fn special_json_from_list(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() != 1 {
      return Err(RuntimeError::ArityError {
        detail: "json-from-list takes 1 arg".into(),
      });
    }
    let list_val = self.eval_expression(env.clone(), &args[0])?;
    let items = match list_val {
      Value::List(l) => l.items,
      other => return Err(Type::list_expected(&other)),
    };
    if items.len() % 2 != 0 {
      return Err(RuntimeError::ArityError {
        detail: "json-from-list: odd number of elements".into(),
      });
    }
    let mut out: indexmap::IndexMap<String, Value<S>> = indexmap::IndexMap::new();
    let mut i = 0;
    while i < items.len() {
      let key = match &items[i] {
        Value::String(s) => s.strip_prefix(':').unwrap_or(s).to_string(),
        Value::Symbol(s) => {
          let n = self
            .interner
            .resolve(s.as_symbol())
            .unwrap_or("")
            .to_string();
          n.strip_prefix(':').unwrap_or(&n).to_string()
        }
        _ => format!("{:?}", &items[i]),
      };
      let raw_val = items[i + 1].clone();
      let value = match &raw_val {
        // Re-evaluate `(<fn> args…)` shaped values. Mirrors JS's
        // "if value is a list starting with a string, evaluate"
        // path in `stdlib.ts::json-from-list`. Quote produced the
        // head as a String — only re-symbol-ize if the name
        // resolves to a callable function. Otherwise keep the
        // list as-is (so `'(items ("red" "blue"))` doesn't try
        // to call `red`).
        Value::List(l) if !l.items.is_empty() && matches!(&l.items[0], Value::String(_)) => {
          let head_name = if let Value::String(s) = &l.items[0] {
            s.clone()
          } else {
            unreachable!()
          };
          // Look up the function — peek at env without committing.
          let sym = self.interner.get_or_intern(&head_name);
          let resolves_to_fn = matches!(env.borrow().get(sym), Some(Value::Function(_)));
          // Special-form names are recognized too.
          let is_special_form = matches!(
            head_name.as_str(),
            "json" | "hash-map" | "list" | "vector" | "quote" | "if" | "@import"
          );
          if resolves_to_fn || is_special_form {
            let mut new_items = Vec::with_capacity(l.items.len());
            new_items.push(Value::Symbol(crate::eval::Sym::from(&sym)));
            for tail in &l.items[1..] {
              new_items.push(tail.clone());
            }
            let call = Value::List(crate::eval::List { items: new_items.into() });
            self.eval_expression(env.clone(), &call)?
          } else {
            raw_val
          }
        }
        Value::List(l) if !l.items.is_empty() && matches!(&l.items[0], Value::Symbol(_)) => {
          self.eval_expression(env.clone(), &raw_val)?
        }
        _ => raw_val,
      };
      out.insert(key, value);
      i += 2;
    }
    Ok(Value::Map(out.into()))
  }

  fn special_apply(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if args.len() < 2 {
      return Err(RuntimeError::ArityError {
        detail: "apply takes fn + args list".into(),
      });
    }
    let func = self.eval_expression(env.clone(), &args[0])?;
    let func: Function<S> = func.try_into()?;
    // Build the final argument list from the remaining args, with the
    // last one expanded if it's a list (mirrors JS `apply` semantics).
    let mut final_args: Vec<Value<S>> = Vec::new();
    for (i, raw) in args[1..].iter().enumerate() {
      let v = self.eval_expression(env.clone(), raw)?;
      let is_last = i == args.len() - 2;
      if is_last {
        match v {
          Value::List(l) => final_args.extend(l.items),
          other => final_args.push(other),
        }
      } else {
        final_args.push(v);
      }
    }
    self.eval_function(env, func, final_args)
  }
}

impl crate::eval::Type {
  fn list_expected<S: Symbol>(v: &Value<S>) -> RuntimeError {
    crate::eval::Type::error(v.as_type(), crate::eval::Type::List)
  }
  fn sym_expected<S: Symbol>(v: &Value<S>) -> RuntimeError {
    crate::eval::Type::error(v.as_type(), crate::eval::Type::Symbol)
  }
}

/// Diagnostic text for a reified [`ErrorValue`] escalated by `unwrap`/`expect`:
/// the captured message, plus the failing form's origin when it was recorded.
fn reified_error_text(e: &ErrorValue) -> String {
  match &e.origin {
    Some(origin) => format!("{} (origin: {origin})", e.message),
    None => e.message.clone(),
  }
}

/// Convert a `serde_json::Value` into our `Value` tree. Used by the
/// `json` tagged-string, any other JSON-parsing builtins, and embedding
/// hosts returning structured JSON from natives (null → Nil, object → Map).
pub fn json_to_value<S: Symbol>(v: serde_json::Value) -> Value<S> {
  use serde_json::Value as J;
  match v {
    J::Null => Value::Nil,
    J::Bool(b) => Value::Boolean(b),
    J::Number(n) => {
      if let Some(i) = n.as_i64() {
        Value::Integer(i)
      } else {
        n.as_f64().map(Value::Float).unwrap_or(Value::Nil)
      }
    }
    J::String(s) => Value::String(s.into()),
    J::Array(a) => Value::List(crate::eval::List {
      items: a.into_iter().map(json_to_value).collect(),
    }),
    J::Object(o) => {
      let mut m = indexmap::IndexMap::with_capacity(o.len());
      for (k, v) in o {
        m.insert(k, json_to_value(v));
      }
      Value::Map(m.into())
    }
  }
}

#[cfg(test)]
mod call_head_tests {
  use super::*;
  use crate::Runtime;
  use string_interner::{backend::StringBackend, symbol::SymbolU32};

  type Calls = Rc<RefCell<Vec<(String, Vec<String>)>>>;

  #[test]
  fn selected_source_preserves_recursion_budget() {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = interp.default_env();
    interp.set_source_root(env.clone());
    interp.eval_selected_source("(+ 1 2)", None).unwrap();
    let forms = Runtime::<SymbolU32, StringBackend>::parse(
      None,
      "(define (boom) (boom))",
      &mut interp.interner,
    )
    .unwrap();
    for form in forms {
      interp
        .eval_expression(env.clone(), &Value::from_owned_sexpression(form).unwrap())
        .unwrap();
    }
    interp.replace_eval_budget(Some(crate::EvalBudget {
      max_steps: 50_000,
      deadline: None,
      max_depth: 200,
    }));
    let error = interp.eval_selected_source("(boom)", None).unwrap_err();
    assert!(error.is_hard());
    assert!(
      error.to_string().contains("recursion too deep")
        || error.to_string().contains("budget exceeded"),
      "{error}"
    );
  }


  /// An interpreter whose hook answers `prog`: records the call and returns
  /// its argument count; every other name is left undefined.
  fn hooked() -> (Interpreter<SymbolU32, StringBackend>, Rc<RefCell<Env<SymbolU32>>>, Calls) {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = interp.default_env();
    let calls: Calls = Rc::default();
    let seen = calls.clone();
    interp.set_call_head_hook(Rc::new(move |name: &str, args: &mut CallArgs<'_, SymbolU32>| {
      if name != "prog" {
        return None;
      }
      let args = match args() {
        Ok(args) => args,
        Err(error) => return Some(Err(error)),
      };
      let text = args.iter().map(|arg| format!("{arg:?}")).collect();
      seen.borrow_mut().push((name.to_string(), text));
      Some(Ok(Value::Integer(args.len() as i64)))
    }));
    (interp, env, calls)
  }

  fn eval(
    interp: &mut Interpreter<SymbolU32, StringBackend>,
    env: &Rc<RefCell<Env<SymbolU32>>>,
    src: &str,
  ) -> Result<Value<SymbolU32>, RuntimeError> {
    let asts = Runtime::parse(None, src, interp.string_interner()).expect("parse");
    let mut last = Value::Nil;
    for ast in &asts {
      last = interp.eval_expression(env.clone(), &Value::from_sexpression(ast).expect("value"))?;
    }
    Ok(last)
  }

  /// argv.md I13: a nested call to an unbound name reaches the host, in an
  /// `if` branch, a `let` body and a lambda body alike.
  #[test]
  fn a_nested_unbound_call_reaches_the_host() {
    let (mut interp, env, calls) = hooked();
    for src in [
      r#"(if true (prog "a" :l))"#,
      r#"(let ((x "b")) (prog x))"#,
      r#"((lambda () (prog)))"#,
      r#"(defun f (y) (prog y "z")) (f "c")"#,
    ] {
      eval(&mut interp, &env, src).unwrap_or_else(|error| panic!("{src}: {error:?}"));
    }
    {
      let calls = calls.borrow();
      assert_eq!(calls.len(), 4, "{calls:?}");
      assert!(calls[0].1[1].starts_with("Keyword(\"l\")"), "a literal keyword stays a flag: {:?}", calls[0].1);
    }
    assert!(matches!(eval(&mut interp, &env, r#"(if true (prog "a" "b"))"#), Ok(Value::Integer(2))));
  }

  /// The outermost form a door evaluates keeps its own fallback, and a name the
  /// host does not answer stays undefined with its arguments never evaluated.
  #[test]
  fn the_outermost_call_and_unanswered_names_stay_undefined() {
    let (mut interp, env, calls) = hooked();
    let err = eval(&mut interp, &env, r#"(prog "a")"#).unwrap_err();
    assert!(matches!(err, RuntimeError::UndefinedSymbol { ref detail } if detail == "prog"), "{err:?}");
    let err = eval(&mut interp, &env, r#"(if true (other (prog "x")))"#).unwrap_err();
    assert!(matches!(err, RuntimeError::UndefinedSymbol { ref detail } if detail == "other"), "{err:?}");
    assert!(calls.borrow().is_empty(), "unanswered: arguments are not evaluated");
    let err = eval(&mut interp, &env, r#"(if true missing)"#).unwrap_err();
    assert!(matches!(err, RuntimeError::UndefinedSymbol { .. }), "a reference is not a call: {err:?}");
  }
}

#[cfg(test)]
mod branch_value_tests {
  use super::*;
  use crate::Runtime;
  use string_interner::{backend::StringBackend, symbol::SymbolU32};

  fn eval(src: &str) -> Result<Value<SymbolU32>, RuntimeError> {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = interp.default_env();
    let asts = Runtime::parse(None, src, interp.string_interner()).expect("parse");
    let mut last = Value::Nil;
    for ast in &asts {
      last = interp.eval_expression(env.clone(), &Value::from_sexpression(ast).expect("value"))?;
    }
    Ok(last)
  }

  /// Decision 2a: an `if` without `else` whose condition is false is the unit
  /// value, as in Rust, never JS Lisp's `0`.
  #[test]
  fn an_if_without_else_is_nil_when_false() {
    assert!(matches!(eval(r#"(if false "never")"#), Ok(Value::Nil)));
    assert!(matches!(eval(r#"(if true 7)"#), Ok(Value::Integer(7))));
    assert!(matches!(eval(r#"(cond (false 1))"#), Ok(Value::Nil)), "cond without a match stays nil");
  }

  /// Decision 2b: a `match` that no clause answers is a forgotten case, so it
  /// fails loudly and names the value, as Rust rejects a non-exhaustive match.
  #[test]
  fn a_match_without_a_matching_clause_fails_loudly() {
    let err = eval(r#"(match 3 (1 "one") (2 "two"))"#).unwrap_err();
    assert!(matches!(&err, RuntimeError::Other(text) if text == "match: no clause matched 3"), "{err:?}");
    assert!(matches!(eval(r#"(match 2 (1 "one") (2 "two"))"#), Ok(Value::String(ref s)) if s.as_str() == "two"));
    assert!(matches!(eval(r#"(match 9 (1 "one") (_ "other"))"#), Ok(Value::String(ref s)) if s.as_str() == "other"));
  }
}

/// R7's `use`, scoped to phase 1: `(use P as: W)` binds W and tells the host
/// `as:` named it; `(use std.fs)` names a module by its last segment;
/// `(use std.fs.(a b))` binds items as Lisp names.
#[cfg(test)]
mod use_form_tests {
  use super::*;
  use crate::Runtime;
  use string_interner::{backend::StringBackend, symbol::SymbolU32};

  type Interp = Interpreter<SymbolU32, StringBackend>;
  type Told = Rc<RefCell<Vec<(String, String, bool)>>>;

  /// An interpreter with `std.fs.read_dir`, `std.fs.write` and
  /// `tsh.toolchain` bound, and a use hook that records what it is told
  /// and refuses the word `taken`.
  fn interp() -> (Interp, Rc<RefCell<Env<SymbolU32>>>, Told) {
    let mut interp = Interp::new();
    let env = interp.default_env();
    for (name, value) in [("std.fs.read_dir", 1), ("std.fs.write", 2), ("tsh.toolchain", 3)] {
      let sym = interp.string_interner().get_or_intern(name);
      env.borrow_mut().define(sym, Value::Integer(value));
    }
    let told: Told = Rc::default();
    let record = told.clone();
    interp.set_use_hook(Rc::new(move |name: &str, path: &str, _value: &Value<SymbolU32>, command: bool| {
      if name == "taken" {
        return Err(RuntimeError::Other("`taken` is already a prelude command".into()));
      }
      record.borrow_mut().push((name.into(), path.into(), command));
      Ok(())
    }));
    (interp, env, told)
  }

  fn eval(interp: &mut Interp, env: &Rc<RefCell<Env<SymbolU32>>>, src: &str) -> Result<Value<SymbolU32>, RuntimeError> {
    let asts = Runtime::parse(None, src, interp.string_interner()).expect("parse");
    let mut last = Value::Nil;
    for ast in &asts {
      last = interp.eval_expression(env.clone(), &Value::from_sexpression(ast).expect("value"))?;
    }
    Ok(last)
  }

  fn message(error: RuntimeError) -> String {
    error.to_string()
  }

  /// `as:` binds the word to the path's value and tells the host so.
  #[test]
  fn use_as_binds_the_word_and_tells_the_host() {
    let (mut interp, env, told) = interp();
    assert!(matches!(eval(&mut interp, &env, "(use tsh.toolchain as: toolchain)"), Ok(Value::Nil)));
    assert!(matches!(eval(&mut interp, &env, "toolchain"), Ok(Value::Integer(3))));
    assert_eq!(*told.borrow(), vec![("toolchain".into(), "tsh.toolchain".into(), true)]);
    // B5b: the value may follow the key without a space.
    eval(&mut interp, &env, "(use std.fs.write as:put)").unwrap();
    assert!(matches!(eval(&mut interp, &env, "put"), Ok(Value::Integer(2))));
  }

  /// Without `as:`, the last segment names the module: `fs.read_dir`
  /// resolves through it, and the host is told nothing.
  #[test]
  fn use_binds_the_last_segment_as_a_module() {
    let (mut interp, env, told) = interp();
    eval(&mut interp, &env, "(use std.fs)").unwrap();
    assert!(matches!(eval(&mut interp, &env, "fs.read_dir"), Ok(Value::Integer(1))));
    assert!(matches!(eval(&mut interp, &env, "fs.write"), Ok(Value::Integer(2))));
    assert_eq!(interp.module_target("fs.read_dir").as_deref(), Some("std.fs.read_dir"));
    assert_eq!(interp.module_target("read_dir"), None);
    assert!(told.borrow().is_empty(), "a module binds no value");
    // A path that is itself a value binds its last segment as a Lisp name.
    eval(&mut interp, &env, "(use tsh.toolchain)").unwrap();
    assert!(matches!(eval(&mut interp, &env, "toolchain"), Ok(Value::Integer(3))));
    assert_eq!(*told.borrow(), vec![("toolchain".into(), "tsh.toolchain".into(), false)]);
  }

  /// `(use std.fs.(read_dir write))` binds each item as a Lisp name.
  #[test]
  fn use_binds_listed_items_as_lisp_names() {
    let (mut interp, env, told) = interp();
    eval(&mut interp, &env, "(use std.fs.(read_dir write))").unwrap();
    assert!(matches!(eval(&mut interp, &env, "read_dir"), Ok(Value::Integer(1))));
    assert!(matches!(eval(&mut interp, &env, "write"), Ok(Value::Integer(2))));
    assert_eq!(
      *told.borrow(),
      vec![("read_dir".into(), "std.fs.read_dir".into(), false), ("write".into(), "std.fs.write".into(), false)]
    );
    let err = message(eval(&mut interp, &env, "(use std.fs.(read_dir nope))").unwrap_err());
    assert_eq!(err, "use: nothing is named `std.fs.nope`");
  }

  /// B5's `as:` is the only spelling; the others are loud and name it.
  #[test]
  fn use_refuses_other_spellings_of_as() {
    let (mut interp, env, _) = interp();
    for src in ["(use tsh.toolchain :as toolchain)", "(use tsh.toolchain as toolchain)"] {
      let err = message(eval(&mut interp, &env, src).unwrap_err());
      assert!(err.contains("write `as: NAME`"), "{src}: {err}");
    }
    let err = message(eval(&mut interp, &env, "(use tsh.toolchain as:)").unwrap_err());
    assert!(err.contains("`as:` needs a name"), "{err}");
    let err = message(eval(&mut interp, &env, r#"(use "tsh-tmux" as: mux)"#).unwrap_err());
    assert!(err.contains("plugin packages still use @import"), "{err}");
    assert!(matches!(eval(&mut interp, &env, "toolchain"), Err(RuntimeError::UndefinedSymbol { .. })));
  }

  /// A path that names nothing is a loud error naming the path.
  #[test]
  fn use_of_a_missing_path_names_it() {
    let (mut interp, env, _) = interp();
    for (src, path) in [("(use std.nope)", "std.nope"), ("(use std.nope as: nope)", "std.nope")] {
      let err = message(eval(&mut interp, &env, src).unwrap_err());
      assert_eq!(err, format!("use: nothing is named `{path}`"), "{src}");
    }
  }

  /// The bound name follows the read-only rules: nothing under `std` or
  /// `tsh.plugins`.
  #[test]
  fn use_may_not_bind_a_read_only_name() {
    let (mut interp, env, _) = interp();
    for src in ["(use std.fs.write as: std.write)", "(use std.fs.write as: tsh.plugins.write)"] {
      let err = message(eval(&mut interp, &env, src).unwrap_err());
      assert!(err.contains("is read-only"), "{src}: {err}");
    }
  }

  /// The host's refusal refuses the whole form: nothing is bound.
  #[test]
  fn a_refused_use_binds_nothing() {
    let (mut interp, env, _) = interp();
    let err = message(eval(&mut interp, &env, "(use std.fs.write as: taken)").unwrap_err());
    assert_eq!(err, "`taken` is already a prelude command");
    assert!(matches!(eval(&mut interp, &env, "taken"), Err(RuntimeError::UndefinedSymbol { .. })));
  }
}

/// A builtin that only reads its first argument: `get`, `nth`, `first`,
/// `length`/`count` and `empty?`. Called on a bound name, or on a `get`,
/// `nth` or `first` of one, it reads the value where it is bound
/// ([`Interpreter::read_in_place`]). A lookup copies the value it finds, so
/// `(get thread "title")` used to copy the whole record to answer one field.
#[derive(Clone, Copy, PartialEq)]
enum Read {
  Get,
  Nth,
  First,
  Length,
  Empty,
}

impl Read {
  fn of_function<S: Symbol>(func: &Function<S>) -> Option<Read> {
    match func {
      Function::NativeFn(native) => Read::of(*native),
      _ => None,
    }
  }

  fn of<S: Symbol>(native: crate::eval::NativeFn<S>) -> Option<Read> {
    use crate::stdlib::{lists, maps};
    let is = |other: crate::eval::NativeFn<S>| std::ptr::fn_addr_eq(native, other);
    if is(maps::get::<S>) {
      Some(Read::Get)
    } else if is(lists::nth::<S>) {
      Some(Read::Nth)
    } else if is(lists::first::<S>) {
      Some(Read::First)
    } else if is(lists::length::<S>) {
      Some(Read::Length)
    } else if is(lists::is_empty::<S>) {
      Some(Read::Empty)
    } else {
      None
    }
  }

  /// Whether it takes `rest` arguments after the collection.
  fn takes(self, rest: usize) -> bool {
    match self {
      Read::Get => rest == 1 || rest == 2,
      Read::Nth => rest == 1,
      Read::First | Read::Length | Read::Empty => rest == 0,
    }
  }

  /// What the builtin answers for `coll`, or `None` where it would answer
  /// otherwise than plainly (an error, a key of another type): the call is
  /// then evaluated as it always was, and answers the same.
  fn answer<S: Symbol>(self, coll: &Value<S>, key: Option<&Value<S>>, default: &Value<S>) -> Option<Value<S>> {
    match self {
      Read::Length => Some(Value::Integer(match coll {
        Value::List(l) => l.items.len() as i64,
        Value::String(s) => s.chars().count() as i64,
        Value::Map(m) => m.len() as i64,
        Value::Nil => 0,
        _ => return None,
      })),
      Read::Empty => Some(Value::Boolean(match coll {
        Value::List(l) => l.items.is_empty(),
        Value::String(s) => s.is_empty(),
        Value::Map(m) => m.is_empty(),
        Value::Nil => true,
        _ => false,
      })),
      _ => self.select(coll, key, default).cloned(),
    }
  }

  /// The part of `coll` a `get`, `nth` or `first` selects, as [`Read::answer`].
  fn select<'a, S: Symbol>(self, coll: &'a Value<S>, key: Option<&Value<S>>, default: &'a Value<S>) -> Option<&'a Value<S>> {
    match (self, coll, key) {
      // `:x` keyword keys are stored without the colon, as `get` reads them.
      (Read::Get, Value::Map(m), Some(Value::String(k))) => Some(m.get(k.strip_prefix(':').unwrap_or(k)).unwrap_or(default)),
      (Read::Get, Value::List(l), Some(&Value::Integer(i))) => {
        Some(usize::try_from(i).ok().and_then(|i| l.items.get(i)).unwrap_or(default))
      }
      // A list read with a key of another kind is left to the builtin: an
      // older `get` refuses it, a newer one answers the default.
      (Read::Get, Value::Nil, Some(_)) => Some(default),
      (Read::Nth, Value::List(l), Some(&Value::Integer(n))) => Some(l.items.get(n as usize).unwrap_or(default)),
      (Read::First, Value::List(l), None) => Some(l.items.first().unwrap_or(default)),
      _ => None,
    }
  }
}

/// The builtins a nested place may read through, by the name its head is
/// spelled with: no special form has one of these names, so a head spelled
/// so is a call, as ordinary evaluation would find it.
const PLACE_HEADS: [&str; 4] = ["get", "nth", "first", "car"];

/// How deep a place may nest (`(get (get (get row …) …) …)` is three):
/// deeper ones are evaluated the ordinary way, so walking a place never
/// needs more native stack than a handful of frames.
const MAX_PLACE_NESTING: u32 = 8;

/// What evaluating `place` as an argument costs the ordinary path: how many
/// evaluations it enters (each one a budget step) and how deep they nest.
/// `None` for what is not a place or nests deeper than `room` (at most
/// [`MAX_PLACE_NESTING`]): the walk stops there rather than descend a nest
/// of any depth.
fn place_cost<S: Symbol>(place: &Value<S>, room: u32) -> Option<(u64, u32)> {
  if room == 0 {
    return None;
  }
  match place {
    Value::Symbol(_) => Some((1, 1)),
    Value::List(list) => {
      let [Value::Symbol(_), inner, rest @ ..] = list.items.as_slice() else { return None };
      let (steps, depth) = place_cost(inner, room - 1)?;
      // The call, its head, the inner place, then each plain argument.
      Some((2 + steps + rest.len() as u64, 1 + depth.max(1)))
    }
    _ => None,
  }
}

impl<S: Symbol, B: Backend<S>> Interpreter<S, B>
where
  S: Debug + 'static,
{
  /// `(read coll …)` without copying `coll`, when `coll` is a bound name or a
  /// `get`, `nth` or `first` of one and the other arguments are [`plain`].
  /// `None`: evaluate the call the ordinary way, which answers whatever this
  /// does not (an unbound name, a hook, an error) exactly as before.
  ///
  /// It costs what the ordinary call would: the evaluations it skips are
  /// charged to the budget as steps, and where the ordinary call would stop
  /// (the step budget, a deadline check, the depth limits) this answers
  /// `None`, so the ordinary call stops there itself. Kept out of line: its
  /// locals would otherwise widen every evaluation's stack frame.
  #[inline(never)]
  fn read_in_place(
    &mut self,
    env: &Rc<RefCell<Env<S>>>,
    read: Read,
    args: &[Value<S>],
  ) -> Option<Result<Value<S>, RuntimeError>> {
    let (coll, rest) = args.split_first()?;
    let (place_steps, place_depth) = place_cost(coll, MAX_PLACE_NESTING)?;
    let steps = place_steps + rest.len() as u64;
    let depth = place_depth.max(u32::from(!rest.is_empty()));
    if self.eval_depth.saturating_add(depth) > self.max_eval_depth {
      return None;
    }
    if let Some(t) = &self.budget {
      let crosses_check = (t.steps + 1..=t.steps + steps).any(|n| n & 1023 == 0);
      if t.steps + steps > t.budget.max_steps
        || t.depth + depth > t.budget.max_depth
        || (crosses_check && t.budget.deadline.is_some_and(|d| std::time::Instant::now() > d))
      {
        return None;
      }
    }
    let values = self.plain_args(env, read, rest)?;
    let nil = Value::Nil;
    let default = if read == Read::Get { values.get(1).unwrap_or(&nil) } else { &nil };
    let key = values.first();
    let value = self.with_place(env, coll, &mut |value| read.answer(value, key, default))?;
    if let Some(t) = &mut self.budget {
      t.steps += steps;
    }
    Some(Ok(value))
  }

  /// A call to one of the [`Read`] builtins: read in place where it can,
  /// else evaluate the arguments and call it, as every other call is.
  #[inline(never)]
  fn read_or_call(
    &mut self,
    env: Rc<RefCell<Env<S>>>,
    read: Read,
    func: Function<S>,
    args: &[Value<S>],
  ) -> Result<Value<S>, RuntimeError> {
    if let Some(result) = self.read_in_place(&env, read, args) {
      return result;
    }
    let mut eval_args = Vec::with_capacity(args.len());
    for arg in args {
      eval_args.push(self.eval_expression(env.clone(), arg)?);
    }
    self.eval_function(env, func, eval_args)
  }

  /// The values of `rest`, when `read` takes them and each is a literal or a
  /// bound name. Found without evaluating anything: a name that is not
  /// bound would run the missing-symbol hook, which may change bindings, so
  /// it falls back to the ordinary call, where hooks run in their order.
  #[inline(never)]
  fn plain_args(&self, env: &Rc<RefCell<Env<S>>>, read: Read, rest: &[Value<S>]) -> Option<Vec<Value<S>>> {
    if !read.takes(rest.len()) {
      return None;
    }
    rest.iter().map(|arg| self.plain_value(env, arg)).collect()
  }

  /// What a literal or a bound name evaluates to, or `None` for anything
  /// whose evaluation could run code.
  fn plain_value(&self, env: &Rc<RefCell<Env<S>>>, arg: &Value<S>) -> Option<Value<S>> {
    match arg {
      Value::Nil | Value::Boolean(_) | Value::Integer(_) | Value::Float(_) | Value::String(_) => Some(arg.clone()),
      Value::Symbol(sym) => {
        let sym = sym.as_symbol();
        let name = self.interner.resolve(sym)?;
        if name.starts_with(':') || name.starts_with('#') {
          return Some(Value::String(name.into()));
        }
        if name == "null" || name == "nil" {
          return Some(Value::Nil);
        }
        env.borrow().with_value(sym, Value::clone)
      }
      _ => None,
    }
  }

  /// Hand `use_it` the value `place` evaluates to, where it is bound: a name,
  /// or a `get`, `nth` or `first` of a place.
  #[inline(never)]
  fn with_place<R>(
    &mut self,
    env: &Rc<RefCell<Env<S>>>,
    place: &Value<S>,
    use_it: &mut dyn FnMut(&Value<S>) -> Option<R>,
  ) -> Option<R> {
    match place {
      Value::Symbol(sym) => {
        let sym = sym.as_symbol();
        let name = self.interner.resolve(sym)?;
        // Self-evaluating spellings are not bindings.
        if name.starts_with(':') || name.starts_with('#') || name == "null" || name == "nil" {
          return None;
        }
        env.borrow().with_value(sym, |value| use_it(value)).flatten()
      }
      Value::List(list) => {
        let (Value::Symbol(head), [inner, rest @ ..]) = (list.items.first()?, &list.items[1..]) else {
          return None;
        };
        if !PLACE_HEADS.contains(&self.interner.resolve(head.as_symbol())?) {
          return None;
        }
        let read = env
          .borrow()
          .with_value(head.as_symbol(), |value| match value {
            Value::Function(Function::NativeFn(native)) => Read::of(*native),
            _ => None,
          })
          .flatten()
          .filter(|read| matches!(read, Read::Get | Read::Nth | Read::First))?;
        let values = self.plain_args(env, read, rest)?;
        let nil = Value::Nil;
        let default = if read == Read::Get { values.get(1).unwrap_or(&nil) } else { &nil };
        let key = values.first();
        self.with_place(env, inner, &mut |coll| read.select(coll, key, default).and_then(&mut *use_it))
      }
      _ => None,
    }
  }
}


/// The `error/v1` value a soft failure becomes under `(try …)`. A failure the
/// command reported as data keeps its fields: the value's `message` is its
/// sentence, without the field lines the error's text adds. Out of line
/// ([`Interpreter::special_try`] recurses), so its locals stay off that frame.
#[inline(never)]
fn error_value(e: RuntimeError, origin: Option<String>) -> Box<ErrorValue> {
  let kind = match &e {
    RuntimeError::UndefinedSymbol { .. } => "unbound",
    RuntimeError::TypeError { .. } => "type",
    _ => "error",
  };
  let (kind, failure) = match e {
    RuntimeError::Reported(failure) => {
      let kind = failure.kind.clone().unwrap_or_else(|| kind.to_string());
      (kind, *failure)
    }
    e => (kind.to_string(), ReportedFailure { message: e.to_string(), ..ReportedFailure::default() }),
  };
  let ReportedFailure { message, kind: _, host, hint, next, output, display } = failure;
  Box::new(ErrorValue {
    kind,
    message,
    origin,
    chain: vec![],
    host,
    hint,
    next,
    output,
    display,
  })
}

#[cfg(test)]
mod place_cost_tests {
  use string_interner::symbol::SymbolU32;

  use super::*;

  fn sym() -> Value<SymbolU32> {
    let mut interner = StringInterner::<string_interner::backend::StringBackend>::new();
    Value::Symbol(crate::eval::Sym::from(&interner.get_or_intern("rows")))
  }

  /// However deep a nest of reads, sizing it up stops at the nesting a read
  /// in place allows: it never needs more native stack than that.
  #[test]
  fn a_nest_of_any_depth_is_sized_within_its_room() {
    let worker = std::thread::Builder::new().stack_size(256 * 1024).spawn(|| {
      let symbol = sym();
      let mut place = symbol.clone();
      for _ in 0..100_000 {
        place = Value::List(crate::eval::List { items: vec![symbol.clone(), place].into() });
      }
      let cost = place_cost(&place, MAX_PLACE_NESTING);
      // Dropping a nest this deep recurses; the test is about sizing it.
      std::mem::forget(place);
      cost
    });
    assert_eq!(worker.unwrap().join().unwrap(), None);
    let symbol = sym();
    let two = Value::List(crate::eval::List { items: vec![symbol.clone(), Value::List(crate::eval::List { items: vec![symbol.clone(), symbol.clone()].into() })].into() });
    // `(f (f x))`: three entries for the outer call (call, head, place) and
    // three for the inner, three frames deep.
    assert_eq!(place_cost(&two, MAX_PLACE_NESTING), Some((5, 3)));
  }
}
