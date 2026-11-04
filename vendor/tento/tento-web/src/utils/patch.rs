use serde::{Deserialize, Deserializer};

// https://stackoverflow.com/questions/44331037/how-can-i-distinguish-between-a-deserialized-field-that-is-missing-and-one-that
#[derive(Debug, PartialEq, Clone)]
pub enum Patch<T> {
  Missing,
  Null,
  Value(T),
}

impl<T> Patch<T> {
  pub fn is_some(&self) -> bool {
    match self {
      Self::Value(_) => true,
      _ => false,
    }
  }

  pub fn is_missing(&self) -> bool {
    match self {
      Self::Missing => true,
      _ => false,
    }
  }

  pub fn option_take(self) -> Option<T> {
    self.into()
  }

  pub fn option(&self) -> Option<&T> {
    match self {
      Self::Value(v) => Some(v),
      _ => None,
    }
  }
}

impl<T> Default for Patch<T> {
  fn default() -> Self {
    Patch::Missing
  }
}

impl<T> Into<Option<T>> for Patch<T> {
  fn into(self) -> Option<T> {
    match self {
      Self::Value(v) => Some(v),
      _ => None,
    }
  }
}

impl<T> From<Option<T>> for Patch<T> {
  fn from(opt: Option<T>) -> Patch<T> {
    match opt {
      Some(v) => Patch::Value(v),
      None => Patch::Null,
    }
  }
}

impl<'de, T> serde::Deserialize<'de> for Patch<T>
where
  T: serde::Deserialize<'de>,
{
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    Option::deserialize(deserializer).map(Into::into)
  }
}

pub fn deserialize_optional_field<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
  D: Deserializer<'de>,
  T: Deserialize<'de>,
{
  Ok(Some(Option::deserialize(deserializer)?))
}
