use std::borrow::Cow;
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::Value as JsonValue;

use crate::Scripts;
use crate::error::Error;
use crate::shell::Callable;

use super::interp::{LispHost, LispHostError};
use super::parser::{LineKind, bash_source, classify, classify_in};

#[derive(Debug, thiserror::Error)]
pub enum TshScriptErrorKind {
  #[error("tokenize error: {0}")]
  Tokenize(crate::tokenizer::TokenizeError),
  #[error("reading script input: {0}")]
  Input(std::io::Error),
  #[error("{0}")]
  Refused(String),
  // The variants of `LispHostError` carry their own `lisp …` prefixes —
  // re-prefixing here stuttered ("lisp error: lisp runtime error: …").
  #[error("{0}")]
  Lisp(LispHostError),
  #[error("command failed: {0}")]
  Command(Error),
  // A `WarnContinue` unit's rollup ("N of M statements failed — …"); each
  // per-statement reason already carries its own kind prefix, so transparent
  // like `Lisp`.
  #[error("{0}")]
  Summary(String),
  /// A Bash unit stopped under errexit or parked on its embedding host.
  /// Any command diagnostic has already been emitted.
  #[error("exit status {0}")]
  BashStatus(i32),
  #[error("{0}")]
  Control(super::bash_compound::ControlSignal),
}

impl TshScriptErrorKind {
  /// Whether this failure must halt the unit even under
  /// [`OnError::WarnContinue`] — a HARD lisp error (`unwrap`/`expect` escalation, a blown
  /// eval budget, `assert`) surfaced as [`LispHostError::Fatal`]. Soft failures
  /// collect-and-continue.
  fn is_hard(&self) -> bool {
    matches!(self, TshScriptErrorKind::Lisp(LispHostError::Fatal(_)))
      || matches!(self, TshScriptErrorKind::Command(Error::Other(error))
        if error.downcast_ref::<tento_lisp::RuntimeError>().is_some_and(|error| error.is_hard()))
  }
}

#[derive(Debug, thiserror::Error)]
#[error("[line {line}] {source_line}\n  -> {kind}")]
pub struct TshScriptError {
  pub line: usize,
  pub source_line: String,
  #[source]
  pub kind: TshScriptErrorKind,
}

impl TshScriptError {
  /// Preserve a direct external command's process status through the script
  /// runner. Other evaluation/configuration errors intentionally return None
  /// so the embedding shell applies its stable generic failure status.
  pub fn process_status(&self) -> Option<i32> {
    match &self.kind {
      TshScriptErrorKind::Command(error) => error.process_status().or_else(|| match error {
        Error::Other(error) => error.downcast_ref::<tento_lisp::RuntimeError>().and_then(|error| match error {
          tento_lisp::RuntimeError::Exit { status, .. } => Some(*status),
          _ => None,
        }),
        _ => None,
      }),
      TshScriptErrorKind::Lisp(error) => error.exit_status(),
      TshScriptErrorKind::BashStatus(status) | TshScriptErrorKind::Control(super::ControlSignal::Exit(status) | super::ControlSignal::ExecExit(status)) => Some(*status),
      _ => None,
    }
  }

  /// What the failing command drew before it failed: the display fields
  /// (`shape`, `rows`, …) of the failure record it reported
  /// ([`tento_lisp::ReportedFailure::display`]), for the embedding shell to
  /// draw ahead of this error's text, the way it draws them on a success
  /// record. `None` for every other failure.
  pub fn reported_display(&self) -> Option<&serde_json::Map<String, JsonValue>> {
    self.kind.reported_display()
  }

  /// No additional runner diagnostic is needed for a Bash stop.
  pub fn is_bash_status(&self) -> bool {
    matches!(self.kind, TshScriptErrorKind::BashStatus(_) | TshScriptErrorKind::Control(super::ControlSignal::Exit(_) | super::ControlSignal::ExecExit(_)))
  }

  /// Whether this is source syntax/tokenization rather than a runtime or
  /// command failure. Embedding CLIs conventionally map these to usage status
  /// 2 while keeping runtime failures on their documented generic status.
  pub fn is_parse_error(&self) -> bool {
    matches!(
      &self.kind,
      TshScriptErrorKind::Tokenize(_) | TshScriptErrorKind::Refused(_) | TshScriptErrorKind::Lisp(LispHostError::Parse(_))
    )
  }

  /// Render-shape form (`sections/v1`): a yellow warning header carrying the
  /// line number, over the offending form + error as indented body lines.
  /// Shape-registry hosts (the CLI startup path, the TUI) render it
  /// natively; `Display` stays the plain form.
  pub fn to_shape(&self, title: &str) -> JsonValue {
    use tento_term::sections::{Section, SectionsBody};
    use tento_term::{Cell, Style};

    let sections = vec![Section {
      title: Some(Cell::new(
        format!("warning: {title} (line {})", self.line),
        Style::Yellow,
      )),
      value: JsonValue::String(format!("{}\n{}", self.source_line, self.kind)),
    }];
    serde_json::to_value(SectionsBody::new(sections)).expect("sections/v1 serializes")
  }
}

/// What a statement failure does to the rest of the unit — honored by
/// [`run_source_on_host`] and the per-script runners opting into Bash mode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OnError {
  /// Stop at the first failing statement (script semantics; the default).
  #[default]
  Halt,
  /// Warn on a failing statement, keep evaluating the rest, and
  /// return ONE summary error at the end so the unit still reports ✗.
  WarnContinue,
  /// Bash lines continue and record status; errexit and Lisp errors halt.
  /// Command stderr is emitted once, without a unit summary.
  Bash,
}

#[derive(Clone, Default)]
pub struct RunOptions {
  pub dry_run: bool,
  /// True only for a Composer unit or the plain terminal REPL. Each source
  /// line chooses its display destination independently of the unit trailer.
  pub prompt: bool,
  pub on_error: OnError,
  /// The file this source came from, when it is file-backed — threaded onto
  /// the host's current-file slot so `(std.script.path)`/`(std.script.dir)`
  /// resolve inside the script. `None` (the default) for pathless sources
  /// (piped stdin, one-shot lines, control units): the natives return nil —
  /// and the runners RESET the slot from this on every run, so a persistent
  /// host never leaks the previous script's path into a pathless unit.
  pub source_path: Option<std::path::PathBuf>,
  /// Under Bash policy, render/write each non-null bash value as its line
  /// finishes. The first argument is the source line (for replay deduplication).
  /// The bool says this is the unit's final evaluable statement
  /// (trailing comments/blanks do not count). Return true when consumed, so
  /// the value is not also returned for end-of-unit rendering. A control host
  /// can return false for the final statement to retain its unit result.
  pub bash_output: Option<Rc<dyn Fn(usize, &JsonValue, bool) -> bool>>,
  /// The source's language when the caller decided it (I8/I9: `-c`, stdin
  /// and unmarked files are bash; `.tsh`, a tsh `#!` and `tsh run` are lisp).
  /// `None` keeps inference from the path suffix and the `#!` line.
  pub bash: Option<bool>,
  /// Whether a lisp source is STRICT lisp (operator Refinements 6/9/10): a
  /// `.tsh` file, a tsh `#!` file, `tsh run`, an rc file. A strict source
  /// refuses bash-looking lines (wrap them in `(sh! …)`), the legacy `>`
  /// prefix and `#` comments, loudly. `None` infers it: a file-backed
  /// (`source_path`) lisp source that is not the prompt.
  pub strict: Option<bool>,
  /// Under `WarnContinue`, called with each soft failure as it is collected
  /// (its line, its source text, the error), so a caller with no trace to
  /// read (a program's `TSH_ENV` startup) can warn on every one, not only
  /// the first the unit's summary names.
  pub on_soft_failure: Option<Rc<dyn Fn(usize, &str, &TshScriptErrorKind)>>,
}

impl std::fmt::Debug for RunOptions {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("RunOptions")
      .field("dry_run", &self.dry_run)
      .field("prompt", &self.prompt)
      .field("on_error", &self.on_error)
      .field("source_path", &self.source_path)
      .field("bash", &self.bash)
      .field("strict", &self.strict)
      .field(
        "bash_output",
        &self.bash_output.as_ref().map(|_| "callback"),
      )
      .field(
        "on_soft_failure",
        &self.on_soft_failure.as_ref().map(|_| "callback"),
      )
      .finish()
  }
}

pub async fn run_script<Info: Clone + 'static>(
  source: &str,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  options: RunOptions,
) -> Result<(), TshScriptError> {
  run_script_with_prefix(
    source,
    scripts,
    subcommands,
    &[],
    std::rc::Rc::new(crate::script::NoApps),
    options,
  )
  .await
}

/// Like [`run_script`] but prepends `prefix` to every command line's
/// argv before dispatch — see [`run_file_with_prefix`]. `app_dirs` is the
/// caller-injected `PATH`-like search for `(@import "name")` `.tsh.app`
/// bundles (empty = `@import` fails at runtime); the library never reads it
/// from env. The list is threaded into [`LispHost::with_apps`] — the
/// `@import` special form lives in the lisp evaluator, not at the line
/// classifier.
pub async fn run_script_with_prefix<Info: Clone + 'static>(
  source: &str,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  prefix: &[String],
  resolver: Rc<dyn crate::script::ImportResolver>,
  options: RunOptions,
) -> Result<(), TshScriptError> {
  run_script_with_prefix_setup(
    source,
    scripts,
    subcommands,
    prefix,
    resolver,
    options,
    |_| {},
  )
  .await
  .map(|_| ())
}

/// Like [`run_script_with_prefix`] but lets the caller register extra natives on
/// the freshly-built [`LispHost`] before the script runs, and **returns the host**
/// so it outlives the call. This is the seam for host-driven Lisp vocabulary
/// (e.g. a startup rc registering `(defmode …)` natives): the `setup` closure
/// wires natives that capture shared state, the script populates that state, and
/// the returned host keeps the closure-captured env alive so those definitions
/// (lambdas in particular) remain callable afterward. With a no-op `setup` and a
/// discarded return this is exactly [`run_script_with_prefix`].
pub async fn run_script_with_prefix_setup<Info, F>(
  source: &str,
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  prefix: &[String],
  resolver: Rc<dyn crate::script::ImportResolver>,
  options: RunOptions,
  setup: F,
) -> Result<LispHost, TshScriptError>
where
  Info: Clone + 'static,
  F: FnOnce(&mut LispHost),
{
  let mut host = LispHost::with_resolver(resolver);
  // Every command is an env native on the script host, so a line routed through
  // eval resolves it the same way the REPL/control hosts already do.
  host.register_commands(scripts.clone(), subcommands.clone());
  setup(&mut host);
  // File-backed sources carry their path onto the host's current-file slot,
  // so `(std.script.dir)` resolves inside the script (nil when pathless).
  host.set_script_path(options.source_path.clone());
  if matches!(options.on_error, OnError::Bash) {
    run_source_on_host(&mut host, source, &scripts, &subcommands, prefix, options).await?;
    return Ok(host);
  }
  // A file-backed lisp script is strict lisp: refuse it whole, before it
  // runs, when a top-level line is not lisp.
  let strict = options.strict.unwrap_or(options.source_path.is_some())
    && !options.bash.unwrap_or_else(|| bash_source(options.source_path.as_deref(), source));
  if strict {
    if let Some((line, refusal, chunk)) = super::sh_macro::strict_refusals(source).into_iter().next() {
      let message = super::sh_macro::strict_refusal_message(refusal, &chunk, options.source_path.as_deref(), line);
      return Err(TshScriptError { line, source_line: chunk, kind: TshScriptErrorKind::Refused(message) });
    }
  }
  let _ = (prefix, options); // dispatch retired: prefix-prepend & dry-run no longer apply here
  for (idx, raw) in source.lines().enumerate() {
    let line_num = idx + 1;
    if let Err(e) = run_line(raw, &mut host).await {
      return Err(TshScriptError {
        line: line_num,
        source_line: raw.to_string(),
        kind: e,
      });
    }
    // An `(@import …)` on this line may have queued the bundle's ui/*.tsh; the
    // import handler runs inside the eval, so the gated registration pass (F11)
    // happens here, between lines. Errors carry the importing line.
    if let Err(e) = host.process_pending_ui() {
      return Err(TshScriptError {
        line: line_num,
        source_line: raw.to_string(),
        kind: TshScriptErrorKind::Lisp(e),
      });
    }
    // …and the bundle's rc/*.tshrc: loaded here, between lines, so the
    // import's macros are bound for every LATER line (per-file hoisting).
    if let Err(e) = host.process_pending_rc() {
      return Err(TshScriptError {
        line: line_num,
        source_line: raw.to_string(),
        kind: TshScriptErrorKind::Lisp(e),
      });
    }
  }
  Ok(host)
}

/// Register the root-surface alias natives on `host`, writing the shared

/// Run script `source` against an **existing** [`LispHost`] — the seam for a
/// long-lived control plane (a control pane evaluating units): the host's env
/// persists across calls, so definitions from one unit remain visible to the
/// next.
///
/// Unlike the per-script runners above, lines are first **coalesced into
/// balanced forms**: a line that opens a Lisp form (`(`/`>` lead) and leaves
/// it unbalanced accumulates subsequent lines until parens balance (strings
/// respected), so multi-line forms evaluate as one statement. Command lines
/// stay line-delimited.
///
/// Returns the last statement's JSON value — lisp form and posix line alike
/// (`None` when the source was blank/comment only, or the last value was
/// `Null`, e.g. a nil-returning form). Bash values consumed by
/// [`RunOptions::bash_output`] are not returned a second time.
///
/// [`RunOptions::on_error`] picks the failure policy: under [`OnError::Halt`]
/// the first failing statement returns immediately (script semantics); under
/// [`OnError::WarnContinue`] each failure is warned + collected, the remaining
/// statements still run, and the unit ends with ONE summary error (so it still
/// reports ✗), for declaration units such as the boot rc. Bash mode records
/// command status without a summary, halting only for errexit or Lisp errors. A
/// single-statement unit skips the summary wrapper and returns its one failure
/// plainly ("1 of 1 statements failed" adds nothing).
pub async fn run_source_on_host<Info: Clone>(
  host: &mut LispHost,
  source: &str,
  scripts: &Scripts<Info>,
  subcommands: &HashMap<String, Box<dyn Callable>>,
  prefix: &[String],
  options: RunOptions,
) -> Result<Option<JsonValue>, TshScriptError> {
  let _ = (scripts, subcommands, prefix); // commands resolve via the host env now
  let bash = options.bash.unwrap_or_else(|| bash_source(options.source_path.as_deref(), source));
  let on_error = options.on_error;
  if matches!(on_error, OnError::Bash) && !bash && has_single_semicolon_line(source) {
    // Bash-mode runs drop comment chunks before the loop sees them.
    if let Some(line) = coalesce_balanced_lines_in(source, bash)
      .find_map(|(line, chunk)| semicolon_comment_line(&chunk, bash).map(|at| line + at))
    {
      host.warn_semicolon_comment(options.source_path.as_deref(), line);
    }
  }
  let mut chunks = coalesce_balanced_lines_in(source, bash)
    .filter(move |(_, chunk)| {
      !matches!(on_error, OnError::Bash)
        || !matches!(classify_in(chunk, bash), LineKind::Blank | LineKind::Comment)
    }).peekable();
  let chunks = std::iter::from_fn(move || {
    let (line, chunk) = chunks.next()?;
    let final_statement = chunks.peek().is_none();
    Some(Ok((line, chunk, bash, final_statement)))
  });
  // A Lisp file (not the prompt's mixed dialect) is strict lisp: it refuses
  // bash words as heads, bash lines, `>` prefixes and `#` comments.
  let strict_source = !bash && options.strict.unwrap_or(!options.prompt && options.source_path.is_some());
  // A script (not a declaration unit) is refused whole before it runs, as a
  // lisp reader refuses a file it cannot read.
  if strict_source && !matches!(on_error, OnError::WarnContinue) {
    if let Some((line, refusal, chunk)) = super::sh_macro::strict_refusals(source).into_iter().next() {
      let message = super::sh_macro::strict_refusal_message(refusal, &chunk, options.source_path.as_deref(), line);
      return Err(TshScriptError { line, source_line: chunk, kind: TshScriptErrorKind::Refused(message) });
    }
  }
  let strict = super::bash_lisp_bridge::set_strict_lisp(strict_source);
  let result = run_chunks_on_host(host, chunks, options).await;
  super::bash_lisp_bridge::set_strict_lisp(strict);
  result
}

/// Read and execute one complete command at a time. `input` must itself be
/// unbuffered when sharing a descriptor with commands: neither this reader
/// nor the execution loop peeks at the following command. Stream output
/// callbacks always receive `false` for final-statement (EOF is not known yet).
pub async fn run_reader_on_host<Info: Clone>(
  host: &mut LispHost,
  input: impl std::io::Read,
  scripts: &Scripts<Info>,
  subcommands: &HashMap<String, Box<dyn Callable>>,
  prefix: &[String],
  options: RunOptions,
) -> Result<Option<JsonValue>, TshScriptError> {
  let _ = (scripts, subcommands, prefix);
  let mut chunks = CommandReader::new(input);
  chunks.bash = options.bash.unwrap_or_else(|| bash_source(options.source_path.as_deref(), ""));
  chunks.forced = options.bash.is_some();
  // A streamed lisp source (`tsh run` reading stdin) is strict only when the
  // caller says so; each refused chunk fails as it is read.
  let strict_source = !chunks.bash && options.strict.unwrap_or(false);
  let strict = super::bash_lisp_bridge::set_strict_lisp(strict_source);
  let result = run_chunks_on_host(host, chunks, options).await;
  super::bash_lisp_bridge::set_strict_lisp(strict);
  result
}

async fn run_chunks_on_host<'a>(
  host: &mut LispHost,
  chunks: impl Iterator<Item = Result<(usize, Cow<'a, str>, bool, bool), TshScriptError>>,
  options: RunOptions,
) -> Result<Option<JsonValue>, TshScriptError> {
  // Reset the persistent host's file slot once per source, including stdin;
  // queued rc units can still override it via `std.script.source`.
  host.set_script_path(options.source_path.clone());
  host.shell_prompt = options.prompt;
  if matches!(options.on_error, OnError::Bash) && options.bash != Some(false) {
    host.begin_shell_main(options.source_path.as_ref().map(|path| path.display().to_string()));
  }
  let mut last = None;
  // `WarnContinue` bookkeeping: the failures (line, chunk, kind) for the
  // summary, and the count of *evaluable* statements attempted — blank and
  // comment chunks are `run_line` no-ops, so they don't count toward M.
  let mut failures: Vec<(usize, String, TshScriptErrorKind)> = Vec::new();
  let mut attempted = 0usize;
  // Per-statement timing behind the startup gate: only forms costing more
  // than 0.1 ms are printed, so an rc's expensive lines stand out.
  // `TENTO_STARTUP_TIMING=<ms>` lowers the print threshold (default 0.1 ms).
  let statement_timing = std::env::var_os("TENTO_STARTUP_TIMING").is_some();
  let statement_threshold = std::env::var("TENTO_STARTUP_TIMING")
    .ok()
    .and_then(|v| v.parse::<f64>().ok())
    .unwrap_or(0.1);
  let strict = super::bash_lisp_bridge::strict_lisp();
  for next in chunks {
    let (line_num, chunk, bash, final_statement) = next?;
    // A strict source refuses its non-lisp chunks loudly (one failing
    // statement: an rc keeps going past it, a script stops).
    let refused = (strict && !bash)
      .then(|| super::sh_macro::strict_refusal(&chunk, line_num))
      .flatten()
      .map(|refusal| super::sh_macro::strict_refusal_message(refusal, &chunk, options.source_path.as_deref(), line_num));
    // A whole-statement `(sh! …)` runs as the bash line it holds, exactly as
    // that line runs in the mixed dialect. Macros are lisp-only.
    let expanded = match super::sh_macro::single_form_body(&chunk).filter(|_| !bash && refused.is_none()) {
      Some(body) => Some(host.expand_sh_macro(body)),
      None => None,
    };
    let datum = strict && !bash && refused.is_none() && expanded.is_none() && super::sh_macro::strict_datum(&chunk);
    let (chunk, bash) = match &expanded {
      Some(Ok(text)) => (Cow::Owned(text.clone()), true),
      _ => (chunk, bash),
    };
    if let Some(at) = semicolon_comment_line(&chunk, bash) {
      host.warn_semicolon_comment(options.source_path.as_deref(), line_num + at);
    }
    let _output_boundary = super::process_pipeline::OutputBoundary::enter();
    let statement = super::interp::StatementInFlight::enter();
    let evaluable = !matches!(classify_in(&chunk, bash), LineKind::Blank | LineKind::Comment);
    let statement_started = std::time::Instant::now();
    if evaluable {
      attempted += 1;
    }
    let ran = if let Some(message) = refused {
      Err(TshScriptErrorKind::Refused(message))
    } else if let Some(Err(error)) = expanded {
      Err(error)
    } else if datum {
      // A strict lisp datum line (`"loaded"`, `42`): lisp, not a command.
      host.note_lisp_statement();
      host.eval_lisp_host_line(&chunk).await.map(|value| (non_null(value), false))
    } else if matches!(options.on_error, OnError::Bash) {
      run_bash_line(
        &chunk,
        line_num,
        host,
        options.bash_output.clone(),
        final_statement,
        options.prompt,
        bash,
      )
      .await
    } else {
      run_line_in(&chunk, host, bash).await.map(|value| (value, false))
    };
    host.warn_deprecations(options.source_path.as_deref(), line_num, &chunk, &statement);
    if statement_timing && evaluable {
      let ms = statement_started.elapsed().as_secs_f64() * 1e3;
      if ms > statement_threshold {
        let head: String = chunk.trim().chars().take(70).collect();
        eprintln!("startup:   [line {line_num}] {ms:.2} ms  {head}");
      }
    }
    match ran {
      // Every evaluable statement RE-STAMPS the unit value — bash-like, the
      // unit value is the LAST statement's value, so a nil-valued trailer
      // clears an earlier value. Blank/comment chunks are `run_line` no-ops
      // and leave it untouched.
      Ok((value, flow_output)) => {
        if evaluable {
          let consumed = matches!(options.on_error, OnError::Bash)
            && matches!(classify_in(&chunk, bash), LineKind::Plain(_))
            && !datum
            && !flow_output
            && value.as_ref().is_some_and(|value| {
              options
                .bash_output
                .as_ref()
                .is_some_and(|output| output(line_num, value, final_statement))
            });
          last = if consumed { None } else { value };
        }
      }
      // bash's DISCARD: the failed command was reported and set `$?`; the
      // script resumes at its next top-level command.
      Err(TshScriptErrorKind::Control(super::ControlSignal::Discard(_)))
        if matches!(options.on_error, OnError::Bash) => last = None,
      Err(e) => {
        // A HARD error halts even under `WarnContinue`: an `(unwrap …)`/`(expect …)`
        // failure or a blown budget stops the unit HERE (remaining statements do not
        // run), returning as today's `Halt` path does. Soft failures still
        // collect-and-continue.
        if e.is_hard() || matches!(options.on_error, OnError::Halt | OnError::Bash) {
          let mut e = e;
          if matches!(options.on_error, OnError::Bash) && !options.prompt
            && !matches!(e, TshScriptErrorKind::Control(super::ControlSignal::ExecExit(_))) {
            if let Err(trap_error) = host.run_shell_trap("EXIT", line_num, super::bash_flow::FlowOutput {
              writer: options.bash_output.clone(), ..Default::default()
            }).await { e = trap_error; }
          }
          return Err(TshScriptError { line: line_num, source_line: chunk.into_owned(), kind: e });
        }
        tracing::warn!(line = line_num, error = %e, "statement failed; continuing");
        if let Some(warn) = &options.on_soft_failure {
          warn(line_num, &chunk, &e);
        }
        failures.push((line_num, chunk.into_owned(), e));
        continue; // pending-ui drains at the next successful statement
      }
    }
    if let Err(e) = host
      .process_pending_ui()
      .and_then(|()| host.process_pending_rc())
    {
      let kind = TshScriptErrorKind::Lisp(e);
      match options.on_error {
        OnError::Halt | OnError::Bash => {
          return Err(TshScriptError {
            line: line_num,
            source_line: chunk.into_owned(),
            kind,
          });
        }
        OnError::WarnContinue => {
          tracing::warn!(line = line_num, error = %kind, "ui registration failed; continuing");
          if let Some(warn) = &options.on_soft_failure {
            warn(line_num, &chunk, &kind);
          }
          failures.push((line_num, chunk.into_owned(), kind));
        }
      }
    }
  }
  if failures.is_empty() {
    if matches!(options.on_error, OnError::Bash) && !options.prompt {
      let output = super::bash_flow::FlowOutput { writer: options.bash_output.clone(), ..Default::default() };
      if host.shell_compound.commands.traps.get("EXIT").is_some_and(|action| !action.is_empty()) || host.has_trapped_signals() {
        output.flush_value(host, last.take());
      }
      // A signal that arrived during the last command runs its trap first.
      host.poll_shell_signals(1, output.clone()).await.map_err(|kind| TshScriptError { line: 1, source_line: "trap".into(), kind })?;
      host.run_shell_trap("EXIT", 1, output).await.map_err(|kind| TshScriptError { line: 1, source_line: "trap EXIT".into(), kind })?;
    }
    return Ok(last);
  }
  // A single-statement unit gains nothing from a "1 of 1 statements failed"
  // wrapper (live run 2026-07-13: pure noise around the one real reason) —
  // return the failure plainly, exactly as `Halt` would have.
  if attempted == 1 {
    let (line, source_line, kind) = failures.swap_remove(0);
    return Err(TshScriptError {
      line,
      source_line,
      kind,
    });
  }
  // One honest ✗ for the unit, anchored at the FIRST failure's site. Only the
  // first reason rides the summary — every failure was already warned
  // individually above it, so enumerating the rest here just re-chops the same
  // text (live run 2026-07-13: the rollup truncated mid-word). M counts
  // evaluable statements only (blank/comment chunks excluded). The reason is
  // capped at a clean char boundary — a categorical guard; the trace's
  // flattener carries this into the unit.result message.
  let first_reason = {
    let full = failures[0].2.to_string();
    if full.chars().count() > 240 {
      let mut s: String = full.chars().take(240).collect();
      s.push('…');
      s
    } else {
      full
    }
  };
  let mut text = format!(
    "{} of {} statements failed — {}",
    failures.len(),
    attempted,
    first_reason
  );
  if failures.len() > 1 {
    text.push_str(&format!(" (+{} more, each warned)", failures.len() - 1));
  }
  let (line, source_line, _) = failures.swap_remove(0);
  Err(TshScriptError {
    line,
    source_line,
    kind: TshScriptErrorKind::Summary(text),
  })
}

/// Whether any line of `source` opens with a single `;` (not `;;`): the
/// cheap test before looking for deprecated comments.
fn has_single_semicolon_line(source: &str) -> bool {
  source.contains(';') && source.lines().any(|line| {
    let line = line.trim_start();
    line.starts_with(';') && !line.starts_with(";;")
  })
}

/// The line offset, within a lisp or comment `chunk`, of its first deprecated
/// single-`;` line comment (I10 transition: still a comment, but warned).
fn semicolon_comment_line(chunk: &str, bash: bool) -> Option<usize> {
  if bash || !has_single_semicolon_line(chunk) { return None; }
  if !matches!(classify_in(chunk, bash), LineKind::Comment | LineKind::LispStmt(_)) { return None; }
  let trimmed = chunk.trim_start();
  let at = if trimmed.starts_with(';') {
    chunk.len() - trimmed.len()
  } else if trimmed.starts_with('#') {
    return None;
  } else {
    tento_lisp::lisp_deprecated_line_comment(chunk)?
  };
  Some(chunk[..at].matches('\n').count())
}

/// Byte-wise physical lines coalesced only until one command is complete.
struct CommandReader<R> {
  input: R,
  line: usize,
  bash: bool,
  /// The caller fixed the language, so a `#!` line does not change it.
  forced: bool,
  eof: bool,
}

impl<R: std::io::Read> CommandReader<R> {
  fn new(input: R) -> Self {
    Self { input, line: 1, bash: false, forced: false, eof: false }
  }

  fn read_line(&mut self) -> std::io::Result<Option<(String, bool)>> {
    let mut bytes = Vec::new();
    let mut byte = [0];
    let newline = loop {
      match self.input.read(&mut byte) {
        Ok(0) => { self.eof = true; break false; }
        Ok(_) if byte[0] == b'\n' => { self.line += 1; break true; }
        Ok(_) => bytes.push(byte[0]),
        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
        Err(error) => return Err(error),
      }
    };
    if bytes.is_empty() && !newline { return Ok(None); }
    if newline && bytes.last() == Some(&b'\r') { bytes.pop(); }
    String::from_utf8(bytes)
      .map(|line| Some((line, newline)))
      .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
  }
}

impl<R: std::io::Read> Iterator for CommandReader<R> {
  type Item = Result<(usize, Cow<'static, str>, bool, bool), TshScriptError>;

  fn next(&mut self) -> Option<Self::Item> {
    if self.eof { return None; }
    let start = self.line;
    let mut source = String::new();
    let mut newline = false;
    loop {
      match self.read_line() {
        Ok(Some((raw, ended))) => {
          if start == 1 && source.is_empty() && !self.forced { self.bash |= bash_source(None, &raw); }
          if !source.is_empty() { source.push('\n'); }
          source.push_str(&raw);
          newline = ended;
          let pending = match classify_in(&source, self.bash) {
            LineKind::Blank | LineKind::Comment | LineKind::Refused { .. } => false,
            LineKind::Plain(_) => flow_needs_continuation(&source),
            LineKind::LispStmt(_) => lisp_form_open(&source),
          };
          if !pending { break; }
        }
        Ok(None) if source.is_empty() => return None,
        Ok(None) => {
          if newline && (bash_trailing_continuation(&source) || tento_lisp::bash_heredoc_pending(&source)) {
            source.push('\n');
          }
          break;
        }
        Err(error) => {
          self.eof = true;
          return Some(Err(TshScriptError { line: start, source_line: source, kind: TshScriptErrorKind::Input(error) }));
        }
      }
    }
    Some(Ok((start, Cow::Owned(source), self.bash, false)))
  }
}

/// Whether lisp `source` is still inside a form, with every raw macro body
/// (`(sh! …)`) read by bash rules rather than lisp's.
fn lisp_form_open(source: &str) -> bool {
  let masked = tento_lisp::mask_raw_macros(source);
  let mut scan = FormScan::default();
  for line in masked.split('\n') {
    scan.feed(line);
  }
  scan.open()
}

/// Paren/string scanner state carried across the lines of one Lisp form.
#[derive(Default)]
struct FormScan {
  depth: i32,
  in_dquote: bool,
  /// Nesting of an open `(; … ;)` block comment, which may span lines.
  block: usize,
}

impl FormScan {
  fn feed(&mut self, line: &str) {
    let mut escape = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
      if self.block > 0 {
        match (c, chars.peek()) {
          ('(', Some(';')) => { chars.next(); self.block += 1; }
          (';', Some(')')) => { chars.next(); self.block -= 1; }
          _ => {}
        }
        continue;
      }
      if escape {
        escape = false;
        continue;
      }
      if self.in_dquote {
        match c {
          '\\' => escape = true,
          '"' => self.in_dquote = false,
          _ => {}
        }
        continue;
      }
      match c {
        '(' if chars.peek() == Some(&';') => { chars.next(); self.block = 1; }
        ';' => break,
        '"' => self.in_dquote = true,
        // `'` is deliberately NOT a delimiter: FormScan only ever scans
        // lispish chunks (non-`(` lines never get a scan — see
        // `coalesce_balanced_lines`), and in lisp the apostrophe is the
        // `(quote …)` sugar. Shell-style squote tracking here made `'((…))`
        // open a "string" that never closes, so the chunk swallowed every
        // following line to EOF with parens ignored, and the parser then
        // failed on unrelated text far below. Posix lines get their squote
        // semantics from the tokenizer, not from this scanner.
        '(' => self.depth += 1,
        ')' => self.depth -= 1,
        _ => {}
      }
    }
  }

  /// Still inside the form (an unclosed paren or string literal)?
  fn open(&self) -> bool {
    self.depth > 0 || self.in_dquote || self.block > 0
  }
}

/// Group `source` lines into runnable chunks: a Lisp-leading line (`(` or the
/// `>` statement prefix) that ends unbalanced accumulates following lines
/// until its parens/strings balance — one multi-line form, one chunk, tagged
/// with its starting line number. Only plain Bash statements continue for
/// incomplete flow operators, quotes, substitutions or heredocs; standalone
/// comments and blank lines pass through unchanged.
/// A form left unbalanced at EOF is emitted as-is (the evaluator reports it).
/// Single-line chunks borrow the source; only multiline forms allocate. Chunks
/// are read on demand so execution or an early failure can precede later scans.
pub(super) fn coalesce_balanced_lines(source: &str) -> impl Iterator<Item = (usize, Cow<'_, str>)> {
  coalesce_balanced_lines_in(source, false)
}

fn coalesce_balanced_lines_in(source: &str, bash: bool) -> impl Iterator<Item = (usize, Cow<'_, str>)> {
  coalesce_lines_in(source.lines().enumerate(), bash).map(move |(line, raw)| {
    // str::lines drops the final newline. Restore it only for a Bash escape
    // at EOF, so the reader removes the continuation without an empty word.
    if source.ends_with('\n') && tento_lisp::bash_heredoc_pending(&raw) {
      let mut source = raw.into_owned();
      source.push('\n');
      return (line, Cow::Owned(source));
    }
    if source.ends_with('\n') && raw.ends_with('\\')
      && matches!(classify_in(&raw, bash), LineKind::Plain(_)) && bash_trailing_continuation(&raw)
    {
      let mut source = raw.into_owned();
      source.push('\n');
      (line, Cow::Owned(source))
    } else {
      (line, raw)
    }
  })
}

fn flow_needs_continuation(source: &str) -> bool {
  if bash_trailing_continuation(source) || tento_lisp::bash_heredoc_pending(source) { return true; }
  let mut interner =
    string_interner::StringInterner::<string_interner::backend::StringBackend>::new();
  matches!(
    tento_lisp::read_statement::<super::Sym, _>(source, &mut interner),
    Err(tento_lisp::PosixReadError::MissingFlowOperand(
      "&&" | "||" | "|" | "!"
    )) | Err(tento_lisp::PosixReadError::IncompleteHeredoc(_))
      | Err(tento_lisp::PosixReadError::IncompleteCompound(_))
      | Err(tento_lisp::PosixReadError::UnterminatedQuote)
      | Err(tento_lisp::PosixReadError::UnbalancedSubstitution)
  )
}

fn bash_trailing_continuation(source: &str) -> bool {
  tento_lisp::bash_line_continues(source)
}

fn coalesce_lines<'a>(
  lines: impl Iterator<Item = (usize, &'a str)> + 'a,
) -> impl Iterator<Item = (usize, Cow<'a, str>)> {
  coalesce_lines_in(lines, false)
}

fn coalesce_lines_in<'a>(
  mut lines: impl Iterator<Item = (usize, &'a str)> + 'a, bash: bool,
) -> impl Iterator<Item = (usize, Cow<'a, str>)> {
  std::iter::from_fn(move || {
    let (idx, raw) = lines.next()?;
    let line_num = idx + 1;
    // Comments are not Bash statements: their quotes, substitutions and
    // heredoc markers must never consume the forms that follow them.
    let lispish = match classify_in(raw, bash) {
      LineKind::Blank | LineKind::Comment => return Some((line_num, Cow::Borrowed(raw))),
      LineKind::LispStmt(_) => true,
      LineKind::Plain(_) => false,
      LineKind::Refused { .. } => return Some((line_num, Cow::Borrowed(raw))),
    };
    if !lispish && flow_needs_continuation(raw) {
      let mut buf = raw.to_string();
      for (_, next) in lines.by_ref() {
        buf.push('\n');
        buf.push_str(next);
        if !flow_needs_continuation(&buf) {
          break;
        }
      }
      return Some((line_num, Cow::Owned(buf)));
    }
    if lispish {
      let mut scan = FormScan::default();
      scan.feed(raw);
      let open = if raw.contains("(sh!") { lisp_form_open(raw) } else { scan.open() };
      if open {
        let mut buf = raw.to_string();
        for (_, next) in lines.by_ref() {
          // Match str::lines + the original coalescer: CRLF separators become
          // LF inside multiline forms, including string literals.
          buf.push('\n');
          buf.push_str(next);
          scan.feed(next);
          let open = if matches!(classify_in(&buf, bash), LineKind::Plain(_)) {
            flow_needs_continuation(&buf)
          } else if buf.contains("(sh!") {
            // A raw macro's bash body has bash quoting: rescan with it masked.
            lisp_form_open(&buf)
          } else { scan.open() };
          if !open {
            break;
          }
        }
        return Some((line_num, Cow::Owned(buf)));
      }
    }
    Some((line_num, Cow::Borrowed(raw)))
  })
}

/// Run one (possibly coalesced multi-line) chunk through the unified evaluator:
/// a lisp form or a posix line, both read into the same s-expression and
/// evaluated against the host env. Returns the rendered value, or `None` when
/// there is nothing to show (a `Null`-returning statement).
async fn run_line(raw: &str, host: &mut LispHost) -> Result<Option<JsonValue>, TshScriptErrorKind> {
  run_line_in(raw, host, false).await
}

async fn run_line_in(raw: &str, host: &mut LispHost, bash: bool) -> Result<Option<JsonValue>, TshScriptErrorKind> {
  match classify_in(raw, bash) {
    LineKind::Blank | LineKind::Comment => Ok(None),
    LineKind::Refused { form, rest } => Err(TshScriptErrorKind::Refused(
      super::parser::lisp_trailer_message(form, rest),
    )),
    LineKind::LispStmt(expr) => {
      // A lisp form's value IS the line's value — bash-like: the LAST
      // statement's value becomes the unit value whether the statement was
      // written as a lisp form or a posix line. `eval_lisp_line` keeps the
      // statement semantics (binds `prev`) and returns the value as JSON;
      // a nil-valued form (`Null`) stays silent via `non_null`.
      let value = host.eval_lisp_host_line(expr).await?;
      Ok(non_null(value))
    }
    LineKind::Plain(body) => {
      if !host.shell_aliases.is_empty() {
        let value = host
          .read_posix_line_value(body)
          .map_err(TshScriptErrorKind::Lisp)?;
        return super::bash_flow::eval_flow(host, &value, 1, false, Default::default(), true).await;
      }
      // Routing historically reads without HOME expansion, then execution
      // reads with it. Preserve that distinction for tilde-bearing lines;
      // other lines can share one parsed value without changing their head.
      let parsed = if body.contains('~') {
        None
      } else {
        Some(
          host
            .read_posix_line_value(body)
            .map_err(TshScriptErrorKind::Lisp)?,
        )
      };
      let is_async = match &parsed {
        Some(value) => host.posix_value_is_async_mount(value),
        None => host.posix_line_is_async_mount(body),
      };
      // Preserve both the async admission policy and each route's error kind.
      // Routing only inspects the head; arguments are evaluated by execution.
      let value = if is_async {
        match parsed {
          Some(value) => host.eval_read_posix_line_async(&value).await,
          None => host.eval_posix_line_async(body).await,
        }
        .map_err(TshScriptErrorKind::Command)?
      } else {
        match parsed {
          Some(value) => host.eval_read_posix_line(&value),
          None => host.eval_posix_line(body),
        }
        .map_err(TshScriptErrorKind::Lisp)?
      };
      if host.command_json_output() {
        super::bash_flow::FlowOutput::default().flush_value(host, Some(value));
        Ok(None)
      } else {
        Ok(non_null(value))
      }
    }
  }
}

/// Bash policy is applied only at the plain-line boundary. Reader errors and
/// Lisp lines retain their normal diagnostics and halt the unit.
async fn run_bash_line(
  raw: &str,
  line: usize,
  host: &mut LispHost,
  output: Option<super::bash_flow::BashOutput>,
  final_statement: bool,
  prompt: bool,
  bash: bool,
) -> Result<(Option<JsonValue>, bool), TshScriptErrorKind> {
  let LineKind::Plain(body) = classify_in(raw, bash) else {
    if matches!(classify_in(raw, bash), LineKind::LispStmt(_)) {
      host.note_lisp_statement();
    }
    return run_line_in(raw, host, bash).await.map(|value| (value, false));
  };
  let parsed = host
    .read_posix_line_value_in(body, prompt)
    .map_err(TshScriptErrorKind::Lisp)?;
  super::bash_flow::eval_flow(
    host,
    &parsed,
    line,
    false,
    super::bash_flow::FlowOutput {
      writer: output,
      shaped: prompt,
      capture: None,
    },
    final_statement,
  )
  .await
  .map(|value| (value, true))
}

impl TshScriptErrorKind {
  /// The display fields of a failure the command reported as data — see
  /// [`TshScriptError::reported_display`].
  pub fn reported_display(&self) -> Option<&serde_json::Map<String, JsonValue>> {
    let failure = match self {
      TshScriptErrorKind::Lisp(LispHostError::Reported(failure)) => failure,
      TshScriptErrorKind::Command(Error::Other(error)) => match error.downcast_ref::<tento_lisp::RuntimeError>()? {
        tento_lisp::RuntimeError::Reported(failure) => failure,
        _ => return None,
      },
      _ => return None,
    };
    failure.display.as_ref()
  }
}

pub(super) async fn run_bash_stage(
  parsed: &super::LispValue<super::Sym>,
  line: usize,
  host: &mut LispHost,
  ignored: bool,
  flow_stage: bool,
) -> Result<Option<JsonValue>, TshScriptErrorKind> {
  if host.application_head(parsed).as_deref() == Some(super::shell_cmd::SET_BUILTIN) {
    let argv = host
      .application_to_argv(parsed)
      .map_err(TshScriptErrorKind::Command)?;
    return host.set_shell_options(&argv[1..]);
  }
  let assignment = host.is_let_binding(parsed);
  let is_async = host.posix_value_is_async_mount(parsed);
  let unbound = host.posix_value_is_unbound(parsed);
  let result = if is_async || unbound {
    host
      .eval_read_posix_line_async(parsed)
      .await
      .map_err(TshScriptErrorKind::Command)
  } else {
    host
      .eval_read_posix_line(parsed)
      .map_err(TshScriptErrorKind::Lisp)
  };
  if host.shell_suspended() {
    return Err(TshScriptErrorKind::BashStatus(host.shell_status()));
  }
  match result {
    Ok(value) => {
      host.set_shell_status(0);
      // External commands already wrote their stdout; the process receipt is
      // host data, not an extra shell output line.
      if unbound && value.get("datatype").and_then(JsonValue::as_str) == Some("process.result/v1") {
        Ok(None)
      } else if assignment {
        // `name=value` lowers to a `def`, whose value is the binding; bash
        // prints nothing for an assignment.
        Ok(None)
      } else {
        Ok(if host.command_json_output() { Some(value) } else { non_null(value) })
      }
    }
    Err(kind) => {
      // A command's own failure (plain or reported as data) is not an
      // interpreter fault, so it keeps the command's words.
      let lisp_fault = matches!(&kind, TshScriptErrorKind::Lisp(error)
        if !matches!(error, LispHostError::Command(_) | LispHostError::Reported(_)))
        || matches!(&kind, TshScriptErrorKind::Command(Error::Other(error))
          if error.downcast_ref::<tento_lisp::RuntimeError>().is_some_and(|error|
            !matches!(error, tento_lisp::RuntimeError::Command { .. })));
      // A HARD error (`assert`, `unwrap`, a blown budget) still halts. Any
      // other native failure in a bash line warns and fails only this
      // command, as a failing bash builtin does (Q6 item 18).
      if kind.is_hard() {
        return Err(kind);
      }
      let status = match &kind {
        TshScriptErrorKind::Command(Error::CommandNotFound { .. }) => 127,
        TshScriptErrorKind::Command(error) => error.process_status().unwrap_or(1),
        _ => 1,
      };
      host.set_shell_status(status);
      // What the failing command drew before it failed (a `partial` grid) is
      // this statement's output, as bash keeps a failed command's partial
      // output. At the interactive prompt the diagnostic reaches the
      // transcript first (it is written as it is reported). Under `set -e`
      // the statement ends the script and the drawing is not written.
      let drawn = kind.reported_display().cloned().map(JsonValue::Object);
      // A native command's failure — a plugin command typed as a bare word,
      // `acme.sheets.list` — is a failed bash command like any other, also at
      // the interactive prompt: its reason is a diagnostic, `$?` is set, and
      // the rest of the line runs (`a && b` stops it).
      let diagnostic = match &kind {
        _ if flow_stage && lisp_fault => Some(format!("tsh: line {line}: {kind}")),
        TshScriptErrorKind::Command(error) => bash_command_diagnostic(line, error),
        // A command's reported failure is the command's own words, without
        // the interpreter's `lisp error:` label (PE-6).
        TshScriptErrorKind::Lisp(LispHostError::Reported(failure)) => Some(failure.to_string()),
        TshScriptErrorKind::Lisp(error) => Some(error.to_string()),
        _ => Some(kind.to_string()),
      };
      if let Some(diagnostic) = diagnostic {
        host.report_shell_diagnostic(diagnostic);
      }
      if host.shell_errexit && !ignored {
        Err(TshScriptErrorKind::BashStatus(status))
      } else {
        Ok(drawn)
      }
    }
  }
}

pub(super) fn bash_command_diagnostic(line: usize, error: &Error) -> Option<String> {
  match error {
    // bash searches PATH only for a bare name; a missing path is ENOENT.
    Error::CommandNotFound { name, .. } if name.contains('/') => {
      Some(format!("tsh: line {line}: {name}: No such file or directory"))
    }
    Error::CommandNotFound { name, .. } => {
      Some(format!("tsh: line {line}: {name}: command not found"))
    }
    Error::ProcessStart { detail, .. } => Some(format!("tsh: line {line}: {detail}")),
    Error::ProcessExit { .. } => None,
    other => Some(other.to_string()),
  }
}

/// A `Null` line value is "nothing to show" (a `def`, or a command that already
/// printed); anything else is the value to render.
fn non_null(v: JsonValue) -> Option<JsonValue> {
  if v.is_null() { None } else { Some(v) }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scripts() -> Scripts<()> {
    Scripts::new(())
  }

  fn subs() -> HashMap<String, Box<dyn Callable>> {
    HashMap::new()
  }

  fn warn_continue() -> RunOptions {
    RunOptions {
      on_error: OnError::WarnContinue,
      ..RunOptions::default()
    }
  }

  #[test]
  fn chunks_borrow_single_lines() {
    let source = "probe alpha\r\n(concat \"x\" \"y\")\n; comment\n\n";
    let chunks: Vec<_> = coalesce_balanced_lines(source).collect();
    assert_eq!(chunks.len(), 4);
    assert!(
      chunks
        .iter()
        .all(|(_, chunk)| matches!(chunk, Cow::Borrowed(_)))
    );
  }

  #[test]
  fn chunks_do_not_continue_comments_with_bash_syntax() {
    for comment in [
      ";; producer's records",
      ";; the producer calls \"snapshot",
      "# $(unclosed",
      ";; <<EOF",
      "# |",
      ";; &&",
    ] {
      let source = format!("{comment}\n(let rows\n  (list \"row\"))\nprobe after");
      let chunks: Vec<_> = coalesce_balanced_lines(&source).collect();
      assert_eq!(chunks.len(), 3, "{source}");
      assert_eq!(chunks[0], (1, Cow::Borrowed(comment)));
      assert_eq!(
        chunks[1],
        (2, Cow::Owned("(let rows\n  (list \"row\"))".into()))
      );
      assert_eq!(chunks[2], (4, Cow::Borrowed("probe after")));
    }
  }

  #[test]
  fn chunks_keep_parenthesized_heredoc_body_in_the_bash_statement() {
    let source = "std.io.stdin_text <<'EOF'\n(unclosed\n(let fake 1))\nEOF\n(let after\n  2)";
    let chunks: Vec<_> = coalesce_balanced_lines(source).collect();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].0, 1);
    assert_eq!(
      chunks[0].1,
      "std.io.stdin_text <<'EOF'\n(unclosed\n(let fake 1))\nEOF"
    );
    assert_eq!(chunks[1], (5, Cow::Owned("(let after\n  2)".into())));
  }

  #[test]
  fn chunks_keep_heredoc_bodies_literal_and_preserve_following_line_numbers() {
    for delimiter in ["'EOF'", "\"EOF\"", "\\EOF"] {
      let source = format!("cat <<{delimiter}\n$(unclosed `source\nEOF\necho after\n");
      let chunks: Vec<_> = coalesce_balanced_lines(&source).collect();
      assert_eq!(chunks.len(), 2);
      assert_eq!(chunks[0].0, 1);
      assert_eq!(chunks[1], (4, Cow::Borrowed("echo after")));
    }
    let source = "ssh host 'cat <<\"PY\n\"\n$( `source\nPY'\necho after\n";
    let chunks: Vec<_> = coalesce_balanced_lines(source).collect();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[1].0, 5);
    assert_eq!(chunks[1].1, "echo after");
    let chunks: Vec<_> = coalesce_balanced_lines("cat <<-'EOF'\n\thi\n\tEOF\necho after").collect();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[1].0, 4);
  }

  #[test]
  fn chunks_preserve_bash_continuations_and_their_physical_line_numbers() {
    let chunks: Vec<_> = coalesce_balanced_lines("echo ab\\\ncd\necho \\\njoined\necho hi \\\n").collect();
    assert_eq!(chunks, vec![
      (1, Cow::Owned("echo ab\\\ncd".into())),
      (3, Cow::Owned("echo \\\njoined".into())),
      (5, Cow::Owned("echo hi \\\n".into())),
    ]);
    assert_eq!(coalesce_balanced_lines("# comment \\\necho yes").count(), 2);
    assert!(!bash_trailing_continuation("echo 'single\\"));
    assert!(!bash_trailing_continuation("echo escaped\\\\"));
    assert!(flow_needs_continuation("echo \"double\\"));
    assert!(!bash_trailing_continuation("echo a # comment \\"));
    assert!(bash_trailing_continuation(r"echo a\ #literal \"));
    assert!(bash_trailing_continuation(r#"echo "$(printf "%s" "it's")" \"#));
  }

  #[test]
  fn chunks_read_only_through_the_next_complete_form() {
    let reads = std::cell::Cell::new(0);
    let source = "probe alpha\n(concat\n \"x\")\nprobe omega\n";
    let lines = source
      .lines()
      .enumerate()
      .inspect(|_| reads.set(reads.get() + 1));
    let mut chunks = coalesce_lines(lines);
    assert_eq!(reads.get(), 0, "construction must not scan the script");
    assert_eq!(chunks.next().unwrap().1, "probe alpha");
    assert_eq!(reads.get(), 1);
    assert_eq!(
      chunks.next().unwrap(),
      (2, Cow::Owned("(concat\n \"x\")".into()))
    );
    assert_eq!(
      reads.get(),
      3,
      "leave later commands unread until requested"
    );
    drop(chunks);
    assert_eq!(reads.get(), 3);
  }

  #[test]
  fn chunks_match_eager_coalescing_text_and_line_numbers() {
    // Keep plain lines complete: the old reference covers Lisp gathering,
    // while Bash multiline quotes and heredocs have their own tests.
    let fragments = [
      "",
      " ",
      "probe α",
      "(concat",
      " \"a)\"",
      ")",
      "(list '(a b))",
      "> (concat",
      "; unmatched (",
      "# unmatched )",
      "(concat \"open",
      "; \"open",
      "(concat \"escaped\\\"quote\")",
    ];
    for a in fragments {
      for b in fragments {
        for c in fragments {
          for ending in ["\n", "\r\n"] {
            let source = [a, b, c].join(ending);
            let expected = reference_coalesce(&source);
            let actual: Vec<_> = coalesce_balanced_lines(&source)
              .map(|(n, chunk)| (n, chunk.into_owned()))
              .collect();
            assert_eq!(actual, expected, "source={source:?}");
          }
        }
      }
    }
  }

  #[test]
  fn paren_incomplete_lisp_keeps_legacy_continuation_in_one_chunk() {
    let source = "(concat\n> (concat\n ";
    let chunks: Vec<_> = coalesce_balanced_lines(source).collect();
    assert_eq!(chunks, vec![(1, Cow::Borrowed(source))]);
  }

  #[test]
  fn paren_lisp_fixture_keeps_comments_quotes_and_every_prefix() {
    let source = include_str!("../../tests/fixtures/paren-lisp.tsh");
    let mut prefix = String::new();
    for line in source.lines() {
      prefix.push_str(line);
      prefix.push('\n');
      assert!(matches!(classify(&prefix), LineKind::LispStmt(_)), "{prefix}");
    }
    let chunks: Vec<_> = coalesce_balanced_lines(source).collect();
    assert_eq!(chunks.len(), 1, "{chunks:?}");
    assert_eq!(chunks[0].0, 1);
    assert_eq!(chunks[0].1, source.trim_end());
  }

  #[test]
  fn paren_synthetic_subshell_shapes_stay_bash() {
    for source in [
      "(cmd x 2>&1 | tail -40)",
      "(cd x && make)",
      "( set -a; . ./.env; cmd )",
      "(a; b) > out",
      "(a || b)",
      "(case x in x) a ;; esac)",
    ] {
      assert_eq!(classify(source), LineKind::Plain(source), "{source}");
    }
  }

  #[test]
  fn paren_tracked_lisp_source_census() {
    let tento = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let tsh = tento.parent().unwrap().join("tsh");
    if !tsh.is_dir() {
      eprintln!("skipping tracked Lisp census: sibling tsh checkout is unavailable");
      return;
    }
    for repo in [tento, tsh.as_path()] {
      let available = std::process::Command::new("git")
        .env("LC_ALL", "C")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(repo).output();
      let output = match available {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
          eprintln!("skipping tracked Lisp census: git is unavailable");
          return;
        }
        Err(error) => panic!("{}: cannot run git: {error}", repo.display()),
      };
      if !output.status.success() {
        assert_eq!(output.status.code(), Some(128), "{}: unexpected git failure: {}",
          repo.display(), String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stderr).contains("not a git repository"),
          "{}: {}", repo.display(), String::from_utf8_lossy(&output.stderr));
        eprintln!("skipping tracked Lisp census: {} is an exported tree without Git", repo.display());
        return;
      }
      let root = std::path::PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
      if root.canonicalize().unwrap() != repo.canonicalize().unwrap() {
        eprintln!("skipping tracked Lisp census: {} has no checkout of its own", repo.display());
        return;
      }
    }
    let mut forms = 0;
    for repo in [tento, tsh.as_path()] {
      let before = forms;
      let tracked = std::process::Command::new("git")
        .args(["ls-files", "-z", "--", "*.tsh", "*.tshrc"])
        .current_dir(repo).output().unwrap();
      assert!(tracked.status.success(), "{}: git ls-files failed: {}",
        repo.display(), String::from_utf8_lossy(&tracked.stderr));
      for path in tracked.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        let path = std::str::from_utf8(path).unwrap();
        // This lexer/grammar corpus intentionally includes deprecated comments
        // and reader edge cases. Its own conformance test validates those bytes;
        // it is not a runnable Lisp source subject to the comment migration.
        if repo == tento && path == "tento-syntax/tests/fixtures/tsh-reader-conformance.tsh" {
          continue;
        }
        if repo == tsh && !path.starts_with("presets/") && !path.starts_with("plugins/") {
          continue;
        }
        let source = std::fs::read_to_string(repo.join(path)).unwrap();
        for (line, form) in coalesce_balanced_lines(&source) {
          // I10 migration: every lisp comment is `;;` or a `(; … ;)` block.
          assert_eq!(semicolon_comment_line(&form, false), None,
            "{}:{line}: a single `;` comment; write `;;`", repo.join(path).display());
          if form.trim_start().starts_with('(') && !form.trim_start().starts_with("(;") {
            forms += 1;
            assert!(matches!(classify(&form), LineKind::LispStmt(_)), "{}:{line}: {form}", repo.join(path).display());
          }
        }
      }
      assert!(forms > before, "{}: the available checkout must contain tracked Lisp forms", repo.display());
    }
    assert!(forms > 0, "the census must exercise tracked Lisp sources");
    eprintln!("tracked Lisp census classified {forms} forms as Lisp");
  }

  fn reference_coalesce(source: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut acc: Option<(usize, String, FormScan)> = None;
    for (idx, raw) in source.lines().enumerate() {
      let line_num = idx + 1;
      match acc.take() {
        None => {
          let trimmed = raw.trim_start();
          let lispish = trimmed.starts_with('(')
            || trimmed
              .strip_prefix('>')
              .is_some_and(|rest| rest.trim_start().starts_with('('));
          if lispish {
            let mut scan = FormScan::default();
            scan.feed(raw);
            if scan.open() {
              acc = Some((line_num, raw.to_string(), scan));
              continue;
            }
          }
          out.push((line_num, raw.to_string()));
        }
        Some((start, mut buf, mut scan)) => {
          buf.push('\n');
          buf.push_str(raw);
          scan.feed(raw);
          if scan.open() {
            acc = Some((start, buf, scan));
          } else {
            out.push((start, buf));
          }
        }
      }
    }
    if let Some((start, buf, _)) = acc {
      out.push((start, buf));
    }
    out
  }

  /// The quote sugar is not a string delimiter: a form containing `'((…))`
  /// coalesces to exactly its own balanced lines, and the lines after it —
  /// including comments with unbalanced parens and non-ASCII punctuation —
  /// stay separate statements. Regression: FormScan's shell-style squote
  /// tracking made the apostrophe open a never-closing "string", so the chunk
  /// swallowed the rest of the source and the parser failed on unrelated text
  /// (found live: a `.tshrc` `(render.line '(…))` ate the file's trailing
  /// `# NOTE — …` comments and errored on the em-dash).
  #[test]
  fn quote_sugar_does_not_open_a_string_in_coalescing() {
    let source = "(render.register \"status.line\"\n  (render.line '((session.cwd) (gap))))\n\n# NOTE — imports below (currently\n# broken).\n(let after 1)";
    let chunks: Vec<_> = coalesce_balanced_lines(source).collect();
    let starts: Vec<usize> = chunks.iter().map(|(n, _)| *n).collect();
    assert_eq!(starts, vec![1, 3, 4, 5, 6], "chunk starts: {chunks:?}");
    assert!(
      chunks[0].1.ends_with("(gap))))"),
      "the quoted form ends at its own balance, got: {}",
      chunks[0].1
    );
    assert_eq!(
      chunks[4].1, "(let after 1)",
      "statements after the form survive"
    );
  }

  /// A failing middle statement doesn't kill the rest: statements 1 and 3 both
  /// executed (their defs are readable from the host afterwards), and the unit
  /// still ends ✗ with a summary anchored at the failure. The comment + blank
  /// lines prove M counts evaluable statements only.
  #[tokio::test]
  async fn warn_continue_runs_past_a_failing_statement() {
    let mut host = LispHost::new();
    let source = "; boot\n> (let a 1)\n\n(nope)\n> (let b 2)";
    let err = run_source_on_host(&mut host, source, &scripts(), &subs(), &[], warn_continue())
      .await
      .expect_err("a failed statement still fails the unit");
    assert!(
      host
        .eval_truthy("(and (= a 1) (= b 2))")
        .expect("defs evaluate"),
      "statements before AND after the failure must have run"
    );
    assert_eq!(err.line, 4, "summary anchors at the first failure");
    let msg = format!("{err}");
    assert!(msg.contains("1 of 3 statements failed"), "got: {msg}");
    assert!(msg.contains("undefined symbol"), "got: {msg}");
  }

  /// A single-statement unit under `WarnContinue` skips the "1 of 1" summary
  /// wrapper: the failure returns plainly — line, source, original kind —
  /// exactly as `Halt` would return it. (Blank/comment lines don't count as
  /// statements.)
  #[tokio::test]
  async fn warn_continue_single_statement_failure_is_plain() {
    let mut host = LispHost::new();
    let source = "; ctl unit\n(nope)\n";
    let err = run_source_on_host(&mut host, source, &scripts(), &subs(), &[], warn_continue())
      .await
      .expect_err("the failing statement fails the unit");
    assert_eq!(err.line, 2, "anchored at the failing statement");
    let msg = format!("{err}");
    assert!(
      !msg.contains("statements failed"),
      "no summary wrapper around a single statement: {msg}"
    );
    assert!(
      msg.contains("undefined symbol"),
      "original reason intact: {msg}"
    );
  }

  /// Multiple failures: the summary carries the FIRST reason plus a count of
  /// the rest — it does NOT enumerate them (each was already warned
  /// individually, and enumeration re-chops the same text mid-word).
  #[tokio::test]
  async fn warn_continue_summary_counts_rather_than_enumerates() {
    let mut host = LispHost::new();
    let source = "(nope)\n(also-nope)\n> (let c 3)";
    let err = run_source_on_host(&mut host, source, &scripts(), &subs(), &[], warn_continue())
      .await
      .expect_err("failed statements still fail the unit");
    assert!(
      host.eval_truthy("(= c 3)").expect("def evaluates"),
      "the statement after both failures must have run"
    );
    let msg = format!("{err}");
    assert!(msg.contains("2 of 3 statements failed"), "got: {msg}");
    assert!(msg.contains("nope"), "first reason present: {msg}");
    assert!(msg.contains("(+1 more, each warned)"), "got: {msg}");
    assert!(
      !msg.contains("also-nope"),
      "later failures are counted, not enumerated: {msg}"
    );
  }

  /// With nothing failing, `WarnContinue` is indistinguishable from `Halt`:
  /// `Ok(last)` — the last statement's value, lisp form or posix line alike
  /// (here `(assert …)` returns its truthy condition).
  #[tokio::test]
  async fn warn_continue_with_no_failures_matches_halt() {
    let mut host = LispHost::new();
    let source = "> (let ok 1)\n(assert (= ok 1))";
    let value = run_source_on_host(&mut host, source, &scripts(), &subs(), &[], warn_continue())
      .await
      .expect("clean source runs");
    assert_eq!(
      value,
      Some(JsonValue::Bool(true)),
      "the last lisp statement's value is the unit value"
    );
  }

  /// The unit value is the LAST statement's value regardless of statement
  /// kind (bash-like): a trailing lisp form that returns a string yields
  /// `Some(json string)`, exactly as a posix line would.
  #[tokio::test]
  async fn last_lisp_statement_value_is_the_unit_value() {
    let mut host = LispHost::new();
    let source = "> (let greeting \"hi\")\n(concat greeting \" there\")";
    let value = run_source_on_host(
      &mut host,
      source,
      &scripts(),
      &subs(),
      &[],
      RunOptions::default(),
    )
    .await
    .expect("clean source runs");
    assert_eq!(value, Some(JsonValue::String("hi there".into())));
  }

  /// A nil-valued trailing form stays silent: `Null` maps to `None`, so
  /// side-effect-only forms produce no unit value.
  #[tokio::test]
  async fn nil_valued_last_statement_yields_no_unit_value() {
    let mut host = LispHost::new();
    let source = "> (let ok 1)\n(if (= ok 2) \"never\" nil)";
    let value = run_source_on_host(
      &mut host,
      source,
      &scripts(),
      &subs(),
      &[],
      RunOptions::default(),
    )
    .await
    .expect("clean source runs");
    assert!(
      value.is_none(),
      "a nil-returning lisp form yields no unit value"
    );
  }

  /// A HARD error (`expect`'s escalation) halts the unit even under
  /// `WarnContinue`: statement 1 ran, the `expect` failed HARD at statement 2,
  /// and statement 3 never ran (unlike a soft failure, which would continue).
  /// The error text carries the custom message.
  #[tokio::test]
  async fn warn_continue_halts_on_a_hard_expect_failure() {
    let mut host = LispHost::new();
    let source = "> (let a 1)\n(expect (nope) \"must exist\")\n> (let b 2)";
    let err = run_source_on_host(&mut host, source, &scripts(), &subs(), &[], warn_continue())
      .await
      .expect_err("a hard failure fails the unit");
    assert_eq!(
      err.line, 2,
      "halts AT the hard failure, not a rolled-up summary"
    );
    assert!(
      host.eval_truthy("(= a 1)").expect("a defined"),
      "statement 1 ran"
    );
    assert!(
      host.eval_expr("b").is_err(),
      "statement after a HARD failure must NOT run under WarnContinue"
    );
    let msg = format!("{err}");
    assert!(
      msg.contains("must exist"),
      "custom expect message present: {msg}"
    );
    assert!(
      !msg.contains("statements failed"),
      "a hard halt returns the error directly, not a WarnContinue summary: {msg}"
    );
  }

  /// `unwrap`'s sibling: the messageless escalation halts the unit the same
  /// way under `WarnContinue` — statement 3 never runs.
  #[tokio::test]
  async fn warn_continue_halts_on_a_hard_unwrap_failure() {
    let mut host = LispHost::new();
    let source = "> (let a 1)\n(unwrap (nope))\n> (let b 2)";
    let err = run_source_on_host(&mut host, source, &scripts(), &subs(), &[], warn_continue())
      .await
      .expect_err("a hard failure fails the unit");
    assert_eq!(err.line, 2, "halts AT the hard failure");
    assert!(
      host.eval_truthy("(= a 1)").expect("a defined"),
      "statement 1 ran"
    );
    assert!(
      host.eval_expr("b").is_err(),
      "statement after a HARD failure must NOT run under WarnContinue"
    );
    let msg = format!("{err}");
    assert!(msg.contains("unwrap failed"), "got: {msg}");
  }

  /// The source-path channel for STARTUP UNITS: `RunOptions::source_path`
  /// stamps the host's current-file slot (an rc-file unit sees its own dir via
  /// `(std.script.dir)`), a pathless run RESETS it (no stale leak from the
  /// previous unit on a persistent host), and the in-band
  /// `(std.script.source "PATH")` context form — how a queued startup unit
  /// carries its path — overrides for the rest of its unit.
  #[tokio::test]
  async fn source_path_stamps_resets_and_ctl_form_overrides() {
    let mut host = LispHost::new();

    // 1. An rc startup unit with its file threaded as metadata.
    let opts = RunOptions {
      source_path: Some(std::path::PathBuf::from("/etc/rc.d/acme.tshrc")),
      ..RunOptions::default()
    };
    run_source_on_host(
      &mut host,
      "(let rc-dir (std.script.dir))\n(let rc-path (std.script.path))",
      &scripts(),
      &subs(),
      &[],
      opts,
    )
    .await
    .expect("file-backed unit runs");
    assert!(host.eval_truthy(r#"(= rc-dir "/etc/rc.d")"#).unwrap());
    assert!(
      host
        .eval_truthy(r#"(= rc-path "/etc/rc.d/acme.tshrc")"#)
        .unwrap()
    );

    // 2. The next (pathless) unit on the SAME host: the slot resets — nil.
    run_source_on_host(
      &mut host,
      "> (let after (std.script.path))",
      &scripts(),
      &subs(),
      &[],
      RunOptions::default(),
    )
    .await
    .expect("pathless unit runs");
    assert!(
      host.eval_truthy("(null? after)").unwrap(),
      "no stale path leaks"
    );

    // 3. A queued startup unit carries its path IN-BAND via the leading
    //    context form (the unit queue has no metadata channel).
    run_source_on_host(
      &mut host,
      "(std.script.source \"/home/u/.tshrc\")\n> (let unit-dir (std.script.dir))",
      &scripts(),
      &subs(),
      &[],
      RunOptions::default(),
    )
    .await
    .expect("ctl-form unit runs");
    assert!(host.eval_truthy(r#"(= unit-dir "/home/u")"#).unwrap());
  }

  /// The default stays `Halt`: the same failing source stops at statement 2 —
  /// statement 3 never runs.
  #[tokio::test]
  async fn halt_default_stops_at_first_failure() {
    let mut host = LispHost::new();
    let source = "; boot\n> (let a 1)\n\n(nope)\n> (let b 2)";
    let err = run_source_on_host(
      &mut host,
      source,
      &scripts(),
      &subs(),
      &[],
      RunOptions::default(),
    )
    .await
    .expect_err("halts at the failure");
    assert_eq!(err.line, 4);
    assert!(host.eval_truthy("(= a 1)").expect("a defined"));
    assert!(
      host.eval_expr("b").is_err(),
      "statement after the failure must NOT have run under Halt"
    );
  }
}

#[cfg(test)]
#[path = "runner/bash_tests.rs"]
mod bash_tests;

#[cfg(test)]
#[path = "runner/unix_names_tests.rs"]
mod unix_names_tests;

#[cfg(test)]
#[path = "runner/compound_tests.rs"]
mod compound_tests;

#[cfg(test)]
#[path = "runner/script_builtins_tests.rs"]
mod script_builtins_tests;

#[cfg(test)]
#[path = "runner/paren_tests.rs"]
mod paren_tests;

#[cfg(test)]
#[path = "runner/set_rename_tests.rs"]
mod set_rename_tests;

#[cfg(test)]
#[path = "runner/strict_lisp_tests.rs"]
mod strict_lisp_tests;

#[cfg(test)]
#[path = "runner/commands_tests.rs"]
mod commands_tests;

#[cfg(all(test, unix))]
#[path = "runner/output_order_tests.rs"]
mod output_order_tests;

#[cfg(test)]
#[path = "runner/last_history_tests.rs"]
mod last_history_tests;

#[cfg(test)]
#[path = "runner/reader_tests.rs"]
mod reader_tests;

#[cfg(test)]
#[path = "runner/conformance_gaps_tests.rs"]
mod conformance_gaps_tests;

#[cfg(test)]
#[path = "runner/builtins_wave2_tests.rs"]
mod builtins_wave2_tests;

#[cfg(test)]
#[path = "runner/expansion_gaps_tests.rs"]
mod expansion_gaps_tests;

#[cfg(test)]
#[path = "runner/execution_gaps_tests.rs"]
mod execution_gaps_tests;

#[cfg(test)]
#[path = "runner/error_policy_tests.rs"]
mod error_policy_tests;

#[cfg(test)]
#[path = "runner/source_positions_tests.rs"]
mod source_positions_tests;
