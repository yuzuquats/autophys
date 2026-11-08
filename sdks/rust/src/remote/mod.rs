//! Async HTTP transport for the daemon's /api/v1, matching Python HttpStore.
//!
//! This is the one transport (tokio, through `reqwest`). Synchronous callers
//! (the CLI, the investigation loop, scripts, [`crate::Workbook`]) use the
//! thin facade [`crate::blocking::Remote`], which drives these futures.
pub mod auth;
mod stream;
mod workbook;
use crate::{Appended, Error, InvestigationInfo, Project, Proposal, Record, Result};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
pub use stream::{RecordStream, Sse, StreamEvent};

pub const API_PREFIX: &str = "/api/v1";
pub const USER_AGENT: &str = "autophys-rust/0.1";

/// The wire error, including the unmodified Retry-After header and optional 422 path.
#[derive(Clone, Debug, thiserror::Error)]
#[error("HTTP {status} {error}: {message}")]
pub struct HttpError {
    pub status: u16,
    pub error: String,
    pub message: String,
    pub retry_after: Option<String>,
    pub path: Option<String>,
}
impl HttpError {
    pub fn new(status: u16, error: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            error: error.into(),
            message: message.into(),
            retry_after: None,
            path: None,
        }
    }
    /// Python AuthError's classification; a denied pairing remains an ordinary HttpError.
    pub fn is_auth(&self) -> bool {
        matches!(self.status, 401 | 403) && self.error != "access_denied"
    }
}
impl From<HttpError> for Error {
    fn from(e: HttpError) -> Self {
        Self::Http(Box::new(e))
    }
}

/// RS-REMOTE-2: a daemon without a feature's endpoint is an error saying to
/// upgrade the daemon, never a silent skip or fallback. The daemon answers an
/// unknown route with 404 `unknown route` (older builds: an empty body) or
/// 405; a 404 naming a resource, such as `unknown investigation`, is left as
/// it is. Mirrors the Python SDK's `_route_missing`/`_daemon_too_old`.
pub(crate) fn daemon_too_old(e: Error, feature: &str) -> Error {
    match e {
        Error::Http(mut h)
            if h.status == 405
                || (h.status == 404 && (h.message.is_empty() || h.message == "unknown route")) =>
        {
            h.message = format!(
                "the daemon is too old for {feature} (no endpoint); upgrade the autophys daemon"
            );
            Error::Http(h)
        }
        e => e,
    }
}

/// Cheap to clone; investigation cursors and diagnostic wait mode are shared.
/// Methods are `async` and need a tokio runtime (I/O and time enabled).
#[derive(Clone)]
pub struct Remote {
    client: reqwest::Client,
    base: String,
    key: Arc<String>,
    pub timeout: Duration,
    pub stream_idle: Duration,
    cursors: Arc<Mutex<HashMap<String, i64>>>,
    last_wait: Arc<Mutex<Option<&'static str>>>,
}
impl std::fmt::Debug for Remote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Remote").field(&self.base).finish()
    }
}
pub(crate) fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::Io("invalid daemon response".into()))
}
pub(crate) fn encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
pub(crate) fn normalize_server(server: &str) -> Result<String> {
    let bad = || Error::BadRequest("invalid daemon URL".into());
    if server.chars().any(char::is_whitespace) || server.contains(['?', '#', '\\']) { return Err(bad()); }
    let (scheme, rest) = server.split_once("://").ok_or_else(bad)?;
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") { return Err(bad()); }
    let text = format!("{scheme}://{rest}");
    let uri: http::Uri = text.parse().map_err(|_| bad())?;
    let authority = uri.authority().ok_or_else(bad)?;
    if authority.as_str().contains('@') || !authority.as_str().is_ascii() { return Err(bad()); }
    let host = uri.host().filter(|s| !s.is_empty()).ok_or_else(bad)?.to_ascii_lowercase();
    // Authority::port() discards invalid/out-of-range text, just like port_u16().
    // Inspect the explicit suffix first, keeping IPv6 colons inside the brackets.
    let authority_text = authority.as_str();
    let port_text = if authority_text.starts_with('[') {
        authority_text.split_once(']').and_then(|(_, tail)| tail.strip_prefix(':'))
    } else {
        authority_text.split_once(':').map(|(_, port)| port)
    };
    let port = match port_text.filter(|text| !text.is_empty()) {
        Some(text) if text.bytes().all(|b| b.is_ascii_digit()) => {
            Some(text.parse::<u16>().map_err(|_| bad())?)
        }
        Some(_) => return Err(bad()),
        None => None,
    };
    let port = port.filter(|p| *p != if scheme == "http" {80} else {443});
    Ok(format!("{scheme}://{host}{}{}", port.map(|p|format!(":{p}")).unwrap_or_default(), uri.path().trim_end_matches('/')))
}
/// How long the facade's pooled client keeps an idle connection: below the
/// daemon's keep-alive (actix-web's default, 5 s). A connection the server
/// closes while a request is being written on it fails that request, and a
/// written request is not retried, so the client must drop idle connections
/// before the server does. Connections through a proxy with a shorter idle
/// limit than this can still meet that race.
const POOL_IDLE: Duration = Duration::from_secs(4);

/// The process-wide pooled client, used only by requests running on the
/// blocking facade's runtime (RS-REMOTE-1-d). A hyper connection is driven
/// by a task on the runtime that opened it, so a pooled connection is only
/// safe on a runtime that outlives it; the facade's runtime is never shut
/// down. `None` if it cannot be built (callers then use the unpooled client).
fn facade_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .pool_idle_timeout(POOL_IDLE)
                .build()
                .ok()
        })
        .as_ref()
}

impl Remote {
    pub fn new(server: &str, api_key: &str) -> Result<Self> {
        let server = normalize_server(server)?;
        // For the async API on the caller's runtime: no idle pool, so a
        // connection never outlives the runtime that opened it (a caller's
        // `#[tokio::test]` or short-lived runtime). Blocking-facade calls use
        // `facade_client()` instead, which reuses connections.
        // TLS: reqwest takes rustls's process-default CryptoProvider if one is
        // installed, else ring; the workspace enables both ring and aws-lc-rs,
        // so never rely on rustls's crate-feature default (ambiguous here).
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|_| Error::Io("cannot start HTTP client".into()))?;
        Ok(Self {
            client,
            base: format!("{}{API_PREFIX}", server.trim_end_matches('/')),
            key: Arc::new(api_key.into()),
            timeout: Duration::from_secs(30),
            stream_idle: Duration::from_secs(30),
            cursors: Arc::new(Mutex::new(HashMap::new())),
            last_wait: Arc::new(Mutex::new(None)),
        })
    }
    pub fn base(&self) -> &str {
        &self.base
    }
    pub fn cursor(&self, inv: &str) -> i64 {
        self.cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(inv)
            .copied()
            .unwrap_or(0)
    }
    pub fn last_wait(&self) -> Option<&'static str> {
        *self.last_wait.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn set_last_wait(&self, mode: &'static str) {
        *self.last_wait.lock().unwrap_or_else(|e| e.into_inner()) = Some(mode);
    }
    fn see(&self, inv: &str, gseq: i64) {
        let mut map = self.cursors.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(inv.into()).or_default();
        *entry = (*entry).max(gseq);
    }
    /// The client for a request on the current runtime: the pooled facade
    /// client on the facade's runtime, else this Remote's unpooled one.
    fn http(&self) -> &reqwest::Client {
        if crate::blocking::on_facade_runtime() {
            if let Some(client) = facade_client() {
                return client;
            }
        }
        &self.client
    }
    pub(crate) async fn response(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        content_type: &str,
        key: Option<&str>,
        timeout: Duration,
        stream: bool,
    ) -> Result<reqwest::Response> {
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| Error::BadRequest("invalid HTTP request".into()))?;
        // One absolute budget also bounds keep-alives and trickling SSE frames.
        let mut req = self
            .http()
            .request(method, format!("{}{}", self.base, path))
            .timeout(timeout)
            .header(
                "Accept",
                if stream {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            )
            .header("User-Agent", USER_AGENT);
        if !self.key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.key));
        }
        if let Some(key) = key {
            req = req.header("Idempotency-Key", key);
        }
        if let Some(body) = body {
            req = req.header("Content-Type", content_type).body(body.to_vec());
        }
        let resp = req
            .send()
            .await
            .map_err(|_| Error::Io("daemon request failed".into()))?;
        if resp.status().as_u16() >= 400 {
            let status = resp.status().as_u16();
            let retry_after = resp
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let j = read_limited(resp, 1024 * 1024)
                .await
                .ok()
                .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
                .unwrap_or(Value::Null);
            let mut err = HttpError::new(
                status,
                j["error"].as_str().unwrap_or("http_error"),
                j["message"].as_str().unwrap_or(""),
            );
            err.retry_after = retry_after;
            err.path = j["path"].as_str().map(str::to_owned);
            return Err(err.into());
        }
        Ok(resp)
    }
    pub(crate) async fn bytes(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        content_type: &str,
        key: Option<&str>,
        timeout: Duration,
    ) -> Result<(u16, Value)> {
        let resp = self
            .response(method, path, body, content_type, key, timeout, false)
            .await?;
        let status = resp.status().as_u16();
        let raw = read_limited(resp, 64 * 1024 * 1024)
            .await
            .map_err(|_| Error::Io("cannot read daemon response".into()))?;
        Ok((
            status,
            if raw.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&raw)
                    .map_err(|_| Error::Io("invalid daemon JSON response".into()))?
            },
        ))
    }
    pub(crate) async fn json(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        key: Option<&str>,
        timeout: Duration,
    ) -> Result<(u16, Value)> {
        let text = body.map(crate::canonical);
        self.bytes(
            method,
            path,
            text.as_deref().map(str::as_bytes),
            "application/json",
            key,
            timeout,
        )
        .await
    }
    pub async fn projects(&self) -> Result<Vec<Project>> {
        decode(self.json("GET", "/projects", None, None, self.timeout).await?.1["projects"].take())
    }
    pub async fn ensure_project(&self, name: &str) -> Result<(Project, bool)> {
        let (status, mut j) = self.json(
            "POST",
            "/projects",
            Some(&json!({"name":name})),
            None,
            self.timeout,
        ).await?;
        Ok((decode(j["project"].take())?, status == 201))
    }
    pub async fn investigations(&self, project: Option<&str>) -> Result<Vec<InvestigationInfo>> {
        let path = project
            .map(|p| format!("/investigations?project={}", encode(p)))
            .unwrap_or_else(|| "/investigations".into());
        decode(self.json("GET", &path, None, None, self.timeout).await?.1["investigations"].take())
    }
    pub async fn records(&self, inv: &str, kind: Option<&str>) -> Result<Vec<Record>> {
        let mut path = format!("/investigations/{}/records", encode(inv));
        if let Some(kind) = kind {
            path.push_str(&format!("?kind={}", encode(kind)));
        }
        decode(self.json("GET", &path, None, None, self.timeout).await?.1["records"].take())
    }
    pub async fn proposal(&self, inv: &str, pid: &str) -> Result<Proposal> {
        self.proposal_with_timeout(inv, pid, self.timeout).await
    }
    async fn proposal_with_timeout(&self, inv: &str, pid: &str, timeout: Duration) -> Result<Proposal> {
        decode(
            self.json(
                "GET",
                &format!("/investigations/{}/proposals/{}", encode(inv), encode(pid)),
                None,
                None,
                timeout,
            ).await?
            .1,
        )
    }
    pub async fn append(
        &self,
        inv: &str,
        kind: &str,
        payload: Value,
        id: Option<&str>,
    ) -> Result<Appended> {
        let id = id
            .map(str::to_owned)
            .map(Ok)
            .unwrap_or_else(|| crate::workbook::random_hex(16))?;
        let endpoint = match kind {
            "measurement" => "measurements".into(),
            "run" => "runs".into(),
            "step" => "steps".into(),
            "outcome" => "outcome".into(),
            "reveal" => "reveal".into(),
            "proposal" => {
                let pid = payload["proposal_id"]
                    .as_str()
                    .ok_or_else(|| Error::invalid("payload.proposal_id", "required string"))?;
                match payload["event"].as_str().unwrap_or("") {
                    "proposed" | "withdrawn" => "proposals".into(),
                    "approved" | "edited" | "rejected" => {
                        format!("proposals/{}/approvals", encode(pid))
                    }
                    "data_attached" => format!("proposals/{}/data", encode(pid)),
                    ev => return Err(Error::BadRequest(format!("unknown proposal event {ev}"))),
                }
            }
            _ => {
                return Err(Error::BadRequest(format!(
                    "kind {kind:?} is not uploaded through HttpStore"
                )));
            }
        };
        let (status, mut j) = self.json(
            "POST",
            &format!("/investigations/{}/{endpoint}", encode(inv)),
            Some(&json!({"id":id,"kind":kind,"payload":payload})),
            Some(&id),
            self.timeout,
        ).await.map_err(|e| if kind == "reveal" { daemon_too_old(e, "reveal records") } else { e })?;
        let gseq = j["gseq"]
            .as_i64()
            .ok_or_else(|| Error::Io("invalid daemon gseq".into()))?;
        self.see(inv, gseq);
        Ok(Appended {
            record: decode(j["record"].take())?,
            gseq,
            created: status == 201,
        })
    }
}

/// Read a whole body, refusing one larger than `limit` bytes.
pub(crate) async fn read_limited(
    mut resp: reqwest::Response,
    limit: usize,
) -> std::result::Result<Vec<u8>, ()> {
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| ())? {
        if out.len() + chunk.len() > limit {
            return Err(());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
