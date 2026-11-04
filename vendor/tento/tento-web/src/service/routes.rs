use std::{
  collections::HashMap,
  fs,
  path::{Path, PathBuf},
};

use actix_files::NamedFile;
use actix_web::{
  HttpResponse,
  body::BoxBody,
  dev::{ResourceDef, ResourceMap, ServiceRequest, ServiceResponse},
  http, web,
};
use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use tento_core::fs::HasPathIter;

use crate::fs_utils::path_buf::PathBufWrap;
use crate::service::template_handler::TemplateHandlerRegistry;

use tento_web_files::domain_type::DomainType;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum ResourceBehavior {
  File {
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
    /// If true, redirect to the request path instead of the literal `location`.
    /// Useful for wildcard route shims such as `/sheet/{id}` -> calendar host.
    #[serde(default)]
    preserve_path: bool,
  },
  Template {
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
        unreachable!("Template rendering handled by ResourceFile::to_response")
      }
      ResourceBehavior::Redirect {
        location,
        absolute,
        subdomain,
        preserve_path,
      } => {
        let (req, _) = req.into_parts();
        let redirect_path = if *preserve_path {
          req.uri().path()
        } else {
          location.as_str()
        };

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
              build_subdomain_url(scheme, host, target_subdomain, redirect_path)
            }
            None => {
              // Redirect to root domain, preserving dev/fleet prefix
              build_root_domain_url(scheme, host, redirect_path)
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

/// Build a URL to a specific subdomain, preserving dev/fleet prefixes.
///
/// Examples:
/// - `lona.so` + `calendar` + `/path` -> `https://calendar.lona.so/path`
/// - `dev.lona.so` + `calendar` + `/path` -> `https://dev--calendar.lona.so/path`
/// - `aws-04.lona.so` + `calendar` + `/path` -> `https://aws-04--calendar.lona.so/path`
/// - `dev--ui.lona.so` + `calendar` + `/path` -> `https://dev--calendar.lona.so/path`
fn build_subdomain_url(scheme: &str, host: &str, target_subdomain: &str, path: &str) -> String {
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

/**
 * "index.anon.html"
 * "cell-data-store.ts"
 * "lona-marketing-header.ts"
 */
#[derive(Debug, Clone)]
pub struct ResourceFile {
  pub uri: String,
  requires_login: bool,
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
        .expect(&format!("couldn't parse json: {absolute_path_str:?}")),
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
    if let ResourceBehavior::Template {
      path,
      is_relative,
      handler,
    } = &self.behavior
    {
      let base_path = if *is_relative {
        self
          .path
          .parent()
          .expect("Template path should have parent")
          .join(path)
          .canonicalize()
          .expect("Template base path should be resolvable")
      } else {
        path.to_path_buf()
      };

      let base_html = match tokio::fs::read_to_string(&base_path).await {
        Ok(html) => html,
        Err(_) => {
          return Ok(req.into_response(HttpResponse::InternalServerError().finish()));
        }
      };

      let params = extract_path_params(&self.uri, req.path());

      let registry = req.app_data::<web::Data<TemplateHandlerRegistry>>();
      let Some(registry) = registry else {
        return Ok(req.into_response(HttpResponse::InternalServerError().finish()));
      };

      let Some(template_handler) = registry.get(handler) else {
        return Ok(req.into_response(HttpResponse::InternalServerError().finish()));
      };

      let Some(rendered) = template_handler.render_request(&base_html, &params, &req) else {
        return Ok(req.into_response(HttpResponse::NotFound().finish()));
      };

      let (req, _) = req.into_parts();
      return Ok(ServiceResponse::new(
        req,
        HttpResponse::Ok()
          .content_type("text/html; charset=utf-8")
          .body(rendered),
      ));
    }

    self.behavior.to_response(req, &self.path).await
  }

  pub fn template_matches(
    &self,
    request_path: &str,
    registry: &TemplateHandlerRegistry,
    req: &ServiceRequest,
  ) -> bool {
    let ResourceBehavior::Template { handler, .. } = &self.behavior else {
      return true;
    };
    let Some(template_handler) = registry.get(handler) else {
      return false;
    };
    let params = extract_path_params(&self.uri, request_path);
    template_handler.matches_request(&params, req)
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

    if base == "" {
      base.to_owned()
    } else {
      format!("/{base}")
    }
  }
}

#[derive(Debug, Clone)]
pub struct ResourceGroup {
  pub logged_in: Option<ResourceFile>,
  pub anonymous: Option<ResourceFile>,
}

#[derive(Debug, Clone)]
pub struct DomainedRoutes {
  project_root_path: PathBuf,
  routes: HashMap<DomainType, Routes>,
  /// The on-disk directory each tree came from (`routes`, `tsh.routes`, …).
  /// Static-file lookup needs the NAME, not the parsed tree, and it must
  /// resolve a Host exactly the way route lookup does — see [`Self::resolve`].
  dirs: HashMap<DomainType, String>,
}

impl DomainedRoutes {
  pub fn new(project_root_path: impl Into<PathBuf>) -> Self {
    let mut routes = HashMap::new();
    let mut dirs = HashMap::new();
    let project_root_path: PathBuf = project_root_path.into();

    let paths = fs::read_dir(&project_root_path).expect(&format!(
      "project root is not a directory: {project_root_path:?}"
    ));
    for child in paths {
      let child_path = child.expect("").path();
      let child_name = child_path
        .file_name()
        .expect("filename invalid (ends with ..)")
        .to_str()
        .expect("filename not unicode");
      if child_name.ends_with(".routes") {
        let mut components = child_name.split(".");
        let name = components
          .next()
          .expect("split should have a '.'")
          .to_string();
        let domain = DomainType::SubDomain { name };
        dirs.insert(domain.clone(), child_name.to_string());
        routes.insert(domain, Routes::new(child_path));
      } else if child_name == "routes" {
        dirs.insert(DomainType::RootDomain, child_name.to_string());
        routes.insert(DomainType::RootDomain, Routes::new(child_path));
      }
    }

    DomainedRoutes {
      routes,
      dirs,
      project_root_path,
    }
  }

  /// Which routes tree a request's Host resolves to.
  ///
  /// Normally one tree per `DomainType`: `so.lona` carries seven
  /// (`routes`, `blog.routes`, `calendar.routes`, …) and the Host is what
  /// picks between them.
  ///
  /// But a project root holding exactly ONE tree has no such ambiguity — there
  /// is only one thing a request could want — so that tree answers for every
  /// Host. This is what lets a single-domain app be reached through a name it
  /// does not own: `tento-tsh-landing` serves `tsh.lona.so` (a SubDomain) and
  /// is also reached at `127.0.0.1` and through the tento.localhost wrap
  /// proxy, which splices the Host header through unrewritten as
  /// `<id>.<host>.tento.localhost` and therefore reads as `RootDomain`.
  /// Without this, such an app 404s every request behind the proxy, and the
  /// alternative is a second routes tree that duplicates the first.
  ///
  /// Multi-tree projects are unaffected: the ambiguity there is real, and an
  /// unmatched Host still resolves to nothing.
  fn resolve<'a, T>(&'a self, map: &'a HashMap<DomainType, T>, domain_type: &DomainType) -> Option<&'a T> {
    if let Some(found) = map.get(domain_type) {
      return Some(found);
    }
    if map.len() == 1 {
      return map.values().next();
    }
    None
  }

  pub fn find_resource_group(
    &self,
    domain_type: &DomainType,
    pattern: &str,
  ) -> Option<&ResourceGroup> {
    let Some(route) = self.resolve(&self.routes, domain_type) else {
      return None;
    };
    route.find_resource_group(pattern)
  }

  /// List all routes for admin display.
  ///
  /// Returns a list of (subdomain_name, routes) pairs where subdomain_name is
  /// empty string for the root domain.
  pub fn list_routes(&self) -> Vec<(String, Vec<String>)> {
    self
      .routes
      .iter()
      .map(|(domain_type, routes)| {
        let name = match domain_type {
          DomainType::RootDomain => String::new(),
          DomainType::SubDomain { name } => name.clone(),
        };
        let mut paths: Vec<String> = routes.resources.keys().cloned().collect();
        paths.sort();
        (name, paths)
      })
      .collect()
  }

  pub fn find_static_file(
    &self,
    domain_type: &DomainType,
    pattern: &str,
  ) -> anyhow::Result<PathBuf> {
    let path_on_disk =
      PathBufWrap::parse_path(pattern, false).map_err(|e| anyhow!("pathbufwrap/parse >> {e}"))?;
    let path_on_disk_str = path_on_disk.as_ref().to_str().expect("");

    if path_on_disk_str.starts_with("@/") {
      return Ok(
        self
          .project_root_path
          .join(path_on_disk_str.trim_start_matches("@/")),
      );
    }

    // println!("--> {:#?} {:#?}", self.project_root_path, path_on_disk_str);

    // The same resolution as route lookup, so a Host that reaches the pages
    // also reaches the assets they reference.
    let routes_dir = self
      .resolve(&self.dirs, domain_type)
      .cloned()
      .unwrap_or_else(|| match domain_type {
        DomainType::RootDomain => "routes/".to_string(),
        DomainType::SubDomain { name } => format!("{name}.routes"),
      });

    Ok(self.project_root_path.join(routes_dir).join(path_on_disk_str))
  }
}

#[derive(Debug, Clone)]
pub struct Routes {
  routes: ResourceMap,
  resources: HashMap<String, ResourceGroup>,
}

impl Routes {
  pub fn new(routes_root: impl Into<PathBuf>) -> Self {
    let routes_root_path: PathBuf = routes_root.into();
    let mut routes = ResourceMap::new(ResourceDef::root_prefix(""));
    let mut resources = HashMap::new();

    for result in routes_root_path.as_path().visitor_iter().expect("") {
      let Ok((_idx, path)) = result else { continue };
      let Some(index_file) = ResourceFile::new(&routes_root_path, path) else {
        continue;
      };

      let uri = index_file.uri.clone();
      let mut rdef = ResourceDef::new(&uri);

      let res = {
        if let Some(resource) = resources.get_mut(&uri) {
          resource
        } else {
          resources.insert(
            uri.clone(),
            ResourceGroup {
              logged_in: None,
              anonymous: None,
            },
          );
          resources.get_mut(&uri).expect("just added")
        }
      };

      if index_file.requires_login {
        res.logged_in = Some(index_file);
      } else {
        res.anonymous = Some(index_file);
      }

      routes.add(&mut rdef, None);
    }

    Routes { routes, resources }
  }

  pub fn find_resource_group(&self, pattern: &str) -> Option<&ResourceGroup> {
    // println!("searching for pattern {}", pattern);
    let Some(resolved_resource) = self.routes.match_pattern(pattern) else {
      return None;
    };

    let resource = self
      .resources
      .get(&resolved_resource)
      .expect("resolved resource should exist in map");
    Some(resource)
  }

  #[allow(dead_code)]
  pub fn find_resource(&self, pattern: &str, logged_in: bool) -> Option<&ResourceFile> {
    let Some(resource_group) = self.find_resource_group(pattern) else {
      return None;
    };

    if logged_in && resource_group.logged_in.is_some() {
      resource_group.logged_in.as_ref()
    } else {
      resource_group.anonymous.as_ref()
    }
  }
}

fn extract_path_params(pattern: &str, request_path: &str) -> HashMap<String, String> {
  let mut params = HashMap::new();
  let rdef = ResourceDef::new(pattern);
  let mut path = actix_web::dev::Path::new(request_path);
  if rdef.capture_match_info(&mut path) {
    for (key, value) in path.iter() {
      params.insert(key.to_string(), value.to_string());
    }
  }
  params
}

#[cfg(test)]
mod tests {

  use super::*;

  #[test]
  fn test_file_behavior() {
    let redir = ResourceBehavior::Redirect {
      location: "www.google.com".to_owned(),
      absolute: false,
      subdomain: None,
      preserve_path: false,
    };

    let redir_ser = serde_json::to_string(&redir).expect("couldn't serialize");
    println!("{}", redir_ser);
  }

  #[test]
  fn subdomain_redirect_preserves_dev_prefix_with_path() {
    assert_eq!(
      build_subdomain_url("https", "dev.lona.so", "calendar", "/sheet/ss_abc"),
      "https://dev--calendar.lona.so/sheet/ss_abc"
    );
  }

  #[test]
  fn subdomain_redirect_preserves_existing_fleet_prefix_with_path() {
    assert_eq!(
      build_subdomain_url("https", "aws-04--ui.lona.so", "calendar", "/sheet/ss_abc"),
      "https://aws-04--calendar.lona.so/sheet/ss_abc"
    );
  }

  // Dot-prefixed request paths (`/.env`, `/.well-known/*`) are rejected by
  // `PathBufWrap::parse_path` — `find_static_file`'s only failure mode, since it
  // does no IO. The caller (`file_routes.rs`) maps that `Err` to a clean 404, not
  // a 500; this pins the routing decision that distinguishes the two.
  #[test]
  fn find_static_file_rejects_dot_paths() {
    let routes = DomainedRoutes::new(env!("CARGO_MANIFEST_DIR"));
    assert!(
      routes
        .find_static_file(&DomainType::RootDomain, "/.env")
        .is_err()
    );
    assert!(
      routes
        .find_static_file(
          &DomainType::RootDomain,
          "/.well-known/apple-app-site-association"
        )
        .is_err()
    );
    // An ordinary path resolves — the caller then does IO and 404s on a miss.
    assert!(
      routes
        .find_static_file(&DomainType::RootDomain, "/meta.json")
        .is_ok()
    );
  }

  /// A project with ONE routes tree answers on any Host.
  ///
  /// This is what makes a single-domain app reachable through a name it does
  /// not own — `tento-tsh-landing` serves `tsh.lona.so` and must also answer
  /// behind the tento.localhost wrap proxy, which splices the Host through
  /// unrewritten as `<id>.<host>.tento.localhost` (a RootDomain). Before this,
  /// such an app 404'd every request behind the proxy.
  #[test]
  fn a_lone_routes_tree_answers_for_every_host() {
    let temp = std::env::temp_dir().join(format!("domained-routes-lone-{}", std::process::id()));
    let _ = fs::remove_dir_all(&temp);
    fs::create_dir_all(temp.join("tsh.routes")).expect("create routes dir");
    fs::write(temp.join("tsh.routes/index.anon.html"), "<h1>tsh</h1>").expect("write page");

    let routes = DomainedRoutes::new(&temp);

    // The Host it owns.
    let owned = routes.find_static_file(
      &DomainType::SubDomain { name: "tsh".into() },
      "/index.anon.html",
    );
    assert_eq!(owned.unwrap(), temp.join("tsh.routes/index.anon.html"));

    // The Host the wrap proxy gives it, and a plain loopback request: both
    // read as RootDomain, and both must reach the SAME file.
    let wrapped = routes.find_static_file(&DomainType::RootDomain, "/index.anon.html");
    assert_eq!(wrapped.unwrap(), temp.join("tsh.routes/index.anon.html"));

    // A Host naming some other service resolves there too — with one tree
    // there is nothing else it could mean.
    let other = routes.find_static_file(
      &DomainType::SubDomain { name: "anything".into() },
      "/index.anon.html",
    );
    assert_eq!(other.unwrap(), temp.join("tsh.routes/index.anon.html"));

    fs::remove_dir_all(&temp).expect("cleanup");
  }

  /// A project with SEVERAL trees is unaffected: the ambiguity is real there,
  /// and the Host is what resolves it. This is the so.lona shape.
  #[test]
  fn several_routes_trees_still_resolve_strictly_by_host() {
    let temp = std::env::temp_dir().join(format!("domained-routes-many-{}", std::process::id()));
    let _ = fs::remove_dir_all(&temp);
    for dir in ["routes", "blog.routes", "calendar.routes"] {
      fs::create_dir_all(temp.join(dir)).expect("create routes dir");
      fs::write(temp.join(dir).join("index.anon.html"), dir).expect("write page");
    }

    let routes = DomainedRoutes::new(&temp);

    assert_eq!(
      routes
        .find_static_file(&DomainType::SubDomain { name: "blog".into() }, "/index.anon.html")
        .unwrap(),
      temp.join("blog.routes/index.anon.html")
    );
    assert_eq!(
      routes
        .find_static_file(&DomainType::RootDomain, "/index.anon.html")
        .unwrap(),
      temp.join("routes/index.anon.html")
    );
    // A subdomain this project does not serve must NOT be silently answered by
    // one of the others.
    assert_eq!(
      routes
        .find_static_file(&DomainType::SubDomain { name: "nope".into() }, "/index.anon.html")
        .unwrap(),
      temp.join("nope.routes/index.anon.html"),
      "an unmatched Host keeps its own (non-existent) directory, not another service's"
    );
    assert!(
      routes
        .find_resource_group(&DomainType::SubDomain { name: "nope".into() }, "/")
        .is_none(),
      "an unmatched Host resolves to no route group"
    );

    fs::remove_dir_all(&temp).expect("cleanup");
  }
}
