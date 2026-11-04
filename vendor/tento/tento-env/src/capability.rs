//! A *capability* binds a stable name to an envgroup whose presence in an
//! environment decides whether a unit of functionality is available — a
//! acme-console subcommand group (evaluated against the operator's local env)
//! or a host's readiness for a package/grant (evaluated against that host's
//! secret bucket). The env/secret key surface is derived from the envgroup's
//! `FromEnv` manifest via [`EnvManifest::of`] — never hand-listed — so one
//! declaration drives gating, the fleet `secrets-store` node, and the
//! generated capability artifact.

use serde::{Deserialize, Serialize};

use crate::manifest::EnvManifest;
use crate::preflight::{GroupReport, preflight};
use crate::template::EnvTemplate;

/// A named capability: an envgroup whose required vars define a unit of
/// functionality. Keys come from [`Self::Env`]'s `FromEnv` manifest, so the
/// declaration is the single source of truth for both gating and rendering.
pub trait Capability {
  /// Stable identifier (`"cloudflare"`, `"linear"`, `"server-app"`). Doubles as the
  /// ledger grant key, the generated-artifact key, and the node id segment.
  const NAME: &'static str;

  /// The envgroup whose required env/secret vars define this capability.
  type Env: EnvTemplate;

  /// The capability's env/secret surface, derived from [`Self::Env`].
  fn manifest() -> EnvManifest {
    // Keep the associated type fully qualified: rustc 1.98-nightly's
    // incremental fingerprint verifier can ICE while resolving the shorthand
    // `Self::Env` here (`explicit_supertraits_containing_assoc_item`).
    EnvManifest::of::<<Self as Capability>::Env>()
  }

  /// Presence of [`Self::Env`] against the active backend (the operator-local
  /// env). The capability is satisfied locally iff [`GroupReport::resolved`];
  /// [`GroupReport::missing_required`] names the gap.
  fn local_presence() -> GroupReport {
    preflight::<<Self as Capability>::Env>()
  }

  /// Type-erased descriptor (name + manifest) for heterogeneous collections,
  /// the fleet node, and the generated artifact — drops the static type so
  /// capabilities of different `Env` types live in one `Vec`.
  fn info() -> CapabilityInfo {
    CapabilityInfo {
      name: Self::NAME.to_string(),
      manifest: Self::manifest(),
    }
  }
}

/// Type-erased capability descriptor: the name plus its env/secret manifest.
/// What the `secrets-store` node and the generated artifact consume — no static
/// type, so it serializes and travels through the ledger/registry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityInfo {
  pub name: String,
  pub manifest: EnvManifest,
}

impl CapabilityInfo {
  /// Boot-critical keys absent under `present` — empty means this capability's
  /// required keys are all resolvable in the probed environment (e.g. a host
  /// bucket via `tento_secrets::store::present`). Keyed off required-ness, not
  /// `secret`: optionality is the boot-critical signal.
  pub fn missing_required<F: Fn(&str) -> bool>(&self, present: F) -> Vec<String> {
    self
      .manifest
      .boot_critical_keys()
      .into_iter()
      .filter(|v| !present(&v.key))
      .map(|v| v.key.to_string())
      .collect()
  }

  /// Every key this capability declares (required or optional) — the orphan
  /// baseline: a stored bucket key matching none of these is an orphan.
  pub fn all_keys(&self) -> Vec<&str> {
    self.manifest.all_keys()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{Backend, Env, EnvError, EnvGroup, EnvGroupResult, FromEnv, env_kv, with_backend};

  env_kv!("CAPABILITY_TEST_TOKEN", String, secret);
  env_kv!("CAPABILITY_TEST_OPTIONAL", String, secret);

  #[derive(FromEnv)]
  struct CloudflareEnv {
    token: Env<CapabilityTestToken>,
  }

  #[derive(FromEnv)]
  #[env(secrets_version = "1.0.0")]
  struct CloudflareCapEnv {
    cloudflare: EnvGroup<CloudflareEnv>,
    extra: EnvGroupResult<CloudflareEnv>,
  }

  struct CloudflareCap;
  impl Capability for CloudflareCap {
    const NAME: &'static str = "cloudflare";
    type Env = CloudflareCapEnv;
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
  fn manifest_and_keys_derive_from_envgroup() {
    let info = CloudflareCap::info();
    assert_eq!(info.name, "cloudflare");
    // All declared keys (required group + optional group occurrences).
    assert!(info.all_keys().contains(&"CAPABILITY_TEST_TOKEN"));
    // Only the required group's key is boot-critical (required ancestry).
    let missing = info.missing_required(|_| false);
    assert_eq!(missing, vec!["CAPABILITY_TEST_TOKEN".to_string()]);
    assert!(info.missing_required(|_| true).is_empty());
  }

  #[test]
  fn local_presence_tracks_active_backend() {
    let present = with_backend(PresentBackend, CloudflareCap::local_presence);
    assert!(present.resolved);
    let absent = with_backend(AbsentBackend, CloudflareCap::local_presence);
    assert!(!absent.resolved);
    assert_eq!(
      absent.missing_required(),
      vec!["CAPABILITY_TEST_TOKEN".to_string()]
    );
  }
}
