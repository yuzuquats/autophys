/** What the tour adds around the cookbook tutorial: the demo-data chip, the
 * "Take the tour" entries, the clipped preview in the sheet's left column, and
 * quicker (200 ms) panel slides while a tour moves between steps. */
export const guidedTourStyles = `
.ap-tour-preview-clip { position:absolute; inset:0 auto auto 0; transform-origin:top left; }
html[data-ap-tour] .ck-panel { transition:opacity 200ms ease-out, transform 200ms ease-out, visibility 0s linear 200ms; }
html[data-ap-tour] .ck-panel-body { transition-duration:200ms; }
html[data-ap-tour] .ck-toggle, html[data-ap-tour] .ck-main { transition-duration:200ms; }
.ap-tour-chip { position:fixed; z-index:25; top:calc(81px + var(--ck-safe-top,0px)); left:50%; transform:translateX(-50%); background:#fff1d5; color:#805000; font:500 11px/18px var(--ck-font); padding:2px 9px; border-radius:999px; pointer-events:none; }
.ap-tour-menu { position:relative; }
.ap-tour-menu summary { cursor:pointer; min-height:36px; padding:8px 10px; list-style:none; }
.ap-tour-menu summary::-webkit-details-marker { display:none; }
.ap-tour-menu button,.ap-tour-empty { min-height:36px; padding:6px 14px; border:1px solid var(--ck-line,#ddd); border-radius:999px; background:white; cursor:pointer; font:500 13px/20px var(--ck-font); }
.ap-tour-menu button:hover,.ap-tour-empty:hover { background:var(--ck-hover,#f2f2f2); }
.ap-tour-menu[open] button { position:absolute; right:0; top:40px; width:150px; border-radius:10px; box-shadow:0 4px 16px rgb(0 0 0 / 12%); }
.ap-tour-empty { display:block; margin:12px auto; }
@media(max-width:639px) { .ap-tour-chip { top:70px; } }
@media(prefers-reduced-motion:reduce) { html[data-ap-tour] .ck-panel, html[data-ap-tour] .ck-panel-body, html[data-ap-tour] .ck-toggle, html[data-ap-tour] .ck-main { transition:none !important; } }
`;
