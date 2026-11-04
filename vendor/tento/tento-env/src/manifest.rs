//! A serializable, `FromEnv`-derived manifest of the environment a config
//! requires — the data the `secrets` fleet node and the deploy gate consume.
//!
//! The manifest is pure data, produced by [`EnvManifest::of`] from any
//! `#[derive(FromEnv)]` type via its [`crate::EnvTemplate`]. It carries the
//! group tree (capability names = struct field names), each var's `secret` flag,
//! per-group display versions, and the slow-moving `secrets_version` semver the
//! secret *surface* declares (`#[env(secrets_version = "x.y.z")]`). Compatibility
//! between a deployed requirement and a binary is a one-line semver check on
//! `secrets_version`, not a manifest diff.

use serde::{Deserialize, Serialize};

use crate::template::{EnvGroupMeta, EnvTemplate};

/// One environment variable in a manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvVar {
  pub key: String,
  pub required: bool,
  pub secret: bool,
}

/// A group of env vars (a capability), mirroring the `FromEnv` group tree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvGroupManifest {
  pub name: String,
  /// Whether the group is on the boot path (`EnvGroup<T>`) vs optional
  /// (`EnvGroupResult<T>` / `Option<EnvGroup<T>>`).
  pub required: bool,
  /// Per-group display version (`#[env(version = N)]`); not the compat handle.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub version: Option<u32>,
  pub vars: Vec<EnvVar>,
  pub groups: Vec<EnvGroupManifest>,
}

/// A versioned, serializable snapshot of a config type's required environment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvManifest {
  /// The secret-surface version string (`#[env(secrets_version)]` on the root
  /// type), e.g. `"2.1.0"`. Kept as a raw string here so this low-level crate
  /// stays dependency-light; consumers parse it to `tento_core::SemVer` for
  /// comparison. `None` for producers that declare no secret surface.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub secrets_version: Option<String>,
  pub root: EnvGroupManifest,
}

impl EnvManifest {
  /// Derive a manifest from any `FromEnv` type via its [`EnvTemplate`].
  pub fn of<T: EnvTemplate>() -> Self {
    let meta = T::env_template();
    EnvManifest {
      secrets_version: meta.secrets_version.clone(),
      root: group_from(&meta),
    }
  }

  /// Secret vars that MUST resolve for the binary to boot: `secret && required`
  /// vars whose entire group ancestry is required.
  pub fn boot_critical_secrets(&self) -> Vec<&EnvVar> {
    let mut out = Vec::new();
    self.root.collect_boot_critical(true, &mut out);
    out
  }

  /// Every secret key anywhere in the tree (required or optional) — the set the
  /// inventory node cross-references to flag orphans.
  pub fn all_secret_keys(&self) -> Vec<&str> {
    let mut out = Vec::new();
    self.root.collect_secret_keys(&mut out);
    out
  }

  /// Every var key anywhere in the tree (required or optional, secret or not).
  /// The capability `secrets-store` node uses this as the orphan baseline: a
  /// stored bucket key matching none of a capability's declared keys is an
  /// orphan. Independent of the `secret` flag — a capability's whole config can
  /// live in its bucket, not just the secret-flagged subset.
  pub fn all_keys(&self) -> Vec<&str> {
    let mut out = Vec::new();
    self.root.collect_keys(&mut out);
    out
  }

  /// Boot-critical keys: required vars whose entire group ancestry is required,
  /// regardless of `secret`. Optionality (`Option`/`EnvGroupResult`) is the
  /// boot-critical signal; `secret` is an orthogonal axis the capability model
  /// does not key off. (Contrast [`Self::boot_critical_secrets`], which the
  /// deploy gate uses to scope to deployable secrets only.)
  pub fn boot_critical_keys(&self) -> Vec<&EnvVar> {
    let mut out = Vec::new();
    self.root.collect_boot_critical_keys(true, &mut out);
    out
  }

  /// A stable fingerprint of the secret surface (sorted `key:required` over all
  /// secret vars). Changes iff a secret is added/removed or its required-ness
  /// flips — the signal the bump-guard test compares against a checked-in
  /// snapshot to require a matching `secrets_version` bump.
  pub fn key_fingerprint(&self) -> String {
    let mut entries: Vec<String> = Vec::new();
    self.root.collect_fingerprint_entries(&mut entries);
    entries.sort();
    entries.dedup();
    fnv1a_hex(entries.join("\n").as_bytes())
  }
}

impl EnvGroupManifest {
  fn collect_boot_critical<'a>(&'a self, ancestors_required: bool, out: &mut Vec<&'a EnvVar>) {
    let on_boot_path = ancestors_required && self.required;
    if on_boot_path {
      out.extend(self.vars.iter().filter(|v| v.secret && v.required));
    }
    for g in &self.groups {
      g.collect_boot_critical(on_boot_path, out);
    }
  }

  fn collect_secret_keys<'a>(&'a self, out: &mut Vec<&'a str>) {
    out.extend(
      self
        .vars
        .iter()
        .filter(|v| v.secret)
        .map(|v| v.key.as_str()),
    );
    for g in &self.groups {
      g.collect_secret_keys(out);
    }
  }

  fn collect_keys<'a>(&'a self, out: &mut Vec<&'a str>) {
    out.extend(self.vars.iter().map(|v| v.key.as_str()));
    for g in &self.groups {
      g.collect_keys(out);
    }
  }

  fn collect_boot_critical_keys<'a>(&'a self, ancestors_required: bool, out: &mut Vec<&'a EnvVar>) {
    let on_boot_path = ancestors_required && self.required;
    if on_boot_path {
      out.extend(self.vars.iter().filter(|v| v.required));
    }
    for g in &self.groups {
      g.collect_boot_critical_keys(on_boot_path, out);
    }
  }

  fn collect_fingerprint_entries(&self, out: &mut Vec<String>) {
    for v in self.vars.iter().filter(|v| v.secret) {
      out.push(format!("{}:{}", v.key, v.required));
    }
    for g in &self.groups {
      g.collect_fingerprint_entries(out);
    }
  }
}

fn group_from(m: &EnvGroupMeta) -> EnvGroupManifest {
  EnvGroupManifest {
    name: m.name.to_string(),
    required: m.required,
    version: m.version,
    vars: m
      .vars
      .iter()
      .map(|v| EnvVar {
        key: v.key.to_string(),
        required: v.required,
        secret: v.secret,
      })
      .collect(),
    groups: m.nested.iter().map(group_from).collect(),
  }
}

/// FNV-1a (64-bit) as lowercase hex — a small, dependency-free, deterministic
/// hash (stable across machines and toolchains, unlike `DefaultHasher`).
fn fnv1a_hex(bytes: &[u8]) -> String {
  let mut hash: u64 = 0xcbf29ce484222325;
  for &b in bytes {
    hash ^= b as u64;
    hash = hash.wrapping_mul(0x100000001b3);
  }
  format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{Env, EnvGroup, EnvGroupResult, FromEnv, env_kv};

  env_kv!("MANIFEST_TEST_DB_URL", String, secret);
  env_kv!("MANIFEST_TEST_CONTAINER_ROOT", std::path::PathBuf);
  env_kv!("MANIFEST_TEST_STRIPE_KEY", String, secret);

  #[derive(FromEnv)]
  #[env(version = 1)]
  struct StripeLike {
    stripe_key: Env<ManifestTestStripeKey>,
  }

  #[derive(FromEnv)]
  #[env(secrets_version = "2.1.0")]
  struct RootLike {
    db_url: Env<ManifestTestDbUrl>,
    container_root: Env<ManifestTestContainerRoot>,
    stripe: EnvGroup<StripeLike>,
    optional_stripe: EnvGroupResult<StripeLike>,
  }

  #[test]
  fn parses_secrets_version_and_secret_flags() {
    let m = EnvManifest::of::<RootLike>();
    assert_eq!(m.secrets_version.as_deref(), Some("2.1.0"));

    // db_url + stripe.stripe_key are secret & required & boot-critical;
    // container_root is not secret; optional_stripe is not on the boot path.
    let boot: Vec<&str> = m
      .boot_critical_secrets()
      .into_iter()
      .map(|v| v.key.as_str())
      .collect();
    assert!(boot.contains(&"MANIFEST_TEST_DB_URL"));
    assert!(boot.contains(&"MANIFEST_TEST_STRIPE_KEY"));
    assert!(!boot.contains(&"MANIFEST_TEST_CONTAINER_ROOT"));
    // boot-critical counts each occurrence on a required path once (stripe group)
    assert_eq!(boot.len(), 2);
  }

  #[test]
  fn fingerprint_is_stable_and_secret_scoped() {
    let a = EnvManifest::of::<RootLike>().key_fingerprint();
    let b = EnvManifest::of::<RootLike>().key_fingerprint();
    assert_eq!(a, b);
    assert_eq!(a.len(), 16);
  }
}
