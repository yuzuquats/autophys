use actix_identity::IdentityExt;
use actix_web::body::{BodySize, MessageBody};
use actix_web::dev::{Service, ServiceRequest, ServiceResponse, Transform};
use actix_web::web::Bytes;
use actix_web::{Error, HttpMessage};
use futures_util::FutureExt;
use futures_util::future::LocalBoxFuture;
use std::future::{Future, Ready, ready};
use std::marker::PhantomData;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::task::{Context, Poll};
use tento_dev::DevMode;
use tracing::Span;
use tracing_actix_web::DefaultRootSpanBuilder;

use super::request_id::RequestId;
use super::root_span::RootSpan;

pub trait RootSpanBuilder {
  fn on_request_start(request: &ServiceRequest) -> Span;
  fn on_request_end<B: MessageBody>(
    span: Span,
    outcome: &Result<ServiceResponse<B>, actix_web::Error>,
  ) {
    use tracing_actix_web::RootSpanBuilder;
    DefaultRootSpanBuilder::on_request_end(span, outcome)
  }
}

pub struct TracingLogger<RootSpan: RootSpanBuilder> {
  root_span_builder: std::marker::PhantomData<RootSpan>,
}

impl<RootSpan: RootSpanBuilder> Clone for TracingLogger<RootSpan> {
  fn clone(&self) -> Self {
    Self::new()
  }
}

impl<RootSpan: RootSpanBuilder> TracingLogger<RootSpan> {
  pub fn new() -> TracingLogger<RootSpan> {
    TracingLogger {
      root_span_builder: Default::default(),
    }
  }
}

impl<S, B, RootSpan> Transform<S, ServiceRequest> for TracingLogger<RootSpan>
where
  S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
  S::Future: 'static,
  B: MessageBody + 'static,
  RootSpan: RootSpanBuilder,
{
  type Response = ServiceResponse<StreamSpan<B>>;
  type Error = Error;
  type Transform = TracingLoggerMiddleware<S, RootSpan>;
  type InitError = ();
  type Future = Ready<Result<Self::Transform, Self::InitError>>;

  fn new_transform(&self, service: S) -> Self::Future {
    ready(Ok(TracingLoggerMiddleware {
      service,
      root_span_builder: std::marker::PhantomData,
    }))
  }
}

#[doc(hidden)]
pub struct TracingLoggerMiddleware<S, RootSpanBuilder> {
  service: S,
  root_span_builder: std::marker::PhantomData<RootSpanBuilder>,
}

#[allow(clippy::type_complexity)]
impl<S, B, RootSpanType> Service<ServiceRequest> for TracingLoggerMiddleware<S, RootSpanType>
where
  B: MessageBody + 'static,
  RootSpanType: RootSpanBuilder,
  S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
  S::Future: 'static,
{
  type Response = ServiceResponse<StreamSpan<B>>;
  type Error = Error;
  type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

  actix_web::dev::forward_ready!(service);

  fn call(&self, req: ServiceRequest) -> Self::Future {
    req.extensions_mut().insert(RequestId::generate());
    let root_span = RootSpanType::on_request_start(&req);

    let root_span_wrapper = RootSpan::new(root_span.clone());
    req.extensions_mut().insert(root_span_wrapper);

    let fut = root_span.in_scope(|| self.service.call(req));

    async move {
      match AssertUnwindSafe(TracingResponse::<S::Future, RootSpanType> {
        fut,
        span: root_span.clone(),
        _root_span_type: std::marker::PhantomData,
      })
      .catch_unwind()
      .await
      {
        Ok(ok) => ok,
        Err(_) => {
          let trace = crate::panic_hook::EXCEPTION.with(|b| b.take()).unwrap();
          root_span.record(
            "exception.trace_json",
            serde_json::to_string(&trace).unwrap(),
          );
          panic!("{}", crate::panic_hook::REPANIC_KEY)
        }
      }
    }
    .boxed_local()
  }
}

#[doc(hidden)]
#[pin_project::pin_project]
pub struct TracingResponse<F, RootSpanType> {
  #[pin]
  fut: F,
  span: Span,
  _root_span_type: std::marker::PhantomData<RootSpanType>,
}

#[doc(hidden)]
#[pin_project::pin_project]
pub struct StreamSpan<B> {
  #[pin]
  body: B,
  span: Span,
}

impl<F, B, RootSpanType> Future for TracingResponse<F, RootSpanType>
where
  F: Future<Output = Result<ServiceResponse<B>, Error>>,
  B: MessageBody + 'static,
  RootSpanType: RootSpanBuilder,
{
  type Output = Result<ServiceResponse<StreamSpan<B>>, Error>;

  fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
    let this = self.project();

    let fut = this.fut;
    let span = this.span;

    span.in_scope(|| match fut.poll(cx) {
      Poll::Pending => Poll::Pending,
      Poll::Ready(outcome) => {
        RootSpanType::on_request_end(Span::current(), &outcome);

        Poll::Ready(outcome.map(|service_response| {
          service_response.map_body(|_, body| StreamSpan {
            body,
            span: span.clone(),
          })
        }))
      }
    })
  }
}

impl<B> MessageBody for StreamSpan<B>
where
  B: MessageBody,
{
  type Error = B::Error;

  fn size(&self) -> BodySize {
    self.body.size()
  }

  fn poll_next(
    self: Pin<&mut Self>,
    cx: &mut Context<'_>,
  ) -> Poll<Option<Result<Bytes, Self::Error>>> {
    let this = self.project();

    let body = this.body;
    let span = this.span;
    span.in_scope(|| body.poll_next(cx))
  }
}

pub struct WithId;
pub struct WithoutId;

pub struct DomainRootSpanBuilder<IncludeId> {
  include_id: PhantomData<IncludeId>,
}

impl RootSpanBuilder for DomainRootSpanBuilder<WithId> {
  fn on_request_start(request: &ServiceRequest) -> Span {
    // NOTE: this cannot be inlined - the root_span! macro will create problematic
    // runtime behaviors by borrowing extensions_mut (a Cell) multiple times.
    //
    let dev_mode = DevMode::extract_from_service_request(request);
    let connecting_ip = connecting_ip(request);
    let email = request.get_identity().map(|id| id.id().ok()).ok().flatten();
    let client_span_id = client_span_id(request);
    let tracing_session_id = tracing_session_id(request);
    crate::root_span!(
      request,
      span.kind = "request",
      user.email = email,
      user.connecting_ip = connecting_ip,
      app.dev_mode = dev_mode.to_str(),
      client.span_id = client_span_id,
      tracing_session.id = tracing_session_id,
    )
  }
}

impl RootSpanBuilder for DomainRootSpanBuilder<WithoutId> {
  fn on_request_start(request: &ServiceRequest) -> Span {
    let dev_mode = DevMode::extract_from_service_request(request);
    let connecting_ip = connecting_ip(request);
    let client_span_id = client_span_id(request);
    let tracing_session_id = tracing_session_id(request);
    crate::root_span!(
      request,
      span.kind = "request",
      user.email = tracing::field::Empty,
      user.connecting_ip = connecting_ip,
      app.dev_mode = dev_mode.to_str(),
      client.span_id = client_span_id,
      tracing_session.id = tracing_session_id,
    )
  }
}

fn connecting_ip(request: &ServiceRequest) -> Option<&str> {
  // Only believe the forwarded-IP header when the direct TCP peer is trusted
  // (loopback / private / Cloudflare egress). An untrusted origin scanner can
  // forge `CF-Connecting-IP`; falling through to `None` here lets the rendered
  // column use the real `http.client_ip` (peer) instead.
  let peer = request.peer_addr()?;
  if !crate::trusted_proxy::is_trusted_proxy(peer.ip()) {
    return None;
  }
  request
    .headers()
    .get("CF-Connecting-IP")
    .and_then(|v| v.to_str().ok())
}

fn client_span_id(request: &ServiceRequest) -> Option<&str> {
  request
    .headers()
    .get("X-Client-Span-Id")
    .and_then(|v| v.to_str().ok())
}

fn tracing_session_id(request: &ServiceRequest) -> Option<&str> {
  request
    .headers()
    .get("X-Tracing-Session-Id")
    .and_then(|v| v.to_str().ok())
}
