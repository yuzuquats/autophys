//! Build-time facts the binary embeds:
//!
//! - `AUTOPHYS_SOURCE_COMMIT`: the commit `autophys new` pins the SDK to.
//!   `AUTOPHYS_COMMIT` (stamped by `ops/deploy.sh` and `ops/package.sh`) wins;
//!   otherwise `git rev-parse HEAD` of this checkout; otherwise empty (a
//!   source export without Git), and `autophys new` then needs `--sdk-rev`.
//! - `templates.rs` in `OUT_DIR`: every file under `templates/`, embedded with
//!   `include_bytes!`, so the project templates have one source.
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

/// The template files: Git's view (tracked plus untracked, minus ignored) so
/// a `.venv` or plot left by running a template in place is never embedded;
/// a plain directory walk where there is no Git.
fn template_files(root: &Path, templates: &Path) -> Vec<PathBuf> {
    if let Some(listing) = git(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            "templates",
        ],
    ) {
        let mut files: Vec<PathBuf> = listing
            .split('\0')
            .filter(|name| !name.is_empty())
            .map(|name| root.join(name))
            .filter(|path| path.is_file())
            .collect();
        files.sort();
        files.dedup();
        if !files.is_empty() {
            return files;
        }
    }
    let mut files = Vec::new();
    walk(templates, &mut files);
    files
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

    let templates = root.join("templates");
    println!("cargo:rerun-if-changed={}", templates.display());
    let files = template_files(&root, &templates);
    let mut code = String::from("pub static FILES: &[(&str, &[u8])] = &[\n");
    for path in files {
        let relative = path.strip_prefix(&templates).unwrap();
        let name: Vec<_> = relative
            .components()
            .map(|c| c.as_os_str().to_str().expect("template paths are UTF-8"))
            .collect();
        code.push_str(&format!(
            "    ({:?}, include_bytes!({:?})),\n",
            name.join("/"),
            path.display().to_string()
        ));
    }
    code.push_str("];\n");
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("templates.rs");
    std::fs::write(out, code).unwrap();
}
