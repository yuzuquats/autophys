/**
 * The components' stylesheet, every selector under `scope` (for example
 * `[data-workbench="modellab"]`). Colours come from the host's tokens where it has them
 * (`--text-pri`, `--text-sec`, `--text-ter`, `--divider`, `--wb-stage`, `--wb-accepted`,
 * `--hx-font`), with the ModelLab mock values as fallbacks.
 */
export function autophysStyles(scope: string): string {
  const w = scope;
  return `
${w} { --ap-ink:var(--text-pri,#111);--ap-sec:var(--text-sec,#555);--ap-ter:var(--text-ter,#8f8f8f);--ap-line:var(--divider,#e4e4e4);
  --ap-stage:var(--wb-stage,#f4f4f4);--ap-ok:var(--wb-accepted,#2f7a52);--ap-warn:#b4541c;--ap-run:#c2701c;--ap-run-track:#f1d9c4;
  --ap-danger:var(--wb-rejected,#a3402f);--ap-font:var(--hx-font,-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif); }
${w} .ap-hidden { position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap; }
${w} .ap-t-ok { color:var(--ap-ok); } ${w} .ap-t-warn { color:var(--ap-warn); } ${w} .ap-t-run { color:var(--ap-run); }
${w} .ap-t-muted { color:var(--ap-ter); } ${w} .ap-t-danger { color:var(--ap-danger); }

/* ---- sidebar ---- */
${w} .ap-side-head { margin:0 0 6px; }
${w} .ap-switch select { width:100%; }
${w} .ap-section-head { display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 4px;font:600 12px/16px var(--ap-font);color:var(--ap-ink); }
${w} .ap-count { margin-left:6px;font-weight:400;color:var(--ap-ter);font-variant-numeric:tabular-nums; }
${w} .ap-add { flex:none;width:24px;height:24px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:none;color:var(--ap-sec);cursor:pointer; }
${w} .ap-add:hover:not(:disabled) { background:var(--bg-hover,#ececec);color:var(--ap-ink); }
${w} .ap-add:disabled { color:var(--ap-ter);cursor:default;opacity:.6; }
${w} .ap-add svg { width:14px;height:14px; }
${w} std-tree-list.ap-tree { --tree-row-height-preset:27px;--tree-row-gap-preset:1px;--tree-indent-preset:16px;--tree-inset-preset:8px;
  --tree-bg-hover-preset:var(--bg-hover,#ececec);--tree-bg-selected-preset:var(--bg-selected,#e4e4e4);display:block;width:auto; }
${w} .ap-lead { display:inline-flex;width:14px;height:14px; }
${w} .ap-lead svg { width:14px;height:14px; }
${w} .ap-trail { display:inline-flex;align-items:center;gap:4px;font:11px/16px var(--ap-font);font-variant-numeric:tabular-nums;white-space:nowrap; }
${w} .ap-badge { display:inline-block;min-width:16px;padding:0 6px;border-radius:999px;background:var(--hx-ink,#111);color:#fff;font:600 10.5px/16px var(--ap-font);text-align:center; }

/* ---- main ---- */
${w} .ap-toolbar { display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;flex-shrink:0;min-height:34px; }
${w} .ap-crumb { display:flex;align-items:center;flex-wrap:wrap;gap:2px;min-width:0;font:13px/18px var(--ap-font);color:var(--ap-sec); }
${w} .ap-crumb button { padding:2px 4px;border:0;border-radius:6px;background:none;font:inherit;color:inherit;cursor:pointer; }
${w} .ap-crumb button:hover { background:var(--bg-hover,#ececec);color:var(--ap-ink); }
${w} .ap-crumb b { padding:2px 4px;color:var(--ap-ink);font-weight:600; }
${w} .ap-sep { color:var(--ap-ter); }
${w} .ap-right { display:flex;align-items:center;gap:8px; }
${w} .ap-meta { font:12px/16px var(--ap-font);color:var(--ap-sec);font-variant-numeric:tabular-nums; }
${w} .ap-viewer { flex:1 0 auto;display:grid;grid-template-columns:repeat(var(--ap-cols,1),minmax(0,1fr));gap:12px;align-content:start;padding:12px;border-radius:12px;background:var(--ap-stage);min-height:180px; }
${w} .ap-viewer.ap-empty { place-items:center;align-content:center;color:var(--ap-ter);font:13px/18px var(--ap-font); }
${w} .ap-viewer.ap-empty p { margin:0; }
${w} .ap-panel { min-width:0;display:flex;flex-direction:column;gap:2px; }
${w} .ap-panel-title { margin:0 0 2px;font:600 12px/16px var(--ap-font);color:var(--ap-ink);font-variant-numeric:tabular-nums; }
${w} .ap-chart { min-width:0; }
${w} .ap-svg { display:block;overflow:visible;font-family:var(--ap-font); }
${w} .ap-grid { stroke:#e2e2e2;stroke-width:1; }
${w} .ap-tick { fill:var(--ap-ter);font-size:10px;font-variant-numeric:tabular-nums; }
${w} .ap-label { fill:var(--ap-sec);font-size:11px; }
${w} .ap-legend { fill:var(--ap-sec);font-size:10.5px; }
${w} .ap-direct { fill:var(--ap-ink);font-size:11px; }
${w} .ap-line { fill:none;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round; }
${w} .ap-dashed { stroke-dasharray:4 4; }
${w} .ap-rule { stroke-width:1; }
${w} .ap-band { stroke:none; }
${w} .ap-dots.ap-s-measured, ${w} circle.ap-s-measured { fill:#a9a9a9; }
${w} .ap-line.ap-s-measured { stroke:#a9a9a9; }
${w} .ap-line.ap-s-initial { stroke:#b5b5b5; }
${w} .ap-line.ap-s-fit { stroke:var(--ap-ink);stroke-width:2; }
${w} .ap-line.ap-s-run { stroke:var(--ap-run);stroke-width:2; }
${w} .ap-line.ap-s-input, ${w} .ap-rule.ap-s-input { stroke:var(--ap-sec);stroke-width:1.5; }
${w} .ap-line.ap-s-muted, ${w} .ap-rule.ap-s-muted { stroke:#cfcfcf; }
${w} .ap-line.ap-s-warn, ${w} .ap-rule.ap-s-warn { stroke:var(--ap-warn); }
${w} .ap-dots.ap-s-fit, ${w} circle.ap-s-fit { fill:var(--ap-ink); }
${w} .ap-dots.ap-s-run, ${w} circle.ap-s-run { fill:var(--ap-run); }
${w} .ap-dots.ap-s-warn { fill:var(--ap-warn); }
${w} .ap-band.ap-s-muted, ${w} .ap-band.ap-s-measured { fill:rgb(0 0 0 / 5%); }
${w} .ap-cells rect { fill:var(--ap-ink); }
${w} .ap-frame { fill:none;stroke:#dcdcdc; }
${w} .ap-trail { }
${w} polyline.ap-trail { fill:none;stroke:var(--ap-run);stroke-width:1.5;stroke-dasharray:3 3; }
${w} .ap-trail-dot { fill:#fff;stroke:var(--ap-run);stroke-width:1.5; }
${w} .ap-trail-dot.last { fill:var(--ap-run); }
${w} .ap-chart-label { margin:0 0 6px;font:12px/16px var(--ap-font);color:var(--ap-sec); }
${w} .ap-credit { margin:6px 0 0;font:12px/16px ui-monospace,"SF Mono",Menlo,monospace;color:var(--ap-ter);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0; }

/* ---- bars and ranges (main and details) ---- */
${w} .ap-bars { display:flex;flex-direction:column;gap:5px; }
${w} .ap-bar { display:grid;grid-template-columns:minmax(0,96px) minmax(0,1fr) 44px;gap:6px;align-items:center;font:11.5px/16px var(--ap-font); }
${w} .ap-bar-label { overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--ap-ink); }
${w} .ap-bar-track { height:8px;border-radius:4px;background:#e6e6e6;overflow:hidden; }
${w} .ap-bar-fill { display:block;height:100%;min-width:2px;border-radius:0 4px 4px 0;background:var(--ap-ink); }
${w} .ap-bar-fill.ap-t-warn { background:var(--ap-warn); } ${w} .ap-bar-fill.ap-t-ok { background:var(--ap-ok); }
${w} .ap-bar-fill.ap-t-muted { background:#bdbdbd; } ${w} .ap-bar-fill.ap-t-run { background:var(--ap-run); }
${w} .ap-bar-value { text-align:right;color:var(--ap-sec);font-variant-numeric:tabular-nums; }
${w} .ap-ranges { display:flex;flex-direction:column;gap:8px;max-width:560px; }
${w} .ap-range { display:grid;grid-template-columns:110px 48px minmax(0,1fr) 48px 56px;gap:8px;align-items:center;font:12px/16px var(--ap-font);font-variant-numeric:tabular-nums; }
${w} .ap-range-lo { text-align:right;color:var(--ap-sec); } ${w} .ap-range-hi { color:var(--ap-sec); }
${w} .ap-range-track { position:relative;height:6px;border-radius:3px;background:#e2e2e2; }
${w} .ap-range-track i { position:absolute;top:-3px;width:2px;height:12px;margin-left:-1px;border-radius:1px;background:var(--ap-ink); }

/* ---- details ---- */
${w} .ap-dname { display:flex;align-items:center;gap:8px; }
${w} .ap-dname svg { flex:none;width:16px;height:16px; }
${w} .ap-sub { margin:14px 0 6px;font:600 12.5px/16px var(--ap-font);color:var(--ap-ink); }
${w} .ap-facts { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;margin:0;font:12.5px/18px var(--ap-font); }
${w} .ap-facts div { display:contents; }
${w} .ap-facts dt { color:var(--ap-sec); }
${w} .ap-facts dd { margin:0;text-align:right;font-weight:500;font-variant-numeric:tabular-nums; }
${w} .ap-note { color:var(--ap-ter);font-weight:400; }
${w} .ap-unit { color:var(--ap-ter);font-size:11px; }
${w} .ap-tag { display:inline-block;padding:0 6px;border:1px solid #d8d8d8;border-radius:999px;font:500 10.5px/16px var(--ap-font);color:var(--ap-sec);white-space:nowrap; }
${w} .ap-tag.ap-t-ok { border-color:#bfdccb;color:var(--ap-ok);background:#eef7f1; }
${w} .ap-tag.ap-t-warn { border-color:#efcdb6;color:var(--ap-warn);background:#fbf1ea; }
${w} .ap-tag.ap-t-run { border-color:#efd3b8;color:var(--ap-run);background:#fbf3ea; }
${w} .ap-tag.ap-t-muted { color:var(--ap-ter); }
${w} .ap-table { width:100%;border-collapse:collapse;font:12.5px/18px var(--ap-font);font-variant-numeric:tabular-nums; }
${w} .ap-table td { padding:4px 0;border-bottom:1px solid #e6e6e6;vertical-align:baseline; }
${w} .ap-table td + td { padding-left:6px; }
${w} .ap-table td.ap-end { text-align:right; }
${w} .ap-table tr.ap-dim td { color:var(--ap-ter); }
${w} .ap-meters { display:flex;flex-direction:column;gap:6px; }
${w} .ap-meter-head { display:flex;justify-content:space-between;font:12.5px/18px var(--ap-font); }
${w} .ap-meter-head span { color:var(--ap-sec); } ${w} .ap-meter-head b { font-weight:500;font-variant-numeric:tabular-nums; }
${w} .ap-meter-track { height:6px;margin-top:3px;border-radius:3px;background:#e6e6e6;overflow:hidden; }
${w} .ap-meter-track i { display:block;height:100%;background:var(--ap-ink); }
${w} .ap-meter-track i.ap-t-run { background:var(--ap-run); } ${w} .ap-meter-track i.ap-t-warn { background:var(--ap-warn); }
${w} .ap-fields { display:grid;grid-template-columns:1fr 1fr;gap:8px 6px; }
${w} .ap-field { display:flex;flex-direction:column;gap:3px;min-width:0; }
${w} .ap-field-label { font:12px/16px var(--ap-font);color:var(--ap-sec); }
${w} .ap-input { display:flex;align-items:center;gap:4px;height:32px;padding:0 9px;border:1px solid #dcdcdc;border-radius:8px;background:#fff; }
${w} .ap-input:focus-within { border-color:var(--blue,#2a6fdb); }
${w} .ap-invalid .ap-input { border-color:var(--ap-danger); }
${w} .ap-input input { flex:1;min-width:0;height:auto!important;padding:0!important;border:0!important;background:none!important;font:13px/18px var(--ap-font);font-variant-numeric:tabular-nums;outline:none; }
${w} .ap-input i { font-style:normal;color:var(--ap-ter);font:12px/16px var(--ap-font); }
${w} .ap-field-error { color:var(--ap-danger);font:11px/14px var(--ap-font); }
${w} .ap-links { display:flex;flex-direction:column;align-items:flex-start;gap:4px; }
${w} .ap-link { padding:0;border:0;background:none;font:12px/16px var(--ap-font);color:var(--ap-ink);text-decoration:underline;text-underline-offset:2px;cursor:pointer; }
${w} .ap-text { margin:0;font:12px/17px var(--ap-font);color:var(--ap-ink); }
${w} .ap-decision, ${w} .ap-actions { display:flex;gap:6px;margin-top:14px; }
${w} .ap-decision > button, ${w} .ap-actions > button { flex:1 1 0;min-width:0; }
`;
}
