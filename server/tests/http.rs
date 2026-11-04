//! End-to-end checks over a real loopback socket.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use autophys_server::{BuildInfo, app, serve};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

fn fixture(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("web-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(
        dir.join("index.html"),
        "<!doctype html><title>autophys</title>",
    )
    .unwrap();
    std::fs::write(dir.join("main.js"), "console.log('autophys')").unwrap();
    std::fs::write(dir.join("assets/style.css"), "body{}").unwrap();
    dir
}

struct Running {
    addr: std::net::SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

async fn start(name: &str) -> Running {
    let web = fixture(name);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let info = BuildInfo {
        version: "0.1.0".into(),
        commit: "abc1234".into(),
    };
    let task = tokio::spawn(serve(listener, app(&web, info), async {
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
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
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
        serde_json::json!({ "ok": true, "version": "0.1.0", "commit": "abc1234" })
    );
}

#[tokio::test]
async fn static_client_is_served() {
    let server = start("static").await;
    let (status, head, body) = get(server.addr, "/").await;
    assert_eq!(status, 200);
    assert!(head.contains("text/html"), "{head}");
    assert!(body.contains("<title>autophys</title>"));
    let (status, head, _) = get(server.addr, "/main.js").await;
    assert_eq!(status, 200);
    assert!(head.contains("javascript"), "{head}");
    let (status, head, body) = get(server.addr, "/assets/style.css").await;
    assert_eq!((status, body.as_str()), (200, "body{}"));
    assert!(head.contains("text/css"), "{head}");
}

#[tokio::test]
async fn app_routes_serve_the_document() {
    let server = start("app-routes").await;
    for path in ["/app", "/app/untitled-2", "/app/a/b"] {
        let (status, _, body) = get(server.addr, path).await;
        assert_eq!(status, 200, "{path}");
        assert!(body.contains("<title>autophys</title>"), "{path}");
    }
}

#[tokio::test]
async fn unknown_paths_are_404() {
    let server = start("missing").await;
    let (status, _, body) = get(server.addr, "/nope.js").await;
    assert_eq!((status, body.as_str()), (404, "not found\n"));
    let (status, head, body) = get(server.addr, "/api/nope").await;
    assert_eq!(status, 404);
    assert!(head.contains("application/json"), "{head}");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["path"], "/api/nope");
    let (status, _, _) = get(server.addr, "/api").await;
    assert_eq!(status, 404);
    // Traversal stays inside the web root.
    let (status, _, _) = get(server.addr, "/../Cargo.toml").await;
    assert!(status == 404 || status == 400, "traversal got {status}");
}

#[tokio::test]
async fn shutdown_signal_drains_and_stops() {
    let mut server = start("shutdown").await;
    let (status, _, _) = get(server.addr, "/api/healthz").await;
    assert_eq!(status, 200);
    server.stop.take().unwrap().send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), &mut server.task).await;
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
    for addr in ["0.0.0.0:0", "[::]:0", "100.64.0.19:0"] {
        let out = Command::new(env!("CARGO_BIN_EXE_autophys-server"))
            .args(["--addr", addr, "--web"])
            .arg(&web)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{addr}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("not loopback"), "{addr}: {stderr}");
    }
}

#[test]
fn binary_exits_cleanly_on_sigterm() {
    let web = fixture("bin-sigterm");
    let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = probe.local_addr().unwrap();
    drop(probe);
    let mut child = Command::new(env!("CARGO_BIN_EXE_autophys-server"))
        .args(["--addr", &addr.to_string(), "--web"])
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
