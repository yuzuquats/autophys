//! Runtime half of `#[derive(ToSchema)]`.
//!
//! The derive emits calls to these functions instead of inlining the
//! construction of every schema, so each derive expands to a short list of
//! calls; how much code the derive asks rustc to compile is part of what this
//! crate exists to reduce. Not a public API.

use std::borrow::Cow;

use serde_json::Value;
pub use serde_json::{self, json};

use crate::Object;
use crate::model::{AdditionalProperties, AllOf, OneOf, SchemaType, Type};

pub use crate::model::{RefOr, Schema};
pub use crate::{Site, ToSchema, register};

/// `Some(name)`, for `ToSchema::name`.
pub fn name(name: &'static str) -> Option<Cow<'static, str>> {
  Some(Cow::Borrowed(name))
}

/// The use site the derive describes with `docs` (`""` for none) and flag
/// bits: 1 inline, 2 deprecated, 4 nullable, 8 not nullable.
pub fn site(docs: &str, flags: u8) -> Site {
  Site {
    description: text(docs),
    nullable: match flags & 12 {
      4 => Some(true),
      8 => Some(false),
      _ => None,
    },
    default: None,
    inline: flags & 1 != 0,
    deprecated: flags & 2 != 0,
  }
}

/// [`site`] with the JSON of a container `#[serde(default)]` value.
pub fn site_default<T: serde::Serialize>(docs: &str, flags: u8, value: &T) -> Site {
  Site {
    default: serde_json::to_value(value).ok(),
    ..site(docs, flags)
  }
}

fn text(description: &str) -> Option<String> {
  (!description.is_empty()).then(|| description.to_owned())
}

/// The object a struct's (or a named variant's) fields are written into,
/// and the `allOf` parts its `#[serde(flatten)]` fields contribute.
#[derive(Default)]
pub struct Fields {
  pub object: Object,
  all_of: Vec<RefOr<Schema>>,
  has_fields: bool,
  has_flattened_map: bool,
}

impl Fields {
  pub fn new() -> Self {
    Fields {
      object: Object::new(),
      ..Fields::default()
    }
  }

  pub fn field(&mut self, name: &str, schema: RefOr<Schema>, required: bool) {
    self.has_fields = true;
    self.object.properties.insert(name.to_owned(), schema);
    if required {
      self.object.required.push(name.to_owned());
    }
  }

  /// A flattened map adds `additionalProperties`; anything else is an
  /// `allOf` part.
  pub fn flatten(&mut self, schema: RefOr<Schema>) {
    match schema {
      RefOr::T(Schema::Object(map))
        if map.properties.is_empty() && map.additional_properties.is_some() =>
      {
        if !self.has_flattened_map {
          self.object.additional_properties = map.additional_properties;
          self.has_flattened_map = true;
        }
      }
      other => self.all_of.push(other),
    }
  }

  /// Whether a flattened field turned the schema into an `allOf`.
  pub fn is_all_of(&self) -> bool {
    !self.all_of.is_empty()
  }

  /// The struct's schema: its object, or `allOf` the flattened parts and the
  /// object (when it has fields of its own).
  pub fn finish(
    mut self,
    deny_unknown_fields: bool,
    description: &str,
    deprecated: bool,
  ) -> Schema {
    if self.all_of.is_empty() {
      if deny_unknown_fields {
        self.object.additional_properties = Some(Box::new(AdditionalProperties::FreeForm(false)));
      }
      self.object.description = text(description);
      if deprecated {
        self.object.deprecated = Some(true);
      }
      return Schema::Object(self.object);
    }
    let mut items = self.all_of;
    if self.has_fields {
      items.push(RefOr::T(Schema::Object(self.object)));
    }
    Schema::AllOf(AllOf {
      description: text(description),
      deprecated: deprecated.then_some(true),
      ..AllOf::new(items)
    })
  }
}

/// `{"type": "string", "enum": [values…]}`.
pub fn string_enum(values: &[&str]) -> Schema {
  Schema::Object(string_object(values))
}

fn string_object(values: &[&str]) -> Object {
  Object {
    enum_values: Some(values.iter().map(|v| Value::from(*v)).collect()),
    ..Object::with_type(Type::String)
  }
}

/// A plain enum tagged internally: one tag-only object per variant.
pub fn tagged_units(tag: &str, names: &[&str]) -> Schema {
  one_of(
    names
      .iter()
      .map(|name| RefOr::T(Schema::Object(tag_object(tag, name))))
      .collect(),
  )
}

/// A plain enum tagged adjacently. utoipa 5 puts the variant name under the
/// content key and the content key's own name under the tag; kept so the
/// generated TS stays the same.
pub fn adjacent_units(tag: &str, content: &str, names: &[&str]) -> Schema {
  one_of(
    names
      .iter()
      .map(|name| {
        RefOr::T(adjacent(
          RefOr::T(string_enum(&[name])),
          tag,
          content,
          content,
        ))
      })
      .collect(),
  )
}

/// `{"type": "object", "properties": {tag: {"enum": [value]}}, "required": [tag]}`.
pub fn tag_object(tag: &str, value: &str) -> Object {
  let mut object = Object::new();
  add_tag(&mut object, tag, value);
  object
}

fn add_tag(object: &mut Object, tag: &str, value: &str) {
  object.properties.insert(
    tag.to_owned(),
    RefOr::T(Schema::Object(string_object(&[value]))),
  );
  object.required.push(tag.to_owned());
}

/// An untagged unit variant: `{"type": "null", "default": null}`.
pub fn null_unit() -> Object {
  Object {
    default: Some(Value::Null),
    ..Object::with_type(Type::Null)
  }
}

/// Applies a variant's (or enum's) description and deprecation.
pub fn describe(mut schema: Schema, description: &str, deprecated: bool) -> Schema {
  let (slot, flag) = match &mut schema {
    Schema::Object(o) => (&mut o.description, &mut o.deprecated),
    Schema::Array(a) => (&mut a.description, &mut a.deprecated),
    Schema::OneOf(o) => (&mut o.description, &mut o.deprecated),
    Schema::AllOf(o) => (&mut o.description, &mut o.deprecated),
    Schema::AnyOf(o) => (&mut o.description, &mut o.deprecated),
  };
  if !description.is_empty() {
    *slot = Some(description.to_owned());
  }
  if deprecated {
    *flag = Some(true);
  }
  schema
}

/// Externally tagged: `{"type": "object", "properties": {name: inner}, "required": [name]}`.
pub fn external(name: &str, inner: RefOr<Schema>) -> Schema {
  let mut object = Object::new();
  object.properties.insert(name.to_owned(), inner);
  object.required.push(name.to_owned());
  Schema::Object(object)
}

/// Internally tagged named variant: the tag joins the variant's own object,
/// or, when flattening made it an `allOf`, is one more part of it.
pub fn internal_named(
  inner: Schema,
  tag: &str,
  name: &str,
  description: &str,
  deprecated: bool,
) -> Schema {
  match inner {
    Schema::Object(mut object) => {
      add_tag(&mut object, tag, name);
      describe(Schema::Object(object), description, deprecated)
    }
    Schema::AllOf(mut all_of) => {
      let tag = describe(
        Schema::Object(tag_object(tag, name)),
        description,
        deprecated,
      );
      all_of.items.push(RefOr::T(tag));
      Schema::AllOf(all_of)
    }
    other => other,
  }
}

/// Internally tagged newtype variant: `allOf` the inner schema and the tag
/// when the inner schema is a reference, else the tag merged into it.
pub fn internal_unnamed(
  inner: RefOr<Schema>,
  tag: &str,
  name: &str,
  description: &str,
  deprecated: bool,
) -> Schema {
  match inner {
    RefOr::T(Schema::Object(mut object)) => {
      object.schema_type = SchemaType::Type(Type::Object);
      add_tag(&mut object, tag, name);
      describe(Schema::Object(object), description, deprecated)
    }
    reference => {
      let all_of = AllOf::new(vec![
        reference,
        RefOr::T(Schema::Object(tag_object(tag, name))),
      ]);
      describe(Schema::AllOf(all_of), description, deprecated)
    }
  }
}

/// Adjacently tagged: `{"properties": {content: inner, tag: {"enum": [name]}}, "required": [content, tag]}`.
pub fn adjacent(inner: RefOr<Schema>, tag: &str, content: &str, name: &str) -> Schema {
  let mut object = Object::new();
  object.properties.insert(content.to_owned(), inner);
  object.required.push(content.to_owned());
  add_tag(&mut object, tag, name);
  Schema::Object(object)
}

/// An enum's variants: `{"oneOf": [...]}`.
pub fn one_of(items: Vec<RefOr<Schema>>) -> Schema {
  Schema::OneOf(OneOf::new(items))
}

/// `Object` in a `value_type`: a free-form object, `{"type": "object"}`.
pub struct FreeFormObject;

impl ToSchema for FreeFormObject {
  fn at_site(site: &Site) -> RefOr<Schema> {
    let mut site = site.clone();
    // Utoipa's virtual Object branch emits description/nullability but omits
    // container defaults, even when the underlying serde value is non-null.
    site.default = None;
    site.decorate(Self::schema())
  }
  fn schema() -> RefOr<Schema> {
    RefOr::T(Schema::Object(Object::new()))
  }
}

/// `Value` in a `value_type`: any value, `{}`.
pub struct AnyValue;

impl ToSchema for AnyValue {
  fn at_site(site: &Site) -> RefOr<Schema> {
    <serde_json::Value as ToSchema>::at_site(site)
  }
  fn schema() -> RefOr<Schema> {
    RefOr::T(Schema::Object(Object::any()))
  }
}

/// Request bodies retain utoipa's optional-body requiredness.
pub fn request_body<T: ToSchema>(schema: RefOr<Schema>, content_type: &str) -> crate::RequestBody {
  crate::RequestBody {
    content: [(
      content_type.into(),
      crate::Content {
        schema: Some(schema),
        ..Default::default()
      },
    )]
    .into(),
    required: (!T::is_option()).then_some(crate::Required::True),
    ..Default::default()
  }
}

/// Explicit path parameters are always required, including an Option type.
pub fn parameter(
  name: &str,
  location: crate::ParameterIn,
  description: &str,
  required: bool,
  schema: Option<RefOr<Schema>>,
) -> crate::Parameter {
  let required = location == crate::ParameterIn::Path || required;
  crate::Parameter {
    name: name.into(),
    parameter_in: Some(location),
    required: Some(if required {
      crate::Required::True
    } else {
      crate::Required::False
    }),
    description: (!description.is_empty()).then(|| description.into()),
    schema,
    ..Default::default()
  }
}

