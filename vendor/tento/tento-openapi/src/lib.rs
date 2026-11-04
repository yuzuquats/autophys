//! tento-openapi: the OpenAPI schema and document layer tento owns.
//!
//! A narrow replacement for the parts of `utoipa` tento uses (decision
//! Q-D3b; plan in `projects/tento-openapi.project.docs`):
//!
//! - [`model`]: the OpenAPI 3.1 schema model the writers read;
//! - [`document`]: paths, operations and the complete document JSON bridge;
//! - [`ToSchema`]: how a Rust type describes itself, with impls for the
//!   std, chrono, uuid and serde_json types wire structs use;
//! - `#[derive(ToSchema)]`, which reads `///` docs and the serde attributes
//!   that change the wire shape, and produces the schema utoipa 5 produces
//!   for the same type (see `tests/corpus.rs` for the proof and the
//!   recorded differences).
//!
//! The derive is type-driven where utoipa is syntactic: a field's schema
//! comes from its type's [`ToSchema`] impl, not from the spelling of its
//! last path segment.

use std::borrow::Cow;

pub mod document;
mod impls;
pub mod model;
mod site;

pub use document::*;
pub use model::*;
pub use site::Site;
pub use tento_openapi_macros::{IntoParams, OpenApi, ToSchema, path};

/// The derive's runtime half; not part of the API.
#[doc(hidden)]
#[path = "derive_support.rs"]
pub mod __private;

/// A Rust type's OpenAPI schema.
///
/// A *named* type ([`ToSchema::name`] is `Some`) is published once under
/// `#/components/schemas/<name>` and referenced with `$ref` everywhere it is
/// used; an unnamed type (a primitive, `Option`, `Vec`, a map) is written
/// in place at every use.
pub trait ToSchema {
  /// The component name, or `None` for a type always written in place.
  fn name() -> Option<Cow<'static, str>> {
    None
  }

  /// Name when referenced as a field (generic arguments are suffixed).
  fn reference_name() -> Option<Cow<'static, str>> {
    Self::name()
  }

  /// Name inside a generic component's name, including unnamed primitives.
  fn argument_name() -> Cow<'static, str> {
    Self::reference_name().unwrap_or_else(|| {
      let name = std::any::type_name::<Self>();
      let mut out = String::new();
      let mut word = String::new();
      for ch in name.chars().chain(std::iter::once(' ')) {
        if ch.is_alphanumeric() || ch == '_' || ch == ':' {
          word.push(ch);
        } else {
          if !word.is_empty() {
            out.push_str(word.rsplit("::").next().unwrap());
            word.clear();
          }
          if ch == '<' || ch == ',' {
            out.push('_');
          }
        }
      }
      Cow::Owned(out)
    })
  }

  /// The type's schema: a component's definition, or the inline schema.
  fn schema() -> RefOr<Schema>;

  /// Schema used for a concrete generic reference. Utoipa composes its
  /// generic arguments inline; a generic root keeps its parameter references.
  fn composed_schema() -> RefOr<Schema> {
    Self::schema()
  }

  /// Adds every component this type's schema references, but not the type
  /// itself, to `components`. Use [`register`] to add a type and its
  /// references.
  fn components(components: &mut Components) {
    let _ = components;
  }

  /// Extra dependencies of an operation body. Utoipa registers a derived
  /// body's generic arguments separately, including skipped marker types.
  /// Implementations own traversal: DateTime's timezone is not a wire type.
  fn operation_components(components: &mut Components) {
    let _ = components;
  }

  /// The components a `#[schema(inline)]` use needs: what [`components`]
  /// adds, and for a wrapper (`Option`, `Vec`, a map) its element's
  /// references without the element itself.
  ///
  /// [`components`]: ToSchema::components
  fn inline_components(components: &mut Components) {
    Self::components(components)
  }

  /// Whether the type is `Option<_>`: a field of such a type is never
  /// `required`.
  fn is_option() -> bool {
    false
  }

  /// The schema where the type is used, with that site's description,
  /// nullability, default and inlining applied.
  fn at_site(site: &Site) -> RefOr<Schema> {
    site.apply(Self::reference_name(), Self::composed_schema)
  }
}

/// Adds `T` (when named) and everything it references to `components`.
///
/// A component is inserted before its references are visited, so recursive
/// types terminate without utoipa's `no_recursion` marker.
///
/// # Panics
///
/// When a different schema is already registered under `T`'s name. The
/// comparison ignores `default` values, so a container `#[serde(default)]`
/// whose `Default` is not deterministic (a timestamp, a counter) does not
/// trip it; the component keeps the defaults of the first registration.
/// Container defaults should still be deterministic, or generated TS will
/// change from run to run.
pub fn register<T: ToSchema + ?Sized>(components: &mut Components) {
  match T::reference_name() {
    Some(name) => {
      if let Some(existing) = components.schemas.get(name.as_ref()) {
        // Two types published under one name would silently shadow each
        // other (utoipa keeps the last); refuse instead. `default` values
        // are left out of the comparison: they come from `Default`, which
        // need not return the same value twice.
        assert!(
          same_ignoring_defaults(existing, &T::composed_schema()),
          "tento-openapi: two different schemas are named `{name}` \
           (`#[schema(as = …)]` or two types with one name)"
        );
        return;
      }
      components
        .schemas
        .insert(name.into_owned(), T::composed_schema());
      T::components(components);
    }
    None => T::components(components),
  }
}

/// `T`'s component (when named) and every component it reaches.
pub fn components_of<T: ToSchema + ?Sized>() -> Components {
  let mut components = Components::default();
  if let Some(name) = T::name() {
    components.schemas.insert(name.into_owned(), T::schema());
    T::components(&mut components);
  } else {
    T::components(&mut components);
  }
  components
}

/// Two schemas are the same apart from their `default` values (the
/// `default` keyword at any depth; a property *named* `default` still
/// counts).
fn same_ignoring_defaults(a: &RefOr<Schema>, b: &RefOr<Schema>) -> bool {
  fn strip(value: &mut serde_json::Value, property_names: bool) {
    match value {
      serde_json::Value::Object(map) => {
        if !property_names {
          map.remove("default");
        }
        for (key, child) in map.iter_mut() {
          strip(child, !property_names && key == "properties");
        }
      }
      serde_json::Value::Array(items) => items.iter_mut().for_each(|item| strip(item, false)),
      _ => {}
    }
  }
  match (serde_json::to_value(a), serde_json::to_value(b)) {
    (Ok(mut a), Ok(mut b)) => {
      strip(&mut a, false);
      strip(&mut b, false);
      a == b
    }
    _ => a == b,
  }
}

/// The parameters contributed by a query or path wire struct.
pub trait IntoParams {
  fn into_params(parameter_in_provider: impl Fn() -> Option<ParameterIn>) -> Vec<Parameter>;
  fn components(components: &mut Components) {
    let _ = components;
  }
}
