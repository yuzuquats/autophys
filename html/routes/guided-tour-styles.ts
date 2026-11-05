/** The 200px tour sheet; a preview is needed only for obscured targets. */
export const guidedTourStyles = `
html[data-ap-tour] .ck-app { --ck-peek: 0px !important; }
html[data-ap-tour] .ck-panels { bottom:212px !important; }
html[data-ap-tour] .ck-panel { transition:opacity 200ms ease-out, transform 200ms ease-out, visibility 0s linear 200ms; }
html[data-ap-tour] .ck-panel-body { transition-duration:200ms; }
html[data-ap-tour] .ck-toggle, html[data-ap-tour] .ck-main { transition-duration:200ms; }
.ap-guided-tour { position:fixed; z-index:30; inset:auto 0 0; height:200px; background:#fff; border-radius:24px 24px 0 0; box-shadow:0 -4px 24px rgb(0 0 0 / 9%); padding:18px 28px; }
.ap-tour-inner { position:relative; max-width:930px; height:100%; margin:auto; display:grid; grid-template-columns:220px minmax(0,1fr); gap:28px; }
.ap-guided-tour[data-preview="false"] .ap-tour-inner { grid-template-columns:minmax(0,1fr); }
.ap-tour-visual[hidden] { display:none; }
.ap-tour-preview { overflow:hidden; height:124px; border-radius:10px; background:var(--ck-fill,#f4f4f4); border:1px solid var(--ck-line,#ddd); pointer-events:none; position:relative; }
.ap-tour-preview-clip { position:absolute; inset:0 auto auto 0; transform-origin:top left; }
.ap-tour-label { margin:6px 0 0; font:11px/15px var(--ck-font); color:var(--ck-secondary,#666); }
.ap-tour-lesson { min-width:0; display:flex; flex-direction:column; padding-right:26px; }
.ap-tour-bars { display:flex; gap:4px; margin:0 0 10px; }
.ap-tour-bars i { height:3px; flex:1; background:var(--ck-n200,#ddd); border-radius:4px; overflow:hidden; }
.ap-tour-bars b { display:block; height:100%; background:var(--ck-ink,#1a1a1a); }
.ap-tour-title { margin:0 0 6px; font-size:21px; line-height:26px; font-weight:500; letter-spacing:-.025em; }
.ap-tour-body { margin:0; color:var(--ck-secondary,#666); font-size:14px; line-height:20px; max-width:55ch; }
.ap-tour-actions { display:flex; align-items:center; gap:8px; margin-top:auto; padding-top:8px; }
.ap-guided-tour button,.ap-tour-menu button,.ap-tour-empty { min-height:36px; padding:6px 14px; border:1px solid var(--ck-line,#ddd); border-radius:999px; background:white; cursor:pointer; font:500 13px/20px var(--ck-font); }
.ap-guided-tour button:hover,.ap-tour-menu button:hover { background:var(--ck-hover,#f2f2f2); }
.ap-guided-tour button:disabled { opacity:.4; cursor:default; }
.ap-guided-tour .ap-tour-next { background:var(--ck-ink,#1a1a1a); color:white; border-color:transparent; }
.ap-guided-tour .ap-tour-next:hover { background:#333; }
.ap-tour-close { position:absolute; right:-10px; top:-8px; width:36px; padding:8px !important; border:0 !important; }
.ap-tour-close svg { display:block; width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.5; }
.ap-tour-hint { font:11px/16px var(--ck-font); color:var(--ck-secondary,#666); }
.ap-tour-chip { position:fixed; z-index:25; top:calc(81px + var(--ck-safe-top,0px)); left:50%; transform:translateX(-50%); background:#fff1d5; color:#805000; font:500 11px/18px var(--ck-font); padding:2px 9px; border-radius:999px; pointer-events:none; }
.ap-tour-menu { position:relative; }
.ap-tour-menu summary { cursor:pointer; min-height:36px; padding:8px 10px; list-style:none; }
.ap-tour-menu summary::-webkit-details-marker { display:none; }
.ap-tour-menu[open] button { position:absolute; right:0; top:40px; width:150px; border-radius:10px; box-shadow:0 4px 16px rgb(0 0 0 / 12%); }
.ap-tour-empty { display:block; margin:12px auto; }
.ap-tour-halo { z-index:26 !important; pointer-events:none; position:fixed; animation:none !important;
 transition:left 180ms ease-out, top 180ms ease-out, width 180ms ease-out, height 180ms ease-out; }
@media(max-width:639px) {
 .ap-guided-tour { height:260px; padding:18px 16px; border-radius:20px 20px 0 0; }
 html[data-ap-tour] .ck-panels { bottom:272px !important; }
 .ap-tour-inner { grid-template-columns:120px minmax(0,1fr); gap:12px; }
 .ap-tour-preview { height:100px; }
 .ap-tour-label { font-size:10px; line-height:14px; }
 .ap-tour-title { font-size:19px; line-height:23px; }
 .ap-tour-body { font-size:13px; line-height:18px; }
 .ap-tour-lesson { padding-right:4px; }
 .ap-tour-actions { flex-wrap:wrap; }
 .ap-tour-hint { flex-basis:100%; }
 .ap-tour-close { right:-8px; top:-12px; }
 .ap-tour-bars { margin-right:22px; }
 .ap-tour-chip { top:70px; }
}
@media(prefers-reduced-motion:reduce) {
 .ap-tour-halo, html[data-ap-tour] .ck-panel, html[data-ap-tour] .ck-panel-body,
 html[data-ap-tour] .ck-toggle, html[data-ap-tour] .ck-main { transition:none !important; }
}
`;
