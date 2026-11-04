use autophys::{Display, models, project::Project, simulator::*};
use serde_json::json;
use std::sync::{Arc, Mutex};
fn toy() -> FunctionSimulator {
    simulator(
        "toy",
        vec![ParamSpec::new("p", "", 1., 9.).unwrap()],
        [(
            "pulse".into(),
            json!({"kind":"pulse","duration":2.,"rate":1.}),
        )]
        .into_iter()
        .collect(),
        vec!["y".into()],
        "toy",
        |p, _, _| {
            Ok([
                ("t".into(), vec![0., 1., 2.]),
                ("y".into(), vec![p["p"]; 3]),
                ("drive".into(), vec![0., 1., 0.]),
            ]
            .into_iter()
            .collect())
        },
    )
    .unwrap()
}
fn declaration() -> Display {
    Display { channels: json!({"y":{"label":"Y","unit":"V","role":"output"},"drive":{"label":"Drive","unit":"A","role":"input"}}).as_object().unwrap().clone(), ..Default::default() }
}
#[test]
fn golden_manifests() {
    for (sim, bytes, hash) in [
        (
            models::battery_ecm(),
            include_bytes!("../src/models/fixtures/display/battery_ecm.json").as_slice(),
            "e1aea0cbe6f8065c8b642d4aeb895509290ae3b30eb6496373c2a17d70c3f5fd",
        ),
        (
            models::oscillator(),
            include_bytes!("../src/models/fixtures/display/oscillator.json").as_slice(),
            "824b945f5f05e47112940e0dfddbafc42a05e6bd0e3f40e9759b3b91ef3abe96",
        ),
        (
            models::thermal_rc(),
            include_bytes!("../src/models/fixtures/display/thermal_rc.json").as_slice(),
            "e19385e061d7fa85fd0fffc66a21c549976d337d9098606c7105ffd5d0442e11",
        ),
    ] {
        let project = Project::new(sim.name.clone(), sim);
        let display = project.simulator.display().unwrap();
        let body = display.canonical(&project).unwrap();
        assert_eq!(body, bytes, "{}", project.name);
        assert_eq!(autophys::sha256_hex([body.as_slice()]), hash);
        assert_eq!(display.digest(&project).unwrap(), format!("sha256:{hash}"));
        assert!(!body.ends_with(b"\n"));
        assert_eq!(project.simulator.calls(), 0);
    }
}
#[test]
fn initial_interpolation_budget_and_identity() {
    let plain = toy();
    let baseline = Project::new("toy", plain.clone());
    let sim = plain.with_display(declaration()).unwrap();
    let mut project = Project::new("toy", sim);
    assert_eq!(baseline.config(), project.config());
    assert_eq!(baseline.config_version(), project.config_version());
    assert_eq!(
        baseline.simulator.source_hash(),
        project.simulator.source_hash()
    );
    assert_eq!(project.initial_value("p"), 3.);
    project.initial.insert("p".into(), 4.);
    let budget = Arc::new(Mutex::new(CallBudget::new(Some(0))));
    project.simulator.set_budget(Some(budget.clone()));
    let body = project
        .simulator
        .display()
        .unwrap()
        .to_dict(&project)
        .unwrap();
    assert_eq!(
        body["settings"]["kind"],
        json!({"label":"kind","unit":"","role":"other"})
    );
    let preview = &body["experiments"]["pulse"]["preview"];
    assert_eq!(preview["t"].as_array().unwrap().len(), 64);
    assert_eq!(preview["t"][1], json!(0.031746));
    assert_eq!(preview["u"]["drive"][1], json!(0.031746));
    assert_eq!(preview["u"]["drive"][32], json!(0.984127));
    let result = project
        .simulator
        .call(
            &[("p".into(), 4.)].into_iter().collect(),
            &json!("pulse"),
            FIT_OPTIONS,
            false,
        )
        .unwrap();
    assert_eq!(
        result.keys().map(String::as_str).collect::<Vec<_>>(),
        ["t", "y"]
    );
    assert_eq!(result["y"], vec![4.; 3]);
    assert_eq!(result.u["drive"], vec![0., 1., 0.]);
    assert_eq!(project.simulator.calls(), 0);
    assert_eq!(budget.lock().unwrap().used, 0);
}
#[test]
fn validates_at_attachment() {
    for (field, value) in [
        ("settings", json!({"unknown":{"role":"other"}})),
        ("settings", json!({"rate":{"role":"bad"}})),
        ("params", json!({"unknown":{}})),
        ("experiments", json!({"unknown":{}})),
        ("experiments", json!({"pulse":{"views":["frequency"]}})),
        ("channels", json!({"missing":{"role":"input"}})),
        ("channels", json!({"missing":{"role":"output"}})),
        ("channels", json!({"y":{"role":"input"}})),
        ("channels", json!({"t":{"role":"input"}})),
        ("channels", json!({"drive":{"role":"bad"}})),
    ] {
        let mut d = declaration();
        let map = value.as_object().unwrap().clone();
        match field {
            "settings" => d.settings = map,
            "params" => d.params = map,
            "experiments" => d.experiments = map,
            _ => d.channels = map,
        }
        assert!(toy().with_display(d).is_err(), "{field}: {value}");
    }
    let mut d = declaration();
    d.default_view = Some("unknown".into());
    assert!(toy().with_display(d).is_err());
    for values in [vec![1.], vec![f64::NAN; 3]] {
        let mut d = declaration();
        d.channels = json!({"input":{"role":"input"}})
            .as_object()
            .unwrap()
            .clone();
        d.inputs
            .insert("input".into(), Arc::new(move |_, _| Ok(values.clone())));
        assert!(toy().with_display(d).is_err());
    }
}
#[test]
fn preview_uses_initial_and_duration_fallback() {
    let sim = simulator(
        "initial",
        vec![ParamSpec::new("a", "", -2., 4.).unwrap()],
        [("e".into(), json!({"kind":"step"}))].into_iter().collect(),
        vec!["y".into()],
        "initial",
        |p, _, _| {
            Ok([
                ("t".into(), vec![0., 1.]),
                ("y".into(), vec![0.; 2]),
                ("drive".into(), vec![p["a"]; 2]),
            ]
            .into_iter()
            .collect())
        },
    )
    .unwrap()
    .with_display(declaration())
    .unwrap();
    let mut project = Project::new("initial", sim);
    assert_eq!(project.initial_value("a"), 1.);
    project.initial.insert("a".into(), 2.12345678);
    let data = project
        .simulator
        .display()
        .unwrap()
        .to_dict(&project)
        .unwrap();
    assert_eq!(
        data["experiments"]["e"]["preview"]["u"]["drive"],
        json!(vec![2.12346; 64])
    );
    assert_eq!(data["experiments"]["e"]["preview"]["t"][63], json!(1.));
}

#[test]
fn trajectory_mapping_wire_shape_and_implicit_outputs() {
    let sim = simulator(
        "implicit",
        vec![],
        [("e".into(), json!({"kind":"step"}))].into_iter().collect(),
        vec![],
        "implicit",
        |_, _, _| {
            Ok([
                ("t".into(), vec![0., 1.]),
                ("y".into(), vec![1., 2.]),
                ("drive".into(), vec![3., 4.]),
            ]
            .into_iter()
            .collect())
        },
    )
    .unwrap();
    let mut display = Display::default();
    display.channels = json!({"drive":{"role":"input"}})
        .as_object()
        .unwrap()
        .clone();
    let sim = sim.with_display(display).unwrap();
    let result = sim
        .call(&Params::new(), &json!("e"), FIT_OPTIONS, false)
        .unwrap();
    assert_eq!(
        result.keys().map(String::as_str).collect::<Vec<_>>(),
        ["t", "y"]
    );
    assert_eq!(result.u["drive"], vec![3., 4.]);
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(wire, json!({"t":[0.,1.],"y":[1.,2.]}));
    let restored: Trajectory = serde_json::from_value(wire).unwrap();
    assert!(restored.u.is_empty());
    assert_eq!(restored["y"], result["y"]);
}
