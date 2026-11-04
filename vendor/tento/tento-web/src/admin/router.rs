use crate::admin::{AdminGuard, HarnessTokenGuard};
use tento_web_router::Router;

#[derive(Router)]
#[router {
  "/_" {
    "/app" {
      "/version" { get: super::get_bundle_version }
      "/ping" { get: super::ping }
    }
    "/ux-test" {
      // Mint the harness cookie. The handler's `LoggedInViewerContext`
      // extractor requires a logged-in lona user (401 for anon) — regular lona
      // auth gates the *mint*, not the harness routes. Issues a `.lona.so`
      // HMAC cookie the in-browser harness then carries through anon flows.
      "/token" { post: super::ux_test::token::post::route }

      // Log WRITES are intentionally unauthenticated. The harness posts logs
      // (and the terminal `complete`) from anonymous surfaces too — e.g. the
      // `/trynow` → `/signin` prefix of an onboarding test, before the user is
      // logged in and the harness cookie can be minted. These are write-only to
      // an opaque, server-minted session id (no read-back), so leaving them open
      // is low-risk; everything that READS, LISTS, or DELETES stays gated below.
      // (The fully-gated alternative is a CLI-minted `?ht=` launch token — see
      // the ux-test-harness-auth project doc.)
      "/logs" { post: tento_ux_test::http::logs::post::route }
      "/complete" { post: tento_ux_test::http::complete::post::route }
      // Idempotent step set-state — same write-only-to-opaque-id reasoning as
      // `/logs` above; step checks happen on anonymous signin surfaces too.
      "/step" { post: tento_ux_test::http::step::post::route }
      // Skip's terminal write, same reasoning as `complete` above: a skip can
      // happen on an anonymous surface, and a skip the server never hears about
      // leaves the session `pending` forever.
      "/abandon" { post: tento_ux_test::http::abandon::post::route }

      // Read/list/delete routes: gated by the HMAC harness cookie
      // (HarnessTokenGuard). The unauthenticated internet 404s (no `else`
      // redirect — these are hidden); the harness, having minted the cookie at
      // its logged-in launch, passes even through later anonymous navigation.
      // The operator's in-app UX-test manager (`ux-tests-modal.ts`, opened via
      // spotlight / `=`) lists + deletes sessions through these same routes via
      // the harness API, so `/sessions*` lives here (a logged-in lona operator,
      // not necessarily an admin) rather than under AdminGuard.
      [guard = HarnessTokenGuard] {
        "/pending" { get: tento_ux_test::http::pending::get::route }
        "/pending-count" { get: tento_ux_test::http::pending_count::get::route }
        "/pending-flaky" { get: tento_ux_test::http::pending_flaky::get::route }
        "/session" {
          "/{session_id}" { get: tento_ux_test::http::session::get::route }
        }
        "/sessions" {
          "" { get: tento_ux_test::http::sessions::get::route }
          "/{session_id}" { delete: tento_ux_test::http::sessions::delete::route }
          "/{session_id}/logs" { get: tento_ux_test::http::session_logs::get::route }
        }
      }
    }
    "/admin" {
      // Public (unbracketed) — the sign-in flow, no auth.
      "/signin" {
        get: super::api::signin::get::route,
        post: super::api::signin::post::route
      }
      "/verify" { get: super::api::verify::get::route }
      "/denied" { get: super::api::denied::get::route }
      "/invalid" { get: super::api::invalid::get::route }
      "/2fac" { post: super::api::two_fac::post::route }

      // Gated HTML pages: AdminGuard validates the session; an unauthenticated
      // request 302s to sign-in (`else`) rather than 404ing. Handlers carry no
      // auth logic — the guard is the single gate.
      [guard = AdminGuard] {
        ""          { get: super::api::dashboard::get::route }
        "/logs"     { get: super::api::logs::get::route }
        "/routes"   { get: super::api::routes_page::get::route }
        "/ux-tests" { get: super::api::ux_tests_page::get::route }
      } else { redirect("/_/admin/signin") }

      // Gated JSON APIs: an unauthenticated request 404s (hidden), no redirect.
      [guard = AdminGuard] {
        "/health" { get: super::api::health::get::route }
        "/api/routes" { get: super::api::routes::get::route }
        "/api/ux-test" {
          "/sessions" { get: tento_ux_test::http::sessions::get::route }
          "/sessions/{session_id}/logs" { get: tento_ux_test::http::session_logs::get::route }
        }
      }
    }
  }
}]
pub struct SystemRouter;

#[cfg(test)]
mod tests {
  use super::*;
  use tento_web_router::Router;

  #[test]
  fn test_system_router_openapi_includes_routes() {
    let api = SystemRouter::apidoc();
    let paths: Vec<_> = api.paths.paths.keys().collect();
    println!("SystemRouter paths: {:?}", paths);

    // App routes
    assert!(
      paths.contains(&&"/_/app/version".to_string()),
      "Missing /_/app/version"
    );
    assert!(
      paths.contains(&&"/_/app/ping".to_string()),
      "Missing /_/app/ping"
    );

    // Fleet routes are an app's own (`tento-fleet-web`), not tento-web's.
    assert!(
      !paths.iter().any(|p| p.starts_with("/_/fleet")),
      "tento-web must not serve the fleet surface"
    );

    // Admin routes
    assert!(paths.contains(&&"/_/admin".to_string()), "Missing /_/admin");
    assert!(
      paths.contains(&&"/_/admin/health".to_string()),
      "Missing /_/admin/health"
    );
    assert!(
      paths.contains(&&"/_/admin/api/routes".to_string()),
      "Missing /_/admin/api/routes"
    );
  }
}
