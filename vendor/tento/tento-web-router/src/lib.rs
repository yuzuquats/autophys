pub use tento_web_router_macros::*;

pub use tento_openapi;
pub use tento_openapi::{IntoParams, ToSchema};

use actix_web::body::BoxBody;
use actix_web::dev::{Service, ServiceRequest, ServiceResponse, Transform};
use actix_web::guard::{Guard, GuardContext};
use actix_web::http::{Method, header};
use actix_web::{Error, HttpResponse, web};
use std::future::{Future, Ready, ready};
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::task::{Context, Poll};

/// A handler function type that can be registered with actix-web.
pub type HandlerFn = fn() -> actix_web::Route;

/// A wrapper around boxed guards that implements Guard.
struct BoxedGuard(Box<dyn Guard>);

impl Guard for BoxedGuard {
  fn check(&self, ctx: &GuardContext<'_>) -> bool {
    self.0.check(ctx)
  }
}

/// A flat route definition with an optional guard and an optional
/// guard-redirect (the `else { redirect(...) }` fail mode).
pub struct RouteDefinition {
  pub path: String,
  pub routes: Vec<(Method, HandlerFn)>,
  /// Plain guard: when it fails, the resource does not match → 404 (hidden).
  guard: Option<BoxedGuard>,
  /// Redirect-on-fail: `(guard, location)`. The resource is registered WITHOUT
  /// a guard (so it always matches its path) and wrapped in `GuardRedirect`,
  /// which evaluates the guard and 302-redirects to `location` on failure.
  redirect: Option<(Arc<dyn Guard>, String)>,
}

impl RouteDefinition {
  pub fn new(path: impl Into<String>) -> Self {
    Self {
      path: path.into(),
      routes: Vec::new(),
      guard: None,
      redirect: None,
    }
  }

  pub fn route(mut self, method: Method, handler: HandlerFn) -> Self {
    self.routes.push((method, handler));
    self
  }

  pub fn guard<G: Guard + 'static>(mut self, guard: G) -> Self {
    self.guard = Some(BoxedGuard(Box::new(guard)));
    self
  }

  /// `[guard = G] { … } else { redirect(location) }`: gate the routes on `G`,
  /// but redirect (302) to `location` on failure instead of 404ing.
  pub fn redirect_guard<G: Guard + 'static>(
    mut self,
    guard: G,
    location: impl Into<String>,
  ) -> Self {
    self.redirect = Some((Arc::new(guard), location.into()));
    self
  }

  pub fn has_guard(&self) -> bool {
    self.guard.is_some() || self.redirect.is_some()
  }

  /// Prepend `prefix` to the path. Verbatim string concatenation — the same
  /// join convention the DSL flattening uses — so a mounted sub-router's
  /// relative paths compose into the host's full paths.
  pub fn prefixed(mut self, prefix: &str) -> Self {
    self.path = format!("{prefix}{}", self.path);
    self
  }

  /// Apply an enclosing scope's guard, unless this definition already carries
  /// its own (inner wins — the same precedence flattening gives nested guarded
  /// scopes). Used when splicing a mounted sub-router into a guarded scope.
  pub fn outer_guard<G: Guard + 'static>(self, guard: G) -> Self {
    if self.has_guard() {
      self
    } else {
      self.guard(guard)
    }
  }

  /// Redirect-on-fail variant of [`Self::outer_guard`]: apply the enclosing
  /// scope's `[guard = G] { … } else { redirect(location) }` unless an inner
  /// guard is already present.
  pub fn outer_redirect_guard<G: Guard + 'static>(
    self,
    guard: G,
    location: impl Into<String>,
  ) -> Self {
    if self.has_guard() {
      self
    } else {
      self.redirect_guard(guard, location)
    }
  }
}

/// Builds an actix-web Scope from a list of RouteDefinitions.
///
/// One resource per path. A plain `guard` 404s on failure; a `redirect_guard`
/// wraps the resource in [`GuardRedirect`] so failures 302 to the location.
pub fn build_scope(base_path: &str, routes: Vec<RouteDefinition>) -> actix_web::Scope {
  let mut scope = web::scope(base_path);

  for route_def in routes {
    // Strip the base path prefix to get the relative path
    let relative_path = route_def
      .path
      .strip_prefix(base_path)
      .unwrap_or(&route_def.path);
    let relative_path = if relative_path.is_empty() {
      ""
    } else {
      relative_path
    };

    let mut resource = web::resource(relative_path);
    for (_method, handler) in route_def.routes {
      resource = resource.route(handler());
    }

    // `.wrap(...)` changes the resource's type, so each branch must consume the
    // resource into `.service(...)` immediately rather than reassigning it.
    if let Some((guard, location)) = route_def.redirect {
      scope = scope.service(resource.wrap(GuardRedirect::new(guard, location)));
    } else if let Some(guard) = route_def.guard {
      scope = scope.service(resource.guard(guard));
    } else {
      scope = scope.service(resource);
    }
  }

  scope
}

/// Middleware emitted for a `[guard = G] { … } else { redirect(location) }`
/// scope. Evaluates `G` against each request (via `ServiceRequest::guard_ctx`)
/// and, on failure, short-circuits with a 302 to `location` instead of letting
/// the request fall through to a 404.
#[derive(Clone)]
pub struct GuardRedirect {
  guard: Arc<dyn Guard>,
  location: Rc<str>,
}

impl GuardRedirect {
  pub fn new(guard: Arc<dyn Guard>, location: impl Into<String>) -> Self {
    Self {
      guard,
      location: Rc::from(location.into().as_str()),
    }
  }
}

impl<S> Transform<S, ServiceRequest> for GuardRedirect
where
  S: Service<ServiceRequest, Response = ServiceResponse<BoxBody>, Error = Error> + 'static,
  S::Future: 'static,
{
  type Response = ServiceResponse<BoxBody>;
  type Error = Error;
  type InitError = ();
  type Transform = GuardRedirectService<S>;
  type Future = Ready<Result<Self::Transform, Self::InitError>>;

  fn new_transform(&self, service: S) -> Self::Future {
    ready(Ok(GuardRedirectService {
      service,
      guard: self.guard.clone(),
      location: self.location.clone(),
    }))
  }
}

pub struct GuardRedirectService<S> {
  service: S,
  guard: Arc<dyn Guard>,
  location: Rc<str>,
}

impl<S> Service<ServiceRequest> for GuardRedirectService<S>
where
  S: Service<ServiceRequest, Response = ServiceResponse<BoxBody>, Error = Error> + 'static,
  S::Future: 'static,
{
  type Response = ServiceResponse<BoxBody>;
  type Error = Error;
  type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>>>>;

  fn poll_ready(&self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
    self.service.poll_ready(cx)
  }

  fn call(&self, req: ServiceRequest) -> Self::Future {
    if self.guard.check(&req.guard_ctx()) {
      Box::pin(self.service.call(req))
    } else {
      let resp = req.into_response(
        HttpResponse::Found()
          .insert_header((header::LOCATION, self.location.as_ref()))
          .finish(),
      );
      Box::pin(ready(Ok(resp)))
    }
  }
}

pub trait Router {
  /// Returns the flat list of route definitions.
  fn routes() -> Vec<RouteDefinition>;

  /// Returns an actix-web Scope built from the routes.
  /// Default implementation calls build_scope with the routes.
  fn service() -> actix_web::Scope;

  /// Returns the OpenAPI documentation for this router.
  fn apidoc() -> tento_openapi::OpenApi;
}

#[cfg(test)]
mod tests {
  use super::*;
  use actix_web::{App, HttpResponse, http::StatusCode, test, web};

  /// A test guard that passes only when the request carries `x-allow: yes`.
  #[derive(Clone)]
  struct HeaderGuard;
  impl Guard for HeaderGuard {
    fn check(&self, ctx: &GuardContext<'_>) -> bool {
      ctx
        .head()
        .headers
        .get("x-allow")
        .and_then(|v| v.to_str().ok())
        == Some("yes")
    }
  }

  fn ok_route() -> actix_web::Route {
    web::get().to(|| async { HttpResponse::Ok().body("ok") })
  }

  /// `redirect_guard` (the `else { redirect("…") }` mode): guard fails ⇒ 302 to
  /// the location; guard passes ⇒ the handler runs.
  #[actix_web::test]
  async fn redirect_guard_redirects_on_fail_and_passes_when_allowed() {
    let app = test::init_service(App::new().service(build_scope(
      "/admin",
      vec![
        RouteDefinition::new("/admin/page")
          .route(Method::GET, ok_route)
          .redirect_guard(HeaderGuard, "/admin/signin"),
      ],
    )))
    .await;

    let resp = test::call_service(
      &app,
      test::TestRequest::get().uri("/admin/page").to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::FOUND);
    assert_eq!(
      resp.headers().get("location").unwrap().to_str().unwrap(),
      "/admin/signin"
    );

    let allowed = test::TestRequest::get()
      .uri("/admin/page")
      .insert_header(("x-allow", "yes"))
      .to_request();
    let resp = test::call_service(&app, allowed).await;
    assert_eq!(resp.status(), StatusCode::OK);
  }

  /// Plain `guard` (no `else`): guard fails ⇒ the resource does not match ⇒ 404;
  /// guard passes ⇒ the handler runs. (Regression guard for the unchanged path.)
  #[actix_web::test]
  async fn plain_guard_404s_on_fail_and_passes_when_allowed() {
    let app = test::init_service(App::new().service(build_scope(
      "/admin",
      vec![
        RouteDefinition::new("/admin/api")
          .route(Method::GET, ok_route)
          .guard(HeaderGuard),
      ],
    )))
    .await;

    let resp = test::call_service(
      &app,
      test::TestRequest::get().uri("/admin/api").to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    let allowed = test::TestRequest::get()
      .uri("/admin/api")
      .insert_header(("x-allow", "yes"))
      .to_request();
    let resp = test::call_service(&app, allowed).await;
    assert_eq!(resp.status(), StatusCode::OK);
  }

  /// `prefixed` composes a mounted sub-router's relative path into the host's
  /// full path by verbatim concatenation. (async: `use actix_web::test` shadows
  /// the built-in `#[test]` in this module.)
  #[actix_web::test]
  async fn prefixed_prepends_verbatim() {
    let def = RouteDefinition::new("/rate").prefixed("/api/atoms");
    assert_eq!(def.path, "/api/atoms/rate");
  }

  #[actix_web::test]
  async fn empty_base_scope_captures_path_miss() {
    let app = test::init_service(
      App::new()
        .service(build_scope(
          "",
          vec![RouteDefinition::new("/api/ping").route(Method::GET, ok_route)],
        ))
        .route(
          "/",
          web::get().to(|| async { HttpResponse::Ok().body("fallback") }),
        ),
    )
    .await;

    let resp = test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
  }

  /// `outer_guard` applies only when no inner guard exists (inner wins), and
  /// a guarded route spliced through `outer_guard` still enforces its own.
  #[actix_web::test]
  async fn outer_guard_defers_to_inner() {
    // No inner guard → the outer guard applies (404 without the header).
    let outer_applied = RouteDefinition::new("/a")
      .route(Method::GET, ok_route)
      .outer_guard(HeaderGuard);
    assert!(outer_applied.has_guard());

    // Inner guard present → outer_guard is a no-op; the redirect (inner) wins
    // over the plain guard (outer): failing requests 302 instead of 404ing.
    let app = test::init_service(App::new().service(build_scope(
      "/m",
      vec![
        RouteDefinition::new("/m/b")
          .route(Method::GET, ok_route)
          .redirect_guard(HeaderGuard, "/signin")
          .outer_guard(HeaderGuard),
      ],
    )))
    .await;
    let resp = test::call_service(&app, test::TestRequest::get().uri("/m/b").to_request()).await;
    assert_eq!(resp.status(), StatusCode::FOUND);
  }
}
