//! Native operation hooks. Parsing is deliberately limited to the route
//! contract used by tento; unsupported attributes fail at their source span.
use proc_macro2::TokenStream;
use quote::{ToTokens, format_ident, quote};
use syn::{
  Ident, ItemFn, LitStr, Token, Type,
  ext::IdentExt,
  parse::{Parse, ParseStream},
};

#[derive(Default)]
pub struct Args {
  method: Option<Ident>,
  path: Option<LitStr>,
  body: Option<Type>,
  body_content_type: Option<String>,
  body_required: Option<bool>,
  responses: Vec<Response>,
  params: Vec<Param>,
  operation_id: Option<LitStr>,
  summary: Option<LitStr>,
  description: Option<LitStr>,
  tag: Option<LitStr>,
}
struct Response {
  status: String,
  body: Option<Type>,
  description: String,
  content_type: Option<String>,
}
enum Param {
  Struct(Type),
  Named {
    name: String,
    ty: Option<Type>,
    location: Ident,
    description: String,
    required: Option<bool>,
  },
}
fn comma(input: ParseStream) -> syn::Result<()> {
  if !input.is_empty() {
    input.parse::<Token![,]>()?;
  }
  Ok(())
}
impl Parse for Args {
  fn parse(input: ParseStream) -> syn::Result<Self> {
    let mut args = Self::default();
    while !input.is_empty() {
      let key = Ident::parse_any(input)?;
      match key.to_string().as_str() {
        "get" | "put" | "post" | "delete" | "patch" | "head" | "options" | "trace" => {
          args.method = Some(key)
        }
        "path" => {
          input.parse::<Token![=]>()?;
          args.path = Some(input.parse()?);
        }
        "operation_id" => {
          input.parse::<Token![=]>()?;
          args.operation_id = Some(input.parse()?);
        }
        "summary" => {
          input.parse::<Token![=]>()?;
          args.summary = Some(input.parse()?);
        }
        "description" => {
          input.parse::<Token![=]>()?;
          args.description = Some(input.parse()?);
        }
        "tag" => {
          input.parse::<Token![=]>()?;
          args.tag = Some(input.parse()?);
        }
        "request_body" => {
          input.parse::<Token![=]>()?;
          args.body = Some(input.parse()?);
        }
        "responses" => {
          let list;
          syn::parenthesized!(list in input);
          while !list.is_empty() {
            let item;
            syn::parenthesized!(item in list);
            let mut response = Response {
              status: String::new(),
              body: None,
              description: String::new(),
              content_type: None,
            };
            while !item.is_empty() {
              let key = Ident::parse_any(&item)?;
              item.parse::<Token![=]>()?;
              match key.to_string().as_str() {
                "status" => {
                  response.status = if item.peek(LitStr) {
                    item.parse::<LitStr>()?.value()
                  } else if item.peek(syn::LitInt) {
                    item.parse::<syn::LitInt>()?.base10_digits().to_owned()
                  } else {
                    Ident::parse_any(&item)?.to_string()
                  };
                }
                "body" => response.body = Some(item.parse()?),
                "description" => response.description = item.parse::<LitStr>()?.value(),
                "content_type" => response.content_type = Some(item.parse::<LitStr>()?.value()),
                _ => {
                  return Err(syn::Error::new_spanned(
                    key,
                    "tento-openapi: unsupported response attribute",
                  ));
                }
              }
              comma(&item)?;
            }
            if response.status.is_empty() {
              return Err(list.error("response requires status"));
            }
            args.responses.push(response);
            comma(&list)?;
          }
        }
        "params" => {
          let list;
          syn::parenthesized!(list in input);
          while !list.is_empty() {
            if list.peek(syn::token::Paren) {
              let item;
              syn::parenthesized!(item in list);
              let name = item.parse::<LitStr>()?.value();
              let ty = if item.peek(Token![=]) {
                item.parse::<Token![=]>()?;
                Some(item.parse::<Type>()?)
              } else {
                None
              };
              comma(&item)?;
              let location = if item.is_empty() {
                format_ident!("Path")
              } else {
                item.parse::<Ident>()?
              };
              let mut description = String::new();
              let mut required = None;
              comma(&item)?;
              while !item.is_empty() {
                let key = Ident::parse_any(&item)?;
                match key.to_string().as_str() {
                  "description" => {
                    item.parse::<Token![=]>()?;
                    description = item.parse::<LitStr>()?.value();
                  }
                  "required" => {
                    required = Some(if item.peek(Token![=]) {
                      item.parse::<Token![=]>()?;
                      item.parse::<syn::LitBool>()?.value
                    } else {
                      true
                    });
                  }
                  _ => {
                    return Err(syn::Error::new_spanned(
                      key,
                      "tento-openapi: unsupported parameter attribute",
                    ));
                  }
                }
                comma(&item)?;
              }
              args.params.push(Param::Named {
                name,
                ty,
                location,
                description,
                required,
              });
            } else {
              args.params.push(Param::Struct(list.parse()?));
            }
            comma(&list)?;
          }
        }
        _ => {
          return Err(syn::Error::new_spanned(
            key,
            "tento-openapi: unsupported path attribute",
          ));
        }
      }
      comma(input)?;
    }
    Ok(args)
  }
}
fn schema(ty: &Type, components: &mut Vec<TokenStream>) -> TokenStream {
  let ty = crate::attrs::special_types(ty);
  components.push(quote! { ::tento_openapi::register::<#ty>(__c); <#ty as ::tento_openapi::ToSchema>::operation_components(__c); });
  quote! { <#ty as ::tento_openapi::ToSchema>::at_site(&::tento_openapi::Site::default()) }
}
pub fn expand(mut args: Args, function: ItemFn) -> syn::Result<TokenStream> {
  infer_arguments(&mut args, &function);
  let name = &function.sig.ident;
  let hook = format_ident!("__path_{}", name);
  let mut components = Vec::new();
  let operation_id = args
    .operation_id
    .map(|s| s.value())
    .unwrap_or_else(|| name.to_string());
  let docs = crate::attrs::docs(&function.attrs).unwrap_or_default();
  let mut lines = docs.splitn(2, "\n\n");
  let summary = args
    .summary
    .map(|s| s.value())
    .unwrap_or_else(|| lines.next().unwrap_or("").to_owned());
  let description = args
    .description
    .map(|s| s.value())
    .unwrap_or_else(|| lines.next().unwrap_or("").trim().to_owned());
  let method = format_ident!(
    "{}",
    match args
      .method
      .as_ref()
      .map(ToString::to_string)
      .as_deref()
      .unwrap_or("get")
    {
      "get" => "Get",
      "put" => "Put",
      "post" => "Post",
      "delete" => "Delete",
      "patch" => "Patch",
      "head" => "Head",
      "options" => "Options",
      "trace" => "Trace",
      _ => unreachable!(),
    }
  );
  let path = args.path.map(|s| s.value()).unwrap_or_default();
  let mut setup = Vec::new();
  if let Some(body) = &args.body {
    let shape = schema(body, &mut components);
    let content_type = args.body_content_type.clone().unwrap_or_else(|| {
      if is_primitive(body) {
        "text/plain".into()
      } else {
        "application/json".into()
      }
    });
    let required = args.body_required.map(|required| {
      let value = if required {
        quote! { Some(::tento_openapi::Required::True) }
      } else {
        quote! { None }
      };
      quote! { __body.required = #value; }
    });
    setup.push(quote! { let mut __body = ::tento_openapi::__private::request_body::<#body>(#shape, #content_type); #required __op.request_body = Some(__body); });
  }
  for response in args.responses {
    let status = response.status;
    let description = response.description;
    let body = response.body.as_ref().map(|ty| schema(ty, &mut components));
    let content_type = response.content_type.unwrap_or_else(|| {
      if response.body.as_ref().is_some_and(is_primitive) {
        "text/plain".into()
      } else {
        "application/json".into()
      }
    });
    let content = body.map(|body| quote! { __response.content.insert(#content_type.into(), ::tento_openapi::Content { schema: Some(#body), ..Default::default() }); });
    setup.push(quote! {
      let mut __response = ::tento_openapi::Response { description: #description.into(), ..Default::default() };
      #content
      __op.responses.responses.insert(#status.into(), ::tento_openapi::RefOr::T(__response));
    });
  }
  for param in args.params {
    match param {
      Param::Struct(ty) => {
        let location = function
          .sig
          .inputs
          .iter()
          .filter_map(|arg| match arg {
            syn::FnArg::Typed(arg) => Some(arg.ty.as_ref()),
            _ => None,
          })
          .find_map(|arg| {
            for name in ["Query", "Path"] {
              if let Some(inner) = extractor(arg, name)
                && type_key(inner) == type_key(&ty)
              {
                let location = format_ident!("{}", name);
                return Some(quote! { Some(::tento_openapi::ParameterIn::#location) });
              }
            }
            None
          })
          .unwrap_or_else(|| quote! { None });
        setup.push(quote! { __op.parameters.get_or_insert_with(Vec::new).extend(<#ty as ::tento_openapi::IntoParams>::into_params(|| #location)); });
        // Utoipa's IntoParams does not register component schemas in paths.
      }
      Param::Named {
        name,
        ty,
        location,
        description,
        required,
      } => {
        let shape = ty.as_ref().map(|ty| { let _ = schema(ty, &mut components); let query = location == "Query"; quote! { Some(<#ty as ::tento_openapi::ToSchema>::at_site(&::tento_openapi::Site { nullable: if #query { Some(false) } else { None }, ..Default::default() })) } }).unwrap_or_else(|| quote! { None });
        let required = required.map(|b| quote! { #b }).unwrap_or_else(|| match ty {
          Some(ty) => quote! { !<#ty as ::tento_openapi::ToSchema>::is_option() },
          None => quote! { true },
        });
        setup.push(quote! {
          __op.parameters.get_or_insert_with(Vec::new).push(::tento_openapi::__private::parameter(#name, ::tento_openapi::ParameterIn::#location, #description, #required, #shape));
        });
      }
    }
  }
  let tag = args.tag.map(|tag| {
    let tag = tag.value();
    quote! { __op.extra.insert("tags".into(), ::tento_openapi::__private::json!([#tag])); }
  });
  let deprecated = function
    .attrs
    .iter()
    .any(|a| a.path().is_ident("deprecated"));
  Ok(quote! {
    #function
    #[doc(hidden)] #[allow(non_camel_case_types)] pub struct #hook;
    impl #hook {
      pub fn operation() -> ::tento_openapi::Operation {
        let mut __op = ::tento_openapi::Operation {
          operation_id: Some(#operation_id.into()), summary: (!#summary.is_empty()).then(|| #summary.into()),
          description: (!#description.is_empty()).then(|| #description.into()), ..Default::default()
        };
        #tag
        if #deprecated { __op.extra.insert("deprecated".into(), ::tento_openapi::__private::json!(true)); }
        #(#setup)* __op
      }
      pub fn schemas(__c: &mut ::tento_openapi::Components) { #(#components)* }
      pub fn path() -> &'static str { #path }
      pub fn method() -> ::tento_openapi::HttpMethod { ::tento_openapi::HttpMethod::#method }
    }
  })
}

fn is_primitive(ty: &Type) -> bool {
  match ty {
    Type::Path(p) => p.path.segments.last().is_some_and(|s| {
      matches!(
        s.ident.to_string().as_str(),
        "String"
          | "str"
          | "char"
          | "bool"
          | "i8"
          | "i16"
          | "i32"
          | "i64"
          | "i128"
          | "isize"
          | "u8"
          | "u16"
          | "u32"
          | "u64"
          | "u128"
          | "usize"
          | "f32"
          | "f64"
      )
    }),
    Type::Reference(r) => is_primitive(&r.elem),
    _ => false,
  }
}

// The old producers enable actix_extras. Preserve extractor-based request-body
// discovery and the location provider for explicitly listed IntoParams structs.
fn type_key(ty: &Type) -> String {
  match ty {
    Type::Path(p) => p
      .path
      .segments
      .last()
      .map(|s| s.ident.to_string())
      .unwrap_or_default(),
    _ => ty.to_token_stream().to_string(),
  }
}
fn extractor<'a>(ty: &'a Type, name: &str) -> Option<&'a Type> {
  match ty {
    Type::Path(p) => {
      let last = p.path.segments.last()?;
      if let syn::PathArguments::AngleBracketed(args) = &last.arguments {
        let children: Vec<_> = args
          .args
          .iter()
          .filter_map(|a| match a {
            syn::GenericArgument::Type(t) => Some(t),
            _ => None,
          })
          .collect();
        if last.ident == name {
          return children.first().copied();
        }
        return children.into_iter().find_map(|t| extractor(t, name));
      }
      None
    }
    Type::Reference(r) => extractor(&r.elem, name),
    _ => None,
  }
}
fn infer_arguments(args: &mut Args, function: &ItemFn) {
  let inputs: Vec<_> = function
    .sig
    .inputs
    .iter()
    .filter_map(|arg| match arg {
      syn::FnArg::Typed(arg) if !matches!(arg.pat.as_ref(), syn::Pat::Wild(_)) => {
        Some(arg.ty.as_ref())
      }
      _ => None,
    })
    .collect();
  if args.body.is_none() {
    for ty in &inputs {
      for kind in ["Json", "Form"] {
        if let Some(inner) = extractor(ty, kind) {
          let mut inner = inner.clone();
          // actix_extras marks the inferred body optional when an Option is
          // nested in its schema type, including a collection element.
          if has_option(&inner) && type_key(&inner) != "Option" {
            inner = syn::parse_quote!(Option<#inner>);
          }
          args.body_content_type =
            (kind == "Form").then(|| "application/x-www-form-urlencoded".into());
          args.body_required = Some(type_key(ty) != "Option");
          args.body = Some(inner);
          break;
        }
      }
      if args.body.is_some() {
        break;
      }
    }
  }
  let path = args.path.as_ref().map(LitStr::value).unwrap_or_default();
  let names: Vec<_> = path
    .split('{')
    .skip(1)
    .filter_map(|s| s.split('}').next())
    .collect();
  let mut primitives = Vec::new();
  for ty in inputs {
    if let Some(inner) = extractor(ty, "Path") {
      match inner {
        Type::Tuple(t) => primitives.extend(t.elems.iter().cloned()),
        ty if is_primitive(ty) => primitives.push(ty.clone()),
        _ => {}
      }
    }
  }
  for (name, ty) in names.into_iter().zip(primitives) {
    let existing = args
      .params
      .iter_mut()
      .find(|p| matches!(p, Param::Named { name: n, .. } if n == name));
    if let Some(Param::Named { ty: old, .. }) = existing {
      if old.is_none() {
        *old = Some(ty);
      }
    } else {
      args.params.push(Param::Named {
        name: name.into(),
        ty: Some(ty),
        location: format_ident!("Path"),
        description: String::new(),
        required: None,
      });
    }
  }
}
fn has_option(ty: &Type) -> bool {
  match ty {
    Type::Path(p) => p.path.segments.iter().any(|s| {
      s.ident == "Option"
        || match &s.arguments {
          syn::PathArguments::AngleBracketed(a) => a
            .args
            .iter()
            .any(|a| matches!(a, syn::GenericArgument::Type(t) if has_option(t))),
          _ => false,
        }
    }),
    _ => false,
  }
}
