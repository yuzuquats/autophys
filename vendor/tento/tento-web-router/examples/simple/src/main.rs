use actix_web::guard::{Guard, GuardContext};
use tento_web_router::Router;

// =============================================================================
// Example Guard
// =============================================================================

/// A simple guard that checks for an "Authorization" header.
/// In a real application, you would validate the token value.
#[derive(Clone)]
pub struct AuthGuard;

impl Guard for AuthGuard {
  fn check(&self, ctx: &GuardContext<'_>) -> bool {
    ctx
      .head()
      .headers
      .get(actix_web::http::header::AUTHORIZATION)
      .is_some()
  }
}

// =============================================================================
// Router with Guard Syntax
// =============================================================================
//
// The `[guard = GuardType]` syntax allows you to protect groups of routes.
// When a guard fails, the route doesn't match (returns 404), hiding protected
// endpoints from unauthorized users.
//
// Routes can be:
// - Public: No guard, accessible to everyone
// - Protected: Inside a `[guard = GuardType]` block
//
// Guards can be nested, with inner guards taking precedence.

#[derive(Router)]
#[router {
  "/api" {
    // Public routes - no authentication required
    "/health" { get: api::health::get::route }
    "/version" { get: api::version::get::route }

    // A mounted sub-router: Widgets' routes are spliced in under the
    // accumulated scope path at the mount site (/api/widgets/*).
    "/widgets" { mount Widgets }

    // Protected routes - require AuthGuard
    [guard = AuthGuard] {
      "/bookings" {
        get: api::booking::get_booking,
        post: api::booking::submit_booking
      }
      "/events" { get }
      "/admin" {
        "/users" { get: api::admin::users::get::route }
        // A mount inside a guarded scope: the enclosing guard applies to the
        // spliced routes (inner guards would win, Widgets has none).
        "/widgets" { mount Widgets }
      }
    }
  }
}]
pub struct Api;

// =============================================================================
// A mountable plugin router
// =============================================================================
//
// A bare top-level item list (no wrapping scope) gets an implicit "" base, so
// its routes stay relative — the host's mount site decides the prefix.

#[derive(Router)]
#[router {
  "/list" { get: api::widgets::list::route }
  "/ping" { get: api::widgets::ping::route }
}]
pub struct Widgets;

fn main() {
  // Print the OpenAPI documentation
  let apis: tento_web_router::tento_openapi::OpenApi = Api::apidoc();
  println!("{}", serde_json::to_string_pretty(&apis).expect(""));

  // Print the flat routes for debugging
  println!("\n--- Flat Routes ---");
  for route in Api::routes() {
    println!("  {} (guarded: {})", route.path, route.has_guard());
  }

  // Mount invariants: spliced paths, declaration-order splice position,
  // enclosing-guard application, and apidoc nesting.
  let routes = Api::routes();
  let paths: Vec<&str> = routes.iter().map(|r| r.path.as_str()).collect();
  assert_eq!(
    paths,
    vec![
      "/api/health",
      "/api/version",
      "/api/widgets/list",
      "/api/widgets/ping",
      "/api/bookings",
      "/api/events",
      "/api/admin/users",
      "/api/admin/widgets/list",
      "/api/admin/widgets/ping",
    ]
  );
  for route in &routes {
    let guarded = route.path.starts_with("/api/bookings")
      || route.path.starts_with("/api/events")
      || route.path.starts_with("/api/admin");
    assert_eq!(
      route.has_guard(),
      guarded,
      "guard mismatch for {}",
      route.path
    );
  }
  let doc_paths = apis.paths.paths;
  for expected in [
    "/api/widgets/list",
    "/api/widgets/ping",
    "/api/admin/widgets/list",
  ] {
    assert!(
      doc_paths.contains_key(expected),
      "apidoc missing {expected}"
    );
  }
  println!("\nmount assertions passed");
}

// =============================================================================
// Handler Modules
// =============================================================================

pub mod api {
  pub mod health {
    pub mod get {
      use actix_web::{HttpResponse, Responder};
      use tento_web_router::api;

      #[api(responses((status = 200)))]
      pub async fn route() -> impl Responder {
        HttpResponse::Ok().body("OK")
      }
    }
  }

  pub mod version {
    pub mod get {
      use actix_web::{HttpResponse, Responder};
      use serde::Serialize;
      use tento_openapi::ToSchema;
      use tento_web_router::api;

      #[derive(Serialize, ToSchema)]
      pub struct VersionInfo {
        version: String,
      }

      #[api(responses((status = 200, body = VersionInfo)))]
      pub async fn route() -> impl Responder {
        HttpResponse::Ok().json(VersionInfo {
          version: "1.0.0".to_string(),
        })
      }
    }
  }

  pub mod events {
    pub mod get {
      use actix_web::{HttpResponse, Responder};
      use tento_web_router::api;

      #[api(responses((status = 200)))]
      pub async fn route() -> impl Responder {
        HttpResponse::Ok()
      }
    }
  }

  pub mod booking {
    use actix_web::{HttpResponse, Responder};
    use serde::{Deserialize, Serialize};
    use tento_openapi::ToSchema;
    use tento_web_router::api;

    #[derive(Serialize, Deserialize, ToSchema)]
    pub struct Booking {
      id: String,
      title: String,
      duration_mins: i32,
    }

    #[derive(Deserialize, ToSchema)]
    #[allow(dead_code)]
    pub struct CreateBooking {
      title: String,
      duration_mins: i32,
    }

    #[api(responses((status = 200, body = Vec<Booking>)))]
    pub async fn get_booking() -> impl Responder {
      HttpResponse::Ok().json(Vec::<Booking>::new())
    }

    #[api(
      responses((status = 201, body = Booking)),
      request_body = CreateBooking
    )]
    pub async fn submit_booking() -> impl Responder {
      HttpResponse::Created().json(Booking {
        id: "123".to_string(),
        title: "New Booking".to_string(),
        duration_mins: 30,
      })
    }
  }

  pub mod widgets {
    pub mod list {
      use actix_web::{HttpResponse, Responder};
      use serde::Serialize;
      use tento_openapi::ToSchema;
      use tento_web_router::api;

      #[derive(Serialize, ToSchema)]
      pub struct Widget {
        id: String,
      }

      #[api(responses((status = 200, body = Vec<Widget>)))]
      pub async fn route() -> impl Responder {
        HttpResponse::Ok().json(Vec::<Widget>::new())
      }
    }

    pub mod ping {
      use actix_web::{HttpResponse, Responder};
      use tento_web_router::api;

      #[api(responses((status = 200)))]
      pub async fn route() -> impl Responder {
        HttpResponse::Ok().body("pong")
      }
    }
  }

  pub mod admin {
    pub mod users {
      pub mod get {
        use actix_web::{HttpResponse, Responder};
        use serde::Serialize;
        use tento_openapi::ToSchema;
        use tento_web_router::api;

        #[derive(Serialize, ToSchema)]
        pub struct User {
          id: String,
          email: String,
        }

        #[api(responses((status = 200, body = Vec<User>)))]
        pub async fn route() -> impl Responder {
          HttpResponse::Ok().json(Vec::<User>::new())
        }
      }
    }
  }
}
