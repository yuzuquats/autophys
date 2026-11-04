//! Central differences, singular directions and Python's identifiability rule.
use crate::{data::Observation, fit::residuals, simulator::*};
use indexmap::IndexMap;
use nalgebra::DMatrix;
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct IdentifiabilityRule {
    pub rel_tol: f64,
    pub max_log_std: f64,
    pub loading_tol: f64,
}
pub const DEFAULT_RULE: IdentifiabilityRule = IdentifiabilityRule {
    rel_tol: 1e-3,
    max_log_std: 0.1,
    loading_tol: 0.2,
};
impl Default for IdentifiabilityRule {
    fn default() -> Self {
        DEFAULT_RULE
    }
}
impl IdentifiabilityRule {
    pub fn describe(&self) -> String {
        format!(
            "direction non-identifiable if s_i < {}*s_max (structural) or 1/s_i > {} (practical); parameter identified iff |loading| <= {} on every such direction and marginal log-std <= {}",
            self.rel_tol, self.max_log_std, self.loading_tol, self.max_log_std
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Direction {
    pub singular_value: f64,
    pub log_std: f64,
    pub vector: Params,
    pub kind: String,
    pub combination: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SensitivityReport {
    pub params: Vec<String>,
    pub singular_values: Vec<f64>,
    pub condition_number: f64,
    pub directions: Vec<Direction>,
    pub marginal_log_std: Params,
    pub identified: Vec<String>,
    pub non_identified: Vec<String>,
    pub rule: String,
    pub at: Params,
}
impl SensitivityReport {
    pub fn non_identifiable_directions(&self) -> Vec<&Direction> {
        self.directions
            .iter()
            .filter(|d| d.kind != "identifiable")
            .collect()
    }
    pub fn to_dict(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap()
    }
}
pub fn jacobian(
    sim: &dyn Simulator,
    p: &Params,
    obs: &[Observation],
    step: f64,
    options: SimOptions,
) -> Result<DMatrix<f64>> {
    sim.validate_params(p)?;
    if !step.is_finite() || step <= 0. {
        return Err(invalid("Jacobian step must be finite and positive"));
    }
    let x = sim.to_x(p);
    let (lo, hi) = sim.x_bounds();
    let mut columns = vec![];
    let mut m = 0;
    for j in 0..x.len() {
        let mut xp = x.clone();
        let mut xm = x.clone();
        xp[j] = (x[j] + step).min(hi[j]);
        xm[j] = (x[j] - step).max(lo[j]);
        let rp = residuals(sim, &sim.from_x(&xp), obs, options)?;
        let rm = residuals(sim, &sim.from_x(&xm), obs, options)?;
        m = rp.len();
        columns.extend(rp.iter().zip(rm).map(|(a, b)| (a - b) / (xp[j] - xm[j])));
    }
    Ok(DMatrix::from_column_slice(m, x.len(), &columns))
}
pub fn analyze(
    sim: &dyn Simulator,
    p: &Params,
    obs: &[Observation],
    rule: IdentifiabilityRule,
    jac: Option<&DMatrix<f64>>,
) -> Result<(SensitivityReport, DMatrix<f64>)> {
    let j = match jac {
        Some(j) => j.clone(),
        None => jacobian(sim, p, obs, 1e-4, FIT_OPTIONS)?,
    };
    Ok((report_from_jacobian(&sim.param_names(), &j, rule, p)?, j))
}
pub fn combination(names: &[String], v: &[f64], floor: f64) -> String {
    let i = v
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()).then_with(|| b.0.cmp(&a.0)))
        .map(|v| v.0)
        .unwrap_or(0);
    if v.is_empty() || v[i] == 0. {
        return "(none)".into();
    }
    names
        .iter()
        .zip(v)
        .filter_map(|(n, c)| {
            let w = c / v[i];
            (w.abs() >= floor).then(|| format!("{n}^{}", significant(w, 2)))
        })
        .collect::<Vec<_>>()
        .join(" * ")
}
pub(crate) fn significant(v: f64, d: usize) -> String {
    if !v.is_finite() {
        return if v.is_nan() {
            "nan"
        } else if v < 0. {
            "-inf"
        } else {
            "inf"
        }
        .into();
    }
    if v == 0. {
        return "0".into();
    }
    let e = v.abs().log10().floor() as i32;
    let rounded = (v * 10_f64.powi(d as i32 - 1 - e)).round() / 10_f64.powi(d as i32 - 1 - e);
    let e = rounded.abs().log10().floor() as i32;
    if e < -4 || e >= d as i32 {
        let s = format!("{:.*e}", d - 1, rounded);
        let (m, exp) = s.split_once('e').unwrap();
        let m = m.trim_end_matches('0').trim_end_matches('.');
        format!("{m}e{:+03}", exp.parse::<i32>().unwrap())
    } else {
        let places = (d as i32 - 1 - e).max(0) as usize;
        let s = format!("{:.*}", places, rounded);
        if places > 0 {
            s.trim_end_matches('0').trim_end_matches('.').into()
        } else {
            s
        }
    }
}
pub fn report_from_jacobian(
    names: &[String],
    j: &DMatrix<f64>,
    rule: IdentifiabilityRule,
    at: &Params,
) -> Result<SensitivityReport> {
    let p = names.len();
    if j.ncols() != p || j.iter().any(|v| !v.is_finite()) {
        return Err(invalid("invalid Jacobian"));
    }
    let (s, vt) = if j.nrows() == 0 || p == 0 {
        (vec![], DMatrix::zeros(0, p))
    } else {
        let svd = j.clone().svd(false, true);
        (svd.singular_values.as_slice().to_vec(), svd.v_t.unwrap())
    };
    let mut singular_values = vec![0.; p];
    singular_values[..s.len()].copy_from_slice(&s);
    let max = singular_values.iter().copied().fold(0., f64::max);
    let mut directions = vec![];
    for i in 0..p {
        let si = singular_values[i];
        let log_std = if si <= 0. { f64::INFINITY } else { 1. / si };
        let kind = if si < rule.rel_tol * max || max == 0. {
            "structural"
        } else if log_std > rule.max_log_std {
            "practical"
        } else {
            "identifiable"
        };
        let vector: Vec<_> = (0..p)
            .map(|k| if i < vt.nrows() { vt[(i, k)] } else { 0. })
            .collect();
        directions.push(Direction {
            singular_value: si,
            log_std,
            vector: names.iter().cloned().zip(vector.clone()).collect(),
            kind: kind.into(),
            combination: combination(names, &vector, 0.1),
        });
    }
    let mut marginal_log_std = IndexMap::new();
    let mut identified = vec![];
    let mut non_identified = vec![];
    for n in names {
        let var = directions
            .iter()
            .filter(|d| d.kind == "identifiable")
            .map(|d| (d.vector[n] / d.singular_value).powi(2))
            .sum::<f64>();
        let loads = directions
            .iter()
            .filter(|d| d.kind != "identifiable")
            .map(|d| d.vector[n].abs())
            .fold(0., f64::max);
        let std = if loads <= rule.loading_tol {
            var.sqrt()
        } else {
            f64::INFINITY
        };
        marginal_log_std.insert(n.clone(), std);
        if std <= rule.max_log_std {
            identified.push(n.clone());
        } else {
            non_identified.push(n.clone());
        }
    }
    let min = singular_values
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min);
    Ok(SensitivityReport {
        params: names.to_vec(),
        singular_values,
        condition_number: if min == 0. || p == 0 {
            f64::INFINITY
        } else {
            max / min
        },
        directions,
        marginal_log_std,
        identified,
        non_identified,
        rule: rule.describe(),
        at: at.clone(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rule() {
        let names = vec!["a".into(), "b".into()];
        let j = DMatrix::from_row_slice(2, 2, &[100., 0., 0., 0.]);
        let r = report_from_jacobian(&names, &j, DEFAULT_RULE, &Params::new()).unwrap();
        assert_eq!(r.identified, vec!["a"]);
        assert_eq!(r.non_identified, vec!["b"]);
    }
    #[test]
    fn combinations() {
        assert_eq!(
            combination(&["a".into(), "b".into()], &[-0.7, -0.7], 0.1),
            "a^1 * b^1"
        );
    }
}
