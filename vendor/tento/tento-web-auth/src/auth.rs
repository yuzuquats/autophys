use actix_web::{cookie::Key, web};
use std::sync::Arc;
use tento_web_router::Router;

use crate::{
  api::Api,
  device_auth::DeviceAuthDelegate,
  viewer_context::{
    anon_store::{AnonViewerContextManager, AnonViewerContextStore},
    logged_in_store::{LoggedInViewerContextManager, LoggedInViewerContextStore},
    middleware::{BearerTokenResolver, ViewerContextMiddleware},
  },
};

#[derive(Clone)]
pub struct Auth {
  pub(crate) logged_in_store: Option<Arc<LoggedInViewerContextManager>>,
  pub(crate) anon_store: Option<Arc<AnonViewerContextManager>>,
  pub(crate) device_auth_delegate: Option<Arc<dyn DeviceAuthDelegate>>,
  pub(crate) bearer_resolver: Option<Arc<dyn BearerTokenResolver>>,
  pub(crate) cookie_bearer_auth: bool,
}

impl Auth {
  pub fn builder() -> AuthBuilder {
    AuthBuilder::new()
  }
}

impl Auth {
  fn new(
    logged_in_store: Option<Arc<LoggedInViewerContextManager>>,
    anon_store: Option<Arc<AnonViewerContextManager>>,
    device_auth_delegate: Option<Arc<dyn DeviceAuthDelegate>>,
    bearer_resolver: Option<Arc<dyn BearerTokenResolver>>,
    cookie_bearer_auth: bool,
  ) -> Auth {
    Auth {
      logged_in_store,
      anon_store,
      device_auth_delegate,
      bearer_resolver,
      cookie_bearer_auth,
    }
  }

  pub fn config(&self, c: &mut web::ServiceConfig) {
    if let Some(delegate) = self.device_auth_delegate.clone() {
      c.app_data(web::Data::new(delegate));
    }
    c.service(Api::service());
  }

  pub fn viewer_context_mw(&self) -> ViewerContextMiddleware {
    let mut builder = ViewerContextMiddleware::builder();
    if let Some(logged_in_store) = self.logged_in_store.clone() {
      builder = builder.logged_in_store(logged_in_store);
    };
    if let Some(anon_store) = self.anon_store.clone() {
      builder = builder.anon_store(anon_store);
    };
    if let Some(resolver) = self.bearer_resolver.clone() {
      builder = builder.bearer_resolver(resolver);
    };
    builder = builder.cookie_bearer_auth(self.cookie_bearer_auth);
    builder.build()
  }
}

pub struct AuthBuilder {
  pub session_key: Option<Key>,
  pub logged_in_store: Option<Arc<LoggedInViewerContextManager>>,
  pub anon_store: Option<Arc<AnonViewerContextManager>>,
  pub device_auth_delegate: Option<Arc<dyn DeviceAuthDelegate>>,
  pub bearer_resolver: Option<Arc<dyn BearerTokenResolver>>,
  pub cookie_bearer_auth: bool,
}

impl AuthBuilder {
  pub(crate) fn new() -> AuthBuilder {
    AuthBuilder {
      session_key: None,
      logged_in_store: None,
      anon_store: None,
      device_auth_delegate: None,
      bearer_resolver: None,
      cookie_bearer_auth: cfg!(debug_assertions),
    }
  }

  pub fn session_key(mut self, key: Key) -> Self {
    self.session_key = Some(key);
    self
  }

  pub fn logged_in_store(mut self, manager: Arc<dyn LoggedInViewerContextStore>) -> AuthBuilder {
    self.logged_in_store = Some(Arc::new(LoggedInViewerContextManager::new(manager)));
    self
  }

  pub fn anon_store(mut self, manager: Arc<dyn AnonViewerContextStore>) -> AuthBuilder {
    self.anon_store = Some(Arc::new(AnonViewerContextManager::new(manager)));
    self
  }

  pub fn device_auth_delegate(mut self, delegate: Arc<dyn DeviceAuthDelegate>) -> AuthBuilder {
    self.device_auth_delegate = Some(delegate);
    self
  }

  pub fn bearer_resolver(mut self, resolver: Arc<dyn BearerTokenResolver>) -> AuthBuilder {
    self.bearer_resolver = Some(resolver);
    self
  }

  /// See `ViewerContextMiddlewareBuilder::cookie_bearer_auth`. Defaults to
  /// `cfg!(debug_assertions)`; an embedder that says nothing keeps the old
  /// behaviour exactly.
  pub fn cookie_bearer_auth(mut self, enabled: bool) -> AuthBuilder {
    self.cookie_bearer_auth = enabled;
    self
  }

  pub fn build(self) -> Auth {
    Auth::new(
      self.logged_in_store,
      self.anon_store,
      self.device_auth_delegate,
      self.bearer_resolver,
      self.cookie_bearer_auth,
    )
  }
}
