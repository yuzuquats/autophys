//! `autophys export-trajectories`: read-only export of recorded reasoner
//! decisions as JSONL (one decision per line, sorted keys), with the
//! research score of the run when a `scores.json` sidecar names it.
//! Legacy usage stays opaque. Python reference: the former
//! `autophys.trajectories`.
use super::{Args, Failure, Kind, read_json};
use autophys::pyjson;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

fn walk(dir: &Path, suffix: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        let is_dir = p.is_dir();
        if p.to_string_lossy().ends_with(suffix)
            && (suffix != "scores.json" || p.file_name().is_some_and(|n| n == "scores.json"))
            && !is_dir
        {
            out.push(p.clone());
        }
        if is_dir {
            walk(&p, suffix, out);
        }
    }
}

fn resolve(p: &Path) -> String {
    p.canonicalize()
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// Every exported decision of `source` (a directory or one workbook).
pub fn trajectories(source: &Path) -> Result<Vec<Value>, String> {
    if !source.exists() {
        return Err("trajectory source does not exist".into());
    }
    let mut scores: HashMap<(String, String), Value> = HashMap::new();
    let workbooks = if source.is_dir() {
        let mut sidecars = vec![];
        walk(source, "scores.json", &mut sidecars);
        sidecars.sort();
        for path in sidecars {
            let report = read_json(&path)?;
            for run in report["runs"].as_array().into_iter().flatten() {
                let workbook = path
                    .parent()
                    .unwrap()
                    .join(run["workbook"].as_str().unwrap_or(""));
                scores.insert(
                    (
                        resolve(&workbook),
                        run["investigation"].as_str().unwrap_or("").to_string(),
                    ),
                    run["score"].clone(),
                );
            }
        }
        let mut books = vec![];
        walk(source, ".ap-workbook", &mut books);
        books.sort();
        books
    } else {
        vec![source.to_path_buf()]
    };
    let mut out = vec![];
    for path in workbooks {
        let client = autophys::connect(Some(&path.to_string_lossy())).map_err(|e| e.to_string())?;
        let resolved = resolve(&path);
        for wb in client.workbooks().map_err(|e| e.to_string())? {
            for info in wb.investigations().map_err(|e| e.to_string())? {
                let records = wb
                    .investigation(&info.id)
                    .and_then(|i| i.records(None))
                    .map_err(|e| e.to_string())?;
                let meta = records
                    .iter()
                    .find(|r| r.kind == "investigation")
                    .map(|r| r.payload.clone())
                    .unwrap_or(json!({}));
                for r in &records {
                    let step = &r.payload;
                    if r.kind != "step" || step.get("raw_output").is_none_or(Value::is_null) {
                        continue;
                    }
                    // Never invent prompt messages from evidence_text.
                    let normalized = autophys::usage::usage_total([step]);
                    let model = match step.get("model") {
                        Some(m) => m.clone(),
                        None => meta.get("model").cloned().unwrap_or(Value::Null),
                    };
                    let get = |k: &str| step.get(k).cloned().unwrap_or(Value::Null);
                    out.push(json!({
                        "investigation": info.id, "seq": r.seq,
                        "system_prompt_sha256": meta.get("system_prompt_sha256").cloned().unwrap_or(Value::Null),
                        "playbook": meta.get("playbook").cloned().unwrap_or(Value::Null),
                        "model": model, "prompt": get("evidence_text"), "messages": get("messages"),
                        "raw_response": get("raw_output"), "decision": get("decision"),
                        "valid": step.get("valid").cloned().unwrap_or(json!(false)),
                        "usage": if normalized["calls"].as_u64().unwrap_or(0) > 0 { get("usage") } else { Value::Null },
                        "replayed": step.get("replayed").cloned().unwrap_or(json!(false)),
                        "score": scores.get(&(resolved.clone(), info.id.clone())).cloned().unwrap_or(Value::Null),
                    }));
                }
            }
        }
    }
    Ok(out)
}

/// One line per decision; non-finite numbers are refused (`allow_nan=False`).
pub fn export(source: &Path, output: &mut impl Write) -> Result<usize, String> {
    let items = trajectories(source)?;
    for item in &items {
        let text = pyjson::dumps_sorted(item);
        if text.contains("NaN") && contains_nonfinite(item) {
            return Err("Out of range float values are not JSON compliant".into());
        }
        writeln!(output, "{text}").map_err(|e| e.to_string())?;
    }
    Ok(items.len())
}

fn contains_nonfinite(v: &Value) -> bool {
    match v {
        Value::Array(a) => a.iter().any(contains_nonfinite),
        Value::Object(m) => m.values().any(contains_nonfinite),
        v => pyjson::is_nonfinite(v),
    }
}

pub const USAGE: &str = "usage: autophys export-trajectories SOURCE [--output FILE]";

/// `autophys export-trajectories`.
pub fn command(words: Vec<String>, out: &mut impl Write) -> Result<(), Failure> {
    let args = Args::parse(words, &[("output", Kind::Value)], USAGE)?;
    let [source] = args.positional.as_slice() else {
        return Err(Failure::usage(format!(
            "exactly one SOURCE is required\n{USAGE}"
        )));
    };
    let source = Path::new(source);
    match args.get("output") {
        Some(path) => {
            // Exclusive creation protects both the input and previous exports.
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|e| Failure::error(format!("{path}: {e}")))?;
            export(source, &mut file).map_err(Failure::error)?;
        }
        None => {
            export(source, out).map_err(Failure::error)?;
        }
    }
    Ok(())
}
