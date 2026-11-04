//! DOP853 with SciPy's initial-step, RMS error controller and dense polynomial.
//! The method tableau comes from differential-equations. Its generic driver uses
//! a different interpolation/controller convention, so this adapter preserves the
//! Python numerical reference's conventions (including discontinuous forcing).
use crate::simulator::*;
use differential_equations::tableau::ButcherTableau;
use std::sync::LazyLock;
static TABLE: LazyLock<ButcherTableau<f64, 12, 16>> = LazyLock::new(ButcherTableau::dop853);
fn rms(a: impl Iterator<Item = f64>, n: usize) -> f64 {
    (a.map(|v| v * v).sum::<f64>() / n as f64).sqrt()
}
pub fn integrate(
    rhs: impl Fn(f64, &[f64], &mut [f64]),
    y0: &[f64],
    times: &[f64],
    o: SimOptions,
    max_step: f64,
) -> Result<Vec<Vec<f64>>> {
    if times.is_empty()
        || y0.is_empty()
        || times.iter().any(|v| !v.is_finite())
        || times.windows(2).any(|w| w[1] <= w[0])
        || max_step <= 0.
    {
        return Err(invalid(
            "ODE needs finite, increasing times, states and positive max_step",
        ));
    }
    if times.len() == 1 {
        return Ok(y0.iter().map(|v| vec![*v]).collect());
    }
    let tab = &*TABLE;
    let n = y0.len();
    let end = *times.last().unwrap();
    let mut t = times[0];
    let mut y = y0.to_vec();
    let mut k = vec![vec![0.; n]; 16];
    rhs(t, &y, &mut k[0]);
    let sc: Vec<_> = y.iter().map(|v| o.atol + v.abs() * o.rtol).collect();
    let d0 = rms(y.iter().zip(&sc).map(|(v, s)| v / s), n);
    let d1 = rms(k[0].iter().zip(&sc).map(|(v, s)| v / s), n);
    let h0 = if d0 < 1e-5 || d1 < 1e-5 {
        1e-6
    } else {
        0.01 * d0 / d1
    }
    .min(end - t);
    let trial: Vec<_> = y.iter().zip(&k[0]).map(|(y, f)| y + h0 * f).collect();
    let mut f1 = vec![0.; n];
    rhs(t + h0, &trial, &mut f1);
    let d2 = rms(
        f1.iter().zip(&k[0]).zip(&sc).map(|((a, b), s)| (a - b) / s),
        n,
    ) / h0;
    let h1 = if d1 <= 1e-15 && d2 <= 1e-15 {
        1e-6_f64.max(h0 * 1e-3)
    } else {
        (0.01 / d1.max(d2)).powf(0.125)
    };
    let mut h = (100. * h0).min(h1).min(end - t).min(max_step);
    let mut output: Vec<Vec<f64>> = y0.iter().map(|v| vec![*v]).collect();
    let mut next = 1;
    let mut steps = 0;
    while t < end {
        steps += 1;
        if steps > 1000000 {
            return Err(SimulationError::Simulation("ODE step limit".into()));
        }
        let min_step = 10. * (t.next_up() - t).abs();
        h = h.min(max_step).max(min_step);
        let mut rejected = false;
        let (yn, tn, used, next_h) = loop {
            if h < min_step {
                return Err(SimulationError::Simulation(
                    "ODE step size underflow".into(),
                ));
            }
            let tn = (t + h).min(end);
            let used = tn - t;
            for stage in 1..12 {
                let state: Vec<_> = (0..n)
                    .map(|j| {
                        y[j] + used * (0..stage).map(|i| k[i][j] * tab.a[stage][i]).sum::<f64>()
                    })
                    .collect();
                rhs(t + tab.c[stage] * used, &state, &mut k[stage]);
            }
            let yn: Vec<_> = (0..n)
                .map(|j| y[j] + used * (0..12).map(|i| k[i][j] * tab.b[i]).sum::<f64>())
                .collect();
            rhs(tn, &yn, &mut k[12]);
            if yn.iter().any(|v| !v.is_finite()) {
                return Err(SimulationError::Simulation("ODE non-finite state".into()));
            }
            let mut err5 = 0.;
            let mut err3 = 0.;
            for j in 0..n {
                let scale = o.atol + o.rtol * y[j].abs().max(yn[j].abs());
                let e5 = (0..12).map(|i| k[i][j] * tab.er.unwrap()[i]).sum::<f64>() / scale;
                let e3 = (0..12)
                    .map(|i| k[i][j] * (tab.b[i] - tab.bh.unwrap()[i]))
                    .sum::<f64>()
                    / scale;
                err5 += e5 * e5;
                err3 += e3 * e3;
            }
            let error = if err5 == 0. && err3 == 0. {
                0.
            } else {
                used.abs() * err5 / ((err5 + 0.01 * err3) * n as f64).sqrt()
            };
            if error < 1. {
                let factor = if error == 0. {
                    10.
                } else {
                    (0.9 * error.powf(-0.125)).min(10.)
                };
                let factor = if rejected { factor.min(1.) } else { factor };
                break (yn, tn, used, used * factor);
            }
            h = used * (0.9 * error.powf(-0.125)).max(0.2);
            rejected = true;
        };
        if next < times.len() && times[next] <= tn {
            for stage in 13..16 {
                let state: Vec<_> = (0..n)
                    .map(|j| {
                        y[j] + used * (0..stage).map(|i| k[i][j] * tab.a[stage][i]).sum::<f64>()
                    })
                    .collect();
                rhs(t + tab.c[stage] * used, &state, &mut k[stage]);
            }
            let mut f = vec![vec![0.; n]; 7];
            for j in 0..n {
                let delta = yn[j] - y[j];
                f[0][j] = delta;
                f[1][j] = used * k[0][j] - delta;
                f[2][j] = 2. * delta - used * (k[12][j] + k[0][j]);
                for row in 3..7 {
                    f[row][j] = used
                        * (0..16)
                            .map(|i| tab.bi.unwrap()[row + 1][i] * k[i][j])
                            .sum::<f64>();
                }
            }
            while next < times.len() && times[next] <= tn {
                let x = (times[next] - t) / used;
                for j in 0..n {
                    let mut v = 0.;
                    for (i, coef) in f.iter().rev().enumerate() {
                        v += coef[j];
                        v *= if i % 2 == 0 { x } else { 1. - x };
                    }
                    output[j].push(v + y[j]);
                }
                next += 1;
            }
        }
        t = tn;
        y = yn;
        k[0] = k[12].clone();
        h = next_h;
    }
    if next != times.len() {
        return Err(SimulationError::Simulation(
            "ODE missing sample times".into(),
        ));
    }
    Ok(output)
}
