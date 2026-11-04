//! The handle a product holds.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde_json::Value;

use crate::backend::{Backend, BoxStream, Change, Enqueued, ListFilter};
use crate::env::QueueEnv;
use crate::error::{QueueError, Result};
use crate::fixture::FixtureBackend;
use crate::model::Job;
use crate::new_job::{CancelReason, NewJob};
use crate::tsh::TshBackend;

/// A queue, a default queue name, and who this product is. Cloning is cheap;
/// a web handler and a background task hold their own.
#[derive(Clone)]
pub struct AgentQueue {
  backend: Arc<dyn Backend>,
  queue: String,
  producer: String,
}

impl AgentQueue {
  pub fn new(
    backend: Arc<dyn Backend>,
    queue: impl Into<String>,
    producer: impl Into<String>,
  ) -> Self {
    Self {
      backend,
      queue: queue.into(),
      producer: producer.into(),
    }
  }

  /// The queue tsh runs, reached through `tsh serve`.
  pub fn from_env(env: &QueueEnv, producer: impl Into<String>) -> Result<Self> {
    let queue = env.queue_name();
    let backend = TshBackend::new(env.socket_path()?);
    Ok(Self::new(Arc::new(backend), queue, producer))
  }

  /// A queue that runs jobs in this process, for a dev mode or a test. The
  /// closure produces the result value a job would have returned.
  pub fn fixture<F>(run: F, producer: impl Into<String>) -> Self
  where
    F: Fn(&NewJob) -> anyhow::Result<Value> + Send + Sync + 'static,
  {
    let backend = FixtureBackend::new(run);
    Self::new(Arc::new(backend), "default", producer)
  }

  /// Which implementation is behind this handle (`tsh`, `fixture`) — a status
  /// line should say, because the two behave differently on purpose.
  pub fn backend_name(&self) -> &'static str {
    self.backend.name()
  }

  pub fn queue_name(&self) -> &str {
    &self.queue
  }

  /// The backend itself, for a caller that must build a second handle over
  /// the same queue (another queue name, another producer).
  pub fn backend_handle(&self) -> Arc<dyn Backend> {
    self.backend.clone()
  }

  pub fn producer(&self) -> &str {
    &self.producer
  }

  /// Enqueue, filling in this handle's queue and producer where the job did
  /// not name its own.
  pub async fn enqueue(&self, job: NewJob) -> Result<Enqueued> {
    let job = match job.queue {
      Some(_) => job,
      None => job.queue(self.queue.clone()),
    };
    let job = match job.producer_id {
      Some(_) => job,
      None => job.producer(self.producer.clone()),
    };
    self.backend.enqueue(job).await
  }

  pub async fn show(&self, id: &str) -> Result<Job> {
    self.backend.show(&self.queue, id).await
  }

  pub async fn list(&self, filter: ListFilter) -> Result<Vec<Job>> {
    self.backend.list(filter).await
  }

  /// This producer's jobs, newest first.
  pub async fn history(&self) -> Result<Vec<Job>> {
    self.history_for(&self.producer).await
  }

  pub async fn history_for(&self, producer: &str) -> Result<Vec<Job>> {
    let mut jobs = self
      .backend
      .list(
        ListFilter::default()
          .queue(self.queue.clone())
          .producer(producer)
          .limit(200),
      )
      .await?;
    // Newest first by when the run was ASKED for, which is the order a
    // history reads in; the backends sort by last movement.
    jobs.sort_by_key(|job| std::cmp::Reverse(job.created_at));
    Ok(jobs)
  }

  pub async fn latest(&self) -> Result<Option<Job>> {
    Ok(self.history().await?.into_iter().next())
  }

  pub async fn cancel(&self, id: &str) -> Result<Job> {
    self
      .backend
      .cancel(&self.queue, id, CancelReason::Operator)
      .await
  }

  pub async fn retry(&self, id: &str) -> Result<Job> {
    self.backend.retry(&self.queue, id).await
  }

  /// Movements of jobs in this handle's queue.
  pub fn changes(&self) -> BoxStream<Change> {
    let queue = self.queue.clone();
    Box::pin(
      self
        .backend
        .changes()
        .filter(move |change| futures::future::ready(change.queue == queue)),
    )
  }

  /// Wait for a job to finish. Reads it once, then waits on the change
  /// stream rather than polling — and reads once more at the end, because the
  /// stream carries a state, not the job.
  pub async fn wait(&self, id: &str, timeout: Duration) -> Result<Job> {
    let job = self.show(id).await?;
    if job.state.is_terminal() {
      return Ok(job);
    }
    let mut changes = self.changes();
    let settled = tokio::time::timeout(timeout, async {
      while let Some(change) = changes.next().await {
        if change.job_id == id && change.state.is_terminal() {
          return true;
        }
      }
      false
    })
    .await
    .map_err(|_| QueueError::Timeout(timeout))?;
    if !settled {
      return Err(QueueError::Unavailable(format!(
        "the change stream ended while waiting for job {id}"
      )));
    }
    self.show(id).await
  }
}
