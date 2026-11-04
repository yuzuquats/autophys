//! Generic request-observation hook: domains contribute [`RequestObserver`]s
//! (attribution capture, analytics, audit — anything that watches traffic
//! without touching it), and the server wraps one [`ObserverMiddleware`]
//! around the App. Keeps tento-web free of feature-crate dependencies: the
//! observer implementations live with their features, the composition lives
//! here.

use std::future::{Future, Ready, ready};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use actix_web::Error;
use actix_web::dev::{Service, ServiceRequest, ServiceResponse, Transform};
use actix_web::http::StatusCode;

/// Completion half of an observation: invoked with the response status once
/// the inner service finishes.
pub type CompletionObserver = Box<dyn FnOnce(StatusCode) + Send>;

/// Watches requests without modifying them. `observe` runs before the
/// handler (extract what you need from the request there) and returns the
/// completion callback to run after — or `None` when the request is of no
/// interest. Observers MUST be cheap and infallible: they can never block,
/// fail, or slow a request.
pub trait RequestObserver: Send + Sync {
  fn observe(&self, req: &ServiceRequest) -> Option<CompletionObserver>;
}

/// Passthrough middleware fanning each request out to every observer. With
/// no observers it is a no-op, so the server can wrap it unconditionally.
#[derive(Clone)]
pub struct ObserverMiddleware {
  observers: Arc<[Arc<dyn RequestObserver>]>,
}

impl ObserverMiddleware {
  pub fn new(observers: Vec<Arc<dyn RequestObserver>>) -> ObserverMiddleware {
    ObserverMiddleware {
      observers: observers.into(),
    }
  }

  pub fn is_empty(&self) -> bool {
    self.observers.is_empty()
  }
}

impl<S, B> Transform<S, ServiceRequest> for ObserverMiddleware
where
  S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
  S::Future: 'static,
  B: 'static,
{
  type Response = ServiceResponse<B>;
  type Error = Error;
  type InitError = ();
  type Transform = ObserverMiddlewareService<S>;
  type Future = Ready<Result<Self::Transform, Self::InitError>>;

  fn new_transform(&self, service: S) -> Self::Future {
    ready(Ok(ObserverMiddlewareService {
      service,
      observers: self.observers.clone(),
    }))
  }
}

pub struct ObserverMiddlewareService<S> {
  service: S,
  observers: Arc<[Arc<dyn RequestObserver>]>,
}

impl<S, B> Service<ServiceRequest> for ObserverMiddlewareService<S>
where
  S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
  S::Future: 'static,
  B: 'static,
{
  type Response = ServiceResponse<B>;
  type Error = Error;
  type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>>>>;

  fn poll_ready(&self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
    self.service.poll_ready(cx)
  }

  fn call(&self, req: ServiceRequest) -> Self::Future {
    let mut pending: Vec<CompletionObserver> = Vec::new();
    for observer in self.observers.iter() {
      if let Some(completion) = observer.observe(&req) {
        pending.push(completion);
      }
    }
    let fut = self.service.call(req);
    Box::pin(async move {
      let res = fut.await?;
      let status = res.status();
      for completion in pending {
        completion(status);
      }
      Ok(res)
    })
  }
}

#[cfg(test)]
mod tests {
  use std::sync::Mutex;

  use actix_web::test as actix_test;
  use actix_web::{App, HttpResponse, web};

  use super::*;

  struct Recording(Mutex<Vec<(String, u16)>>);

  impl RequestObserver for Arc<Recording> {
    fn observe(&self, req: &ServiceRequest) -> Option<CompletionObserver> {
      if req.path() == "/ignored" {
        return None;
      }
      let path = req.path().to_string();
      let sink = self.clone();
      Some(Box::new(move |status: StatusCode| {
        sink.0.lock().unwrap().push((path, status.as_u16()));
      }))
    }
  }

  #[actix_web::test]
  async fn observers_see_path_and_final_status() {
    let recording = Arc::new(Recording(Mutex::new(Vec::new())));
    let app = actix_test::init_service(
      App::new()
        .wrap(ObserverMiddleware::new(vec![Arc::new(recording.clone())]))
        .route(
          "/hit",
          web::get().to(|| async { HttpResponse::Ok().finish() }),
        )
        .route(
          "/ignored",
          web::get().to(|| async { HttpResponse::Ok().finish() }),
        )
        .route(
          "/fail",
          web::get().to(|| async { HttpResponse::BadRequest().finish() }),
        ),
    )
    .await;

    for path in ["/hit", "/ignored", "/fail"] {
      let req = actix_test::TestRequest::get().uri(path).to_request();
      actix_test::call_service(&app, req).await;
    }

    let seen = recording.0.lock().unwrap().clone();
    assert_eq!(
      seen,
      vec![("/hit".to_string(), 200), ("/fail".to_string(), 400)]
    );
  }
}
