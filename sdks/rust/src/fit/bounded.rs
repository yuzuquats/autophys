//! Dense Coleman–Li reflective iteration, following SciPy's `trf_bounds`.
//! Trust-region subproblems and robust rho functions use trust-region-least-squares.
use super::*;
use nalgebra::{DMatrix, DVector};
use trust_region_least_squares::{
    loss::{Loss, LossFunction},
    trf::{check_termination, solve_lsq_trust_region, update_tr_radius},
};
pub(super) struct Solution {
    pub x: Vec<f64>,
    pub plain: f64,
    pub calls: usize,
    pub status: i32,
}
pub(super) fn loss(s: &str) -> Result<Loss> {
    Ok(match s {
        "linear" => Loss::Linear,
        "soft_l1" => Loss::SoftL1,
        "huber" => Loss::Huber,
        "cauchy" => Loss::Cauchy,
        "arctan" => Loss::Arctan,
        _ => return Err(invalid("unknown loss")),
    })
}
fn norm(x: &[f64]) -> f64 {
    x.iter().map(|v| v * v).sum::<f64>().sqrt()
}
fn dot(x: &[f64], y: &[f64]) -> f64 {
    x.iter().zip(y).map(|(a, b)| a * b).sum()
}
fn add(x: &[f64], y: &[f64]) -> Vec<f64> {
    x.iter().zip(y).map(|(a, b)| a + b).collect()
}
fn mul(x: &[f64], y: &[f64]) -> Vec<f64> {
    x.iter().zip(y).map(|(a, b)| a * b).collect()
}
fn scale(x: &[f64], a: f64) -> Vec<f64> {
    x.iter().map(|v| v * a).collect()
}
fn cl(x: &[f64], g: &[f64], lo: &[f64], hi: &[f64]) -> (Vec<f64>, Vec<f64>) {
    x.iter()
        .enumerate()
        .map(|(i, x)| {
            if g[i] < 0. {
                (hi[i] - x, -1.)
            } else if g[i] > 0. {
                (x - lo[i], 1.)
            } else {
                (1., 0.)
            }
        })
        .unzip()
}
fn feasible(x: &[f64], lo: &[f64], hi: &[f64], initial: bool) -> Vec<f64> {
    x.iter()
        .enumerate()
        .map(|(j, x)| {
            let mut v = *x;
            if initial {
                if v - lo[j] <= 1e-10 * lo[j].abs().max(1.) {
                    v = lo[j] + 1e-10 * lo[j].abs().max(1.);
                }
                if hi[j] - v <= 1e-10 * hi[j].abs().max(1.) {
                    v = hi[j] - 1e-10 * hi[j].abs().max(1.);
                }
            } else {
                if v <= lo[j] {
                    v = lo[j].next_up();
                }
                if v >= hi[j] {
                    v = hi[j].next_down();
                }
            }
            if v < lo[j] || v > hi[j] {
                0.5 * (lo[j] + hi[j])
            } else {
                v
            }
        })
        .collect()
}
fn fd(
    fun: &impl Fn(&[f64]) -> Result<Vec<f64>>,
    x: &[f64],
    f: &[f64],
    lo: &[f64],
    hi: &[f64],
) -> Result<DMatrix<f64>> {
    let mut j = DMatrix::zeros(f.len(), x.len());
    for k in 0..x.len() {
        let mut h = 1e-6 * x[k].abs() * if x[k] >= 0. { 1. } else { -1. };
        if x[k] + h == x[k] {
            h = f64::EPSILON.sqrt() * x[k].abs().max(1.) * if x[k] >= 0. { 1. } else { -1. };
        }
        if x[k] + h < lo[k] || x[k] + h > hi[k] {
            if h.abs() <= (x[k] - lo[k]).max(hi[k] - x[k]) {
                h = -h;
            } else if hi[k] - x[k] >= x[k] - lo[k] {
                h = hi[k] - x[k];
            } else {
                h = lo[k] - x[k];
            }
        }
        let mut xp = x.to_vec();
        xp[k] += h;
        let dx = xp[k] - x[k];
        let fp = fun(&xp)?;
        if fp.len() != f.len() {
            return Err(invalid("residual length changed"));
        }
        for i in 0..f.len() {
            j[(i, k)] = (fp[i] - f[i]) / dx;
        }
    }
    Ok(j)
}
fn weighted(j: &DMatrix<f64>, f: &[f64], loss: &LossFunction) -> (DMatrix<f64>, Vec<f64>, f64) {
    if loss.loss == Loss::Linear {
        return (j.clone(), f.to_vec(), 0.5 * dot(f, f));
    }
    let rho = loss.evaluate(f);
    let mut j = j.clone();
    let mut out = f.to_vec();
    for i in 0..f.len() {
        let s = (rho.rho1[i] + 2. * rho.rho2[i] * f[i] * f[i])
            .max(f64::EPSILON)
            .sqrt();
        out[i] *= rho.rho1[i] / s;
        for k in 0..j.ncols() {
            j[(i, k)] *= s;
        }
    }
    (j, out, 0.5 * rho.rho0.iter().sum::<f64>())
}
fn cost(f: &[f64], loss: &LossFunction) -> f64 {
    if loss.loss == Loss::Linear {
        0.5 * dot(f, f)
    } else {
        0.5 * loss.evaluate(f).rho0.iter().sum::<f64>()
    }
}
fn jac_scale(j: &DMatrix<f64>, old: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let inv: Vec<_> = (0..j.ncols())
        .map(|k| {
            let s = j.column(k).norm();
            if old.is_empty() {
                if s == 0. { 1. } else { s }
            } else {
                s.max(old[k])
            }
        })
        .collect();
    (inv.iter().map(|v| 1. / v).collect(), inv)
}
fn bound_stride(x: &[f64], p: &[f64], lo: &[f64], hi: &[f64]) -> (f64, Vec<bool>) {
    let strides: Vec<_> = (0..x.len())
        .map(|i| {
            if p[i] > 0. {
                (hi[i] - x[i]) / p[i]
            } else if p[i] < 0. {
                (lo[i] - x[i]) / p[i]
            } else {
                f64::INFINITY
            }
        })
        .collect();
    let a = strides.iter().copied().fold(f64::INFINITY, f64::min);
    (a, strides.iter().map(|s| *s == a).collect())
}
fn quadratic(j: &DMatrix<f64>, diag: &[f64], g: &[f64], s: &[f64]) -> f64 {
    let js = j * DVector::from_column_slice(s);
    0.5 * (js.norm_squared() + diag.iter().zip(s).map(|(d, s)| d * s * s).sum::<f64>()) + dot(s, g)
}
fn line_min(
    j: &DMatrix<f64>,
    diag: &[f64],
    g: &[f64],
    direction: &[f64],
    origin: &[f64],
    lo: f64,
    hi: f64,
) -> (Vec<f64>, f64) {
    let jd = j * DVector::from_column_slice(direction);
    let jo = j * DVector::from_column_slice(origin);
    let a = 0.5
        * (jd.norm_squared()
            + diag
                .iter()
                .zip(direction)
                .map(|(d, s)| d * s * s)
                .sum::<f64>());
    let b = jd.dot(&jo)
        + dot(direction, g)
        + diag
            .iter()
            .zip(direction)
            .zip(origin)
            .map(|((d, s), o)| d * s * o)
            .sum::<f64>();
    let mut best = (vec![], f64::INFINITY);
    for t in [
        lo,
        hi,
        if a != 0. {
            (-0.5 * b / a).clamp(lo, hi)
        } else {
            lo
        },
    ] {
        let s = add(origin, &scale(direction, t));
        let q = quadratic(j, diag, g, &s);
        if q < best.1 {
            best = (s, q);
        }
    }
    best
}
#[allow(clippy::too_many_arguments)]
fn select(
    x: &[f64],
    jh: &DMatrix<f64>,
    diag: &[f64],
    gh: &[f64],
    ph: &[f64],
    d: &[f64],
    delta: f64,
    lo: &[f64],
    hi: &[f64],
    theta: f64,
) -> (Vec<f64>, Vec<f64>, f64) {
    let p = mul(d, ph);
    if x.iter()
        .zip(&p)
        .enumerate()
        .all(|(j, (x, p))| x + p >= lo[j] && x + p <= hi[j])
    {
        return (p, ph.to_vec(), -quadratic(jh, diag, gh, ph));
    }
    let (stride, hits) = bound_stride(x, &p, lo, hi);
    let rh: Vec<_> = ph
        .iter()
        .zip(hits)
        .map(|(v, h)| if h { -v } else { *v })
        .collect();
    let r = mul(d, &rh);
    let ph = scale(ph, stride);
    let on = add(x, &mul(d, &ph));
    let a = dot(&rh, &rh);
    let b = dot(&ph, &rh);
    let c = dot(&ph, &ph) - delta * delta;
    let to_tr = (-b + (b * b - a * c).max(0.).sqrt()) / a;
    let (to_bound, _) = bound_stride(&on, &r, lo, hi);
    let r_stride = to_bound.min(to_tr);
    let mut choices = vec![];
    if r_stride > 0. {
        let rl = (1. - theta) * stride / r_stride;
        let ru = if r_stride == to_bound {
            theta * to_bound
        } else {
            to_tr
        };
        if rl <= ru {
            choices.push(line_min(jh, diag, gh, &rh, &ph, rl, ru));
        }
    }
    let p = scale(&ph, theta);
    let q = quadratic(jh, diag, gh, &p);
    choices.push((p, q));
    let ag = scale(gh, -1.);
    let to_tr = delta / norm(&ag);
    let (to_bound, _) = bound_stride(x, &mul(d, &ag), lo, hi);
    let upper = if to_bound < to_tr {
        theta * to_bound
    } else {
        to_tr
    };
    choices.push(line_min(jh, diag, gh, &ag, &vec![0.; x.len()], 0., upper));
    let (sh, q) = choices
        .into_iter()
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .unwrap();
    (mul(d, &sh), sh, -q)
}
#[allow(clippy::too_many_arguments)]
pub(super) fn solve(
    fun: &impl Fn(&[f64]) -> Result<Vec<f64>>,
    x0: &[f64],
    lo: &[f64],
    hi: &[f64],
    loss: Loss,
    f_scale: f64,
    max_nfev: usize,
) -> Result<Solution> {
    let lf = LossFunction::new(loss, f_scale);
    let n = x0.len();
    let mut x = feasible(x0, lo, hi, true);
    let mut f = fun(&x)?;
    let m = f.len();
    let mut calls = 1;
    let mut nfev = 1;
    let rawj = fd(fun, &x, &f, lo, hi)?;
    calls += n;
    let (mut j, mut fw, mut cost0) = weighted(&rawj, &f, &lf);
    let mut g = (&j.transpose() * DVector::from_column_slice(&fw))
        .as_slice()
        .to_vec();
    let (mut sc, mut inv) = jac_scale(&j, &[]);
    let (mut v, dv) = cl(&x, &g, lo, hi);
    for k in 0..n {
        if dv[k] != 0. {
            v[k] *= inv[k];
        }
    }
    let mut delta = norm(
        &(0..n)
            .map(|k| x[k] * inv[k] / v[k].sqrt())
            .collect::<Vec<_>>(),
    );
    if delta == 0. {
        delta = 1.;
    }
    let mut alpha = 0.;
    let mut status = 0;
    while nfev < max_nfev {
        let (mut v, dv) = cl(&x, &g, lo, hi);
        let gn = mul(&g, &v).iter().map(|v| v.abs()).fold(0., f64::max);
        if gn < 1e-8 {
            status = 1;
            break;
        }
        for k in 0..n {
            if dv[k] != 0. {
                v[k] *= inv[k];
            }
        }
        let d: Vec<_> = (0..n).map(|k| v[k].sqrt() * sc[k]).collect();
        let diag: Vec<_> = (0..n).map(|k| g[k] * dv[k] * sc[k]).collect();
        let gh = mul(&d, &g);
        let mut jh = j.clone();
        for k in 0..n {
            jh.column_mut(k).scale_mut(d[k]);
        }
        let mut aug = DMatrix::zeros(m + n, n);
        aug.view_mut((0, 0), (m, n)).copy_from(&jh);
        for k in 0..n {
            aug[(m + k, k)] = diag[k].sqrt();
        }
        let svd = aug.svd(true, true);
        let u = svd.u.unwrap();
        let vt = svd.v_t.unwrap();
        let mut fa = DVector::zeros(m + n);
        fa.rows_mut(0, m)
            .copy_from(&DVector::from_column_slice(&fw));
        let uf = u.transpose() * fa;
        let vtr: Vec<_> = (0..n)
            .flat_map(|i| {
                (0..n).map({
                    let vt = &vt;
                    move |k| vt[(i, k)]
                })
            })
            .collect();
        let theta = 0.995_f64.max(1. - gn);
        let mut actual = -1.;
        let mut trial = x.clone();
        let mut fnew = f.clone();
        let mut cnew = cost0;
        while actual <= 0. && nfev < max_nfev {
            let (ph, a) = solve_lsq_trust_region(
                n,
                m,
                uf.as_slice(),
                svd.singular_values.as_slice(),
                &vtr,
                delta,
                alpha,
            )
            .map_err(|e| invalid(e.to_string()))?;
            alpha = a;
            let (step, sh, pred) = select(&x, &jh, &diag, &gh, &ph, &d, delta, lo, hi, theta);
            trial = feasible(&add(&x, &step), lo, hi, false);
            fnew = fun(&trial)?;
            nfev += 1;
            calls += 1;
            let shn = norm(&sh);
            if fnew.iter().any(|v| !v.is_finite()) {
                delta = 0.25 * shn;
                continue;
            }
            cnew = cost(&fnew, &lf);
            actual = cost0 - cnew;
            let (dn, ratio) = update_tr_radius(delta, actual, pred, shn, shn > 0.95 * delta);
            if let Some(s) =
                check_termination(actual, cost0, norm(&step), norm(&x), ratio, 1e-8, 1e-8)
            {
                status = s;
                break;
            }
            if dn == 0. {
                status = 3;
                break;
            }
            alpha *= delta / dn;
            delta = dn;
        }
        if actual > 0. {
            x = trial;
            f = fnew;
            cost0 = cnew;
            let rawj = fd(fun, &x, &f, lo, hi)?;
            calls += n;
            let weighted = weighted(&rawj, &f, &lf);
            j = weighted.0;
            fw = weighted.1;
            g = (&j.transpose() * DVector::from_column_slice(&fw))
                .as_slice()
                .to_vec();
            (sc, inv) = jac_scale(&j, &inv);
        }
        if status != 0 {
            break;
        }
    }
    Ok(Solution {
        x,
        plain: dot(&f, &f),
        calls,
        status,
    })
}
