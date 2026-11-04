//! The autophys daemon, a tento-web app. `autophys serve` runs one loopback
//! actix listener: `/api/healthz` and the file-based router over
//! `html/routes` (built on start, or prebuilt by `autophys build-web`).

pub mod app;
pub mod server;

pub use app::{APP_ID, AppConfig, BuildInfo, TENTO, domain};
pub use server::{
    DEFAULT_ADDR, ServeConfig, USAGE, build_web, check_build_status, check_route_tree,
    default_web_root, http_server, parse_build_web, parse_loopback, parse_serve, project_root, run,
    serve, termination, webapp,
};
