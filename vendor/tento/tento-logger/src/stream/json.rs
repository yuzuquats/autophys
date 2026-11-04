//! Decode the writer's tag-first records without buffering the payload twice.
use std::{borrow::Cow, fmt};

use serde::de::{self, DeserializeSeed, MapAccess, Visitor, value};
use serde::{Deserialize, Deserializer};

use super::{CloseOp, EventOp, FieldOp, OpenOp, TraceOp};

impl TraceOp {
  /// Parse a trace record. Writer-produced records put `op` first, allowing
  /// direct payload deserialization. Reordered or unfamiliar records use the
  /// ordinary derived parser, which remains the wire-format authority.
  pub fn from_json(source: &str) -> Result<Self, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_str(source);
    let fast = deserializer.deserialize_map(LeadingOp).and_then(|op| {
      deserializer.end()?;
      Ok(op)
    });
    fast.or_else(|_| serde_json::from_str(source))
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Tag {
  Open,
  Field,
  Event,
  Close,
}

#[derive(Deserialize)]
struct Key<'a>(#[serde(borrow)] Cow<'a, str>);

struct LeadingOp;

impl<'de> Visitor<'de> for LeadingOp {
  type Value = TraceOp;

  fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
    f.write_str("a trace record with op first")
  }

  fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<TraceOp, M::Error> {
    if map
      .next_key::<Key<'de>>()?
      .as_ref()
      .map(|key| key.0.as_ref())
      != Some("op")
    {
      return Err(de::Error::custom("op is not first"));
    }
    let tag = map.next_value::<Tag>()?;
    let fields: &[&str] = match tag {
      Tag::Open => &[
        "seq",
        "id",
        "parent",
        "sessionId",
        "ts",
        "name",
        "level",
        "loc",
        "fields",
      ],
      Tag::Field => &["seq", "id", "sessionId", "ts", "fields"],
      Tag::Event => &["seq", "parent", "sessionId", "ts", "level", "loc", "fields"],
      Tag::Close => &["seq", "id", "sessionId", "ts", "elapsedMs"],
    };
    let rest = value::MapAccessDeserializer::new(Payload {
      map,
      fields,
      location: false,
    });
    match tag {
      Tag::Open => OpenOp::deserialize(rest).map(TraceOp::Open),
      Tag::Field => FieldOp::deserialize(rest).map(TraceOp::Field),
      Tag::Event => EventOp::deserialize(rest).map(TraceOp::Event),
      Tag::Close => CloseOp::deserialize(rest).map(TraceOp::Close),
    }
  }
}

struct Payload<'a, M> {
  map: M,
  fields: &'a [&'a str],
  location: bool,
}

impl<'de, M: MapAccess<'de>> MapAccess<'de> for Payload<'_, M> {
  type Error = M::Error;

  fn next_key_seed<K: DeserializeSeed<'de>>(
    &mut self,
    seed: K,
  ) -> Result<Option<K::Value>, M::Error> {
    let Some(Key(key)) = self.map.next_key::<Key<'de>>()? else {
      return Ok(None);
    };
    // Includes duplicate (even escaped) op keys. Unknown fields fall back so
    // IgnoredAny cannot accept numbers the buffered parser would reject.
    if !self.fields.contains(&key.as_ref()) {
      return Err(de::Error::custom("unfamiliar trace key"));
    }
    self.location = key == "loc";
    match key {
      Cow::Borrowed(key) => seed
        .deserialize(value::BorrowedStrDeserializer::new(key))
        .map(Some),
      Cow::Owned(key) => seed
        .deserialize(value::StringDeserializer::new(key))
        .map(Some),
    }
  }

  fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, M::Error> {
    if self.location {
      // Location has ignorable extension fields too. Buffer this tiny map,
      // retaining duplicate keys and validating every value as before. The
      // potentially large `fields` payload is still decoded directly.
      let Location(entries) = self.map.next_value::<Location>()?;
      seed
        .deserialize(value::MapDeserializer::new(entries.into_iter()))
        .map_err(de::Error::custom)
    } else {
      self.map.next_value_seed(seed)
    }
  }
}

struct Location(Vec<(String, serde_json::Value)>);

impl<'de> Deserialize<'de> for Location {
  fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    struct Fields;
    impl<'de> Visitor<'de> for Fields {
      type Value = Location;
      fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a location map")
      }
      fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Location, M::Error> {
        let mut entries = Vec::new();
        while let Some(entry) = map.next_entry()? {
          entries.push(entry);
        }
        Ok(Location(entries))
      }
    }
    deserializer.deserialize_map(Fields)
  }
}
