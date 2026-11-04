use std::{path::PathBuf, sync::Arc};

pub use actix_cors::Cors;
use actix_session::{SessionMiddleware, config::PersistentSession};
use actix_web::{HttpResponse, Scope, cookie::Key, dev::ServiceRequest, web};
use anyhow::{Context, anyhow};
use base64::prelude::*;
use std::fmt::Debug;
use tento_web_auth::{Auth, session::cookie_session::LonaCookieSessionStore};
use tento_web_rate_limit::policy::RateLimitPolicyBackend;

use crate::admin::AdminService;
use crate::compiler::Compiler;
use crate::service::template_handler::ReloadableContent;

/// Decision returned by an `AdminGate` for a single request.
pub enum AdminGateDecision {
  /// Path is not gated — let the request flow through.
  PassThrough,
  /// Path is gated and the user passes — let the request flow through.
  Allow,
  /// Path is gated and the user fails — short-circuit with this response.
  Reject(HttpResponse),
}

/// Per-request gate that runs after auth middleware (so `ViewerContextJson`
/// is available in extensions) and before file routes are served. Used to
/// restrict access to specific URL prefixes to admin users.
pub trait AdminGate: Send + Sync {
  fn check(&self, req: &ServiceRequest) -> AdminGateDecision;
}

pub struct BuildArtifactsContext {
  pub hostname: String,
  pub html_root: PathBuf,
  pub beta_root: PathBuf,
  pub project_root: Option<PathBuf>,
}

pub trait BuildArtifactsHook: Send + Sync {
  fn run(&self, context: &BuildArtifactsContext) -> anyhow::Result<()>;
}

#[derive(Clone, Debug)]
pub struct AppConfig {
  pub ssl: Option<SslConfig>,
  pub session_key: Option<String>,
  pub html_root: Option<PathBuf>,
}

///
/// {project_root}/
///   html/
///     routes/
///       index.html
///   secrets/
///     session_key
///     {prekey_filename}.key
///     {cert_filename}.crt
///
/// {prekey_filename} and {cert_filename} defined as hostname.replace(".", "_")
/// session_key can be generated with `head -c 64 /dev/urandom | base64`
///

fn load_session_key(secrets_root: &PathBuf) -> Option<String> {
  let path = secrets_root.join("session_key");
  if path.exists() {
    Some(std::fs::read_to_string(path).expect("couldn't read session key file"))
  } else {
    None
  }
}

#[derive(Clone, Debug)]
pub struct SslConfig {
  pub pkey_path: PathBuf,
  pub cert_path: PathBuf,
  pub ca_bundle_path: Option<PathBuf>,
}

impl SslConfig {
  pub fn new_with_secrets_root(
    host: String,
    secrets_root: impl Into<PathBuf>,
  ) -> Option<SslConfig> {
    let filename = host.replace(".", "_");
    let secrets_root = secrets_root.into();
    let candidate_pkey_path = secrets_root.join(format!("{filename}.key"));
    let candidate_cert_path = secrets_root.join(format!("{filename}.crt"));
    let ca_bundle_path_opt = secrets_root.join(format!("{filename}.ca-bundle"));
    if !candidate_pkey_path.exists() {
      return None;
    }
    if !candidate_cert_path.exists() {
      return None;
    }
    let ca_bundle_path: Option<PathBuf>;
    if !ca_bundle_path_opt.exists() {
      ca_bundle_path = None;
    } else {
      ca_bundle_path = Some(ca_bundle_path_opt);
    }
    return Some(SslConfig {
      pkey_path: candidate_pkey_path,
      cert_path: candidate_cert_path,
      ca_bundle_path,
    });
  }
}

/// One app's addition to the system routes ([`DomainBuilder::system_routes`]).
pub type SystemRoutes = Arc<dyn Fn(&mut web::ServiceConfig) + Send + Sync>;

#[derive(Clone)]
pub struct DomainBuilder {
  hostname: Option<String>,
  additional_hostnames: Vec<String>,
  project_root: Option<PathBuf>,
  html_root: Option<PathBuf>,
  secrets_root: Option<PathBuf>,
  app_config: Option<AppConfig>,
  compiler: Option<Compiler>,
  auth: Option<Auth>,
  cors: Option<Arc<Box<dyn Fn() -> Cors + Send + Sync>>>,
  routes: Option<Arc<Box<dyn Fn() -> Scope + Send + Sync>>>,
  config: Option<Arc<Box<dyn Fn(&mut web::ServiceConfig) + Send + Sync>>>,
  system_routes: Vec<SystemRoutes>,
  build_artifacts_hook: Option<Arc<dyn BuildArtifactsHook>>,
  admin_service: Option<AdminService>,
  auth_rate_limit_policy_backend: Option<Arc<dyn RateLimitPolicyBackend>>,
  admin_gate: Option<Arc<dyn AdminGate>>,
  reloadable_content: Vec<Arc<dyn ReloadableContent>>,
  request_observers: Vec<Arc<dyn crate::RequestObserver>>,
  async_request_observers: Vec<Arc<dyn crate::AsyncRequestObserver>>,
}

impl DomainBuilder {
  pub(crate) fn new() -> DomainBuilder {
    DomainBuilder {
      hostname: None,
      additional_hostnames: Vec::new(),
      project_root: None,
      html_root: None,
      secrets_root: None,
      app_config: None,
      compiler: None,
      auth: None,
      cors: None,
      routes: None,
      config: None,
      system_routes: Vec::new(),
      build_artifacts_hook: None,
      admin_service: None,
      auth_rate_limit_policy_backend: None,
      admin_gate: None,
      reloadable_content: Vec::new(),
      request_observers: Vec::new(),
      async_request_observers: Vec::new(),
    }
  }
}

impl DomainBuilder {
  pub fn hostname(mut self, hostname: impl Into<String>) -> Self {
    self.hostname = Some(hostname.into());
    self
  }

  pub fn project_root(mut self, project_root: impl Into<PathBuf>) -> Self {
    self.project_root = Some(project_root.into());
    self
  }

  pub fn html_root(mut self, html_root: impl Into<PathBuf>) -> Self {
    self.html_root = Some(html_root.into());
    self
  }

  pub fn secrets_root(mut self, secrets_root: impl Into<PathBuf>) -> Self {
    self.secrets_root = Some(secrets_root.into());
    self
  }

  pub fn auth(mut self, auth: Auth) -> Self {
    self.auth = Some(auth);
    self
  }

  pub fn cors<F>(mut self, cors: F) -> Self
  where
    F: Fn() -> Cors + Send + Sync + 'static,
  {
    self.cors = Some(Arc::new(Box::new(cors)));
    self
  }

  pub fn routes<F>(mut self, routes: F) -> Self
  where
    F: Fn() -> Scope + Send + Sync + 'static,
  {
    self.routes = Some(Arc::new(Box::new(routes)));
    self
  }

  pub fn app_config(mut self, app_config: AppConfig) -> Self {
    self.app_config = Some(app_config);
    self
  }

  pub fn config<F>(mut self, config: F) -> Self
  where
    F: Fn(&mut web::ServiceConfig) + Send + Sync + 'static,
  {
    self.config = Some(Arc::new(Box::new(config)));
    self
  }

  /// Add routes beside tento-web's own `/_` system routes — a sub-scope such
  /// as `/_/fleet`, or a top-level path the app reserves for the same
  /// purpose. Each call adds to the previous ones.
  ///
  /// They are registered where the system routes are (after `/_/auth`, before
  /// the files) and *ahead of* tento-web's `/_` scope: actix hands a request
  /// to the first scope whose prefix matches, and `/_` would otherwise keep
  /// every `/_/…` path, answering 404 for the ones it does not serve. A path
  /// tento-web serves itself (`/_/app`, `/_/admin`, `/_/ux-test`) must not be
  /// claimed here: it would be shadowed.
  pub fn system_routes<F>(mut self, routes: F) -> Self
  where
    F: Fn(&mut web::ServiceConfig) + Send + Sync + 'static,
  {
    self.system_routes.push(Arc::new(routes));
    self
  }

  pub fn compiler(mut self, compiler: Option<impl Into<Compiler>>) -> Self {
    self.compiler = compiler.map(|c| c.into());
    self
  }

  pub fn build_artifacts_hook(mut self, hook: Arc<dyn BuildArtifactsHook>) -> Self {
    self.build_artifacts_hook = Some(hook);
    self
  }

  pub fn also_localhost(mut self) -> Self {
    self.additional_hostnames.push("localhost".to_string());
    self
  }

  pub fn admin_service(mut self, admin_service: AdminService) -> Self {
    self.admin_service = Some(admin_service);
    self
  }

  pub fn auth_rate_limit_policy_backend(
    mut self,
    backend: Arc<dyn RateLimitPolicyBackend>,
  ) -> Self {
    self.auth_rate_limit_policy_backend = Some(backend);
    self
  }

  /// Register an `AdminGate` middleware that runs after auth and can
  /// short-circuit requests to restricted URL prefixes.
  pub fn admin_gate(mut self, gate: Arc<dyn AdminGate>) -> Self {
    self.admin_gate = Some(gate);
    self
  }

  /// Register the file-backed content the dev watcher should hot-reload — both
  /// template handlers (registered in the `TemplateHandlerRegistry`) and plain
  /// `web::Data<…>` stores, as `Arc<dyn ReloadableContent>`. Only entries with a
  /// non-empty `watch_paths()` are watched. No effect outside dev (the watcher
  /// is wired only in `run_dev`).
  pub fn reloadable_content(mut self, content: Vec<Arc<dyn ReloadableContent>>) -> Self {
    self.reloadable_content = content;
    self
  }

  /// Request observers this domain contributes (attribution capture,
  /// analytics, audit — see [`crate::RequestObserver`]); empty ⇒ none.
  /// Register bounded asynchronous completion capture separately from cheap observers.
  pub fn async_request_observers(
    mut self,
    observers: Vec<Arc<dyn crate::AsyncRequestObserver>>,
  ) -> Self {
    self.async_request_observers = observers;
    self
  }

  pub fn request_observers(mut self, observers: Vec<Arc<dyn crate::RequestObserver>>) -> Self {
    self.request_observers = observers;
    self
  }

  pub fn build(self) -> DomainConfig {
    let hostname = self.hostname.expect("hostname is required");

    let app_config = if let Some(app_config) = self.app_config {
      app_config
    } else {
      // Secrets dir and html dir are resolved independently so an explicit
      // `secrets_root` (e.g. the on-disk store, per-domain) can supply secrets
      // while `project_root` still supplies html. Precedence: explicit
      // `secrets_root` wins, else `<project_root>/secrets`; html is explicit
      // `html_root`, else `<project_root>/html`.
      let secrets_root = self
        .secrets_root
        .or_else(|| self.project_root.as_ref().map(|p| p.join("secrets")));
      let html_root = self
        .html_root
        .or_else(|| self.project_root.as_ref().map(|p| p.join("html")));
      match secrets_root {
        Some(secrets_root) => AppConfig {
          ssl: SslConfig::new_with_secrets_root(hostname.clone(), &secrets_root),
          session_key: load_session_key(&secrets_root),
          html_root,
        },
        None => AppConfig {
          ssl: None,
          session_key: None,
          html_root,
        },
      }
    };

    DomainConfig {
      hostname,
      additional_hostnames: self.additional_hostnames,
      app_config,
      compiler: self.compiler,
      auth: self.auth,
      cors: self.cors,
      routes: self.routes,
      config: self.config,
      system_routes: self.system_routes,
      build_artifacts_hook: self.build_artifacts_hook,
      admin_service: self.admin_service,
      auth_rate_limit_policy_backend: self.auth_rate_limit_policy_backend,
      admin_gate: self.admin_gate,
      reloadable_content: self.reloadable_content,
      request_observers: self.request_observers,
      async_request_observers: self.async_request_observers,
    }
  }
}

#[derive(Clone)]
pub struct DomainConfig {
  pub hostname: String,
  pub additional_hostnames: Vec<String>,
  pub app_config: AppConfig,
  pub auth: Option<Auth>,
  pub cors: Option<Arc<Box<dyn Fn() -> Cors + Send + Sync>>>,
  pub routes: Option<Arc<Box<dyn Fn() -> Scope + Send + Sync>>>,
  pub config: Option<Arc<Box<dyn Fn(&mut web::ServiceConfig) + Send + Sync>>>,
  /// Routes mounted beside the system routes; see
  /// [`DomainBuilder::system_routes`].
  pub system_routes: Vec<SystemRoutes>,
  pub compiler: Option<Compiler>,
  pub build_artifacts_hook: Option<Arc<dyn BuildArtifactsHook>>,
  pub admin_service: Option<AdminService>,
  pub auth_rate_limit_policy_backend: Option<Arc<dyn RateLimitPolicyBackend>>,
  pub admin_gate: Option<Arc<dyn AdminGate>>,
  /// File-backed content (template handlers + `web::Data` stores) the dev
  /// watcher hot-reloads. Empty in bundles/prod.
  pub reloadable_content: Vec<Arc<dyn ReloadableContent>>,
  /// Request observers (see [`crate::RequestObserver`]); empty ⇒ none.
  pub request_observers: Vec<Arc<dyn crate::RequestObserver>>,
  pub async_request_observers: Vec<Arc<dyn crate::AsyncRequestObserver>>,
}

impl DomainConfig {
  pub fn builder() -> DomainBuilder {
    DomainBuilder::new()
  }
}

impl DomainConfig {
  pub fn cors(&self) -> Cors {
    if let Some(cors) = &self.cors {
      return cors();
    }
    Cors::default()
  }

  pub fn session_mw(&self) -> Option<SessionMiddleware<LonaCookieSessionStore>> {
    // println!("{:#?} {:#?}", self.hostname, self.app_config);
    let Some(session_key) = &self.app_config.session_key else {
      return None;
    };
    Some(
      SessionMiddleware::builder(
        LonaCookieSessionStore::default(),
        key_from_b64(&session_key).expect("couldn't create session key"),
      )
      .session_lifecycle(
        PersistentSession::default()
          .session_ttl(actix_web::cookie::time::Duration::days(7))
          .session_ttl_extension_policy(actix_session::config::TtlExtensionPolicy::OnStateChanges),
      )
      .cookie_domain(Some(self.hostname.clone()))
      // Separate instances may share a DNS parent but use independent keys.
      // Keep the established name unless the instance explicitly opts in.
      .cookie_name(std::env::var("TENTO_SESSION_COOKIE_NAME").unwrap_or_else(|_| "id".into()))
      .build(),
    )
  }
}

fn key_from_b64(b64_key: &str) -> anyhow::Result<Key> {
  let decoded = BASE64_STANDARD.decode(b64_key)?;
  if decoded.len() != 64 {
    return Err(anyhow!("Decoded data is not 64 bytes long"));
  }

  let key: &[u8; 64] = decoded
    .as_slice()
    .try_into()
    .context("Failed to created fixed-sized key data")?;

  Ok(Key::from(key))
}

#[cfg(test)]
mod test {

  use std::assert_matches;
  use std::time::Duration;

  use super::*;
  use tento_web_rate_limit::policy::{RateLimitPolicy, RateLimitPolicyBackend};

  struct TestPolicyBackend;

  impl RateLimitPolicyBackend for TestPolicyBackend {
    fn policy_for_user(&self, _user_id: &str) -> RateLimitPolicy {
      RateLimitPolicy::new(Duration::from_secs(60), 42)
    }

    fn policy_for_anon(&self) -> RateLimitPolicy {
      RateLimitPolicy::new(Duration::from_secs(60), 7)
    }
  }

  #[test]
  pub fn test() {
    let b64_key =
      "mWsoAj/sdJR4jw8yupntdSdYNCLKvlUmvgrdOO7VaIbt8zVe8r4uxh7K3xCykCnDprO1HzXsT0ZbvkGJLbAumQ==";
    assert_matches!(key_from_b64(&b64_key).map(|_| "cool"), Ok(_));
  }

  #[test]
  fn domain_builder_accepts_auth_rate_limit_policy_backend() {
    let backend: Arc<dyn RateLimitPolicyBackend> = Arc::new(TestPolicyBackend);
    let domain = DomainConfig::builder()
      .hostname("example.lona.so")
      .auth_rate_limit_policy_backend(backend.clone())
      .build();

    let Some(policy_backend) = domain.auth_rate_limit_policy_backend else {
      panic!("expected auth_rate_limit_policy_backend to be set")
    };

    assert_eq!(
      policy_backend.policy_for_user("u1"),
      RateLimitPolicy::new(Duration::from_secs(60), 42)
    );
    assert_eq!(
      policy_backend.policy_for_anon(),
      RateLimitPolicy::new(Duration::from_secs(60), 7)
    );
  }
}
