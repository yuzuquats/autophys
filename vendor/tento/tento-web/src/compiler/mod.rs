use std::{
  collections::{BTreeSet, HashMap, HashSet},
  fmt::Display,
  path::{Path, PathBuf},
  sync::{Arc, Mutex, RwLock, Weak},
  time::{Duration, SystemTime},
};

use anyhow::Context;
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
use notify::{RecommendedWatcher, RecursiveMode};
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
use notify_debouncer_mini::{
  Config, DebounceEventHandler, DebounceEventResult, DebouncedEvent, DebouncedEventKind, Debouncer,
  new_debouncer_opt,
};
use tento_core::block;
use tracing::{debug, debug_span, error, info, warn};

use crate::Webapp;
#[cfg(any(target_os = "linux", target_os = "android"))]
use crate::client::file_watcher::check_inotify_headroom;

pub(crate) mod filter;
pub mod js_config;
pub(crate) mod schedule;
pub use js_config::TentoWebJsConfig;

use filter::{Decision, WebappFilter, canonical_lossy, is_noise};
use schedule::{BuildFuture, BuildJob, BuildScheduler, build_concurrency};

#[derive(Clone)]
pub enum Action {
  RebuildRoutes,
  Script(Arc<dyn Fn() + Send + Sync>),
  GlobalScript {
    tag: String,
    build: Arc<dyn Fn() -> anyhow::Result<()> + Send + Sync>,
  },
}

impl Display for Action {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Action::RebuildRoutes => write!(f, "Rebuild Routes"),
      Action::Script(_) => write!(f, "Custom Build Script"),
      Action::GlobalScript { tag, build: _ } => write!(f, "Custom Build Script (Global), {tag}"),
    }
  }
}

#[derive(Clone)]
pub struct Dependency {
  source: String,
  action: Action,
}

impl Dependency {
  pub fn new(source: String, resp: Action) -> Self {
    Dependency {
      source: source,
      action: resp,
    }
  }
}

impl From<(&str, Action)> for Dependency {
  fn from((source, resp): (&str, Action)) -> Self {
    Dependency::new(source.to_string(), resp)
  }
}

#[derive(Clone)]
pub struct Compiler {
  pub(crate) dependencies: Vec<Dependency>,
}

impl From<CompilerBuilder> for Compiler {
  fn from(value: CompilerBuilder) -> Self {
    value.build()
  }
}

impl Compiler {
  pub fn builder() -> CompilerBuilder {
    CompilerBuilder {
      dependencies: vec![],
    }
  }
}

#[derive(Clone)]
pub struct CompilerBuilder {
  pub(crate) dependencies: Vec<Dependency>,
}

impl CompilerBuilder {
  pub fn dep(mut self, dep: impl Into<Dependency>) -> Self {
    self.dependencies.push(dep.into());
    self
  }

  pub fn build(self) -> Compiler {
    Compiler {
      dependencies: self.dependencies,
    }
  }
}

/// One watched path: what to do for which webapp when something under it
/// changes. Declared dependencies (a docs tree, an app's own `html/`) are
/// watched recursively; the directories the build read are watched flat —
/// a file's siblings are the ones that can newly matter to it.
#[derive(Clone)]
pub(crate) struct WatchEntry {
  recursive: bool,
  actions: Vec<(Action, Arc<WatchedWebapp>)>,
}

impl WatchEntry {
  /// Whether an event at `path` belongs to this entry. A flat entry claims
  /// its directory and the directory's direct children only; deeper paths
  /// were never registered with it, and a recursive entry claims them.
  fn claims(&self, dir: &Path, path: &Path) -> bool {
    if self.recursive {
      path.starts_with(dir)
    } else {
      path == dir || path.parent() == Some(dir)
    }
  }

  fn rebuilds(&self, job: &Arc<WatchedWebapp>) -> bool {
    self
      .actions
      .iter()
      .any(|(action, w)| matches!(action, Action::RebuildRoutes) && Arc::ptr_eq(w, job))
  }
}

/// How the dev scheduler builds a webapp: `Webapp::build_beta` in its build
/// span, or a test's stand-in that records a graph the same way.
pub(crate) type BuildFn = Arc<dyn Fn(Arc<Webapp>) -> BuildFuture + Send + Sync>;

fn build_beta() -> BuildFn {
  Arc::new(|webapp: Arc<Webapp>| BuildJob::build(webapp))
}

/// A webapp as the dev watcher sees it: canonical source root and output
/// trees, resolved once when watching starts.
pub(crate) struct WatchedWebapp {
  webapp: Arc<Webapp>,
  html_root: Option<PathBuf>,
  /// The webapp's stage trees (or, for `target.web*` trees, the whole stage
  /// directory) and its module store. An event inside them is the build
  /// observing its own output.
  outputs: Vec<PathBuf>,
  build: BuildFn,
}

impl WatchedWebapp {
  fn new(webapp: Arc<Webapp>, build: BuildFn) -> Self {
    let html_root = webapp.html_root().map(canonical_lossy);
    let state = &webapp.build_state;
    let mut outputs: Vec<PathBuf> = [
      &state.beta_state.routes_root,
      &state.rc_state.routes_root,
      &state.prod_state.routes_root,
    ]
    .into_iter()
    .map(|root| {
      let stage = root.parent().filter(|p| {
        p.file_name()
          .and_then(|n| n.to_str())
          .is_some_and(|n| n.starts_with("target.web"))
      });
      canonical_lossy(stage.unwrap_or(root))
    })
    .collect();
    outputs.push(canonical_lossy(&state.module_store_root));
    // An output tree can never contain the sources being watched; if a
    // misconfigured app nests them, keep watching rather than go blind.
    if let Some(html_root) = &html_root {
      outputs.retain(|o| !html_root.starts_with(o));
    }
    outputs.sort();
    outputs.dedup();
    WatchedWebapp {
      webapp,
      html_root,
      outputs,
      build,
    }
  }

  fn filter(&self) -> WebappFilter<'_> {
    WebappFilter {
      html_root: self.html_root.as_deref(),
      outputs: &self.outputs,
      inputs: self.webapp.input_graph(),
    }
  }
}

impl BuildJob for WatchedWebapp {
  fn output_key(&self) -> PathBuf {
    self.webapp.beta_output_key()
  }

  fn label(&self) -> String {
    self.webapp.domain_name()
  }

  fn build(self: Arc<Self>) -> BuildFuture {
    (self.build)(self.webapp.clone())
  }
}

/// What one debounced batch asks for, after filtering.
#[derive(Default)]
pub(crate) struct Routed {
  /// Webapps to rebuild, each once, in first-seen order.
  pub webapps: Vec<Arc<WatchedWebapp>>,
  /// Custom scripts to run, each once per batch (`GlobalScript` by tag,
  /// `Script` by closure), in first-seen order.
  pub scripts: Vec<Action>,
  /// Paths that caused at least one rebuild or script.
  pub triggered_by: BTreeSet<PathBuf>,
  /// Paths a watch entry claimed that caused nothing.
  pub ignored: Vec<(PathBuf, &'static str)>,
}

/// A write to a newly routed input counts as racing its build if it is
/// stamped no earlier than this before the build started: file systems stamp
/// with a coarse clock that lags the one `SystemTime::now` reads.
const MTIME_SLACK: Duration = Duration::from_millis(100);

/// The watch entries, which both debouncers route through and every finished
/// build extends, and what has been registered with a watcher.
///
/// The graph grows while the server runs: a build that reads a directory no
/// earlier build read routes that directory to its webapp and registers it
/// with the late watcher, so the next edit there rebuilds. Entries are never
/// removed — a directory a failed or changed build stopped reading may be
/// the one its fix is saved in.
pub(crate) struct Routes {
  entries: RwLock<HashMap<PathBuf, WatchEntry>>,
  watching: Mutex<Watching>,
}

#[derive(Default)]
struct Watching {
  /// Directories a watcher was asked to watch, and the recursive ones.
  registered: HashSet<PathBuf>,
  recursive: Vec<PathBuf>,
  /// Watches directories first routed after `watch()` started. notify's
  /// debouncer owns its watcher, and the startup one is the caller's guard,
  /// so later registrations need a watcher of their own.
  #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
  late: Option<Debouncer<RecommendedWatcher>>,
}

impl Watching {
  fn covered(&self, dir: &Path) -> bool {
    self.recursive.iter().any(|r| dir.starts_with(r))
  }
}

/// Routes every directory `job`'s last build read to it. Returns the
/// directories that did not route to it before, and those of them that had
/// no entry at all (the ones a watcher has yet to be asked for). A directory
/// that has since vanished is skipped.
fn route_inputs(
  entries: &mut HashMap<PathBuf, WatchEntry>,
  job: &Arc<WatchedWebapp>,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
  let mut routed = vec![];
  let mut created = vec![];
  for dir in job.webapp.build_input_dirs() {
    let Ok(dir) = dir.canonicalize() else {
      continue;
    };
    let reached = entries.iter().any(|(key, entry)| {
      (*key == dir || (entry.recursive && dir.starts_with(key))) && entry.rebuilds(job)
    });
    if reached {
      continue;
    }
    let entry = entries.entry(dir.clone()).or_insert_with(|| {
      created.push(dir.clone());
      WatchEntry {
        recursive: false,
        actions: vec![],
      }
    });
    entry.actions.push((Action::RebuildRoutes, job.clone()));
    routed.push(dir);
  }
  (routed, created)
}

/// Whether a file the build read, in one of `dirs`, was written or removed
/// after the build started. Those directories reached no rebuild until the
/// build finished, so such a write was not seen.
fn changed_since(inputs: &[PathBuf], dirs: &[PathBuf], started: SystemTime) -> bool {
  let dirs: HashSet<&Path> = dirs.iter().map(PathBuf::as_path).collect();
  let since = started.checked_sub(MTIME_SLACK).unwrap_or(started);
  inputs.iter().any(|input| {
    let input = canonical_lossy(input);
    input.parent().is_some_and(|p| dirs.contains(p))
      && std::fs::metadata(&input)
        .and_then(|m| m.modified())
        .map_or(true, |modified| modified >= since)
  })
}

impl Routes {
  /// Decides what a batch of changed paths asks for. Pure apart from
  /// reading each webapp's last build graph; runs nothing.
  fn route<'p>(&self, paths: impl IntoIterator<Item = &'p Path>) -> Routed {
    let entries = self.entries.read().expect("watch entries poisoned");
    let mut routed = Routed::default();
    let mut tags: BTreeSet<&str> = BTreeSet::new();
    let mut closures: Vec<*const ()> = vec![];

    for path in paths {
      let s = debug_span!("service-compiler/path-changed");
      let _enter = s.enter();
      debug!("path: {:?}", path);
      if is_noise(path) {
        routed
          .ignored
          .push((path.to_path_buf(), "editor/vcs noise"));
        continue;
      }

      let mut claimed = false;
      let mut triggered = false;
      let mut reason = "not a build input";
      for (dir, entry) in entries.iter() {
        if !entry.claims(dir, path) {
          continue;
        }
        claimed = true;
        debug!("claimed by: {:?}", dir);
        for (action, domain) in &entry.actions {
          match action {
            Action::RebuildRoutes => match domain.filter().decide(path) {
              Decision::Rebuild => {
                triggered = true;
                if !routed.webapps.iter().any(|w| Arc::ptr_eq(w, domain)) {
                  routed.webapps.push(domain.clone());
                }
              }
              Decision::OwnOutput => reason = "the webapp's own output",
              Decision::NotAnInput => {}
            },
            Action::Script(f) => {
              triggered = true;
              let ptr = Arc::as_ptr(f) as *const ();
              if !closures.contains(&ptr) {
                closures.push(ptr);
                routed.scripts.push(action.clone());
              }
            }
            Action::GlobalScript { tag, .. } => {
              triggered = true;
              if tags.insert(tag.as_str()) {
                routed.scripts.push(action.clone());
              }
            }
          }
        }
      }

      if triggered {
        routed.triggered_by.insert(path.to_path_buf());
      } else if claimed {
        routed.ignored.push((path.to_path_buf(), reason));
      }
    }
    routed
  }

  /// After a build of `job`: routes the directories it newly read, asks the
  /// late watcher for the ones nobody watched, and says whether the build
  /// must run again because one of those inputs changed while it ran.
  fn refresh(&self, job: &Arc<WatchedWebapp>, started: SystemTime) -> bool {
    let (routed, created) = {
      let mut entries = self.entries.write().expect("watch entries poisoned");
      route_inputs(&mut entries, job)
    };
    if routed.is_empty() {
      return false;
    }
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    self.register_late(&created);
    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    let _ = created;
    info!(
      "watch/routed {} new input dir(s) to {}",
      routed.len(),
      job.label()
    );
    changed_since(&job.webapp.build_inputs(), &routed, started)
  }

  /// Registers flat watches for `dirs` with the late watcher. Before
  /// `watch()` has started there is no late watcher, and `watch()` registers
  /// every entry itself.
  #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
  fn register_late(&self, dirs: &[PathBuf]) {
    let mut watching = self.watching.lock().expect("watch state poisoned");
    let Watching {
      registered,
      recursive,
      late,
    } = &mut *watching;
    let Some(late) = late.as_mut() else {
      return;
    };
    for dir in dirs {
      if recursive.iter().any(|r| dir.starts_with(r)) || registered.contains(dir) {
        continue;
      }
      match late.watcher().watch(dir, RecursiveMode::NonRecursive) {
        Ok(()) => {
          debug!("watching {} (first read after startup)", dir.display());
          registered.insert(dir.clone());
        }
        Err(e) => warn!("couldn't watch new build input dir {}: {e}", dir.display()),
      }
    }
  }
}

pub(crate) struct ServiceCompiler {
  routes: Arc<Routes>,
  scheduler: BuildScheduler<WatchedWebapp>,
}

impl ServiceCompiler {
  pub fn new(
    compilers: impl Iterator<Item = (Compiler, Arc<Webapp>)>,
  ) -> anyhow::Result<ServiceCompiler> {
    Self::with_build(compilers, build_beta())
  }

  /// As `new`, building each webapp with `build` instead of `build_beta`.
  pub(crate) fn with_build(
    compilers: impl Iterator<Item = (Compiler, Arc<Webapp>)>,
    build: BuildFn,
  ) -> anyhow::Result<ServiceCompiler> {
    let mut entries: HashMap<PathBuf, WatchEntry> = HashMap::new();
    let mut domains = vec![];

    for (compiler, webapp) in compilers {
      let Some(html_root) = &webapp.inner.app_config().html_root else {
        continue;
      };
      let domain = Arc::new(WatchedWebapp::new(webapp.clone(), build.clone()));

      for d in &compiler.dependencies {
        let p = html_root.join(&d.source);
        let qualified_path = p
          .canonicalize()
          .expect(&format!("couldn't create path: {p:?}"));
        let entry = entries.entry(qualified_path).or_insert_with(|| WatchEntry {
          recursive: true,
          actions: vec![],
        });
        entry.recursive = true;
        entry.actions.push((d.action.clone(), domain.clone()));
      }
      domains.push(domain);
    }

    // The build's own inputs: the directory of every source file the last
    // build read. This is how the shared browser packages get watched —
    // from the import graph, not from a list of package names this crate
    // would have to know. Declared roots go first so a directory inside one
    // is not given a redundant flat entry; directories first read by a
    // later build are added by `Routes::refresh`.
    for domain in &domains {
      route_inputs(&mut entries, domain);
    }

    let dep_count = entries.len();
    let concurrency = build_concurrency();
    info!(
      "ServiceCompiler created with {} dependencies, building up to {} output root(s) at once",
      dep_count, concurrency
    );

    let routes = Arc::new(Routes {
      entries: RwLock::new(entries),
      watching: Mutex::default(),
    });
    // Weak: the scheduler task outlives neither watcher, and a strong
    // reference here would keep the late watcher (and so the scheduler's
    // own channel) alive forever.
    let weak: Weak<Routes> = Arc::downgrade(&routes);
    let scheduler = BuildScheduler::spawn_after(
      concurrency,
      move |job: &Arc<WatchedWebapp>, _ok: bool, started: SystemTime| {
        weak
          .upgrade()
          .is_some_and(|routes| routes.refresh(job, started))
      },
    );

    Ok(ServiceCompiler { routes, scheduler })
  }

  /// Decides what a batch of changed paths asks for; see `Routes::route`.
  pub(crate) fn route<'p>(&self, paths: impl IntoIterator<Item = &'p Path>) -> Routed {
    self.routes.route(paths)
  }

  #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
  pub async fn watch(self) -> anyhow::Result<Debouncer<RecommendedWatcher>> {
    let routes = self.routes.clone();
    let scheduler = self.scheduler.clone();
    info!("ServiceCompiler::watch() called, setting up debouncer...");

    // Check if we have enough inotify headroom (warn at 85% usage)
    #[cfg(any(target_os = "linux", target_os = "android"))]
    check_inotify_headroom(70)?;

    block!("service-compiler/spawning-thread", {
      // Held until the late watcher exists: a directory a build routes
      // meanwhile is then registered either below or by `register_late`.
      let mut watching = routes.watching.lock().expect("watch state poisoned");
      let mut debouncer =
        new_debouncer_opt(debounce_config(), self).context("couldn't start watching")?;
      info!("Debouncer created successfully");

      let mut snapshot: Vec<(PathBuf, bool, Vec<String>)> = routes
        .entries
        .read()
        .expect("watch entries poisoned")
        .iter()
        .map(|(path, entry)| {
          let actions = entry
            .actions
            .iter()
            .map(|(action, domain)| format!("{}: {}", domain.label(), action))
            .collect();
          (path.clone(), entry.recursive, actions)
        })
        .collect();
      // Recursive watches first, and no flat watch inside one: notify's
      // inotify backend records one mode per directory, and a flat watch
      // added to a directory a recursive watch covers would mark it
      // non-recursive, leaving directories created below it unwatched.
      snapshot.sort_by_key(|(path, recursive, _)| (!*recursive, path.clone()));

      let watcher = debouncer.watcher();
      for (path, recursive, actions) in snapshot {
        if !recursive && watching.covered(&path) {
          debug!("{} is inside a recursive watch", path.display());
          continue;
        }
        let mode = if recursive {
          RecursiveMode::Recursive
        } else {
          RecursiveMode::NonRecursive
        };
        // Not wrapped in `block!`: that macro awaits, and `watcher` is a
        // `&mut dyn Watcher`, which is not `Send` — holding it across the
        // await makes the whole `watch()` future non-Send, and this file
        // stops compiling on linux. `Watcher::watch` is synchronous anyway.
        debug!("watching {}", path.display());
        match watcher.watch(&path, mode) {
          Ok(()) => {
            for action in actions {
              debug!("{action}");
            }
            if recursive {
              watching.recursive.push(path.clone());
            }
            watching.registered.insert(path);
          }
          Err(e) => warn!("couldn't watch dependency {}: {e}", path.display()),
        }
      }

      let late = new_debouncer_opt(
        debounce_config(),
        LateHandler {
          routes: Arc::downgrade(&routes),
          scheduler,
        },
      )
      .context("couldn't start watching new build inputs")?;
      watching.late = Some(late);

      Ok(debouncer)
    })
  }
}

#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
fn debounce_config() -> Config {
  Config::default()
    .with_batch_mode(true)
    .with_timeout(Duration::from_millis(500))
}

/// Filters and routes one debounced batch, runs its scripts and hands its
/// rebuilds to the scheduler. Both watchers' handlers come here.
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
fn dispatch(routes: &Routes, scheduler: &BuildScheduler<WatchedWebapp>, res: DebounceEventResult) {
  let Ok(event) = res else {
    return;
  };
  let paths: Vec<PathBuf> = event
    .into_iter()
    .filter(|e: &DebouncedEvent| e.kind == DebouncedEventKind::Any)
    .map(|e| e.path)
    .collect();
  let routed = routes.route(paths.iter().map(PathBuf::as_path));

  for (path, reason) in &routed.ignored {
    debug!("ignored {} ({reason})", path.display());
  }

  // Scripts run here, before the rebuild is requested, as they always
  // have; once per batch each, however many of their files changed.
  for script in &routed.scripts {
    match script {
      Action::Script(f) => f(),
      Action::GlobalScript { tag, build } => {
        if let Err(e) = build() {
          error!("custom global script failed ({tag}): {}", e.to_string());
        }
      }
      Action::RebuildRoutes => {}
    }
  }

  if routed.webapps.is_empty() {
    return;
  }
  // One INFO line per rebuild batch: which domains rebuilt, what changed,
  // and how many claimed events the filter dropped. Per-event detail stays
  // at DEBUG.
  let domains: BTreeSet<String> = routed.webapps.iter().map(|w| w.label()).collect();
  let sources: Vec<String> = routed
    .triggered_by
    .iter()
    .map(|p| p.display().to_string())
    .collect();
  info!(
    "Rebuild Routes: {} domain(s) [{}] ← {} ({} event(s) ignored)",
    domains.len(),
    domains.into_iter().collect::<Vec<_>>().join(", "),
    sources.join(", "),
    routed.ignored.len()
  );
  if !scheduler.request(routed.webapps) {
    error!("debouncer/error, build scheduler stopped");
  }
}

#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
impl DebounceEventHandler for ServiceCompiler {
  fn handle_event(&mut self, res: DebounceEventResult) {
    dispatch(&self.routes, &self.scheduler, res);
  }
}

/// The late watcher's handler. It holds the routes weakly: they own the
/// late watcher, which owns this handler.
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
struct LateHandler {
  routes: Weak<Routes>,
  scheduler: BuildScheduler<WatchedWebapp>,
}

#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
impl DebounceEventHandler for LateHandler {
  fn handle_event(&mut self, res: DebounceEventResult) {
    if let Some(routes) = self.routes.upgrade() {
      dispatch(&routes, &self.scheduler, res);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{BuildState, DomainConfig, DomainConfigLike};

  /// The watch set is the declared roots, recursively, plus the directory of
  /// every file the last build read, flat — one entry per directory, a
  /// vanished directory skipped, and no package name anywhere.
  #[tokio::test]
  async fn the_watch_set_is_declared_roots_plus_what_the_build_read() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for dir in ["html/routes", "pkg", "other", "out/x"] {
      std::fs::create_dir_all(root.join(dir)).unwrap();
    }
    let domain = DomainConfig::builder()
      .hostname("test.localhost")
      .project_root(root)
      .build();
    let webapp = Arc::new(Webapp::new(
      Arc::new(domain) as Arc<dyn DomainConfigLike>,
      None,
      BuildState::single_stage(root.join("out/x")),
    ));
    webapp.set_build_inputs(vec![
      root.join("pkg/a.ts"),
      root.join("pkg/b.ts"),
      root.join("other/c.ts"),
      root.join("gone/d.ts"),
    ]);
    let compiler = Compiler::builder()
      .dep(("routes", Action::RebuildRoutes))
      .build();

    let service = ServiceCompiler::new([(compiler, webapp)].into_iter()).unwrap();

    let key = |p: &str| root.join(p).canonicalize().unwrap();
    let deps = service.routes.entries.read().unwrap();
    let routes = deps.get(&key("html/routes")).expect("the declared root");
    assert!(routes.recursive);
    let pkg = deps.get(&key("pkg")).expect("a directory the build read");
    assert!(!pkg.recursive);
    assert_eq!(
      pkg.actions.len(),
      1,
      "one entry per directory, not per file"
    );
    assert!(deps.contains_key(&key("other")));
    assert_eq!(deps.len(), 3, "a vanished directory is skipped");
  }

  struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
  }

  impl Fixture {
    fn new() -> Self {
      let tmp = tempfile::tempdir().unwrap();
      let root = tmp.path().canonicalize().unwrap();
      for dir in [
        "a/html/routes",
        "b/html/routes",
        "pkg/sub",
        "plugin/src",
        "out",
      ] {
        std::fs::create_dir_all(root.join(dir)).unwrap();
      }
      for file in [
        "pkg/a.ts",
        "pkg/b.ts",
        "pkg/lib.rs",
        "pkg/sub/deep.ts",
        "plugin/src/pm.ts",
      ] {
        std::fs::write(root.join(file), "").unwrap();
      }
      Fixture { _tmp: tmp, root }
    }

    fn p(&self, rel: &str) -> PathBuf {
      self.root.join(rel)
    }

    /// A webapp rooted at `<name>/` writing `out/target.web.beta/<name>`.
    fn webapp(&self, name: &str) -> Arc<Webapp> {
      let domain = DomainConfig::builder()
        .hostname(&format!("{name}.localhost"))
        .project_root(self.root.join(name))
        .build();
      let out = self.root.join("out/target.web.beta").join(name);
      Arc::new(Webapp::new(
        Arc::new(domain) as Arc<dyn DomainConfigLike>,
        None,
        BuildState::single_stage(out),
      ))
    }
  }

  fn hosts(routed: &Routed) -> Vec<String> {
    routed.webapps.iter().map(|w| w.label()).collect()
  }

  /// Two independent domains importing one package both rebuild from an
  /// edit to it; siblings no bundle reads, swap files and paths deeper than
  /// the flat input directory do not.
  #[tokio::test]
  async fn a_shared_import_rebuilds_both_domains_and_noise_rebuilds_none() {
    let fx = Fixture::new();
    let a = fx.webapp("a");
    let b = fx.webapp("b");
    a.set_build_inputs(vec![fx.p("pkg/a.ts"), fx.p("a/html/routes/index.root.ts")]);
    b.set_build_inputs(vec![fx.p("pkg/a.ts"), fx.p("pkg/b.ts")]);
    let service = ServiceCompiler::new(
      [
        (Compiler::builder().build(), a),
        (Compiler::builder().build(), b),
      ]
      .into_iter(),
    )
    .unwrap();

    let edit = fx.p("pkg/a.ts");
    let routed = service.route([edit.as_path()]);
    assert_eq!(hosts(&routed), vec!["a.localhost", "b.localhost"]);
    assert_eq!(routed.triggered_by.len(), 1);

    let lib = fx.p("pkg/lib.rs");
    let swap = fx.p("pkg/.a.ts.swp");
    let deep = fx.p("pkg/sub/deep.ts");
    let routed = service.route([lib.as_path(), swap.as_path(), deep.as_path()]);
    assert!(routed.webapps.is_empty(), "rebuilt {:?}", hosts(&routed));
    let ignored: Vec<&Path> = routed.ignored.iter().map(|(p, _)| p.as_path()).collect();
    assert_eq!(
      ignored,
      vec![lib.as_path(), swap.as_path()],
      "the deep path is not claimed by a flat entry at all"
    );
  }

  /// New and deleted imports and resolution config rebuild; a webapp only
  /// rebuilds for the package files it can read.
  #[tokio::test]
  async fn new_deleted_and_config_files_rebuild_their_readers() {
    let fx = Fixture::new();
    let a = fx.webapp("a");
    let b = fx.webapp("b");
    a.set_build_inputs(vec![fx.p("pkg/a.ts")]);
    b.set_build_inputs(vec![fx.p("pkg/b.ts")]);
    let service = ServiceCompiler::new(
      [
        (Compiler::builder().build(), a),
        (Compiler::builder().build(), b),
      ]
      .into_iter(),
    )
    .unwrap();

    std::fs::remove_file(fx.p("pkg/b.ts")).unwrap();
    let deleted = fx.p("pkg/b.ts");
    assert_eq!(
      hosts(&service.route([deleted.as_path()])),
      vec!["a.localhost", "b.localhost"]
    );
    let new = fx.p("pkg/new-module.ts");
    assert_eq!(hosts(&service.route([new.as_path()])).len(), 2);
    let config = fx.p("pkg/deno.json");
    assert_eq!(hosts(&service.route([config.as_path()])).len(), 2);
  }

  /// Declared roots keep the broad fallback: assets and templates under the
  /// html root rebuild, and with no clean build graph every claimed file
  /// rebuilds; the webapp's own output never does.
  #[tokio::test]
  async fn declared_roots_and_a_missing_graph_fall_back_to_rebuilding() {
    let fx = Fixture::new();
    let a = fx.webapp("a");
    a.set_build_inputs(vec![fx.p("a/html/routes/index.root.ts")]);
    let failed = fx.webapp("b");
    failed.set_build_inputs(vec![]);
    let service = ServiceCompiler::new(
      [
        (
          Compiler::builder()
            .dep(("routes", Action::RebuildRoutes))
            .build(),
          a,
        ),
        (
          Compiler::builder()
            .dep(("../..", Action::RebuildRoutes))
            .build(),
          failed,
        ),
      ]
      .into_iter(),
    )
    .unwrap();

    for rel in [
      "a/html/routes/logo.png",
      "a/html/routes/page.html",
      "a/html/routes/data.bin",
    ] {
      let p = fx.p(rel);
      assert!(
        hosts(&service.route([p.as_path()])).contains(&"a.localhost".to_string()),
        "{rel}"
      );
    }
    let lib = fx.p("pkg/lib.rs");
    assert_eq!(hosts(&service.route([lib.as_path()])), vec!["b.localhost"]);
    let own = fx.p("out/target.web.beta/b/routes/index.js");
    let store = fx.p("out/target.web.modules/ab/cd.js");
    let routed = service.route([own.as_path(), store.as_path()]);
    assert!(routed.webapps.is_empty(), "rebuilt {:?}", hosts(&routed));
    assert_eq!(routed.ignored.len(), 2);
  }

  /// A global script runs once per batch however many of its files changed,
  /// and once per tag across webapps that share it.
  #[tokio::test]
  async fn a_global_script_runs_once_per_batch_per_tag() {
    let fx = Fixture::new();
    let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let script = |runs: &Arc<std::sync::atomic::AtomicUsize>| Action::GlobalScript {
      tag: "prosemirror".to_string(),
      build: {
        let runs = runs.clone();
        Arc::new(move || {
          runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
          Ok(())
        })
      },
    };
    let plugin = fx.p("plugin/src");
    let dep = |a: Action| {
      Compiler::builder()
        .dep(Dependency::new(plugin.to_str().unwrap().to_string(), a))
        .build()
    };
    let service = ServiceCompiler::new(
      [
        (dep(script(&runs)), fx.webapp("a")),
        (dep(script(&runs)), fx.webapp("b")),
      ]
      .into_iter(),
    )
    .unwrap();

    let one = fx.p("plugin/src/pm.ts");
    let two = fx.p("plugin/src/schema.ts");
    let routed = service.route([one.as_path(), two.as_path()]);
    assert_eq!(routed.scripts.len(), 1);
    assert!(routed.webapps.is_empty());
    assert_eq!(routed.triggered_by.len(), 2);
  }

  use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};

  /// A stand-in for `build_beta` that records its result the same way:
  /// through `Webapp::settle_build`. The graph is `a/html/routes/index.ts`
  /// plus every path on an `import <rel>` line in it; an index containing
  /// `BROKEN` fails the build outright (`Err`, as a bundler RPC failure
  /// does). `during` runs after the inputs were read, before the build ends.
  fn fake_build(
    root: PathBuf,
    builds: Arc<AtomicUsize>,
    during: Option<Arc<dyn Fn() + Send + Sync>>,
  ) -> BuildFn {
    Arc::new(move |webapp: Arc<Webapp>| {
      let (root, builds, during) = (root.clone(), builds.clone(), during.clone());
      Box::pin(async move {
        let index = root.join("a/html/routes/index.ts");
        let text = std::fs::read_to_string(&index)?;
        let outcome = if text.contains("BROKEN") {
          Err(anyhow::anyhow!("index.ts: syntax error"))
        } else {
          let mut inputs = vec![index.clone()];
          inputs.extend(
            text
              .lines()
              .filter_map(|l| l.strip_prefix("import "))
              .map(|rel| root.join(rel.trim())),
          );
          Ok((inputs, true))
        };
        if let Some(during) = &during {
          during();
        }
        let result = webapp.settle_build(outcome);
        builds.fetch_add(1, SeqCst);
        result
      })
    })
  }

  async fn wait_for(what: &str, cond: impl Fn() -> bool) {
    for _ in 0..1000 {
      if cond() {
        return;
      }
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
  }

  async fn stays(what: &str, for_ms: u64, cond: impl Fn() -> bool) {
    for _ in 0..for_ms / 10 {
      assert!(cond(), "{what}");
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
  }

  fn write(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
  }

  /// Stamps `path` well before now, so only a later write looks recent.
  fn age(path: &Path) {
    let file = std::fs::File::options().write(true).open(path).unwrap();
    file
      .set_modified(SystemTime::now() - Duration::from_secs(10))
      .unwrap();
  }

  /// End to end, through real watchers: a page starts importing a package
  /// in a directory nothing watched; the build that reads it registers the
  /// directory, so an edit to only that package rebuilds. A build that then
  /// fails outright drops the graph but keeps the coverage: while broken,
  /// every claimed edit rebuilds, and the fix restores the graph.
  #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_package_first_imported_after_startup_is_watched_and_a_failed_build_recovers() {
    let fx = Fixture::new();
    let (index, pkg2, y, notes) = (
      fx.p("a/html/routes/index.ts"),
      fx.p("pkg2"),
      fx.p("pkg2/y.ts"),
      fx.p("pkg2/NOTES.md"),
    );
    std::fs::create_dir_all(&pkg2).unwrap();
    write(&y, "export const y = 1;");
    write(&index, "import pkg/a.ts\n");
    age(&y);
    let a = fx.webapp("a");
    a.set_build_inputs(vec![index.clone(), fx.p("pkg/a.ts")]);
    let builds = Arc::new(AtomicUsize::new(0));
    let service = ServiceCompiler::with_build(
      [(
        Compiler::builder()
          .dep(("routes", Action::RebuildRoutes))
          .build(),
        a.clone(),
      )]
      .into_iter(),
      fake_build(fx.root.clone(), builds.clone(), None),
    )
    .unwrap();
    let routes = service.routes.clone();
    assert!(!routes.entries.read().unwrap().contains_key(&pkg2));
    let _watcher = service.watch().await.unwrap();
    let built = |n: usize| builds.load(SeqCst) == n;

    write(&index, "import pkg/a.ts\nimport pkg2/y.ts\n");
    wait_for("the import edit's build", || built(1)).await;
    wait_for("pkg2 to be watched", || {
      routes.watching.lock().unwrap().registered.contains(&pkg2)
    })
    .await;
    assert!(a.input_graph().unwrap().contains(&y));

    write(&y, "export const y = 2;");
    wait_for("the new package's edit to rebuild", || built(2)).await;

    write(&notes, "not an input");
    stays(
      "a non-input beside a clean graph's inputs is ignored",
      1500,
      || built(2),
    )
    .await;

    write(&index, "BROKEN\nimport pkg/a.ts\nimport pkg2/y.ts\n");
    wait_for("the breaking edit's build", || built(3)).await;
    assert!(a.input_graph().is_none(), "a failed build leaves no graph");
    assert!(a.build_input_dirs().contains(&pkg2), "coverage is kept");

    write(&notes, "edited while broken");
    wait_for("any claimed edit to rebuild while broken", || built(4)).await;

    write(&index, "import pkg/a.ts\nimport pkg2/y.ts\n");
    wait_for("the fix's build", || built(5)).await;
    wait_for("the graph to return", || a.input_graph().is_some()).await;
    assert!(a.input_graph().unwrap().contains(&y));
    stays("no stray follow-up", 800, || built(5)).await;
  }

  /// The race the late registration leaves: a package first read by a
  /// build is written while that build runs, before its directory is
  /// watched. The build runs once more; without the write it does not.
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn an_input_written_while_its_directory_was_first_read_rebuilds_once_more() {
    for racing in [true, false] {
      let fx = Fixture::new();
      let (index, y) = (fx.p("a/html/routes/index.ts"), fx.p("pkg2/y.ts"));
      std::fs::create_dir_all(fx.p("pkg2")).unwrap();
      write(&y, "export const y = 1;");
      write(&index, "import pkg2/y.ts\n");
      age(&y);
      let a = fx.webapp("a");
      a.set_build_inputs(vec![index.clone()]);
      let during: Option<Arc<dyn Fn() + Send + Sync>> = racing.then(|| {
        let (y, once) = (y.clone(), AtomicBool::new(false));
        Arc::new(move || {
          if !once.swap(true, SeqCst) {
            write(&y, "export const y = 2;");
          }
        }) as Arc<dyn Fn() + Send + Sync>
      });
      let builds = Arc::new(AtomicUsize::new(0));
      let service = ServiceCompiler::with_build(
        [(
          Compiler::builder()
            .dep(("routes", Action::RebuildRoutes))
            .build(),
          a,
        )]
        .into_iter(),
        fake_build(fx.root.clone(), builds.clone(), during),
      )
      .unwrap();

      let routed = service.route([index.as_path()]);
      assert!(service.scheduler.request(routed.webapps));
      let want = if racing { 2 } else { 1 };
      wait_for("the builds", || builds.load(SeqCst) == want).await;
      stays("no further builds", 400, || builds.load(SeqCst) == want).await;
    }
  }

  /// `build_beta`'s result handling, both arms: a clean result is the
  /// graph; an outright failure leaves no graph (every claimed edit
  /// rebuilds) and keeps the last inputs as watch coverage.
  #[tokio::test]
  async fn a_failed_build_drops_the_graph_and_keeps_the_coverage() {
    let fx = Fixture::new();
    let a = fx.webapp("a");
    a.settle_build(Ok((vec![fx.p("pkg/a.ts")], true))).unwrap();
    let service =
      ServiceCompiler::new([(Compiler::builder().build(), a.clone())].into_iter()).unwrap();
    let lib = fx.p("pkg/lib.rs");
    assert!(service.route([lib.as_path()]).webapps.is_empty());

    let err = a.settle_build(Err(anyhow::anyhow!("rpc: esbuild exited")));
    assert!(err.is_err(), "the error is still returned");
    assert!(a.input_graph().is_none());
    assert_eq!(a.build_inputs(), vec![fx.p("pkg/a.ts")]);
    assert_eq!(hosts(&service.route([lib.as_path()])), vec!["a.localhost"]);

    a.settle_build(Ok((vec![fx.p("pkg/a.ts")], true))).unwrap();
    assert!(
      service.route([lib.as_path()]).webapps.is_empty(),
      "recovered"
    );
  }

  /// Two webapps whose beta roots are one directory spelled two ways —
  /// through a symlinked `target`, and through `..` — get one output key,
  /// so they share a slot and never build at once.
  #[cfg(unix)]
  #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
  async fn aliased_output_roots_share_one_slot() {
    let fx = Fixture::new();
    std::fs::create_dir_all(fx.p("disk/target.web.beta")).unwrap();
    std::os::unix::fs::symlink(fx.p("disk"), fx.p("target")).unwrap();
    let webapp = |name: &str, out: PathBuf| {
      let domain = DomainConfig::builder()
        .hostname(&format!("{name}.localhost"))
        .project_root(fx.p(name))
        .build();
      Arc::new(Webapp::new(
        Arc::new(domain) as Arc<dyn DomainConfigLike>,
        None,
        BuildState::single_stage(out),
      ))
    };
    let via_link = webapp("a", fx.p("target/target.web.beta/app"));
    let via_dots = webapp("b", fx.p("disk/target.web.beta/../target.web.beta/./app"));
    let other = webapp("c", fx.p("disk/target.web.beta/other"));
    let real = fx.p("disk/target.web.beta/app");
    assert_eq!(via_link.beta_output_key(), real);
    assert_eq!(via_dots.beta_output_key(), real);
    assert_ne!(other.beta_output_key(), real);

    let active: Arc<Mutex<HashMap<PathBuf, usize>>> = Arc::default();
    let overlap = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let running = Arc::new(AtomicUsize::new(0));
    let step = {
      let (active, overlap, peak, running) = (
        active.clone(),
        overlap.clone(),
        peak.clone(),
        running.clone(),
      );
      move |w: Arc<Webapp>| -> BuildFuture {
        let (active, overlap, peak, running) = (
          active.clone(),
          overlap.clone(),
          peak.clone(),
          running.clone(),
        );
        Box::pin(async move {
          let key = w.beta_output_key();
          {
            let mut active = active.lock().unwrap();
            let n = active.entry(key.clone()).or_default();
            *n += 1;
            if *n > 1 {
              overlap.fetch_add(1, SeqCst);
            }
          }
          peak.fetch_max(running.fetch_add(1, SeqCst) + 1, SeqCst);
          tokio::time::sleep(Duration::from_millis(50)).await;
          running.fetch_sub(1, SeqCst);
          *active.lock().unwrap().get_mut(&key).unwrap() -= 1;
          Ok(())
        })
      }
    };
    let results = schedule::run_grouped([via_link, via_dots, other], 4, step).await;
    assert!(results.iter().all(|(_, r)| r.is_ok()));
    assert_eq!(overlap.load(SeqCst), 0, "the aliases took turns");
    assert_eq!(peak.load(SeqCst), 2, "the other root ran alongside");
  }

  /// A directory the build read inside a declared recursive root gets no
  /// flat watch of its own: notify's inotify backend keeps one mode per
  /// directory, and a flat watch there would make it non-recursive, so a
  /// directory later created below it would go unwatched.
  #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn a_read_directory_inside_a_recursive_root_stays_recursive() {
    let fx = Fixture::new();
    let sub = fx.p("a/html/routes/sub");
    std::fs::create_dir_all(&sub).unwrap();
    write(&sub.join("page.ts"), "");
    write(&fx.p("a/html/routes/index.ts"), "");
    let a = fx.webapp("a");
    a.set_build_inputs(vec![sub.join("page.ts")]);
    let builds = Arc::new(AtomicUsize::new(0));
    let service = ServiceCompiler::with_build(
      [(
        Compiler::builder()
          .dep(("routes", Action::RebuildRoutes))
          .build(),
        a,
      )]
      .into_iter(),
      fake_build(fx.root.clone(), builds.clone(), None),
    )
    .unwrap();
    let _watcher = service.watch().await.unwrap();

    std::fs::create_dir(sub.join("new")).unwrap();
    wait_for("the new directory's build", || builds.load(SeqCst) == 1).await;
    write(&sub.join("new/x.ts"), "export {};");
    wait_for("a file in the new directory to rebuild", || {
      builds.load(SeqCst) == 2
    })
    .await;
  }
}
