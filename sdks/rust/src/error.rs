//! One error type for the library. Each variant knows the HTTP status and
//! the `error` code the daemon answers with, so a server handler never
//! chooses either. No web framework type appears here.

/// Everything a workbook operation can refuse or fail with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 400 `invalid_request`: the call is not shaped like it should be.
    #[error("{0}")]
    BadRequest(String),
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
    /// The file is not a workbook this library can open (wrong
    /// `application_id`, a newer `user_version`, not SQLite).
    #[error("{0}")]
    Format(String),
    /// `wait_for_approval` gave up.
    #[error("{0}")]
    Timeout(String),
    /// 402 `budget_error`: the model provider refused the call for billing
    /// (MQ-6). Retrying or continuing cannot help.
    #[error("{0}")]
    Budget(String),
    /// A target this build does not support yet (an `http(s)` URL).
    #[error("{0}")]
    Unsupported(String),
    /// 500: SQLite failed.
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    /// 500: the filesystem failed.
    #[error("{0}")]
    Io(String),
    /// 500: anything else that should not happen.
    #[error("{0}")]
    Internal(String),
}

impl Error {
    pub(crate) fn invalid(path: impl Into<String>, message: impl Into<String>) -> Self {
        Error::Invalid {
            path: path.into(),
            message: message.into(),
        }
    }

    pub(crate) fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Error::Conflict {
            code,
            message: message.into(),
        }
    }

    /// The HTTP status a server maps this error to.
    pub fn status(&self) -> u16 {
        match self {
            Error::BadRequest(_) => 400,
            Error::NotFound(_) => 404,
            Error::Conflict { .. } => 409,
            Error::TooLarge(_) => 413,
            Error::Budget(_) => 402,
            Error::Invalid { .. } | Error::HashMismatch => 422,
            Error::Unsupported(_) => 501,
            Error::Timeout(_) => 504,
            Error::Format(_) | Error::Db(_) | Error::Io(_) | Error::Internal(_) => 500,
        }
    }

    /// The `error` field of the JSON body.
    pub fn code(&self) -> &'static str {
        match self {
            Error::BadRequest(_) => "invalid_request",
            Error::NotFound(_) => "not_found",
            Error::Conflict { code, .. } => code,
            Error::TooLarge(_) => "payload_too_large",
            Error::Invalid { .. } => "invalid_payload",
            Error::HashMismatch => "hash_mismatch",
            Error::Format(_) => "invalid_workbook",
            Error::Timeout(_) => "timeout",
            Error::Budget(_) => "budget_error",
            Error::Unsupported(_) => "not_implemented",
            Error::Db(_) | Error::Io(_) | Error::Internal(_) => "internal",
        }
    }

    /// The JSON error body: `{error, message}`, plus `path` for a 422.
    pub fn body(&self) -> serde_json::Value {
        let mut body = serde_json::json!({ "error": self.code(), "message": self.to_string() });
        if let Error::Invalid { path, message } = self {
            body["path"] = serde_json::json!(path);
            body["message"] = serde_json::json!(message);
        }
        body
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
