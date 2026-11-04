//! A queue that runs its jobs here, in this process.
//!
//! This is what a dev mode and a test want: the same [`Job`] records and the
//! same state machine as the real queue, with a closure where the agent would
//! be. Nothing is written to disk and nothing outlives the process, which is
//! the point — a test must not reach the host's queue, and a developer
//! running a page should not need an agent to see it work.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::backend::{Backend, BoxStream, Change, Enqueued, ListFilter};
use crate::error::{QueueError, Result};
use crate::model::{Attempt, Job, JobError, JobResult, JobState};
use crate::new_job::{CancelReason, NewJob};

type Runner = Arc<dyn Fn(&NewJob) -> anyhow::Result<Value> + Send + Sync>;

pub struct FixtureBackend {
  jobs: Arc<Mutex<BTreeMap<String, Job>>>,
  run: Runner,
  delay: Duration,
  changes: broadcast::Sender<Change>,
  next_id: AtomicU64,
}

impl FixtureBackend {
  pub fn new<F>(run: F) -> Self
  where
    F: Fn(&NewJob) -> anyhow::Result<Value> + Send + Sync + 'static,
  {
    Self::with_delay(run, Duration::from_millis(50))
  }

  /// How long a job spends running. A dev mode wants long enough to see the
  /// queued and running states on the page; a test wants it short.
  pub fn with_delay<F>(run: F, delay: Duration) -> Self
  where
    F: Fn(&NewJob) -> anyhow::Result<Value> + Send + Sync + 'static,
  {
    Self {
      jobs: Arc::default(),
      run: Arc::new(run),
      delay,
      changes: broadcast::channel(256).0,
      next_id: AtomicU64::new(1),
    }
  }

  fn announce(&self, job: &Job) {
    // A send with no receiver is not a failure: nobody is watching yet.
    let _ = self.changes.send(Change {
      queue: job.queue.clone(),
      job_id: job.id.clone(),
      state: job.state,
      updated_at: job.updated_at,
    });
  }

  fn with_job<T>(&self, id: &str, edit: impl FnOnce(&mut Job) -> T) -> Result<(T, Job)> {
    let mut jobs = self.jobs.lock().expect("fixture jobs poisoned");
    let job = jobs
      .get_mut(id)
      .ok_or_else(|| QueueError::NotFound(id.to_string()))?;
    let outcome = edit(job);
    job.updated_at = now_ms();
    Ok((outcome, job.clone()))
  }
}

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|since| since.as_millis() as u64)
    .unwrap_or(0)
}

#[async_trait]
impl Backend for FixtureBackend {
  fn name(&self) -> &'static str {
    "fixture"
  }

  async fn enqueue(&self, new_job: NewJob) -> Result<Enqueued> {
    let queue = new_job.queue.clone().unwrap_or_else(|| "default".into());
    // The dedupe identity the real queue enforces transactionally.
    if let (Some(producer), Some(request)) = (&new_job.producer_id, &new_job.request_id) {
      let existing = self
        .jobs
        .lock()
        .expect("fixture jobs poisoned")
        .values()
        .find(|job| {
          job.producer_id.as_deref() == Some(producer.as_str())
            && job.request_id.as_deref() == Some(request.as_str())
        })
        .cloned();
      if let Some(job) = existing {
        return Ok(Enqueued {
          job,
          duplicate: true,
        });
      }
    }
    let stamp = now_ms();
    let job = Job {
      id: format!(
        "fixture-{:06}",
        self.next_id.fetch_add(1, Ordering::Relaxed)
      ),
      queue,
      lane: new_job.lane.clone(),
      kind: new_job.kind.as_str().to_string(),
      title: new_job.title.clone().unwrap_or_else(|| {
        let work: String = new_job.work.chars().take(60).collect();
        format!("{} {work}", new_job.kind.as_str())
      }),
      state: JobState::Queued,
      payload: new_job.payload(),
      policy: new_job.policy.clone(),
      created_at: stamp,
      updated_at: stamp,
      attempt_count: 0,
      revision: 1,
      events: Vec::new(),
      result: None,
      error: None,
      producer_id: new_job.producer_id.clone(),
      request_id: new_job.request_id.clone(),
      attempts: Vec::new(),
    };
    self
      .jobs
      .lock()
      .expect("fixture jobs poisoned")
      .insert(job.id.clone(), job.clone());
    self.announce(&job);
    self.drive(job.id.clone(), new_job);
    Ok(Enqueued {
      job,
      duplicate: false,
    })
  }

  async fn show(&self, _queue: &str, id: &str) -> Result<Job> {
    self
      .jobs
      .lock()
      .expect("fixture jobs poisoned")
      .get(id)
      .cloned()
      .ok_or_else(|| QueueError::NotFound(id.to_string()))
  }

  async fn list(&self, filter: ListFilter) -> Result<Vec<Job>> {
    let mut jobs: Vec<Job> = self
      .jobs
      .lock()
      .expect("fixture jobs poisoned")
      .values()
      .filter(|job| filter.matches(job))
      .cloned()
      .collect();
    jobs.sort_by_key(|job| std::cmp::Reverse(job.updated_at));
    if let Some(limit) = filter.limit {
      jobs.truncate(limit as usize);
    }
    Ok(jobs)
  }

  async fn cancel(&self, _queue: &str, id: &str, reason: CancelReason) -> Result<Job> {
    let (moved, job) = self.with_job(id, |job| {
      if job.state.is_terminal() {
        return false;
      }
      // Queued work stops at once; running work is asked to stop and settles
      // when the run returns — the real queue's patience, in miniature.
      job.state = match job.state {
        JobState::Running => JobState::CancelRequested,
        _ => JobState::Canceled,
      };
      job.error = Some(JobError {
        class: Some("canceled".into()),
        message: format!("canceled ({})", reason.as_str()),
        attempt: Some(job.attempt_count),
      });
      true
    })?;
    if !moved {
      return Err(QueueError::Invalid(format!(
        "job {id} has already finished"
      )));
    }
    self.announce(&job);
    Ok(job)
  }

  async fn retry(&self, _queue: &str, id: &str) -> Result<Job> {
    let (retried, job) = self.with_job(id, |job| {
      if !job.state.is_terminal() {
        return false;
      }
      job.state = JobState::Queued;
      job.result = None;
      job.error = None;
      job.policy.max_attempts = job.policy.max_attempts.max(job.attempt_count + 1);
      true
    })?;
    if !retried {
      return Err(QueueError::Invalid(format!("job {id} is still running")));
    }
    self.announce(&job);
    Ok(job)
  }

  fn changes(&self) -> BoxStream<Change> {
    stream_of(self.changes.subscribe())
  }
}

impl FixtureBackend {
  /// Take a job through running to a verdict, off the caller's thread.
  fn drive(&self, id: String, new_job: NewJob) {
    let jobs = self.jobs.clone();
    let changes = self.changes.clone();
    let run = self.run.clone();
    let delay = self.delay;
    tokio::spawn(async move {
      let announce = |job: &Job| {
        let _ = changes.send(Change {
          queue: job.queue.clone(),
          job_id: job.id.clone(),
          state: job.state,
          updated_at: job.updated_at,
        });
      };
      let edit = |apply: &dyn Fn(&mut Job)| -> Option<Job> {
        let mut guard = jobs.lock().expect("fixture jobs poisoned");
        let job = guard.get_mut(&id)?;
        apply(job);
        job.updated_at = now_ms();
        Some(job.clone())
      };

      tokio::time::sleep(delay).await;
      // Canceled before it ever ran.
      let started = edit(&|job: &mut Job| {
        if job.state == JobState::Queued {
          job.state = JobState::Running;
          job.attempt_count = 1;
          job.attempts = vec![Attempt {
            n: 1,
            state: Some("running".into()),
            started_at: Some(now_ms()),
            ..Attempt::default()
          }];
        }
      });
      let Some(job) = started else { return };
      if job.state != JobState::Running {
        return;
      }
      announce(&job);

      let outcome = run(&new_job);
      let datatype = new_job
        .datatype
        .clone()
        .unwrap_or_else(|| "tsh.value/v1".to_string());
      let settled = edit(&|job: &mut Job| {
        // A cancel that arrived while the closure ran wins: the queue was
        // asked to stop, and it stopped.
        if job.state == JobState::CancelRequested {
          job.state = JobState::Canceled;
          if let Some(attempt) = job.attempts.last_mut() {
            attempt.state = Some("canceled".into());
            attempt.ended_at = Some(now_ms());
          }
          return;
        }
        if let Some(attempt) = job.attempts.last_mut() {
          attempt.ended_at = Some(now_ms());
        }
        match &outcome {
          Ok(value) => {
            job.state = JobState::Succeeded;
            job.result = Some(JobResult {
              datatype: datatype.clone(),
              value: value.clone(),
              parsed: true,
              validated: false,
              artifacts: Vec::new(),
            });
            if let Some(attempt) = job.attempts.last_mut() {
              attempt.state = Some("succeeded".into());
            }
          }
          Err(error) => {
            job.state = JobState::Failed;
            job.error = Some(JobError {
              class: Some("internal".into()),
              message: format!("{error:#}"),
              attempt: Some(job.attempt_count),
            });
            if let Some(attempt) = job.attempts.last_mut() {
              attempt.state = Some("failed".into());
            }
          }
        }
      });
      if let Some(job) = settled {
        announce(&job);
      }
    });
  }
}

/// A broadcast receiver as a stream, dropping the gap when a slow consumer
/// falls behind rather than ending the stream.
pub(crate) fn stream_of(receiver: broadcast::Receiver<Change>) -> BoxStream<Change> {
  Box::pin(futures::stream::unfold(
    receiver,
    |mut receiver| async move {
      loop {
        match receiver.recv().await {
          Ok(change) => return Some((change, receiver)),
          Err(broadcast::error::RecvError::Lagged(_)) => continue,
          Err(broadcast::error::RecvError::Closed) => return None,
        }
      }
    },
  ))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::queue::AgentQueue;
  use futures::StreamExt;
  use serde_json::json;

  fn queue() -> AgentQueue {
    AgentQueue::fixture(
      |job: &NewJob| Ok(json!({"echo": job.work})),
      "test-producer",
    )
  }

  #[tokio::test]
  async fn a_job_runs_from_queued_to_succeeded() {
    let queue = queue();
    assert_eq!(queue.backend_name(), "fixture");
    let enqueued = queue
      .enqueue(NewJob::agent("news", "summarize").datatype("demo/v1"))
      .await
      .unwrap();
    assert!(!enqueued.duplicate);
    assert_eq!(enqueued.job.state, JobState::Queued);
    assert_eq!(enqueued.job.producer_id.as_deref(), Some("test-producer"));

    let settled = queue
      .wait(&enqueued.job.id, Duration::from_secs(5))
      .await
      .unwrap();
    assert_eq!(settled.state, JobState::Succeeded);
    assert_eq!(settled.attempt_count, 1);
    assert_eq!(settled.result_of("demo/v1").unwrap()["echo"], "summarize");
    assert_eq!(settled.attempts.len(), 1);
    assert_eq!(settled.attempts[0].state.as_deref(), Some("succeeded"));
  }

  #[tokio::test]
  async fn the_change_stream_reports_every_move() {
    let queue = queue();
    let mut changes = queue.changes();
    let enqueued = queue
      .enqueue(NewJob::ctl("normal", "(begin 1)"))
      .await
      .unwrap();
    let mut seen = Vec::new();
    while let Some(change) = changes.next().await {
      assert_eq!(change.job_id, enqueued.job.id);
      seen.push(change.state);
      if change.state.is_terminal() {
        break;
      }
    }
    assert_eq!(
      seen,
      [JobState::Queued, JobState::Running, JobState::Succeeded]
    );
  }

  #[tokio::test]
  async fn a_failing_run_fails_the_job_and_can_be_retried() {
    let queue = AgentQueue::fixture(
      |_: &NewJob| anyhow::bail!("the lane never answered"),
      "test-producer",
    );
    let id = queue
      .enqueue(NewJob::agent("news", "x"))
      .await
      .unwrap()
      .job
      .id;
    let failed = queue.wait(&id, Duration::from_secs(5)).await.unwrap();
    assert_eq!(failed.state, JobState::Failed);
    let error = failed.error.unwrap();
    assert!(error.message.contains("never answered"), "{error:?}");
    assert_eq!(error.attempt, Some(1));

    let requeued = queue.retry(&id).await.unwrap();
    assert_eq!(requeued.state, JobState::Queued);
    assert!(requeued.error.is_none());
    assert_eq!(requeued.policy.max_attempts, 2);
  }

  #[tokio::test]
  async fn the_same_request_twice_is_one_job() {
    let queue = queue();
    let first = queue
      .enqueue(NewJob::agent("news", "x").request("2026-09-18"))
      .await
      .unwrap();
    let second = queue
      .enqueue(NewJob::agent("news", "x").request("2026-09-18"))
      .await
      .unwrap();
    assert!(!first.duplicate);
    assert!(second.duplicate);
    assert_eq!(first.job.id, second.job.id);
    assert_eq!(queue.history().await.unwrap().len(), 1);
  }

  #[tokio::test]
  async fn a_queued_job_cancels_at_once() {
    // Long enough that the cancel lands while the job is still queued.
    let backend = FixtureBackend::with_delay(|_: &NewJob| Ok(json!({})), Duration::from_secs(30));
    let queue = AgentQueue::new(Arc::new(backend), "default", "test-producer");
    let id = queue
      .enqueue(NewJob::ctl("normal", "(sleep 30)"))
      .await
      .unwrap()
      .job
      .id;
    let canceled = queue.cancel(&id).await.unwrap();
    assert_eq!(canceled.state, JobState::Canceled);
    assert!(
      queue.cancel(&id).await.is_err(),
      "a finished job cannot cancel again"
    );
  }

  #[tokio::test]
  async fn history_is_this_producers_jobs_newest_first() {
    let queue = queue();
    let older = queue
      .enqueue(NewJob::agent("news", "one"))
      .await
      .unwrap()
      .job
      .id;
    tokio::time::sleep(Duration::from_millis(3)).await;
    let newer = queue
      .enqueue(NewJob::agent("news", "two"))
      .await
      .unwrap()
      .job
      .id;
    let history = queue.history().await.unwrap();
    assert_eq!(
      history
        .iter()
        .map(|job| job.id.as_str())
        .collect::<Vec<_>>(),
      [newer.as_str(), older.as_str()]
    );
    // Another product's jobs are not this product's history.
    assert!(queue.history_for("someone-else").await.unwrap().is_empty());
    assert_eq!(queue.latest().await.unwrap().unwrap().id, newer);
  }

  #[tokio::test]
  async fn an_unknown_job_is_not_found() {
    let queue = queue();
    assert!(matches!(
      queue.show("nope").await.unwrap_err(),
      QueueError::NotFound(_)
    ));
  }
}
