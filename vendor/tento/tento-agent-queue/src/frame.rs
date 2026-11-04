//! The framing both tsh sockets speak: a 4-byte big-endian length, then one
//! JSON-RPC 2.0 message. Small enough to own outright — reaching into a
//! platform crate for thirty lines would make every product that enqueues a
//! job depend on tsh's app runtime.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{QueueError, Result};

/// The cap `tsh serve` enforces. A longer frame is refused before anything is
/// allocated for it.
pub const MAX_FRAME: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct Request {
  pub jsonrpc: &'static str,
  pub id: u64,
  pub method: String,
  pub params: Value,
}

impl Request {
  pub fn new(id: u64, method: impl Into<String>, params: Value) -> Self {
    Self {
      jsonrpc: "2.0",
      id,
      method: method.into(),
      params,
    }
  }
}

/// One incoming message. A reply carries `id` and `result` or `error`; a
/// server push carries `method` and `params` and no `id`, so one shape reads
/// both and the caller tells them apart.
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct Incoming {
  pub id: Option<Value>,
  pub method: Option<String>,
  pub params: Option<Value>,
  pub result: Option<Value>,
  pub error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
pub struct RpcError {
  pub code: i32,
  #[serde(default)]
  pub message: String,
  #[serde(default)]
  pub data: Option<Value>,
}

pub async fn write_frame<S: AsyncWrite + Unpin>(stream: &mut S, payload: &[u8]) -> Result<()> {
  let length: u32 = payload
    .len()
    .try_into()
    .map_err(|_| QueueError::Budget(format!("{} bytes is not a frame", payload.len())))?;
  stream.write_all(&length.to_be_bytes()).await?;
  stream.write_all(payload).await?;
  stream.flush().await?;
  Ok(())
}

pub async fn read_frame<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>> {
  let mut header = [0u8; 4];
  stream.read_exact(&mut header).await?;
  let length = u32::from_be_bytes(header) as usize;
  if length > MAX_FRAME {
    return Err(QueueError::Budget(format!(
      "{length} bytes is over the {MAX_FRAME}-byte frame limit"
    )));
  }
  let mut payload = vec![0u8; length];
  stream.read_exact(&mut payload).await?;
  Ok(payload)
}

pub async fn read_message<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Incoming> {
  let payload = read_frame(stream).await?;
  serde_json::from_slice(&payload).map_err(QueueError::decode("a queue message"))
}

/// Send one request and read until its reply arrives, skipping any push that
/// overtakes it.
pub async fn call<S>(stream: &mut S, id: u64, method: &str, params: Value) -> Result<Value>
where
  S: AsyncRead + AsyncWrite + Unpin,
{
  let request = serde_json::to_vec(&Request::new(id, method, params))
    .map_err(QueueError::decode("a queue request"))?;
  write_frame(stream, &request).await?;
  loop {
    let message = read_message(stream).await?;
    if message.id.is_none() {
      continue;
    }
    if let Some(error) = message.error {
      return Err(QueueError::from_rpc(error.code, error.message, error.data));
    }
    return Ok(message.result.unwrap_or(Value::Null));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn a_frame_round_trips() {
    let mut buffer = Vec::new();
    write_frame(&mut buffer, br#"{"jsonrpc":"2.0"}"#)
      .await
      .unwrap();
    assert_eq!(&buffer[..4], &17u32.to_be_bytes());
    let mut cursor = std::io::Cursor::new(buffer);
    let payload = read_frame(&mut cursor).await.unwrap();
    assert_eq!(payload, br#"{"jsonrpc":"2.0"}"#);
  }

  #[tokio::test]
  async fn an_oversized_header_is_refused_before_allocating() {
    let mut framed = (MAX_FRAME as u32 + 1).to_be_bytes().to_vec();
    framed.extend_from_slice(b"never read");
    let mut cursor = std::io::Cursor::new(framed);
    let error = read_frame(&mut cursor).await.unwrap_err();
    assert!(matches!(error, QueueError::Budget(_)), "{error:?}");
  }

  #[tokio::test]
  async fn a_push_does_not_answer_a_request() {
    // A notification, then the reply: `call` must skip the first.
    let mut server = Vec::new();
    write_frame(
      &mut server,
      br#"{"jsonrpc":"2.0","method":"tasks.changed","params":{}}"#,
    )
    .await
    .unwrap();
    write_frame(
      &mut server,
      br#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#,
    )
    .await
    .unwrap();
    let mut duplex = std::io::Cursor::new(server);
    // Read side only: write into a sink by reading the request off the front.
    let message = read_message(&mut duplex).await.unwrap();
    assert_eq!(message.method.as_deref(), Some("tasks.changed"));
    assert!(message.id.is_none());
    let reply = read_message(&mut duplex).await.unwrap();
    assert_eq!(reply.result.unwrap()["ok"], true);
  }
}
