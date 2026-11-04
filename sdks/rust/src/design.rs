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
pub const AFTER_RESOLVED_MAX: f64 = 1.;
pub const OUTLOOK_MAX_BYTES: usize = 900 * 1024;
#[derive(Clone, Debug)]
pub struct OutlookOptions {
    pub max_simulations: usize,
    pub at: String,
    pub jacobian_scale: f64,
}
impl Default for OutlookOptions {
    fn default() -> Self {
        Self {
            max_simulations: 50000,
            at: "fit".into(),
            jacobian_scale: 1.,
        }
    }
}
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
    pub after_resolved_max: f64,
    pub at: String,
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
        // Off the grid, the proposed value is inserted, so the axis has
        // `points + 1` values (E-1b: 12-13 with the default grid), as Python.
        vals.push(value);
        vals.sort_by(f64::total_cmp);
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
    outlook_with_options(
        sim,
        p,
        obs,
        noise,
        settings,
        edit,
        which,
        points,
        j0,
        &Default::default(),
    )
}
/// Outlook with bounded simulation/payload costs and estimate-origin metadata.
#[allow(clippy::too_many_arguments)]
pub fn outlook_with_options(
    sim: &dyn Simulator,
    p: &Params,
    obs: &[Observation],
    noise: &Params,
    settings: &Value,
    edit: &IndexMap<String, [f64; 2]>,
    which: &str,
    mut points: usize,
    j0: Option<&DMatrix<f64>>,
    options: &OutlookOptions,
) -> Result<(Outlook, f64, Params)> {
    if edit.len() > OUTLOOK_MAX_AXES || !(2..=OUTLOOK_POINTS).contains(&points) {
        return Err(invalid(
            "outlook permits at most 3 axes and 2..12 points per axis",
        ));
    }
    if !options.jacobian_scale.is_finite() || options.jacobian_scale <= 0. {
        return Err(invalid("jacobian_scale must be finite and positive"));
    }
    let n = sim.params().len();
    let per_cell = 2 * n + 1;
    let base = per_cell + if j0.is_none() { 2 * n * obs.len() } else { 0 };
    let axes = loop {
        let axes: Vec<_> = edit
            .iter()
            .map(|(name, [lo, hi])| {
                Ok(Axis {
                    name: name.clone(),
                    values: axis(*lo, *hi, number(settings, name)?, points)?,
                })
            })
            .collect::<Result<_>>()?;
        let cells = axes.iter().map(|a| a.values.len()).product::<usize>();
        let skeleton = serde_json::json!({"axes":axes,"score":[],
            "after":sim.param_names().into_iter().map(|n| (n, Vec::<f64>::new())).collect::<IndexMap<_,_>>(),
            "after_resolved_max":AFTER_RESOLVED_MAX,"at":options.at});
        let bytes = crate::canonical::canonical(&skeleton).len() + cells * (n + 1) * 25;
        if base + cells * per_cell <= options.max_simulations && bytes <= OUTLOOK_MAX_BYTES {
            break axes;
        }
        if points == 2 || edit.is_empty() {
            return Err(invalid(
                "outlook limits cannot fit the minimum grid (2 points per axis plus the proposed value)",
            ));
        }
        points -= 1;
    };
    let owned_j;
    let j = match j0 {
        Some(j) => Some(j),
        None if !obs.is_empty() => {
            owned_j = jacobian(sim, p, obs, 1e-4, FIT_OPTIONS)? / options.jacobian_scale;
            Some(&owned_j)
        }
        None => None,
    };
    let f0 = base_information(sim, p, &[], j)?;
    let (score, after) = settings_score(sim, p, &f0, noise, settings, which)?;
    let mut grid = outlook_axes(sim, p, &f0, noise, settings, axes, which)?;
    grid.at = options.at.clone();
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
        after_resolved_max: AFTER_RESOLVED_MAX,
        at: "fit".into(),
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
    fn axis_inserts_an_off_grid_value() {
        // 0.5 is not one of the 12 evenly spaced points over [0, 1].
        let a = axis(0., 1., 0.5, 12).unwrap();
        assert_eq!(a.len(), 13);
        assert!(a.contains(&0.5));
        assert_eq!(a[0], 0.);
        assert_eq!(*a.last().unwrap(), 1.);
        assert!(a.windows(2).all(|w| w[0] < w[1]));
        // An on-grid value replaces its grid point.
        assert_eq!(axis(0., 1., 1. / 11., 12).unwrap().len(), 12);
    }
    #[test]
    fn outlook_limits_preflight_and_shrink() {
        let sim = crate::models::thermal_rc();
        let params = [("C".into(), 500.), ("R".into(), 2.)].into_iter().collect();
        let noise = [("T".into(), 0.05)].into_iter().collect();
        let settings = sim.experiment(&Value::from("step_long")).unwrap();
        let edit = [("power".into(), [1., 10.])].into_iter().collect();
        let before = sim.calls();
        assert!(
            outlook_with_options(
                &sim,
                &params,
                &[],
                &noise,
                &settings,
                &edit,
                "min_eig",
                12,
                None,
                &OutlookOptions {
                    max_simulations: 4,
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert_eq!(sim.calls(), before);
        let (grid, _, _) = outlook_with_options(
            &sim,
            &params,
            &[],
            &noise,
            &settings,
            &edit,
            "min_eig",
            12,
            None,
            &OutlookOptions {
                max_simulations: 25,
                at: "initial".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(grid.axes[0].values.len(), 4);
        assert_eq!(sim.calls() - before, 25);
        assert_eq!(grid.at, "initial");
        assert_eq!(grid.after_resolved_max, 1.);
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
