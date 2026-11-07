//! `autophys bench`: policies × synthetic cases × seeds. Each run reports
//! the evaluator's view, which the policy never saw: relative error of each
//! identifiable combination, RMSE on held-out test experiments, simulator
//! calls, wall-clock, experiments used, and whether the final diagnosis
//! (the non-identified physical parameters) matches the case's
//! expectation. Python reference: the former `autophys.bench`.
use super::{Args, Failure, Kind};
use autophys::indexmap::IndexMap;
use autophys::{
    agent::{Policy, ReasonLanePolicy, ScriptedPolicy, heuristic},
    playbook::load_playbook,
    pyjson,
    reasoner::{ModelSpec, ReasonerConfig, reasoner_for},
    simulator::{Result as NumResult, Simulator},
    synthetic::{self, case_project},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const DEFAULT_POLICIES: [&str; 2] = ["scripted", "fake-reasoner"];
pub const POLICIES: [&str; 3] = ["reason", "scripted", "fake-reasoner"];

pub const USAGE: &str = "usage: autophys bench [--jobs N] [--seeds N] [--case NAME]... [--policy scripted|fake-reasoner|reason]... [--model M] [--route meta|baseten|lane|muse] [--effort E] [--playbook P] [--replay FILE] [--record FILE] [--json]";

/// What the `reason` and `fake-reasoner` policies are built from.
#[derive(Clone, Debug, Default)]
pub struct PolicyOptions {
    pub model_spec: Option<ModelSpec>,
    pub playbook: Option<String>,
    pub replay: Option<String>,
    pub record: Option<String>,
}

/// A policy under another name (Python sets `policy.name = "reason"`).
struct Named<P: Policy> {
    name: String,
    inner: P,
}
impl<P: Policy> Policy for Named<P> {
    fn playbook(&self) -> Option<&autophys::playbook::Playbook> {
        self.inner.playbook()
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn decide(&mut self, facts: &Value) -> NumResult<(Value, Value)> {
        self.inner.decide(facts)
    }
    fn meta(&self) -> Value {
        self.inner.meta()
    }
}

/// The `reason` policy: offline only with a replay cassette, unless live
/// calls are allowed explicitly.
pub fn reason_policy(o: &PolicyOptions) -> Result<Box<dyn Policy>, String> {
    if o.replay.is_none() && super::env_replay().is_none() && !super::live_allowed() {
        return Err("reason benchmark requires --replay for offline use; live calls spend money and require AUTOPHYS_ALLOW_LIVE_REASON=1".into());
    }
    let spec = o
        .model_spec
        .clone()
        .ok_or("reason benchmark requires --model")?;
    let reasoner = reasoner_for(
        spec.clone(),
        ReasonerConfig {
            replay: o.replay.as_ref().map(PathBuf::from),
            record: o.record.as_ref().map(PathBuf::from),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())?;
    let mut policy = ReasonLanePolicy::new(reasoner);
    policy.playbook =
        load_playbook(o.playbook.as_deref().unwrap_or("default")).map_err(|e| e.to_string())?;
    let policy = policy.with_model_spec(spec).map_err(|e| e.to_string())?;
    Ok(Box::new(Named {
        name: "reason".into(),
        inner: policy,
    }))
}

/// The heuristic fake reasoner behind the reason-lane policy, with the
/// playbook's settings checked first (an invalid one is an error).
pub fn fake_reasoner_policy(playbook: Option<&str>) -> Result<Box<dyn Policy>, String> {
    let mut policy = ReasonLanePolicy::new(heuristic::heuristic_reasoner());
    if let Some(p) = playbook {
        policy.playbook = load_playbook(p).map_err(|e| e.to_string())?;
    }
    heuristic::strategy_settings(&autophys::agent::system_prompt_with(&policy.playbook))
        .map_err(|e| e.to_string())?;
    Ok(Box::new(policy))
}

pub fn make_policy(policy: &str, o: &PolicyOptions) -> Result<Box<dyn Policy>, String> {
    match policy {
        "reason" => reason_policy(o),
        "scripted" => Ok(Box::new(ScriptedPolicy::default())),
        "fake-reasoner" => fake_reasoner_policy(o.playbook.as_deref()),
        other => Err(format!("unknown policy '{other}'")),
    }
}

/// One benchmark run (Python `BenchRow`; fields in its order).
#[derive(Clone, Debug)]
pub struct BenchRow {
    pub case: String,
    pub policy: String,
    pub seed: u64,
    pub status: String,
    pub max_rel_error: f64,
    pub rel_errors: IndexMap<String, f64>,
    pub test_rmse: f64,
    pub simulations: usize,
    pub wall_s: f64,
    pub experiments: usize,
    pub steps: usize,
    pub non_identified: Vec<String>,
    pub diagnosis_correct: bool,
    pub requested: Vec<String>,
    pub test_hours: f64,
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: Option<f64>,
}
impl BenchRow {
    /// `dataclasses.asdict(row)`; non-finite floats are marked (pyjson).
    pub fn to_value(&self) -> Value {
        let f = pyjson::float;
        json!({
            "case": self.case, "policy": self.policy, "seed": self.seed, "status": self.status,
            "max_rel_error": f(self.max_rel_error),
            "rel_errors": self.rel_errors.iter().map(|(k, v)| (k.clone(), f(*v))).collect::<serde_json::Map<_, _>>(),
            "test_rmse": f(self.test_rmse), "simulations": self.simulations, "wall_s": f(self.wall_s),
            "experiments": self.experiments, "steps": self.steps, "non_identified": self.non_identified,
            "diagnosis_correct": self.diagnosis_correct, "requested": self.requested,
            "test_hours": f(self.test_hours), "calls": self.calls, "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens, "cost_usd": self.cost_usd.map(f),
        })
    }
}

/// A private temporary directory removed on drop.
pub struct TempDir(pub PathBuf);
impl TempDir {
    pub fn new(prefix: &str) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("{prefix}{}", super::random_hex(8)));
        std::fs::create_dir(&path).map_err(|e| format!("cannot create {}: {e}", path.display()))?;
        Ok(Self(path))
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Run `policy` on `case` with `seed`. The investigation is written to
/// `workbook` (a `.ap-workbook` file) when given, else to a temporary
/// collection that is removed afterwards.
pub fn run_case(
    case: &str,
    policy: &str,
    seed: u64,
    o: &PolicyOptions,
    workbook: Option<&Path>,
) -> Result<BenchRow, String> {
    let (view, evaluator) = synthetic::case(case, seed).map_err(|e| e.to_string())?;
    let project = case_project(&view);
    let selected = make_policy(policy, o)?;
    let temp;
    let target = match workbook {
        Some(path) => path.to_path_buf(),
        None => {
            temp = TempDir::new("autophys-bench-")?;
            temp.0.clone()
        }
    };
    let client = autophys::connect(Some(&target.to_string_lossy())).map_err(|e| e.to_string())?;
    let wb = client
        .project_with(project.clone())
        .map_err(|e| e.to_string())?;
    let mut inv = wb
        .investigate_with(
            view.dataset.clone(),
            Box::new(view.runner),
            selected,
            None,
            seed,
            &format!("bench {case} seed {seed}"),
        )
        .map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let out = inv.run().map_err(|e| e.to_string())?;
    let wall = t0.elapsed().as_secs_f64();
    evaluator.reveal(&inv).map_err(|e| e.to_string())?;
    let est = &out.estimate;
    let rel = if est.is_empty() {
        IndexMap::new()
    } else {
        evaluator.relative_errors(est)
    };
    let physical: BTreeSet<String> = project.simulator.param_names().into_iter().collect();
    let non_ids: Vec<String> = out
        .non_identified
        .iter()
        .filter(|k| physical.contains(*k))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let requested: Vec<String> = inv
        .dataset
        .iter()
        .filter(|o| o.source == "synthetic" && o.split == "train")
        .skip(1)
        .map(|o| o.experiment.clone())
        .collect();
    let steps = inv
        .record
        .records(Some("step"))
        .map_err(|e| e.to_string())?;
    let usage = autophys::usage::usage_total(steps.iter().map(|r| &r.payload));
    let calls = usage["calls"].as_u64().unwrap_or(0);
    let test_rmse = if est.is_empty() {
        f64::NAN
    } else {
        evaluator
            .test_rmse(&project.simulator, est)
            .map_err(|e| e.to_string())?
    };
    let diagnosis_correct = evaluator.diagnosis_correct(&non_ids.iter().cloned().collect());
    Ok(BenchRow {
        case: case.into(),
        policy: policy.into(),
        seed,
        status: out.status.clone(),
        max_rel_error: if rel.is_empty() {
            f64::NAN
        } else {
            rel.values().copied().fold(f64::NEG_INFINITY, f64::max)
        },
        rel_errors: rel,
        test_rmse,
        simulations: out.simulations,
        wall_s: wall,
        experiments: out.experiments,
        steps: out.steps,
        non_identified: non_ids,
        diagnosis_correct,
        requested,
        test_hours: inv.test_hours_used(),
        calls,
        input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
        cost_usd: if calls > 0 {
            usage["cost_usd"].as_f64()
        } else {
            None
        },
    })
}

/// One unit of work: case, policy, seed, options and an optional workbook.
#[derive(Clone)]
pub struct Unit {
    pub case: String,
    pub policy: String,
    pub seed: u64,
    pub options: PolicyOptions,
    pub workbook: Option<PathBuf>,
}

/// Run units on up to `jobs` threads, results in unit order. The first
/// failure stops scheduling and is returned. Recording a cassette needs
/// one job (calls must append in order).
pub fn run_units(units: &[Unit], jobs: usize) -> Result<Vec<BenchRow>, String> {
    if jobs < 1 {
        return Err("jobs must be a positive integer".into());
    }
    let recording = units.iter().any(|u| u.options.record.is_some())
        || std::env::var("AUTOPHYS_REASON_RECORD").is_ok_and(|v| !v.is_empty());
    let jobs = if jobs > 1 && recording {
        eprintln!("autophys: recording requires jobs=1; running serially");
        1
    } else {
        jobs
    };
    let run = |u: &Unit| {
        run_case(
            &u.case,
            &u.policy,
            u.seed,
            &u.options,
            u.workbook.as_deref(),
        )
    };
    if jobs == 1 {
        return units.iter().map(run).collect();
    }
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let next = AtomicUsize::new(0);
    let stopped = AtomicBool::new(false);
    let results: Vec<std::sync::Mutex<Option<Result<BenchRow, String>>>> =
        units.iter().map(|_| std::sync::Mutex::new(None)).collect();
    std::thread::scope(|s| {
        for _ in 0..jobs.min(units.len()) {
            s.spawn(|| {
                while !stopped.load(Ordering::SeqCst) {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= units.len() {
                        break;
                    }
                    let r = run(&units[i]);
                    if r.is_err() {
                        stopped.store(true, Ordering::SeqCst);
                    }
                    *results[i].lock().unwrap() = Some(r);
                }
            });
        }
    });
    let mut rows = vec![];
    for r in results {
        match r.into_inner().unwrap() {
            Some(Ok(row)) => rows.push(row),
            Some(Err(e)) => return Err(e),
            None => {}
        }
    }
    Ok(rows)
}

pub fn run_benchmark(
    cases: &[String],
    policies: &[String],
    seeds: u64,
    jobs: usize,
    o: &PolicyOptions,
) -> Result<Vec<BenchRow>, String> {
    let mut units = vec![];
    for case in cases {
        for policy in policies {
            for seed in 0..seeds {
                units.push(Unit {
                    case: case.clone(),
                    policy: policy.clone(),
                    seed,
                    options: o.clone(),
                    workbook: None,
                });
            }
        }
    }
    run_units(&units, jobs)
}

/// `statistics.median`.
fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    let n = v.len();
    if n == 0 {
        return f64::NAN;
    }
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.
    }
}

/// Per (case, policy) summary, in first-seen order (Python `summarize`).
pub fn summarize(rows: &[BenchRow]) -> Vec<Value> {
    let mut groups: IndexMap<(String, String), Vec<&BenchRow>> = IndexMap::new();
    for r in rows {
        groups
            .entry((r.case.clone(), r.policy.clone()))
            .or_default()
            .push(r);
    }
    let mut out = vec![];
    for ((case, policy), rs) in groups {
        let statuses: BTreeSet<&str> = rs.iter().map(|r| r.status.as_str()).collect();
        let status = statuses
            .iter()
            .map(|s| format!("{s}x{}", rs.iter().filter(|r| r.status == *s).count()))
            .collect::<Vec<_>>()
            .join("/");
        let med = |f: &dyn Fn(&BenchRow) -> f64| median(rs.iter().map(|r| f(r)).collect());
        let cost = if rs.iter().any(|r| r.cost_usd.is_none()) {
            None
        } else {
            Some(rs.iter().map(|r| r.cost_usd.unwrap()).sum::<f64>())
        };
        let requested: BTreeSet<String> = rs
            .iter()
            .map(|r| {
                if r.requested.is_empty() {
                    "-".to_string()
                } else {
                    r.requested.join(",")
                }
            })
            .collect();
        out.push(json!({
            "case": case, "policy": policy, "seeds": rs.len(), "status": status,
            "median_max_rel_error": pyjson::float(med(&|r| r.max_rel_error)),
            "median_test_rmse": pyjson::float(med(&|r| r.test_rmse)),
            "median_simulations": med(&|r| r.simulations as f64),
            "median_wall_s": med(&|r| r.wall_s),
            "experiments": med(&|r| r.experiments as f64),
            "test_hours": med(&|r| r.test_hours),
            "diagnosis_correct": format!("{}/{}", rs.iter().filter(|r| r.diagnosis_correct).count(), rs.len()),
            "calls": rs.iter().map(|r| r.calls).sum::<u64>(),
            "input_tokens": rs.iter().map(|r| r.input_tokens).sum::<u64>(),
            "output_tokens": rs.iter().map(|r| r.output_tokens).sum::<u64>(),
            "cost_usd": cost,
            "requested": requested.into_iter().collect::<Vec<_>>(),
        }));
    }
    out
}

/// Python's `format(x, ".{p}g")`.
pub fn fmt_g(x: f64, p: usize) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0. { "inf" } else { "-inf" }.into();
    }
    let p = p.max(1);
    if x == 0. {
        return if x.is_sign_negative() { "-0" } else { "0" }.into();
    }
    let sci = format!("{:.*e}", p - 1, x);
    let (mantissa, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let strip = |s: &str| -> String {
        if s.contains('.') {
            s.trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            s.to_string()
        }
    };
    if exp >= -4 && exp < p as i32 {
        strip(&format!("{:.*}", (p as i32 - 1 - exp) as usize, x))
    } else {
        format!(
            "{}e{}{:02}",
            strip(mantissa),
            if exp < 0 { '-' } else { '+' },
            exp.abs()
        )
    }
}

fn fmt_f(x: f64, p: usize) -> String {
    if x.is_nan() {
        "nan".into()
    } else if x.is_infinite() {
        if x > 0. { "inf".into() } else { "-inf".into() }
    } else {
        format!("{x:.p$}")
    }
}

fn num(v: &Value) -> f64 {
    pyjson::as_f64(v).unwrap_or(f64::NAN)
}

/// The summary as a Markdown table (Python `format_table`).
pub fn format_table(summary: &[Value]) -> String {
    let head = [
        "case",
        "policy",
        "seeds",
        "status",
        "max rel err",
        "test RMSE",
        "sims",
        "wall s",
        "exps",
        "diagnosis",
        "requested",
        "calls",
        "input_tokens",
        "output_tokens",
        "cost_usd",
        "test_hours",
    ];
    let rows: Vec<Vec<String>> = summary
        .iter()
        .map(|s| {
            vec![
                s["case"].as_str().unwrap_or("").into(),
                s["policy"].as_str().unwrap_or("").into(),
                s["seeds"].to_string(),
                s["status"].as_str().unwrap_or("").into(),
                format!("{}%", fmt_f(num(&s["median_max_rel_error"]) * 100., 2)),
                fmt_g(num(&s["median_test_rmse"]), 4),
                fmt_f(num(&s["median_simulations"]), 0),
                fmt_f(num(&s["median_wall_s"]), 2),
                fmt_f(num(&s["experiments"]), 0),
                s["diagnosis_correct"].as_str().unwrap_or("").into(),
                s["requested"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" | ")
                    })
                    .unwrap_or_default(),
                s["calls"].to_string(),
                s["input_tokens"].to_string(),
                s["output_tokens"].to_string(),
                match s["cost_usd"].as_f64() {
                    None => "null".into(),
                    Some(c) => fmt_f(c, 6),
                },
                fmt_g(num(&s["test_hours"]), 6),
            ]
        })
        .collect();
    let widths: Vec<usize> = head
        .iter()
        .enumerate()
        .map(|(i, h)| {
            rows.iter()
                .map(|r| r[i].chars().count())
                .chain([h.len()])
                .max()
                .unwrap()
        })
        .collect();
    let fmt = |r: &[String]| {
        let cells: Vec<String> = r
            .iter()
            .zip(&widths)
            .map(|(c, w)| format!("{c}{}", " ".repeat(w - c.chars().count())))
            .collect();
        format!("| {} |", cells.join(" | "))
    };
    let mut lines = vec![fmt(&head.map(String::from))];
    lines.push(format!(
        "|{}|",
        widths
            .iter()
            .map(|w| "-".repeat(w + 2))
            .collect::<Vec<_>>()
            .join("|")
    ));
    lines.extend(rows.iter().map(|r| fmt(r)));
    lines.join("\n")
}

/// `json.dumps([asdict(r) for r in rows], indent=1, default=str)`.
pub fn rows_json(rows: &[BenchRow]) -> String {
    pyjson::dumps_indent(
        &Value::Array(rows.iter().map(BenchRow::to_value).collect()),
        1,
        false,
    )
}

const FLAGS: [(&str, Kind); 12] = [
    ("jobs", Kind::Value),
    ("seeds", Kind::Value),
    ("case", Kind::Many),
    ("policy", Kind::Many),
    ("model", Kind::Value),
    ("route", Kind::Value),
    ("effort", Kind::Value),
    ("images", Kind::Switch),
    ("playbook", Kind::Value),
    ("replay", Kind::Value),
    ("record", Kind::Value),
    ("json", Kind::Switch),
];

/// Refuse plot images: rendering fit/residual plots needs the Python
/// SDK's matplotlib renderer, which the Rust CLI does not have.
pub fn refuse_images(args: &Args, flag: &str) -> Result<(), Failure> {
    if args.flag(flag) {
        return Err(Failure::usage(format!(
            "--{flag} is not supported by the autophys CLI: plot images need the Python SDK's renderer"
        )));
    }
    Ok(())
}

/// `autophys bench`.
pub fn command(words: Vec<String>, out: &mut impl Write) -> Result<(), Failure> {
    let args = Args::parse(words, &FLAGS, USAGE)?;
    if !args.positional.is_empty() {
        return Err(Failure::usage(format!(
            "unrecognized arguments: {}\n{USAGE}",
            args.positional.join(" ")
        )));
    }
    refuse_images(&args, "images")?;
    let route = args.choice("route", "meta", &["meta", "baseten", "lane", "muse"])?;
    let mut policies = args.many("policy");
    for p in &policies {
        if !POLICIES.contains(&p.as_str()) {
            return Err(Failure::usage(format!(
                "unknown policy '{p}'; choose from reason, scripted, fake-reasoner"
            )));
        }
    }
    let mut options = PolicyOptions {
        playbook: args.get("playbook").map(String::from),
        ..Default::default()
    };
    if policies.iter().any(|p| p == "reason") {
        let Some(model) = args.get("model") else {
            return Err(Failure::usage("reason benchmark requires --model"));
        };
        let mut spec =
            ModelSpec::new("policy", &route, model).map_err(|e| Failure::usage(e.to_string()))?;
        spec.effort = args.get("effort").map(String::from);
        options.model_spec = Some(spec);
        options.replay = args.get("replay").map(String::from);
        options.record = args.get("record").map(String::from);
    } else {
        // Python passes playbook/replay/record only with the reason policy.
        options.playbook = None;
    }
    if policies.is_empty() {
        policies = DEFAULT_POLICIES.map(String::from).to_vec();
    }
    let mut cases = args.many("case");
    if cases.is_empty() {
        cases = synthetic::CASES.map(String::from).to_vec();
    }
    let jobs = args.int("jobs", 1)?;
    let seeds = args.int("seeds", 3)?;
    if jobs < 1 {
        return Err(Failure::error("jobs must be a positive integer"));
    }
    let rows = run_benchmark(
        &cases,
        &policies,
        seeds.max(0) as u64,
        jobs as usize,
        &options,
    )?;
    let text = if args.flag("json") {
        rows_json(&rows)
    } else {
        format_table(&summarize(&rows))
    };
    writeln!(out, "{text}").map_err(|e| Failure::error(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_number_formats() {
        // python3 -c 'print([format(x, ".4g") for x in (0.0123456, 123456.0, 1e-5, 2.0, 0.0)])'
        assert_eq!(fmt_g(0.0123456, 4), "0.01235");
        assert_eq!(fmt_g(123456., 4), "1.235e+05");
        assert_eq!(fmt_g(1e-5, 4), "1e-05");
        assert_eq!(fmt_g(2., 4), "2");
        assert_eq!(fmt_g(0., 4), "0");
        assert_eq!(fmt_g(1.1666666666666667, 6), "1.16667");
        assert_eq!(fmt_g(f64::NAN, 4), "nan");
        assert_eq!(median(vec![3., 1., 2., 10.]), 2.5);
    }
}
