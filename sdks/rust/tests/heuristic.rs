//! The heuristic fake reasoner and the planted case (Python reference:
//! `sdks/python/tests/test_research_planted.py`, `test_agent.py`).
use autophys::{
    agent::{ReasonLanePolicy, ScriptedPolicy, heuristic},
    playbook::load_playbook,
    synthetic::{self, case_project},
};
use serde_json::Value;

fn actions(
    case: &str,
    seed: u64,
    policy: Box<dyn autophys::agent::Policy>,
) -> (String, Vec<String>) {
    let (view, _) = synthetic::case(case, seed).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let wb = client.project_with(case_project(&view)).unwrap();
    let mut inv = wb
        .investigate_with(
            view.dataset.clone(),
            Box::new(view.runner),
            policy,
            None,
            seed,
            "",
        )
        .unwrap();
    let out = inv.run().unwrap();
    let steps = inv.record.records(Some("step")).unwrap();
    let acts = steps
        .iter()
        .map(|r| {
            r.payload["decision"]["action"]
                .as_str()
                .unwrap_or("")
                .to_string()
        })
        .collect();
    (out.status, acts)
}

fn fake(text: Option<&str>) -> Box<dyn autophys::agent::Policy> {
    let mut p = ReasonLanePolicy::new(heuristic::heuristic_reasoner());
    if let Some(text) = text {
        let dir = tempfile::tempdir().unwrap().keep();
        let path = dir.join("SKILL.md");
        std::fs::write(&path, text).unwrap();
        p.playbook = load_playbook(&path).unwrap();
    }
    Box::new(p)
}

#[test]
fn default_settings_mirror_the_scripted_baseline() {
    for case in ["thermal", "oscillator-free-only", "battery"] {
        let scripted = actions(case, 0, Box::new(ScriptedPolicy::default()));
        assert_eq!(actions(case, 0, fake(None)), scripted, "{case}");
    }
}

#[test]
fn settings_steer_the_fake_reasoner_on_the_planted_case() {
    let default = String::from_utf8(load_playbook("default").unwrap().data().unwrap()).unwrap();
    let base = default.trim_end_matches('\n');
    let never = format!("{base}\n\nSettings:\n- compare_variants: never\n");
    let fix = format!("{base}\n\nSettings:\n- compare_variants: on_misfit\n");
    let (status, acts) = actions("battery-biased", 0, fake(Some(&never)));
    assert_eq!(status, "inconclusive");
    assert!(!acts.iter().any(|a| a == "compare_models"));
    let (status, acts) = actions("battery-biased", 0, fake(Some(&fix)));
    assert_eq!(status, "validated");
    assert!(acts.iter().any(|a| a == "compare_models"));
}

#[test]
fn the_overclaiming_fake_is_overruled_by_the_guardrail() {
    let mut p = ReasonLanePolicy::new(autophys::reasoner::FakeReasoner::new(|m: &[Value]| {
        heuristic::overclaiming_responder(m).unwrap()
    }));
    p.effort = None;
    let (view, _) = synthetic::case("thermal-short-only", 0).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let wb = client.project_with(case_project(&view)).unwrap();
    let mut inv = wb
        .investigate_with(
            view.dataset.clone(),
            Box::new(view.runner),
            Box::new(p),
            None,
            0,
            "",
        )
        .unwrap();
    let out = inv.run().unwrap();
    assert_eq!(out.status, "inconclusive");
    assert_eq!(out.guardrail_overrides, ["R"]);
}
