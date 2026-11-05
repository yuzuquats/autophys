/**
 * Opening summaries use the existing round surface and list-cell hydration.
 * Append after autophysStyles; lower technical cards retain their compact type.
 */
export function mainSummaryStyles(scope: string): string {
  const w = scope;
  return `
${w} .ap-card.ap-main-summary { padding:18px; }
${w} .ap-main-summary > .ap-card-head { margin-bottom:10px; }
${w} .ap-main-summary .ap-card-head h2 { margin:0;color:var(--ap-ink);font:600 20px/26px var(--ap-font);letter-spacing:-.02em;overflow-wrap:anywhere;text-wrap:balance; }
${w} .ap-summary-copy { display:flex;flex-direction:column;gap:10px;min-width:0; }
${w} .ap-main-summary .ap-summary-copy > .ap-text { margin:0;max-width:70ch;color:var(--ap-sec);font:12.5px/19px var(--ap-font);overflow-wrap:anywhere;text-wrap:pretty; }
${w} .ap-main-summary .ap-summary-copy > .ap-text.ap-prose { color:var(--ap-ink);font:14px/22px var(--ap-font); }
${w} .ap-main-summary .ap-summary-copy > .ap-text.ap-t-ok { color:var(--ap-ok); }
${w} .ap-main-summary .ap-summary-copy > .ap-text.ap-t-warn { color:var(--ap-warn); }
${w} .ap-main-summary .ap-summary-copy > .ap-text.ap-t-run { color:var(--ap-run); }
${w} .ap-main-summary .ap-summary-copy > .ap-text.ap-t-danger { color:var(--ap-danger); }
${w} .ap-main-summary .ap-summary-copy > .ap-text.ap-t-muted { color:var(--ap-sec); }
${w} .ap-main-summary .ap-summary-meta { margin:12px 0 0;color:var(--ap-sec);font:12px/18px var(--ap-font);font-variant-numeric:tabular-nums;overflow-wrap:anywhere; }
@media (max-width:639px) {
  ${w} .ap-card.ap-main-summary { padding:16px; }
  ${w} .ap-main-summary .ap-summary-copy > .ap-text.ap-prose { font-size:15px;line-height:23px; }
}
`;
}
