//! Per-import child environment. Bindings hold vault addresses, never plaintext keys.
//!
//! **Only rc policy binds a secret.** A `(secret.file "ns/name")` token is an
//! ordinary tagged string anyone can write, so binding one is what reaches the
//! vault: each later spawn decrypts it into the child. [`Bindings::set`]
//! therefore takes the caller's [`Authority`], and the `<ns>.env.bind` native
//! asks the host for it through the probe installed with
//! [`set_rc_policy_probe`] — true only while the host evaluates its own rc
//! policy (tsh: the startup units of the user's rc and `--boot`). Anything
//! else — a script, a typed or relayed unit, a bundle's code run by a script —
//! may bind plain strings but not a secret. With no probe installed nothing is
//! rc policy, so an embedder that never opted in binds no secrets at all.
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, RwLock};

use anyhow::{Result, anyhow, bail};
use tento_lisp::Value;
use tento_lisp_cmd::script::Sym;
use tento_secrets::{Address, Vault};

#[derive(Clone, Debug)]
enum Binding {
  Literal(String),
  Secret(Address),
}

/// Who is declaring a binding: the host's rc policy, or anything else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authority {
  /// The host's own startup policy (tsh: the user's rc files and `--boot`).
  RcPolicy,
  /// A script, a later unit, or code a script loaded.
  Script,
}

/// The host's answer to "is the code running on this thread rc policy?".
static RC_POLICY_PROBE: RwLock<Option<fn() -> bool>> = RwLock::new(None);

/// Install the host's rc-policy probe (last call wins). The probe is asked on
/// the thread evaluating `<ns>.env.bind`, at the moment it is called.
pub fn set_rc_policy_probe(probe: fn() -> bool) {
  *RC_POLICY_PROBE.write().unwrap_or_else(|e| e.into_inner()) = Some(probe);
}

/// The authority of the code evaluating on this thread, per the host's probe.
/// [`Authority::Script`] when no probe is installed.
pub fn caller_authority() -> Authority {
  let probe = *RC_POLICY_PROBE.read().unwrap_or_else(|e| e.into_inner());
  match probe {
    Some(probe) if probe() => Authority::RcPolicy,
    _ => Authority::Script,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tento_secrets::SetOpts;

  fn secret_map() -> Value<Sym> {
    Value::Map(
      [(
        "ACCESS_TOKEN".into(),
        Value::TaggedString {
          tag: "secret".into(),
          payload: "test/key".into(),
        },
      )]
      .into_iter()
      .collect(),
    )
  }

  #[test]
  fn app_secret_binding_resolves_at_spawn_and_observes_rotation() {
    let dir = std::env::temp_dir().join(format!(
      "tsh-app-env-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    ));
    let mut vault = Vault::init_at(&dir).unwrap();
    let address = Address::parse("test/key").unwrap();
    vault
      .set(&address, b"test-key-first", SetOpts::default())
      .unwrap();
    let bindings = Bindings::default();
    bindings.set(secret_map(), Authority::RcPolicy).unwrap();
    assert!(!format!("{bindings:?}").contains("test-key-first"));

    let mut first = Command::new("unused");
    bindings
      .apply_with(&mut first, || Vault::open_at(&dir))
      .unwrap();
    assert_eq!(
      first.get_envs().next().unwrap().1.unwrap(),
      "test-key-first"
    );

    vault
      .set(&address, b"test-key-rotated", SetOpts::default())
      .unwrap();
    let mut second = Command::new("unused");
    bindings
      .apply_with(&mut second, || Vault::open_at(&dir))
      .unwrap();
    assert_eq!(
      second.get_envs().next().unwrap().1.unwrap(),
      "test-key-rotated"
    );

    // A sibling app with no binding neither opens the vault nor receives a key.
    let mut sibling = Command::new("unused");
    Bindings::default()
      .apply_with(&mut sibling, || panic!("unbound app opened vault"))
      .unwrap();
    assert_eq!(sibling.get_envs().count(), 0);
  }

  /// Outside rc policy a secret-bearing declaration is refused whole — before
  /// any vault is opened, keeping the previous bindings — while plain values
  /// still bind. The same map binds under rc policy.
  #[test]
  fn only_rc_policy_binds_a_secret() {
    let bindings = Bindings::default();
    let plain = Value::Map(
      [(
        "API_URL".into(),
        Value::String("https://example.test".into()),
      )]
      .into_iter()
      .collect(),
    );
    bindings.set(plain, Authority::Script).unwrap();
    let error = bindings
      .set(secret_map(), Authority::Script)
      .unwrap_err()
      .to_string();
    assert!(
      error.contains("only rc policy") && error.contains("test/key"),
      "{error}"
    );
    let mut command = Command::new("unused");
    bindings
      .apply_with(&mut command, || panic!("a refused secret opened the vault"))
      .unwrap();
    let envs: Vec<_> = command
      .get_envs()
      .map(|(k, v)| (k.to_owned(), v.map(|v| v.to_owned())))
      .collect();
    assert_eq!(
      envs,
      vec![("API_URL".into(), Some("https://example.test".into()))],
      "the previous (plain) bindings stay"
    );
    bindings.set(secret_map(), Authority::RcPolicy).unwrap();
    assert!(!bindings.is_empty());
  }

  #[test]
  fn an_import_site_shares_its_bindings_and_no_other_does() {
    let envs = ImportEnvs::default();
    let bundle = Path::new("/apps/acme.tsh.app");
    let lisp = envs.for_import("acme-js", bundle);
    let word = envs.for_import("acme-js", bundle);
    lisp
      .set(
        Value::Map(
          [("API_URL".into(), Value::String("https://example.test".into()))]
            .into_iter()
            .collect(),
        ),
        Authority::Script,
      )
      .unwrap();
    assert!(!word.is_empty(), "the word mount sees the lisp mount's bind");
    assert!(envs.for_import("acme", bundle).is_empty());
    assert!(
      envs
        .for_import("acme-js", Path::new("/apps/acme-js.tsh.app"))
        .is_empty()
    );
    assert!(ImportEnvs::default().for_import("acme-js", bundle).is_empty());
  }

  #[test]
  fn app_secret_binding_rejects_plaintext_atomically_without_disclosing_it() {
    let bindings = Bindings::default();
    bindings.set(secret_map(), Authority::RcPolicy).unwrap();
    let invalid = Value::Map(
      [(
        "ACCESS_TOKEN".into(),
        Value::String("not-for-error-output".into()),
      )]
      .into_iter()
      .collect(),
    );
    let error = bindings
      .set(invalid, Authority::RcPolicy)
      .unwrap_err()
      .to_string();
    assert!(!error.contains("not-for-error-output"));
    assert!(error.contains("secret.file"));
    assert!(
      !bindings.is_empty(),
      "invalid declaration erased the prior binding"
    );
  }
}

/// Shared by the command closures of ONE import; excluded from session env snapshots.
#[derive(Clone, Default, Debug)]
pub struct Bindings(Arc<RwLock<BTreeMap<String, Binding>>>);

/// The bindings of each import site, shared by the two mounts one rc
/// `(@import …)` line produces in a host: the shell's word mount
/// (`tsh acme-js sheets.list`, a [`crate::remote_group::RemoteGroup`]) and the
/// lisp mount (`(acme-js.sheets.list)`), whose `<ns>.env.bind` declares them.
/// Keyed by namespace AND bundle dir, so a same-named import of another
/// bundle binds nothing. Scoped to whoever holds the handle: a host built
/// without it (a lane, a granted script) shares nothing with the rc.
#[derive(Clone, Default, Debug)]
pub struct ImportEnvs(std::rc::Rc<std::cell::RefCell<HashMap<(String, PathBuf), Bindings>>>);

impl ImportEnvs {
  /// The bindings of the import of `bundle_dir` under `namespace`.
  pub fn for_import(&self, namespace: &str, bundle_dir: &Path) -> Bindings {
    self
      .0
      .borrow_mut()
      .entry((namespace.to_string(), bundle_dir.to_path_buf()))
      .or_default()
      .clone()
  }
}

impl Bindings {
  /// Validate the whole declaration before replacing the previous bindings.
  /// A secret is accepted only from [`Authority::RcPolicy`]; refused, the
  /// declaration is rejected whole and the previous bindings stay.
  pub fn set(&self, entries: Value<Sym>, authority: Authority) -> Result<()> {
    let Value::Map(entries) = entries else {
      bail!("env.bind expects a map of environment names to values");
    };
    let mut parsed = BTreeMap::new();
    for (name, value) in entries {
      if name.is_empty() || name.contains('=') || name.contains('\0') {
        bail!("env.bind: invalid environment variable name");
      }
      let secret_shaped = ["_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD"]
        .iter()
        .any(|suffix| name.to_ascii_uppercase().ends_with(suffix))
        || matches!(
          name.to_ascii_uppercase().as_str(),
          "API_KEY" | "TOKEN" | "SECRET" | "PASSWORD"
        );
      let binding = match value {
        Value::TaggedString { tag, payload } if tag == "secret" => {
          let address = Address::parse(&payload)?;
          if authority != Authority::RcPolicy {
            bail!(
              "env.bind: {name} binds the secret {address}, and only rc policy may bind a \
               secret (the host's startup rc, evaluated when it starts); a script reaches \
               the vault only through a grant"
            );
          }
          Binding::Secret(address)
        }
        Value::String(value) if !secret_shaped && !value.contains('\0') => {
          Binding::Literal(value.into_string())
        }
        _ => {
          bail!("env.bind: {name} needs a non-secret string or (secret.file \"namespace/name\")")
        }
      };
      parsed.insert(name, binding);
    }
    *self.0.write().unwrap_or_else(|e| e.into_inner()) = parsed;
    Ok(())
  }

  pub fn is_empty(&self) -> bool {
    self.0.read().unwrap_or_else(|e| e.into_inner()).is_empty()
  }

  /// Resolve at spawn, so key rotation takes effect on the next invocation.
  pub fn apply(&self, command: &mut Command) -> Result<()> {
    self.apply_with(command, || Vault::open_at(&Vault::default_dir()?))
  }

  fn apply_with(&self, command: &mut Command, open: impl FnOnce() -> Result<Vault>) -> Result<()> {
    let bindings = self.0.read().unwrap_or_else(|e| e.into_inner()).clone();
    let vault = if bindings.values().any(|b| matches!(b, Binding::Secret(_))) {
      Some(open()?)
    } else {
      None
    };
    for (name, binding) in bindings {
      match binding {
        Binding::Literal(value) => {
          command.env(name, value);
        }
        Binding::Secret(address) => {
          let value = vault
            .as_ref()
            .ok_or_else(|| anyhow!("vault unavailable"))?
            .read(&address, None)?;
          let text = std::str::from_utf8(value.expose())
            .map_err(|_| anyhow!("env.bind: {address} is not a UTF-8 environment value"))?;
          if text.is_empty() || text.contains('\0') {
            bail!("env.bind: {address} is empty or contains a NUL byte");
          }
          command.env(name, text);
        }
      }
    }
    Ok(())
  }
}
