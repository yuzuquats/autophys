# Approval-card identity

The scientist can locate the proposal, inspect the experiment and distinguish
pending, approved and rejected decisions within the existing Details card.
The investigation and proposal form the breadcrumb above the larger title;
the caption uses `var(--text-ter)`. A clipboard with ellipsis, check or cross
communicates review state. Its full status remains available through its native tooltip and an accessible popover (click/tap, Enter/Space;
Escape or outside click dismisses), and to assistive technology. Pending status
changes retain a visually hidden polite live region. Decided cards retain the complete author/time
receipt beside their footer actions. The source fit is a separate provenance
link, rendered as text when its record is missing.

This implements the operator-selected header. Shared std-round, independently
expandable middle rows, stationary actions, scientific content and save errors
remain. Shell, rail, native/auth and runtime are outside this change.

Publication includes the four same-thread card prerequisites, in order:
`Ie2b05d61c7ca4a00956190e0e048eabc`,
`Ic0f68dd5cfdb4393b9671c2d5c2a42a2`,
`I18b54b04aa9b45d5b764d7cb35315e49`,
`I226863b686ee42fe936fd14ec81631ce`.
The original investigation renderer is already public at 8878d612.
Unrelated upper drafts remain local. No deployment belongs to this work.

Validation and independent publication receipts live under
`~/workspace/fleet/evidence/autophys-ux-flow/approval-header-publication-20261106/`
on yuzuquats. Checks use cached-only, frozen owner Deno inputs and cover record
navigation, missing fits, state-specific glyphs, escaping, full decision facts,
legacy view-model compatibility, disclosures and visible save failures.

Initial owner validation: 26 scoped tests passed and the renderer, stylesheet
and derivation passed frozen cached typechecks. Final prefix qualification and
agent review are required before publication.

Phone qualification found that the shell consumes Escape from ordinary buttons
to close the sheet. The review control uses the equivalent native input button,
which the existing shell already treats as owning its keyboard interaction.
Escape now dismisses its native popover while keeping Details open; no shell or
reserved renderer lifecycle changes are required. The decorative SVG is layered
beside the input and excluded from hit testing and the accessibility tree.

Published to https://github.com/yuzuquats/autophys master through c94aa46b.
Final agent review: READY, /root/approval_header_final_r3; exact prefix tree
66b921dca36ea57a1ffa299e8625e87aeb2bb2ec. All 123 HTML tests and frozen
typechecks passed; desktop/phone checks include native popover dismissal,
record navigation, row state, focus/caret and visible refused-write feedback.
Six scoped commits were fast-forward pushed; 104 unrelated commits stayed local.
The full tip tree, shared index and worktree were preserved. No deployment.
See the linked evidence directory for comparison.html and final review, install
and push receipts. This publication receipt is a local documentation follow-up.

## Shared lifecycle cards (2026-11-06)

The operator requested merging the validated, running, proposed and related
Details presentations. Investigation states now use the same std-round card as
proposal review: tertiary breadcrumb above the title, accessible status control,
independently expandable middle rows and stationary actions. Proposal decision
receipts and editing behavior remain specific to their proposal; an investigation
outcome is not an approval decision. Running investigation anchors show progress
instead of an older proposal, while explicit proposal selection retains that
proposal's review.

Validation displays the recorded check, threshold, measurement identity and
available fit/worst-parameter uncertainty, qualifying its scope to those data.
Summary-only checks explicitly lack the worst-parameter record. Existing result,
budget, data and reproducibility facts remain available. Live progress updates
keep the investigation identity, row state and focused summary; refused writes
remain escaped and visible outside all disclosures.

Agent-chosen, pending operator review (LC-01): investigation progress/result/
validation rows start open; budget, data and run rows start closed. This puts
the current scientific result before supporting details in the narrow panel.
The alternative is opening every row, which places more content below the fold.
Reversal is a small change to the shared renderer's supporting-section set;
there is no persisted-data change. Proposal defaults stay as previously selected.

Owner checks: 124 client/UI tests passed, cached/frozen typechecks passed, and
real hydrated renderer fixtures were inspected at 1280×800 and 390×844 for
proposed, approved, rejected, running and validated states. In all five states
at both sizes, no horizontal card overflow was observed and the action footer
stayed stationary while content scrolled. Progress rerender retained the closed
row, DOM identity and keyboard focus; save-error visibility and escaping passed.
Captures are deterministic fixture evidence, not live experimental records.

Before/after captures, comparison.html, source preimages and validation receipts:
`~/workspace/fleet/evidence/autophys-ux-flow/lifecycle-cards-20261106/` on
yuzuquats, with a small acceptance copy on rwc-01. Additive local commit only,
coordinated with productionize's ref custodian; no sink, push, native build or
deployment belongs to this change.
