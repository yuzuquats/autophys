//! LOOP-PARITY / G8-FINISH: a run whose simulator always fails still ends with
//! an outcome. Each failing tool step is recorded as that step's result, and the
//! closing identifiability check names the failure as a reason.
use autophys::{
    agent::{ProposalRunner, ScriptedPolicy},
    data::{Dataset, Observation},
    project::Project,
    simulator::*,
};
use indexmap::IndexMap;
use serde_json::json;

#[test]
fn a_run_whose_simulator_always_fails_ends_with_an_outcome() {
    let sim = simulator(
        "fails",
        vec![ParamSpec::new("a", "", -1., 3.).unwrap()],
        IndexMap::new(),
        vec!["y".into()],
        "fails",
        |_, _, _| Err(SimulationError::Simulation("diverged".into())),
    )
    .unwrap();
    let mut project = Project::new("fails", sim);
    project.budgets.max_steps = 6;
    project.budgets.max_experiments = 0;
    let o = Observation::new(
        "e",
        json!({"kind":"custom","t":[0.,1.]}),
        vec![0., 1.],
        [("y".into(), vec![5.; 2])].into_iter().collect(),
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
    let out = inv.run().expect("an outcome, not an error");
    assert_eq!(out.status, "budget_exhausted");
    assert!(
        out.reasons
            .iter()
            .any(|r| r == "identifiability could not be checked at the final estimate: diverged"),
        "{:?}",
        out.reasons
    );
    assert!(out.identified.is_empty());
}
