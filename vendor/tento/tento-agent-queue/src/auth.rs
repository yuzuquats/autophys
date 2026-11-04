//! Authenticated framed tsh.serve/v2 client. Side effects are never replayed.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
  collections::VecDeque,
  io::{Read, Write},
  os::unix::net::UnixStream,
  path::Path,
  time::{Duration, Instant},
};

pub const MAX_FRAME: usize = 8 * 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(5);
const CONTEXT: &str = "tsh.serve/v2";

#[derive(Debug)]
pub struct RemoteError(pub Value);
impl std::fmt::Display for RemoteError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}", self.0["message"])
  }
}
impl std::error::Error for RemoteError {}

pub struct Connection {
  socket: UnixStream,
  token: String,
  channel: String,
  id: u64,
  seq: u64,
  events: u64,
  pending: VecDeque<Value>,
  pending_bytes: usize,
}
impl Connection {
  pub fn open(socket: &Path, token_dir: &Path) -> Result<Self> {
    let token = private_read(&token_dir.join("approval.token"))?;
    let socket = UnixStream::connect(socket).context("connect tsh serve")?;
    socket.set_read_timeout(Some(TIMEOUT))?;
    socket.set_write_timeout(Some(TIMEOUT))?;
    let mut conn = Self {
      socket,
      token,
      channel: String::new(),
      id: 0,
      seq: 0,
      events: 0,
      pending: VecDeque::new(),
      pending_bytes: 0,
    };
    let nonce = random()?;
    let params = json!({"bridge":"tento-agent-queue/1","nonce":nonce});
    let asked = conn.send("hello", params)?;
    let frame = conn.read_frame(Instant::now() + TIMEOUT)?;
    let body = text(&frame, "body")?;
    let answer: Value = serde_json::from_str(body)?;
    let hello = &answer["result"];
    let channel = text(hello, "channel")?;
    if hello["schema"] != CONTEXT
      || !verifies(
        &conn.token,
        &format!("{CONTEXT} hello\n{nonce}\n{channel}"),
        text(hello, "proof")?,
      )
    {
      bail!("serve did not prove its identity");
    }
    conn.channel = channel.into();
    conn.open_reply(frame, "hello", &asked)?;
    Ok(conn)
  }
  fn send(&mut self, method: &str, params: Value) -> Result<String> {
    if method.chars().any(char::is_control) {
      bail!("invalid method");
    }
    self.id += 1;
    let asked = digest(&serde_json::to_string(&params)?);
    let frame =
      serde_json::to_vec(&json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params}))?;
    if frame.len() > MAX_FRAME {
      bail!("frame budget exceeded");
    }
    self.socket.write_all(&(frame.len() as u32).to_be_bytes())?;
    self.socket.write_all(&frame)?;
    Ok(asked)
  }
  fn read_exact_until(&mut self, mut bytes: &mut [u8], deadline: Instant) -> Result<()> {
    while !bytes.is_empty() {
      let remaining = deadline
        .checked_duration_since(Instant::now())
        .context("frame deadline exceeded")?;
      self.socket.set_read_timeout(Some(remaining))?;
      let count = self.socket.read(bytes)?;
      if count == 0 {
        bail!("serve disconnected");
      }
      bytes = &mut bytes[count..];
    }
    Ok(())
  }
  fn read_frame(&mut self, deadline: Instant) -> Result<Value> {
    let mut head = [0; 4];
    self.read_exact_until(&mut head, deadline)?;
    let len = u32::from_be_bytes(head) as usize;
    if len > MAX_FRAME {
      bail!("frame budget exceeded");
    }
    let mut body = vec![0; len];
    self.read_exact_until(&mut body, deadline)?;
    let frame: Value = serde_json::from_slice(&body)?;
    if !frame.is_object() {
      bail!("frame must be an object");
    }
    Ok(frame)
  }
  fn open_reply(&self, frame: Value, method: &str, asked: &str) -> Result<Value> {
    let body = text(&frame, "body")?;
    if frame["id"] != self.id
      || !verifies(
        &self.token,
        &format!(
          "{CONTEXT} reply\n{}\n{}\n{method}\n{asked}\n{body}",
          self.channel, self.id
        ),
        text(&frame, "mac")?,
      )
    {
      bail!("unsigned or misbound serve reply");
    }
    let value: Value = serde_json::from_str(body)?;
    if value.get("result").is_some() == value.get("error").is_some() {
      bail!("invalid serve reply");
    }
    if let Some(error) = value.get("error") {
      return Err(RemoteError(error.clone()).into());
    }
    Ok(value["result"].clone())
  }
  fn open_event(&mut self, frame: Value) -> Result<Value> {
    let method = text(&frame, "method")?;
    if method.chars().any(char::is_control) {
      bail!("invalid event method");
    }
    let seq = frame["seq"].as_u64().context("missing event sequence")?;
    let body = text(&frame, "body")?;
    if seq != self.events + 1
      || !verifies(
        &self.token,
        &format!("{CONTEXT} event\n{}\n{seq}\n{method}\n{body}", self.channel),
        text(&frame, "mac")?,
      )
    {
      bail!("unsigned or reordered event");
    }
    let params: Value = serde_json::from_str(body)?;
    if !params.is_object() {
      bail!("event params must be an object");
    }
    self.events = seq;
    Ok(json!({"method":method,"params":params,"body":body}))
  }
  pub fn call(
    &mut self,
    method: &str,
    mut params: Value,
    session_token: Option<&str>,
  ) -> Result<Value> {
    let deadline = Instant::now() + TIMEOUT;
    if method.starts_with("control.") || method == "plugin.call" {
      self.seq += 1;
      let fields = params.as_object_mut().context("params must be an object")?;
      fields.remove("token");
      fields.remove("token_proof");
      if let Some(token) = session_token {
        fields.insert(
          "token_proof".into(),
          json!(mac(
            token,
            &format!("{CONTEXT} approve\n{}\n{}", self.channel, self.seq)
          )),
        );
      }
      let body = serde_json::to_string(&params)?;
      params = json!({"seq":self.seq,"mac":mac(&self.token,&format!("{CONTEXT} request\n{}\n{}\n{method}\n{body}",self.channel,self.seq)),"body":body});
    }
    let asked = self.send(method, params)?;
    loop {
      let frame = self.read_frame(deadline)?;
      if frame.get("id").is_some_and(|id| !id.is_null()) {
        return self.open_reply(frame, method, &asked);
      }
      let size = frame["body"].as_str().map_or(0, str::len);
      if self.pending.len() >= 256 || self.pending_bytes + size > MAX_FRAME {
        bail!("notification budget exceeded");
      }
      let note = self.open_event(frame)?;
      self.pending.push_back(note);
      self.pending_bytes += size;
    }
  }
  pub fn poll(&mut self) -> Result<Option<Value>> {
    if let Some(note) = self.pending.pop_front() {
      self.pending_bytes -= note["body"].as_str().map_or(0, str::len);
      return Ok(Some(note));
    }
    self.socket.set_read_timeout(Some(Duration::from_secs(1)))?;
    let mut first = [0u8; 1];
    // peek distinguishes an idle connection from a partially received frame.
    // SAFETY: recv writes at most one byte into the valid buffer; the fd is live.
    let n = unsafe {
      libc::recv(
        std::os::fd::AsRawFd::as_raw_fd(&self.socket),
        first.as_mut_ptr().cast(),
        1,
        libc::MSG_PEEK,
      )
    };
    if n < 0 {
      let error = std::io::Error::last_os_error();
      if matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
      ) {
        return Ok(None);
      }
      return Err(error.into());
    }
    if n == 0 {
      bail!("serve disconnected");
    }
    let frame = self.read_frame(Instant::now() + TIMEOUT)?;
    self.open_event(frame).map(Some)
  }
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
  value[key]
    .as_str()
    .with_context(|| format!("missing {key}"))
}

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::{
  fs::OpenOptions,
  os::unix::fs::{MetadataExt, OpenOptionsExt},
};
pub fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn random() -> Result<String> {
  let mut bytes = [0; 32];
  getrandom::getrandom(&mut bytes).map_err(|e| anyhow::anyhow!("randomness unavailable: {e}"))?;
  Ok(hex(&bytes))
}
pub fn digest(text: &str) -> String {
  hex(&Sha256::digest(text.as_bytes()))
}
pub fn mac(key: &str, text: &str) -> String {
  let mut h =
    Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts every key length");
  h.update(text.as_bytes());
  hex(&h.finalize().into_bytes())
}
pub fn verifies(key: &str, text: &str, signature: &str) -> bool {
  let mut bytes = Vec::new();
  if signature.len() != 64 {
    return false;
  }
  for chunk in signature.as_bytes().chunks_exact(2) {
    let Ok(s) = std::str::from_utf8(chunk) else {
      return false;
    };
    let Ok(b) = u8::from_str_radix(s, 16) else {
      return false;
    };
    bytes.push(b);
  }
  let mut h =
    Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts every key length");
  h.update(text.as_bytes());
  h.verify_slice(&bytes).is_ok()
}
/// No symlinks, special files, oversized files, or other-user-readable tokens.
pub fn private_read(path: &Path) -> Result<String> {
  let mut file = OpenOptions::new()
    .read(true)
    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
    .open(path)?;
  let meta = file.metadata()?;
  // SAFETY: geteuid has no arguments or memory requirements.
  if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
    bail!("{} is not a private file", path.display());
  }
  let mut text = String::new();
  (&mut file).take(257).read_to_string(&mut text)?;
  if text.len() > 256 || text.trim().is_empty() {
    bail!("invalid private file");
  }
  Ok(text.trim().into())
}
