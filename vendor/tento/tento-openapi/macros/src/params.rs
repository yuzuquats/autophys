//! `IntoParams` reads the parameter rules separately from schema fields.
use crate::attrs::{Container, Field, Source};
use proc_macro2::TokenStream;
use quote::quote;
use syn::{Data, DeriveInput, Fields, LitStr, Token};

pub fn derive(input: &DeriveInput) -> syn::Result<TokenStream> {
  let mut location = None;
  let mut names = Vec::new();
  let mut rename = None;
  let mut style = None;
  for attr in input
    .attrs
    .iter()
    .filter(|a| a.path().is_ident("into_params"))
  {
    attr.parse_nested_meta(|meta| {
      if meta.path.is_ident("parameter_in") {
        location = Some(meta.value()?.parse::<syn::Ident>()?);
      } else if meta.path.is_ident("names") {
        let content;
        syn::parenthesized!(content in meta.input);
        names = content
          .parse_terminated(|i| i.parse::<LitStr>(), Token![,])?
          .into_iter()
          .map(|s| s.value())
          .collect();
      } else if meta.path.is_ident("rename_all") {
        let value: LitStr = meta.value()?.parse()?;
        rename = Some(crate::attrs::RenameRule::parse(&value)?);
      } else if meta.path.is_ident("style") {
        let value: syn::Ident = meta.value()?.parse()?;
        style = Some(match value.to_string().as_str() {
          "Matrix" => "matrix",
          "Label" => "label",
          "Form" => "form",
          "Simple" => "simple",
          "SpaceDelimited" => "spaceDelimited",
          "PipeDelimited" => "pipeDelimited",
          "DeepObject" => "deepObject",
          _ => return Err(syn::Error::new_spanned(
            value,
            "tento-openapi: unsupported parameter style; expected Matrix, Label, Form, Simple, SpaceDelimited, PipeDelimited or DeepObject",
          )),
        });
      } else {
        return Err(meta.error("tento-openapi: unsupported into_params attribute"));
      }
      Ok(())
    })?;
  }
  let container = Container::parse_variant(&input.attrs)?;
  let fields = match &input.data {
    Data::Struct(s) => &s.fields,
    _ => {
      return Err(syn::Error::new_spanned(
        input,
        "IntoParams requires a struct",
      ));
    }
  };
  if matches!(fields, Fields::Unnamed(_)) && names.len() != fields.len() {
    return Err(syn::Error::new_spanned(
      fields,
      "IntoParams tuple fields require one name each in #[into_params(names(...))]",
    ));
  }
  if matches!(fields, Fields::Named(_)) && !names.is_empty() {
    return Err(syn::Error::new_spanned(
      fields,
      "IntoParams names(...) requires tuple fields",
    ));
  }
  let mut parameters = Vec::new();
  let mut components = Vec::new();
  for (index, field) in fields.iter().enumerate() {
    let mut attrs = field.attrs.clone();
    for attr in &mut attrs {
      if attr.path().is_ident("param") {
        match &mut attr.meta {
          syn::Meta::List(list) => list.path = syn::parse_quote!(schema),
          _ => return Err(syn::Error::new_spanned(attr, "param requires a list")),
        }
      }
    }
    let rules = Field::parse(&attrs, "parameter")?;
    if rules.skip {
      continue;
    }
    let raw = field
      .ident
      .as_ref()
      .map(|i| i.to_string())
      .unwrap_or_else(|| names[index].clone());
    let raw = raw.strip_prefix("r#").unwrap_or(&raw);
    let name = rules
      .rename
      .clone()
      .or(rules.schema_rename.clone())
      .unwrap_or_else(|| {
        container
          .rename_all
          .or(rename)
          .map(|r| r.apply_to_field(raw))
          .unwrap_or_else(|| raw.to_owned())
      });
    let location = location
      .as_ref()
      .map(|l| quote! { ::tento_openapi::ParameterIn::#l });
    let is_query = location
      .as_ref()
      .is_some_and(|l| l.to_string().ends_with("Query"));
    let location = location
      .unwrap_or_else(|| quote! { __provider().unwrap_or(::tento_openapi::ParameterIn::Path) });
    let docs = rules.docs.as_deref().unwrap_or("");
    let inline = rules.inline;
    let nullable = match rules.nullable {
      Some(b) => quote! { Some(#b) },
      None if is_query => quote! { Some(false) },
      None => quote! { None },
    };
    let required = rules.required.map(|r| quote! { #r }).unwrap_or_else(|| {
      if rules.default || rules.skip_serializing_if || container.default {
        quote! { false }
      } else {
        match rules.source(&field.ty) {
          Source::Type(ty) => quote! { !<#ty as ::tento_openapi::ToSchema>::is_option() },
          Source::With(_) => quote! { true },
        }
      }
    });
    let (schema, register) = match rules.source(&field.ty) {
      Source::Type(ty) => (
        quote! { <#ty as ::tento_openapi::ToSchema>::at_site(&::tento_openapi::Site { inline: #inline, nullable: #nullable, ..Default::default() }) },
        quote! { ::tento_openapi::register::<#ty>(__c); },
      ),
      Source::With(path) => (quote! { #path().into() }, quote! {}),
    };
    components.push(register);
    let deprecated = rules.deprecated;
    let param_style = style
      .as_ref()
      .map(|s| quote! { __p.extra.insert("style".into(), ::tento_openapi::__private::json!(#s)); });
    parameters.push(quote! {
      let mut __p = ::tento_openapi::Parameter {
        name: #name.into(), parameter_in: Some(#location),
        required: Some(if #required { ::tento_openapi::Required::True } else { ::tento_openapi::Required::False }),
        description: (!#docs.is_empty()).then(|| #docs.into()), schema: Some(#schema), ..Default::default()
      };
      if #deprecated { __p.extra.insert("deprecated".into(), ::tento_openapi::__private::json!(true)); }
      if __p.parameter_in == Some(::tento_openapi::ParameterIn::Path) { __p.required = Some(::tento_openapi::Required::True); }
      #param_style
      __params.push(__p);
    });
  }
  let ident = &input.ident;
  let mut generics = input.generics.clone();
  for param in generics.type_params_mut() {
    param
      .bounds
      .push(syn::parse_quote!(::tento_openapi::ToSchema));
  }
  let (ig, tg, wc) = generics.split_for_impl();
  Ok(quote! {
    impl #ig ::tento_openapi::IntoParams for #ident #tg #wc {
      fn into_params(__provider: impl Fn() -> Option<::tento_openapi::ParameterIn>) -> Vec<::tento_openapi::Parameter> {
        let mut __params = Vec::new(); #(#parameters)* __params
      }
      fn components(__c: &mut ::tento_openapi::Components) { #(#components)* }
    }
  })
}

#[cfg(test)]
mod tests {
  #[test]
  fn unknown_parameter_styles_are_rejected() {
    for style in ["Unknown", "deepObject", "form"] {
      let input: syn::DeriveInput = syn::parse_str(&format!(
        "#[into_params(style = {style})] struct Query {{ value: String }}"
      ))
      .unwrap();
      let error = super::derive(&input).unwrap_err();
      assert!(error.to_string().contains("unsupported parameter style"));
    }
  }
}
