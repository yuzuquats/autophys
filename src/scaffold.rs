//! `autophys new DIR --lang python|rust`: a new project from a template or
//! demo example (`examples/<name>.template|demo/`, built into the binary, or
//! a folder given by reference; see [`crate::examples`]).
//!
//! A project is the example's `common/` plus its `<lang>/` (the language's
//! files win). Files ending in `.tmpl` are rendered (the
//! suffix dropped, `{{name}}`, `{{crate_name}}`, `{{sdk_repo}}` and
//! `{{sdk_rev}}` replaced); every other file is copied byte for byte. The
//! project depends on the SDK through a git dependency on the autophys
//! repository, pinned to the commit this binary was built from unless
//! `--sdk-rev` says otherwise (operator ruling CLI-3; agent choice CLI-6).
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

use crate::device::Failure;
use crate::examples::Example;
use std::borrow::Cow;

/// The repository the SDK git dependency points at.
pub const SDK_REPO: &str = "https://github.com/yuzuquats/autophys";

pub const USAGE: &str = "usage: autophys new DIR --lang python|rust [--example REF] [--name NAME]
                    [--existing] [--no-install] [--sdk-rev REV] [--sdk-repo GIT_URL] [--json]
       REF: a template or demo, built in (blank, battery-fit; `autophys examples`)
            or a folder (./NAME.template); default battery-fit
       --existing: write into a project of that name already in the collection";

/// The commit this binary was built from (`AUTOPHYS_COMMIT`, else the
/// checkout's HEAD at build time); `None` for a build from a source export.
pub fn source_commit() -> Option<&'static str> {
    Some(env!("AUTOPHYS_SOURCE_COMMIT")).filter(|c| !c.is_empty())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Python,
    Rust,
}

impl Lang {
    fn as_str(self) -> &'static str {
        match self {
            Lang::Python => "python",
            Lang::Rust => "rust",
        }
    }
}

#[derive(Debug)]
pub struct Options {
    pub dir: PathBuf,
    pub lang: Lang,
    pub example: Example,
    pub name: Option<String>,
    /// Join a project of the same name already in the collection (G3-NAME).
    pub existing: bool,
    pub install: bool,
    pub sdk_rev: Option<String>,
    pub sdk_repo: String,
    pub json: bool,
}

fn usage(message: impl std::fmt::Display) -> Failure {
    Failure {
        code: 2,
        message: format!("{message}\n{USAGE}"),
    }
}

fn failure(message: impl Into<String>) -> Failure {
    Failure {
        code: 1,
        message: message.into(),
    }
}

pub fn parse(args: Vec<String>) -> Result<Options, Failure> {
    let mut dir = None;
    let mut lang = None;
    let mut example = None;
    let mut name = None;
    let mut install = true;
    let mut existing = false;
    let mut sdk_rev = None;
    let mut sdk_repo = None;
    let mut json = false;
    let mut words = args.into_iter();
    while let Some(word) = words.next() {
        let (flag, inline) = match word.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => {
                (flag.to_string(), Some(value.to_string()))
            }
            _ => (word.clone(), None),
        };
        let mut value = |flag: &str| {
            inline
                .clone()
                .or_else(|| words.next())
                .ok_or_else(|| usage(format!("{flag} needs a value")))
        };
        match flag.as_str() {
            "--lang" => lang = Some(value("--lang")?),
            "--example" => example = Some(value("--example")?),
            "--name" => name = Some(value("--name")?),
            "--sdk-rev" => sdk_rev = Some(value("--sdk-rev")?),
            "--sdk-repo" => sdk_repo = Some(value("--sdk-repo")?),
            "--no-install" => install = false,
            "--existing" => existing = true,
            "--json" => json = true,
            other if other.starts_with('-') => {
                return Err(usage(format!("unknown option {other:?}")));
            }
            _ if dir.is_none() => dir = Some(PathBuf::from(word)),
            _ => return Err(usage(format!("unexpected argument {word:?}"))),
        }
    }
    let dir = dir.ok_or_else(|| usage("DIR is required"))?;
    let lang = match lang.as_deref() {
        Some("python") => Lang::Python,
        Some("rust") => Lang::Rust,
        Some(other) => return Err(usage(format!("--lang {other:?}: use python or rust"))),
        None => return Err(usage("--lang python|rust is required")),
    };
    let reference = example.unwrap_or_else(|| "battery-fit".into());
    let (example, case) =
        crate::examples::resolve(&reference).map_err(|e| usage(format!("--example {e}")))?;
    if case.is_some() {
        return Err(usage(format!(
            "--example {reference:?}: new sets up a whole example; drop the #CASE"
        )));
    }
    if example.kind == "backtest" && example.manifest.languages.is_empty() {
        return Err(usage(format!(
            "--example {reference:?} is a backtest with no project to set up; run it with `autophys bench --example {reference}`"
        )));
    }
    if !example
        .manifest
        .languages
        .iter()
        .any(|l| l == lang.as_str())
    {
        return Err(usage(format!(
            "--example {reference:?} has no {} project (it has: {})",
            lang.as_str(),
            example.manifest.languages.join(", ")
        )));
    }
    if let Some(problem) = crate::examples::check(&example).into_iter().next() {
        return Err(failure(problem));
    }
    if let Some(rev) = &sdk_rev {
        if rev.is_empty()
            || !rev
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
        {
            return Err(usage(format!(
                "--sdk-rev {rev:?} is not a commit, tag or branch name"
            )));
        }
    }
    if let Some(repo) = &sdk_repo {
        if repo.is_empty()
            || repo
                .chars()
                .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '\\' | '#' | '{' | '}'))
        {
            return Err(usage(format!("--sdk-repo {repo:?} is not a plain git URL")));
        }
    }
    Ok(Options {
        dir,
        lang,
        example,
        name,
        existing,
        install,
        sdk_rev,
        sdk_repo: sdk_repo.unwrap_or_else(|| SDK_REPO.into()),
        json,
    })
}

/// A Python distribution name: lowercase ASCII letters, digits, `.`, `_`, `-`.
pub fn python_name(raw: &str) -> String {
    let name = squash(raw, |c| {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
    });
    let name = name.trim_matches(|c| matches!(c, '-' | '.' | '_'));
    if name.is_empty() {
        "autophys-project".into()
    } else {
        name.into()
    }
}

/// A Cargo package name: lowercase ASCII letters, digits, `_`, `-`, starting
/// with a letter.
pub fn crate_name(raw: &str) -> String {
    let name = squash(raw, |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    let name = name.trim_matches(|c| matches!(c, '-' | '_'));
    match name.chars().next() {
        None => "autophys-project".into(),
        Some(c) if c.is_ascii_alphabetic() => name.into(),
        Some(_) => format!("project-{name}"),
    }
}

/// Lowercase, each run of characters outside `keep` replaced by one `-`.
fn squash(raw: &str, keep: impl Fn(char) -> bool) -> String {
    let mut out = String::new();
    for c in raw.trim().to_lowercase().chars() {
        if keep(c) {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out
}

/// The project's files, `(path in the project, bytes)`, `.tmpl` names kept.
pub fn template(example: &Example, lang: Lang) -> Vec<(String, Cow<'static, [u8]>)> {
    example.project_files(lang.as_str())
}

pub fn render(text: &str, vars: &[(&str, &str)]) -> String {
    vars.iter().fold(text.to_string(), |text, (key, value)| {
        text.replace(&format!("{{{{{key}}}}}"), value)
    })
}

/// A collection holds one project per name, so a second scaffold with a name
/// already in it would write into that project, mixing two projects' records
/// (decision G3-NAME). Only the local collection (`$AUTOPHYS_HOME`, else
/// `~/autophys`) is checked: it is where the scaffolded project writes unless
/// `AUTOPHYS_SERVER` sends its records to a daemon.
fn check_new_name(name: &str, collection: &Path) -> Result<(), Failure> {
    // G3-FILE: a home naming one workbook file sends every project there
    // (both SDKs' `connect`), whatever the project's name.
    if collection.to_string_lossy().ends_with(autophys::SUFFIX) {
        if !collection.exists() {
            return Ok(());
        }
        if collection.is_dir() {
            return Err(failure(format!(
                "$AUTOPHYS_HOME {} ends in {} but is a folder, which no SDK can open as a workbook. \
                 Point AUTOPHYS_HOME at a collection folder or a workbook file",
                collection.display(),
                autophys::SUFFIX
            )));
        }
        return Err(failure(format!(
            "$AUTOPHYS_HOME is the workbook {}; project {name:?} would write into it. \
             Point AUTOPHYS_HOME at a collection folder, or pass --existing to add to that workbook",
            collection.display()
        )));
    }
    let path = collection.join(format!("{}{}", autophys::slug(name), autophys::SUFFIX));
    if !path.exists() {
        return Ok(());
    }
    Err(failure(format!(
        "project {name:?} already exists in {}; a new project would write into it. \
         Pick another name (--name NAME), or pass --existing to add to that project",
        collection.display()
    )))
}

fn check_empty(dir: &Path) -> Result<(), Failure> {
    match std::fs::read_dir(dir) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Err(failure(format!(
                    "{} is not empty; choose a new or empty directory",
                    dir.display()
                )));
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => Err(failure(format!(
            "{} exists and is not a directory",
            dir.display()
        ))),
        Err(e) => Err(failure(format!("{}: {e}", dir.display()))),
    }
}

/// Write the template into `dir`, which must be absent or empty.
pub fn write_project(
    dir: &Path,
    files: &[(String, Cow<'static, [u8]>)],
    vars: &[(&str, &str)],
) -> Result<Vec<String>, Failure> {
    check_empty(dir)?;
    std::fs::create_dir_all(dir).map_err(|e| failure(format!("{}: {e}", dir.display())))?;
    let mut written = Vec::new();
    for (relative, bytes) in files {
        let (relative, bytes) = match relative.strip_suffix(".tmpl") {
            Some(stripped) => {
                let text = std::str::from_utf8(bytes)
                    .map_err(|_| failure(format!("template {relative} is not UTF-8")))?;
                (stripped.to_string(), render(text, vars).into_bytes())
            }
            None => (relative.clone(), bytes.to_vec()),
        };
        let path = dir.join(&relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| failure(format!("{}: {e}", parent.display())))?;
        }
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(|e| failure(format!("{}: {e}", path.display())))?;
        written.push(relative);
    }
    Ok(written)
}

fn venv_python(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        dir.join(".venv").join("bin").join("python")
    }
}

/// `python3 -m venv .venv`, then install the project (its dependencies: the
/// SDK from git, plus the template's own). Their output goes to stderr.
fn install_python(dir: &Path) -> Result<(), String> {
    let python = std::env::var("AUTOPHYS_PYTHON")
        .ok()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "python3".into());
    let run = |program: &Path, args: &[&str]| -> Result<(), String> {
        let shown = format!("{} {}", program.display(), args.join(" "));
        eprintln!("autophys new: {shown}");
        let status = Command::new(program)
            .args(args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(std::io::stderr()))
            .status()
            .map_err(|e| format!("{shown}: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("{shown} failed ({status})"))
        }
    };
    run(Path::new(&python), &["-m", "venv", ".venv"])?;
    run(&venv_python(dir), &["-m", "pip", "install", "--quiet", "."])
}

fn next_steps(opts: &Options, installed: bool) -> Vec<String> {
    let dir = opts.dir.display().to_string();
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '~');
    let dir = if dir.chars().all(plain) {
        dir
    } else {
        format!("'{}'", dir.replace('\'', "'\\''"))
    };
    let mut steps = vec![format!("cd {dir}")];
    if opts.lang == Lang::Python && !installed {
        steps.push("python3 -m venv .venv".into());
        steps.push(".venv/bin/python -m pip install .".into());
    }
    steps.extend(
        opts.example
            .manifest
            .next
            .get(opts.lang.as_str())
            .cloned()
            .unwrap_or_default(),
    );
    steps.push("autophys connect URL   # once per device, to record on an autophys server".into());
    steps
}

/// `autophys new`: write the project, install a Python environment unless
/// `--no-install`, and print the next steps.
pub fn new(args: Vec<String>, out: &mut impl Write) -> Result<Value, Failure> {
    let opts = parse(args)?;
    let sdk_rev = match (&opts.sdk_rev, source_commit()) {
        (Some(rev), _) => rev.clone(),
        (None, Some(commit)) => commit.to_string(),
        (None, None) => {
            return Err(usage(
                "this autophys was built without a Git commit; pass --sdk-rev REV (a commit of the autophys repository)",
            ));
        }
    };
    let base = opts
        .dir
        .components()
        .next_back()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .filter(|n| n != "." && n != "..")
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .and_then(|d| d.file_name().map(|n| n.to_string_lossy().into_owned()))
        })
        .unwrap_or_default();
    let raw_name = opts.name.clone().unwrap_or(base);
    let name = match opts.lang {
        Lang::Python => python_name(&raw_name),
        Lang::Rust => crate_name(&raw_name),
    };
    if !opts.existing {
        check_new_name(&name, &autophys::default_home())?;
    }
    let files = template(&opts.example, opts.lang);
    let crate_name = crate_name(&raw_name);
    // PEP 508 refuses a URL without a host, so pip needs file://localhost/PATH
    // for a local repository where Git and Cargo take file:///PATH.
    let sdk_repo = match (opts.lang, opts.sdk_repo.strip_prefix("file:///")) {
        (Lang::Python, Some(path)) => format!("file://localhost/{path}"),
        _ => opts.sdk_repo.clone(),
    };
    let vars = [
        ("name", name.as_str()),
        ("crate_name", crate_name.as_str()),
        ("sdk_repo", sdk_repo.as_str()),
        ("sdk_rev", sdk_rev.as_str()),
    ];
    let written = write_project(&opts.dir, &files, &vars)?;
    let dir = std::fs::canonicalize(&opts.dir).unwrap_or_else(|_| opts.dir.clone());

    let mut installed = false;
    if opts.lang == Lang::Python && opts.install {
        if let Err(e) = install_python(&dir) {
            return Err(failure(format!(
                "{e}\nthe project is in {}; finish its setup with:\n  {}",
                dir.display(),
                next_steps(&opts, false)[..3].join("\n  ")
            )));
        }
        installed = true;
    }
    let steps = next_steps(&opts, installed);
    if opts.json {
        return Ok(json!({
            "dir": dir.display().to_string(),
            "lang": opts.lang.as_str(),
            "example": opts.example.name,
            "kind": opts.example.kind,
            "name": name,
            "sdk_repo": sdk_repo,
            "sdk_rev": sdk_rev,
            "installed": installed,
            "files": written,
            "next": steps,
        }));
    }
    let _ = writeln!(
        out,
        "Created {} ({} project {name:?}, {} {}), with the autophys SDK at {sdk_rev}.",
        opts.dir.display(),
        opts.lang.as_str(),
        opts.example.kind,
        opts.example.name
    );
    if installed {
        let _ = writeln!(out, "Installed its environment in .venv.");
    }
    let _ = writeln!(out, "\nNext:");
    for step in &steps {
        let _ = writeln!(out, "  {step}");
    }
    let _ = writeln!(out, "\nREADME.md walks through the project.");
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn names_are_valid_for_each_tool() {
        assert_eq!(python_name("My Cell Lab!"), "my-cell-lab");
        assert_eq!(python_name("..."), "autophys-project");
        assert_eq!(crate_name("My Cell.Lab"), "my-cell-lab");
        assert_eq!(crate_name("2024 cells"), "project-2024-cells");
        assert_eq!(crate_name("___"), "autophys-project");
    }

    #[test]
    fn arguments() {
        let o = parse(words(
            "cells --lang rust --example blank --no-install --sdk-rev v1.2",
        ))
        .unwrap();
        assert_eq!(o.lang, Lang::Rust);
        assert_eq!((o.example.name.as_str(), o.install), ("blank", false));
        assert_eq!(o.sdk_repo, SDK_REPO);
        let o = parse(words("cells --lang=python")).unwrap();
        assert_eq!((o.example.name.as_str(), o.install), ("battery-fit", true));
        let o = parse(words(
            "cells --lang rust --example builtin:battery-fit.demo",
        ))
        .unwrap();
        assert_eq!(o.example.kind, "demo");
        for bad in [
            "cells",
            "--lang python",
            "cells --lang go",
            "cells --lang rust --example nope",
            "cells --lang rust --example battery",
            "cells --lang rust --example battery-fit#x",
            "cells --lang rust --example github:a/b",
            "cells --lang rust --sdk-rev a\"b",
            "cells --lang rust --sdk-repo x#y",
            "a b --lang rust",
        ] {
            assert_eq!(parse(words(bad)).unwrap_err().code, 2, "{bad}");
        }
    }

    #[test]
    fn every_template_has_a_manifest_and_renders_completely() {
        let projects: Vec<Example> = crate::examples::builtins()
            .into_iter()
            .filter(|e| e.kind != "backtest")
            .collect();
        assert_eq!(projects.len(), 2);
        for example in &projects {
            for (lang, manifest) in [
                (Lang::Python, "pyproject.toml.tmpl"),
                (Lang::Rust, "Cargo.toml.tmpl"),
            ] {
                let files = template(example, lang);
                let name = &example.name;
                assert!(files.iter().any(|(p, _)| p == manifest), "{name} {lang:?}");
                assert!(
                    files.iter().any(|(p, _)| p == "README.md"),
                    "{name} {lang:?}"
                );
                assert!(
                    !files.iter().any(|(p, _)| p == "example.toml"),
                    "{name} {lang:?}"
                );
            }
        }
        let (demo, _) = crate::examples::resolve("battery-fit").unwrap();
        let files = template(&demo, Lang::Rust);
        assert!(files.iter().any(|(p, _)| p == "data/demo.csv"));
        assert!(files.iter().any(|(p, _)| p == "src/main.rs"));
        assert!(!files.iter().any(|(p, _)| p.ends_with(".py")));
    }

    #[test]
    fn refuses_a_name_already_in_the_collection() {
        let collection = tempfile::tempdir().unwrap();
        assert!(check_new_name("my_cell", collection.path()).is_ok());
        std::fs::write(
            collection
                .path()
                .join(format!("{}{}", autophys::slug("my_cell"), autophys::SUFFIX)),
            b"",
        )
        .unwrap();
        let e = check_new_name("my_cell", collection.path()).unwrap_err();
        assert_eq!(e.code, 1);
        assert!(
            e.message.contains("project \"my_cell\" already exists in"),
            "{}",
            e.message
        );
        assert!(e.message.contains("--existing"), "{}", e.message);
        assert!(check_new_name("other_cell", collection.path()).is_ok());
        assert!(
            parse(words("cells --lang python --existing"))
                .unwrap()
                .existing
        );
        assert!(!parse(words("cells --lang python")).unwrap().existing);
    }

    #[test]
    fn refuses_a_home_that_is_an_existing_workbook_file() {
        // G3-FILE: every project would write into that one file.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(format!("battery{}", autophys::SUFFIX));
        assert!(
            check_new_name("thermal", &file).is_ok(),
            "a missing file is created as before"
        );
        std::fs::write(&file, b"").unwrap();
        let e = check_new_name("thermal", &file).unwrap_err();
        assert_eq!(e.code, 1);
        assert!(
            e.message.contains("$AUTOPHYS_HOME is the workbook"),
            "{}",
            e.message
        );
        assert!(
            e.message
                .contains("project \"thermal\" would write into it"),
            "{}",
            e.message
        );
        assert!(e.message.contains("--existing"), "{}", e.message);
        let folder = dir.path().join(format!("odd{}", autophys::SUFFIX));
        std::fs::create_dir(&folder).unwrap();
        let e = check_new_name("thermal", &folder).unwrap_err();
        assert!(e.message.contains("but is a folder"), "{}", e.message);
        assert!(!e.message.contains("--existing"), "{}", e.message);
    }

    #[test]
    fn refuses_a_non_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("keep.txt"), "mine").unwrap();
        let (blank, _) = crate::examples::resolve("blank").unwrap();
        let e = write_project(dir.path(), &template(&blank, Lang::Python), &[]).unwrap_err();
        assert!(e.message.contains("not empty"), "{}", e.message);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("keep.txt")).unwrap(),
            "mine"
        );
    }
}
