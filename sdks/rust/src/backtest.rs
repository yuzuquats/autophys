//! Backtest examples: a hidden system a model must discover through the
//! investigation loop, declared as data (`examples/<name>.backtest/`). See
//! `autophys.project.docs/content/examples.md`.
//!
//! `example.toml` is what the model is told: the simulator, the recorded
//! runs it may request, and each case's starting data and budget.
//! `hidden/cases.toml` holds the truth (and its per-seed ranges), the
//! noise, the held-out tests and how each case is scored; it reaches the
//! [`Evaluator`] and the runner, never a policy. The built-in backtests are
//! copies of the repository's `examples/*.backtest` (a test keeps them
//! byte-identical), so this crate builds on its own.
//!
//! A case either **generates** data from the simulator at the hidden truth
//! (with noise), or replays **recorded** runs (`[[dataset]]`, decision
//! EX-5): the model's experiment menu is then exactly the recorded runs,
//! and the score is prediction error on held-out runs, plus parameter error
//! when the truth is known. Dataset files are fetched by URL and sha256 into
//! the data directory, never built into the binary (EX-7); a folder on disk
//! may also point at a local `file`.
//!
//! The simulator is a built-in model (`[system] model`) or the example's own
//! Python project (`[system] project = "module:attr"`, imported from the
//! example folder by `python -m autophys.worker`, decision EX-6).
//!
//! With `Overrides::drawn_truth`, a generator case's truth is drawn per seed
//! from `[prior]` (EX-4); [`Backtest::regime_problems`] checks that every
//! draw keeps the case's expected answer.
//!
//! A reference is `[SCHEME:]SOURCE[#CASE]` (decision EX-10): `builtin:NAME`
//! (a bare name is the same), or `path:DIR` (a source starting with `./`,
//! `../`, `/` or `~` is the same). Built-in cases keep their stable ids
//! (`battery`, `battery-short-only`, …), which records, replay files and
//! results use; `builtin:battery#full` and `battery` name the same case.
use crate::{
    data::{Dataset, Observation},
    fit::rng::NumpyRng,
    models,
    project::CatalogEntry,
    sensitivity::{DEFAULT_RULE, analyze},
    simulator::{FunctionSimulator, Params, Result, Simulator, invalid, number, time_grid},
    synthetic::{CaseView, Evaluator, NoiseModel, SyntheticRunner, build, observe},
};
use indexmap::IndexMap;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The built-in backtests in suite order: `(name, example.toml, hidden/cases.toml)`.
pub const BUILTIN: [(&str, &str, &str); 4] = [
    (
        "oscillator",
        include_str!("backtests/oscillator.backtest/example.toml"),
        include_str!("backtests/oscillator.backtest/hidden/cases.toml"),
    ),
    (
        "thermal",
        include_str!("backtests/thermal.backtest/example.toml"),
        include_str!("backtests/thermal.backtest/hidden/cases.toml"),
    ),
    (
        "battery",
        include_str!("backtests/battery.backtest/example.toml"),
        include_str!("backtests/battery.backtest/hidden/cases.toml"),
    ),
    (
        "battery-recorded",
        include_str!("backtests/battery-recorded.backtest/example.toml"),
        include_str!("backtests/battery-recorded.backtest/hidden/cases.toml"),
    ),
];

/// Where an example comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Builtin(String),
    Path(PathBuf),
}

/// A parsed `[SCHEME:]SOURCE[#CASE]` reference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ref {
    pub source: Source,
    pub case: Option<String>,
}

impl Ref {
    /// `builtin:NAME[#CASE]` or `path:DIR[#CASE]`, the spelling results record.
    pub fn canonical(&self) -> String {
        let source = match &self.source {
            Source::Builtin(name) => format!("builtin:{name}"),
            Source::Path(dir) => format!("path:{}", dir.display()),
        };
        match &self.case {
            Some(case) => format!("{source}#{case}"),
            None => source,
        }
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The kinds an example folder's suffix may name.
pub const KINDS: [&str; 3] = ["template", "demo", "backtest"];

/// Split `NAME.KIND` into its name and kind, when the suffix is a kind.
pub fn split_kind(dir_name: &str) -> Option<(&str, &str)> {
    let (name, kind) = dir_name.rsplit_once('.')?;
    (KINDS.contains(&kind) && valid_name(name)).then_some((name, kind))
}

/// Parse a reference. A path is kept as written (`~` expanded); a built-in
/// name may carry its kind suffix (`battery.backtest`), which is dropped.
pub fn parse_ref(text: &str) -> std::result::Result<Ref, String> {
    let (source, case) = match text.split_once('#') {
        Some((source, case)) => {
            if !valid_name(case) {
                return Err(format!(
                    "{text:?}: the case after # must be lowercase letters, digits and -"
                ));
            }
            (source, Some(case.to_string()))
        }
        None => (text, None),
    };
    let path_like = |s: &str| {
        s.starts_with("./")
            || s.starts_with("../")
            || s.starts_with('/')
            || s.starts_with('~')
            || s == "."
            || s == ".."
    };
    let source = if let Some(name) = source.strip_prefix("builtin:") {
        Source::Builtin(builtin_name(name, text)?)
    } else if let Some(path) = source.strip_prefix("path:") {
        if path.is_empty() {
            return Err(format!("{text:?}: path: needs a directory"));
        }
        Source::Path(expand_home(path))
    } else if path_like(source) {
        Source::Path(expand_home(source))
    } else if let Some((scheme, _)) = source.split_once(':') {
        return Err(format!(
            "{text:?}: unknown scheme {scheme:?}; use builtin:NAME or path:DIR"
        ));
    } else {
        Source::Builtin(builtin_name(source, text)?)
    };
    Ok(Ref { source, case })
}

fn builtin_name(name: &str, text: &str) -> std::result::Result<String, String> {
    let name = split_kind(name).map(|(n, _)| n).unwrap_or(name);
    if valid_name(name) {
        Ok(name.to_string())
    } else {
        Err(format!(
            "{text:?}: a built-in example name is lowercase letters, digits and -"
        ))
    }
}

fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(rest))
            .unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    }
}

/// How a case's data appears.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaseSource {
    /// From the simulator at the hidden truth, with noise.
    Generator,
    /// From recorded runs (`[[dataset]]`).
    Datasets,
}

/// One case: what the model is told, plus its hidden scoring.
#[derive(Clone, Debug)]
pub struct CaseSpec {
    /// Local name, the part after `#`.
    pub name: String,
    /// The stable id records and results use: a built-in's declared id, or
    /// the canonical reference for a case loaded from a path.
    pub id: String,
    /// In the default suite (`autophys bench` with no `--example`).
    pub suite: bool,
    pub source: CaseSource,
    pub max_experiments: usize,
    pub max_test_hours: Option<f64>,
    pub train: Vec<Value>,
    pub validation: Vec<Value>,
    bias: Params,
    missing: f64,
    combos: IndexMap<String, Params>,
    expected_non_identified: BTreeSet<String>,
    note: String,
    /// Dataset cases: the held-out recorded runs that score prediction.
    test_datasets: Vec<String>,
}

/// A recorded run (`[[dataset]]`).
#[derive(Clone, Debug)]
pub struct DatasetSpec {
    pub name: String,
    pub settings: Value,
    /// A file in the example folder (folders on disk only).
    pub file: Option<String>,
    /// Fetched into the data directory and checked against `sha256`.
    pub url: Option<String>,
    pub sha256: String,
    /// `t` names the time column; every other key is a channel.
    pub columns: IndexMap<String, String>,
    pub sigma: Params,
    pub provenance: String,
    /// Listed in `hidden/cases.toml`: only ever a held-out test.
    pub hidden: bool,
}

/// How a parameter's truth is drawn per seed (EX-4).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Prior {
    Uniform(f64, f64),
    LogUniform(f64, f64),
}

impl Prior {
    fn draw(self, rng: &mut NumpyRng) -> f64 {
        let u = rng.uniform();
        match self {
            Prior::Uniform(lo, hi) => lo + (hi - lo) * u,
            Prior::LogUniform(lo, hi) => (lo.ln() + (hi.ln() - lo.ln()) * u).exp(),
        }
    }
}

/// The simulator a backtest runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum System {
    /// A built-in model (`battery_ecm`, `oscillator`, `thermal_rc`).
    Model(String),
    /// The example's own Python project, `module:attr` (EX-6).
    Project(String),
}

/// A loaded backtest example.
#[derive(Clone, Debug)]
pub struct Backtest {
    pub name: String,
    pub source: Source,
    pub title: String,
    pub summary: String,
    pub system: System,
    setup_hours: Option<f64>,
    pub cases: Vec<CaseSpec>,
    pub datasets: Vec<DatasetSpec>,
    truth: Params,
    prior: IndexMap<String, Prior>,
    sigma: Params,
    test: Vec<Value>,
}

/// Changes made on top of a declared case.
#[derive(Clone, Debug, Default)]
pub struct Overrides {
    pub max_experiments: Option<usize>,
    pub bias: Option<Params>,
    pub missing: Option<f64>,
    /// Draw a generator case's truth for this seed from `[prior]` (EX-4).
    pub drawn_truth: bool,
}

fn toml_value(text: &str, what: &str) -> Result<Value> {
    let table: toml::Table = toml::from_str(text).map_err(|e| invalid(format!("{what}: {e}")))?;
    serde_json::to_value(table).map_err(|e| invalid(format!("{what}: {e}")))
}

fn field<'a>(v: &'a Value, key: &str, what: &str) -> Result<&'a Value> {
    v.get(key)
        .ok_or_else(|| invalid(format!("{what}: missing {key}")))
}

fn text(v: &Value, key: &str, what: &str) -> Result<String> {
    field(v, key, what)?
        .as_str()
        .map(String::from)
        .ok_or_else(|| invalid(format!("{what}: {key} must be a string")))
}

fn params(v: &Value, what: &str) -> Result<Params> {
    let Some(table) = v.as_object() else {
        return Err(invalid(format!("{what} must be a table of numbers")));
    };
    table
        .iter()
        .map(|(k, x)| {
            x.as_f64()
                .filter(|x| x.is_finite())
                .map(|x| (k.clone(), x))
                .ok_or_else(|| invalid(format!("{what}.{k} must be a number")))
        })
        .collect()
}

fn experiments(v: Option<&Value>, what: &str) -> Result<Vec<Value>> {
    match v {
        None => Ok(vec![]),
        Some(Value::Array(items)) => {
            for item in items {
                if !(item.is_string() || item.is_object()) {
                    return Err(invalid(format!(
                        "{what}: each entry is a catalog name or a settings table"
                    )));
                }
            }
            Ok(items.clone())
        }
        Some(_) => Err(invalid(format!("{what} must be an array"))),
    }
}

fn names(v: Option<&Value>, what: &str) -> Result<Vec<String>> {
    match v {
        None => Ok(vec![]),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| x.as_str().map(String::from))
            .collect::<Option<_>>()
            .ok_or_else(|| invalid(format!("{what} lists names"))),
        Some(_) => Err(invalid(format!("{what} lists names"))),
    }
}

/// A built-in simulator by model name.
pub fn simulator(model: &str) -> Result<FunctionSimulator> {
    match model {
        "battery_ecm" => Ok(models::battery_ecm()),
        "oscillator" => Ok(models::oscillator()),
        "thermal_rc" => Ok(models::thermal_rc()),
        other => Err(invalid(format!(
            "unknown model {other:?}; use battery_ecm, oscillator or thermal_rc, or [system] project = \"module:attr\""
        ))),
    }
}

fn datasets(v: Option<&Value>, hidden: bool, what: &str) -> Result<Vec<DatasetSpec>> {
    let Some(v) = v else { return Ok(vec![]) };
    let items = v
        .as_array()
        .ok_or_else(|| invalid(format!("{what}: [[dataset]] must be an array of tables")))?;
    items
        .iter()
        .map(|d| {
            let name = text(d, "name", &format!("{what} [[dataset]]"))?;
            let dw = format!("{what} dataset {name}");
            let settings = field(d, "settings", &dw)?.clone();
            if !settings.is_object() {
                return Err(invalid(format!("{dw}: settings must be a table")));
            }
            let file = d.get("file").and_then(Value::as_str).map(String::from);
            let url = d.get("url").and_then(Value::as_str).map(String::from);
            if file.is_some() == url.is_some() {
                return Err(invalid(format!("{dw}: give exactly one of file or url")));
            }
            let sha256 = text(d, "sha256", &dw)?;
            if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(invalid(format!("{dw}: sha256 must be 64 hex digits")));
            }
            let columns: IndexMap<String, String> = field(d, "columns", &dw)?
                .as_object()
                .ok_or_else(|| invalid(format!("{dw}: columns must be a table")))?
                .iter()
                .map(|(k, v)| {
                    v.as_str()
                        .map(|s| (k.clone(), s.to_string()))
                        .ok_or_else(|| invalid(format!("{dw}: columns.{k} must be a string")))
                })
                .collect::<Result<_>>()?;
            if !columns.contains_key("t") || columns.len() < 2 {
                return Err(invalid(format!(
                    "{dw}: columns needs t (the time column) and at least one channel"
                )));
            }
            let sigma = params(field(d, "sigma", &dw)?, &format!("{dw} sigma"))?;
            if let Some(ch) = columns
                .keys()
                .find(|k| *k != "t" && !sigma.contains_key(*k))
            {
                return Err(invalid(format!("{dw}: channel {ch} has no sigma")));
            }
            let provenance = text(d, "provenance", &dw)?;
            if provenance != "synthetic" && provenance != "measured" {
                return Err(invalid(format!(
                    "{dw}: provenance is synthetic or measured"
                )));
            }
            if provenance == "measured"
                && (d
                    .get("license")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .is_empty()
                    || d.get("source")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .is_empty())
            {
                return Err(invalid(format!(
                    "{dw}: measured data needs a license and a source"
                )));
            }
            Ok(DatasetSpec {
                name,
                settings,
                file,
                url,
                sha256: sha256.to_ascii_lowercase(),
                columns,
                sigma,
                provenance,
                hidden,
            })
        })
        .collect()
}

/// The directory downloaded datasets are cached in: `AUTOPHYS_DATASETS_DIR`,
/// else `$XDG_DATA_HOME/tento/autophys/datasets`, else
/// `~/.local/share/tento/autophys/datasets`.
pub fn datasets_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("AUTOPHYS_DATASETS_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("tento/autophys/datasets")
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Linear interpolation as `numpy.interp` (ends held).
fn interp(x: f64, xp: &[f64], fp: &[f64]) -> f64 {
    if x <= xp[0] {
        return fp[0];
    }
    let last = xp.len() - 1;
    if x >= xp[last] {
        return fp[last];
    }
    let j = xp.partition_point(|v| *v <= x) - 1;
    let slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
    slope * (x - xp[j]) + fp[j]
}

/// Parse a plain CSV (a header row, comma-separated numbers).
fn csv_columns(text: &str, what: &str) -> Result<IndexMap<String, Vec<f64>>> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header: Vec<String> = lines
        .next()
        .ok_or_else(|| invalid(format!("{what}: empty CSV")))?
        .split(',')
        .map(|h| h.trim().trim_start_matches('\u{feff}').to_string())
        .collect();
    let mut cols: IndexMap<String, Vec<f64>> = header.iter().map(|h| (h.clone(), vec![])).collect();
    for (i, line) in lines.enumerate() {
        let cells: Vec<&str> = line.split(',').collect();
        if cells.len() != header.len() {
            return Err(invalid(format!(
                "{what}: row {} has {} cells, not {}",
                i + 2,
                cells.len(),
                header.len()
            )));
        }
        for (h, c) in header.iter().zip(cells) {
            let v: f64 = c
                .trim()
                .parse()
                .map_err(|_| invalid(format!("{what}: row {}: {c:?} is not a number", i + 2)))?;
            cols[h].push(v);
        }
    }
    Ok(cols)
}

impl Backtest {
    /// Parse a backtest from its two files. `source` decides the case ids.
    pub fn parse(name: &str, source: Source, example: &str, hidden: &str) -> Result<Self> {
        let what = format!("{name}.backtest");
        let ex = toml_value(example, &format!("{what}/example.toml"))?;
        let hid = toml_value(hidden, &format!("{what}/hidden/cases.toml"))?;
        let kind = text(&ex, "kind", &what)?;
        if kind != "backtest" {
            return Err(invalid(format!(
                "{what}: kind is {kind:?}, not \"backtest\""
            )));
        }
        let system_table = field(&ex, "system", &what)?;
        let system = match (
            system_table.get("model").and_then(Value::as_str),
            system_table.get("project").and_then(Value::as_str),
        ) {
            (Some(model), None) => {
                simulator(model)?;
                System::Model(model.into())
            }
            (None, Some(project)) => {
                if !matches!(source, Source::Path(_)) {
                    return Err(invalid(format!(
                        "{what}: a built-in backtest uses a built-in model (EX-6)"
                    )));
                }
                if !project.contains(':') {
                    return Err(invalid(format!("{what}: project is \"module:attr\"")));
                }
                System::Project(project.into())
            }
            _ => {
                return Err(invalid(format!(
                    "{what}: [system] needs exactly one of model or project"
                )));
            }
        };
        let setup_hours =
            match system_table.get("experiment_cost") {
                None => None,
                Some(cost) => Some(cost.get("setup_hours").and_then(Value::as_f64).ok_or_else(
                    || invalid(format!("{what}: experiment_cost needs setup_hours")),
                )?),
            };
        let truth = match hid.get("truth") {
            None => Params::new(),
            Some(t) => params(t, &format!("{what} [truth]"))?,
        };
        let prior = match hid.get("prior") {
            None => IndexMap::new(),
            Some(p) => p
                .as_object()
                .ok_or_else(|| invalid(format!("{what}: [prior] must be a table")))?
                .iter()
                .map(|(k, v)| {
                    let pw = format!("{what} prior.{k}");
                    if !truth.contains_key(k) {
                        return Err(invalid(format!("{pw}: [truth] has no {k}")));
                    }
                    let range = |key: &str| -> Option<(f64, f64)> {
                        let a = v.get(key)?.as_array()?;
                        match a.as_slice() {
                            [lo, hi] => Some((lo.as_f64()?, hi.as_f64()?)),
                            _ => None,
                        }
                    };
                    let prior = match (range("uniform"), range("log_uniform")) {
                        (Some((lo, hi)), None) if lo < hi => Prior::Uniform(lo, hi),
                        (None, Some((lo, hi))) if 0. < lo && lo < hi => Prior::LogUniform(lo, hi),
                        _ => {
                            return Err(invalid(format!(
                                "{pw}: give uniform = [lo, hi] or log_uniform = [lo, hi] (0 < lo < hi)"
                            )));
                        }
                    };
                    let fixed = truth[k];
                    let (lo, hi) = match prior {
                        Prior::Uniform(lo, hi) | Prior::LogUniform(lo, hi) => (lo, hi),
                    };
                    if !(lo <= fixed && fixed <= hi) {
                        return Err(invalid(format!(
                            "{pw}: the fixed truth {fixed} is outside [{lo}, {hi}]"
                        )));
                    }
                    Ok((k.clone(), prior))
                })
                .collect::<Result<_>>()?,
        };
        let sigma = match hid.get("noise").and_then(|n| n.get("sigma")) {
            None => Params::new(),
            Some(s) => params(s, &format!("{what} noise.sigma"))?,
        };
        let test = experiments(hid.get("test"), &format!("{what} [[test]]"))?;
        let mut all_datasets = datasets(ex.get("dataset"), false, &what)?;
        all_datasets.extend(datasets(
            hid.get("dataset"),
            true,
            &format!("{what} (hidden)"),
        )?);
        let mut seen = BTreeSet::new();
        for d in &all_datasets {
            if !seen.insert(d.name.clone()) {
                return Err(invalid(format!(
                    "{what}: dataset {} declared twice",
                    d.name
                )));
            }
            if d.file.is_some() && matches!(source, Source::Builtin(_)) {
                return Err(invalid(format!(
                    "{what}: dataset {}: a built-in backtest fetches data by url (EX-7)",
                    d.name
                )));
            }
        }
        let hidden_cases = hid.get("case").cloned().unwrap_or(Value::Null);
        let mut cases: Vec<CaseSpec> = vec![];
        let declared = field(&ex, "case", &what)?
            .as_array()
            .ok_or_else(|| invalid(format!("{what}: [[case]] must be an array of tables")))?;
        for c in declared {
            let case_name = text(c, "name", &format!("{what} [[case]]"))?;
            let cw = format!("{what}#{case_name}");
            if !valid_name(&case_name) {
                return Err(invalid(format!(
                    "{cw}: a case name is lowercase letters, digits and -"
                )));
            }
            if cases.iter().any(|x| x.name == case_name) {
                return Err(invalid(format!("{cw}: case declared twice")));
            }
            let id = match &source {
                Source::Builtin(_) => text(c, "id", &cw)?,
                Source::Path(_) => Ref {
                    source: source.clone(),
                    case: Some(case_name.clone()),
                }
                .canonical(),
            };
            let case_source = match c
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("generator")
            {
                "generator" => CaseSource::Generator,
                "datasets" => CaseSource::Datasets,
                other => {
                    return Err(invalid(format!(
                        "{cw}: source {other:?}: use generator or datasets"
                    )));
                }
            };
            let budget = c.get("budget").cloned().unwrap_or(Value::Null);
            let max_experiments = match budget.get("max_experiments") {
                None => 0,
                Some(v) => v.as_u64().ok_or_else(|| {
                    invalid(format!(
                        "{cw}: budget.max_experiments must be a whole number"
                    ))
                })? as usize,
            };
            let max_test_hours = budget
                .get("max_test_hours")
                .map(|v| v.as_f64().unwrap_or(f64::NAN));
            if max_test_hours.is_some_and(|h| !h.is_finite() || h < 0.) {
                return Err(invalid(format!(
                    "{cw}: budget.max_test_hours must be a number >= 0"
                )));
            }
            let h = hidden_cases.get(&case_name).ok_or_else(|| {
                invalid(format!("{cw}: hidden/cases.toml has no [case.{case_name}]"))
            })?;
            let combos = match h.get("combos") {
                None => IndexMap::new(),
                Some(v) => v
                    .as_object()
                    .ok_or_else(|| invalid(format!("{cw}: combos must be a table")))?
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), params(v, &format!("{cw} combos.{k}"))?)))
                    .collect::<Result<IndexMap<_, _>>>()?,
            };
            for (combo, powers) in &combos {
                if let Some(p) = powers.keys().find(|p| !truth.contains_key(*p)) {
                    return Err(invalid(format!(
                        "{cw}: combo {combo} names {p}, which [truth] lacks"
                    )));
                }
            }
            let train = experiments(c.get("train"), &format!("{cw} train"))?;
            let validation = experiments(c.get("validation"), &format!("{cw} validation"))?;
            let test_datasets = names(h.get("test"), &format!("{cw} test"))?;
            match case_source {
                CaseSource::Generator => {
                    if truth.is_empty() || sigma.is_empty() {
                        return Err(invalid(format!(
                            "{cw}: a generator case needs [truth] and [noise] sigma in hidden/cases.toml"
                        )));
                    }
                    if combos.is_empty() {
                        return Err(invalid(format!("{cw}: a generator case scores combos")));
                    }
                }
                CaseSource::Datasets => {
                    if h.get("bias").is_some() || h.get("missing").is_some() {
                        return Err(invalid(format!(
                            "{cw}: bias and missing corrupt generated data; a dataset case replays its recordings as they are"
                        )));
                    }
                    for n in train.iter().chain(&validation) {
                        let n = n.as_str().ok_or_else(|| {
                            invalid(format!("{cw}: a dataset case lists dataset names"))
                        })?;
                        match all_datasets.iter().find(|d| d.name == n) {
                            None => return Err(invalid(format!("{cw}: no dataset {n}"))),
                            Some(d) if d.hidden => {
                                return Err(invalid(format!(
                                    "{cw}: hidden dataset {n} can only be a test"
                                )));
                            }
                            _ => {}
                        }
                    }
                    if test_datasets.is_empty() {
                        return Err(invalid(format!(
                            "{cw}: a dataset case names held-out runs: [case.{case_name}] test = [...]"
                        )));
                    }
                    if let Some(n) = test_datasets
                        .iter()
                        .find(|n| !all_datasets.iter().any(|d| &&d.name == n))
                    {
                        return Err(invalid(format!("{cw}: no dataset {n}")));
                    }
                }
            }
            cases.push(CaseSpec {
                name: case_name.clone(),
                id,
                suite: c.get("suite").and_then(Value::as_bool).unwrap_or(true),
                source: case_source,
                max_experiments,
                max_test_hours,
                train,
                validation,
                bias: match h.get("bias") {
                    None => Params::new(),
                    Some(b) => params(b, &format!("{cw} bias"))?,
                },
                missing: h.get("missing").and_then(Value::as_f64).unwrap_or(0.),
                combos,
                expected_non_identified: names(
                    h.get("expected_non_identified"),
                    &format!("{cw} expected_non_identified"),
                )?
                .into_iter()
                .collect(),
                note: h
                    .get("note")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                test_datasets,
            });
        }
        if cases.is_empty() {
            return Err(invalid(format!("{what}: no [[case]]")));
        }
        if let Some(extra) = hidden_cases
            .as_object()
            .and_then(|m| m.keys().find(|k| !cases.iter().any(|c| &c.name == *k)))
        {
            return Err(invalid(format!(
                "{what}: hidden [case.{extra}] has no [[case]] in example.toml"
            )));
        }
        Ok(Self {
            name: name.into(),
            source,
            title: text(&ex, "title", &what)?,
            summary: text(&ex, "summary", &what)?,
            system,
            setup_hours,
            cases,
            datasets: all_datasets,
            truth,
            prior,
            sigma,
            test,
        })
    }

    /// A built-in backtest by name.
    pub fn builtin(name: &str) -> Result<Self> {
        let (n, example, hidden) =
            BUILTIN.iter().find(|(n, _, _)| *n == name).ok_or_else(|| {
                invalid(format!(
                    "no built-in backtest {name:?}; built-in: {}",
                    BUILTIN.map(|b| b.0).join(", ")
                ))
            })?;
        Self::parse(n, Source::Builtin(n.to_string()), example, hidden)
    }

    /// A backtest folder on disk (`NAME.backtest/`), its path made absolute.
    pub fn load_dir(dir: &Path) -> Result<Self> {
        let dir =
            std::fs::canonicalize(dir).map_err(|e| invalid(format!("{}: {e}", dir.display())))?;
        let dir_name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = match split_kind(&dir_name) {
            Some((name, "backtest")) => name.to_string(),
            _ => {
                return Err(invalid(format!(
                    "{}: a backtest folder is named NAME.backtest",
                    dir.display()
                )));
            }
        };
        let read = |rel: &str| {
            std::fs::read_to_string(dir.join(rel))
                .map_err(|e| invalid(format!("{}: {e}", dir.join(rel).display())))
        };
        Self::parse(
            &name,
            Source::Path(dir.clone()),
            &read("example.toml")?,
            &read("hidden/cases.toml")?,
        )
    }

    /// The backtest a reference names (its case, if any, is not checked here).
    pub fn load(reference: &Ref) -> Result<Self> {
        match &reference.source {
            Source::Builtin(name) => Self::builtin(name),
            Source::Path(dir) => Self::load_dir(dir),
        }
    }

    pub fn case(&self, name: &str) -> Result<&CaseSpec> {
        self.cases.iter().find(|c| c.name == name).ok_or_else(|| {
            invalid(format!(
                "{} has no case {name:?}; cases: {}",
                self.name,
                self.cases
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })
    }

    /// The canonical reference of one case.
    pub fn reference(&self, case: &CaseSpec) -> String {
        Ref {
            source: self.source.clone(),
            case: Some(case.name.clone()),
        }
        .canonical()
    }

    /// The example's simulator: a built-in model, or its Python project
    /// served by `python -m autophys.worker --root DIR` (`AUTOPHYS_PYTHON`,
    /// else `python3`).
    pub fn simulator(&self) -> Result<FunctionSimulator> {
        match &self.system {
            System::Model(model) => simulator(model),
            System::Project(reference) => {
                let Source::Path(dir) = &self.source else {
                    return Err(invalid("a project simulator needs a backtest folder"));
                };
                let python = std::env::var("AUTOPHYS_PYTHON")
                    .ok()
                    .filter(|p| !p.is_empty())
                    .unwrap_or_else(|| "python3".into());
                let mut command = std::process::Command::new(&python);
                command
                    .args(["-m", "autophys.worker", "--root"])
                    .arg(dir)
                    .arg(reference);
                let project = crate::worker::project(command, reference).map_err(|e| {
                    invalid(format!(
                        "{}: {e}\n{python} must have the autophys SDK installed (set AUTOPHYS_PYTHON)",
                        self.name
                    ))
                })?;
                Ok(project.simulator)
            }
        }
    }

    /// The truth for `seed`: the fixed `[truth]`, or each `[prior]`
    /// parameter drawn in `[truth]` order from `default_rng([seed, 3])`.
    pub fn truth_for(&self, seed: u64, drawn: bool) -> Params {
        if !drawn || self.prior.is_empty() {
            return self.truth.clone();
        }
        let mut rng = NumpyRng::from_entropy(&[seed, 3]);
        self.truth
            .iter()
            .map(|(k, v)| {
                let value = match self.prior.get(k) {
                    Some(p) => p.draw(&mut rng),
                    None => *v,
                };
                (k.clone(), value)
            })
            .collect()
    }

    /// Whether this example declares per-seed truth ranges.
    pub fn has_prior(&self) -> bool {
        !self.prior.is_empty()
    }

    fn dataset(&self, name: &str) -> Result<&DatasetSpec> {
        self.datasets
            .iter()
            .find(|d| d.name == name)
            .ok_or_else(|| invalid(format!("{}: no dataset {name}", self.name)))
    }

    /// A dataset's bytes, checked against its sha256: a `file` in the
    /// example folder, or a `url` fetched once into [`datasets_dir`].
    pub fn dataset_bytes(&self, d: &DatasetSpec) -> Result<Vec<u8>> {
        let check = |bytes: Vec<u8>, from: &str| {
            let sum = sha256_hex(&bytes);
            if sum == d.sha256 {
                Ok(bytes)
            } else {
                Err(invalid(format!(
                    "dataset {} from {from} has sha256 {sum}, not {}",
                    d.name, d.sha256
                )))
            }
        };
        if let Some(file) = &d.file {
            let Source::Path(dir) = &self.source else {
                return Err(invalid("a built-in backtest fetches data by url"));
            };
            let path = dir.join(file);
            let bytes =
                std::fs::read(&path).map_err(|e| invalid(format!("{}: {e}", path.display())))?;
            return check(bytes, &path.display().to_string());
        }
        let url = d.url.as_deref().unwrap_or_default();
        let cache = datasets_dir().join(&d.sha256);
        if let Ok(bytes) = std::fs::read(&cache) {
            if sha256_hex(&bytes) == d.sha256 {
                return Ok(bytes);
            }
        }
        let bytes = if let Some(path) = url.strip_prefix("file://") {
            std::fs::read(path).map_err(|e| invalid(format!("{url}: {e}")))?
        } else if url.starts_with("https://") || url.starts_with("http://") {
            let mut body = ureq::get(url)
                .call()
                .map_err(|e| invalid(format!("{url}: {e}")))?
                .into_body();
            body.with_config()
                .limit(1 << 30)
                .read_to_vec()
                .map_err(|e| invalid(format!("{url}: {e}")))?
        } else {
            return Err(invalid(format!(
                "dataset {}: url must be https://, http:// or file://",
                d.name
            )));
        };
        let bytes = check(bytes, url)?;
        let dir = datasets_dir();
        std::fs::create_dir_all(&dir).map_err(|e| invalid(format!("{}: {e}", dir.display())))?;
        let tmp = dir.join(format!(".{}.{}.tmp", d.sha256, std::process::id()));
        std::fs::write(&tmp, &bytes)
            .and_then(|_| std::fs::rename(&tmp, &cache))
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                invalid(format!("{}: {e}", cache.display()))
            })?;
        Ok(bytes)
    }

    /// A recorded run as an observation on its settings' time grid.
    pub fn recorded(&self, name: &str, split: &str) -> Result<Observation> {
        let d = self.dataset(name)?;
        let what = format!("dataset {name}");
        let bytes = self.dataset_bytes(d)?;
        let text =
            std::str::from_utf8(&bytes).map_err(|_| invalid(format!("{what}: not UTF-8")))?;
        let cols = csv_columns(text, &what)?;
        let col = |key: &str| -> Result<&Vec<f64>> {
            let c = &d.columns[key];
            cols.get(c)
                .ok_or_else(|| invalid(format!("{what}: no column {c:?}")))
        };
        let t = col("t")?;
        if t.len() < 2 || t.windows(2).any(|w| w[1] <= w[0]) {
            return Err(invalid(format!("{what}: time must strictly increase")));
        }
        let grid = time_grid(&d.settings)?;
        let (first, last) = (grid[0], grid[grid.len() - 1]);
        let tol = 0.5_f64.max(1e-6 * last.abs());
        if t[0] > first + tol || t[t.len() - 1] < last - tol {
            return Err(invalid(format!(
                "{what}: covers {}..{} s; its settings run {first}..{last} s",
                t[0],
                t[t.len() - 1]
            )));
        }
        let mut y = IndexMap::new();
        for ch in d.columns.keys().filter(|k| *k != "t") {
            let v = col(ch)?;
            y.insert(ch.clone(), grid.iter().map(|x| interp(*x, t, v)).collect());
        }
        let mut o = Observation::new(name, d.settings.clone(), grid, y, d.sigma.clone())?;
        o.split = split.into();
        o.source = d.provenance.clone();
        o.meta = json!({"dataset": name, "sha256": d.sha256});
        o.validate()?;
        Ok(o)
    }

    /// The case's view (for the policy) and evaluator (for scoring).
    pub fn build(
        &self,
        case: &CaseSpec,
        seed: u64,
        o: &Overrides,
    ) -> Result<(CaseView, Evaluator)> {
        let mut sim = self.simulator()?;
        let cost = |settings: &Value| -> Result<Option<f64>> {
            self.setup_hours
                .map(|setup| Ok(setup + number(settings, "duration")? / 3600.0))
                .transpose()
        };
        if case.source == CaseSource::Datasets {
            if o.bias.is_some() || o.missing.is_some() {
                return Err(invalid(format!(
                    "case {}: bias and missing corrupt generated data; a recorded case replays its runs as they are",
                    case.id
                )));
            }
            let used: BTreeSet<&str> = case
                .train
                .iter()
                .chain(&case.validation)
                .filter_map(Value::as_str)
                .chain(case.test_datasets.iter().map(String::as_str))
                .collect();
            let menu: Vec<&DatasetSpec> = self
                .datasets
                .iter()
                .filter(|d| !d.hidden && !used.contains(d.name.as_str()))
                .collect();
            sim.experiments = self
                .datasets
                .iter()
                .filter(|d| !d.hidden)
                .map(|d| (d.name.clone(), d.settings.clone()))
                .collect();
            let mut observations = vec![];
            for (split, list) in [("train", &case.train), ("validation", &case.validation)] {
                for n in list.iter().filter_map(Value::as_str) {
                    observations.push(self.recorded(n, split)?);
                }
            }
            let runs = menu
                .iter()
                .map(|d| Ok((d.name.clone(), self.recorded(&d.name, "train")?)))
                .collect::<Result<IndexMap<_, _>>>()?;
            let catalog = menu
                .iter()
                .map(|d| {
                    Ok((
                        d.name.clone(),
                        CatalogEntry {
                            max_runs: Some(1),
                            cost_hours: cost(&d.settings)?,
                            ..Default::default()
                        },
                    ))
                })
                .collect::<Result<IndexMap<_, _>>>()?;
            let test = case
                .test_datasets
                .iter()
                .map(|n| self.recorded(n, "test"))
                .collect::<Result<Vec<_>>>()?;
            let view = CaseView {
                name: case.id.clone(),
                simulator: sim,
                dataset: Dataset::new(observations)?,
                runner: SyntheticRunner::recorded(runs),
                max_experiments: o.max_experiments.unwrap_or(case.max_experiments),
                candidates: None,
                max_test_hours: case.max_test_hours,
                catalog: Some(catalog),
            };
            let ev = Evaluator {
                case: case.id.clone(),
                truth: self.truth.clone(),
                test,
                combos: case.combos.clone(),
                expected_non_identified: case.expected_non_identified.clone(),
                note: case.note.clone(),
            };
            return Ok((view, ev));
        }
        let catalog = match self.setup_hours {
            None => None,
            Some(_) => Some(
                sim.experiments
                    .iter()
                    .map(|(n, e)| {
                        Ok((
                            n.clone(),
                            CatalogEntry {
                                max_runs: None,
                                cost_hours: cost(e)?,
                                ..Default::default()
                            },
                        ))
                    })
                    .collect::<Result<IndexMap<_, _>>>()?,
            ),
        };
        let noise = NoiseModel {
            sigma: self.sigma.clone(),
            bias: o.bias.clone().unwrap_or_else(|| case.bias.clone()),
            missing_fraction: o.missing.unwrap_or(case.missing),
        };
        let (mut view, ev) = build(
            &case.id,
            sim,
            self.truth_for(seed, o.drawn_truth),
            noise,
            seed,
            case.train.clone(),
            case.validation.clone(),
            self.test.clone(),
            o.max_experiments.unwrap_or(case.max_experiments),
            case.combos.clone(),
            case.expected_non_identified.clone(),
            &case.note,
        )?;
        view.max_test_hours = case.max_test_hours;
        view.catalog = catalog;
        Ok((view, ev))
    }

    /// EX-4's regime check: for each of `draws` seeds, the truth drawn from
    /// `[prior]` must give every generator case the answer it declares. At
    /// the drawn truth, the parameters the case's starting data leaves
    /// non-identified must match those at the fixed truth, and (for a case
    /// that may request experiments) the starting data plus every catalog
    /// experiment must leave exactly `expected_non_identified`; a case with
    /// no experiments must leave exactly that from its starting data.
    pub fn regime_problems(&self, draws: u64) -> Vec<String> {
        if self.prior.is_empty() {
            return vec![];
        }
        let sim = match self.simulator() {
            Ok(s) => s,
            Err(e) => return vec![e.to_string()],
        };
        let physical: BTreeSet<String> = sim.param_names().into_iter().collect();
        let non_identified = |truth: &Params, experiments: &[Value]| -> Result<BTreeSet<String>> {
            let mut rng = NumpyRng::new(0);
            let noise = NoiseModel::new(self.sigma.clone());
            let obs = experiments
                .iter()
                .map(|e| observe(&sim, truth, e, &noise, &mut rng, "train", None))
                .collect::<Result<Vec<_>>>()?;
            let (report, _) = analyze(&sim, truth, &obs, DEFAULT_RULE, None)?;
            Ok(report
                .non_identified
                .into_iter()
                .filter(|p| physical.contains(p))
                .collect())
        };
        let catalog: Vec<Value> = sim.experiments.keys().map(|k| json!(k)).collect();
        let mut problems = vec![];
        for case in self
            .cases
            .iter()
            .filter(|c| c.source == CaseSource::Generator)
        {
            let baseline = match non_identified(&self.truth, &case.train) {
                Ok(b) => b,
                Err(e) => {
                    problems.push(format!("{}#{}: {e}", self.name, case.name));
                    continue;
                }
            };
            for seed in 0..draws {
                let truth = self.truth_for(seed, true);
                let start = non_identified(&truth, &case.train);
                let end = if case.max_experiments == 0 {
                    start
                        .as_ref()
                        .map(Clone::clone)
                        .map_err(|e| invalid(e.to_string()))
                } else {
                    let all: Vec<Value> = case.train.iter().chain(&catalog).cloned().collect();
                    non_identified(&truth, &all)
                };
                let shown = |s: &BTreeSet<String>| s.iter().cloned().collect::<Vec<_>>().join(",");
                match (start, end) {
                    (Ok(start), Ok(end)) => {
                        if start != baseline {
                            problems.push(format!(
                                "{}#{}: drawn truth for seed {seed} ({truth:?}) leaves {{{}}} non-identified from the starting data, not {{{}}} as the fixed truth does",
                                self.name, case.name, shown(&start), shown(&baseline)
                            ));
                        } else if end != case.expected_non_identified {
                            problems.push(format!(
                                "{}#{}: drawn truth for seed {seed} ({truth:?}) ends with {{{}}} non-identified, not the expected {{{}}}",
                                self.name, case.name, shown(&end), shown(&case.expected_non_identified)
                            ));
                        }
                    }
                    (Err(e), _) | (_, Err(e)) => {
                        problems.push(format!("{}#{} seed {seed}: {e}", self.name, case.name))
                    }
                }
            }
        }
        problems
    }
}

/// Every built-in backtest, in suite order.
pub fn builtins() -> Vec<Backtest> {
    BUILTIN
        .iter()
        .map(|(n, _, _)| Backtest::builtin(n).expect("built-in backtests parse"))
        .collect()
}

/// The default suite's case ids, in order.
pub fn suite() -> Vec<String> {
    builtins()
        .iter()
        .flat_map(|b| b.cases.iter().filter(|c| c.suite).map(|c| c.id.clone()))
        .collect()
}

/// The built-in case with this stable id.
pub fn builtin_case(id: &str) -> Option<(Backtest, String)> {
    builtins().into_iter().find_map(|b| {
        let name = b.cases.iter().find(|c| c.id == id)?.name.clone();
        Some((b, name))
    })
}

/// A case by stable id or reference: a built-in id (`battery`), a
/// reference with a case (`battery#full`, `./x.backtest#c`), or a
/// reference to a one-case example.
pub fn resolve_case(text: &str) -> Result<(Backtest, String)> {
    if let Some(found) = builtin_case(text) {
        return Ok(found);
    }
    let reference = parse_ref(text).map_err(invalid)?;
    let backtest = Backtest::load(&reference)?;
    let name = match (&reference.case, backtest.cases.as_slice()) {
        (Some(case), _) => backtest.case(case)?.name.clone(),
        (None, [only]) => only.name.clone(),
        (None, _) => {
            return Err(invalid(format!(
                "{text:?} has several cases; pick one with #CASE ({})",
                backtest
                    .cases
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
    };
    Ok((backtest, name))
}

/// Expand references (`--example`) into case ids: a reference without a
/// case names every case of its example.
pub fn expand(references: &[String]) -> Result<Vec<String>> {
    let mut ids = vec![];
    for text in references {
        let reference = parse_ref(text).map_err(invalid)?;
        let backtest = Backtest::load(&reference)?;
        let selected: Vec<&CaseSpec> = match &reference.case {
            Some(case) => vec![backtest.case(case)?],
            None => backtest.cases.iter().collect(),
        };
        for c in selected {
            if !ids.contains(&c.id) {
                ids.push(c.id.clone());
            }
        }
    }
    Ok(ids)
}

/// The canonical reference of a case id, for result rows.
pub fn reference_of(id: &str) -> Option<String> {
    let (backtest, name) = resolve_case(id).ok()?;
    let case = backtest.case(&name).ok()?;
    Some(backtest.reference(case))
}

/// What a case's data is, for result rows: `recorded` for a recorded-run
/// case (the same measurements on every seed, so its seeds are repeats, not
/// independent trials), else `drawn` or `fixed` as `drawn_truth` says.
pub fn case_truth(id: &str, drawn_truth: bool) -> &'static str {
    let recorded = resolve_case(id).is_ok_and(|(b, name)| {
        b.case(&name)
            .is_ok_and(|c| c.source == CaseSource::Datasets)
    });
    match (recorded, drawn_truth) {
        (true, _) => "recorded",
        (false, true) => "drawn",
        (false, false) => "fixed",
    }
}

/// The view and evaluator of a case by id or reference.
pub fn build_case(text: &str, seed: u64, o: &Overrides) -> Result<(CaseView, Evaluator)> {
    let (b, name) = resolve_case(text)?;
    b.build(b.case(&name)?, seed, o)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_parse() {
        let r = |s: &str| parse_ref(s).unwrap();
        assert_eq!(
            r("battery"),
            Ref {
                source: Source::Builtin("battery".into()),
                case: None
            }
        );
        assert_eq!(
            r("builtin:battery#short-only").case.as_deref(),
            Some("short-only")
        );
        assert_eq!(
            r("battery.backtest").source,
            Source::Builtin("battery".into())
        );
        assert_eq!(
            r("./x.backtest#c").source,
            Source::Path("./x.backtest".into())
        );
        assert_eq!(
            r("path:x.backtest").source,
            Source::Path("x.backtest".into())
        );
        assert_eq!(
            r("builtin:battery#full").canonical(),
            "builtin:battery#full"
        );
        for bad in [
            "github:a/b",
            "Battery",
            "battery#",
            "battery#Full",
            "path:",
            "builtin:",
        ] {
            assert!(parse_ref(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn builtins_parse_and_keep_the_suite_order() {
        assert_eq!(suite(), crate::synthetic::CASES.map(String::from).to_vec());
        let planted: Vec<String> = builtins()
            .iter()
            .flat_map(|b| {
                b.cases
                    .iter()
                    .filter(|c| !c.suite && c.source == CaseSource::Generator)
                    .map(|c| c.id.clone())
            })
            .collect();
        assert_eq!(
            planted,
            crate::synthetic::PLANTED_CASES.map(String::from).to_vec()
        );
        assert_eq!(
            expand(&["battery#full".into(), "oscillator".into()]).unwrap(),
            ["battery", "oscillator-free-only", "oscillator"]
        );
        assert_eq!(
            reference_of("battery-short-only").unwrap(),
            "builtin:battery#short-only"
        );
        assert!(resolve_case("battery#nope").is_err());
        assert!(expand(&["nope".into()]).is_err());
    }

    /// The crate's copies equal the repository's `examples/*.backtest`.
    #[test]
    fn builtins_match_the_repository_examples() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
        if !root.is_dir() {
            return; // a source export without the repository's examples/
        }
        for (name, example, hidden) in BUILTIN {
            let dir = root.join(format!("{name}.backtest"));
            assert_eq!(
                std::fs::read_to_string(dir.join("example.toml")).unwrap(),
                example,
                "{name}"
            );
            assert_eq!(
                std::fs::read_to_string(dir.join("hidden/cases.toml")).unwrap(),
                hidden,
                "{name}"
            );
        }
    }

    /// The same draws as the Python SDK (`tests/test_backtest.py`).
    #[test]
    fn drawn_truth_is_per_seed_and_fixed_by_default() {
        let b = Backtest::builtin("battery").unwrap();
        assert!(b.has_prior());
        assert_eq!(b.truth_for(1, false), b.truth);
        let a = b.truth_for(1, true);
        assert_ne!(a, b.truth);
        assert_eq!(a, b.truth_for(1, true));
        assert_ne!(a, b.truth_for(2, true));
        let shown: Vec<String> = a.values().map(|v| format!("{v:.12e}")).collect();
        assert_eq!(shown, DRAW_BATTERY_SEED_1);
        let (_, ev) = build_case(
            "battery",
            1,
            &Overrides {
                drawn_truth: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(ev.truth, a);
    }
    const DRAW_BATTERY_SEED_1: [&str; 3] =
        ["2.207476884798e-2", "4.301236879664e-2", "1.609221981739e3"];

    #[test]
    fn built_in_priors_keep_each_case_in_its_regime() {
        for b in builtins() {
            assert_eq!(b.regime_problems(48), Vec::<String>::new(), "{}", b.name);
        }
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn a_path_backtest_loads_with_reference_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("cell.backtest");
        write(&dir, "example.toml", BUILTIN[1].1);
        write(&dir, "hidden/cases.toml", BUILTIN[1].2);
        let text = format!("{}#full", dir.display());
        let (b, name) = resolve_case(&text).unwrap();
        let id = &b.case(&name).unwrap().id;
        assert!(
            id.starts_with("path:/") && id.ends_with("cell.backtest#full"),
            "{id}"
        );
        let (view, ev) = b
            .build(b.case(&name).unwrap(), 0, &Overrides::default())
            .unwrap();
        assert_eq!(
            (view.name.as_str(), ev.case.as_str()),
            (id.as_str(), id.as_str())
        );
        assert!(
            Backtest::load_dir(tmp.path()).is_err(),
            "a folder must be NAME.backtest"
        );
    }

    /// Recorded runs from the thermal model, written as CSV.
    fn thermal_csv(name: &str, settings: &Value) -> String {
        let sim = models::thermal_rc();
        let truth: Params = [("C".to_string(), 500.), ("R".to_string(), 2.)]
            .into_iter()
            .collect();
        let mut rng = NumpyRng::new(7);
        let o = observe(
            &sim,
            &truth,
            settings,
            &NoiseModel::new([("T".to_string(), 0.05)].into_iter().collect()),
            &mut rng,
            "train",
            Some(name),
        )
        .unwrap();
        let mut out = String::from("time,temp\n");
        for (t, v) in o.t.iter().zip(&o.y["T"]) {
            out.push_str(&format!("{t},{v}\n"));
        }
        out
    }

    pub(crate) fn dataset_example(dir: &Path, by_url: bool) {
        let runs = [
            (
                "step_short",
                json!({"kind":"step","power":10.0,"duration":120.0,"rate":1.0}),
                false,
            ),
            (
                "step_long",
                json!({"kind":"step","power":10.0,"duration":3000.0,"rate":0.1}),
                false,
            ),
            (
                "pulse",
                json!({"kind":"pulse","power":15.0,"on":900.0,"duration":4000.0,"rate":0.1}),
                true,
            ),
        ];
        let mut public = String::from(
            "kind = \"backtest\"\ntitle = \"Recorded heater\"\nsummary = \"s\"\nlanguages = []\n[system]\nmodel = \"thermal_rc\"\n[[case]]\nname = \"rec\"\nsource = \"datasets\"\nbudget = { max_experiments = 1 }\ntrain = [\"step_short\"]\n",
        );
        let mut hidden = String::from(
            "[truth]\nC = 500.0\nR = 2.0\n[case.rec]\ntest = [\"pulse\"]\ncombos = { C = { C = 1.0 }, R = { R = 1.0 } }\nexpected_non_identified = []\n",
        );
        for (name, settings, held_out) in runs {
            let csv = thermal_csv(name, &settings);
            write(dir, &format!("data/{name}.csv"), &csv);
            let sum = sha256_hex(csv.as_bytes());
            let place = if by_url {
                format!(
                    "url = \"file://{}\"",
                    dir.join(format!("data/{name}.csv")).display()
                )
            } else {
                format!("file = \"data/{name}.csv\"")
            };
            let settings_toml = settings
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| format!("{k} = {v}"))
                .collect::<Vec<_>>()
                .join(", ");
            let entry = format!(
                "[[dataset]]\nname = \"{name}\"\nsettings = {{ {settings_toml} }}\n{place}\nsha256 = \"{sum}\"\ncolumns = {{ t = \"time\", T = \"temp\" }}\nsigma = {{ T = 0.05 }}\nprovenance = \"synthetic\"\n"
            );
            if held_out {
                hidden.push_str(&entry)
            } else {
                public.push_str(&entry)
            }
        }
        write(dir, "example.toml", &public);
        write(dir, "hidden/cases.toml", &hidden);
    }

    /// EX-6: a backtest folder's own Python simulator, served by the worker.
    /// Runs when `python3` (or `AUTOPHYS_PYTHON`) has NumPy and SciPy.
    #[test]
    fn a_backtest_can_bring_its_own_python_simulator() {
        let python = std::env::var("AUTOPHYS_PYTHON").unwrap_or_else(|_| "python3".into());
        let ok = std::process::Command::new(&python)
            .args(["-c", "import numpy, scipy"])
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            eprintln!("skipped: {python} lacks numpy/scipy");
            return;
        }
        let sdk = Path::new(env!("CARGO_MANIFEST_DIR")).join("../python/src");
        // SAFETY: the only test in this crate that reads PYTHONPATH.
        unsafe { std::env::set_var("PYTHONPATH", &sdk) };
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("lab.backtest");
        write(
            &dir,
            "example.toml",
            &BUILTIN[1]
                .1
                .replace("model = \"thermal_rc\"", "project = \"lab:simulator\""),
        );
        write(&dir, "hidden/cases.toml", BUILTIN[1].2);
        write(
            &dir,
            "lab.py",
            "from autophys.models import thermal_rc as simulator\n",
        );
        let (b, name) = resolve_case(&format!("{}#full", dir.display())).unwrap();
        assert_eq!(b.system, System::Project("lab:simulator".into()));
        let (view, ev) = b
            .build(b.case(&name).unwrap(), 0, &Overrides::default())
            .unwrap();
        let (builtin_view, _) = build_case("thermal", 0, &Overrides::default()).unwrap();
        assert_eq!(
            view.dataset.iter().count(),
            builtin_view.dataset.iter().count()
        );
        assert_eq!(ev.truth, b.truth);
        assert!(
            Backtest::parse(
                "x",
                Source::Builtin("x".into()),
                &BUILTIN[1]
                    .1
                    .replace("model = \"thermal_rc\"", "project = \"lab:simulator\""),
                BUILTIN[1].2
            )
            .is_err(),
            "built-ins use built-in models"
        );
    }

    #[test]
    fn a_dataset_case_replays_recorded_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("heater.backtest");
        dataset_example(&dir, false);
        let (b, name) = resolve_case(&format!("{}#rec", dir.display())).unwrap();
        let (mut view, ev) = b
            .build(b.case(&name).unwrap(), 0, &Overrides::default())
            .unwrap();
        assert_eq!(
            view.catalog.as_ref().unwrap().keys().collect::<Vec<_>>(),
            ["step_long"]
        );
        assert_eq!(view.dataset.iter().count(), 1);
        assert_eq!(ev.test.len(), 1);
        assert!(
            !view.simulator.experiments.contains_key("pulse"),
            "held-out runs stay hidden"
        );
        let o = crate::agent::Runner::run(&mut view.runner, "step_long", &json!({})).unwrap();
        assert_eq!(
            (o.experiment.as_str(), o.source.as_str()),
            ("step_long", "synthetic")
        );
        assert!(
            crate::agent::Runner::run(&mut view.runner, "step_long", &json!({})).is_err(),
            "each run once"
        );
        // A tampered file fails its checksum.
        std::fs::write(dir.join("data/step_long.csv"), "time,temp\n0,1\n").unwrap();
        assert!(
            b.build(b.case(&name).unwrap(), 0, &Overrides::default())
                .is_err()
        );
    }

    static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A recorded case has no generator to corrupt, so bias and missing are
    /// refused (in hidden/cases.toml and as overrides) rather than ignored.
    #[test]
    fn recorded_cases_refuse_bias_and_missing() {
        let (b, name) = resolve_case("battery-recorded#two-tests").unwrap();
        let case = b.case(&name).unwrap();
        for o in [
            Overrides {
                bias: Some(Params::new()),
                ..Default::default()
            },
            Overrides {
                missing: Some(0.1),
                ..Default::default()
            },
        ] {
            let e = b.build(case, 0, &o).err().unwrap().to_string();
            assert!(e.contains("bias and missing"), "{e}");
        }
        let hidden = include_str!("backtests/battery-recorded.backtest/hidden/cases.toml");
        let changed = hidden.replacen("[case.two-tests]\n", "[case.two-tests]\nmissing = 0.1\n", 1);
        assert_ne!(changed, hidden);
        let e = Backtest::parse(
            "battery-recorded",
            Source::Builtin("battery-recorded".into()),
            include_str!("backtests/battery-recorded.backtest/example.toml"),
            &changed,
        )
        .err()
        .unwrap()
        .to_string();
        assert!(e.contains("bias and missing"), "{e}");
    }

    #[test]
    fn case_truth_tells_recorded_from_generated() {
        assert_eq!(case_truth("battery-recorded#two-tests", true), "recorded");
        assert_eq!(case_truth("battery", false), "fixed");
        assert_eq!(case_truth("battery", true), "drawn");
    }

    /// The built-in recorded backtest runs offline once its files are in
    /// the datasets directory (here copied from the repository's data/).
    #[test]
    fn the_recorded_battery_backtest_builds_from_a_filled_cache() {
        let data = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/battery-recorded.backtest/data");
        if !data.is_dir() {
            return; // a source export without the repository's examples/
        }
        let tmp = tempfile::tempdir().unwrap();
        for entry in std::fs::read_dir(&data).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            std::fs::write(tmp.path().join(sha256_hex(&bytes)), bytes).unwrap();
        }
        let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: every test that sets AUTOPHYS_DATASETS_DIR holds ENV.
        unsafe { std::env::set_var("AUTOPHYS_DATASETS_DIR", tmp.path()) };
        let built = build_case("battery-recorded#two-tests", 0, &Overrides::default());
        unsafe { std::env::remove_var("AUTOPHYS_DATASETS_DIR") };
        let (view, ev) = built.unwrap();
        assert_eq!(view.name, "battery-recorded");
        assert_eq!(
            view.catalog.as_ref().unwrap().keys().collect::<Vec<_>>(),
            ["discharge_1A", "pulse_2A", "pulse_train"]
        );
        assert_eq!((view.dataset.iter().count(), ev.test.len()), (2, 1));
        assert!(
            !suite().contains(&"battery-recorded".to_string()),
            "the default suite stays offline"
        );
    }

    #[test]
    fn urls_are_fetched_once_into_the_data_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("heater.backtest");
        dataset_example(&dir, true);
        let cache = tmp.path().join("cache");
        let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: every test that sets AUTOPHYS_DATASETS_DIR holds ENV.
        unsafe { std::env::set_var("AUTOPHYS_DATASETS_DIR", &cache) };
        let (b, name) = resolve_case(&format!("{}#rec", dir.display())).unwrap();
        b.build(b.case(&name).unwrap(), 0, &Overrides::default())
            .unwrap();
        assert_eq!(std::fs::read_dir(&cache).unwrap().count(), 3);
        std::fs::remove_dir_all(dir.join("data")).unwrap();
        b.build(b.case(&name).unwrap(), 0, &Overrides::default())
            .unwrap();
        unsafe { std::env::remove_var("AUTOPHYS_DATASETS_DIR") };
    }
}
