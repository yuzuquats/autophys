//! GT-1 and FC-1 daemon/store contract; no simulator behavior is changed.
mod common;
use actix_web::{App, test};
use autophys::{Envelope, Kind, canonical, sha256_hex};
use autophys_cli::http::configure;
use common::*;
use serde_json::{Value, json};

macro_rules! app {
    ($api:expr) => {{
        let api = $api.clone();
        test::init_service(App::new().configure(move |cfg| configure(cfg, api.clone()))).await
    }};
}
fn investigation(api: &autophys_cli::http::Api, name: &str) -> autophys::Investigation {
    let wb = api.client.project(name).unwrap();
    let bytes = b"{}";
    let version = format!("sha256:{}", sha256_hex([&bytes[..]]));
    wb.put_config_version(&version, bytes).unwrap();
    wb.create_investigation(json!({"config_version":version}), None)
        .unwrap()
        .0
}
fn envelope(id: &str, kind: &str, payload: Value) -> Value {
    json!({"id":id,"kind":kind,"payload":payload})
}

#[actix_web::test]
async fn reveal_requires_own_outcome_replays_and_streams() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "truth").await;
    let inv = investigation(&f.api, "truth");
    let other = investigation(&f.api, "truth");
    other
        .append("outcome", json!({"status":"anything"}), None)
        .unwrap();
    let path = format!("/investigations/{}/reveal", inv.id);
    // Opaque payload: the daemon does not interpret source/truth/ratios.
    let payload = json!({"future":[true,{"opaque":"truth"}]});
    let body = envelope("truth-1", "reveal", payload.clone());
    let before = inv.workbook().cursor().unwrap();
    let (s, e) = call(&app, post(&path, Some(&key), &body).to_request()).await;
    assert_eq!((s, e["error"].as_str()), (409, Some("outcome_required")));
    assert!(e["message"].as_str().unwrap().contains("outcome"));
    assert_eq!(inv.workbook().cursor().unwrap(), before);
    assert!(inv.records(Some("reveal")).unwrap().is_empty());
    let outcome_path = format!("/investigations/{}/outcome", inv.id);
    let outcome = envelope(
        "done",
        "outcome",
        json!({"status":"arbitrary-final-status"}),
    );
    assert_eq!(
        call(&app, post(&outcome_path, Some(&key), &outcome).to_request())
            .await
            .0,
        201
    );
    let cursor = inv.workbook().cursor().unwrap();
    let response = test::call_service(
        &app,
        get(
            &format!("/stream?investigation={}&after={cursor}", inv.id),
            Some(&key),
        )
        .to_request(),
    )
    .await;
    let mut stream = response.into_body();
    let (s, stored) = call(&app, post(&path, Some(&key), &body).to_request()).await;
    assert_eq!(s, 201, "{stored}");
    assert_eq!(stored["record"]["payload"], payload);
    let events = sse_records(&mut stream, 1).await;
    assert_eq!(events[0].1, stored["record"]);
    let (s, replay) = call(
        &app,
        post(&path, Some(&key), &body)
            .insert_header(("idempotency-key", "truth-1"))
            .to_request(),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(stored, replay);
    let second = envelope("truth-2", "reveal", payload.clone());
    let (s, e) = call(&app, post(&path, Some(&key), &second).to_request()).await;
    assert_eq!((s, e["error"].as_str()), (409, Some("already_revealed")));
    let changed = envelope("truth-1", "reveal", json!({"other":true}));
    let (s, e) = call(&app, post(&path, Some(&key), &changed).to_request()).await;
    assert_eq!(
        (s, e["error"].as_str()),
        (409, Some("idempotency_conflict"))
    );
    let (_, read) = call(
        &app,
        get(
            &format!("/investigations/{}/records?kind=reveal", inv.id),
            Some(&key),
        )
        .to_request(),
    )
    .await;
    assert_eq!(read["records"], json!([stored["record"]]));
    let (_, ws) = call(&app, get("/workspace", Some(&key)).to_request()).await;
    assert!(
        ws["records"]
            .as_array()
            .unwrap()
            .contains(&stored["record"])
    );
    assert_eq!(inv.info().unwrap().status, "arbitrary-final-status");
    assert!(inv.workbook().verify().unwrap().ok);
    assert!(inv.workbook().rebuild_projections().unwrap().ok);
}

#[actix_web::test]
async fn reveal_auth_envelope_and_size_errors() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "truth").await;
    let inv = investigation(&f.api, "truth");
    inv.append("outcome", json!({"status":"done"}), None)
        .unwrap();
    let path = format!("/investigations/{}/reveal", inv.id);
    let body = envelope("r", "reveal", json!({}));
    assert_eq!(
        call(&app, post(&path, None, &body).to_request()).await.0,
        401
    );
    for (body, want) in [
        (envelope("r", "step", json!({})), 400),
        (envelope("r", "reveal", json!([])), 422),
        (json!({"kind":"reveal","payload":{}}), 422),
    ] {
        assert_eq!(
            call(&app, post(&path, Some(&key), &body).to_request())
                .await
                .0,
            want
        );
    }
    assert_eq!(
        call(
            &app,
            post(&path, Some(&key), &body).set_payload("{").to_request()
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            &app,
            post(&path, Some(&key), &body)
                .insert_header(("idempotency-key", "wrong"))
                .to_request()
        )
        .await
        .0,
        400
    );
    let large = envelope(
        "large",
        "reveal",
        json!({"x":"x".repeat(autophys::MAX_PAYLOAD_BYTES)}),
    );
    assert_eq!(
        call(&app, post(&path, Some(&key), &large).to_request())
            .await
            .0,
        413
    );
    assert!(inv.records(Some("reveal")).unwrap().is_empty());
}

#[actix_web::test]
async fn run_curves_validate_shape_points_and_whole_payload_cap() {
    let f = fixture();
    let app = app!(f.api);
    let key = pair(&app, &f.api, "curves").await;
    let inv = investigation(&f.api, "curves");
    let path = format!("/investigations/{}/runs", inv.id);
    let curves = json!({"measurement-1":{"fit":{"T":[1,2]},"initial":{"T":[3,4]},"t":[0,1]}});
    let body = envelope("good", "run", json!({"curves":curves,"opaque":"untouched"}));
    let (s, r) = call(&app, post(&path, Some(&key), &body).to_request()).await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(r["record"]["payload"], body["payload"]);
    for (i, bad) in [
        Value::Null,
        json!([]),
        json!({"m":[]}),
        json!({"m":{"fit":[],"initial":{}}}),
        json!({"m":{"fit":{} }}),
        json!({"m":{"fit":{"T":[true]},"initial":{"T":[1]}}}),
        json!({"m":{"fit":{"T":[1]},"initial":{"T":[1,2]}}}),
        json!({"m":{"fit":{"T":[1]},"initial":{"T":[1]},"t":[0,1]}}),
        json!({"m":{"fit":{"T":[1]},"initial":{"T":[1]},"t":[null]}}),
        json!({"m":{"fit":{"T":vec![1;2001]},"initial":{"T":vec![1;2001]}}}),
    ]
    .into_iter()
    .enumerate()
    {
        let (s, e) = call(
            &app,
            post(
                &path,
                Some(&key),
                &envelope(&format!("bad-{i}"), "run", json!({"curves":bad})),
            )
            .to_request(),
        )
        .await;
        assert_eq!(s, 422, "{e}");
        assert!(e["path"].as_str().unwrap().starts_with("payload.curves"));
    }
    // Exact whole-run canonical limit is accepted; one extra byte is not.
    let mut payload = json!({"curves":{},"padding":""});
    let overhead = canonical(&payload).len();
    payload["padding"] = json!("x".repeat(256 * 1024 - overhead));
    assert_eq!(canonical(&payload).len(), 256 * 1024);
    assert_eq!(
        call(
            &app,
            post(
                &path,
                Some(&key),
                &envelope("exact", "run", payload.clone())
            )
            .to_request()
        )
        .await
        .0,
        201
    );
    payload["padding"].as_str().unwrap();
    payload["padding"] = json!("x".repeat(256 * 1024 - overhead + 1));
    assert_eq!(
        call(
            &app,
            post(&path, Some(&key), &envelope("big", "run", payload)).to_request()
        )
        .await
        .0,
        413
    );
    // The added curve cap does not constrain old runs without curves.
    assert!(
        inv.append("run", json!({"padding":"x".repeat(300_000)}), None)
            .is_ok()
    );
    assert!(
        autophys::validate::payload_shape(
            Kind::Run,
            &json!({"curves":{"m":{"fit":{"T":vec![0;2000]},"initial":{"T":vec![0;2000]}}}})
        )
        .is_ok()
    );
}

#[actix_web::test]
async fn local_writers_enforce_outcome_and_single_reveal_atomically() {
    let f = fixture();
    let inv = investigation(&f.api, "truth");
    assert!(matches!(
        inv.append("reveal", json!({}), Some("early")),
        Err(autophys::Error::Conflict {
            code: "outcome_required",
            ..
        })
    ));
    inv.append("outcome", json!({"status":"done"}), None)
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut threads = Vec::new();
    for id in ["one", "two"] {
        let root = f.api.client.root().to_str().unwrap().to_string();
        let inv_id = inv.id.clone();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            let client = autophys::connect(Some(&root)).unwrap();
            let inv = client.find_investigation(&inv_id).unwrap();
            barrier.wait();
            inv.append("reveal", json!({}), Some(id))
        }));
    }
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(
                r,
                Err(autophys::Error::Conflict {
                    code: "already_revealed",
                    ..
                })
            ))
            .count(),
        1
    );
    assert_eq!(inv.records(Some("reveal")).unwrap().len(), 1);
}

#[actix_web::test]
async fn python_curve_reveal_workbook_validates_and_rebuilds() {
    let f = fixture();
    let input = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/conformance/python");
    std::fs::create_dir_all(f.api.client.root()).unwrap();
    std::fs::copy(
        input.join("thermal-curves-reveal.ap-workbook"),
        f.api.client.root().join("thermal.ap-workbook"),
    )
    .unwrap();
    let wb = f.api.client.project("thermal").unwrap();
    let expected: Value =
        serde_json::from_slice(&std::fs::read(input.join("thermal-curves-reveal.json")).unwrap())
            .unwrap();
    let snap = wb.snapshot().unwrap();
    assert_eq!(
        snap.records.len() as u64,
        expected["records"].as_u64().unwrap()
    );
    assert_eq!(
        serde_json::to_value(wb.heads().unwrap()).unwrap(),
        expected["heads"]
    );
    assert_eq!(wb.projection_rows().unwrap(), expected["projections"]);
    for record in &snap.records {
        Envelope::from_value(json!({"id":record.id,"kind":record.kind,"payload":record.payload}))
            .unwrap();
    }
    let run = snap.records.iter().find(|r| r.kind == "run").unwrap();
    for (label, file) in [
        ("fit", "thermal-curves-fit.json"),
        ("initial", "thermal-curves-initial.json"),
    ] {
        let golden: Value =
            serde_json::from_slice(&std::fs::read(input.join(file)).unwrap()).unwrap();
        let values = &golden["expect"]["y"]["value"]["T"];
        assert!(
            run.payload["curves"]
                .as_object()
                .unwrap()
                .values()
                .any(|entry| &entry[label]["T"] == values),
            "golden {label} curve is present in workbook"
        );
    }
    let report = wb.verify().unwrap();
    assert!(report.ok, "{report:?}");
    assert_eq!(report.records as u64, expected["records"].as_u64().unwrap());
    assert!(wb.rebuild_projections().unwrap().ok);
    assert_eq!(wb.projection_rows().unwrap(), expected["projections"]);
}
