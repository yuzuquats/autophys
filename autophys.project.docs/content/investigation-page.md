# One investigation, one page

Rebuild the operator-approved investigation page after the original implementation
was lost before publication, using the approved mock and four reference captures.
Configuration, sidebar children, onboarding and project setup keep their existing UI.

The waiting page leads with a prose Summary, followed by rounds containing Data,
Fit with residuals, Parameters, Identifiability, Landscape and Proposal (candidates
and reasoning). Details contains the decision, previews, editable settings,
expectation, budgets and provenance. The finished page leads with the verdict and
final parameter uncertainties, then Validate and Ground truth, then newest round
expanded and older rounds collapsed. Details contains results, budget, data and Report.
A measurement row expands its plot inside the round's single Data card. Fit occupies
the left column; Parameters and Identifiability stack at right. Under about 760px
of main-pane width the cards stack. Investigation provenance lives only in Details.
Remove investigation Export and its dedicated action; preserve the host export contract.

## Decisions — agent-chosen, pending operator review

- **INV-1: rounds from existing fit/proposal records.** One fit starts a round;
  proposals ranked at that fit finish its decision trace, using the same atFit and
  trace boundaries mapped in client/wire.ts. No daemon or SDK contract changes.
  Alternative: persist explicit rounds upstream. Reverse by replacing the pure
  grouping adapter; modest UI-only cost, upstream work required for persisted rounds.
- **INV-2: evidence order and outcome lead.** Data → Fit → Parameters →
  Identifiability → Landscape → Proposal. Active/newest round opens first;
  finished investigations lead with their outcome and collapse older rounds.
  Alternative: chronological-only pages. Reverse in page derivation; cheap.
- **INV-3: jump pills stay.** Buttons scroll within the investigation and indicate
  the current section. Alternative: scrolling alone. Reverse in page markup and
  renderer, cheap; legacy anchor handling remains.
- **INV-4: data belongs to rounds.** Measurement rows expand inline in one Data card
  per round; no duplicate standalone measurement cards. Alternative: separate data
  pages. Reverse by restoring the previous selected-view dispatch; moderate UI cost.

Legacy selections remain valid and retain their selected sidebar row. They resolve
to cards on the same investigation page: fit/residuals → Fit, sensitivity →
Identifiability, landscape → Landscape, proposal → its Proposal, validate/truth →
outcome cards, data → Data, measurement → its expanded row. Targeting an older
round opens it. Envelope/frequency/edges remain available as supplemental Fit views.
Details follows the investigation decision/result even through a legacy address;
controller decisions and field edits resolve that same context.

## Validation and scope

Add derivation tests for one/two rounds, running/validated ordering, legacy targets,
single Data cards, no Export and no investigation footer. Run all html tests and
route typechecking from a clean git archive export (vendor is tracked), then build
the release binary and web assets there, run the guided-tour e2e and browser
acceptance at 1440 and 1024. Capture both states and the proposal anchor. Use only
scratch ports 47960–47979; stop owned servers and remove the owned Rust scratch
target. No push or deployment is part of this work.

Task-board CLI on yuzuquats is unavailable: tsh.lona reports "lona: No such file or
directory". Live plan/status fallback is in the workstream's external evidence.
No agent-board or other-thread messages are sent, per the task brief.

## Implementation receipt — 2026-11-04

Implemented on yuzuquats master: 18eaabf (round page, shared Details/action context,
legacy selections), 1463c33 (regressions), b95f1d3 (Report and browser driver),
c6fff39 (chart widths). The final forward fix handles the scroll-clamped final
jump pill. Configuration keeps its shared provenance footer; investigation pages
omit it because Details carries full provenance. Existing sidebar children remain.

The operator narrowed verification to route typechecking and requested immediate
delivery. No further tests, browsers, captures or tour runs are authorized.
Before that change, a clean archive at 1463c33 passed 109 html tests and route
typechecking; the later run found two old assertions expecting no actions where
Report is now retained, corrected without rerunning. Browser acceptance captured
awaiting-1440.png and found final-card jump highlighting when scroll clamps;
fixed by treating the visible final section as current at the bottom. Acceptance
and tour completion are deferred; partial acceptance evidence was retained.

The operator subsequently authorized immediate deployment of the completed SHA
without further tests. No source push was authorized.
