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
