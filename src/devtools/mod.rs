//! Developer commands on the SDK primitives (`sdks/rust`): `bench`,
//! `research`, `autoloop`, `export-trajectories` and `mcp`. They moved here
//! from the Python SDK's `python -m autophys.cli` in phase B of the one-CLI
//! plan (cli.md); flags, defaults, files and output keep that shape. The
//! numerics, policies, reasoners, playbooks and workbooks are library calls;
//! this module only orchestrates them.
pub mod autoloop;
pub mod bench;
pub mod mcp;
pub mod research;
pub mod trajectories;

use std::collections::BTreeMap;

/// A command failure: the message for stderr and the exit status.
#[derive(Debug)]
pub struct Failure {
    pub code: u8,
    pub message: String,
}
impl Failure {
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            code: 2,
            message: message.into(),
        }
    }
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            code: 2,
            message: message.into(),
        }
    }
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::error(message)
    }
}

/// What a flag takes.
#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    /// `--flag` alone.
    Switch,
    /// `--flag VALUE` (or `--flag=VALUE`); the last one wins.
    Value,
    /// Repeatable `--flag VALUE`.
    Many,
}

/// Parsed words: flags by name (without `--`) and positionals.
#[derive(Debug, Default)]
pub struct Args {
    values: BTreeMap<String, Vec<String>>,
    pub positional: Vec<String>,
}

impl Args {
    /// Parse `words` against `spec`, as argparse would (no abbreviations).
    pub fn parse(words: Vec<String>, spec: &[(&str, Kind)], usage: &str) -> Result<Self, Failure> {
        let mut args = Args::default();
        let mut words = words.into_iter();
        while let Some(word) = words.next() {
            let Some(flag) = word.strip_prefix("--") else {
                args.positional.push(word);
                continue;
            };
            let (name, inline) = match flag.split_once('=') {
                Some((n, v)) => (n.to_string(), Some(v.to_string())),
                None => (flag.to_string(), None),
            };
            let Some((_, kind)) = spec.iter().find(|(n, _)| *n == name) else {
                return Err(Failure::usage(format!(
                    "unrecognized argument --{name}\n{usage}"
                )));
            };
            let entry = args.values.entry(name.clone()).or_default();
            match kind {
                Kind::Switch => {
                    if inline.is_some() {
                        return Err(Failure::usage(format!("--{name} takes no value\n{usage}")));
                    }
                    entry.push(String::new());
                }
                Kind::Value | Kind::Many => {
                    let value = match inline {
                        Some(v) => v,
                        None => words.next().ok_or_else(|| {
                            Failure::usage(format!("--{name} expects a value\n{usage}"))
                        })?,
                    };
                    if *kind == Kind::Value {
                        entry.clear();
                    }
                    entry.push(value);
                }
            }
        }
        Ok(args)
    }
    pub fn flag(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }
    pub fn get(&self, name: &str) -> Option<&str> {
        self.values
            .get(name)
            .and_then(|v| v.last())
            .map(String::as_str)
    }
    pub fn many(&self, name: &str) -> Vec<String> {
        self.values.get(name).cloned().unwrap_or_default()
    }
    pub fn string(&self, name: &str, default: &str) -> String {
        self.get(name).unwrap_or(default).to_string()
    }
    pub fn int(&self, name: &str, default: i64) -> Result<i64, Failure> {
        match self.get(name) {
            None => Ok(default),
            Some(v) => v.trim().parse().map_err(|_| {
                Failure::usage(format!("argument --{name}: invalid int value: '{v}'"))
            }),
        }
    }
    pub fn float(&self, name: &str) -> Result<Option<f64>, Failure> {
        self.get(name)
            .map(|v| {
                v.trim().parse().map_err(|_| {
                    Failure::usage(format!("argument --{name}: invalid float value: '{v}'"))
                })
            })
            .transpose()
    }
    pub fn choice(&self, name: &str, default: &str, choices: &[&str]) -> Result<String, Failure> {
        let v = self.string(name, default);
        if !choices.contains(&v.as_str()) {
            return Err(Failure::usage(format!(
                "argument --{name}: invalid choice: '{v}' (choose from {})",
                choices
                    .iter()
                    .map(|c| format!("'{c}'"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        Ok(v)
    }
    /// Comma-separated integer seeds (`--train-seeds 0,1,2`).
    pub fn seeds(&self, name: &str, default: &[i64]) -> Result<Vec<i64>, Failure> {
        match self.get(name) {
            None => Ok(default.to_vec()),
            Some(v) => v
                .split(',')
                .map(|s| {
                    s.trim().parse().map_err(|_| {
                        Failure::usage(format!("argument --{name}: invalid value: '{v}'"))
                    })
                })
                .collect(),
        }
    }
}

/// Whether live (paid) model calls are allowed: `AUTOPHYS_ALLOW_LIVE_REASON=1`.
pub fn live_allowed() -> bool {
    std::env::var("AUTOPHYS_ALLOW_LIVE_REASON").as_deref() == Ok("1")
}

/// `AUTOPHYS_REASON_REPLAY` when set and non-empty.
pub fn env_replay() -> Option<String> {
    std::env::var("AUTOPHYS_REASON_REPLAY")
        .ok()
        .filter(|v| !v.is_empty())
}

/// UTC now as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// UTC now as `YYYYMMDDTHHMMSS`.
pub fn stamp() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%S").to_string()
}

/// A random lowercase hex string of `bytes` bytes.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("system randomness");
    hex::encode(buf)
}

/// Write `value` as the Python SDK's strict sidecars do:
/// `json.dumps(clean(value), indent=2, sort_keys=True) + "\n"`, non-finite
/// floats as `null`.
pub fn write_json(path: &std::path::Path, value: &serde_json::Value) -> std::io::Result<()> {
    let clean = autophys::pyjson::finite_or_null(value);
    std::fs::write(path, autophys::pyjson::dumps_indent(&clean, 2, true) + "\n")
}

/// Read a JSON file that Python may have written (NaN/Infinity tokens).
pub fn read_json(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    autophys::pyjson::loads(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// The SHA-256 of `text`, lowercase hex.
pub fn sha(text: &str) -> String {
    autophys::sha256_hex([text.as_bytes()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argparse_shapes() {
        let spec = [
            ("case", Kind::Many),
            ("seeds", Kind::Value),
            ("json", Kind::Switch),
        ];
        let a = Args::parse(
            ["--case", "a", "--case=b", "--seeds", "2", "--json", "src"]
                .map(String::from)
                .to_vec(),
            &spec,
            "usage",
        )
        .unwrap();
        assert_eq!(a.many("case"), ["a", "b"]);
        assert_eq!(a.int("seeds", 3).unwrap(), 2);
        assert!(a.flag("json"));
        assert_eq!(a.positional, ["src"]);
        assert!(Args::parse(vec!["--nope".into()], &spec, "u").is_err());
        assert!(Args::parse(vec!["--seeds".into()], &spec, "u").is_err());
    }
}
