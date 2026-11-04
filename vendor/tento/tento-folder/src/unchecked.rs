//! Explicitly deferred validation.
//!
//! An [`Unchecked<T>`] field records **a path and nothing else**. No
//! read, no parse, no directory walk — not at construction, not during
//! `SCHEMA.validate` (which checks existence only for such entries).
//! The work happens when the caller asks, via [`Unchecked::check`].
//!
//! This makes deferral a **schema-level, greppable** statement rather
//! than a convention. Reading a `folder!` declaration tells you exactly
//! what `Folder::load` proves: everything except the `Unchecked<…>`
//! entries.
//!
//! ```ignore
//! folder!(library, {
//!   "meta.json":  File<Json<Manifest>>,                    // proven by load
//!   "big.json"?:  Unchecked<File<Json<CaptureManifest>>>,  // deferred
//!   "runs":       runs_dir::Folder,                        // proven by load
//! });
//!
//! let lib = library::Folder::load(root)?;            // cheap
//! let big = match &lib.big_json {                    // pay here, or never
//!   Some(handle) => Some(handle.read()?),
//!   None => None,
//! };
//! ```
//!
//! [`Valid<T>`](crate::Valid) is the sibling wrapper on the same axis:
//! same path-only field, but proven at load instead of deferred.

use std::fmt;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use crate::error::FolderError;
use crate::file::{FileContent, Typed};

/// Something an [`Unchecked<T>`] or [`Valid<T>`](crate::Valid) can
/// turn into on demand.
///
/// Two implementors exist out of the box:
///
/// - [`file::Typed<C>`](crate::file::Typed) where `C: FileContent` —
///   `check_at` reads the bytes and runs `C::parse`.
/// - Every `folder!`-generated top-level `Folder` — `check_at` is that
///   module's `load`, i.e. full tier-1 validation plus construction.
///   This is what lets one `folder!` schema hold another as a deferred
///   child.
pub trait Checkable: Sized {
  fn check_at(path: &Path) -> Result<Self, FolderError>;
}

/// A path whose contents have **not** been validated, plus the type
/// they are expected to satisfy.
///
/// Constructed by macro-generated code for `Unchecked<…>` entries;
/// resolved by [`check`](Unchecked::check).
pub struct Unchecked<T> {
  path: PathBuf,
  // `fn() -> T` rather than `T` so `Unchecked<T>` stays Send/Sync and
  // covariant no matter what `T` is — it owns no `T`.
  _marker: PhantomData<fn() -> T>,
}

impl<T> Unchecked<T> {
  /// Record a path as deferred. Does not touch the filesystem.
  pub fn new(path: impl Into<PathBuf>) -> Self {
    Self {
      path: path.into(),
      _marker: PhantomData,
    }
  }

  /// The path whose validation was deferred.
  pub fn path(&self) -> &Path {
    &self.path
  }
}

impl<T: Checkable> Unchecked<T> {
  /// Validate and construct **now**. For a typed file that is a read
  /// plus the `FileContent::parse` its filetype declares; for a folder
  /// reference it is the child module's full `load` (tier-1 validate +
  /// construct), so errors name paths inside the child.
  pub fn check(&self) -> Result<T, FolderError> {
    T::check_at(&self.path)
  }
}

impl<C: FileContent> Unchecked<Typed<C>> {
  /// The parsed value, produced now. Sugar for
  /// `self.check()?.into_value()`.
  pub fn read(&self) -> Result<C::Value, FolderError> {
    Ok(self.check()?.into_value())
  }
}

// Hand-written so a generated `#[derive(Debug)] struct Folder` never
// forces `T: Debug`.
impl<T> fmt::Debug for Unchecked<T> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("Unchecked")
      .field("path", &self.path)
      .finish_non_exhaustive()
  }
}
