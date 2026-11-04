//! The interactive shell's terminal: who is in front of it.
//!
//! bash's job control has two halves. The process-group half (a job leads its
//! own group, a reaper sees it stop) lives in [`super::control`]. This is the
//! other half: when the shell runs at a real terminal it owns, a foreground
//! job is given the terminal (`tcsetpgrp` to the job's group) for as long as
//! it runs, and the shell takes it back, with its own terminal modes, when the
//! job exits or stops. That is what lets Ctrl-Z reach `vim` and not the shell,
//! and what lets `fg` put a stopped `vim` back in front, full screen.
//!
//! The shell claims the terminal once, at its interactive prompt
//! ([`claim_interactive`]): it ignores the keyboard's stop signals (`SIGTSTP`,
//! `SIGTTIN`, `SIGTTOU`), as bash does, leads its own process group and puts
//! that group in front. Every foreground job then starts with those signals
//! back at their defaults (see `start_process_foreground`). Nothing here is
//! claimed by a script, `-c`, a session engine (which has no terminal) or a
//! forked child: [`owned`] answers for the claiming process only.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI32, Ordering};

/// The terminal's descriptor, the shell's group, and the claiming process.
static FD: AtomicI32 = AtomicI32::new(-1);
static SHELL_GROUP: AtomicI32 = AtomicI32::new(0);
static OWNER: AtomicI32 = AtomicI32::new(0);

/// The shell's own terminal modes, restored whenever it takes the terminal
/// back; and each stopped job's modes, restored when `fg` gives it back.
static SHELL_MODES: Mutex<Option<libc::termios>> = Mutex::new(None);
static JOB_MODES: Mutex<Option<HashMap<u32, libc::termios>>> = Mutex::new(None);

/// Claim the terminal for an interactive prompt: the shell ignores the
/// keyboard's stop signals, leads its own process group, and that group is
/// the terminal's foreground. Returns whether job control at the terminal is
/// on. Off when neither stdin nor stderr is a terminal, or when this shell is
/// not in front of it (started in the background).
pub fn claim_interactive() -> bool {
  let fd = [libc::STDIN_FILENO, libc::STDERR_FILENO]
    .into_iter()
    // SAFETY: isatty only inspects the descriptor.
    .find(|fd| unsafe { libc::isatty(*fd) } == 1);
  let Some(fd) = fd else {
    return false;
  };
  // SAFETY: plain process and terminal queries and signal dispositions; no
  // memory is shared with the kernel beyond the termios out-parameter.
  unsafe {
    let group = libc::getpgrp();
    if libc::tcgetpgrp(fd) != group {
      // In the background of whoever started us: leave the terminal alone.
      return false;
    }
    for signal in [libc::SIGTSTP, libc::SIGTTIN, libc::SIGTTOU] {
      libc::signal(signal, libc::SIG_IGN);
    }
    let pid = libc::getpid();
    if group != pid && libc::setpgid(0, 0) == 0 {
      libc::tcsetpgrp(fd, pid);
    }
    let mut modes: libc::termios = std::mem::zeroed();
    if libc::tcgetattr(fd, &mut modes) == 0 {
      *SHELL_MODES.lock().unwrap_or_else(|p| p.into_inner()) = Some(modes);
    }
    FD.store(fd, Ordering::SeqCst);
    SHELL_GROUP.store(libc::getpgrp(), Ordering::SeqCst);
    OWNER.store(pid, Ordering::SeqCst);
  }
  true
}

/// The terminal descriptor, when this process claimed one.
pub(in crate::script) fn descriptor() -> Option<i32> {
  // SAFETY: getpid has no side effects.
  let pid = unsafe { libc::getpid() };
  (OWNER.load(Ordering::SeqCst) == pid).then(|| FD.load(Ordering::SeqCst))
}

/// Whether this process is an interactive shell in front of its terminal.
/// A forked child inherits the statics but not the claim.
pub fn owned() -> bool {
  descriptor().is_some()
}

/// Put the job's process group in front of the terminal (bash's
/// `give_terminal_to`). With `SIGTTOU` ignored the shell may do this from
/// wherever it is.
pub(in crate::script) fn give_to(group: u32) {
  if let Some(fd) = descriptor() {
    // SAFETY: tcsetpgrp only changes the terminal's foreground group.
    unsafe { libc::tcsetpgrp(fd, group as libc::pid_t) };
  }
}

/// Take the terminal back after the job of `pid` exited or stopped: the
/// shell's group in front again and the shell's own modes restored. A job
/// that `stopped` keeps its modes for the `fg` that gives it the terminal
/// again.
pub(in crate::script) fn reclaim(pid: u32, stopped: bool) {
  let Some(fd) = descriptor() else {
    return;
  };
  // SAFETY: terminal queries and settings on a descriptor this process
  // claimed; the termios values are plain data.
  unsafe {
    if stopped {
      let mut modes: libc::termios = std::mem::zeroed();
      if libc::tcgetattr(fd, &mut modes) == 0 {
        JOB_MODES
          .lock()
          .unwrap_or_else(|p| p.into_inner())
          .get_or_insert_with(HashMap::new)
          .insert(pid, modes);
      }
    }
    libc::tcsetpgrp(fd, SHELL_GROUP.load(Ordering::SeqCst));
    if let Some(modes) = *SHELL_MODES.lock().unwrap_or_else(|p| p.into_inner()) {
      libc::tcsetattr(fd, libc::TCSADRAIN, &modes);
    }
  }
}

/// Before `fg` continues a stopped job in front: the terminal modes it had
/// when it stopped (a full-screen program's raw mode), as bash restores them.
pub(in crate::script) fn restore_job_modes(pid: u32) {
  let Some(fd) = descriptor() else {
    return;
  };
  let modes = JOB_MODES
    .lock()
    .unwrap_or_else(|p| p.into_inner())
    .as_mut()
    .and_then(|modes| modes.remove(&pid));
  if let Some(modes) = modes {
    // SAFETY: tcsetattr reads the plain termios value.
    unsafe { libc::tcsetattr(fd, libc::TCSADRAIN, &modes) };
  }
}

/// A finished job's saved modes are of no further use.
pub(in crate::script) fn forget_job(pid: u32) {
  if let Some(modes) = JOB_MODES.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
    modes.remove(&pid);
  }
}
