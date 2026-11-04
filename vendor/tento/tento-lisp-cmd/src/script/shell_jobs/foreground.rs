//! Starting a foreground job at a terminal the shell owns.
//!
//! bash runs every foreground pipeline as a job of its own: its processes
//! share one process group (the first stage's pid), the terminal is handed to
//! that group before any of them can read it, and the keyboard's signals are
//! back at their defaults in each child (the interactive shell ignores the
//! stop signals itself). Ctrl-Z then stops the job and nothing else, and the
//! reapers ([`super::control::wait_child`]) see the stop. The shell decides
//! what a stop means (see `LispHost::run_foreground_job`); this module only
//! starts the processes.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;

use super::super::{ShellCapture, ShellIo, ShellJob};

/// One started stage: its pid and where its status will arrive.
#[cfg(unix)]
type StageReap = (usize, std::sync::mpsc::Receiver<std::io::Result<libc::c_int>>);

/// Start `programs` as one foreground job at the shell's terminal: one
/// process group led by the first stage that starts, the terminal given to
/// that group, stdin, stdout and stderr inherited unless `io` redirects them,
/// consecutive stages joined by OS pipes. A stage that cannot start
/// contributes EOF and its 126/127 status, as in any pipeline.
///
/// The job's pid is its group leader; it is 0 when no stage started (the
/// completion then holds only the start errors). The completion resolves when
/// every stage has exited: the last stage's status, every stage's status.
#[cfg(unix)]
pub fn start_process_foreground(
  programs: Vec<(PathBuf, Vec<String>)>,
  environment: Option<Vec<(OsString, OsString)>>,
  io: Vec<Option<ShellIo>>,
) -> crate::Result<ShellJob> {
  use std::os::unix::process::CommandExt;
  let _output_boundary = super::super::process_pipeline::OutputBoundary::enter();
  let tty = super::terminal::descriptor().unwrap_or(-1);
  let count = programs.len();
  let mut statuses = vec![0; count];
  let mut start_errors = Vec::new();
  let mut leader: Option<u32> = None;
  let mut previous: Option<Stdio> = None;
  let mut reaps: Vec<StageReap> = Vec::new();
  let mut writers = Vec::new();
  for (index, (program, argv)) in programs.into_iter().enumerate() {
    let mut command = std::process::Command::new(&program);
    command.args(argv.iter().skip(1));
    if let Some(environment) = &environment {
      command.env_clear().envs(environment.iter().cloned());
    }
    if let Some(pipe) = previous.take() {
      command.stdin(pipe);
    }
    if index + 1 < count {
      command.stdout(Stdio::piped());
    }
    if let Some(Some(stage_io)) = io.get(index) {
      command.envs(stage_io.1.iter().cloned());
      writers.extend(super::super::process_pipeline::configure_std_descriptors(
        &mut command,
        stage_io,
      )?);
    }
    command.process_group(leader.map_or(0, |pid| pid as i32));
    // SAFETY: between fork and exec only async-signal-safe calls: tcsetpgrp,
    // getpgrp and signal(2). The terminal is taken while SIGTTOU is still
    // ignored (inherited from the shell), then the keyboard's signals return
    // to their defaults, so the job can be stopped, interrupted and quit.
    unsafe {
      command.pre_exec(move || {
        if tty >= 0 {
          libc::tcsetpgrp(tty, libc::getpgrp());
        }
        for signal in [
          libc::SIGINT,
          libc::SIGQUIT,
          libc::SIGTSTP,
          libc::SIGTTIN,
          libc::SIGTTOU,
        ] {
          libc::signal(signal, libc::SIG_DFL);
        }
        Ok(())
      });
    }
    let mut child = match command.spawn() {
      Ok(child) => child,
      Err(error) => {
        let status = if error.kind() == std::io::ErrorKind::NotFound {
          127
        } else {
          126
        };
        statuses[index] = status;
        start_errors.push((status, format!("{}: {error}", argv[0])));
        if index + 1 < count {
          previous = Some(Stdio::null());
        }
        continue;
      }
    };
    let pid = child.id();
    let group = *leader.get_or_insert(pid);
    // The parent hands the terminal over too, so whichever runs first, the
    // job is in front before it reads (bash does both).
    super::terminal::give_to(group);
    if index + 1 < count {
      previous = child.stdout.take().map(Stdio::from).or(Some(Stdio::null()));
    }
    let (sent, received) = std::sync::mpsc::channel();
    super::spawn_reaper(move || {
      let _ = sent.send(super::control::wait_child(pid));
    });
    reaps.push((index, received));
    // The handle is not waited on: the reaper owns the child's status.
    drop(child);
  }
  drop(previous);
  let writers: Vec<_> = writers
    .into_iter()
    .map(|(mut file, bytes)| {
      let (sent, written) = std::sync::mpsc::channel();
      super::spawn_reaper(move || {
        use std::io::Write;
        let _ = sent.send(match file.write_all(&bytes) {
          Err(error) if error.kind() != std::io::ErrorKind::BrokenPipe => Err(error),
          _ => Ok(()),
        });
      });
      written
    })
    .collect();
  let (send, receive) = tokio::sync::oneshot::channel();
  let leader_pid = leader.unwrap_or(0);
  super::spawn_reaper(move || {
    let result = (|| -> crate::Result<ShellCapture> {
      for (index, received) in reaps {
        let raw = received
          .recv()
          .map_err(|error| crate::Error::Other(error.into()))?
          .map_err(|error| crate::Error::Other(error.into()))?;
        statuses[index] = if libc::WIFEXITED(raw) {
          libc::WEXITSTATUS(raw)
        } else {
          let signal = libc::WTERMSIG(raw);
          // The job's status is its last stage's: a signal that ended that
          // stage is the job's (`Terminated: 15`), told by its leader's pid.
          if index + 1 == count {
            super::note_termination(leader_pid, signal);
          }
          128 + signal
        };
      }
      for written in writers {
        if let Ok(Err(error)) = written.recv() {
          return Err(crate::Error::Other(error.into()));
        }
      }
      Ok(ShellCapture {
        stdout: Vec::new(),
        status: statuses[count.saturating_sub(1)],
        statuses,
        start_errors,
      })
    })();
    let _ = send.send(result);
  });
  Ok(ShellJob {
    pid: leader_pid,
    completion: Box::pin(async move {
      receive
        .await
        .map_err(|error| crate::Error::Other(error.into()))?
    }),
  })
}
