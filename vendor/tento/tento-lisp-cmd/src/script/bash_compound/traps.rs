//! bash `trap`, its signal dispositions, and the signal table `kill -l` and
//! `trap -l` share (bash 5.3 §4.1 `trap`, §3.7.6 Signals).
//!
//! A trapped signal is caught by a flag-setting handler and its action runs
//! between commands, in the current shell, as bash's does. An empty action
//! is `SIG_IGN`, so children inherit it; SIGCHLD is the exception: the shell
//! keeps children waitable and applies the ignored disposition only in an
//! external child before exec, as bash does. A caught signal is reset by exec.
//! `EXIT`, `ERR`, `DEBUG` and `RETURN` are shell events.
use super::*;

/// What a trap names: a shell event or a signal number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::script) enum TrapTarget {
  Exit,
  Debug,
  Err,
  Return,
  Signal(i32),
}

impl TrapTarget {
  /// The key in `CommandState::traps`: the event name, or the signal name
  /// without `SIG`.
  pub(in crate::script) fn key(self) -> String {
    match self {
      TrapTarget::Exit => "EXIT".into(),
      TrapTarget::Debug => "DEBUG".into(),
      TrapTarget::Err => "ERR".into(),
      TrapTarget::Return => "RETURN".into(),
      TrapTarget::Signal(number) => signal_name(number)
        .unwrap_or_default()
        .trim_start_matches("SIG")
        .into(),
    }
  }

  /// The name `trap -p` prints: `EXIT`, `SIGUSR1`, `DEBUG`, …
  fn listed(self) -> String {
    match self {
      TrapTarget::Signal(number) => signal_name(number).unwrap_or_default(),
      other => other.key(),
    }
  }

  /// bash lists `EXIT`, then signals by number, then `DEBUG`, `ERR`, `RETURN`.
  fn order(self) -> i32 {
    match self {
      TrapTarget::Exit => 0,
      TrapTarget::Signal(number) => number,
      TrapTarget::Debug => 1000,
      TrapTarget::Err => 1001,
      TrapTarget::Return => 1002,
    }
  }
}

/// Every signal the host names, `(number, "SIGNAME")`, in number order.
#[cfg(unix)]
pub(in crate::script) fn signal_table() -> Vec<(i32, String)> {
  let mut table: Vec<(i32, String)> = [
    (libc::SIGHUP, "HUP"),
    (libc::SIGINT, "INT"),
    (libc::SIGQUIT, "QUIT"),
    (libc::SIGILL, "ILL"),
    (libc::SIGTRAP, "TRAP"),
    (libc::SIGABRT, "ABRT"),
    (libc::SIGFPE, "FPE"),
    (libc::SIGKILL, "KILL"),
    (libc::SIGBUS, "BUS"),
    (libc::SIGSEGV, "SEGV"),
    (libc::SIGSYS, "SYS"),
    (libc::SIGPIPE, "PIPE"),
    (libc::SIGALRM, "ALRM"),
    (libc::SIGTERM, "TERM"),
    (libc::SIGURG, "URG"),
    (libc::SIGSTOP, "STOP"),
    (libc::SIGTSTP, "TSTP"),
    (libc::SIGCONT, "CONT"),
    (libc::SIGCHLD, "CHLD"),
    (libc::SIGTTIN, "TTIN"),
    (libc::SIGTTOU, "TTOU"),
    (libc::SIGIO, "IO"),
    (libc::SIGXCPU, "XCPU"),
    (libc::SIGXFSZ, "XFSZ"),
    (libc::SIGVTALRM, "VTALRM"),
    (libc::SIGPROF, "PROF"),
    (libc::SIGWINCH, "WINCH"),
    (libc::SIGUSR1, "USR1"),
    (libc::SIGUSR2, "USR2"),
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    (libc::SIGEMT, "EMT"),
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    (libc::SIGINFO, "INFO"),
    #[cfg(any(target_os = "linux", target_os = "android"))]
    (libc::SIGSTKFLT, "STKFLT"),
    #[cfg(any(target_os = "linux", target_os = "android"))]
    (libc::SIGPWR, "PWR"),
  ]
  .into_iter()
  .map(|(number, name)| (number, format!("SIG{name}")))
  .collect();
  #[cfg(any(target_os = "linux", target_os = "android"))]
  {
    let (min, max) = (libc::SIGRTMIN(), libc::SIGRTMAX());
    for number in min..=max {
      let name = if number - min <= (max - min) / 2 {
        match number - min {
          0 => "SIGRTMIN".to_string(),
          offset => format!("SIGRTMIN+{offset}"),
        }
      } else {
        match max - number {
          0 => "SIGRTMAX".to_string(),
          offset => format!("SIGRTMAX-{offset}"),
        }
      };
      table.push((number, name));
    }
  }
  table.sort_by_key(|(number, _)| *number);
  table
}

#[cfg(not(unix))]
pub(in crate::script) fn signal_table() -> Vec<(i32, String)> {
  vec![(2, "SIGINT".into()), (15, "SIGTERM".into())]
}

/// `SIGUSR1` for 30 (on macOS); `None` for a number the host does not name.
pub(in crate::script) fn signal_name(number: i32) -> Option<String> {
  signal_table()
    .into_iter()
    .find_map(|(n, name)| (n == number).then_some(name))
}

/// A signal by number, or by name in any case, with or without `SIG`.
pub(in crate::script) fn parse_signal(spec: &str) -> Option<i32> {
  if let Ok(number) = spec.parse::<i32>() {
    return signal_name(number).map(|_| number);
  }
  let upper = spec.to_ascii_uppercase();
  let name = upper.strip_prefix("SIG").unwrap_or(&upper);
  signal_table()
    .into_iter()
    .find_map(|(number, listed)| (listed[3..] == *name).then_some(number))
}

/// A trap condition: `0`/`EXIT`, `DEBUG`, `ERR`, `RETURN`, or a signal.
pub(in crate::script) fn parse_trap_target(spec: &str) -> Option<TrapTarget> {
  let upper = spec.to_ascii_uppercase();
  match upper.strip_prefix("SIG").unwrap_or(&upper) {
    "0" | "EXIT" => Some(TrapTarget::Exit),
    "DEBUG" => Some(TrapTarget::Debug),
    "ERR" => Some(TrapTarget::Err),
    "RETURN" => Some(TrapTarget::Return),
    _ => parse_signal(spec).map(TrapTarget::Signal),
  }
}

fn target_for_key(key: &str) -> Option<TrapTarget> {
  parse_trap_target(key)
}

/// bash's signal listing (`kill -l`, `trap -l`): five `%2d) NAME` columns.
pub(in crate::script) fn signal_listing() -> String {
  let mut text = String::new();
  let mut column = 0;
  for (number, name) in signal_table() {
    text.push_str(&format!("{number:2}) {name}"));
    column += 1;
    if column < 5 {
      text.push('\t');
    } else {
      text.push('\n');
      column = 0;
    }
  }
  if column != 0 {
    text.push('\n');
  }
  text
}

/// Whether `number` was ignored when this shell started: bash lists such a
/// signal as `trap -- '' SIG…` and never traps it. The first look at the
/// dispositions, at host construction, records entry; SIGPIPE is left out
/// because the Rust runtime ignores it in every process before `main`.
pub(in crate::script) fn ignored_at_entry(number: i32) -> bool {
  #[cfg(unix)]
  {
    static ENTRY: std::sync::OnceLock<Vec<i32>> = std::sync::OnceLock::new();
    ENTRY
      .get_or_init(|| {
        signal_table()
          .into_iter()
          .map(|(n, _)| n)
          .filter(|n| *n != libc::SIGPIPE && signal_disposition::is_ignored(*n))
          .collect()
      })
      .contains(&number)
  }
  #[cfg(not(unix))]
  {
    let _ = number;
    false
  }
}

fn quote_action(action: &str) -> String {
  format!("'{}'", action.replace('\'', "'\\''"))
}

const TRAP_USAGE: &str = "trap: usage: trap [-Plp] [[action] signal_spec ...]";

impl LispHost {
  /// Snapshot the shell's logical or entry-inherited ignored SIGCHLD for a
  /// hosted external command. Carry this to the actual exec child; a process
  /// supervising that child must keep SIGCHLD waitable.
  #[cfg(unix)]
  pub fn ignored_sigchld() -> bool {
    signal_disposition::ignored_sigchld()
  }

  /// Apply the shell's logical ignored SIGCHLD disposition in an external
  /// child, without making this process's children un-waitable. Embedders
  /// launching shell commands must call this before spawn (also for Tokio's
  /// `Command::as_std_mut`). The snapshot belongs to this command; no parent
  /// signal disposition is changed, and the child takes no Rust locks.
  #[cfg(unix)]
  pub fn inherit_ignored_sigchld(command: &mut std::process::Command) {
    if Self::ignored_sigchld() {
      Self::apply_sigchld_snapshot(command, true);
    }
  }

  /// Apply a supplied shell snapshot only in the exec child. Use this when
  /// a different process launches a yielded command: its local trap state
  /// does not describe the originating shell. False explicitly resets the
  /// child to SIG_DFL; true installs SIG_IGN. Neither changes the parent.
  #[cfg(unix)]
  pub fn apply_sigchld_snapshot(command: &mut std::process::Command, ignored: bool) {
    signal_disposition::apply_sigchld_snapshot(command, ignored);
  }

  /// bash `trap [-Plp] [[action] signal_spec ...]`.
  pub(in crate::script) fn trap_builtin(
    &mut self,
    args: &[String],
    line: usize,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    let mut index = 0;
    let (mut list, mut print, mut action_only) = (false, false, false);
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
          'l' => list = true,
          'p' => print = true,
          'P' => action_only = true,
          other => {
            self
              .report_shell_diagnostic(format!("tsh: line {line}: trap: -{other}: invalid option"));
            self.report_shell_diagnostic(TRAP_USAGE.into());
            self.set_shell_status(2);
            return Ok(None);
          }
        }
      }
      index += 1;
    }
    let operands = &args[index..];
    // Take the entry snapshot before any trap changes a disposition.
    let _ = ignored_at_entry(0);
    if list {
      output.write_bytes(self, signal_listing().as_bytes());
      self.set_shell_status(0);
      return Ok(None);
    }
    if action_only && operands.is_empty() {
      self.report_shell_diagnostic(format!(
        "tsh: line {line}: trap: -P requires at least one signal name"
      ));
      self.set_shell_status(2);
      return Ok(None);
    }
    if print || action_only || operands.is_empty() {
      return self.trap_listing(operands, line, action_only, output);
    }
    // One operand, `-`, or an unsigned number first: every operand is a
    // condition to reset (POSIX).
    let (action, conditions) = if operands.len() == 1 {
      if operands[0] == "-" {
        self.report_shell_diagnostic(TRAP_USAGE.into());
        self.set_shell_status(2);
        return Ok(None);
      }
      (None, operands)
    } else if operands[0] == "-" {
      (None, &operands[1..])
    } else if !operands[0].is_empty() && operands[0].bytes().all(|b| b.is_ascii_digit()) {
      (None, operands)
    } else {
      (Some(operands[0].clone()), &operands[1..])
    };
    let mut status = 0;
    for spec in conditions {
      let Some(target) = parse_trap_target(spec) else {
        self.report_shell_diagnostic(format!(
          "tsh: line {line}: trap: {spec}: invalid signal specification"
        ));
        status = 1;
        continue;
      };
      // A signal ignored when the shell started cannot be trapped or reset.
      if let TrapTarget::Signal(number) = target {
        if ignored_at_entry(number) {
          continue;
        }
      }
      // A subshell stops showing its parent's traps once it sets its own.
      self.shell_compound.commands.inherited_traps.clear();
      match &action {
        Some(action) => {
          self
            .shell_compound
            .commands
            .traps
            .insert(target.key(), action.clone());
        }
        None => {
          self.shell_compound.commands.traps.remove(&target.key());
        }
      }
    }
    self.sync_signal_traps();
    self.set_shell_status(status);
    Ok(None)
  }

  fn trap_listing(
    &mut self,
    operands: &[String],
    line: usize,
    action_only: bool,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    let shown = |host: &LispHost, key: &str| {
      host
        .shell_compound
        .commands
        .traps
        .get(key)
        .or_else(|| host.shell_compound.commands.inherited_traps.get(key))
        .cloned()
        .or_else(|| match target_for_key(key) {
          Some(TrapTarget::Signal(number)) if ignored_at_entry(number) => Some(String::new()),
          _ => None,
        })
    };
    let mut text = String::new();
    let mut status = 0;
    let targets: Vec<TrapTarget> = if operands.is_empty() {
      let commands = &self.shell_compound.commands;
      let mut targets: Vec<TrapTarget> = commands
        .traps
        .keys()
        .chain(commands.inherited_traps.keys())
        .filter_map(|key| target_for_key(key))
        .chain(
          signal_table()
            .into_iter()
            .map(|(n, _)| n)
            .filter(|n| ignored_at_entry(*n))
            .map(TrapTarget::Signal),
        )
        .collect();
      targets.sort_by_key(|target| target.order());
      targets.dedup();
      targets
    } else {
      let mut targets = Vec::new();
      for spec in operands {
        match parse_trap_target(spec) {
          Some(target) => targets.push(target),
          None => {
            self.report_shell_diagnostic(format!(
              "tsh: line {line}: trap: {spec}: invalid signal specification"
            ));
            status = 1;
          }
        }
      }
      targets
    };
    for target in targets {
      let Some(action) = shown(self, &target.key()) else {
        continue;
      };
      if action_only {
        text.push_str(&format!("{action}\n"));
      } else {
        text.push_str(&format!(
          "trap -- {} {}\n",
          quote_action(&action),
          target.listed()
        ));
      }
    }
    if !text.is_empty() {
      output.write_bytes(self, text.as_bytes());
    }
    self.set_shell_status(status);
    Ok(None)
  }

  /// Bring the process's signal dispositions in line with the trap table:
  /// a non-empty action catches, an empty one ignores, and a signal this
  /// shell no longer traps gets back the disposition it had before. SIGCHLD
  /// keeps its native catcher/chain; only its logical trap mode changes.
  pub(in crate::script) fn sync_signal_traps(&mut self) {
    #[cfg(unix)]
    {
      let mut wanted: HashMap<i32, bool> = HashMap::new();
      for (key, action) in &self.shell_compound.commands.traps {
        if let Some(TrapTarget::Signal(number)) = target_for_key(key) {
          wanted.insert(number, action.is_empty());
        }
      }
      let held: Vec<i32> = self
        .shell_compound
        .commands
        .signals
        .iter()
        .copied()
        .collect();
      for number in held {
        if !wanted.contains_key(&number) {
          signal_disposition::restore(number);
          self.shell_compound.commands.signals.remove(&number);
        }
      }
      for (number, ignore) in wanted {
        if signal_disposition::set(number, ignore) {
          self.shell_compound.commands.signals.insert(number);
        }
      }
    }
  }

  /// Run the action trapped for `event` (`EXIT`, `ERR`, `DEBUG`, `RETURN`
  /// or a signal key), in the current shell, keeping `$?`.
  pub(in crate::script) async fn run_shell_trap(
    &mut self,
    signal: &str,
    line: usize,
    output: FlowOutput,
  ) -> Result<()> {
    let commands = &self.shell_compound.commands;
    let in_function = self.shell_compound.calls > 0;
    if commands.in_trap
      || signal == "ERR" && in_function && !commands.errtrace
      || signal == "DEBUG" && in_function && !commands.functrace
    {
      return Ok(());
    }
    let Some(action) = self.shell_compound.commands.traps.get(signal).cloned() else {
      return Ok(());
    };
    if action.is_empty() {
      return Ok(());
    }
    let status = self.shell_status();
    self.shell_compound.commands.in_trap = true;
    let result = match self.read_posix_line_value(&action) {
      Ok(value) => eval_flow(self, &value, line, true, output.clone().plain(), false).await,
      Err(error) => {
        // bash reports a trap action that does not parse and carries on.
        self.report_shell_diagnostic(format!("tsh: line {line}: {error}"));
        Ok(None)
      }
    };
    self.shell_compound.commands.in_trap = false;
    match result {
      Ok(value) => {
        output.flush_value(self, value);
        self.set_shell_status(status);
        Ok(())
      }
      Err(error) => Err(error),
    }
  }

  /// Whether any signal is trapped (caught or ignored) by this shell.
  pub(in crate::script) fn has_trapped_signals(&self) -> bool {
    #[cfg(unix)]
    return !self.shell_compound.commands.signals.is_empty();
    #[cfg(not(unix))]
    false
  }

  /// Run the actions of the trapped signals that arrived since the last
  /// command, in signal-number order.
  pub(in crate::script) async fn poll_shell_signals(
    &mut self,
    line: usize,
    output: FlowOutput,
  ) -> Result<()> {
    #[cfg(unix)]
    {
      if self.shell_compound.commands.in_trap || self.shell_compound.commands.signals.is_empty() {
        return Ok(());
      }
      let mut held: Vec<i32> = self
        .shell_compound
        .commands
        .signals
        .iter()
        .copied()
        .collect();
      held.sort_unstable();
      for number in held {
        // A subshell that dropped its parent's trap leaves the signal
        // pending for the parent, whose handler is still installed.
        let key = TrapTarget::Signal(number).key();
        if !self
          .shell_compound
          .commands
          .traps
          .get(&key)
          .is_some_and(|action| !action.is_empty())
        {
          continue;
        }
        if signal_disposition::take_pending(number) {
          self.run_shell_trap(&key, line, output.clone()).await?;
        }
      }
    }
    Ok(())
  }

  /// The `DEBUG` trap, before a simple command; `$BASH_COMMAND` is the
  /// command about to run.
  pub(in crate::script) async fn run_debug_trap(
    &mut self,
    argv: &[String],
    line: usize,
    output: FlowOutput,
  ) -> Result<()> {
    if self.shell_compound.commands.in_trap
      || self.shell_compound.calls > 0 && !self.shell_compound.commands.functrace
      || !self
        .shell_compound
        .commands
        .traps
        .get("DEBUG")
        .is_some_and(|action| !action.is_empty())
    {
      return Ok(());
    }
    self.assign_shell_variable("BASH_COMMAND", argv.join(" "), false);
    self.run_shell_trap("DEBUG", line, output).await
  }

  /// Enter a subshell's trap state: caught traps are reset (an ignored
  /// signal stays ignored), but `trap -p` still shows the parent's until the
  /// subshell sets one of its own. Returns what [`Self::leave_subshell_traps`]
  /// restores.
  pub(in crate::script) fn enter_subshell_traps(&mut self) -> SubshellTraps {
    let commands = &mut self.shell_compound.commands;
    let traps = commands.traps.clone();
    let inherited = std::mem::take(&mut commands.inherited_traps);
    let mut shown = traps.clone();
    for (key, action) in &inherited {
      shown.entry(key.clone()).or_insert_with(|| action.clone());
    }
    // `set -E` keeps ERR, `set -T` keeps DEBUG and RETURN.
    let (errtrace, functrace) = (commands.errtrace, commands.functrace);
    commands.traps.retain(|key, action| {
      action.is_empty()
        || errtrace && key == "ERR"
        || functrace && matches!(key.as_str(), "DEBUG" | "RETURN")
    });
    shown.retain(|key, _| !commands.traps.contains_key(key));
    commands.inherited_traps = shown;
    SubshellTraps { traps, inherited }
  }

  /// Run the subshell's own `EXIT` trap, then restore the parent's traps
  /// and dispositions.
  pub(in crate::script) async fn leave_subshell_traps(
    &mut self,
    saved: SubshellTraps,
    line: usize,
    output: FlowOutput,
  ) -> Result<()> {
    let result = self.run_shell_trap("EXIT", line, output).await;
    self.shell_compound.commands.traps = saved.traps;
    self.shell_compound.commands.inherited_traps = saved.inherited;
    self.sync_signal_traps();
    result
  }
}

/// The parent's trap state, held while a subshell runs.
pub(in crate::script) struct SubshellTraps {
  traps: HashMap<String, String>,
  inherited: HashMap<String, String>,
}

/// Raw dispositions. The catching handler only sets a flag (and chains to a
/// handler that was installed before, such as the async runtime's), so the
/// action itself runs between commands.
#[cfg(unix)]
pub(in crate::script) mod signal_disposition {
  use std::collections::HashMap;
  use std::sync::Mutex;
  use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

  const SLOTS: usize = 128;
  static PENDING: [AtomicBool; SLOTS] = [const { AtomicBool::new(false) }; SLOTS];
  static CHAIN: [AtomicUsize; SLOTS] = [const { AtomicUsize::new(0) }; SLOTS];
  static CHAIN_INFO: [AtomicBool; SLOTS] = [const { AtomicBool::new(false) }; SLOTS];
  static ORIGINAL: Mutex<Option<HashMap<i32, libc::sigaction>>> = Mutex::new(None);
  const CHLD_CAUGHT: usize = 1;
  const CHLD_PENDING: usize = 2;
  const CHLD_IGNORED: usize = 4;
  static CHLD_STATE: AtomicUsize = AtomicUsize::new(0);

  pub(super) fn ignored_sigchld() -> bool {
    // Inherited SIG_IGN is never installed in CHLD_STATE: bash keeps such
    // an entry trap ignored even after Tokio replaces the native handler.
    // Host construction primes ENTRY before child setup; forked workers
    // inherit that completed snapshot instead of taking a copied Rust lock.
    super::ignored_at_entry(libc::SIGCHLD) || CHLD_STATE.load(Ordering::SeqCst) & CHLD_IGNORED != 0
  }

  pub(super) fn apply_sigchld_snapshot(command: &mut std::process::Command, ignored: bool) {
    use std::os::unix::process::CommandExt;
    // SAFETY: runs only in the child; sigaction/sigemptyset are
    // async-signal-safe and all storage is local, without allocation or locks.
    unsafe {
      command.pre_exec(move || {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = if ignored { libc::SIG_IGN } else { libc::SIG_DFL };
        libc::sigemptyset(&mut action.sa_mask);
        if libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) < 0 {
          return Err(std::io::Error::last_os_error());
        }
        Ok(())
      });
    }
  }

  fn slot(number: i32) -> Option<usize> {
    usize::try_from(number)
      .ok()
      .filter(|n| *n > 0 && *n < SLOTS)
  }

  extern "C" fn catch(number: libc::c_int, info: *mut libc::siginfo_t, context: *mut libc::c_void) {
    let Some(slot) = slot(number) else { return };
    if number == libc::SIGCHLD {
      // Keep the mode and pending bit in one atomic so a signal from an
      // ignored/default interval cannot become pending after a later catch.
      let _ = CHLD_STATE.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
        (state & CHLD_CAUGHT != 0).then_some(state | CHLD_PENDING)
      });
    } else {
      PENDING[slot].store(true, Ordering::SeqCst);
    }
    let chained = CHAIN[slot].load(Ordering::SeqCst);
    if chained != 0 {
      // SAFETY: `chained` is the handler address the previous sigaction held
      // (never SIG_DFL or SIG_IGN), called with the signature its flags name.
      unsafe {
        if CHAIN_INFO[slot].load(Ordering::SeqCst) {
          let handler: extern "C" fn(libc::c_int, *mut libc::siginfo_t, *mut libc::c_void) =
            std::mem::transmute(chained);
          handler(number, info, context);
        } else {
          let handler: extern "C" fn(libc::c_int) = std::mem::transmute(chained);
          handler(number);
        }
      }
    }
  }

  fn current(number: i32) -> Option<libc::sigaction> {
    let mut action = std::mem::MaybeUninit::<libc::sigaction>::zeroed();
    // SAFETY: a null new action only reads the current one.
    (unsafe { libc::sigaction(number, std::ptr::null(), action.as_mut_ptr()) } == 0)
      .then(|| unsafe { action.assume_init() })
  }

  /// Catch (`ignore` false) or ignore `number`; SIGCHLD always keeps a native
  /// catcher so child exit status stays waitable. False when the host refuses
  /// (`KILL`, `STOP`), which bash accepts and never fires.
  pub fn set(number: i32, ignore: bool) -> bool {
    let Some(slot) = slot(number) else {
      return false;
    };
    let Ok(mut original) = ORIGINAL.lock() else {
      return false;
    };
    let original = original.get_or_insert_with(HashMap::new);
    if number == libc::SIGCHLD && original.contains_key(&number) {
      // Pin the first catcher and its immutable chain for the process's
      // lifetime. Tokio may subsequently install a handler which chains us;
      // replacing it, or chaining it back from here, loses wakeups or recurses.
      set_chld_mode(ignore);
      return true;
    }
    let saved = match original.get(&number) {
      Some(saved) => *saved,
      None => {
        let Some(action) = current(number) else {
          return false;
        };
        original.insert(number, action);
        action
      }
    };
    let previous = saved.sa_sigaction;
    if previous != libc::SIG_DFL && previous != libc::SIG_IGN && previous != catch as usize {
      CHAIN[slot].store(previous, Ordering::SeqCst);
      CHAIN_INFO[slot].store(saved.sa_flags & libc::SA_SIGINFO != 0, Ordering::SeqCst);
    } else {
      CHAIN[slot].store(0, Ordering::SeqCst);
    }
    // SAFETY: a zeroed sigaction with an empty mask and a valid handler.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    if ignore && number != libc::SIGCHLD {
      action.sa_sigaction = libc::SIG_IGN;
    } else {
      action.sa_sigaction = catch as usize;
      action.sa_flags = libc::SA_SIGINFO | libc::SA_RESTART;
    }
    unsafe { libc::sigemptyset(&mut action.sa_mask) };
    // SAFETY: installs a fully initialised action for a valid signal number.
    let installed = unsafe { libc::sigaction(number, &action, std::ptr::null_mut()) == 0 };
    if number == libc::SIGCHLD {
      if installed {
        set_chld_mode(ignore);
      } else {
        original.remove(&number);
      }
    }
    installed
  }

  fn set_chld_mode(ignore: bool) {
    let _ = CHLD_STATE.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
      Some(if ignore { CHLD_IGNORED } else { CHLD_CAUGHT | (state & CHLD_PENDING) })
    });
  }

  /// Give `number` back the disposition it had before the first trap, except
  /// SIGCHLD, whose pinned chain stays installed with its logical trap reset.
  pub fn restore(number: i32) {
    if number == libc::SIGCHLD {
      // Reset the logical trap, not a runtime handler installed above us.
      // The pinned catcher only chains the original handler in default mode;
      // it never reaps, ignores SIGCHLD or sets SA_NOCLDWAIT.
      CHLD_STATE.store(0, Ordering::SeqCst);
      return;
    }
    let Ok(mut original) = ORIGINAL.lock() else {
      return;
    };
    if let Some(saved) = original.get_or_insert_with(HashMap::new).remove(&number) {
      // SAFETY: `saved` is the action sigaction reported for this signal.
      unsafe { libc::sigaction(number, &saved, std::ptr::null_mut()) };
    }
    if let Some(slot) = slot(number) {
      CHAIN[slot].store(0, Ordering::SeqCst);
      PENDING[slot].store(false, Ordering::SeqCst);
    }
  }

  /// Whether `number`'s disposition is `SIG_IGN` and no trap set it so.
  pub fn is_ignored(number: i32) -> bool {
    let ours = ORIGINAL.lock().ok().is_some_and(|original| {
      original
        .as_ref()
        .is_some_and(|map| map.contains_key(&number))
    });
    !ours && current(number).is_some_and(|action| action.sa_sigaction == libc::SIG_IGN)
  }

  /// Whether `number` arrived since the last call.
  pub fn take_pending(number: i32) -> bool {
    if number == libc::SIGCHLD {
      return CHLD_STATE.fetch_and(!CHLD_PENDING, Ordering::SeqCst) & CHLD_PENDING != 0;
    }
    slot(number).is_some_and(|slot| PENDING[slot].swap(false, Ordering::SeqCst))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn trap_targets_accept_bash_spellings() {
    assert_eq!(parse_trap_target("0"), Some(TrapTarget::Exit));
    assert_eq!(parse_trap_target("exit"), Some(TrapTarget::Exit));
    assert_eq!(parse_trap_target("ERR"), Some(TrapTarget::Err));
    assert_eq!(parse_trap_target("usr1"), parse_trap_target("SIGUSR1"));
    assert_eq!(parse_trap_target("15"), Some(TrapTarget::Signal(15)));
    assert_eq!(parse_trap_target("NOSUCHSIG"), None);
    assert_eq!(parse_trap_target("999"), None);
    assert_eq!(parse_trap_target("-5"), None);
  }

  #[cfg(unix)]
  #[test]
  fn signal_keys_drop_the_sig_prefix() {
    assert_eq!(TrapTarget::Signal(libc::SIGUSR1).key(), "USR1");
    assert_eq!(TrapTarget::Signal(libc::SIGUSR1).listed(), "SIGUSR1");
    assert_eq!(parse_signal("term"), Some(libc::SIGTERM));
    assert_eq!(parse_signal("SIGHUP"), Some(libc::SIGHUP));
  }

  #[test]
  fn listing_is_five_columns() {
    let listing = signal_listing();
    let first = listing.lines().next().unwrap();
    assert_eq!(
      first,
      " 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 4) SIGILL\t 5) SIGTRAP"
    );
    assert!(listing.ends_with('\n'));
  }

  #[test]
  fn listed_actions_are_single_quoted() {
    assert_eq!(quote_action("echo it's"), "'echo it'\\''s'");
  }
}

#[cfg(all(test, unix))]
mod sigchld_tests {
  use super::*;
  use std::io::Write;
  use std::process::{Command, Stdio};
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::time::{Duration, Instant};

  static CHAIN_CALLS: AtomicUsize = AtomicUsize::new(0);

  struct Programs;

  impl crate::script::ExternalCommands for Programs {
    fn lookup(&self, name: &str) -> crate::script::ExternalLookup {
      if name == "/usr/bin/python3" { crate::script::ExternalLookup::Runs }
      else { crate::script::ExternalLookup::NotFound }
    }
    fn run(&self, argv: Vec<String>) -> crate::script::AsyncCommandFut {
      let future = self.run_pipeline_with_io(vec![argv], None, false, vec![]);
      Box::pin(async move {
        let result = future.await?;
        if result.status == 0 { Ok(serde_json::Value::Null) }
        else { Err(crate::Error::ProcessExit {
          status: Some(result.status), signal: None, detail: "signal inheritance probe failed".into(),
        }) }
      })
    }
    fn run_pipeline_with_io(
      &self, argv: Vec<Vec<String>>, input: Option<Vec<u8>>, capture: bool,
      io: Vec<Option<crate::script::ShellIo>>,
    ) -> crate::script::PipelineFuture {
      Box::pin(crate::script::run_process_pipeline_with_io(
        argv.into_iter().map(|args| (std::path::PathBuf::from(&args[0]), args)).collect(),
        input, capture, None, None, io,
      ))
    }
    fn run_pipeline(
      &self, argv: Vec<Vec<String>>, input: Option<Vec<u8>>, capture: bool,
    ) -> crate::script::PipelineFuture {
      self.run_pipeline_with_io(argv, input, capture, vec![])
    }
    fn start_background(
      &self, argv: Vec<String>, io: Option<crate::script::ShellIo>, capture: bool,
    ) -> crate::Result<crate::script::ShellJob> {
      crate::script::start_process_background(std::path::PathBuf::from(&argv[0]), argv, io, capture, None)
    }
    fn suggest(&self, _: &str) -> Option<String> { None }
  }

  extern "C" fn chained(_: libc::c_int) {
    CHAIN_CALLS.fetch_add(1, Ordering::SeqCst);
  }

  extern "C" fn chained_info(_: libc::c_int, _: *mut libc::siginfo_t, _: *mut libc::c_void) {
    CHAIN_CALLS.fetch_add(1, Ordering::SeqCst);
  }

  fn disposition() -> libc::sigaction {
    let mut action = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::sigaction(libc::SIGCHLD, std::ptr::null(), &mut action) }, 0);
    action
  }

  fn assert_waitable() {
    let action = disposition();
    assert_ne!(action.sa_sigaction, libc::SIG_IGN);
    assert_eq!(action.sa_flags & libc::SA_NOCLDWAIT, 0);
  }

  async fn trap(host: &mut LispHost, source: &str) {
    crate::script::run_source_on_host(
      host, &format!("(sh! {source})"), &crate::Scripts::new(()),
      &HashMap::new(), &[], crate::script::RunOptions::default(),
    ).await.unwrap();
  }

  fn exited_without_reaping(pid: u32) -> bool {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe {
      libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT)
    }, 0, "exact child {pid} lost: {}", std::io::Error::last_os_error());
    info.si_signo == libc::SIGCHLD
  }

  #[test]
  fn supported_sigchld_transitions_preserve_waitability_and_handlers() {
    for mode in ["default", "handler", "siginfo", "tokio-before", "tokio-after", "inherited-ignore"] {
      let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "script::bash_compound::traps::sigchld_tests::transition_probe", "--nocapture"])
        .env("TENTO_SIGCHLD_TRANSITION_PROBE", mode).output().unwrap();
      assert!(output.status.success(), "{mode}: {}{}",
        String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
  }

  #[test]
  fn transition_probe() {
    let Ok(mode) = std::env::var("TENTO_SIGCHLD_TRANSITION_PROBE") else { return };
    if mode == "inherited-exec" || mode == "default-exec" {
      let ignored = mode == "inherited-exec";
      assert_eq!(disposition().sa_sigaction, if ignored { libc::SIG_IGN } else { libc::SIG_DFL });
      assert_eq!(LispHost::ignored_sigchld(), ignored);
      println!("SNAPSHOT-CHLD-{mode}");
      return;
    }
    if mode == "inherited-ignore" {
      // Only this isolated process changes its entry disposition. Capture
      // must refuse such startup; the shell's inherited ignored trap still
      // belongs in descendants and cannot be reset by `trap -`.
      assert_ne!(unsafe { libc::signal(libc::SIGCHLD, libc::SIG_IGN) }, libc::SIG_ERR);
      let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
      runtime.block_on(async {
        let mut host = LispHost::new();
        // An explicit false snapshot overrides even a viewer's native IGN,
        // without resetting that viewer. No getter has run yet in this host.
        let mut reset = Command::new(std::env::current_exe().unwrap());
        reset.args(["--exact", "script::bash_compound::traps::sigchld_tests::transition_probe", "--nocapture"])
          .env("TENTO_SIGCHLD_TRANSITION_PROBE", "default-exec").stdout(Stdio::piped());
        LispHost::apply_sigchld_snapshot(&mut reset, false);
        let mut child = reset.spawn().unwrap();
        let mut output = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take().unwrap(), &mut output).unwrap();
        assert!(output.contains("SNAPSHOT-CHLD-default-exec"), "{output}");
        assert_eq!(child.wait().unwrap_err().raw_os_error(), Some(libc::ECHILD));
        assert_eq!(disposition().sa_sigaction, libc::SIG_IGN);

        // Install the actual Tokio handler before the first getter or trap.
        // Reading native SIGCHLD lazily can no longer recover entry IGN.
        let _notifications = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()).unwrap();
        let handler = disposition().sa_sigaction;
        assert_ne!(handler, libc::SIG_IGN);
        assert!(LispHost::ignored_sigchld());
        for explicit_snapshot in [None, Some(true), Some(false)] {
          let mode = if explicit_snapshot == Some(false) { "default-exec" } else { "inherited-exec" };
          let mut command = Command::new(std::env::current_exe().unwrap());
          command.args(["--exact", "script::bash_compound::traps::sigchld_tests::transition_probe", "--nocapture"])
            .env("TENTO_SIGCHLD_TRANSITION_PROBE", mode).stdout(Stdio::piped());
          if let Some(ignored) = explicit_snapshot {
            LispHost::apply_sigchld_snapshot(&mut command, ignored && LispHost::ignored_sigchld());
          } else {
            LispHost::inherit_ignored_sigchld(&mut command);
          }
          let output = tokio::process::Command::from(command).output().await.unwrap();
          assert!(output.status.success(), "{:?}", output);
          assert!(String::from_utf8_lossy(&output.stdout).contains(&format!("SNAPSHOT-CHLD-{mode}")));
          if explicit_snapshot.is_none() {
            // A second ignored child follows trap reset, exactly the CLI
            // regression: the first async exec installed Tokio in between.
            for source in ["trap - CHLD", "trap ':' CHLD", "trap '' CHLD"] {
              trap(&mut host, source).await;
              assert!(LispHost::ignored_sigchld());
              assert_eq!(disposition().sa_sigaction, handler);
            }
            let listed = host.capture_shell_source("trap -p CHLD").await.unwrap();
            assert_eq!(listed.stdout, b"trap -- '' SIGCHLD\n");
          }
          assert_eq!(disposition().sa_sigaction, handler);
        }
        drop(host);
        assert!(LispHost::ignored_sigchld());
      });
      return;
    }
    if mode == "handler" || mode == "siginfo" {
      let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
      action.sa_sigaction = if mode == "handler" { chained as *const () as usize }
        else { chained_info as *const () as usize };
      action.sa_flags = if mode == "siginfo" { libc::SA_SIGINFO } else { 0 };
      unsafe {
        libc::sigemptyset(&mut action.sa_mask);
        assert_eq!(libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()), 0);
      }
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
      let mut host = LispHost::new();
      let mut notifications = if mode == "tokio-before" {
        Some(tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()).unwrap())
      } else { None };
      trap(&mut host, "trap '' CHLD").await;
      if mode == "tokio-after" {
        notifications = Some(tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()).unwrap());
      }
      let pinned_handler = disposition().sa_sigaction;
      assert_waitable();
      let listed = host.capture_shell_source("trap -p CHLD").await.unwrap();
      assert_eq!(listed.stdout, b"trap -- '' SIGCHLD\n");

      // An exact native child remains owned while alive and while retained
      // as an exited, non-reaped leader. Tokio must never reap this child.
      let mut child = Command::new("/bin/sh").args(["-c", "read line; exit 23"])
        .stdin(Stdio::piped()).spawn().unwrap();
      let mut tokio_child = if notifications.is_some() {
        Some(tokio::process::Command::new("/bin/sleep").arg("0.03").spawn().unwrap())
      } else { None };
      for source in ["trap ':' CHLD", "trap '' CHLD", "trap - CHLD", "trap '' CHLD"] {
        trap(&mut host, source).await;
        assert_waitable();
        assert_eq!(disposition().sa_sigaction, pinned_handler);
      }
      child.stdin.take().unwrap().write_all(b"finish\n").unwrap();
      let deadline = Instant::now() + Duration::from_secs(2);
      while !exited_without_reaping(child.id()) {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(2)).await;
      }
      for source in ["trap - CHLD", "trap ':' CHLD", "trap '' CHLD", "trap - CHLD"] {
        trap(&mut host, source).await;
        assert!(exited_without_reaping(child.id()));
        assert_waitable();
        assert_eq!(disposition().sa_sigaction, pinned_handler);
      }
      assert_eq!(child.wait().unwrap().code(), Some(23));
      if let Some(child) = &mut tokio_child {
        assert!(tokio::time::timeout(Duration::from_secs(2), child.wait()).await.unwrap().unwrap().success());
      }
      if let Some(stream) = &mut notifications {
        assert!(tokio::time::timeout(Duration::from_secs(2), stream.recv()).await.unwrap().is_some());
      }
      // Catch, ignore and default all preserve the original handler chain;
      // ignored/default signals do not become a stale caught trap later.
      for source in ["trap ':' CHLD", "trap '' CHLD", "trap - CHLD"] {
        trap(&mut host, source).await;
        let before = CHAIN_CALLS.load(Ordering::SeqCst);
        assert_eq!(unsafe { libc::raise(libc::SIGCHLD) }, 0);
        if mode == "handler" || mode == "siginfo" {
          assert_eq!(CHAIN_CALLS.load(Ordering::SeqCst), before + 1);
        }
        assert_eq!(signal_disposition::take_pending(libc::SIGCHLD), source == "trap ':' CHLD");
      }
      trap(&mut host, "trap ':' CHLD").await;
      assert!(!signal_disposition::take_pending(libc::SIGCHLD));
      trap(&mut host, "trap - CHLD").await;

      // The child-only hook snapshots the ignored disposition at preparation;
      // resetting the parent before spawn cannot change this command's policy.
      trap(&mut host, "trap '' CHLD").await;
      assert!(LispHost::ignored_sigchld());
      let mut inherited = Command::new("/usr/bin/python3");
      inherited.args(["-c", "import signal,sys; sys.exit(0 if signal.getsignal(signal.SIGCHLD) == signal.SIG_IGN else 9)"]);
      LispHost::inherit_ignored_sigchld(&mut inherited);
      trap(&mut host, "trap - CHLD").await;
      assert!(!LispHost::ignored_sigchld());
      assert!(inherited.status().unwrap().success());
      let mut reset = Command::new("/usr/bin/python3");
      reset.args(["-c", "import signal,sys; sys.exit(0 if signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL else 9)"]);
      LispHost::inherit_ignored_sigchld(&mut reset);
      assert!(reset.status().unwrap().success());

      // A viewer applies another process's snapshot, never its local mode.
      // Both booleans must override the unrelated local trap state.
      for ignored in [true, false] {
        trap(&mut host, if ignored { "trap - CHLD" } else { "trap '' CHLD" }).await;
        assert_ne!(LispHost::ignored_sigchld(), ignored);
        let mut yielded = Command::new("/usr/bin/python3");
        yielded.args(["-c", if ignored {
          "import signal,sys; sys.exit(0 if signal.getsignal(signal.SIGCHLD) == signal.SIG_IGN else 9)"
        } else {
          "import signal,sys; sys.exit(0 if signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL else 9)"
        }]);
        LispHost::apply_sigchld_snapshot(&mut yielded, ignored);
        assert!(yielded.status().unwrap().success());
        assert_ne!(LispHost::ignored_sigchld(), ignored);
      }

      // Exercise each non-worker shell spawn route, including Tokio and the
      // job-control foreground path (without claiming a real terminal).
      trap(&mut host, "trap '' CHLD").await;
      let argv = vec!["/usr/bin/python3".to_owned(), "-c".to_owned(),
        "import signal,sys; sys.exit(0 if signal.getsignal(signal.SIGCHLD) == signal.SIG_IGN else 9)".to_owned()];
      let programs = vec![(std::path::PathBuf::from(&argv[0]), argv.clone())];
      assert_eq!(crate::script::run_process_pipeline(programs.clone(), None, true, None, None).await.unwrap().status, 0);
      assert_eq!(crate::script::start_process_background(std::path::PathBuf::from(&argv[0]), argv, None, true, None).unwrap().completion.await.unwrap().status, 0);
      assert_eq!(crate::script::start_process_foreground(programs, None, vec![]).unwrap().completion.await.unwrap().status, 0);
      // Forked compound-command workers have two additional spawn doors:
      // a pipeline and an asynchronous command. Both inherit logical ignore.
      host.set_external_commands(std::rc::Rc::new(Programs));
      for source in [
        "(/usr/bin/python3 -c 'import signal; print(int(signal.getsignal(signal.SIGCHLD)))')",
        "(/usr/bin/python3 -c 'import signal; print(int(signal.getsignal(signal.SIGCHLD)))' & wait)",
      ] {
        let out = host.capture_shell_source(source).await.unwrap();
        assert_eq!(out.status, 0);
        assert_eq!(out.stdout, b"1\n");
      }
      let final_handler = disposition().sa_sigaction;
      drop(host);
      assert_waitable();
      assert_eq!(disposition().sa_sigaction, final_handler);
    });
  }
}
