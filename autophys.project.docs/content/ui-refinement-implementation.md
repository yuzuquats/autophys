# Scientific UI refinement implementation

The operator authorized delegated implementation on 2026-11-05 and requires before/after screenshots from each implementer. This follows the content/IA review and the correction of the mock rail.

## Scope and ownership

Reuse the incumbent cookbook shell, Rail, RailSection, TreeList, icons, guide lines and component hydration. No rail renderer replacement or shell redesign. Keep New project and Devices icons.

Main implementer owns html/ui/main.ts and new main-summary helper/styles files. Improve the summary's typographic ordering while retaining recorded scientific evidence, plots, tables and provenance. Do not invent a question, uncertainty, objective or missing record.

Details implementer owns html/ui/details.ts and html/client/derive/details.ts plus new experiment-details helper/styles files. An experiment is one expandable card whose list-cell header holds its identity/provenance. Avoid a repeated Review experiment page heading and generic Next: lab scientist instructions. Preserve settings, previews, conditional uncertainty, provenance and existing permission/decision behavior. Approval is distinct from acquisition and measurement acceptance.

Parent owns shared style integration in html/ui/styles.ts, integration review, scoped commits and screenshot presentation. Children must not edit each other's files, shared component hydration, model contracts, rail, routes or styles.ts without a blocking request.

Native/auth sources and src/http.rs attachment work remain untouched during SDK qualification. Do not build Rust, change SDK files, take the deploy slot, push or deploy. Preserve all existing dirty work; no stash/reset/worktrees/branches.

## Acceptance and review artifacts

Each child must capture matched before/after screenshots from real application renderer/components, at desktop and phone widths, and show relevant expanded/collapsed states. Capture before editing. Static mock screenshots do not qualify. A read-only baseline input is allowed solely for comparison; changes are authored only on owner master. Use isolated, read-only data and no live record writes. Report exact source inputs, capture paths and validation limitations.

Run Deno type-checks and relevant rendered interaction checks. Do not claim unrelated tests or live deployment. Parent will assemble the final scoped implementation commits under Project: autophys after reviewing results. Current implementation: complete locally; see implementation records below.

## Main implementation

Main summary now leads with recorded investigation identity, uses larger explanatory type, and places the existing caption after supporting content. Existing lower-card hydrated markup and complete MainModel hashes match across the before/after fixture captures. Existing Rail/TreeList and scientific values are unchanged. Source-renderer evidence: rwc-01 fleet/evidence/autophys-ux-flow/implementation-20261105/main/index.html and validation.json (7 matched states, 14 images at desktop/phone widths). Deno scoped checks, 12 existing renderer tests and rendered disclosure/jump/focus/overflow checks passed. Parent integrated mainSummaryStyles and rechecked Main/styles. This is not deployed. Details completed subsequently; see the closure below.

## Experiment Details implementation and closure

Experiment Details now uses one native disclosure card with an existing hydrated list-cell identity/provenance header. Settings, previews, uncertainty, budget and provenance expand inside; existing authorized decisions/actions remain outside the disclosure. Collapse, summary focus and input focus/caret survive ordinary rerenders; record changes reset the disclosure. Derived metadata identifies the exact record without display-text inference. Invalid committed drafts suppress stale precision and approval; edited previews are labeled as recorded at the proposed settings. Other Details record types retain their presentation.

Matched before/after desktop and phone renderer captures are at rwc-01 fleet/evidence/autophys-ux-flow/implementation-20261105/details/comparison.html; handoff.json and capture-receipt.json record commands and inputs. 27 existing scoped tests and 39 browser capture checks passed. The known unrelated client boundary assertion fails because existing auth context.ts uses fetch(; it is outside these edits. Parent integrated both stylesheet exports, reviewed diffs/captures and passed the combined Main/Details/styles/derivation Deno type-check and scoped diff check. No native builds, shared deployment, source push or live account record writes occurred. Native/auth/http.rs/SDK work was preserved. Current implementation is complete locally and the screenshots are ready for operator review. No scientific objective or missing evidence was fabricated.


## Scoped source publication review — 2026-11-05

The operator requested sink-and-push. The publication includes this page's three
changes plus six earlier same-thread investigation-page commits, identified by
the retained child-task receipt and stable Change-Ids in investigation-page.md.
The earlier renderer is a real prerequisite for the summary refinement. Account,
SDK, deck and other peer drafts remain outside this publication.

Initial independent Codex review (Claude was rate-limited) found save failures
could be hidden by a collapsed experiment. A forward repair keeps the existing
Not saved feedback in an alert beside the decision controls, outside the
disclosure. A derivation-to-markup regression covers refused Approve/Reject,
escaping, notice clearing and unchanged Configuration feedback. Final prefix
identities, checks, review and publication receipts are retained in the linked
fleet/evidence/autophys-ux-flow/implementation-20261105/publication directory.
The current sink request supersedes this workstream's earlier no-push delivery
limit; it does not request another deployment.

The prerequisite review also found absent supplemental-view destinations and
lost acquisition metadata. A forward repair retains a selected missing-data
destination and shows recorded measurement settings, source/upload, missing
samples, noise, columns and consumption links inside each expanded Data row.
Missing settings are explicitly unrecorded rather than copied from defaults.
Regressions exercise empty Frequency/Edges and acquisition facts/escaping.

The final preservation review identified additional facts formerly shown in leaf
Details. Fit cards now retain recorded variant/loss/data; Identifiability retains
recorded condition numbers, including summary-only records; Validate retains
measurement/fit and worst-parameter 2σ relative uncertainty when recorded.
Missing summary-only values remain explicit. Preservation regressions cover both
losses/variants, full and summary-only identifiability, and validation records.


## Approval card constituent disclosures — 2026-11-05

Operator direction: use std-round and keep the card itself open; only constituent
rows may collapse. The card now uses the existing floating std-round component
and a static hydrated list-cell header. Settings, conditional expected result,
decision controls and escaped save errors remain outside disclosures. Preview,
So far and Provenance are independent native disclosure rows. Their open states,
summary focus and field focus/caret survive same-record rerenders; changing the
selected record resets the supporting rows.

UI-approval-rows-1 (agent-chosen, pending operator review): supporting rows start
closed, and decisions follow Expected before supporting material. This exposes
the approval contract in the initial viewport without removing scientific facts.
The alternative is to open Preview initially or place it before the settings,
which gives the drive/response plots earlier space and pushes decisions down.
Reversing this is a small renderer-only ordering/default change; no data or API
migration is involved.

Matched real-component desktop and phone captures, including an open Preview,
are in rwc-01 fleet/evidence/autophys-ux-flow/implementation-20261105/approval-rows/
(comparison.html, validation.json, screenshots/). Owner evidence retains the
before/after bundles and capture entry. Frozen cached typechecks and 32 scoped
Deno tests passed; the renderer test passed again after moving the actions.
Browser checks verified actual std-round/list-cell hydration, independent
synchronous disclosure state, summary focus, caret, record reset, native click,
read-only/invalid approval, draft precision suppression, escaped save failure,
and phone overflow. This is fixture validation, with no live record writes.
The iteration is committed locally; no new source push or deployment requested.


## Single supporting accordion and anchored decisions — 2026-11-05

The operator superseded UI-approval-rows-1: Approve/Reject/Report belong at the
bottom, with one accordion in the middle. Preview, So far and Provenance now
share one Supporting details disclosure. The std-round card fills the existing
Details area. Its identity header and action footer remain stationary while
settings, expected result and supporting evidence scroll between them. Proposal
layout styles are scoped by card presence; generic Details keeps its existing
shell scrolling. No cookbook or rail source changed.

The footer also keeps escaped save failures visible, with long errors locally
scrollable. Same-record rerenders retain middle scroll, accordion state, summary
focus and field caret. Selecting a different record resets middle state.
Frozen cached typechecks and 32 scoped Deno tests passed. Real-component browser
checks cover desktop 1280×800, phone 390×844 and short phone 390×500: footer
position through expansion/scrolling, long errors, read-only/invalid approval,
stale precision suppression, focus/caret, and Configuration scrolling restoration.

Before/after bundles are retained on yuzuquats under
fleet/evidence/autophys-ux-flow/implementation-20261105/approval-footer/.
Matched captures, validation.json and comparison.html are at the same workspace
evidence path on rwc-01. Validation used deterministic fixture data and no live
writes. This iteration is committed locally; no new push or deployment requested.


## Compact approval header — 2026-11-05

Reduced header vertical padding from 12 to 8 px, tightened title/metadata line
heights and set metadata gaps to 2 px. Font sizes, identity, provenance and
status text are preserved. Actual header height is 87 → 70 px at both desktop
1280×800 and phone 390×844. The footer bounds are identical before/after, and the
single supporting accordion remains intact. A longer approved status wraps.
Frozen cached stylesheet typecheck passed; this CSS-only change adds no tests.
Real-component source captures and measurements are retained under
fleet/evidence/autophys-ux-flow/implementation-20261105/approval-header/ on rwc-01;
bundles are at the same path on yuzuquats. Committed locally; no push/deployment.


## Owner consolidation custody — 2026-11-05

UI owner: yuzuquats:/home/james/workspace/autophys master. Active iteration:
independently collapsible approval sections. Hot paths held by this thread are
html/ui/details-experiment.ts, html/ui/details-experiment-styles.ts,
html/ui/render.deno.test.ts and this project page. The existing
html/ui/details.ts state/focus handling is part of the contract; coordinate
before changing it. Consolidation must reconcile legacy hunks against current
owner and wait for custody on overlapping paths. Never replace old files whole.

Read-only inventory: rwc-01 has no Autophys source checkout; only UI evidence.
rwc-dev-01 master has eight candidates without an owner-master SHA or Change-Id
match, plus mixed staged/unstaged/untracked source. This is an identity census,
not proof of patch uniqueness. It includes legacy unified-page commits whose
effects may already have been adapted on owner, so patch review is required.
The full identities and raw dirty inventory are retained on both rwc-01 and
yuzuquats in fleet/evidence/autophys-ux-flow/implementation-20261105/
approval-sections/nonowner-source-inventory.json. No foreign source was adopted
by this UI iteration. No deployment or restart is requested.


## Per-section chevrons — 2026-11-05

Latest operator direction gives each content section its own chevron. The middle
is now one flat accordion with Experiment, Expected, Preview, So far and
Provenance rows, each independently expandable; the outer Supporting details
wrapper is replaced. Additional named sections, such as Waiting for data or
Outlook, use the same row treatment. The compact 70 px header, std-round card and
anchored decision footer remain intact. Save failures stay outside disclosures.

Experiment and Expected start open, supporting sections closed (reversible
agent-chosen defaults, pending operator review). Same-record redraws preserve
explicitly closed rows, independently open rows, summary focus, input caret and
middle scroll; changing records resets defaults. Frozen typechecks and 32 scoped
Deno tests passed. Actual desktop/phone components were checked for native
summary clicks, all-collapsed and mixed states, read-only/invalid decisions,
precision suppression, escaped errors, focus/scroll preservation and footer
position. Bundles are on owner, matched captures/validation/comparison on rwc-01,
under fleet/evidence/autophys-ux-flow/implementation-20261105/approval-sections/.

UI custody release: this iteration is complete in
Change-Id I226863b686ee42fe936fd14ec81631ce. The executor may reconcile against
the committed owner files, preserving these changes and the prior review
history. No foreign source, brand or docs-route changes are included in this
commit. This does not request a deployment, restart or source push.
