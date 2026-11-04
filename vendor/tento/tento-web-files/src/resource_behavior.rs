use std::{
  fs,
  path::{Path, PathBuf},
};

use actix_files::NamedFile;
use actix_web::{
  HttpResponse,
  body::BoxBody,
  dev::{ServiceRequest, ServiceResponse},
  http,
};
use serde::{Deserialize, Serialize};
use tento_openapi::ToSchema;

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub enum ResourceBehavior {
  File {
    #[schema(value_type = String)]
    path: PathBuf,
    is_relative: bool,
  },
  Redirect {
    location: String,
    /// If true, use location as-is. If false (default), redirect to root domain.
    #[serde(default)]
    absolute: bool,
    /// Target subdomain (e.g., "calendar"). Only used when absolute is false.
    /// If specified, redirects to this subdomain instead of root domain.
    #[serde(default)]
    subdomain: Option<String>,
  },
  Template {
    #[schema(value_type = String)]
    path: PathBuf,
    is_relative: bool,
    handler: String,
  },
}

impl ResourceBehavior {
  pub async fn to_response(
    &self,
    req: ServiceRequest,
    original_path: &PathBuf,
  ) -> actix_web::Result<ServiceResponse<BoxBody>> {
    match self {
      ResourceBehavior::File { path, is_relative } => {
        match NamedFile::open_async(if *is_relative {
          original_path
            .parent()
            .expect("")
            .join(path)
            .canonicalize()
            .expect("")
        } else {
          path.to_path_buf()
        })
        .await
        {
          Ok(named_file) => {
            let (req, _) = req.into_parts();
            let res = named_file.into_response(&req);
            Ok(ServiceResponse::new(req, res))
          }
          Err(err) => Ok(req.error_response(err)),
        }
      }
      ResourceBehavior::Template { .. } => {
        unreachable!("Template rendering handled by yuzu-rs ResourceFile")
      }
      ResourceBehavior::Redirect {
        location,
        absolute,
        subdomain,
      } => {
        let (req, _) = req.into_parts();

        // Build redirect URL
        let base_url = if *absolute {
          location.to_owned()
        } else {
          let conn_info = req.connection_info();
          let scheme = conn_info.scheme();
          let host = conn_info.host();

          let url = match subdomain {
            Some(target_subdomain) => {
              // Redirect to specific subdomain, preserving dev/fleet prefix
              build_subdomain_url(scheme, host, target_subdomain, location)
            }
            None => {
              // Redirect to root domain, preserving dev/fleet prefix
              build_root_domain_url(scheme, host, location)
            }
          };
          drop(conn_info);
          url
        };

        // Preserve query parameters from the original request
        let redirect_url = if let Some(query_string) = req.uri().query() {
          format!("{}?{}", base_url, query_string)
        } else {
          base_url
        };

        Ok(ServiceResponse::new(
          req,
          HttpResponse::Found()
            .append_header((http::header::LOCATION, redirect_url))
            .finish(),
        ))
      }
    }
  }
}

/**
 * "index.anon.html"
 * "cell-data-store.ts"
 * "lona-marketing-header.ts"
 */
#[derive(Debug, Clone)]
pub struct ResourceFile {
  pub uri: String,
  pub requires_login: bool,
  pub path: PathBuf,
  pub behavior: ResourceBehavior,
}

impl ResourceFile {
  pub fn new(
    routes_root_path: impl Into<PathBuf>,
    absolute_path: impl Into<PathBuf>,
  ) -> Option<Self> {
    let absolute_path: PathBuf = absolute_path.into();
    let routes_root_path: PathBuf = routes_root_path.into();
    let filename = absolute_path
      .file_name()
      .expect("a filename should always exist")
      .to_str()
      .expect("filename not unicode");
    let absolute_path_str = absolute_path
      .to_str()
      .expect("absolute path is not unicode");

    match filename {
      "index.html" => Some(ResourceFile {
        requires_login: true,
        uri: ResourceFile::make_resource_uri(&absolute_path, &routes_root_path, filename),
        behavior: ResourceBehavior::File {
          path: absolute_path.clone(),
          is_relative: false,
        },
        path: absolute_path,
      }),
      "index.anon.html" => Some(ResourceFile {
        requires_login: false,
        uri: ResourceFile::make_resource_uri(&absolute_path, &routes_root_path, filename),
        behavior: ResourceBehavior::File {
          path: absolute_path.clone(),
          is_relative: false,
        },
        path: absolute_path,
      }),
      "index.json" => Some(ResourceFile {
        requires_login: true,
        uri: ResourceFile::make_resource_uri(&absolute_path, &routes_root_path, filename),
        behavior: serde_json::from_str(
          &fs::read_to_string(&absolute_path).expect("couldn't read path"),
        )
        .unwrap_or_else(|_| panic!("couldn't parse json: {absolute_path_str:?}")),
        path: absolute_path,
      }),
      "index.anon.json" => Some(ResourceFile {
        requires_login: false,
        uri: ResourceFile::make_resource_uri(&absolute_path, &routes_root_path, filename),
        behavior: serde_json::from_str(
          &fs::read_to_string(&absolute_path).expect("couldn't read path"),
        )
        .expect("couldn't parse json"),
        path: absolute_path,
      }),
      _ => None,
    }
  }

  pub async fn to_response(
    &self,
    req: ServiceRequest,
  ) -> actix_web::Result<ServiceResponse<BoxBody>> {
    self.behavior.to_response(req, &self.path).await
  }

  fn make_resource_uri(absolute_path: &Path, routes_root_path: &Path, filename: &str) -> String {
    let base = absolute_path
      .strip_prefix(routes_root_path)
      .expect("routes_root should be a prefix of the absolute path")
      .to_str()
      .expect("stripped path should be a string still")
      .strip_suffix(filename)
      .expect("stripped path should still exist without a filename")
      .trim_end_matches("/")
      .to_owned();

    if base.is_empty() {
      base.to_owned()
    } else {
      format!("/{base}")
    }
  }
}

/// Build a URL to a specific subdomain, preserving dev/fleet prefixes.
///
/// Examples:
/// - `lona.so` + `calendar` + `/path` -> `https://calendar.lona.so/path`
/// - `dev.lona.so` + `calendar` + `/path` -> `https://dev--calendar.lona.so/path`
/// - `aws-04.lona.so` + `calendar` + `/path` -> `https://aws-04--calendar.lona.so/path`
/// - `dev--ui.lona.so` + `calendar` + `/path` -> `https://dev--calendar.lona.so/path`
fn build_subdomain_url(scheme: &str, host: &str, target_subdomain: &str, path: &str) -> String {
  use crate::domain_type::DomainType;

  // Strip port if present
  let host_without_port = host.split(':').next().unwrap_or(host);

  let parts: Vec<&str> = host_without_port.split('.').collect();

  // For domains like lona.so (2 parts), prepend subdomain
  if parts.len() < 3 {
    return format!(
      "{}://{}.{}{}",
      scheme, target_subdomain, host_without_port, path
    );
  }

  // For 3+ parts, check for prefix--subdomain pattern
  let subdomain_part = parts[0];
  let root_domain = parts[1..].join(".");

  if let Some((prefix, _actual_subdomain)) = subdomain_part.split_once("--") {
    // dev--calendar.lona.so -> dev--{target}.lona.so
    format!(
      "{}://{}--{}.{}{}",
      scheme, prefix, target_subdomain, root_domain, path
    )
  } else if DomainType::is_fleet_prefix(subdomain_part) {
    // dev.lona.so or aws-04.lona.so -> {prefix}--{target}.lona.so
    format!(
      "{}://{}--{}.{}{}",
      scheme, subdomain_part, target_subdomain, root_domain, path
    )
  } else {
    // Plain subdomain like calendar.lona.so -> {target}.lona.so
    format!("{}://{}.{}{}", scheme, target_subdomain, root_domain, path)
  }
}

/// Build a URL to the root domain, preserving dev/fleet prefixes.
///
/// Examples:
/// - `dev--calendar.lona.so` + `/signin` -> `https://dev.lona.so/signin`
/// - `aws-04--calendar.lona.so` + `/signin` -> `https://aws-04.lona.so/signin`
/// - `dev.lona.so` + `/signin` -> `https://dev.lona.so/signin` (already root)
/// - `calendar.lona.so` + `/signin` -> `https://lona.so/signin`
/// - `lona.so` + `/signin` -> `https://lona.so/signin`
fn build_root_domain_url(scheme: &str, host: &str, path: &str) -> String {
  use crate::domain_type::DomainType;

  // Strip port if present
  let host_without_port = host.split(':').next().unwrap_or(host);

  let parts: Vec<&str> = host_without_port.split('.').collect();

  // For domains like lona.so (2 parts), just use as-is
  if parts.len() < 3 {
    return format!("{}://{}{}", scheme, host, path);
  }

  // For 3+ parts, check for prefix--subdomain pattern
  let subdomain_part = parts[0];
  let root_domain = parts[1..].join(".");

  if let Some((prefix, _actual_subdomain)) = subdomain_part.split_once("--") {
    // dev--calendar.lona.so -> dev.lona.so
    format!("{}://{}.{}{}", scheme, prefix, root_domain, path)
  } else if DomainType::is_fleet_prefix(subdomain_part) {
    // dev.lona.so or aws-04.lona.so -> keep as-is (already root for that instance)
    format!("{}://{}{}", scheme, host_without_port, path)
  } else {
    // calendar.lona.so -> lona.so (strip subdomain)
    format!("{}://{}{}", scheme, root_domain, path)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_build_root_domain_url() {
    // Dev prefix patterns
    assert_eq!(
      build_root_domain_url("https", "dev--calendar.lona.so", "/signin"),
      "https://dev.lona.so/signin"
    );
    assert_eq!(
      build_root_domain_url("https", "dev--ui.lona.so", "/api/auth"),
      "https://dev.lona.so/api/auth"
    );

    // Fleet prefix patterns
    assert_eq!(
      build_root_domain_url("https", "aws-04--calendar.lona.so", "/signin"),
      "https://aws-04.lona.so/signin"
    );
    assert_eq!(
      build_root_domain_url("https", "aws-09--ui.lona.so", "/"),
      "https://aws-09.lona.so/"
    );
    assert_eq!(
      build_root_domain_url("https", "rc--calendar.lona.so", "/signin"),
      "https://rc.lona.so/signin"
    );

    // Dev/fleet root domain (already root, keep as-is)
    assert_eq!(
      build_root_domain_url("https", "dev.lona.so", "/signin"),
      "https://dev.lona.so/signin"
    );
    assert_eq!(
      build_root_domain_url("https", "aws-04.lona.so", "/signin"),
      "https://aws-04.lona.so/signin"
    );
    assert_eq!(
      build_root_domain_url("https", "rc.lona.so", "/signin"),
      "https://rc.lona.so/signin"
    );

    // Plain subdomain (strip to root)
    assert_eq!(
      build_root_domain_url("https", "calendar.lona.so", "/signin"),
      "https://lona.so/signin"
    );
    assert_eq!(
      build_root_domain_url("https", "ui.lona.so", "/signin"),
      "https://lona.so/signin"
    );

    // Root domain (keep as-is)
    assert_eq!(
      build_root_domain_url("https", "lona.so", "/signin"),
      "https://lona.so/signin"
    );

    // With port (preserved for 2-part domains)
    assert_eq!(
      build_root_domain_url("https", "lona.so:8080", "/signin"),
      "https://lona.so:8080/signin"
    );

    // HTTP scheme
    assert_eq!(
      build_root_domain_url("http", "dev--calendar.lona.so", "/test"),
      "http://dev.lona.so/test"
    );
  }

  #[test]
  fn test_build_subdomain_url() {
    // From root domain to subdomain
    assert_eq!(
      build_subdomain_url("https", "lona.so", "calendar", "/"),
      "https://calendar.lona.so/"
    );
    assert_eq!(
      build_subdomain_url("https", "lona.so", "calendar", "?referrer=landing"),
      "https://calendar.lona.so?referrer=landing"
    );

    // From dev root to dev subdomain (preserves dev prefix)
    assert_eq!(
      build_subdomain_url("https", "dev.lona.so", "calendar", "/"),
      "https://dev--calendar.lona.so/"
    );
    assert_eq!(
      build_subdomain_url("https", "rc.lona.so", "calendar", "/"),
      "https://rc--calendar.lona.so/"
    );

    // From fleet root to fleet subdomain (preserves fleet prefix)
    assert_eq!(
      build_subdomain_url("https", "aws-04.lona.so", "calendar", "/"),
      "https://aws-04--calendar.lona.so/"
    );

    // From dev prefixed subdomain to another subdomain
    assert_eq!(
      build_subdomain_url("https", "dev--ui.lona.so", "calendar", "/"),
      "https://dev--calendar.lona.so/"
    );
    assert_eq!(
      build_subdomain_url("https", "dev--calendar.lona.so", "static", "/css/app.css"),
      "https://dev--static.lona.so/css/app.css"
    );
    assert_eq!(
      build_subdomain_url("https", "rc--calendar.lona.so", "static", "/css/app.css"),
      "https://rc--static.lona.so/css/app.css"
    );

    // From fleet prefixed subdomain to another subdomain
    assert_eq!(
      build_subdomain_url("https", "aws-04--ui.lona.so", "calendar", "/"),
      "https://aws-04--calendar.lona.so/"
    );
    assert_eq!(
      build_subdomain_url("https", "aws-10--calendar.lona.so", "static", "/"),
      "https://aws-10--static.lona.so/"
    );

    // From plain subdomain to another subdomain
    assert_eq!(
      build_subdomain_url("https", "calendar.lona.so", "static", "/css/app.css"),
      "https://static.lona.so/css/app.css"
    );
    assert_eq!(
      build_subdomain_url("https", "ui.lona.so", "calendar", "/"),
      "https://calendar.lona.so/"
    );
  }
}
