//! App account providers.
//!
//! Two doors answer the same `auth.provider/v1` requests:
//! - an **account kind** ([`kind::KindProvider`]): an app's recipe as data
//!   (`account.kind/v1`), run in-process by one generic executor;
//! - an **executable provider** ([`Provider`]): a bundle that declares
//!   `auth.provider/v1`, run as a child with JSON on stdin and metadata only
//!   on stdout.
//!
//! A kind wins over an executable provider for the same app
//! ([`resolve_with_kinds`]): the shipped recipe is policy, and a stale
//! installed plugin must not shadow it.
use anyhow::{Context, Result, ensure};
use std::{
  collections::BTreeMap,
  path::{Path, PathBuf},
  process::Stdio,
};
use tento_secrets::profiles::{self, Binding, Declared, Launch, Profile, Registry};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use tento_secrets::accounts::AccountKind;
pub use tento_secrets::profiles::{ProviderRequest as Request, ProviderResponse as Response};

pub mod kind;
pub use kind::{KindHost, KindProvider, StoreChoice};
#[derive(Clone, Debug)]
pub struct Provider {
  pub app: String,
  pub bin: PathBuf,
  pub command: Vec<String>,
}
pub fn discover(dirs: &[PathBuf]) -> Result<Vec<Provider>> {
  let mut found = BTreeMap::new();
  for bundle in crate::tsh_app::discover_apps(dirs) {
    for cap in &bundle.manifest.provides {
      if cap.type_tag != profiles::PROVIDER_V1 {
        continue;
      }
      // Auth has no lisp door yet. A lisp-backed entry is not an auth
      // provider here, and must not fail discovery for every other bundle.
      if cap.lisp.is_some() {
        continue;
      }
      profiles::component(&cap.id)?;
      ensure!(!cap.command.is_empty(), "Auth provider has no command");
      // App path order is first-wins, matching normal bundle discovery.
      found.entry(cap.id.clone()).or_insert(Provider {
        app: cap.id.clone(),
        bin: bundle.bin.clone(),
        command: cap.command.split_whitespace().map(str::to_owned).collect(),
      });
    }
  }
  Ok(found.into_values().collect())
}
pub fn resolve(dirs: &[PathBuf], app: &str) -> Result<Provider> {
  discover(dirs)?
    .into_iter()
    .find(|p| p.app == app)
    .context("No auth.provider/v1 bundle for this app")
}
impl Provider {
  pub async fn call(&self, request: &Request) -> Result<Response> {
    ensure!(
      request.version == 1 && request.app == self.app,
      "Auth provider request mismatch"
    );
    let mut cmd = tokio::process::Command::new(&self.bin);
    cmd
      .args(&self.command)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .kill_on_drop(true);
    if let Some(env) = tento_env::hermetic_child_env_os() {
      cmd.env_clear().envs(env);
    }
    let mut child = cmd.spawn().context("Cannot start auth provider")?;
    let mut stdin = child
      .stdin
      .take()
      .context("Auth provider stdin unavailable")?;
    let mut stdout = child
      .stdout
      .take()
      .context("Auth provider stdout unavailable")?
      .take(1024 * 1024 + 1);
    let bytes = serde_json::to_vec(request)?;
    tokio::time::timeout(std::time::Duration::from_secs(45), async {
      stdin.write_all(&bytes).await?;
      stdin.shutdown().await?;
      drop(stdin);
      let mut output = Vec::new();
      stdout.read_to_end(&mut output).await?;
      ensure!(
        output.len() <= 1024 * 1024,
        "Auth provider response too large"
      );
      let status = child.wait().await?;
      ensure!(
        status.success(),
        "Auth provider failed; check its installation"
      );
      // Never include the raw response in diagnostics.
      let reply: Response = serde_json::from_slice(&output)
        .map_err(|_| anyhow::anyhow!("Invalid auth provider response"))?;
      read_reply(request, reply, None)
    })
    .await
    .context("Auth provider timed out; profile unchanged")?
  }
  /// The shell owns the catalog: it applies what a provider declares. A
  /// provider that still writes the catalog itself declares IDs the catalog
  /// already holds, and those merge as no-ops.
  fn merge(&self, registry: &Registry, declared: &[Declared]) -> Result<()> {
    for d in declared {
      registry.declare(&self.app, d)?;
    }
    Ok(())
  }
  pub async fn refresh_catalog(&self, registry: &Registry) -> Result<Vec<Profile>> {
    let response = self.call(&Request::new("discover", &self.app)).await?;
    self.merge(registry, &response.profiles)?;
    Ok(
      registry
        .read()?
        .profiles
        .into_iter()
        .filter(|p| p.app == self.app)
        .collect(),
    )
  }
  /// Ask the provider to declare a new alias, merge it, and return the
  /// catalog entry (with the ID the shell assigned when none was declared).
  pub async fn register(&self, registry: &Registry, alias: &str) -> Result<Profile> {
    let alias = alias.trim_start_matches('@');
    profiles::component(alias)?;
    let mut request = Request::new("register", &self.app);
    request.alias = Some(alias.into());
    let response = self.call(&request).await?;
    self.merge(registry, &response.profiles)?;
    registry.resolve(&self.app, alias)
  }
  /// The provider's terminal login command, bound to the profile's references.
  pub async fn login(&self, registry: &Registry, profile: Profile) -> Result<Launch> {
    let mut request = Request::new("login", &self.app);
    request.credential_dir = registry.credential_dir(&profile)?;
    request.profile = Some(profile.clone());
    let mut launch = self
      .call(&request)
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
    let mut request = Request::new("prepare", &self.app);
    request.arguments = arguments;
    request.credential_dir = registry.credential_dir(&profile)?;
    request.profile = Some(profile.clone());
    request.conversation = conversation.map(str::to_owned);
    request.cwd = Some(cwd.into());
    request.source_env = source_env;
    let response = self.call(&request).await?;
    let identity = response
      .identity
      .context("Provider did not confirm account identity")?;
    let mut launch = response
      .launch
      .context("Provider returned no launch plan")?;
    ensure!(
      conversation.is_none() || launch.resume,
      "Provider cannot safely resume this conversation"
    );
    let profile = registry.confirm(&self.app, &profile.id, identity)?;
    launch.bind(registry, &profile)?;
    Ok(Binding { profile, launch })
  }
}

/// Read a provider's reply: an error code becomes its user-facing message
/// (and `login_required` marks the profile in the catalog); anything else is
/// the reply. Shared by both doors so their answers read the same.
pub(crate) fn read_reply(
  request: &Request,
  reply: Response,
  registry: Option<&Registry>,
) -> Result<Response> {
  let Some(code) = &reply.error else {
    return Ok(reply);
  };
  if code == "login_required" {
    if let Some(profile) = &request.profile {
      let default = match registry {
        Some(_) => None,
        None => profiles::default_registry().ok(),
      };
      if let Some(registry) = registry.or(default.as_ref()) {
        let _ = registry.edit(|catalog| {
          if let Some(p) = catalog
            .profiles
            .iter_mut()
            .find(|p| p.app == profile.app && p.id == profile.id)
          {
            p.state = profiles::AuthState::LoginRequired;
          }
          Ok(())
        });
      }
    }
  }
  let message = match code.as_str() {
    "login_required" => "Sign in required; use profiles login, or choose another /profile",
    "identity_mismatch" => "Account identity mismatch; previous profile retained",
    "history_missing" => "Conversation history is missing; profile unchanged",
    "busy" => "Conversation still has active child work; retry the profile change when it finishes",
    "auth_override" => {
      "Harness settings override the selected login; remove the auth override before choosing a profile"
    }
    "network" => "Auth provider could not reach the service; profile unchanged",
    "unsupported" => "Provider cannot safely resume this conversation",
    _ => "Auth provider could not prepare this profile",
  };
  anyhow::bail!("{message}")
}

/// One app's provider, through either door.
#[derive(Clone, Debug)]
pub enum AppProvider {
  Kind(Box<KindProvider>),
  Executable(Provider),
}

impl AppProvider {
  pub fn app(&self) -> &str {
    match self {
      Self::Kind(k) => k.app(),
      Self::Executable(p) => &p.app,
    }
  }
  /// Where `profile`'s account lives and why, when a kind serves the app.
  /// An executable provider does not say.
  pub fn store_for(&self, profile: &Profile) -> Result<Option<kind::StoreChoice>> {
    match self {
      Self::Kind(k) => k.store_for(profile),
      Self::Executable(_) => Ok(None),
    }
  }
  pub async fn refresh_catalog(&self, registry: &Registry) -> Result<Vec<Profile>> {
    match self {
      Self::Kind(k) => k.refresh_catalog(registry).await,
      Self::Executable(p) => p.refresh_catalog(registry).await,
    }
  }
  pub async fn register(&self, registry: &Registry, alias: &str) -> Result<Profile> {
    match self {
      Self::Kind(k) => k.register(registry, alias).await,
      Self::Executable(p) => p.register(registry, alias).await,
    }
  }
  pub async fn login(&self, registry: &Registry, profile: Profile) -> Result<Launch> {
    match self {
      Self::Kind(k) => k.login(registry, profile).await,
      Self::Executable(p) => p.login(registry, profile).await,
    }
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
    match self {
      Self::Kind(k) => {
        k.prepare_run(registry, profile, conversation, cwd, source_env, arguments)
          .await
      }
      Self::Executable(p) => {
        p.prepare_run(registry, profile, conversation, cwd, source_env, arguments)
          .await
      }
    }
  }
}

/// Every app's provider: each kind, then each executable provider for an
/// app no kind serves.
pub fn discover_with_kinds(dirs: &[PathBuf], kinds: &[AccountKind]) -> Result<Vec<AppProvider>> {
  let mut found: BTreeMap<String, AppProvider> = BTreeMap::new();
  if !kinds.is_empty() {
    let host = KindHost::from_process()?;
    for kind in kinds {
      found.entry(kind.app.clone()).or_insert_with(|| {
        AppProvider::Kind(Box::new(KindProvider::new(kind.clone(), host.clone())))
      });
    }
  }
  for provider in discover(dirs)? {
    found
      .entry(provider.app.clone())
      .or_insert(AppProvider::Executable(provider));
  }
  Ok(found.into_values().collect())
}

/// The provider for one app: its kind when there is one, else its
/// executable provider.
pub fn resolve_with_kinds(
  dirs: &[PathBuf],
  kinds: &[AccountKind],
  app: &str,
) -> Result<AppProvider> {
  if let Some(kind) = kinds.iter().find(|k| k.app == app) {
    return Ok(AppProvider::Kind(Box::new(KindProvider::new(
      kind.clone(),
      KindHost::from_process()?,
    ))));
  }
  resolve(dirs, app)
    .map(AppProvider::Executable)
    .context("No account kind or auth.provider/v1 bundle for this app")
}

fn app_identity(app: &crate::tsh_app::TshApp) -> Option<&str> {
  app
    .manifest
    .provides
    .iter()
    .find(|cap| cap.type_tag == profiles::PROVIDER_V1 && cap.lisp.is_none())
    .map(|cap| cap.id.as_str())
}
fn session_root() -> Option<PathBuf> {
  tento_env::effective_var("TENTO_SESSION_DIR")
    .or_else(|| std::env::var("TENTO_SESSION_DIR").ok())
    .map(PathBuf::from)
}
/// Bind in the same declared app instance directory used by dispatch. The
/// shell queue's storage directory can differ from TENTO_SESSION_DIR.
pub fn bind_app_instance(binding: Binding) -> Result<()> {
  profiles::component(&binding.profile.app)?;
  let root = session_root().context("App profile changes need a current tsh app instance")?;
  let path = root.join("auth-apps").join(&binding.profile.app);
  profiles::Instance {
    active: Some(binding),
    ..Default::default()
  }
  .write(&path)
}
pub fn app_binding(app: &crate::tsh_app::TshApp) -> Result<Option<Binding>> {
  let Some(id) = app_identity(app) else {
    return Ok(None);
  };
  let Some(root) = session_root() else {
    return Ok(None);
  };
  profiles::component(id)?;
  Ok(profiles::Instance::read(&root.join("auth-apps").join(id))?.active)
}
/// Materialize a host default once, at first instance use. Future changes to
/// defaults never alter this instance or a running daemon's environment.
pub async fn ensure_app_instance(app: &crate::tsh_app::TshApp) -> Result<()> {
  let Some(id) = app_identity(app) else {
    return Ok(());
  };
  let Some(root) = session_root() else {
    return Ok(());
  };
  profiles::component(id)?;
  let path = root.join("auth-apps").join(id);
  if path.join("auth-profile.json").exists() {
    return Ok(());
  }
  let registry = profiles::default_registry()?;
  let mut instance = profiles::Instance::default();
  if let Some(profile) = registry.default_for(id)? {
    let cap = app
      .manifest
      .provides
      .iter()
      .find(|cap| cap.type_tag == profiles::PROVIDER_V1 && cap.lisp.is_none() && cap.id == id)
      .context("Missing auth capability")?;
    let provider = Provider {
      app: id.into(),
      bin: app.bin.clone(),
      command: cap.command.split_whitespace().map(str::to_owned).collect(),
    };
    instance.active = Some(
      provider
        .prepare(
          &registry,
          profile,
          None,
          &std::env::current_dir()?,
          BTreeMap::new(),
        )
        .await?,
    );
  }
  instance.write(&path)
}
pub fn apply_app_binding(
  app: &crate::tsh_app::TshApp,
  cmd: &mut std::process::Command,
) -> Result<()> {
  if let Some(binding) = app_binding(app)? {
    cmd.envs(&binding.launch.env);
    for key in &binding.launch.remove_env {
      cmd.env_remove(key);
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  #[tokio::test]
  async fn fixture_app_uses_the_contract_without_provider_name_routing() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("fixture.tsh.app");
    std::fs::create_dir_all(&bundle).unwrap();
    std::fs::write(bundle.join("manifest.json"),r#"{"schema":"tsh.app/v1","name":"fixture","version":"1","entrypoint":"provider.py","transport":"oneshot","commands":{},"provides":[{"type":"auth.provider/v1","id":"arbitraryapp","command":"provider","returns":"auth.response/v1"}]}"#).unwrap();
    let script = bundle.join("provider.py");
    std::fs::write(&script,r#"#!/usr/bin/python3
import json,sys
r=json.load(sys.stdin)
if r['operation']=='prepare':
 print(json.dumps({'identity':{'id':'account-1','label':'Fixture'},'launch':{'env':{'TSH_AUTH_PROFILE_ID':r['profile']['id']},'resume':True}}))
else:
 print(json.dumps({'error':'SENTINEL_SECRET_DO_NOT_PRINT'}))
"#).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let p = resolve(&[dir.path().into()], "arbitraryapp").unwrap();
    let reg = Registry::at(dir.path().join("store"));
    let profile = reg
      .register(
        "arbitraryapp",
        "james",
        profiles::CredentialRef::Local {
          key: "session".into(),
        },
      )
      .unwrap();
    let binding = p
      .prepare(
        &reg,
        profile,
        Some("conversation"),
        dir.path(),
        BTreeMap::new(),
      )
      .await
      .unwrap();
    assert_eq!(binding.profile.identity.unwrap().id, "account-1");
    let error = p
      .call(&Request::new("status", "arbitraryapp"))
      .await
      .unwrap_err();
    assert!(!format!("{error:#}").contains("SENTINEL_SECRET"));
    assert_eq!(discover(&[dir.path().into()]).unwrap().len(), 1);
  }

  /// A provider that declares instead of writing: IDs come from the shell,
  /// rediscovery is idempotent, and every profile call carries the
  /// credential directory — in the request and in the bound launch env.
  #[tokio::test]
  async fn the_shell_merges_declared_profiles_and_passes_the_credential_directory() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("declaring.tsh.app");
    std::fs::create_dir_all(&bundle).unwrap();
    std::fs::write(bundle.join("manifest.json"),r#"{"schema":"tsh.app/v1","name":"declaring","version":"1","entrypoint":"provider.py","transport":"oneshot","commands":{},"provides":[{"type":"auth.provider/v1","id":"declaringapp","command":"provider","returns":"auth.response/v1"}]}"#).unwrap();
    let script = bundle.join("provider.py");
    std::fs::write(&script,r#"#!/usr/bin/python3
import json,sys
r=json.load(sys.stdin)
local={'backend':'local','key':'session'}
op=r['operation']
if op=='discover':
 print(json.dumps({'profiles':[{'alias':'default','credential':local}]}))
elif op=='register':
 print(json.dumps({'profiles':[{'alias':r['alias'],'credential':local}]}))
elif op=='login':
 print(json.dumps({'launch':{'env':{'SEEN_DIR':r['credential_dir']},'argv':['login']}}))
elif op=='prepare':
 print(json.dumps({'identity':{'id':'account-1','label':'Fixture'},'launch':{'env':{'SEEN_DIR':r['credential_dir'],'TSH_AUTH_PROFILE_ID':'provider-guess'}}}))
else:
 print(json.dumps({'error':'unsupported'}))
"#).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let p = resolve(&[dir.path().into()], "declaringapp").unwrap();
    let reg = Registry::at(dir.path().join("store"));

    let listed = p.refresh_catalog(&reg).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].alias, "default");
    let again = p.refresh_catalog(&reg).await.unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].id, listed[0].id);

    let work = p.register(&reg, "@work").await.unwrap();
    assert_eq!(work.alias, "work");
    assert_ne!(work.id, listed[0].id);
    assert_eq!(reg.read().unwrap().profiles.len(), 2);

    let expected = reg.root.join("declaringapp").join(&work.id);
    let binding = p
      .prepare(&reg, work.clone(), None, dir.path(), BTreeMap::new())
      .await
      .unwrap();
    assert_eq!(binding.profile.identity.unwrap().id, "account-1");
    assert_eq!(Path::new(&binding.launch.env["SEEN_DIR"]), expected);
    assert_eq!(
      Path::new(&binding.launch.env[profiles::ENV_CREDENTIAL_DIR]),
      expected
    );
    assert_eq!(binding.launch.env[profiles::ENV_PROFILE_ID], work.id);
    assert_eq!(binding.launch.env[profiles::ENV_APP], "declaringapp");

    let login = p.login(&reg, work.clone()).await.unwrap();
    assert_eq!(Path::new(&login.env["SEEN_DIR"]), expected);
    assert_eq!(
      Path::new(&login.env[profiles::ENV_CREDENTIAL_DIR]),
      expected
    );
  }
}
