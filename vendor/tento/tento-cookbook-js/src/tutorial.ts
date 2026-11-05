import { Stepper } from "./model.ts";
import { h, settleIn } from "./dom.ts";

/** What a step points at: selectors (the first visible match of each), or
 * functions for elements a selector cannot reach, such as rows inside a
 * shadow tree. Every visible target is highlighted while the step shows. */
export type TutorialTarget = string | (() => Element | null);

/** A step: a short title, two lines of body, and the part of the app it
 * points at. */
export type TutorialStep = {
  title: string;
  body: string;
  target?: readonly TutorialTarget[];
  /** Runs each time the step shows, forwards or back, before its targets are
   * found: select a row, open a panel. Back re-runs it, so paging is deterministic. */
  enter?(): void;
  /** Fills the sheet's left column once the targets are found, for example
   * with a clipped copy of them. Steps without it leave the column out. */
  preview?(targets: readonly HTMLElement[], slot: HTMLElement): void;
  /** Consecutive steps with the same group share one progress bar, as the
   * parts of a two-part step. */
  group?: string;
};

/** Steps fixed up front, or a tour the app builds when it starts (on demo
 * data, say) and takes down when it ends. */
export type TutorialSource = readonly TutorialStep[] | {
  start(): readonly TutorialStep[] | Promise<readonly TutorialStep[]>;
  /** Runs once when the tour ends, however it ends. `completed` is true
   * after Done or stepping past the last step. */
  finish?(result: { completed: boolean }): void;
};

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
  /** Show the steps from the first (building them, for a source that does). */
  start(): void;
  /** End the tour: remove the highlight and run the source's finish. */
  clear(): void;
  /** One step forwards (as Next does) or backwards; false past either end. */
  step(delta: number): boolean;
  /** Runs on Done and on the close button. */
  onDone: (() => void) | null;
};

/** The tour, drawn on the lowered deck surface's peek. Each step points at
 * its part of the app directly: it runs its enter action, scrolls its targets
 * into view and highlights them, with an optional preview on the left. */
export function createTutorial(source: TutorialSource): Tutorial {
  const el = h("div", "ck-tour", { role: "group", "aria-label": "Getting started" });
  el.innerHTML =
    `<button type="button" class="ck-tour-dismiss" aria-label="Close tutorial"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
    <div class="ck-tour-preview" aria-hidden="true" inert></div>
    <div class="ck-tour-lesson"><div class="ck-tour-bars" role="img"></div><h2 class="ck-tour-title"></h2><p class="ck-tour-body" aria-live="polite"></p>
      <div class="ck-tour-actions"><button type="button" class="ck-tour-back">← Back</button><button type="button" class="ck-tour-next"></button></div></div>`;
  const q = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
  const bars = q<HTMLElement>(".ck-tour-bars"),
    title = q<HTMLElement>(".ck-tour-title"),
    body = q<HTMLElement>(".ck-tour-body"),
    preview = q<HTMLElement>(".ck-tour-preview");
  const back = q<HTMLButtonElement>(".ck-tour-back"), next = q<HTMLButtonElement>(".ck-tour-next");
  // A highlight stops above the sheet the tutorial sits on, so it marks only
  // the part of its target the reader can see.
  const rings = new TargetRings(() => el.parentElement?.getBoundingClientRect().top ?? innerHeight);
  let steps: readonly TutorialStep[] = [];
  let stepper: Stepper<TutorialStep> | null = null;
  let active = false, completed = false;
  /** Bumped when a tour starts or ends, and when a step shows; stale callbacks check it. */
  let session = 0, shown = 0;

  function render(animate: boolean): void {
    if (!stepper) return;
    const step = stepper.step, own = ++shown;
    preview.replaceChildren();
    const { bar, count, fill } = progress(steps, stepper.index);
    bars.dataset.count = String(count);
    bars.setAttribute("aria-label", `Step ${bar + 1} of ${count}`);
    bars.replaceChildren(...Array.from({ length: count }, (_, i) => {
      const b = h("b");
      b.style.width = `${i < bar ? 100 : i === bar ? fill * 100 : 0}%`;
      return h("i", "", null, b);
    }));
    title.textContent = step.title;
    body.textContent = step.body;
    back.hidden = stepper.index === 0;
    next.textContent = stepper.last ? "Done" : "Next →";
    if (animate) { for (const target of [title, body]) settleIn(target); }
    step.enter?.();
    // On the next frame (the enter action's selection and layout applied),
    // bring the targets into view and move the highlight onto them. The
    // preview column shows only when the step filled it.
    requestAnimationFrame(() => {
      if (own !== shown || !active) return;
      const found = targetsOf(step);
      for (const target of found) target.scrollIntoView({ block: "nearest", inline: "nearest" });
      rings.show(found);
      step.preview?.(found, preview);
      el.toggleAttribute("data-preview", preview.childElementCount > 0);
    });
  }

  function begin(list: readonly TutorialStep[]): void {
    if (!list.length) {
      api.onDone?.();
      return;
    }
    steps = list;
    stepper = new Stepper(list);
    render(false);
  }

  function end(): void {
    if (!active) return;
    active = false;
    session++;
    shown++;
    rings.hide();
    stepper = null;
    if (!isStepList(source)) source.finish?.({ completed });
  }

  const api: Tutorial = {
    el,
    start() {
      end();
      active = true;
      completed = false;
      const own = ++session;
      const list = isStepList(source) ? source : source.start();
      if (isStepList(list)) begin(list);
      else {
        void list.then((ready) => {
          if (own === session && active) begin(ready);
        });
      }
    },
    clear: end,
    step(delta) {
      if (!active || !stepper) return false;
      if (delta > 0 && stepper.last) {
        completed = true;
        return false;
      }
      const moved = delta > 0 ? stepper.advance() : stepper.back();
      // Arrow keys page through the steps: the text swaps in place, without the Next button's rise.
      if (moved) render(false);
      return moved;
    },
    onDone: null,
  };
  back.addEventListener("click", () => {
    if (stepper?.back()) render(true);
  });
  next.addEventListener("click", () => {
    if (!stepper) return;
    if (stepper.advance()) render(true);
    else {
      completed = true;
      api.onDone?.();
    }
  });
  q(".ck-tour-dismiss").addEventListener("click", () => api.onDone?.());
  return api;
}

function isStepList(value: unknown): value is readonly TutorialStep[] {
  return Array.isArray(value);
}

/** Which progress bar a step fills, and how far: consecutive steps with the
 * same group share one bar. */
export function progress(
  steps: readonly { group?: string }[],
  index: number,
): { bar: number; count: number; fill: number } {
  const bars: number[][] = [];
  steps.forEach((step, i) => {
    const prev = steps[i - 1];
    if (i > 0 && step.group !== undefined && step.group === prev?.group) bars[bars.length - 1].push(i);
    else bars.push([i]);
  });
  const bar = bars.findIndex((members) => members.includes(index));
  return { bar, count: bars.length, fill: (bars[bar].indexOf(index) + 1) / bars[bar].length };
}

function visible(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility === "visible";
}

/** Each target's element: a selector's first visible match, or what a
 * function returns. Hidden elements and duplicates are dropped. */
function targetsOf(step: TutorialStep): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const target of step.target ?? []) {
    if (typeof target === "function") {
      const el = target();
      if (el && visible(el)) found.add(el);
      continue;
    }
    for (const el of document.querySelectorAll(target)) {
      if (visible(el)) {
        found.add(el);
        break;
      }
    }
  }
  return [...found];
}

/** One ring per target, following its element every frame until hidden,
 * clipped at `limit` (the top of the tutorial's sheet). Ring nodes are kept
 * from step to step, so a highlight glides to its next target (CSS). */
class TargetRings {
  private rings: HTMLElement[] = [];
  private frame = 0;
  constructor(private limit: () => number) {}

  show(targets: readonly HTMLElement[]): void {
    cancelAnimationFrame(this.frame);
    while (this.rings.length > targets.length) this.rings.pop()!.remove();
    while (this.rings.length < targets.length) {
      // A new ring appears in place; only later moves glide.
      const ring = h("div", "ck-target-ring", { "aria-hidden": "true" });
      ring.style.transition = "none";
      document.body.append(ring);
      this.rings.push(ring);
      requestAnimationFrame(() => requestAnimationFrame(() => ring.style.transition = ""));
    }
    const pairs = targets.map((target, i) => {
      const ring = this.rings[i];
      const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 8;
      ring.style.borderRadius = `${radius + 4}px`;
      return [target, ring] as const;
    });
    const place = () => {
      const limit = this.limit() - 6;
      for (const [target, ring] of pairs) {
        const r = target.getBoundingClientRect();
        const top = r.top - 4, bottom = Math.min(r.bottom + 4, limit);
        ring.hidden = !target.isConnected || r.width === 0 || bottom - top < 8;
        Object.assign(ring.style, {
          left: `${r.left - 4}px`,
          top: `${top}px`,
          width: `${r.width + 8}px`,
          height: `${bottom - top}px`,
        });
      }
      this.frame = requestAnimationFrame(place);
    };
    if (pairs.length) place();
  }

  hide(): void {
    cancelAnimationFrame(this.frame);
    for (const ring of this.rings) ring.remove();
    this.rings = [];
  }
}
