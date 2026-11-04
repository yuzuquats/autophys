//! The job as the queue stores it.
//!
//! Field names follow the daemon's record (`tsh-agent-queue`'s `jobs` and
//! `attempts` rows) and are *read* from its snake_case spelling through
//! aliases while being *written* in camelCase, which is what a browser client
//! generated from these types expects.
//! Every struct is `#[serde(default)]` so a record that grew a column, or a
//! peer that sends a sparse one, still reads — but a field the queue always
//! sends is marked `required` for the schema, because a consumer generating
//! types from it should not have to null-check what is never null. Leniency
//! is for reading; the contract is for publishing.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where a job is. The literals are the daemon's own, so a job record and the
/// task stream that reports the same job agree on the word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(tento_openapi::ToSchema))]
#[serde(rename_all = "snake_case")]
pub enum JobState {
  /// Imported unfinished work awaiting an explicit execution mapping.
  Held,
  #[default]
  Queued,
  Running,
  /// Failed a retryable class and waiting out its backoff.
  RetryWait,
  /// Asked to stop; still running until the session confirms.
  CancelRequested,
  /// The daemon restarted under it and is reattaching.
  Recovering,
  Succeeded,
  Failed,
  Canceled,
}

impl JobState {
  /// Whether the queue is done with this job. Only a terminal job can be
  /// retried, and only a non-terminal one is worth waiting on.
  pub fn is_terminal(self) -> bool {
    matches!(self, Self::Succeeded | Self::Failed | Self::Canceled)
  }

  pub fn as_str(self) -> &'static str {
    match self {
      Self::Held => "held",
      Self::Queued => "queued",
      Self::Running => "running",
      Self::RetryWait => "retry_wait",
      Self::CancelRequested => "cancel_requested",
      Self::Recovering => "recovering",
      Self::Succeeded => "succeeded",
      Self::Failed => "failed",
      Self::Canceled => "canceled",
    }
  }
}

/// How hard to try. `max_attempts` is 1 unless a producer asks for more, and
/// only a failure whose class is named in `retryable_classes` may consume a
/// second attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(tento_openapi::ToSchema))]
#[serde(default, rename_all = "camelCase")]
pub struct JobPolicy {
  #[serde(alias = "max_attempts")]
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub max_attempts: u32,
  #[serde(alias = "timeout_ms")]
  pub timeout_ms: Option<u64>,
  #[serde(alias = "retryable_classes")]
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub retryable_classes: Vec<String>,
}

impl Default for JobPolicy {
  fn default() -> Self {
    Self {
      max_attempts: 1,
      timeout_ms: None,
      retryable_classes: Vec::new(),
    }
  }
}

/// What a finished job produced. `parsed` says the raw output was valid JSON;
/// `validated` says something checked it against `datatype`. Both are the
/// queue's report, not a promise: a result that did not parse is still a
/// result, and a page decides what to show for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "schema", derive(tento_openapi::ToSchema))]
#[serde(default, rename_all = "camelCase")]
pub struct JobResult {
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub datatype: String,
  #[cfg_attr(feature = "schema", schema(value_type = Object))]
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub value: Value,
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub parsed: bool,
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub validated: bool,
  /// Producer attachments retained with imported and native results.
  pub artifacts: Vec<Value>,
}

/// Why a job failed. `class` is what the retry policy matches on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "schema", derive(tento_openapi::ToSchema))]
#[serde(default, rename_all = "camelCase")]
pub struct JobError {
  pub class: Option<String>,
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub message: String,
  pub attempt: Option<u32>,
}

/// One try at a job, and the tsh session that carried it. The session is kept
/// after the attempt ends — that is the point of a session per attempt: a
/// retry never overwrites the transcript of the try that failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "schema", derive(tento_openapi::ToSchema))]
#[serde(default, rename_all = "camelCase")]
pub struct Attempt {
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub n: u32,
  pub state: Option<String>,
  #[serde(alias = "session_id")]
  pub session_id: Option<String>,
  #[serde(alias = "session_root")]
  pub session_root: Option<String>,
  #[serde(alias = "lineage_id")]
  pub lineage_id: Option<String>,
  #[serde(alias = "unit_id")]
  pub unit_id: Option<i64>,
  #[serde(alias = "started_at")]
  pub started_at: Option<u64>,
  #[serde(alias = "deadline_at")]
  pub deadline_at: Option<u64>,
  #[serde(alias = "ended_at")]
  pub ended_at: Option<u64>,
  #[serde(alias = "cancel_reason")]
  pub cancel_reason: Option<String>,
  #[cfg_attr(feature = "schema", schema(value_type = Option<Object>))]
  pub outcome: Option<Value>,
}

/// A job, as the queue holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "schema", derive(tento_openapi::ToSchema))]
#[serde(default, rename_all = "camelCase")]
pub struct Job {
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub id: String,
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub queue: String,
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub lane: String,
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub kind: String,
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub title: String,
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub state: JobState,
  /// What the job asked for: `prompt` or `form`, the declared `datatype`, and
  /// the agent spec when one was given.
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub payload: BTreeMap<String, Value>,
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub policy: JobPolicy,
  /// Milliseconds since the epoch — the daemon's clock, not a formatted date.
  #[serde(alias = "created_at")]
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub created_at: u64,
  #[serde(alias = "updated_at")]
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub updated_at: u64,
  #[serde(alias = "attempt_count")]
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub attempt_count: u32,
  pub result: Option<JobResult>,
  pub error: Option<JobError>,
  #[serde(alias = "producer_id")]
  pub producer_id: Option<String>,
  #[serde(alias = "request_id")]
  pub request_id: Option<String>,
  /// Present on `show`; a listing leaves it empty.
  #[cfg_attr(feature = "schema", schema(required = true))]
  pub attempts: Vec<Attempt>,
  pub revision: u64,
  /// Durable event history supplied by show.
  pub events: Vec<Value>,
}

impl Job {
  /// The date a news-style job was asked for, or whatever string the producer
  /// put at `payload.<key>`.
  pub fn payload_str(&self, key: &str) -> Option<&str> {
    self.payload.get(key).and_then(Value::as_str)
  }

  /// The result's value when the job succeeded with the datatype asked for.
  /// A job that ended any other way, or produced a different contract, has
  /// nothing a typed consumer should hydrate.
  pub fn result_of(&self, datatype: &str) -> Option<&Value> {
    let result = self.result.as_ref()?;
    (self.state == JobState::Succeeded && result.datatype == datatype).then_some(&result.value)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The daemon's own record, as `plugin.call {method: "show"}` answers it —
  /// snake_case, and missing most fields, which is exactly why the model
  /// defaults everything.
  const JOB_SHOW: &str = r#"{
    "id": "job-7", "queue": "default", "state": "running",
    "policy": {"max_attempts": 3, "timeout_ms": 480000,
               "retryable_classes": ["timeout"]},
    "attempts": [{"n": 1, "state": "failed", "session_id": "92501",
                  "outcome": {"class": "timeout", "message": "lane stalled"}},
                 {"n": 2, "state": "running", "session_id": "92501"}],
    "result": {"datatype": "demo/v1", "validated": true, "parsed": true,
               "value": {"overview": "sixteen titles staged"}}
  }"#;

  #[test]
  fn the_daemons_record_reads_whole() {
    let job: Job = serde_json::from_str(JOB_SHOW).unwrap();
    assert_eq!(job.id, "job-7");
    assert_eq!(job.state, JobState::Running);
    assert_eq!(job.policy.max_attempts, 3);
    assert_eq!(job.policy.timeout_ms, Some(480_000));
    assert_eq!(job.policy.retryable_classes, ["timeout"]);
    assert_eq!(job.attempts.len(), 2);
    assert_eq!(job.attempts[0].session_id.as_deref(), Some("92501"));
    assert_eq!(
      job.attempts[0].outcome.as_ref().unwrap()["class"],
      "timeout"
    );
    // Absent in the record, and absent is not an error.
    assert_eq!(job.title, "");
    assert_eq!(job.attempt_count, 0);
    assert!(job.error.is_none());
  }

  #[test]
  fn a_product_reads_camel_case() {
    let job: Job = serde_json::from_str(JOB_SHOW).unwrap();
    let json = serde_json::to_string(&job).unwrap();
    assert!(json.contains("\"maxAttempts\":3"), "{json}");
    assert!(json.contains("\"attemptCount\":0"), "{json}");
    assert!(json.contains("\"createdAt\":0"), "{json}");
    assert!(json.contains("\"sessionId\":\"92501\""), "{json}");
    assert!(!json.contains("max_attempts"), "{json}");
    assert!(!json.contains("session_id"), "{json}");
    // The state words stay the daemon's, so the task stream and the record agree.
    assert!(json.contains("\"state\":\"running\""), "{json}");
  }

  #[test]
  fn the_wire_states_round_trip() {
    for (state, word) in [
      (JobState::RetryWait, "retry_wait"),
      (JobState::CancelRequested, "cancel_requested"),
      (JobState::Succeeded, "succeeded"),
    ] {
      assert_eq!(
        serde_json::to_string(&state).unwrap(),
        format!("\"{word}\"")
      );
      assert_eq!(
        serde_json::from_str::<JobState>(&format!("\"{word}\"")).unwrap(),
        state
      );
      assert_eq!(state.as_str(), word);
    }
    assert!(JobState::Canceled.is_terminal());
    assert!(!JobState::Recovering.is_terminal());
  }

  #[test]
  fn a_result_belongs_to_the_contract_it_declares() {
    let mut job: Job = serde_json::from_str(JOB_SHOW).unwrap();
    // Running, so nothing to hydrate yet.
    assert!(job.result_of("demo/v1").is_none());
    job.state = JobState::Succeeded;
    assert!(job.result_of("demo/v1").is_some());
    assert!(job.result_of("other/v1").is_none());
  }
}
