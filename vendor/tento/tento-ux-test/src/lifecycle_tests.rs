//! Failure injection through run_single and a fake HostPort. No browser or DB.
use super::*;
use crate::orchestration::{HostPort, SessionTarget, UxTestEnv, VerbRequest};
use crate::session::SessionResult;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const ID: &str = "2026-11-03_lifecycle_fixture";
const SECRET: &str = "do-not-persist-host-error-or-promo";
const SPEC: &str = r#"
id: 2026-11-03_lifecycle_fixture
name: Lifecycle fixture
timeout: 3
initial_path: '/promo/{{promo_code}}'
setup:
  - action: delete_fixture
  - action: create_inactive
  - action: create_promo
steps:
  - id: inspect
    instruction: 'Inspect {{promo_code}}'
    display_params: [promo_code]
teardown:
  - action: restore_declared
    code: '{{promo_code}}'
    store_as: ignored
  - action: cleanup_tail
verification:
  auto_fail_on_errors: false
"#;

struct Env {
  root: PathBuf,
  nested: bool,
}
impl UxTestEnv for Env {
  fn llm_logger_dir(&self) -> PathBuf {
    self.root.join("flat")
  }
  fn ux_tests_dir(&self) -> Option<PathBuf> {
    self.nested.then(|| self.root.join("corpus"))
  }
  fn loaf_logs_dir(&self) -> Option<PathBuf> {
    None
  }
  fn server_host(&self) -> Option<String> {
    None
  }
  fn resolve_session_target(
    &self,
    _: &Option<String>,
    path: Option<&str>,
    _: Option<&str>,
  ) -> anyhow::Result<SessionTarget> {
    Ok(SessionTarget::from_full_host(
      "app.example.test".into(),
      path,
    ))
  }
}
#[derive(Clone, Copy)]
enum Fault {
  None,
  Setup(usize),
  SessionFile,
  SpecFile,
  OutputRevoked,
}
struct Rig {
  ctx: UxTestCtx,
  root: PathBuf,
  run_dir: PathBuf,
  calls: Arc<Mutex<Vec<(String, Value)>>>,
  active: Arc<Mutex<bool>>,
}
impl Drop for Rig {
  fn drop(&mut self) {
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = std::fs::set_permissions(&self.run_dir, std::fs::Permissions::from_mode(0o755));
      let _ = std::fs::set_permissions(
        &self.root.join("corpus").join(ID),
        std::fs::Permissions::from_mode(0o755),
      );
    }
    let _ = std::fs::remove_dir_all(&self.root);
  }
}
fn rig(nested: bool, fault: Fault, cleanup_fails: bool) -> Rig {
  let root = std::env::temp_dir().join(format!("ux-lifecycle-{}", Uuid::new_v4()));
  std::fs::create_dir_all(&root).unwrap();
  let run_dir = if nested {
    root.join("corpus").join(ID).join("runs").join(ID)
  } else {
    root.join("flat").join(ID)
  };
  let calls = Arc::new(Mutex::new(Vec::new()));
  let seen = calls.clone();
  let active = Arc::new(Mutex::new(true));
  let fixture = active.clone();
  let output = run_dir.clone();
  let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<VerbRequest>();
  tokio::spawn(async move {
    let mut setup_index = 0;
    while let Some(request) = rx.recv().await {
      seen
        .lock()
        .unwrap()
        .push((request.action.clone(), request.params));
      let result = match request.action.as_str() {
        "delete_fixture" | "create_inactive" | "create_promo" => {
          // Model a host that mutates BEFORE returning an error.
          *fixture.lock().unwrap() = false;
          let fails = matches!(fault, Fault::Setup(i) if i == setup_index);
          setup_index += 1;
          if request.action == "create_promo" {
            match fault {
              Fault::SessionFile => std::fs::create_dir_all(output.join("session.json")).unwrap(),
              Fault::SpecFile => std::fs::create_dir_all(output.join("spec.yaml")).unwrap(),
              #[cfg(unix)]
              Fault::OutputRevoked => {
                use std::os::unix::fs::PermissionsExt;
                std::fs::create_dir_all(&output).unwrap();
                std::fs::set_permissions(&output, std::fs::Permissions::from_mode(0o555)).unwrap();
              }
              _ => {}
            }
          }
          if fails {
            Err(anyhow::anyhow!("primary setup failure {setup_index}"))
          } else {
            Ok(json!({"promo_code": SECRET}))
          }
        }
        "restore_declared" if cleanup_fails => Err(anyhow::anyhow!("cleanup leaked {SECRET}")),
        "restore_declared" => {
          *fixture.lock().unwrap() = true;
          Ok(json!(true))
        }
        "cleanup_tail" => Ok(json!(true)),
        other => panic!("undeclared verb {other}"),
      };
      let _ = request.reply.send(result);
    }
  });
  let ctx = UxTestCtx::new(
    Arc::new(Env {
      root: root.clone(),
      nested,
    }),
    HostPort::new(
      [
        "delete_fixture",
        "create_inactive",
        "create_promo",
        "restore_declared",
        "cleanup_tail",
      ]
      .map(str::to_string)
      .to_vec(),
      tx,
    ),
  );
  Rig {
    ctx,
    root,
    run_dir,
    calls,
    active,
  }
}
impl Rig {
  async fn run(&self, spec: &str, no_wait: bool) -> tento_sh::Result<RunOutcome> {
    let path = self.root.join("input.yaml");
    std::fs::write(&path, spec).unwrap();
    run_single(
      &self.ctx,
      UxTestRunArgs {
        file: Some(path.display().to_string()),
        no_wait,
        ..Default::default()
      },
      &EnvProfile::builtin_local(),
      &RunCtx {
        human: Human::STDOUT,
        artifact: None,
      },
      &mut SpecReport::new(ID.into(), None),
    )
    .await
  }
  fn verbs(&self) -> Vec<String> {
    self
      .calls
      .lock()
      .unwrap()
      .iter()
      .map(|(v, _)| v.clone())
      .collect()
  }
  fn diagnostic(&self) -> Value {
    let bytes = std::fs::read_to_string(self.run_dir.join("lifecycle.json")).unwrap();
    assert!(
      !bytes.contains(SECRET),
      "host params and raw cleanup errors are never persisted"
    );
    serde_json::from_str(&bytes).unwrap()
  }
}

#[cfg(unix)]
#[tokio::test]
async fn output_mkdir_refusal_calls_no_host_verbs() {
  use std::os::unix::fs::PermissionsExt;
  let rig = rig(true, Fault::None, false);
  let test_dir = rig.root.join("corpus").join(ID);
  std::fs::create_dir_all(&test_dir).unwrap();
  std::fs::write(test_dir.join("spec.yaml"), SPEC).unwrap();
  std::fs::set_permissions(&test_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
  let error = rig
    .run(SPEC, true)
    .await
    .err()
    .expect("0555 corpus refuses run creation");
  assert!(format!("{error:#}").contains("create run dir"), "{error:#}");
  assert!(
    rig.verbs().is_empty(),
    "output refusal must precede all mutations: {:?}",
    rig.verbs()
  );
  assert!(*rig.active.lock().unwrap());
  assert_eq!(
    std::fs::read_to_string(test_dir.join("spec.yaml")).unwrap(),
    SPEC
  );
}

#[cfg(unix)]
#[tokio::test]
async fn existing_unwritable_run_refuses_before_setup() {
  use std::os::unix::fs::PermissionsExt;
  let rig = rig(false, Fault::None, false);
  std::fs::create_dir_all(&rig.run_dir).unwrap();
  std::fs::set_permissions(&rig.run_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
  let error = rig
    .run(SPEC, true)
    .await
    .err()
    .expect("must test writes, not just mkdir");
  assert!(format!("{error:#}").contains("output"), "{error:#}");
  assert!(rig.verbs().is_empty(), "{:?}", rig.verbs());
}

async fn partial_setup(index: usize, cleanup_fails: bool) {
  let rig = rig(false, Fault::Setup(index), cleanup_fails);
  let error = rig
    .run(SPEC, true)
    .await
    .err()
    .expect("setup failure remains an error");
  assert!(
    format!("{error:#}").contains(&format!("primary setup failure {}", index + 1)),
    "{error:#}"
  );
  assert!(!format!("{error:#}").contains("cleanup leaked"));
  let mut expected = vec!["delete_fixture"];
  if index > 0 {
    expected.push("create_inactive");
  }
  expected.extend(["restore_declared", "cleanup_tail"]);
  assert_eq!(
    rig.verbs(),
    expected,
    "only declared cleanup runs, once and in order"
  );
  let diagnostic = rig.diagnostic();
  assert_eq!(diagnostic["phase"], "setup");
  assert_eq!(
    diagnostic["teardown"][0]["outcome"],
    if cleanup_fails { "failed" } else { "succeeded" }
  );
  assert_eq!(diagnostic["teardown"][1]["outcome"], "succeeded");
  assert_eq!(*rig.active.lock().unwrap(), !cleanup_fails);
}
#[tokio::test]
async fn failure_after_delete_attempts_declared_cleanup_once() {
  partial_setup(0, false).await;
}
#[tokio::test]
async fn failure_after_inactive_creation_attempts_declared_cleanup_once() {
  partial_setup(1, false).await;
}
#[tokio::test]
async fn cleanup_failure_preserves_primary_and_continues_sanitized() {
  partial_setup(1, true).await;
}

async fn session_failure(fault: Fault, expected: &str, cleanup_fails: bool) {
  let rig = rig(false, fault, cleanup_fails);
  let error = rig
    .run(SPEC, true)
    .await
    .err()
    .expect("session write must fail");
  assert!(format!("{error:#}").contains(expected), "{error:#}");
  assert_eq!(
    rig.verbs(),
    [
      "delete_fixture",
      "create_inactive",
      "create_promo",
      "restore_declared",
      "cleanup_tail"
    ]
  );
  let calls = rig.calls.lock().unwrap();
  assert_eq!(
    calls[3].1,
    json!({"code": SECRET}),
    "post-setup params resolve; store_as is stripped"
  );
  drop(calls);
  {
    assert_eq!(rig.diagnostic()["phase"], "session-creation");
    assert_eq!(
      rig.diagnostic()["teardown"][0]["outcome"],
      if cleanup_fails { "failed" } else { "succeeded" }
    );
  }
  assert_eq!(*rig.active.lock().unwrap(), !cleanup_fails);
}
#[tokio::test]
async fn session_json_failure_after_setup_cleans_up() {
  session_failure(Fault::SessionFile, "Failed to write session.json", false).await;
}
#[tokio::test]
async fn spec_snapshot_failure_after_setup_cleans_up() {
  session_failure(Fault::SpecFile, "Failed to write spec.yaml", false).await;
}
#[tokio::test]
async fn session_failure_and_cleanup_failure_keep_session_error() {
  session_failure(Fault::SessionFile, "Failed to write session.json", true).await;
}
#[cfg(unix)]
#[tokio::test]
async fn revoked_output_cannot_mask_primary_or_prevent_cleanup() {
  session_failure(Fault::OutputRevoked, "Failed to write session.json", false).await;
}

#[tokio::test]
async fn no_setup_means_no_early_teardown_on_session_error() {
  let rig = rig(false, Fault::None, false);
  std::fs::create_dir_all(rig.run_dir.join("session.json")).unwrap();
  let spec = SPEC.replacen(
    "setup:\n  - action: delete_fixture\n  - action: create_inactive\n  - action: create_promo\n",
    "",
    1,
  );
  assert!(rig.run(&spec, true).await.is_err());
  assert!(rig.verbs().is_empty());
  assert_eq!(rig.diagnostic()["teardown"], json!([]));
}

#[tokio::test]
async fn successful_no_wait_keeps_post_setup_session_resolution() {
  let rig = rig(true, Fault::None, false);
  let outcome = rig.run(SPEC, true).await.unwrap();
  assert_eq!(outcome.outcome, Outcome::Pass);
  assert_eq!(
    rig.verbs(),
    ["delete_fixture", "create_inactive", "create_promo"]
  );
  let session = rig.ctx.logger().get_session(ID).unwrap();
  assert_eq!(session.instructions, [format!("Inspect {SECRET}")]);
  assert_eq!(session.display_params.unwrap()[0].value, SECRET);
  assert_eq!(
    session.metadata.unwrap()["targetPath"],
    format!("/promo/{SECRET}")
  );
  let saved = rig.ctx.logger().read_spec(ID).unwrap().unwrap();
  assert_eq!(saved.params["promo_code"], SECRET);
}

#[tokio::test]
async fn successful_completed_run_uses_normal_teardown_once() {
  let rig = rig(false, Fault::None, false);
  let logger = rig.ctx.logger();
  let ready = rig.run_dir.join("spec.yaml");
  let completion = tokio::spawn(async move {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
      while !ready.is_file() {
        tokio::task::yield_now().await;
      }
      logger
        .mark_complete(ID, SessionResult::Success, None)
        .unwrap();
    })
    .await
    .unwrap();
  });
  let outcome = rig.run(SPEC, false).await.unwrap();
  completion.await.unwrap();
  assert_eq!(outcome.outcome, Outcome::Pass);
  assert_eq!(
    rig.verbs(),
    [
      "delete_fixture",
      "create_inactive",
      "create_promo",
      "restore_declared",
      "cleanup_tail"
    ]
  );
  assert!(*rig.active.lock().unwrap());
  let verdict: Value =
    serde_json::from_slice(&std::fs::read(rig.run_dir.join("verification.json")).unwrap()).unwrap();
  assert_eq!(verdict["outcome"], "passed");
}

#[tokio::test]
async fn setup_failure_without_declared_teardown_does_not_invent_cleanup() {
  let rig = rig(false, Fault::Setup(0), false);
  let spec = SPEC.replace(
    "teardown:\n  - action: restore_declared\n    code: '{{promo_code}}'\n    store_as: ignored\n  - action: cleanup_tail\n",
    "",
  );
  let error = rig.run(&spec, true).await.err().unwrap();
  assert!(format!("{error:#}").contains("primary setup failure 1"));
  assert_eq!(rig.verbs(), ["delete_fixture"]);
  assert!(
    !*rig.active.lock().unwrap(),
    "the SDK must not invent a restoration grant"
  );
  assert_eq!(rig.diagnostic()["teardown"], json!([]));
}

// A command endpoint may refuse before any fixture mutation. Exercise the real
// HostPort preflight with a local failing hello; no provider or account is used.
#[cfg(unix)]
async fn preflight_refusal(nested: bool, output_blocked: bool) {
  let mut rig = rig(nested, Fault::None, false);
  let hello_marker = rig.root.join("hello-seen");
  let call_marker = rig.root.join("call-seen");
  let command = |marker: &PathBuf| {
    json!({
      "transport": "local",
      "program": "/bin/sh",
      "args": ["-c", "printf seen > \"$1\"; exit 1", "lifecycle-fixture", marker]
    })
  };
  let bindings: serde_json::Map<String, Value> = rig
    .ctx
    .port()
    .verbs()
    .iter()
    .map(|action_name| {
      (
        action_name.clone(),
        json!({
          "operation": action_name, "version": 1, "effect": "read", "sensitive": false,
          "params": {}, "result": "boolean"
        }),
      )
    })
    .collect();
  let config = serde_json::from_value(json!({
    "schema": "ux.admin-command/v1", "wire_schema": "lifecycle.fixture/v1",
    "product": "lifecycle-fixture", "artifact": "fixture",
    "expected": {"environment": "test"},
    "hello": command(&hello_marker), "call": command(&call_marker),
    "timeout_ms": 1000, "bindings": bindings
  }))
  .unwrap();
  rig.ctx = UxTestCtx::new(
    Arc::new(Env {
      root: rig.root.clone(),
      nested,
    }),
    HostPort::from_commands(config).unwrap(),
  );
  if output_blocked {
    // Output reservation would fail here if it were moved before preflight.
    std::fs::write(rig.root.join("flat"), "output path blocker").unwrap();
  }
  let error = rig
    .run(SPEC, true)
    .await
    .err()
    .expect("preflight must refuse");
  assert!(
    format!("{error:#}").contains("preflight refused"),
    "{error:#}"
  );
  assert!(
    hello_marker.is_file(),
    "the selected endpoint was preflighted"
  );
  assert!(
    !call_marker.exists(),
    "no setup or teardown command was dispatched"
  );
  assert!(rig.verbs().is_empty());
  assert!(*rig.active.lock().unwrap());
  assert!(
    !rig.run_dir.exists(),
    "preflight refusal must not reserve run output"
  );
  if output_blocked {
    assert_eq!(
      std::fs::read_to_string(rig.root.join("flat")).unwrap(),
      "output path blocker"
    );
  } else {
    assert!(!rig.root.join("corpus").exists(), "no corpus run artifacts");
  }
}

#[cfg(unix)]
#[tokio::test]
async fn command_preflight_refusal_creates_no_run_output_or_fixture_calls() {
  preflight_refusal(true, false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn command_preflight_refusal_precedes_output_reservation_failure() {
  preflight_refusal(false, true).await;
}
