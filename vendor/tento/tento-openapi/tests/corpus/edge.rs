//! Synthetic types, one per rule the derive implements, shaped after real
//! uses (cited per type). Each derives both utoipa's and tento's
//! `ToSchema`.
#![allow(dead_code, deprecated)]

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! both {
  ($($item:item)*) => {$(
    #[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
    $item
  )*};
}

both! {
  /// Every primitive a wire struct uses.
  ///
  ///   Indented second paragraph, kept relative to the first.
  pub struct Primitives {
    pub text: String,
    pub letter: char,
    pub flag: bool,
    pub i8_: i8,
    pub i16_: i16,
    pub i32_: i32,
    pub i64_: i64,
    pub i128_: i128,
    pub isize_: isize,
    pub u8_: u8,
    pub u16_: u16,
    pub u32_: u32,
    pub u64_: u64,
    pub u128_: u128,
    pub usize_: usize,
    pub f32_: f32,
    pub f64_: f64,
    pub at: DateTime<Utc>,
    pub naive_at: NaiveDateTime,
    pub day: NaiveDate,
    pub time: NaiveTime,
    pub id: Uuid,
    pub any: serde_json::Value,
    pub maybe_any: Option<serde_json::Value>,
  }

  /// A referenced struct.
  #[serde(rename_all = "camelCase")]
  pub struct Leaf {
    /// The leaf's label.
    pub label_text: String,
  }

  /// Containers around a reference and around primitives.
  #[serde(rename_all = "camelCase")]
  pub struct Containers {
    /// A documented reference.
    pub leaf: Leaf,
    /// A documented optional reference.
    pub maybe_leaf: Option<Leaf>,
    pub leaves: Vec<Leaf>,
    /// Documented optional list of references.
    pub maybe_leaves: Option<Vec<Leaf>>,
    pub sparse: Vec<Option<String>>,
    pub sparse_leaves: Vec<Option<Leaf>>,
    pub by_name: HashMap<String, Leaf>,
    pub series: BTreeMap<String, Vec<i64>>,
    pub tags: BTreeSet<String>,
    pub boxed: Box<Leaf>,
    pub nested: Vec<Vec<u32>>,
    pub maybe_map: Option<HashMap<String, String>>,
  }

  /// serde attributes that change `required` and the property set (the
  /// tento-lona `wire.rs` shapes use all of them).
  #[serde(rename_all = "camelCase")]
  pub struct SerdeRules {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub defaulted: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sparse: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sparse_list: Vec<u8>,
    #[serde(skip)]
    pub hidden: u32,
    #[serde(skip_serializing)]
    pub write_only: u32,
    #[serde(alias = "oldName")]
    pub new_name: String,
    #[serde(rename(serialize = "ser", deserialize = "de"))]
    pub split_rename: String,
    pub r#ref: String,
    #[deprecated]
    pub old: Option<String>,
  }

  /// `#[schema(...)]` keys the corpus uses.
  pub struct SchemaKeys {
    #[schema(required)]
    pub forced: Option<String>,
    #[schema(required = false)]
    pub relaxed: String,
    #[schema(value_type = String)]
    pub as_string: Uuid,
    #[schema(value_type = Object)]
    pub free_form: serde_json::Value,
    #[schema(value_type = Option<Vec<Option<Leaf>>>)]
    pub overridden: Option<Vec<Option<Uuid>>>,
    #[schema(inline)]
    pub inlined: Leaf,
    /// Inline with a description.
    #[schema(inline)]
    pub inlined_described: Leaf,
    #[schema(inline)]
    pub inlined_list: Vec<Leaf>,
    #[schema(inline)]
    pub maybe_inlined: Option<Leaf>,
    #[schema(nullable = false)]
    pub not_null: Option<String>,
    #[schema(rename = "renamedBySchema")]
    pub schema_renamed: String,
  }

  /// `#[schema(as = …)]` renames the component.
  #[schema(as = HealthCell)]
  pub struct HealthCellRow {
    pub value: f64,
  }

  pub struct UsesRenamed {
    pub cell: HealthCellRow,
  }

  /// Rejects unknown fields.
  #[serde(deny_unknown_fields)]
  pub struct Strict {
    pub only: String,
  }

  /// Flattens a struct and a map.
  pub struct Flattened {
    pub own: String,
    #[serde(flatten)]
    pub leaf: Leaf,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
  }

  /// Only a flattened map.
  pub struct OnlyMap {
    #[serde(flatten)]
    pub rest: HashMap<String, String>,
  }

  /// A documented id.
  pub struct UserId(pub Uuid);

  /// A documented wrapper around a reference.
  pub struct LeafWrapper(pub Leaf);

  pub struct UsesNewtypes {
    pub user: UserId,
    pub wrapper: Option<LeafWrapper>,
  }

  #[serde(rename_all = "SCREAMING_SNAKE_CASE")]
  pub enum Plain {
    FirstOne,
    SecondTwo,
    #[serde(rename = "third")]
    Third,
    #[serde(skip)]
    Hidden,
  }

  #[serde(rename_all = "kebab-case")]
  pub enum Kebab {
    ALongName,
    B,
  }

  /// A plain enum tagged internally.
  #[serde(tag = "kind")]
  pub enum PlainTagged {
    A,
    B,
  }

  #[serde(untagged)]
  pub enum PlainUntagged {
    A,
    B,
  }

  /// Externally tagged, every variant shape.
  #[serde(rename_all = "camelCase")]
  pub enum Mixed {
    /// A unit variant.
    Unit,
    /// A named variant.
    #[serde(rename_all = "camelCase")]
    Named {
      /// Its field.
      some_field: Option<i32>,
      leaf: Leaf,
    },
    /// A newtype variant.
    Newtype(Leaf),
    Primitive(String),
  }

  /// Internally tagged, as tento-lona's change events are.
  #[serde(tag = "type", rename_all = "snake_case")]
  pub enum Internal {
    Unit,
    /// Named.
    Named { value: u64 },
    /// Newtype of a reference.
    Wraps(Leaf),
    WithFlatten {
      #[serde(flatten)]
      leaf: Leaf,
      own: bool,
    },
  }

  #[serde(untagged)]
  pub enum Untagged {
    Text(String),
    Leaf(Leaf),
    Named { a: String },
    Nothing,
  }

  #[serde(tag = "t", content = "c")]
  pub enum Adjacent {
    Unit,
    Named { a: String },
    Newtype(Leaf),
  }

  /// A recursive tree. utoipa needs `no_recursion` to stop collecting its
  /// references; tento accepts and ignores it.
  #[schema(no_recursion)]
  pub struct Tree {
    pub children: Vec<Tree>,
    pub parent: Option<Box<Tree>>,
  }

  /// A deprecated type.
  #[deprecated]
  pub struct Old {
    pub a: String,
  }
}

/// A container `#[serde(default)]` writes every field's default value.
#[derive(Default, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct Defaults {
  pub count: u32,
  pub name: String,
  pub maybe: Option<String>,
  pub leaf_list: Vec<Leaf>,
  pub leaf: Option<Leaf>,
}

/// A local type that shares a name with one utoipa treats as built in.
pub mod shadow {
  use serde::{Deserialize, Serialize};

  /// Not `serde_json::Value`.
  #[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
  pub struct Value {
    pub raw: String,
  }
}

/// utoipa reads a field's type by the spelling of its last path segment, so
/// `shadow::Value` becomes the untyped `{}`; tento reads the type's own
/// `ToSchema`, so it is a `$ref` to the `Value` component.
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
pub struct UsesShadowedName {
  pub value: shadow::Value,
}

/// A type with serde but no schema, wrapped below (tento-lona-connector's
/// `Cell` behind lona-models' `SheetCell`).
#[derive(Serialize, Deserialize)]
pub struct Foreign {
  pub raw: String,
}

both! {
  /// A type-level `value_type`: the wrapper's schema is `Leaf`'s.
  #[serde(transparent)]
  #[schema(value_type = Leaf)]
  pub struct LeafCell(pub Foreign);

  /// `value_type` with utoipa's special names nested (tento-agent-queue
  /// `model.rs`), and `required` following the `value_type`.
  pub struct ValueTypes {
    #[schema(value_type = Option<Object>)]
    pub maybe_object: Option<serde_json::Value>,
    #[schema(value_type = Vec<Object>)]
    pub objects: Vec<serde_json::Value>,
    #[schema(value_type = Option<Value>)]
    pub maybe_any: Option<serde_json::Value>,
    /// Declared required, `value_type` optional: not required.
    #[schema(value_type = Option<String>)]
    pub declared_required: String,
    /// Declared optional, `value_type` required: required.
    #[schema(value_type = String)]
    pub declared_optional: Option<String>,
    pub cell: LeafCell,
  }

  /// `Box<Option<T>>` is nullable and, as in utoipa, still required.
  pub struct Boxed {
    pub boxed_option: Box<Option<String>>,
    pub option_box: Option<Box<Leaf>>,
  }

  /// utoipa's `camelCase` keeps a leading underscore's effect: `_type` is
  /// `Type` (serde writes `type`).
  #[serde(rename_all = "camelCase")]
  pub struct Underscores {
    pub _lead: String,
    pub _type: String,
    pub trailing_: String,
    pub plain_name: String,
  }

  /// `#[schema(rename)]` on variants of each shape.
  pub enum SchemaRenamedVariants {
    #[schema(rename = "renamedNamed")]
    Named { a: String },
    #[schema(rename = "renamedUnit")]
    Unit,
  }
}
