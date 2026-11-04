/**
 * The components' stylesheet, every selector under `scope` (for example
 * `[data-workbench="modellab"]`). Colours come from the host's tokens where it has them
 * (`--text-pri`, `--text-sec`, `--text-ter`, `--divider`, `--wb-stage`, `--wb-accepted`,
 * `--hx-font`), with the ModelLab mock values as fallbacks.
 */
import { newProjectStyles } from "./new-project-styles.ts";

export function autophysStyles(scope: string): string {
  const w = scope;
  return `
${w} { --ap-ink:var(--ck-ink);--ap-sec:var(--ck-secondary);--ap-ter:var(--ck-n600);--ap-line:var(--ck-line);
  --ap-stage:var(--ck-wash);--ap-ok:var(--ck-ok);--ap-warn:#9b4818;--ap-run:#99551b;--ap-run-track:#f1d9c4;
  --ap-danger:var(--ck-down);--ap-font:var(--ck-font);
  --text-pri:var(--ck-ink);--text-sec:var(--ck-secondary);--text-ter:var(--ck-n600);--bg:#fff;
  --bg-surface-light:var(--ck-n200);--bg-hover-very-light:var(--ck-n100);--bg-hover:var(--ck-hover);--bg-selected:var(--ck-selected);
  --fg-btn-sec:var(--ck-ink);--bg-btn-sec:var(--ck-fill-strong);--bg-btn-sec-hover:var(--ck-selected);
  --fg-btn-pri:#fff;--bg-btn-pri:var(--ck-ink);--bg-btn-pri-hover:var(--ck-secondary);--blue:var(--ck-focus);
  --p-size:13px;--small-size:12px;--font-family:var(--ck-font);font-family:var(--ck-font); }
${w} .ap-project-label { display:flex;flex-direction:column;gap:4px;padding:8px;overflow-wrap:anywhere;font:13px/18px var(--ap-font); }
${w} .ap-project-label > span { color:var(--ap-sec);font-size:12px; }
${w} .ap-side-notice { padding:8px 0; }
${w} std-empty-state { --empty-state-max-width-preset:480px;--margin-top:0px;--margin-bottom:0px;font:13px/20px var(--ap-font); }
${w} .ap-side-notice std-empty-state { font-size:12px;line-height:18px; }
${w} .ap-viewer.ap-state { display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px; }
${w} [data-ap-skeleton] { width:min(100%,360px);padding:8px 16px; }
${w} .ap-gap { color:var(--ap-sec);margin:8px 0 16px; }
${w} .ap-gap std-empty-state { font-size:12px;line-height:18px; }
${w} .ap-viewer.ap-onboarding { display:flex;flex-direction:column;gap:16px;justify-content:flex-start;padding:32px; }
${w} .ap-onboarding h2 { margin:0;font:600 24px/30px var(--ap-font);letter-spacing:-.025em; }
${w} .ap-intro { margin:0;max-width:60ch;color:var(--ap-sec);font:14px/22px var(--ap-font); }
${w} .ap-code-head { display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px;font:12px/18px var(--ap-font); }
${w} .ap-code { margin:0;padding:16px;overflow:auto;max-width:100%;background:#fff;border-radius:8px;font:12px/20px var(--ck-mono);tab-size:4; }
${w} .ap-help { margin:0;color:var(--ap-sec);font:12px/19px var(--ap-font);max-width:70ch; }
${w} .ap-demo-link { display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin:8px 0 0;font:13px/20px var(--ap-font); }
${w} .ap-demo-link span { color:var(--ap-sec);font-size:12px; }
${w} a { color:var(--ap-ink);text-underline-offset:3px; }
${w} a:hover { text-decoration-thickness:2px; }
${w} .ap-connection { padding:16px;border-radius:8px;background:var(--ck-wash);font:13px/20px var(--ap-font); }
${w} .ap-connection p { margin:4px 0 12px;overflow-wrap:anywhere;color:var(--ap-sec); }
${w} .ap-recovery { display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;font:13px/20px var(--ap-font); }
${w} .ap-connection .ap-recovery { justify-content:flex-start; }
${w} .ap-code::selection, ${w} .ap-code *::selection { background:var(--ck-selected); }
${w} std-tree-list[hidden] { display:none; }
@media (max-width:639px) {
  ${w} .ap-viewer.ap-onboarding { padding:20px 16px;gap:14px; }
  ${w} .ap-onboarding h2 { font-size:22px;line-height:28px; }
  ${w} .ap-intro { font-size:16px;line-height:24px; }
  ${w} .ap-code { font-size:12px;line-height:20px;padding:12px; }
  ${w} .ap-facts { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
  ${w} .ap-facts dd { overflow-wrap:anywhere; }
}
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
${w} [data-ap-icon] { display:inline-flex;flex:none;width:14px;height:14px; }
${w} [data-ap-icon] svg { width:100%;height:100%; }
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
${w} .ap-viewer { flex:1 1 auto;overflow:auto;display:grid;grid-template-columns:repeat(var(--ap-cols,1),minmax(0,1fr));gap:12px;align-content:start;padding:12px;border-radius:12px;background:var(--ap-stage);min-height:0; }
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
${w} .ap-credit { margin:6px 0 0;font:11px/16px var(--ap-font);color:var(--ap-ter);overflow-wrap:anywhere;flex-shrink:0; }
${w} .ap-credit summary { cursor:pointer;width:fit-content;max-width:100%; }
${w} .ap-credit details > p { font:11px/18px var(--ck-mono);user-select:all; }
${w} .ap-credit std-button { --p-size:11px; }

/* ---- bars and ranges (main and details) ---- */
${w} .ap-bars { display:flex;flex-direction:column;gap:5px; }
${w} .ap-bar { display:grid;grid-template-columns:minmax(0,96px) minmax(0,1fr) 44px;gap:6px;align-items:center;font:11.5px/16px var(--ap-font); }
${w} .ap-bar-label { overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--ap-ink); }
${w} .ap-bar-track { height:8px;border-radius:4px;background:#e6e6e6;overflow:hidden; }
${w} .ap-bar-fill { display:block;height:100%;min-width:2px;border-radius:0 4px 4px 0;background:var(--ap-ink); }
${w} .ap-bar-fill.ap-t-warn { background:var(--ap-warn); } ${w} .ap-bar-fill.ap-t-ok { background:var(--ap-ok); }
${w} .ap-bar-fill.ap-t-muted { background:#bdbdbd; } ${w} .ap-bar-fill.ap-t-run { background:var(--ap-run); }
${w} .ap-bar-value { text-align:right;color:var(--ap-sec);font-variant-numeric:tabular-nums; }
${w} .ap-ranges { display:grid;grid-template-columns:auto minmax(40px,1fr) auto;column-gap:8px;row-gap:12px; }
${w} .ap-range { grid-column:1/-1;display:grid;grid-template-columns:subgrid;grid-template-areas:"name meta init" "lo track hi";align-items:center;row-gap:3px;min-width:0;font:12px/16px var(--ap-font);font-variant-numeric:tabular-nums; }
${w} .ap-range-name { grid-area:name;font:600 13px/18px var(--ap-font); }
${w} .ap-range-meta { grid-area:meta;display:flex;align-items:center;gap:6px;color:var(--ap-sec); }
${w} .ap-range-init { grid-area:init;justify-self:end;font:500 13px/18px var(--ap-font);color:var(--ap-ink); }
${w} .ap-range-init.ap-none { font-weight:400;color:var(--ap-ter); }
${w} .ap-range-lo { grid-area:lo;color:var(--ap-sec);font-size:11.5px; }
${w} .ap-range-hi { grid-area:hi;justify-self:end;color:var(--ap-sec);font-size:11.5px; }
${w} .ap-range-track { grid-area:track;position:relative;height:4px;border-radius:2px;background:var(--ck-n300); }
${w} .ap-range-track i { position:absolute;top:-4px;width:2px;height:12px;margin-left:-1px;border-radius:1px;background:var(--ap-ink); }

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
/* Configuration is a document in the main pane, with compact supporting sections. */
${w} .ap-viewer.ap-configuration { display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;overflow:auto;padding:16px 20px 28px;background:var(--ck-n100); }
${w} .ap-configuration, ${w} .ap-decision-view { --ap-card-bg:#fff; }
${w} .ap-card { isolation:isolate;box-sizing:border-box;padding:12px; }
${w} .ap-card-head { display:block;margin-bottom:8px; }
${w} .ap-card-head h3 { margin:0;font:600 13px/18px var(--ap-font);color:var(--ap-ink); }
${w} .ap-card-head p { margin:0;font:12px/15px var(--ap-font);color:var(--ap-ter); }
${w} .ap-card .ap-text { color:var(--ap-sec);font:12px/16px var(--ap-font); }
${w} .ap-card .ap-facts { grid-template-columns:minmax(0,1fr) auto;gap:3px 16px;font:12.5px/18px var(--ap-font); }
${w} .ap-card .ap-facts + .ap-text { margin-top:6px; }
${w} .ap-card .ap-text + .ap-table { margin-top:8px; }
${w} .ap-card .ap-text + .ap-ranges { margin-top:4px; }
${w} .ap-range-note { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
${w} .ap-wave { margin:6px 0 8px; }
${w} .ap-wave figcaption { margin:0 0 3px;font:11.5px/15px var(--ap-font);color:var(--ap-sec); }
${w} .ap-wave svg { display:block;width:100%;height:28px;overflow:visible; }
${w} .ap-viewer.ap-decision-view { display:flex;flex-direction:column;gap:10px;overflow:auto;padding:16px 20px 28px; }
${w} .ap-decision-view > .ap-card { position:relative;flex:none; }
${w} .ap-table tr.ap-strong td { font-weight:600;background:color-mix(in srgb, var(--ap-ink) 4%, transparent); }
${w} .ap-steps { margin-top:4px; }
${w} .ap-steps std-stepper { display:block;--step-marker-size:18px;--step-marker-font-size:10px;--step-marker-color:var(--ap-sec);--step-marker-bg:var(--ap-card-bg);--step-marker-border:1px solid var(--ap-line);--step-rail-width:1.5px;--step-rail-color:var(--ap-line);--step-spacing:12px;--step-gap:10px;--step-title-size:13px;--step-title-color:var(--ap-ink);--step-title-muted-color:var(--ap-ink);--step-body-size:12px;--step-body-color:var(--ap-sec);--step-meta-size:11.5px;--step-meta-color:var(--ap-ter);--step-row-current-bg:transparent;--step-row-hover-bg:transparent; }
${w} .ap-step-body p { margin:0;font:12px/17px var(--ap-font);color:var(--ap-sec); }
${w} .ap-step-body ul { margin:2px 0 4px;padding-left:16px;font:12px/17px var(--ap-font);color:var(--ap-sec); }
${w} .ap-step-body li { margin:0;padding:0; }
${w} .ap-step-body b { font-weight:600;color:var(--ap-ink); }
${w} .ap-card .ap-text.ap-prose { margin:2px 0 0;font:13px/20px var(--ap-font);color:var(--ap-ink); }
${w} .ap-footnote { margin:14px 0 0;font:11px/16px var(--ap-font);color:var(--ap-ter);overflow-wrap:anywhere; }
${w} .ap-wave line { stroke:var(--ap-line);stroke-width:1;vector-effect:non-scaling-stroke; }
${w} .ap-wave polyline { fill:none;stroke:var(--ap-sec);stroke-width:1.5;stroke-linejoin:round;vector-effect:non-scaling-stroke; }
${w} .ap-card .ap-table + .ap-text { margin-top:6px; }
${w} .ap-card .ap-text + .ap-wave { margin-top:8px; }
${w} .ap-card .ap-table td { padding:3px 0; }
${w} .ap-card .ap-table tr:last-child td { border-bottom:0; }
${w} .ap-card .ap-table tr.ap-dim td { padding-top:0;font-size:11px;line-height:16px; }
${w} .ap-facts dt, ${w} .ap-facts dd { overflow-wrap:anywhere; }
${w} .ap-dname { margin:0 0 8px;font:600 16px/22px var(--ap-font); }
${w} .ap-status { margin:0 0 20px;font:12px/18px var(--ap-font);color:var(--ap-sec); }
${w} .ap-pairing { margin:12px 0;padding:16px;border:1px solid var(--ap-line);border-radius:12px;background:var(--ck-n100); }
${w} .ap-pairing h5 { margin:0;font:600 14px/20px var(--ap-font);overflow-wrap:anywhere; }
${w} .ap-pair-client { margin:3px 0 16px;font:12px/18px var(--ap-font);color:var(--ap-sec);overflow-wrap:anywhere; }
${w} .ap-pair-code { display:block;white-space:nowrap;word-break:normal;overflow-wrap:normal;font:600 24px/32px var(--ck-mono);letter-spacing:.04em;user-select:all; }
${w} .ap-pair-expiry { display:block;margin:4px 0 12px;font:12px/18px var(--ap-font);color:var(--ap-sec); }
${w} .ap-pair-actions { display:flex;gap:8px;margin-top:16px;flex-wrap:wrap; }
${w} .ap-pair-actions > span { flex:1 1 auto; }
${w} .ap-pair-actions std-button { display:flex;justify-content:center;min-height:36px; }
${w} ::selection { background:var(--ck-selected);color:var(--ap-ink); }
${w} :focus-visible { outline:2px solid var(--ck-focus);outline-offset:3px; }
@media (max-width:639px) {
  ${w} .ap-viewer.ap-configuration { padding:12px 12px 24px; }
  ${w} .ap-toolbar { align-items:flex-start; }
  ${w} .ap-crumb { overflow-wrap:anywhere; }
}

${newProjectStyles(w)}
`;
}
