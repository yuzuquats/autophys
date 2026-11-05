//! Invite-only browser sign-in for `serve --login` (accounts in
//! [`crate::accounts`]). Plain server-rendered pages, so signing in works
//! before the app's bundle loads and needs nothing from `html/`:
//!
//! ```text
//! GET  /login                 email + password form (?next=/app/...)
//! GET  /invite#<token>        choose a password (the token stays out of logs)
//! GET  /signup                email + password form for a new account
//! POST /api/auth/signup       form → new account, session cookie, 303 to next
//! POST /api/auth/login        form → session cookie, 303 to next
//! POST /api/auth/invite       form → password set, session cookie, 303 /app
//! POST /api/auth/logout       end the session, 303 /login
//! GET  /api/auth/me           {"user": {...}} or 401
//! ```
//!
//! Every form POST must carry one of the daemon's Origins. The app document
//! itself ([`crate::app`]) redirects to `/login` until a session exists and
//! then carries a small account badge ([`badge`]).

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

/// Register the sign-in pages and `/api/auth/*`. Call before the `/api`
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
            .route("/demo", web::post().to(demo_sign_in))
            .route("/signup", web::post().to(signup)),
    );
    cfg.service(
        web::resource("/signup")
            .app_data(data.clone())
            .route(web::get().to(signup_page)),
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
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f6;\
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
form.demo{margin-top:8px}form.demo button{margin-top:0}button.secondary{background:#efefef;color:#141414}";

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

/// The demo button under the sign-in form, when a demo account exists.
const DEMO_FORM: &str = "<form method=\"post\" action=\"/api/auth/demo\" class=\"demo\">\
<input type=\"hidden\" name=\"next\" value=\"/app\">\
<button type=\"submit\" class=\"secondary\">Continue as demo</button></form>";

fn login_form(next: &str, email: &str, error: Option<&str>, demo: bool) -> String {
    let demo = if demo { DEMO_FORM } else { "" };
    let error = error
        .map(|e| format!("<div class=\"err\" role=\"alert\">{}</div>", escape(e)))
        .unwrap_or_default();
    page(
        "Sign in",
        &format!(
            "<h1>Sign in to Autophys</h1><p>Use the email you signed up or were invited with.</p>{error}\
             <form method=\"post\" action=\"/api/auth/login\">\
             <input type=\"hidden\" name=\"next\" value=\"{}\">\
             <label for=\"email\">Email</label>\
             <input id=\"email\" name=\"email\" type=\"email\" autocomplete=\"username\" required value=\"{}\" autofocus>\
             <label for=\"password\">Password</label>\
             <input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required>\
             <button type=\"submit\">Sign in</button></form>{demo}\
             <p class=\"alt\">New here? <a href=\"/signup?next={}\">Create an account</a> · <a href=\"/\">Back to the overview</a></p>",
            escape(next),
            escape(email),
            escape(next),
        ),
    )
}

fn signup_form(next: &str, email: &str, error: Option<&str>) -> String {
    let error = error
        .map(|e| format!("<div class=\"err\" role=\"alert\">{}</div>", escape(e)))
        .unwrap_or_default();
    page(
        "Create an account",
        &format!(
            "<h1>Create your Autophys account</h1><p>Choose an email and a password.</p>{error}\
             <form method=\"post\" action=\"/api/auth/signup\">\
             <input type=\"hidden\" name=\"next\" value=\"{}\">\
             <label for=\"email\">Email</label>\
             <input id=\"email\" name=\"email\" type=\"email\" autocomplete=\"username\" required value=\"{}\" autofocus>\
             <label for=\"password\">Password</label>\
             <input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"new-password\" minlength=\"{MIN_PASSWORD}\" required>\
             <label for=\"confirm\">Confirm password</label>\
             <input id=\"confirm\" name=\"confirm\" type=\"password\" autocomplete=\"new-password\" minlength=\"{MIN_PASSWORD}\" required>\
             <button type=\"submit\">Create account</button></form>\
             <p class=\"alt\">Already have an account? <a href=\"/login?next={}\">Sign in</a></p>",
            escape(next),
            escape(email),
            escape(next),
        ),
    )
}

async fn signup_page(
    api: web::Data<Api>,
    req: HttpRequest,
    q: web::Query<NextQuery>,
) -> Result<HttpResponse> {
    let next = safe_next(q.next.as_deref());
    if signed_in(&api, &req).await?.is_some() {
        return Ok(see_other(&next));
    }
    Ok(html(
        actix_web::http::StatusCode::OK,
        signup_form(&next, "", None),
    ))
}

#[derive(Deserialize)]
struct SignupForm {
    email: String,
    password: String,
    confirm: String,
    next: Option<String>,
}

/// `POST /api/auth/signup`: create an account and sign it in. No email
/// verification (there is no mailer); an email that already has an account,
/// invited or active, is refused.
async fn signup(
    api: web::Data<Api>,
    req: HttpRequest,
    form: web::Form<SignupForm>,
) -> Result<HttpResponse> {
    form_origin(&req, api.options())?;
    let SignupForm {
        email,
        password,
        confirm,
        next,
    } = form.into_inner();
    let next = safe_next(next.as_deref());
    let again = |status, m: &str| Ok(html(status, signup_form(&next, &email, Some(m))));
    if password != confirm {
        return again(
            actix_web::http::StatusCode::BAD_REQUEST,
            "The two passwords don't match.",
        );
    }
    let throttle = req
        .app_data::<web::Data<Throttle>>()
        .cloned()
        .ok_or_else(|| ApiError::Internal("no sign-in throttle".into()))?;
    let Some(_slot) = throttle.slot() else {
        return again(
            actix_web::http::StatusCode::TOO_MANY_REQUESTS,
            "Autophys is busy signing people in. Try again in a moment.",
        );
    };
    let keys = api.keys.clone();
    let typed = email.clone();
    match blocking(move || keys.users_signup(&typed, &password)).await {
        Ok(user) => start_session(&api, user, &next).await,
        Err(e) if e.status() < 500 => {
            again(actix_web::http::StatusCode::BAD_REQUEST, &e.to_string())
        }
        Err(e) => Err(e),
    }
}

/// Whether the sign-in page offers the demo account.
async fn has_demo(api: &Api) -> bool {
    let keys = api.keys.clone();
    blocking(move || keys.users_demo())
        .await
        .ok()
        .flatten()
        .is_some()
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
             <input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"new-password\" minlength=\"{MIN_PASSWORD}\" required autofocus>\
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

async fn login_page(
    api: web::Data<Api>,
    req: HttpRequest,
    q: web::Query<NextQuery>,
) -> Result<HttpResponse> {
    let next = safe_next(q.next.as_deref());
    if signed_in(&api, &req).await?.is_some() {
        return Ok(see_other(&next));
    }
    Ok(html(
        actix_web::http::StatusCode::OK,
        login_form(&next, "", None, has_demo(&api).await),
    ))
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

async fn login(
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
    let demo = has_demo(&api).await;
    let key = crate::accounts::normalize_email(&email).unwrap_or_else(|_| email.to_lowercase());
    let refuse = |m: &str| {
        Ok(html(
            actix_web::http::StatusCode::TOO_MANY_REQUESTS,
            login_form(&next, &email, Some(m), demo),
        ))
    };
    if throttle.locked(&key) {
        return refuse(
            "Too many sign-in attempts for this email. Wait a few minutes and try again.",
        );
    }
    let Some(_slot) = throttle.slot() else {
        return refuse("Autophys is busy signing people in. Try again in a moment.");
    };
    let keys = api.keys.clone();
    let typed = email.clone();
    let user = blocking(move || keys.users_check(&typed, &password)).await?;
    match &user {
        Some(_) => throttle.clear(&key),
        None => throttle.fail(&key),
    }
    let Some(user) = user else {
        return Ok(html(
            actix_web::http::StatusCode::UNAUTHORIZED,
            login_form(
                &next,
                &email,
                Some("That email and password don't match an account."),
                demo,
            ),
        ));
    };
    start_session(&api, user, &next).await
}

async fn start_session(api: &Api, user: User, to: &str) -> Result<HttpResponse> {
    let keys = api.keys.clone();
    let token = blocking(move || keys.session_start(&user)).await?;
    let mut resp = see_other(to);
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
) -> Result<HttpResponse> {
    form_origin(&req, api.options())?;
    let next = safe_next(form.next.as_deref());
    let keys = api.keys.clone();
    match blocking(move || keys.users_demo()).await? {
        Some(user) => start_session(&api, user, &next).await,
        None => Err(ApiError::not_found("demo account")),
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
        Ok(user) => start_session(&api, user, "/app").await,
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
    let mut resp = see_other("/login");
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
            .body(badge(&user))),
        None => Err(ApiError::Unauthorized),
    }
}

/// The account control's stylesheet, scoped to `#ap-account`. Until the page
/// script moves the control into the cookbook header (`account-header.ts`) it
/// is pinned where the header's right end is.
const ACCOUNT_STYLE: &str = "<style>\
#ap-account{position:fixed;top:22px;right:24px;z-index:2147483000;\
font:13px/1.3 system-ui,-apple-system,sans-serif;color:#141414}\
.ck-nav-links #ap-account{position:relative;top:auto;right:auto;z-index:auto;margin-left:12px}\
#ap-account .ap-acct-btn,#ap-account.ap-acct-btn{display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;\
border-radius:50%;background:transparent;color:inherit;cursor:pointer;text-decoration:none}\
#ap-account .ap-acct-btn:hover,#ap-account .ap-acct-btn:focus-visible,#ap-account.ap-acct-btn:hover,#ap-account.ap-acct-btn:focus-visible{background:rgb(0 0 0/8%)}\
#ap-account .ap-acct-btn:focus-visible,#ap-account.ap-acct-btn:focus-visible{outline:2px solid #141414;outline-offset:1px}\
#ap-account svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6;\
stroke-linecap:round;stroke-linejoin:round}\
#ap-account .ap-acct-avatar{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;\
background:#141414;color:#fff;font-size:12px;font-weight:600}\
#ap-account .ap-acct-tip{position:absolute;right:0;top:100%;padding-top:8px;min-width:200px;\
opacity:0;visibility:hidden;transform:translateY(-4px);\
transition:opacity .14s ease,transform .14s ease,visibility 0s linear .14s}\
#ap-account:hover .ap-acct-tip,#ap-account:focus-within .ap-acct-tip{opacity:1;visibility:visible;\
transform:none;transition-delay:0s}\
#ap-account .ap-acct-card{background:#fff;border-radius:10px;padding:10px 12px;\
box-shadow:0 8px 24px rgb(0 0 0/12%),0 0 0 1px rgb(0 0 0/5%);display:grid;gap:8px}\
#ap-account .ap-acct-email{color:#5b5b5b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}\
#ap-account .ap-acct-mode{justify-self:start;font-size:11px;font-weight:600;color:#7a4a05;background:#fff3d6;border-radius:5px;padding:2px 6px}\
#ap-account .ap-acct-card form{margin:0}\
#ap-account .ap-acct-card button{width:100%;border:0;border-radius:7px;background:#f1f1f1;color:#141414;\
font:600 13px/1 inherit;font-family:inherit;padding:8px 10px;cursor:pointer;text-align:left}\
#ap-account .ap-acct-card button:hover{background:#e6e6e6}\
@media (prefers-reduced-motion:reduce){#ap-account .ap-acct-tip{transition:none}}\
</style>";

/// The account control the app document carries while signed in: an avatar
/// icon in the header; hovering or focusing it shows the email and Sign out.
pub fn badge(user: &User) -> String {
    let email = escape(&user.email);
    let initial = escape(
        &user
            .email
            .chars()
            .next()
            .unwrap_or('?')
            .to_uppercase()
            .to_string(),
    );
    let mode = match (user.demo, user.read_only) {
        (true, true) => "<span class=\"ap-acct-mode\">Demo · read-only</span>",
        (true, false) => "<span class=\"ap-acct-mode\">Demo account</span>",
        (false, true) => "<span class=\"ap-acct-mode\">Read-only</span>",
        (false, false) => "",
    };
    format!(
        "<div id=\"ap-account\" data-signed-in=\"true\">\
         <button type=\"button\" class=\"ap-acct-btn\" aria-label=\"Account: {email}\" aria-haspopup=\"true\">\
         <span class=\"ap-acct-avatar\" aria-hidden=\"true\">{initial}</span></button>\
         <div class=\"ap-acct-tip\"><div class=\"ap-acct-card\">\
         <span class=\"ap-acct-email\" title=\"{email}\">{email}</span>{mode}\
         <form method=\"post\" action=\"/api/auth/logout\"><button type=\"submit\">Sign out</button></form>\
         </div></div></div>{ACCOUNT_STYLE}"
    )
}

/// What a signed-out visitor sees where the account control goes
/// (`serve --login`): an icon-only Sign in button.
pub fn anonymous_badge(demo: bool) -> String {
    format!(
        "<a id=\"ap-account\" data-signed-in=\"false\" data-demo=\"{demo}\" class=\"ap-acct-btn\" href=\"/login?next=/app\" \
         aria-label=\"Sign in\" title=\"Sign in\">\
         <svg viewBox=\"0 0 20 20\" aria-hidden=\"true\"><circle cx=\"10\" cy=\"7\" r=\"3.25\"/>\
         <path d=\"M3.75 16.5c.9-3 3.3-4.5 6.25-4.5s5.35 1.5 6.25 4.5\"/></svg></a>{ACCOUNT_STYLE}"
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
