//! Serialization-format markers for the `File<…>` slot.
//!
//! A marker is a **schema-level name**, never a runtime value: its only
//! field is a `PhantomData`, and that field is private, so nothing
//! outside this module can construct one. What it carries is a
//! [`FileContent`] impl, which is what the `folder!` macro actually
//! uses.
//!
//! ```ignore
//! folder!(app, {
//!   "config.json": File<Json<AppConfig>>,   // parse as JSON into AppConfig
//!   "limits.toml": File<Toml<Limits>>,      // parse as TOML into Limits
//!   "raw.json":    Valid<File<Json>>,       // prove it is JSON; keep the path
//!   "any.json":    File<Json>,              // parse and RETAIN serde_json::Value
//! });
//! ```
//!
//! The type parameter defaults to the format's permissive value type
//! (`Json` ≡ `Json<serde_json::Value>`), which is how a
//! well-formedness-only check is spelled: `Valid<File<Json>>` parses
//! at tier-1 validation and keeps nothing but the path.
//!
//! Each marker is behind a cargo feature of the same name (`json`,
//! `toml`, `yaml`), all on by default. With `default-features = false`
//! tento-folder knows no serialization formats at all — only
//! `File::Binary` / `File::Text` / `File::Shell`, folders, and bare
//! `File<C>` for a consumer's own [`FileContent`] impl. A schema that
//! names `Json<…>` with the `json` feature off is a
//! missing-item compile error, by design.
//!
//! Every impl here parses in **two phases** — permissive value first,
//! then the target shape — so the error text distinguishes "these
//! bytes are not JSON" from "these bytes are JSON of the wrong shape".
//! That distinction used to be a tento-folder concept
//! (`FolderError::Malformed` vs `Shape`); it now lives in the layer
//! that actually knows the format, and both surface as
//! [`FolderError::Shape`](crate::FolderError::Shape) naming the file.

// Every item in this module belongs to exactly one format feature; with
// all three off the module is legitimately empty.
#[cfg(any(feature = "json", feature = "toml", feature = "yaml"))]
use std::marker::PhantomData;

#[cfg(any(feature = "json", feature = "toml", feature = "yaml"))]
use crate::file::FileContent;

/// Error alias for a [`FileContent`](crate::FileContent) parse result.
#[cfg(any(feature = "json", feature = "toml", feature = "yaml"))]
type ParseError = Box<dyn std::error::Error + Send + Sync>;

/// JSON, via `serde_json`. `Json<T>` produces `T`; bare `Json`
/// produces a permissive [`serde_json::Value`].
#[cfg(feature = "json")]
pub struct Json<T = serde_json::Value> {
  _marker: PhantomData<fn() -> T>,
}

#[cfg(feature = "json")]
impl<T: serde::de::DeserializeOwned> FileContent for Json<T> {
  type Value = T;

  fn parse(bytes: &[u8]) -> Result<T, ParseError> {
    let raw: serde_json::Value =
      serde_json::from_slice(bytes).map_err(|source| format!("malformed JSON: {source}"))?;
    let value = serde_json::from_value(raw).map_err(|source| {
      format!(
        "well-formed JSON, but not a {}: {source}",
        std::any::type_name::<T>()
      )
    })?;
    Ok(value)
  }
}

/// TOML, via the `toml` crate. `Toml<T>` produces `T`; bare `Toml`
/// produces a permissive [`toml::Value`].
#[cfg(feature = "toml")]
pub struct Toml<T = toml::Value> {
  _marker: PhantomData<fn() -> T>,
}

#[cfg(feature = "toml")]
impl<T: serde::de::DeserializeOwned> FileContent for Toml<T> {
  type Value = T;

  fn parse(bytes: &[u8]) -> Result<T, ParseError> {
    let text = std::str::from_utf8(bytes).map_err(|source| format!("not UTF-8: {source}"))?;
    let raw: toml::Value =
      toml::from_str(text).map_err(|source| format!("malformed TOML: {source}"))?;
    let value = raw.try_into().map_err(|source| {
      format!(
        "well-formed TOML, but not a {}: {source}",
        std::any::type_name::<T>()
      )
    })?;
    Ok(value)
  }
}

/// YAML, via `serde_yml`. `Yaml<T>` produces `T`; bare `Yaml` produces
/// a permissive [`serde_yml::Value`].
#[cfg(feature = "yaml")]
pub struct Yaml<T = serde_yml::Value> {
  _marker: PhantomData<fn() -> T>,
}

#[cfg(feature = "yaml")]
impl<T: serde::de::DeserializeOwned> FileContent for Yaml<T> {
  type Value = T;

  fn parse(bytes: &[u8]) -> Result<T, ParseError> {
    let raw: serde_yml::Value =
      serde_yml::from_slice(bytes).map_err(|source| format!("malformed YAML: {source}"))?;
    let value = serde_yml::from_value(raw).map_err(|source| {
      format!(
        "well-formed YAML, but not a {}: {source}",
        std::any::type_name::<T>()
      )
    })?;
    Ok(value)
  }
}
