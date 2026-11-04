//! The data model of a native's arguments and results — `#[derive(Schema)]`.
//!
//! A [`TypeDesc`] is the structured type a reflection consumer reads: field
//! names as serde spells them, a WIT-like type (`string`, `bool`, `s64`, `u64`,
//! `f64`, `option<T>`, `list<T>`, a record, a fieldless `enum`), the `///` docs,
//! and the presentation hints `#[view(…)]` attaches. One descriptor serves
//! argument types and result types alike; the shape wrappers
//! ([`crate::shape`]) read its `view` hints to build columns. Presentation never
//! changes the serialized data: `#[view]` is read here and nowhere else.
//!
//! ```ignore
//! use tento_lisp_cmd::schema::Schema;
//!
//! #[derive(serde::Serialize, Schema)]
//! struct Entry {
//!   /// The file name.
//!   name: String,
//!   #[view(header = "SIZE", align = right, format = bytes)]
//!   size: u64,
//! }
//! ```

use std::collections::{BTreeSet, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use tento_lisp_macros::Schema;

/// A structured type, tagged on `kind` (`{"kind":"list","of":{"kind":"string"}}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TypeDesc {
  String,
  Bool,
  S64,
  U64,
  F64,
  /// Untyped JSON (`serde_json::Value`, or a type that declares no schema).
  Any,
  Option {
    of: Box<TypeDesc>,
  },
  List {
    of: Box<TypeDesc>,
  },
  Record {
    name: String,
    fields: Vec<FieldDesc>,
  },
  /// A fieldless enum: its member names as serde spells them.
  Enum {
    name: String,
    cases: Vec<String>,
    /// How cases draw as cells (`#[view(label, style)]` on a variant): only
    /// the cases that carry a view, in declaration order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    views: Vec<CaseView>,
  },
  /// An enum whose cases carry data.
  Variant {
    name: String,
    cases: Vec<CaseDesc>,
  },
}

/// One field of a [`TypeDesc::Record`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldDesc {
  pub name: String,
  #[serde(rename = "type")]
  pub ty: TypeDesc,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub doc: Option<String>,
  #[serde(default, skip_serializing_if = "ViewDesc::is_empty")]
  pub view: ViewDesc,
}

/// One case of a [`TypeDesc::Variant`]; `ty` is `None` for a unit case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaseDesc {
  pub name: String,
  #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
  pub ty: Option<TypeDesc>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub doc: Option<String>,
}

/// How one case of a fieldless enum draws as a cell. `label` replaces its
/// serde name on screen and `style` paints it; the data keeps the serde name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaseView {
  pub case: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label: Option<String>,
  /// A style as `tento_term::Style::from_wire` reads it: a legacy name
  /// (`bold`, `dimmed`) or a theme role (`status.ok`, `text.faint`).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub style: Option<String>,
}

/// Column alignment a `#[view(align = …)]` asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewAlign {
  Left,
  Right,
}

/// The presentation hints of one field (`#[view(…)]`). Read only by the human
/// renderers; the data a command returns is the same with or without them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewDesc {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub header: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub align: Option<ViewAlign>,
  /// A cell format name as `tento_term::CellFormat::from_name` reads it
  /// (`size_bytes`, `age_ms`, `text`).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub format: Option<String>,
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub skip: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub section: Option<String>,
  /// The column (or value) style: a legacy name (`bold`, `dimmed`) or a theme
  /// role (`status.info`, `text.secondary`). An enum case's own view wins.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub style: Option<String>,
}

impl ViewDesc {
  pub fn is_empty(&self) -> bool {
    *self == ViewDesc::default()
  }
}

impl TypeDesc {
  pub fn option(of: TypeDesc) -> Self {
    TypeDesc::Option { of: Box::new(of) }
  }
  pub fn list(of: TypeDesc) -> Self {
    TypeDesc::List { of: Box::new(of) }
  }

  /// The WIT spelling: `list<option<string>>`, a record or enum by its
  /// kebab-case name, `any` for untyped JSON.
  pub fn wit(&self) -> String {
    match self {
      TypeDesc::String => "string".into(),
      TypeDesc::Bool => "bool".into(),
      TypeDesc::S64 => "s64".into(),
      TypeDesc::U64 => "u64".into(),
      TypeDesc::F64 => "f64".into(),
      TypeDesc::Any => "any".into(),
      TypeDesc::Option { of } => format!("option<{}>", of.wit()),
      TypeDesc::List { of } => format!("list<{}>", of.wit()),
      TypeDesc::Record { name, .. }
      | TypeDesc::Enum { name, .. }
      | TypeDesc::Variant { name, .. } => kebab(name),
    }
  }

  /// The view of enum case `case` (its serde name), looking through
  /// `option<…>`; `None` when the type is no enum or the case carries none.
  pub fn case_view(&self, case: &str) -> Option<&CaseView> {
    match self {
      TypeDesc::Enum { views, .. } => views.iter().find(|v| v.case == case),
      TypeDesc::Option { of } => of.case_view(case),
      _ => None,
    }
  }

  /// The record fields, looking through `option<…>`; `None` for non-records.
  pub fn record_fields(&self) -> Option<&[FieldDesc]> {
    match self {
      TypeDesc::Record { fields, .. } => Some(fields),
      TypeDesc::Option { of } => of.record_fields(),
      _ => None,
    }
  }
}

/// `EntryKind` → `entry-kind`.
fn kebab(name: &str) -> String {
  let mut out = String::new();
  for (i, c) in name.chars().enumerate() {
    if c.is_uppercase() {
      if i > 0 && !out.ends_with('-') {
        out.push('-');
      }
      out.extend(c.to_lowercase());
    } else if c == '_' {
      out.push('-');
    } else {
      out.push(c);
    }
  }
  out
}

/// The data model of a type. `#[derive(Schema)]` implements it for structs and
/// enums; the impls below cover the scalar and container types fields use.
pub trait Schema {
  fn schema() -> TypeDesc;
}

macro_rules! scalar_schema {
  ($desc:ident: $($t:ty),*) => {
    $(impl Schema for $t {
      fn schema() -> TypeDesc {
        TypeDesc::$desc
      }
    })*
  };
}

scalar_schema!(String: String, str, char, PathBuf, Path, uuid::Uuid);
scalar_schema!(Bool: bool);
scalar_schema!(S64: i8, i16, i32, i64, i128, isize);
scalar_schema!(U64: u8, u16, u32, u64, u128, usize);
scalar_schema!(F64: f32, f64);
scalar_schema!(Any: serde_json::Value);

impl<T: Schema> Schema for Option<T> {
  fn schema() -> TypeDesc {
    TypeDesc::option(T::schema())
  }
}

macro_rules! list_schema {
  ($($t:ident),*) => {
    $(impl<T: Schema> Schema for $t<T> {
      fn schema() -> TypeDesc {
        TypeDesc::list(T::schema())
      }
    })*
  };
}

list_schema!(Vec, VecDeque, BTreeSet, HashSet);

impl<T: Schema> Schema for [T] {
  fn schema() -> TypeDesc {
    TypeDesc::list(T::schema())
  }
}

impl<T: Schema + ?Sized> Schema for &T {
  fn schema() -> TypeDesc {
    T::schema()
  }
}

impl<T: Schema + ?Sized> Schema for Box<T> {
  fn schema() -> TypeDesc {
    T::schema()
  }
}

impl<T: Schema + ?Sized> Schema for std::sync::Arc<T> {
  fn schema() -> TypeDesc {
    T::schema()
  }
}

impl<T: Schema + ToOwned + ?Sized> Schema for std::borrow::Cow<'_, T> {
  fn schema() -> TypeDesc {
    T::schema()
  }
}

#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;
