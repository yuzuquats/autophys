# New project wizard polish — 2026-11-04

The built-in wizard keeps units beside field labels, paints its current header
with the same translucent treatment as the sidebar, and focuses the first field
(or enabled primary action) when navigating. A step change returns the wizard
scroll area to its heading so completed rows and the rail remain in view on a
390px phone. Same-step redraws preserve a focused field or wizard action.

This is a refinement of the existing autophys project. The approved plain ✓,
normal completed titles, absent Done meta, and visible divider rail remain.
The vendored stepper is unchanged; its current background uses
`--step-row-current-bg: rgb(0 0 0 / 5%)`.

Acceptance checks: root-route Deno type check, HTML Deno tests, `autophys
build-web`, and `html/e2e/sidebar-flow.ts` against two isolated loopback daemons.
The browser flow checks units, focus after forward/back navigation, visible
keyboard focus, retained completed rows, the header band, and a complete
create/run/approve-or-reject path at desktop and 390px widths.

Results and captures live on rwc-dev-01 under
`~/workspace/fleet/evidence/autophys/wizard-polish-20261104/`; its receipt
identifies the exact archived commit. Deployment uses a clean local clone and
verifies the source identity through `/api/healthz`. No source push is included.
The installed owner-approved lona-console lacks `task`; live plan status is
recorded in the evidence `plan.json` instead of writing SQLite directly.
