//! `autophys train`: post-training of a decision policy, driven from the CLI.
//!
//! Rust owns the workflow: building the dataset, the budget gate, run
//! manifests, evaluation and the run history. A Python worker from `train/sft`
//! (built into the binary, see [`install_code`]) does what has to live next
//! to the model: chat templates, tokenization and
//! the GPU step (today Baseten Loops). Training data is a view of synthetic
//! investigations; this module adds no state to the record store. Code and
//! data are separate (CLI-16): the workers run from a version-keyed code
//! cache or a `--train-dir`, and write runs, loops and datasets to the data
//! directory passed to them as `AUTOPHYS_TRAIN_DATA` (see [`train_dirs`]).
//!
//! Nothing here spends money unless `train run --live` or `train loop --live` passes the budget
//! gate: an explicit price, an explicit cap and an estimate under that cap.
//! Provider keys are only ever checked for presence, never read or written.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const USAGE: &str =
    "usage: autophys train dataset [--out DIR] [--train-seeds 0,1,2] [--val-seeds 5,6]
                               [--heldout-seeds 3,4] [--example REF]... [--playbook NAME]
                               [--backend local|modal --usd-per-hour X --max-usd Y]
       autophys train run --name NAME --base-model HF_ID --data DIR [--backend loops|modal]
                          [--model-assets DIR] [--rank N] [--epochs N] [--batch-size N] [--lr X] [--max-seq-len N]
                          [--warmup N] [--eval-every N] [--seed N] [--scope S]
                          loops: [--usd-per-mtok X --max-usd Y --live]   (serverless, billed per token)
                          loops: [--usd-per-hour X --max-usd Y --live]   (dedicated trainer, billed by GPU time)
                          modal: [--gpu L40S|A100-80GB|H100 --usd-per-hour X --max-usd Y --live]
       autophys train eval --out DIR [--model NAME] [--seeds 3,4] [--example REF]...
                           [--policy reason|scripted]... [--route baseten|meta|lane] [--replay FILE]
       autophys train eval --backend modal --run NAME --gpu GPU --usd-per-hour X --max-usd Y
                           [--out DIR] [--seeds 3,4] [--example REF]...
       autophys train loop --name LOOP --base-model HF_ID --gpu GPU --usd-per-hour X --max-usd TOTAL
                           [--iterations 3] [--patience 2] [--candidates FILE] [--eval-seeds 3,4]
                           [--model-assets DIR] [--example REF]... [--live] [--resume]
       autophys train runs | train loops
       (all take --train-dir DIR (AUTOPHYS_TRAIN_DIR; default: the built-in workers,
        installed in ~/.local/share/tento/autophys/train/code/VERSION-HASH/train/sft),
        --data-dir DIR (AUTOPHYS_TRAIN_DATA; runs, loops and datasets; default: the
        --train-dir if given, else ~/.local/share/tento/autophys/train/data)
        and --python FILE (AUTOPHYS_TRAIN_PYTHON, default python3 on PATH))
       worker limits: AUTOPHYS_TRAIN_WORKER_TIMEOUT_SECONDS (default 86400;
                      budgeted workers use provider timeout +120s unless overridden),
                      AUTOPHYS_TRAIN_WORKER_GRACE_SECONDS (default 2),
                      AUTOPHYS_TRAIN_WORKER_OUTPUT_BYTES (default 67108864)";

const BACKENDS: &[&str] = &["loops", "modal"];

/// Local launcher bounds. A remote budget still belongs to the provider;
/// killing a local process never confirms remote cancellation.
#[derive(Clone)]
struct WorkerLimits {
    deadline: std::time::Duration,
    grace: std::time::Duration,
    output_bytes: usize,
    explicit_deadline: bool,
}

impl WorkerLimits {
    fn from_env() -> Result<Self> {
        fn seconds(key: &str, default: f64) -> Result<std::time::Duration> {
            let value = std::env::var(key).ok();
            let seconds = value.as_deref().unwrap_or("").parse::<f64>().ok();
            if value.is_some() && seconds.is_none() {
                bail!("{key} must be finite and above zero");
            }
            let seconds = seconds.unwrap_or(default);
            if !seconds.is_finite() || seconds <= 0.0 {
                bail!("{key} must be finite and above zero");
            }
            std::time::Duration::try_from_secs_f64(seconds).context(key.to_string())
        }
        let output_bytes = std::env::var("AUTOPHYS_TRAIN_WORKER_OUTPUT_BYTES")
            .ok()
            .map(|v| v.parse::<usize>())
            .transpose()
            .context("AUTOPHYS_TRAIN_WORKER_OUTPUT_BYTES must be a positive integer")?
            .unwrap_or(64 * 1024 * 1024);
        if output_bytes == 0 {
            bail!("AUTOPHYS_TRAIN_WORKER_OUTPUT_BYTES must be positive");
        }
        Ok(Self {
            // Long serverless jobs have no provider wall-clock flag. One day
            // is a local default, overridable for longer intentional training.
            deadline: seconds("AUTOPHYS_TRAIN_WORKER_TIMEOUT_SECONDS", 86400.0)?,
            grace: seconds("AUTOPHYS_TRAIN_WORKER_GRACE_SECONDS", 2.0)?,
            output_bytes,
            explicit_deadline: std::env::var_os("AUTOPHYS_TRAIN_WORKER_TIMEOUT_SECONDS").is_some(),
        })
    }
}

#[derive(Default)]
struct WorkerEvents {
    steps: u64,
    last_val_nll: Value,
    gpu_seconds: Option<f64>,
}

impl WorkerEvents {
    fn line(&mut self, bytes: &[u8]) -> Result<()> {
        let line = std::str::from_utf8(bytes).context("reading worker stdout: invalid UTF-8")?;
        if let Some(start) = line.find('{') {
            if let Ok(Value::Object(event)) = serde_json::from_str::<Value>(&line[start..]) {
                if event.get("event").and_then(Value::as_str) == Some("eval_done") {
                    self.gpu_seconds = event.get("gpu_seconds").and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0);
                }
                if event.contains_key("step") {
                    self.steps += 1;
                }
                if let Some(value) = event.get("val_nll").filter(|v| v.is_number()) {
                    self.last_val_nll = value.clone();
                }
            }
        }
        Ok(())
    }
}

// Prefer a separate nonblocking description: never change stderr's shared
// flags (the parent/logger can share them). Full sinks discard the remaining
// chunk; a closed/broken sink fails this worker attempt. There is no forwarding
// queue or writer thread to retain or join.
//
// Where stderr cannot be reopened independently (macOS /dev/fd duplicates the
// original description and ignores O_NONBLOCK; Linux cannot open a socket's
// /dev/stderr), write the shared blocking descriptor only after poll() reports
// it writable, in chunks no larger than the smallest PIPE_BUF (512, Darwin).
// A pipe reports writable only with at least PIPE_BUF free, and such a write
// is atomic, so it does not block unless another writer to the same sink fills
// it between the poll and the write.
enum Diagnostics {
    Independent(std::fs::File),
    Polled(std::fs::File),
}

const POLLED_CHUNK: usize = 512;

#[repr(C)]
struct PollFd {
    fd: i32,
    events: i16,
    revents: i16,
}

unsafe extern "C" {
    fn fcntl(fd: i32, command: i32, ...) -> i32;
    #[cfg(target_os = "linux")]
    fn poll(fds: *mut PollFd, nfds: std::ffi::c_ulong, timeout: i32) -> i32;
    #[cfg(not(target_os = "linux"))]
    fn poll(fds: *mut PollFd, nfds: std::ffi::c_uint, timeout: i32) -> i32;
}

impl Diagnostics {
    fn open() -> std::io::Result<Self> {
        let stderr = unsafe { std::os::fd::BorrowedFd::borrow_raw(2) };
        match Self::independent() {
            Ok(Some(file)) => Ok(Self::Independent(file)),
            Ok(None) | Err(_) => Self::polled(stderr),
        }
    }

    fn independent() -> std::io::Result<Option<std::fs::File>> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "linux")]
        const NONBLOCK: i32 = 0x800;
        #[cfg(not(target_os = "linux"))]
        const NONBLOCK: i32 = 0x4; // Darwin O_NONBLOCK
        let file = std::fs::OpenOptions::new()
            .append(true)
            .custom_flags(NONBLOCK)
            .open("/dev/stderr")?;
        if file.metadata()?.is_file() {
            // Preserve a redirected file's shared offset with stdout. A regular
            // filesystem write is byte-bounded, but kernel/storage stalls are
            // outside the pipe/terminal backpressure guarantee.
            let fd = unsafe { std::os::fd::BorrowedFd::borrow_raw(2) };
            return Ok(Some(fd.try_clone_to_owned()?.into()));
        }
        // F_GETFL is 3 on supported Unix targets. Some /dev/fd implementations
        // duplicate the original description and ignore open flags.
        if unsafe { fcntl(file.as_raw_fd(), 3) } & NONBLOCK == 0 {
            return Ok(None);
        }
        Ok(Some(file))
    }

    fn polled(fd: std::os::fd::BorrowedFd<'_>) -> std::io::Result<Self> {
        Ok(Self::Polled(fd.try_clone_to_owned()?.into()))
    }

    /// Whether a polled sink can take one chunk now. Error/hangup states are
    /// reported as writable so the write itself surfaces the failure.
    fn writable(file: &std::fs::File) -> std::io::Result<bool> {
        use std::os::fd::AsRawFd;
        const POLLOUT: i16 = 0x4;
        const POLLERR: i16 = 0x8;
        const POLLHUP: i16 = 0x10;
        const POLLNVAL: i16 = 0x20;
        let mut fds = PollFd {
            fd: file.as_raw_fd(),
            events: POLLOUT,
            revents: 0,
        };
        loop {
            match unsafe { poll(&mut fds, 1, 0) } {
                -1 => {
                    let e = std::io::Error::last_os_error();
                    if e.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(e);
                }
                0 => return Ok(false),
                _ => return Ok(fds.revents & (POLLOUT | POLLERR | POLLHUP | POLLNVAL) != 0),
            }
        }
    }

    fn forward(&mut self, mut bytes: &[u8]) -> std::io::Result<()> {
        let polled = matches!(self, Self::Polled(_));
        let file = match self {
            Self::Independent(file) | Self::Polled(file) => file,
        };
        while !bytes.is_empty() {
            let chunk = if polled {
                if !Self::writable(file)? {
                    break;
                }
                &bytes[..bytes.len().min(POLLED_CHUNK)]
            } else {
                bytes
            };
            match file.write(chunk) {
                Ok(0) => break,
                Ok(n) => bytes = &bytes[n..],
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted && polled => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    break;
                }
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

enum WorkerOutput {
    Data(bool, Vec<u8>),
    Eof,
    Error(std::io::Error),
}

fn read_worker(mut pipe: impl Read, stdout: bool, tx: std::sync::mpsc::SyncSender<WorkerOutput>) {
    let mut buffer = [0u8; 8192];
    loop {
        let message = match pipe.read(&mut buffer) {
            Ok(0) => {
                let _ = tx.send(WorkerOutput::Eof);
                return;
            }
            Ok(n) => WorkerOutput::Data(stdout, buffer[..n].to_vec()),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                let _ = tx.send(WorkerOutput::Error(e));
                return;
            }
        };
        if tx.send(message).is_err() {
            return;
        }
    }
}

fn interrupt_flag() -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>> {
    use std::sync::{Arc, OnceLock, atomic::AtomicBool};
    static FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();
    if let Some(flag) = FLAG.get() {
        return Ok(flag.clone());
    }
    let handle = tokio::runtime::Handle::try_current()
        .context("training supervision needs a Tokio runtime")?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let flag = Arc::new(AtomicBool::new(false));
    let watched = flag.clone();
    handle.spawn(async move {
        tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
        watched.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let _ = FLAG.set(flag.clone());
    Ok(flag)
}

// Unix process groups keep launcher descendants in the cleanup boundary.
// kill(2) is the only FFI here; these signal numbers are common to the supported
// Linux/macOS targets. No new process/dependency or deletion lock is needed.
unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}
fn signal_group(group: i32, signal: i32) -> bool {
    // SAFETY: a negative, positive-child-derived PGID addresses only this
    // command's new process group; no pointer or borrowed memory crosses FFI.
    unsafe { kill(-group, signal) == 0 }
}

struct ManagedWorker {
    child: std::process::Child,
    grace: std::time::Duration,
}

impl Drop for ManagedWorker {
    fn drop(&mut self) {
        let group = self.child.id() as i32;
        // SIGINT gives Python's finally blocks a chance to run. Escalation is
        // local cleanup, with remote state explicitly left unconfirmed.
        signal_group(group, 2);
        let until = std::time::Instant::now() + self.grace;
        while signal_group(group, 0) && std::time::Instant::now() < until {
            let _ = self.child.try_wait();
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        signal_group(group, 9);
        let _ = self.child.wait();
    }
}

/// Why a train command failed. Usage errors exit 2 (with USAGE); runtime
/// failures (worker, budget refusal, provider) exit 1. Bare `String` errors
/// come from argument validation, so they convert to `Usage`.
#[derive(Debug, PartialEq)]
pub enum Failure {
    Usage(String),
    Runtime(String),
}

impl Failure {
    /// The train-only CLI caller uses the same best-effort output boundary as
    /// workers. Even a final error must not wait for a stopped log collector.
    pub fn report(&self) {
        if let Ok(mut sink) = Diagnostics::open() {
            let message =
                crate::cli_error::render(&self.message(), matches!(self, Failure::Usage(_)));
            let _ = sink.forward(&message.as_bytes()[..message.len().min(16 * 1024)]);
        }
    }

    pub fn code(&self) -> i32 {
        match self {
            Failure::Usage(_) => 2,
            Failure::Runtime(_) => 1,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Failure::Usage(m) if m.contains("usage: autophys train") => m.clone(),
            Failure::Usage(m) => format!("{m}\n{USAGE}"),
            Failure::Runtime(m) => m.clone(),
        }
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::Usage(message)
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Failure::Usage(message.to_string())
    }
}

fn runtime(e: anyhow::Error) -> Failure {
    Failure::Runtime(format!("{e:#}"))
}

/// Run names become directory names under runs/.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.starts_with('.')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    {
        return Err(format!(
            "--name {name:?} must be letters, digits, '-', '_' or '.'"
        ));
    }
    Ok(())
}

/// A live run may reuse a name whose last attempt only planned or failed;
/// a running or completed run is never overwritten.
fn live_retry_allowed(previous_status: Option<&str>) -> Result<(), String> {
    match previous_status {
        None | Some("planned") | Some("failed") => Ok(()),
        Some(status) => Err(format!("already has status {status:?}; pick a new --name")),
    }
}
const SPLITS: &[&str] = &["train", "validation", "heldout"];
/// Valued flags every train command takes: where the workers and their
/// outputs are, and which interpreter runs them.
const WORKER_FLAGS: &[&str] = &["train-dir", "data-dir", "python"];

/// Parsed `--flag value` and `--switch` words. Unknown flags are refused so a
/// typo can never silently fall back to a default (such as a larger model).
#[derive(Debug, Default)]
struct Flags {
    values: BTreeMap<String, Vec<String>>,
    switches: BTreeSet<String>,
}

impl Flags {
    fn parse(args: Vec<String>, valued: &[&str], switches: &[&str]) -> Result<Self, String> {
        let mut flags = Flags::default();
        let mut words = args.into_iter();
        while let Some(word) = words.next() {
            let Some(name) = word.strip_prefix("--") else {
                return Err(format!("unexpected argument {word:?}"));
            };
            if name == "json" {
                continue; // rendering flag, handled by the composition root
            }
            let (name, inline) = match name.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (name, None),
            };
            if switches.contains(&name) && inline.is_none() {
                flags.switches.insert(name.to_string());
            } else if valued.contains(&name) || WORKER_FLAGS.contains(&name) {
                let value = match inline {
                    Some(value) => value,
                    None => words
                        .next()
                        .filter(|v| !v.starts_with("--"))
                        .ok_or_else(|| format!("--{name} needs a value"))?,
                };
                flags
                    .values
                    .entry(name.to_string())
                    .or_default()
                    .push(value);
            } else {
                return Err(format!("unknown option \"--{name}\"\n{USAGE}"));
            }
        }
        Ok(flags)
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.values
            .get(name)
            .and_then(|v| v.last())
            .map(String::as_str)
    }

    fn all(&self, name: &str) -> &[String] {
        self.values.get(name).map(Vec::as_slice).unwrap_or(&[])
    }

    fn require(&self, name: &str) -> Result<&str, String> {
        self.get(name)
            .ok_or_else(|| format!("--{name} is required\n{USAGE}"))
    }

    fn number(&self, name: &str) -> Result<Option<f64>, String> {
        self.get(name)
            .map(|v| {
                v.parse::<f64>()
                    .ok()
                    .filter(|x| x.is_finite() && *x >= 0.0)
                    .ok_or_else(|| format!("--{name} {v:?} is not a non-negative number"))
            })
            .transpose()
    }

    /// Re-emit the named flags for the Python worker, in a stable order.
    fn passthrough(&self, names: &[&str]) -> Vec<String> {
        let mut out = Vec::new();
        for name in names {
            for value in self.all(name) {
                out.push(format!("--{name}"));
                out.push(value.clone());
            }
        }
        out
    }
}

/// Where the worker scripts live, where their outputs go and which
/// interpreter runs them.
#[derive(Clone)]
struct Worker {
    dir: PathBuf,
    /// Passed to every worker as `AUTOPHYS_TRAIN_DATA`.
    data: PathBuf,
    python: PathBuf,
    limits: WorkerLimits,
}

// Return an absolute spelling without resolving the final symlink: a venv's
// bin/python may link to the system binary, but its spelling selects the venv.
fn find_python(python: &Path, search_path: Option<&std::ffi::OsStr>) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    let candidates: Vec<PathBuf> = if python.components().count() > 1 || python.is_absolute() {
        vec![python.to_path_buf()]
    } else {
        search_path
            .map(std::env::split_paths)
            .into_iter()
            .flatten()
            .map(|dir| dir.join(python))
            .collect()
    };
    for candidate in candidates {
        if candidate
            .metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        {
            return Ok(if candidate.is_absolute() {
                candidate
            } else {
                std::env::current_dir()?.join(candidate)
            });
        }
    }
    bail!(
        "python {} not found; set --python or AUTOPHYS_TRAIN_PYTHON, or activate a Python environment",
        python.display()
    )
}

mod embedded_workers {
    include!(concat!(env!("OUT_DIR"), "/train_workers.rs"));
}

mod embedded_sdk {
    include!(concat!(env!("OUT_DIR"), "/python_sdk.rs"));
}

/// What [`install_workers`] wrote: each file's path and the SHA-256 of the
/// bytes it wrote there.
const WORKER_MANIFEST: &str = ".autophys-workers.json";

type Files = &'static [(&'static str, &'static [u8])];

/// The code cache key of this binary's built-in workers and SDK:
/// `CARGO_PKG_VERSION-<first 12 hex of a SHA-256 over every embedded name and
/// its bytes>`. The version keeps the directory readable; the content hash
/// keeps two different builds of one version apart (a dirty tree or a source
/// export without Git has no meaningful commit), while two builds with
/// identical workers share a cache harmlessly.
fn code_key(version: &str, sets: &[Files]) -> String {
    let mut hasher = Sha256::new();
    for files in sets {
        for (name, bytes) in *files {
            hasher.update((name.len() as u64).to_le_bytes());
            hasher.update(name.as_bytes());
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }
        hasher.update(b"\0set");
    }
    format!("{version}-{}", &hex::encode(hasher.finalize())[..12])
}

/// This binary's [`code_key`], hashed once per process.
fn builtin_key() -> &'static str {
    static KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    KEY.get_or_init(|| {
        code_key(
            env!("CARGO_PKG_VERSION"),
            &[embedded_workers::FILES, embedded_sdk::FILES],
        )
    })
}

/// Installs the built-in code under `root` (`<app data>/train/code/<key>`):
/// the workers in `train/sft` and the Python SDK in `sdks/python`, the
/// `../../sdks/python` the workers' Modal images build from, as in a
/// checkout. Returns the workers' directory. Nothing the workers write goes
/// here: their outputs go to the data directory (see [`Worker::new`]).
fn install_code(root: &Path, workers: Files, sdk: Files) -> Result<PathBuf> {
    let dir = root.join("train").join("sft");
    for (target, files) in [
        (root.join("sdks").join("python"), sdk),
        (dir.clone(), workers),
    ] {
        let kept = install_workers(&target, files)
            .with_context(|| format!("installing the training workers in {}", target.display()))?;
        if !kept.is_empty() {
            let note = format!(
                "autophys train: kept {} edited file(s) in {} instead of the built-in version: {} (remove a file to restore it)\n",
                kept.len(),
                target.display(),
                kept.join(", ")
            );
            if let Ok(mut sink) = Diagnostics::open() {
                let _ = sink.forward(note.as_bytes());
            }
        }
    }
    Ok(dir)
}

/// Where `autophys train` runs its workers and where their outputs go.
#[derive(Debug, PartialEq)]
struct TrainDirs {
    /// The workers' directory: an explicit one (a checkout), or
    /// `<install>/train/sft`.
    code: PathBuf,
    /// The version-keyed cache (`<app data>/train/code/<key>`) to install the
    /// built-in code into, when no workers' directory is given.
    install: Option<PathBuf>,
    /// Runs, loops, datasets and anything else the workers write.
    data: PathBuf,
}

/// Code: an explicit `--train-dir`/`AUTOPHYS_TRAIN_DIR`, else the built-in
/// workers in `<app data>/train/code/<key>`. Data: `--data-dir`/
/// `AUTOPHYS_TRAIN_DATA`; else an explicit train directory keeps its outputs
/// beside its workers, as before; else `<app data>/train/data`, which
/// survives upgrades. Relative paths are made absolute against `cwd`,
/// because the workers run in another directory.
fn train_dirs(
    train_dir: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    app_data: impl FnOnce() -> Result<PathBuf>,
    key: &str,
    cwd: &Path,
) -> Result<TrainDirs> {
    let data_dir = data_dir.map(|d| cwd.join(d));
    if let Some(code) = train_dir.map(|d| cwd.join(d)) {
        let data = data_dir.unwrap_or_else(|| code.clone());
        return Ok(TrainDirs {
            code,
            install: None,
            data,
        });
    }
    let train = app_data()?.join("train");
    let install = train.join("code").join(key);
    Ok(TrainDirs {
        code: install.join("train").join("sft"),
        install: Some(install),
        data: data_dir.unwrap_or_else(|| train.join("data")),
    })
}

/// Writes `files` into `dir` and returns the ones it left alone because they
/// were edited. A file is written when it is missing, or when it still holds
/// the bytes an earlier install wrote, so an upgrade replaces it. A file with
/// other bytes (edited, or the user's own, such as a built dataset) is kept,
/// and so is one that was there before any install: it stays the user's even
/// when its bytes happen to match. Nothing is deleted: runs, loops and
/// datasets in `dir` are never touched.
fn install_workers(dir: &Path, files: &[(&str, &[u8])]) -> Result<Vec<String>> {
    std::fs::create_dir_all(dir)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(".autophys-workers.lock"))?;
    lock.lock()?;
    let manifest_path = dir.join(WORKER_MANIFEST);
    let mut manifest: BTreeMap<String, String> = match std::fs::read(&manifest_path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("reading {}", manifest_path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e.into()),
    };
    let mut kept = Vec::new();
    for (name, bytes) in files {
        let path = dir.join(name);
        let want = format!("{:x}", Sha256::digest(bytes));
        match std::fs::read(&path) {
            Ok(current) => {
                let have = format!("{:x}", Sha256::digest(&current));
                if have == want {
                    // Already current. The manifest keeps the hash an install
                    // last wrote: bytes that arrived some other way (the
                    // user's own, or an edit that happens to match) stay the
                    // user's, and a later version keeps them.
                    continue;
                }
                if manifest.get(*name) != Some(&have) {
                    kept.push(name.to_string());
                    continue;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(anyhow!("reading {}: {e}", path.display())),
        }
        replace_file(&path, bytes)?;
        manifest.insert(name.to_string(), want);
    }
    replace_file(&manifest_path, &serde_json::to_vec_pretty(&manifest)?)?;
    Ok(kept)
}

/// Writes `bytes` to `path` through a sibling temporary file and a rename,
/// so a reader never sees a partial file.
fn replace_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().expect("installed files have a parent");
    std::fs::create_dir_all(parent)?;
    let name = path.file_name().expect("installed files have a name");
    // create_new never follows or reuses whatever is already at a name, so
    // a leftover or planted file there is skipped, not written through.
    let mut attempt = 0u32;
    let (temp, mut file) = loop {
        let temp = parent.join(format!(
            ".{}.autophys-tmp-{}-{attempt}",
            name.to_string_lossy(),
            std::process::id()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
        {
            Ok(file) => break (temp, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt < 100 => {
                attempt += 1
            }
            Err(e) => bail!("writing {}: {e}", temp.display()),
        }
    };
    let written = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    if let Err(e) = written {
        // Only this call's own file, which create_new made.
        let _ = std::fs::remove_file(&temp);
        bail!("writing {}: {e}", path.display());
    }
    Ok(())
}

impl Worker {
    fn new(flags: &Flags) -> Result<Self> {
        let dirs = train_dirs(
            flags
                .get("train-dir")
                .map(PathBuf::from)
                .or_else(|| env_path("AUTOPHYS_TRAIN_DIR")),
            flags
                .get("data-dir")
                .map(PathBuf::from)
                .or_else(|| env_path("AUTOPHYS_TRAIN_DATA")),
            || Ok(tento_dirs::AppDirs::resolve(crate::app::APP_ID)?.data),
            builtin_key(),
            &std::env::current_dir()?,
        )?;
        let dir = match &dirs.install {
            Some(root) => install_code(root, embedded_workers::FILES, embedded_sdk::FILES)?,
            None => dirs.code.clone(),
        };
        let python = flags
            .get("python")
            .map(PathBuf::from)
            .or_else(|| env_path("AUTOPHYS_TRAIN_PYTHON"))
            .unwrap_or_else(|| PathBuf::from("python3"));
        let python = find_python(&python, std::env::var_os("PATH").as_deref())?;
        if !dir.join("train_sft.py").is_file() {
            bail!(
                "{} has no train_sft.py; set --train-dir or AUTOPHYS_TRAIN_DIR",
                dir.display()
            );
        }
        Ok(Worker {
            dir,
            data: dirs.data,
            python,
            limits: WorkerLimits::from_env()?,
        })
    }

    /// The entries of `<data>/<kind>` (`runs` or `loops`).
    fn listing(&self, kind: &str) -> Vec<PathBuf> {
        std::fs::read_dir(self.data.join(kind))
            .map(|e| e.flatten().map(|e| e.path()).collect())
            .unwrap_or_default()
    }

    fn budgeted(mut self, gate: &Value) -> Self {
        if !self.limits.explicit_deadline {
            if let Some(seconds) = gate["timeout_s"].as_u64() {
                // Let the provider/worker enforce its cap and report teardown
                // before the local supervisor interrupts the launcher.
                self.limits.deadline = std::time::Duration::from_secs(seconds.saturating_add(120));
            }
        }
        self
    }

    /// Both pipes are drained through a bounded channel, independently of
    /// line endings. The supervisor alone owns output/elapsed-time accounting.
    fn supervise(&self, argv: &[String], capture: bool) -> Result<(bool, String, WorkerEvents)> {
        use std::os::unix::process::CommandExt;
        use std::sync::{atomic::Ordering, mpsc};
        use std::time::{Duration, Instant};
        let interrupted = interrupt_flag()?;
        if interrupted.load(Ordering::SeqCst) {
            bail!("worker interrupted before launch");
        }
        let mut diagnostics =
            Diagnostics::open().context("opening nonblocking worker diagnostics")?;
        let child = Command::new(&self.python)
            .args(argv)
            .current_dir(&self.dir)
            .env("AUTOPHYS_TRAIN_DATA", &self.data)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .context("starting training worker")?;
        let mut owned = ManagedWorker {
            child,
            grace: self.limits.grace,
        };
        let (tx, rx) = mpsc::sync_channel(8);
        let stdout = owned.child.stdout.take().expect("piped stdout");
        let stderr = owned.child.stderr.take().expect("piped stderr");
        let other = tx.clone();
        let readers = [
            std::thread::spawn(move || read_worker(stdout, true, tx)),
            std::thread::spawn(move || read_worker(stderr, false, other)),
        ];
        let started = Instant::now();
        let result = (|| -> Result<_> {
            let mut total = 0usize;
            let mut eof = 0;
            let mut captured = Vec::new();
            let mut pending = Vec::new();
            let mut events = WorkerEvents::default();
            loop {
                if interrupted.load(Ordering::SeqCst) {
                    bail!("worker interrupted; remote cancellation is unconfirmed");
                }
                if started.elapsed() >= self.limits.deadline {
                    bail!("worker deadline exceeded; remote cancellation is unconfirmed");
                }
                if eof == 2 {
                    if let Some(status) = owned.child.try_wait()? {
                        if !capture && !pending.is_empty() {
                            events.line(&pending)?;
                        }
                        let stdout = String::from_utf8(captured)
                            .context("reading worker stdout: invalid UTF-8")?;
                        return Ok((status.success(), stdout, events));
                    }
                }
                match rx.recv_timeout(Duration::from_millis(20)) {
                    Ok(WorkerOutput::Eof) => eof += 1,
                    Ok(WorkerOutput::Error(e)) => return Err(e).context("reading worker pipe"),
                    Ok(WorkerOutput::Data(stdout, bytes)) => {
                        total = total
                            .checked_add(bytes.len())
                            .context("worker output count overflow")?;
                        if total > self.limits.output_bytes {
                            bail!(
                                "worker output budget exceeded ({} bytes); remote cancellation is unconfirmed",
                                self.limits.output_bytes
                            );
                        }
                        if capture && stdout {
                            captured.extend_from_slice(&bytes);
                        } else {
                            diagnostics
                                .forward(&bytes)
                                .context("echoing worker output")?;
                        }
                        if !capture && stdout {
                            for part in bytes.split_inclusive(|b| *b == b'\n') {
                                pending.extend_from_slice(part);
                                if pending.len() > self.limits.output_bytes.min(1024 * 1024) {
                                    bail!(
                                        "worker line budget exceeded; remote cancellation is unconfirmed"
                                    );
                                }
                                if part.last() == Some(&b'\n') {
                                    events.line(&pending)?;
                                    pending.clear();
                                }
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) if eof == 2 => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(e) => return Err(e).context("reading worker output channel"),
                }
            }
        })();
        // Drop the receiver first to release a reader blocked on a full queue,
        // then kill/reap the owned process group on every exit, then join readers.
        drop(rx);
        drop(owned);
        for reader in readers {
            let _ = reader.join();
        }
        result
    }

    fn capture(&self, script: &str, args: &[String]) -> Result<String> {
        let mut argv = vec![self.dir.join(script).display().to_string()];
        argv.extend_from_slice(args);
        let (ok, stdout, _) = self.supervise(&argv, true)?;
        if !ok {
            Diagnostics::open()
                .context("opening nonblocking captured diagnostics")?
                .forward(stdout.as_bytes())
                .context("echoing captured worker output")?;
            bail!("{script} exited unsuccessfully");
        }
        Ok(stdout)
    }

    fn stream(&self, script: &str, args: &[String]) -> Result<(bool, WorkerEvents)> {
        let mut argv = vec![self.dir.join(script).display().to_string()];
        argv.extend_from_slice(args);
        self.stream_raw(&argv)
    }

    fn stream_raw(&self, argv: &[String]) -> Result<(bool, WorkerEvents)> {
        let (ok, _, events) = self.supervise(argv, false)?;
        Ok((ok, events))
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn read_json(path: &Path) -> Result<Value> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("json.tmp.{}", attempt_id()?));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&tmp)?;
    file.write_all(format!("{}\n", serde_json::to_string_pretty(value)?).as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&tmp, path).with_context(|| {
        format!(
            "publishing {}; retained temporary {}",
            path.display(),
            tmp.display()
        )
    })?;

    Ok(())
}

/// Stable advisory lock: the file remains as accountable state; the kernel
/// releases ownership on normal exit, error, interruption or process death.
fn reserve_run(dir: &Path) -> Result<std::fs::File> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("run.lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)?;
    file.try_lock().map_err(|e| {
        anyhow!(
            "run is reserved by another invocation ({}): {e}",
            path.display()
        )
    })?;
    Ok(file)
}

fn attempt_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| anyhow!("creating training attempt identity: {e}"))?;
    Ok(hex::encode(bytes))
}

fn previous_manifest(path: &Path, name: &str) -> Result<Option<Vec<u8>>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(e).with_context(|| {
                format!(
                    "reading existing run {}; preserve it and choose a new --name",
                    path.display()
                )
            });
        }
    };
    let value: Value = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "malformed existing run {}; preserve it and choose a new --name",
            path.display()
        )
    })?;
    let status = value["status"].as_str().ok_or_else(|| {
        anyhow!(
            "malformed existing run {}: missing string status; choose a new --name",
            path.display()
        )
    })?;
    live_retry_allowed(Some(status)).map_err(|why| anyhow!("run {name:?} {why}"))?;
    if value["name"].as_str() != Some(name) {
        bail!(
            "malformed existing run {}: name identity differs; preserve it and choose a new --name",
            path.display()
        );
    }
    Ok(Some(bytes))
}

/// Content identity of a dataset directory: rows and sha256 per split, plus
/// the system-prompt hash that rendered it. Two runs with the same `data`
/// block trained on byte-identical inputs.
fn dataset_identity(dir: &Path) -> Result<Value> {
    let mut files = serde_json::Map::new();
    for split in SPLITS {
        let path = dir.join(format!("{split}.jsonl"));
        if !path.is_file() {
            if *split == "heldout" {
                continue;
            }
            bail!(
                "{} is missing; build it with `autophys train dataset`",
                path.display()
            );
        }
        let rows = std::fs::read_to_string(&path)?
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count();
        files.insert(
            split.to_string(),
            json!({"rows": rows, "sha256": sha256_file(&path)?}),
        );
    }
    let manifest = read_json(&dir.join("manifest.json")).ok();
    Ok(json!({
        "dir": dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf()).display().to_string(),
        "files": files,
        "system_prompt_sha256": manifest.as_ref().and_then(|m| m.get("system_prompt_sha256")).cloned(),
        "cases": manifest.as_ref().and_then(|m| m.get("cases")).cloned(),
        "playbook": manifest.as_ref().and_then(|m| m.get("playbook")).cloned(),
    }))
}

fn git_head() -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(crate::project_root())
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

const DATASET_FLAGS: &[&str] = &[
    "train-seeds",
    "val-seeds",
    "heldout-seeds",
    "case",
    "playbook",
];

fn absolute(path: PathBuf) -> Result<PathBuf> {
    Ok(if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    })
}

/// `train dataset`: renders synthetic trajectories into chat rows via the
/// Python SDK's own prompt code, then records the content identity. Local by
/// default (offline, free); `--backend modal` builds one case per container
/// under a budget cap and writes the same files.
pub fn dataset(args: Vec<String>) -> Result<Value, Failure> {
    let mut valued = vec!["out", "backend", "usd-per-hour", "max-usd"];
    valued.extend(DATASET_FLAGS);
    let flags = Flags::parse(args, &valued, &[])?;
    let backend = flags.get("backend").unwrap_or("local").to_string();
    if !["local", "modal"].contains(&backend.as_str()) {
        return Err(
            format!("--backend {backend:?} is not a dataset backend; use local or modal").into(),
        );
    }
    let gate = if backend == "modal" {
        Some(modal_budget(
            flags.number("usd-per-hour")?,
            flags.number("max-usd")?,
            Some("CPU"),
        ))
    } else {
        None
    };
    let run = || -> Result<Value> {
        let worker = Worker::new(&flags)?;
        let worker = if let Some(gate) = &gate {
            worker.budgeted(gate)
        } else {
            worker
        };
        let out = absolute(
            flags
                .get("out")
                .map(PathBuf::from)
                .unwrap_or_else(|| worker.data.join("data")),
        )?;
        if let Some(gate) = &gate {
            if gate["live_allowed"] != true {
                bail!(
                    "modal dataset refused: {}",
                    gate["refusal"].as_str().unwrap_or("budget gate")
                );
            }
            require_modal_credentials()?;
            let mut options = serde_json::Map::new();
            for name in DATASET_FLAGS {
                let values = flags.all(name);
                if *name == "case" {
                    if !values.is_empty() {
                        options.insert("case".into(), json!(values));
                    }
                } else if let Some(value) = values.last() {
                    options.insert(name.replace('-', "_"), json!(value));
                }
            }
            let argv = vec![
                "-m".into(),
                "modal".into(),
                "run".into(),
                worker
                    .dir
                    .join("modal_app.py::dataset_main")
                    .display()
                    .to_string(),
                "--out".into(),
                out.display().to_string(),
                "--budget-seconds".into(),
                gate["timeout_s"].to_string(),
                "--args".into(),
                Value::Object(options).to_string(),
            ];
            let (ok, _) = worker.stream_raw(&argv)?;
            if !ok {
                bail!("modal dataset build failed");
            }
        } else {
            let mut argv = vec!["--out".to_string(), out.display().to_string()];
            argv.extend(flags.passthrough(DATASET_FLAGS));
            let stdout = worker.capture("build_dataset.py", &argv)?;
            Diagnostics::open()
                .context("opening nonblocking captured diagnostics")?
                .forward(stdout.as_bytes())
                .context("echoing captured worker output")?;
        }
        let mut identity = dataset_identity(&out)?;
        identity["backend"] = json!(backend);
        if let Some(gate) = gate.clone() {
            identity["budget"] = gate;
        }
        Ok(identity)
    };
    run().map_err(runtime)
}

/// Modal bills by the second, so the cap is enforced as a hard timeout:
/// `max_usd / usd_per_hour`, less 20% for container CPU, memory and startup.
fn modal_budget(usd_per_hour: Option<f64>, max_usd: Option<f64>, gpu: Option<&str>) -> Value {
    let timeout = usd_per_hour
        .zip(max_usd)
        .filter(|(rate, _)| *rate > 0.0)
        .map(|(rate, cap)| (cap / rate * 3600.0 * 0.8).floor() as u64);
    let refusal = match (gpu, usd_per_hour, max_usd, timeout) {
        (None, ..) => Some("--gpu is required for a modal run (for example L40S, A100-80GB, H100)"),
        (_, None, ..) => Some("--usd-per-hour is required: the CLI never assumes a price"),
        (_, _, None, _) => Some("--max-usd is required: a modal job needs an explicit cap"),
        (_, _, _, None) => Some("--usd-per-hour must be above zero"),
        (_, _, _, Some(t)) if t < 120 => Some("--max-usd buys under two minutes at this rate"),
        _ => None,
    };
    json!({
        "gpu": gpu,
        "usd_per_hour": usd_per_hour,
        "max_usd": max_usd,
        "timeout_s": timeout,
        "enforced_by": "modal function timeout",
        "live_allowed": refusal.is_none(),
        "refusal": refusal,
    })
}

/// A dedicated Loops trainer bills GPU time, so its cap is a deadline like
/// Modal's; the worker deactivates the trainer when it passes.
fn loops_dedicated_budget(usd_per_hour: Option<f64>, max_usd: Option<f64>) -> Value {
    let mut gate = modal_budget(usd_per_hour, max_usd, Some("assigned by Baseten"));
    gate["gpu"] = Value::Null;
    gate["billing"] = json!("dedicated trainer, GPU time");
    gate["enforced_by"] = json!("worker deactivates the Loops deployment at the deadline");
    gate
}

/// Presence only; the Modal client reads its own token.
fn require_modal_credentials() -> Result<()> {
    let env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
        .iter()
        .all(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()));
    let file = env_path("HOME").is_some_and(|h| h.join(".modal.toml").is_file());
    if !env && !file {
        bail!(
            "no Modal credentials: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not in this process's environment and ~/.modal.toml is absent"
        );
    }
    Ok(())
}

/// The worker's dry-run summary is the first JSON value on its stdout.
fn first_json(stdout: &str) -> Result<Value> {
    let start = stdout
        .find('{')
        .ok_or_else(|| anyhow!("no JSON summary in worker output"))?;
    serde_json::Deserializer::from_str(&stdout[start..])
        .into_iter::<Value>()
        .next()
        .ok_or_else(|| anyhow!("no JSON summary in worker output"))?
        .context("parsing worker summary")
}

/// The budget decision for a live run, kept in the manifest either way.
fn budget(tokens: Option<f64>, usd_per_mtok: Option<f64>, max_usd: Option<f64>) -> Value {
    let usd = tokens
        .zip(usd_per_mtok)
        .map(|(t, p)| (t / 1e6 * p * 100.0).round() / 100.0);
    let refusal = match (tokens, usd_per_mtok, max_usd, usd) {
        (None, ..) => Some("the worker reported no billed-token estimate"),
        (_, None, ..) => Some("--usd-per-mtok is required: the CLI never assumes a price"),
        (_, _, None, _) => Some("--max-usd is required: a live run needs an explicit cap"),
        (_, _, Some(cap), Some(usd)) if usd > cap => Some("the estimate exceeds --max-usd"),
        _ => None,
    };
    json!({
        "billed_tokens": tokens,
        "usd_per_mtok": usd_per_mtok,
        "estimate_usd": usd,
        "max_usd": max_usd,
        "live_allowed": refusal.is_none(),
        "refusal": refusal,
    })
}

const HYPERPARAMETERS: &[&str] = &[
    "rank",
    "max-seq-len",
    "lr",
    "warmup",
    "batch-size",
    "epochs",
    "eval-every",
    "seed",
    "scope",
];

/// Hyperparameter flags as the Modal worker's config keys, numbers checked.
fn hyperparameter_json(flags: &Flags) -> Result<Value, String> {
    let mut out = serde_json::Map::new();
    for name in HYPERPARAMETERS.iter().filter(|n| **n != "scope") {
        if let Some(value) = flags.number(name)? {
            let key = name.replace('-', "_");
            out.insert(
                key,
                if *name == "lr" {
                    json!(value)
                } else {
                    json!(value as u64)
                },
            );
        }
    }
    Ok(Value::Object(out))
}

/// `train run`: always plans first (offline dry run, cost estimate, manifest);
/// trains only with `--live` and a passing budget gate.
pub fn run(args: Vec<String>) -> Result<Value, Failure> {
    let mut valued = vec![
        "name",
        "base-model",
        "data",
        "backend",
        "usd-per-mtok",
        "usd-per-hour",
        "gpu",
        "max-usd",
        "model-assets",
    ];
    valued.extend(HYPERPARAMETERS);
    let flags = Flags::parse(args, &valued, &["live"])?;
    let name = flags.require("name")?.to_string();
    check_name(&name)?;
    let base_model = flags.require("base-model")?.to_string();
    let data = PathBuf::from(flags.require("data")?);
    let backend = flags.get("backend").unwrap_or("loops").to_string();
    if !BACKENDS.contains(&backend.as_str()) {
        return Err(format!(
            "--backend {backend:?} is not available yet; supported: {}",
            BACKENDS.join(", ")
        )
        .into());
    }
    let usd_per_mtok = flags.number("usd-per-mtok")?;
    let usd_per_hour = flags.number("usd-per-hour")?;
    let max_usd = flags.number("max-usd")?;
    let live = flags.switches.contains("live");
    let hparams = hyperparameter_json(&flags)?;
    if backend == "modal" && flags.get("scope").is_some() {
        return Err("--scope is a Loops option; modal takes --gpu".into());
    }

    let go = || -> Result<Value> {
        let worker = Worker::new(&flags)?;
        let data = if data.is_absolute() {
            data.clone()
        } else {
            std::env::current_dir()?.join(&data)
        };
        let run_dir = worker.data.join("runs").join(&name);
        let manifest_path = run_dir.join("manifest.json");
        let _reservation = reserve_run(&run_dir)?;
        // Protect provenance before even the offline planner can run.
        let previous = previous_manifest(&manifest_path, &name)?;
        let attempt = attempt_id()?;
        let mut argv = vec![
            "--name".to_string(),
            name.clone(),
            "--base-model".to_string(),
            base_model.clone(),
            "--data".to_string(),
            data.display().to_string(),
        ];
        argv.extend(flags.passthrough(HYPERPARAMETERS));
        if let Some(assets) = flags.get("model-assets") {
            let assets = PathBuf::from(assets);
            let assets = if assets.is_absolute() {
                assets
            } else {
                std::env::current_dir()?.join(assets)
            };
            argv.extend(["--model-assets".into(), assets.display().to_string()]);
        }

        let plan = first_json(&worker.capture("train_sft.py", &argv)?)?;
        let tokens = plan
            .pointer("/billed_token_estimate/total")
            .and_then(Value::as_f64);
        let dedicated = backend == "loops" && usd_per_hour.is_some();
        let gate = if backend == "modal" {
            modal_budget(usd_per_hour, max_usd, flags.get("gpu"))
        } else if dedicated {
            loops_dedicated_budget(usd_per_hour, max_usd)
        } else {
            budget(tokens, usd_per_mtok, max_usd)
        };
        let mut manifest = json!({
            "name": name,
            "attempt_id": attempt,
            "backend": backend,
            "base_model": base_model,
            "status": "planned",
            "planned_at": now(),
            "git_head": git_head(),
            "data": dataset_identity(&data)?,
            "hyperparameters": flags.passthrough(HYPERPARAMETERS),
            "plan": plan,
            "budget": gate,
        });
        if let Some(previous) = previous {
            let archived = run_dir.join(format!("manifest.previous.{attempt}.json"));
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&archived)?;
            file.write_all(&previous)?;
            file.sync_all()?;
            manifest["previous_manifest"] = json!(archived.file_name().unwrap().to_string_lossy());
        }
        write_json(&manifest_path, &manifest)?;
        if !live {
            return Ok(manifest);
        }
        if gate["live_allowed"] != true {
            bail!(
                "live run refused: {}; the plan is in {}",
                gate["refusal"].as_str().unwrap_or("budget gate"),
                manifest_path.display()
            );
        }
        // Presence only: the worker reads the key itself; it is never copied here.
        if backend == "modal" {
            require_modal_credentials()?;
        } else if std::env::var_os("BASETEN_API_KEY").is_none_or(|v| v.is_empty()) {
            bail!("live run refused: BASETEN_API_KEY is not in this process's environment");
        }
        // Preserve earlier result bytes while requiring fresh evidence for this
        // attempt. Never count an old run.json as the new worker's completion.
        let record_path = run_dir.join("run.json");
        match std::fs::symlink_metadata(&record_path) {
            Ok(_) => std::fs::rename(
                &record_path,
                run_dir.join(format!("run.previous.{attempt}.json")),
            )?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).context("inspecting previous training result"),
        }
        let worker = worker.budgeted(&gate);

        manifest["status"] = json!("running");
        manifest["started_at"] = json!(now());
        write_json(&manifest_path, &manifest)?;
        let streamed = if backend == "modal" {
            worker.stream_raw(&[
                "-m".into(),
                "modal".into(),
                "run".into(),
                worker
                    .dir
                    .join("modal_app.py::train_main")
                    .display()
                    .to_string(),
                "--name".into(),
                name.clone(),
                "--base-model".into(),
                base_model.clone(),
                "--data".into(),
                data.display().to_string(),
                "--gpu".into(),
                gate["gpu"].as_str().unwrap_or_default().to_string(),
                "--timeout".into(),
                gate["timeout_s"].to_string(),
                "--model-assets".into(),
                flags
                    .get("model-assets")
                    .map(PathBuf::from)
                    .or_else(|| env_path("AUTOPHYS_TRAIN_MODEL_ASSETS"))
                    .map(absolute)
                    .transpose()?
                    .map(|p| p.display().to_string())
                    .unwrap_or_default(),
                "--planned-assets".into(),
                plan["model_assets"].to_string(),
                "--hparams".into(),
                hparams.to_string(),
            ])
        } else {
            argv.push("--live".into());
            if let Some(identity) = plan
                .pointer("/model_assets/manifest_sha256")
                .and_then(Value::as_str)
            {
                argv.extend(["--expected-assets-sha256".into(), identity.into()]);
            }
            if dedicated {
                argv.push("--allow-dedicated".into());
                argv.push("--max-seconds".into());
                argv.push(gate["timeout_s"].to_string());
            }
            worker.stream("train_sft.py", &argv)
        };
        let (ok, events, mut error) = match streamed {
            Ok((ok, events)) => (ok, events, None),
            Err(e) => (false, WorkerEvents::default(), Some(e)),
        };
        let record = match std::fs::read(&record_path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value)
                    if value["run_id"].as_str().is_some_and(|s| !s.is_empty())
                        && value["sampler_weights"]
                            .as_str()
                            .is_some_and(|s| !s.is_empty())
                        && value
                            .get("state")
                            .is_some_and(|v| v.is_null() || v.is_string())
                        && (backend != "modal"
                            || (plan["model_assets"].is_object()
                                && value["model_assets"] == plan["model_assets"]
                                && value["model_revision"]
                                    == plan["model_assets"]["revision"])) =>
                {
                    Some(value)
                }
                other => {
                    let why = format!(
                        "malformed worker result {}: {other:?}",
                        record_path.display()
                    );
                    error = Some(match error.take() {
                        Some(primary) => primary.context(why),
                        None => anyhow!(why),
                    });
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                error = Some(error.map_or_else(
                    || anyhow!("reading worker result: {e}"),
                    |primary| primary.context(format!("reading worker result also failed: {e}")),
                ));
                None
            }
        };
        manifest["remote_status"] = json!("unconfirmed");
        if let Some(e) = &error {
            manifest["worker_error"] = json!(format!("{e:#}"));
        }
        manifest["status"] = json!(if ok && record.is_some() {
            "completed"
        } else {
            "failed"
        });
        manifest["finished_at"] = json!(now());
        manifest["steps"] = json!(events.steps);
        manifest["last_val_nll"] = events.last_val_nll;
        if let Some(record) = &record {
            manifest["run_id"] = record["run_id"].clone();
            manifest["sampler_weights"] = record["sampler_weights"].clone();
            manifest["state"] = record["state"].clone();
            for key in [
                "heldout_decisions",
                "gpu_seconds",
                "end_of_turn",
                "trainer",
                "wall_seconds",
                "model_assets",
                "model_revision",
            ] {
                if let Some(value) = record.get(key) {
                    manifest[key] = value.clone();
                }
            }
        }
        if let Err(persist) = write_json(&manifest_path, &manifest) {
            return Err(match error {
                Some(primary) => primary.context(format!(
                    "also failed to persist terminal manifest: {persist:#}"
                )),
                None => persist,
            });
        }
        if let Some(error) = error {
            return Err(error.context(format!(
                "training worker failed; see {}",
                manifest_path.display()
            )));
        }
        if manifest["status"] != "completed" {
            bail!("training failed; see {}", manifest_path.display());
        }
        Ok(manifest)
    };
    go().map_err(runtime)
}

const EVAL_LOCAL: &[&str] = &["out", "model", "seeds", "case", "policy", "route", "replay"];
const EVAL_MODAL_ONLY: &[&str] = &["run", "gpu", "usd-per-hour", "max-usd", "model-assets"];
const EVAL_LOCAL_ONLY: &[&str] = &["model", "policy", "route", "replay"];

/// Which eval to run, decided from the flags alone (no I/O).
#[derive(Debug, PartialEq)]
enum EvalBackend {
    Local,
    Modal { run: String },
}

fn eval_backend(flags: &Flags) -> Result<EvalBackend, String> {
    let backend = flags.get("backend").unwrap_or("local");
    let misplaced = |names: &[&str], backend: &str| {
        names
            .iter()
            .find(|n| flags.get(n).is_some())
            .map(|n| format!("--{n} does not apply to --backend {backend}"))
    };
    match backend {
        "local" => {
            if let Some(err) = misplaced(EVAL_MODAL_ONLY, "local") {
                return Err(err);
            }
            flags.require("out")?;
            Ok(EvalBackend::Local)
        }
        "modal" => {
            if let Some(err) = misplaced(EVAL_LOCAL_ONLY, "modal") {
                return Err(err);
            }
            let run = flags.require("run")?.to_string();
            check_name(&run).map_err(|e| e.replace("--name", "--run"))?;
            Ok(EvalBackend::Modal { run })
        }
        other => Err(format!(
            "--backend {other:?} is not an eval backend; use local or modal"
        )),
    }
}

/// `train eval`: the held-out benchmark (reason vs scripted) through the SDK's
/// bench. Local: live endpoint calls also need AUTOPHYS_ALLOW_LIVE_REASON=1,
/// which the worker enforces; `--replay` runs offline from a cassette.
/// Modal: serves a completed Modal run's adapter next to its base model and
/// benchmarks it against scripted, under a hard timeout from the budget; the
/// report is also recorded in the run's manifest under `eval`.
pub fn eval(args: Vec<String>) -> Result<Value, Failure> {
    let mut names = vec!["backend"];
    names.extend(EVAL_LOCAL);
    names.extend(EVAL_MODAL_ONLY);
    let flags = Flags::parse(args, &names, &[])?;
    match eval_backend(&flags)? {
        EvalBackend::Local => eval_local(&flags).map_err(runtime),
        EvalBackend::Modal { run } => {
            let gate = modal_budget(
                flags.number("usd-per-hour")?,
                flags.number("max-usd")?,
                flags.get("gpu"),
            );
            eval_modal(&flags, &run, gate).map_err(runtime)
        }
    }
}

fn eval_local(flags: &Flags) -> Result<Value> {
    let worker = Worker::new(flags)?;
    let mut flags_abs = flags.passthrough(EVAL_LOCAL);
    // Paths are relative to the caller, not to the worker's directory.
    for i in (0..flags_abs.len()).step_by(2) {
        if matches!(flags_abs[i].as_str(), "--out" | "--replay") {
            flags_abs[i + 1] = absolute(PathBuf::from(&flags_abs[i + 1]))?
                .display()
                .to_string();
        }
    }
    let out = PathBuf::from(&flags_abs[flags_abs.iter().position(|w| w == "--out").unwrap() + 1]);
    let (ok, _) = worker.stream("eval_heldout.py", &flags_abs)?;
    if !ok {
        bail!("eval_heldout.py failed");
    }
    read_json(&out.join("report.json"))
}

fn eval_modal(flags: &Flags, run: &str, gate: Value) -> Result<Value> {
    let worker = Worker::new(flags)?.budgeted(&gate);
    let out = flags
        .get("out")
        .map(|o| absolute(PathBuf::from(o)))
        .transpose()?;
    eval_modal_run(
        &worker,
        run,
        gate,
        flags.get("seeds"),
        flags.all("case"),
        out,
        flags.get("model-assets").map(PathBuf::from)
            .or_else(|| env_path("AUTOPHYS_TRAIN_MODEL_ASSETS"))
            .map(absolute).transpose()?.as_deref(),
    )
    .map(|(report, _)| report)
}

/// The modal eval of a completed modal run, recorded in its manifest under
/// `eval`. Returns the report and the container's GPU seconds (if reported).
fn eval_modal_run(
    worker: &Worker,
    run: &str,
    gate: Value,
    seeds: Option<&str>,
    cases: &[String],
    out: Option<PathBuf>,
    assets: Option<&Path>,
) -> Result<(Value, Option<f64>)> {
    if gate["live_allowed"] != true {
        bail!(
            "modal eval refused: {}",
            gate["refusal"].as_str().unwrap_or("budget gate")
        );
    }
    let run_dir = worker.data.join("runs").join(run);
    let _reservation = reserve_run(&run_dir)?;
    let manifest_path = run_dir.join("manifest.json");
    let manifest = read_json(&manifest_path)
        .with_context(|| format!("run {run:?} has no manifest; train it first"))?;
    if manifest["backend"] != "modal" {
        bail!(
            "run {run:?} used backend {}; modal eval needs a modal run",
            manifest["backend"]
        );
    }
    if manifest["status"] != "completed" {
        bail!(
            "run {run:?} has status {}; only a completed run can be evaluated",
            manifest["status"]
        );
    }
    let base_model = manifest["base_model"]
        .as_str()
        .ok_or_else(|| anyhow!("run {run:?} manifest has no base_model"))?
        .to_string();
    require_modal_credentials()?;

    let out = out.unwrap_or_else(|| run_dir.join("eval"));
    let started_at = now();
    let (streamed, report, gpu_seconds) =
        modal_eval_call(worker, run, &base_model, &out, &gate, seeds, cases, false, assets, manifest.pointer("/plan/model_assets"));
    // Re-read so a concurrent `train runs` view or edit is not clobbered.
    let mut manifest = read_json(&manifest_path)?;
    let mut record = json!({
        "status": if report.is_some() { "completed" } else { "failed" },
        "out": out.display().to_string(),
        "gpu": gate["gpu"],
        "budget": gate,
        "gpu_seconds": gpu_seconds,
        "started_at": started_at,
        "finished_at": now(),
    });
    if let Some(report) = &report {
        record["report"] = report.clone();
    }
    manifest["eval"] = record;
    write_json(&manifest_path, &manifest)?;
    match (streamed, report) {
        (_, Some(report)) => Ok((report, gpu_seconds)),
        (Err(e), None) => Err(e.context(format!(
            "modal eval failed; see {}",
            manifest_path.display()
        ))),
        (Ok(_), None) => bail!("modal eval failed; see {}", manifest_path.display()),
    }
}

/// The closed-loop eval of the base model with no adapter, served through the
/// same container path as an adapter so prompts are identical.
fn eval_modal_base(
    worker: &Worker,
    label: &str,
    base_model: &str,
    gate: &Value,
    seeds: Option<&str>,
    cases: &[String],
    out: &Path,
    assets: Option<&Path>,
    identity: Option<&Value>,
) -> Result<(Value, Option<f64>)> {
    if gate["live_allowed"] != true {
        bail!(
            "modal eval refused: {}",
            gate["refusal"].as_str().unwrap_or("budget gate")
        );
    }
    require_modal_credentials()?;
    let (streamed, report, gpu_seconds) =
        modal_eval_call(worker, label, base_model, out, gate, seeds, cases, true, assets, identity);
    match (streamed, report) {
        (_, Some(report)) => Ok((report, gpu_seconds)),
        (Err(e), None) => Err(e.context("modal base eval failed")),
        (Ok(_), None) => bail!("modal base eval failed; no report in {}", out.display()),
    }
}

/// One `modal_app.py::eval_main` call: whether it exited cleanly, its
/// report (if written) and the GPU seconds from its `eval_done` line.
#[allow(clippy::too_many_arguments)]
fn modal_eval_call(
    worker: &Worker,
    label: &str,
    base_model: &str,
    out: &Path,
    gate: &Value,
    seeds: Option<&str>,
    cases: &[String],
    base_only: bool,
    assets: Option<&Path>,
    identity: Option<&Value>,
) -> (Result<bool>, Option<Value>, Option<f64>) {
    // A report from an earlier attempt must not count as this one's.
    if out.exists() {
        let empty = std::fs::read_dir(out)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !empty {
            return (Err(anyhow!("evaluation output {} is not empty or readable; choose a fresh directory", out.display())), None, None);
        }
    }
    let mut options = serde_json::Map::new();
    if let Some(seeds) = seeds {
        options.insert("seeds".into(), json!(seeds));
    }
    if !cases.is_empty() {
        options.insert("case".into(), json!(cases));
    }
    let mut argv: Vec<String> = vec![
        "-m".into(),
        "modal".into(),
        "run".into(),
        worker
            .dir
            .join("modal_app.py::eval_main")
            .display()
            .to_string(),
        "--run".into(),
        label.to_string(),
        "--base-model".into(),
        base_model.to_string(),
        "--out".into(),
        out.display().to_string(),
        "--gpu".into(),
        gate["gpu"].as_str().unwrap_or_default().to_string(),
        "--timeout".into(),
        gate["timeout_s"].to_string(),
        "--args".into(),
        Value::Object(options).to_string(),
    ];
    if base_only {
        argv.push("--base-only".into());
    }
    if let Some(assets) = assets { argv.extend(["--model-assets".into(), assets.display().to_string()]); }
    if let Some(identity) = identity { argv.extend(["--planned-assets".into(), identity.to_string()]); }
    let worker = worker.clone().budgeted(gate);
    let streamed = worker.stream_raw(&argv);
    let gpu_seconds = streamed.as_ref().ok().and_then(|(_, events)| events.gpu_seconds);
    let report = match &streamed {
        Ok((true, _)) => read_report(&out.join("report.json")).ok(),
        _ => None,
    };
    (streamed.map(|(ok, _)| ok), report, gpu_seconds)
}

/// `report.json` from Python's `json.dumps`, which writes a non-finite
/// `max_rel_error` as bare `Infinity`/`NaN`; those become null here.
fn read_report(path: &Path) -> Result<Value> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&nonfinite_to_null(&text))
        .with_context(|| format!("parsing {}", path.display()))
}

fn nonfinite_to_null(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let (mut in_string, mut escaped) = (false, false);
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
        } else if let Some(token) = ["-Infinity", "Infinity", "NaN"]
            .into_iter()
            .find(|t| rest.starts_with(t))
        {
            out.push_str("null");
            rest = &rest[token.len()..];
            continue;
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// `train runs`: every run manifest, newest first.
pub fn runs(args: Vec<String>) -> Result<Value, Failure> {
    let flags = Flags::parse(args, &[], &[])?;
    let go = || -> Result<Value> {
        let worker = Worker::new(&flags)?;
        let mut rows = Vec::new();
        for entry in worker.listing("runs") {
            let path = entry.join("manifest.json");
            let Ok(m) = read_json(&path) else { continue };
            rows.push(json!({
                "name": m["name"],
                "status": m["status"],
                "backend": m["backend"],
                "base_model": m["base_model"],
                "train_rows": m.pointer("/data/files/train/rows"),
                "estimate_usd": m.pointer("/budget/estimate_usd"),
                "planned_at": m["planned_at"],
                "run_id": m.get("run_id"),
                "heldout_decisions": m.get("heldout_decisions"),
                "last_val_nll": m.get("last_val_nll"),
            }));
        }
        rows.sort_by(|a, b| b["planned_at"].as_str().cmp(&a["planned_at"].as_str()));
        Ok(Value::Array(rows))
    };
    go().map_err(runtime)
}

// ------------------------------------------------------------------ train loop
//
// An automatic SFT improvement loop: evaluate the base model closed-loop
// (iteration 0), then for each candidate build its dataset locally (free),
// train it on Modal, evaluate it on the same held-out seeds and keep it only
// if it strictly beats the incumbent under the MQ-4 order. State lives in
// `loops/LOOP/` (state.json, journal.jsonl, per-iteration data and evals), so
// a stopped loop resumes where it stopped.

/// Hyperparameters a candidate may set, as `train run` flags.
const LOOP_HPARAMS: &[&str] = &[
    "epochs",
    "lr",
    "rank",
    "batch-size",
    "max-seq-len",
    "warmup",
    "eval-every",
    "seed",
];
/// A run with no estimate (non-finite error) scores this, worse than any
/// real error; report errors are rounded to 1e-5, the floor.
const LOG_ERROR_CAP: f64 = 50.0;
const LOG_ERROR_FLOOR: f64 = 1e-5;
/// GPU-second estimates for budget planning, from the L40S smoke runs
/// (Qwen3.5-4B: 686 s training 3 seeds x 4 epochs incl. load and held-out
/// decoding; closed-loop eval 132 s plus load).
const EVAL_EST_S: u64 = 300;
/// The untrained base model writes long replies (up to max_tokens per call),
/// so its eval runs several times longer than a trained adapter's (measured:
/// 3 of 8 investigations in 487 s on an L40S for Qwen3.5-4B).
const BASE_EVAL_EST_S: u64 = 1500;
const TRAIN_FIXED_S: u64 = 300;
const TRAIN_PER_SEED_EPOCH_S: u64 = 32;
const DEFAULT_EPOCHS: u64 = 4;
/// Matches `modal_budget`: 20% of each cap is left for startup and billing lag.
const OVERHEAD_FACTOR: f64 = 0.8;

/// `0-2,7,9` -> [0, 1, 2, 7, 9], sorted and unique.
fn parse_seeds(spec: &str) -> Result<Vec<u64>, String> {
    let bad = || format!("seeds {spec:?} must look like 0,1,2 or 0-9,12");
    let mut out = BTreeSet::new();
    for part in spec.split(',').map(str::trim) {
        let (a, b) = part.split_once('-').unwrap_or((part, part));
        let (a, b) = (
            a.trim().parse::<u64>().map_err(|_| bad())?,
            b.trim().parse::<u64>().map_err(|_| bad())?,
        );
        if a > b || b - a > 10_000 {
            return Err(bad());
        }
        out.extend(a..=b);
    }
    Ok(out.into_iter().collect())
}

fn seeds_text(seeds: &[u64]) -> String {
    seeds
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// One thing the loop tries: a dataset recipe and `train run` hyperparameters.
#[derive(Debug, Clone, PartialEq)]
struct Candidate {
    label: String,
    train_seeds: Vec<u64>,
    val_seeds: Vec<u64>,
    cases: Vec<String>,
    /// Worker keys (`batch_size`), numbers checked.
    hparams: serde_json::Map<String, Value>,
}

impl Candidate {
    fn epochs(&self) -> u64 {
        self.hparams
            .get("epochs")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_EPOCHS)
    }

    fn est_train_s(&self) -> u64 {
        TRAIN_FIXED_S + TRAIN_PER_SEED_EPOCH_S * self.train_seeds.len() as u64 * self.epochs()
    }

    fn hparam_flags(&self) -> Vec<String> {
        let mut out = Vec::new();
        for (key, value) in &self.hparams {
            out.push(format!("--{}", key.replace('_', "-")));
            out.push(value.to_string());
        }
        out
    }

    fn to_json(&self) -> Value {
        json!({
            "label": self.label,
            "dataset": {
                "train_seeds": seeds_text(&self.train_seeds),
                "val_seeds": seeds_text(&self.val_seeds),
                "case": self.cases,
            },
            "hparams": self.hparams,
            "est_train_gpu_s": self.est_train_s(),
        })
    }

    /// Held-out seeds must never be trained or validated on.
    fn check_seeds(&self, eval_seeds: &[u64]) -> Result<(), String> {
        let overlap = |a: &[u64], b: &[u64]| -> Vec<u64> {
            a.iter().filter(|s| b.contains(s)).copied().collect()
        };
        for (what, seeds) in [("train", &self.train_seeds), ("val", &self.val_seeds)] {
            let bad = overlap(seeds, eval_seeds);
            if !bad.is_empty() {
                return Err(format!(
                    "candidate {:?}: {what} seeds {} overlap the eval seeds",
                    self.label,
                    seeds_text(&bad)
                ));
            }
        }
        let bad = overlap(&self.train_seeds, &self.val_seeds);
        if !bad.is_empty() {
            return Err(format!(
                "candidate {:?}: train and val seeds share {}",
                self.label,
                seeds_text(&bad)
            ));
        }
        Ok(())
    }
}

/// Grow the training data with default hyperparameters: 3, 6 then 12 seeds,
/// skipping the default validation (5,6) and eval (3,4) seeds.
fn default_candidates(cases: &[String]) -> Vec<Candidate> {
    [
        ("seeds-3", "0-2"),
        ("seeds-6", "0-2,7-9"),
        ("seeds-12", "0-2,7-15"),
    ]
    .into_iter()
    .map(|(label, train)| Candidate {
        label: label.into(),
        train_seeds: parse_seeds(train).expect("static seeds"),
        val_seeds: vec![5, 6],
        cases: cases.to_vec(),
        hparams: serde_json::Map::new(),
    })
    .collect()
}

/// A `--candidates` file: a JSON list of
/// `{"label", "dataset": {"train_seeds", "val_seeds", "case"}, "hparams"}`.
/// Unknown keys are refused so a typo cannot silently fall back to a default.
fn parse_candidates(
    text: &str,
    default_cases: &[String],
    eval_seeds: &[u64],
) -> Result<Vec<Candidate>, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| format!("--candidates is not JSON: {e}"))?;
    let list = value
        .as_array()
        .filter(|l| !l.is_empty())
        .ok_or("--candidates must be a non-empty JSON list")?;
    let only = |obj: &serde_json::Map<String, Value>, keys: &[&str], what: &str| match obj
        .keys()
        .find(|k| !keys.contains(&k.as_str()))
    {
        Some(k) => Err(format!("{what}: unknown key {k:?}")),
        None => Ok(()),
    };
    let seeds_field = |v: &Value, what: &str| -> Result<Vec<u64>, String> {
        match v {
            Value::String(s) => parse_seeds(s).map_err(|e| format!("{what}: {e}")),
            Value::Array(items) => items
                .iter()
                .map(|x| x.as_u64().ok_or(format!("{what}: seeds must be integers")))
                .collect::<Result<BTreeSet<_>, _>>()
                .map(|s| s.into_iter().collect()),
            _ => Err(format!(
                "{what}: seeds must be a string like \"0-9\" or a list"
            )),
        }
    };
    let mut out = Vec::new();
    for (i, item) in list.iter().enumerate() {
        let obj = item
            .as_object()
            .ok_or(format!("candidate {i} must be an object"))?;
        only(
            obj,
            &["label", "dataset", "hparams"],
            &format!("candidate {i}"),
        )?;
        let label = match obj.get("label") {
            None => format!("c{}", i + 1),
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => return Err(format!("candidate {i}: label must be a non-empty string")),
        };
        let what = format!("candidate {label:?}");
        let dataset = obj
            .get("dataset")
            .and_then(Value::as_object)
            .ok_or(format!("{what}: dataset object is required"))?;
        only(dataset, &["train_seeds", "val_seeds", "case"], &what)?;
        let train_seeds = seeds_field(
            dataset
                .get("train_seeds")
                .ok_or(format!("{what}: dataset.train_seeds is required"))?,
            &what,
        )?;
        let val_seeds = match dataset.get("val_seeds") {
            Some(v) => seeds_field(v, &what)?,
            None => vec![5, 6],
        };
        if train_seeds.is_empty() || val_seeds.is_empty() {
            return Err(format!("{what}: train and val seeds must not be empty"));
        }
        let cases = match dataset.get("case") {
            None => default_cases.to_vec(),
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(items)) => items
                .iter()
                .map(|c| {
                    c.as_str()
                        .map(String::from)
                        .ok_or(format!("{what}: case names must be strings"))
                })
                .collect::<Result<_, _>>()?,
            _ => return Err(format!("{what}: case must be a string or a list")),
        };
        let mut hparams = serde_json::Map::new();
        if let Some(h) = obj.get("hparams") {
            let h = h
                .as_object()
                .ok_or(format!("{what}: hparams must be an object"))?;
            for (key, value) in h {
                let flag = key.replace('_', "-");
                if !LOOP_HPARAMS.contains(&flag.as_str()) {
                    return Err(format!(
                        "{what}: unknown hparam {key:?}; use {}",
                        LOOP_HPARAMS.join(", ").replace('-', "_")
                    ));
                }
                let x = value
                    .as_f64()
                    .filter(|x| x.is_finite() && *x >= 0.0)
                    .ok_or(format!(
                        "{what}: hparam {key} must be a non-negative number"
                    ))?;
                let normalized = if flag == "lr" {
                    json!(x)
                } else if x.fract() == 0.0
                    && (x >= 1.0 || matches!(flag.as_str(), "seed" | "warmup"))
                {
                    json!(x as u64)
                } else {
                    return Err(format!("{what}: hparam {key} must be a positive integer"));
                };
                hparams.insert(flag.replace('-', "_"), normalized);
            }
        }
        let candidate = Candidate {
            label,
            train_seeds,
            val_seeds,
            cases,
            hparams,
        };
        candidate.check_seeds(eval_seeds)?;
        out.push(candidate);
    }
    Ok(out)
}

/// A closed-loop result under MQ-4: more passes first, then lower mean log10
/// max relative error, then fewer parse failures (the cost proxy here).
#[derive(Debug, Clone, PartialEq)]
struct Score {
    passes: u64,
    runs: u64,
    mean_log10_error: f64,
    parse_failures: u64,
}

impl Score {
    fn to_json(&self) -> Value {
        json!({
            "passes": self.passes,
            "runs": self.runs,
            "mean_log10_error": self.mean_log10_error,
            "parse_failures": self.parse_failures,
        })
    }

    fn from_json(v: &Value) -> Option<Score> {
        Some(Score {
            passes: v["passes"].as_u64()?,
            runs: v["runs"].as_u64()?,
            mean_log10_error: v["mean_log10_error"].as_f64()?,
            parse_failures: v["parse_failures"].as_u64()?,
        })
    }
}

/// Score `report.json` rows with policy `reason`. A missing or non-finite
/// error counts as `LOG_ERROR_CAP`.
fn score_report(report: &Value) -> Result<Score, String> {
    let rows = report
        .as_array()
        .ok_or("report.json is not a list of rows")?;
    let (mut passes, mut runs, mut log_sum, mut parse_failures) = (0, 0, 0.0, 0);
    for row in rows.iter().filter(|r| r["policy"] == "reason") {
        let case = row["case"].as_str().unwrap_or("?");
        let (k, n) = row["pass"]
            .as_str()
            .and_then(|p| p.split_once('/'))
            .and_then(|(k, n)| Some((k.parse::<u64>().ok()?, n.parse::<u64>().ok()?)))
            .filter(|(k, n)| k <= n)
            .ok_or(format!("report row {case}: pass is not \"k/n\""))?;
        let errors = row["max_rel_error"]
            .as_array()
            .ok_or(format!("report row {case}: max_rel_error is not a list"))?;
        if errors.len() as u64 != n {
            return Err(format!(
                "report row {case}: {} errors for {n} runs",
                errors.len()
            ));
        }
        for e in errors {
            log_sum += match e.as_f64().filter(|x| x.is_finite()) {
                Some(x) => x.max(LOG_ERROR_FLOOR).log10().min(LOG_ERROR_CAP),
                None => LOG_ERROR_CAP,
            };
        }
        passes += k;
        runs += n;
        parse_failures += row["parse_failures"]
            .as_u64()
            .ok_or(format!("report row {case}: parse_failures is not a count"))?;
    }
    if runs == 0 {
        return Err("report.json has no reason runs".into());
    }
    Ok(Score {
        passes,
        runs,
        mean_log10_error: log_sum / runs as f64,
        parse_failures,
    })
}

/// Strictly better under MQ-4; a tie keeps the incumbent.
fn better(candidate: &Score, incumbent: &Score) -> bool {
    if candidate.passes != incumbent.passes {
        return candidate.passes > incumbent.passes;
    }
    let delta = candidate.mean_log10_error - incumbent.mean_log10_error;
    if delta.abs() > 1e-9 {
        return delta < 0.0;
    }
    candidate.parse_failures < incumbent.parse_failures
}

/// One spending step of the plan: the baseline eval, then train and eval
/// per iteration. Datasets are built locally inside the train step, free.
#[derive(Debug, Clone, PartialEq)]
struct Step {
    kind: &'static str,
    iteration: usize,
    est_s: u64,
}

fn loop_steps(candidates: &[Candidate]) -> Vec<Step> {
    let mut steps = vec![Step {
        kind: "eval",
        iteration: 0,
        est_s: BASE_EVAL_EST_S,
    }];
    for (i, c) in candidates.iter().enumerate() {
        steps.push(Step {
            kind: "train",
            iteration: i + 1,
            est_s: c.est_train_s(),
        });
        steps.push(Step {
            kind: "eval",
            iteration: i + 1,
            est_s: EVAL_EST_S,
        });
    }
    steps
}

fn floor_cents(x: f64) -> f64 {
    ((x * 100.0) + 1e-6).floor() / 100.0
}

fn ceil_cents(x: f64) -> f64 {
    ((x * 100.0) - 1e-6).ceil() / 100.0
}

/// Split `usd` over steps in proportion to their GPU-time estimates, floored
/// to cents so the caps never sum above `usd`. Each cap becomes that step's
/// Modal timeout through `modal_budget`. Refused when the total cannot buy
/// the estimated GPU time, or a step's timeout would fall under its estimate.
fn plan_caps(
    usd: f64,
    usd_per_hour: f64,
    gpu: &str,
    ests: &[u64],
) -> Result<Vec<(f64, u64)>, String> {
    if usd_per_hour <= 0.0 {
        return Err("--usd-per-hour must be above zero".into());
    }
    let total: u64 = ests.iter().sum();
    let needed = ceil_cents(total as f64 * usd_per_hour / 3600.0 / OVERHEAD_FACTOR);
    if usd + 1e-9 < needed {
        return Err(format!(
            "the plan's estimated {total} GPU-s needs ${needed:.2} at ${usd_per_hour}/h \
             (with the {OVERHEAD_FACTOR} overhead factor); ${usd:.2} is available"
        ));
    }
    let mut out = Vec::new();
    for (i, est) in ests.iter().enumerate() {
        let cap = floor_cents(usd * *est as f64 / total as f64);
        let gate = modal_budget(Some(usd_per_hour), Some(cap), Some(gpu));
        let timeout = gate["timeout_s"].as_u64().unwrap_or(0);
        if gate["live_allowed"] != true || timeout < *est {
            return Err(format!(
                "step {i}: its ${cap:.2} cap buys a {timeout} s timeout, under its {est} s estimate"
            ));
        }
        out.push((cap, timeout));
    }
    Ok(out)
}

/// What a step cost: measured GPU seconds plus the same 20% overhead the
/// timeout leaves, never more than the cap; the whole cap when unmeasured.
fn charge(cap: f64, usd_per_hour: f64, gpu_seconds: Option<f64>) -> f64 {
    match gpu_seconds {
        Some(s) if s.is_finite() && s >= 0.0 => {
            ceil_cents(s * usd_per_hour / 3600.0 / OVERHEAD_FACTOR).min(cap)
        }
        _ => cap,
    }
}

/// A live loop may start fresh only over a plan; `--resume` continues one
/// that stopped, failed or was interrupted.
fn loop_start_allowed(previous_status: Option<&str>, resume: bool) -> Result<(), String> {
    match (previous_status, resume) {
        (None, true) => Err("has no state.json to resume; start it without --resume".into()),
        (None | Some("planned"), _) => Ok(()),
        (Some(_), true) => Ok(()),
        (Some(status), false) => Err(format!(
            "already has status {status:?}; continue it with --resume or pick a new --name"
        )),
    }
}

/// Everything a loop's flags fix, validated without I/O beyond the
/// candidates file.
struct LoopPlan {
    name: String,
    base_model: String,
    model_assets: Option<PathBuf>,
    asset_identity: Option<Value>,
    gpu: String,
    usd_per_hour: f64,
    max_usd: f64,
    iterations: usize,
    patience: u64,
    eval_seeds: Vec<u64>,
    cases: Vec<String>,
    candidates: Vec<Candidate>,
}

impl LoopPlan {
    /// What a resumed loop must match: changing any of it would make the
    /// incumbent's score incomparable.
    fn fingerprint(&self) -> Value {
        json!({
            "base_model": self.base_model,
            "model_assets": self.asset_identity,
            "gpu": self.gpu,
            "usd_per_hour": self.usd_per_hour,
            "eval_seeds": seeds_text(&self.eval_seeds),
            "case": self.cases,
            "candidates": self.candidates.iter().map(Candidate::to_json).collect::<Vec<_>>(),
        })
    }

    fn steps(&self) -> Vec<Step> {
        loop_steps(&self.candidates[..self.iterations])
    }

    fn run_name(&self, iteration: usize) -> String {
        format!("{}-i{iteration}", self.name)
    }

    fn step_json(&self, index: usize, step: &Step, cap: Option<(f64, u64)>) -> Value {
        let label = match step.iteration {
            0 => "base".to_string(),
            i => self.candidates[i - 1].label.clone(),
        };
        json!({
            "step": index,
            "kind": step.kind,
            "iteration": step.iteration,
            "label": label,
            "run": (step.iteration > 0).then(|| self.run_name(step.iteration)),
            "est_gpu_s": step.est_s,
            "cap_usd": cap.map(|c| c.0),
            "timeout_s": cap.map(|c| c.1),
        })
    }

    /// The remaining steps from `cursor` with caps split from `usd`.
    fn schedule(&self, cursor: usize, usd: f64) -> (Vec<Value>, Option<String>) {
        let steps = self.steps();
        let rest = &steps[cursor.min(steps.len())..];
        let ests: Vec<u64> = rest.iter().map(|s| s.est_s).collect();
        let caps = if rest.is_empty() {
            Ok(vec![])
        } else {
            plan_caps(usd, self.usd_per_hour, &self.gpu, &ests)
        };
        let rows = rest
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let cap = caps.as_ref().ok().map(|c| c[i]);
                self.step_json(cursor + i, s, cap)
            })
            .collect();
        (rows, caps.err())
    }
}

fn loop_plan(flags: &Flags) -> Result<LoopPlan, String> {
    let name = flags.require("name")?.to_string();
    check_name(&name)?;
    let base_model = flags.require("base-model")?.to_string();
    let model_assets = flags.get("model-assets").map(PathBuf::from)
        .or_else(|| env_path("AUTOPHYS_TRAIN_MODEL_ASSETS"))
        .map(absolute).transpose().map_err(|e| e.to_string())?;
    let asset_identity = model_assets.as_ref().map(|dir| -> Result<Value, String> {
        let manifest = read_json(&dir.join("manifest.json")).map_err(|e| e.to_string())?;
        if manifest["schema"] != 1 || manifest["model"] != base_model { return Err("model assets schema/model mismatch".into()); }
        let revision = manifest["revision"].as_str().filter(|r| r.len() == 40 && r.bytes().all(|c| c.is_ascii_hexdigit())).ok_or("model assets need an immutable 40-hex revision")?;
        for file in ["tokenizer.json", "tokenizer_config.json", "chat_template.jinja"] {
            if manifest["files"][file].as_str() != Some(sha256_file(&dir.join(file)).map_err(|e| e.to_string())?.as_str()) { return Err(format!("model asset digest mismatch: {file}")); }
        }
        Ok(json!({"model": base_model, "revision": revision, "manifest_sha256": sha256_file(&dir.join("manifest.json")).map_err(|e| e.to_string())?, "files": manifest["files"]}))
    }).transpose()?;
    let gpu = flags
        .get("gpu")
        .ok_or("--gpu is required for a modal loop (for example L40S, A100-80GB, H100)")?
        .to_string();
    let usd_per_hour = flags
        .number("usd-per-hour")?
        .ok_or("--usd-per-hour is required: the CLI never assumes a price")?;
    if usd_per_hour <= 0.0 {
        return Err("--usd-per-hour must be above zero".into());
    }
    let max_usd = flags
        .number("max-usd")?
        .ok_or("--max-usd is required: a loop needs one explicit total cap")?;
    let count = |flag: &str, default: u64| -> Result<u64, String> {
        match flags.get(flag) {
            None => Ok(default),
            Some(v) => v
                .parse::<u64>()
                .ok()
                .filter(|n| *n >= 1)
                .ok_or(format!("--{flag} {v:?} must be a positive integer")),
        }
    };
    let iterations = count("iterations", 3)? as usize;
    let patience = count("patience", 2)?;
    let eval_seeds = parse_seeds(flags.get("eval-seeds").unwrap_or("3,4"))
        .map_err(|e| format!("--eval-seeds: {e}"))?;
    let cases = flags.all("case").to_vec();
    let candidates = match flags.get("candidates") {
        Some(path) => {
            let text =
                std::fs::read_to_string(path).map_err(|e| format!("--candidates {path:?}: {e}"))?;
            parse_candidates(&text, &cases, &eval_seeds)?
        }
        None => {
            let defaults = default_candidates(&cases);
            for c in &defaults {
                c.check_seeds(&eval_seeds)
                    .map_err(|e| format!("{e}; pass --candidates for these eval seeds"))?;
            }
            defaults
        }
    };
    Ok(LoopPlan {
        name,
        base_model,
        model_assets,
        asset_identity,
        gpu,
        usd_per_hour,
        max_usd,
        iterations: iterations.min(candidates.len()),
        patience,
        eval_seeds,
        cases,
        candidates,
    })
}

/// Persisted state is untrusted input. Refuse malformed counters and budget
/// fields before defaults can restart a baseline, erase spending or panic on steps.
fn validate_loop_state(state: &Value, plan: &LoopPlan) -> Result<()> {
    let invalid = || anyhow!("invalid loop state; refusing overwrite or resume");
    let required = ["name", "status", "fingerprint", "cursor", "spent_usd", "incumbent", "consecutive_rejections", "in_flight", "steps"];
    if !state.as_object().map(|obj| required.iter().all(|key| obj.contains_key(*key))).unwrap_or(false)
        || state["name"].as_str() != Some(plan.name.as_str())
        || !matches!(state["status"].as_str(), Some("planned" | "running" | "failed" | "finished"))
        || !state["fingerprint"].is_object()
    {
        return Err(invalid());
    }
    let cursor = state["cursor"].as_u64().ok_or_else(invalid)?;
    let rejections = state["consecutive_rejections"].as_u64().ok_or_else(invalid)?;
    let spent = state["spent_usd"].as_f64().filter(|n| n.is_finite() && *n >= 0.0).ok_or_else(invalid)?;
    let steps = state["steps"].as_array().ok_or_else(invalid)?;
    let schedule = plan.steps();
    if cursor > schedule.len() as u64 || steps.len() as u64 != cursor || rejections > cursor {
        return Err(invalid());
    }
    for (index, entry) in steps.iter().enumerate() {
        let step = &schedule[index];
        if entry["step"].as_u64() != Some(index as u64)
            || entry["kind"].as_str() != Some(step.kind)
            || entry["iteration"].as_u64() != Some(step.iteration as u64)
            || !entry["result"].is_object()
        { return Err(invalid()); }
    }
    let incumbent = &state["incumbent"];
    if !incumbent.is_null() {
        let iteration = incumbent["iteration"].as_u64().ok_or_else(invalid)?;
        let score = Score::from_json(&incumbent["score"]).ok_or_else(invalid)?;
        if iteration > plan.iterations as u64 || iteration * 2 >= cursor
            || score.runs == 0 || score.passes > score.runs || !score.mean_log10_error.is_finite()
        { return Err(invalid()); }
    } else if cursor > 0 { return Err(invalid()); }
    let flight = &state["in_flight"];
    if !flight.is_null() {
        let cap = flight["cap_usd"].as_f64().filter(|n| n.is_finite() && *n >= 0.0).ok_or_else(invalid)?;
        if flight["step"].as_u64() != Some(cursor) || cursor >= schedule.len() as u64
            || !spent.is_finite() || !(spent + cap).is_finite()
        { return Err(invalid()); }
    }
    if state["status"] == "planned" && (cursor != 0 || spent != 0.0 || !flight.is_null()) {
        return Err(invalid());
    }
    Ok(())
}

/// `train loop`: plan (free) or run the keep-if-better SFT loop.
pub fn run_loop(args: Vec<String>) -> Result<Value, Failure> {
    let flags = Flags::parse(
        args,
        &[
            "name",
            "base-model",
            "model-assets",
            "gpu",
            "usd-per-hour",
            "max-usd",
            "iterations",
            "patience",
            "candidates",
            "eval-seeds",
            "case",
        ],
        &["live", "resume"],
    )?;
    let plan = loop_plan(&flags)?;
    let live = flags.switches.contains("live");
    let resume = flags.switches.contains("resume");
    if live && plan.model_assets.is_none() { return Err("live loop requires prepared --model-assets (or AUTOPHYS_TRAIN_MODEL_ASSETS)".into()); }
    let go = || -> Result<Value> {
        let worker = Worker::new(&flags)?;
        let dir = worker.data.join("loops").join(&plan.name);
        let _reservation = if live || !resume { Some(reserve_run(&dir)?) } else { None };
        let state_path = dir.join("state.json");
        let previous = match std::fs::read(&state_path) {
            Ok(bytes) => Some(serde_json::from_slice::<Value>(&bytes).context("invalid loop state; refusing overwrite")?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if let Some(state) = &previous {
            validate_loop_state(state, &plan)?;
        }
        let status = previous.as_ref().and_then(|s| s["status"].as_str());
        loop_start_allowed(status, resume).map_err(|why| anyhow!("loop {:?} {why}", plan.name))?;
        let fingerprint = plan.fingerprint();
        let mut state = match previous.filter(|_| resume) {
            Some(state) => {
                if state["fingerprint"] != fingerprint {
                    bail!(
                        "loop {:?} was planned with a different base model, GPU, price, eval seeds, \
                         cases or candidates; resume with the same flags (see {})",
                        plan.name,
                        state_path.display()
                    );
                }
                state
            }
            None => json!({
                "name": plan.name,
                "status": "planned",
                "stop_reason": null,
                "planned_at": now(),
                "git_head": git_head(),
                "fingerprint": fingerprint,
                "cursor": 0,
                "spent_usd": 0.0,
                "incumbent": null,
                "consecutive_rejections": 0,
                "in_flight": null,
                "steps": [],
            }),
        };
        let spent = state["spent_usd"].as_f64().unwrap_or(0.0);
        // An interrupted step's spend is unknown: charge its whole cap.
        let in_flight_cap = state["in_flight"]["cap_usd"].as_f64().unwrap_or(0.0);
        let cursor = state["cursor"].as_u64().unwrap_or(0) as usize;
        let (schedule, refusal) = plan.schedule(cursor, plan.max_usd - spent - in_flight_cap);
        let worst_case: f64 = schedule.iter().filter_map(|s| s["cap_usd"].as_f64()).sum();
        let est_s: u64 = schedule
            .iter()
            .filter_map(|s| s["est_gpu_s"].as_u64())
            .sum();
        state["plan"] = json!({
            "base_model": plan.base_model,
            "gpu": plan.gpu,
            "usd_per_hour": plan.usd_per_hour,
            "max_usd": plan.max_usd,
            "iterations": plan.iterations,
            "patience": plan.patience,
            "eval_seeds": seeds_text(&plan.eval_seeds),
            "case": plan.cases,
            "candidates": plan.candidates.iter().map(Candidate::to_json).collect::<Vec<_>>(),
            "schedule": schedule,
            "estimate_gpu_s": est_s,
            "estimate_usd": ceil_cents(est_s as f64 * plan.usd_per_hour / 3600.0),
            "worst_case_usd": floor_cents(worst_case + 1e-9),
            "rule": "accept only if strictly better: passes desc, mean log10 max_rel_error asc, parse_failures asc",
            "live_allowed": refusal.is_none(),
            "refusal": refusal,
        });
        if !live {
            if !resume {
                std::fs::create_dir_all(&dir)?;
                write_json(&state_path, &state)?;
            }
            return Ok(state);
        }
        if let Some(refusal) = refusal {
            bail!("live loop refused: {refusal}");
        }
        require_modal_credentials()?;
        std::fs::create_dir_all(&dir)?;
        let mut driver = LoopDriver {
            plan: &plan,
            worker: &worker,
            passthrough: flags.passthrough(WORKER_FLAGS),
            dir: dir.clone(),
            state,
        };
        driver.drive()?;
        Ok(driver.state)
    };
    go().map_err(runtime)
}

struct LoopDriver<'a> {
    plan: &'a LoopPlan,
    worker: &'a Worker,
    passthrough: Vec<String>,
    dir: PathBuf,
    state: Value,
}

impl LoopDriver<'_> {
    fn save(&mut self) -> Result<()> {
        self.state["updated_at"] = json!(now());
        write_json(&self.dir.join("state.json"), &self.state)
    }

    fn journal(&self, event: &str, mut entry: Value) -> Result<()> {
        use std::io::Write;
        entry["at"] = json!(now());
        entry["event"] = json!(event);
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("journal.jsonl"))?;
        writeln!(file, "{entry}")?;
        Ok(())
    }

    fn spent(&self) -> f64 {
        self.state["spent_usd"].as_f64().unwrap_or(0.0)
    }

    fn add_spend(&mut self, usd: f64) {
        self.state["spent_usd"] = json!(((self.spent() + usd) * 100.0).round() / 100.0);
    }

    fn stop(&mut self, status: &str, reason: String) -> Result<()> {
        self.state["status"] = json!(status);
        self.state["stop_reason"] = json!(reason);
        self.state["stopped_at"] = json!(now());
        self.journal(
            "stop",
            json!({"status": status, "reason": reason, "spent_usd": self.spent(),
                   "incumbent": self.state["incumbent"]}),
        )?;
        self.save()
    }

    fn drive(&mut self) -> Result<()> {
        let resumed = self.state["status"] != "planned";
        if let Some(cap) = self.state["in_flight"]["cap_usd"].as_f64() {
            let step = self.state["in_flight"].clone();
            self.add_spend(cap);
            self.state["in_flight"] = Value::Null;
            self.journal(
                "interrupted_step_charged",
                json!({"step": step, "charged_usd": cap}),
            )?;
        }
        self.state["status"] = json!("running");
        self.state["stop_reason"] = Value::Null;
        self.journal(
            if resumed { "resume" } else { "start" },
            json!({"plan": self.state["plan"], "spent_usd": self.spent()}),
        )?;
        self.save()?;
        let steps = self.plan.steps();
        loop {
            let cursor = self.state["cursor"].as_u64().unwrap_or(0) as usize;
            let rejections = self.state["consecutive_rejections"].as_u64().unwrap_or(0);
            if cursor >= steps.len() {
                return self.stop("finished", "iterations".into());
            }
            if rejections >= self.plan.patience && steps[cursor].kind == "train" {
                return self.stop(
                    "finished",
                    format!("patience: {rejections} consecutive rejections"),
                );
            }
            let ests: Vec<u64> = steps[cursor..].iter().map(|s| s.est_s).collect();
            let remaining = self.plan.max_usd - self.spent();
            let (cap, timeout) =
                match plan_caps(remaining, self.plan.usd_per_hour, &self.plan.gpu, &ests) {
                    Ok(caps) => caps[0],
                    Err(why) => return self.stop("finished", format!("budget: {why}")),
                };
            let step = &steps[cursor];
            let record = self.plan.step_json(cursor, step, Some((cap, timeout)));
            self.state["in_flight"] = json!({"step": cursor, "cap_usd": cap, "started_at": now()});
            self.journal("step_start", record.clone())?;
            self.save()?;
            let gate = modal_budget(
                Some(self.plan.usd_per_hour),
                Some(cap),
                Some(&self.plan.gpu),
            );
            let result = match step.kind {
                "train" => self.train(step.iteration, cap),
                _ => self.eval(step.iteration, &gate),
            };
            self.state["in_flight"] = Value::Null;
            match result {
                Ok(mut done) => {
                    let charged = charge(cap, self.plan.usd_per_hour, done["gpu_seconds"].as_f64());
                    self.add_spend(charged);
                    done["charged_usd"] = json!(charged);
                    let mut entry = record.clone();
                    entry["result"] = done.clone();
                    if step.kind == "eval" {
                        let score = done["score"].clone();
                        entry["decision"] = self.decide(step.iteration, &score)?;
                    }
                    self.journal("step_done", entry.clone())?;
                    self.state["steps"]
                        .as_array_mut()
                        .expect("steps list")
                        .push(entry);
                    self.state["cursor"] = json!(cursor + 1);
                    self.save()?;
                }
                Err(e) => {
                    self.add_spend(cap);
                    let reason = format!(
                        "failed: step {cursor} ({} {}): {e:#}",
                        step.kind, step.iteration
                    );
                    self.journal(
                        "step_failed",
                        json!({"step": record, "error": format!("{e:#}"), "charged_usd": cap}),
                    )?;
                    self.stop("failed", reason.clone())?;
                    bail!("{reason}; resume with --resume after fixing it");
                }
            }
        }
    }

    /// Accept the candidate only if it strictly beats the incumbent.
    fn decide(&mut self, iteration: usize, score: &Value) -> Result<Value> {
        let candidate =
            Score::from_json(score).ok_or_else(|| anyhow!("step result has no score"))?;
        let (label, run) = match iteration {
            0 => ("base".to_string(), Value::Null),
            i => (
                self.plan.candidates[i - 1].label.clone(),
                json!(self.plan.run_name(i)),
            ),
        };
        let incumbent = Score::from_json(&self.state["incumbent"]["score"]);
        let accepted = match &incumbent {
            None => true,
            Some(inc) => better(&candidate, inc),
        };
        if accepted {
            self.state["incumbent"] = json!({
                "iteration": iteration, "label": label, "run": run, "score": score,
            });
            self.state["consecutive_rejections"] = json!(0);
        } else {
            let n = self.state["consecutive_rejections"].as_u64().unwrap_or(0) + 1;
            self.state["consecutive_rejections"] = json!(n);
        }
        Ok(json!({
            "accepted": accepted,
            "baseline": iteration == 0,
            "against": incumbent.map(|s| s.to_json()),
        }))
    }

    /// Build the candidate's dataset locally (free), then train it on Modal
    /// through `train run` under this step's cap.
    fn train(&mut self, iteration: usize, cap: f64) -> Result<Value> {
        let candidate = &self.plan.candidates[iteration - 1];
        let run_name = self.plan.run_name(iteration);
        let manifest_path = self
            .worker
            .data
            .join("runs")
            .join(&run_name)
            .join("manifest.json");
        let data = self.dir.join(format!("iter-{iteration}")).join("data");
        if let Ok(m) = read_json(&manifest_path) {
            let ours = data.canonicalize().ok().map(|d| d.display().to_string());
            if m["status"] == "completed" {
                let expected_hparams: Vec<String> = HYPERPARAMETERS.iter().flat_map(|flag| {
                    candidate.hparams.get(&flag.replace('-', "_")).map(|value|
                        vec![format!("--{flag}"), value.to_string()]).unwrap_or_default()
                }).collect();
                if ours.is_none()
                    || m["name"] != run_name || m["backend"] != "modal"
                    || m["base_model"] != self.plan.base_model
                    || m.pointer("/data/dir").and_then(Value::as_str) != ours.as_deref()
                    || m["data"] != dataset_identity(&data)?
                    || m["hyperparameters"] != json!(expected_hparams)
                    || m.pointer("/plan/model_assets") != self.plan.asset_identity.as_ref()
                {
                    bail!("completed run {run_name:?} differs from this loop's data/model/assets/hyperparameters; preserve it and choose a new loop name");
                }
                // Trained before an interruption; its spend was charged then.
                return Ok(json!({"run": run_name, "reused": true, "gpu_seconds": 0.0}));
            }
        }
        let failure = |f: Failure| anyhow!(f.message());
        let mut args = vec![
            "--out".to_string(),
            data.display().to_string(),
            "--train-seeds".into(),
            seeds_text(&candidate.train_seeds),
            "--val-seeds".into(),
            seeds_text(&candidate.val_seeds),
            "--heldout-seeds".into(),
            seeds_text(&self.plan.eval_seeds),
        ];
        for case in &candidate.cases {
            args.extend(["--case".to_string(), case.clone()]);
        }
        args.extend(self.passthrough.clone());
        let identity = dataset(args).map_err(failure)?;
        self.journal("dataset", json!({"iteration": iteration, "data": identity}))?;
        let mut args = vec![
            "--name".to_string(),
            run_name.clone(),
            "--base-model".into(),
            self.plan.base_model.clone(),
            "--data".into(),
            data.display().to_string(),
            "--backend".into(),
            "modal".into(),
            "--gpu".into(),
            self.plan.gpu.clone(),
            "--usd-per-hour".into(),
            self.plan.usd_per_hour.to_string(),
            "--max-usd".into(),
            cap.to_string(),
            "--live".into(),
        ];
        if let Some(assets) = &self.plan.model_assets { args.extend(["--model-assets".into(), assets.display().to_string()]); }
        args.extend(candidate.hparam_flags());
        args.extend(self.passthrough.clone());
        let manifest = run(args).map_err(failure)?;
        Ok(json!({
            "run": run_name,
            "train_rows": manifest.pointer("/data/files/train/rows"),
            "last_val_nll": manifest["last_val_nll"],
            "heldout_decisions": manifest["heldout_decisions"],
            "gpu_seconds": manifest["gpu_seconds"],
        }))
    }

    /// Closed-loop eval: the base model for iteration 0, else the
    /// iteration's run. Each attempt writes a fresh directory.
    fn eval(&mut self, iteration: usize, gate: &Value) -> Result<Value> {
        let parent = self.dir.join(match iteration {
            0 => "baseline".to_string(),
            i => format!("iter-{i}"),
        });
        let out = (1..)
            .map(|k| {
                parent.join(if k == 1 {
                    "eval".into()
                } else {
                    format!("eval-{k}")
                })
            })
            .find(|p| !p.exists())
            .expect("a free directory name");
        let seeds = seeds_text(&self.plan.eval_seeds);
        let (report, gpu_seconds) = if iteration == 0 {
            eval_modal_base(
                self.worker,
                &format!("{}-base", self.plan.name),
                &self.plan.base_model,
                gate,
                Some(&seeds),
                &self.plan.cases,
                &out,
                self.plan.model_assets.as_deref(),
                self.plan.asset_identity.as_ref(),
            )?
        } else {
            eval_modal_run(
                self.worker,
                &self.plan.run_name(iteration),
                gate.clone(),
                Some(&seeds),
                &self.plan.cases,
                Some(out.clone()),
                self.plan.model_assets.as_deref(),
            )?
        };
        let score = score_report(&report).map_err(|e| anyhow!("{e} ({})", out.display()))?;
        Ok(json!({
            "out": out.display().to_string(),
            "score": score.to_json(),
            "gpu_seconds": gpu_seconds,
        }))
    }
}

/// `train loops`: every loop's state, newest first.
pub fn loops(args: Vec<String>) -> Result<Value, Failure> {
    let flags = Flags::parse(args, &[], &[])?;
    let go = || -> Result<Value> {
        let worker = Worker::new(&flags)?;
        let mut rows = Vec::new();
        for entry in worker.listing("loops") {
            let Ok(s) = read_json(&entry.join("state.json")) else {
                continue;
            };
            rows.push(json!({
                "name": s["name"],
                "status": s["status"],
                "stop_reason": s["stop_reason"],
                "base_model": s.pointer("/plan/base_model"),
                "steps_done": s["cursor"],
                "incumbent": s
                    .pointer("/incumbent/run")
                    .filter(|v| !v.is_null())
                    .or(s.pointer("/incumbent/label")),
                "incumbent_score": s.pointer("/incumbent/score"),
                "spent_usd": s["spent_usd"],
                "max_usd": s.pointer("/plan/max_usd"),
                "planned_at": s["planned_at"],
            }));
        }
        rows.sort_by(|a, b| b["planned_at"].as_str().cmp(&a["planned_at"].as_str()));
        Ok(Value::Array(rows))
    };
    go().map_err(runtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_workers_writes_upgrades_and_keeps_edits() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("train/sft");
        let v1: &[(&str, &[u8])] = &[
            ("train_sft.py", b"v1"),
            ("serving/model.jinja", b"tmpl"),
            ("data/train.jsonl", b"shipped"),
        ];
        assert!(install_workers(&dir, v1).unwrap().is_empty());
        assert_eq!(std::fs::read(dir.join("serving/model.jinja")).unwrap(), b"tmpl");
        // Idempotent, and the user's state beside the workers is untouched.
        std::fs::create_dir_all(dir.join("runs/a")).unwrap();
        std::fs::write(dir.join("runs/a/run.json"), b"{}").unwrap();
        assert!(install_workers(&dir, v1).unwrap().is_empty());
        // The user rebuilds the dataset; an upgrade replaces only what an
        // install wrote and still holds those bytes.
        std::fs::write(dir.join("data/train.jsonl"), b"mine").unwrap();
        let v2: &[(&str, &[u8])] = &[
            ("train_sft.py", b"v2"),
            ("serving/model.jinja", b"tmpl"),
            ("data/train.jsonl", b"shipped v2"),
            ("eval_heldout.py", b"new"),
        ];
        assert_eq!(install_workers(&dir, v2).unwrap(), vec!["data/train.jsonl".to_string()]);
        assert_eq!(std::fs::read(dir.join("train_sft.py")).unwrap(), b"v2");
        assert_eq!(std::fs::read(dir.join("eval_heldout.py")).unwrap(), b"new");
        assert_eq!(std::fs::read(dir.join("data/train.jsonl")).unwrap(), b"mine");
        assert_eq!(std::fs::read(dir.join("runs/a/run.json")).unwrap(), b"{}");
        // A file that was there before any install is the user's.
        let other = root.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("train_sft.py"), b"theirs").unwrap();
        assert_eq!(install_workers(&other, v1).unwrap(), vec!["train_sft.py".to_string()]);
        assert_eq!(std::fs::read(other.join("train_sft.py")).unwrap(), b"theirs");
        // A pre-existing file that matches is still the user's: an upgrade
        // keeps it rather than claiming and replacing it.
        let same = root.path().join("same");
        std::fs::create_dir_all(&same).unwrap();
        std::fs::write(same.join("train_sft.py"), b"v1").unwrap();
        assert!(install_workers(&same, v1).unwrap().is_empty());
        assert_eq!(install_workers(&same, v2).unwrap(), vec!["train_sft.py".to_string()]);
        assert_eq!(std::fs::read(same.join("train_sft.py")).unwrap(), b"v1");
        // An edit that happens to equal the next built-in version is still
        // an edit: the version after that keeps it.
        let edited = root.path().join("edited");
        assert!(install_workers(&edited, v1).unwrap().is_empty());
        std::fs::write(edited.join("train_sft.py"), b"v2").unwrap();
        assert!(install_workers(&edited, v2).unwrap().is_empty());
        let v3: &[(&str, &[u8])] = &[("train_sft.py", b"v3")];
        assert_eq!(install_workers(&edited, v3).unwrap(), vec!["train_sft.py".to_string()]);
        assert_eq!(std::fs::read(edited.join("train_sft.py")).unwrap(), b"v2");
        // Removing an edited file restores the built-in version.
        std::fs::remove_file(dir.join("data/train.jsonl")).unwrap();
        assert!(install_workers(&dir, v2).unwrap().is_empty());
        assert_eq!(std::fs::read(dir.join("data/train.jsonl")).unwrap(), b"shipped v2");
    }

    #[test]
    fn built_in_workers_are_the_train_sft_tree_without_tests() {
        let names: Vec<&str> = embedded_workers::FILES.iter().map(|(n, _)| *n).collect();
        for required in ["train_sft.py", "build_dataset.py", "eval_heldout.py", "modal_app.py", "data/train.jsonl"] {
            assert!(names.contains(&required), "{required} missing from {names:?}");
        }
        assert!(names.iter().all(|n| !n.starts_with("tests/")), "{names:?}");
        assert!(names.iter().all(|n| !n.starts_with("runs/") && !n.starts_with("loops/")), "{names:?}");
        let sdk: Vec<&str> = embedded_sdk::FILES.iter().map(|(n, _)| *n).collect();
        for required in ["pyproject.toml", "src/autophys/__init__.py", "src/autophys/models/battery.py"] {
            assert!(sdk.contains(&required), "{required} missing from {sdk:?}");
        }
        assert!(sdk.iter().all(|n| !n.starts_with("tests/") && !n.contains("__pycache__")), "{sdk:?}");
    }

    const WRITER: &[u8] = b"import os, pathlib
d = pathlib.Path(os.environ['AUTOPHYS_TRAIN_DATA']) / 'runs' / 'x'
d.mkdir(parents=True)
(d / 'run.json').write_text('{}')
";
    const WORKERS_V1: Files = &[("train_sft.py", b"v1"), ("write.py", WRITER)];
    const WORKERS_V2: Files = &[("train_sft.py", b"v2"), ("write.py", WRITER)];
    const SDK: Files = &[("pyproject.toml", b"sdk")];

    #[test]
    fn code_versions_install_side_by_side_and_outputs_go_to_the_data_dir() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("app");
        let k1 = code_key("0.1.1", &[WORKERS_V1, SDK]);
        let k2 = code_key("0.1.1", &[WORKERS_V2, SDK]);
        // Same version, different built-in bytes: different caches.
        assert_ne!(k1, k2);
        assert!(
            k1.starts_with("0.1.1-") && k1.len() == "0.1.1-".len() + 12,
            "{k1}"
        );
        assert_ne!(k1, code_key("0.1.2", &[WORKERS_V1, SDK]));
        assert_eq!(k1, code_key("0.1.1", &[WORKERS_V1, SDK]));
        let cwd = root.path().join("cwd");
        let resolve = |key: &str| train_dirs(None, None, || Ok(app.clone()), key, &cwd).unwrap();
        let (d1, d2) = (resolve(&k1), resolve(&k2));
        let i1 = install_code(d1.install.as_ref().unwrap(), WORKERS_V1, SDK).unwrap();
        let i2 = install_code(d2.install.as_ref().unwrap(), WORKERS_V2, SDK).unwrap();
        assert_eq!((&i1, &i2), (&d1.code, &d2.code));
        assert_eq!(i1, app.join("train/code").join(&k1).join("train/sft"));
        assert_eq!(std::fs::read(i1.join("train_sft.py")).unwrap(), b"v1");
        assert_eq!(std::fs::read(i2.join("train_sft.py")).unwrap(), b"v2");
        // The workers' Modal images find the SDK at ../../sdks/python.
        assert_eq!(
            std::fs::read(i1.join("../../sdks/python/pyproject.toml")).unwrap(),
            b"sdk"
        );
        // One data directory for every version, outside the code cache.
        assert_eq!(d1.data, app.join("train/data"));
        assert_eq!(d1.data, d2.data);
        assert!(!d1.data.starts_with(app.join("train/code")));

        let Ok(python) = find_python(Path::new("python3"), std::env::var_os("PATH").as_deref())
        else {
            eprintln!("skipping the worker write: no python3 on PATH");
            return;
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _entered = runtime.enter();
        let worker = Worker {
            dir: i1.clone(),
            data: d1.data.clone(),
            python,
            limits: WorkerLimits::from_env().unwrap(),
        };
        worker.capture("write.py", &[]).unwrap();
        assert_eq!(
            std::fs::read(d1.data.join("runs/x/run.json")).unwrap(),
            b"{}"
        );
        assert!(!i1.join("runs").exists());
        assert!(!app.join("train/code").join(&k1).join("runs").exists());
    }

    #[test]
    fn an_explicit_train_dir_keeps_outputs_beside_it_unless_a_data_dir_is_given() {
        let cwd = Path::new("/work");
        let never =
            || -> Result<PathBuf> { panic!("an explicit --train-dir needs no app directory") };
        let dirs = train_dirs(Some("rel/sft".into()), None, never, "k", cwd).unwrap();
        assert_eq!(
            dirs,
            TrainDirs {
                code: cwd.join("rel/sft"),
                install: None,
                data: cwd.join("rel/sft"),
            }
        );
        let dirs =
            train_dirs(Some("/abs/sft".into()), Some("out".into()), never, "k", cwd).unwrap();
        assert_eq!(
            (dirs.code, dirs.data),
            (PathBuf::from("/abs/sft"), cwd.join("out"))
        );
        // A data directory with the built-in code.
        let app = PathBuf::from("/app");
        let dirs = train_dirs(None, Some("/d".into()), || Ok(app.clone()), "k", cwd).unwrap();
        assert_eq!(dirs.install, Some(app.join("train/code/k")));
        assert_eq!(dirs.data, PathBuf::from("/d"));
    }

    #[test]
    fn replace_file_never_writes_through_a_name_already_taken() {
        let root = tempfile::tempdir().unwrap();
        let victim = root.path().join("victim");
        std::fs::write(&victim, b"keep").unwrap();
        let path = root.path().join("train_sft.py");
        let taken = root.path().join(format!(".train_sft.py.autophys-tmp-{}-0", std::process::id()));
        std::os::unix::fs::symlink(&victim, &taken).unwrap();
        replace_file(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        assert!(std::fs::symlink_metadata(&taken).unwrap().file_type().is_symlink());
    }

    fn pipe_pair() -> (std::fs::File, std::fs::File) {
        use std::os::fd::FromRawFd;
        unsafe extern "C" {
            fn pipe(fds: *mut i32) -> i32;
        }
        let mut fds = [0i32; 2];
        assert_eq!(unsafe { pipe(fds.as_mut_ptr()) }, 0);
        unsafe {
            (
                std::fs::File::from_raw_fd(fds[0]),
                std::fs::File::from_raw_fd(fds[1]),
            )
        }
    }

    #[test]
    fn polled_diagnostics_deliver_to_a_drained_pipe() {
        use std::os::fd::AsFd;
        let (mut reader, writer) = pipe_pair();
        let mut sink = Diagnostics::polled(writer.as_fd()).unwrap();
        drop(writer);
        let message = vec![b'x'; 3 * POLLED_CHUNK + 7];
        sink.forward(&message).unwrap();
        drop(sink);
        let mut got = Vec::new();
        reader.read_to_end(&mut got).unwrap();
        assert_eq!(got, message);
    }

    #[test]
    fn polled_diagnostics_discard_instead_of_blocking_on_a_full_pipe() {
        use std::os::fd::AsFd;
        let (reader, writer) = pipe_pair();
        let mut sink = Diagnostics::polled(writer.as_fd()).unwrap();
        // Far beyond any pipe capacity: a blocking forward would never return,
        // since nothing reads until it does.
        let flood = vec![b'y'; 4 << 20];
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = sink.forward(&flood).map(|_| ());
            let _ = tx.send(result);
        });
        let result = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("polled forward blocked on a full pipe");
        result.unwrap();
        drop(reader);
        drop(writer);
    }

    #[test]
    fn polled_diagnostics_report_a_closed_pipe() {
        use std::os::fd::AsFd;
        let (reader, writer) = pipe_pair();
        let mut sink = Diagnostics::polled(writer.as_fd()).unwrap();
        drop(reader);
        let err = sink.forward(b"after close\n").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::BrokenPipe);
    }

    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn worker_read_failure_is_reported_and_reader_exits() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("injected pipe read failure"))
            }
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || read_worker(Broken, true, tx));
        assert!(matches!(
            rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap(),
            WorkerOutput::Error(_)
        ));
        reader.join().unwrap();
    }

    #[test]
    fn worker_events_keep_only_bounded_summary() {
        let mut events = WorkerEvents::default();
        for _ in 0..100_000 {
            events
                .line(b"{\"step\": 1, \"val_nll\": 0.4, \"ignored\": [1,2,3]}\n")
                .unwrap();
        }
        assert_eq!(events.steps, 100_000);
        assert_eq!(events.last_val_nll, json!(0.4));
    }

    #[test]
    fn loops_dedicated_budget_is_a_deadline() {
        let gate = loops_dedicated_budget(Some(26.0), Some(17.0));
        assert_eq!(gate["live_allowed"], true);
        assert_eq!(gate["timeout_s"], 1883);
        assert_eq!(gate["gpu"], Value::Null);
        assert_eq!(gate["billing"], "dedicated trainer, GPU time");
        let refused = loops_dedicated_budget(Some(26.0), None);
        assert_eq!(refused["live_allowed"], false);
        assert!(refused["refusal"].as_str().unwrap().contains("--max-usd"));
        assert_eq!(
            loops_dedicated_budget(Some(26.0), Some(0.5))["live_allowed"],
            false
        );
    }

    #[test]
    fn flags_refuse_unknown_and_keep_repeats() {
        let f = Flags::parse(
            words("--case a --case=b --live --json"),
            &["case"],
            &["live"],
        )
        .unwrap();
        assert_eq!(f.all("case"), ["a", "b"]);
        assert!(f.switches.contains("live"));
        assert!(Flags::parse(words("--base-modle x"), &["base-model"], &[]).is_err());
        assert!(Flags::parse(words("--case"), &["case"], &[]).is_err());
        assert!(Flags::parse(words("stray"), &[], &[]).is_err());
    }

    #[test]
    fn budget_gate_needs_price_cap_and_headroom() {
        assert_eq!(
            budget(Some(3.76e6), None, Some(75.0))["live_allowed"],
            false
        );
        assert_eq!(
            budget(Some(3.76e6), Some(10.0), None)["live_allowed"],
            false
        );
        let over = budget(Some(3.76e6), Some(10.0), Some(30.0));
        assert_eq!(over["estimate_usd"], 37.6);
        assert_eq!(over["live_allowed"], false);
        assert_eq!(
            budget(Some(3.76e6), Some(10.0), Some(75.0))["live_allowed"],
            true
        );
        assert_eq!(budget(None, Some(10.0), Some(75.0))["live_allowed"], false);
    }

    #[test]
    fn modal_cap_becomes_a_timeout() {
        let ok = modal_budget(Some(1.95), Some(10.0), Some("L40S"));
        assert_eq!(ok["live_allowed"], true);
        assert_eq!(ok["timeout_s"], 14769); // 10 / 1.95 h, less 20%
        assert_eq!(
            modal_budget(None, Some(10.0), Some("L40S"))["live_allowed"],
            false
        );
        assert_eq!(
            modal_budget(Some(1.95), None, Some("L40S"))["live_allowed"],
            false
        );
        assert_eq!(
            modal_budget(Some(1.95), Some(10.0), None)["live_allowed"],
            false
        );
        assert_eq!(
            modal_budget(Some(0.0), Some(10.0), Some("L40S"))["live_allowed"],
            false
        );
        assert_eq!(
            modal_budget(Some(3.95), Some(0.05), Some("H100"))["live_allowed"],
            false
        );
    }

    #[test]
    fn worker_python_uses_the_selected_environment_without_resolving_venv_links() {
        let temp = tempfile::tempdir().unwrap();
        let system = temp.path().join("system-python");
        std::fs::write(&system, "").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&system, std::fs::Permissions::from_mode(0o755)).unwrap();
        let blocked = temp.path().join("not-executable");
        std::fs::create_dir(&blocked).unwrap();
        std::fs::write(blocked.join("python3"), "").unwrap();
        let venv = temp.path().join("venv/bin");
        std::fs::create_dir_all(&venv).unwrap();
        std::os::unix::fs::symlink(&system, venv.join("python3")).unwrap();
        let path = std::env::join_paths([&blocked, &venv]).unwrap();
        assert_eq!(
            find_python(Path::new("python3"), Some(&path)).unwrap(),
            venv.join("python3")
        );
        assert_eq!(find_python(&system, None).unwrap(), system);
        assert!(find_python(Path::new("python3"), None).is_err());
    }

    #[test]
    fn hyperparameters_map_to_worker_keys() {
        let f = Flags::parse(
            words("--batch-size 4 --lr 0.0001 --epochs 1"),
            HYPERPARAMETERS,
            &[],
        )
        .unwrap();
        let h = hyperparameter_json(&f).unwrap();
        assert_eq!(h, json!({"batch_size": 4, "lr": 0.0001, "epochs": 1}));
    }

    #[test]
    fn live_retry_only_after_plan_or_failure() {
        assert!(live_retry_allowed(None).is_ok());
        assert!(live_retry_allowed(Some("planned")).is_ok());
        assert!(live_retry_allowed(Some("failed")).is_ok());
        assert!(live_retry_allowed(Some("running")).is_err());
        assert!(live_retry_allowed(Some("completed")).is_err());
    }

    fn eval_flags(s: &str) -> Result<EvalBackend, String> {
        let mut names = vec!["backend"];
        names.extend(EVAL_LOCAL);
        names.extend(EVAL_MODAL_ONLY);
        eval_backend(&Flags::parse(words(s), &names, &[])?)
    }

    #[test]
    fn eval_flags_pick_and_validate_backend() {
        assert_eq!(eval_flags("--out x").unwrap(), EvalBackend::Local);
        assert!(eval_flags("--seeds 3,4").is_err()); // local needs --out
        assert!(eval_flags("--out x --run r").is_err()); // modal-only flag
        assert!(eval_flags("--backend modal").is_err()); // needs --run
        assert!(eval_flags("--backend modal --run ../x").is_err());
        assert!(eval_flags("--backend modal --run r --replay c").is_err()); // local-only flag
        assert!(eval_flags("--backend lane --out x").is_err());
        assert_eq!(
            eval_flags("--backend modal --run smoke-1 --gpu L40S --seeds 3,4").unwrap(),
            EvalBackend::Modal {
                run: "smoke-1".into()
            }
        );
    }

    #[test]
    fn failures_carry_exit_codes() {
        let usage: Failure = "bad".into();
        assert_eq!(usage.code(), 2);
        assert!(usage.message().contains("usage: autophys train"));
        let runtime = Failure::Runtime("boom".into());
        assert_eq!((runtime.code(), runtime.message()), (1, "boom".to_string()));
    }

    #[test]
    fn worker_summary_is_first_json_value() {
        let out =
            "{\n \"billed_token_estimate\": {\"total\": 5}\n}\ndry run: nothing sent to Baseten\n";
        assert_eq!(
            first_json(out).unwrap()["billed_token_estimate"]["total"],
            5
        );
    }
    fn row(policy: &str, pass: &str, errors: Value, parse_failures: u64) -> Value {
        json!({"case": "c", "policy": policy, "pass": pass, "max_rel_error": errors,
               "parse_failures": parse_failures})
    }

    #[test]
    fn report_scores_reason_rows_only() {
        let report = json!([
            row("scripted", "2/2", json!([0.001, 0.001]), 0),
            row("reason", "1/2", json!([0.01, null]), 3),
            row("reason", "2/2", json!([0.0, 0.1]), 1),
        ]);
        let s = score_report(&report).unwrap();
        assert_eq!((s.passes, s.runs, s.parse_failures), (3, 4, 4));
        // log10: -2, cap 50, floor 1e-5 -> -5, -1
        assert!((s.mean_log10_error - (-2.0 + 50.0 - 5.0 - 1.0) / 4.0).abs() < 1e-12);
        assert!(score_report(&json!([row("scripted", "1/1", json!([0.1]), 0)])).is_err());
        assert!(score_report(&json!([row("reason", "1/2", json!([0.1]), 0)])).is_err());
        assert!(score_report(&json!([row("reason", "x", json!([0.1]), 0)])).is_err());
        assert!(score_report(&json!({})).is_err());
    }

    #[test]
    fn python_nonfinite_numbers_become_null() {
        let text = r#"[{"case": "NaN-case \"Infinity\"", "max_rel_error": [Infinity, -Infinity, NaN, 0.1]}]"#;
        let v: Value = serde_json::from_str(&nonfinite_to_null(text)).unwrap();
        assert_eq!(v[0]["case"], "NaN-case \"Infinity\"");
        assert_eq!(v[0]["max_rel_error"], json!([null, null, null, 0.1]));
    }

    #[test]
    fn better_is_lexicographic_and_strict() {
        let s = |passes, err, pf| Score {
            passes,
            runs: 8,
            mean_log10_error: err,
            parse_failures: pf,
        };
        assert!(better(&s(5, 9.0, 9), &s(4, -3.0, 0))); // passes first
        assert!(!better(&s(4, -3.0, 0), &s(5, 9.0, 9)));
        assert!(better(&s(4, -2.0, 9), &s(4, -1.0, 0))); // then lower error
        assert!(better(&s(4, -2.0, 1), &s(4, -2.0, 2))); // then fewer parse failures
        assert!(!better(&s(4, -2.0, 2), &s(4, -2.0, 2))); // a tie keeps the incumbent
    }

    #[test]
    fn budget_splits_by_estimate_and_refuses_short_plans() {
        let candidates = default_candidates(&[]);
        let steps = loop_steps(&candidates[..2]);
        let ests: Vec<u64> = steps.iter().map(|s| s.est_s).collect();
        assert_eq!(ests, [1500, 684, 300, 1068, 300]);
        let caps = plan_caps(3.0, 1.95, "L40S", &ests).unwrap();
        let total: f64 = caps.iter().map(|c| c.0).sum();
        assert!(total <= 3.0);
        for ((cap, timeout), est) in caps.iter().zip(&ests) {
            assert!(*timeout >= *est);
            assert_eq!(
                modal_budget(Some(1.95), Some(*cap), Some("L40S"))["timeout_s"],
                *timeout
            );
        }
        // 3852 GPU-s at $1.95/h with the 0.8 factor needs $2.61; the cent
        // floors on each cap need a little more.
        assert!(plan_caps(2.70, 1.95, "L40S", &ests).is_ok());
        assert!(plan_caps(2.50, 1.95, "L40S", &ests).is_err());
        assert!(plan_caps(3.0, 0.0, "L40S", &ests).is_err());
        // The default three-candidate schedule does not fit $3.
        let all: Vec<u64> = loop_steps(&candidates).iter().map(|s| s.est_s).collect();
        assert!(plan_caps(3.0, 1.95, "L40S", &all).is_err());
        assert_eq!(charge(0.5, 1.95, Some(720.0)), 0.49);
        assert_eq!(charge(0.3, 1.95, Some(720.0)), 0.3);
        assert_eq!(charge(0.3, 1.95, None), 0.3);
    }

    #[test]
    fn candidates_parse_and_refuse_eval_seed_overlap() {
        let eval = [3, 4];
        let ok = r#"[{"label": "big", "dataset": {"train_seeds": "0-2,7-9", "case": ["thermal"]},
                      "hparams": {"epochs": 2, "lr": 0.0001, "batch_size": 4}},
                     {"dataset": {"train_seeds": [0, 1], "val_seeds": "5"}}]"#;
        let c = parse_candidates(ok, &["oscillator".into()], &eval).unwrap();
        assert_eq!(c[0].train_seeds, [0, 1, 2, 7, 8, 9]);
        assert_eq!(c[0].val_seeds, [5, 6]);
        assert_eq!(c[0].cases, ["thermal"]);
        assert_eq!(c[0].epochs(), 2);
        assert_eq!(c[0].est_train_s(), 300 + 32 * 6 * 2);
        assert_eq!(
            c[0].hparam_flags(),
            ["--epochs", "2", "--lr", "0.0001", "--batch-size", "4"]
        );
        assert_eq!(
            (c[1].label.as_str(), c[1].cases.as_slice()),
            ("c2", &["oscillator".to_string()][..])
        );
        let refuse = |text: &str| parse_candidates(text, &[], &eval).unwrap_err();
        assert!(
            refuse(r#"[{"dataset": {"train_seeds": "0-4"}}]"#).contains("overlap the eval seeds")
        );
        assert!(
            refuse(r#"[{"dataset": {"train_seeds": "0", "val_seeds": "3"}}]"#).contains("overlap")
        );
        assert!(refuse(r#"[{"dataset": {"train_seeds": "0,5"}}]"#).contains("share"));
        assert!(refuse(r#"[{"dataset": {"train_seed": "0"}}]"#).contains("unknown key"));
        assert!(
            refuse(r#"[{"dataset": {"train_seeds": "0"}, "hparams": {"epoch": 1}}]"#)
                .contains("unknown hparam")
        );
        assert!(
            refuse(r#"[{"dataset": {"train_seeds": "0"}, "hparams": {"epochs": 1.5}}]"#)
                .contains("integer")
        );
        assert!(refuse("[]").contains("non-empty"));
        assert_eq!(parse_seeds("0-2,7, 9").unwrap(), [0, 1, 2, 7, 9]);
        assert!(parse_seeds("2-1").is_err() && parse_seeds("a").is_err());
        for d in default_candidates(&[]) {
            assert!(d.check_seeds(&eval).is_ok());
        }
        assert!(default_candidates(&[])[2].check_seeds(&[8]).is_err());
    }

    #[test]
    fn loop_start_needs_resume_after_a_live_start() {
        assert!(loop_start_allowed(None, false).is_ok());
        assert!(loop_start_allowed(None, true).is_err());
        assert!(loop_start_allowed(Some("planned"), false).is_ok());
        assert!(loop_start_allowed(Some("failed"), false).is_err());
        assert!(loop_start_allowed(Some("failed"), true).is_ok());
        assert!(loop_start_allowed(Some("running"), true).is_ok());
    }

    #[test]
    fn malformed_loop_state_is_refused_before_resume() {
        let flags = Flags::parse(vec!["--name", "checked", "--base-model", "model", "--gpu", "L40S", "--usd-per-hour", "1.95", "--max-usd", "3"].into_iter().map(String::from).collect(),
            &["name", "base-model", "gpu", "usd-per-hour", "max-usd"], &[]).unwrap();
        let plan = loop_plan(&flags).unwrap();
        let valid = json!({"name": "checked", "status": "planned", "fingerprint": plan.fingerprint(), "cursor": 0,
            "spent_usd": 0.0, "incumbent": null, "consecutive_rejections": 0, "in_flight": null, "steps": []});
        assert!(validate_loop_state(&valid, &plan).is_ok());
        for (field, value) in [("status", json!("unknown")), ("cursor", json!(99)), ("spent_usd", json!(-1)),
            ("steps", json!({})), ("incumbent", json!({})), ("in_flight", json!({"step": 0})),
            ("consecutive_rejections", json!("zero"))] {
            let mut broken = valid.clone(); broken[field] = value;
            assert!(validate_loop_state(&broken, &plan).is_err(), "{field}");
        }
        for malformed in [Value::Null, json!([]), json!({})] {
            assert!(validate_loop_state(&malformed, &plan).is_err());
        }
        let mut resumed = valid.clone();
        resumed["status"] = json!("running");
        resumed["in_flight"] = json!({"step": 0, "cap_usd": 0.5});
        assert!(validate_loop_state(&resumed, &plan).is_ok());
    }
}
