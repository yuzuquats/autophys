//! Browser-only starter: the built-in thermal simulator, synthetic observations,
//! and the SDK's scripted loop. No user code or credentials execute here.
use super::*;
use autophys::{
    agent,
    data::Dataset,
    project::Project,
    simulator::Params,
    synthetic::{NoiseModel, SyntheticRunner},
};
use std::{
    collections::HashSet,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
pub(super) struct Jobs(Arc<Mutex<HashSet<String>>>);
struct Lease {
    jobs: Jobs,
    project: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.jobs.0.lock() {
            jobs.remove(&self.project);
        }
    }
}
impl Jobs {
    fn reserve(&self, project: &str) -> Result<Lease> {
        let mut jobs = self
            .0
            .lock()
            .map_err(|_| ApiError::Internal("run registry poisoned".into()))?;
        if jobs.contains(project) || jobs.len() >= 4 {
            return Err(ApiError::bad_request(
                "A run is already active for this project, or four daemon runs are active. Wait for a run to finish.",
            ));
        }
        jobs.insert(project.into());
        Ok(Lease {
            jobs: self.clone(),
            project: project.into(),
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Setup {
    name: String,
    model: String,
    c: f64,
    r: f64,
    power: f64,
    duration: f64,
}
fn numeric(e: impl std::fmt::Display) -> ApiError {
    ApiError::bad_request(e.to_string())
}
fn project(s: Setup) -> Result<Project> {
    if s.name.trim().is_empty() || s.name.len() > 120 || s.name != s.name.trim() {
        return Err(ApiError::invalid(
            "name",
            "Use a project name of 1–120 characters without surrounding spaces.",
        ));
    }
    if s.model != "thermal_rc" {
        return Err(ApiError::invalid("model", "Choose thermal_rc."));
    }
    for (key, value, lo, hi) in [
        ("C", s.c, 10., 1e5),
        ("R", s.r, 0.01, 100.),
        ("power", s.power, 0.1, 100.),
        ("duration", s.duration, 10., 3600.),
    ] {
        if !value.is_finite() || value < lo || value > hi {
            return Err(ApiError::invalid(
                key,
                format!("Use a value from {lo} to {hi}."),
            ));
        }
    }
    let mut sim = autophys::models::thermal::thermal_rc();
    sim.experiments.clear();
    sim.experiments.insert(
        "step".into(),
        json!({"kind":"step","power":s.power,"duration":s.duration,"rate":0.2}),
    );
    let mut p = Project::new(s.name, sim);
    p.initial = [("C".into(), s.c), ("R".into(), s.r)].into_iter().collect();
    p.noise.bias = "off".into();
    p.noise.sigma = Some([("T".into(), 0.05)].into_iter().collect());
    p.n_starts = 2;
    p.budgets.max_experiments = 1;
    p.budgets.max_steps = 12;
    p.budgets.max_simulations = 10000;
    p.validate().map_err(numeric)?;
    Ok(p)
}

pub(super) async fn create(_: KeyOrBrowser, api: Data, body: web::Payload) -> Result<HttpResponse> {
    let setup: Setup = serde_json::from_value(body_json(body).await?).map_err(numeric)?;
    let p = project(setup)?;
    let client = api.client.clone();
    let out = blocking(move || {
        let (wb, new) = client.ensure_project(&p.name)?;
        if !new {
            return Err(ApiError::invalid(
                "name",
                "A project already uses this name. Choose another name.",
            ));
        }
        wb.put_config_version(
            &p.config_version(),
            autophys::canonical::canonical(&p.config()).as_bytes(),
        )?;
        Ok(json!({"project_id":wb.id(),"config_version":p.config_version()}))
    })
    .await?;
    api.woke(out["project_id"].as_str().unwrap());
    Ok(created(true, out))
}

fn restore(name: &str, config: &Value) -> Result<Project> {
    let p = project(Setup {
        name: name.into(),
        model: config["simulator"]["name"].as_str().unwrap_or("").into(),
        c: config["params"]["C"]["initial"]
            .as_f64()
            .unwrap_or(f64::NAN),
        r: config["params"]["R"]["initial"]
            .as_f64()
            .unwrap_or(f64::NAN),
        power: config["catalog"]["step"]["settings"]["power"]
            .as_f64()
            .unwrap_or(f64::NAN),
        duration: config["catalog"]["step"]["settings"]["duration"]
            .as_f64()
            .unwrap_or(f64::NAN),
    })?;
    // Only our exact built-in configuration can be executed, including the source hash.
    if p.config() != *config {
        return Err(ApiError::bad_request(
            "This configuration is not a browser thermal starter.",
        ));
    }
    Ok(p)
}
fn runner(p: &Project, seed: u64) -> SyntheticRunner {
    // Explicitly simulated reference specimen; these are not measured lab values.
    let truth: Params = [("C".into(), 500.), ("R".into(), 2.)].into_iter().collect();
    SyntheticRunner::new(
        p.simulator.clone(),
        truth,
        NoiseModel::new([("T".into(), 0.05)].into_iter().collect()),
        seed,
    )
}

pub(super) async fn start(
    _: KeyOrBrowser,
    api: Data,
    pid: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let v = body_json(body).await?;
    let version = v["config_version"]
        .as_str()
        .ok_or_else(|| ApiError::invalid("config_version", "required string"))?
        .to_string();
    let lease = api.workbench.reserve(&pid)?;
    let wb = workbook(&api, &pid).await?;
    let agent = blocking(move || {
        let config = wb
            .config_versions()?
            .into_iter()
            .find(|c| c.version == version)
            .ok_or_else(|| ApiError::invalid("config_version", "unknown configuration"))?;
        let p = restore(wb.name(), &config.config)?;
        let mut seed = runner(&p, 42);
        let mut train = seed.run(&json!("step")).map_err(numeric)?;
        train.experiment = "seed".into();
        // Distinct seeded observations; validation is never fitted.
        let mut validation = seed.run(&json!("step")).map_err(numeric)?;
        validation.split = "validation".into();
        let dataset = Dataset::new([train, validation]).map_err(numeric)?;
        Ok(agent::Investigation::create(
            p,
            dataset,
            Box::new(agent::ProposalRunner),
            Box::new(agent::ScriptedPolicy::default()),
            &wb,
            None,
            42,
            "Simulated thermal investigation",
        )?)
    })
    .await?;
    let id = agent.record.id.clone();
    let record = agent.record.clone();
    let project_id = pid.to_string();
    let worker_api = api.get_ref().clone();
    actix_web::rt::spawn(async move {
        let _lease = lease;
        let result = drive(worker_api.clone(), agent).await;
        if let Err(error) = result {
            let message = error.to_string();
            let _ = blocking(move || Ok(record.append("outcome", json!({
                "status":"inconclusive","reasons":[message],"summary":"Daemon run stopped. Start a new investigation to retry."
            }), None)?)).await;
        }
        worker_api.woke(&pid);
    });
    api.woke(&project_id);
    Ok(created(true, json!({"id":id})))
}

async fn drive(api: Api, mut inv: agent::Investigation) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(30 * 60);
    let project_id = inv.record.workbook().id().to_string();
    let mut synthetic = runner(&inv.project, 43);
    loop {
        inv = blocking(move || {
            inv.run()?;
            Ok(inv)
        })
        .await?;
        api.woke(&project_id);
        let Some(pid) = inv.pending.clone() else {
            return Ok(());
        };
        loop {
            if Instant::now() >= deadline {
                return Err(ApiError::bad_request(
                    "Approval timed out after 30 minutes.",
                ));
            }
            let record = inv.record.clone();
            let prop_id = pid.clone();
            let proposal = blocking(move || Ok(record.proposal(&prop_id)?)).await?;
            if proposal.status == "proposed" {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            (inv, synthetic) = blocking(move || {
                let decision = inv.wait_for_approval(Duration::ZERO)?;
                if ["approved", "edited"].contains(&decision.status.as_str()) {
                    let mut data = synthetic
                        .run(decision.settings.as_ref().ok_or_else(|| {
                            ApiError::bad_request("Approved proposal has no settings")
                        })?)
                        .map_err(numeric)?;
                    data.experiment = decision.experiment.clone().unwrap_or_else(|| "step".into());
                    inv.attach_data(&pid, data)?;
                } else {
                    // A rejection ends this one-experiment baseline, rather than re-proposing.
                    inv.project.budgets.max_experiments = 0;
                    inv.outcome = None;
                }
                Ok((inv, synthetic))
            })
            .await?;
            api.woke(&project_id);
            break;
        }
    }
}
