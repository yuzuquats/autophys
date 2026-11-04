extern crate proc_macro;

use proc_macro::TokenStream;
use proc_macro2::Span;
use quote::{ToTokens, format_ident, quote};
use syn::{DeriveInput, LitStr, Meta, MetaList, parse_macro_input, parse2};

use crate::{
  render::{FlatItem, RenderScope},
  routes::{HttpMethod, RouterBody},
};

pub fn routes_derive(input: TokenStream) -> TokenStream {
  let input = parse_macro_input!(input as DeriveInput);
  let struct_name = input.ident;

  let routes = input
    .attrs
    .iter()
    .find(|a| a.path().is_ident("router"))
    .expect("#[router{ ... }] must be present");

  let routes_attr: &proc_macro2::TokenStream = match &routes.meta {
    Meta::List(MetaList {
      path: _,
      delimiter: _,
      tokens,
    }) => tokens,
    _ => panic!("couldn't parse"),
  };

  let body = parse2::<RouterBody>(routes_attr.to_token_stream())
    .unwrap_or_else(|e| panic!("Failed to parse input as router body: {:#?}", e));
  let qualified_scope = RenderScope::new_from_scope(body.scope);

  // Flatten routes + mounts (declaration order — actix matches in
  // registration order) for the routes() method.
  let flat_items = qualified_scope.flatten();
  let base_path = qualified_scope.path.value();

  // Generate ordered __defs.push(...) / __defs.extend(...) statements
  let route_definitions: proc_macro2::TokenStream = flat_items
    .iter()
    .map(|item| match item {
      FlatItem::Route(flat) => {
        let path = &flat.full_path;
        let handler_calls: proc_macro2::TokenStream = flat
          .handlers
          .iter()
          .map(|(method, handler)| {
            let method_tokens = match method {
              HttpMethod::Get => quote! { actix_web::http::Method::GET },
              HttpMethod::Post => quote! { actix_web::http::Method::POST },
              HttpMethod::Put => quote! { actix_web::http::Method::PUT },
              HttpMethod::Patch => quote! { actix_web::http::Method::PATCH },
              HttpMethod::Delete => quote! { actix_web::http::Method::DELETE },
            };
            // Generate a closure that creates the route
            let route_call = quote! {
              .route(#method_tokens, || actix_web::web::#method().to(#handler))
            };
            // GET implies HEAD (RFC 9110: HEAD is GET without the body, and
            // actix drops the body from a HEAD response). Without this, every
            // GET-only resource answers 405 to `curl -I` and uptime monitors —
            // registering the same handler under HEAD is what every consumer
            // was hand-wiring around the DSL to get.
            match method {
              HttpMethod::Get => quote! {
                #route_call
                .route(actix_web::http::Method::HEAD, || actix_web::web::head().to(#handler))
              },
              _ => route_call,
            }
          })
          .collect();

        let guard_call = match (&flat.guard, &flat.redirect) {
          // `[guard = X] { … } else { redirect("…") }` → redirect (302) on fail.
          (Some(guard), Some(location)) => quote! { .redirect_guard(#guard, #location) },
          // `[guard = X] { … }` → 404 on fail.
          (Some(guard), None) => quote! { .guard(#guard) },
          _ => quote! {},
        };

        quote! {
          __defs.push(
            tento_web_router::RouteDefinition::new(#path)
              #handler_calls
              #guard_call
          );
        }
      }
      FlatItem::Mount(mount) => {
        let prefix = &mount.prefix;
        let target = &mount.target;
        // An enclosing guard applies to the spliced routes unless they carry
        // their own (inner wins — same precedence as nested guarded scopes).
        let outer_guard_call = match (&mount.guard, &mount.redirect) {
          (Some(guard), Some(location)) => {
            quote! { .outer_redirect_guard(#guard, #location) }
          }
          (Some(guard), None) => quote! { .outer_guard(#guard) },
          _ => quote! {},
        };
        quote! {
          __defs.extend(
            <#target as tento_web_router::Router>::routes()
              .into_iter()
              .map(|__d| __d.prefixed(#prefix) #outer_guard_call),
          );
        }
      }
    })
    .collect();

  // Collect flattened info for OpenAPI
  let mut flattened = vec![];
  qualified_scope.map_resource(&mut |r| {
    let qualified_route = r.qualified_route.clone();

    for (method, handler_path) in &r.handlers {
      let mut path = handler_path.path.clone();
      let last_path_seg = path.segments.last_mut().expect("");
      last_path_seg.ident = format_ident!("__path_{}", last_path_seg.ident);

      flattened.push((method.clone(), qualified_route.clone(), path));
    }
  });

  let native_paths: proc_macro2::TokenStream = flattened
    .iter()
    .map(|(method, pathname, path)| {
      let span = Span::call_site();
      let pathname = LitStr::new(pathname, span);
      let method_tokens = match method {
        HttpMethod::Get => quote! { Get },
        HttpMethod::Post => quote! { Post },
        HttpMethod::Put => quote! { Put },
        HttpMethod::Patch => quote! { Patch },
        HttpMethod::Delete => quote! { Delete },
      };

      quote! {
        __doc.paths.add(#pathname, PathItem::new(#method_tokens, #path::operation()));
      }
    })
    .collect();

  let native_schemas: proc_macro2::TokenStream = flattened
    .iter()
    .map(|(_, _, path)| {
      quote! {
        {
          let mut __path_schemas = tento_web_router::tento_openapi::Components::default();
          #path::schemas(&mut __path_schemas);
          // Legacy hooks append per operation; collecting the vector into the
          // document's map gives the last operation with a name precedence.
          schemas.schemas.extend(__path_schemas.schemas);
        }
      }
    })
    .collect();

  let base_path_lit = LitStr::new(&base_path, Span::call_site());

  // Each mount nests the target router's OpenApi under the mount prefix —
  // verbatim concatenation as route flattening, merging component schemas.
  let apidoc_nests: proc_macro2::TokenStream = flat_items
    .iter()
    .filter_map(|item| match item {
      FlatItem::Route(_) => None,
      FlatItem::Mount(mount) => {
        let prefix = &mount.prefix;
        let target = &mount.target;
        Some(quote! {
          let __doc = __doc.nest(#prefix, <#target as tento_web_router::Router>::apidoc());
        })
      }
    })
    .collect();

  let expanded = quote! {
    impl tento_web_router::Router for #struct_name {
      fn routes() -> Vec<tento_web_router::RouteDefinition> {
        let mut __defs: Vec<tento_web_router::RouteDefinition> = Vec::new();
        #route_definitions
        __defs
      }

      fn service() -> actix_web::Scope {
        tento_web_router::build_scope(#base_path_lit, Self::routes())
      }

      fn apidoc() -> tento_web_router::tento_openapi::OpenApi {
        use tento_web_router::tento_openapi::{Components, OpenApi, PathItem};
        use tento_web_router::tento_openapi::HttpMethod::{Post, Get, Put, Delete, Patch};
        let mut schemas = Components::default();
        #native_schemas
        let mut __doc = OpenApi::new();
        __doc.components = Some(schemas);
        #native_paths
        #apidoc_nests
        __doc
      }
    }
  };

  TokenStream::from(expanded)
}
