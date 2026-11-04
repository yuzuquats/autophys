//! What a product hands the queue.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::model::JobPolicy;

/// What the attempt's session does with the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
  /// Submit a Lisp form to the session's control pane. The result is that
  /// unit's own result record.
  Ctl,
  /// Declare an agent lane, then deliver a prompt to it.
  Agent,
}

impl JobKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Ctl => "ctl",
      Self::Agent => "agent",
    }
  }
}

/// Which agent an `Agent` job runs, and what it may see.
///
/// `env` is the declared door for a pointer the agent needs and cannot
/// inherit: an agent is spawned hermetically, so a credential-store
/// *location* must ride the lane declaration or the agent falls back to a
/// store nothing refreshes. It carries pointers, never credential material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AgentSpec {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub handler: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub agent: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub cmd: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub permissions: Option<String>,
  /// The agent's workspace: the lane's working directory, where its session
  /// opens and what a workspace-scoped permission policy scopes to. Absolute;
  /// the queue refuses anything else at enqueue.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub cwd: Option<String>,
  #[serde(skip_serializing_if = "BTreeMap::is_empty")]
  pub env: BTreeMap<String, String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub script: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub sandbox: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub network: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub lane: Option<String>,
}

impl AgentSpec {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn handler(mut self, handler: impl Into<String>) -> Self {
    self.handler = Some(handler.into());
    self
  }

  pub fn agent(mut self, agent: impl Into<String>) -> Self {
    self.agent = Some(agent.into());
    self
  }

  pub fn cmd(mut self, cmd: impl Into<String>) -> Self {
    self.cmd = Some(cmd.into());
    self
  }

  pub fn permissions(mut self, permissions: impl Into<String>) -> Self {
    self.permissions = Some(permissions.into());
    self
  }

  pub fn cwd(mut self, cwd: impl Into<String>) -> Self {
    self.cwd = Some(cwd.into());
    self
  }

  /// Declare one environment entry for the agent. Pass a POINTER (a path, a
  /// socket, an id), never a secret: the declaration is recorded.
  pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
    self.env.insert(key.into(), value.into());
    self
  }

  pub fn script(mut self, script: impl Into<String>) -> Self {
    self.script = Some(script.into());
    self
  }
  pub fn sandbox(mut self, sandbox: bool) -> Self {
    self.sandbox = Some(sandbox);
    self
  }
  pub fn network(mut self, network: impl Into<String>) -> Self {
    self.network = Some(network.into());
    self
  }
  pub fn lane(mut self, lane: impl Into<String>) -> Self {
    self.lane = Some(lane.into());
    self
  }

  pub fn is_empty(&self) -> bool {
    self.handler.is_none()
      && self.agent.is_none()
      && self.cmd.is_none()
      && self.permissions.is_none()
      && self.cwd.is_none()
      && self.env.is_empty()
      && self.script.is_none()
      && self.sandbox.is_none()
      && self.network.is_none()
      && self.lane.is_none()
  }
}

/// Why a job was stopped. An operator cancel suppresses every retry; a
/// timeout consults the retry policy like any other failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
  Operator,
  Timeout,
}

impl CancelReason {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Operator => "operator",
      Self::Timeout => "timeout",
    }
  }
}

/// A job to enqueue. The lane must be one the queue's host declared —
/// a product asks for a lane, it does not create one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewJob {
  pub queue: Option<String>,
  pub lane: String,
  pub kind: JobKind,
  /// The prompt (`Agent`) or the form (`Ctl`).
  pub work: String,
  pub title: Option<String>,
  pub datatype: Option<String>,
  pub policy: JobPolicy,
  pub agent: AgentSpec,
  pub producer_id: Option<String>,
  pub request_id: Option<String>,
  /// The producer's own payload fields, carried opaquely.
  pub extra: BTreeMap<String, Value>,
}

impl NewJob {
  /// An agent job: the lane is declared, then the prompt is delivered to it.
  pub fn agent(lane: impl Into<String>, prompt: impl Into<String>) -> Self {
    Self::new(JobKind::Agent, lane, prompt)
  }

  /// A control job: one Lisp form on the session's control pane.
  pub fn ctl(lane: impl Into<String>, form: impl Into<String>) -> Self {
    Self::new(JobKind::Ctl, lane, form)
  }

  fn new(kind: JobKind, lane: impl Into<String>, work: impl Into<String>) -> Self {
    Self {
      queue: None,
      lane: lane.into(),
      kind,
      work: work.into(),
      title: None,
      datatype: None,
      policy: JobPolicy::default(),
      agent: AgentSpec::default(),
      producer_id: None,
      request_id: None,
      extra: BTreeMap::new(),
    }
  }

  /// Carry one of the producer's own fields in the job's payload. The queue
  /// stores the payload opaquely and hands it back on every read, so this is
  /// where a producer puts what IT needs to interpret the result later — the
  /// date a digest was asked for, the row a job belongs to.
  pub fn with_payload(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
    self.extra.insert(key.into(), value.into());
    self
  }

  /// Which queue, when the handle's default is not the one wanted.
  pub fn queue(mut self, queue: impl Into<String>) -> Self {
    self.queue = Some(queue.into());
    self
  }

  /// What an operator reading a task list should see.
  pub fn title(mut self, title: impl Into<String>) -> Self {
    self.title = Some(title.into());
    self
  }

  /// The contract the result is expected to satisfy; it travels with the
  /// result so a consumer knows what it is hydrating.
  pub fn datatype(mut self, datatype: impl Into<String>) -> Self {
    self.datatype = Some(datatype.into());
    self
  }

  pub fn policy(mut self, policy: JobPolicy) -> Self {
    self.policy = policy;
    self
  }

  pub fn agent_spec(mut self, agent: AgentSpec) -> Self {
    self.agent = agent;
    self
  }

  /// Who is asking. Together with [`Self::request`] this is a dedupe
  /// identity: enqueueing the same pair twice answers the first job.
  pub fn producer(mut self, producer: impl Into<String>) -> Self {
    self.producer_id = Some(producer.into());
    self
  }

  pub fn request(mut self, request: impl Into<String>) -> Self {
    self.request_id = Some(request.into());
    self
  }

  /// The payload the queue stores for this job — what `Job::payload` will
  /// hold, so a product reads back what it asked for.
  pub fn payload(&self) -> BTreeMap<String, Value> {
    let mut payload = self.extra.clone();
    let work_key = match self.kind {
      JobKind::Agent => "prompt",
      JobKind::Ctl => "form",
    };
    payload.insert(work_key.to_string(), Value::String(self.work.clone()));
    if let Some(datatype) = &self.datatype {
      payload.insert("datatype".to_string(), Value::String(datatype.clone()));
    }
    if !self.agent.is_empty() {
      payload.insert(
        "agent".to_string(),
        serde_json::to_value(&self.agent).unwrap_or(Value::Null),
      );
    }
    payload
  }

  /// The daemon's `enqueue` parameters. Snake_case: that is the spelling its
  /// handler reads, and the one place this crate speaks it.
  pub(crate) fn enqueue_params(&self, default_queue: &str, default_producer: &str) -> Value {
    let mut params = json!({
      "queue": self.queue.clone().unwrap_or_else(|| default_queue.to_string()),
      "lane": self.lane,
      "kind": self.kind.as_str(),
      "payload_json": Value::Object(self.payload().into_iter().collect()),
      "max_attempts": self.policy.max_attempts,
      "producer": self.producer_id.clone().unwrap_or_else(|| default_producer.to_string()),
    });
    let object = params.as_object_mut().expect("json! built an object");
    if let Some(title) = &self.title {
      object.insert("title".into(), Value::String(title.clone()));
    }
    if let Some(timeout) = self.policy.timeout_ms {
      object.insert("timeout_ms".into(), json!(timeout));
    }
    if !self.policy.retryable_classes.is_empty() {
      object.insert("retryable".into(), json!(self.policy.retryable_classes));
    }
    if let Some(request) = &self.request_id {
      object.insert("request".into(), Value::String(request.clone()));
    }
    params
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_agent_job_carries_its_prompt_and_its_lane_environment() {
    let job = NewJob::agent("news", "summarize the day")
      .title("Summarize news for 2026-09-18")
      .datatype("news.summary/v1")
      .policy(JobPolicy {
        max_attempts: 2,
        timeout_ms: Some(600_000),
        retryable_classes: vec!["timeout".into()],
      })
      .agent_spec(
        AgentSpec::new()
          .handler("acp")
          .agent("claude")
          .cmd("claude-agent-acp")
          .permissions("plan")
          .env("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/store/who"),
      )
      .producer("news-demo")
      .request("web-01");

    let params = job.enqueue_params("default", "fallback");
    assert_eq!(params["queue"], "default");
    assert_eq!(params["lane"], "news");
    assert_eq!(params["kind"], "agent");
    assert_eq!(params["title"], "Summarize news for 2026-09-18");
    assert_eq!(params["max_attempts"], 2);
    assert_eq!(params["timeout_ms"], 600_000);
    assert_eq!(params["retryable"][0], "timeout");
    assert_eq!(params["producer"], "news-demo");
    assert_eq!(params["request"], "web-01");
    let payload = &params["payload_json"];
    assert_eq!(payload["prompt"], "summarize the day");
    assert_eq!(payload["datatype"], "news.summary/v1");
    // The lane environment rides inside the agent spec, which is where the
    // daemon looks for it when it writes the lane declaration.
    assert_eq!(payload["agent"]["handler"], "acp");
    assert_eq!(
      payload["agent"]["env"]["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
      "/store/who"
    );
  }

  #[test]
  fn a_workspace_alone_rides_the_agent_spec() {
    // The harness stays the queue's declaration; only the directory is the job's.
    let job = NewJob::agent("ux-browser", "p").agent_spec(AgentSpec::new().cwd("/runs/r1/agent"));
    let params = job.enqueue_params("ux-test", "tento-ux-test");
    assert_eq!(
      params["payload_json"]["agent"],
      json!({"cwd": "/runs/r1/agent"})
    );
  }

  #[test]
  fn a_producers_own_fields_ride_the_payload() {
    let job = NewJob::agent("news", "p").with_payload("date", "2026-09-18");
    let params = job.enqueue_params("default", "p");
    assert_eq!(params["payload_json"]["date"], "2026-09-18");
    assert_eq!(params["payload_json"]["prompt"], "p");
  }

  #[test]
  fn a_ctl_job_is_a_form_and_needs_no_agent() {
    let job = NewJob::ctl("normal", "(begin 1)").producer("smoke");
    let params = job.enqueue_params("default", "fallback");
    assert_eq!(params["kind"], "ctl");
    assert_eq!(params["payload_json"]["form"], "(begin 1)");
    assert!(params["payload_json"].get("agent").is_none());
    // No policy asked for: the daemon's own default of one attempt.
    assert_eq!(params["max_attempts"], 1);
    assert!(params.get("timeout_ms").is_none());
    assert!(params.get("retryable").is_none());
    assert!(params.get("request").is_none());
  }

  #[test]
  fn the_handles_defaults_fill_what_the_builder_left_open() {
    let params = NewJob::ctl("normal", "(begin 1)").enqueue_params("batch", "news-demo");
    assert_eq!(params["queue"], "batch");
    assert_eq!(params["producer"], "news-demo");
  }
}
