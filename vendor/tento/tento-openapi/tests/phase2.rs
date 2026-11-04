//! Same-input parity for the Phase 2 schema and parameter surface.
#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
struct Child {
  value: String,
}
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
struct Clock {
  timestamp: chrono::DateTime<chrono::Utc>,
  optional: Option<chrono::DateTime<chrono::Utc>>,
}
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
struct Generic<T> {
  value: T,
}
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
struct GenericRoot {
  marker: Marker<Unit>,
  named: Generic<Child>,
  number: Generic<i32>,
  nested: Generic<Vec<Child>>,
}
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
struct Marker<T> {
  value: String,
  #[serde(skip)]
  marker: std::marker::PhantomData<T>,
}
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
/// Homogeneous pair.
struct Pair(i32, i32);
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
/// Heterogeneous pair.
struct Mixed(i32, String);
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
enum Tuples {
  Pair(i32, i32),
  Mixed(i32, String),
  Unit,
}
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(untagged)]
enum Untagged {
  Pair(i32, i32),
  Mixed(i32, String),
}
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(tag = "kind", content = "data")]
enum Adjacent {
  Pair(Pair),
  Mixed(Mixed),
  Unit,
}

fn baseline(name: &str) -> Value {
  let values: BTreeMap<String, Value> =
    serde_json::from_str(include_str!("fixtures/utoipa55-phase2.json")).unwrap();
  values[name].clone()
}
fn schemas<T: tento_openapi::ToSchema>() {
  assert_eq!(
    baseline(&format!("schema-{}", std::any::type_name::<T>())),
    serde_json::to_value(tento_openapi::components_of::<T>().schemas).unwrap()
  );
}
#[test]
fn generic_and_tuple_components_match() {
  schemas::<Unit>();
  schemas::<VirtualDefaults>();
  schemas::<Clock>();
  schemas::<Generic<Child>>();
  schemas::<Marker<Unit>>();
  schemas::<GenericRoot>();
  schemas::<Pair>();
  schemas::<Mixed>();
  schemas::<Tuples>();
  schemas::<Untagged>();
  schemas::<Adjacent>();
}

#[derive(Deserialize, tento_openapi::IntoParams)]
#[into_params(parameter_in = Query)]
#[serde(rename_all = "camelCase")]
struct Query {
  /// A query value.
  some_value: String,
  optional: Option<u64>,
  #[param(nullable)]
  nullable: Option<String>,
  #[serde(default)]
  defaulted: u32,
  #[serde(skip)]
  hidden: String,
}
#[derive(Deserialize, tento_openapi::IntoParams)]
struct Inferred {
  optional: Option<String>,
  required: i32,
}
#[derive(Deserialize, tento_openapi::IntoParams)]
#[into_params(names("id", "revision"), parameter_in = Path)]
struct TupleParams(String, Option<u32>);
fn params<T: tento_openapi::IntoParams>() {
  for location in [
    tento_openapi::ParameterIn::Query,
    tento_openapi::ParameterIn::Path,
  ] {
    assert_eq!(
      baseline(&format!(
        "params-{}-{:?}",
        std::any::type_name::<T>(),
        location
      )),
      serde_json::to_value(T::into_params(|| Some(location))).unwrap()
    );
  }
}
#[test]
fn parameter_locations_and_option_quirks_match() {
  params::<Query>();
  params::<Inferred>();
  params::<TupleParams>();
}

mod new_route {

  use super::*;
  /// Find a child.
  /// Wrapped summary.
  ///
  /// More detail on two lines.
  /// The second line.
  #[tento_openapi::path(get, path = "/child/{id}", request_body = Option<Child>,
    params(("id" = String, Path, description = "identifier"), ("page" = Option<u32>, Query), Query),
    responses((status = 200, body = Child), (status = 404, description = "Missing")))]
  fn route() {}
  #[tento_openapi::path(post, path = "/text", responses((status = 200, body = String), (status = "default")))]
  fn text() {}
  #[tento_openapi::path(post, path = "/marker", request_body = Marker<Unit>, responses((status = 200)))]
  fn marker() {}
}

#[test]
fn operation_hooks_match() {
  assert_eq!(
    baseline("operation-route"),
    serde_json::to_value(new_route::__path_route::operation()).unwrap()
  );
  assert_eq!(
    baseline("operation-text"),
    serde_json::to_value(new_route::__path_text::operation()).unwrap()
  );
  let mut schemas = tento_openapi::Components::default();
  new_route::__path_route::schemas(&mut schemas);
  assert_eq!(
    baseline("operation-components"),
    serde_json::to_value(schemas.schemas).unwrap()
  );
  let mut schemas = tento_openapi::Components::default();
  new_route::__path_marker::schemas(&mut schemas);
  assert_eq!(
    baseline("marker-operation-components"),
    serde_json::to_value(schemas.schemas).unwrap()
  );
}

#[derive(tento_openapi::OpenApi)]
#[openapi(
  components(schemas(Child, Pair)),
  paths(new_route::route, new_route::text)
)]
struct NewDoc;
#[test]
fn complete_native_document_matches() {
  assert_eq!(
    baseline("document"),
    serde_json::to_value(NewDoc::openapi()).unwrap()
  );
}

#[test]
fn composition_collision_rules_match() {
  use serde_json::json;
  let a = json!({"openapi":"3.1.0","info":{"title":"A","version":"1"},
    "paths":{"/same":{"summary":"first","get":{"operationId":"first","responses":{}}}},
    "components":{"schemas":{"Name":{"type":"string"}},"securitySchemes":{"auth":{"type":"http","scheme":"bearer"}}},
    "tags":[{"name":"a"}],"servers":[{"url":"http://one"}]});
  let b = json!({"openapi":"3.1.0","info":{"title":"B","version":"2"},
    "paths":{"/same":{"summary":"second","get":{"operationId":"second","responses":{}},"post":{"responses":{}}}},
    "components":{"schemas":{"Name":{"type":"integer"},"Other":{"type":"boolean"}}},
    "tags":[{"name":"a"},{"name":"b"}],"servers":[{"url":"http://two"}]});
  let a: tento_openapi::OpenApi = serde_json::from_value(a).unwrap();
  let b: tento_openapi::OpenApi = serde_json::from_value(b).unwrap();
  assert_eq!(
    baseline("merge"),
    serde_json::to_value(a.clone().merge_from(b.clone())).unwrap()
  );
  assert_eq!(
    baseline("nest"),
    serde_json::to_value(a.nest("", b)).unwrap()
  );
}

#[derive(tento_openapi::ToSchema)]
/// Validation marker.
struct Unit;

#[derive(Default, Serialize, tento_openapi::ToSchema)]
#[serde(default)]
struct VirtualDefaults {
  #[schema(value_type = Object)]
  value: serde_json::Value,
  #[schema(value_type = Option<Object>)]
  optional: Option<serde_json::Value>,
  any: serde_json::Value,
}

mod web {
  pub struct Json<T>(pub T);
  pub struct Query<T>(pub T);
  pub struct Path<T>(pub T);
  pub struct Form<T>(pub T);
}
mod new_inference {
  use super::*;
  #[tento_openapi::path(post, path = "/child", responses((status = 200)))]
  fn json(_body: web::Json<Child>) {}
  #[tento_openapi::path(post, path = "/form", responses((status = 200)))]
  fn form(_body: web::Form<Child>) {}
  #[tento_openapi::path(post, path = "/optional", responses((status = 200)))]
  fn optional(_body: web::Json<Vec<Option<Child>>>) {}
  #[tento_openapi::path(get, path = "/query", params(Inferred), responses((status = 200)))]
  fn query(_query: web::Query<Inferred>) {}
  #[tento_openapi::path(get, path = "/{id}/{revision}", params(("id", Path)), responses((status = 200)))]
  fn path(_path: web::Path<(String, u32)>) {}
}
#[test]
fn actix_extractor_inference_matches() {
  macro_rules! compare {
    ($hook:ident) => {
      assert_eq!(
        baseline(concat!("inference-", stringify!($hook))),
        serde_json::to_value(new_inference::$hook::operation()).unwrap()
      );
    };
  }
  compare!(__path_json);
  compare!(__path_form);
  compare!(__path_optional);
  compare!(__path_query);
  compare!(__path_path);
}

// Wire spellings captured from utoipa 5.5's ParameterStyle serialization.
#[test]
fn parameter_styles_match_legacy_wire_spellings() {
  macro_rules! check {
    ($style:ident, $wire:literal) => {{
      #[derive(tento_openapi::IntoParams)]
      #[into_params(parameter_in = Query, style = $style)]
      struct Styled {
        value: String,
      }
      let actual = <Styled as tento_openapi::IntoParams>::into_params(|| None);
      assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::json!([{
          "name": "value", "in": "query", "required": true,
          "style": $wire, "schema": {"type": "string"}
        }]),
      );
    }};
  }
  check!(Matrix, "matrix");
  check!(Label, "label");
  check!(Form, "form");
  check!(Simple, "simple");
  check!(SpaceDelimited, "spaceDelimited");
  check!(PipeDelimited, "pipeDelimited");
  check!(DeepObject, "deepObject");
}
