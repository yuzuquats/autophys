export const contentTransitionStyles = (scope: string) => `
/* The drawer covers a full-height workbench; it never resizes its charts. */
${scope} .ck-main { bottom:0;transition:none; }
${scope} .ck-panels[data-open] .ck-main { opacity:1;visibility:visible; }
${scope} .ck-panel-body { padding-bottom:8px;transition:none; }
${scope} .ap-viewer { scroll-padding-bottom:calc(var(--ck-peek) + 12px); }
/* Keep the covered tail reachable without changing the viewer's dimensions. */
${scope} .ap-viewer::after { content:"";display:block;flex:none;grid-column:1/-1;height:var(--ck-peek); }
/* Panel toggles retain their independent docking motion. */
${scope} .ck-panel { transition:opacity 180ms ease-out,transform 240ms var(--ck-ease),visibility 0s linear 240ms; }
@media(max-width:760px) {
  ${scope} .ck-panels[data-mobile="sidebar"] .ck-main,
  ${scope} .ck-panels[data-mobile="details"] .ck-main { opacity:0;visibility:hidden; }
}
@media(prefers-reduced-motion:reduce) {
  ${scope} .ck-panel { transition:none !important; }
}
`;
