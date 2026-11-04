use std::path::PathBuf;
use anyhow::Result;
use tento_env::{Env, FromEnv, Home, XdgStateHome};
use super::validate_id;

fn override_path<K: std::ops::Deref<Target = PathBuf>>(loaded: &Option<Env<K>>) -> Option<PathBuf> {
  let path = loaded.as_ref()?.value().deref().clone();
  (!path.as_os_str().is_empty()).then_some(path)
}

/// Target-scoped config paths. Unlike runtime AppDirs overrides, an ambient
/// TENTO_APP_* variable cannot redirect a tool reading another app's config.
#[derive(Debug, Clone)]
pub struct ConfigDirs {
  pub id: String,
  pub root: PathBuf,
  pub run: PathBuf,
}

#[derive(Debug, FromEnv)]
pub struct ConfigEnvGroup {
  pub home: Env<Home>,
  pub config_home: Option<Env<tento_env::XdgConfigHome>>,
  pub state_home: Option<Env<XdgStateHome>>,
}

impl ConfigDirs {
  pub fn resolve(id: &str) -> Result<Self> {
    Self::resolve_from(id, &ConfigEnvGroup::from_env().into_result()?)
  }

  pub fn resolve_from(id: &str, env: &ConfigEnvGroup) -> Result<Self> {
    validate_id(id)?;
    let home = &env.home.value().0;
    let config = override_path(&env.config_home).unwrap_or_else(|| home.join(".config"));
    let state = override_path(&env.state_home).unwrap_or_else(|| home.join(".local/state"));
    anyhow::ensure!(
      config.is_absolute() && state.is_absolute(),
      "config and state roots must be absolute"
    );
    Ok(Self {
      id: id.to_owned(),
      root: config.join("tento/apps").join(id),
      run: state.join("tento").join(id).join("run"),
    })
  }
}
