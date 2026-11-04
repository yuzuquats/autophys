# Docs API

The public docs API is split into source loading, route resolution, and
HTML rendering. The crate stays independent of yuzu; framework adapters
only translate route params into `DocsRoute`.

## Loading docs

```rust
use tento_ssr::{SsrSite, SsrSource};

let sources = vec![
  SsrSource::docs("lona-js/.docs"),
  SsrSource::docs("tento/tento-ssr/.docs"),
];

let site = SsrSite::load(&sources)?;
```

For a docs-only host, `SsrSite::load_docs_roots` is the shorter form:

```rust
let site = SsrSite::load_docs_roots([
  "lona-js/.docs",
  "tento/tento-ssr/.docs",
])?;
```

Use `with_namespace` or `with_title` when the directory name should not
control the public URL section or display title:

```rust
let source = SsrSource::docs("packages/sdk/.docs")
  .with_namespace("sdk")
  .with_title("SDK");
```

## Rendering docs routes

```rust
use tento_ssr::{DocsRenderConfig, DocsRoute};

let config = DocsRenderConfig::new("Example", "https://example.com")
  .with_title_suffix("Example Docs")
  .with_index_description("Documentation for Example libraries.");

let route = DocsRoute::page("tento-ssr", "overview");
let html = site.render_docs_route(base_html, &route, &config);
```

`render_docs_route` returns `None` when a page or library does not
exist. That makes it straightforward for adapters to fall through to a
404 handler.

## Router adapters

Routers that expose params as `HashMap<String, String>` can use
`DocsRoute::from_docs_params`:

```rust
let Some(route) = DocsRoute::from_docs_params(params) else {
  return None;
};

site.render_docs_route(base_html, &route, &config)
```

For adapters that want a single reusable object, use `DocsTemplate`:

```rust
use tento_ssr::{DocsRenderConfig, DocsTemplate, SsrTemplateHandler};

let template = DocsTemplate::new(site, config);

if template.matches(params) {
  return template.render(base_html, params);
}
```

The expected param shapes are:

- `{}` for `/docs`
- `{ "slug": "tento-ssr" }` for `/docs/tento-ssr`
- `{ "library": "tento-ssr", "slug": "overview" }` for
  `/docs/tento-ssr/overview`
