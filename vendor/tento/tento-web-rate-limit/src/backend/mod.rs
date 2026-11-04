pub mod input_builder;
pub mod memory;

pub use input_builder::{SimpleInputFunctionBuilder, SimpleInputFuture, resolve_real_ip_key};

use std::future::Future;
use std::time::{Duration, Instant};

use crate::HeaderCompatibleOutput;

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Decision {
  Allowed,
  Denied,
}

impl Decision {
  pub fn from_allowed(allowed: bool) -> Self {
    if allowed { Self::Allowed } else { Self::Denied }
  }

  pub fn is_allowed(self) -> bool {
    matches!(self, Self::Allowed)
  }

  pub fn is_denied(self) -> bool {
    matches!(self, Self::Denied)
  }
}

pub trait Backend<I: 'static = SimpleInput>: Clone {
  type Output;
  type RollbackToken;
  type Error;

  fn request(
    &self,
    input: I,
  ) -> impl Future<Output = Result<(Decision, Self::Output, Self::RollbackToken), Self::Error>>;

  fn rollback(&self, token: Self::RollbackToken) -> impl Future<Output = Result<(), Self::Error>>;
}

#[derive(Debug, Clone)]
pub struct SimpleInput {
  pub interval: Duration,
  pub max_requests: u64,
  pub key: String,
}

#[derive(Debug, Clone)]
pub struct SimpleOutput {
  pub limit: u64,
  pub remaining: u64,
  pub reset: Instant,
}

pub trait SimpleBackend: Backend<SimpleInput, Output = SimpleOutput> {
  fn remove_key(&self, key: &str) -> impl Future<Output = Result<(), Self::Error>>;
}

impl HeaderCompatibleOutput for SimpleOutput {
  fn limit(&self) -> u64 {
    self.limit
  }

  fn remaining(&self) -> u64 {
    self.remaining
  }

  fn seconds_until_reset(&self) -> u64 {
    let millis = self
      .reset
      .saturating_duration_since(Instant::now())
      .as_millis() as f64;
    (millis / 1000f64).ceil() as u64
  }
}
