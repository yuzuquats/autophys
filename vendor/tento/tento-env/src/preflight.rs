//! Binary self-verification: walk a config type's [`crate::EnvTemplate`] and
//! probe each key's *presence* through the active [`crate::Backend`] — the same
//! resolver the binary uses at boot — without reading or printing any value.
//!
//! A binary exposes this (e.g. a `preflight` subcommand) so the fleet can ask
//! "would this resolve, and which capabilities are live?" host-accurately. A
//! group is `resolved` when all its required vars and required sub-groups are
//! present, which mirrors whether its capability (and thus its commands) loads.

use serde::{Deserialize, Serialize};

use crate::template::{EnvGroupMeta, EnvTemplate};

/// Presence of a single env var (value never read).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VarReport {
  pub key: String,
  pub required: bool,
  pub secret: bool,
  pub present: bool,
}

/// Resolution status of a group and its subtree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupReport {
  pub name: String,
  pub required: bool,
  /// All required vars + required sub-groups present → capability is available.
  pub resolved: bool,
  pub vars: Vec<VarReport>,
  pub groups: Vec<GroupReport>,
}

impl GroupReport {
  /// Required vars/sub-groups missing anywhere on the boot path — the binary
  /// would fail to boot if non-empty.
  pub fn missing_required(&self) -> Vec<String> {
    let mut out = Vec::new();
    self.collect_missing(true, &mut out);
    out
  }

  fn collect_missing(&self, ancestors_required: bool, out: &mut Vec<String>) {
    let on_boot_path = ancestors_required && self.required;
    if on_boot_path {
      out.extend(
        self
          .vars
          .iter()
          .filter(|v| v.required && !v.present)
          .map(|v| v.key.clone()),
      );
    }
    for g in &self.groups {
      g.collect_missing(on_boot_path, out);
    }
  }
}

/// Build a presence report for `T` against the active backend (value-safe).
pub fn preflight<T: EnvTemplate>() -> GroupReport {
  walk(&T::env_template())
}

fn walk(meta: &EnvGroupMeta) -> GroupReport {
  let vars: Vec<VarReport> = meta
    .vars
    .iter()
    .map(|v| VarReport {
      key: v.key.to_string(),
      required: v.required,
      secret: v.secret,
      present: crate::resolve_key(v.key)
        .map(|o| o.is_some())
        .unwrap_or(false),
    })
    .collect();
  let groups: Vec<GroupReport> = meta.nested.iter().map(walk).collect();
  let resolved = vars.iter().all(|v| !v.required || v.present)
    && groups.iter().all(|g| !g.required || g.resolved);
  GroupReport {
    name: meta.name.to_string(),
    required: meta.required,
    resolved,
    vars,
    groups,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{Backend, Env, EnvError, EnvGroup, EnvGroupResult, FromEnv, env_kv, with_backend};

  env_kv!("PREFLIGHT_TEST_REQ", String, secret);

  #[derive(FromEnv)]
  struct ReqGroup {
    req: Env<PreflightTestReq>,
  }

  #[derive(FromEnv)]
  struct Root {
    required_group: EnvGroup<ReqGroup>,
    optional_group: EnvGroupResult<ReqGroup>,
  }

  struct PresentBackend;
  impl Backend for PresentBackend {
    fn lookup(&self, _key: &'static str) -> Result<Option<String>, EnvError> {
      Ok(Some("x".to_string()))
    }
  }
  struct AbsentBackend;
  impl Backend for AbsentBackend {
    fn lookup(&self, _key: &'static str) -> Result<Option<String>, EnvError> {
      Ok(None)
    }
  }

  #[test]
  fn preflight_reflects_active_backend() {
    let ok = with_backend(PresentBackend, preflight::<Root>);
    assert!(ok.resolved, "all present → resolved");
    assert!(ok.missing_required().is_empty());

    let missing = with_backend(AbsentBackend, preflight::<Root>);
    assert!(!missing.resolved, "required var absent → not resolved");
    // The required group's var is boot-critical; the optional group's is not.
    assert_eq!(
      missing.missing_required(),
      vec!["PREFLIGHT_TEST_REQ".to_string()]
    );
  }

  #[test]
  fn group_report_json_roundtrips() {
    let report = with_backend(AbsentBackend, preflight::<Root>);
    let json = serde_json::to_string(&report).unwrap();
    let back: GroupReport = serde_json::from_str(&json).unwrap();
    assert_eq!(back.missing_required(), report.missing_required());
  }
}
