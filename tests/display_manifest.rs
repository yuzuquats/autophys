//! DM-1: real workbook persistence and HTTP/SSE behavior.
mod common;

use actix_web::{App, body::MessageBody, test};
use autophys::{MAX_DISPLAY_BYTES, canonical, sha256_hex};
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

async fn display_event<B: MessageBody + Unpin>(body: &mut B) -> Value
where
    B::Error: std::fmt::Debug,
{
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let chunk = std::future::poll_fn(|cx| Pin::new(&mut *body).poll_next(cx))
                .await
                .unwrap()
                .unwrap();
            let frame = std::str::from_utf8(&chunk).unwrap();
            if frame.starts_with("event: display\n") {
                assert!(!frame.contains("\nid: "));
                return serde_json::from_str(
                    frame
                        .lines()
                        .find_map(|s| s.strip_prefix("data: "))
                        .unwrap(),
                )
                .unwrap();
            }
        }
    })
    .await
    .expect("display event timed out")
}

#[actix_web::test]
async fn golden_manifests_roundtrip_and_latest_upload_wins() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "display").await;
    let wb = f.api.client.ensure_project("display").unwrap().0;
    let pid = wb.id();
    let path = format!("/projects/{pid}/display");
    let (_, empty) = call(&app, get("/workspace", Some(&key)).to_request()).await;
    assert_eq!(empty["projects"][0]["display"], Value::Null);
    // DM-D1: reads leave format 1; the daemon's first display write moves
    // that workbook (only) to format 2, through Workbook::put_display.
    let format = |p: &std::path::Path| -> i64 {
        rusqlite::Connection::open(p)
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(format(wb.path()), 1);
    let config = br#"{"physics":true}"#;
    let version = format!("sha256:{}", sha256_hex([&config[..]]));
    wb.put_config_version(&version, config).unwrap();
    let mut first = Vec::new();
    for (i, name) in ["battery_ecm", "oscillator", "thermal_rc"]
        .iter()
        .enumerate()
    {
        let bytes = std::fs::read(format!(
            "{}/sdks/rust/src/models/fixtures/display/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        if i == 0 {
            first = bytes.clone();
        }
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let (status, reply) = call(&app, put_raw(&path, Some(&key), &bytes).to_request()).await;
        assert_eq!(status, 201, "{reply}");
        assert_eq!(reply["digest"], sha256_hex([canonical(&value).as_bytes()]));
        let (_, ws) = call(
            &app,
            get(&format!("/workspace?project={pid}"), Some(&key)).to_request(),
        )
        .await;
        assert_eq!(ws["projects"][0]["display"], value);
        assert_eq!(ws["cursor"], 0);
        assert_eq!(ws["config_versions"][0]["version"], version);
        let stored = wb.display().unwrap().unwrap();
        let pretty = serde_json::to_vec_pretty(&value).unwrap();
        assert_eq!(
            call(&app, put_raw(&path, Some(&key), &pretty).to_request())
                .await
                .0,
            200
        );
        assert_eq!(wb.display().unwrap().unwrap(), stored);
    }
    // Uploading an earlier manifest again must replace the newest one.
    assert_eq!(
        call(&app, put_raw(&path, Some(&key), &first).to_request())
            .await
            .0,
        201
    );
    let reopened = autophys::connect(Some(f.api.client.root().to_str().unwrap())).unwrap();
    assert_eq!(
        reopened.project_by_id(pid).unwrap().display().unwrap(),
        wb.display().unwrap()
    );
    let other = f.api.client.ensure_project("other").unwrap().0;
    assert!(other.display().unwrap().is_none());
    assert!(wb.verify().unwrap().ok);
    assert_eq!((format(wb.path()), format(other.path())), (2, 1));
}

#[actix_web::test]
async fn format_only_validation_auth_and_missing_project() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "display").await;
    let wb = f.api.client.ensure_project("display").unwrap().0;
    let path = format!("/projects/{}/display", wb.id());
    for body in [
        r#"{}"#,
        r#"[]"#,
        r#"{"format":2}"#,
        r#"{"format":true}"#,
        r#"{"format":"1"}"#,
        r#"{"format":1.0}"#,
        "{",
    ] {
        let (status, error) = call(
            &app,
            put_raw(&path, Some(&key), body.as_bytes()).to_request(),
        )
        .await;
        assert_eq!(status, 422, "{error}");
    }
    let body = br#"{"format":1,"future":{"anything":[null,false,7]}}"#;
    assert_eq!(
        call(&app, put_raw(&path, None, body).to_request()).await.0,
        401
    );
    assert_eq!(
        call(
            &app,
            put_raw("/projects/prj_missing/display", Some(&key), body).to_request()
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(&app, put_raw(&path, Some(&key), body).to_request())
            .await
            .0,
        201
    );
}

#[actix_web::test]
async fn size_cap_checks_wire_and_canonical_bytes_inclusively() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "display").await;
    let wb = f.api.client.ensure_project("display").unwrap().0;
    let path = format!("/projects/{}/display", wb.id());
    let prefix = r#"{"format":1,"x":""#;
    let suffix = r#""}"#;
    let exact = format!(
        "{prefix}{}{suffix}",
        "a".repeat(MAX_DISPLAY_BYTES - prefix.len() - suffix.len())
    );
    assert_eq!(exact.len(), MAX_DISPLAY_BYTES);
    assert_eq!(
        call(
            &app,
            put_raw(&path, Some(&key), exact.as_bytes()).to_request()
        )
        .await
        .0,
        201
    );
    let old = wb.display().unwrap();
    let too_big = format!("{exact} ");
    let (s, e) = call(
        &app,
        put_raw(&path, Some(&key), too_big.as_bytes()).to_request(),
    )
    .await;
    assert_eq!((s, e["error"].as_str()), (413, Some("payload_too_large")));
    let expands = serde_json::to_vec(&json!({"format":1,"x":"é".repeat(50_000)})).unwrap();
    assert!(expands.len() < MAX_DISPLAY_BYTES);
    assert_eq!(
        call(&app, put_raw(&path, Some(&key), &expands).to_request())
            .await
            .0,
        413
    );
    assert_eq!(wb.display().unwrap(), old);
    assert!(matches!(
        wb.put_display(too_big.as_bytes()),
        Err(autophys::Error::TooLarge(_))
    ));
}

#[actix_web::test]
async fn display_stream_reconnect_live_poll_and_project_filter() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "display").await;
    let wb = f.api.client.ensure_project("display").unwrap().0;
    let other = f.api.client.ensure_project("other").unwrap().0;
    let path = format!("/projects/{}/display", wb.id());
    call(
        &app,
        put_raw(&path, Some(&key), br#"{"format":1,"label":"first"}"#).to_request(),
    )
    .await;
    other
        .put_display(br#"{"format":1,"label":"other"}"#)
        .unwrap();
    let url = format!("/stream?project={}&after=0", wb.id());
    let response = test::call_service(&app, get(&url, Some(&key)).to_request()).await;
    let mut body = response.into_body();
    let first = display_event(&mut body).await;
    assert_eq!(first["project_id"], wb.id());
    assert_eq!(first["display"]["label"], "first");
    call(
        &app,
        put_raw(&path, Some(&key), br#"{"format":1,"label":"live"}"#).to_request(),
    )
    .await;
    assert_eq!(display_event(&mut body).await["display"]["label"], "live");
    // Independent process connection: no broadcast, so this requires the poll.
    let external = autophys::connect(Some(f.api.client.root().to_str().unwrap())).unwrap();
    external
        .project_by_id(wb.id())
        .unwrap()
        .put_display(br#"{"format":1,"label":"external"}"#)
        .unwrap();
    assert_eq!(
        display_event(&mut body).await["display"]["label"],
        "external"
    );
    let resumed = test::call_service(
        &app,
        get(&url, Some(&key))
            .insert_header(("last-event-id", "0"))
            .to_request(),
    )
    .await;
    assert_eq!(
        display_event(&mut resumed.into_body()).await["display"]["label"],
        "external"
    );
    let all = test::call_service(&app, get("/stream", Some(&key)).to_request()).await;
    let mut all = all.into_body();
    let a = display_event(&mut all).await;
    let b = display_event(&mut all).await;
    assert_ne!(a["project_id"], b["project_id"]);
}

#[actix_web::test]
async fn unrelated_wakeups_do_not_postpone_external_display_polling() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "display").await;
    let a = f.api.client.ensure_project("quiet").unwrap().0;
    let b = f.api.client.ensure_project("busy").unwrap().0;
    a.put_display(br#"{"format":1,"label":"first"}"#).unwrap();
    let response = test::call_service(
        &app,
        get(&format!("/stream?project={}", a.id()), Some(&key)).to_request(),
    )
    .await;
    let mut body = response.into_body();
    assert_eq!(display_event(&mut body).await["project_id"], a.id());
    let external = autophys::connect(Some(f.api.client.root().to_str().unwrap())).unwrap();
    external
        .project_by_id(a.id())
        .unwrap()
        .put_display(br#"{"format":1,"label":"external"}"#)
        .unwrap();

    let spam = async {
        let path = format!("/projects/{}/display", b.id());
        // Keep unrelated wakeups arriving for longer than the allowed poll delay.
        for i in 0..32 {
            let bytes = serde_json::to_vec(&json!({"format":1,"iteration":i})).unwrap();
            assert_eq!(
                call(&app, put_raw(&path, Some(&key), &bytes).to_request())
                    .await
                    .0,
                201
            );
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    };
    let receive = async {
        let event = tokio::time::timeout(Duration::from_millis(1500), display_event(&mut body))
            .await
            .expect("unrelated writes postponed the one-second external poll");
        assert_eq!(
            event["project_id"],
            a.id(),
            "unrelated display must not leak"
        );
        assert_eq!(event["display"]["label"], "external");
    };
    tokio::join!(spam, receive);
}
