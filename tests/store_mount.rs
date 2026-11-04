//! `/api/v1` mounted in the real daemon app (tento-web `DomainConfig`) over a
//! loopback socket: the hook routes to the store, unknown `/api/v1` paths get
//! the store's JSON 404, the keyless-write guard uses the bound port, and SSE
//! frames arrive unbuffered.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use autophys::store::{NewInvestigation, Store};
use autophys::{AppConfig, BuildInfo, http_server, serve, webapp};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

fn route_tree(dir: &std::path::Path) -> PathBuf {
    let web = dir.join("web");
    std::fs::create_dir_all(web.join("routes")).unwrap();
    std::fs::write(
        web.join("routes/index.anon.html"),
        "<!doctype html><title>autophys</title>",
    )
    .unwrap();
    web
}

async fn send(addr: std::net::SocketAddr, head: &str, body: &str) -> (u16, String) {
    let mut s = TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "{head}\r\nHost: {addr}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    let status = out.split(' ').nth(1).unwrap().parse().unwrap();
    let body = out
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, body)
}

#[tokio::test]
async fn the_store_is_mounted_in_the_daemon_app() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("autophys.db")).unwrap();
    let (project, _) = store.ensure_project("thermal").await.unwrap();
    let body = br#"{"name":"thermal"}"#;
    let version = format!(
        "sha256:{}",
        autophys::store::canonical::sha256_hex([&body[..]])
    );
    store
        .put_config_version(&project.id, &version, body)
        .await
        .unwrap();
    let req = NewInvestigation {
        project_id: project.id,
        config_version: version,
        ..Default::default()
    };
    store.create_investigation(req, None).await.unwrap();

    let config = AppConfig {
        project_root: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        web_root: route_tree(dir.path()),
        store: Some(store),
    };
    let info = BuildInfo {
        version: "0.1.0".into(),
        commit: "test".into(),
        tento_commit: "test".into(),
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = http_server(listener, Arc::new(webapp(&config, info, false).unwrap())).unwrap();
    let handle = server.handle();
    let task = tokio::spawn(serve(server, std::future::pending()));

    let (s, _) = send(addr, "GET /api/healthz HTTP/1.1", "").await;
    assert_eq!(s, 200, "the daemon's own routes are untouched");
    let (s, ws) = send(
        addr,
        "GET /api/v1/workspace HTTP/1.1\r\nSec-Fetch-Site: same-origin",
        "",
    )
    .await;
    assert_eq!(s, 200, "{ws}");
    assert_eq!(serde_json::from_str::<Value>(&ws).unwrap()["cursor"], 1);
    let (s, e) = send(addr, "GET /api/v1/nope HTTP/1.1", "").await;
    assert_eq!(
        (
            s,
            serde_json::from_str::<Value>(&e).unwrap()["error"].clone()
        ),
        (404, json!("not_found"))
    );
    let (s, _) = send(addr, "GET /api/v1/whoami HTTP/1.1", "").await;
    assert_eq!(s, 401);

    // O-3 against the real bound port: a foreign Origin is refused; the
    // daemon's own origin passes the guard (and the unknown code is a 404).
    let post = |origin: String| {
        format!(
            "POST /api/v1/pairings/ABCD-1234/approve HTTP/1.1\r\nContent-Type: application/json\r\nOrigin: {origin}"
        )
    };
    assert_eq!(
        send(addr, &post("http://evil.example".into()), "{}")
            .await
            .0,
        403
    );
    assert_eq!(
        send(
            addr,
            &post(format!("http://127.0.0.1:{}", addr.port())),
            "{}"
        )
        .await
        .0,
        404
    );
    assert_eq!(
        send(
            addr,
            &post(format!("http://localhost:{}", addr.port())),
            "{}"
        )
        .await
        .0,
        404
    );

    // SSE: the first frame arrives without waiting for the response to end.
    let mut s = TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "GET /api/v1/stream?after=0 HTTP/1.1\r\nHost: {addr}\r\nSec-Fetch-Site: same-origin\r\n\r\n"
    );
    s.write_all(head.as_bytes()).await.unwrap();
    let mut seen = String::new();
    let mut buf = [0u8; 4096];
    let read = tokio::time::timeout(Duration::from_secs(3), async {
        while !seen.contains("event: record") {
            let n = s.read(&mut buf).await.unwrap();
            assert!(n > 0, "stream closed early: {seen}");
            seen.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
    })
    .await;
    assert!(read.is_ok(), "no SSE frame within 3 s: {seen:?}");
    assert!(
        seen.to_ascii_lowercase()
            .contains("content-type: text/event-stream"),
        "{seen}"
    );
    assert!(seen.contains("id: 1\n"), "{seen}");

    // No drain: an open SSE response would hold a graceful stop to its
    // 10 s shutdown timeout.
    handle.stop(false).await;
    let _ = task.await;
}
