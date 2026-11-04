use serde_json::{Value, json};
use tento_openapi::{OpenApi, ParameterIn, RefOr};

fn document() -> Value {
  let operation = json!({
    "summary": "", "operationId": "read", "tags": ["items"],
    "servers": [{"url": "https://example.test", "x-server": {"v": 1}}],
    "security": [{"token": []}], "externalDocs": {"url": "https://example.test/docs"},
    "callbacks": {"event": {"{$request.body#/callback}": {"post": {"responses": {}}}}},
    "parameters": [
      {"name": "id", "in": "path", "required": true, "schema": {}, "style": "simple",
       "explode": false, "example": null, "x-parameter": [1, 2]},
      {"$ref": "#/components/parameters/shared", "x-ref": true}
    ],
    "requestBody": {
      "required": false, "description": "", "x-body": null,
      "content": {"multipart/form-data": {
        "schema": {}, "example": null, "examples": {"case": {"value": {"$ref": "literal"}}},
        "encoding": {"part": {"contentType": "application/json", "x-encoding": {},
          "headers": {"X-Header": {"schema": {}, "description": "", "required": true, "x-header": 7}}}},
        "x-content": {"retained": true}
      }}
    },
    "responses": {
      "200": {"description": "", "headers": {"X-Result": {"schema": {}}},
        "content": {"application/json": {"schema": {}, "example": null}},
        "links": {"next": {"operationId": "next", "parameters": {"id": "$response.body#/id"}}},
        "x-response": [null, false]},
      "2XX": {"$ref": "#/components/responses/Shared", "summary": "range", "x-ref": 1},
      "default": {"description": "fallback"}, "x-responses": {"retained": true}
    },
    "x-operation": {"unknown": null}
  });
  let mut item = json!({
    "summary": "", "description": "", "servers": [],
    "parameters": [], "x-path-item": {"retained": true}
  });
  for method in [
    "get", "put", "post", "delete", "options", "head", "patch", "trace",
  ] {
    item[method] = operation.clone();
  }
  json!({
    "openapi": "3.1.0",
    "info": {"title": "", "version": "1", "description": "",
      "contact": {"email": "dev@example.test"}, "license": {"name": "MIT"},
      "summary": "summary", "x-info": {"retained": true}},
    "paths": {"/items/{id}": item, "/reference": {"$ref": "other.json#/paths/item"},
      "x-paths": {"retained": true}, "futurePathMetadata": [1, 2]},
    "components": {
      "schemas": {"Any": {}, "String": {"type": "string", "pattern": ".*", "x-schema": null}},
      "responses": {"Shared": {"description": "ok", "content": {
        "application/json": {"schema": {"$ref": "#/components/schemas/Any", "x-ref": 1}}}}},
      "parameters": {"shared": {"name": "id", "in": "query", "schema": {}}},
      "securitySchemes": {"token": {"type": "http", "scheme": "bearer"}},
      "requestBodies": {"Shared": {"content": {}}}, "x-components": true
    },
    "servers": [], "tags": [{"name": "items", "x-tag": true}], "security": [],
    "externalDocs": {"url": "https://example.test"}, "jsonSchemaDialect": "https://json-schema.org/draft/2020-12/schema",
    "x-root": {"literal": {"$ref": "#/components/schemas/Any"}}
  })
}

#[test]
fn complete_document_retains_metadata_at_every_depth() {
  let json = document();
  let api = OpenApi::from_serializable(&json).unwrap();
  assert_eq!(serde_json::to_value(&api).unwrap(), json);
  let operation = api.paths.paths["/items/{id}"].get.as_ref().unwrap();
  assert_eq!(
    operation.parameters.as_ref().unwrap()[0].parameter_in,
    Some(ParameterIn::Path)
  );
  assert!(matches!(
    &operation.responses.responses["2XX"],
    RefOr::Ref(_)
  ));
  assert!(api.paths.extra.contains_key("x-paths"));
  assert!(operation.responses.extra.contains_key("x-responses"));
  let second: OpenApi = serde_json::from_slice(&serde_json::to_vec(&api).unwrap()).unwrap();
  assert_eq!(serde_json::to_value(second).unwrap(), json);
}

#[test]
fn optional_empty_and_null_members_remain_present_and_typed_edits_win() {
  let mut json = json!({
    "openapi": "3.1.0", "info": {"title": "", "version": "", "description": null},
    "components": {"schemas": {}, "responses": {}, "x-components": null},
    "paths": {"/empty": {"get": {
      "summary": null, "parameters": [], "responses": {},
      "requestBody": {"content": {}, "required": null}
    }}}
  });
  let mut api = OpenApi::from_serializable(&json).unwrap();
  api
    .paths
    .paths
    .get_mut("/empty")
    .unwrap()
    .get
    .as_mut()
    .unwrap()
    .summary = Some("changed".into());
  json["paths"]["/empty"]["get"]["summary"] = json!("changed");
  assert_eq!(serde_json::to_value(api).unwrap(), json);
}

#[test]
fn extra_cannot_override_any_named_document_field() {
  let mut api = OpenApi::from_serializable(&document()).unwrap();
  api.info.extra.insert("title".into(), json!("override"));
  assert!(serde_json::to_value(api).is_err());
  let mut api = OpenApi::from_serializable(&document()).unwrap();
  api
    .components
    .as_mut()
    .unwrap()
    .extra
    .insert("responses".into(), json!({}));
  assert!(serde_json::to_value(api).is_err());
  let mut api = OpenApi::from_serializable(&document()).unwrap();
  api.paths.extra.insert("/shadow".into(), json!({}));
  assert!(serde_json::to_value(api).is_err());
  let mut api = OpenApi::from_serializable(&document()).unwrap();
  api
    .paths
    .paths
    .get_mut("/items/{id}")
    .unwrap()
    .get
    .as_mut()
    .unwrap()
    .responses
    .extra
    .insert("200".into(), json!({}));
  assert!(serde_json::to_value(api).is_err());
}

// Exercise each typed schema family inside a whole document: the bridge's
// equality assertion must stay enabled, including explicit null and empties.
fn schema_document(schema: Value) -> Value {
  json!({"openapi":"3.1.0", "info":{"title":"","version":""},
    "paths":{}, "components":{"schemas":{"Test":schema}}})
}

#[test]
fn known_schema_members_preserve_presence_at_every_depth() {
  let object = json!({"type": null, "title": "", "format": null,
    "description": null, "default": null, "enum": [], "required": [],
    "properties": {}, "additionalProperties": null, "propertyNames": null,
    "deprecated": null, "minimum": null, "maximum": null});
  let array = json!({"type":"array", "title":null, "items":null,
    "prefixItems":[], "description":"", "deprecated":null, "default":null,
    "maxItems":null, "minItems":null, "uniqueItems":false});
  let reference = json!({"$ref":"#/components/schemas/Leaf", "description":"", "summary":null});
  for schema in [
    object.clone(),
    array.clone(),
    reference.clone(),
    json!({"type":"array"}),
    json!({"type":"array", "items":{}}),
    json!({"properties": null, "required": null, "enum": null}),
    json!({"type":[], "required":[], "properties":{}}),
    json!({"type":"object", "properties":{"array":array,"ref":reference},
      "additionalProperties":false, "propertyNames":object}),
    json!({"type":"array", "items":false, "prefixItems":[], "uniqueItems":null}),
    json!({"minimum":9007199254740993u64, "maximum":1.0}),
  ] {
    let json = schema_document(schema);
    let api = OpenApi::from_serializable(&json).unwrap();
    assert_eq!(serde_json::to_value(api).unwrap(), json);
  }
  for key in ["oneOf", "allOf", "anyOf"] {
    for items in [
      json!([]),
      Value::Null,
      json!([object.clone(), reference.clone()]),
    ] {
      let mut schema = json!({"type":null, "title":null, "description":"", "default":null,
        "deprecated":null, "discriminator":{"propertyName":"", "mapping":{}, "x-kept":null}});
      schema[key] = items;
      let json = schema_document(schema);
      let api = OpenApi::from_serializable(&json).unwrap();
      assert_eq!(serde_json::to_value(api).unwrap(), json);
    }
  }
}

#[test]
fn edits_to_present_schema_members_and_nested_schemas_win() {
  use tento_openapi::{Object, Schema, Type};
  let mut json = schema_document(json!({"type":"object", "properties":{}, "description":null}));
  let mut api = OpenApi::from_serializable(&json).unwrap();
  let RefOr::T(Schema::Object(object)) = api
    .components
    .as_mut()
    .unwrap()
    .schemas
    .get_mut("Test")
    .unwrap()
  else {
    panic!()
  };
  object.description = Some("edited".into());
  object
    .properties
    .insert("new".into(), Object::with_type(Type::String).into());
  json["components"]["schemas"]["Test"]["description"] = json!("edited");
  json["components"]["schemas"]["Test"]["properties"]["new"] = json!({"type":"string"});
  assert_eq!(serde_json::to_value(&api).unwrap(), json);
  // Re-read, then mutate inside an originally present collection: presence
  // must not restore a stale original parent over this nested edit.
  let mut api = OpenApi::from_serializable(&json).unwrap();
  let RefOr::T(Schema::Object(object)) = api
    .components
    .as_mut()
    .unwrap()
    .schemas
    .get_mut("Test")
    .unwrap()
  else {
    panic!()
  };
  let RefOr::T(Schema::Object(child)) = object.properties.get_mut("new").unwrap() else {
    panic!()
  };
  child.title = Some("nested edit".into());
  json["components"]["schemas"]["Test"]["properties"]["new"]["title"] = json!("nested edit");
  assert_eq!(serde_json::to_value(api).unwrap(), json);
}

#[test]
fn boolean_schema_boundary_is_explicit() {
  // The Phase 0 model is object-form schemas plus boolean additionalProperties
  // and items:false. It does not implement arbitrary JSON Schema / OpenAPI 3.1
  // boolean schemas. Never silently coerce unsupported booleans to {}.
  for schema in [
    json!(true),
    json!(false),
    json!({"type":"array","items":true}),
    json!({"properties":{"child":false}}),
  ] {
    assert!(OpenApi::from_serializable(&schema_document(schema)).is_err());
  }
  for allowed in [true, false] {
    let json = schema_document(json!({"additionalProperties":allowed}));
    assert_eq!(
      serde_json::to_value(OpenApi::from_serializable(&json).unwrap()).unwrap(),
      json
    );
  }
}

#[test]
fn explicit_default_null_keeps_phase0_typed_semantics() {
  use tento_openapi::{RefOr, Schema};
  let json = schema_document(json!({"default":null}));
  let api = OpenApi::from_serializable(&json).unwrap();
  let RefOr::T(Schema::Object(object)) = &api.components.as_ref().unwrap().schemas["Test"] else {
    panic!()
  };
  assert_eq!(object.default, Some(Value::Null));
}

#[test]
fn every_optional_schema_member_accepts_explicit_null_without_loss() {
  for (template, keys) in [
    (
      json!({}),
      vec![
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
      ],
    ),
    (
      json!({"type":"array"}),
      vec![
        "title",
        "items",
        "prefixItems",
        "description",
        "deprecated",
        "default",
        "maxItems",
        "minItems",
        "uniqueItems",
      ],
    ),
    (
      json!({"$ref":"#/components/schemas/Other"}),
      vec!["summary", "description"],
    ),
  ] {
    for key in keys {
      let mut schema = template.clone();
      schema[key] = Value::Null;
      let json = schema_document(schema);
      let api = OpenApi::from_serializable(&json).unwrap();
      assert_eq!(serde_json::to_value(api).unwrap(), json, "{key}");
    }
  }
  for composition in ["oneOf", "anyOf", "allOf"] {
    for key in [
      composition,
      "type",
      "title",
      "description",
      "default",
      "discriminator",
      "deprecated",
    ] {
      let mut schema = json!({});
      schema[composition] = json!([]);
      schema[key] = Value::Null;
      let json = schema_document(schema);
      assert_eq!(
        serde_json::to_value(OpenApi::from_serializable(&json).unwrap()).unwrap(),
        json
      );
    }
    for key in ["propertyName", "mapping"] {
      let mut schema = json!({"discriminator":{"propertyName":"", "mapping":{}}});
      schema[composition] = json!([]);
      schema["discriminator"][key] = Value::Null;
      let json = schema_document(schema);
      assert_eq!(
        serde_json::to_value(OpenApi::from_serializable(&json).unwrap()).unwrap(),
        json
      );
    }
  }
}
