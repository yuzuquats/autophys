use async_trait::async_trait;

#[async_trait]
pub trait AdminHandler: Send + Sync {
  async fn on_generate_two_fac(&self, id: &str, code: u64) -> bool;
}

#[async_trait]
impl<T: AdminHandler + ?Sized> AdminHandler for Box<T> {
  async fn on_generate_two_fac(&self, id: &str, code: u64) -> bool {
    (**self).on_generate_two_fac(id, code).await
  }
}
