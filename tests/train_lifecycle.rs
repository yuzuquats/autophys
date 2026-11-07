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
    elif mode == 'blocked-sink':
        os.write(2 if phase == 'plan' else 1, b'x' * 262144)
        (root / 'forwarded').write_text('worker pipes drained')
        time.sleep(600)
    elif mode == 'normal-output':
        print('worker diagnostic marker', file=sys.stderr, flush=True)
    elif mode == 'stall': time.sleep(600)
    elif mode == 'no-newline':
        while True: os.write(1, b'x' * 8192)
    elif mode == 'stderr-flood':
        while True: os.write(2, b'x' * 8192)
    elif mode == 'json-flood':
        while True: os.write(1, b'{"step":1,"val_nll":0.4}\n' * 256)
    elif mode == 'nonzero-small':
        print('captured diagnostic marker', flush=True)
        sys.exit(9)
    elif mode == 'nonzero-stdout':
        os.write(1, b'x' * 262144)
        (root / 'capture-complete').write_text('worker stdout complete')
        sys.exit(9)
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
/// Bounds for waiting on a precondition (a file, a worker phase). They only
/// keep a broken test from hanging; the behavior budgets are separate.
const SETUP: Duration = Duration::from_secs(30);

/// The first launch of a freshly linked executable can take seconds on macOS
/// (signature assessment of a 100 MB debug binary), which would otherwise be
/// charged to whichever timed test spawns it first.
fn warm_binary() {
    static WARM: std::sync::Once = std::sync::Once::new();
    WARM.call_once(|| {
        let status = Command::new(env!("CARGO_BIN_EXE_autophys"))
            .arg("--version")
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    });
}

impl Lab {
    fn new() -> Self {
        warm_binary();
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
    let until = Instant::now() + SETUP;
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
    let until = Instant::now() + SETUP;
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

// Keep stderr's read end open but never read it, including while waiting for
// terminal state and exit. The polling watchdog runs outside the CLI. It kills
// only task-owned processes on regression, so a failing test cannot hang CI.
fn undrained(phase: &str, interrupt: bool, closed: bool) {
    let lab = Lab::new();
    let mut child = lab
        .command("sink", phase == "live", "blocked-sink", phase)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pipe = child.stderr.take().unwrap();
    let held_pipe = if closed {
        drop(pipe);
        None
    } else {
        Some(pipe)
    };
    let started = Instant::now();
    let mut sent = false;
    let status = loop {
        if interrupt && !sent && lab.root.path().join("forwarded").exists() {
            assert_eq!(unsafe { kill(child.id() as i32, 2) }, 0);
            sent = true;
        }
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if started.elapsed() >= Duration::from_secs(9) {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if status.is_none() {
        if let Ok(text) = std::fs::read_to_string(lab.root.path().join("worker.pid")) {
            let pid: i32 = text.parse().unwrap();
            unsafe {
                kill(-pid, 9);
            }
        }
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert!(
        status.is_some(),
        "CLI blocked with undrained stderr: {phase}"
    );
    assert_eq!(status.unwrap().code(), Some(1));
    assert!(started.elapsed() < Duration::from_secs(if interrupt || closed { 4 } else { 8 }));
    if interrupt {
        assert!(sent, "interruption must reach output boundary");
    }
    if phase == "live" {
        let manifest = lab.manifest("sink");
        assert_eq!(manifest["status"], "failed");
        assert_eq!(manifest["remote_status"], "unconfirmed");
        let error = manifest["worker_error"].as_str().unwrap();
        assert!(
            error.contains(if closed {
                "echoing"
            } else if interrupt {
                "interrupted"
            } else {
                "deadline"
            }),
            "{error}"
        );
    } else {
        assert!(!lab.dir("sink").join("manifest.json").exists());
    }
    lab.reaped();
    // The held sink is released only after CLI exit, state and reaping checks.
    drop(held_pipe);
}

#[test]
fn undrained_stderr_cannot_suspend_planner_or_live_deadline_or_cli_exit() {
    for phase in ["plan", "live"] {
        undrained(phase, false, false);
    }
}

#[test]
fn interruption_at_saturated_stderr_and_closed_pipes_reap_and_exit() {
    for phase in ["plan", "live"] {
        undrained(phase, true, false);
        undrained(phase, false, true);
    }
}

#[test]
fn normal_worker_diagnostics_remain_visible() {
    for phase in ["plan", "live"] {
        let lab = Lab::new();
        let out = lab
            .command("normal", phase == "live", "normal-output", phase)
            .output()
            .unwrap();
        checked(&out);
        assert!(String::from_utf8_lossy(&out.stderr).contains("worker diagnostic marker"));
        lab.reaped();
    }
}

// Completed capture forwarding must be bounded too: the worker is already
// gone, but a blocking print would retain the CLI and same-name reservation.
#[test]
fn completed_capture_diagnostics_exit_and_release_reservation_before_sink_release() {
    for dataset in [false, true] {
        for closed in [false, true] {
            let lab = Lab::new();
            let previous = b"{\"name\":\"capture\",\"status\":\"failed\",\"retained\":7}";
            let mut command = if dataset {
                std::fs::write(
                    lab.root.path().join("build_dataset.py"),
                    r#"
import os
from pathlib import Path
root = Path(__file__).parent
(root / 'worker.pid').write_text(str(os.getpid()))
os.write(1, b'x' * 262144)
(root / 'capture-complete').write_text('worker stdout complete')
"#,
                )
                .unwrap();
                let mut command = Command::new(env!("CARGO_BIN_EXE_autophys"));
                command
                    .env_clear()
                    .env("HOME", lab.root.path())
                    .env("PATH", "/usr/bin:/bin")
                    .env("TMPDIR", lab.root.path())
                    .env("PYTHONDONTWRITEBYTECODE", "1")
                    .env("AUTOPHYS_TRAIN_WORKER_TIMEOUT_SECONDS", "5")
                    .env("AUTOPHYS_TRAIN_WORKER_GRACE_SECONDS", "2")
                    .env("AUTOPHYS_TRAIN_WORKER_OUTPUT_BYTES", "1048576")
                    .args(["train", "dataset", "--json", "--out"])
                    .arg(&lab.data)
                    .arg("--train-dir")
                    .arg(lab.root.path())
                    .args(["--python", "/usr/bin/python3"]);
                command
            } else {
                lab.seed("capture", previous);
                lab.command("capture", false, "nonzero-stdout", "plan")
            };
            let mut child = command
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let sink = child.stderr.take().unwrap();
            let held = if closed {
                drop(sink);
                None
            } else {
                Some(sink)
            };
            let started = Instant::now();
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break Some(status);
                }
                if started.elapsed() > Duration::from_secs(3) {
                    break None;
                }
                std::thread::sleep(Duration::from_millis(10));
            };
            if status.is_none() {
                child.kill().unwrap();
                child.wait().unwrap();
            }
            assert!(status.is_some(), "completed capture retained CLI");
            assert_eq!(
                status.unwrap().code(),
                Some(if dataset && !closed { 0 } else { 1 })
            );
            assert!(lab.root.path().join("capture-complete").exists());
            lab.reaped();
            if dataset && !closed {
                let output = child.wait_with_output().unwrap();
                let body: Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(body["backend"], "local");
                assert_eq!(body["files"]["train"]["rows"], 1);
            } else if !dataset {
                assert_eq!(
                    std::fs::read(lab.dir("capture").join("manifest.json")).unwrap(),
                    previous
                );
                // This actual retry proves reservation reuse while the original
                // stderr read end is still held open and undrained.
                checked(
                    &lab.command("capture", false, "ok", "plan")
                        .output()
                        .unwrap(),
                );
                assert_eq!(lab.manifest("capture")["status"], "planned");
            }
            drop(held);
        }
    }
}

#[test]
fn normal_failed_capture_diagnostics_remain_visible() {
    let lab = Lab::new();
    let out = lab
        .command("captured", false, "nonzero-small", "plan")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("captured diagnostic marker") && stderr.contains("exited unsuccessfully")
    );
    assert!(out.stdout.is_empty());
    lab.reaped();
}
