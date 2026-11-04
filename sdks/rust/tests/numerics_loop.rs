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

#[test]
fn resume_preserves_fit_and_warm_start() {
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let (p, ds, _) = input();
    let wb = client.project_with(p).unwrap();
    let mut inv = wb
        .investigate(ds, ProposalRunner, ScriptedPolicy::default())
        .unwrap();
    inv.tool_optimize_parameters(Some(1), "linear").unwrap();
    let old_fit = inv.fit.as_ref().unwrap().to_dict();
    let id = inv.id.clone();
    let mut resumed = wb
        .resume(&id, ProposalRunner, ScriptedPolicy::default())
        .unwrap();
    assert_eq!(resumed.fit.as_ref().unwrap().to_dict(), old_fit);
    assert_eq!(resumed.fit_id, inv.fit_id);
    assert_eq!(resumed.facts()["fit"]["current"], true);
    inv.tool_optimize_parameters(Some(1), "linear").unwrap();
    resumed.tool_optimize_parameters(Some(1), "linear").unwrap();
    assert_eq!(
        resumed.fit.as_ref().unwrap().to_dict(),
        inv.fit.as_ref().unwrap().to_dict()
    );
}
#[test]
fn withdrawal_and_outlook_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let (mut p, ds, _) = input();
    p.catalog
        .get_mut("step_long")
        .unwrap()
        .edit
        .insert("power".into(), [1., 10.]);
    let wb = client.project_with(p).unwrap();
    let mut inv = wb
        .investigate(
            ds,
            ProposalRunner,
            script(&[("request_experiment", json!({"experiment":"step_long"}))]),
        )
        .unwrap();
    let out = inv.run().unwrap();
    let pid = out.proposal_id.unwrap();
    let proposal = inv.records(Some("proposal")).unwrap();
    let grid = &proposal[0].payload["outlook"];
    assert_eq!(grid["at"], "initial");
    assert_eq!(grid["after_resolved_max"], 1.);
    let steps = inv.records(Some("step")).unwrap();
    assert_eq!(
        steps[0].payload["result"]["outlook_points"]["power"],
        grid["axes"][0]["values"].as_array().unwrap().len()
    );
    inv.withdraw(&pid, "reviewer", "change plan").unwrap();
    assert!(inv.pending.is_none());
    let records = inv.records(Some("proposal")).unwrap();
    assert_eq!(records[1].payload["via"], "sdk");
    assert_eq!(records[1].payload["event"], "withdrawn");
    assert_eq!(inv.proposal(&pid).unwrap().status, "withdrawn");
    assert!(
        wb.resume(&inv.id, ProposalRunner, ScriptedPolicy::default())
            .unwrap()
            .pending
            .is_none()
    );
    assert!(wb.verify().unwrap().ok);
}

#[test]
fn wait_uses_explicit_older_proposal_among_two_pending() {
    use std::time::Duration;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_str().unwrap().to_string();
    let client = autophys::connect(Some(&root)).unwrap();
    let (p, ds, _) = input();
    let wb = client.project_with(p).unwrap();
    let mut inv = wb
        .investigate(
            ds,
            ProposalRunner,
            script(&[("request_experiment", json!({"experiment":"step_long"}))]),
        )
        .unwrap();
    let pid = inv.run().unwrap().proposal_id.unwrap();
    inv.append(
        "proposal",
        json!({"proposal_id":"newer","event":"proposed",
        "experiment":"step_long","settings":{"power":10.}}),
        None,
    )
    .unwrap();
    assert!(matches!(
        inv.record.wait_for_approval("unknown", Duration::ZERO),
        Err(autophys::Error::NotFound(_))
    ));
    let id = inv.id.clone();
    let older = pid.clone();
    let decider = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        autophys::connect(Some(&root))
            .unwrap()
            .find_investigation(&id)
            .unwrap()
            .approve(&older, "other writer", None)
            .unwrap();
    });
    // The agent must forward its pending id, rather than selecting the newer record.
    let approved = inv.wait_for_approval(Duration::from_secs(5)).unwrap();
    decider.join().unwrap();
    assert_eq!(approved.proposal_id, pid);
    assert_eq!(approved.status, "approved");
    assert_eq!(inv.proposal("newer").unwrap().status, "proposed");
    // Already decided proposals return immediately, even with a zero timeout.
    assert_eq!(
        inv.record
            .wait_for_approval(&pid, Duration::ZERO)
            .unwrap()
            .proposal_id,
        pid
    );
}
