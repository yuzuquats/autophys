//! `#[derive(Schema)]`: a type's data model as a `TypeDesc` — serde field
//! names, structured field types, `///` docs, and the `#[view(…)]`
//! presentation hints. Presentation only: nothing here touches serde.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{
  Attribute, Data, DeriveInput, Fields, GenericParam, LitStr, Token, parse_macro_input, parse_quote,
};

use crate::command_arg_derive::{consume_serde_meta_value, doc_comment, serde_rename};

pub fn derive(input: TokenStream) -> TokenStream {
  let input = parse_macro_input!(input as DeriveInput);
  match expand(&input) {
    Ok(expanded) => expanded.into(),
    Err(error) => error.to_compile_error().into(),
  }
}

fn expand(input: &DeriveInput) -> syn::Result<TokenStream2> {
  let tn = crate::tento_crate();
  let name = &input.ident;
  let mut generics = input.generics.clone();
  for param in &mut generics.params {
    if let GenericParam::Type(ty) = param {
      ty.bounds.push(parse_quote!(#tn::schema::Schema));
    }
  }
  let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();
  let container = ContainerAttrs::parse(&input.attrs)?;
  let type_name = container.rename.clone().unwrap_or_else(|| name.to_string());

  let body = match &input.data {
    Data::Struct(data) => match &data.fields {
      Fields::Named(fields) => {
        let mut pushes = Vec::new();
        for field in &fields.named {
          let ident = field.ident.as_ref().expect("named field");
          let view = ViewAttrs::parse(&field.attrs, ViewSite::Field)?;
          if serde_skips(&field.attrs)? {
            continue;
          }
          let ty = &field.ty;
          if serde_flag(&field.attrs, "flatten")? {
            pushes.push(quote! {
              if let Some(inner) = <#ty as #tn::schema::Schema>::schema().record_fields() {
                fields.extend(inner.iter().cloned());
              }
            });
            continue;
          }
          let field_name = match serde_rename(&field.attrs)? {
            Some(rename) => rename,
            None => container.apply_rename_all(&ident.to_string()),
          };
          let doc = option_str(doc_comment(&field.attrs));
          let view = view.to_tokens(&tn);
          pushes.push(quote! {
            fields.push(#tn::schema::FieldDesc {
              name: #field_name.to_string(),
              ty: <#ty as #tn::schema::Schema>::schema(),
              doc: #doc,
              view: #view,
            });
          });
        }
        quote! {
          let mut fields: Vec<#tn::schema::FieldDesc> = Vec::new();
          #(#pushes)*
          #tn::schema::TypeDesc::Record { name: #type_name.to_string(), fields }
        }
      }
      // A newtype is its inner value on the wire (serde's newtype rule).
      Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
        let ty = &fields.unnamed.first().expect("one field").ty;
        quote! { <#ty as #tn::schema::Schema>::schema() }
      }
      Fields::Unnamed(_) => {
        return Err(syn::Error::new_spanned(
          &data.fields,
          "Schema derive supports tuple structs with exactly one field",
        ));
      }
      Fields::Unit => quote! {
        #tn::schema::TypeDesc::Record { name: #type_name.to_string(), fields: Vec::new() }
      },
    },
    Data::Enum(data) => {
      let fieldless = data
        .variants
        .iter()
        .all(|v| matches!(v.fields, Fields::Unit));
      let mut cases = Vec::new();
      let mut views = Vec::new();
      for variant in &data.variants {
        let view = ViewAttrs::parse(&variant.attrs, ViewSite::Case)?;
        if !fieldless && !view.is_empty() {
          return Err(syn::Error::new_spanned(
            variant,
            "view label/style apply to the cases of a fieldless enum",
          ));
        }
        if serde_skips(&variant.attrs)? {
          continue;
        }
        let case_name = match serde_rename(&variant.attrs)? {
          Some(rename) => rename,
          None => container.apply_rename_all(&variant.ident.to_string()),
        };
        if fieldless {
          if !view.is_empty() {
            let label = option_str(view.label.clone());
            let style = option_str(view.style.clone());
            views.push(quote! {
              #tn::schema::CaseView { case: #case_name.to_string(), label: #label, style: #style }
            });
          }
          cases.push(quote! { #case_name.to_string() });
          continue;
        }
        let doc = option_str(doc_comment(&variant.attrs));
        let ty = match &variant.fields {
          Fields::Unit => quote! { None },
          Fields::Unnamed(f) if f.unnamed.len() == 1 => {
            let ty = &f.unnamed.first().expect("one field").ty;
            quote! { Some(<#ty as #tn::schema::Schema>::schema()) }
          }
          Fields::Named(f) => {
            let mut pushes = Vec::new();
            for field in &f.named {
              if serde_skips(&field.attrs)? {
                continue;
              }
              let ident = field.ident.as_ref().expect("named field");
              let fname = serde_rename(&field.attrs)?.unwrap_or_else(|| ident.to_string());
              let fty = &field.ty;
              let fdoc = option_str(doc_comment(&field.attrs));
              let view = ViewAttrs::parse(&field.attrs, ViewSite::Field)?.to_tokens(&tn);
              pushes.push(quote! {
                fields.push(#tn::schema::FieldDesc {
                  name: #fname.to_string(),
                  ty: <#fty as #tn::schema::Schema>::schema(),
                  doc: #fdoc,
                  view: #view,
                });
              });
            }
            quote! {{
              let mut fields: Vec<#tn::schema::FieldDesc> = Vec::new();
              #(#pushes)*
              Some(#tn::schema::TypeDesc::Record { name: #case_name.to_string(), fields })
            }}
          }
          Fields::Unnamed(_) => {
            return Err(syn::Error::new_spanned(
              variant,
              "Schema derive supports enum cases with at most one unnamed field",
            ));
          }
        };
        cases.push(quote! {
          #tn::schema::CaseDesc { name: #case_name.to_string(), ty: #ty, doc: #doc }
        });
      }
      if fieldless {
        quote! {
          #tn::schema::TypeDesc::Enum {
            name: #type_name.to_string(),
            cases: vec![#(#cases),*],
            views: vec![#(#views),*],
          }
        }
      } else {
        quote! { #tn::schema::TypeDesc::Variant { name: #type_name.to_string(), cases: vec![#(#cases),*] } }
      }
    }
    Data::Union(_) => {
      return Err(syn::Error::new_spanned(
        input,
        "Schema derive does not support unions",
      ));
    }
  };

  Ok(quote! {
    impl #impl_generics #tn::schema::Schema for #name #ty_generics #where_clause {
      fn schema() -> #tn::schema::TypeDesc {
        #body
      }
    }
  })
}

fn option_str(s: Option<String>) -> TokenStream2 {
  match s {
    Some(s) => quote! { Some(#s.to_string()) },
    None => quote! { None },
  }
}

/// `#[serde(skip)]` / `#[serde(skip_serializing)]`: absent from the data.
fn serde_skips(attrs: &[Attribute]) -> syn::Result<bool> {
  Ok(serde_flag(attrs, "skip")? || serde_flag(attrs, "skip_serializing")?)
}

/// Is the bare serde flag `name` present (`#[serde(flatten)]`)?
fn serde_flag(attrs: &[Attribute], name: &str) -> syn::Result<bool> {
  let mut found = false;
  for attr in attrs.iter().filter(|a| a.path().is_ident("serde")) {
    attr.parse_nested_meta(|meta| {
      if meta.path.is_ident(name) && !meta.input.peek(Token![=]) {
        found = true;
        Ok(())
      } else {
        consume_serde_meta_value(meta)
      }
    })?;
  }
  Ok(found)
}

/// The container's serde naming: `rename` and `rename_all`.
#[derive(Default)]
struct ContainerAttrs {
  rename: Option<String>,
  rename_all: Option<String>,
}

impl ContainerAttrs {
  fn parse(attrs: &[Attribute]) -> syn::Result<Self> {
    let mut out = ContainerAttrs::default();
    for attr in attrs.iter().filter(|a| a.path().is_ident("serde")) {
      attr.parse_nested_meta(|meta| {
        if meta.path.is_ident("rename") && meta.input.peek(Token![=]) {
          out.rename = Some(meta.value()?.parse::<LitStr>()?.value());
          Ok(())
        } else if meta.path.is_ident("rename_all") && meta.input.peek(Token![=]) {
          out.rename_all = Some(meta.value()?.parse::<LitStr>()?.value());
          Ok(())
        } else {
          consume_serde_meta_value(meta)
        }
      })?;
    }
    Ok(out)
  }

  fn apply_rename_all(&self, ident: &str) -> String {
    match self.rename_all.as_deref() {
      Some(rule) => rename_rule(rule, ident),
      None => ident.to_string(),
    }
  }
}

/// serde's `rename_all` rules, applied to a field (snake_case) or variant
/// (PascalCase) ident.
pub(crate) fn rename_rule(rule: &str, ident: &str) -> String {
  // Split into lowercase words from either snake_case or PascalCase.
  let mut words: Vec<String> = Vec::new();
  let mut current = String::new();
  for c in ident.chars() {
    if c == '_' {
      if !current.is_empty() {
        words.push(std::mem::take(&mut current));
      }
    } else if c.is_uppercase() && !current.is_empty() {
      words.push(std::mem::take(&mut current));
      current.extend(c.to_lowercase());
    } else {
      current.extend(c.to_lowercase());
    }
  }
  if !current.is_empty() {
    words.push(current);
  }
  let capitalize = |w: &str| {
    let mut chars = w.chars();
    match chars.next() {
      Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
      None => String::new(),
    }
  };
  match rule {
    "lowercase" => words.concat(),
    "UPPERCASE" => words.concat().to_uppercase(),
    "snake_case" => words.join("_"),
    "SCREAMING_SNAKE_CASE" => words.join("_").to_uppercase(),
    "kebab-case" => words.join("-"),
    "SCREAMING-KEBAB-CASE" => words.join("-").to_uppercase(),
    "PascalCase" => words.iter().map(|w| capitalize(w)).collect(),
    "camelCase" => words
      .iter()
      .enumerate()
      .map(|(i, w)| if i == 0 { w.clone() } else { capitalize(w) })
      .collect(),
    _ => ident.to_string(),
  }
}

/// A field's `#[view(header = "…", align = left|right, format = bytes|…,
/// skip, section = "…", style = "…")]`, or a fieldless enum case's
/// `#[view(label = "…", style = "…")]`.
#[derive(Default, Debug, PartialEq)]
pub(crate) struct ViewAttrs {
  pub header: Option<String>,
  pub align: Option<String>,
  pub format: Option<String>,
  pub skip: bool,
  pub section: Option<String>,
  /// A legacy style name (`bold`, `dimmed`) or a theme role (`status.ok`).
  pub style: Option<String>,
  /// A case's on-screen text in place of its serde name.
  pub label: Option<String>,
}

/// Where a `#[view]` sits: a record field, or a case of a fieldless enum.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ViewSite {
  Field,
  Case,
}

/// A non-empty `key = "string"` value.
fn non_empty_str(meta: &syn::meta::ParseNestedMeta<'_>, key: &str) -> syn::Result<String> {
  let value = meta.value()?.parse::<LitStr>()?.value();
  if value.trim().is_empty() {
    return Err(meta.error(format!("view {key} must not be empty")));
  }
  Ok(value)
}

/// `format = …` names the renderer accepts, mapped to `CellFormat` names.
fn canonical_format(name: &str) -> Option<&'static str> {
  match name.replace('-', "_").as_str() {
    "text" => Some("text"),
    "bytes" | "size_bytes" => Some("size_bytes"),
    "age" | "age_ms" => Some("age_ms"),
    _ => None,
  }
}

/// A `key = ident` or `key = "string"` value.
fn ident_or_str(meta: &syn::meta::ParseNestedMeta<'_>) -> syn::Result<String> {
  let value = meta.value()?;
  if value.peek(LitStr) {
    Ok(value.parse::<LitStr>()?.value())
  } else {
    Ok(value.parse::<syn::Ident>()?.to_string())
  }
}

impl ViewAttrs {
  pub(crate) fn is_empty(&self) -> bool {
    *self == ViewAttrs::default()
  }

  pub(crate) fn parse(attrs: &[Attribute], site: ViewSite) -> syn::Result<Self> {
    let mut out = ViewAttrs::default();
    for attr in attrs.iter().filter(|a| a.path().is_ident("view")) {
      attr.parse_nested_meta(|meta| {
        if meta.path.is_ident("style") {
          out.style = Some(non_empty_str(&meta, "style")?);
        } else if site == ViewSite::Case {
          if meta.path.is_ident("label") {
            out.label = Some(non_empty_str(&meta, "label")?);
          } else {
            return Err(meta.error(
              "unsupported view attribute on an enum case (expected label or style)",
            ));
          }
        } else if meta.path.is_ident("header") {
          out.header = Some(meta.value()?.parse::<LitStr>()?.value());
        } else if meta.path.is_ident("section") {
          out.section = Some(meta.value()?.parse::<LitStr>()?.value());
        } else if meta.path.is_ident("skip") {
          out.skip = true;
        } else if meta.path.is_ident("align") {
          let align = ident_or_str(&meta)?;
          if align != "left" && align != "right" {
            return Err(meta.error("view align must be `left` or `right`"));
          }
          out.align = Some(align);
        } else if meta.path.is_ident("format") {
          let format = ident_or_str(&meta)?;
          let Some(canonical) = canonical_format(&format) else {
            return Err(meta.error(format!(
              "unknown view format `{format}` (expected text, bytes or age)"
            )));
          };
          out.format = Some(canonical.to_string());
        } else {
          return Err(meta.error(
            "unsupported view attribute (expected header, align, format, skip, section or style)",
          ));
        }
        Ok(())
      })?;
    }
    Ok(out)
  }

  fn to_tokens(&self, tn: &TokenStream2) -> TokenStream2 {
    let header = option_str(self.header.clone());
    let section = option_str(self.section.clone());
    let format = option_str(self.format.clone());
    let align = match self.align.as_deref() {
      Some("left") => quote! { Some(#tn::schema::ViewAlign::Left) },
      Some(_) => quote! { Some(#tn::schema::ViewAlign::Right) },
      None => quote! { None },
    };
    let skip = self.skip;
    let style = option_str(self.style.clone());
    quote! {
      #tn::schema::ViewDesc {
        header: #header, align: #align, format: #format, skip: #skip, section: #section, style: #style,
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rename_rules_match_serde() {
    assert_eq!(rename_rule("kebab-case", "dry_run"), "dry-run");
    assert_eq!(rename_rule("camelCase", "dry_run"), "dryRun");
    assert_eq!(rename_rule("snake_case", "SizeBytes"), "size_bytes");
    assert_eq!(rename_rule("lowercase", "SizeBytes"), "sizebytes");
    assert_eq!(rename_rule("SCREAMING_SNAKE_CASE", "dry_run"), "DRY_RUN");
    assert_eq!(rename_rule("PascalCase", "dry_run"), "DryRun");
  }

  #[test]
  fn view_attrs_parse_and_validate() {
    let field: syn::Field = parse_quote! {
      #[view(header = "SIZE", align = right, format = bytes, section = "Disk", style = "dimmed")]
      size: u64
    };
    let view = ViewAttrs::parse(&field.attrs, ViewSite::Field).unwrap();
    assert_eq!(view.header.as_deref(), Some("SIZE"));
    assert_eq!(view.align.as_deref(), Some("right"));
    assert_eq!(view.format.as_deref(), Some("size_bytes"));
    assert_eq!(view.section.as_deref(), Some("Disk"));
    assert_eq!(view.style.as_deref(), Some("dimmed"));
    let bad: syn::Field = parse_quote! { #[view(format = furlongs)] size: u64 };
    assert!(ViewAttrs::parse(&bad.attrs, ViewSite::Field).is_err());
    let bad: syn::Field = parse_quote! { #[view(colour = "red")] size: u64 };
    assert!(ViewAttrs::parse(&bad.attrs, ViewSite::Field).is_err());
    // A label belongs to an enum case, not a field.
    let bad: syn::Field = parse_quote! { #[view(label = "x")] size: u64 };
    assert!(ViewAttrs::parse(&bad.attrs, ViewSite::Field).is_err());
    let bad: syn::Field = parse_quote! { #[view(style = "")] size: u64 };
    assert!(ViewAttrs::parse(&bad.attrs, ViewSite::Field).is_err());
  }

  #[test]
  fn case_view_attrs_take_label_and_style_only() {
    let case: syn::Variant = parse_quote! {
      #[view(label = "✗ failing", style = "status.error")]
      Failing
    };
    let view = ViewAttrs::parse(&case.attrs, ViewSite::Case).unwrap();
    assert_eq!(view.label.as_deref(), Some("✗ failing"));
    assert_eq!(view.style.as_deref(), Some("status.error"));
    let bad: syn::Variant = parse_quote! { #[view(header = "X")] Failing };
    assert!(ViewAttrs::parse(&bad.attrs, ViewSite::Case).is_err());
    let bad: syn::Variant = parse_quote! { #[view(skip)] Failing };
    assert!(ViewAttrs::parse(&bad.attrs, ViewSite::Case).is_err());
  }

  #[test]
  fn a_case_view_on_a_data_enum_is_refused() {
    let input: DeriveInput = parse_quote! {
      enum Event {
        #[view(label = "moved")]
        Moved(String),
      }
    };
    let err = expand(&input).unwrap_err();
    assert!(err.to_string().contains("fieldless enum"), "{err}");
  }
}
