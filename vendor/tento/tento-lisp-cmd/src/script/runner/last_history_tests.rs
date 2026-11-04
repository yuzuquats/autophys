use super::bash_tests::host;
use super::*;

#[tokio::test]
async fn last_history_defaults_conditions_and_indirection() {
  let mut h = host();
  let out = h
    .capture_shell_source(
      "if [[ -n \"${HOME_X:-}\" ]]; then echo set; else echo unset; fi; a=b; b=val; echo \"${!a}\"",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"unset\nval\n");
}

#[tokio::test]
async fn last_history_read_prefix_in_pipeline() {
  let mut h = host();
  let out = h
    .capture_shell_source(
      "IFS=:; echo 'ann,red,7' | while IFS=, read -r a b c; do echo \"$b\"; done; echo \"$IFS\"",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"red\n:\n");
}

#[tokio::test]
async fn last_history_integer_blanks_and_printf_q() {
  let mut h = host();
  let out = h
    .capture_shell_source("[ '       5 ' -gt 2 ] && echo many; printf '%q\\n' 'a b' '' 'x;y'")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"many\na\\ b\n''\nx\\;y\n");
}

#[tokio::test]
async fn last_history_flag_clusters_and_pipefail() {
  let mut h = host();
  let out = h
    .capture_shell_source(
      "set -euo pipefail; true; set +eu; false | true; echo $?; set -eu; echo ok",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"1\nok\n");
  assert!(h.shell_errexit);
  assert!(h.shell_compound.commands.nounset.get());
}

#[tokio::test]
async fn last_history_parameter_error_is_subshell_status_and_redirectable() {
  let mut h = host();
  h.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .append(append)
      .truncate(!read && !append)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  h.collect_shell_diagnostics();
  let out = h
    .capture_shell_source("( : \"${REQ:?missing}\" ) 2>/dev/null; echo \"rc=$?\"")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"rc=1\n");
  assert!(h.take_shell_diagnostics().is_empty());
  h.collect_shell_diagnostics();
  let out = h.capture_shell_source("( : \"${REQ:?missing}\" ); echo after")
    .await
    .unwrap();
  assert_eq!(out.stdout, b"after\n");
  assert_eq!(h.take_shell_diagnostics(), ["tsh: line 1: REQ: missing"]);
  h.collect_shell_diagnostics();
  let out = h.capture_shell_source("( : \"${REQ:?missing}\" ) 2>&1; echo \"rc=$?\"")
    .await.unwrap();
  assert_eq!(out.stdout, b"tsh: line 1: REQ: missing\nrc=1\n");
  assert!(h.take_shell_diagnostics().is_empty());
  let path = std::env::temp_dir().join(format!("tento-04w2-param-{}", std::process::id()));
  let quoted = serde_json::to_string(&path.to_string_lossy()).unwrap();
  h.collect_shell_diagnostics();
  let out = h.capture_shell_source(&format!(
    "( : \"${{REQ:?missing}}\" ) 2>{quoted}; echo \"rc=$?\""
  )).await.unwrap();
  assert_eq!(out.stdout, b"rc=1\n");
  assert_eq!(std::fs::read(&path).unwrap(), b"tsh: line 1: REQ: missing\n");
  assert!(h.take_shell_diagnostics().is_empty());
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn last_history_source_state_args_return_and_restore() {
  let path = std::env::temp_dir().join(format!("tento-04w-source-{}.sh", std::process::id()));
  std::fs::write(
    &path,
    "FOO=loaded\nhello(){ echo \"hello:$1\"; }\necho \"arg:$1\"\nreturn 7\necho missed\n",
  )
  .unwrap();
  let mut h = host();
  h.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .append(append)
      .truncate(!read && !append)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let out = h
    .capture_shell_source(&format!(
      "set -- caller; . {} filearg; echo $?; hello world; echo \"$FOO:$1\"; source {} again",
      path.display(),
      path.display()
    ))
    .await
    .unwrap();
  assert_eq!(
    out.stdout,
    b"arg:filearg\n7\nhello:world\nloaded:caller\narg:again\n"
  );
  assert_eq!(out.status, 7);
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn last_history_mapfile_and_readarray() {
  let mut h = host();
  let out = h.capture_shell_source(
    "mapfile -t lines <<'EOF'\nfirst\nsecond\nEOF\necho \"${lines[0]} / ${#lines[@]}\"; readarray rows <<'EOF'\nx\nEOF\necho \"${rows[0]}\""
  ).await.unwrap();
  assert_eq!(out.stdout, b"first / 2\nx\n\n");
}

#[tokio::test]
async fn last_history_declare_associative_integer_readonly_export_global_print() {
  let mut h = host();
  let out = h.capture_shell_source(
    "declare -A m; m[k]=v; m['two words']='a b'; echo \"${m[k]}:${m['two words']}\"; declare -a a; a[2]=two; echo ${a[2]}; declare -i n=2+3; n=n*2; echo $n; declare -r r=old; echo $r; f(){ declare -g g=global; }; f; echo $g; declare -x x=exported; declare -p n"
  ).await.unwrap();
  assert_eq!(
    out.stdout,
    b"v:a b\ntwo\n10\nold\nglobal\ndeclare -i n=\"10\"\n"
  );
}

#[cfg(unix)]
#[tokio::test]
async fn last_history_background_compounds_isolate_and_wait() {
  let mut h = host();
  let out = h.capture_shell_source(
    "x=outer; { (echo a) & (echo b) & wait; } | while read -r line; do echo $line; done; { x=child; echo $x; } & wait; echo $x"
  ).await.unwrap();
  let text = String::from_utf8(out.stdout).unwrap();
  assert!(
    text.starts_with("a\nb\n") || text.starts_with("b\na\n"),
    "{text}"
  );
  assert!(text.ends_with("child\nouter\n"), "{text}");
}

#[tokio::test]
async fn last_history_readonly_assignment_stops_unit() {
  let mut h = host();
  h.collect_shell_diagnostics();
  let error = h
    .capture_shell_source("declare -r r=old; r=new; echo missed")
    .await
    .unwrap_err();
  assert!(matches!(
    error,
    TshScriptErrorKind::Control(super::super::ControlSignal::Discard(1))
  ));
  assert!(
    h.take_shell_diagnostics()
      .iter()
      .any(|s| s.contains("r: readonly variable"))
  );
}

#[cfg(unix)]
#[tokio::test]
async fn last_history_process_substitution_streams_and_preserves_state() {
  use super::super::interp::{AsyncCommandFut, ExternalCommands, ExternalLookup};
  struct Programs(Rc<std::cell::RefCell<Vec<u8>>>);
  impl ExternalCommands for Programs {
    fn lookup(&self, head: &str) -> ExternalLookup {
      if std::path::Path::new(head).is_file() {
        ExternalLookup::Runs
      } else {
        ExternalLookup::NotFound
      }
    }
    fn suggest(&self, _: &str) -> Option<String> {
      None
    }
    fn run(&self, _: Vec<String>) -> AsyncCommandFut {
      Box::pin(async { Ok(JsonValue::Null) })
    }
    fn run_pipeline_with_io(
      &self,
      argv: Vec<Vec<String>>,
      input: Option<Vec<u8>>,
      capture: bool,
      io: Vec<Option<super::super::ShellIo>>,
    ) -> super::super::PipelineFuture {
      let stderr = self.0.clone();
      Box::pin(super::super::run_process_pipeline_with_io(
        argv
          .into_iter()
          .map(|argv| (std::path::PathBuf::from(&argv[0]), argv))
          .collect(),
        input,
        capture,
        None,
        Some(Rc::new(move |bytes, is_stderr| {
          if is_stderr { stderr.borrow_mut().extend_from_slice(bytes); }
        })),
        io,
      ))
    }
  }
  let mut h = host();
  let stderr = Rc::new(std::cell::RefCell::new(Vec::new()));
  h.set_external_commands(Rc::new(Programs(stderr.clone())));
  let path = std::env::temp_dir().join(format!("tento-04w-procsub-{}", std::process::id()));
  h.set_shell_file_opener(Rc::new(|path, read, append| {
    std::fs::OpenOptions::new()
      .read(read)
      .write(!read)
      .create(!read)
      .append(append)
      .truncate(!read && !append)
      .open(path)
      .map_err(|e| LispHostError::Command(e.to_string()))
  }));
  let out = h
    .capture_shell_source(&format!(
      "x=outer; /usr/bin/comm -12 <(echo common; echo left) <(echo common; echo right); \
     echo output > >(/bin/cat >{}); wait; echo $x",
      path.display()
    ))
    .await
    .unwrap();
  assert_eq!(out.stdout, b"common\nouter\n");
  assert_eq!(std::fs::read(&path).unwrap(), b"output\n");
  assert!(stderr.borrow().is_empty());
  let a = path.with_extension("a");
  let b = path.with_extension("b");
  std::fs::write(&a, b"pear\napple\nfig\n").unwrap();
  std::fs::write(&b, b"fig\nkiwi\napple\n").unwrap();
  let qa = serde_json::to_string(&a.to_string_lossy()).unwrap();
  let qb = serde_json::to_string(&b.to_string_lossy()).unwrap();
  let out = h.capture_shell_source(&format!(
    "/usr/bin/comm -12 <(/usr/bin/sort {qa}) <(/usr/bin/sort {qb})"
  )).await.unwrap();
  assert_eq!(out.stdout, b"apple\nfig\n");
  assert_eq!(out.status, 0);
  assert!(stderr.borrow().is_empty());
  let script = format!(
    "/usr/bin/diff <(/usr/bin/sort {qa}) <(/usr/bin/sort {qb}) || true"
  );
  let expected = std::process::Command::new("/bin/bash")
    .args(["-c", &script]).env("LC_ALL", "C").output().unwrap();
  assert!(expected.status.success());
  let out = h.capture_shell_source(&format!("LC_ALL=C; {script}")).await.unwrap();
  assert_eq!(out.status, 0);
  assert_eq!(out.stdout, expected.stdout);
  assert_eq!(std::mem::take(&mut *stderr.borrow_mut()), expected.stderr);
  std::fs::remove_file(a).unwrap();
  std::fs::remove_file(b).unwrap();
  let out = tokio::time::timeout(
    std::time::Duration::from_secs(5),
    h.capture_shell_source(
      "x=outer; while read -r line; do echo \"$line:$x\"; done < <(x=child; echo one; echo two); \
       for word in a b; do read -r line < <(echo $word); echo $line; done; \
       read -r line < <(/bin/cat <(echo nested)); echo $line; echo $x; wait",
    ),
  ).await.expect("builtin and loop process substitutions").unwrap();
  assert_eq!(out.stdout, b"one:outer\ntwo:outer\na\nb\nnested\nouter\n");
  assert!(h.shell_compound.commands.process_fds.borrow().is_empty());
  assert!(h.shell_io.borrow().is_none());
  let out = tokio::time::timeout(
    std::time::Duration::from_secs(5),
    h.capture_shell_source("/usr/bin/head -n 1 <(/usr/bin/yes x)"),
  )
  .await
  .expect("streaming process substitution")
  .unwrap();
  assert_eq!(out.stdout, b"x\n");
  std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn last_history_globstar_zero_many_directories_and_hidden_rules() {
  let root = std::env::temp_dir().join(format!("tento-04w-globstar-{}", std::process::id()));
  std::fs::create_dir_all(root.join("a/b")).unwrap();
  std::fs::create_dir_all(root.join(".hidden")).unwrap();
  for name in ["top.rs", "a/one.rs", "a/b/two.rs", ".hidden/secret.rs"] {
    std::fs::write(root.join(name), "").unwrap();
  }
  let mut h = host();
  let out = h
    .capture_shell_source(&format!(
      "shopt -s globstar; echo {}/**/*.rs",
      root.display()
    ))
    .await
    .unwrap();
  let expected = format!("{0}/a/b/two.rs {0}/a/one.rs {0}/top.rs\n", root.display());
  assert_eq!(out.stdout, expected.as_bytes());
  std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn last_history_printf_q_precision_alternate_and_control_bytes() {
  let mut h = host();
  let out = h
    .capture_shell_source(
      "LC_ALL=C; printf '%q\\n' 'é' $'a\\nb'; printf '%.2q|%#q|%5q\\n' 'a b' 'a b' x",
    )
    .await
    .unwrap();
  assert_eq!(out.stdout, b"$'\\303\\251'\n$'a\\nb'\na\\|'a b'|    x\n");
}

#[tokio::test]
async fn last_history_declaration_array_initializers_and_local_attributes() {
  let mut h = host();
  let out = h.capture_shell_source(
    "declare -ar a=(one 'two three'); typeset -A m=([k]=v ['two words']='a b'); echo \"${a[1]}:${m[k]}:${m['two words']}\"; n=outer; f(){ declare -i n=2+3; echo $n; }; f; n=plain; echo $n"
  ).await.unwrap();
  assert_eq!(out.stdout, b"two three:v:a b\n5\nplain\n");
}

#[tokio::test]
async fn last_history_integer_arrays_evaluate_and_add() {
  let mut h = host();
  let out = h.capture_shell_source(
    "declare -ai a=(2+3); a[1]=4*2; a[1]+=2; declare -Ai m; m[k]=2+3; m[k]+=4; echo ${a[0]}:${a[1]}:${m[k]}"
  ).await.unwrap();
  assert_eq!(out.stdout, b"5:10:9\n");
}

#[tokio::test]
async fn last_history_declare_export_and_print_implicit_array() {
  let map = tento_env::EnvMap::new();
  tento_env::with_env_map_async(map.clone(), async {
    let mut h = host();
    let out = h
      .capture_shell_source("declare -x x=first; x=second; a=(one); declare -p a")
      .await
      .unwrap();
    assert_eq!(map.get("x").as_deref(), Some("second"));
    assert_eq!(out.stdout, b"declare -a a=([0]=\"one\")\n");
  })
  .await;
}
