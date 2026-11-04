//! Materialize store secrets onto a host (behind the `transport` feature).
//!
//! Two projections, both writing `0600` files over a [`tento_nodes::Transport`]:
//! - [`materialize_env`]: `KEY=value` pairs → a `.env` the app sources.
//! - [`materialize_files`]: store `(service,key)` → per-app files under
//!   `secrets_root` (TLS certs, google JSON, session key).
//!
//! The env pairs come from a typed `EnvGroup` the caller loaded + validated
//! (e.g. `LonaSoSecrets::from_backend(StoreBackend).into_result()?.env_vars()`);
//! this module is product-agnostic.

use anyhow::{Result, bail};
use tento_nodes::Transport;

/// One file-shaped secret: a store `(service,key)` → a `secrets_root`-relative
/// destination path.
pub struct FileSecret {
  pub service: String,
  pub key: String,
  pub dest: String,
  pub optional: bool,
}

/// Write a `0600` `.env` file at `dest_path` on the host from `KEY=value` pairs.
pub async fn materialize_env(
  transport: &dyn Transport,
  dest_path: &str,
  pairs: &[(String, String)],
) -> Result<()> {
  let body: String = pairs.iter().map(|(k, v)| format!("{k}={v}\n")).collect();
  transport
    .put_file(dest_path, body.as_bytes(), Some(0o600))
    .await
}

/// Write `KEY=value` pairs as individual `0600` files under
/// `<secrets_root>/<bucket>/<KEY>` — the on-disk secret-store layout a
/// `StoreBackend` reads (`LONA_SECRETS_DIR=<secrets_root>`, service `<bucket>`).
/// Replaces a flat `.env` the app would source: loaf boots reading the store
/// instead, so the store is the single secret interface on the host too.
pub async fn materialize_store_bucket(
  transport: &dyn Transport,
  secrets_root: &str,
  bucket: &str,
  pairs: &[(String, String)],
) -> Result<()> {
  for (k, v) in pairs {
    let dest = format!("{secrets_root}/{bucket}/{k}");
    transport.put_file(&dest, v.as_bytes(), Some(0o600)).await?;
  }
  Ok(())
}

/// Read each declared file-secret from the operator store and write it (0600)
/// to `<secrets_root>/<dest>` on the host. Returns the destinations written.
pub async fn materialize_files(
  transport: &dyn Transport,
  secrets_root: &str,
  files: &[FileSecret],
) -> Result<Vec<String>> {
  let mut written = Vec::new();
  for f in files {
    match tento_secrets::store::read(&f.service, &f.key)? {
      Some(bytes) => {
        let dest = format!("{secrets_root}/{}", f.dest);
        transport.put_file(&dest, &bytes, Some(0o600)).await?;
        written.push(f.dest.clone());
      }
      None if f.optional => {}
      None => bail!("missing file-secret {}/{} in store", f.service, f.key),
    }
  }
  Ok(written)
}
