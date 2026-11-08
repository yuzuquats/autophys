//! `/api/v1` mounted in the real daemon app (tento-web `DomainConfig`) over a
//! loopback socket: the hook routes to the store, unknown `/api/v1` paths get
//! the store's JSON 404, the keyless-write guard uses the bound port, and SSE
//! frames arrive unbuffered.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use autophys_cli::http::Api;
use autophys_cli::keys::Options;
use autophys_cli::{AppConfig, BuildInfo, http_server, serve, webapp};
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

async fn send(addr: std::net::SocketAddr, head: &str, body: &str) -> (u16, String, String) {
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
    (
        status,
        out.split_once("\r\n\r\n").unwrap().0.to_string(),
        body,
    )
}

#[tokio::test]
async fn the_store_is_mounted_in_the_daemon_app() {
    let dir = tempfile::tempdir().unwrap();
    let api = Api::open(
        &dir.path().join("collection"),
        &dir.path().join("server.db"),
        Options::default(),
    )
    .unwrap();
    let wb = api.client.ensure_project("thermal").unwrap().0;
    let body = br#"{"name":"thermal"}"#;
    let version = format!("sha256:{}", autophys::sha256_hex([&body[..]]));
    wb.put_config_version(&version, body).unwrap();
    wb.create_investigation(json!({"config_version": version}), None)
        .unwrap();

    let config = AppConfig {
        project_root: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        web_root: route_tree(dir.path()),
        store: Some(api),
    };
    let info = BuildInfo {
        web_id: None,
        version: "0.1.0".into(),
        commit: "test".into(),
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = http_server(listener, Arc::new(webapp(&config, info, false).unwrap())).unwrap();
    let handle = server.handle();
    let task = tokio::spawn(serve(server, std::future::pending()));

    let (s, _, _) = send(addr, "GET /api/healthz HTTP/1.1", "").await;
    assert_eq!(s, 200, "the daemon's own routes are untouched");
    let (s, _, _) = send(
        addr,
        "GET /api/v1/workspace HTTP/1.1\r\nSec-Fetch-Site: same-origin",
        "",
    )
    .await;
    assert_eq!(s, 401, "browser headers without a cookie are insufficient");
    let (s, headers, _) = send(addr, "GET / HTTP/1.1", "").await;
    assert_eq!(s, 200);
    let cookies: Vec<_> = headers
        .lines()
        .filter(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
        .map(|line| {
            actix_web::cookie::Cookie::parse(line.split_once(':').unwrap().1.trim()).unwrap()
        })
        .collect();
    let session = cookies
        .iter()
        .find(|cookie| cookie.path() == Some("/") && cookie.value().len() == 64)
        .expect("document session covers reloads and API requests");
    assert_eq!(session.http_only(), Some(true));
    assert_eq!(
        session.same_site(),
        Some(actix_web::cookie::SameSite::Strict)
    );
    let retired = cookies
        .iter()
        .find(|cookie| cookie.name() == session.name() && cookie.path() == Some("/api"))
        .expect("the obsolete API-only cookie is expired");
    assert!(retired.value().is_empty());
    assert_eq!(
        retired.max_age(),
        Some(actix_web::cookie::time::Duration::ZERO)
    );
    let cookie = format!("{}={}", session.name(), session.value());
    let (s, _, ws) = send(
        addr,
        &format!(
            "GET /api/v1/workspace?project={} HTTP/1.1\r\nCookie: {cookie}",
            wb.id()
        ),
        "",
    )
    .await;
    assert_eq!(s, 200, "{ws}");
    assert_eq!(serde_json::from_str::<Value>(&ws).unwrap()["cursor"], 1);
    let (s, _, e) = send(addr, "GET /api/v1/nope HTTP/1.1", "").await;
    assert_eq!(
        (
            s,
            serde_json::from_str::<Value>(&e).unwrap()["error"].clone()
        ),
        (404, json!("not_found"))
    );
    let (s, _, _) = send(addr, "GET /api/v1/whoami HTTP/1.1", "").await;
    assert_eq!(s, 401);

    // O-3 against the real bound port: a foreign Origin is refused; the
    // daemon's own origin passes the guard (and the unknown code is a 404).
    let post = |origin: String| {
        format!(
            "POST /api/v1/pairings/ABCD-1234/approve HTTP/1.1\r\nContent-Type: application/json\r\nOrigin: {origin}\r\nCookie: {cookie}"
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
        "GET /api/v1/stream?after=0&project={} HTTP/1.1\r\nHost: {addr}\r\nCookie: {cookie}\r\n\r\n",
        wb.id()
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
