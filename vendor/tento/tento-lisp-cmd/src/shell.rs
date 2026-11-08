use std::{
  collections::HashMap,
  sync::{Arc, RwLock},
};

use crate::error::Error;
use colored::Colorize;
use futures::Future;
use serde_json::Value;

use crate::{
  command_list::CommandList,
  command_metadata::CommandMetadata,
  run_loop::{LineReader, Signal},
};

// The generic, reedline/run-loop-free dispatch primitives now live in
// `crate::dispatch` (pre-split for the `tento-sh` carve). Re-exported here so the
// established `crate::shell::{Callable, Transport, DaemonSpec, …}` paths — and
// `Scripts`'s own references below — keep resolving unchanged.
pub use crate::dispatch::{
  Callable, DaemonScope, DaemonSpec, GateOutcome, Transport, UnavailableGroup,
};
pub use crate::reflect::{ProvideEntry, ServiceDecl};

pub struct Scripts<Info>
where
  Info: Clone,
{
  pub info: Info,
  pub commands: CommandList<Info>,
  /// Nested subcommands keyed by namespace name. Mirrors the
  /// `subcommands` map on `Shell`, but at the `Scripts` level so a
  /// subcommand can itself hold deeper subcommands (`./run a b c`).
  pub subcommands: HashMap<String, Box<dyn Callable>>,
  /// Resolved bundle identities for rc word mounts, carried into host
  /// registration so the same rc's @import can install its Lisp exports.
  pub(crate) prelinked_bundles: HashMap<String, String>,
  /// The namespace this group is mounted under (`ux-test`, `acme.user`,
  /// …), set by [`Self::add_subcommand`] / [`Shell::add_subcommand`].
  /// Used as the program name in help output; `None` for the root group.
  pub name: Option<String>,
  /// Standalone identity emitted by root `--help --json`.
  pub app_name: String,
  pub app_version: String,
  pub app_entrypoint: String,
  /// The out-of-process transport this group declares (default
  /// [`Transport::Oneshot`]). Emitted in root `--help --json`; the packager records
  /// it in the bundle's `manifest.json`.
  pub transport: Transport,
  /// Daemon connection details, set when `transport == Daemon` (via
  /// [`Self::daemon`]). Emitted in root `--help --json` so the client can connect.
  pub daemon: Option<DaemonSpec>,
  /// The CAPABILITIES this group declares ([`Self::provide`]) — emitted in root
  /// `--help --json` as `provides` and cached into the bundle's `manifest.json`
  /// by the packager. Declared right where the commands are, because a provide
  /// only means anything by naming one of them.
  pub provides: Vec<ProvideEntry>,
  /// The long-running SERVICES this group declares ([`Self::service`]) —
  /// emitted in root `--help --json` as `services` and cached into the bundle's
  /// `manifest.json` by the packager. Same reason they live here: a service is
  /// named by one of this group's own commands.
  pub services: Vec<ServiceDecl>,
  /// Per-host SEED source: Lisp `def`s (e.g. `ls` → `std.fs.list_dir`) that
  /// every Lisp host built from this group evaluates right after its commands
  /// register (see `LispHost::register_commands`). The per-host env replacement
  /// for the retired shared alias map: a unix name is an ordinary `def`, so it
  /// resolves on EVERY surface (REPL, one-shot, script, each control pane) with
  /// no shared mutable state. `None` for a bare shell (no aliases). Set by the
  /// composition root (e.g. tsh's `build_shell_from`) to its unix-name prelude.
  pub prelude: Option<std::rc::Rc<str>>,
  /// Where each line of [`Self::prelude`] came from, for the diagnostics of a
  /// seed form that fails: entry `i` names seed line `i + 1`'s file and its
  /// line there. Empty (or short): the seed's own line numbers are reported.
  pub prelude_origin: std::rc::Rc<[SeedLine]>,
  /// Entered around EACH startup unit [`Self::run_with_startup_argv`]
  /// evaluates, and dropped when that unit ends — before the dispatched
  /// command or any REPL line runs. The seam a host uses to mark its startup
  /// policy (tsh: the rc files it may trust with more than a script), set by
  /// [`Self::with_startup_unit_scope`]. `None`: no marking.
  pub startup_unit_scope: Option<StartupUnitScope>,
  /// Whether a failing command first prints its usage block (to stdout).
  /// Default `true`. An embedder that reports its own one-line errors turns
  /// it off per group with [`Self::without_usage_on_failure`], so a failure
  /// never writes to stdout ahead of piped output.
  pub usage_on_failure: bool,
}

/// One line of the prelude seed: the file it was read from and its line there
/// (see [`Scripts::prelude_origin`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedLine {
  pub file: std::sync::Arc<str>,
  pub line: usize,
}

/// See [`Scripts::startup_unit_scope`]: returns a guard held for one unit.
pub type StartupUnitScope = std::rc::Rc<dyn Fn() -> Box<dyn std::any::Any>>;

impl<Info> Scripts<Info>
where
  Info: Clone + 'static,
{
  pub fn new(info: Info) -> Self {
    let commands = CommandList::new();
    Scripts {
      info,
      commands,
      subcommands: HashMap::new(),
      prelinked_bundles: HashMap::new(),
      name: None,
      app_name: String::new(),
      app_version: String::new(),
      app_entrypoint: String::new(),
      transport: Transport::default(),
      daemon: None,
      provides: Vec::new(),
      services: Vec::new(),
      prelude: None,
      prelude_origin: std::rc::Rc::from([]),
      startup_unit_scope: None,
      usage_on_failure: true,
    }
  }

  /// Stop this group's failing commands from printing their usage block; see
  /// [`Self::usage_on_failure`]. Applies to this group only, so set it on
  /// each nested group too. Builder-style.
  pub fn without_usage_on_failure(mut self) -> Self {
    self.usage_on_failure = false;
    self
  }

  /// Declare one CAPABILITY this group provides (a [`ProvideEntry`]) — the
  /// builder seam a bundle author writes next to their `add_command` calls:
  ///
  /// ```ignore
  /// Scripts::new(self)
  ///   .add_command(tokens)
  ///   .provide(ProvideEntry::syntax_provider("go", "tokens", SYNTAX_TOKENS_V1).extensions(["go"]))
  /// ```
  ///
  /// The declaration lives HERE, in the binary, and nowhere else: it rides root
  /// `--help --json` and the packager caches it into `manifest.json`, so the
  /// manifest can never claim a capability the binary doesn't have. Call it once
  /// per entry; provides accumulate in declaration order. Builder-style.
  pub fn provide(mut self, entry: ProvideEntry) -> Self {
    self.provides.push(entry);
    self
  }

  /// Declare one long-running SERVICE this group can run (a [`ServiceDecl`]) —
  /// the builder seam next to `add_command`, for a group that serves as well as
  /// answers:
  ///
  /// ```ignore
  /// Scripts::new(self)
  ///   .add_command(serve)
  ///   .service(ServiceDecl::http("board", "serve").health_path("/health"))
  /// ```
  ///
  /// Like [`Self::provide`], the declaration lives HERE and nowhere else: it
  /// rides root `--help --json` and the packager caches it into
  /// `manifest.json`, so a supervisor reading an installed bundle learns what it
  /// may bring up without spawning the binary to ask. The named `command` must
  /// accept `--listen <ip:port>` and bind exactly it. Call once per service;
  /// services accumulate in declaration order. Builder-style.
  pub fn service(mut self, decl: ServiceDecl) -> Self {
    self.services.push(decl);
    self
  }

  /// Set the application identity carried by root reflection.
  pub fn with_app_identity(
    mut self,
    name: impl Into<String>,
    version: impl Into<String>,
    entrypoint: impl Into<String>,
  ) -> Self {
    self.app_name = name.into();
    self.app_version = version.into();
    self.app_entrypoint = entrypoint.into();
    self
  }

  /// Formerly set the `source_dir` root reflection carried for the packager's
  /// `.changelog/` snapshot. Root reflection no longer carries a source dir, so
  /// this does nothing; it stays so a caller that must also build against an
  /// older tento without [`Self::with_app_identity`] keeps compiling.
  #[deprecated(note = "root reflection no longer carries a source dir; use `with_app_identity`")]
  pub fn with_source_dir(self, _dir: impl Into<String>) -> Self {
    self
  }

  /// Declare this group's out-of-process [`Transport`] (default
  /// [`Transport::Oneshot`]). A oneshot group needs no call; a daemon/pooled
  /// group sets it so the packaged `manifest.json` records it. Builder-style.
  pub fn transport(mut self, transport: Transport) -> Self {
    self.transport = transport;
    self
  }

  /// Declare this group's daemon connection (implies [`Transport::Daemon`]):
  /// the `socket` path to connect to and the `start` argv to lazily spawn it
  /// (empty = externally-managed). Recorded in `manifest.json` so the tsh client
  /// can reach the daemon. Builder-style.
  pub fn daemon(mut self, socket: impl Into<String>, start: Vec<String>) -> Self {
    self.transport = Transport::Daemon;
    self.daemon = Some(DaemonSpec {
      socket: socket.into(),
      start,
      scope: None,
    });
    self
  }

  /// Declare this group as a SESSION-leased daemon service (implies
  /// [`Transport::Daemon`], `scope = DaemonScope::Session`). Unlike
  /// [`Self::daemon`] there
  /// is NO socket argument: the socket is DERIVED per-session at
  /// `<session-dir>/services/<app>.sock` by the typed session folder, so one
  /// service instance is leased per live session and dies with it. `start` is
  /// the argv the engine uses to spawn the service child, which it OWNS
  /// (`kill_on_drop`) — the child must not outlive the engine (no reaper,
  /// matching the ACP-lane philosophy). Builder-style.
  pub fn daemon_session(mut self, start: Vec<String>) -> Self {
    self.transport = Transport::Daemon;
    self.daemon = Some(DaemonSpec {
      socket: String::new(),
      start,
      scope: Some(DaemonScope::Session),
    });
    self
  }

  /// Declare this group as [`Transport::Streaming`]: when mounted as a bundle,
  /// each command spawns the binary with the terminal's stdio **inherited** (no
  /// capture, no `--tsh` JSON channel) so subprocess output streams live and the
  /// command's result is its exit status. For groups that wrap `deno`/`tsc`/build
  /// tools (`tento-ts`). Builder-style. (Run standalone, the binary behaves like
  /// any other group — this only changes how the tsh client dispatches it.)
  pub fn streaming(mut self) -> Self {
    self.transport = Transport::Streaming;
    self
  }

  /// Compatibility shim from the deleted `Shell` wrapper: a `Scripts` IS the
  /// shell now (commands + nested groups + heterogeneous mounts + prelude,
  /// registered into a `LispHost`). Returns self so existing
  /// `scripts.to_shell().run()` call sites keep working; new code drops it.
  pub fn to_shell(self) -> Self {
    self
  }

  pub async fn run(mut self) {
    let subcommands = std::mem::take(&mut self.subcommands);
    let result = crate::run_loop::run(
      std::rc::Rc::new(self),
      std::rc::Rc::new(subcommands),
      &mut StdinLineReader::new(),
    )
    .await;
    crate::run_loop::exit_on_cli_failure(result);
  }

  pub async fn run_with(mut self) {
    let subcommands = std::mem::take(&mut self.subcommands);
    let result = crate::run_loop::run(
      std::rc::Rc::new(self),
      std::rc::Rc::new(subcommands),
      &mut StdinLineReader::new(),
    )
    .await;
    crate::run_loop::exit_on_cli_failure(result);
  }

  /// Mount a raw [`Callable`] under `namespace` — a `RemoteGroup` (an
  /// out-of-process `.tsh.app` bundle) or any dynamic group. Where
  /// [`Self::add_subcommand`] takes a typed `Scripts`, this accepts any
  /// `Callable`, so the core hosts runtime-discovered groups with no
  /// compile-time dependency. (Was `Shell::mount_callable`.)
  pub fn mount_callable(mut self, namespace: &str, callable: Box<dyn Callable>) -> Self {
    self.prelinked_bundles.remove(namespace);
    self.subcommands.insert(namespace.to_string(), callable);
    self
  }

  /// Prelink an rc bundle's command word with the resolved manifest identity.
  /// The first word mount keeps ownership; later conflicting imports report
  /// their collision when startup evaluates them. Raw callables never gain
  /// bundle ownership merely by sharing a namespace's spelling.
  pub fn mount_bundle_callable(
    mut self,
    namespace: &str,
    bundle: &str,
    callable: Box<dyn Callable>,
  ) -> Self {
    if !self.subcommands.contains_key(namespace) {
      self.prelinked_bundles.insert(namespace.to_string(), bundle.to_string());
      self.subcommands.insert(namespace.to_string(), callable);
    }
    self
  }

  /// Mount `commands` under `namespace` iff `outcome` is available; otherwise a
  /// visible [`UnavailableGroup`] placeholder that fails loudly with `reason`.
  pub fn add_gated_subcommand<SubInfo>(
    self,
    namespace: &str,
    outcome: GateOutcome,
    commands: Scripts<SubInfo>,
  ) -> Self
  where
    SubInfo: Clone + 'static,
  {
    match outcome {
      GateOutcome::Available => self.add_subcommand(namespace, commands),
      GateOutcome::Unavailable(reason) => self.add_unavailable(namespace, reason),
    }
  }

  /// Mount a visible [`UnavailableGroup`] placeholder under `namespace`: it shows
  /// in `help` ("namespace — unavailable: <reason>") and fails loudly when
  /// invoked, instead of silently vanishing.
  pub fn add_unavailable(mut self, namespace: &str, reason: impl Into<String>) -> Self {
    self.subcommands.insert(
      namespace.to_string(),
      Box::new(UnavailableGroup {
        name: namespace.to_string(),
        reason: reason.into(),
      }),
    );
    self
  }

  /// Set this group's per-host prelude SEED (the unix-name `def`s every
  /// `LispHost` built from it evaluates — see [`Self::prelude`]). Builder-style.
  /// (Was `Shell::with_root_prelude`.)
  pub fn with_root_prelude(mut self, src: impl Into<std::rc::Rc<str>>) -> Self {
    self.prelude = Some(src.into());
    self
  }

  /// Name the origin of each prelude seed line (see [`Self::prelude_origin`]),
  /// so a failing seed form is reported against its file and line.
  /// Builder-style.
  pub fn with_prelude_origin(mut self, origin: impl Into<std::rc::Rc<[SeedLine]>>) -> Self {
    self.prelude_origin = origin.into();
    self
  }

  /// Set the guard entered around each startup unit (see
  /// [`Self::startup_unit_scope`]). Builder-style.
  pub fn with_startup_unit_scope(
    mut self,
    scope: impl Fn() -> Box<dyn std::any::Any> + 'static,
  ) -> Self {
    self.startup_unit_scope = Some(std::rc::Rc::new(scope));
    self
  }

  /// Split off the heterogeneous subcommand mounts so an alternate front-end (the
  /// TUI host, a control pane) can register both into its own `LispHost` and
  /// drive its own loop. Replaces the deleted `Shell::into_parts` — there is no
  /// line reader to return (the TUI owns input).
  pub fn into_command_parts(mut self) -> (Self, HashMap<String, Box<dyn Callable>>) {
    let subcommands = std::mem::take(&mut self.subcommands);
    (self, subcommands)
  }

  /// Return the canonical, side-effect-free app self-description used by root
  /// `--help --json` and the bundle packager. This only reflects the in-memory
  /// registry; it does not construct an evaluator or execute startup code.
  pub fn self_description(&self) -> Value {
    crate::run_loop::manifest_value(self, &self.subcommands)
  }

  /// Run the startup `.tsh` units against this group's commands, then enter
  /// the run loop (REPL / one-shot dispatch). `startup` is ONE unit PER RC
  /// FILE, in load order, each carrying its source path — threaded as
  /// [`crate::script::RunOptions::source_path`] so `(std.script.dir)` resolves
  /// inside startup code (the rc loader supplies the segments; an included
  /// file contributes its own). Failures are non-fatal at BOTH levels: a
  /// failing statement warns and its file keeps evaluating
  /// ([`crate::script::OnError::WarnContinue`], the policy the control actor
  /// applies to the same source), and a file that ends with failures does not
  /// stop later files. The invocation argv is passed
  /// EXPLICITLY (index 0 = binary name) — the run loop dispatches what the
  /// host decided, never re-reading `env::args()`; a host that filters its
  /// argv (tsh strips `@profile` selector tokens) would otherwise dispatch
  /// stripped-away tokens.
  pub async fn run_with_startup_argv(
    mut self,
    startup: Vec<(std::path::PathBuf, String)>,
    resolver: std::rc::Rc<dyn crate::script::ImportResolver>,
    render_hook: Option<crate::run_loop::RenderHook>,
    argv: Vec<String>,
    host_setup: Option<std::rc::Rc<dyn Fn(&mut crate::script::LispHost)>>,
  ) {
    let subcommands = std::mem::take(&mut self.subcommands);
    let scripts = std::rc::Rc::new(self);
    let subcommands = std::rc::Rc::new(subcommands);
    // ONE host for startup AND for the dispatch that follows — a `(let …)` in
    // an rc stays visible to later rc files, to the dispatched command, and to
    // every REPL prompt, exactly as the engine's persistent ctl host behaves.
    // Built unconditionally (even with no startup units) so the vocabulary
    // `host_setup` contributes is present on every dispatch path.
    let mut host = crate::script::LispHost::with_resolver(resolver.clone());
    // The embedder's own vocabulary, installed BEFORE `register_commands`. This
    // is the seam that lets a host declare which of its natives exist off the
    // session path — tsh registers the pane/lane forms here in an inert
    // flavour, so an rc that declares a lane is legal whether or not a session
    // engine is behind it.
    //
    // Order matters: `register_commands` ends by evaluating the group's
    // unix-name prelude SEED, and that seed is the SAME artifact the engine's
    // ctl host reads. A form the embedder contributes (tsh's `(exec.path)`)
    // must therefore already be bound when the seed runs, or the seed fails on
    // this host and not on the engine's — which is exactly the divergence the
    // one-artifact-two-evaluators contract forbids. The engine's control host
    // has always registered its vocabulary first; this path now matches it.
    let timing = std::env::var_os("TENTO_STARTUP_TIMING").is_some();
    let phase = std::time::Instant::now();
    if let Some(setup) = &host_setup {
      setup(&mut host);
    }
    host.register_commands(scripts.clone(), subcommands.clone());
    if timing {
      eprintln!(
        "startup: host setup + commands {:.1} ms",
        phase.elapsed().as_secs_f64() * 1e3
      );
    }
    run_startup_units(&mut host, startup, &scripts, &subcommands, timing).await;
    let result = crate::run_loop::run_with_resolver_argv(
      scripts,
      subcommands,
      resolver,
      render_hook,
      &mut StdinLineReader::new(),
      argv,
      Some(host),
    )
    .await;
    crate::run_loop::exit_on_cli_failure(result);
  }

  pub fn add_command<C>(mut self, command: C) -> Self
  where
    C: CommandMetadata<Info> + Sized + 'static,
  {
    self.commands.add_command(command);
    self
  }

  /// Register a nested subcommand. Mirrors `Shell::add_subcommand`
  /// but on `Scripts` so chains like `./run a b c <args>` work:
  /// `a` lives in `Shell::subcommands`, `b` lives in `a`'s
  /// `Scripts::subcommands`, `c` is a flat command on `b`.
  pub fn add_subcommand<SubInfo>(mut self, namespace: &str, mut scripts: Scripts<SubInfo>) -> Self
  where
    SubInfo: Clone + 'static,
  {
    scripts.name = Some(namespace.to_string());
    self
      .subcommands
      .insert(namespace.to_string(), Box::new(scripts));
    self.prelinked_bundles.remove(namespace);
    self
  }

  pub async fn run_command(&self, command: &str) -> crate::Result<crate::json::Value> {
    let argv = command
      .split(" ")
      .map(|s| s.to_string())
      .collect::<Vec<String>>();

    let subcommand_name = argv
      .get(0)
      .ok_or_else(|| Error::MissingSubcommand(self.commands.names().join(", ")))?;
    let subcommand = self
      .commands
      .find_command(&subcommand_name)
      .ok_or(Error::NoSuchSubcommand)?;

    Ok(subcommand.call_with_argv(self.info.clone(), argv)?.await?)
  }
}

/// Evaluate `startup` on `host`, one unit per rc file in order, each inside
/// the group's [`Scripts::startup_unit_scope`] guard (dropped as the unit
/// ends). See [`Scripts::run_with_startup_argv`] for the error policy.
async fn run_startup_units<Info>(
  host: &mut crate::script::LispHost,
  startup: Vec<(std::path::PathBuf, String)>,
  scripts: &std::rc::Rc<Scripts<Info>>,
  subcommands: &std::rc::Rc<HashMap<String, Box<dyn Callable>>>,
  timing: bool,
) where
  Info: Clone + 'static,
{
  for (path, src) in startup {
    let phase = std::time::Instant::now();
    let scope = scripts.startup_unit_scope.as_ref().map(|enter| enter());
    let outcome = crate::script::run_source_on_host(
      host,
      &src,
      scripts,
      subcommands,
      &[],
      crate::script::RunOptions {
        source_path: Some(path.clone()),
        // Same policy the control actor uses for the SAME source: a failing
        // statement warns and the file keeps going. An rc is a set of
        // declarations, not a procedure — one unavailable form must not
        // silently discard every declaration below it.
        on_error: crate::script::OnError::WarnContinue,
        ..crate::script::RunOptions::default()
      },
    )
    .await;
    drop(scope);
    if timing {
      eprintln!(
        "startup: unit {} {:.1} ms",
        path.display(),
        phase.elapsed().as_secs_f64() * 1e3
      );
    }
    if let Err(e) = outcome {
      let shape = e.to_shape(&format!("startup .tsh failed ({})", path.display()));
      match crate::run_loop::cli_shape_text(&shape) {
        Some(text) => eprintln!("{text}\n"),
        None => eprintln!("warning: startup .tsh failed ({}): {e}", path.display()),
      }
    }
  }
}

impl<T: Clone> Callable for Scripts<T> {
  fn call_with_argv(
    &self,
    argv: Vec<String>,
  ) -> crate::Result<std::pin::Pin<Box<dyn Future<Output = crate::Result<Value>>>>> {
    let mut argv = argv;
    let reflection = crate::script::arg_bind::take_reflection_argv(&mut argv);
    let Some(next) = argv.get(1).cloned() else {
      // Bare namespace (e.g. `ux-test` with no subcommand): show what can
      // be run instead of erroring out. Returns the structured help tree
      // (like `<namespace> --help`) so the host renders a collapsible tree.
      let tree = self.help_value();
      return Ok(Box::pin(async move { Ok(tree) }));
    };

    // Nested subcommand: forward without the outer namespace name so
    // the inner Callable sees its own name at argv[0]. Mirrors how the
    // top-level argv door (`LispHost::eval_posix_argv_async`) hands argv off.
    if let Some(sub) = self.subcommands.get(&next) {
      let mut argv = argv.clone();
      argv.remove(0);
      if reflection.help {
        let end = argv.iter().position(|word| word == "--").unwrap_or(argv.len());
        argv.insert(end, "--help".into());
      }
      return sub.call_with_argv(argv);
    }

    let Some(subcommand) = self.commands.find_command(&next) else {
      // Unknown nested subcommand. Build a helpful, *visible* error instead of
      // the opaque `NoSuchSubcommand`: name the namespace, suggest the nearest
      // match, and list what's available. `run_once_or_loop` prints this to
      // stderr (and the TUI host renders it) — neither relies on the `tento_sh`
      // tracing target, which consumers like acme-console filter off, so the
      // failure no longer vanishes.
      let ns = self.name.as_deref().unwrap_or("[command]");
      let suggestion = crate::run_loop::nearest_command(&next, &self.commands, &self.subcommands);
      let mut available: Vec<String> = self.commands.names();
      available.extend(self.subcommands.keys().cloned());
      available.sort();
      return Err(Error::CommandNotFound {
        name: format!("{ns} {next}"),
        suggestion,
        available,
      });
    };
    let mut argv = argv.clone();
    argv.remove(0);

    if reflection.help {
      let doc = subcommand.doc_value();
      return Ok(Box::pin(async move { Ok(doc) }));
    }

    // Surface the command's arg descriptions when it fails, so a bad or
    // missing argument (e.g. `ux-test view <unknown-session>`) tells the
    // user what the command actually accepts. Gated on the command having
    // args — a no-arg command's usage block would just be noise on an
    // unrelated runtime error. An embedder can opt out
    // (`usage_on_failure`) and report failures itself.
    let options = subcommand.help();
    if options.is_empty() || !self.usage_on_failure {
      return subcommand.call_with_argv(self.info.clone(), argv);
    }
    let (name, description, long) = (
      subcommand.name(),
      subcommand.description(),
      subcommand.long_description(),
    );
    let print_usage =
      move || crate::command_metadata::print_command_help(name, description, long, &options);
    match subcommand.call_with_argv(self.info.clone(), argv) {
      Err(e) => {
        // Arg-parse failure (synchronous): show usage, then propagate.
        print_usage();
        Err(e)
      }
      Ok(fut) => Ok(Box::pin(async move {
        // Runtime failure (e.g. missing/unknown session): same treatment.
        match fut.await {
          Ok(v) => Ok(v),
          Err(e) => {
            print_usage();
            Err(e)
          }
        }
      })),
    }
  }

  fn print_help(&self, include_args: bool) {
    // Mirror the top-level `help` framing (`run_loop::print_help`): a
    // `Usage:` line naming this namespace, then a `Commands:` section.
    let prog = self.name.as_deref().unwrap_or("[name]");
    println!("\nUsage: {} <command> [options]\n", prog);
    println!("{}", "Commands:".bold());
    self.commands.print_help(0, include_args);
    for (name, sub) in &self.subcommands {
      println!("    {}", name.bold());
      sub.print_help(include_args);
    }
    println!();
  }

  fn help_value(&self) -> Value {
    crate::run_loop::build_help_value(&self.commands, &self.subcommands, false)
  }

  fn command_transports(&self, prefix: &[String]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for name in self.commands.names() {
      if let Some(cmd) = self.commands.find_command(&name) {
        if let Some(t) = cmd.transport() {
          let mut path = prefix.to_vec();
          path.push(name);
          out.push((path.join(" "), t.to_string()));
        }
      }
    }
    for (ns, sub) in &self.subcommands {
      let mut child_prefix = prefix.to_vec();
      child_prefix.push(ns.clone());
      out.extend(sub.command_transports(&child_prefix));
    }
    out
  }
}

#[derive(Clone)]
pub struct PromptText(Arc<RwLock<Option<String>>>);

impl PromptText {
  pub fn new() -> PromptText {
    PromptText(Arc::new(RwLock::new(None)))
  }

  pub fn set(&self, t: Option<String>) {
    *self.0.write().expect("") = t;
  }
}

impl crate::status::StatusSink for PromptText {
  /// Degenerate sink: surface the first source's `identity` as the REPL label.
  /// A tento-tui status pane will render the full merged object.
  fn render(&self, status: &serde_json::Value) {
    let label = status
      .as_object()
      .and_then(|o| {
        o.values()
          .find_map(|v| v.get("identity").and_then(|i| i.as_str()))
      })
      .map(|s| s.to_string());
    self.set(label);
  }
}

/// The cooked-stdin line reader: the reedline-free `LineReader`. It prints the
/// `PromptText` label, reads one line from stdin, and maps EOF to `CtrlD` (the
/// REPL's exit signal). No history or line-editing — the rich interactive
/// surface is the TUI composer pane; this backs the non-TUI / fallback REPL.
pub struct StdinLineReader {
  pub prompt: PromptText,
  buf: String,
}

impl StdinLineReader {
  pub fn new() -> Self {
    StdinLineReader {
      prompt: PromptText::new(),
      buf: String::new(),
    }
  }
}

impl Default for StdinLineReader {
  fn default() -> Self {
    Self::new()
  }
}

impl LineReader for StdinLineReader {
  fn read_line(&mut self) -> anyhow::Result<Signal> {
    use std::io::Write as _;
    let label = self
      .prompt
      .0
      .read()
      .ok()
      .and_then(|g| g.clone())
      .unwrap_or_default();
    print!("{label} → ");
    std::io::stdout().flush()?;
    self.buf.clear();
    let n = std::io::stdin().read_line(&mut self.buf)?;
    if n == 0 {
      return Ok(Signal::CtrlD);
    }
    Ok(Signal::Success(
      self.buf.trim_end_matches(['\n', '\r']).to_string(),
    ))
  }
}

#[cfg(test)]
mod startup_scope_tests {
  use super::*;
  use crate::script::{LispHost, LispValue};
  use std::cell::Cell;
  use std::rc::Rc;

  thread_local! {
    static IN_UNIT: Cell<bool> = const { Cell::new(false) };
  }

  struct Mark;
  impl Drop for Mark {
    fn drop(&mut self) {
      IN_UNIT.with(|flag| flag.set(false));
    }
  }

  /// Each startup unit runs inside the group's scope guard — including after
  /// a unit that failed — and the guard is gone once the units end, so what
  /// the host evaluates next (the dispatched command, a REPL line) is outside
  /// it.
  #[tokio::test(flavor = "current_thread")]
  async fn each_startup_unit_runs_inside_the_scope_and_nothing_after() {
    let scripts = Rc::new(Scripts::new(()).with_startup_unit_scope(|| {
      IN_UNIT.with(|flag| flag.set(true));
      Box::new(Mark)
    }));
    let subcommands = Rc::new(HashMap::new());
    let mut host = LispHost::new();
    let seen = Rc::new(Cell::new(0u32));
    let counted = Rc::clone(&seen);
    host.register_native_special("in-unit", move |_args| {
      if IN_UNIT.with(Cell::get) {
        counted.set(counted.get() + 1);
      }
      Ok(LispValue::Boolean(IN_UNIT.with(Cell::get)))
    });
    let units = vec![
      ("/rc/one.tshrc".into(), "(in-unit)".to_string()),
      ("/rc/two.tshrc".into(), "(nope)\n(in-unit)".to_string()),
    ];
    run_startup_units(&mut host, units, &scripts, &subcommands, false).await;
    assert_eq!(seen.get(), 2, "both units, the failing one too, ran scoped");
    assert!(!IN_UNIT.with(Cell::get), "the guard ended with the units");
    assert!(
      !host.eval_truthy("(in-unit)").expect("evaluates"),
      "a later evaluation is outside the scope"
    );
  }
}
