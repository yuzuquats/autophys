//! The browser creates executable configuration and runs the same approval log.
mod common;
use actix_web::{App, test};
use autophys_cli::http::configure;
use common::*;
use serde_json::{Value, json};
use std::time::Duration;

fn setup(name: &str) -> Value {
    json!({"name":name,"model":"thermal_rc","c":400.,"r":1.5,"power":10.,"duration":600.})
}
#[actix_web::test]
async fn browser_starter_enforces_session_origin_and_configuration() {
    let f = fixture();
    let api = f.api.clone();
    let app =
        test::init_service(App::new().configure(move |cfg| configure(cfg, api.clone()))).await;
    let body = setup("Browser project");
    let (status, _) = call(
        &app,
        post("/workbench/projects", None, &body)
            .insert_header(("origin", ORIGIN))
            .to_request(),
    )
    .await;
    assert_eq!(status, 401);
    let (status, _) = call(
        &app,
        browser(&f.api, post("/workbench/projects", None, &body), false).to_request(),
    )
    .await;
    assert_eq!(status, 403);
    let mut invalid = body.clone();
    invalid["duration"] = json!(1e9);
    let (status, _) = call(
        &app,
        browser(&f.api, post("/workbench/projects", None, &invalid), true).to_request(),
    )
    .await;
    assert_eq!(status, 422);
    assert!(f.api.client.projects().unwrap().is_empty());
    let (status, created) = call(
        &app,
        browser(&f.api, post("/workbench/projects", None, &body), true).to_request(),
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let (status, _) = call(
        &app,
        browser(&f.api, post("/workbench/projects", None, &body), true).to_request(),
    )
    .await;
    assert_eq!(status, 422);
    let wb = f
        .api
        .client
        .project_by_id(created["project_id"].as_str().unwrap())
        .unwrap();
    let config = wb.config_versions().unwrap();
    assert_eq!(config.len(), 1);
    assert_eq!(config[0].config["params"]["C"]["initial"], 400.);
    let route = format!("/workbench/projects/{}/investigations", wb.id());
    let (status, _) = call(
        &app,
        browser(
            &f.api,
            post(&route, None, &json!({"config_version":"unknown"})),
            true,
        )
        .to_request(),
    )
    .await;
    assert_eq!(status, 422);
}

#[actix_web::test]
async fn browser_loop_waits_then_continues_after_approve_and_reject() {
    for approve in [true, false] {
        let f = fixture();
        let api = f.api.clone();
        let app =
            test::init_service(App::new().configure(move |cfg| configure(cfg, api.clone()))).await;
        let (_, created) = call(
            &app,
            browser(
                &f.api,
                post("/workbench/projects", None, &setup("Run")),
                true,
            )
            .to_request(),
        )
        .await;
        let route = format!(
            "/workbench/projects/{}/investigations",
            created["project_id"].as_str().unwrap()
        );
        let request = json!({"config_version":created["config_version"]});
        let (status, started) = call(
            &app,
            browser(&f.api, post(&route, None, &request), true).to_request(),
        )
        .await;
        assert_eq!(status, 201, "{started}");
        let record = f
            .api
            .client
            .find_investigation(started["id"].as_str().unwrap())
            .unwrap();
        let proposal = tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                if let Some(r) = record.records(Some("proposal")).unwrap().into_iter().next() {
                    break record
                        .proposal(r.payload["proposal_id"].as_str().unwrap())
                        .unwrap();
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(proposal.status, "proposed");
        assert_eq!(record.records(Some("measurement")).unwrap().len(), 2);
        let (status, _) = call(
            &app,
            browser(&f.api, post(&route, None, &request), true).to_request(),
        )
        .await;
        assert_eq!(status, 400, "duplicate active run refused");
        let event = if approve { "approved" } else { "rejected" };
        let path = format!(
            "/investigations/{}/proposals/{}/approvals",
            record.id, proposal.proposal_id
        );
        let (status, answer) = call(&app, browser(&f.api, post(&path, None, &json!({
            "id":"browser-decision","kind":"proposal","payload":{"proposal_id":proposal.proposal_id,"event":event,"by":"browser"}
        })), true).to_request()).await;
        assert_eq!(status, 201, "{answer}");
        let outcome = tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                let outcomes = record.records(Some("outcome")).unwrap();
                if let Some(last) = outcomes.last() {
                    if last.payload["status"] != "awaiting_data" {
                        break last.payload.clone();
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            ["validated", "inconclusive"].contains(&outcome["status"].as_str().unwrap()),
            "{outcome}"
        );
        assert!(!record.records(Some("run")).unwrap().is_empty());
        assert_eq!(
            record.records(Some("measurement")).unwrap().len(),
            if approve { 3 } else { 2 }
        );
        assert_eq!(
            record.proposal(&proposal.proposal_id).unwrap().status,
            if approve { "data_attached" } else { "rejected" }
        );
    }
}
