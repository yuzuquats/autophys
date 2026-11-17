# One documentation surface for product manuals

`tento-docs-js` composes existing `tento-ui-js` components. It owns the
Autophys reading preset, static `std-code` node view, and a light documentation
page with section navigation. Markdown, tables and prose are rendered by
`std-documentation`, never by a second HTML/Markdown implementation.

Product modules keep their content, section IDs and specialized diagrams.
Autophys uses `makeDocumentation()` plus its custom node views; Signals uses
the complete page. The prose surface is light and code uses Autophys's Nord palette by default.
The static Code view retains an explicit light option for other consumers.

```ts
import { mountDocumentation } from "@tento-docs/page";
const cleanup = await mountDocumentation(host, {
  title: "Product SDK",
  sections: [{ id: "quick-start", title: "Quick start",
    markdown: "## Quick start\n\nYour instructions here." }],
});
// Disconnect navigation listeners before retiring the page.
cleanup();
```

Map `@tento-docs/*` to this directory in the product's TypeScript configuration
and `@tento-docs/` in its Deno import map. `@tento-ui/` and `@tento-core/`
resolve through that consumer's usual library graph. Standalone products
vendor committed upstream bytes and pin their provenance rather than import
a mutable sibling checkout.

The browser must be initialized with `@tento-ui/init-core`. Serve the generated
ProseMirror bundle at `/js/prosemirror.min.js`, or configure `InstanceUrl`'s
static base before mounting. Use the host's editor-bundle build/staging flow;
do not copy a stale `dist/` from the source checkout. No CodeMirror asset is
needed: read-only code uses `Code.bind({ rendering: "static" })`.

`makeDocumentation()` installs the shared cap-height scale and inline-signature
style on the real Documentation component. `StaticCodeBlockView(node, theme)`
can be composed with product-specific node views. `mountDocumentation()`
accepts unique section IDs and renders all content in one Documentation
component. Each section begins with exactly one level-two heading; deeper
headings stay within it. Section IDs are assigned to the rendered shadow-tree
headings and deep links settle after the component mutation queue attaches
the view. Its returned function disconnects navigation listeners; remounting a host first cleans up the old mount. Read-only
Code controls overlay the existing Code component without an extra frame,
padding or type scale, and copy source text. JS/TS/JSON examples register a
lightweight stream tokenizer with the same shared syntax palette. Clipboard refusal exposes a selected readonly
source textarea, preserving blank lines exactly.

The package never fetches product content, chooses app routes or controls a
site header. Those remain product integration. Library source lives upstream;
public or production publication is a separate operation.
