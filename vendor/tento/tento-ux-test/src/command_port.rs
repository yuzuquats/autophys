//! Explicit command transport for a private admin CLI. No product Rust types,
//! shell templates, retry, fallback, or session-sink inference live here.
//!
//! This first slice admits only read operations with non-sensitive results.
//! Mutations/credentials require the run ownership and redaction integration
//! before they can be mounted on the ordinary spec/result pipeline.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, OnceCell};
use uuid::Uuid;

const LIMIT: usize = 1024 * 1024;
// SSH connect + CLI hello + POST transport each have a five-second budget.
// Keep five further seconds for process startup and scheduling.
const TRANSPORT_MARGIN_MS: u64 = 20_000;

/// Diagnostics never contain subprocess output, argv, params or backend text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
  Configuration,
  Unavailable,
  Busy,
  Preflight,
  InvalidParams,
  UnknownVerb,
  Refused,
  /// A dispatched command did not return a valid, matching success/refusal.
  /// Ending the SSH client is not proof that remote execution stopped.
  OutcomeUnknown,
}

impl std::fmt::Display for Failure {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(match self {
      Self::Configuration => "invalid admin command configuration",
      Self::Unavailable => "admin command could not be started",
      Self::Busy => "admin command port busy",
      Self::Preflight => "admin identity, artifact or operation preflight refused",
      Self::InvalidParams => "admin parameters do not match the declared fields and types",
      Self::UnknownVerb => "undeclared admin verb",
      Self::Refused => "admin operation refused",
      Self::OutcomeUnknown => {
        "admin outcome unknown; do not replay; retain the request ID for recovery"
      }
    })
  }
}
impl std::error::Error for Failure {}

/// Static deployment configuration. No element is interpolated from test data.
#[derive(Clone, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
  Local {
    program: PathBuf,
    args: Vec<String>,
  },
  Ssh {
    host: String,
    program: PathBuf,
    args: Vec<String>,
    /// Optional explicitly provisioned trust store; never populated by scanning
    /// an unauthenticated peer. Absent uses the SSH user's existing trust.
    #[serde(default)]
    known_hosts: Option<PathBuf>,
  },
}

impl Command {
  fn validate(&self) -> Result<(), Failure> {
    let (program, args) = match self {
      Self::Local { program, args } => (program, args),
      Self::Ssh {
        host,
        program,
        args,
        known_hosts,
      } => {
        if known_hosts.as_ref().is_some_and(|path| {
          !path.is_absolute()
            || path.to_str().is_none_or(|s| {
              s.chars()
                .any(|c| c.is_whitespace() || matches!(c, '\0' | '\'' | '"' | '%'))
            })
        }) {
          return Err(Failure::Configuration);
        }
        if host.is_empty()
          || host.starts_with('-')
          || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_@".contains(&b))
        {
          return Err(Failure::Configuration);
        }
        (program, args)
      }
    };
    if !program.is_absolute()
      || program.to_str().is_none_or(|s| s.contains('\0'))
      || args.len() > 64
      || args.iter().any(|arg| arg.contains('\0'))
    {
      return Err(Failure::Configuration);
    }
    Ok(())
  }

  fn process(&self) -> tokio::process::Command {
    match self {
      Self::Local { program, args } => {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args);
        cmd
      }
      Self::Ssh {
        host,
        program,
        args,
        known_hosts,
      } => {
        let mut cmd = tokio::process::Command::new("/usr/bin/ssh");
        // SSH re-parses the remote command through a shell. Quote each fixed
        // word; request parameters travel only on the pipe, never in this text.
        let remote = std::iter::once(program.to_str().expect("validated path"))
          .chain(args.iter().map(String::as_str))
          .map(quote)
          .collect::<Vec<_>>()
          .join(" ");
        if let Some(path) = known_hosts {
          cmd.arg(format!("-oUserKnownHostsFile={}", path.display()));
        }
        cmd.args([
          "-T",
          "-oBatchMode=yes",
          "-oStrictHostKeyChecking=yes",
          "-oConnectTimeout=5",
          "--",
          host,
          &format!("exec {remote}"),
        ]);
        cmd
      }
    }
  }

  async fn exchange(
    &self,
    input: &[u8],
    timeout_ms: u64,
  ) -> Result<(std::process::ExitStatus, Vec<u8>), Failure> {
    if input.len() > LIMIT {
      return Err(Failure::InvalidParams);
    }
    let mut child = self
      .process()
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .kill_on_drop(true)
      .spawn()
      .map_err(|_| Failure::Unavailable)?;
    let mut stdin = child.stdin.take().ok_or(Failure::OutcomeUnknown)?;
    let stdout = child.stdout.take().ok_or(Failure::OutcomeUnknown)?;
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms), async {
      let write = async {
        stdin
          .write_all(input)
          .await
          .map_err(|_| Failure::OutcomeUnknown)?;
        drop(stdin);
        Ok::<_, Failure>(())
      };
      let read = async {
        let mut bytes = Vec::new();
        stdout
          .take((LIMIT + 1) as u64)
          .read_to_end(&mut bytes)
          .await
          .map_err(|_| Failure::OutcomeUnknown)?;
        if bytes.len() > LIMIT {
          return Err(Failure::OutcomeUnknown);
        }
        Ok(bytes)
      };
      let (_, bytes) = tokio::try_join!(write, read)?;
      let status = child.wait().await.map_err(|_| Failure::OutcomeUnknown)?;
      Ok((status, bytes))
    })
    .await
    .unwrap_or(Err(Failure::OutcomeUnknown));
    if result.is_err() {
      // Reap our exact child. Remote work may still exist and remains unknown.
      let _ = child.kill().await;
      let _ = child.wait().await;
    }
    result
  }
}

fn quote(word: &str) -> String {
  format!("'{}'", word.replace('\'', "'\\''"))
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JsonType {
  Null,
  Boolean,
  Number,
  String,
  Array,
  Object,
}

impl JsonType {
  fn matches(self, value: &Value) -> bool {
    match self {
      Self::Null => value.is_null(),
      Self::Boolean => value.is_boolean(),
      Self::Number => value.is_number(),
      Self::String => value.is_string(),
      Self::Array => value.is_array(),
      Self::Object => value.is_object(),
    }
  }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
  pub operation: String,
  pub version: u32,
  /// Must be `read` in this implementation slice.
  pub effect: String,
  /// Must be false until protected result storage is implemented.
  pub sensitive: bool,
  /// Exact required input field set. Values retain their JSON types on stdin.
  pub params: BTreeMap<String, JsonType>,
  pub result: JsonType,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
  pub schema: String,
  pub wire_schema: String,
  pub product: String,
  pub artifact: String,
  /// Deployment intent excluding boot_id. Hello must match exactly these
  /// fields plus one non-nil UUID boot_id, which is then pinned for this port.
  pub expected: BTreeMap<String, String>,
  pub hello: Command,
  pub call: Command,
  pub timeout_ms: u64,
  pub bindings: BTreeMap<String, Binding>,
}

impl Config {
  pub fn load(path: &Path) -> Result<Self, Failure> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
      .map_err(|_| Failure::Configuration)?
      .take((LIMIT + 1) as u64)
      .read_to_end(&mut bytes)
      .map_err(|_| Failure::Configuration)?;
    if bytes.len() > LIMIT {
      return Err(Failure::Configuration);
    }
    let config: Self = serde_json::from_slice(&bytes).map_err(|_| Failure::Configuration)?;
    config.validate()?;
    Ok(config)
  }

  fn validate(&self) -> Result<(), Failure> {
    if self.schema != "ux.admin-command/v1"
      || self.expected.is_empty()
      || self.expected.contains_key("boot_id")
      || self.bindings.is_empty()
      || self.bindings.len() > 256
      || !(1..=300_000).contains(&self.timeout_ms)
      || [&self.wire_schema, &self.product, &self.artifact]
        .iter()
        .any(|s| !label(s))
      || self.expected.iter().any(|(k, v)| !label(k) || !label(v))
    {
      return Err(Failure::Configuration);
    }
    self.hello.validate()?;
    self.call.validate()?;
    for (verb, binding) in &self.bindings {
      if !label(verb)
        || !label(&binding.operation)
        || binding.version == 0
        || binding.effect != "read"
        || binding.sensitive
        || binding.params.keys().any(|s| !label(s))
      {
        return Err(Failure::Configuration);
      }
    }
    Ok(())
  }
}

fn label(s: &str) -> bool {
  !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control)
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
  schema: String,
  product: String,
  identity: BTreeMap<String, String>,
  artifact: String,
  ready: bool,
  operations: Vec<Operation>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
  name: String,
  version: u32,
  effect: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
  schema: String,
  request_id: Uuid,
  identity: BTreeMap<String, String>,
  ok: bool,
  #[serde(default, deserialize_with = "present_value")]
  result: Option<Value>,
  #[serde(default, deserialize_with = "present_error")]
  error: Option<OperationError>,
}

fn present_value<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
  Value::deserialize(d).map(Some)
}
fn present_error<'de, D: serde::Deserializer<'de>>(
  d: D,
) -> Result<Option<OperationError>, D::Error> {
  OperationError::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationError {
  code: String,
  message: String,
  #[serde(rename = "retryable")]
  _retryable: bool,
  execution: String,
}

/// A port pins one boot. It serializes calls without an unbounded queue. Failed
/// preflight is sticky; unknown outcomes poison the port. Recovery in this
/// read-only slice means constructing a new explicitly configured port.
pub struct Client {
  config: Config,
  hello: OnceCell<Result<Hello, Failure>>,
  state: Mutex<bool>,
}

impl Client {
  pub fn new(config: Config) -> Result<Self, Failure> {
    config.validate()?;
    Ok(Self {
      config,
      hello: OnceCell::new(),
      state: Mutex::new(false),
    })
  }

  pub fn verbs(&self) -> Vec<String> {
    self.config.bindings.keys().cloned().collect()
  }

  async fn hello(&self) -> Result<&Hello, Failure> {
    self
      .hello
      .get_or_init(|| async {
        let (status, bytes) = self
          .config
          .hello
          .exchange(&[], self.config.timeout_ms + TRANSPORT_MARGIN_MS)
          .await
          .map_err(|_| Failure::Preflight)?;
        let hello: Hello = serde_json::from_slice(&bytes).map_err(|_| Failure::Preflight)?;
        let boot = hello
          .identity
          .get("boot_id")
          .and_then(|v| Uuid::parse_str(v).ok());
        if !status.success()
          || hello.schema != self.config.wire_schema
          || hello.product != self.config.product
          || hello.artifact != self.config.artifact
          || !hello.ready
          || boot.is_none_or(|v| v.is_nil())
          || hello.identity.len() != self.config.expected.len() + 1
          || self
            .config
            .expected
            .iter()
            .any(|(key, value)| hello.identity.get(key) != Some(value))
          || hello.operations.len() > 256
        {
          return Err(Failure::Preflight);
        }
        let mut seen = std::collections::BTreeSet::new();
        if hello.operations.iter().any(|op| {
          !label(&op.name)
            || op.version == 0
            || !matches!(op.effect.as_str(), "read" | "mutation")
            || !seen.insert((&op.name, op.version))
        }) {
          return Err(Failure::Preflight);
        }
        for b in self.config.bindings.values() {
          if !hello
            .operations
            .iter()
            .any(|op| op.name == b.operation && op.version == b.version && op.effect == "read")
          {
            return Err(Failure::Preflight);
          }
        }
        Ok(hello)
      })
      .await
      .as_ref()
      .map_err(|e| *e)
  }

  /// Explicit online preflight; construction and vocabulary inspection are offline.
  pub async fn preflight(&self) -> Result<(), Failure> {
    self.hello().await.map(|_| ())
  }

  /// Correlation is retained even if the caller loses the response. This API
  /// returns no raw diagnostic from the executable, including on invalid JSON.
  pub async fn execute(&self, action: &str, params: Value) -> Result<Value, CallFailure> {
    let request_id = Uuid::new_v4();
    self
      .execute_inner(action, params, request_id)
      .await
      .map_err(|failure| CallFailure {
        request_id,
        failure,
      })
  }

  async fn execute_inner(
    &self,
    action: &str,
    params: Value,
    request_id: Uuid,
  ) -> Result<Value, Failure> {
    let binding = self
      .config
      .bindings
      .get(action)
      .ok_or(Failure::UnknownVerb)?;
    let fields = params.as_object().ok_or(Failure::InvalidParams)?;
    if fields.len() != binding.params.len()
      || binding
        .params
        .iter()
        .any(|(name, kind)| fields.get(name).is_none_or(|v| !kind.matches(v)))
    {
      return Err(Failure::InvalidParams);
    }
    let mut poisoned = self.state.try_lock().map_err(|_| Failure::Busy)?;
    if *poisoned {
      return Err(Failure::OutcomeUnknown);
    }
    let hello = self.hello().await?;
    let request = serde_json::to_vec(&json!({
      "schema": self.config.wire_schema, "request_id": request_id,
      "expected": hello.identity, "operation": binding.operation,
      "operation_version": binding.version, "params": params, "timeout_ms": self.config.timeout_ms,
    }))
    .map_err(|_| Failure::InvalidParams)?;
    if request.len() > LIMIT {
      return Err(Failure::InvalidParams);
    }
    // Set before await: cancelling the caller cannot permit reuse of this port.
    *poisoned = true;
    let (status, bytes) = match self
      .config
      .call
      .exchange(&request, self.config.timeout_ms + TRANSPORT_MARGIN_MS)
      .await
    {
      Ok(output) => output,
      Err(Failure::Unavailable) => {
        *poisoned = false;
        return Err(Failure::Unavailable);
      }
      Err(error) => return Err(error),
    };
    let reply: Reply = serde_json::from_slice(&bytes).map_err(|_| Failure::OutcomeUnknown)?;
    if reply.schema != self.config.wire_schema
      || reply.request_id != request_id
      || reply.identity.len() != hello.identity.len()
      || reply
        .identity
        .iter()
        .any(|(key, value)| !hello.identity.contains_key(key) || !label(value))
      || reply
        .identity
        .get("boot_id")
        .and_then(|s| Uuid::parse_str(s).ok())
        .is_none_or(|v| v.is_nil())
    {
      return Err(Failure::OutcomeUnknown);
    }
    let identity_matches = reply.identity == hello.identity;
    match (reply.ok, reply.result, reply.error) {
      (true, Some(result), None)
        if status.success() && identity_matches && binding.result.matches(&result) =>
      {
        *poisoned = false;
        return Ok(result);
      }
      // Only a valid structured refusal can prove non-execution. A nonzero
      // exit alone (SSH failure, corrupt output) proves nothing.
      (false, None, Some(error)) if !status.success() => {
        let exit = match error.code.as_str() {
          "invalid_request" | "unknown_operation" | "unsupported_version" => Some(2),
          "denied" => Some(3),
          "identity_mismatch" | "not_ready" => Some(4),
          "busy" => Some(5),
          "deadline" | "internal" => Some(1),
          _ => None,
        };
        if error.execution == "not_started"
          && error.message.len() <= 1024
          && exit.is_some()
          && status.code() == exit
          && (identity_matches || error.code == "identity_mismatch")
        {
          // Identity failure requires a new explicitly selected port, never repin.
          *poisoned = !identity_matches;
          return Err(Failure::Refused);
        }
      }
      _ => {}
    }
    Err(Failure::OutcomeUnknown)
  }
}

#[derive(Debug)]
pub struct CallFailure {
  pub request_id: Uuid,
  pub failure: Failure,
}
impl std::fmt::Display for CallFailure {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{} (request {})", self.failure, self.request_id)
  }
}
impl std::error::Error for CallFailure {}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ssh_quotes_every_static_word_and_never_disables_host_verification() {
    let command = Command::Ssh {
      host: "fixture-host".into(),
      program: "/srv/app's bin/admin".into(),
      args: vec!["live".into(), "a; $(false)".into()],
      known_hosts: Some("/srv/trust/known_hosts".into()),
    };
    command.validate().unwrap();
    let process = command.process();
    let args: Vec<_> = process
      .as_std()
      .get_args()
      .map(|s| s.to_str().unwrap())
      .collect();
    assert!(args.contains(&"-T"));
    assert!(args.contains(&"-oBatchMode=yes"));
    assert!(args.contains(&"-oStrictHostKeyChecking=yes"));
    assert_eq!(
      args.last(),
      Some(&"exec '/srv/app'\\''s bin/admin' 'live' 'a; $(false)'")
    );
  }

  #[test]
  fn ssh_target_cannot_be_an_option_or_shell_fragment() {
    for host in ["-oProxyCommand=bad", "host; false", "", "a\nb"] {
      assert!(
        Command::Ssh {
          host: host.into(),
          program: "/usr/bin/admin".into(),
          args: vec![],
          known_hosts: None
        }
        .validate()
        .is_err()
      );
    }
    assert!(
      Command::Ssh {
        host: "fixture-host".into(),
        program: "/usr/bin/admin".into(),
        args: vec![],
        known_hosts: Some("/srv/trust/%h".into()),
      }
      .validate()
      .is_err()
    );
  }
}
