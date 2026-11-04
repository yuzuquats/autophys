//! Proof without retention.
//!
//! A [`Valid<T>`] field records **a path and nothing else** — same
//! shape as [`Unchecked<T>`](crate::Unchecked). The difference is
//! *when the proof happened*: a `Valid<…>` entry is checked during
//! tier-1 `SCHEMA.validate`, by a `check` hook the `folder!` macro
//! attaches to the schema entry. The value that proof produced is then
//! dropped.
//!
//! ```ignore
//! folder!(app, {
//!   "config.json": File<Json<AppConfig>>,   // parsed AND held
//!   "raw.json":    Valid<File<Json>>,       // parsed at load, held: just the path
//!   "big.json":    Unchecked<File<Json<Report>>>, // not read at all
//! });
//! ```
//!
//! Three points on one axis — how much `load` pays, and how much it
//! keeps:
//!
//! | Form | `load` proves content | `load` retains | Producing the value later |
//! | ---- | --------------------- | -------------- | ------------------------- |
//! | `File<C>` | yes | the value | infallible (`.value()`) |
//! | `Valid<File<C>>` | yes | the path | fallible (`.read()`) |
//! | `Unchecked<File<C>>` | no | the path | fallible (`.read()`) |
//!
//! **The production rule: producing the object is infallible iff load
//! retained it.** `Valid` re-proves on `.check()` / `.read()` rather
//! than handing back a cached value, because the load-time proof was
//! about *that moment* — disk moves underneath a process, so anything
//! that touches disk again stays fallible.

use std::fmt;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use crate::error::FolderError;
use crate::file::{FileContent, Typed};
use crate::unchecked::Checkable;

/// A path proven at load time to satisfy `T`, holding only the path.
///
/// Constructed by macro-generated code for `Valid<…>` entries. The
/// proof itself runs in tier-1 validation via the schema entry's
/// `check` hook — see [`SchemaEntry`](crate::SchemaEntry).
pub struct Valid<T> {
  path: PathBuf,
  // `fn() -> T` rather than `T` so `Valid<T>` stays Send/Sync and
  // covariant no matter what `T` is — it owns no `T`.
  _marker: PhantomData<fn() -> T>,
}

impl<T> Valid<T> {
  /// Record a proven path. Does not touch the filesystem — the proof
  /// is the caller's (in practice, tier-1 validation's) to have run.
  pub fn new(path: impl Into<PathBuf>) -> Self {
    Self {
      path: path.into(),
      _marker: PhantomData,
    }
  }

  /// The path that was proven.
  pub fn path(&self) -> &Path {
    &self.path
  }
}

impl<T: Checkable> Valid<T> {
  /// Re-prove and construct **now**. Identical work to
  /// [`Unchecked::check`](crate::Unchecked::check): for a typed file a
  /// read plus `C::parse`; for a folder reference the child module's
  /// full `load`.
  ///
  /// This repeats the load-time proof on purpose — see the production
  /// rule in the module docs.
  pub fn check(&self) -> Result<T, FolderError> {
    T::check_at(&self.path)
  }
}

impl<C: FileContent> Valid<Typed<C>> {
  /// The parsed value, produced now. Sugar for
  /// `self.check()?.into_value()`.
  pub fn read(&self) -> Result<C::Value, FolderError> {
    Ok(self.check()?.into_value())
  }
}

// Hand-written so a generated `#[derive(Debug)] struct Folder` never
// forces `T: Debug`.
impl<T> fmt::Debug for Valid<T> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("Valid")
      .field("path", &self.path)
      .finish_non_exhaustive()
  }
}
