use std::{io, net::TcpListener, sync::Arc};

use futures_util::StreamExt;
use ntex::{http::Response, web};
use tokio::sync::oneshot;

use crate::{
  Webapp,
  backend::{LocalAddress, PeerAddress, body_channel, forward_body},
};

pub(super) fn run(
  listener: TcpListener,
  app: Arc<Webapp>,
  stop: oneshot::Receiver<()>,
) -> io::Result<()> {
  let local = LocalAddress(listener.local_addr()?);
  ntex::rt::System::new("tento-web-next").block_on(async move {
    let server = web::HttpServer::new(move || {
      let app = app.clone();
      web::App::new().default_service(web::to(move |req, payload| {
        dispatch(req, payload, app.clone(), local)
      }))
    })
    .disable_signals()
    .shutdown_timeout(ntex::time::Seconds(10))
    .listen(listener)?
    .run();
    let handle = server.clone();
    ntex::rt::spawn(async move {
      let _ = stop.await;
      handle.stop(true).await;
    });
    server.await
  })
}

async fn dispatch(
  req: web::HttpRequest,
  payload: web::types::Payload,
  app: Arc<Webapp>,
  local: LocalAddress,
) -> Response {
  let (send, body) = body_channel();
  let mut incoming = http::Request::builder()
    .method(req.method().as_str())
    .uri(req.uri().to_string());
  for (name, value) in req.headers() {
    incoming = incoming.header(name.as_str(), value.as_bytes());
  }
  let Ok(mut incoming) = incoming.body(body) else {
    return Response::BadRequest().finish();
  };
  if let Some(peer) = req.peer_addr() {
    incoming.extensions_mut().insert(PeerAddress(peer));
  }
  incoming.extensions_mut().insert(local);
  ntex::rt::spawn(forward_body(payload, send, |chunk| {
    bytes::Bytes::copy_from_slice(&chunk)
  }));
  let (parts, body) = app.call(incoming).await.into_parts();
  let code = ntex::http::StatusCode::from_u16(parts.status.as_u16()).expect("valid status");
  let mut response = Response::build(code);
  for (name, value) in &parts.headers {
    response.header(name.as_str(), value.as_bytes());
  }
  if matches!(
    parts.status,
    http::StatusCode::NOT_MODIFIED | http::StatusCode::NO_CONTENT
  ) {
    return response.body(ntex::http::body::Body::None);
  }
  let stream = body
    .into_stream()
    .map(|chunk| chunk.map(|bytes| ntex::util::Bytes::copy_from_slice(&bytes)));
  let size = parts
    .headers
    .get(http::header::CONTENT_LENGTH)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.parse::<u64>().ok());
  if let Some(size) = size {
    let stream = stream.map(|chunk| {
      chunk.map_err(|err| std::rc::Rc::new(err) as std::rc::Rc<dyn std::error::Error>)
    });
    response.body(ntex::http::body::Body::from_message(
      ntex::http::body::SizedStream::new(size, stream),
    ))
  } else {
    response.streaming(stream)
  }
}
