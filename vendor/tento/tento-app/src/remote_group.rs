//! Mount a `.tsh.app` bundle as a shell namespace.
//!
//! [`crate::tsh_app::resolve`] + [`crate::tsh_app::discover_apps`] find bundles
//! on disk; the Lisp `@import` path already dispatches their commands. This is
//! the **CLI/REPL** counterpart: a [`RemoteGroup`] wraps a resolved [`TshApp`]
//! and implements [`Callable`], so the core can mount a discovered bundle under
//! its namespace (via [`crate::Shell::mount_callable`]) with **no compile-time
//! dependency** on the group. `tsh whoop user-profile` then dispatches to
//! `tento-whoop.tsh.app/bin/tento-whoop` exactly as the standalone binary would
//! — the "bash, not a Swiss-army-knife" goal.

use std::pin::Pin;
use std::rc::Rc;

use colored::Colorize;
use futures::Future;
use serde_json::Value;

use crate::daemon_rpc::ServiceLease;
use crate::tsh_app::{LazyValue, TshApp};
use tento_lisp_cmd::Error;
use tento_lisp_cmd::shape::ResultDoc;
use tento_lisp_cmd::shell::Callable;

/// The loader's half of FP-13: a bundle prints plain data for `<cmd> --json`
/// (a `Table<T>` is its bare rows), and its manifest records what the command
/// declared under `result`. Note the two together so the display that draws
/// this value for a person applies the declared shape
/// ([`tento_lisp_cmd::shape::take_declared_view`]). `value` itself — what Lisp
/// callers and `--json` get — is untouched; a command that declares no shape,
/// or a value that names its own, is not noted.
pub(crate) fn note_declared_result(app: &TshApp, command: &str, value: &Value) {
  let Some(result) = app
    .manifest
    .commands
    .get(command)
    .and_then(|doc| doc.value().get("result"))
  else {
    return;
  };
  if result.get("shape").is_none() && result.get("cases").is_none() {
    return;
  }
  match serde_json::from_value::<ResultDoc>(result.clone()) {
    Ok(doc) => tento_lisp_cmd::shape::note_declared_result(value, &doc),
    Err(error) => tracing::debug!(app = %app.name, command, %error, "unreadable declared result"),
  }
}

/// A `.tsh.app` bundle mounted as a shell namespace. The `namespace` is the
/// **explicit mount-site choice** (the `:as` value from the importing `.tshrc`),
/// not the bundle's manifest — the mount site names the group.
pub struct RemoteGroup {
  app: Rc<TshApp>,
  namespace: String,
  /// The engine's session-service lease (`Some` inside a live tsh session),
  /// used only when this bundle's `daemon` transport declares `scope = session`
  /// — it locates the per-session socket and owns the spawned child. `None` for
  /// a bare CLI/REPL mount: a session-scoped call then errors clearly.
  lease: Option<Rc<dyn ServiceLease>>,
}

impl RemoteGroup {
  /// Mount `app` under `namespace` with no session-service lease (bare CLI/REPL
  /// context — session-scoped daemon groups error clearly on call).
  pub fn new(app: TshApp, namespace: impl Into<String>) -> Self {
    RemoteGroup {
      app: Rc::new(app),
      namespace: namespace.into(),
      lease: None,
    }
  }

  /// Mount `app` under `namespace` carrying the engine's session-service
  /// `lease`, so a `scope = session` daemon group leases + owns its service
  /// child under the session.
  pub fn with_lease(
    app: TshApp,
    namespace: impl Into<String>,
    lease: Option<Rc<dyn ServiceLease>>,
  ) -> Self {
    RemoteGroup {
      app: Rc::new(app),
      namespace: namespace.into(),
      lease,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn pending_dispatch_keeps_the_mounted_descriptor_alive() {
    let app = TshApp {
      name: "fixture".into(),
      dir: "/nonexistent".into(),
      bin: "/nonexistent/bin/fixture".into(),
      manifest: std::rc::Rc::new(serde_json::from_value(json!({
        "schema": "tsh.app/v1", "name": "fixture", "version": "1",
        "entrypoint": "bin/fixture", "commands": {"run": {"args": [1, 2, 3]}}
      }))
      .unwrap()),
      child_env: Default::default(),
    };
    let group = RemoteGroup::new(app, "fixture");
    let descriptor = Rc::downgrade(&group.app);
    let future = group
      .call_with_argv(vec!["fixture".into(), "run".into()])
      .unwrap();
    drop(group);
    assert!(
      descriptor.upgrade().is_some(),
      "pending call must reuse its mounted descriptor"
    );
    drop(future);
    assert!(
      descriptor.upgrade().is_none(),
      "cancelled call must release its descriptor"
    );
  }

  #[test]
  #[ignore = "controlled performance probe; needs TSH_PERF_MANIFEST"]
  fn repeated_bundle_dispatch_bench() {
    let path = std::path::PathBuf::from(std::env::var("TSH_PERF_MANIFEST").unwrap());
    let text = std::fs::read_to_string(path).unwrap();
    let mut manifest = TshApp::parse_manifest(&text, "fixture").unwrap();
    manifest.transport = "oneshot".into();
    manifest.transports.clear();
    manifest.daemon = None;
    let app = TshApp {
      name: "fixture".into(),
      dir: "/nonexistent".into(),
      // A harmless real process; arguments ignored, empty JSON channel => null.
      bin: "/usr/bin/true".into(),
      manifest: std::rc::Rc::new(manifest),
      child_env: Default::default(),
    };
    let group = RemoteGroup::new(app, "fixture");
    let argv = || vec!["fixture".into(), "probe".into()];
    let prepare = std::time::Instant::now();
    for _ in 0..2_000 {
      drop(std::hint::black_box(group.call_with_argv(argv()).unwrap()));
    }
    let prepare_us = prepare.elapsed().as_micros();
    let run = std::time::Instant::now();
    for _ in 0..500 {
      let value = futures::executor::block_on(group.call_with_argv(argv()).unwrap()).unwrap();
      assert!(value.is_null());
    }
    eprintln!(
      "dispatch_bench {}",
      json!({"prepare_us": prepare_us, "run_us": run.elapsed().as_micros(), "calls": 500})
    );
  }

  /// A oneshot child prints bare rows for a command whose manifest declares
  /// `table/v1`: the caller gets the rows unchanged, and the display of those
  /// rows draws the declared table with its lowercase, toned cells.
  #[test]
  fn a_oneshot_result_draws_through_its_declared_shape() {
    let dir = std::env::temp_dir().join(format!("declared-result-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    let bin = dir.join("bin/fixture");
    std::fs::write(&bin, "#!/bin/sh\necho '[{\"host\":\"a\",\"health\":\"failing\"}]'\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let health = json!({"kind": "enum", "name": "Health", "cases": ["healthy", "failing"],
      "views": [{"case": "failing", "label": "✗ failing", "style": "status.error"}]});
    let manifest = serde_json::from_value(json!({
      "schema": "tsh.app/v1", "name": "fixture", "version": "1", "entrypoint": "bin/fixture",
      "commands": {
        "status": {"type": "command.doc/v1", "result": {"shape": "table/v1", "type": {"kind": "list", "of":
          {"kind": "record", "name": "Row", "fields": [
            {"name": "host", "type": {"kind": "string"}},
            {"name": "health", "type": health}]}}}},
        "raw": {"type": "command.doc/v1"},
      }
    }))
    .unwrap();
    let app = TshApp {
      name: "fixture".into(),
      dir: dir.clone(),
      bin,
      manifest: std::rc::Rc::new(manifest),
      child_env: Default::default(),
    };
    let rows = app.call_oneshot_args("status", &[]).unwrap();
    assert_eq!(rows, json!([{"host": "a", "health": "failing"}]), "the caller gets the data");
    let shape = tento_lisp_cmd::shape::take_declared_view(&rows).expect("declared shape");
    assert_eq!(shape["shape"], "table/v1");
    assert_eq!(shape["columns"][1]["header"], "health");
    assert_eq!(shape["rows"][0][1], json!({"text": "✗ failing", "style": "status.error"}));
    // A command that declares nothing draws as before.
    let same = app.call_oneshot_args("raw", &[]).unwrap();
    assert!(tento_lisp_cmd::shape::take_declared_view(&same).is_none());
    let _ = std::fs::remove_dir_all(dir);
  }

  #[tokio::test(flavor = "current_thread")]
  async fn styled_root_help_preserves_discovery_without_spawning() {
    let manifest: crate::tsh_app::AppManifest = serde_json::from_value(json!({
      "schema": "tsh.app/v1", "name": "demo", "version": "1",
      "entrypoint": "bin/demo",
      "commands": {"list": {"type": "command.doc/v1", "description": "List items"}},
      "help": {"shape": "term.block/v1", "rows": [], "entries": {"fake": {}}},
    }))
    .unwrap();
    let mut app = TshApp {
      name: "demo".into(),
      dir: "/nonexistent".into(),
      bin: "/nonexistent/bin/demo".into(),
      manifest: std::rc::Rc::new(manifest),
      child_env: Default::default(),
    };
    let value = RemoteGroup::new(app.clone(), "demo")
      .call_with_argv(vec!["demo".into(), "--help".into()])
      .unwrap()
      .await
      .unwrap();
    assert_eq!(value["shape"], "term.block/v1");
    assert_eq!(value["type"], "command.index/v1");
    assert_eq!(value["entries"]["list"]["description"], "List items");
    assert!(value["entries"].get("fake").is_none());
    std::rc::Rc::make_mut(&mut app.manifest).help = None;
    let fallback = RemoteGroup::new(app, "demo").help_value();
    assert_eq!(fallback["list"]["description"], "List items");
  }
}

impl Callable for RemoteGroup {
  /// Dispatch a CLI/REPL invocation to the bundle binary. `argv[0]` is the
  /// mount namespace (the key this group was mounted under — the top-level argv
  /// door (`LispHost::eval_posix_argv_async`) hands the subcommand its own name
  /// at `argv[0]`, like every other `Callable`). `argv[1]` is the command; the
  /// rest forwards **verbatim**
  /// to the bundle (`bin <cmd> --json <rest…>`), so a tsh invocation is
  /// byte-identical to the standalone binary.
  ///
  /// A bare namespace (`tsh whoop`) or a namespace-level `--help` returns the
  /// manifest command tree without spawning anything. The returned value is the
  /// bundle's `--json` output (raw data or a tagged render shape); the run loop
  /// renders it (a `table/v1` to text for humans, raw JSON under `--json`).
  fn call_with_argv(
    &self,
    argv: Vec<String>,
  ) -> tento_lisp_cmd::Result<Pin<Box<dyn Future<Output = tento_lisp_cmd::Result<Value>>>>> {
    // No command, or a namespace-level `--help`: show the command tree (no spawn).
    let command = match argv.get(1) {
      Some(c) if c != "--help" && c != "-h" => c.clone(),
      _ => {
        let tree = self.help_value();
        return Ok(Box::pin(async move { Ok(tree) }));
      }
    };
    let extra: Vec<String> = argv.into_iter().skip(2).collect();
    // Per-command transport resolution + dispatch is shared with the Lisp
    // `@import` mounts ([`crate::tsh_app::app_to_import_mounts`]) via
    // [`TshApp::dispatch_argv`] — one place decides `oneshot`/`streaming`/
    // `daemon` (a shape-returning command routes oneshot so tsh captures its
    // JSON and renders in-process; a `scope = session` daemon leases its child
    // through `self.lease`). The future blocks the executor for a oneshot/
    // streaming child's lifetime; `spawn_blocking` is a later refinement.
    let fut = Rc::clone(&self.app).dispatch_shared_argv(command, extra, self.lease.clone());
    Ok(Box::pin(async move {
      fut.await.map_err(|e| Error::Other(anyhow::anyhow!("{e}")))
    }))
  }

  fn print_help(&self, _include_args: bool) {
    let ns = &self.namespace;
    println!("\nUsage: {ns} <command> [options]\n");
    println!("{}", "Commands:".bold());
    for (name, meta) in &self.app.manifest.commands {
      let desc = meta
        .value()
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
      println!("    {} {}", name.bold(), desc);
    }
    println!();
  }

  /// The manifest's per-command metadata *is* the help-tree node shape
  /// (`{ command → { description, args? } }`), so the bundled spec passes
  /// straight through to the same renderer `help`/`<ns> --help` use — no exec.
  fn help_value(&self) -> Value {
    let map: serde_json::Map<String, Value> = self
      .app
      .manifest
      .commands
      .iter()
      .map(|(k, v)| (k.clone(), v.value().clone()))
      .collect();
    if let Some(Value::Object(help)) = self.app.manifest.help.as_ref().map(LazyValue::value) {
      if help.get("shape").and_then(Value::as_str).is_some() {
        let mut value = help.clone();
        value.insert("type".into(), Value::String("command.index/v1".into()));
        value.insert("entries".into(), Value::Object(map));
        return Value::Object(value);
      }
    }
    Value::Object(map)
  }
}

/// A [`RemoteGroup`] that resolves its bundle on first use. Mounted in place
/// of an eager group by a DETACHED shell for a bundle that
/// [`crate::tsh_app::bundle_is_script_free`] — so `tsh version` no longer
/// parses seven manifests to mount command groups it never calls. The first
/// call (or help request) resolves; a bundle that fails to resolve then
/// reports the same error its eager mount would have printed at startup.
pub struct LazyRemoteGroup {
  bundle: String,
  search: Vec<std::path::PathBuf>,
  namespace: String,
  lease: Option<Rc<dyn ServiceLease>>,
  envs: Option<crate::app_env::ImportEnvs>,
  inner: std::cell::OnceCell<Result<RemoteGroup, String>>,
}

impl LazyRemoteGroup {
  pub fn new(
    bundle: impl Into<String>,
    search: Vec<std::path::PathBuf>,
    namespace: impl Into<String>,
    lease: Option<Rc<dyn ServiceLease>>,
  ) -> Self {
    LazyRemoteGroup {
      bundle: bundle.into(),
      search,
      namespace: namespace.into(),
      lease,
      envs: None,
      inner: std::cell::OnceCell::new(),
    }
  }

  /// Bind through the import site's handle in `envs` once resolved, so the
  /// rc's `<ns>.env.bind` reaches this word mount (see
  /// [`crate::app_env::ImportEnvs`]).
  pub fn sharing_import_envs(mut self, envs: crate::app_env::ImportEnvs) -> Self {
    self.envs = Some(envs);
    self
  }

  fn group(&self) -> Result<&RemoteGroup, Error> {
    self
      .inner
      .get_or_init(|| {
        crate::tsh_app::resolve(&self.bundle, &self.search)
          .map(|mut app| {
            if let Some(envs) = &self.envs {
              app.child_env = envs.for_import(&self.namespace, &app.dir);
            }
            RemoteGroup::with_lease(app, self.namespace.clone(), self.lease.clone())
          })
          .map_err(|e| format!("@import {} :as {} — {e}", self.bundle, self.namespace))
      })
      .as_ref()
      .map_err(|e| Error::Other(anyhow::anyhow!("{e}")))
  }

  #[cfg(test)]
  pub fn is_resolved(&self) -> bool {
    self.inner.get().is_some()
  }
}

impl Callable for LazyRemoteGroup {
  fn call_with_argv(
    &self,
    argv: Vec<String>,
  ) -> tento_lisp_cmd::Result<Pin<Box<dyn Future<Output = tento_lisp_cmd::Result<Value>>>>> {
    self.group()?.call_with_argv(argv)
  }

  fn print_help(&self, include_args: bool) {
    match self.group() {
      Ok(group) => group.print_help(include_args),
      Err(e) => eprintln!("{e}"),
    }
  }

  fn help_value(&self) -> Value {
    match self.group() {
      Ok(group) => group.help_value(),
      Err(e) => Value::String(e.to_string()),
    }
  }
}

#[cfg(test)]
mod lazy_group_tests {
  use super::*;

  /// A lazy group touches nothing at construction and resolves on the first
  /// call; a missing bundle surfaces then, as the eager mount's error text.
  #[tokio::test(flavor = "current_thread")]
  async fn a_lazy_group_resolves_on_first_call() {
    let root = std::env::temp_dir().join(format!("lazy-group-{}", std::process::id()));
    let dir = root.join("lazy-fixture.tsh.app");
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::write(
      dir.join("manifest.json"),
      r#"{"schema":"tsh.app/v1","name":"lazy-fixture","version":"1","entrypoint":"bin/x",
          "commands":{"list":{"type":"command.doc/v1","description":"List items"}}}"#,
    )
    .unwrap();
    let group = LazyRemoteGroup::new("lazy-fixture", vec![root.clone()], "lz", None);
    assert!(!group.is_resolved(), "construction resolves nothing");
    let help = group.help_value();
    assert!(group.is_resolved(), "the first use resolves the bundle");
    assert!(help.to_string().contains("list"), "help comes from the resolved manifest: {help}");
    let missing = LazyRemoteGroup::new("no-such-bundle", vec![root.clone()], "nope", None);
    let err = missing.call_with_argv(vec!["nope".into(), "x".into()]).err().expect("unresolvable");
    assert!(err.to_string().contains("@import no-such-bundle :as nope"), "{err}");
    let _ = std::fs::remove_dir_all(root);
  }
}
