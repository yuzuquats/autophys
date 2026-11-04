use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/**
 * rpc_type:
 *   0: Ping
 *   1: Pong
 *   1: RPC request
 *   2: RPC response
 *
 * Rpc:
 *   [message_type] 1-byte
 *   ...Message
 *
 * Message (message_type = 0):
 *   null
 *
 * Message (message_type = 1):
 *   null
 *
 * Message (message_type = 2):
 *   [rpc_id] 8-bytes
 *   [rpc-message-length] 4-bytes
 *   [rpc-contents] {rpc-message-length}-bytes
 *
 * Message (message_type = 3):
 *   [rpc_id] 8-bytes
 *   [rpc-message-length] 4-bytes
 *   [rpc-contents] {rpc-message-length}-bytes
 *
 */
#[derive(Debug)]
pub(crate) enum Message {
  Ping,
  Pong,
  RpcRequest { id: u64, inner: RpcRequest },
  RpcResponse(RpcResponse),
}

impl Message {
  pub async fn send_to<Receiver>(&self, rx: &mut Receiver) -> anyhow::Result<()>
  where
    Receiver: AsyncWriteExt + std::marker::Unpin,
  {
    match self {
      Message::Ping => {
        // Send a ping message (type 0)
        rx.write_all(&[0])
          .await
          .context("Failed to write ping message type")?;
      }
      Message::Pong => {
        // Send a pong message (type 1)
        rx.write_all(&[1])
          .await
          .context("Failed to write pong message type")?;
      }
      Message::RpcRequest { id, inner } => {
        // Send an RPC request (type 2)
        rx.write_all(&[2])
          .await
          .context("Failed to write RPC message type")?;
        // Pass the rest to the RpcRequest implementation
        inner.send(rx, *id).await?;
      }
      Message::RpcResponse(response) => {
        // Send an RPC response (type 3)
        rx.write_all(&[3])
          .await
          .context("Failed to write RPC response message type")?;

        // Write the response ID
        rx.write_all(&response.id.to_be_bytes())
          .await
          .context("Failed to write response ID")?;

        // Serialize the response value
        let response_json =
          serde_json::to_vec(&response.response).context("Failed to serialize response")?;
        let response_len = response_json.len() as u32;

        // Write the response length
        rx.write_all(&response_len.to_be_bytes())
          .await
          .context("Failed to write response length")?;

        // Write the response content
        rx.write_all(&response_json)
          .await
          .context("Failed to write response content")?;
      }
    }
    rx.flush().await.context("Failed to flush output")?;
    Ok(())
  }

  pub async fn read<Sender>(tx: &mut Sender) -> anyhow::Result<Message>
  where
    Sender: AsyncReadExt + std::marker::Unpin,
  {
    let mut message_type_buf = [0u8; 1];
    tx.read_exact(&mut message_type_buf)
      .await
      .context("Failed to read message type")?;
    // println!("[parent] message_type {}", message_type_buf[0]);

    match message_type_buf[0] {
      0 => {
        // Ping message
        Ok(Message::Ping)
      }
      1 => {
        // Pong Message
        Ok(Message::Pong)
      }
      2 => {
        // RPC request
        let (id, request) = RpcRequest::read(tx).await?;
        Ok(Message::RpcRequest { id, inner: request })
      }
      3 => {
        // RPC response
        let response = RpcResponse::read(tx).await?;
        Ok(Message::RpcResponse(response))
      }
      _ => Err(anyhow!("Unknown message type: {}", message_type_buf[0])),
    }
  }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RpcRequest {
  pub method: String,
  pub params: Value,
}

impl RpcRequest {
  pub async fn send<Receiver>(&self, rx: &mut Receiver, id: u64) -> anyhow::Result<()>
  where
    Receiver: AsyncWriteExt + std::marker::Unpin,
  {
    let json = serde_json::to_string(self).context("couldn't serialize request")?;

    let request_bytes = json.as_bytes();
    let request_len = request_bytes.len() as u32;

    rx.write_all(&id.to_be_bytes())
      .await
      .context("Failed to write RPC ID")?;

    rx.write_all(&request_len.to_be_bytes())
      .await
      .context("Failed to write request length")?;

    rx.write_all(request_bytes)
      .await
      .context("Failed to write request body")?;

    rx.flush().await.context("Failed to flush stdin")?;

    Ok(())
  }

  pub async fn read<Sender>(tx: &mut Sender) -> anyhow::Result<(u64, RpcRequest)>
  where
    Sender: AsyncReadExt + std::marker::Unpin,
  {
    let mut id_buf = [0u8; 8];
    tx.read_exact(&mut id_buf)
      .await
      .context("Failed to read RPC ID")?;
    let id = u64::from_be_bytes(id_buf);

    let mut len_buf = [0u8; 4];
    tx.read_exact(&mut len_buf)
      .await
      .context("Failed to read message length")?;
    let len = u32::from_be_bytes(len_buf);

    let mut content_buf = vec![0u8; len as usize];
    tx.read_exact(&mut content_buf)
      .await
      .context("Failed to read message content")?;

    let response: RpcRequest =
      serde_json::from_slice(&content_buf).context("Failed to deserialize RPC response")?;

    Ok((id, response))
  }
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct RpcResponse {
  pub id: u64,
  pub response: serde_json::Value,
}

impl RpcResponse {
  pub async fn read<Sender>(tx: &mut Sender) -> anyhow::Result<RpcResponse>
  where
    Sender: AsyncReadExt + std::marker::Unpin,
  {
    // Response ID
    let mut response_id_bytes = [0u8; 8];
    tx.read_exact(&mut response_id_bytes)
      .await
      .context("Failed to read response id")?;
    let response_id = u64::from_be_bytes(response_id_bytes);

    // Response Len
    let mut response_len_bytes = [0u8; 4];
    tx.read_exact(&mut response_len_bytes)
      .await
      .context("Failed to read response length")?;
    let response_len = u32::from_be_bytes(response_len_bytes);

    // Response
    let mut response_bytes = vec![0u8; response_len as usize];
    tx.read_exact(&mut response_bytes)
      .await
      .context("Failed to read response body")?;

    let response: serde_json::Value =
      serde_json::from_slice(&response_bytes).context("Failed to deserialize RPC response")?;
    Ok(RpcResponse {
      id: response_id,
      response,
    })
  }
}
