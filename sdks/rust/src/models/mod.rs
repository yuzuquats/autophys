//! The Python SDK's three example models, with adaptive DOP853 integration.
#[path = "battery.rs"]
mod battery_impl;
mod display;
#[path = "oscillator.rs"]
mod oscillator_impl;
#[path = "thermal.rs"]
mod thermal_impl;
pub mod battery {
    pub use super::battery_impl::{OCV_SOC, OCV_V, catalog, current, ocv};
    pub fn battery_ecm() -> crate::simulator::FunctionSimulator {
        super::battery_impl::battery_ecm()
            .with_display(super::display::battery())
            .unwrap()
    }
}
pub mod oscillator {
    pub use super::oscillator_impl::{catalog, force};
    pub fn oscillator() -> crate::simulator::FunctionSimulator {
        super::oscillator_impl::oscillator()
            .with_display(super::display::oscillator())
            .unwrap()
    }
}
pub mod thermal {
    pub use super::thermal_impl::{AMBIENT, catalog, power};
    pub fn thermal_rc() -> crate::simulator::FunctionSimulator {
        super::thermal_impl::thermal_rc()
            .with_display(super::display::thermal())
            .unwrap()
    }
}
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

#[cfg(test)]
mod display_identity {
    use super::*;
    #[test]
    fn bench_hashes_unchanged() {
        for (plain, displayed) in [
            (battery_impl::battery_ecm(), battery_ecm()),
            (oscillator_impl::oscillator(), oscillator()),
            (thermal_impl::thermal_rc(), thermal_rc()),
        ] {
            assert_eq!(plain.source_hash(), displayed.source_hash());
            let plain = crate::project::Project::new("bench", plain);
            let displayed = crate::project::Project::new("bench", displayed);
            assert_eq!(plain.config(), displayed.config());
            assert_eq!(plain.config_version(), displayed.config_version());
        }
    }
}
