//! Checks over a real loopback socket, against a prebuilt route tree (what
//! `serve --web-root` serves): healthz, JSON 404s under /api, and the
//! loopback-only refusal.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use autophys::{AppConfig, BuildInfo, http_server, serve, webapp};
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

/// A running server; dropping the stop sender ends it.
struct Running {
    addr: std::net::SocketAddr,
    _stop: oneshot::Sender<()>,
    _task: tokio::task::JoinHandle<std::io::Result<()>>,
}

async fn start(name: &str) -> Running {
    let config = AppConfig {
        project_root: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        web_root: fixture(name),
    };
    let info = BuildInfo {
        version: "0.1.0".into(),
        commit: "abc1234".into(),
        tento_commit: "def5678".into(),
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
        _stop: stop,
        _task: task,
    }
}

/// One HTTP/1.1 request with `Connection: close`; returns (status, headers, body).
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
async fn healthz_reports_ok_version_and_both_commits() {
    let server = start("healthz").await;
    let (status, head, body) = request(server.addr, "GET", "/api/healthz").await;
    assert_eq!(status, 200);
    assert!(head.contains("content-type: application/json"), "{head}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "ok": true, "version": "0.1.0", "commit": "abc1234", "tento_commit": "def5678" })
    );
}

#[tokio::test]
async fn unknown_paths_are_404() {
    let server = start("missing").await;
    let (status, _, _) = request(server.addr, "GET", "/nope.js").await;
    assert_eq!(status, 404);
    for (method, path) in [("GET", "/api/nope"), ("POST", "/api/nope"), ("GET", "/api")] {
        let (status, head, body) = request(server.addr, method, path).await;
        assert_eq!(status, 404, "{method} {path}");
        assert!(head.contains("application/json"), "{path}: {head}");
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["ok"], false, "{path}");
        assert_eq!(json["path"], path);
    }
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
