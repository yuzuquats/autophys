//! What the derive reads from a type: `///` docs, the serde attributes that
//! change the wire shape, and the `#[schema(…)]` keys tento supports.
//!
//! The serde reading follows utoipa 5 rather than serde where the two
//! differ, so the first migration changes no generated TS or Swift: only the
//! `key = "…"` form of `rename` / `rename_all` is read, `transparent` is not
//! (a single-field named struct stays an object), and `skip_deserializing`
//! skips the field.

use syn::parse::ParseStream;
use syn::{Attribute, Expr, Lit, LitStr, Meta, Path, Token, Type};

/// `#[serde(rename_all = "…")]`, applied the way serde applies it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenameRule {
  Lower,
  Upper,
  Pascal,
  Camel,
  Snake,
  ScreamingSnake,
  Kebab,
  ScreamingKebab,
}

impl RenameRule {
  pub fn parse(lit: &LitStr) -> syn::Result<Self> {
    Ok(match lit.value().as_str() {
      "lowercase" => RenameRule::Lower,
      "UPPERCASE" => RenameRule::Upper,
      "PascalCase" => RenameRule::Pascal,
      "camelCase" => RenameRule::Camel,
      "snake_case" => RenameRule::Snake,
      "SCREAMING_SNAKE_CASE" => RenameRule::ScreamingSnake,
      "kebab-case" => RenameRule::Kebab,
      "SCREAMING-KEBAB-CASE" => RenameRule::ScreamingKebab,
      other => {
        return Err(syn::Error::new_spanned(
          lit,
          format!("unknown rename rule `{other}`"),
        ));
      }
    })
  }

  /// utoipa 5's rule for a field name (`RenameRule::rename` in utoipa-gen).
  /// It differs from serde's only around underscores that start a name or
  /// do not separate words: under `camelCase`, `_type` is `Type` here and
  /// `type` in serde. Kept for parity (TO-2); see derive.md.
  pub fn apply_to_field(self, field: &str) -> String {
    match self {
      RenameRule::Lower => field.to_ascii_lowercase(),
      RenameRule::Upper => field.to_ascii_uppercase(),
      RenameRule::Camel => {
        let mut camel = String::new();
        let mut upper = false;
        for ch in field.chars() {
          if ch == '_' {
            upper = true;
          } else if upper {
            camel.push(ch.to_ascii_uppercase());
            upper = false;
          } else {
            camel.push(ch);
          }
        }
        camel
      }
      RenameRule::Snake => field.to_owned(),
      RenameRule::ScreamingSnake => field.to_ascii_uppercase(),
      RenameRule::Pascal => {
        let mut chars = field.chars();
        match chars.next() {
          Some(first) => {
            first.to_ascii_uppercase().to_string()
              + &RenameRule::Camel.apply_to_field(chars.as_str())
          }
          None => String::new(),
        }
      }
      RenameRule::Kebab => field.replace('_', "-"),
      RenameRule::ScreamingKebab => field.replace('_', "-").to_ascii_uppercase(),
    }
  }

  /// utoipa 5's rule for a variant name (`RenameRule::rename_variant`).
  pub fn apply_to_variant(self, variant: &str) -> String {
    match self {
      RenameRule::Lower => variant.to_ascii_lowercase(),
      RenameRule::Upper => variant.to_ascii_uppercase(),
      RenameRule::Camel => lower_first(variant),
      RenameRule::Snake => {
        let mut snake = String::new();
        for (i, ch) in variant.char_indices() {
          if i > 0 && ch.is_uppercase() {
            snake.push('_');
          }
          snake.push(ch);
        }
        snake.to_ascii_lowercase()
      }
      RenameRule::ScreamingSnake => RenameRule::Snake
        .apply_to_variant(variant)
        .to_ascii_uppercase(),
      RenameRule::Pascal => variant.to_owned(),
      RenameRule::Kebab => RenameRule::Snake
        .apply_to_variant(variant)
        .replace('_', "-"),
      RenameRule::ScreamingKebab => RenameRule::Kebab
        .apply_to_variant(variant)
        .to_ascii_uppercase(),
    }
  }
}

fn lower_first(name: &str) -> String {
  let mut chars = name.chars();
  match chars.next() {
    Some(first) => first.to_ascii_lowercase().to_string() + chars.as_str(),
    None => String::new(),
  }
}

/// The serde enum representation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Repr {
  External,
  Internal { tag: String },
  Adjacent { tag: String, content: String },
  Untagged,
}

/// Container-level attributes: `#[serde(…)]`, `#[schema(…)]`, docs.
#[derive(Debug)]
pub struct Container {
  pub rename_all: Option<RenameRule>,
  pub repr: Repr,
  pub default: bool,
  pub deny_unknown_fields: bool,
  /// `#[schema(as = a::b::Name)]`: the component is named `a.b.Name`.
  pub schema_as: Option<String>,
  /// `#[schema(value_type = T)]` on a single-field tuple struct: the
  /// struct's schema is `T`'s (lona-models `SheetCell`).
  pub value_type: Option<Type>,
  pub docs: Option<String>,
  pub deprecated: bool,
}

impl Container {
  /// A type's attributes.
  pub fn parse(attrs: &[Attribute]) -> syn::Result<Self> {
    Container::read(attrs, true)
  }

  /// A struct-like enum variant's serde attributes; its `#[schema(…)]` keys
  /// are a variant's, read by [`Field::parse`].
  pub fn parse_variant(attrs: &[Attribute]) -> syn::Result<Self> {
    Container::read(attrs, false)
  }

  fn read(attrs: &[Attribute], read_schema: bool) -> syn::Result<Self> {
    let mut rename_all = None;
    let mut tag = None;
    let mut content = None;
    let mut untagged = false;
    let mut default = false;
    let mut deny_unknown_fields = false;
    for attr in attrs.iter().filter(|a| a.path().is_ident("serde")) {
      attr.parse_nested_meta(|meta| {
        let key = meta
          .path
          .get_ident()
          .map(|i| i.to_string())
          .unwrap_or_default();
        match key.as_str() {
          "rename_all" => {
            if let Some(lit) = plain_str(&meta)? {
              rename_all = Some(RenameRule::parse(&lit)?);
            }
          }
          "tag" => tag = plain_str(&meta)?.map(|l| l.value()),
          "content" => content = plain_str(&meta)?.map(|l| l.value()),
          "untagged" => untagged = true,
          "default" => {
            default = true;
            skip_value(meta.input)?;
          }
          "deny_unknown_fields" => deny_unknown_fields = true,
          _ => skip_value(meta.input)?,
        }
        Ok(())
      })?;
    }
    let mut schema_as = None;
    let mut value_type = None;
    let schema_attrs = attrs
      .iter()
      .filter(|a| read_schema && a.path().is_ident("schema"));
    for attr in schema_attrs {
      attr.parse_nested_meta(|meta| {
        let key = meta
          .path
          .get_ident()
          .map(|i| i.to_string())
          .unwrap_or_default();
        match key.as_str() {
          "as" => {
            let path: Path = meta.value()?.parse()?;
            let name = path
              .segments
              .iter()
              .map(|s| s.ident.to_string())
              .collect::<Vec<_>>()
              .join(".");
            schema_as = Some(name);
          }
          "value_type" => value_type = Some(meta.value()?.parse()?),
          // Recursive types terminate without it: `register` inserts a
          // component before visiting its references.
          "no_recursion" => {}
          _ => return Err(meta.error(unsupported(&key, "type"))),
        }
        Ok(())
      })?;
    }
    let repr = match (tag, content, untagged) {
      (_, _, true) => Repr::Untagged,
      (Some(tag), Some(content), false) => Repr::Adjacent { tag, content },
      (Some(tag), None, false) => Repr::Internal { tag },
      _ => Repr::External,
    };
    Ok(Container {
      rename_all,
      repr,
      default,
      deny_unknown_fields,
      schema_as,
      value_type: value_type.map(|ty| special_types(&ty)),
      docs: docs(attrs),
      deprecated: is_deprecated(attrs),
    })
  }
}

/// Where a field's schema comes from.
pub enum Source {
  /// The field's own type, or `#[schema(value_type = T)]` with utoipa's
  /// special names replaced (see [`special_types`]).
  Type(Type),
  /// `#[schema(schema_with = path)]`.
  With(Path),
}

/// Field-level attributes. Also used for an enum variant's own
/// `#[serde(…)]` (`rename`, `skip`).
#[derive(Default)]
pub struct Field {
  pub rename: Option<String>,
  pub skip: bool,
  pub skip_serializing_if: bool,
  pub default: bool,
  pub flatten: bool,
  pub required: Option<bool>,
  pub value_type: Option<Type>,
  pub inline: bool,
  pub nullable: Option<bool>,
  pub schema_with: Option<Path>,
  pub schema_rename: Option<String>,
  pub docs: Option<String>,
  pub deprecated: bool,
}

impl Field {
  pub fn parse(attrs: &[Attribute], site: &str) -> syn::Result<Self> {
    let mut field = Field {
      docs: docs(attrs),
      deprecated: is_deprecated(attrs),
      ..Field::default()
    };
    for attr in attrs.iter().filter(|a| a.path().is_ident("serde")) {
      attr.parse_nested_meta(|meta| {
        let key = meta
          .path
          .get_ident()
          .map(|i| i.to_string())
          .unwrap_or_default();
        match key.as_str() {
          "rename" => field.rename = plain_str(&meta)?.map(|l| l.value()),
          "skip" | "skip_serializing" | "skip_deserializing" => field.skip = true,
          "skip_serializing_if" => {
            field.skip_serializing_if = true;
            skip_value(meta.input)?;
          }
          "default" => {
            field.default = true;
            skip_value(meta.input)?;
          }
          "flatten" => field.flatten = true,
          _ => skip_value(meta.input)?,
        }
        Ok(())
      })?;
    }
    for attr in attrs.iter().filter(|a| a.path().is_ident("schema")) {
      attr.parse_nested_meta(|meta| {
        let key = meta
          .path
          .get_ident()
          .map(|i| i.to_string())
          .unwrap_or_default();
        match key.as_str() {
          "required" => field.required = Some(optional_bool(&meta)?),
          "inline" => field.inline = optional_bool(&meta)?,
          "nullable" => field.nullable = Some(optional_bool(&meta)?),
          "value_type" => field.value_type = Some(meta.value()?.parse()?),
          "schema_with" => field.schema_with = Some(meta.value()?.parse()?),
          "rename" => field.schema_rename = Some(meta.value()?.parse::<LitStr>()?.value()),
          "no_recursion" => {}
          _ => return Err(meta.error(unsupported(&key, site))),
        }
        Ok(())
      })?;
    }
    Ok(field)
  }

  /// Where this field's schema comes from, given its declared type.
  pub fn source(&self, declared: &Type) -> Source {
    if let Some(path) = &self.schema_with {
      return Source::With(path.clone());
    }
    match &self.value_type {
      Some(ty) => Source::Type(special_types(ty)),
      None => Source::Type(declared.clone()),
    }
  }
}

/// In a `value_type`, utoipa reads a bare `Object` as a free-form object
/// and a bare `Value` as any value, at any depth (`Option<Object>`,
/// `Vec<Value>`). Those names become `tento_openapi` marker types here.
pub fn special_types(ty: &Type) -> Type {
  let mut ty = ty.clone();
  rewrite(&mut ty);
  ty
}

fn rewrite(ty: &mut Type) {
  match ty {
    Type::Path(p) if p.qself.is_none() => {
      if p.path.segments.len() == 1 && p.path.segments[0].arguments.is_none() {
        let ident = &p.path.segments[0].ident;
        if ident == "Object" {
          *ty = syn::parse_quote!(::tento_openapi::__private::FreeFormObject);
          return;
        }
        if ident == "Value" {
          *ty = syn::parse_quote!(::tento_openapi::__private::AnyValue);
          return;
        }
      }
      for segment in &mut p.path.segments {
        if let syn::PathArguments::AngleBracketed(args) = &mut segment.arguments {
          for arg in &mut args.args {
            if let syn::GenericArgument::Type(inner) = arg {
              rewrite(inner);
            }
          }
        }
      }
    }
    Type::Reference(r) => rewrite(&mut r.elem),
    Type::Slice(s) => rewrite(&mut s.elem),
    Type::Array(a) => rewrite(&mut a.elem),
    Type::Paren(p) => rewrite(&mut p.elem),
    Type::Group(g) => rewrite(&mut g.elem),
    Type::Tuple(t) => t.elems.iter_mut().for_each(rewrite),
    _ => {}
  }
}

fn unsupported(key: &str, site: &str) -> String {
  format!(
    "tento-openapi: `#[schema({key})]` is not supported on a {site}; \
     see projects/tento-openapi.project.docs for the supported keys"
  )
}

/// `key = "…"`; `None` for the `key(serialize = …)` form, which utoipa
/// ignores too.
fn plain_str(meta: &syn::meta::ParseNestedMeta) -> syn::Result<Option<LitStr>> {
  if meta.input.peek(Token![=]) {
    let value = meta.value()?;
    return Ok(Some(value.parse()?));
  }
  skip_value(meta.input)?;
  Ok(None)
}

/// `key` (true) or `key = bool`.
fn optional_bool(meta: &syn::meta::ParseNestedMeta) -> syn::Result<bool> {
  if meta.input.peek(Token![=]) {
    let lit: syn::LitBool = meta.value()?.parse()?;
    return Ok(lit.value);
  }
  Ok(true)
}

/// Consumes `= value` or `(…)` after a key the derive does not read.
fn skip_value(input: ParseStream) -> syn::Result<()> {
  if input.peek(Token![=]) {
    input.parse::<Token![=]>()?;
    input.parse::<Expr>()?;
  } else if input.peek(syn::token::Paren) {
    let content;
    syn::parenthesized!(content in input);
    content.parse::<proc_macro2::TokenStream>()?;
  }
  Ok(())
}

/// `///` docs as utoipa joins them: trailing space trimmed per line, the
/// smallest common run of leading spaces removed, lines joined with `\n`.
pub fn docs(attrs: &[Attribute]) -> Option<String> {
  let mut lines: Vec<String> = attrs
    .iter()
    .filter(|a| a.path().is_ident("doc"))
    .filter_map(|a| match &a.meta {
      Meta::NameValue(nv) => match &nv.value {
        Expr::Lit(lit) => match &lit.lit {
          Lit::Str(s) => {
            let mut line = s.value();
            line.truncate(line.trim_end().len());
            Some(line)
          }
          _ => None,
        },
        _ => None,
      },
      _ => None,
    })
    .collect();
  let indent = lines
    .iter()
    .filter(|l| !l.is_empty())
    .map(|l| l.len() - l.trim_start_matches(' ').len())
    .min()
    .unwrap_or(0);
  for line in &mut lines {
    if !line.is_empty() {
      line.drain(..indent);
    }
  }
  let joined = lines.join("\n");
  (!joined.is_empty()).then_some(joined)
}

fn is_deprecated(attrs: &[Attribute]) -> bool {
  attrs.iter().any(|a| a.path().is_ident("deprecated"))
}

/// Whether a type is spelled `Option<…>`; used where the field's own type
/// need not implement `ToSchema` (`value_type`, `schema_with`).
pub fn spelled_option(ty: &Type) -> bool {
  match ty {
    Type::Path(p) => p.path.segments.last().is_some_and(|s| s.ident == "Option"),
    _ => false,
  }
}
