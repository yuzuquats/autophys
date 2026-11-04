use std::fmt::Display;

use actix::fut::{Ready, ready};
use actix_http::Uri;
use actix_web::{FromRequest, dev::ServiceRequest};

use crate::host_utils::get_host_uri;

#[derive(Debug, Clone, Eq, Hash, PartialEq)]
pub enum DomainType {
  RootDomain,
  SubDomain { name: String },
}

impl Display for DomainType {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::RootDomain => f.write_str("<root>"),
      Self::SubDomain { name } => f.write_fmt(format_args!("{}.<root>", name)),
    }
  }
}

impl FromRequest for DomainType {
  type Error = actix_web::Error;

  type Future = Ready<Result<Self, Self::Error>>;

  fn from_request(req: &actix_web::HttpRequest, _: &mut actix_http::Payload) -> Self::Future {
    ready(Ok(DomainType::extract_from_request(req)))
  }
}

impl DomainType {
  pub fn extract_from_request(req: &actix_web::HttpRequest) -> DomainType {
    let host_uri = get_host_uri(req.head()).expect("hostguard should have checked for uri");
    DomainType::extract_from_host_uri(host_uri)
  }

  pub fn extract_from_service_request(req: &ServiceRequest) -> DomainType {
    let host_uri = get_host_uri(req.head()).expect("hostguard should have checked for uri");
    DomainType::extract_from_host_uri(host_uri)
  }

  pub fn extract_from_host_uri(host_uri: Uri) -> DomainType {
    let host_name = host_uri.to_string();
    let host_without_port = host_name.split(':').next().unwrap_or(&host_name);

    if host_without_port.parse::<std::net::IpAddr>().is_ok() {
      return DomainType::RootDomain;
    }

    // Fleet-wrap origins: `<app>.<host>.tento.localhost` is how the laptop's
    // tento-localhost proxy addresses a wrapped miniapp (the proxy splices the
    // request through with the Host header intact). The labels left of
    // `tento.localhost` name the wrap target, not a subdomain of the app —
    // wrapped apps always serve their root domain (the wrap grammar has no
    // way to express an app subdomain). Mirrors localhost.node's BASE_HOST
    // (that crate sits above tento-web, so the constant can't be imported).
    const WRAP_BASE_HOST: &str = "tento.localhost";
    if host_without_port == WRAP_BASE_HOST
      || host_without_port
        .strip_suffix(WRAP_BASE_HOST)
        .is_some_and(|prefix| prefix.ends_with('.'))
    {
      return DomainType::RootDomain;
    }

    let components = host_without_port.split(".").collect::<Vec<&str>>();

    // For domains like:
    //   lona.so (2 parts) → RootDomain
    //   ui.lona.so (3 parts) → SubDomain{ui}
    //   www.lona.so (3 parts) → RootDomain
    //   rc.lona.so (3 parts, named instance prefix) → RootDomain
    //   rc--calendar.lona.so (3 parts, named instance with subdomain) → SubDomain{calendar}
    //   aws-04.lona.so (3 parts, fleet prefix) → RootDomain
    //   aws-04--ui.lona.so (3 parts, fleet with subdomain) → SubDomain{ui}
    //   aws-04--calendar.lona.so (3 parts, fleet with subdomain) → SubDomain{calendar}
    //
    // Fleet subdomains use "--" separator: aws-04--ui means fleet "aws-04", subdomain "ui"
    if components.len() >= 3 {
      let subdomain_part = components[components.len() - 3];

      // Check for fleet subdomain pattern: fleet--subdomain (e.g., aws-04--ui)
      if let Some((fleet_prefix, actual_subdomain)) = subdomain_part.split_once("--") {
        if Self::is_fleet_prefix(fleet_prefix) && !actual_subdomain.is_empty() {
          return DomainType::SubDomain {
            name: actual_subdomain.to_string(),
          };
        }
      }

      // Plain subdomain or fleet root
      if subdomain_part == "www" || Self::is_fleet_prefix(subdomain_part) {
        DomainType::RootDomain
      } else {
        DomainType::SubDomain {
          name: subdomain_part.to_string(),
        }
      }
    } else {
      DomainType::RootDomain
    }
  }

  /// Check if a string looks like a fleet prefix.
  ///
  /// Valid patterns:
  /// - "dev" (dev environment)
  /// - "rc" (release-candidate environment)
  /// - "ci" (the rwc-05 verification environment)
  /// - "local" (the operator laptop's pseudo-host in the tento.localhost registry)
  /// - "{provider}-{number}" where provider is lowercase letters and number is digits
  ///   Examples: aws-04, gcp-01, oracle-12, custom-99
  ///
  /// `ci` earns its place for the same reason `dev`/`rc` do: it names a host
  /// position (the verification instance on rwc-05), not a service. Without it
  /// `ci.lona.so` reads as a SubDomain{ci} — a service nothing serves — and
  /// `ci--calendar.lona.so` never resolves to the calendar app at all.
  ///
  /// `local` earns its place for the same reason `dev`/`rc` do: it is a host
  /// position, not a service. tento.localhost proxies wrapped apps at
  /// `<app>.<host>.tento.localhost`, and every real fleet id (`rwc-03`,
  /// `gcp-05`) already matches provider-number — so only the laptop, whose id
  /// is literally `local`, was misread as a service subdomain and 404'd every
  /// app it wrapped.
  pub fn is_fleet_prefix(name: &str) -> bool {
    if matches!(name, "dev" | "rc" | "ci" | "local") {
      return true;
    }

    // Fleet prefixes end in a number; providers may have hyphenated segments.
    if let Some((provider, number)) = name.rsplit_once('-') {
      !provider.is_empty()
        && provider
          .split('-')
          .all(|segment| !segment.is_empty() && segment.chars().all(|c| c.is_ascii_lowercase()))
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
    } else {
      false
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn host_domain_type(host: &str) -> DomainType {
    DomainType::extract_from_host_uri(host.parse().expect("host should parse as URI"))
  }

  #[test]
  fn named_instance_prefixes_are_root_domains() {
    assert_eq!(host_domain_type("dev.lona.so"), DomainType::RootDomain);
    assert_eq!(host_domain_type("rc.lona.so"), DomainType::RootDomain);
    assert_eq!(host_domain_type("ci.lona.so"), DomainType::RootDomain);
  }

  #[test]
  fn fleet_wrap_hosts_are_root_domains() {
    // `<app>.<host>.tento.localhost` — the tento-localhost proxy's wrap origin
    // for a kind-1 miniapp; the app behind it serves its root domain.
    assert_eq!(
      host_domain_type("campaigns.yuzuquats.tento.localhost"),
      DomainType::RootDomain
    );
    assert_eq!(
      host_domain_type("market-research.yuzuquats.tento.localhost"),
      DomainType::RootDomain
    );
    assert_eq!(host_domain_type("tento.localhost"), DomainType::RootDomain);
  }

  #[test]
  fn named_instance_prefixed_hosts_resolve_to_service_subdomains() {
    assert_eq!(
      host_domain_type("dev--calendar.lona.so"),
      DomainType::SubDomain {
        name: "calendar".to_string()
      }
    );
    assert_eq!(
      host_domain_type("rc--calendar.lona.so"),
      DomainType::SubDomain {
        name: "calendar".to_string()
      }
    );
    // The rwc-05 verification instance. This is the assertion the `ci`
    // environment actually rides on: without `ci` in `is_fleet_prefix`, this
    // reads as SubDomain{"ci--calendar"} and the calendar app never answers.
    assert_eq!(
      host_domain_type("ci--calendar.lona.so"),
      DomainType::SubDomain {
        name: "calendar".to_string()
      }
    );
  }

  #[test]
  fn tento_localhost_wrapped_apps_resolve_to_the_root_domain() {
    // `<app>.<host>.tento.localhost` is the proxy shape. The host label sits in
    // the subdomain position, so it must read as a fleet prefix — otherwise the
    // app's own pages 404 while its API routes still answer.
    assert_eq!(
      host_domain_type("tento-task-graph.rwc-03.tento.localhost"),
      DomainType::RootDomain
    );
    assert_eq!(
      host_domain_type("tento-task-graph.local.tento.localhost"),
      DomainType::RootDomain
    );
    assert_eq!(
      host_domain_type("local.tento.localhost"),
      DomainType::RootDomain
    );
  }

  #[test]
  fn fleet_prefix_validation_accepts_named_and_provider_number_prefixes() {
    assert!(DomainType::is_fleet_prefix("local"));
    assert!(DomainType::is_fleet_prefix("dev"));
    assert!(DomainType::is_fleet_prefix("rc"));
    assert!(DomainType::is_fleet_prefix("ci"));
    assert!(DomainType::is_fleet_prefix("htz-02"));
    assert!(DomainType::is_fleet_prefix("oracle-12"));
    assert!(DomainType::is_fleet_prefix("rwc-dev-01"));

    assert!(!DomainType::is_fleet_prefix("aws"));
    assert!(!DomainType::is_fleet_prefix("rcx"));
    assert!(!DomainType::is_fleet_prefix("cix"));
    assert!(!DomainType::is_fleet_prefix("aws-02a"));
    assert!(!DomainType::is_fleet_prefix("aws2-02"));
    assert!(!DomainType::is_fleet_prefix("rwc--dev-01"));
    assert!(!DomainType::is_fleet_prefix("rwc-dev-a"));
    assert!(!DomainType::is_fleet_prefix("rwc-Dev-01"));
  }

  #[test]
  fn hyphenated_fleet_provider_preserves_root_and_service_routes() {
    assert_eq!(
      host_domain_type("rwc-dev-01.lona.so"),
      DomainType::RootDomain
    );
    assert_eq!(
      host_domain_type("rwc-dev-01--calendar.lona.so"),
      DomainType::SubDomain {
        name: "calendar".into()
      }
    );
    assert_eq!(
      host_domain_type("rwc-dev-01--static.lona.so"),
      DomainType::SubDomain {
        name: "static".into()
      }
    );
  }
}
