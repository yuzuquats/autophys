use actix_http::Payload;
use actix_web::{FromRequest, HttpMessage, HttpRequest, ResponseError};
use std::future::{Ready, ready};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub struct RequestId(Uuid);

impl RequestId {
  pub(crate) fn generate() -> Self {
    Self(Uuid::new_v4())
  }
}

impl std::ops::Deref for RequestId {
  type Target = Uuid;

  fn deref(&self) -> &Self::Target {
    &self.0
  }
}

impl From<RequestId> for Uuid {
  fn from(r: RequestId) -> Self {
    r.0
  }
}

impl std::fmt::Display for RequestId {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}", self.0)
  }
}

impl FromRequest for RequestId {
  type Error = RequestIdExtractionError;
  type Future = Ready<Result<Self, Self::Error>>;

  fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
    ready(
      req
        .extensions()
        .get::<RequestId>()
        .copied()
        .ok_or(RequestIdExtractionError { _priv: () }),
    )
  }
}

#[derive(Debug)]
/// Error returned by the [`RequestId`] extractor when it fails to retrieve
/// the current request id from request-local storage.
///
/// It only happens if you try to extract the current request id without having
/// registered [`TracingLogger`] as a middleware for your application.
///
/// [`TracingLogger`]: crate::TracingLogger
pub struct RequestIdExtractionError {
  // It turns out that a unit struct has a public constructor!
  // Therefore adding fields to it (either public or private) later on
  // is an API breaking change.
  // Therefore we are adding a dummy private field that the compiler is going
  // to optimise away to make sure users cannot construct this error
  // manually in their own code.
  _priv: (),
}

impl ResponseError for RequestIdExtractionError {}

impl std::fmt::Display for RequestIdExtractionError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(
      f,
      "Failed to retrieve request id from request-local storage."
    )
  }
}

impl std::error::Error for RequestIdExtractionError {}
