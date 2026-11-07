//! Python `json` module compatibility for files that the Python SDK writes
//! and reads: `json.dumps` with its `indent`, `sort_keys` and `separators`
//! options, and `json.loads` of text holding the `NaN`, `Infinity` and
//! `-Infinity` tokens that Python emits for non-finite floats.
//!
//! serde_json cannot hold a non-finite float, so one is carried as a marked
//! string ([`float`], [`as_f64`]) that only this writer prints as a bare
//! token. Strings and floats print exactly as [`crate::canonical`] does
//! (ASCII escapes, Python `repr` floats).

use serde_json::{Number, Value};

/// Prefix of a non-finite float carried in a [`Value`].
const MARK: &str = "\u{0}pyfloat:";

/// A float as a [`Value`]: a JSON number when finite, else a marked string
/// that [`dumps`] prints as `NaN`, `Infinity` or `-Infinity`.
pub fn float(x: f64) -> Value {
    if x.is_finite() {
        Number::from_f64(x)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    } else {
        Value::String(format!("{MARK}{}", token(x)))
    }
}

fn token(x: f64) -> &'static str {
    if x.is_nan() {
        "NaN"
    } else if x > 0. {
        "Infinity"
    } else {
        "-Infinity"
    }
}

/// The float a [`Value`] holds: a number or a marked non-finite float.
pub fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => match s.strip_prefix(MARK)? {
            "NaN" => Some(f64::NAN),
            "Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            _ => None,
        },
        _ => None,
    }
}

/// Whether `v` is a marked non-finite float.
pub fn is_nonfinite(v: &Value) -> bool {
    matches!(v, Value::String(s) if s.starts_with(MARK))
}

/// `v` with every non-finite float replaced by `null`, as the Python SDK's
/// strict sidecars store them.
pub fn finite_or_null(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(finite_or_null).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (k.clone(), finite_or_null(v)))
                .collect(),
        ),
        v if is_nonfinite(v) => Value::Null,
        v => v.clone(),
    }
}

/// Options of Python's `json.dumps`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Dumps {
    pub indent: Option<usize>,
    pub sort_keys: bool,
    /// `(item, key)` separators; `None` is Python's default for the indent.
    pub separators: Option<(&'static str, &'static str)>,
}

/// `json.dumps(v)` with Python's defaults.
pub fn dumps(v: &Value) -> String {
    dumps_with(v, Dumps::default())
}

/// `json.dumps(v, sort_keys=True)`.
pub fn dumps_sorted(v: &Value) -> String {
    dumps_with(
        v,
        Dumps {
            sort_keys: true,
            ..Default::default()
        },
    )
}

/// `json.dumps(v, indent=indent, sort_keys=sort_keys)`.
pub fn dumps_indent(v: &Value, indent: usize, sort_keys: bool) -> String {
    dumps_with(
        v,
        Dumps {
            indent: Some(indent),
            sort_keys,
            separators: None,
        },
    )
}

pub fn dumps_with(v: &Value, o: Dumps) -> String {
    let (item, key) = o.separators.unwrap_or(if o.indent.is_some() {
        (",", ": ")
    } else {
        (", ", ": ")
    });
    let mut out = String::new();
    write(&mut out, v, &o, item, key, 0);
    out
}

fn newline(out: &mut String, o: &Dumps, level: usize) {
    if let Some(n) = o.indent {
        out.push('\n');
        out.extend(std::iter::repeat_n(' ', n * level));
    }
}

fn write(out: &mut String, v: &Value, o: &Dumps, item: &str, key: &str, level: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(_) => out.push_str(&crate::canonical::canonical(v)),
        Value::String(s) => match s.strip_prefix(MARK) {
            Some(t) => out.push_str(t),
            None => crate::canonical::write_str(out, s),
        },
        Value::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(item);
                }
                newline(out, o, level + 1);
                write(out, x, o, item, key, level + 1);
            }
            newline(out, o, level);
            out.push(']');
        }
        Value::Object(m) => {
            if m.is_empty() {
                out.push_str("{}");
                return;
            }
            let mut keys: Vec<&String> = m.keys().collect();
            if o.sort_keys {
                keys.sort();
            }
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push_str(item);
                }
                newline(out, o, level + 1);
                crate::canonical::write_str(out, k);
                out.push_str(key);
                write(out, &m[k], o, item, key, level + 1);
            }
            newline(out, o, level);
            out.push('}');
        }
    }
}

/// `json.loads(text)`: JSON that may hold Python's `NaN`, `Infinity` and
/// `-Infinity` tokens, which become marked floats ([`as_f64`]).
pub fn loads(text: &str) -> serde_json::Result<Value> {
    if !text.contains("NaN") && !text.contains("Infinity") {
        return serde_json::from_str(text);
    }
    let mut out = String::with_capacity(text.len() + 32);
    let mut chars = text.char_indices().peekable();
    let mut in_string = false;
    while let Some((i, c)) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some((_, n)) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        let rest = &text[i..];
        let found = ["-Infinity", "Infinity", "NaN"]
            .into_iter()
            .find(|t| rest.starts_with(t));
        if let Some(t) = found {
            let mut marked = String::new();
            crate::canonical::write_str(&mut marked, &format!("{MARK}{t}"));
            out.push_str(&marked);
            for _ in 1..t.len() {
                chars.next();
            }
            continue;
        }
        if c == '"' {
            in_string = true;
        }
        out.push(c);
    }
    serde_json::from_str(&out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dumps_matches_python() {
        // python3 -c 'import json; print(json.dumps({"b":[1,2.0,{}],"a":"é","c":[]}, indent=2, sort_keys=True))'
        let v = json!({"b": [1, 2.0, {}], "a": "é", "c": []});
        assert_eq!(
            dumps_indent(&v, 2, true),
            "{\n  \"a\": \"\\u00e9\",\n  \"b\": [\n    1,\n    2.0,\n    {}\n  ],\n  \"c\": []\n}"
        );
        assert_eq!(
            dumps(&v),
            "{\"b\": [1, 2.0, {}], \"a\": \"\\u00e9\", \"c\": []}"
        );
        assert_eq!(
            dumps_indent(&json!([1, {"x": null}]), 1, false),
            "[\n 1,\n {\n  \"x\": null\n }\n]"
        );
    }

    #[test]
    fn nonfinite_round_trip() {
        let v = json!({"a": float(f64::INFINITY), "b": [float(f64::NAN), float(-f64::INFINITY)], "c": "NaN in text"});
        let text = dumps_sorted(&v);
        assert_eq!(
            text,
            "{\"a\": Infinity, \"b\": [NaN, -Infinity], \"c\": \"NaN in text\"}"
        );
        let back = loads(&text).unwrap();
        assert_eq!(as_f64(&back["a"]), Some(f64::INFINITY));
        assert!(as_f64(&back["b"][0]).unwrap().is_nan());
        assert_eq!(back["c"], "NaN in text");
        assert_eq!(finite_or_null(&back)["a"], Value::Null);
    }
}
