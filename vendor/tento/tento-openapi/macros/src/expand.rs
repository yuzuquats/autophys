//! The `ToSchema` impl a type derives.
//!
//! Generated bodies open with `use ::tento_openapi::__private as __p;` and
//! call its helpers, so each field costs one short call; the volume of code
//! a derive hands rustc is part of the build time this crate exists to cut.

use proc_macro2::TokenStream;
use quote::quote;
use syn::{Data, DeriveInput, Fields, Type, Variant};

use crate::attrs::{Container, Field, RenameRule, Repr, Source, spelled_option};

/// `Site` flag bits; must match `tento_openapi::__private::site`.
const INLINE: u8 = 1;
const DEPRECATED: u8 = 2;
const NULLABLE: u8 = 4;
const NOT_NULLABLE: u8 = 8;

pub fn derive(input: &DeriveInput) -> syn::Result<TokenStream> {
  let container = Container::parse(&input.attrs)?;
  let generic_params: Vec<_> = input
    .generics
    .type_params()
    .map(|p| p.ident.clone())
    .collect();
  let ident = &input.ident;
  let is_newtype = matches!(
    &input.data,
    Data::Struct(d) if matches!(&d.fields, Fields::Unnamed(f) if f.unnamed.len() == 1)
  );
  if let (Some(ty), false) = (&container.value_type, is_newtype) {
    return Err(syn::Error::new_spanned(
      ty,
      "tento-openapi: a type-level `#[schema(value_type = …)]` applies to single-field tuple structs only",
    ));
  }
  let name = container
    .schema_as
    .clone()
    .unwrap_or_else(|| ident.to_string());
  let (body, components) = match &input.data {
    Data::Struct(data) => match &data.fields {
      Fields::Named(fields) => {
        let fields: Vec<_> = fields.named.iter().collect();
        let object = named_fields(
          &fields,
          container.rename_all,
          &container,
          true,
          &generic_params,
        )?;
        let deny = container.deny_unknown_fields;
        let docs = docs_lit(&container.docs);
        let deprecated = container.deprecated;
        let build = object.build;
        (
          quote! { __p::RefOr::T({ #build }.finish(#deny, #docs, #deprecated)) },
          object.components,
        )
      }
      Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
        let field = fields.unnamed.first().expect("one field");
        let rules = Field::parse(&field.attrs, "newtype field")?;
        let site = site(
          &container.docs,
          flags(rules.inline, container.deprecated, None),
          None,
        );
        // A type-level `value_type` replaces the inner type, as a field's does.
        let declared = container
          .value_type
          .clone()
          .unwrap_or_else(|| field.ty.clone());
        field_schema(&rules, &declared, site, &generic_params)
      }
      Fields::Unnamed(fields) if !fields.unnamed.is_empty() => tuple_fields(
        &fields.unnamed.iter().collect::<Vec<_>>(),
        &container.docs,
        container.deprecated,
        &generic_params,
      )?,
      Fields::Unit | Fields::Unnamed(_) => {
        let docs = docs_lit(&container.docs);
        (
          quote! { __p::RefOr::T(__p::describe(__p::Schema::Object(::tento_openapi::Object {
            default: Some(__p::serde_json::Value::Null), ..::tento_openapi::Object::any()
          }), #docs, false)) },
          quote! {},
        )
      }
    },
    Data::Enum(data) => enum_body(
      &data.variants.iter().collect::<Vec<_>>(),
      &container,
      &generic_params,
    )?,
    Data::Union(_) => {
      return Err(syn::Error::new_spanned(
        ident,
        "tento-openapi: unions do not derive ToSchema",
      ));
    }
  };
  let mut generics = input.generics.clone();
  for param in generics.type_params_mut() {
    param
      .bounds
      .push(syn::parse_quote!(::tento_openapi::ToSchema));
  }
  let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();
  let arguments: Vec<_> = input.generics.type_params().map(|p| &p.ident).collect();
  let reference_name = if arguments.is_empty() {
    quote! { <Self as ::tento_openapi::ToSchema>::name() }
  } else {
    quote! { Some(::std::borrow::Cow::Owned(format!("{}_{}", #name,
    [#(<#arguments as ::tento_openapi::ToSchema>::argument_name()),*].join("_")))) }
  };
  let composed_impl = (!generic_params.is_empty()).then(|| {
    quote! {
        fn composed_schema() -> ::tento_openapi::RefOr<::tento_openapi::Schema> {
          use ::tento_openapi::__private as __p;
          let __composed = true;
          #body
        }
    }
  });
  Ok(quote! {
    #[automatically_derived]
    impl #impl_generics ::tento_openapi::ToSchema for #ident #ty_generics #where_clause {
      fn name() -> ::core::option::Option<::std::borrow::Cow<'static, str>> {
        ::tento_openapi::__private::name(#name)
      }
      fn reference_name() -> ::core::option::Option<::std::borrow::Cow<'static, str>> {
        #reference_name
      }
      fn schema() -> ::tento_openapi::RefOr<::tento_openapi::Schema> {
        use ::tento_openapi::__private as __p;
        let __composed = false;
        #body
      }
      #composed_impl
      fn operation_components(__c: &mut ::tento_openapi::Components) {
        #(::tento_openapi::register::<#arguments>(__c);)*
      }
      fn components(__c: &mut ::tento_openapi::Components) {
        use ::tento_openapi::__private as __p;
        let _ = &__c;
        #components
      }
    }
  })
}

/// Code that builds a `Fields` value (an expression), and the statements
/// registering what those fields reference.
struct Object {
  build: TokenStream,
  components: TokenStream,
}

/// The fields of a struct or of a named enum variant. `defaults` is whether
/// a container `#[serde(default)]` writes each field's default value (only
/// a struct has a `Self::default()` to read it from).
fn named_fields(
  fields: &[&syn::Field],
  rename_all: Option<RenameRule>,
  container: &Container,
  defaults: bool,
  generics: &[syn::Ident],
) -> syn::Result<Object> {
  let mut statements = Vec::new();
  let mut components = Vec::new();
  for field in fields {
    let rules = Field::parse(&field.attrs, "field")?;
    if rules.skip {
      continue;
    }
    let ident = field.ident.as_ref().expect("named field");
    let raw = ident.to_string();
    let raw = raw.strip_prefix("r#").unwrap_or(&raw);
    let name = rules
      .rename
      .clone()
      .or_else(|| rules.schema_rename.clone())
      .unwrap_or_else(|| match rename_all {
        Some(rule) => rule.apply_to_field(raw),
        None => raw.to_owned(),
      });
    let default = (defaults && container.default)
      .then(|| quote! { &<Self as ::core::default::Default>::default().#ident });
    let site = site(
      &rules.docs,
      flags(rules.inline, rules.deprecated, rules.nullable),
      default,
    );
    let (schema, registers) = field_schema(&rules, &field.ty, site, generics);
    components.push(registers);
    if rules.flatten {
      statements.push(quote! { __f.flatten(#schema); });
      continue;
    }
    let optional_by_serde = rules.skip_serializing_if || rules.default || container.default;
    // utoipa reads `Option` from the schema's type: `value_type` when given,
    // else the declared type. `schema_with` keeps the declared type.
    let required = match rules.required {
      Some(required) => quote! { #required },
      None if optional_by_serde => quote! { false },
      None => match rules.source(&field.ty) {
        Source::Type(ty) if matches!(&ty, Type::Path(p) if p.path.segments.len() == 1 && generics.contains(&p.path.segments[0].ident)) =>
        {
          quote! { true }
        }
        Source::Type(ty) => quote! { !<#ty as __p::ToSchema>::is_option() },
        Source::With(_) => {
          let required = !spelled_option(&field.ty);
          quote! { #required }
        }
      },
    };
    statements.push(quote! { __f.field(#name, #schema, #required); });
  }
  Ok(Object {
    build: quote! {
      let mut __f = __p::Fields::new();
      #(#statements)*
      __f
    },
    components: quote! { #(#components)* },
  })
}

fn flags(inline: bool, deprecated: bool, nullable: Option<bool>) -> u8 {
  let mut flags = 0;
  if inline {
    flags |= INLINE;
  }
  if deprecated {
    flags |= DEPRECATED;
  }
  match nullable {
    Some(true) => flags |= NULLABLE,
    Some(false) => flags |= NOT_NULLABLE,
    None => {}
  }
  flags
}

/// A `&Site` expression: `__p::site(docs, flags)`, or `__p::site_default(…)`
/// with a reference to the field's default value.
fn site(docs: &Option<String>, flags: u8, default: Option<TokenStream>) -> TokenStream {
  let docs = docs_lit(docs);
  match default {
    Some(value) => quote! { &__p::site_default(#docs, #flags, #value) },
    None => quote! { &__p::site(#docs, #flags) },
  }
}

/// Docs as a string literal; `""` when there are none.
fn docs_lit(docs: &Option<String>) -> TokenStream {
  let docs = docs.as_deref().unwrap_or("");
  quote! { #docs }
}

/// A field's schema expression at `site`, and the statement registering
/// what it references.
fn field_schema(
  rules: &Field,
  declared: &Type,
  site: TokenStream,
  generics: &[syn::Ident],
) -> (TokenStream, TokenStream) {
  match rules.source(declared) {
    Source::Type(ty) => {
      let register = registrations(&ty, rules.inline, generics);
      let schema = if contains_generic(&ty, generics) {
        quote! { {
          let mut __site = (#site).clone();
          if __composed { __site.inline = true; }
          <#ty as __p::ToSchema>::at_site(&__site)
        } }
      } else {
        quote! { <#ty as __p::ToSchema>::at_site(#site) }
      };
      (schema, register)
    }
    Source::With(path) => (quote! { ::core::convert::Into::<__p::RefOr<__p::Schema>>::into(#path()) }, quote! {}),
  }
}

fn enum_body(
  variants: &[&Variant],
  container: &Container,
  generics: &[syn::Ident],
) -> syn::Result<(TokenStream, TokenStream)> {
  let docs = docs_lit(&container.docs);
  let deprecated = container.deprecated;
  let plain = variants.iter().all(|v| matches!(v.fields, Fields::Unit));
  let mut kept = Vec::new();
  for variant in variants {
    let rules = Field::parse(&variant.attrs, "variant")?;
    if rules.skip {
      continue;
    }
    let raw = variant.ident.to_string();
    let name = rules
      .rename
      .clone()
      .or_else(|| rules.schema_rename.clone())
      .unwrap_or_else(|| match container.rename_all {
        Some(rule) => rule.apply_to_variant(&raw),
        None => raw.clone(),
      });
    kept.push((*variant, rules, name));
  }

  if plain {
    let names: Vec<&String> = kept.iter().map(|(_, _, name)| name).collect();
    let body = match &container.repr {
      Repr::External => quote! { __p::string_enum(&[#(#names),*]) },
      Repr::Internal { tag } => quote! { __p::tagged_units(#tag, &[#(#names),*]) },
      Repr::Untagged => quote! { __p::Schema::Object(__p::null_unit()) },
      Repr::Adjacent { tag, content } => {
        quote! { __p::adjacent_units(#tag, #content, &[#(#names),*]) }
      }
    };
    return Ok((
      quote! { __p::RefOr::T(__p::describe(#body, #docs, #deprecated)) },
      quote! {},
    ));
  }

  let mut items = Vec::new();
  let mut components = Vec::new();
  for (variant, rules, name) in &kept {
    let vdocs = docs_lit(&rules.docs);
    let vdep = rules.deprecated;
    let item = match &variant.fields {
      Fields::Unit => {
        let schema = match &container.repr {
          Repr::External => quote! { __p::string_enum(&[#name]) },
          Repr::Internal { tag } | Repr::Adjacent { tag, .. } => {
            quote! { __p::Schema::Object(__p::tag_object(#tag, #name)) }
          }
          Repr::Untagged => quote! { __p::Schema::Object(__p::null_unit()) },
        };
        quote! { __p::RefOr::T(__p::describe(#schema, #vdocs, #vdep)) }
      }
      Fields::Named(fields) => {
        let fields: Vec<_> = fields.named.iter().collect();
        let variant_container = Container::parse_variant(&variant.attrs)?;
        let object = named_fields(
          &fields,
          variant_container.rename_all,
          &variant_container,
          false,
          generics,
        )?;
        components.push(object.components);
        let build = object.build;
        let deny = variant_container.deny_unknown_fields;
        let inner = quote! { { #build }.finish(#deny, #vdocs, #vdep) };
        let schema = match &container.repr {
          Repr::External => quote! {
            __p::describe(__p::external(#name, __p::RefOr::T(#inner)), #vdocs, #vdep)
          },
          Repr::Internal { tag } => {
            quote! { __p::internal_named(#inner, #tag, #name, #vdocs, #vdep) }
          }
          Repr::Untagged => inner,
          Repr::Adjacent { tag, content } => quote! {
            __p::describe(
              __p::adjacent(__p::RefOr::T(#inner), #tag, #content, #name),
              #vdocs, #vdep,
            )
          },
        };
        quote! { __p::RefOr::T(#schema) }
      }
      Fields::Unnamed(fields) if !fields.unnamed.is_empty() => {
        let field = fields.unnamed.first().expect("one field");
        let field_rules = Field::parse(&field.attrs, "variant field")?;
        let site = site(&rules.docs, flags(field_rules.inline, vdep, None), None);
        let (inner, register) = if fields.unnamed.len() == 1 {
          field_schema(&field_rules, &field.ty, site, generics)
        } else {
          tuple_fields(
            &fields.unnamed.iter().collect::<Vec<_>>(),
            &rules.docs,
            vdep,
            generics,
          )?
        };
        components.push(register);
        match &container.repr {
          Repr::External => quote! {
            __p::RefOr::T(__p::describe(__p::external(#name, #inner), #vdocs, #vdep))
          },
          Repr::Internal { tag } => quote! {
            __p::RefOr::T(__p::internal_unnamed(#inner, #tag, #name, #vdocs, #vdep))
          },
          Repr::Untagged => inner,
          Repr::Adjacent { tag, content } => quote! {
            __p::RefOr::T(__p::describe(
              __p::adjacent(#inner, #tag, #content, #name),
              #vdocs, #vdep,
            ))
          },
        }
      }
      other => {
        return Err(syn::Error::new_spanned(
          other,
          "tento-openapi: tuple variants with more than one field are not supported",
        ));
      }
    };
    items.push(item);
  }
  Ok((
    quote! {
      __p::RefOr::T(__p::describe(__p::one_of(::std::vec![#(#items),*]), #docs, #deprecated))
    },
    quote! { #(#components)* },
  ))
}

/// Utoipa describes homogeneous tuples as a fixed-length array of their
/// first field and heterogeneous tuples as a fixed-length object array.
fn tuple_fields(
  fields: &[&syn::Field],
  docs: &Option<String>,
  deprecated: bool,
  generics: &[syn::Ident],
) -> syn::Result<(TokenStream, TokenStream)> {
  use quote::ToTokens;
  let first = fields[0];
  let homogeneous = fields
    .iter()
    .all(|f| f.ty.to_token_stream().to_string() == first.ty.to_token_stream().to_string());
  let (item, components) = if homogeneous {
    let rules = Field::parse(&first.attrs, "tuple field")?;
    field_schema(
      &rules,
      &first.ty,
      site(docs, flags(false, deprecated, None), None),
      generics,
    )
  } else {
    (
      quote! { __p::RefOr::T(__p::Schema::Object(::tento_openapi::Object::new())) },
      quote! {},
    )
  };
  let len = fields.len();
  let docs = docs_lit(docs);
  Ok((
    quote! { {
      let mut __array = ::tento_openapi::Array::new(#item);
      __array.min_items = Some(#len); __array.max_items = Some(#len);
      __p::RefOr::T(__p::describe(__p::Schema::Array(__array), #docs, #deprecated))
    } },
    components,
  ))
}

/// Utoipa omits a bare generic parameter's own component from the generic
/// definition; concrete generic references compose those arguments inline.
fn registrations(ty: &Type, inline: bool, generics: &[syn::Ident]) -> TokenStream {
  if let Type::Path(path) = ty
    && let Some(last) = path.path.segments.last()
  {
    if path.path.segments.len() == 1 && generics.contains(&last.ident) {
      return quote! { <#ty as __p::ToSchema>::inline_components(__c); };
    }
    let mut args = Vec::new();
    if let syn::PathArguments::AngleBracketed(arguments) = &last.arguments {
      args.extend(arguments.args.iter().filter_map(|arg| match arg {
        syn::GenericArgument::Type(ty) => Some(ty),
        _ => None,
      }));
    }
    let wrapper = matches!(
      last.ident.to_string().as_str(),
      "Option"
        | "Vec"
        | "VecDeque"
        | "LinkedList"
        | "HashSet"
        | "BTreeSet"
        | "HashMap"
        | "BTreeMap"
        | "Box"
        | "Arc"
        | "Rc"
        | "RefCell"
        | "Cow"
    );
    let children: Vec<_> = args
      .iter()
      .map(|ty| registrations(ty, inline, generics))
      .collect();
    if wrapper && !generics.is_empty() {
      return quote! { #(#children)* };
    }
    let own = if inline {
      quote! { <#ty as __p::ToSchema>::inline_components(__c); }
    } else {
      quote! { __p::register::<#ty>(__c); }
    };
    return own;
  }
  if inline {
    quote! { <#ty as __p::ToSchema>::inline_components(__c); }
  } else {
    quote! { __p::register::<#ty>(__c); }
  }
}

fn contains_generic(ty: &Type, generics: &[syn::Ident]) -> bool {
  match ty {
    Type::Path(p) => p.path.segments.iter().any(|segment| {
      generics.contains(&segment.ident)
        || match &segment.arguments {
          syn::PathArguments::AngleBracketed(args) => args.args.iter().any(
            |arg| matches!(arg, syn::GenericArgument::Type(ty) if contains_generic(ty, generics)),
          ),
          _ => false,
        }
    }),
    Type::Reference(r) => contains_generic(&r.elem, generics),
    Type::Array(a) => contains_generic(&a.elem, generics),
    Type::Slice(a) => contains_generic(&a.elem, generics),
    Type::Tuple(t) => t.elems.iter().any(|ty| contains_generic(ty, generics)),
    _ => false,
  }
}
