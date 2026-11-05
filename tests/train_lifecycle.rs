//! Offline launcher/state faults. These workers cannot call a provider or
//! download a model. Test budgets: 5s deadline, 2s grace, 1MiB output total.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const WORKER: &str = r#"
import json, os, sys, time
from pathlib import Path
root = Path(__file__).parent
assert os.environ['OFFLINE_TRAIN_TEST'] == '1'
args = sys.argv[1:]
live = '--live' in args
name = args[args.index('--name') + 1]
(root / 'worker.pid').write_text(str(os.getpid()))
with (root / 'calls').open('a') as f: f.write(('live' if live else 'plan') + '\n')
mode = os.environ.get('FAULT', 'ok')
phase = os.environ.get('FAULT_PHASE', 'live')
if (live and phase == 'live') or (not live and phase == 'plan'):
    if mode == 'slow-plan':
        while not (root / 'release').exists(): time.sleep(.01)
    elif mode == 'stall': time.sleep(600)
    elif mode == 'no-newline':
        while True: os.write(1, b'x' * 8192)
    elif mode == 'stderr-flood':
        while True: os.write(2, b'x' * 8192)
    elif mode == 'json-flood':
        while True: os.write(1, b'{"step":1,"val_nll":0.4}\n' * 256)
    elif mode == 'nonzero': sys.exit(9)
    elif mode == 'read-failure': os.write(1, b'\xff\n'); time.sleep(600)
if not live:
    print(json.dumps({'billed_token_estimate': {'total': 2000000}}), flush=True)
else:
    for i in range(3000): print(json.dumps({'step':i, 'val_nll': 0.4}))
    out = root / 'runs' / name / 'run.json'
    if mode == 'malformed-result': out.write_text('{}')
    elif mode != 'no-result': out.write_text(json.dumps({'run_id': 'new-offline-run', 'sampler_weights':'offline-weights', 'state':'offline-state'}))
"#;

struct Lab {
    root: tempfile::TempDir,
    data: PathBuf,
}
impl Lab {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        std::fs::create_dir(&data).unwrap();
        for split in ["train", "validation"] {
            std::fs::write(data.join(format!("{split}.jsonl")), "{}\n").unwrap();
        }
        std::fs::write(root.path().join("train_sft.py"), WORKER).unwrap();
        Self { root, data }
    }
    fn command(&self, name: &str, live: bool, fault: &str, phase: &str) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_autophys"));
        cmd.env_clear()
            .env("HOME", self.root.path())
            .env("PATH", "/usr/bin:/bin")
            .env("TMPDIR", self.root.path())
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("OFFLINE_TRAIN_TEST", "1")
            .env("BASETEN_API_KEY", "synthetic-offline-test-key")
            .env("FAULT", fault)
            .env("FAULT_PHASE", phase)
            .env("AUTOPHYS_TRAIN_WORKER_TIMEOUT_SECONDS", "5")
            .env("AUTOPHYS_TRAIN_WORKER_GRACE_SECONDS", "2")
            .env("AUTOPHYS_TRAIN_WORKER_OUTPUT_BYTES", "1048576")
            .args([
                "train",
                "run",
                "--json",
                "--name",
                name,
                "--base-model",
                "offline-model",
                "--data",
            ])
            .arg(&self.data)
            .args(["--train-dir"])
            .arg(self.root.path())
            .args([
                "--python",
                "/usr/bin/python3",
                "--usd-per-mtok",
                "1",
                "--max-usd",
                "3",
            ]);
        if live {
            cmd.arg("--live");
        }
        cmd
    }
    fn dir(&self, name: &str) -> PathBuf {
        self.root.path().join("runs").join(name)
    }
    fn manifest(&self, name: &str) -> Value {
        serde_json::from_slice(&std::fs::read(self.dir(name).join("manifest.json")).unwrap())
            .unwrap()
    }
    fn seed(&self, name: &str, bytes: &[u8]) {
        std::fs::create_dir_all(self.dir(name)).unwrap();
        std::fs::write(self.dir(name).join("manifest.json"), bytes).unwrap();
    }
    fn reaped(&self) {
        let pid: i32 = std::fs::read_to_string(self.root.path().join("worker.pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(!alive(pid), "worker {pid} was not reaped");
    }
}

unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}
fn alive(pid: i32) -> bool {
    unsafe { kill(pid, 0) == 0 }
}
fn checked(out: &Output) {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn wait_for(path: &Path) {
    let until = Instant::now() + Duration::from_secs(3);
    while !path.exists() {
        assert!(Instant::now() < until, "missing {}", path.display());
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn offline_and_live_conflicts_preserve_running_completed_bytes_before_planning() {
    for status in ["running", "completed"] {
        let lab = Lab::new();
        let bytes = format!(
            "{{\"name\":\"reserved\",\"status\":\"{status}\",\"run_id\":\"retained\",\"data\":{{\"identity\":7}}}}\n"
        );
        lab.seed("reserved", bytes.as_bytes());
        for live in [false, true] {
            let out = lab
                .command("reserved", live, "ok", "live")
                .output()
                .unwrap();
            assert!(!out.status.success());
            assert!(String::from_utf8_lossy(&out.stderr).contains("pick a new --name"));
            assert_eq!(
                std::fs::read(lab.dir("reserved").join("manifest.json")).unwrap(),
                bytes.as_bytes()
            );
            assert!(!lab.root.path().join("calls").exists());
        }
        assert!(lab.dir("reserved").join("run.lock").exists());
    }
}

#[test]
fn malformed_or_mismatched_existing_manifest_is_actionable_and_unchanged() {
    for bytes in [
        b"{bad".as_slice(),
        b"{}",
        b"{\"name\":\"bad\",\"status\":4}",
        b"{\"name\":\"other\",\"status\":\"planned\"}",
    ] {
        let lab = Lab::new();
        lab.seed("bad", bytes);
        for live in [false, true] {
            let out = lab.command("bad", live, "ok", "live").output().unwrap();
            assert!(!out.status.success());
            assert!(String::from_utf8_lossy(&out.stderr).contains("malformed existing run"));
            assert_eq!(
                std::fs::read(lab.dir("bad").join("manifest.json")).unwrap(),
                bytes
            );
            assert!(!lab.root.path().join("calls").exists());
        }
    }
}

#[test]
fn concurrent_same_name_has_one_owner_for_both_offline_and_live() {
    for live in [false, true] {
        let lab = Lab::new();
        let mut first = lab
            .command("one", live, "slow-plan", "plan")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        wait_for(&lab.root.path().join("calls"));
        let second = lab.command("one", live, "ok", "live").output().unwrap();
        assert!(!second.status.success());
        assert!(String::from_utf8_lossy(&second.stderr).contains("reserved by another invocation"));
        std::fs::write(lab.root.path().join("release"), "go").unwrap();
        checked(&first.wait_with_output().unwrap());
        assert_eq!(
            lab.manifest("one")["status"],
            if live { "completed" } else { "planned" }
        );
        assert_eq!(
            std::fs::read_to_string(lab.root.path().join("calls")).unwrap(),
            if live { "plan\nlive\n" } else { "plan\n" }
        );
        lab.reaped();
    }
}

#[test]
fn planned_and_failed_retries_preserve_previous_identity_and_result_bytes() {
    for status in ["planned", "failed"] {
        let lab = Lab::new();
        checked(&lab.command("retry", false, "ok", "live").output().unwrap());
        let mut previous = lab.manifest("retry");
        previous["status"] = json!(status);
        previous["retained_marker"] = json!("old-identity");
        let bytes = serde_json::to_vec(&previous).unwrap();
        lab.seed("retry", &bytes);
        let old_result =
            b"{\"run_id\":\"old-run\",\"sampler_weights\":\"old-weights\",\"state\":null}";
        std::fs::write(lab.dir("retry").join("run.json"), old_result).unwrap();
        checked(&lab.command("retry", true, "ok", "live").output().unwrap());
        let current = lab.manifest("retry");
        assert_eq!(current["status"], "completed");
        assert_eq!(current["run_id"], "new-offline-run");
        assert_eq!(current["steps"], 3000);
        assert_eq!(current["last_val_nll"], 0.4);
        assert_eq!(current["data"], previous["data"]);
        assert_eq!(current["base_model"], previous["base_model"]);
        assert_ne!(current["attempt_id"], previous["attempt_id"]);
        assert_eq!(
            std::fs::read(
                lab.dir("retry")
                    .join(current["previous_manifest"].as_str().unwrap())
            )
            .unwrap(),
            bytes
        );
        assert_eq!(
            std::fs::read(lab.dir("retry").join(format!(
                "run.previous.{}.json",
                current["attempt_id"].as_str().unwrap()
            )))
            .unwrap(),
            old_result
        );
        assert_eq!(current["remote_status"], "unconfirmed");
        lab.reaped();
    }
}

#[test]
fn stale_or_malformed_worker_results_never_count_as_completion() {
    for fault in ["no-result", "malformed-result", "nonzero"] {
        let lab = Lab::new();
        checked(&lab.command("stale", false, "ok", "live").output().unwrap());
        std::fs::write(lab.dir("stale").join("run.json"), "{\"run_id\":\"stale\"}").unwrap();
        let out = lab.command("stale", true, fault, "live").output().unwrap();
        assert!(!out.status.success());
        assert_eq!(lab.manifest("stale")["status"], "failed");
        assert_eq!(lab.manifest("stale")["remote_status"], "unconfirmed");
        lab.reaped();
    }
}

#[test]
fn stalled_verbose_invalid_and_failed_workers_are_bounded_and_reaped() {
    for fault in [
        "stall",
        "no-newline",
        "stderr-flood",
        "json-flood",
        "nonzero",
        "read-failure",
    ] {
        let lab = Lab::new();
        let started = Instant::now();
        let out = lab.command("fault", true, fault, "live").output().unwrap();
        assert!(!out.status.success(), "{fault}");
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "unbounded {fault}"
        );
        assert!(
            out.stdout.len() + out.stderr.len() < 1048576 + 65536,
            "unbounded capture for {fault}"
        );
        let manifest = lab.manifest("fault");
        assert_eq!(manifest["status"], "failed");
        assert_eq!(manifest["remote_status"], "unconfirmed");
        if fault != "nonzero" {
            assert!(manifest["worker_error"].is_string());
        }
        lab.reaped();
    }
}

#[test]
fn planner_capture_has_the_same_deadline_and_output_bounds() {
    for fault in ["stall", "no-newline", "stderr-flood", "nonzero"] {
        let lab = Lab::new();
        let started = Instant::now();
        let out = lab
            .command("plan-fault", false, fault, "plan")
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(started.elapsed() < Duration::from_secs(8));
        assert!(out.stdout.len() + out.stderr.len() < 1048576 + 65536);
        assert!(!lab.dir("plan-fault").join("manifest.json").exists());
        lab.reaped();
    }
}

#[test]
fn interrupt_finalizes_local_failure_and_reaps_worker_without_claiming_remote_cancel() {
    let lab = Lab::new();
    let child = lab
        .command("interrupt", true, "stall", "live")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        if lab.dir("interrupt").join("manifest.json").exists()
            && lab.manifest("interrupt")["status"] == "running"
        {
            // Wait for the live worker, after the planner PID has gone away.
            if std::fs::read_to_string(lab.root.path().join("calls"))
                .unwrap_or_default()
                .contains("live")
            {
                break;
            }
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    let started = Instant::now();
    assert_eq!(unsafe { kill(child.id() as i32, 2) }, 0);
    let out = child.wait_with_output().unwrap();
    assert!(!out.status.success());
    assert!(started.elapsed() < Duration::from_secs(3));
    let manifest = lab.manifest("interrupt");
    assert_eq!(manifest["status"], "failed");
    assert_eq!(manifest["remote_status"], "unconfirmed");
    assert!(
        manifest["worker_error"]
            .as_str()
            .unwrap()
            .contains("interrupted")
    );
    lab.reaped();
}
