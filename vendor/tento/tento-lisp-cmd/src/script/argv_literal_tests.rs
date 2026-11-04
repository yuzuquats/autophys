#[tokio::test]
async fn literal_external_options_reach_line_argv_and_lisp_doors() {
  let (mut host, ran) = external_host(true, &["git"]);
  let words = ["git", "--k=v", "--multi-word-flag=x", "--flag", "--json", "--help", "--", "-rn"];
  host.eval_posix_line_async(&words.join(" ")).await.unwrap();
  host.eval_posix_argv_async(words.iter().map(|s| s.to_string()).collect()).await.unwrap();
  host.eval_posix_line_async(r#"(git :multi-word-flag "x" :flag "next" "--json" "--help")"#).await.unwrap();
  let calls = ran.borrow();
  assert_eq!(calls[0], words);
  assert_eq!(calls[1], words);
  assert_eq!(calls[2], ["git", "--multi-word-flag", "x", "--flag", "next", "--json", "--help"]);
  assert!(!host.command_json_output());
}

fn reflection_host() -> LispHost {
  let scripts = crate::Scripts::new(())
    .add_command(crate::SyncCommand(HelpProbe))
    .with_root_prelude("(let probe std.test.probe)");
  let mut host = LispHost::new();
  host.register_commands(Rc::new(scripts), Rc::new(HashMap::new()));
  host
}

#[tokio::test]
async fn command_reflection_agrees_in_all_doors_and_respects_terminator() {
  let mut host = reflection_host();
  let doc = host.eval_to_json(r#"(help "std.test.probe")"#).unwrap();
  // `probe` (the seed's `(let probe std.test.probe)`) is a Lisp name and a
  // prompt declaration; these doors are no prompt, so only the full name.
  for source in ["std.test.probe --help", "std.test.probe '--help'"] {
    assert_eq!(host.eval_posix_line(source).unwrap(), doc);
    assert_eq!(host.eval_posix_line_async(source).await.unwrap(), doc);
  }
  assert_eq!(host.eval_to_json("(std.test.probe :help)").unwrap(), doc);
  assert_eq!(host.eval_to_json(r#"(std.test.probe "--help")"#).unwrap(), doc);
  assert_eq!(host.eval_posix_argv_async(vec!["std.test.probe".into(), "--help".into()]).await.unwrap(), doc);
  for source in ["std.test.probe -- --help --json"] {
    assert_eq!(host.eval_posix_line_async(source).await.unwrap(), serde_json::json!(["--", "--help", "--json"]));
    assert!(!host.command_json_output());
  }
  // The seed's declaration turns on the shell door, where `--json` writes
  // the document as text rather than returning it.
  let namespace = host.eval_to_json(r#"(help "std.test")"#).unwrap();
  let written = |captured: crate::script::ShellCapture| serde_json::from_slice::<JsonValue>(&captured.stdout).unwrap();
  assert_eq!(written(host.capture_shell_source("std.test --help --json").await.unwrap()), namespace);
  assert!(host.eval_posix_line_async("std.test -- --help").await.is_err());
  host.eval_to_json(r#"(let help_word "--help")"#).unwrap();
  assert_eq!(written(host.capture_shell_source("std.test $help_word --json").await.unwrap()), namespace);
}

#[tokio::test]
async fn json_is_text_output_metadata_and_not_a_lisp_value_wrapper() {
  let mut host = reflection_host();
  host.set_shell_formatter(Rc::new(|_| Some("human table\n".into())));
  let captured = host.capture_shell_source("std.test.probe --json a").await.unwrap();
  assert_eq!(captured.stdout, b"[\"a\"]\n");
  let captured = host.capture_shell_source("std.test.probe a --json; std.test.probe b").await.unwrap();
  assert_eq!(captured.stdout, b"[\"a\"]\nhuman table\n");
  let captured = host.capture_shell_source("std.test.probe --help --json").await.unwrap();
  let doc: JsonValue = serde_json::from_slice(&captured.stdout).unwrap();
  assert_eq!(doc["type"], "command.doc/v1");
  assert_eq!(host.eval_to_json(r#"(std.test.probe :json "a")"#).unwrap(), serde_json::json!(["a"]));
  assert!(!host.command_json_output(), "Lisp reflection has no text mode side effect");
  assert_eq!(host.eval_posix_line(r#"(std.test.probe :json "a")"#).unwrap(), serde_json::json!(["a"]));
  assert!(!host.command_json_output());
  let bytes = Rc::new(RefCell::new(Vec::new()));
  let written = bytes.clone();
  host.set_shell_byte_output(Rc::new(move |b| written.borrow_mut().extend_from_slice(b)));
  let scripts = crate::Scripts::new(());
  crate::script::runner::run_source_on_host(&mut host, "std.test.probe --json a", &scripts, &HashMap::new(), &[],
    crate::script::runner::RunOptions { on_error: crate::script::runner::OnError::Bash,
      bash_output: Some(Rc::new(|_, _, _| panic!("JSON must bypass human value writer"))), ..Default::default() }).await.unwrap();
  assert_eq!(&*bytes.borrow(), b"[\"a\"]\n");
}

#[tokio::test]
async fn json_survives_substitution_and_expanded_option_words() {
  let mut host = reflection_host();
  host.eval_to_json(r#"(let flag "--json")"#).unwrap();
  let captured = host.capture_shell_source("std.test.probe $flag a").await.unwrap();
  assert_eq!(captured.stdout, b"[\"a\"]\n");
  host.set_shell_formatter(Rc::new(|value| Some(format!("{}\n", value[0].as_str().unwrap()))));
  let captured = host.capture_shell_source("std.test.probe \"$(std.test.probe --json a)\"").await.unwrap();
  assert_eq!(String::from_utf8(captured.stdout).unwrap().trim(), "[\"a\"]");
  assert!(!host.command_json_output(), "substitution's mode must not leak to its consumer");
}

#[tokio::test]
async fn lisp_functions_keep_literal_words_and_do_not_inherit_nested_json() {
  let mut host = reflection_host();
  host.eval_to_json(r#"(let words (lambda (x y) (list x y)))"#).unwrap();
  // A Lisp function takes its words as written when Lisp calls it; a bash
  // line never reaches it (I12).
  assert_eq!(host.eval_to_json(r#"(words "--k=v" "--multi-word")"#).unwrap(), serde_json::json!(["--k=v", "--multi-word"]));
  let error = host.eval_posix_line_async("words --k=v --multi-word").await.unwrap_err();
  assert!(
    matches!(error, crate::Error::CommandNotFound { ref name, .. } if name == "words") || error.process_status() == Some(127),
    "{error}"
  );
  host.eval_to_json(r#"(let nested (lambda () (std.test.probe :json "x")))"#).unwrap();
  assert_eq!(host.eval_to_json("(nested)").unwrap(), serde_json::json!(["x"]));
  assert!(!host.command_json_output());
  // `std.*` is read-only for user code; the host registers the function.
  host.register_native_special("std.test", |mut args| Ok(args.remove(0)));
  assert_eq!(host.eval_posix_line_async("std.test --help").await.unwrap(), "--help");
}

struct JsonNullProbe;
impl crate::CommandMetadataSync<()> for JsonNullProbe {
  fn name(&self) -> &'static str { "std.test.null" }
  fn description(&self) -> &'static str { "Return null" }
  fn call_sync(&self, _: (), _: Vec<String>) -> crate::Result<JsonValue> { Ok(JsonValue::Null) }
}

#[tokio::test]
async fn json_null_is_written_at_the_script_text_boundary() {
  let mut host = LispHost::new();
  host.register_commands(Rc::new(crate::Scripts::new(()).add_command(crate::SyncCommand(JsonNullProbe))), Rc::new(HashMap::new()));
  assert_eq!(host.capture_shell_source("std.test.null --json").await.unwrap().stdout, b"null\n");
  assert_eq!(host.capture_shell_source("std.test.null").await.unwrap().stdout, b"");
}

#[tokio::test]
async fn json_text_boundary_consumes_presentation_mode() {
  let mut host = reflection_host();
  let captured = host.capture_shell_source("std.test.probe --json a").await.unwrap();
  assert_eq!(captured.stdout, b"[\"a\"]\n");
  assert!(!host.command_json_output(), "written bytes must not leave a value to render again");
  host.register_shell_alias("probe", "std.test.probe");
  let bytes = Rc::new(RefCell::new(Vec::new()));
  let written = bytes.clone();
  host.set_shell_byte_output(Rc::new(move |b| written.borrow_mut().extend_from_slice(b)));
  let value = host.eval_posix_argv_async(vec!["std.test.probe".into(), "--json".into(), "a".into()]).await.unwrap();
  assert_eq!(value, JsonValue::Null);
  assert_eq!(&*bytes.borrow(), b"[\"a\"]\n");
  assert!(!host.command_json_output());
}

#[tokio::test]
async fn mounted_group_help_returns_data_and_keeps_terminated_words() {
  let scripts = crate::Scripts::new(()).add_command(crate::SyncCommand(HelpProbe));
  let mut subs: HashMap<String, Box<dyn crate::shell::Callable>> = HashMap::new();
  subs.insert("tools".into(), Box::new(crate::Scripts::new(()).add_command(crate::SyncCommand(HelpProbe))));
  let mut host = LispHost::new();
  host.register_commands(Rc::new(scripts), Rc::new(subs));
  let doc = host.eval_to_json(r#"(help "std.test.probe")"#).unwrap();
  assert_eq!(host.eval_to_json(r#"(tools "std.test.probe" :help)"#).unwrap(), doc);
  assert_eq!(host.eval_posix_argv_async(vec!["tools".into(), "std.test.probe".into(), "--help".into()]).await.unwrap(), doc);
  let captured = host.capture_shell_source("tools std.test.probe --help --json").await.unwrap();
  assert_eq!(serde_json::from_slice::<JsonValue>(&captured.stdout).unwrap(), doc);
  assert_eq!(host.eval_posix_line_async("tools std.test.probe -- --help --json").await.unwrap(), serde_json::json!(["--", "--help", "--json"]));
}

struct ReflectionImport;
impl ImportResolver for ReflectionImport {
  fn lazy_eligible(&self, _: &str, _: Option<&str>) -> bool { true }
  fn resolve(&self, _: &str, namespace: &str, _: Option<&str>, _: Rc<RefCell<Option<String>>>) -> Result<ImportMounts, RuntimeError> {
    let mut host = reflection_host();
    let doc = host.eval_to_json(r#"(help "std.test.probe")"#).unwrap();
    let native: NativeClosure<Sym> = Rc::new(move |_, args| {
      if args.iter().take_while(|arg| !matches!(arg, LispValue::String(word) if word == "--"))
        .any(|arg| matches!(arg, LispValue::String(word) if word == "--help")) {
        Ok(value_from_json(&doc))
      } else { Ok(LispValue::List(tento_lisp::List { items: args.into() })) }
    });
    let dispatch: AsyncDispatch = Rc::new(|argv| {
      assert!(!argv.iter().skip(1).take_while(|word| word.as_str() != "--").any(|word| word == "--json"), "the host binder consumes JSON presentation");
      Ok(Box::pin(async move { Ok(serde_json::json!(&argv[1..])) }))
    });
    let name = format!("{namespace}.probe");
    Ok(ImportMounts { mounts: vec![(name.clone(), LispValue::Function(Function::NativeClosure(native)))],
      async_mounts: vec![(name, dispatch)], ui_scripts: vec![], rc_scripts: vec![] })
  }
}

#[tokio::test]
async fn imported_commands_bind_reflection_on_eager_lazy_and_direct_mounts() {
  for lazy in [false, true] {
    let mut host = LispHost::with_resolver(Rc::new(ReflectionImport));
    host.register_commands(Rc::new(crate::Scripts::new(())), Rc::new(HashMap::new()));
    if lazy { host.enable_lazy_imports(); }
    host.eval_to_json(r#"(@import "fixture" :as "fixture")"#).unwrap();
    let doc = host.eval_posix_line_async("fixture.probe --help").await.unwrap();
    assert_eq!(doc["type"], "command.doc/v1");
    assert_eq!(host.eval_to_json(r#"(help "fixture.probe")"#).unwrap(), doc);
    assert_eq!(host.eval_to_json("(fixture.probe :help)").unwrap(), doc);
    assert_eq!(host.capture_shell_source("fixture.probe --json a").await.unwrap().stdout, b"[\"a\"]\n");
    assert_eq!(host.eval_posix_line_async("fixture.probe -- --help --json").await.unwrap(), serde_json::json!(["--", "--help", "--json"]));
    let namespace = host.capture_shell_source("fixture --help --json").await.unwrap();
    let namespace: JsonValue = serde_json::from_slice(&namespace.stdout).unwrap();
    assert_eq!(namespace["type"], "command.index/v1");
    assert_eq!(namespace["entries"]["probe"], doc);
    assert_eq!(host.eval_to_json(r#"(fixture.probe :json "a")"#).unwrap(), serde_json::json!(["a"]));
    assert!(!host.command_json_output());
  }
  let mut host = LispHost::new();
  host.register_commands(Rc::new(crate::Scripts::new(())), Rc::new(HashMap::new()));
  host.mount(ReflectionImport.resolve("fixture", "fixture", None, Rc::new(RefCell::new(None))).unwrap(), "fixture");
  assert_eq!(host.eval_posix_line("fixture.probe --json a").unwrap(), serde_json::json!(["a"]));
  assert!(host.command_json_output());
  assert_eq!(host.eval_to_json("(fixture.probe :json \"a\")").unwrap(), serde_json::json!(["a"]));
  assert!(!host.command_json_output());
}

/// A retired command keeps its replacement's JSON presentation through a
/// computed command word (`cmd=std.fs.list_dir; $cmd --json`), as the
/// literal word does.
#[tokio::test]
async fn a_computed_retired_command_word_keeps_the_json_presentation() {
  let mut host = reflection_host();
  host.add_deprecated_call("std.test.old", "std.test.probe", &["-x"]);
  host.set_shell_formatter(Rc::new(|_| Some("human table\n".into())));
  for source in ["std.test.old --json a", "c=std.test.old; $c --json a"] {
    let captured = host.capture_shell_source(source).await.unwrap();
    assert_eq!(String::from_utf8_lossy(&captured.stdout), "[\"-x\",\"a\"]\n", "{source}");
  }
}
