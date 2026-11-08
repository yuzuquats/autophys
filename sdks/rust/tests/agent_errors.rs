//! G8-FINISH / LOOP-PARITY: when the simulator fails after the last good fit,
//! each failing tool step is that step's result, and the closing
//! identifiability check names the failure as a reason instead of ending the
//! run with an error and no outcome.
use autophys::{
    agent::{ProposalRunner, ScriptedPolicy},
    data::{Dataset, Observation},
    project::Project,
    simulator::*,
};
use indexmap::IndexMap;
use serde_json::json;
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
