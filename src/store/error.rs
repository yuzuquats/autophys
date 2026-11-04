//! One error type for the store and the HTTP layer. Each variant knows its
//! HTTP status and its `error` code, so a handler never chooses either. No
//! web framework type appears here; `http` turns it into a response.

/// Everything the store can refuse or fail with.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// 400 `invalid_request`: the request is not shaped like the route expects.
    #[error("{0}")]
    BadRequest(String),
    /// 401 `unauthorized`: no key, an unknown key or a revoked key.
    #[error("missing or unknown API key")]
    Unauthorized,
    /// 403 `forbidden`: a keyless write without the daemon's own Origin (O-3).
    #[error("{0}")]
    Forbidden(String),
    /// 415 `unsupported_media_type`: a keyless write that is not JSON (O-3).
    #[error("keyless writes must be Content-Type: application/json")]
    UnsupportedMediaType,
    /// 404 `not_found`.
    #[error("unknown {0}")]
    NotFound(&'static str),
    /// 409 with a specific code (`conflict`, `unknown_config_version`,
    /// `proposal_exists`, `idempotency_conflict`).
    #[error("{message}")]
    Conflict { code: &'static str, message: String },
    /// 413 `payload_too_large`.
    #[error("payload is larger than {0} bytes")]
    TooLarge(usize),
    /// 422 `invalid_payload`, with the JSON path of the offending field.
    #[error("{path}: {message}")]
    Invalid { path: String, message: String },
    /// 422 `hash_mismatch`: a config body does not hash to its version.
    #[error("sha256 of the body does not match the version")]
    HashMismatch,
    /// 400 device-flow answers from `pair_poll`: `authorization_pending`,
    /// `slow_down`, `access_denied`, `expired_token` (RFC 8628 names).
    #[error("{0}")]
    Pairing(&'static str),
    /// 500: SQLite failed.
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    /// 500: anything else that should not happen.
    #[error("{0}")]
    Internal(String),
}

impl StoreError {
    pub(crate) fn invalid(path: impl Into<String>, message: impl Into<String>) -> Self {
        StoreError::Invalid {
            path: path.into(),
            message: message.into(),
        }
    }

    pub(crate) fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        StoreError::Conflict {
            code,
            message: message.into(),
        }
    }

    /// The HTTP status this error maps to.
    pub fn status(&self) -> u16 {
        match self {
            StoreError::BadRequest(_) | StoreError::Pairing(_) => 400,
            StoreError::Unauthorized => 401,
            StoreError::Forbidden(_) => 403,
            StoreError::UnsupportedMediaType => 415,
            StoreError::NotFound(_) => 404,
            StoreError::Conflict { .. } => 409,
            StoreError::TooLarge(_) => 413,
            StoreError::Invalid { .. } | StoreError::HashMismatch => 422,
            StoreError::Db(_) | StoreError::Internal(_) => 500,
        }
    }

    /// The `error` field of the JSON body.
    pub fn code(&self) -> &'static str {
        match self {
            StoreError::BadRequest(_) => "invalid_request",
            StoreError::Unauthorized => "unauthorized",
            StoreError::Forbidden(_) => "forbidden",
            StoreError::UnsupportedMediaType => "unsupported_media_type",
            StoreError::NotFound(_) => "not_found",
            StoreError::Conflict { code, .. } => code,
            StoreError::TooLarge(_) => "payload_too_large",
            StoreError::Invalid { .. } => "invalid_payload",
            StoreError::HashMismatch => "hash_mismatch",
            StoreError::Pairing(code) => code,
            StoreError::Db(_) | StoreError::Internal(_) => "internal",
        }
    }

    /// The JSON error body: `{error, message}`, plus `path` for a 422.
    pub fn body(&self) -> serde_json::Value {
        let mut body = serde_json::json!({ "error": self.code(), "message": self.to_string() });
        if let StoreError::Invalid { path, message } = self {
            body["path"] = serde_json::json!(path);
            body["message"] = serde_json::json!(message);
        }
        body
    }
}

pub type Result<T, E = StoreError> = std::result::Result<T, E>;
