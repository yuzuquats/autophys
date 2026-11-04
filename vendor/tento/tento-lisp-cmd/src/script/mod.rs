//! `.tsh` script-file support.
//!
//! A `.tsh` file, a tsh-shebang file, `tsh run FILE` and every rc file are
//! strict lisp (operator Refinements 6, 9, 10, 2026-10-05):
//!
//! ```text
//! #!/usr/bin/env tsh                  ;; a shebang on line 1 is allowed
//! ;; comments are `;;` (a `#` line is a loud error)
//! (let name (concat "x-" "y"))         ;; top-level lisp; persists in env
//! (sheets.create :name name)           ;; a command is a lisp call
//! (sh! git log -1 --format=%s {name})  ;; bash through the `sh!` macro
//! ```
//!
//! A bash-looking line is a loud error ("looks like bash; wrap it:
//! (sh! …)"), and so is the legacy `> (form)` prefix. The interactive
//! prompt keeps the mixed dialect; `-c`, stdin and `.sh` files are bash.
//! See `sh_macro` for the macro and its holes.

mod process_pipeline;
mod stack;
pub use process_pipeline::{ProcessOutput, flush_shell_output, run_process_pipeline, run_process_pipeline_with_io, start_process_background};

mod shell_redirect;
pub use shell_redirect::{FdTarget, ShellFileOpener, ShellIo, ShellOpenOptions, ShellOptionsFileOpener};

mod shell_printf;
mod bash_printf;
mod bash_functions;
mod bash_time;
mod bash_select;
mod shell_workers;
mod owned_io_fork;
#[doc(hidden)]
pub use owned_io_fork::uncovered_shell_forks;
mod shell_jobs;
pub use shell_jobs::{
  Advance, BackgroundOutput, ExecState, FoldedExecution, JobAdmission, JobHost, JobOutcome,
  JobOutcomeFuture, JobPlan, JobSlot, ProcEvent, ProcObserver, TransitionConflict, fold_lifecycle,
  job_status_text, job_stopped_text, lifecycle_record, settled_outcome, claim_terminal,
  terminal_owned, StoppedJob, adopt_stopped_job, job_control_requested, note_job_continued,
  note_job_finished, note_job_stopped, observe_job,
};
#[cfg(unix)]
pub use shell_jobs::start_process_foreground;
mod shell_cmd;
mod shell_commands;
pub use shell_commands::{
  ShellBuiltin, ShellBuiltinOutput, ShellCommandAdmission, ShellFailureDisplay, shell_test,
};

mod bash_compound;
mod bash_arrays;
mod bash_attributes;
mod bash_unset;
mod bash_test_vars;
mod bash_export;
mod bash_read;
mod bash_type;
mod bash_dirs;
pub use bash_compound::ControlSignal;
mod bash_flow;
mod bash_callstack;
mod bash_xtrace;
mod bash_lisp_bridge;
mod sh_macro;
pub mod env_files;
pub use sh_macro::{StrictRefusal, strict_refusal, strict_refusal_message, strict_refusals};
pub use bash_flow::{PipelineFuture, ShellCapture, ShellFormatter, ShellJob};

pub(crate) mod arg_bind;
pub(crate) mod interp;
pub(crate) mod parser;
pub(crate) mod runner;
pub(crate) mod value;
pub use parser::{LineKind, classify_in, first_form_trailer, lisp_trailer_message};

// Externally-callable surface for embedding the script crate's lisp host.
// In-crate consumers continue to use the modules directly.
pub use arg_bind::{
  lisp_args_to_argv, lisp_args_to_bind_doc, lisp_args_to_tokens, lisp_args_to_typed,
};
pub use bash_read::{TerminalLine, TerminalRead};
pub use interp::{
  AsyncCommandFut, AsyncDispatch, DeprecationNotes, ExternalCommands, ExternalLookup, ImportMounts, ImportResolver,
  LispHost, LispHostError, NoApps, Sym, value_from_json, value_to_json,
};
pub use value::{HostValue, LispScalar};

// Re-export `tento_lisp` types that hosts need to author
// `register_native_special` closures or call into stashed lisp values.
// `LispValue` is the AST/runtime value type (strings, ints, lists,
// functions, …); `Function` wraps native/lambda variants; `List` is the
// payload a host builds to RETURN a `LispValue::List` from a native.
pub use tento_lisp::{EvalBudget, Function, List as LispList, Text, Value as LispValue};
/// Error type used by injected import resolvers and native closures.
pub use tento_lisp::RuntimeError;
pub use tento_lisp::types::{ParamKind, Parameter, Signature, TypeExpr};

use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

use crate::Scripts;
use crate::shell::Callable;

pub use runner::{
  OnError, RunOptions, TshScriptError, TshScriptErrorKind, run_script_with_prefix_setup,
  run_source_on_host, run_reader_on_host,
};

/// Run a `.tsh` file against the given Scripts/subcommands registry.
pub async fn run_file<Info: Clone + 'static>(
  path: impl AsRef<Path>,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  options: RunOptions,
) -> Result<(), TshScriptError> {
  run_file_with_prefix(path, scripts, subcommands, &[], options).await
}

/// Like [`run_file`] but prepends `prefix` to every command line
/// before dispatch. Used when the `.tsh` was reached through a
/// nested subcommand chain (`./run a b script.tsh`): commands
/// inside the file are dispatched as if the operator typed
/// `a b <cmd>` at the top level.
pub async fn run_file_with_prefix<Info: Clone + 'static>(
  path: impl AsRef<Path>,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  prefix: &[String],
  options: RunOptions,
) -> Result<(), TshScriptError> {
  run_file_with_prefix_and_resolver(
    path,
    scripts,
    subcommands,
    prefix,
    std::rc::Rc::new(crate::script::NoApps),
    options,
  )
  .await
}

/// Like [`run_file_with_prefix`] but also injects a `.tsh.app` search path so a
/// file-based script can use `(@import "name")` — the file counterpart of
/// [`run_str_with_apps`]. The CLI script path (`tsh script.tsh`) routes through
/// here so `app_dirs` (declared by the composition root) reaches `@import`,
/// matching the startup-script path. `app_dirs` is injected, never read here.
/// Resolver-based core of [`run_file_with_prefix_and_apps`]: the generic engine
/// threads `Rc<dyn ImportResolver>`; the `*_apps` wrapper builds it from a search
/// path. The interactive / one-shot dispatcher calls this directly.
pub async fn run_file_with_prefix_and_resolver<Info: Clone + 'static>(
  path: impl AsRef<Path>,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  prefix: &[String],
  resolver: std::rc::Rc<dyn ImportResolver>,
  options: RunOptions,
) -> Result<(), TshScriptError> {
  let source = std::fs::read_to_string(path.as_ref()).map_err(|e| TshScriptError {
    line: 0,
    source_line: format!("{}", path.as_ref().display()),
    kind: TshScriptErrorKind::Command(crate::Error::Other(anyhow::anyhow!(
      "failed to read script: {}",
      e
    ))),
  })?;
  // A file script IS file-backed: stamp its path so `(std.script.dir)`
  // resolves inside it (an explicit caller-set source_path wins).
  let options = RunOptions {
    source_path: options
      .source_path
      .or_else(|| Some(path.as_ref().to_path_buf())),
    ..options
  };
  runner::run_script_with_prefix(&source, scripts, subcommands, prefix, resolver, options).await
}

/// Run a `.tsh` script from an in-memory source string.
pub async fn run_str<Info: Clone + 'static>(
  source: &str,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  options: RunOptions,
) -> Result<(), TshScriptError> {
  runner::run_script(source, scripts, subcommands, options).await
}

/// Run an in-memory `.tsh` script with an injected `.tsh.app` search path,
/// enabling the `(@import "name")` form. `app_dirs` is supplied by the
/// composition root (which declares it as typed `tento_env` config) — it is
/// not read from the environment here.
pub async fn run_str_with_resolver<Info: Clone + 'static>(
  source: &str,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  resolver: std::rc::Rc<dyn ImportResolver>,
  options: RunOptions,
) -> Result<(), TshScriptError> {
  runner::run_script_with_prefix(source, scripts, subcommands, &[], resolver, options).await
}

/// Like [`run_str_with_apps`] but registers caller natives on the host first and
/// **returns the host** so its env (and any lambdas the script defined) outlives
/// the run. This is the startup-rc seam: a host wires `(defmode …)` natives that
/// capture shared state, the rc populates it, and the kept-alive host lets the
/// session fire those Lisp definitions later. See
/// [`runner::run_script_with_prefix_setup`].
pub async fn run_str_with_resolver_setup<Info, F>(
  source: &str,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  resolver: std::rc::Rc<dyn ImportResolver>,
  options: RunOptions,
  setup: F,
) -> Result<LispHost, TshScriptError>
where
  Info: Clone + 'static,
  F: FnOnce(&mut LispHost),
{
  runner::run_script_with_prefix_setup(source, scripts, subcommands, &[], resolver, options, setup)
    .await
}
