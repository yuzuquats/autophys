//! Serve a prebuilt `tento-web` route tree on an ephemeral loopback socket.
//!
//! Native web containers need the same route discovery and static-file
//! behavior as other Tento applications, but they do not want the production
//! server's fixed ports, TLS configuration, or multi-domain lifecycle. This
//! adapter keeps that smaller embedding boundary inside `tento-web`.

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::thread;

use actix_web::dev::ServerHandle;
use actix_web::web;
use actix_web::{App, HttpServer};
use anyhow::{Context, Result, anyhow};

use crate::{BuildState, DomainConfig, DomainConfigLike, Webapp};

/// A `tento-web` application running on `127.0.0.1` at an ephemeral port.
///
/// Dropping the value stops the Actix server and joins its dedicated thread.
/// Keeping the runtime on that thread lets synchronous native hosts own their
/// platform event loop on the main thread.
pub struct PrebuiltLoopbackServer {
  pub addr: SocketAddr,
  handle: Option<ServerHandle>,
  thread: Option<thread::JoinHandle<Result<(), String>>>,
}

impl PrebuiltLoopbackServer {
  /// Serve a prebuilt route tree containing `routes/` and any sibling domain
  /// route directories. The socket is always loopback-only.
  pub fn spawn(routes_root: PathBuf) -> Result<Self> {
    if !routes_root.join("routes").is_dir() {
      anyhow::bail!(
        "prebuilt tento-web root has no routes directory: {}",
        routes_root.display()
      );
    }

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
      .context("bind prebuilt tento-web loopback socket")?;
    let addr = listener.local_addr().context("read loopback address")?;
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);

    let thread = thread::Builder::new()
      .name("tento-web-loopback".into())
      .spawn(move || {
        let domain = DomainConfig::builder()
          .hostname("localhost")
          .project_root(routes_root.clone())
          .build();
        let webapp = Arc::new(Webapp::new(
          Arc::new(domain) as Arc<dyn DomainConfigLike>,
          None,
          BuildState::new(
            routes_root.clone(),
            routes_root.clone(),
            routes_root.clone(),
            routes_root.join("target.web.modules"),
          ),
        ));
        let serve_webapp = webapp.clone();
        let server = match HttpServer::new(move || {
          let webapp = serve_webapp.clone();
          App::new().configure(move |cfg| {
            webapp.configure(cfg, web::scope(""));
          })
        })
        .listen(listener)
        {
          Ok(server) => server.run(),
          Err(error) => {
            let message = format!("start prebuilt tento-web server: {error}");
            let _ = ready_tx.send(Err(message.clone()));
            return Err(message);
          }
        };

        let handle = server.handle();
        if ready_tx.send(Ok(handle)).is_err() {
          return Err("prebuilt tento-web caller disappeared during startup".into());
        }
        actix_web::rt::System::new()
          .block_on(server)
          .map_err(|error| format!("run prebuilt tento-web server: {error}"))
      })
      .context("spawn prebuilt tento-web thread")?;

    let handle = ready_rx
      .recv()
      .context("prebuilt tento-web thread exited during startup")?
      .map_err(anyhow::Error::msg)?;

    Ok(Self {
      addr,
      handle: Some(handle),
      thread: Some(thread),
    })
  }

  /// Block until the server exits (the foreground development-binary path).
  pub fn wait(mut self) -> Result<()> {
    let thread = self
      .thread
      .take()
      .ok_or_else(|| anyhow!("prebuilt tento-web thread already joined"))?;
    let result = thread
      .join()
      .map_err(|_| anyhow!("prebuilt tento-web thread panicked"))?
      .map_err(anyhow::Error::msg);
    self.handle.take();
    result
  }
}

impl Drop for PrebuiltLoopbackServer {
  fn drop(&mut self) {
    if let Some(handle) = self.handle.take() {
      actix_web::rt::System::new().block_on(handle.stop(true));
    }
    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
  }
}

#[cfg(test)]
mod tests {
  use std::io::{Read, Write};
  use std::net::TcpStream;
  use std::time::{Duration, SystemTime, UNIX_EPOCH};

  use super::*;

  #[test]
  fn serves_a_prebuilt_route_tree_on_loopback() {
    let nonce = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    let root = std::env::temp_dir().join(format!("tento-web-prebuilt-{nonce}"));
    std::fs::create_dir_all(root.join("routes")).unwrap();
    std::fs::write(
      root.join("routes/index.anon.html"),
      "<title>prebuilt</title>",
    )
    .unwrap();

    let server = PrebuiltLoopbackServer::spawn(root.clone()).unwrap();
    let mut stream = TcpStream::connect(server.addr).unwrap();
    stream
      .set_read_timeout(Some(Duration::from_secs(2)))
      .unwrap();
    write!(
      stream,
      "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("<title>prebuilt</title>"));

    drop(server);
    std::fs::remove_dir_all(root).unwrap();
  }
}
