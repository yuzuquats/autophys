#[cfg(test)]
mod tests {
  use crate::subprocess::message::{Message, RpcRequest};
  use std::io::Cursor;

  // Helper function to serialize a Message to a buffer
  async fn serialize_message(message: &Message) -> anyhow::Result<Vec<u8>> {
    let mut buffer = Vec::new();
    let mut cursor = Cursor::new(&mut buffer);
    message.send_to(&mut cursor).await?;
    Ok(cursor.into_inner().to_vec())
  }

  // Helper function to deserialize a Message from a buffer
  async fn deserialize_message(buffer: Vec<u8>) -> anyhow::Result<Message> {
    let mut cursor = Cursor::new(buffer);
    Message::read(&mut cursor).await
  }

  #[tokio::test]
  async fn test_ping_message() -> anyhow::Result<()> {
    // Test ping message serialization
    let ping = Message::Ping;
    let buffer = serialize_message(&ping).await?;

    // Verify frame format
    assert_eq!(buffer.len(), 1, "Ping message should be 1 byte");
    assert_eq!(buffer[0], 0, "Ping message type should be 0");

    // Test ping message deserialization
    let received = deserialize_message(buffer).await?;
    match received {
      Message::Ping => Ok(()),
      _ => Err(anyhow::anyhow!("Expected Ping message, got {:?}", received)),
    }
  }

  #[tokio::test]
  async fn test_rpc_request_message() -> anyhow::Result<()> {
    // Create test request
    let request = RpcRequest {
      method: "test_method".to_string(),
      params: serde_json::json!({"key": "value"}),
    };
    let request_id = 42;
    let rpc_request = Message::RpcRequest {
      id: request_id,
      inner: request.clone(),
    };

    // Serialize the request
    let buffer = serialize_message(&rpc_request).await?;

    // Verify frame format
    assert!(
      buffer.len() > 13,
      "RPC request message should be more than 13 bytes"
    );
    assert_eq!(buffer[0], 2, "RPC request message type should be 2");

    // Extract id from buffer (bytes 1-8)
    let mut id_bytes = [0u8; 8];
    id_bytes.copy_from_slice(&buffer[1..9]);
    let id = u64::from_be_bytes(id_bytes);
    assert_eq!(id, request_id, "Request ID should match");

    // Extract length from buffer (bytes 9-12)
    let mut len_bytes = [0u8; 4];
    len_bytes.copy_from_slice(&buffer[9..13]);
    let len = u32::from_be_bytes(len_bytes);

    // Check that the length matches the rest of the buffer
    assert_eq!(
      len as usize,
      buffer.len() - 13,
      "Message length should match"
    );

    // Deserialize the request
    let received = deserialize_message(buffer).await?;
    match received {
      Message::RpcRequest { id, inner } => {
        assert_eq!(id, request_id, "Request ID should match");
        assert_eq!(inner.method, request.method, "Method should match");
        assert_eq!(inner.params, request.params, "Params should match");
        Ok(())
      }
      _ => Err(anyhow::anyhow!(
        "Expected RpcRequest message, got {:?}",
        received
      )),
    }
  }

  #[tokio::test]
  async fn test_rpc_response_deserialization() -> anyhow::Result<()> {
    // Create a response buffer manually
    let response_id: u64 = 123;
    let response_json = r#"{"result":"success"}"#; // Response content is just the value
    let response_bytes = response_json.as_bytes();
    let response_len = response_bytes.len() as u32;

    // The Message::RpcResponse variant has frame format:
    // [message_type=3] + [id (8 bytes)] + [rpc-message-length (4 bytes)] + [rpc-contents]
    let mut buffer = Vec::new();
    buffer.push(3); // Message type 3 for RPC response

    // Add the response ID bytes
    buffer.extend_from_slice(&response_id.to_be_bytes()); // Response ID
    buffer.extend_from_slice(&response_len.to_be_bytes()); // Length
    buffer.extend_from_slice(response_bytes); // Content

    // Deserialize the response
    let received = deserialize_message(buffer).await?;
    match received {
      Message::RpcResponse(response) => {
        assert_eq!(response.id, response_id, "Response ID should match");
        assert_eq!(
          response.response.get("result").and_then(|v| v.as_str()),
          Some("success"),
          "Response should contain expected result"
        );
        Ok(())
      }
      _ => Err(anyhow::anyhow!(
        "Expected RpcResponse message, got {:?}",
        received
      )),
    }
  }

  #[tokio::test]
  async fn test_round_trip_rpc_request() -> anyhow::Result<()> {
    // Create a complex request
    let request = RpcRequest {
      method: "complex.method".to_string(),
      params: serde_json::json!({
        "nested": {
          "array": [1, 2, 3],
          "bool": true,
          "null": null
        },
        "string": "value with spaces and special chars: !@#$%^&*()"
      }),
    };
    let request_id = 987654321;
    let rpc_request = Message::RpcRequest {
      id: request_id,
      inner: request,
    };

    // Serialize and then deserialize
    let buffer = serialize_message(&rpc_request).await?;
    let received = deserialize_message(buffer).await?;

    // Verify round-trip correctness
    match received {
      Message::RpcRequest { id, inner } => {
        assert_eq!(id, request_id, "Request ID should be preserved");
        assert_eq!(inner.method, "complex.method", "Method should be preserved");

        // Check nested structure
        let nested = inner.params.get("nested").expect("nested missing");
        assert!(nested.is_object(), "nested should be an object");

        let array = nested.get("array").expect("array missing");
        assert!(array.is_array(), "array should be an array");
        assert_eq!(
          array.as_array().unwrap().len(),
          3,
          "array should have 3 elements"
        );

        assert_eq!(
          nested.get("bool").and_then(|v| v.as_bool()),
          Some(true),
          "bool should be true"
        );

        assert!(nested.get("null").unwrap().is_null(), "null should be null");

        // Check string with special characters
        let string = inner.params.get("string").expect("string missing");
        assert!(string.is_string(), "string should be a string");
        assert!(
          string.as_str().unwrap().contains("special chars"),
          "string should contain the expected content"
        );

        Ok(())
      }
      _ => Err(anyhow::anyhow!(
        "Expected RpcRequest message, got something else"
      )),
    }
  }

  #[tokio::test]
  async fn test_invalid_message_type() -> anyhow::Result<()> {
    // Create a buffer with invalid message type
    let mut buffer = Vec::new();
    buffer.push(99); // Invalid message type

    // Attempt to deserialize
    let result = deserialize_message(buffer).await;
    assert!(
      result.is_err(),
      "Deserializing invalid message type should fail"
    );

    // Check error message
    if let Err(err) = result {
      assert!(
        err.to_string().contains("Unknown message type"),
        "Error should mention unknown message type"
      );
    }

    Ok(())
  }

  #[tokio::test]
  async fn test_truncated_messages() -> anyhow::Result<()> {
    // 1. Test truncated ping
    let ping_buffer = Vec::new(); // Empty buffer
    let ping_result = deserialize_message(ping_buffer).await;
    assert!(
      ping_result.is_err(),
      "Deserializing truncated ping should fail"
    );

    // 2. Test truncated RPC request (header only)
    let mut req_buffer = Vec::new();
    req_buffer.push(2); // Message type 2 for RPC request
    req_buffer.extend_from_slice(&42u64.to_be_bytes()); // ID
    // Missing length and content

    let req_result = deserialize_message(req_buffer).await;
    assert!(
      req_result.is_err(),
      "Deserializing truncated request should fail"
    );

    // 3. Test truncated RPC request (partial content)
    let mut req_buffer2 = Vec::new();
    req_buffer2.push(2); // Message type 2 for RPC request
    req_buffer2.extend_from_slice(&42u64.to_be_bytes()); // ID
    req_buffer2.extend_from_slice(&100u32.to_be_bytes()); // Length of 100
    req_buffer2.extend_from_slice(&[0; 50]); // Only 50 bytes of content (not 100)

    let req_result2 = deserialize_message(req_buffer2).await;
    assert!(
      req_result2.is_err(),
      "Deserializing truncated request content should fail"
    );

    Ok(())
  }

  #[tokio::test]
  async fn test_malformed_json() -> anyhow::Result<()> {
    // Create an RPC request message with invalid JSON content
    let request_id: u64 = 42;
    let malformed_json = r#"{"method":"test","params":invalid_json}"#;
    let malformed_len = malformed_json.len() as u32;

    let mut buffer = Vec::new();
    buffer.push(2); // Message type 2 for RPC request
    buffer.extend_from_slice(&request_id.to_be_bytes()); // ID
    buffer.extend_from_slice(&malformed_len.to_be_bytes()); // Length
    buffer.extend_from_slice(malformed_json.as_bytes()); // Malformed content

    // Attempt to deserialize
    let result = deserialize_message(buffer).await;
    assert!(result.is_err(), "Deserializing malformed JSON should fail");

    // Check error message
    if let Err(err) = result {
      assert!(
        err.to_string().contains("deserialize"),
        "Error should mention deserialization failure"
      );
    }

    Ok(())
  }
}
