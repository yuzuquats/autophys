import { Stepper } from "./model.ts";
import { ease, h, reducedMotion, settleIn } from "./dom.ts";

/** A step: a short title, two lines of body, and optionally the element
 * "Show me" rings (selectors tried in order; the first visible match wins). */
export type TutorialStep = { title: string; body: string; target?: readonly string[] };

/** Steps for any cookbook app: they point only at the shell's own pieces. */
export const shellSteps: readonly TutorialStep[] = [
  {
    title: "The sidebar.",
    body: "Everything in the app is listed here.",
    target: [".ck-sidebar .ck-queue", ".ck-sidebar-toggle"],
  },
  {
    title: "Details.",
    body: "This button shows or hides the panel for what you selected.",
    target: [".ck-details-toggle"],
  },
  {
    title: "Your way home.",
    body: "Select the name at the top left anytime to return to the deck.",
    target: [".ck-header .ck-brand"],
  },
];

export type Tutorial = {
  readonly el: HTMLElement;
  /** Show the steps from the first. */
  start(): void;
  /** Remove the ring; call when the tutorial hides. */
  clear(): void;
  /** Runs on Done and on the close button. */
  onDone: (() => void) | null;
};

/** The first-visit tour, drawn on the lowered deck surface's peek. */
export function createTutorial(steps: readonly TutorialStep[]): Tutorial {
  const el = h("div", "ck-tour", { role: "group", "aria-label": "Getting started" });
  el.innerHTML =
    `<button type="button" class="ck-tour-dismiss" aria-label="Close tutorial"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
    <div class="ck-tour-lesson"><div class="ck-tour-bars" role="img"></div><h2 class="ck-tour-title"></h2><p class="ck-tour-body" aria-live="polite"></p>
      <div class="ck-tour-actions"><button type="button" class="ck-tour-show">Show me</button><button type="button" class="ck-tour-next"></button></div></div>`;
  const q = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
  const bars = q<HTMLElement>(".ck-tour-bars"),
    title = q<HTMLElement>(".ck-tour-title"),
    body = q<HTMLElement>(".ck-tour-body");
  const show = q<HTMLButtonElement>(".ck-tour-show"), next = q<HTMLButtonElement>(".ck-tour-next");
  const stepper = new Stepper(steps);
  const ring = new TargetRing();

  function render(animate: boolean): void {
    const step = stepper.step;
    ring.hide();
    bars.dataset.count = String(stepper.count);
    bars.setAttribute("aria-label", `Step ${stepper.index + 1} of ${stepper.count}`);
    bars.replaceChildren(...steps.map((_, i) => h("i", i <= stepper.index ? "ck-on" : "")));
    title.textContent = step.title;
    body.textContent = step.body;
    show.hidden = !step.target?.length;
    next.textContent = stepper.last ? "Done" : "Next →";
    if (animate) { for (const target of [title, body]) settleIn(target); }
  }

  const api: Tutorial = {
    el,
    start() {
      stepper.restart();
      render(false);
    },
    clear: () => ring.hide(),
    onDone: null,
  };
  show.addEventListener("click", () => {
    const target = stepper.step.target ? findVisible(stepper.step.target) : null;
    if (!target) return;
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    ring.show(target);
  });
  next.addEventListener("click", () => {
    if (stepper.advance()) render(true);
    else {
      ring.hide();
      api.onDone?.();
    }
  });
  q(".ck-tour-dismiss").addEventListener("click", () => {
    ring.hide();
    api.onDone?.();
  });
  render(false);
  return api;
}

function findVisible(selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility === "visible") return el;
    }
  }
  return null;
}

/** A ring over one element. It follows the element while shown and goes away
 * on the next press anywhere. */
class TargetRing {
  private ring: HTMLElement | null = null;
  private frame = 0;
  private stop: AbortController | null = null;

  show(target: HTMLElement): void {
    this.hide();
    const ring = this.ring = h("div", "ck-target-ring", { "aria-hidden": "true" });
    const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 8;
    ring.style.borderRadius = `${radius + 4}px`;
    document.body.append(ring);
    const place = () => {
      const r = target.getBoundingClientRect();
      if (!target.isConnected || r.width === 0) return this.hide();
      Object.assign(ring.style, {
        left: `${r.left - 4}px`,
        top: `${r.top - 4}px`,
        width: `${r.width + 8}px`,
        height: `${r.height + 8}px`,
      });
      this.frame = requestAnimationFrame(place);
    };
    place();
    if (!reducedMotion()) {
      ring.animate([{ opacity: 0, transform: "scale(1.06)" }, { opacity: 1, transform: "scale(1)" }], {
        duration: 260,
        easing: ease,
      });
    }
    const stop = this.stop = new AbortController();
    setTimeout(() => {
      if (!stop.signal.aborted) {
        document.addEventListener("pointerdown", () => this.hide(), {
          capture: true,
          once: true,
          signal: stop.signal,
        });
      }
    }, 0);
  }

  hide(): void {
    cancelAnimationFrame(this.frame);
    this.stop?.abort();
    this.stop = null;
    this.ring?.remove();
    this.ring = null;
  }
}
