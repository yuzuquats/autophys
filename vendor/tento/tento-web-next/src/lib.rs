//! Build a web application once and select its HTTP server at the executable.

pub mod backend;
mod files;
mod message;
mod routing;

use std::{io, net::TcpListener, path::PathBuf, sync::Arc};

pub use ::http;
pub use cookie;
pub use message::{
  Body, BodyLimitExceeded, FromRequest, HttpRequest, HttpResponse, HttpResponseBuilder, Payload,
  ResponseError,
};
pub use routing::{Guard, RouteDefinition, Router, Scope, build_scope, web};
pub use tento_openapi;
pub use tento_web_router_macros::{NextRouter as Router, next_api as api, next_routes as routes};

/// Application routes and the hostname used by its embedding server.
#[derive(Default)]
pub struct DomainConfig {
  pub hostname: String,
  registrations: Vec<Box<dyn Fn(&mut web::ServiceConfig) + Send + Sync>>,
}

impl DomainConfig {
  pub fn builder() -> DomainBuilder {
    DomainBuilder(Self::default())
  }
}

pub struct DomainBuilder(DomainConfig);

impl DomainBuilder {
  pub fn hostname(mut self, hostname: impl Into<String>) -> Self {
    self.0.hostname = hostname.into();
    self
  }

  pub fn config(
    mut self,
    configure: impl Fn(&mut web::ServiceConfig) + Send + Sync + 'static,
  ) -> Self {
    self.0.registrations.push(Box::new(configure));
    self
  }

  pub fn routes(self, configure: impl Fn() -> web::Scope + Send + Sync + 'static) -> Self {
    self.config(move |cfg| {
      cfg.service(configure());
    })
  }

  pub fn build(self) -> DomainConfig {
    self.0
  }
}

#[derive(Clone)]
pub struct BuildState {
  root: PathBuf,
  module_store_root: Option<PathBuf>,
}

impl BuildState {
  pub fn single_stage(root: PathBuf) -> Self {
    Self {
      root,
      module_store_root: None,
    }
  }

  pub fn with_module_store(mut self, root: PathBuf) -> Self {
    self.module_store_root = Some(root);
    self
  }
}

/// An assembled domain and its prebuilt route tree.
pub struct Webapp {
  routes: web::ServiceConfig,
  files: files::FileRoutes,
}

impl Webapp {
  pub fn prebuilt(domain: &DomainConfig, state: BuildState) -> io::Result<Self> {
    let mut routes = web::ServiceConfig::default();
    for register in &domain.registrations {
      register(&mut routes);
    }
    routes.prepare()?;
    Ok(Self {
      routes,
      files: files::FileRoutes::load(state)?,
    })
  }

  pub async fn call(&self, req: ::http::Request<Body>) -> HttpResponse {
    let head = req.method() == ::http::Method::HEAD;
    let mut response = match self.routes.dispatch(req).await {
      Ok(response) => response,
      Err(req) => self.files.serve(req).await,
    };
    if head {
      *response.body_mut() = Body::empty();
    }
    response
  }
}

pub struct TentoWebServer {
  app: Arc<Webapp>,
  backend: backend::Backend,
}

impl TentoWebServer {
  pub fn new(app: Arc<Webapp>, backend: backend::Backend) -> Self {
    Self { app, backend }
  }

  pub async fn serve(
    self,
    listener: TcpListener,
    shutdown: impl Future<Output = ()> + Send + 'static,
  ) -> io::Result<()> {
    self.backend.serve(listener, self.app, shutdown).await
  }
}
