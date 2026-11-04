use actix_http::Payload;
use actix_service::{Service, Transform};
use actix_web::body::BoxBody;
use actix_web::dev::{ServiceRequest, ServiceResponse};
use actix_web::{Error, FromRequest, HttpMessage, HttpRequest, ResponseError};
use std::fmt::Write;
use std::future::{Future, Ready, ready};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Instant;

struct TimingMark {
  name: String,
  duration_ms: f64,
}

#[derive(Clone)]
pub struct ServerTimings {
  start: Instant,
  marks: Arc<Mutex<Vec<TimingMark>>>,
}

impl ServerTimings {
  fn new() -> Self {
    ServerTimings {
      start: Instant::now(),
      marks: Arc::new(Mutex::new(Vec::new())),
    }
  }

  /// Record a named timing mark (e.g., "db", "garmin_api").
  pub fn mark(&self, name: &str, duration_ms: f64) {
    let Ok(mut marks) = self.marks.lock() else {
      return;
    };
    marks.push(TimingMark {
      name: name.to_string(),
      duration_ms,
    });
  }

  /// Convenience: time a block and record it when the guard is dropped.
  pub fn time(&self, name: &str) -> TimingGuard {
    TimingGuard {
      name: name.to_string(),
      start: Instant::now(),
      timings: self.clone(),
    }
  }

  fn header_value(&self) -> String {
    let total_ms = self.start.elapsed().as_secs_f64() * 1000.0;
    let mut value = format!("total;dur={:.2}", total_ms);

    let Ok(marks) = self.marks.lock() else {
      return value;
    };
    for mark in marks.iter() {
      let _ = write!(value, ", {};dur={:.2}", mark.name, mark.duration_ms);
    }
    value
  }
}

/// Drop guard that records elapsed time when dropped.
pub struct TimingGuard {
  name: String,
  start: Instant,
  timings: ServerTimings,
}

impl Drop for TimingGuard {
  fn drop(&mut self) {
    let duration_ms = self.start.elapsed().as_secs_f64() * 1000.0;
    self.timings.mark(&self.name, duration_ms);
  }
}

impl FromRequest for ServerTimings {
  type Error = ServerTimingsExtractionError;
  type Future = Ready<Result<Self, Self::Error>>;

  fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
    ready(
      req
        .extensions()
        .get::<ServerTimings>()
        .cloned()
        .ok_or(ServerTimingsExtractionError { _priv: () }),
    )
  }
}

#[derive(Debug)]
pub struct ServerTimingsExtractionError {
  _priv: (),
}

impl ResponseError for ServerTimingsExtractionError {}

impl std::fmt::Display for ServerTimingsExtractionError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(
      f,
      "Failed to retrieve ServerTimings from request-local storage. \
       Is ServerTimingMiddleware registered?"
    )
  }
}

impl std::error::Error for ServerTimingsExtractionError {}

// --- Middleware ---

#[derive(Clone, Default)]
pub struct ServerTimingMiddleware;

impl<S> Transform<S, ServiceRequest> for ServerTimingMiddleware
where
  S: Service<ServiceRequest, Response = ServiceResponse<BoxBody>, Error = Error>,
  S::Future: 'static,
{
  type Response = ServiceResponse<BoxBody>;
  type Error = Error;
  type InitError = ();
  type Transform = ServerTimingService<S>;
  type Future = Ready<Result<Self::Transform, Self::InitError>>;

  fn new_transform(&self, service: S) -> Self::Future {
    ready(Ok(ServerTimingService { service }))
  }
}

pub struct ServerTimingService<S> {
  service: S,
}

impl<S> Service<ServiceRequest> for ServerTimingService<S>
where
  S: Service<ServiceRequest, Response = ServiceResponse<BoxBody>, Error = Error>,
  S::Future: 'static,
{
  type Response = ServiceResponse<BoxBody>;
  type Error = Error;
  type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>>>>;

  fn poll_ready(&self, cx: &mut Context) -> Poll<Result<(), Self::Error>> {
    self.service.poll_ready(cx)
  }

  fn call(&self, req: ServiceRequest) -> Self::Future {
    let timings = ServerTimings::new();
    req.extensions_mut().insert(timings.clone());

    let fut = self.service.call(req);

    Box::pin(async move {
      let mut res = fut.await?;
      res.headers_mut().insert(
        actix_web::http::header::HeaderName::from_static("server-timing"),
        actix_web::http::header::HeaderValue::from_str(&timings.header_value())
          .unwrap_or_else(|_| actix_web::http::header::HeaderValue::from_static("total;dur=0")),
      );
      Ok(res)
    })
  }
}
