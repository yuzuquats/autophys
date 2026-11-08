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
        y["t"].to_vec(),
        [("T".into(), y["T"].to_vec())].into_iter().collect(),
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
    for every_fit in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
        let (mut p, ds, truth) = input();
        p.budgets.max_experiments = 1;
        p.analysis.identify_every_fit = every_fit;
        let sim = p.simulator.clone();
        let runner = move |name: &str, settings: &Value| {
            let y = sim.simulate(&truth, settings, FIT_OPTIONS)?;
            Observation::new(
                name,
                settings.clone(),
                y["t"].to_vec(),
                [("T".into(), y["T"].to_vec())].into_iter().collect(),
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
        // Each fit carries its identifiability check unless the project turns
        // that off; then the policy asks for it as a step of its own.
        let expected: &[&str] = if every_fit {
            &[
                "optimize_parameters",
                "rank_experiments",
                "request_experiment",
                "optimize_parameters",
                "validate_predictions",
                "stop",
            ]
        } else {
            &[
                "optimize_parameters",
                "analyze_sensitivity",
                "rank_experiments",
                "request_experiment",
                "optimize_parameters",
                "analyze_sensitivity",
                "validate_predictions",
                "stop",
            ]
        };
        assert_eq!(actions, expected, "identify_every_fit {every_fit}");
        let fits: Vec<_> = inv
            .records(Some("step"))
            .unwrap()
            .into_iter()
            .filter(|r| r.payload["decision"]["action"] == "optimize_parameters")
            .collect();
        assert_eq!(fits.len(), 2);
        for f in &fits {
            let ident = &f.payload["result"]["identification"];
            assert_eq!(ident.is_object(), every_fit, "{ident}");
            if every_fit {
                assert!(ident["identified"].is_array(), "{ident}");
                assert!(ident["marginal_log_std"].is_object(), "{ident}");
            }
        }
        assert!(wb.verify().unwrap().ok);
    }
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

#[test]
fn a_402_ends_the_investigation_on_the_first_call() {
    use autophys::{
        agent::ReasonLanePolicy,
        reasoner::{MUSE_SPARK, ModelSpec, ReasonOptions, ReasonReply, Reasoner},
        simulator::SimulationError,
    };
    struct Unbilled(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    impl Reasoner for Unbilled {
        fn complete(
            &mut self,
            _: &[Value],
            _: &ReasonOptions,
        ) -> autophys::simulator::Result<ReasonReply> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(SimulationError::BudgetError(
                "chat completions: HTTP 402 (billing_not_configured)".into(),
            ))
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let (p, ds, _) = input();
    let wb = client.project_with(p).unwrap();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let policy = ReasonLanePolicy::new(Unbilled(calls.clone()))
        .with_model_spec(ModelSpec::new("policy", "meta", MUSE_SPARK).unwrap())
        .unwrap();
    let mut inv = wb.investigate(ds, ProposalRunner, policy).unwrap();
    let err = inv.run().unwrap_err();
    assert!(matches!(err, autophys::Error::Budget(_)), "{err:?}");
    assert_eq!(err.status(), 402);
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "no second call"
    );
    let steps = inv.records(Some("step")).unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].payload["valid"], false);
    assert!(
        steps[0].payload["error"]
            .as_str()
            .unwrap()
            .starts_with("BudgetError: ")
    );
    let outcome = inv.records(Some("outcome")).unwrap().remove(0);
    assert_eq!(outcome.payload["status"], "failed");
    assert_eq!(
        outcome.payload["reasons"],
        json!(["billing: provider refused the call (HTTP 402)"])
    );
}
#[test]
fn a_bad_playbook_hash_reports_its_own_path() {
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let (p, _, _) = input();
    let wb = client.project_with(p).unwrap();
    let version = wb.config_versions().unwrap().remove(0).version;
    let meta = json!({"config_version": version, "playbook": {"name": "d", "version": "1", "sha256": "not-hex"}});
    match wb.create_investigation(meta, None) {
        Err(autophys::Error::Invalid { path, .. }) => assert_eq!(path, "payload.playbook.sha256"),
        other => panic!("{:?}", other.map(|_| ())),
    }
    match wb.create_investigation(json!({}), None) {
        Err(autophys::Error::Invalid { path, .. }) => assert_eq!(path, "project_id"),
        other => panic!("{:?}", other.map(|_| ())),
    }
}
#[test]
fn muse_policy_pins_playbook_and_retains_usage_on_invalid_replies_and_resume() {
    use autophys::{
        agent::ReasonLanePolicy,
        playbook::load_playbook,
        reasoner::{MUSE_SPARK, ModelSpec, ReasonOptions, ReasonReply, Reasoner},
    };
    struct Offline;
    impl Reasoner for Offline {
        fn complete(
            &mut self,
            _: &[Value],
            _: &ReasonOptions,
        ) -> autophys::simulator::Result<ReasonReply> {
            Ok(ReasonReply {
                content: json!("not JSON"),
                model: Some(MUSE_SPARK.into()),
                route: Some("meta".into()),
                usage: json!({"prompt_tokens":10,"completion_tokens":5}),
                elapsed_ms: Some(1.),
                replayed: true,
            })
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let (p, ds, _) = input();
    let wb = client.project_with(p).unwrap();
    let make = || {
        ReasonLanePolicy::new(Offline)
            .with_model_spec(ModelSpec::new("policy", "meta", MUSE_SPARK).unwrap())
            .unwrap()
    };
    let mut inv = wb.investigate(ds, ProposalRunner, make()).unwrap();
    let out = inv.run().unwrap();
    assert_eq!(out.status, "failed");
    assert_eq!(out.usage_total["calls"], 3);
    assert_eq!(out.usage_total["input_tokens"], 30);
    assert_eq!(out.usage_total["output_tokens"], 15);
    let playbook = load_playbook("default").unwrap();
    let head = inv.records(None).unwrap().remove(0);
    assert_eq!(head.payload["playbook"], playbook.metadata());
    assert_eq!(head.payload["price"]["model"], MUSE_SPARK);
    assert_eq!(
        wb.get_blob(&playbook.sha256).unwrap(),
        (playbook.data().unwrap(), "text/markdown".into())
    );
    let steps = inv.records(Some("step")).unwrap();
    assert!(steps.iter().all(|r| r.payload["valid"] == false
        && r.payload["replayed"] == true
        && r.payload["raw_output"] == "not JSON"
        && r.payload["usage"]["input_tokens"] == 10));
    let id = inv.id.clone();
    drop(inv);
    let mut resumed = wb.resume(&id, ProposalRunner, make()).unwrap();
    let next = resumed.run().unwrap();
    assert_eq!(next.usage_total["calls"], 6);
    assert_eq!(next.usage_total["input_tokens"], 60);
    assert!(wb.verify().unwrap().ok);
}

#[test]
fn core_finite_noise_and_fit_negative_inputs_before_simulation() {
    use autophys::fit::{fit,FitOptions};
    let (p,ds,truth)=input(); let train=ds.split("train");
    let calls=p.simulator.calls();
    for sigma in [f64::INFINITY,f64::NEG_INFINITY,f64::NAN,0.,-1.] {
        let mut q=p.clone();q.noise.sigma=Some([("T".into(),sigma)].into_iter().collect());
        assert!(q.validate().is_err(),"sigma {sigma}");
        let mut o=train[0].clone();o.sigma.insert("T".into(),sigma);
        assert!(o.validate().unwrap_err().to_string().contains("T"));
        assert!(fit(&p.simulator,&[o],&FitOptions {initial:Some(truth.clone()),n_starts:0,..Default::default()}).is_err());
    }
    let mut bad=vec![];
    let mut v=truth.clone();v.shift_remove("C");bad.push(v);
    let mut v=truth.clone();v.insert("extra".into(),1.);bad.push(v);
    for x in [-1.,f64::INFINITY,f64::NAN] {let mut v=truth.clone();v.insert("C".into(),x);bad.push(v);}
    for v in bad {assert!(fit(&p.simulator,&train,&FitOptions {initial:Some(v),n_starts:0,..Default::default()}).is_err());}
    assert!(fit(&p.simulator,&train,&FitOptions {n_starts:0,..Default::default()}).is_err());
    let mut missing=train[0].clone();for y in missing.y.values_mut() {y.fill(f64::NAN);}
    assert!(fit(&p.simulator,&[missing.clone()],&FitOptions {initial:Some(truth.clone()),n_starts:0,..Default::default()}).is_err());
    assert_eq!(p.simulator.calls(),calls);
    let temp=tempfile::tempdir().unwrap();let c=autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();let wb=c.project_with(p.clone()).unwrap();
    assert!(wb.investigate(Dataset::new([missing]).unwrap(),ProposalRunner,ScriptedPolicy::default()).is_err());
    assert!(wb.investigations().unwrap().is_empty());
    assert!(fit(&p.simulator,&train,&FitOptions {initial:Some(truth),n_starts:0,..Default::default()}).unwrap().n>0);
}
#[test]
fn core_validation_requires_finite_samples() {
 for kind in ["absent","empty","missing","partial","normal"] {
  // Same seed/settings as Python test_validation_requires_usable_evidence.
  // Short training barely identifies R; a long extrapolation need not validate.
  let (view, _) = autophys::synthetic::thermal_case(0, 2, 0., 0.).unwrap();
  let mut p = Project::new("core", view.simulator);
  p.initial = [("C".into(), 500.), ("R".into(), 2.)].into_iter().collect();
  p.noise.bias = "off".into();
  let mut obs=view.dataset.split("train");let mut val=view.dataset.split("validation")[0].clone();
  if kind=="empty" {val.t.clear();for y in val.y.values_mut(){y.clear();}}
  if kind=="missing" {for y in val.y.values_mut(){y.fill(f64::NAN);}}
  if kind=="partial" {for y in val.y.values_mut(){for i in (0..y.len()).step_by(2){y[i]=f64::NAN;}}}
  if kind!="absent" {obs.push(val.clone());}
  let temp=tempfile::tempdir().unwrap();let c=autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();let wb=c.project_with(p).unwrap();
  let mut inv=wb.investigate(Dataset::new(obs).unwrap(),ProposalRunner,ScriptedPolicy::default()).unwrap();
  inv.tool_optimize_parameters(None,"linear").unwrap();
  let calls = inv.project.simulator.calls();
  let out=inv.tool_validate_predictions().unwrap();
  eprintln!("validation {kind}: {out}");
  if ["absent","empty","missing"].contains(&kind) {
   assert_eq!(out,json!({"available":false,"passed":false}),"{kind}");
   assert_eq!(inv.project.simulator.calls(), calls);
  } else {
   assert_eq!(out["available"],true);assert_eq!(out["passed"],true,"{kind}: {out}");
   assert_eq!(out["n"],val.n_samples());assert!(val.n_samples()>0);
   assert!(out["chi2_per_n"].as_f64().unwrap() < 2.);
  }
  assert!(wb.verify().unwrap().ok);
 }
}
#[test]
fn core_validation_rejects_unsupported_long_extrapolation() {
    for partial in [false, true] {
        let (p, ds, _) = input();
        let mut observations = ds.split("train");
        let mut val = ds.split("validation")[0].clone();
        if partial {
            for y in val.y.values_mut() {
                for i in (0..y.len()).step_by(2) { y[i] = f64::NAN; }
            }
        }
        let n = val.n_samples();
        observations.push(val);
        let temp = tempfile::tempdir().unwrap();
        let c = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
        let wb = c.project_with(p).unwrap();
        let mut inv = wb.investigate(Dataset::new(observations).unwrap(), ProposalRunner, ScriptedPolicy::default()).unwrap();
        inv.tool_optimize_parameters(Some(0), "linear").unwrap();
        let out = inv.tool_validate_predictions().unwrap();
        eprintln!("long extrapolation partial={partial}: {out}");
        assert_eq!(out["available"], true);assert_eq!(out["passed"], false);
        assert_eq!(out["n"], n);assert!(out["chi2_per_n"].as_f64().unwrap() > 2.);
        assert!(wb.verify().unwrap().ok);
    }
}
#[test]
fn core_owned_and_public_configuration_drift() {
 let (mut p,ds,_)=input();let original=p.clone();
 let temp=tempfile::tempdir().unwrap();let c=autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();let wb=c.project_with(p.clone()).unwrap();
 let mut inv=wb.investigate(ds,ProposalRunner,script(&[("request_experiment",json!({"experiment":"step_long"}))])).unwrap();
 p.initial.insert("C".into(),600.); // retained original cannot mutate the owned configuration
 assert_eq!(inv.project.config_version(),original.config_version());
 let pid=inv.run().unwrap().proposal_id.unwrap();
 let before=inv.records(None).unwrap().len();let calls=inv.project.simulator.calls();
 inv.project.budgets.max_steps+=1;
 assert!(inv.run().unwrap_err().to_string().contains("pinned"));
 assert!(inv.approve(&pid,"test",None).unwrap_err().to_string().contains("pinned"));
 let o=inv.dataset.split("train")[0].clone();
 assert!(inv.attach_data(&pid,o).unwrap_err().to_string().contains("pinned"));
 assert_eq!(inv.records(None).unwrap().len(),before);assert_eq!(inv.project.simulator.calls(),calls);
 assert!(c.project_with(inv.project.clone()).unwrap().resume(&inv.id,ProposalRunner,ScriptedPolicy::default()).is_err());
 assert!(original.simulator.simulate(&original.initial,&original.simulator.experiment(&json!("step_short")).unwrap(),FIT_OPTIONS).is_ok());
}
