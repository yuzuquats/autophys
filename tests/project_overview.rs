//! OV-5: project overviews over HTTP, in `/workspace` and on `/stream`.
mod common;

use actix_web::{App, body::MessageBody, test};
use autophys::{MAX_OVERVIEW_BYTES, sha256_hex};
use autophys_cli::http::configure;
use common::*;
use serde_json::{Value, json};
use std::{pin::Pin, time::Duration};

macro_rules! app {
    ($api:expr) => {{
        let api = $api.clone();
        test::init_service(App::new().configure(move |cfg| configure(cfg, api.clone()))).await
    }};
}

fn put_json(path: &str, key: Option<&str>, body: &Value) -> actix_web::test::TestRequest {
    put_raw(path, key, body.to_string().as_bytes())
}

fn format(p: &std::path::Path) -> i64 {
    rusqlite::Connection::open(p)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

/// The raw body of a GET, for byte-for-byte comparisons.
async fn raw_get<S, B>(app: &S, path: &str, key: &str) -> String
where
    S: actix_web::dev::Service<
            actix_http::Request,
            Response = actix_web::dev::ServiceResponse<B>,
            Error = actix_web::Error,
        >,
    B: MessageBody,
{
    let resp = test::call_service(app, get(path, Some(key)).to_request()).await;
    assert_eq!(resp.status(), 200);
    String::from_utf8(test::read_body(resp).await.to_vec()).unwrap()
}

/// The next `event: overview`, parsed. See [`overview_frame`].
async fn overview_event<B: MessageBody + Unpin>(body: &mut B, wait: Duration) -> Option<Value>
where
    B::Error: std::fmt::Debug,
{
    overview_frame(body, wait)
        .await
        .map(|data| serde_json::from_str(&data).unwrap())
}

/// The next `event: overview`'s data line, asserting the frame carries no
/// id. Record and display frames are skipped; `None` when only keep-alives
/// arrive before the deadline.
async fn overview_frame<B: MessageBody + Unpin>(body: &mut B, wait: Duration) -> Option<String>
where
    B::Error: std::fmt::Debug,
{
    tokio::time::timeout(wait, async {
        let mut buf = String::new();
        loop {
            let chunk = std::future::poll_fn(|cx| Pin::new(&mut *body).poll_next(cx))
                .await
                .unwrap()
                .unwrap();
            buf.push_str(std::str::from_utf8(&chunk).unwrap());
            while let Some(end) = buf.find("\n\n") {
                let frame: String = buf.drain(..end + 2).collect();
                if frame.starts_with("event: overview\n") {
                    assert!(!frame.contains("\nid: "), "{frame}");
                    return frame
                        .lines()
                        .find_map(|s| s.strip_prefix("data: "))
                        .unwrap()
                        .to_string();
                }
            }
        }
    })
    .await
    .ok()
}

#[actix_web::test]
async fn writes_append_versions_and_the_snapshot_carries_the_latest() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "overview").await;
    let wb = f.api.client.ensure_project("overview").unwrap().0;
    let other = f.api.client.ensure_project("other").unwrap().0;
    let pid = wb.id().to_string();
    let config = br#"{"physics":true}"#;
    let version = format!("sha256:{}", sha256_hex([&config[..]]));
    wb.put_config_version(&version, config).unwrap();
    let (inv, _) = wb
        .create_investigation(json!({"config_version": version}), None)
        .unwrap();
    let path = format!("/projects/{pid}/overview");
    let scoped = format!("/workspace?project={pid}");

    let (_, ws) = call(&app, get(&scoped, Some(&key)).to_request()).await;
    assert_eq!(ws["projects"][0]["overview"], Value::Null);
    assert!(ws["projects"][0].get("overview_meta").is_none());
    let (s, v) = call(
        &app,
        get(&format!("{path}/versions"), Some(&key)).to_request(),
    )
    .await;
    assert_eq!((s, &v["versions"]), (200, &json!([])));
    let (s, latest) = call(&app, get(&path, Some(&key)).to_request()).await;
    assert_eq!(
        (s, &latest),
        (200, &json!({"project_id": pid, "overview": null}))
    );
    assert_eq!(format(wb.path()), 1, "reads never upgrade");

    let md = format!(
        "# Overview \u{e9}\n\n<ap-investigation investigation=\"{}\" hue=\"1\"></ap-investigation>\n\n<ap-investigation investigation=\"inv_gone\"></ap-investigation>\n",
        inv.id
    );
    let (s, first) = call(
        &app,
        put_json(&path, Some(&key), &json!({"markdown": md, "author": "ada"})).to_request(),
    )
    .await;
    assert_eq!(s, 201, "{first}");
    assert_eq!(first["project_id"], pid.as_str());
    assert_eq!(first["changed"], true);
    assert_eq!(first["overview"]["seq"], 1);
    assert_eq!(first["overview"]["digest"], sha256_hex([md.as_bytes()]));
    assert!(first["overview"].get("markdown").is_none());
    let codes: Vec<_> = first["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["code"].clone())
        .collect();
    assert_eq!(
        codes,
        [json!("unknown_attribute"), json!("unknown_investigation")]
    );
    assert_eq!(first["warnings"][1]["investigation"], "inv_gone");
    assert_eq!((format(wb.path()), format(other.path())), (3, 1));

    // OV-7: `/workspace` carries the same version object as the overview
    // route, byte for byte: field names, order and number formatting.
    let raw_latest = raw_get(&app, &path, &key).await;
    let object = raw_latest
        .strip_prefix(&format!("{{\"project_id\":\"{pid}\",\"overview\":"))
        .and_then(|rest| rest.strip_suffix('}'))
        .unwrap_or_else(|| panic!("{raw_latest}"));
    let raw_ws = raw_get(&app, &scoped, &key).await;
    assert!(
        raw_ws.contains(&format!("\"overview\":{object}")),
        "{raw_ws}\n{object}"
    );
    let ws: Value = serde_json::from_str(&raw_ws).unwrap();
    let wire = &ws["projects"][0]["overview"];
    assert_eq!(
        wire.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["seq", "digest", "markdown", "author", "created"]
    );
    assert_eq!(wire["markdown"], md.as_str());
    assert!(ws["projects"][0].get("overview_meta").is_none());
    for field in ["seq", "digest", "author", "created"] {
        assert_eq!(wire[field], first["overview"][field], "{field}");
    }
    let (_, all) = call(&app, get("/workspace", Some(&key)).to_request()).await;
    let other_row = all["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == other.id())
        .unwrap();
    assert_eq!(other_row["overview"], Value::Null);

    // The digest decides, whoever writes it.
    let (s, same) = call(
        &app,
        put_json(
            &path,
            Some(&key),
            &json!({"markdown": md, "author": "grace"}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(
        (s, &same["changed"], &same["overview"]),
        (200, &json!(false), &first["overview"])
    );
    let (s, second) = call(
        &app,
        put_json(
            &path,
            Some(&key),
            &json!({"markdown": "# Two\n", "author": "grace"}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(
        (s, &second["overview"]["seq"], &second["warnings"]),
        (201, &json!(2), &json!([]))
    );
    let (_, v) = call(
        &app,
        get(&format!("{path}/versions"), Some(&key)).to_request(),
    )
    .await;
    let versions = v["versions"].as_array().unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(
        (&versions[0]["markdown"], &versions[0]["author"]),
        (&json!(md), &json!("ada"))
    );
    assert_eq!(
        (&versions[1]["markdown"], &versions[1]["author"]),
        (&json!("# Two\n"), &json!("grace"))
    );
    assert_eq!(wb.overview().unwrap().unwrap().markdown, "# Two\n");
    // The latest alone, with its Markdown: what remote readers fetch.
    let (s, latest) = call(&app, get(&path, Some(&key)).to_request()).await;
    assert_eq!(
        (s, &latest["project_id"], &latest["overview"]),
        (200, &json!(pid), &versions[1])
    );
    let head = wb.overview_head().unwrap().unwrap();
    assert_eq!(
        (json!(head.seq), json!(head.digest)),
        (versions[1]["seq"].clone(), versions[1]["digest"].clone())
    );
    assert!(other.overview_head().unwrap().is_none());
    assert!(wb.verify().unwrap().ok);
}

#[actix_web::test]
async fn refusals_auth_missing_projects_and_the_size_cap() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "overview").await;
    let wb = f.api.client.ensure_project("overview").unwrap().0;
    let path = format!("/projects/{}/overview", wb.id());
    for (body, field) in [
        (json!({"markdown": "", "author": "a"}), "markdown"),
        (json!({"markdown": " \n\t", "author": "a"}), "markdown"),
        (json!({"author": "a"}), "markdown"),
        (json!({"markdown": 7, "author": "a"}), "markdown"),
        (json!({"markdown": "# x"}), "author"),
        (json!({"markdown": "# x", "author": " "}), "author"),
        (
            json!({"markdown": "# x", "author": "\u{e9}".repeat(201)}),
            "author",
        ),
    ] {
        let (s, e) = call(&app, put_json(&path, Some(&key), &body).to_request()).await;
        assert_eq!(
            (s, e["error"].as_str(), e["path"].as_str()),
            (422, Some("invalid_payload"), Some(field)),
            "{body} {e}"
        );
    }
    let (s, _) = call(&app, put_raw(&path, Some(&key), b"{").to_request()).await;
    assert_eq!(s, 400);
    let ok = json!({"markdown": "# x\n", "author": "a"});
    assert_eq!(
        call(&app, put_json(&path, None, &ok).to_request()).await.0,
        401
    );
    assert_eq!(
        call(
            &app,
            put_json("/projects/prj_missing/overview", Some(&key), &ok).to_request()
        )
        .await
        .0,
        404
    );
    for url in [
        "/projects/prj_missing/overview/versions",
        "/projects/prj_missing/overview",
    ] {
        assert_eq!(call(&app, get(url, Some(&key)).to_request()).await.0, 404, "{url}");
    }
    assert_eq!(call(&app, get(&path, None).to_request()).await.0, 401);
    assert_eq!(format(wb.path()), 1, "refused writes leave format 1");

    let exact = "x".repeat(MAX_OVERVIEW_BYTES);
    let (s, _) = call(
        &app,
        put_json(
            &path,
            Some(&key),
            &json!({"markdown": exact, "author": "a"}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 201);
    let (s, e) = call(
        &app,
        put_json(
            &path,
            Some(&key),
            &json!({"markdown": format!("{exact}x"), "author": "a"}),
        )
        .to_request(),
    )
    .await;
    assert_eq!((s, e["error"].as_str()), (413, Some("payload_too_large")));
    // Escapes may inflate the wire body up to six times; the cap is on the decoded text.
    let escaped = "\u{1}".repeat(MAX_OVERVIEW_BYTES - 2) + "#\n";
    let wire = json!({"markdown": escaped, "author": "a"}).to_string();
    assert!(wire.len() > 5 * MAX_OVERVIEW_BYTES);
    let (s, e) = call(
        &app,
        put_raw(&path, Some(&key), wire.as_bytes()).to_request(),
    )
    .await;
    assert_eq!(s, 201, "{e}");
    assert_eq!(wb.overview_versions().unwrap().len(), 2);
}

#[actix_web::test]
async fn the_stream_sends_the_latest_overview_then_each_new_digest_without_an_id() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "overview").await;
    let wb = f.api.client.ensure_project("overview").unwrap().0;
    let other = f.api.client.ensure_project("other").unwrap().0;
    let path = format!("/projects/{}/overview", wb.id());
    call(
        &app,
        put_json(
            &path,
            Some(&key),
            &json!({"markdown": "# First\n", "author": "ada"}),
        )
        .to_request(),
    )
    .await;
    other.put_overview("# Other\n", "ada").unwrap();
    let url = format!("/stream?project={}&after=0", wb.id());
    let response = test::call_service(&app, get(&url, Some(&key)).to_request()).await;
    let mut body = response.into_body();
    let data = overview_frame(&mut body, Duration::from_secs(3))
        .await
        .expect("latest on connect");
    // OV-7: the event's data is the overview route's body, byte for byte.
    assert_eq!(data, raw_get(&app, &path, &key).await);
    let first: Value = serde_json::from_str(&data).unwrap();
    assert_eq!(first["project_id"], wb.id());
    let first = &first["overview"];
    assert_eq!(
        (&first["markdown"], &first["seq"], &first["author"]),
        (&json!("# First\n"), &json!(1), &json!("ada"))
    );
    assert_eq!(first["digest"], sha256_hex([&b"# First\n"[..]]));
    assert!(first["created"].is_f64());

    // An unchanged digest sends nothing, whoever writes it. The unchanged
    // write wakes no stream, so a display write wakes this one explicitly,
    // and the wait outlasts the 1 s poll as well: both re-reads must find
    // the overview's digest already sent.
    call(
        &app,
        put_json(
            &path,
            Some(&key),
            &json!({"markdown": "# First\n", "author": "grace"}),
        )
        .to_request(),
    )
    .await;
    let (s, _) = call(
        &app,
        put_raw(
            &format!("/projects/{}/display", wb.id()),
            Some(&key),
            br#"{"format":1,"title":"wake"}"#,
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 201);
    assert!(
        overview_event(&mut body, Duration::from_millis(2500))
            .await
            .is_none()
    );
    call(
        &app,
        put_json(
            &path,
            Some(&key),
            &json!({"markdown": "# Live\n", "author": "grace"}),
        )
        .to_request(),
    )
    .await;
    let live = overview_event(&mut body, Duration::from_secs(3))
        .await
        .unwrap();
    assert_eq!(
        (&live["overview"]["markdown"], &live["overview"]["seq"]),
        (&json!("# Live\n"), &json!(2))
    );
    // Another process: no broadcast, so the poll must find it.
    let external = autophys::connect(Some(f.api.client.root().to_str().unwrap())).unwrap();
    external
        .project_by_id(wb.id())
        .unwrap()
        .put_overview("# External\n", "bob")
        .unwrap();
    let ext = overview_event(&mut body, Duration::from_secs(3))
        .await
        .unwrap();
    assert_eq!(
        (&ext["overview"]["markdown"], &ext["overview"]["author"]),
        (&json!("# External\n"), &json!("bob"))
    );

    // A reconnect gets the latest again; the record cursor is untouched.
    let resumed = test::call_service(
        &app,
        get(&url, Some(&key))
            .insert_header(("last-event-id", "0"))
            .to_request(),
    )
    .await;
    let again = overview_event(&mut resumed.into_body(), Duration::from_secs(3))
        .await
        .unwrap();
    assert_eq!(again["overview"]["markdown"], "# External\n");

    // Unscoped streams carry every project's overview.
    let all = test::call_service(&app, get("/stream?after=0", Some(&key)).to_request()).await;
    let mut all = all.into_body();
    let mut seen = vec![
        overview_event(&mut all, Duration::from_secs(3))
            .await
            .unwrap()["project_id"]
            .clone(),
        overview_event(&mut all, Duration::from_secs(3))
            .await
            .unwrap()["project_id"]
            .clone(),
    ];
    seen.sort_by_key(|v| v.to_string());
    let mut want = vec![json!(wb.id()), json!(other.id())];
    want.sort_by_key(|v| v.to_string());
    assert_eq!(seen, want);
}
