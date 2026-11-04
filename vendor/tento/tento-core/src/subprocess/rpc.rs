use std::fmt;
use std::future::Future;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::task::Waker;
use std::time::Duration;

use anyhow::{Context, anyhow};
use dashmap::DashMap;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time;
use tracing::{self, debug, error, info, warn};

use super::message::{Message, RpcRequest, RpcResponse};

#[derive(Clone)]
pub struct OutgoingRpc {
  pub inner: Arc<OutgoingRpcInner>,
}

impl OutgoingRpc {
  pub fn new(request: RpcRequest) -> OutgoingRpc {
    OutgoingRpc {
      inner: Arc::new(OutgoingRpcInner {
        request,
        result: RwLock::new(None),
        waker: RwLock::new(None),
        spawn_id: AtomicU32::new(NO_SPAWN),
      }),
    }
  }

  pub fn complete(&mut self, response: RpcResponse) {
    self.finish(Ok(response));
  }

  pub fn fail(&mut self, error: anyhow::Error) {
    self.finish(Err(error));
  }

  /// Store the result, then wake whoever polled. A call that has not been
  /// polled yet has no waker; it finds the result on its first poll.
  fn finish(&mut self, result: anyhow::Result<RpcResponse>) {
    {
      *self.inner.result.write().expect("poisoned") = Some(result);
    }
    let waker = self.inner.waker.write().expect("poisoned").take();
    if let Some(waker) = waker {
      waker.wake();
    }
  }
}

impl Future for OutgoingRpc {
  type Output = anyhow::Result<RpcResponse>;

  fn poll(
    self: std::pin::Pin<&mut Self>,
    cx: &mut std::task::Context<'_>,
  ) -> std::task::Poll<Self::Output> {
    // Waker first, result second: `finish` stores the result before taking
    // the waker, so either this poll sees the result or `finish` sees this
    // waker. Checking first (or skipping on a contended lock) lost wake-ups.
    let inner = self.inner.clone();
    inner.save_waker(cx.waker().clone());
    if let Some(resp) = inner.result.write().expect("poisoned").take() {
      return std::task::Poll::Ready(resp);
    }
    std::task::Poll::Pending
  }
}

pub struct OutgoingRpcInner {
  pub request: RpcRequest,
  pub result: RwLock<Option<anyhow::Result<RpcResponse>>>,
  pub waker: RwLock<Option<std::task::Waker>>,
  /// The subprocess the request was written to. A subprocess that dies or
  /// is replaced fails only its own calls, never those already sent to its
  /// successor.
  spawn_id: AtomicU32,
}

/// `spawn_id` of a call not yet written to any subprocess.
const NO_SPAWN: u32 = u32::MAX;

impl OutgoingRpcInner {
  fn save_waker(&self, waker: Waker) {
    let Ok(mut waker_lock) = self.waker.write() else {
      return;
    };
    *waker_lock = Some(waker);
  }
}

/// Ping intervals a subprocess may take to answer a ping before it counts as
/// unhealthy. A child busy in a long handler answers pings late (its event
/// loop is shared with the handler), and declaring it dead on the first late
/// pong replaced the bundler worker in the middle of a build.
pub const PONG_GRACE_INTERVALS: u64 = 3;

/// Liveness of one spawned subprocess. Its reader and ping tasks each hold
/// this subprocess's own record, so a task that outlives a replacement (an
/// abort takes effect only at the task's next await) can change only the
/// subprocess it belonged to, never its successor.
pub(crate) struct SpawnHealth {
  spawn_id: u32,
  // False once the reader saw the pipe close, a write to it failed or it was
  // reset; never true again. A closed subprocess is written no new call.
  open: AtomicBool,
  // Milliseconds since the client's `epoch` by which the outstanding ping's
  // pong is due; 0 while no ping is outstanding. A busy child answers late,
  // not never, so a ping in flight is not by itself a dead subprocess.
  pong_deadline_ms: AtomicU64,
}

impl SpawnHealth {
  fn new(spawn_id: u32) -> Self {
    SpawnHealth {
      spawn_id,
      open: AtomicBool::new(true),
      pong_deadline_ms: AtomicU64::new(0),
    }
  }

  /// Open, and no ping unanswered for [`PONG_GRACE_INTERVALS`] intervals.
  fn is_healthy(&self, now_ms: u64) -> bool {
    if !self.open.load(Ordering::SeqCst) {
      return false;
    }
    let deadline = self.pong_deadline_ms.load(Ordering::SeqCst);
    deadline == 0 || now_ms < deadline
  }
}

/// A call that was not written: the subprocess it was meant for (none when
/// there was no subprocess), and why.
struct Unsent {
  spawn_id: Option<u32>,
  error: anyhow::Error,
}

/// Whether a message reached the subprocess it was meant for.
enum Delivery {
  Written,
  /// That subprocess is no longer the running one; nothing was written.
  Replaced,
}

/// A simple RPC client for communicating with subprocesses
#[derive(Clone)]
pub struct SubprocessRpc {
  id: String,
  pub(crate) spawn_id: Arc<AtomicU32>,
  /// Health of the running subprocess (`None` when none runs), for
  /// [`Self::is_healthy`]. Written only under `inner`'s lock, beside it.
  current: Arc<std::sync::RwLock<Option<Arc<SpawnHealth>>>>,
  pub(crate) rpc_id: Arc<AtomicU64>,
  pub(crate) outgoing_rpcs: Arc<DashMap<u64, OutgoingRpc>>,
  command_factory: Arc<dyn Fn() -> Command + Send + Sync>,
  pub(crate) inner: Arc<Mutex<Option<SubprocessInner>>>,
  epoch: std::time::Instant,
  // Interval between pings in milliseconds (default: 5 seconds)
  ping_interval_ms: u64,
  // When set, this subprocess's RPC diagnostics (stderr echo + protocol
  // chatter) route to the named stream bucket (e.g. "bundling") instead of the
  // main server log, so they can be inspected — and disabled — independently.
  log_stream: Option<String>,
}

impl fmt::Debug for SubprocessRpc {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("SubprocessRpc")
      .field("id", &self.id)
      .field("inner", &self.inner)
      .finish()
  }
}

pub(crate) struct SubprocessInner {
  pub(crate) spawn_id: u32,
  health: Arc<SpawnHealth>,
  pub(crate) stdin: ChildStdin,
  pub(crate) child: Child,
  #[allow(dead_code)]
  pub(crate) handler: JoinHandle<()>,
  #[allow(dead_code)]
  pub(crate) log_handler: JoinHandle<()>,
  #[allow(dead_code)]
  pub(crate) ping_handler: JoinHandle<()>,
}

impl fmt::Debug for SubprocessInner {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("SubprocessInner")
      .field("spawn_id", &self.spawn_id)
      .field("child_id", &self.child.id())
      .finish()
  }
}

impl SubprocessRpc {
  /// Create a new subprocess RPC client with lazy initialization
  pub fn new<F>(id: String, command_factory: F) -> Self
  where
    F: Fn() -> Command + Send + Sync + 'static,
  {
    SubprocessRpc {
      id,
      spawn_id: Arc::new(AtomicU32::new(0)),
      current: Arc::new(std::sync::RwLock::new(None)),
      rpc_id: Arc::new(AtomicU64::new(0)),
      outgoing_rpcs: Arc::new(DashMap::new()),
      command_factory: Arc::new(command_factory),
      inner: Arc::new(Mutex::new(None)),
      epoch: std::time::Instant::now(),
      ping_interval_ms: 5000, // Default to 5 seconds
      log_stream: None,
    }
  }

  /// Set a custom ping interval (in milliseconds)
  pub fn with_ping_interval(mut self, interval_ms: u64) -> Self {
    self.ping_interval_ms = interval_ms;
    self
  }

  /// Route this subprocess's RPC diagnostics to a named stream bucket (e.g.
  /// `"bundling"`) instead of the main server log. The launcher that knows the
  /// node's bucket identity installs the writer under this name (see
  /// `tento_logger::subscribers::install_stream_writer`); this layer looks it
  /// up by name and appends. Keeps routine subprocess chatter out of the
  /// primary log while leaving it visible — and independently disableable — in
  /// its own stream.
  pub fn with_log_stream(mut self, stream: String) -> Self {
    self.log_stream = Some(stream);
    self
  }

  /// Append one diagnostic event to this subprocess's stream bucket as a
  /// synthesized span row, when a stream is configured and its writer is
  /// installed. Returns `false` otherwise so the caller falls back to a
  /// `tracing` macro (no stream configured, or the launcher hasn't installed a
  /// writer yet — we never silently drop the line).
  fn log_event(&self, level: &str, name: &str, attributes: serde_json::Value) -> bool {
    let Some(writer) = self
      .log_stream
      .as_deref()
      .and_then(tento_logger::subscribers::stream_writer)
    else {
      return false;
    };
    let _ = writer.append(chrono::Utc::now(), name, level, attributes);
    true
  }

  /// Check if the running subprocess is currently considered healthy: its
  /// pipe is open and no ping has gone unanswered for
  /// [`PONG_GRACE_INTERVALS`] ping intervals. True while none runs.
  pub fn is_healthy(&self) -> bool {
    let current = self.current.read().expect("poisoned").clone();
    current.is_none_or(|health| health.is_healthy(self.now_ms()))
  }

  fn now_ms(&self) -> u64 {
    // +1 so a deadline is never the "no ping outstanding" 0.
    self.epoch.elapsed().as_millis() as u64 + 1
  }

  /// Requests sent and not yet answered.
  pub fn in_flight(&self) -> usize {
    self.outgoing_rpcs.len()
  }

  /// Replace subprocess `spawn_id` if it is still the running one: kill it,
  /// and fail every call still waiting on it (dropping the reader task alone
  /// left those calls pending forever). Returns false and does nothing when
  /// it has already been replaced: whoever saw it fail — a call's write, a
  /// call's health check, its ping loop — may act after a concurrent caller
  /// has replaced it and written to the successor, which must survive.
  pub(crate) async fn reset_spawn(&self, spawn_id: u32, reason: &str) -> bool {
    let old = {
      let mut inner = self.inner.lock().await;
      if inner.as_ref().map(|running| running.spawn_id) != Some(spawn_id) {
        return false;
      }
      *self.current.write().expect("poisoned") = None;
      inner.take()
    };
    let Some(mut old) = old else { return false };
    old.health.open.store(false, Ordering::SeqCst);
    let _ = old.child.start_kill();
    self.fail_calls_of(
      old.spawn_id,
      &format!("subprocess {} was replaced: {reason}", self.id),
    );
    warn!("subprocess {} reset: {reason}", self.id);
    true
  }

  /// Fail every call written to subprocess `spawn_id`. Calls sent to a later
  /// subprocess (a concurrent caller may already have started one) are left
  /// to it.
  fn fail_calls_of(&self, spawn_id: u32, why: &str) {
    let stranded: Vec<u64> = self
      .outgoing_rpcs
      .iter()
      .filter(|e| e.value().inner.spawn_id.load(Ordering::SeqCst) == spawn_id)
      .map(|e| *e.key())
      .collect();
    for id in stranded {
      if let Some((_, mut rpc)) = self.outgoing_rpcs.remove(&id) {
        rpc.fail(anyhow!("{why}"));
      }
    }
  }

  /// The reader of `health`'s subprocess can read no more: close it, then
  /// fail the calls written to it. Closing first is what keeps a call from
  /// being stranded: `send_call` registers a call before it checks `open`,
  /// so a call either is refused there or is registered in time for this
  /// sweep to fail it.
  fn subprocess_failed(&self, health: &SpawnHealth, why: &str) {
    health.open.store(false, Ordering::SeqCst);
    self.fail_calls_of(health.spawn_id, why);
  }

  /// Ping `health`'s subprocess and start its pong clock. Returns whether
  /// its ping loop should go on: a replaced subprocess is not pinged (its
  /// successor has its own loop), and one whose ping cannot be written is
  /// reset.
  async fn ping(&self, health: &SpawnHealth) -> bool {
    if !self.log_event(
      "debug",
      "rpc/ping",
      serde_json::json!({ "subprocess": self.id }),
    ) {
      debug!("Sending ping to subprocess {}", self.id);
    }
    // Armed before the write, so the pong cannot arrive before the deadline
    // it clears; an earlier unanswered ping's deadline stands (a later ping
    // must not extend it).
    let due = self.now_ms() + self.ping_interval_ms * PONG_GRACE_INTERVALS;
    let _ = health
      .pong_deadline_ms
      .compare_exchange(0, due, Ordering::SeqCst, Ordering::SeqCst);
    match self.send_to(health.spawn_id, &Message::Ping).await {
      Ok(Delivery::Written) => true,
      Ok(Delivery::Replaced) => false,
      Err(e) => {
        error!("Failed to send ping to subprocess: {}", e);
        health.open.store(false, Ordering::SeqCst);
        // This task belongs to the subprocess being reset; it is aborted at
        // its next await, which is why its loop ends here.
        self
          .reset_spawn(health.spawn_id, "ping could not be sent")
          .await;
        false
      }
    }
  }

  /// Ensure the subprocess is running or start a new one, and return the
  /// health of the one running.
  async fn ensure_subprocess(&self) -> anyhow::Result<Arc<SpawnHealth>> {
    let mut inner = self.inner.lock().await;
    if let Some(running) = inner.as_ref() {
      return Ok(running.health.clone());
    }

    let mut cmd = (self.command_factory)();
    // A replaced subprocess must not outlive its handle.
    cmd.kill_on_drop(true);
    let spawn_context = format!("Failed to spawn subprocess: {cmd:?}");
    let mut child = cmd
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .context(spawn_context)?;
    let stdin = child
      .stdin
      .take()
      .ok_or_else(|| anyhow!("Failed to open child stdin"))?;
    let mut stdout = child
      .stdout
      .take()
      .ok_or_else(|| anyhow!("Failed to open child stdout"))?;
    let stderr = child
      .stderr
      .take()
      .ok_or_else(|| anyhow!("Failed to open child stdout"))?;
    let mut stderr_reader = BufReader::new(stderr);
    let outgoing_rpcs = self.outgoing_rpcs.clone();

    let id = self.id.clone();
    let spawn_id = self.spawn_id.fetch_add(1, Ordering::SeqCst);
    let health = Arc::new(SpawnHealth::new(spawn_id));
    let pid = child.id().map(|pid| pid as i64).unwrap_or(-1);
    let log_stream = self.log_stream.clone();
    let log_handler = tokio::spawn(async move {
      loop {
        let mut buf = String::new();
        match stderr_reader.read_line(&mut buf).await {
          Ok(bytes) => {
            if bytes == 0 {
              return;
            }
            // Skip empty lines to avoid excessive logging
            let trimmed = buf.trim_end();
            if !trimmed.is_empty() {
              // Route to the subprocess's stream bucket when one is configured
              // and its writer is installed; otherwise echo to the main log.
              match log_stream
                .as_deref()
                .and_then(tento_logger::subscribers::stream_writer)
              {
                Some(writer) => {
                  let _ = writer.append(
                    chrono::Utc::now(),
                    trimmed,
                    detect_line_level(trimmed),
                    serde_json::json!({
                      "subprocess_id": id,
                      "spawn_id": spawn_id,
                      "pid": pid,
                    }),
                  );
                }
                None => info!("[{id}:{spawn_id}/{pid}] {}", trimmed),
              }
            }
          }
          Err(e) => {
            error!("rpc/stderr error, {e}");
            return;
          }
        }
      }
    });

    // Create a clone of self that will be used within the message handler
    let rpc_self = self.clone();
    let reader_health = health.clone();

    let handler = tokio::spawn(async move {
      loop {
        // let tid = thread::current().id();
        // println!("{tid:?} - rpc reader");
        match Message::read(&mut stdout).await {
          Ok(Message::RpcResponse(response)) => {
            let Some(mut rpc) = outgoing_rpcs.get_mut(&response.id) else {
              warn!("Received response for unknown RPC ID: {}", response.id);
              continue;
            };
            if !rpc_self.log_event(
              "debug",
              &format!("rpc/response #{}", response.id),
              serde_json::json!({
                "id": response.id,
                "response": response.response.clone(),
              }),
            ) {
              debug!("[parent] got response: {:?}", response);
            }
            rpc.complete(response);
          }
          Ok(Message::Ping) => {
            // debug!("Received ping from subprocess, sending pong");
            // Answer the child's ping, on this subprocess only.
            if let Err(e) = rpc_self.send_to(spawn_id, &Message::Pong).await {
              error!("Failed to send pong in response to ping: {}", e);
            }
          }
          Ok(Message::Pong) => {
            // debug!("Received pong from subprocess");
            // A pong answers this subprocess's outstanding ping.
            reader_health.pong_deadline_ms.store(0, Ordering::SeqCst);
          }
          Ok(_) => {
            // debug!("Received unexpected message type from subprocess");
          }
          Err(e) => {
            error!("Error reading message from subprocess: {}", e);
            rpc_self.subprocess_failed(
              &reader_health,
              &format!("Subprocess communication error: {e}"),
            );
            break;
          }
        }
      }
    });

    // Create a ping handler that periodically sends pings
    let ping_rpc = self.clone();
    let ping_health = health.clone();
    let ping_interval = self.ping_interval_ms;
    let ping_handler = tokio::spawn(async move {
      let mut interval = time::interval(Duration::from_millis(ping_interval));

      // Initial delay before first ping
      interval.tick().await;

      loop {
        interval.tick().await;
        if !ping_rpc.ping(&ping_health).await {
          debug!("Subprocess {spawn_id} no longer running, stopping its ping loop");
          break;
        }
      }
    });

    *self.current.write().expect("poisoned") = Some(health.clone());
    *inner = Some(SubprocessInner {
      spawn_id,
      health: health.clone(),
      stdin,
      child,
      handler,
      log_handler,
      ping_handler,
    });

    Ok(health)
  }

  pub async fn call(&self, method: String, params: Value) -> anyhow::Result<RpcResponse> {
    let request = RpcRequest { method, params };
    let max_retry_cnt = 5;
    for attempt in 1..=max_retry_cnt {
      let seen = self.ensure_subprocess().await?;
      if !seen.is_healthy(self.now_ms()) {
        // Replace the subprocess this call saw unhealthy, and only that one:
        // a concurrent caller may have replaced it already and written to
        // the successor. Replacing fails whatever was still waiting on it,
        // so those callers see an error instead of hanging.
        self
          .reset_spawn(seen.spawn_id, "unhealthy before a call")
          .await;
        self.ensure_subprocess().await?;
      }

      let id = self.rpc_id.fetch_add(1, Ordering::SeqCst);
      if !self.log_event(
        "debug",
        &format!("rpc/request {} #{}", request.method, id),
        serde_json::json!({
          "id": id,
          "method": request.method.clone(),
          "params": request.params.clone(),
        }),
      ) {
        debug!("call {} {:?}", request.method, request.params);
      }
      let message = Message::RpcRequest {
        id,
        inner: request.clone(),
      };
      let outgoing = OutgoingRpc::new(request.clone());

      match self.send_call(id, &outgoing, &message).await {
        Ok(()) => {
          let result = outgoing.await;
          self.outgoing_rpcs.remove(&id);
          return result;
        }
        Err(Unsent { spawn_id, error }) => {
          warn!(
            "Failed to send RPC request, resetting subprocess (attempt {attempt}/{max_retry_cnt}): {error:?}"
          );
          // Only the subprocess the write was meant for: another caller may
          // have replaced it since and written to its successor.
          if let Some(spawn_id) = spawn_id {
            self
              .reset_spawn(spawn_id, "request could not be sent")
              .await;
          }
        }
      }
    }
    Err(anyhow!("max retry count reached"))
  }

  /// Register `outgoing` against the subprocess it is about to be written
  /// to, then write it, under one lock: a replacement in between cannot leave
  /// the call attributed to the wrong subprocess. A call that is not written
  /// is withdrawn again, and a failed write closes the subprocess.
  async fn send_call(
    &self,
    id: u64,
    outgoing: &OutgoingRpc,
    message: &Message,
  ) -> Result<(), Unsent> {
    let mut inner_guard = self.inner.lock().await;
    let Some(inner) = inner_guard.as_mut() else {
      return Err(Unsent {
        spawn_id: None,
        error: anyhow!("Subprocess not initialized"),
      });
    };
    let spawn_id = inner.spawn_id;
    let unsent = move |error: anyhow::Error| Unsent {
      spawn_id: Some(spawn_id),
      error,
    };
    outgoing
      .inner
      .spawn_id
      .store(inner.spawn_id, Ordering::SeqCst);
    self.outgoing_rpcs.insert(id, outgoing.clone());
    // Registered first, checked second (see `subprocess_failed`).
    if !inner.health.open.load(Ordering::SeqCst) {
      self.outgoing_rpcs.remove(&id);
      return Err(unsent(anyhow!("subprocess {} is closed", self.id)));
    }
    if let Err(e) = message.send_to(&mut inner.stdin).await {
      inner.health.open.store(false, Ordering::SeqCst);
      self.outgoing_rpcs.remove(&id);
      return Err(unsent(e.context("Failed to send message to subprocess")));
    }
    Ok(())
  }

  /// Write `message` to subprocess `spawn_id`, if it is still the running
  /// one.
  async fn send_to(&self, spawn_id: u32, message: &Message) -> anyhow::Result<Delivery> {
    let mut inner_guard = self.inner.lock().await;
    let Some(inner) = inner_guard
      .as_mut()
      .filter(|running| running.spawn_id == spawn_id)
    else {
      return Ok(Delivery::Replaced);
    };
    message
      .send_to(&mut inner.stdin)
      .await
      .context("Failed to send message to subprocess")?;
    Ok(Delivery::Written)
  }
}

impl Drop for SubprocessInner {
  fn drop(&mut self) {
    self.handler.abort();
    self.log_handler.abort();
    self.ping_handler.abort();
  }
}

/// Coarse severity for a subprocess stderr line, used to level the
/// stream-bucket row when echoing subprocess output. Mirrors how producers
/// tag their own lines (esbuild's `[ERROR]`/`[WARNING]`, Rust's `error:`).
fn detect_line_level(line: &str) -> &'static str {
  if line.contains("[ERROR]") || line.contains("error:") {
    "error"
  } else if line.contains("[WARNING]") || line.contains("warning:") {
    "warn"
  } else {
    "info"
  }
}

#[cfg(test)]
mod spawn_attribution_tests {
  use super::*;

  /// A Deno RPC server with one `sleep` method, written to a temp dir.
  fn sleeper() -> (tempfile::TempDir, SubprocessRpc) {
    let dir = tempfile::tempdir().unwrap();
    let server = concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/src/subprocess/rpc-server.deno.ts"
    );
    let script = dir.path().join("sleeper.ts");
    std::fs::write(
      &script,
      format!(
        "import {{ RpcServer }} from \"file://{server}\";\n\
         const server = new RpcServer(undefined, 10, 60);\n\
         server.registerHandler(\"sleep\", async (p) => {{\n\
           await new Promise((wake) => setTimeout(wake, p.ms));\n\
           return {{ status: \"ok\" }};\n\
         }});\n\
         await server.run();\n"
      ),
    )
    .unwrap();
    let rpc = SubprocessRpc::new("Sleeper".to_string(), move || {
      let mut c = Command::new("deno");
      c.args(["run", "-A"]).arg(&script);
      c
    });
    (dir, rpc)
  }

  fn current_spawn(rpc: &SubprocessRpc) -> Option<u32> {
    rpc
      .current
      .read()
      .unwrap()
      .as_ref()
      .map(|health| health.spawn_id)
  }

  /// Waits for a condition rather than for a guessed time.
  async fn until(what: &str, condition: impl Fn() -> bool) {
    time::timeout(Duration::from_secs(20), async {
      while !condition() {
        time::sleep(Duration::from_millis(10)).await;
      }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
  }

  /// A call written to the running subprocess, in flight on its own task.
  async fn call_in_flight(rpc: &SubprocessRpc, ms: u64) -> JoinHandle<anyhow::Result<RpcResponse>> {
    let before = rpc.in_flight();
    let caller = rpc.clone();
    let call = tokio::spawn(async move {
      caller
        .call("sleep".to_string(), serde_json::json!({ "ms": ms }))
        .await
    });
    until("the call to be written", || rpc.in_flight() > before).await;
    call
  }

  /// A replaced subprocess fails the calls written to it; a call already
  /// written to its successor is not failed with it, even when the old
  /// subprocess's failure is noticed late (its reader seeing EOF after the
  /// replacement).
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_replaced_subprocess_fails_only_its_own_calls() {
    let (_dir, rpc) = sleeper();
    let old = call_in_flight(&rpc, 5_000).await;
    let old_spawn = current_spawn(&rpc).unwrap();
    assert!(rpc.reset_spawn(old_spawn, "test").await);
    // A call on the next subprocess, then the old one's late failure.
    let new = call_in_flight(&rpc, 1_000).await;
    rpc.fail_calls_of(old_spawn, "late reader EOF");
    let (old, new) = time::timeout(Duration::from_secs(20), async { tokio::join!(old, new) })
      .await
      .expect("no call may hang");
    assert!(old.unwrap().is_err());
    assert_eq!(new.unwrap().unwrap().response["status"], "ok");
    assert_ne!(current_spawn(&rpc), Some(old_spawn));
    assert_eq!(rpc.in_flight(), 0);
  }

  /// Everything that observed a subprocess before it was replaced and acts
  /// after — its reader seeing EOF, its ping loop, a call that saw it
  /// unhealthy, a call whose write to it failed — is replayed against it
  /// once its successor runs a call. None of it may mark the successor
  /// unhealthy, reset it, or fail its call. (Each of these paths used to
  /// check "is it still current?" and then act in a separate step, or reset
  /// whichever subprocess was current; this replays the act landing after a
  /// replacement in between, the interleaving those gaps allowed.)
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn stale_observers_of_a_replaced_subprocess_leave_its_successor_alone() {
    let (_dir, rpc) = sleeper();
    let old = rpc.ensure_subprocess().await.unwrap();
    assert!(rpc.reset_spawn(old.spawn_id, "replaced by the test").await);
    let call = call_in_flight(&rpc, 1_500).await;
    let new = rpc.ensure_subprocess().await.unwrap();
    assert_ne!(new.spawn_id, old.spawn_id);

    // The old reader's late EOF.
    rpc.subprocess_failed(&old, "late reader EOF");
    // The old ping loop's next tick: no ping is written to the successor, no
    // pong clock started on it, and the loop ends.
    assert!(!rpc.ping(&old).await);
    // A call that saw the old subprocess unhealthy, and one whose write to it
    // failed, each reset what they saw.
    assert!(
      !rpc
        .reset_spawn(old.spawn_id, "unhealthy before a call")
        .await
    );
    assert!(
      !rpc
        .reset_spawn(old.spawn_id, "request could not be sent")
        .await
    );

    assert!(rpc.is_healthy());
    assert!(new.open.load(Ordering::SeqCst));
    assert_eq!(new.pong_deadline_ms.load(Ordering::SeqCst), 0);
    assert_eq!(current_spawn(&rpc), Some(new.spawn_id));
    let result = time::timeout(Duration::from_secs(20), call)
      .await
      .expect("the successor's call must not hang")
      .unwrap();
    assert_eq!(result.unwrap().response["status"], "ok");
    assert_eq!(rpc.in_flight(), 0);
  }

  /// A subprocess its reader has given up on takes no new call: one written
  /// after the reader's sweep would never be answered or failed. The call
  /// is refused unsent, and `call` replaces the subprocess and succeeds.
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_closed_subprocess_is_written_no_new_call() {
    let (_dir, rpc) = sleeper();
    let old = rpc.ensure_subprocess().await.unwrap();
    rpc.subprocess_failed(&old, "reader EOF");

    let message = Message::RpcRequest {
      id: u64::MAX,
      inner: RpcRequest {
        method: "sleep".to_string(),
        params: serde_json::json!({ "ms": 0 }),
      },
    };
    let outgoing = OutgoingRpc::new(RpcRequest {
      method: "sleep".to_string(),
      params: serde_json::json!({ "ms": 0 }),
    });
    let unsent = rpc
      .send_call(u64::MAX, &outgoing, &message)
      .await
      .err()
      .expect("a closed subprocess must refuse the call");
    assert_eq!(unsent.spawn_id, Some(old.spawn_id));
    assert_eq!(rpc.in_flight(), 0);

    let result = time::timeout(
      Duration::from_secs(20),
      rpc.call("sleep".to_string(), serde_json::json!({ "ms": 0 })),
    )
    .await
    .expect("no call may hang");
    assert_eq!(result.unwrap().response["status"], "ok");
    assert_ne!(current_spawn(&rpc), Some(old.spawn_id));
  }
}
