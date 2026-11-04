//! Refinement 8 (2026-10-05): lisp `set!` became `set`, and bash's `set`
//! builtin lowers to `std.sh.set`, so both meet at the mixed prompt without
//! colliding. Old spellings (`set!`, `std.tsh.X`, `std.apps`) keep working
//! for one release and warn once per site.
use super::bash_tests::host;
use super::*;

fn prompt() -> RunOptions {
  RunOptions { on_error: OnError::Bash, prompt: true, ..Default::default() }
}

fn lisp_file(path: &str) -> RunOptions {
  RunOptions { source_path: Some(path.into()), on_error: OnError::Bash, ..Default::default() }
}

async fn run(host: &mut LispHost, source: &str, options: RunOptions) -> Result<Option<JsonValue>, TshScriptError> {
  run_source_on_host(host, source, &Scripts::new(()), &HashMap::new(), &[], options).await
}

#[tokio::test]
async fn prompt_bash_set_and_lisp_set_both_work() {
  let mut host = host();
  host.collect_shell_diagnostics();
  // A bash line: the `set` builtin, lowered to `std.sh.set`.
  run(&mut host, "set -e", prompt()).await.unwrap();
  assert!(host.shell_errexit, "set -e reached bash's set builtin");
  run(&mut host, "set +e", prompt()).await.unwrap();
  assert!(!host.shell_errexit);
  // A lisp line: the `set` special form.
  run(&mut host, "(let x 1)", prompt()).await.unwrap();
  run(&mut host, "(set x 2)", prompt()).await.unwrap();
  assert_eq!(host.eval_to_json("x").unwrap(), serde_json::json!(2));
  assert!(host.take_shell_diagnostics().is_empty());
}

#[tokio::test]
async fn bash_set_lowers_to_a_qualified_head_and_keeps_its_name() {
  let mut host = host();
  let out = host.capture_shell_source("set -- a b; echo $1:$#").await.unwrap();
  assert_eq!(out.stdout, b"a:2\n");
  // A computed command word reaches the same builtin.
  let out = host.capture_shell_source("cmd=set; $cmd -- p q r; echo $1:$#").await.unwrap();
  assert_eq!(out.stdout, b"p:3\n");
  // xtrace shows the bash word, never the lowered head.
  host.collect_shell_diagnostics();
  host.capture_shell_source("set -x; set -- z; set +x").await.unwrap();
  assert_eq!(host.take_shell_diagnostics(), vec!["+ set -- z", "+ set +x"]);
}

#[tokio::test]
async fn set_bang_still_works_and_warns_once_per_site() {
  let mut host = host();
  host.collect_shell_diagnostics();
  let source = ";; old spelling\n(let y 1)\n(set! y 2)\n(set y 3)\n";
  run(&mut host, source, lisp_file("old.tsh")).await.unwrap();
  assert_eq!(host.eval_to_json("y").unwrap(), serde_json::json!(3));
  assert_eq!(
    host.take_shell_diagnostics(),
    vec![
      "tsh: old.tsh: line 3: deprecated: `set!` is now `set` (the old spelling is removed in the next release)"
        .to_string()
    ]
  );
  // The same site again: no second warning.
  host.collect_shell_diagnostics();
  run(&mut host, source, lisp_file("old.tsh")).await.unwrap();
  assert!(host.take_shell_diagnostics().is_empty());
  // The new spelling never warns.
  host.collect_shell_diagnostics();
  run(&mut host, "(let z 1)\n(set z 2)", lisp_file("new.tsh")).await.unwrap();
  assert!(host.take_shell_diagnostics().is_empty());
}

#[tokio::test]
async fn set_bang_inside_a_function_warns_once_at_its_own_line() {
  let mut host = host();
  host.collect_shell_diagnostics();
  let source = "(let n 0)\n(let bump (lambda ()\n  (set! n (+ n 1))))\n(bump)\n(bump)\n";
  run(&mut host, source, lisp_file("loop.tsh")).await.unwrap();
  assert_eq!(host.eval_to_json("n").unwrap(), serde_json::json!(2));
  let diagnostics = host.take_shell_diagnostics();
  assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
  assert!(diagnostics[0].starts_with("tsh: loop.tsh: line 3: deprecated: `set!` is now `set`"), "{diagnostics:?}");
}

#[tokio::test]
async fn renamed_prefixes_resolve_and_warn_once_per_site() {
  let mut host = host();
  host.register_native_special("tsh.ping", |_| Ok(super::super::LispValue::String("pong".into())));
  host.register_native_special("tsh.plugins.list", |_| Ok(super::super::LispValue::String("listed".into())));
  host.add_deprecated_alias("std.tsh", "tsh");
  host.add_deprecated_alias("std.apps", "tsh.plugins");
  host.collect_shell_diagnostics();
  let source = "(let a (std.tsh.ping))\n(let b (std.apps.list))\n(let c (tsh.ping))\n(let d (std.tsh.ping))\n";
  run(&mut host, source, lisp_file("rc.tshrc")).await.unwrap();
  assert_eq!(host.eval_to_json("(list a b c d)").unwrap(), serde_json::json!(["pong", "listed", "pong", "pong"]));
  assert_eq!(
    host.take_shell_diagnostics(),
    vec![
      "tsh: rc.tshrc: line 1: deprecated: `std.tsh.ping` is now `tsh.ping` (the old spelling is removed in the next release)".to_string(),
      "tsh: rc.tshrc: line 2: deprecated: `std.apps.list` is now `tsh.plugins.list` (the old spelling is removed in the next release)".to_string(),
      "tsh: rc.tshrc: line 4: deprecated: `std.tsh.ping` is now `tsh.ping` (the old spelling is removed in the next release)".to_string(),
    ]
  );
  // A statement head on the lisp door is respelled before dispatch too.
  host.collect_shell_diagnostics();
  run(&mut host, "(std.tsh.ping)", prompt()).await.unwrap();
  let diagnostics = host.take_shell_diagnostics();
  assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
  assert!(diagnostics[0].contains("`std.tsh.ping` is now `tsh.ping`"), "{diagnostics:?}");
  // An unrelated miss under `std` is still an error.
  assert!(host.eval_to_json("(std.tshx.nope)").is_err());
}

#[tokio::test]
async fn deprecated_natives_keep_working_and_warn_once_per_site() {
  let mut host = host();
  let notes = host.deprecation_notes();
  host.register_native_special("old.read-text", move |_| {
    notes.note("old.read-text", "new.read_file");
    Ok(super::super::LispValue::String("text".into()))
  });
  host.collect_shell_diagnostics();
  let source = "(let a (old.read-text))\n(let b (old.read-text))\n(let read (lambda () (old.read-text)))\n(read)\n(read)\n";
  run(&mut host, source, lisp_file("rc.tsh")).await.unwrap();
  assert_eq!(host.eval_to_json("(list a b)").unwrap(), serde_json::json!(["text", "text"]));
  let message = "deprecated: `old.read-text` is now `new.read_file` (the old spelling is removed in the next release)";
  assert_eq!(
    host.take_shell_diagnostics(),
    vec![
      format!("tsh: rc.tsh: line 1: {message}"),
      format!("tsh: rc.tsh: line 2: {message}"),
      // Reached through a helper: each calling statement is a site.
      format!("tsh: rc.tsh: line 4: {message}"),
      format!("tsh: rc.tsh: line 5: {message}"),
    ]
  );
  host.collect_shell_diagnostics();
  run(&mut host, source, lisp_file("rc.tsh")).await.unwrap();
  assert!(host.take_shell_diagnostics().is_empty(), "each site warns once");
}

/// A child host (a `std.script.call` module's) evaluates and calls with
/// `eval_value` / `call_value`, which no runner drains: dropped during a
/// statement, it hands its deprecations to that statement, which warns once
/// per its own site, however many child hosts used the old spelling there.
#[tokio::test]
async fn a_dropped_child_hosts_deprecations_warn_at_the_calling_statement() {
  let mut host = host();
  host.register_native_special("child.call", |_| {
    let mut child = LispHost::new();
    child.hand_off_deprecations();
    let notes = child.deprecation_notes();
    child.register_native_special("old.read-text", move |_| {
      notes.note("old.read-text", "new.read_file");
      Ok(super::super::LispValue::String("text".into()))
    });
    child.add_deprecated_alias("std.tsh", "tsh");
    child.register_native_special("tsh.ping", |_| Ok(super::super::LispValue::String("pong".into())));
    child.eval_value("(fn child.read () (list (old.read-text) (std.tsh.ping)))").expect("the module loads");
    let read = child.eval_value("child.read").expect("the function");
    child.call_value(read, Vec::new())
  });
  host.collect_shell_diagnostics();
  let source = "(let a (child.call))\n(let b (list (child.call) (child.call)))\n";
  run(&mut host, source, lisp_file("driver.tsh")).await.unwrap();
  assert_eq!(host.eval_to_json("a").unwrap(), serde_json::json!(["text", "pong"]));
  let read = "deprecated: `old.read-text` is now `new.read_file` (the old spelling is removed in the next release)";
  let ping = "deprecated: `std.tsh.ping` is now `tsh.ping` (the old spelling is removed in the next release)";
  assert_eq!(
    host.take_shell_diagnostics(),
    vec![
      format!("tsh: driver.tsh: line 1: {ping}"),
      format!("tsh: driver.tsh: line 1: {read}"),
      format!("tsh: driver.tsh: line 2: {ping}"),
      format!("tsh: driver.tsh: line 2: {read}"),
    ]
  );
  host.collect_shell_diagnostics();
  run(&mut host, source, lisp_file("driver.tsh")).await.unwrap();
  assert!(host.take_shell_diagnostics().is_empty(), "each site warns once");
}

/// Run pure `source` on `host` to completion from inside a native (no
/// executor is reachable there; a pure statement is ready at once).
fn run_ready(host: &mut LispHost, source: &str, path: &str) {
  let scripts = Scripts::new(());
  let commands = HashMap::new();
  let mut run = std::pin::pin!(run_source_on_host(host, source, &scripts, &commands, &[], lisp_file(path)));
  let waker = futures::task::noop_waker();
  let mut cx = std::task::Context::from_waker(&waker);
  match std::future::Future::poll(run.as_mut(), &mut cx) {
    std::task::Poll::Ready(result) => {
      result.expect("the nested run");
    }
    std::task::Poll::Pending => panic!("a pure statement is ready"),
  }
}

/// A marked child dropped with `old` noted.
fn drop_child(old: &str) {
  let mut child = LispHost::new();
  child.hand_off_deprecations();
  child.deprecation_notes().note(old, "new.read_file");
}

/// Hand-off frames are per statement: a nested runner on the same thread
/// drains only its own statement's, so what the enclosing statement's
/// children left, before or after the nested run, warns at the enclosing
/// site; a child dropped inside the nested statement warns there.
#[tokio::test]
async fn a_nested_runner_never_takes_an_enclosing_statements_hand_offs() {
  let inner_warnings: Rc<std::cell::RefCell<Vec<String>>> = Rc::default();
  let seen = inner_warnings.clone();
  let mut host = host();
  host.register_native_special("outer.call", move |_| {
    drop_child("old.before_nested");
    let mut inner = LispHost::new();
    inner.collect_shell_diagnostics();
    inner.register_native_special("inner.call", |_| {
      drop_child("old.inside_nested");
      Ok(super::super::LispValue::Nil)
    });
    run_ready(&mut inner, "42\n(inner.call)\n", "unrelated-inner.tsh");
    seen.borrow_mut().extend(inner.take_shell_diagnostics());
    drop_child("old.after_nested");
    Ok(super::super::LispValue::Nil)
  });
  host.collect_shell_diagnostics();
  run(&mut host, "(outer.call)\n", lisp_file("outer.tsh")).await.unwrap();
  let message = |old: &str| format!("deprecated: `{old}` is now `new.read_file` (the old spelling is removed in the next release)");
  assert_eq!(*inner_warnings.borrow(), [format!("tsh: unrelated-inner.tsh: line 2: {}", message("old.inside_nested"))]);
  assert_eq!(
    host.take_shell_diagnostics(),
    [
      format!("tsh: outer.tsh: line 1: {}", message("old.before_nested")),
      format!("tsh: outer.tsh: line 1: {}", message("old.after_nested")),
    ]
  );
}

/// A statement frame that ends undrained (an early exit, a cancelled run)
/// passes what it holds to the frame enclosing it.
#[test]
fn an_undrained_frame_passes_its_hand_offs_to_the_enclosing_frame() {
  let outer = super::super::interp::StatementInFlight::enter();
  {
    let _inner = super::super::interp::StatementInFlight::enter();
    drop_child("old.undrained");
  }
  let handed = outer.take();
  assert_eq!(handed.iter().map(|d| d.old.as_str()).collect::<Vec<_>>(), ["old.undrained"]);
  assert!(outer.take().is_empty(), "taken once");
}
