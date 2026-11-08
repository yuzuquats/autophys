//! The examples catalogue: `examples/<name>.<kind>/` folders built into the
//! binary (`build.rs`), or a folder on disk. See
//! `autophys.project.docs/content/examples.md`.
//!
//! Every example has an `example.toml`; its folder suffix names its kind
//! (`template`, `demo` or `backtest`, decision EX-1). `autophys new
//! --example REF` sets up a template or demo as a project, and `bench`,
//! `research`, `autoloop` and `train` take `--example REF` to pick backtest
//! cases. A reference is `[SCHEME:]SOURCE[#CASE]` (EX-10), parsed by
//! [`autophys::backtest::parse_ref`].
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use autophys::backtest::{self, Backtest, Source, parse_ref, split_kind};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::device::Failure;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/examples.rs"));
}

pub const USAGE: &str = "usage: autophys examples [--json]
       autophys examples --check [REF]... [--json]";

/// Seeds the regime check draws for a backtest with `[prior]` (EX-4).
pub const REGIME_DRAWS: u64 = 32;

/// The languages an example may provide.
pub const LANGUAGES: [&str; 2] = ["python", "rust"];

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Data {
    pub path: String,
    #[serde(default)]
    pub provenance: String,
    #[serde(default)]
    pub generator: Option<String>,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Expected {
    pub lang: String,
    pub run: String,
    pub stdout: String,
    #[serde(default)]
    pub compare: Option<String>,
}

/// The fields every kind shares; a backtest's cases are read by
/// [`autophys::backtest`].
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Manifest {
    pub kind: String,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub min_autophys: Option<String>,
    #[serde(default)]
    pub next: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub data: Vec<Data>,
    #[serde(default)]
    pub expected: Vec<Expected>,
}

/// One example: its name, kind, manifest and files (paths relative to the
/// example folder).
#[derive(Clone, Debug)]
pub struct Example {
    pub name: String,
    pub kind: String,
    pub source: Source,
    pub manifest: Manifest,
    pub files: Vec<(String, Cow<'static, [u8]>)>,
}

impl Example {
    fn file(&self, relative: &str) -> Option<&[u8]> {
        self.files
            .iter()
            .find(|(p, _)| p == relative)
            .map(|(_, b)| b.as_ref())
    }

    fn text(&self, relative: &str) -> Result<&str, String> {
        let bytes = self
            .file(relative)
            .ok_or_else(|| format!("{}: missing {relative}", self.label()))?;
        std::str::from_utf8(bytes).map_err(|_| format!("{}: {relative} is not UTF-8", self.label()))
    }

    /// `builtin:NAME` or `path:DIR`.
    pub fn label(&self) -> String {
        backtest::Ref {
            source: self.source.clone(),
            case: None,
        }
        .canonical()
    }

    /// The backtest this example declares (`kind = "backtest"` only).
    pub fn backtest(&self) -> Result<Backtest, String> {
        Backtest::parse(
            &self.name,
            self.source.clone(),
            self.text("example.toml")?,
            self.text("hidden/cases.toml")?,
        )
        .map_err(|e| e.to_string())
    }

    /// The project files for `lang`: `common/` then `<lang>/`, the
    /// language's files winning, `.tmpl` names kept.
    pub fn project_files(&self, lang: &str) -> Vec<(String, Cow<'static, [u8]>)> {
        let mut files: Vec<(String, Cow<'static, [u8]>)> = Vec::new();
        for prefix in ["common/".to_string(), format!("{lang}/")] {
            for (path, bytes) in &self.files {
                if let Some(relative) = path.strip_prefix(prefix.as_str()) {
                    files.retain(|(existing, _)| existing != relative);
                    files.push((relative.to_string(), bytes.clone()));
                }
            }
        }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        files
    }
}

fn parse_manifest(text: &str, label: &str) -> Result<Manifest, String> {
    toml::from_str(text).map_err(|e| format!("{label}/example.toml: {e}"))
}

/// Every built-in example, ordered by kind (templates, demos, backtests)
/// and then by name, backtests in suite order.
pub fn builtins() -> Vec<Example> {
    let mut by_dir: BTreeMap<&str, Vec<(String, Cow<'static, [u8]>)>> = BTreeMap::new();
    for (path, bytes) in embedded::FILES {
        if let Some((dir, rest)) = path.split_once('/') {
            by_dir
                .entry(dir)
                .or_default()
                .push((rest.to_string(), Cow::Borrowed(*bytes)));
        }
    }
    let mut out = vec![];
    for (dir, files) in by_dir {
        let Some((name, kind)) = split_kind(dir) else {
            continue;
        };
        let source = Source::Builtin(name.to_string());
        let text = files
            .iter()
            .find(|(p, _)| p == "example.toml")
            .and_then(|(_, b)| std::str::from_utf8(b).ok())
            .unwrap_or_default();
        let manifest = parse_manifest(text, dir).unwrap_or_default();
        out.push(Example {
            name: name.into(),
            kind: kind.into(),
            source,
            manifest,
            files,
        });
    }
    let order = |e: &Example| {
        let kind = backtest::KINDS
            .iter()
            .position(|k| *k == e.kind)
            .unwrap_or(9);
        let suite = backtest::BUILTIN
            .iter()
            .position(|(n, _, _)| *n == e.name)
            .unwrap_or(0);
        (kind, suite, e.name.clone())
    };
    out.sort_by_key(order);
    out
}

/// Folders and files never read from an example on disk.
fn skipped(name: &str) -> bool {
    matches!(
        name,
        ".git" | "target" | "node_modules" | "__pycache__" | ".venv" | ".DS_Store"
    )
}

fn walk(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(String, Cow<'static, [u8]>)>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if skipped(&name) {
            continue;
        }
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if kind.is_dir() {
            walk(root, &path, out)?;
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            out.push((relative, Cow::Owned(bytes)));
        }
    }
    Ok(())
}

/// An example folder on disk, named `NAME.KIND`.
pub fn load_dir(dir: &Path) -> Result<Example, String> {
    let dir = std::fs::canonicalize(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let dir_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (name, kind) = split_kind(&dir_name).ok_or_else(|| {
        format!(
            "{}: an example folder is named NAME.template, NAME.demo or NAME.backtest",
            dir.display()
        )
    })?;
    let mut files = vec![];
    walk(&dir, &dir, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let label = format!("path:{}", dir.display());
    let text = files
        .iter()
        .find(|(p, _)| p == "example.toml")
        .ok_or_else(|| format!("{label}: missing example.toml"))
        .and_then(|(_, b)| {
            std::str::from_utf8(b).map_err(|_| format!("{label}: example.toml is not UTF-8"))
        })?;
    let manifest = parse_manifest(text, &label)?;
    Ok(Example {
        name: name.into(),
        kind: kind.into(),
        source: Source::Path(dir.clone()),
        manifest,
        files,
    })
}

/// The example a reference names, and the case after `#`, if any.
pub fn resolve(text: &str) -> Result<(Example, Option<String>), String> {
    let reference = parse_ref(text)?;
    let example = match &reference.source {
        Source::Builtin(name) => {
            let all = builtins();
            let found = all.iter().find(|e| &e.name == name).cloned();
            match found {
                Some(e) => e,
                None => {
                    let mut message = format!(
                        "no built-in example {name:?}; built-in: {}",
                        all.iter()
                            .map(|e| e.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                    if Path::new(name).exists() || Path::new(text).exists() {
                        message.push_str(&format!(
                            "\n(a bare name is always built-in; for the folder use ./{text} or path:{text})"
                        ));
                    }
                    return Err(message);
                }
            }
        }
        Source::Path(dir) => load_dir(dir)?,
    };
    Ok((example, reference.case))
}

fn version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.trim().split('.').map(|p| p.parse::<u64>().ok());
    Some((
        parts.next()??,
        parts.next().flatten().unwrap_or(0),
        parts.next().flatten().unwrap_or(0),
    ))
}

/// What is wrong with an example (empty when it is sound).
pub fn check(e: &Example) -> Vec<String> {
    let label = e.label();
    let mut problems = vec![];
    let mut problem = |p: String| problems.push(format!("{label}: {p}"));
    let m = &e.manifest;
    if e.file("example.toml").is_none() {
        problem("missing example.toml".into());
        return problems;
    }
    if let Err(err) = e
        .text("example.toml")
        .and_then(|t| parse_manifest(t, &label))
    {
        problem(err);
        return problems;
    }
    if m.kind != e.kind {
        problem(format!(
            "the folder says {:?} but example.toml says kind = {:?}",
            e.kind, m.kind
        ));
    }
    if m.title.trim().is_empty() || m.summary.trim().is_empty() {
        problem("title and summary are required".into());
    }
    if let Some(min) = &m.min_autophys {
        match (version(min), version(env!("CARGO_PKG_VERSION"))) {
            (Some(need), Some(have)) if need > have => problem(format!(
                "needs autophys {min} or newer; this is {}",
                env!("CARGO_PKG_VERSION")
            )),
            (None, _) => problem(format!("min_autophys {min:?} is not a version")),
            _ => {}
        }
    }
    for lang in &m.languages {
        if !LANGUAGES.contains(&lang.as_str()) {
            problem(format!("unknown language {lang:?}; use python or rust"));
        } else if !e
            .files
            .iter()
            .any(|(p, _)| p.starts_with(&format!("{lang}/")))
        {
            problem(format!(
                "languages lists {lang} but there is no {lang}/ folder"
            ));
        }
    }
    if matches!(e.kind.as_str(), "template" | "demo") && m.languages.is_empty() {
        problem(format!("a {} needs at least one language", e.kind));
    }
    for lang in m.next.keys() {
        if !m.languages.contains(lang) {
            problem(format!("[next] has {lang}, which languages does not list"));
        }
    }
    for d in &m.data {
        match e.file(&d.path) {
            None => problem(format!("data {} is missing", d.path)),
            Some(bytes) => {
                let sum = hex::encode(Sha256::digest(bytes));
                if sum != d.sha256 {
                    problem(format!(
                        "data {} has sha256 {sum}, not {}",
                        d.path, d.sha256
                    ));
                }
            }
        }
        match d.provenance.as_str() {
            "synthetic" => {}
            "measured" => {
                if d.license.as_deref().unwrap_or("").is_empty()
                    || d.source.as_deref().unwrap_or("").is_empty()
                {
                    problem(format!(
                        "measured data {} needs a license and a source",
                        d.path
                    ));
                }
            }
            other => problem(format!(
                "data {} provenance {other:?}: use synthetic or measured",
                d.path
            )),
        }
    }
    if e.kind == "demo" && m.data.is_empty() {
        problem("a demo lists its data in [[data]]".into());
    }
    for x in &m.expected {
        if !m.languages.contains(&x.lang) {
            problem(format!(
                "[[expected]] for {}, which languages does not list",
                x.lang
            ));
        }
        if e.file(&x.stdout).is_none() {
            problem(format!("[[expected]] output {} is missing", x.stdout));
        }
    }
    if e.kind == "demo" && m.expected.is_empty() {
        problem("a demo lists its expected output in [[expected]]".into());
    }
    if e.kind == "backtest" {
        match e.backtest() {
            Err(err) => problem(err),
            Ok(b) => {
                // Local dataset files must match their sha256; a url is
                // checked when a run fetches it.
                for d in b.datasets.iter().filter(|d| d.file.is_some()) {
                    if let Err(err) = b.dataset_bytes(d) {
                        problem(err.to_string());
                    }
                }
                // EX-4: every drawn truth keeps the answer each case declares.
                for p in b.regime_problems(REGIME_DRAWS) {
                    problem(p);
                }
            }
        }
    } else if e.file("hidden/cases.toml").is_some() {
        problem("only a backtest has hidden/".into());
    }
    for lang in &m.languages {
        for (path, bytes) in e.project_files(lang) {
            if !path.ends_with(".tmpl") {
                continue;
            }
            let Ok(text) = std::str::from_utf8(&bytes) else {
                problem(format!("{lang}/{path} is not UTF-8"));
                continue;
            };
            let rendered = crate::scaffold::render(
                text,
                &[
                    ("name", "n"),
                    ("crate_name", "n"),
                    ("sdk_repo", "r"),
                    ("sdk_rev", "v"),
                ],
            );
            if rendered.contains("{{") {
                problem(format!(
                    "{path} ({lang}) leaves a {{{{ placeholder unrendered"
                ));
            }
        }
    }
    problems
}

/// `--example REF` (repeatable) and the deprecated `--case NAME` in a
/// command's words, as `--case ID` words the existing parsers take. A
/// reference without `#CASE` names every case of its example; ids stay the
/// built-ins' stable ids (`battery`), so records and replay files match.
pub fn examples_to_cases(args: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(args.len());
    let mut words = args.into_iter();
    let mut deprecated = false;
    while let Some(word) = words.next() {
        let (flag, inline) = match word.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (word.clone(), None),
        };
        if flag != "--example" && flag != "--case" {
            out.push(word);
            continue;
        }
        let Some(value) = inline.or_else(|| words.next()) else {
            return Err(format!("{flag} expects a value"));
        };
        let ids = if flag == "--case" {
            deprecated = true;
            match backtest::resolve_case(&value) {
                Ok((b, name)) => vec![b.case(&name).map_err(|e| e.to_string())?.id.clone()],
                Err(_) => vec![value],
            }
        } else {
            backtest::expand(std::slice::from_ref(&value))
                .map_err(|e| format!("--example {value}: {e}"))?
        };
        for id in ids {
            out.push("--case".into());
            out.push(id);
        }
    }
    if deprecated {
        eprintln!(
            "autophys: --case is deprecated; use --example (for example --example battery#short-only)"
        );
    }
    Ok(out)
}

/// `autophys examples`: list the built-in examples, or `--check` them (or
/// the referenced ones).
pub fn command(args: Vec<String>, out: &mut impl Write) -> Result<Value, Failure> {
    let usage = |m: String| Failure {
        code: 2,
        message: format!("{m}\n{USAGE}"),
    };
    let (mut json_out, mut check_mode, mut refs) = (false, false, vec![]);
    for word in args {
        match word.as_str() {
            "--json" => json_out = true,
            "--check" => check_mode = true,
            w if w.starts_with("--") => return Err(usage(format!("unknown option {w:?}"))),
            _ => refs.push(word),
        }
    }
    if !refs.is_empty() && !check_mode {
        return Err(usage("a REF is only taken with --check".into()));
    }
    if check_mode {
        let examples = if refs.is_empty() {
            builtins()
        } else {
            refs.iter()
                .map(|r| resolve(r).map(|(e, _)| e))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| Failure {
                    code: 1,
                    message: e,
                })?
        };
        let problems: Vec<String> = examples.iter().flat_map(check).collect();
        if json_out {
            return if problems.is_empty() {
                Ok(
                    json!({"checked": examples.iter().map(Example::label).collect::<Vec<_>>(), "problems": []}),
                )
            } else {
                Err(Failure {
                    code: 1,
                    message: problems.join("\n"),
                })
            };
        }
        if !problems.is_empty() {
            return Err(Failure {
                code: 1,
                message: problems.join("\n"),
            });
        }
        let _ = writeln!(out, "{} example(s) checked: no problems.", examples.len());
        return Ok(Value::Null);
    }
    let all = builtins();
    if json_out {
        return Ok(Value::Array(
            all.iter()
                .map(|e| {
                    let cases = e.backtest().ok().map(|b| {
                        b.cases
                            .iter()
                            .map(|c| json!({"name": c.name, "id": c.id, "reference": b.reference(c), "suite": c.suite}))
                            .collect::<Vec<_>>()
                    });
                    json!({"name": e.name, "kind": e.kind, "reference": e.label(), "title": e.manifest.title,
                           "summary": e.manifest.summary, "languages": e.manifest.languages, "cases": cases})
                })
                .collect(),
        ));
    }
    for (kind, heading) in [
        (
            "template",
            "Templates: autophys new DIR --lang python|rust --example NAME",
        ),
        (
            "demo",
            "Demos: autophys new DIR --lang python|rust --example NAME",
        ),
        (
            "backtest",
            "Backtests: autophys bench --example NAME[#CASE]",
        ),
    ] {
        let _ = writeln!(out, "{heading}");
        for e in all.iter().filter(|e| e.kind == kind) {
            let langs = if e.manifest.languages.is_empty() {
                String::new()
            } else {
                format!(" ({})", e.manifest.languages.join(", "))
            };
            let _ = writeln!(out, "  {:<12} {}{langs}", e.name, e.manifest.title);
            if let Ok(b) = e.backtest() {
                let cases: Vec<String> = b
                    .cases
                    .iter()
                    .map(|c| {
                        if c.suite {
                            c.name.clone()
                        } else {
                            format!("{} (planted)", c.name)
                        }
                    })
                    .collect();
                let _ = writeln!(out, "  {:<12} cases: {}", "", cases.join(", "));
            }
        }
        let _ = writeln!(out);
    }
    let _ = writeln!(
        out,
        "A reference is [builtin:|path:]SOURCE[#CASE]; ./DIR and ~/DIR are paths."
    );
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_built_in_example_checks_clean() {
        let all = builtins();
        let names: Vec<(&str, &str)> = all
            .iter()
            .map(|e| (e.kind.as_str(), e.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("template", "blank"),
                ("demo", "battery-fit"),
                ("backtest", "oscillator"),
                ("backtest", "thermal"),
                ("backtest", "battery"),
            ]
        );
        for e in &all {
            assert_eq!(check(e), Vec::<String>::new(), "{}", e.name);
        }
    }

    #[test]
    fn references_resolve() {
        assert_eq!(resolve("battery-fit").unwrap().0.kind, "demo");
        assert_eq!(resolve("builtin:blank.template").unwrap().0.name, "blank");
        let (e, case) = resolve("battery#short-only").unwrap();
        assert_eq!(
            (e.kind.as_str(), case.as_deref()),
            ("backtest", Some("short-only"))
        );
        assert!(resolve("nope").is_err());
        assert!(resolve("github:a/b").is_err());
    }

    #[test]
    fn examples_become_case_ids() {
        let words = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        assert_eq!(
            examples_to_cases(words(
                "--seeds 3 --example battery#full --example=thermal --case oscillator --json"
            ))
            .unwrap(),
            words(
                "--seeds 3 --case battery --case thermal-short-only --case thermal --case oscillator --json"
            )
        );
        assert_eq!(
            examples_to_cases(words("--case battery#short-only")).unwrap(),
            words("--case battery-short-only")
        );
        assert!(examples_to_cases(words("--example nope")).is_err());
        assert!(examples_to_cases(words("--example")).is_err());
    }

    #[test]
    fn a_folder_on_disk_is_checked() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("mine.demo");
        std::fs::create_dir_all(dir.join("python")).unwrap();
        std::fs::write(
            dir.join("example.toml"),
            "kind = \"template\"\ntitle = \"t\"\nsummary = \"s\"\nlanguages = [\"python\", \"rust\"]\n",
        )
        .unwrap();
        std::fs::write(dir.join("python/main.py"), "").unwrap();
        let (e, _) = resolve(&format!("{}", dir.display())).unwrap();
        let problems = check(&e).join("\n");
        assert!(problems.contains("folder says \"demo\""), "{problems}");
        assert!(problems.contains("no rust/ folder"), "{problems}");
        assert!(problems.contains("a demo lists its data"), "{problems}");
    }
}
