use actix_identity::Identity;
use actix_web::{HttpRequest, HttpResponse, Responder, http::StatusCode, web};
use tento_web_router::api;

use crate::{
  DeviceAuthDelegate, DeviceAuthError, DeviceAuthErrorKind, DeviceAuthErrorResponse,
  DevicePollRequest, DevicePollResponse, DeviceRequestContext, DeviceStartRequest,
  DeviceStartResponse, DeviceVerifyRequest, DeviceVerifyResponse, LoggedInViewerContext,
  ServiceViewerContext,
};

fn device_error_response(err: DeviceAuthError) -> HttpResponse {
  let status = match err.kind {
    DeviceAuthErrorKind::InvalidRequest => StatusCode::BAD_REQUEST,
    DeviceAuthErrorKind::Unauthorized => StatusCode::UNAUTHORIZED,
    DeviceAuthErrorKind::Forbidden => StatusCode::FORBIDDEN,
    DeviceAuthErrorKind::NotFound => StatusCode::NOT_FOUND,
    DeviceAuthErrorKind::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
    DeviceAuthErrorKind::Conflict => StatusCode::CONFLICT,
    DeviceAuthErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
  };

  HttpResponse::build(status).json(DeviceAuthErrorResponse {
    error: err.code,
    error_description: err.description,
  })
}

#[api(
  responses(
    (status = 200, body = ServiceViewerContext)
  )
)]
pub async fn get_id(vc: ServiceViewerContext) -> impl Responder {
  HttpResponse::Ok().json(vc)
}

#[api(
  responses(
    (status = 200)
  )
)]
pub async fn signout(id: Option<Identity>) -> impl Responder {
  if let Some(identity) = id {
    identity.logout();
  }
  HttpResponse::Ok()
}

#[api(
  request_body = DeviceStartRequest,
  responses(
    (status = 200, body = DeviceStartResponse),
    (status = 400, body = DeviceAuthErrorResponse),
    (status = 500, body = DeviceAuthErrorResponse)
  )
)]
pub async fn device_start(
  request: HttpRequest,
  delegate: web::Data<std::sync::Arc<dyn DeviceAuthDelegate>>,
  body: web::Json<DeviceStartRequest>,
) -> impl Responder {
  let conn = request.connection_info();
  let context = DeviceRequestContext {
    scheme: conn.scheme().to_string(),
    host: conn.host().to_string(),
  };

  match delegate.start(context, body.into_inner()).await {
    Ok(response) => HttpResponse::Ok().json(response),
    Err(err) => device_error_response(err),
  }
}

#[api(
  request_body = DevicePollRequest,
  responses(
    (status = 200, body = DevicePollResponse),
    (status = 400, body = DeviceAuthErrorResponse),
    (status = 429, body = DeviceAuthErrorResponse),
    (status = 500, body = DeviceAuthErrorResponse)
  )
)]
pub async fn device_poll(
  delegate: web::Data<std::sync::Arc<dyn DeviceAuthDelegate>>,
  body: web::Json<DevicePollRequest>,
) -> impl Responder {
  match delegate.poll(body.into_inner()).await {
    Ok(response) => HttpResponse::Ok().json(response),
    Err(err) => device_error_response(err),
  }
}

#[api(
  request_body = DeviceVerifyRequest,
  responses(
    (status = 200, body = DeviceVerifyResponse),
    (status = 400, body = DeviceAuthErrorResponse),
    (status = 401, body = DeviceAuthErrorResponse),
    (status = 404, body = DeviceAuthErrorResponse),
    (status = 500, body = DeviceAuthErrorResponse)
  )
)]
pub async fn device_verify(
  viewer: LoggedInViewerContext,
  delegate: web::Data<std::sync::Arc<dyn DeviceAuthDelegate>>,
  body: web::Json<DeviceVerifyRequest>,
) -> impl Responder {
  match delegate.verify(viewer, body.into_inner()).await {
    Ok(response) => HttpResponse::Ok().json(response),
    Err(err) => device_error_response(err),
  }
}
