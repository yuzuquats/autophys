# Completed investigations should explain what they established and produced

Status: revision 1, 2026-11-12. Interactive concept mocks only; not integrated or
deployed. Open [the mock](investigation-summary.mock.html) to explore three views.
All outcomes, estimates, files and the validation plot in the mock are illustrative.

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

Two independent review attempts returned no final verdict (the retry was
interrupted). No independent approval is claimed. These remain concept mocks
for operator review. The existing dev app and production service are unchanged.
Host layout checks retain their pre-existing findings; this work adds no app,
service, build directory or home entry.
