//! `DomainBuilder::system_routes`: routes an app mounts beside tento-web's own
//! `/_` scope, through the real `DomainConfigLike::configure`.

use actix_web::{App, HttpResponse, http::StatusCode, test, web};
use tento_web::{BuildState, DomainConfig, DomainConfigLike};

fn domain(with_app_routes: bool) -> DomainConfig {
  let mut builder = DomainConfig::builder().hostname("example.test");
  if with_app_routes {
    builder = builder
      .system_routes(|cfg| {
        cfg.service(web::scope("/_/probe").route(
          "/hello",
          web::get().to(|| async { HttpResponse::Ok().body("probe") }),
        ));
      })
      // A second call adds; it does not replace the first.
      .system_routes(|cfg| {
        cfg.route(
          "/probe-top",
          web::get().to(|| async { HttpResponse::Ok().body("top") }),
        );
      });
  }
  builder.build()
}

/// Status and body of one request against `domain`, mounted the way
/// `TentoWebServer` mounts every domain.
async fn call(domain: DomainConfig, req: test::TestRequest) -> (StatusCode, String) {
  let root = tempfile::tempdir().expect("routes root");
  let state = BuildState::single_stage(root.path().to_path_buf());
  let app =
    test::init_service(App::new().configure(|cfg| domain.configure(cfg, web::scope(""), &state)))
      .await;
  let resp = test::call_service(
    &app,
    req.insert_header(("host", "example.test")).to_request(),
  )
  .await;
  let status = resp.status();
  let body = test::read_body(resp).await;
  (status, String::from_utf8_lossy(&body).into_owned())
}

fn get(uri: &str) -> test::TestRequest {
  test::TestRequest::get().uri(uri)
}

#[actix_web::test]
async fn app_routes_under_the_system_prefix_are_reachable() {
  assert_eq!(
    call(domain(true), get("/_/probe/hello")).await,
    (StatusCode::OK, "probe".to_string())
  );
  assert_eq!(
    call(domain(true), get("/probe-top")).await,
    (StatusCode::OK, "top".to_string())
  );
  // Without the registration the same path is just a miss.
  assert_eq!(
    call(domain(false), get("/_/probe/hello")).await.0,
    StatusCode::NOT_FOUND
  );
}

#[actix_web::test]
async fn app_routes_leave_the_system_routes_alone() {
  for with_app_routes in [false, true] {
    assert_eq!(
      call(domain(with_app_routes), get("/_/app/ping")).await,
      (StatusCode::OK, "pong".to_string()),
      "with_app_routes = {with_app_routes}"
    );
  }

  // The ux-test routes answer exactly as they do without app routes. Their
  // stores are not configured here, so the write route's 500 is the proof it
  // was routed (a miss would be 404); the gated read 404s at its guard.
  let abandon = || {
    test::TestRequest::post()
      .uri("/_/ux-test/abandon")
      .set_json(serde_json::json!({ "sessionId": "s" }))
  };
  let bare = call(domain(false), abandon()).await.0;
  assert_eq!(bare, StatusCode::INTERNAL_SERVER_ERROR);
  assert_eq!(call(domain(true), abandon()).await.0, bare);
  assert_eq!(
    call(domain(true), get("/_/ux-test/pending")).await.0,
    call(domain(false), get("/_/ux-test/pending")).await.0
  );
}

#[actix_web::test]
async fn tento_web_serves_no_fleet_routes_of_its_own() {
  for path in ["/_/fleet/install.sh", "/_/fleet/window/w", "/fleet"] {
    assert_eq!(
      call(domain(false), get(path)).await.0,
      StatusCode::NOT_FOUND,
      "{path}"
    );
  }
}
