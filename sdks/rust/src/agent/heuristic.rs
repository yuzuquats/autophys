//! Offline decision brains for [`crate::reasoner::FakeReasoner`] and the
//! typed playbook settings they read. With them the benchmark, research
//! and autoloop run end to end without a model. Python reference:
//! `autophys.heuristic` (formerly in `autophys.bench`).
use crate::simulator::{Result, invalid};
use serde_json::{Value, json};

/// Typed settings a playbook may state on lines such as
/// `- compare_variants: never`. Only the offline fake reasoner reads them;
/// a real model reads the playbook's prose. The first value is the default
/// and reproduces the scripted baseline.
pub const STRATEGY_SETTINGS: [(&str, [&str; 2]); 2] = [
    ("compare_variants", ["on_misfit", "never"]),
    ("experiments", ["as_needed", "none"]),
];

fn allowed(key: &str) -> Option<&'static [&'static str; 2]> {
    STRATEGY_SETTINGS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v)
}

/// The value of `key` in `text`, as Python's
/// `re.search(rf"^\s*-?\s*{key}:\s*(\S+)\s*$", text, re.M)`.
fn setting_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let starts = std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1));
    for start in starts {
        let rest = &text[start..];
        let rest = rest.trim_start();
        let rest = rest.strip_prefix('-').unwrap_or(rest).trim_start();
        let Some(rest) = rest.strip_prefix(key).and_then(|r| r.strip_prefix(':')) else {
            continue;
        };
        let rest = rest.trim_start();
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let (token, after) = rest.split_at(end);
        if token.is_empty() {
            continue;
        }
        // `\s*$`: the token ends its line (whitespace up to a newline or the end).
        let ws_end = after
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(after.len());
        if ws_end == after.len() || after[..ws_end].contains('\n') {
            return Some(token);
        }
    }
    None
}

/// The [`STRATEGY_SETTINGS`] stated in a system prompt's strategy part,
/// with defaults. An unknown value is an error.
pub fn strategy_settings(system_prompt: &str) -> Result<indexmap::IndexMap<String, String>> {
    let strategy = match system_prompt.split_once("\nStrategy:\n") {
        Some((_, s)) => s,
        None => system_prompt,
    };
    let mut found = indexmap::IndexMap::new();
    for (key, values) in STRATEGY_SETTINGS {
        let mut value = values[0].to_string();
        if let Some(v) = setting_value(strategy, key) {
            if !values.contains(&v) {
                return Err(invalid(format!(
                    "playbook setting {key}: '{v}' is not one of ('{}', '{}')",
                    values[0], values[1]
                )));
            }
            value = v.into();
        }
        found.insert(key.to_string(), value);
    }
    Ok(found)
}

/// `text` with the typed setting `key` set to `value`: the first stating
/// line is rewritten, else the setting is appended under `Settings:`.
pub fn set_setting(text: &str, key: &str, value: &str) -> Result<String> {
    if !allowed(key).is_some_and(|v| v.contains(&value)) {
        return Err(invalid(format!("unknown setting {key}: {value}")));
    }
    // Python: ^([ \t]*-?[ \t]*){key}:[ \t]*\S+[ \t]*$ (re.M), first match.
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let indent_end = body.len() - body.trim_start_matches([' ', '\t']).len();
        let mut prefix_end = indent_end;
        let rest = &body[indent_end..];
        let rest = if let Some(r) = rest.strip_prefix('-') {
            prefix_end += 1;
            let t = r.trim_start_matches([' ', '\t']);
            prefix_end += r.len() - t.len();
            t
        } else {
            rest
        };
        if let Some(after) = rest.strip_prefix(key).and_then(|r| r.strip_prefix(':')) {
            let v = after.trim_matches([' ', '\t']);
            if !v.is_empty() && !v.contains(char::is_whitespace) {
                let mut out = String::with_capacity(text.len() + 8);
                out.push_str(&text[..offset]);
                out.push_str(&body[..prefix_end]);
                out.push_str(&format!("{key}: {value}"));
                out.push_str(&text[offset + body.len()..]);
                return Ok(out);
            }
        }
        offset += line.len();
    }
    let mut body = text.trim_end_matches('\n').to_string();
    let has_header = body.split('\n').any(|l| {
        l.strip_prefix("Settings:")
            .is_some_and(|r| r.trim().is_empty())
    });
    if !has_header {
        body.push_str("\n\nSettings:");
    }
    Ok(format!("{body}\n- {key}: {value}\n"))
}

fn line<'a>(text: &'a str, tag: &str) -> &'a str {
    let prefix = format!("{tag}: ");
    text.split('\n')
        .find_map(|l| l.strip_prefix(prefix.as_str()))
        .unwrap_or("")
}

fn capture<'a>(text: &'a str, pattern: &str) -> Option<&'a str> {
    let i = text.find(pattern)? + pattern.len();
    let rest = &text[i..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    Some(&rest[..end]).filter(|s| !s.is_empty())
}

fn content(m: &Value) -> &str {
    m["content"].as_str().unwrap_or("")
}

/// Python's `json.dumps` of the decision, key order as written.
fn out(fit: &str, action: &str, arguments: Value, hypothesis: &str) -> Value {
    let evidence: String = fit.chars().take(80).collect();
    Value::String(crate::pyjson::dumps(&json!({
        "hypothesis": hypothesis,
        "evidence": [evidence],
        "action": action,
        "arguments": arguments,
        "expected_information": "see tool result",
    })))
}

/// A FakeReasoner brain that reads the rendered diagnostics and the
/// playbook settings. With default settings it mirrors the scripted
/// baseline; settings change its strategy the way an edit would steer a
/// model. Returns the decision as JSON text, as a model would.
pub fn heuristic_responder(messages: &[Value]) -> Result<Value> {
    let text = messages.last().map(content).unwrap_or("");
    let settings = strategy_settings(if messages.len() > 1 {
        content(&messages[0])
    } else {
        ""
    })?;
    let (fit, sens, rank, val, bud) = (
        line(text, "FIT"),
        line(text, "SENSITIVITY"),
        line(text, "RANKING"),
        line(text, "VALIDATION"),
        line(text, "BUDGET"),
    );
    let mut budget = std::collections::HashMap::new();
    for kv in bud.split_whitespace() {
        let (k, v) = kv
            .split_once('=')
            .ok_or_else(|| invalid("malformed BUDGET line"))?;
        budget.insert(k, v);
    }
    if !fit.starts_with("current") {
        return Ok(out(
            fit,
            "optimize_parameters",
            json!({}),
            "calibrate to the current measurements",
        ));
    }
    let chi: f64 = capture(fit, "chi2/N=")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| invalid("FIT line has no chi2/N"))?;
    let model = line(text, "MODEL");
    let variants = model.rsplit("variants=").next().unwrap_or("");
    if settings["compare_variants"] == "on_misfit"
        && chi > 2.
        && line(text, "COMPARED") == "no"
        && variants.contains(',')
    {
        return Ok(out(
            fit,
            "compare_models",
            json!({"adopt": true}),
            "misfit suggests a sensor offset",
        ));
    }
    if !sens.starts_with("current") {
        return Ok(out(
            fit,
            "analyze_sensitivity",
            json!({}),
            "check what the data determines",
        ));
    }
    let non = capture(sens, "non_identified=").ok_or_else(|| invalid("no non_identified"))?;
    let ident = capture(sens, " identified=").ok_or_else(|| invalid("no identified"))?;
    let catalog = line(text, "CATALOG");
    let need = settings["experiments"] != "none"
        && (non != "none" || budget.get("experiments_requested") == Some(&"0"));
    let left: i64 = budget
        .get("experiments_left")
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| invalid("BUDGET has no experiments_left"))?;
    if need && left > 0 && !catalog.starts_with("none") {
        if !rank.starts_with("current") {
            return Ok(out(
                fit,
                "rank_experiments",
                json!({"criterion": "min_eig"}),
                "find the most informative experiment",
            ));
        }
        let best = capture(rank, "top=").ok_or_else(|| invalid("RANKING has no top"))?;
        return Ok(out(
            fit,
            "request_experiment",
            json!({"experiment": best}),
            &format!("{best} resolves the weakest direction"),
        ));
    }
    if !val.starts_with("current") {
        return Ok(out(
            fit,
            "validate_predictions",
            json!({}),
            "check predictions on the validation split",
        ));
    }
    let passed = val.contains("passed=yes");
    let ids: Vec<&str> = if ident == "none" {
        vec![]
    } else {
        ident.split(',').collect()
    };
    let status = if passed && non == "none" {
        "validated"
    } else {
        "inconclusive"
    };
    Ok(out(
        fit,
        "stop",
        json!({"status": status, "identified": ids, "summary": "heuristic fake reasoner"}),
        "done",
    ))
}

/// A fake that follows the heuristic but claims every parameter identified
/// at stop (exercises the identified-claim guardrail).
pub fn overclaiming_responder(messages: &[Value]) -> Result<Value> {
    let reply = heuristic_responder(messages)?;
    let mut d: Value =
        serde_json::from_str(reply.as_str().unwrap_or("{}")).map_err(|e| invalid(e.to_string()))?;
    if d["action"] == "stop" {
        let text = messages.last().map(content).unwrap_or("");
        let params = line(text, "PARAMS");
        let names: Vec<&str> = params
            .split("; ")
            .map(|p| p.split(' ').next().unwrap_or(""))
            .collect();
        d["arguments"]["identified"] = json!(names);
        d["arguments"]["status"] = json!("validated");
    }
    Ok(Value::String(crate::pyjson::dumps(&d)))
}

/// A [`crate::reasoner::FakeReasoner`] answering with
/// [`heuristic_responder`]. A responder error (an invalid playbook
/// setting) becomes an unparseable reply, which the investigation records
/// as an invalid decision; validate the playbook first with
/// [`strategy_settings`].
pub fn heuristic_reasoner() -> crate::reasoner::FakeReasoner {
    crate::reasoner::FakeReasoner::new(|m| {
        heuristic_responder(m).unwrap_or_else(|e| Value::String(format!("error: {e}")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_parse_like_the_python_regex() {
        let s = strategy_settings("x\nStrategy:\nSettings:\n- compare_variants: never\n").unwrap();
        assert_eq!(s["compare_variants"], "never");
        assert_eq!(s["experiments"], "as_needed");
        assert!(strategy_settings("\nStrategy:\n- experiments: maybe\n").is_err());
        // A value followed by more text on its line is not a setting.
        let s = strategy_settings("\nStrategy:\n- experiments: none really\n").unwrap();
        assert_eq!(s["experiments"], "as_needed");
    }

    #[test]
    fn set_setting_edits_or_appends() {
        assert_eq!(
            set_setting("a\n  - experiments: none\nb\n", "experiments", "as_needed").unwrap(),
            "a\n  - experiments: as_needed\nb\n"
        );
        assert_eq!(
            set_setting("a\n\n", "compare_variants", "never").unwrap(),
            "a\n\nSettings:\n- compare_variants: never\n"
        );
        assert_eq!(
            set_setting("a\nSettings:\n", "compare_variants", "never").unwrap(),
            "a\nSettings:\n- compare_variants: never\n"
        );
    }
}
