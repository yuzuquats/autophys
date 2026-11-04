# Autophys icon

Current selection: R2 Response with the lower dot (operator, 2026-11-04).
The plain mark is served as /brand.svg in the header. The first slide starts
with its title: brand.ts removes its icon container before first paint.
The favicon uses /favicon.svg, including the Lona family's white 32-unit tile,
6-unit corner radius, fine border and soft shadow, inside a 44-unit canvas.
Both are vector-only. The favicon has a local SVG filter; neither asset uses
scripts, fonts, raster images or external references.

Source: workspace lona-family-landings project, autophys/current/build.py.
It retains response_lower/r2_lower_dot.svg and copies the existing Music icon's
background, border and shadow construction. Rebuild in the design workspace;
copy current/mark.svg to html/routes/brand.svg and current/favicon.svg to
html/routes/favicon.svg. These files are app-owned static resources.

Mark SHA-256: e0e561f40ff80cf553b4418964aec2967ef8827af728f62d47cb95fdf7cef74c
Favicon SHA-256: 93c26c889ee8d98b73e7f124ad35febb7513d01b32e21da9bce74fbf19496b45

Validation: retained SVG hashes match the design source; all artwork is vector-only.
The design build reproduces byte-identically and the favicon was inspected at
16/24/32px on light and dark grounds.

Live on 2026-11-04: release 0ce95e8-response-c887327-20261104. UI owner handed
runtime control to this thread after deploying 0ce95e8. The verified resource
transform preserves that native executable and six unaffected web entries;
only brand.svg and the favicon link change, with favicon.svg added. The native
health commit remains 0ce95e8; RESOURCE_TRANSFORM.json records branding source
c887327. Public SVG hashes, browser image decoding and both mounted marks pass.
No additional UI, server, auth or data changes were deployed.
Receipt: workspace/fleet/evidence/lona-family-landings/autophys/response_cutover_20261104/receipt.json.
Future master builds include these committed resources normally.

## Earlier circle integration (superseded artwork)

The retained compact circle replaces the placeholder favicon and pitch mark
and sits beside the header wordmark on landing and workbench views.
The existing back arrow and home link keep their behavior.

The operator selected the plain circle in the icons thread on 2026-11-04 and
asked to apply it to this repository. Source: workspace
artifacts/projects/lona-family-landings.project.docs/content/autophys/current/mark.svg,
recorded in workspace commit d68534a11. html/routes/brand.svg is byte-identical;
SHA-256 581820ac766eb3cdbac8b767aa32042f465a5c75ea5650929a8fe9c5d9162df1.
It contains vector paths and a local gradient, with no scripts, fonts, raster
or external references. Ink remains #171B18; the accent is #5B8EC4 to #8CBDBE.

The 32-unit canvas carries a 7-unit radius, 2.5-unit line weight and equal
2-unit gaps. This is P0, the circular longer-return reference (110 degrees);
the dimple and pressed variations were not retained.

The app-owned brand.ts runs once after synchronous cookbook mount, before the
first paint. It places decorative 32px header and 40px pitch images. The parent
link retains its accessible name. The favicon references the same static SVG,
so the package has one artwork source and no duplicated embedded data URL.
The vendored cookbook is unchanged.

Coordination: autophys/ui authorized one side-effect import after landingDocs;
its dirty project-setup and status hunks remain owned by that thread.
Validation: Deno type checking and formatting pass for brand.ts; the installed
owner compiler builds the current web source successfully. A temporary loopback
server serves /brand.svg with the retained SHA-256. Browser checks at 1280px and
390px confirm both images load, the header fits without horizontal overflow,
and workbench entry and the brand's back link retain exactly two marks with no
captured navigation errors. The build includes concurrent UI work; its ownership
is separate from this icon integration.

Live favicon verified on 2026-11-04: the concurrent owner release
f3a4869-20261104 includes the committed branding. The public page now links
/brand.svg and the public SVG matches the retained hash above. This thread made
no runtime changes or additional restart. Receipt on rwc-dev-01:
workspace/fleet/evidence/lona-family-landings/autophys/favicon_20261104/receipt.json.
Source publication remains separate.
