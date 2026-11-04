//! The Python SDK's three example models, with adaptive DOP853 integration.
pub mod battery;
pub mod oscillator;
pub mod thermal;
use crate::simulator::*;
pub use battery::battery_ecm;
pub use oscillator::oscillator;
pub use thermal::thermal_rc;
mod dop853;
pub use dop853::integrate;
pub(crate) fn specs(a: &[(&str, &str, f64, f64)]) -> Vec<ParamSpec> {
    a.iter()
        .map(|(n, u, a, b)| ParamSpec::new(*n, *u, *a, *b).unwrap())
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exponential() {
        let t = vec![0., 0.1, 0.9, 1.];
        let y = integrate(
            |_, y, d| d[0] = -y[0],
            &[1.],
            &t,
            FIT_OPTIONS,
            f64::INFINITY,
        )
        .unwrap();
        for (t, y) in t.iter().zip(&y[0]) {
            assert!((y - (-t).exp()).abs() < 1e-8);
        }
    }
}
