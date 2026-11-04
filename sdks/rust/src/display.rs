//! Format-1 presentation metadata. Never part of a simulator schema or config hash.
use crate::{project::Project, simulator::*};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use std::sync::Arc;

pub type InputFn = Arc<dyn Fn(&Settings, &[f64]) -> Result<Vec<f64>> + Send + Sync>;
/// Attach with `FunctionSimulator::with_display`; previews are uncounted simulations.
#[derive(Clone, Default)]
pub struct Display {
    pub channels: Map<String, Value>,
    pub params: Map<String, Value>,
    pub settings: Map<String, Value>,
    pub experiments: Map<String, Value>,
    pub default_view: Option<String>,
    pub inputs: IndexMap<String, InputFn>,
}
impl std::fmt::Debug for Display {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Display")
            .field("channels", &self.channels)
            .finish_non_exhaustive()
    }
}
const VIEWS: &[&str] = &["edges", "envelope", "spectrum"];
const DEFAULT_VIEWS: &[&str] = &[
    "fit",
    "residuals",
    "landscape",
    "edges",
    "envelope",
    "spectrum",
];
impl Display {
    pub(crate) fn input_names(&self) -> Vec<String> {
        let mut names: Vec<_> = self
            .channels
            .iter()
            .filter(|(_, s)| s["role"] == "input")
            .map(|(k, _)| k.clone())
            .collect();
        names.sort();
        names
    }
    pub fn validate(&self, sim: &FunctionSimulator) -> Result<()> {
        let keys: Vec<_> = sim
            .experiments
            .values()
            .flat_map(|e| e.as_object().into_iter().flat_map(|e| e.keys()))
            .collect();
        if self.settings.keys().any(|k| !keys.contains(&k)) {
            return Err(invalid(
                "display settings must exist in the experiment catalog",
            ));
        }
        if self.params.keys().any(|k| !sim.params.contains_key(k)) {
            return Err(invalid("display params must exist in the simulator"));
        }
        if self
            .experiments
            .keys()
            .any(|k| !sim.experiments.contains_key(k))
        {
            return Err(invalid("display experiments must exist in the catalog"));
        }
        if self
            .default_view
            .as_ref()
            .is_some_and(|v| !DEFAULT_VIEWS.contains(&v.as_str()))
        {
            return Err(invalid("invalid display default_view"));
        }
        for e in self.experiments.values() {
            if !e.is_object() {
                return Err(invalid("display experiment must be an object"));
            }
            if let Some(views) = e.get("views") {
                if !views.as_array().is_some_and(|v| {
                    v.iter()
                        .all(|v| v.as_str().is_some_and(|v| VIEWS.contains(&v)))
                }) {
                    return Err(invalid("invalid display views"));
                }
            }
        }
        for s in self.settings.values() {
            if !s["role"]
                .as_str()
                .is_some_and(|r| ["drive", "sampling", "known", "other"].contains(&r))
            {
                return Err(invalid("invalid display setting role"));
            }
        }
        for (ch, spec) in &self.channels {
            let role = spec["role"].as_str();
            if ch == "t" || !matches!(role, Some("input" | "output")) {
                return Err(invalid("invalid display channel role or name"));
            }
            if role == Some("output") && !sim.outputs.contains(ch) {
                return Err(invalid("display output channels must be in outputs"));
            }
            if role == Some("input") && sim.outputs.contains(ch) {
                return Err(invalid("display inputs must be separate from outputs"));
            }
        }
        let names = self.input_names();
        if self.inputs.keys().any(|k| !names.contains(k)) {
            return Err(invalid(
                "display input functions must provide declared input channels",
            ));
        }
        if !names.is_empty() {
            let mut probe = sim.clone();
            probe.display = Some(self.clone());
            let p = sim
                .params
                .iter()
                .map(|(k, s)| {
                    (
                        k.clone(),
                        if s.log() {
                            (s.lo * s.hi).sqrt()
                        } else {
                            (s.lo + s.hi) / 2.
                        },
                    )
                })
                .collect();
            for exp in sim.experiments.values() {
                probe.call(
                    &p,
                    exp,
                    SimOptions {
                        seed: Some(0),
                        ..Default::default()
                    },
                    false,
                )?;
            }
        }
        Ok(())
    }
    pub(crate) fn check_inputs(
        &self,
        raw: &Trajectory,
        exp: &Settings,
        checked: &mut Trajectory,
    ) -> Result<()> {
        let t = &raw["t"];
        for ch in self.input_names() {
            let values = if let Some(v) = raw.get(&ch).or_else(|| raw.u.get(&ch)) {
                v.clone()
            } else if let Some(f) = self.inputs.get(&ch) {
                f(exp, t)?
            } else {
                return Err(invalid(format!("missing input channel {ch}")));
            };
            if values.len() != t.len() || values.iter().any(|v| !v.is_finite()) {
                return Err(invalid(format!("invalid input channel {ch}")));
            }
            checked.u.insert(ch, values);
        }
        Ok(())
    }
    pub fn to_dict(&self, project: &Project) -> Result<Value> {
        let sim = &project.simulator;
        let mut settings = self.settings.clone();
        for name in project.catalog.keys() {
            let exp = sim
                .experiments
                .get(name)
                .ok_or_else(|| invalid(format!("unknown catalog experiment {name}")))?;
            for key in exp.as_object().unwrap().keys() {
                settings
                    .entry(key.clone())
                    .or_insert_with(|| json!({"label":key,"unit":"","role":"other"}));
            }
        }
        let p = sim
            .params
            .keys()
            .map(|k| (k.clone(), project.initial_value(k)))
            .collect();
        let mut experiments = Map::new();
        for name in project.catalog.keys() {
            let exp = sim.experiment(&json!(name))?;
            let result = sim.call(&p, &exp, SimOptions::default(), false)?;
            let source_t = &result["t"];
            if source_t.is_empty()
                || source_t.iter().any(|x| !x.is_finite())
                || source_t.windows(2).any(|w| w[0] >= w[1])
            {
                return Err(invalid("preview needs finite increasing times"));
            }
            let duration = exp
                .get("duration")
                .and_then(Value::as_f64)
                .unwrap_or(*source_t.last().unwrap());
            // Match numpy.linspace: multiply by the precomputed step, fixing the endpoint.
            let t: Vec<_> = (0..64)
                .map(|i| {
                    if i == 63 {
                        duration
                    } else {
                        i as f64 * (duration / 63.)
                    }
                })
                .collect();
            let mut u = Map::new();
            for (ch, values) in &result.u {
                u.insert(
                    ch.clone(),
                    json!(
                        t.iter()
                            .map(|x| round6(interpolate(*x, source_t, values)))
                            .collect::<Vec<_>>()
                    ),
                );
            }
            let mut entry = json!({"label":name,"description":"","views":[]})
                .as_object()
                .unwrap()
                .clone();
            if let Some(spec) = self.experiments.get(name) {
                entry.extend(spec.as_object().unwrap().clone());
            }
            entry.insert(
                "preview".into(),
                json!({"t":t.into_iter().map(round6).collect::<Vec<_>>(),"u":u}),
            );
            experiments.insert(name.clone(), Value::Object(entry));
        }
        let mut out = json!({"format":1,"simulator":sim.name,"channels":self.channels,"settings":settings,"experiments":experiments});
        if !self.params.is_empty() {
            out["params"] = json!(self.params);
        }
        if let Some(view) = &self.default_view {
            out["default_view"] = json!(view);
        }
        Ok(out)
    }
    pub fn canonical(&self, project: &Project) -> Result<Vec<u8>> {
        Ok(crate::canonical(&self.to_dict(project)?).into_bytes())
    }
    pub fn digest(&self, project: &Project) -> Result<String> {
        Ok(format!(
            "sha256:{}",
            crate::sha256_hex([self.canonical(project)?.as_slice()])
        ))
    }
}
impl FunctionSimulator {
    pub fn display(&self) -> Option<&Display> {
        self.display.as_ref()
    }
    pub fn with_display(mut self, display: Display) -> Result<Self> {
        display.validate(&self)?;
        self.display = Some(display);
        Ok(self)
    }
}
fn round6(x: f64) -> f64 {
    // Scientific formatting avoids log10/pow rounding errors at decimal ties.
    format!("{x:.5e}").parse().unwrap()
}
fn interpolate(x: f64, t: &[f64], y: &[f64]) -> f64 {
    if x <= t[0] {
        return y[0];
    }
    if x >= t[t.len() - 1] {
        return y[y.len() - 1];
    }
    let i = t.partition_point(|v| *v <= x) - 1;
    let slope = (y[i + 1] - y[i]) / (t[i + 1] - t[i]);
    y[i] + slope * (x - t[i])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn python_significant_digits_and_interpolation() {
        for (x, expected) in [
            (1.234565, 1.23456),
            (1.234575, 1.23457),
            (1234565., 1234560.),
            (1234575., 1234580.),
            (0.00001234565, 0.0000123456),
            (9.999999, 10.),
            (-2.12345678, -2.12346),
        ] {
            assert_eq!(round6(x), expected, "{x}");
        }
        assert!(round6(-0.).is_sign_negative());
        assert_eq!(interpolate(-1., &[0., 1.], &[2., 4.]), 2.);
        assert_eq!(interpolate(2., &[0., 1.], &[2., 4.]), 4.);
        assert_eq!(interpolate(0.25, &[0., 1.], &[2., 4.]), 2.5);
    }
}
