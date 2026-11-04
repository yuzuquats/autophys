//! Provider normalization and lenient totals for additive v1 trace records.
use crate::reasoner::ReasonReply;
use serde_json::{Value, json};
use std::sync::LazyLock;

pub static PRICES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("prices.json")).expect("embedded price table")
});
pub fn price_for(model: &str) -> Option<Value> {
    let mut price = PRICES["models"].get(model)?.clone();
    price["model"] = json!(model);
    price["as_of"] = PRICES["as_of"].clone();
    Some(price)
}
pub fn normalize_usage(reply: &ReasonReply) -> Value {
    let raw = &reply.usage;
    let inp = raw["prompt_tokens"].as_u64().unwrap_or(0);
    let out = raw["completion_tokens"].as_u64().unwrap_or(0);
    let price = reply.model.as_deref().and_then(price_for);
    let cost = price.map(|p| {
        (inp as f64 * p["input_per_mtok"].as_f64().unwrap()
            + out as f64 * p["output_per_mtok"].as_f64().unwrap())
            / 1e6
    });
    let mut value = json!({"route":reply.route.as_deref().filter(|s| !s.is_empty()).unwrap_or("unknown"),
        "model":reply.model.as_deref().filter(|s| !s.is_empty()).unwrap_or("unknown"),
        "input_tokens":inp,"output_tokens":out,"total_tokens":raw.get("total_tokens").cloned().unwrap_or(json!(inp+out)),
        "latency_ms":reply.elapsed_ms.unwrap_or(0.),"cost_usd":cost});
    for (source, key, target) in [
        (
            "completion_tokens_details",
            "reasoning_tokens",
            "reasoning_tokens",
        ),
        (
            "prompt_tokens_details",
            "cached_tokens",
            "cached_input_tokens",
        ),
    ] {
        if let Some(v) = raw[source].get(key) {
            value[target] = v.clone();
        }
    }
    value
}
/// Legacy provider dictionaries are opaque and do not affect counts or costs.
pub fn usage_total<'a>(steps: impl IntoIterator<Item = &'a Value>) -> Value {
    let (mut calls, mut inp, mut out) = (0u64, 0u64, 0u64);
    let mut cost = Some(0.0);
    for step in steps {
        let Some(usage) = step
            .get("usage")
            .filter(|u| u.is_object() && u.get("input_tokens").is_some())
        else {
            continue;
        };
        calls += 1;
        inp += usage["input_tokens"].as_u64().unwrap_or(0);
        out += usage["output_tokens"].as_u64().unwrap_or(0);
        cost = cost.zip(usage["cost_usd"].as_f64()).map(|(a, b)| a + b);
    }
    json!({"calls":calls,"input_tokens":inp,"output_tokens":out,"cost_usd":cost})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prices_equal_shared_fixture() {
        let shared = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/conformance/reasoner/prices.json"
        ))
        .unwrap();
        assert_eq!(include_str!("prices.json"), shared);
        assert_eq!(*PRICES, serde_json::from_str::<Value>(&shared).unwrap());
        assert!(price_for("unpriced").is_none());
    }
    #[test]
    fn normalization_and_opaque_legacy_totals() {
        let reply = ReasonReply {
            content: json!("ok"),
            model: Some("muse-spark-1.3".into()),
            route: Some("meta".into()),
            usage: json!({"prompt_tokens":100,"completion_tokens":40,"completion_tokens_details":{"reasoning_tokens":10},"prompt_tokens_details":{"cached_tokens":20}}),
            elapsed_ms: Some(3.),
            replayed: false,
        };
        let usage = normalize_usage(&reply);
        assert_eq!(
            usage,
            json!({"route":"meta","model":"muse-spark-1.3","input_tokens":100,"output_tokens":40,"total_tokens":140,"latency_ms":3.,"cost_usd":0.000295,"reasoning_tokens":10,"cached_input_tokens":20})
        );
        let steps = [
            json!({"usage":usage}),
            json!({"usage":{"prompt_tokens":800,"provider":"opaque"}}),
            json!({"usage":null}),
        ];
        assert_eq!(
            usage_total(&steps),
            json!({"calls":1,"input_tokens":100,"output_tokens":40,"cost_usd":0.000295})
        );
        let unknown = json!({"usage":{"input_tokens":5,"cost_usd":null}});
        assert!(usage_total(steps.iter().chain([&unknown]))["cost_usd"].is_null());
        let mut reply = reply;
        reply.model = None;
        reply.route = None;
        reply.elapsed_ms = None;
        let u = normalize_usage(&reply);
        assert_eq!(u["route"], "unknown");
        assert_eq!(u["latency_ms"], 0.);
        assert!(u["cost_usd"].is_null());
        assert_eq!(
            usage_total([].iter()),
            json!({"calls":0,"input_tokens":0,"output_tokens":0,"cost_usd":0.})
        );
    }
}
