use super::*;
use crate::reasoner::{ReasonOptions, Reasoner, parse_json_content};
pub const ACTIONS: [&str; 8] = [
    "inspect_data",
    "optimize_parameters",
    "analyze_sensitivity",
    "rank_experiments",
    "request_experiment",
    "compare_models",
    "validate_predictions",
    "stop",
];
pub const LOSSES: [&str; 5] = ["linear", "soft_l1", "huber", "cauchy", "arctan"];
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub hypothesis: String,
    pub evidence: Vec<String>,
    pub action: String,
    pub arguments: Value,
    pub expected_information: String,
}
impl Decision {
    pub fn new(action: &str, arguments: Value) -> Self {
        Self {
            hypothesis: String::new(),
            evidence: vec![],
            action: action.into(),
            arguments,
            expected_information: String::new(),
        }
    }
    pub fn to_dict(&self) -> Value {
        json!(self)
    }
    pub fn parse(v: Value, param_names: &[String], catalog: &[String]) -> NumResult<Self> {
        let d: Self = serde_json::from_value(v).map_err(|e| invalid(e.to_string()))?;
        d.validate(param_names, catalog)?;
        Ok(d)
    }
    pub fn validate(&self, param_names: &[String], catalog: &[String]) -> NumResult<()> {
        let a = &self.arguments;
        let allowed: &[&str] = match self.action.as_str() {
            "inspect_data" | "analyze_sensitivity" | "validate_predictions" => &[],
            "optimize_parameters" => &["n_starts", "loss"],
            "rank_experiments" => &["criterion"],
            "request_experiment" => &["experiment"],
            "compare_models" => &["adopt"],
            "stop" => &["status", "identified", "summary"],
            _ => return Err(invalid("unknown decision action")),
        };
        let args = a
            .as_object()
            .ok_or_else(|| invalid("arguments must be an object"))?;
        if args.keys().any(|k| !allowed.contains(&k.as_str())) {
            return Err(invalid("unexpected decision argument"));
        }
        match self.action.as_str() {
            "optimize_parameters" => {
                if a.get("n_starts")
                    .is_some_and(|v| !v.as_u64().is_some_and(|n| (1..=16).contains(&n)))
                {
                    return Err(invalid("n_starts must be integer 1..16"));
                }
                if a.get("loss")
                    .is_some_and(|v| !v.as_str().is_some_and(|s| LOSSES.contains(&s)))
                {
                    return Err(invalid("invalid loss"));
                }
            }
            "rank_experiments" => {
                if a.get("criterion").is_some_and(|v| {
                    !v.as_str()
                        .is_some_and(|s| ["min_eig", "d_opt"].contains(&s))
                }) {
                    return Err(invalid("invalid criterion"));
                }
            }
            "request_experiment" => {
                if !a["experiment"]
                    .as_str()
                    .is_some_and(|e| catalog.iter().any(|v| v == e))
                {
                    return Err(invalid("unknown experiment"));
                }
            }
            "compare_models" => {
                if a.get("adopt").is_some_and(|v| !v.is_boolean()) {
                    return Err(invalid("adopt must be boolean"));
                }
            }
            "stop" => {
                if !a["status"]
                    .as_str()
                    .is_some_and(|s| ["validated", "inconclusive"].contains(&s))
                {
                    return Err(invalid("invalid stop status"));
                }
                if a.get("identified").is_some_and(|v| {
                    !v.as_array().is_some_and(|a| {
                        a.iter().all(|v| {
                            v.as_str()
                                .is_some_and(|n| param_names.iter().any(|p| p == n))
                        })
                    })
                }) {
                    return Err(invalid("stop.identified must list known parameters"));
                }
            }
            _ => {}
        }
        Ok(())
    }
}
pub fn decision_schema() -> Value {
    json!({"type":"object","required":["hypothesis","evidence","action","arguments","expected_information"],"additionalProperties":false,"properties":{"hypothesis":{"type":"string"},"evidence":{"type":"array","items":{"type":"string"}},"action":{"type":"string","enum":ACTIONS},"arguments":{"type":"object"},"expected_information":{"type":"string"}}})
}
pub trait Policy: Send {
    fn name(&self) -> &str;
    fn decide(&mut self, facts: &Value) -> NumResult<(Value, Value)>;
    fn meta(&self) -> Value {
        json!({})
    }
}
#[derive(Clone, Debug)]
pub struct ScriptedPolicy {
    pub misfit: f64,
}
impl Default for ScriptedPolicy {
    fn default() -> Self {
        Self { misfit: 2. }
    }
}
impl Policy for ScriptedPolicy {
    fn name(&self) -> &str {
        "scripted"
    }
    fn decide(&mut self, f: &Value) -> NumResult<(Value, Value)> {
        let fit = &f["fit"];
        let sens = &f["sensitivity"];
        let rank = &f["ranking"];
        let val = &f["validation"];
        let bud = &f["budget"];
        let dec = |action: &str, args: Value, h: String, ev: Vec<String>, info: &str| Decision {
            action: action.into(),
            arguments: args,
            hypothesis: h,
            evidence: ev,
            expected_information: info.into(),
        };
        let d = if fit.is_null() || fit["current"] != true {
            dec(
                "optimize_parameters",
                json!({}),
                "the model can be calibrated to the current train data".into(),
                vec![
                    format!("measurement version {}", f["measurements"]["version"]),
                    "no current fit".into(),
                ],
                "best-fit parameters and chi2/N",
            )
        } else if fit["chi2_per_n"].as_f64().unwrap_or(0.) > self.misfit
            && f["compared"] != true
            && f["model"]["variants"].as_array().map_or(0, Vec::len) > 1
        {
            dec(
                "compare_models",
                json!({"adopt":true}),
                "the misfit comes from a model error such as a sensor offset".into(),
                vec![format!(
                    "chi2/N={} > {}",
                    fmt(&fit["chi2_per_n"]),
                    self.misfit
                )],
                "which variant the data supports (BIC)",
            )
        } else if sens.is_null() || sens["current"] != true {
            dec(
                "analyze_sensitivity",
                json!({}),
                "some parameter combinations may be undetermined by this data".into(),
                vec![format!("fit chi2/N={}", fmt(&fit["chi2_per_n"]))],
                "identified parameters and non-identifiable directions",
            )
        } else if (sens["non_identified"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
            || bud["experiments_requested"] == 0)
            && bud["experiments_left"].as_i64().unwrap_or(0) > 0
            && f["catalog"].as_array().is_some_and(|a| !a.is_empty())
        {
            if rank.is_null() || rank["current"] != true {
                dec(
                    "rank_experiments",
                    json!({"criterion":"min_eig"}),
                    "a catalog experiment can resolve the weakest direction".into(),
                    vec![format!(
                        "non_identified={}",
                        joined(&sens["non_identified"])
                    )],
                    "Fisher-information score per experiment",
                )
            } else {
                let best = rank["top"][0]["experiment"]
                    .as_str()
                    .ok_or_else(|| invalid("empty ranking"))?;
                dec(
                    "request_experiment",
                    json!({"experiment":best}),
                    format!("{best} adds the most information on the weakest direction"),
                    vec![format!(
                        "{best} min_eig={}",
                        fmt(&rank["top"][0]["min_eig"])
                    )],
                    "data that tightens the worst-determined direction",
                )
            }
        } else if val.is_null() || val["current"] != true {
            dec(
                "validate_predictions",
                json!({}),
                "the calibrated model predicts the validation split".into(),
                vec![format!("fit chi2/N={}", fmt(&fit["chi2_per_n"]))],
                "validation chi2/N",
            )
        } else {
            let ok = val["passed"] == true
                && sens["non_identified"].as_array().is_some_and(Vec::is_empty);
            dec(
                "stop",
                json!({"status":if ok{"validated"}else{"inconclusive"},"identified":sens["identified"],"summary":"scripted baseline finished"}),
                "the investigation has answered what this budget allows".into(),
                vec![
                    format!(
                        "validation passed={}",
                        if val["passed"] == true {
                            "True"
                        } else {
                            "False"
                        }
                    ),
                    format!("non_identified={}", joined(&sens["non_identified"])),
                ],
                "none",
            )
        };
        Ok((
            json!(d),
            json!({"evidence_text":render_facts(f),"raw_output":null}),
        ))
    }
}
fn joined(v: &Value) -> String {
    let s = v
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    if s.is_empty() { "none".into() } else { s }
}
fn fmt(v: &Value) -> String {
    v.as_f64()
        .map(|v| crate::sensitivity::significant(v, 4))
        .unwrap_or_else(|| "inf".into())
}
fn string(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn yes(v: &Value) -> &str {
    if *v == true { "yes" } else { "no" }
}
fn current(v: &Value) -> &str {
    if v["current"] == true {
        "current"
    } else {
        "stale"
    }
}
fn fields(v: &Value) -> String {
    v.as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| format!("{k}={}", fmt(v)))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default()
}
pub fn render_facts(f: &Value) -> String {
    let m = &f["model"];
    let mut lines = vec![format!(
        "MODEL: {} variant={} variants={}",
        string(&m["name"]),
        string(&m["variant"]),
        joined(&m["variants"])
    )];
    lines.push(format!(
        "PARAMS: {}",
        m["params"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| format!(
                "{} [{}] in [{}, {}]",
                string(&p["name"]),
                string(&p["unit"]),
                fmt(&p["lo"]),
                fmt(&p["hi"])
            ))
            .collect::<Vec<_>>()
            .join("; ")
    ));
    lines.push(format!(
        "MEASUREMENTS: version={} {}",
        f["measurements"]["version"],
        f["measurements"]["observations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| format!(
                "{} {} n={} missing={} sigma={}",
                string(&o["split"]),
                string(&o["experiment"]),
                o["n"],
                o["missing"],
                fields(&o["sigma"])
            ))
            .collect::<Vec<_>>()
            .join("; ")
    ));
    lines.push(format!(
        "BUDGET: {}",
        [
            "steps_left",
            "simulations_left",
            "experiments_left",
            "experiments_requested"
        ]
        .iter()
        .map(|k| format!("{k}={}", f["budget"][k]))
        .collect::<Vec<_>>()
        .join(" ")
    ));
    let fixed = fields(&f["fixed"]).replace(',', ", ");
    lines.push(format!(
        "FIXED: {}",
        if fixed.is_empty() { "none" } else { &fixed }
    ));
    lines.push(format!("NOISE_SCALE: {}", fmt(&f["noise_scale"])));
    let cat = f["catalog"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| string(n))
        .collect::<Vec<_>>()
        .join(", ");
    lines.push(format!(
        "CATALOG: {}",
        if cat.is_empty() {
            "none (every experiment at its run limit)"
        } else {
            &cat
        }
    ));
    lines.push(format!("COMPARED: {}", yes(&f["compared"])));
    let fit = &f["fit"];
    if fit.is_null() {
        lines.push("FIT: none".into());
    } else {
        lines.push(format!(
            "FIT: {} chi2/N={} converged={} nfev={} at_bounds={} params {}",
            current(fit),
            fmt(&fit["chi2_per_n"]),
            yes(&fit["converged"]),
            fit["nfev"],
            joined(&fit["at_bounds"]),
            fields(&fit["params"]).replace(',', ", ")
        ));
    }
    let s = &f["sensitivity"];
    if s.is_null() {
        lines.push("SENSITIVITY: none".into());
    } else {
        lines.push(format!(
            "SENSITIVITY: {} cond={} identified={} non_identified={}",
            current(s),
            fmt(&s["condition_number"]),
            joined(&s["identified"]),
            joined(&s["non_identified"])
        ));
        for d in s["directions"].as_array().unwrap() {
            lines.push(format!(
                "  direction {} log_std={}: {}",
                string(&d["kind"]),
                fmt(&d["log_std"]),
                string(&d["combination"])
            ));
        }
    }
    let r = &f["ranking"];
    if r.is_null() {
        lines.push("RANKING: none".into());
    } else {
        let top = r["top"].as_array().unwrap();
        lines.push(format!(
            "RANKING: {} top={} {}",
            current(r),
            top.first()
                .map(|v| string(&v["experiment"]))
                .unwrap_or("none"),
            top.iter()
                .map(|c| format!(
                    "{} min_eig={} gain={} d_opt={}",
                    string(&c["experiment"]),
                    fmt(&c["min_eig"]),
                    fmt(&c["min_eig_gain"]),
                    fmt(&c["d_opt"])
                ))
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    let v = &f["validation"];
    if v.is_null() {
        lines.push("VALIDATION: none".into());
    } else if v["available"] == false {
        lines.push(format!("VALIDATION: {} available=no passed=no", current(v)));
    } else {
        lines.push(format!(
            "VALIDATION: {} passed={} chi2/N={} rmse={} threshold={}",
            current(v),
            yes(&v["passed"]),
            fmt(&v["chi2_per_n"]),
            fmt(&v["rmse"]),
            fmt(&v["threshold"])
        ));
    }
    lines.push(format!("RULE: {}", string(&f["rule"])));
    if let Some(h) = f["history"].as_array() {
        if !h.is_empty() {
            lines.push(format!(
                "HISTORY: {}",
                h.iter().map(string).collect::<Vec<_>>().join(" | ")
            ));
        }
    }
    if !string(&f["last_error"]).is_empty() {
        lines.push(format!("ERROR: {}", string(&f["last_error"])));
    }
    lines.join("\n")
}
pub fn actions() -> Value {
    serde_json::from_str(include_str!("actions.json")).unwrap()
}
pub fn system_prompt() -> String {
    include_str!("system-prompt.txt").into()
}
pub struct ReasonLanePolicy {
    pub reasoner: Box<dyn Reasoner>,
    pub effort: Option<String>,
    pub max_tokens: usize,
}
impl ReasonLanePolicy {
    pub fn new(reasoner: impl Reasoner + 'static) -> Self {
        Self {
            reasoner: Box::new(reasoner),
            effort: Some("low".into()),
            max_tokens: 2400,
        }
    }
}
impl Policy for ReasonLanePolicy {
    fn name(&self) -> &str {
        "reason-lane"
    }
    fn meta(&self) -> Value {
        use sha2::{Digest, Sha256};
        json!({"system_prompt_sha256":format!("{:x}",Sha256::digest(system_prompt())),"reasoner":self.reasoner.description()})
    }
    fn decide(&mut self, f: &Value) -> NumResult<(Value, Value)> {
        let text = render_facts(f);
        let reply = self.reasoner.complete(
            &[
                json!({"role":"developer","content":system_prompt()}),
                json!({"role":"user","content":text}),
            ],
            &ReasonOptions {
                response_schema: Some(decision_schema()),
                effort: self.effort.clone(),
                max_tokens: Some(self.max_tokens),
            },
        )?;
        let d = parse_json_content(&reply.content)?;
        Ok((
            d,
            json!({"evidence_text":text,"raw_output":reply.content,"model":reply.model,"usage":reply.usage,"elapsed_ms":reply.elapsed_ms}),
        ))
    }
}
/// An explicit decision script, useful for deterministic integration and conformance.
pub struct SequencePolicy {
    pub decisions: std::collections::VecDeque<Value>,
}
impl SequencePolicy {
    pub fn new(decisions: impl IntoIterator<Item = Value>) -> Self {
        Self {
            decisions: decisions.into_iter().collect(),
        }
    }
}
impl Policy for SequencePolicy {
    fn name(&self) -> &str {
        "script"
    }
    fn decide(&mut self, f: &Value) -> NumResult<(Value, Value)> {
        let d = self
            .decisions
            .pop_front()
            .ok_or_else(|| invalid("script exhausted"))?;
        Ok((
            d,
            json!({"evidence_text":render_facts(f),"raw_output":null}),
        ))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decisions() {
        assert!(Decision::parse(json!({"action":"stop"}), &[], &[]).is_err());
        assert!(
            Decision::new("stop", json!({"status":"validated","identified":["x"]}))
                .validate(&[], &[])
                .is_err()
        );
        assert!(
            Decision::new("optimize_parameters", json!({"n_starts":17}))
                .validate(&[], &[])
                .is_err()
        );
    }
}
