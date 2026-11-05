/** Let the shell paint its new layout before rebuilding the workspace.
 * Pending content is hidden and inert, then fades in without delaying input. */
export class ContentTransition {
  private frame = 0;
  private task: ReturnType<typeof setTimeout> | null = null;
  private animations: Animation[] = [];
  private saved: boolean[] | null = null;
  private disposed = false;

  constructor(private regions: HTMLElement[]) {}

  get pending(): boolean { return this.saved !== null; }

  defer(render: () => void, restored: () => void): void {
    if (this.disposed) return;
    this.cancelWork();
    this.saved ??= this.regions.map(region => region.inert);
    for (const region of this.regions) {
      region.setAttribute("data-ap-content-pending", "");
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
        const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
        this.animations = this.regions.map(region => region.animate(
          reduce ? [{ opacity: 0 }, { opacity: 1 }]
            : [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }],
          { duration: reduce ? 80 : 180, easing: "cubic-bezier(.16,1,.3,1)" },
        ));
      }, 0);
    });
  }

  private cancelWork(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.task !== null) clearTimeout(this.task);
    this.task = null;
    this.animations.forEach(animation => animation.cancel());
    this.animations = [];
  }

  private release(): void {
    const saved = this.saved;
    this.saved = null;
    this.regions.forEach((region, i) => {
      region.removeAttribute("data-ap-content-pending");
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
${scope} [data-ap-content-pending] { visibility:hidden !important; }
/* The panel frame moves immediately; the contents have their own short reveal. */
${scope} .ck-panel { transition:opacity 180ms ease-out,transform 240ms var(--ck-ease),visibility 0s linear 240ms; }
@media(prefers-reduced-motion:reduce) {
  ${scope} .ck-panel { transition:none !important; }
}
`;
