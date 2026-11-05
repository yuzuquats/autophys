/** What the tour adds around the cookbook tutorial: the demo-data chip, the
 * clipped preview in the sheet's left column, and
 * quicker (200 ms) panel slides while a tour moves between steps. */
export const guidedTourStyles = `
.ap-tour-preview-clip { position:absolute; inset:0 auto auto 0; transform-origin:top left; }
html[data-ap-tour] .ck-panel { transition:opacity 200ms ease-out, transform 200ms ease-out, visibility 0s linear 200ms; }
html[data-ap-tour] .ck-panel-body { transition-duration:200ms; }
html[data-ap-tour] .ck-toggle, html[data-ap-tour] .ck-main { transition-duration:200ms; }
.ap-tour-chip { position:fixed; z-index:25; top:calc(81px + var(--ck-safe-top,0px)); left:50%; transform:translateX(-50%); background:#fff1d5; color:#805000; font:500 11px/18px var(--ck-font); padding:2px 9px; border-radius:999px; pointer-events:none; }
@media(max-width:639px) { .ap-tour-chip { top:70px; } }
@media(prefers-reduced-motion:reduce) { html[data-ap-tour] .ck-panel, html[data-ap-tour] .ck-panel-body, html[data-ap-tour] .ck-toggle, html[data-ap-tour] .ck-main { transition:none !important; } }
`;
