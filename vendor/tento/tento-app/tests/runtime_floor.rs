use tento_app::tsh_app::{TshApp, lisp_host_with_apps, set_runtime_tsh_version};

#[test]
fn mount_refuses_a_future_tsh_floor_before_running_bundle_code() {
  set_runtime_tsh_version("0.1.57");
  let temp = tempfile::tempdir().unwrap();
  let bundle = temp.path().join("future.tsh.app");
  std::fs::create_dir_all(bundle.join("rc")).unwrap();
  std::fs::write(bundle.join("rc/future.tshrc"), "(let loaded true)").unwrap();
  let manifest = |floor: &str| {
    serde_json::json!({"schema":"tsh.app/v1", "name":"future",
    "version":"1.0.0", "entrypoint":"rc/future.tshrc", "rc":["rc/future.tshrc"],
    "requires_tsh":floor})
  };
  std::fs::write(
    bundle.join("manifest.json"),
    manifest(">=0.1.58").to_string(),
  )
  .unwrap();
  let mut host = lisp_host_with_apps(vec![temp.path().into()]);
  let error = host
    .eval_stmt(r#"(@import "future" :as "future")"#)
    .unwrap_err()
    .to_string();
  assert!(
    error.contains("requires tsh >=0.1.58; running tsh 0.1.57"),
    "{error}"
  );
  assert!(host.eval_value("future.loaded").is_err());
  std::fs::write(
    bundle.join("manifest.json"),
    manifest(">=0.1.57").to_string(),
  )
  .unwrap();
  assert!(TshApp::load(&bundle).is_ok());
  std::fs::write(
    bundle.join("manifest.json"),
    manifest(">=0.1.58").to_string(),
  )
  .unwrap();
  assert!(TshApp::load(&bundle).is_err());
  let mut null_manifest = manifest(">=0.1.57");
  null_manifest["requires_tsh"] = serde_json::Value::Null;
  std::fs::write(bundle.join("manifest.json"), null_manifest.to_string()).unwrap();
  let error = TshApp::load(&bundle).unwrap_err().to_string();
  assert!(error.contains("expected a string"), "{error}");
}
