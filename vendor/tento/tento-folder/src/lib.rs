//! `tento-folder` — declarative folder-shape primitive.
//!
//! Defines the [`folder!`] macro for declaring a folder layout, the
//! [`ContentSource`] enum for materializing entries, the [`FolderError`]
//! type for build/load failures, the [`ValidateFolder`] tier-2 hook,
//! and supporting [`FileNode`] / [`FolderNode`] handles plus the typed
//! content handle [`file::Typed`] (the `File<C>` form) and its
//! [`FileContent`] contract.
//!
//! # The two axes of a `File` slot
//!
//! **Encoding (inside).** `File<Json<AppConfig>>` names a
//! [format marker](formats) — `Json` / `Toml` / `Yaml`, each behind a
//! cargo feature of the same name, all on by default. A bare
//! `File<AppConfig>` means `AppConfig` implements [`FileContent`]
//! itself: a custom filetype in the consumer's own encoding. The
//! blanket impls live on the markers, never on `T`, so the bare form
//! reliably means "custom".
//!
//! **Timing and retention (outside).**
//!
//! | Form | `load` proves content | `load` retains | Producing the value |
//! | ---- | --------------------- | -------------- | ------------------- |
//! | `File<C>` | yes | the value | infallible (`.value()`) |
//! | [`Valid<File<C>>`](Valid) | yes (tier-1 hook) | the path | fallible (`.read()`) |
//! | [`Unchecked<File<C>>`](Unchecked) | no | the path | fallible (`.read()`) |
//!
//! **Producing the object is infallible iff `load` retained it.**
//!
//! Both path-only wrappers also take a `folder!` module
//! (`Valid<mod::Folder>` / `Unchecked<mod::Folder>`), which is how one
//! folder schema composes another without paying for it eagerly.
//!
//! # Validation tiers
//!
//! 1. **Tier 1** — structural checks (existence + node kind) plus any
//!    per-entry [`check` hook](SchemaEntry::check), performed by the
//!    macro-emitted `Folder::load(path)` via [`Schema::validate`].
//! 2. **Tier 2** — caller-provided cross-file invariants, via the
//!    [`ValidateFolder`] trait's `validate(&self)` method.
//!
//! Reading a schema top to bottom therefore tells you exactly what
//! `Folder::load` proves: everything except the `Unchecked<…>` entries.
//!
//! See the design docs under `.docs/` for the canonical API spec.

pub use tento_folder_macros::folder;

pub mod file;
pub mod formats;

mod builder;
mod content_source;
mod error;
mod glob_entry;
mod glob_match;
mod node;
mod path;
#[cfg(feature = "cli")]
pub mod plugin;
mod schema;
mod spec;
#[cfg(feature = "tsh")]
pub mod tsh;
mod unchecked;
mod valid;
mod validate;
mod validate_folder;

pub use builder::{EntryKind, FolderBuilder, FolderEntry};
pub use content_source::ContentSource;
pub use error::{FolderError, NodeKind};
pub use file::FileContent;
pub use glob_entry::{GlobEntry, GlobMatch};
pub use glob_match::matches as glob_matches;
pub use node::{FileNode, FileType, FolderNode};
pub use path::{JoinError, safe_join};
pub use schema::{Schema, SchemaEntry, SchemaKind};
pub use spec::{FolderViolation, Spec, SpecEntry, SpecError, SpecKind, SpecRow, violations};
pub use unchecked::{Checkable, Unchecked};
pub use valid::Valid;
pub use validate::{
  Validator, load_file_required, load_folder_required, validate_file, validate_folder,
};
pub use validate_folder::ValidateFolder;

/// tsh source defining the `folder.*` spec DSL (see [`tsh`] when the `tsh`
/// feature is on). A plain string, always available, so a crate that already
/// runs the tsh engine can bind the vocabulary without turning on `tsh` —
/// which would pull the shell into every `tento-folder` user through cargo's
/// feature unification.
pub const TSH_PRELUDE: &str = include_str!("../tsh/prelude.tsh");
