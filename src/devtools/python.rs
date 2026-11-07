//! Python lab projects for the developer commands: a `mypkg.module:project`
//! reference names a `Project` or an `@ap.simulator` in trusted lab code. The
//! command spawns `python -m autophys.worker` (the Python SDK) and drives it
//! through `autophys::worker` (cli.md CLI-11, option A). This module is the
//! spawn policy: which interpreter, and where the module is imported from.
use autophys::project::Project;
use std::path::Path;
use std::process::Command;

/// The interpreter: the command's `--python` or configuration value, else
/// `AUTOPHYS_PYTHON` (as `autophys new` uses it), else `python3`.
pub fn interpreter(explicit: Option<String>) -> String {
    explicit
        .or_else(|| {
            std::env::var("AUTOPHYS_PYTHON")
                .ok()
                .filter(|p| !p.is_empty())
        })
        .unwrap_or_else(|| "python3".into())
}

/// Whether `reference` names Python code rather than a built-in project.
pub fn is_reference(reference: &str) -> bool {
    reference.contains(':')
}

/// Import `reference` with `python`, the lab `root` first on `sys.path` (as
/// the former Python server did), keeping this process's working directory
/// and environment.
pub fn load(reference: &str, root: &Path, python: &str) -> Result<Project, String> {
    let mut command = Command::new(python);
    command
        .args(["-m", "autophys.worker", "--root"])
        .arg(root)
        .arg(reference);
    autophys::worker::project(command, reference).map_err(|e| {
        let mut message = e.to_string();
        if message.contains("No module named 'autophys") || message.contains("could not start") {
            message += &format!(
                "\n{python} must be an interpreter with the autophys SDK installed: pass --python, or set AUTOPHYS_PYTHON, to the lab environment's interpreter"
            );
        }
        message
    })
}
