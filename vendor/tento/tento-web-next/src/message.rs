use std::{
  io,
  ops::{Deref, DerefMut},
  pin::Pin,
  sync::Arc,
};

use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream};
use http::{Extensions, HeaderMap, Method, StatusCode, Uri, header, request::Parts};
use serde::Serialize;

pub struct Body(Pin<Box<dyn Stream<Item = io::Result<Bytes>> + Send>>);

impl Body {
  pub fn empty() -> Self {
    Self::stream(stream::empty())
  }

  pub fn bytes(bytes: impl Into<Bytes>) -> Self {
    let bytes = bytes.into();
    Self::stream(stream::iter([Ok(bytes)]))
  }

  pub fn stream(stream: impl Stream<Item = io::Result<Bytes>> + Send + 'static) -> Self {
    Self(Box::pin(stream))
  }

  pub fn into_stream(self) -> impl Stream<Item = io::Result<Bytes>> + Send + Unpin {
    self.0
  }
}

/// An extracted streaming request body and its size-limited collector.
pub type Payload = Body;

pub struct BodyLimitExceeded;

impl Body {
  pub async fn to_bytes_limited(
    self,
    limit: usize,
  ) -> Result<io::Result<Bytes>, BodyLimitExceeded> {
    let mut bytes = bytes::BytesMut::new();
    let mut stream = self.into_stream();
    while let Some(chunk) = stream.next().await {
      let chunk = match chunk {
        Ok(chunk) => chunk,
        Err(error) => return Ok(Err(error)),
      };
      if chunk.len() > limit - bytes.len() {
        return Err(BodyLimitExceeded);
      }
      bytes.extend_from_slice(&chunk);
    }
    Ok(Ok(bytes.freeze()))
  }
}

pub struct HttpResponse(http::Response<Body>);

impl HttpResponse {
  pub fn build(status: StatusCode) -> HttpResponseBuilder {
    HttpResponseBuilder::new(status)
  }

  pub fn add_cookie(
    &mut self,
    cookie: &cookie::Cookie<'_>,
  ) -> Result<(), header::InvalidHeaderValue> {
    let value = header::HeaderValue::from_str(&cookie.encoded().to_string())?;
    self.headers_mut().append(header::SET_COOKIE, value);
    Ok(())
  }

  pub fn into_parts(self) -> (http::response::Parts, Body) {
    self.0.into_parts()
  }

  pub fn into_body(self) -> Body {
    self.0.into_body()
  }

  pub fn into_http(self) -> http::Response<Body> {
    self.0
  }
}

impl Deref for HttpResponse {
  type Target = http::Response<Body>;

  fn deref(&self) -> &Self::Target {
    &self.0
  }
}

impl DerefMut for HttpResponse {
  fn deref_mut(&mut self) -> &mut Self::Target {
    &mut self.0
  }
}

macro_rules! response_builders {
  ($($name:ident = $status:ident),+ $(,)?) => {
    #[allow(non_snake_case)]
    impl HttpResponse {
      $(pub fn $name() -> HttpResponseBuilder {
        Self::build(StatusCode::$status)
      })+
    }
  };
}

response_builders! {
  Ok = OK,
  Created = CREATED,
  Found = FOUND,
  SeeOther = SEE_OTHER,
  NotFound = NOT_FOUND,
  InternalServerError = INTERNAL_SERVER_ERROR,
}

/// Request metadata and captures are available to extractors without consuming the body.
#[derive(Clone)]
pub struct HttpRequest(Arc<RequestContext>);

struct RequestContext {
  parts: Parts,
  params: Vec<(String, String)>,
  data: Extensions,
}

impl HttpRequest {
  pub(crate) fn new(parts: Parts, params: Vec<(String, String)>, data: Extensions) -> Self {
    Self(Arc::new(RequestContext {
      parts,
      params,
      data,
    }))
  }

  pub fn method(&self) -> &Method {
    &self.0.parts.method
  }
  pub fn uri(&self) -> &Uri {
    &self.0.parts.uri
  }
  pub fn path(&self) -> &str {
    self.uri().path()
  }
  pub fn query_string(&self) -> &str {
    self.uri().query().unwrap_or_default()
  }
  pub fn headers(&self) -> &HeaderMap {
    &self.0.parts.headers
  }
  pub fn extensions(&self) -> &Extensions {
    &self.0.parts.extensions
  }
  pub fn match_info(&self) -> &[(String, String)] {
    &self.0.params
  }
  pub fn local_addr(&self) -> Option<std::net::SocketAddr> {
    self
      .extensions()
      .get::<crate::backend::LocalAddress>()
      .map(|address| address.0)
  }

  pub fn peer_addr(&self) -> Option<std::net::SocketAddr> {
    self
      .extensions()
      .get::<crate::backend::PeerAddress>()
      .map(|peer| peer.0)
  }

  pub fn cookie(&self, name: &str) -> Option<cookie::Cookie<'static>> {
    self
      .headers()
      .get_all(header::COOKIE)
      .iter()
      .filter_map(|header| header.to_str().ok())
      .flat_map(|value| value.split(';'))
      .filter_map(|pair| cookie::Cookie::parse_encoded(pair.trim()).ok())
      .find(|cookie| cookie.name() == name)
      .map(cookie::Cookie::into_owned)
  }

  pub fn app_data<T: Send + Sync + 'static>(&self) -> Option<&T> {
    self.0.data.get()
  }
}

pub trait ResponseError: std::fmt::Display {
  fn status_code(&self) -> StatusCode {
    StatusCode::INTERNAL_SERVER_ERROR
  }

  fn error_response(&self) -> HttpResponse {
    HttpResponseBuilder::new(self.status_code()).body(self.to_string())
  }
}

pub trait FromRequest: Sized + Send {
  fn from_request(
    req: &HttpRequest,
    body: &mut Payload,
  ) -> impl Future<Output = Result<Self, HttpResponse>> + Send;
}

impl FromRequest for HttpRequest {
  async fn from_request(req: &HttpRequest, _: &mut Payload) -> Result<Self, HttpResponse> {
    Ok(req.clone())
  }
}

impl<T: FromRequest> FromRequest for Option<T> {
  async fn from_request(req: &HttpRequest, body: &mut Payload) -> Result<Self, HttpResponse> {
    Ok(T::from_request(req, body).await.ok())
  }
}

#[derive(Debug)]
pub struct Data<T>(Arc<T>);

impl<T> Data<T> {
  pub fn new(value: T) -> Self {
    Self(Arc::new(value))
  }
  pub fn get_ref(&self) -> &T {
    &self.0
  }
}

impl<T> Clone for Data<T> {
  fn clone(&self) -> Self {
    Self(self.0.clone())
  }
}

impl<T> Deref for Data<T> {
  type Target = T;
  fn deref(&self) -> &T {
    self.get_ref()
  }
}

impl<T: Send + Sync + 'static> FromRequest for Data<T> {
  async fn from_request(req: &HttpRequest, _: &mut Payload) -> Result<Self, HttpResponse> {
    req
      .app_data::<Self>()
      .cloned()
      .ok_or_else(|| status(StatusCode::INTERNAL_SERVER_ERROR))
  }
}

impl FromRequest for Body {
  async fn from_request(_: &HttpRequest, body: &mut Payload) -> Result<Self, HttpResponse> {
    Ok(std::mem::replace(body, Body::empty()))
  }
}

impl FromRequest for Bytes {
  async fn from_request(req: &HttpRequest, body: &mut Payload) -> Result<Self, HttpResponse> {
    let limit = req
      .app_data::<PayloadConfig>()
      .copied()
      .unwrap_or_default()
      .0;
    std::mem::replace(body, Body::empty())
      .to_bytes_limited(limit)
      .await
      .map_err(|_| status(StatusCode::PAYLOAD_TOO_LARGE))?
      .map_err(|_| status(StatusCode::BAD_REQUEST))
  }
}

#[derive(Clone, Copy)]
pub struct PayloadConfig(usize);

impl PayloadConfig {
  pub fn new(limit: usize) -> Self {
    Self(limit)
  }
}

impl Default for PayloadConfig {
  fn default() -> Self {
    Self(256 * 1024)
  }
}

macro_rules! extractor {
  ($name:ident) => {
    pub struct $name<T>(pub T);

    impl<T> $name<T> {
      pub fn into_inner(self) -> T {
        self.0
      }
    }

    impl<T> Deref for $name<T> {
      type Target = T;
      fn deref(&self) -> &T {
        &self.0
      }
    }
  };
}

extractor!(Path);
extractor!(Query);
extractor!(Json);
extractor!(Form);

impl<T: serde::de::DeserializeOwned + Send> FromRequest for Path<T> {
  async fn from_request(req: &HttpRequest, _: &mut Payload) -> Result<Self, HttpResponse> {
    use crate::path_value::PathValue;
    use serde::de::value::{Error, MapDeserializer, SeqDeserializer};

    let params = req.match_info();
    let named = params
      .iter()
      .map(|(name, value)| (name.as_str(), PathValue(value)));
    let value = T::deserialize(MapDeserializer::<_, Error>::new(named))
      .or_else(|_| {
        let ordered = params.iter().map(|(_, value)| PathValue(value));
        T::deserialize(SeqDeserializer::<_, Error>::new(ordered))
      })
      .or_else(|err| match params {
        [(_, value)] => T::deserialize(PathValue(value)),
        _ => Err(err),
      });
    value.map(Self).map_err(|_| status(StatusCode::BAD_REQUEST))
  }
}

impl<T: serde::de::DeserializeOwned + Send> FromRequest for Query<T> {
  async fn from_request(req: &HttpRequest, _: &mut Payload) -> Result<Self, HttpResponse> {
    serde_urlencoded::from_str(req.query_string())
      .map(Self)
      .map_err(|_| status(StatusCode::BAD_REQUEST))
  }
}

impl<T: serde::de::DeserializeOwned + Send> FromRequest for Json<T> {
  async fn from_request(req: &HttpRequest, body: &mut Payload) -> Result<Self, HttpResponse> {
    let media = media_type(req);
    if media != "application/json" && !media.ends_with("+json") {
      return Err(status(StatusCode::UNSUPPORTED_MEDIA_TYPE));
    }
    serde_json::from_slice(&Bytes::from_request(req, body).await?)
      .map(Self)
      .map_err(|_| status(StatusCode::BAD_REQUEST))
  }
}

impl<T: serde::de::DeserializeOwned + Send> FromRequest for Form<T> {
  async fn from_request(req: &HttpRequest, body: &mut Payload) -> Result<Self, HttpResponse> {
    if media_type(req) != "application/x-www-form-urlencoded" {
      return Err(status(StatusCode::UNSUPPORTED_MEDIA_TYPE));
    }
    serde_urlencoded::from_bytes(&Bytes::from_request(req, body).await?)
      .map(Self)
      .map_err(|_| status(StatusCode::BAD_REQUEST))
  }
}

fn media_type(req: &HttpRequest) -> String {
  req
    .headers()
    .get(header::CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .unwrap_or_default()
    .split(';')
    .next()
    .unwrap_or_default()
    .trim()
    .to_ascii_lowercase()
}

pub struct HttpResponseBuilder {
  status: StatusCode,
  headers: HeaderMap,
  invalid_header: bool,
}

impl HttpResponseBuilder {
  pub fn new(status: StatusCode) -> Self {
    Self {
      status,
      headers: HeaderMap::new(),
      invalid_header: false,
    }
  }

  pub fn header(mut self, name: header::HeaderName, value: header::HeaderValue) -> Self {
    self.headers.append(name, value);
    self
  }

  pub fn insert_header<N, V>(&mut self, (name, value): (N, V)) -> &mut Self
  where
    N: TryInto<header::HeaderName>,
    V: TryInto<header::HeaderValue>,
  {
    match (name.try_into(), value.try_into()) {
      (Ok(name), Ok(value)) => {
        self.headers.insert(name, value);
      }
      _ => self.invalid_header = true,
    }
    self
  }

  pub fn content_type(&mut self, value: impl TryInto<header::HeaderValue>) -> &mut Self {
    self.insert_header((header::CONTENT_TYPE, value))
  }

  pub fn cookie(&mut self, cookie: cookie::Cookie<'_>) -> &mut Self {
    match header::HeaderValue::from_str(&cookie.encoded().to_string()) {
      Ok(value) => {
        self.headers.append(header::SET_COOKIE, value);
      }
      Err(_) => self.invalid_header = true,
    }
    self
  }

  pub fn finish(&mut self) -> HttpResponse {
    self.streaming(Body::empty())
  }

  pub fn body(&mut self, bytes: impl Into<Bytes>) -> HttpResponse {
    let bytes = bytes.into();
    if !self.headers.contains_key(header::CONTENT_LENGTH) {
      self.headers.insert(
        header::CONTENT_LENGTH,
        header::HeaderValue::from(bytes.len()),
      );
    }
    self.streaming(Body::bytes(bytes))
  }

  pub fn json(&mut self, value: impl Serialize) -> HttpResponse {
    match serde_json::to_vec(&value) {
      Ok(bytes) => self.content_type("application/json").body(bytes),
      Err(_) => status(StatusCode::INTERNAL_SERVER_ERROR),
    }
  }

  pub fn streaming(&mut self, body: Body) -> HttpResponse {
    if self.invalid_header {
      return status(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mut response = http::Response::new(body);
    *response.status_mut() = self.status;
    *response.headers_mut() = std::mem::take(&mut self.headers);
    HttpResponse(response)
  }
}

pub(crate) fn status(code: StatusCode) -> HttpResponse {
  HttpResponseBuilder::new(code).finish()
}
