use actix::fut::{Ready, ready};
use actix_service::{Service, Transform};
use actix_web::body::BoxBody;

use actix_web::{
  Error, HttpResponse,
  dev::{ServiceRequest, ServiceResponse},
  http,
};

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use crate::utils::root_domain;

/// Middleware for `actix-web` which redirects all `http` requests to `https` with optional url
/// string replacements.
///
/// ## Usage
/// ```
/// use actix_web::{App, web, HttpResponse};
/// use tento_web::middleware::redirect_https::RedirectHTTPS;
///
/// let app = App::new()
///     .wrap(RedirectHTTPS::default())
///     .route("/", web::get().to(|| async {
///         HttpResponse::Ok()
///             .content_type("text/plain")
///             .body("Always HTTPS!")
///     }));
/// ```
#[derive(Default, Clone)]
pub struct RedirectHTTPS {
  replacements: Vec<(String, String)>,
  domains: HashSet<String>,
}

impl RedirectHTTPS {
  pub fn new(domains: HashSet<String>) -> RedirectHTTPS {
    RedirectHTTPS {
      replacements: vec![],
      domains,
    }
  }
}

impl<S> Transform<S, ServiceRequest> for RedirectHTTPS
where
  S: Service<ServiceRequest, Response = ServiceResponse<BoxBody>, Error = Error>,
  S::Future: 'static,
{
  type Response = ServiceResponse<BoxBody>;
  type Error = Error;
  type InitError = ();
  type Transform = RedirectHTTPSService<S>;
  type Future = Ready<Result<Self::Transform, Self::InitError>>;

  fn new_transform(&self, service: S) -> Self::Future {
    ready(Ok(RedirectHTTPSService {
      service,
      replacements: self.replacements.clone(),
      domains: self.domains.clone(),
    }))
  }
}

pub struct RedirectHTTPSService<S> {
  service: S,
  replacements: Vec<(String, String)>,
  domains: HashSet<String>,
}

impl<S> Service<ServiceRequest> for RedirectHTTPSService<S>
where
  S: Service<ServiceRequest, Response = ServiceResponse<BoxBody>, Error = Error>,
  S::Future: 'static,
{
  type Response = ServiceResponse<BoxBody>;
  type Error = Error;
  type Future = Either<S::Future, Ready<Result<Self::Response, Self::Error>>>;

  fn poll_ready(&self, cx: &mut Context) -> Poll<Result<(), Self::Error>> {
    self.service.poll_ready(cx)
  }

  fn call(&self, req: ServiceRequest) -> Self::Future {
    if req.connection_info().scheme() == "https" {
      return Either::Left(self.service.call(req));
    }

    let host_name = req.connection_info().host().to_owned();
    let host_name_base = root_domain(&host_name);
    if !self.domains.contains(host_name_base) {
      return Either::Left(self.service.call(req));
    }

    let uri = req.uri().to_owned();
    let mut url = format!("https://{}{}", host_name, uri);
    for (s1, s2) in self.replacements.iter() {
      url = url.replace(s1, s2);
    }
    Either::Right(ready(Ok(
      req.into_response(
        HttpResponse::MovedPermanently()
          .append_header((http::header::LOCATION, url))
          .finish(),
      ),
    )))
  }
}

#[derive(Debug, Clone)]
pub enum Either<A, B> {
  /// First branch of the type
  Left(/* #[pin] */ A),
  /// Second branch of the type
  Right(/* #[pin] */ B),
}

impl<A, B> Future for Either<A, B>
where
  A: Future,
  B: Future<Output = A::Output>,
{
  type Output = A::Output;

  fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
    match self.as_pin_mut() {
      Either::Left(x) => x.poll(cx),
      Either::Right(x) => x.poll(cx),
    }
  }
}

impl<A, B> Either<A, B> {
  /// Convert `Pin<&mut Either<A, B>>` to `Either<Pin<&mut A>, Pin<&mut B>>`,
  /// pinned projections of the inner variants.
  pub fn as_pin_mut(self: Pin<&mut Self>) -> Either<Pin<&mut A>, Pin<&mut B>> {
    // SAFETY: `get_unchecked_mut` is fine because we don't move anything.
    // We can use `new_unchecked` because the `inner` parts are guaranteed
    // to be pinned, as they come from `self` which is pinned, and we never
    // offer an unpinned `&mut A` or `&mut B` through `Pin<&mut Self>`. We
    // also don't have an implementation of `Drop`, nor manual `Unpin`.
    unsafe {
      match *Pin::get_unchecked_mut(self) {
        Either::Left(ref mut inner) => Either::Left(Pin::new_unchecked(inner)),
        Either::Right(ref mut inner) => Either::Right(Pin::new_unchecked(inner)),
      }
    }
  }
}
