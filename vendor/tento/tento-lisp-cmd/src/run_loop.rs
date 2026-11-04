use colored::Colorize;
use futures::FutureExt;
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::panic::AssertUnwindSafe;
use std::rc::Rc;
use std::sync::LazyLock;
use tento_term::Style;
use tracing::{error, info};

use crate::Scripts;
use crate::command_list::CommandList;
use crate::error::{Error, ToTrace};
use crate::script::LispHost;
use crate::shell::Callable;

/// The outcome of reading one input line. Was `reedline::Signal`; reedline is
/// gone, so this is the reedline-free equivalent a cooked line reader returns.
pub enum Signal {
  Success(String),
  CtrlC,
  CtrlD,
}

/// Reads one line of input for the interactive REPL. The only impl is the
/// cooked-stdin [`crate::shell::StdinLineReader`]; the TUI drives its own loop
/// and never constructs one.
pub trait LineReader {
  fn read_line(&mut self) -> anyhow::Result<Signal>;
}

/// What the host tells a component about the surface it is painting onto.
///
/// Every field is a **fact the caller actually knows**, never a placeholder: a
/// component that decides whether to animate must be handed the real width,
/// the real in-flight state, the real motion preference, and a real stable
/// identity — a hardcoded `width: 100, active: true` would make every
/// component's "am I still running?" answer a lie.
#[derive(Clone, Debug)]
pub struct RenderRequest<'a> {
  /// The producer value (the `datatype`-tagged record), passed through as the
  /// component's `props` unchanged.
  pub value: &'a Value,
  /// The content width this render will actually be painted at.
  pub width: u16,
  /// Whether the element this value describes is still in flight. A finished
  /// element renders its still frame and asks for no wakeups.
  pub active: bool,
  /// Whether the operator asked for reduced motion (see
  /// `tento_shapes::REDUCED_MOTION_VAR`) — independent of any color setting.
  pub reduced_motion: bool,
  /// A stable identity for this element, unique within the surface and
  /// unchanged across repaints. Components compose animation keys from it so
  /// an animation keeps its phase (and its elapsed time) across rebuilds.
  pub origin: &'a str,
  /// Host-held per-row view state for THIS element: a JSON **object** keyed by
  /// the row paths the component itself authored (`tool:abc`; `""` for a row
  /// addressed at the element's own base), valued by that row's state — e.g.
  /// `{"expanded": true}` after the operator pressed Enter on a `toggle` row.
  ///
  /// The keys are RELATIVE on purpose: a component reads back exactly the
  /// `:path` vocabulary it wrote, and never has to know (or guess) the host's
  /// base path. Empty on every surface that holds no view state — the CLI,
  /// `tsh replay`, tests — so a collapsed-by-default face is the deterministic
  /// snapshot face.
  pub state: &'a Value,
  /// The row of THIS element the operator's cursor sits on, or `None` when the
  /// selection is elsewhere (or the surface has no cursor at all).
  ///
  /// Keyed in the SAME relative vocabulary as [`Self::state`] — the row `:path`
  /// the component itself authored (`tool:abc`; `""` for a row addressed at the
  /// element's own base) — so a component compares it against its own row ids
  /// and never has to reconstruct the host's base path.
  ///
  /// This is what lets a face spend ink only where the cursor is: the row under
  /// the cursor can show its affordance (`· enter to expand`) while every other
  /// block on screen stays quiet. `None` on every surface without a cursor —
  /// the CLI, `tsh replay`, tests — so the snapshot face is the quiet one.
  pub selected: Option<&'a str>,
}

/// The empty render state: no row of this element carries view state. The
/// truthful value for every surface with nowhere to keep it.
static EMPTY_STATE: LazyLock<Value> = LazyLock::new(|| Value::Object(serde_json::Map::new()));

impl<'a> RenderRequest<'a> {
  /// The one-shot CLI surface: a static snapshot at the terminal width.
  /// `active: false` + `reduced_motion: true` are the truth here — a printed
  /// record has nothing in flight and nothing to animate it, and it holds no
  /// per-row state (nothing can have been toggled) and no cursor (nothing can
  /// be selected).
  pub fn snapshot(value: &'a Value, width: u16) -> Self {
    RenderRequest {
      value,
      width,
      active: false,
      reduced_motion: true,
      origin: "cli",
      state: RenderRequest::empty_state(),
      selected: None,
    }
  }

  /// The shared empty [`Self::state`] object — what a host with no view-state
  /// store hands every component.
  pub fn empty_state() -> &'static Value {
    &EMPTY_STATE
  }
}

/// A host-injected render hook: maps a producer value carrying a `datatype` tag
/// to a render **shape** value (e.g. `table/v1`) the shape registry can render.
/// The datatype→preset→shape resolution lives on the host side (tsh, which owns
/// the `RcStack` + preset files); this crate only holds the injection slot and
/// consults it at the render boundary. Returns `None` when the value has no
/// datatype the host can resolve. Mirrors the `ImportResolver` injection.
pub type RenderHook = Rc<dyn Fn(&RenderRequest) -> Option<Value>>;

pub async fn run<Info>(
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  line_reader: &mut (impl LineReader + ?Sized),
) -> Result<(), Error>
where
  Info: Clone + 'static,
{
  run_with_resolver(
    scripts,
    subcommands,
    std::rc::Rc::new(crate::script::NoApps),
    None,
    line_reader,
  )
  .await
}

/// The generic core of [`run`]/[`run_with_apps`]: drive the REPL / one-shot
/// dispatch against an injected import resolver — no `.tsh.app` reference.
/// Reads the process argv; a host that pre-filters its argv (tsh strips
/// `@profile` tokens) must use [`run_with_resolver_argv`] instead.
pub async fn run_with_resolver<Info>(
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  resolver: Rc<dyn crate::script::ImportResolver>,
  render_hook: Option<RenderHook>,
  line_reader: &mut (impl LineReader + ?Sized),
) -> Result<(), Error>
where
  Info: Clone + 'static,
{
  let argv: Vec<String> = env::args().collect();
  run_with_resolver_argv(
    scripts,
    subcommands,
    resolver,
    render_hook,
    line_reader,
    argv,
    None,
  )
  .await
}

/// [`run_with_resolver`] with the invocation argv passed EXPLICITLY (index 0 =
/// the binary name, exactly the `env::args()` shape). The run loop itself
/// never reads the process argv — a host that filters or rewrites its argv
/// before dispatch (tsh's `@profile` selectors) passes the filtered vector
/// here, and what the loop dispatches is exactly what the host decided.
///
/// `host` is the CONTINUING evaluation host. `Some(h)` hands the loop the very
/// host an earlier phase already populated — [`crate::Shell::run_with_startup_argv`]
/// passes the one its rc/startup units evaluated on, so a `(let …)` in an rc is
/// visible to the dispatched command and to every REPL prompt. `None` (the
/// default for bundled apps, which have no startup phase) builds a fresh host
/// per branch, as before.
pub async fn run_with_resolver_argv<Info>(
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  resolver: Rc<dyn crate::script::ImportResolver>,
  render_hook: Option<RenderHook>,
  line_reader: &mut (impl LineReader + ?Sized),
  argv: Vec<String>,
  host: Option<crate::script::LispHost>,
) -> Result<(), Error>
where
  Info: Clone + 'static,
{
  if let Err(e) = run_once_or_loop(
    scripts,
    subcommands,
    resolver,
    render_hook,
    line_reader,
    argv,
    host,
  )
  .await
  {
    log_command_failure(&e);
    return Err(e);
  }
  Ok(())
}

/// The value a human one-shot prints for the result of command `name`: the shape
/// its declared return type renders to (`CommandMetadata::render_result`), else
/// `data` as it is. `--json` and Lisp callers never come through here; they
/// keep the plain data.
pub(crate) fn human_value<'a, Info>(
  scripts: &Scripts<Info>,
  name: Option<&str>,
  data: &'a Value,
) -> std::borrow::Cow<'a, Value>
where
  Info: Clone + 'static,
{
  match name
    .and_then(|name| scripts.commands.find_command(name))
    .and_then(|command| command.render_result(data))
  {
    Some(shape) => std::borrow::Cow::Owned(shape),
    None => std::borrow::Cow::Borrowed(data),
  }
}

/// Convert a `run()` failure into a non-zero process exit. `run()` only
/// returns `Err` from the one-shot CLI path (`argv.len() > 1`) — the
/// interactive REPL catches per-command errors and returns `Ok(())` — so an
/// error here always means a one-shot invocation failed and should exit 1.
///
/// This used to gate on `!stdin().is_terminal()`, but that conflated "one-shot
/// invocation" with "piped stdin": running `./bin sub bogus` from a terminal
/// has a tty stdin, so the failure silently exited 0.
pub fn exit_on_cli_failure<E>(result: Result<(), E>) {
  if result.is_err() {
    std::process::exit(1);
  }
}

/// In CLI / piped mode the shell discards a command's return value (the TUI
/// host renders it instead, via `exec.body`). If that value carries a render
/// shape the registry knows (`table/v1`, `sections/v1`, …), render it to
/// aligned text at the terminal width — the non-TUI counterpart to the trace
/// pane's inline-shape rendering, so `./run ux-test ls` and friends still show
/// a table on the CLI / when piped.
///
/// Returns `None` for non-shape values (the caller falls through to the
/// readable-JSON path). A `source`-aliased shape resolves here too, via
/// `FileSourceResolver`.
pub(crate) fn cli_shape_text(value: &Value) -> Option<String> {
  static REGISTRY: std::sync::LazyLock<tento_shapes::ShapeRegistry> =
    std::sync::LazyLock::new(tento_shapes::ShapeRegistry::core);
  REGISTRY.render_text(value)
}

async fn run_once_or_loop<Info>(
  scripts: Rc<Scripts<Info>>,
  subcommands: Rc<HashMap<String, Box<dyn Callable>>>,
  resolver: Rc<dyn crate::script::ImportResolver>,
  render_hook: Option<RenderHook>,
  line_reader: &mut (impl LineReader + ?Sized),
  mut argv: Vec<String>,
  mut host: Option<crate::script::LispHost>,
) -> Result<(), Error>
where
  Info: Clone + 'static,
{
  if argv.len() > 1 {
    argv.remove(0);

    // Script-mode dispatch:
    //   `<bin> path/to/script.tsh`                       (root scripts)
    //   `<bin> --script <path>`                           (root scripts)
    //   `<bin> sub1 [sub2 …] path/to/script.tsh`          (nested)
    //
    // The nested form treats `sub1 [sub2 …]` as a prefix prepended to
    // every command line in the `.tsh` before dispatch. That lets
    // a script registered under a subcommand chain run with its own
    // command set without each line repeating the chain.
    if let Some((prefix, script_path)) = detect_script_path(&argv) {
      let dry_run = argv.iter().any(|a| a == "--dry-run");
      let opts = crate::script::RunOptions {
        dry_run,
        ..Default::default()
      };
      let result = AssertUnwindSafe(crate::script::run_file_with_prefix_and_resolver(
        script_path,
        scripts.clone(),
        subcommands.clone(),
        &prefix,
        resolver.clone(),
        opts,
      ))
      .catch_unwind()
      .await;
      return match result {
        Ok(Ok(_)) => {
          // Same constraint as the one-shot exit below: the external-printer
          // task parks a worker in a blocking `recv()`, so returning here
          // stalls the runtime drop. Flush + force-exit.
          use std::io::Write as _;
          let _ = std::io::stdout().flush();
          std::process::exit(0);
        }
        Ok(Err(e)) => {
          eprintln!("error: {e:#}");
          Err(Error::Other(anyhow::anyhow!(e.to_string())))
        }
        Err(_) => std::process::exit(1),
      };
    }

    // One-shot Lisp form: `tsh '(ls "/tmp")'`. A single arg opening with `(` or
    // `>` evaluates as Lisp — every command reachable via the host's command
    // fallback — and its value renders like a command's return value.
    if argv.len() == 1 {
      let trimmed = argv[0].trim_start();
      if let crate::script::parser::LineKind::LispStmt(src) = crate::script::parser::classify(trimmed) {
        let mut host = continue_or_new(&mut host, &scripts, &subcommands, &resolver);
        use std::io::Write as _;
        match host.eval_to_json(src) {
          Ok(value) => {
            if host.command_json_output() {
              match serde_json::to_string(&value) {
                Ok(json) => println!("{json}"),
                Err(e) => eprintln!("error: serializing --json output: {e}"),
              }
            } else if let Some(text) = format_cli_value(&value, render_hook.as_ref()) {
              println!("{text}");
            }
            let _ = std::io::stdout().flush();
            std::process::exit(0);
          }
          Err(e) => {
            eprintln!("{} {e}", Style::Red.paint("error:"));
            let _ = std::io::stdout().flush();
            std::process::exit(1);
          }
        }
      }
    }

    // One-shot posix command: read into the unified s-expression and evaluate
    // it on a fresh host (every command is an env native): `ls /tmp` -> `(ls "/tmp")`.
    let mut host = continue_or_new(&mut host, &scripts, &subcommands, &resolver);
    // Async dispatch so a one-shot daemon command awaits; an unknown command
    // gets the structured `CommandNotFound` (nearest-match + available list).
    let paren_source = argv.len() == 1 && argv[0].trim_start().starts_with('(');
    if paren_source { host.set_shell_invocation_flags(true, false, false); }
    // The command a human one-shot ran, whose declared result shape renders it.
    let invoked = if paren_source { None } else { argv.first().cloned() };
    let result = std::panic::AssertUnwindSafe(async {
      if paren_source { host.eval_posix_line_async(&argv[0]).await }
      else { host.eval_posix_argv_async(argv).await }
    })
      .catch_unwind()
      .await;

    match result {
      Ok(Ok(value)) => {
        if host.command_json_output() {
          // Machine output: the raw return value as JSON (raw data or a tagged
          // render shape). The shell host renders shapes; here we emit the bytes.
          match serde_json::to_string(&value) {
            Ok(json) => println!("{json}"),
            Err(e) => eprintln!("error: serializing --json output: {e}"),
          }
        } else if let Some(text) = format_cli_value(&human_value(&scripts, invoked.as_deref(), &value), render_hook.as_ref()) {
          // Human one-shot: render the return value the same way the REPL does
          // (a `table/v1` as text, a string/help-tree/object readably). Previously
          // only `table/v1` printed, so e.g. `tsh pwd` (a string) showed nothing.
          println!("{text}");
        }
        // Flush + force-exit. The `argv>1` branch above spawned a task that
        // blocks forever on the external printer's `recv()`; returning would
        // stall tokio's runtime drop (the blocking recv can't be aborted),
        // hanging the process AND losing block-buffered stdout. Force-exit;
        // flush first so the rendered output actually reaches the
        // terminal/pipe.
        use std::io::Write as _;
        let _ = std::io::stdout().flush();
        std::process::exit(if paren_source { host.shell_status() } else { 0 });
      }
      Ok(Err(e)) => {
        // A command that ran and failed has already said so; tsh exits with
        // its status and adds no line (argv.md I14). Everything else is tsh's
        // own error and stays loud. Shape-aware: `CommandNotFound` renders its
        // `sections/v1` (suggestion + available) like the trace pane; shapeless
        // errors stay plain text.
        if !is_command_status(&e) {
          eprintln!("{}", render_cli_error(&e));
        }
        use std::io::Write as _;
        let _ = std::io::stdout().flush();
        std::process::exit(e.process_status().unwrap_or(1));
      }
      Err(_) => {
        // A panic occurred - exit with error code
        std::process::exit(1);
      }
    }
  }

  // Interactive REPL: one persistent Lisp host so `(let …)` survives across
  // prompts and every command is Lisp-callable. Bare lines stay shell commands.
  // It CONTINUES the startup host when one was passed, so the rc's `(let …)`s
  // are bound at the first prompt rather than the REPL opening on a blank slate.
  let mut host = continue_or_new(&mut host, &scripts, &subcommands, &resolver);
  let prompt_render = render_hook.clone();
  host.set_shell_invocation_flags(false, false, true);
  host.set_shell_formatter(Rc::new(move |value| {
    format_cli_value(value, prompt_render.as_ref()).map(|text| format!("{text}\n"))
  }));

  // Job control at the terminal, as bash's interactive shell has it: the
  // shell owns the terminal, a foreground job is handed it, and Ctrl-Z stops
  // the job instead of the shell. A no-op when stdin is not a terminal.
  crate::script::claim_terminal();
  // bash's checkjobs: an `exit` with stopped jobs warns once; the next line,
  // when it is `exit` again (or follows `jobs`), leaves.
  let mut exit_acknowledged = false;

  loop {
    // bash's notices, before the prompt: a job that finished or stopped since
    // the last line, `[1]+  Done  cmd`, each told once.
    for notice in host.job_notices() {
      eprintln!("{notice}");
    }
    let sig = line_reader.read_line();

    match sig {
      Ok(Signal::Success(line)) => {
        if line.trim().is_empty() {
          continue;
        }
        if let Some(requested) = exit_request(&line) {
          match requested {
            Ok(status) => leave_prompt(&mut host, &mut exit_acknowledged, status),
            Err(operand) => {
              eprintln!("tsh: exit: {operand}: numeric argument required");
              exit_acknowledged = false;
            }
          }
          continue;
        }
        // Listing the jobs counts as being told of them (bash).
        exit_acknowledged = line.split_whitespace().next() == Some("jobs");

        // Polymorphic: a line opening with `(` or `>` is Lisp; render its value
        // (a `table/v1` as text, etc.). Everything else is a shell command.
        let trimmed = line.trim_start();
        if let crate::script::parser::LineKind::LispStmt(src) = crate::script::parser::classify(trimmed) {
          match host.eval_to_json(src) {
            Ok(value) => {
              if let Some(text) = format_cli_value(&value, render_hook.as_ref()) {
                println!("{text}");
              }
            }
            Err(e) => eprintln!("{} {e}", Style::Red.paint("error:")),
          }
          continue;
        }

        // A posix line: read into the unified s-expression and evaluate it on the
        // persistent host (every command is an env native): `ls /tmp` -> `(ls "/tmp")`.
        // Async dispatch + structured not-found, parity with the one-shot CLI.
        let result = std::panic::AssertUnwindSafe(host.eval_prompt_source_async(trimmed))
          .catch_unwind()
          .await;

        match result {
          // Render the command's return value so the interactive REPL shows
          // output — a `table/v1` as aligned text, a help tree / object / string
          // readably. A tento-native reader restores cooked mode between lines,
          // so a direct `println!` renders cleanly (no `ExternalPrinter` fight).
          // The TUI host renders separately via `exec.body`.
          Ok(Ok(value)) => {
            if let Some(text) = format_cli_value(&value, render_hook.as_ref()) {
              println!("{text}");
            }
          }
          Ok(Err(e)) => {
            if let Some(text) = render_prompt_error(&e, &host) {
              eprintln!("{text}");
            }
          }
          Err(_) => {
            error!("Command panicked!");
          }
        }
      }
      Ok(Signal::CtrlD) => {
        // At a terminal, end of input (Ctrl-D) leaves as `exit` does,
        // stopped jobs included; piped input simply ends.
        if !crate::script::terminal_owned() {
          info!("Exiting");
          break;
        }
        leave_prompt(&mut host, &mut exit_acknowledged, None);
      }
      Ok(Signal::CtrlC) => {
        info!("Exiting");
        break;
      }
      // A read error (e.g. EOF on a closed / piped stdin) is terminal — exit
      // instead of spinning forever logging the same error.
      x => {
        if let Err(e) = x {
          info!("line reader closed ({e}); exiting");
        }
        break;
      }
    }
  }

  return Ok(());
}

/// `exit [N]` typed at the prompt: `Some(Ok(status))` (the status when one
/// is given), `Some(Err(operand))` for a status that is not a number, `None`
/// for any other line. Only a line that is the exit command alone; `exit`
/// inside a compound line is the shell's own builtin.
fn exit_request(line: &str) -> Option<Result<Option<i32>, String>> {
  let mut words = line.split_whitespace();
  if words.next() != Some("exit") {
    return None;
  }
  match (words.next(), words.next()) {
    (None, _) => Some(Ok(None)),
    (Some(word), None) => Some(
      word
        .parse::<i64>()
        .map(|status| Some((status & 0xff) as i32))
        .map_err(|_| word.to_string()),
    ),
    _ => None,
  }
}

/// Leave the interactive prompt, as bash's `exit` does: `exit` on stderr, and
/// with stopped jobs the first attempt only warns (`There are stopped
/// jobs.`); a second consecutive attempt leaves, terminating them. Running
/// jobs never hold the exit (bash's default, `checkjobs` off).
fn leave_prompt(host: &mut LispHost, acknowledged: &mut bool, status: Option<i32>) {
  use std::io::Write as _;
  if crate::script::terminal_owned() {
    eprintln!("exit");
  }
  if host.stopped_jobs() > 0 && !*acknowledged {
    eprintln!("There are stopped jobs.");
    *acknowledged = true;
    return;
  }
  host.terminate_stopped_jobs();
  let status = status.unwrap_or_else(|| host.shell_status());
  let _ = std::io::stdout().flush();
  let _ = std::io::stderr().flush();
  std::process::exit(status);
}

/// Build a Lisp host with every command registered as an env native (so each
/// command is Lisp-callable) for the REPL / one-shot paths. The shared
/// `Rc<Scripts>` alias map is mirrored into the env, so `(ls …)` resolves.
/// Take the caller's continuing host if it supplied one, else build a fresh one.
/// Exactly one dispatch branch of [`run_once_or_loop`] ever runs, so the `take`
/// is unambiguous — the host is consumed by whichever branch the argv selected.
fn continue_or_new<Info: Clone + 'static>(
  host: &mut Option<LispHost>,
  scripts: &Rc<Scripts<Info>>,
  subcommands: &Rc<HashMap<String, Box<dyn Callable>>>,
  resolver: &Rc<dyn crate::script::ImportResolver>,
) -> LispHost {
  host
    .take()
    .unwrap_or_else(|| lisp_host_for(scripts, subcommands, resolver.clone()))
}

fn lisp_host_for<Info: Clone + 'static>(
  scripts: &Rc<Scripts<Info>>,
  subcommands: &Rc<HashMap<String, Box<dyn Callable>>>,
  resolver: Rc<dyn crate::script::ImportResolver>,
) -> LispHost {
  let mut host = LispHost::with_resolver(resolver);
  host.register_commands(scripts.clone(), subcommands.clone());
  host
}

/// Format a command's return value into displayable text (or `None` when there's
/// nothing to show, i.e. `Null` — the "the command already printed" case). A
/// render shape (`table/v1`, `sections/v1`, …) becomes styled text; a reflection
/// record maps to its shape ([`crate::reflect::reflect_shape`]); a plain object
/// lists `key — description` rows; a string is itself; anything else is pretty JSON.
///
/// Both the one-shot CLI and the REPL print the result with a direct `println!`.
/// (A tento-native [`LineReader`] restores cooked mode between lines, so the
/// print renders cleanly — no reedline `ExternalPrinter` routing needed.)
pub fn format_cli_value(value: &Value, render_hook: Option<&RenderHook>) -> Option<String> {
  // External programs already own stdout/stderr. Their successful completion
  // value remains available to Lisp and explicit JSON callers, but printing
  // it here would corrupt pipelines, SSH command output, and file transfers.
  if value.get("datatype").and_then(Value::as_str) == Some("process.result/v1")
    && value.get("ok").and_then(Value::as_bool) == Some(true)
  {
    return None;
  }
  // A mounted command's result draws through the `result.shape` its manifest
  // declares (FP-13). Only this render applies it; the value stays the data.
  if let Some(shape) = crate::shape::take_declared_view(value) {
    if let Some(text) = cli_shape_text(&shape) {
      return Some(text);
    }
  }
  // A producer value carrying a `datatype` tag resolves through the host hook
  // (datatype → preset → shape+columns) BEFORE the generic shape render: a bare
  // datatype table carries no columns yet, so rendering it as a plain shape would
  // be empty. The producer's value stays pure data (`--json` emits it verbatim);
  // presentation is applied here, only for the human render.
  if let Some(hook) = render_hook {
    if value.get("datatype").is_some() {
      let width = tento_term::term_columns().clamp(20, 500) as u16;
      if let Some(shape) = hook(&RenderRequest::snapshot(value, width)) {
        if let Some(text) = cli_shape_text(&shape) {
          return Some(text);
        }
      }
    }
  }
  if let Some(text) = cli_shape_text(value) {
    return Some(text);
  }
  // A reflection record (`command.doc/v1` / `command.index/v1` / `tsh.app/v1`)
  // carries no `shape`, so it maps to one at the boundary — the record stays pure
  // for `--json`/the loader; only the human render styles it via the registry.
  if let Some(shape) = crate::reflect::reflect_shape(value) {
    if let Some(text) = cli_shape_text(&shape) {
      return Some(text);
    }
  }
  match value {
    Value::Null => None,
    Value::String(s) => Some(s.clone()),
    // An UNTAGGED object — no `shape`, no `datatype`, no reflection `type`.
    // Two very different things land here, and telling them apart is the
    // difference between a render and silent data loss:
    //
    //   * a command menu (`{name: {description: …}}`), which wants the listing
    //     below. Every in-tree producer of one now carries a `type` tag and is
    //     rendered by `reflect_shape` above; the arm stays for anything that
    //     still hands us the bare map.
    //   * ANY value from a bundle that did not tag a datatype — which is what
    //     the first plugin anyone writes returns. Listing that map's keys and
    //     dropping their values is not a degraded render, it is a lost one:
    //     `{"greeting": "hello"}` printed as `  greeting`.
    Value::Object(map) if is_command_menu(map) => {
      let lines: Vec<String> = map
        .iter()
        .map(
          |(key, entry)| match entry.get("description").and_then(Value::as_str) {
            Some(desc) => format!("  {key}  {desc}"),
            None => format!("  {key}"),
          },
        )
        .collect();
      Some(lines.join("\n"))
    }
    // A flat record renders through `kv/v1` — the same aligned `key   value`
    // block a producer gets by asking for that shape by name. A bundle should
    // still tag a datatype and ship a preset when it wants columns; this is
    // what it gets for free in the meantime, and it is lossless.
    Value::Object(map) if map.values().all(is_scalar) => cli_shape_text(&serde_json::json!({
      "shape": tento_shapes::KV_V1,
      "fields": map,
    }))
    .or_else(|| Some(serde_json::to_string_pretty(value).unwrap_or_default())),
    other => Some(serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string())),
  }
}

/// Whether an untagged object is a command menu — every entry an object, and at
/// least one of them carrying a string `description`. Deliberately strict: the
/// listing render DROPS values, so anything it is not certain about must fall
/// through to a render that keeps them.
fn is_command_menu(map: &serde_json::Map<String, Value>) -> bool {
  !map.is_empty()
    && map.values().all(Value::is_object)
    && map
      .values()
      .any(|entry| entry.get("description").and_then(Value::as_str).is_some())
}

/// A value `kv/v1` can put on one line. Nested objects/arrays cannot, so a
/// record holding one pretty-prints as JSON instead of being flattened.
fn is_scalar(value: &Value) -> bool {
  !value.is_object() && !value.is_array()
}

/// Render a command failure for a human terminal: structured errors go
/// through their `sections/v1` shape and the same registry the REPL uses
/// (`cli_shape_text`), so the CLI and the trace pane render one block;
/// shapeless errors keep the one-line `error: …` form. `Error`'s `Display`
/// stays plain for logs and hosts.
/// A failure that is only a command's exit status: a child ran and exited
/// non-zero. A program that could not start (126, 127) is not one: it has a
/// diagnostic of its own to give.
pub fn is_command_status(e: &Error) -> bool {
  matches!(e, Error::ProcessExit { status: Some(_), .. })
}

fn render_cli_error(e: &Error) -> String {
  if let Some(text) = e.to_shape().as_ref().and_then(cli_shape_text) {
    return text;
  }
  format!("{} {e:#}", Style::Red.paint("error:"))
}

fn render_prompt_error(e: &Error, host: &crate::script::LispHost) -> Option<String> {
  if let Some(status) = e
    .process_status()
    .filter(|_| host.shell_last_statement_bash())
  {
    match host.shell_failure_display() {
      crate::script::ShellFailureDisplay::Off => None,
      crate::script::ShellFailureDisplay::Mark => Some(Style::Red.paint("✗")),
      crate::script::ShellFailureDisplay::Status => Some(format!("exit {status}")),
    }
  } else {
    Some(render_cli_error(e))
  }
}

/// User errors (typos, bad args) are fully reported by [`render_cli_error`]
/// on stderr plus the non-zero exit — no logger event, which would only
/// re-render the same failure in the trace idiom. Internal failures
/// (`Error::Other`) still earn the logger's boxed trace pane.
fn log_command_failure(e: &Error) {
  if matches!(e, Error::Other(_)) {
    let trace_ser = serde_json::to_string(&e.to_trace()).expect("trace couldn't serialize");
    error!(exception.trace_json = trace_ser, "Command Failed");
  }
}

/// The `help` command's value, resolved by what `help_arg` names:
/// - bare (`help` / root `--help`) → the app's self-description (`tsh.app/v1`),
///   the SAME record `--help --json` emits raw and the loader/packager read;
/// - an exact command → its `command.doc/v1` leaf;
/// - a namespace prefix (`std`, `std.fs`) → that subtree as `command.index/v1`.
///
/// `argv` is the help invocation (`["help", maybe-name, "--args"?]`). Extracted
/// from the (retired) `exec` so the `help` env native and the CLI share one body.
/// Presentation (a rendered menu vs. raw JSON) is the renderer's concern, never
/// this record's — one record, both surfaces.
pub(crate) fn help_command_value<Info: Clone>(
  scripts: &Scripts<Info>,
  subcommands: &HashMap<String, Box<dyn Callable>>,
  argv: &[String],
) -> crate::Result<Value> {
  let command = argv.iter().find(|a| *a != "--args" && *a != "help");
  let Some(help_arg) = command else {
    // Bare `help` / root `--help` → the app root (`tsh.app/v1`).
    return Ok(manifest_value(scripts, subcommands));
  };
  // `help <cmd>` → that command's `command.doc/v1`.
  if let Some(command) = scripts.commands.find_command(help_arg) {
    return Ok(command.doc_value());
  }
  // The prelude already reflects these ordinary `def`s as alias leaves.
  // Resolve their target for `help echo`, without reserving flags on `echo`.
  if let Some(prelude) = &scripts.prelude {
    if let Some((_, target)) = prelude_alias_defs(prelude)
      .into_iter()
      .find(|(n, _)| n == help_arg)
    {
      if let Some(command) = scripts.commands.find_command(&target) {
        return Ok(command.doc_value());
      }
    }
  }
  // `help <namespace>` → the subtree as `command.index/v1` (e.g. `help std`).
  if let Some(entry) = namespace_entry(&scripts.commands, help_arg) {
    return Ok(entry_value(entry));
  }
  Err(Error::CommandNotFound {
    name: help_arg.clone(),
    suggestion: None,
    available: vec![],
  })
}

/// Resolve a dotted namespace prefix (`std`, `std.fs`) to its subtree as a
/// `command.index/v1` entry, or `None` when no command lives under it. Descends
/// the full command index part-by-part.
fn namespace_entry<Info: Clone>(
  commands: &CommandList<Info>,
  namespace: &str,
) -> Option<crate::reflect::CommandEntry> {
  let index = build_command_index(commands);
  let mut cursor = &index;
  let mut parts = namespace.split('.').peekable();
  while let Some(part) = parts.next() {
    match cursor.entries.get(part)? {
      crate::reflect::CommandEntry::Index(sub) if parts.peek().is_some() => cursor = sub,
      entry if parts.peek().is_none() => return Some(entry.clone()),
      _ => return None,
    }
  }
  None
}

/// A `command.index/v1` over the canonical commands: dotted names
/// (`std.fs.list_dir`) nest into namespace sub-indices, each leaf a
/// `command.doc/v1` from [`CommandMetadata::doc`]. Reuses the per-command
/// descriptor — no separate leaf shaping. Backs namespace help (`help std` →
/// this tree descended to `std`). (Shell-level subcommand groups aren't reflected
/// here yet — deferred.)
pub(crate) fn build_command_index<Info: Clone>(
  commands: &CommandList<Info>,
) -> crate::reflect::CommandIndex {
  let mut root = crate::reflect::CommandIndex::default();
  for name in commands.names() {
    let Some(command) = commands.find_command(&name) else {
      continue;
    };
    let parts: Vec<&str> = name.split('.').collect();
    insert_command_entry(
      &mut root,
      &parts,
      crate::reflect::CommandEntry::Doc(command.doc()),
    );
  }
  root
}

/// Place `entry` at `parts` in the index, creating namespace sub-indices along
/// the way (a leaf already holding a namespace name is left alone).
pub(crate) fn insert_command_entry(
  index: &mut crate::reflect::CommandIndex,
  parts: &[&str],
  entry: crate::reflect::CommandEntry,
) {
  match parts {
    [] => {}
    [last] => {
      index.entries.insert((*last).to_string(), entry);
    }
    [head, rest @ ..] => {
      let child = index.entries.entry((*head).to_string()).or_insert_with(|| {
        crate::reflect::CommandEntry::Index(crate::reflect::CommandIndex::default())
      });
      if let crate::reflect::CommandEntry::Index(sub) = child {
        insert_command_entry(sub, rest, entry);
      }
    }
  }
}

/// Serialize a `CommandEntry` to its tagged wire value (`Null` on the impossible
/// serialize error).
fn entry_value(entry: crate::reflect::CommandEntry) -> Value {
  serde_json::to_value(entry).unwrap_or(Value::Null)
}

/// The session-publishable `command.index/v1` value over a group's commands
/// **plus** its prelude unix-name aliases — the record a completion provider
/// ([`crate::complete::CommandsProvider`]) consumes.
///
/// Built from two sources:
/// - [`build_command_index`] over `scripts.commands` (dotted names nest, each
///   leaf a `command.doc/v1`);
/// - `scripts.prelude`, read with the real Lisp reader: each simple two-symbol
///   `(let name target)` whose `target` is a registered command becomes a flat
///   `command.alias/v1` leaf at the root, its `description` composed as
///   `→ <target>` plus the target's own description when it has one. A `def`
///   that isn't the simple two-symbol shape (lambdas, multi-form defs) or whose
///   target resolves to no command is skipped; a name collision with a real
///   command/namespace leaves the existing entry (real commands win).
///
/// This is a snapshot of the *registered* surface — runtime `def`s and
/// `(@import …)`s are deliberately not reflected here.
pub fn command_index_value<Info: Clone>(scripts: &Scripts<Info>) -> Value {
  let mut index = build_command_index(&scripts.commands);
  if let Some(prelude) = &scripts.prelude {
    for (name, target) in prelude_alias_defs(prelude) {
      let Some(command) = scripts.commands.find_command(&target) else {
        continue;
      };
      if index.entries.contains_key(&name) {
        continue;
      }
      let target_desc = command.description();
      let description = if target_desc.is_empty() {
        format!("→ {target}")
      } else {
        format!("→ {target} — {target_desc}")
      };
      index.entries.insert(
        name.clone(),
        crate::reflect::CommandEntry::Alias(crate::reflect::CommandAlias {
          name,
          target,
          description,
        }),
      );
    }
  }
  entry_value(crate::reflect::CommandEntry::Index(index))
}

/// The simple `(let name target)` and `(use target as: name)` pairs in a
/// prelude source, read with the Lisp reader the script engine uses — never
/// string-matched. Any other form (a lambda `def`, a multi-form body, a bare
/// `use`) is skipped: aliases are exactly the prelude's named command words. A parse failure yields no pairs
/// (the prelude eval path reports it; reflection just goes without).
fn prelude_alias_defs(source: &str) -> Vec<(String, String)> {
  use string_interner::{StringInterner, backend::StringBackend};
  use tento_lisp::{Literal, SExpression};
  let mut interner = StringInterner::<StringBackend>::new();
  let forms = match tento_lisp::Runtime::<crate::script::Sym, StringBackend>::parse(
    None,
    source,
    &mut interner,
  ) {
    Ok(forms) => forms,
    Err(e) => {
      tracing::warn!(error = ?e, "prelude parse failed; no alias entries reflected");
      return Vec::new();
    }
  };
  let mut out = Vec::new();
  for form in forms {
    let SExpression::List(items) = form else {
      continue;
    };
    let symbols: Option<Vec<&str>> = items
      .iter()
      .map(|item| match item {
        SExpression::Literal(Literal::Symbol(sym)) => interner.resolve(*sym),
        _ => None,
      })
      .collect();
    let Some(symbols) = symbols else { continue };
    // `(let name target)`, or R7's `(use target as: name)` / `(use target as:name)`.
    let pair = match symbols.as_slice() {
      ["let", name, target] => Some((*name, *target)),
      ["use", target, "as:", name] => Some((*name, *target)),
      ["use", target, key] => key.strip_prefix("as:").filter(|name| !name.is_empty()).map(|name| (name, *target)),
      _ => None,
    };
    if let Some((name, target)) = pair {
      out.push((name.to_string(), target.to_string()));
    }
  }
  out
}

/// The app's self-describing spec as a `tsh.app/v1` record — what bare `help` /
/// root `--help [--json]` returns and the `tento-app` loader/packager read (no
/// translation layer; this retired the bespoke `__manifest` subcommand). `commands` is a
/// **flat** map of full command names (`std.fs.list_dir`) to their
/// `command.doc/v1`, so the loader dispatches by name and reads each entry's
/// `description`. (Shell-level subcommand groups — empty for a packaged bundle —
/// aren't reflected here yet; deferred, like the reflection index.)
pub(crate) fn manifest_value<Info: Clone>(
  scripts: &Scripts<Info>,
  subcommands: &HashMap<String, Box<dyn Callable>>,
) -> Value {
  let mut app = crate::reflect::AppSelfDoc::new(scripts.transport.as_str());
  app.name = scripts.app_name.clone();
  app.version = scripts.app_version.clone();
  app.entrypoint = scripts.app_entrypoint.clone();
  if let Some(daemon) = &scripts.daemon {
    app.daemon = Some(crate::reflect::DaemonDoc {
      socket: daemon.socket.clone(),
      start: daemon.start.clone(),
      scope: daemon.scope.clone(),
    });
  }
  // The declared CAPABILITIES, verbatim from the builder. This is the whole
  // authority chain: the group crate says it here, `--help --json` says it on
  // the wire, and the packager copies that into `manifest.json` — so a mounted
  // bundle's provides are always the running binary's own claim. Only the ROOT
  // group's provides are reflected; a nested subcommand group is a namespace
  // inside one app, not an app of its own.
  app.provides = scripts.provides.clone();
  // The declared SERVICES, same chain and same root-only rule: a supervisor
  // reads them off the installed manifest to know what it may bring up, without
  // spawning the binary to ask.
  app.services = scripts.services.clone();
  // Per-command transport overrides (flat: `"ns sub cmd"` → transport, joined
  // exactly how the mounting tsh joins `argv`), so a shape-returning command
  // routes oneshot (the host renders the shape) even in an otherwise-streaming
  // bundle. Built from the `Scripts` tree (real mount + command names), not the
  // dotted help tree (whose keys can't be unambiguously re-split into argv).
  for (path, t) in scripts.command_transports(&[]) {
    app.transports.insert(path, t);
  }
  for (ns, sub) in subcommands {
    for (path, t) in sub.command_transports(std::slice::from_ref(ns)) {
      app.transports.insert(path, t);
    }
  }
  for name in scripts.commands.names() {
    if let Some(command) = scripts.commands.find_command(&name) {
      app.commands.insert(
        name.clone(),
        crate::reflect::CommandEntry::Doc(command.doc()),
      );
    }
  }
  serde_json::to_value(app).unwrap_or(Value::Null)
}

/// Build the structured `CommandNotFound` for `typed` against this command
/// set — the TUI host's unknown-command pre-check uses it to produce a
/// nearest-match suggestion + available list (and, via `Error::to_shape`, a
/// `sections/v1` block) instead of the env's bare "undefined symbol" error.
pub fn command_not_found<Info: Clone>(
  typed: &str,
  commands: &CommandList<Info>,
  subcommands: &HashMap<String, Box<dyn Callable>>,
) -> Error {
  let suggestion = nearest_command(typed, commands, subcommands);
  let mut available: Vec<String> = commands.names();
  for (_original, normalized) in normalize_subcommand_names(subcommands.keys().cloned().collect()) {
    available.push(normalized);
  }
  available.sort();
  Error::CommandNotFound {
    name: typed.to_string(),
    suggestion,
    available,
  }
}

/// Find a known command name within Levenshtein distance of `typed`.
/// Exposed so hosts (e.g. `tento-sh-tui`) can pre-check unknown
/// commands without going through `exec` and avoid materializing a
/// `shell.exec` span for input that never ran.
pub fn nearest_command<Info: Clone>(
  typed: &str,
  commands: &CommandList<Info>,
  subcommands: &HashMap<String, Box<dyn Callable>>,
) -> Option<String> {
  let mut candidates: Vec<String> = commands.names();
  // Include normalized subcommand names so `acme-admin` gets compared
  // as `acme.admin` (the form the user would actually type).
  for (_original, normalized) in normalize_subcommand_names(subcommands.keys().cloned().collect()) {
    candidates.push(normalized);
  }
  nearest_match(typed, &candidates)
}

/// Pick the candidate with the smallest case-insensitive Levenshtein
/// distance to `typed`, gated by a per-candidate threshold of
/// `(len / 3).max(2)`: generous for short names; tight enough that
/// totally-unknown input gets `None` instead of a misleading
/// suggestion.
///
/// Used by `nearest_command` for unknown-command suggestions and by
/// `tento_fleet_console::node::dispatch` for unknown-flag suggestions
/// against an `OpSpec.params`.
pub fn nearest_match(typed: &str, candidates: &[String]) -> Option<String> {
  let typed_lower = typed.to_lowercase();
  let mut best: Option<(usize, String)> = None;
  for cand in candidates {
    let dist = levenshtein(&typed_lower, &cand.to_lowercase());
    let threshold = (cand.chars().count() / 3).max(2);
    if dist > threshold {
      continue;
    }
    if best.as_ref().is_none_or(|(d, _)| dist < *d) {
      best = Some((dist, cand.clone()));
    }
  }
  best.map(|(_, name)| name)
}

/// Classic two-row Levenshtein edit distance. Compares by `char` so
/// non-ASCII command names (none today; future-proofing) work
/// correctly.
fn levenshtein(a: &str, b: &str) -> usize {
  let a: Vec<char> = a.chars().collect();
  let b: Vec<char> = b.chars().collect();
  if a.is_empty() {
    return b.len();
  }
  if b.is_empty() {
    return a.len();
  }
  let mut prev: Vec<usize> = (0..=b.len()).collect();
  let mut curr: Vec<usize> = vec![0; b.len() + 1];
  for (i, ca) in a.iter().enumerate() {
    curr[0] = i + 1;
    for (j, cb) in b.iter().enumerate() {
      let cost = if ca == cb { 0 } else { 1 };
      curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
    }
    std::mem::swap(&mut prev, &mut curr);
  }
  prev[b.len()]
}

/// Structured help value for the root command list + subcommand
/// namespaces. Produces ONE merged tree nested by `.`-segments so the
/// TUI's TracePane (or any other consumer) can navigate it as a real
/// hierarchy:
///
/// - Each command's dotted name is split into segments; segments become
///   nested object keys.
/// - Leaves carry `{description, args?}` — `args` is omitted when the
///   command has none.
/// - Single-child internal nodes are fused with their sole child
///   (`fleet.healthd.install` lands as `healthd.install` *inside* the
///   `fleet` group rather than `healthd > install`).
/// - Subcommand namespaces (`deploy`, `acme-admin`, …) appear as
///   top-level placeholder groups. Their internal commands aren't
///   enumerable through `Callable` yet — that's a follow-up; for now
///   the slot exists so users see the namespace at the right scope.
pub(crate) fn build_help_value<Info: Clone>(
  commands: &CommandList<Info>,
  subcommands: &HashMap<String, Box<dyn Callable>>,
  _include_args: bool,
) -> Value {
  // Always include args; visibility is the TUI's job (collapsed by
  // default at the leaf level — they reveal on expand).
  let mut root = serde_json::Map::new();
  for name in commands.names() {
    let Some(command) = commands.find_command(&name) else {
      continue;
    };
    insert_dotted(&mut root, &name, command_leaf_value(command.as_ref()));
  }
  collapse_single_child_chains(&mut root);
  // Surface subcommand namespaces as nested groups: dotted names
  // (e.g. `acme.fleet`, `acme.user.garmin`) nest under their
  // namespace; hyphenated names that share a dotted namespace prefix
  // (e.g. `acme-admin` → `acme.admin`) get normalized first so they
  // join the same group. Each callable's own `help_value()` is
  // spliced in at the leaf segment, so a nested `Scripts<T>` recurses
  // and surfaces its own commands + subcommands.
  let sub_names = normalize_subcommand_names(subcommands.keys().cloned().collect());
  for (original, normalized) in &sub_names {
    let tree = subcommands
      .get(original)
      .map(|c| c.help_value())
      .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    insert_dotted_with_value(&mut root, normalized, tree);
  }
  // Prefix every non-top-level key with `.` so concatenating the
  // visible names from root down recovers the original command name
  // (e.g. `acme` + `.user` + `.garmin` = `acme.user.garmin`). The
  // leading dot is purely the join character; top-level keys retain
  // their full form (`admin.spend.report`, `deploy`, etc.).
  prefix_nested_keys_with_dot(&mut root);
  Value::Object(root)
}

/// One leaf in the help tree: `{description, args?, _open?}`.
///
/// - `args` is a single comma-joined String (or omitted when the
///   command takes none). The fold's inline-description path then
///   renders it as a one-line child (`args: --foo, --bar, …`)
///   instead of a multi-line subtree.
/// - `_open: false` is stamped on leaves that carry args so the
///   TracePane keeps them collapsed by default; toggling the leaf
///   reveals the inline args row.
fn command_leaf_value<Info: Clone>(
  command: &dyn crate::command_metadata::CommandMetadata<Info>,
) -> Value {
  let mut obj = serde_json::Map::new();
  obj.insert(
    "description".to_string(),
    Value::String(command.description().to_string()),
  );
  let args: Vec<String> = command
    .help()
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect();
  if !args.is_empty() {
    obj.insert("args".to_string(), Value::String(args.join(", ")));
    obj.insert("_open".to_string(), Value::Bool(false));
  }
  Value::Object(obj)
}

/// Walk `name`'s dot-separated segments and place `value` at the
/// terminal node. If the terminal slot is already a non-empty Object,
/// MERGE — `value`'s keys are folded in alongside whatever's there
/// (this lets a `acme.fleet` subcommand expand its own subcommands at
/// `acme.fleet`'s slot without obliterating siblings inserted earlier
/// by a different code path). If `value` itself isn't an Object (rare,
/// shouldn't happen for `help_value` outputs), it overwrites.
fn insert_dotted_with_value(root: &mut serde_json::Map<String, Value>, name: &str, value: Value) {
  let segments: Vec<&str> = name.split('.').collect();
  let mut current = root;
  for (i, seg) in segments.iter().enumerate() {
    if i == segments.len() - 1 {
      let slot = current
        .entry(seg.to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
      match (slot, value) {
        (Value::Object(existing), Value::Object(incoming)) => {
          for (k, v) in incoming {
            existing.insert(k, v);
          }
        }
        (slot, v) => {
          *slot = v;
        }
      }
      return;
    }
    let entry = current
      .entry(seg.to_string())
      .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Value::Object(obj) = entry else {
      return;
    };
    current = obj;
  }
}

/// Prepend `.` to every non-top-level key in the help-tree JSON. The
/// dot is the join character — concatenating the visible names from
/// root down recovers the original command name (e.g. `acme` +
/// `.user` + `.garmin` = `acme.user.garmin`).
///
/// Top-level keys keep their plain form. The walk is post-order +
/// idempotent (keys already starting with `.` are left alone).
fn prefix_nested_keys_with_dot(map: &mut serde_json::Map<String, Value>) {
  // First, descend into each top-level child and dot-prefix
  // everything inside them. Top-level keys themselves are NOT
  // renamed.
  let top_keys: Vec<String> = map.keys().cloned().collect();
  for top in &top_keys {
    if let Some(Value::Object(child)) = map.get_mut(top) {
      dot_prefix_subtree(child);
    }
  }
}

/// Recursive helper: rename every key in `map` to `.<key>` (if not
/// already prefixed), and recurse into Object values FIRST so deeper
/// levels are transformed before their parents.
///
/// Stop at leaf records — `command_leaf_value` emits these with a
/// `description` field, and their internal keys (`description`,
/// `args`, `_open`) are reserved metadata the fold handles specially,
/// NOT command-name segments. Renaming them would break the
/// inline-description path and the `_open` collapse hint.
fn dot_prefix_subtree(map: &mut serde_json::Map<String, Value>) {
  if map.contains_key("description") {
    return;
  }
  let keys: Vec<String> = map.keys().cloned().collect();
  for k in &keys {
    if let Some(Value::Object(sub)) = map.get_mut(k) {
      dot_prefix_subtree(sub);
    }
  }
  let renames: Vec<(String, String)> = keys
    .iter()
    .filter(|k| !k.starts_with('.'))
    .map(|k| (k.clone(), format!(".{k}")))
    .collect();
  for (old, new) in renames {
    if let Some(val) = map.remove(&old) {
      map.insert(new, val);
    }
  }
}

/// Normalize a list of subcommand names so hyphenated names whose
/// pre-hyphen prefix matches an existing dotted-subcommand namespace
/// (e.g. `acme-admin` when `acme.fleet` / `acme.user` exist) get
/// rewritten to dot-joined form (`acme.admin`). Standalone hyphenated
/// names (no matching namespace) are left alone, so command groups
/// like `ux-test` aren't accidentally split.
/// Returns `(original, normalized)` pairs. The `original` is the
/// `subcommands` map key the caller looks up to invoke / introspect
/// the callable; the `normalized` is the display name that nests into
/// the help tree (so `acme-admin` shows up under `acme` when the
/// `acme.*` namespace exists).
fn normalize_subcommand_names(names: Vec<String>) -> Vec<(String, String)> {
  let namespaces: std::collections::HashSet<String> = names
    .iter()
    .filter_map(|n| n.split_once('.').map(|(prefix, _)| prefix.to_string()))
    .collect();
  let mut out: Vec<(String, String)> = names
    .into_iter()
    .map(|n| {
      let normalized = if let Some((prefix, rest)) = n.split_once('-') {
        if namespaces.contains(prefix) {
          format!("{prefix}.{rest}")
        } else {
          n.clone()
        }
      } else {
        n.clone()
      };
      (n, normalized)
    })
    .collect();
  out.sort_by(|a, b| a.1.cmp(&b.1));
  out
}

/// Walk `name`'s dot-separated segments and insert `payload` at the
/// terminal node, creating intermediate Object groups as needed.
fn insert_dotted(root: &mut serde_json::Map<String, Value>, name: &str, payload: Value) {
  let segments: Vec<&str> = name.split('.').collect();
  let mut current = root;
  for (i, seg) in segments.iter().enumerate() {
    if i == segments.len() - 1 {
      current.insert(seg.to_string(), payload);
      return;
    }
    let entry = current
      .entry(seg.to_string())
      .or_insert_with(|| Value::Object(serde_json::Map::new()));
    // If a previous insert left a non-Object here, we can't nest under
    // it. This shouldn't happen with a disjoint command set, but bail
    // cleanly rather than panicking.
    let Value::Object(obj) = entry else {
      return;
    };
    current = obj;
  }
}

/// Bottom-up: for every Object whose value has exactly one Object
/// child, fuse the parent's key with the child's. Repeats so chains
/// (e.g. `a > b > c (leaf)`) collapse to `a.b.c (leaf)` at the
/// grandparent level.
fn collapse_single_child_chains(map: &mut serde_json::Map<String, Value>) {
  let keys: Vec<String> = map.keys().cloned().collect();
  for key in &keys {
    if let Some(Value::Object(sub)) = map.get_mut(key) {
      collapse_single_child_chains(sub);
    }
  }
  // Single pass over this level — after children are collapsed, look
  // for any single-Object-child group and fuse it.
  let mut fusions: Vec<(String, String, Value)> = Vec::new();
  for key in &keys {
    if let Some(Value::Object(sub)) = map.get(key) {
      if sub.len() == 1 {
        let (child_key, child_val) = sub.iter().next().unwrap();
        if matches!(child_val, Value::Object(_)) {
          fusions.push((key.clone(), child_key.clone(), child_val.clone()));
        }
      }
    }
  }
  for (old_key, child_key, child_val) in fusions {
    map.remove(&old_key);
    map.insert(format!("{old_key}.{child_key}"), child_val);
  }
}

/// Pick the `.tsh` script path out of argv, returning the
/// `(prefix, path)` pair when found. Recognises:
/// - `<bin> foo.tsh`                       → `([], "foo.tsh")`
/// - `<bin> --script <path>`               → `([], path)`
/// - `<bin> sub1 [sub2 …] foo.tsh`         → `([sub1, …], "foo.tsh")`
///
/// In the nested form the prefix is the chain of subcommand
/// namespaces that precede the script path. `run_script` prepends
/// the prefix to every command line so commands inside the `.tsh`
/// resolve against the correct nested `Scripts`.
fn detect_script_path(argv: &[String]) -> Option<(Vec<String>, String)> {
  // `--script <path>` form short-circuits — the prefix is the args
  // before `--script`, the path is the arg after.
  let mut idx = 0;
  while idx < argv.len() {
    if argv[idx] == "--script" && idx + 1 < argv.len() {
      let prefix = argv[..idx].to_vec();
      return Some((prefix, argv[idx + 1].clone()));
    }
    idx += 1;
  }

  // Positional form — first arg ending in `.tsh` that exists on disk.
  for (i, a) in argv.iter().enumerate() {
    if a.ends_with(".tsh") && std::path::Path::new(a).is_file() {
      return Some((argv[..i].to_vec(), a.clone()));
    }
  }
  None
}

pub fn print_help<Info: Clone>(
  commands: &CommandList<Info>,
  subcommands: &HashMap<String, Box<dyn Callable>>,
  include_args: bool,
) {
  println!("\nUsage: [name] [command]\n");
  println!("Commands:");
  commands.print_help(0, include_args);
  for (subcommand_name, subcommand) in subcommands {
    println!("    {}", subcommand_name.bold());
    subcommand.print_help(include_args);
  }
  println!("");
}

#[cfg(test)]
mod help_value_tests {
  use super::*;
  use serde_json::json;

  fn leaf(desc: &str) -> Value {
    json!({ "description": desc })
  }

  #[test]
  fn insert_dotted_creates_nested_groups() {
    let mut root = serde_json::Map::new();
    insert_dotted(&mut root, "a", leaf("alpha"));
    insert_dotted(&mut root, "b.c", leaf("bc"));
    insert_dotted(&mut root, "b.d.e", leaf("bde"));
    insert_dotted(&mut root, "b.d.f", leaf("bdf"));

    let v = Value::Object(root);
    assert_eq!(v["a"]["description"], json!("alpha"));
    assert_eq!(v["b"]["c"]["description"], json!("bc"));
    assert_eq!(v["b"]["d"]["e"]["description"], json!("bde"));
    assert_eq!(v["b"]["d"]["f"]["description"], json!("bdf"));
  }

  #[test]
  fn collapse_fuses_single_child_chains_only() {
    let mut root = serde_json::Map::new();
    insert_dotted(&mut root, "b.c", leaf("bc"));
    insert_dotted(&mut root, "b.d.e", leaf("bde"));
    insert_dotted(&mut root, "b.d.f", leaf("bdf"));
    collapse_single_child_chains(&mut root);

    let b = root.get("b").expect("b must exist").as_object().unwrap();
    assert!(
      b.contains_key("c"),
      "b.c should appear inside b (b has 2 children)"
    );
    assert_eq!(b["c"]["description"], json!("bc"));
    let d = b.get("d").expect("d must exist").as_object().unwrap();
    assert!(d.contains_key("e"));
    assert!(d.contains_key("f"));
  }

  #[test]
  fn insert_dotted_with_value_empty_does_not_overwrite_existing_group() {
    let mut root = serde_json::Map::new();
    insert_dotted(&mut root, "acme.user.garmin", leaf("garmin"));
    insert_dotted(&mut root, "acme.user.whoop", leaf("whoop"));
    insert_dotted_with_value(
      &mut root,
      "acme.user",
      Value::Object(serde_json::Map::new()),
    );

    let user = root["acme"]["user"].as_object().unwrap();
    assert!(
      user.contains_key("garmin") && user.contains_key("whoop"),
      "placeholder for `acme.user` must not wipe its existing children; got {:?}",
      user.keys().collect::<Vec<_>>()
    );
  }

  #[test]
  fn insert_dotted_with_value_empty_creates_intermediates_and_terminal_empty() {
    let mut root = serde_json::Map::new();
    insert_dotted_with_value(
      &mut root,
      "acme.fleet",
      Value::Object(serde_json::Map::new()),
    );
    assert!(root["acme"]["fleet"].is_object());
    assert!(root["acme"]["fleet"].as_object().unwrap().is_empty());
  }

  #[test]
  fn normalize_subcommand_names_dots_hyphenated_with_matching_namespace() {
    let input = vec![
      "acme-admin".to_string(),
      "acme-sdk".to_string(),
      "acme.fleet".to_string(),
      "acme.user".to_string(),
      "deploy".to_string(),
      "ux-test".to_string(), // no `ux.` namespace, must stay as-is
    ];
    let out = normalize_subcommand_names(input);
    let normalized: Vec<&str> = out.iter().map(|(_, n)| n.as_str()).collect();
    let originals: Vec<&str> = out.iter().map(|(o, _)| o.as_str()).collect();
    assert!(
      normalized.contains(&"acme.admin"),
      "acme-admin → acme.admin"
    );
    assert!(normalized.contains(&"acme.sdk"), "acme-sdk → acme.sdk");
    assert!(normalized.contains(&"acme.fleet"));
    assert!(normalized.contains(&"acme.user"));
    assert!(normalized.contains(&"deploy"));
    assert!(
      normalized.contains(&"ux-test"),
      "ux-test has no matching dotted namespace → stays hyphenated"
    );
    // The original key is preserved alongside so callers can look up
    // the callable for the renamed namespace.
    assert!(originals.contains(&"acme-admin"));
    assert!(originals.contains(&"acme-sdk"));
  }

  #[test]
  fn prefix_nested_keys_dots_children_not_top_level() {
    let mut root = serde_json::Map::new();
    // Build a representative tree: top-level fused leaf, top-level
    // empty subcommand, a group with leaves, and a deeply-nested
    // group (acme → user → garmin/whoop).
    root.insert("admin.spend.report".to_string(), leaf("spend"));
    root.insert("deploy".to_string(), Value::Object(serde_json::Map::new()));
    let mut dev = serde_json::Map::new();
    dev.insert("calculator".to_string(), leaf("calc"));
    dev.insert("vscode.enable-paths".to_string(), leaf("paths"));
    root.insert("dev".to_string(), Value::Object(dev));
    insert_dotted_with_value(
      &mut root,
      "acme.user.garmin",
      Value::Object(serde_json::Map::new()),
    );
    insert_dotted_with_value(
      &mut root,
      "acme.user.whoop",
      Value::Object(serde_json::Map::new()),
    );

    prefix_nested_keys_with_dot(&mut root);

    // Top-level keys are untouched.
    assert!(root.contains_key("admin.spend.report"));
    assert!(root.contains_key("deploy"));
    assert!(root.contains_key("dev"));
    assert!(root.contains_key("acme"));
    assert!(!root.contains_key(".dev") && !root.contains_key(".acme"));

    // Children of `dev` get the dot prefix.
    let dev = root["dev"].as_object().unwrap();
    assert!(dev.contains_key(".calculator"));
    assert!(dev.contains_key(".vscode.enable-paths"));
    assert!(!dev.contains_key("calculator"));

    // Children + grandchildren under `acme`.
    let acme = root["acme"].as_object().unwrap();
    assert!(acme.contains_key(".user"));
    let user = acme[".user"].as_object().unwrap();
    assert!(user.contains_key(".garmin"));
    assert!(user.contains_key(".whoop"));
  }

  #[test]
  fn prefix_nested_keys_is_idempotent() {
    let mut root = serde_json::Map::new();
    insert_dotted_with_value(
      &mut root,
      "acme.user.garmin",
      Value::Object(serde_json::Map::new()),
    );
    prefix_nested_keys_with_dot(&mut root);
    let once = root.clone();
    prefix_nested_keys_with_dot(&mut root);
    assert_eq!(
      serde_json::Value::Object(root),
      serde_json::Value::Object(once),
      "running prefix_nested_keys_with_dot twice should be a no-op"
    );
  }

  #[test]
  fn prefix_nested_keys_does_not_dot_inside_leaf_records() {
    // A leaf record (the shape `command_leaf_value` emits) carries
    // `{description, args, _open}` — all reserved metadata. The
    // dot-prefix pass must NOT touch those keys, only the leaf's own
    // key as set by the parent.
    let mut root = serde_json::Map::new();
    let mut fleet = serde_json::Map::new();
    let mut leaf = serde_json::Map::new();
    leaf.insert(
      "description".to_string(),
      Value::String("Install daemon".to_string()),
    );
    leaf.insert(
      "args".to_string(),
      Value::String("--target: Option<String>".to_string()),
    );
    leaf.insert("_open".to_string(), Value::Bool(false));
    fleet.insert("healthd.install".to_string(), Value::Object(leaf));
    root.insert("fleet".to_string(), Value::Object(fleet));

    prefix_nested_keys_with_dot(&mut root);

    // Top-level `fleet` unchanged; leaf's KEY dotted.
    assert!(root.contains_key("fleet"));
    let fleet = root["fleet"].as_object().unwrap();
    assert!(fleet.contains_key(".healthd.install"));
    assert!(!fleet.contains_key("healthd.install"));

    // Inside the leaf, metadata keys are UNTOUCHED.
    let leaf = fleet[".healthd.install"].as_object().unwrap();
    assert!(leaf.contains_key("description"));
    assert!(leaf.contains_key("args"));
    assert!(leaf.contains_key("_open"));
    assert!(!leaf.contains_key(".description"));
    assert!(!leaf.contains_key(".args"));
    assert!(!leaf.contains_key("._open"));
  }

  #[test]
  fn prefix_nested_keys_leaves_top_level_fused_keys_alone() {
    let mut root = serde_json::Map::new();
    root.insert("admin.spend.report".to_string(), leaf("spend"));
    prefix_nested_keys_with_dot(&mut root);
    assert!(root.contains_key("admin.spend.report"));
    assert!(!root.contains_key(".admin.spend.report"));
  }

  #[test]
  fn collapse_deep_chain_fuses_under_parent() {
    let mut root = serde_json::Map::new();
    insert_dotted(&mut root, "fleet.healthd.install", leaf("install"));
    insert_dotted(&mut root, "fleet.mount.ws", leaf("mount"));
    insert_dotted(&mut root, "fleet.postgres.backup.run.local", leaf("br"));
    insert_dotted(&mut root, "fleet.postgres.backup.check.local", leaf("bc"));
    collapse_single_child_chains(&mut root);

    let fleet = root.get("fleet").unwrap().as_object().unwrap();
    assert!(
      fleet.contains_key("healthd.install"),
      "single-child healthd should fuse with its install leaf, got keys={:?}",
      fleet.keys().collect::<Vec<_>>()
    );
    assert!(fleet.contains_key("mount.ws"));
    // postgres has only one direct child (backup) → fleet sees
    // "postgres.backup" as the key.
    let pb = fleet
      .get("postgres.backup")
      .expect("postgres collapses with backup")
      .as_object()
      .unwrap();
    assert!(pb.contains_key("run.local"));
    assert!(pb.contains_key("check.local"));
  }

  // ---- nearest-match suggestion on unknown command ----

  fn names() -> Vec<String> {
    vec![
      "acme.fleet".to_string(),
      "acme.releases".to_string(),
      "acme.admin".to_string(),
      "deploy".to_string(),
      "ssh.sync".to_string(),
      "ux-test".to_string(),
    ]
  }

  #[test]
  fn levenshtein_canonical() {
    assert_eq!(levenshtein("kitten", "sitting"), 3);
    assert_eq!(levenshtein("abc", "abc"), 0);
    assert_eq!(levenshtein("", "abc"), 3);
    assert_eq!(levenshtein("abc", ""), 3);
    assert_eq!(levenshtein("flaw", "lawn"), 2);
  }

  #[test]
  fn nearest_suggests_single_edit_typo() {
    // single-char drop within `acme.fleet` → matches it.
    assert_eq!(
      nearest_match("acme.flet", &names()),
      Some("acme.fleet".to_string()),
    );
  }

  #[test]
  fn nearest_suggests_transposition() {
    // One adjacent transposition remains within the suggestion threshold.
    assert_eq!(
      nearest_match("acem.fleet", &names()),
      Some("acme.fleet".to_string()),
    );
  }

  #[test]
  fn nearest_no_suggestion_for_alien_input() {
    // Nothing within threshold.
    assert!(nearest_match("asdfqwer", &names()).is_none());
  }

  #[test]
  fn nearest_no_suggestion_for_short_random_input() {
    // 2-char typed against 10-char candidates → distance >>
    // threshold; no spurious match.
    assert!(nearest_match("lo", &names()).is_none());
  }

  #[test]
  fn nearest_prefers_closest() {
    // `acme.adim` is 2 edits from `acme.admin` (the closest) and
    // farther from `acme.fleet` or `acme.releases`. Threshold for
    // 10-char candidate is 3 → admin wins.
    assert_eq!(
      nearest_match("acme.adim", &names()),
      Some("acme.admin".to_string()),
    );
  }

  #[test]
  fn nearest_case_insensitive() {
    assert_eq!(
      nearest_match("ACME.FLEET", &names()),
      Some("acme.fleet".to_string()),
    );
  }
}

#[cfg(test)]
mod cli_shape_tests {
  use super::*;
  use serde_json::json;

  /// argv.md D2a: at the prompt a definition is refused (status 1) and bare
  /// `alias` lists nothing; a script records and lists, as bash does.
  #[tokio::test]
  async fn alias_is_refused_at_the_prompt_and_recorded_in_a_script() {
    let mut host = crate::script::LispHost::new();
    let _ = host.eval_prompt_source_async("alias ll='ls -la'").await;
    assert_eq!(host.shell_status(), 1, "a definition is a loud failure at the prompt");
    let _ = host.eval_prompt_source_async("alias").await;
    assert_eq!(host.shell_status(), 0, "bare alias lists nothing and succeeds");
    let mut script = crate::script::LispHost::new();
    let captured = script.capture_shell_source("alias ll='ls -la'; alias").await.unwrap();
    assert_eq!(String::from_utf8_lossy(&captured.stdout), "alias ll='ls -la'\n");
  }

  /// argv.md I14: a command that ran and failed is only its status; a program
  /// that could not start, and tsh's own errors, keep their line.
  #[test]
  fn a_failed_command_is_a_status_and_nothing_else() {
    let exited = Error::ProcessExit { status: Some(3), signal: None, detail: "exit status 3".into() };
    assert!(is_command_status(&exited));
    let missing = Error::ProcessStart { status: 127, detail: "nope: not found".into() };
    assert!(!is_command_status(&missing));
    assert!(!is_command_status(&Error::Other(anyhow::anyhow!("tsh's own error"))));
    let killed = Error::ProcessExit { status: None, signal: Some(9), detail: "killed".into() };
    assert!(!is_command_status(&killed), "a signal says so");
  }

  #[tokio::test]
  async fn prompt_failure_display_changes_only_rendered_text() {
    let mut host = crate::script::LispHost::new();
    for mode in ["off", "mark", "status"] {
      host
        .eval_stmt(&format!("(tsh.failure-display \"{mode}\")"))
        .unwrap();
      let error = host.eval_prompt_source_async("false").await.unwrap_err();
      assert_eq!(error.process_status(), Some(1), "{mode}");
      let rendered = render_prompt_error(&error, &host);
      match mode {
        "off" => assert!(rendered.is_none()),
        "mark" => {
          let rendered = rendered.unwrap();
          assert!(rendered.contains('✗'));
          assert!(!rendered.contains("exit"));
        }
        "status" => assert_eq!(rendered.as_deref(), Some("exit 1")),
        _ => unreachable!(),
      }
    }
    host.eval_stmt("(tsh.failure-display \"off\")").unwrap();
    let error = Error::Other(anyhow::anyhow!("fixture Lisp error"));
    assert!(
      render_prompt_error(&error, &host)
        .unwrap()
        .contains("fixture Lisp error")
    );
  }

  #[test]
  fn inline_table_renders_to_text() {
    let value = json!({
      "shape": "table/v1",
      "columns": [{"header": "STATUS"}, {"header": "AGE"}],
      "rows": [[{"text": "success", "style": "green"}, "2h"]],
    });
    let text = cli_shape_text(&value).expect("inline table/v1 renders");
    // Headers (and the lone row) survive at any width — a 2-column table this
    // narrow never demotes.
    assert!(text.contains("STATUS"), "header present: {text:?}");
    assert!(text.contains("AGE"), "header present: {text:?}");
    assert!(text.contains("2h"), "row present: {text:?}");
  }

  #[test]
  fn sections_render_titled_tables() {
    let value = json!({
      "shape": "sections/v1",
      "sections": [
        { "title": "Zone X", "value": {
          "shape": "table/v1",
          "columns": [{"header": "STDOFF"}],
          "rows": [["-8:00"]],
        }},
        { "title": "Notes", "value": "plain text" },
      ],
    });
    let text = cli_shape_text(&value).expect("sections/v1 renders");
    assert!(text.contains("Zone X"), "section title present: {text:?}");
    assert!(text.contains("-8:00"), "table row present: {text:?}");
    assert!(
      text.contains("plain text"),
      "text section present: {text:?}"
    );
  }

  #[test]
  fn dead_source_alias_degrades_to_a_diagnostic_line() {
    // The CLI resolves `source` aliases now; an unresolvable one renders a
    // single diagnostic line rather than printing nothing.
    let value = json!({
      "shape": "table/v1",
      "source": {"kind": "file", "path": "/nonexistent/x.ljson"},
    });
    let text = cli_shape_text(&value).expect("aliased table/v1 dispatches");
    assert!(text.contains("unresolved"), "{text:?}");
  }

  #[test]
  fn non_shape_value_prints_nothing() {
    assert!(cli_shape_text(&json!({"some": "object"})).is_none());
    assert!(cli_shape_text(&Value::Null).is_none());
    assert!(cli_shape_text(&json!("just a string")).is_none());
  }

  /// The plugin case. A bundle command that returns a plain object — no shape,
  /// no datatype — must have its VALUES rendered, not just its keys. This is
  /// the regression that made `{"greeting": "hello, Ada"}` print as `greeting`.
  #[test]
  fn an_untagged_record_renders_its_values() {
    let text = format_cli_value(&json!({"greeting": "hello, Ada"}), None)
      .expect("an untagged record renders");
    assert!(text.contains("greeting"), "got: {text:?}");
    assert!(text.contains("hello, Ada"), "the VALUE survives: {text:?}");
  }

  /// A record whose values are not all scalars cannot be aligned into `kv/v1`
  /// lines, so it pretty-prints instead — still lossless, which is the bar.
  #[test]
  fn a_nested_record_pretty_prints_rather_than_flattening() {
    let value = json!({"datatype": "weather.forecast/v1", "records": [{"day": "Mon"}]});
    let text = format_cli_value(&value, None).expect("a nested record renders");
    assert!(text.contains("weather.forecast/v1"), "got: {text:?}");
    assert!(text.contains("Mon"), "nested data survives: {text:?}");
  }

  /// And the arm this one displaced still works: a command menu keeps its
  /// `name  description` listing.
  #[test]
  fn a_command_menu_still_lists_names_and_descriptions() {
    let value = json!({
      "ls": {"description": "list a directory"},
      "cat": {"description": "print a file"},
    });
    let text = format_cli_value(&value, None).expect("a menu renders");
    assert!(text.contains("ls"), "got: {text:?}");
    assert!(text.contains("list a directory"), "got: {text:?}");
  }

  /// The discrimination itself: an object of objects that carries no
  /// description is DATA, not a menu, and must keep its values.
  #[test]
  fn an_object_of_objects_without_descriptions_is_not_a_menu() {
    assert!(!is_command_menu(
      json!({"a": {"x": 1}, "b": {"x": 2}}).as_object().unwrap()
    ));
    assert!(is_command_menu(
      json!({"a": {"description": "d"}}).as_object().unwrap()
    ));
    assert!(!is_command_menu(json!({}).as_object().unwrap()));
  }
}

#[cfg(test)]
mod command_index_value_tests {
  use super::*;
  use crate::command_metadata::{CommandMetadataSync, SyncCommand};

  /// A minimal registered command: name + description, trivial body.
  struct FakeCmd {
    name: &'static str,
    description: &'static str,
  }

  impl CommandMetadataSync<()> for FakeCmd {
    fn name(&self) -> &'static str {
      self.name
    }
    fn description(&self) -> &'static str {
      self.description
    }
    fn call_sync(&self, _info: (), _argv: Vec<String>) -> crate::Result<Value> {
      Ok(Value::Null)
    }
  }

  fn scripts_with_prelude(prelude: &str) -> Scripts<()> {
    Scripts::new(())
      .add_command(SyncCommand(FakeCmd {
        name: "std.fs.list_dir",
        description: "list directory entries",
      }))
      .add_command(SyncCommand(FakeCmd {
        name: "session",
        description: "show the session",
      }))
      .with_root_prelude(prelude)
  }

  /// A valid two-symbol `def` becomes a flat `command.alias/v1` leaf with the
  /// composed `→ target — description` detail; a `def` to an unknown target and
  /// a non-simple (lambda) `def` are skipped; commands still nest as docs.
  #[test]
  fn prelude_aliases_reflect_as_alias_leaves() {
    let scripts = scripts_with_prelude(
      "(let ls std.fs.list_dir)\n\
       (let gone std.fs.no_such_command)\n\
       (let fancy (lambda (p) (std.fs.list_dir p)))\n",
    );
    let value = command_index_value(&scripts);
    assert_eq!(value["type"], "command.index/v1");
    // Real commands nest as before.
    assert_eq!(
      value["entries"]["std"]["entries"]["fs"]["entries"]["list_dir"]["type"],
      "command.doc/v1"
    );
    // The simple def is an alias leaf at the root.
    let ls = &value["entries"]["ls"];
    assert_eq!(ls["type"], "command.alias/v1", "got: {value}");
    assert_eq!(ls["name"], "ls");
    assert_eq!(ls["target"], "std.fs.list_dir");
    assert_eq!(
      ls["description"],
      "→ std.fs.list_dir — list directory entries"
    );
    // Unknown-target and non-simple defs are skipped, silently.
    assert!(value["entries"].get("gone").is_none(), "got: {value}");
    assert!(value["entries"].get("fancy").is_none(), "got: {value}");
  }

  /// An alias whose name collides with a real command leaves the command in
  /// place — real commands win.
  #[test]
  fn alias_never_overwrites_a_real_command() {
    let scripts = scripts_with_prelude("(let session std.fs.list_dir)\n");
    let value = command_index_value(&scripts);
    assert_eq!(
      value["entries"]["session"]["type"], "command.doc/v1",
      "the registered command wins: {value}"
    );
    assert_eq!(
      value["entries"]["session"]["description"],
      "show the session"
    );
  }

  /// No prelude → the plain command index (no alias entries, no error).
  #[test]
  fn no_prelude_yields_plain_index() {
    let scripts = Scripts::new(()).add_command(SyncCommand(FakeCmd {
      name: "session",
      description: "show the session",
    }));
    let value = command_index_value(&scripts);
    assert_eq!(value["type"], "command.index/v1");
    assert_eq!(value["entries"]["session"]["type"], "command.doc/v1");
    assert_eq!(value["entries"].as_object().unwrap().len(), 1);
  }
}

#[cfg(test)]
mod manifest_transport_tests {
  use super::*;
  use crate::command_metadata::CommandMetadata;

  // `pub` because the `#[command]` macro emits `pub` items whose signatures
  // mention the args type (E0446 otherwise); the module itself is test-private.
  #[derive(crate::CommandArg, serde::Deserialize, Clone, Debug, Default)]
  pub struct FixtureArgs {
    #[allow(dead_code)]
    limit: Option<usize>,
  }

  /// Fixture with an explicit per-command transport override.
  #[crate::command(
    name = "tail",
    description = "stream a log (fixture)",
    transport = "streaming"
  )]
  async fn tail_fixture(_info: (), _args: Option<FixtureArgs>) -> crate::Result<Value> {
    Ok(Value::Null)
  }

  /// Root-level fixture with a different override.
  #[crate::command(name = "fetch", description = "fetch (fixture)", transport = "oneshot")]
  async fn fetch_fixture(_info: (), _args: Option<FixtureArgs>) -> crate::Result<Value> {
    Ok(Value::Null)
  }

  /// Fixture without the attribute — inherits the bundle transport.
  #[crate::command(name = "show", description = "plain (fixture)")]
  async fn show_fixture(_info: (), _args: Option<FixtureArgs>) -> crate::Result<Value> {
    Ok(Value::Null)
  }

  /// `#[command(transport = "…")]` surfaces through
  /// [`CommandMetadata::transport`]; absent ⇒ `None` (inherit).
  #[test]
  fn transport_attr_surfaces_in_metadata() {
    assert_eq!(
      CommandMetadata::<()>::transport(&tail_fixture),
      Some("streaming")
    );
    assert_eq!(
      CommandMetadata::<()>::transport(&fetch_fixture),
      Some("oneshot")
    );
    assert_eq!(CommandMetadata::<()>::transport(&show_fixture), None);
  }

  fn root_scripts() -> Scripts<()> {
    let logs = Scripts::new(()).add_command(tail_fixture);
    Scripts::new(())
      .add_command(show_fixture)
      .add_command(fetch_fixture)
      .add_subcommand("logs", logs)
  }

  /// The walker emits `"ns sub cmd"` (space-joined, matching how `tsh` joins
  /// argv) for every command with an explicit override — recursing into nested
  /// subcommands — and NOTHING for commands without one.
  #[test]
  fn command_transports_walks_nested_subcommands() {
    let root = root_scripts();
    let mut got = root.command_transports(&[]);
    got.sort();
    assert_eq!(
      got,
      vec![
        ("fetch".to_string(), "oneshot".to_string()),
        ("logs tail".to_string(), "streaming".to_string()),
      ]
    );
    // The mount prefix threads through every emitted path.
    let mut prefixed = root.command_transports(&["ns".to_string()]);
    prefixed.sort();
    assert_eq!(
      prefixed,
      vec![
        ("ns fetch".to_string(), "oneshot".to_string()),
        ("ns logs tail".to_string(), "streaming".to_string()),
      ]
    );
  }

  /// `manifest_value` emits the overrides as a `"transports"` object (the shape
  /// `tento-app`'s `AppManifest.transports` reads), folding in shell-level
  /// subcommand groups under their namespace.
  #[test]
  fn manifest_value_emits_transports_map() {
    let root = root_scripts();
    let mut subs: HashMap<String, Box<dyn Callable>> = HashMap::new();
    subs.insert(
      "ext".to_string(),
      Box::new(Scripts::new(()).add_command(tail_fixture)),
    );
    let json = manifest_value(&root, &subs);
    assert_eq!(json["schema"], "tsh.app/v1");
    assert_eq!(json["transports"]["fetch"], "oneshot");
    assert_eq!(json["transports"]["logs tail"], "streaming");
    assert_eq!(json["transports"]["ext tail"], "streaming");
    // A command without an override contributes no key — it inherits.
    assert!(json["transports"].get("show").is_none());
    assert_eq!(json["transports"].as_object().unwrap().len(), 3);
  }

  /// The whole SERVICE authority chain in one assertion: what the group crate
  /// declared at the builder is exactly what root `--help --json` emits, in the
  /// shape `tento-app`'s `AppManifest.services` reads. The packager copies this
  /// verbatim, so a manifest can never offer a listener the binary lacks.
  ///
  /// Only the ROOT group's services are reflected — a subcommand group is a
  /// namespace inside one app, not an app that serves on its own.
  #[test]
  fn manifest_value_emits_declared_services_from_the_root_group_only() {
    let root =
      root_scripts().service(crate::ServiceDecl::http("board", "serve").health_path("/health"));
    let mut subs: HashMap<String, Box<dyn Callable>> = HashMap::new();
    subs.insert(
      "ext".to_string(),
      Box::new(
        Scripts::new(())
          .add_command(tail_fixture)
          .service(crate::ServiceDecl::http("nested", "tail")),
      ),
    );
    let json = manifest_value(&root, &subs);
    assert_eq!(json["services"].as_array().unwrap().len(), 1, "root only");
    assert_eq!(json["services"][0]["id"], "board");
    assert_eq!(json["services"][0]["command"], "serve");
    assert_eq!(json["services"][0]["kind"], "http");
    assert_eq!(json["services"][0]["health_path"], "/health");
  }

  /// A group that declares no service omits the key entirely, keeping the
  /// manifest byte-stable for every bundle that only answers commands.
  #[test]
  fn manifest_without_services_omits_the_key() {
    let json = manifest_value(&root_scripts(), &HashMap::new());
    assert!(json.get("services").is_none());
  }

  /// No overrides anywhere ⇒ the `transports` key is omitted entirely
  /// (`skip_serializing_if`), keeping the manifest byte-stable for bundles
  /// that don't use the feature.
  #[test]
  fn manifest_without_overrides_omits_transports_key() {
    let root = Scripts::new(()).add_command(show_fixture);
    let json = manifest_value(&root, &HashMap::new());
    assert!(json.get("transports").is_none());
  }
}

#[cfg(test)]
mod prelude_alias_tests {
  use super::prelude_alias_defs;

  #[test]
  fn use_as_words_are_prelude_aliases_beside_defs() {
    let prelude = "(use tsh.toolchain as: toolchain)\n(use tsh.update as:update)\n(let secrets std.secrets)\n(use std.fs)\n(let setup (lambda () 1))";
    assert_eq!(
      prelude_alias_defs(prelude),
      vec![
        ("toolchain".to_string(), "tsh.toolchain".to_string()),
        ("update".to_string(), "tsh.update".to_string()),
        ("secrets".to_string(), "std.secrets".to_string()),
      ]
    );
  }
}
