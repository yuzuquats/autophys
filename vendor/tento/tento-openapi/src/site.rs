//! Where a type is used, and what that changes about its schema.

use std::borrow::Cow;

use serde_json::Value;

use crate::Object;
use crate::model::{OneOf, Ref, RefOr, Schema, Type};

/// The modifiers a use site applies to a type's schema: a field's `///`
/// docs, `Option`'s nullability, a container `#[serde(default)]` value and
/// `#[schema(inline)]`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Site {
  pub description: Option<String>,
  /// `None`: as the type says (`Option` sets it); `Some(false)`:
  /// `#[schema(nullable = false)]`; `Some(true)`: nullable.
  pub nullable: Option<bool>,
  pub default: Option<Value>,
  /// Write a named type's definition in place instead of a `$ref`.
  pub inline: bool,
  pub deprecated: bool,
}

impl Site {
  /// The site of a container's element (a `Vec`'s items, a map's values):
  /// it inherits only inlining, as utoipa's element schemas do.
  pub fn element(&self) -> Site {
    Site {
      inline: self.inline,
      ..Site::default()
    }
  }

  fn is_nullable(&self) -> bool {
    self.nullable == Some(true)
  }

  /// The schema of a type named `name` (or unnamed) at this site.
  pub fn apply(
    &self,
    name: Option<Cow<'static, str>>,
    schema: impl FnOnce() -> RefOr<Schema>,
  ) -> RefOr<Schema> {
    match name {
      Some(name) if !self.inline => self.reference(&name),
      Some(_) => self.wrap(schema()),
      None => self.decorate(schema()),
    }
  }

  /// A `$ref` carrying the description; nullability and a default need a
  /// `oneOf` around it, since a `$ref` has no `type` of its own.
  fn reference(&self, name: &str) -> RefOr<Schema> {
    let reference = Ref {
      description: self.description.clone().unwrap_or_default(),
      ..Ref::schema(name)
    };
    if !self.is_nullable() && self.default.is_none() {
      return RefOr::Ref(reference);
    }
    let mut items = Vec::new();
    if self.is_nullable() {
      items.push(null_schema());
    }
    items.push(RefOr::Ref(reference));
    RefOr::T(Schema::OneOf(OneOf {
      default: self.default.clone(),
      ..OneOf::new(items)
    }))
  }

  /// A named type written in place keeps its own definition intact and
  /// takes the site's modifiers on a `oneOf` around it.
  fn wrap(&self, schema: RefOr<Schema>) -> RefOr<Schema> {
    if !self.is_nullable() && self.default.is_none() && self.description.is_none() {
      return schema;
    }
    let mut items = Vec::new();
    if self.is_nullable() {
      items.push(null_schema());
    }
    items.push(schema);
    RefOr::T(Schema::OneOf(OneOf {
      description: self.description.clone(),
      default: self.default.clone(),
      ..OneOf::new(items)
    }))
  }

  /// An unnamed type's schema is the site's own, so the modifiers go on it.
  pub fn decorate(&self, schema: RefOr<Schema>) -> RefOr<Schema> {
    match schema {
      RefOr::T(Schema::Object(mut object)) => {
        if self.is_nullable() {
          object.schema_type = object.schema_type.nullable();
        }
        if self.description.is_some() {
          object.description = self.description.clone();
        }
        if self.deprecated {
          object.deprecated = Some(true);
        }
        if self.default.is_some() {
          object.default = self.default.clone();
        }
        RefOr::T(Schema::Object(object))
      }
      RefOr::T(Schema::Array(mut array)) => {
        if self.is_nullable() {
          array.schema_type = array.schema_type.nullable();
        }
        if self.description.is_some() {
          array.description = self.description.clone();
        }
        if self.deprecated {
          array.deprecated = Some(true);
        }
        if self.default.is_some() {
          array.default = self.default.clone();
        }
        RefOr::T(Schema::Array(array))
      }
      other => other,
    }
  }
}

fn null_schema() -> RefOr<Schema> {
  RefOr::T(Schema::Object(Object::with_type(Type::Null)))
}
