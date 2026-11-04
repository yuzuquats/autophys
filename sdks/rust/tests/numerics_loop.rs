//! Record-backed loop, proposal replay, guardrails and simulation-budget isolation.
use autophys::{
    agent::{Decision, ProposalRunner, ScriptedPolicy, SequencePolicy},
    data::{Dataset, Observation},
    fit::rng::NumpyRng,
    models,
    project::Project,
    simulator::{FIT_OPTIONS, Params, Simulator},
    synthetic::{NoiseModel, observe},
};
use serde_json::{Value, json};
fn input() -> (Project, Dataset, Params) {
    let sim = models::thermal_rc();
    let truth: Params = [("C".into(), 500.), ("R".into(), 2.)].into_iter().collect();
    let noise = NoiseModel::new([("T".into(), 0.05)].into_iter().collect());
    let mut rng = NumpyRng::new(2);
    let train = observe(
        &sim,
        &truth,
        &json!("step_short"),
        &noise,
        &mut rng,
        "train",
        None,
    )
    .unwrap();
    let val = observe(
        &sim,
        &truth,
        &json!("step_long"),
        &noise,
        &mut rng,
        "validation",
        None,
    )
    .unwrap();
    let mut p = Project::new("test", sim);
    p.initial = truth.clone();
    p.noise.bias = "off".into();
    p.n_starts = 1;
    (p, Dataset::new([train, val]).unwrap(), truth)
}
fn script(actions: &[(&str, Value)]) -> SequencePolicy {
    SequencePolicy::new(
        actions
            .iter()
            .map(|(a, v)| json!(Decision::new(a, v.clone()))),
    )
}
#[test]
fn proposal_resume_and_config_pin() {
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let (p, ds, truth) = input();
    let wb = client.project_with(p.clone()).unwrap();
    let policy = script(&[("request_experiment", json!({"experiment":"step_long"}))]);
    let mut inv = wb.investigate(ds, ProposalRunner, policy).unwrap();
    let out = inv.run().unwrap();
    assert_eq!(out.status, "awaiting_data");
    let pid = out.proposal_id.unwrap();
    let id = inv.id.clone();
    assert!(inv.run().is_err());
    let sim = p.simulator.clone();
    let settings = sim.experiment(&json!("step_long")).unwrap();
    let y = sim.simulate(&truth, &settings, FIT_OPTIONS).unwrap();
    let mut o = Observation::new(
        "step_long",
        settings,
        y["t"].clone(),
        [("T".into(), y["T"].clone())].into_iter().collect(),
        [("T".into(), 0.05)].into_iter().collect(),
    )
    .unwrap();
    o.split = "test".into();
    assert!(inv.attach_data(&pid, o.clone()).is_err());
    inv.approve(&pid, "reviewer", None).unwrap();
    inv.attach_data(&pid, o).unwrap();
    assert_eq!(inv.experiments_used, 1);
    assert_eq!(inv.dataset.version, 3);
    drop(inv);
    let inv = wb
        .resume(&id, ProposalRunner, ScriptedPolicy::default())
        .unwrap();
    assert!(inv.pending.is_none());
    assert_eq!(inv.experiments_used, 1);
    assert_eq!(inv.dataset.version, 3);
    assert_eq!(inv.steps, 1);
    assert_eq!(inv.runs_per_experiment["step_long"], 1);
    assert!(wb.verify().unwrap().ok);
    let mut changed = p;
    changed.initial.insert("C".into(), 600.);
    let changed = client.project_with(changed).unwrap();
    assert!(
        changed
            .resume(&id, ProposalRunner, ScriptedPolicy::default())
            .is_err()
    );
}
#[test]
fn budgets_do_not_get_swallowed_by_fit() {
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let (mut p, ds, _) = input();
    p.budgets.max_simulations = 1;
    let original = p.simulator.clone();
    let wb = client.project_with(p).unwrap();
    let mut inv = wb
        .investigate(ds, ProposalRunner, ScriptedPolicy::default())
        .unwrap();
    let out = inv.run().unwrap();
    assert_eq!(out.status, "budget_exhausted");
    assert_eq!(out.simulations, 1);
    assert!(wb.verify().unwrap().ok);
    let p = [("C".into(), 500.), ("R".into(), 2.)].into_iter().collect();
    original
        .simulate(&p, &json!("step_short"), FIT_OPTIONS)
        .unwrap();
}
#[test]
fn invalid_decisions_fail_and_guardrail_downgrades_claims() {
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let (p, ds, _) = input();
    let wb = client.project_with(p).unwrap();
    let mut inv = wb
        .investigate(
            ds.clone(),
            ProposalRunner,
            SequencePolicy::new([json!({}), json!({}), json!({})]),
        )
        .unwrap();
    let out = inv.run().unwrap();
    assert_eq!(out.status, "failed");
    assert_eq!(out.steps, 3);
    let mut inv = wb
        .investigate(
            ds,
            ProposalRunner,
            script(&[("stop", json!({"status":"validated","identified":["C","R"]}))]),
        )
        .unwrap();
    let out = inv.run().unwrap();
    assert_eq!(out.status, "inconclusive");
    assert!(out.identified.is_empty());
    assert_eq!(out.guardrail_overrides, vec!["C", "R"]);
}
#[test]
fn scripted_runs_through_refit_and_validation() {
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let (mut p, ds, truth) = input();
    p.budgets.max_experiments = 1;
    let sim = p.simulator.clone();
    let runner = move |name: &str, settings: &Value| {
        let y = sim.simulate(&truth, settings, FIT_OPTIONS)?;
        Observation::new(
            name,
            settings.clone(),
            y["t"].clone(),
            [("T".into(), y["T"].clone())].into_iter().collect(),
            [("T".into(), 0.05)].into_iter().collect(),
        )
    };
    let wb = client.project_with(p).unwrap();
    let mut inv = wb
        .investigate(ds, runner, ScriptedPolicy::default())
        .unwrap();
    let out = inv.run().unwrap();
    assert_eq!(out.status, "validated");
    assert_eq!(out.experiments, 1);
    let actions: Vec<_> = inv
        .records(Some("step"))
        .unwrap()
        .into_iter()
        .map(|r| {
            r.payload["decision"]["action"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(
        actions,
        vec![
            "optimize_parameters",
            "analyze_sensitivity",
            "rank_experiments",
            "request_experiment",
            "optimize_parameters",
            "analyze_sensitivity",
            "validate_predictions",
            "stop"
        ]
    );
    assert!(wb.verify().unwrap().ok);
}
