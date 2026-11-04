//! `autophys serve` and `autophys build-web`: one loopback actix listener over
//! the tento-web app in [`crate::app`]. In dev, `serve` bundles `html/routes`
//! on start and rebuilds when anything the build read changes; with
//! `--web-root` it serves a tree `build-web` wrote and bundles nothing.

use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use actix_web::{App, HttpServer, dev::Server, web};
use anyhow::{Context, Result};
use tento_dirs::AppDirs;
use tento_web::{BuildState, Bundler, DomainConfigLike, EsbuildClient, TentoWeb, Webapp};

use crate::app::{APP_ID, AppConfig, BuildInfo, TENTO, domain};

/// The default listen address: loopback, port 4794 (decision AP-3).
pub const DEFAULT_ADDR: &str = "127.0.0.1:4794";

pub const USAGE: &str = "usage: autophys serve [--addr 127.0.0.1:4794] [--web-root DIR]
       autophys build-web [--out DIR]";

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

/// `serve` settings after argument and environment parsing.
#[derive(Debug, PartialEq, Eq)]
pub struct ServeConfig {
    pub addr: SocketAddr,
    /// A prebuilt route tree (`build-web` output). `None` bundles from source.
    pub web_root: Option<PathBuf>,
}

/// `serve` flags: `--addr` / `AUTOPHYS_ADDR` (default [`DEFAULT_ADDR`]) and
/// `--web-root` / `AUTOPHYS_WEB_ROOT`. Flags win over the environment.
pub fn parse_serve(
    args: impl IntoIterator<Item = String>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<ServeConfig, String> {
    let mut addr = env("AUTOPHYS_ADDR");
    let mut web_root = env("AUTOPHYS_WEB_ROOT").filter(|v| !v.is_empty());
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (key, inline) = split_flag(&arg);
        match key.as_str() {
            "--addr" => addr = Some(flag_value(&key, inline, &mut args)?),
            "--web-root" => web_root = Some(flag_value(&key, inline, &mut args)?),
            other => return Err(format!("unknown argument {other:?}\n{USAGE}")),
        }
    }
    let addr = parse_loopback(addr.as_deref().unwrap_or(DEFAULT_ADDR))?;
    let web_root = web_root.map(PathBuf::from);
    if let Some(root) = &web_root {
        check_route_tree(root)?;
    }
    Ok(ServeConfig { addr, web_root })
}

/// `build-web` flags: `--out DIR` (default [`default_web_root`]).
pub fn parse_build_web(args: impl IntoIterator<Item = String>) -> Result<Option<PathBuf>, String> {
    let mut out = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (key, inline) = split_flag(&arg);
        match key.as_str() {
            "--out" => out = Some(PathBuf::from(flag_value(&key, inline, &mut args)?)),
            other => return Err(format!("unknown argument {other:?}\n{USAGE}")),
        }
    }
    Ok(out)
}

fn split_flag(arg: &str) -> (String, Option<String>) {
    match arg.split_once('=') {
        Some((k, v)) => (k.to_string(), Some(v.to_string())),
        None => (arg.to_string(), None),
    }
}

fn flag_value(
    key: &str,
    inline: Option<String>,
    rest: &mut impl Iterator<Item = String>,
) -> Result<String, String> {
    inline
        .or_else(|| rest.next())
        .ok_or(format!("{key} needs a value"))
}

/// A served tree must hold the page `/` resolves to.
pub fn check_route_tree(root: &Path) -> Result<(), String> {
    if root.join("routes/index.anon.html").is_file() {
        Ok(())
    } else {
        Err(format!(
            "--web-root {}: no routes/index.anon.html (run `autophys build-web`)",
            root.display()
        ))
    }
}

/// The checkout the binary was built from, unless `AUTOPHYS_PROJECT_ROOT`
/// names another one. Only a build reads it.
pub fn project_root() -> PathBuf {
    std::env::var_os("AUTOPHYS_PROJECT_ROOT")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

/// Where a dev `serve` and a bare `build-web` write the route tree: the
/// app's tento cache dir (`~/.cache/tento/autophys/web/local.web`), never the
/// checkout. tento-web puts its per-file module store two levels above the
/// tree, so this keeps it at `~/.cache/tento/autophys/target.web.modules`.
pub fn default_web_root() -> Result<PathBuf> {
    Ok(AppDirs::resolve(APP_ID)?.cache.join("web/local.web"))
}

fn build_state(root: &Path) -> BuildState {
    BuildState::new(
        root.to_path_buf(),
        root.to_path_buf(),
        root.to_path_buf(),
        root.to_path_buf(),
    )
}

/// tento-web's bundler (esbuild under Deno), found at `TENTO_WEB` or at
/// `<project root>/<TENTO>/tento-web`.
fn bundler(project_root: &Path) -> Result<Bundler> {
    let tento_web_root = std::env::var_os("TENTO_WEB")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| {
            let path = project_root.join(TENTO).join("tento-web");
            path.is_dir().then_some(path)
        })
        .context("locate tento-web; set TENTO_WEB if it is not at the project root's TENTO path")?;
    let tento_web = Arc::new(TentoWeb(tento_web_root));
    let esbuild = Arc::new(EsbuildClient::new(tento_web.clone()).context("start esbuild")?);
    Ok(Bundler::new(esbuild, tento_web))
}

/// The webapp over `config.web_root`, with a bundler when it will build.
pub fn webapp(config: &AppConfig, info: BuildInfo, build: bool) -> Result<Webapp> {
    Ok(Webapp::new(
        Arc::new(domain(config, info)) as Arc<dyn DomainConfigLike>,
        if build {
            Some(bundler(&config.project_root)?)
        } else {
            None
        },
        build_state(&config.web_root),
    )
    .with_project_root(Some(config.project_root.clone())))
}

/// `autophys build-web`: bundle `html/routes` into `out` and return it.
pub async fn build_web(project_root: PathBuf, out: PathBuf) -> Result<PathBuf> {
    let config = AppConfig {
        project_root,
        web_root: out.clone(),
    };
    webapp(&config, BuildInfo::current(), true)?
        .build_beta()
        .await
        .context("bundle html/routes")?;
    if let Some(warning) = check_build_status(&out)? {
        eprintln!("autophys: warning: {warning}");
    }
    Ok(out)
}

/// tento-web returns `Ok` from a build whose bundle reported errors; the
/// `build-status.json` it writes beside `routes/` says whether it was clean.
/// A failed bundle is an error carrying esbuild's messages. A failed per-file
/// emit (the `?fe=unbundled` module tree, which autophys does not serve) is
/// returned as a warning: tento-web derives its store two levels above the
/// output root and resolves modules against the tento tree, which a project
/// outside tento does not always satisfy.
pub fn check_build_status(root: &Path) -> Result<Option<String>> {
    let path = root.join("build-status.json");
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let status: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    let lines = |key: &str| -> String {
        status[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|line| line.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    if status["status"] != "ok" {
        anyhow::bail!(
            "bundling html/routes failed ({}):\n{}",
            path.display(),
            lines("errors")
        );
    }
    if status.get("emitter_status").is_some_and(|s| s != "ok") {
        return Ok(Some(format!(
            "the per-file emit failed (the bundle is fine; {}):\n{}",
            path.display(),
            lines("emitter_errors")
        )));
    }
    Ok(None)
}

/// An actix server for `webapp` on an already-bound loopback listener. It
/// handles no signals itself: [`serve`] drains it when `shutdown` resolves.
pub fn http_server(
    listener: std::net::TcpListener,
    webapp: Arc<Webapp>,
) -> std::io::Result<Server> {
    Ok(HttpServer::new(move || {
        let webapp = webapp.clone();
        App::new().configure(move |cfg| webapp.configure(cfg, web::scope("")))
    })
    .disable_signals()
    .shutdown_timeout(10)
    .listen(listener)?
    .run())
}

/// Run `server` until `shutdown` resolves, then stop accepting and drain
/// in-flight requests.
pub async fn serve(
    server: Server,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let handle = server.handle();
    tokio::spawn(async move {
        shutdown.await;
        handle.stop(true).await;
    });
    server.await
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

/// `autophys serve`: bind first (so a taken port fails before any build),
/// bundle unless serving a prebuilt tree, then serve until a signal.
pub async fn run(serve_config: ServeConfig) -> Result<()> {
    let listener = std::net::TcpListener::bind(serve_config.addr)
        .with_context(|| format!("bind {}", serve_config.addr))?;
    let build = serve_config.web_root.is_none();
    let config = AppConfig {
        project_root: project_root(),
        web_root: match serve_config.web_root {
            Some(root) => root,
            None => default_web_root()?,
        },
    };
    let info = BuildInfo::current();
    let webapp = Arc::new(webapp(&config, info.clone(), build)?);
    // Held for the server's lifetime: dropping it stops the dev watch.
    let _watch = if build {
        webapp.build_beta().await.context("bundle html/routes")?;
        // Keep serving a broken dev build: the watch rebuilds on the fix.
        match check_build_status(&config.web_root) {
            Ok(None) => {}
            Ok(Some(warning)) => eprintln!("autophys: warning: {warning}"),
            Err(error) => eprintln!("autophys: {error:#}"),
        }
        Some(
            webapp
                .watch_dev()
                .await
                .context("watch html/routes and its deps")?,
        )
    } else {
        None
    };
    eprintln!(
        "autophys {} ({}, tento {}) serving {} {} on http://{}",
        info.version,
        info.commit,
        info.tento_commit,
        if build { "dev build" } else { "prebuilt" },
        config.web_root.display(),
        listener.local_addr()?,
    );
    serve(http_server(listener, webapp)?, termination()).await?;
    eprintln!("autophys: stopped");
    Ok(())
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
}
