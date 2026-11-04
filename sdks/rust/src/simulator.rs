//! Simulator schema, transformed coordinates and shared call budgets.
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
pub type Params = IndexMap<String, f64>;
pub type Settings = Value;
pub type Trajectory = IndexMap<String, Vec<f64>>;
pub type Result<T> = std::result::Result<T, SimulationError>;
#[derive(Debug, Clone, thiserror::Error)]
pub enum SimulationError {
    #[error("{0}")]
    Bounds(String),
    #[error("{0}")]
    Simulation(String),
    #[error("simulation budget of {0} calls is spent")]
    BudgetExceeded(usize),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    BudgetError(String),
    #[error("{message}")]
    ReasonerTrace { message: String, trace: Value },
}
pub(crate) fn invalid(s: impl Into<String>) -> SimulationError {
    SimulationError::Invalid(s.into())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ParamSpec {
    pub name: String,
    pub unit: String,
    pub lo: f64,
    pub hi: f64,
}
impl ParamSpec {
    pub fn new(name: impl Into<String>, unit: impl Into<String>, lo: f64, hi: f64) -> Result<Self> {
        if !lo.is_finite() || !hi.is_finite() || lo >= hi {
            return Err(invalid("parameter needs finite lo < hi"));
        }
        Ok(Self {
            name: name.into(),
            unit: unit.into(),
            lo,
            hi,
        })
    }
    pub fn log(&self) -> bool {
        self.lo > 0.0
    }
    pub fn scale(&self) -> f64 {
        if self.log() { 1.0 } else { self.hi - self.lo }
    }
    pub fn to_x(&self, v: f64) -> f64 {
        if self.log() { v.ln() } else { v / self.scale() }
    }
    pub fn from_x(&self, x: f64) -> f64 {
        if self.log() {
            x.exp()
        } else {
            x * self.scale()
        }
    }
    pub fn x_bounds(&self) -> (f64, f64) {
        (self.to_x(self.lo), self.to_x(self.hi))
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct SimOptions {
    pub rtol: f64,
    pub atol: f64,
    pub seed: Option<u64>,
}
impl Default for SimOptions {
    fn default() -> Self {
        FIT_OPTIONS
    }
}
pub const FIT_OPTIONS: SimOptions = SimOptions {
    rtol: 1e-8,
    atol: 1e-10,
    seed: None,
};
pub const TRUTH_OPTIONS: SimOptions = SimOptions {
    rtol: 1e-11,
    atol: 1e-13,
    seed: None,
};
#[derive(Debug)]
pub struct CallBudget {
    pub limit: Option<usize>,
    pub used: usize,
}
impl CallBudget {
    pub fn new(limit: Option<usize>) -> Self {
        Self { limit, used: 0 }
    }
    pub fn charge(&mut self) -> Result<()> {
        if let Some(n) = self.limit {
            if self.used >= n {
                return Err(SimulationError::BudgetExceeded(n));
            }
        }
        self.used += 1;
        Ok(())
    }
}
pub trait Simulator: Send + Sync {
    fn name(&self) -> &str;
    fn params(&self) -> &IndexMap<String, ParamSpec>;
    fn experiments(&self) -> &IndexMap<String, Settings>;
    fn outputs(&self) -> &[String];
    fn source_hash(&self) -> &str;
    fn stochastic(&self) -> bool {
        false
    }
    fn simulate(
        &self,
        params: &Params,
        experiment: &Settings,
        options: SimOptions,
    ) -> Result<Trajectory>;
    fn param_names(&self) -> Vec<String> {
        self.params().keys().cloned().collect()
    }
    fn schema(&self) -> Value {
        json!({"name":self.name(),"params":self.params().values().collect::<Vec<_>>(),"experiments":self.experiments(),"outputs":self.outputs(),"stochastic":self.stochastic()})
    }
    fn validate_params(&self, p: &Params) -> Result<Params> {
        if p.len() != self.params().len() || p.keys().any(|k| !self.params().contains_key(k)) {
            return Err(SimulationError::Bounds(
                "missing or unknown parameters".into(),
            ));
        }
        let mut out = Params::new();
        for (k, s) in self.params() {
            let v = *p
                .get(k)
                .ok_or_else(|| SimulationError::Bounds(format!("missing {k}")))?;
            if !v.is_finite() || v < s.lo || v > s.hi {
                return Err(SimulationError::Bounds(format!(
                    "{k}={v} outside [{}, {}]",
                    s.lo, s.hi
                )));
            }
            out.insert(k.clone(), v);
        }
        Ok(out)
    }
    fn experiment(&self, e: &Value) -> Result<Settings> {
        if let Some(n) = e.as_str() {
            return self
                .experiments()
                .get(n)
                .cloned()
                .ok_or_else(|| invalid(format!("unknown experiment {n}")));
        }
        validate_experiment(e)?;
        Ok(e.clone())
    }
    fn to_x(&self, p: &Params) -> Vec<f64> {
        self.params().iter().map(|(k, s)| s.to_x(p[k])).collect()
    }
    fn from_x(&self, x: &[f64]) -> Params {
        self.params()
            .iter()
            .zip(x)
            .map(|((k, s), v)| (k.clone(), s.from_x(*v).clamp(s.lo, s.hi)))
            .collect()
    }
    fn x_bounds(&self) -> (Vec<f64>, Vec<f64>) {
        self.params().values().map(ParamSpec::x_bounds).unzip()
    }
    fn check_determinism(&self, p: &Params, e: &Settings, options: SimOptions) -> Result<bool> {
        Ok(self.simulate(p, e, options)? == self.simulate(p, e, options)?)
    }
}
type SimFn = dyn Fn(&Params, &Settings, SimOptions) -> Result<Trajectory> + Send + Sync;
#[derive(Clone)]
pub struct FunctionSimulator {
    pub name: String,
    pub params: IndexMap<String, ParamSpec>,
    pub experiments: IndexMap<String, Settings>,
    pub outputs: Vec<String>,
    pub stochastic: bool,
    source_hash: String,
    func: Arc<SimFn>,
    calls: Arc<AtomicUsize>,
    budget: Arc<Mutex<Option<Arc<Mutex<CallBudget>>>>>,
}
impl std::fmt::Debug for FunctionSimulator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Simulator")
            .field("name", &self.name)
            .finish()
    }
}
pub fn simulator(
    name: impl Into<String>,
    specs: Vec<ParamSpec>,
    experiments: IndexMap<String, Settings>,
    outputs: Vec<String>,
    source: &str,
    func: impl Fn(&Params, &Settings, SimOptions) -> Result<Trajectory> + Send + Sync + 'static,
) -> Result<FunctionSimulator> {
    for e in experiments.values() {
        validate_experiment(e)?;
    }
    let params: IndexMap<_, _> = specs.into_iter().map(|s| (s.name.clone(), s)).collect();
    for s in params.values() {
        ParamSpec::new(&s.name, &s.unit, s.lo, s.hi)?;
    }
    let mut sim = FunctionSimulator {
        name: name.into(),
        params,
        experiments,
        outputs,
        stochastic: false,
        source_hash: String::new(),
        func: Arc::new(func),
        calls: Arc::new(AtomicUsize::new(0)),
        budget: Arc::new(Mutex::new(None)),
    };
    use sha2::{Digest, Sha256};
    sim.source_hash = format!(
        "sha256:{:x}",
        Sha256::digest(format!("{source}{}", sim.schema()).as_bytes())
    );
    Ok(sim)
}
impl FunctionSimulator {
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::Relaxed)
    }
    pub fn set_budget(&self, b: Option<Arc<Mutex<CallBudget>>>) {
        *self.budget.lock().unwrap() = b;
    }
    pub fn call(
        &self,
        p: &Params,
        e: &Settings,
        options: SimOptions,
        count: bool,
    ) -> Result<Trajectory> {
        self.validate_params(p)?;
        let exp = self.experiment(e)?;
        if self.stochastic && options.seed.is_none() {
            return Err(SimulationError::Simulation(
                "stochastic simulator needs a seed".into(),
            ));
        }
        if !options.rtol.is_finite()
            || options.rtol <= 0.0
            || !options.atol.is_finite()
            || options.atol <= 0.0
        {
            return Err(invalid("solver tolerances must be finite and positive"));
        }
        if count {
            if let Some(b) = &*self.budget.lock().unwrap() {
                b.lock().unwrap().charge()?;
            }
            self.calls.fetch_add(1, Ordering::Relaxed);
        }
        let out = (self.func)(p, &exp, options)?;
        let t = out
            .get("t")
            .ok_or_else(|| SimulationError::Simulation("missing time vector".into()))?;
        let channels: Vec<_> = if self.outputs.is_empty() {
            out.keys().filter(|k| k.as_str() != "t").cloned().collect()
        } else {
            self.outputs.clone()
        };
        let mut checked = Trajectory::new();
        checked.insert("t".into(), t.clone());
        for ch in channels {
            let v = out
                .get(&ch)
                .ok_or_else(|| SimulationError::Simulation(format!("missing channel {ch}")))?;
            if v.len() != t.len() || v.iter().any(|x| !x.is_finite()) {
                return Err(SimulationError::Simulation(format!(
                    "invalid output channel {ch}"
                )));
            }
            checked.insert(ch, v.clone());
        }
        Ok(checked)
    }
    pub fn with_fixed(&self, fixed: Params) -> Result<Self> {
        for k in fixed.keys() {
            if !self.params.contains_key(k) {
                return Err(invalid(format!("unknown fixed parameter {k}")));
            }
        }
        let base = self.clone();
        let mut out = self.clone();
        out.params.retain(|k, _| !fixed.contains_key(k));
        out.name = format!(
            "{}[fixed {}]",
            self.name,
            fixed.keys().cloned().collect::<Vec<_>>().join(",")
        );
        use sha2::{Digest, Sha256};
        out.source_hash = format!(
            "sha256:{:x}",
            Sha256::digest(format!(
                "{}{}",
                self.source_hash,
                serde_json::to_string(&fixed).unwrap()
            ))
        );
        out.func = Arc::new(move |p, e, o| {
            let mut full = fixed.clone();
            full.extend(p.clone());
            (base.func)(&full, e, o)
        });
        out.calls = Arc::new(AtomicUsize::new(0));
        out.budget = Arc::new(Mutex::new(None));
        Ok(out)
    }
    pub fn with_bias(&self, channel: &str, lo: f64, hi: f64) -> Result<Self> {
        if !(lo < 0.0 && hi > 0.0) {
            return Err(invalid("bias bounds must straddle zero"));
        }
        let mut out = self.clone();
        let base = self.clone();
        let ch = channel.to_string();
        let pname = format!("bias_{channel}");
        out.params.insert(
            pname.clone(),
            ParamSpec::new(&pname, format!("output units of {channel}"), lo, hi)?,
        );
        out.name = format!("{}+{pname}", self.name);
        use sha2::{Digest, Sha256};
        out.source_hash = format!(
            "sha256:{:x}",
            Sha256::digest(format!("{}+bias:{channel}", self.source_hash))
        );
        out.func = Arc::new(move |p, e, o| {
            let mut inner = p.clone();
            let bias = inner.shift_remove(&pname).unwrap();
            let mut y = (base.func)(&inner, e, o)?;
            for v in y
                .get_mut(&ch)
                .ok_or_else(|| invalid("unknown bias channel"))?
            {
                *v += bias;
            }
            Ok(y)
        });
        out.calls = Arc::new(AtomicUsize::new(0));
        out.budget = Arc::new(Mutex::new(None));
        Ok(out)
    }
}
impl Simulator for FunctionSimulator {
    fn name(&self) -> &str {
        &self.name
    }
    fn params(&self) -> &IndexMap<String, ParamSpec> {
        &self.params
    }
    fn experiments(&self) -> &IndexMap<String, Settings> {
        &self.experiments
    }
    fn outputs(&self) -> &[String] {
        &self.outputs
    }
    fn source_hash(&self) -> &str {
        &self.source_hash
    }
    fn stochastic(&self) -> bool {
        self.stochastic
    }
    fn simulate(&self, p: &Params, e: &Settings, o: SimOptions) -> Result<Trajectory> {
        self.call(p, e, o, true)
    }
}
pub fn validate_experiment(e: &Value) -> Result<()> {
    if !e.is_object() || !e["kind"].is_string() {
        return Err(invalid("experiment needs kind"));
    }
    for k in ["duration", "rate"] {
        if let Some(v) = e.get(k) {
            if !v.as_f64().is_some_and(|v| v > 0.0) {
                return Err(invalid(format!("{k} must be positive")));
            }
        }
    }
    Ok(())
}
pub fn time_grid(e: &Value) -> Result<Vec<f64>> {
    if let Some(t) = e.get("t") {
        return serde_json::from_value(t.clone()).map_err(|e| invalid(e.to_string()));
    }
    let d = number(e, "duration")?;
    let rate = number(e, "rate")?;
    let n = (d * rate).round_ties_even() as usize;
    if n == 0 {
        return Ok(vec![0.0]);
    }
    Ok((0..=n)
        .map(|i| if i == n { d } else { d * i as f64 / n as f64 })
        .collect())
}
pub fn number(e: &Value, k: &str) -> Result<f64> {
    e[k].as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| invalid(format!("missing numeric {k}")))
}
pub fn get(e: &Value, k: &str, default: f64) -> f64 {
    e[k].as_f64().unwrap_or(default)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coordinates() {
        let p = ParamSpec::new("a", "", 0.1, 10.0).unwrap();
        assert!((p.from_x(p.to_x(3.0)) - 3.0).abs() < 1e-14);
        let p = ParamSpec::new("b", "", -3.0, 7.0).unwrap();
        assert_eq!(p.from_x(p.to_x(-2.0)), -2.0);
        assert!(ParamSpec::new("bad", "", 1.0, 1.0).is_err());
    }
    #[test]
    fn grid() {
        assert_eq!(
            time_grid(&json!({"duration":1.0,"rate":2.0})).unwrap(),
            vec![0.0, 0.5, 1.0]
        );
    }
    #[test]
    fn budget() {
        let mut b = CallBudget::new(Some(1));
        b.charge().unwrap();
        assert!(matches!(
            b.charge(),
            Err(SimulationError::BudgetExceeded(1))
        ));
    }
}
