use std::{collections::HashMap, fs, io::ErrorKind, path::PathBuf, thread, time::Duration};

use actix_web::dev::{ResourceDef, ResourceMap};
use anyhow::{Context, anyhow};
use tento_core::fs::HasPathIter;
use tracing::warn;

use crate::domain_type::DomainType;
use crate::path_buf::PathBufWrap;
use crate::resource_group::{ResourceFile, ResourceGroup};

const MAX_RETRIES: u32 = 5;
const INITIAL_BACKOFF_MS: u64 = 10;

/// Check if an error is due to too many open files (EMFILE)
fn is_too_many_open_files(err: &anyhow::Error) -> bool {
  if let Some(io_err) = err.root_cause().downcast_ref::<std::io::Error>() {
    return io_err.raw_os_error() == Some(24) // EMFILE
      || io_err.kind() == ErrorKind::Other && io_err.to_string().contains("Too many open files");
  }
  false
}

#[derive(Debug, Clone)]
pub struct DomainedRoutes {
  project_root_path: PathBuf,
  routes: HashMap<DomainType, Routes>,
}

impl DomainedRoutes {
  pub fn new(project_root_path: impl Into<PathBuf>) -> Self {
    let mut routes = HashMap::new();
    let project_root_path: PathBuf = project_root_path.into();

    let paths = fs::read_dir(&project_root_path)
      .unwrap_or_else(|_| panic!("project root is not a directory: {project_root_path:?}"));
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
        routes.insert(DomainType::SubDomain { name }, Routes::new(child_path));
      } else if child_name == "routes" {
        routes.insert(DomainType::RootDomain, Routes::new(child_path));
      }
    }

    DomainedRoutes {
      routes,
      project_root_path,
    }
  }

  pub fn find_resource_group(
    &self,
    domain_type: &DomainType,
    pattern: &str,
  ) -> Option<&ResourceGroup> {
    let Some(route) = &self.routes.get(domain_type) else {
      return None;
    };
    route.find_resource_group(pattern)
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

    Ok(
      self
        .project_root_path
        .join(match domain_type {
          DomainType::RootDomain => "routes/".to_string(),
          DomainType::SubDomain { name } => format!("{name}.routes"),
        })
        .join(path_on_disk_str),
    )
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

    // Use exponential backoff for visitor_iter to handle transient EMFILE errors
    let iter = Self::visitor_iter_with_backoff(&routes_root_path)
      .expect("failed to iterate routes directory after retries");

    for result in iter {
      let (_idx, path) = match result {
        Ok(item) => item,
        Err(e) => {
          if is_too_many_open_files(&e) {
            // On EMFILE during iteration, log and skip this entry
            warn!("Skipping entry due to too many open files: {}", e);
            continue;
          }
          // For other errors, log and continue
          warn!("Error reading directory entry: {}", e);
          continue;
        }
      };
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

  /// Attempt to create a visitor iterator with exponential backoff on EMFILE errors.
  fn visitor_iter_with_backoff(path: &PathBuf) -> anyhow::Result<tento_core::fs::PathIter> {
    let mut backoff_ms = INITIAL_BACKOFF_MS;

    for attempt in 0..MAX_RETRIES {
      match path.as_path().visitor_iter() {
        Ok(iter) => return Ok(iter),
        Err(e) => {
          if is_too_many_open_files(&e) && attempt < MAX_RETRIES - 1 {
            warn!(
              "Too many open files, retrying in {}ms (attempt {}/{})",
              backoff_ms,
              attempt + 1,
              MAX_RETRIES
            );
            thread::sleep(Duration::from_millis(backoff_ms));
            backoff_ms *= 2; // Exponential backoff
            continue;
          }
          return Err(e).context(format!(
            "failed to iterate directory {:?} after {} attempts",
            path,
            attempt + 1
          ));
        }
      }
    }

    unreachable!()
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
