use super::super::interp::{AsyncCommandFut, ExternalCommands, ExternalLookup};
use super::super::{PipelineFuture, ShellIo};
use super::*;
use std::io::Write;

struct OrderPrograms;

impl ExternalCommands for OrderPrograms {
  fn lookup(&self, name: &str) -> ExternalLookup {
    if name == "printf" || name.starts_with("/usr/bin/") || matches!(name, "/bin/sh" | "/bin/cat") {
      ExternalLookup::Runs
    } else {
      ExternalLookup::NotFound
    }
  }

  fn run(&self, argv: Vec<String>) -> AsyncCommandFut {
    Box::pin(async move {
      let program = if argv[0] == "printf" {
        "/usr/bin/printf"
      } else {
        &argv[0]
      };
      let status = tokio::process::Command::new(program)
        .args(&argv[1..])
        .status()
        .await
        .map_err(|e| Error::Other(e.into()))?;
      if status.success() {
        Ok(JsonValue::Null)
      } else {
        Err(Error::ProcessExit {
          status: status.code(),
          signal: None,
          detail: "order child failed".into(),
        })
      }
    })
  }

  fn run_pipeline_with_io(
    &self,
    argv: Vec<Vec<String>>,
    input: Option<Vec<u8>>,
    capture: bool,
    io: Vec<Option<ShellIo>>,
  ) -> PipelineFuture {
    Box::pin(super::super::run_process_pipeline_with_io(
      argv
        .into_iter()
        .map(|argv| {
          let program = if argv[0] == "printf" {
            "/usr/bin/printf"
          } else {
            &argv[0]
          };
          (std::path::PathBuf::from(program), argv)
        })
        .collect(),
      input,
      capture,
      None,
      None,
      io,
    ))
  }

  fn suggest(&self, _: &str) -> Option<String> {
    None
  }
}

fn order_host() -> LispHost {
  let mut host = LispHost::new();
  host.set_external_commands(Rc::new(OrderPrograms));
  host.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .append(append)
      .truncate(!read && !append)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  host
}

#[tokio::test]
async fn builtin_bytes_reach_inherited_descriptors_before_children_and_at_statement_end() {
  const FLAG: &str = "TENTO_04V_OUTPUT_ORDER_CHILD";
  if let Ok(source) = std::env::var(FLAG) {
    let mut host = order_host();
    std::io::stdout().write_all(b"04v-begin\n").unwrap();
    std::io::stdout().flush().unwrap();
    super::bash_tests::bash(&mut host, &source).await.unwrap();
    // No Rust stdio flush here: a descriptor write observes statement completion.
    let end = b"04v-end\n";
    assert_eq!(
      unsafe { libc::write(1, end.as_ptr().cast(), end.len()) },
      end.len() as isize
    );
    return;
  }
  let test_name = "script::runner::output_order_tests::builtin_bytes_reach_inherited_descriptors_before_children_and_at_statement_end";
  for (source, expected) in [
    ("echo -n a; /usr/bin/printf n", "an"),
    ("echo -n a\n/usr/bin/printf n", "an"),
    ("echo -n a; printf n", "an"),
    (
      "for x in a b; do echo -n $x; /usr/bin/printf n; done",
      "anbn",
    ),
    ("f(){ echo -n a; /usr/bin/printf n; }; f; f", "anan"),
    ("echo -n a; /usr/bin/printf n | /bin/cat", "an"),
    ("echo -n a; echo -n n | /bin/cat", "an"),
    ("echo -n a; /bin/sh -c 'printf n >&2' 2>&1", "an"),
    ("echo -n a >&2; /usr/bin/printf n", "an"),
    ("echo -n end", "end"),
    (
      "{ set -x; /usr/bin/printf n; set +x; }",
      "+ /usr/bin/printf n\nn+ set +x\n",
    ),
  ] {
    let path = std::env::temp_dir().join(format!("tento-04v-inherited-{}", std::process::id()));
    let file = std::fs::File::create(&path).unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
      .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
      .env(FLAG, source)
      .stdout(std::process::Stdio::from(file.try_clone().unwrap()))
      .stderr(std::process::Stdio::from(file))
      .status()
      .unwrap();
    let stdout = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(child.success(), "{source}: {stdout:?}");
    assert!(
      stdout.contains(&format!("04v-begin\n{expected}04v-end\n")),
      "{source}: {stdout:?}"
    );
  }
}

#[tokio::test]
async fn builtin_child_order_survives_captures_functions_loops_and_redirects() {
  let mut host = order_host();
  for (source, expected) in [
    ("echo -n a; /usr/bin/printf n", "an"),
    (
      "for x in a b; do echo -n $x; /usr/bin/printf n; done",
      "anbn",
    ),
    ("f(){ echo -n a; /usr/bin/printf n; }; f; f", "anan"),
    ("echo \"$(echo -n a; /usr/bin/printf n)\"", "an\n"),
    ("{ echo -n a; /usr/bin/printf n; } | /bin/cat", "an"),
    ("{ echo -n a >&2; /bin/sh -c 'printf n >&2'; } 2>&1", "an"),
    (
      "{ missing-04v; /bin/sh -c 'printf child >&2'; } 2>&1",
      "tsh: line 1: missing-04v: command not found\nchild",
    ),
    (
      "{ set -x; /usr/bin/printf n; set +x; } 2>&1",
      "+ /usr/bin/printf n\nn+ set +x\n",
    ),
  ] {
    let result = host.capture_shell_source(source).await.unwrap();
    assert_eq!(result.stdout, expected.as_bytes(), "{source}");
    assert_eq!(result.status, 0, "{source}");
  }
  let file = std::env::temp_dir().join(format!("tento-04v-order-{}", std::process::id()));
  let source = format!(
    "{{ echo -n a; /usr/bin/printf n; echo -n b >&2; /bin/sh -c 'printf c >&2'; }} >{} 2>&1",
    serde_json::to_string(&file.to_string_lossy()).unwrap()
  );
  assert!(
    host
      .capture_shell_source(&source)
      .await
      .unwrap()
      .stdout
      .is_empty()
  );
  assert_eq!(std::fs::read(&file).unwrap(), b"anbc");
  std::fs::remove_file(file).unwrap();
}

#[tokio::test]
async fn printf_bash_unknown_escapes_match_in_format_and_b_arguments() {
  let mut host = order_host();
  // Each unknown ASCII escape, plus UTF-8 and a terminal backslash. % itself
  // is a format directive, so its format case is exercised as \%s separately.
  for ch in (1u8..=127).map(char::from).chain(['λ']) {
    if "abefnrtvE\\01234567xuU".contains(ch) {
      continue;
    }
    let escaped = format!("\\{ch}");
    let quoted = format!("'{}'", escaped.replace('\'', "'\\''"));
    let b = host
      .capture_shell_source(&format!("printf '%b' {quoted}"))
      .await
      .unwrap();
    assert_eq!(
      b.stdout,
      if ch == 'c' {
        b"".as_slice()
      } else {
        escaped.as_bytes()
      },
      "b {ch:?}"
    );
    if ch == '%' {
      continue;
    }
    let result = host
      .capture_shell_source(&format!("printf {quoted}"))
      .await
      .unwrap();
    let expected = if "\"'?".contains(ch) {
      ch.to_string()
    } else {
      escaped.clone()
    };
    assert_eq!(result.stdout, expected.as_bytes(), "format {ch:?}");
  }
  for (source, expected) in [
    (r"printf '\'", "\\"),
    (r"printf '%b' '\'", "\\"),
    (r"printf '\%s' ok", "\\ok"),
    (r"printf '%s:%b;' '\q' '\q' '\z' '\z'", "\\q:\\q;\\z:\\z;"),
    (r"printf '%b' '\cignored'; echo -n after", "after"),
    (r"printf \ ", " "),
  ] {
    assert_eq!(
      host.capture_shell_source(source).await.unwrap().stdout,
      expected.as_bytes(),
      "{source}"
    );
  }
}

#[tokio::test]
async fn hosted_diagnostics_and_stderr_bytes_stream_before_later_output_without_replay() {
  let mut host = order_host();
  let output = Rc::new(std::cell::RefCell::new(Vec::new()));
  let stdout = output.clone();
  host.set_shell_byte_output(Rc::new(move |bytes| {
    stdout.borrow_mut().extend_from_slice(bytes)
  }));
  let stderr = output.clone();
  host.set_shell_stderr_output(Rc::new(move |bytes| {
    stderr.borrow_mut().extend_from_slice(bytes)
  }));
  host.collect_shell_diagnostics();
  super::bash_tests::bash(
    &mut host,
    "missing-04v; echo -n after; echo -n err >&2; echo -n end",
  )
  .await
  .unwrap();
  assert_eq!(
    &*output.borrow(),
    b"tsh: line 1: missing-04v: command not found\naftererrend"
  );
  assert!(host.take_shell_diagnostics().is_empty());
  output.borrow_mut().clear();
  for _ in 0..2 {
    host.begin_shell_unit(404);
    super::bash_tests::bash(&mut host, "echo -n err >&2; echo -n end")
      .await
      .unwrap();
  }
  assert_eq!(&*output.borrow(), b"errend");
}

#[tokio::test]
async fn printf_escape_adapter_applies_to_async_line_argv_and_prompt_doors() {
  let mut host = order_host();
  let file = std::env::temp_dir().join(format!("tento-04v-doors-{}", std::process::id()));
  let source = format!(
    "printf '\\q' >{}",
    serde_json::to_string(&file.to_string_lossy()).unwrap()
  );
  host.eval_posix_line_async(&source).await.unwrap();
  assert_eq!(std::fs::read(&file).unwrap(), b"\\q");
  host.eval_prompt_source_async(&source).await.unwrap();
  assert_eq!(std::fs::read(&file).unwrap(), b"\\q");
  // The one-shot argv door delegates printf through the same external adapter.
  // Use a %b argument with no output to check \c without inherited descriptors.
  host
    .eval_posix_argv_async(vec!["printf".into(), "%b".into(), "\\cignored".into()])
    .await
    .unwrap();
  std::fs::remove_file(file).unwrap();
}
