use std::future::Future;
use std::rc::Rc;

use actix_web::HttpResponse;
use actix_web::dev::ServiceRequest;
use actix_web::http::StatusCode;
use actix_web::http::header::{HeaderMap, HeaderName, HeaderValue, RETRY_AFTER};

use crate::backend::Backend;

use super::{AllowedTransformation, DeniedResponse, RateLimiter, RollbackCondition};

#[allow(clippy::declare_interior_mutable_const)]
pub const X_RATELIMIT_LIMIT: HeaderName = HeaderName::from_static("x-ratelimit-limit");
#[allow(clippy::declare_interior_mutable_const)]
pub const X_RATELIMIT_REMAINING: HeaderName = HeaderName::from_static("x-ratelimit-remaining");
#[allow(clippy::declare_interior_mutable_const)]
pub const X_RATELIMIT_RESET: HeaderName = HeaderName::from_static("x-ratelimit-reset");

pub struct RateLimiterBuilder<BE, BO, F> {
  backend: BE,
  input_fn: F,
  fail_open: bool,
  allowed_transformation: Option<Rc<AllowedTransformation<BO>>>,
  denied_response: Rc<DeniedResponse<BO>>,
  rollback_condition: Option<Rc<RollbackCondition>>,
}

impl<BE, BI, BO, F, O> RateLimiterBuilder<BE, BO, F>
where
  BE: Backend<BI, Output = BO> + 'static,
  BI: 'static,
  F: Fn(&ServiceRequest) -> O,
  O: Future<Output = Result<BI, actix_web::Error>>,
{
  pub(super) fn new(backend: BE, input_fn: F) -> Self {
    Self {
      backend,
      input_fn,
      fail_open: false,
      allowed_transformation: None,
      denied_response: Rc::new(|_| HttpResponse::TooManyRequests().finish()),
      rollback_condition: None,
    }
  }

  pub fn fail_open(mut self, fail_open: bool) -> Self {
    self.fail_open = fail_open;
    self
  }

  pub fn add_headers(mut self) -> Self
  where
    BO: HeaderCompatibleOutput,
  {
    self.allowed_transformation = Some(Rc::new(|map, output, rolled_back| {
      if let Some(status) = output {
        map.insert(X_RATELIMIT_LIMIT, HeaderValue::from(status.limit()));
        let remaining = if rolled_back {
          status.remaining() + 1
        } else {
          status.remaining()
        };
        map.insert(X_RATELIMIT_REMAINING, HeaderValue::from(remaining));
        map.insert(
          X_RATELIMIT_RESET,
          HeaderValue::from(status.seconds_until_reset()),
        );
      }
    }));

    self.denied_response = Rc::new(|status| {
      let mut response = HttpResponse::TooManyRequests().finish();
      let map = response.headers_mut();
      map.insert(X_RATELIMIT_LIMIT, HeaderValue::from(status.limit()));
      map.insert(X_RATELIMIT_REMAINING, HeaderValue::from(status.remaining()));
      let seconds = status.seconds_until_reset();
      map.insert(X_RATELIMIT_RESET, HeaderValue::from(seconds));
      map.insert(RETRY_AFTER, HeaderValue::from(seconds));
      response
    });

    self
  }

  pub fn request_allowed_transformation<M>(mut self, mutation: Option<M>) -> Self
  where
    M: Fn(&mut HeaderMap, Option<&BO>, bool) + 'static,
  {
    self.allowed_transformation = mutation.map(|m| Rc::new(m) as Rc<AllowedTransformation<BO>>);
    self
  }

  pub fn request_denied_response<R>(mut self, denied_response: R) -> Self
  where
    R: Fn(&BO) -> HttpResponse + 'static,
  {
    self.denied_response = Rc::new(denied_response);
    self
  }

  pub fn rollback_condition<C>(mut self, condition: Option<C>) -> Self
  where
    C: Fn(StatusCode) -> bool + 'static,
  {
    self.rollback_condition = condition.map(|m| Rc::new(m) as Rc<RollbackCondition>);
    self
  }

  pub fn rollback_server_errors(self) -> Self {
    self.rollback_condition(Some(|status: StatusCode| status.is_server_error()))
  }

  pub fn build(self) -> RateLimiter<BE, BO, F> {
    RateLimiter {
      backend: self.backend,
      input_fn: Rc::new(self.input_fn),
      fail_open: self.fail_open,
      allowed_mutation: self.allowed_transformation,
      denied_response: self.denied_response,
      rollback_condition: self.rollback_condition,
    }
  }
}

pub trait HeaderCompatibleOutput {
  fn limit(&self) -> u64;
  fn remaining(&self) -> u64;
  fn seconds_until_reset(&self) -> u64;
}
