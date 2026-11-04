//! Named environment profiles — where a run's *network identity* comes from.
//!
//! The browser layer used to hardcode the product's network identity: every
//! headless run mapped `*.lona.so` to `127.0.0.1`, rewrote sub-resource ports to
//! the host's dev port, and ignored certificate errors. That is exactly right
//! for a laptop driving its own dev server, and exactly wrong for a CI host
//! asked to measure a *remote* server — it silently measured its own localhost
//! instead, and reported the answer as if it had reached `dev.lona.so`.
//!
//! A profile names the three knobs that difference turns on:
//!
//! - [`Resolver`] — whether Chrome gets the loopback `--host-resolver-rules` MAP
//!   (and therefore the sub-resource port rewrite) or resolves real public DNS.
//! - [`Tls`] — whether certificate errors are ignored (a self-signed dev cert) or
//!   enforced (a real public endpoint).
//! - `server_host` — the host slug the product's URL grammar resolves against
//!   (lona: `{slug}--{app}.lona.so`), overriding the one derived from the running
//!   environment.
//!
//! Profiles live **with the corpus**, at `<corpus-root>/.envs/<name>.yaml`, for
//! the same reason specs do: which environments a suite can be pointed at is a
//! property of that suite, reviewed in the same diff. The dot-prefix keeps the
//! directory out of group enumeration (see [`crate::folder`], which skips every
//! dot-dir).
//!
//! `local` is a **built-in**, not a file: with no `--env` flag the run uses
//! [`EnvProfile::builtin_local`], which reproduces today's behaviour byte for
//! byte. `.envs/local.yaml` exists as documentation and as the explicit spelling
//! (`--env local`), and resolves to the same thing on a host whose `dev_port` is
//! the port it names.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

/// Directory, relative to the corpus root, that holds the profiles.
pub const ENVS_DIR: &str = ".envs";

/// How the runner's Chrome resolves the product's hostnames.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolver {
  /// `MAP *.lona.so 127.0.0.1` plus the sub-resource port rewrite — the browser
  /// never leaves the machine it runs on.
  Loopback,
  /// No resolver rules: real DNS, real network, real remote server.
  Public,
}

/// Which scheme a run's URLs are built with.
///
/// Part of the env profile for the same reason [`Resolver`] and [`Tls`] are: it
/// is the network identity of the server being measured, not a property of the
/// suite. An app served over plain HTTP — a loopback front door with no TLS
/// anywhere — was previously untestable, because the URL builder said `https`
/// unconditionally and nothing in a corpus could change it. The workaround was
/// a TLS proxy sidecar per app, which is a lot of machinery to spell one word.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scheme {
  /// The default, and what every corpus written before this field assumed.
  #[default]
  Https,
  Http,
}

impl Scheme {
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::Https => "https",
      Self::Http => "http",
    }
  }
}

/// How the runner's Chrome treats certificate errors.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tls {
  /// `--ignore-certificate-errors` — a dev server's self-signed cert.
  IgnoreErrors,
  /// Certificates are verified; a bad cert fails the run.
  Strict,
}

/// The on-disk shape. Every field but `resolver` is optional, so a profile says
/// only what it changes; defaults are applied in [`EnvProfile::from_raw`].
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEnvProfile {
  resolver: Resolver,
  #[serde(default)]
  port: Option<String>,
  #[serde(default)]
  tls: Option<Tls>,
  #[serde(default)]
  server_host: Option<String>,
  #[serde(default)]
  scheme: Option<Scheme>,
}

/// A resolved environment profile: the network identity one run drives against.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvProfile {
  /// Profile name, for diagnostics (`local` for the built-in).
  pub name: String,
  pub resolver: Resolver,
  /// Loopback rewrite port. `None` ⇒ defer to the host's own `dev_port()`.
  /// Meaningless — and rejected — on a `public` profile.
  pub port: Option<String>,
  pub tls: Tls,
  /// Host slug override for the product's URL grammar. `None` ⇒ the host's own.
  pub server_host: Option<String>,
  /// The scheme this environment is reached over. Defaults to `https`, so a
  /// profile that does not mention it behaves exactly as it did before.
  pub scheme: Scheme,
}

impl EnvProfile {
  /// The implicit default: today's behaviour, in code rather than in a file.
  ///
  /// `port: None` is deliberate — the built-in defers to the host's `dev_port()`
  /// rather than naming a port of its own, so a run with no `--env` produces
  /// exactly the plan it produced before profiles existed.
  pub fn builtin_local() -> Self {
    Self {
      name: "local".to_string(),
      resolver: Resolver::Loopback,
      port: None,
      tls: Tls::IgnoreErrors,
      server_host: None,
      scheme: Scheme::Https,
    }
  }

  /// Load `<corpus_root>/.envs/<name>.yaml`.
  ///
  /// An unknown name or an unparseable file is a hard error naming the profiles
  /// that *do* exist — a typo'd `--env` must never fall back to loopback and
  /// quietly measure the wrong machine, which is the entire failure this
  /// mechanism exists to prevent.
  pub fn load(corpus_root: &Path, name: &str) -> Result<Self> {
    let path = profile_path(corpus_root, name);
    if !path.exists() {
      bail!(
        "unknown env profile '{name}' (looked for {})\n  available: {}",
        path.display(),
        describe_available(corpus_root)
      );
    }
    let content = std::fs::read_to_string(&path)
      .with_context(|| format!("read env profile {}", path.display()))?;
    let raw: RawEnvProfile = serde_yml::from_str(&content).with_context(|| {
      format!(
        "parse env profile {} (available: {})",
        path.display(),
        describe_available(corpus_root)
      )
    })?;
    Self::from_raw(name, raw).with_context(|| format!("invalid env profile {}", path.display()))
  }

  fn from_raw(name: &str, raw: RawEnvProfile) -> Result<Self> {
    if raw.resolver == Resolver::Public && raw.port.is_some() {
      bail!(
        "`port` is only meaningful for a loopback resolver — a public profile \
reaches the server on the port its URL carries. Drop `port`, or set \
`resolver: loopback`."
      );
    }
    // TLS default follows the resolver, because that is what the resolver
    // implies: loopback means a dev server's self-signed cert, public means a
    // real endpoint whose cert had better verify.
    let tls = raw.tls.unwrap_or(match raw.resolver {
      Resolver::Loopback => Tls::IgnoreErrors,
      Resolver::Public => Tls::Strict,
    });
    Ok(Self {
      name: name.to_string(),
      resolver: raw.resolver,
      port: raw.port,
      tls,
      server_host: raw.server_host,
      scheme: raw.scheme.unwrap_or_default(),
    })
  }

  /// Resolve `--env <name>` (or its absence) against the corpus root.
  ///
  /// `None` ⇒ [`builtin_local`](Self::builtin_local), with no requirement that
  /// `.envs/local.yaml` exist. A named profile on a host with no corpus root is
  /// an error rather than a silent fallback.
  pub fn resolve(corpus_root: Option<&Path>, name: Option<&str>) -> Result<Self> {
    let Some(name) = name else {
      return Ok(Self::builtin_local());
    };
    let root = corpus_root.ok_or_else(|| {
      anyhow!("--env {name} needs a .ux-tests corpus root, and this host configures none")
    })?;
    Self::load(root, name)
  }

  /// The port the runner rewrites sub-resource requests to, given the host's own
  /// declared dev port.
  ///
  /// Public profiles rewrite nothing: the URL already carries whatever port the
  /// remote server listens on, and injecting the local dev port would point the
  /// browser at a port the remote host does not serve.
  pub fn dev_port(&self, host_dev_port: Option<String>) -> Option<String> {
    match self.resolver {
      Resolver::Loopback => self.port.clone().or(host_dev_port),
      Resolver::Public => None,
    }
  }

  /// Whether the runner's Chrome ignores certificate errors.
  pub fn ignore_https_errors(&self) -> bool {
    self.tls == Tls::IgnoreErrors
  }
}

fn profile_path(corpus_root: &Path, name: &str) -> PathBuf {
  corpus_root.join(ENVS_DIR).join(format!("{name}.yaml"))
}

/// Profile names available under `<corpus_root>/.envs`, sorted.
pub fn available_profiles(corpus_root: &Path) -> Vec<String> {
  let Ok(entries) = std::fs::read_dir(corpus_root.join(ENVS_DIR)) else {
    return Vec::new();
  };
  let mut names: Vec<String> = entries
    .filter_map(|e| e.ok())
    .filter_map(|e| {
      let path = e.path();
      let name = path.file_name()?.to_str()?;
      name.strip_suffix(".yaml").map(str::to_string)
    })
    .collect();
  names.sort();
  names
}

/// Human-readable profile list for an error message. `local` is always offered
/// because it is built in even when nobody wrote the file.
fn describe_available(corpus_root: &Path) -> String {
  let mut names = available_profiles(corpus_root);
  if !names.iter().any(|n| n == "local") {
    names.push("local".to_string());
    names.sort();
  }
  names.join(", ")
}

#[cfg(test)]
mod tests {
  use super::*;

  /// An app served over plain HTTP — a loopback front door with no TLS — was
  /// untestable before this field: the URL builder said `https` unconditionally
  /// and the only workaround was a TLS proxy sidecar per app.
  #[test]
  fn a_profile_can_declare_http() {
    let dir = scratch("http-scheme");
    std::fs::write(
      dir.join(ENVS_DIR).join("local-http.yaml"),
      "resolver: loopback\nport: \"4720\"\nscheme: http\n",
    )
    .unwrap();
    assert_eq!(
      EnvProfile::load(&dir, "local-http").unwrap().scheme,
      Scheme::Http
    );
  }

  /// Every profile written before the field existed, and the built-in, keep
  /// saying https — the field is additive or it is a breaking change.
  #[test]
  fn a_profile_that_omits_the_scheme_is_https() {
    let dir = scratch("default-scheme");
    std::fs::write(dir.join(ENVS_DIR).join("plain.yaml"), "resolver: public\n").unwrap();
    assert_eq!(
      EnvProfile::load(&dir, "plain").unwrap().scheme,
      Scheme::Https
    );
    assert_eq!(EnvProfile::builtin_local().scheme, Scheme::Https);
  }

  /// A unique scratch dir under the system temp dir (no tempfile dep), matching
  /// the pattern `folder.rs` tests use.
  fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "ux-env-profile-{tag}-{}",
      uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(dir.join(ENVS_DIR)).unwrap();
    dir
  }

  fn write(root: &Path, name: &str, body: &str) {
    std::fs::write(profile_path(root, name), body).unwrap();
  }

  #[test]
  fn builtin_local_defers_to_the_host_dev_port() {
    let profile = EnvProfile::builtin_local();
    assert_eq!(profile.resolver, Resolver::Loopback);
    assert_eq!(profile.dev_port(Some("8443".to_string())), Some("8443".to_string()));
    assert_eq!(profile.dev_port(None), None);
    assert!(profile.ignore_https_errors());
  }

  #[test]
  fn absent_flag_resolves_to_the_builtin_without_touching_disk() {
    let profile = EnvProfile::resolve(None, None).unwrap();
    assert_eq!(profile, EnvProfile::builtin_local());
  }

  #[test]
  fn loads_the_loopback_shape() {
    let root = scratch("loopback");
    write(
      &root,
      "local",
      "resolver: loopback\nport: \"8443\"\ntls: ignore-errors\nserver_host: dev\n",
    );

    let profile = EnvProfile::load(&root, "local").unwrap();
    assert_eq!(profile.resolver, Resolver::Loopback);
    assert_eq!(profile.tls, Tls::IgnoreErrors);
    assert_eq!(profile.server_host.as_deref(), Some("dev"));
    // The file's own port wins over the host's.
    assert_eq!(profile.dev_port(Some("9999".to_string())), Some("8443".to_string()));
  }

  #[test]
  fn loads_the_public_shapes_and_rewrites_no_port() {
    let root = scratch("public");
    write(&root, "dev", "resolver: public\ntls: strict\nserver_host: dev\n");
    write(&root, "rc", "resolver: public\ntls: strict\nserver_host: rc\n");

    let dev = EnvProfile::load(&root, "dev").unwrap();
    assert_eq!(dev.resolver, Resolver::Public);
    assert_eq!(dev.tls, Tls::Strict);
    assert!(!dev.ignore_https_errors());
    // Even when the host declares a dev port, a public run must not inject it.
    assert_eq!(dev.dev_port(Some("8443".to_string())), None);

    let rc = EnvProfile::load(&root, "rc").unwrap();
    assert_eq!(rc.server_host.as_deref(), Some("rc"));
  }

  #[test]
  fn tls_defaults_follow_the_resolver() {
    let root = scratch("tls-default");
    write(&root, "loop", "resolver: loopback\n");
    write(&root, "pub", "resolver: public\n");

    assert_eq!(EnvProfile::load(&root, "loop").unwrap().tls, Tls::IgnoreErrors);
    assert_eq!(EnvProfile::load(&root, "pub").unwrap().tls, Tls::Strict);
  }

  #[test]
  fn port_on_a_public_profile_is_rejected() {
    let root = scratch("port-public");
    write(&root, "bad", "resolver: public\nport: \"8443\"\n");

    let error = format!("{:#}", EnvProfile::load(&root, "bad").unwrap_err());
    assert!(error.contains("only meaningful for a loopback resolver"), "{error}");
  }

  #[test]
  fn unknown_name_lists_the_candidates() {
    let root = scratch("unknown");
    write(&root, "dev", "resolver: public\n");
    write(&root, "rc", "resolver: public\n");

    let error = format!("{:#}", EnvProfile::load(&root, "prod").unwrap_err());
    assert!(error.contains("unknown env profile 'prod'"), "{error}");
    assert!(error.contains("dev, local, rc"), "{error}");
  }

  #[test]
  fn unparseable_profile_is_a_hard_error() {
    let root = scratch("unparseable");
    write(&root, "broken", "resolver: sideways\n");

    let error = format!("{:#}", EnvProfile::load(&root, "broken").unwrap_err());
    assert!(error.contains("parse env profile"), "{error}");
  }
}
