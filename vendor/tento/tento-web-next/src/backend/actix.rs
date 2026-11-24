use std::{io, net::TcpListener, sync::Arc};

use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
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
  actix_web::rt::System::new().block_on(async move {
    let server = HttpServer::new(move || {
      App::new()
        .app_data(web::Data::from(app.clone()))
        .app_data(local)
        .default_service(web::to(dispatch))
    })
    .disable_signals()
    .shutdown_timeout(10)
    .listen(listener)?
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(async move {
      let _ = stop.await;
      handle.stop(true).await;
    });
    server.await
  })
}

async fn dispatch(req: HttpRequest, payload: web::Payload, app: web::Data<Webapp>) -> HttpResponse {
  let (send, body) = body_channel();
  let mut incoming = http::Request::builder()
    .method(req.method().as_str())
    .uri(req.uri().to_string());
  for (name, value) in req.headers() {
    incoming = incoming.header(name.as_str(), value.as_bytes());
  }
  let Ok(mut incoming) = incoming.body(body) else {
    return HttpResponse::BadRequest().finish();
  };
  if let Some(peer) = req.peer_addr() {
    incoming.extensions_mut().insert(PeerAddress(peer));
  }
  if let Some(local) = req.app_data::<LocalAddress>() {
    incoming.extensions_mut().insert(*local);
  }
  actix_web::rt::spawn(forward_body(payload, send, std::convert::identity));
  let (parts, body) = app.call(incoming).await.into_parts();
  let code = actix_web::http::StatusCode::from_u16(parts.status.as_u16()).expect("valid status");
  let mut response = HttpResponse::build(code);
  for (name, value) in &parts.headers {
    response.append_header((name.as_str(), value.as_bytes()));
  }
  response.streaming(body.into_stream())
}
