//! Autophys owns its HTTP surface, including rejection of inherited system routes.
mod common;

use actix_web::{App, http::Method, test, web};
use autophys_cli::{AppConfig, BuildInfo, webapp};
use std::{path::PathBuf, sync::Arc};

#[actix_web::test]
async fn product_routes_work_and_dependency_system_routes_are_product_404s() {
    let fixture = common::fixture();
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("routes")).unwrap();
    std::fs::write(
        root.path().join("routes/index.anon.html"),
        "<!doctype html><title>Autophys</title>",
    )
    .unwrap();
    let config = AppConfig {
        project_root: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        web_root: root.path().to_path_buf(),
        store: Some(fixture.api.clone()),
    };
    let app = Arc::new(webapp(&config, BuildInfo::current(), false).unwrap());
    let app =
        test::init_service(App::new().configure(move |cfg| app.configure(cfg, web::scope(""))))
            .await;
    for path in ["/", "/app", "/app/project", "/api/healthz"] {
        let response =
            test::call_service(&app, test::TestRequest::get().uri(path).to_request()).await;
        assert_eq!(response.status(), 200, "{path}");
    }
    let response =
        test::call_service(&app, test::TestRequest::get().uri("/login").to_request()).await;
    assert_eq!(response.status(), 303);
    assert_eq!(response.headers().get("location").unwrap(), "/app");
    // All methods on the entire namespace, including the bare prefix, are
    // reserved. Future upstream routes cannot silently expand the surface.
    for path in [
        "/_",
        "/_/",
        "/_/admin",
        "/_/admin/signin",
        "/_/admin/verify",
        "/_/admin/denied",
        "/_/admin/invalid",
        "/_/admin/2fac",
        "/_/admin/logs",
        "/_/admin/routes",
        "/_/admin/ux-tests",
        "/_/admin/health",
        "/_/admin/api/routes",
        "/_/admin/api/ux-test/sessions",
        "/_/admin/api/ux-test/sessions/id/logs",
        "/_/app/version",
        "/_/app/ping",
        "/_/ux-test/token",
        "/_/ux-test/logs",
        "/_/ux-test/complete",
        "/_/ux-test/step",
        "/_/ux-test/abandon",
        "/_/ux-test/pending",
        "/_/ux-test/pending-count",
        "/_/ux-test/pending-flaky",
        "/_/ux-test/session/id",
        "/_/ux-test/sessions",
        "/_/ux-test/sessions/id",
        "/_/ux-test/sessions/id/logs",
        "/_/future-upstream-route",
        "/%5f/admin/signin",
        "/_/admin/%73ignin",
        "/_/admin/signin/",
        "/_//admin/signin",
        "/_/admin/signin?next=/app",
    ] {
        for method in [
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ] {
            let response = test::call_service(
                &app,
                test::TestRequest::default()
                    .method(method.clone())
                    .uri(path)
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), 404, "{method} {path}");
            assert!(
                !response.headers().contains_key("location"),
                "{method} {path}"
            );
            let body: serde_json::Value = test::read_body_json(response).await;
            assert_eq!(body["error"], "not found", "{method} {path}");
            assert_eq!(body["ok"], false);
        }
    }
}
