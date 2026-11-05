/** Let the shell paint before rebuilding the workspace. Keep the previous
 * content visible until its replacement is ready; never insert a blank frame. */
export class ContentTransition {
  private frame = 0;
  private task: ReturnType<typeof setTimeout> | null = null;
  private saved: boolean[] | null = null;
  private disposed = false;

  constructor(private regions: HTMLElement[]) {}

  get pending(): boolean { return this.saved !== null; }

  defer(render: () => void, restored: () => void): void {
    if (this.disposed) return;
    this.cancelWork();
    this.saved ??= this.regions.map(region => region.inert);
    for (const region of this.regions) {
      region.inert = true;
    }
    // A timer from rAF runs after that frame paints. A microtask or a single
    // rAF would still rebuild the charts before the shell gets on screen.
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.task = setTimeout(() => {
        this.task = null;
        try { render(); }
        finally { this.release(); }
        restored();
      }, 0);
    });
  }

  private cancelWork(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.task !== null) clearTimeout(this.task);
    this.task = null;
  }

  private release(): void {
    const saved = this.saved;
    this.saved = null;
    this.regions.forEach((region, i) => {
      if (saved) region.inert = saved[i];
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelWork();
    this.release();
  }
}

export const contentTransitionStyles = (scope: string) => `
/* The drawer covers a full-height workbench; it never resizes its charts. */
${scope} .ck-main { bottom:0;transition:none; }
${scope} .ck-panels[data-open] .ck-main { opacity:1;visibility:visible; }
${scope} .ck-panel-body { padding-bottom:8px;transition:none; }
${scope} .ap-viewer { scroll-padding-bottom:calc(var(--ck-peek) + 12px); }
/* Keep the covered tail reachable without changing the viewer's dimensions. */
${scope} .ap-viewer::after { content:"";display:block;flex:none;grid-column:1/-1;height:var(--ck-peek); }
/* Panel toggles retain their independent docking motion. */
${scope} .ck-panel { transition:opacity 180ms ease-out,transform 240ms var(--ck-ease),visibility 0s linear 240ms; }
@media(max-width:760px) {
  ${scope} .ck-panels[data-mobile="sidebar"] .ck-main,
  ${scope} .ck-panels[data-mobile="details"] .ck-main { opacity:0;visibility:hidden; }
}
@media(prefers-reduced-motion:reduce) {
  ${scope} .ck-panel { transition:none !important; }
}
`;
