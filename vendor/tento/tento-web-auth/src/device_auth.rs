use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tento_openapi::ToSchema;

use crate::LoggedInViewerContext;

#[derive(Clone, Debug)]
pub struct DeviceRequestContext {
  pub scheme: String,
  pub host: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStartRequest {
  pub scopes: Option<Vec<String>>,
  pub token_ttl_seconds: Option<u64>,
  pub label: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStartResponse {
  pub device_code: String,
  pub user_code: String,
  pub verification_url: String,
  pub verification_url_complete: Option<String>,
  pub expires_in_seconds: u64,
  pub interval_seconds: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollRequest {
  pub device_code: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DevicePollStatus {
  AuthorizationPending,
  SlowDown,
  ExpiredToken,
  AccessDenied,
  Ok,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollResponse {
  pub status: DevicePollStatus,
  pub api_token: Option<String>,
  pub token_type: Option<String>,
  pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeviceVerifyRequest {
  pub user_code: String,
  /// Optional subject selected by the caller; delegates must reject a mismatch.
  /// Legacy terminal callers may omit it; browser account choosers should bind it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub expected_user_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeviceVerifyResponse {
  pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthErrorResponse {
  pub error: String,
  pub error_description: String,
}

#[derive(Clone, Debug)]
pub enum DeviceAuthErrorKind {
  InvalidRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  TooManyRequests,
  Conflict,
  Internal,
}

#[derive(Clone, Debug)]
pub struct DeviceAuthError {
  pub kind: DeviceAuthErrorKind,
  pub code: String,
  pub description: String,
}

impl DeviceAuthError {
  pub fn invalid_request(code: impl Into<String>, description: impl Into<String>) -> Self {
    Self {
      kind: DeviceAuthErrorKind::InvalidRequest,
      code: code.into(),
      description: description.into(),
    }
  }

  pub fn internal(code: impl Into<String>, description: impl Into<String>) -> Self {
    Self {
      kind: DeviceAuthErrorKind::Internal,
      code: code.into(),
      description: description.into(),
    }
  }
}

pub trait DeviceAuthDelegate: Send + Sync {
  fn start(
    &self,
    context: DeviceRequestContext,
    req: DeviceStartRequest,
  ) -> BoxFuture<'_, Result<DeviceStartResponse, DeviceAuthError>>;
  fn poll(
    &self,
    req: DevicePollRequest,
  ) -> BoxFuture<'_, Result<DevicePollResponse, DeviceAuthError>>;
  fn verify(
    &self,
    viewer: LoggedInViewerContext,
    req: DeviceVerifyRequest,
  ) -> BoxFuture<'_, Result<DeviceVerifyResponse, DeviceAuthError>>;
}

#[cfg(test)]
mod subject_binding_tests {
  use super::DeviceVerifyRequest;

  #[test]
  fn legacy_verification_can_omit_subject_but_mobile_preserves_it() {
    let legacy: DeviceVerifyRequest = serde_json::from_str(r#"{"userCode":"ABCD-EFGH"}"#).unwrap();
    assert!(legacy.expected_user_id.is_none());
    let mobile: DeviceVerifyRequest =
      serde_json::from_str(r#"{"userCode":"ABCD-EFGH","expectedUserId":"account-a"}"#).unwrap();
    assert_eq!(mobile.expected_user_id.as_deref(), Some("account-a"));
    assert_eq!(
      serde_json::to_value(mobile).unwrap()["expectedUserId"],
      "account-a"
    );
  }

  #[test]
  fn malformed_subject_is_not_silently_ignored() {
    assert!(
      serde_json::from_str::<DeviceVerifyRequest>(
        r#"{"userCode":"ABCD-EFGH","expectedUserId":123}"#
      )
      .is_err()
    );
  }
}
