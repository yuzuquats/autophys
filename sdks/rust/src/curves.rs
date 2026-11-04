//! FC-1 display curves: uncounted truth-accuracy predictions, never agent facts.
use crate::{Record, data::Observation, fit::FitResult, simulator::*};
use serde_json::{Map, Value, json};

const RUN_BYTES: usize = 256 * 1024;
fn error(e: impl std::fmt::Display) -> crate::Error {
    crate::Error::BadRequest(e.to_string())
}
fn indices(n: usize, limit: usize) -> Vec<usize> {
    let m = n.min(limit);
    if m <= 1 {
        return (0..m).collect();
    }
    // NumPy linspace multiplies by the step, then overwrites its endpoint.
    let step = (n - 1) as f64 / (m - 1) as f64;
    (0..m)
        .map(|i| {
            if i == m - 1 {
                n - 1
            } else {
                (i as f64 * step).round_ties_even() as usize
            }
        })
        .collect()
}
fn round6(x: f64) -> f64 {
    format!("{x:.5e}").parse().unwrap()
}
/// Same contract as Python `curves.run_payload`. Uses recorded measurement ids
/// and their full grids; every size retry resamples the original predictions.
pub fn run_payload(
    sim: &FunctionSimulator,
    result: &FitResult,
    measurements: &[Record],
    mut payload: Value,
) -> crate::Result<Value> {
    let start = result
        .starts
        .iter()
        .reduce(|a, b| if b.loss < a.loss { b } else { a })
        .ok_or_else(|| error("curve generation needs a fit start"))?;
    let initial = sim.from_x(&start.x0);
    let options = SimOptions {
        seed: if sim.stochastic { result.seed } else { None },
        ..TRUTH_OPTIONS
    };
    let mut full = vec![];
    for record in measurements {
        let obs = Observation::from_dict(record.payload["observation"].clone()).map_err(error)?;
        if !["train", "validation"].contains(&obs.split.as_str()) {
            continue;
        }
        let mut settings = obs.settings.clone();
        settings["t"] = json!(obs.t);
        let fit = sim
            .call(&result.params, &settings, options, false)
            .map_err(error)?;
        let initial = sim
            .call(&initial, &settings, options, false)
            .map_err(error)?;
        full.push((&record.id, obs.t, fit, initial));
    }
    let mut limit = 2000;
    loop {
        let mut curves = Map::new();
        for (id, t, fit, initial) in &full {
            let idx = indices(t.len(), limit);
            let sample = |pred: &Trajectory| -> Value {
                Value::Object(
                    pred.iter()
                        .filter(|(ch, _)| ch.as_str() != "t")
                        .map(|(ch, y)| {
                            (
                                ch.clone(),
                                json!(idx.iter().map(|i| round6(y[*i])).collect::<Vec<_>>()),
                            )
                        })
                        .collect(),
                )
            };
            let mut entry = json!({"fit":sample(fit),"initial":sample(initial)});
            if idx.len() < t.len() {
                entry["t"] = json!(idx.iter().map(|i| t[*i]).collect::<Vec<_>>());
            }
            curves.insert((*id).clone(), entry);
        }
        payload["curves"] = Value::Object(curves);
        if crate::canonical(&payload).len() <= RUN_BYTES {
            crate::validate::payload_shape(crate::Kind::Run, &payload)?;
            return Ok(payload);
        }
        if limit == 1 {
            return Err(error(
                "run metadata and one curve point per measurement exceed 256 KiB",
            ));
        }
        limit = (limit / 2).max(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numpy_indices_and_six_digits() {
        assert_eq!(indices(6, 3), [0, 2, 5]);
        assert_eq!(indices(8, 3), [0, 4, 7]);
        assert_eq!(indices(8, 1), [0]);
        for (x, y) in [
            (1.234565, 1.23456),
            (1.234575, 1.23457),
            (9.999999, 10.),
            (0.000012345678, 0.0000123457),
        ] {
            assert_eq!(round6(x), y);
        }
        assert!(round6(-0.).is_sign_negative());
    }
}
