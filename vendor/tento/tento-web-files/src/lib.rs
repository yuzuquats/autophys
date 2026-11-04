pub mod domain_type;
pub mod domained_routes;
pub mod host_utils;
pub mod image_assets;
pub mod path_buf;
pub mod resource_behavior;
pub mod resource_group;

#[cfg(test)]
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
