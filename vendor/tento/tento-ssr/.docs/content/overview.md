# tento-ssr

`tento-ssr` is the shared SSR content loader for `.docs` and `.blog`
sources. It gives apps one place to assemble docs navigation, markdown
pages, emitted build artifacts, and route-ready HTML without depending
on yuzu.

## Source containers

Docs live in a hidden `.docs/` directory inside each crate:

```text
tento-ssr/
  .docs/
    toc.json
    content/
      overview.md
```

Blog posts live in folders named `*.blog` and are loaded by the same
source model. For docs the namespace defaults to the crate's directory
name, so `tento-ssr/.docs` becomes the `/docs/tento-ssr` section
(unless `toc.json` overrides the namespace).

## What the crate owns

- `SsrSource` describes one source container.
- `SsrSite` merges sources into pages and docs navigation.
- `DocsRoute` models `/docs`, `/docs/{library}`, and
  `/docs/{library}/{slug}` without tying the crate to a router.
- `DocsRenderConfig` carries host metadata such as site name and URL.
- `DocsTemplate` combines a site and render config behind the crate's
  yuzu-independent template trait.
- `SsrSite::render_docs_route` injects docs metadata, hydration state,
  and rendered markdown into an HTML shell.

Host apps still decide how to register a template handler. A yuzu app
can wrap `DocsRoute::from_docs_params` and `render_docs_route` in its
own `TemplateHandler`, while a different server can adapt the same API
to its own routing layer.

## Build artifacts

Use `SsrSite::emit_docs_artifacts(routes_root)` during a rebuild step
to copy merged docs into `routes/docs/content`. Bundle mode can then
load `routes/docs` as a normal docs source without needing the original
repo layout.
