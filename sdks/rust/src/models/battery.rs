//! First-order Thevenin battery cell with a piecewise linear OCV table.
use super::*;
use indexmap::IndexMap;
use serde_json::{Value, json};
pub const OCV_SOC: [f64; 13] = [
    0., 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.,
];
pub const OCV_V: [f64; 13] = [
    3., 3.30, 3.45, 3.56, 3.62, 3.67, 3.72, 3.79, 3.88, 3.97, 4.06, 4.12, 4.20,
];
pub fn ocv(s: f64) -> f64 {
    if s <= 0. {
        return OCV_V[0];
    }
    if s >= 1. {
        return OCV_V[12];
    }
    let i = OCV_SOC.partition_point(|x| *x <= s) - 1;
    OCV_V[i] + (s - OCV_SOC[i]) / (OCV_SOC[i + 1] - OCV_SOC[i]) * (OCV_V[i + 1] - OCV_V[i])
}
pub fn catalog() -> IndexMap<String, Value> {
    [
 ("discharge_1A",json!({"kind":"constant","current":1.,"duration":600.,"rate":1.,"capacity_ah":2.5,"soc0":0.9})),
 ("pulse_2A",json!({"kind":"pulse","current":2.,"on":30.,"duration":300.,"rate":2.,"capacity_ah":2.5,"soc0":0.9})),
 ("pulse_train",json!({"kind":"pulse_train","current":2.,"on":10.,"off":20.,"duration":300.,"rate":2.,"capacity_ah":2.5,"soc0":0.9}))].into_iter().map(|(k,v)|(k.into(),v)).collect()
}
pub fn current(e: &Value, t: f64) -> Result<f64> {
    let i = number(e, "current")?;
    Ok(match e["kind"].as_str() {
        Some("constant") => i,
        Some("pulse") => {
            if t < number(e, "on")? {
                i
            } else {
                0.
            }
        }
        Some("pulse_train") => {
            if t % (number(e, "on")? + number(e, "off")?) < number(e, "on")? {
                i
            } else {
                0.
            }
        }
        _ => return Err(invalid("battery_ecm: unknown experiment kind")),
    })
}
pub fn battery_ecm() -> FunctionSimulator {
    simulator(
        "battery_ecm",
        specs(&[
            ("R0", "ohm", 1e-3, 0.5),
            ("R1", "ohm", 1e-3, 0.5),
            ("C1", "F", 10., 1e5),
        ]),
        catalog(),
        vec!["v".into()],
        include_str!("battery.rs"),
        |p, e, o| {
            let t = time_grid(e)?;
            current(e, 0.)?;
            let q = get(e, "capacity_ah", 2.5);
            let max = get(e, "on", get(e, "duration", *t.last().unwrap_or(&1.))) / 4.;
            let y = integrate(
                |tt, y, d| {
                    let i = current(e, tt).unwrap();
                    d[0] = -i / (3600. * q);
                    d[1] = -y[1] / (p["R1"] * p["C1"]) + i / p["C1"];
                },
                &[get(e, "soc0", 0.9), 0.],
                &t,
                o,
                max,
            )?;
            let v = t
                .iter()
                .enumerate()
                .map(|(j, tt)| ocv(y[0][j]) - y[1][j] - current(e, *tt).unwrap() * p["R0"])
                .collect();
            Ok([("t".into(), t), ("v".into(), v)].into_iter().collect())
        },
    )
    .unwrap()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interpolation() {
        assert_eq!(ocv(-1.), 3.);
        assert_eq!(ocv(2.), 4.2);
        assert!((ocv(0.15) - 3.505).abs() < 1e-14);
    }
}
