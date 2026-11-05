# The drawer should move over a stable workbench

The operator reports that Up/Down in `/app` shifts the content behind the
drawer and makes it disappear and redraw. Live Chromium samples on a777ad1
show the main pane shrinking from 708px to 508px over 380ms at 1280×800.
Tour exit additionally marks every region hidden, then fades it back in.
Closing the landing clears main readiness before the covering surface arrives.

Keep the main pane at its viewport height, leaving the deck to cover its lower
200px. Keep the outgoing workbench painted while the deck returns. Deferred
restoration retains its old content until replacement can paint atomically,
without a separate hide/reveal animation. The demo/user controller switch and
existing tutorial interactions remain intact. App teardown still occurs only
after the landing covers it; no new background service or polling lifecycle.

These changes are scoped to this Autophys vendored cookbook and its app-owned
content transition, on yuzuquats master, preserving the deployed a777ad1 worker
and surface-depth fixes. The committed vendor tree is authoritative during the
rwc-dev-01 outage; retain the patch in subsequent vendor reconstruction.

DM-1 — **agent-chosen, pending operator review**: a tutorial covers the existing
full-height workbench rather than shrinking it. This prevents chart/container
resizes on every toggle. The strongest alternative reserves a shorter viewport
for the tutorial, preserving a visible footer at the cost of relayout. Reversal
is a small CSS change. Scroll padding must still allow lesson targets to clear
the covering sheet.

Validate actual Up/Down, settled and interrupted returns, tour navigation,
main height/opacity samples and phone layout. Type-check changed entry points,
run the existing HTML suite and package/deployment gates, then verify the live
commit and browser result. Current task: rwc-01:01m6ndqqbat4k6h676w40kepx7.

## Candidate verified, 2026-11-05

The implementation retains the old rendered workspace during deferred restoration,
then replaces it without opacity or translate animations. Main is painted from
opening onward. Closing keeps panel layout, readiness and tour content until the
cover arrives; the app layer becomes inert immediately. Teardown still removes
its DOM and listeners after coverage. App-owned CSS fixes main bottom to zero;
a scroll-tail spacer and scroll padding retain access below the tutorial.

Chromium frame samples of the built candidate at 1280×800 hold main height at
708px in both directions, full opening/closing, rapid reversal and the reduced
motion JS branch. All seven scenarios have zero blank/faded uncovered frames.
At 390×844 the height stays 752px, sheets remain mutually exclusive/inert and
there is no horizontal overflow. The tutorial's intentional demo/user selection
and Details changes remain; this change removes the repeated vertical resizing
and blank/reveal cycle, not those content changes.

Deno entry-point check, web bundle, diff whitespace and the design detector pass;
the HTML suite passes 107/107. Measurements: rwc-01
`fleet/evidence/autophys-drawer/candidate-results.json`; built candidate and
HTML log: yuzuquats `fleet/evidence/hacks-carousel-align/drawer-*`.
