use std::{
  collections::{BTreeSet, HashSet},
  future::ready,
  path::{Path, PathBuf},
  sync::{Arc, OnceLock, RwLock},
  time::Duration,
};

#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
use notify::RecommendedWatcher;
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
use notify_debouncer_mini::Debouncer;

use actix_identity::IdentityMiddleware;
use actix_web::{
  HttpMessage, Scope,
  body::{BoxBody, MessageBody},
  dev::{ServiceRequest, ServiceResponse},
  middleware::{Next, from_fn},
  web::{self, ServiceConfig},
};
use tento_logger::middleware::TentoLogger;
use tento_web_auth::ViewerContext;
use tento_web_rate_limit::{
  RateLimiter,
  backend::{SimpleInput, memory::InMemoryBackend, resolve_real_ip_key},
  policy::{InMemoryPolicyBackend, RateLimitPolicy},
};
use tento_web_router::Router;
use tracing::info;

use crate::{
  AppConfig, BuildArtifactsContext, BuildArtifactsHook, DomainConfig, FeBuildVersion,
  client::{bundler::Bundler, state::BuildState},
  compiler::Compiler,
  domain::{AdminGate, AdminGateDecision},
  fs_utils::copy_dir_all,
  service::{file_routes::FileRoutes, template_handler::ReloadableContent},
};

/// What one build attempt tells the dev watcher (`Webapp::settle_report`).
pub(crate) struct BuildOutcome {
  pub inputs: Vec<PathBuf>,
  pub probes: Vec<PathBuf>,
  pub clean: bool,
}

#[derive(Clone)]
pub struct Webapp {
  pub inner: Arc<dyn DomainConfigLike>,
  pub bundler: Option<Bundler>,
  pub build_state: BuildState,
  pub project_root: Option<PathBuf>,
  /// Every source file the last `build_beta` read, as esbuild reported it.
  /// The dev watcher's watch set is derived from this, so the packages a
  /// page imports are watched because it imports them — not because
  /// tento-web knows their names.
  build_inputs: Arc<RwLock<BuildGraph>>,
  /// The dev scheduler's identity for the beta routes root, resolved on
  /// first use and shared by clones (`Webapp::beta_output_key`).
  output_key: Arc<OnceLock<PathBuf>>,
}

/// What the last build read: the bundler's report as given, and the same
/// files as a set the dev watcher's event filter matches paths against
/// (each file as reported and canonicalised). `matchable` is `None` when the
/// graph cannot be trusted to be complete — before the first build, or after
/// a build that reported errors (bundle or per-file emit) or failed outright.
/// `inputs` then keeps the last known files, so the directories they live in
/// stay watched and the edit that fixes the build is seen.
///
/// `probes` are the paths the resolver looked for and did not find
/// (`BuildReport::resolution_probes`). They are matched like inputs, so
/// creating one rebuilds, and their directories are watched like input
/// directories.
#[derive(Default)]
struct BuildGraph {
  inputs: Vec<PathBuf>,
  probes: Vec<PathBuf>,
  matchable: Option<Arc<HashSet<PathBuf>>>,
}

impl BuildGraph {
  fn new(inputs: Vec<PathBuf>, probes: Vec<PathBuf>, clean: bool) -> Self {
    let matchable = (clean && !inputs.is_empty()).then(|| {
      let mut set = HashSet::with_capacity((inputs.len() + probes.len()) * 2);
      for path in inputs.iter().chain(&probes) {
        set.insert(crate::compiler::filter::canonical_lossy(path));
        set.insert(path.clone());
      }
      Arc::new(set)
    });
    BuildGraph {
      inputs,
      probes,
      matchable,
    }
  }
}

impl Webapp {
  pub fn new(
    domain: Arc<dyn DomainConfigLike>,
    bundler: Option<Bundler>,
    build_state: BuildState,
  ) -> Self {
    Webapp {
      inner: domain,
      bundler,
      build_state,
      project_root: None,
      build_inputs: Arc::default(),
      output_key: Arc::default(),
    }
  }

  /// Records a clean build's inputs (a non-empty list is a usable graph).
  pub(crate) fn set_build_inputs(&self, inputs: Vec<PathBuf>) {
    self.record_build(inputs, vec![], true);
  }

  /// Records what a build attempt leaves for the dev watcher: a build's
  /// reported inputs and whether it was clean, or its outright failure. A
  /// failure is returned unchanged after the graph is dropped — a graph
  /// left marked clean would let the filter ignore the edit that fixes it.
  #[cfg(test)]
  pub(crate) fn settle_build(
    &self,
    outcome: anyhow::Result<(Vec<PathBuf>, bool)>,
  ) -> anyhow::Result<()> {
    self.settle_report(outcome.map(|(inputs, clean)| BuildOutcome {
      inputs,
      probes: vec![],
      clean,
    }))
  }

  /// `settle_build` for a bundler report. A build is clean only when neither
  /// the bundle nor the per-file emit reported an error: an emit that failed
  /// part-way may have read less than the next one will.
  pub(crate) fn settle_report(&self, outcome: anyhow::Result<BuildOutcome>) -> anyhow::Result<()> {
    match outcome {
      Ok(BuildOutcome {
        inputs,
        probes,
        clean,
      }) => {
        self.record_build(inputs, probes, clean);
        Ok(())
      }
      Err(e) => {
        self.record_build(vec![], vec![], false);
        Err(e)
      }
    }
  }

  /// A clean build replaces the graph. Any other build drops the matchable
  /// set and adds what it reported to the last known inputs: the bundler
  /// reports none on errors, and the watch coverage must survive the
  /// breakage it is needed to recover from.
  fn record_build(&self, inputs: Vec<PathBuf>, probes: Vec<PathBuf>, clean: bool) {
    let mut graph = self.build_inputs.write().expect("build inputs poisoned");
    *graph = if clean {
      BuildGraph::new(inputs, probes, true)
    } else {
      let merge = |known: &mut Vec<PathBuf>, more: Vec<PathBuf>| {
        let seen: HashSet<PathBuf> = known.iter().cloned().collect();
        known.extend(more.into_iter().filter(|i| !seen.contains(i)));
      };
      let mut known = std::mem::take(&mut graph.inputs);
      merge(&mut known, inputs);
      let mut known_probes = std::mem::take(&mut graph.probes);
      merge(&mut known_probes, probes);
      BuildGraph::new(known, known_probes, false)
    };
  }

  /// The beta routes root as the dev scheduler identifies it: one key for
  /// every spelling of one directory (relative, `..`, symlinked ancestors),
  /// fixed on first use so a clean never moves it. Webapps sharing a key
  /// never build at once.
  pub(crate) fn beta_output_key(&self) -> PathBuf {
    self
      .output_key
      .get_or_init(|| {
        crate::compiler::schedule::stable_output_key(&self.build_state.beta_state.routes_root)
      })
      .clone()
  }

  /// The source files the last build read (empty before the first build;
  /// after a failed build, the last known ones).
  pub fn build_inputs(&self) -> Vec<PathBuf> {
    self
      .build_inputs
      .read()
      .expect("build inputs poisoned")
      .inputs
      .clone()
  }

  /// The last build's inputs as a set to match watcher paths against, or
  /// `None` when there is no complete graph and every edit must rebuild.
  pub(crate) fn input_graph(&self) -> Option<Arc<HashSet<PathBuf>>> {
    self
      .build_inputs
      .read()
      .expect("build inputs poisoned")
      .matchable
      .clone()
  }

  /// The directories those files live in, and the directories the
  /// resolver probed for missing paths, deduplicated — what a watcher
  /// registers to notice an edit to any input, a new sibling, or a probed
  /// path appearing.
  pub fn build_input_dirs(&self) -> Vec<PathBuf> {
    let graph = self.build_inputs.read().expect("build inputs poisoned");
    let dirs: BTreeSet<PathBuf> = graph
      .inputs
      .iter()
      .chain(&graph.probes)
      .filter_map(|file| file.parent().map(Path::to_path_buf))
      .collect();
    dirs.into_iter().collect()
  }

  pub fn with_project_root(mut self, project_root: Option<PathBuf>) -> Self {
    self.project_root = project_root;
    self
  }

  pub fn domain_name(&self) -> String {
    self.inner.hostname()
  }

  pub fn html_root(&self) -> Option<&Path> {
    self.inner.app_config().html_root.as_deref()
  }

  pub fn promote_rc_to_prod(&self) -> anyhow::Result<()> {
    let rc_root = &self.build_state.rc_state.routes_root;
    let prod_root = &self.build_state.prod_state.routes_root;

    if !rc_root.exists() {
      self.promote_beta_to_rc()?;
    }

    info!("promote/rc   → prod, {rc_root:?} to {prod_root:?}");
    copy_dir_all(rc_root, prod_root)?;
    self.build_state.prod_state.update_last_invalidated();

    // Copy and update build-version.json
    copy_build_version(rc_root, prod_root, "prod")?;

    Ok(())
  }

  pub fn promote_beta_to_rc(&self) -> anyhow::Result<()> {
    let beta_root = &self.build_state.beta_state.routes_root;
    let rc_root = &self.build_state.rc_state.routes_root;

    info!("promote/beta → rc, {beta_root:?} to {rc_root:?}");
    copy_dir_all(beta_root, rc_root)?;
    self.build_state.rc_state.update_last_invalidated();

    // Copy and update build-version.json
    copy_build_version(beta_root, rc_root, "rc")?;

    Ok(())
  }

  /// Promote beta directly to prod, skipping RC.
  pub fn promote_beta_to_prod(&self) -> anyhow::Result<()> {
    let beta_root = &self.build_state.beta_state.routes_root;
    let prod_root = &self.build_state.prod_state.routes_root;

    info!("promote/beta → prod, {beta_root:?} to {prod_root:?}");
    copy_dir_all(beta_root, prod_root)?;
    self.build_state.prod_state.update_last_invalidated();

    // Copy and update build-version.json
    copy_build_version(beta_root, prod_root, "prod")?;

    Ok(())
  }

  pub async fn build_beta(&self) -> anyhow::Result<()> {
    let bundler = self
      .bundler
      .as_ref()
      .ok_or_else(|| anyhow::anyhow!("build_beta requires bundler - not available in bundles"))?;

    let html_root = self
      .html_root()
      .ok_or_else(|| anyhow::anyhow!("build_beta requires html_root - not available in bundles"))?;

    let beta_root = &self.build_state.beta_state.routes_root;

    // Extract fleet prefix from hostname (e.g., "aws-04.lona.so" -> "aws-04")
    let fleet_prefix = extract_fleet_prefix(&self.domain_name());

    info!(
      "build-beta, root = {}, fleet_prefix = {:?}",
      html_root.to_str().unwrap_or("<None>"),
      fleet_prefix
    );
    let outcome = bundler
      .clean_and_build_all(html_root, beta_root, fleet_prefix.as_deref())
      .await
      .map(|report| BuildOutcome {
        clean: report.errors.is_empty() && report.emitter_errors.is_empty(),
        inputs: report.inputs,
        probes: report.resolution_probes,
      });
    self.settle_report(outcome)?;

    if let Some(hook) = self.inner.build_artifacts_hook() {
      hook.run(&BuildArtifactsContext {
        hostname: self.domain_name(),
        html_root: html_root.to_path_buf(),
        beta_root: beta_root.to_path_buf(),
        project_root: self.project_root.clone(),
      })?;
    }

    self.build_state.beta_state.update_last_invalidated();

    Ok(())
  }

  pub fn configure(&self, config: &mut ServiceConfig, service: Scope) {
    self.inner.configure(config, service, &self.build_state)
  }

  /// The single-webapp version of the dev watch `run_dev` wires for a whole
  /// server: source edits rebuild this webapp's beta routes through its
  /// `Compiler` deps, and reloadable content (page-model JSON, blog posts)
  /// hot-swaps in place. For standalone example servers that serve one domain
  /// without `TentoWebServer`. Hold the returned guard for the server's
  /// lifetime; dropping it stops watching.
  #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
  pub async fn watch_dev(self: &Arc<Self>) -> anyhow::Result<DevWatchers> {
    let sources =
      crate::compiler::ServiceCompiler::new(self.inner.compiler().map(|c| (c, self.clone())).into_iter())?
        .watch()
        .await?;

    let content = self.inner.reloadable_content();
    let paths: HashSet<PathBuf> = content.iter().flat_map(|c| c.watch_paths()).collect();
    let content_watcher = if paths.is_empty() {
      None
    } else {
      Some(crate::client::file_watcher::FileWatcher::watch(
        paths.into_iter(),
        move |changed| {
          crate::client::file_watcher::reload_changed(&content, changed);
          Ok(())
        },
      )?)
    };

    Ok(DevWatchers {
      _sources: sources,
      _content: content_watcher,
    })
  }
}

/// Keeps a standalone webapp's dev file-watchers alive — see
/// [`Webapp::watch_dev`].
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
pub struct DevWatchers {
  _sources: Debouncer<RecommendedWatcher>,
  _content: Option<Debouncer<RecommendedWatcher>>,
}

pub trait DomainConfigLike: Send + Sync {
  fn hostname(&self) -> String;
  fn additional_hostnames(&self) -> &[String];
  fn app_config(&self) -> &AppConfig;
  fn configure(&self, config: &mut ServiceConfig, service: Scope, state: &BuildState);
  fn compiler(&self) -> Option<Compiler>;
  fn build_artifacts_hook(&self) -> Option<Arc<dyn BuildArtifactsHook>>;

  /// File-backed content (template handlers + `web::Data` stores) that opts into
  /// dev hot-reload (non-empty `watch_paths()`). The dev watcher in `run_dev`
  /// watches these and calls `reload()` on edits. Defaults to empty.
  fn reloadable_content(&self) -> Vec<Arc<dyn ReloadableContent>> {
    vec![]
  }

  /// Request observers this domain contributes (attribution capture,
  /// analytics, audit — see [`crate::RequestObserver`]). The server fans
  /// every request through all domains' observers. Defaults to none.
  fn request_observers(&self) -> Vec<Arc<dyn crate::RequestObserver>> {
    vec![]
  }
  /// Opt-in bounded asynchronous completion capture; default remains empty.
  fn async_request_observers(&self) -> Vec<Arc<dyn crate::AsyncRequestObserver>> {
    vec![]
  }
}

impl<T: DomainConfigLike + ?Sized> DomainConfigLike for Box<T> {
  fn hostname(&self) -> String {
    (**self).hostname()
  }
  fn additional_hostnames(&self) -> &[String] {
    (**self).additional_hostnames()
  }
  fn app_config(&self) -> &AppConfig {
    (**self).app_config()
  }
  fn compiler(&self) -> Option<Compiler> {
    (**self).compiler()
  }
  fn build_artifacts_hook(&self) -> Option<Arc<dyn BuildArtifactsHook>> {
    (**self).build_artifacts_hook()
  }
  fn reloadable_content(&self) -> Vec<Arc<dyn ReloadableContent>> {
    (**self).reloadable_content()
  }
  fn request_observers(&self) -> Vec<Arc<dyn crate::RequestObserver>> {
    (**self).request_observers()
  }
  fn async_request_observers(&self) -> Vec<Arc<dyn crate::AsyncRequestObserver>> {
    (**self).async_request_observers()
  }
  fn configure(&self, config: &mut ServiceConfig, service: Scope, state: &BuildState) {
    (**self).configure(config, service, state)
  }
}

impl DomainConfigLike for DomainConfig {
  fn hostname(&self) -> String {
    self.hostname.clone()
  }
  fn additional_hostnames(&self) -> &[String] {
    &self.additional_hostnames
  }
  fn app_config(&self) -> &AppConfig {
    &self.app_config
  }
  fn compiler(&self) -> Option<Compiler> {
    self.compiler.clone()
  }
  fn build_artifacts_hook(&self) -> Option<Arc<dyn BuildArtifactsHook>> {
    self.build_artifacts_hook.clone()
  }
  fn reloadable_content(&self) -> Vec<Arc<dyn ReloadableContent>> {
    self
      .reloadable_content
      .iter()
      .filter(|c| !c.watch_paths().is_empty())
      .cloned()
      .collect()
  }
  fn request_observers(&self) -> Vec<Arc<dyn crate::RequestObserver>> {
    self.request_observers.clone()
  }
  fn async_request_observers(&self) -> Vec<Arc<dyn crate::AsyncRequestObserver>> {
    self.async_request_observers.clone()
  }
  fn configure(&self, config: &mut ServiceConfig, service: Scope, state: &BuildState) {
    //
    // Cors
    //
    let service = service.wrap(self.cors());

    TentoLogger::register_panic_hook_for_thread(false);

    //
    // API + File service
    //
    let service = service
      //
      // User Apis
      //
      .configure(move |c: &mut web::ServiceConfig| {
        if let Some(config) = &self.config {
          config(c);
        }
        if let Some(routes) = &self.routes {
          c.service((*routes)());
        }
      });

    if let Some(auth) = &self.auth {
      //
      // Auth
      //
      // NOTE: order is important here
      let admin_service = self.admin_service.clone();
      let admin_gate = self.admin_gate.clone();
      let auth_policy_backend = self
        .auth_rate_limit_policy_backend
        .clone()
        .unwrap_or_else(|| {
          Arc::new(InMemoryPolicyBackend::new(
            RateLimitPolicy::new(Duration::from_secs(60), 2000),
            RateLimitPolicy::new(Duration::from_secs(60), 500),
          ))
        });
      let auth_rate_limiter_backend = InMemoryBackend::builder().build();
      // Admin gate runs innermost (after viewer_context_mw has populated extensions).
      let service = service.wrap(from_fn(move |req, next| {
        let gate = admin_gate.clone();
        run_admin_gate(req, next, gate)
      }));
      let service = service
        //
        // Logging
        //
        .wrap(TentoLogger::default_log_identity())
        .wrap(
          RateLimiter::builder(auth_rate_limiter_backend, {
            let auth_policy_backend = auth_policy_backend.clone();
            move |req| {
              let auth_policy_backend = auth_policy_backend.clone();
              ready((|| {
                // The static FE module store (`/js/m/**`) bypasses the auth
                // limiter (anon 500/min, user 2000/min) too — a single
                // unbundled page load fetches 1000+ modules. Same carve-out as
                // the global limiter; see `crate::rate_limit`.
                if crate::rate_limit::is_static_module_path(req.path()) {
                  return Ok(crate::rate_limit::static_module_rate_limit_input());
                }
                if let Some(vc) = req.extensions().get::<ViewerContext>() {
                  match vc {
                    ViewerContext::User(user) => {
                      let policy = auth_policy_backend.policy_for_user(&user.id);
                      return Ok(SimpleInput {
                        interval: policy.interval,
                        max_requests: policy.max_requests,
                        key: format!("user:{}", user.id),
                      });
                    }
                    ViewerContext::Admin(_) => {
                      let policy = auth_policy_backend.policy_for_user("admin");
                      return Ok(SimpleInput {
                        interval: policy.interval,
                        max_requests: policy.max_requests,
                        key: "user:admin".to_string(),
                      });
                    }
                    ViewerContext::Anon(_) => {}
                  }
                }

                let anon_key = resolve_real_ip_key(req)?;
                let policy = auth_policy_backend.policy_for_anon();
                Ok(SimpleInput {
                  interval: policy.interval,
                  max_requests: policy.max_requests,
                  key: format!("anon:{anon_key}"),
                })
              })())
            }
          })
          .add_headers()
          .build(),
        )
        //
        // Auth
        //
        .wrap(auth.viewer_context_mw())
        .wrap(IdentityMiddleware::default())
        .wrap(
          self
            .session_mw()
            .expect("couldn't construct session mw - no session key"),
        )
        //
        // Auth APIs
        //
        .configure(|cfg| auth.config(cfg))
        //
        // Admin APIs (inside auth scope for Identity access)
        //
        .configure(move |cfg| {
          if let Some(admin_svc) = admin_service {
            (admin_svc.config())(cfg);
          }
        })
        //
        // System Router (after auth so /_/auth is matched before /_)
        //
        .configure(|cfg| self.configure_system_routes(cfg))
        //
        // Serve Files
        //
        .service(FileRoutes::new(state, true));

      config.service(service);
    } else {
      let service = service
        //
        // Logging
        //
        .wrap(TentoLogger::default())
        //
        // System Router
        //
        .configure(|cfg| self.configure_system_routes(cfg))
        //
        // Serve Files
        //
        .service(FileRoutes::new(state, false));

      config.service(service);
    }
  }
}

impl DomainConfig {
  /// tento-web's `/_` system routes, preceded by the ones the app added
  /// ([`crate::domain::DomainBuilder::system_routes`]). The app's go first:
  /// `SystemRouter` is one `/_` scope, and actix gives a request to the first
  /// scope whose prefix matches, so a `/_/fleet` registered after it would
  /// never be reached. A second top-level path (`/fleet`) cannot be folded into
  /// `SystemRouter` either: that would collapse its base to `""`, which in
  /// actix swallows every unmatched path.
  fn configure_system_routes(&self, cfg: &mut ServiceConfig) {
    for routes in &self.system_routes {
      routes(cfg);
    }
    cfg.service(crate::admin::router::SystemRouter::service());
  }
}

/// Run the optional `AdminGate` for this request. If the gate rejects, return
/// the response immediately; otherwise hand off to the next service in the
/// middleware chain.
async fn run_admin_gate<B>(
  req: ServiceRequest,
  next: Next<B>,
  gate: Option<Arc<dyn AdminGate>>,
) -> Result<ServiceResponse<BoxBody>, actix_web::Error>
where
  B: MessageBody + 'static,
{
  if let Some(gate) = gate {
    match gate.check(&req) {
      AdminGateDecision::PassThrough | AdminGateDecision::Allow => {}
      AdminGateDecision::Reject(resp) => {
        return Ok(req.into_response(resp).map_into_boxed_body());
      }
    }
  }
  next.call(req).await.map(|sr| sr.map_into_boxed_body())
}

/// Extract fleet prefix from a hostname.
///
/// Examples:
/// - "lona.so" -> None (production)
/// - "aws-04.lona.so" -> Some("aws-04")
/// - "dev.lona.so" -> Some("dev")
/// - "calendar.lona.so" -> None (subdomain without prefix)
fn extract_fleet_prefix(hostname: &str) -> Option<String> {
  let parts: Vec<&str> = hostname.split('.').collect();

  // Need at least 3 parts for a prefix (e.g., "aws-04.lona.so")
  if parts.len() < 3 {
    return None;
  }

  let subdomain = parts[0];

  // Skip standard subdomains that aren't fleet prefixes
  if subdomain == "calendar" || subdomain == "static" || subdomain == "www" {
    return None;
  }

  // If the subdomain contains "--", it's a prefixed subdomain like "dev--calendar"
  // We want the prefix part
  if let Some((prefix, _)) = subdomain.split_once("--") {
    return Some(prefix.to_string());
  }

  // Otherwise, the subdomain itself is the fleet prefix (e.g., "aws-04", "dev")
  Some(subdomain.to_string())
}

/// Copy build-version.json from source to destination, updating the stage field.
/// Paths are like `releases_dir/target.web.beta/app_name`, so we go to parent
/// to find the build-version.json.
fn copy_build_version(
  src_app_root: &Path,
  dst_app_root: &Path,
  new_stage: &str,
) -> anyhow::Result<()> {
  let Some(src_target_dir) = src_app_root.parent() else {
    return Ok(());
  };
  let Some(dst_target_dir) = dst_app_root.parent() else {
    return Ok(());
  };

  let src_version_path = src_target_dir.join("build-version.json");
  if !src_version_path.exists() {
    return Ok(());
  }

  let mut version = FeBuildVersion::load(&src_version_path)?;
  version.stage = new_stage.to_string();

  let dst_version_path = dst_target_dir.join("build-version.json");
  let content = serde_json::to_string_pretty(&version)?;
  std::fs::write(&dst_version_path, content)?;
  info!(
    "Copied build-version.json to {:?} (stage={})",
    dst_version_path, new_stage
  );

  Ok(())
}
