//! What can go wrong between a product and its queue.

use std::time::Duration;

use serde_json::Value;

pub type Result<T> = std::result::Result<T, QueueError>;

#[derive(Debug, thiserror::Error)]
pub enum QueueError {
  #[error("no such job: {0}")]
  NotFound(String),
  /// The queue is not answering: no socket, nothing listening, or the daemon
  /// behind `tsh serve` could not be reached. A product reports this and
  /// stays up; it is the one error that is nobody's bug.
  #[error("the job queue is unavailable: {0}")]
  Unavailable(String),
  #[error("refused: {0}")]
  Forbidden(String),
  #[error("the answer was over budget: {0}")]
  Budget(String),
  /// The request was wrong — an undeclared lane, a missing prompt, a retry of
  /// a job that is still running.
  #[error("invalid request: {0}")]
  Invalid(String),
  #[error("queue rpc {code}: {message}")]
  Rpc { code: i32, message: String },
  #[error("the queue did not answer within {0:?}")]
  Timeout(Duration),
  #[error("job queue transport: {0}")]
  Io(#[from] std::io::Error),
  #[error("decode {context}: {source}")]
  Decode {
    context: &'static str,
    #[source]
    source: serde_json::Error,
  },
}

impl QueueError {
  pub(crate) fn decode(context: &'static str) -> impl FnOnce(serde_json::Error) -> Self {
    move |source| Self::Decode { context, source }
  }

  /// Map the error record the serve contract defines. `data.kind` is the
  /// stable name; the numeric code is the fallback for a peer that predates a
  /// kind, and the plugin's own refusals arrive as invalid-params with no
  /// kind at all.
  pub(crate) fn from_rpc(code: i32, message: String, data: Option<Value>) -> Self {
    let kind = data
      .as_ref()
      .and_then(|data| data.get("kind"))
      .and_then(Value::as_str)
      .map(str::to_string);
    match kind.as_deref() {
      Some("not-found") => Self::NotFound(message),
      Some("plugin-unavailable") => Self::Unavailable(message),
      Some("forbidden") => Self::Forbidden(message),
      Some("budget") => Self::Budget(message),
      Some(_) => Self::Rpc { code, message },
      None => match code {
        -32001 => Self::NotFound(message),
        -32004 => Self::Unavailable(message),
        -32005 => Self::Forbidden(message),
        -32003 => Self::Budget(message),
        -32602 => Self::Invalid(message),
        _ => Self::Rpc { code, message },
      },
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn the_kind_names_the_error_and_the_code_is_the_fallback() {
    let unavailable = QueueError::from_rpc(
      -32004,
      "tsh-agent-queue is not mounted".into(),
      Some(json!({"kind": "plugin-unavailable"})),
    );
    assert!(matches!(unavailable, QueueError::Unavailable(_)));
    assert!(matches!(
      QueueError::from_rpc(-32001, "gone".into(), None),
      QueueError::NotFound(_)
    ));
    // The daemon's own refusals: invalid params, no kind.
    assert!(matches!(
      QueueError::from_rpc(-32602, "unknown lane 'news'".into(), None),
      QueueError::Invalid(_)
    ));
    // A kind this crate does not know stays an rpc error rather than a lie.
    assert!(matches!(
      QueueError::from_rpc(
        -32002,
        "session is not live".into(),
        Some(json!({"kind": "not-live"}))
      ),
      QueueError::Rpc { .. }
    ));
  }
}
