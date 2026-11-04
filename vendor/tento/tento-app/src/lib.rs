//! The `.tsh.app` bundle/transport layer, carved out of `tento-lisp-cmd`.
//!
//! Discovers and dispatches `*.tsh.app` command-group bundles out-of-process
//! (the "the binary is the plugin" mechanism), and provides the `(@import …)`
//! resolver (`TshAppResolver`) plus the `app_dirs`-based run wrappers that build
//! a resolver and call the engine's generic `*_with_resolver` entry points. The
//! engine (`tento-lisp-cmd`) carries no bundle reference; the facade `tento-sh`
//! re-exports both crates.

// The daemon transport rides a Unix socket (serve side and the RPC client's
// connect path); a Windows port maps it onto named pipes. Until then those
// halves — not the bundle layer or the JSON-RPC vocabulary — are Unix-only.
pub mod auth;
pub mod app_env;
pub mod daemon_rpc;
pub mod foreground;
pub mod remote_group;
#[cfg(unix)]
pub mod serve;
pub mod tsh_app;

pub use daemon_rpc::ServiceLease;
pub use remote_group::RemoteGroup;
#[cfg(unix)]
pub use serve::serve_scripts;
pub use tsh_app::{TshAppResolver, import_app, lisp_host_with_apps, resolver_for};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use tento_lisp_cmd::run_loop::LineReader;
use tento_lisp_cmd::script::{LispHost, RunOptions, TshScriptError};
use tento_lisp_cmd::shell::Callable;
use tento_lisp_cmd::{Error, Scripts};

/// REPL / one-shot dispatch with a `.tsh.app` search path (`@import` enabled).
/// Builds a `TshAppResolver` and calls the engine's generic `run_with_resolver`.
pub async fn run_with_apps<Info>(
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  app_dirs: &[PathBuf],
  line_reader: &mut (impl LineReader + ?Sized),
) -> Result<(), Error>
where
  Info: Clone + 'static,
{
  tento_lisp_cmd::run_loop::run_with_resolver(
    scripts,
    subcommands,
    resolver_for(app_dirs.to_vec()),
    None,
    line_reader,
  )
  .await
}

/// Run an in-memory `.tsh` script with a `.tsh.app` search path.
pub async fn run_str_with_apps<Info: Clone + 'static>(
  source: &str,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  app_dirs: &[PathBuf],
  options: RunOptions,
) -> Result<(), TshScriptError> {
  tento_lisp_cmd::script::run_str_with_resolver(
    source,
    scripts,
    subcommands,
    resolver_for(app_dirs.to_vec()),
    options,
  )
  .await
}

/// Like [`run_str_with_apps`] but registers caller natives first and returns the
/// kept-alive host (the startup-rc seam).
pub async fn run_str_with_apps_setup<Info, F>(
  source: &str,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  app_dirs: &[PathBuf],
  options: RunOptions,
  setup: F,
) -> Result<LispHost, TshScriptError>
where
  Info: Clone + 'static,
  F: FnOnce(&mut LispHost),
{
  tento_lisp_cmd::script::run_str_with_resolver_setup(
    source,
    scripts,
    subcommands,
    resolver_for(app_dirs.to_vec()),
    options,
    setup,
  )
  .await
}

/// Run a `.tsh` file (with a command prefix) with a `.tsh.app` search path.
pub async fn run_file_with_prefix_and_apps<Info: Clone + 'static>(
  path: impl AsRef<Path>,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  prefix: &[String],
  app_dirs: &[PathBuf],
  options: RunOptions,
) -> Result<(), TshScriptError> {
  tento_lisp_cmd::script::run_file_with_prefix_and_resolver(
    path,
    scripts,
    subcommands,
    prefix,
    resolver_for(app_dirs.to_vec()),
    options,
  )
  .await
}

#[cfg(test)]
mod tests {
  use tento_lisp_cmd::script::{LispHost, LispHostError};

  /// A bundle's `rc/*.tshrc` — one `(bundle (m) …)` form — loads at import:
  /// its defines are reachable ONLY as `<alias>.<name>` for the exported set,
  /// an unwrapped file is rejected with the teaching error, bare
  /// `lane.declare` inside the body teaches the m-send, and a second import
  /// of the same file is a no-op (ES-module "once").
  #[test]
  fn bundle_rc_mounts_exports_under_the_alias() {
    let dir = std::env::temp_dir().join(format!("tsh-rc-load-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let bundle = dir.join("fix.tsh.app");
    std::fs::create_dir_all(bundle.join("rc")).unwrap();
    std::fs::write(
      bundle.join("manifest.json"),
      r#"{"schema":"tsh.app/v1","name":"fix","version":"0","entrypoint":"bin/fix","transport":"oneshot","commands":{"hello":{}}}"#,
    )
    .unwrap();
    std::fs::write(
      bundle.join("rc/macro.tshrc"),
      "(bundle (m)\n  (define (greet who) (str.concat \"hi \" who))\n  (define (hidden) \"secret-helper\")\n  (m.export 'greet))\n",
    )
    .unwrap();
    let app = crate::tsh_app::TshApp::load(&bundle).expect("bundle loads");

    let mut host = LispHost::new();
    crate::tsh_app::import_app(&mut host, &app, "fx");
    host.process_pending_rc().expect("rc loads");
    let got = host.eval_to_json("(fx.greet \"moo\")").expect("macro runs");
    assert_eq!(got, serde_json::json!("hi moo"));
    // Non-exported defs stay in the bundle's own scope.
    let err = host.eval_to_json("(hidden)").expect_err("not leaked bare");
    assert!(format!("{err}").contains("hidden"), "got: {err}");
    let err = host.eval_to_json("(fx.hidden)").expect_err("not exported");
    assert!(format!("{err}").contains("fx.hidden"), "got: {err}");
    // Evaluated once, mounted per alias: a second import of the SAME file
    // under another alias re-mounts the cached exports without re-running.
    crate::tsh_app::import_app(&mut host, &app, "fx2");
    host
      .process_pending_rc()
      .expect("aliased re-import mounts from cache");
    let got = host
      .eval_to_json("(fx2.greet \"moo\")")
      .expect("alias mounts");
    assert_eq!(got, serde_json::json!("hi moo"));

    // An UNWRAPPED rc file is rejected with the teaching error.
    std::fs::write(bundle.join("rc/macro.tshrc"), "(define (greet w) w)\n").unwrap();
    let app = crate::tsh_app::TshApp::load(&bundle).expect("bundle reloads");
    let mut fresh = LispHost::new();
    crate::tsh_app::import_app(&mut fresh, &app, "fx");
    let err = fresh.process_pending_rc().expect_err("unwrapped refused");
    assert!(format!("{err}").contains("(bundle (m)"), "got: {err}");

    // Bare `lane.declare` inside the body fails AT LOAD, naming the m-send.
    std::fs::write(
      bundle.join("rc/macro.tshrc"),
      "(bundle (m) (lane.declare \"x\" \":handler\" \"term\"))\n",
    )
    .unwrap();
    let app = crate::tsh_app::TshApp::load(&bundle).expect("bundle reloads");
    let mut fresh = LispHost::new();
    crate::tsh_app::import_app(&mut fresh, &app, "fx");
    let err = fresh
      .process_pending_rc()
      .expect_err("bare lane.declare refused");
    let text = format!("{err}");
    assert!(text.contains("m.lane.declare"), "teaches the send: {text}");

    std::fs::remove_dir_all(&dir).ok();
  }

  /// A plain host SKIPS a bundle's queued ui/*.tsh (no session UI layer); a
  /// ui-enabled host without the natives errors — proving the skip is the gate.
  #[test]
  fn pending_ui_is_skipped_without_a_session_ui_layer() {
    let dir = std::env::temp_dir().join(format!("tsh-ui-skip-{}", std::process::id()));
    let bundle = dir.join("fix.tsh.app");
    std::fs::create_dir_all(bundle.join("ui")).unwrap();
    std::fs::write(
      bundle.join("manifest.json"),
      r#"{"schema":"tsh.app/v1","name":"fix","version":"0","entrypoint":"bin/fix","transport":"oneshot","commands":{"hello":{}}}"#,
    )
    .unwrap();
    std::fs::write(
      bundle.join("ui/fix.tsh"),
      "(defmode \"agent\" :on-submit (lambda (l) l))\n",
    )
    .unwrap();
    let app = crate::tsh_app::TshApp::load(&bundle).expect("bundle loads");

    let mut host = LispHost::new();
    crate::tsh_app::import_app(&mut host, &app, "fix");
    host
      .process_pending_ui()
      .expect("plain host skips queued ui");

    let mut enabled = LispHost::new();
    crate::tsh_app::import_app(&mut enabled, &app, "fix");
    enabled.enable_import_ui();
    let err = enabled
      .process_pending_ui()
      .expect_err("ui eval needs the session natives");
    assert!(err.to_string().contains("defmode"), "got: {err}");

    std::fs::remove_dir_all(&dir).ok();
  }

  /// `import_app` installs the manifest's dotted command symbols and spawns
  /// nothing; the bare symbol resolves to a function (reported NonScalar).
  #[test]
  fn import_installs_dotted_symbols_without_spawning() {
    let Some(path) = tento_env::test_env("TSH_APP_PATH") else {
      eprintln!("skipping: TSH_APP_PATH not set");
      return;
    };
    let dirs: Vec<std::path::PathBuf> = std::env::split_paths(&path).collect();
    let app = match crate::tsh_app::resolve("tento-whoop", &dirs) {
      Ok(a) => a,
      Err(e) => {
        eprintln!("skipping: {e}");
        return;
      }
    };
    let mut host = LispHost::new();
    crate::tsh_app::import_app(&mut host, &app, "whoop");
    match host.eval_expr("whoop.user-profile") {
      Err(LispHostError::NonScalar(_)) => {}
      other => panic!("expected NonScalar (installed function), got: {other:?}"),
    }
  }
}
