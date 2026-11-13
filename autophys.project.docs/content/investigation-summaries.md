# Completed investigations should explain what they established and produced

Status: revision 7, 2026-11-12. Implemented, verified and deployed at
https://dev--autophys.lona.so.
The current [plain-language card mock](investigation-card-summary.mock.html)
shows the implemented direction using recorded synthetic-cell results. Earlier
concepts contain illustrative reorganizations.
The [earlier summary mock](investigation-summary.mock.html) is retained for comparison.

## A compact card inside the narrative

The operator asked for a clean investigation card, with most prose remaining
in std-documentation. The revised mock uses one proposed insert,
`<ap-investigation investigation="inv_01" />`, for the investigation's title,
completion/outcome state, one-line finding, one evidence line and produced
outputs. Output previews open directly below their links and preserve focus.

The surrounding Markdown carries explanation, interpretation, limitations and
the transition to the next investigation. Opening an investigation shows the
same card above ordinary document sections; it does not create a second bespoke
report interface. The "Card on its own" view shows validated and unresolved
states using exactly the same markup as the contextual view.

**D-SUM-3 — operator-directed simplification; visual treatment agent-chosen,
pending operator review.** Before: several proposed inserts and a detailed
custom report. After: one investigation card and ordinary Markdown around it.
This keeps the evidence easy to scan while agents maintain the explanation in
one familiar format. The strongest alternative is the earlier collection of
separate evidence inserts, which affords richer layouts but increases component
and document complexity. Current state: concept HTML only. Reversal is a small
mock edit; no runtime or persisted API has been adopted.

The earlier proposal and its review below describe revision 1. Revision 2
supersedes its component decomposition, while preserving the distinction
between lifecycle completion and scientific outcome.

## Earlier exploration — revision 1

The operator wants a clear summary of each completed investigation and what it
produced, and suggested registered components inside std-documentation. The
current project Overview explains the overall approach, while the investigation
workbench exposes detailed records. Neither presents a concise project-wide
account of what each completed investigation contributed.

The proposal keeps the living Markdown narrative and embeds evidence that can
be traced to recorded runs. The project overview shows one compact result per
investigation. A full report leads with the conclusion, compares what was known
before and after, shows held-out validation when available, and links the
parameter set, measurements, report or next experiment that the run produced.

## Two levels of summary

```review-flow
flowchart TD
  O[Project narrative] --> A[Compact investigation result]
  A --> R[Full investigation report]
  R --> P[Parameter comparison]
  R --> V[Held-out validation]
  R --> F[Produced outputs]
  F --> S[Source record or artifact]
  class O,A,R,P,V,F new
```

The mock includes an unresolved investigation and a validated follow-up in the
same synthetic battery project. These are illustrative reorganizations, not the
two currently recorded demo investigations. Completion describes the work's
lifecycle; identification and validation describe its scientific result.

| Question | Proposed answer | Reason |
| --- | --- | --- |
| What should lead? | The investigation's conclusion | A reader should understand its contribution before reading its steps. |
| How should each investigation appear in Overview? | A compact summary with outputs and a report link | The project narrative can explain how one result led to another. |
| What belongs in registered components? | Results, parameter comparisons, validation and output links | Structured evidence can point to exact run records. |
| What stays in Markdown? | The explanation, interpretation, limitations and transitions | Agents can maintain ordinary narrative text. |
| What happens when work completes with ambiguity? | Explicit unresolved result and next experiment | Completion must not imply scientific success. |

The mock's expandable component note shows proposed insert names. The actual
renderer supports `Documentation.bind({ markdown, inserts })`; each registration
provides an id, componentName, parsed attributeKeys and nodeView factory. This
does not require an application-level Markdown revision system. The displayed
insert names and attributes are proposals, not an adopted API.

## Choices for review

**D-SUM-1 — agent-chosen, pending operator review.** Add compact investigation
results in the project narrative, with a linked full report per investigation.
Before: the Overview explains the workflow and investigations show their records.
After: readers can scan contributions across completed investigations and open
their evidence. Recommended because it serves both project-level reading and
individual result inspection. The strongest alternative is summaries only at
the top of each investigation; it adds less UI but leaves comparison across
investigations to the reader. Current state: HTML concept only. Reversal is a
small mock edit with no stored-data or runtime impact.

**D-SUM-2 — agent-chosen, pending operator review.** Separate completed lifecycle
from validated, unresolved or failed-validation outcomes. A single green
Complete label is simpler but can imply scientific success. The mock shows
validated and unresolved outcomes; failed validation remains an implementation
state to design. Reversal is a small copy and state-presentation change.

## Next implementation boundary

First, review the mock's information structure. Then wire a demo summary into
the existing document with registered inserts that resolve known record ids.
A real implementation must define stable references and missing-record behavior,
keep historical reports tied to the fits they summarize, and use recorded
uncertainty only when present. Agent generation, persistence and automatic
updates are deferred. Existing production and dev deployments are unchanged.

The mock interactions switch views and preview outputs. Desktop and mobile
renders were inspected; these are visual proposals rather than functioning
scientific reports or real downloadable artifacts.

## Mock verification

At 728px and 390px, all three views render without horizontal page overflow.
The overview's six output previews and each report's three previews open and
close correctly; the validation plot renders and no console exceptions were
observed. The final overview was also inspected at 728px after the typography
correction. The detector identified undersized sidebar text; the 10px text was
raised to 11px. `git diff --check` passes.

The independent concept review found one material interaction issue: an output
preview could open below the viewport and lose keyboard focus. Opening now
focuses and reveals the preview; closing or toggling restores focus and
visibility to the originating link. DOM assertions passed for all 12 outputs
at both 728px and 390px, covering reveal, focus, close and toggle behavior.
The subsequent independent verdict scored this finding resolved, disposition
`ship`, with no regressions found in the changed helper and handler. This
verdict covers the correction; it is not scientific or production validation.
The existing dev app and production service are unchanged.
Host layout checks retain their pre-existing findings; this work adds no app,
service, build directory or home entry.

## Revision 2 verification

Both views and both investigation documents were inspected at 728px and 390px.
All six output previews in each view open, reveal focus, and restore focus to
their links on close. Navigation reaches the corresponding investigation
document. No horizontal overflow or console exceptions were observed. These
checks cover the interactive concept, not a registered runtime component.


## Implementation — revision 3

The operator approved implementation and requested std-card with shadows.
D-SUM-3's compact-card direction is operator-confirmed. The insert uses
`Documentation.bind({ markdown, inserts })` without modifying the shared
renderer. App-owned node views project the card's content into std-card; the
shared card owns its surface and a soft, offset shadow.

Card text is derived from the project's existing investigation records. The
demo contains one completed investigation spanning the initial pulse and pulse
ladder, plus another awaiting approval. The narrative now describes those
actual records rather than the synthetic split in the earlier mocks. The
Markdown references their exact investigation ids. Missing references show an
explicit unavailable state; missing scientific evidence is not filled in.

Outputs navigate to existing fit, measurement, proposal and validation nodes.
There is no separate artifact store or new persisted contract. During evidence
updates the Markdown component remains mounted and its card views refresh.
Ordinary account workspaces still receive no hardcoded document.

Validation: 156 frontend tests pass, including missing identification,
unresolved completion, failed validation and validation tied to an older fit.
The frozen entry-point type check passes. Four browser regression assertions
verify document/insert retention and focus through evidence updates, updated
evidence delivery and remounting when Markdown changes. Deployment and final
render checks follow in the receipt below.

The renderer requires paired tags in authored Markdown, for example
`<ap-investigation investigation="inv_c51194ac2a68ef19"></ap-investigation>`.
Self-closing tags are not supported by its HTML block parser and swallowed
following content in the first deployed check. The source now uses paired
tags. Two additional browser assertions exercise the actual demo Markdown
through std-documentation, verifying both inserts and the following narrative.

## Investigation card dev receipt — preceding deployment

Card implementation: d85c9439011a8800485dc6d6ee07cb96de4dc871
(Change-Id Iad54f277c50d4d1c94c0ef8e403c286d), above d7fcc4a
(Ia6e15be955d34868aee334eb60ac4bc6). Source, native build and web bundle come
from yuzuquats master. No source push.

Release: ~/.local/share/tento/services/autophys-dev/d85c943-card-20261112.
autophys-dev.service remains on 127.0.0.1:4796 with isolated dev books and
server database. Its current symlink selects the release. The previous complete
document release, 9a6ce3f-document-20261112, is retained for rollback; switch
current to it and restart only autophys-dev.service.

The public health endpoint reports d85c943 / version 0.1.5 and the service is
active. The native executable was packed with the web payload; the service's
existing explicit --web-root serves the matching external bundle (so health's
web_id is null). No version bump was introduced by this work.

Verified both cards, paired-tag rendering and following narrative in the deployed
Overview. At 1280×800 and 390×844, all 12 output/open links navigate to the
expected tree records. There is no page or card-content horizontal overflow.
Computed std-card surface shadows are 0 2px 5px at 6% black and 0 8px 22px at
7% black. Both card elements and the document stay mounted across a resize.
The first card shows Complete · validated with recorded held-out χ²/N 1.04;
the second shows Awaiting approval with R1 and C1 unresolved.

The 156-test frontend suite and frozen entry-point check pass. Six focused
browser assertions cover reconciliation/focus and parsing the actual Markdown.
Native release and offline web builds pass. Host layout checks retain the same
pre-existing workspace autophys and home-policy findings.

Production was not restarted: autophys.service remains PID 1747, active since
2026-11-09 05:26:46 PST. No workbook, proposal or experiment was changed during
browser verification.

## Research-note Overview — revision 4

The operator requested a clearer account of the work and its takeaways, styled
as Markdown for a small research paper. The demo Overview now has an abstract,
research question, method, findings, takeaways, work in progress and limitations.
The existing std-documentation typography and std-card inserts remain the
rendering surface; there is no new report layout or persisted contract.

The parameter comparison and held-out statistic were checked against the demo
workspace records. The table omits initial unresolved R1/C1 estimates instead
of presenting them as established values. The completed investigation contains
both pulses; the pending investigation is explicitly not a completed
replication. Synthetic scope and untested temperature, aging and transfer are
explicit, and no uncertainty bounds are invented. The narrative remains a
hardcoded demo asset, not an automatic research report.

The browser parser check now follows the revised headings and final limitation
sentence, retaining coverage for Markdown after both paired insert tags.
Validation: the frozen browser-test type check and diff check pass. Six browser
assertions pass against the actual std-documentation renderer: four cover
reconciliation/focus and two cover both inserts and the following narrative.
Deployment and responsive checks follow in the receipt below.

## Research-note dev receipt — preceding deployment

Deployed source: 08a3745404903126fb8a9719c2937036088f4e39
(Change-Id Id406e67966bb4be0936d1e5e0c216d72), yuzuquats master.
Release: ~/.local/share/tento/services/autophys-dev/08a3745-research-note-20261112.
The current symlink selects it; rollback is the retained d85c943-card-20261112
release, activated by switching current and restarting only autophys-dev.service.
No source push or version bump. Native and offline web builds pass, and the
packed executable and external web root come from the same clean commit.

Public health reports 08a3745 / version 0.1.5. At 1280×800 and 390×844 the
research headings, comparison table, both cards and final limitations render.
The page, document, table and cards have no horizontal overflow. The actual
std-documentation parser and reconciliation checks pass again on the deployed
page (six assertions), and both cards' parameter links reach their matching
record. The frozen browser-test type check and diff check pass. The served
Markdown matches source SHA256:
3944490892f4b1a68334d75286d06b50c01c4498364bff51adabde3d229fb06b.

Before/after host layout checks retain the pre-existing workspace autophys
and home-policy findings. Production was not restarted: autophys.service
remains PID 1747, active since 2026-11-09 05:26:46 PST. No investigation,
proposal or measurement record was changed.

## Card hierarchy variations — revision 5 concepts

The operator requested variations that make each investigation easier to
summarize. [Three card concepts](investigation-card-variations.mock.html) use
the recorded synthetic battery results from the current Overview. They retain
the std-card surface/shadow direction; this self-contained HTML approximates
that surface rather than importing or registering runtime components.

- A leads with a finding, then gives the result, held-out evidence and grouped
  expandable outputs. The original run name becomes secondary identity.
- B compares the short-pulse knowledge with the pulse-ladder result. Pending
  work instead shows the proposed next step without claiming a result.
- C separates what was done, what was found and what was checked.

Both states and all three cards can be inspected together or inside a short
Overview excerpt. Outputs expand locally. Open investigation shows a labeled
record preview; it does not navigate or change a live record. Editorial
headlines are proposed summaries, not newly stored investigation titles.

**D-SUM-4 — agent-chosen recommendation, pending operator review.** Recommend
A's finding-first hierarchy and grouped outputs. Before: the recorded run name
leads and raw output links compete with the finding. Proposed after: the
conclusion leads and the supporting records expand on demand. B is the
strongest alternative when the change in knowledge matters most; it takes more
space and needs a meaningful baseline. Current state: concept only; the live
insert and deployments are unchanged. Reversal is a small HTML/copy edit with
no data contract or migration.

Validation: inspected compare and contextual layouts at 728px and 390px. At
each width, 84 assertions cover all state/view/variant combinations, expanded
outputs, preview focus and focus restoration, and horizontal overflow. No
uncaught errors were reported. The paired contextual mock is intentionally
a single investigation excerpt, not the whole project document. Diff checks
pass; owner workspace/home layout checks retain their existing findings.

## Plain-language summary above B — revision 6 concept

The operator preferred B and requested a clear explanation for a lay reader.
The [refined B mock](investigation-card-summary.mock.html) adds a short narrative
above the before/after comparison: the initial test left slower behavior
uncertain, a follow-up pulse sequence resolved the model settings, and the
updated model passed a check against measurements excluded from fitting.
The pending state explains the proposed test without implying it succeeded.

Technical parameter names, fitted values, dataset ids and the chi-squared
statistic move into a native expandable details section. The default card
retains the plain-language prediction-check result, simulated scope and
Open investigation link to the corresponding dev record. The shadowed
std-card direction remains. This HTML is a design mock; no live insert or
service was changed.

D-SUM-4 update: the operator's preference for B supersedes the agent's
recommendation of A. The requested plain-language summary is now mocked;
its exact copy and final implementation remain for review. Switching copy
or layout is a small concept edit with no persisted-data impact.

Validation: completed and pending cards inspected at 728px and 390px. Six
checks at each width cover state changes retaining keyboard focus, collapsed
and expanded layout without horizontal overflow, and matching record links.
No uncaught errors were reported. Diff check passes. Owner layout checks
retain the pre-existing workspace/home-policy findings.

## Plain-language card implementation — revision 7

The operator approved the refined B card. The registered insert now leads
with a plain-language explanation and a before/after comparison. The existing
std-card owns its soft shadow. A native Technical details & outputs disclosure
contains recorded identification, validation, fitted values and the existing
record-navigation buttons. Open investigation remains directly available.

The demo Markdown authors optional title, summary, before, before-detail,
after, after-detail and scope attributes on the paired investigation insert.
The Markdown therefore remains the editorial source; no battery-specific
explanation is embedded in the renderer or generic evidence derivation. An
insert without authored prose keeps its record-derived summary. The demo
narrative is still hardcoded and requires editorial updates when the scenario
changes; automatic agent editing and narrative persistence remain deferred.
Status, prediction-check outcome, sample counts, parameter values and all
navigation targets remain record-derived. Missing, failed and older checks
stay explicit; unresolved values are not presented as established estimates.

D-SUM-4's B direction is now operator-approved for implementation, with the
plain-language summary requested in revision 6. The choice to author optional
prose as insert attributes is agent-chosen, pending operator review: it keeps
this demo in one Markdown asset. The alternative is a separate structured
narrative map, which is easier to author at scale but splits document content.
Current state: implemented with no server or persisted-data contract change.
Reversal is a small Markdown/renderer edit, preserving the evidence model.

Validation: the frontend suite passes 157 tests; a subsequent numeric-format
regression and the six related evidence tests pass (seven targeted tests).
Frozen entry-point and browser-test type checks and diff checks pass. Fourteen
browser assertions exercise real std-documentation parsing, both card views,
comparison prose, collapsed details, disclosure/focus preservation during
evidence refresh, recorded navigation dispatch and missing references. The
predeployment browser fixture supplies the new fields to the previous dev
snapshot; the same checks will run against deployed derived data below.

The initial deployed mobile check exposed a narrow technical column beside
Open investigation. Expanded details now take the full card width and the
open link moves below them. Closed-card layout remains compact. This is a
CSS-only refinement; browser/record behavior is unchanged. Final verification
and deployment receipt follow below.

## Current plain-language card dev receipt

Deployed source: bd27ce9fec150f5a7dc54a7dad738b66df01b515
(Change-Id I27dd82b75e0444f388d62a394d3a889c), above 450b62a
(Ie351936f105f4e0db3ce33706cfc786a). Source, native release, offline web build
and packed executable come from clean yuzuquats master. No source push or
version bump. Public health reports bd27ce9 / version 0.1.5.

Release: ~/.local/share/tento/services/autophys-dev/bd27ce9-plain-card-20261112.
The current symlink selects it; autophys-dev.service is active on
127.0.0.1:4796. The matching external web root remains explicit, so health's
web_id is null. The pre-work 08a3745-research-note-20261112 release is retained
for rollback by switching current and restarting only autophys-dev.service.

Verified the completed and pending cards in the deployed Overview. At
1280×800 and 390×844 the page, document, comparisons and technical sections
have no horizontal overflow. Expanded details use the full card width
(566px desktop, 288px mobile). Both std-card surfaces retain the requested
soft shadows. All 12 navigation buttons reach their matching tree records
at both widths, including the validation section selected within its
investigation. The browser regression passes all 14 assertions on deployed
derived data. The numeric parameter values preserve significant digits and
unresolved parameters remain explicit. The served Markdown matches source:
b3fbb8f68fab0cfe6c7fe6908c1267a0263283a7a36cb20f1c9b65eb4eeb0a8f.

The frontend suite, targeted evidence/numeric tests, frozen type checks,
diff check and both build steps pass as described above. Before/after owner
workspace and home checks retain their pre-existing policy findings.
Production was not restarted: autophys.service remains PID 1747, active since
2026-11-09 05:26:46 PST. No investigation, proposal or measurement was changed.


## Oscillator and thermal Overview backfill — 2026-11-12

The operator requested subagents to carry the research-note Overview into the
other demo projects. Separate authors added
[oscillator](../../html/routes/demo-overview-oscillator.md) and
[thermal](../../html/routes/demo-overview-thermal.md) Markdown; an independent
reviewer found no content issues against the recorded investigations and
simulator settings. Each note explains the question, method, findings and
limits for a lay reader, with one paired investigation insert summarizing
the initial ambiguity and the informative follow-up test. Completion and
held-out prediction remain distinct; fitted estimates are not uncertainty
bounds. Oscillator validation covers free_neg, while thermal validation
covers the short 5 W step; neither claims general hardware validation.

The demo-only adapter loads an explicit per-project Markdown asset, caches
successful reads and retries failed assets. Loaded documents survive folds
and stream refreshes. Unregistered projects retain their recorded content.
The registry includes jazz_performance_demo -> /demo-overview-jazz.md for
the concurrent Jazz workstream, which owns that asset, its generator and
its separate spec. Assets are requested only for projects in the snapshot;
this registry entry can precede the Jazz workbook safely.

Validation: the full frontend suite passed 160 tests before the Jazz registry
entry; all three loader tests passed again with Jazz included. Frozen route
and browser-test type checks and diff checks pass. The browser regression
was generalized for any number of cards. Against current recorded data,
both new documents passed real std-documentation parsing and card rendering,
following-prose retention, initial collapsed details, focus/disclosure
preservation across evidence updates, output-target dispatch and missing
references (24 assertions including shared reconciliation checks). This is
predeployment rendering, not verification of served oscillator/thermal pages.

Activation coordination: this workstream will not restart dev independently.
After the scoped backfill commit, the Jazz thread receives the shared adapter
and ownership of the single combined dev activation once its workbook is
ready. The activation must include desktop/mobile rendering and record-link
checks for these two Overviews as well as Jazz, and record source/served
matching. Production and source publication remain untouched. The current
dev receipt above remains bd27ce9 until that coordinated activation.

Owner workspace/home checks retain the pre-existing undeclared autophys
workspace entry and home-policy findings; no new root entries were added.
