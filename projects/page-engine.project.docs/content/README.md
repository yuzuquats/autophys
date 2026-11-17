# Product manuals use one documentation renderer

Status: the shared reading preset is extracted upstream; this consumer adopts
its committed vendor copy without adding a sibling checkout dependency.

Autophys already renders its manual with std-documentation and static std-code
in html/routes/docs.ts. Signals had introduced a second HTML/CSS renderer.
The operator asked for the same components and an upstream tento library.
The shared preset belongs in tento-docs-js; each product retains its content,
custom figures and surrounding page behavior.

Autophys imports the shared reading tokens, inline signature styles and static
Code view from its vendor copy. Its existing Nord code palette and cookbook
lifecycle remain product choices. Signals uses the same primitives through
the library's manual navigation composition. This migration changes no SDK
or model behavior and does not deploy Autophys.

The source-only build must continue to work from one checkout: both browser
import maps point inside vendor, new library bytes come from a committed
upstream revision, and the complete vendor manifest is re-pinned. Qualification
uses the product's frozen Deno check and bounded vendor replay verifier;
no production publication or source push is authorized by this extraction.


The committed upstream library is `9e0f100e90`; its four files are vendored
byte-for-byte. The frozen cached-only Deno check of html/routes/index.root.ts
passes with the product import map. The bounded vendor verifier passes
reverse/forward patch replay and checks 2447 files against the complete
repin-20261117-docs manifest. Signals's browser tests confirm the shared preset
runs as real Documentation/Code components. Autophys was not deployed.

The rendered-parity correction refreshes the same vendor library from
`1f645c9631d4c46a25302c2403fb9df8bc8aad9f`: full font defaults, Nord code, one continuous
Documentation flow and overlaid copy controls. The prose surface stays light.
The product's explicit dark code setting remains compatible. The complete
vendor manifest is updated in the same commit.
