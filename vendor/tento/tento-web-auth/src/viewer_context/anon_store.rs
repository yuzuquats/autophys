use std::{any::Any, sync::Arc};

use actix_http::Extensions;

use super::viewer_context_json::ServiceAnonViewerContext;

pub trait AnonViewerContextStore: Any + Send + Sync {
  fn find_anon_user_json(&self) -> Option<serde_json::Value> {
    None
  }
}

#[derive(Clone)]
pub struct AnonViewerContextManager {
  store: Arc<dyn AnonViewerContextStore>,
}

impl AnonViewerContextManager {
  pub fn default() -> AnonViewerContextManager {
    AnonViewerContextManager::new(Arc::new(()))
  }

  pub fn new(store: Arc<dyn AnonViewerContextStore>) -> Self {
    AnonViewerContextManager { store }
  }

  pub fn extract_from_extensions(ext: &Extensions) -> Arc<Self> {
    ext
      .get::<Arc<Self>>()
      .expect("The ViewerContext middleware should be added (anon)")
      .to_owned()
  }

  pub fn find_vc_json(&self) -> Option<ServiceAnonViewerContext> {
    self
      .store
      .find_anon_user_json()
      .map(ServiceAnonViewerContext)
  }
}

impl AnonViewerContextStore for () {}
