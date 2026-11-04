use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tento_env::{Env, FromEnv, env_kv};

use super::{Action, Compiler, CompilerBuilder};

env_kv!("TENTO_WEB_JS", PathBuf);
env_kv!("TENTO_CHRONO_JS", PathBuf);
env_kv!("TENTO_PLUGINS_JS_ROOT", PathBuf);
env_kv!("TENTO_LONA_JS_ROOT", PathBuf);

/// The lona.so server's declared rebuild roots, by package name.
///
/// Superseded: the dev watcher now derives its watch set from what the build
/// read (`Webapp::build_inputs`), so tento-web needs no list of browser
/// packages — this one names lona's, and only lona's servers construct it
/// (so.lona, so.lona.admin, so.lona.static; owner yuzuquats). It stays until
/// they drop it; nothing else may add a package here.
#[derive(Clone, Debug, FromEnv, Serialize, Deserialize)]
pub struct TentoWebJsConfig {
  pub root: Env<TentoWebJs>,
  pub chrono: Env<TentoChronoJs>,
  pub plugins: Env<TentoPluginsJsRoot>,
  pub tento_lona_js: Env<TentoLonaJsRoot>,
}

impl TentoWebJsConfig {
  pub fn js_source_compiler(&self) -> CompilerBuilder {
    let tento_web_js_root = self.root.0.to_str().unwrap();
    let tento_lona_js_root = self.tento_lona_js.0.to_str().unwrap();
    let tento_root = self.tento_lona_js.0.parent();
    let mut builder = Compiler::builder()
      .dep((tento_web_js_root, Action::RebuildRoutes))
      .dep((self.chrono.0.to_str().unwrap(), Action::RebuildRoutes))
      .dep((".", Action::RebuildRoutes))
      .dep((tento_lona_js_root, Action::RebuildRoutes));
    builder = add_rebuild_dep(builder, tento_root, "tento-lona-js/sheets");
    builder = add_rebuild_dep(builder, tento_root, "tento-lona-js/sheets-ui");
    builder = add_rebuild_dep(builder, tento_root, "tento-core-js");
    builder = add_rebuild_dep(builder, tento_root, "tento-ui-js");
    builder = add_rebuild_dep(builder, tento_root, "tento-scroll-js");
    builder = add_rebuild_dep(builder, tento_root, "tento-chat-js");
    builder = add_rebuild_dep(builder, tento_root, "tento-data-js");
    builder = add_rebuild_dep(builder, tento_root, "tento-data-ui-js");
    builder = add_rebuild_dep(builder, tento_root, "tento-plugins-js");
    // Subpaths on purpose: the package root also holds examples/*/ whose own
    // build output would rebuild-storm the dev server if watched.
    builder = add_rebuild_dep(builder, tento_root, "tento-brand-js/src");
    builder = add_rebuild_dep(builder, tento_root, "tento-brand-js/systems");
    builder = add_rebuild_dep(builder, tento_root, "tento-brand-js/kit");
    // The Lona showcase adapters are a second, opt-in source package; a host
    // that serves them wants its edits to rebuild routes too.
    builder = add_rebuild_dep(builder, tento_root, "tento-brand-lona-js");
    builder
  }
}

pub(crate) fn add_rebuild_dep(
  builder: CompilerBuilder,
  parent: Option<&Path>,
  dirname: &str,
) -> CompilerBuilder {
  let Some(parent) = parent else {
    return builder;
  };
  let path = parent.join(dirname);
  if !path.exists() {
    return builder;
  }
  builder.dep((
    path.to_str().expect("rebuild dep path not UTF-8"),
    Action::RebuildRoutes,
  ))
}
