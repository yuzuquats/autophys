//! The `/_/ux-test/token` mint — the one ux-test route that depends on the web
//! app's auth (a logged-in lona user) and the harness secret, so it stays here.
//!
//! The **data** handlers (`pending*`, `logs`, `complete`, `session*`,
//! `sessions`) + their DTOs now live in the `tento-ux-test` crate
//! (`tento_ux_test::http`, behind its `http` feature) — the crate owns the HTTP
//! wire contract. `admin/router.rs` mounts those crate handlers and keeps the
//! unauth-vs-`HarnessTokenGuard` route grouping (the security posture stays in
//! tento-web).

pub mod token {
  pub mod post {
    use actix_web::cookie::Cookie as AwCookie;
    use actix_web::{HttpResponse, Responder, web};
    use tento_web_auth::LoggedInViewerContext;
    use tento_web_router::api;

    use crate::admin::{HARNESS_COOKIE, HarnessSecret};

    /// Mint a ux-test harness token cookie. Requires a logged-in lona user (the
    /// `LoggedInViewerContext` extractor → 401 for anon callers); regular lona
    /// auth gates the *mint*, not the harness routes themselves. The token is
    /// scoped to `Domain=.lona.so` so it fans out to every subdomain and
    /// survives sign-out, letting the in-browser harness reach the ux-test
    /// routes through the anonymous parts of a test flow (e.g. onboarding).
    #[api(responses((status = 200), (status = 401)))]
    pub async fn route(
      _vc: LoggedInViewerContext,
      secret: web::Data<HarnessSecret>,
    ) -> impl Responder {
      let token = secret.generate_token();
      let cookie = AwCookie::build(HARNESS_COOKIE, token)
        .domain(".lona.so")
        .path("/")
        .http_only(true)
        .secure(true)
        .same_site(actix_web::cookie::SameSite::Lax)
        .max_age(actix_web::cookie::time::Duration::hours(12))
        .finish();
      HttpResponse::Ok().cookie(cookie).finish()
    }
  }
}
