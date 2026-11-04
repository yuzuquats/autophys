//! The contract a queue implementation satisfies.

use std::pin::Pin;

use async_trait::async_trait;
use futures::Stream;
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::model::{Job, JobState};
use crate::new_job::{CancelReason, NewJob};

pub type BoxStream<T> = Pin<Box<dyn Stream<Item = T> + Send + 'static>>;

/// The answer to an enqueue. `duplicate` says the producer's
/// `(producer, request)` pair had already been seen and this is the job it
/// made the first time — not an error, and not a second job.
///
/// The job is nested rather than flattened: a flattened field does not appear
/// in a generated schema at all, so a consumer's types would have said an
/// enqueue answers nothing but a boolean.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "schema", derive(tento_openapi::ToSchema))]
#[serde(default, rename_all = "camelCase")]
pub struct Enqueued {
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub job: Job,
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub duplicate: bool,
}

/// Which jobs to list. An empty filter is every job in the backend's default
/// queue, newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListFilter {
  pub queue: Option<String>,
  pub producer: Option<String>,
  pub states: Vec<JobState>,
  pub limit: Option<u32>,
}

impl ListFilter {
  pub fn queue(mut self, queue: impl Into<String>) -> Self {
    self.queue = Some(queue.into());
    self
  }

  pub fn producer(mut self, producer: impl Into<String>) -> Self {
    self.producer = Some(producer.into());
    self
  }

  pub fn state(mut self, state: JobState) -> Self {
    self.states.push(state);
    self
  }

  pub fn limit(mut self, limit: u32) -> Self {
    self.limit = Some(limit);
    self
  }

  /// Whether a job belongs in this listing. The backends apply what their
  /// transport can and use this for the rest, so both filter alike.
  pub fn matches(&self, job: &Job) -> bool {
    if let Some(queue) = &self.queue
      && &job.queue != queue
    {
      return false;
    }
    if let Some(producer) = &self.producer
      && job.producer_id.as_deref() != Some(producer.as_str())
    {
      return false;
    }
    if !self.states.is_empty() && !self.states.contains(&job.state) {
      return false;
    }
    true
  }
}

/// One job moved. A consumer holding a list re-reads it; the point of the
/// signal is that it does not have to poll to find out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
  pub queue: String,
  pub job_id: String,
  pub state: JobState,
  pub updated_at: u64,
}

/// A queue. Implementations: [`crate::TshBackend`] (tsh runs the jobs, one
/// saved session per attempt) and [`crate::FixtureBackend`] (a closure runs
/// them in this process).
///
/// Every method addresses a job by `(queue, id)` because one host runs
/// several queues and a job id is only unique inside one.
#[async_trait]
pub trait Backend: Send + Sync + 'static {
  /// The backend's name, for a status line: `tsh` or `fixture`.
  fn name(&self) -> &'static str;

  async fn enqueue(&self, job: NewJob) -> Result<Enqueued>;

  async fn show(&self, queue: &str, id: &str) -> Result<Job>;

  /// Matching jobs, newest first.
  async fn list(&self, filter: ListFilter) -> Result<Vec<Job>>;

  async fn cancel(&self, queue: &str, id: &str, reason: CancelReason) -> Result<Job>;

  /// Re-queue a terminal job. A job that is still running is refused.
  async fn retry(&self, queue: &str, id: &str) -> Result<Job>;

  /// Every job movement the backend learns about, for as long as the stream
  /// is held. It never ends: a transport failure is recovered from, not
  /// reported as the end of the queue.
  fn changes(&self) -> BoxStream<Change>;
}
