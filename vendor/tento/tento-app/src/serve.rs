//! A reusable JSON-RPC serve loop for a [`Scripts`] surface — so no service
//! group ever hand-rolls a server again (`tento-kol`'s `daemon/server.rs` was
//! the bespoke first one; migrating it onto this is a follow-up).
//!
//! [`serve_scripts`] binds a `UnixListener`, accepts connections, and per
//! connection speaks the same wire the tsh daemon client already does
//! ([`crate::daemon_rpc`]): read a framed [`JsonRpcRequest`], reconstruct the
//! argv ([`build_argv`]), dispatch it through the group's own `Scripts` exactly
//! like an in-process / oneshot call, and write back a framed
//! [`JsonRpcResponse`]. It carries **no domain policy** (no auditor hooks, no
//! warm-pool bookkeeping) — a group layers those in its command bodies.
//!
//! `!Send` futures: a `CommandMetadata` future isn't `Send`, so both the accept
//! loop and the per-connection tasks must run inside a `tokio::task::LocalSet`
//! (`spawn_local`). A service `main` wraps the call in one, e.g.
//! `LocalSet::new().run_until(serve_scripts(scripts, &socket)).await`.
//!
//! Lifecycle: this runs **forever** (until the process is killed). A
//! session-leased service's OWNER is the tsh engine, which holds the child with
//! `kill_on_drop` and kills it on engine exit — so an in-loop shutdown signal
//! would be redundant. A detached daemon keeps its own signal handling in `main`
//! around this loop.

use std::path::Path;
use std::rc::Rc;

use tento_lisp_cmd::{Error, Scripts};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::UnixListener;

use crate::daemon_rpc::{
  JsonRpcError, JsonRpcRequest, JsonRpcResponse, build_argv, read_frame, write_frame,
};

/// Serve `scripts` over the Unix `socket` until the process is killed. Creates
/// the socket's parent dir and removes any stale socket file first, then binds
/// and accepts. Each connection is handled on its own `spawn_local` task, so two
/// callers don't serialize on the accept loop. Must run inside a `LocalSet` (the
/// dispatched futures are `!Send`).
pub async fn serve_scripts<Info>(scripts: Scripts<Info>, socket: &Path) -> anyhow::Result<()>
where
  Info: Clone + 'static,
{
  if let Some(parent) = socket.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|e| anyhow::anyhow!("creating socket dir {}: {e}", parent.display()))?;
  }
  // A stale socket file from a prior run makes `bind` fail with EADDRINUSE.
  let _ = std::fs::remove_file(socket);
  let listener = UnixListener::bind(socket)
    .map_err(|e| anyhow::anyhow!("binding service socket {}: {e}", socket.display()))?;

  let scripts = Rc::new(scripts);
  loop {
    let stream = match listener.accept().await {
      Ok((stream, _addr)) => stream,
      Err(e) => {
        // A transient accept error shouldn't tear the service down; log and
        // keep serving. (A truly wedged listener surfaces as the owner killing
        // the process.)
        tracing::warn!(error = %e, "service accept error");
        continue;
      }
    };
    let scripts = scripts.clone();
    tokio::task::spawn_local(async move {
      if let Err(e) = handle_connection(stream, &scripts).await {
        tracing::warn!(error = %e, "service connection error");
      }
    });
  }
}

/// Serve one connection: a request/response loop over the framed wire until the
/// peer hangs up. A malformed frame returns a JSON-RPC parse error and the
/// connection SURVIVES (subsequent frames still dispatch), matching the daemon
/// server's behavior.
async fn handle_connection<S, Info>(mut stream: S, scripts: &Scripts<Info>) -> anyhow::Result<()>
where
  S: AsyncRead + AsyncWrite + Unpin,
  Info: Clone + 'static,
{
  loop {
    let payload = match read_frame(&mut stream).await {
      Ok(p) => p,
      // EOF / read error → the peer is gone; end this connection cleanly.
      Err(_) => break,
    };

    let request: JsonRpcRequest = match serde_json::from_slice(&payload) {
      Ok(r) => r,
      Err(e) => {
        let resp = JsonRpcResponse::err(
          serde_json::Value::Null,
          JsonRpcError::parse_error(format!("parse error: {e}")),
        );
        write_frame(&mut stream, &serde_json::to_vec(&resp)?).await?;
        continue;
      }
    };

    let id = request.id.clone();
    let method = request.method.clone();
    let argv = build_argv(&request);
    let result = if let Some(name) = argv.first() {
      if let Some(command) = scripts.commands.find_command(name) {
        match command.call_with_argv(scripts.info.clone(), argv) {
          Ok(future) => future.await,
          Err(error) => Err(error),
        }
      } else {
        Err(Error::NoSuchSubcommand)
      }
    } else {
      Err(Error::MissingSubcommand(
        scripts.commands.names().join(", "),
      ))
    };

    let response = match result {
      Ok(value) => JsonRpcResponse::ok(id, value),
      Err(Error::NoSuchSubcommand) | Err(Error::CommandNotFound { .. }) => {
        JsonRpcResponse::err(id, JsonRpcError::method_not_found(&method))
      }
      Err(Error::ArgParseError(msg)) | Err(Error::MissingSubcommand(msg)) => {
        JsonRpcResponse::err(id, JsonRpcError::invalid_params(msg))
      }
      // `Error` is #[non_exhaustive]; `Other` (an anyhow domain error) and any
      // future variant map to a generic internal error — no domain policy here.
      Err(other) => JsonRpcResponse::err(id, JsonRpcError::internal_error(other.to_string())),
    };

    write_frame(&mut stream, &serde_json::to_vec(&response)?).await?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::daemon_rpc::Client;
  use serde_json::Value;
  use tento_lisp_cmd::{CommandArg, Scripts, command};

  // A trivial command surface: `echo --text X` returns `{ "echoed": X }`.
  #[derive(CommandArg, serde::Deserialize, Clone)]
  pub struct EchoArgs {
    pub text: String,
  }

  #[command(name = "echo", description = "echo the text back")]
  async fn echo(_ctx: (), args: EchoArgs) -> tento_lisp_cmd::Result<Value> {
    Ok(serde_json::json!({ "echoed": args.text }))
  }

  fn scripts() -> Scripts<()> {
    Scripts::new(()).add_command(echo)
  }

  /// Round-trip: serve on a temp socket inside a LocalSet, call it via the
  /// daemon `Client` (no spawn — `start = None`), get the JSON back; then an
  /// unknown command yields a JSON-RPC method-not-found error AND the connection
  /// survives to serve a following good call.
  #[tokio::test]
  async fn serve_roundtrip_and_error_survives_connection() {
    let dir = std::env::temp_dir().join(format!("tento-serve-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("svc.sock");

    let local = tokio::task::LocalSet::new();
    local
      .run_until(async {
        // Serve in the background (same LocalSet, so the !Send future is legal).
        let serve_socket = socket.clone();
        tokio::task::spawn_local(async move {
          let _ = serve_scripts(scripts(), &serve_socket).await;
        });

        // Wait for the socket to bind.
        let bin = std::path::PathBuf::from("unused-bin");
        for _ in 0..50 {
          if socket.exists() {
            break;
          }
          tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        // Good call: externally-managed (start=None) so no spawn is attempted.
        let out = Client::call(
          &socket,
          None,
          &bin,
          "echo",
          &["--text".to_string(), "hi".to_string()],
        )
        .await
        .expect("echo call succeeds");
        assert_eq!(out, serde_json::json!({ "echoed": "hi" }));

        // Unknown command → transport-native error (method not found), and the
        // service keeps serving (the next good call still works).
        let err = Client::call(&socket, None, &bin, "nope", &[])
          .await
          .expect_err("unknown command errors");
        assert!(err.to_string().contains("method not found"), "got: {err}");

        let again = Client::call(
          &socket,
          None,
          &bin,
          "echo",
          &["--text".to_string(), "again".to_string()],
        )
        .await
        .expect("service still serving after an error");
        assert_eq!(again, serde_json::json!({ "echoed": "again" }));
      })
      .await;

    let _ = std::fs::remove_dir_all(&dir);
  }
}
