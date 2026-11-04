//! Packaged bundle boundaries: dependency resolution, Lisp module exports and
//! the exact fleet/auth consumer sources, with no network or credentials.
use serde_json::{Value, json};
use std::{
  cell::RefCell,
  path::{Path, PathBuf},
  rc::Rc,
};
use tento_lisp_cmd::script::{LispHost, value_from_json, value_to_json};

fn bundle(root: &Path, name: &str, version: &str, requirements: Value, source: &str) -> PathBuf {
  let dir = root.join(format!("{name}.tsh.app"));
  std::fs::create_dir_all(dir.join("rc")).unwrap();
  std::fs::write(dir.join("rc/main.tshrc"), source).unwrap();
  std::fs::write(
    dir.join("manifest.json"),
    json!({
      "schema":"tsh.app/v1", "name":name, "version":version,
      "entrypoint":"rc/main.tshrc", "commands":{}, "dependencies":requirements
    })
    .to_string(),
  )
  .unwrap();
  dir
}

fn import(host: &mut LispHost, name: &str, alias: &str) -> Result<(), String> {
  host
    .eval_to_json(&format!("(@import {name:?} :as {alias:?})"))
    .map_err(|e| e.to_string())?;
  host.process_pending_rc().map_err(|e| e.to_string())
}

#[test]
fn module_dependency_aliases_resolve_packages_before_running_the_body() {
  let root = tempfile::tempdir().unwrap();
  bundle(
    root.path(),
    "consumer",
    "1.0.0",
    json!({"sdk":{"package":"real-sdk","version":"^1"}}),
    "(define ready (sdk.ready)) (define (identity) (module.bundle))",
  );
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  let missing = import(&mut host, "consumer", "app").unwrap_err();
  assert!(missing.contains("plugins install real-sdk"), "{missing}");
  bundle(
    root.path(),
    "real-sdk",
    "1.0.0",
    json!({}),
    "(define (ready) true)",
  );
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  import(&mut host, "consumer", "app").unwrap();
  assert_eq!(host.eval_to_json("app.ready").unwrap(), json!(true));
  assert_eq!(
    host.eval_to_json("(app.identity)").unwrap(),
    json!("consumer")
  );
  assert!(host.eval_to_json("sdk").is_err());
  import(&mut host, "consumer", "other").unwrap();
  assert_eq!(host.eval_to_json("other.ready").unwrap(), json!(true));
  bundle(
    root.path(),
    "legacy-consumer",
    "1.0.0",
    json!({"real-sdk":"^1"}),
    "(define ready (real-sdk.ready))",
  );
  import(&mut host, "legacy-consumer", "legacy").unwrap();
  assert_eq!(host.eval_to_json("legacy.ready").unwrap(), json!(true));
}

#[test]
fn aliased_dependencies_consume_legacy_requires_without_duplicate_mounts() {
  let root = tempfile::tempdir().unwrap();
  let dir = bundle(
    root.path(),
    "consumer",
    "1.0.0",
    json!({"sdk":{"package":"real-sdk","version":"^1"}}),
    "(define ready (sdk.ready))",
  );
  let manifest_path = dir.join("manifest.json");
  let mut manifest: Value =
    serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
  manifest["requires"] = json!(["real-sdk"]);
  std::fs::write(manifest_path, manifest.to_string()).unwrap();
  bundle(
    root.path(),
    "real-sdk",
    "1.0.0",
    json!({}),
    "(define (ready) true)",
  );
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  import(&mut host, "consumer", "app").unwrap();
  assert_eq!(host.eval_to_json("app.ready").unwrap(), json!(true));
  assert!(host.eval_to_json("app.__deps.real-sdk").is_err());
  assert_eq!(
    host.eval_to_json("(app.__deps.sdk.ready)").unwrap(),
    json!(true)
  );
}

#[test]
fn d13_spotlight_trait_presets_and_json_hydration_run_through_real_bundles() {
  use tento_lisp_cmd::script::ImportResolver;
  // This embedding stands in for the tsh version required by the fixture.
  tento_app::tsh_app::set_runtime_tsh_version("0.1.57");
  let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("../tento-lisp-cmd/src/script/fixtures/bundle-module-form");
  let root = tempfile::tempdir().unwrap();
  for (name, rc) in [
    ("tento-fleet-sdk", "sdk"),
    ("tento-fleet-item", "item"),
    ("tsh-item-spotlight", "spotlight"),
  ] {
    let dir = root.path().join(format!("{name}.tsh.app"));
    std::fs::create_dir_all(dir.join("rc")).unwrap();
    std::fs::copy(
      fixtures.join(name).join("manifest.json"),
      dir.join("manifest.json"),
    )
    .unwrap();
    std::fs::copy(
      fixtures.join(name).join(format!("rc/{rc}.tshrc")),
      dir.join(format!("rc/{rc}.tshrc")),
    )
    .unwrap();
  }
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  // This is a core-provided std namespace in the design. Mount it through
  // the trusted host door; user @import intentionally cannot claim std.*.
  let resolver = tento_app::tsh_app::TshAppResolver::new(vec![root.path().into()]);
  let item = resolver
    .resolve("tento-fleet-item", "std.fleet.item", None, Rc::default())
    .unwrap();
  host.mount(item, "std.fleet.item");
  host.process_pending_rc().unwrap();
  host.register_native_special("std.text.matches", |args| {
    let [
      tento_lisp::Value::String(text),
      tento_lisp::Value::String(pattern),
    ] = args.as_slice()
    else {
      panic!("string matcher args");
    };
    Ok(tento_lisp::Value::Boolean(text.contains(pattern.as_str())))
  });
  import(&mut host, "tsh-item-spotlight", "item.spotlight").unwrap();
  host
    .eval_to_json("(use std.fleet.item (Item ItemPlan ReconcileCheck ReconcileResult))")
    .unwrap();
  let plan = host
    .eval_to_json("(define plan (item.spotlight.plan)) plan")
    .unwrap();
  assert_eq!(plan["item"], "tsh-item-spotlight");
  assert_eq!(plan["params"]["volume"], "/System/Volumes/Data");
  assert_eq!(plan["params"]["shape"], "item.spotlight.params/v1");
  assert_eq!(
    host.eval_to_json("(Item.privileged plan.params)").unwrap(),
    json!(["/usr/bin/mdutil"])
  );
  assert_eq!(
    host.eval_to_json("(Item.check plan.params)").unwrap()["state"],
    "drift"
  );
  for source in [
    "(Item.reconcile plan.params)",
    "(Item.reconcile plan.params apply: false)",
  ] {
    assert_eq!(host.eval_to_json(source).unwrap()["state"], "would-change");
  }
  let failed = host
    .eval_to_json("(Item.reconcile plan.params apply: true)")
    .unwrap();
  assert_eq!(failed["state"], "failed");
  assert_eq!(failed["error"], "stub sudo");
  assert_eq!(
    host.eval_to_json("(trait.check Item plan.params)").unwrap(),
    "ok"
  );
  assert_eq!(
    host
      .eval_to_json("(trait.check Item item.spotlight)")
      .unwrap(),
    "ok"
  );
  assert_eq!(host.eval_to_json("(count (trait.impls Item))").unwrap(), 1);
  assert!(
    host.eval_to_json("(trait.describe Item)").unwrap()["methods"]["reconcile"]["parameters"]
      .is_array()
  );
  host
    .eval_to_json(include_str!(
      "../../tento-lisp-cmd/src/script/fixtures/bundle-module-form/hydrate-plan.tsh"
    ))
    .unwrap();
  assert_eq!(host.eval_to_json("restored").unwrap(), plan["params"]);
  assert_eq!(
    host.eval_to_json("(Item.reconcile restored)").unwrap()["state"],
    "would-change"
  );
  let custom = host
    .eval_to_json("(item.spotlight.plan volume: \"/Other\")")
    .unwrap();
  assert_eq!(custom["params"]["volume"], "/Other");
  assert!(
    host
      .eval_to_json("(item.spotlight.plan unknown: 1)")
      .is_err()
  );
  assert!(
    host
      .eval_to_json("(Item.reconcile restored apply: 1)")
      .is_err()
  );
  // Other item implementations are out of scope; fixture plans let the exact
  // presets block exercise namespaced calls, defaults, keyword args and concat.
  for name in [
    "power",
    "identity",
    "time",
    "homebrew",
    "sudoers",
    "tailnet",
    "iroh-bridge",
    "headless",
    "mosh",
    "gate",
    "perimeter",
    "sshd",
    "checkouts",
    "screen-sharing",
  ] {
    let id = format!("tsh-item-{name}");
    bundle(
      root.path(),
      &id,
      "0.1.0",
      json!({}),
      "(fn plan (ports: (option (list s64))) -> any {\"item\" (module.bundle) \"params\" {\"ports\" ports}})",
    );
    import(&mut host, &id, &format!("item.{name}")).unwrap();
  }
  let presets = std::fs::read_to_string(fixtures.join("presets.tsh")).unwrap();
  host.eval_to_json(&presets).unwrap();
  assert_eq!(
    host
      .eval_to_json("(list (count fleet-mini) (count wan) (count reachable) (count console))")
      .unwrap(),
    json!([11, 14, 4, 13])
  );
  import(&mut host, "tsh-item-spotlight", "other.spotlight").unwrap();
  import(&mut host, "tsh-item-spotlight", "item.spotlight").unwrap();
  assert_eq!(host.eval_to_json("(other.spotlight.plan)").unwrap(), plan);
  assert_eq!(host.eval_to_json("(count (trait.impls Item))").unwrap(), 1);
}

#[test]
fn failed_module_initialization_rolls_back_shape_and_impl_registration() {
  let root = tempfile::tempdir().unwrap();
  let source = r#"
    (struct Params shape: (enum "retry.params/v1") volume: string)
    (trait Item (fn check (self) -> string))
    (impl Item for Params (fn check (self) -> string self.volume))
  "#;
  let dir = bundle(
    root.path(),
    "retry",
    "1.0.0",
    json!({}),
    &format!("{source} (undefined-init)"),
  );
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  assert!(
    import(&mut host, "retry", "app")
      .unwrap_err()
      .contains("undefined-init")
  );
  assert!(
    host
      .eval_to_json(
        "(std.record.hydrate {\"shape\" \"retry.params/v1\" \"volume\" \"x\"} for: \"retry\")"
      )
      .is_err()
  );
  std::fs::write(dir.join("rc/main.tshrc"), source).unwrap();
  import(&mut host, "retry", "app").unwrap();
  assert_eq!(
    host
      .eval_to_json("(use app (Item Params)) (Item.check (Params volume: \"x\"))")
      .unwrap(),
    "x"
  );
  assert_eq!(host.eval_to_json("(count (trait.impls Item))").unwrap(), 1);
}

fn fleet_source() -> String {
  std::fs::read_to_string(
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tento-fleet/rc/fleet.tshrc"),
  )
  .unwrap()
}

fn auth_source() -> String {
  let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .unwrap()
    .parent()
    .unwrap();
  std::fs::read_to_string(workspace.join("tsh/plugins/tsh-auth/rc/auth.tshrc")).unwrap()
}

#[test]
fn missing_mismatched_and_cyclic_dependencies_fail_before_consumer_rc() {
  let root = tempfile::tempdir().unwrap();
  bundle(
    root.path(),
    "parent",
    "1.0.0",
    json!({"dependency":"^1"}),
    "(bundle (m) (test.side-effect))",
  );
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  host.register_native_special("test.side-effect", |_| panic!("consumer must not run"));
  let missing = import(&mut host, "parent", "p").unwrap_err();
  assert!(missing.contains("plugins install dependency"), "{missing}");
  bundle(
    root.path(),
    "dependency",
    "2.0.0",
    json!({}),
    "(bundle (m))",
  );
  let mismatch = import(&mut host, "parent", "p").unwrap_err();
  assert!(
    mismatch.contains("requires dependency@^1, installed 2.0.0"),
    "{mismatch}"
  );
  bundle(
    root.path(),
    "dependency",
    "1.0.0",
    json!({"parent":"^1"}),
    "(bundle (m))",
  );
  let cycle = import(&mut host, "parent", "p").unwrap_err();
  assert!(cycle.contains("parent -> dependency -> parent"), "{cycle}");
}

#[test]
fn failed_dependency_rc_quarantines_consumers_until_reimport_and_keeps_valid_exports() {
  let root = tempfile::tempdir().unwrap();
  bundle(root.path(), "ready", "1.0.0", json!({}),
    r#"(bundle (m) (test.note "ready") (define (value) 41) (m.export 'value))"#);
  let broken = bundle(root.path(), "broken", "1.0.0", json!({}), "(bundle (m) (undefined-init))");
  let parent = bundle(root.path(), "parent", "1.0.0", json!({"broken":"*", "ready":"*"}), r#"
    (bundle (m)
      (test.note "parent")
      (let broken (m.require "broken")) (let ready (m.require "ready"))
      (define (value) (+ (broken.value) (ready.value))) (m.export 'value))"#);
  std::fs::create_dir_all(parent.join("ui")).unwrap();
  std::fs::write(parent.join("ui/main.tsh"), "(test.note \"parent-ui\")").unwrap();
  let notes = Rc::new(RefCell::new(Vec::new()));
  let record = notes.clone();
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  host.enable_import_ui();
  host.register_native_special("test.note", move |args| { record.borrow_mut().push(value_to_json(&args[0])); Ok(tento_lisp::Value::Nil) });
  let error = import(&mut host, "parent", "p").unwrap_err();
  assert!(error.contains("undefined-init"), "{error}");
  assert_eq!(*notes.borrow(), vec![json!("ready")]);
  host.eval_to_json("nil").unwrap();
  host.process_pending_ui().unwrap();
  assert_eq!(*notes.borrow(), vec![json!("ready")], "unrelated eval must not initialize queued consumers");
  std::fs::write(broken.join("rc/main.tshrc"),
    r#"(bundle (m) (test.note "repaired") (define (value) 1) (m.export 'value))"#).unwrap();
  import(&mut host, "parent", "p").unwrap();
  host.process_pending_ui().unwrap();
  assert_eq!(host.eval_to_json("(p.value)").unwrap(), json!(42));
  assert_eq!(*notes.borrow(), vec![json!("ready"), json!("repaired"), json!("parent"), json!("parent-ui")],
    "successful dependency exports stay cached while failed initialization is retried");
}

#[test]
fn failed_dependency_ui_quarantines_consumers_until_reimport() {
  for read_failure in [false, true] {
    let root = tempfile::tempdir().unwrap();
    let dep = bundle(root.path(), "dep", "1.0.0", json!({}), r#"(bundle (m) (test.note "dep-rc"))"#);
    let parent = bundle(root.path(), "parent", "1.0.0", json!({"dep":"*"}), r#"(bundle (m) (test.note "parent-rc"))"#);
    for (dir, source) in [(&dep, "(undefined-ui-init)"), (&parent, "(test.note \"parent-ui\")")] {
      std::fs::create_dir_all(dir.join("ui")).unwrap();
      std::fs::write(dir.join("ui/main.tsh"), source).unwrap();
    }
    let notes = Rc::new(RefCell::new(Vec::new()));
    let record = notes.clone();
    let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
    host.enable_import_ui();
    host.register_native_special("test.note", move |args| { record.borrow_mut().push(value_to_json(&args[0])); Ok(tento_lisp::Value::Nil) });
    import(&mut host, "parent", "p").unwrap();
    if read_failure { std::fs::remove_file(dep.join("ui/main.tsh")).unwrap(); }
    assert!(host.process_pending_ui().is_err());
    host.eval_to_json("nil").unwrap();
    host.process_pending_ui().unwrap();
    assert_eq!(*notes.borrow(), vec![json!("dep-rc"), json!("parent-rc")]);
    std::fs::write(dep.join("ui/main.tsh"), "(test.note \"dep-ui\")").unwrap();
    import(&mut host, "parent", "p").unwrap();
    host.process_pending_ui().unwrap();
    assert_eq!(*notes.borrow(), vec![json!("dep-rc"), json!("parent-rc"), json!("dep-ui"), json!("parent-ui")],
      "reimport retries UI while keeping successfully initialized rc cached");
  }
}

#[test]
fn private_rc_dependencies_and_checked_exports_survive_reimport_and_aliases() {
  let root = tempfile::tempdir().unwrap();
  bundle(
    root.path(),
    "dep",
    "1.2.0",
    json!({}),
    "(bundle (m) (fn next (value s64) -> s64 (+ value 1)) (m.export 'next))",
  );
  bundle(
    root.path(),
    "parent",
    "1.0.0",
    json!({"dep":"^1"}),
    r#"
    (bundle (m)
      (let dep (m.require "dep"))
      (define (next value) (dep.next value))
      (m.export 'next))"#,
  );
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  bundle(
    root.path(),
    "unrelated",
    "1.0.0",
    json!({}),
    "(bundle (m) (fn next (value s64) -> s64 999) (m.export 'next))",
  );
  import(&mut host, "unrelated", "dep").unwrap();
  import(&mut host, "parent", "p").unwrap();
  assert_eq!(host.eval_to_json("(p.next 4)").unwrap(), json!(5));
  assert!(
    host
      .eval_to_json("(p.next \"bad\")")
      .unwrap_err()
      .to_string()
      .contains("arguments.value")
  );
  assert_eq!(
    host.eval_to_json("(dep.next 4)").unwrap(),
    json!(999),
    "private import preserves unrelated public alias"
  );
  import(&mut host, "parent", "renamed").unwrap();
  assert_eq!(
    host
      .eval_to_json("(let ((module renamed)) (module.next 8))")
      .unwrap(),
    json!(9)
  );
  assert_eq!(
    host.eval_to_json("(module.bundle renamed)").unwrap(),
    json!("parent")
  );
  import(&mut host, "parent", "p").unwrap();
  assert_eq!(host.eval_to_json("(p.next 5)").unwrap(), json!(6));
}

#[test]
fn dependency_identity_and_conflicting_legacy_ranges_are_refused() {
  let root = tempfile::tempdir().unwrap();
  let shadow = tempfile::tempdir().unwrap();
  bundle(root.path(), "dep", "1.2.0", json!({}), "(bundle (m))");
  bundle(
    root.path(),
    "parent",
    "1.0.0",
    json!({"dep":"^1"}),
    "(bundle (m))",
  );
  let fake = bundle(shadow.path(), "dep", "1.2.0", json!({}), "(bundle (m))");
  let manifest_path = fake.join("manifest.json");
  let mut manifest: Value =
    serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
  manifest["name"] = json!("other");
  std::fs::write(&manifest_path, manifest.to_string()).unwrap();
  let mut host = tento_app::lisp_host_with_apps(vec![shadow.path().into(), root.path().into()]);
  assert!(
    import(&mut host, "parent", "p")
      .unwrap_err()
      .contains("mismatched bundle")
  );
  let conflicting = bundle(
    root.path(),
    "conflicting",
    "1.0.0",
    json!({}),
    "(bundle (m))",
  );
  let manifest_path = conflicting.join("manifest.json");
  let mut manifest: Value =
    serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
  manifest["requires"] = json!(["dep@^1", "dep@^2"]);
  std::fs::write(&manifest_path, manifest.to_string()).unwrap();
  assert!(
    import(&mut host, "conflicting", "c")
      .unwrap_err()
      .contains("conflicting ranges")
  );
}

#[test]
fn serialized_fleet_program_drains_rc_exports_inside_outer_begin() {
  let root = tempfile::tempdir().unwrap();
  bundle(
    root.path(),
    "only-rc",
    "1.0.0",
    json!({}),
    "(bundle (m) (define (report) (list {\"id\" \"one\"} {\"id\" \"two\"})) (m.export 'report))",
  );
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  let text = host
    .eval_to_json(
      r#"(json-stringify (begin
    (begin (@import "only-rc" :as "p") (p.report))))"#,
    )
    .unwrap();
  let value: Value = serde_json::from_str(text.as_str().unwrap()).unwrap();
  assert_eq!(value, json!([{"id":"one"},{"id":"two"}]));
  let mut scripted = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  let output = futures::executor::block_on(tento_lisp_cmd::script::run_source_on_host(
    &mut scripted,
    r#"(json-stringify (begin (@import "only-rc" :as "p") (p.report)))"#,
    &tento_lisp_cmd::Scripts::new(()),
    &std::collections::HashMap::new(),
    &[],
    tento_lisp_cmd::script::RunOptions {
      bash: Some(false),
      ..Default::default()
    },
  ))
  .unwrap()
  .unwrap();
  assert_eq!(
    serde_json::from_str::<Value>(output.as_str().unwrap()).unwrap(),
    value
  );
  let deep = format!("{}nil{}", "(begin ".repeat(260), ")".repeat(260));
  assert!(scripted.eval_to_json(&deep).unwrap_err().to_string().contains("256 nested"));
}

#[test]
fn import_enforces_local_lock_pins_and_shared_nightly_ranges() {
  let root = tempfile::tempdir().unwrap();
  let dep = bundle(
    root.path(),
    "dep",
    "1.2.3-nightly.1",
    json!({}),
    "(bundle (m))",
  );
  let parent = bundle(
    root.path(),
    "parent",
    "1.0.0",
    json!({"dep":"^1.2"}),
    "(bundle (m))",
  );
  let lock = root.path().join("tsh.lock");
  let resolver =
    tento_app::TshAppResolver::new(vec![root.path().into()]).with_dependency_lock(lock.clone());
  let mut host = LispHost::with_resolver(Rc::new(resolver));
  std::fs::write(
    &lock,
    json!({"schema":"tsh.lock/v1","plugins":{
      "parent":{"version":"1.0.0","path":parent},
      "dep":{"version":"1.2.3-nightly.1","path":dep}
    }})
    .to_string(),
  )
  .unwrap();
  import(&mut host, "parent", "p").unwrap();
  std::fs::write(
    &lock,
    json!({"schema":"tsh.lock/v1","plugins":{
      "parent":{"version":"1.0.0","path":parent},
      "dep":{"version":"1.2.2","path":dep}
    }})
    .to_string(),
  )
  .unwrap();
  assert!(
    import(&mut host, "parent", "again")
      .unwrap_err()
      .contains("differs from tsh.lock")
  );
  std::fs::write(
    &lock,
    json!({"schema":"tsh.lock/v1","plugins":{
      "parent":{"version":"1.0.0","path":parent}
    }})
    .to_string(),
  )
  .unwrap();
  assert!(
    import(&mut host, "parent", "again")
      .unwrap_err()
      .contains("missing from tsh.lock")
  );
  std::fs::write(&lock, "{}").unwrap();
  assert!(
    import(&mut host, "parent", "again")
      .unwrap_err()
      .contains("not a tsh.lock/v1")
  );
}

#[test]
fn optional_dependencies_are_not_required_or_implicitly_installed() {
  let root = tempfile::tempdir().unwrap();
  bundle(
    root.path(),
    "parent",
    "1.0.0",
    json!({"absent":{"version":"^1","optional":true}}),
    "(bundle (m) (define (optional) (m.require \"absent\")) (define (undeclared) (m.require \"other\")) (m.export 'optional) (m.export 'undeclared))",
  );
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  import(&mut host, "parent", "p").unwrap();
  assert_eq!(host.eval_to_json("(p.optional)").unwrap(), Value::Null);
  assert!(
    host
      .eval_to_json("(p.undeclared)")
      .unwrap_err()
      .to_string()
      .contains("not a declared dependency")
  );
}

#[test]
fn fleet_front_door_keeps_literal_arguments_and_host_error_rows() {
  let root = tempfile::tempdir().unwrap();
  bundle(
    root.path(),
    "tento-fleet",
    "0.3.0",
    json!({}),
    &fleet_source(),
  );
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  let calls = Rc::new(RefCell::new(Vec::new()));
  let recorded = calls.clone();
  host.register_native_special("std.fleet.mode", |_| Ok(value_from_json(&json!("legacy"))));
  host.register_native_special("std.fleet.map", move |args| {
    recorded.borrow_mut().push(args.iter().map(value_to_json).collect::<Vec<_>>());
    Ok(value_from_json(&json!([
      {"host":"local","ok":true,"value":[{"id":"one","n":1},{"id":"two","extra":true}],"error":null,"elapsed_ms":1},
      {"host":"down","ok":false,"value":null,"error":"connection refused","elapsed_ms":2}
    ])))
  });
  import(&mut host, "tento-fleet", "fleet").unwrap();
  let table = host
    .eval_to_json(r#"(fleet.run "echo" "refresh:" "false" "a\"b" (list 1 2) {"k" "v"})"#)
    .unwrap();
  assert_eq!(table["shape"], json!("table/v1"));
  assert_eq!(table["rows"].as_array().unwrap().len(), 3);
  assert!(table.to_string().contains("connection refused"));
  assert_eq!(
    calls.borrow()[0][1],
    json!(r#"(echo "refresh:" "false" "a\"b" (list 1 2) {"k" "v"})"#)
  );
  host.eval_to_json(r#"(fleet.run "echo")"#).unwrap();
  assert_eq!(calls.borrow()[1][1], json!("(echo)"));
  assert!(host.eval_to_json(r#"(fleet.run "echo) (bad")"#).is_err());
  assert_eq!(calls.borrow().len(), 2, "reject before transport");
  assert!(
    host
      .eval_to_json(r#"(fleet.map "local" (list "echo" "x) (bad:"))"#)
      .is_err()
  );
  assert_eq!(
    calls.borrow().len(),
    2,
    "reject invalid named token before transport"
  );
  host
    .eval_to_json(r#"(let ((module fleet)) (module.map "local" "(+ 1 2)"))"#)
    .unwrap();
  assert_eq!(calls.borrow()[2], vec![json!("local"), json!("(+ 1 2)")]);
}

#[test]
fn exact_auth_source_maps_bundle_identity_and_preserves_failed_hosts() {
  let root = tempfile::tempdir().unwrap();
  bundle(
    root.path(),
    "tento-fleet",
    "0.3.0",
    json!({}),
    &fleet_source(),
  );
  bundle(
    root.path(),
    "tsh-auth",
    "0.1.0",
    json!({"tento-fleet":"^0.3"}),
    &auth_source(),
  );
  bundle(
    root.path(),
    "independent-provider",
    "1.0.0",
    json!({}),
    r#"
    (bundle (m)
      (struct Window label: string used_percent: f64 resets_at: (option s64))
      (struct Account id: string nick: string login: string login_detail: (option string)
        login_expires_at: (option s64) usage_as_of: (option s64) usage: (list Window) usage_state: string)
      (struct Report provider: string active: (option string) accounts: (list Account))
      (fn accounts (refresh: bool = false) -> Report
        {"provider" "independent" "active" nil "accounts" (list)})
      (m.export 'accounts))"#,
  );
  let calls = Rc::new(RefCell::new(Vec::new()));
  let recorded = calls.clone();
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  host.register_native_special("std.time.unix", |_| Ok(value_from_json(&json!(1700000000))));
  host.register_native_special("std.fleet.mode", |_| Ok(value_from_json(&json!("legacy"))));
  host.register_native_special("std.fleet.hosts", |_| Ok(value_from_json(&json!([
    {"name":"local","ssh":null,"tsh":"fixture-tsh"},
    {"name":"down","ssh":"down","tsh":"tsh"},
    {"name":"liar","ssh":"liar","tsh":"tsh"}
  ]))));
  host.register_native_special("std.fleet.map", move |args| {
    recorded.borrow_mut().push(args.iter().map(value_to_json).collect::<Vec<_>>());
    Ok(value_from_json(&json!([
      {"host":"local","ok":true,"value":{"provider":"independent","active":"test@example.invalid","accounts":[
        {"id":"test@example.invalid","nick":"test","login":"ok","login_detail":null,"login_expires_at":null,
        "usage_as_of":1700000000,"usage_state":"available","usage":[
          {"label":"short","used_percent":10.0,"resets_at":null},
          {"label":"long","used_percent":85.0,"resets_at":null}]}]},"error":null,"elapsed_ms":1},
      {"host":"down","ok":false,"value":null,"error":"provider unavailable","elapsed_ms":2},
      {"host":"liar","ok":true,"value":{"provider":"independent","active":null,"accounts":[
        {"id":"wrong","nick":"wrong","login":"ok","login_detail":null,"login_expires_at":null,
         "usage_as_of":null,"usage_state":"available","usage":[{"label":"short","used_percent":"wrong","resets_at":null}]}]},"error":null,"elapsed_ms":1}
    ])))
  });
  import(&mut host, "independent-provider", "renamed").unwrap();
  import(&mut host, "tsh-auth", "auth").unwrap();
  assert!(
    host
      .eval_to_json("(auth.check)")
      .unwrap()
      .to_string()
      .contains("\"conforms\":true")
  );
  assert!(
    calls.borrow().is_empty(),
    "discovery never invokes transport"
  );
  let report = host.eval_to_json("(auth.status {})").unwrap();
  assert!(
    report.to_string().contains("provider unavailable"),
    "{report}"
  );
  assert!(report.to_string().contains("@test"), "{report}");
  assert!(report.to_string().contains("used_percent"), "invalid remote results remain visible: {report}");
  assert_eq!(
    report["sections"][0]["value"]["rows"]
      .as_array()
      .unwrap()
      .len(),
    2
  );
  let form = calls.borrow()[0][1].as_str().unwrap().to_string();
  assert!(
    form.contains("independent-provider") && !form.contains("renamed.accounts"),
    "{form}"
  );
  assert!(form.contains("refresh: false"), "{form}");
  host
    .eval_to_json("(auth.status {\"hosts\" \"local\"})")
    .unwrap();
  assert_eq!(
    calls.borrow().len(),
    1,
    "local option directly calls discovered source"
  );
}

#[test]
fn provider_sync_keeps_resolved_routes_and_never_sends_the_local_registry_to_itself() {
  for provider in ["claude", "codex"] {
    let root = tempfile::tempdir().unwrap();
    let source = std::fs::read_to_string(
      Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../tento-{provider}/rc/{provider}.tshrc")),
    )
    .unwrap();
    bundle(
      root.path(),
      &format!("tento-{provider}"),
      "1.0.0",
      json!({}),
      &source,
    );
    let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
    let selected = Rc::new(RefCell::new(Vec::new()));
    let selection = selected.clone();
    let targets = json!([
      {"name":"local","ssh":null,"tsh":"/caller/tsh"},
      {"name":"far","ssh":"user@frozen-route","tsh":"~/pinned/tsh"},
      {"name":"caller-alias","ssh":null,"tsh":"/caller/tsh"}
    ]);
    let answer = targets.clone();
    host.register_native_special("std.fleet.mode", |_| Ok(value_from_json(&json!("legacy"))));
    host.register_native_special("std.fleet.hosts", move |args| {
      selection.borrow_mut().push(value_to_json(&args[0]));
      Ok(value_from_json(&answer))
    });
    host.register_native_special("std.fs.read_file", |_| {
      Ok(value_from_json(&json!("person@example.invalid\tnick\n")))
    });
    let calls = Rc::new(RefCell::new(Vec::new()));
    let captured = calls.clone();
    host.register_native_special("std.fleet.map", move |args| {
      captured
        .borrow_mut()
        .push(args.iter().map(value_to_json).collect::<Vec<_>>());
      Ok(value_from_json(&json!([
        {"host":"far","ok":false,"value":null,"error":"fixture offline","elapsed_ms":1}
      ])))
    });
    import(&mut host, &format!("tento-{provider}"), "p").unwrap();
    let report = host
      .eval_to_json(r#"(p.sync (list "local" "far"))"#)
      .unwrap();
    assert_eq!(*selected.borrow(), vec![json!(["local", "far"])]);
    assert_eq!(
      calls.borrow()[0][0],
      json!([targets[1]]),
      "keep ssh and tsh, not just the host name"
    );
    assert!(
      calls.borrow()[0][1]
        .as_str()
        .unwrap()
        .contains(&format!("tento-{provider}"))
    );
    assert!(report.to_string().contains("fixture offline"), "{report}");
    assert_eq!(report["rows"].as_array().unwrap().len(), 1);
    // An explicit record takes the same route through the ordinary typed fn.
    host
      .eval_to_json(&format!(
        "(p.sync (json-parse {:?}))",
        targets[1].to_string()
      ))
      .unwrap();
    assert_eq!(selected.borrow().len(), 2);
    assert_eq!(calls.borrow()[1][0], json!([targets[1]]));
  }
}

#[test]
fn auth_selects_once_for_all_providers_and_keeps_local_and_error_paths() {
  let root = tempfile::tempdir().unwrap();
  bundle(
    root.path(),
    "tento-fleet",
    "0.3.0",
    json!({}),
    &fleet_source(),
  );
  bundle(
    root.path(),
    "tsh-auth",
    "0.1.0",
    json!({"tento-fleet":"^0.3"}),
    &auth_source(),
  );
  let provider = r#"(bundle (m)
    (struct Account id: string nick: string login: string login_detail: (option string)
      login_expires_at: (option s64) usage_as_of: (option s64) usage: (list any) usage_state: string)
    (struct Report provider: string active: (option string) accounts: (list Account))
    (fn accounts (refresh: bool = false) -> Report
      (test.local-provider) {"provider" "fixture" "active" nil "accounts" (list)})
    (m.export 'accounts))"#;
  // Match the actual consumer structurally, including a typed window list.
  let provider = provider
    .replace(
      "(struct Account",
      "(struct Window label: string used_percent: f64 resets_at: (option s64)) (struct Account",
    )
    .replace("usage: (list any)", "usage: (list Window)");
  for name in ["one", "two"] {
    bundle(root.path(), name, "1.0.0", json!({}), &provider);
  }
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  host.register_native_special("std.time.unix", |_| Ok(value_from_json(&json!(1700000000))));
  let local_calls = Rc::new(RefCell::new(0));
  let local = local_calls.clone();
  host.register_native_special("test.local-provider", move |_| {
    *local.borrow_mut() += 1;
    Ok(tento_lisp::Value::Nil)
  });
  let selections = Rc::new(RefCell::new(Vec::new()));
  let selected = selections.clone();
  let targets = json!([{"name":"far","ssh":"user@frozen-route","tsh":"~/pinned/tsh"}]);
  let answer = targets.clone();
  host.register_native_special("std.fleet.mode", |_| Ok(value_from_json(&json!("legacy"))));
  host.register_native_special("std.fleet.hosts", move |args| {
    let input = value_to_json(&args[0]);
    selected.borrow_mut().push(input.clone());
    if input == json!(42) {
      return Err(tento_lisp_cmd::script::LispHostError::Runtime(
        "fixture selection refused".into(),
      ));
    }
    Ok(value_from_json(&answer))
  });
  let calls = Rc::new(RefCell::new(Vec::new()));
  let captured = calls.clone();
  host.register_native_special("std.fleet.map", move |args| {
    captured.borrow_mut().push(args.iter().map(value_to_json).collect::<Vec<_>>());
    Ok(value_from_json(&json!([{"host":"far","ok":true,"value":{"provider":"fixture","active":null,"accounts":[]},"error":null,"elapsed_ms":1}])))
  });
  import(&mut host, "tsh-auth", "auth").unwrap();
  let empty = host.eval_to_json(r#"(auth.status {"hosts" 42})"#).unwrap();
  assert!(empty.to_string().contains("No conforming"));
  assert!(
    selections.borrow().is_empty(),
    "no providers means no inventory work"
  );
  for (name, alias) in [("one", "renamed"), ("two", "also-renamed")] {
    import(&mut host, name, alias).unwrap();
  }
  host.eval_to_json("(auth.check)").unwrap();
  host.eval_to_json("(auth.contract)").unwrap();
  assert!(selections.borrow().is_empty());
  assert_eq!(*local_calls.borrow(), 0);
  host.eval_to_json("(auth.status {})").unwrap();
  assert_eq!(
    *selections.borrow(),
    vec![json!("fleet")],
    "one target snapshot for both providers"
  );
  assert_eq!(calls.borrow().len(), 2);
  for call in calls.borrow().iter() {
    assert_eq!(call[0], targets);
  }
  // Records and mixed inputs are passed to the one canonical host validator.
  host.eval_to_json(r#"(auth.status {"hosts" (list "local" {"name" "far" "ssh" "user@frozen-route" "tsh" "~/pinned/tsh"})})"#).unwrap();
  assert_eq!(selections.borrow().len(), 2);
  assert_eq!(calls.borrow().len(), 4);
  host
    .eval_to_json(r#"(auth.status {"hosts" "local"})"#)
    .unwrap();
  assert_eq!(selections.borrow().len(), 2);
  assert_eq!(calls.borrow().len(), 4);
  assert_eq!(
    *local_calls.borrow(),
    2,
    "exact local calls the in-memory providers directly"
  );
  let failed = host.eval_to_json(r#"(auth.status {"hosts" 42})"#).unwrap();
  let rows = failed["sections"][1]["value"]["rows"].as_array().unwrap();
  assert_eq!(rows.len(), 2);
  assert!(
    rows
      .iter()
      .all(|r| r.to_string().contains("fixture selection refused"))
  );
  assert_eq!(
    calls.borrow().len(),
    4,
    "a failed selection never dispatches any provider"
  );
}

#[test]
fn optional_dependency_aliases_bind_nil_when_absent_and_modules_when_present() {
  for legacy in [false, true] {
    let root = tempfile::tempdir().unwrap();
    let source = if legacy {
      "(bundle (m) (define opt (m.require \"opt\")) (define available (not (null? opt))) (m.export 'available))"
    } else {
      "(define available (not (null? opt)))"
    };
    bundle(
      root.path(),
      "consumer",
      "1.0.0",
      json!({"opt":{"package":"real-optional","version":"*","optional":true}}),
      source,
    );
    let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
    import(&mut host, "consumer", "absent").unwrap();
    assert_eq!(host.eval_to_json("absent.available").unwrap(), false);
    bundle(
      root.path(),
      "real-optional",
      "1.0.0",
      json!({}),
      "(define ready true)",
    );
    let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
    import(&mut host, "consumer", "present").unwrap();
    assert_eq!(host.eval_to_json("present.available").unwrap(), true);
  }
}

#[test]
fn tsh_update_startup_entrypoint_is_refused_before_any_effect() {
  let root = tempfile::tempdir().unwrap();
  let dir = root.path().join("tsh-update.tsh.app");
  std::fs::create_dir_all(dir.join("rc")).unwrap();
  // Frozen from tsh/plugins/tsh-update: both startup forms must stay inert.
  std::fs::write(
    dir.join("rc/tsh-update.tshrc"),
    include_str!("../../tento-lisp-cmd/src/script/fixtures/bundle-module-form/tsh-update.tshrc"),
  )
  .unwrap();
  std::fs::write(
    dir.join("manifest.json"),
    json!({"schema":"tsh.app/v1", "name":"tsh-update", "version":"0.1.0",
      "entrypoint":"rc/tsh-update.tshrc", "startup":"rc/tsh-update.tshrc",
      "commands":{}})
    .to_string(),
  )
  .unwrap();
  let mut host = tento_app::lisp_host_with_apps(vec![]);
  host.eval_to_json("(define :session \"session\")").unwrap();
  let effects = Rc::new(RefCell::new(Vec::new()));
  for name in ["startup.scope", "on"] {
    let effects = effects.clone();
    host.register_native_special(name, move |_| {
      effects.borrow_mut().push(name);
      Ok(tento_lisp::Value::Nil)
    });
  }
  let error = host
    .eval_to_json(&format!(
      "(@import \"tsh-update\" :as \"update\" :from {:?})",
      root.path().to_str().unwrap()
    ))
    .unwrap_err()
    .to_string();
  assert!(effects.borrow().is_empty(), "{:?}", effects.borrow());
  assert!(error.contains("a bundle rc is ONE"), "{error}");
}

#[test]
fn non_entrypoint_startup_files_are_refused_before_their_effects() {
  let root = tempfile::tempdir().unwrap();
  let dir = bundle(
    root.path(),
    "startup",
    "1.0.0",
    json!({}),
    "(define ready true)",
  );
  std::fs::write(dir.join("rc/zz-startup.tshrc"), "(set touched true)").unwrap();
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  host.eval_to_json("(define touched false)").unwrap();
  let error = import(&mut host, "startup", "app").unwrap_err();
  assert!(
    error.contains("zz-startup.tshrc") && error.contains("a bundle rc is ONE"),
    "{error}"
  );
  assert_eq!(host.eval_to_json("touched").unwrap(), false);
}

#[test]
fn same_bundle_changed_impl_is_refused_and_identical_retry_is_idempotent() {
  let one = tempfile::tempdir().unwrap();
  let two = tempfile::tempdir().unwrap();
  let original = r#"(struct Params shape: (enum "same/v1") value: string)
    (impl Item for Params (fn check (self) -> string "original"))"#;
  bundle(one.path(), "same", "1.0.0", json!({}), original);
  let changed = bundle(
    two.path(),
    "same",
    "1.0.0",
    json!({}),
    &original.replace("\"original\"", "\"changed\""),
  );
  let mut host = tento_app::lisp_host_with_apps(vec![one.path().into()]);
  host
    .eval_to_json("(trait Item (fn check (self) -> string))")
    .unwrap();
  import(&mut host, "same", "one").unwrap();
  let second_import = format!(
    "(@import \"same\" :as \"two\" :from {:?})",
    two.path().to_str().unwrap()
  );
  let error = host.eval_to_json(&second_import).unwrap_err().to_string();
  assert!(
    error.contains("changed impl Item for Params in bundle same"),
    "{error}"
  );
  assert_eq!(host.eval_to_json("(count (trait.impls Item))").unwrap(), 1);
  assert_eq!(
    host
      .eval_to_json(r#"(Item.check (one.Params value: "x"))"#)
      .unwrap(),
    "original"
  );

  // Failed registration must leave the original impl usable and allow repair.
  std::fs::write(changed.join("rc/main.tshrc"), original).unwrap();
  host.eval_to_json(&second_import).unwrap();
  host.process_pending_rc().unwrap();
  assert_eq!(host.eval_to_json("(count (trait.impls Item))").unwrap(), 1);
  assert_eq!(
    host
      .eval_to_json(r#"(Item.check (two.Params value: "x"))"#)
      .unwrap(),
    "original"
  );
}

#[test]
fn shape_identity_survives_two_install_roots_for_the_same_bundle() {
  let one = tempfile::tempdir().unwrap();
  let two = tempfile::tempdir().unwrap();
  for root in [one.path(), two.path()] {
    bundle(
      root,
      "same",
      "1.0.0",
      json!({}),
      r#"(struct Params shape: (enum "same/v1") value: string)
         (impl Item for Params (fn check (self) -> string self.value))"#,
    );
  }
  let mut host = tento_app::lisp_host_with_apps(vec![one.path().into()]);
  host
    .eval_to_json("(trait Item (fn check (self) -> string))")
    .unwrap();
  import(&mut host, "same", "one").unwrap();
  host
    .eval_to_json(&format!(
      "(@import \"same\" :as \"two\" :from {:?})",
      two.path().to_str().unwrap()
    ))
    .unwrap();
  host.process_pending_rc().unwrap();
  assert_eq!(
    host
      .eval_to_json(r#"(Item.check (two.Params value: "x"))"#)
      .unwrap(),
    "x"
  );
  assert_eq!(host.eval_to_json("(count (trait.impls Item))").unwrap(), 1);
  assert_eq!(
    host
      .eval_to_json(r#"(std.record.hydrate {"shape" "same/v1" "value" "x"} as: two.Params)"#)
      .unwrap(),
    json!({"shape":"same/v1","value":"x"})
  );
  assert_eq!(
    host
      .eval_to_json(r#"(std.record.hydrate {"shape" "same/v1" "value" "x"} as: one.Params)"#)
      .unwrap(),
    json!({"shape":"same/v1","value":"x"})
  );
}

#[test]
fn a_forged_plan_cannot_dispatch_another_items_privileged_implementation() {
  let root = tempfile::tempdir().unwrap();
  for name in ["spotlight", "sudoers"] {
    bundle(
      root.path(),
      &format!("tsh-item-{name}"),
      "1.0.0",
      json!({}),
      &format!(
        r#"
        (struct Params shape: (enum "item.{name}/v1") value: string)
        (impl Item for Params (fn reconcile (self apply: bool = false) -> string
          (if apply (begin (set applied (+ applied 1)) (module.bundle)) "dry-run")))
      "#
      ),
    );
  }
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  host
    .eval_to_json(
      "(define applied 0) (trait Item (fn reconcile (self apply: bool = false) -> string))",
    )
    .unwrap();
  import(&mut host, "tsh-item-spotlight", "spotlight").unwrap();
  import(&mut host, "tsh-item-sudoers", "sudoers").unwrap();
  host.eval_to_json(r#"(define frame {"item" "tsh-item-spotlight" "params" {"shape" "item.sudoers/v1" "value" "forged"}})"#).unwrap();
  let error = host
    .eval_to_json("(Item.reconcile (std.record.hydrate frame.params for: frame.item) apply: true)")
    .unwrap_err()
    .to_string();
  assert!(
    error.contains("tsh-item-sudoers") && error.contains("tsh-item-spotlight"),
    "{error}"
  );
  assert_eq!(host.eval_to_json("applied").unwrap(), 0);
  assert_eq!(
    host
      .eval_to_json(
        r#"(Item.reconcile (std.record.hydrate frame.params for: "tsh-item-sudoers") apply: true)"#
      )
      .unwrap(),
    "tsh-item-sudoers"
  );
  assert_eq!(host.eval_to_json("applied").unwrap(), 1);
}

#[test]
fn provision_renders_per_host_uncertainty_and_partial_outcomes() {
  let root = tempfile::tempdir().unwrap();
  bundle(root.path(), "tento-fleet", "0.4.1", json!({}), &fleet_source());
  let mut host = tento_app::lisp_host_with_apps(vec![root.path().into()]);
  host.register_native_special("fleet.configure", |_| Ok(value_from_json(&json!({
    "success":false, "recap":[], "host_results":[
      {"host":"reachable", "items":["power"], "state":"unverified plan", "run":{"recap":{"changed":0,"failed":0}}},
      {"host":"console", "items":["headless","mosh"], "state":"verification failed", "run":{"recap":{"changed":2,"failed":0}}},
      {"host":"down", "items":["power"], "state":"failed", "run":{"recap":null}}
    ]
  }))));
  import(&mut host, "tento-fleet", "fleet").unwrap();
  let table = host.eval_to_json("(fleet.provision sudo: false)").unwrap();
  assert_eq!(table["success"], false);
  let rows = table["rows"].as_array().unwrap();
  assert_eq!(rows[0][1], "power"); assert_eq!(rows[1][1], "headless,mosh");
  assert_eq!(rows[0][4]["text"], "unverified plan");
  assert_eq!(rows[1][4]["style"], "red");
  assert_eq!(rows[2][2], "?");
}
