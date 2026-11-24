use proc_macro::TokenStream;
use quote::quote;
use syn::{ItemFn, parse_macro_input};

pub fn api(args: TokenStream, input_fn: TokenStream) -> TokenStream {
  expand(args, input_fn, quote! { tento_web_router })
}

pub fn expand(
  args: TokenStream,
  input_fn: TokenStream,
  router: proc_macro2::TokenStream,
) -> TokenStream {
  let args = proc_macro2::TokenStream::from(args);
  let input_fn = parse_macro_input!(input_fn as ItemFn);
  proc_macro::TokenStream::from(quote! {
      #[#router::tento_openapi::path(
          get,
          path = "",
          #args
      )]
      #input_fn
  })
}
