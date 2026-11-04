//! End-to-end check of the `(@import "name" :as "ns")` form running through the
//! `.tsh` script runner with an injected `.tsh.app` search path (tento-shell
//! pilot). The namespace is an explicit `:as` value — the mount site names the
//! group. Skips when the pilot bundle isn't on `TSH_APP_PATH`.

use std::collections::HashMap;
use std::path::PathBuf;

use tento_sh::Scripts;
use tento_sh::run_str_with_apps;
use tento_sh::script::RunOptions;
use tento_sh::shell::Callable;

#[tokio::test]
async fn at_import_form_mounts_bundle() {
  let Some(path) = tento_env::test_env("TSH_APP_PATH") else {
    eprintln!("skipping at_import_form_mounts_bundle: TSH_APP_PATH not set");
    return;
  };
  let app_dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
  let scripts = Scripts::new(());
  let subs: HashMap<String, Box<dyn Callable>> = HashMap::new();
  let scripts = std::rc::Rc::new(scripts);
  let subs = std::rc::Rc::new(subs);

  // The `(@import "tento-whoop" :as "wh")` form resolves the bundle from the
  // injected search dirs and mounts its commands under the explicit `wh`
  // namespace. No command dispatch, no auth — and because import never spawns,
  // no child process.
  let ok = run_str_with_apps(
    "(@import \"tento-whoop\" :as \"wh\")\n",
    scripts.clone(),
    subs.clone(),
    &app_dirs,
    RunOptions::default(),
  )
  .await;
  assert!(ok.is_ok(), "valid @import should succeed, got: {ok:?}");

  // An unknown app surfaces a resolution error through the script runner,
  // proving the form is wired (not silently treated as plain lisp).
  let err = run_str_with_apps(
    "(@import \"does-not-exist-xyz\" :as \"x\")\n",
    scripts.clone(),
    subs.clone(),
    &app_dirs,
    RunOptions::default(),
  )
  .await;
  assert!(err.is_err(), "unknown @import should error, got: {err:?}");

  // The namespace is REQUIRED: a bare `(@import "name")` with no `:as` errors
  // (force-the-import-path — no derived/implicit namespace).
  let no_as = run_str_with_apps(
    "(@import \"tento-whoop\")\n",
    scripts.clone(),
    subs.clone(),
    &app_dirs,
    RunOptions::default(),
  )
  .await;
  assert!(
    no_as.is_err(),
    "@import without :as should error, got: {no_as:?}"
  );
}
