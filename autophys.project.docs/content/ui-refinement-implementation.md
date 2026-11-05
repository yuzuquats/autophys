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

Run Deno type-checks and relevant rendered interaction checks. Do not claim unrelated tests or live deployment. Parent will assemble the final scoped implementation commits under Project: autophys after reviewing results. Current implementation: delegated, not yet complete.

## Main implementation

Main summary now leads with recorded investigation identity, uses larger explanatory type, and places the existing caption after supporting content. Existing lower-card hydrated markup and complete MainModel hashes match across the before/after fixture captures. Existing Rail/TreeList and scientific values are unchanged. Source-renderer evidence: rwc-01 fleet/evidence/autophys-ux-flow/implementation-20261105/main/index.html and validation.json (7 matched states, 14 images at desktop/phone widths). Deno scoped checks, 12 existing renderer tests and rendered disclosure/jump/focus/overflow checks passed. Parent integrated mainSummaryStyles and rechecked Main/styles. This is not deployed. Details implementation remains in progress.
