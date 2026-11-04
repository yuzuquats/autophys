//! Shared rate-limit carve-out for the static FE module store.
//!
//! The unbundled per-file build serves content-addressed, immutable modules
//! under `/js/m/**`. A single page load fetches 1000+ of them in one burst,
//! which would blow any per-IP or per-user request budget and 429 the page
//! mid-load. Both rate limiters in the request path — the global per-IP limiter
//! in [`crate::server`] and the per-domain auth limiter in `crate::app`'s
//! `domain_config` — route these requests to a single shared bucket with an
//! effectively-unlimited budget so they never touch the real counters.

use std::time::Duration;

use tento_web_rate_limit::backend::SimpleInput;

/// URL prefix of the content-addressed, immutable FE module store
/// (`target.web.modules`), served at `/js/m/**`.
pub(crate) const STATIC_MODULE_PREFIX: &str = "/js/m/";

/// Shared rate-limit bucket key for static module fetches.
const STATIC_MODULE_RATE_KEY: &str = "static-modules";

/// True when `path` targets the static module store and should bypass the
/// per-IP / per-user rate limiters.
pub(crate) fn is_static_module_path(path: &str) -> bool {
  path.starts_with(STATIC_MODULE_PREFIX)
}

/// Rate-limit input that exempts static module fetches: one shared key with an
/// effectively-unlimited budget, so a 1000+ module burst never touches the
/// per-IP / per-user counters.
pub(crate) fn static_module_rate_limit_input() -> SimpleInput {
  SimpleInput {
    interval: Duration::from_secs(60),
    max_requests: u64::MAX,
    key: STATIC_MODULE_RATE_KEY.to_string(),
  }
}
