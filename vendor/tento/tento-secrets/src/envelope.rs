//! The encrypted envelope: one ciphertext per secret version, readable by a
//! set of recipients.
//!
//! Shape (age-style, own header — NOT wire-compatible with `age` in v1):
//!
//! - a fresh 32-byte **data key** encrypts the body with ChaCha20-Poly1305
//!   (random 96-bit nonce; the address + version are the AAD, so a ciphertext
//!   cannot be silently re-labelled);
//! - the data key is **wrapped once per recipient**: ephemeral X25519 →
//!   ECDH with the recipient's public key → HKDF-SHA256 → ChaCha20-Poly1305
//!   over the data key (nonce is all-zero: the wrap key is single-use).
//!
//! Adding a recipient rewraps the data key; evicting one drops its stanza
//! (and, per the design, marks what it could read `burned`). The file is
//! JSON so a human can see *who* can read it without seeing *what*.
//!
//! Identity keys are X25519; see [`crate::identity`] for their on-disk shape.

use anyhow::{Context, Result, anyhow, bail};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::secret::SecretBytes;

pub const ENVELOPE_VERSION: u32 = 1;
const WRAP_INFO: &[u8] = b"tsh-secrets/v1/wrap";

/// One recipient's stanza: the data key wrapped to `to`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Stanza {
  /// Recipient X25519 public key, hex.
  pub to: String,
  /// Ephemeral X25519 public key used for this wrap, hex.
  pub eph: String,
  /// ChaCha20-Poly1305(data key), hex (32 + 16 bytes).
  pub wrap: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope {
  pub v: u32,
  /// `namespace/name` — part of the body AAD.
  pub addr: String,
  /// Record version — part of the body AAD.
  pub version: u32,
  pub recipients: Vec<Stanza>,
  pub nonce: String,
  pub ct: String,
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
  let mut b = [0u8; N];
  getrandom::getrandom(&mut b).map_err(|e| anyhow!("system randomness unavailable: {e}"))?;
  Ok(b)
}

fn aad(addr: &str, version: u32) -> Vec<u8> {
  format!("{addr}#v{version}").into_bytes()
}

fn wrap_key(shared: &[u8; 32], eph_pub: &PublicKey, to: &PublicKey) -> Zeroizing<[u8; 32]> {
  let mut salt = Vec::with_capacity(64);
  salt.extend_from_slice(eph_pub.as_bytes());
  salt.extend_from_slice(to.as_bytes());
  let hk = Hkdf::<Sha256>::new(Some(&salt), shared);
  let mut out = Zeroizing::new([0u8; 32]);
  hk.expand(WRAP_INFO, out.as_mut())
    .expect("32 bytes is a valid HKDF-SHA256 output length");
  out
}

fn parse_pub(hex_key: &str, what: &str) -> Result<PublicKey> {
  let bytes = hex::decode(hex_key).with_context(|| format!("{what}: not hex"))?;
  let arr: [u8; 32] = bytes
    .try_into()
    .map_err(|_| anyhow!("{what}: expected 32 bytes"))?;
  Ok(PublicKey::from(arr))
}

impl Envelope {
  /// Seal `plaintext` for `recipients` (hex X25519 public keys). At least one
  /// recipient is required — a secret nobody can read is a bug, not a store.
  pub fn seal(
    addr: &str,
    version: u32,
    plaintext: &[u8],
    recipients: &[String],
  ) -> Result<Envelope> {
    if recipients.is_empty() {
      bail!("seal {addr}: no recipients");
    }
    let data_key = Zeroizing::new(random_bytes::<32>()?);
    let nonce = random_bytes::<12>()?;
    let body = ChaCha20Poly1305::new(Key::from_slice(data_key.as_ref()));
    let ct = body
      .encrypt(
        Nonce::from_slice(&nonce),
        Payload {
          msg: plaintext,
          aad: &aad(addr, version),
        },
      )
      .map_err(|_| anyhow!("seal {addr}: body encryption failed"))?;

    let mut stanzas = Vec::with_capacity(recipients.len());
    for to_hex in recipients {
      stanzas.push(wrap_for(&data_key, to_hex)?);
    }
    Ok(Envelope {
      v: ENVELOPE_VERSION,
      addr: addr.to_string(),
      version,
      recipients: stanzas,
      nonce: hex::encode(nonce),
      ct: hex::encode(ct),
    })
  }

  /// Open with `identity` (this host's X25519 secret). Fails if no stanza is
  /// addressed to it or any tag check fails.
  pub fn open(&self, identity: &StaticSecret) -> Result<SecretBytes> {
    if self.v != ENVELOPE_VERSION {
      bail!("envelope {}: unsupported version {}", self.addr, self.v);
    }
    let me = PublicKey::from(identity);
    let me_hex = hex::encode(me.as_bytes());
    let stanza = self
      .recipients
      .iter()
      .find(|s| s.to == me_hex)
      .ok_or_else(|| anyhow!("envelope {}: this host is not a recipient", self.addr))?;
    let eph = parse_pub(&stanza.eph, "stanza eph")?;
    let shared = identity.diffie_hellman(&eph);
    let wk = wrap_key(shared.as_bytes(), &eph, &me);
    let wrapped = hex::decode(&stanza.wrap).context("stanza wrap: not hex")?;
    let data_key = Zeroizing::new(
      ChaCha20Poly1305::new(Key::from_slice(wk.as_ref()))
        .decrypt(Nonce::from_slice(&[0u8; 12]), wrapped.as_ref())
        .map_err(|_| {
          anyhow!(
            "envelope {}: data key unwrap failed (wrong identity or tampered)",
            self.addr
          )
        })?,
    );
    let nonce = hex::decode(&self.nonce).context("nonce: not hex")?;
    let ct = hex::decode(&self.ct).context("ct: not hex")?;
    let pt = ChaCha20Poly1305::new(Key::from_slice(data_key.as_ref()))
      .decrypt(
        Nonce::from_slice(&nonce),
        Payload {
          msg: &ct,
          aad: &aad(&self.addr, self.version),
        },
      )
      .map_err(|_| {
        anyhow!(
          "envelope {}: body authentication failed (tampered or relabelled)",
          self.addr
        )
      })?;
    Ok(SecretBytes::new(pt))
  }

  /// Rewrap the data key for an additional recipient. Needs an identity that
  /// can already open the envelope (the laptop's, during `push`/`enroll`).
  pub fn add_recipient(&mut self, opener: &StaticSecret, to_hex: &str) -> Result<()> {
    if self.recipients.iter().any(|s| s.to == to_hex) {
      return Ok(());
    }
    let data_key = Zeroizing::new(self.unwrap_data_key(opener)?);
    self.recipients.push(wrap_for(&data_key, to_hex)?);
    Ok(())
  }

  /// Drop a recipient's stanza (eviction). The design also burns the record.
  pub fn remove_recipient(&mut self, to_hex: &str) {
    self.recipients.retain(|s| s.to != to_hex);
  }

  fn unwrap_data_key(&self, identity: &StaticSecret) -> Result<[u8; 32]> {
    let me = PublicKey::from(identity);
    let me_hex = hex::encode(me.as_bytes());
    let stanza = self
      .recipients
      .iter()
      .find(|s| s.to == me_hex)
      .ok_or_else(|| anyhow!("envelope {}: this identity is not a recipient", self.addr))?;
    let eph = parse_pub(&stanza.eph, "stanza eph")?;
    let shared = identity.diffie_hellman(&eph);
    let wk = wrap_key(shared.as_bytes(), &eph, &me);
    let wrapped = hex::decode(&stanza.wrap).context("stanza wrap: not hex")?;
    let dk = ChaCha20Poly1305::new(Key::from_slice(wk.as_ref()))
      .decrypt(Nonce::from_slice(&[0u8; 12]), wrapped.as_ref())
      .map_err(|_| anyhow!("envelope {}: data key unwrap failed", self.addr))?;
    dk.try_into().map_err(|_| anyhow!("data key length"))
  }
}

fn wrap_for(data_key: &[u8; 32], to_hex: &str) -> Result<Stanza> {
  let to = parse_pub(to_hex, "recipient")?;
  let eph_secret = StaticSecret::from(random_bytes::<32>()?);
  let eph_pub = PublicKey::from(&eph_secret);
  let shared = eph_secret.diffie_hellman(&to);
  let wk = wrap_key(shared.as_bytes(), &eph_pub, &to);
  let wrapped = ChaCha20Poly1305::new(Key::from_slice(wk.as_ref()))
    .encrypt(Nonce::from_slice(&[0u8; 12]), data_key.as_ref())
    .map_err(|_| anyhow!("wrap for {to_hex}: failed"))?;
  Ok(Stanza {
    to: to_hex.to_string(),
    eph: hex::encode(eph_pub.as_bytes()),
    wrap: hex::encode(wrapped),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn identity() -> (StaticSecret, String) {
    let sk = StaticSecret::from(random_bytes::<32>().unwrap());
    let pk = hex::encode(PublicKey::from(&sk).as_bytes());
    (sk, pk)
  }

  #[test]
  fn seal_open_roundtrip_and_recipient_ops() {
    let (laptop, laptop_pub) = identity();
    let (host, host_pub) = identity();
    let (stranger, _) = identity();

    let mut env = Envelope::seal("deepseek/api-key", 1, b"sk-123", &[laptop_pub.clone()]).unwrap();
    assert_eq!(env.open(&laptop).unwrap().expose(), b"sk-123");
    assert!(env.open(&host).is_err(), "not yet a recipient");
    assert!(env.open(&stranger).is_err());

    env.add_recipient(&laptop, &host_pub).unwrap();
    assert_eq!(env.open(&host).unwrap().expose(), b"sk-123");
    env.remove_recipient(&host_pub);
    assert!(env.open(&host).is_err(), "evicted");
    assert_eq!(env.open(&laptop).unwrap().expose(), b"sk-123");
  }

  #[test]
  fn relabelled_ciphertext_fails_authentication() {
    let (laptop, laptop_pub) = identity();
    let mut env = Envelope::seal("deepseek/api-key", 1, b"sk-123", &[laptop_pub]).unwrap();
    env.version = 2;
    assert!(env.open(&laptop).is_err());
    env.version = 1;
    env.addr = "other/name".into();
    assert!(env.open(&laptop).is_err());
  }

  #[test]
  fn envelope_json_never_contains_plaintext() {
    let (_, laptop_pub) = identity();
    let env = Envelope::seal(
      "deepseek/api-key",
      1,
      b"very-unique-plaintext",
      &[laptop_pub],
    )
    .unwrap();
    let json = serde_json::to_string(&env).unwrap();
    assert!(!json.contains("very-unique-plaintext"));
    assert!(!json.contains(&hex::encode(b"very-unique-plaintext")));
  }
}
