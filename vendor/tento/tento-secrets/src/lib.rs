//! `tento-secrets` — reusable secret primitives shared across the package
//! tooling and the tsh secrets layer.
//!
//! The plaintext generation (the bridge, still read by deployed services):
//! - [`store`]: the on-host 0600 file store a deployed service reads its
//!   secrets from (path convention + write/read/presence).
//! - [`template`]: a package's `secrets.template.toml` (which keys it needs).
//! - [`env`]: a minimal `.env` parser for bootstrapping values.
//!
//! Named app accounts:
//! - [`accounts`]: the account catalog, credential references, launch plans
//!   and the `auth.provider/v1` wire ([`profiles`] is its older name).
//!
//! The envelope generation (design: `tsh-secrets.project.docs` in mono):
//! - [`address`]: `namespace/name` addresses.
//! - [`secret`]: `Secret<T>`, the tainted value type.
//! - [`envelope`]: per-version ciphertext, data key wrapped per recipient.
//! - [`identity`]: X25519 recipient identity + ed25519 signing key on disk.
//! - [`manifest`]: the signed, `seq`-monotonic metadata + roster.
//! - [`vault`]: the store as a whole (init / set / read / list).
//!
//! The envelope generation is the `vault` feature (default-on today; package
//! tooling opts out). The optional `terminal` feature adds `input::read_secret_multiline` for
//! hidden paste into a `SecretBytes` buffer, ready to pass to `Vault::set`.
//!
//! Pure by design — no transport/node deps. The "push a value to a host over
//! a transport" glue lives with its caller (the CLI / node layer).

pub mod accounts;
#[cfg(feature = "vault")]
pub mod address;
pub mod env;
#[cfg(feature = "vault")]
pub mod envelope;
#[cfg(feature = "vault")]
pub mod identity;
#[cfg(feature = "terminal")]
pub mod input;
#[cfg(feature = "vault")]
pub mod manifest;
pub mod profiles;
#[cfg(feature = "vault")]
pub mod secret;
pub mod store;
pub mod template;
#[cfg(feature = "vault")]
pub mod vault;
#[cfg(feature = "vault")]
pub mod write_lock;

#[cfg(feature = "vault")]
pub use address::Address;
#[cfg(feature = "vault")]
pub use manifest::{Health, HistoryEntry, Kind, Record, Unlock};
#[cfg(feature = "vault")]
pub use secret::{Secret, SecretBytes};
pub use template::{SECRETS_TEMPLATE_FILE, SecretDecl, SecretsTemplate};
#[cfg(feature = "vault")]
pub use vault::{Guard, SetOpts, Vault};
#[cfg(feature = "vault")]
pub use write_lock::VaultWriteLock;
