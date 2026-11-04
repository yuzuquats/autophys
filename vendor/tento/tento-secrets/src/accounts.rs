//! Named app accounts ("profiles"): the catalog, credential references,
//! credential transactions and the `auth.provider/v1` wire. No provider policy.
//!
//! An account is one record: which app it is for, an alias, a
//! [`CredentialRef`] saying where its credential lives (a core-owned
//! directory, a vault address, the app's own native store, or a delegate),
//! and the account identity a provider verified. How an app is launched as
//! that account is a [`Launch`] plan: environment references, never tokens.
//!
//! This module was the `tsh-auth-core` crate; it lives in the secrets layer
//! because a named account is a secrets-level concept. `crate::profiles` is
//! kept as an alias of it, and the app half (`tento-auth`) re-exports these
//! types instead of keeping a serde copy.
//!
//! [`kind`] is `account.kind/v1`: an app's account recipe as data, which a
//! generic executor runs instead of a per-app provider binary.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
  collections::BTreeMap,
  fs::{self, File, OpenOptions},
  io::Write,
  path::{Path, PathBuf},
};
use zeroize::Zeroizing;

pub mod kind;
pub use kind::{AccountKind, KIND_V1};

pub const PROVIDER_V1: &str = "auth.provider/v1";
/// Launch environment the shell sets on every profile binding. Values are
/// references: the app name, the catalog profile ID, and — for core-owned
/// (`Local`) credentials only — the directory holding that profile's
/// `credentials.json` and `refresh.lock`. Never a token.
pub const ENV_APP: &str = "TSH_AUTH_APP";
pub const ENV_PROFILE_ID: &str = "TSH_AUTH_PROFILE_ID";
pub const ENV_CREDENTIAL_DIR: &str = "TSH_AUTH_CREDENTIAL_DIR";
/// The host's catalog: `<secrets base>/profiles`.
pub fn default_registry() -> Result<Registry> {
  Ok(Registry::at(crate::store::base_dir()?.join("profiles")))
}
pub fn component(value: &str) -> Result<&str> {
  ensure!(
    !value.is_empty()
      && value.len() <= 128
      && value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
    "Invalid app/profile identifier"
  );
  Ok(value)
}
fn random_id() -> Result<String> {
  let mut bytes = [0; 16];
  getrandom::getrandom(&mut bytes).map_err(|_| anyhow::anyhow!("Profile ID generation failed"))?;
  Ok(hex::encode(bytes))
}
/// Create `path` readable by its owner only (0700). Off unix there is no
/// mode to set: the directory keeps the ACL it inherits from where it is
/// created (the user's profile, for every path this module uses).
pub fn private_dir(path: &Path) -> Result<()> {
  fs::create_dir_all(path)?;
  #[cfg(unix)]
  fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
  Ok(())
}
/// Open options for a file readable by its owner only (0600 on unix; off
/// unix, the inherited ACL, as for [`private_dir`]).
fn private_file(options: &mut OpenOptions) -> &mut OpenOptions {
  #[cfg(unix)]
  options.mode(0o600);
  options
}
/// Unique temporary file, private before the first byte; fsync before rename.
pub fn atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
  let parent = path.parent().context("Missing parent directory")?;
  private_dir(parent)?;
  let tmp = parent.join(format!(".write-{}", random_id()?));
  let mut file = private_file(OpenOptions::new().write(true).create_new(true)).open(&tmp)?;
  let bytes = Zeroizing::new(serde_json::to_vec(value)?);
  file.write_all(&bytes)?;
  file.sync_all()?;
  fs::rename(&tmp, path)?;
  File::open(parent)?.sync_all()?;
  Ok(())
}
/// Kernel releases the lock on crash. Lock files are persistent, never unlinked.
#[derive(Debug)]
pub struct Lock(File);
impl Lock {
  pub fn acquire(path: &Path) -> Result<Self> {
    private_dir(path.parent().context("Missing lock parent")?)?;
    let f = private_file(
      OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false),
    )
    .open(path)?;
    fs2::FileExt::lock_exclusive(&f)?;
    Ok(Self(f))
  }
  pub fn try_acquire(path: &Path) -> Result<Self> {
    private_dir(path.parent().context("Missing lock parent")?)?;
    let f = private_file(
      OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false),
    )
    .open(path)?;
    fs2::FileExt::try_lock_exclusive(&f).context("Conversation is already in use")?;
    Ok(Self(f))
  }
}
impl Drop for Lock {
  fn drop(&mut self) {
    let _ = fs2::FileExt::unlock(&self.0);
  }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "backend", rename_all = "snake_case")]
pub enum CredentialRef {
  Local { key: String },
  Vault { address: String },
  Native { locator: PathBuf },
  Delegated { owner: String },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Identity {
  pub id: String,
  pub label: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
  Ready,
  LoginRequired,
  Unverified,
  Unavailable,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Profile {
  pub app: String,
  pub id: String,
  pub alias: String,
  pub credential: CredentialRef,
  #[serde(default)]
  pub identity: Option<Identity>,
  pub state: AuthState,
}
/// A profile as a provider declares it on the wire. The shell owns the
/// catalog: it merges declarations itself, so a provider never writes
/// `catalog.json`. `id` is optional — a provider that cannot know the catalog
/// ID (a new alias, an imported legacy login) omits it and the shell assigns
/// one. A declaration carrying a catalog-assigned ID (a full [`Profile`] from
/// a provider that wrote the catalog itself) still parses; its `identity` and
/// `state` are ignored, because discovery never asserts account identity.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Declared {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub app: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub id: Option<String>,
  pub alias: String,
  pub credential: CredentialRef,
}
impl Declared {
  /// A declaration with no app and no ID: the shell fills both in.
  pub fn new(alias: impl Into<String>, credential: CredentialRef) -> Self {
    Self {
      app: None,
      id: None,
      alias: alias.into(),
      credential,
    }
  }
}
impl From<Profile> for Declared {
  fn from(p: Profile) -> Self {
    Self {
      app: Some(p.app),
      id: Some(p.id),
      alias: p.alias,
      credential: p.credential,
    }
  }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Catalog {
  #[serde(default)]
  pub profiles: Vec<Profile>,
  #[serde(default)]
  pub defaults: BTreeMap<String, String>,
}
impl Catalog {
  /// [`Registry::register`], inside a [`Registry::edit`]: a caller that must
  /// decide and register in one transaction (a check, then the write, with
  /// no other session in between) does both in its own edit.
  pub fn register(&mut self, app: &str, alias: &str, credential: CredentialRef) -> Result<Profile> {
    component(app)?;
    component(alias)?;
    if let Some(p) = self
      .profiles
      .iter()
      .find(|p| p.app == app && p.alias == alias)
    {
      ensure!(
        p.credential == credential,
        "Profile alias already refers to another credential store"
      );
      return Ok(p.clone());
    }
    let p = Profile {
      app: app.into(),
      id: random_id()?,
      alias: alias.into(),
      credential,
      identity: None,
      state: AuthState::Unverified,
    };
    self.profiles.push(p.clone());
    Ok(p)
  }
  /// The app's default profile: the one its pointer names, if that exists.
  pub fn default_for(&self, app: &str) -> Option<&Profile> {
    self
      .defaults
      .get(app)
      .and_then(|id| self.profiles.iter().find(|p| p.app == app && &p.id == id))
  }
}
#[derive(Clone, Debug)]
pub struct Registry {
  pub root: PathBuf,
}
impl Registry {
  pub fn at(root: impl Into<PathBuf>) -> Self {
    Self { root: root.into() }
  }
  pub fn read(&self) -> Result<Catalog> {
    match fs::read(self.root.join("catalog.json")) {
      Ok(bytes) => Ok(serde_json::from_slice(&bytes).context("Invalid profile catalog")?),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Catalog::default()),
      Err(e) => Err(e.into()),
    }
  }
  pub fn edit<T>(&self, f: impl FnOnce(&mut Catalog) -> Result<T>) -> Result<T> {
    let _lock = Lock::acquire(&self.root.join("catalog.lock"))?;
    let mut catalog = self.read()?;
    let result = f(&mut catalog)?;
    atomic_json(&self.root.join("catalog.json"), &catalog)?;
    Ok(result)
  }
  pub fn resolve(&self, app: &str, alias: &str) -> Result<Profile> {
    component(app)?;
    let alias = alias.trim_start_matches('@');
    component(alias)?;
    self
      .read()?
      .profiles
      .into_iter()
      .find(|p| p.app == app && (p.alias == alias || p.id == alias))
      .context("Unknown profile; use profiles list")
  }
  /// Import references idempotently; discovery never asserts account identity.
  pub fn register(&self, app: &str, alias: &str, credential: CredentialRef) -> Result<Profile> {
    component(app)?;
    component(alias)?;
    self.edit(|c| c.register(app, alias, credential))
  }
  /// Merge one provider declaration, idempotently. An existing alias must
  /// keep its credential reference (and its ID, when the declaration names
  /// one); a new alias takes the declared ID if it is free, else a new one.
  /// Identity and state are the catalog's, never the declaration's.
  pub fn declare(&self, app: &str, declared: &Declared) -> Result<Profile> {
    component(app)?;
    component(&declared.alias)?;
    ensure!(
      declared.app.as_deref().is_none_or(|a| a == app),
      "Provider declared a profile for another app"
    );
    if let Some(id) = &declared.id {
      component(id)?;
    }
    self.edit(|c| {
      if let Some(p) = c
        .profiles
        .iter()
        .find(|p| p.app == app && p.alias == declared.alias)
      {
        ensure!(
          p.credential == declared.credential,
          "Profile alias already refers to another credential store"
        );
        ensure!(
          declared.id.as_ref().is_none_or(|id| *id == p.id),
          "Provider declared another ID for an existing profile"
        );
        return Ok(p.clone());
      }
      let id = match &declared.id {
        Some(id) => {
          ensure!(
            !c.profiles.iter().any(|p| p.app == app && p.id == *id),
            "Provider declared an ID that belongs to another profile"
          );
          id.clone()
        }
        None => random_id()?,
      };
      let p = Profile {
        app: app.into(),
        id,
        alias: declared.alias.clone(),
        credential: declared.credential.clone(),
        identity: None,
        state: AuthState::Unverified,
      };
      c.profiles.push(p.clone());
      Ok(p)
    })
  }
  pub fn confirm(&self, app: &str, id: &str, identity: Identity) -> Result<Profile> {
    ensure!(
      !identity.id.is_empty(),
      "Provider returned no account identity"
    );
    self.edit(|c| {
      let p = c
        .profiles
        .iter_mut()
        .find(|p| p.app == app && p.id == id)
        .context("Unknown profile")?;
      if let Some(expected) = &p.identity {
        ensure!(
          expected.id == identity.id,
          "Account identity mismatch; previous binding retained"
        );
      }
      p.identity = Some(identity);
      p.state = AuthState::Ready;
      Ok(p.clone())
    })
  }
  pub fn set_default(&self, profile: &Profile) -> Result<()> {
    self.edit(|c| {
      c.defaults.insert(profile.app.clone(), profile.id.clone());
      Ok(())
    })
  }
  pub fn default_for(&self, app: &str) -> Result<Option<Profile>> {
    Ok(self.read()?.default_for(app).cloned())
  }
  /// Where a core-owned (`Local`) profile keeps its credentials:
  /// `<root>/<app>/<id>`. `None` for native, vault and delegated backends,
  /// whose stores the app does not own through the catalog.
  pub fn credential_dir(&self, profile: &Profile) -> Result<Option<PathBuf>> {
    component(&profile.app)?;
    component(&profile.id)?;
    Ok(
      matches!(profile.credential, CredentialRef::Local { .. })
        .then(|| self.root.join(&profile.app).join(&profile.id)),
    )
  }
  pub fn credential(&self, profile: &Profile) -> Result<CredentialStore> {
    let dir = self
      .credential_dir(profile)?
      .context("Credential refresh is owned by the native/delegated backend")?;
    Ok(CredentialStore { dir })
  }
  pub fn conversation_lock(&self, app: &str, conversation: &str) -> Result<Lock> {
    use sha2::{Digest, Sha256};
    component(app)?;
    Lock::try_acquire(&self.root.join("conversations").join(app).join(format!(
      "{}.lock",
      hex::encode(Sha256::digest(conversation.as_bytes()))
    )))
  }
}
#[derive(Clone, Debug)]
pub struct CredentialStore {
  pub dir: PathBuf,
}
impl CredentialStore {
  /// The store in a directory the shell passed; it must be absolute.
  pub fn at(dir: impl Into<PathBuf>) -> Result<Self> {
    let dir = dir.into();
    ensure!(dir.is_absolute(), "Credential directory must be absolute");
    Ok(Self { dir })
  }
  pub fn dir(&self) -> &Path {
    &self.dir
  }
}
#[derive(Serialize, Deserialize)]
pub struct Versioned<T> {
  pub version: u64,
  pub value: T,
}
pub struct CredentialTransaction {
  _lock: Lock,
  path: PathBuf,
}
impl CredentialStore {
  /// Hold through refresh and persistence. Reread inside the lock, even after
  /// waiting for another process: it may have rotated the refresh token.
  pub fn transaction(&self) -> Result<CredentialTransaction> {
    Ok(CredentialTransaction {
      _lock: Lock::acquire(&self.dir.join("refresh.lock"))?,
      path: self.dir.join("credentials.json"),
    })
  }
}
impl CredentialTransaction {
  pub fn read<T: DeserializeOwned>(&self) -> Result<Option<Versioned<T>>> {
    match fs::read(&self.path) {
      Ok(bytes) => Ok(Some(
        serde_json::from_slice(&Zeroizing::new(bytes)).context("Invalid saved credentials")?,
      )),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
      Err(e) => Err(e.into()),
    }
  }
  pub fn save<T: Serialize>(&self, value: &T) -> Result<u64> {
    let previous: Option<Versioned<serde_json::Value>> = self.read()?;
    let version = previous.map_or(1, |v| v.version + 1);
    atomic_json(&self.path, &Versioned { version, value })?;
    Ok(version)
  }
}
/// Metadata-only launch plan. Environment values are credential REFERENCES,
/// never bearer tokens. Login is a separate terminal process.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Launch {
  #[serde(default)]
  pub env: BTreeMap<String, String>,
  #[serde(default)]
  pub remove_env: Vec<String>,
  #[serde(default)]
  pub argv: Vec<String>,
  #[serde(default)]
  pub resume: bool,
  #[serde(default)]
  pub exclusive_conversation: Option<String>,
  #[serde(default)]
  pub rebind_between_calls: bool,
}
impl Launch {
  /// Bind this plan to a catalog profile: the shell's references overwrite
  /// whatever the provider set under the same names. A profile without a
  /// core-owned credential directory removes the variable, so a stale value
  /// inherited from the parent environment never reaches the app.
  pub fn bind(&mut self, registry: &Registry, profile: &Profile) -> Result<()> {
    self.env.insert(ENV_APP.into(), profile.app.clone());
    self.env.insert(ENV_PROFILE_ID.into(), profile.id.clone());
    match registry.credential_dir(profile)? {
      Some(dir) => {
        self
          .env
          .insert(ENV_CREDENTIAL_DIR.into(), dir.to_string_lossy().into());
        self.remove_env.retain(|key| key != ENV_CREDENTIAL_DIR);
      }
      None => {
        self.env.remove(ENV_CREDENTIAL_DIR);
        if !self.remove_env.iter().any(|key| key == ENV_CREDENTIAL_DIR) {
          self.remove_env.push(ENV_CREDENTIAL_DIR.into());
        }
      }
    }
    Ok(())
  }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Binding {
  pub profile: Profile,
  pub launch: Launch,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Instance {
  #[serde(default)]
  pub active: Option<Binding>,
  #[serde(default)]
  pub pending: Option<String>,
  #[serde(default)]
  pub recovery: Option<String>,
  #[serde(default)]
  pub blocked: bool,
}
impl Instance {
  pub fn read(pane: &Path) -> Result<Self> {
    match fs::read(pane.join("auth-profile.json")) {
      Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
      Err(e) => Err(e.into()),
    }
  }
  pub fn write(&self, pane: &Path) -> Result<()> {
    atomic_json(&pane.join("auth-profile.json"), self)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[cfg(unix)]
  use std::os::unix::fs::PermissionsExt;
  #[test]
  fn aliases_are_app_scoped_and_identity_is_immutable() {
    let dir = tempfile::tempdir().unwrap();
    let reg = Registry::at(dir.path());
    let a = reg
      .register(
        "one",
        "james",
        CredentialRef::Native {
          locator: "/native/one".into(),
        },
      )
      .unwrap();
    let b = reg
      .register(
        "two",
        "james",
        CredentialRef::Local {
          key: "session".into(),
        },
      )
      .unwrap();
    assert_ne!(a.id, b.id);
    assert_eq!(reg.resolve("one", "@james").unwrap().id, a.id);
    reg
      .confirm(
        "one",
        &a.id,
        Identity {
          id: "account1".into(),
          label: "James".into(),
        },
      )
      .unwrap();
    assert!(
      reg
        .confirm(
          "one",
          &a.id,
          Identity {
            id: "account2".into(),
            label: "James".into()
          }
        )
        .is_err()
    );
    assert!(reg.credential(&a).is_err());
    assert!(
      reg
        .register("../escape", "x", CredentialRef::Local { key: "x".into() })
        .is_err()
    );
    reg.set_default(&b).unwrap();
    assert!(reg.default_for("one").unwrap().is_none());
    assert_eq!(reg.default_for("two").unwrap().unwrap().id, b.id);
  }
  #[test]
  fn transactions_reread_and_serialize_refresh_without_catalog_leaks() {
    let dir = tempfile::tempdir().unwrap();
    let reg = Registry::at(dir.path());
    let p = reg
      .register(
        "fixture",
        "a",
        CredentialRef::Local {
          key: "session".into(),
        },
      )
      .unwrap();
    let store = reg.credential(&p).unwrap();
    store
      .transaction()
      .unwrap()
      .save(&serde_json::json!({"token":"SENTINEL_SECRET","expired":true}))
      .unwrap();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut threads = vec![];
    for _ in 0..8 {
      let store = store.clone();
      let calls = calls.clone();
      threads.push(std::thread::spawn(move || {
        let tx = store.transaction().unwrap();
        let mut value = tx.read::<serde_json::Value>().unwrap().unwrap().value;
        if value["expired"] == true {
          calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
          value["expired"] = false.into();
          tx.save(&value).unwrap();
        }
      }));
    }
    for thread in threads {
      thread.join().unwrap();
    }
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
      store
        .transaction()
        .unwrap()
        .read::<serde_json::Value>()
        .unwrap()
        .unwrap()
        .version,
      2
    );
    let cat = std::fs::read_to_string(reg.root.join("catalog.json")).unwrap();
    assert!(!cat.contains("SENTINEL_SECRET"));
    assert_eq!(
      std::fs::metadata(store.dir.join("credentials.json"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777,
      0o600
    );
  }
  fn local() -> CredentialRef {
    CredentialRef::Local {
      key: "session".into(),
    }
  }
  fn declared(alias: &str, id: Option<&str>) -> Declared {
    Declared {
      app: None,
      id: id.map(str::to_owned),
      alias: alias.into(),
      credential: local(),
    }
  }
  #[test]
  fn declarations_merge_idempotently_and_the_shell_assigns_missing_ids() {
    let dir = tempfile::tempdir().unwrap();
    let reg = Registry::at(dir.path());
    let a = reg.declare("fixture", &declared("default", None)).unwrap();
    assert_eq!(a.state, AuthState::Unverified);
    component(&a.id).unwrap();
    // Rediscovery is a no-op: same ID, no second entry.
    assert_eq!(
      reg
        .declare("fixture", &declared("default", None))
        .unwrap()
        .id,
      a.id
    );
    // A provider that wrote the catalog itself returns the catalog's own ID.
    assert_eq!(
      reg
        .declare("fixture", &Declared::from(a.clone()))
        .unwrap()
        .id,
      a.id
    );
    // A new alias keeps a provider-chosen ID when it is free.
    let b = reg
      .declare("fixture", &declared("work", Some("chosen")))
      .unwrap();
    assert_eq!(b.id, "chosen");
    assert_eq!(reg.read().unwrap().profiles.len(), 2);
    // Identity is never taken from a declaration; confirmation survives it.
    reg
      .confirm(
        "fixture",
        &a.id,
        Identity {
          id: "account-1".into(),
          label: "Fixture".into(),
        },
      )
      .unwrap();
    let again = reg.declare("fixture", &declared("default", None)).unwrap();
    assert_eq!(again.state, AuthState::Ready);
    assert!(again.identity.is_some());
    // Conflicts fail rather than rebinding a profile.
    let other = Declared {
      credential: CredentialRef::Native {
        locator: "/elsewhere".into(),
      },
      ..declared("default", None)
    };
    assert!(reg.declare("fixture", &other).is_err());
    assert!(
      reg
        .declare("fixture", &declared("default", Some("other")))
        .is_err()
    );
    assert!(
      reg
        .declare("fixture", &declared("third", Some("chosen")))
        .is_err()
    );
    assert!(
      reg
        .declare(
          "fixture",
          &Declared {
            app: Some("another".into()),
            ..declared("x", None)
          }
        )
        .is_err()
    );
    assert!(reg.declare("fixture", &declared("../x", None)).is_err());
    assert_eq!(reg.read().unwrap().profiles.len(), 2);
  }
  #[test]
  fn bindings_pass_the_credential_directory_as_a_reference_only_for_local_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let reg = Registry::at(dir.path());
    let local = reg.declare("fixture", &declared("a", None)).unwrap();
    let store = reg.credential(&local).unwrap();
    store
      .transaction()
      .unwrap()
      .save(&serde_json::json!({"token":"SENTINEL_SECRET"}))
      .unwrap();
    let mut launch = Launch {
      env: BTreeMap::from([(ENV_PROFILE_ID.into(), "provider-said".into())]),
      remove_env: vec![ENV_CREDENTIAL_DIR.into()],
      ..Default::default()
    };
    launch.bind(&reg, &local).unwrap();
    assert_eq!(launch.env[ENV_APP], "fixture");
    assert_eq!(launch.env[ENV_PROFILE_ID], local.id);
    assert_eq!(
      Path::new(&launch.env[ENV_CREDENTIAL_DIR]),
      dir.path().join("fixture").join(&local.id)
    );
    assert_eq!(Path::new(&launch.env[ENV_CREDENTIAL_DIR]), store.dir);
    assert!(!launch.remove_env.iter().any(|k| k == ENV_CREDENTIAL_DIR));
    assert!(
      !serde_json::to_string(&launch)
        .unwrap()
        .contains("SENTINEL_SECRET")
    );

    let native = reg
      .declare(
        "fixture",
        &Declared {
          credential: CredentialRef::Native {
            locator: "/native".into(),
          },
          ..declared("b", None)
        },
      )
      .unwrap();
    let mut launch = Launch {
      env: BTreeMap::from([(ENV_CREDENTIAL_DIR.into(), "/stale".into())]),
      ..Default::default()
    };
    launch.bind(&reg, &native).unwrap();
    assert!(!launch.env.contains_key(ENV_CREDENTIAL_DIR));
    assert!(launch.remove_env.iter().any(|k| k == ENV_CREDENTIAL_DIR));
    assert_eq!(reg.credential_dir(&native).unwrap(), None);
  }
  #[test]
  fn conversation_lease_excludes_other_instances_but_not_other_conversations() {
    let dir = tempfile::tempdir().unwrap();
    let reg = Registry::at(dir.path());
    let first = reg.conversation_lock("app", "conversation1").unwrap();
    assert!(reg.conversation_lock("app", "conversation1").is_err());
    assert!(reg.conversation_lock("app", "conversation2").is_ok());
    drop(first);
    assert!(reg.conversation_lock("app", "conversation1").is_ok());
  }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderRequest {
  pub version: u32,
  pub operation: String,
  pub app: String,
  #[serde(default)]
  pub alias: Option<String>,
  #[serde(default)]
  pub profile: Option<Profile>,
  #[serde(default)]
  pub conversation: Option<String>,
  #[serde(default)]
  pub cwd: Option<PathBuf>,
  #[serde(default)]
  pub source_env: BTreeMap<String, String>,
  #[serde(default)]
  pub arguments: Vec<String>,
  /// The profile's core-owned credential directory, when `profile` is a
  /// `Local` one: the same path the launch binding passes as
  /// `TSH_AUTH_CREDENTIAL_DIR`. The provider reads and refreshes credentials
  /// there instead of computing a store root of its own.
  #[serde(default)]
  pub credential_dir: Option<PathBuf>,
}
impl ProviderRequest {
  pub fn new(operation: &str, app: &str) -> Self {
    Self {
      version: 1,
      operation: operation.into(),
      app: app.into(),
      alias: None,
      profile: None,
      conversation: None,
      cwd: None,
      source_env: BTreeMap::new(),
      arguments: Vec::new(),
      credential_dir: None,
    }
  }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProviderResponse {
  /// Profiles the provider declares; the shell merges them into the catalog
  /// with [`Registry::declare`].
  #[serde(default)]
  pub profiles: Vec<Declared>,
  #[serde(default)]
  pub identity: Option<Identity>,
  #[serde(default)]
  pub launch: Option<Launch>,
  #[serde(default)]
  pub error: Option<String>,
}

/// The app half's names for the wire messages.
pub type Request = ProviderRequest;
pub type Response = ProviderResponse;

/// An unguessable one-time value, e.g. an OAuth `state`.
pub fn challenge_id() -> Result<String> {
  random_id()
}
