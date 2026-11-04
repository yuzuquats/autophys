pub mod admin;
mod app;
mod client;
mod fs_utils;
pub mod middleware;
mod service;
pub mod utils;

pub mod compiler;
mod domain;
mod prebuilt;
mod rate_limit;
mod redirect;
mod server;
mod tls;

use std::path::PathBuf;

pub use admin::admin_handler::AdminHandler;
pub use admin::admin_handler_wrapper::AdminHandlerWrapper;
pub use admin::router::SystemRouter;
pub use admin::{
  AdminService, AdminSessionStore, BundleVersionInfo, HarnessSecret, HarnessTokenGuard,
  InMemorySessionStore, PrivateApiGuard, PrivateApiSecret, ServerHost, ServerStartTime,
  ServerVersion, SignedSessionStore,
};
pub use app::domain_config::{DomainConfigLike, Webapp};
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
pub use app::domain_config::DevWatchers;
pub use client::bundler::{Bundler, EsbuildClient, FeBuildVersion};
pub use client::state::BuildState;
pub use compiler::TentoWebJsConfig;
pub use domain::{
  AdminGate, AdminGateDecision, AppConfig, BuildArtifactsContext, BuildArtifactsHook, Cors,
  DomainConfig, SystemRoutes,
};
pub use middleware::observer::{CompletionObserver, ObserverMiddleware, RequestObserver};
pub use prebuilt::PrebuiltLoopbackServer;
pub use redirect::{LoggedInState, Redirect};
pub use server::TentoWebServer;
pub use service::static_resource::{ReleasesDir, SecretsRoot, StaticResource};
pub use service::template_handler::{
  ReloadableContent, TemplateHandler, TemplateHandlerRegistry, TentoTemplateHandlerAdapter,
};
pub use tento_dev::DevMode;
use tento_env::env_kv;
pub use tento_web_rate_limit::policy::{
  InMemoryPolicyBackend, RateLimitPolicy, RateLimitPolicyBackend,
};
pub use utils::prefixed_uuid::PrefixedUuid;

env_kv!("TENTO_WEB", PathBuf);

impl TentoWeb {
  /// The checked-in `tento-web` source tree that belongs to this crate build.
  ///
  /// Consumers that embed the frontend compiler use this instead of guessing a
  /// sibling checkout path at runtime. `TENTO_WEB` remains the typed override
  /// for development against a different source tree.
  pub fn source_tree() -> Self {
    Self(PathBuf::from(env!("CARGO_MANIFEST_DIR")))
  }

  pub(crate) fn path(&self, path: impl Into<std::path::PathBuf>) -> anyhow::Result<PathBuf> {
    Ok(self.0.join(path.into()))
  }
}

pub use middleware::async_observer::{AsyncCompletionObserver, AsyncObserverMiddleware, AsyncRequestObserver};
