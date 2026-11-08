//! Code-declared configuration and a workbook bound to its executable simulator.
use crate::{
    agent::{self, Policy, Runner},
    data::Dataset,
    sensitivity::{DEFAULT_RULE, IdentifiabilityRule},
    simulator::*,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::ops::Deref;
use std::sync::Arc;
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Budgets {
    pub max_steps: usize,
    pub max_simulations: usize,
    pub max_experiments: usize,
    pub max_outlook_simulations: usize,
    /// MQ-5: a cap on the physical test hours that catalog experiments with a
    /// `cost_hours` may spend. Omitted from the config when unset, so configs
    /// without it keep their hash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_test_hours: Option<f64>,
}
impl Default for Budgets {
    fn default() -> Self {
        Self {
            max_steps: 24,
            max_simulations: 20000,
            max_experiments: 2,
            max_outlook_simulations: 50000,
            max_test_hours: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct NoiseConfig {
    pub sigma: Option<Params>,
    pub estimate: bool,
    pub bias: String,
}
impl Default for NoiseConfig {
    fn default() -> Self {
        Self {
            sigma: None,
            estimate: false,
            bias: "compare".into(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct PolicyConfig {
    pub kind: String,
    pub effort: Option<String>,
    pub max_tokens: usize,
}
impl Default for PolicyConfig {
    fn default() -> Self {
        Self {
            kind: "scripted".into(),
            effort: Some("low".into()),
            max_tokens: 2400,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct StopRules {
    pub validation_threshold: f64,
    pub misfit_threshold: f64,
    pub rule: IdentifiabilityRule,
}
impl Default for StopRules {
    fn default() -> Self {
        Self {
            validation_threshold: 2.,
            misfit_threshold: 2.,
            rule: DEFAULT_RULE,
        }
    }
}
/// Analyses the agent runs on every fit it adopts, recorded with that fit.
///
/// `identify_every_fit`: check identifiability, with each parameter's
/// one-sigma uncertainty, right after every adopted fit; the simulations count
/// against the budget, and the result travels in the step that made the fit.
/// Off, identifiability is checked only when the policy asks for
/// `analyze_sensitivity` (and at the end of the run).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AnalysisConfig {
    pub identify_every_fit: bool,
}
impl Default for AnalysisConfig {
    fn default() -> Self {
        Self {
            identify_every_fit: true,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct CatalogEntry {
    pub max_runs: Option<usize>,
    /// MQ-5: physical test hours one run costs; absent means 0. Serialized
    /// only when declared, so configs without it keep their hash.
    #[serde(
        default,
        deserialize_with = "declared_cost_hours",
        skip_serializing_if = "Option::is_none"
    )]
    pub cost_hours: Option<f64>,
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub edit: IndexMap<String, [f64; 2]>,
}
// Absence means uncosted, but an explicitly declared null is invalid in
// Python. Deserializing Option<f64> directly would silently treat it as absent.
fn declared_cost_hours<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<f64>, D::Error> {
    f64::deserialize(d).map(Some)
}
#[derive(Clone, Debug)]
pub struct Project {
    pub name: String,
    pub simulator: FunctionSimulator,
    pub initial: Params,
    pub fixed: Vec<String>,
    pub catalog: IndexMap<String, CatalogEntry>,
    pub noise: NoiseConfig,
    pub budgets: Budgets,
    pub stop: StopRules,
    pub policy: PolicyConfig,
    pub n_starts: usize,
    pub analysis: AnalysisConfig,
    /// The configuration another SDK computed for this same project (see
    /// [`Project::with_recorded_config`]); it is what records pin.
    recorded: Option<Arc<RecordedConfig>>,
}
/// A configuration and its version exactly as another SDK computed them.
#[derive(Debug)]
struct RecordedConfig {
    config: Value,
    version: String,
}
impl Project {
    pub fn new(name: impl Into<String>, simulator: FunctionSimulator) -> Self {
        let catalog = simulator
            .experiments
            .keys()
            .map(|k| (k.clone(), CatalogEntry::default()))
            .collect();
        Self {
            name: name.into(),
            simulator,
            initial: Params::new(),
            fixed: vec![],
            catalog,
            noise: Default::default(),
            budgets: Default::default(),
            stop: Default::default(),
            policy: Default::default(),
            n_starts: 4,
            analysis: AnalysisConfig::default(),
            recorded: None,
        }
    }
    pub fn validate(&self) -> Result<()> {
        for (k, v) in &self.initial {
            let s = self
                .simulator
                .params
                .get(k)
                .ok_or_else(|| invalid(format!("initial value for unknown parameter {k}")))?;
            if !v.is_finite() || *v < s.lo || *v > s.hi {
                return Err(invalid(format!("initial {k} outside bounds")));
            }
        }
        self.check_fixed(&self.fixed)?;
        if !["off", "fit", "compare"].contains(&self.noise.bias.as_str()) {
            return Err(invalid("bias must be off, fit or compare"));
        }
        if self
            .noise
            .sigma
            .as_ref()
            .is_some_and(|m| m.values().any(|s| *s <= 0. || !s.is_finite()))
        {
            return Err(invalid("noise sigma must be positive"));
        }
        if !["scripted", "reason-lane"].contains(&self.policy.kind.as_str()) {
            return Err(invalid("invalid policy kind"));
        }
        if self
            .budgets
            .max_test_hours
            .is_some_and(|h| !h.is_finite() || h < 0.)
        {
            return Err(invalid("max_test_hours must be finite and non-negative"));
        }
        for (n, entry) in &self.catalog {
            let s = self
                .simulator
                .experiments
                .get(n)
                .ok_or_else(|| invalid(format!("unknown catalog experiment {n}")))?;
            if entry.cost_hours.is_some_and(|h| !h.is_finite() || h < 0.) {
                return Err(invalid(format!(
                    "{n}: cost_hours must be finite and non-negative"
                )));
            }
            if entry.edit.len() > 3 {
                return Err(invalid("at most three editable settings"));
            }
            for (k, [lo, hi]) in &entry.edit {
                let v = number(s, k)?;
                if !lo.is_finite() || !hi.is_finite() || lo >= hi || v < *lo || v > *hi {
                    return Err(invalid("invalid editable setting limits"));
                }
            }
        }
        Ok(())
    }
    fn check_fixed(&self, fixed: &[String]) -> Result<()> {
        for k in fixed {
            if !self.simulator.params.contains_key(k) || !self.initial.contains_key(k) {
                return Err(invalid(format!(
                    "fixed parameter {k} needs a known initial value"
                )));
            }
        }
        if self.simulator.params.keys().all(|k| fixed.contains(k)) {
            return Err(invalid("at least one parameter must be free"));
        }
        Ok(())
    }
    pub fn initial_value(&self, k: &str) -> f64 {
        self.initial.get(k).copied().unwrap_or_else(|| {
            let s = &self.simulator.params[k];
            if s.log() {
                (s.lo * s.hi).sqrt()
            } else {
                0.5 * (s.lo + s.hi)
            }
        })
    }
    pub fn resolve_free(&self, free: Option<&[String]>) -> Result<(Vec<String>, Params)> {
        let free = free.map(|f| f.to_vec()).unwrap_or_else(|| {
            self.simulator
                .param_names()
                .into_iter()
                .filter(|n| !self.fixed.contains(n))
                .collect()
        });
        for k in &free {
            if !self.simulator.params.contains_key(k) {
                return Err(invalid(format!("unknown free parameter {k}")));
            }
        }
        let fixed: Vec<_> = self
            .simulator
            .params
            .keys()
            .filter(|k| !free.contains(k))
            .cloned()
            .collect();
        self.check_fixed(&fixed)?;
        Ok((
            self.simulator
                .param_names()
                .into_iter()
                .filter(|k| free.contains(k))
                .collect(),
            fixed.iter().map(|k| (k.clone(), self.initial[k])).collect(),
        ))
    }
    /// The configuration records pin: the recorded one (see
    /// [`Project::with_recorded_config`]) while this project still matches
    /// it, else the one computed from the fields.
    pub fn config(&self) -> Value {
        let computed = self.computed_config();
        match &self.recorded {
            Some(r) if numeric_difference(&computed, &r.config, "").is_none() => r.config.clone(),
            _ => computed,
        }
    }
    /// The version of [`Project::config`]: sha256 of its canonical JSON.
    pub fn config_version(&self) -> String {
        let computed = self.computed_config();
        match &self.recorded {
            Some(r) if numeric_difference(&computed, &r.config, "").is_none() => r.version.clone(),
            _ => config_hash(&computed),
        }
    }
    /// Pin `config` and its `version` exactly as another SDK computed them
    /// for this project, so records carry them byte for byte. The Python SDK
    /// keeps the integers a lab declares (`initial={"A": 1}` is `1` in its
    /// config and `1.0` here), so its version of the same configuration can
    /// differ from the one computed here. Refuses a `config` that does not
    /// hash to `version`, or that differs from this project's other than in
    /// how a number is written (`1` and `1.0` are the same value). Changing
    /// the project's fields afterwards drops the recorded configuration.
    pub fn with_recorded_config(mut self, config: Value, version: &str) -> Result<Self> {
        let hashed = config_hash(&config);
        if hashed != version {
            return Err(invalid(format!(
                "the recorded configuration hashes to {hashed}, not to its version {version}"
            )));
        }
        if let Some(diff) = numeric_difference(&self.computed_config(), &config, "config") {
            return Err(invalid(diff));
        }
        self.recorded = Some(Arc::new(RecordedConfig {
            config,
            version: version.into(),
        }));
        Ok(self)
    }
    fn computed_config(&self) -> Value {
        let sim = &self.simulator;
        let params:IndexMap<_,_>=sim.params.iter().map(|(k,s)|(k,json!({"unit":s.unit,"lo":s.lo,"hi":s.hi,"initial":self.initial.get(k),"fixed":self.fixed.contains(k)}))).collect();
        let catalog: IndexMap<_, _> = self
            .catalog
            .iter()
            .map(|(k, c)| {
                let mut v = json!({"settings":sim.experiments[k],"max_runs":c.max_runs});
                // Only present when declared, so configs without it keep their hash.
                if let Some(h) = c.cost_hours {
                    v["cost_hours"] = json!(h);
                }
                if !c.edit.is_empty() {
                    v["edit"] = json!(c.edit);
                }
                (k, v)
            })
            .collect();
        let mut budgets = json!(self.budgets);
        if self.budgets.max_outlook_simulations == Budgets::default().max_outlook_simulations {
            budgets
                .as_object_mut()
                .unwrap()
                .remove("max_outlook_simulations");
        }
        let mut config = json!({"name":self.name,"simulator":{"name":sim.name,"source_hash":sim.source_hash(),"outputs":sim.outputs},"params":params,"catalog":catalog,"noise":self.noise,"budgets":budgets,"stop":self.stop,"policy":self.policy,"n_starts":self.n_starts});
        // Only present when changed, so configs that keep the defaults keep their hash.
        if self.analysis != AnalysisConfig::default() {
            config["analysis"] = json!(self.analysis);
        }
        config
    }
}
fn config_hash(config: &Value) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "sha256:{:x}",
        Sha256::digest(crate::canonical::canonical(config))
    )
}
/// The first place where `rebuilt` and `recorded` differ, described with its
/// path under `at`; `None` when they are the same JSON up to how numbers are
/// written (an integer equals the float of the same value, at any depth).
pub fn numeric_difference(rebuilt: &Value, recorded: &Value, at: &str) -> Option<String> {
    let path = |k: &str| {
        if at.is_empty() {
            k.to_string()
        } else {
            format!("{at}.{k}")
        }
    };
    let differ = || {
        let at = if at.is_empty() {
            "the configuration"
        } else {
            at
        };
        Some(format!(
            "{at} is {rebuilt} here but {recorded} in the recorded configuration"
        ))
    };
    match (rebuilt, recorded) {
        (Value::Number(a), Value::Number(b)) if same_number(a, b) => None,
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .enumerate()
            .find_map(|(i, (x, y))| numeric_difference(x, y, &format!("{at}[{i}]"))),
        (Value::Object(a), Value::Object(b)) => {
            if let Some(k) = b.keys().find(|k| !a.contains_key(*k)) {
                return Some(format!(
                    "{} is missing here but present in the recorded configuration",
                    path(k)
                ));
            }
            a.iter().find_map(|(k, x)| match b.get(k) {
                Some(y) => numeric_difference(x, y, &path(k)),
                None => Some(format!(
                    "{} is present here but missing in the recorded configuration",
                    path(k)
                )),
            })
        }
        (Value::Number(_) | Value::Array(_), _) => differ(),
        (a, b) if a == b => None,
        _ => differ(),
    }
}
fn same_number(a: &serde_json::Number, b: &serde_json::Number) -> bool {
    let int = |n: &serde_json::Number| {
        n.as_i64()
            .map(i128::from)
            .or_else(|| n.as_u64().map(i128::from))
    };
    // An integral float equals the integer of the same value, compared
    // exactly, so a large integer never matches a nearby float.
    let int_float = |i: i128, f: Option<f64>| {
        f.is_some_and(|f| f.is_finite() && f.fract() == 0. && f.abs() < 1e38 && f as i128 == i)
    };
    match (int(a), int(b)) {
        (Some(x), Some(y)) => x == y,
        (Some(i), None) => int_float(i, b.as_f64()),
        (None, Some(i)) => int_float(i, a.as_f64()),
        (None, None) => a.as_f64() == b.as_f64(),
    }
}
pub fn policy_from_config(
    config: &PolicyConfig,
    reasoner: Option<Box<dyn crate::reasoner::Reasoner>>,
) -> Result<Box<dyn Policy>> {
    match config.kind.as_str() {
        "scripted" => Ok(Box::new(agent::ScriptedPolicy::default())),
        "reason-lane" => Ok(Box::new(agent::ReasonLanePolicy {
            reasoner: reasoner.ok_or_else(|| invalid("a reason-lane policy needs a reasoner"))?,
            effort: config.effort.clone(),
            max_tokens: Some(config.max_tokens),
            playbook: crate::playbook::load_playbook("default")?,
            model_spec: None,
        })),
        _ => Err(invalid("invalid policy kind")),
    }
}
/// A record workbook plus its in-process simulator. Deref exposes all record calls.
/// Review-only workbooks cannot reconstruct arbitrary executable Rust closures;
/// call `with_project` to attach the code before resuming in another process.
#[derive(Clone, Debug)]
pub struct ProjectWorkbook {
    pub workbook: crate::Workbook,
    pub project: Project,
}
impl Deref for ProjectWorkbook {
    type Target = crate::Workbook;
    fn deref(&self) -> &Self::Target {
        &self.workbook
    }
}
fn store_error(e: SimulationError) -> crate::Error {
    crate::Error::BadRequest(e.to_string())
}
impl crate::Client {
    pub fn project_with(&self, project: Project) -> crate::Result<ProjectWorkbook> {
        project.validate().map_err(store_error)?;
        let wb = self.project(&project.name)?;
        wb.with_project(project)
    }
}
impl crate::Workbook {
    pub fn with_project(&self, project: Project) -> crate::Result<ProjectWorkbook> {
        project.validate().map_err(store_error)?;
        if project.name != self.name() {
            return Err(crate::Error::BadRequest(
                "project name does not match workbook".into(),
            ));
        }
        self.put_config_version(
            &project.config_version(),
            crate::canonical::canonical(&project.config()).as_bytes(),
        )?;
        if self.remote().is_some() {
            if let Some(display) = project.simulator.display() {
                self.put_display(&display.canonical(&project).map_err(store_error)?)?;
            }
        }
        Ok(ProjectWorkbook {
            workbook: self.clone(),
            project,
        })
    }
}
impl ProjectWorkbook {
    pub fn investigate(
        &self,
        dataset: Dataset,
        runner: impl Runner + 'static,
        policy: impl Policy + 'static,
    ) -> crate::Result<agent::Investigation> {
        self.investigate_with(dataset, Box::new(runner), Box::new(policy), None, 0, "")
    }
    pub fn investigate_with(
        &self,
        dataset: Dataset,
        runner: Box<dyn Runner>,
        policy: Box<dyn Policy>,
        free: Option<&[String]>,
        seed: u64,
        title: &str,
    ) -> crate::Result<agent::Investigation> {
        agent::Investigation::create(
            self.project.clone(),
            dataset,
            runner,
            policy,
            &self.workbook,
            free,
            seed,
            title,
        )
    }
    pub fn resume(
        &self,
        id: &str,
        runner: impl Runner + 'static,
        policy: impl Policy + 'static,
    ) -> crate::Result<agent::Investigation> {
        agent::Investigation::resume(
            self.project.clone(),
            self.workbook.investigation(id)?,
            Box::new(runner),
            Box::new(policy),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_requires_initial() {
        let mut p = Project::new("x", crate::models::thermal_rc());
        p.fixed = vec!["C".into()];
        assert!(p.validate().is_err());
        p.initial.insert("C".into(), 500.);
        p.validate().unwrap();
        let (f, v) = p.resolve_free(None).unwrap();
        assert_eq!(f, vec!["R"]);
        assert_eq!(v["C"], 500.);
    }
    #[test]
    fn analysis_is_in_the_config_only_when_changed() {
        let mut p = Project::new("x", crate::models::thermal_rc());
        let default_version = p.config_version();
        assert!(p.config().get("analysis").is_none());
        p.analysis.identify_every_fit = false;
        assert_eq!(p.config()["analysis"], json!({"identify_every_fit": false}));
        assert_ne!(p.config_version(), default_version);
        let read: AnalysisConfig = serde_json::from_value(json!({})).unwrap();
        assert!(read.identify_every_fit);
    }
    #[test]
    fn numbers_compare_by_value_not_spelling() {
        let rebuilt = json!({"a": 1.0, "b": [2.0, {"c": 3.5}], "d": null, "e": "x"});
        let recorded = json!({"a": 1, "b": [2, {"c": 3.5}], "d": null, "e": "x"});
        assert_eq!(numeric_difference(&rebuilt, &recorded, ""), None);
        assert_eq!(numeric_difference(&json!(0.0), &json!(0), ""), None);
        assert_eq!(numeric_difference(&json!(-3.0), &json!(-3), ""), None);
        let other = json!({"a": 1, "b": [2, {"c": 3}], "d": null, "e": "x"});
        assert_eq!(
            numeric_difference(&rebuilt, &other, "config").unwrap(),
            "config.b[1].c is 3.5 here but 3 in the recorded configuration"
        );
        assert!(numeric_difference(&json!({"a": 1.5}), &json!({"a": 1}), "").is_some());
        let missing = numeric_difference(&json!({"a": 1}), &json!({"a": 1, "b": 2}), "").unwrap();
        assert!(missing.contains("b is missing here"), "{missing}");
        let extra = numeric_difference(&json!({"a": 1, "b": 2}), &json!({"a": 1}), "").unwrap();
        assert!(extra.contains("b is present here"), "{extra}");
        assert!(numeric_difference(&json!([1]), &json!([1, 2]), "").is_some());
        assert!(numeric_difference(&json!("1"), &json!(1), "").is_some());
        assert!(numeric_difference(&json!(1), &json!("1"), "").is_some());
        assert!(numeric_difference(&json!(true), &json!(1), "").is_some());
        assert!(numeric_difference(&json!(null), &json!(0), "").is_some());
        // Exact, not through f64: 2^53 + 1 is not the float 2^53.
        let big = json!(9007199254740993u64);
        assert!(numeric_difference(&big, &json!(9007199254740992.0), "").is_some());
        assert!(numeric_difference(&json!(u64::MAX), &json!(u64::MAX), "").is_none());
    }
    #[test]
    fn a_recorded_config_is_authoritative_while_the_project_matches_it() {
        let mut p = Project::new("x", crate::models::thermal_rc());
        p.initial.insert("C".into(), 500.);
        p.stop.validation_threshold = 3.;
        // What the Python SDK computes for the same lab declared with integers.
        let mut theirs = p.config();
        theirs["params"]["C"]["initial"] = json!(500);
        theirs["stop"]["validation_threshold"] = json!(3);
        let version = config_hash(&theirs);
        assert_ne!(version, p.config_version());
        let recorded = p
            .clone()
            .with_recorded_config(theirs.clone(), &version)
            .unwrap();
        assert_eq!(recorded.config(), theirs);
        assert_eq!(recorded.config_version(), version);
        assert_eq!(recorded.clone().config_version(), version);
        // A changed project is no longer the recorded one.
        let mut changed = recorded.clone();
        changed.stop.validation_threshold = 4.;
        assert_ne!(changed.config_version(), version);
        assert_eq!(changed.config()["stop"]["validation_threshold"], json!(4.0));
        // A genuine difference, or a version that is not the hash, is refused.
        let mut other = theirs.clone();
        other["stop"]["validation_threshold"] = json!(5);
        let e = p
            .clone()
            .with_recorded_config(other.clone(), &config_hash(&other))
            .unwrap_err()
            .to_string();
        assert!(
            e.contains("config.stop.validation_threshold is 3.0 here but 5"),
            "{e}"
        );
        let e = p
            .with_recorded_config(theirs, "sha256:0")
            .unwrap_err()
            .to_string();
        assert!(e.contains("not to its version sha256:0"), "{e}");
    }
}
