//! Invite-only browser sign-in for `serve --login` (accounts in
//! [`crate::accounts`]). Credentials are entered in the workspace or its header
//! dialog. The legacy `/login` URL redirects into the workspace.
//!
//! ```text
//! GET  /login                 303 to /app (or a safe workspace next path)
//! GET  /invite#<token>        choose a password (the token stays out of logs)
//! POST /api/auth/login        session cookie, 303 to next; JSON on failure
//! POST /api/auth/invite       password set, session cookie, 303 /app
//! POST /api/auth/logout       end the session, 303 /app
//! GET  /api/auth/me           {"user": {...}} or 401
//! ```
//!
//! Every form POST must carry one of the daemon's Origins. App documents
//! ([`crate::app`]) remain public; signed-out workspaces render the inline form.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use actix_web::cookie::{Cookie, SameSite, time};
use actix_web::http::header;
use actix_web::{HttpRequest, HttpResponse, web};
use serde::Deserialize;
use serde_json::json;

use crate::accounts::{MIN_PASSWORD, SESSION_TTL, User};
use crate::error::{ApiError, Result};
use crate::http::auth::{LOGIN_COOKIE, form_origin, signed_in};
use crate::http::{Api, blocking};

/// Register the legacy redirect, invitation page and `/api/auth/*`. Call before the `/api`
/// catch-all.
pub fn configure(cfg: &mut web::ServiceConfig, api: Api) {
    let data = web::Data::new(api);
    cfg.app_data(web::Data::new(Throttle::default()));
    cfg.service(
        web::scope("/api/auth")
            .app_data(data.clone())
            .route("/login", web::post().to(login))
            .route("/invite", web::post().to(accept))
            .route("/logout", web::post().to(logout))
            .route("/me", web::get().to(me))
            .route("/badge", web::get().to(badge_fragment))
            .route("/demo", web::post().to(demo_sign_in)),
    );
    cfg.service(
        web::resource("/login")
            .app_data(data.clone())
            .route(web::get().to(login_page)),
    );
    cfg.service(
        web::resource("/invite")
            .app_data(data)
            .route(web::get().to(invite_page)),
    );
}

/// Only same-site paths: `/app/...`, never `//host` or a URL.
///
/// A browser strips tabs and newlines from a URL, so `/\t/evil.example`
/// would become `//evil.example`: only printable ASCII (no space, no
/// backslash) is accepted.
fn safe_next(next: Option<&str>) -> String {
    match next {
        Some(n)
            if n.starts_with('/')
                && !n.starts_with("//")
                && n.bytes().all(|b| b.is_ascii_graphic() && b != b'\\') =>
        {
            n.into()
        }
        _ => "/app".into(),
    }
}

fn session_cookie(api: &Api, token: String) -> Cookie<'static> {
    let secure = api
        .options()
        .public_url
        .as_deref()
        .is_some_and(|u| u.starts_with("https://"));
    Cookie::build(LOGIN_COOKIE, token)
        .http_only(true)
        .secure(secure)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::seconds(SESSION_TTL.num_seconds()))
        .finish()
}

fn see_other(to: &str) -> HttpResponse {
    HttpResponse::SeeOther()
        .insert_header((header::LOCATION, to.to_string()))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .finish()
}

/// Minimal HTML escaping for text and attribute values.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

const PAGE_STYLE: &str = "\
*{box-sizing:border-box}\
body{margin:0;min-height:100vh;min-height:100svh;padding:24px 0;display:grid;place-items:center;background:#f6f6f6;\
color:#141414;font:15px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif}\
main{width:min(380px,calc(100vw - 32px));background:#fff;border-radius:14px;padding:28px;\
box-shadow:0 10px 30px rgba(0,0,0,.10)}\
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 18px;color:#666}\
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}\
input{width:100%;padding:10px 12px;border:1px solid #d6d6d6;border-radius:8px;font:inherit}\
input:focus{outline:2px solid #141414;outline-offset:-1px}\
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;\
background:#141414;color:#fff;font:inherit;font-weight:600;cursor:pointer}\
.err{background:#fdecec;color:#9b1c1c;border-radius:8px;padding:9px 12px;margin:0 0 6px}\
.mark{width:28px;height:28px;border-radius:7px;background:#141414;margin-bottom:16px}\
.alt{margin:18px 0 0;font-size:13px}.alt a{color:#141414}\
form.demo{margin-top:8px}form.demo button{margin-top:0}button.secondary{background:#efefef;color:#141414}\
@keyframes auth-enter{from{opacity:.6}to{opacity:1}}\
@media(prefers-reduced-motion:no-preference){main{animation:auth-enter 160ms ease-out}}\
@media(max-width:640px){input{font-size:16px}}";

fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex\">\
         <title>{} · Autophys</title><style>{PAGE_STYLE}</style>\
         <body><main><div class=\"mark\"></div>{body}</main></body></html>",
        escape(title)
    )
}

fn html(status: actix_web::http::StatusCode, body: String) -> HttpResponse {
    HttpResponse::build(status)
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .insert_header(("x-frame-options", "DENY"))
        .content_type("text/html; charset=utf-8")
        .body(body)
}

fn invite_form(error: Option<&str>) -> String {
    let error = error
        .map(|e| format!("<div class=\"err\" role=\"alert\">{}</div>", escape(e)))
        .unwrap_or_default();
    page(
        "Set your password",
        &format!(
            "<h1>Welcome to Autophys</h1><p>Choose a password to finish setting up your account.</p>{error}\
             <form method=\"post\" action=\"/api/auth/invite\">\
             <input type=\"hidden\" name=\"token\" id=\"token\">\
             <label for=\"password\">Password</label>\
             <input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"new-password\" minlength=\"{MIN_PASSWORD}\" required>\
             <label for=\"confirm\">Confirm password</label>\
             <input id=\"confirm\" name=\"confirm\" type=\"password\" autocomplete=\"new-password\" minlength=\"{MIN_PASSWORD}\" required>\
             <button type=\"submit\">Set password and sign in</button></form>\
             <script>\
             var t=location.hash.slice(1)||sessionStorage.getItem('autophys.invite')||'';\
             if(t){{sessionStorage.setItem('autophys.invite',t);history.replaceState(null,'',location.pathname);}}\
             document.getElementById('token').value=t;\
             </script>"
        ),
    )
}

#[derive(Deserialize)]
struct NextQuery {
    next: Option<String>,
}

async fn login_page(q: web::Query<NextQuery>) -> HttpResponse {
    // Legacy links never render another sign-in surface, or redirect back to
    // this alias. Only workspace destinations can contain the inline form.
    let next = safe_next(q.next.as_deref());
    let path = next.split(['?', '#']).next().unwrap_or("");
    see_other(if path == "/app" || path.starts_with("/app/") {
        &next
    } else {
        "/app"
    })
}

/// Fetch submissions keep failures in the existing form. A native form
/// navigation returns to the inline workspace form with a fixed error code;
/// credentials and arbitrary messages never enter the URL.
fn login_error(
    req: &HttpRequest,
    status: actix_web::http::StatusCode,
    code: &str,
    message: &str,
) -> HttpResponse {
    if req
        .headers()
        .get("sec-fetch-mode")
        .and_then(|v| v.to_str().ok())
        == Some("navigate")
    {
        return see_other(&format!("/app?signin_error={code}"));
    }
    HttpResponse::build(status)
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(json!({ "error": code, "message": message }))
}

async fn invite_page() -> HttpResponse {
    html(actix_web::http::StatusCode::OK, invite_form(None))
}

#[derive(Deserialize)]
struct LoginForm {
    email: String,
    password: String,
    next: Option<String>,
}

async fn login(api: web::Data<Api>, req: HttpRequest, form: web::Form<LoginForm>) -> HttpResponse {
    let result = login_attempt(api, req.clone(), form).await;
    sign_in_response(&req, result)
}

/// Fixed public errors with an opaque reference; details stay in the server log.
fn sign_in_failure(req: &HttpRequest, error: ApiError, code: &str, message: &str) -> HttpResponse {
    let reference = crate::keys::random_hex(8).ok();
    if let Some(reference) = &reference {
        eprintln!("sign-in request {reference} failed: {error}");
    } else {
        eprintln!("sign-in request failed: {error}");
    }
    let mut response = login_error(
        req,
        actix_web::http::StatusCode::from_u16(error.status())
            .unwrap_or(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR),
        code,
        message,
    );
    if let Some(reference) = reference {
        response.headers_mut().insert(
            header::HeaderName::from_static("x-request-id"),
            header::HeaderValue::from_str(&reference).expect("hex request reference"),
        );
    }
    response
}

fn sign_in_response(req: &HttpRequest, result: Result<HttpResponse>) -> HttpResponse {
    match result {
        Ok(response) => response,
        Err(error) => {
            let (code, message) = if error.status() == 403 {
                (
                    "forbidden",
                    "This page couldn't sign you in. Reload it and try again.",
                )
            } else {
                (
                    "unavailable",
                    "Autophys is temporarily unavailable. Try again in a moment.",
                )
            };
            sign_in_failure(req, error, code, message)
        }
    }
}

async fn login_attempt(
    api: web::Data<Api>,
    req: HttpRequest,
    form: web::Form<LoginForm>,
) -> Result<HttpResponse> {
    form_origin(&req, api.options())?;
    let LoginForm {
        email,
        password,
        next,
    } = form.into_inner();
    let next = safe_next(next.as_deref());
    let throttle = req
        .app_data::<web::Data<Throttle>>()
        .cloned()
        .ok_or_else(|| ApiError::Internal("no sign-in throttle".into()))?;
    let key = crate::accounts::normalize_email(&email).unwrap_or_else(|_| email.to_lowercase());
    let refuse = |code: &str, message: &str| {
        Ok(login_error(
            &req,
            actix_web::http::StatusCode::TOO_MANY_REQUESTS,
            code,
            message,
        ))
    };
    if throttle.locked(&key) {
        return refuse(
            "throttled",
            "Too many sign-in attempts for this email. Wait a few minutes and try again.",
        );
    }
    let Some(_slot) = throttle.slot() else {
        return refuse(
            "busy",
            "Autophys is busy signing people in. Try again in a moment.",
        );
    };
    let keys = api.keys.clone();
    let typed = email.clone();
    let user = blocking(move || keys.users_check(&typed, &password)).await?;
    match &user {
        Some(_) => throttle.clear(&key),
        None => throttle.fail(&key),
    }
    let Some(user) = user else {
        return Ok(login_error(
            &req,
            actix_web::http::StatusCode::UNAUTHORIZED,
            "invalid",
            "That email and password don't match an account.",
        ));
    };
    start_session(&api, &req, user, &next).await
}

async fn start_session(api: &Api, req: &HttpRequest, user: User, to: &str) -> Result<HttpResponse> {
    let resolver = api.clone();
    let account = user.clone();
    let context = match blocking(move || {
        resolver
            .scoped(
                &crate::http::Caller::Member(account),
                crate::http::auth::Credential::Local,
            )?
            .context
            .ok_or_else(|| ApiError::Internal("sign-in context missing".into()))
    })
    .await
    {
        Ok(context) => context,
        Err(error) => {
            return Ok(sign_in_failure(
                req,
                error,
                "workspace_unavailable",
                "Your account's workspace is unavailable. Contact the account owner.",
            ));
        }
    };
    let keys = api.keys.clone();
    let previous = req.cookie(LOGIN_COOKIE).map(|c| c.value().to_string());
    let token = blocking(move || keys.session_replace(&user, previous.as_deref())).await?;
    // Fetch submits receive everything needed to enter the workspace, without
    // waiting on cosmetic badge/avatar requests. Native forms still navigate.
    let wants_json = req
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .any(|part| part.trim().split(';').next() == Some("application/json"))
        });
    let navigation = req
        .headers()
        .get("sec-fetch-mode")
        .and_then(|v| v.to_str().ok())
        == Some("navigate");
    let mut resp = if wants_json && !navigation {
        HttpResponse::Ok()
            .insert_header((header::CACHE_CONTROL, "no-store"))
            .json(json!({ "badge": account_control(&context), "context": context }))
    } else {
        see_other(to)
    };
    resp.add_cookie(&session_cookie(api, token))
        .map_err(|e| ApiError::Internal(format!("set cookie: {e}")))?;
    Ok(resp)
}

#[derive(Deserialize)]
struct DemoForm {
    next: Option<String>,
}

/// `POST /api/auth/demo`: sign in as the demo account, without a password.
async fn demo_sign_in(
    api: web::Data<Api>,
    req: HttpRequest,
    form: web::Form<DemoForm>,
) -> HttpResponse {
    let result = demo_attempt(api, req.clone(), form).await;
    sign_in_response(&req, result)
}

async fn demo_attempt(
    api: web::Data<Api>,
    req: HttpRequest,
    form: web::Form<DemoForm>,
) -> Result<HttpResponse> {
    form_origin(&req, api.options())?;
    let next = safe_next(form.next.as_deref());
    let keys = api.keys.clone();
    match blocking(move || keys.users_demo()).await? {
        Some(user) => start_session(&api, &req, user, &next).await,
        None => Ok(login_error(
            &req,
            actix_web::http::StatusCode::NOT_FOUND,
            "demo_unavailable",
            "Demo sign-in is unavailable right now. Try again later or sign in with your account.",
        )),
    }
}

#[derive(Deserialize)]
struct InviteForm {
    token: String,
    password: String,
    confirm: String,
}

async fn accept(
    api: web::Data<Api>,
    req: HttpRequest,
    form: web::Form<InviteForm>,
) -> Result<HttpResponse> {
    form_origin(&req, api.options())?;
    let InviteForm {
        token,
        password,
        confirm,
    } = form.into_inner();
    let again = |m: &str| {
        Ok(html(
            actix_web::http::StatusCode::BAD_REQUEST,
            invite_form(Some(m)),
        ))
    };
    if password != confirm {
        return again("The two passwords don't match.");
    }
    if password.chars().count() < MIN_PASSWORD {
        return again(&format!("Use at least {MIN_PASSWORD} characters."));
    }
    let keys = api.keys.clone();
    match blocking(move || keys.users_accept(&token, &password)).await {
        Ok(user) => start_session(&api, &req, user, "/app").await,
        Err(e) if e.status() == 404 => again(
            "This invite link has expired or was already used. Ask whoever invited \
             you for a new one.",
        ),
        Err(e) if e.status() < 500 => again(&e.to_string()),
        Err(e) => Err(e),
    }
}

async fn logout(api: web::Data<Api>, req: HttpRequest) -> Result<HttpResponse> {
    form_origin(&req, api.options())?;
    if let Some(token) = req.cookie(LOGIN_COOKIE).map(|c| c.value().to_string()) {
        let keys = api.keys.clone();
        blocking(move || keys.session_end(&token)).await?;
    }
    let mut gone = session_cookie(&api, String::new());
    gone.make_removal();
    let mut resp = see_other("/app");
    resp.add_cookie(&gone)
        .map_err(|e| ApiError::Internal(format!("clear cookie: {e}")))?;
    Ok(resp)
}

async fn me(api: web::Data<Api>, req: HttpRequest) -> Result<HttpResponse> {
    match signed_in(&api, &req).await? {
        Some(user) => Ok(HttpResponse::Ok()
            .insert_header((header::CACHE_CONTROL, "no-store"))
            .json(json!({ "user": user }))),
        None => Err(ApiError::Unauthorized),
    }
}

/// Sign-in throttling without trusting client IPs (the public proxy may
/// not forward them): at most [`Throttle::FAILURES`] failed sign-ins per
/// email per [`Throttle::WINDOW`], and at most [`Throttle::CONCURRENT`]
/// password checks at once (argon2 is the expensive part).
#[derive(Default)]
pub struct Throttle {
    failures: Mutex<HashMap<String, (u32, Instant)>>,
    in_flight: Arc<AtomicUsize>,
}

/// A held password-check slot; released on drop.
pub struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Throttle {
    pub const FAILURES: u32 = 8;
    pub const WINDOW: Duration = Duration::from_secs(15 * 60);
    pub const CONCURRENT: usize = 4;

    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, (u32, Instant)>> {
        self.failures.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Whether this email has used up its failures for the window.
    pub fn locked(&self, key: &str) -> bool {
        self.map()
            .get(key)
            .is_some_and(|(n, since)| *n >= Self::FAILURES && since.elapsed() < Self::WINDOW)
    }

    pub fn fail(&self, key: &str) {
        let mut map = self.map();
        if map.len() > 10_000 {
            map.retain(|_, (_, since)| since.elapsed() < Self::WINDOW);
        }
        let entry = map.entry(key.to_string()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= Self::WINDOW {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
    }

    pub fn clear(&self, key: &str) {
        self.map().remove(key);
    }

    /// A password-check slot, or `None` when [`Throttle::CONCURRENT`] are running.
    pub fn slot(&self) -> Option<Slot> {
        let n = self.in_flight.fetch_add(1, Ordering::SeqCst);
        let slot = Slot(self.in_flight.clone());
        (n < Self::CONCURRENT).then_some(slot)
    }
}

/// `GET /api/auth/badge`: the signed-in account badge as an HTML fragment,
/// for a page that signed in without reloading (the in-app sign-in card).
async fn badge_fragment(api: web::Data<Api>, req: HttpRequest) -> Result<HttpResponse> {
    match signed_in(&api, &req).await? {
        Some(user) => Ok(HttpResponse::Ok()
            .insert_header((header::CACHE_CONTROL, "no-store"))
            .content_type("text/html; charset=utf-8")
            .body({
                let raw = api.get_ref().clone();
                let context = blocking(move || {
                    Ok(raw
                        .scoped(
                            &crate::http::Caller::Member(user),
                            crate::http::auth::Credential::Local,
                        )?
                        .context
                        .unwrap())
                })
                .await?;
                account_control(&context)
            })),
        None => Err(ApiError::Unauthorized),
    }
}

/// The account control's stylesheet, scoped to `#ap-account`. Until the page
/// script moves the control into the cookbook header (`account-header.ts`) it
/// is pinned where the header's right end is.
const ACCOUNT_STYLE: &str = r#"<style>
#ap-account{position:relative;display:inline-flex;align-items:center;font:13px/1.45 var(--ap-font,system-ui)}
#ap-account summary{list-style:none}#ap-account summary::-webkit-details-marker{display:none}
#ap-account .ap-acct-btn{display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;border-radius:50%;background:#efefef;color:#333;text-decoration:none;cursor:pointer;position:relative}
#ap-account .ap-acct-btn:hover{background:#e5e5e5}#ap-account .ap-acct-btn:focus-visible{outline:2px solid #141414;outline-offset:3px}
#ap-account .ap-acct-avatar{position:relative;width:32px;height:32px;display:grid;place-items:center;border-radius:50%;overflow:hidden;font-weight:600}
#ap-account img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}#ap-account img[hidden]{display:none}
#ap-account svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.4}
#ap-account .ap-acct-card{position:absolute;z-index:120;right:0;top:calc(100% + 8px);width:220px;max-width:calc(100vw - 32px);padding:4px;background:#fff;border-radius:10px;box-shadow:0 7px 22px rgb(20 30 23 / 13%),0 2px 4px rgb(20 30 23 / 4%);color:#202421;overflow-wrap:anywhere}
#ap-account .ap-acct-identity{padding:4px 8px 5px}#ap-account .ap-acct-identity-top{display:flex;align-items:center;gap:8px;min-width:0}
#ap-account .ap-acct-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;font-weight:600}
#ap-account .ap-acct-email{display:block;color:#656c67;font-size:12px;line-height:17px}
#ap-account .ap-acct-mode{margin-left:auto;flex:none;color:#68716b;font-size:11px;line-height:16px;white-space:nowrap}
#ap-account .ap-acct-actions{margin:3px 2px 0;padding:3px 0 0;border:0;border-top:1px solid #e9ece9}
#ap-account .ap-acct-action{display:flex;align-items:center;width:100%;min-height:26px;padding:3px 8px;border:0;border-radius:5px;background:transparent;color:#303832;font:400 13px/20px var(--ap-font,system-ui);cursor:pointer;text-align:left}
#ap-account .ap-acct-action:hover{background:#edf0ed}#ap-account .ap-acct-action:active{background:#e2e8e2}
#ap-account .ap-acct-action:focus-visible{outline:2px solid #141414;outline-offset:-2px}
#ap-account .ap-acct-action:disabled{opacity:.55;cursor:wait}
@media(pointer:coarse){#ap-account .ap-acct-action{min-height:44px}}
</style>"#;

/// Shared photo/initial control for local and account sessions. No deployment badge.
pub fn account_control(context: &crate::workspaces::AppContext) -> String {
    let Some(profile) = &context.principal else {
        return anonymous_badge(context.auth.allow_demo);
    };
    let name = escape(&profile.display_name);
    let principal_id = escape(&profile.id);
    let initial = escape(
        &profile
            .display_name
            .chars()
            .find(|c| !c.is_whitespace())
            .unwrap_or('?')
            .to_uppercase()
            .to_string(),
    );
    let image = profile
        .avatar_url
        .as_ref()
        .map(|url| {
            format!(
                "<img src=\"{}\" alt=\"\" referrerpolicy=\"no-referrer\" decoding=\"async\">",
                escape(url)
            )
        })
        .unwrap_or_default();
    let email = profile
        .email
        .as_ref()
        .map(|email| format!("<span class=\"ap-acct-email\">{}</span>", escape(email)))
        .unwrap_or_default();
    let permission = if context.capabilities.create_project {
        ""
    } else {
        "<span class=\"ap-acct-mode\">Read-only</span>"
    };
    let logout = if context.auth.can_sign_out {
        "<form class=\"ap-acct-actions\" method=\"post\" action=\"/api/auth/logout\"><button class=\"ap-acct-action\" type=\"submit\">Sign out</button></form>"
    } else {
        ""
    };
    format!(
        "<details id=\"ap-account\" data-signed-in=\"true\" data-principal-id=\"{principal_id}\"><summary class=\"ap-acct-btn\" aria-label=\"Account: {name}\"><span class=\"ap-acct-avatar\" aria-hidden=\"true\">{initial}{image}</span></summary><div class=\"ap-acct-card\"><div class=\"ap-acct-identity\"><div class=\"ap-acct-identity-top\"><span class=\"ap-acct-name\" title=\"{name}\">{name}</span>{permission}</div>{email}</div>{logout}</div></details>{ACCOUNT_STYLE}"
    )
}

/// Compatibility helper; app documents resolve the persisted profile first.
pub fn badge(user: &User) -> String {
    use crate::workspaces::*;
    let write = !user.read_only && !user.demo;
    account_control(&AppContext {
        principal: Some(Profile {
            id: user.id.clone(),
            display_name: user.email.clone(),
            email: Some(user.email.clone()),
            avatar_url: None,
        }),
        workspace: None,
        capabilities: Capabilities {
            read: true,
            create_project: write,
            start_investigation: write,
            approve_proposal: write,
            manage_devices: write,
        },
        auth: AuthOptions {
            can_sign_in: false,
            can_sign_out: true,
            allow_demo: false,
        },
    })
}

pub fn anonymous_badge(demo: bool) -> String {
    format!(
        "<a id=\"ap-account\" data-signed-in=\"false\" data-demo=\"{demo}\" class=\"ap-acct-btn\" href=\"/app\" aria-label=\"Sign in\" title=\"Sign in\"><svg viewBox=\"0 0 20 20\" aria-hidden=\"true\"><circle cx=\"10\" cy=\"7\" r=\"3.25\"/><path d=\"M3.75 16.5c.9-3 3.3-4.5 6.25-4.5s5.35 1.5 6.25 4.5\"/></svg></a>{ACCOUNT_STYLE}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_is_same_site_only() {
        assert_eq!(safe_next(Some("/app/inv_1")), "/app/inv_1");
        // Browsers strip tabs and newlines: these would become //evil.example.
        for bad in [
            "/\t/evil.example",
            "/\n/evil.example",
            "/\r/evil.example",
            "/ /x",
            "/\\evil",
        ] {
            assert_eq!(safe_next(Some(bad)), "/app", "{bad:?}");
        }
        for bad in [
            None,
            Some("https://evil.example"),
            Some("//evil.example"),
            Some("/\\evil"),
            Some("app"),
        ] {
            assert_eq!(safe_next(bad), "/app");
        }
    }

    #[test]
    fn throttle_locks_an_email_and_caps_concurrent_checks() {
        let t = Throttle::default();
        for _ in 0..Throttle::FAILURES {
            assert!(!t.locked("a@b.org"));
            t.fail("a@b.org");
        }
        assert!(t.locked("a@b.org") && !t.locked("c@d.org"));
        t.clear("a@b.org");
        assert!(!t.locked("a@b.org"));
        let held: Vec<_> = (0..Throttle::CONCURRENT)
            .map(|_| t.slot().unwrap())
            .collect();
        assert!(t.slot().is_none());
        drop(held);
        assert!(t.slot().is_some());
    }

    #[test]
    fn badge_escapes_the_email() {
        let user = User {
            id: "u_1".into(),
            email: "a<b>@x.org".into(),
            created: String::new(),
            active: true,
            read_only: false,
            demo: false,
        };
        let html = badge(&user);
        assert!(html.contains("a&lt;b&gt;@x.org") && !html.contains("a<b>"));
    }
}
