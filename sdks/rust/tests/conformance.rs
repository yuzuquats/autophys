//! The shared workbook conformance suite (W-4, `tests/conformance/README.md`).
//!
//! - `tests/conformance/python/`: golden workbooks the Python SDK wrote. Each
//!   is copied to a temp dir (never opened in place), every chain verified,
//!   the projections rebuilt, and everything compared with its `<case>.json`:
//!   format pragmas, project name, record count and kinds, chain heads, and
//!   every projection row field for field (floats exactly, TEXT JSON columns
//!   as the stored strings). The three Python cases must all be present.
//! - `tests/conformance/rust/`: the same check on the workbooks this crate
//!   wrote, which the Python suite verifies too. They are regenerated only on
//!   request: `AUTOPHYS_WRITE_GOLDENS=1 cargo test --test conformance` (ids
//!   and timestamps are random, so every run would change the bytes).
//!   Without it the generator writes to a temp dir and checks itself.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use autophys::{APPLICATION_ID, Client, FORMAT_VERSION, Workbook, connect, sha256_hex};
use rusqlite::Connection;
use serde_json::{Map, Value, json};

fn conformance() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance")
}

fn goldens(side: &str) -> Vec<PathBuf> {
    let Ok(dir) = std::fs::read_dir(conformance().join(side)) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = dir
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "ap-workbook"))
        .collect();
    out.sort();
    out
}

/// Objects with their keys in sorted order, at every depth.
fn sorted(v: Value) -> Value {
    match v {
        Value::Object(m) => {
            let tree: BTreeMap<String, Value> =
                m.into_iter().map(|(k, v)| (k, sorted(v))).collect();
            Value::Object(tree.into_iter().collect::<Map<_, _>>())
        }
        Value::Array(a) => Value::Array(a.into_iter().map(sorted).collect()),
        other => other,
    }
}

/// What any implementation must read back from a workbook (the shape the
/// Python goldens' JSON has).
fn expected(path: &Path, wb: &Workbook) -> Value {
    let raw = Connection::open(path).unwrap();
    let pragma = |n: &str| -> i64 {
        raw.query_row(&format!("PRAGMA {n}"), [], |r| r.get(0))
            .unwrap()
    };
    let mut kinds: BTreeMap<String, i64> = BTreeMap::new();
    let records = wb.records_after(0, i64::MAX).unwrap();
    for l in &records {
        *kinds.entry(l.record.kind.clone()).or_default() += 1;
    }
    sorted(json!({
        "format": {"application_id": pragma("application_id"), "user_version": pragma("user_version")},
        "project": wb.name(),
        "records": records.len(),
        "kinds": kinds,
        "heads": serde_json::to_value(wb.heads().unwrap()).unwrap(),
        "projections": wb.projection_rows().unwrap(),
    }))
}

/// Copy a golden (and nothing else) into a fresh temp dir and open it.
fn open_copy(golden: &Path) -> (tempfile::TempDir, PathBuf, Client, Workbook) {
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join(golden.file_name().unwrap());
    std::fs::copy(golden, &copy).unwrap();
    let client = connect(Some(copy.to_str().unwrap())).unwrap();
    let wb = client.workbooks().unwrap().remove(0);
    (dir, copy, client, wb)
}

/// The full check against a golden's JSON.
fn read_back(golden: &Path) {
    let case = golden.file_stem().unwrap().to_string_lossy().to_string();
    let exp: Value =
        serde_json::from_str(&std::fs::read_to_string(golden.with_extension("json")).unwrap())
            .unwrap_or_else(|e| panic!("{case}.json: {e}"));
    let (_dir, copy, _client, wb) = open_copy(golden);
    assert_eq!(
        exp["format"],
        json!({"application_id": APPLICATION_ID, "user_version": FORMAT_VERSION}),
        "{case}: format"
    );
    let report = wb.verify().unwrap();
    assert!(report.ok, "{case}: {report:?}");
    assert_eq!(
        json!(report.records),
        exp["records"],
        "{case}: record count"
    );
    for entry in wb.records_after(0, i64::MAX).unwrap() {
        autophys::validate::payload_shape(
            autophys::Kind::parse(&entry.record.kind).unwrap(),
            &entry.record.payload,
        )
        .unwrap();
    }
    let got = expected(&copy, &wb);
    for key in ["format", "project", "records", "kinds", "heads"] {
        assert_eq!(got[key], exp[key], "{case}: {key}");
    }
    compare_rows(&case, "stored", &got["projections"], &exp["projections"]);
    // Rebuild the projections from the records and compare again.
    let rebuilt = wb.rebuild_projections().unwrap();
    assert!(rebuilt.ok, "{case}: {rebuilt:?}");
    let rows = sorted(wb.projection_rows().unwrap());
    compare_rows(&case, "rebuilt", &rows, &exp["projections"]);
}

fn compare_rows(case: &str, stage: &str, rows: &Value, expected: &Value) {
    for table in ["investigations", "proposals"] {
        let (a, b) = (&rows[table], &expected[table]);
        assert_eq!(
            a.as_array().map(Vec::len),
            b.as_array().map(Vec::len),
            "{case}: {stage} {table} row count"
        );
        for (i, (x, y)) in a
            .as_array()
            .unwrap()
            .iter()
            .zip(b.as_array().unwrap())
            .enumerate()
        {
            for (field, want) in y.as_object().unwrap() {
                assert_eq!(&x[field], want, "{case}: {stage} {table}[{i}].{field}");
            }
            assert_eq!(x, y, "{case}: {stage} {table}[{i}]");
        }
    }
}

#[test]
fn python_goldens_read_back_exactly() {
    let found = goldens("python");
    // Keep the original cases mandatory while checking additional committed
    // Python workbooks too (for example the fit-curves reveal case).
    for name in ["events-and-values", "oscillator-edited", "reason-replayed", "thermal-validated"] {
        assert!(found.iter().any(|p| p.file_stem().unwrap() == name),
            "missing Python workbook golden {name} in {}", conformance().join("python").display());
    }
    for golden in found {
        read_back(&golden);
    }
}

#[test]
fn rust_goldens_read_back_exactly() {
    if std::env::var_os("AUTOPHYS_WRITE_GOLDENS").is_some() {
        return;
    }
    let found = goldens("rust");
    assert!(
        !found.is_empty(),
        "missing checked-in Rust workbook goldens"
    );
    for golden in found {
        read_back(&golden);
    }
}

// --- the Rust cases -------------------------------------------------------------

fn config(wb: &Workbook, body: &Value) -> String {
    let text = autophys::canonical(body);
    let version = format!("sha256:{}", sha256_hex([text.as_bytes()]));
    wb.put_config_version(&version, text.as_bytes()).unwrap();
    version
}

/// Every proposal event, through the approval verbs where Rust has them, and
/// canonical-JSON edge values (non-ASCII text, Python float repr, a u64).
fn events_and_values(wb: &Workbook) {
    let version = config(
        wb,
        &json!({"name": "events-and-values", "params": {"a": {"lo": 0.1, "hi": 1.0}}}),
    );
    let (inv, _) = wb
        .create_investigation(
            json!({"config_version": version, "overrides": {"free": ["a"]}, "writer": "autophys-rs"}),
            Some("rust-conformance-inv-0"),
        )
        .unwrap();
    inv.append(
        "measurement",
        json!({"version": 1, "observation": {"t": [0.0, 1.0], "y": {"x": [0.5, null]}}}),
        Some("rust-m-0"),
    )
    .unwrap();
    inv.append(
        "step",
        json!({
            "text": "é😀\"\\\n\u{1}\u{7f}",
            "floats": [1.0, 0.1, 1e-05, 1.5e-07, 1e16, -0.0, 123.456, 5e-324, 1.7976931348623157e308],
            "halfway": [f64::from_bits(0xc30fa36fd398d412), f64::from_bits(0x42d9636d03665f08)],
            "ints": [0, -3, 18446744073709551615u64],
            "nested": {"b": 1, "a": [true, null]},
        }),
        Some("rust-step-0"),
    )
    .unwrap();
    let outlook = json!({
        "axes": [{"name": "freq", "values": [0.1, 1.0]}, {"name": "amp", "values": [1, 2, 3]}],
        "score": [1, 2, 3, 4, 5, 6],
        "after": {"a": [0.6, 0.5, 0.4, 0.3, 0.2, 0.1]},
    });
    let base = json!({"kind": "sine", "freq": 0.1, "amp": 1});
    for pid in ["p-rejected", "p-withdrawn", "p-approved", "p-edited"] {
        inv.append(
            "proposal",
            json!({"proposal_id": pid, "event": "proposed", "experiment": "sine",
                   "settings": base, "outlook": outlook}),
            Some(&format!("rust-{pid}-proposed")),
        )
        .unwrap();
    }
    inv.reject("p-rejected", "rust", "too long").unwrap();
    inv.append(
        "proposal",
        json!({"proposal_id": "p-withdrawn", "event": "withdrawn"}),
        Some("rust-p-withdrawn-withdrawn"),
    )
    .unwrap();
    inv.approve("p-approved", "rust", None).unwrap();
    inv.attach_data(
        "p-approved",
        json!({"t": [0.0, 0.5], "y": {"x": [1.0, 2.0]}}),
    )
    .unwrap();
    inv.approve(
        "p-edited",
        "rust",
        Some(json!({"kind": "sine", "freq": 1.0, "amp": 3})),
    )
    .unwrap();
    inv.append(
        "outcome",
        json!({"status": "inconclusive", "reasons": ["conformance"]}),
        Some("rust-outcome"),
    )
    .unwrap();
}

/// Two interleaved investigations pinned to two config versions, with
/// replayed appends (which must not add records).
fn two_investigations(wb: &Workbook) {
    let v1 = config(wb, &json!({"name": "two-investigations", "rev": 1}));
    let v2 = config(
        wb,
        &json!({"name": "two-investigations", "rev": 2, "x": 1.5}),
    );
    let (a, _) = wb
        .create_investigation(json!({"config_version": v1, "seed": 1}), None)
        .unwrap();
    let (b, _) = wb
        .create_investigation(
            json!({"config_version": v2, "overrides": {"free": ["k"], "fixed": {"m": 2.0}}}),
            None,
        )
        .unwrap();
    for n in 0..3 {
        for inv in [&a, &b] {
            let id = format!("{}-run-{n}", inv.id);
            inv.append(
                "run",
                json!({"n": n, "loss": 1.0 / (n as f64 + 3.0)}),
                Some(&id),
            )
            .unwrap();
            inv.append(
                "run",
                json!({"n": n, "loss": 1.0 / (n as f64 + 3.0)}),
                Some(&id),
            )
            .unwrap();
            inv.append("measurement", json!({"observation": {"n": n}}), None)
                .unwrap();
        }
    }
    a.append(
        "proposal",
        json!({"proposal_id": "next", "event": "proposed", "experiment": "step"}),
        None,
    )
    .unwrap();
    b.append("outcome", json!({"status": "validated"}), None)
        .unwrap();
}

/// Replays the seed-0 Python prompts against the shared fake cassette. No
/// provider or numerical fitter participates in this record-format case.
fn reason_replayed(wb: &Workbook) {
    use autophys::{
        agent::{Policy, ReasonLanePolicy, decision_schema, system_prompt},
        playbook::load_playbook,
        reasoner::{
            ModelSpec, ReasonOptions, Reasoner, ReasonerConfig, ReplayReasoner, parse_json_content,
            reasoner_for,
        },
        usage::{normalize_usage, usage_total},
    };
    let (_tmp, _path, _client, python) =
        open_copy(&conformance().join("python/reason-replayed.ap-workbook"));
    let source = python.records_after(0, i64::MAX).unwrap();
    let head = &source[0].record.payload;
    assert_eq!(
        autophys::sha256_hex([system_prompt().as_bytes()]),
        head["system_prompt_sha256"].as_str().unwrap()
    );
    let spec = ModelSpec::new("policy", "meta", autophys::reasoner::MUSE_SPARK).unwrap();
    let mut replay = reasoner_for(
        spec.clone(),
        ReasonerConfig {
            replay: Some(conformance().join("reasoner/spark-oscillator.jsonl")),
            ..Default::default()
        },
    )
    .unwrap();
    let policy = ReasonLanePolicy::new(
        ReplayReasoner::new(conformance().join("reasoner/spark-oscillator.jsonl")).unwrap(),
    )
    .with_model_spec(spec)
    .unwrap();
    let mut meta = policy.meta();
    meta["config_version"] = json!(config(
        wb,
        &json!({"name":"reason-replayed","writer":"autophys-rs"})
    ));
    meta["seed"] = json!(0);
    let playbook = load_playbook("default").unwrap();
    assert_eq!(
        wb.put_blob(&playbook.data().unwrap(), "text/markdown")
            .unwrap(),
        format!("sha256:{}", playbook.sha256)
    );
    let (inv, _) = wb.create_investigation(meta, None).unwrap();
    let mut written = vec![];
    for r in source
        .iter()
        .filter(|r| r.record.kind == "step" && r.record.payload.get("usage").is_some())
    {
        let p = &r.record.payload;
        let reply = replay
            .complete(
                &[
                    json!({"role":"developer","content":system_prompt()}),
                    json!({"role":"user","content":p["evidence_text"]}),
                ],
                &ReasonOptions {
                    response_schema: Some(decision_schema()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(reply.replayed);
        assert_eq!(reply.content, p["raw_output"]);
        assert_eq!(normalize_usage(&reply), p["usage"]);
        let step = json!({"index":written.len()+1,"evidence_text":p["evidence_text"],"raw_output":reply.content,
            "decision":parse_json_content(&reply.content).unwrap(),"model":reply.model,"elapsed_ms":reply.elapsed_ms,
            "usage":normalize_usage(&reply),"replayed":reply.replayed});
        inv.append("step", step.clone(), None).unwrap();
        written.push(step);
    }
    assert_eq!(written.len(), 8);
    let total = usage_total(&written);
    assert_eq!(
        total,
        source
            .iter()
            .find(|r| r.record.kind == "outcome")
            .unwrap()
            .record
            .payload["usage_total"]
    );
    let image = &source.last().unwrap().record.payload["images"][0];
    let (bytes, media) = python.get_blob(image["sha256"].as_str().unwrap()).unwrap();
    let hash = wb.put_blob(&bytes, &media).unwrap();
    inv.append(
        "step",
        json!({"images":[{"sha256":hash,"media_type":media,"caption":"Rust image fixture"}]}),
        None,
    )
    .unwrap();
    let legacy = json!({"usage":{"prompt_tokens":7,"provider_extra":{"opaque":true}}});
    inv.append("step", legacy.clone(), None).unwrap();
    assert_eq!(
        usage_total(
            inv.records(Some("step"))
                .unwrap()
                .iter()
                .map(|r| &r.payload)
        ),
        total
    );
    inv.append(
        "outcome",
        json!({"status":"validated","usage_total":total}),
        None,
    )
    .unwrap();
    let info = serde_json::to_value(inv.info().unwrap()).unwrap();
    assert_eq!(info["playbook"], playbook.metadata());
    assert_eq!(info["model"], head["model"]);
    assert_eq!(info["usage_total"], total);
    assert_eq!(info["steps"].as_array().unwrap().last().unwrap(), &legacy);
    assert_eq!(
        wb.get_blob(&playbook.sha256).unwrap().0,
        playbook.data().unwrap()
    );
}

type Case = (&'static str, fn(&Workbook));
const CASES: &[Case] = &[
    ("events-and-values", events_and_values),
    ("two-investigations", two_investigations),
    ("reason-replayed", reason_replayed),
];

/// Write every case into `out` as `<case>.ap-workbook` (a single vacuumed
/// file, `journal_mode = DELETE`) plus `<case>.json`.
fn write_cases(out: &Path) -> Vec<PathBuf> {
    std::fs::create_dir_all(out).unwrap();
    let mut written = Vec::new();
    for (case, build) in CASES {
        if std::env::var("AUTOPHYS_WRITE_GOLDENS_CASE").is_ok_and(|v| v != *case) {
            continue;
        }
        let path = out.join(format!("{case}.ap-workbook"));
        for p in [
            path.clone(),
            out.join(format!("{case}.ap-workbook-wal")),
            out.join(format!("{case}.ap-workbook-shm")),
        ] {
            let _ = std::fs::remove_file(p);
        }
        let exp = {
            let client = connect(Some(path.to_str().unwrap())).unwrap();
            let wb = client.project(case).unwrap();
            build(&wb);
            let report = wb.verify().unwrap();
            assert!(report.ok, "{case}: {report:?}");
            expected(&path, &wb)
        };
        let raw = Connection::open(&path).unwrap();
        let _: String = raw
            .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
            .unwrap();
        raw.execute_batch("VACUUM").unwrap();
        drop(raw);
        let text = serde_json::to_string_pretty(&exp).unwrap() + "\n";
        std::fs::write(path.with_extension("json"), text).unwrap();
        written.push(path);
    }
    written
}

#[test]
fn the_generator_writes_self_consistent_cases() {
    let out = if std::env::var_os("AUTOPHYS_WRITE_GOLDENS").is_some() {
        let dir = conformance().join("rust");
        eprintln!("writing the Rust goldens into {}", dir.display());
        write_cases(&dir);
        return;
    } else {
        tempfile::tempdir().unwrap()
    };
    for path in write_cases(out.path()) {
        read_back(&path);
    }
}
