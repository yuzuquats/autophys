//! Env as declared state — the SHELL-TIER lisp surface over the session
//! [`tento_env::EnvMap`]: `(env.set …)` writes are live for the rest of the
//! session (subsequent `(env …)` reads AND template-literal holes see them)
//! and land in the hermetic child snapshot. An integration test in its own
//! process because it installs the PROCESS-GLOBAL map (`set_global_env_map`
//! is a OnceLock; installing it inside the crate's unit-test binary would
//! flip every other test's typed resolution to map-only).

use tento_lisp_cmd::script::LispHost;

#[test]
fn env_set_is_session_live_and_reaches_the_child_snapshot() {
  // The composition-root install (what tsh's boot does): empty map + HOME.
  let map = tento_env::EnvMap::new();
  map.seed_home();
  assert!(
    tento_env::set_global_env_map(map),
    "this test process installs the global map first"
  );

  let mut host = LispHost::new();

  // Undeclared → nil (assert fails loud); the default arg covers it.
  assert!(
    host
      .eval_truthy(r#"(null? (env "TSH_ENV_STATE_TEST_X"))"#)
      .unwrap()
  );
  assert!(
    host
      .eval_truthy(r#"(= (env "TSH_ENV_STATE_TEST_X" "dflt") "dflt")"#)
      .unwrap()
  );

  // (env.set …) returns the written value and is visible to a subsequent
  // (env …) read on the same host…
  assert!(
    host
      .eval_truthy(r#"(= (env.set "TSH_ENV_STATE_TEST_X" "1") "1")"#)
      .unwrap()
  );
  assert!(
    host
      .eval_truthy(r#"(= (env "TSH_ENV_STATE_TEST_X") "1")"#)
      .unwrap()
  );
  // …and to template-literal expansion (the `${(env …)}` hole desugars to
  // str.concat over the same map read)…
  assert!(
    host
      .eval_truthy(r#"(= `X=${(env "TSH_ENV_STATE_TEST_X")}` "X=1")"#)
      .unwrap()
  );
  // …and on a DIFFERENT host in the same session (the map is process state,
  // not host state).
  let mut other = LispHost::new();
  assert!(
    other
      .eval_truthy(r#"(= (env "TSH_ENV_STATE_TEST_X") "1")"#)
      .unwrap()
  );

  // Scalar coercion: a bare integer declares as its decimal string.
  assert!(
    host
      .eval_truthy(r#"(= (env.set "TSH_ENV_STATE_TEST_N" 7) "7")"#)
      .unwrap()
  );
  // A non-scalar value is a loud error, and a missing arg too.
  assert!(
    host
      .eval_expr(r#"(env.set "TSH_ENV_STATE_TEST_BAD" (list 1))"#)
      .is_err()
  );
  assert!(
    host
      .eval_expr(r#"(env.set "TSH_ENV_STATE_TEST_BAD")"#)
      .is_err()
  );

  // The hermetic child snapshot (`env_clear().envs(...)` material) carries
  // the session-live write — a spawned child would see X=1.
  let snapshot = tento_env::hermetic_child_env().expect("map installed");
  assert!(
    snapshot.contains(&("TSH_ENV_STATE_TEST_X".to_string(), "1".to_string())),
    "env.set lands in the child snapshot: {snapshot:?}"
  );
  assert!(
    snapshot.contains(&("TSH_ENV_STATE_TEST_N".to_string(), "7".to_string())),
    "coerced write lands too: {snapshot:?}"
  );

  // Tilde ergonomics are DECLARED state too: the posix-line door
  // (`eval_posix_line` → `read_statement_with_home`) expands an unquoted
  // word-leading `~` from the map's HOME (seeded above by `seed_home`) — the
  // same injection chain the interactive prompt uses. Quoted tildes and lisp
  // strings stay literal.
  let home = tento_env::effective_var("HOME").expect("seed_home declared HOME");
  host
    .eval_posix_line("tilde_p=~/tsh-tilde-test")
    .expect("posix assignment with tilde");
  assert!(
    host
      .eval_truthy(&format!(r#"(= tilde_p "{home}/tsh-tilde-test")"#))
      .unwrap(),
    "unquoted leading ~ expands from the declared HOME"
  );
  host
    .eval_posix_line("tilde_q='~/tsh-tilde-test'")
    .expect("posix assignment with quoted tilde");
  assert!(
    host
      .eval_truthy(r#"(= tilde_q "~/tsh-tilde-test")"#)
      .unwrap(),
    "a single-quoted ~ stays literal"
  );
  // The lisp reader never tilde-expands: a lisp string is literal even with
  // HOME declared (rc files are lisp — declared paths stay as written).
  host
    .eval_stmt(r#"(let tilde_l "~/tsh-tilde-test")"#)
    .unwrap();
  assert!(
    host
      .eval_truthy(r#"(= tilde_l "~/tsh-tilde-test")"#)
      .unwrap(),
    "lisp-form strings are untouched"
  );

  // The script runner must preserve declared-HOME expansion on its routing
  // path, including a changed HOME in an already-running host.
  struct NoExternal;
  impl tento_lisp_cmd::script::ExternalCommands for NoExternal {
    fn lookup(&self, _head: &str) -> tento_lisp_cmd::script::ExternalLookup {
      tento_lisp_cmd::script::ExternalLookup::NotFound
    }
    fn run(&self, _argv: Vec<String>) -> tento_lisp_cmd::script::AsyncCommandFut {
      panic!("no external command should run")
    }
    fn suggest(&self, _typed: &str) -> Option<String> {
      None
    }
  }
  host.set_external_commands(std::rc::Rc::new(NoExternal));
  // This test isolates tilde expansion, including HOME containing spaces.
  // A bash line never names a Lisp function (argv.md I12, I13), so the
  // script's last line joins the two assignments in Lisp.
  for declared_home in ["/declared first", "/declared second"] {
    host
      .eval_stmt(&format!(r#"(env.set "HOME" "{declared_home}")"#))
      .unwrap();
    let result = futures::executor::block_on(tento_lisp_cmd::script::run_source_on_host(
      &mut host,
      "captured=~/path\nliteral='~/literal'\n(str.concat captured \"|\" literal)",
      &tento_lisp_cmd::Scripts::new(()),
      &std::collections::HashMap::new(),
      &[],
      tento_lisp_cmd::script::RunOptions::default(),
    ))
    .unwrap();
    assert_eq!(
      result,
      Some(serde_json::json!(format!("{declared_home}/path|~/literal")))
    );
  }
}
