import { invert, type Mode } from "./flip.ts";
import { reducedMotion } from "./dom.ts";

/**
 * FLIP for panel toggles: measure the targets, apply the layout change in one
 * synchronous step, measure again, then play each target back from where it
 * was drawn. Rects include in-flight transforms, so reversing mid-motion
 * starts from what is on screen instead of snapping.
 */
export class Motion {
  private animations = new Set<Animation>();
  constructor(private targets: () => readonly (readonly [Element, Mode])[]) {}

  cancel(): void {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
  }

  reflow(change: () => void, enabled = true): void {
    if (!enabled || reducedMotion()) {
      this.cancel();
      change();
      return;
    }
    const targets = this.targets();
    const first = targets.map(([el]) => el.getBoundingClientRect());
    this.cancel();
    change();
    const last = targets.map(([el]) => el.getBoundingClientRect());
    targets.forEach(([el, mode], i) => {
      const from = invert(first[i], last[i], mode);
      if (!from) return;
      const animation = el.animate([{ transform: from }, { transform: "none" }], {
        duration: 360,
        easing: "cubic-bezier(.16,1,.3,1)",
      });
      this.animations.add(animation);
      animation.finished.then(() => this.animations.delete(animation), () => {});
    });
  }
}
