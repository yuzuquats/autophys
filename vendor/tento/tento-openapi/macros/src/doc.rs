//! Component-only and explicit-path documents, as used by the generators.
use proc_macro2::TokenStream;
use quote::{format_ident, quote};
use syn::{DeriveInput, Token, Type};
pub fn derive(input: &DeriveInput) -> syn::Result<TokenStream> {
  let mut schemas = Vec::new();
  let mut paths: Vec<syn::Path> = Vec::new();
  for attr in input.attrs.iter().filter(|a| a.path().is_ident("openapi")) {
    attr.parse_nested_meta(|meta| {
      if meta.path.is_ident("components") {
        let c;
        syn::parenthesized!(c in meta.input);
        let key: syn::Ident = c.parse()?;
        if key != "schemas" {
          return Err(syn::Error::new_spanned(key, "expected schemas"));
        }
        let list;
        syn::parenthesized!(list in c);
        schemas.extend(list.parse_terminated(|i| i.parse::<Type>(), Token![,])?);
        if !c.is_empty() {
          return Err(c.error("unsupported component kind"));
        }
      } else if meta.path.is_ident("paths") {
        let list;
        syn::parenthesized!(list in meta.input);
        paths.extend(list.parse_terminated(|i| i.parse::<syn::Path>(), Token![,])?);
      } else {
        return Err(meta.error("tento-openapi: unsupported openapi attribute"));
      }
      Ok(())
    })?;
  }
  let ident = &input.ident;
  let tags: Vec<_> = paths
    .iter()
    .map(|p| {
      p.segments
        .iter()
        .take(p.segments.len() - 1)
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
    })
    .collect();
  for path in &mut paths {
    let last = path.segments.last_mut().unwrap();
    last.ident = format_ident!("__path_{}", last.ident);
  }
  let components = if schemas.is_empty() && paths.is_empty() {
    quote! {}
  } else {
    quote! {
      let mut __c = ::tento_openapi::Components::default();
      #(::tento_openapi::register::<#schemas>(&mut __c);)*
      #(#paths::schemas(&mut __c);)*
      __doc.components = Some(__c);
    }
  };
  Ok(quote! {
    impl #ident {
      pub fn openapi() -> ::tento_openapi::OpenApi {
        let mut __doc = ::tento_openapi::OpenApi::new();
        __doc.info.title = env!("CARGO_PKG_NAME").into();
        __doc.info.version = env!("CARGO_PKG_VERSION").into();
        __doc.info.description = Some(env!("CARGO_PKG_DESCRIPTION").into());
        __doc.info.extra.insert("license".into(), ::tento_openapi::__private::json!({ "name": env!("CARGO_PKG_LICENSE") }));
        #components
        #({
          let mut operation = #paths::operation();
          if !#tags.is_empty() && !operation.extra.contains_key("tags") {
            operation.extra.insert("tags".into(), ::tento_openapi::__private::json!([#tags]));
          }
          __doc.paths.add(#paths::path(), ::tento_openapi::PathItem::new(#paths::method(), operation));
        })*
        __doc
      }
    }
  })
}
