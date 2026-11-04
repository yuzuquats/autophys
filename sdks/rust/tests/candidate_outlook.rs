use autophys::{design, models, simulator::Params};
use nalgebra::DMatrix;
use serde_json::json;
#[test]
fn candidate_after_matches_outlook() {
    let sim = models::oscillator();
    let p: Params = serde_json::from_value(json!({"m":2.,"c":0.8,"k":15.})).unwrap();
    let noise: Params = serde_json::from_value(json!({"x":0.01})).unwrap();
    use autophys::simulator::Simulator;
    for c in design::rank_experiments(&sim, &p, &[], &noise, None, "min_eig", None).unwrap() {
        let settings = sim.experiment(&json!(c.experiment)).unwrap();
        let (_, after) = design::settings_score(&sim, &p, &DMatrix::zeros(3,3), &noise, &settings, "min_eig").unwrap();
        let reference: serde_json::Value = serde_json::from_str(include_str!("../../python/tests/candidate_after_reference.json")).unwrap();
        for (k, v) in &c.after {
            let expected = reference[&c.experiment][k].as_f64().unwrap();
            assert!((v - expected).abs() < 1e-5 * expected.abs().max(1.));
        }
        for (k,v) in after { assert!((c.after[&k]-v).abs() < 1e-10*v.abs().max(1.)); }
    }
}
