//! FC-1/GT-1: Python numerical reference, byte-stable record replay, no truth in facts.
use autophys::{
    agent::{Investigation, ProposalRunner, ScriptedPolicy, render_facts},
    curves::run_payload,
    data::{Dataset, Observation},
    fit::{FitResult, StartResult},
    project::{Project, ProjectWorkbook},
    simulator::*,
    synthetic::{Evaluator, thermal_case},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
fn golden(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance/python")
        .join(name)
}
fn fixture_records() -> (tempfile::TempDir, autophys::Workbook, Vec<autophys::Record>) {
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("thermal.ap-workbook");
    std::fs::copy(golden("thermal-curves-reveal.ap-workbook"), &copy).unwrap();
    let client = autophys::connect(Some(copy.to_str().unwrap())).unwrap();
    let wb = client.workbooks().unwrap().remove(0);
    let records = wb
        .records_after(0, i64::MAX)
        .unwrap()
        .into_iter()
        .map(|l| l.record)
        .collect();
    (dir, wb, records)
}
fn near(a: f64, b: f64, atol: f64, rtol: f64) {
    assert!((a - b).abs() <= atol + rtol * b.abs(), "{a} != {b}");
}
fn compare_curves(a: &Value, b: &Value) {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => {
            near(a.as_f64().unwrap(), b.as_f64().unwrap(), 1e-8, 1e-5)
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len());
            for (a, b) in a.iter().zip(b) {
                compare_curves(a, b);
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len());
            for (k, b) in b {
                compare_curves(&a[k], b);
            }
        }
        _ => assert_eq!(a, b),
    }
}
#[test]
fn python_workbook_curves_and_unchanged_record_bytes() {
    let (_dir, wb, records) = fixture_records();
    let sim = autophys::models::thermal_rc();
    let budget = Arc::new(Mutex::new(CallBudget::new(Some(0))));
    sim.set_budget(Some(budget.clone()));
    let mut measurements = vec![];
    let mut points = 0;
    for record in &records {
        if record.kind == "measurement" {
            measurements.push(record.clone());
        }
        if record.kind == "run" {
            let fit = FitResult::from_dict(record.payload.clone()).unwrap();
            let mut metadata = record.payload.clone();
            metadata.as_object_mut().unwrap().remove("curves");
            let generated = run_payload(&sim, &fit, &measurements, metadata.clone()).unwrap();
            compare_curves(&generated["curves"], &record.payload["curves"]);
            points += generated["curves"]
                .as_object()
                .unwrap()
                .values()
                .map(|e| e["fit"]["T"].as_array().unwrap().len() * 2)
                .sum::<usize>();
            let mut stripped = generated;
            stripped.as_object_mut().unwrap().remove("curves");
            assert_eq!(
                autophys::canonical(&stripped),
                autophys::canonical(&metadata)
            );
        }
    }
    assert_eq!(points, 2170);
    assert_eq!(sim.calls(), 0);
    assert_eq!(budget.lock().unwrap().used, 0);
    // Reading/rebuilding retains every canonical payload byte and chain hash.
    let before = wb.records_after(0, i64::MAX).unwrap();
    wb.rebuild_projections().unwrap();
    assert_eq!(before, wb.records_after(0, i64::MAX).unwrap());
    assert!(wb.verify().unwrap().ok);
}
#[test]
fn python_numerical_curve_cases() {
    for label in ["fit", "initial"] {
        let case: Value = serde_json::from_slice(
            &std::fs::read(golden(&format!("thermal-curves-{label}.json"))).unwrap(),
        )
        .unwrap();
        let sim = autophys::models::thermal_rc();
        let mut settings = case["inputs"]["settings"].clone();
        settings["t"] = case["inputs"]["t"].clone();
        let params = serde_json::from_value(case["inputs"]["theta"].clone()).unwrap();
        let pred = sim.call(&params, &settings, TRUTH_OPTIONS, false).unwrap();
        let expected = &case["expect"]["y"];
        for (ch, arr) in expected["value"].as_object().unwrap() {
            for (a, b) in pred.output(ch).unwrap().iter().zip(arr.as_array().unwrap()) {
                near(
                    *a,
                    b.as_f64().unwrap(),
                    expected["atol"].as_f64().unwrap(),
                    expected["rtol"].as_f64().unwrap(),
                );
            }
        }
    }
}
fn toy() -> FunctionSimulator {
    simulator(
        "line",
        vec![ParamSpec::new("a", "", 0.1, 10.).unwrap()],
        Default::default(),
        vec!["y".into()],
        "line",
        |p, e, o| {
            assert_eq!(o.rtol, 1e-11);
            assert_eq!(o.atol, 1e-13);
            let t = time_grid(e)?;
            Ok([
                ("y".into(), t.iter().map(|t| p["a"] * t).collect()),
                ("input".into(), t.clone()),
                ("t".into(), t),
            ]
            .into_iter()
            .collect())
        },
    )
    .unwrap()
}
fn fake_fit() -> FitResult {
    FitResult {
        params: [("a".into(), 2.)].into_iter().collect(),
        loss: 0.,
        chi2_per_n: 0.,
        n: 1,
        nfev: 1,
        status: 1,
        message: "ok".into(),
        success: true,
        loss_kind: "linear".into(),
        at_bounds: vec![],
        starts: vec![
            StartResult {
                x0: vec![1.23456789_f64.ln()],
                loss: 0.,
                nfev: 1,
                status: 1,
                success: true,
            },
            StartResult {
                x0: vec![3_f64.ln()],
                loss: 0.,
                nfev: 1,
                status: 1,
                success: true,
            },
        ],
        dataset_version: Some(1),
        source_hash: "test".into(),
        seed: Some(17),
    }
}
fn measurement(n: usize) -> autophys::Record {
    let t: Vec<_> = (0..n).map(|i| 3. * i as f64 / (n - 1) as f64).collect();
    let obs = Observation::new(
        "e",
        json!({"kind":"e","duration":999.}),
        t.clone(),
        [("y".into(), t)].into_iter().collect(),
        [("y".into(), 1.)].into_iter().collect(),
    )
    .unwrap();
    autophys::Record {
        id: "m0".into(),
        investigation: "inv".into(),
        seq: 1,
        kind: "measurement".into(),
        ts: 0.,
        payload: json!({"observation":obs.to_dict()}),
        prev_hash: autophys::GENESIS.into(),
        hash: "unused".into(),
    }
}
#[test]
fn own_grid_rounding_halving_and_impossible_cap() {
    let sim = toy();
    let r = fake_fit();
    let m = measurement(2101);
    sim.set_budget(Some(Arc::new(Mutex::new(CallBudget::new(Some(0))))));
    let payload = run_payload(&sim, &r, &[m.clone()], json!({})).unwrap();
    let entry = &payload["curves"]["m0"];
    assert_eq!(entry["t"].as_array().unwrap().len(), 2000);
    assert_eq!(entry["initial"]["y"][1999], json!(3.70370));
    assert_eq!(entry["fit"]["y"].as_object(), None);
    assert_eq!(entry["fit"].as_object().unwrap().len(), 1);
    let t = m.payload["observation"]["t"].as_array().unwrap();
    for i in 0..2000 {
        let j = (i as f64 * (2100. / 1999.)).round_ties_even() as usize;
        assert_eq!(entry["t"][i], t[j]);
        assert_eq!(
            entry["fit"]["y"][i].as_f64().unwrap(),
            format!("{:.5e}", 2. * t[j].as_f64().unwrap())
                .parse::<f64>()
                .unwrap()
        );
    }
    let records: Vec<_> = (0..12)
        .map(|i| {
            let mut m = m.clone();
            m.id = format!("m{i}");
            m
        })
        .collect();
    let payload = run_payload(&sim, &r, &records, json!({"metadata":"x".repeat(1000)})).unwrap();
    let len = payload["curves"]["m0"]["t"].as_array().unwrap().len();
    assert!([1000, 500, 250, 125, 62, 31, 15, 7, 3, 1].contains(&len));
    for e in payload["curves"].as_object().unwrap().values() {
        assert_eq!(e["t"].as_array().unwrap().len(), len);
        for i in 0..len {
            let j = (i as f64 * (2100. / (len - 1) as f64)).round_ties_even() as usize;
            assert_eq!(e["t"][i], t[j]);
        }
    }
    assert!(autophys::canonical(&payload).len() <= 256 * 1024);
    assert!(
        run_payload(&sim, &r, &records, json!({"metadata":"x".repeat(256*1024)}))
            .unwrap_err()
            .to_string()
            .contains("one curve point")
    );
    assert_eq!(sim.calls(), 0);
    let small = run_payload(&sim, &r, &[measurement(3)], json!({})).unwrap();
    assert!(small["curves"]["m0"].get("t").is_none());
}
fn setup() -> (tempfile::TempDir, ProjectWorkbook, Investigation, Evaluator) {
    let (view, ev) = thermal_case(0, 0, 0., 0.).unwrap();
    let mut p = Project::new(view.name, view.simulator);
    p.budgets.max_experiments = 0;
    let dir = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(dir.path().to_str().unwrap())).unwrap();
    let wb = client.project_with(p).unwrap();
    let inv = wb
        .investigate(view.dataset, view.runner, ScriptedPolicy::default())
        .unwrap();
    (dir, wb, inv, ev)
}
#[test]
fn live_loop_reveal_guards_facts_and_idempotency() {
    let (_dir, wb, mut inv, ev) = setup();
    assert_eq!(
        ev.reveal(&inv).unwrap_err().to_string(),
        "reveal requires an outcome"
    );
    inv.tool_optimize_parameters(None, "linear").unwrap();
    let runs = inv.records(Some("run")).unwrap();
    let curves = &runs[0].payload["curves"];
    for m in inv.records(Some("measurement")).unwrap() {
        assert!(curves.get(&m.id).is_some());
    }
    let restored = wb
        .resume(&inv.id, ProposalRunner, ScriptedPolicy::default())
        .unwrap();
    assert_eq!(
        inv.fit.as_ref().unwrap().to_dict(),
        restored.fit.as_ref().unwrap().to_dict()
    );
    assert_eq!(render_facts(&inv.facts()), render_facts(&restored.facts()));
    assert!(inv.fit.as_ref().unwrap().to_dict().get("curves").is_none());
    inv.run().unwrap();
    let facts = inv.facts();
    let sims = inv.simulations();
    let record = ev.reveal(&inv).unwrap().record;
    let q = &record.payload["quantities"][0];
    let variance: f64 = inv
        .sens
        .as_ref()
        .unwrap()
        .directions
        .iter()
        .map(|d| (d.vector["C"] / d.singular_value).powi(2))
        .sum();
    near(
        q["sigma_ratio"].as_f64().unwrap(),
        q["ratio"].as_f64().unwrap().abs() * variance.sqrt(),
        1e-15,
        1e-14,
    );
    assert_eq!(inv.facts(), facts);
    assert_eq!(inv.simulations(), sims);
    assert!(!render_facts(&facts).contains("truth"));
    assert_eq!(
        inv.records(None)
            .unwrap()
            .iter()
            .rev()
            .take(2)
            .map(|r| r.kind.as_str())
            .collect::<Vec<_>>(),
        ["reveal", "outcome"]
    );
    assert!(
        !inv.append("reveal", record.payload.clone(), Some(&record.id))
            .unwrap()
            .created
    );
    assert!(
        ev.reveal(&inv)
            .unwrap_err()
            .to_string()
            .contains("already has a reveal")
    );
    assert_eq!(
        inv.run().unwrap_err().to_string(),
        "cannot continue an investigation after ground truth reveal"
    );
    assert!(
        inv.approve("p", "user", None)
            .unwrap_err()
            .to_string()
            .contains("ground truth reveal")
    );
    assert!(
        inv.attach_data("p", inv.dataset.iter().next().unwrap().clone())
            .unwrap_err()
            .to_string()
            .contains("ground truth reveal")
    );
    assert_eq!(
        wb.resume(&inv.id, ProposalRunner, ScriptedPolicy::default())
            .err()
            .unwrap()
            .to_string(),
        "cannot resume an investigation after ground truth reveal"
    );
}
#[test]
fn python_reveal_numbers_and_exact_nonuncertainty_fields() {
    let (_gold_dir, _gold_wb, records) = fixture_records();
    let (_dir, _wb, mut inv, _) = setup();
    inv.tool_optimize_parameters(None, "linear").unwrap();
    let last = records.iter().rfind(|r| r.kind == "run").unwrap();
    inv.fit = Some(FitResult::from_dict(last.payload.clone()).unwrap());
    inv.fit_id = 2;
    inv.dataset = Dataset::new(
        records
            .iter()
            .filter(|r| r.kind == "measurement")
            .map(|r| Observation::from_dict(r.payload["observation"].clone()).unwrap()),
    )
    .unwrap();
    let sens = inv.tool_analyze_sensitivity().unwrap();
    let marginal = sens["marginal_log_std"].as_object().unwrap();
    for name in sens["identified"].as_array().unwrap() {
        let v = marginal[name.as_str().unwrap()].as_f64().unwrap();
        assert!(v > 0. && v <= 0.1, "{name}: {v}");
    }
    for name in sens["non_identified"].as_array().unwrap() {
        assert!(marginal[name.as_str().unwrap()].is_null(), "{name} is on a ridge");
    }
    let outcome = records
        .iter()
        .find(|r| r.kind == "outcome")
        .unwrap()
        .payload
        .clone();
    inv.outcome = Some(serde_json::from_value(outcome.clone()).unwrap());
    inv.append("outcome", outcome, None).unwrap();
    let (_, ev) = thermal_case(0, 2, 0., 0.).unwrap();
    let mut actual = ev.reveal(&inv).unwrap().record.payload;
    let expected = &records.last().unwrap().payload;
    for (a, b) in actual["quantities"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(expected["quantities"].as_array().unwrap())
    {
        near(
            a["sigma_ratio"].as_f64().unwrap(),
            b["sigma_ratio"].as_f64().unwrap(),
            1e-8,
            1e-5,
        );
        a["sigma_ratio"] = b["sigma_ratio"].clone();
    }
    assert_eq!(autophys::canonical(&actual), autophys::canonical(expected));
}
#[test]
fn missing_and_stale_sensitivity_omit_uncertainty_and_missing_estimates() {
    for stale in [false, true] {
        let (_dir, _wb, mut inv, mut ev) = setup();
        inv.run().unwrap();
        if stale {
            inv.fit_id += 1;
        } else {
            inv.sens = None;
        }
        ev.combos.insert(
            "missing".into(),
            [("missing".into(), 1.)].into_iter().collect(),
        );
        let payload = ev.reveal(&inv).unwrap().record.payload;
        assert_eq!(payload["quantities"].as_array().unwrap().len(), 1);
        assert!(payload["quantities"][0]["sigma_ratio"].is_null());
    }
}
#[test]
fn combinations_structural_zero_and_linear_gradients() {
    let (_dir, _wb, mut inv, mut ev) = setup();
    inv.run().unwrap();
    ev.truth["C"] = 250.;
    ev.combos = [
        (
            "C/R".into(),
            [("C".into(), 1.), ("R".into(), -1.)].into_iter().collect(),
        ),
        ("C".into(), [("C".into(), 1.)].into_iter().collect()),
    ]
    .into_iter()
    .collect();
    ev.expected_non_identified.insert("C/R".into());
    inv.variants.get_mut("base").unwrap().params.insert(
        "bias_T".into(),
        ParamSpec::new("bias_T", "", -1., 1.).unwrap(),
    );
    inv.outcome
        .as_mut()
        .unwrap()
        .estimate
        .insert("bias_T".into(), 0.);
    let report = inv.sens.as_mut().unwrap();
    report.params.push("bias_T".into());
    report.directions = vec![
        autophys::sensitivity::Direction {
            singular_value: 0.,
            log_std: f64::INFINITY,
            vector: [("C".into(), 1.), ("R".into(), 1.), ("bias_T".into(), 0.)]
                .into_iter()
                .collect(),
            kind: "structural".into(),
            combination: "C R".into(),
        },
        autophys::sensitivity::Direction {
            singular_value: 10.,
            log_std: 0.1,
            vector: [("C".into(), 1.), ("R".into(), -1.), ("bias_T".into(), 0.)]
                .into_iter()
                .collect(),
            kind: "identifiable".into(),
            combination: "C/R".into(),
        },
    ];
    let q = ev.reveal(&inv).unwrap().record.payload["quantities"].clone();
    near(
        q[0]["sigma_ratio"].as_f64().unwrap(),
        q[0]["ratio"].as_f64().unwrap().abs() * 0.2,
        1e-14,
        1e-14,
    );
    assert_eq!(q[0]["identifiable"], false);
    assert_eq!(q[0]["within"], false);
    assert!(q[1]["sigma_ratio"].is_null());
}
