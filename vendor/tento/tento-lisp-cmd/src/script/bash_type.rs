//! `type` and `command` as bash builtins: they see shell functions, bash
//! keywords and builtins, then `PATH` (the host's `/usr/bin/type` and
//! `/usr/bin/command` wrappers cannot see the running shell). Aliases never
//! expand in tsh scripts (D2a), so they never answer either, as in a bash
//! script without `expand_aliases`. A function prints in bash's layout
//! (bash_functions.rs).
use std::path::Path;

use serde_json::Value as JsonValue;

use super::bash_flow::{FlowOutput, eval_flow};
use super::interp::LispHost;
use super::runner::TshScriptErrorKind;

type Result<T> = std::result::Result<T, TshScriptErrorKind>;

const KEYWORDS: &[&str] = &[
  "if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until", "do", "done",
  "in", "function", "time", "{", "}", "!", "[[", "]]", "coproc",
];

const BUILTINS: &[&str] = &[
  ".", ":", "[", "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen",
  "complete", "compopt", "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec",
  "exit", "export", "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let",
  "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly",
  "return", "set", "shift", "shopt", "source", "suspend", "test", "times", "trap", "true", "type",
  "typeset", "ulimit", "umask", "unalias", "unset", "wait",
];

thread_local! {
  /// Functions made readonly with `readonly -f`.
  static READONLY_FUNCTIONS: std::cell::RefCell<std::collections::HashSet<String>> = Default::default();
}

/// The `readonly -f` set, for a subshell's snapshot.
pub(super) fn readonly_functions() -> std::collections::HashSet<String> {
  READONLY_FUNCTIONS.with(|set| set.borrow().clone())
}

pub(super) fn set_readonly_functions(names: std::collections::HashSet<String>) {
  READONLY_FUNCTIONS.with(|set| *set.borrow_mut() = names);
}

/// Whether `readonly -f` protects the function NAME.
pub(super) fn readonly_function(name: &str) -> bool {
  READONLY_FUNCTIONS.with(|set| set.borrow().contains(name))
}

/// bash's `command -p` search path.
const STANDARD_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

#[derive(Clone, Copy, PartialEq)]
enum Kind {
  Keyword,
  Function,
  Builtin,
}

impl LispHost {
  /// `type` and `command`; `None` for any other head.
  pub(super) async fn describe_builtin(
    &mut self,
    argv: &[String],
    line: usize,
    ignored: bool,
    output: FlowOutput,
    last: bool,
  ) -> Option<Result<Option<JsonValue>>> {
    match argv.first()?.as_str() {
      "type" => Some(self.type_builtin(&argv[1..], line, &output)),
      "command" => Some(self.command_builtin_native(&argv[1..], line, ignored, output, last).await),
      "printf" if argv.get(1).is_some_and(|arg| arg.starts_with("-v")) => {
        Some(self.printf_to_variable(&argv[1..], line, ignored).await)
      }
      _ => None,
    }
  }

  fn type_builtin(&mut self, args: &[String], line: usize, output: &FlowOutput) -> Result<Option<JsonValue>> {
    let (mut all, mut no_functions, mut path_only, mut force_path, mut kind_only) = (false, false, false, false, false);
    let mut index = 0;
    while let Some(arg) = args.get(index) {
      if arg == "--" {
        index += 1;
        break;
      }
      if !arg.starts_with('-') || arg.len() == 1 {
        break;
      }
      for flag in arg[1..].chars() {
        match flag {
          'a' => all = true,
          'f' => no_functions = true,
          'p' => path_only = true,
          'P' => force_path = true,
          't' => kind_only = true,
          _ => {
            self.report_shell_diagnostic(format!(
              "tsh: line {line}: type: -{flag}: invalid option\ntype: usage: type [-afptP] name [name ...]"
            ));
            self.set_shell_status(2);
            return Ok(None);
          }
        }
      }
      index += 1;
    }
    let mut text = String::new();
    let mut status = 0;
    for name in &args[index..] {
      let mut found = false;
      if !force_path {
        for kind in self.command_kinds(name, !no_functions) {
          found = true;
          if !path_only {
            match kind {
              Kind::Function if !kind_only => match self.function_text_or_reason(name) {
                Ok(body) => text.push_str(&format!("{name} is a function\n{body}\n")),
                Err(reason) => {
                  self.report_shell_diagnostic(format!("tsh: line {line}: type: {reason}"));
                  status = 1;
                }
              },
              _ => text.push_str(&if kind_only {
                format!("{}\n", kind_word(kind))
              } else {
                format!("{name} is a shell {}\n", kind_word(kind))
              }),
            }
          }
          if !all {
            break;
          }
        }
        // At the interactive prompt a prelude declaration answers before
        // PATH (`ls is declared in the prelude (std.fs.list_dir)`); a script
        // never sees one.
        if all || !found {
          if let Some((place, target)) = self.prompt_declaration(name) {
            found = true;
            if kind_only {
              text.push_str("declared\n");
            } else if !path_only {
              text.push_str(&format!("{name} is declared in {place} ({target})\n"));
            }
          }
        }
      }
      if all || !found {
        for path in self.command_paths(name, all, None) {
          found = true;
          text.push_str(&if kind_only {
            "file\n".to_string()
          } else if path_only || force_path {
            format!("{path}\n")
          } else {
            format!("{name} is {path}\n")
          });
        }
      }
      if !found {
        if !kind_only && !path_only && !force_path {
          self.report_shell_diagnostic(format!("tsh: line {line}: type: {name}: not found"));
        }
        status = 1;
      }
    }
    output.write_bytes(self, text.as_bytes());
    self.set_shell_status(status);
    Ok(None)
  }

  async fn command_builtin_native(
    &mut self,
    args: &[String],
    line: usize,
    ignored: bool,
    output: FlowOutput,
    last: bool,
  ) -> Result<Option<JsonValue>> {
    let (mut standard, mut name_only, mut verbose) = (false, false, false);
    let mut index = 0;
    while let Some(arg) = args.get(index) {
      if arg == "--" {
        index += 1;
        break;
      }
      if !arg.starts_with('-') || arg.len() == 1 {
        break;
      }
      for flag in arg[1..].chars() {
        match flag {
          'p' => standard = true,
          // The later of -v and -V wins.
          'v' => (name_only, verbose) = (true, false),
          'V' => (name_only, verbose) = (false, true),
          _ => {
            self.report_shell_diagnostic(format!(
              "tsh: line {line}: command: -{flag}: invalid option\ncommand: usage: command [-pVv] command [arg ...]"
            ));
            self.set_shell_status(2);
            return Ok(None);
          }
        }
      }
      index += 1;
    }
    let operands = &args[index..];
    let path = standard.then_some(STANDARD_PATH);
    if name_only || verbose {
      let mut text = String::new();
      let mut any = false;
      for name in operands {
        let kind = self.command_kinds(name, true).into_iter().next();
        let found = match kind {
          Some(Kind::Function) if verbose => {
            match self.function_text_or_reason(name) {
              Ok(body) => text.push_str(&format!("{name} is a function\n{body}\n")),
              Err(reason) => self.report_shell_diagnostic(format!("tsh: line {line}: command: {reason}")),
            }
            true
          }
          Some(kind) => {
            text.push_str(&if verbose { format!("{name} is a shell {}\n", kind_word(kind)) } else { format!("{name}\n") });
            true
          }
          None => match self.command_paths(name, false, path).into_iter().next() {
            Some(found) => {
              text.push_str(&if verbose { format!("{name} is {found}\n") } else { format!("{found}\n") });
              true
            }
            None => {
              if verbose {
                self.report_shell_diagnostic(format!("tsh: line {line}: command: {name}: not found"));
              }
              false
            }
          },
        };
        any |= found;
      }
      output.write_bytes(self, text.as_bytes());
      self.set_shell_status(if any || operands.is_empty() { 0 } else { 1 });
      return Ok(None);
    }
    let Some(name) = operands.first() else {
      self.set_shell_status(0);
      return Ok(None);
    };
    let mut argv = operands.to_vec();
    if !self.command_kinds(name, false).contains(&Kind::Builtin) && !name.contains('/') {
      // Only the shell's PATH (or -p's standard path) can name a program.
      match self.command_paths(name, false, path).into_iter().next() {
        Some(found) if standard => argv[0] = found,
        Some(_) => {}
        None => {
          self.report_shell_diagnostic(format!("tsh: line {line}: {name}: command not found"));
          self.set_shell_status(127);
          return Ok(None);
        }
      }
    }
    // `command NAME` skips shell functions: hide NAME's for this call. It
    // never renders through a prompt declaration either (plain output).
    let hidden = self.shell_compound.functions.remove(name);
    let call = self.shell_literal_call(&argv, &argv[0], false);
    let result = eval_flow(self, &call, line, ignored, output.plain(), last).await;
    if let Some(body) = hidden {
      self.shell_compound.functions.entry(name.clone()).or_insert(body);
    }
    result
  }

  /// `declare -f`/`-F`, `typeset -f`, `readonly -f`, `export -f` listing:
  /// function bodies in bash's layout, names, and the `r`/`x` attributes
  /// (`changes` are the attribute flags given with `-f`).
  pub(super) fn declare_functions(&mut self, command: &str, names_only: bool, print: bool, changes: &[(char, bool)], operands: &[String], line: usize) -> Result<Option<JsonValue>> {
    let readonly = command == "readonly";
    let setting: Vec<char> = changes.iter().filter(|(_, on)| *on).map(|(flag, _)| *flag).collect();
    let mut status = 0;
    let mut text = String::new();
    if operands.is_empty() {
      let mut names: Vec<String> = self.shell_compound.functions.keys().cloned().collect();
      names.sort();
      // With no names the attribute flags filter the listing.
      names.retain(|name| {
        setting.iter().all(|flag| match flag {
          'r' => readonly_function(name),
          'x' => self.function_exported(name),
          _ => true,
        })
      });
      for name in names {
        let flags = self.function_flags(&name);
        if names_only || readonly && !print {
          text.push_str(&format!("declare -{flags} {name}\n"));
          continue;
        }
        match self.function_text_or_reason(&name) {
          Ok(body) => text.push_str(&format!("{body}\n")),
          Err(reason) => {
            self.report_shell_diagnostic(format!("tsh: line {line}: {command}: {reason}"));
            status = 1;
          }
        }
        if !setting.is_empty() {
          text.push_str(&format!("declare -{flags} {name}\n"));
        }
      }
    }
    for name in operands {
      if !self.shell_compound.functions.contains_key(name) {
        if readonly {
          self.report_shell_diagnostic(format!("tsh: line {line}: readonly: {name}: not a function"));
        }
        status = 1;
        continue;
      }
      if !setting.is_empty() {
        // `declare -fx NAME`, `readonly -f NAME`: set attributes, print nothing.
        for flag in &setting {
          match flag {
            'r' => READONLY_FUNCTIONS.with(|set| {
              set.borrow_mut().insert(name.clone());
            }),
            'x' => {
              self.export_function(name);
            }
            _ => {}
          }
        }
        continue;
      }
      if names_only {
        text.push_str(&format!("{name}\n"));
        continue;
      }
      match self.function_text_or_reason(name) {
        Ok(body) => {
          text.push_str(&format!("{body}\n"));
          let flags = self.function_flags(name);
          if print && flags != "f" {
            text.push_str(&format!("declare -{flags} {name}\n"));
          }
        }
        Err(reason) => {
          self.report_shell_diagnostic(format!("tsh: line {line}: {command}: {reason}"));
          status = 1;
        }
      }
    }
    let output = self.shell_output.borrow().clone();
    output.write_bytes(self, text.as_bytes());
    self.set_shell_status(status);
    Ok(None)
  }

  /// A function's `declare` flags: `f`, then `r` and `x` as set.
  fn function_flags(&self, name: &str) -> String {
    let mut flags = String::from("f");
    if readonly_function(name) {
      flags.push('r');
    }
    if self.function_exported(name) {
      flags.push('x');
    }
    flags
  }

  /// Where NAME's prompt declaration was made, and the `std.*` command it
  /// names — only at the interactive prompt, and never for a builtin (the
  /// builtin answers first; its declaration is a Lisp name only).
  fn prompt_declaration(&mut self, name: &str) -> Option<(String, String)> {
    if !self.shell_prompt || BUILTINS.contains(&name) || KEYWORDS.contains(&name) || name == "rm" {
      return None;
    }
    let target = self.declared_target(name)?;
    let place = self.binding_places.borrow().get(name).cloned().unwrap_or_else(|| "the prelude".into());
    Some((place, target))
  }

  fn command_kinds(&self, name: &str, functions: bool) -> Vec<Kind> {
    let mut kinds = Vec::new();
    if KEYWORDS.contains(&name) {
      kinds.push(Kind::Keyword);
    }
    if functions && self.shell_compound.functions.contains_key(name) {
      kinds.push(Kind::Function);
    }
    if BUILTINS.contains(&name) {
      kinds.push(Kind::Builtin);
    }
    kinds
  }

  /// `PATH` matches for NAME, as bash's search reports them: executables
  /// first, else the first plain file; a name with a slash is itself.
  fn command_paths(&mut self, name: &str, all: bool, path: Option<&str>) -> Vec<String> {
    if name.is_empty() {
      return Vec::new();
    }
    if name.contains('/') {
      return if executable(Path::new(name)) { vec![name.to_string()] } else { Vec::new() };
    }
    let path = match path {
      Some(path) => path.to_string(),
      None => {
        let call = self.shell_literal_call(&["std.sh.var".into(), "PATH".into()], "std.sh.var", false);
        match self.evaluate_shell_data(&call) {
          Ok(JsonValue::String(path)) => path,
          _ => String::new(),
        }
      }
    };
    let mut found = Vec::new();
    let mut fallback = None;
    for dir in path.split(':') {
      let dir = if dir.is_empty() { "." } else { dir };
      let candidate = Path::new(dir).join(name);
      if executable(&candidate) {
        found.push(candidate.display().to_string());
        if !all {
          break;
        }
      } else if fallback.is_none() && candidate.is_file() {
        fallback = Some(candidate.display().to_string());
      }
    }
    if found.is_empty() {
      found.extend(fallback);
    }
    found
  }
}

fn kind_word(kind: Kind) -> &'static str {
  match kind {
    Kind::Keyword => "keyword",
    Kind::Function => "function",
    Kind::Builtin => "builtin",
  }
}

#[cfg(unix)]
pub(super) fn executable(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
pub(super) fn executable(path: &Path) -> bool {
  path.is_file()
}
