//! The OpenAPI 3.1 schema model: the subset tento's derive produces and its
//! TS / Swift writers read.
//!
//! The shape follows `utoipa::openapi` 5.x on purpose (the same variants, the
//! same field names, the same JSON), so porting a writer is a change of
//! imports rather than of logic. This is the Phase 0 object-form scope,
//! not arbitrary JSON Schema: `additionalProperties` accepts either boolean,
//! and `items: false` is supported, but standalone boolean schemas and
//! `items: true` are not. Unknown keywords are retained as opaque JSON.
//! Explicit empty/null known members survive input round trips; this model
//! is not a schema validator. Three things differ from utoipa:
//!
//! - every type here deserializes from what it serializes, including the
//!   untyped `{}` schema, so a document survives a JSON round trip;
//! - keys the model does not name (`example`, `pattern`, `readOnly`,
//!   `const`, `x-…`, OpenAPI 3.0's `nullable`, …) are kept in each schema's
//!   `extra` map and written back, so converting a utoipa document through
//!   JSON loses nothing;
//! - there are no builders; the fields are public and the derive writes them.

use std::collections::BTreeMap;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

// Presence belongs to schema objects too: serde's skip rules otherwise erase
// explicit empty/null members. Keep the original spelling only while its typed
// projection is unchanged, so edits always win (including nested schema edits).
#[doc(hidden)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SchemaPresence(BTreeMap<String, FieldPresence>);

#[derive(Clone, Debug, PartialEq)]
struct FieldPresence {
  original: Option<Value>,
  baseline: Option<Value>,
}

macro_rules! schema_object {
  ($(#[$doc:meta])* $name:ident, $keys:expr, { $( $(#[doc = $field_doc:expr])* $(#[serde($($serde:tt)*)])* pub $field:ident: $ty:ty, )* }) => {
    $(#[$doc])*
    #[derive(Clone, Debug, Default, PartialEq)]
    pub struct $name {
      $( $(#[doc = $field_doc])* pub $field: $ty,)*
      /// Original known members and their typed projections. Leave default
      /// when constructing schemas; input presence survives unchanged fields.
      #[doc(hidden)]
      pub presence: SchemaPresence,
    }
    impl<'de> Deserialize<'de> for $name {
      fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Default, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields { $( $(#[serde($($serde)*)])* $field: $ty, )* }
        let original = Value::deserialize(deserializer)?;
        let mut input = original.clone();
        let map = input.as_object_mut().ok_or_else(|| D::Error::custom("expected schema object"))?;
        // Non-optional vectors/strings use their default typed projection for
        // null; presence restores the exact null unless the field is edited.
        for key in $keys {
          if !["$ref", "default"].contains(key) && map.get(*key).is_some_and(Value::is_null) { map.remove(*key); }
        }
        let fields: Fields = serde_json::from_value(input).map_err(D::Error::custom)?;
        let baseline = serde_json::to_value(&fields).map_err(D::Error::custom)?;
        let presence = SchemaPresence($keys.iter().filter_map(|key| {
          let original = original.get(*key).cloned();
          let baseline = baseline.get(*key).cloned();
          (original != baseline).then(|| ((*key).to_owned(), FieldPresence { original, baseline }))
        }).collect());
        Ok(Self { $( $field: fields.$field, )* presence })
      }
    }
    impl Serialize for $name {
      fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields<'a> { $( $(#[serde($($serde)*)])* $field: &'a $ty, )* }
        let mut json = serde_json::to_value(Fields { $( $field: &self.$field, )* })
          .map_err(serde::ser::Error::custom)?;
        for (key, field) in &self.presence.0 {
          if json.get(key) == field.baseline.as_ref() {
            match &field.original {
              Some(value) => { json[key] = value.clone(); }
              None => { json.as_object_mut().unwrap().remove(key); }
            }
          }
        }
        json.serialize(serializer)
      }
    }
  };
}

/// A schema written in place, or a `$ref` to a named component.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum RefOr<T> {
  Ref(Ref),
  T(T),
}

impl<T: Serialize> Serialize for RefOr<T> {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    match self {
      RefOr::Ref(reference) => {
        check_extra::<S::Error>("a $ref", &reference.extra, REF_KEYS)?;
        reference.serialize(serializer)
      }
      RefOr::T(value) => value.serialize(serializer),
    }
  }
}

impl<T> From<Ref> for RefOr<T> {
  fn from(reference: Ref) -> Self {
    RefOr::Ref(reference)
  }
}

impl From<Schema> for RefOr<Schema> {
  fn from(schema: Schema) -> Self {
    RefOr::T(schema)
  }
}

schema_object! {
/// `{"$ref": "#/components/schemas/<name>"}`, optionally with a description.
Ref, REF_KEYS, {
  #[serde(rename = "$ref")]
  pub ref_location: String,
  #[serde(default, skip_serializing_if = "String::is_empty")]
  pub description: String,
  #[serde(default, skip_serializing_if = "String::is_empty")]
  pub summary: String,
  /// Keys this model does not name, kept as written. It must not hold a
  /// key the model names; serializing such a value fails (see
  /// [`check_extra`]).
  #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
  pub extra: BTreeMap<String, Value>,
}}

impl Ref {
  /// A reference to the component schema `name`.
  pub fn schema(name: &str) -> Self {
    Ref {
      ref_location: format!("#/components/schemas/{name}"),
      ..Ref::default()
    }
  }

  /// The component name this reference points at, when it points into
  /// `#/components/schemas/`.
  pub fn schema_name(&self) -> Option<&str> {
    self.ref_location.strip_prefix("#/components/schemas/")
  }
}

// Field construction stays concise without exposing a builder API.
macro_rules! schema_from {
  ($($name:ident),* $(,)?) => {$(
    impl From<$name> for RefOr<Schema> {
      fn from(value: $name) -> Self { RefOr::T(Schema::$name(value)) }
    }
  )*};
}
schema_from!(Object, Array, OneOf, AllOf, AnyOf);

/// One schema object. Which variant it is follows from its keys: `oneOf`,
/// `allOf`, `anyOf`, an array `type`, or otherwise an object or primitive.
#[derive(Clone, Debug, PartialEq)]
pub enum Schema {
  Object(Object),
  Array(Array),
  OneOf(OneOf),
  AllOf(AllOf),
  AnyOf(AnyOf),
}

impl Serialize for Schema {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    match self {
      Schema::Object(schema) => {
        check_extra::<S::Error>("an object schema", &schema.extra, OBJECT_KEYS)?;
        schema.serialize(serializer)
      }
      Schema::Array(schema) => {
        check_extra::<S::Error>("an array schema", &schema.extra, ARRAY_KEYS)?;
        schema.serialize(serializer)
      }
      Schema::OneOf(schema) => {
        check_composition::<S::Error>("oneOf", &schema.extra, &schema.discriminator)?;
        schema.serialize(serializer)
      }
      Schema::AllOf(schema) => {
        check_composition::<S::Error>("allOf", &schema.extra, &schema.discriminator)?;
        schema.serialize(serializer)
      }
      Schema::AnyOf(schema) => {
        check_composition::<S::Error>("anyOf", &schema.extra, &schema.discriminator)?;
        schema.serialize(serializer)
      }
    }
  }
}

/// Keys that choose how a JSON object reads back (`$ref` makes it a
/// reference, a composition key makes it that composition). No schema's
/// `extra` may hold one.
const SELECTOR_KEYS: &[&str] = &["$ref", "oneOf", "allOf", "anyOf"];
const REF_KEYS: &[&str] = &["$ref", "description", "summary"];
const OBJECT_KEYS: &[&str] = &[
  "type",
  "title",
  "format",
  "description",
  "default",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
  "deprecated",
  "minimum",
  "maximum",
  // Not a field, but with an array `type` it would make the JSON read back
  // as an `Array`.
  "items",
];
const ARRAY_KEYS: &[&str] = &[
  "type",
  "title",
  "items",
  "prefixItems",
  "description",
  "deprecated",
  "default",
  "maxItems",
  "minItems",
  "uniqueItems",
];
const COMPOSITION_KEYS: &[&str] = &[
  "type",
  "title",
  "description",
  "default",
  "discriminator",
  "deprecated",
];
const DISCRIMINATOR_KEYS: &[&str] = &["propertyName", "mapping"];
const COMPONENTS_KEYS: &[&str] = &["schemas", "responses"];

/// `extra` holds only keys the model does not name. A modelled key there
/// would be written twice (`to_string`) or win over the field (`to_value`),
/// and a selector key would change what the JSON reads back as; both are
/// refused when serializing. Values read from JSON never break the rule:
/// serde fills the named fields first.
pub fn check_extra<E: serde::ser::Error>(
  what: &str,
  extra: &BTreeMap<String, Value>,
  modelled: &[&str],
) -> Result<(), E> {
  // A `$ref` always reads back as a reference, whatever else it holds.
  let selectors = if modelled == REF_KEYS {
    &[][..]
  } else {
    SELECTOR_KEYS
  };
  match extra
    .keys()
    .find(|key| modelled.contains(&key.as_str()) || selectors.contains(&key.as_str()))
  {
    Some(key) => Err(E::custom(format!(
      "tento-openapi: `extra` of {what} holds `{key}`, a key the model names; set the field instead"
    ))),
    None => Ok(()),
  }
}

fn check_composition<E: serde::ser::Error>(
  key: &str,
  extra: &BTreeMap<String, Value>,
  discriminator: &Option<Discriminator>,
) -> Result<(), E> {
  check_extra::<E>(&format!("a {key} schema"), extra, COMPOSITION_KEYS)?;
  if let Some(discriminator) = discriminator {
    check_extra::<E>("a discriminator", &discriminator.extra, DISCRIMINATOR_KEYS)?;
  }
  Ok(())
}

impl<'de> Deserialize<'de> for Schema {
  fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Schema::from_value(value).map_err(D::Error::custom)
  }
}

impl Schema {
  /// Reads a schema from JSON, choosing the variant by its keys.
  pub fn from_value(value: Value) -> Result<Schema, serde_json::Error> {
    let Value::Object(map) = &value else {
      return Err(serde_json::Error::custom(format!(
        "a schema is a JSON object, found {value}"
      )));
    };
    if map.contains_key("oneOf") {
      return serde_json::from_value(value).map(Schema::OneOf);
    }
    if map.contains_key("allOf") {
      return serde_json::from_value(value).map(Schema::AllOf);
    }
    if map.contains_key("anyOf") {
      return serde_json::from_value(value).map(Schema::AnyOf);
    }
    if is_array_type(map) {
      return serde_json::from_value(value).map(Schema::Array);
    }
    serde_json::from_value(value).map(Schema::Object)
  }
}

fn is_array_type(map: &Map<String, Value>) -> bool {
  match map.get("type") {
    Some(Value::String(name)) => name == "array",
    Some(Value::Array(names)) => names.iter().any(|name| name == "array"),
    _ => false,
  }
}

/// A JSON Schema primitive type name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Type {
  Object,
  String,
  Integer,
  Number,
  Boolean,
  Array,
  Null,
}

/// The `type` keyword: one type, a list (`["string", "null"]` is a nullable
/// string), or absent, which accepts any value.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum SchemaType {
  Type(Type),
  Array(Vec<Type>),
  #[default]
  AnyValue,
}

impl SchemaType {
  pub fn is_any_value(&self) -> bool {
    matches!(self, SchemaType::AnyValue)
  }

  /// The same type with `null` added; an untyped schema already admits null.
  pub fn nullable(self) -> SchemaType {
    match self {
      SchemaType::Type(Type::Null) => SchemaType::Type(Type::Null),
      SchemaType::Type(ty) => SchemaType::Array(vec![ty, Type::Null]),
      SchemaType::Array(mut types) => {
        if !types.contains(&Type::Null) {
          types.push(Type::Null);
        }
        SchemaType::Array(types)
      }
      SchemaType::AnyValue => SchemaType::AnyValue,
    }
  }

  /// Whether this type admits `null`.
  pub fn is_nullable(&self) -> bool {
    match self {
      SchemaType::Type(ty) => *ty == Type::Null,
      SchemaType::Array(types) => types.contains(&Type::Null),
      SchemaType::AnyValue => true,
    }
  }
}

impl From<Type> for SchemaType {
  fn from(ty: Type) -> Self {
    SchemaType::Type(ty)
  }
}

impl Serialize for SchemaType {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    match self {
      SchemaType::Type(ty) => ty.serialize(serializer),
      SchemaType::Array(types) => types.serialize(serializer),
      SchemaType::AnyValue => serializer.serialize_none(),
    }
  }
}

impl<'de> Deserialize<'de> for SchemaType {
  fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
      One(Type),
      Many(Vec<Type>),
    }
    Ok(match Option::<Raw>::deserialize(deserializer)? {
      Some(Raw::One(ty)) => SchemaType::Type(ty),
      Some(Raw::Many(types)) => SchemaType::Array(types),
      None => SchemaType::AnyValue,
    })
  }
}

/// The `format` keyword: one of the formats utoipa names, or any other
/// string. Same shape as `utoipa::openapi::SchemaFormat`, so the writers'
/// `match`es port unchanged.
///
/// A string equal to a known format's name always reads back as that known
/// format: utoipa's `Custom("uuid")` arrives as `KnownFormat(Uuid)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SchemaFormat {
  KnownFormat(KnownFormat),
  Custom(String),
}

/// utoipa 5's known formats, every feature's, with its JSON spellings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KnownFormat {
  Int8,
  Int16,
  Int32,
  Int64,
  #[serde(rename = "u-int8")]
  UInt8,
  #[serde(rename = "u-int16")]
  UInt16,
  #[serde(rename = "u-int32")]
  UInt32,
  #[serde(rename = "u-int64")]
  UInt64,
  Float,
  Double,
  Byte,
  Binary,
  Time,
  Date,
  DateTime,
  Duration,
  Password,
  Uuid,
  Ulid,
  Uri,
  UriReference,
  Iri,
  IriReference,
  Email,
  IdnEmail,
  Hostname,
  IdnHostname,
  Ipv4,
  Ipv6,
  UriTemplate,
  JsonPointer,
  RelativeJsonPointer,
  Regex,
}

schema_object! {
/// An object, a primitive, an enum of values or the untyped schema: every
/// schema that is not an array or a composition.
Object, OBJECT_KEYS, {
  #[serde(
    rename = "type",
    default,
    skip_serializing_if = "SchemaType::is_any_value"
  )]
  pub schema_type: SchemaType,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub format: Option<SchemaFormat>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "present"
  )]
  pub default: Option<Value>,
  #[serde(rename = "enum", default, skip_serializing_if = "Option::is_none")]
  pub enum_values: Option<Vec<Value>>,
  /// Required property names, in field order.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub required: Vec<String>,
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub properties: BTreeMap<String, RefOr<Schema>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub additional_properties: Option<Box<AdditionalProperties>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub property_names: Option<Box<Schema>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub deprecated: Option<bool>,
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    serialize_with = "number_without_zero_fraction"
  )]
  pub minimum: Option<f64>,
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    serialize_with = "number_without_zero_fraction"
  )]
  pub maximum: Option<f64>,
  /// Keys this model does not name, kept as written. It must not hold a
  /// key the model names; serializing such a value fails (see
  /// [`check_extra`]).
  #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
  pub extra: BTreeMap<String, Value>,
}}

impl Object {
  /// `{"type": "object"}` with no properties yet.
  pub fn new() -> Self {
    Object::with_type(Type::Object)
  }

  pub fn with_type(ty: impl Into<SchemaType>) -> Self {
    Object {
      schema_type: ty.into(),
      ..Object::default()
    }
  }

  /// The untyped schema `{}`, which accepts any JSON value.
  pub fn any() -> Self {
    Object::default()
  }
}

/// `additionalProperties`: a schema every extra value must match, or `false`
/// (no extra properties) / `true` (any).
// Always held in a `Box` by `Object`, so the variants' sizes do not matter.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AdditionalProperties {
  FreeForm(bool),
  RefOr(RefOr<Schema>),
}

schema_object! {
/// `{"type": "array", "items": …}`.
Array, ARRAY_KEYS, {
  #[serde(rename = "type", default)]
  pub schema_type: SchemaType,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(default)]
  pub items: ArrayItems,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub prefix_items: Vec<Schema>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub deprecated: Option<bool>,
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "present"
  )]
  pub default: Option<Value>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub max_items: Option<usize>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub min_items: Option<usize>,
  #[serde(default, skip_serializing_if = "is_false")]
  pub unique_items: bool,
  /// Keys this model does not name, kept as written. It must not hold a
  /// key the model names; serializing such a value fails (see
  /// [`check_extra`]).
  #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
  pub extra: BTreeMap<String, Value>,
}}

impl Array {
  pub fn new(items: RefOr<Schema>) -> Self {
    Array {
      schema_type: SchemaType::Type(Type::Array),
      title: None,
      items: ArrayItems::RefOrSchema(Box::new(items)),
      prefix_items: Vec::new(),
      description: None,
      deprecated: None,
      default: None,
      max_items: None,
      min_items: None,
      unique_items: false,
      extra: BTreeMap::new(),
      presence: SchemaPresence::default(),
    }
  }
}

/// `items`: the element schema, or `false` for a tuple fully described by
/// `prefixItems`.
#[derive(Clone, Debug, PartialEq)]
pub enum ArrayItems {
  RefOrSchema(Box<RefOr<Schema>>),
  False,
}

impl Default for ArrayItems {
  fn default() -> Self {
    Self::RefOrSchema(Box::new(Object::any().into()))
  }
}

impl Serialize for ArrayItems {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    match self {
      ArrayItems::RefOrSchema(items) => items.serialize(serializer),
      ArrayItems::False => serializer.serialize_bool(false),
    }
  }
}

impl<'de> Deserialize<'de> for ArrayItems {
  fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    match Value::deserialize(deserializer)? {
      Value::Bool(false) => Ok(ArrayItems::False),
      value => serde_json::from_value(value)
        .map(|items| ArrayItems::RefOrSchema(Box::new(items)))
        .map_err(D::Error::custom),
    }
  }
}

/// Fields shared by `oneOf`, `allOf` and `anyOf`.
macro_rules! composition {
  ($(#[$doc:meta])* $name:ident, $key:literal) => {
    schema_object! { $(#[$doc])* $name, &[ $key, "type", "title", "description", "default", "discriminator", "deprecated" ], {
      #[serde(rename = $key, default)]
      pub items: Vec<RefOr<Schema>>,
      #[serde(rename = "type", default, skip_serializing_if = "SchemaType::is_any_value")]
      pub schema_type: SchemaType,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub title: Option<String>,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub description: Option<String>,
      #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
      pub default: Option<Value>,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub discriminator: Option<Discriminator>,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub deprecated: Option<bool>,
      /// Keys this model does not name, kept as written. It must not hold a
      /// key the model names, nor another composition's key; serializing
      /// such a value fails (see [`check_extra`]).
      #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
      pub extra: BTreeMap<String, Value>,

    }}

    impl $name {
      pub fn new(items: Vec<RefOr<Schema>>) -> Self {
        $name { items, ..$name::default() }
      }
    }
  };
}

composition!(
  /// Exactly one of `items` matches: an enum's variants, a nullable reference.
  OneOf,
  "oneOf"
);
composition!(
  /// Every one of `items` matches: a struct with `#[serde(flatten)]` fields.
  AllOf,
  "allOf"
);
composition!(
  /// At least one of `items` matches.
  AnyOf,
  "anyOf"
);

schema_object! {
/// Names the property whose value selects a `oneOf` branch.
Discriminator, DISCRIMINATOR_KEYS, {
  #[serde(default)]
  pub property_name: String,
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub mapping: BTreeMap<String, String>,
  /// Keys this model does not name, kept as written. It must not hold a
  /// key the model names; serializing such a value fails (see
  /// [`check_extra`]).
  #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
  pub extra: BTreeMap<String, Value>,
}}

/// Named schema and response components, with other component kinds in extra.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Components {
  pub schemas: BTreeMap<String, RefOr<Schema>>,
  pub responses: BTreeMap<String, RefOr<crate::Response>>,
  pub extra: BTreeMap<String, Value>,
  /// Preserve explicitly empty component maps read from JSON.
  #[doc(hidden)]
  pub present: std::collections::BTreeSet<String>,
}

impl<'de> Deserialize<'de> for Components {
  fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    #[derive(Deserialize)]
    struct Fields {
      #[serde(default)]
      schemas: BTreeMap<String, RefOr<Schema>>,
      #[serde(default)]
      responses: BTreeMap<String, RefOr<crate::Response>>,
      #[serde(flatten)]
      extra: BTreeMap<String, Value>,
    }
    let json = Value::deserialize(deserializer)?;
    let present = json
      .as_object()
      .ok_or_else(|| D::Error::custom("expected components object"))?
      .keys()
      .filter(|key| COMPONENTS_KEYS.contains(&key.as_str()))
      .cloned()
      .collect();
    let fields: Fields = serde_json::from_value(json).map_err(D::Error::custom)?;
    Ok(Self {
      schemas: fields.schemas,
      responses: fields.responses,
      extra: fields.extra,
      present,
    })
  }
}

impl Serialize for Components {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    check_extra::<S::Error>("components", &self.extra, COMPONENTS_KEYS)?;
    let mut map = serializer.serialize_map(None)?;
    if !self.schemas.is_empty() || self.present.contains("schemas") {
      map.serialize_entry("schemas", &self.schemas)?;
    }
    if !self.responses.is_empty() || self.present.contains("responses") {
      map.serialize_entry("responses", &self.responses)?;
    }
    for (key, value) in &self.extra {
      map.serialize_entry(key, value)?;
    }
    map.end()
  }
}

fn is_false(value: &bool) -> bool {
  !*value
}

/// A present `default` is kept even when it is `null`: `"default": null`
/// (an untagged unit variant) is a value, not an absent key.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
  Value::deserialize(deserializer).map(Some)
}

/// utoipa writes `0.0` as `0`; so does this model, so the two agree on JSON.
fn number_without_zero_fraction<S: Serializer>(
  value: &Option<f64>,
  serializer: S,
) -> Result<S::Ok, S::Error> {
  match value {
    Some(number) if number.fract() == 0.0 && number.abs() < 9.0e15 => {
      serializer.serialize_i64(*number as i64)
    }
    Some(number) => serializer.serialize_f64(*number),
    None => serializer.serialize_none(),
  }
}
