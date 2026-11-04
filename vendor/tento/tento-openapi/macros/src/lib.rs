//! `#[derive(ToSchema)]` for `tento-openapi`. Use it through
//! `tento_openapi::ToSchema`; the crate documents what the derive reads.

use proc_macro::TokenStream;

mod attrs;
mod doc;
mod expand;
mod params;
mod route;

/// Implements `tento_openapi::ToSchema` from the type's `///` docs, its
/// serde attributes and `#[schema(…)]`.
#[proc_macro_derive(ToSchema, attributes(schema))]
pub fn derive_to_schema(input: TokenStream) -> TokenStream {
  let input = syn::parse_macro_input!(input as syn::DeriveInput);
  expand::derive(&input)
    .unwrap_or_else(syn::Error::into_compile_error)
    .into()
}

/// Implements the query/path parameter model from a wire struct.
#[proc_macro_derive(IntoParams, attributes(into_params, param))]
pub fn derive_into_params(input: TokenStream) -> TokenStream {
  let input = syn::parse_macro_input!(input as syn::DeriveInput);
  params::derive(&input)
    .unwrap_or_else(syn::Error::into_compile_error)
    .into()
}

/// Describes an HTTP operation using tento's schema and document model.
#[proc_macro_attribute]
pub fn path(args: TokenStream, input: TokenStream) -> TokenStream {
  let args = syn::parse_macro_input!(args as route::Args);
  let function = syn::parse_macro_input!(input as syn::ItemFn);
  route::expand(args, function)
    .unwrap_or_else(syn::Error::into_compile_error)
    .into()
}

/// A configuration-free document from explicit components and operation hooks.
#[proc_macro_derive(OpenApi, attributes(openapi))]
pub fn derive_openapi(input: TokenStream) -> TokenStream {
  let input = syn::parse_macro_input!(input as syn::DeriveInput);
  doc::derive(&input)
    .unwrap_or_else(syn::Error::into_compile_error)
    .into()
}
