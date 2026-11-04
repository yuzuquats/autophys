//! `autophys train`: post-training of a decision policy, driven from the CLI.
//!
//! Rust owns the workflow: building the dataset, the budget gate, run
//! manifests, evaluation and the run history. A Python worker in `train/sft`
//! does what has to live next to the model: chat templates, tokenization and
//! the GPU step (today Baseten Loops). Training data is a view of synthetic
//! investigations; this module adds no state to the record store.
//!
//! Nothing here spends money unless `train run --live` passes the budget
//! gate: an explicit price, an explicit cap and an estimate under that cap.
//! Provider keys are only ever checked for presence, never read or written.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const USAGE: &str =
    "usage: autophys train dataset [--out DIR] [--train-seeds 0,1,2] [--val-seeds 5,6]
                               [--heldout-seeds 3,4] [--case NAME]... [--playbook NAME]
                               [--backend local|modal --usd-per-hour X --max-usd Y]
       autophys train run --name NAME --base-model HF_ID --data DIR [--backend loops|modal]
                          [--rank N] [--epochs N] [--batch-size N] [--lr X] [--max-seq-len N]
                          [--warmup N] [--eval-every N] [--seed N] [--scope S]
                          loops: [--usd-per-mtok X --max-usd Y --live]   (serverless, billed per token)
                          loops: [--usd-per-hour X --max-usd Y --live]   (dedicated trainer, billed by GPU time)
                          modal: [--gpu L40S|A100-80GB|H100 --usd-per-hour X --max-usd Y --live]
       autophys train eval --out DIR [--model NAME] [--seeds 3,4] [--case NAME]...
                           [--policy reason|scripted]... [--route baseten|meta|lane] [--replay FILE]
       autophys train eval --backend modal --run NAME --gpu GPU --usd-per-hour X --max-usd Y
                           [--out DIR] [--seeds 3,4] [--case NAME]...
       autophys train runs
       (all take --train-dir DIR (AUTOPHYS_TRAIN_DIR, default <project>/train/sft)
        and --python FILE (AUTOPHYS_TRAIN_PYTHON, default ~/autophys-train/.venv/bin/python))";

const BACKENDS: &[&str] = &["loops", "modal"];

/// Why a train command failed. Usage errors exit 2 (with USAGE); runtime
/// failures (worker, budget refusal, provider) exit 1. Bare `String` errors
/// come from argument validation, so they convert to `Usage`.
#[derive(Debug, PartialEq)]
pub enum Failure {
    Usage(String),
    Runtime(String),
}

impl Failure {
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
            } else if valued.contains(&name) || ["train-dir", "python"].contains(&name) {
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
                return Err(format!("unknown flag --{name}\n{USAGE}"));
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

/// Where the worker scripts live and which interpreter runs them.
struct Worker {
    dir: PathBuf,
    python: PathBuf,
}

impl Worker {
    fn new(flags: &Flags) -> Result<Self> {
        let dir = flags
            .get("train-dir")
            .map(PathBuf::from)
            .or_else(|| env_path("AUTOPHYS_TRAIN_DIR"))
            .unwrap_or_else(|| crate::project_root().join("train").join("sft"));
        let python = flags
            .get("python")
            .map(PathBuf::from)
            .or_else(|| env_path("AUTOPHYS_TRAIN_PYTHON"))
            .or_else(|| env_path("HOME").map(|h| h.join("autophys-train/.venv/bin/python")))
            .ok_or_else(|| anyhow!("set --python or AUTOPHYS_TRAIN_PYTHON"))?;
        if !dir.join("train_sft.py").is_file() {
            bail!(
                "{} has no train_sft.py; set --train-dir or AUTOPHYS_TRAIN_DIR",
                dir.display()
            );
        }
        if !python.is_file() {
            bail!(
                "python {} not found; set --python or AUTOPHYS_TRAIN_PYTHON (see train/sft/README.md, Setup)",
                python.display()
            );
        }
        Ok(Worker { dir, python })
    }

    fn command(&self, script: &str, args: &[String]) -> Command {
        let mut cmd = Command::new(&self.python);
        cmd.arg(self.dir.join(script))
            .args(args)
            .current_dir(&self.dir);
        cmd
    }

    /// Run to completion and capture stdout; stderr streams to the terminal.
    fn capture(&self, script: &str, args: &[String]) -> Result<String> {
        let out = self
            .command(script, args)
            .stdin(Stdio::null())
            .stderr(Stdio::inherit())
            .output()
            .with_context(|| format!("starting {script}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        if !out.status.success() {
            eprint!("{stdout}");
            bail!("{script} exited with {}", out.status);
        }
        Ok(stdout)
    }

    /// Run while echoing stdout to stderr (stdout stays for the final JSON),
    /// and collect every stdout line that is a JSON object.
    fn stream(&self, script: &str, args: &[String]) -> Result<(bool, Vec<Value>)> {
        let mut argv = vec![self.dir.join(script).display().to_string()];
        argv.extend_from_slice(args);
        self.stream_raw(&argv)
    }

    /// `stream` with the interpreter's own arguments (for `-m modal run ...`).
    /// Modal prints container logs with its own prefixes, so JSON events are
    /// also found after the first `{` of a line.
    fn stream_raw(&self, argv: &[String]) -> Result<(bool, Vec<Value>)> {
        let mut child = Command::new(&self.python)
            .args(argv)
            .current_dir(&self.dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("starting {}", argv.join(" ")))?;
        let mut events = Vec::new();
        let stdout = child.stdout.take().expect("piped stdout");
        for line in BufReader::new(stdout).lines() {
            let line = line?;
            eprintln!("{line}");
            if let Some(start) = line.find('{') {
                if let Ok(value @ Value::Object(_)) = serde_json::from_str::<Value>(&line[start..])
                {
                    events.push(value);
                }
            }
        }
        Ok((child.wait()?.success(), events))
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
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    std::fs::rename(&tmp, path)?;
    Ok(())
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
        let out = absolute(
            flags
                .get("out")
                .map(PathBuf::from)
                .unwrap_or_else(|| worker.dir.join("data")),
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
            eprint!("{stdout}");
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
        let run_dir = worker.dir.join("runs").join(&name);
        let manifest_path = run_dir.join("manifest.json");
        if live {
            let previous = read_json(&manifest_path).ok();
            let status = previous.as_ref().and_then(|m| m["status"].as_str());
            live_retry_allowed(status).map_err(|why| anyhow!("run {name:?} {why}"))?;
        }
        let mut argv = vec![
            "--name".to_string(),
            name.clone(),
            "--base-model".to_string(),
            base_model.clone(),
            "--data".to_string(),
            data.display().to_string(),
        ];
        argv.extend(flags.passthrough(HYPERPARAMETERS));

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
        // A stale record from an earlier attempt must not count as this run's.
        let _ = std::fs::remove_file(run_dir.join("run.json"));

        manifest["status"] = json!("running");
        manifest["started_at"] = json!(now());
        write_json(&manifest_path, &manifest)?;
        let (ok, events) = if backend == "modal" {
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
                "--hparams".into(),
                hparams.to_string(),
            ])?
        } else {
            argv.push("--live".into());
            if dedicated {
                argv.push("--allow-dedicated".into());
                argv.push("--max-seconds".into());
                argv.push(gate["timeout_s"].to_string());
            }
            worker.stream("train_sft.py", &argv)?
        };
        let record = read_json(&run_dir.join("run.json")).ok();
        manifest["status"] = json!(if ok && record.is_some() {
            "completed"
        } else {
            "failed"
        });
        manifest["finished_at"] = json!(now());
        manifest["steps"] = json!(events.iter().filter(|e| e.get("step").is_some()).count());
        manifest["last_val_nll"] = events
            .iter()
            .rev()
            .find_map(|e| e.get("val_nll"))
            .cloned()
            .unwrap_or(Value::Null);
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
            ] {
                if let Some(value) = record.get(key) {
                    manifest[key] = value.clone();
                }
            }
        }
        write_json(&manifest_path, &manifest)?;
        if manifest["status"] != "completed" {
            bail!("training failed; see {}", manifest_path.display());
        }
        Ok(manifest)
    };
    go().map_err(runtime)
}

const EVAL_LOCAL: &[&str] = &["out", "model", "seeds", "case", "policy", "route", "replay"];
const EVAL_MODAL_ONLY: &[&str] = &["run", "gpu", "usd-per-hour", "max-usd"];
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
    if gate["live_allowed"] != true {
        bail!(
            "modal eval refused: {}",
            gate["refusal"].as_str().unwrap_or("budget gate")
        );
    }
    let worker = Worker::new(flags)?;
    let run_dir = worker.dir.join("runs").join(run);
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

    let out = absolute(
        flags
            .get("out")
            .map(PathBuf::from)
            .unwrap_or_else(|| run_dir.join("eval")),
    )?;
    // A report from an earlier attempt must not count as this one's.
    let _ = std::fs::remove_file(out.join("report.json"));
    let mut options = serde_json::Map::new();
    if let Some(seeds) = flags.get("seeds") {
        options.insert("seeds".into(), json!(seeds));
    }
    if !flags.all("case").is_empty() {
        options.insert("case".into(), json!(flags.all("case")));
    }
    let gpu = gate["gpu"].as_str().unwrap_or_default().to_string();
    let started_at = now();
    let streamed = worker.stream_raw(&[
        "-m".into(),
        "modal".into(),
        "run".into(),
        worker
            .dir
            .join("modal_app.py::eval_main")
            .display()
            .to_string(),
        "--run".into(),
        run.to_string(),
        "--base-model".into(),
        base_model,
        "--out".into(),
        out.display().to_string(),
        "--gpu".into(),
        gpu.clone(),
        "--timeout".into(),
        gate["timeout_s"].to_string(),
        "--args".into(),
        Value::Object(options).to_string(),
    ]);
    let report = match &streamed {
        Ok((true, _)) => read_json(&out.join("report.json")).ok(),
        _ => None,
    };
    // Re-read so a concurrent `train runs` view or edit is not clobbered.
    let mut manifest = read_json(&manifest_path)?;
    let mut record = json!({
        "status": if report.is_some() { "completed" } else { "failed" },
        "out": out.display().to_string(),
        "gpu": gpu,
        "budget": gate,
        "started_at": started_at,
        "finished_at": now(),
    });
    if let Some(report) = &report {
        record["report"] = report.clone();
    }
    manifest["eval"] = record;
    write_json(&manifest_path, &manifest)?;
    match (streamed, report) {
        (_, Some(report)) => Ok(report),
        (Err(e), None) => Err(e.context(format!(
            "modal eval failed; see {}",
            manifest_path.display()
        ))),
        (Ok(_), None) => bail!("modal eval failed; see {}", manifest_path.display()),
    }
}

/// `train runs`: every run manifest, newest first.
pub fn runs(args: Vec<String>) -> Result<Value, Failure> {
    let flags = Flags::parse(args, &[], &[])?;
    let go = || -> Result<Value> {
        let worker = Worker::new(&flags)?;
        let mut rows = Vec::new();
        let Ok(entries) = std::fs::read_dir(worker.dir.join("runs")) else {
            return Ok(Value::Array(rows));
        };
        for entry in entries.flatten() {
            let path = entry.path().join("manifest.json");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
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
}
