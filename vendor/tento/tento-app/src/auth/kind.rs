//! The executor for `account.kind/v1`: one generic provider that runs any
//! app's account recipe.
//!
//! An executable `auth.provider/v1` bundle answers each request in its own
//! process. A kind is data, so the shell answers the same requests itself,
//! in-process, with the eight operations every provider needed anyway:
//!
//! - a private per-account config directory, with shared entries linked in;
//! - environment set and removed, and the argv, from templates;
//! - reading a native secret (keychain item or JSON file, then a pointer);
//! - an identity check: a precheck command, an HTTPS endpoint called with
//!   that secret as a bearer (sent on curl's stdin, never its argv), or a
//!   JSON file the app writes;
//! - settings files that must not override the selected account;
//! - exact-resume parsing, the history check, and the busy probe;
//! - an import of a legacy account table, and of the default it points at.
//!
//! None of them names an app. The answers keep the executable wire's error
//! codes (`login_required`, `identity_mismatch`, `history_missing`, `busy`,
//! `auth_override`, `network`, `unsupported`), so callers see one contract.
//!
//! Vault credentials are refused here: materializing one goes through the
//! shell's audited secret mint (design commit 7, held for security review).
use anyhow::{Context, Result, bail, ensure};
use std::{
  collections::BTreeMap,
  io::{Read, Write},
  path::{Path, PathBuf},
  process::{Command, Stdio},
  time::{Duration, Instant},
};
use tento_secrets::Secret;
use tento_secrets::accounts::kind::{
  AccountKind, Busy, ExpectedLabel, KindCredential, NativeLogin, SecretSource, Vars,
  checked_path, names_placeholder, native_alias,
};
use tento_secrets::accounts::{
  self as profiles, Binding, CredentialRef, Identity, Launch, Profile, Registry,
};
use tento_secrets::store::{SecretsBase, candidate_base_dirs_with};

use super::{Request, Response};

/// How long one probe (precheck, busy, keychain lookup, identity request)
/// may take, from start to its last byte of output, and never past its
/// request's [`Deadline`].
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// How long one request may take, every probe it runs included.
const CHECK_TIMEOUT: Duration = Duration::from_secs(45);
/// How long past its deadline a request's thread is waited for. No probe
/// outlives the deadline or starts after it, so only a thread stalled
/// outside any probe (a catalog lock, a slow disk) is ever abandoned.
const STALL_GRACE: Duration = Duration::from_secs(5);
/// Probe output beyond this is refused.
const PROBE_LIMIT: u64 = 1024 * 1024;

/// A request missed its [`Deadline`]; the caller's profile is untouched.
#[derive(Debug)]
struct CheckTimedOut;

impl std::fmt::Display for CheckTimedOut {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("Account check timed out; profile unchanged")
  }
}

impl std::error::Error for CheckTimedOut {}

/// A probe reached its `deadline` before it answered, or was not started
/// because the deadline had already passed.
#[derive(Debug)]
struct ProbeTimedOut {
  name: String,
  deadline: Instant,
}

impl std::fmt::Display for ProbeTimedOut {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{} did not answer in time", self.name)
  }
}

impl std::error::Error for ProbeTimedOut {}

/// When a request must be answered. Every probe the request runs shares it:
/// each ends by then, and none starts after it.
#[derive(Clone, Copy, Debug)]
struct Deadline(Instant);

impl Deadline {
  fn after(budget: Duration) -> Self {
    Self(Instant::now() + budget)
  }

  /// When a probe starting now must end: its own [`PROBE_TIMEOUT`], cut
  /// short by the request's deadline. Once that has passed, no probe starts.
  fn probe(self) -> Result<Instant> {
    let now = Instant::now();
    ensure!(now < self.0, CheckTimedOut);
    Ok((now + PROBE_TIMEOUT).min(self.0))
  }

  /// A probe's failure, as the request's timeout when the probe ran out of
  /// the request's time rather than its own budget. Every other failure
  /// keeps its own error, whenever it is seen.
  fn blame(self, error: anyhow::Error) -> anyhow::Error {
    match error.downcast_ref::<ProbeTimedOut>() {
      Some(expired) if expired.deadline >= self.0 => CheckTimedOut.into(),
      _ => error,
    }
  }
}

/// What the executor reads from its surroundings. The shell builds it from
/// the process ([`KindHost::from_process`]); tests build it from a sandbox,
/// so nothing reads the real home, environment or keychain.
#[derive(Clone, Debug)]
pub struct KindHost {
  pub home: PathBuf,
  /// Variables a kind may consult: its `cli.env`, its credential root's
  /// `env`, `PATH`, and the resume `source_env` capture.
  pub vars: BTreeMap<String, String>,
  /// The environment probe commands start from. `None` inherits the
  /// process environment.
  pub child_env: Option<BTreeMap<String, String>>,
  /// The working directory when a request names none.
  pub cwd: PathBuf,
  /// The keychain tool (`/usr/bin/security` on macOS), if any.
  pub keychain: Option<PathBuf>,
  /// The keychain account; `/usr/bin/id -un` when unset.
  pub user: Option<String>,
  /// The HTTP client used for identity endpoints.
  pub curl: PathBuf,
}

impl KindHost {
  /// The shell's own surroundings: the declared session environment when one
  /// is installed (the same environment an executable provider is given),
  /// else the process environment.
  pub fn from_process() -> Result<Self> {
    // Lookups see the declared value when there is one, else the process's
    // (a bare install declares no PATH); children get exactly the declared
    // environment, as an executable provider's child does.
    let mut vars: BTreeMap<String, String> = std::env::vars().collect();
    let child_env = tento_env::hermetic_child_env().map(|declared| {
      let map: BTreeMap<String, String> = declared.into_iter().collect();
      vars.extend(map.clone());
      map
    });
    let home = vars
      .get("HOME")
      .filter(|h| !h.is_empty())
      .map(PathBuf::from)
      .context("HOME unavailable")?;
    let keychain = Path::new("/usr/bin/security");
    Ok(Self {
      home,
      vars,
      child_env,
      cwd: std::env::current_dir()?,
      keychain: keychain.exists().then(|| keychain.to_path_buf()),
      user: None,
      curl: PathBuf::from("/usr/bin/curl"),
    })
  }

  fn var(&self, key: &str) -> Option<&str> {
    self
      .vars
      .get(key)
      .map(String::as_str)
      .filter(|v| !v.is_empty())
  }

  fn command(&self, program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    if let Some(env) = &self.child_env {
      cmd.env_clear().envs(env);
    }
    cmd
  }
}

/// Where a kind keeps an app's accounts, and why there.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct StoreChoice {
  pub root: PathBuf,
  /// `variable <NAME>`, `default root`, `fallback in the <secrets base>`,
  /// `default root (no store yet)`, `native login`, or `catalog profile locator`.
  pub source: String,
  /// The file that made a fallback the store.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub marker: Option<String>,
}

/// A kind, ready to answer provider requests for its app.
#[derive(Clone, Debug)]
pub struct KindProvider {
  pub kind: AccountKind,
  pub host: KindHost,
}

/// Which account a verification found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
  Confirmed(Identity),
  /// Signed in, but the kind offers no way to learn which account.
  Unverified,
  LoginRequired,
}

/// An error whose message is a wire code.
fn error_code(error: &anyhow::Error) -> Option<&'static str> {
  match error.to_string().as_str() {
    "network" => Some("network"),
    "auth_override" => Some("auth_override"),
    "identity_mismatch" => Some("identity_mismatch"),
    _ => None,
  }
}

impl KindProvider {
  pub fn new(kind: AccountKind, host: KindHost) -> Self {
    Self { kind, host }
  }

  pub fn app(&self) -> &str {
    &self.kind.app
  }

  /// Whether a prepared account must come back with a confirmed identity.
  fn requires_identity(&self) -> bool {
    self.kind.verify.as_ref().is_some_and(|v| v.http.is_some())
  }

  fn base_vars(&self) -> Vars {
    Vars::new()
      .with("home", self.host.home.to_string_lossy())
      .with("app", self.kind.app.clone())
  }

  /// The native credential root: the kind's variable when set, else its
  /// default, unless the default does not exist yet and a fallback store
  /// (the first whose marker is a file) does.
  fn native_root(&self) -> Result<Option<PathBuf>> {
    Ok(self.root_choice()?.map(|choice| choice.root))
  }

  /// [`Self::native_root`], with why that root was chosen.
  pub fn root_choice(&self) -> Result<Option<StoreChoice>> {
    let KindCredential::Native { root, .. } = &self.kind.credential else {
      return Ok(None);
    };
    let choice = match root.env.as_deref().and_then(|env| {
      self
        .host
        .var(env)
        .map(|value| (env.to_owned(), value.to_owned()))
    }) {
      Some((env, value)) => StoreChoice {
        root: PathBuf::from(value),
        source: format!("variable {env}"),
        marker: None,
      },
      None => self.default_or_fallback(root)?,
    };
    checked_path(&choice.root)?;
    Ok(Some(choice))
  }

  fn default_or_fallback(
    &self,
    root: &tento_secrets::accounts::kind::Setting,
  ) -> Result<StoreChoice> {
    let vars = self.base_vars();
    let default = vars.expand_path(&root.default)?;
    if default.exists() {
      return Ok(StoreChoice {
        root: default,
        source: "default root".into(),
        marker: None,
      });
    }
    let mut bases = None;
    for fallback in &root.fallback {
      // A path under a secret-store base is tried under each base, in the
      // store's own order; any other path once.
      let tries: Vec<(PathBuf, Option<&'static str>)> =
        if names_placeholder(&fallback.path, "secrets") {
          bases
            .get_or_insert_with(|| self.secrets_bases())
            .iter()
            .map(|base: &SecretsBase| {
              vars
                .clone()
                .with("secrets", base.path.to_string_lossy())
                .expand_path(&fallback.path)
                .map(|path| (path, Some(base.source)))
            })
            .collect::<Result<_>>()?
        } else {
          vec![(vars.expand_path(&fallback.path)?, None)]
        };
      for (store, base) in tries {
        if store.join(&fallback.marker).is_file() {
          return Ok(StoreChoice {
            root: store,
            source: match base {
              Some(base) => format!("fallback in the {base}"),
              None => "fallback".into(),
            },
            marker: Some(fallback.marker.clone()),
          });
        }
      }
    }
    Ok(StoreChoice {
      root: default,
      source: "default root (no store yet)".into(),
      marker: None,
    })
  }

  /// The host's secret-store bases, in the store's order, existing only.
  fn secrets_bases(&self) -> Vec<SecretsBase> {
    let home = self.host.home.to_string_lossy().into_owned();
    candidate_base_dirs_with(
      |name| match name {
        "HOME" => Some(home.clone()),
        name => self.host.var(name).map(str::to_owned),
      },
      |path| path.exists(),
    )
  }

  /// The app's own login, when the kind declares one.
  fn native_login(&self) -> Option<&NativeLogin> {
    self.kind.import.as_ref().and_then(|i| i.native.as_ref())
  }

  /// The app's own login when `profile` is it: a native profile at the
  /// declared locator.
  fn native_profile(&self, profile: &Profile) -> Result<Option<&NativeLogin>> {
    let (Some(native), CredentialRef::Native { locator }) =
      (self.native_login(), &profile.credential)
    else {
      return Ok(None);
    };
    Ok((self.base_vars().expand_path(&native.locator)? == *locator).then_some(native))
  }

  /// Where `profile`'s account lives and why: the app's own login, or the
  /// store the kind chose. `None` for a kind with no native store.
  pub fn store_for(&self, profile: &Profile) -> Result<Option<StoreChoice>> {
    if self.native_profile(profile)?.is_some() {
      let CredentialRef::Native { locator } = &profile.credential else {
        unreachable!("a native login is a native profile")
      };
      return Ok(Some(StoreChoice {
        root: locator.clone(),
        source: "native login".into(),
        marker: None,
      }));
    }
    let choice = self.root_choice()?;
    if let (Some(store), CredentialRef::Native { locator }) = (&choice, &profile.credential) {
      if !locator.starts_with(&store.root) {
        // Root selection governs new accounts. Existing profiles keep the
        // locator saved in the catalog, which is also what launch_with uses.
        checked_path(locator)?;
        return Ok(Some(StoreChoice {
          root: locator.clone(),
          source: "catalog profile locator".into(),
          marker: None,
        }));
      }
    }
    Ok(choice)
  }

  fn locator_vars(&self) -> Result<Vars> {
    let mut vars = self.base_vars();
    if let Some(root) = self.native_root()? {
      vars.set("root", root.to_string_lossy());
    }
    Ok(vars)
  }

  /// The app's executable: the kind's variable (which must name a file),
  /// then its name on `PATH`, then its fallbacks.
  pub fn cli(&self) -> Result<PathBuf> {
    let cli = &self.kind.cli;
    if let Some(env) = &cli.env {
      if let Some(named) = self.host.var(env) {
        let path = PathBuf::from(named);
        ensure!(path.is_file(), "{env} does not name a file");
        return Ok(path);
      }
    }
    if let Some(paths) = self.host.var("PATH") {
      if let Some(found) = std::env::split_paths(paths)
        .map(|dir| dir.join(&cli.name))
        .find(|candidate| candidate.is_file())
      {
        return Ok(found);
      }
    }
    let vars = self.base_vars();
    for fallback in &cli.fallback {
      let path = vars.expand_path(fallback)?;
      if path.is_file() {
        return Ok(path);
      }
    }
    bail!("{} CLI unavailable", cli.name)
  }

  /// The credential a new alias gets.
  fn credential_for(&self, alias: &str) -> Result<CredentialRef> {
    Ok(match &self.kind.credential {
      KindCredential::Native { locator, .. } => CredentialRef::Native {
        locator: self
          .locator_vars()?
          .with("alias", alias)
          .expand_path(locator)?,
      },
      KindCredential::Vault {
        namespace, name, ..
      } => CredentialRef::Vault {
        address: format!(
          "{namespace}/{}",
          Vars::new().with("alias", alias).expand(name)?
        ),
      },
      KindCredential::Local => CredentialRef::Local {
        key: "session".into(),
      },
    })
  }

  /// Import the legacy account table; a missing file is no table. A row the
  /// kind's default pointer names becomes the app's default.
  fn import(&self, registry: &Registry) -> Result<()> {
    let Some(import) = &self.kind.import else {
      return Ok(());
    };
    let vars = self.locator_vars()?;
    // A missing or unreadable pointer names no row.
    let pointer = match &import.default_from {
      Some(file) => std::fs::read_to_string(vars.expand_path(file)?).unwrap_or_default(),
      None => String::new(),
    };
    // A missing or unreadable table is no table, as it always was; with no
    // table, the app's own login is the one account there is.
    let table = vars.expand_path(&import.tsv)?;
    let Ok(text) = std::fs::read_to_string(&table) else {
      return self.import_native(registry, &table);
    };
    let pointer = pointer.trim();
    let mut default_by_key = None;
    let mut default_by_alias = None;
    for row in text.lines().filter(|l| !l.starts_with('#')) {
      let Some((key, alias)) = row.split_once('\t') else {
        continue;
      };
      let alias = alias.trim().trim_start_matches('@');
      if profiles::component(alias).is_err() || key.contains('/') || key.contains("..") {
        continue;
      }
      let locator = vars.clone().with("key", key).expand_path(&import.locator)?;
      let profile = registry.register(&self.kind.app, alias, CredentialRef::Native { locator })?;
      if !pointer.is_empty() {
        if !pointer.starts_with('@') && pointer == key {
          default_by_key = Some(profile.clone());
        }
        if pointer.trim_start_matches('@') == alias {
          default_by_alias = Some(profile);
        }
      }
    }
    // Resolve against the whole table: a store key wins over another row's
    // alias, while an explicit @alias selects only by alias. Setting inside
    // the row loop made the last matching row silently select the account.
    if let Some(profile) = default_by_key.or(default_by_alias) {
      if registry
        .default_for(&self.kind.app)?
        .is_none_or(|current| current.id != profile.id)
      {
        registry.set_default(&profile)?;
      }
    }
    Ok(())
  }

  /// Register the app's own login as a profile, once: only while the import
  /// `table` does not exist, no profile has its locator, and the app has been
  /// used. It becomes the app's default when the app has none. Nothing of the
  /// app's is written.
  ///
  /// The catalog half is one [`Registry::edit`]: whether the login is still
  /// unimported, which alias is free, the registration, and whether the app
  /// has a default are all decided under the catalog lock, so a default
  /// another session chooses meanwhile is seen, never overwritten.
  fn import_native(&self, registry: &Registry, table: &Path) -> Result<()> {
    let Some(native) = self.native_login() else {
      return Ok(());
    };
    let vars = self.base_vars();
    let credential = CredentialRef::Native {
      locator: vars.expand_path(&native.locator)?,
    };
    let present = native
      .present
      .iter()
      .map(|file| vars.expand_path(file))
      .collect::<Result<Vec<_>>>()?;
    let applies = || !table.exists() && present.iter().all(|file| file.exists());
    let app = self.kind.app.as_str();
    let imported = |catalog: &profiles::Catalog| {
      catalog
        .profiles
        .iter()
        .any(|p| p.app == app && p.credential == credential)
    };
    // The common case, already imported, takes no lock and writes nothing.
    if !applies() || imported(&registry.read()?) {
      return Ok(());
    }
    // Only read, and only a cached name: never a secret, never the network.
    let cached = self.cached_account(native)?;
    registry.edit(|catalog| {
      // Rechecked under the lock: another session may have imported it, or
      // the app's files may have changed, since the look above.
      if !applies() || imported(catalog) {
        return Ok(());
      }
      let Some(alias) = cached
        .as_deref()
        .and_then(native_alias)
        .into_iter()
        .chain([native.default_alias.clone()])
        .find(|alias| {
          !catalog
            .profiles
            .iter()
            .any(|p| p.app == app && p.alias == *alias)
        })
      else {
        return Ok(());
      };
      let profile = catalog.register(app, &alias, credential.clone())?;
      // Only a login the app has named an account for (a real sign-in) is
      // made the default; an unnamed one is there to pick, never imposed.
      if cached.is_some() && catalog.default_for(app).is_none() {
        #[cfg(all(test, unix))]
        tests::before_native_default();
        catalog.defaults.insert(app.to_owned(), profile.id);
      }
      Ok(())
    })
  }

  /// The account name the app caches for its own login, if it has one. Only
  /// read, never a secret, never the network.
  fn cached_account(&self, native: &NativeLogin) -> Result<Option<String>> {
    let Some(from) = &native.alias_from else {
      return Ok(None);
    };
    Ok(
      std::fs::read(self.base_vars().expand_path(&from.file)?)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
          value
            .pointer(&from.json_pointer)
            .and_then(|v| v.as_str())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
        }),
    )
  }

  /// The identity of the app's own login, from `verdict`, never blocking
  /// it: the login is the user's own, and the app runs on it as it would
  /// with no shell involved. An account this check cannot confirm (not
  /// signed in, a key login, no token, no network, an endpoint error), or
  /// one other than the app's cached account, is logged and not recorded;
  /// the launch is then unverified, even for a profile confirmed before
  /// (see [`Self::prepare_run`]).
  fn native_identity(
    &self,
    native: &NativeLogin,
    profile: &Profile,
    verdict: Result<Verdict>,
  ) -> Option<Identity> {
    let unverified = |reason: &str| {
      tracing::warn!(
        app = %self.kind.app,
        profile = %profile.alias,
        %reason,
        "the app's own login is not verified; it runs as it is"
      );
      None
    };
    match verdict {
      Ok(Verdict::Confirmed(identity)) => match self.cached_account(native) {
        Ok(Some(cached)) if !cached.eq_ignore_ascii_case(&identity.label) => unverified(&format!(
          "identity mismatch: the token is {}'s, the app's cache names {cached}",
          identity.label
        )),
        _ => Some(identity),
      },
      Ok(Verdict::Unverified) => None,
      Ok(Verdict::LoginRequired) => unverified("not signed in to an account this check can name"),
      Err(error) => unverified(&format!("{error:#}")),
    }
  }

  /// The catalog's profiles for this app, after the legacy import.
  pub fn profiles(&self, registry: &Registry) -> Result<Vec<Profile>> {
    self.import(registry)?;
    Ok(
      registry
        .read()?
        .profiles
        .into_iter()
        .filter(|p| p.app == self.kind.app)
        .collect(),
    )
  }

  /// A new alias, registered with the kind's credential; a native locator
  /// is created private.
  pub fn register_alias(&self, registry: &Registry, alias: &str) -> Result<Profile> {
    let alias = alias.trim_start_matches('@');
    profiles::component(alias)?;
    let profile = registry.register(&self.kind.app, alias, self.credential_for(alias)?)?;
    if let CredentialRef::Native { locator } = &profile.credential {
      profiles::private_dir(locator)?;
    }
    Ok(profile)
  }

  /// Every placeholder a profile's launch can use.
  fn profile_vars(&self, registry: &Registry, profile: &Profile, cli: &Path) -> Result<Vars> {
    ensure!(profile.app == self.kind.app, "Profile app mismatch");
    profiles::component(&profile.id)?;
    let mut vars = self.locator_vars()?;
    vars
      .set("alias", profile.alias.clone())
      .set("id", profile.id.clone())
      .set(
        "profile_dir",
        registry
          .root
          .join(&self.kind.app)
          .join(&profile.id)
          .to_string_lossy(),
      )
      .set("cli", cli.to_string_lossy());
    match (&self.kind.credential, &profile.credential) {
      (KindCredential::Native { .. }, CredentialRef::Native { locator }) => {
        ensure!(
          locator.is_absolute(),
          "Native credential location must be absolute"
        );
        vars.set("locator", locator.to_string_lossy());
      }
      (KindCredential::Native { .. }, _) => bail!("Expected native credentials"),
      (KindCredential::Vault { .. }, _) => bail!(
        "Vault-backed accounts are not enabled yet: their credential goes through the secret mint, which is still in review"
      ),
      (KindCredential::Local, _) => {}
    }
    if self.native_profile(profile)?.is_some() {
      // The app's own login keeps the app's own configuration.
      if let Some(locator) = vars.get("locator").map(str::to_owned) {
        vars.set("config_dir", locator);
      }
    } else if let Some(config) = &self.kind.config_dir {
      let dir = vars.expand_path(config)?;
      vars.set("config_dir", dir.to_string_lossy());
    }
    Ok(vars)
  }

  /// The launch plan for a profile, before the shell binds its references.
  /// Creates the private config directory and links the shared entries.
  pub fn launch_for(&self, registry: &Registry, profile: &Profile) -> Result<Launch> {
    let cli = self.cli()?;
    self
      .launch_with(registry, profile, &cli)
      .map(|(launch, _)| launch)
  }

  fn launch_with(
    &self,
    registry: &Registry,
    profile: &Profile,
    cli: &Path,
  ) -> Result<(Launch, Vars)> {
    let vars = self.profile_vars(registry, profile, cli)?;
    if let Some(native) = self.native_profile(profile)? {
      return self.native_launch(native, vars);
    }
    if let Some(config) = vars.get("config_dir") {
      let config = PathBuf::from(config);
      profiles::private_dir(&config)?;
      if let Some(shared) = &self.kind.shared {
        let from = vars.expand_path(&shared.from)?;
        for name in shared.names.iter().chain(&shared.create) {
          ensure!(single_component(name), "Invalid shared entry {name:?}");
        }
        for name in &shared.names {
          shared_link(&config, &from, name)?;
        }
        // Entries shared even on a new installation: the first account
        // creates the entry, and every account (that one, and each one after
        // it, which finds the entry already there) links it, whether or not
        // `names` lists it too.
        for name in &shared.create {
          if !from.join(name).exists() {
            profiles::private_dir(&from.join(name))?;
          }
          shared_link(&config, &from, name)?;
        }
      }
    } else {
      ensure!(
        self.kind.shared.is_none(),
        "Shared entries need a config directory"
      );
    }
    let mut env = BTreeMap::new();
    for (key, template) in &self.kind.env {
      env.insert(key.clone(), vars.expand(template)?);
    }
    let argv = self
      .kind
      .argv
      .iter()
      .map(|a| vars.expand(a))
      .collect::<Result<Vec<_>>>()?;
    Ok((
      Launch {
        env,
        remove_env: self.kind.remove_env.clone(),
        argv,
        resume: self.kind.resume.is_some(),
        exclusive_conversation: None,
        rebind_between_calls: self.kind.rebind_between_calls,
      },
      vars,
    ))
  }

  /// The app's own login: the kind's launch without the variables that
  /// would move the app off it, and nothing created or linked.
  ///
  /// Its policy is its own, not the named accounts': it removes exactly
  /// `unset_env` (the variables that would point the app at another account's
  /// store) and nothing else. The kind's `remove_env` isolates a named account
  /// from the caller's authentication; the app's own login keeps that
  /// authentication (an API key, a token, a provider selection), since it is
  /// how the app runs without the shell.
  fn native_launch(&self, native: &NativeLogin, vars: Vars) -> Result<(Launch, Vars)> {
    let mut env = BTreeMap::new();
    for (key, template) in &self.kind.env {
      if !native.unset_env.contains(key) {
        env.insert(key.clone(), vars.expand(template)?);
      }
    }
    let mut remove_env: Vec<String> = Vec::new();
    for key in &native.unset_env {
      if !remove_env.contains(key) {
        remove_env.push(key.clone());
      }
    }
    let argv = self
      .kind
      .argv
      .iter()
      .map(|a| vars.expand(a))
      .collect::<Result<Vec<_>>>()?;
    Ok((
      Launch {
        env,
        remove_env,
        argv,
        resume: self.kind.resume.is_some(),
        exclusive_conversation: None,
        rebind_between_calls: self.kind.rebind_between_calls,
      },
      vars,
    ))
  }

  /// The label a login must produce, when the kind can know it in advance.
  fn expected_label(&self, profile: &Profile) -> Option<String> {
    let rule = self.kind.verify.as_ref().map(|v| &v.expected_label)?;
    match rule {
      ExpectedLabel::None => None,
      ExpectedLabel::LocatorBasenameIfEmail => match &profile.credential {
        CredentialRef::Native { locator } => locator
          .file_name()
          .and_then(|x| x.to_str())
          .filter(|x| x.contains('@'))
          .map(str::to_owned),
        _ => None,
      },
    }
  }

  /// Answer one `auth.provider/v1` request in-process: the same operations
  /// and error codes an executable provider answers with.
  pub fn run(&self, registry: &Registry, req: Request) -> Result<Response> {
    self.run_until(registry, req, Deadline::after(CHECK_TIMEOUT))
  }

  /// [`Self::run`], with every probe inside the one `deadline`.
  fn run_until(
    &self,
    registry: &Registry,
    mut req: Request,
    deadline: Deadline,
  ) -> Result<Response> {
    ensure!(
      req.version == 1 && req.app == self.kind.app,
      "Unsupported provider request"
    );
    let resume = self.kind.resume.clone().unwrap_or_default();
    // Direct CLI launches inherit the caller's native configuration. Capture
    // only the kind's named references, never arbitrary environment.
    if !req.arguments.is_empty() && req.source_env.is_empty() {
      req.source_env = resume
        .source_env
        .iter()
        .filter_map(|key| self.host.var(key).map(|v| (key.clone(), v.to_owned())))
        .collect();
    }
    let mut response = Response::default();
    match req.operation.as_str() {
      "discover" => {
        response.profiles = self
          .profiles(registry)?
          .into_iter()
          .map(Into::into)
          .collect();
        return Ok(response);
      }
      "register" => {
        let alias = req.alias.as_deref().context("Alias required")?;
        response.profiles = vec![self.register_alias(registry, alias)?.into()];
        return Ok(response);
      }
      _ => {}
    }
    let profile = req.profile.as_ref().context("Profile required")?;
    let canonical = registry.resolve(&self.kind.app, &profile.id)?;
    let cli = self.cli()?;
    let (mut launch, vars) = self.launch_with(registry, &canonical, &cli)?;
    if req.operation == "login" {
      let login = self
        .kind
        .login
        .as_ref()
        .context("This app has no login command")?;
      for arg in &login.args {
        launch.argv.push(vars.expand(arg)?);
      }
      if let Some(label) = self.expected_label(&canonical) {
        let vars = vars.clone().with("label", label);
        for arg in &login.label_args {
          launch.argv.push(vars.expand(arg)?);
        }
      }
      response.launch = Some(launch);
      return Ok(response);
    }
    let native = self.native_profile(&canonical)?;
    // The settings guards keep a named account's login from being overridden;
    // the app's own login is whatever the app's settings make it.
    if native.is_none() {
      self.check_settings(&launch, &vars, &req)?;
    }
    if !matches!(req.operation.as_str(), "prepare" | "status") {
      response.error = Some("unsupported".into());
      return Ok(response);
    }
    if req.arguments.first().is_some_and(|arg| {
      Path::new(arg).file_name().is_some() && Path::new(arg).file_name() == cli.file_name()
    }) {
      if req.arguments.iter().any(|a| resume.refuse.contains(a)) {
        response.error = Some("unsupported".into());
        return Ok(response);
      }
      for (i, arg) in req.arguments.iter().enumerate() {
        if resume.exact.contains(arg) {
          req.conversation = Some(
            req
              .arguments
              .get(i + 1)
              .filter(|s| !s.starts_with('-'))
              .context("Exact resume ID required")?
              .clone(),
          );
        } else if let Some(id) = resume
          .exact
          .iter()
          .filter(|flag| flag.starts_with("--"))
          .find_map(|flag| arg.strip_prefix(&format!("{flag}=")))
        {
          req.conversation = Some(id.into());
        }
      }
      if req.conversation.is_some()
        && req
          .arguments
          .iter()
          .any(|a| resume.refuse_with_resume.contains(a))
      {
        response.error = Some("unsupported".into());
        return Ok(response);
      }
      // Before the conversation becomes the launch's lock key: one
      // conversation, one spelling, one lock.
      self.check_conversation(&req)?;
      launch.exclusive_conversation = req.conversation.clone();
    }
    // A conversation the caller names (a lane switch) is held to the same
    // spelling before the caller locks it.
    self.check_conversation(&req)?;
    if !self.history(&vars, &req)? {
      response.error = Some("history_missing".into());
      return Ok(response);
    }
    if self.busy(&launch, &req, deadline)? {
      response.error = Some("busy".into());
      return Ok(response);
    }
    let verdict = self.verify_until(&launch, &vars, &canonical, deadline);
    if let Some(native) = native {
      response.identity = self.native_identity(native, &canonical, verdict);
      response.launch = Some(launch);
      return Ok(response);
    }
    match verdict {
      Ok(Verdict::Confirmed(identity)) => response.identity = Some(identity),
      Ok(Verdict::Unverified) => {}
      Ok(Verdict::LoginRequired) => {
        response.error = Some("login_required".into());
        return Ok(response);
      }
      Err(e) if error_code(&e) == Some("identity_mismatch") => {
        response.error = Some("identity_mismatch".into());
        return Ok(response);
      }
      Err(e) => return Err(e),
    }
    response.launch = Some(launch);
    Ok(response)
  }

  /// A probe command: the launch's program and environment, with `args`.
  fn probe(&self, launch: &Launch) -> Result<Command> {
    let mut cmd = self
      .host
      .command(launch.argv.first().context("No native CLI")?);
    cmd.envs(&launch.env);
    for key in &launch.remove_env {
      cmd.env_remove(key);
    }
    Ok(cmd)
  }

  /// Settings may customize the app, but must not override the selected
  /// account.
  fn check_settings(&self, launch: &Launch, vars: &Vars, req: &Request) -> Result<()> {
    let Some(guards) = &self.kind.guards else {
      return Ok(());
    };
    let mut paths = guards
      .files
      .iter()
      .map(|f| vars.expand_path(f))
      .collect::<Result<Vec<_>>>()?;
    let cwd = req.cwd.clone().unwrap_or_else(|| self.host.cwd.clone());
    for dir in cwd.ancestors() {
      for file in &guards.cwd_files {
        ensure!(
          Path::new(file).is_relative()
            && !Path::new(file)
              .components()
              .any(|c| matches!(c, std::path::Component::ParentDir)),
          "Invalid settings path {file:?}"
        );
        paths.push(dir.join(file));
      }
    }
    for path in paths {
      let bytes = match std::fs::read(&path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
        Err(e) => return Err(e.into()),
      };
      let value: serde_json::Value = serde_json::from_slice(&bytes).context("Invalid settings")?;
      for key in &guards.forbidden_keys {
        ensure!(value.pointer(key).is_none(), "auth_override");
      }
      if let Some(env) = guards
        .env_object
        .as_deref()
        .and_then(|p| value.pointer(p))
        .and_then(|v| v.as_object())
      {
        ensure!(
          !launch.remove_env.iter().any(|key| env.contains_key(key)),
          "auth_override"
        );
        ensure!(
          !guards.forbidden_env.iter().any(|key| env.contains_key(key)),
          "auth_override"
        );
      }
    }
    Ok(())
  }

  /// Refuse a conversation ID in any spelling but the kind's
  /// ([`tento_secrets::accounts::kind::ConversationId`]).
  fn check_conversation(&self, request: &Request) -> Result<()> {
    let (Some(sid), Some(resume)) = (&request.conversation, &self.kind.resume) else {
      return Ok(());
    };
    resume.id.check(&self.kind.app, sid)
  }

  /// Whether the conversation being resumed has a transcript this account
  /// can read. No conversation, or no history rule, is always fine.
  fn history(&self, vars: &Vars, request: &Request) -> Result<bool> {
    let Some(sid) = &request.conversation else {
      return Ok(true);
    };
    ensure!(
      !sid.is_empty() && sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
      "Invalid conversation ID"
    );
    let Some(history) = self.kind.resume.as_ref().and_then(|r| r.history.as_ref()) else {
      return Ok(true);
    };
    let dir = vars.expand_path(&history.dir)?;
    // A source config root is supported only when it shares the same store.
    // Never import or move a live transcript.
    if let Some(env) = &history.source_env {
      if let Some(source) = request.source_env.get(env) {
        let subdir = history.source_subdir.as_deref().unwrap_or("");
        if std::fs::canonicalize(Path::new(source).join(subdir)).ok()
          != std::fs::canonicalize(&dir).ok()
        {
          return Ok(false);
        }
      }
    }
    let file = vars
      .clone()
      .with("sid", sid.clone())
      .expand(&history.file)?;
    ensure!(single_component(&file), "Invalid history file {file:?}");
    for entry in std::fs::read_dir(dir)? {
      let path = entry?.path().join(&file);
      if path.is_file() && path.metadata()?.len() > 0 {
        return Ok(true);
      }
    }
    Ok(false)
  }

  /// Whether another process is still working in the conversation. Checks
  /// the caller's own configuration, then the selected account's.
  fn busy(&self, launch: &Launch, request: &Request, deadline: Deadline) -> Result<bool> {
    let (Some(sid), Some(busy)) = (
      &request.conversation,
      self.kind.resume.as_ref().and_then(|r| r.busy.as_ref()),
    ) else {
      return Ok(false);
    };
    if self.supervisor_busy(
      busy,
      launch,
      &request.source_env,
      sid,
      !request.arguments.is_empty(),
      deadline,
    )? {
      return Ok(true);
    }
    if busy
      .env
      .iter()
      .all(|key| request.source_env.get(key) == launch.env.get(key))
    {
      return Ok(false);
    }
    self.supervisor_busy(busy, launch, &launch.env, sid, true, deadline)
  }

  fn supervisor_busy(
    &self,
    busy: &Busy,
    launch: &Launch,
    env: &BTreeMap<String, String>,
    sid: &str,
    native_launch: bool,
    deadline: Deadline,
  ) -> Result<bool> {
    let mut cmd = self.probe(launch)?;
    cmd.args(&busy.args);
    for key in &busy.env {
      match env.get(key) {
        Some(value) => cmd.env(key, value),
        None => cmd.env_remove(key),
      };
    }
    let output = bounded(cmd, None, deadline)?;
    ensure!(
      output.status.success(),
      "Cannot inspect native supervisor state"
    );
    let value: serde_json::Value =
      serde_json::from_slice(&output.stdout).context("Invalid native supervisor state")?;
    Ok(active(busy, &value, sid, native_launch))
  }

  /// Which account this profile's login is.
  pub fn verify(&self, launch: &Launch, vars: &Vars, profile: &Profile) -> Result<Verdict> {
    self.verify_until(launch, vars, profile, Deadline::after(CHECK_TIMEOUT))
  }

  /// [`Self::verify`], with every probe inside the one `deadline`.
  fn verify_until(
    &self,
    launch: &Launch,
    vars: &Vars,
    profile: &Profile,
    deadline: Deadline,
  ) -> Result<Verdict> {
    let Some(verify) = &self.kind.verify else {
      return Ok(Verdict::Unverified);
    };
    if let Some(precheck) = &verify.precheck {
      let mut cmd = self.probe(launch)?;
      for arg in &precheck.args {
        cmd.arg(vars.expand(arg)?);
      }
      let output = bounded(cmd, None, deadline)?;
      if precheck.expect.is_empty() {
        if !output.status.success() {
          return Ok(Verdict::LoginRequired);
        }
      } else {
        let value: serde_json::Value =
          serde_json::from_slice(&output.stdout).context("Invalid native auth status")?;
        if precheck
          .expect
          .iter()
          .any(|(pointer, want)| value.pointer(pointer) != Some(want))
        {
          return Ok(Verdict::LoginRequired);
        }
      }
    }
    for present in &verify.present {
      if !vars.expand_path(present)?.exists() {
        return Ok(Verdict::LoginRequired);
      }
    }
    let identity = if let Some(http) = &verify.http {
      let source = match self.native_profile(profile)? {
        Some(native) => native.secret.as_ref(),
        None => match &self.kind.credential {
          KindCredential::Native { secret, .. } => secret.as_ref(),
          _ => None,
        },
      };
      let Some(token) = self.native_secret(source, vars, deadline)? else {
        return Ok(Verdict::LoginRequired);
      };
      match http_identity(
        &self.host.curl,
        &vars.expand(&http.url)?,
        &token,
        http,
        deadline,
      )? {
        Some(identity) => identity,
        None => return Ok(Verdict::LoginRequired),
      }
    } else if let Some(file) = &verify.file {
      let bytes = match std::fs::read(vars.expand_path(&file.path)?) {
        Ok(bytes) => Secret::new(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Verdict::LoginRequired),
        Err(e) => return Err(e.into()),
      };
      let value: serde_json::Value =
        serde_json::from_slice(bytes.expose()).context("Invalid account file")?;
      let Some(id) = value.pointer(&file.id).and_then(|v| v.as_str()) else {
        // Signed in some other way (an API key): no account to name.
        return Ok(Verdict::Unverified);
      };
      let label = match (&file.label, &file.label_jwt_claim) {
        (Some(pointer), Some(claim)) => value
          .pointer(pointer)
          .and_then(|v| v.as_str())
          .and_then(|jwt| jwt_claim(jwt, claim)),
        (Some(pointer), None) => value
          .pointer(pointer)
          .and_then(|v| v.as_str())
          .map(str::to_owned),
        (None, _) => None,
      };
      Identity {
        id: id.into(),
        label: label.unwrap_or_else(|| id.into()),
      }
    } else {
      return Ok(Verdict::Unverified);
    };
    if let Some(expected) = self.expected_label(profile) {
      ensure!(
        expected.eq_ignore_ascii_case(&identity.label),
        "identity_mismatch"
      );
    }
    Ok(Verdict::Confirmed(identity))
  }

  /// The native secret a verifier sends as a bearer: the keychain item when
  /// there is one, else the JSON file, then the kind's pointer.
  ///
  /// Both keychain lookups share one probe's time, cut short by `deadline`.
  fn native_secret(
    &self,
    source: Option<&SecretSource>,
    vars: &Vars,
    deadline: Deadline,
  ) -> Result<Option<Secret<String>>> {
    let Some(source) = source else {
      return Ok(None);
    };
    self
      .native_secret_until(source, vars, deadline.probe()?)
      .map_err(|e| deadline.blame(e))
  }

  /// [`Self::native_secret`], with the keychain user and item lookups both
  /// inside one probe deadline.
  fn native_secret_until(
    &self,
    source: &SecretSource,
    vars: &Vars,
    deadline: Instant,
  ) -> Result<Option<Secret<String>>> {
    let mut bytes = None;
    if let (Some(tool), Some(service)) = (&self.host.keychain, &source.keychain_service) {
      let service = vars.expand(service)?;
      let user = match &self.host.user {
        Some(user) => user.clone(),
        None => {
          let mut id = Command::new("/usr/bin/id");
          id.arg("-un");
          let out = bounded_until(id, None, deadline)?;
          ensure!(out.status.success(), "Cannot name the keychain user");
          String::from_utf8(out.stdout)?.trim().to_owned()
        }
      };
      #[cfg(all(test, unix))]
      tests::after_user_lookup();
      let mut lookup = self.host.command(tool);
      lookup.args(["find-generic-password", "-a", &user, "-s", &service, "-w"]);
      let out = bounded_until(lookup, None, deadline)?;
      let stdout = Secret::new(out.stdout);
      if out.status.success() && !stdout.expose().is_empty() {
        bytes = Some(stdout);
      }
    }
    if bytes.is_none() {
      let Some(file) = &source.file else {
        return Ok(None);
      };
      match std::fs::read(vars.expand_path(file)?) {
        Ok(value) => bytes = Some(Secret::new(value)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
      }
    }
    let Some(bytes) = bytes else {
      return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_slice(bytes.expose())
      .map_err(|_| anyhow::anyhow!("Invalid native credential store"))?;
    let token = value
      .pointer(&source.json_pointer)
      .and_then(|v| v.as_str())
      .map(|t| Secret::new(t.to_owned()));
    // The parsed tree holds the secret too; clear what we can.
    drop(value);
    Ok(token)
  }
}

/// Whether any node for `sid` is in a live status.
fn active(busy: &Busy, v: &serde_json::Value, sid: &str, native_launch: bool) -> bool {
  match v {
    serde_json::Value::Array(a) => a.iter().any(|v| active(busy, v, sid, native_launch)),
    serde_json::Value::Object(o) => {
      let same = busy
        .id_keys
        .iter()
        .any(|k| o.get(k).and_then(|v| v.as_str()) == Some(sid));
      let status = busy
        .status_keys
        .iter()
        .find_map(|k| o.get(k))
        .and_then(|v| v.as_str())
        .unwrap_or("");
      let interactive = busy
        .interactive
        .as_ref()
        .is_some_and(|m| o.get(&m.key).and_then(|v| v.as_str()) == Some(m.value.as_str()));
      (same && (native_launch || !interactive) && !busy.idle.iter().any(|idle| idle == status))
        || o.values().any(|v| active(busy, v, sid, native_launch))
    }
    _ => false,
  }
}

fn single_component(name: &str) -> bool {
  let mut components = Path::new(name).components();
  matches!(
    (components.next(), components.next()),
    (Some(std::path::Component::Normal(_)), None)
  )
}

/// Link a shared entry into an account's config directory. An existing
/// entry must already be that same shared entry.
fn shared_link(root: &Path, shared: &Path, name: &str) -> Result<()> {
  let src = shared.join(name);
  let dest = root.join(name);
  if !src.exists() {
    return Ok(());
  }
  if std::fs::symlink_metadata(&dest).is_ok() {
    ensure!(
      std::fs::canonicalize(&dest)? == std::fs::canonicalize(&src)?,
      "Profile customization conflicts with shared configuration"
    );
  } else {
    link(&src, &dest)?;
  }
  Ok(())
}

/// A shared entry is a symlink, so every account sees the one original.
#[cfg(unix)]
fn link(src: &Path, dest: &Path) -> Result<()> {
  std::os::unix::fs::symlink(src, dest)?;
  Ok(())
}

/// Off unix, refuse rather than copy: a copy would quietly fork the shared
/// configuration, and each account would drift from the others.
#[cfg(not(unix))]
fn link(src: &Path, _dest: &Path) -> Result<()> {
  bail!(
    "Account kinds share {} by symlink, which this platform does not support yet",
    src.display()
  )
}

/// Run a probe with an output cap, by its own [`PROBE_TIMEOUT`] or the
/// request's `deadline`, whichever comes first.
fn bounded(cmd: Command, input: Option<&[u8]>, deadline: Deadline) -> Result<std::process::Output> {
  let input = input.map(|bytes| Secret::new(bytes.to_vec()));
  bounded_until(cmd, input, deadline.probe()?).map_err(|e| deadline.blame(e))
}

/// Run a probe to completion by `deadline`. Feeding it `input`, its own
/// lifetime, and reading its output to the end all count against that one
/// deadline, and output past [`PROBE_LIMIT`] is refused. A probe whose
/// deadline has passed is refused before it starts. Missing the deadline
/// either way is a [`ProbeTimedOut`].
///
/// The probe runs in its own process group. When it misses the deadline or
/// answers too much, the whole group is killed, so a background descendant
/// that inherited its pipes can neither keep the caller waiting nor outlive
/// the probe. Input and output move through threads that are never joined:
/// one blocked on a pipe that something outside the group (a descendant
/// that started its own session) still holds is abandoned, not waited for.
/// A probe that finishes in time keeps its descendants: a CLI may leave a
/// helper running, as long as it released the probe's output.
fn bounded_until(
  mut cmd: Command,
  input: Option<Secret<Vec<u8>>>,
  deadline: Instant,
) -> Result<std::process::Output> {
  let name = Path::new(cmd.get_program())
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_default();
  cmd
    .stdin(if input.is_some() {
      Stdio::piped()
    } else {
      Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
  #[cfg(unix)]
  std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
  let timeout = || ProbeTimedOut {
    name: name.clone(),
    deadline,
  };
  // A probe whose deadline has already passed is not started: whatever
  // delayed its caller must not let it act after the time ran out.
  if Instant::now() >= deadline {
    return Err(timeout().into());
  }
  let mut probe = Probe {
    child: cmd
      .spawn()
      .with_context(|| format!("Cannot start {name}"))?,
    finished: false,
  };
  if let Some(input) = input {
    let mut stdin = probe
      .child
      .stdin
      .take()
      .context("Probe input unavailable")?;
    // A probe may exit, or be killed, without reading all of it: the write
    // then fails, and the probe's answer (or the deadline) decides.
    std::thread::spawn(move || {
      let _ = stdin.write_all(input.expose());
    });
  }
  let stdout = probe
    .child
    .stdout
    .take()
    .context("Probe output unavailable")?;
  let (sender, receiver) = std::sync::mpsc::channel();
  std::thread::spawn(move || {
    let mut out = Vec::new();
    let read = stdout.take(PROBE_LIMIT + 1).read_to_end(&mut out);
    let _ = sender.send(read.map(|_| out));
  });
  // Every writer of the output pipe has closed it (or the cap is reached)...
  let stdout = match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
    Ok(read) => read.with_context(|| format!("Cannot read {name}'s answer"))?,
    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Err(timeout().into()),
    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => bail!("Probe output reader failed"),
  };
  ensure!(
    stdout.len() as u64 <= PROBE_LIMIT,
    "{name} answered too much"
  );
  // ...and the probe itself has exited.
  let status = loop {
    if let Some(status) = probe.child.try_wait()? {
      break status;
    }
    if Instant::now() >= deadline {
      return Err(timeout().into());
    }
    std::thread::sleep(Duration::from_millis(10));
  };
  probe.finished = true;
  Ok(std::process::Output {
    status,
    stdout,
    stderr: Vec::new(),
  })
}

/// A running probe. Unless it finished, dropping it kills its process group
/// and reaps it.
struct Probe {
  child: std::process::Child,
  /// Set only once `try_wait` has reaped the child.
  finished: bool,
}

impl Drop for Probe {
  fn drop(&mut self) {
    if self.finished {
      return;
    }
    // The child is not reaped yet, so its pid still names its own process
    // group and cannot have been reused.
    #[cfg(unix)]
    if let Ok(group) = libc::pid_t::try_from(self.child.id()) {
      // SAFETY: `killpg` takes plain integers and only sends a signal; the
      // group is the one this probe was spawned into.
      unsafe {
        libc::killpg(group, libc::SIGKILL);
      }
    }
    let _ = self.child.kill();
    let _ = self.child.wait();
  }
}

/// Whether an identity URL may carry a bearer, and the one protocol curl may
/// then use: HTTPS to any host, or plain HTTP to a loopback address only.
///
/// The URL is read structurally, and only in a narrow form that curl (run
/// with `--globoff`, so it takes the URL literally) reads the same way:
/// `scheme://host[:port]`, then an optional path, query or fragment, in
/// printable ASCII. The authority holds no userinfo (`user@`) and no
/// percent-escape; an HTTP host is exactly `localhost`, a dotted-decimal
/// address in 127.0.0.0/8, or the IPv6 loopback `[::1]`. Anything else is
/// refused rather than interpreted.
fn allowed_proto(url: &str) -> Result<&'static str> {
  const INVALID: &str = "Invalid identity endpoint URL";
  ensure!(
    url.bytes().all(|b| b.is_ascii_graphic() && b != b'\\'),
    INVALID
  );
  let (proto, rest) = if let Some(rest) = url.strip_prefix("https://") {
    ("=https", rest)
  } else if let Some(rest) = url.strip_prefix("http://") {
    ("=http", rest)
  } else {
    bail!("An identity endpoint must be HTTPS");
  };
  let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
  ensure!(
    !authority.contains('@'),
    "An identity endpoint URL must not carry credentials"
  );
  let (loopback, port) = match authority.strip_prefix('[') {
    Some(inner) => {
      let (literal, port) = inner.split_once(']').context(INVALID)?;
      let address: std::net::Ipv6Addr = literal.parse().map_err(|_| anyhow::anyhow!(INVALID))?;
      (address.is_loopback(), port)
    }
    None => {
      let (host, port) = authority.split_at(authority.find(':').unwrap_or(authority.len()));
      ensure!(
        host.split('.').all(|label| {
          !label.is_empty()
            && label
              .bytes()
              .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        }),
        INVALID
      );
      let loopback = host == "localhost"
        || host
          .parse::<std::net::Ipv4Addr>()
          .is_ok_and(|address| address.is_loopback());
      (loopback, port)
    }
  };
  match port.strip_prefix(':') {
    Some(port) => ensure!(
      !port.is_empty()
        && port.bytes().all(|b| b.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|p| p > 0),
      INVALID
    ),
    None => ensure!(port.is_empty(), INVALID),
  }
  ensure!(
    proto == "=https" || loopback,
    "An identity endpoint must be HTTPS, or HTTP to a loopback address"
  );
  Ok(proto)
}

/// The identity request's argv. It never holds the credential: the headers
/// (with the bearer) go to curl on stdin.
pub fn identity_argv(url: &str) -> Result<Vec<String>> {
  Ok(
    [
      "--disable",
      "--silent",
      "--globoff",
      "--max-time",
      "15",
      "--proto",
      allowed_proto(url)?,
      "--url",
      url,
      "--header",
      "@-",
      "--write-out",
      "\n%{http_code}",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect(),
  )
}

/// Ask the identity endpoint which account the bearer belongs to. `None`
/// when the endpoint says the credential is no longer valid.
fn http_identity(
  curl: &Path,
  url: &str,
  token: &Secret<String>,
  http: &tento_secrets::accounts::kind::HttpIdentity,
  deadline: Deadline,
) -> Result<Option<Identity>> {
  ensure!(
    !token.expose().is_empty() && !token.expose().contains(['\r', '\n', '\0']),
    "Invalid native credential"
  );
  let headers = Secret::new(format!(
    "Authorization: Bearer {}\nContent-Type: application/json\nCache-Control: no-cache\n",
    token.expose()
  ));
  let mut cmd = Command::new(curl);
  cmd.args(identity_argv(url)?);
  let output = bounded(cmd, Some(headers.expose().as_bytes()), deadline)?;
  ensure!(output.status.success(), "network");
  let body = String::from_utf8(output.stdout).context("Invalid identity response")?;
  let (body, status) = body
    .rsplit_once('\n')
    .context("Missing identity response status")?;
  if http
    .unauthorized
    .iter()
    .any(|code| status == code.to_string())
  {
    return Ok(None);
  }
  ensure!(status == "200", "network");
  let value: serde_json::Value =
    serde_json::from_str(body).context("Invalid account identity response")?;
  let label = value
    .pointer(&http.label)
    .and_then(|v| v.as_str())
    .context("No account label")?;
  let id = value
    .pointer(&http.id)
    .and_then(|v| v.as_str())
    .context("No account ID")?;
  Ok(Some(Identity {
    id: id.into(),
    label: label.into(),
  }))
}

/// One claim of a JWT's payload, decoded but NOT verified: good for a label,
/// never for a decision.
pub fn jwt_claim(jwt: &str, claim: &str) -> Option<String> {
  let payload = jwt.split('.').nth(1)?;
  let bytes = base64url(payload)?;
  let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
  value.get(claim)?.as_str().map(str::to_owned)
}

fn base64url(text: &str) -> Option<Vec<u8>> {
  let mut out = Vec::with_capacity(text.len() * 3 / 4);
  let mut acc = 0u32;
  let mut bits = 0;
  for b in text.bytes().take_while(|b| *b != b'=') {
    let v = match b {
      b'A'..=b'Z' => b - b'A',
      b'a'..=b'z' => b - b'a' + 26,
      b'0'..=b'9' => b - b'0' + 52,
      b'-' | b'+' => 62,
      b'_' | b'/' => 63,
      _ => return None,
    };
    acc = (acc << 6) | u32::from(v);
    bits += 6;
    if bits >= 8 {
      bits -= 8;
      out.push((acc >> bits) as u8);
      acc &= (1 << bits) - 1;
    }
  }
  Some(out)
}

// --- the provider surface, as `super::Provider` has it ----------------------

impl KindProvider {
  /// Answer a request on a blocking thread, then read the reply exactly as an
  /// executable provider's reply is read.
  async fn call(&self, registry: &Registry, request: Request) -> Result<Response> {
    self.call_within(registry, request, CHECK_TIMEOUT).await
  }

  /// [`Self::call`], answered within `budget`. The request's probes share
  /// that one deadline, so a request that misses it has already killed and
  /// reaped whatever it started when it reports the timeout.
  async fn call_within(
    &self,
    registry: &Registry,
    request: Request,
    budget: Duration,
  ) -> Result<Response> {
    let this = self.clone();
    let reg = registry.clone();
    let req = request.clone();
    let deadline = Deadline::after(budget);
    let reply = tokio::time::timeout_at(
      (deadline.0 + STALL_GRACE).into(),
      tokio::task::spawn_blocking(move || this.run_until(&reg, req, deadline)),
    )
    .await
    .map_err(|_| CheckTimedOut)?
    .context("Account check failed")?;
    let reply = match reply {
      Ok(reply) => reply,
      Err(e) if e.is::<CheckTimedOut>() => return Err(e),
      Err(e) => match error_code(&e) {
        Some(code) => Response {
          error: Some(code.into()),
          ..Default::default()
        },
        None => return Err(e.context(format!("{} account", self.kind.app))),
      },
    };
    super::read_reply(&request, reply, Some(registry))
  }

  pub async fn refresh_catalog(&self, registry: &Registry) -> Result<Vec<Profile>> {
    let this = self.clone();
    let reg = registry.clone();
    tokio::task::spawn_blocking(move || this.profiles(&reg))
      .await
      .context("Account import failed")?
  }

  pub async fn register(&self, registry: &Registry, alias: &str) -> Result<Profile> {
    let this = self.clone();
    let reg = registry.clone();
    let alias = alias.to_owned();
    tokio::task::spawn_blocking(move || this.register_alias(&reg, &alias))
      .await
      .context("Account registration failed")?
  }

  pub async fn login(&self, registry: &Registry, profile: Profile) -> Result<Launch> {
    if let KindCredential::Vault {
      namespace, name, ..
    } = &self.kind.credential
    {
      let name = Vars::new()
        .with("alias", profile.alias.clone())
        .expand(name)?;
      bail!(
        "This account's key is a vault value: set it with `tsh '(tsh.secrets \"set\" \"{namespace}/{name}\")'`"
      );
    }
    let mut request = Request::new("login", &self.kind.app);
    request.credential_dir = registry.credential_dir(&profile)?;
    request.profile = Some(profile.clone());
    let mut launch = self
      .call(registry, request)
      .await?
      .launch
      .context("Provider returned no login command")?;
    launch.bind(registry, &profile)?;
    Ok(launch)
  }

  pub async fn prepare(
    &self,
    registry: &Registry,
    profile: Profile,
    conversation: Option<&str>,
    cwd: &Path,
    source_env: BTreeMap<String, String>,
  ) -> Result<Binding> {
    self
      .prepare_run(registry, profile, conversation, cwd, source_env, Vec::new())
      .await
  }

  pub async fn prepare_run(
    &self,
    registry: &Registry,
    profile: Profile,
    conversation: Option<&str>,
    cwd: &Path,
    source_env: BTreeMap<String, String>,
    arguments: Vec<String>,
  ) -> Result<Binding> {
    let mut request = Request::new("prepare", &self.kind.app);
    request.arguments = arguments;
    request.credential_dir = registry.credential_dir(&profile)?;
    request.profile = Some(profile.clone());
    request.conversation = conversation.map(str::to_owned);
    request.cwd = Some(cwd.into());
    request.source_env = source_env;
    let response = self.call(registry, request).await?;
    let mut launch = response
      .launch
      .context("Provider returned no launch plan")?;
    ensure!(
      conversation.is_none() || launch.resume,
      "Provider cannot safely resume this conversation"
    );
    // The app's own login is never held to a confirmed identity; see
    // `native_identity`.
    let native = self.native_profile(&profile)?.is_some();
    let confirmed = match response.identity {
      // An account other than the one the catalog bound this profile to is
      // refused by `confirm` (the binding is kept), and for the app's own
      // login that is one more way of being unverified.
      Some(identity) if native => registry
        .confirm(&self.kind.app, &profile.id, identity)
        .map_err(|error| {
          tracing::warn!(
            app = %self.kind.app,
            profile = %profile.alias,
            reason = %format!("{error:#}"),
            "the app's own login is not verified; it runs as it is"
          )
        })
        .ok(),
      Some(identity) => Some(registry.confirm(&self.kind.app, &profile.id, identity)?),
      None => None,
    };
    let profile = match confirmed {
      Some(profile) => profile,
      None => {
        ensure!(
          native || !self.requires_identity(),
          "Provider did not confirm account identity"
        );
        // Usable, though no account was named: a profile an earlier attempt
        // marked for sign-in is no longer that. The app's own login, once
        // confirmed, is demoted too: this launch verified nothing, so it is
        // not `Ready`, and it does not carry the earlier account as its
        // identity. The catalog keeps that account as the profile's binding,
        // so a different account is never confirmed as this profile.
        let app = self.kind.app.clone();
        registry.edit(|catalog| {
          let entry = catalog
            .profiles
            .iter_mut()
            .find(|p| p.app == app && p.id == profile.id)
            .context("Unknown profile")?;
          if entry.state == profiles::AuthState::LoginRequired
            || (native && entry.state == profiles::AuthState::Ready)
          {
            entry.state = profiles::AuthState::Unverified;
          }
          let mut launched = entry.clone();
          if native {
            launched.identity = None;
          }
          Ok(launched)
        })?
      }
    };
    launch.bind(registry, &profile)?;
    Ok(Binding { profile, launch })
  }
}

#[cfg(all(test, unix))]
mod tests {
  //! The probe and request deadlines, with short deadlines in place of
  //! [`PROBE_TIMEOUT`] and [`CHECK_TIMEOUT`].
  //! Every probe records the pid of whatever might outlive it, so each test
  //! can check that nothing it started is left running.
  use super::*;
  use std::os::unix::fs::PermissionsExt;

  const DEADLINE: Duration = Duration::from_millis(1500);
  /// Room for scheduling, the kill and the reap.
  const EPSILON: Duration = Duration::from_millis(1500);

  thread_local! {
    /// How long a keychain read pauses between naming the user and asking
    /// for the item, as a thread the scheduler set aside would.
    static USER_LOOKUP_DELAY: std::cell::Cell<Duration> = const { std::cell::Cell::new(Duration::ZERO) };
    /// Whether a keychain read got as far as naming its user.
    static USER_LOOKUP_DONE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
  }

  pub(super) fn after_user_lookup() {
    USER_LOOKUP_DONE.set(true);
    std::thread::sleep(USER_LOOKUP_DELAY.get());
  }

  thread_local! {
    /// What happens once a native import has found the app without a
    /// default, before it makes its login the default: another session's
    /// move, placed exactly there.
    static BEFORE_NATIVE_DEFAULT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
      const { std::cell::RefCell::new(None) };
  }

  pub(super) fn before_native_default() {
    if let Some(step) = BEFORE_NATIVE_DEFAULT.take() {
      step();
    }
  }

  /// Tests that start processes take turns. On macOS a pipe is made
  /// close-on-exec only after it is created, so a process another test
  /// starts in between can inherit a probe's output pipe, and a fixture
  /// that sleeps would then hold that probe's answer open.
  static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

  fn turn() -> std::sync::MutexGuard<'static, ()> {
    TURN
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
  }

  fn sh(script: &str) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(script);
    cmd
  }

  /// Runs `exercise` while waiting for the fixture it starts to write its
  /// pid to `file`, and returns that pid with what `exercise` returned. The
  /// fixture must be ready while `exercise` still runs, before the deadline
  /// it is there to test can kill it: a pid that has not arrived by the time
  /// `exercise` is over never will, and fails the test as a fixture that
  /// never started, never as a clean-up.
  fn started<T: Send>(file: &Path, exercise: impl FnOnce() -> T + Send) -> (libc::pid_t, T) {
    std::thread::scope(|scope| {
      let running = scope.spawn(exercise);
      let pid = loop {
        let over = running.is_finished();
        if let Some(pid) = std::fs::read_to_string(file)
          .ok()
          .and_then(|text| text.trim().parse().ok())
        {
          break pid;
        }
        assert!(
          !over,
          "{} was never written: the fixture never started",
          file.display()
        );
        std::thread::sleep(Duration::from_millis(10));
      };
      (pid, running.join().unwrap())
    })
  }

  /// Whether `pid` is gone, allowing a moment for its reaper.
  fn gone(pid: libc::pid_t) -> bool {
    let until = Instant::now() + Duration::from_secs(3);
    loop {
      // SAFETY: signal 0 only checks that the process exists.
      if unsafe { libc::kill(pid, 0) } != 0 {
        return true;
      }
      if Instant::now() >= until {
        return false;
      }
      std::thread::sleep(Duration::from_millis(20));
    }
  }

  /// Runs `cmd` with the short deadline; the result and how long it took.
  fn timed(cmd: Command, input: Option<Vec<u8>>) -> (Result<std::process::Output>, Duration) {
    let start = Instant::now();
    let result = bounded_until(cmd, input.map(Secret::new), start + DEADLINE);
    (result, start.elapsed())
  }

  fn assert_timed_out(result: Result<std::process::Output>, elapsed: Duration) {
    let error = result.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(error.contains("did not answer in time"), "{error:?}");
    assert!(
      elapsed >= DEADLINE && elapsed < DEADLINE + EPSILON,
      "returned after {elapsed:?}"
    );
  }

  #[test]
  fn an_exited_parent_cannot_hold_the_answer_open() {
    let _turn = turn();
    let temp = tempfile::tempdir().unwrap();
    let pid = temp.path().join("pid");
    // The shell exits at once; its background child keeps stdout open.
    let (writer, (result, elapsed)) = started(&pid, || {
      timed(
        sh(&format!("sleep 30 & echo $! > '{}'; exit 0", pid.display())),
        None,
      )
    });
    assert_timed_out(result, elapsed);
    assert!(gone(writer), "the background writer outlived the probe");
  }

  #[test]
  fn a_probe_that_never_reads_its_input_times_out() {
    let _turn = turn();
    let temp = tempfile::tempdir().unwrap();
    let pid = temp.path().join("pid");
    // Far more than a pipe buffers, so writing it blocks.
    let input = vec![b'x'; 8 * 1024 * 1024];
    let (probe, (result, elapsed)) = started(&pid, || {
      timed(
        sh(&format!("echo $$ > '{}'; exec sleep 30", pid.display())),
        Some(input),
      )
    });
    assert_timed_out(result, elapsed);
    assert!(gone(probe), "the probe outlived its deadline");
  }

  #[test]
  fn output_past_the_cap_is_refused_without_waiting() {
    let _turn = turn();
    let temp = tempfile::tempdir().unwrap();
    let pid = temp.path().join("pid");
    let (probe, (result, elapsed)) = started(&pid, || {
      let start = Instant::now();
      let result = bounded_until(
        sh(&format!("echo $$ > '{}'; exec yes", pid.display())),
        None,
        start + Duration::from_secs(20),
      );
      (result, start.elapsed())
    });
    let error = result.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(error.contains("answered too much"), "{error:?}");
    assert!(elapsed < EPSILON, "took {elapsed:?}");
    assert!(gone(probe), "the flooding probe was left running");
  }

  #[test]
  fn input_reaches_the_probe_and_its_answer_comes_back() {
    let _turn = turn();
    let (result, elapsed) = timed(sh("cat; echo done"), Some(b"hello\n".to_vec()));
    let output = result.unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"hello\ndone\n");
    assert!(elapsed < DEADLINE, "took {elapsed:?}");
    let (result, _) = timed(sh("exit 3"), None);
    assert_eq!(result.unwrap().status.code(), Some(3));
  }

  #[test]
  fn a_helper_that_released_the_output_does_not_hold_the_answer() {
    let _turn = turn();
    let temp = tempfile::tempdir().unwrap();
    let pid = temp.path().join("pid");
    let (helper, (result, elapsed)) = started(&pid, || {
      timed(
        sh(&format!(
          "sleep 30 >/dev/null 2>&1 & echo $! > '{}'; echo ok",
          pid.display()
        )),
        None,
      )
    });
    let output = result.unwrap();
    assert_eq!(output.stdout, b"ok\n");
    assert!(elapsed < DEADLINE, "took {elapsed:?}");
    // A probe that finished in time keeps its helper; this test does not.
    // SAFETY: the pid is the helper this test just started.
    unsafe { libc::kill(helper, libc::SIGKILL) };
    assert!(gone(helper));
  }

  fn keychain_provider(tool: &Path, user: Option<&str>) -> KindProvider {
    let kind = AccountKind::parse(
      &serde_json::json!({
        "schema": "account.kind/v1",
        "app": "fixture",
        "cli": {"name": "fakecli"},
        "credential": {
          "backend": "native",
          "root": {"default": "{home}/accounts"},
          "locator": "{root}/{alias}",
          "secret": {"keychain_service": "fixture-credentials", "json_pointer": "/token"}
        }
      })
      .to_string(),
    )
    .unwrap();
    let home = tool.parent().unwrap().to_path_buf();
    KindProvider::new(
      kind,
      KindHost {
        home: home.clone(),
        vars: BTreeMap::new(),
        child_env: Some(BTreeMap::from([(
          "PATH".to_string(),
          "/usr/bin:/bin".to_string(),
        )])),
        cwd: home,
        keychain: Some(tool.to_path_buf()),
        user: user.map(str::to_owned),
        curl: PathBuf::from("/usr/bin/curl"),
      },
    )
  }

  /// The kind's own secret source.
  fn kind_secret(provider: &KindProvider) -> &SecretSource {
    match &provider.kind.credential {
      KindCredential::Native {
        secret: Some(secret),
        ..
      } => secret,
      _ => panic!("the fixture kind reads a native secret"),
    }
  }

  fn keychain_tool(dir: &Path, script: &str) -> PathBuf {
    tool(dir, "security", script)
  }

  /// An executable shell script named `name` in `dir`, started once (as a
  /// no-op) before it is returned. macOS may scan a new executable on its
  /// first run, slowly enough on a loaded host that a probe with a short
  /// deadline would be killed before the script's first line; that cold
  /// start is paid here, under its own allowance, not inside a deadline.
  fn tool(dir: &Path, name: &str, script: &str) -> PathBuf {
    let tool = dir.join(name);
    std::fs::write(
      &tool,
      format!("#!/bin/sh\n[ \"$1\" = --warm ] && exit 0\n{script}\n"),
    )
    .unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    // No pipes: nothing another process inherits can hold this run open.
    let mut warm = Command::new(&tool)
      .arg("--warm")
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .spawn()
      .unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    let status = loop {
      if let Some(status) = warm.try_wait().unwrap() {
        break Some(status);
      }
      if Instant::now() >= until {
        let _ = warm.kill();
        let _ = warm.wait();
        break None;
      }
      std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
      status.is_some_and(|s| s.success()),
      "{} never started: {status:?}",
      tool.display()
    );
    tool
  }

  #[test]
  fn a_blocked_keychain_helper_times_out() {
    let _turn = turn();
    let temp = tempfile::tempdir().unwrap();
    let pid = temp.path().join("pid");
    let tool = keychain_tool(
      temp.path(),
      &format!("echo $$ > '{}'; exec sleep 30", pid.display()),
    );
    let provider = keychain_provider(&tool, Some("fixture-user"));
    let (helper, (result, elapsed)) = started(&pid, || {
      let start = Instant::now();
      let result =
        provider.native_secret_until(kind_secret(&provider), &Vars::new(), start + DEADLINE);
      (result, start.elapsed())
    });
    let error = result.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(error.contains("did not answer in time"), "{error:?}");
    assert!(
      elapsed >= DEADLINE && elapsed < DEADLINE + EPSILON,
      "returned after {elapsed:?}"
    );
    assert!(gone(helper), "the keychain helper outlived the lookup");
  }

  #[test]
  fn a_keychain_helper_that_answers_is_read_for_the_current_user() {
    let _turn = turn();
    let temp = tempfile::tempdir().unwrap();
    let args = temp.path().join("args");
    let tool = keychain_tool(
      temp.path(),
      &format!(
        "echo \"$@\" > '{}'; printf '{{\"token\":\"FROM_KEYCHAIN\"}}'",
        args.display()
      ),
    );
    // No configured user: `/usr/bin/id -un` names it, under the same deadline.
    let provider = keychain_provider(&tool, None);
    let token = provider
      .native_secret_until(
        kind_secret(&provider),
        &Vars::new(),
        Instant::now() + Duration::from_secs(20),
      )
      .unwrap()
      .unwrap();
    assert_eq!(token.expose(), "FROM_KEYCHAIN");
    let asked = std::fs::read_to_string(&args).unwrap();
    assert!(
      asked.starts_with("find-generic-password -a ")
        && asked.contains(" -s fixture-credentials -w"),
      "{asked}"
    );
    assert!(!asked.contains("-a  -s"), "no user was named: {asked}");
  }

  /// A kind whose account check runs three scripts in `dir`: the CLI (the
  /// precheck), the keychain tool, and the HTTP client (the identity
  /// request). The request prepares a registered account.
  fn scripted(
    dir: &Path,
    precheck: &str,
    keychain: &str,
    curl: &str,
  ) -> (KindProvider, Registry, Request) {
    let cli = tool(dir, "fakecli", precheck);
    let keychain = tool(dir, "security", keychain);
    let curl = tool(dir, "curl", curl);
    let kind = AccountKind::parse(
      &serde_json::json!({
        "schema": "account.kind/v1",
        "app": "fixture",
        "cli": {"env": "FAKE_CLI", "name": "fakecli"},
        "credential": {
          "backend": "native",
          "root": {"default": "{home}/accounts"},
          "locator": "{root}/{alias}",
          "secret": {"keychain_service": "fixture-credentials", "json_pointer": "/token"}
        },
        "verify": {
          "precheck": {"args": ["auth", "status"]},
          "http": {"url": "https://identity.invalid/profile", "id": "/id", "label": "/label"}
        }
      })
      .to_string(),
    )
    .unwrap();
    let home = dir.join("home");
    std::fs::create_dir(&home).unwrap();
    let provider = KindProvider::new(
      kind,
      KindHost {
        home: home.clone(),
        vars: BTreeMap::from([("FAKE_CLI".to_string(), cli.to_string_lossy().into_owned())]),
        child_env: Some(BTreeMap::from([(
          "PATH".to_string(),
          "/usr/bin:/bin".to_string(),
        )])),
        cwd: home.clone(),
        keychain: Some(keychain),
        user: Some("fixture-user".into()),
        curl,
      },
    );
    let registry = Registry::at(dir.join("store"));
    let profile = provider.register_alias(&registry, "work").unwrap();
    let mut request = Request::new("prepare", "fixture");
    request.profile = Some(profile);
    request.cwd = Some(home);
    (provider, registry, request)
  }

  /// One account check with `budget` as its whole time. The runtime is shut
  /// down without waiting, as a caller that gave up would leave it: whatever
  /// the check started must already be gone.
  fn check(
    provider: &KindProvider,
    registry: &Registry,
    request: Request,
    budget: Duration,
  ) -> (Result<Response>, Duration) {
    let runtime = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap();
    let start = Instant::now();
    let result = runtime.block_on(provider.call_within(registry, request, budget));
    let elapsed = start.elapsed();
    runtime.shutdown_background();
    (result, elapsed)
  }

  fn assert_check_timed_out(result: Result<Response>, elapsed: Duration, budget: Duration) {
    let error = result.err().map(|e| e.to_string()).unwrap_or_default();
    assert_eq!(error, "Account check timed out; profile unchanged");
    assert!(
      elapsed >= budget && elapsed < budget + EPSILON,
      "returned after {elapsed:?}"
    );
  }

  #[test]
  fn a_timed_out_check_leaves_no_probe_running() {
    let _turn = turn();
    let temp = tempfile::tempdir().unwrap();
    let (pid, late) = (temp.path().join("pid"), temp.path().join("late"));
    // The precheck alone outlasts the whole check.
    let (provider, registry, request) = scripted(
      temp.path(),
      &format!(
        "echo $$ > '{}'; sleep 30; echo late > '{}'",
        pid.display(),
        late.display()
      ),
      "exit 44",
      "exit 7",
    );
    let (precheck, (result, elapsed)) =
      started(&pid, || check(&provider, &registry, request, DEADLINE));
    assert_check_timed_out(result, elapsed, DEADLINE);
    assert!(
      gone(precheck),
      "the precheck outlived the check that started it"
    );
    assert!(
      !late.exists(),
      "the precheck finished after the check gave up"
    );
  }

  #[test]
  fn every_step_shares_the_one_request_deadline() {
    let _turn = turn();
    let temp = tempfile::tempdir().unwrap();
    let (pid, late) = (temp.path().join("pid"), temp.path().join("late"));
    // The precheck and the keychain answer; the identity request, the third
    // step, hangs. It gets what is left of the check, not a fresh probe
    // budget, and is killed when that runs out.
    let (provider, registry, request) = scripted(
      temp.path(),
      "sleep 0.5",
      "sleep 0.5; printf '{\"token\":\"T\"}'",
      &format!(
        "echo $$ > '{}'; cat > /dev/null; sleep 30; echo late > '{}'",
        pid.display(),
        late.display()
      ),
    );
    // Room for the three steps on a loaded host.
    let budget = Duration::from_secs(4);
    let (identity, (result, elapsed)) =
      started(&pid, || check(&provider, &registry, request, budget));
    assert_check_timed_out(result, elapsed, budget);
    assert!(
      gone(identity),
      "the identity request outlived the check that started it"
    );
    assert!(
      !late.exists(),
      "the identity request finished after the check gave up"
    );
  }

  #[test]
  fn no_probe_starts_once_the_request_deadline_has_passed() {
    let _turn = turn();
    let temp = tempfile::tempdir().unwrap();
    let ran = temp.path().join("ran");
    let result = bounded(
      sh(&format!("echo ran > '{}'", ran.display())),
      None,
      Deadline(Instant::now()),
    );
    assert!(
      result.as_ref().is_err_and(|e| e.is::<CheckTimedOut>()),
      "{:?}",
      result.map(|_| ())
    );
    std::thread::sleep(Duration::from_millis(200));
    assert!(!ran.exists(), "a probe started after the deadline");
  }

  #[test]
  fn an_expired_probe_is_never_started() {
    let _turn = turn();
    use std::os::unix::{ffi::OsStrExt, process::CommandExt};
    let temp = tempfile::tempdir().unwrap();
    let started = temp.path().join("started");
    let path = std::ffi::CString::new(started.as_os_str().as_bytes()).unwrap();
    let mut cmd = Command::new("/usr/bin/true");
    // SAFETY: between fork and exec the hook only calls `open` and `close`,
    // which are async-signal-safe, on a path allocated before the fork.
    unsafe {
      cmd.pre_exec(move || {
        let fd = libc::open(
          path.as_ptr(),
          libc::O_CREAT | libc::O_WRONLY,
          0o600 as libc::c_uint,
        );
        if fd >= 0 {
          libc::close(fd);
        }
        Ok(())
      });
    }
    let result = bounded_until(cmd, None, Instant::now());
    let error = result.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(error.contains("did not answer in time"), "{error:?}");
    assert!(!started.exists(), "a probe started after its deadline");
  }

  #[test]
  fn a_keychain_item_is_not_asked_for_once_the_user_lookup_used_up_the_deadline() {
    let _turn = turn();
    let temp = tempfile::tempdir().unwrap();
    // A keychain tool that cannot be executed: trying to start it fails with
    // its own error, so the error says whether the lookup was attempted.
    let tool = temp.path().join("security");
    std::fs::write(&tool, "").unwrap();
    // No configured user: `/usr/bin/id -un` names it, then the thread stalls
    // past the deadline the two lookups share.
    let provider = keychain_provider(&tool, None);
    USER_LOOKUP_DELAY.set(DEADLINE);
    USER_LOOKUP_DONE.set(false);
    let result = provider.native_secret_until(
      kind_secret(&provider),
      &Vars::new(),
      Instant::now() + DEADLINE / 2,
    );
    USER_LOOKUP_DELAY.set(Duration::ZERO);
    assert!(
      USER_LOOKUP_DONE.get(),
      "the user lookup itself failed; the stall after it was never reached"
    );
    let error = result.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(error.contains("did not answer in time"), "{error:?}");
  }

  #[test]
  fn a_failure_seen_after_the_deadline_keeps_its_own_error() {
    let deadline = Deadline(Instant::now());
    let capped = deadline.blame(anyhow::anyhow!("fakecli answered too much"));
    assert!(!capped.is::<CheckTimedOut>());
    assert_eq!(capped.to_string(), "fakecli answered too much");
    let read = deadline.blame(
      Err::<(), _>(std::io::Error::other("broken pipe"))
        .context("Cannot read fakecli's answer")
        .unwrap_err(),
    );
    assert!(!read.is::<CheckTimedOut>());
    assert_eq!(
      format!("{read:#}"),
      "Cannot read fakecli's answer: broken pipe"
    );
  }

  #[test]
  fn only_a_probe_out_of_the_request_time_is_the_check_timing_out() {
    let deadline = Deadline(Instant::now());
    let expired = |at| {
      anyhow::Error::new(ProbeTimedOut {
        name: "fakecli".into(),
        deadline: at,
      })
    };
    // The request's deadline was the probe's: the check ran out of time.
    assert!(deadline.blame(expired(deadline.0)).is::<CheckTimedOut>());
    // The probe's own budget ran out first: that probe is the failure.
    let own = deadline.blame(expired(deadline.0 - Duration::from_millis(1)));
    assert!(own.is::<ProbeTimedOut>());
    assert_eq!(own.to_string(), "fakecli did not answer in time");
  }

  /// A kind that resumes by `resume <id>`, holding IDs to `id` (when given),
  /// with one registered account and a CLI that always succeeds.
  fn resumable(dir: &Path, id: Option<&str>) -> (KindProvider, Registry, Request, PathBuf) {
    let cli = tool(dir, "fakecli", "exit 0");
    let mut resume = serde_json::json!({"exact": ["resume"], "refuse": ["--last"]});
    if let Some(id) = id {
      resume["id"] = serde_json::json!(id);
    }
    let kind = AccountKind::parse(
      &serde_json::json!({
        "schema": "account.kind/v1",
        "app": "fixture",
        "cli": {"env": "FAKE_CLI", "name": "fakecli"},
        "credential": {"backend": "native", "root": {"default": "{home}/accounts"}, "locator": "{root}/{alias}"},
        "resume": resume
      })
      .to_string(),
    )
    .unwrap();
    let home = dir.join("home");
    std::fs::create_dir(&home).unwrap();
    let provider = KindProvider::new(
      kind,
      KindHost {
        home: home.clone(),
        vars: BTreeMap::from([("FAKE_CLI".to_string(), cli.to_string_lossy().into_owned())]),
        child_env: Some(BTreeMap::from([(
          "PATH".to_string(),
          "/usr/bin:/bin".to_string(),
        )])),
        cwd: home.clone(),
        keychain: None,
        user: None,
        curl: PathBuf::from("/usr/bin/curl"),
      },
    );
    let registry = Registry::at(dir.join("store"));
    let profile = provider.register_alias(&registry, "work").unwrap();
    let mut request = Request::new("prepare", "fixture");
    request.profile = Some(profile);
    request.cwd = Some(home);
    (provider, registry, request, cli)
  }

  const THREAD: &str = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  /// Other ways to name [`THREAD`]: a session name and two UUID spellings.
  const ALIASES: [&str; 3] = [
    "my-session",
    "0199AAAA-BBBB-7CCC-8DDD-EEEEEEEEEEEE",
    "0199aaaabbbb7ccc8dddeeeeeeeeeeee",
  ];

  fn resume_args(cli: &Path, id: &str) -> Vec<String> {
    vec![
      cli.to_string_lossy().into_owned(),
      "resume".into(),
      id.into(),
    ]
  }

  #[test]
  fn a_uuid_kind_resumes_only_by_the_canonical_uuid() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, registry, request, cli) = resumable(temp.path(), Some("uuid"));
    let mut exact = request.clone();
    exact.arguments = resume_args(&cli, THREAD);
    let response = provider.run(&registry, exact).unwrap();
    assert_eq!(
      response.launch.unwrap().exclusive_conversation.as_deref(),
      Some(THREAD)
    );
    for alias in ALIASES {
      let mut named = request.clone();
      named.arguments = resume_args(&cli, alias);
      let error = provider.run(&registry, named).unwrap_err().to_string();
      assert!(error.contains("session UUID"), "{alias}: {error}");
      // A lane switch names the conversation itself; the same rule holds.
      let mut switch = request.clone();
      switch.conversation = Some(alias.into());
      let error = provider.run(&registry, switch).unwrap_err().to_string();
      assert!(error.contains("session UUID"), "switch to {alias}: {error}");
    }
  }

  /// The lock is taken on the ID the provider hands back. With the UUID
  /// contract, a second spelling of a locked conversation never gets a key
  /// of its own, so it cannot run beside the first; without one, it could.
  #[test]
  fn two_spellings_of_one_conversation_cannot_both_proceed() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, registry, request, cli) = resumable(temp.path(), Some("uuid"));
    // What a caller does with a prepared launch: lock its conversation.
    let lock = |args: Vec<String>| -> Result<tento_secrets::accounts::Lock> {
      let mut prepared = request.clone();
      prepared.arguments = args;
      let launch = provider
        .run(&registry, prepared)?
        .launch
        .context("no launch")?;
      let sid = launch
        .exclusive_conversation
        .context("no exclusive conversation")?;
      registry.conversation_lock("fixture", &sid)
    };
    let _first = lock(resume_args(&cli, THREAD)).unwrap();
    assert!(
      lock(resume_args(&cli, THREAD)).is_err(),
      "the same spelling is already locked"
    );
    for alias in ALIASES {
      assert!(
        lock(resume_args(&cli, alias)).is_err(),
        "{alias} got a lock of its own"
      );
    }

    // A kind that declares no contract keeps today's behaviour, where two
    // spellings are two keys: the reason the contract exists.
    let other = tempfile::tempdir().unwrap();
    let (provider, registry, request, cli) = resumable(other.path(), None);
    let mut upper = request.clone();
    upper.arguments = resume_args(&cli, ALIASES[1]);
    let sid = provider
      .run(&registry, upper)
      .unwrap()
      .launch
      .unwrap()
      .exclusive_conversation
      .unwrap();
    let _held = registry.conversation_lock("fixture", THREAD).unwrap();
    assert!(registry.conversation_lock("fixture", &sid).is_ok());
  }

  /// The native import's "no default yet" and its "make this the default"
  /// are one decision. Another session choosing a default at the moment
  /// between them (the user's `profiles default`, here on its own thread)
  /// either lands first, and the import sees it, or waits for the import and
  /// then wins: the user's choice is never overwritten. Deterministic: the
  /// other session's move runs at exactly that point, whatever the scheduler
  /// does, and the import waits a bounded time for it to finish.
  #[test]
  fn a_default_chosen_during_a_native_import_is_never_overwritten() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let home = root.join("home");
    std::fs::create_dir_all(home.join(".fixture")).unwrap();
    std::fs::write(
      home.join(".fixture.json"),
      r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#,
    )
    .unwrap();
    let kind = AccountKind::parse(
      &serde_json::json!({
        "schema": "account.kind/v1",
        "app": "fixture",
        "cli": {"name": "fakecli"},
        "credential": {"backend": "native", "root": {"default": "{home}/accounts"}, "locator": "{root}/{alias}"},
        "import": {
          "tsv": "{root}/profiles.tsv",
          "locator": "{root}/{key}",
          "native": {
            "locator": "{home}/.fixture",
            "present": ["{home}/.fixture.json"],
            "alias_from": {"file": "{home}/.fixture.json", "json_pointer": "/oauthAccount/emailAddress"},
            "default_alias": "default"
          }
        }
      })
      .to_string(),
    )
    .unwrap();
    let provider = KindProvider::new(
      kind,
      KindHost {
        home: home.clone(),
        vars: BTreeMap::new(),
        child_env: Some(BTreeMap::new()),
        cwd: root.clone(),
        keychain: None,
        user: None,
        curl: PathBuf::from("/usr/bin/curl"),
      },
    );
    let registry = Registry::at(root.join("store/profiles"));
    let chosen = registry
      .register(
        "fixture",
        "work",
        CredentialRef::Native {
          locator: root.join("accounts/work"),
        },
      )
      .unwrap();

    let (done, finished) = std::sync::mpsc::channel();
    let user = std::sync::Arc::new(std::sync::Mutex::new(None));
    let slot = user.clone();
    let (reg, pick) = (registry.clone(), chosen.clone());
    BEFORE_NATIVE_DEFAULT.set(Some(Box::new(move || {
      let session = std::thread::spawn(move || {
        reg.set_default(&pick).unwrap();
        let _ = done.send(());
      });
      // Long enough for an unlocked write to finish; one that waits for the
      // import's lock does not, and the import goes on holding it.
      let _ = finished.recv_timeout(Duration::from_millis(500));
      *slot.lock().unwrap() = Some(session);
    })));
    provider.profiles(&registry).unwrap();
    assert!(
      BEFORE_NATIVE_DEFAULT.take().is_none(),
      "the import reached its default decision"
    );
    let session = user.lock().unwrap().take().unwrap();
    session.join().unwrap();

    let imported = registry.resolve("fixture", "me").unwrap();
    assert_eq!(
      imported.credential,
      CredentialRef::Native {
        locator: home.join(".fixture")
      }
    );
    assert_eq!(
      registry.default_for("fixture").unwrap().map(|p| p.id),
      Some(chosen.id),
      "the default chosen during the import stays"
    );
  }
}
