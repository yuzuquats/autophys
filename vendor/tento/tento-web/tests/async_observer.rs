use actix_web::{App, HttpResponse, test as actix_test, web};
use actix_web::{dev::ServiceRequest, http::StatusCode};
use std::sync::Arc;
use std::sync::Mutex;
use tento_web::{AsyncCompletionObserver, AsyncObserverMiddleware, AsyncRequestObserver};

struct Recording(Arc<Mutex<Vec<(String, u16)>>>);
impl AsyncRequestObserver for Recording {
  fn observe(&self, req: &ServiceRequest) -> Option<AsyncCompletionObserver> {
    if req.path() == "/ignored" {
      return None;
    }
    let path = req.path().to_owned();
    let records = self.0.clone();
    Some(Box::new(move |status| {
      Box::pin(async move {
        // Completion must be polled to completion before the response returns.
        tokio::task::yield_now().await;
        records.lock().unwrap().push((path, status.as_u16()));
      })
    }))
  }
}

#[actix_web::test]
async fn awaits_capture_and_preserves_success_and_service_errors() {
  let records = Arc::new(Mutex::new(Vec::new()));
  let app = actix_test::init_service(
    App::new()
      .wrap(AsyncObserverMiddleware::new(vec![Arc::new(Recording(
        records.clone(),
      ))]))
      .route(
        "/ok",
        web::get().to(|| async { HttpResponse::Created().body("original") }),
      )
      .route(
        "/ignored",
        web::get().to(|| async { HttpResponse::Ok().finish() }),
      )
      .route(
        "/error",
        web::get().to(|| async {
          Err::<HttpResponse, _>(actix_web::error::ErrorBadRequest("original failure"))
        }),
      ),
  )
  .await;
  let response =
    actix_test::call_service(&app, actix_test::TestRequest::get().uri("/ok").to_request()).await;
  assert_eq!(response.status(), StatusCode::CREATED);
  assert_eq!(*records.lock().unwrap(), vec![("/ok".into(), 201)]);
  assert_eq!(actix_test::read_body(response).await, "original");
  let response = actix_test::call_service(
    &app,
    actix_test::TestRequest::get().uri("/error").to_request(),
  )
  .await;
  assert_eq!(response.status(), StatusCode::BAD_REQUEST);
  assert_eq!(actix_test::read_body(response).await, "original failure");
  actix_test::call_service(
    &app,
    actix_test::TestRequest::get().uri("/ignored").to_request(),
  )
  .await;
  assert_eq!(
    *records.lock().unwrap(),
    vec![("/ok".into(), 201), ("/error".into(), 400)]
  );
}
