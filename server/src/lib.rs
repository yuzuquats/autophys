//! autophys server: one loopback HTTP listener that answers `/api/healthz`
//! and serves the built client. Nothing else lives here in batch 1.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{any, get};
use serde::Serialize;
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};

/// The default listen address: loopback, port 4794 (decision AP-3).
pub const DEFAULT_ADDR: &str = "127.0.0.1:4794";

/// What `/api/healthz` reports about this binary.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct BuildInfo {
    pub version: String,
    pub commit: String,
}

impl BuildInfo {
    /// The version from Cargo and the commit stamped in by `ops/deploy.sh`
    /// through `AUTOPHYS_COMMIT`; a plain `cargo build` reports `dev`.
    pub fn current() -> Self {
        BuildInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            commit: option_env!("AUTOPHYS_COMMIT").unwrap_or("dev").to_string(),
        }
    }
}

#[derive(Serialize)]
struct Health<'a> {
    ok: bool,
    version: &'a str,
    commit: &'a str,
}

/// Parse a listen address and refuse anything that is not a literal loopback
/// IP. Host names are refused too: `localhost` can resolve to a routable
/// address, and this server must never be reachable from the network.
pub fn parse_loopback(addr: &str) -> Result<SocketAddr, String> {
    let parsed: SocketAddr = addr
        .parse()
        .map_err(|_| format!("--addr {addr:?} is not an IP:port (use 127.0.0.1:<port>)"))?;
    if !parsed.ip().is_loopback() {
        return Err(format!(
            "--addr {addr:?} is not loopback; autophys binds 127.0.0.1 or [::1] only"
        ));
    }
    Ok(parsed)
}

/// The router: healthz, unknown `/api/*` as JSON 404, the client's two
/// document routes (`/` and `/app/...`) as `index.html`, and every other
/// path as a static file or a plain 404.
pub fn app(web: &Path, info: BuildInfo) -> Router {
    let index = web.join("index.html");
    let health = move || {
        let info = info.clone();
        async move {
            Json(Health {
                ok: true,
                version: &info.version,
                commit: &info.commit,
            })
            .into_response()
        }
    };
    Router::new()
        .route("/api/healthz", get(health))
        .route("/api", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found))
        .route_service("/app", ServeFile::new(&index))
        .route_service("/app/{*rest}", ServeFile::new(&index))
        .fallback_service(
            ServeDir::new(web)
                .append_index_html_on_directories(true)
                .not_found_service(any(not_found)),
        )
}

async fn api_not_found(uri: Uri) -> Response {
    let body = serde_json::json!({ "ok": false, "error": "not found", "path": uri.path() });
    (StatusCode::NOT_FOUND, Json(body)).into_response()
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found\n").into_response()
}

/// Server settings after argument and environment parsing.
#[derive(Debug, PartialEq, Eq)]
pub struct Config {
    pub addr: SocketAddr,
    pub web: PathBuf,
}

/// `--addr` / `AUTOPHYS_ADDR` (default [`DEFAULT_ADDR`]) and `--web` /
/// `AUTOPHYS_WEB` (required). Flags win over the environment.
pub fn parse_config(
    args: impl IntoIterator<Item = String>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<Config, String> {
    let mut addr = env("AUTOPHYS_ADDR");
    let mut web = env("AUTOPHYS_WEB");
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (key, inline) = match arg.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (arg.clone(), None),
        };
        let mut value = || {
            inline
                .clone()
                .or_else(|| args.next())
                .ok_or(format!("{key} needs a value"))
        };
        match key.as_str() {
            "--addr" => addr = Some(value()?),
            "--web" => web = Some(value()?),
            "-h" | "--help" => return Err(USAGE.to_string()),
            other => return Err(format!("unknown argument {other:?}\n{USAGE}")),
        }
    }
    let addr = parse_loopback(addr.as_deref().unwrap_or(DEFAULT_ADDR))?;
    let web = PathBuf::from(web.ok_or(format!("--web is required\n{USAGE}"))?);
    if !web.join("index.html").is_file() {
        return Err(format!(
            "--web {}: no index.html (run `deno task build`)",
            web.display()
        ));
    }
    Ok(Config { addr, web })
}

pub const USAGE: &str = "usage: autophys-server --web <dir> [--addr 127.0.0.1:4794]";

/// Serve until `shutdown` resolves, then stop accepting and drain in-flight
/// requests.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await
}

/// Resolves on SIGTERM or SIGINT.
pub async fn termination() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
    tokio::select! {
        _ = term.recv() => eprintln!("autophys: SIGTERM, draining"),
        _ = int.recv() => eprintln!("autophys: SIGINT, draining"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_addresses_are_accepted() {
        assert_eq!(parse_loopback("127.0.0.1:4794").unwrap().port(), 4794);
        assert!(parse_loopback("[::1]:4794").is_ok());
        assert!(parse_loopback("127.0.0.2:1").is_ok());
    }

    #[test]
    fn non_loopback_addresses_are_refused() {
        for addr in [
            "0.0.0.0:4794",
            "[::]:4794",
            "100.64.0.19:4794",
            "192.168.1.5:80",
            "localhost:4794",
            "4794",
        ] {
            assert!(parse_loopback(addr).is_err(), "{addr} should be refused");
        }
    }

    #[test]
    fn config_reads_flags_over_env() {
        let dir = std::env::temp_dir().join(format!("autophys-config-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "x").unwrap();
        let env = |k: &str| match k {
            "AUTOPHYS_ADDR" => Some("127.0.0.1:1".to_string()),
            "AUTOPHYS_WEB" => Some(dir.display().to_string()),
            _ => None,
        };
        let from_env = parse_config(Vec::<String>::new(), env).unwrap();
        assert_eq!(from_env.addr.port(), 1);
        let flagged = parse_config(["--addr=127.0.0.1:2".to_string()], env).unwrap();
        assert_eq!(flagged.addr.port(), 2);
        assert!(parse_config(["--addr".into(), "0.0.0.0:2".into()], env).is_err());
        assert!(parse_config(["--bogus".into()], env).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn config_requires_a_built_client() {
        let err =
            parse_config(["--web".into(), "/nonexistent/autophys".into()], |_| None).unwrap_err();
        assert!(err.contains("index.html"), "{err}");
    }
}
