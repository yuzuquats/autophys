//! OpenAPI document data read by the writers. Unknown members (including
//! tags, servers, security, callbacks, examples and extensions) live in extra.
//! Route-producing macros remain separate; there are no builders.

use crate::{Components, RefOr, Schema};
use indexmap::IndexMap;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

// Check extra before serializing: duplicate keys must not override typed fields.
macro_rules! document_object {
  ($name:ident { $( $(#[$attr:meta])* $field:ident: $ty:ty => $key:literal, )* }) => {
    #[derive(Clone, Debug, Default, PartialEq)]
    pub struct $name {
      $( pub $field: $ty, )*
      pub extra: BTreeMap<String, Value>,
      /// Members present on input: preserves explicit empty maps and nulls.
      /// Producers constructing a document can leave this at its default.
      #[doc(hidden)]
      pub present: BTreeSet<String>,
    }
    impl<'de> Deserialize<'de> for $name {
      fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Fields {
          $( $(#[$attr])* #[serde(rename = $key)] $field: $ty, )*
          #[serde(flatten, default)] extra: BTreeMap<String, Value>,
        }
        let json = Value::deserialize(deserializer)?;
        let present = json.as_object().ok_or_else(|| D::Error::custom("expected OpenAPI object"))?
          .keys().filter(|key| [$($key,)*].contains(&key.as_str())).cloned().collect();
        let fields: Fields = serde_json::from_value(json).map_err(D::Error::custom)?;
        Ok(Self { $( $field: fields.$field, )* extra: fields.extra, present })
      }
    }
    impl Serialize for $name {
      fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let Some(key) = self.extra.keys().find(|key| [$($key,)*].contains(&key.as_str())) {
          return Err(serde::ser::Error::custom(format!(
            "tento-openapi: extra of {} holds modelled key {key}", stringify!($name)
          )));
        }
        #[derive(Serialize)]
        struct Fields<'a> {
          $( $(#[$attr])* #[serde(rename = $key)] $field: &'a $ty, )*
          #[serde(flatten)] extra: &'a BTreeMap<String, Value>,
        }
        let mut json = serde_json::to_value(Fields { $( $field: &self.$field, )* extra: &self.extra })
          .map_err(serde::ser::Error::custom)?;
        $(
          if self.present.contains($key) && json.get($key).is_none() {
            json[$key] = serde_json::to_value(&self.$field).map_err(serde::ser::Error::custom)?;
          }
        )*
        json.serialize(serializer)
      }
    }
  };
}

document_object! {
  OpenApi {
    openapi: String => "openapi",
    info: Info => "info",
    paths: Paths => "paths",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    components: Option<Components> => "components",
  }
}

document_object! {
  Info {
    title: String => "title",
    version: String => "version",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String> => "description",
  }
}

document_object! {
  PathItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String> => "summary",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String> => "description",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parameters: Option<Vec<Parameter>> => "parameters",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    get: Option<Operation> => "get",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    put: Option<Operation> => "put",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    post: Option<Operation> => "post",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delete: Option<Operation> => "delete",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    options: Option<Operation> => "options",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    head: Option<Operation> => "head",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    patch: Option<Operation> => "patch",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trace: Option<Operation> => "trace",
  }
}

document_object! {
  Operation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String> => "summary",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String> => "description",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation_id: Option<String> => "operationId",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parameters: Option<Vec<Parameter>> => "parameters",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_body: Option<RequestBody> => "requestBody",
    responses: Responses => "responses",
  }
}

document_object! {
  Parameter {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    name: String => "name",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parameter_in: Option<ParameterIn> => "in",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    required: Option<Required> => "required",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String> => "description",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    schema: Option<RefOr<Schema>> => "schema",
  }
}

document_object! {
  RequestBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String> => "description",
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    content: BTreeMap<String, Content> => "content",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    required: Option<Required> => "required",
  }
}

document_object! {
  Response {
    description: String => "description",
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    headers: BTreeMap<String, Header> => "headers",
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    content: IndexMap<String, Content> => "content",
  }
}

document_object! {
  Content {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    schema: Option<RefOr<Schema>> => "schema",
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    encoding: BTreeMap<String, Encoding> => "encoding",
  }
}

document_object! {
  Encoding {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    headers: BTreeMap<String, Header> => "headers",
  }
}

document_object! {
  Header {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    schema: Option<RefOr<Schema>> => "schema",
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String> => "description",
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HttpMethod {
  Get,
  Put,
  Post,
  Delete,
  Options,
  Head,
  Patch,
  Trace,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParameterIn {
  Query,
  Path,
  Header,
  Cookie,
}

/// OpenAPI boolean, named to keep producer code explicit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Required {
  True,
  #[default]
  False,
}
impl Serialize for Required {
  fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_bool(*self == Self::True)
  }
}
impl<'de> Deserialize<'de> for Required {
  fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
    bool::deserialize(d).map(|b| if b { Self::True } else { Self::False })
  }
}

// Using serde(flatten) twice would interpret extensions as paths/responses.
// Partition dynamic keys explicitly instead.
macro_rules! document_map {
  ($name:ident, $field:ident, $ty:ty, $is_key:expr) => {
    #[derive(Clone, Debug, Default, PartialEq)]
    pub struct $name {
      pub $field: BTreeMap<String, $ty>,
      pub extra: BTreeMap<String, Value>,
    }
    impl Serialize for $name {
      fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = s.serialize_map(Some(self.$field.len() + self.extra.len()))?;
        for (key, value) in &self.$field {
          if !($is_key)(key) {
            return Err(serde::ser::Error::custom("invalid document map key"));
          }
          map.serialize_entry(key, value)?;
        }
        for (key, value) in &self.extra {
          if ($is_key)(key) {
            return Err(serde::ser::Error::custom(
              "modelled document map key in extra",
            ));
          }
          map.serialize_entry(key, value)?;
        }
        map.end()
      }
    }
    impl<'de> Deserialize<'de> for $name {
      fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let mut result = Self::default();
        for (key, value) in BTreeMap::<String, Value>::deserialize(d)? {
          if ($is_key)(&key) {
            result.$field.insert(
              key,
              serde_json::from_value(value).map_err(D::Error::custom)?,
            );
          } else {
            result.extra.insert(key, value);
          }
        }
        Ok(result)
      }
    }
  };
}
document_map!(Paths, paths, PathItem, |key: &str| key.starts_with('/'));
document_map!(Responses, responses, RefOr<Response>, |key: &str| key
  == "default"
  || (key.len() == 3
    && (b'1'..=b'5').contains(&key.as_bytes()[0])
    && (key.as_bytes()[1..].iter().all(u8::is_ascii_digit)
      || &key[1..] == "XX")));

impl OpenApi {
  /// Read a complete serialized document, rejecting lossy model conversions.
  /// Used for external document imports and roundtrip validation.
  pub fn from_serializable(document: &impl Serialize) -> Result<Self, serde_json::Error> {
    let json = serde_json::to_value(document)?;
    let result: Self = serde_json::from_value(json.clone())?;
    if serde_json::to_value(&result)? != json {
      fn first_difference(a: &Value, b: &Value, path: &str) -> String {
        match (a, b) {
          (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
              if a.get(key) != b.get(key) {
                let escaped = key.replace('~', "~0").replace('/', "~1");
                let next = format!("{path}/{escaped}");
                return match (a.get(key), b.get(key)) {
                  (Some(a), Some(b)) => first_difference(a, b, &next),
                  _ => next,
                };
              }
            }
          }
          (Value::Array(a), Value::Array(b)) => {
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
              if a != b {
                return first_difference(a, b, &format!("{path}/{index}"));
              }
            }
          }
          _ => {}
        }
        path.to_owned()
      }
      return Err(serde_json::Error::custom(format!(
        "tento-openapi: document bridge changed JSON at {}",
        first_difference(&json, &serde_json::to_value(&result)?, "")
      )));
    }
    Ok(result)
  }
}

impl PathItem {
  pub fn new(method: HttpMethod, operation: Operation) -> Self {
    let mut result = Self::default();
    *result.operation_mut(method) = Some(operation);
    result
  }
  fn operation_mut(&mut self, method: HttpMethod) -> &mut Option<Operation> {
    match method {
      HttpMethod::Get => &mut self.get,
      HttpMethod::Put => &mut self.put,
      HttpMethod::Post => &mut self.post,
      HttpMethod::Delete => &mut self.delete,
      HttpMethod::Options => &mut self.options,
      HttpMethod::Head => &mut self.head,
      HttpMethod::Patch => &mut self.patch,
      HttpMethod::Trace => &mut self.trace,
    }
  }
  fn merge(&mut self, other: Self) {
    for (ours, theirs) in [
      (&mut self.get, other.get),
      (&mut self.put, other.put),
      (&mut self.post, other.post),
      (&mut self.delete, other.delete),
      (&mut self.options, other.options),
      (&mut self.head, other.head),
      (&mut self.patch, other.patch),
      (&mut self.trace, other.trace),
    ] {
      if ours.is_none() {
        *ours = theirs;
      }
    }
  }
}
impl Paths {
  /// Like utoipa's PathsBuilder: adding another method to a path keeps its
  /// existing methods and metadata.
  pub fn add(&mut self, path: impl Into<String>, item: PathItem) {
    self
      .paths
      .entry(path.into())
      .and_modify(|existing| existing.merge(item.clone()))
      .or_insert(item);
  }
}
impl OpenApi {
  /// Empty router document (utoipa's builder defaults).
  pub fn new() -> Self {
    Self {
      openapi: "3.1.0".into(),
      ..Self::default()
    }
  }

  pub fn merge_from(mut self, other: Self) -> Self {
    self.merge(other);
    self
  }

  /// Preserve the first declaration when two documents name the same schema
  /// or operation, matching the existing composition contract.
  pub fn merge(&mut self, other: Self) {
    for (path, item) in other.paths.paths {
      self.paths.add(path, item);
    }
    if let Some(theirs) = other.components {
      let ours = self.components.get_or_insert_with(Components::default);
      for (name, schema) in theirs.schemas {
        ours.schemas.entry(name).or_insert(schema);
      }
      for (name, response) in theirs.responses {
        ours.responses.entry(name).or_insert(response);
      }
      if let Some(Value::Object(theirs)) = theirs.extra.get("securitySchemes") {
        let target = ours
          .extra
          .entry("securitySchemes".into())
          .or_insert_with(|| Value::Object(Default::default()));
        if let Value::Object(ours) = target {
          for (name, value) in theirs {
            ours.entry(name).or_insert_with(|| value.clone());
          }
        }
      }
    }
    for key in ["servers", "tags", "security"] {
      if let Some(Value::Array(theirs)) = other.extra.get(key) {
        let target = self
          .extra
          .entry(key.into())
          .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(ours) = target {
          let unique: Vec<_> = theirs
            .iter()
            .filter(|value| !ours.contains(value))
            .cloned()
            .collect();
          ours.extend(unique);
        }
      }
    }
  }

  /// Nest uses verbatim prefix concatenation and replaces colliding path
  /// items, as utoipa does; remaining components are merged first-wins.
  pub fn nest(mut self, prefix: impl AsRef<str>, mut other: Self) -> Self {
    let paths = std::mem::take(&mut other.paths.paths);
    self.paths.paths.extend(
      paths
        .into_iter()
        .map(|(path, item)| (format!("{}{path}", prefix.as_ref()), item)),
    );
    self.merge(other);
    self
  }
}
