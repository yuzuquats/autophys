pub mod resource;
pub mod call;
pub mod cfg;
pub mod owned_io_gate;
pub mod source;
pub mod types;
mod structural;
mod struct_impl;
pub use struct_impl::DeclarationCheckpoint;
#[cfg(test)]
mod struct_impl_tests;
#[cfg(test)]
mod typed_function_tests;
pub use structural::ModuleDiscovery;
mod eval;
mod grammar;
mod interpreter;
mod lexer;
mod posix_reader;
mod render;
mod result;
mod stdlib;
pub use stdlib::strings::concat_values;
mod symbol;
mod tail;
mod value;
mod value_format;

use std::fmt::Debug;

pub use crate::eval::{
  Env, Function, Lambda, List, Member, NativeClosure, NativeFn, ReceiverState, ReportedFailure,
  RuntimeError, Sym,
  Type,
};
pub use crate::grammar::{Literal, SExpression};
pub use crate::interpreter::{
  BindingGuard, CallArg, CallArgs, CallHeadHook, DeprecatedTarget, Deprecation, EvalBudget, ImportHandler, Interpreter, SourceHeads, StackGrower,
  install_stack_grower, json_to_value,
};
/// WAT comment rules shared by the lisp reader and the line classifier.
pub use crate::lexer::{
  comment_only as lisp_comment_only, deprecated_line_comment as lisp_deprecated_line_comment,
  single_semicolon as lisp_single_semicolon,
};
pub use crate::posix_reader::{
  bash_heredoc_pending,
  arith as bash_arith, bash_paren_statement,
  PosixReadError, ShellExpression, ShellOperator, bash_line_continues, lower_shell_expression, read_posix,
  read_posix_argv, read_posix_with_home, read_shell_expression, read_shell_expression_with_home,
  read_shell_plan, read_shell_plan_with_home, read_shell_plan_with_functions, read_statement, read_statement_with_home,
  mark_displayed_command, read_prompt_plan_with_functions, sexpr_to_json, SH_FLOW_FORMS, SPAWN_FORM, LAST_JOB_FORM,
};
pub use crate::posix_reader::{FunctionStyle as ShellFunctionStyle, format_shell_function};
/// Raw-tokenizing macros (`(sh! …)`): the reader hands their text to the macro.
pub use crate::posix_reader::{
  RAW_MACROS, mask_raw_macros, raw_macro_close, raw_macro_head,
};
/// The strict-lisp line test: a top-level line that is lisp without a `(`.
pub use crate::lexer::datum_line as lisp_datum_line;
pub use crate::render::{render_lisp, render_posix};
pub use crate::result::{EvalError, EvalResult, SyntaxError, SyntaxResult};
/// The same numeric contract is used by standalone Lisp and embedded hosts.
pub use crate::stdlib::{arith, cmp};
pub use crate::symbol::{Backend, Symbol};
pub use crate::value::{DEBUG_DEPTH_LIMIT, ErrorValue, Shared, Teardown, Text, Value};
pub use crate::value_format::format_value;
pub use crate::grammar::MAX_NESTING_DEPTH;

use grammar::TokenStream;
use string_interner::{StringInterner, backend::StringBackend, symbol::SymbolU32};

pub struct Runtime<S = SymbolU32, B = StringBackend>
where
  S: Symbol,
  B: Backend<S>,
{
  s: std::marker::PhantomData<S>,
  b: std::marker::PhantomData<B>,
}

impl<S, B> Runtime<S, B>
where
  // `'static` propagates from the interpreter's receiver machinery (a receiver
  // is an `Rc<dyn Fn>` capturing `Value<S>`). Concrete backends are owned
  // interned symbols, so nothing real is excluded.
  S: Symbol + Debug + 'static,
  B: Backend<S>,
{
  pub fn parse(
    filename: Option<std::path::PathBuf>,
    input: &str,
    interner: &mut StringInterner<B>,
  ) -> crate::result::SyntaxResult<Vec<SExpression<S>>> {
    let stream = TokenStream::new(filename, input)?;
    let ast = grammar::module_parser::module(&stream, interner)?;
    Ok(ast)
  }

  pub fn eval(filename: Option<std::path::PathBuf>, input: &str) -> EvalResult<Vec<Value<S>>> {
    let mut int = Interpreter::<S, B>::new();
    let stream = TokenStream::new(filename, input).map_err(EvalError::SyntaxError)?;
    let asts = grammar::module_parser::module(&stream, int.string_interner())
      .map_err(|e| EvalError::SyntaxError(SyntaxError::from(e)))?;

    let env = Interpreter::default_env(&mut int);

    let mut result = vec![];
    for ast in asts {
      let r = int
        .eval_expression(
          env.clone(),
          &Value::from_owned_sexpression(ast).map_err(EvalError::SyntaxError)?,
        )
        .map_err(EvalError::RuntimeError)?;
      result.push(r);
    }

    Ok(result)
  }
}

impl Runtime<SymbolU32, StringBackend> {}

#[cfg(test)]
mod test {
  use string_interner::backend::StringBackend;

  use super::*;

  #[test]
  pub fn test_basic() {
    let mut interner: StringInterner<_> = StringInterner::<StringBackend>::new();
    let ast = Runtime::parse(None, "(+ 1 3)", &mut interner);

    println!("{:#?}", ast);
  }

  #[test]
  pub fn test_eval() {
    let r = Runtime::<SymbolU32>::eval(
      None,
      r#"
      ( + 1 3 )
      (+ 2 8)
    "#,
    )
    .expect("couldn't eval");

    println!("{:#?}", r);
  }

  /// A `let` whose helper lambda captures the scope that binds it is an `Rc`
  /// cycle. The interpreter releases such a scope when the form exits, so the
  /// frame — and whatever data sits beside the helper — does not outlive it.
  /// Counted, not weighed: other tests run alongside and open scopes of their
  /// own, so the bound is loose but far below one leaked scope per form.
  #[test]
  fn a_scope_only_its_own_lambdas_hold_is_released_on_exit() {
    use std::sync::atomic::Ordering;
    let before = crate::eval::LIVE_SCOPES.load(Ordering::Relaxed);
    let form = "(let ((rows (list 1 2 3))
                      (twice (lambda (x) (* 2 x)))
                      (walk (lambda (i) (if (> i 0) (walk (- i 1)) i)))
                      (total (lambda (xs) (reduce (lambda (a b) (+ a (twice b))) (walk 3) xs))))
                  (total rows))\n";
    let results = Runtime::<SymbolU32>::eval(None, &form.repeat(500)).expect("evaluates");
    assert!(
      matches!(results.last(), Some(Value::Integer(12))),
      "{:?}",
      results.last()
    );
    let after = crate::eval::LIVE_SCOPES.load(Ordering::Relaxed);
    assert!(
      after.saturating_sub(before) < 250,
      "{} scopes still alive after 500 helper-bearing lets",
      after.saturating_sub(before)
    );
  }

  /// The release is for scopes nothing outside can reach. A closure that
  /// escapes its `let` keeps the scope, and the value it closed over.
  #[test]
  fn a_scope_a_closure_escaped_from_is_kept() {
    let results = Runtime::<SymbolU32>::eval(
      None,
      r#"
        (let make (lambda (k) (let ((seen (list k))) (lambda () (first seen)))))
        (let f (make 7))
        (f)
      "#,
    )
    .expect("evaluates");
    assert!(
      matches!(results.last(), Some(Value::Integer(7))),
      "{:?}",
      results.last()
    );
  }

  /// The escaping closure is usually not anonymous. A `let` that BINDS its
  /// lambda and then hands it out — returned by name, inside a returned list
  /// or map — looks to the scope exactly like a helper that dies with the
  /// frame: one binding, one capture. Counting bindings alone cleared these
  /// scopes and the closure came back with its captures gone, reporting
  /// `undefined symbol`; the escape shows up as the lambda being held by
  /// more than its own binding.
  #[test]
  pub fn a_named_closure_that_escapes_keeps_what_it_captured() {
    for (shape, source) in [
      (
        "returned by name",
        r#"(let f (let ((secret 42) (peek (lambda () secret))) peek))
           (f)"#,
      ),
      (
        "inside a returned list",
        r#"(let h (first (let ((secret 42) (peek (lambda () secret))) (list peek))))
           (h)"#,
      ),
      (
        "inside a returned map",
        r#"(let m (let ((secret 42) (peek (lambda () secret))) (hash-map "f" peek)))
           ((get m "f"))"#,
      ),
      (
        "aliased binding, then returned",
        r#"(let a (let ((secret 42) (peek (lambda () secret)) (alias peek)) alias))
           (a)"#,
      ),
    ] {
      let results = Runtime::<SymbolU32>::eval(None, source)
        .unwrap_or_else(|e| panic!("{shape}: evaluates: {e:?}"));
      assert!(
        matches!(results.last(), Some(Value::Integer(42))),
        "{shape}: {:?}",
        results.last()
      );
    }
  }

  #[test]
  pub fn keyword_with_slash_lexes_as_single_symbol() {
    // The lexer accepts `/` as a symbol cont-char so paths like
    // `:host-a/host-health` parse as one keyword (auto-evaluates to a
    // String). Standalone `/` still lexes as the division operator.
    let results = Runtime::<SymbolU32>::eval(
      None,
      r#"
        :host-a/host-health
        (/ 10 2)
      "#,
    )
    .expect("couldn't eval");
    assert_eq!(results.len(), 2);
    match &results[0] {
      Value::String(s) => assert_eq!(s, ":host-a/host-health"),
      other => panic!("expected keyword-as-string, got {:?}", other),
    }
    match &results[1] {
      Value::Integer(n) => assert_eq!(*n, 5),
      Value::Float(f) => assert_eq!(*f, 5.0),
      other => panic!("expected 5 from (/ 10 2), got {:?}", other),
    }
  }

  /// A receiver + one selector, for the dot-sugar tests below.
  fn receiver_fixture(
    interp: &mut Interpreter<SymbolU32, StringBackend>,
    env: &std::rc::Rc<std::cell::RefCell<crate::eval::Env<SymbolU32>>>,
    bind_as: &str,
  ) {
    use crate::eval::ReceiverState;
    use indexmap::IndexMap;
    use std::cell::RefCell;
    use std::rc::Rc;

    let mut selectors: IndexMap<String, NativeClosure<SymbolU32>> = IndexMap::new();
    selectors.insert(
      ":lane.declare".to_string(),
      Rc::new(|_env, args| {
        // Echo the first argument so a test can prove the ARGS arrive after
        // the selector was stripped.
        Ok(args.into_iter().next().unwrap_or(Value::Nil))
      }),
    );
    let state = Rc::new(ReceiverState {
      name: bind_as.to_string(),
      selectors,
      members: RefCell::new(Vec::new()),
    });
    let recv = interp.make_receiver(state);
    let sym = interp.string_interner().get_or_intern(bind_as);
    env.borrow_mut().define(sym, recv);
  }

  fn eval_one(
    interp: &mut Interpreter<SymbolU32, StringBackend>,
    env: &std::rc::Rc<std::cell::RefCell<crate::eval::Env<SymbolU32>>>,
    src: &str,
  ) -> Result<Value<SymbolU32>, crate::eval::RuntimeError> {
    let asts = Runtime::parse(None, src, interp.string_interner()).expect("parse");
    let ast = asts.first().expect("one form");
    let v = Value::from_sexpression(ast).expect("from_sexpression");
    interp.eval_expression(env.clone(), &v)
  }

  /// A retired command (`add_deprecated_call`) runs its replacement with the
  /// leading arguments first: called, as a bare value, and respelled before a
  /// door dispatches it. Each records one deprecation naming the whole
  /// replacement, and only the exact old name matches.
  #[test]
  fn a_deprecated_call_puts_its_leading_arguments_first() {
    use std::rc::Rc;
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);
    let echo: NativeClosure<SymbolU32> = Rc::new(|_env, args| Ok(Value::List(List { items: args.into() })));
    let sym = interp.string_interner().get_or_intern("new.ls");
    env.borrow_mut().define(sym, Value::Function(Function::NativeClosure(echo)));
    interp.add_deprecated_call("old.list", "new.ls", &["-l"]);
    let strings = |value: Value<SymbolU32>| match value {
      Value::List(list) => list
        .items
        .iter()
        .map(|item| match item {
          Value::String(s) => s.to_string(),
          other => panic!("expected a string, got {other:?}"),
        })
        .collect::<Vec<_>>(),
      other => panic!("expected a list, got {other:?}"),
    };
    let called = eval_one(&mut interp, &env, r#"(old.list "dir")"#).expect("a call");
    assert_eq!(strings(called), ["-l", "dir"]);
    let bare = eval_one(&mut interp, &env, r#"((if true old.list nil) "a" "b")"#).expect("a bare value");
    assert_eq!(strings(bare), ["-l", "a", "b"]);
    assert_eq!(
      interp.take_deprecations(),
      vec![crate::Deprecation { old: "old.list".into(), new: "new.ls -l".into() }]
    );
    let asts = Runtime::parse(None, r#"(old.list "x")"#, interp.string_interner()).expect("parse");
    let mut form = Value::from_sexpression(asts.first().expect("one form")).expect("a form");
    interp.respell_deprecated(&mut form);
    let respelled = format!("{form:?}");
    assert!(respelled.contains("\"-l\"") && respelled.contains("\"x\""), "{respelled}");
    assert_eq!(strings(interp.eval_expression(env.clone(), &form).expect("respelled")), ["-l", "x"]);
    assert_eq!(interp.take_deprecations().len(), 1, "the respelling is recorded");
    assert!(eval_one(&mut interp, &env, "(old.list.more)").is_err(), "a retired command is only itself");
    // The bare name answers one closure while its replacement is unchanged,
    // and the interpreter names the retired command it fronts.
    let closure = |value: Value<SymbolU32>| match value {
      Value::Function(Function::NativeClosure(f)) => f,
      other => panic!("expected a closure, got {other:?}"),
    };
    let first = closure(eval_one(&mut interp, &env, "old.list").expect("bare"));
    let second = closure(eval_one(&mut interp, &env, "old.list").expect("bare"));
    assert!(Rc::ptr_eq(&first, &second), "one identity");
    assert_eq!(interp.deprecated_call_of(&first), Some("old.list"));
    let echo: NativeClosure<SymbolU32> = Rc::new(|_env, args| Ok(Value::List(List { items: args.into() })));
    assert_eq!(interp.deprecated_call_of(&echo), None);
    env.borrow_mut().define(sym, Value::Function(Function::NativeClosure(echo)));
    let rebound = closure(eval_one(&mut interp, &env, "old.list").expect("bare"));
    assert!(!Rc::ptr_eq(&first, &rebound), "a new replacement, a new application");
    assert_eq!(interp.deprecated_call_of(&first), None, "the old application is forgotten");
    assert_eq!(interp.deprecated_call_of(&rebound), Some("old.list"));
  }

  /// A receiver dispatches on its first argument, and the SUGAR reaches the
  /// same place: `(shell :lane.declare "moo")` and `(shell.lane.declare "moo")`
  /// are the same message send.
  #[test]
  pub fn receiver_dispatches_directly_and_through_the_dot_sugar() {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);
    receiver_fixture(&mut interp, &env, "shell");

    let direct = eval_one(&mut interp, &env, r#"(shell :lane.declare "moo")"#).expect("direct");
    assert!(
      matches!(&direct, Value::String(s) if s == "moo"),
      "{direct:?}"
    );

    let sugared = eval_one(&mut interp, &env, r#"(shell.lane.declare "moo")"#).expect("sugared");
    assert!(
      matches!(&sugared, Value::String(s) if s == "moo"),
      "same send: {sugared:?}"
    );
  }

  /// WHOLE-SYMBOL LOOKUP WINS. A dotted name that is BOUND resolves to its
  /// binding and the sugar never runs — this is the compatibility guarantee
  /// that keeps `lane.declare`, `session.cwd` and `std.apps.install` working
  /// even when a receiver named `lane`/`session`/`std` also exists.
  #[test]
  pub fn a_bound_dotted_name_beats_the_sugar() {
    use std::rc::Rc;
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);
    receiver_fixture(&mut interp, &env, "shell");

    // Bind the WHOLE dotted name to something else entirely.
    let whole: NativeClosure<SymbolU32> =
      Rc::new(|_env, _args| Ok(Value::String("whole-symbol".into())));
    let sym = interp.string_interner().get_or_intern("shell.lane.declare");
    env
      .borrow_mut()
      .define(sym, Value::Function(Function::NativeClosure(whole)));

    let got = eval_one(&mut interp, &env, r#"(shell.lane.declare "moo")"#).expect("eval");
    assert!(
      matches!(&got, Value::String(s) if s == "whole-symbol"),
      "the bound whole symbol wins; the receiver is not consulted: {got:?}"
    );
  }

  /// A head that is NOT a receiver leaves the original error untouched — a
  /// lambda, a plain native, or an unbound name all still fail exactly as they
  /// did before the sugar existed.
  #[test]
  pub fn a_non_receiver_head_still_reports_undefined() {
    use std::rc::Rc;
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);

    // A plain native closure bound to `notrecv` — callable, but not a receiver.
    let plain: NativeClosure<SymbolU32> = Rc::new(|_env, _args| Ok(Value::Nil));
    let sym = interp.string_interner().get_or_intern("notrecv");
    env
      .borrow_mut()
      .define(sym, Value::Function(Function::NativeClosure(plain)));

    let err = eval_one(&mut interp, &env, "(notrecv.anything 1)").unwrap_err();
    assert!(
      matches!(err, crate::eval::RuntimeError::UndefinedSymbol { .. }),
      "a non-receiver head is not a message send: {err:?}"
    );

    // And a head that is not bound at all.
    let err = eval_one(&mut interp, &env, "(nosuch.thing 1)").unwrap_err();
    assert!(matches!(
      err,
      crate::eval::RuntimeError::UndefinedSymbol { .. }
    ));
  }

  /// A selector the receiver does not carry is NOT a message send: absence is
  /// the prohibition, so `shell.nope` stays undefined rather than becoming a
  /// callable that fails later. Reported where it was written.
  #[test]
  pub fn an_unknown_selector_is_not_a_send() {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);
    receiver_fixture(&mut interp, &env, "shell");

    let err = eval_one(&mut interp, &env, "(shell.nope 1)").unwrap_err();
    assert!(
      matches!(err, crate::eval::RuntimeError::UndefinedSymbol { .. }),
      "an unknown selector is not a send: {err:?}"
    );

    // Sent DIRECTLY, the receiver's own miss teaches what it does answer.
    let err = eval_one(&mut interp, &env, "(shell :nope)").unwrap_err();
    let text = format!("{err:?}");
    assert!(text.contains("does not answer"), "{text}");
    assert!(
      text.contains(":lane.declare"),
      "it lists what it answers: {text}"
    );
  }

  /// Existing dotted names are untouched when no receiver is involved at all —
  /// the ordinary case, and the one that must not regress.
  #[test]
  pub fn ordinary_dotted_names_are_unaffected() {
    use std::rc::Rc;
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);

    let f: NativeClosure<SymbolU32> = Rc::new(|_env, _args| Ok(Value::Integer(7)));
    let sym = interp.string_interner().get_or_intern("lane.declare");
    env
      .borrow_mut()
      .define(sym, Value::Function(Function::NativeClosure(f)));

    let got = eval_one(&mut interp, &env, "(lane.declare)").expect("eval");
    assert!(matches!(got, Value::Integer(7)), "{got:?}");
  }

  #[test]
  pub fn native_closure_captures_mutable_state() {
    use std::cell::Cell;
    use std::rc::Rc;

    let counter: Rc<Cell<i32>> = Rc::new(Cell::new(0));
    let counter_for_closure = counter.clone();

    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);

    let closure: NativeClosure<SymbolU32> = Rc::new(move |_env, _args| {
      counter_for_closure.set(counter_for_closure.get() + 1);
      Ok(Value::Integer(counter_for_closure.get() as i64))
    });
    let sym = interp.string_interner().get_or_intern("bump");
    env
      .borrow_mut()
      .define(sym, Value::Function(Function::NativeClosure(closure)));

    let asts =
      Runtime::parse(None, "(bump) (bump) (bump)", interp.string_interner()).expect("parse");
    let mut last = Value::Nil;
    for ast in asts {
      let v = Value::from_sexpression(&ast).expect("from_sexpression");
      last = interp
        .eval_expression(env.clone(), &v)
        .expect("eval (bump)");
    }
    match last {
      Value::Integer(n) => assert_eq!(n, 3, "last expression result"),
      other => panic!("expected Integer(3), got {:?}", other),
    }
    assert_eq!(counter.get(), 3);
  }
}

/// Phase 2: errors-as-values at the seam — `(try …)`, `(unwrap …)`,
/// `(expect …)`, the `Value::Error` variant, the soft/hard split, and the
/// inspection natives.
#[cfg(test)]
mod error_seam_tests {
  use super::*;
  use string_interner::backend::StringBackend;
  use string_interner::symbol::SymbolU32;

  type V = Value<SymbolU32>;

  /// Eval every form in `src` against a fresh default env; return each form's
  /// value, or short-circuit on the first RuntimeError (syntax errors panic).
  fn eval_seq(src: &str) -> Result<Vec<V>, RuntimeError> {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);
    let asts = Runtime::<SymbolU32, StringBackend>::parse(None, src, interp.string_interner())
      .expect("parse");
    let mut out = Vec::new();
    for ast in asts {
      let v = Value::from_sexpression(&ast).expect("from_sexpression");
      out.push(interp.eval_expression(env.clone(), &v)?);
    }
    Ok(out)
  }

  /// The last form's value (or the RuntimeError).
  fn run(src: &str) -> Result<V, RuntimeError> {
    eval_seq(src).map(|vs| vs.into_iter().last().unwrap_or(Value::Nil))
  }

  fn int(v: &V) -> i64 {
    match v {
      Value::Integer(i) => *i,
      other => panic!("expected Integer, got {other:?}"),
    }
  }

  fn string(v: &V) -> &str {
    match v {
      Value::String(s) => s,
      other => panic!("expected String, got {other:?}"),
    }
  }

  #[test]
  fn try_captures_a_soft_error_as_a_value() {
    let vs = eval_seq("(let r (try (nope)))\n(error? r)\n(error.kind r)\n(error.message r)")
      .expect("try captures, never errors out");
    assert!(matches!(vs[1], Value::Boolean(true)), "error? => true");
    assert_eq!(string(&vs[2]), "unbound", "unbound-symbol kind");
    assert!(
      string(&vs[3]).contains("undefined symbol"),
      "message carries the original text: {:?}",
      vs[3]
    );
  }

  #[test]
  fn try_origin_renders_the_inner_form() {
    let v = run("(error.origin (try (nope)))").expect("origin readable");
    assert!(
      string(&v).contains("nope"),
      "origin renders the failed form: {v:?}"
    );
  }

  #[test]
  fn try_or_returns_fallback_on_soft_error_and_is_lazy_on_success() {
    // `hit` is bumped only when a fallback actually evaluates. `a` fails soft
    // (fallback runs → hit=1, a=99); `b` succeeds (fallback must NOT run).
    let vs = eval_seq(
      "(let hit 0)\n\
       (let a (try (nope) :or (begin (set! hit 1) 99)))\n\
       (let b (try 7 :or (begin (set! hit 2) 0)))\n\
       hit\na\nb",
    )
    .expect("no form errors — try defuses");
    assert_eq!(int(&vs[4]), 99, "a took the fallback value");
    assert_eq!(int(&vs[5]), 7, "b kept the success value");
    assert_eq!(
      int(&vs[3]),
      1,
      "fallback ran once (for a), never for b's success"
    );
  }

  #[test]
  fn try_passes_hard_assert_through() {
    let e = run("(try (assert false \"boom\"))").expect_err("assert is hard; try can't defuse it");
    assert!(e.is_hard(), "assert failure stays hard");
    assert!(e.to_string().contains("boom"));
  }

  #[test]
  fn try_passes_a_blown_budget_through() {
    // Budget errors must remain hard — a runaway inside `try` still halts.
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);
    interp.replace_eval_budget(Some(EvalBudget {
      max_steps: 50_000,
      deadline: None,
      max_depth: 200,
    }));
    let asts = Runtime::<SymbolU32, StringBackend>::parse(
      None,
      "(define (boom) (boom))\n(try (boom))",
      interp.string_interner(),
    )
    .expect("parse");
    let mut err = None;
    for ast in asts {
      let v = Value::from_sexpression(&ast).expect("from_sexpression");
      if let Err(e) = interp.eval_expression(env.clone(), &v) {
        err = Some(e);
        break;
      }
    }
    let e = err.expect("budget halts even inside try");
    assert!(e.is_hard(), "blown budget is hard");
    assert!(
      e.to_string().contains("recursion too deep") || e.to_string().contains("budget exceeded"),
      "got: {e}"
    );
  }

  #[test]
  fn try_misuse_is_a_hard_structural_error() {
    assert!(run("(try)").expect_err("no form").is_hard());
    assert!(
      run("(try (nope) :nope 1)")
        .expect_err("bad keyword")
        .is_hard(),
      "an unknown keyword is structural, not a captured soft error"
    );
  }

  #[test]
  fn expect_escalates_a_soft_error_to_hard() {
    let e = run("(expect (nope) \"must exist\")").expect_err("expect escalates");
    assert!(e.is_hard(), "escalated error is hard");
    assert!(
      matches!(e, RuntimeError::Fatal { .. }),
      "escalation lands on Fatal"
    );
    assert!(
      e.to_string().contains("must exist"),
      "custom message included: {e}"
    );
    // Success passes through untouched (message never evaluated).
    assert_eq!(
      int(&run("(expect 5 \"unused\")").expect("expect passes success")),
      5
    );
  }

  #[test]
  fn expect_without_a_message_is_an_arity_error_teaching_unwrap() {
    // Rust's `.expect()` always carries a message; the messageless assert is
    // `(unwrap form)` and the arity error must say so.
    let e = run("(expect (nope))").expect_err("message is required");
    assert!(matches!(e, RuntimeError::ArityError { .. }), "got: {e:?}");
    assert!(e.is_hard(), "structural misuse is hard");
    assert!(
      e.to_string().contains("unwrap"),
      "teaches the unwrap form: {e}"
    );
  }

  #[test]
  fn unwrap_escalates_a_soft_error_to_hard() {
    let e = run("(unwrap (nope))").expect_err("unwrap escalates");
    assert!(e.is_hard(), "escalated error is hard");
    assert!(
      matches!(e, RuntimeError::Fatal { .. }),
      "escalation lands on Fatal"
    );
    assert!(e.to_string().contains("unwrap failed"), "got: {e}");
    assert!(
      e.to_string().contains("undefined symbol"),
      "carries the cause: {e}"
    );
    // Success passes through untouched; misuse is structural.
    assert_eq!(int(&run("(unwrap 5)").expect("unwrap passes success")), 5);
    assert!(matches!(
      run("(unwrap)").expect_err("no form"),
      RuntimeError::ArityError { .. }
    ));
    assert!(matches!(
      run("(unwrap 1 2)").expect_err("two args"),
      RuntimeError::ArityError { .. }
    ));
  }

  /// The value-awareness rule: `(unwrap (try (nope)))` ≡ `(unwrap (nope))` —
  /// a reified error value escalates exactly like the in-flight soft failure
  /// it captured, carrying the same unbound message (plus its origin).
  #[test]
  fn unwrap_escalates_a_reified_error_like_an_in_flight_one() {
    let reified = run("(unwrap (try (nope)))").expect_err("reified error escalates");
    let in_flight = run("(unwrap (nope))").expect_err("in-flight error escalates");
    assert!(
      matches!(reified, RuntimeError::Fatal { .. }),
      "got: {reified:?}"
    );
    assert!(
      matches!(in_flight, RuntimeError::Fatal { .. }),
      "got: {in_flight:?}"
    );
    for e in [&reified, &in_flight] {
      let text = e.to_string();
      assert!(text.contains("unwrap failed"), "got: {text}");
      assert!(text.contains("undefined symbol"), "got: {text}");
      assert!(text.contains("nope"), "got: {text}");
    }
    // The reified path additionally carries the captured origin.
    assert!(reified.to_string().contains("origin"), "got: {reified}");
  }

  #[test]
  fn expect_escalates_a_reified_error_with_its_prefix() {
    let e = run("(expect (try (nope)) \"ctx\")").expect_err("reified error escalates");
    assert!(matches!(e, RuntimeError::Fatal { .. }), "got: {e:?}");
    let text = e.to_string();
    assert!(text.starts_with("ctx: "), "message prefixes: {text}");
    assert!(
      text.contains("undefined symbol"),
      "captured message carried: {text}"
    );
  }

  /// `:or` fires on a reified error value too (`unwrap_or_else` on an `Err`):
  /// the inner `try` returns an error VALUE, the outer `try` sees Ok(Error) —
  /// and the fallback fires.
  #[test]
  fn try_or_fires_on_a_reified_error_value() {
    assert_eq!(
      int(&run("(try (try (nope)) :or 42)").expect(":or defuses the reified error")),
      42
    );
  }

  /// Plain `try` is idempotent: `(try (try (nope)))` returns the SAME error
  /// value unchanged — re-wrapping never stacks.
  #[test]
  fn try_is_idempotent_on_an_error_value() {
    let vs = eval_seq("(let once (try (nope)))\n(let twice (try (try (nope))))\nonce\ntwice")
      .expect("both capture");
    let (once, twice) = (&vs[2], &vs[3]);
    match (once, twice) {
      (Value::Error(a), Value::Error(b)) => assert_eq!(a, b, "identical error values"),
      other => panic!("expected two error values, got {other:?}"),
    }
  }

  #[test]
  fn an_error_value_is_falsy() {
    assert_eq!(
      int(&run("(if (try (nope)) 1 2)").expect("if over a captured error")),
      2,
      "a captured error takes the else branch"
    );
  }

  #[test]
  fn format_value_renders_the_error_shape() {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);
    let asts =
      Runtime::<SymbolU32, StringBackend>::parse(None, "(try (nope))", interp.string_interner())
        .expect("parse");
    let v = interp
      .eval_expression(
        env,
        &Value::from_sexpression(&asts[0]).expect("from_sexpression"),
      )
      .expect("try captures");
    let s = interp.format_value(&v);
    assert!(s.starts_with("#<error unbound:"), "got: {s}");
    assert!(s.contains("undefined symbol"), "got: {s}");
    assert!(s.ends_with('>'));
  }

  #[test]
  fn json_stringify_emits_the_tagged_error_record() {
    let v = run("(json-stringify (try (nope)))").expect("stringify an error value");
    let text = string(&v);
    let j: serde_json::Value = serde_json::from_str(text).expect("valid JSON");
    assert_eq!(j["type"], "error/v1");
    assert_eq!(j["kind"], "unbound");
    assert!(j["message"].as_str().unwrap().contains("undefined symbol"));
    assert!(j["origin"].as_str().unwrap().contains("nope"));
    assert!(j["chain"].as_array().unwrap().is_empty());
  }

  /// tsh-core-shell(14) W4: a reported failure's display fields ride its
  /// error/v1 record; without them the record keeps its old keys.
  #[test]
  fn an_error_record_carries_display_fields_only_when_reported() {
    let mut error = crate::ErrorValue {
      kind: "partial".into(),
      message: "m".into(),
      origin: None,
      chain: vec![],
      host: None,
      hint: None,
      next: None,
      output: None,
      display: None,
    };
    let plain = error.to_record();
    assert!(plain.get("shape").is_none() && plain.get("rows").is_none(), "got: {plain}");
    let display = serde_json::json!({"shape": "term.block/v1", "rows": [{"spans": [{"text": "Count"}]}]});
    error.display = display.as_object().cloned();
    let record = error.to_record();
    assert_eq!(record["shape"], "term.block/v1");
    assert_eq!(record["rows"], display["rows"]);
    assert_eq!((record["type"].as_str(), record["message"].as_str()), (Some("error/v1"), Some("m")));
  }

  #[test]
  fn inspection_natives_are_safe_on_non_errors() {
    let vs = eval_seq(
      "(error? 5)\n(error? \"x\")\n(error.kind 5)\n(error.message nil)\n\
       (error.origin (list 1 2))\n(error.chain 3)",
    )
    .expect("inspection never type-errors");
    assert!(matches!(vs[0], Value::Boolean(false)), "error? on int");
    assert!(matches!(vs[1], Value::Boolean(false)), "error? on string");
    assert!(matches!(vs[2], Value::Nil), "kind of non-error is nil");
    assert!(matches!(vs[3], Value::Nil), "message of non-error is nil");
    assert!(matches!(vs[4], Value::Nil), "origin of non-error is nil");
    assert!(matches!(vs[5], Value::Nil), "chain of non-error is nil");
  }

  #[test]
  fn error_chain_is_an_empty_list_in_phase_2() {
    let v = run("(error.chain (try (nope)))").expect("chain of an error");
    match v {
      Value::List(l) => assert!(l.items.is_empty(), "chain is empty in Phase 2"),
      other => panic!("expected a list, got {other:?}"),
    }
  }
}

/// Phase A.1: TS-style template literals — `` `a ${b}` `` is parse-level
/// sugar for `(str.concat "a " b)`; a hole-free template collapses to a
/// plain string literal. Plain `"…"` strings and tagged strings are
/// untouched (see also the lexer-level tests in `lexer.rs`).
#[cfg(test)]
mod template_literal_tests {
  use super::*;
  use string_interner::StringInterner;
  use string_interner::backend::StringBackend;
  use string_interner::symbol::SymbolU32;

  type V = Value<SymbolU32>;

  /// Eval every form in `src` against a fresh default env; return the
  /// last form's value (syntax and runtime errors panic).
  fn run(src: &str) -> V {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let env = Interpreter::default_env(&mut interp);
    let asts = Runtime::<SymbolU32, StringBackend>::parse(None, src, interp.string_interner())
      .expect("parse");
    let mut last = Value::Nil;
    for ast in asts {
      let v = Value::from_sexpression(&ast).expect("from_sexpression");
      last = interp.eval_expression(env.clone(), &v).expect("eval");
    }
    last
  }

  fn eval_str(src: &str) -> String {
    match run(src) {
      Value::String(s) => s.into_string(),
      other => panic!("expected String, got {other:?}"),
    }
  }

  fn parse_err(src: &str) -> String {
    let mut interner = StringInterner::<StringBackend>::new();
    let err = Runtime::<SymbolU32, StringBackend>::parse(None, src, &mut interner)
      .expect_err("expected a syntax error");
    format!("{err:?}")
  }

  #[test]
  fn no_hole_template_desugars_to_a_plain_string_literal() {
    let mut interner = StringInterner::<StringBackend>::new();
    let asts = Runtime::<SymbolU32, StringBackend>::parse(None, "`hi there` ``", &mut interner)
      .expect("parse");
    assert_eq!(
      asts,
      vec![
        SExpression::Literal(Literal::String("hi there".into())),
        SExpression::Literal(Literal::String("".into())),
      ]
    );
  }

  #[test]
  fn template_with_holes_desugars_to_str_concat() {
    let mut interner = StringInterner::<StringBackend>::new();
    let asts =
      Runtime::<SymbolU32, StringBackend>::parse(None, "`a ${b} c`", &mut interner).expect("parse");
    let concat = interner.get_or_intern("str.concat");
    let b = interner.get_or_intern("b");
    assert_eq!(
      asts,
      vec![SExpression::List(vec![
        SExpression::Literal(Literal::Symbol(concat)),
        SExpression::Literal(Literal::String("a ".into())),
        SExpression::Literal(Literal::Symbol(b)),
        SExpression::Literal(Literal::String(" c".into())),
      ])]
    );
  }

  #[test]
  fn single_hole_interpolates() {
    assert_eq!(
      eval_str("(let name \"world\")\n`hello ${name}!`"),
      "hello world!"
    );
  }

  #[test]
  fn holes_at_start_end_and_multiple() {
    assert_eq!(
      eval_str("(let a \"x\")\n(let b \"y\")\n`${a} and ${b}`"),
      "x and y"
    );
  }

  #[test]
  fn adjacent_holes() {
    assert_eq!(eval_str("`${1}${2}`"), "12");
  }

  /// A hole holding a call whose string argument contains braces — the
  /// balanced hole scanner must not close on `}` inside `"…"`.
  #[test]
  fn hole_with_call_and_braced_string_argument() {
    assert_eq!(eval_str(r#"`v=${(concat "A{B}" "!")}`"#), "v=A{B}!");
  }

  /// Non-string hole values stringify via `str.concat`'s scalar
  /// coercion — the same convention as `concat` / `str`.
  #[test]
  fn number_holes_stringify_like_concat() {
    assert_eq!(
      eval_str("`n=${(+ 1 2)} f=${1.5} b=${true}`"),
      "n=3 f=1.5 b=true"
    );
  }

  #[test]
  fn escapes_and_bare_dollars_stay_literal() {
    assert_eq!(eval_str(r"`\${not-a-hole}`"), "${not-a-hole}");
    assert_eq!(eval_str(r"`tick \` tock`"), "tick ` tock");
    assert_eq!(eval_str("`costs $5`"), "costs $5");
    assert_eq!(eval_str("`trailing$`"), "trailing$");
  }

  /// Regression: plain `"…"` strings stay 100% literal.
  #[test]
  fn plain_strings_keep_dollar_brace_literal() {
    assert_eq!(eval_str(r#""${x} stays literal""#), "${x} stays literal");
  }

  /// Regression: tagged strings still evaluate as before, and their
  /// payloads are RAW — `${…}` is not interpolated.
  #[test]
  fn tagged_strings_still_work_and_stay_raw() {
    match run("x`a ${b} c`") {
      Value::List(l) => {
        assert_eq!(l.items.len(), 2);
        assert!(matches!(&l.items[0], Value::String(s) if s == "x"));
        assert!(matches!(&l.items[1], Value::String(s) if s == "a ${b} c"));
      }
      other => panic!("expected (tag payload) list, got {other:?}"),
    }
    // `json` tag still parses its payload; long form still lexes.
    match run(r#"json`{"a": 1}`"#) {
      Value::Map(m) => assert_eq!(m.len(), 1),
      other => panic!("expected map from json tag, got {other:?}"),
    }
    match run("x```a `tick` ${b}```") {
      Value::List(l) => {
        assert!(matches!(&l.items[1], Value::String(s) if s == "a `tick` ${b}"));
      }
      other => panic!("expected (tag payload) list, got {other:?}"),
    }
  }

  #[test]
  fn template_syntax_errors_are_clear() {
    assert!(
      parse_err("`abc").contains("UnterminatedTemplateString"),
      "got: {}",
      parse_err("`abc")
    );
    assert!(
      parse_err("`${}`").contains("EmptyTemplateHole"),
      "got: {}",
      parse_err("`${}`")
    );
    // Documented choice: backticks (nested templates, tagged strings)
    // are rejected inside holes.
    assert!(
      parse_err("`${`nested`}`").contains("NestedBacktickInTemplateHole"),
      "got: {}",
      parse_err("`${`nested`}`")
    );
    // A hole must contain exactly one expression.
    assert!(matches!(
      Runtime::<SymbolU32, StringBackend>::parse(
        None,
        "`${1 2}`",
        &mut StringInterner::<StringBackend>::new()
      ),
      Err(SyntaxError::UnexpectedToken { .. })
    ));
  }
}

#[cfg(test)]
mod read_only_binding_tests {
  use super::*;
  use string_interner::backend::StringBackend;
  use string_interner::symbol::SymbolU32;

  /// Eval `src` form by form; the first runtime error ends it.
  fn run(interp: &mut Interpreter<SymbolU32, StringBackend>, src: &str) -> Result<Value<SymbolU32>, RuntimeError> {
    let env = Interpreter::default_env(interp);
    let asts = Runtime::<SymbolU32, StringBackend>::parse(None, src, interp.string_interner()).expect("parse");
    let mut last = Value::Nil;
    for ast in asts {
      last = interp.eval_expression(env.clone(), &Value::from_sexpression(&ast).expect("value"))?;
    }
    Ok(last)
  }

  /// `std.*` is read-only for user code: every source-level binding form
  /// refuses it loudly, while the host still registers natives directly.
  #[test]
  fn std_names_are_read_only_for_user_code() {
    for source in [
      "(let std.cli.anything 1)",
      "(define std.text.wrap 1)",
      "(define (std.text.wrap x) x)",
      "(defun std.process.capture (r) r)",
      "(fn std.process.capture (r) r)",
      "(set! std.http.request 1)",
      "(let std 1)",
      "(let std.coreutil.cat 1)",
    ] {
      let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
      let error = run(&mut interp, source).expect_err(source).to_string();
      assert!(error.contains("is read-only: std names are defined by the host"), "{source}: {error}");
    }
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    assert!(run(&mut interp, "(let standard 1) (let my.std.x 2) my.std.x").is_ok());
    // The utilities are `std.coreutil.*` (operator, 2026-10-19): `coreutil`
    // itself is an ordinary name.
    assert!(run(&mut interp, "(let coreutil.cat 1) coreutil.cat").is_ok());
  }

  /// `tsh.plugins` is the platform's plugin family (A5): read-only like
  /// `std.*`, in every binding form, while the rest of `tsh.*` and names that
  /// merely start with the same letters stay user names.
  #[test]
  fn tsh_plugins_names_are_read_only_for_user_code() {
    for source in [
      "(let tsh.plugins 1)",
      "(let tsh.plugins.records 1)",
      "(define (tsh.plugins.install x) x)",
      "(defun tsh.plugins.pin (a b) a)",
      "(fn tsh.plugins.pin (a b) a)",
      "(set! tsh.plugins.list 1)",
    ] {
      let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
      let error = run(&mut interp, source).expect_err(source).to_string();
      assert!(error.contains("is read-only: tsh.plugins names are defined by the host"), "{source}: {error}");
    }
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    assert!(run(&mut interp, "(let tsh.plugins-extra 1) (let tsh.scenes 2) (let my.tsh.plugins 3) tsh.scenes").is_ok());
  }

  /// Refinement 8 (2026-10-05): `set` assigns; `set!` still does for one
  /// release and records a deprecation the host warns about.
  #[test]
  fn set_assigns_and_set_bang_is_a_recorded_deprecated_alias() {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    assert!(matches!(run(&mut interp, "(let y 1) (set y 2) y"), Ok(Value::Integer(2))));
    assert!(interp.take_deprecations().is_empty());
    assert!(matches!(run(&mut interp, "(let y 1) (set! y 3) (set! y 4) y"), Ok(Value::Integer(4))));
    assert_eq!(
      interp.take_deprecations(),
      vec![crate::Deprecation { old: "set!".into(), new: "set".into() }]
    );
    assert!(run(&mut interp, "(set never 1)").is_err(), "set never creates a binding");
  }

  /// A host-declared renamed prefix resolves only on a miss, records each
  /// old spelling, and binds nothing under the old (read-only) root.
  #[test]
  fn deprecated_alias_resolves_on_a_miss_and_is_recorded() {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    interp.add_deprecated_alias("old.ns", "new.ns");
    interp.add_deprecated_alias("std.apps", "new.ns");
    assert!(matches!(run(&mut interp, "(let new.ns.n 7) old.ns.n"), Ok(Value::Integer(7))));
    assert!(matches!(run(&mut interp, "(let new.ns.n 8) std.apps.n"), Ok(Value::Integer(8))));
    assert_eq!(
      interp.take_deprecations(),
      vec![
        crate::Deprecation { old: "old.ns.n".into(), new: "new.ns.n".into() },
        crate::Deprecation { old: "std.apps.n".into(), new: "new.ns.n".into() },
      ]
    );
    // A bound old name wins; an unrelated prefix is still a miss.
    assert!(matches!(run(&mut interp, "(let new.ns.n 1) (let old.ns.n 2) old.ns.n"), Ok(Value::Integer(2))));
    assert!(run(&mut interp, "old.nsx.n").is_err());
    let error = run(&mut interp, "(let std.apps.m 1)").expect_err("std stays read-only").to_string();
    assert!(error.contains("read-only"), "{error}");
  }

  /// A5: the host's guard makes a name read-only in every binding form;
  /// an inner `let` may still shadow it.
  #[test]
  fn binding_guard_refuses_every_assignment_form() {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    interp.set_binding_guard(std::rc::Rc::new(|name: &str| (name == "x").then(|| format!("{name}: readonly variable"))));
    for source in ["(let x 2)", "(define (x) 1)", "(defun x () 1)", "(fn x () 1)", "(set! x 3)", "((lambda () (let x 4)))"] {
      let error = run(&mut interp, source).expect_err(source).to_string();
      assert_eq!(error, "x: readonly variable", "{source}");
    }
    assert!(matches!(run(&mut interp, "(let ((x 5)) x)"), Ok(Value::Integer(5))));
    assert!(matches!(run(&mut interp, "(let y 1) (set! y 2) y"), Ok(Value::Integer(2))));
  }

  #[test]
  fn fn_and_defun_share_named_function_semantics() {
    for spelling in ["fn", "defun"] {
      let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
      let recursion = format!("({spelling} fact (n) (if (= n 0) 1 (* n (fact (- n 1))))) (fact 5)");
      assert!(matches!(run(&mut interp, &recursion), Ok(Value::Integer(120))), "{recursion}");

      let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
      let closure = format!("(let ((seed 4)) ({spelling} add (x) (+ x seed)) (add 3))");
      assert!(matches!(run(&mut interp, &closure), Ok(Value::Integer(7))), "{closure}");

      let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
      let malformed = format!("({spelling} answer)");
      let error = run(&mut interp, &malformed).expect_err(&malformed).to_string();
      assert!(error.contains(&format!("{spelling} takes name + params + body")), "{error}");
    }
  }

  /// Rulings 18/19 (2026-10-06): `(let NAME VALUE)` with no body is the
  /// binding form. It binds in the scope it runs in — the top level, a
  /// lambda's call scope, an enclosing `let` body — and returns the value.
  #[test]
  fn let_without_a_body_binds_in_the_current_scope() {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    let mut ok = |source: &str, want: i64| match run(&mut interp, source) {
      Ok(Value::Integer(got)) => assert_eq!(got, want, "{source}"),
      other => panic!("{source}: {other:?}"),
    };
    ok("(let a 5)", 5);
    ok("(let a 5) (+ a 1)", 6);
    // A function is a lambda bound by `let`; it sees later top-level names.
    ok("(let f (lambda (n) (* n b))) (let b 3) (f 2)", 6);
    // Inside a lambda the binding is local to the call.
    ok("((lambda () (let inner 7) (+ inner 1)))", 8);
    // The scoped spellings keep working beside it.
    ok("(let ((p 1) (q (+ p 1))) q)", 2);
    ok("(let [p 2 q 3] (* p q))", 6);
    ok("(let p 4 (+ p 1))", 5);
    // Rebinding a name is a fresh `let`, as in Rust.
    ok("(let a 1) (let a (+ a 10)) a", 11);
    let leaked = |interp: &mut Interpreter<SymbolU32, StringBackend>, source: &str| run(interp, source).is_ok();
    assert!(!leaked(&mut interp, "((lambda () (let inner 7))) inner"), "a call-local let must not leak");
    assert!(!leaked(&mut interp, "(let p 4 p) p"), "`(let NAME VALUE body…)` binds only for the body");
  }

  /// Ruling 19: `def` is gone with no deprecation window. Every spelling of it
  /// fails loudly and names its replacement; nothing is bound.
  #[test]
  fn def_is_a_loud_error_that_names_let() {
    for source in ["(def x 1)", "(def (f a) a)", "(def x)", "((lambda () (def y 2)))"] {
      let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
      let error = run(&mut interp, source).expect_err(source).to_string();
      assert!(error.contains("`def` was removed; use (let NAME VALUE)"), "{source}: {error}");
      assert!(run(&mut interp, "x").is_err(), "{source} bound nothing");
    }
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    // `def` stays an ordinary word elsewhere: a quoted symbol, a binding name.
    assert!(run(&mut interp, "(let def 1) def").is_ok());
    assert!(run(&mut interp, "'(def x 1)").is_ok());
  }

  /// `let` with too little to bind says what it takes.
  #[test]
  fn let_arity_errors_name_both_spellings() {
    let mut interp = Interpreter::<SymbolU32, StringBackend>::new();
    for source in ["(let)", "(let x)"] {
      let error = run(&mut interp, source).expect_err(source).to_string();
      assert!(error.contains("let needs NAME VALUE, or bindings + body"), "{source}: {error}");
    }
  }
}
