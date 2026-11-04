/**
 * Placeholder blocks (state-markup.ts skeletonMarkup) and the main pane's sign-in card
 * (`serve --login`, signed out), every selector under `scope`.
 */
export function placeholderStyles(scope: string): string {
  const w = scope;
  return `
${w} .ap-ph { display:grid;gap:12px;width:100%;box-sizing:border-box;padding:12px 4px; }
${w} .ap-ph i { display:block;width:var(--w,100%);height:14px;border-radius:6px;
  background:linear-gradient(90deg,#e8e8e8 0%,#f3f3f3 45%,#e8e8e8 90%);background-size:300% 100%;
  animation:ap-ph-shimmer 2.6s ease-in-out infinite; }
${w} .ap-ph i.b { height:18px; }
${w} .ap-ph i.t { height:22px;border-radius:7px; }
${w} .ap-ph i.card { height:96px;border-radius:10px;margin:6px 0; }
${w} .ap-ph-details { padding:4px 0; }
@keyframes ap-ph-shimmer { 0% { background-position:100% 0; } 100% { background-position:-200% 0; } }
@media (prefers-reduced-motion: reduce) { ${w} .ap-ph i { animation:none; } }
${w} .ap-side-notice [data-ap-empty][data-title=""] { display:none; }
${w} :has(> .ap-signin-wrap) > .ap-toolbar, ${w} :has(> * > .ap-signin-wrap) > .ap-toolbar { visibility:hidden; }
${w} .ap-signin-wrap { display:grid;place-items:center;padding:24px; }
${w} .ap-signin { width:min(100%,360px);box-sizing:border-box;background:#fff;border:1px solid #e6e6e6;border-radius:12px;
  padding:28px;display:grid;gap:6px;font:14px/1.4 var(--ap-font,system-ui);color:var(--ap-ink,#141414); }
${w} .ap-signin h2 { margin:0;font:600 19px/1.3 var(--ap-font,system-ui);letter-spacing:-.01em; }
${w} .ap-signin > p { margin:0 0 10px;color:var(--ap-sec,#5b5b5b); }
${w} .ap-signin label { display:grid;gap:5px;font-size:12px;font-weight:600;margin-top:6px; }
${w} .ap-signin input { font:inherit;font-weight:400;padding:10px 12px;border:1px solid #d6d6d6;border-radius:8px;background:#fff;color:inherit; }
${w} .ap-signin input:focus { outline:2px solid var(--ap-ink,#141414);outline-offset:-1px;border-color:transparent; }
${w} .ap-signin button { margin-top:14px;padding:11px;border:0;border-radius:8px;background:var(--ap-ink,#141414);color:#fff;
  font:inherit;font-weight:600;cursor:pointer; }
${w} .ap-signin .ap-signin-alt { margin:12px 0 0;font-size:13px;color:var(--ap-sec,#5b5b5b); }
${w} .ap-signin .ap-signin-alt a { color:inherit; }
`;
}
