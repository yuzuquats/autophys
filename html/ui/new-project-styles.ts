export function newProjectStyles(w: string): string {
  return `
${w} .ap-viewer.ap-project-setup { display:flex;flex-direction:column;gap:20px;padding:32px; }
${w} .ap-project-setup h2 { margin:0;font:600 24px/30px var(--ap-font);letter-spacing:-.025em; }
${w} .ap-project-setup std-stepper { min-width:0;max-width:100%; --step-gap:12px;--step-spacing:24px;--step-title-size:var(--text-10px);--step-marker-size:22px;--step-marker-font-size:var(--text-8px);--step-body-gap:8px;--step-rail-width:1px;--divider:var(--ap-line);--step-row-current-bg:rgb(0 0 0 / 5%); }
${w} .ap-project-setup [data-ap-step-body] { display:flex;flex-direction:column;gap:10px;min-width:0;max-width:640px;outline:none; }
${w} .ap-project-setup .ap-code-head { margin-top:2px; }
${w} .ap-project-setup .ap-setup-command { white-space:pre;border:1px solid var(--ap-line); }
${w} .ap-project-setup .ap-pairing { margin:0;background:var(--bg); }
${w} .ap-setup-choice { display:inline-flex;align-self:flex-start;padding:2px;gap:2px;border:1px solid var(--ap-line);border-radius:8px;background:var(--ck-n100); }
${w} .ap-setup-option { min-width:76px;min-height:30px;padding:4px 14px;border:0;border-radius:6px;background:transparent;color:var(--ap-sec);font:500 13px/20px var(--ap-font);cursor:pointer; }
${w} .ap-setup-option[aria-pressed="true"] { background:var(--bg);color:var(--ap-ink);box-shadow:0 1px 2px rgb(0 0 0 / 12%); }
${w} .ap-setup-option:focus-visible { outline:2px solid var(--ap-ink);outline-offset:1px; }
${w} .ap-setup-waiting { display:flex;align-items:center;gap:8px;margin:0;color:var(--ap-sec);font:13px/20px var(--ap-font); }
${w} .ap-setup-dot { width:8px;height:8px;flex:none;border-radius:50%;background:var(--ap-run); }
${w} .ap-setup-actions { display:flex;gap:10px;flex-wrap:wrap; }
@media (max-width:639px) { ${w} .ap-viewer.ap-project-setup { padding:20px 16px; } ${w} .ap-project-setup h2 { font-size:22px;line-height:28px; } ${w} .ap-setup-option { min-height:36px; } }
`;
}
