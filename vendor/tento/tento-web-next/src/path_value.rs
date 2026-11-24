use serde::de::{
  Deserializer, IntoDeserializer, Visitor,
  value::{Error, StrDeserializer},
};
use serde::forward_to_deserialize_any;

#[derive(Clone, Copy)]
pub(crate) struct PathValue<'a>(pub &'a str);

impl<'de> IntoDeserializer<'de, Error> for PathValue<'de> {
  type Deserializer = Self;

  fn into_deserializer(self) -> Self::Deserializer {
    self
  }
}

macro_rules! parse_value {
  ($method:ident, $visit:ident, $ty:ty) => {
    fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
      let value = self
        .0
        .parse::<$ty>()
        .map_err(<Error as serde::de::Error>::custom)?;
      visitor.$visit(value)
    }
  };
}

impl<'de> Deserializer<'de> for PathValue<'de> {
  type Error = Error;

  fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
    visitor.visit_borrowed_str(self.0)
  }

  parse_value!(deserialize_bool, visit_bool, bool);
  parse_value!(deserialize_i8, visit_i8, i8);
  parse_value!(deserialize_i16, visit_i16, i16);
  parse_value!(deserialize_i32, visit_i32, i32);
  parse_value!(deserialize_i64, visit_i64, i64);
  parse_value!(deserialize_i128, visit_i128, i128);
  parse_value!(deserialize_u8, visit_u8, u8);
  parse_value!(deserialize_u16, visit_u16, u16);
  parse_value!(deserialize_u32, visit_u32, u32);
  parse_value!(deserialize_u64, visit_u64, u64);
  parse_value!(deserialize_u128, visit_u128, u128);
  parse_value!(deserialize_f32, visit_f32, f32);
  parse_value!(deserialize_f64, visit_f64, f64);
  parse_value!(deserialize_char, visit_char, char);

  fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
    visitor.visit_some(self)
  }

  fn deserialize_newtype_struct<V: Visitor<'de>>(
    self,
    _: &'static str,
    visitor: V,
  ) -> Result<V::Value, Error> {
    visitor.visit_newtype_struct(self)
  }

  fn deserialize_enum<V: Visitor<'de>>(
    self,
    name: &'static str,
    variants: &'static [&'static str],
    visitor: V,
  ) -> Result<V::Value, Error> {
    StrDeserializer::<Error>::new(self.0).deserialize_enum(name, variants, visitor)
  }

  forward_to_deserialize_any! {
    str string bytes byte_buf unit unit_struct seq tuple tuple_struct map struct identifier
    ignored_any
  }
}
