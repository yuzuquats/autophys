use std::{
  io,
  net::{SocketAddr, TcpListener},
  sync::Arc,
  time::Duration,
};

use axum::{
  Router, body,
  extract::{ConnectInfo, Request, State},
};
use futures_util::StreamExt;
use http::header;
use tokio::{sync::oneshot, time::timeout};
use tokio_util::sync::CancellationToken;

use crate::{
  Body, Webapp,
  backend::{LocalAddress, PeerAddress},
};

const DRAIN_TIMEOUT: Duration = Duration::from_secs(8);
const CONNECTION_CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone)]
struct ServerState {
  app: Arc<Webapp>,
  local: LocalAddress,
  draining: CancellationToken,
  force_close: CancellationToken,
}

pub(super) async fn serve(
  listener: TcpListener,
  app: Arc<Webapp>,
  shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
  listener.set_nonblocking(true)?;
  let local = listener.local_addr()?;
  let listener = tokio::net::TcpListener::from_std(listener)?;
  let state = ServerState {
    app,
    local: LocalAddress(local),
    draining: CancellationToken::new(),
    force_close: CancellationToken::new(),
  };
  let router = Router::new().fallback(dispatch).with_state(state.clone());
  let (started, draining) = oneshot::channel();
  let signal = state.draining.clone();
  let server = axum::serve(
    listener,
    router.into_make_service_with_connect_info::<SocketAddr>(),
  )
  .with_graceful_shutdown(async move {
    shutdown.await;
    signal.cancel();
    let _ = started.send(());
  });

  let mut server = std::pin::pin!(std::future::IntoFuture::into_future(server));
  tokio::select! {
    result = &mut server => return result,
    _ = draining => {},
  }
  if let Ok(result) = timeout(DRAIN_TIMEOUT, &mut server).await {
    return result;
  }

  state.force_close.cancel();
  timeout(CONNECTION_CLEANUP_TIMEOUT, server)
    .await
    .map_err(|_| {
      io::Error::new(
        io::ErrorKind::TimedOut,
        "Axum connections did not close after shutdown",
      )
    })?
}

async fn dispatch(
  State(state): State<ServerState>,
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
  request.extensions_mut().insert(state.local);
  let response = tokio::select! {
    response = state.app.call(request) => response.into_http(),
    () = state.force_close.cancelled() => {
      let mut response = http::Response::new(body::Body::empty());
      *response.status_mut() = http::StatusCode::SERVICE_UNAVAILABLE;
      return response;
    }
  };
  // Event streams can stay open indefinitely, including when the app is idle.
  // Let clients reconnect immediately while ordinary responses have time to finish.
  let is_event_stream = response
    .headers()
    .get(header::CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.split(';').next())
    .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"));
  let end = if is_event_stream {
    state.draining
  } else {
    state.force_close
  };
  response.map(|body| body::Body::from_stream(body.into_stream().take_until(end.cancelled_owned())))
}
