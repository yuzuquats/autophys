# One investigation, one page

The workbench keeps the evidence and decision for an investigation in one Main
page. Previously, choosing a fit, sensitivity, proposal or validation replaced
Main and Details with a separate view, hiding the evidence needed to decide.
The operator-approved mock is the visual contract:
`fleet/evidence/autophys/investigation-page-20261104/mock.html` on rwc-dev-01.

Awaiting approval: a Summary explains the recorded fit, the ridge and proposed
experiment. Round sections contain Data, Fit with normalized residuals, Parameters,
Identifiability, Landscape and Proposal (the existing Candidates table including
per-candidate after columns, followed by the existing Reasoning stepper). Details
holds previews, settings, expected uncertainty, approval/rejection and the budget.

After an outcome: Summary leads with the recorded verdict and final parameters;
Validate and revealed Ground truth appear together. The latest round is expanded,
and earlier rounds have expandable one-line headers. Details shows final parameters,
budget used, training/held-out data and provenance. Unrecorded values remain gaps;
round timestamps and per-round simulation counts are omitted.

## Scope and implementation

Compose the existing derive section/chart builders and Details proposal builder.
The UI receives a complete investigation body; the client owns grouping, ordering
and address mapping. Legacy child selections keep their public ids and sidebar
rows, and scroll to stable section anchors. Selection of an old round expands it.
The active decision is independent of the selected section, including the controller
handlers for edited settings, approval and rejection. No SDK or daemon contract
changes, sidebar removal, deployment, push, or Configuration/onboarding redesign.

The cookbook cards use std-round, headers use std-list-cell-layout and paired rows
use std-grid-layout. Reasoning still hydrates to the shared vertical Stepper.
Navigation pills track the scroll position. Redraws preserve open rounds and scroll
position for the same investigation; a different legacy selection jumps to its target.
Measurement plots expand inside Data cards to keep the overview compact.

## Reversible decisions

All four defaults below are **agent-chosen, pending operator review**. The operator
approved the overall mock, and did not confirm these individual defaults.

- **INV-1 — round boundaries.** Before: independent fit/proposal nodes. After: fits
  through the next proposal are a round, using existing atFit links and proposal order,
  matching the proposal reasoning intervals in wire.ts. Re-ranking the same fit stays
  in its round; fits after the last proposal form the open round. Alternative: one round
  per fit. Change `investigationRounds` and grouping tests; cheap, no data migration.
- **INV-2 — reading order.** Data → Fit/Parameters → Identifiability/Landscape →
  Proposal. Latest/open round first; completed investigations lead with their outcome
  and collapse earlier rounds. Alternative: chronological rounds or outcome last.
  Reorder the derived rows/rounds and open flags; cheap, no persisted state change.
- **INV-3 — section navigation.** Pills under the toolbar scroll to anchors and mark
  the current section. Alternative: no pills, or a contents menu. Change the derived
  jump list and UI navigation/hydration; cheap. Old node ids stay supported.
- **INV-4 — measurement placement.** Measurements are expandable Data cards in the
  round, with a canonical anchor in the latest round using that measurement; no separate
  measurement page. Alternative: expanded plots or a separate data page. Change the
  Data composition and address resolver; cheap, no record conversion.

## Validation

Required: all html Deno tests and route type checking from a clean git archive of
committed HEAD, plus scratch build screenshots at 1440 and 1024 for awaiting approval
and validated states. Round/legacy-address tests cover grouping, running and finished
ordering, actual rendered anchor destinations, and decision actions from fit/data/root
selections. Run the existing guided-tour acceptance without changing its component
navigation contract. Build/serve under ~/.cache/autophys on an unused 47950–47999
loopback port; stop the server afterward. Evidence and receipts remain at
`fleet/evidence/autophys/investigation-page-20261104/implementation/`.

Implementation and verification are in progress. Task board was not used because
this task explicitly forbids board and other-thread messaging.
