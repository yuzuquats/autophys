# Completed investigations should explain what they established and produced

Status: revision 3, 2026-11-12. Implemented; dev deployment verification in progress.
The current [investigation card mock](investigation-card.mock.html) shows the card
in the project document and on its own. All results and outputs are illustrative.
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
