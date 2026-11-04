//! Investigation loop. All durable writes use the record API's `append`.
mod policy;
use crate::{
    data::{Dataset, Observation},
    design::{self, Candidate},
    fit::{self, FitOptions, FitResult},
    project::Project,
    sensitivity::{self, SensitivityReport},
    simulator::{
        CallBudget, FIT_OPTIONS, FunctionSimulator, Params, Result as NumResult, SimulationError,
        Simulator, invalid,
    },
};
use indexmap::IndexMap;
use nalgebra::DMatrix;
pub use policy::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    ops::Deref,
    sync::{Arc, Mutex},
    time::Instant,
};
fn err(e: SimulationError) -> crate::Error {
    crate::Error::BadRequest(e.to_string())
}
pub trait Runner: Send {
    fn kind(&self) -> &str {
        "runner"
    }
    fn run(&mut self, experiment: &str, settings: &Value) -> NumResult<Observation>;
}
impl<F: FnMut(&str, &Value) -> NumResult<Observation> + Send> Runner for F {
    fn run(&mut self, n: &str, s: &Value) -> NumResult<Observation> {
        self(n, s)
    }
}
#[derive(Default)]
pub struct ProposalRunner;
impl Runner for ProposalRunner {
    fn kind(&self) -> &str {
        "proposal"
    }
    fn run(&mut self, _: &str, _: &Value) -> NumResult<Observation> {
        Err(invalid("proposal runner needs approval and attached data"))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outcome {
    pub status: String,
    pub reasons: Vec<String>,
    pub estimate: Params,
    pub units: IndexMap<String, String>,
    pub fixed: Vec<String>,
    pub identified: Vec<String>,
    pub non_identified: Vec<String>,
    pub non_identifiable_combinations: Vec<String>,
    pub guardrail_overrides: Vec<String>,
    pub model: String,
    pub fit: Option<Value>,
    pub validation: Option<Value>,
    pub steps: usize,
    pub simulations: usize,
    pub experiments: usize,
    pub wall_s: f64,
    pub investigation: String,
    pub proposal_id: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub usage_total: Value,
}
impl Outcome {
    pub fn to_dict(&self) -> Value {
        json!(self)
    }
}
pub struct Investigation {
    pub record: crate::Investigation,
    pub project: Project,
    pub dataset: Dataset,
    pub runner: Box<dyn Runner>,
    pub policy: Box<dyn Policy>,
    pub free: Vec<String>,
    pub fixed: Params,
    pub variants: IndexMap<String, FunctionSimulator>,
    pub model: String,
    pub seed: u64,
    pub fit: Option<FitResult>,
    pub fit_id: usize,
    fit_model: Option<String>,
    pub sens: Option<SensitivityReport>,
    sens_fit: Option<usize>,
    pub jac: Option<DMatrix<f64>>,
    pub ranking: Option<Vec<Candidate>>,
    ranking_fit: Option<usize>,
    ranking_criterion: String,
    pub validation: Option<Value>,
    validation_fit: Option<usize>,
    pub compared: bool,
    pub experiments_used: usize,
    pub steps: usize,
    pub history: Vec<String>,
    pub last_error: String,
    pub pending: Option<String>,
    pending_experiment: Option<String>,
    pub wall: f64,
    pub outcome: Option<Outcome>,
    pub runs_per_experiment: IndexMap<String, usize>,
    /// MQ-5: measurement version (1-based dataset position) of each
    /// observation that came in through `data_attached`, mapped to its
    /// proposal's experiment, so a lab-renamed observation is still charged
    /// the proposed experiment's cost. Rebuilt from the records on resume.
    attached: IndexMap<usize, Option<String>>,
    budget: Arc<Mutex<CallBudget>>,
}
impl Deref for Investigation {
    type Target = crate::Investigation;
    fn deref(&self) -> &Self::Target {
        &self.record
    }
}
impl Investigation {
    fn setup(
        project: Project,
        dataset: Dataset,
        record: crate::Investigation,
        runner: Box<dyn Runner>,
        policy: Box<dyn Policy>,
        free: Option<&[String]>,
        seed: u64,
    ) -> NumResult<Self> {
        project.validate()?;
        let (free, fixed) = project.resolve_free(free)?;
        let base = if fixed.is_empty() {
            project.simulator.clone()
        } else {
            project.simulator.with_fixed(fixed.clone())?
        };
        let mut variants = IndexMap::new();
        let mut channels: Vec<_> = dataset.iter().flat_map(|o| o.y.keys().cloned()).collect();
        channels.sort();
        channels.dedup();
        let mut biased = vec![];
        for ch in channels {
            let vals: Vec<_> = dataset
                .iter()
                .filter_map(|o| o.y.get(&ch))
                .flatten()
                .copied()
                .filter(|v| v.is_finite())
                .collect();
            let span = if vals.is_empty() {
                1.
            } else {
                vals.iter().copied().fold(f64::NEG_INFINITY, f64::max)
                    - vals.iter().copied().fold(f64::INFINITY, f64::min)
            }
            .max(1e-9);
            biased.push((ch, span));
        }
        if project.noise.bias == "fit" && !biased.is_empty() {
            let mut b = base;
            for (ch, span) in &biased {
                b = b.with_bias(ch, -span, *span)?;
            }
            variants.insert("sensor_bias".into(), b);
        } else {
            variants.insert("base".into(), base.clone());
            if project.noise.bias == "compare" {
                for (ch, span) in biased {
                    variants.insert(
                        format!("sensor_bias_{ch}"),
                        base.with_bias(&ch, -span, span)?,
                    );
                }
            }
        }
        let model = variants.keys().next().unwrap().clone();
        let limit = project.budgets.max_simulations;
        Ok(Self {
            record,
            project,
            dataset,
            runner,
            policy,
            free,
            fixed,
            variants,
            model,
            seed,
            fit: None,
            fit_id: 0,
            fit_model: None,
            sens: None,
            sens_fit: None,
            jac: None,
            ranking: None,
            ranking_fit: None,
            ranking_criterion: "min_eig".into(),
            validation: None,
            validation_fit: None,
            compared: false,
            experiments_used: 0,
            steps: 0,
            history: vec![],
            last_error: String::new(),
            pending: None,
            pending_experiment: None,
            wall: 0.,
            outcome: None,
            runs_per_experiment: IndexMap::new(),
            attached: IndexMap::new(),
            budget: Arc::new(Mutex::new(CallBudget::new(Some(limit)))),
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        project: Project,
        dataset: Dataset,
        runner: Box<dyn Runner>,
        policy: Box<dyn Policy>,
        wb: &crate::Workbook,
        free: Option<&[String]>,
        seed: u64,
        title: &str,
    ) -> crate::Result<Self> {
        project.validate().map_err(err)?;
        let (fr, fx) = project.resolve_free(free).map_err(err)?;
        let version = project.config_version();
        wb.put_config_version(
            &version,
            crate::canonical::canonical(&project.config()).as_bytes(),
        )?;
        let mut meta = json!({"project_id":wb.id(),"config_version":version,"title":title,"overrides":{"free":fr,"fixed":fx},"policy":policy.name(),"seed":seed});
        if let Some(m) = policy.meta().as_object() {
            meta.as_object_mut().unwrap().extend(m.clone());
        }
        if let Some(playbook) = policy.playbook() {
            wb.put_blob(&playbook.data().map_err(err)?, "text/markdown")?;
        }
        let (record, _) = wb.create_investigation(meta, None)?;
        let s = Self::setup(project, dataset, record, runner, policy, free, seed).map_err(err)?;
        for o in s.dataset.iter() {
            s.record_measurement(o)?;
        }
        Ok(s)
    }
    pub fn resume(
        project: Project,
        record: crate::Investigation,
        runner: Box<dyn Runner>,
        policy: Box<dyn Policy>,
    ) -> crate::Result<Self> {
        let recs = record.records(None)?;
        let head = recs
            .first()
            .ok_or(crate::Error::NotFound("investigation"))?;
        if head.payload["config_version"] != project.config_version() {
            return Err(crate::Error::BadRequest(
                "investigation is pinned to a different config version".into(),
            ));
        }
        let mut i = 1;
        let mut initial = vec![];
        // Measurement records map 1:1, in order, onto dataset positions. A
        // `data_attached` event names its measurement by that position
        // (Python) or by the measurement record's hash (Rust record API).
        let mut positions: std::collections::HashMap<String, usize> = Default::default();
        while i < recs.len() && recs[i].kind == "measurement" {
            initial
                .push(Observation::from_dict(recs[i].payload["observation"].clone()).map_err(err)?);
            positions.insert(recs[i].hash.clone(), initial.len());
            i += 1;
        }
        let mut measured = initial.len();
        let free: Option<Vec<String>> = head.payload["overrides"]["free"].as_array().map(|v| {
            v.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        });
        let seed = head.payload["seed"].as_u64().unwrap_or(0);
        let mut s = Self::setup(
            project,
            Dataset::new(initial).map_err(err)?,
            record,
            runner,
            policy,
            free.as_deref(),
            seed,
        )
        .map_err(err)?;
        let mut proposals: IndexMap<String, (String, Option<String>)> = IndexMap::new();
        let mut unclaimed: Option<String> = None;
        for r in &recs[i..] {
            let p = &r.payload;
            if r.kind == "measurement" {
                if let Some(n) = unclaimed.take() {
                    s.count(&n);
                }
                let o = Observation::from_dict(p["observation"].clone()).map_err(err)?;
                unclaimed = Some(o.experiment.clone());
                s.dataset.add(o).map_err(err)?;
                measured += 1;
                positions.insert(r.hash.clone(), measured);
                continue;
            }
            if r.kind == "proposal" && p["event"] == "data_attached" {
                unclaimed = None;
                let proposed = proposals
                    .get(p["proposal_id"].as_str().unwrap_or(""))
                    .and_then(|v| v.1.clone());
                let version = match &p["measurement_version"] {
                    Value::String(hash) => positions.get(hash).copied(),
                    v => v.as_u64().map(|v| v as usize),
                };
                if let Some(version) = version {
                    s.attached.insert(version, proposed.clone());
                }
                s.count(&proposed.unwrap_or_default());
                s.outcome = None;
            } else if let Some(n) = unclaimed.take() {
                s.count(&n);
            }
            match r.kind.as_str() {
                "proposal" => {
                    let pid = p["proposal_id"].as_str().unwrap_or("").to_string();
                    let st = proposals.entry(pid).or_insert((String::new(), None));
                    st.0 = p["event"].as_str().unwrap_or("").into();
                    if st.0 == "proposed" {
                        st.1 = p["experiment"].as_str().map(String::from);
                        s.ranking_criterion = p["criterion"]
                            .as_str()
                            .unwrap_or(&s.ranking_criterion)
                            .into();
                    }
                }
                "run" => {
                    s.fit_id = p["fit_id"]
                        .as_u64()
                        .ok_or_else(|| crate::Error::BadRequest("run has no fit_id".into()))?
                        as usize;
                    let model = p["model"]
                        .as_str()
                        .ok_or_else(|| crate::Error::BadRequest("run has no model".into()))?;
                    if !s.variants.contains_key(model) {
                        return Err(crate::Error::BadRequest(
                            "run refers to unknown model".into(),
                        ));
                    }
                    s.fit_model = Some(model.into());
                    s.model = model.into();
                    s.fit = Some(FitResult::from_dict(p.clone()).map_err(err)?);
                }
                "step" => {
                    s.outcome = None;
                    s.steps += 1;
                    s.budget.lock().unwrap().used +=
                        p["simulations"].as_u64().unwrap_or(0) as usize;
                    if let Some(a) = p["decision"]["action"].as_str() {
                        if a == "compare_models" {
                            s.compared = true;
                            if p["result"]["adopted"] == true {
                                if let Some(best) = p["result"]["best"].as_str() {
                                    if s.variants.contains_key(best) {
                                        s.model = best.into();
                                    }
                                }
                            }
                        }
                        s.history.push(format!(
                            "{a}: {}",
                            p["result"]["error"]
                                .as_str()
                                .map(|e| format!("error {e}"))
                                .unwrap_or_else(|| "ok".into())
                        ));
                    }
                }
                "outcome" => {
                    s.outcome = Some(
                        serde_json::from_value(p.clone())
                            .map_err(|e| crate::Error::BadRequest(e.to_string()))?,
                    );
                    s.wall = p["wall_s"].as_f64().unwrap_or(0.);
                }
                _ => {}
            }
        }
        if let Some(n) = unclaimed {
            s.count(&n);
        }
        for (pid, (event, n)) in proposals {
            if ["proposed", "approved", "edited"].contains(&event.as_str()) {
                s.pending = Some(pid);
                s.pending_experiment = n;
            }
        }
        Ok(s)
    }
    fn count(&mut self, name: &str) {
        self.experiments_used += 1;
        *self.runs_per_experiment.entry(name.into()).or_default() += 1;
    }
    fn write(&self, kind: &str, payload: Value) -> crate::Result<()> {
        self.record.append(kind, payload, None)?;
        Ok(())
    }
    fn record_measurement(&self, o: &Observation) -> crate::Result<()> {
        self.write("measurement",json!({"version":self.dataset.version,"digest":self.dataset.digest(),"observation":o.to_dict()}))
    }
    pub fn sim(&self) -> &FunctionSimulator {
        &self.variants[&self.model]
    }
    pub fn simulations(&self) -> usize {
        self.budget.lock().unwrap().used
    }
    pub fn noise_scale(&self) -> f64 {
        if self.project.noise.estimate {
            if let Some(f) = &self.fit {
                if f.chi2_per_n > 0. {
                    return f.chi2_per_n.sqrt();
                }
            }
        }
        1.
    }
    pub fn declared_noise(&self) -> Params {
        let mut n = self.dataset.noise();
        if let Some(o) = &self.project.noise.sigma {
            n.extend(o.clone());
        }
        n
    }
    pub fn available_experiments(&self) -> Vec<String> {
        self.project
            .catalog
            .iter()
            .filter(|(n, c)| {
                c.max_runs.is_none_or(|limit| {
                    self.runs_per_experiment.get(*n).copied().unwrap_or(0) < limit
                }) && self.affordable(n)
            })
            .map(|(n, _)| n.clone())
            .collect()
    }
    /// MQ-5: whether any catalog experiment declares `cost_hours`. Outputs
    /// carry hours and costs only then, so uncosted ones stay byte-identical.
    fn costed(&self) -> bool {
        self.project
            .catalog
            .values()
            .any(|c| c.cost_hours.is_some())
    }
    fn cost_hours(&self, experiment: &str) -> f64 {
        self.project
            .catalog
            .get(experiment)
            .and_then(|c| c.cost_hours)
            .unwrap_or(0.)
    }
    /// Test hours used, recomputed from the measured data (including data
    /// restored on resume). An attached observation is charged its
    /// proposal's experiment even if the lab named it differently.
    pub fn test_hours_used(&self) -> f64 {
        if !self.costed() {
            return 0.;
        }
        python_sum(self.dataset.iter().enumerate().map(|(i, o)| {
            let name = self
                .attached
                .get(&(i + 1))
                .and_then(|n| n.as_deref())
                .filter(|n| !n.is_empty())
                .unwrap_or(&o.experiment);
            self.cost_hours(name)
        }))
    }
    fn affordable(&self, experiment: &str) -> bool {
        self.project.budgets.max_test_hours.is_none_or(|limit| {
            self.test_hours_used() + self.cost_hours(experiment) <= limit + 1e-12
        })
    }
    pub fn facts(&self) -> Value {
        let sim = self.sim();
        let observations:Vec<_>=self.dataset.iter().map(|o|json!({"experiment":o.experiment,"split":o.split,"n":o.n_samples(),"missing":o.y.values().map(|v|v.len()).sum::<usize>()-o.n_samples(),"sigma":o.sigma})).collect();
        let fit=self.fit.as_ref().map(|f|json!({"current":f.dataset_version==Some(self.dataset.version)&&self.fit_model.as_ref()==Some(&self.model),"params":f.params,"chi2_per_n":f.chi2_per_n,"converged":f.success,"nfev":f.nfev,"at_bounds":f.at_bounds,"loss":f.loss_kind}));
        let sens=self.sens.as_ref().map(|s|json!({"current":self.sens_fit==Some(self.fit_id),"condition_number":s.condition_number,"identified":s.identified,"non_identified":s.non_identified,"directions":s.directions.iter().map(|d|json!({"kind":d.kind,"log_std":d.log_std,"combination":d.combination})).collect::<Vec<_>>()}));
        let rank=self.ranking.as_ref().map(|r|json!({"current":self.ranking_fit==Some(self.fit_id),"top":r.iter().take(5).map(|c|json!({"experiment":c.experiment,"min_eig":c.min_eig,"d_opt":c.d_opt,"min_eig_gain":c.min_eig_gain})).collect::<Vec<_>>()}));
        let val = self.validation.as_ref().map(|v| {
            let mut v = v.clone();
            v["current"] = json!(self.validation_fit == Some(self.fit_id));
            v
        });
        let mut facts = json!({"model":{"name":sim.name,"variant":self.model,"variants":self.variants.keys().collect::<Vec<_>>(),"params":sim.params.values().collect::<Vec<_>>()},"measurements":{"version":self.dataset.version,"observations":observations},"budget":{"steps_left":self.project.budgets.max_steps as i64-self.steps as i64,"simulations_left":self.project.budgets.max_simulations as i64-self.simulations()as i64,"experiments_left":self.project.budgets.max_experiments as i64-self.experiments_used as i64,"experiments_requested":self.experiments_used},"catalog":self.available_experiments(),"fixed":self.fixed,"noise_scale":self.noise_scale(),"compared":self.compared,"rule":self.project.stop.rule.describe(),"history":self.history.iter().skip(self.history.len().saturating_sub(6)).collect::<Vec<_>>(),"last_error":self.last_error,"fit":fit,"sensitivity":sens,"ranking":rank,"validation":val});
        if self.costed() {
            let used = self.test_hours_used();
            facts["budget"]["test_hours_used"] = json!(used);
            if let Some(limit) = self.project.budgets.max_test_hours {
                facts["budget"]["test_hours_left"] = json!(limit - used);
            }
        }
        facts
    }
    fn need_fit(&self) -> NumResult<&FitResult> {
        self.fit
            .as_ref()
            .filter(|_| self.fit_model.as_ref() == Some(&self.model))
            .ok_or_else(|| invalid("no fit for the current model: call optimize_parameters first"))
    }
    fn adopt(&mut self, r: FitResult, model: String) -> NumResult<()> {
        self.fit_id += 1;
        let mut body = r.to_dict();
        body["fit_id"] = json!(self.fit_id);
        body["model"] = json!(model);
        body["simulator"] = json!(self.variants[&model].name);
        self.write("run", body)
            .map_err(|e| invalid(e.to_string()))?;
        self.fit = Some(r);
        self.fit_model = Some(model);
        Ok(())
    }
    pub fn tool_inspect_data(&self) -> Value {
        json!({"version":self.dataset.version,"observations":self.dataset.iter().map(|o|{let chans:IndexMap<_,_>=o.y.iter().map(|(ch,y)|{let finite:Vec<_>=y.iter().copied().filter(|v|v.is_finite()).collect();(ch,json!({"min":finite.iter().copied().reduce(f64::min),"max":finite.iter().copied().reduce(f64::max),"missing":y.len()-finite.len(),"sigma":o.sigma[ch]}))}).collect();json!({"experiment":o.experiment,"split":o.split,"n":o.t.len(),"duration":o.t.last().unwrap_or(&0.)-o.t.first().unwrap_or(&0.),"channels":chans})}).collect::<Vec<_>>()})
    }
    pub fn tool_optimize_parameters(
        &mut self,
        n_starts: Option<usize>,
        loss: &str,
    ) -> NumResult<Value> {
        let train = self.dataset.split("train");
        if train.is_empty() {
            return Err(invalid("no train observations"));
        }
        let mut initial = self
            .fit
            .as_ref()
            .filter(|_| self.fit_model.as_ref() == Some(&self.model))
            .map(|f| f.params.clone());
        if initial.is_none()
            && self
                .free
                .iter()
                .all(|k| self.project.initial.contains_key(k))
        {
            initial = Some(
                self.sim()
                    .params
                    .keys()
                    .map(|k| {
                        (
                            k.clone(),
                            self.project.initial.get(k).copied().unwrap_or(0.),
                        )
                    })
                    .collect(),
            );
        }
        let n_starts = n_starts.unwrap_or(if initial.is_none() {
            self.project.n_starts
        } else {
            (self.project.n_starts / 2).max(1)
        });
        let r = fit::fit(
            self.sim(),
            &train,
            &FitOptions {
                initial,
                n_starts,
                loss: loss.into(),
                seed: self.seed * 1000 + self.fit_id as u64,
                dataset_version: Some(self.dataset.version),
                ..Default::default()
            },
        )?;
        let out = json!({"params":r.params,"chi2_per_n":r.chi2_per_n,"converged":r.success,"nfev":r.nfev,"at_bounds":r.at_bounds});
        self.adopt(r, self.model.clone())?;
        Ok(out)
    }
    pub fn tool_analyze_sensitivity(&mut self) -> NumResult<Value> {
        let r = self.need_fit()?;
        let j = sensitivity::jacobian(
            self.sim(),
            &r.params,
            &self.dataset.split("train"),
            1e-4,
            FIT_OPTIONS,
        )? / self.noise_scale();
        let s = sensitivity::report_from_jacobian(
            &self.sim().param_names(),
            &j,
            self.project.stop.rule,
            &r.params,
        )?;
        let out = json!({"condition_number":s.condition_number,"identified":s.identified,"non_identified":s.non_identified,"non_identifiable":s.non_identifiable_directions().iter().map(|d|&d.combination).collect::<Vec<_>>()});
        self.sens = Some(s);
        self.jac = Some(j);
        self.sens_fit = Some(self.fit_id);
        Ok(out)
    }
    pub fn tool_rank_experiments(&mut self, criterion: &str) -> NumResult<Value> {
        self.need_fit()?;
        if self.sens_fit != Some(self.fit_id) {
            self.tool_analyze_sensitivity()?;
        }
        let candidates = self.available_experiments();
        if candidates.is_empty() {
            return Err(invalid("every catalog experiment is at its run limit"));
        }
        let noise = self
            .declared_noise()
            .into_iter()
            .map(|(k, v)| (k, v * self.noise_scale()))
            .collect();
        let mut rank = design::rank_experiments(
            self.sim(),
            &self.need_fit()?.params,
            &self.dataset.split("train"),
            &noise,
            Some(&candidates),
            criterion,
            self.jac.as_ref(),
        )?;
        let out = if self.costed() {
            for c in &mut rank {
                c.cost_hours = Some(self.cost_hours(&c.experiment));
            }
            json!({"criterion":criterion,"ranking":rank})
        } else {
            json!({"criterion":criterion,"ranking":rank.iter().map(|c|json!([c.experiment,c.min_eig,c.d_opt])).collect::<Vec<_>>()})
        };
        self.ranking = Some(rank);
        self.ranking_fit = Some(self.fit_id);
        self.ranking_criterion = criterion.into();
        Ok(out)
    }
    pub fn proposal_outlook(
        &self,
        experiment: &str,
        settings: &Value,
    ) -> NumResult<(Value, f64, usize)> {
        let sim = self.sim();
        for v in self.variants.values() {
            v.set_budget(None);
        }
        let c0 = sim.calls();
        let result = (|| {
            let p = self
                .fit
                .as_ref()
                .map(|f| f.params.clone())
                .unwrap_or_else(|| {
                    sim.params
                        .iter()
                        .map(|(k, s)| {
                            (
                                k.clone(),
                                if self.project.simulator.params.contains_key(k) {
                                    self.project.initial_value(k)
                                } else {
                                    s.from_x(0.5 * (s.to_x(s.lo) + s.to_x(s.hi)))
                                },
                            )
                        })
                        .collect()
                });
            let noise = self
                .declared_noise()
                .into_iter()
                .map(|(k, v)| (k, v * self.noise_scale()))
                .collect();
            let j = if self.sens_fit == Some(self.fit_id) {
                self.jac.as_ref()
            } else {
                None
            };
            let edit = self
                .project
                .catalog
                .get(experiment)
                .map(|c| c.edit.clone())
                .unwrap_or_default();
            let (grid, score, _) = design::outlook_with_options(
                sim,
                &p,
                &self.dataset.split("train"),
                &noise,
                settings,
                &edit,
                &self.ranking_criterion,
                12,
                j,
                &design::OutlookOptions {
                    max_simulations: self.project.budgets.max_outlook_simulations,
                    at: if self.fit.is_some() { "fit" } else { "initial" }.into(),
                    jacobian_scale: self.noise_scale(),
                },
            )?;
            Ok((json!(grid), score, sim.calls() - c0))
        })();
        for v in self.variants.values() {
            v.set_budget(Some(self.budget.clone()));
        }
        result
    }
    pub fn tool_request_experiment(
        &mut self,
        experiment: &str,
        d: Option<&Decision>,
    ) -> NumResult<Value> {
        if self.experiments_used >= self.project.budgets.max_experiments {
            return Err(invalid("experiment budget is spent"));
        }
        if self.project.catalog.contains_key(experiment) && !self.affordable(experiment) {
            return Err(invalid(format!(
                "{experiment} exceeds the test-hour budget of {}",
                crate::canonical::py_float_repr(self.project.budgets.max_test_hours.unwrap_or(0.))
            )));
        }
        if !self
            .available_experiments()
            .contains(&experiment.to_string())
        {
            return Err(invalid(
                "experiment is not in the catalog or is at its run limit",
            ));
        }
        let settings = self.sim().experiment(&json!(experiment))?;
        if self.runner.kind() == "proposal" {
            let mut bytes = [0u8; 6];
            getrandom::getrandom(&mut bytes).map_err(|e| invalid(e.to_string()))?;
            let pid = format!("prop_{}", hex::encode(bytes));
            let (grid, score, calls) = self.proposal_outlook(experiment, &settings)?;
            let points: IndexMap<String, usize> = grid["axes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| {
                    (
                        a["name"].as_str().unwrap().into(),
                        a["values"].as_array().unwrap().len(),
                    )
                })
                .collect();
            self.write("proposal",json!({"proposal_id":pid,"event":"proposed","experiment":experiment,"settings":settings,"rationale":d.map(|d|d.hypothesis.as_str()).unwrap_or(""),"expected_information":d.map(|d|d.expected_information.as_str()).unwrap_or(""),"criterion":self.ranking_criterion,"score":score,"outlook":grid})).map_err(|e|invalid(e.to_string()))?;
            self.pending = Some(pid.clone());
            self.pending_experiment = Some(experiment.into());
            return Ok(
                json!({"proposal_id":pid,"status":"proposed","outlook_simulations":calls,"outlook_points":points}),
            );
        }
        let mut o = self.runner.run(experiment, &settings)?;
        o.split = "train".into();
        self.dataset.add(o.clone())?;
        self.record_measurement(&o)
            .map_err(|e| invalid(e.to_string()))?;
        self.count(experiment);
        Ok(
            json!({"experiment":experiment,"n":o.n_samples(),"measurement_version":self.dataset.version}),
        )
    }
    pub fn tool_compare_models(&mut self, adopt: bool) -> NumResult<Value> {
        let train = self.dataset.split("train");
        let n = fit::n_residuals(&train);
        let mut table = vec![];
        let mut fits = IndexMap::new();
        for (name, sim) in &self.variants {
            let initial = self
                .fit
                .as_ref()
                .filter(|_| self.fit_model.as_ref() == Some(name))
                .map(|f| f.params.clone());
            let r = fit::fit(
                sim,
                &train,
                &FitOptions {
                    initial,
                    n_starts: self.project.n_starts,
                    seed: self.seed * 1000 + 500 + table.len() as u64,
                    dataset_version: Some(self.dataset.version),
                    ..Default::default()
                },
            )?;
            let k = sim.params.len();
            table.push(json!({"variant":name,"k":k,"chi2":r.loss,"chi2_per_n":r.chi2_per_n,"aic":r.loss+2.*k as f64,"bic":r.loss+k as f64*(n.max(1)as f64).ln(),"converged":r.success}));
            fits.insert(name.clone(), r);
        }
        let best = table
            .iter()
            .min_by(|a, b| {
                a["bic"]
                    .as_f64()
                    .unwrap()
                    .total_cmp(&b["bic"].as_f64().unwrap())
            })
            .unwrap()["variant"]
            .as_str()
            .unwrap()
            .to_string();
        self.compared = true;
        if adopt {
            self.model = best.clone();
            self.adopt(fits.shift_remove(&best).unwrap(), best.clone())?;
        }
        Ok(json!({"table":table,"best":best,"adopted":adopt}))
    }
    pub fn tool_validate_predictions(&mut self) -> NumResult<Value> {
        let p = self.need_fit()?.params.clone();
        let val = self.dataset.split("validation");
        let out = if val.is_empty() {
            json!({"available":false,"passed":false})
        } else {
            let (mut chi, mut sq, mut n) = (0., 0., 0);
            for o in val {
                let pred = self.sim().simulate(&p, &o.settings, FIT_OPTIONS)?;
                for (ch, y) in &o.y {
                    let py = pred
                        .get(ch)
                        .ok_or_else(|| invalid("missing validation channel"))?;
                    if py.len() != y.len() {
                        return Err(invalid("validation prediction shape mismatch"));
                    }
                    for (y, f) in y.iter().zip(py) {
                        if y.is_finite() {
                            let d = y - f;
                            chi += (d / o.sigma[ch]).powi(2);
                            sq += d * d;
                            n += 1;
                        }
                    }
                }
            }
            let chi = chi / n.max(1) as f64 / self.noise_scale().powi(2);
            json!({"available":true,"chi2_per_n":chi,"rmse":(sq/n.max(1)as f64).sqrt(),"n":n,"threshold":self.project.stop.validation_threshold,"passed":chi<=self.project.stop.validation_threshold})
        };
        self.validation = Some(out.clone());
        self.validation_fit = Some(self.fit_id);
        Ok(out)
    }
    fn dispatch(&mut self, d: &Decision) -> NumResult<Value> {
        let a = &d.arguments;
        match d.action.as_str() {
            "inspect_data" => Ok(self.tool_inspect_data()),
            "optimize_parameters" => self.tool_optimize_parameters(
                a["n_starts"].as_u64().map(|v| v as usize),
                a["loss"].as_str().unwrap_or("linear"),
            ),
            "analyze_sensitivity" => self.tool_analyze_sensitivity(),
            "rank_experiments" => {
                self.tool_rank_experiments(a["criterion"].as_str().unwrap_or("min_eig"))
            }
            "request_experiment" => {
                self.tool_request_experiment(a["experiment"].as_str().unwrap(), Some(d))
            }
            "compare_models" => self.tool_compare_models(a["adopt"].as_bool().unwrap_or(true)),
            "validate_predictions" => self.tool_validate_predictions(),
            _ => Err(invalid("no tool for decision")),
        }
    }
    pub fn run(&mut self) -> crate::Result<Outcome> {
        if self.pending.is_some() {
            return Err(crate::Error::BadRequest(
                "awaiting data for pending proposal".into(),
            ));
        }
        for v in self.variants.values() {
            v.set_budget(Some(self.budget.clone()));
        }
        let result = self.run_inner();
        for v in self.variants.values() {
            v.set_budget(None);
        }
        result
    }
    fn run_inner(&mut self) -> crate::Result<Outcome> {
        let t = Instant::now();
        let mut failures = 0;
        loop {
            if self.steps >= self.project.budgets.max_steps {
                return self.finish(
                    "budget_exhausted",
                    vec![format!(
                        "step budget of {} spent",
                        self.project.budgets.max_steps
                    )],
                    None,
                    "",
                    t,
                );
            }
            let facts = self.facts();
            self.steps += 1;
            let mut step =
                json!({"index":self.steps,"policy":self.policy.name(),"fit_id":self.fit_id});
            let decision = self.policy.decide(&facts).and_then(|(raw, trace)| {
                if let Some(m) = trace.as_object() {
                    step.as_object_mut().unwrap().extend(m.clone());
                }
                Decision::parse(
                    raw,
                    &self.sim().param_names(),
                    &self.project.catalog.keys().cloned().collect::<Vec<_>>(),
                )
            });
            let d = match decision {
                Ok(d) => d,
                Err(e) => {
                    if let SimulationError::ReasonerTrace { trace, .. } = &e {
                        if let Some(m) = trace.as_object() {
                            step.as_object_mut().unwrap().extend(m.clone());
                        }
                    }
                    if let SimulationError::BudgetError(message) = &e {
                        // MQ-6: billing is not configured; retrying or
                        // continuing cannot help. Record the step, end the
                        // investigation and return the error.
                        self.last_error = format!("BudgetError: {message}");
                        step["valid"] = json!(false);
                        step["error"] = json!(self.last_error);
                        self.write("step", step)?;
                        self.finish(
                            "failed",
                            vec!["billing: provider refused the call (HTTP 402)".into()],
                            None,
                            "",
                            t,
                        )?;
                        return Err(crate::Error::Budget(message.clone()));
                    }
                    failures += 1;
                    self.last_error = e.to_string();
                    step["valid"] = json!(false);
                    step["error"] = json!(self.last_error);
                    self.write("step", step)?;
                    if failures >= 3 {
                        return self.finish(
                            "failed",
                            vec!["three unusable decisions in a row".into()],
                            None,
                            "",
                            t,
                        );
                    }
                    continue;
                }
            };
            failures = 0;
            step["decision"] = json!(d);
            step["valid"] = json!(true);
            if d.action == "stop" {
                self.write("step", step)?;
                let claimed = d.arguments["identified"].as_array().map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                });
                return self.finish(
                    d.arguments["status"].as_str().unwrap(),
                    vec![],
                    claimed,
                    d.arguments["summary"].as_str().unwrap_or(""),
                    t,
                );
            }
            let before = self.simulations();
            let result = self.dispatch(&d);
            step["simulations"] = json!(self.simulations() - before);
            let exhausted = matches!(result, Err(SimulationError::BudgetExceeded(_)));
            step["result"] = match result {
                Ok(v) => {
                    self.last_error.clear();
                    self.history.push(format!("{}: ok", d.action));
                    v
                }
                Err(e) => {
                    self.last_error = format!("{}: {e}", d.action);
                    self.history.push(format!("{}: error {e}", d.action));
                    json!({"error":e.to_string()})
                }
            };
            self.write("step", step)?;
            if exhausted {
                return self.finish(
                    "budget_exhausted",
                    vec![self.last_error.clone()],
                    None,
                    "",
                    t,
                );
            }
            if let Some(pid) = &self.pending {
                return self.finish(
                    "awaiting_data",
                    vec![format!("proposal {pid} awaits approval and data")],
                    None,
                    "",
                    t,
                );
            }
        }
    }
    fn finish(
        &mut self,
        status: &str,
        mut reasons: Vec<String>,
        claimed: Option<Vec<String>>,
        summary: &str,
        t: Instant,
    ) -> crate::Result<Outcome> {
        self.wall += t.elapsed().as_secs_f64();
        if self.fit.is_some()
            && self.fit_model.as_ref() == Some(&self.model)
            && self.sens_fit != Some(self.fit_id)
        {
            match self.tool_analyze_sensitivity() {
                Ok(_) => {}
                Err(SimulationError::BudgetExceeded(_)) => reasons.push(
                    "no simulations left to check identifiability at the final estimate".into(),
                ),
                Err(e) => return Err(err(e)),
            }
        }
        let sens = self
            .sens
            .as_ref()
            .filter(|_| self.sens_fit == Some(self.fit_id));
        let ids = sens.map(|s| s.identified.clone()).unwrap_or_default();
        let names = self.sim().param_names();
        let non: Vec<_> = names.iter().filter(|k| !ids.contains(k)).cloned().collect();
        let claimed = claimed.unwrap_or(ids.clone());
        let overrides: Vec<_> = claimed
            .iter()
            .filter(|k| !ids.contains(k))
            .cloned()
            .collect();
        let identified: Vec<_> = claimed
            .iter()
            .filter(|k| ids.contains(k))
            .cloned()
            .collect();
        let val_ok = self
            .validation
            .as_ref()
            .is_some_and(|v| v["passed"] == true)
            && self.validation_fit == Some(self.fit_id);
        let mut status = status.to_string();
        if status == "validated" {
            if self.fit.as_ref().is_none_or(|f| !f.success) {
                reasons.push(
                    if self.fit.is_some() {
                        "latest fit did not converge"
                    } else {
                        "no fit"
                    }
                    .into(),
                );
            }
            if !val_ok {
                reasons.push("validation split not passed at the latest fit".into());
            }
            if !non.is_empty() {
                reasons.push(format!("not identified by the rule: {}", non.join(", ")));
            }
            if !reasons.is_empty() {
                status = "inconclusive".into();
            }
        } else if status == "inconclusive" && reasons.is_empty() {
            if !non.is_empty() {
                reasons.push(format!("not identified by the rule: {}", non.join(", ")));
            }
            if !val_ok {
                reasons.push("validation split not passed at the latest fit".into());
            }
        }
        if !overrides.is_empty() {
            reasons.push(format!(
                "guardrail: claimed identified but the rule disagrees: {}",
                overrides.join(", ")
            ));
        }
        let mut estimate = self.fixed.clone();
        if let Some(f) = &self.fit {
            estimate.extend(f.params.clone());
        }
        let mut units = IndexMap::new();
        for k in self.fixed.keys() {
            units.insert(k.clone(), self.project.simulator.params[k].unit.clone());
        }
        units.extend(
            self.sim()
                .params
                .iter()
                .map(|(k, s)| (k.clone(), s.unit.clone())),
        );
        let mut fixed: Vec<_> = self.fixed.keys().cloned().collect();
        fixed.sort();
        let out = Outcome {
            status,
            reasons,
            estimate,
            units,
            fixed,
            non_identified: names
                .into_iter()
                .filter(|k| !identified.contains(k))
                .collect(),
            identified,
            non_identifiable_combinations: sens
                .map(|s| {
                    s.non_identifiable_directions()
                        .iter()
                        .map(|d| d.combination.clone())
                        .collect()
                })
                .unwrap_or_default(),
            guardrail_overrides: overrides,
            model: self.model.clone(),
            fit: self
                .fit
                .as_ref()
                .map(|f| json!({"chi2_per_n":f.chi2_per_n,"converged":f.success,"nfev":f.nfev})),
            validation: self.validation.clone(),
            steps: self.steps,
            simulations: self.simulations(),
            experiments: self.experiments_used,
            wall_s: self.wall,
            investigation: self.record.id.clone(),
            proposal_id: self.pending.clone(),
            summary: summary.into(),
            usage_total: crate::usage::usage_total(
                self.record
                    .records(Some("step"))?
                    .iter()
                    .map(|r| &r.payload),
            ),
        };
        self.write("outcome", json!(out))?;
        self.outcome = Some(out.clone());
        Ok(out)
    }
    pub fn approve(
        &self,
        pid: &str,
        by: &str,
        settings: Option<Value>,
    ) -> crate::Result<crate::Appended> {
        self.require_pending(pid)?;
        let mut payload = json!({"proposal_id":pid,"event":if settings.is_some() {"edited"} else {"approved"},"by":by,"via":"sdk"});
        if let Some(settings) = settings {
            payload["settings"] = self.sim().experiment(&settings).map_err(err)?;
        }
        self.record.append("proposal", payload, None)
    }
    pub fn reject(&mut self, pid: &str, by: &str, reason: &str) -> crate::Result<crate::Appended> {
        self.require_pending(pid)?;
        let a = self.record.append(
            "proposal",
            json!({"proposal_id":pid,"event":"rejected","by":by,"via":"sdk","reason":reason}),
            None,
        )?;
        self.pending = None;
        self.pending_experiment = None;
        self.history
            .push(format!("proposal {pid} rejected: {reason}"));
        Ok(a)
    }
    pub fn withdraw(
        &mut self,
        pid: &str,
        by: &str,
        reason: &str,
    ) -> crate::Result<crate::Appended> {
        self.require_pending(pid)?;
        let a = self.record.append(
            "proposal",
            json!({"proposal_id":pid,"event":"withdrawn","by":by,"via":"sdk","reason":reason}),
            None,
        )?;
        self.pending = None;
        self.pending_experiment = None;
        self.history
            .push(format!("proposal {pid} withdrawn: {reason}"));
        Ok(a)
    }
    pub fn attach_data(&mut self, pid: &str, mut o: Observation) -> crate::Result<crate::Appended> {
        self.require_pending(pid)?;
        o.split = "train".into();
        o.validate().map_err(err)?;
        let a = self.record.attach_data(pid, o.to_dict())?;
        self.dataset.add(o.clone()).map_err(err)?;
        self.attached
            .insert(self.dataset.len(), self.pending_experiment.clone());
        if let Some(n) = self.pending_experiment.take() {
            self.count(&n);
        }
        self.pending = None;
        self.outcome = None;
        self.history
            .push(format!("data attached for {pid} ({})", o.experiment));
        Ok(a)
    }
    pub fn wait_for_approval(
        &mut self,
        timeout: std::time::Duration,
    ) -> crate::Result<crate::Proposal> {
        let pid = self
            .pending
            .as_deref()
            .ok_or_else(|| crate::Error::BadRequest("no pending proposal".into()))?;
        let p = self.record.wait_for_approval(pid, timeout)?;
        if ["rejected", "withdrawn"].contains(&p.status.as_str()) {
            self.pending = None;
            self.pending_experiment = None;
        }
        Ok(p)
    }
    fn require_pending(&self, pid: &str) -> crate::Result<()> {
        if self.pending.as_deref() != Some(pid) {
            return Err(crate::Error::BadRequest(format!(
                "{pid} is not the pending proposal"
            )));
        }
        Ok(())
    }
}
/// CPython 3.12+ `sum()` over floats: Neumaier-compensated, so recomputed
/// test hours match the Python reference bit for bit.
fn python_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let (mut sum, mut c) = (0_f64, 0_f64);
    for x in values {
        let t = sum + x;
        c += if sum.abs() >= x.abs() {
            (sum - t) + x
        } else {
            (x - t) + sum
        };
        sum = t;
    }
    if c != 0. && c.is_finite() {
        sum + c
    } else {
        sum
    }
}
