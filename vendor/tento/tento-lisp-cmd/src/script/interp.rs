use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value as JsonValue;
use string_interner::backend::StringBackend;
use string_interner::symbol::SymbolU32;
use tento_lisp::{
  Env, EvalError, Function, ImportHandler, Interpreter, Member, NativeClosure, NativeFn,
  ReceiverState, RuntimeError, SyntaxError, Value as LispValue,
};

use super::value::{HostValue, LispScalar};
use indexmap::IndexMap;

#[path = "bash_expansion.rs"]
mod bash_expansion;

#[cfg(test)]
#[path = "fleet_prereq_tests.rs"]
mod fleet_prereq_tests;

pub type Sym = SymbolU32;

// Lisp evaluation has no text-output mode, including after an error.
struct LispOutputReset(Rc<Cell<bool>>);
impl Drop for LispOutputReset {
  fn drop(&mut self) { self.0.set(false); }
}

type CommandNatives = Rc<RefCell<HashMap<String, NativeClosure<Sym>>>>;

fn forward_help(argv: &mut Vec<String>) {
  let end = argv.iter().position(|word| word == "--").unwrap_or(argv.len());
  argv.insert(end, "--help".into());
}

/// Name → who owns it (see [`LispHost::command_owners`]).
type CommandOwners = Rc<RefCell<HashMap<String, String>>>;

/// The refusal for `(@import NAME :as NAMESPACE)` when NAMESPACE is already a
/// tsh command: `std` (`std.coreutil` included), a prelude name or another bundle's mount.
/// Re-importing the same bundle under its own name is not a collision, nor is
/// the rc's word mount of that same import (a command group named NAMESPACE).
fn import_collision(
  bundle: &str,
  namespace: &str,
  owners: &HashMap<String, String>,
  natives: &HashMap<String, NativeClosure<Sym>>,
) -> Option<String> {
  let owner = if namespace == "std" || namespace.starts_with("std.") {
    Some("std (read-only)".to_string())
  } else {
    match owners.get(namespace) {
      Some(owner) => (owner != &format!("bundle {bundle}")).then(|| owner.clone()),
      None => natives.contains_key(namespace).then(|| "a registered command".to_string()),
    }
  }?;
  let short = bundle.strip_prefix("tsh-").unwrap_or(bundle);
  let free = [short.to_string(), bundle.to_string(), format!("{short}-plugin")]
    .into_iter()
    .find(|name| name != namespace && word_is_free(name, owners, natives))
    .unwrap_or_else(|| format!("{namespace}-{short}"));
  Some(format!(
    "`{namespace}` is already {owner}; mount {bundle} under another name, e.g. :as \"{free}\""
  ))
}

/// Whether nobody owns `name`: no owner and no command. A `PATH` program of
/// that name is no conflict (operator Refinement 4, 2026-10-05, superseding
/// the 2026-10-04 refusal): a mount binds a Lisp name only, reached as
/// `ns.export`, and bash lookup never resolves a mount, so `tmux ls` runs
/// the tmux program beside a `tmux` mount.
fn word_is_free(name: &str, owners: &HashMap<String, String>, natives: &HashMap<String, NativeClosure<Sym>>) -> bool {
  !owners.contains_key(name) && !natives.contains_key(name)
}

fn import_native_reflection(
  name: String, value: LispValue<Sym>, json: Rc<Cell<bool>>, natives: &CommandNatives,
) -> (String, LispValue<Sym>) {
  let LispValue::Function(Function::NativeClosure(native)) = value else { return (name, value); };
  let wrapper: NativeClosure<Sym> = Rc::new(move |env, mut args| {
    let options = super::arg_bind::take_reflection_lisp(&mut args);
    json.set(options.json);
    if options.help {
      let end = args.iter().position(|arg| matches!(arg, LispValue::String(s) if s == "--")).unwrap_or(args.len());
      args.insert(end, LispValue::String("--help".into()));
    }
    native(env, args)
  });
  natives.borrow_mut().insert(name.clone(), wrapper.clone());
  (name, LispValue::Function(Function::NativeClosure(wrapper)))
}

fn import_async_reflection(
  name: String, dispatch: AsyncDispatch, json: Rc<Cell<bool>>, natives: CommandNatives, env: Rc<RefCell<Env<Sym>>>,
) -> AsyncDispatch {
  Rc::new(move |mut argv| {
    let options = super::arg_bind::take_reflection_argv(&mut argv);
    json.set(options.json);
    if options.help {
      let native = natives.borrow().get(&name).cloned();
      if let Some(native) = native {
        let value = native(env.clone(), vec![LispValue::String("--help".into())])
          .map_err(|error| crate::Error::Other(anyhow::anyhow!("{error}")))?;
        json.set(options.json);
        return Ok(Box::pin(async move { Ok(value_to_json(&value)) }));
      }
      forward_help(&mut argv);
    }
    dispatch(argv)
  })
}

fn imported_help_value(natives: &CommandNatives, env: Rc<RefCell<Env<Sym>>>, name: &str) -> Option<JsonValue> {
  let native = natives.borrow().get(name).cloned();
  if let Some(native) = native {
    return native(env, vec![LispValue::String("--help".into())]).ok().map(|value| value_to_json(&value));
  }
  let prefix = format!("{name}.");
  let commands: Vec<_> = natives.borrow().iter().filter(|(command, _)| command.starts_with(&prefix))
    .map(|(command, native)| (command.clone(), native.clone())).collect();
  let mut index = crate::reflect::CommandIndex::default();
  for (command, native) in commands {
    let Ok(value) = native(env.clone(), vec![LispValue::String("--help".into())]) else { continue; };
    let Ok(entry) = serde_json::from_value::<crate::reflect::CommandEntry>(value_to_json(&value)) else { continue; };
    let parts: Vec<_> = command[prefix.len()..].split('.').collect();
    crate::run_loop::insert_command_entry(&mut index, &parts, entry);
  }
  if index.entries.is_empty() { None } else { serde_json::to_value(crate::reflect::CommandEntry::Index(index)).ok() }
}

/// Errors produced by the lisp host bridge. Each variant carries enough
/// detail for the runner to attach a line number on top.
#[derive(Debug, thiserror::Error)]
pub enum LispHostError {
  #[error("lisp parse error: {0}")]
  Parse(String),
  #[error("lisp error: {0}")]
  Runtime(String),
  /// A command's failure it reported as data ([`RuntimeError::Reported`]):
  /// the same text as [`Self::Runtime`], with the reported fields kept so
  /// the embedding shell can draw what the command drew
  /// ([`tento_lisp::ReportedFailure::display`]).
  #[error("lisp error: {0}")]
  Reported(Box<tento_lisp::ReportedFailure>),
  /// A dispatched command's OWN returned failure (`ls -t` → "ls: -t … not
  /// implemented yet"), carried from [`RuntimeError::Command`]. Renders WITHOUT
  /// the `lisp error:` label — the command already self-identifies, so stacking
  /// `[line N] ls -t — lisp error: ls: …` reads as three redundant layers. The
  /// origin is the producer's knowledge (the command dispatch layer tags it),
  /// never string inspection of the message.
  #[error("{0}")]
  Command(String),
  /// A HARD lisp error (`is_hard()`: `unwrap`/`expect` escalation, a blown eval budget,
  /// `assert`, structural misuse). Carried distinctly so the `WarnContinue`
  /// runner halts the unit on it instead of collecting-and-continuing.
  #[error("lisp error: {0}")]
  Fatal(String),
  #[error("path lookup failed: {0}")]
  PathLookup(String),
  #[error("undefined symbol or bind: {0}")]
  Undefined(String),
  #[error("expected scalar value, got {0}")]
  NonScalar(String),
  /// A native's failure that carries an exit status for the process (a
  /// `std.cli._start` child that exited N): the caller exits N, not 1.
  /// Carried through the interpreter as [`RuntimeError::Exit`].
  #[error("{message}")]
  Exit { status: i32, message: String },
}

impl LispHostError {
  /// The process status this failure carries, when it carries one.
  pub fn exit_status(&self) -> Option<i32> {
    match self {
      Self::Exit { status, .. } => Some(*status),
      _ => None,
    }
  }
}

/// Map a lisp [`RuntimeError`] onto [`LispHostError::Runtime`], enriching the
/// undefined-symbol case with the bare-word-vs-string teaching law (keeping the
/// original message as the prefix). Other variants stringify as-is. This lives
/// here, at the host-mapping boundary — NOT in `RuntimeError`'s own `Display` —
/// so the structured `CommandNotFound` path (which matches the `RuntimeError`
/// enum upstream of this mapping) is unaffected.
/// The teaching error for a head that IS a program on the declared PATH while
/// external execution is undeclared: name the gap and the one-line fix, never
/// silently fall through (the legibility ethos applied to the policy boundary).
pub(super) fn undeclared_external(typed: &str, path: &str) -> crate::Error {
  crate::Error::Other(anyhow::anyhow!(
    "«{typed}» exists at {path}, but external execution is not declared — add (exec.path) to your rc"
  ))
}

fn syntax_host_error(e: SyntaxError) -> LispHostError {
  match e {
    // The lexer already supplied the diagnostic; Debug would quote its text
    // and double the backslashes in the suggested spelling.
    SyntaxError::InvalidStringEscape { message, .. } => LispHostError::Parse(message),
    SyntaxError::InvalidComment { message, loc } | SyntaxError::TooDeep { message, loc } => {
      LispHostError::Parse(format!("{message} (line {})", loc.linecol.0))
    }
    other => LispHostError::Parse(format!("{other}")),
  }
}

/// One seed failure's message: `warning: prelude `FILE` line N: …` when the
/// origin names the line's file, else the seed's own line number.
fn seed_failure(origin: &[crate::SeedLine], line: Option<usize>, error: &str) -> String {
  let at = line.and_then(|line| line.checked_sub(1).and_then(|i| origin.get(i)).map(|o| (o, line)));
  match (at, line) {
    (Some((o, _)), _) => format!("warning: prelude `{}` line {}: {error}", o.file, o.line),
    (None, Some(line)) => format!("warning: prelude seed line {line}: {error}"),
    (None, None) => match origin.first() {
      Some(o) => format!("warning: prelude `{}`: {error}", o.file),
      None => format!("warning: prelude seed: {error}"),
    },
  }
}

/// Write each seed failure to stderr the first time this process sees it:
/// every host built in a process evaluates the same seed, and one broken form
/// is one message.
fn report_seed_failures(failures: &[String]) {
  static REPORTED: std::sync::Mutex<Option<HashSet<String>>> = std::sync::Mutex::new(None);
  let mut reported = REPORTED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let reported = reported.get_or_insert_with(HashSet::new);
  for failure in failures {
    if reported.insert(failure.clone()) {
      eprintln!("{failure}");
    }
  }
}

/// The seed line each of the `count` top-level forms of `source` starts on,
/// read chunk by chunk the way a script is; `None` if the chunks do not
/// account for exactly those forms.
fn seed_form_lines(
  source: &str,
  count: usize,
  interner: &mut string_interner::StringInterner<StringBackend>,
) -> Option<Vec<usize>> {
  let mut lines = Vec::with_capacity(count);
  for (line, chunk) in super::runner::coalesce_balanced_lines(source) {
    let forms = tento_lisp::Runtime::<Sym, StringBackend>::parse(None, &chunk, interner).ok()?;
    lines.extend(std::iter::repeat_n(line, forms.len()));
  }
  (lines.len() == count).then_some(lines)
}

fn runtime_host_error(e: RuntimeError) -> LispHostError {
  // A command's own failure keeps its self-identifying text and drops the
  // `lisp error:` label — the origin rides the error, chosen by the command
  // dispatch layer (see `register_command_native` / `drive_command`), not by
  // inspecting the message.
  if let RuntimeError::Command { detail } = e {
    return LispHostError::Command(detail);
  }
  if let RuntimeError::Exit { status, detail } = e {
    return LispHostError::Exit { status, message: detail };
  }
  if let RuntimeError::Reported(failure) = e {
    return LispHostError::Reported(failure);
  }
  let text = match &e {
    RuntimeError::UndefinedSymbol { detail } => {
      format!("{e} — bare words are references; quote \"{detail}\" for a string")
    }
    _ => e.to_string(),
  };
  // Preserve the soft/hard split across the host boundary: a hard error becomes
  // `Fatal` so the `WarnContinue` runner halts on it (`unwrap`/`expect`, blown budget).
  // `UndefinedSymbol` is soft, so the enriched teaching text still rides the
  // `Runtime` variant untouched.
  if e.is_hard() {
    LispHostError::Fatal(text)
  } else {
    LispHostError::Runtime(text)
  }
}

/// Map a native's returned [`LispHostError`] onto a [`RuntimeError`] at the
/// env-native boundary (the `register_native_*` wrappers). Two live-tested
/// rules:
/// (a) build from the error's INNER message — re-wrapping the `Display`
///     stuttered (`lane.ref: lisp error: lane.ref: …`) — and only prepend
///     `{name}: ` when the text doesn't already self-identify;
/// (b) preserve severity: a native's `Fatal` maps to `RuntimeError::Fatal`
///     (hard), never flattening to a soft `Other`.
fn native_runtime_error(name: &str, e: LispHostError) -> RuntimeError {
  // The status rides unchanged; an empty message stays empty (the child
  // already spoke).
  if let LispHostError::Exit { status, message } = e {
    return RuntimeError::Exit { status, detail: message };
  }
  // A reported failure keeps its fields; its message is named like any
  // other native's.
  if let LispHostError::Reported(mut failure) = e {
    if !failure.message.starts_with(&format!("{name}:")) {
      failure.message = format!("{name}: {}", failure.message);
    }
    return RuntimeError::Reported(failure);
  }
  let (hard, command, inner) = match e {
    LispHostError::Fatal(inner) => (true, false, inner),
    LispHostError::Command(inner) => (false, true, inner),
    LispHostError::Runtime(inner) => (false, false, inner),
    other => (false, false, other.to_string()),
  };
  let detail = if inner.starts_with(&format!("{name}:")) {
    inner
  } else {
    format!("{name}: {inner}")
  };
  if hard {
    RuntimeError::Fatal { detail }
  } else if command {
    RuntimeError::Command { detail }
  } else {
    RuntimeError::Other(detail)
  }
}

/// A bundle UI script queued by `(@import …)` for evaluation in the gated
/// registration context (F11). The runner drains the queue between lines via
/// [`LispHost::process_pending_ui`].
#[derive(Debug, Clone)]
pub struct PendingUiScript {
  /// The import-site namespace (`:as` value) the contributions register under.
  pub namespace: String,
  pub script: PathBuf,
}

/// The product-neutral result of resolving an `(@import "name" :as "ns")`: the
/// dotted command symbols to mount into the env, plus any UI scripts to queue
/// for the gated registration eval. The generic [`LispHost`] owns the
/// registration guard, the env mutation, and the `pending_ui` queue; an
/// [`ImportResolver`] owns only *where bundles come from and how their commands
/// dispatch*.
pub struct ImportMounts {
  /// `(<namespace>.<command>, native-closure)` pairs; the interpreter interns
  /// the string keys and defines them in the env. Every command gets one (the
  /// sync env path for nested/in-process calls); a daemon command's sync native
  /// errors "run it as a shell line" (it can't be awaited on the sync engine).
  pub mounts: Vec<(String, LispValue<Sym>)>,
  /// `(<namespace>.<command>, async-dispatcher)` pairs for the commands whose
  /// transport is genuinely async (a session/daemon bundle command): registered
  /// into the host's async table + async-mount set so the top-level await door
  /// ([`LispHost::eval_posix_line_async`]) drives — and leases — them, exactly
  /// as a registry subcommand group's daemon transport is. Empty for a purely
  /// oneshot/streaming bundle.
  pub async_mounts: Vec<(String, AsyncDispatch)>,
  /// Bundle UI scripts to queue under the import namespace for the F11 eval.
  pub ui_scripts: Vec<PathBuf>,
  /// Bundle rc scripts (`rc/*.tshrc`, sorted): a single `(bundle (m) …)` form,
  /// or a module body only at the resolver-declared manifest entrypoint.
  /// Evaluated at import with exports under the alias.
  pub rc_scripts: Vec<PathBuf>,
}

/// A bundle rc script queued by `(@import …)` for [`LispHost::process_pending_rc`].
struct PendingRcScript {
  namespace: String,
  script: PathBuf,
}

// Accept old resolver string entries as well as owner/package-aware entries.
fn requirement_binding(
  entry: &LispValue<Sym>,
  alias: &str,
) -> Result<(String, String, bool), RuntimeError> {
  match entry {
    LispValue::String(namespace) => Ok((namespace.to_string(), alias.into(), false)),
    LispValue::Map(fields) => match (
      fields.get("namespace"),
      fields.get("package"),
      fields.get("optional"),
    ) {
      (
        Some(LispValue::String(namespace)),
        Some(LispValue::String(package)),
        Some(LispValue::Boolean(optional)),
      ) => Ok((namespace.to_string(), package.to_string(), *optional)),
      _ => Err(RuntimeError::Other(format!(
        "invalid resolved dependency metadata for {alias}"
      ))),
    },
    _ => Err(RuntimeError::Other(format!(
      "invalid resolved dependency metadata for {alias}"
    ))),
  }
}

/// Resolves an `(@import "name" :as "ns")` to mountable commands. This is the
/// seam between the generic command host and the `.tsh.app` bundle layer: the
/// host calls `resolve`, then mounts the result and queues its UI scripts, so it
/// carries no bundle-format dependency itself (the `.tsh.app` transport lives
/// behind this trait — see [`TshAppResolver`]). `registration` is the host's
/// gated-context cell, threaded into each mounted command closure so it refuses
/// to spawn while a `ui/*.tsh` registration script is evaluating.
pub trait ImportResolver {
  /// Private, already-installed dependencies in parent-before-child order.
  /// Resolution validates the whole graph before the host installs any mounts.
  fn resolve_dependencies(
    &self,
    _name: &str,
    _namespace: &str,
    _from: Option<&str>,
    _registration: Rc<RefCell<Option<String>>>,
  ) -> Result<Vec<(String, ImportMounts)>, RuntimeError> {
    Ok(Vec::new())
  }

  fn resolve(
    &self,
    name: &str,
    namespace: &str,
    from: Option<&str>,
    registration: Rc<RefCell<Option<String>>>,
  ) -> Result<ImportMounts, RuntimeError>;

  /// The host has admitted this import's entire namespace graph and installed
  /// its command tables. Resolution alone can still be rejected by admission;
  /// wrappers must forward this notification before recording a mounted import.
  /// A lazy import notifies only when its mounts are actually resolved.
  fn admitted(&self, _name: &str, _namespace: &str, _from: Option<&str>) {}

  /// Whether `name` may be mounted LAZILY — recorded at `(@import …)` time and
  /// resolved on the first reference to `<namespace>.<anything>` instead. Only
  /// a bundle whose mount has no side effects qualifies (no `rc/*.tshrc`, no
  /// `ui/*.tsh` to run at import time); the resolver decides from the bundle
  /// on disk without parsing its manifest. Default: never — a host opts in
  /// with [`LispHost::enable_lazy_imports`], and only a detached one should.
  fn lazy_eligible(&self, _name: &str, _from: Option<&str>) -> bool {
    false
  }
}

/// The no-bundle resolver: a host built with no `.tsh.app` search path. Every
/// `(@import …)` fails with a clear error. `LispHost::new()` uses it; bundle-aware
/// hosts get a `TshAppResolver` via the bundle layer's `lisp_host_with_apps`.
pub struct NoApps;

impl ImportResolver for NoApps {
  fn resolve(
    &self,
    name: &str,
    _namespace: &str,
    _from: Option<&str>,
    _registration: Rc<RefCell<Option<String>>>,
  ) -> Result<ImportMounts, RuntimeError> {
    Err(RuntimeError::Other(format!(
      "@import {name}: no .tsh.app search path on this host"
    )))
  }
}

/// The boxed result future an async command yields (resolved at the top level).
/// Public so a bundle layer (`@import` daemon mounts) can build a dispatcher of
/// the same shape as [`LispHost::register_commands`]'s.
pub type AsyncCommandFut =
  std::pin::Pin<Box<dyn std::future::Future<Output = crate::Result<JsonValue>>>>;

/// What an [`ExternalCommands`] hook knows about a bare head that resolved
/// nowhere else.
pub enum ExternalLookup {
  /// The head names a runnable external program — [`ExternalCommands::run`]
  /// takes the raw argv.
  Runs,
  /// The head exists as a program at this path, but external execution has
  /// not been declared (ring-1 policy off). Surfaces as a teaching error,
  /// never a silent fallback.
  Undeclared(String),
  /// Not an external program either — fall through to `CommandNotFound`.
  NotFound,
}

/// The external-program seam — "a small core that finds and runs programs".
///
/// Core ships only this hook; whether bare words reach a PATH is ring-1
/// policy (the host installs an implementation, the rc's `(exec.path)`
/// enables it). Consulted at the `UndefinedSymbol`-head fallback of the async
/// eval doors, AFTER bindings/builtins (a `def` always wins) and BEFORE
/// `CommandNotFound` — an external binary is a command in every sense, so it
/// also shadows composer scene takeover (a scene never shadows a command).
pub trait ExternalCommands {
  fn lookup(&self, head: &str) -> ExternalLookup;
  /// Run the raw argv (head at `[0]`, words verbatim — flags never pass the
  /// `#[command]` arg layer, so no `--` is needed anywhere). The returned
  /// value settles the statement.
  fn run(&self, argv: Vec<String>) -> AsyncCommandFut;
  /// Redirect stdout and connect consecutive children with OS pipes. Admission
  /// has already checked every head; status belongs to the final child.
  fn run_pipeline(
    &self,
    _argv: Vec<Vec<String>>,
    _input: Option<Vec<u8>>,
    _capture: bool,
  ) -> super::PipelineFuture {
    Box::pin(async {
      Err(crate::Error::Other(anyhow::anyhow!(
        "external host does not support pipeline I/O"
      )))
    })
  }
  fn run_pipeline_with_io(
    &self,
    argv: Vec<Vec<String>>,
    input: Option<Vec<u8>>,
    capture: bool,
    io: Vec<Option<super::ShellIo>>,
  ) -> super::PipelineFuture {
    if io.iter().all(Option::is_none) {
      self.run_pipeline(argv, input, capture)
    } else {
      Box::pin(async { Err(crate::Error::Other(anyhow::anyhow!("external host does not support descriptor I/O"))) })
    }
  }
  /// Start an admitted OS job; the returned pid is also accepted by wait.
  fn start_background(&self, _argv: Vec<String>, _io: Option<super::ShellIo>, _capture: bool) -> crate::Result<super::ShellJob> {
    Err(crate::Error::Other(anyhow::anyhow!("background jobs: not supported by this external host")))
  }
  /// Start admitted stages as one foreground job at the terminal an
  /// interactive shell owns (job control: their own process group, handed
  /// the terminal; see [`super::start_process_foreground`]). `None`: this
  /// host has no such door (a session engine hosts its terminals itself), and
  /// the pipeline door runs the stages instead.
  fn start_foreground(
    &self,
    _argv: Vec<Vec<String>>,
    _io: Vec<Option<super::ShellIo>>,
  ) -> Option<crate::Result<super::ShellJob>> {
    None
  }
  /// A nearest-match suggestion over the external name index, for
  /// `CommandNotFound` upgrades.
  fn suggest(&self, typed: &str) -> Option<String>;
  /// An unavailable head exists but cannot be executed (shell status 126).
  /// Kept separate from lookup so existing hosts retain their admission policy.
  fn not_executable(&self, _head: &str) -> bool {
    false
  }
  /// The embedding host parked this line and will replay after it settles.
  fn suspended(&self) -> bool {
    false
  }
  /// Collect one line for `read` from the terminal the interactive prompt
  /// draws on, when that terminal is not this process's descriptor 0 (a
  /// session engine's viewer collects it). `None`: this host has no such
  /// door, and `read` reads descriptor 0 as before.
  fn read_terminal(&self, _request: &super::TerminalRead) -> Option<super::TerminalLine> {
    None
  }
  /// Run the raw argv to completion without awaiting: the bridge for a program
  /// called from inside a Lisp expression (argv.md I13), where the evaluator
  /// cannot await. `None`: this host runs programs only on its async doors, so
  /// such a call is refused loudly.
  fn run_blocking(&self, _argv: Vec<String>) -> Option<crate::Result<JsonValue>> {
    None
  }
}
/// A type-erased async command dispatcher: full argv (name at `[0]`) -> result
/// future. Built by [`LispHost::register_commands`] alongside the sync env
/// natives; consulted by [`LispHost::eval_posix_argv_async`] /
/// [`LispHost::eval_posix_line_async`] so a genuinely-async daemon/streaming
/// command is awaited, not `now_or_never`-driven. Also carried by
/// [`ImportMounts::async_mounts`] so a `@import`ed session/daemon bundle command
/// leases through the same top-level await door.
pub type AsyncDispatch = Rc<dyn Fn(Vec<String>) -> crate::Result<AsyncCommandFut>>;

/// `LispHost` owns the persistent lisp `Interpreter`/`Env` plus a
/// host-side bind table for command results. See module docs for the
/// resolution order.
/// See [`LispHost::set_env_write_gate`].
type EnvWriteGate = Rc<RefCell<Option<Rc<dyn Fn() -> Result<(), String>>>>>;

/// A native's way to say it is deprecated: a call records its own name and
/// the spelling that replaces it ([`DeprecationNotes::note`]), and the host warns once
/// per site exactly as it does for a deprecated alias. A native that keeps
/// its old behaviour for one release clones this handle into its closure
/// ([`LispHost::deprecation_notes`]).
#[derive(Clone, Default)]
pub struct DeprecationNotes(Rc<RefCell<Vec<tento_lisp::Deprecation>>>);

impl DeprecationNotes {
  /// Record that `old` was called where `new` is the spelling now.
  pub fn note(&self, old: &str, new: &str) {
    let mut notes = self.0.borrow_mut();
    if !notes.iter().any(|d| d.old == old) {
      notes.push(tento_lisp::Deprecation { old: old.to_string(), new: new.to_string() });
    }
  }

  fn take(&self) -> Vec<tento_lisp::Deprecation> {
    std::mem::take(&mut self.0.borrow_mut())
  }
}

thread_local! {
  /// One hand-off frame per source statement this thread is evaluating
  /// ([`StatementInFlight`]), innermost last, each holding what child hosts
  /// dropped during it left undrained ([`LispHost::hand_off_deprecations`]).
  /// The rules:
  ///
  /// - a statement pushes its frame when it starts and removes it when it
  ///   ends, by id, so runner futures that interleave on one thread keep
  ///   their own frames;
  /// - a dropped child hands its notes to the innermost frame, the
  ///   statement running when it was dropped;
  /// - a runner drains only its own frame, warning at its own site, so a
  ///   nested runner never takes what an enclosing statement's children left;
  /// - a frame that ends undrained (an early exit, an error, a cancelled
  ///   future) passes its notes to the frame enclosing it, and with none,
  ///   to the unsited report;
  /// - with no frame at all (a `std.script.spawn` job's thread), a child's
  ///   notes are the unsited report: each spelling once per process.
  static FRAMES: RefCell<Vec<(u64, Vec<tento_lisp::Deprecation>)>> = const { RefCell::new(Vec::new()) };
  /// The id the next frame on this thread takes.
  static NEXT_FRAME: Cell<u64> = const { Cell::new(0) };
}

/// The spellings the unsited report has warned about, each once per process.
static UNSITED_WARNED: std::sync::Mutex<std::collections::BTreeSet<String>> =
  std::sync::Mutex::new(std::collections::BTreeSet::new());

/// Report `pending` with no site, each spelling once per process.
fn report_unsited(pending: Vec<tento_lisp::Deprecation>, mut report: impl FnMut(String)) {
  for deprecation in pending {
    if UNSITED_WARNED.lock().map_or(true, |mut warned| warned.insert(deprecation.old.clone())) {
      report(format!("tsh: {}", deprecation.message()));
    }
  }
}

/// Add `pending` to `frame`, each spelling once.
fn merge_into(frame: &mut Vec<tento_lisp::Deprecation>, pending: Vec<tento_lisp::Deprecation>) {
  for deprecation in pending {
    if !frame.contains(&deprecation) {
      frame.push(deprecation);
    }
  }
}

/// One source statement's hand-off frame (see `FRAMES`), held while the
/// runner evaluates the statement and reports its deprecations.
pub(super) struct StatementInFlight(u64);

impl StatementInFlight {
  pub(super) fn enter() -> Self {
    let id = NEXT_FRAME.with(|next| {
      let id = next.get();
      next.set(id + 1);
      id
    });
    FRAMES.with(|frames| frames.borrow_mut().push((id, Vec::new())));
    StatementInFlight(id)
  }

  /// What children dropped during this statement handed off, taken.
  pub(super) fn take(&self) -> Vec<tento_lisp::Deprecation> {
    FRAMES.with(|frames| {
      let mut frames = frames.borrow_mut();
      frames.iter_mut().find(|(id, _)| *id == self.0).map(|(_, notes)| std::mem::take(notes)).unwrap_or_default()
    })
  }
}

impl Drop for StatementInFlight {
  fn drop(&mut self) {
    let left = FRAMES.try_with(|frames| {
      let mut frames = frames.borrow_mut();
      let at = frames.iter().position(|(id, _)| *id == self.0)?;
      let (_, notes) = frames.remove(at);
      match at.checked_sub(1).and_then(|outer| frames.get_mut(outer)) {
        Some((_, enclosing)) => {
          merge_into(enclosing, notes);
          None
        }
        None => Some(notes),
      }
    });
    if let Ok(Some(notes)) = left {
      report_unsited(notes, |line| eprintln!("{line}"));
    }
  }
}

pub struct LispHost {
  stream_capability: Option<Rc<dyn Fn(bool)>>,
  resources: tento_lisp::resource::ResourceScope,
  types_sealed: bool,
  core_types: Rc<RefCell<HashSet<String>>>,
  #[cfg(test)]
  posix_reads: usize,
  pub(super) interp: Interpreter<Sym, StringBackend>,
  pub(super) env: Rc<RefCell<Env<Sym>>>,
  binds: HashMap<String, HostValue>,
  /// `Some(namespace)` while a bundle's `ui/*.tsh` evaluates — the F11 gated
  /// registration context. Effect chokepoints (the command mounts, `@import`
  /// itself) check it and refuse; define-only natives (a host's `defmode`/
  /// `bind-key`) read it to stage contributions inert instead of applying them.
  registration: Rc<RefCell<Option<String>>>,
  /// UI scripts queued by `(@import …)`, drained by the runner between lines
  /// (the import handler runs *inside* an eval, so the script can't be
  /// re-entrantly evaluated at queue time).
  pending_ui: Rc<RefCell<Vec<PendingUiScript>>>,
  /// Bundle rc scripts queued by `(@import …)`, drained between lines by
  /// [`Self::process_pending_rc`] — same discipline as `pending_ui`.
  pending_rc: Rc<RefCell<Vec<PendingRcScript>>>,
  rc_evaluating: Rc<RefCell<Option<String>>>,
  /// Bundle rc scripts already loaded, by canonical path → their exported
  /// (name, value) pairs. ES-module semantics: EVALUATED once; a later import
  /// of the same file under another alias re-mounts the cached exports
  /// without re-running the body.
  rc_loaded: HashMap<PathBuf, Vec<(String, LispValue<Sym>)>>,
  /// Whether this host evaluates queued ui scripts (the session UI layer is
  /// wired — see [`Self::enable_import_ui`]). Plain script/CLI hosts skip them.
  ui_enabled: bool,
  /// Per-command async dispatchers keyed by canonical name — the top-level
  /// await path ([`Self::eval_posix_argv_async`]). Populated by
  /// [`Self::register_commands`]; empty until then. Shared (`Rc<RefCell>`) so a
  /// runtime `(@import …)` handler can register a session/daemon bundle
  /// command's dispatcher LIVE, mid-unit — the command call is a later line.
  async_commands: Rc<RefCell<HashMap<String, AsyncDispatch>>>,
  /// The subset of async command names that MUST be driven through the async
  /// door because their transport is genuinely async (a session/daemon
  /// `@import` mount): the sync script runner routes a line whose head is here
  /// to [`Self::eval_posix_line_async`] instead of the sync env path (which
  /// would `now_or_never` the daemon future into a "run it as a shell line"
  /// error). Populated by the `@import` handler / [`Self::mount`].
  pub(super) async_mount_names: Rc<RefCell<HashSet<String>>>,
  /// `(@import …)`s recorded instead of mounted, by namespace — see
  /// [`ImportResolver::lazy_eligible`]. Drained by `lazy_mounter` on the first
  /// reference to the namespace, from the interpreter's missing-symbol hook
  /// (nested Lisp) or the shell-line dispatch (a daemon command's head).
  lazy_imports: Rc<RefCell<HashMap<String, LazyImport>>>,
  lazy_enabled: Rc<std::cell::Cell<bool>>,
  lazy_mounter: Rc<dyn Fn(&str) -> Option<Vec<(String, LispValue<Sym>)>>>,
  /// Sorted dispatchable command names, for the structured `CommandNotFound`
  /// (nearest-match + available list) built for an unknown command.
  pub(super) command_names: Vec<String>,
  /// The subcommand groups [`Self::register_commands`] registered under a
  /// bare word: in tsh, the rc's `(@import … :as NS)` word mounts. A mount is
  /// a Lisp name (`NS.export`), so bash lookup lets a `PATH` program of the
  /// same name answer first (see [`Self::mount_yields_to_program`]).
  pub(super) subcommand_groups: HashSet<String>,
  pub(super) command_natives: CommandNatives,
  /// Names of app/scene natives registered via [`Self::register_native_closure`]
  /// / [`Self::register_native_special`] — the completion surface for a prompt
  /// (`native_names`). Excludes the base lisp primitives (car/cdr/+/…), which
  /// aren't registered through those methods, so this lists only the command
  /// vocabulary a user would type.
  pub(super) native_defs: Vec<String>,
  /// The deprecated spellings and their replacements, shared with the
  /// `help` native so `(help "old.name")` answers the new name's document
  /// for the release the old spelling still resolves.
  deprecated_aliases: Rc<RefCell<Vec<(String, String)>>>,
  /// What deprecated natives recorded since the last drain
  /// ([`Self::deprecation_notes`]).
  native_deprecations: DeprecationNotes,
  /// Set by [`Self::hand_off_deprecations`]: what this host never drained
  /// is reported when it is dropped.
  hand_off_deprecations: bool,
  /// Name index for host-native binding lookup; extended after each parse.
  pub(super) shell_symbols: Rc<RefCell<HashMap<String, Sym>>>,
  /// bash's directory stack below the current directory, top last.
  pub(super) shell_dir_stack: Vec<String>,
  /// The external-program hook (None = this host never runs externals). See
  /// [`ExternalCommands`]; installed by the embedding shell, enabled by rc
  /// policy inside the implementation.
  pub(super) external: Option<Rc<dyn ExternalCommands>>,
  pub(super) shell_prompt: bool,
  pub(super) shell_aliases: HashMap<String, String>,
  pub(super) shell_command_admission: Option<super::ShellCommandAdmission>,
  pub(super) shell_builtin: Option<super::ShellBuiltin>,
  pub(super) shell_builtin_cache: Option<(usize, Vec<super::ShellBuiltinOutput>)>,
  pub(super) shell_builtin_gate: Option<Rc<dyn Fn(&str) -> crate::Result<()>>>,
  pub(super) shell_byte_output: Option<Rc<dyn Fn(&[u8])>>,
  pub(super) shell_stderr_output: Option<Rc<dyn Fn(&[u8])>>,
  pub(super) shell_failure_display: Rc<std::cell::Cell<super::ShellFailureDisplay>>,
  pub(super) shell_stdin: Rc<RefCell<Option<Vec<u8>>>>,
  pub(super) shell_io: Rc<RefCell<Option<super::ShellIo>>>,
  pub(super) shell_output: Rc<RefCell<super::bash_flow::FlowOutput>>,
  pub(super) shell_files: Rc<RefCell<(i64, HashMap<i64, std::sync::Arc<std::fs::File>>)>>,
  pub(super) shell_redirect_cache: Option<(usize, Vec<super::shell_redirect::PreparedRedirect>)>,
  pub(super) shell_write_cache: Option<(usize, Vec<Result<(), String>>)>,
  shell_stdin_reads: Rc<RefCell<Option<(usize, Vec<String>)>>>,
  pub(super) shell_formatter: Option<super::ShellFormatter>,
  pub(super) command_json: Rc<Cell<bool>>,
  /// The file-backed source this host is currently evaluating, if any — read
  /// by the `(std.script.path)` / `(std.script.dir)` natives. Set from
  /// [`crate::script::RunOptions::source_path`] by the runners (file scripts,
  /// per-unit reset on the control-plane host) and by the internal
  /// `(std.script.source "PATH")` context form (how a queued startup unit —
  /// which travels as plain content — carries its rc file's path). `None` for
  /// pathless sources (piped stdin, one-shot lines): the natives return nil.
  script_path: Rc<RefCell<Option<PathBuf>>>,
  /// Checked before every env write (`env.set`, `env.default`,
  /// `env.from-file`, `env.from-json`): an embedder that must refuse writes
  /// in some context (tsh while a prompt renders) installs it once with
  /// [`Self::set_env_write_gate`] instead of re-registering each writer.
  env_write_gate: EnvWriteGate,
  /// Positional arguments belonging to the currently invoked command, stdin,
  /// or file source. Startup and source share one host, so the embedding shell
  /// sets this once before startup and `(std.script.args)` reads it as data.
  script_args: Rc<RefCell<Vec<String>>>,
  /// Bash-line state belongs to this host and survives interactive units.
  shell_status: Rc<std::cell::Cell<i32>>,
  pub(super) shell_errexit: bool,
  pub(super) shell_compound: super::bash_compound::CompoundState,
  shell_unit: Option<(i64, i32, bool)>,
  /// Counts every status write, so a caller can tell whether a unit ran a
  /// Bash line at all (the status itself survives between units).
  shell_status_writes: u64,
  /// Whether the last statement was a Bash line (a Lisp statement clears it).
  shell_last_statement_bash: bool,
  /// `Some` while an embedder collects Bash diagnostics instead of letting
  /// them reach this process's stderr (the session daemon's stderr is a log).
  pub(super) shell_diagnostics: Option<Vec<String>>,
  /// Sources (`None` for the session) already warned that a single-`;`
  /// comment is deprecated, so each warns once (I10 transition).
  semicolon_comment_warned: std::collections::HashSet<Option<std::path::PathBuf>>,
  /// Deprecated spellings already warned, per site: (source, line, old).
  deprecation_warned: std::collections::HashSet<(Option<std::path::PathBuf>, usize, String)>,
  /// What a command called from inside a Lisp expression can reach (I13).
  pub(super) nested_commands: Rc<RefCell<super::shell_cmd::NestedCommands>>,
  /// Names a `use` bound (`(use std.fs.(read_dir))`, `(use std.text.highlight
  /// as: highlight)`): Lisp names only, never command words or prompt
  /// declarations, even when the value is a command. A later `let` of the
  /// same name takes it out again.
  pub(super) use_lisp_names: Rc<RefCell<HashSet<String>>>,
  /// Where each root name was last bound: "the prelude" while the seed
  /// evaluates, else the script file, else "this session". `type NAME` at
  /// the prompt names it for a declaration.
  pub(super) binding_places: Rc<RefCell<HashMap<String, String>>>,
  /// Set while the prelude seed evaluates.
  seeding: Rc<Cell<bool>>,
  /// Every failure the last prelude seed evaluation on this host reported
  /// ([`Self::eval_seed`]), so an embedder can refuse to run a program
  /// whose named prelude did not load ([`Self::prelude_failures`]).
  prelude_failures: Vec<String>,
  /// Who owns each name in tsh's command namespace besides `std.*` and the
  /// registry: a prelude name or a bundle the rc mounted. An `@import …
  /// :as NAME` never takes a name someone owns (operator ruling, 2026-10-04).
  command_owners: CommandOwners,
}

/// An `(@import …)` recorded for lazy mounting — see [`ImportResolver::lazy_eligible`].
#[derive(Clone)]
struct LazyImport {
  name: String,
  from: Option<String>,
}

impl LispHost {
  fn define_host_binding(&mut self, symbol: Sym, value: LispValue<Sym>) {
    self.interp.define_source_binding(symbol, value.clone());
    self.env.borrow_mut().define(symbol, value);
  }

  pub(super) fn detach_shell_worker_io(&mut self) {
    self.shell_byte_output = None;
    self.shell_stderr_output = None;
    self.shell_diagnostics = None;
    self.shell_write_cache = None;
    self.shell_builtin_cache = None;
    self.shell_redirect_cache = None;
    *self.shell_output.borrow_mut() = super::bash_flow::FlowOutput::default();
  }

  /// Let script-free bundles mount on first reference instead of at their
  /// `(@import …)` line. For a DETACHED host only: a session keeps eager
  /// imports so completion sees every command and bundle scripts keep their
  /// order. Before this, a one-shot `tsh <cmd>` mounted every bundle its rc
  /// imports — seven in the stock rc — to run a command that touched none.
  pub fn enable_lazy_imports(&mut self) {
    self.lazy_enabled.set(true);
  }

  /// Mount a lazily recorded namespace now (a shell line whose head is
  /// `<namespace>.<cmd>` needs its async table entry before dispatch). No-op
  /// when nothing is recorded under it.
  fn mount_lazy_namespace(&mut self, namespace: &str) -> bool {
    if !self.lazy_imports.borrow().contains_key(namespace) {
      return false;
    }
    let Some(mounts) = (self.lazy_mounter)(namespace) else {
      return false;
    };
    let root = tento_lisp::Env::root_of(&self.env);
    for (symbol, value) in mounts {
      let sym = self.interp.string_interner().get_or_intern(&symbol);
      self.interp.define_source_binding(sym, value.clone());
      root.borrow_mut().define(sym, value);
    }
    true
  }

  /// Host-local opaque resources; teardown revokes all escaped aliases.
  pub fn resource_scope(&self) -> tento_lisp::resource::ResourceScope {
    self.resources.clone()
  }

  /// Construct a host with no `.tsh.app` search path: every `(@import …)` fails.
  /// The bundle layer's `lisp_host_with_apps` builds a bundle-aware host instead.
  pub fn new() -> Self {
    Self::with_resolver(Rc::new(NoApps))
  }

  /// Construct a host whose `(@import …)` resolves through `resolver`. The host
  /// owns the generic half: it refuses imports during a ui registration script,
  /// queues the resolved UI scripts, and lets the interpreter intern + define
  /// the returned mounts. The resolver owns where bundles come from and how
  /// their commands dispatch (the `.tsh.app` transport stays behind the trait).
  pub fn with_resolver(resolver: Rc<dyn ImportResolver>) -> Self {
    super::stack::install();
    let mut interp = Interpreter::<Sym, StringBackend>::new();
    let env = interp.default_env();
    register_natives(&mut env.borrow_mut(), interp.string_interner());
    let source_root = interp.default_env();
    register_natives(&mut source_root.borrow_mut(), interp.string_interner());
    interp.set_source_root(source_root);
    let command_json = Rc::new(Cell::new(false));
    let command_natives: CommandNatives = Rc::new(RefCell::new(HashMap::new()));
    let registration: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    let pending_ui: Rc<RefCell<Vec<PendingUiScript>>> = Rc::new(RefCell::new(Vec::new()));
    let pending_rc: Rc<RefCell<Vec<PendingRcScript>>> = Rc::new(RefCell::new(Vec::new()));
    let rc_evaluating: Rc<RefCell<Option<String>>> = Rc::default();
    let handler_rc = rc_evaluating.clone();
    let async_commands: Rc<RefCell<HashMap<String, AsyncDispatch>>> =
      Rc::new(RefCell::new(HashMap::new()));
    let async_mount_names: Rc<RefCell<HashSet<String>>> = Rc::new(RefCell::new(HashSet::new()));
    let handler_registration = registration.clone();
    let handler_pending = pending_ui.clone();
    let handler_pending_rc = pending_rc.clone();
    let handler_async = async_commands.clone();
    let handler_async_names = async_mount_names.clone();
    let handler_json = command_json.clone();
    let handler_natives = command_natives.clone();
    let handler_env = env.clone();
    let command_owners: CommandOwners = Rc::default();
    let handler_owners = command_owners.clone();
    let lazy_imports: Rc<RefCell<HashMap<String, LazyImport>>> =
      Rc::new(RefCell::new(HashMap::new()));
    let lazy_enabled = Rc::new(std::cell::Cell::new(false));
    let handler_lazy = lazy_imports.clone();
    let handler_lazy_enabled = lazy_enabled.clone();
    let handler_resolver = resolver.clone();
    let handler: ImportHandler<Sym> =
      Rc::new(move |name: &str, namespace: &str, from: Option<&str>| {
        if let Some(ns) = handler_rc.borrow().as_deref() {
          return Err(RuntimeError::Fatal { detail: format!(
            "@import {name}: not allowed inside bundle `{ns}`'s rc; declare dependencies in the manifest and use their aliases (legacy: m.require)"
          ) });
        }
        // A registration script defines UI; it must not mount further bundles.
        if let Some(ns) = handler_registration.borrow().as_deref() {
          return Err(RuntimeError::Other(format!(
            "@import {name}: not allowed inside `{ns}`'s ui registration script"
          )));
        }
        // Names in tsh's command namespace are never shadowed: the existing
        // owner keeps the name, and the rc loader reports this line.
        // An existing bundle owner is checked against the RESOLVED module's
        // identity below: the lookup/folder name need not be its manifest name.
        // Unowned natives and non-bundle names remain immediate refusals.
        if !handler_owners.borrow().get(namespace).is_some_and(|owner| owner.starts_with("bundle ")) {
          if let Some(refusal) = import_collision(name, namespace, &handler_owners.borrow(), &handler_natives.borrow()) {
            return Err(RuntimeError::Other(refusal));
          }
        }
        let dependencies = handler_resolver.resolve_dependencies(name, namespace, from, handler_registration.clone())?;
        if dependencies.is_empty() && handler_lazy_enabled.get()
          && !handler_owners.borrow().contains_key(namespace)
          && handler_resolver.lazy_eligible(name, from) {
          // Record it; the first `<namespace>.<x>` reference mounts it. A
          // later eager import of the same namespace simply replaces the
          // record's mounts when it defines them (last-wins, as today).
          handler_lazy.borrow_mut().insert(
            namespace.to_string(),
            LazyImport {
              name: name.to_string(),
              from: from.map(str::to_string),
            },
          );
          handler_owners.borrow_mut().insert(namespace.to_string(), format!("bundle {name}"));
          return Ok(Vec::new());
        }
        let resolved =
          handler_resolver.resolve(name, namespace, from, handler_registration.clone())?;
        let mut imports = vec![(namespace.to_string(), resolved)];
        imports.extend(dependencies);
        // Admit the entire graph before reserving names or installing any
        // commands/scripts. A private alias is owned by the dependency's
        // bundle identity, not by the parent's namespace prefix.
        let mut owners = handler_owners.borrow().clone();
        for (index, (namespace, resolved)) in imports.iter().enumerate() {
          let bundle = resolved.mounts.iter().find_map(|(symbol, value)| {
            if symbol != namespace { return None; }
            match value {
              LispValue::Module(module) => module.bundle_name.as_deref(),
              _ => None,
            }
          }).or_else(|| (index == 0).then_some(name)).ok_or_else(|| {
            RuntimeError::Other(format!("@import {name}: dependency `{namespace}` has no bundle identity"))
          })?;
          if let Some(refusal) = import_collision(bundle, namespace, &owners, &handler_natives.borrow()) {
            return Err(RuntimeError::Other(refusal));
          }
          owners.insert(namespace.clone(), format!("bundle {bundle}"));
        }
        *handler_owners.borrow_mut() = owners;
        let mut all_mounts = Vec::new();
        for (namespace, resolved) in imports {
        // Queue the bundle's ui/*.tsh for the gated registration eval (F11). The
        // handler runs inside an eval, so the runner drains the queue between
        // lines rather than re-entering the interpreter here.
        handler_pending
          .borrow_mut()
          .extend(
            resolved
              .ui_scripts
              .into_iter()
              .map(|script| PendingUiScript {
                namespace: namespace.to_string(),
                script,
              }),
          );
        // Register the bundle's async (session/daemon) command dispatchers LIVE:
        // the command call is a later line in the same unit, so by the time it
        // runs the async door + async-mount routing already know it. The sync env
        // mounts still ride the interpreter's own `Ok(mounts)` return below.
        {
          let mut ac = handler_async.borrow_mut();
          let mut names = handler_async_names.borrow_mut();
          for (symbol, dispatch) in resolved.async_mounts {
            names.insert(symbol.clone());
            ac.insert(symbol.clone(), import_async_reflection(symbol, dispatch, handler_json.clone(), handler_natives.clone(), handler_env.clone()));
          }
        }
        // Queue the bundle's rc/*.tshrc the same way (drained between lines):
        // the loader needs the interpreter, which this handler must not
        // re-enter.
        handler_pending_rc
          .borrow_mut()
          .extend(
            resolved
              .rc_scripts
              .into_iter()
              .map(|script| PendingRcScript {
                namespace: namespace.to_string(),
                script,
              }),
          );
          all_mounts.extend(resolved.mounts.into_iter().map(|(name, value)| import_native_reflection(name, value, handler_json.clone(), &handler_natives)));
        }
        handler_resolver.admitted(name, namespace, from);
        Ok(all_mounts)
      });
    interp.set_import_handler(handler);
    // `use` binds Lisp names only, `as:` or not (operator ruling 14,
    // 2026-10-06): an import never takes a bash command word, so it can
    // collide with nothing a bash line runs.
    let script_path: Rc<RefCell<Option<PathBuf>>> = Rc::new(RefCell::new(None));
    let use_lisp_names: Rc<RefCell<HashSet<String>>> = Rc::default();
    let binding_places: Rc<RefCell<HashMap<String, String>>> = Rc::default();
    let seeding = Rc::new(Cell::new(false));
    {
      let lisp_names = use_lisp_names.clone();
      interp.set_use_hook(Rc::new(move |word: &str, _path: &str, _value: &LispValue<Sym>, _as: bool| {
        lisp_names.borrow_mut().insert(word.to_string());
        Ok(())
      }));
    }
    // Mount one recorded namespace: resolve the bundle now, install its async
    // (daemon) commands in the host tables, and hand back the sync mounts for
    // the caller to define in the root env. `None` when nothing is recorded
    // under `namespace` (or its bundle no longer resolves — then the reference
    // fails as an undefined symbol, exactly as an eager import failure would
    // have left it).
    let mounter_registration = registration.clone();
    let mounter_async = async_commands.clone();
    let mounter_async_names = async_mount_names.clone();
    let mounter_lazy = lazy_imports.clone();
    let mounter_resolver = resolver.clone();
    let mounter_json = command_json.clone();
    let mounter_natives = command_natives.clone();
    let mounter_env = env.clone();
    let lazy_mounter: Rc<dyn Fn(&str) -> Option<Vec<(String, LispValue<Sym>)>>> =
      Rc::new(move |namespace: &str| {
        let pending = mounter_lazy.borrow().get(namespace).cloned()?;
        let resolved = mounter_resolver
          .resolve(
            &pending.name,
            namespace,
            pending.from.as_deref(),
            mounter_registration.clone(),
          )
          .inspect_err(|e| tracing::warn!(%e, namespace, "lazy @import failed on first reference"))
          .ok()?;
        mounter_lazy.borrow_mut().remove(namespace);
        {
          let mut ac = mounter_async.borrow_mut();
          let mut names = mounter_async_names.borrow_mut();
          for (symbol, dispatch) in resolved.async_mounts {
            names.insert(symbol.clone());
            ac.insert(symbol.clone(), import_async_reflection(symbol, dispatch, mounter_json.clone(), mounter_natives.clone(), mounter_env.clone()));
          }
        }
        let mounts = resolved.mounts.into_iter().map(|(name, value)| import_native_reflection(name, value, mounter_json.clone(), &mounter_natives)).collect();
        mounter_resolver.admitted(&pending.name, namespace, pending.from.as_deref());
        Some(mounts)
      });
    let hook_lazy = lazy_imports.clone();
    let hook_mounter = lazy_mounter.clone();
    interp.set_missing_symbol_hook(Rc::new(move |name: &str| {
      let namespace = name.split_once('.').map(|(head, _)| head).unwrap_or(name);
      if !hook_lazy.borrow().contains_key(namespace) {
        return None;
      }
      hook_mounter(namespace)
    }));
    let discovery_lazy = lazy_imports.clone();
    let discovery_mounter = lazy_mounter.clone();
    interp.set_module_discovery(Rc::new(move || {
      let before = discovery_lazy.borrow().clone();
      let mut pending: Vec<_> = before.keys().cloned().collect();
      pending.sort();
      let mut mounts = vec![];
      for namespace in pending {
        match discovery_mounter(&namespace) {
          Some(definitions) => mounts.extend(definitions),
          None => {
            // No definitions have reached the interpreter yet. Restore successful
            // imports too so a later retry cannot lose their module values.
            discovery_lazy.borrow_mut().extend(before);
            return Err(RuntimeError::Other(format!("trait discovery could not resolve imported module {namespace}; imports retained for retry")));
          },
        }
      }
      Ok(mounts)
    }));
    let mut host = LispHost {
      resources: Default::default(),
      types_sealed: false,
      stream_capability: None,
      core_types: Rc::default(),
      #[cfg(test)]
      posix_reads: 0,
      interp,
      env,
      binds: HashMap::new(),
      registration,
      pending_ui,
      pending_rc,
      rc_evaluating,
      rc_loaded: HashMap::new(),
      ui_enabled: false,
      async_commands,
      async_mount_names,
      lazy_imports,
      lazy_enabled,
      lazy_mounter,
      command_names: Vec::new(),
      subcommand_groups: HashSet::new(),
      command_natives,
      native_defs: Vec::new(),
      deprecated_aliases: Rc::new(RefCell::new(Vec::new())),
      native_deprecations: DeprecationNotes::default(),
      hand_off_deprecations: false,
      shell_symbols: Rc::new(RefCell::new(HashMap::new())),
      shell_dir_stack: Vec::new(),
      external: None,
      shell_prompt: false,
      shell_aliases: HashMap::new(),
      shell_command_admission: None,
      shell_builtin: None,
      shell_builtin_cache: None,
      shell_builtin_gate: None,
      shell_byte_output: None,
      shell_stderr_output: None,
      shell_failure_display: Rc::new(std::cell::Cell::new(Default::default())),
      shell_stdin: Rc::new(RefCell::new(None)),
      shell_io: Rc::new(RefCell::new(None)),
      shell_output: Rc::new(RefCell::new(Default::default())),
      shell_files: Rc::new(RefCell::new((0, HashMap::new()))),
      shell_redirect_cache: None,
      shell_write_cache: None,
      shell_stdin_reads: Rc::new(RefCell::new(None)),
      shell_formatter: None,
      command_json,
      script_path,
      env_write_gate: Rc::default(),
      script_args: Rc::new(RefCell::new(Vec::new())),
      shell_status: Rc::new(std::cell::Cell::new(0)),
      shell_errexit: false,
      shell_compound: Default::default(),
      shell_unit: None,
      shell_status_writes: 0,
      shell_last_statement_bash: false,
      shell_diagnostics: None,
      semicolon_comment_warned: Default::default(),
      deprecation_warned: Default::default(),
      nested_commands: Default::default(),
      use_lisp_names,
      binding_places,
      seeding,
      prelude_failures: Vec::new(),
      command_owners,
    };
    let hook = super::shell_cmd::call_head_hook(
      host.nested_commands.clone(),
      host.shell_io.clone(),
      host.shell_status.clone(),
    );
    host.interp.set_call_head_hook(hook);
    host.register_env_and_script_natives();
    host.register_bash_expansion_natives();
    host.register_shell_presentation();
    // A5: one variable store. A name made readonly by bash `readonly` refuses
    // lisp `def`/`set` too, as bash refuses `x=2`.
    let attributes = host.shell_compound.commands.attributes.clone();
    // Each binding also records where it was made (for `type` at the prompt)
    // and takes the name out of the `use` set: a later `let` is the user's
    // own binding again, a declaration when it names a `std.*` command.
    let places = host.binding_places.clone();
    let use_names = host.use_lisp_names.clone();
    let seeding = host.seeding.clone();
    let script_path = host.script_path.clone();
    let core_types = host.core_types.clone();
    host.interp.set_binding_guard(Rc::new(move |name: &str| {
      if core_types.borrow().contains(name) {
        return Some(format!("{name}: core type is sealed"));
      }
      let readonly = attributes.borrow().get(name).is_some_and(|attr| attr.readonly)
        .then(|| format!("{name}: readonly variable"));
      if readonly.is_none() && !name.contains('.') {
        use_names.borrow_mut().remove(name);
        let path = script_path.borrow();
        let place: std::borrow::Cow<str> = match (seeding.get(), path.as_ref()) {
          (true, _) => "the prelude".into(),
          (false, Some(file)) => file.to_string_lossy(),
          (false, None) => "this session".into(),
        };
        let mut places = places.borrow_mut();
        if places.get(name).map(String::as_str) != Some(&*place) {
          places.insert(name.to_string(), place.into_owned());
        }
      }
      readonly
    }));
    let stdin = host.shell_stdin.clone();
    let io = host.shell_io.clone();
    let reads = host.shell_stdin_reads.clone();
    host.register_native_special("std.io.stdin_text", move |args| {
      if !args.is_empty() {
        return Err(LispHostError::Runtime(
          "std.io.stdin_text: expected no arguments".into(),
        ));
      }
      let ordinal = reads.borrow_mut().as_mut().map(|(cursor, values)| {
        let ordinal = *cursor;
        *cursor += 1;
        (ordinal, values.get(ordinal).cloned())
      });
      if let Some((_, Some(text))) = &ordinal { return Ok(LispValue::String(text.as_str().into())); }
      let text = super::shell_redirect::stdin_text(io.borrow().as_ref(), stdin.borrow().clone())?;
      if let (Some((ordinal, _)), Some((_, values))) = (ordinal, &mut *reads.borrow_mut()) {
        if ordinal == values.len() { values.push(text.clone()); }
      }
      Ok(LispValue::String(text.into()))
    });
    host.refresh_shell_symbols();
    host
  }

  /// The declared-env + script-identity vocabulary EVERY host carries — the
  /// shell tier of "env as declared state" (the scene host shares these via
  /// its embedded `LispHost`; the rc DIRECTIVE tier has its own restricted
  /// twins):
  ///
  ///   * `(env "K" [DEFAULT])` — read the session [`tento_env::EnvMap`]
  ///     (map-only; never the process environment). Unset/empty → DEFAULT
  ///     when given, else nil — so `(assert (env "X") "msg")` fails loud.
  ///   * `(env.set "K" VALUE)` — write the global map (session-live state).
  ///     The key must be a string literal; VALUE coerces like `str.concat`
  ///     scalars (string/int/float/bool). Returns the written string.
  ///   * `(std.script.path)` / `(std.script.dir)` — the file-backed source
  ///     currently evaluating (nil when the source has no file).
  ///   * `(std.script.args)` — the current invocation's positional source args.
  ///   * `(std.script.source "PATH")` — the internal context form a queued
  ///     startup unit leads with: sets the current-file slot for the rest of
  ///     the unit (the unit queue carries plain content, so the path rides
  ///     in-band, visible in the trace).
  ///
  /// Registered at construction; a later `register_commands`/`def` of the
  /// same name would shadow them (ordinary env semantics), and none does.
  fn register_env_and_script_natives(&mut self) {
    let lisp_str = |v: &LispValue<Sym>| match v {
      LispValue::String(s) => Some(s.clone()),
      _ => None,
    };

    self.register_native_special("env", move |args| {
      let name = args
        .first()
        .and_then(&lisp_str)
        .ok_or_else(|| LispHostError::Runtime("env: expected (env \"NAME\" [DEFAULT])".into()))?;
      match tento_env::effective_var(&name).filter(|v| !v.is_empty()) {
        Some(v) => Ok(LispValue::String(v.into())),
        None => Ok(args.get(1).cloned().unwrap_or(LispValue::Nil)),
      }
    });

    // Every env writer goes through `declare`: the embedder's gate, then the
    // session's declared map.
    let gate = self.env_write_gate.clone();
    let declare = Rc::new(move |head: &str, name: String, value: String| {
      if let Some(gate) = gate.borrow().as_ref() {
        gate().map_err(LispHostError::Runtime)?;
      }
      let Some(map) = tento_env::global_env_map() else {
        return Err(LispHostError::Runtime(format!(
          "{head}: no session EnvMap installed on this host (env is declared state)"
        )));
      };
      map.set(name, value.clone());
      Ok(LispValue::String(value.into()))
    });
    // The str.concat scalar coercion — a composed value is usually already a
    // string (template literals desugar to str.concat), but a bare
    // number/bool declares fine too. Nil is a loud error, not "nil": it is
    // almost always an unset `(env …)` read with no default.
    let scalar = |head: &str, name: &str, value: &LispValue<Sym>| match value {
      LispValue::String(s) => Ok(s.to_string()),
      LispValue::Integer(i) => Ok(i.to_string()),
      LispValue::Float(f) => Ok(f.to_string()),
      LispValue::Boolean(b) => Ok(b.to_string()),
      other => Err(LispHostError::Runtime(format!(
        "{head} {name}: VALUE must be a scalar (string/number/boolean), got {:?}",
        other.as_type()
      ))),
    };

    let write = declare.clone();
    self.register_native_special("env.set", move |args| {
      let [name_arg, value_arg] = args.as_slice() else {
        return Err(LispHostError::Runtime(
          "env.set: expected (env.set \"NAME\" VALUE)".into(),
        ));
      };
      let name = lisp_str(name_arg)
        .ok_or_else(|| LispHostError::Runtime("env.set: NAME must be a string".into()))?;
      let value = scalar("env.set", &name, value_arg)?;
      write("env.set", name.into_string(), value)
    });

    // `(env.default "NAME" VALUE)`: `env.set` when NAME is unset. An ordinary
    // call, so VALUE is evaluated either way; write `(when …)` to skip work.
    let write = declare.clone();
    self.register_native_special("env.default", move |args| {
      let [name_arg, value_arg] = args.as_slice() else {
        return Err(LispHostError::Runtime(
          "env.default: expected (env.default \"NAME\" VALUE)".into(),
        ));
      };
      let name = lisp_str(name_arg)
        .ok_or_else(|| LispHostError::Runtime("env.default: NAME must be a string".into()))?;
      if let Some(current) = tento_env::global_env_map().and_then(|map| map.get(&name)) {
        return Ok(LispValue::String(current.into()));
      }
      let value = scalar("env.default", &name, value_arg)?;
      write("env.default", name.into_string(), value)
    });

    // `(env.from-file "NAME" PATH)` and `(env.from-json "NAME" PATH "a.b")`:
    // a relative PATH resolves against the file being evaluated.
    let write = declare.clone();
    let slot = self.script_path.clone();
    self.register_native_special("env.from-file", move |args| {
      let [name_arg, path_arg] = args.as_slice() else {
        return Err(LispHostError::Runtime(
          "env.from-file: expected (env.from-file \"NAME\" PATH)".into(),
        ));
      };
      let (Some(name), Some(path)) = (lisp_str(name_arg), lisp_str(path_arg)) else {
        return Err(LispHostError::Runtime("env.from-file: NAME and PATH must be strings".into()));
      };
      let dir = slot.borrow().as_ref().and_then(|p| p.parent().map(PathBuf::from));
      let path = super::env_files::resolve_declared_path(dir.as_deref(), &path);
      let value = super::env_files::read_env_file(&name, &path).map_err(LispHostError::Runtime)?;
      write("env.from-file", name.into_string(), value)
    });

    let write = declare;
    let slot = self.script_path.clone();
    self.register_native_special("env.from-json", move |args| {
      let [name_arg, path_arg, key_arg] = args.as_slice() else {
        return Err(LispHostError::Runtime(
          "env.from-json: expected (env.from-json \"NAME\" PATH \"dotted.key\")".into(),
        ));
      };
      let (Some(name), Some(path), Some(key)) =
        (lisp_str(name_arg), lisp_str(path_arg), lisp_str(key_arg))
      else {
        return Err(LispHostError::Runtime(
          "env.from-json: NAME, PATH and KEY must be strings".into(),
        ));
      };
      let dir = slot.borrow().as_ref().and_then(|p| p.parent().map(PathBuf::from));
      let path = super::env_files::resolve_declared_path(dir.as_deref(), &path);
      let value =
        super::env_files::read_env_json(&name, &path, &key).map_err(LispHostError::Runtime)?;
      write("env.from-json", name.into_string(), value)
    });

    let slot = self.script_path.clone();
    self.register_native_special("std.script.path", move |_args| {
      Ok(match &*slot.borrow() {
        Some(p) => LispValue::String(p.display().to_string().into()),
        None => LispValue::Nil,
      })
    });

    let slot = self.script_path.clone();
    self.register_native_special("std.script.dir", move |_args| {
      Ok(match &*slot.borrow() {
        Some(p) => LispValue::String(
          p.parent()
            .map(|d| d.display().to_string())
            .unwrap_or_else(|| ".".to_string()).into(),
        ),
        None => LispValue::Nil,
      })
    });

    let slot = self.script_path.clone();
    self.register_native_special("std.script.source", move |args| {
      let path = args.first().and_then(&lisp_str).ok_or_else(|| {
        LispHostError::Runtime("std.script.source: expected (std.script.source \"PATH\")".into())
      })?;
      *slot.borrow_mut() = Some(PathBuf::from(path.as_str()));
      Ok(LispValue::String(path))
    });

    let status = self.shell_status.clone();
    self.register_native_special("std.sh.status", move |args| {
      if !args.is_empty() {
        return Err(LispHostError::Runtime("std.sh.status: expected no arguments".into()));
      }
      Ok(LispValue::Integer(i64::from(status.get())))
    });

    self.register_shell_call_native();

    let args = self.script_args.clone();
    self.register_native_special("std.script.args", move |_ignored| {
      Ok(LispValue::List(tento_lisp::List {
        items: args
          .borrow()
          .iter()
          .cloned()
          .map(|value| LispValue::String(value.into()))
          .collect(),
      }))
    });
  }

  /// Refuse env writes while `gate` returns `Err(reason)`. One gate covers
  /// `env.set`, `env.default`, `env.from-file` and `env.from-json`.
  pub fn set_env_write_gate(&mut self, gate: impl Fn() -> Result<(), String> + 'static) {
    *self.env_write_gate.borrow_mut() = Some(Rc::new(gate));
  }

  /// Point `(std.script.path)`/`(std.script.dir)` at the file-backed source
  /// about to evaluate (`None` for pathless sources), returning the previous
  /// value. The runners call this from [`crate::script::RunOptions::source_path`].
  pub fn set_script_path(&mut self, path: Option<PathBuf>) -> Option<PathBuf> {
    self.script_path.replace(path)
  }

  /// The file-backed source being evaluated, as it was named.
  pub(super) fn script_path(&self) -> Option<PathBuf> {
    self.script_path.borrow().clone()
  }

  /// Whether a file-backed source is being evaluated (bash's `main` frame).
  pub(super) fn has_script_path(&self) -> bool {
    self.script_path.borrow().is_some()
  }

  /// The last bash line's status, independent of the last rendered Lisp value.
  pub fn shell_status(&self) -> i32 {
    self.shell_status.get()
  }

  /// A hosted unit may replay several times as its commands settle. Restore
  /// its entry state on replay; a new unit inherits the previous one's state.
  pub fn begin_shell_unit(&mut self, unit: i64) {
    match self.shell_unit {
      Some((id, status, errexit)) if id == unit => {
        self.shell_status.set(status);
        self.shell_errexit = errexit;
        if let Some((cursor, _)) = &mut self.shell_redirect_cache { *cursor = 0; }
        if let Some((cursor, _)) = &mut self.shell_write_cache { *cursor = 0; }
        if let Some((cursor, _)) = &mut self.shell_builtin_cache { *cursor = 0; }
        if let Some((cursor, _)) = &mut *self.shell_stdin_reads.borrow_mut() { *cursor = 0; }
      }
      _ => {
        self.shell_unit = Some((unit, self.shell_status(), self.shell_errexit));
        self.shell_redirect_cache = Some((0, Vec::new()));
        self.shell_write_cache = Some((0, Vec::new()));
        self.shell_builtin_cache = Some((0, Vec::new()));
        *self.shell_stdin_reads.borrow_mut() = Some((0, Vec::new()));
      }
    }
  }

  pub fn shell_suspended(&self) -> bool {
    self
      .external
      .as_ref()
      .is_some_and(|external| external.suspended())
  }

  pub(super) fn set_shell_status(&mut self, status: i32) {
    self.set_compound_status(status);
    self.set_pipeline_statuses(&[status]);
  }

  /// A compound result updates $? while retaining its last executed pipeline.
  pub(super) fn set_compound_status(&mut self, status: i32) {
    self.shell_status.set(status);
    self.shell_status_writes += 1;
    self.shell_last_statement_bash = true;
  }

  pub(super) fn note_lisp_statement(&mut self) {
    self.shell_last_statement_bash = false;
  }

  /// Whether the most recent statement was a Bash line — so its status, not a
  /// later Lisp value, decides how a unit ends.
  pub fn shell_last_statement_bash(&self) -> bool {
    self.shell_last_statement_bash
  }

  /// How many Bash-line statuses this host has recorded.
  pub fn shell_status_writes(&self) -> u64 {
    self.shell_status_writes
  }

  /// Collect Bash diagnostics for [`Self::take_shell_diagnostics`] instead of
  /// printing them to stderr.
  pub fn collect_shell_diagnostics(&mut self) {
    self.shell_diagnostics = Some(Vec::new());
  }

  /// The diagnostics collected since [`Self::collect_shell_diagnostics`];
  /// stops collecting.
  pub fn take_shell_diagnostics(&mut self) -> Vec<String> {
    self.shell_diagnostics.take().unwrap_or_default()
  }

  pub(super) fn report_shell_diagnostic(&mut self, diagnostic: String) {
    let diagnostic = self.shape_shell_diagnostic(diagnostic);
    let io = self.shell_io.borrow().clone();
    if let Some(io) = io {
      let target = io.target(2);
      if !matches!(target, super::FdTarget::Inherit(2)) {
        if matches!(target, super::FdTarget::Inherit(1)) {
          let output = self.shell_output.borrow().clone();
          // Duplication copied the original stdout destination. A later
          // stdout redirect must not redirect this diagnostic a second time.
          output.write_inherited_bytes(self, format!("{diagnostic}\n").as_bytes());
        } else if !matches!(target, super::FdTarget::Closed) {
          let _ = self.write_shell_target(&target, format!("{diagnostic}\n").as_bytes());
        }
        return;
      }
    }
    self.report_ambient_shell_diagnostic(diagnostic);
  }

  /// Warn once per source (`None`: the session) that a single-`;` comment
  /// is deprecated in favour of `;;` (I10 transition).
  pub(super) fn warn_semicolon_comment(&mut self, source: Option<&std::path::Path>, line: usize) {
    if !self.semicolon_comment_warned.insert(source.map(std::path::Path::to_path_buf)) {
      return;
    }
    let place = source.map(|path| format!("{}: ", path.display())).unwrap_or_default();
    self.report_ambient_shell_diagnostic(format!(
      "tsh: {place}line {line}: deprecated: use ;; for a comment (a single ; is not lisp)"
    ));
  }

  /// Warn about the deprecated spellings the statement at `line` of `source`
  /// used (deprecated: `set!`, `std.tsh.X`, `std.apps`, and deprecated natives
  /// through [`Self::deprecation_notes`]), once per site. The site
  /// is the line within `chunk` that spells the old name, else the
  /// statement's own line (a deprecated name reached through a call).
  pub(super) fn warn_deprecations(
    &mut self,
    source: Option<&std::path::Path>,
    line: usize,
    chunk: &str,
    statement: &StatementInFlight,
  ) {
    let noted = self.native_deprecations.take();
    let handed = statement.take();
    for deprecation in self.interp.take_deprecations().into_iter().chain(noted).chain(handed) {
      let at = chunk
        .find(deprecation.old.as_str())
        .map_or(line, |offset| line + chunk[..offset].matches('\n').count());
      let key = (source.map(std::path::Path::to_path_buf), at, deprecation.old.clone());
      if !self.deprecation_warned.insert(key) {
        continue;
      }
      let place = source.map(|path| format!("{}: ", path.display())).unwrap_or_default();
      self.report_ambient_shell_diagnostic(format!("tsh: {place}line {at}: {}", deprecation.message()));
    }
  }

  /// The handle a deprecated native records its calls through, so they warn
  /// once per site like a deprecated alias while the native keeps working.
  pub fn deprecation_notes(&self) -> DeprecationNotes {
    self.native_deprecations.clone()
  }

  /// Make this a child host whose deprecations still warn although no
  /// source runner drains it (a `std.script.call` / `std.script.spawn`
  /// module's host, which evaluates with [`Self::eval_value`] and
  /// [`Self::call_value`]). When it is dropped, what it never drained goes to
  /// the hand-off frame of the innermost statement this thread is evaluating,
  /// which warns once per its own site (a deprecated native reached through
  /// a call is the calling statement's, as in one host); dropped outside any
  /// statement (a job's thread), each spelling is reported once per process,
  /// with no site. The frame rules are at `FRAMES`.
  pub fn hand_off_deprecations(&mut self) {
    self.hand_off_deprecations = true;
  }

  /// See [`Self::hand_off_deprecations`].
  fn hand_off_undrained_deprecations(&mut self) {
    let mut pending = self.interp.take_deprecations();
    pending.extend(self.native_deprecations.take());
    if pending.is_empty() {
      return;
    }
    let unsited = FRAMES
      .try_with(|frames| match frames.borrow_mut().last_mut() {
        Some((_, innermost)) => {
          merge_into(innermost, std::mem::take(&mut pending));
          None
        }
        None => Some(std::mem::take(&mut pending)),
      })
      .unwrap_or(Some(pending));
    if let Some(pending) = unsited {
      report_unsited(pending, |line| self.report_ambient_shell_diagnostic(line));
    }
  }

  /// Keep a renamed name prefix resolving for one release (`std.tsh` →
  /// `tsh`): uses resolve the new name and warn once per site. Nothing is
  /// bound under the old prefix, so read-only `std` stays read-only.
  pub fn add_deprecated_alias(&mut self, old: &str, new: &str) {
    self.interp.add_deprecated_alias(old, new);
    self.note_help_alias(old, new);
  }

  /// Keep a retired command running for one release as its replacement
  /// called with `leading` arguments first (`std.fs.list_dir` is
  /// `std.coreutil.ls -l`); uses warn once per site, naming the whole
  /// replacement. `(help "old")` answers the replacement's document.
  pub fn add_deprecated_call(&mut self, old: &str, new: &str, leading: &[&str]) {
    self.interp.add_deprecated_call(old, new, leading);
    self.note_help_alias(old, new);
  }

  fn note_help_alias(&mut self, old: &str, new: &str) {
    let mut aliases = self.deprecated_aliases.borrow_mut();
    if !aliases.iter().any(|(o, _)| o == old) {
      aliases.push((old.to_string(), new.to_string()));
    }
  }

  /// Respell deprecated names in a parsed lisp form before a door
  /// dispatches it, so a renamed command reaches its new owner however it
  /// is routed (async mounts included).
  pub(super) fn respell_deprecated(&mut self, value: &mut LispValue<Sym>) {
    self.interp.respell_deprecated(value);
  }

  pub(super) fn report_ambient_shell_diagnostic(&mut self, diagnostic: String) {
    if self.shell_stderr_output.is_some() {
      let _ = self.write_shell_target(&super::FdTarget::Inherit(2), format!("{diagnostic}\n").as_bytes());
      return;
    }
    match &mut self.shell_diagnostics {
      Some(collected) => collected.push(diagnostic),
      None => eprintln!("{diagnostic}"),
    }
  }

  /// Set the positional arguments exposed by `(std.script.args)`, returning
  /// the previous vector for embedders that temporarily change invocation
  /// context on a persistent host.
  pub fn set_script_args(&mut self, args: Vec<String>) -> Vec<String> {
    self.shell_compound.positional.replace(args.clone());
    self.script_args.replace(args)
  }

  /// Bash invocation context; $0 is separate from the argument vector.
  pub fn set_shell_positionals(&mut self, zero: String, args: Vec<String>) {
    self.shell_compound.zero.replace(zero);
    self.shell_compound.positional.replace(args);
  }

  /// The app/scene native command names registered on this host (unsorted, in
  /// registration order, may contain duplicates if a name was re-registered).
  /// The prompt's completion sorts + dedups.
  pub fn native_names(&self) -> &[String] {
    &self.native_defs
  }

  /// The shared registration-context cell: `Some(namespace)` while a bundle's
  /// `ui/*.tsh` evaluates. A host embedding define-style natives (`defmode`,
  /// `bind-key`, …) captures this to stage contributions inert during
  /// registration instead of applying them live.
  pub fn registration_guard(&self) -> Rc<RefCell<Option<String>>> {
    self.registration.clone()
  }

  /// Opt this host into import-time UI registration. Called by the embedder
  /// that registers the session UI natives (`defmode`, `bind-key`, `use-ui`,
  /// …); without it, [`Self::process_pending_ui`] *skips* queued ui scripts —
  /// a bundle's UI layer is a session concern, and a plain script/CLI host
  /// evaluating `ui/*.tsh` would only hit undefined symbols and break the
  /// import that mounted perfectly good commands.
  pub fn enable_import_ui(&mut self) {
    self.ui_enabled = true;
  }

  /// Drain the UI scripts queued by `(@import …)` and evaluate each in the
  /// gated registration context: the registration cell holds the import's
  /// namespace for the duration, so command mounts refuse to spawn and
  /// define-style natives stage their contributions inert. Line-based, like
  /// the rc runner. Called by the script runner after every line; a no-op when
  /// nothing is queued. Hosts that never called [`Self::enable_import_ui`]
  /// drain the queue without evaluating (commands mount; UI stays dormant).
  /// Failure cancels queued RC/UI initialization; re-import to retry.
  pub fn process_pending_ui(&mut self) -> Result<(), LispHostError> {
    self.seal_types();
    let result = self.drain_pending_ui();
    if result.is_err() { self.quarantine_pending_initialization(); }
    result
  }

  fn drain_pending_ui(&mut self) -> Result<(), LispHostError> {
    if !self.ui_enabled {
      let skipped = std::mem::take(&mut *self.pending_ui.borrow_mut());
      for pending in &skipped {
        tracing::debug!(
          script = %pending.script.display(),
          namespace = %pending.namespace,
          "skipping import-time ui (host has no session UI layer)"
        );
      }
      return Ok(());
    }
    loop {
      let Some(pending) = self.pending_ui.borrow_mut().pop() else {
        return Ok(());
      };
      let source = std::fs::read_to_string(&pending.script).map_err(|e| {
        LispHostError::Runtime(format!(
          "reading ui script {}: {e}",
          pending.script.display()
        ))
      })?;
      *self.registration.borrow_mut() = Some(pending.namespace.clone());
      let result = self.eval_ui_source(&source);
      *self.registration.borrow_mut() = None;
      result.map_err(|e| {
        LispHostError::Runtime(format!(
          "ui registration {} ({}): {e}",
          pending.script.display(),
          pending.namespace
        ))
      })?;
    }
  }

  /// Evaluate a ui script's lines (one form per line, `#`/`;` comments and
  /// blanks skipped — the same line discipline as the rc runner).
  fn eval_ui_source(&mut self, source: &str) -> Result<(), LispHostError> {
    for raw in source.lines() {
      let line = raw.trim();
      if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
        continue;
      }
      self.eval_stmt(line)?;
    }
    Ok(())
  }

  /// Drain the bundle rc scripts queued by `(@import …)` and load each ONCE
  /// (ES-module semantics: a re-import is a no-op). Unlike `pending_ui` there
  /// is no gating: rc defines the bundle's macros and mounts its exports, a
  /// host-tier concern on every host kind. Errors name the script and the
  /// namespace, cancel remaining RC/UI initialization and retain successfully
  /// cached exports. Re-import reconstructs the queues for a retry.
  pub fn process_pending_rc(&mut self) -> Result<(), LispHostError> {
    self.seal_types();
    let result = self.drain_pending_rc();
    if result.is_err() { self.quarantine_pending_initialization(); }
    result
  }

  /// An aborted initialization must not resume its queued consumers on the
  /// next unrelated eval. Re-import reconstructs the queues; successfully
  /// initialized rc exports remain cached and are mounted again on retry.
  fn quarantine_pending_initialization(&mut self) {
    self.pending_rc.borrow_mut().clear();
    self.pending_ui.borrow_mut().clear();
  }

  fn drain_pending_rc(&mut self) -> Result<(), LispHostError> {
    loop {
      let Some(pending) = self.pending_rc.borrow_mut().pop() else {
        return Ok(());
      };
      let canonical = pending
        .script
        .canonicalize()
        .unwrap_or_else(|_| pending.script.clone());
      // Evaluated ONCE per file; a later import under another alias re-mounts
      // the cached exports without re-running the body.
      if let Some(exports) = self.rc_loaded.get(&canonical).cloned() {
        self.mount_rc_exports(&pending.namespace, &exports)?;
        continue;
      }
      let source = std::fs::read_to_string(&pending.script).map_err(|e| {
        LispHostError::Runtime(format!(
          "reading bundle rc {}: {e}",
          pending.script.display()
        ))
      })?;
      // Bundle initialization resolves its own file; restore the persistent
      // host's caller context before propagating either success or failure.
      let previous_path = self.set_script_path(Some(pending.script.clone()));
      let declarations = self.interp.declaration_checkpoint();
      // Only the manifest entrypoint may use a bare module body. Other
      // rc/*.tshrc files retain the legacy wrapper gate before any effects.
      let requirement_symbol = self
        .interp
        .string_interner()
        .get_or_intern(format!("{}.__requires", pending.namespace));
      let module_body = match self.env.borrow().get(requirement_symbol) {
        Some(LispValue::Map(requirements)) => requirements.values().any(|entry| {
          let LispValue::Map(entry) = entry else {
            return false;
          };
          let Some(LispValue::String(path)) = entry.get("module_rc") else {
            return false;
          };
          PathBuf::from(path.as_str()).canonicalize().ok().as_ref() == Some(&canonical)
        }),
        _ => false,
      };
      let evaluated = self.eval_bundle_rc_entry(&pending.namespace, &source, module_body);
      self.set_script_path(previous_path);
      let evaluated = evaluated.and_then(|exports| {
        self.mount_rc_exports(&pending.namespace, &exports)?;
        Ok(exports)
      });
      if evaluated.is_err() {
        self.interp.restore_declarations(declarations);
      }
      let exports = evaluated.map_err(|e| {
        LispHostError::Runtime(format!(
          "bundle rc {} ({}): {e}",
          pending.script.display(),
          pending.namespace
        ))
      })?;
      self.rc_loaded.insert(canonical, exports);
    }
  }

  /// Mount `(name, value)` export pairs as `<namespace>.<name>` in the host env.
  fn mount_rc_exports(
    &mut self,
    namespace: &str,
    exports: &[(String, LispValue<Sym>)],
  ) -> Result<(), LispHostError> {
    use tento_lisp::types::Module;
    let module_sym = self.interp.string_interner().get_or_intern(namespace);
    let previous = self.env.borrow().get(module_sym);
    let mut module = match previous {
      Some(LispValue::Module(module)) => (*module).clone(),
      _ => Module::new(namespace.to_string(), Default::default()),
    };
    for (name, _) in exports {
      if module.method_names.contains(name) && !module.exports.contains_key(name) {
        return Err(LispHostError::Runtime(format!("bundle rc export {namespace}.{name} collides with a native command")));
      }
    }
    let mut members = module.exports.clone();
    members.extend(exports.iter().cloned());
    module = module.with_exports(members);
    self.define_host_binding(module_sym, LispValue::Module(Rc::new(module)));
    for (name, value) in exports {
      let mounted = self
        .interp
        .string_interner()
        .get_or_intern(format!("{namespace}.{name}"));
      self.define_host_binding(mounted, value.clone());
    }
    Ok(())
  }

  #[cfg(test)]
  fn eval_bundle_rc(
    &mut self,
    namespace: &str,
    source: &str,
  ) -> Result<Vec<(String, LispValue<Sym>)>, LispHostError> {
    self.eval_bundle_rc_entry(namespace, source, true)
  }

  fn eval_bundle_rc_entry(
    &mut self,
    namespace: &str,
    source: &str,
    module_body: bool,
  ) -> Result<Vec<(String, LispValue<Sym>)>, LispHostError> {
    let previous = self.rc_evaluating.replace(Some(namespace.into()));
    let result = self.eval_bundle_rc_body(namespace, source, module_body);
    self.rc_evaluating.replace(previous);
    result
  }

  fn eval_bundle_rc_body(
    &mut self,
    namespace: &str,
    source: &str,
    module_body: bool,
  ) -> Result<Vec<(String, LispValue<Sym>)>, LispHostError> {
    use std::rc::Weak;
    // A bundle rc is strict lisp: refuse a bash line, `>` prefix or `#` comment.
    if let Some((line, refusal, chunk)) = super::sh_macro::strict_refusals(source).into_iter().next() {
      return Err(LispHostError::Parse(super::sh_macro::strict_refusal_message(refusal, &chunk, None, line)));
    }
    let asts = {
      let interner = self.interp.string_interner();
      tento_lisp::Runtime::<Sym, StringBackend>::parse(None, source, interner)
        .map_err(syntax_host_error)?
    };
    self.refresh_shell_symbols();
    let mut forms = Vec::new();
    for ast in asts {
      forms.push(
        LispValue::from_owned_sexpression(ast)
          .map_err(|e| LispHostError::Parse(format!("{:?}", EvalError::SyntaxError(e))))?,
      );
    }
    let teaching = "a bundle rc is ONE `(bundle (m) …)` form — definitions and \
                    own-receiver registrations only";
    let has_bundle = forms.iter().any(|form| {
      matches!(form,
      LispValue::List(items) if matches!(items.items.first(), Some(LispValue::Symbol(s))
        if self.interp.string_interner().resolve(s.as_symbol()) == Some("bundle")))
    });
    if (has_bundle || !module_body) && forms.len() != 1 {
      return Err(LispHostError::Runtime(format!(
        "{} form(s) at top level; {teaching}",
        forms.len()
      )));
    }
    let wrapped = match forms.as_slice() {
      [LispValue::List(items)]
        if matches!(
          items.items.first(),
          Some(LispValue::Symbol(s))
            if self.interp.string_interner().resolve(s.as_symbol()) == Some("bundle")
        ) =>
      {
        Some(&items.items)
      }
      _ => None,
    };
    if !module_body && wrapped.is_none() {
      return Err(LispHostError::Runtime(teaching.into()));
    }
    let (param, body) = if let Some(items) = wrapped {
      let param = match items.get(1) {
      Some(LispValue::List(params)) if params.items.len() == 1 => match &params.items[0] {
        LispValue::Symbol(sym) => sym.as_symbol(),
        _ => return Err(LispHostError::Runtime(teaching.into())),
      },
      _ => return Err(LispHostError::Runtime(teaching.into())),
    };
      (Some(param), &items[2..])
    } else {
      (None, forms.as_slice())
    };

    // The receiver: `:lane.declare` delegates to the HOST's lane.declare (the
    // detached twin on a detached host — the refusal is then the host's own
    // words) and records the member; `:export` marks names to mount.
    let host_env = self.env.clone();
    let require_symbol = self.interp.string_interner().get_or_intern(format!("{namespace}.__requires"));
    let symbols = self.shell_symbols.clone();
    let lane_declare_sym = self.interp.string_interner().get_or_intern("lane.declare");
    let exports: Rc<RefCell<Vec<LispValue<Sym>>>> = Rc::new(RefCell::new(Vec::new()));
    let state = Rc::new_cyclic(|weak: &Weak<ReceiverState<Sym>>| {
      let mut selectors: IndexMap<String, NativeClosure<Sym>> = IndexMap::new();
      let require_env = host_env.clone();
      let require_symbols = symbols.clone();
      selectors.insert(":require".into(), Rc::new(move |_env, args| {
        let [LispValue::String(name)] = args.as_slice() else {
          return Err(RuntimeError::Other("m.require expects one installed bundle name".into()));
        };
        let requirements = require_env.borrow().get(require_symbol);
        let Some(LispValue::Map(requirements)) = requirements else {
          return Err(RuntimeError::Other("m.require is available only for resolved bundle dependencies".into()));
        };
        let Some(entry) = requirements.get(name.as_ref()) else {
          return Err(RuntimeError::Other(format!("m.require {name}: not a declared dependency")));
        };
        let (namespace, package, optional) = requirement_binding(entry, name)?;
        let symbol = require_symbols.borrow().get(namespace.as_str()).copied();
        match symbol.and_then(|symbol| require_env.borrow().get(symbol)) {
          Some(value @ LispValue::Module(_)) => Ok(value),
          _ if optional => Ok(LispValue::Nil),
          _ => Err(RuntimeError::Other(format!("m.require {name}: dependency is not mounted; install it with plugins install {package}"))),
        }
      }));
      let delegate_env = host_env.clone();
      let record = weak.clone();
      selectors.insert(
        ":lane.declare".to_string(),
        Rc::new(move |_env, args| {
          let target = delegate_env.borrow().get(lane_declare_sym).ok_or_else(|| {
            RuntimeError::Other("lane.declare is not available on this host".to_string())
          })?;
          let label = match args.first() {
            Some(LispValue::String(name)) => name.to_string(),
            _ => "?".into(),
          };
          let out = match &target {
            LispValue::Function(Function::NativeClosure(f)) => f(delegate_env.clone(), args),
            LispValue::Function(Function::NativeFn(f)) => f(args),
            _ => Err(RuntimeError::Other(
              "lane.declare on this host is not callable".to_string(),
            )),
          }?;
          if let Some(state) = record.upgrade() {
            state.members.borrow_mut().push(Member {
              selector: ":lane.declare".to_string(),
              label,
              // Host lanes KEEP RUNNING when the bundle unmounts — dispose
              // reports this member by name instead of undoing it (Q8).
              undo: None,
            });
          }
          Ok(out)
        }),
      );
      let export_list = exports.clone();
      selectors.insert(
        ":export".to_string(),
        Rc::new(move |_env, args| {
          for arg in args {
            match &arg {
              LispValue::Symbol(_) | LispValue::String(_) => {
                export_list.borrow_mut().push(arg);
              }
              other => {
                return Err(RuntimeError::TypeError {
                  expected: "m.export: a quoted name — (m.export 'lane)".to_string(),
                  got: format!("{:?}", other.as_type()),
                });
              }
            }
          }
          Ok(LispValue::Nil)
        }),
      );
      ReceiverState {
        name: namespace.to_string(),
        selectors,
        members: RefCell::new(Vec::new()),
      }
    });
    let receiver = self.interp.make_receiver(state);

    // The bundle's own scope: the receiver bound under its declared name, the
    // host-only verbs shadowed so a bare call fails AT LOAD with the remedy.
    let child = Rc::new(RefCell::new(Env::extend(self.env.clone())));
    if let Some(param) = param {
      child.borrow_mut().define(param, receiver);
    }
    let module_symbol = self.interp.string_interner().get_or_intern(namespace);
    let bundle_name = match self.env.borrow().get(module_symbol) {
      Some(LispValue::Module(module)) => module
        .bundle_name
        .clone()
        .unwrap_or_else(|| namespace.into()),
      _ => namespace.into(),
    };
    let identity = self
      .interp
      .string_interner()
      .get_or_intern("__module_bundle");
    child
      .borrow_mut()
      .define(identity, LispValue::String(bundle_name.into()));
    if param.is_none() {
      if let Some(LispValue::Map(requirements)) = self.env.borrow().get(require_symbol) {
        for (alias, entry) in requirements.iter() {
          let (target, package, optional) = requirement_binding(entry, alias).map_err(runtime_host_error)?;
          if target == namespace {
            continue;
          }
          let target_symbol = self.interp.string_interner().get(&target);
          let value = target_symbol.and_then(|symbol| self.env.borrow().get(symbol));
          let value = match value {
            Some(value @ LispValue::Module(_)) => value,
            _ if optional => LispValue::Nil,
            _ => return Err(LispHostError::Runtime(format!(
              "dependency {alias} is not mounted; install it with plugins install {package}"
            ))),
          };
          let symbol = self.interp.string_interner().get_or_intern(alias);
          child.borrow_mut().define(symbol, value);
        }
      }
    }
    let ns_for_err = namespace.to_string();
    let lane_advice = if param.is_some() {
      "a bundle defines a macro that sends (m.lane.declare …) at expansion"
    } else {
      "a module bundle exports data and functions; declare host lanes in the host rc"
    };
    let bare: NativeClosure<Sym> = Rc::new(move |_env, _args| {
      Err(RuntimeError::Other(format!(
        "lanes are the HOST's: {lane_advice}; bare lane.declare is not available \
         inside bundle `{ns_for_err}`"
      )))
    });
    child.borrow_mut().define(
      lane_declare_sym,
      LispValue::Function(Function::NativeClosure(bare)),
    );
    let shell_sym = self.interp.string_interner().get_or_intern("shell");
    let ns_for_shell = namespace.to_string();
    let no_shell: NativeClosure<Sym> = Rc::new(move |_env, _args| {
      Err(RuntimeError::Other(format!(
        "the shell root is not reachable from bundle `{ns_for_shell}` — \
         register on the bundle's own receiver"
      )))
    });
    child.borrow_mut().define(
      shell_sym,
      LispValue::Function(Function::NativeClosure(no_shell)),
    );

    for form in body {
      let evaluated = self
        .interp
        .eval_expression(child.clone(), form)
        .map_err(runtime_host_error)?;
      if param.is_none() {
        if let LispValue::List(items) = form {
          if let [LispValue::Symbol(head), definition, ..] = items.items.as_slice() {
            let name = self
              .interp
              .string_interner()
              .resolve(head.as_symbol())
              .unwrap_or("");
            if matches!(name, "define" | "fn" | "struct" | "type" | "trait") {
              let definition = match definition {
                LispValue::List(signature) => signature.items.first(),
                value => Some(value),
              };
              if let Some(name @ LispValue::Symbol(_)) = definition {
                exports.borrow_mut().push(name.clone());
              }
            }
            if name == "impl" {
              if let LispValue::Module(module) = &evaluated {
                if let Some(local) =
                  module
                    .name
                    .rsplit_once('.')
                    .and_then(|(prefix, struct_name)| {
                      prefix
                        .rsplit('.')
                        .next()
                        .map(|trait_name| format!("{trait_name}.{struct_name}"))
                    })
                {
                  exports.borrow_mut().push(LispValue::String(local.into()));
                }
              }
            }
          }
        }
      }
    }

    // Resolve the exports from the bundle scope. The values are ordinary
    // lambdas whose captured env is that scope, so their non-exported helpers
    // stay reachable to them and invisible to the host. The caller mounts
    // them (and caches them for later aliases of the same file).
    let mut resolved: Vec<(String, LispValue<Sym>)> = Vec::new();
    let exported: Vec<LispValue<Sym>> = exports.borrow().clone();
    for entry in exported {
      let (sym, name) = match &entry {
        LispValue::Symbol(sym) => {
          let raw = sym.as_symbol();
          let name = self
            .interp
            .string_interner()
            .resolve(raw)
            .unwrap_or("?")
            .to_string();
          (raw, name)
        }
        LispValue::String(name) => (
          self.interp.string_interner().get_or_intern(name),
          name.to_string(),
        ),
        _ => unreachable!("the :export selector only records symbols and strings"),
      };
      let value = child.borrow().get(sym).ok_or_else(|| {
        LispHostError::Runtime(format!(
          "(m.export '{name}): nothing named {name} was defined"
        ))
      })?;
      resolved.push((name, value));
    }
    Ok(resolved)
  }

  /// Store a JSON-shaped command result under `name` and rebind `prev`
  /// to the same value.
  pub fn define_bind(&mut self, name: Option<&str>, value: HostValue) {
    if let Some(n) = name {
      self.binds.insert(n.to_string(), value.clone());
    }
    self.binds.insert("prev".to_string(), value);
  }

  /// Define a scalar in the persistent lisp env (used by `(let NAME EXPR)`).
  /// Errors if the value isn't a scalar lisp type.
  pub fn define_lisp_scalar(&mut self, name: &str, value: HostValue) -> Result<(), LispHostError> {
    let lisp_v = host_to_lisp(&value)
      .ok_or_else(|| LispHostError::NonScalar(format!("def value for {}", name)))?;
    let sym = self.interp.string_interner().get_or_intern(name);
    self.env.borrow_mut().define(sym, lisp_v);
    Ok(())
  }

  /// Resolve a bare identifier through bind table → lisp env (lookup
  /// only; no expression eval). Returns `None` if neither has it.
  pub fn resolve_ident(&mut self, name: &str) -> Option<HostValue> {
    if let Some(v) = self.binds.get(name) {
      return Some(v.clone());
    }
    let sym = self.interp.string_interner().get(name)?;
    let val = self.env.borrow().get(sym)?;
    lisp_to_host_scalar(&val)
  }

  /// Resolve a dotted path like `prev.id.foo` against the bind table.
  /// Errors on missing key or non-object intermediate.
  ///
  /// Array support: a numeric segment (e.g. `sheets.0.id`) indexes the
  /// array element. The synthetic segment `count` returns the array
  /// length. `String.count` returns the byte length.
  pub fn resolve_path(&self, head: &str, parts: &[&str]) -> Result<HostValue, LispHostError> {
    let root = self
      .binds
      .get(head)
      .ok_or_else(|| LispHostError::Undefined(head.to_string()))?;
    let json = match root {
      HostValue::Json(j) => j.clone(),
      HostValue::Lisp(_) => {
        return Err(LispHostError::PathLookup(format!(
          "cannot path-access scalar bind `{}`",
          head
        )));
      }
    };
    let mut cur: JsonValue = json.as_ref().clone();
    let mut walked = head.to_string();
    for p in parts {
      walked.push('.');
      walked.push_str(p);
      let next: JsonValue = match &cur {
        JsonValue::Object(o) => o.get(*p).cloned().ok_or_else(|| {
          LispHostError::PathLookup(format!("missing key `{}` at `{}`", p, walked))
        })?,
        JsonValue::Array(a) => {
          if *p == "count" {
            JsonValue::Number(serde_json::Number::from(a.len()))
          } else if let Ok(idx) = p.parse::<usize>() {
            a.get(idx).cloned().ok_or_else(|| {
              LispHostError::PathLookup(format!(
                "array index `{}` out of bounds (len {}) at `{}`",
                idx,
                a.len(),
                walked
              ))
            })?
          } else {
            return Err(LispHostError::PathLookup(format!(
              "cannot index array at `{}` with `{}` (expected numeric index or `count`)",
              walked, p
            )));
          }
        }
        JsonValue::String(s) if *p == "count" => {
          JsonValue::Number(serde_json::Number::from(s.len()))
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => {
          return Err(LispHostError::PathLookup(format!(
            "cannot index `{}`: parent at `{}` is not an object or array",
            p, walked
          )));
        }
      };
      cur = next;
    }
    Ok(HostValue::from_json(cur))
  }

  /// Parse + evaluate a single lisp expression in the persistent env.
  pub fn eval_expr(&mut self, source: &str) -> Result<HostValue, LispHostError> {
    let v = self
      .eval_last(source)?
      .ok_or_else(|| LispHostError::Parse("empty expression".to_string()))?;
    lisp_to_host(&v).ok_or_else(|| LispHostError::NonScalar(format!("{:?}", v.as_type())))
  }

  /// Evaluate `source` for its **side effects**, discarding the result. Unlike
  /// [`Self::eval_expr`], this does NOT require the result to be a host scalar:
  /// a top-level statement — `(@import …)`, a `def`, or a command call that
  /// returns `Nil` or a function handle — is valid, and its value is simply
  /// dropped. For statement lines that DO report their value (the script
  /// runner's `LispStmt` arm), [`Self::eval_lisp_line`] is the door;
  /// `eval_expr`'s scalar coercion is only for contexts that consume the value
  /// as a host scalar (binds, interpolation).
  pub fn eval_stmt(&mut self, source: &str) -> Result<(), LispHostError> {
    self.eval_last(source)?;
    Ok(())
  }

  /// Evaluate `source` and return the last form's value as JSON — **without**
  /// the scalar coercion [`Self::eval_expr`] applies. A command call returning a
  /// `table/v1` map (or any structured value) crosses back intact, so the REPL /
  /// one-shot can render it the same way a bare command's return value renders.
  /// An empty source yields `Null`.
  pub fn eval_to_json(&mut self, source: &str) -> Result<JsonValue, LispHostError> {
    Ok(
      self
        .eval_last(source)?
        .as_ref()
        .map(value_to_json)
        .unwrap_or(JsonValue::Null),
    )
  }

  /// Read a posix statement (a command line, or a `name=$(…)` capture) into the
  /// canonical s-expression and evaluate it against the env — the unified posix
  /// path: a shell line becomes the same form a lisp line would, run through one
  /// evaluator. Binds `prev` to the value so the next line can reference it
  /// (`$prev` / `(get prev "field")`); returns the value as JSON intact.
  pub fn eval_posix_line(&mut self, body: &str) -> Result<JsonValue, LispHostError> {
    if let super::parser::LineKind::LispStmt(source) = super::parser::classify(body) {
      return self.eval_lisp_line(source);
    }
    let value = self.read_posix_line_value(body)?;
    self.eval_read_posix_line(&value)
  }

  /// Read once for the script runner's routing and execution steps.
  pub(super) fn read_posix_line_value(
    &mut self,
    body: &str,
  ) -> Result<LispValue<Sym>, LispHostError> {
    self.read_posix_line_value_in(body, false)
  }

  /// [`Self::read_posix_line_value`], marking the displayed command when the
  /// line is an interactive prompt line (argv.md D5).
  pub(super) fn read_posix_line_value_in(
    &mut self,
    body: &str,
    prompt: bool,
  ) -> Result<LispValue<Sym>, LispHostError> {
    self.refresh_shell_flags();
    #[cfg(test)]
    {
      self.posix_reads += 1;
    }
    // Tilde prefixes ride the posix reader (quoting is known only there) and
    // lower to `std.sh.tilde`, which reads $HOME when the word is expanded.
    let home = self.tilde_home();
    // The flow lexer also owns comments on a simple command line.
    let functions: Vec<_> = self.shell_compound.functions.keys().cloned().collect();
    let read = if prompt {
      tento_lisp::read_prompt_plan_with_functions
    } else {
      tento_lisp::read_shell_plan_with_functions
    };
    let sexpr = read(body, self.interp.string_interner(), home.as_deref(), &functions)
      .map_err(|e| LispHostError::Parse(e.to_string()))?;
    let mut value = LispValue::from_owned_sexpression(sexpr)
      .map_err(|e| LispHostError::Parse(format!("{:?}", EvalError::SyntaxError(e))))?;
    self.lower_commands(&mut value);
    self.resolve_command_help(&mut value);
    self.prepare_arithmetic_literals(&value)?;
    self.refresh_shell_symbols();
    Ok(value)
  }

  pub(super) fn eval_read_posix_line(
    &mut self,
    value: &LispValue<Sym>,
  ) -> Result<JsonValue, LispHostError> {
    let result = self.eval_posix_value(value)?;
    self.update_exported_assignment(value).map_err(|e| LispHostError::Command(e.to_string()))?;
    let json = value_to_json(&result);
    self.bind_prev(Self::prev_value(result, &json));
    Ok(json)
  }

  /// Evaluate a lisp line, binding `prev` to its value (uniform with the posix
  /// path). Returns the value as JSON; an empty/`Null` line yields `Null`.
  pub fn eval_lisp_line(&mut self, source: &str) -> Result<JsonValue, LispHostError> {
    let last = self.eval_last(source)?;
    let json = last.as_ref().map(value_to_json).unwrap_or(JsonValue::Null);
    if let Some(v) = last {
      let v = Self::prev_value(v, &json);
      self.bind_prev(v);
    }
    Ok(json)
  }

  /// Evaluate a pre-split posix command (CLI argv, already word-split by the
  /// outer shell) by building `(head arg1 arg2 …)` — head symbol, args string
  /// literals — and evaluating it against the env (binding `prev`). Used by the
  /// one-shot CLI path; argv elements are literal (the outer shell already did
  /// any `$`/`=` expansion).
  pub fn eval_posix_argv(&mut self, argv: Vec<String>) -> Result<JsonValue, LispHostError> {
    self.command_json.set(false);
    if argv.is_empty() {
      return Ok(JsonValue::Null);
    }
    // The pre-split argv reads into the SAME s-expression a posix line or a lisp
    // call does: head symbol and string-literal words. The outer
    // shell already de-quoted and `$`-expanded, so every word is literal.
    let interner = self.interp.string_interner();
    let sexpr = tento_lisp::read_posix_argv(&argv, interner)
      .map_err(|e| LispHostError::Parse(e.to_string()))?;
    let mut value = LispValue::from_owned_sexpression(sexpr)
      .map_err(|e| LispHostError::Parse(format!("{:?}", EvalError::SyntaxError(e))))?;
    self.resolve_command_help(&mut value);
    let result = self.eval_posix_value(&value)?;
    let json = value_to_json(&result);
    self.bind_prev(Self::prev_value(result, &json));
    Ok(json)
  }

  /// The shared sync-eval core of [`Self::eval_posix_line`] /
  /// [`Self::eval_posix_argv`]: evaluate a posix-read statement, mapping an
  /// undefined *head* (not a nested symbol) to the same command-not-found text
  /// the async twins produce — a head is an unknown COMMAND, and the bare-word
  /// "quote it for a string" teaching is actively wrong advice there (quoting
  /// the head runs nothing). Argument-position unbound symbols keep the
  /// enrichment via [`runtime_host_error`].
  fn eval_posix_value(&mut self, value: &LispValue<Sym>) -> Result<LispValue<Sym>, LispHostError> {
    self.seal_types();
    self.command_json.set(false);
    self.refresh_nested_commands();
    let head = self.application_head(value);
    if super::bash_flow::is_flow(head.as_deref()) || self.shell_compound_value(head.as_deref(), value) {
      return self.eval_flow_sync(value);
    }
    let evaluated = match &head {
      Some(name) if self.shadowed_by_lisp_binding(name) => {
        Err(RuntimeError::UndefinedSymbol { detail: name.clone() })
      }
      _ => self.interp.eval_expression(self.env.clone(), value),
    };
    match evaluated {
      Ok(result) => {
        if !self.call_owns_reflection(value) { self.command_json.set(false); }
        Ok(result)
      }
      Err(RuntimeError::UndefinedSymbol { detail }) if head.as_deref() == Some(detail.as_str()) => {
        if let Some(doc) = self.expanded_namespace_help(value).map_err(|error| LispHostError::Command(error.to_string()))? {
          return Ok(value_from_json(&doc));
        }
        Err(LispHostError::Runtime(
          self.command_not_found(&detail).to_string(),
        ))
      }
      Err(e) => Err(runtime_host_error(e)),
    }
  }

  /// Async twin of [`Self::eval_posix_argv`] for the **top-level** run loop: a
  /// registered command (by canonical name) is dispatched through the async
  /// table and its future is `.await`ed directly, so a genuinely-async
  /// daemon/streaming command resolves (the sync env path would `now_or_never`
  /// it and error "call it as a shell line"). Everything else — `help`, a unix
  /// alias (`ls` -> `std.fs.list_dir`), a `def`, or an unknown name — falls
  /// through to the synchronous [`Self::eval_posix_argv`].
  /// Binds `prev` either way. This is the seam the TUI exec loop uses in place
  /// of the retired `run_loop::exec`.
  pub async fn eval_posix_argv_async(&mut self, argv: Vec<String>) -> crate::Result<JsonValue> {
    self.seal_types();
    self.command_json.set(false);
    if argv.is_empty() {
      return Ok(JsonValue::Null);
    }
    let mut argv = argv;
    // A headless `--help` in COMMAND position (`tsh --help`) is the universal
    // `help` command. Per-command help is resolved below using the typed head;
    // `-h` always stays an ordinary command word.
    if let Some(alias) = head_flag_alias(&argv[0]) {
      argv[0] = alias.to_string();
    }
    // Everything through the tokenizer: the pre-split argv reads into the SAME
    // s-expression a posix line does, and the fast path dispatches THAT. A
    // registered async command is awaited directly (so a genuinely-async
    // daemon/streaming command resolves); its args evaluate on the sync engine
    // (in-process subs resolve) and re-lower to argv. Everything else — `help`,
    // a unix-alias `def`, a lisp form — evaluates on the sync engine.
    // Identical to `eval_posix_line_async` past the parse; the door differs
    // (pre-split argv vs a line).
    let mut value = {
      let interner = self.interp.string_interner();
      let sexpr = tento_lisp::read_posix_argv(&argv, interner)
        .map_err(|e| crate::Error::Other(anyhow::anyhow!("{e}")))?;
      LispValue::from_owned_sexpression(sexpr)
        .map_err(|e| crate::Error::Other(anyhow::anyhow!("parse: {e}")))?
    };
    self.resolve_command_help(&mut value);
    if !self.shell_aliases.is_empty() || self.application_head(&value).as_deref() == Some("env") {
      let result = self.eval_shell_destination_async(&value, false).await;
      if let Err(crate::Error::CommandNotFound { name, .. }) = &result {
        if let Some(error) = bare_file_refusal(name, std::path::Path::new(name).is_file()) {
          return Err(error);
        }
      }
      return result;
    }
    let head = self.application_head(&value);
    if let Some(name) = &head {
      // The one-shot `tsh <ns>.<cmd> …` door: a lazily recorded namespace
      // must be mounted before the async table is consulted, or a daemon
      // command falls to the sync native that refuses it.
      if let Some((namespace, _)) = name.split_once('.') {
        self.mount_lazy_namespace(namespace);
      }
      let dispatch = self.async_commands.borrow().get(name).cloned();
      if let Some(dispatch) = dispatch.filter(|_| !self.mount_yields_to_program(name)) {
        let argv = self.application_to_argv(&value)?;
        let result = dispatch(argv)?.await?;
        self.bind_prev(value_from_json(&result));
        return Ok(result);
      }
    }
    // Not a registered command. An undefined *head* (not a nested symbol) is an
    // unknown command: consult the external hook with the RAW argv (words
    // verbatim, so `git status -sb` and `git --help` reach
    // git untouched), then restore the structured `CommandNotFound`
    // (nearest-match + available) rather than the env's bare "undefined symbol".
    // A mount word with a program of its name is that program (Refinement 4).
    let evaluated = match &head {
      Some(name) if self.mount_yields_to_program(name) => Err(RuntimeError::UndefinedSymbol { detail: name.clone() }),
      _ => self.interp.eval_expression(self.env.clone(), &value),
    };
    match evaluated {
      Ok(result) => {
        if !self.call_owns_reflection(&value) { self.command_json.set(false); }
        let json = value_to_json(&result);
        self.bind_prev(Self::prev_value(result, &json));
        Ok(json)
      }
      Err(RuntimeError::UndefinedSymbol { detail }) if head.as_deref() == Some(detail.as_str()) => {
        if let Some(doc) = self.expanded_namespace_help(&value)? { return Ok(doc); }
        if let Some(external) = self.external.clone() {
          match external.lookup(&detail) {
            ExternalLookup::Runs => {
              super::shell_printf::prepare_printf_argv(&mut argv);
              let _output_boundary = super::process_pipeline::OutputBoundary::enter();
              self.command_json.set(false);
              let result = self.run_external_argv(external.clone(), argv).await?;
              self.bind_prev(value_from_json(&result));
              return Ok(result);
            }
            ExternalLookup::Undeclared(path) => return Err(undeclared_external(&detail, &path)),
            ExternalLookup::NotFound => {
              if let Some(error) = bare_file_refusal(&detail, std::path::Path::new(&detail).is_file()) {
                return Err(error);
              }
              if external.not_executable(&detail) {
                return Err(crate::Error::ProcessStart {
                  status: 126,
                  detail: format!("{detail}: Permission denied"),
                });
              }
            }
          }
        }
        if let Some(error) = bare_file_refusal(&detail, std::path::Path::new(&detail).is_file()) {
          return Err(error);
        }
        Err(self.command_not_found(&detail))
      }
      Err(e) => Err(crate::Error::Other(anyhow::anyhow!("{e}"))),
    }
  }

  pub(super) fn shell_background_builtin(head: Option<&str>) -> bool {
    matches!(
      head,
      Some("echo" | "printf" | "cd" | "pwd" | "rm" | "export" | "std.sh.set" | "test" | "[" | ":" | "true" | "false" | "read" | "local" | "declare" | "typeset" | "readonly" | "getopts" | "shift" | "return" | "break" | "continue" | "exit")
    )
  }

  pub(super) fn shell_external_stage(&mut self, value: &LispValue<Sym>) -> bool {
    let head = self.application_head(value);
    if self.shell_compound_value(head.as_deref(), value) { return false; }
    if Self::shell_background_builtin(head.as_deref()) { return false; }
    if head.as_ref().is_some_and(|name| self.shell_compound.functions.contains_key(name)) { return false; }
    let async_mount = self.posix_value_is_async_mount(value);
    let unbound = self.posix_value_is_unbound(value);
    (async_mount && unbound || head.as_ref().is_some_and(|name| self.shell_utility(name)))
      && head.as_ref().is_some_and(|name| {
        self
          .external
          .as_ref()
          .is_some_and(|external| matches!(external.lookup(name), ExternalLookup::Runs))
      })
  }

  pub(super) async fn run_shell_pipeline(
    &mut self,
    mut argv: Vec<Vec<String>>,
    input: Option<Vec<u8>>,
    capture: bool,
    io: Vec<Option<super::ShellIo>>,
  ) -> crate::Result<super::ShellCapture> {
    let external = self.external.clone().ok_or_else(|| {
      crate::Error::Other(anyhow::anyhow!("external pipeline host is not installed"))
    })?;
    for stage in &mut argv { super::shell_printf::prepare_printf_argv(stage); }
    let _output_boundary = super::process_pipeline::OutputBoundary::enter();
    // At a terminal the interactive shell owns, a foreground pipeline is a
    // job: its own process group, given the terminal (Ctrl-Z stops it).
    if !capture && input.is_none() && self.job_control() && super::shell_jobs::terminal::owned() {
      let command = super::shell_jobs::pipeline_text(&argv);
      if let Some(started) = external.start_foreground(argv.clone(), io.clone()) {
        return self.run_foreground_job(started?, command).await;
      }
    }
    external.run_pipeline_with_io(argv, input, capture, io).await
  }

  pub(super) fn evaluate_shell_data(&mut self, value: &LispValue<Sym>) -> Result<JsonValue, LispHostError> {
    self.interp.eval_expression(self.env.clone(), value)
      .map(|value| value_to_json(&value)).map_err(runtime_host_error)
  }

  /// Install the external-program hook (see [`ExternalCommands`]). One per
  /// host; the embedding shell installs it at host construction.
  pub fn set_external_commands(&mut self, external: Rc<dyn ExternalCommands>) {
    self.external = Some(external);
  }

  /// True when `head` is a namespace prefix of some dispatchable command
  /// (`std` for `std.fs.list_dir`), rather than a bound command itself — the
  /// signal that `<head> --help` should route to namespace help.
  fn is_namespace(&mut self, head: &str) -> bool {
    if let Some(namespace) = head.split('.').next() { self.mount_lazy_namespace(namespace); }
    let symbol = self.interp.string_interner().get_or_intern(head);
    self.env.borrow().get(symbol).is_none()
      && (self.command_names.iter().any(|n| n.starts_with(&format!("{head}.")))
        || self.command_natives.borrow().keys().any(|n| n.starts_with(&format!("{head}."))))
  }

  /// Build the structured `CommandNotFound` the retired `exec` produced — a
  /// nearest-match suggestion + the available command list — from the names
  /// registered on this host, falling back to the external hook's index
  /// (`gti status` suggests `git`) when no registered name is close.
  fn command_not_found(&self, typed: &str) -> crate::Error {
    let suggestion = crate::run_loop::nearest_match(typed, &self.command_names)
      .or_else(|| self.external.as_ref().and_then(|e| e.suggest(typed)));
    crate::Error::CommandNotFound {
      name: typed.to_string(),
      suggestion,
      available: self.command_names.clone(),
    }
  }

  /// Async twin of [`Self::eval_posix_line`] for an interactive line (the
  /// REPL): a registered async command at the top level is awaited directly,
  /// and an unknown command head yields the structured `CommandNotFound`
  /// (nearest-match + available) — line-path parity with
  /// [`Self::eval_posix_argv_async`]. Everything else (a `def` capture, a lisp
  /// form, an in-process command) evaluates on the sync engine.
  pub async fn eval_posix_line_async(&mut self, body: &str) -> crate::Result<JsonValue> {
    self.seal_types();
    if let super::parser::LineKind::Refused { form, rest } = super::parser::classify(body) {
      return Err(crate::Error::Other(anyhow::anyhow!(
        "{}", super::parser::lisp_trailer_message(form, rest),
      )));
    }
    if let super::parser::LineKind::LispStmt(body) = super::parser::classify(body) {
      return self
        .eval_lisp_host_line(body)
        .await
        .map_err(|error| match error {
          super::runner::TshScriptErrorKind::Command(error) => error,
          // A status-carrying failure keeps its status to the process exit.
          super::runner::TshScriptErrorKind::Lisp(LispHostError::Exit { status, message }) => {
            crate::Error::ProcessExit { status: Some(status), signal: None, detail: message }
          }
          error => crate::Error::Other(anyhow::anyhow!("{error}")),
        });
    }
    #[cfg(test)]
    {
      self.posix_reads += 1;
    }
    // Same tilde door as `eval_posix_line`.
    let home = self.tilde_home();
    let functions: Vec<_> = self.shell_compound.functions.keys().cloned().collect();
    let sexpr =
      tento_lisp::read_shell_plan_with_functions(body, self.interp.string_interner(), home.as_deref(), &functions)
        .map_err(|e| crate::Error::Other(anyhow::anyhow!("{e}")))?;
    let mut value = LispValue::from_owned_sexpression(sexpr)
      .map_err(|e| crate::Error::Other(anyhow::anyhow!("parse: {e}")))?;
    self.lower_commands(&mut value);
    self.resolve_command_help(&mut value);
    self.prepare_arithmetic_literals(&value).map_err(|e| crate::Error::Other(anyhow::anyhow!("{e}")))?;
    self.refresh_shell_symbols();
    if !self.shell_aliases.is_empty() || self.application_head(&value).as_deref() == Some("env") {
      return self.eval_shell_destination_async(&value, false).await;
    }
    self.eval_read_posix_line_async(&value).await
  }

  pub(super) async fn eval_read_posix_line_async(
    &mut self,
    value: &LispValue<Sym>,
  ) -> crate::Result<JsonValue> {
    self.command_json.set(false);
    self.refresh_nested_commands();
    let head = self.application_head(value);
    if super::bash_flow::is_flow(head.as_deref()) || self.shell_compound_value(head.as_deref(), value) {
      return super::bash_flow::eval_flow(self, value, 1, false, Default::default(), true)
        .await
        .map(|value| value.unwrap_or(JsonValue::Null))
        .map_err(|error| match error {
          super::runner::TshScriptErrorKind::Command(error) => error,
          super::runner::TshScriptErrorKind::BashStatus(status) => crate::Error::ProcessExit {
            status: Some(status),
            signal: None,
            detail: format!("exit status {status}"),
          },
          error => crate::Error::Other(anyhow::anyhow!("{error}")),
        });
    }
    // A registered async command run as a line: evaluate its args on the sync
    // engine (nested in-process subs resolve), then await the outer command.
    if let Some(name) = &head {
      if let Some((namespace, _)) = name.split_once('.') {
        self.mount_lazy_namespace(namespace);
      }
      let dispatch = self.async_commands.borrow().get(name).cloned();
      if let Some(dispatch) = dispatch.filter(|_| !self.mount_yields_to_program(name)) {
        let argv = self.application_to_argv(value)?;
        let result = dispatch(argv)?.await?;
        self.bind_prev(value_from_json(&result));
        return Ok(result);
      }
    }
    // Sync eval; an undefined *head* (not a nested symbol) is an unknown
    // command — consulted against the external hook first (argv reconstructed
    // via [`Self::application_to_argv`]: args evaluate, so `$(…)` subs resolve;
    // keywords re-lower to `--flags`), then `CommandNotFound`.
    let evaluated = match &head {
      Some(name) if self.shadowed_by_lisp_binding(name) => {
        Err(RuntimeError::UndefinedSymbol { detail: name.clone() })
      }
      _ => self.interp.eval_expression(self.env.clone(), value),
    };
    match evaluated {
      Ok(result) => {
        if !self.call_owns_reflection(value) { self.command_json.set(false); }
        self.update_exported_assignment(value)?;
        let json = value_to_json(&result);
        self.bind_prev(Self::prev_value(result, &json));
        Ok(json)
      }
      Err(RuntimeError::UndefinedSymbol { detail }) if head.as_deref() == Some(detail.as_str()) => {
        if let Some(doc) = self.expanded_namespace_help(value)? { return Ok(doc); }
        if let Some(external) = self.external.clone() {
          match external.lookup(&detail) {
            ExternalLookup::Runs => {
              let mut argv = self.external_call_argv(value)?;
              super::shell_printf::prepare_printf_argv(&mut argv);
              let _output_boundary = super::process_pipeline::OutputBoundary::enter();
              self.command_json.set(false);
              let result = self.run_external_argv(external.clone(), argv).await?;
              self.bind_prev(value_from_json(&result));
              return Ok(result);
            }
            ExternalLookup::Undeclared(path) => return Err(undeclared_external(&detail, &path)),
            ExternalLookup::NotFound => {
              if external.not_executable(&detail) {
                return Err(crate::Error::ProcessStart {
                  status: 126,
                  detail: format!("{detail}: Permission denied"),
                });
              }
            }
          }
        }
        Err(self.command_not_found(&detail))
      }
      Err(e) => Err(crate::Error::Other(anyhow::Error::new(e))),
    }
  }

  /// The head command name if `value` is `(head args…)` with a Symbol head.
  pub(super) fn application_head(&mut self, value: &LispValue<Sym>) -> Option<String> {
    if self.is_split_application(value) {
      let LispValue::List(list) = value else {
        unreachable!()
      };
      let LispValue::Symbol(command) = &list.items[1] else {
        unreachable!()
      };
      return self
        .interp
        .string_interner()
        .resolve(command.as_symbol())
        .map(str::to_string);
    }
    if let LispValue::List(list) = value {
      if let Some(LispValue::Symbol(sym)) = list.items.first() {
        return self
          .interp
          .string_interner()
          .resolve(sym.as_symbol())
          .map(str::to_string);
      }
    }
    None
  }

  /// Only namespaces need routing; commands bind reflection after evaluation.
  /// Quoted data and user functions are never rewritten by this traversal.
  fn resolve_command_help(&mut self, value: &mut LispValue<Sym>) {
    let head = self.application_head(value);
    if head.as_deref() == Some("quote") { return; }
    if let Some(name) = head.as_ref().filter(|name| self.is_namespace(name)) {
      if let LispValue::List(list) = value {
        let help = list.items.iter().skip(1).take_while(|arg|
          !matches!(arg, LispValue::String(s) if s == "--"))
          .any(|arg| match arg {
            LispValue::String(s) => matches!(s.as_str(), "--help" | ":help"),
            LispValue::Symbol(sym) => self.interp.string_interner().resolve(sym.as_symbol()) == Some(":help"),
            _ => false,
          });
        if help {
          list.items[0] = LispValue::from_owned_sexpression(tento_lisp::SExpression::Literal(tento_lisp::Literal::Symbol(self.interp.string_interner().get_or_intern("help")))).expect("help symbol");
          list.items.insert(1, LispValue::String(name.as_str().into()));
        }
      }
    }
  }

  fn expanded_namespace_help(&mut self, value: &LispValue<Sym>) -> crate::Result<Option<JsonValue>> {
    let Some(head) = self.application_head(value) else { return Ok(None); };
    if !self.is_namespace(&head) { return Ok(None); }
    let mut argv = self.application_to_argv(value)?;
    let options = super::arg_bind::take_reflection_argv(&mut argv);
    if !options.help { return Ok(None); }
    let mut help = vec!["help".into(), head];
    if options.json { help.push("--json".into()); }
    self.eval_posix_argv(help).map(Some).map_err(|error| crate::Error::Other(anyhow::anyhow!("{error}")))
  }

  fn call_owns_reflection(&mut self, value: &LispValue<Sym>) -> bool {
    let Some(head) = self.application_head(value) else { return false; };
    let Some(mut called) = self.native_named(&head) else { return false; };
    // A binding of a retired command's bare name (`cmd=std.fs.list_dir;
    // $cmd --json`) owns what its replacement owns.
    if let Some(old) = self.interp.deprecated_call_of(&called).map(str::to_string) {
      let Some(target) = self.native_named(&old) else { return false; };
      called = target;
    }
    self.command_natives.borrow().values().any(|native| Rc::ptr_eq(native, &called))
  }

  /// The native closure `name` is bound to, a deprecated spelling resolving
  /// to its replacement's (`std.fs.list_dir` → `std.coreutil.ls`).
  fn native_named(&mut self, name: &str) -> Option<NativeClosure<Sym>> {
    let name = self.interp.deprecated_target(name).map_or_else(|| name.to_string(), |target| target.name);
    let symbol = self.interp.string_interner().get_or_intern(name);
    match self.env.borrow().get(symbol) {
      Some(LispValue::Function(Function::NativeClosure(native))) => Some(native),
      _ => None,
    }
  }

  /// Whether the last bash/argv command requested JSON at its text boundary.
  /// The value itself stays ordinary data; Lisp calls reset this presentation.
  pub fn command_json_output(&self) -> bool { self.command_json.get() }

  /// Keep shell fields as text. Only a keyword in the reader's syntax owns
  /// flag lowering; a colon supplied by expansion or a quoted string is data.
  fn shell_fields_to_argv(&mut self, fields: &LispValue<Sym>) -> crate::Result<Vec<String>> {
    let LispValue::List(words) = fields else {
      return Err(crate::Error::Other(anyhow::anyhow!(
        "expanded argv must be a list"
      )));
    };
    let mut argv = Vec::new();
    for word in words.items.iter().skip(1) {
      if let LispValue::List(single) = word {
        if single.items.len() == 2 && self.application_head(word).as_deref() == Some("list") {
          if let LispValue::Symbol(symbol) = &single.items[1] {
            if let Some(flag) = self
              .interp
              .string_interner()
              .resolve(symbol.as_symbol())
              .and_then(|name| name.strip_prefix(':'))
            {
              argv.push(format!("--{flag}"));
              continue;
            }
          }
        }
      }
      let value = self
        .interp
        .eval_expression(self.env.clone(), word)
        .map_err(|e| crate::Error::Other(anyhow::Error::new(e)))?;
      let LispValue::List(values) = value else {
        return Err(crate::Error::Other(anyhow::anyhow!(
          "expanded word must yield fields"
        )));
      };
      for value in values.items {
        match value {
          LispValue::String(text) => argv.push(text.into_string()),
          value => argv.extend(
            super::lisp_args_to_argv("", vec![value])
              .into_iter()
              .skip(1),
          ),
        }
      }
    }
    Ok(argv)
  }

  /// Lower `(head arg-exprs…)` to argv: evaluate each arg on the sync engine,
  /// then [`lisp_args_to_argv`] (head at `[0]`). Hands a posix line to an async
  /// command via the same argv door the dispatch table expects.
  pub(super) fn application_to_argv(
    &mut self,
    value: &LispValue<Sym>,
  ) -> crate::Result<Vec<String>> {
    if self.is_computed_command(value) {
      let LispValue::List(list) = value else {
        unreachable!()
      };
      let [_, fields] = list.items.as_slice() else {
        return Err(crate::Error::Other(anyhow::anyhow!(
          "std.sh.cmd: expected fields"
        )));
      };
      return self.shell_fields_to_argv(fields);
    }
    if self.is_split_application(value) {
      let head = self
        .application_head(value)
        .expect("split application head");
      let LispValue::List(list) = value else {
        unreachable!()
      };
      let mut argv = vec![super::shell_cmd::builtin_word(head)];
      argv.extend(self.shell_fields_to_argv(&list.items[2])?);
      return Ok(argv);
    }
    let LispValue::List(list) = value else {
      return Err(crate::Error::Other(anyhow::anyhow!(
        "not a command application"
      )));
    };
    let head = match list.items.first() {
      Some(LispValue::Symbol(sym)) => self
        .interp
        .string_interner()
        .resolve(sym.as_symbol())
        .map(str::to_string)
        .ok_or_else(|| crate::Error::Other(anyhow::anyhow!("unresolved command head")))?,
      _ => {
        return Err(crate::Error::Other(anyhow::anyhow!(
          "not a command application"
        )));
      }
    };
    let mut arg_vals = Vec::with_capacity(list.items.len().saturating_sub(1));
    for a in &list.items[1..] {
      let v = self
        .interp
        .eval_expression(self.env.clone(), a)
        .map_err(|e| crate::Error::Other(anyhow::Error::new(e)))?;
      let keyword = matches!(a, LispValue::Symbol(symbol)
        if self.interp.string_interner().resolve(symbol.as_symbol()).is_some_and(|name| name.starts_with(':')));
      arg_vals.push((v, keyword));
    }
    let mut argv = vec![super::shell_cmd::builtin_word(head)];
    for (value, keyword) in arg_vals {
      match value {
        LispValue::String(text) if !keyword => argv.push(text.into_string()),
        value => argv.extend(
          super::lisp_args_to_argv("", vec![value])
            .into_iter()
            .skip(1),
        ),
      }
    }
    Ok(argv)
  }

  /// Bind `prev` in the env to the most recent line's value. Takes the value
  /// itself: a Lisp result is moved in, never copied, so a 64 MiB string a
  /// one-shot prints is not duplicated to become `prev`.
  fn bind_prev(&mut self, value: LispValue<Sym>) {
    let sym = self.interp.string_interner().get_or_intern("prev");
    self.env.borrow_mut().define(sym, value);
  }

  /// What `prev` holds after a form answered `result`, whose JSON for the
  /// runner is `json`: the value itself when the JSON carries it whole (text,
  /// numbers, booleans, nil, and lists and maps of those), so no copy is
  /// made; otherwise the value rebuilt from the JSON, as `prev` always was,
  /// so an error, a function, a type or a symbol still reads back as the
  /// record or `nil` the JSON bridge makes of it.
  fn prev_value(result: LispValue<Sym>, json: &JsonValue) -> LispValue<Sym> {
    if json_faithful(&result) { result } else { value_from_json(json) }
  }

  fn flow_host_error(error: super::runner::TshScriptErrorKind) -> LispHostError {
    match error {
      super::runner::TshScriptErrorKind::Lisp(error) => error,
      super::runner::TshScriptErrorKind::Command(error) => {
        LispHostError::Command(error.to_string())
      }
      error => LispHostError::Command(error.to_string()),
    }
  }

  fn eval_flow_sync(&mut self, value: &LispValue<Sym>) -> Result<LispValue<Sym>, LispHostError> {
    use futures::FutureExt;
    let result = super::bash_flow::eval_flow(self, value, 1, false, Default::default(), true)
      .now_or_never()
      .ok_or_else(|| {
        LispHostError::Runtime(
          "std.flow: asynchronous stages must run through the script or async host door".into(),
        )
      })?
      .map_err(Self::flow_host_error)?;
    Ok(value_from_json(&result.unwrap_or(JsonValue::Null)))
  }

  pub(super) async fn eval_lisp_host_line(
    &mut self,
    source: &str,
  ) -> Result<JsonValue, super::runner::TshScriptErrorKind> {
    self.seal_types();
    let _json_reset = LispOutputReset(self.command_json.clone());
    self.command_json.set(false);
    let asts =
      tento_lisp::Runtime::<Sym, StringBackend>::parse(None, source, self.interp.string_interner())
        .map_err(|error| super::runner::TshScriptErrorKind::Lisp(syntax_host_error(error)))?;
    self.refresh_shell_symbols();
    self.refresh_nested_commands();
    let flow_source = tento_lisp::SH_FLOW_FORMS.iter().any(|form| source.contains(form))
      || source.contains(super::shell_cmd::SHELL_COMMAND);
    let has_forms = !asts.is_empty();
    let mut last = JsonValue::Null;
    // The last Lisp result, kept for the final `prev` binding so it is not
    // rebuilt from its JSON; a flow or program result has only the JSON.
    let mut last_value: Option<LispValue<Sym>> = None;
    for ast in asts {
      let mut value = LispValue::from_owned_sexpression(ast).map_err(|error| {
        super::runner::TshScriptErrorKind::Lisp(LispHostError::Parse(format!("{error}")))
      })?;
      self.respell_deprecated(&mut value);
      // A top-level `(std.sh.cmd …)` is a bash command: it resolves by bash's
      // lookup, so it runs on the flow door rather than the Lisp evaluator.
      let bash_command = self.application_head(&value).as_deref() == Some(super::shell_cmd::SHELL_COMMAND);
      // `(std.sh.call …)` statements run here, where the host can await.
      self.run_statement_shell_calls(&mut value).await?;
      self.refuse_bash_word_head(&value)?;
      self.lower_commands(&mut value);
      self.resolve_command_help(&mut value);
      if bash_command || super::bash_flow::is_flow(self.application_head(&value).as_deref()) {
        last = super::bash_flow::eval_flow(self, &value, 1, false, Default::default(), true)
          .await?
          .unwrap_or(JsonValue::Null);
        last_value = None;
        if flow_source { self.bind_prev(value_from_json(&last)); }
      } else if self.lisp_head_unbound(&value)
        && self.application_head(&value).is_some_and(|head| self.external.as_ref().is_some_and(|external|
          matches!(external.lookup(&head), ExternalLookup::Runs | ExternalLookup::Undeclared(_))))
      {
        last = self.eval_read_posix_line_async(&value).await
          .map_err(super::runner::TshScriptErrorKind::Command)?;
        last_value = None;
      } else {
        let result = if self.import_sequence(&value) {
          self.eval_import_sequence(&value)
        } else {
          self.interp.eval_expression(self.env.clone(), &value).map_err(runtime_host_error)
        }.map_err(super::runner::TshScriptErrorKind::Lisp)?;
        last = value_to_json(&result);
        let result = Self::prev_value(result, &last);
        if flow_source { self.bind_prev(result); } else { last_value = Some(result); }
      }
      self.process_pending_rc().map_err(super::runner::TshScriptErrorKind::Lisp)?;
    }
    if !flow_source && has_forms {
      match last_value.take() {
        Some(result) => self.bind_prev(result),
        None => self.bind_prev(value_from_json(&last)),
      }
    }
    Ok(last)
  }

  /// Parse + evaluate every form in `source`, returning the last form's raw
  /// lisp value (or `None` for an empty source). Shared core of [`Self::eval_expr`]
  /// and [`Self::eval_stmt`]; neither host-bridge conversion nor scalar
  /// validation happens here.
  fn eval_last(&mut self, source: &str) -> Result<Option<LispValue<Sym>>, LispHostError> {
    self.seal_types();
    let _json_reset = LispOutputReset(self.command_json.clone());
    self.command_json.set(false);
    let asts = {
      let interner = self.interp.string_interner();
      tento_lisp::Runtime::<Sym, StringBackend>::parse(None, source, interner)
        .map_err(syntax_host_error)?
    };
    let mut last: Option<LispValue<Sym>> = None;
    self.refresh_shell_symbols();
    self.refresh_nested_commands();
    for ast in asts {
      let mut value = LispValue::from_owned_sexpression(ast)
        .map_err(|e| LispHostError::Parse(format!("{:?}", EvalError::SyntaxError(e))))?;
      let bash_command = self.application_head(&value).as_deref() == Some(super::shell_cmd::SHELL_COMMAND);
      self.lower_commands(&mut value);
      self.resolve_command_help(&mut value);
      let r = if !bash_command && self.import_sequence(&value) {
        self.eval_import_sequence(&value)?
      } else if bash_command || super::bash_flow::is_flow(self.application_head(&value).as_deref()) {
        self.eval_flow_sync(&value)?
      } else {
        self
          .interp
          .eval_expression(self.env.clone(), &value)
          .map_err(runtime_host_error)?
      };
      last = Some(r);
      self.process_pending_rc()?;
    }
    Ok(last)
  }

  /// Host-level program sequencing: imports queue rc while the interpreter is
  /// borrowed. Drain at expression boundaries, including a serialized fleet
  /// program, without re-entering the interpreter during an import callback.
  fn import_sequence(&mut self, value: &LispValue<Sym>) -> bool {
    match self.application_head(value).as_deref() {
      Some("begin") => true,
      Some("json-stringify") => matches!(value, LispValue::List(list)
        if list.items.len() == 2 && self.application_head(&list.items[1]).as_deref() == Some("begin")),
      _ => false,
    }
  }

  fn eval_import_sequence(&mut self, value: &LispValue<Sym>) -> Result<LispValue<Sym>, LispHostError> {
    self.eval_import_sequence_at(value, 0)
  }

  fn eval_import_sequence_at(&mut self, value: &LispValue<Sym>, depth: usize) -> Result<LispValue<Sym>, LispHostError> {
    if depth >= 256 {
      return Err(LispHostError::Runtime("program sequencing exceeds 256 nested forms".into()));
    }
    let LispValue::List(list) = value else { unreachable!("sequence is a list"); };
    if self.application_head(value).as_deref() == Some("json-stringify") {
      let result = self.eval_import_sequence_at(&list.items[1], depth + 1)?;
      let quote = self.interp.string_interner().get_or_intern("quote");
      let quoted = LispValue::List(tento_lisp::List { items: vec![LispValue::Symbol(quote.into()), result].into() });
      let call = LispValue::List(tento_lisp::List { items: vec![list.items[0].clone(), quoted].into() });
      return self.interp.eval_expression(self.env.clone(), &call).map_err(runtime_host_error);
    }
    let mut result = LispValue::Nil;
    for expression in &list.items[1..] {
      result = if self.import_sequence(expression) {
        self.eval_import_sequence_at(expression, depth + 1)?
      } else {
        // Retain the enclosing call context: unbound nested command heads
        // have a shell fallback, while a top-level unbound symbol does not.
        let begin = self.interp.string_interner().get_or_intern("begin");
        let member = LispValue::List(tento_lisp::List {
          items: vec![LispValue::Symbol(begin.into()), expression.clone()].into(),
        });
        self.interp.eval_expression(self.env.clone(), &member).map_err(runtime_host_error)?
      };
      self.process_pending_rc()?;
    }
    Ok(result)
  }

  /// Convenience: eval an expression and collapse to truthy/falsy.
  pub fn eval_truthy(&mut self, source: &str) -> Result<bool, LispHostError> {
    Ok(self.eval_expr(source)?.truthy())
  }

  /// Register a closure-bearing host function. The persistent lisp env
  /// binds `name` to a callable that, when invoked from lisp, coerces
  /// arguments to `HostValue` (via `lisp_to_host_scalar`) and the
  /// return value back to `LispValue` (via `host_to_lisp`). Non-scalar
  /// arguments or returns surface as a runtime error tagged with `name`.
  ///
  /// Use this for app-specific commands that need to capture state
  /// (e.g. `(recheck "host-a/admin.acme")` mutating a `RefCell<TuiState>`).
  /// The closure must be `'static` so the resulting `Rc<dyn Fn>` can live
  /// alongside the interpreter.
  pub fn register_native_closure<F>(&mut self, name: &str, f: F)
  where
    F: Fn(Vec<HostValue>) -> Result<HostValue, LispHostError> + 'static,
  {
    self.native_defs.push(name.to_string());
    let owned_name = name.to_string();
    let closure: NativeClosure<Sym> = std::rc::Rc::new(move |_env, args| {
      let mut hargs = Vec::with_capacity(args.len());
      for a in &args {
        let h = lisp_to_host_scalar(a).ok_or_else(|| RuntimeError::TypeError {
          expected: format!("{} arg as scalar", owned_name),
          got: format!("{:?}", a.as_type()),
        })?;
        hargs.push(h);
      }
      let out = f(hargs).map_err(|e| native_runtime_error(&owned_name, e))?;
      host_to_lisp(&out).ok_or_else(|| RuntimeError::TypeError {
        expected: format!("{} return as scalar", owned_name),
        got: "non-scalar HostValue".to_string(),
      })
    });
    let sym = self.interp.string_interner().get_or_intern(name);
    self.define_host_binding(sym, LispValue::Function(Function::NativeClosure(closure)));
  }

  /// Register an RAII scope around a zero-argument Lisp thunk. Entry returns
  /// the thunk and an opaque lifetime token; the interpreter drops the token
  /// on success, error or unwinding, without re-entering a second interpreter.
  pub fn register_native_scope<F>(&mut self, name: &str, enter: F)
  where
    F: Fn(Vec<LispValue<Sym>>) -> Result<(LispValue<Sym>, Box<dyn std::any::Any>), LispHostError>
      + 'static,
  {
    self.native_defs.push(name.to_owned());
    let owned = name.to_owned();
    let value = self.interp.native_scope(Rc::new(move |args| {
      enter(args).map_err(|e| native_runtime_error(&owned, e))
    }));
    let sym = self.interp.string_interner().get_or_intern(name);
    self.define_host_binding(sym, value);
  }

  /// Like [`register_native_closure`] but skips the host-scalar coercion at
  /// the boundary: the closure receives the raw `LispValue` args and returns
  /// a raw `LispValue`. Use when a native takes a non-scalar lisp value as
  /// input (e.g. a `(lambda …)` argument) or wants to return one. Errors
  /// are reported the same way (tagged with `name`).
  pub fn register_native_special<F>(&mut self, name: &str, f: F)
  where
    F: Fn(Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, LispHostError> + 'static,
  {
    self.native_defs.push(name.to_string());
    let owned_name = name.to_string();
    let closure: NativeClosure<Sym> =
      std::rc::Rc::new(move |_env, args| f(args).map_err(|e| native_runtime_error(&owned_name, e)));
    // `f` sees only its arguments, never the caller's scope: calling it
    // leaves a lambda's frame releasable (tento-lisp's `tail`).
    self.interp.declare_env_blind(&closure);
    let sym = self.interp.string_interner().get_or_intern(name);
    self.define_host_binding(sym, LispValue::Function(Function::NativeClosure(closure)));
  }

  /// Register a Schema record or enum as `std.<descriptor name>` at core init.
  /// A descriptor already named under `std.` keeps that fully qualified name.
  /// This bypasses script declarations; scripts can never replace the binding.
  pub fn define_type(&mut self, descriptor: crate::schema::TypeDesc) -> Result<(), LispHostError> {
    if self.types_sealed {
      return Err(LispHostError::Runtime("core type registration is sealed".into()));
    }
    let name = match &descriptor {
      crate::schema::TypeDesc::Record { name, .. } | crate::schema::TypeDesc::Enum { name, .. } => name,
      _ => return Err(LispHostError::Runtime("core types require a named record or enum descriptor".into())),
    };
    let name = if name.starts_with("std.") { name.clone() } else { format!("std.{name}") };
    let ty = crate::structural::type_expression(&descriptor);
    let mut errors = vec![];
    ty.subtype(&ty, &name, &mut errors);
    tento_lisp::types::checked(errors).map_err(runtime_host_error)?;
    let symbol = self.interp.string_interner().get_or_intern(&name);
    if self.env.borrow().get(symbol).is_some() {
      return Err(LispHostError::Runtime(format!("core type {name} is already bound")));
    }
    self.define_host_binding(symbol, LispValue::Type(Rc::new(ty)));
    self.core_types.borrow_mut().insert(name);
    Ok(())
  }

  /// Finish core initialization. Hosts call this at their capability seal.
  pub fn seal_types(&mut self) { self.types_sealed = true; }

  /// Core initialization may be layered; do not register the same family twice.
  pub fn core_type_registered(&self, name: &str) -> bool {
    self.core_types.borrow().contains(name)
  }

  pub fn set_stream_capability(&mut self, update: impl Fn(bool) + 'static) {
    self.stream_capability = Some(Rc::new(update));
  }
  pub fn set_stream_capability_held(&self, held: bool) {
    if let Some(update) = &self.stream_capability { update(held); }
  }

  /// One symbol-headed literal form runs in the root scope, budget and capability gate.
  pub fn register_source_native<F>(&mut self, name: &str, select: F)
  where
    F: Fn(Vec<LispValue<Sym>>) -> Result<(LispValue<Sym>, Option<String>), LispHostError> + 'static,
  {
    self.register_source_native_inner(name, None, select);
  }

  /// As [`Self::register_source_native`], running only forms whose head
  /// `heads` admits (an advice runner admits its advice commands only).
  pub fn register_source_native_heads<H, F>(&mut self, name: &str, heads: H, select: F)
  where
    H: Fn(&str) -> bool + 'static,
    F: Fn(Vec<LispValue<Sym>>) -> Result<(LispValue<Sym>, Option<String>), LispHostError> + 'static,
  {
    self.register_source_native_inner(name, Some(Rc::new(heads)), select);
  }

  fn register_source_native_inner<F>(&mut self, name: &str, heads: Option<tento_lisp::SourceHeads>, select: F)
  where
    F: Fn(Vec<LispValue<Sym>>) -> Result<(LispValue<Sym>, Option<String>), LispHostError> + 'static,
  {
    self.native_defs.push(name.into());
    let owned = name.to_string();
    let value = self.interp.native_source_with_heads(Rc::new(move |args| {
      select(args).map_err(|e| native_runtime_error(&owned, e))
    }), heads);
    let symbol = self.interp.string_interner().get_or_intern(name);
    self.define_host_binding(symbol, value);
  }

  /// Install the process-local stream table seam. Validation must reject
  /// unknown/closed tokens and enforce the caller's ownership/capability.
  /// Close runs once in finally, including on a raise;
  /// a close failure cannot replace the body's result or original failure.
  pub fn set_stream_callbacks<V, C>(&mut self, validate: V, close: C)
  where
    V: Fn(&str) -> Result<(), LispHostError> + 'static,
    C: Fn(&str) -> Result<(), LispHostError> + 'static,
  {
    struct Close<C: Fn(&str) -> Result<(), LispHostError>>(String, Rc<C>);
    impl<C: Fn(&str) -> Result<(), LispHostError>> Drop for Close<C> {
      fn drop(&mut self) {
        if let Err(error) = (self.1)(&self.0) {
          tracing::warn!(%error, "std.stream.with: stream close failed");
        }
      }
    }
    let close = Rc::new(close);
    self.interp.set_stream_scope(Rc::new(move |token| {
      validate(token).map_err(|e| native_runtime_error("std.stream.with", e))?;
      Ok(Box::new(Close(token.to_string(), close.clone())))
    }));
  }

  /// Typed natives use the same named-input parser and Signature binder as
  /// typed Lisp functions. The callback receives declaration-ordered values.
  pub fn register_typed_native<F>(
    &mut self,
    name: &str,
    signature: tento_lisp::types::Signature,
    f: F,
  ) where
    F: Fn(Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, LispHostError> + 'static,
  {
    self.native_defs.push(name.to_string());
    let owned = name.to_string();
    let body: NativeClosure<Sym> = Rc::new(move |_, args| f(args).map_err(|e| native_runtime_error(&owned, e)));
    self.interp.declare_env_blind(&body);
    let symbol = self.interp.string_interner().get_or_intern(name);
    self.define_host_binding(symbol, LispValue::Function(Function::TypedNative(Rc::new(
      tento_lisp::types::TypedNative { name: name.to_string(), signature, body }
    ))));
  }

  /// Register every registry command as an env native under its canonical name,
  /// so `(std.fs.list_dir "/tmp")` resolves by ordinary env lookup — no fallback,
  /// no hidden control flow. Subcommand groups register via the argv door. The
  /// group's unix-name prelude (`ls` → `std.fs.list_dir`) is then evaluated as a
  /// per-host SEED of ordinary `def`s ([`crate::Scripts::prelude`]) — the env
  /// replacement for the old shared alias map, which is gone.
  ///
  /// Command futures are driven with `now_or_never` (see [`drive_command`]) —
  /// sound because in-process `std.*` / `SyncCommand` / oneshot futures are
  /// poll-ready; a genuinely async daemon/streaming command yields a clear
  /// "call it as a shell line" error rather than blocking the thread. A later
  /// `(let name …)` shadows the command of the same name (`define` overwrites).
  pub fn register_commands<Info: Clone + 'static>(
    &mut self,
    scripts: Rc<crate::Scripts<Info>>,
    subcommands: Rc<HashMap<String, Box<dyn crate::shell::Callable>>>,
  ) {
    // Canonical registry commands: a sync env native (nested/in-process calls,
    // driven with `now_or_never`) plus an async dispatcher (top-level await).
    for name in scripts.commands.names() {
      let scripts_sync = scripts.clone();
      let canonical_sync = name.clone();
      let json_sync = self.command_json.clone();
      self.register_command_native(&name, move |mut args| {
        let cmd = scripts_sync
          .commands
          .find_command(&canonical_sync)
          .expect("registered command vanished from the list");
        let options = super::arg_bind::take_reflection_lisp(&mut args);
        json_sync.set(options.json);
        if options.help { return Ok(value_from_json(&cmd.doc_value())); }
        cmd
          .call_for_lisp(scripts_sync.info.clone(), args)
          .map(|v| value_from_json(&v))
          // A command's OWN failure — tag it as command-origin so the host
          // boundary renders it without the `lisp error:` label (it already
          // self-identifies, e.g. `ls: …`).
          .map_err(|e| RuntimeError::Command {
            detail: format!("{e}"),
          })
      });
      let scripts_async = scripts.clone();
      let canonical_async = name.clone();
      let json_async = self.command_json.clone();
      self.async_commands.borrow_mut().insert(
        name.clone(),
        Rc::new(move |mut argv: Vec<String>| {
          let cmd = scripts_async
            .commands
            .find_command(&canonical_async)
            .expect("registered command vanished from the list");
          let options = super::arg_bind::take_reflection_argv(&mut argv);
          json_async.set(options.json);
          if options.help {
            let doc = cmd.doc_value();
            return Ok(Box::pin(async move { Ok(doc) }));
          }
          cmd.call_with_argv(scripts_async.info.clone(), argv)
        }),
      );
    }
    // Subcommand groups: sync argv-door native + async dispatcher (the async
    // path already holds the full argv, so it passes it straight through).
    for name in subcommands.keys().cloned().collect::<Vec<_>>() {
      if let Some(bundle) = scripts.prelinked_bundles.get(&name) {
        if let Some(refusal) = import_collision(bundle, &name, &self.command_owners.borrow(), &self.command_natives.borrow()) {
          eprintln!("warning: {refusal}");
          continue;
        }
        self.command_owners.borrow_mut().insert(name.clone(), format!("bundle {bundle}"));
      }
      self.subcommand_groups.insert(name.clone());
      let subs_sync = subcommands.clone();
      let canonical_sync = name.clone();
      let json_sync = self.command_json.clone();
      self.register_command_native(&name, move |args| {
        let sub = subs_sync
          .get(&canonical_sync)
          .expect("registered subcommand vanished from the map");
        let mut argv = super::lisp_args_to_argv(&canonical_sync, args);
        let options = super::arg_bind::take_reflection_argv(&mut argv);
        json_sync.set(options.json);
        if options.help {
          let end = argv.iter().position(|word| word == "--").unwrap_or(argv.len());
          argv.insert(end, "--help".into());
        }
        drive_command(sub.call_with_argv(argv), &canonical_sync)
      });
      let subs_async = subcommands.clone();
      let canonical_async = name.clone();
      let json_async = self.command_json.clone();
      self.async_commands.borrow_mut().insert(
        name.clone(),
        Rc::new(move |mut argv: Vec<String>| {
          let sub = subs_async
            .get(&canonical_async)
            .expect("registered subcommand vanished from the map");
          let options = super::arg_bind::take_reflection_argv(&mut argv);
          json_async.set(options.json);
          if options.help {
            let end = argv.iter().position(|word| word == "--").unwrap_or(argv.len());
            argv.insert(end, "--help".into());
          }
          sub.call_with_argv(argv)
        }),
      );
    }
    // `help` as an ordinary env native so it resolves through the same env lookup
    // as every command (CLI / REPL / TUI all route posix lines through the env
    // now). It used to live only in the retired `exec` argv path, which is why
    // `tsh help` regressed once the CLI moved onto the host. Bare `help` / root
    // `--help` returns the app self-description (`tsh.app/v1`) — the record that
    // retired the bespoke `__manifest` subcommand; the packager reads it via
    // `<bin> --help --json`.
    {
      let scripts_h = scripts.clone();
      let subs_h = subcommands.clone();
      let json_help = self.command_json.clone();
      let natives_help = self.command_natives.clone();
      let env_help = self.env.clone();
      let deprecated_h = self.deprecated_aliases.clone();
      self.register_command_native("help", move |mut args| {
        let options = super::arg_bind::take_reflection_lisp(&mut args);
        json_help.set(options.json);
        let argv = super::lisp_args_to_argv("help", args);
        let value = crate::run_loop::help_command_value(&scripts_h, &subs_h, &argv)
          .or_else(|error| argv.get(1).and_then(|name| imported_help_value(&natives_help, env_help.clone(), name)).ok_or(error))
          // A deprecated spelling answers its replacement's document while
          // the spelling still resolves (`(help "std.fs.list_dir")`).
          .or_else(|error| {
            argv.get(1)
              .and_then(|name| alias_target(&deprecated_h.borrow(), name))
              .and_then(|target| crate::run_loop::help_command_value(&scripts_h, &subs_h, &["help".to_string(), target]).ok())
              .ok_or(error)
          });
        json_help.set(options.json);
        value
          .map(|v| value_from_json(&v))
          .map_err(|e| RuntimeError::Command {
            detail: format!("{e}"),
          })
      });
    }
    // The dispatchable command names (canonical commands + subcommand groups),
    // for the structured `CommandNotFound` an unknown argv head produces.
    self.command_names = self.async_commands.borrow().keys().cloned().collect();
    self.command_names.sort();
    // Per-host prelude SEED: its short Lisp names (`(let update tsh.update)`,
    // …) and its prompt declarations (`(let ls std.fs.list_dir)`, …),
    // evaluated AFTER the commands register so the typed targets resolve in
    // the env. Each host (REPL, one-shot, script, control pane) runs it
    // independently.
    // Evaluated FORM BY FORM: the prelude is a set of declarations, not a
    // procedure, so one unavailable form must not silently discard every
    // declaration below it — the same policy `OnError::WarnContinue` gives the
    // rc files that read the very same artifact. Without it, a single form the
    // embedder did not register (an `(exec.path)` on a host with no exec
    // vocabulary) takes the whole unix-name vocabulary down with it, and does
    // so silently on one host while working on another.
    if let Some(prelude) = scripts.prelude.clone() {
      self.prelude_failures = self.eval_seed(&prelude, &scripts.prelude_origin);
    }
  }

  /// The failures the prelude seed reported when the commands registered
  /// (each already written to stderr once per process): empty when it
  /// loaded cleanly or there was none.
  pub fn prelude_failures(&self) -> &[String] {
    &self.prelude_failures
  }

  /// Evaluate a per-host SEED source, warning and CONTINUING past a form that
  /// fails. A parse error is fatal to the whole seed (there are no well-formed
  /// declarations to salvage); an evaluation error costs only its own form.
  ///
  /// Nothing is dropped silently (argv.md I10): every failure is written to
  /// stderr with the file and line `origin` gives it, once per process (each
  /// host evaluates the same seed), and the session keeps running. Returns
  /// every failure's message, printed now or before.
  pub(super) fn eval_seed(&mut self, source: &str, origin: &[crate::SeedLine]) -> Vec<String> {
    let mut failures = Vec::new();
    // The prelude is strict lisp, like every rc: a bash line, a `>` prefix
    // or a `#` comment is reported at its line and never evaluated.
    let (source, refused) = super::sh_macro::blank_refusals(source);
    let source: &str = &source;
    for (line, message) in refused {
      failures.push(seed_failure(origin, Some(line), &message));
    }
    let asts = {
      let interner = self.interp.string_interner();
      match tento_lisp::Runtime::<Sym, StringBackend>::parse(None, source, interner) {
        Ok(asts) => asts,
        Err(e) => {
          failures.push(seed_failure(origin, None, &format!("did not parse: {e}")));
          report_seed_failures(&failures);
          return failures;
        }
      }
    };
    let lines = seed_form_lines(source, asts.len(), self.interp.string_interner());
    self.refresh_shell_symbols();
    self.seeding.set(true);
    for (index, ast) in asts.into_iter().enumerate() {
      let line = lines.as_ref().map(|lines| lines[index]);
      let value = match LispValue::from_owned_sexpression(ast) {
        Ok(v) => v,
        Err(e) => {
          failures.push(seed_failure(origin, line, &format!("did not read: {e}")));
          continue;
        }
      };
      if let Err(e) = self.interp.eval_expression(self.env.clone(), &value) {
        failures.push(seed_failure(origin, line, &runtime_host_error(e).to_string()));
      } else if self.is_let_binding(&value) {
        // `(let ls std.fs.list_dir)` is a prompt declaration (see
        // `declared_target`); recording it turns on the shell dispatch that
        // consults declarations. The binding itself stays the authority: an
        // rc that rebinds `ls` changes or removes the command.
        if let LispValue::List(list) = &value {
          if let [_, LispValue::Symbol(name), _] = list.items.as_slice() {
            let name = self.interp.string_interner().resolve(name.as_symbol()).map(str::to_string);
            if let Some(name) = name {
              let target = self.declared_target(&name);
              // A function the prelude binds is a prelude name: no rc mount
              // takes it, so `NAME.x` never means a bundle beside `NAME`.
              let symbol = self.interp.string_interner().get_or_intern(&name);
              let function = matches!(self.env.borrow().get(symbol), Some(LispValue::Function(_)));
              if function {
                let owner = target.as_ref().map_or_else(|| "a prelude name".to_string(), |target| format!("{target} (prelude)"));
                self.command_owners.borrow_mut().insert(name.clone(), owner);
              }
              if let Some(target) = target {
                self.register_shell_alias(&name, &target);
              }
            }
          }
        }
      }
    }
    self.seeding.set(false);
    report_seed_failures(&failures);
    failures
  }

  /// Define one env native taking raw Lisp args and returning a raw Lisp value
  /// (no host-scalar coercion). The body owns its dispatch; see
  /// [`Self::register_commands`].
  fn register_command_native<F>(&mut self, name: &str, f: F)
  where
    F: Fn(Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> + 'static,
  {
    let closure: NativeClosure<Sym> = Rc::new(move |_env, args| f(args));
    self.command_natives.borrow_mut().insert(name.into(), closure.clone());
    let sym = self.interp.string_interner().get_or_intern(name);
    self.define_host_binding(sym, LispValue::Function(Function::NativeClosure(closure)));
  }

  /// Invoke a `LispValue::Function` with the given arguments and return the
  /// raw lisp result. Used by hosts that store a lisp-level callback (e.g.
  /// a `(lambda …)` registered via [`register_native_special`]) and need to
  /// fire it from Rust on an external event.
  ///
  /// The call is synthesized as `(func args…)` and run through the same
  /// interpreter as user input, so closure-captured env is honored.
  /// Engage (or clear) an eval budget (steps / wall-clock / recursion-depth
  /// ceilings — the F8 rail against runaway scripts freezing the host),
  /// returning the previous one so scopes nest by save/restore.
  pub fn replace_eval_budget(
    &mut self,
    budget: Option<tento_lisp::EvalBudget>,
  ) -> Option<tento_lisp::EvalBudget> {
    self.interp.replace_eval_budget(budget)
  }

  /// Read the current budget's charged steps without changing its limits.
  pub fn eval_budget_steps(&self) -> Option<u64> {
    self.interp.eval_budget_steps()
  }

  /// Run `f` under an [`tento_lisp::EvalBudget`], reinstating the previous
  /// budget — usually `None` — afterward, so an unbudgeted prompt eval stays
  /// unlimited.
  pub fn with_eval_budget<T>(
    &mut self,
    budget: tento_lisp::EvalBudget,
    f: impl FnOnce(&mut Self) -> T,
  ) -> T {
    let prev = self.replace_eval_budget(Some(budget));
    let out = f(self);
    self.replace_eval_budget(prev);
    out
  }

  /// Evaluate `source` and return the **raw** last value — no host-scalar
  /// coercion (unlike [`Self::eval_expr`]), so a `(lambda …)` evaluates to a
  /// callable `Function` the caller can stash and later fire via
  /// [`Self::call_value`]. The seam for host-side L0 primitives
  /// (`pane/custom` lifts its `:render`/`:on-event` lambdas through this).
  pub fn eval_value(&mut self, source: &str) -> Result<LispValue<Sym>, LispHostError> {
    self
      .eval_last(source)?
      .ok_or_else(|| LispHostError::Parse("empty expression".to_string()))
  }

  pub fn call_value(
    &mut self,
    func: LispValue<Sym>,
    args: Vec<LispValue<Sym>>,
  ) -> Result<LispValue<Sym>, LispHostError> {
    self.seal_types();
    let mut items = Vec::with_capacity(args.len() + 1);
    items.push(func);
    items.extend(args);
    let call = LispValue::List(tento_lisp::List { items: items.into() });
    self
      .interp
      .eval_expression(self.env.clone(), &call)
      .map_err(runtime_host_error)
  }

  /// Apply pre-resolved [`ImportMounts`] to the persistent env: define each
  /// dotted command symbol, then queue the bundle's UI scripts under `namespace`
  /// for the F11 registration eval. The generic half of `(@import …)`, shared by
  /// the import handler (via the interpreter) and [`Self::import_app`].
  pub fn mount(&mut self, resolved: ImportMounts, namespace: &str) {
    self
      .pending_rc
      .borrow_mut()
      .extend(
        resolved
          .rc_scripts
          .iter()
          .cloned()
          .map(|script| PendingRcScript {
            namespace: namespace.to_string(),
            script,
          }),
      );
    for (symbol, value) in resolved.mounts {
      let (symbol, value) = import_native_reflection(symbol, value, self.command_json.clone(), &self.command_natives);
      let sym = self.interp.string_interner().get_or_intern(&symbol);
      self.define_host_binding(sym, value);
    }
    {
      let mut ac = self.async_commands.borrow_mut();
      let mut names = self.async_mount_names.borrow_mut();
      for (symbol, dispatch) in resolved.async_mounts {
        names.insert(symbol.clone());
        ac.insert(symbol.clone(), import_async_reflection(symbol, dispatch, self.command_json.clone(), self.command_natives.clone(), self.env.clone()));
      }
    }
    self
      .pending_ui
      .borrow_mut()
      .extend(
        resolved
          .ui_scripts
          .into_iter()
          .map(|script| PendingUiScript {
            namespace: namespace.to_string(),
            script,
          }),
      );
  }

  /// Whether a posix line's head is a session/daemon `@import` mount that must
  /// be driven through the async door ([`Self::eval_posix_line_async`]) rather
  /// than the sync env path (which can't await the daemon future). The sync
  /// script runner ([`crate::script::run_source_on_host`]) calls this per line
  /// to pick the door; a bare assignment (`x=…` → `(let …)`) or any non-mount
  /// head reads `false` and stays on the sync path.
  pub fn posix_line_is_async_mount(&mut self, body: &str) -> bool {
    // A lazily recorded namespace may hold a daemon command that is not in the
    // async table YET — the value-level check below mounts it on sight of the
    // head, so this shortcut must not fire while any import is still pending.
    if self.async_mount_names.borrow().is_empty()
      && self.external.is_none()
      && self.lazy_imports.borrow().is_empty()
    {
      return false;
    }
    #[cfg(test)]
    {
      self.posix_reads += 1;
    }
    let sexpr = {
      let interner = self.interp.string_interner();
      match tento_lisp::read_statement::<Sym, StringBackend>(body, interner) {
        Ok(s) => s,
        Err(_) => return false,
      }
    };
    let mut value = match LispValue::from_owned_sexpression(sexpr) {
      Ok(v) => v,
      Err(_) => return false,
    };
    self.lower_commands(&mut value);
    self.posix_value_is_async_mount(&value)
  }

  /// Unknown Bash heads use the async door's structured command-not-found error.
  /// A name bound only by Lisp (a `def`, a bash variable, a user closure) is
  /// unknown to bash: command lookup never consults those bindings (I12).
  pub(super) fn posix_value_is_unbound(&mut self, value: &LispValue<Sym>) -> bool {
    let Some(head) = self.application_head(value) else {
      return false;
    };
    let sym = self.interp.string_interner().get_or_intern(&head);
    self.env.borrow().get(sym).is_none() || self.shadowed_by_lisp_binding(&head)
  }

  /// A Lisp call whose head nothing binds: the lisp view of an unknown name,
  /// where every Lisp binding counts (the fallback to `std.sh.cmd`, I13).
  fn lisp_head_unbound(&mut self, value: &LispValue<Sym>) -> bool {
    let Some(head) = self.application_head(value) else {
      return false;
    };
    let sym = self.interp.string_interner().get_or_intern(&head);
    self.env.borrow().get(sym).is_none()
  }

  pub(super) fn posix_value_is_async_mount(&mut self, value: &LispValue<Sym>) -> bool {
    let head = self.application_head(value);
    if super::bash_flow::is_flow(head.as_deref()) || self.shell_compound_value(head.as_deref(), value) {
      return true;
    }
    if let Some(head) = self.application_head(value) {
      if let Some((namespace, _)) = head.split_once('.') {
        self.mount_lazy_namespace(namespace);
      }
    }
    if self.async_mount_names.borrow().is_empty() && self.external.is_none() {
      return false;
    }
    match self.application_head(value) {
      Some(head) => {
        if self.async_mount_names.borrow().contains(&head) {
          return true;
        }
        // An external candidate also needs the async door (running a child is
        // genuinely async; the sync path would have no way to await it) — but
        // ONLY for an UNBOUND head: a `def`/builtin always wins, and external
        // resolution must never shadow one. `Undeclared` routes too, so the
        // teaching error surfaces instead of the bare command-not-found.
        if let Some(external) = self.external.clone() {
          let sym = self.interp.string_interner().get_or_intern(&head);
          let bound = self.env.borrow().get(sym).is_some() && !self.shadowed_by_lisp_binding(&head);
          if !bound && !matches!(external.lookup(&head), ExternalLookup::NotFound) {
            return true;
          }
        }
        false
      }
      None => false,
    }
  }
}

fn host_to_lisp(v: &HostValue) -> Option<LispValue<Sym>> {
  match v {
    HostValue::Lisp(LispScalar::Boolean(b)) => Some(LispValue::Boolean(*b)),
    HostValue::Lisp(LispScalar::Integer(i)) => Some(LispValue::Integer(*i)),
    HostValue::Lisp(LispScalar::Float(f)) => Some(LispValue::Float(*f)),
    HostValue::Lisp(LispScalar::String(s)) => Some(LispValue::String(s.as_str().into())),
    // Full JSON→lisp: null → Nil, object → Map, array → List — a native
    // returning `HostValue::from_json(Null)` (the exec.* policy natives) or
    // a structured fold (`exec.page`'s term.result) is a value, not a type
    // error.
    HostValue::Json(j) => Some(tento_lisp::json_to_value(j.as_ref().clone())),
  }
}

fn lisp_to_host_scalar(v: &LispValue<Sym>) -> Option<HostValue> {
  match v {
    LispValue::Boolean(b) => Some(HostValue::Lisp(LispScalar::Boolean(*b))),
    LispValue::Integer(i) => Some(HostValue::Lisp(LispScalar::Integer(*i))),
    LispValue::Float(f) => Some(HostValue::Lisp(LispScalar::Float(*f))),
    LispValue::String(s) => Some(HostValue::Lisp(LispScalar::String(s.to_string()))),
    _ => None,
  }
}

fn lisp_to_host(v: &LispValue<Sym>) -> Option<HostValue> {
  // For the MVP the host only consumes scalars from lisp evaluations.
  // Lists/symbols/functions can flow through lisp-internal computations
  // but cannot leak out as bind values.
  lisp_to_host_scalar(v)
}

/// JSON → lisp value, recursively (objects→`Map`, arrays→`List`). The widening
/// that lets out-of-process command results cross into lisp as structured data.
/// Public JSON→Lisp bridge (the recursive `@import` boundary conversion),
/// for hosts that round-trip values — e.g. a custom pane's state snapshot
/// restored across a live scene reload (F8 c2).
/// Drive a command's call-result to a Lisp value via `now_or_never`: the sync
/// engine polls the future exactly once. In-process `std.*` / `SyncCommand` /
/// oneshot futures are poll-ready, so this resolves immediately; a genuinely
/// async (daemon/streaming) command returns `Pending` and yields a clear error
/// telling the caller to run it as a shell line. This one function is the
/// sync/async seam — the future async-twin engine will `.await` here instead.
fn drive_command<F, E>(call: Result<F, E>, name: &str) -> Result<LispValue<Sym>, RuntimeError>
where
  F: std::future::Future<Output = Result<JsonValue, E>> + Unpin,
  E: std::fmt::Display,
{
  use futures::FutureExt;
  // A subcommand's OWN failure (setup or resolved future) is command-origin —
  // tagged so the host boundary drops the `lisp error:` label. The `None` arm
  // is NOT a command failure but a dispatch-context fault (an async command
  // called inside Lisp), so it keeps the interpreter `lisp error:` labelling.
  let fut = call.map_err(|e| RuntimeError::Command {
    detail: format!("{e}"),
  })?;
  match fut.now_or_never() {
    Some(Ok(v)) => Ok(value_from_json(&v)),
    Some(Err(e)) => Err(RuntimeError::Command {
      detail: format!("{e}"),
    }),
    None => Err(RuntimeError::Other(format!(
      "`{name}` is an async (daemon/streaming) command; call it as a shell line, not inside Lisp"
    ))),
  }
}

pub fn value_from_json(j: &JsonValue) -> LispValue<Sym> {
  json_to_lisp(j)
}

/// Public Lisp→JSON bridge — the inverse of [`value_from_json`]. Also how an
/// L0 `:render` lambda's returned shape map crosses into the serde world the
/// shape registry renders.
pub fn value_to_json(v: &LispValue<Sym>) -> JsonValue {
  lisp_to_json(v)
}

fn json_to_lisp(j: &JsonValue) -> LispValue<Sym> {
  match j {
    JsonValue::Null => LispValue::Nil,
    JsonValue::Bool(b) => LispValue::Boolean(*b),
    JsonValue::Number(n) => n
      .as_i64()
      .map(LispValue::Integer)
      .or_else(|| n.as_f64().map(LispValue::Float))
      .unwrap_or(LispValue::Nil),
    JsonValue::String(s) => LispValue::String(s.as_str().into()),
    JsonValue::Array(items) => LispValue::List(tento_lisp::List {
      items: items.iter().map(json_to_lisp).collect(),
    }),
    JsonValue::Object(obj) => {
      let mut map: IndexMap<String, LispValue<Sym>> = IndexMap::with_capacity(obj.len());
      for (k, v) in obj {
        map.insert(k.clone(), json_to_lisp(v));
      }
      LispValue::Map(map.into())
    }
  }
}

/// How many arrays and objects deep [`value_to_json`] builds before it cuts
/// the rest off: the same depth the Lisp reader admits.
///
/// Lisp builds data nested far deeper than any native stack, and a
/// `serde_json::Value` drops and serializes recursively, so an uncut
/// conversion of a million-deep list would only move the stack overflow to
/// whoever drops or prints the JSON. Past this depth a list or map becomes
/// an `error/v1` record of kind `"depth"`, visible where the data stopped.
pub const JSON_DEPTH_LIMIT: usize = tento_lisp::MAX_NESTING_DEPTH;

/// Lisp value → JSON (`Map`→object, `List`→array). Used to forward call
/// arguments to a command. Non-data lisp values (symbols, functions, tagged
/// strings) map to null — they don't cross the wire. The walk keeps its open
/// arrays and objects on a heap stack, never the native one.
fn lisp_to_json(v: &LispValue<Sym>) -> JsonValue {
  enum Open<'a> {
    Array(std::slice::Iter<'a, LispValue<Sym>>, Vec<JsonValue>),
    Object(
      indexmap::map::Iter<'a, String, LispValue<Sym>>,
      serde_json::Map<String, JsonValue>,
      Option<String>,
    ),
  }
  let mut open: Vec<Open<'_>> = Vec::new();
  let mut next = Some(v);
  loop {
    let mut done = match next.take() {
      Some(LispValue::List(_) | LispValue::Map(_)) if open.len() >= JSON_DEPTH_LIMIT => {
        Some(json_depth_cut())
      }
      Some(LispValue::List(list)) => {
        open.push(Open::Array(list.items.iter(), Vec::with_capacity(list.items.len())));
        None
      }
      Some(LispValue::Map(map)) => {
        open.push(Open::Object(map.iter(), serde_json::Map::with_capacity(map.len()), None));
        None
      }
      Some(leaf) => Some(lisp_leaf_to_json(leaf)),
      None => None,
    };
    loop {
      if let Some(value) = done.take() {
        match open.last_mut() {
          None => return value,
          Some(Open::Array(_, items)) => items.push(value),
          Some(Open::Object(_, obj, key)) => {
            obj.insert(key.take().expect("an entry is open"), value);
          }
        }
      }
      match open.last_mut().expect("a container is open") {
        Open::Array(items, _) => {
          if let Some(item) = items.next() {
            next = Some(item);
            break;
          }
        }
        Open::Object(entries, _, key) => {
          if let Some((k, item)) = entries.next() {
            *key = Some(k.clone());
            next = Some(item);
            break;
          }
        }
      }
      done = Some(match open.pop().expect("a container is open") {
        Open::Array(_, items) => JsonValue::Array(items),
        Open::Object(_, obj, _) => JsonValue::Object(obj),
      });
    }
  }
}

/// Where [`lisp_to_json`] stops descending past [`JSON_DEPTH_LIMIT`].
fn json_depth_cut() -> JsonValue {
  tento_lisp::ErrorValue {
    kind: "depth".into(),
    message: format!("value nests deeper than {JSON_DEPTH_LIMIT} levels; the rest is cut off"),
    origin: None,
    chain: Vec::new(),
    host: None,
    hint: None,
    next: None,
    output: None,
    display: None,
  }
  .to_record()
}

/// JSON for a value that holds no further values.
/// The replacement a deprecated `name` resolves to under `aliases`, by the
/// interpreter's rule: a dotted old spelling renames itself and its members,
/// a bare one only its members.
fn alias_target(aliases: &[(String, String)], name: &str) -> Option<String> {
  aliases.iter().find_map(|(old, new)| {
    if name == old && old.contains('.') {
      return Some(new.clone());
    }
    let rest = name.strip_prefix(old.as_str())?.strip_prefix('.')?;
    Some(format!("{new}.{rest}"))
  })
}

/// Whether `value_to_json` and `value_from_json` give `v` back as it is: the
/// data kinds, and lists and maps of them, with no container nested past
/// [`JSON_DEPTH_LIMIT`] (the bridge cuts it to a depth record there) and every
/// map's keys already in the sorted order a JSON object comes back in. An
/// error, function, type, trait, module, symbol or tagged string becomes a
/// record or `nil` on the way. The walk keeps its open containers on a heap
/// stack, never the native one, as `lisp_to_json` does: Lisp builds data far
/// deeper than any native stack.
fn json_faithful(v: &LispValue<Sym>) -> bool {
  let mut open: Vec<(&LispValue<Sym>, usize)> = vec![(v, 0)];
  while let Some((v, depth)) = open.pop() {
    match v {
      LispValue::Nil | LispValue::Boolean(_) | LispValue::Integer(_) | LispValue::String(_) => {}
      LispValue::Float(f) if f.is_finite() => {}
      LispValue::List(list) if depth < JSON_DEPTH_LIMIT => {
        open.extend(list.items.iter().map(|item| (item, depth + 1)));
      }
      LispValue::Map(map) if depth < JSON_DEPTH_LIMIT => {
        if !map.keys().zip(map.keys().skip(1)).all(|(a, b)| a < b) {
          return false;
        }
        open.extend(map.values().map(|item| (item, depth + 1)));
      }
      _ => return false,
    }
  }
  true
}

fn lisp_leaf_to_json(v: &LispValue<Sym>) -> JsonValue {
  match v {
    LispValue::Nil => JsonValue::Null,
    LispValue::Boolean(b) => JsonValue::Bool(*b),
    LispValue::Integer(i) => JsonValue::Number((*i).into()),
    LispValue::Float(f) => serde_json::Number::from_f64(*f)
      .map(JsonValue::Number)
      .unwrap_or(JsonValue::Null),
    LispValue::String(s) => JsonValue::String(s.to_string()),
    LispValue::List(_) | LispValue::Map(_) => unreachable!("containers are walked by lisp_to_json"),
    // A first-class error crosses the wire as a tagged `error/v1` record
    // (matching the repo's `<name>/v1` convention), built from a serde value —
    // never a hand-assembled JSON string.
    LispValue::Error(e) => e.to_record(),
    LispValue::Resource(resource) => serde_json::json!({"type":"opaque-resource/v1", "kind":resource.kind()}),
    LispValue::Type(ty) => ty.describe(),
    LispValue::Trait(ty) => ty.describe(),
    LispValue::Module(module) => serde_json::json!({"type":"module/v1","name":module.name}),
    LispValue::Symbol(_) | LispValue::TaggedString { .. } | LispValue::Function(_) => {
      JsonValue::Null
    }
  }
}

fn register_natives(
  env: &mut Env<Sym>,
  interner: &mut string_interner::StringInterner<StringBackend>,
) {
  let mut reg = |name: &str, f: NativeFn<Sym>| {
    let s = interner.get_or_intern(name);
    env.define(s, LispValue::Function(Function::NativeFn(f)));
  };
  reg("-", native_isub);
  reg("*", native_imul);
  reg("/", native_idiv);
  reg(">", native_gt);
  reg("<", native_lt);
  reg("=", native_eq);
  reg(">=", native_ge);
  reg("<=", native_le);
  // `not` is NOT overridden: the stdlib's truthiness `not` serves scripts, so
  // `(not nil)` is true here exactly as `if` treats nil. This host's former
  // boolean-only `not` refused nil and non-boolean values.
  reg("concat", native_concat);
  reg("now", native_now);
}

fn native_isub(args: Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> {
  tento_lisp::arith::isub(args)
}

fn native_imul(args: Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> {
  tento_lisp::arith::imul(args)
}

fn native_idiv(args: Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> {
  tento_lisp::arith::idiv(args)
}

fn native_gt(args: Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> {
  tento_lisp::cmp::gt(args)
}

fn native_lt(args: Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> {
  tento_lisp::cmp::lt(args)
}

fn native_ge(args: Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> {
  tento_lisp::cmp::ge(args)
}

fn native_le(args: Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> {
  tento_lisp::cmp::le(args)
}

fn native_eq(args: Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> {
  tento_lisp::cmp::eq(args)
}

fn native_concat(args: Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> {
  if args.iter().any(|value| matches!(value, LispValue::Nil)) {
    return Err(RuntimeError::TypeError {
      expected: "scalar".into(),
      got: "Nil".into(),
    });
  }
  tento_lisp::concat_values(args)
}

fn native_now(_args: Vec<LispValue<Sym>>) -> Result<LispValue<Sym>, RuntimeError> {
  let secs = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|e| RuntimeError::TypeError {
      expected: "valid system time".to_string(),
      got: e.to_string(),
    })?
    .as_secs() as i64;
  Ok(LispValue::Integer(secs))
}

/// A `--help` in **command (head) position** is the flag spelling of the
/// universal `help` command; any other head (a real command, a bareword `help`,
/// or `--version`, which the app's own top-level dispatch owns) passes through
/// unchanged. This only fires when the flag IS the head — `<cmd> --help` keeps
/// `<cmd>` as the head and lets that command's binder read `--help` itself.
fn head_flag_alias(head: &str) -> Option<&'static str> {
  (head == "--help").then_some("help")
}

/// A host is dropped with its scope CLEARED. Every lambda `def`ined at top
/// level captured `env` and is stored in it — an `Rc` cycle that `Drop`
/// alone never frees, so a host built for one run kept its whole run alive:
/// the producer host behind `tsh.script-snapshot` leaked records, probe
/// output and closures at 5–8 MB per refresh, a gigabyte an hour in an open
/// agents sidebar (2026-09-09). Scopes a `let` opened for a recursive helper
/// hold the same cycle among themselves and are not reached from here; they
/// are a few hundred bytes each. A child host
/// ([`LispHost::hand_off_deprecations`]) first reports what it never drained.
impl Drop for LispHost {
  fn drop(&mut self) {
    self.resources.close_all();
    if self.hand_off_deprecations {
      self.hand_off_undrained_deprecations();
    }
    if let Ok(mut natives) = self.command_natives.try_borrow_mut() {
      natives.clear();
    }
    if let Ok(mut env) = self.env.try_borrow_mut() {
      env.clear();
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::Cell;
  use std::rc::Rc;

  struct DependencyImports;

  impl DependencyImports {
    fn mounts(bundle: &str, namespace: &str) -> ImportMounts {
      let native: NativeClosure<Sym> = Rc::new(|_, _| Ok(LispValue::Nil));
      let module = tento_lisp::types::Module::new(namespace.into(), Default::default())
        .with_bundle_name(bundle.into());
      ImportMounts {
        mounts: vec![
          (namespace.into(), LispValue::Module(Rc::new(module))),
          (format!("{namespace}.ping"), LispValue::Function(Function::NativeClosure(native))),
        ],
        async_mounts: Vec::new(),
        ui_scripts: Vec::new(),
        rc_scripts: Vec::new(),
      }
    }
  }

  impl ImportResolver for DependencyImports {
    fn resolve_dependencies(
      &self, name: &str, namespace: &str, _from: Option<&str>,
      _registration: Rc<RefCell<Option<String>>>,
    ) -> Result<Vec<(String, ImportMounts)>, RuntimeError> {
      Ok(if name == "parent" {
        [("first", "first-bundle"), ("dep", "actual-dependency")].into_iter().map(|(alias, bundle)| {
          let private = format!("{namespace}.__deps.{alias}");
          let mounts = Self::mounts(bundle, &private);
          (private, mounts)
        }).collect()
      } else { Vec::new() })
    }

    fn resolve(
      &self, name: &str, namespace: &str, _from: Option<&str>,
      _registration: Rc<RefCell<Option<String>>>,
    ) -> Result<ImportMounts, RuntimeError> {
      let identity = if name == "bundle-folder" { "actual-bundle" } else { name };
      Ok(Self::mounts(identity, namespace))
    }
  }

  #[test]
  fn prelinked_bundle_admits_its_rc_import_using_resolved_identity() {
    let scripts = crate::Scripts::new(())
      .mount_bundle_callable("p", "actual-bundle", Box::new(crate::Scripts::new(())));
    let (scripts, groups) = scripts.into_command_parts();
    let mut host = LispHost::with_resolver(Rc::new(DependencyImports));
    host.register_commands(Rc::new(scripts), Rc::new(groups));
    // Folder lookup and manifest identity deliberately differ.
    host.eval_value(r#"(@import "bundle-folder" :as "p")"#).unwrap();
    host.eval_value(r#"(@import "bundle-folder" :as "p")"#).unwrap();
    assert_eq!(host.command_owners.borrow().get("p").map(String::as_str), Some("bundle actual-bundle"));
    assert!(host.eval_value("(p.ping)").is_ok());
    let error = host.eval_value(r#"(@import "other" :as "p")"#).unwrap_err().to_string();
    assert!(error.contains("bundle actual-bundle"), "{error}");
    assert!(host.eval_value("(p.ping)").is_ok());
  }

  #[test]
  fn prelinked_bundle_never_claims_an_unrelated_native_or_raw_group() {
    for raw_replacement in [false, true] {
      let mut scripts = crate::Scripts::new(())
        .mount_bundle_callable("p", "parent", Box::new(crate::Scripts::new(())));
      if raw_replacement {
        scripts = scripts.mount_callable("p", Box::new(crate::Scripts::new(())));
      }
      let (scripts, groups) = scripts.into_command_parts();
      let mut host = LispHost::with_resolver(Rc::new(DependencyImports));
      if !raw_replacement {
        host.register_command_native("p", |_| Ok(value_from_json(&serde_json::json!(42))));
      }
      host.register_commands(Rc::new(scripts), Rc::new(groups));
      assert!(!host.command_owners.borrow().contains_key("p"));
      let error = host.eval_value(r#"(@import "parent" :as "p")"#).unwrap_err().to_string();
      assert!(error.contains("registered command"), "{error}");
      assert!(!host.command_natives.borrow().contains_key("p.ping"));
      if !raw_replacement {
        assert_eq!(host.eval_to_json("(p)").unwrap(), serde_json::json!(42));
      }
    }
  }

  #[test]
  fn first_prelinked_bundle_keeps_its_word_against_another_bundle() {
    let scripts = crate::Scripts::new(())
      .mount_bundle_callable("p", "first", Box::new(crate::Scripts::new(())))
      .mount_bundle_callable("p", "other", Box::new(crate::Scripts::new(())));
    let (scripts, groups) = scripts.into_command_parts();
    let mut host = LispHost::with_resolver(Rc::new(DependencyImports));
    host.register_commands(Rc::new(scripts), Rc::new(groups));
    let error = host.eval_value(r#"(@import "other" :as "p")"#).unwrap_err().to_string();
    assert!(error.contains("bundle first"), "{error}");
    host.eval_value(r#"(@import "first" :as "p")"#).unwrap();
  }

  #[test]
  fn dependency_import_refuses_a_preexisting_private_alias_atomically() {
    let mut host = LispHost::with_resolver(Rc::new(DependencyImports));
    host.eval_value(r#"(@import "other" :as "p.__deps.dep")"#).unwrap();
    let owners = host.command_owners.borrow().clone();
    let natives = host.command_natives.borrow().len();
    let error = host.eval_value(r#"(@import "parent" :as "p")"#).unwrap_err().to_string();
    assert!(error.contains("p.__deps.dep") && error.contains("bundle other"), "{error}");
    assert_eq!(*host.command_owners.borrow(), owners, "no partial parent/first dependency reservation");
    assert_eq!(host.command_natives.borrow().len(), natives, "no partial native mounts");
    assert!(host.pending_ui.borrow().is_empty());
    assert!(host.pending_rc.borrow().is_empty());
  }

  #[test]
  fn dependency_import_reserves_actual_bundle_identity_and_allows_reimports() {
    let mut host = LispHost::with_resolver(Rc::new(DependencyImports));
    host.eval_value(r#"(@import "parent" :as "p")"#).unwrap();
    assert_eq!(host.command_owners.borrow().get("p.__deps.dep").map(String::as_str), Some("bundle actual-dependency"));
    host.eval_value(r#"(@import "parent" :as "p")"#).unwrap();
    host.eval_value(r#"(@import "actual-dependency" :as "p.__deps.dep")"#).unwrap();
    let owners = host.command_owners.borrow().clone();
    let error = host.eval_value(r#"(@import "other" :as "p.__deps.dep")"#).unwrap_err().to_string();
    assert!(error.contains("bundle actual-dependency"), "{error}");
    assert_eq!(*host.command_owners.borrow(), owners);
  }

  #[test]
  fn dependency_import_refuses_an_existing_native_namespace_atomically() {
    let mut host = LispHost::with_resolver(Rc::new(DependencyImports));
    host.register_command_native("p.__deps.dep", |_| Ok(LispValue::Nil));
    // A native need not have an entry in the command-owner table.
    assert!(!host.command_owners.borrow().contains_key("p.__deps.dep"));
    let owners = host.command_owners.borrow().clone();
    let error = host.eval_value(r#"(@import "parent" :as "p")"#).unwrap_err().to_string();
    assert!(error.contains("p.__deps.dep") && error.contains("registered command"), "{error}");
    assert_eq!(*host.command_owners.borrow(), owners);
    assert!(!host.command_natives.borrow().contains_key("p.ping"));
  }

  #[test]
  fn a_lazy_import_notifies_admission_only_after_resolution() {
    struct Notified(Cell<usize>);
    impl ImportResolver for Notified {
      fn lazy_eligible(&self, _name: &str, _from: Option<&str>) -> bool { true }
      fn resolve(
        &self, name: &str, namespace: &str, _from: Option<&str>,
        _registration: Rc<RefCell<Option<String>>>,
      ) -> Result<ImportMounts, RuntimeError> { Ok(DependencyImports::mounts(name, namespace)) }
      fn admitted(&self, name: &str, namespace: &str, from: Option<&str>) {
        assert_eq!((name, namespace, from), ("lazy-app", "lz", None));
        self.0.set(self.0.get() + 1);
      }
    }
    let resolver = Rc::new(Notified(Cell::new(0)));
    let mut host = LispHost::with_resolver(resolver.clone());
    host.enable_lazy_imports();
    host.eval_value(r#"(@import "lazy-app" :as "lz")"#).unwrap();
    assert_eq!(resolver.0.get(), 0, "a lazy reservation has installed no mounts");
    host.eval_value("lz").unwrap();
    assert_eq!(resolver.0.get(), 1);
    host.eval_value("lz").unwrap();
    assert_eq!(resolver.0.get(), 1, "notify once per actual resolution");
  }

  /// The one-shot argv door (`tsh q.status`) mounts a pending namespace before
  /// consulting the async table, so a daemon command dispatched from the
  /// command line runs instead of hitting the sync native's refusal.
  #[tokio::test(flavor = "current_thread")]
  async fn one_shot_argv_into_a_pending_lazy_namespace_runs_the_daemon_command() {
    struct Fake;
    impl ImportResolver for Fake {
      fn lazy_eligible(&self, _name: &str, _from: Option<&str>) -> bool {
        true
      }
      fn resolve(
        &self,
        _name: &str,
        namespace: &str,
        _from: Option<&str>,
        _registration: Rc<RefCell<Option<String>>>,
      ) -> Result<ImportMounts, RuntimeError> {
        let dispatch: AsyncDispatch = Rc::new(|argv| {
          Ok(Box::pin(
            async move { Ok(serde_json::json!({"ran": argv})) },
          ))
        });
        let refuse: NativeClosure<Sym> = Rc::new(|_env, _args| {
          Err(RuntimeError::Other(
            "status: a session/daemon command — run it as a shell line".into(),
          ))
        });
        Ok(ImportMounts {
          mounts: vec![(
            format!("{namespace}.status"),
            LispValue::Function(Function::NativeClosure(refuse)),
          )],
          async_mounts: vec![(format!("{namespace}.status"), dispatch)],
          ui_scripts: Vec::new(),
          rc_scripts: Vec::new(),
        })
      }
    }
    let mut host = LispHost::with_resolver(Rc::new(Fake));
    host.enable_lazy_imports();
    host.eval_value(r#"(@import "queue-app" :as "q")"#).unwrap();
    let out = host
      .eval_posix_argv_async(vec!["q.status".into(), "--all".into()])
      .await
      .expect("the daemon command runs through the async door");
    assert_eq!(out["ran"][0], "q.status", "{out}");
  }

  /// A daemon command in a lazily recorded namespace must still take the async
  /// door when it runs as a shell line: the line-level check used to answer
  /// "not async" while the async table was empty, which sent `agent-queue.status`
  /// down the sync path to the native that refuses daemon commands.
  #[test]
  fn a_shell_line_into_a_pending_lazy_namespace_takes_the_async_door() {
    struct Fake;
    impl ImportResolver for Fake {
      fn lazy_eligible(&self, _name: &str, _from: Option<&str>) -> bool {
        true
      }
      fn resolve(
        &self,
        _name: &str,
        namespace: &str,
        _from: Option<&str>,
        _registration: Rc<RefCell<Option<String>>>,
      ) -> Result<ImportMounts, RuntimeError> {
        let dispatch: AsyncDispatch =
          Rc::new(|_argv| Ok(Box::pin(async { Ok(serde_json::json!({"ok": true})) })));
        Ok(ImportMounts {
          mounts: Vec::new(),
          async_mounts: vec![(format!("{namespace}.status"), dispatch)],
          ui_scripts: Vec::new(),
          rc_scripts: Vec::new(),
        })
      }
    }
    let mut host = LispHost::with_resolver(Rc::new(Fake));
    host.enable_lazy_imports();
    host.eval_value(r#"(@import "queue-app" :as "q")"#).unwrap();
    assert!(
      host.posix_line_is_async_mount("q.status"),
      "the pending namespace is mounted on sight of the head and its daemon command routes async"
    );
    assert!(
      !host.posix_line_is_async_mount("x=1"),
      "a plain assignment stays on the sync path"
    );
  }

  /// A lazily eligible `(@import …)` is only recorded on a host that opted in;
  /// the first reference into its namespace — here a NESTED call, the case a
  /// retry-based scheme could not serve — resolves and mounts it, once. A host
  /// that has not opted in mounts at the import line, as before.
  #[test]
  fn a_lazy_import_mounts_on_first_reference() {
    struct Fake {
      resolves: Cell<usize>,
    }
    impl ImportResolver for Fake {
      fn lazy_eligible(&self, _name: &str, _from: Option<&str>) -> bool {
        true
      }
      fn resolve(
        &self,
        _name: &str,
        namespace: &str,
        _from: Option<&str>,
        _registration: Rc<RefCell<Option<String>>>,
      ) -> Result<ImportMounts, RuntimeError> {
        self.resolves.set(self.resolves.get() + 1);
        let closure: NativeClosure<Sym> = Rc::new(|_env, _args| Ok(LispValue::Integer(41)));
        Ok(ImportMounts {
          mounts: vec![(
            format!("{namespace}.ping"),
            LispValue::Function(Function::NativeClosure(closure)),
          )],
          async_mounts: Vec::new(),
          ui_scripts: Vec::new(),
          rc_scripts: Vec::new(),
        })
      }
    }
    let fake = Rc::new(Fake {
      resolves: Cell::new(0),
    });
    let mut host = LispHost::with_resolver(fake.clone());
    host.enable_lazy_imports();
    host.eval_value(r#"(@import "lazy-app" :as "lz")"#).unwrap();
    assert_eq!(
      fake.resolves.get(),
      0,
      "recorded at the import line, not resolved"
    );
    let value = host.eval_expr("(+ 1 (lz.ping))").unwrap();
    assert_eq!(
      fake.resolves.get(),
      1,
      "the first nested reference resolves it"
    );
    assert!(
      format!("{value:?}").contains("42"),
      "and the call answers: {value:?}"
    );
    host.eval_expr("(lz.ping)").unwrap();
    assert_eq!(
      fake.resolves.get(),
      1,
      "mounted once, then defined like any command"
    );
    assert!(
      host.eval_expr("(lz.missing)").is_err(),
      "an unknown command in a mounted namespace still fails"
    );
    assert_eq!(fake.resolves.get(), 1, "a miss does not re-resolve");

    let eager = Rc::new(Fake {
      resolves: Cell::new(0),
    });
    let mut host = LispHost::with_resolver(eager.clone());
    host.eval_value(r#"(@import "lazy-app" :as "lz")"#).unwrap();
    assert_eq!(
      eager.resolves.get(),
      1,
      "without opting in the import line mounts, as before"
    );
  }

  #[test]
  #[ignore = "controlled performance probe; repeated commands in one host"]
  fn repeated_command_reader_bench() {
    let mut host = LispHost::new();
    host.register_native_closure("probe", |args| {
      assert_eq!(args.len(), 8);
      Ok(HostValue::from_json(JsonValue::from(42)))
    });
    let posix = "probe alpha beta gamma delta epsilon zeta eta theta";
    let lisp = r#"(probe "alpha" "beta" "gamma" "delta" "epsilon" "zeta" "eta" "theta")"#;
    let mut timings = serde_json::Map::new();
    for (name, source) in [("posix", posix), ("lisp", lisp)] {
      let started = std::time::Instant::now();
      for _ in 0..10_000 {
        let result = if name == "posix" {
          futures::executor::block_on(host.eval_posix_line_async(source)).unwrap()
        } else {
          host.eval_to_json(source).unwrap()
        };
        assert_eq!(result, JsonValue::from(42));
      }
      timings.insert(
        format!("{name}_us"),
        JsonValue::from(started.elapsed().as_micros() as u64),
      );
    }
    eprintln!("reader_bench {}", JsonValue::Object(timings));
  }

  include!("argv_literal_tests.rs");

  struct HelpProbe;

  impl crate::CommandMetadataSync<()> for HelpProbe {
    fn name(&self) -> &'static str {
      "std.test.probe"
    }
    fn description(&self) -> &'static str {
      "Record argument words"
    }
    fn call_sync(&self, _: (), argv: Vec<String>) -> crate::Result<JsonValue> {
      Ok(serde_json::json!(&argv[1..]))
    }
  }

  #[tokio::test]
  async fn typed_help_is_bound_after_dispatch_including_aliases() {
    let mut host = reflection_host();
    let doc = host.eval_to_json(r#"(help "std.test.probe")"#).unwrap();
    // `probe` is the seed's Lisp name for the command (a prompt declaration,
    // which no script line consults): Lisp reaches its help.
    assert_eq!(host.eval_to_json("(probe :help)").unwrap(), doc);
    for name in ["std.test.probe"] {
      assert_eq!(host.eval_posix_line(&format!("{name} --help")).unwrap(), doc);
      assert_eq!(host.eval_posix_line_async(&format!("{name} --help")).await.unwrap(), doc);
      assert_eq!(host.eval_to_json(&format!("({name} :help)")).unwrap(), doc);
      assert_eq!(host.eval_posix_line_async(&format!("{name} -h")).await.unwrap(), serde_json::json!(["-h"]));
    }
  }

  #[test]
  fn string_escape_errors_reach_the_lisp_host_and_bundle_messages() {
    let mut host = LispHost::new();
    for (literal, expected) in [
      (
        r#""a\.b""#,
        r"lisp parse error: unknown escape `\.` in a double-quoted string — write `\\.` for a backslash, or use single quotes",
      ),
      (
        "\"a\\",
        r"lisp parse error: trailing backslash in a double-quoted string — write `\\` for a backslash, or use single quotes",
      ),
    ] {
      assert_eq!(
        host.eval_lisp_line(literal).unwrap_err().to_string(),
        expected
      );
      let call = if literal.ends_with('\\') {
        format!("(std.io.echo {literal}")
      } else {
        format!("(std.io.echo {literal})")
      };
      assert_eq!(
        host.eval_lisp_line(&call).unwrap_err().to_string(),
        expected
      );
      assert_eq!(
        host
          .eval_bundle_rc("test", literal)
          .unwrap_err()
          .to_string(),
        expected
      );
    }
  }

  #[tokio::test]
  async fn bash_quoting_reaches_sync_and_async_posix_hosts() {
    let mut host = LispHost::new();
    host.register_native_closure("probe", |args| Ok(args.into_iter().next().unwrap()));
    for (source, expected) in [
      (r#"probe "a\.b""#, r"a\.b"),
      (r#"probe "a\tb""#, r"a\tb"),
      (r#"probe "cost \$5""#, "cost $5"),
      (r"probe $'a\tb'", "a\tb"),
      (r"probe pre$'\n'post", "pre\npost"),
    ] {
      assert_eq!(
        host.eval_posix_line(source).unwrap(),
        JsonValue::from(expected)
      );
      assert_eq!(
        host.eval_posix_line_async(source).await.unwrap(),
        JsonValue::from(expected)
      );
    }
    for source in ["probe \"a\\", "probe $'a\\"] {
      assert_eq!(
        host.eval_posix_line(source).unwrap_err().to_string(),
        "lisp parse error: unterminated quote"
      );
      assert_eq!(
        host
          .eval_posix_line_async(source)
          .await
          .unwrap_err()
          .to_string(),
        "unterminated quote"
      );
    }
  }

  #[test]
  fn help_flag_head_aliases_to_the_help_command() {
    assert_eq!(head_flag_alias("--help"), Some("help"));
    assert_eq!(head_flag_alias("-h"), None);
    // Bareword `help`, real commands, and `--version` (owned upstream) pass through.
    assert_eq!(head_flag_alias("help"), None);
    assert_eq!(head_flag_alias("ls"), None);
    assert_eq!(head_flag_alias("--version"), None);
  }

  /// Dropping a host frees the scope its lambdas captured: a `def`'d lambda
  /// is stored in the very scope it closes over, a cycle only the host's
  /// explicit clear breaks. Without it the scope — and everything a run
  /// defined into it — outlives the host, once per run.
  #[test]
  fn dropping_a_host_frees_the_scope_its_lambdas_captured() {
    let mut host = LispHost::new();
    host
      .eval_stmt("(let keep (lambda (x) (list x keep)))")
      .unwrap();
    host.eval_stmt("(let held (keep 1))").unwrap();
    let scope = Rc::downgrade(&host.env);
    drop(host);
    assert!(
      scope.upgrade().is_none(),
      "the host's scope outlived it: a def'd lambda still holds it"
    );
  }

  #[test]
  fn script_args_are_explicit_host_context() {
    let mut host = LispHost::new();
    assert_eq!(
      host.eval_to_json("(std.script.args)").unwrap(),
      serde_json::json!([])
    );
    assert!(
      host
        .set_script_args(vec!["zero".into(), "one".into()])
        .is_empty()
    );
    assert_eq!(
      host.eval_to_json("(std.script.args)").unwrap(),
      serde_json::json!(["zero", "one"])
    );
  }

  /// A ui-bearing bundle imported into a host WITHOUT the session UI layer
  /// must still mount cleanly — queued ui scripts are skipped, not evaluated
  /// into undefined `defmode`/`bind-key` symbols. (Regression: a plain
  /// A seed is a set of DECLARATIONS, not a procedure: a form this host never
  /// registered costs only its own line, and every `def` below it still lands.
  ///
  /// Regression (tsh(28)): the shipped prelude declares `(exec.path)` ABOVE the
  /// unix-name `def`s. On a host built without the exec vocabulary that form is
  /// an undefined symbol, and an all-or-nothing seed threw the whole file away
  /// — `ls`, `cat`, `cd`, `echo` and every `prompt.*` silently vanished from
  /// the one-shot CLI and the REPL while the engine's ctl host, which registers
  /// its vocabulary first, kept working. One artifact, two evaluators, two
  /// different vocabularies.
  #[test]
  fn a_failing_seed_form_does_not_discard_the_declarations_below_it() {
    // Driven through `register_commands`, the real seeding path — so this also
    // pins that the seed is evaluated form-by-form, not merely that it CAN be.
    let scripts = Rc::new(
      crate::Scripts::new(())
        .with_root_prelude("(let a 1)\n(no.such.form.on.this.host)\n(let b 2)\n"),
    );
    let mut host = LispHost::new();
    host.register_commands(scripts, Rc::new(std::collections::HashMap::new()));
    // Both sides of the failing form survive it.
    for (name, expected) in [("a", 1), ("b", 2)] {
      match host.eval_expr(name) {
        Ok(HostValue::Lisp(LispScalar::Integer(n))) => assert_eq!(n, expected, "{name}"),
        other => panic!("expected `{name}` bound to {expected}, got {other:?}"),
      }
    }
  }

  /// A failing seed form is reported with its file and line, never only to a
  /// trace (argv.md I10), and the forms after it still bind. A seed with no
  /// origin names its own line; a seed that does not parse names the file.
  #[test]
  fn a_failing_seed_form_is_reported_with_its_file_and_line() {
    let mut host = LispHost::new();
    let origin: Vec<crate::SeedLine> = [3, 7, 8, 9]
      .into_iter()
      .map(|line| crate::SeedLine { file: "/rc/prelude.tshrc".into(), line })
      .collect();
    let failures = host.eval_seed(
      "(let a 1)\n(let b\n  (no.such.form.on.this.host))\n(let c 3)\n",
      &origin,
    );
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
      failures[0].starts_with("warning: prelude `/rc/prelude.tshrc` line 7: "),
      "{failures:?}"
    );
    assert!(failures[0].contains("no.such.form.on.this.host"), "{failures:?}");
    assert!(host.eval_expr("c").is_ok(), "the form after the failure still binds");

    let failures = host.eval_seed("(let d 1) (no.such.seed.form)\n", &[]);
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].starts_with("warning: prelude seed line 1: "), "{failures:?}");

    let failures = host.eval_seed("(let e\n", &origin);
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
      failures[0].starts_with("warning: prelude `/rc/prelude.tshrc`: did not parse"),
      "{failures:?}"
    );
  }

  #[test]
  fn register_native_closure_captures_mutable_state() {
    let counter: Rc<Cell<i32>> = Rc::new(Cell::new(0));
    let counter_in = counter.clone();
    let mut host = LispHost::new();
    host.register_native_closure("bump", move |_args: Vec<HostValue>| {
      counter_in.set(counter_in.get() + 1);
      Ok(HostValue::Lisp(
        LispScalar::Integer(counter_in.get() as i64),
      ))
    });
    let v = host.eval_expr("(bump)").expect("first bump");
    assert!(matches!(v, HostValue::Lisp(LispScalar::Integer(1))));
    let v = host.eval_expr("(bump)").expect("second bump");
    assert!(matches!(v, HostValue::Lisp(LispScalar::Integer(2))));
    assert_eq!(counter.get(), 2);
  }

  #[test]
  fn register_native_closure_forwards_args_and_errors() {
    let mut host = LispHost::new();
    host.register_native_closure("echo", |args: Vec<HostValue>| {
      // First arg must be a string; uppercase it and return.
      let first = args
        .into_iter()
        .next()
        .ok_or_else(|| LispHostError::Runtime("echo expects 1 arg".to_string()))?;
      match first {
        HostValue::Lisp(LispScalar::String(s)) => {
          Ok(HostValue::Lisp(LispScalar::String(s.to_uppercase())))
        }
        other => Err(LispHostError::NonScalar(format!("{:?}", other))),
      }
    });
    let v = host.eval_expr(r#"(echo "hi")"#).expect("echo");
    match v {
      HostValue::Lisp(LispScalar::String(s)) => assert_eq!(s, "HI"),
      other => panic!("expected uppercase echo, got {:?}", other),
    }
    // Bubble closure-returned LispHostError up as a runtime error.
    let err = host.eval_expr("(echo 42)").unwrap_err();
    let msg = format!("{}", err);
    assert!(
      msg.contains("echo: "),
      "expected echo-tagged runtime err, got: {}",
      msg
    );
  }

  // JSON ↔ lisp widening round-trips structured values (objects, arrays,
  // scalars, null). Pure + offline.
  #[test]
  fn json_lisp_roundtrip() {
    let j = serde_json::json!({
      "email": "james@example.com",
      "user_id": 42,
      "flag": true,
      "tags": ["a", "b"],
      "missing": null
    });
    let back = lisp_to_json(&json_to_lisp(&j));
    assert_eq!(back, j);
  }

  /// The `(@import "name")` special form goes through the lisp evaluator (not
  /// a parser-level directive) — bare-paren auto-classifies as LispStmt, the
  /// interpreter routes `@import` to `special_import`, which calls the
  /// registered handler and mounts the result. With no apps available the
  /// handler surfaces a Lisp runtime error; the test runs without
  /// `TSH_APP_PATH` so it always exercises the host-wiring path.
  /// An unbound bare-word *argument* (not a command head) surfaces the
  /// enriched teaching error: the original `undefined symbol` message plus the
  /// bare-word-vs-string law. `list` is a builtin, so the head resolves and the
  /// error comes from evaluating the `perms` argument — the eval_last mapping
  /// site, not the `CommandNotFound` head path.
  #[test]
  fn undefined_argument_teaches_bare_word_law() {
    let mut host = LispHost::new();
    let err = host.eval_expr("(list perms)").unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("undefined symbol"), "got: {msg}");
    assert!(msg.contains("bare words are references"), "got: {msg}");
  }

  #[test]
  fn at_import_form_routes_through_handler() {
    let mut host = LispHost::new();
    let err = host.eval_expr(r#"(@import "tento-whoop")"#).unwrap_err();
    let msg = format!("{err}");
    assert!(
      msg.contains("@import"),
      "error should mention @import; got: {msg}"
    );
  }

  /// A captured error value crosses the Lisp→JSON bridge as the tagged
  /// `error/v1` record (the explicit `lisp_to_json` arm, not the null default).
  #[test]
  fn error_value_crosses_as_tagged_error_v1_record() {
    let mut host = LispHost::new();
    let j = host.eval_to_json("(try (nope))").expect("try captures");
    assert_eq!(j["type"], "error/v1");
    assert_eq!(j["kind"], "unbound");
    assert!(
      j["message"].as_str().unwrap().contains("undefined symbol"),
      "got: {j}"
    );
    assert!(j["origin"].as_str().unwrap().contains("nope"), "got: {j}");
    assert!(j["chain"].as_array().unwrap().is_empty(), "got: {j}");
  }

  /// The SYNC posix line (the script runner's path) mirrors the async twins:
  /// an undefined HEAD is an unknown COMMAND — it gets the command-not-found
  /// text, never the bare-word "quote it for a string" teaching (which is
  /// actively wrong advice for a head; quoting a command name runs nothing).
  #[test]
  fn sync_posix_line_unknown_head_is_command_not_found() {
    let mut host = LispHost::new();
    let err = host.eval_posix_line("zzznotacommand /tmp").unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("no command `zzznotacommand`"), "got: {msg}");
    assert!(
      !msg.contains("bare words are references"),
      "a head must not get the argument-position teaching: {msg}"
    );
  }

  /// A close typo of a registered command carries the did-you-mean suggestion
  /// on the sync path too.
  #[test]
  fn sync_posix_line_unknown_head_suggests_nearest_command() {
    let mut host = LispHost::new();
    host.command_names = vec!["table.show".to_string()];
    let err = host.eval_posix_line("table.shw perms").unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("did you mean `table.show`"), "got: {msg}");
  }

  /// The sync argv door (one-shot CLI) gets the same head treatment.
  #[test]
  fn sync_posix_argv_unknown_head_is_command_not_found() {
    let mut host = LispHost::new();
    let err = host
      .eval_posix_argv(vec!["zzznotacommand".to_string()])
      .unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("no command `zzznotacommand`"), "got: {msg}");
    assert!(!msg.contains("bare words are references"), "got: {msg}");
  }

  /// The native wrappers build from the error's INNER message and don't
  /// re-prefix a text that already self-identifies — one `myname:`, not
  /// `myname: lisp error: myname: …`.
  #[test]
  fn native_error_text_is_not_double_prefixed() {
    let mut host = LispHost::new();
    host.register_native_special("myname", |_args| {
      Err(LispHostError::Runtime("myname: boom".to_string()))
    });
    let err = host.eval_expr("(myname)").unwrap_err();
    let msg = format!("{err}");
    assert_eq!(
      msg.matches("myname:").count(),
      1,
      "exactly one self-identification: {msg}"
    );
    assert!(msg.contains("boom"), "got: {msg}");
    assert!(
      !msg.contains("lisp error: myname: lisp error"),
      "got: {msg}"
    );
    // A native that does NOT self-identify still gets tagged.
    host.register_native_special("plain", |_args| {
      Err(LispHostError::Runtime("boom".to_string()))
    });
    let msg = format!("{}", host.eval_expr("(plain)").unwrap_err());
    assert!(msg.contains("plain: boom"), "got: {msg}");
  }

  /// Operator finding (session 42533): `✗ [line 1] ls -t — lisp error: ls: -t …`
  /// stacked three labels. A dispatched command's OWN failure is command-origin
  /// (`RuntimeError::Command`), so it renders WITHOUT the interpreter's
  /// `lisp error:` label — the command already self-identifies (`ls: …`). A
  /// genuine interpreter fault (undefined symbol) keeps the label.
  #[test]
  fn command_error_drops_lisp_error_label_interpreter_fault_keeps_it() {
    let mut host = LispHost::new();
    // The command dispatch layer tags its own failures command-origin.
    host.register_command_native("ls", |_args| {
      Err(RuntimeError::Command {
        detail: "ls: -t (sort by mtime) is recognized but not implemented yet".to_string(),
      })
    });
    let msg = format!("{}", host.eval_expr("(ls)").unwrap_err());
    assert!(
      msg.contains("ls: -t (sort by mtime)"),
      "the command's self-identifying text is intact: {msg}"
    );
    assert!(
      !msg.contains("lisp error"),
      "a command error drops the interpreter label: {msg}"
    );

    // Contrast: an interpreter-proper fault keeps `lisp error:`.
    let interp = format!("{}", host.eval_expr("(undefined-thing)").unwrap_err());
    assert!(
      interp.contains("lisp error"),
      "an interpreter fault keeps the label: {interp}"
    );
  }

  /// tsh-core-shell(14) W4: a reported failure crosses the host boundary
  /// with its fields — the text is what `Runtime` gave, `(try …)` keeps the
  /// display fields, and the script error hands them to the embedding shell.
  #[test]
  fn a_reported_failure_keeps_its_display_across_the_host() {
    let display = serde_json::json!({"shape": "term.block/v1", "rows": [{"spans": [{"text": "Count"}]}]});
    let shown = display.clone();
    let mut host = LispHost::new();
    host.register_native_special("partialnat", move |_args| {
      Err(LispHostError::Reported(Box::new(tento_lisp::ReportedFailure {
        message: "part did not load".into(),
        kind: Some("partial".into()),
        display: shown.as_object().cloned(),
        ..Default::default()
      })))
    });
    let err = host.eval_expr("(partialnat)").unwrap_err();
    assert_eq!(err.to_string(), "lisp error: partialnat: part did not load\nkind: partial");
    let LispHostError::Reported(failure) = &err else { panic!("got: {err:?}") };
    assert_eq!(failure.display.as_ref(), display.as_object());
    let caught = host.eval_to_json("(try (partialnat))").expect("try captures it");
    assert_eq!((caught["kind"].as_str(), caught["shape"].as_str()), (Some("partial"), Some("term.block/v1")));
    let script = crate::script::TshScriptError {
      line: 1,
      source_line: "(partialnat)".into(),
      kind: crate::script::TshScriptErrorKind::Lisp(err),
    };
    assert_eq!(script.reported_display(), display.as_object());
    let plain = crate::script::TshScriptError {
      line: 1,
      source_line: "x".into(),
      kind: crate::script::TshScriptErrorKind::Lisp(LispHostError::Runtime("x".into())),
    };
    assert_eq!(plain.reported_display(), None);
  }

  /// A native returning `LispHostError::Fatal` stays HARD through the wrapper:
  /// the mapped `RuntimeError` is `Fatal` (so `try` can't defuse it and the
  /// round-trip back through `runtime_host_error` lands on `Fatal` again).
  #[test]
  fn native_fatal_stays_hard_through_the_wrapper() {
    let mut host = LispHost::new();
    host.register_native_special("hardnat", |_args| {
      Err(LispHostError::Fatal("hardnat: down".to_string()))
    });
    let err = host.eval_expr("(hardnat)").unwrap_err();
    assert!(
      matches!(err, LispHostError::Fatal(_)),
      "severity preserved end-to-end: {err:?}"
    );
    // Behavioral proof: `try` cannot defuse it into an error value.
    let err = host.eval_expr("(try (hardnat))").unwrap_err();
    assert!(matches!(err, LispHostError::Fatal(_)), "got: {err:?}");
  }

  /// An unknown command head still yields the structured `CommandNotFound`
  /// (the head-match arm is upstream of the soft/hard host mapping and must
  /// keep firing after the Phase 2 changes).
  #[tokio::test]
  async fn unknown_head_stays_structured_command_not_found() {
    let mut host = LispHost::new();
    let err = host
      .eval_posix_line_async("zzznotacommand")
      .await
      .expect_err("unknown head");
    assert!(
      matches!(err, crate::Error::CommandNotFound { .. }),
      "got: {err:?}"
    );
  }

  /// Fake external hook: `known` names resolve; `declared` gates Runs vs the
  /// teaching Undeclared; every run's argv is recorded for fidelity asserts.
  struct FakeExternal {
    known: Vec<String>,
    declared: bool,
    ran: Rc<RefCell<Vec<Vec<String>>>>,
  }

  impl ExternalCommands for FakeExternal {
    fn lookup(&self, head: &str) -> ExternalLookup {
      if !self.known.iter().any(|k| k == head) {
        return ExternalLookup::NotFound;
      }
      if self.declared {
        ExternalLookup::Runs
      } else {
        ExternalLookup::Undeclared(format!("/fake/bin/{head}"))
      }
    }

    fn run(&self, argv: Vec<String>) -> AsyncCommandFut {
      self.ran.borrow_mut().push(argv.clone());
      Box::pin(async move { Ok(serde_json::json!({ "ran": argv })) })
    }

    fn suggest(&self, typed: &str) -> Option<String> {
      crate::run_loop::nearest_match(typed, &self.known)
    }
  }

  fn external_host(declared: bool, known: &[&str]) -> (LispHost, Rc<RefCell<Vec<Vec<String>>>>) {
    let mut host = LispHost::new();
    let ran = Rc::new(RefCell::new(Vec::new()));
    host.set_external_commands(Rc::new(FakeExternal {
      known: known.iter().map(|s| s.to_string()).collect(),
      declared,
      ran: ran.clone(),
    }));
    (host, ran)
  }

  #[tokio::test]
  async fn external_help_flags_reach_both_doors_unchanged() {
    let (mut host, ran) = external_host(true, &["du"]);
    for words in [vec!["du", "-h", "."], vec!["du", "--help"]] {
      host.eval_posix_line_async(&words.join(" ")).await.unwrap();
      host
        .eval_posix_argv_async(words.iter().map(|w| w.to_string()).collect())
        .await
        .unwrap();
      let expected: Vec<String> = words.iter().map(|w| w.to_string()).collect();
      let calls = ran.borrow();
      assert_eq!(calls[calls.len() - 2], expected);
      assert_eq!(calls[calls.len() - 1], expected);
    }
  }

  #[test]
  fn reflection_binds_only_before_dashdash() {
    let mut argv = vec!["cmd".into(), "-h".into(), "--help".into(), "--json".into(), "--".into(), "--help".into(), "--json".into()];
    let options = super::super::arg_bind::take_reflection_argv(&mut argv);
    assert!(options.help && options.json);
    assert_eq!(argv, vec!["cmd", "-h", "--", "--help", "--json"]);
  }

  #[tokio::test]
  async fn mounted_script_group_does_not_reserve_short_help() {
    let scripts = crate::Scripts::new(());
    let err =
      match crate::shell::Callable::call_with_argv(&scripts, vec!["group".into(), "-h".into()]) {
        Ok(_) => panic!("-h was consumed as group help"),
        Err(err) => err,
      };
    assert!(matches!(err, crate::Error::CommandNotFound { .. }), "{err}");
    let doc =
      crate::shell::Callable::call_with_argv(&scripts, vec!["group".into(), "--help".into()])
        .unwrap()
        .await
        .unwrap();
    assert!(doc.is_object(), "{doc}");
  }

  async fn run_test_source(
    host: &mut LispHost,
    source: &str,
  ) -> Result<Option<JsonValue>, super::super::TshScriptError> {
    super::super::run_source_on_host(
      host,
      source,
      &crate::Scripts::new(()),
      &HashMap::new(),
      &[],
      super::super::RunOptions::default(),
    )
    .await
  }

  /// A mount's bare namespace word never shadows a `PATH` program (operator
  /// Refinement 4, 2026-10-05): with tsh-tmux mounted as `tmux`, a bash line
  /// `tmux ls` runs the tmux program through every door. A group whose word
  /// names no program still answers its own word.
  #[tokio::test]
  async fn a_mount_word_never_shadows_a_path_program() {
    let (mut host, ran) = external_host(true, &["tmux"]);
    let (scripts, subs) = crate::Scripts::new(())
      .add_unavailable("tmux", "the plugin group answered")
      .add_unavailable("agents", "the plugin group answered")
      .into_command_parts();
    host.register_commands(Rc::new(scripts), Rc::new(subs));
    assert!(host.mount_yields_to_program("tmux"));
    assert!(!host.mount_yields_to_program("agents"), "no program of that name");
    host.eval_posix_line_async("tmux ls").await.unwrap();
    host.eval_posix_argv_async(vec!["tmux".into(), "attach".into(), "-t".into(), "x".into()]).await.unwrap();
    run_test_source(&mut host, "tmux ls -F x").await.unwrap();
    assert_eq!(
      *ran.borrow(),
      [vec!["tmux", "ls"], vec!["tmux", "attach", "-t", "x"], vec!["tmux", "ls", "-F", "x"]],
      "every door ran the program"
    );
    let error = host.eval_posix_line_async("agents ls").await.unwrap_err().to_string();
    assert!(error.contains("the plugin group answered"), "{error}");
  }

  #[tokio::test]
  async fn script_routing_reads_plain_commands_once() {
    let (mut host, ran) = external_host(true, &["outside"]);
    host.register_native_closure("inside", |_| Ok(HostValue::from_json(JsonValue::from(42))));
    assert_eq!(
      run_test_source(&mut host, "inside alpha beta")
        .await
        .unwrap(),
      Some(JsonValue::from(42))
    );
    assert_eq!(
      host.posix_reads, 1,
      "routing and sync execution share the reader result"
    );
    run_test_source(&mut host, "outside alpha beta")
      .await
      .unwrap();
    assert_eq!(host.posix_reads, 2, "async execution also reads only once");
    assert_eq!(
      ran.borrow().as_slice(),
      &[vec!["outside".to_string(), "alpha".into(), "beta".into()]]
    );
  }

  async fn legacy_script_line(
    host: &mut LispHost,
    source: &str,
  ) -> Result<Option<JsonValue>, super::super::TshScriptErrorKind> {
    use super::super::TshScriptErrorKind;
    let value = if host.posix_line_is_async_mount(source) {
      host
        .eval_posix_line_async(source)
        .await
        .map_err(TshScriptErrorKind::Command)?
    } else {
      host
        .eval_posix_line(source)
        .map_err(TshScriptErrorKind::Lisp)?
    };
    Ok((!value.is_null()).then_some(value))
  }

  #[tokio::test]
  async fn script_routing_preserves_results_errors_effects_and_prev() {
    fn configured(declared: bool) -> (LispHost, Rc<RefCell<Vec<Vec<String>>>>, Rc<Cell<usize>>) {
      let (mut host, ran) = external_host(declared, &["outside", "shadow", "~/tool"]);
      host.register_native_special("inside", |args| {
        Ok(LispValue::List(tento_lisp::List { items: args.into() }))
      });
      host.register_native_special("shadow", |_| Ok(LispValue::Integer(44)));
      host.register_native_special("hard", |_| Err(LispHostError::Fatal("stop".into())));
      let ticks = Rc::new(Cell::new(0));
      let count = ticks.clone();
      host.register_native_special("tick", move |_| {
        count.set(count.get() + 1);
        Ok(LispValue::Integer(7))
      });
      host.register_native_special("async.run", |_| {
        Err(LispHostError::Fatal("wrong sync route".into()))
      });
      host
        .async_mount_names
        .borrow_mut()
        .insert("async.run".into());
      host.async_commands.borrow_mut().insert(
        "async.run".into(),
        Rc::new(|argv| {
          Ok(Box::pin(async move {
            tokio::task::yield_now().await;
            Ok(serde_json::json!(argv))
          }))
        }),
      );
      (host, ran, ticks)
    }
    let cases = [
      "inside alpha --long -s",
      "inside $(tick)",
      "outside $(tick) --flag",
      "async.run $(tick)",
      "shadow",
      "missing x",
      "inside $unbound",
      "outside $unbound",
      "async.run $unbound",
      "hard",
      "x=$(tick)",
      "inside 'quoted text' \"more text\"",
      "inside ~/x '~' \"~/quoted\"",
      "~/tool arg",
      "inside 'unterminated",
      "inside $(",
      "A=x command",
      "inside #json",
    ];
    for declared in [false, true] {
      for source in cases {
        let (mut control, old_ran, old_ticks) = configured(declared);
        let (mut candidate, new_ran, new_ticks) = configured(declared);
        let expected = legacy_script_line(&mut control, source).await;
        let actual = run_test_source(&mut candidate, source)
          .await
          .map_err(|e| e.kind);
        match (expected, actual) {
          (Ok(a), Ok(b)) => assert_eq!(a, b, "{source}"),
          (Err(a), Err(b)) => {
            assert_eq!(
              std::mem::discriminant(&a),
              std::mem::discriminant(&b),
              "{source}"
            );
            assert_eq!(a.to_string(), b.to_string(), "{source}");
          }
          (a, b) => panic!("{source}: {a:?} vs {b:?}"),
        }
        assert_eq!(*old_ran.borrow(), *new_ran.borrow(), "{source}");
        assert_eq!(old_ticks.get(), new_ticks.get(), "{source}");
        assert!(
          new_ticks.get() <= 1,
          "substitution ran more than once: {source}"
        );
        assert_eq!(
          control.eval_to_json("prev").map_err(|e| e.to_string()),
          candidate.eval_to_json("prev").map_err(|e| e.to_string()),
          "{source}"
        );
      }
    }
  }

  /// `prev` reads the same whether the value was kept or rebuilt from the
  /// runner's JSON: data stays itself, and what the JSON bridge cannot carry
  /// (an error value, a function) reads back as the record or `nil` it
  /// always did.
  #[test]
  fn prev_keeps_data_and_reads_non_data_through_the_json_bridge() {
    let mut host = LispHost::new();
    host.eval_lisp_line("\"two\\nlines\\n\"").unwrap();
    assert_eq!(host.eval_to_json("prev").unwrap(), serde_json::json!("two\nlines\n"));
    host.eval_lisp_line("(list 1 2.5 true nil \"s\" (hash-map \"k\" 1))").unwrap();
    assert_eq!(host.eval_to_json("(nth prev 5)").unwrap(), serde_json::json!({"k": 1}));
    host.eval_lisp_line("(try (/ 1 0))").unwrap();
    assert_eq!(host.eval_to_json("(error? prev)").unwrap(), serde_json::json!(false), "an error value reads back as its record");
    assert_eq!(host.eval_to_json("(get prev \"type\")").unwrap(), serde_json::json!("error/v1"));
    host.eval_lisp_line("(lambda (x) (+ x 1))").unwrap();
    assert_eq!(host.eval_to_json("prev").unwrap(), serde_json::Value::Null, "a function reads back as nil");
  }

  /// Where the JSON bridge changes a value, `prev` is what the bridge gives
  /// back: a map's keys come back sorted, and a container nested past the
  /// depth limit comes back as a depth record. Data built far deeper than any
  /// native stack is checked without recursion.
  #[test]
  fn prev_follows_the_json_bridge_for_map_order_and_depth() {
    let mut host = LispHost::new();
    host.eval_lisp_line("(hash-map \"z\" 1 \"a\" 2)").unwrap();
    assert_eq!(host.eval_to_json("(keys prev)").unwrap(), serde_json::json!(["a", "z"]));
    host.eval_lisp_line("(list (hash-map \"z\" 1 \"b\" 2))").unwrap();
    assert_eq!(host.eval_to_json("(keys (nth prev 0))").unwrap(), serde_json::json!(["b", "z"]), "nested maps too");
    host.eval_lisp_line("(hash-map \"a\" 1 \"b\" 2)").unwrap();
    assert_eq!(host.eval_to_json("(keys prev)").unwrap(), serde_json::json!(["a", "b"]), "a sorted map is kept");
    let unwrap = "(reduce (lambda (v x) (nth v 0)) prev (range 0 1000))";
    host.eval_lisp_line("(reduce (lambda (v x) (list v)) 7 (range 0 1000))").unwrap();
    assert_eq!(host.eval_to_json(unwrap).unwrap(), serde_json::json!(7), "the limit's worth of lists is carried whole");
    host.eval_lisp_line("(reduce (lambda (v x) (list v)) 7 (range 0 1001))").unwrap();
    assert_eq!(host.eval_to_json(&format!("(get {unwrap} \"type\")")).unwrap(), serde_json::json!("error/v1"), "one more is cut where the bridge cuts it");
    host.eval_lisp_line("(reduce (lambda (v x) (list v)) 7 (range 0 100000))").unwrap();
    assert_eq!(host.eval_to_json(&format!("(get {unwrap} \"type\")")).unwrap(), serde_json::json!("error/v1"), "far deeper than the native stack");
  }

  #[test]
  #[ignore = "controlled performance probe; script routing in one persistent host"]
  fn repeated_script_routing_bench() {
    let (mut host, _) = external_host(true, &[]);
    host.register_native_closure("probe", |args| {
      assert_eq!(args.len(), 8);
      Ok(HostValue::from_json(JsonValue::from(42)))
    });
    let source = "probe alpha beta gamma delta epsilon zeta eta theta\n".repeat(10_000);
    let started = std::time::Instant::now();
    let result = futures::executor::block_on(run_test_source(&mut host, &source)).unwrap();
    assert_eq!(result, Some(JsonValue::from(42)));
    eprintln!(
      "routing_bench {}",
      serde_json::json!({"run_us": started.elapsed().as_micros(), "commands": 10_000, "reads": host.posix_reads})
    );
  }

  /// The argv door hands the external the RAW words: short flags, long flags,
  /// and `--` all reach the child verbatim — no keyword mangling, no
  /// mandatory `--`.
  #[tokio::test]
  async fn external_argv_reaches_child_verbatim() {
    let (mut host, ran) = external_host(true, &["git"]);
    let value = host
      .eval_posix_argv_async(vec![
        "git".into(),
        "status".into(),
        "-sb".into(),
        "--porcelain".into(),
      ])
      .await
      .expect("external runs");
    assert_eq!(value["ran"][0], "git");
    assert_eq!(
      ran.borrow()[0],
      vec!["git", "status", "-sb", "--porcelain"],
      "raw argv untouched"
    );
  }

  /// The line door lowers a posix line back to argv for the external —
  /// keywords re-lower to `--flags`, short flags stay literal words.
  #[tokio::test]
  async fn external_line_reaches_child() {
    let (mut host, ran) = external_host(true, &["git"]);
    host
      .eval_posix_line_async("git status -sb --porcelain")
      .await
      .expect("external runs");
    assert_eq!(
      ran.borrow()[0],
      vec!["git", "status", "-sb", "--porcelain"],
      "line lowering preserves flags"
    );
  }

  /// A tsh command wins over an external of the same name, but a Lisp binding
  /// is not a command: `(let git …)` does not capture the bash word `git`
  /// (I12), so the binary still runs.
  #[tokio::test]
  async fn a_host_command_shadows_an_external_but_a_lisp_binding_does_not() {
    let (mut host, ran) = external_host(true, &["git"]);
    host.eval_stmt("(let git (lambda () \"defined\"))").unwrap();
    host.eval_posix_line_async("git").await.expect("the external runs");
    assert_eq!(ran.borrow().len(), 1, "a Lisp binding never answers a bash command");
    assert_eq!(ran.borrow()[0], vec!["git"]);
    host.register_native_special("git", |_| Ok(LispValue::String("native".into())));
    let value = host.eval_posix_line_async("git").await.expect("the host command runs");
    assert_eq!(value, serde_json::json!("native"));
    assert_eq!(ran.borrow().len(), 1, "the external was not consulted again");
  }

  /// argv.md I13, I11: a Lisp call with no binding runs the program. Strings
  /// pass verbatim; a keyword is a flag; an option map carries the options that
  /// take values.
  #[tokio::test]
  async fn an_unbound_lisp_call_runs_the_program_with_the_option_convention() {
    let (mut host, ran) = external_host(true, &["git"]);
    for source in [
      r#"(git "status" "-sb")"#,
      r#"(git "log" :oneline :n {:format "%h" :n 3 :graph true :quiet false})"#,
      r#"(git "log" "--" ":oneline")"#,
    ] {
      host.eval_lisp_host_line(source).await.unwrap();
    }
    let calls = ran.borrow();
    assert_eq!(calls[0], vec!["git", "status", "-sb"]);
    assert_eq!(
      calls[1],
      vec!["git", "log", "--oneline", "-n", "--format=%h", "-n", "3", "--graph"]
    );
    assert_eq!(calls[2], vec!["git", "log", "--", ":oneline"], "a string is verbatim, even when it looks like a keyword");
  }

  /// argv.md I12: bash command lookup never consults a Lisp binding, so a bash
  /// variable or a `def` that shares a command's name does not run in its place.
  #[tokio::test]
  async fn a_bash_variable_or_def_never_answers_a_command_word() {
    let (mut host, ran) = external_host(true, &["git"]);
    host.eval_posix_line_async("git=5").await.unwrap();
    host.eval_posix_line_async("git status").await.expect("the program runs");
    assert_eq!(ran.borrow().len(), 1);
    assert_eq!(ran.borrow()[0], vec!["git", "status"]);
    host.eval_posix_line_async("nothere=5").await.unwrap();
    let outcome = host.eval_posix_line_async("nothere").await;
    assert!(outcome.is_err() || host.shell_status() == 127, "a variable is not a command: {outcome:?}");
    assert_ne!(outcome.ok(), Some(serde_json::json!("5")), "the variable's value is never the command's result");
  }

  /// `std.sh.cmd` is callable from Lisp by exact name, so `true` is a string
  /// (argv.md I12): `(std.sh.cmd "true")` is bash's `true`.
  #[tokio::test]
  async fn std_sh_cmd_is_callable_from_lisp_by_exact_name() {
    let mut host = LispHost::new();
    host.eval_lisp_host_line(r#"(std.sh.cmd "true")"#).await.unwrap();
    assert_eq!(host.shell_status(), 0);
    host.eval_lisp_host_line(r#"(std.sh.cmd "false")"#).await.unwrap();
    assert_eq!(host.shell_status(), 1);
    host
      .eval_lisp_host_line(r#"(std.sh.and (std.sh.cmd "true") (std.sh.cmd "false"))"#)
      .await
      .unwrap();
    assert_eq!(host.shell_status(), 1, "the compiled flow runs over the same command words");
  }

  /// argv.md I12 note: a quoted or escaped command word compiles to
  /// `(std.sh.word.quoted "name")` and resolves exactly as the bare word.
  #[tokio::test]
  async fn a_quoted_command_word_resolves_as_the_bare_word() {
    let (mut host, ran) = external_host(true, &["git"]);
    for line in ["'git' status", r#""git" status"#, r"\git status", r"g\it status"] {
      host.eval_posix_line_async(line).await.expect("the program runs");
    }
    assert_eq!(ran.borrow().len(), 4);
    assert!(ran.borrow().iter().all(|argv| argv == &vec!["git", "status"]), "{:?}", ran.borrow());
    host.eval_lisp_host_line(r#"(std.sh.cmd (std.sh.word.quoted "false"))"#).await.unwrap();
    assert_eq!(host.shell_status(), 1, "a quoted builtin name is still the builtin");
  }

  /// An external host with a blocking runner (argv.md I13): records each
  /// argv; `fail` exits 7.
  struct BlockingExternal {
    ran: Rc<RefCell<Vec<Vec<String>>>>,
  }

  impl ExternalCommands for BlockingExternal {
    fn lookup(&self, head: &str) -> ExternalLookup {
      if matches!(head, "git" | "fail") { ExternalLookup::Runs } else { ExternalLookup::NotFound }
    }
    fn run(&self, argv: Vec<String>) -> AsyncCommandFut {
      self.ran.borrow_mut().push(argv.clone());
      Box::pin(async move { Ok(serde_json::json!({ "ran": argv })) })
    }
    fn run_blocking(&self, argv: Vec<String>) -> Option<crate::Result<JsonValue>> {
      self.ran.borrow_mut().push(argv.clone());
      Some(if argv[0] == "fail" {
        Err(crate::Error::ProcessExit { status: Some(7), signal: None, detail: "fail exited 7".into() })
      } else {
        Ok(serde_json::json!({ "ran": argv }))
      })
    }
    fn suggest(&self, _: &str) -> Option<String> {
      None
    }
  }

  fn blocking_host() -> (LispHost, Rc<RefCell<Vec<Vec<String>>>>, Rc<RefCell<Vec<u8>>>) {
    let mut host = LispHost::new();
    let ran = Rc::new(RefCell::new(Vec::new()));
    host.set_external_commands(Rc::new(BlockingExternal { ran: ran.clone() }));
    let written = Rc::new(RefCell::new(Vec::new()));
    let sink = written.clone();
    host.set_shell_byte_output(Rc::new(move |bytes| sink.borrow_mut().extend_from_slice(bytes)));
    (host, ran, written)
  }

  /// argv.md I13: an unbound name called inside an `if`, a `let`, a lambda or
  /// a named function body runs the program, its arguments converted by I11.
  #[tokio::test]
  async fn a_nested_unbound_call_runs_the_program() {
    let (mut host, ran, _) = blocking_host();
    for source in [
      r#"(if true (git "status" :s))"#,
      r#"(let ((x "log")) (git x {:n 3}))"#,
      r#"((lambda () (git "a")))"#,
      r#"(begin (defun f (y) (git y)) (f "b"))"#,
      r#"(begin (fn g (y) (git y)) (g "c"))"#,
    ] {
      host.eval_lisp_host_line(source).await.unwrap_or_else(|error| panic!("{source}: {error}"));
    }
    assert_eq!(
      *ran.borrow(),
      vec![vec!["git", "status", "-s"], vec!["git", "log", "-n", "3"], vec!["git", "a"], vec!["git", "b"], vec!["git", "c"]]
    );
  }

  /// Nested bash builtins run here and write where the shell writes; the test
  /// builtins answer a boolean for Lisp conditions.
  #[tokio::test]
  async fn a_nested_builtin_runs_and_tests_answer_booleans() {
    let (mut host, ran, written) = blocking_host();
    host
      .eval_lisp_host_line(r#"(if (test "-n" "x") (echo "yes" "1") (echo "no"))"#)
      .await
      .unwrap();
    host.eval_lisp_host_line(r#"(let ((v "a b")) (if (test "-z" "x") (echo "no") (echo v "c")))"#).await.unwrap();
    assert_eq!(String::from_utf8_lossy(&written.borrow()), "yes 1\na b c\n");
    assert_eq!(host.shell_status(), 0);
    assert!(ran.borrow().is_empty(), "builtins never reach the external host");
    host.eval_lisp_host_line(r#"(begin (printf "%s" "async"))"#).await.unwrap();
    host.eval_to_json(r#"(begin (printf "%s" "sync"))"#).unwrap();
    assert!(String::from_utf8_lossy(&written.borrow()).ends_with("asyncsync"));
  }

  /// A failed nested program is an error carrying its status, with no message
  /// of its own (I14); a shell function and a stateful builtin are refused.
  #[tokio::test]
  async fn a_failed_nested_program_carries_its_status() {
    let (mut host, _, _) = blocking_host();
    let error = host.eval_lisp_host_line(r#"(if true (fail "x"))"#).await.unwrap_err();
    assert!(matches!(
      &error,
      super::super::runner::TshScriptErrorKind::Lisp(LispHostError::Exit { status: 7, message }) if message.is_empty()
    ), "{error:?}");
    assert_eq!(host.shell_status(), 7);
    host.eval_posix_line_async("greet() { echo hi; }").await.unwrap();
    let error = host.eval_lisp_host_line(r#"(if true (greet))"#).await.unwrap_err();
    assert!(error.to_string().contains("greet: a shell function cannot run inside a Lisp expression"), "{error}");
    let error = host.eval_lisp_host_line(r#"(if true (read "x"))"#).await.unwrap_err();
    assert!(error.to_string().contains("read: this shell builtin cannot run"), "{error}");
  }

  /// A host with no blocking runner refuses a nested program loudly.
  #[tokio::test]
  async fn a_host_without_a_blocking_runner_refuses_nested_programs() {
    let (mut host, ran) = external_host(true, &["git"]);
    let error = host.eval_lisp_host_line(r#"(if true (git "status"))"#).await.unwrap_err();
    assert!(error.to_string().contains("git: cannot run inside a Lisp expression on this host"), "{error}");
    assert!(ran.borrow().is_empty());
  }

  /// Undeclared policy: a head the hook knows but may not run surfaces the
  /// teaching error naming the path and the fix.
  #[tokio::test]
  async fn undeclared_external_teaches() {
    let (mut host, _ran) = external_host(false, &["git"]);
    let err = host
      .eval_posix_line_async("git status")
      .await
      .expect_err("undeclared must not run");
    let msg = format!("{err}");
    assert!(msg.contains("/fake/bin/git"), "names the path: {msg}");
    assert!(msg.contains("(exec.path)"), "names the fix: {msg}");
  }

  /// A typo near an external name gets the external suggestion when no
  /// registered command is close.
  #[tokio::test]
  async fn command_not_found_suggests_external_names() {
    let (mut host, _ran) = external_host(true, &["git"]);
    let err = host
      .eval_posix_line_async("gti status")
      .await
      .expect_err("typo is not a command");
    match err {
      crate::Error::CommandNotFound { suggestion, .. } => {
        assert_eq!(suggestion.as_deref(), Some("git"));
      }
      other => panic!("expected CommandNotFound, got {other:?}"),
    }
  }

  /// The runner's routing predicate: an unbound external candidate needs the
  /// async door; a bound head or an unknown word does not.
  #[test]
  fn async_door_routing_for_externals() {
    let (mut host, _ran) = external_host(true, &["git"]);
    assert!(host.posix_line_is_async_mount("git status"));
    assert!(!host.posix_line_is_async_mount("zzznotacommand at all"));
    host.eval_stmt("(let git (lambda () 1))").unwrap();
    assert!(
      host.posix_line_is_async_mount("git status"),
      "a Lisp binding does not take the head off the external door"
    );
    host.register_native_special("git", |_| Ok(LispValue::Nil));
    assert!(
      !host.posix_line_is_async_mount("git status"),
      "a host command binding stays on the sync path"
    );
  }
}

#[cfg(test)]
mod approved_numeric_regressions {
  use super::*;

  #[test]
  fn embedded_mixed_numeric_comparisons_preserve_integer_boundaries() {
    let mut host = LispHost::new();
    for (source, expected) in [
      ("(= 9007199254740993 9007199254740992.0)", false),
      ("(> 9007199254740993 9007199254740992.0)", true),
      ("(< 9223372036854775807 9223372036854775808.0)", true),
      ("(= -9223372036854775808 -9223372036854775808.0)", true),
    ] {
      assert!(
        matches!(host.eval_value(source).unwrap(), LispValue::Boolean(v) if v == expected),
        "{source}"
      );
    }
  }
}

/// Only the argv dispatch door teaches a bare file collision: command lookup
/// has already failed, and reading this file requires an explicit path.
fn bare_file_refusal(name: &str, regular_file: bool) -> Option<crate::Error> {
  (regular_file && !name.contains('/') && !(cfg!(windows) && name.contains('\\'))).then(|| {
    crate::Error::ProcessStart {
      status: 127,
      detail: format!("no command `{name}`; to run the file {name}, use `./{name}`"),
    }
  })
}

#[cfg(test)]
mod p1a_tests {
  use super::*;

  #[test]
  fn argv_file_collision_names_the_command_and_explicit_path() {
    let error = bare_file_refusal("deploy", true).unwrap();
    assert_eq!(error.process_status(), Some(127));
    assert_eq!(error.to_string(), "no command `deploy`; to run the file deploy, use `./deploy`");
    assert!(bare_file_refusal("deploy", false).is_none());
    assert!(bare_file_refusal("./deploy", true).is_none());
    assert!(bare_file_refusal("dir/deploy", true).is_none());
  }

  #[tokio::test]
  async fn argv_lookup_wins_over_a_same_named_regular_file() {
    let name = format!("p1a-file-{}-{}", std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    let path = std::env::current_dir().unwrap().join(&name);
    std::fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
    let mut host = LispHost::new();
    let error = host.eval_posix_argv_async(vec![name.clone()]).await.unwrap_err();
    assert_eq!(error.process_status(), Some(127));
    assert!(error.to_string().contains(&format!("use `./{name}`")));
    host.register_native_special(&name, |_| Ok(LispValue::String("found".into())));
    assert_eq!(host.eval_posix_argv_async(vec![name]).await.unwrap(), JsonValue::from("found"));
    std::fs::remove_file(path).unwrap();
  }

  #[tokio::test]
  async fn async_line_runs_every_form_and_refuses_a_single_semicolon_in_lisp() {
    let mut host = LispHost::new();
    host.eval_posix_line_async("(let a 1) (let b 2) ;; both run").await.unwrap();
    assert_eq!(host.eval_to_json("b").unwrap(), 2);
    // The legacy `>` prefix rules out bash, so the single `;` is refused
    // before the form runs.
    let error = host.eval_posix_line_async("> (let touched 1); echo AFTER").await.unwrap_err();
    assert!(error.to_string().contains("a single `;` is not lisp: `(let touched 1)` is followed by `; echo AFTER`"), "{error}");
    assert!(host.eval_to_json("touched").is_err());
  }
}

/// R7's `use … as:` in tsh's command namespace (operator rulings 2026-10-04):
/// the word is a command bash lookup finds, owned by the file that says it;
/// a word someone owns or a `PATH` program names is refused like an
/// `@import`; a `use` without `as:` names no command word.
#[cfg(test)]
mod use_as_tests {
  use super::*;

  type Notes = Rc<RefCell<Vec<String>>>;

  fn noting_host() -> (LispHost, Notes) {
    let mut host = LispHost::new();
    let notes: Notes = Rc::default();
    let record = notes.clone();
    host.register_native_special("std.test.note", move |args| {
      for arg in args {
        if let LispValue::String(word) = arg {
          record.borrow_mut().push(word.into_string());
        }
      }
      Ok(LispValue::Nil)
    });
    (host, notes)
  }

  /// A `PATH` of `dirs` for one closure, without touching the process map.
  fn with_path<R>(dirs: &str, run: impl FnOnce() -> R) -> R {
    let map = tento_env::EnvMap::new();
    map.set("PATH", dirs);
    tento_env::with_env_map(map, run)
  }

  /// `use` binds Lisp names only, `as:` or not (operator ruling 14,
  /// 2026-10-06): Lisp calls them, bash lookup never finds them.
  #[tokio::test]
  async fn use_binds_lisp_names_only() {
    let (mut h, notes) = noting_host();
    assert!(h.eval_seed("(use std.test.note as: note)", &[]).is_empty());
    h.eval_stmt("(use std.test.(note))").unwrap();
    h.eval_stmt("(use std.test)").unwrap();
    for name in ["note", "test.note"] {
      assert!(h.shadowed_by_lisp_binding(name), "{name} is a Lisp name");
    }
    h.eval_stmt(r#"(note "x")"#).unwrap();
    h.eval_stmt(r#"(test.note "y")"#).unwrap();
    assert_eq!(*notes.borrow(), ["x", "y"], "Lisp calls them");
    h.collect_shell_diagnostics();
    let captured = h.capture_shell_source("note a b").await.unwrap();
    assert_eq!(captured.status, 127, "no command word");
    assert_eq!(*notes.borrow(), ["x", "y"]);
    // A user's `let` of a function is a Lisp name too.
    h.eval_stmt(r#"(let helper (lambda (x) (std.test.note x)))"#).unwrap();
    assert!(h.shadowed_by_lisp_binding("helper"));
    assert!(!h.shadowed_by_lisp_binding("std.test.note"), "the registered command is one");
  }

  /// A `use` name collides with nothing: no owned word, no PATH program.
  #[test]
  fn use_names_never_collide() {
    let (mut h, _) = noting_host();
    with_path("/bin", || {
      h.eval_stmt("(use std.test.note as: sh)").unwrap();
      h.eval_stmt("(use std.test.note as: sh)").unwrap();
    });
    let error = h.eval_stmt("(use std.test.note as: std)").unwrap_err().to_string();
    assert!(error.contains("std is read-only"), "{error}");
  }

  /// A mount may share its word with a program on the declared `PATH`
  /// (operator Refinement 4, 2026-10-05: tsh-tmux mounts as `tmux` again).
  /// The mount binds `ns.export` names only: `(sh.hello)` and `sh.hello`
  /// reach the bundle, while a bash line headed by the bare word never does,
  /// so bash lookup goes on to the program (127 here, where no program runs).
  #[tokio::test]
  async fn a_mount_may_share_a_path_program_word_and_never_takes_the_bash_word() {
    struct Fake(Notes);
    impl ImportResolver for Fake {
      fn resolve(
        &self,
        _name: &str,
        namespace: &str,
        _from: Option<&str>,
        _registration: Rc<RefCell<Option<String>>>,
      ) -> Result<ImportMounts, RuntimeError> {
        let notes = self.0.clone();
        let hello: NativeClosure<Sym> = Rc::new(move |_env, _args| {
          notes.borrow_mut().push("hello".into());
          Ok(LispValue::Nil)
        });
        Ok(ImportMounts {
          mounts: vec![(format!("{namespace}.hello"), LispValue::Function(Function::NativeClosure(hello)))],
          async_mounts: Vec::new(),
          ui_scripts: Vec::new(),
          rc_scripts: Vec::new(),
        })
      }
    }
    let notes: Notes = Rc::default();
    let mut h = LispHost::with_resolver(Rc::new(Fake(notes.clone())));
    with_path("/bin", || h.eval_stmt(r#"(@import "tsh-sh" :as "sh")"#)).expect("/bin/sh is no conflict");
    h.eval_stmt("(sh.hello)").unwrap();
    assert_eq!(*notes.borrow(), ["hello"], "the Lisp name reaches the bundle");
    h.collect_shell_diagnostics();
    let captured = h.capture_shell_source("sh hello").await.unwrap();
    assert_eq!(captured.status, 127, "the bare mount word is no command word");
    assert_eq!(*notes.borrow(), ["hello"], "the bare word never reached the bundle");
    let captured = h.capture_shell_source("sh.hello").await.unwrap();
    assert_eq!(captured.status, 0, "the qualified export is a command");
    assert_eq!(*notes.borrow(), ["hello", "hello"], "`ns.export` reaches the bundle");
  }

  /// A seed `(let NAME std.*)` is a prompt declaration: recorded for the
  /// shell dispatch, bound as an ordinary Lisp name, owning no word. A
  /// `tsh.*` or a function binding is a Lisp name only.
  #[test]
  fn a_seed_let_of_a_std_command_is_a_declaration() {
    let (mut h, _) = noting_host();
    h.register_native_special("tsh.test.word", |_| Ok(LispValue::Nil));
    assert!(h.eval_seed("(let x 1)\n(let plugins tsh.test.word)\n(let f (lambda () 1))", &[]).is_empty());
    assert!(h.shell_aliases.is_empty(), "no declaration");
    assert!(h.eval_seed("(let note std.test.note)", &[]).is_empty());
    let declared: Vec<_> = h.shell_aliases.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    assert_eq!(declared, [("note".to_string(), "std.test.note".to_string())]);
    assert_eq!(h.declared_target("note").as_deref(), Some("std.test.note"));
    assert_eq!(h.binding_places.borrow().get("note").map(String::as_str), Some("the prelude"));
    assert!(h.shadowed_by_lisp_binding("note"), "a Lisp name to bash lookup outside the prompt");
    assert_eq!(
      h.command_owners.borrow().get("note").map(String::as_str),
      Some("std.test.note (prelude)"),
      "a prelude name no mount takes"
    );
    // An rc rebinding to data removes the declaration.
    h.eval_stmt("(let note 5)").unwrap();
    assert_eq!(h.declared_target("note"), None);
  }

  /// The utilities are `std.coreutil.*` (operator, 2026-10-19), so the `std`
  /// rules cover them with no namespace of their own: a word bound to one is
  /// a prompt declaration, and user code cannot rebind one. `coreutil` is an
  /// ordinary name now.
  #[test]
  fn a_std_coreutil_command_is_a_std_command() {
    let (mut h, _) = noting_host();
    h.register_native_special("std.coreutil.note", |_| Ok(LispValue::Nil));
    assert!(h.eval_seed("(let ls std.coreutil.note)", &[]).is_empty());
    assert_eq!(h.declared_target("ls").as_deref(), Some("std.coreutil.note"));
    let error = h.eval_stmt("(let std.coreutil.note 1)").unwrap_err().to_string();
    assert!(error.contains("read-only"), "{error}");
    let error = h.eval_stmt("(let std.coreutil.cat 1)").unwrap_err().to_string();
    assert!(error.contains("read-only"), "{error}");
    h.eval_stmt("(let coreutil.cat 1)").expect("`coreutil` is an ordinary name");
    assert_eq!(h.eval_to_json("coreutil.cat").unwrap(), serde_json::json!(1));
  }
}


#[cfg(test)]
mod typed_bundle_tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn module_dependencies_are_lexical_and_identity_survives_aliases() {
    let mut host = LispHost::new();
    let module = tento_lisp::types::Module::new("private".into(), Default::default())
      .with_bundle_name("tento-fleet-sdk".into())
      .with_exports(
        [("answer".into(), LispValue::Integer(42))]
          .into_iter()
          .collect(),
      );
    for (name, value) in [
      ("item.__deps.sdk", LispValue::Module(Rc::new(module))),
      (
        "item.__requires",
        value_from_json(&json!({"sdk":"item.__deps.sdk"})),
      ),
      (
        "item",
        LispValue::Module(Rc::new(
          tento_lisp::types::Module::new("item".into(), Default::default())
            .with_bundle_name("tsh-item-test".into()),
        )),
      ),
    ] {
      let symbol = host.interp.string_interner().get_or_intern(name);
      host.env.borrow_mut().define(symbol, value);
    }
    let exports = host
      .eval_bundle_rc(
        "item",
        "(define answer sdk.answer) (define (identity) (module.bundle))",
      )
      .unwrap();
    host.mount_rc_exports("alias", &exports).unwrap();
    assert_eq!(host.eval_to_json("alias.answer").unwrap(), json!(42));
    assert_eq!(
      host.eval_to_json("(alias.identity)").unwrap(),
      json!("tsh-item-test")
    );
    assert!(
      host
        .eval_bundle_rc("item", "(define value undeclared.answer)")
        .unwrap_err()
        .to_string()
        .contains("undeclared.answer")
    );
    let requirements = host
      .interp
      .string_interner()
      .get_or_intern("item.__requires");
    host.env.borrow_mut().define(
      requirements,
      value_from_json(&json!({"missing":"item.__deps.missing"})),
    );
    assert!(
      host
        .eval_bundle_rc("item", "(define x 1)")
        .unwrap_err()
        .to_string()
        .contains("plugins install missing")
    );
  }

  #[test]
  fn module_bodies_export_definitions_and_keep_lexical_helpers() {
    let mut host = LispHost::new();
    let exports = host
      .eval_bundle_rc(
        "module",
        r#"
      (type Label string)
      (struct Report label: Label)
      (trait Source (fn report () -> Report))
      (define prefix "module:")
      (define (helper name) (concat prefix name))
      (fn report () -> Report (Report label: (helper "ok")))
    "#,
      )
      .unwrap();
    assert_eq!(
      exports
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>(),
      ["Label", "Report", "Source", "prefix", "helper", "report"]
    );
    host.mount_rc_exports("renamed", &exports).unwrap();
    assert_eq!(
      host.eval_to_json("(renamed.report)").unwrap(),
      json!({"label":"module:ok"})
    );
    assert!(host.eval_to_json("prefix").is_err());
    for source in ["", ";; empty module\n", "(; empty (; nested ;) module ;)"] {
      assert!(host.eval_bundle_rc("empty", source).unwrap().is_empty());
    }
    assert!(
      host
        .eval_bundle_rc("bad", "(bundle ())")
        .unwrap_err()
        .to_string()
        .contains("a bundle rc is ONE")
    );
  }

  #[test]
  fn initialization_read_errors_clear_both_pending_script_queues() {
    for ui in [false, true] {
      let mut host = LispHost::new();
      host.enable_import_ui();
      host.pending_rc.borrow_mut().push(PendingRcScript {
        namespace: "consumer".into(), script: PathBuf::from("/nonexistent-tsh-initialization/consumer.tshrc"),
      });
      host.pending_ui.borrow_mut().push(PendingUiScript {
        namespace: "consumer".into(), script: PathBuf::from("/nonexistent-tsh-initialization/consumer.tsh"),
      });
      let result = if ui { host.process_pending_ui() } else { host.process_pending_rc() };
      assert!(result.is_err());
      assert!(host.pending_rc.borrow().is_empty());
      assert!(host.pending_ui.borrow().is_empty());
      host.eval_to_json("nil").unwrap();
      host.process_pending_ui().unwrap();
    }
  }

  #[test]
  fn typed_bundle_exports_keep_contracts_helpers_and_namespace_aliases() {
    let mut host = LispHost::new();
    let exports = host.eval_bundle_rc("typed", r#"
      (bundle (m)
        (struct Report label: string refreshed: bool)
        (let prefix "fleet:")
        (fn report (hosts: (option string) refresh: bool = false) -> Report
          {"label" (concat prefix (if (null? hosts) "local" hosts)) "refreshed" refresh})
        (m.export 'report))
    "#).unwrap();
    host.mount_rc_exports("work", &exports).unwrap();
    host.mount_rc_exports("personal", &exports).unwrap();
    assert_eq!(host.eval_to_json("(work.report)").unwrap(), json!({"label":"fleet:local","refreshed":false}));
    assert_eq!(host.eval_to_json(r#"(personal.report refresh: true hosts: "--help")"#).unwrap(),
      json!({"label":"fleet:--help","refreshed":true}));
    assert!(host.eval_to_json(r#"(work.report refresh: "false")"#).unwrap_err().to_string().contains("arguments.refresh"));
    assert!(host.eval_to_json("prefix").is_err(), "private helper must not leak");
  }

  #[test]
  fn typed_bundle_defaults_run_after_mount_in_the_captured_namespace() {
    let mut host = LispHost::new();
    let exports = host.eval_bundle_rc("typed", r#"
      (bundle (m)
        (let count 5)
        (fn next (x: s64 = count doubled: s64 = (* x 2)) -> s64
          (set count (+ count 1)) doubled)
        (m.export 'next))
    "#).unwrap();
    host.mount_rc_exports("work", &exports).unwrap();
    host.mount_rc_exports("personal", &exports).unwrap();
    assert_eq!(host.eval_to_json("(work.next)").unwrap(), json!(10));
    assert_eq!(host.eval_to_json("(personal.next)").unwrap(), json!(12));
    assert_eq!(host.eval_to_json("(work.next x: 20)").unwrap(), json!(40));
    assert_eq!(host.eval_to_json("(personal.next)").unwrap(), json!(16));
    assert_eq!(
      host.eval_to_json("(count (list 1 2 3))").unwrap(),
      json!(3),
      "bundle-local count must not replace the standard count function"
    );
  }

  #[test]
  fn typed_bundle_result_rejection_survives_mounting() {
    let mut host = LispHost::new();
    let exports = host.eval_bundle_rc("typed", r#"
      (bundle (m)
        (struct Row id: string)
        (fn rows () -> (list Row) (list {"id" 1}))
        (m.export 'rows))
    "#).unwrap();
    host.mount_rc_exports("renamed", &exports).unwrap();
    let error = host.eval_to_json("(renamed.rows)").unwrap_err().to_string();
    assert!(error.contains("result[0].id"), "{error}");
  }
}

#[cfg(test)]
mod module_review_tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn legacy_bundle_with_a_second_form_keeps_the_original_teaching_error() {
    let mut host = LispHost::new();
    host.eval_to_json("(define touched false)").unwrap();
    for source in [
      "(bundle (m) (set touched true)) (set touched true)",
      "(set touched true) (bundle (m) (set touched true))",
    ] {
      let error = host
        .eval_bundle_rc("legacy", source)
        .unwrap_err()
        .to_string();
      assert_eq!(
        error,
        "lisp error: 2 form(s) at top level; a bundle rc is ONE `(bundle (m) …)` form — definitions and own-receiver registrations only"
      );
      assert_eq!(host.eval_to_json("touched").unwrap(), false);
    }
  }

  #[test]
  fn imports_are_refused_in_both_bundle_forms_and_the_guard_is_restored() {
    let mut host = LispHost::new();
    host.eval_to_json("(define touched false)").unwrap();
    for source in [
      "(@import \"nested\" :as \"n\")",
      "(bundle (m) (@import \"nested\" :as \"n\"))",
      "(@import \"nested\" :as \"n\" :optional) (set touched true)",
      "(bundle (m) (@import \"nested\" :as \"n\" :optional) (set touched true))",
    ] {
      let error = host
        .eval_bundle_rc("consumer", source)
        .unwrap_err()
        .to_string();
      assert!(
        error.contains("not allowed inside bundle `consumer`'s rc")
          && error.contains("declare dependencies in the manifest"),
        "{error}"
      );
      assert_eq!(host.eval_to_json("touched").unwrap(), false);
    }
    assert_eq!(
      host
        .eval_to_json("(@import \"outside\" :as \"n\" :optional)")
        .unwrap(),
      json!(null)
    );
    let error = host
      .eval_to_json("(@import \"outside\" :as \"n\")")
      .unwrap_err()
      .to_string();
    assert!(!error.contains("not allowed inside bundle"), "{error}");
  }

  #[test]
  fn missing_renamed_dependency_names_the_install_package() {
    let mut host = LispHost::new();
    let sym = host
      .interp
      .string_interner()
      .get_or_intern("app.__requires");
    host.env.borrow_mut().define(
      sym,
      value_from_json(
        &json!({"sdk":{"namespace":"app.__deps.sdk","package":"real-sdk","optional":false}}),
      ),
    );
    for source in ["(define x 1)", "(bundle (m) (m.require \"sdk\"))"] {
      let error = host.eval_bundle_rc("app", source).unwrap_err().to_string();
      assert!(error.contains("plugins install real-sdk"), "{error}");
    }
  }

  #[test]
  fn module_lane_advice_does_not_refer_to_an_unbound_receiver() {
    let mut host = LispHost::new();
    let error = host
      .eval_bundle_rc("app", "(lane.declare \"test\")")
      .unwrap_err()
      .to_string();
    assert!(
      error.contains("declare host lanes in the host rc"),
      "{error}"
    );
    assert!(!error.contains("m.lane.declare"), "{error}");
  }

  #[test]
  fn legacy_trait_check_uses_the_modules_explicit_methods_even_with_an_impl() {
    let mut host = LispHost::new();
    host
      .eval_to_json("(trait Item (fn check (self) -> string))")
      .unwrap();
    let exports = host
      .eval_bundle_rc(
        "legacy",
        r#"
      (bundle (m)
        (struct Params value: string)
        (impl Item for Params (fn check (self) -> string self.value))
        (fn check (self) -> string "legacy")
        (m.export 'Params 'check))
    "#,
      )
      .unwrap();
    host.mount_rc_exports("legacy", &exports).unwrap();
    assert_eq!(
      host.eval_to_json("(trait.check Item legacy)").unwrap(),
      "ok"
    );
    let exports = host.eval_bundle_rc("struct-only", r#"(bundle (m) (m.export 'Item))"#);
    assert!(exports.is_ok());
    // A module exporting only the struct must still report its missing method.
    let ty = host.eval_value("legacy.Params").unwrap();
    host
      .mount_rc_exports("struct-only", &[("Params".into(), ty)])
      .unwrap();
    assert_ne!(
      host.eval_to_json("(trait.check Item struct-only)").unwrap(),
      "ok"
    );
  }

  #[test]
  fn concat_rejects_mixed_list_scalars_and_concatenates_all_lists() {
    let mut host = LispHost::new();
    let error = host
      .eval_to_json("(concat '(1) \"x\")")
      .unwrap_err()
      .to_string();
    assert!(error.contains("scalar"), "{error}");
    assert_eq!(
      host.eval_to_json("(concat '(1) '(2))").unwrap(),
      json!([1, 2])
    );
  }

  #[test]
  fn concat_rejects_nil_with_the_previous_scalar_error() {
    let mut host = LispHost::new();
    host.eval_to_json("(define maybe-nil nil)").unwrap();
    for source in ["(concat nil)", "(concat \"dir/\" maybe-nil)"] {
      let error = host.eval_to_json(source).unwrap_err().to_string();
      assert_eq!(error, "lisp error: type error: expected scalar, got Nil");
    }
    assert_eq!(
      host.eval_to_json("(concat \"dir/\" 42 true)").unwrap(),
      "dir/42true"
    );
    assert_eq!(
      host.eval_to_json("(str.concat \"dir/\" nil)").unwrap(),
      "dir/nil"
    );
  }
}

#[cfg(test)]
mod fleet_source_native_tests {
  use super::*;

  #[test]
  fn selected_source_uses_host_root_without_caller_definitions_through_aliases() {
    let mut host = LispHost::new();
    host.register_source_native("selected", |args| {
      let [value] = args.as_slice() else { return Err(LispHostError::Runtime("one argument".into())); };
      Ok((value.clone(), value_to_json(value).as_str().map(str::to_owned)))
    });
    assert_eq!(host.eval_to_json(r#"
      (let alias selected)
      (let x 7)
      [(let ((x 40)) (alias "(+ 1 2)")) (selected 7)
       (error? (try (selected "(+ x 2)")))
       (error? (try (selected "missing-source-binding")))]
    "#).unwrap(), serde_json::json!([3,7,true,true]));
    for source in [
      "1",
      "x",
      "[1 2]",
      "{a 1}",
      "'(+ 1 2)",
      "(+ 1 2) (+ 3 4)",
      "((lambda () 1))",
      "",
      "(begin (let x 10) x)",
      "(do (set x 10) x)",
      "(let x 10)",
      "(define x 10)",
      "(def x 10)",
      "(set x 10)",
      "(set! x 10)",
      "(if true 1 2)",
      "(lambda () 1)",
      "(+ (set x 10) 1)",
      "(+ (def x 10) 1)",
      "(+ (+ 1 2) 3)",
      "(list '(set x 10))",
      "(list '(1 (def x 10)))",
    ] {
      assert!(host.eval_stmt(&format!("(selected {})", serde_json::json!(source))).is_err());
    }
    assert_eq!(host.eval_to_json("x").unwrap(), 7);
    host.eval_stmt("(let user-command (lambda () 99))").unwrap();
    assert!(host.eval_stmt(r#"(selected "(user-command)")"#).is_err());
    host.register_native_special("host-command", |_| Ok(LispValue::Integer(42)));
    assert_eq!(
      host.eval_to_json(r#"(selected "(host-command)")"#).unwrap(),
      42
    );
    // Advice arguments are literal data. No nested form may mutate even the
    // fresh child, or execute a host command while computing an argument.
    assert!(
      host
        .eval_stmt(r#"(selected "(+ (begin (let scratch 4) scratch) 1)")"#)
        .is_err()
    );
    assert!(host.eval_stmt(r#"(selected "(+ (host-command) 1)")"#).is_err());
    assert_eq!(
      host.eval_to_json(r#"(selected "(list 1 2.5 true false nil :key '(3 \"four\" (5)))")"#).unwrap(),
      serde_json::json!([1, 2.5, true, false, null, ":key", [3, "four", [5]]])
    );
    assert!(host.eval_stmt(r#"(selected "(+ scratch 1)")"#).is_err());
    assert!(host.eval_stmt("scratch").is_err());
    host.eval_stmt("(let private 23)").unwrap();
    let command = host.eval_value("(lambda () 17)").unwrap();
    host
      .mount_rc_exports("plugin", &[("command".into(), command)])
      .unwrap();
    assert_eq!(
      host
        .eval_to_json(r#"(selected "(plugin.command)")"#)
        .unwrap(),
      17
    );
  }

  /// design-v9 §11's advice forms use the reader's `[...]` and `{...}`
  /// sugar and signed numbers. Those arguments are built from the parsed
  /// data; no argument form is evaluated, so neither a nested call nor a
  /// shadowed `vector`/`hash-map` can run while acting on advice.
  #[test]
  fn selected_source_accepts_vector_and_map_literals_without_evaluating_them() {
    let mut host = LispHost::new();
    host.register_source_native("selected", |args| {
      let [value] = args.as_slice() else { return Err(LispHostError::Runtime("one argument".into())); };
      Ok((value.clone(), value_to_json(value).as_str().map(str::to_owned)))
    });
    let doctor = host
      .eval_value(
        "(fn doctor (host string items: (list string) = (list) opts: any = nil n: s64 = 0 m: s64 = 0) -> any \
           (list host items opts n m))",
      )
      .unwrap();
    host
      .mount_rc_exports("fleet", &[("doctor".into(), doctor)])
      .unwrap();
    let run = |host: &mut LispHost, form: &str| {
      host.eval_to_json(&format!("(selected {})", serde_json::json!(form)))
    };
    assert_eq!(
      run(&mut host, r#"(fleet.doctor "rwc-03" items: ["iroh-bridge"])"#).unwrap(),
      serde_json::json!(["rwc-03", ["iroh-bridge"], null, 0, 0])
    );
    assert_eq!(
      run(
        &mut host,
        r#"(fleet.doctor "rwc-03" opts: {"kind" "ssh-ed25519" "rescan" true :nested [1 [2.5 nil] {"k" :v}]} n: -1 m: +2)"#
      )
      .unwrap(),
      serde_json::json!(["rwc-03", [], {"kind": "ssh-ed25519", "rescan": true, "nested": [1, [2.5, null], {"k": ":v"}]}, -1, 2])
    );
    assert_eq!(
      run(&mut host, r#"(list -1 +2 -1.5 [] {} '(1 "two"))"#).unwrap(),
      serde_json::json!([-1, 2, -1.5, [], {}, [1, "two"]])
    );
    host.eval_stmt("(let x 7)").unwrap();
    for form in [
      "(list [x])",
      "(list [items:])",
      "(list [(+ 1 2)])",
      "(list [(set x 1)])",
      "(list (vector 1 x))",
      "(list {a 1})",
      "(list {\"a\" x})",
      "(list {\"a\" (def x 1)})",
      "(list {\"a\"})",
      "(list [1 '(set x 1)])",
      "(list ['(1 (def x 2))])",
      "(fleet.doctor \"rwc-03\" items: (list \"a\"))",
      "(fleet.doctor host-name)",
    ] {
      assert!(run(&mut host, form).is_err(), "{form} must be refused");
    }
    assert_eq!(host.eval_to_json("x").unwrap(), 7);
    // A host binding that shadows the reader sugar's heads never runs.
    host.register_native_special("vector", |_| Ok(LispValue::Integer(99)));
    host.register_native_special("hash-map", |_| Ok(LispValue::Integer(98)));
    assert_eq!(
      run(&mut host, r#"(list [1 2] {"a" [3]})"#).unwrap(),
      serde_json::json!([[1, 2], {"a": [3]}])
    );
    // A named-argument keyword takes literal data, never another keyword
    // (which would be evaluated as a root lookup) and never nothing.
    host.eval_stmt("(let n: 5)").ok();
    for form in [
      r#"(fleet.doctor "rwc-03" items: n:)"#,
      r#"(fleet.doctor "rwc-03" n: m: 1)"#,
      r#"(fleet.doctor "rwc-03" n:)"#,
    ] {
      let e = run(&mut host, form);
      assert!(e.is_err(), "{form} must be refused: {e:?}");
    }
    assert_eq!(
      run(&mut host, r#"(fleet.doctor "rwc-03" n: 1 m: 2)"#).unwrap(),
      serde_json::json!(["rwc-03", [], null, 1, 2])
    );
  }

  /// Advice runs only the heads its native admits (design §11: `fleet.*`
  /// and `std.term.list`), and never a source native such as
  /// `std.next.call` itself, whatever the admitted set.
  #[test]
  fn selected_source_admits_only_its_heads_and_never_a_source_native() {
    let mut host = LispHost::new();
    let one = |args: Vec<LispValue<Sym>>| {
      let [value] = args.as_slice() else { return Err(LispHostError::Runtime("one argument".into())); };
      Ok((value.clone(), value_to_json(value).as_str().map(str::to_owned)))
    };
    host.register_source_native("selected", one);
    host.register_source_native_heads(
      "advise",
      |head| head.starts_with("fleet.") || head == "std.term.list",
      one,
    );
    let doctor = host.eval_value("(lambda (h) (list \"doctor\" h))").unwrap();
    host.mount_rc_exports("fleet", &[("doctor".into(), doctor)]).unwrap();
    host.register_native_special("std.fleet.exec", |_| Ok(LispValue::Integer(13)));
    let run = |host: &mut LispHost, native: &str, form: &str| {
      host.eval_to_json(&format!("({native} {})", serde_json::json!(form)))
    };
    assert_eq!(
      run(&mut host, "advise", r#"(fleet.doctor "rwc-03")"#).unwrap(),
      serde_json::json!(["doctor", "rwc-03"])
    );
    for form in [
      r#"(std.fleet.exec "rwc-03")"#,
      r#"(list 1)"#,
      r#"(advise "(fleet.doctor \"rwc-03\")")"#,
      r#"(selected "(+ 1 2)")"#,
    ] {
      let e = run(&mut host, "advise", form);
      assert!(e.is_err(), "advise {form} must be refused: {e:?}");
    }
    // Without a head set, any non-special callable runs, but a source
    // native still never does.
    assert_eq!(run(&mut host, "selected", r#"(std.fleet.exec "x")"#).unwrap(), 13);
    for form in [r#"(selected "(+ 1 2)")"#, r#"(advise "(fleet.doctor \"x\")")"#] {
      let e = run(&mut host, "selected", form);
      assert!(e.is_err(), "selected {form} must be refused: {e:?}");
    }
  }
}
