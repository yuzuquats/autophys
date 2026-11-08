//! A starting point: one model, synthetic data, a fit and an identifiability
//! check.
//!
//!     cargo run --release
//!
//! Replace `decay` with your simulator and the synthetic observation with
//! your measurements. The SDK reference is sdks/rust in the autophys repo.
use std::error::Error;

use autophys::data::Observation;
use autophys::fit::{FitOptions, fit};
use autophys::sensitivity::analyze;
use autophys::simulator::{FIT_OPTIONS, ParamSpec, Params, SimulationError, Simulator, simulator};
use serde_json::json;

fn main() -> Result<(), Box<dyn Error>> {
    // y(t) = y0 * exp(-k t), sampled at the experiment's times.
    let decay = simulator(
        "decay",
        vec![
            ParamSpec::new("k", "1/s", 1e-3, 10.0)?,
            ParamSpec::new("y0", "V", 0.1, 10.0)?,
        ],
        Default::default(),
        vec!["y".into()],
        include_str!("main.rs"),
        |p, experiment, _options| {
            let t: Vec<f64> = serde_json::from_value(experiment["t"].clone())
                .map_err(|e| SimulationError::Invalid(e.to_string()))?;
            let y = t.iter().map(|t| p["y0"] * (-p["k"] * t).exp()).collect();
            Ok([("t".to_string(), t), ("y".to_string(), y)]
                .into_iter()
                .collect())
        },
    )?;

    let t: Vec<f64> = (0..=100).map(|k| k as f64 * 0.1).collect();
    let settings = json!({"kind": "measured", "t": t});
    let truth: Params = [("k".to_string(), 0.4), ("y0".to_string(), 2.0)]
        .into_iter()
        .collect();
    let sigma = 0.01;
    let mut rng = autophys::fit::rng::NumpyRng::new(0);
    let y: Vec<f64> = decay
        .simulate(&truth, &settings, FIT_OPTIONS)?
        .output("y")?
        .iter()
        .map(|y| y + sigma * rng.normal())
        .collect();
    let obs = [Observation::new(
        "measured",
        settings,
        t,
        [("y".to_string(), y)].into_iter().collect(),
        [("y".to_string(), sigma)].into_iter().collect(),
    )?];

    let fitted = fit(
        &decay,
        &obs,
        &FitOptions {
            n_starts: 4,
            ..Default::default()
        },
    )?;
    let (report, _) = analyze(&decay, &fitted.params, &obs, Default::default(), None)?;
    println!("fit: chi2/N = {:.2}", fitted.chi2_per_n);
    for name in decay.params().keys() {
        let verdict = if report.identified.contains(name) {
            "identified"
        } else {
            "NOT identified"
        };
        println!(
            "  {name:3} = {:.5}  (true {})  {verdict}",
            fitted.params[name], truth[name]
        );
    }
    Ok(())
}
