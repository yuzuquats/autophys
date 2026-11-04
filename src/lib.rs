//! The autophys daemon, a tento-web app. `autophys serve` runs one loopback
//! actix listener: `/api/healthz`, the `/api/v1` hook in [`app`], and the
//! file-based router over `html/routes` (built on start, or prebuilt by
//! `autophys build-web`). The record store sits beside them: `store` (the
//! SQLite log, projections, keys and pairing), `ingest` (the one append
//! path) and `http` (`/api/v1` on actix).

pub mod app;
pub mod http;
pub mod ingest;
pub mod server;
pub mod store;

pub use app::{APP_ID, AppConfig, BuildInfo, TENTO, domain};
pub use server::{
    DEFAULT_ADDR, ServeConfig, USAGE, build_web, check_build_status, check_route_tree, default_db,
    default_web_root, http_server, parse_build_web, parse_loopback, parse_serve, project_root, run,
    serve, termination, webapp,
};
