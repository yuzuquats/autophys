//! File handles produced by the [`folder!`] macro.
//!
//! The three contract-free kinds — `File::Binary` / `File::Text` /
//! `File::Shell` — emit a [`FileNode`](crate::FileNode): a path plus a
//! declared [`FileType`](crate::FileType), never read at load.
//! [`Typed<C>`] backs the **typed** form `File<C>`: it reads the bytes
//! once at load time, hands them to `C`'s [`FileContent`] impl, and
//! caches the resulting `C::Value`.
//!
//! The typed slot has two orthogonal axes:
//!
//! - **Encoding, inside.** `File<Json<T>>` / `File<Toml<T>>` /
//!   `File<Yaml<T>>` name a [format marker](crate::formats) whose
//!   blanket [`FileContent`] impl does the serde work. A bare
//!   `File<AppConfig>` means `AppConfig` implements [`FileContent`]
//!   itself — a custom filetype, in the consumer's own encoding.
//! - **Timing/retention, outside.** `File<C>` parses at load and keeps
//!   the value; [`Valid<File<C>>`](crate::Valid) proves it at load and
//!   keeps only the path; [`Unchecked<File<C>>`](crate::Unchecked)
//!   defers entirely.
//!
//! tento-folder itself knows no formats on this path: the markers are
//! ordinary [`FileContent`] impls that happen to ship in the crate
//! behind cargo features. A parse failure becomes
//! [`FolderError::Shape`] naming the offending file — the impl's own
//! error text says *how* it failed (syntax vs shape), because that is
//! the layer that knows the difference.
//!
//! [`folder!`]: crate::folder

use std::fmt;
use std::path::{Path, PathBuf};

use crate::error::FolderError;
use crate::unchecked::Checkable;

/// How a typed file entry's bytes become a value.
///
/// `C: FileContent` is a **filetype**: the name in a `File<C>` schema
/// slot. It is not necessarily the produced type — that is
/// [`Value`](FileContent::Value). The split is what lets a marker like
/// [`Json<T>`](crate::formats::Json) exist purely at the schema level
/// (`type Value = T`) while a custom filetype produces itself
/// (`type Value = Self`).
///
/// The returned error is surfaced as [`FolderError::Shape`] with the
/// path attached. Impls that want the malformed-vs-shape distinction
/// produce it here, in their own message:
///
/// ```ignore
/// /// A bespoke `key=value` config — no serde, no format crate.
/// struct AppConfig { name: String }
///
/// impl tento_folder::FileContent for AppConfig {
///   type Value = Self;
///   fn parse(bytes: &[u8]) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
///     let text = std::str::from_utf8(bytes).map_err(|e| format!("not UTF-8: {e}"))?;
///     let name = text
///       .lines()
///       .find_map(|line| line.strip_prefix("name="))
///       .ok_or("well-formed text, but no `name=` line")?;
///     Ok(Self { name: name.to_string() })
///   }
/// }
/// ```
pub trait FileContent {
  /// What a successful parse produces — what [`Typed`] holds and
  /// `value()` hands back.
  ///
  /// Associated-type defaults are unstable, so custom filetypes must
  /// spell `type Value = Self;` explicitly.
  type Value;

  fn parse(bytes: &[u8]) -> Result<Self::Value, Box<dyn std::error::Error + Send + Sync>>;
}

/// Handle for `File::Binary`. Path-only; contents are never read at
/// load time.
pub struct Binary {
  pub(crate) path: PathBuf,
}

impl Binary {
  pub fn path(&self) -> &Path {
    &self.path
  }
}

/// Handle for `File::Text`. Path-only; contents are never read at
/// load time.
pub struct Text {
  pub(crate) path: PathBuf,
}

impl Text {
  pub fn path(&self) -> &Path {
    &self.path
  }
}

/// Handle for `File::Shell`. Same on-disk shape as `Text` but the
/// builder writes mode `0755`.
pub struct Shell {
  pub(crate) path: PathBuf,
}

impl Shell {
  pub fn path(&self) -> &Path {
    &self.path
  }
}

/// Handle for the typed form `File<C>`: the value `C::parse` produced
/// at load time, plus the path it came from.
///
/// Constructed by macro-generated code (which lives in consumer
/// crates) via [`Typed::load`]; the untyped `File::…` forms emit a
/// [`FileNode`](crate::FileNode) instead.
pub struct Typed<C: FileContent> {
  path: PathBuf,
  value: C::Value,
}

impl<C: FileContent> Typed<C> {
  /// Read `path` and parse its bytes through `C`'s [`FileContent`]
  /// impl.
  ///
  /// - Unreadable ⇒ [`FolderError::Io`].
  /// - `C::parse` rejects the bytes ⇒ [`FolderError::Shape`], carrying
  ///   the impl's error as its `source`.
  pub fn load(path: impl Into<PathBuf>) -> Result<Self, FolderError> {
    let path = path.into();
    let bytes = std::fs::read(&path).map_err(|source| FolderError::Io {
      path: path.clone(),
      source,
    })?;
    let value = C::parse(&bytes).map_err(|source| FolderError::Shape {
      path: path.clone(),
      source,
    })?;
    Ok(Self { path, value })
  }

  /// The value parsed at load time.
  pub fn value(&self) -> &C::Value {
    &self.value
  }

  /// Take ownership of the parsed value, dropping the path.
  pub fn into_value(self) -> C::Value {
    self.value
  }

  pub fn path(&self) -> &Path {
    &self.path
  }
}

/// Wrapping a typed file (`Valid<File<C>>` / `Unchecked<File<C>>`)
/// resolves by doing exactly what an eager `File<C>` entry does at
/// load — just at a different moment.
impl<C: FileContent> Checkable for Typed<C> {
  fn check_at(path: &Path) -> Result<Self, FolderError> {
    Self::load(path)
  }
}

// Hand-written so the generated `#[derive(Debug)] struct Folder` does
// not force `C::Value: Debug` on consumers' shape types.
impl<C: FileContent> fmt::Debug for Typed<C> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("Typed")
      .field("path", &self.path)
      .finish_non_exhaustive()
  }
}
