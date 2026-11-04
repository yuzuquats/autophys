//! Numeric parity: private Python fixtures and every shared numerics case.
use autophys::{
    agent::{Policy, ScriptedPolicy, SequencePolicy},
    data::{Dataset, Observation},
    design::{self, Axis},
    fit::{FitOptions, fit},
    models,
    project::Project,
    sensitivity::{IdentifiabilityRule, analyze},
    simulator::*,
};
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
fn model(n: &str) -> FunctionSimulator {
    match n {
        "thermal" | "thermal_rc" => models::thermal_rc(),
        "oscillator" => models::oscillator(),
        "battery" | "battery_ecm" => models::battery_ecm(),
        _ => panic!("unknown conformance model {n}"),
    }
}
fn parse<T: serde::de::DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(v.clone()).unwrap()
}
fn observations(v: &Value) -> Vec<Observation> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|v| Observation::from_dict(v.clone()).unwrap())
        .collect()
}
fn numeric(a: &Value, e: &Value, rtol: f64, atol: f64, path: &str) {
    match (a, e) {
        (Value::Number(a), Value::Number(e)) => {
            let (a, e) = (a.as_f64().unwrap(), e.as_f64().unwrap());
            assert!(
                (a - e).abs() <= atol + rtol * e.abs(),
                "{path}: got {a}, expected {e} (rtol {rtol}, atol {atol})"
            );
        }
        (Value::Array(a), Value::Array(e)) => {
            assert_eq!(a.len(), e.len(), "{path}: array lengths");
            for (i, (a, e)) in a.iter().zip(e).enumerate() {
                numeric(a, e, rtol, atol, &format!("{path}/{i}"));
            }
        }
        (Value::Object(a), Value::Object(e)) => {
            for (k, e) in e {
                numeric(
                    a.get(k).unwrap_or_else(|| panic!("{path}: missing {k}")),
                    e,
                    rtol,
                    atol,
                    &format!("{path}/{k}"),
                );
            }
        }
        _ => assert_eq!(a, e, "{path}"),
    }
}
fn rel(a: &Value, e: &Value) -> f64 {
    match (a, e) {
        (Value::Number(a), Value::Number(e)) => {
            let (a, e) = (a.as_f64().unwrap(), e.as_f64().unwrap());
            if a == e {
                0.
            } else {
                (a - e).abs() / e.abs().max(f64::MIN_POSITIVE)
            }
        }
        (Value::Array(a), Value::Array(e)) => {
            a.iter().zip(e).map(|(a, e)| rel(a, e)).fold(0., f64::max)
        }
        (Value::Object(a), Value::Object(e)) => {
            e.iter().map(|(k, e)| rel(&a[k], e)).fold(0., f64::max)
        }
        _ => 0.,
    }
}
fn rule_compare(actual: &Value, r: &Value, path: &str) {
    let e = &r["value"];
    if r["set"] == true {
        let mut a: Vec<_> = actual
            .as_array()
            .unwrap()
            .iter()
            .map(Value::to_string)
            .collect();
        let mut e: Vec<_> = e.as_array().unwrap().iter().map(Value::to_string).collect();
        a.sort();
        e.sort();
        a.dedup();
        e.dedup();
        assert_eq!(a, e, "{path}");
    } else if r["exact"] == true {
        assert_eq!(actual, e, "{path}");
    } else if r["up_to_sign"] == true {
        let neg = fn_neg(actual);
        let max = error_ratio(actual, e, r);
        let negmax = error_ratio(&neg, e, r);
        assert!(
            max.min(negmax) <= 1.,
            "{path}: neither sign satisfies tolerance, ratios {max}, {negmax}"
        );
    } else {
        numeric(
            actual,
            e,
            r["rtol"].as_f64().unwrap_or(0.),
            r["atol"].as_f64().unwrap_or(0.),
            path,
        );
    }
}
fn fn_neg(a: &Value) -> Value {
    match a {
        Value::Number(n) => json!(-n.as_f64().unwrap()),
        Value::Array(a) => json!(a.iter().map(fn_neg).collect::<Vec<_>>()),
        Value::Object(a) => Value::Object(a.iter().map(|(k, v)| (k.clone(), fn_neg(v))).collect()),
        _ => a.clone(),
    }
}
fn error_ratio(a: &Value, e: &Value, r: &Value) -> f64 {
    match (a, e) {
        (Value::Number(a), Value::Number(e)) => {
            let (a, e) = (a.as_f64().unwrap(), e.as_f64().unwrap());
            let tol = r["atol"].as_f64().unwrap_or(0.) + r["rtol"].as_f64().unwrap_or(0.) * e.abs();
            if a == e { 0. } else { (a - e).abs() / tol }
        }
        (Value::Array(a), Value::Array(e)) if a.len() == e.len() => a
            .iter()
            .zip(e)
            .map(|(a, e)| error_ratio(a, e, r))
            .fold(0., f64::max),
        (Value::Object(a), Value::Object(e)) => e
            .iter()
            .map(|(k, e)| error_ratio(&a[k], e, r))
            .fold(0., f64::max),
        _ => f64::INFINITY,
    }
}
#[test]
fn python_examples() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../src/models/fixtures/python.json")).unwrap();
    for c in fixtures.as_array().unwrap() {
        let name = c["model"].as_str().unwrap();
        let sim = model(name);
        let p: Params = parse(&c["theta"]);
        let obs = observations(&c["observations"]);
        let noise = Dataset::new(obs.clone()).unwrap().noise();
        let mut simerr = 0_f64;
        for v in c["simulate"].as_array().unwrap() {
            let a = json!(sim.simulate(&p, &v["settings"], FIT_OPTIONS).unwrap());
            numeric(&a, &v["trajectory"], 1e-6, 1e-9, name);
            simerr = simerr.max(rel(&a, &v["trajectory"]));
        }
        let f = fit(
            &sim,
            &obs,
            &FitOptions {
                initial: Some(parse(&c["initial"])),
                n_starts: 0,
                ..Default::default()
            },
        )
        .unwrap();
        let fitv = json!({"params":f.params,"loss":f.loss,"chi2_per_n":f.chi2_per_n});
        let fexp = json!({"params":c["fit"]["params"],"loss":c["fit"]["loss"],"chi2_per_n":c["fit"]["chi2_per_n"]});
        numeric(&fitv, &fexp, 1e-6, 1e-9, name);
        assert_eq!(json!(f.at_bounds), c["fit"]["at_bounds"]);
        assert_eq!(f.success, c["fit"]["success"]);
        let (s, j) = analyze(&sim, &p, &obs, Default::default(), None).unwrap();
        numeric(
            &json!(s.singular_values),
            &c["analyze"]["singular_values"],
            1e-6,
            1e-8,
            name,
        );
        assert_eq!(json!(s.identified), c["analyze"]["identified"]);
        assert_eq!(json!(s.non_identified), c["analyze"]["non_identified"]);
        let rank =
            design::rank_experiments(&sim, &p, &obs, &noise, None, "min_eig", Some(&j)).unwrap();
        let order: Vec<_> = rank.iter().map(|c| c.experiment.clone()).collect();
        let exporder: Vec<_> = c["rank"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["experiment"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(order, exporder, "{name}: ranking decision");
        let scores: Vec<_> = rank
            .iter()
            .map(|c| json!({"min_eig":c.min_eig,"d_opt":c.d_opt,"min_eig_gain":c.min_eig_gain}))
            .collect();
        let exp:Vec<_>=c["rank"].as_array().unwrap().iter().map(|c|json!({"min_eig":c["min_eig"],"d_opt":c["d_opt"],"min_eig_gain":c["min_eig_gain"]})).collect();
        numeric(&json!(scores), &json!(exp), 1e-6, 1e-8, name);
        let oi = &c["outlook_inputs"];
        let (grid, score, after) = design::outlook(
            &sim,
            &p,
            &obs,
            &noise,
            &oi["settings"],
            &parse(&oi["edit"]),
            "min_eig",
            3,
            Some(&j),
        )
        .unwrap();
        let out = json!({"grid":grid,"score":score,"after":after});
        numeric(&out, &c["outlook"], 1e-6, 1e-8, name);
        numeric(
            &json!(autophys::fit::lhs_starts(&sim, 4, 0)),
            &c["lhs"],
            1e-14,
            1e-14,
            "lhs",
        );
        let settings = &c["observations"][0]["settings"];
        let syn = autophys::synthetic::observe(
            &sim,
            &p,
            settings,
            &autophys::synthetic::NoiseModel::new(noise),
            &mut autophys::fit::rng::NumpyRng::new(0),
            "train",
            None,
        )
        .unwrap();
        numeric(&json!(syn.y), &c["synthetic"]["y"], 1e-6, 1e-9, "synthetic");
        eprintln!(
            "{name}: simulate={simerr:.6e} fit={:.6e} analyze={:.6e} rank={:.6e} outlook={:.6e}",
            rel(&fitv, &fexp),
            rel(&json!(s.singular_values), &c["analyze"]["singular_values"]),
            rel(&json!(scores), &json!(exp)),
            rel(&out, &c["outlook"])
        );
    }
}
fn walk(p: &Path, files: &mut Vec<PathBuf>) {
    if !p.exists() {
        return;
    }
    for e in std::fs::read_dir(p).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            walk(&p, files);
        } else if p.extension().is_some_and(|e| e == "json") {
            files.push(p);
        }
    }
}
fn case(c: &Value) -> Value {
    assert_eq!(c["format"], 1);
    let mut sim = model(c["model"].as_str().unwrap());
    let i = &c["inputs"];
    if let Some(specs) = i["params"].as_object() {
        let mut p = IndexMap::new();
        for (k, v) in specs {
            p.insert(
                k.clone(),
                ParamSpec::new(
                    k,
                    v["unit"].as_str().unwrap_or(""),
                    v["lo"].as_f64().unwrap(),
                    v["hi"].as_f64().unwrap(),
                )
                .unwrap(),
            );
        }
        sim.params = p;
    }
    if let Some(fixed) = i["fixed"].as_object() {
        let mut p = Params::new();
        for (k, v) in fixed {
            if sim.params.contains_key(k) {
                p.insert(k.clone(), v.as_f64().unwrap());
            } else {
                for s in sim.experiments.values_mut() {
                    s[k] = v.clone();
                }
            }
        }
        if !p.is_empty() {
            sim = sim.with_fixed(p).unwrap();
        }
    }
    if let Some(catalog) = i["catalog"].as_object() {
        sim.experiments = catalog
            .iter()
            .map(|(k, v)| (k.clone(), v.get("settings").unwrap_or(v).clone()))
            .collect();
    }
    let options = if i["options"].is_object() {
        parse(&i["options"])
    } else {
        FIT_OPTIONS
    };
    let obs = if i["observations"].is_array() {
        observations(&i["observations"])
    } else {
        vec![]
    };
    let p = if i["theta"].is_object() {
        parse(&i["theta"])
    } else {
        Params::new()
    };
    let noise = if i["noise"].is_object() {
        parse(&i["noise"])
    } else {
        Dataset::new(obs.clone()).unwrap().noise()
    };
    match c["op"].as_str().unwrap() {
        "simulate" => {
            let mut settings = if i["settings"].is_object() {
                i["settings"].clone()
            } else {
                sim.experiment(&i["experiment"]).unwrap()
            };
            if i["t"].is_array() {
                settings["t"] = i["t"].clone();
            }
            let y = sim.simulate(&p, &settings, options).unwrap();
            let mut v = json!(y);
            v["trajectory"] = json!(y);
            v["y"] = json!(
                y.iter()
                    .filter(|(k, _)| k.as_str() != "t")
                    .collect::<IndexMap<_, _>>()
            );
            v
        }
        "fit" => json!(
            fit(
                &sim,
                &obs,
                &FitOptions {
                    starts: Some(parse(&i["starts"])),
                    n_starts: 0,
                    loss: i["loss"].as_str().unwrap_or("linear").into(),
                    f_scale: i["f_scale"].as_f64().unwrap_or(1.),
                    options,
                    ..Default::default()
                }
            )
            .unwrap()
        ),
        "analyze" => {
            let rule: IdentifiabilityRule = if i["rule"].is_object() {
                parse(&i["rule"])
            } else {
                Default::default()
            };
            let (s, j) = analyze(&sim, &p, &obs, rule, None).unwrap();
            let mut v = s.to_dict();
            v["jacobian"] = json!(
                (0..j.nrows())
                    .map(|i| (0..j.ncols()).map(|k| j[(i, k)]).collect::<Vec<_>>())
                    .collect::<Vec<_>>()
            );
            v
        }
        "rank" => {
            let candidates: Option<Vec<String>> = i.get("candidates").map(parse);
            let r = design::rank_experiments(
                &sim,
                &p,
                &obs,
                &noise,
                candidates.as_deref(),
                i["criterion"].as_str().unwrap_or("min_eig"),
                None,
            )
            .unwrap();
            json!({"ranking":r,"experiments":r.iter().map(|c|&c.experiment).collect::<Vec<_>>(),"order":r.iter().map(|c|&c.experiment).collect::<Vec<_>>()})
        }
        "outlook" => {
            let settings = if i["settings"].is_object() {
                i["settings"].clone()
            } else {
                sim.experiment(&i["experiment"]).unwrap()
            };
            let f0 = design::base_information(&sim, &p, &obs, None).unwrap();
            let which = i["criterion"].as_str().unwrap_or("min_eig");
            let axes: Vec<Axis> = parse(&i["axes"]);
            let grid = design::outlook_axes(&sim, &p, &f0, &noise, &settings, axes, which).unwrap();
            let mut v = json!(grid);
            v["outlook"] = json!(grid);
            v["grid"] = json!(grid);
            v
        }
        "run" => run_case(&sim, i, c["policy"].as_str()),
        op => panic!("unsupported numerics op {op}"),
    }
}
fn run_case(sim: &FunctionSimulator, i: &Value, policy: Option<&str>) -> Value {
    let temp = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
    let mut project = Project::new("conformance", sim.clone());
    if i["budgets"].is_object() {
        project.budgets = parse(&i["budgets"]);
    }
    if i["stop"].is_object() {
        project.stop = parse(&i["stop"]);
    }
    if i["stop_rules"].is_object() {
        project.stop = parse(&i["stop_rules"]);
    }
    project.noise.bias = "off".into();
    if i["initial"].is_object() {
        project.initial = parse(&i["initial"]);
    }
    let dataset = if i["dataset"].is_array() {
        observations(&i["dataset"])
    } else {
        observations(&i["dataset"]["observations"])
    };
    let ds = Dataset::new(dataset).unwrap();
    let workbook = client.project_with(project).unwrap();
    let policy: Box<dyn Policy> = if policy == Some("scripted") {
        Box::new(ScriptedPolicy::default())
    } else {
        Box::new(SequencePolicy::new(
            i["script"].as_array().unwrap().iter().map(|d| {
                if d.get("hypothesis").is_some() {
                    d.clone()
                } else {
                    json!(autophys::agent::Decision::new(
                        d["action"].as_str().unwrap(),
                        d.get("arguments").cloned().unwrap_or(json!({}))
                    ))
                }
            }),
        ))
    };
    let result_obs = i["runner"]["observations"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut queue: std::collections::VecDeque<_> = result_obs.into_iter().collect();
    let sim = sim.clone();
    let truth: Option<Params> = i["runner"]
        .get("theta")
        .or_else(|| i["runner"].get("truth"))
        .map(parse);
    let noise = ds.noise();
    let runner = move |name: &str, settings: &Value| -> Result<Observation> {
        if let Some(o) = queue.pop_front() {
            return Observation::from_dict(o);
        }
        if let Some(theta) = &truth {
            let mut y = sim.call(theta, settings, TRUTH_OPTIONS, false)?;
            let t = y.shift_remove("t").unwrap();
            return Observation::new(name, settings.clone(), t, y, noise.clone());
        }
        Err(SimulationError::Invalid(
            "deterministic runner exhausted".into(),
        ))
    };
    let mut inv = workbook
        .investigate_with(ds, Box::new(runner), policy, None, 0, "")
        .unwrap();
    let out = inv.run().unwrap();
    let decisions: Vec<_> = inv
        .records(Some("step"))
        .unwrap()
        .iter()
        .filter_map(|r| r.payload.get("decision").cloned())
        .collect();
    let mut v = out.to_dict();
    v["outcome"] = json!(out);
    v["decisions"] = json!(decisions);
    v["actions"] = json!(
        decisions
            .iter()
            .map(|d| d["action"].clone())
            .collect::<Vec<_>>()
    );
    v
}
#[test]
fn numerics_conformance() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/numerics");
    let mut files = vec![];
    walk(&root, &mut files);
    files.sort();
    if files.is_empty() {
        eprintln!("no shared numerics cases yet; private Python fixtures cover all three models");
        return;
    }
    for file in files {
        let c: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        let actual = case(&c);
        for (field, rule) in c["expect"].as_object().unwrap() {
            let a = actual
                .pointer(&format!("/{}", field.replace('.', "/")))
                .unwrap_or_else(|| panic!("{} missing result field {field}", file.display()));
            rule_compare(a, rule, &format!("{}:{field}", file.display()));
        }
    }
}

#[test]
fn python_scripted_runs() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../src/models/fixtures/python.json")).unwrap();
    for c in fixtures.as_array().unwrap() {
        let sim = model(c["model"].as_str().unwrap());
        let truth: Params = parse(&c["theta"]);
        let sigma: Params = parse(&c["observations"][0]["sigma"]);
        let mut p = Project::new("comparison", sim.clone());
        p.initial = parse(&c["initial"]);
        p.noise.bias = "off".into();
        p.budgets.max_experiments = 1;
        p.n_starts = 1;
        let runner = move |name: &str, settings: &Value| {
            let mut y = sim.call(&truth, settings, TRUTH_OPTIONS, false)?;
            let t = y.shift_remove("t").unwrap();
            Observation::new(name, settings.clone(), t, y, sigma.clone())
        };
        let temp = tempfile::tempdir().unwrap();
        let client = autophys::connect(Some(temp.path().to_str().unwrap())).unwrap();
        let wb = client.project_with(p).unwrap();
        let mut inv = wb
            .investigate(
                Dataset::new(observations(&c["run"]["dataset"])).unwrap(),
                runner,
                ScriptedPolicy::default(),
            )
            .unwrap();
        let out = inv.run().unwrap();
        assert_eq!(json!(out.status), c["run"]["status"], "{}", c["model"]);
        let decisions: Vec<_> = inv
            .records(Some("step"))
            .unwrap()
            .iter()
            .filter_map(|r| r.payload.get("decision"))
            .map(|d| json!({"action":d["action"],"arguments":d["arguments"]}))
            .collect();
        assert_eq!(json!(decisions), c["run"]["decisions"], "{}", c["model"]);
        assert!(wb.verify().unwrap().ok);
    }
}
