//! The daemon's error: the library's [`autophys::Error`] plus what only a
//! server refuses (keys, the browser guard, pairing answers). Each variant
//! knows its HTTP status and `error` code; `http` turns it into a response.

/// Everything an `/api/v1` handler, the key store or the admin CLI can fail with.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// A workbook call refused or failed; its own status and code apply.
    #[error(transparent)]
    Lib(#[from] autophys::Error),
    /// 401 `unauthorized`: no key, an unknown key or a revoked key.
    #[error("missing or unknown API key")]
    Unauthorized,
    /// 403 `forbidden`: a keyless write without the daemon's own Origin (O-3).
    #[error("{0}")]
    Forbidden(String),
    /// 415 `unsupported_media_type`: a keyless write that is not JSON (O-3).
    #[error("keyless writes must be Content-Type: application/json")]
    UnsupportedMediaType,
    /// 400 device-flow answers from `pair_poll`: `authorization_pending`,
    /// `slow_down`, `access_denied`, `expired_token` (RFC 8628 names).
    #[error("{0}")]
    Pairing(&'static str),
    /// 500: the server database failed.
    #[error("server database: {0}")]
    Db(#[from] rusqlite::Error),
    /// 500: anything else that should not happen.
    #[error("{0}")]
    Internal(String),
}

impl ApiError {
    /// 400 `invalid_request`.
    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError::Lib(autophys::Error::BadRequest(message.into()))
    }

    /// 422 `invalid_payload` at `path`.
    pub fn invalid(path: impl Into<String>, message: impl Into<String>) -> Self {
        ApiError::Lib(autophys::Error::Invalid {
            path: path.into(),
            message: message.into(),
        })
    }

    /// 404 `not_found`.
    pub fn not_found(what: &'static str) -> Self {
        ApiError::Lib(autophys::Error::NotFound(what))
    }

    /// 413 `payload_too_large`.
    pub fn too_large(limit: usize) -> Self {
        ApiError::Lib(autophys::Error::TooLarge(limit))
    }

    /// The HTTP status this error maps to.
    pub fn status(&self) -> u16 {
        match self {
            ApiError::Lib(e) => e.status(),
            ApiError::Pairing(_) => 400,
            ApiError::Unauthorized => 401,
            ApiError::Forbidden(_) => 403,
            ApiError::UnsupportedMediaType => 415,
            ApiError::Db(_) | ApiError::Internal(_) => 500,
        }
    }

    /// The `error` field of the JSON body.
    pub fn code(&self) -> &'static str {
        match self {
            ApiError::Lib(e) => e.code(),
            ApiError::Unauthorized => "unauthorized",
            ApiError::Forbidden(_) => "forbidden",
            ApiError::UnsupportedMediaType => "unsupported_media_type",
            ApiError::Pairing(code) => code,
            ApiError::Db(_) | ApiError::Internal(_) => "internal",
        }
    }

    /// The JSON error body: `{error, message}`, plus `path` for a 422.
    pub fn body(&self) -> serde_json::Value {
        match self {
            ApiError::Lib(e) => e.body(),
            _ => serde_json::json!({ "error": self.code(), "message": self.to_string() }),
        }
    }
}

pub type Result<T, E = ApiError> = std::result::Result<T, E>;
