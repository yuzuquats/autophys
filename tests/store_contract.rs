//! HTTP contract tests for every `/api/v1` route: the SDK's fake server
//! (`hacks-site/exp/modellab/python/tests/fake_server.py`) made real, plus the
//! browser routes, auth, the proposal state machine and SSE resume.

mod common;

use actix_web::{App, test};
use autophys::{GENESIS, chain_hash, sha256_hex};
use autophys_cli::http::configure;
use autophys_cli::keys::Options;
use common::*;
use serde_json::{Value, json};

macro_rules! app {
    ($store:expr) => {{
        let api = $store.clone();
        test::init_service(App::new().configure(move |cfg| configure(cfg, api.clone()))).await
    }};
}

const CONFIG: &[u8] = br#"{"name":"thermal","x":1.5}"#;

/// Object keys in sorted order: serde_json may preserve insertion order
/// (its `preserve_order` feature is on in the daemon build).
fn sorted_keys(v: &Value) -> Vec<String> {
    let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

fn version() -> String {
    format!("sha256:{}", sha256_hex([CONFIG]))
}

fn env(id: &str, kind: &str, payload: Value) -> Value {
    json!({"id": id, "kind": kind, "payload": payload})
}

fn proposed(pid: &str) -> Value {
    json!({"proposal_id": pid, "event": "proposed", "experiment": "sine", "settings": {"f": 0.44}})
}

/// A project, its config version and one investigation; returns (key, inv).
async fn seeded<S, B>(app: &S, api: &autophys_cli::http::Api) -> (String, String)
where
    S: actix_web::dev::Service<
            actix_http::Request,
            Response = actix_web::dev::ServiceResponse<B>,
            Error = actix_web::Error,
        >,
    B: actix_web::body::MessageBody,
{
    let key = pair(app, api, "lab-pc").await;
    let k = Some(key.as_str());
    let (_, p) = call(
        app,
        post("/projects", k, &json!({"name": "thermal"})).to_request(),
    )
    .await;
    let pid = p["project"]["id"].as_str().unwrap().to_string();
    let (s, _) = call(
        app,
        put_raw(
            &format!("/projects/{pid}/config_versions/{}", version()),
            k,
            CONFIG,
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 201);
    let body = json!({"project_id": pid, "config_version": version(), "overrides": {"free": ["C"]}, "meta": {"name": "thermal"}});
    let (s, inv) = call(app, post("/investigations", k, &body).to_request()).await;
    assert_eq!(s, 201, "{inv}");
    (key, inv["id"].as_str().unwrap().to_string())
}

#[actix_web::test]
async fn pairing_issues_a_key_once_and_stores_only_hashes() {
    let f = fixture();
    let app = app!(f.api);
    let (s, start) = call(
        &app,
        post(
            "/pair/start",
            None,
            &json!({"device_name": "lab-pc", "client": "modellab-python/0.1"}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 200);
    for field in [
        "device_code",
        "user_code",
        "verification_url",
        "interval",
        "expires_in",
    ] {
        assert!(start.get(field).is_some(), "{field} missing: {start}");
    }
    let code = json!({"device_code": start["device_code"]});
    let (s, pending) = call(&app, post("/pair/poll", None, &code).to_request()).await;
    assert_eq!(
        (s, pending["error"].as_str()),
        (400, Some("authorization_pending"))
    );

    assert!(f.api.keys.pair_approve("NOPE-0000").is_err());
    // People type codes loosely; approval normalises them.
    let typed = start["user_code"]
        .as_str()
        .unwrap()
        .replace('-', " ")
        .to_lowercase();
    let approved = f.api.keys.pair_approve(&typed).unwrap();
    assert_eq!(approved.device_name, "lab-pc");

    let (s, issued) = call(&app, post("/pair/poll", None, &code).to_request()).await;
    assert_eq!(s, 200, "{issued}");
    let api_key = issued["api_key"].as_str().unwrap().to_string();
    assert!(api_key.starts_with("apk_"));
    assert_eq!(issued["workspace"], "local");
    let (s, again) = call(&app, post("/pair/poll", None, &code).to_request()).await;
    assert_eq!((s, again["error"].as_str()), (400, Some("expired_token")));

    let (s, me) = call(&app, get("/whoami", Some(&api_key)).to_request()).await;
    assert_eq!(s, 200);
    assert_eq!(me["device_name"], "lab-pc");
    assert_eq!(me["key_id"], issued["key_id"]);
    assert!(!me.to_string().contains(&api_key));

    // Neither secret is anywhere on disk, and no listing shows the key.
    let keys = f.api.keys.keys_list().unwrap();
    assert_eq!(keys.len(), 1);
    assert!(!format!("{keys:?}").contains(&api_key));
    let device_code = start["device_code"].as_str().unwrap();
    for name in ["autophys.db", "autophys.db-wal"] {
        if let Ok(bytes) = std::fs::read(f.dir.path().join(name)) {
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains(&api_key), "{name} holds the key");
            assert!(!text.contains(device_code), "{name} holds the device code");
        }
    }
    let fresh = f.api.keys.pair_start("x", "y").unwrap();
    assert!(
        !format!("{fresh:?}").contains(&fresh.device_code),
        "Debug never prints the device code"
    );
    assert!(!format!("{issued:?}").is_empty());
}

#[actix_web::test]
async fn pairing_denied_expired_and_slow_down() {
    let f = fixture_with(Options {
        poll_interval: std::time::Duration::from_secs(5),
        ..options()
    });
    let app = app!(f.api);
    let start = f.api.keys.pair_start("a", "t").unwrap();
    let code = json!({"device_code": start.device_code});
    let (_, first) = call(&app, post("/pair/poll", None, &code).to_request()).await;
    assert_eq!(first["error"], "authorization_pending");
    let (s, fast) = call(&app, post("/pair/poll", None, &code).to_request()).await;
    assert_eq!((s, fast["error"].as_str()), (400, Some("slow_down")));
    f.api.keys.pair_deny(&start.user_code).unwrap();
    let (_, denied) = call(&app, post("/pair/poll", None, &code).to_request()).await;
    assert_eq!(denied["error"], "access_denied");

    let g = fixture_with(Options {
        pairing_ttl: std::time::Duration::ZERO,
        ..options()
    });
    let app = app!(g.api);
    let start = g.api.keys.pair_start("b", "t").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let (_, expired) = call(
        &app,
        post(
            "/pair/poll",
            None,
            &json!({"device_code": start.device_code}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(expired["error"], "expired_token");
    assert!(
        g.api.keys.pair_approve(&start.user_code).is_err(),
        "an expired code cannot be approved"
    );
    let (_, unknown) = call(
        &app,
        post("/pair/poll", None, &json!({"device_code": "nope"})).to_request(),
    )
    .await;
    assert_eq!(unknown["error"], "expired_token");
}

#[actix_web::test]
async fn every_keyed_route_refuses_missing_wrong_and_revoked_keys() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    // (method, path); the keyless-write routes answer 403, not 401, when no
    // key is sent (O-3), and are covered by their own test.
    let routes: Vec<(&str, String)> = vec![
        ("GET", "/whoami".into()),
        ("GET", "/projects".into()),
        ("POST", "/projects".into()),
        ("GET", "/projects/p/config_versions".into()),
        ("PUT", "/projects/p/config_versions/v".into()),
        ("PUT", format!("/projects/p/blobs/{}", "0".repeat(64))),
        ("GET", format!("/projects/p/blobs/{}", "0".repeat(64))),
        ("GET", "/investigations".into()),
        ("POST", "/investigations".into()),
        ("GET", format!("/investigations/{inv}/records")),
        ("POST", format!("/investigations/{inv}/records")),
        ("POST", format!("/investigations/{inv}/measurements")),
        ("POST", format!("/investigations/{inv}/runs")),
        ("POST", format!("/investigations/{inv}/steps")),
        ("POST", format!("/investigations/{inv}/outcome")),
        ("POST", format!("/investigations/{inv}/proposals")),
        ("GET", format!("/investigations/{inv}/proposals/p1")),
        ("POST", format!("/investigations/{inv}/proposals/p1/data")),
        ("GET", "/workspace".into()),
        ("GET", "/stream".into()),
        ("GET", "/pairings".into()),
    ];
    let request = |method: &str, path: &str, k: Option<&str>| match method {
        "GET" => get(path, k),
        "PUT" => put_raw(path, k, b"{}"),
        _ => post(path, k, &json!({})),
    };
    for (method, path) in &routes {
        for k in [None, Some("apk_wrong")] {
            let (s, body) = call(&app, request(method, path, k).to_request()).await;
            assert_eq!(
                (s, body["error"].as_str()),
                (401, Some("unauthorized")),
                "{method} {path} key={k:?}"
            );
        }
    }
    // Browser headers do not open the SDK-only routes.
    for (method, path) in &routes[..16] {
        let (s, _) = call(
            &app,
            browser(&f.api, request(method, path, None), true).to_request(),
        )
        .await;
        assert_eq!(s, 401, "{method} {path} must need a key");
    }
    let id = f.api.keys.keys_list().unwrap()[0].id.clone();
    assert!(f.api.keys.keys_revoke(&id).unwrap());
    assert!(
        !f.api.keys.keys_revoke(&id).unwrap(),
        "second revoke reports already revoked"
    );
    assert!(f.api.keys.keys_revoke("k_missing").is_err());
    let (s, _) = call(&app, get("/whoami", Some(&key)).to_request()).await;
    assert_eq!(s, 401, "a revoked key is refused");
    assert!(f.api.keys.keys_list().unwrap()[0].revoked.is_some());
}

#[actix_web::test]
async fn browser_session_opens_only_browser_routes_and_headers_alone_do_not() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    call(
        &app,
        post(
            &format!("/investigations/{inv}/proposals"),
            Some(&key),
            &env("rp", "proposal", proposed("p1")),
        )
        .to_request(),
    )
    .await;

    let headers_only = get("/workspace", None)
        .insert_header(("host", "127.0.0.1:8080"))
        .insert_header(("sec-fetch-site", "same-origin"));
    assert_eq!(call(&app, headers_only.to_request()).await.0, 401);
    let forged = get("/workspace", None).insert_header(("cookie", "autophys_session=forged"));
    assert_eq!(call(&app, forged.to_request()).await.0, 401);
    let (s, ws) = call(
        &app,
        browser(&f.api, get("/workspace", None), false).to_request(),
    )
    .await;
    assert_eq!(s, 200, "{ws}");

    let cross = get("/workspace", None)
        .insert_header(("host", "127.0.0.1:8080"))
        .insert_header(("sec-fetch-site", "cross-site"));
    assert_eq!(call(&app, cross.to_request()).await.0, 401, "cross-site");
    let rebind = get("/workspace", None)
        .insert_header(("host", "evil.example:8080"))
        .insert_header(("sec-fetch-site", "same-origin"));
    assert_eq!(
        call(&app, rebind.to_request()).await.0,
        401,
        "DNS rebinding host"
    );
    let proxied = get("/workspace", None)
        .cookie(f.api.sessions.issue_cookie().unwrap())
        .insert_header(("host", "autophys.rwc-dev-01.tento.localhost"));
    assert_eq!(
        call(&app, proxied.to_request()).await.0,
        200,
        "tento.localhost proxy host"
    );
    let remote = browser(&f.api, get("/workspace", None), false)
        .peer_addr("100.64.0.9:5000".parse().unwrap());
    assert_eq!(
        call(&app, remote.to_request()).await.0,
        403,
        "non-loopback peer"
    );
}

/// O-3: keyless writes are JSON from the daemon's own origin; keyed calls
/// need neither.
#[actix_web::test]
async fn keyless_writes_refuse_cross_origin_and_form_posts() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    let base = format!("/investigations/{inv}/proposals");
    call(
        &app,
        post(&base, Some(&key), &env("rp1", "proposal", proposed("p1"))).to_request(),
    )
    .await;
    call(
        &app,
        post(&base, Some(&key), &env("rp2", "proposal", proposed("p2"))).to_request(),
    )
    .await;
    let approve = |id: &str, pid: &str| {
        env(
            id,
            "proposal",
            json!({"proposal_id": pid, "event": "approved", "by": "dashboard"}),
        )
    };
    let path = format!("{base}/p1/approvals");

    let (s, e) = call(
        &app,
        browser(&f.api, post(&path, None, &approve("a1", "p1")), false).to_request(),
    )
    .await;
    assert_eq!(
        (s, e["error"].as_str()),
        (403, Some("forbidden")),
        "no Origin"
    );
    let cross = browser(&f.api, post(&path, None, &approve("a1", "p1")), false)
        .insert_header(("origin", "http://evil.example"));
    assert_eq!(
        call(&app, cross.to_request()).await.0,
        403,
        "cross-origin JSON POST"
    );
    let other_port = browser(&f.api, post(&path, None, &approve("a1", "p1")), false)
        .insert_header(("origin", "http://127.0.0.1:9999"));
    assert_eq!(
        call(&app, other_port.to_request()).await.0,
        403,
        "another local origin"
    );
    let form = actix_web::test::TestRequest::post()
        .uri(&format!("/api/v1{path}"))
        .insert_header(("content-type", "application/x-www-form-urlencoded"))
        .insert_header(("origin", "http://evil.example"))
        .set_payload("id=a1&kind=proposal");
    let (s, e) = call(&app, form.to_request()).await;
    assert_eq!(
        (s, e["error"].as_str()),
        (415, Some("unsupported_media_type")),
        "form-encoded POST"
    );
    let text = browser(&f.api, post(&path, None, &approve("a1", "p1")), true)
        .insert_header(("content-type", "text/plain"));
    assert_eq!(
        call(&app, text.to_request()).await.0,
        415,
        "text/plain POST"
    );
    let (_, p) = call(&app, get(&format!("{base}/p1"), Some(&key)).to_request()).await;
    assert_eq!(p["status"], "proposed", "nothing refused was written");

    let missing_cookie = post(&path, None, &approve("a1", "p1")).insert_header(("origin", ORIGIN));
    assert_eq!(call(&app, missing_cookie.to_request()).await.0, 401);
    let (s, rec) = call(
        &app,
        browser(&f.api, post(&path, None, &approve("a1", "p1")), true).to_request(),
    )
    .await;
    assert_eq!(s, 201, "same-origin JSON POST: {rec}");
    let localhost = browser(
        &f.api,
        post(&format!("{base}/p2/approvals"), None, &approve("a2", "p2")),
        false,
    )
    .insert_header(("origin", "http://localhost:8080"));
    assert_eq!(
        call(&app, localhost.to_request()).await.0,
        201,
        "http://localhost:<port> is ours too"
    );

    // The SDK sends a key and no Origin.
    call(
        &app,
        post(&base, Some(&key), &env("rp3", "proposal", proposed("p3"))).to_request(),
    )
    .await;
    let (s, _) = call(
        &app,
        post(
            &format!("{base}/p3/approvals"),
            Some(&key),
            &approve("a3", "p3"),
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 201, "keyed call without Origin");
}

/// UI-27: the built-in Thermal starter is gone with its API; no caller, a
/// same-origin browser or a keyed device, can create a project or start a
/// daemon-side simulation through `/workbench`.
#[actix_web::test]
async fn workbench_starter_routes_are_removed() {
    let f = fixture();
    let app = app!(f.api);
    let (key, _) = seeded(&app, &f.api).await;
    let projects = f.api.client.projects().unwrap().len();
    let setup = json!({"name": "Browser project", "model": "thermal_rc",
        "c": 400., "r": 1.5, "power": 10., "duration": 600.});
    let pid = f.api.client.projects().unwrap()[0].id.clone();
    for path in [
        "/workbench/projects".to_string(),
        format!("/workbench/projects/{pid}/investigations"),
    ] {
        let (s, _) = call(
            &app,
            browser(&f.api, post(&path, None, &setup), true).to_request(),
        )
        .await;
        assert_eq!(s, 404, "browser {path}");
        let (s, _) = call(&app, post(&path, Some(&key), &setup).to_request()).await;
        assert_eq!(s, 404, "keyed {path}");
    }
    assert_eq!(f.api.client.projects().unwrap().len(), projects);
}

/// O-3: the browser lists and decides pairings; nothing secret is shown.
#[actix_web::test]
async fn browser_approves_and_denies_pairings() {
    let f = fixture();
    let app = app!(f.api);
    let start = |name: &'static str| {
        post(
            "/pair/start",
            None,
            &json!({"device_name": name, "client": "modellab-python/0.1"}),
        )
    };
    let (_, a) = call(&app, start("laptop").to_request()).await;
    let (_, b) = call(&app, start("lab-pc").to_request()).await;

    let (s, list) = call(
        &app,
        browser(&f.api, get("/pairings", None), false).to_request(),
    )
    .await;
    assert_eq!(s, 200, "{list}");
    let rows = list["pairings"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        sorted_keys(&rows[0]),
        ["client", "device_name", "expires", "user_code"]
    );
    assert!(
        !list
            .to_string()
            .contains(a["device_code"].as_str().unwrap())
    );

    let code_a = a["user_code"].as_str().unwrap();
    let approve = format!("/pairings/{code_a}/approve");
    let (s, _) = call(
        &app,
        browser(&f.api, post(&approve, None, &json!({})), false)
            .insert_header(("origin", "http://evil.example"))
            .to_request(),
    )
    .await;
    assert_eq!(s, 403, "cross-origin approve");
    let (s, _) = call(
        &app,
        browser(&f.api, post(&approve, None, &json!({})), true)
            .insert_header(("content-type", "application/x-www-form-urlencoded"))
            .to_request(),
    )
    .await;
    assert_eq!(s, 415, "form approve");
    let (s, done) = call(
        &app,
        browser(&f.api, post(&approve, None, &json!({})), true).to_request(),
    )
    .await;
    assert_eq!(
        (s, done["pairing"]["device_name"].as_str()),
        (200, Some("laptop"))
    );
    let (s, _) = call(
        &app,
        browser(&f.api, post(&approve, None, &json!({})), true).to_request(),
    )
    .await;
    assert_eq!(s, 404, "an approved code is no longer pending");
    let (s, issued) = call(
        &app,
        post(
            "/pair/poll",
            None,
            &json!({"device_code": a["device_code"]}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 200);
    assert!(issued["api_key"].as_str().unwrap().starts_with("apk_"));

    let code_b = b["user_code"].as_str().unwrap();
    let (s, _) = call(
        &app,
        browser(
            &f.api,
            post(&format!("/pairings/{code_b}/deny"), None, &json!({})),
            true,
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 200);
    let (_, denied) = call(
        &app,
        post(
            "/pair/poll",
            None,
            &json!({"device_code": b["device_code"]}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(denied["error"], "access_denied");
    let (_, list) = call(
        &app,
        browser(&f.api, get("/pairings", None), false).to_request(),
    )
    .await;
    assert_eq!(list["pairings"], json!([]));
    assert_eq!(
        call(&app, get("/pairings", None).to_request()).await.0,
        401,
        "no key, no browser"
    );
}

#[actix_web::test]
async fn blobs_are_put_by_hash_and_read_back() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "d").await;
    let k = Some(key.as_str());
    let (_, p) = call(
        &app,
        post("/projects", k, &json!({"name": "thermal"})).to_request(),
    )
    .await;
    let pid = p["project"]["id"].as_str().unwrap();
    let skill = b"# Playbook\nFit first, then rank.\n";
    let hash = sha256_hex([&skill[..]]);
    let path = format!("/projects/{pid}/blobs/{hash}");
    let put = |path: &str, body: &[u8], media: Option<&str>| {
        let req = actix_web::test::TestRequest::put()
            .uri(&format!("/api/v1{path}"))
            .insert_header(("authorization", format!("Bearer {key}")))
            .set_payload(body.to_vec());
        match media {
            Some(m) => req.insert_header(("content-type", m)),
            None => req,
        }
        .to_request()
    };
    let (s, v) = call(&app, put(&path, skill, Some("text/markdown"))).await;
    assert_eq!((s, v["sha256"].as_str()), (201, Some(hash.as_str())));
    assert_eq!(
        call(&app, put(&path, skill, Some("text/markdown"))).await.0,
        200,
        "idempotent"
    );
    let (s, e) = call(&app, put(&path, b"other bytes", Some("text/markdown"))).await;
    assert_eq!((s, e["error"].as_str()), (422, Some("hash_mismatch")));
    let (s, e) = call(&app, put(&path, skill, None)).await;
    assert_eq!((s, e["path"].as_str()), (422, Some("Content-Type")));
    let (s, e) = call(
        &app,
        put(
            &format!("/projects/{pid}/blobs/sha256:{hash}"),
            skill,
            Some("text/markdown"),
        ),
    )
    .await;
    assert_eq!(
        (s, e["path"].as_str()),
        (422, Some("sha256")),
        "bare hex only"
    );
    let (s, _) = call(
        &app,
        put(
            &format!("/projects/prj_nope/blobs/{hash}"),
            skill,
            Some("text/markdown"),
        ),
    )
    .await;
    assert_eq!(s, 404);

    let resp = actix_web::test::call_service(&app, get(&path, k).to_request()).await;
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "text/markdown");
    assert_eq!(&actix_web::test::read_body(resp).await[..], &skill[..]);
    let (s, _) = call(
        &app,
        get(&format!("/projects/{pid}/blobs/{}", "f".repeat(64)), k).to_request(),
    )
    .await;
    assert_eq!(s, 404);
}

#[actix_web::test]
async fn projects_and_config_versions() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "d").await;
    let k = Some(key.as_str());
    let (s, a) = call(
        &app,
        post("/projects", k, &json!({"name": "thermal"})).to_request(),
    )
    .await;
    assert_eq!(s, 201);
    let (s, b) = call(
        &app,
        post("/projects", k, &json!({"name": "thermal"})).to_request(),
    )
    .await;
    assert_eq!(s, 200, "idempotent by name");
    assert_eq!(a["project"]["id"], b["project"]["id"]);
    let (s, bad) = call(&app, post("/projects", k, &json!({})).to_request()).await;
    assert_eq!((s, bad["path"].as_str()), (422, Some("name")));
    let (_, list) = call(&app, get("/projects", k).to_request()).await;
    assert_eq!(list["projects"].as_array().unwrap().len(), 1);

    let pid = a["project"]["id"].as_str().unwrap();
    let path = format!("/projects/{pid}/config_versions/{}", version());
    let (s, v) = call(&app, put_raw(&path, k, CONFIG).to_request()).await;
    assert_eq!((s, v["version"].as_str()), (201, Some(version().as_str())));
    assert_eq!(
        call(&app, put_raw(&path, k, CONFIG).to_request()).await.0,
        200
    );
    let (s, mismatch) = call(&app, put_raw(&path, k, br#"{"name":"other"}"#).to_request()).await;
    assert_eq!(
        (s, mismatch["error"].as_str()),
        (422, Some("hash_mismatch"))
    );
    let (s, _) = call(
        &app,
        put_raw(
            &format!("/projects/prj_nope/config_versions/{}", version()),
            k,
            CONFIG,
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 404);
    let (s, list) = call(
        &app,
        get(&format!("/projects/{pid}/config_versions"), k).to_request(),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(
        list["config_versions"],
        json!([{"version": version(), "config": {"name": "thermal", "x": 1.5}}])
    );
    assert_eq!(
        call(
            &app,
            get("/projects/prj_nope/config_versions", k).to_request()
        )
        .await
        .0,
        404
    );
}

#[actix_web::test]
async fn investigations_pin_a_config_and_replay_by_idempotency_key() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    let k = Some(key.as_str());
    let (s, e) = call(
        &app,
        post(
            "/investigations",
            k,
            &json!({"project_id": "prj_nope", "config_version": "sha256:00"}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(
        (s, e["error"].as_str()),
        (409, Some("unknown_config_version"))
    );
    let (s, e) = call(
        &app,
        post("/investigations", k, &json!({"config_version": "x"})).to_request(),
    )
    .await;
    assert_eq!((s, e["path"].as_str()), (422, Some("project_id")));

    let (_, list) = call(&app, get("/investigations", k).to_request()).await;
    let row = &list["investigations"][0];
    let pid = row["project_id"].as_str().unwrap().to_string();
    assert_eq!(row["id"], inv.as_str());
    assert_eq!(row["overrides"], json!({"free": ["C"]}));
    assert_eq!(row["status"], "open");

    let body = json!({"project_id": pid, "config_version": version(), "meta": {}});
    let req = || post("/investigations", k, &body).insert_header(("idempotency-key", "create-1"));
    let (s1, a) = call(&app, req().to_request()).await;
    let (s2, b) = call(&app, req().to_request()).await;
    assert_eq!((s1, s2), (201, 200));
    assert_eq!(a["id"], b["id"]);

    let (_, recs) = call(
        &app,
        get(&format!("/investigations/{inv}/records"), k).to_request(),
    )
    .await;
    let first = &recs["records"][0];
    assert_eq!(
        (first["seq"].as_i64(), first["kind"].as_str()),
        (Some(0), Some("investigation"))
    );
    assert_eq!(first["prev_hash"], GENESIS);
    assert_eq!(first["payload"]["name"], "thermal");
    assert_eq!(first["payload"]["project_id"], pid.as_str());
    assert_eq!(
        sorted_keys(first),
        [
            "hash",
            "id",
            "investigation",
            "kind",
            "payload",
            "prev_hash",
            "seq",
            "ts"
        ],
        "exactly the SDK Record fields"
    );
    assert_eq!(
        call(
            &app,
            get("/investigations/inv_nope/records", k).to_request()
        )
        .await
        .0,
        404
    );
}

#[actix_web::test]
async fn appends_are_idempotent_validated_and_routed_by_kind() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    let k = Some(key.as_str());
    let runs = format!("/investigations/{inv}/runs");
    let run = env("abc", "run", json!({"loss": 1.0}));
    let (s1, r1) = call(
        &app,
        post(&runs, k, &run)
            .insert_header(("idempotency-key", "abc"))
            .to_request(),
    )
    .await;
    let (s2, r2) = call(
        &app,
        post(&runs, k, &run)
            .insert_header(("idempotency-key", "abc"))
            .to_request(),
    )
    .await;
    assert_eq!(
        (s1, s2),
        (201, 200),
        "first write creates, replay returns the stored record"
    );
    assert_eq!(r1, r2);
    assert_eq!(r1["record"]["seq"], 1);

    let (s, e) = call(
        &app,
        post(&runs, k, &env("abc", "run", json!({"loss": 2.0}))).to_request(),
    )
    .await;
    assert_eq!(
        (s, e["error"].as_str()),
        (409, Some("idempotency_conflict"))
    );
    let (s, _) = call(
        &app,
        post(&runs, k, &env("x1", "run", json!({})))
            .insert_header(("idempotency-key", "other"))
            .to_request(),
    )
    .await;
    assert_eq!(s, 400, "Idempotency-Key must equal the envelope id");
    let (s, e) = call(
        &app,
        post(&runs, k, &env("x2", "step", json!({}))).to_request(),
    )
    .await;
    assert_eq!(
        (s, e["error"].as_str()),
        (400, Some("invalid_request")),
        "kind must match the route"
    );
    let (s, e) = call(
        &app,
        post(
            &format!("/investigations/{inv}/measurements"),
            k,
            &env("x3", "measurement", json!({"version": 1})),
        )
        .to_request(),
    )
    .await;
    assert_eq!((s, e["path"].as_str()), (422, Some("payload.observation")));
    let (s, e) = call(
        &app,
        post(
            &format!("/investigations/{inv}/outcome"),
            k,
            &env("x4", "outcome", json!({})),
        )
        .to_request(),
    )
    .await;
    assert_eq!((s, e["path"].as_str()), (422, Some("payload.status")));
    let (s, e) = call(
        &app,
        post(
            &runs,
            k,
            &json!({"id": "x5", "kind": "run", "payload": [1]}),
        )
        .to_request(),
    )
    .await;
    assert_eq!((s, e["path"].as_str()), (422, Some("payload")));
    let (s, _) = call(&app, post(&runs, k, &json!("not an object")).to_request()).await;
    assert_eq!(s, 422);
    let bad_json = post(&runs, k, &json!({})).set_payload("{nope");
    assert_eq!(call(&app, bad_json.to_request()).await.0, 400);
    let (s, _) = call(
        &app,
        post(
            "/investigations/inv_nope/runs",
            k,
            &env("x6", "run", json!({})),
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 404);
    let big = env("x7", "run", json!({"blob": "x".repeat(1 << 20)}));
    assert_eq!(call(&app, post(&runs, k, &big).to_request()).await.0, 413);

    for (route, kind, payload) in [
        (
            "measurements",
            "measurement",
            json!({"version": 2, "observation": {"experiment": "step"}}),
        ),
        ("steps", "step", json!({"action": "fit"})),
        ("outcome", "outcome", json!({"status": "validated"})),
    ] {
        let (s, r) = call(
            &app,
            post(
                &format!("/investigations/{inv}/{route}"),
                k,
                &env(&format!("ok-{kind}"), kind, payload),
            )
            .to_request(),
        )
        .await;
        assert_eq!(s, 201, "{route}: {r}");
    }
    let (_, only) = call(
        &app,
        get(&format!("/investigations/{inv}/records?kind=run"), k).to_request(),
    )
    .await;
    assert_eq!(only["records"].as_array().unwrap().len(), 1);
    let (s, e) = call(
        &app,
        get(&format!("/investigations/{inv}/records?kind=bogus"), k).to_request(),
    )
    .await;
    assert_eq!((s, e["path"].as_str()), (422, Some("kind")));
    let (_, list) = call(&app, get("/investigations", k).to_request()).await;
    assert_eq!(list["investigations"][0]["status"], "validated");
    assert_eq!(list["investigations"][0]["budget_used"], 1);
}

#[actix_web::test]
async fn proposal_state_machine() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    let k = Some(key.as_str());
    let base = format!("/investigations/{inv}/proposals");
    let ev = |id: &str, pid: &str, event: &str| {
        env(
            id,
            "proposal",
            json!({"proposal_id": pid, "event": event, "by": "test", "measurement_version": 3}),
        )
    };

    let (s, _) = call(
        &app,
        post(
            &format!("{base}/p1/approvals"),
            k,
            &ev("e0", "p1", "approved"),
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 404, "approving an unknown proposal");
    assert_eq!(
        call(
            &app,
            post(&base, k, &env("e1", "proposal", proposed("p1"))).to_request()
        )
        .await
        .0,
        201
    );
    let (s, e) = call(
        &app,
        post(&base, k, &env("e1b", "proposal", proposed("p1"))).to_request(),
    )
    .await;
    assert_eq!((s, e["error"].as_str()), (409, Some("proposal_exists")));
    let (s, p) = call(&app, get(&format!("{base}/p1"), k).to_request()).await;
    assert_eq!(
        (s, p["status"].as_str(), p["experiment"].as_str()),
        (200, Some("proposed"), Some("sine"))
    );
    assert_eq!(
        call(&app, get(&format!("{base}/p404"), k).to_request())
            .await
            .0,
        404
    );

    let (s, e) = call(
        &app,
        post(
            &format!("{base}/p1/data"),
            k,
            &ev("e2", "p1", "data_attached"),
        )
        .to_request(),
    )
    .await;
    assert_eq!(
        (s, e["error"].as_str()),
        (409, Some("conflict")),
        "data before approval"
    );
    let (s, e) = call(
        &app,
        post(
            &format!("{base}/p1/approvals"),
            k,
            &ev("e3", "p1", "data_attached"),
        )
        .to_request(),
    )
    .await;
    assert_eq!(
        (s, e["path"].as_str()),
        (422, Some("payload.event")),
        "approvals takes decisions only"
    );
    let (s, e) = call(
        &app,
        post(
            &format!("{base}/p1/approvals"),
            k,
            &ev("e4", "p2", "approved"),
        )
        .to_request(),
    )
    .await;
    assert_eq!((s, e["path"].as_str()), (422, Some("payload.proposal_id")));
    let edited_without = env(
        "e5",
        "proposal",
        json!({"proposal_id": "p1", "event": "edited"}),
    );
    let (s, e) = call(
        &app,
        post(&format!("{base}/p1/approvals"), k, &edited_without).to_request(),
    )
    .await;
    assert_eq!((s, e["path"].as_str()), (422, Some("payload.settings")));

    let edited = env(
        "e6",
        "proposal",
        json!({"proposal_id": "p1", "event": "edited", "settings": {"f": 0.5}}),
    );
    let (s1, a) = call(
        &app,
        post(&format!("{base}/p1/approvals"), k, &edited).to_request(),
    )
    .await;
    let (s2, b) = call(
        &app,
        post(&format!("{base}/p1/approvals"), k, &edited).to_request(),
    )
    .await;
    assert_eq!(
        (s1, s2),
        (201, 200),
        "a replayed decision is returned, not refused"
    );
    assert_eq!(a, b);
    let (s, e) = call(
        &app,
        post(
            &format!("{base}/p1/approvals"),
            k,
            &ev("e7", "p1", "rejected"),
        )
        .to_request(),
    )
    .await;
    assert_eq!(
        (s, e["error"].as_str()),
        (409, Some("conflict")),
        "a second decision"
    );
    let (_, p) = call(&app, get(&format!("{base}/p1"), k).to_request()).await;
    assert_eq!(
        (p["status"].as_str(), &p["settings"]),
        (Some("edited"), &json!({"f": 0.5}))
    );
    let (_, list) = call(&app, get("/investigations", k).to_request()).await;
    assert_eq!(list["investigations"][0]["status"], "awaiting_data");

    assert_eq!(
        call(
            &app,
            post(
                &format!("{base}/p1/data"),
                k,
                &ev("e8", "p1", "data_attached")
            )
            .to_request()
        )
        .await
        .0,
        201
    );
    let (s, _) = call(
        &app,
        post(
            &format!("{base}/p1/data"),
            k,
            &ev("e9", "p1", "data_attached"),
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 409, "data is attached once");
    let (_, p) = call(&app, get(&format!("{base}/p1"), k).to_request()).await;
    assert_eq!(p["status"], "data_attached");

    // The SDK withdraws through /proposals; withdrawn is terminal.
    call(
        &app,
        post(&base, k, &env("w1", "proposal", proposed("p2"))).to_request(),
    )
    .await;
    assert_eq!(
        call(
            &app,
            post(&base, k, &ev("w2", "p2", "withdrawn")).to_request()
        )
        .await
        .0,
        201
    );
    assert_eq!(
        call(
            &app,
            post(
                &format!("{base}/p2/approvals"),
                k,
                &ev("w3", "p2", "approved")
            )
            .to_request()
        )
        .await
        .0,
        409
    );
    let (s, e) = call(
        &app,
        post(&base, k, &ev("w4", "p2", "approved")).to_request(),
    )
    .await;
    assert_eq!(
        (s, e["path"].as_str()),
        (422, Some("payload.event")),
        "/proposals does not take decisions"
    );
}

/// CORE-01: `POST /investigations/{inv}/records` appends a batch all or none.
#[actix_web::test]
async fn batch_appends_all_or_none_and_replays_by_record_id() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    let k = Some(key.as_str());
    let batch = format!("/investigations/{inv}/records");
    let listing = format!("/investigations/{inv}/records");
    macro_rules! all {
        ($app:expr) => {{
            let (_, r) = call($app, get(&listing, k).to_request()).await;
            r["records"].as_array().unwrap().len()
        }};
    }
    let proposal = json!({"records": [
        env("b-prop", "proposal", proposed("p1")),
        env("b-ok", "proposal", json!({"proposal_id": "p1", "event": "approved", "by": "test"})),
    ]});
    let (s, out) = call(&app, post(&batch, k, &proposal).to_request()).await;
    assert_eq!(s, 201, "{out}");
    let items = out["records"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|i| i["created"] == true));
    assert_eq!(out["gseq"], items[1]["gseq"]);
    assert_eq!(items[1]["record"]["prev_hash"], items[0]["record"]["hash"]);
    let before = all!(&app);

    // One refused record anywhere writes nothing: an unknown kind, a bad
    // payload, a state-machine refusal (data for an unknown proposal).
    let measurement = env("b-m", "measurement", json!({"observation": {"t": [0.0], "y": {"T": [1.0]}}}));
    let attach = |pid: &str| {
        let mut e = env("b-e", "proposal", json!({"proposal_id": pid, "event": "data_attached"}));
        e["hash_of"] = json!({"measurement_version": 0});
        e
    };
    for (body, status, code, path) in [
        (json!({"records": [measurement.clone(), env("b-x", "bogus", json!({}))]}), 422, "invalid_payload", Some("records[1].kind")),
        (json!({"records": [measurement.clone(), env("b-x", "run", json!(5))]}), 422, "invalid_payload", None),
        (json!({"records": [measurement.clone(), attach("p404")]}), 404, "not_found", None),
        (json!({"records": [measurement.clone(), measurement.clone()]}), 422, "invalid_payload", Some("records[1].id")),
        (json!({"records": []}), 422, "invalid_payload", Some("records")),
        (json!({"nope": []}), 422, "invalid_payload", Some("records")),
    ] {
        let (s, e) = call(&app, post(&batch, k, &body).to_request()).await;
        assert_eq!((s, e["error"].as_str()), (status, Some(code)), "{body} -> {e}");
        if let Some(path) = path {
            assert_eq!(e["path"].as_str(), Some(path), "{e}");
        }
        assert_eq!(all!(&app), before, "a refused batch wrote records: {body}");
    }

    // The attachment pair: the event's measurement_version is the hash of
    // the batch's measurement record, filled in by the store.
    let pair = json!({"records": [measurement.clone(), attach("p1")]});
    let (s, out) = call(&app, post(&batch, k, &pair).to_request()).await;
    assert_eq!(s, 201, "{out}");
    let m = &out["records"][0]["record"];
    let e = &out["records"][1]["record"];
    assert_eq!(e["payload"]["measurement_version"], m["hash"]);
    let (_, p) = call(&app, get(&format!("/investigations/{inv}/proposals/p1"), k).to_request()).await;
    assert_eq!(p["status"], "data_attached");
    let after = all!(&app);
    assert_eq!(after, before + 2);

    // A retry of the committed batch replays both records (200, created false).
    let (s, again) = call(&app, post(&batch, k, &pair).to_request()).await;
    assert_eq!(s, 200, "{again}");
    assert!(again["records"].as_array().unwrap().iter().all(|i| i["created"] == false));
    assert_eq!(again["records"][1]["record"], *e);
    assert_eq!(all!(&app), after);
    // The same id with other content conflicts, and still writes nothing.
    let mut changed = pair.clone();
    changed["records"][0]["payload"]["observation"]["y"]["T"] = json!([2.0]);
    let (s, c) = call(&app, post(&batch, k, &changed).to_request()).await;
    assert_eq!((s, c["error"].as_str()), (409, Some("idempotency_conflict")));
    assert_eq!(all!(&app), after);

    // Idempotency is per record id; the header is refused.
    let (s, _) = call(
        &app,
        post(&batch, k, &pair).insert_header(("Idempotency-Key", "b-m")).to_request(),
    )
    .await;
    assert_eq!(s, 400);
    // The dedicated attachment route is gone (CORE-01a).
    let (s, _) = call(
        &app,
        post(&format!("/investigations/{inv}/proposals/p1/attachment"), k, &pair).to_request(),
    )
    .await;
    assert_eq!(s, 404);
}

/// The removed attachment route refused a `data_attached` event that did not
/// name its measurement; the batch keeps that. A link into the batch must
/// be a measurement, and with measurements before it in the batch the event
/// must name one: by hash (`hash_of`, Rust) or by payload `version`
/// (Python). A stored event retried unchanged replays without the check.
#[actix_web::test]
async fn batch_data_attached_must_name_its_measurement() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    let k = Some(key.as_str());
    let batch = format!("/investigations/{inv}/records");
    macro_rules! all {
        ($app:expr) => {{
            let (_, r) = call($app, get(&batch, k).to_request()).await;
            r["records"].as_array().unwrap().len()
        }};
    }
    let approve = |pid: &str| {
        json!({"records": [
            env(&format!("{pid}-prop"), "proposal", proposed(pid)),
            env(&format!("{pid}-ok"), "proposal", json!({"proposal_id": pid, "event": "approved", "by": "test"})),
        ]})
    };
    for pid in ["p1", "p2", "p3"] {
        let (s, out) = call(&app, post(&batch, k, &approve(pid)).to_request()).await;
        assert_eq!(s, 201, "{out}");
    }
    let observation = json!({"t": [0.0], "y": {"T": [1.0]}});
    let rust_m = env("m-rust", "measurement", json!({"observation": observation}));
    let python_m = env("m-py", "measurement", json!({"version": 3, "digest": "d", "observation": observation}));
    let attached = |id: &str, pid: &str, link: Value| {
        env(id, "proposal", json!({"proposal_id": pid, "event": "data_attached", "measurement_version": link}))
    };
    let linked = |id: &str, pid: &str, index: usize| {
        let mut e = env(id, "proposal", json!({"proposal_id": pid, "event": "data_attached"}));
        e["hash_of"] = json!({"measurement_version": index});
        e
    };
    let before = all!(&app);
    for (body, path, why) in [
        (
            json!({"records": [env("p4-prop", "proposal", proposed("p4")), linked("e-1", "p1", 0)]}),
            "records[1].hash_of.measurement_version",
            "hash_of names a proposal record, not a measurement",
        ),
        (
            json!({"records": [rust_m.clone(), attached("e-2", "p1", json!("0".repeat(64)))]}),
            "records[1].payload.measurement_version",
            "a hash that is not the batch's measurement",
        ),
        (
            json!({"records": [python_m.clone(), attached("e-3", "p1", json!(4))]}),
            "records[1].payload.measurement_version",
            "another dataset version than the batch's measurement",
        ),
    ] {
        let (s, e) = call(&app, post(&batch, k, &body).to_request()).await;
        assert_eq!((s, e["error"].as_str(), e["path"].as_str()), (422, Some("invalid_payload"), Some(path)), "{why}: {e}");
        assert_eq!(all!(&app), before, "a refused batch wrote records: {why}");
    }

    // What the SDKs send: Rust links the hash, Python the dataset version.
    let rust = json!({"records": [rust_m, linked("e-rust", "p1", 0)]});
    let (s, out) = call(&app, post(&batch, k, &rust).to_request()).await;
    assert_eq!(s, 201, "{out}");
    assert_eq!(out["records"][1]["record"]["payload"]["measurement_version"], out["records"][0]["record"]["hash"]);
    let python = json!({"records": [python_m, attached("e-py", "p2", json!(3))]});
    let (s, out) = call(&app, post(&batch, k, &python).to_request()).await;
    assert_eq!(s, 201, "{out}");
    // An event alone names no batch record and is checked as before.
    let alone = json!({"records": [attached("e-alone", "p3", json!(1))]});
    let (s, out) = call(&app, post(&batch, k, &alone).to_request()).await;
    assert_eq!(s, 201, "{out}");
    assert_eq!(all!(&app), before + 5);

    // Only records the batch writes are link-checked: the stored `e-py`,
    // retried byte for byte after a measurement it does not name, replays.
    let later = |id: &str, version: u64| {
        env(id, "measurement", json!({"version": version, "digest": "d", "observation": observation}))
    };
    let retry = json!({"records": [later("m-later", 9), attached("e-py", "p2", json!(3))]});
    let (s, out) = call(&app, post(&batch, k, &retry).to_request()).await;
    assert_eq!(s, 201, "{out}");
    let created: Vec<_> = out["records"].as_array().unwrap().iter().map(|r| r["created"].as_bool()).collect();
    assert_eq!(created, [Some(true), Some(false)], "{out}");
    assert_eq!(all!(&app), before + 6);
    // A new event in the same place is still refused.
    let fresh = json!({"records": [later("m-later-2", 10), attached("e-new", "p2", json!(3))]});
    let (s, e) = call(&app, post(&batch, k, &fresh).to_request()).await;
    assert_eq!(
        (s, e["path"].as_str()),
        (422, Some("records[1].payload.measurement_version")),
        "{e}"
    );
    assert_eq!(all!(&app), before + 6);
    // A reused id with other content is a conflict, decided before the link
    // rule, which applies only to records the batch writes.
    let reused = json!({"records": [later("m-later-3", 11), attached("e-py", "p2", json!(5))]});
    let (s, e) = call(&app, post(&batch, k, &reused).to_request()).await;
    assert_eq!((s, e["error"].as_str()), (409, Some("idempotency_conflict")), "{e}");
    assert_eq!(all!(&app), before + 6);
}

#[actix_web::test]
async fn outlook_is_validated_and_passed_through_untouched() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    let k = Some(key.as_str());
    let base = format!("/investigations/{inv}/proposals");
    let outlook = json!({
        "axes": [{"name": "f", "values": [0.1, 0.2, 0.4]}, {"name": "amp", "values": [1.0, 2.0]}],
        "score": [0.9, 0.8, 0.7, 0.6, 0.5, 0.4],
        "after": {"C": [1.1, 1.2, 1.3, 1.4, 1.5, 1.6], "k": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5]}
    });
    let mut payload = proposed("p1");
    payload["outlook"] = outlook.clone();
    let (s, r) = call(
        &app,
        post(&base, k, &env("o1", "proposal", payload)).to_request(),
    )
    .await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(r["record"]["payload"]["outlook"], outlook);

    // Edits stay inside the outlook's axes; other settings cannot move.
    let edit = |id: &str, settings: Value| {
        env(
            id,
            "proposal",
            json!({"proposal_id": "p1", "event": "edited", "settings": settings}),
        )
    };
    let decide = format!("{base}/p1/approvals");
    let (s, e) = call(
        &app,
        post(&decide, k, &edit("ed1", json!({"f": 0.5}))).to_request(),
    )
    .await;
    assert_eq!(
        (s, e["path"].as_str()),
        (422, Some("payload.settings.f")),
        "above the f axis: {e}"
    );
    let (s, e) = call(
        &app,
        post(&decide, k, &edit("ed2", json!({"f": 0.2, "amp": 9.0}))).to_request(),
    )
    .await;
    assert_eq!(
        (s, e["path"].as_str()),
        (422, Some("payload.settings.amp")),
        "amp is not an axis here"
    );
    let (s, e) = call(
        &app,
        post(&decide, k, &edit("ed3", json!({"f": "fast"}))).to_request(),
    )
    .await;
    assert_eq!((s, e["path"].as_str()), (422, Some("payload.settings.f")));
    let (s, r) = call(
        &app,
        post(&decide, k, &edit("ed4", json!({"f": 0.4}))).to_request(),
    )
    .await;
    assert_eq!(s, 201, "inclusive upper bound: {r}");
    let (_, p) = call(&app, get(&format!("{base}/p1"), k).to_request()).await;
    assert_eq!(
        (p["status"].as_str(), &p["settings"]),
        (Some("edited"), &json!({"f": 0.4}))
    );

    let mut short = proposed("p2");
    short["outlook"] = json!({"axes": [{"name": "f", "values": [0.1, 0.2, 0.4]}], "score": [0.9, 0.8], "after": {"C": [1, 2, 3]}});
    let (s, e) = call(
        &app,
        post(&base, k, &env("o2", "proposal", short)).to_request(),
    )
    .await;
    assert_eq!(
        (s, e["error"].as_str(), e["path"].as_str()),
        (422, Some("invalid_payload"), Some("payload.outlook.score"))
    );
    let mut after = proposed("p3");
    after["outlook"] = json!({"axes": [{"name": "f", "values": [0.1, 0.2]}], "score": [0.9, 0.8], "after": {"C": [1]}});
    let (s, e) = call(
        &app,
        post(&base, k, &env("o3", "proposal", after)).to_request(),
    )
    .await;
    assert_eq!(
        (s, e["path"].as_str()),
        (422, Some("payload.outlook.after.C"))
    );
}

#[actix_web::test]
async fn hash_chain_is_continuous_and_matches_the_sdk_rule() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    let k = Some(key.as_str());
    for i in 0..5 {
        let p = json!({"i": i, "x": 0.1 * i as f64, "tiny": 1e-7, "name": "naïve"});
        call(
            &app,
            post(
                &format!("/investigations/{inv}/steps"),
                k,
                &env(&format!("s{i}"), "step", p),
            )
            .to_request(),
        )
        .await;
    }
    let (_, recs) = call(
        &app,
        get(&format!("/investigations/{inv}/records"), k).to_request(),
    )
    .await;
    let mut prev = GENESIS.to_string();
    for (i, r) in recs["records"].as_array().unwrap().iter().enumerate() {
        assert_eq!(r["seq"], i as i64);
        assert_eq!(r["prev_hash"], prev.as_str());
        let h = chain_hash(
            &prev,
            r["id"].as_str().unwrap(),
            r["kind"].as_str().unwrap(),
            &r["payload"],
        );
        assert_eq!(r["hash"], h.as_str());
        prev = h;
    }
    let report = f
        .api
        .client
        .find_investigation(&inv)
        .unwrap()
        .workbook()
        .verify()
        .unwrap();
    assert!(report.ok, "{report:?}");
    assert_eq!(report.records, 6);
}

#[actix_web::test]
async fn workspace_is_one_snapshot_with_a_cursor() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await;
    call(
        &app,
        post(
            &format!("/investigations/{inv}/proposals"),
            Some(&key),
            &env("p", "proposal", proposed("p1")),
        )
        .to_request(),
    )
    .await;
    let (s, ws) = call(&app, get("/workspace", Some(&key)).to_request()).await;
    assert_eq!(s, 200);
    let pid = ws["projects"][0]["id"].as_str().unwrap();
    assert_eq!(ws["cursor"], format!("{pid}:2"));
    assert_eq!(ws["cursors"][pid], 2);
    let (s, scoped) = call(
        &app,
        get(&format!("/workspace?project={pid}"), Some(&key)).to_request(),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(scoped["cursor"], 2);
    assert_eq!(ws["projects"].as_array().unwrap().len(), 1);
    assert_eq!(ws["config_versions"][0]["config"]["x"], 1.5);
    assert_eq!(ws["investigations"][0]["status"], "awaiting_approval");
    assert_eq!(ws["proposals"][0]["proposal_id"], "p1");
    assert_eq!(ws["records"].as_array().unwrap().len(), 2);
}

#[actix_web::test]
async fn stream_resumes_after_a_cursor_then_goes_live() {
    let f = fixture();
    let app = app!(f.api);
    let (key, inv) = seeded(&app, &f.api).await; // gseq 1: the investigation record
    let k = Some(key.as_str());
    for i in 0..3 {
        call(
            &app,
            post(
                &format!("/investigations/{inv}/runs"),
                k,
                &env(&format!("r{i}"), "run", json!({"i": i})),
            )
            .to_request(),
        )
        .await;
    } // gseq 2, 3, 4

    let resp = test::call_service(
        &app,
        get(&format!("/stream?after=2&investigation={inv}"), k).to_request(),
    )
    .await;
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "text/event-stream"
    );
    let mut body = resp.into_body();
    let backlog = sse_records(&mut body, 2).await;
    assert_eq!(backlog.iter().map(|(g, _)| *g).collect::<Vec<_>>(), [3, 4]);
    assert_eq!(backlog[0].1["id"], "r1");
    assert!(
        backlog[0].1.get("gseq").is_none(),
        "records keep the SDK's 8 fields"
    );

    call(
        &app,
        post(
            &format!("/investigations/{inv}/runs"),
            k,
            &env("live", "run", json!({})),
        )
        .to_request(),
    )
    .await;
    let live = sse_records(&mut body, 1).await;
    assert_eq!((live[0].0, live[0].1["id"].as_str()), (5, Some("live")));

    // EventSource reconnects with Last-Event-ID; it wins over a lower `after`.
    let resumed = test::call_service(
        &app,
        get(&format!("/stream?after=0&investigation={inv}"), k)
            .insert_header(("last-event-id", "4"))
            .to_request(),
    )
    .await;
    let mut body = resumed.into_body();
    let again = sse_records(&mut body, 1).await;
    assert_eq!(again[0].0, 5);

    // The browser may stream without a key.
    let resp = test::call_service(
        &app,
        browser(
            &f.api,
            get(&format!("/stream?after=4&investigation={inv}"), None),
            false,
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status().as_u16(), 200);
}

#[actix_web::test]
async fn appends_return_their_cursor_and_the_stream_filters_by_investigation() {
    let f = fixture();
    let app = app!(f.api);
    let (key, a) = seeded(&app, &f.api).await; // gseq 1
    let k = Some(key.as_str());
    let (_, list) = call(&app, get("/investigations", k).to_request()).await;
    let pid = list["investigations"][0]["project_id"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, b) = call(
        &app,
        post(
            "/investigations",
            k,
            &json!({"project_id": pid, "config_version": version()}),
        )
        .to_request(),
    )
    .await;
    let b = b["id"].as_str().unwrap().to_string(); // gseq 2
    let (s, r) = call(
        &app,
        post(
            &format!("/investigations/{a}/runs"),
            k,
            &env("a1", "run", json!({})),
        )
        .to_request(),
    )
    .await;
    assert_eq!((s, r["gseq"].as_i64()), (201, Some(3)));
    assert!(r["record"].get("gseq").is_none());
    let (s, again) = call(
        &app,
        post(
            &format!("/investigations/{a}/runs"),
            k,
            &env("a1", "run", json!({})),
        )
        .to_request(),
    )
    .await;
    assert_eq!(
        (s, again["gseq"].as_i64()),
        (200, Some(3)),
        "a replay reports the stored cursor"
    );
    call(
        &app,
        post(
            &format!("/investigations/{b}/runs"),
            k,
            &env("b1", "run", json!({})),
        )
        .to_request(),
    )
    .await; // 4
    call(
        &app,
        post(
            &format!("/investigations/{a}/runs"),
            k,
            &env("a2", "run", json!({})),
        )
        .to_request(),
    )
    .await; // 5

    let resp = test::call_service(
        &app,
        get(&format!("/stream?after=0&investigation={b}"), k).to_request(),
    )
    .await;
    let mut body = resp.into_body();
    let backlog = sse_records(&mut body, 2).await;
    assert_eq!(backlog.iter().map(|(g, _)| *g).collect::<Vec<_>>(), [2, 4]);
    call(
        &app,
        post(
            &format!("/investigations/{a}/runs"),
            k,
            &env("a3", "run", json!({})),
        )
        .to_request(),
    )
    .await; // 6, filtered out
    call(
        &app,
        post(
            &format!("/investigations/{b}/runs"),
            k,
            &env("b2", "run", json!({})),
        )
        .to_request(),
    )
    .await; // 7
    let live = sse_records(&mut body, 1).await;
    assert_eq!((live[0].0, live[0].1["id"].as_str()), (7, Some("b2")));
}

#[actix_web::test]
async fn unknown_routes_are_json_404() {
    let f = fixture();
    let app = app!(f.api);
    let (s, e) = call(&app, get("/nope", None).to_request()).await;
    assert_eq!((s, e["error"].as_str()), (404, Some("not_found")));
}

#[actix_web::test]
async fn collection_cursors_resume_two_workbooks_and_detect_external_writes() {
    let f = fixture();
    let app = app!(f.api);
    let (key, a) = seeded(&app, &f.api).await;
    let k = Some(key.as_str());
    let wb_a = f
        .api
        .client
        .find_investigation(&a)
        .unwrap()
        .workbook()
        .clone();
    let wb_b = f.api.client.ensure_project("battery").unwrap().0;
    wb_b.put_config_version(&version(), CONFIG).unwrap();
    let (b, _) = wb_b
        .create_investigation(json!({"config_version": version()}), None)
        .unwrap();
    let (_, ws) = call(&app, get("/workspace", k).to_request()).await;
    assert_eq!(ws["cursors"][wb_a.id()], 1);
    assert_eq!(ws["cursors"][wb_b.id()], 1);
    let cursor = ws["cursor"].as_str().unwrap();
    let resp = test::call_service(
        &app,
        get(&format!("/stream?after={cursor}"), k).to_request(),
    )
    .await;
    assert_eq!(resp.status().as_u16(), 200);
    let mut stream = resp.into_body();

    // A separate local SDK client changes both files; no server wake-up is sent.
    let external = autophys::connect(Some(f.api.client.root().to_str().unwrap())).unwrap();
    external
        .find_investigation(&a)
        .unwrap()
        .append("run", json!({"a": true}), Some("a-external"))
        .unwrap();
    external
        .find_investigation(&b.id)
        .unwrap()
        .append("run", json!({"b": true}), Some("b-external"))
        .unwrap();
    let events = sse_events(&mut stream, 2).await;
    let ids: std::collections::BTreeSet<_> = events
        .iter()
        .map(|(_, r)| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["a-external", "b-external"].into_iter().collect());
    let last = &events[1].0;
    assert!(last.contains(&format!("{}:2", wb_a.id())));
    assert!(last.contains(&format!("{}:2", wb_b.id())));

    let resp = test::call_service(
        &app,
        get("/stream?after=0", k)
            .insert_header(("last-event-id", last.as_str()))
            .to_request(),
    )
    .await;
    let mut resumed = resp.into_body();
    external
        .find_investigation(&b.id)
        .unwrap()
        .append("step", json!({}), Some("b-live"))
        .unwrap();
    let live = sse_events(&mut resumed, 1).await;
    assert_eq!(live[0].1["id"], "b-live");

    let (status, _) = call(&app, get("/stream?after=2", k).to_request()).await;
    assert_eq!(
        status, 400,
        "an unscoped integer cannot name positions in two files"
    );
    let (status, recs) = call(
        &app,
        get(&format!("/investigations/{}/records?after=2", b.id), k).to_request(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(recs["records"].as_array().unwrap().len(), 1);
    assert_eq!(recs["records"][0]["id"], "b-live");
}

#[actix_web::test]
async fn inference_context_is_read_from_records_in_investigations_and_proposals() {
    let f = fixture();
    let app = app!(f.api);
    let (key, existing) = seeded(&app, &f.api).await;
    let wb = f
        .api
        .client
        .find_investigation(&existing)
        .unwrap()
        .workbook()
        .clone();
    let context = json!({
        "config_version": version(),
        "playbook":{"name":"policy", "version":"1", "sha256":"a".repeat(64)},
        "model":{"role":"policy", "route":"meta", "model":"muse-spark-1.3", "effort":null, "max_tokens":2400},
        "price":{"model":"muse-spark-1.3", "input_per_mtok":1.25, "output_per_mtok":4.25, "as_of":"2026-11-04"}
    });
    let (inv, _) = wb.create_investigation(context.clone(), None).unwrap();
    let step = json!({"index":1, "model":"muse-spark-1.3", "elapsed_ms":9.0, "usage":{"route":"meta", "model":"muse-spark-1.3", "input_tokens":10, "output_tokens":2, "total_tokens":12, "latency_ms":9.0, "cost_usd":null}, "replayed":true});
    inv.append("step", step.clone(), None).unwrap();
    // Historical raw provider dictionaries remain untouched in the read model.
    let legacy = json!({"index":2,"usage":{"prompt_tokens":7}});
    inv.append("step", legacy.clone(), None).unwrap();
    inv.append("proposal", proposed("reasoned"), None).unwrap();
    let total = json!({"calls":1,"input_tokens":10,"output_tokens":2,"cost_usd":null});
    inv.append(
        "outcome",
        json!({"status":"inconclusive", "usage_total":total}),
        None,
    )
    .unwrap();
    let info = serde_json::to_value(inv.info().unwrap()).unwrap();
    let proposal = serde_json::to_value(inv.proposal("reasoned").unwrap()).unwrap();
    for view in [&info, &proposal] {
        for field in ["playbook", "model", "price"] {
            assert_eq!(view[field], context[field]);
        }
        assert_eq!(view["steps"], json!([step, legacy]));
        assert_eq!(view["usage_total"], total);
    }
    let (_, listing) = call(&app, get("/investigations", Some(&key)).to_request()).await;
    let listed = listing["investigations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == inv.id)
        .unwrap();
    assert_eq!(listed, &info);
    let (status, reply) = call(
        &app,
        get(
            &format!("/investigations/{}/proposals/reasoned", inv.id),
            Some(&key),
        )
        .to_request(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(reply, proposal);
    let snapshot = wb.snapshot().unwrap();
    assert_eq!(
        snapshot.investigations.last().unwrap().reason.steps,
        vec![step, legacy]
    );
    assert!(wb.verify().unwrap().ok);
}

#[actix_web::test]
async fn python_replay_golden_exposes_chip_fields_on_api_read_views() {
    let f = fixture();
    std::fs::create_dir_all(f.dir.path().join("collection")).unwrap();
    std::fs::copy(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/conformance/python/reason-replayed.ap-workbook"
        ),
        f.dir.path().join("collection/oscillator.ap-workbook"),
    )
    .unwrap();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "replay-reader").await;
    let (status, listing) = call(&app, get("/investigations", Some(&key)).to_request()).await;
    assert_eq!(status, 200);
    let inv = &listing["investigations"][0];
    assert_eq!(inv["playbook"]["name"], "default");
    assert_eq!(inv["playbook"]["version"], "1");
    assert_eq!(inv["model"]["model"], autophys::reasoner::MUSE_SPARK);
    assert_eq!(inv["usage_total"]["calls"], 8);
    assert_eq!(inv["usage_total"]["input_tokens"], 800);
    assert_eq!(inv["usage_total"]["output_tokens"], 320);
    assert!((inv["usage_total"]["cost_usd"].as_f64().unwrap() - 0.00236).abs() < 1e-15);
    let (status, workspace) = call(&app, get("/workspace", Some(&key)).to_request()).await;
    assert_eq!(status, 200);
    assert_eq!(workspace["investigations"][0], *inv);
    let id = inv["id"].as_str().unwrap();
    let (status, records) = call(
        &app,
        get(&format!("/investigations/{id}/records"), Some(&key)).to_request(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        records["records"][0]["payload"]["playbook"],
        inv["playbook"]
    );
    assert!(
        f.api
            .client
            .find_investigation(id)
            .unwrap()
            .workbook()
            .verify()
            .unwrap()
            .ok
    );
}
