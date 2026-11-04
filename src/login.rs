//! Invite-only browser sign-in for `serve --login` (accounts in
//! [`crate::accounts`]). Plain server-rendered pages, so signing in works
//! before the app's bundle loads and needs nothing from `html/`:
//!
//! ```text
//! GET  /login                 email + password form (?next=/app/...)
//! GET  /invite#<token>        choose a password (the token stays out of logs)
//! POST /api/auth/login        form → session cookie, 303 to next
//! POST /api/auth/invite       form → password set, session cookie, 303 /app
//! POST /api/auth/logout       end the session, 303 /login
//! GET  /api/auth/me           {"user": {...}} or 401
//! ```
//!
//! Every form POST must carry one of the daemon's Origins. The app document
//! itself ([`crate::app`]) redirects to `/login` until a session exists and
//! then carries a small account badge ([`badge`]).

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
    cfg.service(
        web::scope("/api/auth")
            .app_data(data.clone())
            .route("/login", web::post().to(login))
            .route("/invite", web::post().to(accept))
            .route("/logout", web::post().to(logout))
            .route("/me", web::get().to(me)),
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
fn safe_next(next: Option<&str>) -> String {
    match next {
        Some(n) if n.starts_with('/') && !n.starts_with("//") && !n.contains('\\') => n.into(),
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
main{width:min(380px,calc(100vw - 32px));background:#fff;border:1px solid #e4e4e4;\
border-radius:14px;padding:28px}\
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 18px;color:#666}\
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}\
input{width:100%;padding:10px 12px;border:1px solid #d6d6d6;border-radius:8px;font:inherit}\
input:focus{outline:2px solid #141414;outline-offset:-1px}\
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;\
background:#141414;color:#fff;font:inherit;font-weight:600;cursor:pointer}\
.err{background:#fdecec;color:#9b1c1c;border-radius:8px;padding:9px 12px;margin:0 0 6px}\
.mark{width:28px;height:28px;border-radius:7px;background:#141414;margin-bottom:16px}\
.alt{margin:18px 0 0;font-size:13px}.alt a{color:#141414}";

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

fn login_form(next: &str, email: &str, error: Option<&str>) -> String {
    let error = error
        .map(|e| format!("<div class=\"err\" role=\"alert\">{}</div>", escape(e)))
        .unwrap_or_default();
    page(
        "Sign in",
        &format!(
            "<h1>Sign in to Autophys</h1><p>Use the email you were invited with.</p>{error}\
             <form method=\"post\" action=\"/api/auth/login\">\
             <input type=\"hidden\" name=\"next\" value=\"{}\">\
             <label for=\"email\">Email</label>\
             <input id=\"email\" name=\"email\" type=\"email\" autocomplete=\"username\" required value=\"{}\" autofocus>\
             <label for=\"password\">Password</label>\
             <input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required>\
             <button type=\"submit\">Sign in</button></form>\
             <p class=\"alt\">No account? <a href=\"/app?source=fixtures\">View the recorded demo</a> \
             (read-only), or go back to <a href=\"/\">the overview</a>.</p>",
            escape(next),
            escape(email)
        ),
    )
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
        login_form(&next, "", None),
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
    let keys = api.keys.clone();
    let typed = email.clone();
    let user = blocking(move || keys.users_check(&typed, &password)).await?;
    let Some(user) = user else {
        return Ok(html(
            actix_web::http::StatusCode::UNAUTHORIZED,
            login_form(
                &next,
                &email,
                Some("That email and password don't match an account."),
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

/// The account badge the app document carries while signed in: the email and
/// a sign-out button, pinned over the right end of the cookbook header (which
/// this app leaves empty). Fixed and on top, so no app layer covers it.
pub fn badge(user: &User) -> String {
    format!(
        "<div id=\"ap-account\" style=\"position:fixed;top:23px;right:24px;z-index:2147483000;\
         display:flex;align-items:center;gap:8px;font:13px/1.2 system-ui,-apple-system,sans-serif;\
         color:#141414;background:#efefef;border-radius:8px;padding:4px 4px 4px 6px\">\
         <span title=\"Signed in\" style=\"display:inline-flex;align-items:center;gap:6px\">\
         <span aria-hidden=\"true\" style=\"width:22px;height:22px;border-radius:50%;background:#141414;\
         color:#fff;display:inline-grid;place-items:center;font-size:11px;font-weight:600\">{initial}</span>\
         <span>{email}</span></span>\
         <form method=\"post\" action=\"/api/auth/logout\" style=\"margin:0\">\
         <button type=\"submit\" style=\"border:0;border-radius:6px;background:#fff;color:#141414;\
         font:inherit;padding:5px 9px;cursor:pointer\">Sign out</button></form></div>",
        initial = escape(
            &user
                .email
                .chars()
                .next()
                .unwrap_or('?')
                .to_uppercase()
                .to_string()
        ),
        email = escape(&user.email),
    )
}

/// The badge a signed-out visitor sees on the public pages (`serve --login`):
/// a read-only note and a way to sign in, where the account badge would be.
pub fn anonymous_badge(label: &str) -> String {
    format!(
        "<div id=\"ap-account\" data-signed-in=\"false\" style=\"position:fixed;top:23px;right:24px;\
         z-index:2147483000;display:flex;align-items:center;gap:8px;\
         font:13px/1.2 system-ui,-apple-system,sans-serif;color:#141414;background:#efefef;\
         border-radius:8px;padding:4px 4px 4px 10px\">\
         <span title=\"Not signed in: the live workbench needs an account\">{}</span>\
         <a href=\"/login?next=/app\" style=\"border-radius:6px;background:#141414;color:#fff;\
         text-decoration:none;padding:5px 9px\">Sign in</a></div>",
        escape(label)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_is_same_site_only() {
        assert_eq!(safe_next(Some("/app/inv_1")), "/app/inv_1");
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
    fn badge_escapes_the_email() {
        let user = User {
            id: "u_1".into(),
            email: "a<b>@x.org".into(),
            created: String::new(),
            active: true,
        };
        let html = badge(&user);
        assert!(html.contains("a&lt;b&gt;@x.org") && !html.contains("a<b>"));
    }
}
