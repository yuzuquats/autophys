use std::{ops::Deref, sync::Arc};

use super::admin_handler::AdminHandler;

pub struct AdminHandlerWrapper {
  inner: Arc<Box<dyn AdminHandler + Sync + Send>>,
}

impl AdminHandlerWrapper {
  pub fn new(app: impl AdminHandler + Sync + Send + 'static) -> Self {
    Self {
      inner: Arc::new(Box::new(app)),
    }
  }
}

impl Deref for AdminHandlerWrapper {
  type Target = Box<dyn AdminHandler + Sync + Send>;

  fn deref(&self) -> &Self::Target {
    self.inner.as_ref()
  }
}

impl Clone for AdminHandlerWrapper {
  fn clone(&self) -> Self {
    AdminHandlerWrapper {
      inner: self.inner.clone(),
    }
  }
}
