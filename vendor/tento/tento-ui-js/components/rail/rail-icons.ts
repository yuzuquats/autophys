// The rail's collapse glyphs, once.
//
// A panel whose left lane is the rail itself, with the chevron pointing the
// way the rail is about to move. The icon set has nothing that reads as "this
// rail narrows" — its double-chevrons all say "expand a section" — so the
// commit-review rail drew its own, ux-rail copied it verbatim, and the spool
// rail did it a third time. Inline markup rather than an `icons/*.svg`
// import on purpose: a storybook card is bundled separately by bun, where an
// svg import arrives as a path and `LonaIcons.$svg` dies on it.
//
// Exported from their own module because the BUTTON that shows them is the
// owner's (a rail collapsed to zero width has nowhere to hold its own expand
// affordance) while the meaning of the glyph is the rail's.

export const COLLAPSE_RAIL_ICON = /* xml */ `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <line x1="10" y1="4.5" x2="10" y2="19.5" />
    <polyline points="16.5 9.5 14 12 16.5 14.5" />
  </svg>
`;

export const EXPAND_RAIL_ICON = /* xml */ `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <line x1="10" y1="4.5" x2="10" y2="19.5" />
    <polyline points="14 9.5 16.5 12 14 14.5" />
  </svg>
`;
