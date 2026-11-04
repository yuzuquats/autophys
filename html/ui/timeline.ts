/// <reference lib="dom" />
/** Browser-only presentation clock. Derive supplies every label and transition time;
 * this element only advances those labels and owns its one pending callback.
 */
import type { TextStep } from "./view-model.ts";

export class LabelTimeline extends HTMLElement {
  private steps: TextStep[] = [];
  private started = 0;
  private timer: number | undefined;

  static makeWith(steps: TextStep[]): LabelTimeline {
    const el = document.createElement("ap-label-timeline") as LabelTimeline;
    el.steps = steps;
    el.started = Date.now();
    return el;
  }

  connectedCallback(): void { this.advance(); }
  disconnectedCallback(): void { this.cancel(); }

  private cancel(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private advance(): void {
    this.cancel();
    if (!this.isConnected) return;
    const elapsed = Date.now() - this.started;
    // Reconnecting or resuming a throttled tab jumps to the current supplied label.
    const index = this.steps.findLastIndex((step) => step.delayMs <= elapsed);
    this.textContent = this.steps[index]?.label ?? "";
    const next = this.steps[index + 1];
    if (next) this.timer = window.setTimeout(() => this.advance(), Math.max(1, next.delayMs - elapsed));
  }
}
customElements.define("ap-label-timeline", LabelTimeline);
