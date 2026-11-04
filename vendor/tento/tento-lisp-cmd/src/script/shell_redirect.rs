//! Scoped descriptor tables; no ambient process descriptors are changed.
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::rc::Rc;
use std::sync::Arc;

use super::LispValue;
use super::bash_flow::{FlowOutput, eval_flow};
use super::interp::{LispHost, LispHostError, Sym};
use super::runner::TshScriptErrorKind;

#[derive(Clone, Debug)]
pub enum FdTarget {
  Inherit(i32),
  File(Arc<File>),
  Text(Arc<std::sync::Mutex<Vec<u8>>>),
  Closed,
}

#[derive(Clone, Debug)]
pub struct ShellIo(pub BTreeMap<i32, FdTarget>, pub Vec<(String, String)>);
pub(super) type PreparedRedirect = Result<ShellIo, (ShellIo, String)>;

impl Default for ShellIo {
  fn default() -> Self {
    Self((0..3).map(|fd| (fd, FdTarget::Inherit(fd))).collect(), Vec::new())
  }
}

impl ShellIo {
  pub fn target(&self, fd: i32) -> FdTarget {
    self.0.get(&fd).cloned().unwrap_or(FdTarget::Closed)
  }
}

/// The embedder installs its file-effect door; sealed hosts check each native
/// capability before that door can open or truncate anything.
pub type ShellFileOpener = Rc<dyn Fn(&str, bool, bool) -> Result<File, LispHostError>>;

#[derive(Clone, Copy, Debug)]
pub struct ShellOpenOptions {
  pub read: bool, pub write: bool, pub append: bool, pub exclusive: bool, pub truncate: bool,
}
pub type ShellOptionsFileOpener = Rc<dyn Fn(&str, ShellOpenOptions) -> Result<File, LispHostError>>;


impl LispHost {
  pub(super) fn write_shell_target(
    &mut self,
    target: &FdTarget,
    bytes: &[u8],
  ) -> std::io::Result<()> {
    let ordinal = self.shell_write_cache.as_mut().map(|(cursor, cache)| {
      let ordinal = *cursor;
      *cursor += 1;
      (ordinal, cache.get(ordinal).cloned())
    });
    if let Some((_, Some(result))) = &ordinal {
      return result.clone().map_err(std::io::Error::other);
    }
    let result = if matches!(target, FdTarget::Inherit(1)) && self.shell_byte_output.is_some() {
      (self.shell_byte_output.as_ref().unwrap())(bytes);
      Ok(())
    } else if matches!(target, FdTarget::Inherit(2)) && self.shell_stderr_output.is_some() {
      (self.shell_stderr_output.as_ref().unwrap())(bytes);
      Ok(())
    } else if matches!(target, FdTarget::Inherit(2)) && self.shell_diagnostics.is_some() {
      self.shell_diagnostics.as_mut().unwrap().push(
        String::from_utf8_lossy(bytes).trim_end_matches('\n').into());
      Ok(())
    } else {
      write_target(target, bytes)
    };
    if let (Some((ordinal, _)), Some((_, cache))) = (ordinal, &mut self.shell_write_cache) {
      if ordinal == cache.len() {
        cache.push(result.as_ref().map(|_| ()).map_err(|e| e.to_string()));
      }
    }
    result
  }

  pub fn set_shell_file_opener(&mut self, open: ShellFileOpener) {
    self.set_shell_options_file_opener(Rc::new(move |path, options| {
      if options.read && options.write {
        return Err(LispHostError::Command("<>: this host's file opener does not support read/write descriptors".into()));
      }
      if options.exclusive {
        return Err(LispHostError::Command("noclobber: this host's file opener does not support atomic opens".into()));
      }
      open(path, options.read, options.append)
    }));
  }

  pub fn set_shell_options_file_opener(&mut self, open: ShellOptionsFileOpener) {
    self.shell_compound.commands.open = Some(open.clone());
    for (name, read) in [("std.io.open_read", true), ("std.io.open_write", false)] {
      let files = self.shell_files.clone();
      let open = open.clone();
      self.register_native_special(name, move |args| {
        let Some(LispValue::String(path)) = args.first() else {
          return Err(LispHostError::Command(format!("{name}: expected a path")));
        };
        if if read { args.len() != 1 } else { !matches!(args.len(), 2 | 4) } {
          return Err(LispHostError::Command(format!("{name}: invalid argument count")));
        }
        let append = matches!(args.get(1), Some(LispValue::Boolean(true)));
        let update = matches!(args.get(3), Some(LispValue::Boolean(true)));
        let options = ShellOpenOptions {
          read: read || update, write: !read, append,
          exclusive: matches!(args.get(2), Some(LispValue::Boolean(true))),
          truncate: !read && !update && !append,
        };
        let file = open(path, options)?;
        let mut files = files.borrow_mut();
        let id = files.0; files.0 += 1; files.1.insert(id, Arc::new(file));
        Ok(LispValue::Integer(id))
      });
    }
  }

  fn open_redirect_file(
    &mut self,
    path: &str,
    read: bool,
    append: bool,
    exclusive: bool,
    update: bool,
  ) -> Result<Arc<File>, String> {
    let name = if read {
      "std.io.open_read"
    } else {
      "std.io.open_write"
    };
    let path = serde_json::to_string(path).unwrap();
    let source = if read {
      format!("({name} {path})")
    } else {
      format!("({name} {path} {append} {exclusive} {update})")
    };
    let id = self
      .eval_to_json(&source)
      .map_err(|error| error.to_string())?
      .as_i64()
      .ok_or_else(|| "file opener did not return a handle".to_string())?;
    self
      .shell_files
      .borrow_mut()
      .1
      .remove(&id)
      .ok_or_else(|| "file handle is missing".into())
  }
}

pub(super) fn redirected_stage<'a>(
  host: &mut LispHost,
  value: &'a LispValue<Sym>,
) -> Option<(&'a LispValue<Sym>, &'a LispValue<Sym>)> {
  if host.application_head(value).as_deref() != Some("std.sh.redirect") {
    return None;
  }
  let LispValue::List(list) = value else {
    return None;
  };
  if list.items.len() == 3 {
    Some((&list.items[1], &list.items[2]))
  } else {
    None
  }
}

/// The source text of an expanded redirection word (`$fd`, `$x`).
fn written_word(host: &mut LispHost, target: &LispValue<Sym>) -> Option<String> {
  let head = host.application_head(target)?;
  let LispValue::List(list) = target else { return None };
  match (head.as_str(), list.items.get(2)) {
    ("std.sh.redirect-word" | "std.sh.redirect-fields", Some(LispValue::String(raw))) => Some(raw.to_string()),
    _ => None,
  }
}

pub(super) async fn prepare(
  host: &mut LispHost,
  specs: &LispValue<Sym>,
  line: usize,
) -> PreparedRedirect {
  let ordinal = host.shell_redirect_cache.as_mut().map(|(cursor, cache)| {
    let ordinal = *cursor;
    *cursor += 1;
    (ordinal, cache.get(ordinal).cloned())
  });
  if let Some((_, Some(cached))) = &ordinal {
    return cached.clone();
  }
  // Evaluate each target immediately before its open, preserving side effects
  // from earlier redirections even when a later target fails to expand/open.
  let mut io = host.shell_io.borrow().clone().or_else(|| host.shell_compound.commands.persistent_io.clone()).unwrap_or_default();
  if let Some(persistent) = &host.shell_compound.commands.persistent_io {
    for (fd, target) in &persistent.0 {
      if *fd >= 10 { io.0.entry(*fd).or_insert_with(|| target.clone()); }
    }
  }
  let result: Result<(), String> = async {
    let LispValue::List(specs) = specs else {
      return Err("invalid redirection list".into());
    };
    for spec in specs.items.iter().skip(1) {
      let LispValue::List(fields) = spec else {
        return Err("invalid redirection".into());
      };
      if fields.items.len() != 4 {
        return Err("invalid redirection".into());
      }
      if matches!(&fields.items[1], LispValue::String(kind) if kind == "env") {
        let key = host
          .evaluate_shell_data(&fields.items[2])
          .map_err(|e| e.to_string())?;
        let key = key.as_str().ok_or("environment key must be text")?;
        if host.shell_readonly(key) {
          return Err(format!("tsh: line {line}: {key}: readonly variable"));
        }
        // Bash 5 expands prefix assignments left to right, each seeing the
        // ones before it: `FOO=once MYVAR=$FOO cmd` gives MYVAR=once. The
        // word expands in a scope holding the earlier entries; the outer
        // environment comes back before any error is reported.
        let resolved = if io.1.is_empty() {
          resolve_target(host, &fields.items[3], line).await?
        } else {
          let outer = host.env.clone();
          let mut scope = tento_lisp::Env::extend(outer.clone());
          for (name, value) in &io.1 {
            let symbol = host.interp.string_interner().get_or_intern(name);
            scope.define(symbol, LispValue::String(value.as_str().into()));
          }
          host.env = Rc::new(std::cell::RefCell::new(scope));
          host.refresh_shell_symbols();
          let resolved = resolve_target(host, &fields.items[3], line).await;
          host.env = outer;
          resolved?
        };
        let value = host
          .evaluate_environment_value(&resolved, &io.1)
          .map_err(|e| e.to_string())?;
        let value = value
          .as_str()
          .map(str::to_string)
          .unwrap_or_else(|| value.to_string());
        io.1.push((key.into(), value));
        continue;
      }
      let descriptor = host.evaluate_shell_data(&fields.items[1]).map_err(|e| e.to_string())?;
      let variable = descriptor.as_str().map(str::to_string);
      let mut fd = if variable.is_some() {
        (10..i32::MAX).find(|fd| matches!(io.target(*fd), FdTarget::Closed))
          .ok_or("no free file descriptor")?
      } else {
        descriptor.as_i64().and_then(|fd| i32::try_from(fd).ok())
          .ok_or("invalid file descriptor")?
      };
      let op = host
        .evaluate_shell_data(&fields.items[2])
        .map_err(|e| e.to_string())?;
      let op = op.as_str().ok_or("invalid redirection operator")?;
      let restore = IoRestore::install(host, io.clone());
      let resolved = resolve_target(host, &fields.items[3], line).await;
      if let Some(current) = host.shell_io.borrow().as_ref() {
        for fd in host.shell_compound.commands.process_fds.borrow().iter() {
          if let Some(target) = current.0.get(fd) {
            io.0.insert(*fd, target.clone());
          }
        }
      }
      drop(restore);
      let resolved = resolved.map_err(|error| {
        if error.ends_with(": ambiguous redirect") { format!("tsh: line {line}: {error}") }
        else { error }
      })?;
      let target = host
        .evaluate_shell_data(&resolved)
        .map_err(|error| format!("tsh: line {line}: {error}"))?;
      let target = target.as_str().ok_or("redirection target must be text")?;
      // bash names a bad descriptor or an ambiguous word as it was written.
      let word = written_word(host, &fields.items[3]).unwrap_or_else(|| target.to_string());
      let mut moved = None;
      let mut both = false;
      if let Some(name) = &variable {
        if matches!(op, ">&" | "<&") && target == "-" {
          let call = host.shell_literal_call(&["std.sh.var".into(), name.clone()], "std.sh.var", false);
          let number = host.evaluate_shell_data(&call).map_err(|e| e.to_string())?;
          fd = number.as_str().and_then(|s| s.parse::<i32>().ok())
            .ok_or_else(|| format!("tsh: line {line}: {name}: ambiguous redirect"))?;
        }
      }
      let endpoint = if matches!(op, ">&" | "<&") {
        if target == "-" {
          FdTarget::Closed
        } else if let Some(other) = target.strip_suffix('-').and_then(|n| n.parse::<i32>().ok()) {
          // `N>&M-` moves M to N; moving a descriptor onto itself is a no-op.
          let endpoint = io.target(other);
          if other != fd && matches!(endpoint, FdTarget::Closed) {
            return Err(format!("tsh: line {line}: {other}: Bad file descriptor"));
          }
          if other != fd { moved = Some(other); }
          endpoint
        } else if let Ok(other) = target.parse::<i32>() {
          let endpoint = io.target(other);
          if matches!(endpoint, FdTarget::Closed) {
            return Err(format!("tsh: line {line}: {word}: Bad file descriptor"));
          }
          endpoint
        } else if op == ">&" && fd == 1 && variable.is_none() {
          // `>&word` (not a number) sends stdout and stderr to the file.
          both = true;
          let file = host
            .open_redirect_file(target, false, false, host.shell_compound.commands.noclobber, false)
            .map_err(|error| {
              let message = if host.shell_compound.commands.noclobber && error.contains("(os error 17)") {
                "cannot overwrite existing file".into()
              } else {
                open_error(&error)
              };
              format!("tsh: line {line}: {target}: {message}")
            })?;
          FdTarget::File(file)
        } else {
          return Err(format!("tsh: line {line}: {word}: ambiguous redirect"));
        }
      } else if op == "<<" || op == "<<<" {
        let mut bytes = target.as_bytes().to_vec();
        if op == "<<<" {
          bytes.push(b'\n');
        }
        FdTarget::Text(Arc::new(std::sync::Mutex::new(bytes)))
      } else if let Some(other) = match target {
        "/dev/stdin" => Some(0),
        "/dev/stdout" => Some(1),
        "/dev/stderr" => Some(2),
        path => path
          .strip_prefix("/dev/fd/")
          .and_then(|n| n.parse::<i32>().ok()),
      } {
        let endpoint = io.target(other);
        if matches!(endpoint, FdTarget::Closed) {
          return Err(format!("tsh: line {line}: {target}: Bad file descriptor"));
        }
        endpoint
      } else {
        let file = host
          .open_redirect_file(target, op == "<", matches!(op, ">>" | "&>>"),
            host.shell_compound.commands.noclobber && matches!(op, ">" | "&>"), op == "<>")
          .map_err(|error| {
            let message = if host.shell_compound.commands.noclobber && matches!(op, ">" | "&>")
              && error.contains("(os error 17)") { "cannot overwrite existing file".into() }
              else { open_error(&error) };
            format!("tsh: line {line}: {target}: {message}")
          })?;
        FdTarget::File(file)
      };
      if let Some(name) = variable {
        let persistent = host.shell_compound.commands.persistent_io.get_or_insert_with(ShellIo::default);
        persistent.0.insert(fd, endpoint.clone());
        if !matches!(endpoint, FdTarget::Closed) { host.assign_shell_variable(&name, fd.to_string(), false); }
      }
      io.0.insert(if fd == -1 { 1 } else { fd }, endpoint.clone());
      if fd == -1 || both {
        io.0.insert(2, endpoint);
      }
      if let Some(other) = moved {
        io.0.insert(other, FdTarget::Closed);
      }
    }
    Ok(())
  }
  .await;
  let prepared = match result {
    Ok(()) => Ok(io),
    Err(error) => Err((io, error)),
  };
  if !host.shell_suspended() {
    if let (Some((ordinal, _)), Some((_, cache))) = (ordinal, &mut host.shell_redirect_cache) {
      if ordinal == cache.len() {
        cache.push(prepared.clone());
      }
    }
  }
  prepared
}

pub(super) fn resolve_target<'a>(
  host: &'a mut LispHost,
  value: &'a LispValue<Sym>,
  line: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<LispValue<Sym>, String>> + 'a>> {
  Box::pin(async move {
    if host.application_head(value).as_deref() == Some("quote") { return Ok(value.clone()); }
    // The parameter reader emits an ordinary Lisp if. Resolve only its
    // selected word: command substitutions and assignments in the other
    // default/alternate branch must never run.
    if host.application_head(value).as_deref() == Some("if") {
      if let LispValue::List(list) = value {
        if let [_, condition, yes, no] = list.items.as_slice() {
          if host.application_head(condition).as_deref() == Some("std.sh.param-test") {
            let selected = host.interp.eval_expression(host.env.clone(), condition).map_err(|e| e.to_string())?;
            let branch = if matches!(selected, LispValue::Boolean(true)) { yes } else { no };
            return resolve_target(host, branch, line).await;
          }
        }
      }
    }
    if host.application_head(value).as_deref() == Some("std.sh.process-sub") {
      let LispValue::List(list) = value else {
        unreachable!()
      };
      let [_, LispValue::Boolean(write), body] = list.items.as_slice() else {
        return Err("process substitution: invalid operands".into());
      };
      #[cfg(unix)]
      return host
        .process_substitution(body, *write, line)
        .map(|value| LispValue::String(value.into()))
        .map_err(|e| e.to_string());
      #[cfg(not(unix))]
      return Err("process substitution requires a Unix host".into());
    }
    if host.application_head(value).as_deref() == Some("std.sh.sub") {
      let LispValue::List(list) = value else {
        unreachable!()
      };
      if list.items.len() != 2 {
        return Err("std.sh.sub: expected a command".into());
      }
      let mut io = host.shell_io.borrow().clone().unwrap_or_default();
      io.0.insert(1, FdTarget::Inherit(1));
      let restore = IoRestore::install(host, io);
      // A command substitution is a subshell (bash 5.3 §3.7.4).
      let captured = super::bash_compound::capture_substitution(host, &list.items[1], line).await;
      drop(restore);
      let captured = captured.map_err(|e| e.to_string())?;
      return Ok(LispValue::String(
        String::from_utf8(captured)
          .map_err(|_| "command substitution is not UTF-8")?
          .trim_end_matches('\n')
          .into(),
      ));
    }
    if host.application_head(value).as_deref() == Some("if") {
      if let LispValue::List(list) = value {
        if list.items.len() == 4 && matches!(host.application_head(&list.items[1]).as_deref(), Some("std.sh.brace-enabled" | "std.sh.array-test")) {
          // Array defaults are lazy, including substitutions in the word.
          let test = resolve_target(host, &list.items[1], line).await?;
          let enabled = host.evaluate_shell_data(&test).map_err(|e| e.to_string())?.as_bool().unwrap_or(false);
          return resolve_target(host, &list.items[if enabled { 2 } else { 3 }], line).await;
        }
      }
    }
    let mut result = value.clone();
    if let LispValue::List(list) = &mut result {
      for item in list.items.iter_mut().skip(1) {
        *item = resolve_target(host, item, line).await?;
      }
    }
    let head = host.application_head(&result);
    if head.as_deref() == Some("std.sh.arith") {
      let LispValue::List(list) = &result else { unreachable!() };
      let [_, source] = list.items.as_slice() else { return Err("std.sh.arith: expected EXPRESSION".into()); };
      let source = host.evaluate_shell_data(source).map_err(|e| e.to_string())?;
      let source = source.as_str().ok_or("std.sh.arith: expected EXPRESSION string")?;
      host.prepare_shell_arithmetic(source)?;
    }
    // `$(< file)` that cannot read warns and expands to nothing; the
    // command still runs, and the substitution's status is 1 (Q6 item 18).
    if head.as_deref() == Some("std.sh.read-file") {
      let read = host.interp.eval_expression(host.env.clone(), &result);
      let text = match read {
        Ok(value) => { host.set_shell_status(0); value }
        Err(error) => {
          let io = host.shell_compound.commands.expansion_report_io.clone();
          host.report_expansion_diagnostic(io, format!("tsh: line {line}: {error}"));
          host.set_shell_status(1);
          LispValue::String(String::new().into())
        }
      };
      let mut quoted = host.shell_literal_call(&[], "quote", false);
      if let LispValue::List(list) = &mut quoted { list.items.push(text); }
      return Ok(quoted);
    }
    // Freeze expansions in word order. A later arithmetic or parameter
    // assignment must not run before the preceding word's default is bound,
    // and the following variable must see that assignment exactly once.
    if matches!(head.as_deref(), Some("std.sh.array-index" | "std.sh.indirect" | "std.sh.array-get" | "std.sh.array-keys" | "std.sh.names" | "std.sh.array-test" | "std.sh.array-word" | "std.sh.array-scalar" | "std.sh.var" | "std.sh.tilde" | "std.sh.positional" | "std.sh.arith" | "std.sh.param-word" | "std.sh.param-transform" | "std.sh.param-each" | "std.sh.param-slice" | "std.sh.read-file" | "std.sh.bad-substitution" | "std.sh.scalar" | "std.sh.split" | "std.sh.redirect-word")) {
      let frozen = host.interp.eval_expression(host.env.clone(), &result).map_err(|e| e.to_string())?;
      // A typed expansion may contain callable-looking lists or symbols.
      // Quote the value so argument evaluation never treats it as source.
      let mut quoted = host.shell_literal_call(&[], "quote", false);
      if let LispValue::List(list) = &mut quoted { list.items.push(frozen); }
      return Ok(quoted);
    }
    if host.is_computed_command(&result) {
      let argv = host
        .application_to_argv(&result)
        .map_err(|e| e.to_string())?;
      if let Some(name) = argv.first() {
        if name == "unset" {
          return Ok(host.shell_literal_call(&argv, "std.sh.unset", false));
        }
        return Ok(host.shell_literal_call(&argv, name, false));
      }
      // An unquoted empty command expansion is a successful empty command.
      return Ok(host.shell_literal_call(&[":".into()], ":", false));
    }
    Ok(result)
  })
}

/// Resolve only a dynamic command head before pipeline classification. Its
/// expanded fields are frozen, so grouping external stages cannot repeat a
/// substitution or pathname scan while looking ahead to the next stage.
pub(super) fn resolve_dynamic_stage<'a>(
  host: &'a mut LispHost,
  value: &'a LispValue<Sym>,
  line: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<LispValue<Sym>, String>> + 'a>> {
  Box::pin(async move {
    if let Some((stage, _)) = redirected_stage(host, value) {
      let stage = resolve_dynamic_stage(host, stage, line).await?;
      let mut resolved = value.clone();
      if let LispValue::List(list) = &mut resolved {
        list.items[1] = stage;
      }
      return Ok(resolved);
    }
    if host.is_computed_command(value) {
      return resolve_target(host, value, line).await;
    }
    Ok(value.clone())
  })
}

fn open_error(error: &str) -> String {
  // Strip host/native context only for an OS failure. Capability and policy
  // refusals retain their own text rather than pretending to be errno.
  if let Some((_, suffix)) = error.rsplit_once("(os error ") {
    if let Some(errno) = suffix.split(')').next().and_then(|n| n.parse::<i32>().ok()) {
      let message = std::io::Error::from_raw_os_error(errno).to_string();
      return message.split(" (os error ").next().unwrap_or(&message).into();
    }
  }
  error.to_string()
}

struct Restore {
  io: Rc<std::cell::RefCell<Option<ShellIo>>>,
  saved: Option<ShellIo>,
  stdin: Rc<std::cell::RefCell<Option<Vec<u8>>>>,
  saved_stdin: Option<Vec<u8>>,
  restore_stdin: bool,
}

pub(super) struct IoRestore {
  slot: Rc<std::cell::RefCell<Option<ShellIo>>>,
  saved: Option<ShellIo>,
}
impl IoRestore {
  pub(super) fn install(host: &LispHost, io: ShellIo) -> Self {
    Self {
      slot: host.shell_io.clone(),
      saved: host.shell_io.replace(Some(io)),
    }
  }
}
impl Drop for IoRestore {
  fn drop(&mut self) {
    *self.slot.borrow_mut() = self.saved.take();
  }
}
impl Drop for Restore {
  fn drop(&mut self) {
    *self.io.borrow_mut() = self.saved.take();
    if self.restore_stdin {
      *self.stdin.borrow_mut() = self.saved_stdin.take();
    }
  }
}

pub(super) async fn run(
  host: &mut LispHost,
  stage: &LispValue<Sym>,
  specs: &LispValue<Sym>,
  line: usize,
  ignored: bool,
  output: FlowOutput,
  last: bool,
  inherited: Option<super::owned_io_fork::UnitReservation>,
) -> Result<Option<serde_json::Value>, TshScriptErrorKind> {
  // Reserve before the first redirection when this command's own preparation
  // can fork; an enclosing redirection of the same command may hand its own.
  let mut unit = match inherited {
    Some(unit) => Some(unit),
    None => {
      let forks = super::owned_io_fork::words_fork(host, specs)
        || super::owned_io_fork::unit_forks(host, stage);
      match host.reserve_fork_unit(forks, "redirected command", line) {
        Ok(unit) => unit,
        Err(error) => {
          host.set_shell_status(1);
          host.report_shell_diagnostic(format!("tsh: line {line}: {error}"));
          return if host.shell_errexit && !ignored {
            Err(TshScriptErrorKind::BashStatus(1))
          } else {
            Ok(None)
          };
        }
      }
    }
  };
  let io = match prepare(host, specs, line).await {
    Ok(io) => io,
    Err((io, error)) => {
      if host.shell_suspended() {
        return Err(TshScriptErrorKind::BashStatus(host.shell_status()));
      }
      host.set_shell_status(1);
      let saved = host.shell_io.replace(Some(io));
      host.report_shell_diagnostic(error);
      *host.shell_io.borrow_mut() = saved;
      return if host.shell_errexit && !ignored {
        Err(TshScriptErrorKind::BashStatus(1))
      } else {
        Ok(None)
      };
    }
  };
  // Redirections alone: the reservation ends with their preparation. A
  // simple command keeps it until its words have expanded.
  if !super::owned_io_fork::unit_forks(host, stage) {
    drop(unit.take());
  }
  let mut resolved_exec = None;
  if host.is_computed_command(stage) {
    resolved_exec = Some(resolve_target(host, stage, line).await
      .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error)))?);
  }
  let stage = resolved_exec.as_ref().unwrap_or(stage);
  let mut frozen_exec = None;
  if host.application_head(stage).as_deref() == Some("exec") {
    let resolved = resolve_target(host, stage, line).await
      .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error)))?;
    let argv = host.application_to_argv(&resolved).map_err(TshScriptErrorKind::Command)?;
    if argv.len() == 1 {
      host.trace_shell_command(&argv, line).await?;
      host.shell_compound.commands.persistent_io = Some(io.clone());
      *host.shell_io.borrow_mut() = Some(io);
      host.set_shell_status(0);
      return Ok(None);
    }
    frozen_exec = Some(host.shell_literal_call(&argv, "exec", false));
  }
  let stage = frozen_exec.as_ref().unwrap_or(stage);
  if resolved_exec.is_some() || frozen_exec.is_some() {
    // Expanded above: nothing left of this command's preparation can fork.
    drop(unit.take());
  }
  let saved = host.shell_io.replace(Some(io.clone()));
  // A simple command's trace lines ignore its own redirections: they go
  // where the shell's stderr was before the outermost of them.
  let mut innermost = stage;
  while let Some((inner, _)) = redirected_stage(host, innermost) {
    innermost = inner;
  }
  let head = host.application_head(innermost);
  let simple = !super::bash_flow::is_flow(head.as_deref()) || matches!(head.as_deref(), Some("std.sh.cmd" | "std.sh.append"));
  let outer_trace = host.shell_compound.commands.trace_io.clone();
  if simple && outer_trace.is_none() {
    host.shell_compound.commands.trace_io = Some(saved.clone());
  }
  if simple && host.shell_compound.commands.xtrace {
    // `set -x` shows each prefix assignment on its own line first.
    let target = host.shell_compound.commands.trace_io.clone();
    let before = saved.as_ref().map_or(0, |io| io.1.len());
    for (name, value) in io.1.iter().skip(before) {
      let prefix = host.shell_trace_prefix(line).await?;
      let line = format!("{prefix}{name}={}", super::bash_compound::trace_word(value));
      host.shell_compound.commands.trace_io = target.clone();
      host.write_trace(line);
    }
    host.shell_compound.commands.trace_io = target;
  }
  let mut restore = Restore {
    io: host.shell_io.clone(),
    saved,
    stdin: host.shell_stdin.clone(),
    saved_stdin: host.shell_stdin_bytes(),
    // An env-only prefix must not rewind bytes consumed by `read`. Only a
    // replacement stdin descriptor owns a separate input scope.
    restore_stdin: !matches!(io.target(0), FdTarget::Inherit(0)),
  };
  // The simple command's words expand before these redirections apply; an
  // inner redirection of the same command keeps the outermost descriptors.
  let expansion_io = (simple && host.shell_compound.commands.expansion_io.is_none())
    .then(|| restore.saved.clone());
  let result = if !io.1.is_empty() {
    let stage = freeze_environment_command(host, stage, line).await
      .map_err(|error| TshScriptErrorKind::Lisp(LispHostError::Command(error)))?;
    // The words are frozen; only a nested redirection can still fork.
    if super::owned_io_fork::unit_forks(host, &stage) {
      host.hand_off_fork_unit(unit.take());
    } else {
      drop(unit.take());
    }
    let map = environment_map(&io.1);
    if expansion_io.is_some() { host.shell_compound.commands.expansion_io = expansion_io; }
    tento_env::with_env_map_async(map, eval_flow(host, &stage, line, ignored, output.plain(), last)).await
  } else {
    if expansion_io.is_some() { host.shell_compound.commands.expansion_io = expansion_io; }
    // The command's words expand in this eval_flow, which claims the
    // reservation first and releases it when they have expanded.
    host.hand_off_fork_unit(unit.take());
    eval_flow(host, stage, line, ignored, output.plain(), last).await
  };
  // Whatever was not claimed ends with this command's preparation.
  drop(host.take_fork_handoff());
  host.shell_compound.commands.trace_io = outer_trace;
  host.shell_compound.commands.expansion_io = None;
  // An enclosing redirection restores only the descriptors it redirected.
  // exec changes to other descriptors survive the enclosing command scope.
  if let Some(mut persistent) = host.shell_compound.commands.persistent_io.clone() {
    let base = restore.saved.clone().unwrap_or_default();
    let mut affected = Vec::new();
    if let LispValue::List(specs) = specs {
      for spec in specs.items.iter().skip(1) {
        if let LispValue::List(fields) = spec {
          if let Some(LispValue::Integer(fd)) = fields.items.get(1) {
            if *fd == -1 { affected.extend([1, 2]); }
            else if let Ok(fd) = i32::try_from(*fd) { affected.push(fd); }
          }
        }
      }
    }
    for fd in &affected { persistent.0.insert(*fd, base.target(*fd)); }
    if let Some(saved) = &mut restore.saved {
      for (fd, target) in &persistent.0 {
        if !affected.contains(fd) { saved.0.insert(*fd, target.clone()); }
      }
    }
    host.shell_compound.commands.persistent_io = Some(persistent);
  }
  result
}

pub(super) fn environment_map(overlay: &[(String, String)]) -> tento_env::EnvMap {
  let map = tento_env::global_env_map()
    .map(|map| map.fork())
    .unwrap_or_else(tento_env::EnvMap::from_process);
  for (key, value) in overlay {
    map.set(key.clone(), value.clone());
  }
  map
}

fn freeze_environment_command<'a>(
  host: &'a mut LispHost,
  stage: &'a LispValue<Sym>,
  line: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<LispValue<Sym>, String>> + 'a>> {
  Box::pin(async move {
    if let Some((command, specs)) = redirected_stage(host, stage) {
      let command = freeze_environment_command(host, command, line).await?;
      let mut value = stage.clone();
      if let LispValue::List(list) = &mut value {
        list.items[1] = command;
        list.items[2] = specs.clone();
      }
      return Ok(value);
    }
    let stage = resolve_target(host, stage, line).await?;
    let argv = host
      .application_to_argv(&stage)
      .map_err(|e| e.to_string())?;
    let name = argv.first().ok_or("environment scope requires a command")?;
    Ok(host.shell_literal_call(&argv, name, false))
  })
}

pub(super) fn failed_pipeline_stage(
  host: &mut LispHost,
  mut io: ShellIo,
  error: String,
) -> ShellIo {
  let bytes = Rc::new(std::cell::RefCell::new(Vec::new()));
  let saved_io = host.shell_io.replace(Some(io.clone()));
  let saved_output = host.shell_output.replace(FlowOutput {
    writer: None,
    shaped: false,
    capture: Some(bytes.clone()),
  });
  host.report_shell_diagnostic(error);
  *host.shell_io.borrow_mut() = saved_io;
  *host.shell_output.borrow_mut() = saved_output;
  // Empty argv marks an inert failed stage. Its synthetic stdout still gets
  // a real pipe, so downstream programs see merged diagnostics and EOF.
  io.0.insert(
    1,
    FdTarget::Text(Arc::new(std::sync::Mutex::new(std::mem::take(
      &mut *bytes.borrow_mut(),
    )))),
  );
  io
}

pub(super) fn stdin_text(
  io: Option<&ShellIo>,
  input: Option<Vec<u8>>,
) -> Result<String, LispHostError> {
  let input = match io.map(|io| io.target(0)) {
    Some(FdTarget::File(file)) => {
      let mut bytes = Vec::new();
      (&*file)
        .read_to_end(&mut bytes)
        .map_err(|e| LispHostError::Command(e.to_string()))?;
      Some(bytes)
    }
    Some(FdTarget::Text(text)) => {
      Some(std::mem::take(&mut *text.lock().map_err(|_| {
        LispHostError::Command("stdin lock is poisoned".into())
      })?))
    }
    Some(FdTarget::Closed) => return Err(LispHostError::Command("Bad file descriptor".into())),
    _ => input,
  };
  String::from_utf8(input.unwrap_or_default())
    .map_err(|_| LispHostError::Runtime("std.io.stdin_text: stdin is not UTF-8".into()))
}

pub(super) fn write_target(target: &FdTarget, bytes: &[u8]) -> std::io::Result<()> {
  match target {
    FdTarget::File(file) => (&**file).write_all(bytes),
    FdTarget::Inherit(2) => {
      let mut stderr = std::io::stderr().lock();
      stderr.write_all(bytes).and_then(|()| stderr.flush())
    }
    FdTarget::Inherit(1) => {
      let mut stdout = std::io::stdout().lock();
      stdout.write_all(bytes).and_then(|()| stdout.flush())
    }
    FdTarget::Closed => Err(std::io::Error::from_raw_os_error(9)),
    _ => Err(std::io::Error::from_raw_os_error(9)),
  }
}
