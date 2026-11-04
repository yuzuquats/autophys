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
use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use actix_web::dev::Payload;
use actix_web::http::{Method, header};
use actix_web::{FromRequest, HttpRequest, web};
use futures_util::future::LocalBoxFuture;

use crate::accounts::User;
use crate::error::ApiError;
use crate::http::{Api, blocking};
use crate::keys::{KeyInfo, Options};

/// Host-only browser session, sent to API routes only.
pub const SESSION_COOKIE: &str = "autophys_session";

/// The sign-in cookie of `serve --login`: a session in the server database,
/// so it survives restarts (the document cookie above does not).
pub const LOGIN_COOKIE: &str = "autophys_login";

/// Valid document sessions in this server process. Nothing is persisted.
#[derive(Clone, Default)]
pub struct BrowserSessions(Arc<Mutex<HashSet<String>>>);

impl BrowserSessions {
    /// Mint a fresh 256-bit session for a served document.
    pub fn issue_cookie(&self) -> Result<Cookie<'static>, ApiError> {
        let token = crate::keys::random_hex(32)?;
        self.0
            .lock()
            .map_err(|_| ApiError::Internal("browser sessions poisoned".into()))?
            .insert(token.clone());
        Ok(Cookie::build(SESSION_COOKIE, token)
            .http_only(true)
            .same_site(SameSite::Strict)
            .path("/api")
            .finish())
    }

    fn accepts(&self, req: &HttpRequest) -> bool {
        req.cookie(SESSION_COOKIE).is_some_and(|cookie| {
            self.0
                .lock()
                .is_ok_and(|valid| valid.contains(cookie.value()))
        })
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

impl FromRequest for Keyed {
    type Error = ApiError;
    type Future = LocalBoxFuture<'static, Result<Self, ApiError>>;

    fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
        let store = api_of(req);
        let token = bearer(req);
        Box::pin(async move {
            let token = token.ok_or(ApiError::Unauthorized)?;
            Ok(Keyed(by_key(store?, token).await?))
        })
    }
}

impl FromRequest for KeyOrBrowser {
    type Error = ApiError;
    type Future = LocalBoxFuture<'static, Result<Self, ApiError>>;

    fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
        let store = api_of(req);
        let token = bearer(req);
        let keyless = match (&store, &token) {
            (Ok(a), None) => Some(browser(req, a)),
            _ => None,
        };
        let req = req.clone();
        Box::pin(async move {
            let store = store?;
            match (token, keyless) {
                (Some(token), _) => Ok(KeyOrBrowser(Caller::Key(by_key(store, token).await?))),
                (None, Some(verdict)) => {
                    verdict?;
                    if !store.options().login {
                        return Ok(KeyOrBrowser(Caller::Browser));
                    }
                    match signed_in(&store, &req).await? {
                        Some(user) => Ok(KeyOrBrowser(Caller::Member(user))),
                        None => Err(ApiError::Unauthorized),
                    }
                }
                (None, None) => Err(ApiError::Unauthorized),
            }
        })
    }
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
    // authorizes the browser; writes still pass the Origin check above. The
    // process-local document session is not required, so a daemon restart
    // (every deploy) does not knock signed-in tabs out.
    if api.options().login {
        return Ok(());
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
