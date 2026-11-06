//! Blocking HTTP transport for the daemon's /api/v1, matching Python HttpStore.
pub mod auth;
mod stream;
mod workbook;
use crate::{Appended, Error, InvestigationInfo, Project, Proposal, Record, Result};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
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

/// Cheap to clone; investigation cursors and diagnostic wait mode are shared.
#[derive(Clone)]
pub struct Remote {
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
    let uri: ureq::http::Uri = text.parse().map_err(|_| bad())?;
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
impl Remote {
    pub fn new(server: &str, api_key: &str) -> Result<Self> {
        let server = normalize_server(server)?;
        Ok(Self {
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
    fn see(&self, inv: &str, gseq: i64) {
        let mut map = self.cursors.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(inv.into()).or_default();
        *entry = (*entry).max(gseq);
    }
    pub(crate) fn response(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        content_type: &str,
        key: Option<&str>,
        timeout: Duration,
        stream: bool,
    ) -> Result<ureq::http::Response<ureq::Body>> {
        // One absolute budget also bounds keep-alives and trickling SSE frames.
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(timeout))
            .timeout_recv_body(Some(if stream {
                self.stream_idle.min(timeout)
            } else {
                timeout
            }))
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let mut req = ureq::http::Request::builder()
            .method(method)
            .uri(format!("{}{}", self.base, path))
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
        if body.is_some() {
            req = req.header("Content-Type", content_type);
        }
        let request = req
            .body(body.unwrap_or_default())
            .map_err(|_| Error::BadRequest("invalid HTTP request".into()))?;
        let mut resp = agent
            .run(request)
            .map_err(|_| Error::Io("daemon request failed".into()))?;
        if resp.status().as_u16() >= 400 {
            let status = resp.status().as_u16();
            let retry_after = resp
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let j = resp
                .body_mut()
                .read_to_vec()
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
    pub(crate) fn bytes(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        content_type: &str,
        key: Option<&str>,
        timeout: Duration,
    ) -> Result<(u16, Value)> {
        let mut resp = self.response(method, path, body, content_type, key, timeout, false)?;
        let status = resp.status().as_u16();
        let raw = resp
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_vec()
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
    pub(crate) fn json(
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
    }
    pub fn projects(&self) -> Result<Vec<Project>> {
        decode(self.json("GET", "/projects", None, None, self.timeout)?.1["projects"].take())
    }
    pub fn ensure_project(&self, name: &str) -> Result<(Project, bool)> {
        let (status, mut j) = self.json(
            "POST",
            "/projects",
            Some(&json!({"name":name})),
            None,
            self.timeout,
        )?;
        Ok((decode(j["project"].take())?, status == 201))
    }
    pub fn investigations(&self, project: Option<&str>) -> Result<Vec<InvestigationInfo>> {
        let path = project
            .map(|p| format!("/investigations?project={}", encode(p)))
            .unwrap_or_else(|| "/investigations".into());
        decode(self.json("GET", &path, None, None, self.timeout)?.1["investigations"].take())
    }
    pub fn records(&self, inv: &str, kind: Option<&str>) -> Result<Vec<Record>> {
        let mut path = format!("/investigations/{}/records", encode(inv));
        if let Some(kind) = kind {
            path.push_str(&format!("?kind={}", encode(kind)));
        }
        decode(self.json("GET", &path, None, None, self.timeout)?.1["records"].take())
    }
    pub fn proposal(&self, inv: &str, pid: &str) -> Result<Proposal> {
        self.proposal_with_timeout(inv, pid, self.timeout)
    }
    fn proposal_with_timeout(&self, inv: &str, pid: &str, timeout: Duration) -> Result<Proposal> {
        decode(
            self.json(
                "GET",
                &format!("/investigations/{}/proposals/{}", encode(inv), encode(pid)),
                None,
                None,
                timeout,
            )?
            .1,
        )
    }
    pub fn append(
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
        )?;
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

#[cfg(test)]
mod tests;
