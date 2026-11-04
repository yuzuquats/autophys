//! The foreground-runner hook: how a `streaming` app command reaches a real
//! terminal when the process dispatching it has none.
//!
//! A `streaming` command ([`crate::tsh_app::TshApp::call_streaming_args`])
//! wants the user's terminal: its output streams live and it may prompt
//! (`tento-claude login` runs `ssh -t` and waits on a sign-in prompt). From a
//! plain CLI that terminal is already ours, so the child inherits our stdio and
//! we wait. A host that owns no terminal — tsh's session engine is setsid, with
//! stdin on /dev/null and stdout/stderr on its log — installs a
//! [`ForegroundRunner`] instead, and the command is handed to it: tento-app
//! owns what a transport means, the host owns terminals.
//!
//! The runner is per thread (an engine evaluates on one actor thread, and the
//! runner it installs carries that thread's `!Send` unit state). A thread with
//! no runner keeps the inherit-and-wait behaviour.

use std::cell::RefCell;
use std::ffi::OsString;
use std::path::PathBuf;
use std::rc::Rc;

/// One `streaming` command, fully prepared: everything the child would have
/// been spawned with, so a runner reproduces the spawn exactly.
#[derive(Debug, Clone)]
pub struct ForegroundCommand {
  /// `"<app> <command>"`, for messages.
  pub label: String,
  /// The bundle executable.
  pub program: PathBuf,
  /// `[<app name>, <command>, <extra…>]`: argv[0] names the app, the rest are
  /// the child's arguments.
  pub argv: Vec<String>,
  /// The directory the child starts in.
  pub cwd: PathBuf,
  /// The child's COMPLETE environment (the runner clears its own first): the
  /// hermetic session snapshot, the import's bindings, the profile binding and
  /// the colour decision, in that order.
  pub env: Vec<(OsString, OsString)>,
  /// Capture stdout as JSON while stdin/stderr use the hosted terminal.
  pub capture_json: bool,
}

/// What a runner did with a [`ForegroundCommand`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForegroundRun {
  /// The command ran to completion on the host's terminal.
  Exited {
    success: bool,
    /// The exit code; `None` when a signal (or a cancel) ended it.
    code: Option<i32>,
    /// Captured JSON stdout when capture_json was requested; otherwise
    /// the last lines it printed, which a failure's error quotes; empty when
    /// the host kept none (the output went to a terminal it does not own).
    output: String,
  },
  /// The host suspended the caller until the terminal is handed back (tsh
  /// parks the unit and re-runs it; the re-run's call returns `Exited`).
  /// Whatever the caller returns now is discarded.
  Parked,
}

/// Why a runner could not run the command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForegroundError {
  /// No terminal can take the command (no viewer attached): the caller fails
  /// at once instead of hanging on a terminal nobody sees.
  NoTerminal(String),
  /// The handoff itself failed (the child could not start, the host's
  /// bookkeeping failed).
  Failed(String),
}

/// Runs a prepared command in the foreground on a real terminal.
pub trait ForegroundRunner {
  fn run(&self, command: ForegroundCommand) -> Result<ForegroundRun, ForegroundError>;
}

thread_local! {
  static RUNNER: RefCell<Option<Rc<dyn ForegroundRunner>>> = const { RefCell::new(None) };
}

/// Install `runner` for this thread, returning the one it replaces.
pub fn install_foreground_runner(
  runner: Rc<dyn ForegroundRunner>,
) -> Option<Rc<dyn ForegroundRunner>> {
  RUNNER.with(|slot| slot.borrow_mut().replace(runner))
}

/// Remove this thread's runner (back to inherit-and-wait), returning it.
pub fn take_foreground_runner() -> Option<Rc<dyn ForegroundRunner>> {
  RUNNER.with(|slot| slot.borrow_mut().take())
}

/// This thread's runner, if a host installed one.
pub fn foreground_runner() -> Option<Rc<dyn ForegroundRunner>> {
  RUNNER.with(|slot| slot.borrow().clone())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::tsh_app::{AppError, TshApp};
  use std::cell::RefCell;
  use std::path::Path;
  use tento_lisp::Value as LispValue;

  /// A `streaming` bundle whose `login` prints a banner, reads a line and
  /// records that it ran (and what it read) in `ran`. The line comes from
  /// `--input=FILE` (default /dev/null), never the test's own stdin, which
  /// may be a terminal nobody types into.
  fn streaming_bundle(root: &Path, transports: &str) -> TshApp {
    let bundle = root.join("fake.tsh.app");
    std::fs::create_dir_all(bundle.join("bin")).unwrap();
    std::fs::write(
      bundle.join("manifest.json"),
      format!(
        r#"{{"schema":"tsh.app/v1","name":"fake","version":"1","entrypoint":"bin/fake",
          "transport":"oneshot","transports":{transports},"commands":{{"login":{{}}}}}}"#
      ),
    )
    .unwrap();
    let script = bundle.join("bin/fake");
    std::fs::write(
      &script,
      format!(
        "#!/bin/sh\necho 'fake login: banner'\ninput=/dev/null\nfor a; do case $a in --input=*) input=${{a#--input=}};; esac; done\nread line < \"$input\"\necho \"ran $* [$line]\" > '{}'\n",
        root.join("ran").display()
      ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    TshApp::load(&bundle).unwrap()
  }

  /// Records what it was handed and answers with `reply`.
  struct Recorder {
    seen: RefCell<Vec<ForegroundCommand>>,
    reply: Result<ForegroundRun, ForegroundError>,
  }

  impl ForegroundRunner for Recorder {
    fn run(&self, command: ForegroundCommand) -> Result<ForegroundRun, ForegroundError> {
      self.seen.borrow_mut().push(command);
      self.reply.clone()
    }
  }

  fn install(reply: Result<ForegroundRun, ForegroundError>) -> Rc<Recorder> {
    let recorder = Rc::new(Recorder {
      seen: RefCell::new(Vec::new()),
      reply,
    });
    install_foreground_runner(recorder.clone());
    recorder
  }

  #[test]
  fn interactive_terminal_returns_json_without_spawning_and_rejects_bad_results() {
    let root = tempfile::tempdir().unwrap();
    let app = streaming_bundle(root.path(), r#"{"login":"interactive"}"#);
    for (output, valid) in [
      (r#"{"success":false,"hosts":["one"]}"#, true),
      ("", false),
      ("banner\n{}", false),
    ] {
      let recorder = install(Ok(ForegroundRun::Exited {
        success: true,
        code: Some(0),
        output: output.into(),
      }));
      let result = futures::executor::block_on(app.dispatch_argv("login".into(), vec![], None));
      take_foreground_runner();
      assert_eq!(result.is_ok(), valid, "{result:?}");
      if valid {
        assert_eq!(result.unwrap()["success"], false);
      }
      assert!(recorder.seen.borrow()[0].capture_json);
      assert_eq!(recorder.seen.borrow()[0].argv, ["fake", "login", "--json"]);
      assert!(!root.path().join("ran").exists());
    }
    install(Ok(ForegroundRun::Parked));
    assert_eq!(
      app.call_interactive_args("login", &[]).unwrap(),
      serde_json::Value::Null
    );
    take_foreground_runner();
    install(Err(ForegroundError::Failed("cancelled".into())));
    assert!(
      app
        .call_interactive_args("login", &[])
        .unwrap_err()
        .to_string()
        .contains("cancelled")
    );
    take_foreground_runner();
  }

  /// Outside a session (no runner on this thread) a streaming command keeps
  /// today's behaviour: the child inherits our stdio and we wait for it.
  #[test]
  fn without_a_runner_the_child_inherits_and_is_waited_on() {
    assert!(foreground_runner().is_none());
    let root = tempfile::tempdir().unwrap();
    let app = streaming_bundle(root.path(), r#"{"login":"streaming"}"#);
    let value = app
      .call_streaming_args("login", &["@acme".to_string()])
      .expect("the child ran and exited 0");
    assert_eq!(value, serde_json::Value::Null);
    let ran = std::fs::read_to_string(root.path().join("ran")).unwrap();
    assert!(ran.starts_with("ran login @acme"), "{ran}");
  }

  /// With a runner installed the child is NOT spawned here: the runner gets
  /// the prepared command — argv, cwd and the complete environment, bindings
  /// and the colour decision included — and its answer is the call's.
  #[test]
  fn a_runner_receives_the_prepared_command_instead_of_a_spawn() {
    let root = tempfile::tempdir().unwrap();
    let app = streaming_bundle(root.path(), r#"{"login":"streaming"}"#);
    app
      .child_env
      .set(
        LispValue::Map(
          [(
            "FAKE_URL".into(),
            LispValue::String("https://example.test".into()),
          )]
          .into_iter()
          .collect(),
        ),
        crate::app_env::Authority::Script,
      )
      .unwrap();
    let recorder = install(Ok(ForegroundRun::Parked));
    let value = app
      .call_streaming_args(
        "login",
        &["@acme".into(), "--hosts".into(), "yuzuquats".into()],
      )
      .expect("a parked handoff returns a placeholder");
    take_foreground_runner();
    assert_eq!(value, serde_json::Value::Null);
    assert!(
      !root.path().join("ran").exists(),
      "nothing was spawned here"
    );

    let seen = recorder.seen.borrow();
    let [command] = seen.as_slice() else {
      panic!("one handoff, got {seen:?}");
    };
    assert_eq!(command.label, "fake login");
    assert_eq!(command.program, app.bin);
    assert_eq!(
      command.argv,
      ["fake", "login", "@acme", "--hosts", "yuzuquats"]
    );
    assert_eq!(command.cwd, std::env::current_dir().unwrap());
    let env: std::collections::HashMap<_, _> = command.env.iter().cloned().collect();
    assert_eq!(
      env
        .get(std::ffi::OsStr::new("FAKE_URL"))
        .map(|v| v.to_str().unwrap()),
      Some("https://example.test")
    );
    if tento_env::effective_var("NO_COLOR").is_none() {
      assert_eq!(
        env
          .get(std::ffi::OsStr::new("CLICOLOR_FORCE"))
          .map(|v| v.to_str().unwrap()),
        Some("1"),
        "the runner's terminal is a real one"
      );
    }
    assert!(
      env.contains_key(std::ffi::OsStr::new("PATH")),
      "with no map installed, the environment the child would have inherited"
    );
  }

  /// The runner's verdicts map onto the transport's errors: an exit status is
  /// `StreamFailed`, and "no terminal" is the loud, 126-status refusal that
  /// names the command.
  #[test]
  fn runner_verdicts_become_the_calls_result() {
    let root = tempfile::tempdir().unwrap();
    let app = streaming_bundle(root.path(), r#"{"login":"streaming"}"#);

    install(Ok(ForegroundRun::Exited {
      success: true,
      code: Some(0),
      output: String::new(),
    }));
    assert_eq!(
      app.call_streaming_args("login", &[]).unwrap(),
      serde_json::Value::Null
    );

    install(Ok(ForegroundRun::Exited {
      success: false,
      code: Some(5),
      output: "fake: no API key".into(),
    }));
    match app.call_streaming_args("login", &[]) {
      Err(error @ AppError::StreamFailed(_, 5, _)) => {
        assert_eq!(
          error.to_string(),
          "`fake login` exited with code 5",
          "the transcript already showed the output; the text does not repeat it"
        );
        let AppError::StreamFailed(_, _, output) = error else {
          unreachable!()
        };
        assert_eq!(output, "fake: no API key", "what it printed last is kept");
      }
      other => panic!("expected exit 5, got {other:?}"),
    }

    install(Ok(ForegroundRun::Exited {
      success: false,
      code: Some(5),
      output: String::new(),
    }));
    assert_eq!(
      app
        .call_streaming_args("login", &[])
        .unwrap_err()
        .to_string(),
      "`fake login` exited with code 5",
      "no output kept, no dangling colon"
    );

    install(Err(ForegroundError::NoTerminal(
      "no viewer is attached".into(),
    )));
    let error = app.call_streaming_args("login", &[]).unwrap_err();
    take_foreground_runner();
    assert_eq!(error.status(), Some(126));
    let message = error.to_string();
    assert!(message.contains("`fake login`"), "{message}");
    assert!(message.contains("needs an attached terminal"), "{message}");
    assert!(message.contains("no viewer is attached"), "{message}");
    assert!(
      !root.path().join("ran").exists(),
      "nothing was spawned here"
    );
  }

  /// A transport name this binary does not implement is refused when the
  /// manifest loads — bundle-level or per command — naming it, instead of
  /// running the command silently as a captured oneshot.
  #[test]
  fn an_unknown_transport_is_refused_naming_it() {
    let manifest = |transport: &str, transports: &str| {
      format!(
        r#"{{"schema":"tsh.app/v1","name":"fake","version":"1","entrypoint":"bin/fake",
          "transport":"{transport}","transports":{transports},"commands":{{"login":{{}}}}}}"#
      )
    };
    let error = TshApp::parse_manifest(&manifest("pooled", "{}"), "fake").unwrap_err();
    let message = error.to_string();
    assert!(message.contains("unknown transport `pooled`"), "{message}");

    let error =
      TshApp::parse_manifest(&manifest("oneshot", r#"{"login":"streming"}"#), "fake").unwrap_err();
    let message = error.to_string();
    assert!(message.contains("`transports` entry `login`"), "{message}");
    assert!(
      message.contains("unknown transport `streming`"),
      "{message}"
    );

    for known in ["oneshot", "streaming", "interactive", "daemon"] {
      TshApp::parse_manifest(&manifest(known, r#"{"login":"streaming"}"#), "fake")
        .unwrap_or_else(|e| panic!("{known}: {e}"));
    }
  }

  /// A manifest built in memory skips the load check; dispatch refuses it too.
  #[test]
  fn dispatch_refuses_an_unknown_transport() {
    let root = tempfile::tempdir().unwrap();
    let mut app = streaming_bundle(root.path(), "{}");
    Rc::make_mut(&mut app.manifest).transport = "pooled".into();
    let error =
      futures::executor::block_on(app.dispatch_argv("login".into(), Vec::new(), None)).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("unknown transport `pooled`"), "{message}");
    assert!(
      !root.path().join("ran").exists(),
      "nothing ran as a oneshot"
    );
  }
}
