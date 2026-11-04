//! Opt-in asynchronous completion hook: domains contribute [`AsyncRequestObserver`]s
//! (attribution capture, analytics, audit — anything that watches traffic
//! without touching it), and the server wraps one [`AsyncObserverMiddleware`]
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
pub type AsyncCompletionObserver =
  Box<dyn FnOnce(StatusCode) -> Pin<Box<dyn Future<Output = ()> + 'static>> + Send>;

/// Opt-in asynchronous completion capture. Extraction must be cheap; completion
/// must enforce a bounded admission budget and report its own health failures.
/// It cannot replace the product response. Do not spawn unbounded detached work
/// or perform blocking storage on the request executor.
pub trait AsyncRequestObserver: Send + Sync {
  fn observe(&self, req: &ServiceRequest) -> Option<AsyncCompletionObserver>;
}

/// Passthrough middleware fanning each request out to every observer. With
/// no observers it is a no-op, so the server can wrap it unconditionally.
#[derive(Clone)]
pub struct AsyncObserverMiddleware {
  observers: Arc<[Arc<dyn AsyncRequestObserver>]>,
}

impl AsyncObserverMiddleware {
  pub fn new(observers: Vec<Arc<dyn AsyncRequestObserver>>) -> AsyncObserverMiddleware {
    AsyncObserverMiddleware {
      observers: observers.into(),
    }
  }

  pub fn is_empty(&self) -> bool {
    self.observers.is_empty()
  }
}

impl<S, B> Transform<S, ServiceRequest> for AsyncObserverMiddleware
where
  S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
  S::Future: 'static,
  B: 'static,
{
  type Response = ServiceResponse<B>;
  type Error = Error;
  type InitError = ();
  type Transform = AsyncObserverMiddlewareService<S>;
  type Future = Ready<Result<Self::Transform, Self::InitError>>;

  fn new_transform(&self, service: S) -> Self::Future {
    ready(Ok(AsyncObserverMiddlewareService {
      service,
      observers: self.observers.clone(),
    }))
  }
}

pub struct AsyncObserverMiddlewareService<S> {
  service: S,
  observers: Arc<[Arc<dyn AsyncRequestObserver>]>,
}

impl<S, B> Service<ServiceRequest> for AsyncObserverMiddlewareService<S>
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
    let mut pending: Vec<AsyncCompletionObserver> = Vec::new();
    for observer in self.observers.iter() {
      if let Some(completion) = observer.observe(&req) {
        pending.push(completion);
      }
    }
    let fut = self.service.call(req);
    Box::pin(async move {
      let res = fut.await;
      let status = match &res {
        Ok(response) => response.status(),
        Err(error) => error.as_response_error().status_code(),
      };
      for completion in pending {
        completion(status).await;
      }
      res
    })
  }
}

