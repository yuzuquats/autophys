use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Deserializer};
use tento_openapi::ToSchema;

pub trait UserContent {
  fn is_valid() -> bool;
}

#[derive(Debug)]
pub struct Valid;

impl UserContent for Valid {
  fn is_valid() -> bool {
    true
  }
}

#[derive(Debug, ToSchema, Deserialize)]
pub struct PendingValidation;

#[derive(Debug)]
pub struct Invalid;

impl UserContent for Invalid {
  fn is_valid() -> bool {
    false
  }
}

#[derive(Debug)]
pub struct DebugWrapper<T>(pub T);

impl<'de, T> Deserialize<'de> for DebugWrapper<T>
where
  T: Deserialize<'de>,
{
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    let mut track = serde_path_to_error::Track::new();
    let d = serde_path_to_error::Deserializer::new(deserializer, &mut track);
    let value = T::deserialize(d).map_err(|e| {
      let path = track.path().to_string();
      let msg = format!("Deserialization error at '{}': {}", path, e);
      serde::de::Error::custom(msg)
    })?;
    Ok(DebugWrapper(value))
  }
}

pub fn timestamp_to_datetime<'de, D>(deserializer: D) -> Result<DateTime<Utc>, D::Error>
where
  D: Deserializer<'de>,
{
  let timestamp_s: i64 = Deserialize::deserialize(deserializer)?;
  Ok(
    Utc
      .timestamp_millis_opt(timestamp_s * 1000)
      .earliest()
      .expect(""),
  )
}

pub fn timestamp_to_datetime_opt<'de, D>(deserializer: D) -> Result<Option<DateTime<Utc>>, D::Error>
where
  D: Deserializer<'de>,
{
  let timestamp_s: Option<i64> = Deserialize::deserialize(deserializer)?;
  Ok(timestamp_s.map(|timestamp_s| {
    Utc
      .timestamp_millis_opt(timestamp_s * 1000)
      .earliest()
      .expect("")
  }))
}
