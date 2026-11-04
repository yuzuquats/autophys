//! On-disk identities: the everyday X25519 recipient identity (`identity`)
//! and the laptop's ed25519 manifest signing key (`signing-key`). Both are
//! one hex line in a `0600` file. The high-value tier (`identity-hv`,
//! passphrase-encrypted) is a later slice and shares this shape.

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use ed25519_dalek::SigningKey;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

pub const IDENTITY_FILE: &str = "identity";
pub const SIGNING_KEY_FILE: &str = "signing-key";

fn random32() -> Result<[u8; 32]> {
  let mut b = [0u8; 32];
  getrandom::getrandom(&mut b).map_err(|e| anyhow!("system randomness unavailable: {e}"))?;
  Ok(b)
}

/// 32 lowercase hex chars of system randomness — the name of a minted
/// handoff file (unguessable, carries no address).
pub fn random_hex32() -> Result<String> {
  let mut b = [0u8; 16];
  getrandom::getrandom(&mut b).map_err(|e| anyhow!("system randomness unavailable: {e}"))?;
  Ok(hex::encode(b))
}

/// Write `hex(bytes)` + newline as a `0600` file, refusing to overwrite: an
/// identity is minted once; losing it means re-enrolling, so replacing one
/// silently would be the worst possible default.
#[cfg(unix)]
fn write_key_file(path: &Path, bytes: &[u8; 32]) -> Result<()> {
  if path.exists() {
    bail!(
      "{} already exists; refusing to overwrite an identity",
      path.display()
    );
  }
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
      .with_context(|| format!("chmod 0700 {}", dir.display()))?;
  }
  let line = Zeroizing::new(format!("{}\n", hex::encode(bytes)));
  let tmp = path.with_extension("tmp");
  std::fs::write(&tmp, line.as_bytes()).with_context(|| format!("write {}", tmp.display()))?;
  std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
    .with_context(|| format!("chmod 0600 {}", tmp.display()))?;
  std::fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
  Ok(())
}

#[cfg(not(unix))]
fn write_key_file(_path: &Path, _bytes: &[u8; 32]) -> Result<()> {
  bail!("secret identities require owner-only file modes; unsupported on this platform")
}

fn read_key_file(path: &Path) -> Result<Zeroizing<[u8; 32]>> {
  let raw = Zeroizing::new(
    std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?,
  );
  let bytes = Zeroizing::new(
    hex::decode(raw.trim()).with_context(|| format!("{}: not a hex key", path.display()))?,
  );
  let arr: [u8; 32] = bytes
    .as_slice()
    .try_into()
    .map_err(|_| anyhow!("{}: expected 32 bytes", path.display()))?;
  Ok(Zeroizing::new(arr))
}

/// The X25519 recipient identity.
pub struct Identity {
  secret: StaticSecret,
}

impl Identity {
  pub fn generate_at(path: &Path) -> Result<Identity> {
    let bytes = Zeroizing::new(random32()?);
    write_key_file(path, &bytes)?;
    Ok(Identity {
      secret: StaticSecret::from(*bytes),
    })
  }

  pub fn load(path: &Path) -> Result<Identity> {
    let bytes = read_key_file(path)?;
    Ok(Identity {
      secret: StaticSecret::from(*bytes),
    })
  }

  pub fn secret(&self) -> &StaticSecret {
    &self.secret
  }

  /// Hex public key — the recipient string used in envelopes and manifests.
  pub fn public_hex(&self) -> String {
    hex::encode(PublicKey::from(&self.secret).as_bytes())
  }
}

/// The ed25519 manifest signing key (laptop only; hosts pin its public half).
pub struct Signer {
  key: SigningKey,
}

impl Signer {
  pub fn generate_at(path: &Path) -> Result<Signer> {
    let bytes = Zeroizing::new(random32()?);
    write_key_file(path, &bytes)?;
    Ok(Signer {
      key: SigningKey::from_bytes(&bytes),
    })
  }

  pub fn load(path: &Path) -> Result<Signer> {
    let bytes = read_key_file(path)?;
    Ok(Signer {
      key: SigningKey::from_bytes(&bytes),
    })
  }

  pub fn signing_key(&self) -> &SigningKey {
    &self.key
  }

  pub fn public_hex(&self) -> String {
    hex::encode(self.key.verifying_key().as_bytes())
  }
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;

  #[test]
  fn generate_load_and_refuse_overwrite() {
    let dir = std::env::temp_dir().join(format!("tento-secrets-id-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join(IDENTITY_FILE);
    let id = Identity::generate_at(&path).unwrap();
    let again = Identity::load(&path).unwrap();
    assert_eq!(id.public_hex(), again.public_hex());
    assert_eq!(
      std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
      0o600
    );
    assert!(Identity::generate_at(&path).is_err());
    let s = Signer::generate_at(&dir.join(SIGNING_KEY_FILE)).unwrap();
    assert_eq!(
      s.public_hex(),
      Signer::load(&dir.join(SIGNING_KEY_FILE))
        .unwrap()
        .public_hex()
    );
    let _ = std::fs::remove_dir_all(&dir);
  }
}
