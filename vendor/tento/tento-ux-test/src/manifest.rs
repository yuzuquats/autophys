//! The corpus's description of the app it tests.
//!
//! `<corpus-root>/app.yaml`, a sibling of the `.envs/` profiles. Everything the
//! harness would otherwise have to know about a specific product — which
//! hostnames are its own, which cookie carries its auth, which host label names
//! an environment, which account a headless run falls back to — is stated here
//! by the corpus rather than compiled into the machinery.
//!
//! **Why the corpus and not the host config.** A corpus travels with the app,
//! in the app's own repository, and an adopter who cannot link this crate can
//! still write this file. That is the whole point: the manifest is the one
//! artifact a third-party app must produce, and it is data.
//!
//! **Absent is a legitimate state.** A corpus with no `app.yaml` is not an
//! error — it is an app that has declared nothing, and every consumer degrades
//! rather than guessing. The loopback resolver then maps only the target
//! hostname the run already names, no auth cookie is set, and no origin is
//! classified as production. Each of those is a smaller claim than the truth,
//! which is the correct direction to be wrong in.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// The manifest's filename, relative to the corpus root.
pub const MANIFEST_FILE: &str = "app.yaml";

/// The contract version this build understands. A manifest declaring a NEWER
/// version is refused at load rather than partially honoured — see
/// [`AppManifest::load`].
pub const CONTRACT_VERSION: u32 = 1;

/// What a corpus says about the app it covers.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AppManifest {
  /// Stable identifier, used as the app's key wherever runs are namespaced.
  pub id: String,

  /// Display name for a board. Absent ⇒ consumers show [`AppManifest::id`].
  #[serde(default)]
  pub name: Option<String>,

  /// The hostnames that ARE this app, apex and wildcards alike. One list, read
  /// by three separate consumers — the resolver rules, the sub-resource port
  /// rewrite, and the console's production check — because when they each
  /// carried their own copy they could disagree, and a run whose page came from
  /// one server and whose scripts came from another produced a plausible number
  /// instead of an error.
  #[serde(default)]
  pub domains: Vec<String>,

  /// Which of [`AppManifest::domains`] the loopback resolver maps to
  /// `127.0.0.1`. Absent ⇒ the wildcard entries only.
  ///
  /// Separate from `domains` because the two answer different questions. A bare
  /// apex is part of the app's identity but is reached by being the run's
  /// target, not by a blanket MAP — mapping it as well would silently redirect
  /// an apex a run never asked for.
  #[serde(default)]
  pub resolve: Option<Vec<String>>,

  /// Which leftmost host label names which environment, e.g.
  /// `prod: [prod, www]`. An app whose environments are paths, ports or
  /// unrelated domains leaves this empty, and every target reads as `other`.
  #[serde(default)]
  pub env_prefixes: BTreeMap<String, Labels>,

  /// The app's environments **in promotion order** — the columns a board draws
  /// and the order a run report walks them, e.g. `[dev, rc, prod]`.
  ///
  /// Optional because [`AppManifest::env_prefixes`] and
  /// [`AppManifest::default_env`] already name every environment the manifest
  /// can classify; what they cannot say is the ORDER, and a `BTreeMap` answers
  /// that alphabetically (`dev, prod, rc`), which is nobody's promotion path.
  /// See [`AppManifest::environments`] for the derivation when this is absent.
  #[serde(default)]
  pub environments: Option<Vec<String>>,

  /// The environment an owned host names when its leftmost label matches no
  /// entry in [`AppManifest::env_prefixes`] — lona's unprefixed hosts
  /// (`lona.so`, `calendar.lona.so`) are production, and nothing in the label
  /// says so.
  ///
  /// Deliberately narrower than "a default": it applies only to a host this app
  /// OWNS. An unrecognised origin belonging to nobody stays `None`, because a
  /// target nobody can classify is the one a reader most needs to see, and
  /// folding it into the majority bucket is how it disappears.
  #[serde(default)]
  pub default_env: Option<String>,

  /// The account a headless run authenticates as when neither `--user` nor the
  /// spec names one. Absent ⇒ such a spec cannot be driven headless here, and
  /// the run stops before minting anything.
  #[serde(default)]
  pub default_user: Option<String>,

  /// Where the app answers host verbs, for a verb table that does not live in
  /// this process. Absent ⇒ only the core verbs are available.
  #[serde(default)]
  pub verb_endpoint: Option<String>,

  /// Path, on every environment origin, where the app states which build is
  /// serving — e.g. `/_/app/version`. Absent ⇒ nothing asks, and a board that
  /// wanted to name the build under an environment column says nothing rather
  /// than guessing.
  ///
  /// A path and not a URL, because the question is asked once per environment
  /// and the origin is [`AppManifest::origin_of_env`]'s answer. The endpoint is
  /// expected to reply with JSON carrying `serverVersion`, `serverHost` and a
  /// `feVersion` object of `version` / `gitHash` / `builtAt`. Every field is
  /// optional to a reader and a missing one is simply not shown, so an app that
  /// answers half of it is not an app that answers wrongly.
  #[serde(default)]
  pub version_endpoint: Option<String>,

  /// How a browser presents the app's credentials.
  #[serde(default)]
  pub auth: Option<AuthConfig>,

  /// The contract version this manifest is written against.
  #[serde(default = "default_contract")]
  pub contract: u32,
}

/// One or more host labels. YAML may write either `dev: dev` or
/// `prod: [prod, www]`; both are the same thing and authors should not have to
/// remember which.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Labels {
  One(String),
  Many(Vec<String>),
}

impl Labels {
  pub fn contains(&self, label: &str) -> bool {
    match self {
      Self::One(value) => value == label,
      Self::Many(values) => values.iter().any(|value| value == label),
    }
  }
}

/// The browser-side credential the harness installs for a run.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthConfig {
  /// Cookie name. The WebSocket handshake cannot carry an Authorization header
  /// but cookies ride it automatically, which is why this exists at all.
  pub cookie: String,
}

fn default_contract() -> u32 {
  CONTRACT_VERSION
}

impl AppManifest {
  /// Load `<corpus_root>/app.yaml`.
  ///
  /// `Ok(None)` when the file is absent — see the module note on why that is a
  /// state and not a failure. A file that exists but does not parse IS a
  /// failure: someone wrote it intending it to be read.
  pub fn load(corpus_root: &Path) -> Result<Option<Self>> {
    let path = manifest_path(corpus_root);
    let text = match std::fs::read_to_string(&path) {
      Ok(text) => text,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
      Err(error) => {
        return Err(error).with_context(|| format!("read {}", path.display()));
      }
    };
    let manifest: Self = serde_yml::from_str(&text)
      .with_context(|| format!("parse {}", path.display()))?;
    if manifest.contract > CONTRACT_VERSION {
      bail!(
        "{} declares contract {} but this build understands {CONTRACT_VERSION}",
        path.display(),
        manifest.contract
      );
    }
    if manifest.id.trim().is_empty() {
      bail!("{} has an empty `id`", path.display());
    }
    Ok(Some(manifest))
  }

  /// [`AppManifest::load`] against a corpus root that may not exist. A host
  /// configuring no corpus has no manifest, which is not an error.
  pub fn resolve(corpus_root: Option<&Path>) -> Result<Option<Self>> {
    match corpus_root {
      Some(root) => Self::load(root),
      None => Ok(None),
    }
  }

  /// Display name, falling back to the id.
  pub fn display_name(&self) -> &str {
    self.name.as_deref().unwrap_or(&self.id)
  }

  /// The hostname patterns the loopback resolver maps to `127.0.0.1`.
  pub fn resolve_patterns(&self) -> Vec<String> {
    match &self.resolve {
      Some(explicit) => explicit.clone(),
      None => self
        .domains
        .iter()
        .filter(|domain| domain.starts_with('*'))
        .cloned()
        .collect(),
    }
  }

  /// The cookie domain an auth cookie is set on: the widest wildcard the app
  /// claims, with its `*` removed (`*.example.com` ⇒ `.example.com`). `None`
  /// when the app claims no wildcard, in which case the cookie belongs to the
  /// exact origin and the browser's own default is right.
  pub fn cookie_domain(&self) -> Option<String> {
    self
      .domains
      .iter()
      .find(|domain| domain.starts_with("*."))
      .map(|domain| domain.trim_start_matches('*').to_string())
  }

  /// Whether `host` belongs to this app, apex or subdomain.
  pub fn owns_host(&self, host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    self.domains.iter().any(|domain| {
      let domain = domain.to_ascii_lowercase();
      match domain.strip_prefix("*.") {
        Some(suffix) => host.ends_with(&format!(".{suffix}")),
        None => host == domain,
      }
    })
  }

  /// Every environment this manifest can name, in promotion order.
  ///
  /// The explicit [`AppManifest::environments`] list wins verbatim — including
  /// any name it carries that no prefix maps to, because a column an app asks
  /// for is a column even before anything has run there. Absent, the set is
  /// the prefix keys plus the default, ordered by the one promotion ladder the
  /// common names share (`dev` before `rc` before `prod`) and then
  /// alphabetically, so an app with unusual names still gets a stable order
  /// rather than the map's.
  pub fn environments(&self) -> Vec<String> {
    if let Some(explicit) = &self.environments {
      let mut seen = Vec::new();
      for name in explicit {
        let name = name.trim();
        if !name.is_empty() && !seen.iter().any(|s: &String| s == name) {
          seen.push(name.to_string());
        }
      }
      return seen;
    }
    let mut names: Vec<String> = self.env_prefixes.keys().cloned().collect();
    if let Some(default) = &self.default_env {
      if !names.iter().any(|n| n == default) {
        names.push(default.clone());
      }
    }
    names.sort_by_key(|name| (promotion_rank(name), name.clone()));
    names
  }

  /// The origin an environment lives at — the inverse of
  /// [`AppManifest::env_of_host`], and the only thing that turns a column name
  /// on a board back into somewhere to ask a question.
  ///
  /// Built from what the manifest already states rather than from a second
  /// list: the app's apex is its first non-wildcard domain, an environment a
  /// prefix names sits on that prefix's leftmost label, and the
  /// [`AppManifest::default_env`] is the apex itself — which is what
  /// `default_env` means (`lona.so` IS production, and nothing in the label
  /// says so). `None` for an app with no apex, or for a name no prefix claims
  /// and the default does not answer for: an origin nobody declared is not one
  /// to invent.
  ///
  /// Always `https`. The environments a board draws are deployed ones; a
  /// loopback target is a run's own business and reaches a reader through the
  /// ledger, never through a name.
  pub fn origin_of_env(&self, env: &str) -> Option<String> {
    let apex = self
      .domains
      .iter()
      .find(|domain| !domain.starts_with("*."))?
      .to_ascii_lowercase();
    if self.default_env.as_deref() == Some(env) {
      return Some(format!("https://{apex}"));
    }
    let labels = self.env_prefixes.get(env)?;
    let label = match labels {
      Labels::One(one) => one.as_str(),
      Labels::Many(many) => many.first()?.as_str(),
    };
    Some(format!("https://{label}.{apex}"))
  }

  /// The environment `host` names, from its leftmost label. `None` when this
  /// app claims no such label — deliberately not a guess, because a target
  /// nobody can classify is the one a reader most needs to see.
  pub fn env_of_host(&self, host: &str) -> Option<&str> {
    let host = host.to_ascii_lowercase();
    let label = host.split('.').next().unwrap_or_default();
    // A `{env}--{app}` subdomain carries the environment before the separator.
    let prefix = match label.find("--") {
      Some(at) => &label[..at],
      None => label,
    };
    if let Some((env, _)) = self
      .env_prefixes
      .iter()
      .find(|(_, labels)| labels.contains(prefix))
    {
      return Some(env.as_str());
    }
    // A host this app owns whose label names no environment falls to the app's
    // stated default; one it does not own falls to nothing.
    if self.owns_host(&host) {
      return self.default_env.as_deref();
    }
    None
  }
}

/// Where a common environment name sits on the promotion ladder. Names the
/// ladder does not know sort after it, alphabetically — a fallback for a
/// manifest that declares prefixes but no `environments` list, never the
/// vocabulary itself.
fn promotion_rank(name: &str) -> u8 {
  match name {
    "local" => 0,
    "dev" | "development" => 1,
    "test" | "testing" | "qa" => 2,
    "staging" | "stage" | "preview" => 3,
    "rc" | "canary" | "beta" => 4,
    "prod" | "production" | "live" => 5,
    _ => 6,
  }
}

fn manifest_path(corpus_root: &Path) -> PathBuf {
  corpus_root.join(MANIFEST_FILE)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn lona() -> AppManifest {
    serde_yml::from_str(
      r#"
id: lona
name: Lona
domains: ["lona.so", "*.lona.so"]
env_prefixes:
  dev: dev
  rc: rc
  prod: [prod, www]
default_env: prod
default_user: operator-tester@lona.so
auth:
  cookie: x_api_token
"#,
    )
    .expect("parse")
  }

  #[test]
  fn an_absent_manifest_is_a_state_not_an_error() {
    let dir = std::env::temp_dir().join(format!("uxm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    assert_eq!(AppManifest::load(&dir).expect("load"), None);
    assert_eq!(AppManifest::resolve(None).expect("resolve"), None);
    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn a_malformed_manifest_is_an_error_because_someone_meant_it_to_be_read() {
    let dir = std::env::temp_dir().join(format!("uxm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(manifest_path(&dir), "id: lona\nwhat_is_this: 1\n").expect("write");
    let err = AppManifest::load(&dir).expect_err("unknown field must fail");
    assert!(format!("{err:#}").contains("what_is_this"), "{err:#}");
    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn a_newer_contract_is_refused_rather_than_partially_honoured() {
    let dir = std::env::temp_dir().join(format!("uxm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(manifest_path(&dir), "id: lona\ncontract: 99\n").expect("write");
    let err = AppManifest::load(&dir).expect_err("future contract must fail");
    assert!(format!("{err:#}").contains("understands"), "{err:#}");
    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn the_apex_is_owned_but_not_resolver_mapped() {
    let manifest = lona();
    assert!(manifest.owns_host("lona.so"));
    assert!(manifest.owns_host("dev--calendar.lona.so"));
    assert!(!manifest.owns_host("example.com"));
    // Only the wildcard is MAPped: an apex reaches loopback by being the run's
    // target, and a blanket MAP would redirect one nobody asked for.
    assert_eq!(manifest.resolve_patterns(), vec!["*.lona.so".to_string()]);
  }

  #[test]
  fn an_environment_resolves_back_to_the_origin_it_lives_at() {
    let manifest = lona();
    assert_eq!(
      manifest.origin_of_env("rc").as_deref(),
      Some("https://rc.lona.so"),
      "a prefixed environment sits on its label"
    );
    assert_eq!(
      manifest.origin_of_env("prod").as_deref(),
      Some("https://lona.so"),
      "the default environment IS the apex — prod.lona.so does not exist"
    );
    assert_eq!(
      manifest.origin_of_env("qa"),
      None,
      "a name no prefix claims has no origin to invent"
    );
  }

  #[test]
  fn an_app_with_only_a_wildcard_has_no_apex_to_build_an_origin_on() {
    let manifest: AppManifest =
      serde_yml::from_str("id: x\ndomains: [\"*.example.com\"]\nenv_prefixes:\n  rc: rc\n")
        .expect("parse");
    assert_eq!(manifest.origin_of_env("rc"), None);
  }

  #[test]
  fn the_cookie_domain_comes_off_the_wildcard() {
    assert_eq!(lona().cookie_domain().as_deref(), Some(".lona.so"));
  }

  #[test]
  fn env_reads_the_leftmost_label_through_the_subdomain_separator() {
    let manifest = lona();
    assert_eq!(manifest.env_of_host("dev.lona.so"), Some("dev"));
    assert_eq!(manifest.env_of_host("dev--calendar.lona.so"), Some("dev"));
    assert_eq!(manifest.env_of_host("rc--calendar.lona.so"), Some("rc"));
    assert_eq!(manifest.env_of_host("www.lona.so"), Some("prod"));
  }

  #[test]
  fn an_owned_host_with_no_prefix_falls_to_the_stated_default() {
    let manifest = lona();
    // lona's unprefixed hosts are production, and nothing in the label says so.
    assert_eq!(manifest.env_of_host("lona.so"), Some("prod"));
    assert_eq!(manifest.env_of_host("calendar.lona.so"), Some("prod"));
    // A host this app does not own is not classified at all — the bucket a
    // reader most needs to see is the one nobody can name.
    assert_eq!(manifest.env_of_host("example.com"), None);
  }

  #[test]
  fn without_a_default_an_unprefixed_owned_host_stays_unclassified() {
    let mut manifest = lona();
    manifest.default_env = None;
    assert_eq!(manifest.env_of_host("calendar.lona.so"), None);
    assert_eq!(manifest.env_of_host("dev--calendar.lona.so"), Some("dev"));
  }

  #[test]
  fn environments_derive_in_promotion_order_not_map_order() {
    // The BTreeMap would say dev, prod, rc. The ladder says dev, rc, prod.
    assert_eq!(lona().environments(), vec!["dev", "rc", "prod"]);
  }

  #[test]
  fn the_default_env_joins_the_derived_set_once() {
    let mut manifest = lona();
    manifest.env_prefixes.remove("prod");
    // `prod` is now only the default, and it still gets its column — last.
    assert_eq!(manifest.environments(), vec!["dev", "rc", "prod"]);
    manifest.default_env = None;
    assert_eq!(manifest.environments(), vec!["dev", "rc"]);
  }

  #[test]
  fn an_explicit_list_wins_verbatim_and_deduplicated() {
    let mut manifest = lona();
    manifest.environments = Some(vec!["prod".into(), " dev ".into(), "dev".into(), "sandbox".into()]);
    // Order is the author's, whitespace and repeats are not, and a name no
    // prefix maps to is still a column.
    assert_eq!(manifest.environments(), vec!["prod", "dev", "sandbox"]);
  }

  #[test]
  fn unknown_names_sort_after_the_ladder_alphabetically() {
    let manifest: AppManifest = serde_yml::from_str(
      "id: x\nenv_prefixes:\n  zeta: z\n  prod: p\n  alpha: a\n",
    )
    .expect("parse");
    assert_eq!(manifest.environments(), vec!["prod", "alpha", "zeta"]);
  }

  #[test]
  fn a_scalar_and_a_list_of_labels_are_the_same_thing() {
    assert!(Labels::One("dev".into()).contains("dev"));
    assert!(Labels::Many(vec!["prod".into(), "www".into()]).contains("www"));
    assert!(!Labels::Many(vec!["prod".into()]).contains("dev"));
  }
}
