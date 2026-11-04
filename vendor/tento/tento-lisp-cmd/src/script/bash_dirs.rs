//! bash's directory stack: `pushd`, `popd` and `dirs`, the `DIRSTACK`
//! array, and the shell variables a hosted `cd` reads (`CDPATH`). The
//! stack holds every entry but the current directory, top last, as bash's
//! `pushd_directory_list` does; the current directory is always entry 0.
//! Changing directory goes through the host's `cd` builtin, so the logical
//! path, CDPATH and the session mirror stay one implementation.
use std::collections::BTreeMap;

use tento_lisp::{Env, Value as LispValue};

use super::ShellBuiltinOutput;
use super::interp::LispHost;

const PUSHD_USAGE: &str = "pushd: usage: pushd [-n] [+N | -N | dir]";
const POPD_USAGE: &str = "popd: usage: popd [-n] [+N | -N]";
const DIRS_USAGE: &str = "dirs: usage: dirs [-clpv] [+N] [-N]";

/// Shell variables a hosted `cd` reads even when they are not exported.
const CD_VARIABLES: &[&str] = &["CDPATH", "HOME", "OLDPWD"];

/// One builtin's result as it accumulates.
struct Run {
  name: &'static str,
  line: usize,
  output: ShellBuiltinOutput,
}

impl Run {
  fn fail(mut self, status: i32, detail: impl std::fmt::Display) -> ShellBuiltinOutput {
    self.output.status = status;
    self
      .output
      .diagnostics
      .push(format!("tsh: line {}: {}: {detail}", self.line, self.name));
    self.output
  }

  fn usage(mut self, detail: impl std::fmt::Display, usage: &str) -> ShellBuiltinOutput {
    self
      .output
      .diagnostics
      .push(format!("tsh: line {}: {}: {detail}", self.line, self.name));
    self.output.diagnostics.push(usage.to_string());
    self.output.status = 2;
    self.output
  }
}

/// `~user`'s home from the user database (`getpwnam_r`).
#[cfg(unix)]
pub(super) fn user_home(user: &str) -> Option<String> {
  let name = std::ffi::CString::new(user).ok()?;
  // SAFETY: getpwnam_r writes only into `pw` and `buf`, which outlive the
  // borrowed `pw_dir` read below.
  unsafe {
    let mut pw: libc::passwd = std::mem::zeroed();
    let mut buf = vec![0u8; 4096];
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    if libc::getpwnam_r(
      name.as_ptr(),
      &mut pw,
      buf.as_mut_ptr().cast(),
      buf.len(),
      &mut out,
    ) != 0
      || out.is_null()
      || pw.pw_dir.is_null()
    {
      return None;
    }
    Some(
      std::ffi::CStr::from_ptr(pw.pw_dir)
        .to_string_lossy()
        .into_owned(),
    )
  }
}

#[cfg(not(unix))]
pub(super) fn user_home(_user: &str) -> Option<String> {
  None
}

/// The invoking user's home from the user database (`getpwuid_r`): what `~`
/// names when HOME is unset, as in bash.
#[cfg(unix)]
pub(super) fn login_home() -> Option<String> {
  // SAFETY: getpwuid_r writes only into `pw` and `buf`, which outlive the
  // borrowed `pw_dir` read below.
  unsafe {
    let mut pw: libc::passwd = std::mem::zeroed();
    let mut buf = vec![0u8; 4096];
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    if libc::getpwuid_r(libc::getuid(), &mut pw, buf.as_mut_ptr().cast(), buf.len(), &mut out) != 0
      || out.is_null()
      || pw.pw_dir.is_null()
    {
      return None;
    }
    Some(std::ffi::CStr::from_ptr(pw.pw_dir).to_string_lossy().into_owned())
  }
}

#[cfg(not(unix))]
pub(super) fn login_home() -> Option<String> {
  None
}

/// `+N`/`-N`: the sign and the number, or `None` when it is not one.
fn signed_number(word: &str) -> Option<Option<(char, i64)>> {
  let sign = word.chars().next().filter(|c| matches!(c, '+' | '-'))?;
  Some(
    word[1..]
      .trim()
      .parse::<i64>()
      .ok()
      .filter(|n| *n >= 0)
      .map(|n| (sign, n)),
  )
}

impl LispHost {
  /// A shell variable's text: the session environment first (where an
  /// exported or declared value lives), then a script-local binding.
  pub(super) fn shell_text_variable(&mut self, name: &str) -> Option<String> {
    if let Some(value) = tento_env::effective_var(name) {
      return Some(value);
    }
    let symbol = self.interp.string_interner().get_or_intern(name);
    match self.env.borrow().get(symbol) {
      Some(LispValue::String(text)) => Some(text.into_string()),
      _ => None,
    }
  }

  /// The reader's tilde switch: always on. `~` lowers to `(std.sh.tilde "")`,
  /// which reads `$HOME` as it stands when the word is expanded — the same
  /// line, a compound or a function body included (operator ruling Q9.10,
  /// 2026-10-06) — so the reader needs no home text.
  pub(super) fn tilde_home(&mut self) -> Option<String> {
    Some(String::new())
  }

  fn logical_directory(&mut self) -> String {
    self
      .shell_text_variable("PWD")
      .filter(|pwd| pwd.starts_with('/'))
      .or_else(|| {
        std::env::current_dir()
          .ok()
          .map(|dir| dir.display().to_string())
      })
      .unwrap_or_else(|| ".".into())
  }

  /// `DIRSTACK`: the current directory, then the stack from the top.
  pub(super) fn refresh_dir_stack(&mut self) {
    let mut entries = BTreeMap::new();
    entries.insert(0, self.logical_directory());
    for (index, dir) in self.shell_dir_stack.iter().rev().enumerate() {
      entries.insert(index as i64 + 1, dir.clone());
    }
    let symbol = self.interp.string_interner().get_or_intern("DIRSTACK");
    Env::root_of(&self.env)
      .borrow_mut()
      .define(symbol, super::bash_arrays::value(entries));
    self.refresh_shell_symbols();
  }

  /// Run the host's `cd` with `args`. Unexported CDPATH/HOME/OLDPWD reach it
  /// through a command-local environment; the PWD and OLDPWD it sets are
  /// copied back to the session. `None`: this host owns no `cd`.
  pub(super) fn hosted_cd(&mut self, args: &[String]) -> Option<crate::Result<ShellBuiltinOutput>> {
    let builtin = self.shell_builtin.clone()?;
    let mut argv = vec!["cd".to_string()];
    argv.extend(args.iter().cloned());
    let session = tento_env::global_env_map();
    let overlay: Vec<(String, String)> = CD_VARIABLES
      .iter()
      .filter(|name| session.as_ref().is_some_and(|map| map.get(name).is_none()))
      .filter_map(|name| Some((name.to_string(), self.shell_text_variable(name)?)))
      .collect();
    let result = if overlay.is_empty() {
      builtin(argv, self.shell_prompt)
    } else {
      let scoped = super::shell_redirect::environment_map(&overlay);
      let result = tento_env::with_env_map(scoped.clone(), || builtin(argv, self.shell_prompt));
      if let Some(session) = &session {
        for name in ["PWD", "OLDPWD"] {
          if let Some(value) = scoped.get(name) {
            session.set(name, value);
          }
        }
      }
      result
    };
    if matches!(result, Some(Ok(ref output)) if output.status == 0) {
      self.refresh_dir_stack();
    }
    result
  }

  /// `cd -- DIR` on behalf of `name`: its output, or the diagnostics with
  /// `cd` renamed, as bash reports the builtin that is running.
  fn stack_cd(&mut self, run: &mut Run, args: &[String]) -> bool {
    let result = match self.hosted_cd(args) {
      Some(result) => result,
      None => self.unhosted_cd(args),
    };
    match result {
      Ok(output) => {
        run.output.stdout.extend(output.stdout);
        run.output.diagnostics.extend(output.diagnostics);
        run.output.status = output.status;
        output.status == 0
      }
      Err(error) => {
        run.output.status = error.process_status().unwrap_or(1);
        if let Some(diagnostic) = super::runner::bash_command_diagnostic(run.line, &error) {
          run
            .output
            .diagnostics
            .push(diagnostic.replacen("cd: ", &format!("{}: ", run.name), 1));
        }
        false
      }
    }
  }

  /// A host without a `cd` builtin (tests, embedders): a plain chdir.
  fn unhosted_cd(&mut self, args: &[String]) -> crate::Result<ShellBuiltinOutput> {
    let target = args
      .iter()
      .find(|arg| *arg != "--")
      .cloned()
      .unwrap_or_default();
    if target.is_empty() {
      return Err(crate::Error::ProcessStart {
        status: 1,
        detail: "cd: null directory".into(),
      });
    }
    let old = self.logical_directory();
    let path = std::path::Path::new(&old).join(&target);
    std::env::set_current_dir(&path).map_err(|error| crate::Error::ProcessStart {
      status: 1,
      detail: format!("cd: {target}: {}", error.kind()),
    })?;
    if let Some(map) = tento_env::global_env_map() {
      map.set("OLDPWD", old);
      map.set("PWD", path.display().to_string());
    }
    self.refresh_dir_stack();
    Ok(ShellBuiltinOutput::default())
  }

  /// bash's `polite_directory_format`: a `$HOME` prefix shown as `~`.
  fn polite(&mut self, dir: &str) -> String {
    match self.shell_text_variable("HOME") {
      Some(home) if home.len() > 1 => match dir.strip_prefix(home.as_str()) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
        _ => dir.to_string(),
      },
      _ => dir.to_string(),
    }
  }

  /// The plain `dirs` listing pushd and popd print after a change.
  fn dirs_listing(&mut self) -> Vec<u8> {
    let mut words = vec![self.logical_directory()];
    words.extend(self.shell_dir_stack.iter().rev().cloned());
    let shown: Vec<String> = words.iter().map(|dir| self.polite(dir)).collect();
    format!("{}\n", shown.join(" ")).into_bytes()
  }

  /// `pushd`, `popd` and `dirs`, as bash 5.3's `pushd.def`.
  pub(super) fn dir_stack_builtin(
    &mut self,
    name: &str,
    args: &[String],
    line: usize,
  ) -> ShellBuiltinOutput {
    let name = match name {
      "pushd" => "pushd",
      "popd" => "popd",
      _ => "dirs",
    };
    let run = Run {
      name,
      line,
      output: ShellBuiltinOutput::default(),
    };
    match name {
      "pushd" => self.pushd(run, args),
      "popd" => self.popd(run, args),
      _ => self.dirs(run, args),
    }
  }

  fn pushd(&mut self, mut run: Run, args: &[String]) -> ShellBuiltinOutput {
    let skipped = args.first().is_some_and(|arg| arg == "--");
    let list = if skipped { &args[1..] } else { args };
    let depth = self.shell_dir_stack.len() as i64;
    if list.is_empty() {
      // No operand: exchange the current directory with the top.
      let Some(top) = self.shell_dir_stack.pop() else {
        return run.fail(1, "no other directory");
      };
      let current = self.logical_directory();
      self.shell_dir_stack.push(current);
      if self.stack_cd(&mut run, &["--".into(), top]) {
        run.output.stdout.extend(self.dirs_listing());
      }
      self.refresh_dir_stack();
      return run.output;
    }
    let mut no_cd = false;
    let mut rotate = None;
    let mut index = 0;
    while !skipped && index < list.len() {
      let word = list[index].as_str();
      match word {
        "-n" => no_cd = true,
        "--" => {
          index += 1;
          break;
        }
        "-" => break,
        _ => match signed_number(word) {
          Some(None) => return run.usage(format!("{word}: invalid number"), PUSHD_USAGE),
          Some(Some((sign, n))) => {
            let n = if sign == '-' { depth - n } else { n };
            if n > depth || n < 0 {
              return if depth == 0 {
                run.fail(1, "directory stack empty")
              } else {
                run.fail(1, format!("{word}: directory stack index out of range"))
              };
            }
            rotate = Some(n);
          }
          None if word.starts_with('-') => {
            return run.usage(format!("{word}: invalid option"), PUSHD_USAGE);
          }
          None => break,
        },
      }
      index += 1;
    }
    if let Some(mut n) = rotate {
      // The current directory acts as part of the stack while rotating.
      let mut temp = self.logical_directory();
      while n > 0 {
        let top = self.shell_dir_stack.pop().unwrap_or_default();
        self.shell_dir_stack.insert(0, temp);
        temp = top;
        n -= 1;
      }
      if !no_cd && self.stack_cd(&mut run, &["--".into(), temp]) {
        run.output.stdout.extend(self.dirs_listing());
      }
      self.refresh_dir_stack();
      return run.output;
    }
    let rest = &list[index..];
    if rest.is_empty() {
      return run.output;
    }
    let current = self.logical_directory();
    let cd_args: Vec<String> = if skipped {
      args.to_vec()
    } else {
      rest.to_vec()
    };
    if no_cd || self.stack_cd(&mut run, &cd_args) {
      self
        .shell_dir_stack
        .push(if no_cd { rest[0].clone() } else { current });
      run.output.stdout.extend(self.dirs_listing());
      run.output.status = 0;
    } else {
      // pushd fails with 1 whatever cd's own status (`cd a b` is 2).
      run.output.status = 1;
    }
    self.refresh_dir_stack();
    run.output
  }

  fn popd(&mut self, mut run: Run, args: &[String]) -> ShellBuiltinOutput {
    let mut no_cd = false;
    let (mut direction, mut which, mut word) = ('+', 0_i64, String::new());
    for arg in args {
      match arg.as_str() {
        "-n" => no_cd = true,
        "--" => break,
        _ => match signed_number(arg) {
          Some(None) => return run.usage(format!("{arg}: invalid number"), POPD_USAGE),
          Some(Some((sign, n))) => {
            (direction, which, word) = (sign, n, arg.clone());
          }
          None if arg.starts_with('-') => {
            return run.usage(format!("{arg}: invalid option"), POPD_USAGE);
          }
          None if !arg.is_empty() => {
            return run.usage(format!("{arg}: invalid argument"), POPD_USAGE);
          }
          None => break,
        },
      }
    }
    let depth = self.shell_dir_stack.len() as i64;
    if which > depth || depth == 0 && which == 0 {
      return if depth == 0 {
        run.fail(1, "directory stack empty")
      } else {
        run.fail(1, format!("{word}: directory stack index out of range"))
      };
    }
    if direction == '+' && which == 0 || direction == '-' && which == depth {
      let top = self.shell_dir_stack.last().cloned().unwrap_or_default();
      if !no_cd && !self.stack_cd(&mut run, &["--".into(), top]) {
        return run.output;
      }
      self.shell_dir_stack.pop();
    } else {
      let slot = if direction == '+' {
        depth - which
      } else {
        which
      };
      if slot < 0 || slot >= depth {
        return run.fail(1, format!("{word}: directory stack index out of range"));
      }
      self.shell_dir_stack.remove(slot as usize);
    }
    self.refresh_dir_stack();
    run.output.stdout.extend(self.dirs_listing());
    run.output.status = 0;
    run.output
  }

  fn dirs(&mut self, mut run: Run, args: &[String]) -> ShellBuiltinOutput {
    let (mut long, mut clear, mut vflag) = (false, false, 0);
    let mut desired: Option<(i64, i32)> = None;
    let mut word = String::new();
    let depth = self.shell_dir_stack.len() as i64;
    for arg in args {
      match arg.as_str() {
        "-l" => long = true,
        "-c" => clear = true,
        "-v" => vflag |= 2,
        "-p" => vflag |= 1,
        "--" => break,
        _ if arg.starts_with(['+', '-']) => match signed_number(arg) {
          Some(Some((sign, n))) => {
            word = arg[1..].to_string();
            // bash's get_dirstack_index: the slot, and whether it names the
            // current directory (1) or a stack entry (2).
            desired = Some(if n == 0 && sign == '+' {
              (0, 1)
            } else if n == depth {
              (0, if sign == '+' { 2 } else { 1 })
            } else if n <= depth {
              (
                if sign == '+' { depth - n } else { n },
                if sign == '+' { 1 } else { 2 },
              )
            } else {
              (-1, if sign == '+' { 1 } else { 2 })
            });
          }
          _ => return run.usage(format!("{arg}: invalid number"), DIRS_USAGE),
        },
        _ => return run.usage(format!("{arg}: invalid option"), DIRS_USAGE),
      }
    }
    if clear {
      self.shell_dir_stack.clear();
      self.refresh_dir_stack();
      return run.output;
    }
    let format = |host: &mut Self, dir: &str| {
      if long {
        dir.to_string()
      } else {
        host.polite(dir)
      }
    };
    let mut text = String::new();
    if let Some((slot, flag)) = desired {
      if slot < 0 || slot > depth {
        return if depth == 0 {
          run.fail(1, "directory stack empty")
        } else {
          run.fail(1, format!("{word}: directory stack index out of range"))
        };
      }
      // Slot 0 with flag 1 is the current directory; otherwise an entry
      // counted from the bottom of the stored list.
      let (position, dir) = if flag == 1 && slot == 0 {
        (0, self.logical_directory())
      } else {
        let Some(dir) = self.shell_dir_stack.get(slot as usize).cloned() else {
          return run.fail(1, "directory stack empty");
        };
        (depth - slot, dir)
      };
      let shown = format(self, &dir);
      text = if vflag & 2 != 0 {
        format!("{position:2}  {shown}\n")
      } else {
        format!("{shown}\n")
      };
    } else {
      let current = self.logical_directory();
      let shown = format(self, &current);
      text.push_str(&if vflag & 2 != 0 {
        format!(" 0  {shown}")
      } else {
        shown
      });
      for (index, dir) in self.shell_dir_stack.clone().iter().enumerate().rev() {
        let shown = format(self, dir);
        if vflag >= 2 {
          text.push_str(&format!("\n{:2}  {shown}", depth - index as i64));
        } else {
          text.push_str(if vflag & 1 != 0 { "\n" } else { " " });
          text.push_str(&shown);
        }
      }
      text.push('\n');
    }
    run.output.stdout = text.into_bytes();
    run.output
  }
}
