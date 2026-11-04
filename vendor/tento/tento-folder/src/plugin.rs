//! The `folder.*` tsh plugin — check a directory against a tsh spec file.
//!
//! Imported as `(@import "tento-folder" :as "folder")`, or run as the
//! standalone `tento-folder` binary (feature `cli`).
//!
//! ```text
//! folder.check layout.folder [dir]    validate dir (default .) against the spec; fails on any violation
//! folder.check layout.folder --report the same, but return the violations as data instead of failing
//! folder.show layout.folder           the spec as a tree
//! ```
//!
//! Name spec files `*.folder`, not `*.tsh`: the command engine runs the first
//! `.tsh` argument on the command line as a script before dispatching.
//!
//! A spec file is tsh whose last form is a `folder.*` node (see
//! [`crate::tsh`]). Output is `table/v1` / `sections/v1` shape JSON built
//! with the builders every plugin shares ([`tento_shapes::build`]), so it
//! renders at a tsh prompt.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tento_lisp_cmd::{CommandArg, Scripts, command};
use tento_shapes::build::{self as view, Col, section, sections, styled, table};

use crate::{FolderViolation, Spec, violations};

pub const TOOL: &str = "tento-folder";

/// The plugin needs no state; every command reads its spec file fresh.
#[derive(Clone, Debug, Default)]
pub struct FolderPlugin;

/// Read and evaluate a tsh spec file.
pub fn load_spec(path: &Path) -> anyhow::Result<Spec> {
  let src = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
  crate::tsh::spec_from_tsh(&src).with_context(|| format!("evaluate {}", path.display()))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CheckReport {
  pub spec: String,
  pub dir: String,
  pub violations: Vec<FolderViolation>,
}

/// A `table/v1` of violations: path, problem, detail.
pub fn violations_table(violations: &[FolderViolation]) -> Value {
  let rows = violations
    .iter()
    .map(|v| {
      vec![
        Value::String(v.path.clone()),
        styled(v.problem.clone(), view::ERROR),
        styled(v.detail.clone(), view::SECONDARY),
      ]
    })
    .collect();
  table(
    None,
    vec![
      Col::new("path", 0),
      Col::new("problem", 0),
      Col::new("detail", 1),
    ],
    rows,
  )
}

/// Violations as plain lines, for the error a failing check returns.
pub fn violations_text(violations: &[FolderViolation]) -> String {
  violations
    .iter()
    .map(|v| format!("  {}  {}  ({})", v.path, v.problem, v.detail))
    .collect::<Vec<_>>()
    .join("\n")
}

#[derive(Clone, Debug, Default, Deserialize, CommandArg)]
pub struct CheckArgs {
  /// The tsh spec file.
  #[arg(positional)]
  pub spec: String,
  /// The directory to check (default: the current directory).
  #[arg(positional, default = ".")]
  pub dir: String,
  /// Return the violations as data instead of failing on them.
  pub report: bool,
}

#[command(
  name = "check",
  description = "Validate a directory (default .) against a folder.* tsh spec. Fails listing every violation; --report returns them as data instead"
)]
pub async fn check(_plugin: FolderPlugin, args: CheckArgs) -> tento_lisp_cmd::Result<Value> {
  let spec = load_spec(Path::new(&args.spec))?;
  let dir = PathBuf::from(&args.dir);
  let violations = match spec.validate(&dir) {
    Ok(()) => Vec::new(),
    Err(e) => violations(&dir, &e),
  };
  if !violations.is_empty() && !args.report {
    return Err(
      anyhow::anyhow!(
        "{} violation(s) of {} in {}:\n{}",
        violations.len(),
        args.spec,
        args.dir,
        violations_text(&violations)
      )
      .into(),
    );
  }
  let shape = if violations.is_empty() {
    view::note(vec![styled(
      format!("{} · {} · ok", args.dir, args.spec),
      view::OK,
    )])
  } else {
    sections(vec![section(
      Some(styled(
        format!("{} · {} violation(s)", args.dir, violations.len()),
        view::ERROR,
      )),
      violations_table(&violations),
    )])
  };
  let report = CheckReport {
    spec: args.spec,
    dir: args.dir,
    violations,
  };
  Ok(view::with_records(shape, "folder.check/v1", &report).map_err(anyhow::Error::from)?)
}

#[derive(Clone, Debug, Default, Deserialize, CommandArg)]
pub struct ShowArgs {
  /// The tsh spec file.
  #[arg(positional)]
  pub spec: String,
}

#[command(name = "show", description = "Render a folder.* tsh spec as a tree")]
pub async fn show(_plugin: FolderPlugin, args: ShowArgs) -> tento_lisp_cmd::Result<Value> {
  let spec = load_spec(Path::new(&args.spec))?;
  let shape = sections(vec![section(
    Some(Value::String(args.spec)),
    spec.rows_table(),
  )]);
  Ok(view::with_records(shape, "folder.spec/v1", &spec.to_json()).map_err(anyhow::Error::from)?)
}

pub fn scripts(plugin: FolderPlugin) -> Scripts<FolderPlugin> {
  Scripts::new(plugin)
    .with_app_identity(TOOL, env!("CARGO_PKG_VERSION"), "bin/tento-folder")
    .add_command(check)
    .add_command(show)
}
