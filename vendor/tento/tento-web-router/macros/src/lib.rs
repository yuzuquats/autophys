extern crate proc_macro;

use proc_macro::TokenStream;

mod api;
mod render;
mod routes;
mod routes_derive;

#[proc_macro]
pub fn routes(input: TokenStream) -> TokenStream {
  routes::routes(input)
}

#[proc_macro_attribute]
pub fn api(args: TokenStream, input: TokenStream) -> TokenStream {
  api::api(args, input)
}

#[proc_macro_derive(Router, attributes(router))]
pub fn routes_derive(input: TokenStream) -> TokenStream {
  routes_derive::routes_derive(input, false)
}

#[proc_macro]
pub fn next_routes(input: TokenStream) -> TokenStream {
  let body = syn::parse_macro_input!(input as routes::RouterBody);
  let scope = render::RenderScope::new_from_scope(body.scope);
  let router = next_crate();
  let base = &scope.path;
  let definitions = routes_derive::definitions(&scope.flatten(), &router, true);
  quote::quote! {{
    let mut __defs = Vec::new();
    #definitions
    #router::build_scope(#base, __defs)
  }}
  .into()
}

#[proc_macro_attribute]
pub fn next_api(args: TokenStream, input: TokenStream) -> TokenStream {
  api::expand(args, input, next_crate())
}

#[proc_macro_derive(NextRouter, attributes(router))]
pub fn next_router(input: TokenStream) -> TokenStream {
  routes_derive::routes_derive(input, true)
}

fn next_crate() -> proc_macro2::TokenStream {
  use proc_macro_crate::{FoundCrate, crate_name};
  match crate_name("tento-web-next") {
    Ok(FoundCrate::Name(name)) => {
      let name = quote::format_ident!("{name}");
      quote::quote! { ::#name }
    }
    _ => quote::quote! { ::tento_web_next },
  }
}
