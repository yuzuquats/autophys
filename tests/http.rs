//! End-to-end checks over a real loopback socket, against a prebuilt route
//! tree (what `serve --web-root` serves); no bundler runs here.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use autophys_cli::{AppConfig, BuildInfo, http_server, serve, webapp};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::oneshot;

const PAGE: &str = "<!doctype html><title>autophys</title>";

fn fixture(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("web-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("routes")).unwrap();
    std::fs::write(dir.join("routes/index.anon.html"), PAGE).unwrap();
    std::fs::write(dir.join("routes/index.root.js"), "console.log('autophys')").unwrap();
    dir
}

struct Running {
    addr: std::net::SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

async fn start(name: &str) -> Running {
    let config = AppConfig {
        project_root: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        web_root: fixture(name),
        store: None,
    };
    let info = BuildInfo {
        version: "0.1.0".into(),
        commit: "abc1234".into(),
        web_id: None,
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Arc::new(webapp(&config, info, false).unwrap());
    let (stop, stopped) = oneshot::channel::<()>();
    let server = http_server(listener, app).unwrap();
    let task = tokio::spawn(serve(server, async {
        let _ = stopped.await;
    }));
    Running {
        addr,
        stop: Some(stop),
        task,
    }
}

/// One HTTP/1.1 request with `Connection: close`; returns (status, headers, body).
async fn get(addr: std::net::SocketAddr, path: &str) -> (u16, String, String) {
    request(addr, "GET", path).await
}

async fn request(addr: std::net::SocketAddr, method: &str, path: &str) -> (u16, String, String) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    (status, head.to_lowercase(), body.to_string())
}

#[tokio::test]
async fn healthz_reports_ok_version_and_commit() {
    let server = start("healthz").await;
    let (status, head, body) = get(server.addr, "/api/healthz").await;
    assert_eq!(status, 200);
    assert!(head.contains("content-type: application/json"), "{head}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "ok": true, "version": "0.1.0", "commit": "abc1234", "web_id": null })
    );
}

#[tokio::test]
async fn the_route_tree_is_served() {
    let server = start("static").await;
    let (status, head, body) = get(server.addr, "/").await;
    assert_eq!(status, 200);
    assert!(head.contains("text/html"), "{head}");
    assert!(head.contains("set-cookie: autophys_session="), "{head}");
    assert!(
        head.contains("httponly") && head.contains("samesite=strict") && head.contains("path=/api")
    );
    assert!(body.contains("<title>autophys</title>"), "{body}");
    let (status, head, body) = get(server.addr, "/index.root.js").await;
    assert_eq!((status, body.as_str()), (200, "console.log('autophys')"));
    assert!(head.contains("javascript"), "{head}");
}

#[tokio::test]
async fn app_routes_serve_the_document() {
    let server = start("app-routes").await;
    for path in ["/app", "/app/", "/app/untitled-2", "/app/a/b"] {
        let (status, head, body) = get(server.addr, path).await;
        assert_eq!(status, 200, "{path}");
        assert!(head.contains("text/html"), "{path}: {head}");
        assert!(
            head.contains("set-cookie: autophys_session="),
            "{path}: missing session cookie"
        );
        assert_eq!(body, PAGE, "{path}");
    }
}

#[tokio::test]
async fn unknown_paths_are_404() {
    let server = start("missing").await;
    let (status, _, _) = get(server.addr, "/nope.js").await;
    assert_eq!(status, 404);
    for (method, path) in [
        ("GET", "/api/nope"),
        ("GET", "/api/v1/workspace"),
        ("POST", "/api/v1/x"),
        ("GET", "/api"),
    ] {
        let (status, head, body) = request(server.addr, method, path).await;
        assert_eq!(status, 404, "{method} {path}");
        assert!(head.contains("application/json"), "{path}: {head}");
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["ok"], false, "{path}");
        assert_eq!(json["path"], path);
    }
    // Traversal stays inside the route tree.
    let (status, _, _) = get(server.addr, "/../Cargo.toml").await;
    assert!(status == 404 || status == 400, "traversal got {status}");
}

#[tokio::test]
async fn shutdown_signal_drains_and_stops() {
    let mut server = start("shutdown").await;
    let (status, _, _) = get(server.addr, "/api/healthz").await;
    assert_eq!(status, 200);
    server.stop.take().unwrap().send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(15), &mut server.task).await;
    assert!(
        matches!(result, Ok(Ok(Ok(())))),
        "server did not stop cleanly: {result:?}"
    );
    assert!(
        TcpStream::connect(server.addr).await.is_err(),
        "listener still accepting"
    );
}

#[test]
fn binary_refuses_non_loopback_addr() {
    let web = fixture("bin-refuse");
    for addr in ["0.0.0.0:0", "[::]:0", "100.64.0.19:0", "localhost:0"] {
        let out = Command::new(env!("CARGO_BIN_EXE_autophys"))
            .args(["serve", "--addr", addr, "--web-root"])
            .arg(&web)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{addr}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("loopback") || stderr.contains("not an IP"),
            "{addr}: {stderr}"
        );
    }
}

#[test]
fn binary_refuses_an_unbuilt_web_root() {
    let out = Command::new(env!("CARGO_BIN_EXE_autophys"))
        .args([
            "serve",
            "--addr",
            "127.0.0.1:0",
            "--web-root",
            "/nonexistent/autophys",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("autophys build-web"));
}

#[test]
fn binary_exits_cleanly_on_sigterm() {
    let web = fixture("bin-sigterm");
    let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = probe.local_addr().unwrap();
    drop(probe);
    let mut child = Command::new(env!("CARGO_BIN_EXE_autophys"))
        .args(["serve", "--addr", &addr.to_string(), "--web-root"])
        .arg(&web)
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::net::TcpStream::connect(addr).is_err() {
        assert!(
            std::time::Instant::now() < deadline,
            "server never listened"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    // Signal only the child this test spawned, by PID.
    let status = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    let exit = child.wait().unwrap();
    assert_eq!(exit.code(), Some(0), "SIGTERM should drain and exit 0");
    let mut stderr = String::new();
    std::io::Read::read_to_string(child.stderr.as_mut().unwrap(), &mut stderr).unwrap();
    assert!(
        stderr.contains("SIGTERM, draining") && stderr.contains("stopped"),
        "{stderr}"
    );
}

#[test]
fn binary_lists_its_subcommands() {
    let bin = env!("CARGO_BIN_EXE_autophys");
    let none = Command::new(bin).output().unwrap();
    assert_eq!(none.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&none.stderr).contains("usage: autophys serve"));
    let unknown = Command::new(bin).arg("ingest").output().unwrap();
    assert_eq!(unknown.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("unknown command"));
    let help = Command::new(bin).arg("--help").output().unwrap();
    assert_eq!(help.status.code(), Some(0));
    let help = String::from_utf8_lossy(&help.stdout).to_string();
    assert!(
        help.contains("autophys serve") && help.contains("autophys build-web"),
        "{help}"
    );
    // The store's commands exist; with no subcommand each is a usage error
    // that opens no database (tests/store_admin.rs covers them working). The
    // error is one line plus a pointer to the group's --help (G4).
    for command in ["pair", "keys", "db"] {
        let out = Command::new(bin)
            .arg(command)
            .env("AUTOPHYS_DB", "/nonexistent/autophys.db")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{command}");
        assert!(out.stdout.is_empty(), "{command}");
        assert_eq!(
            String::from_utf8_lossy(&out.stderr),
            format!(
                "autophys: {command} needs a subcommand\n\
                 Try `autophys {command} --help` for the options.\n"
            ),
            "{command}"
        );
    }
}
