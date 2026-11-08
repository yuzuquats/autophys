//! The developer commands (`bench`, `research`, `autoloop`,
//! `export-trajectories`, `mcp`), offline; `mcp` also over a Python lab
//! simulator when an interpreter with the SDK is available. Expected outcomes are the Python
//! reference's (the former `sdks/python/tests/test_{bench,research_planted,
//! autoloop,mcp}.py`), on the same planted cases, seeds and edits.
use autophys_cli::devtools::{
    autoloop::{Config, Evaluate, HeuristicResearcher, autoloop},
    bench::PolicyOptions,
    research::{Proposal, ResearchError, Researcher, score},
};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

const BIN: &str = env!("CARGO_BIN_EXE_autophys");

fn default_playbook() -> String {
    let book = autophys::playbook::load_playbook("default").unwrap();
    String::from_utf8(book.data().unwrap())
        .unwrap()
        .trim_end_matches('\n')
        .to_string()
}
fn never() -> String {
    default_playbook() + "\n\nSettings:\n- compare_variants: never\n"
}
fn fix() -> String {
    default_playbook() + "\n\nSettings:\n- compare_variants: on_misfit\n"
}
fn worse() -> String {
    fix() + "- experiments: none\n"
}
fn run(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(BIN)
        .args(args)
        .env_remove("AUTOPHYS_REASON_REPLAY")
        .env_remove("AUTOPHYS_ALLOW_LIVE_REASON")
        .output()
        .unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into(),
        String::from_utf8_lossy(&out.stderr).into(),
    )
}
fn read(p: impl AsRef<Path>) -> Value {
    autophys::pyjson::loads(&std::fs::read_to_string(p).unwrap()).unwrap()
}
fn lines(p: impl AsRef<Path>) -> Vec<Value> {
    std::fs::read_to_string(p)
        .unwrap()
        .lines()
        .map(|l| autophys::pyjson::loads(l).unwrap())
        .collect()
}

#[test]
fn bench_json_rows_and_table() {
    let (code, out, err) = run(&[
        "bench",
        "--example",
        "thermal#full",
        "--seeds",
        "1",
        "--jobs",
        "2",
        "--json",
    ]);
    assert_eq!(code, 0, "{err}");
    let rows: Value = serde_json::from_str(&out).unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    for (row, policy) in rows.iter().zip(["scripted", "fake-reasoner"]) {
        assert_eq!(row["policy"], policy);
        assert_eq!(row["status"], "validated");
        assert_eq!(row["diagnosis_correct"], true);
        let keys: Vec<&String> = row.as_object().unwrap().keys().collect();
        assert_eq!(keys.first().map(|k| k.as_str()), Some("case"));
        assert_eq!(keys.last().map(|k| k.as_str()), Some("example"));
        assert_eq!(row["case"], "thermal");
        assert_eq!(row["example"], "builtin:thermal#full");
    }
    // The fake reasoner's decisions are the scripted baseline's.
    assert_eq!(rows[0]["requested"], rows[1]["requested"]);
    assert_eq!(rows[0]["steps"], rows[1]["steps"]);
    let (code, table, _) = run(&[
        "bench",
        "--case",
        "thermal-short-only",
        "--seeds",
        "1",
        "--policy",
        "scripted",
    ]);
    assert_eq!(code, 0);
    assert!(table.starts_with("| case "), "{table}");
    // --case still works (deprecated) and an unknown --example is a usage error.
    assert!(
        table.contains("| thermal-short-only | scripted | fixed | 1     | inconclusivex1 |"),
        "{table}"
    );
    let (code, _, err) = run(&["bench", "--example", "nope"]);
    assert_eq!(code, 2);
    assert!(err.contains("no built-in backtest"), "{err}");
    // The reason policy never calls a model without a cassette.
    let (code, _, err) = run(&[
        "bench", "--case", "thermal", "--seeds", "1", "--policy", "reason", "--model", "m",
    ]);
    assert_eq!(code, 2);
    assert!(err.contains("requires --replay"), "{err}");
    let (code, _, err) = run(&["bench", "--images"]);
    assert_eq!(code, 2);
    assert!(err.contains("not supported"), "{err}");
}

#[test]
fn research_keeps_the_planted_fix_and_rejects_a_regression_then_exports() {
    let temp = tempfile::tempdir().unwrap();
    let t = temp.path();
    for (name, text) in [("start", never()), ("fix", fix()), ("worse", worse())] {
        std::fs::write(t.join(format!("{name}.md")), text).unwrap();
    }
    let p = |n: &str| t.join(n).to_string_lossy().into_owned();
    let out_dir = p("run");
    let (code, out, err) = run(&[
        "research",
        "--policy",
        "fake-reasoner",
        "--researcher",
        "scripted",
        "--playbook",
        &p("start.md"),
        "--edit",
        &p("fix.md"),
        "--edit",
        &p("worse.md"),
        "--case",
        "battery-biased",
        "--case",
        "battery",
        "--train-seeds",
        "0,1",
        "--heldout-seeds",
        "2,3",
        "--iterations",
        "2",
        "--output-dir",
        &out_dir,
    ]);
    assert_eq!(code, 0, "{err}");
    let printed: Value = serde_json::from_str(&out).unwrap();
    let summary = read(t.join("run/summary.json"));
    assert_eq!(printed["final_playbook"], summary["final_playbook"]);
    let accepted: Vec<&Value> = summary["iterations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| &i["accepted"])
        .collect();
    assert_eq!(accepted, [&json!(true), &json!(false)]);
    assert_eq!(summary["final_playbook"], "playbook-001.md");
    assert_eq!(summary["train"]["correct"], 4);
    assert_eq!(
        (
            summary["heldout_initial"]["correct"].as_i64(),
            summary["heldout_final"]["correct"].as_i64()
        ),
        (Some(2), Some(4))
    );
    assert!(
        summary["iterations"][1]["score"]["correct"]
            .as_i64()
            .unwrap()
            < 4
    );
    assert_eq!(
        std::fs::read_to_string(t.join("run/playbook-001.sha256")).unwrap(),
        format!("{}\n", summary["iterations"][0]["sha256"].as_str().unwrap())
    );
    // A second run into the same directory is refused.
    let (code, _, _) = run(&[
        "research",
        "--policy",
        "scripted",
        "--researcher",
        "scripted",
        "--output-dir",
        &out_dir,
    ]);
    assert_eq!(code, 2);
    // export-trajectories: one line per fake-reasoner decision, scored, sorted keys.
    let (code, out, err) = run(&["export-trajectories", &out_dir]);
    assert_eq!(code, 0, "{err}");
    let items: Vec<Value> = out
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(!items.is_empty());
    for (item, line) in items.iter().zip(out.lines()) {
        assert!(line.starts_with("{\"decision\": "), "{line}");
        assert!(item["score"].is_object());
        assert_eq!(item["valid"], true);
        assert!(item["raw_response"].is_string());
        assert_eq!(item["messages"], Value::Null);
    }
    let target = p("decisions.jsonl");
    let (code, _, _) = run(&["export-trajectories", &out_dir, "--output", &target]);
    assert_eq!(code, 0);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), out);
    // Exclusive creation protects a previous export.
    let (code, _, _) = run(&["export-trajectories", &out_dir, "--output", &target]);
    assert_eq!(code, 2);
    let (code, _, err) = run(&["export-trajectories", &p("missing")]);
    assert_eq!(code, 2);
    assert!(err.contains("does not exist"));
}

#[test]
fn autoloop_finds_the_planted_fix_by_itself_and_resumes() {
    let temp = tempfile::tempdir().unwrap();
    let t = temp.path();
    let start = t.join("start.md");
    std::fs::write(
        &start,
        default_playbook() + "\n\nSettings:\n- compare_variants: never\n- experiments: none\n",
    )
    .unwrap();
    let dir = t.join("cli").to_string_lossy().into_owned();
    let base = [
        "autoloop",
        "--researcher",
        "heuristic",
        "--policy",
        "fake-reasoner",
        "--case",
        "battery-biased",
        "--train-seeds",
        "0",
        "--heldout-seeds",
        "2",
        "--output-dir",
        &dir,
    ];
    let mut first = base.to_vec();
    first.extend([
        "--playbook",
        start.to_str().unwrap(),
        "--max-iterations",
        "1",
    ]);
    let (code, _, err) = run(&first);
    assert_eq!(code, 0, "{err}");
    let summary = read(t.join("cli/summary.json"));
    assert_eq!(summary["stop_reason"], "max iterations");
    assert_eq!(summary["iterations"], 1);
    let mut second = base.to_vec();
    second.extend(["--resume", "--max-iterations", "5"]);
    let (code, _, err) = run(&second);
    assert_eq!(code, 0, "{err}");
    let summary = read(t.join("cli/summary.json"));
    assert_eq!(summary["stop_reason"], "researcher has no further proposal");
    assert_eq!(
        (summary["iterations"].as_i64(), summary["accepted"].as_i64()),
        (Some(2), Some(2))
    );
    assert_eq!(
        (
            summary["train_initial"]["correct"].as_i64(),
            summary["train_final"]["correct"].as_i64()
        ),
        (Some(0), Some(1))
    );
    assert_eq!(summary["heldout_final"]["correct"], 1);
    let journal = lines(t.join("cli/journal.jsonl"));
    assert_eq!(journal.len(), 2);
    assert!(
        journal[0]["hypothesis"]
            .as_str()
            .unwrap()
            .contains("sensor-bias variant")
    );
    assert!(
        journal[0]["diff"]
            .as_str()
            .unwrap()
            .contains("+- compare_variants: on_misfit")
    );
    assert!(
        journal[1]["diff"]
            .as_str()
            .unwrap()
            .contains("+- experiments: as_needed")
    );
    let state = read(t.join("cli/state.json"));
    assert_eq!(state["incumbent"], "002.md");
    assert_eq!(state["stopped"]["reason"], summary["stop_reason"]);
    assert_eq!(state["config"]["model_spec"]["images"], false);
    // Nothing to resume elsewhere.
    let (code, _, err) = run(&[
        "autoloop",
        "--researcher",
        "heuristic",
        "--resume",
        "--output-dir",
        t.join("none").to_str().unwrap(),
    ]);
    assert_eq!(code, 2);
    assert!(err.contains("nothing to resume"), "{err}");
}

/// Scores a playbook by its number of `Improve.` lines (Python `FakeEval`).
fn fake_eval(calls: Arc<Mutex<Vec<(Vec<i64>, String)>>>, cost: f64) -> Evaluate {
    Arc::new(
        move |path: &Path,
              _: &[String],
              seeds: &[i64],
              _: &str,
              dir: &Path,
              _: usize,
              _: &PolicyOptions| {
            let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            calls.lock().unwrap().push((
                seeds.to_vec(),
                path.file_name().unwrap().to_string_lossy().into(),
            ));
            let n = text.matches("Improve.").count() as f64;
            std::fs::create_dir_all(dir).unwrap();
            let c = json!({"correct": n as i64, "mean_log_error": 1. / (1. + n), "cost_usd": cost});
            Ok(json!({"score": score(&[c]), "runs": [], "failing_transcripts": []}))
        },
    )
}

/// Proposes from a list; records the history each call received.
struct Proposer {
    edits: Vec<String>,
    cost: f64,
    histories: Arc<Mutex<Vec<Value>>>,
}
impl Researcher for Proposer {
    fn propose(
        &mut self,
        text: &str,
        _: &Value,
        history: Option<&Value>,
    ) -> Result<Option<Proposal>, ResearchError> {
        self.histories
            .lock()
            .unwrap()
            .push(history.cloned().unwrap_or(Value::Null));
        if self.edits.is_empty() {
            return Ok(None);
        }
        let edit = self.edits.remove(0);
        Ok(Some(Proposal::Dict {
            skill: json!(format!("{text}{edit}")),
            hypothesis: json!(format!("adds {}", edit.trim())),
            prediction: json!("better"),
        }))
    }
    fn last_usage(&self) -> Value {
        json!({"cost_usd": self.cost})
    }
}

fn config(dir: &Path, start: &Path, evaluate: Evaluate) -> Config {
    Config {
        evaluate: Some(evaluate),
        output_dir: dir.into(),
        playbook: start.to_string_lossy().into(),
        cases: vec!["thermal".into()],
        train: vec![0, 1, 2],
        heldout: vec![3, 4],
        policy: "scripted".into(),
        jobs: 1,
        max_iterations: 10,
        patience: 3,
        max_usd: None,
        max_wall_s: None,
        resume: false,
        acceptance: "auto".into(),
        repeats: 1,
        alpha: 0.05,
        options: PolicyOptions::default(),
    }
}

fn setup() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let start = temp.path().join("start.md");
    std::fs::write(&start, default_playbook() + "\n").unwrap();
    (temp, start)
}

#[test]
fn patience_history_budget_stop_file_and_resume() {
    let (temp, start) = setup();
    let calls = Arc::new(Mutex::new(vec![]));
    let histories = Arc::new(Mutex::new(vec![]));
    let mut r = Proposer {
        edits: [
            "\nImprove.\n",
            "\nNoise.\n",
            "\nNoise again.\n",
            "\nImprove.\n",
        ]
        .map(String::from)
        .to_vec(),
        cost: 0.,
        histories: histories.clone(),
    };
    let mut c = config(
        &temp.path().join("run"),
        &start,
        fake_eval(calls.clone(), 0.),
    );
    c.patience = 2;
    let summary = autoloop(&mut r, c).unwrap();
    assert_eq!(summary["stop_reason"], "2 rejections in a row");
    assert_eq!(
        (summary["iterations"].as_i64(), summary["accepted"].as_i64()),
        (Some(3), Some(1))
    );
    let h = histories.lock().unwrap();
    assert_eq!(h[0], json!([]));
    assert_eq!(h[2].as_array().unwrap().len(), 2);
    assert_eq!(h[2][1]["accepted"], false);
    assert_eq!(h[2][1]["hypothesis"], "adds Noise.");
    // Held-out seeds are scored once each for the initial and final playbooks, never shown before.
    let seen: Vec<Vec<i64>> = calls.lock().unwrap().iter().map(|c| c.0.clone()).collect();
    assert_eq!(seen.iter().filter(|s| **s == vec![3, 4]).count(), 2);
    assert_eq!(seen.last().unwrap(), &vec![3, 4]);

    // Budget: researcher spend stops the loop before the next proposal.
    let (temp, start) = setup();
    let mut r = Proposer {
        edits: vec!["\nImprove.\n".into(); 5],
        cost: 0.4,
        histories: Default::default(),
    };
    let mut c = config(
        &temp.path().join("run"),
        &start,
        fake_eval(Default::default(), 0.),
    );
    c.max_usd = Some(1.0);
    let summary = autoloop(&mut r, c).unwrap();
    assert_eq!(summary["stop_reason"], "budget");
    assert_eq!(summary["iterations"], 3);
    assert_eq!(lines(temp.path().join("run/spend.jsonl")).len(), 3);

    // STOP file and max iterations, then resume without rescoring the baseline.
    let (temp, start) = setup();
    let dir = temp.path().join("run");
    let calls = Arc::new(Mutex::new(vec![]));
    let mut r = Proposer {
        edits: vec!["\nImprove.\n".into(); 6],
        cost: 0.,
        histories: Default::default(),
    };
    let mut c = config(&dir, &start, fake_eval(calls.clone(), 0.));
    c.max_iterations = 2;
    let summary = autoloop(&mut r, c).unwrap();
    assert_eq!(summary["stop_reason"], "max iterations");
    let baseline = calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.1 == "000.md" && c.0 == vec![0, 1, 2])
        .count();
    assert_eq!(baseline, 1);
    let mut c = config(&dir, &start, fake_eval(calls.clone(), 0.));
    c.resume = true;
    c.max_iterations = 4;
    let summary = autoloop(&mut r, c).unwrap();
    assert_eq!(
        (summary["iterations"].as_i64(), summary["accepted"].as_i64()),
        (Some(4), Some(4))
    );
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.1 == "000.md" && c.0 == vec![0, 1, 2])
            .count(),
        1
    );
    std::fs::write(dir.join("STOP"), "").unwrap();
    let mut c = config(&dir, &start, fake_eval(calls.clone(), 0.));
    c.resume = true;
    c.max_iterations = 9;
    assert_eq!(autoloop(&mut r, c).unwrap()["stop_reason"], "stop file");
}

/// Proposes fixed SKILL.md texts verbatim (not appended).
struct Verbatim(Vec<Value>);
impl Researcher for Verbatim {
    fn propose(
        &mut self,
        _: &str,
        _: &Value,
        _: Option<&Value>,
    ) -> Result<Option<Proposal>, ResearchError> {
        if self.0.is_empty() {
            return Ok(None);
        }
        Ok(Some(Proposal::Dict {
            skill: self.0.remove(0),
            hypothesis: Value::Null,
            prediction: Value::Null,
        }))
    }
}

#[test]
fn invalid_and_unchanged_proposals_are_journalled_not_fatal() {
    let (temp, start) = setup();
    let text = std::fs::read_to_string(&start).unwrap();
    let mut r = Verbatim(vec![
        json!(text.clone()),
        json!(null),
        json!(text.clone() + "\n- experiments: sometimes\n"),
        json!(format!("{text}\n{}", autophys::agent::contract())),
        json!(text.clone() + "\nImprove.\n"),
    ]);
    let mut c = config(
        &temp.path().join("run"),
        &start,
        fake_eval(Default::default(), 0.),
    );
    c.patience = 10;
    let summary = autoloop(&mut r, c).unwrap();
    let journal = lines(temp.path().join("run/journal.jsonl"));
    let reasons: Vec<&str> = journal
        .iter()
        .map(|e| e["reason"].as_str().unwrap())
        .collect();
    assert_eq!(
        reasons[0],
        "invalid edit: researcher left SKILL.md unchanged"
    );
    assert_eq!(
        reasons[1],
        "invalid edit: researcher returned no SKILL.md text"
    );
    assert!(
        reasons[2].starts_with("invalid edit: playbook setting experiments"),
        "{}",
        reasons[2]
    );
    assert_eq!(
        reasons[3],
        "invalid edit: fixed contract must not be included or edited in SKILL.md"
    );
    assert_eq!(reasons[4], "improves on the incumbent");
    assert_eq!(summary["accepted"], 1);
}

#[test]
fn a_journal_line_without_state_is_set_aside_and_redone() {
    let (temp, start) = setup();
    let dir = temp.path().join("run");
    let mut r = Proposer {
        edits: vec!["\nImprove.\n".into(); 3],
        cost: 0.,
        histories: Default::default(),
    };
    let mut c = config(&dir, &start, fake_eval(Default::default(), 0.));
    c.max_iterations = 1;
    autoloop(&mut r, c).unwrap();
    // Simulate a crash between the journal append and the state save.
    let mut journal = std::fs::read_to_string(dir.join("journal.jsonl")).unwrap();
    journal.push_str("{\"accepted\": true, \"iteration\": 2, \"reason\": \"orphan\"}\n");
    std::fs::write(dir.join("journal.jsonl"), journal).unwrap();
    let mut c = config(&dir, &start, fake_eval(Default::default(), 0.));
    c.resume = true;
    c.max_iterations = 2;
    autoloop(&mut r, c).unwrap();
    assert_eq!(
        lines(dir.join("journal.orphaned.jsonl"))[0]["reason"],
        "orphan"
    );
    let journal = lines(dir.join("journal.jsonl"));
    assert_eq!(journal.len(), 2);
    assert_eq!(journal[1]["reason"], "improves on the incumbent");
}

#[test]
fn the_heuristic_researcher_ends_when_nothing_is_wrong() {
    let report = json!({"failing_transcripts": []});
    assert!(
        HeuristicResearcher
            .propose(&fix(), &report, None)
            .unwrap()
            .is_none()
    );
}

fn mcp_call(
    stdin: &mut impl Write,
    out: &mut impl BufRead,
    id: u64,
    name: &str,
    args: Value,
) -> Value {
    let msg = json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": args}});
    writeln!(stdin, "{msg}").unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    let reply: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(reply["id"], id);
    reply["result"].clone()
}

fn write_csv(path: &Path, experiment: &str) {
    let sim = autophys::models::battery_ecm();
    use autophys::simulator::Simulator;
    let settings = sim.experiment(&json!(experiment)).unwrap();
    let truth = [("R0", 0.025), ("R1", 0.045), ("C1", 1600.)]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    let y = sim
        .simulate(&truth, &settings, autophys::simulator::FIT_OPTIONS)
        .unwrap();
    let mut text = String::from("time,current,voltage\n");
    for (t, v) in y["t"].iter().zip(&y["v"]) {
        let i = autophys::models::battery::current(&settings, *t).unwrap();
        text.push_str(&format!(
            "{},{},{}\n",
            autophys::canonical::py_float_repr(*t),
            autophys::canonical::py_float_repr(i),
            autophys::canonical::py_float_repr(*v)
        ));
    }
    std::fs::write(path, text).unwrap();
}

#[test]
fn mcp_protocol_cycle_with_external_approval() {
    let temp = tempfile::tempdir().unwrap();
    let lab = temp.path().join("lab");
    std::fs::create_dir(&lab).unwrap();
    write_csv(&lab.join("pulses.csv"), "pulse_2A");
    write_csv(&lab.join("discharge.csv"), "discharge_1A");
    let books = temp.path().join("books");
    let mut child = Command::new(BIN)
        .args([
            "mcp",
            "--project",
            "battery_ecm",
            "--workbook",
            books.to_str().unwrap(),
        ])
        .current_dir(&lab)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{}", json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}})).unwrap();
    writeln!(
        stdin,
        "{}",
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
    )
    .unwrap();
    writeln!(
        stdin,
        "{}",
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    )
    .unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    let init: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(init["result"]["serverInfo"]["name"], "autophys");
    line.clear();
    out.read_line(&mut line).unwrap();
    let tools: Value = serde_json::from_str(&line).unwrap();
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "describe_project",
            "import_measurements",
            "fit",
            "identifiability",
            "rank_experiments",
            "propose_experiment",
            "status",
            "attach_data",
            "report"
        ]
    );
    assert!(
        !names
            .iter()
            .any(|n| n.contains("approve") || n.contains("reject"))
    );
    let text = |r: &Value| -> Value {
        serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap()
    };
    let info = mcp_call(&mut stdin, &mut out, 2, "describe_project", json!({}));
    assert_eq!(text(&info)["parameters"]["R0"]["unit"], "ohm");
    let imported = mcp_call(
        &mut stdin,
        &mut out,
        3,
        "import_measurements",
        json!({"path": "pulses.csv", "experiment": "pulse_2A", "sigma": {"v": 0.002}}),
    );
    assert_eq!(imported["isError"], false, "{imported}");
    let inv = text(&imported)["investigation"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        mcp_call(&mut stdin, &mut out, 4, "fit", json!({"n_starts": 2}))["isError"],
        false
    );
    let ident = text(&mcp_call(
        &mut stdin,
        &mut out,
        5,
        "identifiability",
        json!({}),
    ));
    assert!(ident["parameters"]["R0"]["identified"].is_boolean());
    let proposed = text(&mcp_call(
        &mut stdin,
        &mut out,
        6,
        "propose_experiment",
        json!({"experiment": "discharge_1A", "rationale": "long trace"}),
    ));
    let pid = proposed["proposal_id"].as_str().unwrap().to_string();
    let early = mcp_call(
        &mut stdin,
        &mut out,
        7,
        "attach_data",
        json!({"proposal_id": pid, "path": "discharge.csv", "sigma": {"v": 0.002}}),
    );
    assert_eq!(early["isError"], true);
    assert!(
        early["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("browser approval is required")
    );
    // A human approves in another process (the browser's record API).
    let client = autophys::connect(Some(books.to_str().unwrap())).unwrap();
    client
        .find_investigation(&inv)
        .unwrap()
        .approve(&pid, "reviewer", None)
        .unwrap();
    assert_eq!(
        text(&mcp_call(&mut stdin, &mut out, 8, "status", json!({})))["status"],
        "approved"
    );
    let attached = mcp_call(
        &mut stdin,
        &mut out,
        9,
        "attach_data",
        json!({"proposal_id": pid, "path": "discharge.csv", "sigma": {"v": 0.002}}),
    );
    assert_eq!(attached["isError"], false, "{attached}");
    let stale = mcp_call(&mut stdin, &mut out, 10, "report", json!({}));
    assert!(
        stale["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("measurements changed")
    );
    mcp_call(&mut stdin, &mut out, 11, "fit", json!({"n_starts": 2}));
    let report = text(&mcp_call(&mut stdin, &mut out, 12, "report", json!({})));
    assert_eq!(report["experiments"], 1);
    assert!(["validated", "inconclusive"].contains(&report["status"].as_str().unwrap()));
    let unknown = mcp_call(&mut stdin, &mut out, 13, "approve", json!({}));
    assert_eq!(unknown["content"][0]["text"], "Unknown tool: approve");
    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn mcp_refuses_a_different_strategy_before_opening_a_workbook() {
    let temp = tempfile::tempdir().unwrap();
    let books = temp.path().join("books");
    let (code, out, err) = run(&[
        "mcp",
        "--workbook",
        books.to_str().unwrap(),
        "--root",
        temp.path().to_str().unwrap(),
        "--expected-playbook-sha256",
        "00",
    ]);
    assert_eq!(code, 2);
    assert!(out.is_empty());
    assert!(err.contains("playbook digest mismatch"), "{err}");
    assert!(!books.exists());
    let (code, _, err) = run(&[
        "mcp",
        "--project",
        "mypkg.module:project",
        "--root",
        temp.path().to_str().unwrap(),
    ]);
    // A Python reference is imported by a worker; this module does not exist.
    assert_eq!(code, 2);
    assert!(err.contains("mypkg.module:project"), "{err}");
    assert!(!err.contains("built-in projects"), "{err}");
}

/// The fixture lab (`tests/fixtures/python_lab`) and an interpreter that can
/// import the checkout's Python SDK (`AUTOPHYS_PYTHON`, else `python3`, with
/// `sdks/python/src` on `PYTHONPATH`), or `None` when NumPy/SciPy are missing.
/// With `CI` set, or `AUTOPHYS_REQUIRE_PYTHON=1`, a missing interpreter fails
/// the test instead of skipping it.
fn python_lab() -> Option<(String, String, PathBuf)> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
    let python = std::env::var("AUTOPHYS_PYTHON")
        .ok()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "python3".into());
    let mut path = repo.join("sdks/python/src").display().to_string();
    if let Ok(old) = std::env::var("PYTHONPATH")
        && !old.is_empty()
    {
        path = format!("{path}:{old}");
    }
    let probe = Command::new(&python)
        .args(["-c", "import autophys.worker, numpy, scipy"])
        .env("PYTHONPATH", &path)
        .output();
    match probe {
        Ok(out) if out.status.success() => {
            Some((python, path, repo.join("tests/fixtures/python_lab")))
        }
        failed => {
            let why = match failed {
                Ok(out) => String::from_utf8_lossy(&out.stderr).trim().to_string(),
                Err(e) => e.to_string(),
            };
            let message = format!(
                "{python} cannot import the autophys SDK with NumPy and SciPy ({why}); set AUTOPHYS_PYTHON to such an interpreter (e.g. a venv with sdks/python installed) to run the Python worker tests"
            );
            let required = std::env::var_os("CI").is_some_and(|v| !v.is_empty())
                || std::env::var("AUTOPHYS_REQUIRE_PYTHON").is_ok_and(|v| v == "1");
            assert!(
                !required,
                "{message} (required: CI or AUTOPHYS_REQUIRE_PYTHON=1 is set)"
            );
            eprintln!("SKIPPED: {message}");
            None
        }
    }
}

fn write_decay_csv(path: &Path, duration: f64, rate: f64) {
    let n = (duration * rate).round() as usize;
    let mut text = String::from("time,y\n");
    for i in 0..=n {
        let t = if i == n {
            duration
        } else {
            duration * i as f64 / n as f64
        };
        let y = 2.0 * (-0.8 * t).exp();
        text.push_str(&format!(
            "{},{}\n",
            autophys::canonical::py_float_repr(t),
            autophys::canonical::py_float_repr(y)
        ));
    }
    std::fs::write(path, text).unwrap();
}

#[test]
fn mcp_serves_a_python_simulator_through_the_worker() {
    serve_decay_lab("project", "decay_lab");
}

/// B1: a lab typed with integers (initial values, sigma, bounds, stop rules,
/// budgets) keeps them in Python's configuration; the server records that
/// configuration and its version rather than refusing to start.
#[test]
fn mcp_serves_a_python_lab_declared_with_integers() {
    serve_decay_lab("integers", "decay_ints");
}

/// The whole MCP cycle over `decaylab:<attribute>` (a project named `name`);
/// the records carry the configuration version the Python SDK computes.
fn serve_decay_lab(attribute: &str, name: &str) {
    let Some((python, pythonpath, fixture)) = python_lab() else {
        return;
    };
    let reference = format!("decaylab:{attribute}");
    let temp = tempfile::tempdir().unwrap();
    let lab = temp.path().join("lab");
    std::fs::create_dir(&lab).unwrap();
    std::fs::copy(fixture.join("decaylab.py"), lab.join("decaylab.py")).unwrap();
    write_decay_csv(&lab.join("short.csv"), 2.0, 20.0);
    write_decay_csv(&lab.join("long.csv"), 10.0, 5.0);
    let books = temp.path().join("books");
    // The interpreter comes from the lab configuration; the module from --root.
    std::fs::write(
        temp.path().join(".autophys-mcp.json"),
        json!({"python": python, "root": "lab"}).to_string(),
    )
    .unwrap();
    let mut child = Command::new(BIN)
        .args([
            "mcp",
            "--project",
            &reference,
            "--workbook",
            books.to_str().unwrap(),
        ])
        .current_dir(temp.path())
        .env("PYTHONPATH", &pythonpath)
        .env_remove("AUTOPHYS_PYTHON")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{}", json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}})).unwrap();
    writeln!(
        stdin,
        "{}",
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    )
    .unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    let init: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(init["result"]["serverInfo"]["name"], "autophys");
    line.clear();
    out.read_line(&mut line).unwrap();
    let tools: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 9);
    let text = |r: &Value| -> Value {
        assert_eq!(r["isError"], false, "{r}");
        serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap()
    };
    let info = text(&mcp_call(
        &mut stdin,
        &mut out,
        2,
        "describe_project",
        json!({}),
    ));
    assert_eq!(info["name"], name);
    assert_eq!(info["parameters"]["k"]["unit"], "1/s");
    assert_eq!(info["outputs"], json!(["y"]));
    let imported = text(&mcp_call(
        &mut stdin,
        &mut out,
        3,
        "import_measurements",
        json!({"path": "short.csv", "experiment": "short", "sigma": {"y": 0.01}}),
    ));
    let inv = imported["investigation"].as_str().unwrap().to_string();
    let fit = text(&mcp_call(
        &mut stdin,
        &mut out,
        4,
        "fit",
        json!({"n_starts": 2}),
    ));
    let estimate = |fit: &Value, k: &str| fit["params"][k].as_f64().unwrap_or(f64::NAN);
    assert!((estimate(&fit, "A") - 2.0).abs() < 1e-4, "{fit}");
    assert!((estimate(&fit, "k") - 0.8).abs() < 1e-4, "{fit}");
    let ident = text(&mcp_call(
        &mut stdin,
        &mut out,
        5,
        "identifiability",
        json!({}),
    ));
    assert_eq!(ident["parameters"]["A"]["identified"], true, "{ident}");
    let proposed = text(&mcp_call(
        &mut stdin,
        &mut out,
        6,
        "propose_experiment",
        json!({"experiment": "long", "rationale": "see the tail"}),
    ));
    let pid = proposed["proposal_id"].as_str().unwrap().to_string();
    let client = autophys::connect(Some(books.to_str().unwrap())).unwrap();
    client
        .find_investigation(&inv)
        .unwrap()
        .approve(&pid, "reviewer", None)
        .unwrap();
    text(&mcp_call(
        &mut stdin,
        &mut out,
        7,
        "attach_data",
        json!({"proposal_id": pid, "path": "long.csv", "sigma": {"y": 0.01}}),
    ));
    text(&mcp_call(
        &mut stdin,
        &mut out,
        8,
        "fit",
        json!({"n_starts": 2}),
    ));
    let report = text(&mcp_call(&mut stdin, &mut out, 9, "report", json!({})));
    assert_eq!(report["experiments"], 1, "{report}");
    // No validation split was imported, so the verdict stops short of validated.
    assert_eq!(report["status"], "inconclusive", "{report}");
    assert_eq!(report["identified"], json!(["A", "k"]), "{report}");
    assert!((report["estimate"]["k"].as_f64().unwrap() - 0.8).abs() < 1e-6);
    drop(stdin);
    let done = child.wait_with_output().unwrap();
    assert!(done.status.success());
    let stderr = String::from_utf8_lossy(&done.stderr);
    // User prints reach stderr, not the protocol stream.
    assert!(stderr.contains("decaylab imported"), "{stderr}");
    if attribute == "project" {
        assert!(stderr.contains("simulating"), "{stderr}");
    }
    // The records carry the Python simulator's own source hash and the
    // config version the Python SDK computes, and only that version.
    let wb = client.open_project(name).unwrap();
    let configs: String = wb
        .config_versions()
        .unwrap()
        .iter()
        .map(|c| format!("{} {}\n", c.version, c.config))
        .collect();
    let python_hash = Command::new(&python)
        .args([
            "-c",
            &format!("import decaylab; p = decaylab.{attribute}; print(p.simulator.source_hash, p.config_version)"),
        ])
        .current_dir(&lab)
        .env("PYTHONPATH", format!("{}:{pythonpath}", lab.display()))
        .output()
        .unwrap();
    let printed = String::from_utf8_lossy(&python_hash.stdout);
    let mut words = printed.lines().last().unwrap().split_whitespace();
    let (source_hash, config_version) = (words.next().unwrap(), words.next().unwrap());
    assert!(configs.contains(source_hash), "{configs}");
    assert!(configs.contains(config_version), "{configs}");
    assert_eq!(configs.lines().count(), 1, "{configs}");
    assert_eq!(info["config_version"], config_version, "{info}");
    let pinned = client.find_investigation(&inv).unwrap();
    assert_eq!(
        pinned.records(None).unwrap()[0].payload["config_version"],
        config_version
    );
}

#[test]
fn mcp_reports_a_crashed_python_simulator_with_its_stderr() {
    let Some((python, pythonpath, fixture)) = python_lab() else {
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    std::fs::copy(fixture.join("decaylab.py"), temp.path().join("decaylab.py")).unwrap();
    let mut child = Command::new(BIN)
        .args([
            "mcp",
            "--project",
            "decaylab:crashes",
            "--python",
            &python,
            "--root",
            temp.path().to_str().unwrap(),
            "--workbook",
            temp.path().join("books").to_str().unwrap(),
        ])
        .current_dir(temp.path())
        .env("PYTHONPATH", &pythonpath)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    std::fs::write(temp.path().join("e.csv"), "time,y\n0,1\n0.5,1\n1,1\n").unwrap();
    let r = mcp_call(
        &mut stdin,
        &mut out,
        1,
        "import_measurements",
        json!({"path": "e.csv", "experiment": "e", "sigma": {"y": 0.1}}),
    );
    // Opening the investigation needs no simulation; the fit does.
    assert_eq!(r["isError"], false, "{r}");
    let r = mcp_call(&mut stdin, &mut out, 2, "fit", json!({}));
    let message = r["content"][0]["text"].as_str().unwrap();
    assert_eq!(r["isError"], true, "{r}");
    assert!(
        message.contains("decaylab:crashes") && message.contains("about to fall over"),
        "{message}"
    );
    drop(stdin);
    child.wait().unwrap();
}
