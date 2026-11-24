#[cfg(feature = "actix")]
pub mod domain_type;
#[cfg(feature = "actix")]
pub mod domained_routes;
#[cfg(feature = "actix")]
pub mod host_utils;
#[cfg(feature = "actix")]
pub mod image_assets;
#[cfg(feature = "actix")]
pub mod path_buf;
#[cfg(feature = "actix")]
pub mod resource_behavior;
#[cfg(feature = "actix")]
pub mod resource_group;

#[cfg(all(test, feature = "actix"))]
mod tests {

  use crate::resource_behavior::ResourceBehavior;

  #[test]
  fn test_file_behavior() {
    let redir = ResourceBehavior::Redirect {
      location: "www.google.com".to_owned(),
      absolute: true,
      subdomain: None,
    };

    let redir_ser = serde_json::to_string(&redir).expect("couldn't serialize");
    println!("{}", redir_ser);
  }
}

/// Convert the parent of an index file into a route, preserving parameter segments.
/// The root route is represented by an empty pattern in legacy route registration.
pub fn index_pattern(
  routes_root: &std::path::Path,
  index_file: &std::path::Path,
) -> Option<String> {
  let parent = index_file
    .strip_prefix(routes_root)
    .ok()?
    .parent()?
    .to_str()?;
  if parent.is_empty() {
    Some(String::new())
  } else {
    Some(format!("/{parent}"))
  }
}
