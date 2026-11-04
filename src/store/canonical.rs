//! Canonical JSON and the record hash chain, byte-compatible with the SDK.
//!
//! The SDK (`modellab/store.py`) hashes `sha256(prev_hash + canonical({id,
//! kind, payload}))` where canonical is Python's
//! `json.dumps(obj, sort_keys=True, separators=(",", ":"))`. That call keeps
//! the default `ensure_ascii=True` and prints floats with `repr`, so this
//! module reproduces both: every character outside printable ASCII becomes a
//! lowercase `\uXXXX` escape (surrogate pairs above the BMP), and floats use
//! Python's shortest round-trip form (`1e-05`, `1e+16`, `3.0`). serde_json's
//! own writer differs on both points, so it is never used for hashing.

use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

/// The `prev_hash` of an investigation's first record.
pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Canonical JSON text of `value` (sorted keys, no whitespace, ASCII only).
pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// `sha256(prev_hash ‖ canonical{id, kind, payload})`, lowercase hex.
pub fn chain_hash(prev_hash: &str, id: &str, kind: &str, payload: &Value) -> String {
    let mut body = String::from("{\"id\":");
    write_str(&mut body, id);
    body.push_str(",\"kind\":");
    write_str(&mut body, kind);
    body.push_str(",\"payload\":");
    write_value(&mut body, payload);
    body.push('}');
    sha256_hex([prev_hash.as_bytes(), body.as_bytes()])
}

/// Lowercase hex sha256 of the concatenation of `parts`.
pub fn sha256_hex<'a>(parts: impl IntoIterator<Item = &'a [u8]>) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    hex::encode(h.finalize())
}

fn write_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(out, n),
        Value::String(s) => write_str(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            // Python sorts str keys by code point; UTF-8 byte order is the same.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_str(out, k);
                out.push(':');
                write_value(out, &map[k]);
            }
            out.push('}');
        }
    }
}

fn write_number(out: &mut String, n: &Number) {
    if let Some(i) = n.as_i64() {
        out.push_str(&i.to_string());
    } else if let Some(u) = n.as_u64() {
        out.push_str(&u.to_string());
    } else {
        // serde_json never holds a non-finite f64.
        out.push_str(&py_float_repr(n.as_f64().unwrap_or(0.0)));
    }
}

/// Python's `repr(float)`: shortest round-trip digits, fixed notation when the
/// decimal exponent is in `-4..16`, otherwise `d.ddde±XX`.
pub fn py_float_repr(x: f64) -> String {
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0" } else { "0.0" }.to_string();
    }
    // Rust's `{:e}` without a precision prints the shortest round-trip digits.
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let (neg, mantissa) = match mantissa.strip_prefix('-') {
        Some(m) => (true, m),
        None => (false, mantissa),
    };
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let mut out = String::with_capacity(digits.len() + 8);
    if neg {
        out.push('-');
    }
    if (-4..16).contains(&exp) {
        if exp >= 0 {
            let int_len = exp as usize + 1;
            if digits.len() <= int_len {
                out.push_str(&digits);
                out.extend(std::iter::repeat_n('0', int_len - digits.len()));
                out.push_str(".0");
            } else {
                out.push_str(&digits[..int_len]);
                out.push('.');
                out.push_str(&digits[int_len..]);
            }
        } else {
            out.push_str("0.");
            out.extend(std::iter::repeat_n('0', (-exp - 1) as usize));
            out.push_str(&digits);
        }
    } else {
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if exp < 0 { '-' } else { '+' });
        out.push_str(&format!("{:02}", exp.unsigned_abs()));
    }
    out
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(c),
            _ => {
                let mut units = [0u16; 2];
                for u in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{u:04x}"));
                }
            }
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floats_match_python_repr() {
        let cases = [
            (1.0, "1.0"),
            (0.1, "0.1"),
            (-2.5, "-2.5"),
            (1e-4, "0.0001"),
            (1e-5, "1e-05"),
            (1.5e-7, "1.5e-07"),
            (1e15, "1000000000000000.0"),
            (1e16, "1e+16"),
            (1.2345678901234568e17, "1.2345678901234568e+17"),
            (1e100, "1e+100"),
            (123.456, "123.456"),
            (0.30000000000000004, "0.30000000000000004"),
            (-0.0, "-0.0"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ];
        for (x, want) in cases {
            assert_eq!(py_float_repr(x), want, "{x:e}");
        }
    }

    #[test]
    fn strings_are_ascii_escaped_like_python() {
        let v = json!({"b": "é\u{1F600}\"\\\n\u{1}\u{7f}", "a": [1, 2.0, null, true]});
        assert_eq!(
            canonical(&v),
            r#"{"a":[1,2.0,null,true],"b":"\u00e9\ud83d\ude00\"\\\n\u0001\u007f"}"#
        );
    }
}
