//! `#[derive(Shape)]` on an untagged enum of shape wrappers: one shape per case.
//! A typed value renders through its own case; plain data (all the render
//! boundary holds) renders through the first case whose shape fits its form.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{Data, DeriveInput, Fields, parse_macro_input};

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
  if !input.generics.params.is_empty() {
    return Err(syn::Error::new_spanned(
      &input.generics,
      "Shape derive does not support generic enums",
    ));
  }
  let Data::Enum(data) = &input.data else {
    return Err(syn::Error::new_spanned(
      input,
      "Shape derive supports only an untagged enum of shape wrappers",
    ));
  };
  if !crate::command_arg_derive::has_serde_untagged(&input.attrs) {
    return Err(syn::Error::new_spanned(
      input,
      "Shape derive needs #[serde(untagged)] so each case's data is its wrapper's data",
    ));
  }
  let mut docs = Vec::new();
  let mut renders = Vec::new();
  let mut arms = Vec::new();
  for variant in &data.variants {
    let Fields::Unnamed(fields) = &variant.fields else {
      return Err(syn::Error::new_spanned(
        variant,
        "Shape derive cases must hold exactly one shape wrapper",
      ));
    };
    if fields.unnamed.len() != 1 {
      return Err(syn::Error::new_spanned(
        variant,
        "Shape derive cases must hold exactly one shape wrapper",
      ));
    }
    let ty = &fields.unnamed.first().expect("one field").ty;
    let ident = &variant.ident;
    docs.push(quote! { <#ty as #tn::shape::Shape>::result_doc() });
    renders.push(quote! { .or_else(|| <#ty as #tn::shape::Shape>::render_data(data)) });
    arms.push(quote! { #name::#ident(inner) => #tn::shape::Shape::render(inner) });
  }
  Ok(quote! {
    impl #tn::shape::Shape for #name {
      fn result_doc() -> #tn::shape::ResultDoc {
        #tn::shape::ResultDoc::union(vec![#(#docs),*])
      }
      fn render_data(data: &#tn::json::Value) -> Option<#tn::json::Value> {
        None #(#renders)*
      }
      fn render(&self) -> #tn::json::Value
      where
        Self: #tn::__serde::Serialize,
      {
        match self {
          #(#arms),*
        }
      }
    }
  })
}
