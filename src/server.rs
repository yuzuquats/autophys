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
       autophys new DIR --lang python|rust [--example REF] [--name NAME]
                    [--existing] [--no-install] [--sdk-rev REV]
       autophys examples [--json] | examples --check [REF]...
       autophys connect [URL] [--name NAME] | whoami [--json]
       autophys bench | research | autoloop | export-trajectories | mcp   (developer tools; autophys <command> --help)
       autophys pair list | pair approve <CODE> | pair deny <CODE>
       autophys keys list [--json] | keys revoke <KEY_ID>
       autophys users list | users add <EMAIL> [--read-only] | users set <EMAIL> --read-only|--read-write|--demo|--no-demo | users remove <EMAIL>
       autophys workspace list | bind | key | profile | seed [--server-db FILE] [--apply]\n       autophys db verify [--rebuild] [--json] [--project NAME]   (db check is the same)
       autophys train dataset | run | eval | runs | loop | loops   (autophys train for details)
       autophys overview set PROJECT FILE.md [--author NAME] | overview show PROJECT [--json]   (--target DIR|FILE|URL)
       (pair, keys and db also take --collection DIR and --server-db FILE;
        --db DIR is an alias of --collection; without --server-db each
        collection has its own server database, except under --login)";

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
    /// [`server_db_for`] the collection ([`default_server_db`] with `--login`).
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
/// environment, except browser origins: the flagged and environment origins
/// are joined (environment first, duplicates dropped), so a deploy that
/// passes `--browser-origin` keeps the origins a unit drop-in sets.
pub fn parse_serve(
    args: impl IntoIterator<Item = String>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<ServeConfig, String> {
    let nonempty = |k: &str| env(k).filter(|v| !v.is_empty());
    let mut addr = env("AUTOPHYS_ADDR");
    let mut web_root = nonempty("AUTOPHYS_WEB_ROOT");
    let mut collection = nonempty("AUTOPHYS_HOME");
    let mut server_db = nonempty("AUTOPHYS_SERVER_DB");
    let env_origins = match nonempty("AUTOPHYS_BROWSER_ORIGINS") {
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
            other if other.starts_with('-') => {
                return Err(format!("unknown option {other:?}\n{USAGE}"));
            }
            other => return Err(format!("unexpected argument {other:?}\n{USAGE}")),
        }
    }
    let mut browser_origins: Vec<String> = Vec::new();
    for origin in env_origins.into_iter().chain(flagged_origins) {
        if !browser_origins.contains(&origin) {
            browser_origins.push(origin);
        }
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
            other if other.starts_with('-') => {
                return Err(format!("unknown option {other:?}\n{USAGE}"));
            }
            other => return Err(format!("unexpected argument {other:?}\n{USAGE}")),
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
    let esbuild = Arc::new(EsbuildClient::with_deno_config(
        tento_web.clone(),
        &project_root.join("html/deno.json"),
        std::env::var("AUTOPHYS_BUILD_OFFLINE").as_deref() == Ok("1"),
    ).context("start esbuild with frozen product dependencies")?);
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

/// The server database for `collection` when neither `--server-db` nor
/// `AUTOPHYS_SERVER_DB` names one (decision G1-DB). A server database pins
/// the one local collection it serves, so the default follows the
/// collection the way the collection follows `$AUTOPHYS_HOME`.
pub fn server_db_for(collection: &Path) -> Result<PathBuf> {
    let standard = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("autophys"));
    choose_server_db(&AppDirs::resolve(APP_ID)?.data, collection, standard.as_deref())
}

/// The app-data `server.db` serves the collection it is already pinned to,
/// or `~/autophys` while it is unpinned; that keeps every existing key and
/// pairing where it was. Any other collection gets its own database under
/// `collections/<name>-<hash of its path>/`.
fn choose_server_db(data: &Path, collection: &Path, standard: Option<&Path>) -> Result<PathBuf> {
    let shared = data.join("server.db");
    let root = resolved(collection);
    match pinned_local_root(&shared)? {
        Some(pinned) if pinned == root => return Ok(shared),
        None if standard.is_some_and(|s| resolved(s) == root) => return Ok(shared),
        _ => {}
    }
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(root.as_os_str().as_encoded_bytes());
    let name: String = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(40)
        .collect();
    Ok(data
        .join("collections")
        .join(format!("{name}-{}", hex::encode(&digest[..8])))
        .join("server.db"))
}

/// The collection a server database's local workspace is pinned to, if the
/// database exists and has served one. Read only: choosing a database never
/// creates or migrates one.
pub fn pinned_local_root(server_db: &Path) -> Result<Option<PathBuf>> {
    use rusqlite::{Connection, OpenFlags, OptionalExtension};
    if !server_db.exists() {
        return Ok(None);
    }
    // A database that exists but cannot be read is an error, not "unpinned":
    // treating it as unpinned would start an empty database for a collection
    // whose keys and pairings are in this one.
    let read = || -> rusqlite::Result<Option<String>> {
        let conn = Connection::open_with_flags(server_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        // A running server may hold a brief lock (migration, checkpoint);
        // wait as the key store does rather than fail the command.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let has_table: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')",
            [],
            |r| r.get(0),
        )?;
        if !has_table {
            return Ok(None);
        }
        conn.query_row("SELECT root FROM workspaces WHERE id = 'local'", [], |r| r.get(0))
            .optional()
    };
    read()
        .map(|root| root.map(PathBuf::from))
        .with_context(|| format!("read which collection {} serves", server_db.display()))
}

/// `path` with symlinks resolved as far as it exists, so a collection names
/// the same database before and after its directory is created (the server
/// pins the canonical path).
fn resolved(path: &Path) -> PathBuf {
    use std::path::Component;
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let parts: Vec<Component> = absolute.components().collect();
    for split in (1..=parts.len()).rev() {
        let Ok(mut real) = std::fs::canonicalize(parts[..split].iter().collect::<PathBuf>()) else {
            continue;
        };
        // The rest does not exist yet, so it holds no symlinks: `..` removes
        // the previous name, as it will once create_dir_all has made it.
        for part in &parts[split..] {
            match part {
                Component::CurDir => {}
                Component::ParentDir => {
                    real.pop();
                }
                other => real.push(other),
            }
        }
        return real;
    }
    absolute
}

/// A local (no `--login`) server must serve the collection its database is
/// pinned to; say so at startup instead of answering every request 403.
fn check_pin(collection: &Path, server_db: &Path) -> Result<()> {
    let Some(pinned) = pinned_local_root(server_db)? else {
        return Ok(());
    };
    let root = resolved(collection);
    if pinned == root {
        return Ok(());
    }
    anyhow::bail!(
        "the server database {} serves the collection {}, not {}. Omit --server-db \
         (and AUTOPHYS_SERVER_DB) to use this collection's own database, or pass \
         another --server-db.",
        server_db.display(),
        pinned.display(),
        root.display()
    )
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
    // Held while serving, so another start's cache pruning keeps this tree.
    let mut _hold = None;
    let (web_root, build, web_id) = match serve_config.web_root {
        Some(root) => (root, false, None),
        None => match payload {
            Some(payload) => {
                let cache = AppDirs::resolve(APP_ID)?.cache;
                let root = crate::embedded::hydrate(&exe, &payload, &cache)?;
                _hold = Some(crate::embedded::hold(&root)?);
                (root, false, Some(payload.id))
            }
            None => (default_web_root()?, true, None),
        },
    };
    let collection = serve_config.collection.unwrap_or_else(default_collection);
    // A --login server keeps the one app-data database its accounts and
    // workspace assignments live in; a local server's follows the collection.
    let server_db = match serve_config.server_db {
        Some(path) => path,
        None if serve_config.login => default_server_db()?,
        None => server_db_for(&collection)?,
    };
    if !serve_config.login {
        check_pin(&collection, &server_db)?;
    }
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
        "autophys {} ({}) serving {} {} and collection {} (server database {}) on http://{}",
        info.version,
        info.commit,
        if build { "dev build" } else { "prebuilt" },
        config.web_root.display(),
        collection.display(),
        server_db.display(),
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

    fn pin(db: &Path, root: &Path) {
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let conn = rusqlite::Connection::open(db).unwrap();
        conn.execute_batch("CREATE TABLE workspaces (id TEXT PRIMARY KEY, root TEXT NOT NULL)")
            .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, root) VALUES ('local', ?1)",
            [root.to_string_lossy().as_ref()],
        )
        .unwrap();
    }

    #[test]
    fn the_server_database_follows_the_collection() {
        let tmp = std::env::temp_dir().join(format!("ap-g1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let (data, standard, other) = (tmp.join("data"), tmp.join("autophys"), tmp.join("scratch/coll"));
        let shared = data.join("server.db");
        // Unpinned: ~/autophys takes the shared database, anything else its own.
        assert_eq!(choose_server_db(&data, &standard, Some(&standard)).unwrap(), shared);
        let own = choose_server_db(&data, &other, Some(&standard)).unwrap();
        assert!(own.starts_with(data.join("collections")) && own.ends_with("server.db"));
        assert!(own.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with("coll-"));
        // The same collection names the same database before and after it exists.
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(choose_server_db(&data, &other, Some(&standard)).unwrap(), own);
        assert_ne!(choose_server_db(&data, &tmp.join("scratch/coll2"), Some(&standard)).unwrap(), own);
        // A shared database already pinned to a collection keeps serving it
        // (existing keys stay put); ~/autophys then gets its own.
        pin(&shared, &resolved(&other));
        assert_eq!(choose_server_db(&data, &other, Some(&standard)).unwrap(), shared);
        let standard_own = choose_server_db(&data, &standard, Some(&standard)).unwrap();
        assert!(standard_own.starts_with(data.join("collections")));
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn a_server_database_pinned_elsewhere_fails_at_startup() {
        let tmp = std::env::temp_dir().join(format!("ap-g1-pin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let (a, b, db) = (tmp.join("a"), tmp.join("b"), tmp.join("server.db"));
        std::fs::create_dir_all(&a).unwrap();
        assert!(check_pin(&b, &db).is_ok(), "a missing database pins nothing");
        pin(&db, &resolved(&a));
        assert_eq!(pinned_local_root(&db).unwrap(), Some(resolved(&a)));
        assert!(check_pin(&a, &db).is_ok());
        let message = check_pin(&b, &db).unwrap_err().to_string();
        assert!(message.contains("serves the collection"), "{message}");
        assert!(message.contains("Omit --server-db"), "{message}");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn an_unreadable_server_database_is_an_error_not_unpinned() {
        let tmp = std::env::temp_dir().join(format!("ap-g1-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let data = tmp.join("data");
        std::fs::create_dir_all(&data).unwrap();
        // A database without the workspaces table yet pins nothing.
        rusqlite::Connection::open(data.join("server.db")).unwrap();
        assert_eq!(pinned_local_root(&data.join("server.db")).unwrap(), None);
        std::fs::write(data.join("server.db"), b"not a sqlite database, padded past the header size")
            .unwrap();
        let e = choose_server_db(&data, &tmp.join("coll"), None).unwrap_err();
        assert!(format!("{e:#}").contains("read which collection"), "{e:#}");
        assert!(check_pin(&tmp.join("coll"), &data.join("server.db")).is_err());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn a_missing_collection_names_the_path_it_will_have() {
        let tmp = std::env::temp_dir().join(format!("ap-g1-dots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let typed = tmp.join("missing/../coll/./x");
        let before = resolved(&typed);
        std::fs::create_dir_all(&typed).unwrap();
        assert_eq!(before, std::fs::canonicalize(&typed).unwrap());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn serve_without_a_web_root_builds_from_source() {
        let config = parse_serve(Vec::<String>::new(), |_| None).unwrap();
        assert_eq!(config.addr, DEFAULT_ADDR.parse().unwrap());
        assert_eq!(config.web_root, None);
    }

    #[test]
    fn browser_origins_join_flags_and_env() {
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
        let flags = [
            "--browser-origin",
            "http://a.localhost",
            "--browser-origin=http://b.localhost,https://x.localhost:8443",
        ]
        .map(String::from);
        let flagged = parse_serve(flags.clone(), |_| None).unwrap();
        assert_eq!(
            flagged.browser_origins,
            ["http://a.localhost", "http://b.localhost", "https://x.localhost:8443"]
        );
        // A deploy passes the flag; a drop-in's environment origins stay.
        let both = parse_serve(flags, env).unwrap();
        assert_eq!(
            both.browser_origins,
            [
                "http://autophys.rwc-dev-01.tento.localhost",
                "https://x.localhost:8443",
                "http://a.localhost",
                "http://b.localhost",
            ],
            "flag and environment origins are joined, duplicates dropped"
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
