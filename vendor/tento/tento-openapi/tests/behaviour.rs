//! What tento-openapi does that utoipa does not, or that the parity corpus
//! cannot show because utoipa would need a different input.

use serde_json::json;
use tento_openapi::{RefOr, Schema, ToSchema, components_of};

/// No `no_recursion` marker: `register` inserts a component before visiting
/// its references.
#[derive(ToSchema)]
pub struct Node {
  pub next: Option<Box<Node>>,
  pub children: Vec<Node>,
}

#[test]
fn recursive_types_terminate_without_a_marker() {
  let components = components_of::<Node>();
  assert_eq!(components.schemas.len(), 1);
  let node = serde_json::to_value(&components.schemas["Node"]).unwrap();
  assert_eq!(
    node["properties"]["next"],
    json!({"oneOf": [{"type": "null"}, {"$ref": "#/components/schemas/Node"}]})
  );
}

fn rfc3339() -> Schema {
  Schema::Object(tento_openapi::Object {
    format: Some(tento_openapi::SchemaFormat::KnownFormat(
      tento_openapi::KnownFormat::DateTime,
    )),
    ..tento_openapi::Object::with_type(tento_openapi::Type::String)
  })
}

/// `schema_with` takes a function returning tento's model.
#[derive(ToSchema)]
pub struct WithFn {
  #[schema(schema_with = rfc3339)]
  pub at: String,
}

#[test]
fn schema_with_uses_the_function() {
  let schema = serde_json::to_value(WithFn::schema()).unwrap();
  assert_eq!(
    schema["properties"]["at"],
    json!({"type": "string", "format": "date-time"})
  );
  assert_eq!(schema["required"], json!(["at"]));
}

/// The case `tento-writer-js/src/openipa/mod.rs` gave up on: utoipa cannot
/// read back an untyped `{}` property, so a JSON round trip failed.
#[test]
fn an_untyped_property_survives_a_json_round_trip() {
  let document = json!({
    "type": "object",
    "properties": {
      "attributes": {},
      "body": {"$ref": "#/components/schemas/Request"}
    }
  });
  let schema: RefOr<Schema> = serde_json::from_value(document.clone()).unwrap();
  let RefOr::T(Schema::Object(object)) = &schema else {
    panic!("an object schema");
  };
  assert!(matches!(
    object.properties["attributes"],
    RefOr::T(Schema::Object(ref any)) if any.schema_type.is_any_value()
  ));
  assert!(matches!(object.properties["body"], RefOr::Ref(_)));
  assert_eq!(serde_json::to_value(&schema).unwrap(), document);
}

mod one {
  #[derive(tento_openapi::ToSchema)]
  #[schema(as = Same)]
  pub struct A {
    pub a: String,
  }
}

mod two {
  #[derive(tento_openapi::ToSchema)]
  #[schema(as = Same)]
  pub struct B {
    pub b: u8,
  }
}

#[derive(ToSchema)]
pub struct BothSames {
  pub one: one::A,
  pub two: two::B,
}

/// utoipa keeps whichever `Same` it collects last; tento refuses.
#[test]
#[should_panic(expected = "two different schemas are named `Same`")]
fn two_schemas_under_one_name_panic() {
  components_of::<BothSames>();
}

/// The Phase 1 bridge reads utoipa's JSON: keys the model does not name are
/// kept in `extra` and written back, at every depth.
#[test]
fn keys_the_model_does_not_name_survive_the_bridge() {
  // Frozen serialization of the legacy ObjectBuilder used before removal.
  let utoipa_json = json!({"type":"string", "format":"RowId", "pattern":"^r_",
    "maxLength":34, "minLength":3, "readOnly":true, "examples":["r_0123"]});
  let schema: Schema = serde_json::from_value(utoipa_json.clone()).unwrap();
  let Schema::Object(object) = &schema else {
    panic!("an object schema");
  };
  assert_eq!(
    object.format,
    Some(tento_openapi::SchemaFormat::Custom("RowId".into()))
  );
  assert!(object.extra.contains_key("pattern") && object.extra.contains_key("readOnly"));
  assert_eq!(serde_json::to_value(&schema).unwrap(), utoipa_json);

  let document = json!({
    "oneOf": [
      {"type": "null"},
      {"$ref": "#/components/schemas/Leaf", "x-origin": "lona"}
    ],
    "x-tento": {"kept": true},
    "properties-ignored": 1
  });
  let schema: RefOr<Schema> = serde_json::from_value(document.clone()).unwrap();
  assert_eq!(serde_json::to_value(&schema).unwrap(), document);

  let document = json!({
    "type": "object",
    "nullable": true,
    "properties": {
      "kind": {"const": "a", "type": "string"},
      "list": {"type": "array", "items": {"type": "integer", "example": 3}, "x-list": 1}
    }
  });
  let schema: RefOr<Schema> = serde_json::from_value(document.clone()).unwrap();
  assert_eq!(serde_json::to_value(&schema).unwrap(), document);
}

/// A known format's name reads back as the known format, whichever way
/// utoipa wrote it; `RowId` stays custom.
#[test]
fn formats_read_back_as_known_formats() {
  use tento_openapi::{KnownFormat, SchemaFormat};
  let read = |format: &str| -> SchemaFormat { serde_json::from_value(json!(format)).unwrap() };
  assert_eq!(
    read("date-time"),
    SchemaFormat::KnownFormat(KnownFormat::DateTime)
  );
  assert_eq!(
    read("u-int64"),
    SchemaFormat::KnownFormat(KnownFormat::UInt64)
  );
  assert_eq!(read("uuid"), SchemaFormat::KnownFormat(KnownFormat::Uuid));
  assert_eq!(read("RowId"), SchemaFormat::Custom("RowId".into()));
}

static TICKS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// A container default that differs on every call.
#[derive(ToSchema, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Ticking {
  pub tick: u32,
}

impl Default for Ticking {
  fn default() -> Self {
    Ticking {
      tick: TICKS.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
    }
  }
}

#[derive(ToSchema)]
pub struct UsesTickingTwice {
  pub one: Ticking,
  pub many: Vec<Ticking>,
}

/// The duplicate-name check ignores `default`, so a non-deterministic
/// `Default` registered twice is one component, not a panic.
#[test]
fn a_changing_default_is_not_a_second_schema() {
  let components = components_of::<UsesTickingTwice>();
  assert!(components.schemas.contains_key("Ticking"));
}

/// `extra` may not hold a key the model names, nor one that changes what
/// the JSON reads back as; serializing such a value fails.
#[test]
fn extra_cannot_shadow_a_modelled_key() {
  use std::collections::BTreeMap;
  use tento_openapi::{Components, Object, OneOf, Ref, Type};
  let extra = |key: &str, value: serde_json::Value| BTreeMap::from([(key.to_owned(), value)]);
  let shadowed = Schema::Object(Object {
    extra: extra("type", json!("integer")),
    ..Object::with_type(Type::String)
  });
  let error = serde_json::to_string(&shadowed).unwrap_err().to_string();
  assert!(error.contains("holds `type`"), "{error}");
  let selector = Schema::OneOf(OneOf {
    extra: extra("allOf", json!([])),
    ..OneOf::new(vec![])
  });
  assert!(serde_json::to_value(&selector).is_err());
  let reference: RefOr<Schema> = RefOr::Ref(Ref {
    extra: extra("description", json!("twice")),
    ..Ref::schema("Leaf")
  });
  assert!(serde_json::to_value(&reference).is_err());
  let components = Components {
    extra: extra("schemas", json!({})),
    ..Components::default()
  };
  assert!(serde_json::to_value(&components).is_err());
  let fine = Schema::Object(Object {
    extra: extra("x-origin", json!("lona")),
    ..Object::with_type(Type::String)
  });
  assert_eq!(
    serde_json::to_value(&fine).unwrap(),
    json!({"type": "string", "x-origin": "lona"})
  );
}
