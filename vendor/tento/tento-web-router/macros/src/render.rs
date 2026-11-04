use crate::routes::FailAction;
use crate::routes::GuardedScope;
use crate::routes::HttpMethod;
use crate::routes::Resource;
use crate::routes::Scope;
use crate::routes::ScopeItem;

use convert_case::{Case, Casing};
use quote::ToTokens;
use quote::quote;
use syn::{ExprPath, LitStr};

/// A flattened route with full path, optional guard, and optional
/// redirect-on-guard-fail location (the `else { redirect("…") }` mode).
pub(crate) struct FlatRoute {
  pub(crate) full_path: String,
  pub(crate) handlers: Vec<(HttpMethod, ExprPath)>,
  pub(crate) guard: Option<ExprPath>,
  pub(crate) redirect: Option<LitStr>,
}

/// A flattened `mount`: the accumulated path prefix at the mount site plus the
/// enclosing guard context (applied to the spliced routes at runtime; inner
/// guards win).
pub(crate) struct FlatMount {
  pub(crate) prefix: String,
  pub(crate) target: ExprPath,
  pub(crate) guard: Option<ExprPath>,
  pub(crate) redirect: Option<LitStr>,
}

/// One flattened item of a router body, in declaration order (order matters:
/// actix matches resources in registration order).
pub(crate) enum FlatItem {
  Route(FlatRoute),
  Mount(FlatMount),
}

pub(crate) struct RenderScope {
  pub(crate) path: LitStr,
  pub(crate) items: Vec<RenderScopeItem>,
}

impl RenderScope {
  pub fn map_resource<F>(&self, f: &mut F)
  where
    F: FnMut(&RenderResource),
  {
    for item in &self.items {
      match item {
        RenderScopeItem::Scope(s) => s.map_resource(f),
        RenderScopeItem::Resource(r) => r.map_resource(f),
        RenderScopeItem::GuardedScope(g) => g.map_resource(f),
        RenderScopeItem::Mount(_) => {} // no resources of its own
      }
    }
  }

  pub fn new_from_scope(s: Scope) -> RenderScope {
    let mut path_so_far = vec![];
    RenderScope::new_from_scope_helper(s, &mut path_so_far, None)
  }

  fn new_from_scope_helper(
    s: Scope,
    path_so_far: &mut Vec<String>,
    _guard: Option<ExprPath>,
  ) -> RenderScope {
    path_so_far.push(s.path.value());
    let rs = RenderScope {
      path: s.path,
      items: s
        .items
        .into_iter()
        .map(|i| RenderScopeItem::new_from_item(i, path_so_far, None))
        .collect(),
    };
    path_so_far.pop();
    rs
  }

  /// Flatten this scope into declaration-ordered items: routes plus mounts.
  pub fn flatten(&self) -> Vec<FlatItem> {
    let mut result = Vec::new();
    self.flatten_into(&mut result, &self.path.value(), None, None);
    result
  }

  fn flatten_into(
    &self,
    result: &mut Vec<FlatItem>,
    prefix: &str,
    guard: Option<&ExprPath>,
    redirect: Option<&LitStr>,
  ) {
    for item in &self.items {
      match item {
        RenderScopeItem::Scope(s) => {
          let new_prefix = format!("{}{}", prefix, s.path.value());
          s.flatten_into(result, &new_prefix, guard, redirect);
        }
        RenderScopeItem::Resource(r) => {
          r.flatten_into(result, prefix, guard, redirect);
        }
        RenderScopeItem::GuardedScope(g) => {
          g.flatten_into(result, prefix, guard, redirect);
        }
        RenderScopeItem::Mount(m) => {
          result.push(FlatItem::Mount(FlatMount {
            prefix: prefix.to_string(),
            target: m.target.clone(),
            guard: guard.cloned(),
            redirect: redirect.cloned(),
          }));
        }
      }
    }
  }
}

impl ToTokens for RenderScope {
  fn to_tokens(&self, tokens: &mut proc_macro2::TokenStream) {
    let RenderScope { path, items } = self;
    let nested_items = items.iter().map(|item| {
      quote! { .service(#item) }
    });
    tokens.extend(quote! {
      actix_web::web::scope(#path)
        #(#nested_items)*
    });
  }
}

pub enum RenderScopeItem {
  Scope(RenderScope),
  Resource(RenderResource),
  GuardedScope(RenderGuardedScope),
  Mount(RenderMount),
}

impl RenderScopeItem {
  pub fn new_from_item(
    i: ScopeItem,
    path_so_far: &mut Vec<String>,
    guard: Option<ExprPath>,
  ) -> RenderScopeItem {
    match i {
      ScopeItem::Scope(s) => {
        RenderScopeItem::Scope(RenderScope::new_from_scope_helper(s, path_so_far, guard))
      }
      ScopeItem::Resource(r) => {
        RenderScopeItem::Resource(RenderResource::new_from_resource(r, path_so_far, guard))
      }
      ScopeItem::GuardedScope(g) => {
        RenderScopeItem::GuardedScope(RenderGuardedScope::new_from_guarded(g, path_so_far))
      }
      ScopeItem::Mount(m) => RenderScopeItem::Mount(RenderMount { target: m.target }),
    }
  }
}

impl ToTokens for RenderScopeItem {
  fn to_tokens(&self, tokens: &mut proc_macro2::TokenStream) {
    match self {
      RenderScopeItem::Scope(s) => s.to_tokens(tokens),
      RenderScopeItem::Resource(r) => r.to_tokens(tokens),
      RenderScopeItem::GuardedScope(g) => g.to_tokens(tokens),
      RenderScopeItem::Mount(m) => m.to_tokens(tokens),
    }
  }
}

/// A `mount` node for rendering. Only the flatten path (the derive) supports
/// mounts; the fn-like `routes!` macro renders the actix tree directly and has
/// no splice point, so it rejects them.
pub(crate) struct RenderMount {
  pub(crate) target: ExprPath,
}

impl ToTokens for RenderMount {
  fn to_tokens(&self, tokens: &mut proc_macro2::TokenStream) {
    tokens.extend(
      syn::Error::new_spanned(
        &self.target,
        "`mount` is only supported in #[derive(Router)]",
      )
      .to_compile_error(),
    );
  }
}

/// A guarded scope for rendering.
pub(crate) struct RenderGuardedScope {
  pub(crate) guard: ExprPath,
  pub(crate) items: Vec<RenderScopeItem>,
  pub(crate) else_action: Option<FailAction>,
}

impl RenderGuardedScope {
  pub fn new_from_guarded(g: GuardedScope, path_so_far: &mut Vec<String>) -> RenderGuardedScope {
    let guard = g.guard.clone();
    RenderGuardedScope {
      guard: g.guard.clone(),
      items: g
        .items
        .into_iter()
        .map(|i| RenderScopeItem::new_from_item(i, path_so_far, Some(guard.clone())))
        .collect(),
      else_action: g.else_action,
    }
  }

  pub fn map_resource<F>(&self, f: &mut F)
  where
    F: FnMut(&RenderResource),
  {
    for item in &self.items {
      match item {
        RenderScopeItem::Scope(s) => s.map_resource(f),
        RenderScopeItem::Resource(r) => r.map_resource(f),
        RenderScopeItem::GuardedScope(g) => g.map_resource(f),
        RenderScopeItem::Mount(_) => {} // no resources of its own
      }
    }
  }

  fn flatten_into(
    &self,
    result: &mut Vec<FlatItem>,
    prefix: &str,
    _outer_guard: Option<&ExprPath>,
    _outer_redirect: Option<&LitStr>,
  ) {
    // This scope's own guard + fail mode take precedence over any enclosing
    // scope's (inner wins).
    let guard = Some(&self.guard);
    let redirect = match &self.else_action {
      Some(FailAction::Redirect(location)) => Some(location),
      None => None,
    };
    for item in &self.items {
      match item {
        RenderScopeItem::Scope(s) => {
          let new_prefix = format!("{}{}", prefix, s.path.value());
          s.flatten_into(result, &new_prefix, guard, redirect);
        }
        RenderScopeItem::Resource(r) => {
          r.flatten_into(result, prefix, guard, redirect);
        }
        RenderScopeItem::GuardedScope(g) => {
          // Nested guarded scope - inner guard/fail-mode takes precedence
          g.flatten_into(result, prefix, guard, redirect);
        }
        RenderScopeItem::Mount(m) => {
          result.push(FlatItem::Mount(FlatMount {
            prefix: prefix.to_string(),
            target: m.target.clone(),
            guard: guard.cloned(),
            redirect: redirect.cloned(),
          }));
        }
      }
    }
  }
}

impl ToTokens for RenderGuardedScope {
  fn to_tokens(&self, tokens: &mut proc_macro2::TokenStream) {
    // For backward compatibility with the old nested scope approach,
    // we render guarded items inline. The actual guard logic happens
    // in the flattened routes() method.
    for item in &self.items {
      tokens.extend(quote! { .service(#item) });
    }
  }
}

pub(crate) struct RenderResource {
  pub(crate) path: LitStr,
  pub(crate) handlers: Vec<(HttpMethod, ExprPath)>,
  pub(crate) nested: Vec<RenderResource>,
  pub(crate) qualified_route: String,
  pub(crate) guard: Option<ExprPath>,
}

impl RenderResource {
  pub fn map_resource<F>(&self, f: &mut F)
  where
    F: FnMut(&RenderResource),
  {
    f(self);
    for r in &self.nested {
      r.map_resource(f);
    }
  }

  pub fn new_from_resource(
    r: Resource,
    path_so_far: &mut Vec<String>,
    guard: Option<ExprPath>,
  ) -> RenderResource {
    path_so_far.push(r.path.value());

    let rs = RenderResource {
      path: r.path,
      handlers: r
        .handlers
        .into_iter()
        .map(|(method, path)| {
          let qualified_path = path
            .to_owned()
            .unwrap_or_else(|| transform_to_expr_path(path_so_far, &method));
          (method, qualified_path)
        })
        .collect(),
      nested: r
        .nested
        .into_iter()
        .map(|r| RenderResource::new_from_resource(r, path_so_far, guard.clone()))
        .collect(),
      qualified_route: path_so_far.join(""),
      guard,
    };

    path_so_far.pop();

    rs
  }

  fn flatten_into(
    &self,
    result: &mut Vec<FlatItem>,
    prefix: &str,
    guard: Option<&ExprPath>,
    redirect: Option<&LitStr>,
  ) {
    let full_path = format!("{}{}", prefix, self.path.value());

    // Add this resource if it has handlers
    if !self.handlers.is_empty() {
      result.push(FlatItem::Route(FlatRoute {
        full_path: full_path.clone(),
        handlers: self.handlers.clone(),
        guard: self.guard.clone().or_else(|| guard.cloned()),
        redirect: redirect.cloned(),
      }));
    }

    // Recurse into nested resources
    for nested in &self.nested {
      nested.flatten_into(result, &full_path, guard, redirect);
    }
  }
}

impl ToTokens for RenderResource {
  fn to_tokens(&self, tokens: &mut proc_macro2::TokenStream) {
    let RenderResource {
      path,
      handlers,
      nested,
      qualified_route: _,
      guard: _,
    } = self;

    let handler_tokens = handlers.iter().map(|(method, handler)| {
      quote! {
          .route(actix_web::web::#method().to(#handler))
      }
    });

    let nested_tokens = nested.iter().map(|nested_route| {
      quote! {
          .service(#nested_route)
      }
    });

    if !nested.is_empty() {
      if handlers.is_empty() {
        tokens.extend(quote! {
          actix_web::web::scope(#path)
            #(#nested_tokens)*
        });
      } else {
        tokens.extend(quote! {
          actix_web::web::scope(#path)
            .service(
              actix_web::web::resource("")
                #(#handler_tokens)*
            )
            #(#nested_tokens)*
        });
      }
    } else {
      tokens.extend(quote! {
        actix_web::web::resource(#path)
          #(#handler_tokens)*
      });
    }
  }
}

pub fn transform_to_expr_path(vec: &Vec<String>, method: &HttpMethod) -> ExprPath {
  let mut segments: Vec<String> = vec
    .iter()
    .map(|s| {
      let s = s.trim_start_matches('/');
      let is_query_path = s.starts_with("{") && s.ends_with("}");
      let s = s.replace("{", "").replace("}", "").to_case(Case::Snake);
      if is_query_path { format!("__{s}") } else { s }
    })
    // An implicit-""-base router (bare top-level item list) contributes an
    // empty segment; skip it or the joined path would start with `::`.
    .filter(|s| !s.is_empty())
    .collect();

  segments.push(
    match method {
      HttpMethod::Get => "get",
      HttpMethod::Post => "post",
      HttpMethod::Put => "put",
      HttpMethod::Patch => "patch",
      HttpMethod::Delete => "delete",
    }
    .to_string(),
  );
  segments.push("route".to_string());

  syn::parse_str(&segments.join("::")).expect("Route handler is not a path")
}
