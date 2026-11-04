//! Process-GLOBAL [`tento_env::EnvMap`] install — its own test binary (= its
//! own process) because `set_global_env_map` is set-once and flips every
//! typed read to map-only resolution, which would break the unit tests that
//! prove the default process-env resolution path.

use tento_env::{EnvMap, effective_var, global_env_map, hermetic_child_env, set_global_env_map};

#[test]
fn global_map_is_the_only_resolution_source() {
  // Empty-map boot: seed HOME (userdb), install globally.
  let map = EnvMap::new();
  map.seed_home();
  assert!(set_global_env_map(map.clone()), "first install wins");
  assert!(
    global_env_map().is_some(),
    "global handle reachable after install"
  );

  // Empty-by-default: exactly HOME is present after the mechanism seed —
  // children of an rc-less session would see only HOME.
  let snapshot = map.snapshot();
  assert_eq!(snapshot.len(), 1, "only the HOME seed: {snapshot:?}");
  assert_eq!(snapshot[0].0, "HOME");

  // effective_var is MAP-ONLY: PATH is guaranteed present in the process env
  // and absent from the map → None (no process-env leak).
  assert_eq!(effective_var("PATH"), None, "no process-env fallback");

  // Typed resolve_key goes through the installed map with no fallback: HOME
  // (seeded) resolves; PATH (process-env-only) does not.
  assert!(tento_env::test_env("HOME").is_some(), "map answer resolves");
  assert_eq!(
    tento_env::test_env("PATH"),
    None,
    "typed reads are map-only once the map is installed"
  );

  // The map's answer wins over the process env's for the same key.
  map.set("PATH", "/declared/bin");
  assert_eq!(effective_var("PATH").as_deref(), Some("/declared/bin"));
  assert_eq!(
    tento_env::test_env("PATH").as_deref(),
    Some("/declared/bin")
  );

  // Hermetic child env == the map snapshot, exactly.
  assert_eq!(hermetic_child_env(), Some(map.snapshot()));
}
