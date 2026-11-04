use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tento_sh::{CommandArg, RunOptions, Scripts, command, run_file, run_str};

#[derive(Clone, Default)]
pub struct TestState {
  /// Every dispatched command's argv, captured in order. Used by the
  /// fixtures to assert which commands actually ran (vs were guarded
  /// out by `(if ...)`).
  pub log: Arc<Mutex<Vec<Vec<String>>>>,
  /// Counter that fixture commands can read/increment to drive
  /// `(if ...)` branches.
  pub counter: Arc<Mutex<i64>>,
}

impl TestState {
  fn snapshot(&self) -> Vec<Vec<String>> {
    self.log.lock().unwrap().clone()
  }
}

#[derive(CommandArg, Serialize, Deserialize, Debug, Clone, Default)]
pub struct CreateArgs {
  #[serde(default)]
  name: Option<String>,
  #[serde(default)]
  count: Option<i64>,
}

#[command(name = "create", description = "create a thing")]
async fn create(state: TestState, args: CreateArgs) -> tento_sh::Result<serde_json::Value> {
  state.log.lock().unwrap().push(vec![
    "create".to_string(),
    args.name.clone().unwrap_or_default(),
  ]);
  if let Some(c) = args.count {
    *state.counter.lock().unwrap() = c;
  }
  let id = format!("id_{}", state.log.lock().unwrap().len());
  Ok(serde_json::json!({
    "id": id,
    "name": args.name.unwrap_or_default(),
    "count": *state.counter.lock().unwrap(),
  }))
}

#[derive(CommandArg, Serialize, Deserialize, Debug, Clone, Default)]
pub struct LinkArgs {
  #[serde(default)]
  parent: Option<String>,
  #[serde(default)]
  label: Option<String>,
  #[serde(default)]
  value: Option<i64>,
}

#[command(name = "link", description = "link with a parent id")]
async fn link(state: TestState, args: LinkArgs) -> tento_sh::Result<serde_json::Value> {
  state.log.lock().unwrap().push(vec![
    "link".to_string(),
    args.parent.clone().unwrap_or_default(),
    args.label.clone().unwrap_or_default(),
    args.value.map(|v| v.to_string()).unwrap_or_default(),
  ]);
  Ok(serde_json::json!({
    "ok": true,
    "parent": args.parent,
  }))
}

#[command(name = "delete", description = "delete (no-op marker)")]
async fn delete(state: TestState, _: Option<()>) -> tento_sh::Result<serde_json::Value> {
  state.log.lock().unwrap().push(vec!["delete".to_string()]);
  Ok(serde_json::json!({ "ok": true }))
}

fn scripts(state: TestState) -> Scripts<TestState> {
  Scripts::new(state)
    .add_command(create)
    .add_command(link)
    .add_command(delete)
}

#[tokio::test]
async fn basic_sequence_uses_prev_id() {
  let state = TestState::default();
  let scripts = scripts(state.clone());
  let subs = HashMap::new();
  let source = r#"
    create --name foo
    link --parent $(get $prev id) --label first
  "#;
  run_str(
    source,
    std::rc::Rc::new(scripts),
    std::rc::Rc::new(subs),
    RunOptions::default(),
  )
  .await
  .expect("script ran");
  let log = state.snapshot();
  assert_eq!(
    log,
    vec![
      vec!["create".to_string(), "foo".to_string()],
      vec![
        "link".to_string(),
        "id_1".to_string(),
        "first".to_string(),
        "".to_string(),
      ],
    ]
  );
}

#[tokio::test]
async fn named_bind_outlives_prev() {
  let state = TestState::default();
  let scripts = scripts(state.clone());
  let subs = HashMap::new();
  let source = r#"
    sheet=$(create --name first)
    create --name second
    link --parent $(get $sheet id) --label x
  "#;
  run_str(
    source,
    std::rc::Rc::new(scripts),
    std::rc::Rc::new(subs),
    RunOptions::default(),
  )
  .await
  .expect("script ran");
  let log = state.snapshot();
  // The link's parent should reference `sheet`'s id from line 1, which is "id_1",
  // even though `prev` after line 2 was the "id_2" result.
  assert_eq!(log[2][1], "id_1");
}

#[tokio::test]
async fn lisp_def_and_concat() {
  let state = TestState::default();
  let scripts = scripts(state.clone());
  let subs = HashMap::new();
  let source = r#"
    (let label (concat "row-" "x"))
    create --name $label
  "#;
  run_str(
    source,
    std::rc::Rc::new(scripts),
    std::rc::Rc::new(subs),
    RunOptions::default(),
  )
  .await
  .expect("script ran");
  let log = state.snapshot();
  assert_eq!(log, vec![vec!["create".to_string(), "row-x".to_string()]]);
}

#[tokio::test]
async fn when_guard_truthy_runs_body() {
  let state = TestState::default();
  let scripts = scripts(state.clone());
  let subs = HashMap::new();
  let source = r#"
    create --name first --count 5
    (if (> (get prev "count") 0) (delete))
  "#;
  run_str(
    source,
    std::rc::Rc::new(scripts),
    std::rc::Rc::new(subs),
    RunOptions::default(),
  )
  .await
  .expect("script ran");
  let log = state.snapshot();
  assert_eq!(log.len(), 2, "delete should have run: {:?}", log);
  assert_eq!(log[1][0], "delete");
}

#[tokio::test]
async fn when_guard_falsy_skips_body() {
  let state = TestState::default();
  let scripts = scripts(state.clone());
  let subs = HashMap::new();
  // Note: counter starts at 0 by default. The `create` command only
  // overwrites it when --count is supplied; without it, `(get prev "count")`
  // stays 0 and the guard skips. (We avoid `--count 0` here because
  // tento-sh's argv parser turns the literal "0" into bool `false`.)
  let source = r#"
    create --name first
    (if (> (get prev "count") 0) (delete))
  "#;
  run_str(
    source,
    std::rc::Rc::new(scripts),
    std::rc::Rc::new(subs),
    RunOptions::default(),
  )
  .await
  .expect("script ran");
  let log = state.snapshot();
  assert_eq!(log.len(), 1, "delete should NOT have run: {:?}", log);
}

#[tokio::test]
async fn run_file_smoke_test() {
  // Exercises the on-disk path through `run_file`, using one of the
  // fixtures shipped under `tests/fixtures/tsh/`.
  let state = TestState::default();
  let scripts = scripts(state.clone());
  let subs = HashMap::new();
  let path =
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tsh/named_bind.tsh");
  run_file(
    &path,
    std::rc::Rc::new(scripts),
    std::rc::Rc::new(subs),
    RunOptions::default(),
  )
  .await
  .expect("script ran");
  let log = state.snapshot();
  assert_eq!(log.len(), 3);
  assert_eq!(log[2][0], "link");
  assert_eq!(log[2][1], "id_1");
}

#[tokio::test]
async fn error_halts_subsequent_lines() {
  let state = TestState::default();
  let scripts = scripts(state.clone());
  let subs = HashMap::new();
  let source = r#"
    create --name first
    nonexistent_command --foo bar
    create --name third
  "#;
  let err = run_str(
    source,
    std::rc::Rc::new(scripts),
    std::rc::Rc::new(subs),
    RunOptions::default(),
  )
  .await
  .expect_err("script must fail");
  assert!(
    err.line >= 2,
    "error should point at the failing line: {:?}",
    err
  );
  let log = state.snapshot();
  // Line 1 ran; line 2 errored; line 3 must NOT have run.
  let names: Vec<&str> = log.iter().map(|v| v[0].as_str()).collect();
  assert_eq!(
    names,
    vec!["create"],
    "third line must not have run: {:?}",
    log
  );
}

#[tokio::test]
async fn new_grammar_capture_and_field_access() {
  let state = TestState::default();
  let scripts = scripts(state.clone());
  let subs = HashMap::new();
  // Unified posix grammar: `name=$(cmd)` capture + `$(get $name field)` access.
  let source = r#"
    sheet=$(create --name first)
    create --name second
    link --parent $(get $sheet id) --label x
  "#;
  run_str(
    source,
    std::rc::Rc::new(scripts),
    std::rc::Rc::new(subs),
    RunOptions::default(),
  )
  .await
  .expect("script ran");
  let log = state.snapshot();
  // The link's parent references `sheet`'s id from line 1 ("id_1"), not `prev`
  // (the second create, "id_2") — capture outlives prev and field access works.
  assert_eq!(log[2][1], "id_1", "captured field access: {:?}", log);
}

#[tokio::test]
async fn new_grammar_if_guard_reads_prev() {
  let state = TestState::default();
  let scripts = scripts(state.clone());
  let subs = HashMap::new();
  // A lisp `(if …)` guard (replacing the retired `(when …)`) reading the
  // previous command's value via `(get prev "field")`.
  let source = r#"
    create --name first --count 5
    (if (> (get prev "count") 0) (delete))
  "#;
  run_str(
    source,
    std::rc::Rc::new(scripts),
    std::rc::Rc::new(subs),
    RunOptions::default(),
  )
  .await
  .expect("script ran");
  let log = state.snapshot();
  assert_eq!(log.len(), 2, "guard truthy -> delete ran: {:?}", log);
  assert_eq!(log[1][0], "delete");
}

#[tokio::test]
async fn one_shot_argv_resolves_command() {
  // The CLI one-shot path: pre-split argv -> `(create :name "foo")` -> eval
  // against a host whose commands are env natives. The `--name` lowers to the
  // `:name` keyword (the same node the lisp call reads to), so it binds as a
  // named option, not a positional.
  let state = TestState::default();
  let scripts = std::rc::Rc::new(scripts(state.clone()));
  let subs = std::rc::Rc::new(HashMap::new());
  let mut host = tento_sh::script::LispHost::new();
  host.register_commands(scripts, subs);
  let v = host
    .eval_posix_argv(vec!["create".into(), "--name".into(), "foo".into()])
    .expect("argv evaluates");
  assert_eq!(v["name"], "foo", "got: {v}");
  assert_eq!(state.snapshot().len(), 1, "create ran once");
}

#[tokio::test]
async fn async_argv_dispatch_awaits_command() {
  // The top-level async dispatch path (`eval_posix_argv_async`): a registered
  // command is routed through the async table and its future is `.await`ed
  // directly — the seam the TUI uses instead of the retired `run_loop::exec`,
  // so a genuinely-async daemon command would resolve rather than error.
  let state = TestState::default();
  let scripts = std::rc::Rc::new(scripts(state.clone()));
  let subs = std::rc::Rc::new(HashMap::new());
  let mut host = tento_sh::script::LispHost::new();
  host.register_commands(scripts, subs);
  let v = host
    .eval_posix_argv_async(vec!["create".into(), "--name".into(), "foo".into()])
    .await
    .expect("argv evaluates");
  assert_eq!(v["name"], "foo", "got: {v}");
  assert_eq!(
    state.snapshot().len(),
    1,
    "create ran once via async dispatch"
  );
}

#[tokio::test]
async fn async_argv_dispatch_unknown_command_suggests() {
  // An unknown command head through the async dispatch path yields the
  // structured `CommandNotFound` (nearest-match + available) the retired
  // `exec` produced — not the env's bare "undefined symbol".
  let state = TestState::default();
  let scripts = std::rc::Rc::new(scripts(state.clone()));
  let subs = std::rc::Rc::new(HashMap::new());
  let mut host = tento_sh::script::LispHost::new();
  host.register_commands(scripts, subs);
  let err = host
    .eval_posix_argv_async(vec!["creat".into(), "--name".into(), "x".into()])
    .await
    .expect_err("unknown command errors");
  let msg = err.to_string();
  assert!(msg.contains("creat"), "names the typo: {msg}");
  assert!(
    msg.contains("did you mean `create`?"),
    "suggests nearest: {msg}"
  );
}

#[tokio::test]
async fn line_async_not_found_and_dispatch() {
  // The REPL line path (`eval_posix_line_async`): an unknown command head gets
  // the structured suggestion, and a valid line dispatches through the async seam.
  let state = TestState::default();
  let scripts = std::rc::Rc::new(scripts(state.clone()));
  let subs = std::rc::Rc::new(HashMap::new());
  let mut host = tento_sh::script::LispHost::new();
  host.register_commands(scripts, subs);
  let err = host
    .eval_posix_line_async("creat --name x")
    .await
    .expect_err("unknown head errors");
  assert!(
    err.to_string().contains("did you mean `create`?"),
    "got: {err}"
  );
  let v = host
    .eval_posix_line_async("create --name foo")
    .await
    .expect("valid line dispatches");
  assert_eq!(v["name"], "foo", "got: {v}");
  assert_eq!(state.snapshot().len(), 1, "create ran once");
}
