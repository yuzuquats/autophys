//! Fisher-information experiment ranking and row-major E-1 outlook grids.
use crate::{data::Observation, sensitivity::jacobian, simulator::*};
use indexmap::IndexMap;
use nalgebra::{DMatrix, SymmetricEigen};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate {
    pub experiment: String,
    pub min_eig: f64,
    pub d_opt: f64,
    pub min_eig_gain: f64,
    pub worst_direction: Params,
}
impl Candidate {
    pub fn to_dict(&self) -> Value {
        serde_json::to_value(self).unwrap()
    }
}
pub const OUTLOOK_POINTS: usize = 12;
pub const OUTLOOK_MAX_AXES: usize = 3;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Axis {
    pub name: String,
    pub values: Vec<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outlook {
    pub axes: Vec<Axis>,
    pub score: Vec<f64>,
    pub after: IndexMap<String, Vec<f64>>,
}
pub fn fisher(j: &DMatrix<f64>) -> DMatrix<f64> {
    j.transpose() * j
}
fn criterion(c: &str) -> Result<()> {
    if ["min_eig", "d_opt"].contains(&c) {
        Ok(())
    } else {
        Err(invalid("criterion must be min_eig or d_opt"))
    }
}
fn template(
    sim: &dyn Simulator,
    p: &Params,
    name: &str,
    settings: &Value,
    noise: &Params,
) -> Result<Observation> {
    let t = time_grid(settings)?;
    let pred = sim.simulate(p, settings, FIT_OPTIONS)?;
    let mut y = IndexMap::new();
    let mut sigma = Params::new();
    for ch in pred.keys().filter(|k| k.as_str() != "t") {
        let s = noise
            .get(ch)
            .ok_or_else(|| invalid(format!("no declared sigma for {ch}")))?;
        y.insert(ch.clone(), vec![0.; t.len()]);
        sigma.insert(ch.clone(), *s);
    }
    Observation::new(name, settings.clone(), t, y, sigma)
}
pub fn base_information(
    sim: &dyn Simulator,
    p: &Params,
    obs: &[Observation],
    j0: Option<&DMatrix<f64>>,
) -> Result<DMatrix<f64>> {
    Ok(match j0 {
        Some(j) => fisher(j),
        None => {
            if obs.is_empty() {
                DMatrix::zeros(sim.params().len(), sim.params().len())
            } else {
                fisher(&jacobian(sim, p, obs, 1e-4, FIT_OPTIONS)?)
            }
        }
    })
}
fn eigen(f: &DMatrix<f64>) -> (Vec<f64>, DMatrix<f64>) {
    let e = SymmetricEigen::new(f.clone());
    let mut order: Vec<_> = (0..e.eigenvalues.len()).collect();
    order.sort_by(|a, b| e.eigenvalues[*a].total_cmp(&e.eigenvalues[*b]));
    let w = order.iter().map(|i| e.eigenvalues[*i]).collect();
    let mut v = DMatrix::zeros(f.nrows(), f.ncols());
    for (j, i) in order.iter().enumerate() {
        v.column_mut(j).copy_from(&e.eigenvectors.column(*i));
    }
    (w, v)
}
fn logdet(f: &DMatrix<f64>, eps: f64) -> f64 {
    let mut a = f.clone();
    for i in 0..a.nrows() {
        a[(i, i)] += eps;
    }
    let lu = a.lu();
    lu.u().diagonal().iter().map(|d| d.abs().ln()).sum()
}
pub fn rank_experiments(
    sim: &dyn Simulator,
    p: &Params,
    obs: &[Observation],
    noise: &Params,
    candidates: Option<&[String]>,
    which: &str,
    j0: Option<&DMatrix<f64>>,
) -> Result<Vec<Candidate>> {
    criterion(which)?;
    if sim.params().is_empty() {
        return Err(invalid("ranking needs free parameters"));
    }
    let f0 = base_information(sim, p, obs, j0)?;
    let eps = 1e-9 * f0.trace().max(1.);
    let log0 = logdet(&f0, eps);
    let (w0, _) = eigen(&f0);
    let names: Vec<_> = candidates
        .filter(|c| !c.is_empty())
        .map(|v| v.to_vec())
        .unwrap_or_else(|| sim.experiments().keys().cloned().collect());
    let mut out = vec![];
    for name in names {
        let settings = sim.experiment(&Value::String(name.clone()))?;
        let o = template(sim, p, &name, &settings, noise)?;
        let f = &f0 + fisher(&jacobian(sim, p, &[o], 1e-4, FIT_OPTIONS)?);
        let (w, v) = eigen(&f);
        out.push(Candidate {
            experiment: name,
            min_eig: w[0].max(0.),
            d_opt: logdet(&f, eps) - log0,
            min_eig_gain: w[0].max(0.) - w0[0].max(0.),
            worst_direction: sim
                .param_names()
                .into_iter()
                .enumerate()
                .map(|(i, k)| (k, v[(i, 0)]))
                .collect(),
        });
    }
    out.sort_by(|a, b| {
        if which == "min_eig" {
            b.min_eig.total_cmp(&a.min_eig)
        } else {
            b.d_opt.total_cmp(&a.d_opt)
        }
    });
    Ok(out)
}
pub fn settings_score(
    sim: &dyn Simulator,
    p: &Params,
    f0: &DMatrix<f64>,
    noise: &Params,
    settings: &Value,
    which: &str,
) -> Result<(f64, Params)> {
    criterion(which)?;
    if sim.params().is_empty() {
        return Err(invalid("outlook needs free parameters"));
    }
    let eps = 1e-9 * f0.trace().max(1.);
    let o = template(sim, p, "<outlook>", settings, noise)?;
    let f = f0 + fisher(&jacobian(sim, p, &[o], 1e-4, FIT_OPTIONS)?);
    let (w, v) = eigen(&f);
    let score = if which == "min_eig" {
        w[0].max(0.)
    } else {
        logdet(&f, eps) - logdet(f0, eps)
    };
    let after = sim
        .param_names()
        .into_iter()
        .enumerate()
        .map(|(j, k)| {
            (
                k,
                (0..w.len())
                    .map(|i| v[(j, i)].powi(2) / w[i].max(eps))
                    .sum::<f64>()
                    .sqrt(),
            )
        })
        .collect();
    Ok((score, after))
}
fn axis(lo: f64, hi: f64, value: f64, points: usize) -> Result<Vec<f64>> {
    if !lo.is_finite() || !hi.is_finite() || lo >= hi || value < lo || value > hi {
        return Err(invalid(
            "axis needs finite lo < hi containing the proposed value",
        ));
    }
    let mut vals: Vec<_> = (0..points)
        .map(|i| lo + (hi - lo) * i as f64 / (points - 1) as f64)
        .collect();
    let tol = 1e-12 * (hi - lo).abs().max(1e-300);
    if let Some(i) = vals.iter().position(|v| (v - value).abs() <= tol) {
        vals[i] = value;
    } else {
        vals.push(value);
        vals.sort_by(f64::total_cmp);
        if vals.len() > OUTLOOK_POINTS {
            let i = (1..vals.len() - 1)
                .filter(|i| vals[*i] != value)
                .min_by(|a, b| {
                    (vals[*a] - value)
                        .abs()
                        .total_cmp(&(vals[*b] - value).abs())
                })
                .unwrap();
            vals.remove(i);
        }
    }
    Ok(vals)
}
#[allow(clippy::too_many_arguments)]
pub fn outlook(
    sim: &dyn Simulator,
    p: &Params,
    obs: &[Observation],
    noise: &Params,
    settings: &Value,
    edit: &IndexMap<String, [f64; 2]>,
    which: &str,
    points: usize,
    j0: Option<&DMatrix<f64>>,
) -> Result<(Outlook, f64, Params)> {
    if edit.len() > OUTLOOK_MAX_AXES || !(2..=OUTLOOK_POINTS).contains(&points) {
        return Err(invalid(
            "outlook permits at most 3 axes and 2..12 points per axis",
        ));
    }
    let f0 = base_information(sim, p, obs, j0)?;
    let (score, after) = settings_score(sim, p, &f0, noise, settings, which)?;
    let mut axes = vec![];
    for (n, [lo, hi]) in edit {
        axes.push(Axis {
            name: n.clone(),
            values: axis(*lo, *hi, number(settings, n)?, points)?,
        });
    }
    let grid = outlook_axes(sim, p, &f0, noise, settings, axes, which)?;
    Ok((grid, score, after))
}
pub fn outlook_axes(
    sim: &dyn Simulator,
    p: &Params,
    f0: &DMatrix<f64>,
    noise: &Params,
    settings: &Value,
    axes: Vec<Axis>,
    which: &str,
) -> Result<Outlook> {
    if axes.len() > 3
        || axes.iter().any(|a| {
            a.values.is_empty() || a.values.len() > 12 || a.values.iter().any(|v| !v.is_finite())
        })
    {
        return Err(invalid(
            "outlook axes exceed 3 x 12 or contain invalid values",
        ));
    }
    let count = axes.iter().map(|a| a.values.len()).product::<usize>();
    let mut grid = Outlook {
        axes,
        score: vec![],
        after: sim.param_names().into_iter().map(|n| (n, vec![])).collect(),
    };
    for flat in 0..count {
        let mut index = flat;
        let mut s = settings.clone();
        for axis in grid.axes.iter().rev() {
            let i = index % axis.values.len();
            index /= axis.values.len();
            s[&axis.name] = Value::from(axis.values[i]);
        }
        let (sc, af) = settings_score(sim, p, f0, noise, &s, which)?;
        grid.score.push(sc);
        for (k, v) in af {
            grid.after.get_mut(&k).unwrap().push(v);
        }
    }
    Ok(grid)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn axis_cap() {
        let a = axis(0., 1., 0.5, 12).unwrap();
        assert_eq!(a.len(), 12);
        assert!(a.contains(&0.5));
        assert_eq!(a[0], 0.);
        assert_eq!(*a.last().unwrap(), 1.);
    }
    #[test]
    fn fisher_matrix() {
        let j = DMatrix::from_row_slice(2, 2, &[1., 2., 3., 4.]);
        assert_eq!(
            fisher(&j),
            DMatrix::from_row_slice(2, 2, &[10., 14., 14., 20.])
        );
    }
}
