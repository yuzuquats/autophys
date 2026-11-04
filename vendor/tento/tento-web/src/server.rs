use std::{
  collections::HashSet,
  path::PathBuf,
  sync::Arc,
  time::{Duration, Instant},
};

use actix_web::{
  App, HttpRequest, HttpResponse, HttpServer,
  error::JsonPayloadError,
  web::{self},
};
use anyhow::Context;
use chrono;
use fnv::FnvHashMap;
#[cfg(any(target_os = "linux", target_os = "android"))]
use notify::INotifyWatcher;
#[cfg(any(target_os = "linux", target_os = "android"))]
use notify_debouncer_mini::Debouncer;
use tento_core::block;
use tento_web_rate_limit::{
  RateLimiter,
  backend::{SimpleInputFunctionBuilder, memory::InMemoryBackend},
};
use tokio::signal::unix::{SignalKind, signal};
use tracing::{error, info, instrument};

use crate::{
  admin::ServerStartTime,
  app::domain_config::{DomainConfigLike, Webapp},
  client::{bundler::Bundler, state::BuildState},
  compiler::schedule::{BuildFuture, build_concurrency, run_grouped},
  domain::SslConfig,
  tls::{self, SslMap},
};

#[cfg(any(target_os = "linux", target_os = "android"))]
use crate::{client::file_watcher::FileWatcher, compiler::ServiceCompiler};

pub struct LonaServerBuilder {
  domains: Vec<Arc<Webapp>>,
  sslmap: SslMap,
  override_hostname: Option<String>,

  bundler: Option<Arc<Bundler>>,
  releases_dir: PathBuf,
  server_version: Option<String>,
  server_host: Option<String>,
  server_mode: Option<String>,
  db_host_alias: Option<String>,
  db_name: Option<String>,
  bundle_path: Option<PathBuf>,
  llm_logger_dir: Option<PathBuf>,
  ux_tests_dir: Option<PathBuf>,
}

impl LonaServerBuilder {
  pub fn new(
    bundler: Option<Arc<Bundler>>,
    releases_dir: PathBuf,
    server_version: Option<String>,
    server_host: Option<String>,
    server_mode: Option<String>,
  ) -> anyhow::Result<Self> {
    Ok(LonaServerBuilder {
      domains: vec![],
      sslmap: FnvHashMap::default(),
      override_hostname: None,
      bundler,
      releases_dir,
      server_version,
      server_host,
      server_mode,
      db_host_alias: None,
      db_name: None,
      bundle_path: None,
      llm_logger_dir: None,
      ux_tests_dir: None,
    })
  }

  pub fn domain(mut self, domain: impl DomainConfigLike + 'static) -> Self {
    let hostname = &domain.hostname();
    if let Some(ssl) = &domain.app_config().ssl {
      self.sslmap.insert(hostname.to_string(), ssl.clone());
    };

    let domain = Arc::new(domain);
    let build_state =
      BuildState::new_from_releases_dir(self.releases_dir.clone(), &domain.hostname());
    let bundler = self.bundler.as_ref().map(|b| Bundler::clone(b));
    let webapp = Webapp::new(domain, bundler, build_state);

    self.domains.push(Arc::new(webapp));
    self
  }

  pub fn override_hostname(mut self, override_hostname: &str) -> Self {
    self.override_hostname = Some(override_hostname.to_string());
    self
  }

  pub fn bundle_path(mut self, path: PathBuf) -> Self {
    self.bundle_path = Some(path);
    self
  }

  pub fn db_host_alias(mut self, alias: Option<String>) -> Self {
    self.db_host_alias = alias;
    self
  }

  pub fn db_name(mut self, db_name: Option<String>) -> Self {
    self.db_name = db_name;
    self
  }

  pub fn llm_logger_dir(mut self, dir: PathBuf) -> Self {
    self.llm_logger_dir = Some(dir);
    self
  }

  /// Root of the checked-in `.ux-tests/` corpus. When set, the live harness
  /// nests new runs per-test (`<root>/<test-id>/runs/<id>/`) and dual-reads the
  /// legacy flat `llm_logger_dir`. **Must match the CLI's `ux_tests_dir`** or
  /// the live writer and the CLI reader diverge.
  pub fn ux_tests_dir(mut self, dir: PathBuf) -> Self {
    self.ux_tests_dir = Some(dir);
    self
  }

  pub fn build(self) -> TentoWebServer {
    TentoWebServer {
      webapps: self.domains,
      sslmap: self.sslmap,
      override_hostname: self.override_hostname,
      server_version: self.server_version,
      server_host: self.server_host,
      server_mode: self.server_mode,
      db_host_alias: self.db_host_alias,
      db_name: self.db_name,
      bundle_path: self.bundle_path,
      llm_logger_dir: self.llm_logger_dir,
      ux_tests_dir: self.ux_tests_dir,
    }
  }
}

#[derive(Clone)]
pub struct TentoWebServer {
  pub(crate) webapps: Vec<Arc<Webapp>>,
  pub(crate) sslmap: fnv::FnvHashMap<String, SslConfig>,
  pub(crate) override_hostname: Option<String>,
  pub(crate) server_version: Option<String>,
  pub(crate) server_host: Option<String>,
  pub(crate) server_mode: Option<String>,
  pub(crate) db_host_alias: Option<String>,
  pub(crate) db_name: Option<String>,
  pub(crate) bundle_path: Option<PathBuf>,
  pub(crate) llm_logger_dir: Option<PathBuf>,
  pub(crate) ux_tests_dir: Option<PathBuf>,
}

impl TentoWebServer {
  pub fn builder(
    bundler: Option<Arc<Bundler>>,
    releases_dir: PathBuf,
    server_version: Option<String>,
    server_host: Option<String>,
    server_mode: Option<String>,
  ) -> anyhow::Result<LonaServerBuilder> {
    LonaServerBuilder::new(
      bundler,
      releases_dir,
      server_version,
      server_host,
      server_mode,
    )
  }

  #[inline]
  fn webapps(&self) -> impl Iterator<Item = Arc<Webapp>> + use<> {
    self.webapps.clone().into_iter()
  }

  /// Returns only webapps that have a bundler configured (can build)
  #[inline]
  fn webapps_with_bundler(&self) -> impl Iterator<Item = Arc<Webapp>> + use<> {
    self
      .webapps
      .clone()
      .into_iter()
      .filter(|w| w.bundler.is_some())
  }

  #[cfg(any(target_os = "linux", target_os = "android"))]
  pub async fn watch_dev(&self) -> anyhow::Result<Debouncer<INotifyWatcher>> {
    ServiceCompiler::new(
      self
        .webapps()
        .map(|d| (d.inner.compiler(), d.clone()))
        .filter_map(|(compiler, domain)| compiler.map(|c| (c, domain.clone()))),
    )?
    .watch()
    .await
  }

  pub async fn run_dev(self, use_production_addr: bool) -> anyhow::Result<()> {
    let run_start = Instant::now();
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run_dev: starting"
    );

    //
    // 1) Build HTML (only for webapps with bundler configured)
    //
    let build_all_fut = TentoWebServer::build_all(self.webapps_with_bundler());
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run_dev: spawning build_all"
    );
    let first_build = tokio::spawn(async move {
      if let Err(e) = build_all_fut.await {
        error!("server/build-all/error, {:#?}", e)
      }
    });
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run_dev: build_all spawned"
    );

    // NOTE: this doesn't work well with the actix_rt runtime - what should we be
    // doing here?
    //
    // 2) Watch for changes in the HTML source -> update DEV targets if so
    //    This watcher is optional - if inotify limits are exhausted, continue without it
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run_dev: setting up dev watcher"
    );
    // The watch set is derived from what the first build read (each webapp's
    // `build_inputs`), so the watcher starts once that build has finished;
    // the server binds meanwhile. The task holds the watcher for the life of
    // the process.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
      let server = self.clone();
      tokio::spawn(async move {
        let _ = first_build.await;
        match server.watch_dev().await {
          Ok(watcher) => {
            let _watcher = watcher;
            std::future::pending::<()>().await
          }
          Err(e) => tracing::warn!(
            "Failed to set up dev HTML watcher (continuing without it): {}",
            e
          ),
        }
      });
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    drop(first_build);
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run_dev: dev watcher setup complete"
    );

    // TODO: listen to admin routes and rebuild all
    // .dep((
    //   "../yuzu-rs/src/admin/html/components/",
    //   Action::RebuildRoutes,
    // ))

    // 3) Watch for changes in the PROD output -> update PROD routes if so
    //    These watchers are optional - if inotify limits are exhausted, continue without them
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run_dev: setting up prod watcher"
    );
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let _prod_watchers = match self.spawn_prod_html_output_watcher().await {
      Ok(w) => Some(w),
      Err(e) => {
        tracing::warn!(
          "Failed to set up prod HTML watcher (continuing without it): {}",
          e
        );
        None
      }
    };
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run_dev: setting up RC watcher"
    );
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let _rc_watchers = match self.rc_html_output_watcher().await {
      Ok(w) => Some(w),
      Err(e) => {
        tracing::warn!(
          "Failed to set up RC HTML watcher (continuing without it): {}",
          e
        );
        None
      }
    };
    // 4) Watch template-handler content sources -> hot-reload handlers in place
    //    (landing/marketing JSON, blog posts, docs/projects). Optional.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let _template_watcher = match self.spawn_template_handler_watcher().await {
      Ok(w) => w,
      Err(e) => {
        tracing::warn!(
          "Failed to set up template-handler hot-reload watcher (continuing without it): {}",
          e
        );
        None
      }
    };
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run_dev: watchers setup complete"
    );

    let mut sigterm = signal(SignalKind::terminate()).expect("");
    let mut sigint = signal(SignalKind::interrupt()).expect("");

    tokio::select! {
      _ = sigterm.recv() => { println!("SIGTERM Shuting down"); return Ok(()) },
      _ = sigint.recv() => { println!("SIGINT Shuting down"); return Ok(()) },
      r = self.start_server(use_production_addr) => {
        return r
      }
    }
  }

  //
  // Watches each template handler's content sources (landing/marketing JSON,
  // blog posts, docs/projects `.docs` trees) and hot-reloads the handler in
  // place on edit — the SSR analogue of the TS bundler's dev watch. Reuses the
  // same debounced `FileWatcher`; the handlers swap their cached content behind
  // a lock, so no server restart is needed. Dev-only (wired in `run_dev`).
  //
  // NOTE: this reloads handler *content* for routes that already exist. A
  // brand-new top-level route still needs a `DomainedRoutes` rescan (the
  // separate prod/rc output-watcher path); a new slug under an existing
  // parameterized route (e.g. a new `brand.pages/for/*.json`) is picked up here.
  //
  #[cfg(any(target_os = "linux", target_os = "android"))]
  #[instrument(skip_all)]
  async fn spawn_template_handler_watcher(
    &self,
  ) -> anyhow::Result<Option<Debouncer<INotifyWatcher>>> {
    // Every reloadable content source across all webapps — template handlers
    // (served via the template registry) and plain `web::Data` stores (e.g. blog
    // post indexes) alike, unified behind `ReloadableContent`.
    let content: Vec<_> = self
      .webapps
      .iter()
      .flat_map(|app| app.inner.reloadable_content())
      .collect();

    // Deduped union of all watch paths — the three marketing handlers share
    // `nav.json`, so the same path can appear more than once.
    let paths: HashSet<PathBuf> = content.iter().flat_map(|c| c.watch_paths()).collect();

    if paths.is_empty() {
      return Ok(None);
    }

    for path in &paths {
      info!("watching reloadable-content source: {}", path.display());
    }

    let watcher = FileWatcher::watch(paths.into_iter(), move |changed| {
      crate::client::file_watcher::reload_changed(&content, changed);
      Ok(())
    })?;

    Ok(Some(watcher))
  }

  //
  // Watches for changes in the target.web.prod - If a new path is created and
  // another process updates the prod output, we need a way to invalidate the DomainedRoutes
  //
  #[cfg(any(target_os = "linux", target_os = "android"))]
  #[instrument(skip_all)]
  async fn spawn_prod_html_output_watcher(&self) -> anyhow::Result<Debouncer<INotifyWatcher>> {
    let paths_to_watch = self.webapps.clone().into_iter().map(|app| {
      let path = app.build_state.prod_state.routes_root.clone();
      std::fs::create_dir_all(path.as_path()).expect("couldn't create build-dir");
      info!("watching: {}", path.to_str().expect("invalid path"));
      path
    });
    let apps = self.webapps.clone();
    FileWatcher::watch(paths_to_watch, move |changed| {
      for app in apps.iter() {
        let root = &app.build_state.prod_state.routes_root;
        if let Some(path) = changed.iter().find(|p| p.starts_with(root)) {
          info!("prod-routes/updating, reason = {}", path.display());
          app.build_state.prod_state.update_last_invalidated();
        }
      }
      Ok(())
    })
  }

  //
  // Watches for changes in the target.web.rc - If a new path is created and
  // another process updates the prod output, we need a way to invalidate the DomainedRoutes
  //
  #[cfg(any(target_os = "linux", target_os = "android"))]
  #[instrument(skip_all)]
  async fn rc_html_output_watcher(&self) -> anyhow::Result<Debouncer<INotifyWatcher>> {
    let paths_to_watch = self.webapps.clone().into_iter().map(|app| {
      let path = app.build_state.rc_state.routes_root.clone();
      std::fs::create_dir_all(path.as_path()).expect("couldn't create build-dir");
      info!("watching: {}", path.to_str().expect("invalid path"));
      path
    });
    let apps = self.webapps.clone();
    FileWatcher::watch(paths_to_watch, move |changed| {
      for app in apps.iter() {
        let root = &app.build_state.rc_state.routes_root;
        if let Some(path) = changed.iter().find(|p| p.starts_with(root)) {
          info!("rc-routes/updating, reason = {}", path.display());
          app.build_state.rc_state.update_last_invalidated();
        }
      }
      Ok(())
    })
  }

  pub async fn run(&self, use_production_addr: bool) -> anyhow::Result<()> {
    let run_start = Instant::now();
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run: starting"
    );

    let build_all_fut = TentoWebServer::build_all(self.webapps_with_bundler());
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run: spawning build_all"
    );
    tokio::spawn(async move {
      if let Err(e) = build_all_fut.await {
        error!("server/build-all/error, {:#?}", e)
      }
    });
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run: build_all spawned, calling start_server"
    );
    self.start_server(use_production_addr).await?;
    info!(
      elapsed_ms = run_start.elapsed().as_millis() as u64,
      "yuzu.run: start_server returned"
    );
    Ok(())
  }

  #[instrument(skip_all)]
  async fn build_all(webapps: impl Iterator<Item = Arc<Webapp>>) -> anyhow::Result<()> {
    // Every webapp builds, and every failure is reported in one aggregated
    // error, so a broken site does not hide behind a healthy one (and a
    // missing `deno` on PATH is not silently swallowed). Webapps that share
    // an output root build one after another — each build starts by
    // cleaning that tree — and at most `build_concurrency()` roots build at
    // once, each in its own task. This replaced an unbounded `join_all`,
    // which polled every build from one task and let two webapps sharing a
    // root clean each other's tree mid-build.
    let results = run_grouped(
      webapps,
      build_concurrency(),
      |webapp: Arc<Webapp>| -> BuildFuture {
        Box::pin(async move {
          block!("build", webapp.domain_name(), {
            // build_all is only called with webapps_with_bundler(), so bundler is guaranteed
            let _bundler = webapp
              .bundler
              .as_ref()
              .context("build_all requires bundler")?;
            webapp.build_beta().await?;
            if !webapp.build_state.rc_state.routes_root.exists() {
              webapp.promote_beta_to_rc()?;
            }
            if !webapp.build_state.prod_state.routes_root.exists() {
              webapp.promote_rc_to_prod()?;
            }
            Ok::<_, anyhow::Error>(())
          })
        })
      },
    )
    .await;

    let errors: Vec<String> = results
      .into_iter()
      .filter_map(|(_, r)| r.err().map(|e| format!("{e:#}")))
      .collect();

    if errors.is_empty() {
      Ok(())
    } else {
      anyhow::bail!(
        "build_all: {} webapp build(s) failed:\n  - {}",
        errors.len(),
        errors.join("\n  - ")
      )
    }
  }

  async fn start_server(&self, use_production_addr: bool) -> anyhow::Result<()> {
    let start = Instant::now();
    tento_core::lazy::set_startup_deadline_at("tento_web::start_server", Duration::from_secs(60));
    info!(
      elapsed_ms = start.elapsed().as_millis() as u64,
      "start_server: starting"
    );

    let this = self.clone();
    let has_ssl = self
      .sslmap
      .keys()
      .into_iter()
      .map(|k| k.clone())
      .collect::<HashSet<String>>();
    info!(
      elapsed_ms = start.elapsed().as_millis() as u64,
      "start_server: ssl map collected"
    );

    let server_start_time = ServerStartTime::default();

    info!(
      elapsed_ms = start.elapsed().as_millis() as u64,
      "start_server: creating HttpServer"
    );
    let request_observers: Vec<Arc<dyn crate::RequestObserver>> = self
      .webapps
      .iter()
      .flat_map(|webapp| webapp.inner.request_observers())
      .collect();
    let observer_mw = crate::ObserverMiddleware::new(request_observers);
    let async_observer_mw = crate::AsyncObserverMiddleware::new(
      self
        .webapps
        .iter()
        .flat_map(|webapp| webapp.inner.async_request_observers())
        .collect(),
    );

    let mut server = HttpServer::new(move || {
      let rate_limiter_backend = InMemoryBackend::builder().build();

      // The ux-test session store, built once per worker and registered twice:
      // as the `SessionStore` the `/_/ux-test/*` routes extract, and inside the
      // completion-audit closure. One instance, two roles.
      let ux_test_logger = std::sync::Arc::new({
        // Legacy flat session store (also the prod fallback).
        let legacy = this.llm_logger_dir.clone().unwrap_or_else(|| {
          this
            .bundle_path
            .as_ref()
            .map(|p| p.join("container_data/tento-llm-logger"))
            .unwrap_or_else(|| std::path::PathBuf::from("container_data/tento-llm-logger"))
        });
        // With a `.ux-tests` root, the live harness nests runs per-test and
        // dual-reads the legacy store; otherwise it writes flat (production).
        match this.ux_tests_dir.clone() {
          Some(root) => tento_ux_test::LLMLogger::new_rooted(root, Some(legacy)),
          None => tento_ux_test::LLMLogger::new(legacy),
        }
      });
      let ux_test_audit_logger = ux_test_logger.clone();

      let mut app = App::new()
        // Registered first ⇒ innermost: observers see NormalizePath'd paths
        // and only requests that survived the rate limiter.
        .wrap(observer_mw.clone())
        .wrap(async_observer_mw.clone())
        .wrap(crate::middleware::server_timing::ServerTimingMiddleware)
        .wrap(crate::middleware::redirect_https::RedirectHTTPS::new(
          has_ssl.clone(),
        ))
        .wrap(actix_web::middleware::NormalizePath::trim())
        .wrap(actix_web::middleware::DefaultHeaders::new())
        .wrap(actix_web::middleware::Compress::default())
        .wrap(
          RateLimiter::builder(rate_limiter_backend, {
            // Everything gets the standard 2000/min per-real-IP budget except
            // the static FE module store (`/js/m/**`): the unbundled per-file
            // build makes a single page load fetch 1000+ modules in one burst,
            // which would blow the budget and 429 the page mid-load. Those
            // bypass the IP counter via a shared unlimited bucket — the
            // per-domain auth limiter shares the same carve-out. See
            // `crate::rate_limit`.
            let api_input =
              SimpleInputFunctionBuilder::new(std::time::Duration::from_secs(60), 2000)
                .real_ip_key()
                .build();
            move |req: &actix_web::dev::ServiceRequest| -> tento_web_rate_limit::backend::SimpleInputFuture {
              if crate::rate_limit::is_static_module_path(req.path()) {
                std::future::ready(Ok(crate::rate_limit::static_module_rate_limit_input()))
              } else {
                api_input(req)
              }
            }
          })
          .add_headers()
          .build(),
        )
        .app_data(web::JsonConfig::default().error_handler(json_error_handler))
        .app_data(web::Data::new(crate::admin::ServerVersion(
          this.server_version.clone(),
        )))
        .app_data(web::Data::new(crate::admin::ServerHost(
          this.server_host.clone(),
        )))
        .app_data(web::Data::new(crate::admin::ServerMode(
          this.server_mode.clone(),
        )))
        .app_data(web::Data::new(crate::admin::DatabaseHostAlias(
          this.db_host_alias.clone(),
        )))
        .app_data(web::Data::new(crate::admin::DatabaseName(
          this.db_name.clone(),
        )))
        .app_data(web::Data::new(crate::admin::BundlePath(
          this.bundle_path.clone(),
        )))
        .app_data(web::Data::new(server_start_time.clone()))
        // The `/_/ux-test/*` routes extract the STORE, not `LLMLogger` — they
        // hold the wire contract and nothing of the harness behind it.
        .app_data(web::Data::new(
          ux_test_logger as std::sync::Arc<dyn tento_ux_test::http::SessionStore>,
        ))
        // The judge for a manual "Works" completion — a BRIDGE, on its way out.
        //
        // RULING 2026-09-18: judging is a mountable route collection
        // (`tento_ux_test::judge::JudgeRoutes`), and the board judges on read
        // when a completion carries no verification record. `ux(18.1)` deleted
        // `CompletionAudit` from the canonical ux-test crate; this registration
        // survives only because tento's copy of the harness has not been
        // ported yet, and it goes in the SAME change that ports `http.rs`.
        //
        // **A product must not register one of these.** A new product starts in
        // the judge-on-read world and has no click-time behaviour to preserve;
        // commit-review deliberately registers nothing. Only tento-web needs
        // the bridge, because it has judged at click since before the split.
        //
        // The order is not a preference. Dropping this before the board's
        // run-folder read path is LIVE does not mean "judged later" — it means
        // anything completed in that window is never judged at all, because
        // nothing comes back for those sessions.
        //
        // The closure captures its own logger rather than receiving the store:
        // auditing needs `session_dir` / `write_verification_record` /
        // `refresh_status`, and routing those through `SessionStore` would put
        // the run folder back on the wire side for one caller's benefit.
        .app_data(web::Data::new(std::sync::Arc::new(
          move |session_id: &str| {
            tento_ux_test::orchestration::audit_completion(&ux_test_audit_logger, session_id)
          },
        ) as tento_ux_test::http::CompletionAudit));

      for domain in this.webapps.iter() {
        let override_hostname = this.override_hostname.clone();

        // Create guard for main hostname
        app = app.configure(move |cfg| {
          let service = web::scope("").guard(crate::app::host_guard::HostGuard::new(
            domain.inner.hostname(),
            override_hostname.clone(),
          ));
          domain.configure(cfg, service)
        });

        // Create guards for additional hostnames (e.g., localhost)
        for additional_hostname in domain.inner.additional_hostnames() {
          let override_hostname = this.override_hostname.clone();
          let additional_hostname = additional_hostname.clone();
          app = app.configure(move |cfg| {
            let service = web::scope("").guard(crate::app::host_guard::HostGuard::new(
              additional_hostname,
              override_hostname,
            ));
            domain.configure(cfg, service)
          });
        }
      }

      app
    });
    info!(
      elapsed_ms = start.elapsed().as_millis() as u64,
      "start_server: HttpServer created"
    );

    info!(
      elapsed_ms = start.elapsed().as_millis() as u64,
      "start_server: binding HTTP port"
    );
    // Errors (port held by another process, etc.) propagate instead of
    // panicking, so supervised callers (loaf's `server.run.fg`) can log a
    // structured failure row before exiting — a crash-looping unit's
    // startup stream then says WHY each attempt died.
    let http_override = std::env::var("TENTO_HTTP_BIND").ok().or_else(|| {
      if use_production_addr { None } else { std::env::var("TENTO_WEB_HTTP_ADDR").ok() }
    });
    let http_addr = configured_bind_address(
      if use_production_addr {
        "0.0.0.0:8080"
      } else {
        "127.0.0.1:3001"
      },
      http_override.as_deref(),
    )
    .context("TENTO_HTTP_BIND")?;
    server = server
      .bind(&http_addr)
      .with_context(|| format!("bind HTTP {http_addr}"))?;
    info!(
      elapsed_ms = start.elapsed().as_millis() as u64,
      "start_server: HTTP port bound"
    );

    info!(
      elapsed_ms = start.elapsed().as_millis() as u64,
      "start_server: binding HTTPS port"
    );
    let https_override = std::env::var("TENTO_HTTPS_BIND").ok().or_else(|| {
      if use_production_addr { None } else { std::env::var("TENTO_WEB_HTTPS_ADDR").ok() }
    });
    let https_addr = configured_bind_address(
      if use_production_addr {
        "0.0.0.0:8443"
      } else {
        "127.0.0.1:8443"
      },
      https_override.as_deref(),
    )
    .context("TENTO_HTTPS_BIND")?;
    server = server
      .bind_rustls_0_23(
        &https_addr,
        tls::rustls_config(&self.sslmap).context("couldn't create rust TLS config")?,
      )
      .with_context(|| format!("bind HTTPS {https_addr}"))?;
    info!(
      elapsed_ms = start.elapsed().as_millis() as u64,
      "start_server: HTTPS port bound"
    );

    // Use eprintln for immediate flush - tracing spans buffer until process exit
    eprintln!(
      "[READY] Server accepting connections on {http_addr}/{https_addr} (startup: {}ms)",
      start.elapsed().as_millis()
    );
    // Also emit through the structured logger: once any structured row exists
    // for this spawn, the supervisor's ready-watch trusts events.ljson
    // exclusively (spawn-id-scoped) and ignores the stdout marker above.
    info!(
      "[READY] Server accepting connections on {http_addr}/{https_addr} (startup: {}ms)",
      start.elapsed().as_millis()
    );
    tento_core::lazy::clear_startup_deadline();

    // Notify systemd we're ready (Type=notify)
    let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Ready]);

    // Watchdog pinger — keeps systemd happy that we're not hung
    tokio::spawn(async {
      loop {
        tokio::time::sleep(Duration::from_secs(120)).await;
        let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Watchdog]);
      }
    });

    info!(
      elapsed_ms = start.elapsed().as_millis() as u64,
      "start_server: calling server.run()"
    );
    info!("Starting server: use_prod_addr = {use_production_addr}");
    server.run().await.context("server.run()")?;

    Ok(())
  }
}

fn json_error_handler(err: JsonPayloadError, _req: &HttpRequest) -> actix_web::error::Error {
  let detail = err.to_string();
  let resp = match &err {
    JsonPayloadError::ContentType => HttpResponse::UnsupportedMediaType().body(detail),
    JsonPayloadError::Deserialize(json_err) if json_err.is_data() => {
      HttpResponse::UnprocessableEntity().body(detail)
    }
    _ => HttpResponse::BadRequest().body(detail),
  };
  actix_web::error::InternalError::from_response(err, resp).into()
}

/// Explicit private instances may select other ports without displacing a peer.
/// Overrides must remain loopback-only; an absent override keeps fleet defaults.
fn configured_bind_address(
  default: &str,
  configured: Option<&str>,
) -> anyhow::Result<std::net::SocketAddr> {
  let address: std::net::SocketAddr = configured
    .unwrap_or(default)
    .parse()
    .context("expected an IP address and port")?;
  if configured.is_some() {
    anyhow::ensure!(
      address.ip().is_loopback(),
      "explicit bind address must be loopback"
    );
    anyhow::ensure!(address.port() != 0, "explicit bind port must be nonzero");
  }
  Ok(address)
}

#[cfg(test)]
mod private_bind_tests {
  use super::configured_bind_address;

  #[test]
  fn omitted_override_preserves_existing_defaults() {
    for address in ["0.0.0.0:8080", "127.0.0.1:3001", "127.0.0.1:8443"] {
      assert_eq!(
        configured_bind_address(address, None).unwrap().to_string(),
        address
      );
    }
  }

  #[test]
  fn explicit_private_ports_accept_both_loopback_families() {
    for address in ["127.0.0.1:4781", "[::1]:4783"] {
      assert_eq!(
        configured_bind_address("127.0.0.1:3001", Some(address))
          .unwrap()
          .to_string(),
        address
      );
    }
  }

  #[test]
  fn explicit_addresses_reject_lan_wildcards_and_ephemeral_ports() {
    for address in [
      "0.0.0.0:4781",
      "[::]:4781",
      "192.168.1.2:4781",
      "127.0.0.1:0",
      "localhost:4781",
      "bad",
    ] {
      assert!(
        configured_bind_address("127.0.0.1:3001", Some(address)).is_err(),
        "{address}"
      );
    }
  }
}
