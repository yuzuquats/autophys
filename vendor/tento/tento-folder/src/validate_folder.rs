//! Tier-2 / package-level validation hook.
//!
//! `tento-folder` validates folders in two tiers:
//!
//! 1. **Tier 1** — structural + content-format checks, performed by
//!    the macro-emitted `Folder::load(path)` (via [`crate::Schema::validate`]).
//! 2. **Tier 2** — package-level cross-file invariants the consumer
//!    layers on top, via [`ValidateFolder::validate`].
//!
//! Every [`crate::folder!`]-emitted `Folder` automatically gets
//! `impl ValidateFolder for Folder {}` (default no-op). Consumers who
//! want cross-file checks wrap the Folder in a newtype and override
//! `validate(&self)`:
//!
//! ```ignore
//! use tento_folder::{ValidateFolder, FolderError};
//!
//! pub struct ServerAppAppBundle(server-app_bundle::Folder);
//!
//! impl ServerAppAppBundle {
//!   pub fn load(path: &std::path::Path) -> Result<Self, FolderError> {
//!     let folder = server-app_bundle::Folder::load(path)?;   // tier 1
//!     let bundle = Self(folder);
//!     bundle.validate()?;                              // tier 2
//!     Ok(bundle)
//!   }
//! }
//!
//! impl ValidateFolder for ServerAppAppBundle {
//!   fn validate(&self) -> Result<(), FolderError> {
//!     // e.g. parse the VERSION file format, check secrets coverage,
//!     // assert container artifacts exist, etc.
//!     Ok(())
//!   }
//! }
//! ```

use crate::error::FolderError;

/// Tier-2 (package-level) validation contract.
///
/// Single method, defaulted to no-op. Macro-emitted Folder types
/// inherit the default; consumer newtypes override to enforce
/// cross-file invariants that the lower-lib structural + content
/// validator can't see.
pub trait ValidateFolder {
  fn validate(&self) -> Result<(), FolderError> {
    Ok(())
  }
}
