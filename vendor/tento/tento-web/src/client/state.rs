use std::{
  path::PathBuf,
  sync::{Arc, RwLock},
  time::SystemTime,
};

use crate::service::routes::DomainedRoutes;

#[derive(Debug, Clone)]
pub struct RoutesState {
  last_invalidated: Arc<RwLock<SystemTime>>,
  pub routes_root: PathBuf,
}

impl RoutesState {
  pub fn new(routes_root: PathBuf) -> RoutesState {
    RoutesState {
      last_invalidated: Arc::new(RwLock::new(SystemTime::now())),
      routes_root,
    }
  }

  pub fn thread_specific(&self) -> ThreadSpecificRoutesState {
    ThreadSpecificRoutesState {
      last_invalidated: self.last_invalidated.clone(),
      routes_root: self.routes_root.clone(),
      last_built: None,
      routes: None,
    }
  }

  pub fn update_last_invalidated(&self) {
    let mut time = self.last_invalidated.write().expect("poisoned");
    *time = SystemTime::now();
  }
}

#[derive(Debug, Clone)]
pub struct BuildState {
  pub beta_state: RoutesState,
  pub rc_state: RoutesState,
  pub prod_state: RoutesState,
  /// Shared, content-addressed per-file module store, orthogonal to the stage
  /// trees: `releases_dir/target.web.modules`. Served at `/js/m/**` regardless of
  /// stage/subdomain (content-hashed ⇒ immutable).
  pub module_store_root: PathBuf,
}

/// Where the per-file module store sits for a build output tree, derived from
/// the output root alone.
///
/// The emitter (`Bundler::perfile_emit_step`) and the `/js/m/**` handler must
/// name the SAME directory, and deriving it twice let them disagree: a
/// single-stage app pointed `module_store_root` at its own bundle tree while
/// the emitter filled `target.web.modules` one level up, so every module URL
/// 404'd against a store that was fully populated. Both now call this.
///
/// The shape is `<releases>/target.web.<stage>/<domain>` → `<releases>/target.web.modules`
/// — a sibling of the stage trees, so `clean` never wipes it and a promote
/// (a per-stage copy) never duplicates it. `None` for a root with fewer than
/// two ancestors, which no real build tree has.
pub fn module_store_for(output_root: &std::path::Path) -> Option<PathBuf> {
  output_root
    .parent()
    .and_then(|stage| stage.parent())
    .map(|releases| releases.join("target.web.modules"))
}

impl BuildState {
  /// A single-stage local app (loopback miniapps): there is no beta/rc/prod
  /// promotion, so all three stage trees resolve to the one build output.
  ///
  /// The module store is NOT the build output — it is the shared, hashed store
  /// beside it, exactly where the emitter writes (see [`module_store_for`]).
  /// The fallback to `root` only fires for a root with no grandparent, where
  /// the emitter derives nothing either and there is no store to serve.
  pub fn single_stage(root: PathBuf) -> Self {
    let store = module_store_for(&root).unwrap_or_else(|| root.clone());
    BuildState::new(root.clone(), root.clone(), root, store)
  }

  pub fn new_from_releases_dir(releases_dir: PathBuf, domain_name: &str) -> Self {
    BuildState::new(
      releases_dir.join("target.web.beta").join(domain_name),
      releases_dir.join("target.web.rc").join(domain_name),
      releases_dir.join("target.web").join(domain_name),
      releases_dir.join("target.web.modules"),
    )
  }

  pub fn new(
    beta_path: PathBuf,
    rc_state: PathBuf,
    prod_state: PathBuf,
    module_store_root: PathBuf,
  ) -> Self {
    BuildState {
      beta_state: RoutesState::new(beta_path),
      rc_state: RoutesState::new(rc_state),
      prod_state: RoutesState::new(prod_state),
      module_store_root,
    }
  }

  pub fn thread_specific(&self) -> ThreadSpecificBuildState {
    ThreadSpecificBuildState {
      beta_state: self.beta_state.thread_specific(),
      rc_state: self.rc_state.thread_specific(),
      prod_state: self.prod_state.thread_specific(),
      module_store_root: self.module_store_root.clone(),
    }
  }
}

#[derive(Debug, Clone)]
pub struct ThreadSpecificRoutesState {
  last_invalidated: Arc<RwLock<SystemTime>>,
  pub routes_root: PathBuf,
  last_built: Option<SystemTime>,
  routes: Option<DomainedRoutes>,
}

impl ThreadSpecificRoutesState {
  fn should_rebuild(&self) -> bool {
    if self.routes.is_none() {
      return true;
    }

    let Some(dev_routes_build_time) = self.last_built else {
      return true;
    };

    let last_update_time = self.last_invalidated.read().expect("poisoned");
    dev_routes_build_time > *last_update_time
  }

  pub fn routes(&mut self) -> &DomainedRoutes {
    if self.should_rebuild() {
      self.routes = Some(DomainedRoutes::new(&self.routes_root));
      self.last_built = Some(SystemTime::now());
    }
    self.routes.as_ref().expect("")
  }
}

#[derive(Debug, Clone)]
pub struct ThreadSpecificBuildState {
  pub beta_state: ThreadSpecificRoutesState,
  pub rc_state: ThreadSpecificRoutesState,
  pub prod_state: ThreadSpecificRoutesState,
  pub module_store_root: PathBuf,
}

#[cfg(test)]
mod tests {
  use super::module_store_for;
  use std::path::{Path, PathBuf};

  /// The shape the derivation is written for.
  #[test]
  fn a_stage_tree_resolves_beside_its_stages() {
    assert_eq!(
      module_store_for(Path::new("/srv/releases/target.web.rc/example.com")),
      Some(PathBuf::from("/srv/releases/target.web.modules"))
    );
  }

  /// The dev tree, which is why the derivation goes up two levels rather than
  /// one: `<crate>/target/local.web` → `<crate>/target.web.modules`.
  #[test]
  fn the_dev_tree_resolves_beside_the_crate_target() {
    assert_eq!(
      module_store_for(Path::new("/w/localhost.node/target/local.web")),
      Some(PathBuf::from("/w/localhost.node/target.web.modules"))
    );
  }

  /// A shallow output root derives a store OUTSIDE any build tree, and nothing
  /// about the value says so. `build-web /tmp/x` aims the emitter at
  /// `/target.web.modules`; on a read-only root every esbuild write fails while
  /// the command still reports success, because the emit is non-fatal and its
  /// `error!` reaches nobody without a tracing subscriber. `perfile_emit_step`
  /// now fails on an unwritable store for exactly this reason — the derivation
  /// itself cannot tell a bad root from a good one, so the check has to be at
  /// the point of use.
  #[test]
  fn a_shallow_output_root_derives_a_store_outside_any_build_tree() {
    assert_eq!(
      module_store_for(Path::new("/tmp/x")),
      Some(PathBuf::from("/target.web.modules"))
    );
  }

  /// Documented `None` case: fewer than two ancestors.
  #[test]
  fn a_root_without_two_ancestors_derives_nothing() {
    assert_eq!(module_store_for(Path::new("/tmp")), None);
  }
}
