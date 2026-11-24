use std::{io, pin::Pin, sync::Arc};

use http::{Extensions, Method, Request, StatusCode, header};
use percent_encoding::percent_decode_str;
use regex::Regex;

use crate::{
  Body, FromRequest, HttpRequest, HttpResponse, HttpResponseBuilder, ResponseError, message::status,
};

type HandlerFuture = Pin<Box<dyn Future<Output = HttpResponse> + Send>>;
type HandlerFn = Arc<dyn Fn(HttpRequest, Body) -> HandlerFuture + Send + Sync>;

pub trait Responder {
  fn respond(self) -> HttpResponse;
}

impl Responder for HttpResponse {
  fn respond(self) -> HttpResponse {
    self
  }
}

impl<T: Responder, E: ResponseError> Responder for Result<T, E> {
  fn respond(self) -> HttpResponse {
    match self {
      Ok(value) => value.respond(),
      Err(error) => error.error_response(),
    }
  }
}

impl Responder for &'static str {
  fn respond(self) -> HttpResponse {
    HttpResponseBuilder::new(StatusCode::OK)
      .header(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/plain; charset=utf-8"),
      )
      .body(self)
  }
}

pub trait Handler<Args>: Clone + Send + Sync + 'static {
  fn call(&self, req: HttpRequest, body: Body) -> HandlerFuture;
}

macro_rules! handler {
    ($($arg:ident),*) => {
        impl<F, Fut, Output, $($arg,)*> Handler<($($arg,)*)> for F
        where
            F: Fn($($arg),*) -> Fut + Clone + Send + Sync + 'static,
            Fut: Future<Output = Output> + Send + 'static,
            Output: Responder,
            $($arg: FromRequest + 'static,)*
        {
            #[allow(unused_variables, unused_mut)]
            fn call(&self, req: HttpRequest, mut body: Body) -> HandlerFuture {
                let handler = self.clone();
                Box::pin(async move {
                    $(let $arg = match $arg::from_request(&req, &mut body).await {
                        Ok(value) => value,
                        Err(response) => return response,
                    };)*
                    handler($($arg),*).await.respond()
                })
            }
        }
    };
}

#[allow(non_snake_case)]
mod handlers {
  use super::*;

  handler!();
  handler!(A);
  handler!(A, B);
  handler!(A, B, C);
  handler!(A, B, C, D);
  handler!(A, B, C, D, E);
  handler!(A, B, C, D, E, F0);
}

pub trait Guard: Send + Sync + 'static {
  fn check(&self, request: &HttpRequest) -> bool;
}

impl<F: Fn(&HttpRequest) -> bool + Send + Sync + 'static> Guard for F {
  fn check(&self, request: &HttpRequest) -> bool {
    self(request)
  }
}

struct Gate {
  guard: Box<dyn Guard>,
  redirect: Option<header::HeaderValue>,
}

pub struct RouteDefinition {
  path: String,
  routes: Vec<Route>,
  gate: Option<Gate>,
  pattern: Option<PathPattern>,
  claims_path: bool,
  data: Extensions,
  default: Option<HandlerFn>,
}

impl RouteDefinition {
  pub fn new(path: impl Into<String>) -> Self {
    Self {
      path: path.into(),
      routes: Vec::new(),
      gate: None,
      pattern: None,
      claims_path: true,
      data: Extensions::new(),
      default: None,
    }
  }

  pub fn route(mut self, route: Route) -> Self {
    self.routes.push(route);
    self
  }

  pub fn app_data(mut self, data: impl Clone + Send + Sync + 'static) -> Self {
    self.data.insert(data);
    self
  }

  pub fn default_service(mut self, route: Route) -> Self {
    self.default = route.handler;
    self
  }

  fn single(path: &str, route: Route) -> Self {
    Self {
      claims_path: false,
      ..Self::new(path).route(route)
    }
  }

  pub fn guard(mut self, guard: impl Guard) -> Self {
    self.gate = Some(Gate {
      guard: Box::new(guard),
      redirect: None,
    });
    self
  }

  pub fn redirect_guard(mut self, guard: impl Guard, location: &str) -> Self {
    self.gate = Some(Gate {
      guard: Box::new(guard),
      redirect: Some(
        header::HeaderValue::from_str(location).expect("invalid guard redirect location"),
      ),
    });
    self
  }

  pub fn outer_guard(self, guard: impl Guard) -> Self {
    if self.gate.is_some() {
      self
    } else {
      self.guard(guard)
    }
  }

  pub fn outer_redirect_guard(self, guard: impl Guard, location: &str) -> Self {
    if self.gate.is_some() {
      self
    } else {
      self.redirect_guard(guard, location)
    }
  }

  pub fn prefixed(mut self, prefix: &str) -> Self {
    self.path.insert_str(0, prefix);
    self
  }
}

pub trait Router {
  fn routes() -> Vec<RouteDefinition>;
  fn service() -> Scope;
  fn apidoc() -> tento_openapi::OpenApi;
}

pub fn build_scope(prefix: &str, routes: Vec<RouteDefinition>) -> Scope {
  let mut scope = web::scope(prefix);
  for mut route in routes {
    if let Some(relative) = route.path.strip_prefix(prefix) {
      route.path = relative.to_owned();
    }
    scope = scope.service(route);
  }
  scope
}

pub struct Route {
  method: Option<Method>,
  handler: Option<HandlerFn>,
}

impl Route {
  pub fn to<Args>(mut self, handler: impl Handler<Args>) -> Self {
    self.handler = Some(Arc::new(move |req, body| handler.call(req, body)));
    self
  }
}

pub struct Service(Item);

enum Item {
  Resource(RouteDefinition),
  Scope(Scope),
}

impl From<RouteDefinition> for Service {
  fn from(route: RouteDefinition) -> Self {
    Self(Item::Resource(route))
  }
}

impl From<Scope> for Service {
  fn from(scope: Scope) -> Self {
    Self(Item::Scope(scope))
  }
}

#[derive(Default)]
pub struct Scope {
  prefix: String,
  prefix_pattern: Option<Regex>,
  claims_prefix: bool,
  services: Vec<Service>,
  data: Extensions,
  default: Option<HandlerFn>,
}

impl Scope {
  pub fn route(mut self, path: &str, route: Route) -> Self {
    self
      .services
      .push(RouteDefinition::single(path, route).into());
    self
  }

  pub fn service(mut self, service: impl Into<Service>) -> Self {
    self.services.push(service.into());
    self
  }

  pub fn app_data(mut self, data: impl Clone + Send + Sync + 'static) -> Self {
    self.data.insert(data);
    self
  }

  pub fn default_service(mut self, route: Route) -> Self {
    self.default = route.handler;
    self
  }

  pub(crate) fn prepare(&mut self) -> io::Result<()> {
    self.prepare_with_prefix("")
  }

  fn prepare_with_prefix(&mut self, parent: &str) -> io::Result<()> {
    self.prefix.insert_str(0, parent);
    if !self.prefix.is_empty() {
      self.prefix_pattern = Some(PathPattern::prefix(&self.prefix)?.regex);
    }
    for Service(service) in &mut self.services {
      match service {
        Item::Resource(resource) => {
          let mut path = format!("{}{}", self.prefix, resource.path);
          if path.is_empty() {
            path.push('/');
          }
          resource.pattern = Some(PathPattern::new(&path)?);
        }
        Item::Scope(scope) => scope.prepare_with_prefix(&self.prefix)?,
      }
    }
    Ok(())
  }

  pub(crate) async fn dispatch(&self, req: Request<Body>) -> Result<HttpResponse, Request<Body>> {
    let (parts, body) = req.into_parts();
    match self.find(&parts, Extensions::new()) {
      Some(Dispatch::Handler(req, handler)) => Ok(handler(req, body).await),
      Some(Dispatch::Response(response)) => Ok(response),
      None => Err(Request::from_parts(parts, body)),
    }
  }

  fn find<'a>(
    &'a self,
    parts: &http::request::Parts,
    mut data: Extensions,
  ) -> Option<Dispatch<'a>> {
    let path = parts.uri.path();
    if self
      .prefix_pattern
      .as_ref()
      .is_some_and(|prefix| !prefix.is_match(path))
    {
      return None;
    }

    data.extend(self.data.clone());
    for Service(service) in &self.services {
      match service {
        Item::Scope(scope) => {
          if let Some(found) = scope.find(parts, data.clone()) {
            return Some(found);
          }
        }
        Item::Resource(resource) => {
          let Some(params) = resource.pattern.as_ref().expect("prepared").captures(path) else {
            continue;
          };
          let mut route_data = data.clone();
          route_data.extend(resource.data.clone());
          let req = HttpRequest::new(parts.clone(), params, route_data);
          if let Some(gate) = &resource.gate {
            if !gate.guard.check(&req) {
              if let Some(location) = &gate.redirect {
                return Some(Dispatch::Response(
                  HttpResponseBuilder::new(StatusCode::FOUND)
                    .header(header::LOCATION, location.clone())
                    .finish(),
                ));
              }
              continue;
            }
          }
          for route in &resource.routes {
            if route
              .method
              .as_ref()
              .is_none_or(|method| method == parts.method)
            {
              if let Some(handler) = &route.handler {
                return Some(Dispatch::Handler(req, handler));
              }
            }
          }
          if let Some(handler) = &resource.default {
            return Some(Dispatch::Handler(req, handler));
          }
          // A declared resource owns its path, including unsupported methods.
          if resource.claims_path {
            return Some(Dispatch::Response(status(StatusCode::METHOD_NOT_ALLOWED)));
          }
        }
      }
    }
    if let Some(handler) = &self.default {
      return Some(Dispatch::Handler(
        HttpRequest::new(parts.clone(), Vec::new(), data),
        handler,
      ));
    }
    self
      .claims_prefix
      .then(|| Dispatch::Response(status(StatusCode::NOT_FOUND)))
  }
}

enum Dispatch<'a> {
  Handler(HttpRequest, &'a HandlerFn),
  Response(HttpResponse),
}

#[derive(Default)]
pub struct ServiceConfig(Scope);

impl ServiceConfig {
  pub fn route(&mut self, path: &str, route: Route) -> &mut Self {
    self.service(RouteDefinition::single(path, route))
  }

  pub fn service(&mut self, service: impl Into<Service>) -> &mut Self {
    self.0.services.push(service.into());
    self
  }

  pub fn app_data(&mut self, data: impl Clone + Send + Sync + 'static) -> &mut Self {
    self.0.data.insert(data);
    self
  }

  pub(crate) fn prepare(&mut self) -> io::Result<()> {
    self.0.prepare()
  }
  pub(crate) async fn dispatch(
    &self,
    request: Request<Body>,
  ) -> Result<HttpResponse, Request<Body>> {
    self.0.dispatch(request).await
  }
}

pub(crate) struct PathPattern {
  regex: Regex,
  names: Vec<String>,
}

impl PathPattern {
  pub(crate) fn new(path: &str) -> io::Result<Self> {
    Self::compile(path, "")
  }

  fn prefix(path: &str) -> io::Result<Self> {
    let suffix = if path.ends_with('/') {
      ".*"
    } else {
      "(?:/.*)?"
    };
    Self::compile(path, suffix)
  }

  fn compile(path: &str, suffix: &str) -> io::Result<Self> {
    let mut remainder = path;
    let mut expression = String::from(r"\A");
    let mut names = Vec::new();
    while let Some((literal, capture)) = remainder.split_once('{') {
      expression.push_str(&regex::escape(literal));
      let mut nesting = 0;
      let mut escaped = false;
      let mut in_class = false;
      let end = capture
        .char_indices()
        .find_map(|(index, ch)| {
          if escaped {
            escaped = false;
            return None;
          }
          match ch {
            '\\' => escaped = true,
            '[' => in_class = true,
            ']' => in_class = false,
            '{' if !in_class => nesting += 1,
            '}' if !in_class && nesting == 0 => return Some(index),
            '}' if !in_class => nesting -= 1,
            _ => {}
          }
          None
        })
        .ok_or_else(|| invalid_path(path, "missing closing brace"))?;
      let (name, pattern) = capture[..end]
        .split_once(':')
        .unwrap_or((&capture[..end], "[^/]+"));
      if name.is_empty() || names.iter().any(|existing| existing == name) {
        return Err(invalid_path(path, "empty or repeated parameter name"));
      }
      use std::fmt::Write as _;
      write!(expression, "(?P<p{}>{pattern})", names.len()).expect("writing a String");
      names.push(name.to_owned());
      remainder = &capture[end + 1..];
    }
    expression.push_str(&regex::escape(remainder));
    expression.push_str(suffix);
    expression.push_str(r"\z");
    let regex = Regex::new(&expression).map_err(|err| invalid_path(path, err))?;
    Ok(Self { regex, names })
  }

  pub(crate) fn captures(&self, path: &str) -> Option<Vec<(String, String)>> {
    let captures = self.regex.captures(path)?;
    self
      .names
      .iter()
      .enumerate()
      .map(|(index, name)| {
        let value = captures.name(&format!("p{index}"))?.as_str();
        Some((
          name.clone(),
          percent_decode_str(value).decode_utf8().ok()?.into_owned(),
        ))
      })
      .collect()
  }
}

fn invalid_path(path: &str, error: impl std::fmt::Display) -> io::Error {
  io::Error::new(
    io::ErrorKind::InvalidInput,
    format!("route {path:?}: {error}"),
  )
}

pub mod web {
  pub use super::{Handler, Responder, Route, Scope, ServiceConfig};
  pub use crate::message::{Data, Form, Json, Path, Payload, PayloadConfig, Query};
  pub use bytes::Bytes;
  use http::Method;

  pub async fn block<F, T>(work: F) -> Result<T, tokio::task::JoinError>
  where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
  {
    tokio::task::spawn_blocking(work).await
  }

  pub fn scope(prefix: &str) -> Scope {
    Scope {
      prefix: prefix.to_owned(),
      claims_prefix: true,
      ..Scope::default()
    }
  }
  pub fn resource(path: impl Into<String>) -> super::RouteDefinition {
    super::RouteDefinition::new(path)
  }
  pub fn route() -> Route {
    Route {
      method: None,
      handler: None,
    }
  }
  pub fn to<Args>(handler: impl Handler<Args>) -> Route {
    route().to(handler)
  }
  pub fn method(method: Method) -> Route {
    Route {
      method: Some(method),
      handler: None,
    }
  }
  pub fn get() -> Route {
    method(Method::GET)
  }
  pub fn head() -> Route {
    method(Method::HEAD)
  }
  pub fn post() -> Route {
    method(Method::POST)
  }
  pub fn put() -> Route {
    method(Method::PUT)
  }
  pub fn patch() -> Route {
    method(Method::PATCH)
  }
  pub fn delete() -> Route {
    method(Method::DELETE)
  }
}
