/** Scoped experiment Details refinement; compose after autophysStyles. */
export function detailsExperimentStyles(scope: string): string {
  return `
${scope} .ap-experiment-card { position:relative;isolation:isolate;min-width:0;overflow-wrap:anywhere; }
${scope} .ap-experiment-header { display:block;padding:12px; }
${scope} .ap-experiment-header std-list-cell-layout, ${scope} .ap-experiment-header .ap-cell-text { display:block;min-width:0;width:100%; }
${scope} .ap-experiment-header .ap-dname { display:flex;align-items:baseline;gap:6px;margin:0;font:600 14px/20px var(--ap-font); }
${scope} .ap-experiment-header .ap-dname [data-ap-icon] { align-self:center; }
${scope} .ap-experiment-source { margin:3px 0 0;color:var(--ap-sec);font:12px/17px var(--ap-font); }
${scope} .ap-experiment-header .ap-status { margin:6px 0 0;font:12px/17px var(--ap-font); }
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
${scope} .ap-experiment-notice { padding:12px; }
${scope} .ap-experiment-notice .ap-sub { margin:0 0 7px; }
${scope} .ap-experiment-actions { display:flex;flex-direction:column;gap:8px;padding:12px;border-top:1px solid var(--ap-line); }
${scope} .ap-experiment-actions .ap-decision, ${scope} .ap-experiment-actions .ap-actions { margin:0; }
${scope} .ap-experiment-card input { caret-color:var(--ap-ink); }
${scope} .ap-experiment-card .ap-input:focus-within { outline:2px solid var(--ck-focus);outline-offset:1px; }
${scope} .ap-experiment-card .ap-input input:focus-visible { outline:none; }
`;
}
