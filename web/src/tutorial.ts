import { Stepper } from "./model.ts";
import { ease, h, reducedMotion, settleIn } from "./dom.ts";

/** A step: a short title, two lines of body, and optionally the element
 * "Show me" rings (selectors tried in order; the first visible match wins). */
export type TutorialStep = { title: string; body: string; target?: readonly string[] };

export const tourSteps: readonly TutorialStep[] = [
  {
    title: "The sidebar.",
    body: "Items in the workspace are listed here.",
    target: [".panel.sidebar .nav-list", ".sidebar-toggle"],
  },
  {
    title: "Details.",
    body: "This button shows or hides the panel for the selected item.",
    target: [".details-toggle"],
  },
  {
    title: "Your way home.",
    body: "Select autophys anytime to return to the deck.",
    target: [".site-header .brand"],
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
  const el = h("div", "tour", { role: "group", "aria-label": "Getting started" });
  el.innerHTML =
    `<button type="button" class="tour-dismiss" aria-label="Close tutorial"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
    <div class="tour-lesson"><div class="tour-bars" role="img"></div><h2 class="tour-title"></h2><p class="tour-body" aria-live="polite"></p>
      <div class="tour-actions"><button type="button" class="tour-show">Show me</button><button type="button" class="tour-next"></button></div></div>`;
  const q = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
  const bars = q<HTMLElement>(".tour-bars"),
    title = q<HTMLElement>(".tour-title"),
    body = q<HTMLElement>(".tour-body");
  const show = q<HTMLButtonElement>(".tour-show"), next = q<HTMLButtonElement>(".tour-next");
  const stepper = new Stepper(steps);
  const ring = new TargetRing();

  function render(animate: boolean): void {
    const step = stepper.step;
    ring.hide();
    bars.dataset.count = String(stepper.count);
    bars.setAttribute("aria-label", `Step ${stepper.index + 1} of ${stepper.count}`);
    bars.replaceChildren(...steps.map((_, i) => h("i", i <= stepper.index ? "on" : "")));
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
  q(".tour-dismiss").addEventListener("click", () => {
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
    const ring = this.ring = h("div", "target-ring", { "aria-hidden": "true" });
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
