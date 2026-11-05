//! Bounded, multistart weighted least squares in the Python fitting coordinates.
mod bounded;
pub mod rng;
pub(crate) mod ziggurat;
use crate::{data::Observation, simulator::*};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug)]
pub struct FitOptions {
    pub initial: Option<Params>,
    pub starts: Option<Vec<Params>>,
    pub n_starts: usize,
    pub loss: String,
    pub f_scale: f64,
    pub seed: u64,
    pub max_nfev: usize,
    pub options: SimOptions,
    pub dataset_version: Option<usize>,
}
impl Default for FitOptions {
    fn default() -> Self {
        Self {
            initial: None,
            starts: None,
            n_starts: 4,
            loss: "linear".into(),
            f_scale: 1.,
            seed: 0,
            max_nfev: 200,
            options: FIT_OPTIONS,
            dataset_version: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StartResult {
    pub x0: Vec<f64>,
    pub loss: f64,
    pub nfev: usize,
    pub status: i32,
    pub success: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FitResult {
    pub params: Params,
    pub loss: f64,
    pub chi2_per_n: f64,
    pub n: usize,
    pub nfev: usize,
    pub status: i32,
    pub message: String,
    pub success: bool,
    pub loss_kind: String,
    pub at_bounds: Vec<String>,
    #[serde(default)]
    pub starts: Vec<StartResult>,
    pub dataset_version: Option<usize>,
    pub source_hash: String,
    pub seed: Option<u64>,
}
impl FitResult {
    pub fn from_dict(value: serde_json::Value) -> Result<Self> {
        serde_json::from_value(value).map_err(|e| invalid(format!("invalid fit result: {e}")))
    }
    pub fn to_dict(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap()
    }
}
pub fn residuals(
    sim: &dyn Simulator,
    p: &Params,
    obs: &[Observation],
    options: SimOptions,
) -> Result<Vec<f64>> {
    for o in obs { o.validate()?; }
    let mut r = vec![];
    for o in obs {
        let pred = sim.simulate(p, &o.settings, options)?;
        for (ch, y) in &o.y {
            let py = pred
                .get(ch)
                .ok_or_else(|| SimulationError::Simulation(format!("missing channel {ch}")))?;
            if py.len() != y.len() {
                return Err(SimulationError::Simulation(
                    "prediction does not match observation time grid".into(),
                ));
            }
            for (y, f) in y.iter().zip(py) {
                if y.is_finite() {
                    r.push((y - f) / o.sigma[ch]);
                }
            }
        }
    }
    Ok(r)
}
pub fn n_residuals(obs: &[Observation]) -> usize {
    obs.iter().map(Observation::n_samples).sum()
}
pub fn lhs_starts(sim: &dyn Simulator, n: usize, seed: u64) -> Vec<Vec<f64>> {
    let (lo, hi) = sim.x_bounds();
    if n == 0 {
        return vec![];
    }
    let mut rng = rng::NumpyRng::new(seed);
    let mut samples: Vec<Vec<f64>> = (0..n)
        .map(|_| (0..lo.len()).map(|_| rng.uniform()).collect())
        .collect();
    for j in 0..lo.len() {
        let mut order: Vec<_> = (1..=n).collect();
        rng.shuffle(&mut order);
        for i in 0..n {
            let v = (order[i] as f64 - samples[i][j]) / n as f64;
            samples[i][j] = lo[j] + (0.05 + 0.9 * v) * (hi[j] - lo[j]);
        }
    }
    samples
}
pub fn fit(
    sim: &dyn Simulator,
    observations: &[Observation],
    opts: &FitOptions,
) -> Result<FitResult> {
    if observations.is_empty() {
        return Err(invalid("fit needs at least one observation"));
    }
    for o in observations {
        o.validate()?;
    }
    if sim.params().is_empty()
        || opts.max_nfev == 0
        || !opts.f_scale.is_finite()
        || opts.f_scale <= 0.
    {
        return Err(invalid(
            "fit needs parameters, positive max_nfev and f_scale",
        ));
    }
    let loss = bounded::loss(&opts.loss)?;
    let (lo, hi) = sim.x_bounds();
    let mut starts = vec![];
    if let Some(initial) = &opts.initial {
        sim.validate_params(initial)?;
        starts.push(sim.to_x(initial));
    }
    if let Some(explicit) = &opts.starts {
        for p in explicit {
            sim.validate_params(p)?;
            starts.push(sim.to_x(p));
        }
    } else {
        starts.extend(lhs_starts(sim, opts.n_starts, opts.seed));
    }
    if starts.is_empty() {
        return Err(invalid("fit needs at least one start"));
    }
    let n = n_residuals(observations);
    if n == 0 {
        return Err(invalid("fit needs finite observations"));
    }
    let fun = |x: &[f64]| -> Result<Vec<f64>> {
        match residuals(sim, &sim.from_x(x), observations, opts.options) {
            Err(SimulationError::Simulation(_)) => Ok(vec![1e6; n]),
            r => r,
        }
    };
    let mut records = vec![];
    let mut best: Option<bounded::Solution> = None;
    let mut nfev = 0;
    for x0 in starts {
        let r = bounded::solve(&fun, &x0, &lo, &hi, loss, opts.f_scale, opts.max_nfev)?;
        nfev += r.calls;
        records.push(StartResult {
            x0,
            loss: r.plain,
            nfev: r.calls,
            status: r.status,
            success: r.status > 0,
        });
        if best.as_ref().is_none_or(|b| r.plain < b.plain) {
            best = Some(r);
        }
    }
    let r = best.unwrap();
    let params = sim.from_x(&r.x);
    let at_bounds = sim
        .param_names()
        .into_iter()
        .enumerate()
        .filter_map(|(j, k)| {
            ((r.x[j] - lo[j]).min(hi[j] - r.x[j]) < 1e-6 * (hi[j] - lo[j])).then_some(k)
        })
        .collect();
    Ok(FitResult {
        params,
        loss: r.plain,
        chi2_per_n: r.plain / n.max(1) as f64,
        n,
        nfev,
        status: r.status,
        message: match r.status {
            0 => "maximum function evaluations exceeded",
            1 => "gtol termination",
            2 => "ftol termination",
            3 => "xtol termination",
            _ => "ftol and xtol termination",
        }
        .into(),
        success: r.status > 0,
        loss_kind: opts.loss.clone(),
        at_bounds,
        starts: records,
        dataset_version: opts.dataset_version,
        source_hash: sim.source_hash().into(),
        seed: Some(opts.seed),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use serde_json::json;
    #[test]
    fn bounded_and_robust() {
        let s = simulator(
            "line",
            vec![ParamSpec::new("a", "", -1., 3.).unwrap()],
            IndexMap::new(),
            vec!["y".into()],
            "line",
            |p, e, _| {
                let t = time_grid(e)?;
                Ok([("y".into(), vec![p["a"]; t.len()]), ("t".into(), t)]
                    .into_iter()
                    .collect())
            },
        )
        .unwrap();
        let o = Observation::new(
            "e",
            json!({"kind":"custom","t":[0.,1.,2.]}),
            vec![0., 1., 2.],
            [("y".into(), vec![5.; 3])].into_iter().collect(),
            [("y".into(), 1.)].into_iter().collect(),
        )
        .unwrap();
        for loss in ["linear", "huber", "soft_l1", "cauchy", "arctan"] {
            let r = fit(
                &s,
                &[o.clone()],
                &FitOptions {
                    loss: loss.into(),
                    n_starts: 1,
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(r.success);
            assert_eq!(r.at_bounds, vec!["a"]);
            assert!((r.params["a"] - 3.).abs() < 1e-6);
        }
    }
}
