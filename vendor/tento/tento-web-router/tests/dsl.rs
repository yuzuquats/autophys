//! Consumer-side tests of the `#[derive(Router)]` DSL — in `tests/` because
//! the generated code names `tento_web_router::…` paths, which only resolve
//! where the crate is external, exactly as every real consumer sees it.

use actix_web::{App, test};
use tento_web_router::Router;

#[derive(Router)]
#[router {
  "/api" {
    "/apps" {
      get
    }
  }
}]
struct HeadApi;

mod api {
  pub mod apps {
    pub mod get {
      use actix_web::HttpResponse;

      #[tento_web_router::api(responses((status = 200)))]
      pub async fn route() -> HttpResponse {
        HttpResponse::Ok().body("apps")
      }
    }
  }
}

#[actix_web::test]
async fn get_implies_head() {
  let app = test::init_service(App::new().service(HeadApi::service())).await;
  let req = test::TestRequest::with_uri("/api/apps")
    .method(actix_web::http::Method::HEAD)
    .to_request();
  let res = test::call_service(&app, req).await;
  assert_eq!(
    res.status(),
    actix_web::http::StatusCode::OK,
    "a GET-only DSL resource must answer HEAD, not 405"
  );
  // No body assertion: stripping the body from a HEAD response happens in the
  // HTTP dispatcher, a layer below the service `call_service` exercises. This
  // layer's whole contract is that the route matches.
}

#[actix_web::test]
async fn get_itself_still_answers() {
  let app = test::init_service(App::new().service(HeadApi::service())).await;
  let req = test::TestRequest::get().uri("/api/apps").to_request();
  let res = test::call_service(&app, req).await;
  assert_eq!(res.status(), actix_web::http::StatusCode::OK);
  let body = test::read_body(res).await;
  assert_eq!(&body[..], b"apps");
}

#[actix_web::test]
async fn documentation_returns_owned_document_without_changing_legacy_hooks() {
  let document: tento_openapi::OpenApi = HeadApi::apidoc();
  let json = serde_json::to_value(document).unwrap();
  assert_eq!(
    json,
    serde_json::json!({
      "openapi": "3.1.0", "info": { "title": "", "version": "" },
      "paths": { "/api/apps": { "get": { "operationId": "route", "responses": { "200": { "description": "" } } } } },
      "components": {}
    })
  );
}
