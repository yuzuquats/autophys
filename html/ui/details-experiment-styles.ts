/** Scoped experiment Details refinement; compose after autophysStyles. */
export function detailsExperimentStyles(scope: string): string {
  return `
/* Only proposal Details opt into a full-height card; other records keep shell scrolling. */
${scope} .ck-panel-body:has(> .ck-details-slot > .ap-experiment-card) { overflow:hidden;padding-bottom:8px; }
${scope} .ck-details-slot:has(> .ap-experiment-card) { display:flex;flex:1;min-height:0; }
${scope} .ap-experiment-card { position:relative;isolation:isolate;display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow-wrap:anywhere; }
${scope} .ap-experiment-scroll { flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scroll-padding:12px;scrollbar-width:thin; }
${scope} .ap-experiment-header { display:block;flex:none;padding:8px 12px; }
${scope} .ap-experiment-header std-list-cell-layout, ${scope} .ap-experiment-header .ap-cell-text { display:block;min-width:0;width:100%; }
${scope} .ap-experiment-header .ap-dname { display:flex;align-items:baseline;gap:6px;margin:0;font:600 14px/18px var(--ap-font); }
${scope} .ap-experiment-header .ap-dname [data-ap-icon] { align-self:center; }
${scope} .ap-experiment-source { margin:2px 0 0;color:var(--ap-sec);font:12px/16px var(--ap-font); }
${scope} .ap-experiment-header .ap-status { margin:2px 0 0;font:12px/16px var(--ap-font); }
${scope} .ap-experiment-body { padding:0 12px 12px; }
${scope} .ap-experiment-section + .ap-experiment-section { margin-top:18px; }
${scope} .ap-experiment-section .ap-sub { margin:0 0 7px; }
${scope} .ap-experiment-caption { margin:0 0 8px;color:var(--ap-sec);font:12px/17px var(--ap-font); }
${scope} .ap-experiment-row { border-top:1px solid var(--ap-line); }
${scope} .ap-experiment-row-summary { display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:40px;box-sizing:border-box;padding:10px 12px;list-style:none;cursor:pointer;font:600 12px/20px var(--ap-font); }
${scope} .ap-experiment-row-summary::-webkit-details-marker { display:none; }
${scope} .ap-experiment-row-summary::marker { content:""; }
${scope} .ap-experiment-row-summary:hover { background:var(--bg-hover-very-light); }
${scope} .ap-experiment-row-summary:focus-visible { outline:2px solid var(--ck-focus);outline-offset:-2px; }
${scope} .ap-experiment-caret { display:flex;align-items:center;flex:none;width:14px;height:20px;color:var(--ap-sec); }
${scope} .ap-experiment-row[open] > summary .ap-experiment-caret { transform:rotate(90deg); }
${scope} .ap-experiment-row-body { padding:0 12px 12px; }
${scope} .ap-experiment-card .ap-facts { grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:4px 8px; }
${scope} .ap-experiment-card .ap-facts dd { text-align:right; }
${scope} .ap-experiment-card .ap-footnote { margin:0;color:var(--ap-sec); }
${scope} .ap-experiment-notice { max-height:120px;overflow:auto; }
${scope} .ap-experiment-notice .ap-sub { margin:0 0 7px; }
${scope} .ap-experiment-actions { display:flex;flex:none;flex-direction:column;gap:8px;padding:12px;border-top:1px solid var(--ap-line); }
${scope} .ap-experiment-actions .ap-decision, ${scope} .ap-experiment-actions .ap-actions { margin:0; }
${scope} .ap-experiment-card input { caret-color:var(--ap-ink); }
${scope} .ap-experiment-card .ap-input:focus-within { outline:2px solid var(--ck-focus);outline-offset:1px; }
${scope} .ap-experiment-card .ap-input input:focus-visible { outline:none; }
`;
}
