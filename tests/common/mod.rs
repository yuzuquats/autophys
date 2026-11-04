//! Shared test helpers: a store in a temp dir, an actix test service, a
//! paired key, and request shorthands.
#![allow(dead_code)]

use std::pin::Pin;
use std::time::Duration;

use actix_web::body::MessageBody;
use actix_web::dev::{Service, ServiceResponse};
use actix_web::test::{self, TestRequest};
use autophys::store::{Options, Store};
use serde_json::Value;
use tempfile::TempDir;

pub struct Fixture {
    pub store: Store,
    pub dir: TempDir,
}

pub fn options() -> Options {
    Options {
        poll_interval: Duration::ZERO,
        ..Options::default()
    }
}

pub fn fixture_with(opts: Options) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_with(dir.path().join("autophys.db"), opts).unwrap();
    Fixture { store, dir }
}

pub fn fixture() -> Fixture {
    fixture_with(options())
}

/// Send `req`, return status and JSON body (Null when empty).
pub async fn call<S, R, B>(app: &S, req: R) -> (u16, Value)
where
    S: Service<R, Response = ServiceResponse<B>, Error = actix_web::Error>,
    B: MessageBody,
{
    let resp = test::call_service(app, req).await;
    let status = resp.status().as_u16();
    let body = test::read_body(resp).await;
    let json = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&body).into()))
    };
    (status, json)
}

pub fn get(path: &str, key: Option<&str>) -> TestRequest {
    with_key(TestRequest::get().uri(&format!("/api/v1{path}")), key)
}

pub fn post(path: &str, key: Option<&str>, body: &Value) -> TestRequest {
    with_key(TestRequest::post().uri(&format!("/api/v1{path}")), key)
        .insert_header(("content-type", "application/json"))
        .set_payload(body.to_string())
}

pub fn put_raw(path: &str, key: Option<&str>, body: &[u8]) -> TestRequest {
    with_key(TestRequest::put().uri(&format!("/api/v1{path}")), key)
        .insert_header(("content-type", "application/json"))
        .set_payload(body.to_vec())
}

fn with_key(req: TestRequest, key: Option<&str>) -> TestRequest {
    match key {
        Some(k) => req.insert_header(("authorization", format!("Bearer {k}"))),
        None => req,
    }
}

/// The test server's own origin (actix test services bind 127.0.0.1:8080).
pub const ORIGIN: &str = "http://127.0.0.1:8080";

/// Headers a same-origin page on the daemon's loopback origin sends.
pub fn browser(req: TestRequest, with_origin: bool) -> TestRequest {
    let req = req
        .insert_header(("host", "127.0.0.1:8080"))
        .insert_header(("sec-fetch-site", "same-origin"))
        .peer_addr("127.0.0.1:50000".parse().unwrap());
    if with_origin {
        req.insert_header(("origin", ORIGIN))
    } else {
        req
    }
}

/// Pair a device over HTTP and approve it the way the CLI does.
pub async fn pair<S, B>(app: &S, store: &Store, device: &str) -> String
where
    S: Service<actix_http::Request, Response = ServiceResponse<B>, Error = actix_web::Error>,
    B: MessageBody,
{
    let (s, start) = call(
        app,
        post(
            "/pair/start",
            None,
            &serde_json::json!({"device_name": device, "client": "test"}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 200, "{start}");
    store
        .pair_approve(start["user_code"].as_str().unwrap())
        .await
        .unwrap();
    let (s, issued) = call(
        app,
        post(
            "/pair/poll",
            None,
            &serde_json::json!({"device_code": start["device_code"]}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 200, "{issued}");
    issued["api_key"].as_str().unwrap().to_string()
}

/// Read SSE frames from a streaming response until `n` `record` events have
/// arrived (or two seconds pass). Returns `(gseq, record)` pairs.
pub async fn sse_records<B: MessageBody + Unpin>(body: &mut B, n: usize) -> Vec<(i64, Value)>
where
    B::Error: std::fmt::Debug,
{
    let mut buf = String::new();
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while out.len() < n {
        let chunk = tokio::time::timeout_at(
            deadline,
            std::future::poll_fn(|cx| Pin::new(&mut *body).poll_next(cx)),
        )
        .await
        .unwrap_or_else(|_| panic!("timed out with {} of {n} events: {buf:?}", out.len()));
        let Some(chunk) = chunk else { break };
        buf.push_str(std::str::from_utf8(&chunk.unwrap()).unwrap());
        while let Some(end) = buf.find("\n\n") {
            let frame: String = buf.drain(..end + 2).collect();
            let (mut id, mut data, mut is_record) = (None, None, false);
            for line in frame.lines() {
                if let Some(v) = line.strip_prefix("id: ") {
                    id = v.parse::<i64>().ok();
                } else if let Some(v) = line.strip_prefix("data: ") {
                    data = serde_json::from_str::<Value>(v).ok();
                } else if line == "event: record" {
                    is_record = true;
                }
            }
            if is_record {
                out.push((id.unwrap(), data.unwrap()));
            }
        }
    }
    out
}
