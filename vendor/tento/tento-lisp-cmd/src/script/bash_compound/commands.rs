//! Bash builtins operate on the current host, without a host-shell handoff.
use super::*;
use std::cell::Cell;
use tento_lisp::{Function, NativeClosure, RuntimeError};

#[derive(Clone, Copy, Default)]
pub(in crate::script) struct GlobOptions {
  pub nullglob: bool,
  pub failglob: bool,
  pub dotglob: bool,
  pub nocaseglob: bool,
  pub globstar: bool,
}

#[derive(Default)]
pub(in crate::script) struct CommandState {
  pub brace_disabled: Rc<Cell<bool>>,
  pub nounset: Rc<Cell<bool>>,
  pub unset_value: Option<NativeClosure<Sym>>,
  pub xtrace: bool,
  /// The shell's descriptors before a traced simple command's own
  /// redirections: its trace line goes there, as bash's does.
  pub trace_io: Option<Option<super::super::ShellIo>>,
  /// The descriptors before a redirected simple command's own redirections,
  /// handed to that command alone: bash expands its words before applying
  /// them, so an expansion error is written to the outer stderr.
  pub expansion_io: Option<Option<super::super::ShellIo>>,
  /// The same descriptors while that command's words expand, for a warning
  /// raised inside the expansion (`$(< missing)`).
  pub expansion_report_io: Option<Option<super::super::ShellIo>>,
  /// bash's indirection level (eval, command substitution): the first
  /// character of `$PS4` repeats once more per level.
  pub trace_level: usize,
  pub pipefail: bool,
  /// `shopt -s inherit_errexit`: command substitutions keep `-e`.
  pub inherit_errexit: bool,
  /// `shopt -s nocasematch`: `case` and `[[ == ]]` ignore case.
  pub nocasematch: bool,
  /// `shopt -s lastpipe`: a pipeline's last stage runs in this shell.
  pub lastpipe: bool,
  /// `set -E`: functions, substitutions and subshells inherit the ERR trap.
  pub errtrace: bool,
  /// `set -T`: they inherit the DEBUG and RETURN traps.
  pub functrace: bool,
  /// How many times `umask` changed the mask, so a subshell knows to undo it.
  pub umask_changes: usize,
  pub noclobber: bool,
  pub glob: Rc<Cell<GlobOptions>>,
  pub traps: HashMap<String, String>,
  /// A subshell's view of its parent's traps, for `trap -p` only.
  pub inherited_traps: HashMap<String, String>,
  pub in_trap: bool,
  pub persistent_io: Option<super::super::ShellIo>,
  pub open: Option<super::super::shell_redirect::ShellOptionsFileOpener>,
  #[cfg(unix)]
  pub signals: std::collections::BTreeSet<i32>,
  pub jobs: super::super::shell_jobs::JobTable,
  /// Owned-I/O fork reservations this host's command units hold
  /// (`owned_io_fork`).
  pub fork_cover: super::super::owned_io_fork::ForkCover,
  pub last_pid: Rc<Cell<u32>>,
  pub rematch: Rc<RefCell<Vec<String>>>,
  pub process_fds: Rc<RefCell<Vec<i32>>>,
  pub attributes: Rc<RefCell<HashMap<String, super::super::bash_arrays::VarAttributes>>>,
  pub expansion_failure: Rc<RefCell<Option<String>>>,
  /// The pending failure is a parameter error (`${x:?}`, nounset, a bad
  /// substitution): bash ends a top-level `-c` string with 127 for those,
  /// and with 1 for every other expansion error.
  pub expansion_failure_127: Rc<Cell<bool>>,
  /// The pending failure is an arithmetic one (`$((1/0))`, a negative
  /// substring length): bash discards the command even under `set -e`,
  /// where its other expansion errors end the shell.
  pub expansion_failure_arithmetic: Rc<Cell<bool>>,
  pub getopts_index: usize,
  pub getopts_offset: usize,
  /// Aliases a script recorded (argv.md D2a). Non-interactive bash leaves
  /// `expand_aliases` off, so a recorded alias lists and unsets but never expands.
  pub aliases: std::collections::BTreeMap<String, String>,
}

impl LispHost {
  pub(in crate::script) fn register_shell_option_natives(&mut self) {
    for (name, value) in [("OPTIND", "1"), ("OPTERR", "1"), ("BASH_SUBSHELL", "0")] {
      let symbol = self.interp.string_interner().get_or_intern(name);
      if self.env.borrow().get(symbol).is_none() {
        self.env.borrow_mut().define(symbol, LispValue::String(value.into()));
      }
    }
    let disabled = self.shell_compound.commands.brace_disabled.clone();
    let toggle: NativeClosure<Sym> = Rc::new(move |_, args| {
      if !args.is_empty() {
        return Err(RuntimeError::Other(
          "std.sh.brace-enabled: expected no arguments".into(),
        ));
      }
      Ok(LispValue::Boolean(!disabled.get()))
    });
    let symbol = self
      .interp
      .string_interner()
      .get_or_intern("std.sh.brace-enabled");
    self
      .env
      .borrow_mut()
      .define(symbol, LispValue::Function(Function::NativeClosure(toggle)));
    let pid = self.shell_compound.commands.last_pid.clone();
    let nounset = self.shell_compound.commands.nounset.clone();
    let failure = self.shell_compound.commands.expansion_failure.clone();
    let status_127 = self.shell_compound.commands.expansion_failure_127.clone();
    // `(std.jobs.last)`, bash's `$!` (argv.md I17): the pid of the most
    // recent background job as a word, kept after the job is waited for, as
    // bash keeps it; empty when no job has started, an unbound-variable
    // failure under `set -u`. `(std.jobs.show (std.jobs.last))` is its job.
    let last_pid: NativeClosure<Sym> = Rc::new(move |_, args| {
      if !args.is_empty() {
        return Err(RuntimeError::Other(
          "std.jobs.last: expected no arguments".into(),
        ));
      }
      if pid.get() == 0 && nounset.get() {
        // A `set -u` failure: reported by the flow, which ends the script.
        status_127.set(true);
        failure.replace(Some("$!: unbound variable".into()));
        return Err(RuntimeError::Fatal { detail: "$!: unbound variable".into() });
      }
      Ok(LispValue::String(if pid.get() == 0 {
        String::new().into()
      } else {
        pid.get().to_string().into()
      }))
    });
    let redirect_fields: NativeClosure<Sym> = Rc::new(move |_, args| {
      let [LispValue::List(fields), LispValue::String(source)] = args.as_slice() else {
        return Err(RuntimeError::Other(
          "std.sh.redirect-fields: expected FIELDS SOURCE".into(),
        ));
      };
      if fields.items.len() != 1 {
        return Err(RuntimeError::Command { detail: format!("{source}: ambiguous redirect") });
      }
      Ok(fields.items[0].clone())
    });
    let rematch = self.shell_compound.commands.rematch.clone();
    let rematch: NativeClosure<Sym> = Rc::new(move |_, args| {
      let [LispValue::String(index)] = args.as_slice() else {
        return Err(RuntimeError::Other("std.sh.rematch: expected INDEX".into()));
      };
      Ok(LispValue::String(
        index
          .parse::<usize>()
          .ok()
          .and_then(|i| rematch.borrow().get(i).cloned())
          .unwrap_or_default().into(),
      ))
    });
    self.native_defs.push(tento_lisp::LAST_JOB_FORM.into());
    for (name, native) in [
      (tento_lisp::LAST_JOB_FORM, last_pid.clone()),
      // The pre-I17 spelling of `$!`, for forms compiled before it.
      ("std.sh.last-pid", last_pid),
      ("std.sh.redirect-fields", redirect_fields),
      ("std.sh.rematch", rematch),
    ] {
      let symbol = self.interp.string_interner().get_or_intern(name);
      self
        .env
        .borrow_mut()
        .define(symbol, LispValue::Function(Function::NativeClosure(native)));
    }
    self.register_job_natives();
  }

  pub(in crate::script) fn set_shell_options(
    &mut self,
    args: &[String],
  ) -> Result<Option<JsonValue>> {
    let mut i = 0;
    while i < args.len() {
      let arg = &args[i];
      if arg == "--" {
        self
          .shell_compound
          .positional
          .replace(args[i + 1..].to_vec());
        self.set_shell_status(0);
        return Ok(None);
      }
      if arg == "-" {
        self.shell_compound.commands.xtrace = false;
        i += 1;
        break;
      }
      if !arg.starts_with(['-', '+']) || arg.len() == 1 {
        break;
      }
      let enabled = arg.starts_with('-');
      if arg == "-o" || arg == "+o" {
        i += 1;
        let Some(name) = args.get(i) else {
          return self.list_shell_options(enabled);
        };
        self.set_shell_option(name, enabled)?;
      } else {
        for flag in arg[1..].chars() {
          if flag == 'o' {
            i += 1;
            let Some(name) = args.get(i) else {
              return self.list_shell_options(enabled);
            };
            self.set_shell_option(name, enabled)?;
            continue;
          }
          self.set_shell_option(
            match flag {
              'e' => "errexit",
              'u' => "nounset",
              'f' => "noglob",
              'x' => "xtrace",
              'B' => "braceexpand",
              'C' => "noclobber",
              'E' => "errtrace",
              'T' => "functrace",
              _ => {
                return Err(TshScriptErrorKind::Lisp(LispHostError::Command(format!(
                  "set: {flag}: unsupported option"
                ))));
              }
            },
            enabled,
          )?;
        }
      }
      i += 1;
    }
    if i < args.len() {
      self.shell_compound.positional.replace(args[i..].to_vec());
    }
    if args.is_empty() {
      return Err(TshScriptErrorKind::Lisp(LispHostError::Command(
        "set: variable listing is not supported yet".into(),
      )));
    }
    self.set_shell_status(0);
    Ok(None)
  }

  /// `set -o` (a `name<TAB>on|off` table) or `set +o` (the `set ±o name`
  /// commands that restore it), over bash 5.3's option names.
  /// A `set -o` option's state; `None` for a name bash does not know.
  pub(in crate::script) fn shell_option_state(&self, name: &str) -> Option<bool> {
    let commands = &self.shell_compound.commands;
    Some(match name {
      "braceexpand" => !commands.brace_disabled.get(),
      "errexit" => self.shell_errexit,
      "hashall" | "interactive-comments" => true,
      "noclobber" => commands.noclobber,
      "noglob" => self.shell_compound.noglob.get(),
      "nounset" => commands.nounset.get(),
      "pipefail" => commands.pipefail,
      "xtrace" => commands.xtrace,
      "errtrace" => commands.errtrace,
      "functrace" => commands.functrace,
      _ if SET_OPTION_NAMES.contains(&name) => false,
      _ => return None,
    })
  }

  fn list_shell_options(&mut self, table: bool) -> Result<Option<JsonValue>> {
    let mut text = String::new();
    for name in SET_OPTION_NAMES {
      let on = self.shell_option_state(name) == Some(true);
      if table {
        text.push_str(&format!("{name:<15}\t{}\n", if on { "on" } else { "off" }));
      } else {
        text.push_str(&format!("set {}o {name}\n", if on { '-' } else { '+' }));
      }
    }
    let output = self.shell_output.borrow().clone();
    output.write_bytes(self, text.as_bytes());
    self.set_shell_status(0);
    Ok(None)
  }

  fn set_shell_option(&mut self, name: &str, enabled: bool) -> Result<()> {
    match name {
      "errexit" => self.shell_errexit = enabled,
      "nounset" => self.shell_compound.commands.nounset.set(enabled),
      "noglob" => self.shell_compound.noglob.set(enabled),
      "xtrace" => self.shell_compound.commands.xtrace = enabled,
      "braceexpand" => self.shell_compound.commands.brace_disabled.set(!enabled),
      "noclobber" => self.shell_compound.commands.noclobber = enabled,
      "pipefail" => self.shell_compound.commands.pipefail = enabled,
      "errtrace" => self.shell_compound.commands.errtrace = enabled,
      "functrace" => self.shell_compound.commands.functrace = enabled,
      _ => {
        return Err(TshScriptErrorKind::Lisp(LispHostError::Command(format!(
          "set: {name}: unsupported option"
        ))));
      }
    }
    Ok(())
  }

  /// The state of a `shopt` option this shell implements, or of one whose
  /// bash default it keeps; `None` for a name bash does not know.
  fn shopt_state(&self, name: &str) -> Option<bool> {
    let glob = self.shell_compound.commands.glob.get();
    let commands = &self.shell_compound.commands;
    Some(match name {
      "nullglob" => glob.nullglob,
      "failglob" => glob.failglob,
      "dotglob" => glob.dotglob,
      "nocaseglob" => glob.nocaseglob,
      "globstar" => glob.globstar,
      "inherit_errexit" => commands.inherit_errexit,
      "nocasematch" => commands.nocasematch,
      "lastpipe" => commands.lastpipe,
      _ if SHOPT_DEFAULT_ON.contains(&name) => true,
      _ if SHOPT_DEFAULT_OFF.contains(&name) => false,
      _ => return None,
    })
  }

  /// bash `shopt [-pqsu] [optname ...]`. An option tsh does not implement
  /// may be set to the value it already has; changing it is refused loudly.
  pub(in crate::script) fn shopt_command(&mut self, args: &[String], line: usize, output: FlowOutput) -> Result<Option<JsonValue>> {
    let (mut set, mut unset, mut print, mut quiet) = (false, false, false, false);
    let mut index = 0;
    while let Some(arg) = args.get(index) {
      if arg == "--" {
        index += 1;
        break;
      }
      if arg.len() < 2 || !arg.starts_with('-') {
        break;
      }
      for flag in arg[1..].chars() {
        match flag {
          's' => set = true,
          'u' => unset = true,
          'p' => print = true,
          'q' => quiet = true,
          other => {
            self.report_shell_diagnostic(format!("tsh: line {line}: shopt: -{other}: invalid option"));
            self.report_shell_diagnostic("shopt: usage: shopt [-pqsu] [-o] [optname ...]".into());
            self.set_shell_status(2);
            return Ok(None);
          }
        }
      }
      index += 1;
    }
    if set && unset {
      self.report_shell_diagnostic(format!("tsh: line {line}: shopt: cannot set and unset shell options simultaneously"));
      self.set_shell_status(1);
      return Ok(None);
    }
    let names: Vec<String> = if index < args.len() {
      args[index..].to_vec()
    } else if set || unset {
      return Err(invalid("shopt option listing is not supported yet"));
    } else {
      SHOPT_NAMES.iter().map(|name| name.to_string()).collect()
    };
    let mut status = 0;
    let mut text = String::new();
    let mut options = self.shell_compound.commands.glob.get();
    for name in &names {
      let Some(current) = self.shopt_state(name) else {
        self.report_shell_diagnostic(format!("tsh: line {line}: shopt: {name}: invalid shell option name"));
        status = 1;
        continue;
      };
      if !(set || unset) {
        if !current {
          status = 1;
        }
        if quiet {
          continue;
        }
        let flag = if current { 's' } else { 'u' };
        if print {
          text.push_str(&format!("shopt -{flag} {name}\n"));
        } else {
          text.push_str(&format!("{name:<20}\t{}\n", if current { "on" } else { "off" }));
        }
        continue;
      }
      let enabled = set;
      match name.as_str() {
        "nullglob" => options.nullglob = enabled,
        "failglob" => options.failglob = enabled,
        "dotglob" => options.dotglob = enabled,
        "nocaseglob" => options.nocaseglob = enabled,
        "globstar" => options.globstar = enabled,
        "inherit_errexit" => self.shell_compound.commands.inherit_errexit = enabled,
        "nocasematch" => self.shell_compound.commands.nocasematch = enabled,
        "lastpipe" => self.shell_compound.commands.lastpipe = enabled,
        // argv.md D2a: aliases are record-only until macros land, so turning
        // expansion on is refused with the function to write instead.
        "expand_aliases" if enabled => {
          return Err(TshScriptErrorKind::Lisp(LispHostError::Command(
            "shopt: expand_aliases: aliases do not expand until macros; define a function: \
             name() { command value \"$@\"; }"
              .into(),
          )));
        }
        // tsh ruling (Q7/Q8): extended globs are always parsed.
        "extglob" if !enabled => {
          return Err(TshScriptErrorKind::Lisp(LispHostError::Command(
            "shopt: extglob: always on in tsh".into(),
          )));
        }
        _ if current == enabled => {}
        _ => {
          return Err(TshScriptErrorKind::Lisp(LispHostError::Command(format!(
            "shopt: {name}: not supported yet"
          ))));
        }
      }
    }
    self.shell_compound.commands.glob.set(options);
    if !text.is_empty() {
      output.write_bytes(self, text.as_bytes());
    }
    self.set_shell_status(status);
    Ok(None)
  }

  pub(in crate::script) async fn command_builtin(
    &mut self,
    argv: &[String],
    line: usize,
    ignored: bool,
    output: FlowOutput,
  ) -> Option<Result<Option<JsonValue>>> {
    let name = argv.first()?.as_str();
    let args = &argv[1..];
    Some(match name {
      "." | "source" => {
        let result = self.source_shell_file(name, args, line, ignored, output.clone()).await;
        // RETURN fires when a sourced file finishes, as bash's does.
        self.run_shell_trap("RETURN", line, output).await.and(result)
      }
      "mapfile" | "readarray" => self.mapfile_command(args, line),
      "eval" => {
        // bash: `--` ends options, any other leading dash word is an invalid
        // option, a blank string succeeds, and a syntax error is status 2
        // without stopping the script.
        let args = args.strip_prefix(&["--".to_string()]).unwrap_or(args);
        if let Some(option) = args.first().filter(|arg| arg.starts_with('-') && arg.len() > 1 && *arg != "--") {
          self.report_shell_diagnostic(format!(
            "tsh: line {line}: eval: {option}: invalid option\neval: usage: eval [arg ...]"
          ));
          self.set_shell_status(2);
          Ok(None)
        } else if args.join(" ").trim().is_empty() {
          self.set_shell_status(0);
          Ok(None)
        } else {
          match self.read_posix_line_value(&args.join(" ")) {
            Ok(value) => {
              self.shell_compound.commands.trace_level += 1;
              let result = eval_flow(self, &value, line, ignored, output.plain(), false).await;
              self.shell_compound.commands.trace_level -= 1;
              // An expansion error abandons the eval'd string, not the caller.
              match result {
                Err(TshScriptErrorKind::Control(ControlSignal::Discard(status))) => {
                  self.set_shell_status(status);
                  Ok(None)
                }
                result => result,
              }
            }
            Err(error) => {
              self.report_shell_diagnostic(format!("tsh: line {line}: eval: {error}"));
              self.set_shell_status(2);
              Ok(None)
            }
          }
        }
      }
      "exec" => {
        // bash's options: `--`, `-c` (empty environment), `-a NAME` (argv[0])
        // and `-l` (argv[0] with a leading `-`, a login shell's spelling).
        let usage = "exec: usage: exec [-cl] [-a name] [command [argument ...]] [redirection ...]";
        let mut args = args.to_vec();
        let (mut clear, mut login, mut argv0) = (false, false, None::<String>);
        while let Some(arg) = args.first().filter(|arg| arg.starts_with('-') && arg.len() > 1).cloned() {
          args.remove(0);
          if arg == "--" {
            break;
          }
          let flags: Vec<char> = arg[1..].chars().collect();
          for (at, flag) in flags.iter().enumerate() {
            match flag {
              'c' => clear = true,
              'l' => login = true,
              'a' => {
                let attached: String = flags[at + 1..].iter().collect();
                if !attached.is_empty() {
                  argv0 = Some(attached);
                } else if args.is_empty() {
                  self.report_shell_diagnostic(format!("tsh: line {line}: exec: -a: option requires an argument\n{usage}"));
                  self.set_shell_status(2);
                  return Some(Ok(None));
                } else {
                  argv0 = Some(args.remove(0));
                }
                break;
              }
              _ => {
                self.report_shell_diagnostic(format!("tsh: line {line}: exec: -{flag}: invalid option\n{usage}"));
                self.set_shell_status(2);
                return Some(Ok(None));
              }
            }
          }
        }
        let launch = (!args.is_empty() && (clear || login || argv0.is_some())).then(|| {
          let name = argv0.clone().unwrap_or_else(|| args[0].clone());
          super::super::process_pipeline::ExecLaunch {
            argv0: (login || argv0.is_some()).then(|| if login { format!("-{name}") } else { name }),
            clear_environment: clear,
          }
        });
        let args = args.as_slice();
        let path = std::path::Path::new(args.first().map_or("", String::as_str));
        if args.is_empty() {
          self.set_shell_status(0);
          Ok(None)
        } else if args[0].contains('/') && path.exists() && (path.is_dir() || !super::super::bash_type::executable(path)) {
          // A path that exists but cannot run: 126, and the shell exits.
          let reason = if path.is_dir() { "Is a directory" } else { "Permission denied" };
          self.report_shell_diagnostic(format!("tsh: line {line}: {}: {reason}", args[0]));
          self.set_shell_status(126);
          Err(TshScriptErrorKind::Control(ControlSignal::Exit(126)))
        } else {
          let Some(external) = self.external.clone() else {
            return Some(Err(invalid("exec external host is not installed")));
          };
          if !matches!(
            external.lookup(&args[0]),
            super::super::ExternalLookup::Runs
          ) {
            self.set_shell_status(127);
            self.report_shell_diagnostic(format!(
              "tsh: line {line}: exec: {}: not found",
              args[0]
            ));
            Err(TshScriptErrorKind::Control(ControlSignal::Exit(127)))
          } else {
            let mut io = self.shell_io.borrow().clone();
            // argv[0] and `-c` ride the in-process launcher (one stage).
            if let Some(launch) = launch {
              super::super::process_pipeline::set_exec_launch(launch);
              io.get_or_insert_with(Default::default);
            }
            let (status, replaced) = if output.capture.is_some() || io.is_some() {
              let captured = self
                .run_shell_pipeline(
                  vec![args.to_vec()],
                  self.shell_stdin_bytes(),
                  output.capture.is_some(),
                  vec![io],
                )
                .await
                .map_err(TshScriptErrorKind::Command);
              match captured {
                Ok(captured) => {
                  let replaced = captured.start_errors.is_empty();
                  for (status, detail) in captured.start_errors {
                    if let Some(diagnostic) = super::super::runner::bash_command_diagnostic(
                      line,
                      &crate::Error::ProcessStart { status, detail },
                    ) {
                      self.report_shell_diagnostic(diagnostic);
                    }
                  }
                  output.write_bytes(self, &captured.stdout);
                  (captured.status, replaced)
                }
                Err(error) => return Some(Err(error)),
              }
            } else {
              match external.run(args.to_vec()).await {
                Ok(_) => (0, true),
                Err(error) if error.process_status().is_some() => {
                  let replaced = matches!(error, crate::Error::ProcessExit { .. });
                  if let Some(diagnostic) =
                    super::super::runner::bash_command_diagnostic(line, &error)
                  {
                    self.report_shell_diagnostic(diagnostic);
                  }
                  (error.process_status().unwrap_or(1), replaced)
                }
                Err(error) => return Some(Err(TshScriptErrorKind::Command(error))),
              }
            };
            // A launch that never spawned must not reach a later program.
            super::super::process_pipeline::take_exec_launch();
            self.set_shell_status(status);
            Err(TshScriptErrorKind::Control(if replaced {
              ControlSignal::ExecExit(status)
            } else {
              ControlSignal::Exit(status)
            }))
          }
        }
      }
      "alias" => self.alias_builtin(args, line, output),
      "unalias" => self.unalias_builtin(args, line),
      "trap" => self.trap_builtin(args, line, output),
      "umask" => self.umask_builtin(args, line, output),
      "shopt" => self.shopt_command(args, line, output),
      "wait" => self.wait_builtin(args, line, output).await,
      "jobs" => self.jobs_builtin(args, line, output),
      "kill" => return self.kill_builtin(args, line, output),
      "disown" => self.disown_builtin(args, line),
      "fg" => self.fg_builtin(args, line, output).await,
      "bg" => self.bg_builtin(args, line, output),
      _ if name.starts_with("std.jobs.") => return self.std_jobs_line(argv, line, output).await,
      _ => return None,
    })
  }

  /// `alias` (argv.md D2a, interim until macros). At the interactive prompt and
  /// in interactive rc files a definition is refused with a function hint and
  /// nothing is listed; elsewhere it is bash's non-interactive record-only
  /// behaviour.
  fn alias_builtin(&mut self, args: &[String], line: usize, output: FlowOutput) -> Result<Option<JsonValue>> {
    let args = if args.first().is_some_and(|arg| arg == "--") { &args[1..] } else { args };
    let listing = args.is_empty() || args == ["-p"];
    if self.shell_prompt {
      self.set_shell_status(0);
      if listing {
        return Ok(None);
      }
      for arg in args.iter().filter(|arg| *arg != "-p") {
        let Some((name, value)) = arg.split_once('=') else {
          self.report_shell_diagnostic(format!("tsh: line {line}: alias: {arg}: not found"));
          self.set_shell_status(1);
          continue;
        };
        self.report_shell_diagnostic(format!(
          "tsh: line {line}: alias: aliases arrive with macros; define a function: {name}() {{ command {value} \"$@\"; }}"
        ));
        self.set_shell_status(1);
        break;
      }
      return Ok(None);
    }
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let mut text = String::new();
    let mut status = 0;
    if listing {
      for (name, value) in &self.shell_compound.commands.aliases {
        text.push_str(&format!("alias {name}={}\n", quote(value)));
      }
    }
    for arg in args.iter().filter(|arg| !listing && *arg != "-p") {
      match arg.split_once('=') {
        Some((name, value)) if !name.is_empty() && !name.contains(['/', ' ', '\t', '$', '`', '"', '\'', '\\']) => {
          self.shell_compound.commands.aliases.insert(name.to_string(), value.to_string());
        }
        Some((name, _)) => {
          self.report_shell_diagnostic(format!("tsh: line {line}: alias: `{name}': invalid alias name"));
          status = 1;
        }
        None => match self.shell_compound.commands.aliases.get(arg) {
          Some(value) => text.push_str(&format!("alias {arg}={}\n", quote(value))),
          None => {
            self.report_shell_diagnostic(format!("tsh: line {line}: alias: {arg}: not found"));
            status = 1;
          }
        },
      }
    }
    if !text.is_empty() {
      output.write_bytes(self, text.as_bytes());
    }
    self.set_shell_status(status);
    Ok(None)
  }

  fn unalias_builtin(&mut self, args: &[String], line: usize) -> Result<Option<JsonValue>> {
    let args = if args.first().is_some_and(|arg| arg == "--") { &args[1..] } else { args };
    if args.is_empty() {
      self.report_shell_diagnostic("unalias: usage: unalias [-a] name [name ...]".to_string());
      self.set_shell_status(2);
      return Ok(None);
    }
    let mut status = 0;
    for arg in args {
      if arg == "-a" {
        self.shell_compound.commands.aliases.clear();
      } else if self.shell_compound.commands.aliases.remove(arg).is_none() && !self.shell_prompt {
        self.report_shell_diagnostic(format!("tsh: line {line}: unalias: {arg}: not found"));
        status = 1;
      } else if self.shell_prompt {
        // Nothing is ever recorded at the prompt, so there is nothing to remove.
        self.report_shell_diagnostic(format!("tsh: line {line}: unalias: {arg}: not found"));
        status = 1;
      }
    }
    self.set_shell_status(status);
    Ok(None)
  }

  pub(in crate::script) async fn shell_trace_prefix(&mut self, line: usize) -> Result<String> {
    let call = self.shell_literal_call(
      &["std.sh.var".into(), "PS4".into(), "+ ".into()],
      "std.sh.var",
      false,
    );
    let prefix = self
      .evaluate_shell_data(&call)
      .map_err(TshScriptErrorKind::Lisp)?;
    let prefix = text(&prefix);
    let source = format!("echo \"{}\"", prefix.replace('"', "\\\""));
    let value = self
      .read_posix_line_value(&source)
      .map_err(TshScriptErrorKind::Lisp)?;
    let status = self.shell_status();
    let xtrace = self.shell_compound.commands.xtrace;
    self.shell_compound.commands.xtrace = false;
    // PS4's expansion is a unit of its own.
    let forks = super::super::owned_io_fork::words_fork(self, &value);
    let resolved = match self.reserve_fork_unit(forks, "PS4", line) {
      Ok(unit) => {
        let resolved = super::super::shell_redirect::resolve_target(self, &value, line).await;
        drop(unit);
        resolved
      }
      Err(refused) => Err(refused),
    };
    self.shell_compound.commands.xtrace = xtrace;
    self.set_shell_status(status);
    let resolved = resolved
      .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(format!("PS4: {error}"))))?;
    let argv = self
      .application_to_argv(&resolved)
      .map_err(TshScriptErrorKind::Command)?;
    let prefix = argv.get(1).cloned().unwrap_or_default();
    // bash repeats PS4's first character once per indirection level.
    Ok(match prefix.chars().next() {
      Some(first) => format!("{}{prefix}", first.to_string().repeat(self.shell_compound.commands.trace_level)),
      None => prefix,
    })
  }

  pub(in crate::script) async fn trace_shell_command(
    &mut self,
    argv: &[String],
    line: usize,
  ) -> Result<()> {
    if !self.shell_compound.commands.xtrace {
      return Ok(());
    }
    let prefix = self.shell_trace_prefix(line).await?;
    let words: Vec<_> = argv.iter().map(|s| trace_word(s)).collect();
    self.write_trace(format!("{prefix}{}", words.join(" ")));
    Ok(())
  }

  /// Write one xtrace line where bash does: to `$BASH_XTRACEFD` when it
  /// names a descriptor, else to the shell's stderr as it was before the
  /// traced command's own redirections.
  pub(in crate::script) fn write_trace(&mut self, text: String) {
    let outer = self.shell_compound.commands.trace_io.take();
    let saved = outer.map(|io| self.shell_io.replace(io));
    let symbol = self.interp.string_interner().get_or_intern("BASH_XTRACEFD");
    let fd = match self.env.borrow().get(symbol) {
      Some(LispValue::String(text)) => text.parse::<i32>().ok().filter(|fd| *fd >= 0 && *fd != 2),
      _ => None,
    };
    let redirected = fd.map(|fd| {
      let mut io = self.shell_io.borrow().clone().unwrap_or_default();
      let target = match io.target(fd) {
        super::super::FdTarget::Closed => super::super::FdTarget::Inherit(fd),
        target => target,
      };
      io.0.insert(2, target);
      self.shell_io.replace(Some(io))
    });
    self.report_shell_diagnostic(text);
    if let Some(previous) = redirected {
      *self.shell_io.borrow_mut() = previous;
    }
    if let Some(previous) = saved {
      *self.shell_io.borrow_mut() = previous;
    }
  }

  pub(in crate::script) async fn condition_command(
    &mut self,
    args: &[LispValue<Sym>],
    line: usize,
    ignored: bool,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    let Some(LispValue::String(op)) = args.first() else {
      return Err(invalid("[["));
    };
    // The operands are one unit: a later operand's fork refuses before an
    // earlier operand's substitution runs.
    let forks = args[1..]
      .iter()
      .any(|word| super::super::owned_io_fork::words_fork(self, word));
    let unit = self
      .reserve_fork_unit(forks, "[[ ]] operands", line)
      .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error)))?;
    let mut values = Vec::new();
    for word in &args[1..] {
      values.push(data(self, word, line).await?);
    }
    drop(unit);
    if self.shell_compound.commands.xtrace {
      // bash traces each primary with its expanded, unquoted operands.
      let word = |value: &JsonValue| match value.as_array() {
        Some(pairs) => pairs.iter().filter_map(|pair| pair.get(0)).map(text).collect::<String>(),
        None => text(value),
      };
      let words = match values.as_slice() {
        [left, right] => format!("{} {op} {}", word(left), word(right)),
        [operand] => format!("{op} {}", word(operand)),
        _ => op.to_string(),
      };
      let prefix = self.shell_trace_prefix(line).await?;
      self.write_trace(format!("{prefix}[[ {words} ]]"));
    }
    let left = values.first().map(text).unwrap_or_default();
    let status = if matches!(op.as_str(), "=" | "==" | "!=" | "=~") {
      let pairs = values
        .get(1)
        .and_then(JsonValue::as_array)
        .ok_or_else(|| invalid("[["))?;
      let mut pattern = String::new();
      for pair in pairs {
        let pair = pair.as_array().ok_or_else(|| invalid("[["))?;
        let value = text(&pair[0]);
        let active = pair.get(1).and_then(JsonValue::as_bool).unwrap_or(false);
        if op == "=~" && !active {
          pattern.push_str(&quote_regex(&value));
        } else {
          for c in value.chars() {
            if !active {
              pattern.push('\\');
            }
            pattern.push(c);
          }
        }
      }
      if op == "=~" {
        #[cfg(not(unix))]
        return Err(invalid(
          "[[ =~ POSIX regular expressions require a Unix host",
        ));
        match regex_matches(&pattern, &left) {
          Err(_) => 2,
          Ok(matched) => {
            self
              .shell_compound
              .commands
              .rematch
              .replace(matched.clone().unwrap_or_default());
            let symbol = self.interp.string_interner().get_or_intern("BASH_REMATCH");
            self.env.borrow_mut().define(
              symbol,
              LispValue::List(tento_lisp::List {
                items: matched
                  .clone()
                  .unwrap_or_default()
                  .into_iter()
                  .map(|value| LispValue::String(value.into()))
                  .collect(),
              }),
            );
            if matched.is_some() {
              0
            } else {
              1
            }
          }
        }
      } else {
        let matched = self.shell_case_matches(&pattern, &left);
        if matched == (op != "!=") {
          0
        } else {
          1
        }
      }
    } else if op == "<" || op == ">" {
      let right = values.get(1).map(text).unwrap_or_default();
      if if op == "<" {
        left < right
      } else {
        left > right
      } {
        0
      } else {
        1
      }
    } else if matches!(op.as_str(), "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge") {
      let right = values.get(1).map(text).unwrap_or_default();
      let arithmetic = |host: &mut Self, source: &str| -> Result<i64> {
        let call = host.shell_literal_call(&["std.sh.arith".into(), source.into()], "std.sh.arith", false);
        let value = host
          .evaluate_shell_data(&call)
          .map_err(TshScriptErrorKind::Lisp)?;
        text(&value).parse().map_err(|_| invalid("[[ arithmetic"))
      };
      let left = arithmetic(self, &left)?;
      let right = arithmetic(self, &right)?;
      let matched = match op.as_str() {
        "-eq" => left == right,
        "-ne" => left != right,
        "-lt" => left < right,
        "-le" => left <= right,
        "-gt" => left > right,
        _ => left >= right,
      };
      if matched {
        0
      } else {
        1
      }
    } else if op == "-v" {
      if self.shell_variable_is_set(&left) { 0 } else { 1 }
    } else if op == "-o" && values.len() == 1 {
      // `-o OPTNAME`: true when the `set -o` option is on.
      i32::from(self.shell_option_state(&left) != Some(true))
    } else if op == "-R" && values.len() == 1 {
      let nameref = self.shell_compound.commands.attributes.borrow().get(&left).is_some_and(|a| a.nameref);
      i32::from(!(nameref && self.shell_variable_is_set(&left)))
    } else if op == "-N" && values.len() == 1 {
      // Modified since it was last read: mtime after atime.
      let modified = std::fs::metadata(&left).ok().and_then(|meta| Some(meta.modified().ok()? > meta.accessed().ok()?));
      i32::from(modified != Some(true))
    } else {
      let mut argv = vec!["test".into()];
      if values.len() == 1 {
        argv.push(op.to_string());
        argv.push(left);
      } else {
        argv.push(left);
        argv.push(op.to_string());
        argv.push(values.get(1).map(text).unwrap_or_default());
      }
      let result = self
        .shell_builtin_bytes(argv, line)
        .ok_or_else(|| invalid("[[ file/numeric test host is not installed"))?;
      for diagnostic in result.diagnostics {
        self.report_shell_diagnostic(diagnostic);
      }
      result.status
    };
    self.set_shell_status(status);
    if status != 0 && self.shell_errexit && !ignored {
      Err(TshScriptErrorKind::BashStatus(status))
    } else {
      Ok(None)
    }
  }
}

/// bash 5.3's `set -o` names, in its listing order.
const SET_OPTION_NAMES: &[&str] = &[
  "allexport", "braceexpand", "emacs", "errexit", "errtrace", "functrace", "hashall",
  "histexpand", "history", "ignoreeof", "interactive-comments", "keyword", "monitor",
  "noclobber", "noexec", "noglob", "nolog", "notify", "nounset", "onecmd", "physical",
  "pipefail", "posix", "privileged", "verbose", "vi", "xtrace",
];

/// bash 5.3's `shopt` names, in its listing order.
const SHOPT_NAMES: &[&str] = &[
  "array_expand_once", "assoc_expand_once", "autocd", "bash_source_fullpath", "cdable_vars",
  "cdspell", "checkhash", "checkjobs", "checkwinsize", "cmdhist", "compat31", "compat32",
  "compat40", "compat41", "compat42", "compat43", "compat44", "complete_fullquote", "direxpand",
  "dirspell", "dotglob", "execfail", "expand_aliases", "extdebug", "extglob", "extquote",
  "failglob", "force_fignore", "globasciiranges", "globskipdots", "globstar", "gnu_errfmt",
  "histappend", "histreedit", "histverify", "hostcomplete", "huponexit", "inherit_errexit",
  "interactive_comments", "lastpipe", "lithist", "localvar_inherit", "localvar_unset",
  "login_shell", "mailwarn", "no_empty_cmd_completion", "nocaseglob", "nocasematch",
  "noexpand_translation", "nullglob", "patsub_replacement", "progcomp", "progcomp_alias",
  "promptvars", "restricted_shell", "shift_verbose", "sourcepath", "varredir_close", "xpg_echo",
];
/// The options a non-interactive bash 5.3 starts with on, whose behaviour
/// tsh already has.
const SHOPT_DEFAULT_ON: &[&str] = &[
  "checkwinsize", "cmdhist", "complete_fullquote", "extglob", "extquote", "force_fignore", "globasciiranges",
  "globskipdots", "hostcomplete", "interactive_comments", "patsub_replacement", "progcomp",
  "promptvars", "sourcepath",
];
/// The rest of bash's names start off.
const SHOPT_DEFAULT_OFF: &[&str] = &[
  "array_expand_once", "assoc_expand_once", "autocd", "bash_source_fullpath", "cdable_vars",
  "cdspell", "checkhash", "checkjobs", "compat31", "compat32", "compat40", "compat41", "compat42",
  "compat43", "compat44", "direxpand", "dirspell", "execfail", "expand_aliases", "extdebug",
  "gnu_errfmt", "histappend", "histreedit", "histverify", "huponexit", "lithist",
  "localvar_inherit", "localvar_unset", "login_shell", "mailwarn", "no_empty_cmd_completion",
  "noexpand_translation", "progcomp_alias", "restricted_shell", "shift_verbose", "varredir_close",
  "xpg_echo",
];

/// A word as bash's xtrace prints it: bare when nothing in it is special,
/// `$'…'` when it holds a control character, else single-quoted.
pub(in crate::script) fn trace_word(word: &str) -> String {
  if !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || "_-/.:=+,%@".contains(c)) {
    return word.to_string();
  }
  if word.chars().any(|c| c.is_control()) {
    let mut text = String::from("$'");
    for c in word.chars() {
      match c {
        '\n' => text.push_str("\\n"),
        '\t' => text.push_str("\\t"),
        '\r' => text.push_str("\\r"),
        '\x07' => text.push_str("\\a"),
        '\x08' => text.push_str("\\b"),
        '\x0b' => text.push_str("\\v"),
        '\x0c' => text.push_str("\\f"),
        '\x1b' => text.push_str("\\E"),
        '\'' => text.push_str("\\'"),
        '\\' => text.push_str("\\\\"),
        c if c.is_control() => text.push_str(&format!("\\{:03o}", c as u32)),
        c => text.push(c),
      }
    }
    text.push('\'');
    return text;
  }
  format!("'{}'", word.replace('\'', "'\\''"))
}

fn quote_regex(value: &str) -> String {
  let mut result = String::new();
  for c in value.chars() {
    if "\\.^$|?*+()[{]".contains(c) {
      result.push('\\');
    }
    result.push(c);
  }
  result
}

fn regex_capture_count(pattern: &[u8]) -> usize {
  let mut count = 0;
  let mut i = 0;
  while i < pattern.len() {
    match pattern[i] {
      b'\\' => {
        i += 2;
        continue;
      }
      b'[' => {
        i += 1;
        if matches!(pattern.get(i), Some(b'^')) {
          i += 1;
        }
        if matches!(pattern.get(i), Some(b']')) {
          i += 1;
        }
        while i < pattern.len() && pattern[i] != b']' {
          if pattern[i] == b'[' && matches!(pattern.get(i + 1), Some(b':' | b'.' | b'=')) {
            let closer = pattern[i + 1];
            i += 2;
            while i + 1 < pattern.len() && !(pattern[i] == closer && pattern[i + 1] == b']') {
              i += 1;
            }
            i += 2;
          } else {
            i += 1;
          }
        }
      }
      b'(' => count += 1,
      _ => {}
    }
    i += 1;
  }
  count
}

#[cfg(unix)]
fn regex_matches(pattern: &str, value: &str) -> std::result::Result<Option<Vec<String>>, String> {
  use std::ffi::CString;
  let pattern = CString::new(pattern).map_err(|_| "regular expression contains NUL")?;
  let input = CString::new(value).map_err(|_| "regular expression input contains NUL")?;
  let mut regex = std::mem::MaybeUninit::<libc::regex_t>::zeroed();
  let code = unsafe { libc::regcomp(regex.as_mut_ptr(), pattern.as_ptr(), libc::REG_EXTENDED) };
  if code != 0 {
    return Err("invalid regular expression".into());
  }
  let mut regex = unsafe { regex.assume_init() };
  let count = regex_capture_count(pattern.to_bytes()).saturating_add(1);
  if count > 1024 {
    unsafe {
      libc::regfree(&mut regex);
    }
    return Err("regular expression has too many captures".into());
  }
  let mut matches = vec![
    libc::regmatch_t {
      rm_so: -1,
      rm_eo: -1
    };
    count
  ];
  let code = unsafe { libc::regexec(&regex, input.as_ptr(), count, matches.as_mut_ptr(), 0) };
  unsafe {
    libc::regfree(&mut regex);
  }
  if code == libc::REG_NOMATCH {
    return Ok(None);
  }
  if code != 0 {
    return Err("regular expression could not be evaluated".into());
  }
  let mut captures = Vec::new();
  for matched in matches {
    if matched.rm_so < 0 {
      captures.push(String::new());
    } else {
      captures.push(
        value
          .get(matched.rm_so as usize..matched.rm_eo as usize)
          .ok_or("regular expression capture is not UTF-8")?
          .to_string(),
      );
    }
  }
  Ok(Some(captures))
}

#[cfg(not(unix))]
fn regex_matches(_pattern: &str, _value: &str) -> std::result::Result<Option<Vec<String>>, String> {
  Err("POSIX regular expressions require a Unix host".into())
}

impl Drop for CommandState {
  fn drop(&mut self) {
    #[cfg(unix)]
    for number in std::mem::take(&mut self.signals) {
      super::traps::signal_disposition::restore(number);
    }
  }
}
