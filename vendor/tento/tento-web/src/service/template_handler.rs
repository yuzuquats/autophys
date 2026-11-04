use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use actix_web::dev::ServiceRequest;

pub trait TemplateHandler: Send + Sync {
  fn matches(&self, params: &HashMap<String, String>) -> bool;
  fn render(&self, base_html: &str, params: &HashMap<String, String>) -> Option<String>;

  /// Request-aware variant of [`matches`](Self::matches). Defaults to the
  /// param-only `matches`; override to vary on cookies/query (e.g. the blog's
  /// `lona_blog_mock` mock-dataset toggle). The full request is threaded in
  /// because path params alone don't carry cookies or the query string.
  fn matches_request(&self, params: &HashMap<String, String>, _req: &ServiceRequest) -> bool {
    self.matches(params)
  }

  /// Request-aware variant of [`render`](Self::render). Defaults to the
  /// param-only `render`; override to vary on cookies/query. The request
  /// subsumes the query string (`req.uri().query()`) and carries cookies.
  fn render_request(
    &self,
    base_html: &str,
    params: &HashMap<String, String>,
    _req: &ServiceRequest,
  ) -> Option<String> {
    self.render(base_html, params)
  }
}

/// A file-backed content source the dev watcher can hot-reload in place — the
/// single reload contract for everything the watcher drives, whether it's a
/// [`TemplateHandler`] served through the template registry (landing/marketing
/// JSON, docs, blog SSR) or a `web::Data<…>` store served through plain route
/// handlers (the blog post search index). Dev-only; `reload` runs off the
/// request path, so it takes `&self` (state must live behind interior
/// mutability) and MUST NOT panic on a malformed edit — log and keep the
/// previously-loaded content instead.
pub trait ReloadableContent: Send + Sync {
  /// Source dirs/files whose changes trigger [`reload`](Self::reload). An empty
  /// list (the default) means "not reloadable", so the dev watcher ignores it.
  fn watch_paths(&self) -> Vec<PathBuf> {
    vec![]
  }

  /// Re-read sources and atomically swap the cached content.
  fn reload(&self) {}
}

pub struct TemplateHandlerRegistry {
  handlers: HashMap<String, Arc<dyn TemplateHandler>>,
}

impl TemplateHandlerRegistry {
  pub fn new() -> Self {
    TemplateHandlerRegistry {
      handlers: HashMap::new(),
    }
  }

  pub fn register(&mut self, name: &str, handler: Arc<dyn TemplateHandler>) {
    self.handlers.insert(name.to_string(), handler);
  }

  pub fn get(&self, name: &str) -> Option<&Arc<dyn TemplateHandler>> {
    self.handlers.get(name)
  }
}

pub struct TentoTemplateHandlerAdapter {
  handler: Arc<dyn tento_ssr::SsrTemplateHandler>,
}

impl TentoTemplateHandlerAdapter {
  pub fn new(handler: Arc<dyn tento_ssr::SsrTemplateHandler>) -> Self {
    TentoTemplateHandlerAdapter { handler }
  }
}

impl TemplateHandler for TentoTemplateHandlerAdapter {
  fn matches(&self, params: &HashMap<String, String>) -> bool {
    self.handler.matches(params)
  }

  fn render(&self, base_html: &str, params: &HashMap<String, String>) -> Option<String> {
    self.handler.render(base_html, params)
  }
}
