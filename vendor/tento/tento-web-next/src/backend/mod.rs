//! Server adapters selected by the executable.

#[cfg(feature = "actix")]
mod actix;
#[cfg(feature = "axum")]
mod axum;
#[cfg(feature = "ntex")]
mod ntex;

use std::{io, net::TcpListener, sync::Arc};

use crate::Webapp;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Backend {
  #[cfg(feature = "actix")]
  Actix,
  #[cfg(feature = "axum")]
  Axum,
  #[cfg(feature = "ntex")]
  Ntex,
}

impl Backend {
  #[allow(unused_variables)] // The enum is uninhabited when only app code is built.
  pub(crate) async fn serve(
    self,
    listener: TcpListener,
    app: Arc<Webapp>,
    shutdown: impl Future<Output = ()> + Send + 'static,
  ) -> io::Result<()> {
    match self {
      #[cfg(feature = "actix")]
      Self::Actix => worker(shutdown, move |stop| actix::run(listener, app, stop)).await,
      #[cfg(feature = "axum")]
      Self::Axum => axum::serve(listener, app, shutdown).await,
      #[cfg(feature = "ntex")]
      Self::Ntex => worker(shutdown, move |stop| ntex::run(listener, app, stop)).await,
    }
  }
}

/// Kernel peer address. The incoming headers remain available separately.
#[derive(Clone, Copy, Debug)]
pub struct PeerAddress(pub std::net::SocketAddr);

/// Address bound by the server. It is independent of the client-supplied Host.
#[derive(Clone, Copy, Debug)]
pub struct LocalAddress(pub std::net::SocketAddr);

#[cfg(any(feature = "actix", feature = "ntex"))]
async fn worker(
  shutdown: impl Future<Output = ()> + Send + 'static,
  run: impl FnOnce(tokio::sync::oneshot::Receiver<()>) -> io::Result<()> + Send + 'static,
) -> io::Result<()> {
  let (stop, stopped) = tokio::sync::oneshot::channel();
  let mut worker = tokio::task::spawn_blocking(move || run(stopped));
  tokio::select! {
      outcome = &mut worker => outcome.map_err(io::Error::other)?,
      () = shutdown => {
          let _ = stop.send(());
          worker.await.map_err(io::Error::other)?
      }
  }
}

#[cfg(any(feature = "actix", feature = "ntex"))]
fn body_channel() -> (
  tokio::sync::mpsc::Sender<io::Result<bytes::Bytes>>,
  crate::Body,
) {
  let (send, receive) = tokio::sync::mpsc::channel(1);
  (
    send,
    crate::Body::stream(futures_util::stream::unfold(
      receive,
      |mut receive| async move { receive.recv().await.map(|item| (item, receive)) },
    )),
  )
}

#[cfg(any(feature = "actix", feature = "ntex"))]
async fn forward_body<T, E>(
  input: impl futures_util::Stream<Item = Result<T, E>>,
  send: tokio::sync::mpsc::Sender<io::Result<bytes::Bytes>>,
  convert: impl Fn(T) -> bytes::Bytes,
) where
  E: std::fmt::Display,
{
  use futures_util::{StreamExt, pin_mut};
  pin_mut!(input);
  loop {
    // Obtain capacity before polling the framework stream. Dropping the
    // application body wakes this even when the client has stopped sending.
    let Ok(permit) = send.reserve().await else {
      return;
    };
    let chunk = tokio::select! {
        biased;
        () = send.closed() => return,
        chunk = input.next() => chunk,
    };
    let Some(chunk) = chunk else { return };
    let chunk = chunk
      .map(&convert)
      .map_err(|err| io::Error::other(err.to_string()));
    let failed = chunk.is_err();
    permit.send(chunk);
    if failed {
      return;
    }
  }
}
