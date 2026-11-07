//! Build-time facts the binary embeds:
//!
//! - `AUTOPHYS_SOURCE_COMMIT`: the commit `autophys new` pins the SDK to.
//!   `AUTOPHYS_COMMIT` (stamped by `ops/deploy.sh` and `ops/package.sh`) wins;
//!   otherwise `git rev-parse HEAD` of this checkout; otherwise empty (a
//!   source export without Git), and `autophys new` then needs `--sdk-rev`.
//! - `examples.rs` in `OUT_DIR`: every file under `examples/`, embedded with
//!   `include_bytes!`, so the projects `autophys new` writes have one source.
//! - `train_workers.rs` in `OUT_DIR`: the Python workers under `train/sft/`
//!   (without `tests/`), which `autophys train` writes to its own directory
//!   when no `--train-dir` is given, so a release binary can train.
//! - `python_sdk.rs` in `OUT_DIR`: the Python SDK under `sdks/python/`
//!   (without `tests/`), installed beside those workers because their Modal
//!   images build it from `../../sdks/python`.
use std::path::{Path, PathBuf};
use std::process::Command;

/// Runs git in `root`, but only when `root` is the top of its own repository:
/// a source export unpacked inside some other checkout must not pin that
/// checkout's HEAD or list its files.
fn git(root: &Path, args: &[&str]) -> Option<String> {
    let top = git_raw(root, &["rev-parse", "--show-toplevel"])?;
    if std::fs::canonicalize(&top).ok()? != std::fs::canonicalize(root).ok()? {
        return None;
    }
    git_raw(root, args)
}

fn git_raw(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

fn source_commit(root: &Path) -> String {
    println!("cargo:rerun-if-env-changed=AUTOPHYS_COMMIT");
    if let Ok(commit) = std::env::var("AUTOPHYS_COMMIT") {
        if !commit.is_empty() {
            return commit;
        }
    }
    // Rebuild when HEAD moves: HEAD itself, the branch it names, packed refs.
    let mut watched = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Some(branch) = git(root, &["symbolic-ref", "-q", "HEAD"]) {
        watched.push(branch);
    }
    for name in watched {
        if let Some(path) = git(root, &["rev-parse", "--git-path", &name]) {
            let path = root.join(path);
            if path.exists() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
    git(root, &["rev-parse", "--verify", "HEAD"]).unwrap_or_default()
}

/// The files under `dir`: Git's view (tracked plus untracked, minus ignored)
/// so a `.venv`, plot or training run left in place is never embedded; a
/// plain directory walk where there is no Git. Either way [`local_state`]
/// is left out, so a build without Git embeds no caches, runs or env files.
fn tree_files(root: &Path, dir: &Path) -> Vec<PathBuf> {
    let relative = dir.strip_prefix(root).unwrap().to_str().unwrap();
    let mut files = Vec::new();
    if let Some(listing) = git(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            relative,
        ],
    ) {
        files = listing
            .split('\0')
            .filter(|name| !name.is_empty())
            .map(|name| root.join(name))
            .filter(|path| path.is_file())
            .collect();
    }
    if files.is_empty() {
        walk(dir, &mut files);
    }
    files.retain(|path| {
        !path
            .strip_prefix(dir)
            .unwrap()
            .components()
            .any(|c| local_state(c.as_os_str().to_str().unwrap_or("")))
    });
    files.sort();
    files.dedup();
    files
}

/// Names of local state that must never be embedded, whether or not Git is
/// there to apply `.gitignore`: caches, environments, training output, and
/// env files that can hold keys. Mirrors the repository's `.gitignore`s.
fn local_state(name: &str) -> bool {
    matches!(
        name,
        "__pycache__"
            | ".pytest_cache"
            | ".mypy_cache"
            | ".ruff_cache"
            | ".DS_Store"
            | "node_modules"
            | "target"
            | "runs"
            | "loops"
            | "results"
            | "build"
            | "dist"
            | ".env"
            | ".agent-state.json"
    ) || name.starts_with(".venv")
        || name.starts_with("data-")
        || name.starts_with("label-work")
        || name.ends_with(".pyc")
        || name.ends_with(".pyo")
        || name.ends_with(".pyd")
        || name.ends_with(".egg-info")
        || (name.ends_with(".env") && name != ".env")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            walk(&path, out);
        } else {
            out.push(path);
        }
    }
}

fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    println!(
        "cargo:rustc-env=AUTOPHYS_SOURCE_COMMIT={}",
        source_commit(&root)
    );

    embed(&root, "examples", &[], "examples.rs");
    embed(&root, "train/sft", &["tests"], "train_workers.rs");
    embed(&root, "sdks/python", &["tests"], "python_sdk.rs");
}

/// Writes `OUT_DIR/out` with `FILES`: each file under `root/dir` as its
/// `/`-separated path below `dir` and its bytes, skipping the top-level
/// entries named in `skip`.
fn embed(root: &Path, dir: &str, skip: &[&str], out: &str) {
    let base = root.join(dir);
    println!("cargo:rerun-if-changed={}", base.display());
    let mut code = String::from("pub static FILES: &[(&str, &[u8])] = &[\n");
    for path in tree_files(root, &base) {
        let relative = path.strip_prefix(&base).unwrap();
        let name: Vec<_> = relative
            .components()
            .map(|c| c.as_os_str().to_str().expect("embedded paths are UTF-8"))
            .collect();
        if skip.contains(&name[0]) {
            continue;
        }
        // What running an example in place writes at its project root
        // (`examples/<name>/<language>/`, the root its `.gitignore` anchors).
        if dir == "examples"
            && name.len() == 3
            && (name[2] == "demo.csv" || name[2] == "fit.csv" || name[2].ends_with(".png"))
        {
            continue;
        }
        code.push_str(&format!(
            "    ({:?}, include_bytes!({:?})),\n",
            name.join("/"),
            path.display().to_string()
        ));
    }
    code.push_str("];\n");
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join(out);
    std::fs::write(out, code).unwrap();
}
