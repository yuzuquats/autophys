use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;

use actix::fut::{Ready, ready};
use actix_identity::IdentityExt;
use actix_service::{Service, Transform};
use actix_web::Error;
use actix_web::{
  HttpMessage,
  body::MessageBody,
  dev::{ServiceRequest, ServiceResponse},
};
use futures::future::LocalBoxFuture;

use crate::{LoggedInViewerContext, ViewerContext};

use super::anon_store::AnonViewerContextManager;
use super::logged_in_store::LoggedInViewerContextManager;
use super::viewer_context_json::ViewerContextJson;

/// Trait for resolving Bearer tokens to user IDs.
/// Implement this to add DB-backed API key authentication.
pub trait BearerTokenResolver: Send + Sync + 'static {
  fn resolve_user_id<'a>(
    &'a self,
    token: &'a str,
  ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>>;
}

pub struct ViewerContextMiddlewareBuilder {
  logged_in_store: Option<Arc<LoggedInViewerContextManager>>,
  anon_store: Option<Arc<AnonViewerContextManager>>,
  bearer_resolver: Option<Arc<dyn BearerTokenResolver>>,
  cookie_bearer_auth: bool,
}

impl ViewerContextMiddlewareBuilder {
  pub(crate) fn new() -> Self {
    ViewerContextMiddlewareBuilder {
      logged_in_store: None,
      anon_store: None,
      bearer_resolver: None,
      cookie_bearer_auth: cfg!(debug_assertions),
    }
  }

  pub fn logged_in_store(mut self, store: Arc<LoggedInViewerContextManager>) -> Self {
    self.logged_in_store = Some(store);
    self
  }

  pub fn anon_store(mut self, store: Arc<AnonViewerContextManager>) -> Self {
    self.anon_store = Some(store);
    self
  }

  pub fn bearer_resolver(mut self, resolver: Arc<dyn BearerTokenResolver>) -> Self {
    self.bearer_resolver = Some(resolver);
    self
  }

  /// Accept the bearer token presented as an `x_api_token` COOKIE, not just as
  /// an `Authorization` header.
  ///
  /// The browser cannot put a header on a WebSocket handshake but cookies ride
  /// it automatically, so a harness driving a real browser has no other way to
  /// authenticate the socket — without this, live data never syncs and the app
  /// never boots as a logged-in user.
  ///
  /// OFF in release builds unless an embedder opts in, because a bearer token
  /// in a cookie is sent by the browser on cross-site requests too: that is
  /// CSRF exposure the header path does not have. Turn it on only for a
  /// deployment that exists to be driven by a test harness, and decide it with
  /// the same switch that makes the host answer harness verbs at all — never
  /// as a default, and never on a host serving real users.
  pub fn cookie_bearer_auth(mut self, enabled: bool) -> Self {
    self.cookie_bearer_auth = enabled;
    self
  }

  pub fn build(self) -> ViewerContextMiddleware {
    ViewerContextMiddleware::new(
      self.logged_in_store.expect("An inner store is required"),
      self.anon_store.expect("anon store is required"),
      self.bearer_resolver,
      self.cookie_bearer_auth,
    )
  }
}

#[derive(Clone)]
pub struct ViewerContextMiddleware {
  pub logged_in_store: Arc<LoggedInViewerContextManager>,
  pub anon_store: Arc<AnonViewerContextManager>,
  pub bearer_resolver: Option<Arc<dyn BearerTokenResolver>>,
  pub cookie_bearer_auth: bool,
}

impl ViewerContextMiddleware {
  pub fn builder() -> ViewerContextMiddlewareBuilder {
    ViewerContextMiddlewareBuilder::new()
  }

  pub(crate) fn new(
    logged_in_store: Arc<LoggedInViewerContextManager>,
    anon_store: Arc<AnonViewerContextManager>,
    bearer_resolver: Option<Arc<dyn BearerTokenResolver>>,
    cookie_bearer_auth: bool,
  ) -> Self {
    ViewerContextMiddleware {
      logged_in_store,
      anon_store,
      bearer_resolver,
      cookie_bearer_auth,
    }
  }
}

impl<S, B> Transform<S, ServiceRequest> for ViewerContextMiddleware
where
  S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
  S::Future: 'static,
  B: MessageBody + 'static,
{
  type Response = ServiceResponse<B>;
  type Error = Error;
  type Transform = InnerViewerContextMiddleware<S>;
  type InitError = ();
  type Future = Ready<Result<Self::Transform, Self::InitError>>;

  fn new_transform(&self, service: S) -> Self::Future {
    ready(Ok(InnerViewerContextMiddleware {
      service: Rc::new(service),
      logged_in_store: self.logged_in_store.clone(),
      anon_store: self.anon_store.clone(),
      bearer_resolver: self.bearer_resolver.clone(),
      cookie_bearer_auth: self.cookie_bearer_auth,
    }))
  }
}

#[derive(Clone)]
pub struct InnerViewerContextMiddleware<S> {
  service: Rc<S>,
  logged_in_store: Arc<LoggedInViewerContextManager>,
  anon_store: Arc<AnonViewerContextManager>,
  bearer_resolver: Option<Arc<dyn BearerTokenResolver>>,
  cookie_bearer_auth: bool,
}

impl<S, B> Service<ServiceRequest> for InnerViewerContextMiddleware<S>
where
  S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = actix_web::error::Error>
    + 'static,
  S::Future: 'static,
  B: MessageBody + 'static,
{
  type Response = ServiceResponse<B>;
  type Error = actix_web::error::Error;
  type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

  actix_service::forward_ready!(service);

  fn call(&self, req: ServiceRequest) -> Self::Future {
    let srv = Rc::clone(&self.service);
    let maybe_id = req.get_identity().map(|i| i.id().ok()).ok().flatten();
    let anon_store = self.anon_store.clone();
    let logged_in_store = self.logged_in_store.clone();
    let bearer_resolver = self.bearer_resolver.clone();
    let cookie_bearer_auth = self.cookie_bearer_auth;

    Box::pin(async move {
      // Extract the debug_auth_bypass cookie value once. Validation (HMAC + user binding)
      // happens per-identity below so the cookie cannot be transferred across users.
      use actix_web::http::header::COOKIE;
      let bypass_cookie: Option<String> = req
        .headers()
        .get_all(COOKIE)
        .filter_map(|h| h.to_str().ok())
        .flat_map(|s| s.split(';'))
        .map(|s| s.trim())
        .find_map(|s| s.strip_prefix("debug_auth_bypass="))
        .map(|v| v.to_string());

      // Check Bearer token via resolver (before cookie check)
      if let Some(ref resolver) = bearer_resolver {
        if let Some(raw_token) = req
          .headers()
          .get(actix_web::http::header::AUTHORIZATION)
          .and_then(|h| h.to_str().ok())
          .and_then(|s| s.strip_prefix("Bearer "))
        {
          if let Some(user_id) = resolver.resolve_user_id(raw_token).await {
            let has_bypass = bypass_cookie
              .as_deref()
              .map(|v| logged_in_store.is_debug_bypass(v, &user_id))
              .unwrap_or(false);
            let vc = LoggedInViewerContext {
              id: user_id.clone(),
            };
            req.extensions_mut().insert(vc.clone());
            req.extensions_mut().insert(ViewerContext::User(vc));
            let (auth_expired, data, redirect) = futures::join!(
              async { !has_bypass && logged_in_store.is_user_auth_expired(&user_id).await },
              logged_in_store.find_vc_json(&user_id),
              logged_in_store.redirect_user(&user_id),
            );
            req.extensions_mut().insert(ViewerContextJson::User {
              auth_expired,
              data,
              redirect,
              id: user_id,
            });
            return srv.call(req).await;
          }
        }
      }

      // Accept the same API token via an `x_api_token` cookie so the screenshot
      // harness can authenticate the WebSocket handshake — browsers cannot set
      // the Authorization header on a WS, but cookies ride the handshake
      // automatically. Same resolver / same credential as the header path above.
      //
      // Was `cfg!(debug_assertions)`, which compiled it out of every release
      // build — so a PACKAGED bundle could never be driven as a logged-in user,
      // and a corpus measuring one got the logged-out marketing page instead of
      // the app (release-ci run 20260921T225333Z-fd7d5a: 86 of 95 specs timed
      // out at step -1 with `dispatchApp: undefined`). Acceptance is
      // production-shaped by construction, so a credential that only exists in
      // debug builds can never be exercised by a test of the artifact.
      //
      // Still OFF by default in release: the builder defaults to
      // `cfg!(debug_assertions)`, and only an explicit `cookie_bearer_auth(true)`
      // turns it on. A bearer token in a cookie rides cross-site requests, which
      // the header path does not — that CSRF exposure is why this is opt-in and
      // belongs only on a host that exists to be driven.
      if cookie_bearer_auth {
        if let Some(ref resolver) = bearer_resolver {
          let cookie_token: Option<String> = req
            .headers()
            .get_all(COOKIE)
            .filter_map(|h| h.to_str().ok())
            .flat_map(|s| s.split(';'))
            .map(|s| s.trim())
            .find_map(|s| s.strip_prefix("x_api_token="))
            .map(|v| v.to_string());
          if let Some(raw_token) = cookie_token {
            if let Some(user_id) = resolver.resolve_user_id(&raw_token).await {
              let has_bypass = bypass_cookie
                .as_deref()
                .map(|v| logged_in_store.is_debug_bypass(v, &user_id))
                .unwrap_or(false);
              let vc = LoggedInViewerContext {
                id: user_id.clone(),
              };
              req.extensions_mut().insert(vc.clone());
              req.extensions_mut().insert(ViewerContext::User(vc));
              let (auth_expired, data, redirect) = futures::join!(
                async { !has_bypass && logged_in_store.is_user_auth_expired(&user_id).await },
                logged_in_store.find_vc_json(&user_id),
                logged_in_store.redirect_user(&user_id),
              );
              req.extensions_mut().insert(ViewerContextJson::User {
                auth_expired,
                data,
                redirect,
                id: user_id,
              });
              return srv.call(req).await;
            }
          }
        }
      }

      if let Some(id) = maybe_id {
        let has_bypass = bypass_cookie
          .as_deref()
          .map(|v| logged_in_store.is_debug_bypass(v, &id))
          .unwrap_or(false);
        let vc: LoggedInViewerContext = LoggedInViewerContext { id: id.clone() };
        req.extensions_mut().insert(vc.clone());
        req.extensions_mut().insert(ViewerContext::User(vc));
        let (auth_expired, data, redirect) = futures::join!(
          async { !has_bypass && logged_in_store.is_user_auth_expired(&id).await },
          logged_in_store.find_vc_json(&id),
          logged_in_store.redirect_user(&id),
        );
        req.extensions_mut().insert(ViewerContextJson::User {
          auth_expired,
          data,
          redirect,
          id,
        });
      } else {
        req
          .extensions_mut()
          .insert(ViewerContext::Anon(crate::AnonViewerContext));
        req
          .extensions_mut()
          .insert(ViewerContextJson::Anon(anon_store.find_vc_json()));
      }
      srv.call(req).await
    })
  }
}
