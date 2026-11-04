//! Bearer keys, and the one exemption: the operator's browser on loopback.
//!
//! Why a keyless browser is safe enough (store.md AX-9, O-3). The daemon binds
//! only literal loopback addresses (`parse_loopback`), so every peer is a
//! process on this host or the operator's tento.localhost proxy, which
//! splices the browser's bytes through unchanged. A key adds nothing against
//! a local process that can already read the database file. What remains is
//! the operator's own browser being driven by a hostile page, so:
//!
//! Keyless **reads** (`/workspace`, `/stream`, `GET /pairings`):
//! - `Sec-Fetch-Site: same-origin`, which the browser sets and page script
//!   cannot, refuses cross-site fetches;
//! - the Host must be a loopback literal, `localhost`, a `*.localhost` name or
//!   a configured name, which refuses a DNS-rebinding page (its Host is its
//!   own domain, though the browser calls it same-origin);
//! - an `Origin`, when sent, must name that same host.
//!
//! Keyless **writes** (`…/approvals`, `/pairings/{code}/approve|deny`),
//! operator decision O-3:
//! - `Content-Type: application/json`, else 415, so an HTML form (which can
//!   only send form or text bodies) cannot reach the handler;
//! - `Origin` equal to the daemon's own origin (`http://127.0.0.1:<port>`,
//!   `http://localhost:<port>`, `http://[::1]:<port>`) or a configured one,
//!   else 403. Browsers always send Origin on a cross-origin or JSON POST.
//!
//! In both cases a known TCP peer must be loopback. A request that sends a
//! bearer key is judged by the key alone and needs no Origin.

use std::net::IpAddr;

use actix_web::dev::Payload;
use actix_web::http::{Method, header};
use actix_web::{FromRequest, HttpRequest, web};
use futures_util::future::LocalBoxFuture;

use crate::store::error::StoreError;
use crate::store::keys::KeyInfo;
use crate::store::{Options, Store};

/// Who made the request.
#[derive(Clone, Debug)]
pub enum Caller {
    Key(KeyInfo),
    Browser,
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

fn store_of(req: &HttpRequest) -> Result<Store, StoreError> {
    req.app_data::<web::Data<Store>>()
        .map(|d| d.get_ref().clone())
        .ok_or_else(|| StoreError::Internal("the /api/v1 scope has no Store".into()))
}

async fn by_key(store: Store, token: String) -> Result<KeyInfo, StoreError> {
    store
        .authenticate(&token)
        .await?
        .ok_or(StoreError::Unauthorized)
}

impl FromRequest for Keyed {
    type Error = StoreError;
    type Future = LocalBoxFuture<'static, Result<Self, StoreError>>;

    fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
        let store = store_of(req);
        let token = bearer(req);
        Box::pin(async move {
            let token = token.ok_or(StoreError::Unauthorized)?;
            Ok(Keyed(by_key(store?, token).await?))
        })
    }
}

impl FromRequest for KeyOrBrowser {
    type Error = StoreError;
    type Future = LocalBoxFuture<'static, Result<Self, StoreError>>;

    fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
        let store = store_of(req);
        let token = bearer(req);
        let keyless = match (&store, &token) {
            (Ok(s), None) => Some(browser(req, s.options())),
            _ => None,
        };
        Box::pin(async move {
            let store = store?;
            match (token, keyless) {
                (Some(token), _) => Ok(KeyOrBrowser(Caller::Key(by_key(store, token).await?))),
                (None, Some(verdict)) => verdict.map(|()| KeyOrBrowser(Caller::Browser)),
                (None, None) => Err(StoreError::Unauthorized),
            }
        })
    }
}

/// Admit a keyless request: reads by [`same_origin_read`] (else 401), writes
/// by [`same_origin_write`] (415 / 403).
pub fn browser(req: &HttpRequest, opts: &Options) -> Result<(), StoreError> {
    if req.peer_addr().is_some_and(|peer| !peer.ip().is_loopback()) {
        return Err(StoreError::Forbidden(
            "keyless requests must come from loopback".into(),
        ));
    }
    if matches!(*req.method(), Method::GET | Method::HEAD) {
        same_origin_read(req, opts)
            .then_some(())
            .ok_or(StoreError::Unauthorized)
    } else {
        same_origin_write(req, opts)
    }
}

/// A same-origin browser read on a local host name.
pub fn same_origin_read(req: &HttpRequest, opts: &Options) -> bool {
    let h = req.headers();
    let text = |name: &str| h.get(name).and_then(|v| v.to_str().ok());
    if text("sec-fetch-site") != Some("same-origin") {
        return false;
    }
    let Some(host) = text("host") else {
        return false;
    };
    if !local_host(host_name(host), opts) {
        return false;
    }
    text("origin").is_none_or(|origin| {
        let (origin, host) = (origin.to_ascii_lowercase(), host.to_ascii_lowercase());
        origin == format!("http://{host}") || origin == format!("https://{host}")
    })
}

/// O-3: a keyless write must be JSON from the daemon's own Origin.
pub fn same_origin_write(req: &HttpRequest, opts: &Options) -> Result<(), StoreError> {
    let h = req.headers();
    let json = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"));
    if !json {
        return Err(StoreError::UnsupportedMediaType);
    }
    let Some(origin) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return Err(StoreError::Forbidden(
            "a keyless write needs an Origin header".into(),
        ));
    };
    if !own_origins(req, opts)
        .iter()
        .any(|o| o.eq_ignore_ascii_case(origin))
    {
        return Err(StoreError::Forbidden(format!(
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
