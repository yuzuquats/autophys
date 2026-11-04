use tento_app::tsh_app::TshApp;

#[test]
fn an_embedder_must_declare_its_runtime_before_loading_a_floor() {
  let temp = tempfile::tempdir().unwrap();
  let bundle = temp.path().join("floor.tsh.app");
  std::fs::create_dir(&bundle).unwrap();
  std::fs::write(
    bundle.join("manifest.json"),
    serde_json::json!({
      "schema":"tsh.app/v1", "name":"floor", "version":"1", "entrypoint":"bin/floor",
      "requires_tsh":"0.1.57"
    })
    .to_string(),
  )
  .unwrap();
  let error = TshApp::load(&bundle).unwrap_err().to_string();
  assert!(
    error.contains("cannot determine running tsh version"),
    "{error}"
  );
  assert!(error.contains("0.1.57"), "{error}");
}
