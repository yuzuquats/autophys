//! API bearer keys or a document-issued session cookie (AX-9).
//!
//! Browser reads require a live process-local cookie; Sec-Fetch-Site grants
//! no exemption. Browser writes additionally keep the JSON + Origin guard
//! (O-3). A known peer must be loopback and browser read Hosts stay local.
//! API keys work independently of the browser session and its headers.
//!
//! With `serve --login` ([`Options::login`]) a browser must also carry a
//! sign-in cookie ([`LOGIN_COOKIE`], `crate::accounts`), and the caller is
//! that [`Caller::Member`]. The local-Host rule is then dropped: the sign-in,
//! not the machine, is what admits a browser, so a public proxy works.

use actix_web::cookie::{Cookie, SameSite};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use actix_web::dev::Payload;
use actix_web::http::{Method, header};
use actix_web::{FromRequest, HttpRequest, web};
use futures_util::future::LocalBoxFuture;

use crate::accounts::User;
use crate::error::ApiError;
use crate::http::{Api, blocking};
use crate::keys::{KeyInfo, Options};

/// Host-only, HttpOnly browser session, reused on document loads.
pub const SESSION_COOKIE: &str = "autophys_session";

/// The sign-in cookie of `serve --login`: a session in the server database,
/// so it survives restarts (the document cookie above does not).
pub const LOGIN_COOKIE: &str = "autophys_login";

/// Process-local document sessions. Reloads reuse a browser's existing token;
/// ordinary API activity renews its idle lease. Account sessions remain in the
/// separate persistent store. No valid active token is evicted for admission.
#[derive(Clone, Default)]
pub struct BrowserSessions(Arc<Mutex<HashMap<String, Instant>>>);

const DOCUMENT_IDLE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const DOCUMENT_CAPACITY: usize = 4096;

impl BrowserSessions {
    /// Mint a session for callers that have no document request (embedders/tests).
    pub fn issue_cookie(&self) -> Result<Cookie<'static>, ApiError> {
        self.issue_at(None, Instant::now())
    }

    pub fn document_cookie(&self, req: &HttpRequest) -> Result<Cookie<'static>, ApiError> {
        self.issue_at(
            req.cookie(SESSION_COOKIE).as_ref().map(|c| c.value()),
            Instant::now(),
        )
    }

    fn issue_at(&self, existing: Option<&str>, now: Instant) -> Result<Cookie<'static>, ApiError> {
        let mut valid = self
            .0
            .lock()
            .map_err(|_| ApiError::Internal("browser sessions poisoned".into()))?;
        valid.retain(|_, seen| now.saturating_duration_since(*seen) < DOCUMENT_IDLE);
        let token = if let Some(token) = existing.filter(|t| valid.contains_key(*t)) {
            token.to_string()
        } else {
            if valid.len() >= DOCUMENT_CAPACITY {
                return Err(ApiError::Forbidden(
                    "document session capacity reached; retry after idle sessions expire".into(),
                ));
            }
            crate::keys::random_hex(32)?
        };
        valid.insert(token.clone(), now);
        Ok(Cookie::build(SESSION_COOKIE, token)
            .http_only(true)
            .same_site(SameSite::Strict)
            // Reload requests must carry the cookie too, so they can reuse it.
            // HttpOnly and the independent API Host/Origin checks still apply.
            .path("/")
            .finish())
    }

    fn accepts_at(&self, token: &str, now: Instant) -> bool {
        self.0.lock().is_ok_and(|mut valid| {
            valid.retain(|_, seen| now.saturating_duration_since(*seen) < DOCUMENT_IDLE);
            if let Some(seen) = valid.get_mut(token) {
                *seen = now;
                true
            } else {
                false
            }
        })
    }

    fn accepts(&self, req: &HttpRequest) -> bool {
        req.cookie(SESSION_COOKIE)
            .is_some_and(|cookie| self.accepts_at(cookie.value(), Instant::now()))
    }
}

/// Who made the request.
#[derive(Clone, Debug)]
pub enum Caller {
    Key(KeyInfo),
    /// A local browser (no `--login`).
    Browser,
    /// A signed-in browser (`--login`).
    Member(User),
}

impl Caller {
    /// Who to record as having acted, when the server knows better than the
    /// client: a signed-in person's email.
    pub fn person(&self) -> Option<&str> {
        match self {
            Caller::Member(user) => Some(&user.email),
            _ => None,
        }
    }
}

/// The signed-in account behind the request's [`LOGIN_COOKIE`], if any.
pub async fn signed_in(api: &Api, req: &HttpRequest) -> Result<Option<User>, ApiError> {
    let Some(token) = req.cookie(LOGIN_COOKIE).map(|c| c.value().to_string()) else {
        return Ok(None);
    };
    let keys = api.keys.clone();
    blocking(move || keys.session_user(&token)).await
}

/// Extractor: a live bearer key, else 401.
pub struct Keyed(pub KeyInfo);

/// Extractor: a live bearer key, or the local browser under the rules above.
pub struct KeyOrBrowser(pub Caller);

fn bearer(req: &HttpRequest) -> Option<String> {
    let v = req.headers().get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = v.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then(|| token.to_string())
}

fn api_of(req: &HttpRequest) -> Result<Api, ApiError> {
    req.app_data::<web::Data<Api>>()
        .map(|d| d.get_ref().clone())
        .ok_or_else(|| ApiError::Internal("the /api/v1 scope has no Api".into()))
}

async fn by_key(api: Api, token: String) -> Result<KeyInfo, ApiError> {
    let keys = api.keys.clone();
    blocking(move || keys.authenticate(&token))
        .await?
        .ok_or(ApiError::Unauthorized)
}

/// Kept only in memory for revalidating long-lived work; never serialized or logged.
#[derive(Clone)]
pub(crate) enum Credential {
    Local,
    Session(String),
    Key(String),
}

pub(crate) async fn request_scope(
    req: &HttpRequest,
    keys_only: bool,
) -> Result<(Caller, Api), ApiError> {
    let api = api_of(req)?;
    let (caller, credential) = if let Some(token) = bearer(req) {
        (
            Caller::Key(by_key(api.clone(), token.clone()).await?),
            Credential::Key(token),
        )
    } else {
        if keys_only {
            return Err(ApiError::Unauthorized);
        }
        browser(req, &api)?;
        if api.options().login {
            let user = signed_in(&api, req).await?.ok_or(ApiError::Unauthorized)?;
            let token = req
                .cookie(LOGIN_COOKIE)
                .ok_or(ApiError::Unauthorized)?
                .value()
                .to_string();
            (Caller::Member(user), Credential::Session(token))
        } else {
            (Caller::Browser, Credential::Local)
        }
    };
    let saved = caller.clone();
    let scoped = blocking(move || api.scoped(&saved, credential)).await?;
    if !matches!(*req.method(), Method::GET | Method::HEAD)
        && !scoped.context.as_ref().unwrap().capabilities.create_project
    {
        return Err(ApiError::Forbidden("This account is read-only.".into()));
    }
    Ok((caller, scoped))
}
impl FromRequest for Keyed {
    type Error = ApiError;
    type Future = LocalBoxFuture<'static, Result<Self, ApiError>>;
    fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
        let req = req.clone();
        Box::pin(async move {
            match request_scope(&req, true).await?.0 {
                Caller::Key(key) => Ok(Self(key)),
                _ => Err(ApiError::Unauthorized),
            }
        })
    }
}
impl FromRequest for KeyOrBrowser {
    type Error = ApiError;
    type Future = LocalBoxFuture<'static, Result<Self, ApiError>>;
    fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
        let req = req.clone();
        Box::pin(async move { Ok(Self(request_scope(&req, false).await?.0)) })
    }
}

/// A login-off daemon's own browser: a loopback peer naming a local host
/// (the DNS-rebinding guard), without requiring the document session.
pub(crate) fn local_browser(req: &HttpRequest, api: &Api) -> bool {
    req.peer_addr().is_none_or(|peer| peer.ip().is_loopback())
        && req
            .headers()
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| local_host(host_name(h), api.options()))
}

/// Admit a browser session; O-3 is checked before a state-changing request.
pub fn browser(req: &HttpRequest, api: &Api) -> Result<(), ApiError> {
    if req.peer_addr().is_some_and(|peer| !peer.ip().is_loopback()) {
        return Err(ApiError::Forbidden(
            "browser requests must come from loopback".into(),
        ));
    }
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        same_origin_write(req, api.options())?;
    } else if !api.options().login {
        let local = req
            .headers()
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| local_host(host_name(h), api.options()));
        if !local {
            return Err(ApiError::Unauthorized);
        }
    }
    // `serve --login`: the persistent sign-in cookie (checked by the caller)
    // authorizes the browser, so a daemon restart (every deploy) does not knock
    // signed-in tabs out. That cookie is SameSite=Lax, so reads must also be
    // same-origin by Sec-Fetch-Site (a sibling subdomain or a cross-site
    // top-level navigation is refused); writes passed the Origin check above.
    if api.options().login {
        let same_origin = req
            .headers()
            .get("sec-fetch-site")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.eq_ignore_ascii_case("same-origin"));
        return if same_origin || !matches!(*req.method(), Method::GET | Method::HEAD) {
            Ok(())
        } else {
            Err(ApiError::Unauthorized)
        };
    }
    api.sessions
        .accepts(req)
        .then_some(())
        .ok_or(ApiError::Unauthorized)
}

/// A sign-in form's POST must come from one of the daemon's origins.
pub fn form_origin(req: &HttpRequest, opts: &Options) -> Result<(), ApiError> {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::Forbidden("a sign-in form needs an Origin header".into()))?;
    if own_origins(req, opts)
        .iter()
        .any(|o| o.eq_ignore_ascii_case(origin))
    {
        Ok(())
    } else {
        Err(ApiError::Forbidden(format!(
            "origin {origin} is not this daemon's"
        )))
    }
}

/// O-3: a keyless write must be JSON from the daemon's own Origin.
pub fn same_origin_write(req: &HttpRequest, opts: &Options) -> Result<(), ApiError> {
    let h = req.headers();
    let json = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"));
    if !json {
        return Err(ApiError::UnsupportedMediaType);
    }
    let Some(origin) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return Err(ApiError::Forbidden(
            "a keyless write needs an Origin header".into(),
        ));
    };
    if !own_origins(req, opts)
        .iter()
        .any(|o| o.eq_ignore_ascii_case(origin))
    {
        return Err(ApiError::Forbidden(format!(
            "origin {origin} is not this daemon's"
        )));
    }
    Ok(())
}

/// The daemon's own origins, from the port it is actually bound to.
fn own_origins(req: &HttpRequest, opts: &Options) -> Vec<String> {
    let port = req.app_config().local_addr().port();
    let mut out = vec![
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
        format!("http://[::1]:{port}"),
    ];
    out.extend(opts.browser_origins.iter().cloned());
    out.extend(opts.public_url.iter().cloned());
    out
}

/// `host[:port]` → host, without IPv6 brackets.
fn host_name(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("");
    }
    match host.rsplit_once(':') {
        Some((name, port)) if port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host,
    }
}

fn local_host(name: &str, opts: &Options) -> bool {
    let name = name.to_ascii_lowercase();
    if let Ok(ip) = name.parse::<IpAddr>() {
        return ip.is_loopback();
    }
    name == "localhost"
        || name.ends_with(".localhost")
        || opts
            .browser_hosts
            .iter()
            .any(|h| h.eq_ignore_ascii_case(&name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reloads_reuse_tokens_active_api_clients_renew_and_idle_entries_are_reclaimed() {
        let sessions = BrowserSessions::default();
        let start = Instant::now();
        let active = sessions.issue_at(None, start).unwrap();
        let stale = sessions.issue_at(None, start).unwrap();
        let initial_len = sessions.0.lock().unwrap().len();
        for day in 0..100 {
            let now = start + Duration::from_secs(day * 86400);
            assert!(sessions.accepts_at(active.value(), now));
            for _ in 0..100 {
                let reloaded = sessions.issue_at(Some(active.value()), now).unwrap();
                assert_eq!(reloaded.value(), active.value());
                assert_eq!(reloaded.path(), Some("/"));
                assert!(reloaded.http_only().unwrap());
                assert_eq!(reloaded.same_site(), Some(SameSite::Strict));
            }
            assert!(sessions.0.lock().unwrap().len() <= initial_len);
            if day >= 30 {
                assert!(!sessions.accepts_at(stale.value(), now));
                assert_eq!(sessions.0.lock().unwrap().len(), 1);
            }
        }
        assert!(!sessions.accepts_at(active.value(), start + Duration::from_secs(130 * 86400)));
        assert_eq!(sessions.0.lock().unwrap().len(), 0);
    }

    #[test]
    fn admission_is_bounded_without_evicting_valid_clients_or_accepting_forged_tokens() {
        let sessions = BrowserSessions::default();
        let now = Instant::now();
        let active = sessions.issue_at(Some("untrusted"), now).unwrap();
        assert_ne!(active.value(), "untrusted");
        for _ in 1..DOCUMENT_CAPACITY {
            sessions.issue_at(None, now).unwrap();
        }
        assert!(sessions.issue_at(None, now).is_err());
        assert_eq!(sessions.0.lock().unwrap().len(), DOCUMENT_CAPACITY);
        assert!(sessions.accepts_at(active.value(), now));
        assert_eq!(
            sessions
                .issue_at(Some(active.value()), now)
                .unwrap()
                .value(),
            active.value()
        );
        assert!(sessions.issue_at(None, now + DOCUMENT_IDLE).is_ok());
        assert_eq!(sessions.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn host_names() {
        assert_eq!(host_name("127.0.0.1:4794"), "127.0.0.1");
        assert_eq!(host_name("[::1]:4794"), "::1");
        assert_eq!(
            host_name("autophys.rwc-dev-01.tento.localhost"),
            "autophys.rwc-dev-01.tento.localhost"
        );
        let o = Options::default();
        assert!(local_host("::1", &o) && local_host("127.0.0.1", &o));
        assert!(local_host("autophys.rwc-dev-01.tento.localhost", &o));
        assert!(!local_host("evil.example", &o) && !local_host("10.0.0.1", &o));
        assert!(!local_host("localhost.evil.example", &o));
    }
}
