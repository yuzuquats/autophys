//! `tento-env-file-backend` — a [`tento_env::Backend`] that resolves every key
//! from the on-disk secret store (`tento_secrets::store`).
//!
//! Kept separate from `tento-env` core so the core crate never depends on
//! `tento-secrets`. Pass it explicitly:
//!
//! ```ignore
//! let config = MyConfig::from_backend(tento_env_file_backend::StoreBackend::new())
//!   .assert_envars();
//! ```
//!
//! A load resolves **entirely** from the store — there is no env fallback.

use tento_env::{Backend, EnvError, EnvGroupResult, FromEnv};

#[cfg(feature = "transport")]
pub mod materialize;

/// Default service bucket when `LONA_ENV_SERVICE` is unset.
pub const DEFAULT_SERVICE: &str = "scripts";

/// Load a config resolving **every** key from the `service` bucket of the
/// on-disk secret store, with no env fallback. Convenience over
/// `T::from_backend(StoreBackend::for_service(service))` for operator tools
/// whose secrets live in a per-service bucket (e.g. `cloudflare`, `garmin`).
pub fn config_from_store<T: FromEnv>(service: impl Into<String>) -> EnvGroupResult<T> {
  T::from_backend(StoreBackend::for_service(service))
}

/// Resolves keys from `<base>/<service>/<KEY>` via [`tento_secrets::store`],
/// where `<base>` is `$LONA_SECRETS_DIR` or `$HOME/.local/share/lona/secrets`.
pub struct StoreBackend {
  service: String,
}

impl StoreBackend {
  /// Service from `$LONA_ENV_SERVICE`, defaulting to [`DEFAULT_SERVICE`].
  pub fn new() -> Self {
    let service = std::env::var("LONA_ENV_SERVICE").unwrap_or_else(|_| DEFAULT_SERVICE.to_string());
    Self { service }
  }

  /// Explicit service bucket.
  pub fn for_service(service: impl Into<String>) -> Self {
    Self {
      service: service.into(),
    }
  }
}

impl Default for StoreBackend {
  fn default() -> Self {
    Self::new()
  }
}

impl Backend for StoreBackend {
  fn lookup(&self, key: &'static str) -> Result<Option<String>, EnvError> {
    match tento_secrets::store::read(&self.service, key) {
      Ok(Some(bytes)) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
      Ok(None) => Ok(None),
      Err(e) => Err(EnvError::parse(
        key,
        format!("secret store read: {e}"),
        "secret-store",
      )),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // Env mutation: keep single-threaded for this crate's tests.
  #[test]
  fn reads_present_and_absent_keys() {
    let dir = tempfile::tempdir().unwrap();
    // SAFETY: single-threaded test.
    unsafe {
      std::env::set_var("LONA_SECRETS_DIR", dir.path());
    }
    tento_secrets::store::write("svc", "MY_KEY", b"the-value").unwrap();

    let backend = StoreBackend::for_service("svc");
    assert_eq!(
      backend.lookup("MY_KEY").unwrap().as_deref(),
      Some("the-value")
    );
    assert_eq!(backend.lookup("ABSENT_KEY").unwrap(), None);

    // SAFETY: single-threaded test.
    unsafe {
      std::env::remove_var("LONA_SECRETS_DIR");
    }
  }
}
