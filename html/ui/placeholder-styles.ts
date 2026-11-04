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
/* Quiet loading: the text stays for screen readers (role=status) but is not drawn. */
${w} .ap-viewer.ap-state[aria-busy="true"] > [data-ap-empty] { position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap; }
${w} .ap-viewer.ap-state > .ap-ph { max-width:420px; }
${w} :has(> .ap-signin-wrap) > .ap-toolbar, ${w} :has(> * > .ap-signin-wrap) > .ap-toolbar { visibility:hidden; }
${w} .ap-signin-wrap { container-type:size;display:grid;place-content:safe center;place-items:center;
  height:100%;box-sizing:border-box;padding:16px;overflow:auto; }
/* Everything in the card is in em, and the card's font size follows the pane's height, so the
   whole card scales down to fit a short pane (and never overflows) and tops out at 14px. */
${w} .ap-signin { font:clamp(11px, calc(100cqh / 31), 14px)/1.4 var(--ap-font,system-ui);
  width:min(100cqw, 26em);box-sizing:border-box;position:relative;isolation:isolate;
  padding:2em;display:grid;gap:.45em;color:var(--ap-ink,#141414); }
${w} .ap-signin h2 { margin:0;font:600 1.36em/1.3 var(--ap-font,system-ui);letter-spacing:-.01em; }
${w} .ap-signin > p { margin:0 0 .7em;color:var(--ap-sec,#5b5b5b); }
${w} .ap-signin label { display:grid;gap:.35em;font-size:.86em;font-weight:600;margin-top:.4em; }
${w} .ap-signin input { font-size:1.16em;font-weight:400;font-family:inherit;padding:.6em .75em;border:1px solid #d6d6d6;
  border-radius:.55em;background:#fff;color:inherit;min-width:0; }
${w} .ap-signin input:focus { outline:2px solid var(--ap-ink,#141414);outline-offset:-1px;border-color:transparent; }
${w} .ap-signin button { margin-top:1em;padding:.8em;border:0;border-radius:.55em;background:var(--ap-ink,#141414);color:#fff;
  font:inherit;font-weight:600;cursor:pointer; }
${w} .ap-signin button.ap-signin-demo { margin-top:0;background:#efefef;color:var(--ap-ink,#141414); }
${w} .ap-signin button.ap-signin-demo:hover { background:#e4e4e4; }
${w} .ap-signin .ap-signin-alt { margin:.85em 0 0;font-size:.93em;color:var(--ap-sec,#5b5b5b); }
${w} .ap-signin .ap-signin-alt a { color:inherit; }
${w} .ap-signin .ap-signin-err { background:#fdecec;color:#9b1c1c;border-radius:.55em;padding:.55em .75em;font-size:.93em;margin:.2em 0 .1em; }
/* A short pane (a small window with the tutorial open): drop the subtitle and tighten. */
@container (max-height: 300px) {
  ${w} .ap-signin { padding:1.1em 1.4em;gap:.3em; }
  ${w} .ap-signin > p:not(.ap-signin-alt) { display:none; }
  ${w} .ap-signin label { margin-top:.2em; }
  ${w} .ap-signin button { margin-top:.6em;padding:.6em; }
  ${w} .ap-signin .ap-signin-alt { margin-top:.4em; }
}
`;
}
