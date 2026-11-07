//! Lab CSV import with an explicit channel and noise mapping, checked
//! against the declared experiment. Python reference:
//! `autophys.measurements.read_csv`. Sigma is never inferred.
use crate::{
    data::Observation,
    project::Project,
    simulator::{Result, Simulator, invalid, time_grid},
};
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::path::Path;

const MAX_BYTES: u64 = 1 << 20;

/// RFC 4180 rows (quoted fields, doubled quotes, CRLF or LF line ends).
fn parse_rows(text: &str) -> Result<Vec<Vec<String>>> {
    let mut rows = vec![];
    let mut row = vec![];
    let mut field = String::new();
    let mut chars = text.chars().peekable();
    let mut quoted = false;
    let mut any = false;
    while let Some(c) = chars.next() {
        any = true;
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                any = false;
            }
            c => field.push(c),
        }
    }
    if quoted {
        return Err(invalid("invalid numeric CSV: unterminated quoted field"));
    }
    if any {
        row.push(field);
        rows.push(row);
    }
    // csv.DictReader skips blank rows.
    rows.retain(|r| !(r.len() == 1 && r[0].is_empty()) && !r.is_empty());
    Ok(rows)
}

/// `numpy.allclose(a, b, rtol, atol)`: `|a - b| <= atol + rtol * |b|`.
fn allclose(a: &[f64], b: &[f64], rtol: f64, atol: f64) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| (x - y).abs() <= atol + rtol * y.abs())
}

/// Python `float(text)` for decimal numbers (surrounding whitespace allowed).
fn py_float(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() || t.contains('_') {
        return None;
    }
    t.parse().ok()
}

/// Whether the project's simulator is the built-in battery model, whose
/// CSV also carries the current waveform.
pub fn is_battery(project: &Project) -> bool {
    project.simulator.name == "battery_ecm"
}

/// Read `path` (inside `root`) as the measurement of `experiment`.
/// `columns` maps the logical names `t`, each output and (battery)
/// `current` to CSV headers; `sigma` must declare every output unless the
/// project does. `settings` overrides the catalog experiment (an approved
/// proposal's settings).
#[allow(clippy::too_many_arguments)]
pub fn read_csv(
    project: &Project,
    root: &Path,
    path: &str,
    experiment: &str,
    settings: Option<Value>,
    columns: Option<IndexMap<String, String>>,
    sigma: Option<IndexMap<String, f64>>,
    split: &str,
) -> Result<Observation> {
    if !["train", "validation"].contains(&split) {
        return Err(invalid(
            "split must be train or validation; test data is evaluator-only",
        ));
    }
    let root = root
        .canonicalize()
        .map_err(|_| invalid("the configured lab root does not exist"))?;
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME")
            .map(|h| Path::new(&h).join(rest))
            .unwrap_or_else(|| path.into()),
        None => std::path::PathBuf::from(path),
    };
    let file = root
        .join(expanded)
        .canonicalize()
        .map_err(|_| invalid(format!("CSV does not exist: {path}")))?;
    let relative = file
        .strip_prefix(&root)
        .map_err(|_| invalid("CSV must be inside the configured lab root"))?
        .to_path_buf();
    let size = std::fs::metadata(&file)
        .map_err(|e| invalid(e.to_string()))?
        .len();
    if size > MAX_BYTES {
        return Err(invalid(
            "CSV exceeds 1 MiB; split it into smaller measurements",
        ));
    }
    let raw = std::fs::read(&file).map_err(|e| invalid(e.to_string()))?;
    let text = std::str::from_utf8(&raw).map_err(|_| invalid("invalid numeric CSV: not UTF-8"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = parse_rows(text)?.into_iter();
    let names = rows.next().unwrap_or_default();
    let mut unique = names.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != names.len() {
        return Err(invalid("CSV headers must be unique"));
    }
    let battery = is_battery(project);
    let outputs = &project.simulator.outputs;
    let mapping: IndexMap<String, String> = columns.unwrap_or_else(|| {
        if battery {
            [("t", "time"), ("current", "current"), ("v", "voltage")]
                .into_iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect()
        } else {
            std::iter::once(("t".to_string(), "time".to_string()))
                .chain(outputs.iter().map(|ch| (ch.clone(), ch.clone())))
                .collect()
        }
    });
    let mut required: Vec<String> = std::iter::once("t".to_string())
        .chain(outputs.iter().cloned())
        .chain(battery.then(|| "current".to_string()))
        .collect();
    required.sort();
    required.dedup();
    let mut given: Vec<String> = mapping.keys().cloned().collect();
    given.sort();
    if given != required || mapping.values().any(|h| !names.contains(h)) {
        return Err(invalid(format!(
            "columns must map {} to existing CSV headers",
            crate::pyjson::dumps(&json!(required)).replace('"', "'")
        )));
    }
    let rows: Vec<Vec<String>> = rows.collect();
    if !(2..=10000).contains(&rows.len()) {
        return Err(invalid("CSV needs 2..10000 rows"));
    }
    let mut values: IndexMap<String, Vec<f64>> = IndexMap::new();
    for (key, header) in &mapping {
        let index = names.iter().position(|n| n == header).unwrap();
        let column = rows
            .iter()
            .map(|r| r.get(index).and_then(|v| py_float(v)))
            .collect::<Option<Vec<f64>>>()
            .ok_or_else(|| invalid(format!("invalid numeric CSV: column {header}")))?;
        values.insert(key.clone(), column);
    }
    if values.values().flatten().any(|v| !v.is_finite()) {
        return Err(invalid("CSV values must be finite"));
    }
    let t = values["t"].clone();
    if t[0] != 0. || t.windows(2).any(|w| w[1] - w[0] <= 0.) {
        return Err(invalid(
            "time must start at zero and increase strictly (seconds)",
        ));
    }
    let settings = match settings {
        Some(s) => s,
        None => project.simulator.experiment(&json!(experiment))?,
    };
    let grid = time_grid(&settings)?;
    if !allclose(&grid, &t, 1e-9, 1e-9) {
        return Err(invalid(
            "CSV time grid differs from the declared/approved experiment",
        ));
    }
    if battery {
        let expected = t
            .iter()
            .map(|tt| crate::models::battery::current(&settings, *tt))
            .collect::<Result<Vec<f64>>>()?;
        if !allclose(&values["current"], &expected, 1e-5, 1e-6) {
            return Err(invalid(
                "CSV current differs from the declared/approved battery waveform; declare a matching experiment",
            ));
        }
    }
    let noise: IndexMap<String, f64> = sigma
        .or_else(|| project.noise.sigma.clone().map(|s| s.into_iter().collect()))
        .unwrap_or_default();
    let mut declared: Vec<&String> = noise.keys().collect();
    declared.sort();
    let mut wanted: Vec<&String> = outputs.iter().collect();
    wanted.sort();
    if declared != wanted || noise.values().any(|s| !s.is_finite() || *s <= 0.) {
        return Err(invalid(format!(
            "sigma must declare a finite positive standard deviation for {}",
            crate::pyjson::dumps(&json!(outputs)).replace('"', "'")
        )));
    }
    let y: IndexMap<String, Vec<f64>> = outputs
        .iter()
        .map(|ch| (ch.clone(), values[ch].clone()))
        .collect();
    let sigma: IndexMap<String, f64> = noise;
    let mut o = Observation::new(experiment, settings, t, y, sigma)?;
    o.split = split.into();
    o.source = "csv".into();
    o.meta = json!({"path": relative.to_string_lossy(),
        "csv_sha256": crate::sha256_hex([raw.as_slice()]), "columns": mapping});
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_quotes_and_blank_lines() {
        let rows = parse_rows("a,\"b,c\"\r\n1,\"2\"\"\"\n\n3,4").unwrap();
        assert_eq!(
            rows,
            vec![vec!["a", "b,c"], vec!["1", "2\""], vec!["3", "4"]]
        );
        assert_eq!(py_float(" 1.5 "), Some(1.5));
        assert_eq!(py_float("1_0"), None);
    }
}
