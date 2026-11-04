//! Process I/O mechanism shared by the shell's pipeline and capture doors.
use std::path::PathBuf;
use std::process::Stdio;
use std::rc::Rc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::ShellCapture;

/// A host may stream child stdout/stderr to a transcript instead of inheriting
/// this process's descriptors. The bool distinguishes stderr; an empty slice
/// marks EOF, so a text sink can flush an incomplete UTF-8 sequence.
pub type ProcessOutput = Rc<dyn Fn(&[u8], bool)>;

/// Inherited children bypass Rust's line-buffered stdout. Publish even a
/// partial builtin write before handing those descriptors to a child.
pub fn flush_shell_output() -> std::io::Result<()> {
  use std::io::Write;
  let stdout = std::io::stdout().flush();
  let stderr = std::io::stderr().flush();
  stdout.and(stderr)
}

pub(super) struct OutputBoundary;

impl OutputBoundary {
  pub(super) fn enter() -> Self {
    let _ = flush_shell_output();
    Self
  }
}

impl Drop for OutputBoundary {
  fn drop(&mut self) { let _ = flush_shell_output(); }
}

pub async fn run_process_pipeline(
  programs: Vec<(PathBuf, Vec<String>)>,
  input: Option<Vec<u8>>,
  capture: bool,
  environment: Option<Vec<(std::ffi::OsString, std::ffi::OsString)>>,
  output: Option<ProcessOutput>,
) -> crate::Result<ShellCapture> {
  run_process_pipeline_with_io(programs, input, capture, environment, output, Vec::new()).await
}

pub async fn run_process_pipeline_with_io(
  programs: Vec<(PathBuf, Vec<String>)>,
  input: Option<Vec<u8>>,
  capture: bool,
  environment: Option<Vec<(std::ffi::OsString, std::ffi::OsString)>>,
  output: Option<ProcessOutput>,
  io: Vec<Option<super::ShellIo>>,
) -> crate::Result<ShellCapture> {
  let _output_boundary = OutputBoundary::enter();
  if programs.is_empty() {
    return Err(crate::Error::Other(anyhow::anyhow!(
      "pipeline: expected a stage"
    )));
  }
  let count = programs.len();
  let mut children = Vec::with_capacity(count);
  let mut statuses = vec![0; count];
  let mut start_errors = Vec::new();
  let mut last_stdout: Option<Box<dyn tokio::io::AsyncRead + Unpin>> = None;
  let mut previous: Option<Stdio> = None;
  let mut stdin = None;
  let mut stderr = Vec::new();
  let mut text_inputs = Vec::new();
  for (index, (program, argv)) in programs.into_iter().enumerate() {
    if argv.is_empty() {
      statuses[index] = 1;
      drop(previous.take());
      let bytes = match io.get(index).and_then(Option::as_ref).map(|io| io.target(1)) {
        Some(super::FdTarget::Text(bytes)) => std::mem::take(&mut *bytes.lock().map_err(|_| crate::Error::Other(anyhow::anyhow!("stdin lock is poisoned")))?),
        _ => Vec::new(),
      };
      let (read, write) = text_pipe(bytes)?;
      text_inputs.push(write);
      if index + 1 < count { previous = Some(Stdio::from(read)); }
      else { last_stdout = Some(Box::new(tokio::fs::File::from_std(read))); }
      continue;
    }
    let mut command = tokio::process::Command::new(program);
    command.args(&argv[1..]).kill_on_drop(true);
    let launch = if index == 0 { take_exec_launch() } else { ExecLaunch::default() };
    if let Some(argv0) = &launch.argv0 {
      command.arg0(argv0);
    }
    if let Some(environment) = &environment {
      command.env_clear().envs(environment.iter().cloned());
    }
    if let Some(Some(io)) = io.get(index) {
      command.envs(io.1.iter().cloned());
    }
    if let Some(pipe) = previous.take() {
      command.stdin(pipe);
    } else if input.is_some() {
      command.stdin(Stdio::piped());
    }
    if index + 1 < count || capture || output.is_some() {
      command.stdout(Stdio::piped());
    }
    if output.is_some() || io.get(index).is_some_and(Option::is_some) {
      command.stderr(Stdio::piped());
    }
    if let Some(Some(io)) = io.get(index) {
      text_inputs.extend(configure_descriptors(&mut command, io)?);
    }
    if launch.clear_environment {
      command.env_clear();
    }
    let _ = flush_shell_output();
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
        // A failed stage contributes EOF. Later children still run, and the
        // pipeline's status still belongs to its last stage.
        previous = Some(Stdio::null());
        continue;
      }
    };
    if index == 0 && input.is_some() {
      stdin = child.stdin.take();
    }
    if index + 1 < count {
      // Transfer the read descriptor directly to the next child's stdin.
      // No parent reader or full-stream buffer exists between external stages.
      previous = Some(
        child
          .stdout
          .take()
          .map(|stdout| stdout.try_into())
          .transpose()
          .map_err(|error: std::io::Error| crate::Error::Other(error.into()))?
          .unwrap_or_else(Stdio::null),
      );
    }
    if index + 1 == count {
      last_stdout = child.stdout.take().map(|stdout| Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Unpin>);
    }
    if let Some(pipe) = child.stderr.take() {
      stderr.push(pipe);
    }
    children.push((index, child));
  }
  // A failed final stage must close the preceding reader before waits begin.
  drop(previous);
  let stdout = last_stdout;
  let write_input = async {
    let write_text = futures::future::try_join_all(text_inputs.into_iter().map(|(file, bytes)| async move {
      let mut file = tokio::fs::File::from_std(file);
      if let Err(error) = file.write_all(&bytes).await {
        if error.kind() != std::io::ErrorKind::BrokenPipe { return Err(crate::Error::Other(error.into())); }
      }
      Ok::<_, crate::Error>(())
    }));
    let write_stdin = async {
    if let (Some(mut stdin), Some(input)) = (stdin, input) {
      if let Err(error) = stdin.write_all(&input).await {
        if error.kind() != std::io::ErrorKind::BrokenPipe {
          return Err(crate::Error::Other(error.into()));
        }
      }
      // Closing the writer delivers EOF even for empty input.
    }
    Ok::<_, crate::Error>(())
    };
    tokio::try_join!(write_stdin, write_text).map(|_| ())
  };
  let read_stdout = async {
    let mut bytes = Vec::new();
    if let Some(mut stdout) = stdout {
      let mut chunk = [0; 8192];
      loop {
        let count = stdout
          .read(&mut chunk)
          .await
          .map_err(|error| crate::Error::Other(error.into()))?;
        if count == 0 {
          if !capture {
            if let Some(output) = &output {
              output(&[], false);
            }
          }
          break;
        }
        if capture {
          bytes.extend_from_slice(&chunk[..count]);
        } else if let Some(output) = &output {
          output(&chunk[..count], false);
        } else {
          let _ = super::shell_redirect::write_target(&super::FdTarget::Inherit(1), &chunk[..count]);
        }
      }
    }
    Ok::<_, crate::Error>(bytes)
  };
  let read_stderr = async {
    futures::future::try_join_all(stderr.into_iter().map(|mut stderr| {
      let output = output.clone();
      async move {
        let mut chunk = [0; 8192];
        loop {
          let count = stderr
            .read(&mut chunk)
            .await
            .map_err(|error| crate::Error::Other(error.into()))?;
          if count == 0 {
            if let Some(output) = &output {
              output(&[], true);
            }
            break;
          }
          if let Some(output) = &output {
            output(&chunk[..count], true);
          } else {
            let _ = super::shell_redirect::write_target(&super::FdTarget::Inherit(2), &chunk[..count]);
          }
        }
        Ok::<_, crate::Error>(())
      }
    }))
    .await
  };
  let wait = async {
    futures::future::try_join_all(children.into_iter().map(|(index, mut child)| async move {
      child
        .wait()
        .await
        .map(|status| (index, status))
        .map_err(|error| crate::Error::Other(error.into()))
    }))
    .await
  };
  let (_, stdout, _, completed) = tokio::try_join!(write_input, read_stdout, read_stderr, wait)?;
  for (index, status) in completed {
    #[cfg(unix)]
    let code = {
      use std::os::unix::process::ExitStatusExt;
      status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
    };
    #[cfg(not(unix))]
    let code = status.code().unwrap_or(1);
    statuses[index] = code;
  }
  Ok(ShellCapture {
    stdout,
    status: statuses[count - 1],
    statuses: statuses.clone(),
    start_errors,
  })
}

#[cfg(unix)]
fn configure_descriptors(command: &mut tokio::process::Command, io: &super::ShellIo)
  -> crate::Result<Vec<(std::fs::File, Vec<u8>)>> {
  configure_std_descriptors(command.as_std_mut(), io)
}

#[cfg(unix)]
pub(super) fn configure_std_descriptors(command: &mut std::process::Command, io: &super::ShellIo)
  -> crate::Result<Vec<(std::fs::File, Vec<u8>)>> {
  use std::os::fd::AsRawFd;
  use std::os::unix::process::CommandExt;
  use std::sync::Arc;
  use super::FdTarget;
  let mut sources = Vec::new();
  let mut keep = Vec::new();
  let mut writers = Vec::new();
  let mut text_sources = std::collections::HashMap::new();
  for (&fd, target) in &io.0 {
    let source = match target {
      FdTarget::Inherit(source) => Some(*source),
      FdTarget::File(file) => { keep.push(file.clone()); Some(file.as_raw_fd()) }
      FdTarget::Text(bytes) => {
        let key = Arc::as_ptr(bytes) as usize;
        if let Some(source) = text_sources.get(&key) {
          sources.push((fd, Some(*source)));
          continue;
        }
        let bytes = std::mem::take(&mut *bytes.lock().map_err(|_| crate::Error::Other(anyhow::anyhow!("stdin lock is poisoned")))?);
        let (read, write) = text_pipe(bytes)?;
        let read = Arc::new(read);
        let fd = read.as_raw_fd();
        text_sources.insert(key, fd);
        keep.push(read);
        writers.push(write);
        Some(fd)
      }
      FdTarget::Closed => None,
    };
    sources.push((fd, source));
  }
  let minimum = sources.iter().map(|(fd, _)| *fd).max().unwrap_or(2).checked_add(1)
    .ok_or_else(|| crate::Error::Other(anyhow::anyhow!("file descriptor out of range")))?.max(10);
  // Snapshot all sources before changing any destination: a dup always sees
  // the descriptor's left-to-right value, never the result of a later dup2.
  let mut copies = Vec::with_capacity(sources.len());
  unsafe { command.pre_exec(move || {
    let _keep = &keep;
    copies.clear();
    for &(fd, source) in &sources {
      let copy = if let Some(source) = source {
        let copy = libc::fcntl(source, libc::F_DUPFD_CLOEXEC, minimum);
        if copy < 0 { return Err(std::io::Error::last_os_error()); }
        Some(copy)
      } else { None };
      copies.push((fd, copy));
    }
    for &(fd, copy) in &copies {
      if let Some(copy) = copy {
        if libc::dup2(copy, fd) < 0 { return Err(std::io::Error::last_os_error()); }
      } else { libc::close(fd); }
    }
    for &(_, copy) in &copies { if let Some(copy) = copy { libc::close(copy); } }
    Ok(())
  }); }
  Ok(writers)
}

#[cfg(unix)]
fn text_pipe(bytes: Vec<u8>) -> crate::Result<(std::fs::File, (std::fs::File, Vec<u8>))> {
  use std::os::fd::FromRawFd;
  let mut pipe = [-1; 2];
  if unsafe { libc::pipe(pipe.as_mut_ptr()) } != 0 {
    return Err(crate::Error::Other(std::io::Error::last_os_error().into()));
  }
  let read = unsafe { std::fs::File::from_raw_fd(pipe[0]) };
  let write = unsafe { std::fs::File::from_raw_fd(pipe[1]) };
  unsafe {
    libc::fcntl(pipe[0], libc::F_SETFD, libc::FD_CLOEXEC);
    libc::fcntl(pipe[1], libc::F_SETFD, libc::FD_CLOEXEC);
  }
  Ok((read, (write, bytes)))
}

#[cfg(not(unix))]
fn text_pipe(_bytes: Vec<u8>) -> crate::Result<(std::fs::File, (std::fs::File, Vec<u8>))> {
  Err(crate::Error::Other(anyhow::anyhow!("descriptor redirection requires a Unix host")))
}

#[cfg(not(unix))]
fn configure_descriptors(_command: &mut tokio::process::Command, _io: &super::ShellIo)
  -> crate::Result<Vec<(std::fs::File, Vec<u8>)>> {
  Err(crate::Error::Other(anyhow::anyhow!("descriptor redirection requires a Unix host")))
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;

  fn commands(stages: &[&[&str]]) -> Vec<(PathBuf, Vec<String>)> {
    stages
      .iter()
      .map(|stage| {
        (
          PathBuf::from(stage[0]),
          stage.iter().map(|s| s.to_string()).collect(),
        )
      })
      .collect()
  }

  async fn pipe(stages: &[&[&str]], input: Option<Vec<u8>>) -> ShellCapture {
    tokio::time::timeout(
      std::time::Duration::from_secs(5),
      run_process_pipeline(commands(stages), input, true, None, None),
    )
    .await
    .expect("pipeline must terminate")
    .unwrap()
  }

  #[tokio::test]
  async fn external_pipeline_is_concurrent_and_ignores_upstream_sigpipe() {
    let out = pipe(&[&["/usr/bin/yes"], &["/usr/bin/head", "-1"]], None).await;
    assert_eq!(out.stdout, b"y\n");
    assert_eq!(out.status, 0);
  }

  #[tokio::test]
  async fn external_pipeline_streams_a_mebibyte_and_uses_last_status() {
    let out = pipe(
      &[
        &["/usr/bin/head", "-c", "1048576", "/dev/zero"],
        &["/usr/bin/wc", "-c"],
      ],
      None,
    )
    .await;
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "1048576");
    assert_eq!(out.status, 0);
    for (left, right, status) in [
      ("false", "true", 0),
      ("true", "false", 1),
      ("false", "false", 1),
    ] {
      let left = format!("/usr/bin/{left}");
      let right = format!("/usr/bin/{right}");
      assert_eq!(pipe(&[&[&left], &[&right]], None).await.status, status);
    }
  }

  #[tokio::test]
  async fn external_pipeline_typed_input_and_epipe_are_quiet() {
    let out = pipe(&[&["/usr/bin/sort"]], Some(b"b\na\n".to_vec())).await;
    assert_eq!(out.stdout, b"a\nb\n");
    let out = pipe(&[&["/usr/bin/head", "-c", "1"]], Some(vec![b'x'; 1048576])).await;
    assert_eq!(out.stdout, b"x");
    assert_eq!(out.status, 0);
  }

  #[tokio::test]
  async fn external_pipeline_launch_failures_keep_the_last_stage_status() {
    let missing = "/no-such-phase4h-pipeline-program";
    let out = pipe(&[&[missing], &["/usr/bin/true"]], None).await;
    assert_eq!(out.status, 0);
    assert_eq!(out.start_errors.len(), 1);
    assert_eq!(out.start_errors[0].0, 127);
    let out = pipe(&[&["/usr/bin/yes"], &[missing]], None).await;
    assert_eq!(out.status, 127);
  }

  #[tokio::test]
  async fn external_pipeline_drains_stderr_and_streams_output_to_host() {
    let writes = Rc::new(std::cell::RefCell::new(Vec::new()));
    let record = writes.clone();
    let out = run_process_pipeline(
      commands(&[&["/bin/sh", "-c", "printf out; printf err >&2; exit 7"]]),
      None,
      false,
      None,
      Some(Rc::new(move |bytes, stderr| {
        record.borrow_mut().push((bytes.to_vec(), stderr))
      })),
    )
    .await
    .unwrap();
    assert_eq!(out.status, 7);
    assert!(out.stdout.is_empty());
    let records = writes.borrow();
    assert!(records.iter().any(|(bytes, err)| bytes == b"out" && !err));
    assert!(records.iter().any(|(bytes, err)| bytes == b"err" && *err));
  }
}

/// Starts one external background command immediately: an asynchronous
/// command without job control, so its inherited stdin is /dev/null and it
/// ignores SIGINT and SIGQUIT. A reaper thread drains captured output and
/// waits for it, so the job settles whether or not anything polls it; wait
/// consumes its status and captured bytes.
pub fn start_process_background(
  program: PathBuf, argv: Vec<String>, io: Option<super::ShellIo>, capture: bool,
  environment: Option<Vec<(std::ffi::OsString, std::ffi::OsString)>>,
) -> crate::Result<super::ShellJob> {
  let _output_boundary = OutputBoundary::enter();
  let mut command = std::process::Command::new(program);
  command.args(argv.iter().skip(1)).stdin(Stdio::null());
  if capture { command.stdout(Stdio::piped()); }
  if let Some(env) = environment { command.env_clear().envs(env); }
  let writers = if let Some(mut io) = io {
    // Inherited stdin of an asynchronous command is /dev/null. Explicit
    // descriptor redirects retain their ordered values.
    if matches!(io.target(0), super::FdTarget::Inherit(0)) { io.0.remove(&0); }
    command.envs(io.1.iter().cloned());
    configure_std_descriptors(&mut command, &io)?
  } else { Vec::new() };
  #[cfg(unix)]
  if super::shell_jobs::control::new_group_requested() {
    // Job control: the job is a process group of its own and keeps the
    // keyboard's signals, so Ctrl-C reaches it while it is in the foreground.
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    // However the shell itself was started (under `nohup`, from a script that
    // ignores them), a job of a prompt starts as a terminal's child does.
    // SAFETY: signal(2) is async-signal-safe and touches no shared state.
    unsafe {
      command.pre_exec(|| {
        for signal in [libc::SIGINT, libc::SIGQUIT, libc::SIGTSTP, libc::SIGTTIN, libc::SIGTTOU] {
          libc::signal(signal, libc::SIG_DFL);
        }
        Ok(())
      });
    }
  } else {
    ignore_keyboard_signals(&mut command);
  }
  #[cfg(not(unix))]
  ignore_keyboard_signals(&mut command);
  let mut child = command.spawn().map_err(|error| crate::Error::ProcessStart {
    status: if error.kind() == std::io::ErrorKind::NotFound { 127 } else { 126 },
    detail: error.to_string(),
  })?;
  let pid = child.id();
  let stdout = child.stdout.take();
  let (send, receive) = tokio::sync::oneshot::channel();
  let writers: Vec<_> = writers.into_iter().map(|(mut file, bytes)| {
    let (sent, written) = std::sync::mpsc::channel();
    super::shell_jobs::spawn_reaper(move || {
      use std::io::Write;
      let _ = sent.send(match file.write_all(&bytes) {
        Err(error) if error.kind() != std::io::ErrorKind::BrokenPipe => Err(error),
        _ => Ok(()),
      });
    });
    written
  }).collect();
  // The capture drains on a thread of its own: the wait below must see a
  // stop of the job, not only its exit, and a captured job's pipe stays open
  // while it is stopped.
  let drained = stdout.map(|mut stdout| {
    let (sent, drained) = std::sync::mpsc::channel();
    super::shell_jobs::spawn_reaper(move || {
      use std::io::Read;
      let mut bytes = Vec::new();
      let _ = sent.send(stdout.read_to_end(&mut bytes).map(|_| bytes));
    });
    drained
  });
  super::shell_jobs::spawn_reaper(move || {
    let result = (|| -> crate::Result<ShellCapture> {
      // Unix waits through the job reaper, which notes stops and continues.
      #[cfg(unix)]
      let status = {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(
          super::shell_jobs::control::wait_child(pid).map_err(|e| crate::Error::Other(e.into()))?,
        )
      };
      #[cfg(not(unix))]
      let status = child.wait().map_err(|e| crate::Error::Other(e.into()))?;
      let bytes = match drained {
        Some(drained) => drained
          .recv()
          .map_err(|e| crate::Error::Other(e.into()))?
          .map_err(|e| crate::Error::Other(e.into()))?,
        None => Vec::new(),
      };
      for writer in writers {
        if let Ok(Err(error)) = writer.recv() { return Err(crate::Error::Other(error.into())); }
      }
      #[cfg(unix)]
      let status = {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() { super::shell_jobs::note_termination(pid, signal); }
        status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
      };
      #[cfg(not(unix))]
      let status = status.code().unwrap_or(1);
      Ok(ShellCapture { stdout: bytes, status, statuses: vec![status], start_errors: Vec::new() })
    })();
    let _ = send.send(result);
  });
  Ok(super::ShellJob { pid, completion: Box::pin(async move {
    receive.await.map_err(|e| crate::Error::Other(e.into()))?
  }) })
}

/// Without job control an asynchronous command ignores the keyboard's SIGINT
/// and SIGQUIT; the disposition survives exec.
#[cfg(unix)]
fn ignore_keyboard_signals(command: &mut std::process::Command) {
  use std::os::unix::process::CommandExt;
  // SAFETY: signal(2) is async-signal-safe and touches no shared state.
  unsafe {
    command.pre_exec(|| {
      libc::signal(libc::SIGINT, libc::SIG_IGN);
      libc::signal(libc::SIGQUIT, libc::SIG_IGN);
      Ok(())
    });
  }
}

#[cfg(not(unix))]
fn ignore_keyboard_signals(_command: &mut std::process::Command) {}

/// How `exec -a NAME`, `-l` and `-c` launch the next program: its argv[0]
/// and an empty environment. Set by the `exec` builtin right before it runs
/// its one-stage pipeline and taken by the first stage spawned on this
/// thread, so no host interface changes.
#[derive(Clone, Debug, Default)]
pub(super) struct ExecLaunch {
  pub argv0: Option<String>,
  pub clear_environment: bool,
}

thread_local! {
  static EXEC_LAUNCH: std::cell::RefCell<ExecLaunch> = std::cell::RefCell::new(ExecLaunch::default());
}

pub(super) fn set_exec_launch(launch: ExecLaunch) {
  EXEC_LAUNCH.with(|slot| *slot.borrow_mut() = launch);
}

pub(super) fn take_exec_launch() -> ExecLaunch {
  EXEC_LAUNCH.with(|slot| std::mem::take(&mut *slot.borrow_mut()))
}
