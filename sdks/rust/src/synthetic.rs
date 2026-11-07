//! Synthetic data; truth and held-out test measurements stay in the evaluator.
use crate::{
    agent::Runner,
    data::{Dataset, Observation},
    fit::rng::NumpyRng,
    models,
    simulator::*,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NoiseModel {
    pub sigma: Params,
    #[serde(default)]
    pub bias: Params,
    #[serde(default)]
    pub missing_fraction: f64,
}
impl NoiseModel {
    pub fn new(sigma: Params) -> Self {
        Self {
            sigma,
            bias: Params::new(),
            missing_fraction: 0.,
        }
    }
}
pub fn observe(
    sim: &FunctionSimulator,
    truth: &Params,
    experiment: &Value,
    noise: &NoiseModel,
    rng: &mut NumpyRng,
    split: &str,
    name: Option<&str>,
) -> Result<Observation> {
    let settings = sim.experiment(experiment)?;
    let out = sim.call(truth, &settings, TRUTH_OPTIONS, false)?;
    let mut y = IndexMap::new();
    for (ch, values) in out.iter().filter(|(k, _)| k.as_str() != "t") {
        let sigma = *noise
            .sigma
            .get(ch)
            .ok_or_else(|| invalid(format!("missing noise sigma for {ch}")))?;
        let mut v: Vec<_> = values
            .iter()
            .map(|x| x + rng.normal() * sigma + noise.bias.get(ch).copied().unwrap_or(0.))
            .collect();
        if noise.missing_fraction > 0. {
            for (i, x) in v.iter_mut().enumerate() {
                let drop = rng.uniform() < noise.missing_fraction;
                if i != 0 && drop {
                    *x = f64::NAN;
                }
            }
        }
        y.insert(ch.clone(), v);
    }
    let name = name
        .map(String::from)
        .or_else(|| experiment.as_str().map(String::from))
        .unwrap_or_else(|| settings["kind"].as_str().unwrap_or("").into());
    let mut o = Observation::new(name, settings, out["t"].clone(), y, noise.sigma.clone())?;
    o.split = split.into();
    o.source = "synthetic".into();
    o.validate()?;
    Ok(o)
}
pub struct SyntheticRunner {
    sim: FunctionSimulator,
    truth: Params,
    noise: NoiseModel,
    rng: NumpyRng,
}
impl SyntheticRunner {
    pub fn new(sim: FunctionSimulator, truth: Params, noise: NoiseModel, seed: u64) -> Self {
        Self {
            sim,
            truth,
            noise,
            rng: NumpyRng::new(seed),
        }
    }
    pub fn run(&mut self, experiment: &Value) -> Result<Observation> {
        observe(
            &self.sim,
            &self.truth,
            experiment,
            &self.noise,
            &mut self.rng,
            "train",
            None,
        )
    }
}
impl Runner for SyntheticRunner {
    fn kind(&self) -> &str {
        "synthetic"
    }
    fn run(&mut self, experiment: &str, _: &Value) -> Result<Observation> {
        self.run(&json!(experiment))
    }
}
pub struct CaseView {
    pub name: String,
    pub simulator: FunctionSimulator,
    pub dataset: Dataset,
    pub runner: SyntheticRunner,
    pub max_experiments: usize,
    pub candidates: Option<Vec<String>>,
    /// MQ-5: the case's test-hour budget and costed catalog, when it has one.
    pub max_test_hours: Option<f64>,
    pub catalog: Option<IndexMap<String, crate::project::CatalogEntry>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evaluator {
    pub case: String,
    pub truth: Params,
    pub test: Vec<Observation>,
    pub combos: IndexMap<String, Params>,
    pub expected_non_identified: BTreeSet<String>,
    #[serde(default)]
    pub note: String,
}
impl Evaluator {
    pub fn combo_value(&self, p: &Params, combo: &str) -> f64 {
        self.combos[combo]
            .iter()
            .map(|(k, e)| p[k].powf(*e))
            .product()
    }
    pub fn relative_errors(&self, p: &Params) -> Params {
        self.combos
            .keys()
            .map(|k| {
                (
                    k.clone(),
                    (self.combo_value(p, k) / self.combo_value(&self.truth, k) - 1.).abs(),
                )
            })
            .collect()
    }
    pub fn test_rmse(&self, sim: &FunctionSimulator, p: &Params) -> Result<f64> {
        let params = sim.params.keys().map(|k| (k.clone(), p[k])).collect();
        let (mut sq, mut n) = (0., 0usize);
        for o in &self.test {
            let pred = sim.call(&params, &o.settings, FIT_OPTIONS, false)?;
            for (ch, y) in &o.y {
                if pred[ch].len() != y.len() {
                    return Err(invalid("test prediction shape mismatch"));
                }
                for (y, f) in y.iter().zip(&pred[ch]) {
                    if y.is_finite() {
                        sq += (y - f).powi(2);
                        n += 1;
                    }
                }
            }
        }
        Ok((sq / n.max(1) as f64).sqrt())
    }
    pub fn diagnosis_correct(&self, non: &BTreeSet<String>) -> bool {
        *non == self.expected_non_identified
    }
    /// Harness-only truth publication. Call after `inv.run()`, as in Python.
    /// Ordering and idempotency are enforced by the shared record store.
    pub fn reveal(&self, inv: &crate::agent::Investigation) -> crate::Result<crate::Appended> {
        let out = inv
            .outcome
            .as_ref()
            .ok_or_else(|| crate::Error::BadRequest("reveal requires an outcome".into()))?;
        let estimate = &out.estimate;
        let finite = |x: f64| -> crate::Result<f64> {
            if x.is_finite() {
                Ok(x)
            } else {
                Err(crate::Error::BadRequest(
                    "reveal values must be finite numbers".into(),
                ))
            }
        };
        for x in self.truth.values().chain(estimate.values()) {
            finite(*x)?;
        }
        let mut quantities = vec![];
        for (name, powers) in &self.combos {
            if !powers.keys().all(|p| estimate.contains_key(p)) {
                continue;
            }
            if !powers.keys().all(|p| self.truth.contains_key(p)) {
                return Err(crate::Error::BadRequest(
                    "reveal combination has no truth".into(),
                ));
            }
            let truth = finite(self.combo_value(&self.truth, name))?;
            let value = finite(self.combo_value(estimate, name))?;
            let ratio = finite(value / truth)?;
            let sigma = inv
                .current_sensitivity()
                .filter(|_| inv.fit.is_some())
                .and_then(|report| {
                    let gradient: Vec<f64> = report
                        .params
                        .iter()
                        .map(|p| {
                            let exponent = powers.get(p).copied().unwrap_or(0.);
                            if exponent == 0. {
                                return 0.;
                            }
                            let Some(spec) = inv.sim().params.get(p) else {
                                return f64::NAN;
                            };
                            if spec.log() {
                                exponent
                            } else {
                                let value = estimate.get(p).copied().unwrap_or(0.);
                                if value == 0. {
                                    f64::NAN
                                } else {
                                    exponent * spec.scale() / value
                                }
                            }
                        })
                        .collect();
                    let mut variance = 0.;
                    for direction in &report.directions {
                        let projection: f64 = report
                            .params
                            .iter()
                            .zip(&gradient)
                            .map(|(p, g)| g * direction.vector.get(p).copied().unwrap_or(f64::NAN))
                            .sum();
                        if (direction.kind == "structural" || direction.singular_value <= 0.)
                            && projection.abs() > 1e-8
                        {
                            return None;
                        }
                        if !projection.is_finite() {
                            return None;
                        }
                        if direction.singular_value > 0. {
                            variance += (projection / direction.singular_value).powi(2);
                        }
                    }
                    let candidate = ratio.abs() * variance.sqrt();
                    candidate.is_finite().then_some(candidate)
                });
            quantities.push(
                json!({"name":name,"truth":truth,"estimate":value,"ratio":ratio,
                "sigma_ratio":sigma,"within":(ratio-1.).abs() <= 0.10,
                "identifiable":!self.expected_non_identified.contains(name)}),
            );
        }
        inv.record.append(
            "reveal",
            json!({"source":"synthetic","tolerance":0.10,
            "truth":self.truth,"estimate":estimate,"quantities":quantities,
            "fit_id":inv.fit.as_ref().map(|_| inv.fit_id)}),
            None,
        )
    }
    pub fn save(&self, path: impl AsRef<std::path::Path>) -> Result<()> {
        std::fs::write(
            path,
            serde_json::to_vec(self).map_err(|e| invalid(e.to_string()))?,
        )
        .map_err(|e| invalid(e.to_string()))
    }
    pub fn load(path: impl AsRef<std::path::Path>) -> Result<Self> {
        serde_json::from_slice(&std::fs::read(path).map_err(|e| invalid(e.to_string()))?)
            .map_err(|e| invalid(e.to_string()))
    }
}
fn params(a: &[(&str, f64)]) -> Params {
    a.iter().map(|(k, v)| ((*k).into(), *v)).collect()
}
#[allow(clippy::too_many_arguments)]
fn build(
    name: &str,
    sim: FunctionSimulator,
    truth: Params,
    noise: NoiseModel,
    seed: u64,
    train: Vec<Value>,
    validation: Vec<Value>,
    test: Vec<Value>,
    max_experiments: usize,
    combos: IndexMap<String, Params>,
    expected: BTreeSet<String>,
    note: &str,
) -> Result<(CaseView, Evaluator)> {
    let mut rng = NumpyRng::from_entropy(&[seed, 1]);
    let mut observations = vec![];
    for e in &train {
        observations.push(observe(
            &sim,
            &truth,
            e,
            &noise,
            &mut rng,
            "train",
            e.as_str(),
        )?);
    }
    for e in &validation {
        observations.push(observe(
            &sim,
            &truth,
            e,
            &noise,
            &mut rng,
            "validation",
            e.as_str().or_else(|| e["name"].as_str()),
        )?);
    }
    let mut rng = NumpyRng::from_entropy(&[seed, 2]);
    let test = test
        .iter()
        .map(|e| {
            observe(
                &sim,
                &truth,
                e,
                &NoiseModel::new(noise.sigma.clone()),
                &mut rng,
                "test",
                e["name"].as_str(),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let runner = SyntheticRunner::new(sim.clone(), truth.clone(), noise, seed * 7919 + 3);
    Ok((
        CaseView {
            name: name.into(),
            simulator: sim,
            dataset: Dataset::new(observations)?,
            runner,
            max_experiments,
            candidates: None,
            max_test_hours: None,
            catalog: None,
        },
        Evaluator {
            case: name.into(),
            truth,
            test,
            combos,
            expected_non_identified: expected,
            note: note.into(),
        },
    ))
}
pub fn oscillator_case(
    seed: u64,
    max_experiments: usize,
    bias: f64,
    missing: f64,
) -> Result<(CaseView, Evaluator)> {
    let sim = models::oscillator();
    let truth = params(&[("m", 2.), ("c", 0.8), ("k", 15.)]);
    let ambiguous = max_experiments == 0;
    let combos = if ambiguous {
        [
            ("c/m".into(), params(&[("c", 1.), ("m", -1.)])),
            ("k/m".into(), params(&[("k", 1.), ("m", -1.)])),
        ]
        .into_iter()
        .collect()
    } else {
        truth
            .keys()
            .map(|k| (k.clone(), [(k.clone(), 1.)].into_iter().collect()))
            .collect()
    };
    let expected = if ambiguous {
        truth.keys().cloned().collect()
    } else {
        BTreeSet::new()
    };
    let mut noise = NoiseModel::new(params(&[("x", 0.01)]));
    if bias != 0. {
        noise.bias.insert("x".into(), bias);
    }
    noise.missing_fraction = missing;
    build(
        if ambiguous {
            "oscillator-free-only"
        } else {
            "oscillator"
        },
        sim,
        truth,
        noise,
        seed,
        vec![json!("free")],
        vec![
            json!({"name":"free_neg","kind":"free","x0":-0.08,"v0":0.05,"duration":10.,"rate":100.}),
        ],
        vec![
            json!({"name":"sine_0.3Hz","kind":"sine","amplitude":1.5,"freq":0.3,"duration":10.,"rate":100.}),
            json!({"name":"step_1N","kind":"step","amplitude":1.,"duration":10.,"rate":100.}),
        ],
        max_experiments,
        combos,
        expected,
        "A free response depends only on c/m and k/m: scaling m, c, k together is invisible.",
    )
}
pub fn thermal_case(
    seed: u64,
    max_experiments: usize,
    bias: f64,
    missing: f64,
) -> Result<(CaseView, Evaluator)> {
    let truth = params(&[("C", 500.), ("R", 2.)]);
    let short = max_experiments == 0;
    let combos = if short {
        [("C".into(), params(&[("C", 1.)]))].into_iter().collect()
    } else {
        truth
            .keys()
            .map(|k| (k.clone(), [(k.clone(), 1.)].into_iter().collect()))
            .collect()
    };
    let expected = if short {
        ["R".into()].into_iter().collect()
    } else {
        BTreeSet::new()
    };
    let mut noise = NoiseModel::new(params(&[("T", 0.05)]));
    if bias != 0. {
        noise.bias.insert("T".into(), bias);
    }
    noise.missing_fraction = missing;
    build(
        if short {
            "thermal-short-only"
        } else {
            "thermal"
        },
        models::thermal_rc(),
        truth,
        noise,
        seed,
        vec![json!("step_short")],
        vec![json!({"name":"step_short_5W","kind":"step","power":5.,"duration":120.,"rate":1.})],
        vec![
            json!({"name":"pulse_15W","kind":"pulse","power":15.,"on":900.,"duration":4000.,"rate":0.1}),
        ],
        max_experiments,
        combos,
        expected,
        "Over 120 s of a 1000 s time constant the response is nearly linear in t/C; R only bends it.",
    )
}
pub const BATTERY_TRUTH: [(&str, f64); 3] = [("R0", 0.025), ("R1", 0.045), ("C1", 1600.)];
/// MQ-5: a short pulse measures the ohmic drop and initial polarization slope.
pub fn battery_case(seed: u64, max_experiments: usize) -> Result<(CaseView, Evaluator)> {
    battery_case_with(seed, max_experiments, 0.)
}
/// [`battery_case`] with a constant voltage-sensor offset `bias` (V) added
/// to every measurement; a nonzero bias names the case `battery-biased`.
pub fn battery_case_with(
    seed: u64,
    max_experiments: usize,
    bias: f64,
) -> Result<(CaseView, Evaluator)> {
    let sim = models::battery_ecm();
    let truth = params(&BATTERY_TRUTH);
    let short = max_experiments == 0;
    let pulse = |name: &str, current: f64, on: f64| json!({"name":name,"kind":"pulse","current":current,"on":on,"duration":25.,"rate":32.,"capacity_ah":2.5,"soc0":0.9});
    let combos = if short {
        [
            ("R0".into(), params(&[("R0", 1.)])),
            ("C1".into(), params(&[("C1", 1.)])),
        ]
        .into_iter()
        .collect()
    } else {
        truth
            .keys()
            .map(|k| (k.clone(), [(k.clone(), 1.)].into_iter().collect()))
            .collect()
    };
    let expected = if short {
        ["R1".into()].into_iter().collect()
    } else {
        BTreeSet::new()
    };
    let catalog = sim
        .experiments
        .iter()
        .map(|(n, e)| {
            Ok((
                n.clone(),
                crate::project::CatalogEntry {
                    max_runs: None,
                    cost_hours: Some(1.0 + number(e, "duration")? / 3600.0),
                    ..Default::default()
                },
            ))
        })
        .collect::<Result<IndexMap<_, _>>>()?;
    let (mut view, ev) = build(
        if short {
            "battery-short-only"
        } else if bias != 0. {
            "battery-biased"
        } else {
            "battery"
        },
        sim,
        truth,
        NoiseModel {
            bias: if bias != 0. { params(&[("v", bias)]) } else { Params::new() },
            ..NoiseModel::new(params(&[("v", 0.002)]))
        },
        seed,
        vec![pulse("pulse_short", 2., 6.)],
        vec![pulse("pulse_short_1A", 1., 6.)],
        vec![
            json!({"name":"unseen_train","kind":"pulse_train","current":1.5,"on":40.,"off":60.,"duration":500.,"rate":1.,"capacity_ah":2.5,"soc0":0.9}),
        ],
        max_experiments,
        combos,
        expected,
        "A 6 s pulse against a 72 s RC time constant resolves the instantaneous I R0 drop and initial I/C1 slope; R1 needs a longer polarization and relaxation trace.",
    )?;
    view.max_test_hours = Some(3.);
    view.catalog = Some(catalog);
    Ok((view, ev))
}
/// The benchmark suite, in Python `CASES` order.
pub const CASES: [&str; 6] = [
    "oscillator-free-only",
    "oscillator",
    "thermal-short-only",
    "thermal",
    "battery-short-only",
    "battery",
];
/// Cases with a known strategy fix, used to check that the research loop
/// finds it; not in [`CASES`]. `battery-biased`: the voltage sensor reads
/// 10 mV high, so comparing the sensor-bias variant on a poor fit
/// validates the cell and never comparing ends inconclusive.
pub const PLANTED_CASES: [&str; 1] = ["battery-biased"];
/// The project a benchmark investigation of `view` runs under.
pub fn case_project(view: &CaseView) -> crate::project::Project {
    let mut p = crate::project::Project::new(view.name.clone(), view.simulator.clone());
    if let Some(catalog) = &view.catalog {
        p.catalog = catalog.clone();
    }
    p.budgets.max_experiments = view.max_experiments;
    p.budgets.max_test_hours = view.max_test_hours;
    p
}
/// A case by name, from [`CASES`] or [`PLANTED_CASES`].
pub fn case(name: &str, seed: u64) -> Result<(CaseView, Evaluator)> {
    match name {
        "battery-biased" => battery_case_with(seed, 2, 0.01),
        "oscillator" => oscillator_case(seed, 2, 0., 0.),
        "oscillator-free-only" => oscillator_case(seed, 0, 0., 0.),
        "thermal" => thermal_case(seed, 2, 0., 0.),
        "thermal-short-only" => thermal_case(seed, 0, 0., 0.),
        "battery" => battery_case(seed, 2),
        "battery-short-only" => battery_case(seed, 0),
        _ => Err(invalid("unknown synthetic case")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reproducible() {
        let sim = models::thermal_rc();
        let p = params(&[("C", 500.), ("R", 2.)]);
        let n = NoiseModel::new(params(&[("T", 0.05)]));
        let a = observe(
            &sim,
            &p,
            &json!("step_short"),
            &n,
            &mut NumpyRng::new(1),
            "train",
            None,
        )
        .unwrap();
        let b = observe(
            &sim,
            &p,
            &json!("step_short"),
            &n,
            &mut NumpyRng::new(1),
            "train",
            None,
        )
        .unwrap();
        assert_eq!(a.to_dict(), b.to_dict());
        assert_eq!(sim.calls(), 0);
    }
}
