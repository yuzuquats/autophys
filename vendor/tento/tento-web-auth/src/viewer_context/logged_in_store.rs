use std::{any::Any, sync::Arc};

use futures::future::BoxFuture;
use tento_web_files::resource_behavior::ResourceBehavior;

use super::viewer_context_json::ServiceLoggedInViewerContext;

pub trait LoggedInViewerContextStore: Any + Send + Sync {
  fn find_user_json(&'_ self, _id: &str) -> BoxFuture<'_, Option<serde_json::Value>> {
    Box::pin(async { None })
  }
  fn user_should_relogin(&'_ self, id: &str) -> BoxFuture<'_, bool>;
  fn user_should_redirect(&'_ self, id: &str) -> BoxFuture<'_, Option<ResourceBehavior>>;

  /// Returns true if `cookie_value` is a valid, unexpired debug bypass for `user_id`.
  /// The implementation must verify the HMAC and confirm that the cookie was minted
  /// for this specific user — preventing a bypass cookie for user A from working for user B.
  /// Default returns false (no bypass).
  fn debug_auth_bypass(&self, _cookie_value: &str, _user_id: &str) -> bool {
    false
  }
}

#[derive(Clone)]
pub struct LoggedInViewerContextManager {
  store: Arc<dyn LoggedInViewerContextStore>,
}

impl LoggedInViewerContextManager {
  pub fn new(store: Arc<dyn LoggedInViewerContextStore>) -> Self {
    LoggedInViewerContextManager { store }
  }

  pub async fn find_vc_json(&self, id: &str) -> Option<ServiceLoggedInViewerContext> {
    self
      .store
      .find_user_json(id)
      .await
      .map(ServiceLoggedInViewerContext)
  }

  pub async fn is_user_auth_expired(&self, id: &str) -> bool {
    self.store.user_should_relogin(id).await
  }

  pub fn is_debug_bypass(&self, cookie_value: &str, user_id: &str) -> bool {
    self.store.debug_auth_bypass(cookie_value, user_id)
  }

  pub async fn redirect_user(&self, id: &str) -> Option<ResourceBehavior> {
    self.store.user_should_redirect(id).await
  }
}
