use actix::fut::{Ready, ready};
use actix_web::{FromRequest, dev::ServiceRequest};
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevMode {
  Beta,
  ReleaseCandidate,
  Prod,
}

impl FromStr for DevMode {
  type Err = String;

  fn from_str(s: &str) -> Result<Self, Self::Err> {
    match s {
      "beta" => Ok(DevMode::Beta),
      "rc" => Ok(DevMode::ReleaseCandidate),
      "prod" => Ok(DevMode::Prod),
      _ => Err(format!("invalid dev mode: {}", s)),
    }
  }
}

impl DevMode {
  pub fn from_str(s: &str) -> DevMode {
    <Self as FromStr>::from_str(s).unwrap_or(DevMode::Prod)
  }

  pub fn to_str(&self) -> &str {
    match self {
      DevMode::Beta => "beta",
      DevMode::ReleaseCandidate => "rc",
      DevMode::Prod => "prod",
    }
  }

  pub fn extract_from_service_request(req: &ServiceRequest) -> Self {
    // Check for query parameter first
    if let Some(dev_mode) = req.query_string().split('&').find_map(|param| {
      let parts: Vec<&str> = param.split('=').collect();
      if parts.len() == 2 && parts[0] == "dev-mode" {
        Some(DevMode::from_str(parts[1]))
      } else {
        None
      }
    }) {
      return dev_mode;
    }

    // Check for cookie
    if let Some(cookie) = req.cookie("dev-mode") {
      return DevMode::from_str(cookie.value());
    }

    let conn_info = req.connection_info();
    let host = conn_info.host();
    if let Some(dev_mode) = Self::mode_from_host(host) {
      return dev_mode;
    }

    DevMode::Prod
  }

  /// Infer the default frontend stage from a named instance hostname.
  fn mode_from_host(host: &str) -> Option<Self> {
    // Remove port if present
    let host_without_port = host.split(':').next().unwrap_or(host);
    let parts: Vec<&str> = host_without_port.split('.').collect();
    if parts.is_empty() {
      return None;
    }

    let subdomain = parts[0];
    if subdomain == "dev" || subdomain.starts_with("dev--") {
      return Some(DevMode::Beta);
    }
    if subdomain == "rc" || subdomain.starts_with("rc--") {
      return Some(DevMode::ReleaseCandidate);
    }
    None
  }

  /// Check if the host indicates a dev environment
  #[cfg(test)]
  fn is_dev_host(host: &str) -> bool {
    matches!(Self::mode_from_host(host), Some(DevMode::Beta))
  }

  pub fn extract_from_request(req: &actix_web::HttpRequest) -> Self {
    // Check for query parameter first
    if let Some(dev_mode) = req.query_string().split('&').find_map(|param| {
      let parts: Vec<&str> = param.split('=').collect();
      if parts.len() == 2 && parts[0] == "dev-mode" {
        Some(DevMode::from_str(parts[1]))
      } else {
        None
      }
    }) {
      return dev_mode;
    }

    // Check for cookie
    if let Some(cookie) = req.cookie("dev-mode") {
      return DevMode::from_str(cookie.value());
    }

    let conn_info = req.connection_info();
    let host = conn_info.host();
    if let Some(dev_mode) = Self::mode_from_host(host) {
      return dev_mode;
    }

    DevMode::Prod
  }
}

impl FromRequest for DevMode {
  type Error = actix_web::Error;

  type Future = Ready<Result<Self, Self::Error>>;

  fn from_request(req: &actix_web::HttpRequest, _: &mut actix_http::Payload) -> Self::Future {
    ready(Ok(DevMode::extract_from_request(req)))
  }
}

/// Frontend delivery mode, orthogonal to `DevMode`'s stage axis. Selects whether
/// a route serves the monolithic bundle (default) or the per-file unbundled build
/// (import map + content-hashed modules served from the shared module store).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeMode {
  Bundled,
  Unbundled,
}

impl FeMode {
  pub fn from_str(s: &str) -> FeMode {
    match s {
      "unbundled" => FeMode::Unbundled,
      _ => FeMode::Bundled,
    }
  }

  pub fn to_str(&self) -> &str {
    match self {
      FeMode::Bundled => "bundled",
      FeMode::Unbundled => "unbundled",
    }
  }

  /// The mode explicitly requested via `?fe=…`, if the query carries an `fe`
  /// param. `None` when it doesn't — lets callers persist an explicit choice as
  /// the `fe-mode` cookie without rewriting the cookie on every request.
  pub fn query_override_from_service_request(req: &ServiceRequest) -> Option<Self> {
    req.query_string().split('&').find_map(|param| {
      let parts: Vec<&str> = param.split('=').collect();
      if parts.len() == 2 && parts[0] == "fe" {
        Some(FeMode::from_str(parts[1]))
      } else {
        None
      }
    })
  }

  /// Query param `?fe=unbundled` > cookie `fe-mode` > default `Bundled`.
  pub fn extract_from_service_request(req: &ServiceRequest) -> Self {
    if let Some(fe) = Self::query_override_from_service_request(req) {
      return fe;
    }

    if let Some(cookie) = req.cookie("fe-mode") {
      return FeMode::from_str(cookie.value());
    }

    FeMode::Bundled
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_is_dev_host() {
    // Dev subdomain patterns - should return true
    assert!(DevMode::is_dev_host("dev.lona.so"));
    assert!(DevMode::is_dev_host("dev.lona.so:443"));
    assert!(DevMode::is_dev_host("dev--calendar.lona.so"));
    assert!(DevMode::is_dev_host("dev--calendar.lona.so:8080"));
    assert!(DevMode::is_dev_host("dev--ui.lona.so"));

    // Production patterns - should return false
    assert!(!DevMode::is_dev_host("lona.so"));
    assert!(!DevMode::is_dev_host("www.lona.so"));
    assert!(!DevMode::is_dev_host("calendar.lona.so"));
    assert!(!DevMode::is_dev_host("ui.lona.so"));
    assert!(!DevMode::is_dev_host("api.lona.so"));

    // Fleet patterns - should return false (not dev)
    assert!(!DevMode::is_dev_host("aws-04.lona.so"));
    assert!(!DevMode::is_dev_host("aws-04--calendar.lona.so"));

    // Edge cases
    assert!(!DevMode::is_dev_host("localhost"));
    assert!(!DevMode::is_dev_host("localhost:3000"));
    assert!(!DevMode::is_dev_host("127.0.0.1"));
    assert!(!DevMode::is_dev_host("192.168.1.1:8080"));
    assert!(!DevMode::is_dev_host(""));

    // Tricky cases - "dev" appearing elsewhere
    assert!(!DevMode::is_dev_host("developer.lona.so"));
    assert!(!DevMode::is_dev_host("mydev.lona.so"));
    assert!(!DevMode::is_dev_host("dev-test.lona.so")); // single dash, not double
  }

  #[test]
  fn mode_from_host_infers_rc_hostnames() {
    assert_eq!(
      DevMode::mode_from_host("rc.lona.so"),
      Some(DevMode::ReleaseCandidate)
    );
    assert_eq!(
      DevMode::mode_from_host("rc--calendar.lona.so"),
      Some(DevMode::ReleaseCandidate)
    );
    assert_eq!(
      DevMode::mode_from_host("rc--calendar.lona.so:443"),
      Some(DevMode::ReleaseCandidate)
    );
    assert_eq!(DevMode::mode_from_host("dev.lona.so"), Some(DevMode::Beta));
    assert_eq!(DevMode::mode_from_host("calendar.lona.so"), None);
  }

  /// `ci` is deliberately NOT a stage here, and this test is what says so.
  ///
  /// `DomainType::is_fleet_prefix` accepts `ci` so the rwc-05 verification
  /// instance routes its apps, but the stage axis is separate: `ci` hosts a
  /// PACKAGED release, whose frontend is the prod payload (`target.web`), not
  /// a beta or rc stage rebuilt from a working tree. `mode_from_host`
  /// returning `None` is exactly that — the caller falls through to
  /// `DevMode::Prod`. If `ci` ever needs its own stage, it needs a
  /// `target.web.ci` in the bundle schema first; adding a variant here alone
  /// would serve it an empty directory.
  #[test]
  fn ci_hostnames_take_the_prod_stage() {
    assert_eq!(DevMode::mode_from_host("ci.lona.so"), None);
    assert_eq!(DevMode::mode_from_host("ci--calendar.lona.so"), None);
  }
}
