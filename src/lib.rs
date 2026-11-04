//! The autophys daemon (package `autophys-cli`, binary `autophys`), a
//! tento-web app. `autophys serve` runs one loopback actix listener:
//! `/api/healthz`, the `/api/v1` hook in [`app`], and the file-based router
//! over `html/routes` (built on start, or prebuilt by `autophys build-web`).
//! `/api/v1` ([`http`]) maps each route to one call into the `autophys`
//! crate (`sdks/rust`) over a collection of `.ap-workbook` files; [`keys`]
//! holds the server's own database of API keys and pairings; [`admin`] is
//! `autophys pair | keys | db`.

pub mod admin;
pub mod app;
pub mod embedded;
pub mod error;
pub mod http;
pub mod keys;
pub mod scripts;
pub mod server;

pub use app::{APP_ID, AppConfig, BuildInfo, TENTO, domain};
pub use server::{
    DEFAULT_ADDR, ServeConfig, USAGE, build_web, check_build_status, check_route_tree,
    default_collection, default_server_db, default_web_root, http_server, parse_build_web,
    parse_loopback, parse_serve, project_root, run, serve, termination, webapp,
};
