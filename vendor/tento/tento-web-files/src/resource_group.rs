pub use crate::resource_behavior::ResourceFile;

#[derive(Debug, Clone)]
pub struct ResourceGroup {
  pub logged_in: Option<ResourceFile>,
  pub anonymous: Option<ResourceFile>,
}
