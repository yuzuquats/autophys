# Autophys icon

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
