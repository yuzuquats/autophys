use crate::{CommandArg, error::Error};
use colored::Colorize;
use futures::Future;
use serde_json::Value;

impl CommandArg for () {
  fn display_help() -> Vec<String> {
    vec![]
  }
}

pub trait CommandMetadata<Info> {
  fn name(&self) -> &'static str;
  fn description(&self) -> &'static str;
  fn long_description(&self) -> Option<&'static str>;
  fn confirmation_message(&self) -> Option<&'static str> {
    None
  }
  /// The `CARGO_MANIFEST_DIR` of the crate this command is defined in, baked in
  /// by the `#[command]` macro in debug builds only. Release builds return
  /// `None` so distributions do not disclose the builder's paths. Lets a group's
  /// `Scripts` self-describe its source dir in root `--help --json` so the packager can
  /// snapshot the crate's `.changelog/` into the bundle. `None` for
  /// hand-written `CommandMetadata` impls.
  fn manifest_dir(&self) -> Option<&'static str> {
    None
  }
  /// This command's out-of-process transport override (`"oneshot"`,
  /// `"streaming"`, `"daemon"`), set via `#[command(transport = "…")]`. `None`
  /// (the default) means inherit the bundle's transport. Surfaced in
  /// `__manifest` so the mounting `tsh` routes a shape-returning command oneshot
  /// (host renders the shape) even when the bundle is otherwise streaming.
  fn transport(&self) -> Option<&'static str> {
    None
  }
  fn call_with_argv(
    &self,
    info: Info,
    argv: Vec<String>,
  ) -> Result<std::pin::Pin<Box<dyn Future<Output = Result<Value, Error>>>>, Error>;

  /// The **Lisp door**: invoke this builtin from a Lisp call `(name a b :k v)`.
  /// A builtin is one body reachable two ways; this default lowers the
  /// evaluated Lisp args to argv and reuses [`Self::call_with_argv`], so every
  /// command is Lisp-callable with no per-command work. The `#[command]` macro
  /// overrides it with a type-preserving path that binds straight to the param
  /// type under the command's `arg_schema` (mixing positionals + `:named`).
  fn call_with_lisp_args(
    &self,
    info: Info,
    args: Vec<crate::script::LispValue<crate::script::Sym>>,
  ) -> Result<std::pin::Pin<Box<dyn Future<Output = Result<Value, Error>>>>, Error> {
    self.call_with_argv(info, crate::script::lisp_args_to_argv(self.name(), args))
  }

  /// Invoke this command from the lisp/env driver, returning a value directly.
  /// The **default** (async commands) builds the boxed future via
  /// [`Self::call_with_lisp_args`] and drives it with `now_or_never`: a poll-ready
  /// (in-process) future resolves immediately; a genuinely async daemon/streaming
  /// command is `Pending` and yields a clear "run it as a shell line" error rather
  /// than blocking the thread. A **synchronous** command (`#[command]` on a plain
  /// `fn`, or [`SyncCommand`]) overrides this to run its body directly — **no
  /// future is constructed** — keeping the sync path fast and async-free. This is
  /// the one sync/async seam the future async-twin engine will replace with a real
  /// `.await`.
  fn call_for_lisp(
    &self,
    info: Info,
    args: Vec<crate::script::LispValue<crate::script::Sym>>,
  ) -> Result<Value, Error> {
    use futures::FutureExt;
    match self.call_with_lisp_args(info, args)?.now_or_never() {
      Some(result) => result,
      None => Err(Error::Other(anyhow::anyhow!(
        "`{}` is an async (daemon/streaming) command; call it as a shell line, not inside Lisp",
        self.name()
      ))),
    }
  }

  fn help(&self) -> Vec<String>;

  /// The structured per-option docs (the reflection twin of [`Self::help`]).
  /// Default empty (hand-written impls opt out); the `#[command]` macro fills it
  /// from the arg type's `CommandArg::arg_docs()`.
  fn arg_docs(&self) -> Vec<crate::reflect::OptionDoc> {
    Vec::new()
  }

  /// The command's `command.doc/v1` reflection record — what `<cmd> --help` /
  /// `(cmd :help)` return and a `command.index/v1` leaf embeds. Assembled from the
  /// existing metadata + [`Self::arg_docs`]; no per-command work.
  fn doc(&self) -> crate::reflect::CommandDoc {
    crate::reflect::CommandDoc {
      name: self.name().to_string(),
      description: self.description().to_string(),
      long_description: self.long_description().map(str::to_string),
      options: self.arg_docs(),
      result: self.result_doc(),
    }
  }

  /// The declared result (`command.doc/v1` `result`): its type and, when the
  /// return type is a shape wrapper, the shape and columns. The `#[command]`
  /// macro fills it from the function's `Result<T>`; `None` for hand-written
  /// impls and for results with no schema (`serde_json::Value`).
  fn result_doc(&self) -> Option<crate::shape::ResultDoc> {
    None
  }

  /// The human presentation of this command's plain result `data`, when its
  /// declared return type is a shape wrapper (`Table<T>`, `Kv<T>`, …). `None`
  /// keeps today's generic rendering — always for `Value` results and for data
  /// that carries its own `shape`/`datatype`. `--json` and lisp callers never
  /// see this: they get `data` unchanged.
  fn render_result(&self, data: &Value) -> Option<Value> {
    let _ = data;
    None
  }

  /// [`Self::doc`] serialized as the tagged wire record (`{"type":"command.doc/v1",
  /// …}`) — what the central reflection seam returns for `--help`/`:help`. A
  /// declared result rides along as `result` (omitted when undeclared, so
  /// existing records are unchanged).
  fn doc_value(&self) -> Value {
    serde_json::to_value(crate::reflect::CommandEntry::Doc(self.doc())).unwrap_or(Value::Null)
  }

  fn print_help(&self) {
    print_command_help(
      self.name(),
      self.description(),
      self.long_description(),
      &self.help(),
    );
  }
}

/// The **synchronous** analog of [`CommandMetadata`]: same metadata, but a
/// `call_sync` body that returns a value directly instead of a future. A sync
/// command becomes a real registry command via the [`SyncCommand`] adapter — so
/// the hand-written `std.*` coreutils (and future pane forms) live in the *same*
/// `CommandList` and dispatch through the *same* `find_command` path as the
/// async `#[command]`s, with no parallel native table.
///
/// (A blanket `impl<C: CommandMetadataSync> CommandMetadata for C` would collide
/// with the macro's concrete `CommandMetadata` impls under coherence, hence the
/// explicit `SyncCommand` newtype.)
pub trait CommandMetadataSync<Info> {
  fn name(&self) -> &'static str;
  fn description(&self) -> &'static str;
  fn long_description(&self) -> Option<&'static str> {
    None
  }
  fn help(&self) -> Vec<String> {
    vec![]
  }
  fn call_sync(&self, info: Info, argv: Vec<String>) -> Result<Value, Error>;
}

/// Adapter newtype that lifts any [`CommandMetadataSync`] into a
/// [`CommandMetadata`] by running the body now and handing back an
/// already-ready future. The single bridge between the sync and async seams.
pub struct SyncCommand<C>(pub C);

impl<Info, C: CommandMetadataSync<Info>> CommandMetadata<Info> for SyncCommand<C> {
  fn name(&self) -> &'static str {
    self.0.name()
  }
  fn description(&self) -> &'static str {
    self.0.description()
  }
  fn long_description(&self) -> Option<&'static str> {
    self.0.long_description()
  }
  fn call_with_argv(
    &self,
    info: Info,
    argv: Vec<String>,
  ) -> Result<std::pin::Pin<Box<dyn Future<Output = Result<Value, Error>>>>, Error> {
    let result = self.0.call_sync(info, argv);
    Ok(Box::pin(async move { result }))
  }
  fn call_for_lisp(
    &self,
    info: Info,
    args: Vec<crate::script::LispValue<crate::script::Sym>>,
  ) -> Result<Value, Error> {
    // Future-free: run the sync body via argv lowering; no future is built.
    self
      .0
      .call_sync(info, crate::script::lisp_args_to_argv(self.0.name(), args))
  }
  fn help(&self) -> Vec<String> {
    self.0.help()
  }
}

/// Render a single command's help block: a bold `Name:` / `Description:` /
/// `Options:` layout. Shared by [`CommandMetadata::print_help`] and the
/// dispatch layer (which prints it when a command invocation fails) so the
/// on-failure usage hint and the explicit `--help` output stay identical.
pub fn print_command_help(
  name: &str,
  description: &str,
  long_description: Option<&str>,
  options: &[String],
) {
  println!(
    "\n{}\n    {} {}",
    "Name:".bold(),
    name.bold(),
    if !options.is_empty() { "[OPTIONS]" } else { "" }
  );
  println!(
    "\n{}\n    {}\n",
    "Description:".bold(),
    long_description.unwrap_or(description)
  );
  if !options.is_empty() {
    println!("{}", "Options:".bold());
    for option in options {
      println!("    {}", option);
    }
  }
}
