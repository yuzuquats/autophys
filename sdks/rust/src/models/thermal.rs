//! Lumped thermal RC: C dT/dt = P(t) - (T - ambient)/R.
use super::*;
use indexmap::IndexMap;
use serde_json::{Value, json};
pub const AMBIENT: f64 = 20.0;
pub fn catalog() -> IndexMap<String, Value> {
    [
        (
            "step_short",
            json!({"kind":"step","power":10.,"duration":120.,"rate":1.}),
        ),
        (
            "step_long",
            json!({"kind":"step","power":10.,"duration":3000.,"rate":0.2}),
        ),
        (
            "pulse",
            json!({"kind":"pulse","power":20.,"on":600.,"duration":3000.,"rate":0.2}),
        ),
        (
            "sine_slow",
            json!({"kind":"sine","power":10.,"period":2000.,"duration":3000.,"rate":0.2}),
        ),
        (
            "sine_fast",
            json!({"kind":"sine","power":10.,"period":100.,"duration":600.,"rate":1.}),
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect()
}
pub fn power(e: &Value, t: f64) -> Result<f64> {
    let p = number(e, "power")?;
    Ok(match e["kind"].as_str() {
        Some("step") => p,
        Some("pulse") => {
            if t < number(e, "on")? {
                p
            } else {
                0.
            }
        }
        Some("sine") => 0.5 * p * (1. - (std::f64::consts::TAU * t / number(e, "period")?).cos()),
        _ => return Err(invalid("thermal_rc: unknown experiment kind")),
    })
}
pub fn thermal_rc() -> FunctionSimulator {
    simulator(
        "thermal_rc",
        specs(&[("C", "J/K", 10., 1e5), ("R", "K/W", 0.01, 100.)]),
        catalog(),
        vec!["T".into()],
        include_str!("thermal.rs"),
        |p, e, o| {
            let t = time_grid(e)?;
            let ta = get(e, "ambient", AMBIENT);
            power(e, 0.)?;
            let max = if e["kind"] == "pulse" {
                number(e, "on")? / 4.
            } else {
                f64::INFINITY
            };
            let y = integrate(
                |tt, y, d| d[0] = (power(e, tt).unwrap() - (y[0] - ta) / p["R"]) / p["C"],
                &[get(e, "T0", ta)],
                &t,
                o,
                max,
            )?;
            Ok([("t".into(), t), ("T".into(), y[0].clone())]
                .into_iter()
                .collect())
        },
    )
    .unwrap()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn step() {
        let sim = thermal_rc();
        let p = [("C".into(), 500.), ("R".into(), 2.)].into_iter().collect();
        let y = sim.simulate(&p, &json!("step_short"), FIT_OPTIONS).unwrap();
        let temp = y.output("T").unwrap();
        assert!((temp[120] - (20. + 20. * (1. - (-0.12_f64).exp()))).abs() < 1e-7);
    }
}
