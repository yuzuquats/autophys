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
