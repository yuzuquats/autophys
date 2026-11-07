//! The user's side of the one CLI (cli.md, phase A): `autophys connect`,
//! `whoami` and `new`, through the real binary against a scratch daemon and
//! temporary directories. No installed service, network or shared data.
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_autophys");

fn cli(config: &Path) -> Command {
    let mut command = Command::new(BIN);
    command
        .env_clear()
        .env("HOME", config)
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("AUTOPHYS_CONFIG_DIR", config.join("cfg"));
    command
}

struct Daemon {
    child: Child,
    dir: tempfile::TempDir,
    url: String,
}
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Daemon {
    fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let web = dir.path().join("web/routes");
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(
            web.join("index.anon.html"),
            "<!doctype html><title>t</title>",
        )
        .unwrap();
        let addr = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap()
        };
        let child = Command::new(BIN)
            .env_clear()
            .env("HOME", dir.path())
            .args(["serve", "--addr", &addr.to_string(), "--web-root"])
            .arg(dir.path().join("web"))
            .arg("--collection")
            .arg(dir.path().join("collection"))
            .arg("--server-db")
            .arg(dir.path().join("server.db"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let url = format!("http://{addr}");
        let started = Instant::now();
        while std::net::TcpStream::connect(addr).is_err() {
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "daemon failed to start"
            );
            std::thread::sleep(Duration::from_millis(30));
        }
        Self { child, dir, url }
    }
    fn admin(&self, args: &[&str]) -> Output {
        Command::new(BIN)
            .env_clear()
            .env("HOME", self.dir.path())
            .args(args)
            .arg("--collection")
            .arg(self.dir.path().join("collection"))
            .arg("--server-db")
            .arg(self.dir.path().join("server.db"))
            .output()
            .unwrap()
    }
}

#[test]
fn connect_saves_a_private_key_and_whoami_reads_it() {
    let d = Daemon::start();
    let home = tempfile::tempdir().unwrap();

    let unpaired = cli(home.path())
        .args(["whoami", "--server", &d.url])
        .output()
        .unwrap();
    assert_eq!(unpaired.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&unpaired.stderr).contains("autophys connect"));

    let mut connect = cli(home.path())
        .args(["connect", &d.url, "--name", "lab-pc"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(connect.stdout.take().unwrap());
    let mut first = String::new();
    stdout.read_line(&mut first).unwrap();
    let code = first.trim().rsplit(' ').next().unwrap().to_string();
    assert!(first.contains("enter code:"), "{first}");
    let approved = d.admin(&["pair", "approve", &code]);
    assert!(
        approved.status.success(),
        "{}",
        String::from_utf8_lossy(&approved.stderr)
    );
    let mut rest = String::new();
    std::io::Read::read_to_string(&mut stdout, &mut rest).unwrap();
    let status = connect.wait().unwrap();
    assert!(status.success(), "{first}{rest}");
    assert!(rest.contains("Connected as"), "{rest}");

    let path = home.path().join("cfg/credentials");
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let key = saved["api_key"].as_str().unwrap();
    assert!(key.starts_with("apk_"));
    assert!(!first.contains(key) && !rest.contains(key));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let me = cli(home.path())
        .args(["whoami", "--json"])
        .output()
        .unwrap();
    assert!(
        me.status.success(),
        "{}",
        String::from_utf8_lossy(&me.stderr)
    );
    let text = String::from_utf8(me.stdout).unwrap();
    let me: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(me["device_name"], "lab-pc");
    assert!(!text.contains(key));
    let plain = cli(home.path()).arg("whoami").output().unwrap();
    let plain = String::from_utf8(plain.stdout).unwrap();
    assert!(
        plain.contains("device:    lab-pc") && plain.contains(&d.url),
        "{plain}"
    );

    // A revoked key is reported as rejected, not as a network failure.
    let key_id = saved["key_id"].as_str().unwrap();
    assert!(d.admin(&["keys", "revoke", key_id]).status.success());
    let rejected = cli(home.path()).arg("whoami").output().unwrap();
    assert_eq!(rejected.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("rejected the key"));
}

#[test]
fn connect_with_json_keeps_stdout_one_object() {
    let d = Daemon::start();
    let home = tempfile::tempdir().unwrap();
    let mut connect = cli(home.path())
        .env("AUTOPHYS_SERVER", &d.url)
        .args(["connect", "--name", "json-pc", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stderr = BufReader::new(connect.stderr.take().unwrap());
    let mut first = String::new();
    stderr.read_line(&mut first).unwrap();
    let code = first.trim().rsplit(' ').next().unwrap().to_string();
    assert!(d.admin(&["pair", "approve", &code]).status.success());
    let out = connect.wait_with_output().unwrap();
    assert!(out.status.success());
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["device_name"], "json-pc");
    assert_eq!(doc["server"], d.url.as_str());
    assert!(doc.get("api_key").is_none());
}

#[test]
fn connect_reports_an_unreachable_server() {
    let home = tempfile::tempdir().unwrap();
    let out = cli(home.path())
        .args(["connect", "http://127.0.0.1:9"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("pairing could not start"));
    assert!(!home.path().join("cfg/credentials").exists());
}

fn new_project(home: &Path, args: &[&str]) -> Output {
    cli(home)
        .arg("new")
        .args(args)
        .current_dir(home)
        .output()
        .unwrap()
}

#[test]
fn new_writes_each_template_pinned_to_one_sdk_commit() {
    let home = tempfile::tempdir().unwrap();
    let out = new_project(
        home.path(),
        &[
            "py",
            "--lang",
            "python",
            "--no-install",
            "--sdk-rev",
            "abc123",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let py = home.path().join("py");
    let pyproject = std::fs::read_to_string(py.join("pyproject.toml")).unwrap();
    assert!(pyproject.contains(
        "\"autophys @ git+https://github.com/yuzuquats/autophys@abc123#subdirectory=sdks/python\""
    ));
    assert!(pyproject.contains("name = \"py\""));
    for file in [
        "battery_fit.py",
        "closed_loop.py",
        "data/demo.csv",
        "expected/demo.txt",
        ".gitignore",
    ] {
        assert!(py.join(file).is_file(), "{file}");
    }
    assert!(!py.join(".venv").exists());
    assert!(!py.join("run.sh").exists());
    let loop_source = std::fs::read_to_string(py.join("closed_loop.py")).unwrap();
    assert!(!loop_source.contains("run.sh") && !loop_source.contains("autophys pair"));
    assert!(String::from_utf8_lossy(&out.stdout).contains("python3 -m venv .venv"));

    let out = new_project(
        home.path(),
        &[
            "Rust Cells",
            "--lang",
            "rust",
            "--sdk-rev",
            "abc123",
            "--sdk-repo",
            "file:///src/autophys",
            "--json",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["name"], "rust-cells");
    let cargo = std::fs::read_to_string(home.path().join("Rust Cells/Cargo.toml")).unwrap();
    assert!(cargo.contains("name = \"rust-cells\""));
    assert!(cargo.contains("autophys = { git = \"file:///src/autophys\", rev = \"abc123\" }"));
    assert!(home.path().join("Rust Cells/src/main.rs").is_file());
    assert!(home.path().join("Rust Cells/data/short.csv").is_file());

    // pip needs a host in a file URL; Cargo and Git do not.
    let out = new_project(
        home.path(),
        &[
            "local",
            "--lang",
            "python",
            "--example",
            "blank",
            "--no-install",
            "--sdk-rev",
            "abc123",
            "--sdk-repo",
            "file:///src/autophys",
        ],
    );
    assert!(out.status.success());
    let pyproject = std::fs::read_to_string(home.path().join("local/pyproject.toml")).unwrap();
    assert!(
        pyproject.contains("git+file://localhost/src/autophys@abc123#subdirectory=sdks/python")
    );

    let out = new_project(
        home.path(),
        &[
            "blank",
            "--lang",
            "rust",
            "--example",
            "blank",
            "--sdk-rev",
            "abc123",
        ],
    );
    assert!(out.status.success());
    assert!(!home.path().join("blank/data").exists());

    // A non-empty directory is refused and left as it was.
    let out = new_project(
        home.path(),
        &["py", "--lang", "rust", "--sdk-rev", "abc123"],
    );
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("not empty"));
    assert!(!home.path().join("py/Cargo.toml").exists());

    let out = new_project(home.path(), &["x", "--lang", "go"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
}

#[test]
fn new_pins_the_build_commit_by_default() {
    let home = tempfile::tempdir().unwrap();
    let out = new_project(home.path(), &["p", "--lang", "rust", "--json"]);
    match autophys_cli::scaffold::source_commit() {
        Some(commit) => {
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(doc["sdk_rev"], commit);
        }
        None => {
            assert_eq!(out.status.code(), Some(2));
            assert!(String::from_utf8_lossy(&out.stderr).contains("--sdk-rev"));
        }
    }
}

#[test]
fn help_lists_the_user_commands() {
    let out = Command::new(BIN)
        .env_clear()
        .args(["--help", "--json"])
        .output()
        .unwrap();
    let tree: Value = serde_json::from_slice(&out.stdout).unwrap();
    for command in ["new", "connect", "whoami"] {
        assert!(
            tree["commands"].get(command).is_some(),
            "missing {command}: {tree}"
        );
    }
}
