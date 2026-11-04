//! The `daemon` transport wire — JSON-RPC over a byte stream, for invoking a
//! remote `Scripts` surface.
//!
//! The shell's universal dispatch is `Callable::call_with_argv(argv) -> Value`.
//! A command needs both `argv` (the request — **serializable**) and an `Info`
//! (its deps / warm state — **non-serializable**, e.g. a daemon's warm process
//! pool). The wire is spliced exactly between them: the client ships `argv`, the
//! server reconstructs it ([`build_argv`]) and dispatches where its `Info` lives.
//! So a daemon group is just a remote `Scripts` surface that this wire makes look
//! like a local [`Callable`](crate::shell::Callable).
//!
//! Format: a 4-byte big-endian length prefix + a JSON-RPC 2.0 payload, one frame
//! per message. `tento-kol`'s daemon is the first server (it re-exports these
//! types); [`crate::remote_group::RemoteGroup`]'s daemon branch is the first
//! Rust client. The same envelope is what the kol-triad deno clients already
//! speak — the protocol is a wire contract, not a shared Rust type.

use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(unix)]
use tokio::net::UnixStream;

// ── Standard JSON-RPC 2.0 error codes ──────────────────────────────
pub const CODE_PARSE_ERROR: i32 = -32700;
pub const CODE_INVALID_REQUEST: i32 = -32600;
pub const CODE_METHOD_NOT_FOUND: i32 = -32601;
pub const CODE_INVALID_PARAMS: i32 = -32602;
pub const CODE_INTERNAL_ERROR: i32 = -32603;

// ── Message types ──────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcRequest {
  pub jsonrpc: String,
  pub method: String,
  #[serde(default, skip_serializing_if = "Value::is_null")]
  pub params: Value,
  #[serde(default = "default_id")]
  pub id: Value,
}

fn default_id() -> Value {
  Value::Null
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcResponse {
  pub jsonrpc: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub result: Option<Value>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub error: Option<JsonRpcError>,
  pub id: Value,
}

impl JsonRpcResponse {
  pub fn ok(id: Value, result: Value) -> Self {
    Self {
      jsonrpc: "2.0".into(),
      result: Some(result),
      error: None,
      id,
    }
  }
  pub fn err(id: Value, error: JsonRpcError) -> Self {
    Self {
      jsonrpc: "2.0".into(),
      result: None,
      error: Some(error),
      id,
    }
  }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcError {
  pub code: i32,
  pub message: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub data: Option<Value>,
}

impl JsonRpcError {
  pub fn new(code: i32, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
      data: None,
    }
  }
  pub fn with_data(mut self, data: Value) -> Self {
    self.data = Some(data);
    self
  }
  pub fn parse_error(detail: impl Into<String>) -> Self {
    Self::new(CODE_PARSE_ERROR, detail.into())
  }
  pub fn method_not_found(method: &str) -> Self {
    Self::new(CODE_METHOD_NOT_FOUND, format!("method not found: {method}"))
  }
  pub fn invalid_params(detail: impl Into<String>) -> Self {
    Self::new(CODE_INVALID_PARAMS, detail.into())
  }
  pub fn internal_error(detail: impl Into<String>) -> Self {
    Self::new(CODE_INTERNAL_ERROR, detail.into())
  }
}

// ── Frame helpers ──────────────────────────────────────────────────

/// Bound allocations before trusting a peer-supplied length prefix.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Write a length-prefixed payload (4-byte BE length + bytes).
pub async fn write_frame<S: AsyncWrite + Unpin>(
  stream: &mut S,
  payload: &[u8],
) -> std::io::Result<()> {
  if payload.len() > MAX_FRAME_BYTES {
    return Err(std::io::Error::new(
      std::io::ErrorKind::InvalidInput,
      "daemon frame too large",
    ));
  }
  let len = payload.len() as u32;
  stream.write_all(&len.to_be_bytes()).await?;
  stream.write_all(payload).await?;
  Ok(())
}

/// Read a length-prefixed payload written by [`write_frame`].
pub async fn read_frame<S: AsyncRead + Unpin>(stream: &mut S) -> std::io::Result<Vec<u8>> {
  let mut len_buf = [0u8; 4];
  stream.read_exact(&mut len_buf).await?;
  let len = u32::from_be_bytes(len_buf) as usize;
  if len > MAX_FRAME_BYTES {
    return Err(std::io::Error::new(
      std::io::ErrorKind::InvalidData,
      "daemon frame too large",
    ));
  }
  let mut payload = vec![0u8; len];
  stream.read_exact(&mut payload).await?;
  Ok(payload)
}

// ── Wire → argv (server side) ──────────────────────────────────────

/// Reconstruct a tento-sh argv from a JSON-RPC request, so the server dispatches
/// it through `Scripts` exactly like the in-process / oneshot paths. The wire:
/// `params: { "_pos": [..], "key": val }` → `[method, ..pos, "--key", val]`
/// (or a bare positional array). `_pos` entries are pushed **verbatim**, so the
/// tsh client forwards the user's whole argv tail as `_pos` (flags and all) and
/// gets `[method, ...tail]` back — byte-identical to a oneshot child — without
/// any client-side arg parsing, and using only the wire the deployed daemon
/// already understands.
pub fn build_argv(request: &JsonRpcRequest) -> Vec<String> {
  let mut argv: Vec<String> = vec![request.method.clone()];

  let push_val = |argv: &mut Vec<String>, v: &Value| match v {
    Value::String(s) => argv.push(s.clone()),
    other => argv.push(other.to_string()),
  };

  match &request.params {
    Value::Object(map) => {
      // Positionals first, then flags (legacy ordering). The tsh client puts its
      // entire raw argv tail in `_pos`, so it round-trips verbatim.
      if let Some(Value::Array(positionals)) = map.get("_pos") {
        for v in positionals {
          push_val(&mut argv, v);
        }
      }
      for (key, value) in map {
        if key == "_pos" || value.is_null() {
          continue;
        }
        argv.push(format!("--{key}"));
        push_val(&mut argv, value);
      }
    }
    Value::Array(positionals) => {
      for v in positionals {
        push_val(&mut argv, v);
      }
    }
    _ => {}
  }
  argv
}

// ── Session-leased services ────────────────────────────────────────

/// The engine-side owner of session-leased service children, seen by the client
/// as a trait so the client stays reusable and the child ownership lives in the
/// engine (tsh). A session-scoped daemon call uses this to (a) obtain the
/// per-session socket from the engine's typed session folder and (b) ensure the
/// service child is spawned and
/// **owned** by the engine (`kill_on_drop`), so it dies with the session — the
/// manifest record is inspect-only; nobody reaps from it.
pub trait ServiceLease {
  /// Derive `app`'s socket from the owner's typed session-folder boundary.
  /// The generic transport intentionally knows nothing about the folder layout.
  fn service_socket(&self, app: &str) -> anyhow::Result<PathBuf>;

  /// Ensure `app`'s service child is spawned and engine-owned (idempotent — a
  /// no-op when a live child already holds `socket`). `socket` is the derived
  /// per-session socket; `bin`/`start` are the launch argv. The spawn uses
  /// `kill_on_drop`, and the child handle is retained by the engine.
  fn ensure_service(
    &self,
    app: &str,
    socket: &Path,
    bin: &Path,
    start: &[String],
  ) -> anyhow::Result<()>;
}

// ── Client (the tsh daemon transport) ──────────────────────────────

/// How long to wait for a lazily-spawned daemon to bind its socket.
#[cfg(unix)]
const SPAWN_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// One deadline includes connection readiness, request delivery and response.
#[cfg(unix)]
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(unix)]
async fn call_deadline<T>(
  duration: Duration,
  method: &str,
  operation: impl std::future::Future<Output = anyhow::Result<T>>,
) -> anyhow::Result<T> {
  tokio::time::timeout(duration, operation)
    .await
    .map_err(|_| {
      anyhow::anyhow!(
        "daemon call {method} timed out; execution outcome may be unknown; request was not retried"
      )
    })?
}

/// JSON-RPC client for the daemon transport. One call = connect, frame the
/// request, read the framed response. If the socket is absent and a `start`
/// argv is given, the daemon is lazily spawned first.
pub struct Client;

/// The transport itself is a Unix socket for now; on other platforms both call
/// paths refuse cleanly (a named-pipe transport is the porting seam).
#[cfg(not(unix))]
impl Client {
  pub async fn call(
    socket: &Path,
    _start: Option<&[String]>,
    _bin: &Path,
    _method: &str,
    _argv_tail: &[String],
  ) -> anyhow::Result<Value> {
    anyhow::bail!(
      "daemon transport ({}) requires unix sockets; unsupported on this platform",
      socket.display()
    )
  }

  pub async fn call_leased(
    socket: &Path,
    _lease: &dyn ServiceLease,
    _app: &str,
    _bin: &Path,
    _start: &[String],
    _method: &str,
    _argv_tail: &[String],
  ) -> anyhow::Result<Value> {
    anyhow::bail!(
      "daemon transport ({}) requires unix sockets; unsupported on this platform",
      socket.display()
    )
  }
}

#[cfg(unix)]
impl Client {
  /// Dispatch `method` + `argv_tail` to the daemon at `socket`. The tail is
  /// forwarded verbatim as `params._pos` so the daemon reconstructs the same
  /// argv a oneshot child would (`[method, ...tail]`) using only the wire the
  /// deployed daemon already speaks. `start` (if set) is the argv passed to
  /// `bin` to lazily spawn the daemon when the socket isn't there yet; `None`
  /// means externally-managed (a clear error if it isn't running).
  pub async fn call(
    socket: &Path,
    start: Option<&[String]>,
    bin: &Path,
    method: &str,
    argv_tail: &[String],
  ) -> anyhow::Result<Value> {
    call_deadline(CALL_TIMEOUT, method, async {
      let stream = connect_or_spawn(socket, start, bin).await?;
      Self::exchange(stream, method, argv_tail).await
    })
    .await
  }

  /// Dispatch `method` + `argv_tail` to a SESSION-leased service at `socket`.
  /// Like [`Self::call`], but when the socket isn't there yet the child is
  /// spawned + owned by the engine via `lease` (not the detached null-stdio
  /// spawn): `lease.ensure_service` records a `kill_on_drop` child so the
  /// service dies with the session. `app`/`bin`/`start` are the launch context.
  pub async fn call_leased(
    socket: &Path,
    lease: &dyn ServiceLease,
    app: &str,
    bin: &Path,
    start: &[String],
    method: &str,
    argv_tail: &[String],
  ) -> anyhow::Result<Value> {
    call_deadline(CALL_TIMEOUT, method, async {
      let stream = connect_or_lease(socket, lease, app, bin, start).await?;
      Self::exchange(stream, method, argv_tail).await
    })
    .await
  }

  /// Frame the request over `stream`, read the framed response, surface a
  /// transport-native JSON-RPC error as an `Err`. Shared by both call paths.
  async fn exchange(
    mut stream: UnixStream,
    method: &str,
    argv_tail: &[String],
  ) -> anyhow::Result<Value> {
    let request = JsonRpcRequest {
      jsonrpc: "2.0".into(),
      method: method.to_string(),
      params: serde_json::json!({ "_pos": argv_tail }),
      id: Value::Number(1.into()),
    };
    let req_json = serde_json::to_vec(&request)?;
    write_frame(&mut stream, &req_json).await?;
    let resp_bytes = read_frame(&mut stream).await?;
    let response: JsonRpcResponse = serde_json::from_slice(&resp_bytes)?;

    if let Some(err) = response.error {
      // Transport-native error — surface code + message (+ any data), the same
      // way a oneshot non-zero exit surfaces stderr.
      let detail = match &err.data {
        Some(data) => format!("{} (code {}): {data}", err.message, err.code),
        None => format!("{} (code {})", err.message, err.code),
      };
      anyhow::bail!("{detail}");
    }
    Ok(response.result.unwrap_or(Value::Null))
  }
}

/// Try to connect to `socket`. `Ok(Some(stream))` on success; `Ok(None)` when
/// the socket is absent/refused (the daemon isn't listening — the caller decides
/// whether/how to spawn); `Err` for any other connect failure.
#[cfg(unix)]
async fn try_connect(socket: &Path) -> anyhow::Result<Option<UnixStream>> {
  match UnixStream::connect(socket).await {
    Ok(s) => Ok(Some(s)),
    Err(e)
      if matches!(
        e.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
      ) =>
    {
      Ok(None)
    }
    Err(e) => Err(anyhow::anyhow!(
      "connecting to daemon socket {}: {e}",
      socket.display()
    )),
  }
}

/// Poll-connect to `socket` until it binds or [`SPAWN_CONNECT_TIMEOUT`] elapses
/// — the shared tail after a spawn/ensure ran. `label` names the launch for the
/// timeout error.
#[cfg(unix)]
async fn poll_connect(socket: &Path, label: &str) -> anyhow::Result<UnixStream> {
  let deadline = Instant::now() + SPAWN_CONNECT_TIMEOUT;
  loop {
    match UnixStream::connect(socket).await {
      Ok(s) => return Ok(s),
      Err(_) if Instant::now() < deadline => {
        tokio::time::sleep(Duration::from_millis(100)).await;
      }
      Err(e) => {
        anyhow::bail!(
          "{label} but socket {} not ready within {}s: {e}",
          socket.display(),
          SPAWN_CONNECT_TIMEOUT.as_secs()
        );
      }
    }
  }
}

/// Connect to `socket`; if it's absent/refused and `start` is given, spawn
/// `bin <start…>` (detached, null stdio) and poll-connect until it binds.
#[cfg(unix)]
async fn connect_or_spawn(
  socket: &Path,
  start: Option<&[String]>,
  bin: &Path,
) -> anyhow::Result<UnixStream> {
  if let Some(s) = try_connect(socket).await? {
    return Ok(s);
  }

  let Some(start) = start else {
    anyhow::bail!(
      "daemon not running at {} and no start command in the manifest \
       (start it externally, e.g. via launchd)",
      socket.display()
    );
  };

  // Lazy spawn — detached, stdio to /dev/null. The daemon owns its own lifecycle
  // (pid file, signal handlers); dropping the handle doesn't reap it.
  let mut cmd = std::process::Command::new(bin);
  cmd.args(start);
  // Hermetic spawn when the session EnvMap is installed (the child's env is
  // the declared session env); no map → legacy inheritance.
  if let Some(envs) = tento_env::hermetic_child_env_os() {
    cmd.env_clear();
    cmd.envs(envs);
  }
  cmd
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .map_err(|e| {
      anyhow::anyhow!(
        "spawning daemon `{} {}`: {e}",
        bin.display(),
        start.join(" ")
      )
    })?;

  poll_connect(socket, "daemon spawned").await
}

/// Connect to `socket`; if it's absent/refused, ensure the SESSION-leased
/// service is spawned + engine-owned via `lease` (not the detached spawn) and
/// poll-connect until it binds. The engine holds the `kill_on_drop` child, so
/// the service dies with the session.
#[cfg(unix)]
async fn connect_or_lease(
  socket: &Path,
  lease: &dyn ServiceLease,
  app: &str,
  bin: &Path,
  start: &[String],
) -> anyhow::Result<UnixStream> {
  if let Some(s) = try_connect(socket).await? {
    return Ok(s);
  }
  lease.ensure_service(app, socket, bin, start)?;
  poll_connect(socket, "session service spawned").await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn build_argv_pos_passthrough_is_byte_identical_to_oneshot() {
    // The tsh client puts its whole argv tail (flags and all) in `_pos`; the
    // daemon pushes them verbatim → identical to `bin play --character jdacow …`.
    let req = JsonRpcRequest {
      jsonrpc: "2.0".into(),
      method: "play".into(),
      params: serde_json::json!({ "_pos": ["--character", "jdacow", "--day", "1"] }),
      id: Value::Null,
    };
    assert_eq!(
      build_argv(&req),
      vec!["play", "--character", "jdacow", "--day", "1"]
    );
  }

  #[test]
  fn build_argv_structured_pos_then_flags() {
    let req = JsonRpcRequest {
      jsonrpc: "2.0".into(),
      method: "ns.verb".into(),
      params: serde_json::json!({ "_pos": ["a", "b"], "key": "value" }),
      id: Value::Null,
    };
    let argv = build_argv(&req);
    assert_eq!(argv[0], "ns.verb");
    assert_eq!(argv[1], "a");
    assert_eq!(argv[2], "b");
    // flag pair present (map ordering aside)
    let k = argv.iter().position(|s| s == "--key").unwrap();
    assert_eq!(argv[k + 1], "value");
  }

  #[test]
  fn build_argv_empty_tail_is_just_method() {
    let req = JsonRpcRequest {
      jsonrpc: "2.0".into(),
      method: "jvmp.status".into(),
      params: serde_json::json!({ "_pos": [] }),
      id: Value::Null,
    };
    assert_eq!(build_argv(&req), vec!["jvmp.status"]);
  }

  #[test]
  fn response_ok_and_err_are_exclusive_on_the_wire() {
    let ok = serde_json::to_string(&JsonRpcResponse::ok(
      Value::Null,
      serde_json::json!({"x": 1}),
    ))
    .unwrap();
    assert!(ok.contains("result") && !ok.contains("error"));
    let err = serde_json::to_string(&JsonRpcResponse::err(
      Value::Null,
      JsonRpcError::method_not_found("foo"),
    ))
    .unwrap();
    assert!(err.contains("error") && err.contains("-32601") && !err.contains("result"));
  }
  #[tokio::test]
  async fn oversized_header_is_rejected_before_reading_payload() {
    let (mut reader, mut writer) = tokio::io::duplex(8);
    writer.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
    let error = tokio::time::timeout(std::time::Duration::from_secs(1), read_frame(&mut reader))
      .await
      .unwrap()
      .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
  }

  #[tokio::test]
  async fn oversized_write_is_rejected_before_writing_header() {
    let (mut writer, mut reader) = tokio::io::duplex(8);
    let payload = vec![0; MAX_FRAME_BYTES + 1];
    assert_eq!(
      write_frame(&mut writer, &payload).await.unwrap_err().kind(),
      std::io::ErrorKind::InvalidInput
    );
    drop(writer);
    assert_eq!(reader.read(&mut [0; 1]).await.unwrap(), 0);
  }

  #[cfg(unix)]
  #[tokio::test]
  async fn deadline_after_request_does_not_replay_mutation() {
    let (client, mut server) = UnixStream::pair().unwrap();
    let peer = tokio::spawn(async move {
      let request = read_frame(&mut server).await.unwrap();
      assert_eq!(
        serde_json::from_slice::<Value>(&request).unwrap()["method"],
        "mutate"
      );
      let mut rest = Vec::new();
      server.read_to_end(&mut rest).await.unwrap();
      assert!(
        rest.is_empty(),
        "must not resend after an uncertain outcome"
      );
    });
    let error = call_deadline(
      Duration::from_millis(50),
      "mutate",
      Client::exchange(client, "mutate", &[]),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("outcome may be unknown"));
    tokio::time::timeout(Duration::from_secs(1), peer)
      .await
      .unwrap()
      .unwrap();
  }
}
