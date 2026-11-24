use std::{
  io,
  net::{SocketAddr, TcpListener},
  sync::Arc,
};

use axum::{
  Router, body,
  extract::{ConnectInfo, Request, State},
};
use futures_util::StreamExt;

use crate::{
  Body, Webapp,
  backend::{LocalAddress, PeerAddress},
};

pub(super) async fn serve(
  listener: TcpListener,
  app: Arc<Webapp>,
  shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
  listener.set_nonblocking(true)?;
  let local = listener.local_addr()?;
  let listener = tokio::net::TcpListener::from_std(listener)?;
  let router = Router::new()
    .fallback(dispatch)
    .with_state((app, LocalAddress(local)));
  axum::serve(
    listener,
    router.into_make_service_with_connect_info::<SocketAddr>(),
  )
  .with_graceful_shutdown(shutdown)
  .await
}

async fn dispatch(
  State((app, local)): State<(Arc<Webapp>, LocalAddress)>,
  ConnectInfo(peer): ConnectInfo<SocketAddr>,
  request: Request,
) -> http::Response<body::Body> {
  let mut request = request.map(|body| {
    Body::stream(
      body
        .into_data_stream()
        .map(|item| item.map_err(io::Error::other)),
    )
  });
  request.extensions_mut().insert(PeerAddress(peer));
  request.extensions_mut().insert(local);
  app
    .call(request)
    .await
    .into_http()
    .map(|body| body::Body::from_stream(body.into_stream()))
}
