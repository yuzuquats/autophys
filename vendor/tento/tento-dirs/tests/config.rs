use std::path::PathBuf;
use tento_dirs::{ConfigDirs, ConfigEnvGroup};
use tento_env::{Env, Home, XdgConfigHome, XdgStateHome};

#[test]
fn config_resolution_is_target_scoped_and_uses_xdg_roots() {
  let mut env = ConfigEnvGroup {
    home: Env::new("HOME", Home(PathBuf::from("/h"))),
    config_home: None,
    state_home: None,
  };
  assert_eq!(
    ConfigDirs::resolve_from("spaces", &env).unwrap().root,
    PathBuf::from("/h/.config/tento/apps/spaces")
  );
  env.config_home = Some(Env::new(
    "XDG_CONFIG_HOME",
    XdgConfigHome(PathBuf::from("/config")),
  ));
  env.state_home = Some(Env::new(
    "XDG_STATE_HOME",
    XdgStateHome(PathBuf::from("/state")),
  ));
  let a = ConfigDirs::resolve_from("spaces", &env).unwrap();
  let b = ConfigDirs::resolve_from("media", &env).unwrap();
  assert_eq!(a.root, PathBuf::from("/config/tento/apps/spaces"));
  assert_eq!(a.run, PathBuf::from("/state/tento/spaces/run"));
  assert_ne!(a.root, b.root);
  assert!(ConfigDirs::resolve_from("../other", &env).is_err());
  env.config_home = Some(Env::new(
    "XDG_CONFIG_HOME",
    XdgConfigHome(PathBuf::from("relative")),
  ));
  assert!(ConfigDirs::resolve_from("spaces", &env).is_err());
}
