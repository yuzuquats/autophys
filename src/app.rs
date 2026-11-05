//! The autophys tento-web app: one `DomainConfig` whose compiler bundles
//! `html/routes` by file name (`index.anon.html`, `index.root.ts`), and whose
//! `.config` registers the daemon's API on the same actix app.

use std::path::PathBuf;

use actix_web::{HttpRequest, HttpResponse, web};
use serde::Serialize;
use tento_web::{
    DomainConfig,
    compiler::{Action, Compiler},
};

use crate::http::Api;

pub const APP_ID: &str = "autophys";

/// The tento tree this app builds against, relative to the project root: the
/// vendored copy. The only tento path on the Rust side besides `Cargo.toml`.
pub const TENTO: &str = "vendor/tento";

/// What `/api/healthz` reports about this binary.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct BuildInfo {
    pub version: String,
    /// The autophys commit `ops/deploy.sh` stamps in through `AUTOPHYS_COMMIT`.
    pub commit: String,
    /// SHA-256 of the embedded web payload currently served, or null.
    pub web_id: Option<String>,
}

impl BuildInfo {
    /// The Cargo version and stamped commit; a plain build reports `dev`.
    pub fn current() -> Self {
        BuildInfo {
            web_id: None,
            version: env!("CARGO_PKG_VERSION").to_string(),
            commit: option_env!("AUTOPHYS_COMMIT").unwrap_or("dev").to_string(),
        }
    }
}

/// Where the app's sources and its built route tree are.
#[derive(Clone, Debug)]
pub struct AppConfig {
    /// The autophys checkout: `html/` and the `vendor/tento` compiler deps are
    /// resolved against it. Only a build reads it.
    pub project_root: PathBuf,
    /// The route tree that is served: written by a build, or prebuilt by
    /// `autophys build-web` and passed as `serve --web-root`.
    pub web_root: PathBuf,
    /// The collection and server database behind `/api/v1`. `None` (a bare
    /// `build-web`) leaves `/api/v1/*` on the JSON 404.
    pub store: Option<Api>,
}

#[derive(Serialize)]
struct Health<'a> {
    ok: bool,
    version: &'a str,
    commit: &'a str,
    web_id: Option<&'a str>,
}

/// The page the cookbook's client routes answer with: the built shell.
#[derive(Clone)]
struct Shell(PathBuf);

pub fn domain(config: &AppConfig, info: BuildInfo) -> DomainConfig {
    // Compiler deps are watched relative to the html root (`html/`), not the
    // project root: the routes themselves, then the tento trees they import.
    let compiler = Compiler::builder()
        .dep((".", Action::RebuildRoutes))
        .dep((
            format!("../{TENTO}/tento-cookbook-js").as_str(),
            Action::RebuildRoutes,
        ))
        .dep((
            format!("../{TENTO}/tento-ui-js").as_str(),
            Action::RebuildRoutes,
        ))
        .build();
    let info = web::Data::new(info);
    let shell = web::Data::new(Shell(config.web_root.join("routes/index.anon.html")));
    let store = config.store.clone();
    let sessions = web::Data::new(
        store
            .as_ref()
            .map(|api| api.sessions.clone())
            .unwrap_or_default(),
    );

    DomainConfig::builder()
        .hostname("localhost")
        .project_root(config.project_root.clone())
        .compiler(Some(compiler))
        .config(move |cfg| {
            // Reserve the dependency system namespace before its SystemRouter.
            // Autophys owns its auth/API; upstream admin and UX-test handlers
            // must never run, even when they need app data we do not provide.
            cfg.service(web::scope("/_").default_service(web::route().to(api_not_found)));
            cfg.app_data(info.clone());
            cfg.app_data(shell.clone());
            cfg.app_data(sessions.clone());
            cfg.route("/api/healthz", web::get().to(healthz));
            configure_api_v1(cfg, store.as_ref());
            // Sign-in pages and /api/auth (used when `serve --login`).
            if let Some(api) = store.as_ref() {
                cfg.app_data(web::Data::new(api.clone()));
                crate::login::configure(cfg, api.clone());
            }
            // Anything else under /api is a JSON 404, never the page.
            cfg.route("/api", web::route().to(api_not_found));
            cfg.route("/api/{tail:.*}", web::route().to(api_not_found));
            // Document loads reuse a valid process-local browser session.
            cfg.route("/", web::get().to(app_document));
            cfg.route("/app", web::get().to(app_document));
            cfg.route("/app/{tail:.*}", web::get().to(app_document));
        })
        .build()
}

// ---------------------------------------------------------------------------
// HOOK: /api/v1
//
// `crate::http::configure` registers every `/api/v1` route and the SSE stream
// (`src/http.rs` over the `autophys` crate; decisions in store.md and
// rust-sdk.md). It runs after `/api/healthz` and before the `/api` JSON 404
// catch-all, so its scope wins over the catch-all; unknown `/api/v1/*` paths
// get the scope's own JSON 404. Without an `Api` (`build-web`) nothing is
// registered and the catch-all answers.
// ---------------------------------------------------------------------------
fn configure_api_v1(cfg: &mut web::ServiceConfig, api: Option<&Api>) {
    if let Some(api) = api {
        crate::http::configure(cfg, api.clone());
    }
}

async fn healthz(info: web::Data<BuildInfo>) -> HttpResponse {
    HttpResponse::Ok().json(Health {
        ok: true,
        version: &info.version,
        commit: &info.commit,
        web_id: info.web_id.as_deref(),
    })
}

async fn api_not_found(req: HttpRequest) -> HttpResponse {
    HttpResponse::NotFound()
        .json(serde_json::json!({ "ok": false, "error": "not found", "path": req.path() }))
}

async fn app_document(
    req: HttpRequest,
    shell: web::Data<Shell>,
    sessions: web::Data<crate::http::auth::BrowserSessions>,
    api: Option<web::Data<Api>>,
) -> Result<HttpResponse, crate::error::ApiError> {
    // `serve --login`: signed out, only the landing page is served; the API
    // stays closed. Anything else redirects to the sign-in page.
    let mut badge = None;
    if let Some(api) = api.filter(|a| a.options().login) {
        match crate::http::auth::signed_in(&api, &req).await? {
            Some(user) => badge = Some(crate::login::badge(&user)),
            None if req.path() == "/" => {
                let keys = api.keys.clone();
                let demo = crate::http::blocking(move || keys.users_demo())
                    .await
                    .ok()
                    .flatten()
                    .is_some();
                badge = Some(crate::login::anonymous_badge(demo))
            }
            None => {
                let path = req.uri().path_and_query().map_or("/app", |p| p.as_str());
                let next: String = path
                    .bytes()
                    .map(|b| match b {
                        b'A'..=b'Z'
                        | b'a'..=b'z'
                        | b'0'..=b'9'
                        | b'-'
                        | b'_'
                        | b'.'
                        | b'~'
                        | b'/' => (b as char).to_string(),
                        b => format!("%{b:02X}"),
                    })
                    .collect();
                return Ok(HttpResponse::SeeOther()
                    .insert_header((
                        actix_web::http::header::LOCATION,
                        format!("/login?next={next}"),
                    ))
                    .insert_header((actix_web::http::header::CACHE_CONTROL, "no-store"))
                    .finish());
            }
        }
    }
    match tokio::fs::read(&shell.0).await {
        Ok(html) => Ok(HttpResponse::Ok()
            .cookie(sessions.document_cookie(&req)?)
            // Retire the former /api cookie so it cannot shadow the reused /
            // cookie on API calls after the old token's idle lease expires.
            .cookie(
                actix_web::cookie::Cookie::build(crate::http::auth::SESSION_COOKIE, "")
                    .path("/api")
                    .max_age(actix_web::cookie::time::Duration::ZERO)
                    .finish(),
            )
            .insert_header((actix_web::http::header::CACHE_CONTROL, "no-store"))
            // `serve --login` pages carry a password form: refuse framing.
            .insert_header((
                "x-frame-options",
                if badge.is_some() {
                    "DENY"
                } else {
                    "SAMEORIGIN"
                },
            ))
            .insert_header((
                actix_web::http::header::CONTENT_SECURITY_POLICY,
                if badge.is_some() {
                    "frame-ancestors 'none'"
                } else {
                    "frame-ancestors 'self'"
                },
            ))
            .content_type("text/html; charset=utf-8")
            .body(match badge {
                Some(badge) => with_badge(html, &badge),
                None => html,
            })),
        Err(error) => Ok(HttpResponse::InternalServerError()
            .content_type("text/plain; charset=utf-8")
            .body(format!("the built shell is missing ({error})\n"))),
    }
}

/// Put the account badge just before `</body>` (or at the end).
fn with_badge(html: Vec<u8>, badge: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(&html);
    match text.rfind("</body>") {
        Some(at) => format!("{}{badge}{}", &text[..at], &text[at..]).into_bytes(),
        None => format!("{text}{badge}").into_bytes(),
    }
}
