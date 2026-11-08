//! G8-FINISH / LOOP-PARITY: when the simulator fails after the last good fit,
//! each failing tool step is that step's result, and the closing
//! identifiability check names the failure as a reason instead of ending the
//! run with an error and no outcome.
use autophys::{
    agent::{Decision, Policy, ProposalRunner, ScriptedPolicy},
    data::{Dataset, Observation},
    project::Project,
    simulator::*,
};
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[test]
fn a_simulator_failing_after_the_fit_still_ends_the_run_with_an_outcome() {
    let failing = Arc::new(AtomicBool::new(false));
    let flag = failing.clone();
    let sim = simulator(
        "flaky",
        vec![ParamSpec::new("a", "", -1., 3.).unwrap()],
        IndexMap::new(),
        vec!["y".into()],
        "flaky",
        move |p, e, _| {
            if flag.load(Ordering::SeqCst) {
                return Err(SimulationError::Simulation("diverged".into()));
            }
            let t = time_grid(e)?;
            Ok([("y".into(), vec![p["a"]; t.len()]), ("t".into(), t)]
                .into_iter()
                .collect())
        },
    )
    .unwrap();
    let mut project = Project::new("flaky", sim);
    project.budgets.max_steps = 4;
    project.budgets.max_experiments = 0;
    // No identifiability check at the fit, so the closing check runs it.
    project.analysis.identify_every_fit = false;
    let o = Observation::new(
        "e",
        json!({"kind":"custom","t":[0.,1.]}),
        vec![0., 1.],
        [("y".into(), vec![2.; 2])].into_iter().collect(),
        [("y".into(), 1.)].into_iter().collect(),
    )
    .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let wb = client.project_with(project).unwrap();
    let mut inv = wb
        .investigate(
            Dataset::new([o]).unwrap(),
            ProposalRunner,
            ScriptedPolicy::default(),
        )
        .unwrap();
    inv.tool_optimize_parameters(None, "linear").unwrap();
    failing.store(true, Ordering::SeqCst);
    let out = inv.run().expect("an outcome, not an error");
    assert_eq!(out.status, "budget_exhausted");
    assert!(
        inv.history
            .iter()
            .all(|h| h == "analyze_sensitivity: error diverged"),
        "{:?}",
        inv.history
    );
    assert!(
        out.reasons
            .iter()
            .any(|r| r == "identifiability could not be checked at the final estimate: diverged"),
        "{:?}",
        out.reasons
    );
    assert!(out.identified.is_empty());
}

struct StopClaiming;
impl Policy for StopClaiming {
    fn name(&self) -> &str {
        "stop"
    }
    fn decide(&mut self, _: &Value) -> Result<(Value, Value)> {
        let d = Decision::new(
            "stop",
            json!({"status":"validated","identified":["a"],"summary":"claims a"}),
        );
        Ok((d.to_dict(), json!({})))
    }
}

#[test]
fn a_claim_the_closing_check_could_not_test_says_it_was_not_checked() {
    // FINISH-WORDING: the rule never ran, so the outcome must not say it disagreed.
    let failing = Arc::new(AtomicBool::new(false));
    let flag = failing.clone();
    let sim = simulator(
        "flaky",
        vec![ParamSpec::new("a", "", -1., 3.).unwrap()],
        IndexMap::new(),
        vec!["y".into()],
        "flaky",
        move |p, e, _| {
            if flag.load(Ordering::SeqCst) {
                return Err(SimulationError::Simulation("diverged".into()));
            }
            let t = time_grid(e)?;
            Ok([("y".into(), vec![p["a"]; t.len()]), ("t".into(), t)]
                .into_iter()
                .collect())
        },
    )
    .unwrap();
    let mut project = Project::new("flaky", sim);
    project.budgets.max_experiments = 0;
    project.analysis.identify_every_fit = false;
    let o = Observation::new(
        "e",
        json!({"kind":"custom","t":[0.,1.]}),
        vec![0., 1.],
        [("y".into(), vec![2.; 2])].into_iter().collect(),
        [("y".into(), 1.)].into_iter().collect(),
    )
    .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let wb = client.project_with(project).unwrap();
    let mut inv = wb
        .investigate(Dataset::new([o]).unwrap(), ProposalRunner, StopClaiming)
        .unwrap();
    inv.tool_optimize_parameters(None, "linear").unwrap();
    failing.store(true, Ordering::SeqCst);
    let out = inv.run().expect("an outcome, not an error");
    assert_eq!(out.status, "inconclusive");
    assert!(out.identified.is_empty());
    let has = |s: &str| out.reasons.iter().any(|r| r == s);
    assert!(
        has("identifiability could not be checked at the final estimate: diverged"),
        "{:?}",
        out.reasons
    );
    assert!(
        has("guardrail: claimed identified but identifiability was not checked: a"),
        "{:?}",
        out.reasons
    );
    assert!(
        !out.reasons
            .iter()
            .any(|r| r.starts_with("not identified by the rule") || r.contains("disagrees")),
        "{:?}",
        out.reasons
    );
}
