//! The autophys tento-web app: one `DomainConfig` whose compiler bundles
//! `html/routes` by file name (`index.anon.html`, `index.root.ts`), and whose
//! `.config` registers the daemon's routes on the same actix app.

use std::path::PathBuf;

use actix_web::{HttpRequest, HttpResponse, web};
use serde::Serialize;
use tento_web::{
    DomainConfig,
    compiler::{Action, Compiler},
};

pub const APP_ID: &str = "autophys";

/// The tento tree this app builds against, relative to the project root: the
/// vendored copy. The only tento path on the Rust side besides `Cargo.toml`.
pub const TENTO: &str = "vendor/tento";

/// What `/api/healthz` reports about this binary.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct BuildInfo {
    pub version: String,
    /// The autophys commit `ops/deploy.sh` stamps in through `AUTOPHYS_COMMIT`.
    pub commit: String,
    /// The git tree id of `vendor/tento`, the tento tree whose cookbook and
    /// tento-ui the bundle was built from, stamped through
    /// `AUTOPHYS_TENTO_COMMIT`.
    pub tento_commit: String,
}

impl BuildInfo {
    /// The Cargo version plus the stamped commits; a plain `cargo build`
    /// reports `dev` for both.
    pub fn current() -> Self {
        BuildInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            commit: option_env!("AUTOPHYS_COMMIT").unwrap_or("dev").to_string(),
            tento_commit: option_env!("AUTOPHYS_TENTO_COMMIT")
                .unwrap_or("dev")
                .to_string(),
        }
    }
}

/// Where the app's sources and its built route tree are.
#[derive(Clone, Debug)]
pub struct AppConfig {
    /// The autophys checkout: `html/` and the `vendor/tento` compiler deps are
    /// resolved against it. Only a build reads it.
    pub project_root: PathBuf,
    /// The route tree that is served: written by a build, or prebuilt by
    /// `autophys build-web` and passed as `serve --web-root`.
    pub web_root: PathBuf,
}

#[derive(Serialize)]
struct Health<'a> {
    ok: bool,
    version: &'a str,
    commit: &'a str,
    tento_commit: &'a str,
}

/// The page the cookbook's client routes answer with: the built shell.
#[derive(Clone)]
struct Shell(PathBuf);

pub fn domain(config: &AppConfig, info: BuildInfo) -> DomainConfig {
    // Compiler deps are watched relative to the html root (`html/`), not the
    // project root: the routes themselves, then the tento trees they import.
    let compiler = Compiler::builder()
        .dep((".", Action::RebuildRoutes))
        .dep((
            format!("../{TENTO}/tento-cookbook-js").as_str(),
            Action::RebuildRoutes,
        ))
        .dep((
            format!("../{TENTO}/tento-ui-js").as_str(),
            Action::RebuildRoutes,
        ))
        .build();
    let info = web::Data::new(info);
    let shell = web::Data::new(Shell(config.web_root.join("routes/index.anon.html")));

    DomainConfig::builder()
        .hostname("localhost")
        .project_root(config.project_root.clone())
        .compiler(Some(compiler))
        .config(move |cfg| {
            cfg.app_data(info.clone());
            cfg.app_data(shell.clone());
            cfg.route("/api/healthz", web::get().to(healthz));
            // Anything else under /api is a JSON 404, never the page.
            cfg.route("/api", web::route().to(api_not_found));
            cfg.route("/api/{tail:.*}", web::route().to(api_not_found));
            // The cookbook's client routes (`/app`, `/app/<item>`) are the
            // same document as `/`; the file router serves `/` itself.
            cfg.route("/app", web::get().to(app_document));
            cfg.route("/app/{tail:.*}", web::get().to(app_document));
        })
        .build()
}

async fn healthz(info: web::Data<BuildInfo>) -> HttpResponse {
    HttpResponse::Ok().json(Health {
        ok: true,
        version: &info.version,
        commit: &info.commit,
        tento_commit: &info.tento_commit,
    })
}

async fn api_not_found(req: HttpRequest) -> HttpResponse {
    HttpResponse::NotFound()
        .json(serde_json::json!({ "ok": false, "error": "not found", "path": req.path() }))
}

async fn app_document(shell: web::Data<Shell>) -> HttpResponse {
    match tokio::fs::read(&shell.0).await {
        Ok(html) => HttpResponse::Ok()
            .content_type("text/html; charset=utf-8")
            .body(html),
        Err(error) => HttpResponse::InternalServerError()
            .content_type("text/plain; charset=utf-8")
            .body(format!("the built shell is missing ({error})\n")),
    }
}
