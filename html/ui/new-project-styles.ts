export function newProjectStyles(w: string): string {
  return `
${w} .ap-viewer.ap-project-setup { display:flex;flex-direction:column;gap:20px;padding:32px; }
${w} .ap-project-setup h2 { margin:0;font:600 24px/30px var(--ap-font);letter-spacing:-.025em; }
${w} .ap-project-setup std-stepper { min-width:0;max-width:100%; --step-gap:12px;--step-spacing:24px;--step-title-size:var(--text-10px);--step-marker-size:22px;--step-marker-font-size:var(--text-8px);--step-body-gap:8px;--step-rail-width:1px;--divider:var(--ap-line);--step-row-current-bg:rgb(0 0 0 / 5%); }
${w} .ap-project-setup [data-ap-step-body] { display:flex;flex-direction:column;gap:10px;min-width:0; }
${w} .ap-setup-fields { display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:16px;max-width:620px; }
${w} .ap-setup-fields label { display:flex;flex-direction:column;gap:6px;font:500 12px/18px var(--ap-font); }
${w} .ap-setup-fields .ap-setup-unit { color:var(--ap-sec);white-space:nowrap; }
${w} .ap-setup-fields input { box-sizing:border-box;min-width:0;width:100%;padding:10px 12px;border:1px solid var(--ap-line);border-radius:6px;color:var(--ap-ink);background:var(--bg);font:14px/20px var(--ap-font); }
${w} .ap-setup-fields input:focus-visible { outline:2px solid var(--ap-ink);outline-offset:2px; }
${w} .ap-setup-actions { display:flex;gap:10px;flex-wrap:wrap; }
@media (max-width:639px) { ${w} .ap-viewer.ap-project-setup { padding:20px 16px; } ${w} .ap-project-setup h2 { font-size:22px;line-height:28px; } }
`;
}
