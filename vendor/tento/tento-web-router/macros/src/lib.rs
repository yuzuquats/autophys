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
  routes_derive::routes_derive(input)
}
