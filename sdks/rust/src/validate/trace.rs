use super::*;

fn object<'a>(v: &'a Value, at: &str) -> Result<&'a Map<String, Value>> {
    v.as_object()
        .ok_or_else(|| Error::invalid(at, "must be an object"))
}
fn fields(
    v: &Map<String, Value>,
    at: &str,
    strings: &[&str],
    integers: &[&str],
    numbers: &[&str],
    nullable: &[&str],
) -> Result<()> {
    for key in strings {
        if v.get(*key).is_some_and(|v| !v.is_string()) {
            return Err(Error::invalid(format!("{at}.{key}"), "must be a string"));
        }
    }
    for key in integers {
        if v.get(*key).is_some_and(|v| v.as_u64().is_none()) {
            return Err(Error::invalid(
                format!("{at}.{key}"),
                "must be an integer >= 0",
            ));
        }
    }
    for key in numbers {
        if let Some(n) = v.get(*key) {
            if !(nullable.contains(key) && n.is_null()) && !n.as_f64().is_some_and(f64::is_finite) {
                return Err(Error::invalid(
                    format!("{at}.{key}"),
                    "must be a finite number",
                ));
            }
        }
    }
    Ok(())
}
fn digest(v: Option<&Value>, at: &str, prefix: bool) -> Result<()> {
    let valid = v.and_then(Value::as_str).is_some_and(|s| {
        let s = if prefix {
            s.strip_prefix("sha256:").unwrap_or(s)
        } else {
            s
        };
        s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
    });
    if !valid {
        return Err(Error::invalid(at, "must be a 64-hex sha256"));
    }
    Ok(())
}
pub(super) fn shape(kind: Kind, p: &Map<String, Value>) -> Result<()> {
    if kind == Kind::Investigation {
        if let Some(v) = p.get("playbook") {
            let v = object(v, "payload.playbook")?;
            for key in ["name", "version"] {
                string_field(v, "payload.playbook", key)?;
            }
            digest(v.get("sha256"), "payload.playbook.sha256", false)?;
        }
        if let Some(v) = p.get("model") {
            let v = object(v, "payload.model")?;
            for key in ["role", "route", "model"] {
                string_field(v, "payload.model", key)?;
            }
            if !["policy", "researcher"].contains(&v["role"].as_str().unwrap()) {
                return Err(Error::invalid(
                    "payload.model.role",
                    "must be policy or researcher",
                ));
            }
            if v.get("effort")
                .is_some_and(|v| !v.is_null() && !v.is_string())
            {
                return Err(Error::invalid(
                    "payload.model.effort",
                    "must be a string or null",
                ));
            }
            if v.get("max_tokens")
                .is_some_and(|v| !v.is_null() && v.as_u64().is_none())
            {
                return Err(Error::invalid(
                    "payload.model.max_tokens",
                    "must be an integer >= 0 or null",
                ));
            }
        }
        if let Some(v) = p.get("price") {
            let v = object(v, "payload.price")?;
            for key in ["model", "as_of"] {
                string_field(v, "payload.price", key)?;
            }
            for key in ["input_per_mtok", "output_per_mtok"] {
                if !v.contains_key(key) {
                    return Err(Error::invalid(
                        format!("payload.price.{key}"),
                        "required number",
                    ));
                }
            }
            fields(
                v,
                "payload.price",
                &[],
                &[],
                &["input_per_mtok", "output_per_mtok"],
                &[],
            )?;
        }
    }
    if kind == Kind::Step {
        if let Some(v) = p.get("usage") {
            fields(
                object(v, "payload.usage")?,
                "payload.usage",
                &["route", "model"],
                &[
                    "input_tokens",
                    "output_tokens",
                    "total_tokens",
                    "reasoning_tokens",
                    "cached_input_tokens",
                ],
                &["latency_ms", "cost_usd"],
                &["cost_usd"],
            )?;
        }
        if p.get("replayed").is_some_and(|v| !v.is_boolean()) {
            return Err(Error::invalid("payload.replayed", "must be a boolean"));
        }
        if let Some(v) = p.get("images") {
            let v = v
                .as_array()
                .ok_or_else(|| Error::invalid("payload.images", "must be an array"))?;
            for (i, v) in v.iter().enumerate() {
                let at = format!("payload.images[{i}]");
                let v = object(v, &at)?;
                digest(v.get("sha256"), &format!("{at}.sha256"), true)?;
                string_field(v, &at, "media_type")?;
                fields(v, &at, &["caption"], &[], &[], &[])?;
            }
        }
    }
    if kind == Kind::Outcome {
        if let Some(v) = p.get("usage_total") {
            fields(
                object(v, "payload.usage_total")?,
                "payload.usage_total",
                &[],
                &["calls", "input_tokens", "output_tokens"],
                &["cost_usd"],
                &["cost_usd"],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn trace_fields_accept_legacy_and_name_invalid_paths() {
        for p in [
            json!({"usage":{"prompt_tokens":"opaque","unknown":[1]}}),
            json!({"usage":{"input_tokens":0,"cost_usd":null}}),
            json!({"images":[{"sha256":format!("sha256:{}","a".repeat(64)),"media_type":"image/png"}],"replayed":true}),
        ] {
            payload_shape(Kind::Step, &p).unwrap();
        }
        for (k, p, path) in [
            (
                Kind::Investigation,
                json!({"project_id":"p","config_version":"v","playbook":{"name":"d","version":"1","sha256":format!("sha256:{}","a".repeat(64))}}),
                "payload.playbook.sha256",
            ),
            (
                Kind::Investigation,
                json!({"project_id":"p","config_version":"v","model":{"role":"other","route":"meta","model":"m"}}),
                "payload.model.role",
            ),
            (
                Kind::Investigation,
                json!({"project_id":"p","config_version":"v","model":{"role":"policy","route":"meta","model":"m","max_tokens":true}}),
                "payload.model.max_tokens",
            ),
            (
                Kind::Investigation,
                json!({"project_id":"p","config_version":"v","price":{"model":"m","as_of":"d","input_per_mtok":1}}),
                "payload.price.output_per_mtok",
            ),
            (Kind::Step, json!({"usage":null}), "payload.usage"),
            (
                Kind::Step,
                json!({"usage":{"input_tokens":true}}),
                "payload.usage.input_tokens",
            ),
            (
                Kind::Step,
                json!({"usage":{"output_tokens":1.0}}),
                "payload.usage.output_tokens",
            ),
            (
                Kind::Step,
                json!({"usage":{"cost_usd":"1"}}),
                "payload.usage.cost_usd",
            ),
            (Kind::Step, json!({"replayed":1}), "payload.replayed"),
            (
                Kind::Step,
                json!({"images":[{"sha256":"wrong","media_type":"image/png"}]}),
                "payload.images[0].sha256",
            ),
            (
                Kind::Step,
                json!({"images":[{"sha256":"a".repeat(64),"media_type":"image/png","caption":null}]}),
                "payload.images[0].caption",
            ),
            (
                Kind::Outcome,
                json!({"status":"done","usage_total":{"calls":-1}}),
                "payload.usage_total.calls",
            ),
        ] {
            match payload_shape(k, &p) {
                Err(Error::Invalid { path: got, .. }) => assert_eq!(got, path),
                other => panic!("expected invalid {path}: {other:?}"),
            }
        }
    }
}
