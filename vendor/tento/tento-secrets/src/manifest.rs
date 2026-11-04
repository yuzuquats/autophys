//! The signed manifest: every record's plaintext metadata, the host roster,
//! and a monotonic `seq`. Signed by the laptop's ed25519 key; hosts pin that
//! key at enrollment and refuse anything unsigned or with a lower `seq`
//! (rollback refusal — age-style envelopes are unauthenticated, this is the
//! authentication layer).
//!
//! Signature input is the canonical JSON of everything except `sig`: objects
//! with keys sorted recursively, no whitespace. The canonicalisation is done
//! here rather than trusting serde_json's map type, so a `preserve_order`
//! feature unified in from elsewhere cannot change the bytes we sign.

use std::collections::BTreeMap;

use anyhow::{Context, Result, anyhow, bail};
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MANIFEST_VERSION: u32 = 1;
pub const MANIFEST_FILE: &str = "manifest.json";

/// Which identity wraps a record (design: `:unlock` on the record is
/// authoritative; a binding site may raise, never lower).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Unlock {
  None,
  Session,
  Launch,
}

/// The one-field health machine. Any sender may report `ok → suspect`; only
/// the operator's `mark` or an eviction reaches `burned`; `rotate` → `ok`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Health {
  Ok,
  Suspect,
  Burned,
}

/// One line of a record's persistent history (why it was marked, rotated…).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryEntry {
  /// Unix seconds.
  pub at: u64,
  /// `set` | `rotate` | `report` | `mark` | `rollback` | `evict`.
  pub event: String,
  /// `operator` | `lane:<name>` | `agent:<name>` | `policy:<name>` | `evict:<host>`.
  pub source: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reason: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub evidence: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub provider: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub account: Option<String>,
  /// Unix seconds.
  pub created: u64,
  pub rotated: u64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub expires: Option<u64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub renewal_url: Option<String>,
  pub unlock: Unlock,
  pub health: Health,
  /// The version a mint reads.
  pub current: u32,
  /// Versions whose ciphertext is still on disk (current + previous).
  pub versions: Vec<u32>,
  /// Keyed fingerprint of the current value (never the value): lets two
  /// stores be compared without decrypting.
  pub fingerprint: String,
  #[serde(default)]
  pub history: Vec<HistoryEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Host {
  /// X25519 public key, hex.
  pub recipient: String,
  pub enrolled: u64,
  /// Namespaces pushed to this host (empty = nothing; the laptop's own entry
  /// lists `*`).
  #[serde(default)]
  pub namespaces: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
  pub v: u32,
  pub seq: u64,
  /// ed25519 verifying key, hex.
  pub signer: String,
  pub hosts: BTreeMap<String, Host>,
  pub records: BTreeMap<String, Record>,
}

/// What lives on disk: the manifest plus its signature over the canonical
/// form of everything else.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignedManifest {
  #[serde(flatten)]
  pub manifest: Manifest,
  pub sig: String,
}

/// Recursively sort object keys and emit compact JSON.
pub fn canonical_json(v: &Value) -> String {
  fn sort(v: &Value) -> Value {
    match v {
      Value::Object(m) => {
        let mut sorted: Vec<(&String, &Value)> = m.iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(b.0));
        let mut out = serde_json::Map::new();
        for (k, val) in sorted {
          out.insert(k.clone(), sort(val));
        }
        Value::Object(out)
      }
      Value::Array(a) => Value::Array(a.iter().map(sort).collect()),
      other => other.clone(),
    }
  }
  sort(v).to_string()
}

impl Manifest {
  pub fn new(signer_hex: &str) -> Manifest {
    Manifest {
      v: MANIFEST_VERSION,
      seq: 0,
      signer: signer_hex.to_string(),
      hosts: BTreeMap::new(),
      records: BTreeMap::new(),
    }
  }

  fn canonical(&self) -> Result<String> {
    let v = serde_json::to_value(self).context("manifest to json")?;
    Ok(canonical_json(&v))
  }

  /// Bump `seq` and sign. Every write goes through here.
  pub fn sign(mut self, key: &SigningKey) -> Result<SignedManifest> {
    let signer_hex = hex::encode(key.verifying_key().as_bytes());
    if self.signer != signer_hex {
      bail!(
        "manifest signer {} does not match the signing key {}",
        self.signer,
        signer_hex
      );
    }
    self.seq += 1;
    let sig = key.sign(self.canonical()?.as_bytes());
    Ok(SignedManifest {
      manifest: self,
      sig: hex::encode(sig.to_bytes()),
    })
  }
}

impl SignedManifest {
  /// Verify against a pinned signer (hex verifying key). The manifest's own
  /// `signer` field must equal the pin — a manifest may not nominate a new
  /// signer for itself.
  pub fn verify(&self, pinned_signer_hex: &str) -> Result<()> {
    if self.manifest.v != MANIFEST_VERSION {
      bail!("manifest: unsupported version {}", self.manifest.v);
    }
    if self.manifest.signer != pinned_signer_hex {
      bail!(
        "manifest signer {} is not the pinned signer {}",
        self.manifest.signer,
        pinned_signer_hex
      );
    }
    let vk_bytes: [u8; 32] = hex::decode(pinned_signer_hex)
      .context("pinned signer: not hex")?
      .try_into()
      .map_err(|_| anyhow!("pinned signer: expected 32 bytes"))?;
    let vk = VerifyingKey::from_bytes(&vk_bytes).context("pinned signer: invalid key")?;
    let sig_bytes: [u8; 64] = hex::decode(&self.sig)
      .context("manifest sig: not hex")?
      .try_into()
      .map_err(|_| anyhow!("manifest sig: expected 64 bytes"))?;
    let sig = Signature::from_bytes(&sig_bytes);
    vk.verify(self.manifest.canonical()?.as_bytes(), &sig)
      .map_err(|_| anyhow!("manifest signature does not verify (tampered or wrong signer)"))
  }

  /// Rollback refusal: a replacement must carry a strictly higher `seq`.
  pub fn accept_over(&self, current: Option<&SignedManifest>) -> Result<()> {
    if let Some(cur) = current {
      if self.manifest.seq <= cur.manifest.seq {
        bail!(
          "manifest seq {} is not newer than the installed seq {} — refusing rollback",
          self.manifest.seq,
          cur.manifest.seq
        );
      }
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
  }

  #[test]
  fn sign_verify_tamper_and_rollback() {
    let k = key();
    let signer = hex::encode(k.verifying_key().as_bytes());
    let m = Manifest::new(&signer);
    let s1 = m.sign(&k).unwrap();
    assert_eq!(s1.manifest.seq, 1);
    s1.verify(&signer).unwrap();

    let mut tampered = s1.clone();
    tampered.manifest.hosts.insert(
      "evil".into(),
      Host {
        recipient: "00".repeat(32),
        enrolled: 0,
        namespaces: vec![],
      },
    );
    assert!(tampered.verify(&signer).is_err());

    let other = SigningKey::from_bytes(&[9u8; 32]);
    assert!(
      s1.verify(&hex::encode(other.verifying_key().as_bytes()))
        .is_err()
    );

    let s2 = s1.manifest.clone().sign(&k).unwrap();
    assert_eq!(s2.manifest.seq, 2);
    s2.accept_over(Some(&s1)).unwrap();
    assert!(s1.accept_over(Some(&s2)).is_err(), "rollback refused");
  }

  #[test]
  fn canonical_json_sorts_recursively() {
    let v: Value = serde_json::from_str(r#"{"b":{"z":1,"a":[{"y":2,"x":1}]},"a":0}"#).unwrap();
    assert_eq!(
      canonical_json(&v),
      r#"{"a":0,"b":{"a":[{"x":1,"y":2}],"z":1}}"#
    );
  }
}
