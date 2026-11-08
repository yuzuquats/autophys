//! Synthetic data; truth and held-out test measurements stay in the evaluator.
use crate::{
    agent::Runner,
    data::{Dataset, Observation},
    fit::rng::NumpyRng,
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
    for (ch, values) in out.outputs().iter().filter(|(k, _)| k.as_str() != "t") {
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
    let mut o = Observation::new(name, settings, out["t"].to_vec(), y, noise.sigma.clone())?;
    o.split = split.into();
    o.source = "synthetic".into();
    o.validate()?;
    Ok(o)
}
/// Runs experiments for a case: on the hidden system (synthetic data), or
/// by replaying recorded runs, each at most once (a dataset backtest).
pub struct SyntheticRunner {
    source: RunnerSource,
}
enum RunnerSource {
    Generate {
        sim: FunctionSimulator,
        truth: Params,
        noise: NoiseModel,
        rng: NumpyRng,
    },
    Recorded(IndexMap<String, Observation>),
}
impl SyntheticRunner {
    pub fn new(sim: FunctionSimulator, truth: Params, noise: NoiseModel, seed: u64) -> Self {
        Self {
            source: RunnerSource::Generate {
                sim,
                truth,
                noise,
                rng: NumpyRng::new(seed),
            },
        }
    }
    /// Replays `runs` by experiment name; each run is returned once.
    pub fn recorded(runs: IndexMap<String, Observation>) -> Self {
        Self {
            source: RunnerSource::Recorded(runs),
        }
    }
    pub fn run(&mut self, experiment: &Value) -> Result<Observation> {
        match &mut self.source {
            RunnerSource::Generate {
                sim,
                truth,
                noise,
                rng,
            } => observe(sim, truth, experiment, noise, rng, "train", None),
            RunnerSource::Recorded(runs) => {
                let name = experiment
                    .as_str()
                    .or_else(|| experiment["name"].as_str())
                    .unwrap_or_default();
                runs.shift_remove(name).ok_or_else(|| {
                    invalid(format!(
                        "no recorded run {name:?} is left; recorded: {}",
                        runs.keys().cloned().collect::<Vec<_>>().join(", ")
                    ))
                })
            }
        }
    }
}
impl Runner for SyntheticRunner {
    fn kind(&self) -> &str {
        match self.source {
            RunnerSource::Generate { .. } => "synthetic",
            RunnerSource::Recorded(_) => "recorded",
        }
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
pub(crate) fn build(
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
/// A declared built-in case with the SDK helpers' changes applied.
fn declared(
    example: &str,
    case: &str,
    seed: u64,
    o: crate::backtest::Overrides,
) -> Result<(CaseView, Evaluator)> {
    let b = crate::backtest::Backtest::builtin(example)?;
    b.build(b.case(case)?, seed, &o)
}
fn bias_on(channel: &str, bias: f64) -> Option<Params> {
    (bias != 0.).then(|| params(&[(channel, bias)]))
}
/// `examples/oscillator.backtest`: `free-only` when `max_experiments` is 0,
/// else `full`, with that budget, a sensor `bias` and a `missing` fraction.
pub fn oscillator_case(
    seed: u64,
    max_experiments: usize,
    bias: f64,
    missing: f64,
) -> Result<(CaseView, Evaluator)> {
    let case = if max_experiments == 0 { "free-only" } else { "full" };
    declared(
        "oscillator",
        case,
        seed,
        crate::backtest::Overrides {
            max_experiments: Some(max_experiments),
            bias: bias_on("x", bias),
            missing: Some(missing),
            ..Default::default()
        },
    )
}
/// `examples/thermal.backtest`: `short-only` when `max_experiments` is 0,
/// else `full`.
pub fn thermal_case(
    seed: u64,
    max_experiments: usize,
    bias: f64,
    missing: f64,
) -> Result<(CaseView, Evaluator)> {
    let case = if max_experiments == 0 { "short-only" } else { "full" };
    declared(
        "thermal",
        case,
        seed,
        crate::backtest::Overrides {
            max_experiments: Some(max_experiments),
            bias: bias_on("T", bias),
            missing: Some(missing),
            ..Default::default()
        },
    )
}
pub const BATTERY_TRUTH: [(&str, f64); 3] = [("R0", 0.025), ("R1", 0.045), ("C1", 1600.)];
/// MQ-5 (`examples/battery.backtest`): a short pulse measures the ohmic drop
/// and initial polarization slope.
pub fn battery_case(seed: u64, max_experiments: usize) -> Result<(CaseView, Evaluator)> {
    battery_case_with(seed, max_experiments, 0.)
}
/// [`battery_case`] with a constant voltage-sensor offset `bias` (V) added
/// to every measurement; a nonzero bias is the planted `battery-biased` case
/// (unless `max_experiments` is 0, which is `battery-short-only`).
pub fn battery_case_with(
    seed: u64,
    max_experiments: usize,
    bias: f64,
) -> Result<(CaseView, Evaluator)> {
    let case = if max_experiments == 0 {
        "short-only"
    } else if bias != 0. {
        "biased"
    } else {
        "full"
    };
    declared(
        "battery",
        case,
        seed,
        crate::backtest::Overrides {
            max_experiments: Some(max_experiments),
            bias: bias_on("v", bias),
            missing: None,
            ..Default::default()
        },
    )
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
/// A case by stable id (from [`CASES`] or [`PLANTED_CASES`]) or by
/// reference (`battery#full`, `./x.backtest#case`); see [`crate::backtest`].
pub fn case(name: &str, seed: u64) -> Result<(CaseView, Evaluator)> {
    let (b, case) = crate::backtest::resolve_case(name)?;
    b.build(b.case(&case)?, seed, &crate::backtest::Overrides::default())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models;
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
