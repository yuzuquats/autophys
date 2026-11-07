//! Backtest examples: a hidden system a model must discover through the
//! investigation loop, declared as data (`examples/<name>.backtest/`).
//!
//! `example.toml` is what the model is told: the simulator, each case's
//! starting data and budget. `hidden/cases.toml` holds the truth, the noise,
//! the held-out test experiments and how each case is scored; it reaches the
//! [`Evaluator`] and the runner's closure, never a policy. The built-in
//! backtests are copies of the repository's `examples/*.backtest` (a test
//! keeps them byte-identical), so this crate builds on its own.
//!
//! A reference is `[SCHEME:]SOURCE[#CASE]` (decision EX-10): `builtin:NAME`
//! (a bare name is the same), or `path:DIR` (a source starting with `./`,
//! `../`, `/` or `~` is the same). Built-in cases keep their stable ids
//! (`battery`, `battery-short-only`, …), which records, replay files and
//! results use; `builtin:battery#full` and `battery` name the same case.
use crate::{
    models,
    project::CatalogEntry,
    simulator::{FunctionSimulator, Params, Result, invalid, number},
    synthetic::{CaseView, Evaluator, NoiseModel, build},
};
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The built-in backtests in suite order: `(name, example.toml, hidden/cases.toml)`.
pub const BUILTIN: [(&str, &str, &str); 3] = [
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
    pub max_experiments: usize,
    pub max_test_hours: Option<f64>,
    pub train: Vec<Value>,
    pub validation: Vec<Value>,
    bias: Params,
    missing: f64,
    combos: IndexMap<String, Params>,
    expected_non_identified: BTreeSet<String>,
    note: String,
}

/// A loaded backtest example.
#[derive(Clone, Debug)]
pub struct Backtest {
    pub name: String,
    pub source: Source,
    pub title: String,
    pub summary: String,
    /// The built-in simulator the cases run (decision EX-6).
    pub model: String,
    setup_hours: Option<f64>,
    pub cases: Vec<CaseSpec>,
    truth: Params,
    sigma: Params,
    test: Vec<Value>,
}

/// Changes the SDK's case helpers make on top of a declared case.
#[derive(Clone, Debug, Default)]
pub struct Overrides {
    pub max_experiments: Option<usize>,
    pub bias: Option<Params>,
    pub missing: Option<f64>,
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

/// The simulator a backtest names.
pub fn simulator(model: &str) -> Result<FunctionSimulator> {
    match model {
        "battery_ecm" => Ok(models::battery_ecm()),
        "oscillator" => Ok(models::oscillator()),
        "thermal_rc" => Ok(models::thermal_rc()),
        other => Err(invalid(format!(
            "unknown model {other:?}; a backtest uses battery_ecm, oscillator or thermal_rc"
        ))),
    }
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
        let system = field(&ex, "system", &what)?;
        let model = text(system, "model", &format!("{what} [system]"))?;
        simulator(&model)?;
        let setup_hours =
            match system.get("experiment_cost") {
                None => None,
                Some(cost) => Some(cost.get("setup_hours").and_then(Value::as_f64).ok_or_else(
                    || invalid(format!("{what}: experiment_cost needs setup_hours")),
                )?),
            };
        let truth = params(field(&hid, "truth", &what)?, &format!("{what} [truth]"))?;
        let noise = field(&hid, "noise", &what)?;
        let sigma = params(
            field(noise, "sigma", &what)?,
            &format!("{what} noise.sigma"),
        )?;
        let test = experiments(hid.get("test"), &format!("{what} [[test]]"))?;
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
            let combos = field(h, "combos", &cw)?
                .as_object()
                .ok_or_else(|| invalid(format!("{cw}: combos must be a table")))?
                .iter()
                .map(|(k, v)| Ok((k.clone(), params(v, &format!("{cw} combos.{k}"))?)))
                .collect::<Result<IndexMap<_, _>>>()?;
            for (combo, powers) in &combos {
                if let Some(p) = powers.keys().find(|p| !truth.contains_key(*p)) {
                    return Err(invalid(format!(
                        "{cw}: combo {combo} names {p}, which [truth] lacks"
                    )));
                }
            }
            let expected_non_identified = match h.get("expected_non_identified") {
                None => BTreeSet::new(),
                Some(Value::Array(a)) => a
                    .iter()
                    .map(|x| x.as_str().map(String::from))
                    .collect::<Option<_>>()
                    .ok_or_else(|| invalid(format!("{cw}: expected_non_identified lists names")))?,
                Some(_) => {
                    return Err(invalid(format!(
                        "{cw}: expected_non_identified lists names"
                    )));
                }
            };
            cases.push(CaseSpec {
                name: case_name.clone(),
                id,
                suite: c.get("suite").and_then(Value::as_bool).unwrap_or(true),
                max_experiments,
                max_test_hours,
                train: experiments(c.get("train"), &format!("{cw} train"))?,
                validation: experiments(c.get("validation"), &format!("{cw} validation"))?,
                bias: match h.get("bias") {
                    None => Params::new(),
                    Some(b) => params(b, &format!("{cw} bias"))?,
                },
                missing: h.get("missing").and_then(Value::as_f64).unwrap_or(0.),
                combos,
                expected_non_identified,
                note: h
                    .get("note")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
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
            model,
            setup_hours,
            cases,
            truth,
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

    /// The case's view (for the policy) and evaluator (for scoring).
    pub fn build(
        &self,
        case: &CaseSpec,
        seed: u64,
        o: &Overrides,
    ) -> Result<(CaseView, Evaluator)> {
        let sim = simulator(&self.model)?;
        let catalog = match self.setup_hours {
            None => None,
            Some(setup) => Some(
                sim.experiments
                    .iter()
                    .map(|(n, e)| {
                        Ok((
                            n.clone(),
                            CatalogEntry {
                                max_runs: None,
                                cost_hours: Some(setup + number(e, "duration")? / 3600.0),
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
            self.truth.clone(),
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
            .flat_map(|b| b.cases.iter().filter(|c| !c.suite).map(|c| c.id.clone()))
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

    #[test]
    fn a_path_backtest_loads_with_reference_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("cell.backtest");
        std::fs::create_dir_all(dir.join("hidden")).unwrap();
        std::fs::write(dir.join("example.toml"), BUILTIN[1].1).unwrap();
        std::fs::write(dir.join("hidden/cases.toml"), BUILTIN[1].2).unwrap();
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
}
