//! Mass-spring-damper with free, step, impulse and sine excitation.
use super::*;
use indexmap::IndexMap;
use serde_json::{Value, json};
pub fn catalog() -> IndexMap<String, Value> {
    [
        (
            "free",
            json!({"kind":"free","x0":0.1,"v0":0.,"duration":10.,"rate":100.}),
        ),
        (
            "step_2N",
            json!({"kind":"step","amplitude":2.,"duration":10.,"rate":100.}),
        ),
        (
            "impulse",
            json!({"kind":"impulse","amplitude":0.5,"duration":10.,"rate":100.}),
        ),
        (
            "sine_0.1Hz",
            json!({"kind":"sine","amplitude":2.,"freq":0.1,"duration":10.,"rate":100.}),
        ),
        (
            "sine_0.44Hz",
            json!({"kind":"sine","amplitude":2.,"freq":0.44,"duration":10.,"rate":100.}),
        ),
        (
            "sine_2Hz",
            json!({"kind":"sine","amplitude":2.,"freq":2.,"duration":10.,"rate":100.}),
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect()
}
pub fn force(e: &Value, t: f64) -> Result<f64> {
    let a = get(e, "amplitude", 0.);
    Ok(match e["kind"].as_str() {
        Some("free" | "impulse") => 0.,
        Some("step") => a,
        Some("sine") => a * (std::f64::consts::TAU * number(e, "freq")? * t).sin(),
        _ => return Err(invalid("oscillator: unknown experiment kind")),
    })
}
pub fn oscillator() -> FunctionSimulator {
    simulator(
        "oscillator",
        specs(&[
            ("m", "kg", 0.1, 20.),
            ("c", "N*s/m", 0.01, 10.),
            ("k", "N/m", 0.5, 100.),
        ]),
        catalog(),
        vec!["x".into()],
        include_str!("oscillator.rs"),
        |p, e, o| {
            let t = time_grid(e)?;
            let x = get(e, "x0", 0.);
            let mut v = get(e, "v0", 0.);
            if e["kind"] == "impulse" {
                v += number(e, "amplitude")? / p["m"];
            }
            force(e, 0.)?;
            let y = integrate(
                |tt, y, d| {
                    d[0] = y[1];
                    d[1] = (force(e, tt).unwrap() - p["c"] * y[1] - p["k"] * y[0]) / p["m"];
                },
                &[x, v],
                &t,
                o,
                f64::INFINITY,
            )?;
            Ok([("t".into(), t), ("x".into(), y[0].clone())]
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
    fn free() {
        let s = oscillator();
        let p = [("m".into(), 2.), ("c".into(), 0.8), ("k".into(), 15.)]
            .into_iter()
            .collect();
        let y = s.simulate(&p, &json!("free"), FIT_OPTIONS).unwrap();
        assert_eq!(y["x"][0], 0.1);
        assert_eq!(y["x"].len(), 1001);
    }
}
