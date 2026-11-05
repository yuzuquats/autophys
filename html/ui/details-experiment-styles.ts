/** Scoped experiment Details refinement; compose after autophysStyles. */
export function detailsExperimentStyles(scope: string): string {
  return `
${scope} .ap-experiment-card { min-width:0;border:1px solid var(--ap-line);border-radius:12px;background:var(--bg,#fff);overflow-wrap:anywhere; }
${scope} .ap-experiment-summary { display:grid;grid-template-columns:minmax(0,1fr) 14px;align-items:start;gap:8px;padding:12px;list-style:none;cursor:pointer;border-radius:11px; }
${scope} .ap-experiment-summary::-webkit-details-marker { display:none; }
${scope} .ap-experiment-summary::marker { content:""; }
${scope} .ap-experiment-summary:hover { background:var(--bg-hover-very-light); }
${scope} .ap-experiment-summary:focus-visible { outline:2px solid var(--ck-focus);outline-offset:-2px; }
${scope} .ap-experiment-summary [data-ap-cell], ${scope} .ap-experiment-summary std-list-cell-layout, ${scope} .ap-experiment-summary .ap-cell-text { display:block;min-width:0;width:100%; }
${scope} .ap-experiment-summary .ap-dname { display:flex;align-items:baseline;gap:6px;margin:0;font:600 14px/20px var(--ap-font); }
${scope} .ap-experiment-summary .ap-dname [data-ap-icon] { align-self:center; }
${scope} .ap-experiment-source { margin:3px 0 0;color:var(--ap-sec);font:12px/17px var(--ap-font); }
${scope} .ap-experiment-summary .ap-status { margin:6px 0 0;font:12px/17px var(--ap-font); }
${scope} .ap-experiment-caret { display:flex;align-items:center;height:20px;color:var(--ap-sec); }
${scope} .ap-experiment-card details[open] > summary .ap-experiment-caret { transform:rotate(90deg); }
${scope} .ap-experiment-body { padding:0 12px 12px; }
${scope} .ap-experiment-section + .ap-experiment-section { margin-top:18px; }
${scope} .ap-experiment-section .ap-sub { margin:0 0 7px; }
${scope} .ap-experiment-caption { margin:0 0 8px;color:var(--ap-sec);font:12px/17px var(--ap-font); }
${scope} .ap-experiment-card .ap-facts { grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:4px 8px; }
${scope} .ap-experiment-card .ap-facts dd { text-align:right; }
${scope} .ap-experiment-card .ap-footnote { margin-top:18px;color:var(--ap-sec); }
${scope} .ap-experiment-actions { display:flex;flex-direction:column;gap:8px;padding:12px;border-top:1px solid var(--ap-line); }
${scope} .ap-experiment-actions .ap-decision, ${scope} .ap-experiment-actions .ap-actions { margin:0; }
${scope} .ap-experiment-card input { caret-color:var(--ap-ink); }
${scope} .ap-experiment-card .ap-input:focus-within { outline:2px solid var(--ck-focus);outline-offset:1px; }
${scope} .ap-experiment-card .ap-input input:focus-visible { outline:none; }
`;
}

