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
use crate::http::Api;
use crate::keys::Options;

/// The default listen address: loopback, port 4794 (decision AP-3).
pub const DEFAULT_ADDR: &str = "127.0.0.1:4794";

pub const USAGE: &str =
    "usage: autophys serve [--addr 127.0.0.1:4794] [--web-root DIR] [--collection DIR]
                      [--server-db FILE] [--browser-origin ORIGIN]...
                      [--login] [--public-url https://host]
       autophys build-web [--out DIR] [--bundle FILE]
       autophys pack --web-root DIR --out FILE [--no-maps]
       autophys pair list | pair approve <CODE> | pair deny <CODE>
       autophys keys list [--json] | keys revoke <KEY_ID>
       autophys users list | users add <EMAIL> [--read-only] | users set <EMAIL> --read-only|--read-write | users remove <EMAIL>
       autophys db verify [--rebuild] [--json] [--project NAME]   (db check is the same)
       autophys train dataset | train run | train eval | train runs   (autophys train for details)
       (pair, keys and db also take --collection DIR and --server-db FILE;
        --db DIR is an alias of --collection)";

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
    /// The collection: a directory of `<slug>.ap-workbook` files. `None`
    /// means [`default_collection`].
    pub collection: Option<PathBuf>,
    /// The server database (keys, pairings). `None` means
    /// [`default_server_db`] in the app data directory.
    pub server_db: Option<PathBuf>,
    /// Extra origins whose keyless browser writes are admitted (O-3), such as
    /// `http://autophys.rwc-dev-01.tento.localhost`.
    pub browser_origins: Vec<String>,
    /// `--login` / `AUTOPHYS_LOGIN=1`: browsers sign in with invited accounts.
    pub login: bool,
    /// `--public-url` / `AUTOPHYS_PUBLIC_URL`: the origin people use, such as
    /// `https://autophys.lona.so` (pairing and invite links point there).
    pub public_url: Option<String>,
}

/// Split a comma-separated origin list; each must be `http(s)://host[:port]`.
fn origins(text: &str) -> Result<Vec<String>, String> {
    text.split(',')
        .map(str::trim)
        .filter(|o| !o.is_empty())
        .map(|o| {
            let o = o.trim_end_matches('/');
            let uri = o.parse::<actix_web::http::Uri>().ok();
            let valid = uri.as_ref().is_some_and(|u| {
                matches!(u.scheme_str(), Some("http" | "https"))
                    && u.authority().is_some_and(|a| !a.as_str().contains('@'))
                    && matches!(u.path(), "" | "/")
                    && u.query().is_none()
                    && !o.contains('#')
            });
            if valid {
                Ok(o.to_string())
            } else {
                Err(format!(
                    "--browser-origin {o:?} is not an origin (http(s)://host[:port], no path)"
                ))
            }
        })
        .collect()
}

/// `serve` flags: `--addr` / `AUTOPHYS_ADDR` (default [`DEFAULT_ADDR`]),
/// `--web-root` / `AUTOPHYS_WEB_ROOT`, `--collection` (alias `--db`) /
/// `AUTOPHYS_HOME` (default [`default_collection`]), `--login` /
/// `AUTOPHYS_LOGIN` (`1`, `true` or `yes`), `--public-url` /
/// `AUTOPHYS_PUBLIC_URL` (an origin), `--server-db` /
/// `AUTOPHYS_SERVER_DB`, and `--browser-origin` (repeatable,
/// comma-separated) / `AUTOPHYS_BROWSER_ORIGINS`. Flags win over the
/// environment.
pub fn parse_serve(
    args: impl IntoIterator<Item = String>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<ServeConfig, String> {
    let nonempty = |k: &str| env(k).filter(|v| !v.is_empty());
    let mut addr = env("AUTOPHYS_ADDR");
    let mut web_root = nonempty("AUTOPHYS_WEB_ROOT");
    let mut collection = nonempty("AUTOPHYS_HOME");
    let mut server_db = nonempty("AUTOPHYS_SERVER_DB");
    let mut browser_origins = match nonempty("AUTOPHYS_BROWSER_ORIGINS") {
        Some(list) => origins(&list)?,
        None => Vec::new(),
    };
    let mut login = nonempty("AUTOPHYS_LOGIN")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
    let mut public_url = nonempty("AUTOPHYS_PUBLIC_URL");
    let mut flagged_origins = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (key, inline) = split_flag(&arg);
        match key.as_str() {
            "--addr" => addr = Some(flag_value(&key, inline, &mut args)?),
            "--web-root" => web_root = Some(flag_value(&key, inline, &mut args)?),
            "--collection" | "--db" => collection = Some(flag_value(&key, inline, &mut args)?),
            "--server-db" => server_db = Some(flag_value(&key, inline, &mut args)?),
            "--login" if inline.is_none() => login = true,
            "--public-url" => public_url = Some(flag_value(&key, inline, &mut args)?),
            "--browser-origin" => {
                flagged_origins.extend(origins(&flag_value(&key, inline, &mut args)?)?)
            }
            other => return Err(format!("unknown argument {other:?}\n{USAGE}")),
        }
    }
    if !flagged_origins.is_empty() {
        browser_origins = flagged_origins;
    }
    let addr = parse_loopback(addr.as_deref().unwrap_or(DEFAULT_ADDR))?;
    let web_root = web_root.map(PathBuf::from);
    if let Some(root) = &web_root {
        check_route_tree(root)?;
    }
    let public_url = match public_url {
        Some(url) => Some(
            origins(&url)
                .map_err(|e| e.replace("--browser-origin", "--public-url"))?
                .into_iter()
                .next()
                .ok_or("--public-url is empty")?,
        ),
        None => None,
    };
    Ok(ServeConfig {
        addr,
        web_root,
        collection: collection.map(PathBuf::from),
        server_db: server_db.map(PathBuf::from),
        browser_origins,
        login,
        public_url,
    })
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

/// tento-web deletes the output folder before every build. A hand-typed
/// `--out ~/notes` would delete the notes, so `build-web` only writes into a
/// folder that is missing, empty, or an earlier build (it has
/// `build-status.json`). tento-web also keeps a module store two levels above
/// the folder; that store only adds files.
pub fn check_out_dir(out: &Path) -> Result<()> {
    let mut entries = match std::fs::read_dir(out) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e).with_context(|| format!("read --out {}", out.display())),
    };
    if entries.next().is_none() || out.join("build-status.json").is_file() {
        return Ok(());
    }
    anyhow::bail!(
        "--out {}: not empty and not an earlier build-web output; the build \
         deletes this folder first, so pick a new or empty one",
        out.display()
    )
}

/// `autophys build-web`: bundle `html/routes` into `out` and return it.
pub async fn build_web(project_root: PathBuf, out: PathBuf) -> Result<PathBuf> {
    check_out_dir(&out)?;
    let config = AppConfig {
        project_root,
        web_root: out.clone(),
        store: None,
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

/// The collection `serve`, `pair`, `keys` and `db` use without a flag:
/// `$AUTOPHYS_HOME`, else `~/autophys`, the same directory the SDKs open
/// with no target, so the daemon serves the workbooks local programs write.
pub fn default_collection() -> PathBuf {
    autophys::default_home()
}

/// Keys and pairings live in the app's tento-dirs data directory (AX-17).
pub fn default_server_db() -> Result<PathBuf> {
    Ok(AppDirs::resolve(APP_ID)?.data.join("server.db"))
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
    let exe = std::env::current_exe().context("locate autophys executable")?;
    let payload = crate::embedded::locate(&exe)?;
    anyhow::ensure!(
        option_env!("AUTOPHYS_RELEASE") != Some("1") || payload.is_some(),
        "release binary has no embedded web payload; run autophys pack after stripping"
    );
    let (web_root, build, web_id) = match serve_config.web_root {
        Some(root) => (root, false, None),
        None => match payload {
            Some(payload) => {
                let cache = AppDirs::resolve(APP_ID)?.cache;
                let root = crate::embedded::hydrate(&exe, &payload, &cache)?;
                (root, false, Some(payload.id))
            }
            None => (default_web_root()?, true, None),
        },
    };
    let collection = serve_config.collection.unwrap_or_else(default_collection);
    let server_db = match serve_config.server_db {
        Some(path) => path,
        None => default_server_db()?,
    };
    let options = Options {
        // The app lists devices waiting to pair; that is where a code is approved.
        verification_url: match &serve_config.public_url {
            Some(url) => format!("{url}/app"),
            None => format!("http://{}/app", listener.local_addr()?),
        },
        browser_origins: serve_config.browser_origins,
        login: serve_config.login,
        public_url: serve_config.public_url,
        ..Options::default()
    };
    let api = Api::open(&collection, &server_db, options).with_context(|| {
        format!(
            "open the collection {} and the server database {}",
            collection.display(),
            server_db.display()
        )
    })?;
    let config = AppConfig {
        project_root: project_root(),
        web_root,
        store: Some(api),
    };
    let mut info = BuildInfo::current();
    info.web_id = web_id;
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
    if let Some(api) = config.store.as_ref().filter(|a| a.options().login) {
        let users = api.keys.users_list().map(|u| u.len()).unwrap_or(0);
        eprintln!(
            "autophys: --login: browsers must sign in ({users} account(s); add one with \
             `autophys users add EMAIL`)"
        );
    }
    eprintln!(
        "autophys {} ({}) serving {} {} and collection {} on http://{}",
        info.version,
        info.commit,
        if build { "dev build" } else { "prebuilt" },
        config.web_root.display(),
        collection.display(),
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

    fn tree(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("autophys-{name}-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("routes")).unwrap();
        std::fs::write(dir.join("routes/index.anon.html"), "x").unwrap();
        dir
    }

    #[test]
    fn serve_reads_flags_over_env() {
        let dir = tree("config");
        let env = |k: &str| match k {
            "AUTOPHYS_ADDR" => Some("127.0.0.1:1".to_string()),
            "AUTOPHYS_WEB_ROOT" => Some(dir.display().to_string()),
            _ => None,
        };
        let from_env = parse_serve(Vec::<String>::new(), env).unwrap();
        assert_eq!(from_env.addr.port(), 1);
        assert_eq!(from_env.web_root.as_deref(), Some(dir.as_path()));
        let flagged = parse_serve(["--addr=127.0.0.1:2".to_string()], env).unwrap();
        assert_eq!(flagged.addr.port(), 2);
        assert!(parse_serve(["--addr".into(), "0.0.0.0:2".into()], env).is_err());
        assert!(parse_serve(["--bogus".into()], env).is_err());
        assert!(parse_serve(["--addr".into()], env).is_err());
        assert_eq!(
            (from_env.collection.as_ref(), from_env.server_db.as_ref()),
            (None, None)
        );
        let with_db = parse_serve(["--db=/tmp/c".to_string()], env).unwrap();
        assert_eq!(with_db.collection.as_deref(), Some(Path::new("/tmp/c")));
        let flagged = parse_serve(
            ["--collection", "/tmp/d", "--server-db", "/tmp/s.db"].map(String::from),
            env,
        )
        .unwrap();
        assert_eq!(flagged.collection.as_deref(), Some(Path::new("/tmp/d")));
        assert_eq!(flagged.server_db.as_deref(), Some(Path::new("/tmp/s.db")));
        assert!(
            default_server_db()
                .unwrap()
                .ends_with("tento/autophys/server.db")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn serve_without_a_web_root_builds_from_source() {
        let config = parse_serve(Vec::<String>::new(), |_| None).unwrap();
        assert_eq!(config.addr, DEFAULT_ADDR.parse().unwrap());
        assert_eq!(config.web_root, None);
    }

    #[test]
    fn browser_origins_come_from_flags_or_env() {
        let env = |k: &str| {
            (k == "AUTOPHYS_BROWSER_ORIGINS").then(|| {
                "http://autophys.rwc-dev-01.tento.localhost, https://x.localhost:8443/".to_string()
            })
        };
        let from_env = parse_serve(Vec::<String>::new(), env).unwrap();
        assert_eq!(
            from_env.browser_origins,
            [
                "http://autophys.rwc-dev-01.tento.localhost",
                "https://x.localhost:8443"
            ]
        );
        let flagged = parse_serve(
            [
                "--browser-origin",
                "http://a.localhost",
                "--browser-origin=http://b.localhost",
            ]
            .map(String::from),
            env,
        )
        .unwrap();
        assert_eq!(
            flagged.browser_origins,
            ["http://a.localhost", "http://b.localhost"]
        );
        assert!(
            parse_serve(
                ["--browser-origin", "a.localhost"].map(String::from),
                |_| None
            )
            .is_err()
        );
        assert!(
            parse_serve(["--browser-origin", "http://a/x"].map(String::from), |_| {
                None
            })
            .is_err()
        );
    }

    #[test]
    fn a_web_root_must_be_a_built_route_tree() {
        let err = parse_serve(
            ["--web-root".into(), "/nonexistent/autophys".into()],
            |_| None,
        )
        .unwrap_err();
        assert!(err.contains("routes/index.anon.html"), "{err}");
    }

    #[test]
    fn a_failed_build_status_is_an_error() {
        let dir = tree("status");
        let write = |body: &str| std::fs::write(dir.join("build-status.json"), body).unwrap();
        write(r#"{"status":"ok","emitter_status":"ok","errors":[]}"#);
        assert_eq!(check_build_status(&dir).unwrap(), None);
        write(r#"{"status":"failed","errors":["Could not resolve \"@tento-trace\""]}"#);
        let err = check_build_status(&dir).unwrap_err().to_string();
        assert!(err.contains("@tento-trace"), "{err}");
        write(r#"{"status":"ok","emitter_status":"failed","emitter_errors":["x"]}"#);
        let warning = check_build_status(&dir)
            .unwrap()
            .expect("an emit failure is a warning");
        assert!(warning.contains("per-file emit"), "{warning}");
        std::fs::remove_file(dir.join("build-status.json")).unwrap();
        assert!(
            check_build_status(&dir).is_err(),
            "a missing status is not a clean build"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn build_web_never_replaces_a_folder_it_did_not_write() {
        let dir = tree("out-guard");
        let out = dir.join("web");
        assert!(check_out_dir(&out).is_ok(), "a missing folder");
        std::fs::create_dir_all(&out).unwrap();
        assert!(check_out_dir(&out).is_ok(), "an empty folder");
        std::fs::write(out.join("notes.txt"), "keep").unwrap();
        let err = check_out_dir(&out).unwrap_err().to_string();
        assert!(err.contains("not an earlier build-web output"), "{err}");
        std::fs::write(out.join("build-status.json"), "{}").unwrap();
        assert!(check_out_dir(&out).is_ok(), "an earlier build");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn build_web_takes_only_out() {
        assert_eq!(parse_build_web(Vec::<String>::new()).unwrap(), None);
        assert_eq!(
            parse_build_web(["--out=/tmp/x".to_string()]).unwrap(),
            Some(PathBuf::from("/tmp/x"))
        );
        assert!(parse_build_web(["--web-root".into(), "x".into()]).is_err());
    }
}
