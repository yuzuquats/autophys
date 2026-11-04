//! MQ-5 battery diagnosis and physical test-hour budgets (entirely offline).
//! Expected values are the Python reference (sdks/python/tests/test_battery.py).
use autophys::{
    agent::{Investigation, ProposalRunner, ScriptedPolicy, render_facts},
    canonical::{canonical, sha256_hex},
    models,
    project::{Project, ProjectWorkbook},
    synthetic::{CaseView, battery_case, oscillator_case},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const PULSE: f64 = 1. + 300. / 3600.;

fn case_project(view: &CaseView) -> Project {
    let mut p = Project::new(view.name.clone(), view.simulator.clone());
    if let Some(catalog) = &view.catalog {
        p.catalog = catalog.clone();
    }
    p.budgets.max_experiments = view.max_experiments;
    p.budgets.max_test_hours = view.max_test_hours;
    p
}
struct Setup {
    _temp: tempfile::TempDir,
    wb: ProjectWorkbook,
    inv: Investigation,
    view: CaseView,
}
fn investigation(limit: Option<f64>, proposals: bool) -> Setup {
    let (view, _) = battery_case(0, 2).unwrap();
    let mut project = case_project(&view);
    project.budgets.max_test_hours = limit;
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let wb = client.project_with(project).unwrap();
    let (runner_view, _) = battery_case(0, 2).unwrap();
    let runner: Box<dyn autophys::agent::Runner> = if proposals {
        Box::new(ProposalRunner)
    } else {
        Box::new(runner_view.runner)
    };
    let inv = wb
        .investigate_with(
            view.dataset.clone(),
            runner,
            Box::new(ScriptedPolicy::default()),
            None,
            0,
            "",
        )
        .unwrap();
    Setup {
        _temp: temp,
        wb,
        inv,
        view,
    }
}
fn resume(s: &Setup) -> Investigation {
    s.wb.resume(&s.inv.id, ProposalRunner, ScriptedPolicy::default())
        .unwrap()
}
fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-12 * b.abs().max(1.)
}

#[test]
fn battery_diagnosis_matches_python() {
    // Python `run_case(case, "scripted", seed)` for seeds 0..3.
    for (case, max_experiments) in [("battery-short-only", 0), ("battery", 2)] {
        for seed in 0..3 {
            let (view, ev) = battery_case(seed, max_experiments).unwrap();
            assert_eq!(view.name, case);
            let temp = tempfile::tempdir().unwrap();
            let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
            let wb = client.project_with(case_project(&view)).unwrap();
            let mut inv = wb
                .investigate_with(
                    view.dataset.clone(),
                    Box::new(view.runner),
                    Box::new(ScriptedPolicy::default()),
                    None,
                    seed,
                    &format!("bench {case} seed {seed}"),
                )
                .unwrap();
            let out = inv.run().unwrap();
            let requested: Vec<_> = inv
                .dataset
                .split("train")
                .iter()
                .skip(1)
                .map(|o| o.experiment.clone())
                .collect();
            let non: BTreeSet<_> = out.non_identified.iter().cloned().collect();
            assert!(ev.diagnosis_correct(&non), "{case} {seed}: {non:?}");
            if case == "battery" {
                assert_eq!(out.status, "validated", "{case} {seed}");
                assert_eq!(requested, ["discharge_1A"], "{case} {seed}");
                assert_eq!(inv.test_hours_used(), 1.1666666666666667, "{case} {seed}");
                assert_eq!(out.steps, 8, "{case} {seed}");
            } else {
                assert_eq!(out.status, "inconclusive", "{case} {seed}");
                assert_eq!(out.non_identified, ["R1"], "{case} {seed}");
                assert!(requested.is_empty());
                assert_eq!(inv.test_hours_used(), 0.);
                assert_eq!(out.steps, 4, "{case} {seed}");
            }
            let est = &out.estimate;
            assert!(
                ev.test_rmse(&inv.project.simulator, est)
                    .unwrap()
                    .is_finite()
            );
        }
    }
}

#[test]
fn costs_refusal_ranking_and_resume() {
    let mut s = investigation(Some(1.1), false);
    s.inv.tool_optimize_parameters(None, "linear").unwrap();
    let ranking = s.inv.tool_rank_experiments("min_eig").unwrap()["ranking"].clone();
    let names: BTreeSet<_> = ranking
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["experiment"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["pulse_2A", "pulse_train"].map(String::from).into());
    for c in ranking.as_array().unwrap() {
        let keys: Vec<_> = c.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            [
                "experiment",
                "min_eig",
                "d_opt",
                "min_eig_gain",
                "worst_direction",
                "after",
                "cost_hours"
            ]
        );
        assert_eq!(c["cost_hours"], json!(1.0833333333333333));
    }
    let e = s
        .inv
        .tool_request_experiment("discharge_1A", None)
        .unwrap_err();
    assert!(
        e.to_string()
            .contains("discharge_1A exceeds the test-hour budget of 1.1"),
        "{e}"
    );
    assert_eq!(s.inv.test_hours_used(), 0.);
    s.inv.tool_request_experiment("pulse_2A", None).unwrap();
    assert_eq!(s.inv.test_hours_used(), PULSE);
    assert!(s.inv.available_experiments().is_empty());
    let e = s
        .inv
        .tool_request_experiment("pulse_train", None)
        .unwrap_err();
    assert!(
        e.to_string()
            .contains("pulse_train exceeds the test-hour budget of 1.1"),
        "{e}"
    );
    let budget = s.inv.facts()["budget"].clone();
    assert_eq!(budget["test_hours_used"], json!(1.0833333333333333));
    assert_eq!(budget["test_hours_left"], json!(0.01666666666666683));
    let restored = resume(&s);
    assert_eq!(restored.test_hours_used(), s.inv.test_hours_used());
    assert_eq!(restored.facts()["budget"], budget);
}

#[test]
fn two_tests_and_initial_observation_costs() {
    let mut s = investigation(Some(3.), false);
    s.inv.tool_request_experiment("pulse_2A", None).unwrap();
    s.inv.tool_request_experiment("discharge_1A", None).unwrap();
    assert_eq!(s.inv.test_hours_used(), 2.25);
    let line = render_facts(&s.inv.facts())
        .lines()
        .find(|l| l.starts_with("BUDGET"))
        .unwrap()
        .to_string();
    // The Python reference renders this line byte for byte.
    assert_eq!(
        line,
        "BUDGET: steps_left=24 simulations_left=20000 experiments_left=0 experiments_requested=2 test_hours_used=2.25 test_hours_left=0.75"
    );
    assert_eq!(resume(&s).test_hours_used(), 2.25);
    // A catalog experiment among the initial observations is charged too.
    let (mut view, _) = battery_case(0, 2).unwrap();
    let o = view.runner.run(&json!("pulse_train")).unwrap();
    view.dataset.add(o).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let wb = client.project_with(case_project(&view)).unwrap();
    let other = wb
        .investigate(
            view.dataset.clone(),
            ProposalRunner,
            ScriptedPolicy::default(),
        )
        .unwrap();
    assert!(close(other.test_hours_used(), PULSE));
}

#[test]
fn attached_lab_name_cost_recomputed_from_proposal() {
    let mut s = investigation(Some(3.), true);
    let pid = s.inv.tool_request_experiment("pulse_2A", None).unwrap()["proposal_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(s.inv.test_hours_used(), 0.);
    s.inv.approve(&pid, "reviewer", None).unwrap();
    let mut o = s.view.runner.run(&json!("pulse_2A")).unwrap();
    o.experiment = "lab-trace-17".into();
    s.inv.attach_data(&pid, o).unwrap();
    assert_eq!(s.inv.test_hours_used(), PULSE);
    assert_eq!(resume(&s).test_hours_used(), PULSE);
}

#[test]
fn python_written_integer_measurement_version_is_resolved() {
    // Python records data_attached with the dataset version, not a hash.
    let mut s = investigation(Some(3.), true);
    let pid = s.inv.tool_request_experiment("pulse_2A", None).unwrap()["proposal_id"]
        .as_str()
        .unwrap()
        .to_string();
    s.inv.approve(&pid, "reviewer", None).unwrap();
    let mut o = s.view.runner.run(&json!("pulse_2A")).unwrap();
    o.experiment = "lab-trace-17".into();
    o.split = "train".into();
    s.inv
        .record
        .append(
            "measurement",
            json!({"version":3,"observation":o.to_dict()}),
            None,
        )
        .unwrap();
    s.inv
        .record
        .append(
            "proposal",
            json!({"proposal_id":pid,"event":"data_attached","measurement_version":3}),
            None,
        )
        .unwrap();
    let restored = resume(&s);
    assert_eq!(restored.dataset.len(), 3);
    assert_eq!(restored.test_hours_used(), PULSE);
}

#[test]
fn optional_config_and_uncosted_facts_compatibility() {
    let project = Project::new("legacy", models::oscillator());
    let config = project.config();
    assert!(config["budgets"].get("max_test_hours").is_none());
    for entry in config["catalog"].as_object().unwrap().values() {
        assert!(entry.get("cost_hours").is_none());
    }
    let mut legacy = config.clone();
    legacy["budgets"] = json!({"max_steps":24,"max_simulations":20000,"max_experiments":2});
    assert_eq!(
        project.config_version(),
        format!("sha256:{}", sha256_hex([canonical(&legacy).as_bytes()]))
    );
    let mut explicit = project.clone();
    explicit.budgets.max_test_hours = Some(0.);
    assert_eq!(
        explicit.config()["budgets"]["max_test_hours"].as_f64(),
        Some(0.)
    );
    assert_ne!(explicit.config_version(), project.config_version());
    let mut costed = project.clone();
    costed.catalog.get_index_mut(0).unwrap().1.cost_hours = Some(1.);
    let first = costed.catalog.get_index(0).unwrap().0.clone();
    let entry = &costed.config()["catalog"][&first];
    assert_eq!(canonical(&entry["cost_hours"]), "1.0");

    let (view, _) = oscillator_case(0, 2, 0., 0.).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let wb = client.project_with(project).unwrap();
    let mut inv = wb
        .investigate(
            view.dataset.clone(),
            ProposalRunner,
            ScriptedPolicy::default(),
        )
        .unwrap();
    let facts = inv.facts();
    assert!(facts["budget"].get("test_hours_used").is_none());
    let text = render_facts(&facts);
    assert!(!text.contains("test_hours"));
    assert!(text.contains(
        "\nBUDGET: steps_left=24 simulations_left=20000 experiments_left=2 experiments_requested=0\n"
    ));
    inv.tool_optimize_parameters(None, "linear").unwrap();
    let ranking = &inv.tool_rank_experiments("min_eig").unwrap()["ranking"];
    assert!(
        ranking[0].is_array(),
        "uncosted rankings keep the tuple shape"
    );
    let s = investigation(None, false);
    let budget = &s.inv.facts()["budget"];
    assert_eq!(budget["test_hours_used"], json!(0.0));
    assert!(budget.get("test_hours_left").is_none());
    assert!(render_facts(&s.inv.facts()).contains(" test_hours_used=0.0\n"));
}

#[test]
fn invalid_catalog_cost() {
    for cost in [-1., f64::INFINITY, f64::NAN] {
        let (view, _) = battery_case(0, 2).unwrap();
        let mut p = case_project(&view);
        p.catalog["pulse_2A"].cost_hours = Some(cost);
        let e = p.validate().unwrap_err().to_string();
        assert!(
            e.contains("pulse_2A: cost_hours must be finite and non-negative"),
            "{e}"
        );
    }
}

#[test]
fn invalid_test_hour_budget() {
    for limit in [-1., f64::INFINITY, f64::NAN] {
        let mut p = Project::new("x", models::battery_ecm());
        p.budgets.max_test_hours = Some(limit);
        let e = p.validate().unwrap_err().to_string();
        assert!(
            e.contains("max_test_hours must be finite and non-negative"),
            "{e}"
        );
    }
}

fn same(a: &Value, e: &Value, path: &str) {
    match (a, e) {
        (Value::Number(a), Value::Number(e)) => {
            let (a, e) = (a.as_f64().unwrap(), e.as_f64().unwrap());
            assert!((a - e).abs() <= 1e-9 + 1e-6 * e.abs(), "{path}: {a} vs {e}");
        }
        (Value::Array(a), Value::Array(e)) => {
            assert_eq!(a.len(), e.len(), "{path}");
            for (i, (a, e)) in a.iter().zip(e).enumerate() {
                same(a, e, &format!("{path}/{i}"));
            }
        }
        (Value::Object(a), Value::Object(e)) => {
            let mut ak: Vec<_> = a.keys().collect();
            let mut ek: Vec<_> = e.keys().collect();
            ak.sort();
            ek.sort();
            assert_eq!(ak, ek, "{path}");
            for (k, e) in e {
                same(&a[k], e, &format!("{path}/{k}"));
            }
        }
        _ => assert_eq!(a, e, "{path}"),
    }
}

#[test]
fn battery_case_matches_python_dataset_and_catalog() {
    let c: Value = serde_json::from_slice(
        &std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/conformance/numerics/battery/run-scripted.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let (view, ev) = battery_case(0, 2).unwrap();
    let dataset: Vec<_> = view.dataset.iter().map(|o| o.to_dict()).collect();
    same(&json!(dataset), &c["inputs"]["dataset"], "dataset");
    assert_eq!(json!(ev.truth), c["inputs"]["runner"]["theta"]);
    assert_eq!(view.max_test_hours, Some(3.));
    let costs: Vec<_> = view
        .catalog
        .unwrap()
        .iter()
        .map(|(n, e)| (n.clone(), e.cost_hours.unwrap(), e.max_runs))
        .collect();
    assert_eq!(
        costs,
        [
            ("discharge_1A".to_string(), 1. + 600. / 3600., None),
            ("pulse_2A".to_string(), PULSE, None),
            ("pulse_train".to_string(), PULSE, None),
        ]
    );
}

#[test]
fn declared_cost_cannot_be_null() {
    use autophys::project::CatalogEntry;
    let absent: CatalogEntry = serde_json::from_value(json!({"max_runs":null})).unwrap();
    assert_eq!(absent.cost_hours, None);
    for invalid in [Value::Null, json!(true), json!("1")] {
        assert!(serde_json::from_value::<CatalogEntry>(json!({"cost_hours":invalid})).is_err());
    }
    for cost in [0., 1.] {
        let entry: CatalogEntry = serde_json::from_value(json!({"cost_hours":cost})).unwrap();
        assert_eq!(entry.cost_hours, Some(cost));
    }
}

#[test]
fn affordability_uses_total_and_python_tolerance() {
    for (delta, allowed) in [(0., true), (5e-13, true), (2e-12, false)] {
        let limit = 2. * PULSE - delta;
        let mut s = investigation(Some(limit), false);
        s.inv.tool_request_experiment("pulse_2A", None).unwrap();
        assert_eq!(s.inv.test_hours_used(), PULSE);
        assert_eq!(
            s.inv
                .available_experiments()
                .contains(&"pulse_train".into()),
            allowed
        );
        let result = s.inv.tool_request_experiment("pulse_train", None);
        assert_eq!(result.is_ok(), allowed);
        if allowed {
            assert_eq!(s.inv.test_hours_used(), 2. * PULSE);
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("exceeds the test-hour budget")
            );
            assert_eq!(s.inv.test_hours_used(), PULSE);
        }
    }
}

#[test]
fn mixed_catalog_keeps_zero_cost_candidates_and_recomputes_dataset() {
    let mut s = investigation(Some(0.), false);
    s.inv.project.catalog["pulse_train"].cost_hours = None;
    assert_eq!(s.inv.available_experiments(), ["pulse_train"]);
    s.inv.tool_optimize_parameters(None, "linear").unwrap();
    let ranking = s.inv.tool_rank_experiments("min_eig").unwrap();
    assert_eq!(ranking["ranking"].as_array().unwrap().len(), 1);
    assert_eq!(ranking["ranking"][0]["experiment"], "pulse_train");
    assert_eq!(ranking["ranking"][0]["cost_hours"], json!(0.));
    // Hours come from every dataset observation, including direct additions
    // and splits other than train, rather than an experiment-count cache.
    let mut o = s.view.runner.run(&json!("pulse_2A")).unwrap();
    o.split = "validation".into();
    s.inv.dataset.add(o).unwrap();
    assert_eq!(s.inv.test_hours_used(), PULSE);
    assert!(s.inv.available_experiments().is_empty());
}
