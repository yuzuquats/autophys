//! `autophys research`: offline-first playbook research. Each iteration
//! asks a researcher for one SKILL.md edit, scores it on the training seeds
//! and keeps it only if it beats the incumbent; held-out seeds are scored
//! once at the end. Reports are sidecars, never workbook fields. Python
//! reference: the former `autophys.research`.
use super::bench::{PolicyOptions, Unit, run_units};
use super::{Failure, read_json, write_json};
use autophys::{
    canonical, pyjson,
    pyrandom::PyRandom,
    reasoner::{ModelSpec, ReasonOptions, Reasoner, ReasonerConfig, reasoner_for},
    simulator::SimulationError,
    synthetic,
};
use serde_json::{Map, Value, json};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Why a proposal did not become a candidate, or the run failed.
#[derive(Debug)]
pub enum ResearchError {
    /// The researcher returned an unusable edit: a rejected iteration.
    Invalid(String),
    /// Billing refused a call (HTTP 402): stop.
    Budget(String),
    /// Any other failure ends the command.
    Failed(String),
}
impl From<SimulationError> for ResearchError {
    fn from(e: SimulationError) -> Self {
        match e {
            SimulationError::BudgetError(m) => Self::Budget(m),
            e => Self::Failed(e.to_string()),
        }
    }
}
impl ResearchError {
    pub fn message(&self) -> String {
        match self {
            Self::Invalid(m) | Self::Budget(m) | Self::Failed(m) => m.clone(),
        }
    }
}

/// A researcher's answer: the complete SKILL.md, or a dict with `skill`,
/// `hypothesis` and `prediction`.
#[derive(Clone, Debug)]
pub enum Proposal {
    Text(String),
    Dict {
        skill: Value,
        hypothesis: Value,
        prediction: Value,
    },
}

pub trait Researcher {
    /// `None`: nothing further to propose.
    fn propose(
        &mut self,
        playbook: &str,
        report: &Value,
        history: Option<&Value>,
    ) -> Result<Option<Proposal>, ResearchError>;
    fn last_usage(&self) -> Value {
        Value::Null
    }
    fn last_events(&self) -> Value {
        Value::Null
    }
}

/// CPython 3.12 `sum()` over floats (Neumaier-compensated).
pub fn py_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let (mut sum, mut c) = (0_f64, 0_f64);
    for x in values {
        let t = sum + x;
        c += if sum.abs() >= x.abs() {
            (sum - t) + x
        } else {
            (x - t) + sum
        };
        sum = t;
    }
    if c != 0. && c.is_finite() {
        sum + c
    } else {
        sum
    }
}

fn f(v: &Value) -> Option<f64> {
    pyjson::as_f64(v)
}

/// Pure MQ-4 per-run score from fitted/true identifiable ratios.
pub fn run_score(
    status: &str,
    expected_status: &str,
    diagnosis_correct: bool,
    ratios: &[(String, f64)],
    cost_usd: Option<f64>,
) -> Value {
    let errors: Vec<(String, f64)> = ratios
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                if *v > 0. && v.is_finite() {
                    v.ln().abs()
                } else {
                    f64::INFINITY
                },
            )
        })
        .collect();
    let mean = if errors.is_empty() {
        f64::INFINITY
    } else {
        py_sum(errors.iter().map(|e| e.1)) / errors.len() as f64
    };
    json!({
        "correct": status == expected_status && diagnosis_correct,
        "status_correct": status == expected_status,
        "diagnosis_correct": diagnosis_correct,
        "log_errors": errors.iter().map(|(k, v)| (k.clone(), pyjson::float(*v))).collect::<Map<_, _>>(),
        "mean_log_error": pyjson::float(mean),
        "cost_usd": cost_usd.map(pyjson::float),
    })
}

fn component(run: &Value) -> &Value {
    run.get("score").unwrap_or(run)
}

/// Pure aggregation; unknown costs cannot win a cost tie.
pub fn score(runs: &[Value]) -> Value {
    let components: Vec<&Value> = runs.iter().map(component).collect();
    let correct: i64 = components
        .iter()
        .map(|c| i64::from(c["correct"] == true))
        .sum();
    let mean = if components.is_empty() {
        f64::INFINITY
    } else {
        py_sum(
            components
                .iter()
                .map(|c| f(&c["mean_log_error"]).unwrap_or(f64::INFINITY)),
        ) / components.len() as f64
    };
    let cost = if components.iter().any(|c| f(&c["cost_usd"]).is_none()) {
        Value::Null
    } else {
        pyjson::float(py_sum(
            components.iter().map(|c| f(&c["cost_usd"]).unwrap()),
        ))
    };
    json!({"correct": correct, "mean_log_error": pyjson::float(mean), "cost_usd": cost})
}

/// Lexicographic: more correct runs, then lower mean log error (null is
/// infinite), then a known lower cost.
pub fn improves(candidate: &Value, baseline: &Value) -> bool {
    let error = |s: &Value| f(&s["mean_log_error"]).unwrap_or(f64::INFINITY);
    let correct = |s: &Value| s["correct"].as_i64().unwrap_or(0);
    if correct(candidate) != correct(baseline) {
        return correct(candidate) > correct(baseline);
    }
    if error(candidate) != error(baseline) {
        return error(candidate) < error(baseline);
    }
    match (f(&candidate["cost_usd"]), f(&baseline["cost_usd"])) {
        (Some(a), Some(b)) => a < b,
        _ => false,
    }
}

pub const LOG_ERROR_CAP: f64 = 50.;

/// Per (case, seed) unit: mean correctness and capped mean log error.
fn unit_means(runs: &[Value]) -> std::collections::BTreeMap<(String, i64), (f64, f64)> {
    let mut units: autophys::indexmap::IndexMap<(String, i64), Vec<(f64, f64)>> =
        autophys::indexmap::IndexMap::new();
    for run in runs {
        let (row, c) = (&run["row"], &run["score"]);
        let error = match f(&c["mean_log_error"]) {
            Some(e) if e.is_finite() => e.min(LOG_ERROR_CAP),
            _ => LOG_ERROR_CAP,
        };
        let correct = if c["correct"] == true { 1. } else { 0. };
        units
            .entry((
                row["case"].as_str().unwrap_or("").to_string(),
                row["seed"].as_i64().unwrap_or(0),
            ))
            .or_default()
            .push((correct, error));
    }
    units
        .into_iter()
        .map(|(k, v)| {
            let n = v.len() as f64;
            (
                k,
                (
                    py_sum(v.iter().map(|x| x.0)) / n,
                    py_sum(v.iter().map(|x| x.1)) / n,
                ),
            )
        })
        .collect()
}

/// AR-3: accept only a gain unlikely to be noise. Candidate and incumbent
/// are paired on (case, seed) units; the metric is per-unit correctness,
/// else mean log error when no unit's correctness changed. Units are
/// resampled with Python's `random.Random(seed)`. Returns (accepted, stats).
pub fn paired_bootstrap(
    candidate: &[Value],
    incumbent: &[Value],
    alpha: f64,
    resamples: usize,
    seed: u64,
) -> (bool, Value) {
    let (c, i) = (unit_means(candidate), unit_means(incumbent));
    let mut stats = json!({"rule": "paired-bootstrap", "alpha": alpha, "resamples": resamples, "units": c.len()});
    let refuse = |mut stats: Value, reason: &str| {
        stats["metric"] = Value::Null;
        stats["p_better"] = Value::Null;
        stats["reason"] = json!(reason);
        (false, stats)
    };
    if c.is_empty() || c.keys().ne(i.keys()) {
        return refuse(
            stats,
            "candidate and incumbent were not scored on the same units",
        );
    }
    let correct: Vec<f64> = c.iter().map(|(k, v)| v.0 - i[k].0).collect();
    let error: Vec<f64> = c.iter().map(|(k, v)| i[k].1 - v.1).collect();
    stats["improved"] = json!(correct.iter().filter(|d| **d > 0.).count());
    stats["worse"] = json!(correct.iter().filter(|d| **d < 0.).count());
    let (metric, diffs) = if correct.iter().any(|d| *d != 0.) {
        ("correct", correct)
    } else if error.iter().any(|d| d.abs() > 1e-12) {
        ("mean_log_error", error)
    } else {
        return refuse(stats, "no unit changed");
    };
    let mut rng = PyRandom::new(seed);
    let n = diffs.len();
    let better = (0..resamples)
        .filter(|_| py_sum((0..n).map(|_| diffs[rng.randrange(n as u32) as usize])) > 0.)
        .count();
    let p_better = better as f64 / resamples as f64;
    stats["metric"] = json!(metric);
    stats["mean_diff"] = pyjson::float(py_sum(diffs.iter().copied()) / n as f64);
    stats["p_better"] = json!(p_better);
    (p_better >= 1. - alpha, stats)
}

/// Only a strategy skill is editable; the executable contract stays in code.
pub fn validate_edit(original: &str, proposed: &str) -> Result<String, ResearchError> {
    if proposed == original {
        return Err(ResearchError::Invalid(
            "researcher left SKILL.md unchanged".into(),
        ));
    }
    let dir = super::bench::TempDir::new("autophys-validate-").map_err(ResearchError::Failed)?;
    let path = dir.0.join("SKILL.md");
    std::fs::write(&path, proposed).map_err(|e| ResearchError::Failed(e.to_string()))?;
    autophys::playbook::load_playbook(&path).map_err(|e| ResearchError::Invalid(e.to_string()))?;
    autophys::agent::heuristic::strategy_settings(&format!("\nStrategy:\n{proposed}"))
        .map_err(|e| ResearchError::Invalid(e.to_string()))?;
    if proposed.contains(autophys::agent::contract().trim()) {
        return Err(ResearchError::Invalid(
            "fixed contract must not be included or edited in SKILL.md".into(),
        ));
    }
    Ok(proposed.to_string())
}

/// Training score feedback without evaluator truth or final-test
/// diagnostics: what a researcher sees. Full reports stay in evaluator
/// sidecars. A structural boundary for cooperative researchers, not a
/// sandbox against code reading the run directory.
pub fn proposer_report(report: &Value) -> Value {
    const ORACLE: [&str; 7] = [
        "truth",
        "quantities",
        "rel_errors",
        "max_rel_error",
        "test_rmse",
        "diagnosis_correct",
        "log_errors",
    ];
    match report {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| !ORACLE.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), proposer_report(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(
            a.iter()
                .filter(|v| !(v.is_object() && v["kind"] == "reveal"))
                .map(proposer_report)
                .collect(),
        ),
        v => v.clone(),
    }
}

/// `value` without volatile record identities and timing (cassette keys
/// must not depend on them); non-finite floats become null.
fn stable(value: &Value) -> Value {
    const VOLATILE: [&str; 11] = [
        "investigation",
        "project_id",
        "id",
        "ts",
        "hash",
        "prev_hash",
        "wall_s",
        "elapsed_ms",
        "latency_ms",
        "reasoner",
        "plot_artifacts",
    ];
    match value {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| !VOLATILE.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), stable(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(stable).collect()),
        v if pyjson::is_nonfinite(v) => Value::Null,
        v => v.clone(),
    }
}

/// The researcher prompt (byte-identical to the Python reference).
pub fn proposal_prompt(playbook: &str, report: &Value, history: Option<&Value>) -> String {
    let mut text = String::from(
        "Edit only SKILL.md's strategy and valid scalar name/description/version frontmatter. \
         The JSON/action/identified-claim contract is fixed in Python and cannot be edited. \
         Return the complete SKILL.md, without Markdown fences. Improve training results.\n\n",
    );
    text.push_str(playbook);
    text.push_str("\n\nTraining report and failing transcripts:\n");
    text.push_str(&pyjson::dumps_sorted(&stable(&proposer_report(report))));
    // Only autoloop passes history; without it the prompt (and keys) are unchanged.
    if let Some(h) = history.filter(|h| h.as_array().is_some_and(|a| !a.is_empty())) {
        text.push_str(
            "\n\nPrevious proposals and their training scores; do not repeat a rejected edit:\n",
        );
        text.push_str(&pyjson::dumps_sorted(&stable(h)));
    }
    text
}

/// A researcher on a reasoner (API route, or its replay cassette).
pub struct ApiResearcher {
    pub spec: ModelSpec,
    reasoner: Box<dyn Reasoner>,
    usage: Value,
}
impl ApiResearcher {
    pub fn new(
        spec: ModelSpec,
        replay: Option<String>,
        record: Option<String>,
    ) -> Result<Self, String> {
        if replay.is_none() && super::env_replay().is_none() && !super::live_allowed() {
            return Err(
                "research requires --replay; live calls require AUTOPHYS_ALLOW_LIVE_REASON=1"
                    .into(),
            );
        }
        let reasoner = reasoner_for(
            spec.clone(),
            ReasonerConfig {
                replay: replay.map(PathBuf::from),
                record: record.map(PathBuf::from),
                ..Default::default()
            },
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            spec,
            reasoner,
            usage: Value::Null,
        })
    }
}
impl Researcher for ApiResearcher {
    fn propose(
        &mut self,
        playbook: &str,
        report: &Value,
        history: Option<&Value>,
    ) -> Result<Option<Proposal>, ResearchError> {
        let reply = self.reasoner.complete(
            &[json!({"role": "user", "content": proposal_prompt(playbook, report, history)})],
            &ReasonOptions {
                effort: self.spec.effort.clone(),
                max_tokens: self.spec.max_tokens,
                ..Default::default()
            },
        )?;
        self.usage = autophys::usage::normalize_usage(&reply);
        let text = reply
            .content
            .as_str()
            .ok_or_else(|| ResearchError::Invalid("researcher returned no SKILL.md text".into()))?;
        Ok(Some(Proposal::Text(validate_edit(playbook, text)?)))
    }
    fn last_usage(&self) -> Value {
        self.usage.clone()
    }
}

/// An offline researcher proposing the given SKILL.md texts in order.
pub struct ScriptedResearcher {
    pub edits: VecDeque<String>,
}
impl Researcher for ScriptedResearcher {
    fn propose(
        &mut self,
        _: &str,
        _: &Value,
        _: Option<&Value>,
    ) -> Result<Option<Proposal>, ResearchError> {
        Ok(self.edits.pop_front().map(Proposal::Text))
    }
}

/// The Muse Code CLI as researcher: it edits SKILL.md in a scratch
/// workspace. Replay is local (Muse has no replay flag): a cassette line
/// `{key, playbook, events}`, or a whole SKILL.md file.
pub struct MuseCliResearcher {
    pub binary: String,
    pub spec: ModelSpec,
    pub key_env: String,
    pub timeout: Duration,
    pub max_model_steps: Option<i64>,
    pub replay: Option<String>,
    pub record: Option<String>,
    events: Value,
}
impl MuseCliResearcher {
    pub fn new(
        binary: &str,
        spec: ModelSpec,
        timeout: f64,
        max_model_steps: Option<i64>,
        replay: Option<String>,
        record: Option<String>,
    ) -> Self {
        Self {
            binary: binary.into(),
            spec,
            key_env: "MODEL_API_KEY".into(),
            timeout: Duration::from_secs_f64(timeout.max(0.)),
            max_model_steps,
            replay,
            record,
            events: Value::Null,
        }
    }
}
impl Researcher for MuseCliResearcher {
    fn propose(
        &mut self,
        playbook: &str,
        report: &Value,
        history: Option<&Value>,
    ) -> Result<Option<Proposal>, ResearchError> {
        let failed = |m: &str| ResearchError::Failed(m.to_string());
        let mut prompt = proposal_prompt(playbook, report, history);
        let identity = json!({"model": self.spec.model, "effort": self.spec.effort,
            "max_model_steps": self.max_model_steps, "prompt": prompt});
        let key = autophys::sha256_hex([canonical(&identity).as_bytes()]);
        // Outside the replay identity, so recorded cassettes keep their keys.
        prompt.push_str("\n\nYour workspace holds SKILL.md and failing-transcripts.json. Write the edited SKILL.md to that file in place: the file, not your reply, is what gets scored.");
        if let Some(replay) = &self.replay {
            let recorded = std::fs::read_to_string(replay)
                .map_err(|e| ResearchError::Failed(format!("{replay}: {e}")))?;
            if recorded.starts_with("---") {
                return Ok(Some(Proposal::Text(validate_edit(playbook, &recorded)?)));
            }
            for line in recorded.lines() {
                let item: Value =
                    pyjson::loads(line).map_err(|e| ResearchError::Failed(e.to_string()))?;
                if item["key"] == key.as_str() {
                    self.events = item.get("events").cloned().unwrap_or(Value::Null);
                    let text = item["playbook"].as_str().unwrap_or("");
                    return Ok(Some(Proposal::Text(validate_edit(playbook, text)?)));
                }
            }
            return Err(ResearchError::Failed(format!(
                "Muse researcher replay miss: {key}"
            )));
        }
        if !super::live_allowed() {
            return Err(failed(
                "research requires --replay; live calls require AUTOPHYS_ALLOW_LIVE_REASON=1",
            ));
        }
        let dir = super::bench::TempDir::new("autophys-muse-").map_err(ResearchError::Failed)?;
        let root = dir.0.clone();
        let skill = root.join("SKILL.md");
        let write = |p: &Path, t: &str| {
            std::fs::write(p, t).map_err(|e| ResearchError::Failed(e.to_string()))
        };
        write(&skill, playbook)?;
        write(
            &root.join("failing-transcripts.json"),
            &pyjson::dumps(report),
        )?;
        let prompt_path = root.join("prompt.txt");
        write(&prompt_path, &prompt)?;
        let mut argv: Vec<String> = vec![
            self.binary.clone(),
            "exec".into(),
            "--json".into(),
            "--provider".into(),
            "meta".into(),
            "--model".into(),
            self.spec.model.clone(),
            "--workspace".into(),
            root.to_string_lossy().into(),
            "--prompt-file".into(),
            prompt_path.to_string_lossy().into(),
            "--no-session-log".into(),
            "--disable-web-tools".into(),
            "--disable-request-user-input".into(),
            "--no-foreign-personal-context".into(),
            "--disable-reminders".into(),
            "--approval-mode".into(),
            "never".into(),
            "--disable-shell".into(),
        ];
        if let Some(e) = &self.spec.effort {
            argv.extend(["--reasoning-effort".into(), e.clone()]);
        }
        if let Some(n) = self.max_model_steps {
            argv.extend(["--max-model-steps".into(), n.to_string()]);
        }
        let api_key = std::env::var(&self.key_env).ok().filter(|k| !k.is_empty());
        if api_key.is_some() {
            argv.push("--api-key-stdin".into());
        }
        let (status, stdout) = autophys::reasoner::muse::run_with_timeout(
            &argv,
            api_key.as_deref().unwrap_or(""),
            self.timeout,
            &self.key_env,
            "Muse researcher",
        )?;
        if status != 0 {
            return Err(ResearchError::Failed(format!(
                "Muse researcher exited with status {status}"
            )));
        }
        let events = autophys::reasoner::muse::parse_muse_events(&stdout);
        self.events = events.to_value();
        if events.terminal.as_deref() != Some("completed") {
            return Err(ResearchError::Failed(format!(
                "Muse researcher run ended {}",
                events.terminal_for_error()
            )));
        }
        let mut written =
            std::fs::read_to_string(&skill).map_err(|e| ResearchError::Failed(e.to_string()))?;
        let reply = events.message.clone().unwrap_or_default();
        let reply = reply.trim();
        if written == playbook && reply.starts_with("---") {
            // The model answered with the full SKILL.md instead of editing the file.
            written = format!("{reply}\n");
        }
        let proposed = validate_edit(playbook, &written)?;
        if let Some(record) = &self.record {
            use std::io::Write;
            let line =
                pyjson::dumps(&json!({"key": key, "playbook": proposed, "events": self.events}))
                    + "\n";
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(record)
                .and_then(|mut f| f.write_all(line.as_bytes()))
                .map_err(|e| ResearchError::Failed(e.to_string()))?;
        }
        Ok(Some(Proposal::Text(proposed)))
    }
    fn last_events(&self) -> Value {
        self.events.clone()
    }
}

/// The Python record dict (`dataclasses.asdict(record)`).
pub fn record_dict(r: &autophys::Record) -> Value {
    json!({"id": r.id, "investigation": r.investigation, "seq": r.seq, "kind": r.kind, "ts": r.ts,
        "payload": r.payload, "prev_hash": r.prev_hash, "hash": r.hash})
}

/// Score `playbook` with `policy` on every case × seed; workbooks and
/// `scores.json` go to `directory`, which must not exist.
pub fn evaluate(
    playbook: &Path,
    cases: &[String],
    seeds: &[i64],
    policy: &str,
    directory: &Path,
    jobs: usize,
    options: &PolicyOptions,
) -> Result<Value, String> {
    if directory.exists() {
        return Err(format!("[Errno 17] File exists: '{}'", directory.display()));
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut units = vec![];
    for case in cases {
        for seed in seeds {
            units.push(Unit {
                case: case.clone(),
                policy: policy.into(),
                seed: *seed as u64,
                options: PolicyOptions {
                    playbook: Some(playbook.to_string_lossy().into()),
                    ..options.clone()
                },
                workbook: Some(directory.join(format!("{case}-{seed}.ap-workbook"))),
            });
        }
    }
    let rows = run_units(&units, jobs)?;
    let (mut runs, mut failures) = (vec![], vec![]);
    for row in rows {
        let name = format!("{}-{}.ap-workbook", row.case, row.seed);
        let path = directory.join(&name);
        let client = autophys::connect(Some(&path.to_string_lossy())).map_err(|e| e.to_string())?;
        let wb = client
            .workbooks()
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .ok_or("empty workbook")?;
        let info = wb
            .investigations()
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .ok_or("no investigation")?;
        let records = wb
            .investigation(&info.id)
            .and_then(|i| i.records(None))
            .map_err(|e| e.to_string())?;
        let (_, evaluator) = synthetic::case(&row.case, row.seed).map_err(|e| e.to_string())?;
        let outcome = records
            .iter()
            .rev()
            .find(|r| r.kind == "outcome")
            .map(|r| r.payload.clone())
            .unwrap_or(Value::Null);
        let estimate: autophys::simulator::Params = outcome["estimate"]
            .as_object()
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_f64().map(|v| (k.clone(), v)))
                    .collect()
            })
            .unwrap_or_default();
        let ratios: Vec<(String, f64)> = if estimate.is_empty() {
            vec![]
        } else {
            evaluator
                .combos
                .keys()
                .map(|n| {
                    (
                        n.clone(),
                        evaluator.combo_value(&estimate, n)
                            / evaluator.combo_value(&evaluator.truth, n),
                    )
                })
                .collect()
        };
        let expected = if evaluator.expected_non_identified.is_empty() {
            "validated"
        } else {
            "inconclusive"
        };
        let c = run_score(
            &row.status,
            expected,
            row.diagnosis_correct,
            &ratios,
            row.cost_usd,
        );
        let correct = c["correct"] == true;
        runs.push(
            json!({"investigation": info.id, "workbook": name, "row": row.to_value(), "score": c}),
        );
        if !correct {
            failures.push(json!({"investigation": info.id, "records": records.iter().map(record_dict).collect::<Vec<_>>()}));
        }
    }
    let report = json!({"score": score(&runs), "runs": runs, "failing_transcripts": failures});
    // Python key order: runs, score, failing_transcripts.
    let report = json!({"runs": report["runs"], "score": report["score"], "failing_transcripts": report["failing_transcripts"]});
    write_json(&directory.join("scores.json"), &report).map_err(|e| e.to_string())?;
    Ok(report)
}

/// The playbook text that `playbook` (a path or `default`) names.
pub fn playbook_text(playbook: &str) -> Result<String, String> {
    let book = autophys::playbook::load_playbook(playbook).map_err(|e| e.to_string())?;
    String::from_utf8(book.data().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Write `text` as `root/playbook-NNN.md` with its `.sha256` sidecar.
fn save(root: &Path, index: usize, text: &str) -> Result<PathBuf, String> {
    let path = root.join(format!("playbook-{index:03}.md"));
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    std::fs::write(
        path.with_extension("sha256"),
        format!("{}\n", super::sha(text)),
    )
    .map_err(|e| e.to_string())?;
    Ok(path)
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Python `ValueError`s for case and seed arguments.
pub fn check_cases_and_seeds(
    cases: &[String],
    train: &[i64],
    heldout: &[i64],
) -> Result<(), String> {
    if train.iter().any(|s| heldout.contains(s)) {
        return Err("train and held-out seeds must be disjoint".into());
    }
    let unique = |s: &[i64]| s.iter().collect::<std::collections::BTreeSet<_>>().len() == s.len();
    if !unique(train) || !unique(heldout) {
        return Err("seeds must be unique".into());
    }
    if train.iter().chain(heldout).any(|s| *s < 0) || cases.iter().any(|c| !known_case(c)) {
        return Err("unknown case or negative seed".into());
    }
    Ok(())
}

pub fn known_case(c: &str) -> bool {
    synthetic::CASES.contains(&c)
        || synthetic::PLANTED_CASES.contains(&c)
        || autophys::backtest::resolve_case(c).is_ok()
}

#[allow(clippy::too_many_arguments)]
pub fn research(
    researcher: &mut dyn Researcher,
    output_dir: &Path,
    playbook: &str,
    cases: Vec<String>,
    train: Vec<i64>,
    heldout: Vec<i64>,
    iterations: i64,
    policy: &str,
    jobs: i64,
    options: &PolicyOptions,
) -> Result<Value, ResearchError> {
    let fail = ResearchError::Failed;
    let cases = if cases.is_empty() {
        synthetic::CASES.map(String::from).to_vec()
    } else {
        cases
    };
    if train.iter().any(|s| heldout.contains(s)) {
        return Err(fail("train and held-out seeds must be disjoint".into()));
    }
    if iterations < 0 || train.is_empty() || heldout.is_empty() || jobs < 1 {
        return Err(fail("invalid iterations, seeds or jobs".into()));
    }
    check_cases_and_seeds(&cases, &train, &heldout).map_err(fail)?;
    if policy == "reason"
        && options.replay.is_none()
        && super::env_replay().is_none()
        && !super::live_allowed()
    {
        return Err(fail(
            "research requires --replay; live calls require AUTOPHYS_ALLOW_LIVE_REASON=1".into(),
        ));
    }
    let jobs = jobs as usize;
    let mut text = playbook_text(playbook).map_err(fail)?;
    if output_dir.exists() {
        return Err(fail(format!(
            "[Errno 17] File exists: '{}'",
            output_dir.display()
        )));
    }
    std::fs::create_dir_all(output_dir).map_err(|e| fail(e.to_string()))?;
    let root = output_dir;
    let initial = save(root, 0, &text).map_err(fail)?;
    let mut current = initial.clone();
    let mut report = evaluate(
        &current,
        &cases,
        &train,
        policy,
        &root.join("train-000"),
        jobs,
        options,
    )
    .map_err(fail)?;
    let mut history: Vec<Value> = vec![];
    for index in 1..=iterations as usize {
        let proposal = match researcher.propose(&text, &proposer_report(&report), None) {
            Ok(None) => break,
            Ok(Some(Proposal::Text(t))) => validate_edit(&text, &t),
            Ok(Some(Proposal::Dict { skill, .. })) => match skill.as_str() {
                Some(t) => validate_edit(&text, t),
                None => Err(ResearchError::Invalid(
                    "researcher returned no SKILL.md text".into(),
                )),
            },
            Err(e) => Err(e),
        };
        let proposed = match proposal {
            Ok(p) => p,
            Err(ResearchError::Invalid(message)) => {
                // An unusable proposal is a rejected iteration, not the end of the run.
                history.push(json!({"iteration": index, "playbook": null, "sha256": null, "accepted": false,
                    "error": format!("_InvalidEdit: {message}"), "score": null,
                    "researcher_usage": researcher.last_usage(), "researcher_events": researcher.last_events()}));
                write_json(
                    &root.join("iterations.json"),
                    &Value::Array(history.clone()),
                )
                .map_err(|e| fail(e.to_string()))?;
                continue;
            }
            Err(e) => return Err(e),
        };
        let candidate = save(root, index, &proposed).map_err(fail)?;
        let trial = evaluate(
            &candidate,
            &cases,
            &train,
            policy,
            &root.join(format!("train-{index:03}")),
            jobs,
            options,
        )
        .map_err(fail)?;
        let accepted = improves(&trial["score"], &report["score"]);
        history.push(json!({"iteration": index, "playbook": file_name(&candidate), "sha256": super::sha(&proposed),
            "accepted": accepted, "score": trial["score"], "researcher_usage": researcher.last_usage(),
            "researcher_events": researcher.last_events()}));
        if accepted {
            current = candidate;
            text = proposed;
            report = trial;
        }
        write_json(
            &root.join("iterations.json"),
            &Value::Array(history.clone()),
        )
        .map_err(|e| fail(e.to_string()))?;
    }
    let initial_test = evaluate(
        &initial,
        &cases,
        &heldout,
        policy,
        &root.join("heldout-initial"),
        jobs,
        options,
    )
    .map_err(fail)?;
    let final_test = evaluate(
        &current,
        &cases,
        &heldout,
        policy,
        &root.join("heldout-final"),
        jobs,
        options,
    )
    .map_err(fail)?;
    let summary = json!({"initial_playbook": file_name(&initial), "final_playbook": file_name(&current),
        "train_seeds": train, "heldout_seeds": heldout, "cases": cases, "iterations": history,
        "train": report["score"], "heldout_initial": initial_test["score"], "heldout_final": final_test["score"]});
    write_json(&root.join("summary.json"), &summary).map_err(|e| fail(e.to_string()))?;
    Ok(summary)
}

/// Flags shared by `research` and `autoloop`.
pub const RESEARCH_FLAGS: [(&str, super::Kind); 24] = {
    use super::Kind::*;
    [
        ("playbook", Value),
        ("case", Many),
        ("train-seeds", Value),
        ("heldout-seeds", Value),
        ("iterations", Value),
        ("policy", Value),
        ("model", Value),
        ("route", Value),
        ("effort", Value),
        ("images", Switch),
        ("replay", Value),
        ("record", Value),
        ("researcher", Value),
        ("edit", Many),
        ("researcher-model", Value),
        ("researcher-route", Value),
        ("researcher-effort", Value),
        ("researcher-images", Switch),
        ("researcher-replay", Value),
        ("researcher-record", Value),
        ("muse-binary", Value),
        ("timeout", Value),
        ("max-model-steps", Value),
        ("output-dir", Value),
    ]
};

/// Common configuration of `research` and `autoloop`.
pub struct Common {
    pub playbook: String,
    pub cases: Vec<String>,
    pub train: Vec<i64>,
    pub heldout: Vec<i64>,
    pub policy: String,
    pub options: PolicyOptions,
    pub output_dir: PathBuf,
    pub jobs: i64,
}

pub fn common(args: &super::Args, usage: &str) -> Result<Common, Failure> {
    super::bench::refuse_images(args, "images")?;
    super::bench::refuse_images(args, "researcher-images")?;
    let route = args.choice("route", "meta", &["meta", "baseten", "lane", "muse"])?;
    let policy = args.choice("policy", "reason", &["reason", "scripted", "fake-reasoner"])?;
    let mut spec = ModelSpec::new(
        "policy",
        &route,
        &args.string("model", autophys::reasoner::MUSE_SPARK),
    )
    .map_err(|e| Failure::usage(e.to_string()))?;
    spec.effort = args.get("effort").map(String::from);
    let output_dir = args.get("output-dir").ok_or_else(|| {
        Failure::usage(format!(
            "the following arguments are required: --output-dir\n{usage}"
        ))
    })?;
    Ok(Common {
        playbook: args.string("playbook", "default"),
        cases: args.many("case"),
        train: args.seeds("train-seeds", &[0, 1, 2])?,
        heldout: args.seeds("heldout-seeds", &[3, 4])?,
        policy,
        options: PolicyOptions {
            model_spec: Some(spec),
            playbook: None,
            replay: args.get("replay").map(String::from),
            record: args.get("record").map(String::from),
        },
        output_dir: PathBuf::from(output_dir),
        jobs: args.int("jobs", 1)?,
    })
}

/// The researcher `--researcher` names.
pub fn researcher(args: &super::Args) -> Result<Box<dyn Researcher>, Failure> {
    let kind = args.choice(
        "researcher",
        "api",
        &["api", "muse", "scripted", "heuristic"],
    )?;
    match kind.as_str() {
        "heuristic" => return Ok(Box::new(super::autoloop::HeuristicResearcher)),
        "scripted" => {
            let mut edits = VecDeque::new();
            for path in args.many("edit") {
                edits.push_back(
                    std::fs::read_to_string(&path)
                        .map_err(|e| Failure::error(format!("{path}: {e}")))?,
                );
            }
            return Ok(Box::new(ScriptedResearcher { edits }));
        }
        _ => {}
    }
    let route = args.choice("researcher-route", "meta", &["meta", "baseten"])?;
    let mut spec = ModelSpec::new(
        "researcher",
        &route,
        &args.string("researcher-model", autophys::reasoner::MUSE_WONDER),
    )
    .map_err(|e| Failure::usage(e.to_string()))?;
    spec.effort = args.get("researcher-effort").map(String::from);
    let replay = args.get("researcher-replay").map(String::from);
    let record = args.get("researcher-record").map(String::from);
    if kind == "muse" {
        let timeout = args.float("timeout")?.unwrap_or(300.);
        let steps = args
            .get("max-model-steps")
            .map(|_| args.int("max-model-steps", 0))
            .transpose()?;
        return Ok(Box::new(MuseCliResearcher::new(
            &args.string("muse-binary", "muse"),
            spec,
            timeout,
            steps,
            replay,
            record,
        )));
    }
    Ok(Box::new(
        ApiResearcher::new(spec, replay, record).map_err(Failure::error)?,
    ))
}

pub const USAGE: &str = "usage: autophys research --output-dir DIR [--playbook P] [--example REF[#CASE]]... [--train-seeds 0,1,2] [--heldout-seeds 3,4] [--iterations N] [--policy reason|scripted|fake-reasoner] [--model M] [--route R] [--effort E] [--replay FILE] [--record FILE] [--researcher api|muse|scripted|heuristic] [--edit SKILL.md]... [--researcher-model M] [--researcher-route meta|baseten] [--researcher-effort E] [--researcher-replay FILE] [--researcher-record FILE] [--muse-binary B] [--timeout S] [--max-model-steps N] [--jobs N]";

/// `autophys research`.
pub fn command(words: Vec<String>, out: &mut impl std::io::Write) -> Result<(), Failure> {
    let mut spec: Vec<(&str, super::Kind)> = RESEARCH_FLAGS.to_vec();
    spec.push(("jobs", super::Kind::Value));
    let args = super::Args::parse(words, &spec, USAGE)?;
    if !args.positional.is_empty() {
        return Err(Failure::usage(format!(
            "unrecognized arguments: {}\n{USAGE}",
            args.positional.join(" ")
        )));
    }
    let c = common(&args, USAGE)?;
    let iterations = args.int("iterations", 1)?;
    let mut r = researcher(&args)?;
    let summary = research(
        r.as_mut(),
        &c.output_dir,
        &c.playbook,
        c.cases,
        c.train,
        c.heldout,
        iterations,
        &c.policy,
        c.jobs,
        &c.options,
    )
    .map_err(|e| Failure::error(e.message()))?;
    writeln!(out, "{}", pyjson::dumps_indent(&summary, 2, false))
        .map_err(|e| Failure::error(e.to_string()))
}

/// Read a sidecar report (a Python-written one may hold NaN/Infinity).
pub fn read_report(path: &Path) -> Result<Value, String> {
    read_json(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(case: &str, seed: i64, correct: bool, error: f64) -> Value {
        json!({"row": {"case": case, "seed": seed}, "score": {"correct": correct, "mean_log_error": error}})
    }

    #[test]
    fn bootstrap_matches_the_python_reference() {
        // Python: paired_bootstrap(cand, inc) with these units (test_autoloop.py).
        let inc: Vec<Value> = (0..6).map(|s| run("a", s, false, 1.)).collect();
        let lucky: Vec<Value> = (0..6).map(|s| run("a", s, s == 0, 1.)).collect();
        let (ok, stats) = paired_bootstrap(&lucky, &inc, 0.05, 2000, 0);
        assert!(!ok, "{stats}");
        // Python reference values (random.Random resampling, CPython sum).
        assert_eq!(stats["p_better"], 0.671);
        assert_eq!(stats["mean_diff"], 0.16666666666666666);
        let mixed: Vec<Value> = (0..6)
            .map(|s| {
                run(
                    "a",
                    s,
                    false,
                    1.0 - 0.1 * (s % 3) as f64 + 0.05 * (s % 2) as f64,
                )
            })
            .collect();
        let (ok, stats) = paired_bootstrap(&mixed, &inc, 0.05, 2000, 7);
        assert!(ok);
        assert_eq!(
            (stats["metric"].as_str(), stats["p_better"].as_f64()),
            (Some("mean_log_error"), Some(0.9765))
        );
        assert_eq!(stats["mean_diff"], 0.07499999999999996);
        let two: Vec<Value> = (0..6)
            .map(|s| run("a", s, s < 3, 1.))
            .chain((0..4).map(|s| run("b", s, s == 1, 1.)))
            .collect();
        let inc2: Vec<Value> = (0..6)
            .map(|s| run("a", s, false, 1.))
            .chain((0..4).map(|s| run("b", s, false, 0.5)))
            .collect();
        let (ok, stats) = paired_bootstrap(&two, &inc2, 0.05, 2000, 3);
        assert!(ok);
        assert_eq!(
            (stats["improved"].as_u64(), stats["p_better"].as_f64()),
            (Some(4), Some(0.9935))
        );
        let robust: Vec<Value> = (0..6).map(|s| run("a", s, true, 1.)).collect();
        let (ok, stats) = paired_bootstrap(&robust, &inc, 0.05, 2000, 0);
        assert!(ok);
        assert_eq!(stats["p_better"], 1.0);
        let (ok, stats) = paired_bootstrap(&inc, &inc, 0.05, 2000, 0);
        assert!(!ok);
        assert_eq!(stats["reason"], "no unit changed");
    }

    #[test]
    fn proposer_report_redacts_oracle_fields_and_reveals() {
        // Python: tests/test_proposer_boundary.py.
        let report = json!({"score": {"correct": 0, "mean_log_error": 1., "cost_usd": null},
            "runs": [{"row": {"status": "inconclusive", "test_rmse": 99., "rel_errors": {"R": 2.}},
                      "score": {"log_errors": {"R": 1.}, "correct": false}}],
            "failing_transcripts": [{"records": [
                {"kind": "outcome", "payload": {"estimate": {"R": 1.}}},
                {"kind": "reveal", "payload": {"truth": {"R": 2.}, "quantities": ["secret"]}}]}]});
        let original = report.clone();
        let safe = proposer_report(&report);
        assert_eq!(report, original);
        let text = safe.to_string();
        for field in [
            "\"truth\"",
            "\"quantities\"",
            "\"reveal\"",
            "\"test_rmse\"",
            "\"rel_errors\"",
            "\"log_errors\"",
        ] {
            assert!(!text.contains(field), "{field}");
        }
        assert_eq!(safe["score"], report["score"]);
        assert_eq!(
            safe["failing_transcripts"][0]["records"],
            json!([report["failing_transcripts"][0]["records"][0]])
        );
        assert!(!proposal_prompt("skill", &report, None).contains("\"truth\""));
    }

    #[test]
    fn improves_treats_null_error_as_infinite() {
        assert!(improves(
            &json!({"correct": 1, "mean_log_error": 3.0, "cost_usd": null}),
            &json!({"correct": 1, "mean_log_error": null, "cost_usd": null})
        ));
        assert!(!improves(
            &json!({"correct": 1, "mean_log_error": 1.0, "cost_usd": null}),
            &json!({"correct": 1, "mean_log_error": 1.0, "cost_usd": 0.0})
        ));
    }
}
