//! [`ToSchema`] for the std, chrono, uuid and serde_json types wire structs
//! use. Formats and bounds match utoipa 5 without `non_strict_integers`:
//! the narrow integers share `int32`, `u64` is `int64` with `minimum: 0`.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, LinkedList, VecDeque};
use std::rc::Rc;
use std::sync::Arc;

use crate::model::{
  AdditionalProperties, Array, KnownFormat, Object, RefOr, Schema, SchemaFormat, Type,
};
use crate::{Components, Site, ToSchema, register};

fn primitive(ty: Type, format: Option<KnownFormat>, minimum: Option<f64>) -> RefOr<Schema> {
  RefOr::T(Schema::Object(Object {
    format: format.map(SchemaFormat::KnownFormat),
    minimum,
    ..Object::with_type(ty)
  }))
}

macro_rules! primitives {
  ($($ty:ty => $schema_type:ident, $format:expr, $minimum:expr;)*) => {$(
    impl ToSchema for $ty {
      fn schema() -> RefOr<Schema> {
        primitive(Type::$schema_type, $format, $minimum)
      }
    }
  )*};
}

primitives! {
  String => String, None, None;
  str => String, None, None;
  char => String, None, None;
  bool => Boolean, None, None;
  i8 => Integer, Some(KnownFormat::Int32), None;
  i16 => Integer, Some(KnownFormat::Int32), None;
  i32 => Integer, Some(KnownFormat::Int32), None;
  i64 => Integer, Some(KnownFormat::Int64), None;
  i128 => Integer, None, None;
  isize => Integer, None, None;
  u8 => Integer, Some(KnownFormat::Int32), Some(0.0);
  u16 => Integer, Some(KnownFormat::Int32), Some(0.0);
  u32 => Integer, Some(KnownFormat::Int32), Some(0.0);
  u64 => Integer, Some(KnownFormat::Int64), Some(0.0);
  u128 => Integer, None, Some(0.0);
  usize => Integer, None, Some(0.0);
  f32 => Number, Some(KnownFormat::Float), None;
  f64 => Number, Some(KnownFormat::Double), None;
}

/// `serde_json::Value` accepts anything: the untyped schema `{}`. It stays
/// untyped when nullable, since `{}` already admits `null`.
impl ToSchema for serde_json::Value {
  fn at_site(site: &Site) -> RefOr<Schema> {
    let mut site = site.clone();
    site.default = None;
    site.nullable = None;
    site.decorate(Self::schema())
  }
  fn schema() -> RefOr<Schema> {
    RefOr::T(Schema::Object(Object::any()))
  }
}

#[cfg(feature = "chrono")]
mod chrono_impls {
  use super::*;

  impl<Tz: chrono::TimeZone> ToSchema for chrono::DateTime<Tz> {
    fn schema() -> RefOr<Schema> {
      primitive(Type::String, Some(KnownFormat::DateTime), None)
    }
  }

  primitives! {
    chrono::NaiveDateTime => String, Some(KnownFormat::DateTime), None;
    chrono::NaiveDate => String, Some(KnownFormat::Date), None;
    chrono::NaiveTime => String, None, None;
  }
}

#[cfg(feature = "uuid")]
impl ToSchema for uuid::Uuid {
  fn schema() -> RefOr<Schema> {
    primitive(Type::String, Some(KnownFormat::Uuid), None)
  }
}

/// `Option<T>` is `T` made nullable, and never `required`.
impl<T: ToSchema> ToSchema for Option<T> {
  fn schema() -> RefOr<Schema> {
    Self::at_site(&Site::default())
  }

  fn components(components: &mut Components) {
    register::<T>(components);
  }
  fn operation_components(components: &mut Components) {
    T::operation_components(components);
  }

  fn inline_components(components: &mut Components) {
    T::inline_components(components);
  }

  fn is_option() -> bool {
    true
  }

  fn at_site(site: &Site) -> RefOr<Schema> {
    let mut site = site.clone();
    site.nullable.get_or_insert(true);
    T::at_site(&site)
  }
}

/// Pointers and borrows are their target on the wire (except for
/// `is_option`, below).
macro_rules! transparent {
  ($($ty:ty),*) => {$(
    impl<T: ToSchema + ?Sized> ToSchema for $ty {
      fn name() -> Option<Cow<'static, str>> {
        T::name()
      }
      fn schema() -> RefOr<Schema> {
        T::schema()
      }
      fn components(components: &mut Components) {
        T::components(components)
      }
      fn inline_components(components: &mut Components) {
        T::inline_components(components)
      }
      // utoipa reads `Option` from the outermost type: a `Box<Option<T>>`
      // field is nullable but still `required`.
      fn at_site(site: &Site) -> RefOr<Schema> {
        T::at_site(site)
      }
    }
  )*};
}

transparent!(Box<T>, Rc<T>, Arc<T>, RefCell<T>, &T);

impl<T: ToSchema + ToOwned + ?Sized> ToSchema for Cow<'_, T> {
  fn name() -> Option<Cow<'static, str>> {
    T::name()
  }
  fn schema() -> RefOr<Schema> {
    T::schema()
  }
  fn components(components: &mut Components) {
    T::components(components)
  }
  fn inline_components(components: &mut Components) {
    T::inline_components(components)
  }
  fn at_site(site: &Site) -> RefOr<Schema> {
    T::at_site(site)
  }
}

fn array_at<T: ToSchema + ?Sized>(site: &Site, unique: bool) -> RefOr<Schema> {
  let mut array = Array::new(T::at_site(&site.element()));
  array.unique_items = unique;
  site.decorate(RefOr::T(Schema::Array(array)))
}

/// Sequences are arrays; sets are arrays with `uniqueItems`.
macro_rules! sequences {
  ($($ty:ty => $unique:expr),*) => {$(
    impl<T: ToSchema> ToSchema for $ty {
      fn schema() -> RefOr<Schema> {
        Self::at_site(&Site::default())
      }
      fn components(components: &mut Components) {
        register::<T>(components);
      }
      fn operation_components(components: &mut Components) {
        T::operation_components(components);
      }
      fn inline_components(components: &mut Components) {
        T::inline_components(components);
      }
      fn at_site(site: &Site) -> RefOr<Schema> {
        array_at::<T>(site, $unique)
      }
    }
  )*};
}

sequences!(Vec<T> => false, VecDeque<T> => false, LinkedList<T> => false, [T] => false,
  HashSet<T> => true, BTreeSet<T> => true);

impl<T: ToSchema, const N: usize> ToSchema for [T; N] {
  fn schema() -> RefOr<Schema> {
    Self::at_site(&Site::default())
  }
  fn components(components: &mut Components) {
    register::<T>(components);
  }
  fn operation_components(components: &mut Components) {
    T::operation_components(components);
  }
  fn inline_components(components: &mut Components) {
    T::inline_components(components);
  }
  fn at_site(site: &Site) -> RefOr<Schema> {
    array_at::<T>(site, false)
  }
}

/// A map is an object whose values match `additionalProperties`; its keys
/// are described by `propertyNames`, always in place.
fn map_at<K: ToSchema, V: ToSchema>(site: &Site) -> RefOr<Schema> {
  let keys = K::at_site(&Site {
    inline: true,
    ..Site::default()
  });
  let property_names = match keys {
    RefOr::T(schema) => Some(Box::new(schema)),
    RefOr::Ref(_) => None,
  };
  let object = Object {
    additional_properties: Some(Box::new(AdditionalProperties::RefOr(V::at_site(
      &site.element(),
    )))),
    property_names,
    ..Object::new()
  };
  site.decorate(RefOr::T(Schema::Object(object)))
}

macro_rules! maps {
  ($($map:ident),*) => {$(
    impl<K: ToSchema, V: ToSchema, S> ToSchema for $map<K, V, S> {
      fn schema() -> RefOr<Schema> {
        Self::at_site(&Site::default())
      }
      fn components(components: &mut Components) {
        K::inline_components(components);
        register::<V>(components);
      }
      fn inline_components(components: &mut Components) {
        K::inline_components(components);
        V::inline_components(components);
      }
      fn at_site(site: &Site) -> RefOr<Schema> {
        map_at::<K, V>(site)
      }
    }
  )*};
}

maps!(HashMap);

impl<K: ToSchema, V: ToSchema> ToSchema for BTreeMap<K, V> {
  fn schema() -> RefOr<Schema> {
    Self::at_site(&Site::default())
  }
  fn components(components: &mut Components) {
    K::inline_components(components);
    register::<V>(components);
  }
  fn inline_components(components: &mut Components) {
    K::inline_components(components);
    V::inline_components(components);
  }
  fn at_site(site: &Site) -> RefOr<Schema> {
    map_at::<K, V>(site)
  }
}
