//! The store as a whole: the signed manifest, this host's identities, and one
//! envelope per record version.
//!
//! Layout under `$TSH_SECRETS_DIR` (default `~/.local/share/tsh/secrets` —
//! the same base as the plaintext [`crate::store`], so the bridge keeps
//! working while records migrate):
//!
//! ```text
//! manifest.json                 signed; plaintext metadata only
//! identity                      0600  X25519 recipient secret (everyday tier)
//! signing-key                   0600  ed25519 (laptop only)
//! <ns>/<name>.v<N>.envelope     ciphertext, one per retained version
//! ```
//!
//! Every mutation: rewrite the envelope(s), update the record, `seq += 1`,
//! sign, atomically replace `manifest.json`. Values are never logged; the
//! only path from ciphertext to plaintext is [`Vault::read`], which returns a
//! [`SecretBytes`].

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

use crate::address::Address;
use crate::envelope::Envelope;
use crate::identity::{IDENTITY_FILE, Identity, SIGNING_KEY_FILE, Signer};
use crate::manifest::{
  Health, HistoryEntry, Host, MANIFEST_FILE, Manifest, Record, SignedManifest, Unlock,
};
use crate::secret::SecretBytes;

pub const ENVELOPE_SUFFIX: &str = ".envelope";
/// The roster name for the store's own laptop (the signer's host).
pub const SELF_HOST: &str = "laptop";

/// How many versions stay on disk: current + previous (7-day grace is a
/// later slice; retention here is count-based).
pub const RETAIN_VERSIONS: usize = 2;

pub fn now() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

/// Options for a new record; `set` on an existing record keeps its metadata
/// unless a field is given.
#[derive(Clone, Debug, Default)]
pub struct SetOpts {
  pub provider: Option<String>,
  pub account: Option<String>,
  pub expires: Option<u64>,
  pub renewal_url: Option<String>,
  pub unlock: Option<Unlock>,
  /// Who is setting: `operator` by default.
  pub source: Option<String>,
}

pub struct Vault {
  dir: PathBuf,
  identity: Identity,
  /// Present on the laptop; absent on a host that only opens envelopes.
  signer: Option<Signer>,
  manifest: SignedManifest,
}

impl Vault {
  /// The store root: `$TSH_SECRETS_DIR` or `~/.local/share/tsh/secrets`.
  pub fn default_dir() -> Result<PathBuf> {
    crate::store::base_dir()
  }

  pub fn exists_at(dir: &Path) -> bool {
    dir.join(MANIFEST_FILE).exists()
  }

  /// Create a fresh laptop store: identity + signing key + an empty signed
  /// manifest whose roster holds only `laptop`. Refuses if one exists.
  pub fn init_at(dir: &Path) -> Result<Vault> {
    if Self::exists_at(dir) {
      bail!("secret store already initialised at {}", dir.display());
    }
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    #[cfg(unix)]
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
      .with_context(|| format!("chmod 0700 {}", dir.display()))?;
    let identity = Identity::generate_at(&dir.join(IDENTITY_FILE))?;
    let signer = Signer::generate_at(&dir.join(SIGNING_KEY_FILE))?;
    let mut manifest = Manifest::new(&signer.public_hex());
    manifest.hosts.insert(
      SELF_HOST.to_string(),
      Host {
        recipient: identity.public_hex(),
        enrolled: now(),
        namespaces: vec!["*".to_string()],
      },
    );
    let signed = manifest.sign(signer.signing_key())?;
    write_manifest(dir, &signed)?;
    Ok(Vault {
      dir: dir.to_path_buf(),
      identity,
      signer: Some(signer),
      manifest: signed,
    })
  }

  /// Open an existing store, verifying the manifest against the pinned
  /// signer. On the laptop the pin is the local signing key; on a host it is
  /// `signer.pub` written at enrollment (later slice) — for now a host with no
  /// signing key pins the manifest's own signer, which is only acceptable
  /// because push (which is what would swap it) does not exist yet.
  pub fn open_at(dir: &Path) -> Result<Vault> {
    let manifest_path = dir.join(MANIFEST_FILE);
    let raw = match std::fs::read_to_string(&manifest_path) {
      Ok(raw) => raw,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
        bail!("{}", missing_store(dir, Self::default_dir().ok().as_deref()))
      }
      // Unreadable, or not a file: `init` would refuse it as initialised,
      // so the init hint would send the person in a circle.
      Err(e) => {
        let context = format!("read secret store manifest {}", manifest_path.display());
        return Err(anyhow!(e).context(context));
      }
    };
    let signed: SignedManifest =
      serde_json::from_str(&raw).with_context(|| format!("parse {}", manifest_path.display()))?;
    let signer = match Signer::load(&dir.join(SIGNING_KEY_FILE)) {
      Ok(s) => Some(s),
      Err(_) if !dir.join(SIGNING_KEY_FILE).exists() => None,
      Err(e) => return Err(e),
    };
    let pin = signer
      .as_ref()
      .map(|s| s.public_hex())
      .unwrap_or_else(|| signed.manifest.signer.clone());
    signed.verify(&pin)?;
    let identity = Identity::load(&dir.join(IDENTITY_FILE))?;
    Ok(Vault {
      dir: dir.to_path_buf(),
      identity,
      signer,
      manifest: signed,
    })
  }

  /// Open, or create when absent — what `set` on a fresh laptop wants.
  pub fn open_or_init_at(dir: &Path) -> Result<Vault> {
    if Self::exists_at(dir) {
      Self::open_at(dir)
    } else {
      Self::init_at(dir)
    }
  }

  pub fn dir(&self) -> &Path {
    &self.dir
  }

  pub fn manifest(&self) -> &Manifest {
    &self.manifest.manifest
  }

  pub fn seq(&self) -> u64 {
    self.manifest.manifest.seq
  }

  pub fn recipient_hex(&self) -> String {
    self.identity.public_hex()
  }

  pub fn record(&self, addr: &Address) -> Option<&Record> {
    self.manifest.manifest.records.get(&addr.to_string())
  }

  /// All records, sorted by address.
  pub fn records(&self) -> impl Iterator<Item = (Address, &Record)> {
    self
      .manifest
      .manifest
      .records
      .iter()
      .filter_map(|(k, r)| Address::parse(k).ok().map(|a| (a, r)))
  }

  fn envelope_path(&self, addr: &Address, version: u32) -> PathBuf {
    self
      .dir
      .join(addr.namespace())
      .join(format!("{}.v{version}{ENVELOPE_SUFFIX}", addr.name()))
  }

  /// Keyed fingerprint of a value: HKDF(signing key ∥ identity) as the key,
  /// so the plaintext manifest reveals nothing an outsider could brute-force
  /// against a guessed value. Short on purpose — it is a comparison aid.
  fn fingerprint(&self, value: &[u8]) -> String {
    let mut ikm = Vec::new();
    ikm.extend_from_slice(self.manifest.manifest.signer.as_bytes());
    ikm.extend_from_slice(self.identity.public_hex().as_bytes());
    let hk = Hkdf::<Sha256>::new(Some(b"tsh-secrets/fp"), &ikm);
    let mut key = [0u8; 32];
    hk.expand(b"fingerprint", &mut key).expect("valid length");
    let mut h = Sha256::new();
    h.update(key);
    h.update(value);
    hex::encode(&h.finalize()[..6])
  }

  fn signer(&self) -> Result<&Signer> {
    self
      .signer
      .as_ref()
      .ok_or_else(|| anyhow!("this store has no signing key — only the laptop can write it"))
  }

  /// Recipients a new envelope is sealed for: every roster host whose
  /// namespace set covers the address (`*` or the namespace itself).
  fn recipients_for(&self, addr: &Address) -> Vec<String> {
    self
      .manifest
      .manifest
      .hosts
      .values()
      .filter(|h| {
        h.namespaces
          .iter()
          .any(|n| n == "*" || n == addr.namespace())
      })
      .map(|h| h.recipient.clone())
      .collect()
  }

  /// Store a value. A new address creates the record at v1; an existing one
  /// gets a new version (`rotated` bumps, health → ok, previous version kept,
  /// older ciphertext removed).
  pub fn set(&mut self, addr: &Address, value: &[u8], opts: SetOpts) -> Result<u32> {
    if value.is_empty() {
      bail!("refusing to store an empty value for {addr}");
    }
    let signer_key = self.signer()?.signing_key().clone();
    let key = addr.to_string();
    let ts = now();
    let recipients = self.recipients_for(addr);
    let source = opts
      .source
      .clone()
      .unwrap_or_else(|| "operator".to_string());
    let fp = self.fingerprint(value);

    let (version, record, stale): (u32, Record, Vec<u32>) =
      match self.manifest.manifest.records.get(&key) {
        None => {
          let r = Record {
            provider: opts.provider,
            account: opts.account,
            created: ts,
            rotated: ts,
            expires: opts.expires,
            renewal_url: opts.renewal_url,
            unlock: opts.unlock.unwrap_or(Unlock::None),
            health: Health::Ok,
            current: 1,
            versions: vec![1],
            fingerprint: fp,
            history: vec![HistoryEntry {
              at: ts,
              event: "set".into(),
              source,
              reason: None,
              evidence: None,
            }],
          };
          (1, r, Vec::new())
        }
        Some(existing) => {
          let mut r = existing.clone();
          let version = r.versions.iter().copied().max().unwrap_or(r.current) + 1;
          r.versions.push(version);
          r.versions.sort_unstable();
          let mut stale = Vec::new();
          while r.versions.len() > RETAIN_VERSIONS {
            stale.push(r.versions.remove(0));
          }
          r.current = version;
          r.rotated = ts;
          r.health = Health::Ok;
          r.fingerprint = fp;
          if opts.provider.is_some() {
            r.provider = opts.provider;
          }
          if opts.account.is_some() {
            r.account = opts.account;
          }
          if opts.expires.is_some() {
            r.expires = opts.expires;
          }
          if opts.renewal_url.is_some() {
            r.renewal_url = opts.renewal_url;
          }
          if let Some(u) = opts.unlock {
            r.unlock = u;
          }
          r.history.push(HistoryEntry {
            at: ts,
            event: "rotate".into(),
            source,
            reason: None,
            evidence: None,
          });
          (version, r, stale)
        }
      };

    // Ciphertext first, manifest last: a crash between the two leaves an
    // unreferenced envelope (harmless) rather than a reference to nothing.
    let env = Envelope::seal(&key, version, value, &recipients)?;
    write_envelope(&self.envelope_path(addr, version), &env)?;

    let mut manifest = self.manifest.manifest.clone();
    manifest.records.insert(key, record);
    let signed = manifest.sign(&signer_key)?;
    write_manifest(&self.dir, &signed)?;
    self.manifest = signed;

    for v in stale {
      let _ = std::fs::remove_file(self.envelope_path(addr, v));
    }
    Ok(version)
  }

  /// Decrypt a record's current (or a named) version with this host's
  /// everyday identity. The high-value tier (`:unlock :session|:launch`) is a
  /// later slice: today it is refused rather than silently downgraded.
  pub fn read(&self, addr: &Address, version: Option<u32>) -> Result<SecretBytes> {
    let record = self
      .record(addr)
      .ok_or_else(|| anyhow!("no secret at {addr}"))?;
    if record.unlock != Unlock::None {
      bail!(
        "{addr} is a high-value record (:unlock {:?}); the per-session unlock tier is not built yet",
        record.unlock
      );
    }
    let version = version.unwrap_or(record.current);
    if !record.versions.contains(&version) {
      bail!(
        "{addr} has no version {version} on disk (have {:?})",
        record.versions
      );
    }
    let path = self.envelope_path(addr, version);
    let raw = std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let env: Envelope =
      serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
    if env.addr != addr.to_string() || env.version != version {
      bail!(
        "{}: envelope is labelled {}#v{}",
        path.display(),
        env.addr,
        env.version
      );
    }
    env.open(self.identity.secret())
  }

  /// Append a history line and re-sign (health transitions, reports).
  pub fn append_history(
    &mut self,
    addr: &Address,
    entry: HistoryEntry,
    health: Option<Health>,
  ) -> Result<()> {
    let signer_key = self.signer()?.signing_key().clone();
    let mut manifest = self.manifest.manifest.clone();
    let rec = manifest
      .records
      .get_mut(&addr.to_string())
      .ok_or_else(|| anyhow!("no secret at {addr}"))?;
    rec.history.push(entry);
    if let Some(h) = health {
      rec.health = h;
    }
    let signed = manifest.sign(&signer_key)?;
    write_manifest(&self.dir, &signed)?;
    self.manifest = signed;
    Ok(())
  }
}

fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
  }
  let tmp = path.with_extension("tmp");
  std::fs::write(&tmp, bytes).with_context(|| format!("write {}", tmp.display()))?;
  #[cfg(unix)]
  std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode))
    .with_context(|| format!("chmod {mode:o} {}", tmp.display()))?;
  #[cfg(not(unix))]
  let _ = mode;
  std::fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
  Ok(())
}

fn write_manifest(dir: &Path, signed: &SignedManifest) -> Result<()> {
  let json = serde_json::to_string_pretty(signed).context("encode manifest")?;
  write_atomic(&dir.join(MANIFEST_FILE), json.as_bytes(), 0o600)
}

fn write_envelope(path: &Path, env: &Envelope) -> Result<()> {
  let json = serde_json::to_string_pretty(env).context("encode envelope")?;
  write_atomic(path, json.as_bytes(), 0o600)
}

/// What to say when `dir` holds no store: how to create it. `tsh.secrets
/// "init"` creates the default store, so a store elsewhere is named through
/// `TSH_SECRETS_DIR`, which `init` honours when it is absolute.
fn missing_store(dir: &Path, default: Option<&Path>) -> String {
  let init = r#"tsh '(tsh.secrets "init")'"#;
  if default == Some(dir) {
    return format!("no secret store at {} (create it: {init})", dir.display());
  }
  let absolute = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
  let quoted = format!("'{}'", absolute.display().to_string().replace('\'', r"'\''"));
  format!(
    "no secret store at {} (create it: TSH_SECRETS_DIR={quoted} {init})",
    dir.display()
  )
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;

  fn temp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "tento-secrets-vault-{tag}-{}-{}",
      std::process::id(),
      now()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
  }

  /// tsh-core-shell(14), operator Q16: the missing-store hint names a form
  /// that works. `secrets init` is not a command a tsh 0.1.54 user can run;
  /// `tsh '(tsh.secrets "init")'` is, from a shell, and its inner form is
  /// what to type inside tsh.
  #[test]
  fn a_missing_store_names_the_init_form_that_works() {
    let dir = temp("missing-store-hint");
    let error = format!("{:#}", Vault::open_at(&dir.join("absent")).err().expect("no store"));
    assert!(error.contains(r#"tsh '(tsh.secrets "init")'"#), "{error}");
    assert!(!error.contains("(run `secrets init`)"), "{error}");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// The init hint is for a store that is genuinely absent, and names the
  /// store `init` would create. A manifest that cannot be read — here a
  /// directory where the file should be — is reported as the I/O error with
  /// its path, since `init` refuses that store as already initialised.
  #[test]
  fn only_a_missing_store_gets_the_init_hint_and_it_names_that_store() {
    let dir = temp("unreadable-manifest");
    std::fs::create_dir_all(dir.join(MANIFEST_FILE)).unwrap();
    let error = format!("{:#}", Vault::open_at(&dir).err().expect("unreadable"));
    assert!(!error.contains("tsh.secrets"), "{error}");
    assert!(error.contains(&dir.join(MANIFEST_FILE).display().to_string()), "{error}");
    assert!(Vault::init_at(&dir).is_err(), "init refuses it, so no hint may suggest init");
    let _ = std::fs::remove_dir_all(&dir);

    let default = Path::new("/home/x/.local/share/tsh/secrets");
    assert_eq!(
      missing_store(default, Some(default)),
      r#"no secret store at /home/x/.local/share/tsh/secrets (create it: tsh '(tsh.secrets "init")')"#
    );
    assert_eq!(
      missing_store(Path::new("/srv/it's"), Some(default)),
      r#"no secret store at /srv/it's (create it: TSH_SECRETS_DIR='/srv/it'\''s' tsh '(tsh.secrets "init")')"#
    );
    assert!(missing_store(Path::new("/srv/s"), None).contains("TSH_SECRETS_DIR='/srv/s' "));
  }

  #[test]
  fn init_set_read_rotate_retain_and_reopen() {
    let dir = temp("roundtrip");
    let addr = Address::parse("deepseek/api-key").unwrap();
    let mut v = Vault::init_at(&dir).unwrap();
    assert_eq!(v.seq(), 1);
    assert!(Vault::init_at(&dir).is_err());

    assert_eq!(v.set(&addr, b"sk-one", SetOpts::default()).unwrap(), 1);
    assert_eq!(v.read(&addr, None).unwrap().expose(), b"sk-one");
    let fp1 = v.record(&addr).unwrap().fingerprint.clone();

    assert_eq!(v.set(&addr, b"sk-two", SetOpts::default()).unwrap(), 2);
    assert_eq!(v.set(&addr, b"sk-three", SetOpts::default()).unwrap(), 3);
    let rec = v.record(&addr).unwrap();
    assert_eq!(rec.current, 3);
    assert_eq!(rec.versions, vec![2, 3], "current + previous only");
    assert_ne!(rec.fingerprint, fp1);
    assert_eq!(rec.history.len(), 3);
    assert!(!dir.join("deepseek/api-key.v1.envelope").exists());
    assert_eq!(v.read(&addr, Some(2)).unwrap().expose(), b"sk-two");
    assert!(v.read(&addr, Some(1)).is_err());

    // Nothing plaintext anywhere on disk.
    for entry in walk(&dir) {
      let bytes = std::fs::read(&entry).unwrap();
      assert!(
        !bytes.windows(6).any(|w| w == b"sk-one" || w == b"sk-two"),
        "{}",
        entry.display()
      );
      assert!(
        !bytes.windows(8).any(|w| w == b"sk-three"),
        "{}",
        entry.display()
      );
    }

    let again = Vault::open_at(&dir).unwrap();
    assert_eq!(again.seq(), v.seq());
    assert_eq!(again.read(&addr, None).unwrap().expose(), b"sk-three");
    assert!(again.record(&Address::parse("nope/x").unwrap()).is_none());

    // Tampered manifest is refused on open.
    let mp = dir.join(MANIFEST_FILE);
    let s = std::fs::read_to_string(&mp)
      .unwrap()
      .replace("\"ok\"", "\"burned\"");
    std::fs::write(&mp, s).unwrap();
    assert!(Vault::open_at(&dir).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn high_value_records_are_refused_until_the_tier_exists() {
    let dir = temp("hv");
    let addr = Address::parse("alpaca/api-key").unwrap();
    let mut v = Vault::init_at(&dir).unwrap();
    v.set(
      &addr,
      b"x",
      SetOpts {
        unlock: Some(Unlock::Session),
        ..Default::default()
      },
    )
    .unwrap();
    assert!(v.read(&addr, None).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap() {
      let p = e.unwrap().path();
      if p.is_dir() {
        out.extend(walk(&p));
      } else {
        out.push(p);
      }
    }
    out
  }
}
