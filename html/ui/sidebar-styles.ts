/** App-local rail and panel header alignment; the cookbook still owns panel layout. */
export function sidebarStyles(w: string): string {
  return `
.ck-app[data-cookbook] .ck-panels:has(.ap-sidebar) { --ck-side-width:320px; }
.ck-app[data-cookbook] .ck-sidebar:has(.ap-sidebar) > .ck-panel-body { overflow:hidden;padding:0; }
.ck-app[data-cookbook]:has(.ap-sidebar) .ck-status { display:none; }
/* One 48px band, one 12px text inset, across all three separate panels. */
.ck-app[data-cookbook]:has(.ap-sidebar) .ck-panel-header,
.ck-app[data-cookbook]:has(.ap-sidebar) .ap-toolbar {
  box-sizing:border-box;flex:0 0 48px;height:48px;min-height:48px;padding:0 12px;
  box-shadow:inset 0 -1px 0 var(--ap-line);align-items:center;flex-wrap:nowrap;
}
.ck-app[data-cookbook]:has(.ap-sidebar) .ck-toggle { top:8px; }
.ck-app[data-cookbook]:has(.ap-sidebar) .ck-panel-heading { min-height:48px;padding-left:0;font:600 13px/18px var(--ap-font); }
.ck-app[data-cookbook]:has(.ap-sidebar) .ck-details .ck-panel-heading { padding-right:40px; }
.ck-app[data-cookbook]:has(.ap-sidebar) .ck-panels[data-details] .ck-details-toggle { right:8px; }
.ck-app[data-cookbook]:has(.ap-sidebar) .ap-crumb { flex-wrap:nowrap;overflow:hidden;font:600 13px/18px var(--ap-font); }
.ck-app[data-cookbook]:has(.ap-sidebar) .ap-crumb > :not(.ap-sep) { white-space:nowrap; }
.ck-app[data-cookbook]:has(.ap-sidebar) .ap-crumb b { padding-left:0;overflow:hidden;text-overflow:ellipsis; }
.ck-app[data-cookbook]:has(.ap-sidebar) .ap-crumb > :not(:first-child):not(.ap-sep) { flex-shrink:0;max-width:50%; }
.ck-app[data-cookbook]:has(.ap-sidebar) .ck-panels:not([data-sidebar]) .ap-toolbar { padding-left:44px; }
.ck-app[data-cookbook]:has(.ap-sidebar) .ck-panels:not([data-details]) .ap-toolbar { padding-right:44px; }
.ck-app[data-cookbook] .ck-panels[data-ap-setup-only] .ck-details,
.ck-app[data-cookbook] .ck-panels[data-ap-setup-only] .ck-details-toggle { display:none; }
.ck-app[data-cookbook] .ck-panels[data-ap-setup-only] .ck-main { right:0; }
.ck-app[data-cookbook] .ck-panels[data-ap-setup-only] .ap-toolbar { padding-right:12px; }
@media (max-width:1100px) and (min-width:640px) { .ck-app[data-cookbook] .ck-panels:has(.ap-sidebar) { --ck-side-width:280px; } }
@media (max-width:639px) { .ck-app[data-cookbook] .ck-panels:has(.ap-sidebar) { --ck-side-width:100%; } }

${w}.ap-sidebar { display:flex;min-height:0;height:100%;overflow:hidden;--rail-inset:12px;--divider:var(--ap-line); }
/* The frame owns the grey surface; suppress the rail's white page fallback
   and scroll gradients. Keep the 12px text column inside full-width rows. */
${w} > std-rail {
  min-width:0;--rail-bg:transparent;--rail-shadow:transparent;--rail-inset:12px;
  --rail-body-padding:8px 0 12px;--rail-body-padding-top:8px;
}
${w} .ap-projects {
  margin-top:12px;padding-top:16px;border-top:1px solid var(--ap-line);
  /* Cookbook text uses full em sizes; the kit otherwise needs absent cap metrics. */
  --cap-height:0;--baseline:0;--rail-section-size:10.5px;--rail-section-color:var(--ap-ter);--rail-section-case:uppercase;
  --rail-section-tracking:.07em;--rail-section-weight:600;--rail-section-head-gap:8px;
}
${w} std-tree-list.ap-tree {
  --tree-inset-preset:var(--rail-inset);--tree-row-height-preset:26px;--tree-row-gap-preset:1px;
  --tree-name-size-preset:var(--text-9px);--tree-indent-preset:22px;
  --tree-bg-hover-preset:var(--ck-hover);--tree-bg-selected-preset:var(--ck-selected);
  width:100%;min-width:100%;
}
${w} .ap-tree [data-ap-icon], ${w} .ap-tree .ap-lead, ${w} .ap-tree .ap-lead svg { width:13px!important;height:13px!important; }
${w} .ap-nav-row {
  box-sizing:border-box;display:flex;align-items:center;gap:9px;width:100%;height:27px;padding:0 8px 0 var(--rail-inset);
  border:0;border-radius:5px;background:transparent;color:var(--ap-sec);font:400 13px/18px var(--ap-font);text-align:left;cursor:pointer;
}
${w} .ap-nav-row:hover:not(:disabled) { background:var(--ck-hover); }
${w} .ap-nav-row[aria-pressed=true] { background:var(--ck-selected);color:var(--ap-ink); }
${w} .ap-nav-row:disabled { color:var(--ap-ter);cursor:default; }
${w} .ap-nav-row > svg, ${w} .ap-nav-row [data-ap-icon] { width:13px!important;height:13px!important;flex:none; }
${w} .ap-nav-row .ap-badge { margin-left:auto; }
${w} .ap-devices { --ap-danger:#c53030; }
${w} .ap-new-project { margin-bottom:0; }
${w} button:focus-visible { outline:2px solid var(--ck-focus);outline-offset:-2px; }
`;
}
