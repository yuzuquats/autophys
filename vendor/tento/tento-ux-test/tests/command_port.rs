use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use tento_ux_test::{
  HostPort,
  command_port::{CallFailure, Client, Config, Failure},
};

struct Fixture {
  dir: PathBuf,
}
impl Fixture {
  fn new() -> Self {
    let dir = std::env::temp_dir().join(format!("ux-command-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    Self { dir }
  }
  fn config_json(&self, mode: &str, kind: &str) -> Value {
    let script = concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/tests/fixtures/admin_command.py"
    );
    let command = |verb| {
      json!({"transport":"local", "program":"/usr/bin/python3",
      "args":[script, verb, mode, self.dir.join("calls")]})
    };
    json!({
      "schema":"ux.admin-command/v1", "wire_schema":"example.admin/v1", "product":"example", "artifact":"fixture-v1",
      "expected":{"instance_id":"example", "profile":"fixture", "database":"isolated"},
      "hello":command("hello"), "call":command("call"), "timeout_ms":1000,
      "bindings":{"inspect":{"operation":"inspect","version":1,"effect":"read", "sensitive":false,
        "params":{"value":kind},"result":kind}}
    })
  }
  fn config(&self, mode: &str, kind: &str) -> Config {
    serde_json::from_value(self.config_json(mode, kind)).unwrap()
  }
  fn calls(&self) -> usize {
    std::fs::read_to_string(self.dir.join("calls"))
      .unwrap_or_default()
      .lines()
      .count()
  }
}
impl Drop for Fixture {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.dir);
  }
}

#[tokio::test]
async fn ordinary_setup_substitution_and_store_as_use_the_command_port() {
  let fixture = Fixture::new();
  let port = HostPort::from_commands(fixture.config("ok", "string")).unwrap();
  let mut spec = tento_ux_test::TestSpec::from_yaml(
    "id: test\nname: test\nparams:\n  input: literal-data\nsetup:\n  - action: inspect\n    value: '{{input}}'\n    store_as: observed\ninstructions:\n  - inspect\n",
  ).unwrap();
  let action = spec.setup[0].clone();
  assert!(tento_ux_test::orchestration::unknown_host_actions(&spec, port.verbs()).is_empty());
  port.preflight_commands().await.unwrap();
  tento_ux_test::orchestration::execute_setup_action(&port, &mut spec, &action)
    .await
    .unwrap();
  assert_eq!(spec.params["observed"], "literal-data");
  assert_eq!(fixture.calls(), 1);
}

#[tokio::test]
async fn setup_port_preserves_json_types_and_never_uses_a_shell_for_parameters() {
  for (kind, value) in [
    ("string", json!("'\"; $(touch NEVER); `false`\n${HOME}")),
    ("boolean", json!(false)),
    ("object", json!({"a":1})),
    ("array", json!([1, "x", true])),
    ("null", Value::Null),
    ("number", json!(12)),
  ] {
    let fixture = Fixture::new();
    let port = HostPort::from_commands(fixture.config("ok", kind)).unwrap();
    assert_eq!(fixture.calls(), 0); // Offline mount and lint vocabulary.
    assert_eq!(port.verbs(), &["inspect".to_owned()]);
    assert!(!port.remote_session_source());
    let result = port
      .execute_verb("inspect", json!({"value": value}))
      .await
      .unwrap();
    assert_eq!(result, value);
    assert_eq!(fixture.calls(), 1);
  }
}

#[tokio::test]
async fn wrong_target_artifact_schema_and_unadvertised_operations_refuse_before_dispatch() {
  for field in [
    "wire_schema",
    "product",
    "artifact",
    "database",
    "operation",
    "version",
  ] {
    let fixture = Fixture::new();
    let mut config = fixture.config_json("ok", "string");
    match field {
      "database" => config["expected"][field] = json!("wrong"),
      "operation" => config["bindings"]["inspect"][field] = json!("missing"),
      "version" => config["bindings"]["inspect"][field] = json!(2),
      _ => config[field] = json!("wrong"),
    }
    let client = Client::new(serde_json::from_value(config).unwrap()).unwrap();
    assert_eq!(client.preflight().await, Err(Failure::Preflight));
    assert_eq!(fixture.calls(), 0);
  }
  for mode in ["mutation", "not_ready"] {
    let fixture = Fixture::new();
    let client = Client::new(fixture.config(mode, "string")).unwrap();
    assert_eq!(client.preflight().await, Err(Failure::Preflight));
    assert_eq!(fixture.calls(), 0);
  }
}

#[tokio::test]
async fn input_allowlist_refuses_unknown_verb_missing_extra_and_wrong_type() {
  let fixture = Fixture::new();
  let port = HostPort::from_commands(fixture.config("ok", "string")).unwrap();
  for (action, params) in [
    ("other", json!({"value":"x"})),
    ("inspect", json!({})),
    ("inspect", json!({"value":false})),
    ("inspect", json!({"value":"x","extra":"SECRET"})),
  ] {
    assert!(port.execute_verb(action, params).await.is_err());
  }
  assert_eq!(fixture.calls(), 0);
}

#[tokio::test]
async fn invalid_or_lost_replies_poison_the_port_without_retry_or_output_leakage() {
  for mode in [
    "malformed",
    "lost",
    "wrong_nonce",
    "restart",
    "both",
    "exit_mismatch",
    "overflow",
    "wrong_result",
    "duplicate",
    "bad_refusal_identity",
  ] {
    let fixture = Fixture::new();
    let port = HostPort::from_commands(fixture.config(mode, "string")).unwrap();
    let error = port
      .execute_verb("inspect", json!({"value":"SECRET-DO-NOT-LOG"}))
      .await
      .unwrap_err();
    assert!(!format!("{error:#?}").contains("SECRET-DO-NOT-LOG"));
    let typed = error.downcast_ref::<CallFailure>().unwrap();
    assert_eq!(typed.failure, Failure::OutcomeUnknown, "{mode}");
    assert!(!typed.request_id.is_nil());
    assert!(
      port
        .execute_verb("inspect", json!({"value":"again"}))
        .await
        .is_err()
    );
    assert_eq!(fixture.calls(), 1, "{mode}");
  }
}

#[tokio::test]
async fn typed_nonzero_refusal_is_not_success_and_does_not_echo_backend_text() {
  let fixture = Fixture::new();
  let client = Client::new(fixture.config("refused", "string")).unwrap();
  let error = client
    .execute("inspect", json!({"value":"x"}))
    .await
    .unwrap_err();
  assert_eq!(error.failure, Failure::Refused);
  assert!(!format!("{error:?}").contains("SECRET"));
  assert_eq!(fixture.calls(), 1); // retryable:true never causes retry.
}

#[tokio::test]
async fn cancellation_retains_exclusion_and_refuses_another_call() {
  let fixture = Fixture::new();
  let client = Arc::new(Client::new(fixture.config("hang", "string")).unwrap());
  let task = tokio::spawn({
    let client = client.clone();
    async move { client.execute("inspect", json!({"value":"x"})).await }
  });
  tokio::time::timeout(std::time::Duration::from_secs(5), async {
    while fixture.calls() == 0 {
      tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
  })
  .await
  .unwrap();
  assert_eq!(
    client
      .execute("inspect", json!({"value":"x"}))
      .await
      .unwrap_err()
      .failure,
    Failure::Busy
  );
  task.abort();
  assert!(task.await.unwrap_err().is_cancelled());
  assert_eq!(
    client
      .execute("inspect", json!({"value":"x"}))
      .await
      .unwrap_err()
      .failure,
    Failure::OutcomeUnknown
  );
  assert_eq!(fixture.calls(), 1);
}

#[tokio::test]
async fn deadline_is_unknown_and_does_not_retry() {
  let fixture = Fixture::new();
  let mut config = fixture.config("hang", "string");
  config.timeout_ms = 1;
  let client = Client::new(config).unwrap();
  let started = std::time::Instant::now();
  let error = client
    .execute("inspect", json!({"value":"x"}))
    .await
    .unwrap_err();
  assert_eq!(error.failure, Failure::OutcomeUnknown);
  assert!(started.elapsed() < std::time::Duration::from_secs(25));
  assert_eq!(fixture.calls(), 1);
}

#[tokio::test]
async fn spawn_failure_keeps_the_port_usable_and_failed_preflight_is_sticky() {
  let fixture = Fixture::new();
  let mut config = fixture.config_json("ok", "string");
  config["call"]["program"] = json!(fixture.dir.join("does-not-exist"));
  let client = Client::new(serde_json::from_value(config).unwrap()).unwrap();
  for _ in 0..2 {
    assert_eq!(
      client
        .execute("inspect", json!({"value":"x"}))
        .await
        .unwrap_err()
        .failure,
      Failure::Unavailable
    );
  }
  assert_eq!(fixture.calls(), 0);
  let fixture = Fixture::new();
  let client = Client::new(fixture.config("not_ready", "string")).unwrap();
  for _ in 0..2 {
    assert_eq!(client.preflight().await, Err(Failure::Preflight));
  }
  assert_eq!(
    std::fs::read_to_string(fixture.dir.join("calls.hello"))
      .unwrap()
      .lines()
      .count(),
    1
  );
}

#[test]
fn mutation_and_sensitive_bindings_are_rejected_until_lifecycle_and_redaction_exist() {
  let fixture = Fixture::new();
  for field in ["sensitive", "effect"] {
    let mut config = fixture.config_json("ok", "string");
    config["bindings"]["inspect"][field] = if field == "effect" {
      json!("mutation")
    } else {
      json!(true)
    };
    assert!(Client::new(serde_json::from_value(config).unwrap()).is_err());
  }
}
