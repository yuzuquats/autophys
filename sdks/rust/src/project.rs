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
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Budgets {
    pub max_steps: usize,
    pub max_simulations: usize,
    pub max_experiments: usize,
}
impl Default for Budgets {
    fn default() -> Self {
        Self {
            max_steps: 24,
            max_simulations: 20000,
            max_experiments: 2,
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
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct CatalogEntry {
    pub max_runs: Option<usize>,
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub edit: IndexMap<String, [f64; 2]>,
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
        for (n, entry) in &self.catalog {
            let s = self
                .simulator
                .experiments
                .get(n)
                .ok_or_else(|| invalid(format!("unknown catalog experiment {n}")))?;
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
    pub fn config(&self) -> Value {
        let sim = &self.simulator;
        let params:IndexMap<_,_>=sim.params.iter().map(|(k,s)|(k,json!({"unit":s.unit,"lo":s.lo,"hi":s.hi,"initial":self.initial.get(k),"fixed":self.fixed.contains(k)}))).collect();
        let catalog: IndexMap<_, _> = self
            .catalog
            .iter()
            .map(|(k, c)| {
                let mut v = json!({"settings":sim.experiments[k],"max_runs":c.max_runs});
                if !c.edit.is_empty() {
                    v["edit"] = json!(c.edit);
                }
                (k, v)
            })
            .collect();
        json!({"name":self.name,"simulator":{"name":sim.name,"source_hash":sim.source_hash(),"outputs":sim.outputs},"params":params,"catalog":catalog,"noise":self.noise,"budgets":self.budgets,"stop":self.stop,"policy":self.policy,"n_starts":self.n_starts})
    }
    pub fn config_version(&self) -> String {
        use sha2::{Digest, Sha256};
        format!(
            "sha256:{:x}",
            Sha256::digest(crate::canonical::canonical(&self.config()))
        )
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
            max_tokens: config.max_tokens,
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
}
