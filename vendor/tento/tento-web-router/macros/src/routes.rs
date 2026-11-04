use crate::render::RenderScope;

use proc_macro::TokenStream;
use quote::{ToTokens, quote};
use std::fmt::Debug;
use syn::parse::discouraged::Speculative;
use syn::parse::{Parse, ParseStream};
use syn::{ExprPath, LitStr, Token, braced, bracketed, parenthesized, parse2};

mod kw {
  // Contextual keyword: `mount` stays usable as an ident everywhere else.
  syn::custom_keyword!(mount);
}

#[derive(Debug)]
pub(crate) enum ScopeItem {
  Scope(Scope),
  Resource(Resource),
  GuardedScope(GuardedScope),
  Mount(Mount),
}

/// `mount <ExprPath>` — splice another `Router`'s routes in under the
/// accumulated scope path at the mount site (host owns the prefix).
pub(crate) struct Mount {
  pub(crate) target: ExprPath,
}

impl Debug for Mount {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("Mount")
      .field("target", &format_args!("{}", self.target.to_token_stream()))
      .finish()
  }
}

/// Parse one item of a scope body: a guarded scope, a `mount`, or the
/// LitStr-headed Resource/Scope fork. Shared by `Scope`, `GuardedScope`, and
/// the derive's top-level `RouterBody` so all three accept the same grammar.
pub(crate) fn parse_scope_item(input: ParseStream) -> syn::Result<ScopeItem> {
  // Guarded scope: [guard = ...] { ... }
  if input.peek(syn::token::Bracket) {
    return Ok(ScopeItem::GuardedScope(input.parse()?));
  }
  // mount some::Router
  if input.peek(kw::mount) {
    input.parse::<kw::mount>()?;
    let target: ExprPath = input.parse()?;
    if input.peek(Token![,]) {
      input.parse::<Token![,]>()?;
    }
    return Ok(ScopeItem::Mount(Mount { target }));
  }
  // A bare method ident here means handlers were mixed into a block that
  // isn't a plain resource (e.g. next to a `mount`). Without this check the
  // Scope fallback reports a confusing "expected string literal".
  if input.peek(syn::Ident) {
    let ident: syn::Ident = input.fork().parse()?;
    if matches!(
      ident.to_string().as_str(),
      "get" | "post" | "put" | "patch" | "delete"
    ) {
      return Err(syn::Error::new_spanned(
        ident,
        "cannot mix method handlers with `mount` in the same block; put the handlers under \
         their own path resource (e.g. a sibling \"/seg\" { post } block — duplicate segments \
         concatenate)",
      ));
    }
  }
  // Use fork for speculative parsing — Resource and Scope both start
  // with a LitStr + braces, so a failed Resource parse would consume
  // tokens from the stream. Fork lets us backtrack on failure.
  let fork = input.fork();
  if let Ok(route) = fork.parse::<Resource>() {
    input.advance_to(&fork);
    return Ok(ScopeItem::Resource(route));
  }
  Ok(ScopeItem::Scope(input.parse()?))
}

/// Reject a path literal of exactly "/" — flattening joins segments by
/// verbatim concatenation, so a bare "/" silently yields double slashes.
fn check_path_lit(path: &LitStr) -> syn::Result<()> {
  if path.value() == "/" {
    return Err(syn::Error::new_spanned(
      path,
      "path segment must not be a bare \"/\"; use \"\" for an empty segment or \"/name\"",
    ));
  }
  Ok(())
}

/// The terminal action a guarded scope's `else { ... }` branch runs when the
/// guard fails. Today the only action is a 302 redirect; the enum leaves room
/// for more (e.g. an explicit `unauthorized`) without changing the grammar.
#[derive(Clone, Debug)]
pub(crate) enum FailAction {
  /// `else { redirect("/path") }` → 302 to the literal location.
  Redirect(LitStr),
}

/// A scope with an associated guard.
/// Syntax: `[guard = GuardType] { ... }` (guard fails ⇒ 404), or
/// `[guard = GuardType] { ... } else { redirect("/path") }` (guard fails ⇒ 302).
pub(crate) struct GuardedScope {
  pub(crate) guard: ExprPath,
  pub(crate) items: Vec<ScopeItem>,
  pub(crate) else_action: Option<FailAction>,
}

impl Debug for GuardedScope {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("GuardedScope")
      .field("guard", &format_args!("{}", self.guard.to_token_stream()))
      .field("items", &self.items)
      .finish()
  }
}

impl Parse for GuardedScope {
  fn parse(input: ParseStream) -> syn::Result<Self> {
    // Parse [guard = ExprPath]
    let bracket_content;
    let _ = bracketed!(bracket_content in input);

    let ident: syn::Ident = bracket_content.parse()?;
    if ident != "guard" {
      return Err(syn::Error::new_spanned(ident, "Expected `guard`"));
    }

    bracket_content.parse::<Token![=]>()?;
    let guard: ExprPath = bracket_content.parse()?;

    // Parse { ... } contents
    let brace_content;
    let _ = braced!(brace_content in input);

    let mut items = Vec::new();
    while !brace_content.is_empty() {
      items.push(parse_scope_item(&brace_content)?);
    }

    // Optional `else { redirect("/path") }` fail mode. No `else` ⇒ the guard
    // 404s (handled downstream); with `else` it 302s to the location.
    let else_action = if input.peek(Token![else]) {
      input.parse::<Token![else]>()?;
      let else_content;
      let _ = braced!(else_content in input);

      let action: syn::Ident = else_content.parse()?;
      if action != "redirect" {
        return Err(syn::Error::new_spanned(
          action,
          "Expected `redirect(\"/path\")` in the `else` block",
        ));
      }
      let paren_content;
      let _ = parenthesized!(paren_content in else_content);
      let location: LitStr = paren_content.parse()?;

      if !else_content.is_empty() {
        return Err(
          else_content.error("only a single `redirect(\"/path\")` action is supported in `else`"),
        );
      }
      Some(FailAction::Redirect(location))
    } else {
      None
    };

    Ok(GuardedScope {
      guard,
      items,
      else_action,
    })
  }
}

pub(crate) struct Resource {
  pub(crate) path: LitStr,
  pub(crate) handlers: Vec<(HttpMethod, Option<ExprPath>)>,
  pub(crate) nested: Vec<Resource>,
}

impl Debug for Resource {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let mut sb = String::new();
    for handler in &self.handlers {
      sb.push_str(&format!(
        "<{:?}:{}>",
        handler.0,
        handler.1.to_token_stream()
      ));
    }

    f.debug_struct("Route")
      .field("path", &format_args!("{}", self.path.token()))
      .field("handlers", &format_args!("{}", sb))
      .field("nested", &self.nested)
      .finish()
  }
}

impl Parse for Resource {
  fn parse(input: ParseStream) -> syn::Result<Self> {
    let path: LitStr = input.parse()?;
    check_path_lit(&path)?;
    let content;
    let _brace_token = braced!(content in input);

    let mut handlers = Vec::new();
    let mut nested = Vec::new();

    while !content.is_empty() {
      // Check for a LitStr to ensure we're looking at either a handler or a nested route
      if content.peek(LitStr) {
        let nested_route: Resource = content.parse()?;
        nested.push(nested_route);
      } else {
        let method: HttpMethod = content.parse()?;
        if content.peek(Token![:]) {
          content.parse::<Token![:]>()?;
          let handler: ExprPath = content.parse()?;
          handlers.push((method, Some(handler)));
        } else {
          handlers.push((method, None));
        }
      }
      if content.peek(Token![,]) {
        content.parse::<Token![,]>()?;
      }
    }

    Ok(Resource {
      path,
      handlers,
      nested,
    })
  }
}

pub(crate) struct Scope {
  pub(crate) path: LitStr,
  pub(crate) items: Vec<ScopeItem>,
}

impl Debug for Scope {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("Scope")
      .field("path", &format_args!("{}", self.path.token()))
      .field("items", &self.items)
      .finish()
  }
}

impl Parse for Scope {
  fn parse(input: ParseStream) -> syn::Result<Self> {
    let path: LitStr = input.parse()?;
    check_path_lit(&path)?;
    let content;
    let _ = braced!(content in input);
    let mut items = Vec::new();

    while !content.is_empty() {
      items.push(parse_scope_item(&content)?);
    }

    Ok(Scope { path, items })
  }
}

/// The full body of a `#[router { … }]` attribute.
///
/// Back-compat rule: a body that is exactly ONE top-level scope keeps that
/// scope's literal as the `service()` base (every pre-mount consumer). Any
/// other body — a bare list of items, e.g. a mountable plugin router's
/// resources — is wrapped in an implicit `""` base so plugins don't need a
/// `"" { … }` shell.
pub(crate) struct RouterBody {
  pub(crate) scope: Scope,
}

impl Parse for RouterBody {
  fn parse(input: ParseStream) -> syn::Result<Self> {
    let fork = input.fork();
    if let Ok(scope) = fork.parse::<Scope>() {
      if fork.is_empty() {
        input.advance_to(&fork);
        return Ok(RouterBody { scope });
      }
    }

    let mut items = Vec::new();
    while !input.is_empty() {
      items.push(parse_scope_item(input)?);
    }
    Ok(RouterBody {
      scope: Scope {
        path: LitStr::new("", proc_macro2::Span::call_site()),
        items,
      },
    })
  }
}

#[derive(Clone, Debug)]
pub enum HttpMethod {
  Get,
  Post,
  Put,
  Patch,
  Delete,
}

impl Parse for HttpMethod {
  fn parse(input: ParseStream) -> syn::Result<Self> {
    let ident: syn::Ident = input.parse()?;

    match ident.to_string().as_str() {
      "get" => Ok(HttpMethod::Get),
      "post" => Ok(HttpMethod::Post),
      "put" => Ok(HttpMethod::Put),
      "patch" => Ok(HttpMethod::Patch),
      "delete" => Ok(HttpMethod::Delete),
      _ => Err(syn::Error::new_spanned(
        ident,
        "Expected an HTTP method: `get`, `post`, `put`, `patch`, or `delete`",
      )),
    }
  }
}

impl ToTokens for HttpMethod {
  fn to_tokens(&self, tokens: &mut proc_macro2::TokenStream) {
    let method_tokens = match self {
      HttpMethod::Get => quote! { get },
      HttpMethod::Post => quote! { post },
      HttpMethod::Put => quote! { put },
      HttpMethod::Patch => quote! { patch },
      HttpMethod::Delete => quote! { delete },
    };
    method_tokens.to_tokens(tokens);
  }
}

impl std::fmt::Display for HttpMethod {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let method = match self {
      HttpMethod::Get => "Get",
      HttpMethod::Post => "Post",
      HttpMethod::Put => "Put",
      HttpMethod::Patch => "Patch",
      HttpMethod::Delete => "Delete",
    };
    write!(f, "{}", method)
  }
}

/*
  routes! {
    "/api" {
      "/bookings/confirm" { post: api::booking::submit_booking }
      "/events" { get: api::events::get_events }
      "/test" { "/nested" { get: hello::blah }, get: test::get }
    }
  }

  web::scope("/api")
    .service(
      web::resource("/bookings/confirm")
        .route(web::post().to(api::booking::submit_booking)),
    )
    .service(
      web::resource("/events")
        .route(web::get().to(api::events::get_events))
    )
    .service(
      web::scope("/test")
        .service(
          web::resource("")
            .route(web::get().to(test::get))
        )
        .service(
          web::resource("/nested")
            .route(web::get().to(hello::blah))
        )
    )
*/
pub fn routes(input: TokenStream) -> TokenStream {
  let scope =
    parse2::<Scope>(input.into()).unwrap_or_else(|e| panic!("Failed to parse input: {}", e));
  let qualified_scope = RenderScope::new_from_scope(scope);
  qualified_scope.to_token_stream().into()
}
