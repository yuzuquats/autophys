/** What the tour adds around the cookbook tutorial: the demo-data chip, the
 * native-size fixture images in the sheet's left column, and
 * quicker (200 ms) panel slides while a tour moves between steps. */
export const guidedTourStyles = `
html[data-ap-tour] .ck-tour { max-width:1000px; gap:20px; }
html[data-ap-tour] .ck-tour[data-preview] { grid-template-columns:32px 320px minmax(0,1fr); }
html[data-ap-tour] .ck-tour-preview { height:166px; background:transparent; box-shadow:none; }
/* Empty or failed images never leave the cookbook's grey placeholder visible. */
html[data-ap-tour] .ck-tour-preview:empty { display:none !important; }
.ap-tour-image { display:block; width:320px; height:166px; max-width:none; }
/* Narrow screens pan a crop instead of shrinking its labels below native size. */
@media(max-width:760px) {
  html[data-ap-tour] .ck-tour[data-preview] { grid-template-columns:28px minmax(104px,32%) minmax(0,1fr); gap:12px; }
  html[data-ap-tour] .ck-tour-preview { overflow:auto; pointer-events:auto; }
}
html[data-ap-tour] .ck-panel { transition:opacity 200ms ease-out, transform 200ms ease-out, visibility 0s linear 200ms; }
html[data-ap-tour] .ck-panel-body { transition-duration:200ms; }
html[data-ap-tour] .ck-toggle, html[data-ap-tour] .ck-main { transition-duration:200ms; }
.ap-tour-chip { position:fixed; z-index:25; top:calc(81px + var(--ck-safe-top,0px)); left:50%; transform:translateX(-50%); background:#fff1d5; color:#805000; font:500 11px/18px var(--ck-font); padding:2px 9px; border-radius:999px; pointer-events:none; }
@media(max-width:639px) { .ap-tour-chip { top:70px; } }
@media(prefers-reduced-motion:reduce) { html[data-ap-tour] .ck-panel, html[data-ap-tour] .ck-panel-body, html[data-ap-tour] .ck-toggle, html[data-ap-tour] .ck-main { transition:none !important; } }
`;
