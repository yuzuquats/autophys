//! `std.sh.cmd`: how a bash simple command runs (argv.md I12, I13).
//!
//! The bash front end compiles every simple command to
//! `(std.sh.cmd "name" word…)`: strings and word expansions, the first word
//! naming the command. The runtime resolves that name by bash's lookup (shell
//! function, bash builtin, tsh command, then `PATH`) and never consults a
//! Lisp binding: a `def`, a bash variable or a user closure that shares the
//! name is not the command. This file lowers the form to the call shapes the
//! flow evaluator dispatches on, and decides which names a Lisp binding may
//! answer for.
use super::*;
use std::cell::RefCell;

impl LispHost {
  /// Lower every `(std.sh.cmd …)` under `value`, children first, to the call
  /// the flow evaluator dispatches on:
  ///
  /// - `(std.sh.cmd "echo" "a" "b")` → `(echo "a" "b")`
  /// - with a word that expands to fields, `(apply echo (append (list "a") fields))`
  /// - with a computed command word, `(std.sh.cmd (append …))`, the one
  ///   computed shape of the same form (`std.sh.cmd` merged, argv.md I17)
  ///
  /// - bash's `cmd &`, `(std.jobs.spawn STAGE)` with one compiled shell stage
  ///   (argv.md I17), → `(std.sh.background STAGE)`, the flow form that
  ///   starts the stage as a job; program words (`(std.jobs.spawn "sleep"
  ///   "1")`, `(std.jobs.spawn (list …))`) stay the typed command
  ///
  /// The head is interned directly, never read, so `true`, `[`, `:` and `2` are
  /// command names like any other. `quote` is data and stays untouched.
  pub(super) fn lower_commands(&mut self, value: &mut LispValue<Sym>) {
    let LispValue::List(list) = value else {
      return;
    };
    let head = match list.items.first() {
      Some(LispValue::Symbol(symbol)) => {
        self.interp.string_interner().resolve(symbol.as_symbol()).map(str::to_string)
      }
      _ => None,
    };
    if head.as_deref() == Some("quote") {
      return;
    }
    if head.as_deref() == Some(tento_lisp::SPAWN_FORM) && self.is_shell_stage_operand(&list.items[1..]) {
      let background = self.interp.string_interner().get_or_intern("std.sh.background");
      list.items[0] = LispValue::Symbol(background.into());
    }
    for item in &mut list.items {
      self.lower_commands(item);
    }
    if head.as_deref() != Some(SHELL_COMMAND) {
      return;
    }
    // Already lowered to its computed shape: lowering is idempotent.
    if self.is_computed_command(value) {
      return;
    }
    let LispValue::List(list) = value else {
      return;
    };
    let words = list.items.split_off(1);
    *value = self.lowered_command(words);
  }

  /// One operand that is a form of the bash lowering vocabulary (`std.sh.*`):
  /// the stage of a `cmd &`, which is syntax rather than an argument.
  fn is_shell_stage_operand(&mut self, operands: &[LispValue<Sym>]) -> bool {
    let [LispValue::List(stage)] = operands else {
      return false;
    };
    let Some(LispValue::Symbol(head)) = stage.items.first() else {
      return false;
    };
    self
      .interp
      .string_interner()
      .resolve(head.as_symbol())
      .is_some_and(|name| name.starts_with("std.sh."))
  }

  fn lowered_command(&mut self, mut words: Vec<LispValue<Sym>>) -> LispValue<Sym> {
    // A quoted command word resolves as the bare name: the marker only keeps
    // literal macro patterns off it (I12 note), so it ends here.
    let mut quoted = false;
    if let Some(name) = words.first().and_then(|word| self.quoted_word(word)) {
      // `\ls` / `'ls'` never reaches a prompt declaration, as a quoted word
      // never expands an alias in bash: it runs as a computed command word.
      quoted = self.shell_prompt && self.declared_target(&name).is_some();
      words[0] = LispValue::String(name);
    }
    if quoted {
      let argv = self.appended_fields(words);
      let command = self.symbol_value(SHELL_COMMAND);
      return LispValue::List(tento_lisp::List { items: vec![command, argv].into() });
    }
    let fields = words.iter().any(|word| self.is_fields_word(word));
    match words.first() {
      Some(LispValue::String(name)) => {
        let mut name = name.clone();
        words.remove(0);
        // A renamed tsh command word (`std.apps.list`) still runs, warned; a
        // retired one (`std.fs.list_dir`) runs with its leading arguments.
        if name.contains('.') {
          if let Some(target) = self.interp.deprecated_target(&name) {
            self.interp.note_deprecation(&name, &target.spelling());
            words.splice(0..0, target.leading.iter().map(|arg| LispValue::String(arg.as_str().into())));
            name = target.name.into();
          }
        }
        let head = self.symbol_value(builtin_head(&name));
        if !fields {
          let mut items = vec![head];
          items.extend(words);
          return LispValue::List(tento_lisp::List { items: items.into() });
        }
        let argv = self.appended_fields(words);
        let apply = self.symbol_value("apply");
        LispValue::List(tento_lisp::List { items: vec![apply, head, argv].into() })
      }
      _ => {
        let argv = self.appended_fields(words);
        let command = self.symbol_value(SHELL_COMMAND);
        LispValue::List(tento_lisp::List { items: vec![command, argv].into() })
      }
    }
  }

  /// `(append (list word) fields …)`: each word as a field list, in order.
  fn appended_fields(&mut self, words: Vec<LispValue<Sym>>) -> LispValue<Sym> {
    let mut items = vec![self.symbol_value("append")];
    for word in words {
      if self.is_fields_word(&word) {
        items.push(word);
      } else {
        let list = self.symbol_value("list");
        items.push(LispValue::List(tento_lisp::List { items: vec![list, word].into() }));
      }
    }
    LispValue::List(tento_lisp::List { items: items.into() })
  }

  /// `(std.sh.cmd (append …))`: a command whose argv is computed at run time
  /// (a computed or prompt-quoted command word). The merged `std.sh.cmd`.
  pub(super) fn is_computed_command(&mut self, value: &LispValue<Sym>) -> bool {
    let LispValue::List(list) = value else {
      return false;
    };
    list.items.len() == 2
      && self.call_head(value).as_deref() == Some(SHELL_COMMAND)
      && self.call_head(&list.items[1]).as_deref() == Some("append")
  }

  /// A word that expands to fields: `std.sh.split`, or a `${x:+…}` conditional.
  fn is_fields_word(&mut self, word: &LispValue<Sym>) -> bool {
    matches!(self.call_head(word).as_deref(), Some("std.sh.split" | "if"))
  }

  /// The name inside `(std.sh.word.quoted "name")`.
  fn quoted_word(&mut self, word: &LispValue<Sym>) -> Option<tento_lisp::Text> {
    let LispValue::List(list) = word else {
      return None;
    };
    match list.items.as_slice() {
      [_, LispValue::String(name)] if self.call_head(word).as_deref() == Some(QUOTED_WORD) => {
        Some(name.clone())
      }
      _ => None,
    }
  }

  fn call_head(&mut self, value: &LispValue<Sym>) -> Option<String> {
    let LispValue::List(list) = value else {
      return None;
    };
    match list.items.first() {
      Some(LispValue::Symbol(symbol)) => {
        self.interp.string_interner().resolve(symbol.as_symbol()).map(str::to_string)
      }
      _ => None,
    }
  }

  fn symbol_value(&mut self, name: &str) -> LispValue<Sym> {
    LispValue::Symbol(self.interp.string_interner().get_or_intern(name).into())
  }

  /// Whether a form is, or contains, a `std.sh.cmd` call outside `quote`.
  pub(super) fn contains_command(&mut self, value: &LispValue<Sym>) -> bool {
    let LispValue::List(list) = value else {
      return false;
    };
    match self.call_head(value).as_deref() {
      Some("quote") => false,
      Some(SHELL_COMMAND) => true,
      _ => list.items.iter().any(|item| self.contains_command(item)),
    }
  }

  /// Whether `name` is answered by a Lisp binding rather than a host command.
  /// A command resolves to a function, a builtin, a tsh command (a native the
  /// host registered under that very name) or a `PATH` program; a `let`, a
  /// bash variable, a user closure or an imported name bound to the same word
  /// is none of those, so bash lookup passes over it (operator rulings 14 and
  /// 18, 2026-10-06: the prelude binds Lisp names only).
  ///
  /// `(let ls std.fs.list_dir)` therefore binds the Lisp name `ls`; it is a
  /// command only as a prompt declaration ([`Self::declared_target`]), which
  /// the flow evaluator consults before PATH at the interactive prompt alone.
  /// `use` (with or without `as:`) binds Lisp names only, and so does a
  /// module path (`fs.read_dir` after `(use std.fs)`).
  pub(super) fn shadowed_by_lisp_binding(&mut self, name: &str) -> bool {
    let symbol = self.interp.string_interner().get_or_intern(name);
    let bound = self.env.borrow().get(symbol);
    match bound {
      None => self.interp.module_target(name).is_some(),
      Some(LispValue::Function(Function::NativeClosure(_))) => {
        self.use_lisp_names.borrow().contains(name)
          || !name.contains('.') && !self.registered_native(name)
          || self.mount_yields_to_program(name)
      }
      Some(_) => true,
    }
  }

  /// Whether `name` is only a mount's namespace word (a subcommand group, in
  /// tsh the rc's `(@import … :as NAME)`) and a program of that name runs
  /// from `PATH`. The mount is a Lisp name, reached as `NAME.export`; bash
  /// lookup passes over it to the program, so `tmux ls` beside a `tmux` mount
  /// runs tmux (operator Refinement 4, 2026-10-05: "lisp names cannot
  /// collide with PATH"). With no such program the group still answers.
  pub(super) fn mount_yields_to_program(&self, name: &str) -> bool {
    self.subcommand_groups.contains(name)
      && self.external.as_ref().is_some_and(|external| matches!(external.lookup(name), ExternalLookup::Runs))
  }

  /// Whether the host registered a native under exactly `name` (a command,
  /// an app native, an async mount), as opposed to a Lisp name that copies one.
  pub(super) fn registered_native(&self, name: &str) -> bool {
    self.command_natives.borrow().contains_key(name)
      || self.async_mount_names.borrow().contains(name)
      || self.native_defs.iter().any(|native| native == name)
      || self.command_names.iter().any(|command| command == name)
  }

  /// The `std.*` command a prompt DECLARATION names: `ls` after the prelude's
  /// `(let ls std.coreutil.ls)`. The rule (operator rulings 18/19,
  /// 2026-10-06; the utilities are `std.coreutil.*` by ruling R-2, 2026-10-18,
  /// under `std` since the operator moved them there, 2026-10-19): a root
  /// binding of a bare word (no `.`) whose value is a `std.*` native the host
  /// registered is a declaration. It is ordinary Lisp — editing or removing
  /// the `let` in the prelude or an rc changes or removes the command, and
  /// `(let ls 5)` leaves no command at all. Lambdas, `tsh.*` natives, data and
  /// every `use` name are Lisp names only, so the prelude's
  /// `plugins`/`update`/`setup` never take a bash word.
  ///
  /// Only the interactive prompt consults it (function → builtin →
  /// declaration → PATH); scripts, pipes, captures and redirects use PATH.
  /// An embedder's [`Self::register_shell_alias`] spelling with no Lisp
  /// binding of its own answers too.
  pub(super) fn declared_target(&mut self, name: &str) -> Option<String> {
    if name.is_empty() || name.contains('.') || self.use_lisp_names.borrow().contains(name) {
      return None;
    }
    let symbol = self.interp.string_interner().get_or_intern(name);
    let bound = self.env.borrow().get(symbol);
    let bound = match bound {
      None => return self.shell_aliases.get(name).cloned(),
      Some(LispValue::Function(Function::NativeClosure(bound))) => bound,
      Some(_) => return None,
    };
    if self.registered_native(name) {
      return None;
    }
    // A retired command's bare name (an older prelude's `(let ls
    // std.fs.list_dir)`) declares its old spelling, which still runs the
    // replacement with its leading arguments (`std.coreutil.ls -l`).
    if let Some(old) = self.interp.deprecated_call_of(&bound).filter(|old| old.starts_with("std.")) {
      return Some(old.to_string());
    }
    // The recorded target first (the prelude's own), then any `std.*` native
    // the binding is (an rc or prompt `let` made after the seed).
    let recorded = self.shell_aliases.get(name).cloned();
    let candidates: Vec<String> = recorded
      .into_iter()
      .chain(self.command_names.iter().cloned())
      .chain(self.command_natives.borrow().keys().cloned())
      .chain(self.native_defs.iter().cloned())
      .filter(|target| target.starts_with("std."))
      .collect();
    for target in candidates {
      let target_symbol = self.interp.string_interner().get_or_intern(&target);
      let value = self.env.borrow().get(target_symbol);
      if let Some(LispValue::Function(Function::NativeClosure(native))) = value {
        if Rc::ptr_eq(&native, &bound) {
          return Some(target);
        }
      }
    }
    None
  }
}

impl LispHost {
  /// The argv of a Lisp call to an external program, `(git "log" :oneline
  /// {:format "%h" :n 3})` (argv.md I11, I13). Strings pass verbatim, always.
  /// A literal keyword is a flag: `:l` → `-l`, `:oneline` → `--oneline`. An
  /// option map carries the options that take values: `{:format "%h"}` →
  /// `--format=%h`, `{:n 3}` → `-n 3`; `true` is the bare flag, `false` and nil
  /// leave the option out, a list repeats it. A bash-lowered call is already
  /// strings and goes through the shell door unchanged.
  pub(super) fn external_call_argv(
    &mut self,
    value: &LispValue<Sym>,
  ) -> crate::Result<Vec<String>> {
    let head = self.application_head(value);
    let LispValue::List(list) = value else {
      return self.application_to_argv(value);
    };
    let split = self.call_head(value).as_deref() == Some("apply")
      && list.items.len() == 3
      && self.call_head(&list.items[2]).as_deref() == Some("append");
    if self.is_computed_command(value) || split {
      return self.application_to_argv(value);
    }
    let Some(head) = head else {
      return self.application_to_argv(value);
    };
    let mut argv = vec![head];
    for arg in &list.items[1..] {
      let keyword = match arg {
        LispValue::Symbol(symbol) => self
          .interp
          .string_interner()
          .resolve(symbol.as_symbol())
          .and_then(|name| name.strip_prefix(':'))
          .map(str::to_string),
        _ => None,
      };
      if let Some(name) = keyword {
        argv.push(option_flag(&name));
        continue;
      }
      let evaluated = self
        .interp
        .eval_expression(self.env.clone(), arg)
        .map_err(|error| crate::Error::Other(anyhow::Error::new(error)))?;
      match evaluated {
        LispValue::String(text) => argv.push(text.into_string()),
        LispValue::Map(options) => {
          for (name, value) in options {
            push_option(&mut argv, name.trim_start_matches(':'), value);
          }
        }
        other => argv.extend(super::lisp_args_to_argv("", vec![other]).into_iter().skip(1)),
      }
    }
    Ok(argv)
  }
}

/// `-n` for a one-letter option, `--name` otherwise.
fn option_flag(name: &str) -> String {
  if name.chars().count() == 1 { format!("-{name}") } else { format!("--{name}") }
}

fn push_option(argv: &mut Vec<String>, name: &str, value: LispValue<Sym>) {
  match value {
    LispValue::Boolean(true) => argv.push(option_flag(name)),
    LispValue::Boolean(false) | LispValue::Nil => {}
    LispValue::List(items) => {
      for item in items.items {
        push_option(argv, name, item);
      }
    }
    scalar => {
      let text = match scalar {
        LispValue::String(text) => text.into_string(),
        other => super::lisp_args_to_argv("", vec![other]).pop().unwrap_or_default(),
      };
      if name.chars().count() == 1 {
        argv.push(option_flag(name));
        argv.push(text);
      } else {
        argv.push(format!("--{name}={text}"));
      }
    }
  }
}

/// The form a bash simple command compiles to.
pub(super) const SHELL_COMMAND: &str = "std.sh.cmd";

/// bash's `set` builtin once lowered (refinement 8): bash builtins take
/// qualified heads, never bare lisp names, so a `set -e` line never meets
/// the lisp `set` special form.
pub(super) const SET_BUILTIN: &str = "std.sh.set";

/// The head symbol a bash command word lowers to.
pub(super) fn builtin_head(name: &str) -> &str {
  if name == "set" { SET_BUILTIN } else { name }
}

/// The command word a lowered head stands for (argv[0], traces, messages).
pub(super) fn builtin_word(head: String) -> String {
  if head == SET_BUILTIN { "set".into() } else { head }
}

/// The marker on a quoted or escaped command word (tento-lisp's reader).
pub(super) const QUOTED_WORD: &str = "std.sh.word.quoted";

/// What a command called from inside a Lisp expression can reach (argv.md
/// I13). The evaluator cannot await there, so the call-head hook works from
/// this snapshot of the host, refreshed at each door that evaluates Lisp.
#[derive(Clone, Default)]
pub(super) struct NestedCommands {
  external: Option<Rc<dyn ExternalCommands>>,
  builtin: Option<super::ShellBuiltin>,
  gate: Option<Rc<dyn Fn(&str) -> crate::Result<()>>>,
  byte_output: Option<Rc<dyn Fn(&[u8])>>,
  stderr_output: Option<Rc<dyn Fn(&[u8])>>,
  prompt: bool,
  functions: Vec<String>,
}

impl LispHost {
  /// Take the snapshot the call-head hook reads (see [`NestedCommands`]).
  pub(super) fn refresh_nested_commands(&mut self) {
    *self.nested_commands.borrow_mut() = NestedCommands {
      external: self.external.clone(),
      builtin: self.shell_builtin.clone(),
      gate: self.shell_builtin_gate.clone(),
      byte_output: self.shell_byte_output.clone(),
      stderr_output: self.shell_stderr_output.clone(),
      prompt: self.shell_prompt,
      functions: self.shell_compound.functions.keys().cloned().collect(),
    };
  }
}

/// Bash builtins a nested call runs here, with no shell state beyond output.
const PURE_BUILTINS: &[&str] = &[":", "true", "false", "echo", "printf", "test", "["];
/// Bash builtins the host's builtin hook owns.
const HOSTED_BUILTINS: &[&str] = &["cd", "pwd", "rm", "export"];
/// Bash builtins that need the shell's own state (variables, positional
/// parameters, control flow, jobs): refused inside a Lisp expression.
const STATEFUL_BUILTINS: &[&str] = &[
  ".", "source", "alias", "unalias", "bg", "fg", "jobs", "kill", "wait", "disown", "exec", "eval",
  "trap", "shopt", "read", "local", "declare", "typeset", "readonly", "getopts", "shift", "return",
  "break", "continue", "exit", "set", "unset", "let", "mapfile", "readarray", "command", "type",
  "hash", "umask", "times", "ulimit", "builtin", "enable", "caller", "dirs", "pushd", "popd",
];

/// The interpreter's call-head hook: a nested `(name arg…)` whose head names
/// nothing in Lisp resolves by bash's lookup (argv.md I13) — shell function,
/// bash builtin, then `PATH` (a tsh command is a native in the env, so it never
/// gets here). Arguments convert by I11. A program runs through the external
/// host's blocking runner; a host without one refuses the call loudly.
pub(super) fn call_head_hook(
  nested: Rc<RefCell<NestedCommands>>,
  io: Rc<RefCell<Option<super::ShellIo>>>,
  status: Rc<std::cell::Cell<i32>>,
) -> tento_lisp::CallHeadHook<Sym> {
  Rc::new(move |name: &str, args: &mut tento_lisp::CallArgs<'_, Sym>| {
    let commands = nested.borrow().clone();
    let refused = |what: &str| {
      Some(Err(tento_lisp::RuntimeError::Command {
        detail: format!("{name}: {what} cannot run inside a Lisp expression yet; run it on a bash line"),
      }))
    };
    if commands.functions.iter().any(|function| function == name) {
      return refused("a shell function");
    }
    if super::bash_lisp_bridge::strict_lisp() && super::bash_lisp_bridge::is_bash_word(name) {
      let operands = match args() {
        Ok(args) => nested_argv(name, args).split_off(1),
        Err(error) => return Some(Err(error)),
      };
      return Some(Err(tento_lisp::RuntimeError::Command {
        detail: super::bash_lisp_bridge::bash_word_hint(name, &operands),
      }));
    }
    if STATEFUL_BUILTINS.contains(&name) {
      return refused("this shell builtin");
    }
    let builtin = PURE_BUILTINS.contains(&name) || HOSTED_BUILTINS.contains(&name);
    let lookup = commands.external.as_ref().map(|external| external.lookup(name));
    if !builtin && !matches!(lookup, Some(ExternalLookup::Runs | ExternalLookup::Undeclared(_))) {
      return None;
    }
    let argv = match args() {
      Ok(args) => nested_argv(name, args),
      Err(error) => return Some(Err(error)),
    };
    if builtin {
      if let Some(result) = run_nested_builtin(&commands, &io, &status, argv.clone()) {
        return Some(result);
      }
    }
    let Some(external) = &commands.external else {
      return None;
    };
    match external.lookup(name) {
      ExternalLookup::Runs => {}
      ExternalLookup::Undeclared(path) => {
        return Some(Err(tento_lisp::RuntimeError::Command {
          detail: super::interp::undeclared_external(name, &path).to_string(),
        }));
      }
      ExternalLookup::NotFound => return None,
    }
    let mut argv = argv;
    super::shell_printf::prepare_printf_argv(&mut argv);
    let Some(result) = external.run_blocking(argv) else {
      return Some(Err(tento_lisp::RuntimeError::Command {
        detail: format!("{name}: cannot run inside a Lisp expression on this host"),
      }));
    };
    Some(match result {
      Ok(value) => {
        status.set(0);
        Ok(super::value_from_json(&value))
      }
      // A failed program is an error that carries its status. An exit status
      // adds no message, as at top level (I14): the child already spoke.
      Err(error) => {
        let code = error.process_status().unwrap_or(1);
        status.set(code);
        let detail = match &error {
          crate::Error::ProcessExit { status: Some(_), .. } => String::new(),
          other => other.to_string(),
        };
        Err(tento_lisp::RuntimeError::Exit { status: code, detail })
      }
    })
  })
}

/// The argv of a nested call by I11: strings verbatim, a literal keyword a
/// flag, an option map its options, anything else its printed value.
fn nested_argv(name: &str, args: Vec<tento_lisp::CallArg<Sym>>) -> Vec<String> {
  let mut argv = vec![name.to_string()];
  for arg in args {
    match arg {
      tento_lisp::CallArg::Keyword(flag) => argv.push(option_flag(&flag)),
      tento_lisp::CallArg::Value(LispValue::String(text)) => argv.push(text.into_string()),
      tento_lisp::CallArg::Value(LispValue::Map(options)) => {
        for (option, value) in options {
          push_option(&mut argv, option.trim_start_matches(':'), value);
        }
      }
      tento_lisp::CallArg::Value(other) => {
        argv.extend(super::lisp_args_to_argv("", vec![other]).into_iter().skip(1));
      }
    }
  }
  argv
}

/// Run a bash builtin for a nested call: its bytes go where the shell's
/// stdout and stderr go, its status becomes `$?`. `true`, `false`, `:`,
/// `test` and `[` answer a boolean, so `(if (test "-f" path) …)` reads as Lisp;
/// the others answer nil, or an error carrying a failed status. `None`: the
/// host does not own this builtin (or `printf` needs the program).
fn run_nested_builtin(
  commands: &NestedCommands,
  io: &Rc<RefCell<Option<super::ShellIo>>>,
  status: &Rc<std::cell::Cell<i32>>,
  argv: Vec<String>,
) -> Option<Result<LispValue<Sym>, tento_lisp::RuntimeError>> {
  let name = argv[0].clone();
  let admitted = commands.gate.as_ref().map_or(Ok(()), |gate| gate(&name));
  let result = match admitted {
    Err(error) => Err(error),
    Ok(()) => match name.as_str() {
      ":" | "true" => Ok(super::ShellBuiltinOutput::default()),
      "false" => Ok(super::ShellBuiltinOutput { status: 1, ..Default::default() }),
      "echo" => Ok(super::ShellBuiltinOutput::success(super::shell_commands::echo_bytes(&argv[1..]))),
      "printf" => Ok(super::bash_printf::run_detached(&argv[1..])),
      "test" | "[" => Ok(super::shell_test(&name, &argv[1..])),
      _ => commands.builtin.as_ref().and_then(|builtin| builtin(argv, commands.prompt))?,
    },
  };
  let output = match result {
    Ok(output) => output,
    Err(error) => super::ShellBuiltinOutput {
      status: error.process_status().unwrap_or(1),
      diagnostics: vec![format!("tsh: {error}")],
      ..Default::default()
    },
  };
  write_nested(commands, io, 1, &output.stdout);
  for diagnostic in &output.diagnostics {
    write_nested(commands, io, 2, format!("{diagnostic}\n").as_bytes());
  }
  status.set(output.status);
  Some(match name.as_str() {
    ":" | "true" | "false" | "test" | "[" => Ok(LispValue::Boolean(output.status == 0)),
    _ if output.status == 0 => Ok(LispValue::Nil),
    _ => Err(tento_lisp::RuntimeError::Exit { status: output.status, detail: String::new() }),
  })
}

/// Write a nested builtin's bytes to the shell's descriptor `fd`: a redirect
/// in force, else the host's output sink, else this process's descriptor.
fn write_nested(commands: &NestedCommands, io: &Rc<RefCell<Option<super::ShellIo>>>, fd: i32, bytes: &[u8]) {
  if bytes.is_empty() {
    return;
  }
  let target = io.borrow().as_ref().map_or(super::FdTarget::Inherit(fd), |io| io.target(fd));
  let sink = if fd == 1 { &commands.byte_output } else { &commands.stderr_output };
  match (target.clone(), sink) {
    (super::FdTarget::Inherit(inherited), Some(sink)) if inherited == fd => sink(bytes),
    _ => {
      let _ = super::shell_redirect::write_target(&target, bytes);
    }
  }
}
