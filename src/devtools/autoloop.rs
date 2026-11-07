//! `autophys autoloop`: research until a stop condition, with a journal and
//! resume. Each iteration asks a researcher for one playbook edit, scores
//! it on the training seeds and keeps it only if it beats the incumbent
//! (lexicographic: any gain; bootstrap: a paired bootstrap gain at level
//! `alpha`). Held-out seeds are scored once, at the end, and never shown
//! to the researcher. Python reference: the former `autophys.autoloop`.
//!
//! The run directory holds all state, so `--resume` continues it:
//! `state.json`, `journal.jsonl`, `spend.jsonl`, `attempts/`,
//! `playbooks/NNN.md`, `train/NNN/`, `heldout/`, `summary.json`, and `STOP`
//! (create it to stop after the current iteration).
use super::bench::PolicyOptions;
use super::research::{
    Proposal, ResearchError, Researcher, evaluate, improves, paired_bootstrap, proposer_report,
    py_sum, score, validate_edit,
};
use super::{Failure, now, random_hex, read_json, sha, stamp, write_json};
use autophys::{agent::heuristic, pyjson};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const HISTORY_LIMIT: usize = 20;

fn diff(old: &str, new: &str) -> String {
    autophys::difflib::unified_diff(old, new, "incumbent", "proposal", 1)
}

fn usage_cost(usage: &Value) -> f64 {
    usage.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.)
}

/// What the researcher may see: its own past proposals and their scores.
fn history(journal: &[Value]) -> Value {
    const KEEP: [&str; 9] = [
        "iteration",
        "hypothesis",
        "prediction",
        "diff",
        "accepted",
        "reason",
        "score",
        "incumbent_score",
        "acceptance",
    ];
    let start = journal.len().saturating_sub(HISTORY_LIMIT);
    Value::Array(
        journal[start..]
            .iter()
            .map(|e| {
                Value::Object(
                    KEEP.iter()
                        .map(|k| (k.to_string(), e.get(*k).cloned().unwrap_or(Value::Null)))
                        .collect(),
                )
            })
            .collect(),
    )
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn read_lines(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    std::fs::read_to_string(path)
        .map_err(err)?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| pyjson::loads(l).map_err(err))
        .collect()
}

fn append_line(path: &Path, line: &str) -> Result<(), String> {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| f.write_all(format!("{line}\n").as_bytes()))
        .map_err(err)
}

/// `json.dumps(v, sort_keys=True)` (journal lines keep Infinity tokens).
fn line(v: &Value) -> String {
    pyjson::dumps_sorted(v)
}

/// Write via a temporary file and rename (state and attempt files).
fn save_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    write_json(&tmp, value).map_err(err)?;
    std::fs::rename(&tmp, path).map_err(err)
}

/// Known dollar cost of the reasoner calls recorded in one workbook
/// (unpriced calls count 0; a workbook cut off mid-write counts what it can).
pub fn workbook_cost(path: &Path) -> f64 {
    let mut total = 0.;
    let Ok(client) = autophys::connect(Some(&path.to_string_lossy())) else {
        return total;
    };
    let Ok(books) = client.workbooks() else {
        return total;
    };
    for wb in books {
        let Ok(infos) = wb.investigations() else {
            return total;
        };
        for info in infos {
            let Ok(records) = wb.investigation(&info.id).and_then(|i| i.records(None)) else {
                return total;
            };
            for r in records {
                if r.kind == "step" {
                    if let Some(c) = r.payload["usage"].get("cost_usd").and_then(Value::as_f64) {
                        total += c;
                    }
                }
            }
        }
    }
    total
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.to_string_lossy().ends_with(".ap-workbook") {
            out.push(p);
        }
    }
}

/// `sorted(directory.rglob("*.ap-workbook"))`.
fn workbooks_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    walk(dir, &mut out);
    out.sort();
    out
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .into_owned()
}

fn name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn num(v: &Value) -> f64 {
    pyjson::as_f64(v).unwrap_or(0.)
}

/// Bind an old scalar total only to evaluations proved complete by its
/// state; ambiguous held-out attempts are refused rather than guessed.
fn preledger_coverage(root: &Path, state: &Value) -> Result<Vec<String>, String> {
    let mut covered: std::collections::BTreeSet<PathBuf> = Default::default();
    let mut completed = 0.;
    for directory in subdirs(&root.join("train")) {
        let n = name(&directory);
        if n.chars().all(|c| c.is_ascii_digit())
            && !n.is_empty()
            && state.get("incumbent").is_some()
            && n.parse::<i64>().unwrap_or(i64::MAX) <= state["iteration"].as_i64().unwrap_or(0)
            && directory.join("report.json").exists()
        {
            let report = read_json(&directory.join("report.json"))?;
            completed += num(&report["score"]["cost_usd"]);
            covered.extend(workbooks_under(&directory));
        }
    }
    let heldout = subdirs(&root.join("heldout"));
    let books: Vec<PathBuf> = heldout.iter().flat_map(|p| workbooks_under(p)).collect();
    if !books.is_empty() {
        let summary_path = root.join("summary.json");
        let summary = if summary_path.exists() {
            read_json(&summary_path)?
        } else {
            json!({})
        };
        let mut expected = vec!["initial"];
        if state.get("initial") != state.get("incumbent") {
            expected.push("final");
        }
        let stopped = state
            .get("stopped")
            .is_some_and(|s| !s.is_null() && s != &json!({}) && s != &json!(false));
        let mut complete = stopped
            && summary
                .get("spent_usd")
                .is_some_and(|v| num(v) == num(&state["spent_usd"]))
            && summary.get("iterations") == state.get("iteration")
            && summary.get("initial_playbook") == state.get("initial")
            && summary.get("final_playbook") == state.get("incumbent");
        let mut directories = std::collections::BTreeSet::new();
        for kind in &expected {
            let matches: Vec<&PathBuf> = heldout
                .iter()
                .filter(|p| name(p).starts_with(&format!("{kind}-")))
                .collect();
            complete =
                complete && matches.len() == 1 && !name(matches[0]).contains(".interrupted-");
            directories.extend(matches.into_iter().cloned());
        }
        if !complete || directories != heldout.iter().cloned().collect() {
            return Err("cannot bind pre-ledger held-out workbooks to recorded spend; restore the original spend ledger or start a new run".into());
        }
        for kind in &expected {
            completed += num(&summary[format!("heldout_{kind}")]["cost_usd"]);
        }
        covered.extend(books);
    }
    if completed > num(&state["spent_usd"]) + 1e-9 {
        return Err("pre-ledger completed evaluations exceed recorded spend; restore the original spend ledger or start a new run".into());
    }
    Ok(covered.iter().map(|p| rel(root, p)).collect())
}

/// How a playbook is scored: `(playbook, cases, seeds, policy, directory,
/// jobs, options)` to a report with `runs`, `score` and
/// `failing_transcripts`. [`evaluate`] by default; tests inject fakes.
pub type Evaluate = std::sync::Arc<
    dyn Fn(&Path, &[String], &[i64], &str, &Path, usize, &PolicyOptions) -> Result<Value, String>
        + Send
        + Sync,
>;

/// The autoloop configuration (CLI flags).
pub struct Config {
    /// The scorer; `None` runs the real [`evaluate`].
    pub evaluate: Option<Evaluate>,
    pub output_dir: PathBuf,
    pub playbook: String,
    pub cases: Vec<String>,
    pub train: Vec<i64>,
    pub heldout: Vec<i64>,
    pub policy: String,
    pub jobs: i64,
    pub max_iterations: i64,
    pub patience: i64,
    pub max_usd: Option<f64>,
    pub max_wall_s: Option<f64>,
    pub resume: bool,
    pub acceptance: String,
    pub repeats: i64,
    pub alpha: f64,
    pub options: PolicyOptions,
}

/// `dataclasses.asdict(ModelSpec)`.
fn spec_dict(spec: &autophys::reasoner::ModelSpec) -> Value {
    json!({"role": spec.role, "route": spec.route, "model": spec.model, "effort": spec.effort,
        "max_tokens": spec.max_tokens, "images": spec.images})
}

/// Python `repr` of a JSON value (dicts, strings, None, True, numbers).
fn py_repr(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::Number(_) => autophys::canonical(v),
        Value::String(s) => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'")),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(m) => format!(
            "{{{}}}",
            m.iter()
                .map(|(k, v)| format!("'{k}': {}", py_repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

struct Loop<'a> {
    evaluate: Evaluate,
    root: PathBuf,
    state: Value,
    cases: Vec<String>,
    policy: String,
    jobs: usize,
    repeats: i64,
    options: &'a PolicyOptions,
}

impl Loop<'_> {
    fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }
    fn journal_path(&self) -> PathBuf {
        self.root.join("journal.jsonl")
    }
    fn save_state(&self) -> Result<(), String> {
        save_atomic(&self.state_path(), &self.state)
    }
    fn journal(&self) -> Result<Vec<Value>, String> {
        read_lines(&self.journal_path())
    }
    fn ledger(&self) -> Result<Vec<Value>, String> {
        read_lines(&self.root.join("spend.jsonl"))
    }
    fn playbook(&self, index: usize, text: &str) -> Result<PathBuf, String> {
        let path = self.root.join("playbooks").join(format!("{index:03}.md"));
        std::fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
        std::fs::write(&path, text).map_err(err)?;
        Ok(path)
    }
    /// Appended when incurred, so spend survives any crash before state.json.
    fn charge(&mut self, what: &str, usd: f64, identity: Option<String>) -> Result<(), String> {
        if usd != 0. {
            append_line(
                &self.root.join("spend.jsonl"),
                &pyjson::dumps(
                    &json!({"at": now(), "what": what, "usd": usd, "identity": identity}),
                ),
            )?;
            self.state["spent_usd"] = json!(num(&self.state["spent_usd"]) + usd);
        }
        Ok(())
    }
    /// Charge workbooks of an interrupted evaluation not yet charged, under
    /// a persisted attempt identity; returns that attempt's path.
    fn recover(&mut self, directory: &Path, label: &str) -> Result<PathBuf, String> {
        let attempt_path = self.root.join("attempts").join(format!("{label}.json"));
        std::fs::create_dir_all(attempt_path.parent().unwrap()).map_err(err)?;
        let entries = self.ledger()?;
        let migrated = entries.iter().find_map(|e| {
            e["coverage_attempts"]
                .get(label)
                .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                .cloned()
        });
        let attempt = if attempt_path.exists() {
            read_json(&attempt_path)?
        } else {
            json!({"id": migrated.unwrap_or_else(|| json!(random_hex(16))), "legacy": directory.exists()})
        };
        save_atomic(&attempt_path, &attempt)?;
        if directory.exists() {
            let charged: std::collections::HashSet<String> = entries
                .iter()
                .filter_map(|e| e["identity"].as_str().map(String::from))
                .collect();
            let legacy: std::collections::HashSet<String> = entries
                .iter()
                .filter(|e| e["identity"].as_str().is_none_or(str::is_empty))
                .filter_map(|e| e["what"].as_str().map(String::from))
                .collect();
            let id = attempt["id"].as_str().unwrap_or("").to_string();
            let covered: std::collections::HashSet<String> = entries
                .iter()
                .filter(|e| {
                    e["coverage_attempts"].get(label).and_then(Value::as_str) == Some(id.as_str())
                })
                .flat_map(|e| {
                    e["covered_workbooks"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                })
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            for workbook in workbooks_under(directory) {
                let parent = workbook.parent().unwrap();
                let part = match parent.strip_prefix(directory) {
                    Ok(p) if p.as_os_str().is_empty() => ".".to_string(),
                    Ok(p) => p.to_string_lossy().into_owned(),
                    Err(_) => ".".into(),
                };
                let what = if part == "." {
                    label.to_string()
                } else {
                    format!("{label}/{part}")
                };
                let evaluation = format!("{id}/{part}");
                let identity = format!("{evaluation}/{}", name(&workbook));
                if !charged.contains(&evaluation)
                    && !charged.contains(&identity)
                    && !covered.contains(&rel(&self.root, &workbook))
                    && !(attempt["legacy"] == true
                        && (legacy.contains(label) || legacy.contains(&what)))
                {
                    self.charge(
                        &format!("{what} (interrupted: {})", name(&workbook)),
                        workbook_cost(&workbook),
                        Some(identity),
                    )?;
                }
            }
        }
        Ok(attempt_path)
    }
    /// Recover and archive any previous attempt, then start a new one.
    fn fresh(&mut self, directory: &Path, label: &str) -> Result<String, String> {
        let attempt_path = self.recover(directory, label)?;
        if directory.exists() {
            let archived = directory.with_file_name(format!(
                "{}.interrupted-{}-{}",
                name(directory),
                stamp(),
                random_hex(4)
            ));
            std::fs::rename(directory, archived).map_err(err)?;
        }
        let id = random_hex(16);
        save_atomic(&attempt_path, &json!({"id": id, "legacy": false}))?;
        Ok(id)
    }
    fn cost(report: &Value) -> f64 {
        pyjson::as_f64(&report["score"]["cost_usd"]).unwrap_or(0.)
    }
    /// Evaluate and charge as it goes: each repeat when it completes.
    fn scored(
        &mut self,
        path: &Path,
        seeds: &[i64],
        directory: &Path,
        label: &str,
    ) -> Result<Value, String> {
        let attempt = self.fresh(directory, label)?;
        let result = if self.repeats == 1 {
            let r = (self.evaluate)(
                path,
                &self.cases,
                seeds,
                &self.policy,
                directory,
                self.jobs,
                self.options,
            )?;
            self.charge(label, Self::cost(&r), Some(format!("{attempt}/.")))?;
            r
        } else {
            let mut parts = vec![];
            for k in 0..self.repeats {
                let part = (self.evaluate)(
                    path,
                    &self.cases,
                    seeds,
                    &self.policy,
                    &directory.join(format!("r{k}")),
                    self.jobs,
                    self.options,
                )?;
                self.charge(
                    &format!("{label}/r{k}"),
                    Self::cost(&part),
                    Some(format!("{attempt}/r{k}")),
                )?;
                parts.push(part);
            }
            let runs: Vec<Value> = parts
                .iter()
                .enumerate()
                .flat_map(|(k, p)| {
                    p["runs"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .map(move |mut r| {
                            r["repeat"] = json!(k);
                            r
                        })
                })
                .collect();
            let failing: Vec<Value> = parts
                .iter()
                .flat_map(|p| {
                    p["failing_transcripts"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                })
                .collect();
            json!({"runs": runs, "score": score(&runs), "failing_transcripts": failing})
        };
        std::fs::create_dir_all(directory).map_err(err)?;
        Ok(result)
    }
}

/// Run the autoloop in `c.output_dir` until a stop condition; return the
/// summary. `max_usd` is checked before each proposal, so one iteration
/// and the closing held-out evaluations can pass it.
pub fn autoloop(researcher: &mut dyn Researcher, c: Config) -> Result<Value, ResearchError> {
    let fail = ResearchError::Failed;
    let root = c.output_dir.clone();
    let (mut cases, mut train, mut heldout, mut policy, mut acceptance, mut repeats, mut alpha) = (
        c.cases.clone(),
        c.train.clone(),
        c.heldout.clone(),
        c.policy.clone(),
        c.acceptance.clone(),
        c.repeats,
        c.alpha,
    );
    let mut options = c.options.clone();
    let state;
    if c.resume {
        let path = root.join("state.json");
        if !path.exists() {
            return Err(fail(format!("nothing to resume in {}", root.display())));
        }
        state = read_json(&path).map_err(fail)?;
        let config = &state["config"];
        let strings = |v: &Value| {
            v.as_array()
                .into_iter()
                .flatten()
                .filter_map(|x| x.as_str().map(String::from))
                .collect::<Vec<_>>()
        };
        let ints = |v: &Value| {
            v.as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_i64)
                .collect::<Vec<_>>()
        };
        cases = strings(&config["cases"]);
        train = ints(&config["train_seeds"]);
        heldout = ints(&config["heldout_seeds"]);
        policy = config["policy"].as_str().unwrap_or("").to_string();
        acceptance = config["acceptance"]
            .as_str()
            .unwrap_or("lexicographic")
            .to_string();
        repeats = config["repeats"].as_i64().unwrap_or(1);
        alpha = config["alpha"].as_f64().unwrap_or(alpha);
        // Scores are only comparable under the policy model of the incumbent's.
        if policy == "reason" {
            let Some(stored) = config.get("model_spec") else {
                return Err(fail("this run does not record its policy model, so it cannot be resumed safely; start a new run".into()));
            };
            let given = options
                .model_spec
                .as_ref()
                .map(spec_dict)
                .unwrap_or(Value::Null);
            if given.is_null() && !stored.is_null() {
                options.model_spec = serde_json::from_value(stored.clone()).ok();
            } else if &given != stored {
                return Err(fail(format!(
                    "resume must use the run's policy model {}, not {}",
                    py_repr(stored),
                    py_repr(&given)
                )));
            }
        }
    } else {
        if cases.is_empty() {
            cases = autophys::synthetic::CASES.map(String::from).to_vec();
        }
        if train.iter().any(|s| heldout.contains(s)) || train.is_empty() || heldout.is_empty() {
            return Err(fail(
                "train and held-out seeds must be non-empty and disjoint".into(),
            ));
        }
        if cases.iter().any(|x| !super::research::known_case(x)) {
            return Err(fail("unknown case".into()));
        }
        if c.jobs < 1
            || c.max_iterations < 0
            || c.patience < 1
            || repeats < 1
            || !(alpha > 0. && alpha < 1.)
        {
            return Err(fail(
                "invalid jobs, max_iterations, patience, repeats or alpha".into(),
            ));
        }
        if acceptance == "auto" {
            acceptance = if policy == "reason" {
                "bootstrap"
            } else {
                "lexicographic"
            }
            .into();
        }
        if !["lexicographic", "bootstrap"].contains(&acceptance.as_str()) {
            return Err(fail(format!("unknown acceptance rule '{acceptance}'")));
        }
        if root.exists() {
            return Err(fail(format!(
                "[Errno 17] File exists: '{}'",
                root.display()
            )));
        }
        std::fs::create_dir_all(&root).map_err(|e| fail(e.to_string()))?;
        let config = json!({"cases": cases, "train_seeds": train, "heldout_seeds": heldout, "policy": policy,
            "playbook": c.playbook, "acceptance": acceptance, "repeats": repeats, "alpha": alpha,
            "model_spec": options.model_spec.as_ref().map(spec_dict)});
        state = json!({"config": config, "started_at": now(), "iteration": 0, "rejected_in_a_row": 0,
            "spent_usd": 0.0, "wall_s": 0.0});
    }
    if policy == "reason"
        && options.replay.is_none()
        && super::env_replay().is_none()
        && !super::live_allowed()
    {
        return Err(fail(
            "research requires --replay; live calls require AUTOPHYS_ALLOW_LIVE_REASON=1".into(),
        ));
    }
    let evaluate_fn: Evaluate = c
        .evaluate
        .clone()
        .unwrap_or_else(|| std::sync::Arc::new(evaluate));
    let mut run = Loop {
        evaluate: evaluate_fn,
        root: root.clone(),
        state,
        cases: cases.clone(),
        policy: policy.clone(),
        jobs: c.jobs.max(1) as usize,
        repeats,
        options: &options,
    };
    // Saved before the baseline, so an interrupted baseline can be resumed.
    if !c.resume {
        run.save_state().map_err(fail)?;
    }
    let decide = |trial: &Value, incumbent: &Value, index: usize| -> (bool, Value) {
        if acceptance == "bootstrap" {
            let empty = vec![];
            paired_bootstrap(
                trial["runs"].as_array().unwrap_or(&empty),
                incumbent["runs"].as_array().unwrap_or(&empty),
                alpha,
                2000,
                index as u64,
            )
        } else {
            (
                improves(&trial["score"], &incumbent["score"]),
                json!({"rule": "lexicographic"}),
            )
        }
    };
    let t0 = Instant::now();
    let wall_before = num(&run.state["wall_s"]);
    if c.resume {
        // Publish the scalar total and its coverage together.
        if !root.join("spend.jsonl").exists() {
            let covered = preledger_coverage(&root, &run.state).map_err(fail)?;
            if num(&run.state["spent_usd"]) != 0. || !covered.is_empty() {
                let labels: std::collections::BTreeSet<String> = covered
                    .iter()
                    .map(|p| p.split('/').take(2).collect::<Vec<_>>().join("/"))
                    .collect();
                let mut attempts = serde_json::Map::new();
                for label in labels {
                    let metadata = root.join("attempts").join(format!("{label}.json"));
                    let id = if metadata.exists() {
                        read_json(&metadata).map_err(fail)?["id"].clone()
                    } else {
                        json!(random_hex(16))
                    };
                    attempts.insert(label, id);
                }
                let entry = json!({"at": now(), "what": "before the spend ledger", "usd": run.state["spent_usd"],
                    "identity": null, "covered_workbooks": covered, "coverage_attempts": attempts});
                let pending = root.join("spend.jsonl.tmp");
                std::fs::write(&pending, pyjson::dumps(&entry) + "\n")
                    .map_err(|e| fail(e.to_string()))?;
                std::fs::rename(&pending, root.join("spend.jsonl"))
                    .map_err(|e| fail(e.to_string()))?;
            }
        }
        let ledger = run.ledger().map_err(fail)?;
        run.state["spent_usd"] = if ledger.is_empty() {
            json!(0)
        } else {
            json!(py_sum(ledger.iter().map(|e| num(&e["usd"]))))
        };
        for directory in subdirs(&root.join("heldout")) {
            let n = name(&directory);
            if (n.starts_with("initial-") || n.starts_with("final-"))
                && !n.contains(".interrupted-")
            {
                run.recover(&directory, &format!("heldout/{n}"))
                    .map_err(fail)?;
            }
        }
    }
    let mut text;
    let mut report;
    if run.state.get("incumbent").is_none() {
        let book = if c.resume {
            run.state["config"]["playbook"]
                .as_str()
                .unwrap_or("default")
                .to_string()
        } else {
            c.playbook.clone()
        };
        text = super::research::playbook_text(&book).map_err(fail)?;
        let path = run.playbook(0, &text).map_err(fail)?;
        report = run
            .scored(&path, &train, &root.join("train").join("000"), "train/000")
            .map_err(fail)?;
        run.state["incumbent"] = json!(name(&path));
        run.state["incumbent_sha256"] = json!(sha(&text));
        run.state["incumbent_score"] = report["score"].clone();
        run.state["initial"] = json!(name(&path));
        write_json(&root.join("train").join("000").join("report.json"), &report)
            .map_err(|e| fail(e.to_string()))?;
        run.save_state().map_err(fail)?;
    } else {
        let incumbent = run.state["incumbent"].as_str().unwrap_or("").to_string();
        let path = root.join("playbooks").join(&incumbent);
        text = std::fs::read_to_string(&path).map_err(|e| fail(e.to_string()))?;
        let stem = incumbent.strip_suffix(".md").unwrap_or(&incumbent);
        report = read_json(&root.join("train").join(stem).join("report.json")).map_err(fail)?;
        // state.json is written after the journal line; set aside lines it never committed.
        let journal = run.journal().map_err(fail)?;
        let committed = run.state["iteration"].as_i64().unwrap_or(0);
        if journal
            .iter()
            .any(|e| e["iteration"].as_i64().unwrap_or(0) > committed)
        {
            for e in journal
                .iter()
                .filter(|e| e["iteration"].as_i64().unwrap_or(0) > committed)
            {
                append_line(&root.join("journal.orphaned.jsonl"), &line(e)).map_err(fail)?;
            }
            let kept: String = journal
                .iter()
                .filter(|e| e["iteration"].as_i64().unwrap_or(0) <= committed)
                .map(|e| line(e) + "\n")
                .collect();
            std::fs::write(run.journal_path(), kept).map_err(|e| fail(e.to_string()))?;
        }
    }

    let mut stop = None;
    loop {
        let wall = wall_before + t0.elapsed().as_secs_f64();
        let iteration = run.state["iteration"].as_i64().unwrap_or(0);
        let rejected = run.state["rejected_in_a_row"].as_i64().unwrap_or(0);
        if root.join("STOP").exists() {
            stop = Some("stop file".to_string());
        } else if iteration >= c.max_iterations {
            stop = Some("max iterations".into());
        } else if rejected >= c.patience {
            stop = Some(format!("{} rejections in a row", c.patience));
        } else if c.max_usd.is_some_and(|m| num(&run.state["spent_usd"]) >= m) {
            stop = Some("budget".into());
        } else if c.max_wall_s.is_some_and(|m| wall >= m) {
            stop = Some("wall time".into());
        }
        if stop.is_some() {
            break;
        }
        let index = iteration as usize + 1;
        let mut entry = json!({"iteration": index, "at": now(), "incumbent": run.state["incumbent"],
            "incumbent_score": run.state["incumbent_score"], "hypothesis": null, "prediction": null});
        let past = history(&run.journal().map_err(fail)?);
        let proposal = match researcher.propose(&text, &proposer_report(&report), Some(&past)) {
            Err(ResearchError::Budget(_)) => {
                stop = Some("researcher budget error".into());
                break;
            }
            Err(ResearchError::Invalid(m)) => Err(m),
            Err(e) => return Err(e),
            Ok(p) => Ok(p),
        };
        let usage = researcher.last_usage();
        run.charge(&format!("researcher/{index:03}"), usage_cost(&usage), None)
            .map_err(fail)?;
        entry["researcher_usage"] = usage;
        let events = researcher.last_events();
        if events.is_object() {
            entry["researcher_events"] =
                json!({"terminal": events.get("terminal"), "usage": events.get("usage")});
        }
        let proposal = match proposal {
            Ok(None) => {
                stop = Some("researcher has no further proposal".into());
                break;
            }
            Ok(Some(Proposal::Text(t))) => Ok(Value::String(t)),
            Ok(Some(Proposal::Dict {
                skill,
                hypothesis,
                prediction,
            })) => {
                entry["hypothesis"] = hypothesis;
                entry["prediction"] = prediction;
                Ok(skill)
            }
            Err(m) => Err(m),
        };
        let checked = proposal.and_then(|p| match p.as_str() {
            Some(t) => validate_edit(&text, t).map_err(|e| e.message()),
            None => Err("researcher returned no SKILL.md text".into()),
        });
        match checked {
            Err(m) => {
                for (k, v) in [
                    ("accepted", json!(false)),
                    ("reason", json!(format!("invalid edit: {m}"))),
                    ("score", Value::Null),
                    ("playbook", Value::Null),
                    ("diff", Value::Null),
                ] {
                    entry[k] = v;
                }
            }
            Ok(proposed) => {
                let candidate = run.playbook(index, &proposed).map_err(fail)?;
                let directory = root.join("train").join(format!("{index:03}"));
                let trial = run
                    .scored(&candidate, &train, &directory, &format!("train/{index:03}"))
                    .map_err(fail)?;
                write_json(&directory.join("report.json"), &trial)
                    .map_err(|e| fail(e.to_string()))?;
                let (accepted, stats) = decide(&trial, &report, index);
                let reason = if accepted {
                    "improves on the incumbent".to_string()
                } else {
                    stats
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("does not improve on the incumbent")
                        .to_string()
                };
                for (k, v) in [
                    ("accepted", json!(accepted)),
                    ("score", trial["score"].clone()),
                    ("playbook", json!(name(&candidate))),
                    ("sha256", json!(sha(&proposed))),
                    ("diff", json!(diff(&text, &proposed))),
                    ("acceptance", stats),
                    ("reason", json!(reason)),
                ] {
                    entry[k] = v;
                }
                if accepted {
                    run.state["incumbent"] = json!(name(&candidate));
                    run.state["incumbent_sha256"] = json!(sha(&proposed));
                    run.state["incumbent_score"] = trial["score"].clone();
                    text = proposed;
                    report = trial;
                }
            }
        }
        run.state["iteration"] = json!(index);
        run.state["rejected_in_a_row"] = json!(if entry["accepted"] == true {
            0
        } else {
            rejected + 1
        });
        run.state["wall_s"] = json!(wall_before + t0.elapsed().as_secs_f64());
        append_line(&run.journal_path(), &line(&entry)).map_err(fail)?;
        run.save_state().map_err(fail)?;
    }

    let initial = root
        .join("playbooks")
        .join(run.state["initial"].as_str().unwrap_or(""));
    let final_ = root
        .join("playbooks")
        .join(run.state["incumbent"].as_str().unwrap_or(""));
    let when = stamp();
    let held_initial = run
        .scored(
            &initial,
            &heldout,
            &root.join("heldout").join(format!("initial-{when}")),
            &format!("heldout/initial-{when}"),
        )
        .map_err(fail)?;
    let held_final = if final_ != initial {
        run.scored(
            &final_,
            &heldout,
            &root.join("heldout").join(format!("final-{when}")),
            &format!("heldout/final-{when}"),
        )
        .map_err(fail)?
    } else {
        held_initial.clone()
    };
    run.state["wall_s"] = json!(wall_before + t0.elapsed().as_secs_f64());
    run.state["stopped"] = json!({"at": now(), "reason": stop});
    run.save_state().map_err(fail)?;
    let journal = run.journal().map_err(fail)?;
    let train_initial = read_json(&root.join("train").join("000").join("report.json"))
        .map_err(fail)?["score"]
        .clone();
    let empty = vec![];
    let comparison =
        if final_ != initial && held_final["runs"].as_array().is_some_and(|a| !a.is_empty()) {
            paired_bootstrap(
                held_final["runs"].as_array().unwrap_or(&empty),
                held_initial["runs"].as_array().unwrap_or(&empty),
                alpha,
                2000,
                0,
            )
            .1
        } else {
            Value::Null
        };
    let summary = json!({"stop_reason": stop, "iterations": run.state["iteration"],
        "accepted": journal.iter().filter(|e| e["accepted"] == true).count(),
        "initial_playbook": run.state["initial"], "final_playbook": run.state["incumbent"],
        "train_initial": train_initial, "train_final": run.state["incumbent_score"],
        "heldout_initial": held_initial["score"], "heldout_final": held_final["score"],
        "spent_usd": run.state["spent_usd"], "wall_s": run.state["wall_s"],
        "acceptance": run.state["config"].get("acceptance").cloned().unwrap_or(json!("lexicographic")),
        "heldout_comparison": comparison, "cases": cases, "train_seeds": train, "heldout_seeds": heldout});
    write_json(&root.join("summary.json"), &summary).map_err(|e| fail(e.to_string()))?;
    Ok(summary)
}

/// An offline researcher that diagnoses failing transcripts and edits the
/// typed settings ([`heuristic::STRATEGY_SETTINGS`]). It knows two failure
/// patterns (a base-model misfit with an uncompared sensor-bias variant;
/// unidentified parameters with experiments forbidden); anything else ends
/// the loop.
pub struct HeuristicResearcher;

impl Researcher for HeuristicResearcher {
    fn propose(
        &mut self,
        playbook: &str,
        report: &Value,
        history: Option<&Value>,
    ) -> Result<Option<Proposal>, ResearchError> {
        let invalid =
            |e: autophys::simulator::SimulationError| ResearchError::Invalid(e.to_string());
        let settings =
            heuristic::strategy_settings(&format!("Strategy:\n{playbook}")).map_err(invalid)?;
        let tried: std::collections::HashSet<String> = history
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|e| e["accepted"] != true)
            .map(|e| e["diff"].as_str().unwrap_or("").to_string())
            .collect();
        let empty = vec![];
        let failing: Vec<&Vec<Value>> = report["failing_transcripts"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .map(|t| t["records"].as_array().unwrap_or(&empty))
            .collect();
        let outcomes: Vec<Option<&Value>> = failing
            .iter()
            .map(|recs| {
                recs.iter()
                    .rev()
                    .find(|r| r["kind"] == "outcome")
                    .map(|r| &r["payload"])
            })
            .collect();
        let steps: Vec<Vec<&Value>> = failing
            .iter()
            .map(|recs| {
                recs.iter()
                    .filter(|r| r["kind"] == "step")
                    .map(|r| &r["payload"])
                    .collect()
            })
            .collect();
        let has_variants = |s: &[&Value]| {
            s.iter().any(|p| {
                let text = p["evidence_text"].as_str().unwrap_or("");
                text.rsplit("variants=")
                    .next()
                    .unwrap_or("")
                    .split('\n')
                    .next()
                    .unwrap_or("")
                    .contains(',')
            })
        };
        let compared = |s: &[&Value]| {
            s.iter()
                .any(|p| p["decision"]["action"] == "compare_models")
        };
        let misfit: Vec<f64> = outcomes
            .iter()
            .zip(&steps)
            .filter_map(|(o, s)| {
                let o = (*o)?;
                let chi = o["fit"]
                    .get("chi2_per_n")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.);
                (o["fit"].is_object()
                    && chi > 2.
                    && o["model"] == "base"
                    && has_variants(s)
                    && !compared(s))
                .then_some(chi)
            })
            .collect();
        if !misfit.is_empty() && settings["compare_variants"] == "never" {
            let skill = heuristic::set_setting(playbook, "compare_variants", "on_misfit")
                .map_err(invalid)?;
            let (lo, hi) = misfit
                .iter()
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), x| {
                    (a.min(*x), b.max(*x))
                });
            let hypothesis = format!(
                "{} failing run(s) end on the base model with chi2/N {lo:.1}-{hi:.1}, although a sensor-bias variant exists and was never compared; a constant sensor offset would explain that misfit.",
                misfit.len()
            );
            if !tried.contains(&diff(playbook, &skill)) {
                return Ok(Some(Proposal::Dict {
                    skill: json!(skill),
                    hypothesis: json!(hypothesis),
                    prediction: json!(
                        "those runs adopt the sensor-bias variant and validate; other runs are unchanged."
                    ),
                }));
            }
        }
        let starved = outcomes
            .iter()
            .flatten()
            .filter(|o| {
                let non = &o["non_identified"];
                let truthy = |v: &Value| match v {
                    Value::Null => false,
                    Value::Array(a) => !a.is_empty(),
                    Value::Number(n) => n.as_f64() != Some(0.),
                    Value::Bool(b) => *b,
                    Value::String(s) => !s.is_empty(),
                    Value::Object(m) => !m.is_empty(),
                };
                truthy(non) && !truthy(&o["experiments"])
            })
            .count();
        if starved > 0 && settings["experiments"] == "none" {
            let skill =
                heuristic::set_setting(playbook, "experiments", "as_needed").map_err(invalid)?;
            if !tried.contains(&diff(playbook, &skill)) {
                return Ok(Some(Proposal::Dict {
                    skill: json!(skill),
                    hypothesis: json!(format!(
                        "{starved} failing run(s) stop with unidentified parameters after no experiments, because the playbook forbids requesting any."
                    )),
                    prediction: json!(
                        "those runs request the top-ranked experiment and identify the parameters."
                    ),
                }));
            }
        }
        Ok(None)
    }
}

pub const USAGE: &str = "usage: autophys autoloop --output-dir DIR [research flags] [--resume] [--max-iterations N] [--patience N] [--max-usd X] [--max-wall-s S] [--acceptance auto|lexicographic|bootstrap] [--repeats N] [--alpha A] [--jobs N]";

/// `autophys autoloop`.
pub fn command(words: Vec<String>, out: &mut impl std::io::Write) -> Result<(), Failure> {
    use super::Kind::*;
    let mut spec: Vec<(&str, super::Kind)> = super::research::RESEARCH_FLAGS.to_vec();
    spec.extend([
        ("resume", Switch),
        ("max-iterations", Value),
        ("patience", Value),
        ("max-usd", Value),
        ("max-wall-s", Value),
        ("acceptance", Value),
        ("repeats", Value),
        ("alpha", Value),
        ("jobs", Value),
    ]);
    let args = super::Args::parse(words, &spec, USAGE)?;
    if !args.positional.is_empty() {
        return Err(Failure::usage(format!(
            "unrecognized arguments: {}\n{USAGE}",
            args.positional.join(" ")
        )));
    }
    let common = super::research::common(&args, USAGE)?;
    let acceptance = args.choice(
        "acceptance",
        "auto",
        &["auto", "lexicographic", "bootstrap"],
    )?;
    let mut researcher = super::research::researcher(&args)?;
    let config = Config {
        evaluate: None,
        output_dir: common.output_dir,
        playbook: common.playbook,
        cases: common.cases,
        train: common.train,
        heldout: common.heldout,
        policy: common.policy,
        jobs: common.jobs,
        max_iterations: args.int("max-iterations", 10)?,
        patience: args.int("patience", 3)?,
        max_usd: args.float("max-usd")?,
        max_wall_s: args.float("max-wall-s")?,
        resume: args.flag("resume"),
        acceptance,
        repeats: args.int("repeats", 1)?,
        alpha: args.float("alpha")?.unwrap_or(0.05),
        options: common.options,
    };
    let summary = autoloop(researcher.as_mut(), config).map_err(|e| Failure::error(e.message()))?;
    writeln!(out, "{}", pyjson::dumps_indent(&summary, 2, false))
        .map_err(|e| Failure::error(e.to_string()))
}
