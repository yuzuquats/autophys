//! The account-kind executor against fake apps.
//!
//! Every fake is this test binary itself, run through a symlink: named
//! `fakecli` it plays an app's CLI, named `security` it plays the keychain
//! tool, named `curl` it plays the HTTP client (recording the request it was
//! asked to make, never making it). Nothing here reads the real home, environment or keychain: each
//! fixture owns a temporary HOME and gives the executor an explicit
//! environment. The identity endpoint is a loopback listener that records
//! what it received, so the test can see the bearer arrive in a header.
//!
//! `harness = false`: `main` decides between playing a fake and running the
//! tests below.
use serde_json::{Value, json};
use std::{
  collections::BTreeMap,
  io::{BufRead, BufReader, Read, Write},
  net::TcpListener,
  path::{Path, PathBuf},
  sync::{Arc, Mutex},
};
use tento_app::auth::{self, KindHost, KindProvider};
use tento_secrets::accounts::kind::{Fallback, Shared};
use tento_secrets::accounts::{
  AccountKind, AuthState, CredentialRef, ENV_APP, ENV_CREDENTIAL_DIR, ENV_PROFILE_ID, Identity,
  Launch, Profile, Registry, Request,
};

// --- the fakes -----------------------------------------------------------------

fn fake_cli(args: &[String]) -> i32 {
  let here = PathBuf::from(std::env::args().next().unwrap());
  let dir = here.parent().unwrap().to_path_buf();
  let args: Vec<&str> = args.iter().map(String::as_str).collect();
  match args.as_slice() {
    // The environment the app was started with, as JSON.
    ["env-dump"] => {
      let env: BTreeMap<String, String> = std::env::vars().collect();
      print!("{}", serde_json::to_string(&env).unwrap());
      0
    }
    ["agents", "--json"] => match std::env::var_os("CLAUDE_CONFIG_DIR") {
      Some(config) => match std::fs::read(Path::new(&config).join("agents.json")) {
        Ok(bytes) => {
          std::io::stdout().write_all(&bytes).unwrap();
          0
        }
        Err(_) => 1,
      },
      None => {
        println!("[]");
        0
      }
    },
    ["auth", "status", "--json"] => {
      match std::fs::read_to_string(dir.join("status.json")) {
        Ok(text) => print!("{text}"),
        Err(_) => println!(r#"{{"loggedIn":false,"authMethod":"claude.ai"}}"#),
      }
      0
    }
    ["login", "status"] => {
      let home = std::env::var_os("FAKE_HOME").map(PathBuf::from);
      if home.is_some_and(|h| h.join("auth.json").is_file()) {
        println!("Logged in using ChatGPT");
        0
      } else {
        println!("Not logged in");
        1
      }
    }
    _ => 0,
  }
}

fn fake_security(args: &[String]) -> i32 {
  let here = PathBuf::from(std::env::args().next().unwrap());
  let dir = here.parent().unwrap().to_path_buf();
  let a: Vec<&str> = args.iter().map(String::as_str).collect();
  let ["find-generic-password", "-a", user, "-s", service, "-w"] = a.as_slice() else {
    return 2;
  };
  let mut log = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(dir.join("security.log"))
    .unwrap();
  writeln!(log, "{user}|{service}").unwrap();
  match std::fs::read(dir.join("keychain").join(service)) {
    Ok(bytes) => {
      std::io::stdout().write_all(&bytes).unwrap();
      0
    }
    Err(_) => 44,
  }
}

/// Records the URL and protocol restriction it was given, and whether the
/// bearer arrived on stdin, then answers as a signed-in identity endpoint.
fn fake_curl(args: &[String]) -> i32 {
  let here = PathBuf::from(std::env::args().next().unwrap());
  let dir = here.parent().unwrap().to_path_buf();
  let after = |flag: &str| {
    args
      .windows(2)
      .find(|w| w[0] == flag)
      .map(|w| w[1].clone())
      .unwrap_or_default()
  };
  let mut stdin = String::new();
  std::io::stdin().read_to_string(&mut stdin).unwrap();
  let mut log = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(dir.join("curl.log"))
    .unwrap();
  writeln!(
    log,
    "{} {} bearer={}",
    after("--proto"),
    after("--url"),
    stdin.contains("Authorization: Bearer ")
  )
  .unwrap();
  print!(r#"{{"account":{{"uuid":"acct-c","email":"c@example.com"}}}}"#);
  print!("\n200");
  0
}

// --- fixtures ------------------------------------------------------------------

/// A Claude-shaped kind (native store, shared customization, HTTP identity,
/// exact resume, busy probe, settings guards, legacy import) that names no
/// real app: its CLI is `fakecli`.
fn claude_like(url: &str) -> AccountKind {
  AccountKind::parse(
    &json!({
      "schema": "account.kind/v1",
      "app": "fixture",
      "cli": {"env": "FAKE_CLI", "name": "fakecli"},
      "credential": {
        "backend": "native",
        "root": {"env": "FAKE_PROFILE_DIR", "default": "{home}/.local/share/fixture-profiles"},
        "locator": "{root}/cred/{alias}",
        "secret": {
          "keychain_service": "Fixture-credentials-{sha256_8:locator}",
          "file": "{locator}/.credentials.json",
          "json_pointer": "/oauth/accessToken"
        }
      },
      "config_dir": "{profile_dir}/config",
      "shared": {"from": "{home}/.fixture", "names": ["skills", "settings.json", "projects"], "create": ["projects"]},
      "env": {
        "CLAUDE_CONFIG_DIR": "{config_dir}",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR": "{locator}",
        "FIXTURE_EXECUTABLE": "{cli}",
        "FIXTURE_PROFILE_ATTR": "{id}",
        "TSH_AUTH_APP": "{app}",
        "TSH_AUTH_PROFILE_ID": "{id}"
      },
      "remove_env": ["FIXTURE_TOKEN", "FIXTURE_API_KEY"],
      "login": {"args": ["auth", "login"], "label_args": ["--email", "{label}"]},
      "verify": {
        "precheck": {"args": ["auth", "status", "--json"], "expect": {"/loggedIn": true, "/authMethod": "claude.ai"}},
        "http": {"url": url, "id": "/account/uuid", "label": "/account/email"},
        "expected_label": "locator_basename_if_email"
      },
      "guards": {
        "files": ["{home}/.fixture/settings.json"],
        "cwd_files": [".fixture/settings.json", ".fixture/settings.local.json"],
        "forbidden_keys": ["/apiKeyHelper"],
        "env_object": "/env",
        "forbidden_env": ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]
      },
      "resume": {
        "exact": ["--resume", "-r"],
        "refuse": ["--continue", "-c"],
        "refuse_with_resume": ["--bg", "--background"],
        "source_env": ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
        "history": {"dir": "{config_dir}/projects", "file": "{sid}.jsonl", "source_env": "CLAUDE_CONFIG_DIR", "source_subdir": "projects"},
        "busy": {
          "args": ["agents", "--json"],
          "env": ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
          "id_keys": ["sessionId", "session_id", "parentSessionId", "parent_session_id"],
          "status_keys": ["status", "state"],
          "idle": ["idle", "completed", "done", "stopped", "exited"],
          "interactive": {"key": "kind", "value": "interactive"}
        }
      },
      "import": {"tsv": "{root}/profiles.tsv", "locator": "{root}/cred/{key}"}
    })
    .to_string(),
  )
  .unwrap()
}

struct Fixture {
  _temp: tempfile::TempDir,
  root: PathBuf,
  home: PathBuf,
  cli: PathBuf,
  registry: Registry,
  provider: KindProvider,
}

impl Fixture {
  fn new(kind: AccountKind) -> Self {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let home = root.join("home");
    std::fs::create_dir(&home).unwrap();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let exe = std::env::current_exe().unwrap();
    let cli = bin.join("fakecli");
    std::os::unix::fs::symlink(&exe, &cli).unwrap();
    std::os::unix::fs::symlink(&exe, bin.join("security")).unwrap();
    std::os::unix::fs::symlink(&exe, bin.join("curl")).unwrap();
    std::fs::create_dir(bin.join("keychain")).unwrap();
    let vars = BTreeMap::from([
      ("HOME".to_string(), home.to_string_lossy().into_owned()),
      ("PATH".to_string(), "/usr/bin:/bin".to_string()),
      ("FAKE_CLI".to_string(), cli.to_string_lossy().into_owned()),
      (
        "FAKE_PROFILE_DIR".to_string(),
        root.join("native").to_string_lossy().into_owned(),
      ),
    ]);
    let host = KindHost {
      home: home.clone(),
      child_env: Some(BTreeMap::from([
        ("HOME".to_string(), home.to_string_lossy().into_owned()),
        ("PATH".to_string(), "/usr/bin:/bin".to_string()),
      ])),
      vars,
      cwd: root.clone(),
      keychain: None,
      user: Some("fixture-user".into()),
      curl: PathBuf::from("/usr/bin/curl"),
    };
    Self {
      registry: Registry::at(root.join("store/profiles")),
      provider: KindProvider::new(kind, host),
      _temp: temp,
      root,
      home,
      cli,
    }
  }

  fn claude_like() -> Self {
    Self::new(claude_like("https://identity.invalid/profile"))
  }

  fn request(&self, operation: &str, body: Value) -> Request {
    let mut body = body;
    body["version"] = json!(1);
    body["operation"] = json!(operation);
    body["app"] = json!(self.provider.kind.app);
    if body.get("cwd").is_none() {
      body["cwd"] = json!(self.root);
    }
    serde_json::from_value(body).unwrap()
  }

  fn run(&self, operation: &str, body: Value) -> anyhow::Result<Value> {
    let reply = self
      .provider
      .run(&self.registry, self.request(operation, body))?;
    Ok(serde_json::to_value(reply).unwrap())
  }

  fn register(&self, alias: &str) -> Profile {
    self.provider.register_alias(&self.registry, alias).unwrap()
  }

  fn block_on<T>(&self, future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap()
      .block_on(future)
  }
}

/// A one-shot loopback HTTP server: answers every request with `status` and
/// `body`, and keeps the request heads it received.
struct Endpoint {
  url: String,
  seen: Arc<Mutex<Vec<String>>>,
}

fn endpoint(status: u16, body: Value) -> Endpoint {
  endpoint_at(
    TcpListener::bind("127.0.0.1:0").unwrap(),
    "127.0.0.1",
    status,
    body,
  )
}

/// The same server on an already bound listener, reached as `http://<host>`.
fn endpoint_at(listener: TcpListener, host: &str, status: u16, body: Value) -> Endpoint {
  let url = format!(
    "http://{host}:{}/profile",
    listener.local_addr().unwrap().port()
  );
  let seen = Arc::new(Mutex::new(Vec::new()));
  let log = seen.clone();
  std::thread::spawn(move || {
    for stream in listener.incoming() {
      let Ok(mut stream) = stream else { break };
      let mut reader = BufReader::new(stream.try_clone().unwrap());
      let mut head = String::new();
      loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
          break;
        }
        head.push_str(&line);
      }
      log.lock().unwrap().push(head);
      let body = body.to_string();
      let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
      );
    }
  });
  Endpoint { url, seen }
}

// --- launch, register, import, login -----------------------------------------------

fn accounts_share_customization_but_isolate_config_and_credentials() {
  let f = Fixture::claude_like();
  let shared = f.home.join(".fixture");
  std::fs::create_dir_all(shared.join("skills")).unwrap();
  std::fs::write(shared.join("settings.json"), "{}").unwrap();
  let a = f.register("james");
  let b = f.register("moo");
  let x = f.provider.launch_for(&f.registry, &a).unwrap();
  let y = f.provider.launch_for(&f.registry, &b).unwrap();
  assert_ne!(x.env["CLAUDE_CONFIG_DIR"], y.env["CLAUDE_CONFIG_DIR"]);
  assert_eq!(
    Path::new(&x.env["CLAUDE_CONFIG_DIR"]),
    f.registry.root.join("fixture").join(&a.id).join("config")
  );
  assert_ne!(
    x.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
    y.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]
  );
  assert_eq!(
    Path::new(&x.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]),
    f.root.join("native/cred/james")
  );
  for key in ["projects", "skills", "settings.json"] {
    assert_eq!(
      std::fs::canonicalize(Path::new(&x.env["CLAUDE_CONFIG_DIR"]).join(key)).unwrap(),
      std::fs::canonicalize(Path::new(&y.env["CLAUDE_CONFIG_DIR"]).join(key)).unwrap()
    );
  }
  assert_eq!(x.env["FIXTURE_EXECUTABLE"], f.cli.to_string_lossy());
  assert_eq!(x.env["FIXTURE_PROFILE_ATTR"], a.id);
  assert_eq!(x.argv, vec![f.cli.to_string_lossy().into_owned()]);
  assert_eq!(x.remove_env, vec!["FIXTURE_TOKEN", "FIXTURE_API_KEY"]);
  assert!(x.resume && !x.rebind_between_calls);
  // A registered locator exists and is private; nothing was copied into it.
  let locator = f.root.join("native/cred/james");
  use std::os::unix::fs::PermissionsExt;
  assert_eq!(
    std::fs::metadata(&locator).unwrap().permissions().mode() & 0o777,
    0o700
  );
  assert_eq!(std::fs::read_dir(&locator).unwrap().count(), 0);
  // A customization that is not the shared one is refused, not replaced.
  let other = f
    .registry
    .root
    .join("fixture")
    .join(&a.id)
    .join("config/skills");
  std::fs::remove_file(&other).unwrap();
  std::fs::create_dir(&other).unwrap();
  assert!(f.provider.launch_for(&f.registry, &a).is_err());
}

/// An entry listed only in `create` is shared by every account: by the
/// first, which creates it, and by each later one, which finds it there.
fn a_created_shared_entry_is_linked_into_every_account() {
  for preexisting in [false, true] {
    let mut kind = claude_like("https://example.com/profile");
    kind.shared = Some(Shared {
      from: "{home}/.fixture".into(),
      names: vec![],
      create: vec!["projects".into()],
    });
    let f = Fixture::new(kind);
    let source = f.home.join(".fixture/projects");
    if preexisting {
      std::fs::create_dir_all(&source).unwrap();
    }
    let a = f.register("james");
    let b = f.register("moo");
    for profile in [&a, &b, &a] {
      let launch = f.provider.launch_for(&f.registry, profile).unwrap();
      let entry = Path::new(&launch.env["CLAUDE_CONFIG_DIR"]).join("projects");
      assert!(
        std::fs::symlink_metadata(&entry)
          .map(|m| m.file_type().is_symlink())
          .unwrap_or(false),
        "{} has no shared projects link (source existed first: {preexisting})",
        profile.alias
      );
      assert_eq!(
        std::fs::canonicalize(&entry).unwrap(),
        std::fs::canonicalize(&source).unwrap()
      );
    }
  }
}

fn the_legacy_table_imports_once_and_skips_unsafe_rows() {
  let f = Fixture::claude_like();
  std::fs::create_dir_all(f.root.join("native")).unwrap();
  std::fs::write(
    f.root.join("native/profiles.tsv"),
    "# email\talias\na@example.com\t@work\nb@example.com\tpersonal\nx/y\tbad\n..\tdots\nc@example.com\tno spaces\n",
  )
  .unwrap();
  let listed = f.run("discover", json!({})).unwrap();
  let aliases: Vec<&str> = listed["profiles"]
    .as_array()
    .unwrap()
    .iter()
    .map(|p| p["alias"].as_str().unwrap())
    .collect();
  assert_eq!(aliases, vec!["work", "personal"]);
  assert_eq!(
    listed["profiles"][0]["credential"],
    json!({"backend": "native", "locator": f.root.join("native/cred/a@example.com")})
  );
  let again = f.run("discover", json!({})).unwrap();
  assert_eq!(again["profiles"], listed["profiles"]);
  assert_eq!(f.registry.read().unwrap().profiles.len(), 2);
}

fn login_names_the_expected_account_and_binds_references() {
  let f = Fixture::claude_like();
  std::fs::create_dir_all(f.root.join("native")).unwrap();
  std::fs::write(f.root.join("native/profiles.tsv"), "a@example.com\twork\n").unwrap();
  f.run("discover", json!({})).unwrap();
  let work = f.registry.resolve("fixture", "work").unwrap();
  let plain = f.register("plain");
  let launch = f
    .block_on(f.provider.login(&f.registry, work.clone()))
    .unwrap();
  let cli = f.cli.to_string_lossy().into_owned();
  assert_eq!(
    launch.argv,
    vec![cli.as_str(), "auth", "login", "--email", "a@example.com"]
  );
  assert_eq!(launch.env[ENV_APP], "fixture");
  assert_eq!(launch.env[ENV_PROFILE_ID], work.id);
  assert!(launch.remove_env.iter().any(|k| k == ENV_CREDENTIAL_DIR));
  let launch = f.block_on(f.provider.login(&f.registry, plain)).unwrap();
  assert_eq!(launch.argv, vec![cli.as_str(), "auth", "login"]);
}

/// A raw pointer is a store key first; `@alias` explicitly selects an alias.
/// Reordering the table must never switch the default account.
fn a_default_pointer_prefers_a_key_over_another_rows_alias() {
  for rows in ["work\tpersonal\nother\twork\n", "other\twork\nwork\tpersonal\n"] {
    let mut kind = claude_like("https://identity.invalid/profile");
    kind.import.as_mut().unwrap().default_from = Some("{root}/active".into());
    let f = Fixture::new(kind);
    let root = f.root.join("native");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("profiles.tsv"), rows).unwrap();
    for (pointer, alias) in [("work\n", "personal"), ("@work", "work")] {
      std::fs::write(root.join("active"), pointer).unwrap();
      f.run("discover", json!({})).unwrap();
      assert_eq!(
        f.registry.default_for("fixture").unwrap().unwrap().alias,
        alias,
        "pointer {pointer:?}, table {rows:?}"
      );
    }
  }
}

/// Catalog credentials keep their location when the kind's root changes.
/// The diagnostic must describe the store the launch actually reads.
fn store_diagnostics_follow_the_profiles_saved_locator() {
  let mut f = Fixture::claude_like();
  let old = f.register("work");
  assert_eq!(
    f.provider.store_for(&old).unwrap().unwrap().root,
    f.root.join("native")
  );
  let new_root = f.root.join("new-store");
  f.provider.host.vars.insert(
    "FAKE_PROFILE_DIR".into(),
    new_root.to_string_lossy().into_owned(),
  );
  let launch = f.provider.launch_for(&f.registry, &old).unwrap();
  let actual = PathBuf::from(&launch.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]);
  let reported = f.provider.store_for(&old).unwrap().unwrap();
  assert_eq!(reported.root, actual, "diagnostic must name the saved location");
  assert_eq!(reported.source, "catalog profile locator");
  assert_eq!(reported.marker, None);
  let new = f.register("new");
  assert_eq!(f.provider.store_for(&new).unwrap().unwrap().root, new_root);
}

/// A kind whose own store does not exist yet adopts another store of the
/// same layout, and follows that store's pointer to its default account.
fn a_fallback_store_is_adopted_and_its_pointer_names_the_default() {
  let fallback_kind = |pointer: bool| {
    let mut kind = claude_like("https://identity.invalid/profile");
    let tento_secrets::accounts::kind::KindCredential::Native { root, .. } = &mut kind.credential
    else {
      unreachable!()
    };
    root.fallback = vec![Fallback {
      path: "{home}/.other/{app}-profiles".into(),
      marker: "profiles.tsv".into(),
    }];
    if pointer {
      kind.import.as_mut().unwrap().default_from = Some("{root}/active".into());
    }
    kind
  };
  let fixture = |pointer: bool| {
    let mut f = Fixture::new(fallback_kind(pointer));
    f.provider.host.vars.remove("FAKE_PROFILE_DIR");
    f
  };
  let own = |f: &Fixture| f.home.join(".local/share/fixture-profiles");
  let other = |f: &Fixture| f.home.join(".other/fixture-profiles");
  let locator = |p: &Profile| match &p.credential {
    CredentialRef::Native { locator } => locator.clone(),
    other => panic!("{other:?}"),
  };
  let default = |f: &Fixture| f.registry.default_for("fixture").unwrap().map(|p| p.alias);

  // A directory without the marker is not a store: the default root stays.
  let f = fixture(true);
  std::fs::create_dir_all(other(&f).join("cred")).unwrap();
  std::fs::write(other(&f).join("active"), "a@example.com").unwrap();
  assert_eq!(locator(&f.register("plain")), own(&f).join("cred/plain"));
  assert_eq!(default(&f), None);

  // With its marker, the other store is the root: its table is imported,
  // a new alias is registered in it, and its pointer names the default.
  let f = fixture(true);
  std::fs::create_dir_all(other(&f)).unwrap();
  std::fs::write(
    other(&f).join("profiles.tsv"),
    "# email\tnick\na@example.com\twork\nb@example.com\t@home\n",
  )
  .unwrap();
  let discover = |f: &Fixture| {
    f.run("discover", json!({})).unwrap()["profiles"]
      .as_array()
      .unwrap()
      .iter()
      .map(|p| p["alias"].as_str().unwrap().to_owned())
      .collect::<Vec<_>>()
  };
  assert_eq!(discover(&f), vec!["work", "home"]);
  assert_eq!(default(&f), None, "no pointer, no default");
  let work = f.registry.resolve("fixture", "work").unwrap();
  assert_eq!(locator(&work), other(&f).join("cred/a@example.com"));
  assert_eq!(locator(&f.register("new")), other(&f).join("cred/new"));
  assert!(!own(&f).exists(), "the default root was never created");
  for (pointer, want) in [
    ("b@example.com\n", Some("home")),
    ("@work", Some("work")),
    ("home", Some("home")),
    // Naming no row, or nothing, leaves the default where it was.
    ("nobody@example.com", Some("home")),
    ("@new", Some("home")),
    ("", Some("home")),
  ] {
    std::fs::write(other(&f).join("active"), pointer).unwrap();
    discover(&f);
    assert_eq!(default(&f).as_deref(), want, "pointer {pointer:?}");
  }
  std::fs::remove_file(other(&f).join("active")).unwrap();
  discover(&f);
  assert_eq!(default(&f).as_deref(), Some("home"), "a missing pointer");

  // Once the kind's own store exists, it is the root again.
  std::fs::create_dir_all(own(&f)).unwrap();
  assert_eq!(locator(&f.register("later")), own(&f).join("cred/later"));
  // And the variable wins over both.
  let mut f = fixture(true);
  std::fs::create_dir_all(other(&f)).unwrap();
  std::fs::write(other(&f).join("profiles.tsv"), "a@example.com\twork\n").unwrap();
  let named = f.root.join("named");
  f.provider.host.vars.insert(
    "FAKE_PROFILE_DIR".into(),
    named.to_string_lossy().into_owned(),
  );
  assert_eq!(locator(&f.register("x")), named.join("cred/x"));
  assert_eq!(
    discover(&f),
    vec!["x"],
    "the other store's table is not read"
  );

  // A kind that declares no pointer never sets a default.
  let f = fixture(false);
  std::fs::create_dir_all(other(&f)).unwrap();
  std::fs::write(other(&f).join("profiles.tsv"), "a@example.com\twork\n").unwrap();
  std::fs::write(other(&f).join("active"), "@work").unwrap();
  assert_eq!(discover(&f), vec!["work"]);
  assert_eq!(default(&f), None);
}

/// A fallback under `{secrets}` is tried under each secret-store base in the
/// store's order, and a base without the marker (a stale or empty one) is
/// passed over. Each choice says why it was made.
fn a_secrets_base_fallback_is_tried_under_each_base_in_order() {
  let fixture = || {
    let mut kind = claude_like("https://identity.invalid/profile");
    let tento_secrets::accounts::kind::KindCredential::Native { root, .. } = &mut kind.credential
    else {
      unreachable!()
    };
    root.fallback = vec![Fallback {
      path: "{secrets}/fixture-profiles".into(),
      marker: "profiles.tsv".into(),
    }];
    let mut f = Fixture::new(kind);
    f.provider.host.vars.remove("FAKE_PROFILE_DIR");
    f
  };
  let store = |base: &Path| {
    let store = base.join("fixture-profiles");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(store.join("profiles.tsv"), "a@example.com\twork\n").unwrap();
    store
  };
  let choice = |f: &Fixture| {
    let choice = f.provider.root_choice().unwrap().unwrap();
    (choice.root, choice.source, choice.marker)
  };
  let marker = Some("profiles.tsv".to_string());

  // No store anywhere: the default root, not created.
  let f = fixture();
  let own = f.home.join(".local/share/fixture-profiles");
  assert_eq!(
    choice(&f),
    (own.clone(), "default root (no store yet)".into(), None)
  );

  // A stale neutral base (the catalog lives there, no store) is passed
  // over for the legacy base that has one.
  std::fs::create_dir_all(f.home.join(".local/share/tsh/secrets/profiles")).unwrap();
  let legacy = store(&f.home.join(".local/share/lona/secrets"));
  assert_eq!(
    choice(&f),
    (
      legacy.clone(),
      "fallback in the legacy secrets base".into(),
      marker.clone()
    )
  );
  let listed = f.run("discover", json!({})).unwrap();
  assert_eq!(
    listed["profiles"][0]["credential"]["locator"],
    json!(legacy.join("cred/a@example.com"))
  );

  // TSH_SECRETS_DIR comes first, but only when it holds a store.
  let mut f = f;
  let named = f.root.join("named-secrets");
  std::fs::create_dir_all(&named).unwrap();
  f.provider.host.vars.insert(
    "TSH_SECRETS_DIR".into(),
    named.to_string_lossy().into_owned(),
  );
  assert_eq!(choice(&f).0, legacy, "a base without the marker is skipped");
  let named_store = store(&named);
  assert_eq!(
    choice(&f),
    (
      named_store,
      "fallback in the TSH_SECRETS_DIR".into(),
      marker.clone()
    )
  );

  // The kind's own root, once it exists, and its variable, win outright.
  std::fs::create_dir_all(&own).unwrap();
  assert_eq!(choice(&f), (own.clone(), "default root".into(), None));
  let elsewhere = f.root.join("elsewhere");
  f.provider.host.vars.insert(
    "FAKE_PROFILE_DIR".into(),
    elsewhere.to_string_lossy().into_owned(),
  );
  assert_eq!(
    choice(&f),
    (elsewhere, "variable FAKE_PROFILE_DIR".into(), None)
  );
}

/// Every file under `root` with its bytes and modification time.
fn file_states(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
  let mut out = BTreeMap::new();
  let mut stack = vec![root.to_path_buf()];
  while let Some(path) = stack.pop() {
    let meta = std::fs::symlink_metadata(&path).unwrap();
    if meta.is_dir() {
      for entry in std::fs::read_dir(&path).unwrap() {
        stack.push(entry.unwrap().path());
      }
    }
    let bytes = if meta.is_file() {
      std::fs::read(&path).unwrap()
    } else {
      Vec::new()
    };
    out.insert(path, (bytes, meta.modified().unwrap()));
  }
  out
}

fn with_native(url: &str) -> Fixture {
  let mut kind = claude_like(url);
  kind.import.as_mut().unwrap().native = Some(
    serde_json::from_value(json!({
      "locator": "{home}/.fixture",
      "present": ["{home}/.fixture.json"],
      "alias_from": {"file": "{home}/.fixture.json", "json_pointer": "/oauthAccount/emailAddress"},
      "default_alias": "default",
      "unset_env": ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
      "secret": {"keychain_service": "Fixture-credentials", "file": "{locator}/.credentials.json", "json_pointer": "/oauth/accessToken"}
    }))
    .unwrap(),
  );
  let mut f = Fixture::new(kind);
  f.provider.host.vars.remove("FAKE_PROFILE_DIR");
  f
}

/// With no store anywhere, the app's own login is imported as the default
/// profile, and using it leaves the app's files exactly as they were.
fn the_apps_own_login_is_imported_without_touching_it() {
  let server = endpoint(
    200,
    json!({"account": {"uuid": "acct-own", "email": "james.kao@example.com"}}),
  );
  let f = with_native(&server.url);
  let own = f.home.join(".fixture");
  // Never used: nothing to import.
  assert_eq!(f.run("discover", json!({})).unwrap()["profiles"], json!([]));

  std::fs::create_dir_all(own.join("projects")).unwrap();
  std::fs::write(own.join("settings.json"), "{}").unwrap();
  std::fs::write(
    own.join(".credentials.json"),
    r#"{"oauth":{"accessToken":"SENTINEL_OWN"}}"#,
  )
  .unwrap();
  std::fs::write(
    f.home.join(".fixture.json"),
    r#"{"oauthAccount":{"emailAddress":"james.kao@example.com"},"numStartups":3}"#,
  )
  .unwrap();
  let before = (
    file_states(&own),
    file_states(&f.home.join(".fixture.json")),
  );

  let listed = f.run("discover", json!({})).unwrap();
  assert_eq!(listed["profiles"].as_array().unwrap().len(), 1, "{listed}");
  assert_eq!(listed["profiles"][0]["alias"], "james-kao");
  assert_eq!(
    listed["profiles"][0]["credential"],
    json!({"backend": "native", "locator": own})
  );
  let profile = f.registry.resolve("fixture", "james-kao").unwrap();
  assert_eq!(
    f.registry.default_for("fixture").unwrap().map(|p| p.id),
    Some(profile.id.clone()),
    "the app's own login is the default"
  );
  assert_eq!(
    f.provider.store_for(&profile).unwrap().unwrap(),
    auth::StoreChoice {
      root: own.clone(),
      source: "native login".into(),
      marker: None
    }
  );

  // Its launch is the app on its own configuration.
  let launch = f.provider.launch_for(&f.registry, &profile).unwrap();
  assert!(!launch.env.contains_key("CLAUDE_CONFIG_DIR"), "{launch:?}");
  assert!(!launch.env.contains_key("CLAUDE_SECURESTORAGE_CONFIG_DIR"));
  for key in ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] {
    assert!(launch.remove_env.iter().any(|k| k == key), "{key} removed");
  }
  assert_eq!(launch.env["FIXTURE_PROFILE_ATTR"], profile.id);
  assert!(
    !f.registry.root.join("fixture").join(&profile.id).exists(),
    "no per-account directory"
  );

  // Signing in is checked against the app's own secret; the account named.
  signed_in(&f);
  let binding = f
    .block_on(
      f.provider
        .prepare(&f.registry, profile.clone(), None, &f.root, BTreeMap::new()),
    )
    .unwrap();
  assert_eq!(
    binding.profile.identity.unwrap().label,
    "james.kao@example.com"
  );
  assert!(
    server
      .seen
      .lock()
      .unwrap()
      .join("\n")
      .contains("Authorization: Bearer SENTINEL_OWN")
  );
  let login = f
    .block_on(f.provider.login(&f.registry, profile.clone()))
    .unwrap();
  assert!(!login.env.contains_key("CLAUDE_CONFIG_DIR"));

  // Imported once: a later discovery, even under another cached name, adds
  // nothing, and an account added later does not take the default.
  std::fs::write(
    f.home.join(".fixture.json"),
    r#"{"oauthAccount":{"emailAddress":"other@example.com"}}"#,
  )
  .unwrap();
  let work = f.register("work");
  f.run("discover", json!({})).unwrap();
  let catalog = f.registry.read().unwrap();
  assert_eq!(catalog.profiles.len(), 2);
  assert_eq!(
    f.registry.default_for("fixture").unwrap().map(|p| p.id),
    Some(profile.id.clone())
  );
  f.registry.set_default(&work).unwrap();
  f.run("discover", json!({})).unwrap();
  assert_eq!(
    f.registry.default_for("fixture").unwrap().map(|p| p.id),
    Some(work.id),
    "a chosen default stays"
  );
  std::fs::write(
    f.home.join(".fixture.json"),
    r#"{"oauthAccount":{"emailAddress":"james.kao@example.com"},"numStartups":3}"#,
  )
  .unwrap();
  // Byte for byte, and not one modification time moved, except the file
  // this test itself rewrote.
  assert_eq!(file_states(&own), before.0, "the app's own directory");
  assert_eq!(
    std::fs::read(f.home.join(".fixture.json")).unwrap(),
    before.1.values().next().unwrap().0
  );

  // A name that is taken, or none, falls back to the default alias; a
  // store with a table imports no native login at all.
  let f = with_native("https://identity.invalid/profile");
  std::fs::create_dir_all(f.home.join(".fixture")).unwrap();
  std::fs::write(f.home.join(".fixture.json"), "{}").unwrap();
  assert_eq!(
    f.run("discover", json!({})).unwrap()["profiles"][0]["alias"],
    "default"
  );
  assert_eq!(
    f.registry.default_for("fixture").unwrap().map(|p| p.alias),
    None,
    "no cached account (no real sign-in): imported, not the default"
  );
  let f = with_native("https://identity.invalid/profile");
  std::fs::write(
    f.home.join(".fixture.json"),
    r#"{"oauthAccount":{"emailAddress":"work@example.com"}}"#,
  )
  .unwrap();
  f.register("work");
  f.run("discover", json!({})).unwrap();
  assert!(
    f.registry.resolve("fixture", "default").is_ok(),
    "work is taken"
  );
  let f = with_native("https://identity.invalid/profile");
  std::fs::write(f.home.join(".fixture.json"), "{}").unwrap();
  let own_root = f.home.join(".local/share/fixture-profiles");
  std::fs::create_dir_all(&own_root).unwrap();
  std::fs::write(own_root.join("profiles.tsv"), "a@example.com\twork\n").unwrap();
  let listed = f.run("discover", json!({})).unwrap();
  assert_eq!(listed["profiles"].as_array().unwrap().len(), 1);
  assert_eq!(listed["profiles"][0]["alias"], "work");
}

/// The app's own login is the user's own: its identity check never blocks
/// it. Whatever the check cannot confirm, the launch is the app as it is,
/// and the profile stays unverified; a named profile stays strict.
fn the_apps_own_login_is_never_blocked_by_its_identity_check() {
  let native = |url: &str, status: Option<&str>, token: Option<&str>| {
    let f = with_native(url);
    let own = f.home.join(".fixture");
    std::fs::create_dir_all(&own).unwrap();
    std::fs::write(
      f.home.join(".fixture.json"),
      r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#,
    )
    .unwrap();
    if let Some(token) = token {
      std::fs::write(
        own.join(".credentials.json"),
        format!(r#"{{"oauth":{{"accessToken":"{token}"}}}}"#),
      )
      .unwrap();
    }
    if let Some(status) = status {
      std::fs::write(f.cli.parent().unwrap().join("status.json"), status).unwrap();
    }
    f.run("discover", json!({})).unwrap();
    let profile = f.registry.resolve("fixture", "me").unwrap();
    (f, profile)
  };
  let prepare = |f: &Fixture, profile: &Profile| {
    f.block_on(
      f.provider
        .prepare(&f.registry, profile.clone(), None, &f.root, BTreeMap::new()),
    )
  };
  let signed_in = Some(r#"{"loggedIn":true,"authMethod":"claude.ai"}"#);
  let offline = {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    format!(
      "http://127.0.0.1:{}/profile",
      listener.local_addr().unwrap().port()
    )
  };
  for (what, url, status, token) in [
    ("offline", offline.as_str(), signed_in, Some("T")),
    (
      "a key login",
      "https://identity.invalid/profile",
      Some(r#"{"loggedIn":true,"authMethod":"api_key"}"#),
      None,
    ),
    (
      "not signed in",
      "https://identity.invalid/profile",
      None,
      None,
    ),
    ("no token", offline.as_str(), signed_in, None),
  ] {
    let (f, profile) = native(url, status, token);
    let binding = prepare(&f, &profile).unwrap_or_else(|e| panic!("{what}: blocked: {e:#}"));
    assert!(
      !binding.launch.env.contains_key("CLAUDE_CONFIG_DIR"),
      "{what}: the app as it is"
    );
    assert_eq!(binding.profile.identity, None, "{what}");
    assert_eq!(binding.profile.state, AuthState::Unverified, "{what}");
    // The wire answer carries the launch and no error.
    let reply = f.run("prepare", json!({"profile": profile})).unwrap();
    assert_eq!(reply["error"], json!(null), "{what}: {reply}");
    assert!(reply["launch"].is_object(), "{what}");
  }

  // Another account than the cache names: reported, not recorded, not
  // blocking. The cached account itself is confirmed.
  let server = endpoint(
    200,
    json!({"account": {"uuid": "acct-other", "email": "other@example.com"}}),
  );
  let (f, profile) = native(&server.url, signed_in, Some("T"));
  let binding = prepare(&f, &profile).unwrap();
  assert_eq!(binding.profile.identity, None, "a mismatch is not recorded");
  assert_eq!(binding.profile.state, AuthState::Unverified);
  let server = endpoint(
    200,
    json!({"account": {"uuid": "acct-me", "email": "Me@Example.com"}}),
  );
  let (f, profile) = native(&server.url, signed_in, Some("T"));
  let binding = prepare(&f, &profile).unwrap();
  assert_eq!(binding.profile.identity.unwrap().id, "acct-me");
  assert_eq!(binding.profile.state, AuthState::Ready);

  // A named profile keeps the strict check.
  let work = f.register("work");
  let error = prepare(&f, &work).unwrap_err().to_string();
  assert!(error.contains("Sign in required"), "{error}");

  // A missing keychain item falls through to the app's own file.
  let server = endpoint(
    200,
    json!({"account": {"uuid": "acct-me", "email": "me@example.com"}}),
  );
  let (mut f, profile) = native(&server.url, signed_in, Some("FROM_FILE"));
  let bin = f.cli.parent().unwrap().to_path_buf();
  f.provider.host.keychain = Some(bin.join("security"));
  let binding = prepare(&f, &profile).unwrap();
  assert_eq!(binding.profile.state, AuthState::Ready);
  let asked = std::fs::read_to_string(bin.join("security.log")).unwrap();
  assert!(asked.contains("|Fixture-credentials\n"), "{asked}");
  assert!(
    server
      .seen
      .lock()
      .unwrap()
      .join("\n")
      .contains("Authorization: Bearer FROM_FILE")
  );
}

/// What the app sees when the shell starts `launch` from `parent`: the
/// launch's variables set, then its `remove_env` removed, exactly as the
/// shell applies a binding. The fake app reports its own environment.
fn launched_env(
  cli: &Path,
  launch: &Launch,
  parent: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
  let mut cmd = std::process::Command::new(cli);
  cmd
    .arg("env-dump")
    .env_clear()
    .envs(parent)
    .envs(&launch.env);
  for key in &launch.remove_env {
    cmd.env_remove(key);
  }
  let out = cmd.output().unwrap();
  assert!(out.status.success());
  serde_json::from_slice(&out.stdout).unwrap()
}

/// A native fixture whose app has been used and cached `me@example.com`,
/// discovered: its own login, profile `@me`.
fn native_me(url: &str) -> (Fixture, Profile) {
  let f = with_native(url);
  std::fs::create_dir_all(f.home.join(".fixture")).unwrap();
  cache_account(&f, "me@example.com");
  f.run("discover", json!({})).unwrap();
  let profile = f.registry.resolve("fixture", "me").unwrap();
  (f, profile)
}

fn cache_account(f: &Fixture, email: &str) {
  std::fs::write(
    f.home.join(".fixture.json"),
    json!({"oauthAccount": {"emailAddress": email}}).to_string(),
  )
  .unwrap();
}

fn native_token(f: &Fixture, token: &str) {
  std::fs::write(
    f.home.join(".fixture/.credentials.json"),
    json!({"oauth": {"accessToken": token}}).to_string(),
  )
  .unwrap();
}

fn point_at(f: &mut Fixture, url: &str) {
  f.provider
    .kind
    .verify
    .as_mut()
    .unwrap()
    .http
    .as_mut()
    .unwrap()
    .url = url.into();
}

/// The profile as the catalog now has it.
fn stored(f: &Fixture, profile: &Profile) -> Profile {
  f.registry.resolve("fixture", &profile.id).unwrap()
}

/// Codex review probe K1, kept as a regression: a native profile confirmed
/// `Ready`, then signed out, launches unverified, and the launch does not
/// carry the earlier account as its identity.
fn codex_probe_k1_a_signed_out_native_login_is_demoted() {
  let server = endpoint(
    200,
    json!({"account": {"uuid": "acct-me", "email": "me@example.com"}}),
  );
  let (f, profile) = native_me(&server.url);
  native_token(&f, "REVIEW_FIXTURE");
  signed_in(&f);
  let prepare = || {
    f.block_on(
      f.provider
        .prepare(&f.registry, profile.clone(), None, &f.root, BTreeMap::new()),
    )
    .unwrap()
  };
  assert_eq!(prepare().profile.state, AuthState::Ready);
  std::fs::remove_file(f.cli.parent().unwrap().join("status.json")).unwrap();
  let after = prepare();
  assert_eq!(after.profile.state, AuthState::Unverified);
  assert_eq!(
    after.profile.identity, None,
    "the old account is not presented"
  );
  let kept = stored(&f, &profile);
  assert_eq!(kept.state, AuthState::Unverified);
  assert_eq!(
    kept.identity.map(|i| i.id).as_deref(),
    Some("acct-me"),
    "the catalog keeps the binding"
  );
}

/// Codex review probe K2, kept as a regression: an API-key helper in the
/// app's own settings does not block its own login's lane.
fn codex_probe_k2_a_native_key_helper_does_not_block() {
  let (f, profile) = native_me("http://127.0.0.1:9/profile");
  std::fs::write(
    f.home.join(".fixture/settings.json"),
    r#"{"apiKeyHelper":"printf fixture"}"#,
  )
  .unwrap();
  let binding = f
    .block_on(
      f.provider
        .prepare(&f.registry, profile, None, &f.root, BTreeMap::new()),
    )
    .unwrap_or_else(|e| panic!("blocked: {e:#}"));
  assert_eq!(binding.profile.state, AuthState::Unverified);
  assert!(!binding.launch.env.contains_key("CLAUDE_CONFIG_DIR"));
}

/// From an already-confirmed native profile, every way re-verification can
/// fail (signed out, a key login, a token for another account than the
/// app's cache, an account the catalog is not bound to) demotes it for that
/// launch: unverified, no identity presented, never blocked. Signing back in
/// to the bound account makes it `Ready` again; another account is never
/// accepted as this profile. A named profile stays strict.
fn a_confirmed_native_login_is_demoted_when_reverification_fails() {
  let me = endpoint(
    200,
    json!({"account": {"uuid": "acct-me", "email": "me@example.com"}}),
  );
  let other = endpoint(
    200,
    json!({"account": {"uuid": "acct-other", "email": "other@example.com"}}),
  );
  let (mut f, profile) = native_me(&me.url);
  native_token(&f, "T");
  let status = f.cli.parent().unwrap().join("status.json");
  let prepare = |f: &Fixture| {
    f.block_on(
      f.provider
        .prepare(&f.registry, profile.clone(), None, &f.root, BTreeMap::new()),
    )
    .unwrap_or_else(|e| panic!("blocked: {e:#}"))
  };
  let bound = Identity {
    id: "acct-me".into(),
    label: "me@example.com".into(),
  };
  let confirm = |f: &mut Fixture| {
    point_at(f, &me.url);
    cache_account(f, "me@example.com");
    signed_in(f);
    let binding = prepare(f);
    assert_eq!(binding.profile.state, AuthState::Ready);
    assert_eq!(binding.profile.identity.as_ref(), Some(&bound));
    assert_eq!(stored(f, &profile).state, AuthState::Ready);
  };
  // `found`: the account the check found, which the wire reply names when
  // only the catalog's binding refuses it (the shell confirms, not the kind).
  let demoted = |f: &Fixture, what: &str, found: Option<&str>| {
    let binding = prepare(f);
    assert_eq!(binding.profile.state, AuthState::Unverified, "{what}");
    assert_eq!(
      binding.profile.identity, None,
      "{what}: no identity presented"
    );
    assert!(
      !binding.launch.env.contains_key("CLAUDE_CONFIG_DIR"),
      "{what}: the app as it is"
    );
    let kept = stored(f, &profile);
    assert_eq!(kept.state, AuthState::Unverified, "{what}: catalog demoted");
    assert_eq!(
      kept.identity.as_ref(),
      Some(&bound),
      "{what}: the binding stays"
    );
    // The wire answer carries no error, and no identity the kind could not
    // stand behind.
    let reply = f.run("prepare", json!({"profile": profile})).unwrap();
    assert_eq!(reply["error"], json!(null), "{what}: {reply}");
    assert_eq!(reply["identity"]["id"].as_str(), found, "{what}: {reply}");
  };

  confirm(&mut f);
  std::fs::remove_file(&status).unwrap();
  demoted(&f, "signed out", None);

  confirm(&mut f);
  std::fs::write(&status, r#"{"loggedIn":true,"authMethod":"api_key"}"#).unwrap();
  demoted(&f, "a key login", None);

  confirm(&mut f);
  point_at(&mut f, &other.url);
  demoted(&f, "a token for another account than the cache names", None);

  confirm(&mut f);
  point_at(&mut f, &other.url);
  cache_account(&f, "other@example.com");
  demoted(
    &f,
    "an account change the catalog is not bound to",
    Some("acct-other"),
  );
  // Still not accepted on a second look.
  demoted(&f, "the same account change again", Some("acct-other"));

  // Back on the bound account, it is confirmed again.
  confirm(&mut f);

  // A named profile, confirmed and then signed out, stays strict.
  std::fs::create_dir_all(f.root.join("native/cred/me@example.com")).unwrap();
  std::fs::write(
    f.root.join("native/cred/me@example.com/.credentials.json"),
    r#"{"oauth":{"accessToken":"N"}}"#,
  )
  .unwrap();
  let named = f
    .registry
    .register(
      "fixture",
      "named",
      CredentialRef::Native {
        locator: f.root.join("native/cred/me@example.com"),
      },
    )
    .unwrap();
  let prepare_named = |f: &Fixture| {
    f.block_on(
      f.provider
        .prepare(&f.registry, named.clone(), None, &f.root, BTreeMap::new()),
    )
  };
  assert_eq!(prepare_named(&f).unwrap().profile.state, AuthState::Ready);
  std::fs::remove_file(&status).unwrap();
  let error = prepare_named(&f).unwrap_err().to_string();
  assert!(error.contains("Sign in required"), "{error}");
  signed_in(&f);
  point_at(&mut f, &other.url);
  let error = format!("{:#}", prepare_named(&f).unwrap_err());
  assert!(error.contains("mismatch"), "{error}");
}

/// The app's own login keeps its own authentication: an API-key helper in
/// its settings (user or project) does not block its lane, and the
/// authentication it inherits (a key, a token) reaches the app, while the
/// variables that would move it onto another account's store are removed.
/// A named profile keeps both the guards and the isolation.
fn the_apps_own_login_keeps_its_own_authentication() {
  let (mut f, profile) = native_me("http://127.0.0.1:9/profile");
  let parent = BTreeMap::from([
    ("HOME".to_string(), f.home.to_string_lossy().into_owned()),
    ("PATH".to_string(), "/usr/bin:/bin".to_string()),
    ("FIXTURE_TOKEN".to_string(), "inherited-token".to_string()),
    ("FIXTURE_API_KEY".to_string(), "inherited-key".to_string()),
    (
      "CLAUDE_CONFIG_DIR".to_string(),
      "/another/config".to_string(),
    ),
    (
      "CLAUDE_SECURESTORAGE_CONFIG_DIR".to_string(),
      "/another/store".to_string(),
    ),
  ]);
  // The app is authenticated by what it inherits: its probes see it too.
  f.provider.host.child_env = Some(parent.clone());
  std::fs::write(
    f.home.join(".fixture/settings.json"),
    r#"{"apiKeyHelper":"printf fixture","env":{"FIXTURE_TOKEN":"from-settings"}}"#,
  )
  .unwrap();
  let project = f.root.join("project");
  std::fs::create_dir_all(project.join(".fixture")).unwrap();
  std::fs::write(
    project.join(".fixture/settings.local.json"),
    r#"{"apiKeyHelper":"printf project"}"#,
  )
  .unwrap();
  std::fs::write(
    f.cli.parent().unwrap().join("status.json"),
    r#"{"loggedIn":true,"authMethod":"api_key"}"#,
  )
  .unwrap();

  let binding = f
    .block_on(f.provider.prepare(
      &f.registry,
      profile.clone(),
      None,
      &project,
      BTreeMap::new(),
    ))
    .unwrap_or_else(|e| panic!("a key login in its own settings blocked: {e:#}"));
  assert_eq!(binding.profile.state, AuthState::Unverified);
  assert_eq!(
    binding.launch.remove_env,
    vec![
      "CLAUDE_CONFIG_DIR".to_string(),
      "CLAUDE_SECURESTORAGE_CONFIG_DIR".to_string(),
      ENV_CREDENTIAL_DIR.to_string(),
    ],
    "exactly the isolation variables"
  );
  let seen = launched_env(&f.cli, &binding.launch, &parent);
  assert_eq!(seen["FIXTURE_TOKEN"], "inherited-token");
  assert_eq!(seen["FIXTURE_API_KEY"], "inherited-key");
  for key in ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] {
    assert!(!seen.contains_key(key), "{key} reached the app");
  }
  assert_eq!(seen[ENV_APP], "fixture");
  assert_eq!(seen[ENV_PROFILE_ID], profile.id);
  // The wire answer too.
  let reply = f
    .run("prepare", json!({"profile": profile, "cwd": project}))
    .unwrap();
  assert_eq!(reply["error"], json!(null), "{reply}");

  // A named profile: the same settings are an override, and the same
  // inherited authentication never reaches its app.
  let work = f.register("work");
  let error = f
    .block_on(
      f.provider
        .prepare(&f.registry, work.clone(), None, &project, BTreeMap::new()),
    )
    .unwrap_err();
  assert!(
    format!("{error:#}").contains("override the selected login"),
    "{error:#}"
  );
  let launch = f.provider.launch_for(&f.registry, &work).unwrap();
  let seen = launched_env(&f.cli, &launch, &parent);
  for key in ["FIXTURE_TOKEN", "FIXTURE_API_KEY"] {
    assert!(!seen.contains_key(key), "{key} reached a named account");
  }
  assert_ne!(
    seen.get("CLAUDE_CONFIG_DIR").map(String::as_str),
    Some("/another/config")
  );
}

// --- identity ------------------------------------------------------------------

fn signed_in(f: &Fixture) {
  std::fs::write(
    f.cli.parent().unwrap().join("status.json"),
    r#"{"loggedIn":true,"authMethod":"claude.ai"}"#,
  )
  .unwrap();
}

fn with_url(url: &str) -> Fixture {
  Fixture::new(claude_like(url))
}

fn the_identity_endpoint_gets_the_bearer_on_stdin_and_names_the_account() {
  let server = endpoint(
    200,
    json!({"account": {"uuid": "acct-1", "email": "A@Example.com"}}),
  );
  let f = with_url(&server.url);
  signed_in(&f);
  std::fs::create_dir_all(f.root.join("native")).unwrap();
  std::fs::write(f.root.join("native/profiles.tsv"), "a@example.com\twork\n").unwrap();
  f.run("discover", json!({})).unwrap();
  let work = f.registry.resolve("fixture", "work").unwrap();
  let CredentialRef::Native { locator } = &work.credential else {
    panic!("native")
  };
  std::fs::create_dir_all(locator).unwrap();
  std::fs::write(
    locator.join(".credentials.json"),
    r#"{"oauth":{"accessToken":"SENTINEL_BEARER"}}"#,
  )
  .unwrap();
  let binding = f
    .block_on(
      f.provider
        .prepare(&f.registry, work.clone(), None, &f.root, BTreeMap::new()),
    )
    .unwrap();
  let identity = binding.profile.identity.clone().unwrap();
  assert_eq!(
    (identity.id.as_str(), identity.label.as_str()),
    ("acct-1", "A@Example.com")
  );
  assert_eq!(binding.profile.state, AuthState::Ready);
  let seen = server.seen.lock().unwrap().join("\n");
  assert!(
    seen.contains("Authorization: Bearer SENTINEL_BEARER"),
    "{seen}"
  );
  // The request argv never carries the credential.
  let argv = auth::kind::identity_argv(&server.url).unwrap();
  assert!(!argv.iter().any(|a| a.contains("SENTINEL")));
  assert!(argv.windows(2).any(|w| w == ["--header", "@-"]));
  // Neither the catalog nor the launch carries it.
  let catalog = std::fs::read_to_string(f.registry.root.join("catalog.json")).unwrap();
  assert!(!catalog.contains("SENTINEL"));
  assert!(
    !serde_json::to_string(&binding.launch)
      .unwrap()
      .contains("SENTINEL")
  );
}

fn a_login_into_another_account_is_a_mismatch() {
  let server = endpoint(
    200,
    json!({"account": {"uuid": "acct-2", "email": "other@example.com"}}),
  );
  let f = with_url(&server.url);
  signed_in(&f);
  std::fs::create_dir_all(f.root.join("native/cred/a@example.com")).unwrap();
  std::fs::write(f.root.join("native/profiles.tsv"), "a@example.com\twork\n").unwrap();
  std::fs::write(
    f.root.join("native/cred/a@example.com/.credentials.json"),
    r#"{"oauth":{"accessToken":"t"}}"#,
  )
  .unwrap();
  f.run("discover", json!({})).unwrap();
  let work = f.registry.resolve("fixture", "work").unwrap();
  let reply = f.run("prepare", json!({"profile": work})).unwrap();
  assert_eq!(reply["error"], "identity_mismatch");
  let error = f
    .block_on(
      f.provider
        .prepare(&f.registry, work, None, &f.root, BTreeMap::new()),
    )
    .unwrap_err();
  assert!(format!("{error:#}").contains("identity mismatch"));
}

fn an_unauthorized_bearer_or_a_missing_credential_needs_sign_in() {
  let server = endpoint(401, json!({}));
  let f = with_url(&server.url);
  signed_in(&f);
  let alice = f.register("alice");
  // No credential file at all.
  assert_eq!(
    f.run("prepare", json!({"profile": alice})).unwrap()["error"],
    "login_required"
  );
  std::fs::write(
    f.root.join("native/cred/alice/.credentials.json"),
    r#"{"oauth":{"accessToken":"t"}}"#,
  )
  .unwrap();
  assert_eq!(
    f.run("prepare", json!({"profile": alice})).unwrap()["error"],
    "login_required"
  );
  // Through the provider surface, the catalog records it.
  let error = f
    .block_on(
      f.provider
        .prepare(&f.registry, alice.clone(), None, &f.root, BTreeMap::new()),
    )
    .unwrap_err();
  assert!(format!("{error:#}").contains("Sign in required"));
  assert_eq!(
    f.registry.resolve("fixture", "alice").unwrap().state,
    AuthState::LoginRequired
  );
  // A signed-out CLI never reaches the endpoint.
  std::fs::remove_file(f.cli.parent().unwrap().join("status.json")).unwrap();
  let before = server.seen.lock().unwrap().len();
  assert_eq!(
    f.run("prepare", json!({"profile": alice})).unwrap()["error"],
    "login_required"
  );
  assert_eq!(server.seen.lock().unwrap().len(), before);
}

fn the_keychain_item_wins_over_the_file_and_is_asked_for_by_service() {
  let server = endpoint(
    200,
    json!({"account": {"uuid": "acct-k", "email": "k@example.com"}}),
  );
  let mut f = with_url(&server.url);
  signed_in(&f);
  let bin = f.cli.parent().unwrap().to_path_buf();
  f.provider.host.keychain = Some(bin.join("security"));
  let alice = f.register("alice");
  let CredentialRef::Native { locator } = &alice.credential else {
    panic!("native")
  };
  let service = {
    use sha2::{Digest, Sha256};
    format!(
      "Fixture-credentials-{}",
      &hex::encode(Sha256::digest(locator.to_string_lossy().as_bytes()))[..8]
    )
  };
  std::fs::write(
    bin.join("keychain").join(&service),
    r#"{"oauth":{"accessToken":"FROM_KEYCHAIN"}}"#,
  )
  .unwrap();
  std::fs::write(
    locator.join(".credentials.json"),
    r#"{"oauth":{"accessToken":"FROM_FILE"}}"#,
  )
  .unwrap();
  let reply = f.run("prepare", json!({"profile": alice})).unwrap();
  assert_eq!(reply["identity"]["id"], "acct-k", "{reply}");
  let seen = server.seen.lock().unwrap().join("\n");
  assert!(seen.contains("Bearer FROM_KEYCHAIN"), "{seen}");
  let log = std::fs::read_to_string(bin.join("security.log")).unwrap();
  assert_eq!(log.trim(), format!("fixture-user|{service}"));
  // No keychain item: the file is read instead.
  std::fs::remove_file(bin.join("keychain").join(&service)).unwrap();
  f.run("prepare", json!({"profile": alice})).unwrap();
  assert!(
    server
      .seen
      .lock()
      .unwrap()
      .join("\n")
      .contains("Bearer FROM_FILE")
  );
}

fn plain_http_is_refused_off_loopback() {
  assert!(auth::kind::identity_argv("http://example.com/profile").is_err());
  assert!(auth::kind::identity_argv("https://example.com/profile").is_ok());
  assert!(auth::kind::identity_argv("http://127.0.0.1:9/profile").is_ok());
  assert!(auth::kind::identity_argv("http://127.0.0.1.example.com/").is_err());
}

/// URLs whose real host is not what a prefix check would read, or that a
/// URL parser and curl could read differently. None may carry the bearer.
const DECEPTIVE: &[&str] = &[
  // Userinfo: the "loopback" is a user name, the host is remote.
  "http://127.0.0.1:80@example.invalid/identity",
  "http://127.0.0.1@example.invalid/identity",
  "http://localhost:80@example.invalid/identity",
  "http://localhost@example.invalid/identity",
  "http://[::1]:80@example.invalid/identity",
  "http://[::1]@example.invalid/identity",
  "http://user:pass@127.0.0.1/identity",
  "http://@127.0.0.1/identity",
  "https://user@example.com/identity",
  "https://127.0.0.1:443@example.com/identity",
  // A loopback name as a prefix of a remote one.
  "http://localhost.evil/identity",
  "http://localhost.evil:80/identity",
  "http://127.0.0.1.evil/identity",
  "http://127.0.0.1.example.com/",
  "http://localhost./identity",
  "http://localhostevil/identity",
  // Encoded and ambiguous forms.
  "http://127.0.0.1%40example.invalid/identity",
  "http://127.0.0.1:80%40example.invalid/identity",
  "http://127%2e0%2e0%2e1/identity",
  "http://%6c%6fcalhost/identity",
  "http://localhost%2eevil/identity",
  "http://127.0.0.1\\@example.invalid/identity",
  "http://127.0.0.1\\.example.invalid/identity",
  "http://127.0.0.1 @example.invalid/identity",
  "http://127.0.0.1\t@example.invalid/identity",
  "http://0177.0.0.1/identity",
  "http://2130706433/identity",
  "http://127.1/identity",
  "http://[::ffff:7f00:1]/identity",
  "http://[::1%25lo0]/identity",
  "http://127.0.0.1:80:81/identity",
  "http://127.0.0.1:/identity",
  "http://127.0.0.1:99999/identity",
  // Not HTTP(S), or no host at all.
  "HTTP://example.com/identity",
  "ftp://127.0.0.1/identity",
  "http:/127.0.0.1/identity",
  "http:///identity",
  "http://:80/identity",
  "https:///identity",
  "https://exa mple.com/identity",
];

/// Genuine loopback HTTP and HTTPS, with the protocol curl is limited to.
const GENUINE: &[(&str, &str)] = &[
  ("http://127.0.0.1:8080/identity", "=http"),
  ("http://127.0.0.1/identity", "=http"),
  ("http://127.0.0.1", "=http"),
  ("http://127.1.2.3:9/identity?x=1", "=http"),
  ("http://[::1]:8080/identity", "=http"),
  ("http://[::1]/identity", "=http"),
  ("http://localhost:8080/identity", "=http"),
  ("http://localhost/identity#top", "=http"),
  ("https://example.com/identity", "=https"),
  ("https://api.example.com:8443/v1/me?fields=email", "=https"),
  ("https://127.0.0.1/identity", "=https"),
  ("https://[2001:db8::1]:8443/identity", "=https"),
];

/// A fixture signed in with a native credential file, whose curl is the
/// recording fake.
fn with_fake_curl(url: &str) -> (Fixture, Profile, PathBuf) {
  let mut f = with_url(url);
  signed_in(&f);
  let bin = f.cli.parent().unwrap().to_path_buf();
  f.provider.host.curl = bin.join("curl");
  let alice = f.register("alice");
  let CredentialRef::Native { locator } = &alice.credential else {
    panic!("native")
  };
  std::fs::write(
    locator.join(".credentials.json"),
    r#"{"oauth":{"accessToken":"DECEPTIVE_BEARER"}}"#,
  )
  .unwrap();
  (f, alice, bin.join("curl.log"))
}

fn a_deceptive_identity_url_never_reaches_curl() {
  let mut accepted = Vec::new();
  for url in DECEPTIVE {
    if auth::kind::identity_argv(url).is_ok() {
      accepted.push(format!("identity_argv accepted {url:?}"));
    }
    let (f, alice, log) = with_fake_curl(url);
    if f.run("prepare", json!({"profile": alice})).is_ok() {
      accepted.push(format!("prepare accepted {url:?}"));
    }
    if let Ok(request) = std::fs::read_to_string(&log) {
      accepted.push(format!("curl was asked for: {}", request.trim()));
    }
  }
  assert!(accepted.is_empty(), "{}", accepted.join("\n"));
}

fn genuine_loopback_http_and_https_reach_curl_exactly() {
  let mut refused = Vec::new();
  for (url, proto) in GENUINE {
    match auth::kind::identity_argv(url) {
      Err(e) => refused.push(format!("identity_argv refused {url:?}: {e:#}")),
      Ok(argv) => {
        let ok = argv.windows(2).any(|w| w == ["--proto", *proto])
          && argv.windows(2).any(|w| w == ["--url", *url])
          // curl reads the URL literally: no `{}`/`[]` globbing into
          // other URLs.
          && argv.iter().any(|a| a == "--globoff");
        if !ok {
          refused.push(format!("{url:?}: argv {argv:?}"));
        }
      }
    }
    let (f, alice, log) = with_fake_curl(url);
    match f.run("prepare", json!({"profile": alice})) {
      Err(e) => refused.push(format!("prepare refused {url:?}: {e:#}")),
      Ok(reply) if reply["identity"]["id"] != "acct-c" => refused.push(format!("{url:?}: {reply}")),
      Ok(_) => {
        let request = std::fs::read_to_string(&log).unwrap_or_default();
        if request != format!("{proto} {url} bearer=true\n") {
          refused.push(format!("{url:?}: curl was asked for {request:?}"));
        }
      }
    }
  }
  assert!(refused.is_empty(), "{}", refused.join("\n"));
}

/// The loopback forms a kind can use really reach a loopback listener
/// through the real curl: IPv6 by literal, and `localhost` by name.
fn loopback_http_reaches_ipv6_and_localhost_listeners() {
  let body = json!({"account": {"uuid": "acct-l", "email": "l@example.com"}});
  let mut servers = vec![endpoint_at(
    TcpListener::bind("127.0.0.1:0").unwrap(),
    "localhost",
    200,
    body.clone(),
  )];
  match TcpListener::bind("[::1]:0") {
    Ok(listener) => servers.push(endpoint_at(listener, "[::1]", 200, body)),
    Err(e) => println!("  (no IPv6 loopback here, skipping [::1]: {e})"),
  }
  for server in servers {
    let f = with_url(&server.url);
    signed_in(&f);
    let alice = f.register("alice");
    let CredentialRef::Native { locator } = &alice.credential else {
      panic!("native")
    };
    std::fs::write(
      locator.join(".credentials.json"),
      r#"{"oauth":{"accessToken":"LOOPBACK_BEARER"}}"#,
    )
    .unwrap();
    let reply = f.run("prepare", json!({"profile": alice})).unwrap();
    assert_eq!(reply["identity"]["id"], "acct-l", "{}: {reply}", server.url);
    let seen = server.seen.lock().unwrap().join("\n");
    assert!(seen.contains("Bearer LOOPBACK_BEARER"), "{seen}");
  }
}

// --- settings guards -------------------------------------------------------------

fn settings_that_override_the_account_are_refused() {
  let f = Fixture::claude_like();
  let alice = f.register("alice");
  let project = f.root.join("project/deep");
  std::fs::create_dir_all(project.join("../.fixture")).unwrap();
  let prepare = |settings: &str| {
    std::fs::write(
      f.root.join("project/.fixture/settings.local.json"),
      settings,
    )
    .unwrap();
    f.run("prepare", json!({"profile": alice, "cwd": project}))
  };
  for bad in [
    r#"{"apiKeyHelper": "x"}"#,
    r#"{"env": {"FIXTURE_TOKEN": "x"}}"#,
    r#"{"env": {"CLAUDE_CONFIG_DIR": "/x"}}"#,
  ] {
    let reply = prepare(bad);
    assert_eq!(reply.unwrap_err().to_string(), "auth_override", "{bad}");
  }
  // Ordinary customization is fine (and the signed-out fake says so).
  assert_eq!(
    prepare(r#"{"env": {"OTHER": "1"}}"#).unwrap()["error"],
    "login_required"
  );
  // The provider surface turns the code into its message.
  std::fs::write(
    f.root.join("project/.fixture/settings.local.json"),
    r#"{"apiKeyHelper":1}"#,
  )
  .unwrap();
  let error = f
    .block_on(
      f.provider
        .prepare(&f.registry, alice, None, &project, BTreeMap::new()),
    )
    .unwrap_err();
  assert!(format!("{error:#}").contains("override the selected login"));
}

// --- exact resume: the executable plugin's resume tests, against the kind ---------

struct Resume {
  f: Fixture,
  config: PathBuf,
  profile: Profile,
}

impl Resume {
  fn new() -> Self {
    let f = Fixture::claude_like();
    let profile = f.register("alice");
    let login = f.run("login", json!({"profile": profile})).unwrap();
    let config = PathBuf::from(
      login["launch"]["env"]["CLAUDE_CONFIG_DIR"]
        .as_str()
        .unwrap(),
    );
    let project = config.join("projects/test-project");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("test-session.jsonl"), "{}\n").unwrap();
    let r = Self { f, config, profile };
    r.target(json!([]));
    r
  }

  fn target(&self, agents: Value) {
    std::fs::write(self.config.join("agents.json"), agents.to_string()).unwrap();
  }

  fn source(&self, agents: Value) -> Value {
    let config = self.f.root.join("source");
    std::fs::create_dir_all(&config).unwrap();
    let _ = std::os::unix::fs::symlink(self.config.join("projects"), config.join("projects"));
    std::fs::write(config.join("agents.json"), agents.to_string()).unwrap();
    json!({"CLAUDE_CONFIG_DIR": config, "CLAUDE_SECURESTORAGE_CONFIG_DIR": self.f.root.join("source-native")})
  }

  fn prepare(&self, source: Value, native: bool) -> anyhow::Result<Value> {
    let args = if native {
      json!([self.f.cli, "--resume", "test-session"])
    } else {
      json!([])
    };
    self.f.run(
      "prepare",
      json!({"profile": self.profile, "conversation": "test-session", "arguments": args, "source_env": source}),
    )
  }
}

fn running(kind: &str) -> Value {
  json!([{"sessionId": "test-session", "status": "running", "kind": kind}])
}

fn empty_source_still_checks_selected_profile() {
  let r = Resume::new();
  r.target(running("interactive"));
  assert_eq!(r.prepare(json!({}), true).unwrap()["error"], "busy");
}

fn both_source_and_destination_can_block_a_resume() {
  for target_busy in [false, true] {
    let r = Resume::new();
    r.target(if target_busy {
      running("interactive")
    } else {
      json!([])
    });
    let source = r.source(if target_busy {
      json!([])
    } else {
      running("interactive")
    });
    assert_eq!(r.prepare(source, true).unwrap()["error"], "busy");
  }
}

fn cli_resume_preserves_inherited_source_configuration() {
  let mut r = Resume::new();
  let source = r.source(running("interactive"));
  for (key, value) in source.as_object().unwrap() {
    r.f
      .provider
      .host
      .vars
      .insert(key.clone(), value.as_str().unwrap().into());
  }
  assert_eq!(r.prepare(json!({}), true).unwrap()["error"], "busy");
}

fn completed_and_unrelated_sessions_do_not_block() {
  let r = Resume::new();
  r.target(json!([
    {"sessionId": "test-session", "status": "completed", "kind": "interactive"},
    {"sessionId": "another-session", "status": "running", "kind": "interactive"}
  ]));
  assert_eq!(
    r.prepare(json!({}), true).unwrap()["error"],
    "login_required"
  );
}

fn lane_switch_ignores_source_interactive_owner_but_not_destination() {
  let r = Resume::new();
  let source = r.source(running("interactive"));
  assert_eq!(
    r.prepare(source.clone(), false).unwrap()["error"],
    "login_required"
  );
  r.target(running("interactive"));
  assert_eq!(r.prepare(source, false).unwrap()["error"], "busy");
}

fn lane_switch_refuses_active_child_work() {
  let r = Resume::new();
  let source = r.source(running("task"));
  assert_eq!(r.prepare(source, false).unwrap()["error"], "busy");
}

fn same_profile_lane_switch_does_not_block_on_its_own_interactive_session() {
  let r = Resume::new();
  r.target(running("interactive"));
  let CredentialRef::Native { locator } = &r.profile.credential else {
    panic!("native")
  };
  let source = json!({"CLAUDE_CONFIG_DIR": r.config, "CLAUDE_SECURESTORAGE_CONFIG_DIR": locator});
  assert_eq!(
    r.prepare(source.clone(), false).unwrap()["error"],
    "login_required"
  );
  assert_eq!(r.prepare(source, true).unwrap()["error"], "busy");
}

fn supervisor_failure_refuses_resume() {
  let r = Resume::new();
  std::fs::write(r.config.join("agents.json"), "invalid-json").unwrap();
  assert!(r.prepare(json!({}), true).is_err());
}

fn inexact_and_background_resumes_are_unsupported_and_history_must_exist() {
  let r = Resume::new();
  let cli = r.f.cli.to_string_lossy().into_owned();
  let run = |args: Value| {
    r.f
      .run("prepare", json!({"profile": r.profile, "arguments": args}))
      .unwrap()
  };
  assert_eq!(run(json!([cli, "--continue"]))["error"], "unsupported");
  assert_eq!(run(json!([cli, "-c"]))["error"], "unsupported");
  assert_eq!(
    run(json!([cli, "--resume", "test-session", "--bg"]))["error"],
    "unsupported"
  );
  assert_eq!(
    run(json!([cli, "--resume=missing-session"]))["error"],
    "history_missing"
  );
  assert!(
    r.f
      .run(
        "prepare",
        json!({"profile": r.profile, "arguments": [cli, "--resume", "-x"]})
      )
      .is_err()
  );
  // A command that is not the app's CLI is not parsed for resume flags.
  assert_eq!(
    run(json!(["/usr/bin/env", "--continue"]))["error"],
    "login_required"
  );
}

// --- the other shapes: exit-status precheck + account file, and no verifier ---------

fn jwt(payload: Value) -> String {
  fn b64(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
      let n = chunk.iter().fold(0u32, |a, b| (a << 8) | u32::from(*b)) << (8 * (3 - chunk.len()));
      for i in 0..=chunk.len() {
        out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
      }
    }
    out
  }
  format!(
    "{}.{}.sig",
    b64(b"{\"alg\":\"none\"}"),
    b64(payload.to_string().as_bytes())
  )
}

fn codex_like() -> AccountKind {
  AccountKind::parse(
    &json!({
      "schema": "account.kind/v1",
      "app": "fixture",
      "cli": {"env": "FAKE_CLI", "name": "fakecli"},
      "credential": {"backend": "native", "root": {"default": "{home}/accounts"}, "locator": "{root}/{alias}"},
      "config_dir": "{locator}",
      "shared": {"from": "{home}/.fakehome", "names": ["config.toml"]},
      "env": {"FAKE_HOME": "{locator}"},
      "remove_env": ["FAKE_API_KEY"],
      "login": {"args": ["login"]},
      "verify": {
        "precheck": {"args": ["login", "status"]},
        "file": {"path": "{locator}/auth.json", "id": "/tokens/account_id", "label": "/tokens/id_token", "label_jwt_claim": "email"}
      }
    })
    .to_string(),
  )
  .unwrap()
}

fn an_exit_status_precheck_and_an_account_file_name_the_account() {
  let f = Fixture::new(codex_like());
  std::fs::create_dir_all(f.home.join(".fakehome")).unwrap();
  std::fs::write(f.home.join(".fakehome/config.toml"), "model = \"x\"\n").unwrap();
  let work = f.register("work");
  // Not signed in: the CLI says so by its exit status.
  assert_eq!(
    f.run("prepare", json!({"profile": work})).unwrap()["error"],
    "login_required"
  );
  let token = jwt(json!({"email": "w@example.com", "sub": "x"}));
  std::fs::write(
    f.home.join("accounts/work/auth.json"),
    json!({"tokens": {"account_id": "acct-w", "id_token": token}}).to_string(),
  )
  .unwrap();
  let binding = f
    .block_on(
      f.provider
        .prepare(&f.registry, work.clone(), None, &f.root, BTreeMap::new()),
    )
    .unwrap();
  let identity = binding.profile.identity.unwrap();
  assert_eq!(
    (identity.id.as_str(), identity.label.as_str()),
    ("acct-w", "w@example.com")
  );
  assert_eq!(
    Path::new(&binding.launch.env["FAKE_HOME"]),
    f.home.join("accounts/work")
  );
  assert_eq!(
    std::fs::read_to_string(f.home.join("accounts/work/config.toml")).unwrap(),
    "model = \"x\"\n"
  );
  // Signed in with a key rather than an account: usable, but unverified.
  let key = f.register("key");
  std::fs::write(
    f.home.join("accounts/key/auth.json"),
    json!({"OPENAI_API_KEY": "sk-SENTINEL", "tokens": null}).to_string(),
  )
  .unwrap();
  let binding = f
    .block_on(
      f.provider
        .prepare(&f.registry, key, None, &f.root, BTreeMap::new()),
    )
    .unwrap();
  assert!(binding.profile.identity.is_none());
  assert_eq!(binding.profile.state, AuthState::Unverified);
  assert!(
    !serde_json::to_string(&binding)
      .unwrap()
      .contains("SENTINEL")
  );
  // No resume rules: a conversation cannot be resumed.
  let error = f
    .block_on(f.provider.prepare(
      &f.registry,
      work,
      Some("conversation"),
      &f.root,
      BTreeMap::new(),
    ))
    .unwrap_err();
  assert!(format!("{error:#}").contains("cannot safely resume"));
}

fn a_kind_without_a_verifier_binds_unverified_and_checks_presence() {
  let kind = AccountKind::parse(
    &json!({
      "schema": "account.kind/v1",
      "app": "fixture",
      "cli": {"env": "FAKE_CLI", "name": "fakecli"},
      "credential": {"backend": "native", "root": {"default": "{home}/data-homes"}, "locator": "{root}/{alias}"},
      "env": {"XDG_DATA_HOME": "{locator}"},
      "login": {"args": ["auth", "login"]},
      "verify": {"present": ["{locator}/fixture/auth.json"]}
    })
    .to_string(),
  )
  .unwrap();
  let f = Fixture::new(kind);
  let a = f.register("a");
  assert_eq!(
    f.run("prepare", json!({"profile": a})).unwrap()["error"],
    "login_required"
  );
  // Through the provider surface the catalog records it, and a later
  // success clears it even though no account is named.
  assert!(
    f.block_on(
      f.provider
        .prepare(&f.registry, a.clone(), None, &f.root, BTreeMap::new())
    )
    .is_err()
  );
  assert_eq!(
    f.registry.resolve("fixture", "a").unwrap().state,
    AuthState::LoginRequired
  );
  std::fs::create_dir_all(f.home.join("data-homes/a/fixture")).unwrap();
  std::fs::write(f.home.join("data-homes/a/fixture/auth.json"), "{}").unwrap();
  let binding = f
    .block_on(
      f.provider
        .prepare(&f.registry, a, None, &f.root, BTreeMap::new()),
    )
    .unwrap();
  assert_eq!(binding.profile.state, AuthState::Unverified);
  assert_eq!(
    Path::new(&binding.launch.env["XDG_DATA_HOME"]),
    f.home.join("data-homes/a")
  );
  let run = f
    .block_on(f.provider.login(&f.registry, binding.profile.clone()))
    .unwrap();
  assert_eq!(run.argv[1..], ["auth", "login"]);
}

fn a_vault_kind_is_declared_but_does_not_mint_yet() {
  let kind = AccountKind::parse(
    &json!({
      "schema": "account.kind/v1",
      "app": "fixture",
      "cli": {"env": "FAKE_CLI", "name": "fakecli"},
      "credential": {"backend": "vault", "namespace": "fixture", "name": "api-key-{alias}", "bind": {"env": "FIXTURE_API_KEY"}}
    })
    .to_string(),
  )
  .unwrap();
  let f = Fixture::new(kind);
  let a = f.register("a");
  assert_eq!(
    a.credential,
    CredentialRef::Vault {
      address: "fixture/api-key-a".into()
    }
  );
  let error = f.run("prepare", json!({"profile": a})).unwrap_err();
  assert!(format!("{error:#}").contains("not enabled yet"));
  let login = f.block_on(f.provider.login(&f.registry, a)).unwrap_err();
  assert!(format!("{login:#}").contains(r#"tsh '(tsh.secrets "set" "fixture/api-key-a")'"#));
}

// --- the two doors ------------------------------------------------------------------

fn a_kind_shadows_an_executable_provider_for_the_same_app() {
  let dir = tempfile::tempdir().unwrap();
  let bundle = dir.path().join("fixture.tsh.app");
  std::fs::create_dir_all(bundle.join("bin")).unwrap();
  std::fs::write(
    bundle.join("manifest.json"),
    json!({"schema": "tsh.app/v1", "name": "fixture", "version": "1", "entrypoint": "bin/provider",
      "transport": "oneshot", "commands": {},
      "provides": [{"type": "auth.provider/v1", "id": "fixture", "command": "provider", "returns": "auth.response/v1"}]})
    .to_string(),
  )
  .unwrap();
  let dirs = vec![dir.path().to_path_buf()];
  let kind = claude_like("https://identity.invalid/");
  let chosen = auth::resolve_with_kinds(&dirs, std::slice::from_ref(&kind), "fixture").unwrap();
  assert!(matches!(chosen, auth::AppProvider::Kind(_)));
  let plain = auth::resolve_with_kinds(&dirs, &[], "fixture").unwrap();
  assert!(matches!(plain, auth::AppProvider::Executable(_)));
  let mut other = kind.clone();
  other.app = "another".into();
  let all = auth::discover_with_kinds(&dirs, &[other]).unwrap();
  let apps: Vec<&str> = all.iter().map(|p| p.app()).collect();
  assert_eq!(apps, vec!["another", "fixture"]);
  assert!(auth::resolve_with_kinds(&dirs, &[], "missing").is_err());
}

// --- runner --------------------------------------------------------------------------

fn main() {
  let mut args = std::env::args();
  let name = args
    .next()
    .map(|a| {
      Path::new(&a)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
    })
    .unwrap_or_default();
  let rest: Vec<String> = args.collect();
  match name.as_str() {
    "fakecli" => std::process::exit(fake_cli(&rest)),
    "security" => std::process::exit(fake_security(&rest)),
    "curl" => std::process::exit(fake_curl(&rest)),
    _ => {}
  }
  let filter = rest.iter().find(|a| !a.starts_with('-')).cloned();
  let tests: &[(&str, fn())] = &[
    (
      "a_default_pointer_prefers_a_key_over_another_rows_alias",
      a_default_pointer_prefers_a_key_over_another_rows_alias,
    ),
    (
      "store_diagnostics_follow_the_profiles_saved_locator",
      store_diagnostics_follow_the_profiles_saved_locator,
    ),
    (
      "accounts_share_customization_but_isolate_config_and_credentials",
      accounts_share_customization_but_isolate_config_and_credentials,
    ),
    (
      "a_created_shared_entry_is_linked_into_every_account",
      a_created_shared_entry_is_linked_into_every_account,
    ),
    (
      "the_legacy_table_imports_once_and_skips_unsafe_rows",
      the_legacy_table_imports_once_and_skips_unsafe_rows,
    ),
    (
      "a_fallback_store_is_adopted_and_its_pointer_names_the_default",
      a_fallback_store_is_adopted_and_its_pointer_names_the_default,
    ),
    (
      "a_secrets_base_fallback_is_tried_under_each_base_in_order",
      a_secrets_base_fallback_is_tried_under_each_base_in_order,
    ),
    (
      "the_apps_own_login_is_imported_without_touching_it",
      the_apps_own_login_is_imported_without_touching_it,
    ),
    (
      "the_apps_own_login_is_never_blocked_by_its_identity_check",
      the_apps_own_login_is_never_blocked_by_its_identity_check,
    ),
    (
      "codex_probe_k1_a_signed_out_native_login_is_demoted",
      codex_probe_k1_a_signed_out_native_login_is_demoted,
    ),
    (
      "codex_probe_k2_a_native_key_helper_does_not_block",
      codex_probe_k2_a_native_key_helper_does_not_block,
    ),
    (
      "a_confirmed_native_login_is_demoted_when_reverification_fails",
      a_confirmed_native_login_is_demoted_when_reverification_fails,
    ),
    (
      "the_apps_own_login_keeps_its_own_authentication",
      the_apps_own_login_keeps_its_own_authentication,
    ),
    (
      "login_names_the_expected_account_and_binds_references",
      login_names_the_expected_account_and_binds_references,
    ),
    (
      "the_identity_endpoint_gets_the_bearer_on_stdin_and_names_the_account",
      the_identity_endpoint_gets_the_bearer_on_stdin_and_names_the_account,
    ),
    (
      "a_login_into_another_account_is_a_mismatch",
      a_login_into_another_account_is_a_mismatch,
    ),
    (
      "an_unauthorized_bearer_or_a_missing_credential_needs_sign_in",
      an_unauthorized_bearer_or_a_missing_credential_needs_sign_in,
    ),
    (
      "the_keychain_item_wins_over_the_file_and_is_asked_for_by_service",
      the_keychain_item_wins_over_the_file_and_is_asked_for_by_service,
    ),
    (
      "plain_http_is_refused_off_loopback",
      plain_http_is_refused_off_loopback,
    ),
    (
      "a_deceptive_identity_url_never_reaches_curl",
      a_deceptive_identity_url_never_reaches_curl,
    ),
    (
      "genuine_loopback_http_and_https_reach_curl_exactly",
      genuine_loopback_http_and_https_reach_curl_exactly,
    ),
    (
      "loopback_http_reaches_ipv6_and_localhost_listeners",
      loopback_http_reaches_ipv6_and_localhost_listeners,
    ),
    (
      "settings_that_override_the_account_are_refused",
      settings_that_override_the_account_are_refused,
    ),
    (
      "empty_source_still_checks_selected_profile",
      empty_source_still_checks_selected_profile,
    ),
    (
      "both_source_and_destination_can_block_a_resume",
      both_source_and_destination_can_block_a_resume,
    ),
    (
      "cli_resume_preserves_inherited_source_configuration",
      cli_resume_preserves_inherited_source_configuration,
    ),
    (
      "completed_and_unrelated_sessions_do_not_block",
      completed_and_unrelated_sessions_do_not_block,
    ),
    (
      "lane_switch_ignores_source_interactive_owner_but_not_destination",
      lane_switch_ignores_source_interactive_owner_but_not_destination,
    ),
    (
      "lane_switch_refuses_active_child_work",
      lane_switch_refuses_active_child_work,
    ),
    (
      "same_profile_lane_switch_does_not_block_on_its_own_interactive_session",
      same_profile_lane_switch_does_not_block_on_its_own_interactive_session,
    ),
    (
      "supervisor_failure_refuses_resume",
      supervisor_failure_refuses_resume,
    ),
    (
      "inexact_and_background_resumes_are_unsupported_and_history_must_exist",
      inexact_and_background_resumes_are_unsupported_and_history_must_exist,
    ),
    (
      "an_exit_status_precheck_and_an_account_file_name_the_account",
      an_exit_status_precheck_and_an_account_file_name_the_account,
    ),
    (
      "a_kind_without_a_verifier_binds_unverified_and_checks_presence",
      a_kind_without_a_verifier_binds_unverified_and_checks_presence,
    ),
    (
      "a_vault_kind_is_declared_but_does_not_mint_yet",
      a_vault_kind_is_declared_but_does_not_mint_yet,
    ),
    (
      "a_kind_shadows_an_executable_provider_for_the_same_app",
      a_kind_shadows_an_executable_provider_for_the_same_app,
    ),
  ];
  let mut failed = Vec::new();
  let mut ran = 0;
  for (name, test) in tests {
    if filter.as_deref().is_some_and(|f| !name.contains(f)) {
      continue;
    }
    ran += 1;
    match std::panic::catch_unwind(test) {
      Ok(()) => println!("test {name} ... ok"),
      Err(_) => {
        println!("test {name} ... FAILED");
        failed.push(*name);
      }
    }
  }
  println!(
    "\ntest result: {}. {} passed; {} failed",
    if failed.is_empty() { "ok" } else { "FAILED" },
    ran - failed.len(),
    failed.len()
  );
  if !failed.is_empty() {
    std::process::exit(1);
  }
}
