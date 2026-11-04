import {
  clampSlide,
  type DeckBar,
  type DeckBody,
  type DeckSlide,
  type DeckStat,
} from "./deck-data.ts";
import { renderLines, renderProfile, renderUncertainty } from "./deck-charts.ts";
import { h } from "./dom.ts";
import { createTexture } from "./texture.ts";

export type Deck = {
  readonly el: HTMLElement;
  readonly index: number;
  go(index: number): void;
  step(delta: number): void;
};

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const easeInSine = (p: number) => 1 - Math.cos(p * Math.PI / 2);

/** Position and depth share the fractional page index, as in std-carousel.
 * Out-of-range calls retain std-carousel parity: edge pages approach a third
 * of a page of overscroll. The live adapter clamps idx and uses deckPull. */
export function deckTransforms(
  idx: number,
  count: number,
): { progress: number; translate: number; scale: number }[] {
  if (!Number.isFinite(idx) || !Number.isInteger(count) || count < 0) {
    throw new RangeError("Invalid deck transform bounds");
  }
  return Array.from({ length: count }, (_, i) => {
    let diff = i - idx;
    if (idx < 0 && i === 0) diff = (1 - Math.exp(-diff)) / 3;
    else if (idx > count - 1 && i === count - 1) {
      diff = -(1 - Math.exp(-Math.abs(diff))) / 3;
    }
    const progress = Math.max(0, 1 - Math.abs(i - idx));
    return {
      progress,
      translate: diff,
      scale: lerp(.95, 1, easeInSine(progress)),
    };
  });
}

/** The clamped pages share one bounded edge pull, matching Hacks' adapter. */
export function deckPull(
  position: number,
  count: number,
): { offset: number; scale: number } {
  const excess = position - Math.max(0, Math.min(count - 1, position));
  const offset = -Math.sign(excess) * .22 *
    (1 - Math.exp(-Math.abs(excess) / .55));
  return { offset, scale: 1 - .05 * Math.abs(offset) / .22 };
}

/** Each page translates and scales together. The stationary texture well
 * stays beneath the pages, including the shared layer's endpoint pulls. */
export function createDeck(slides: readonly DeckSlide[]): Deck {
  const count = slides.length;
  const el = h("section", "ck-deck", {
    "aria-label": "Pitch deck",
    "aria-roledescription": "carousel",
  });
  const viewport = h("div", "ck-deck-viewport");
  const texture = createTexture();
  const track = h("div", "ck-deck-track");
  const pages = slides.map((slide, i) =>
    h("div", "ck-deck-page", {
      role: "group",
      "aria-roledescription": "slide",
      "aria-label": `${i + 1} of ${count}`,
    }, renderSlide(slide))
  );
  track.append(...pages);
  viewport.append(texture.el, track);
  const counter = h("span", "ck-deck-counter", { "aria-hidden": "true" });
  const prev = h("button", "ck-deck-arrow", {
    type: "button",
    "aria-label": "Previous slide",
  }, "←");
  const next = h("button", "ck-deck-arrow", {
    type: "button",
    "aria-label": "Next slide",
  }, "→");
  const status = h("span", "ck-sr-only", { role: "status" });
  el.append(
    viewport,
    h(
      "nav",
      "ck-deck-controls",
      { "aria-label": "Choose slide" },
      counter,
      h("div", "ck-deck-arrows", null, prev, next),
    ),
    status,
  );

  let index = 0;
  let position = 0;
  let revision = 0;
  let suppressClickUntil = 0;
  const animations = new Map<HTMLElement, Animation>();
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  const events = new AbortController();
  const { signal } = events;
  const moving = (on: boolean) => {
    el.toggleAttribute("data-moving", on);
    texture.setRunning(on);
  };
  const cancelAnimations = () => {
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
  };

  function render(
    idx: number,
    animate: boolean,
    duration = 500,
    easing = "ease",
  ): void {
    const ownRevision = ++revision;
    const animated = animate && !media.matches;
    const elements = [track, ...pages];
    // Capture every displayed transform before cancelling an interrupted move.
    const from = elements.map((page) => getComputedStyle(page).transform);
    const interrupted = animations.size > 0;
    cancelAnimations();
    position = Math.max(0, Math.min(count - 1, idx));
    const pull = deckPull(idx, count);
    const transforms = [
      `translateX(${pull.offset * 100}%) scale(${pull.scale})`,
      ...deckTransforms(position, count).map(({ translate, scale }) =>
        `translate(${translate * 100}%, 0) scale(${scale})`
      ),
    ];
    const exposed = idx !== index || pull.offset !== 0 || animated &&
        (interrupted ||
          elements.some((page, i) => page.style.transform !== transforms[i]));
    moving(exposed);
    // As in Hacks, drag rounding and corner settling have independent timing.
    const radius =
      !animate && (!Number.isInteger(position) || pull.offset !== 0) &&
        !media.matches
        ? "24px"
        : "0px";
    for (const page of pages) {
      page.style.transitionDuration = `${
        media.matches ? 0 : animate ? duration * 5 : 800
      }ms`;
      page.style.borderRadius = radius;
    }
    elements.forEach((page, i) => {
      page.style.transform = transforms[i];
      if (!animated || !exposed) return;
      const own = page.animate([{ transform: from[i] }, {
        transform: transforms[i],
      }], {
        duration,
        easing: i === 0 ? "cubic-bezier(.16,1,.3,1)" : easing,
      });
      animations.set(page, own);
    });
    if (animated && exposed) {
      Promise.allSettled(
        [...animations.values()].map((animation) => animation.finished),
      ).then(() => {
        if (ownRevision !== revision) return;
        animations.clear();
        moving(false);
      });
    }
  }

  function update(): void {
    pages.forEach((page, i) => {
      page.inert = i !== index;
      page.setAttribute("aria-hidden", String(i !== index));
    });
    counter.textContent = `${index + 1} / ${count}`;
    prev.disabled = index === 0;
    next.disabled = index === count - 1;
    status.textContent = `Slide ${index + 1} of ${count}`;
  }

  function go(target: number, duration = 500): void {
    endDrag();
    index = clampSlide(target, count);
    update();
    render(index, true, duration);
  }
  prev.addEventListener("click", () => go(index - 1), { signal });
  next.addEventListener("click", () => go(index + 1), { signal });

  let drag: {
    id: number;
    x0: number;
    y0: number;
    start: number;
    width: number;
    active: boolean;
  } | null = null;
  let restoreSelection: (() => void) | null = null;
  function endDrag(): void {
    const previous = drag;
    drag = null;
    el.toggleAttribute("data-dragging", false);
    restoreSelection?.();
    restoreSelection = null;
    if (previous && viewport.hasPointerCapture(previous.id)) {
      viewport.releasePointerCapture(previous.id);
    }
  }
  function recover(): void {
    const previous = drag;
    endDrag();
    if (previous?.active) go(Math.round(position), 200);
  }
  const ownsPointer = (event: Event) =>
    event.composedPath().some((target) =>
      target instanceof Element &&
      target.matches(
        "a,button,input,textarea,select,[contenteditable=true],[data-carousel-interactive]",
      )
    );
  viewport.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || ownsPointer(event)) return;
    recover();
    drag = {
      id: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      start: Math.round(position),
      width: Math.max(1, viewport.clientWidth),
      active: false,
    };
  }, { signal });
  window.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      recover();
      return;
    }
    const dx = event.clientX - drag.x0, dy = event.clientY - drag.y0;
    if (!drag.active) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        endDrag();
        return;
      }
      if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (animations.size && pages[0]) {
        const shown = new DOMMatrixReadOnly(
          getComputedStyle(pages[0]).transform,
        );
        drag.start = Math.max(0, Math.min(count - 1, -shown.m41 / drag.width));
      }
      drag.active = true;
      const style = document.documentElement.style;
      const saved = ["user-select", "-webkit-user-select"].map((property) => ({
        property,
        value: style.getPropertyValue(property),
        priority: style.getPropertyPriority(property),
      }));
      saved.forEach(({ property }) =>
        style.setProperty(property, "none", "important")
      );
      restoreSelection = () =>
        saved.forEach(({ property, value, priority }) => {
          if (value) style.setProperty(property, value, priority);
          else style.removeProperty(property);
        });
      getSelection()?.removeAllRanges();
      el.toggleAttribute("data-dragging", true);
      try {
        viewport.setPointerCapture(event.pointerId);
      } catch { /* Synthetic or cancelled pointer. */ }
    }
    render(drag.start - dx / drag.width, false);
  }, { signal, passive: true });
  viewport.addEventListener("touchmove", (event) => {
    if (drag?.active && event.touches.length === 1 && event.cancelable) {
      event.preventDefault();
    }
  }, { signal, passive: false, capture: true });
  document.addEventListener("selectstart", (event) => {
    if (drag?.active) event.preventDefault();
  }, { signal, capture: true });
  window.addEventListener("pointerup", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const previous = drag;
    endDrag();
    if (!previous.active) return;
    const progress = (previous.x0 - event.clientX) / previous.width;
    suppressClickUntil = performance.now() + 250;
    go(
      Math.round(previous.start) +
        (Math.abs(progress) >= .15 ? Math.sign(progress) : 0),
      300,
    );
  }, { signal });
  window.addEventListener("pointercancel", (event) => {
    if (drag?.id === event.pointerId) recover();
  }, { signal });
  viewport.addEventListener("lostpointercapture", (event) => {
    if (event.composedPath()[0] === viewport && event.pointerId === drag?.id) {
      recover();
    }
  }, { signal });
  viewport.addEventListener("click", (event) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, { signal, capture: true });
  window.addEventListener("blur", recover, { signal });
  window.addEventListener("pagehide", recover, { signal });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) recover();
  }, { signal });
  el.addEventListener("keydown", (event) => {
    if (
      event.composedPath().some((target) =>
        target instanceof Element &&
        target.matches(
          "input,textarea,select,[contenteditable=true],[data-carousel-interactive]",
        )
      )
    ) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape" && drag?.active) {
      recover();
      event.preventDefault();
    }
  }, { signal });
  const resize = new ResizeObserver(() => {
    if (drag && Math.abs(viewport.clientWidth - drag.width) > 1) recover();
  });
  resize.observe(viewport);
  media.addEventListener("change", () => {
    if (media.matches) {
      recover();
      render(index, false);
    }
  }, { signal });
  update();
  render(index, false);
  return {
    el,
    get index() {
      return index;
    },
    go,
    step: (delta) => go(index + delta),
  };
}

const mark = `<svg viewBox="0 0 56 40" width="56" height="40" aria-hidden="true" focusable="false">
  <circle cx="14" cy="20" r="11"/><circle cx="33" cy="20" r="8" opacity=".55"/><circle cx="47" cy="20" r="5.5" opacity=".3"/></svg>`;

function renderSlide(slide: DeckSlide): HTMLElement {
  const eyebrow = h("div", "ck-slide-eyebrow");
  if ("icon" in slide.eyebrow) eyebrow.innerHTML = mark;
  else eyebrow.append(h("p", "ck-slide-label", null, slide.eyebrow.label));
  const lead = h(
    "div",
    "ck-slide-frame ck-slide-lead",
    null,
    eyebrow,
    h("h2", "ck-slide-title", null, slide.title),
    h("p", "ck-slide-description", null, slide.description),
  );
  return h("section", "ck-slide" + ("icon" in slide.eyebrow ? " ck-hook" : ""), null, lead, renderBody(slide.body));
}

function renderBody(body: DeckBody): HTMLElement {
  const frame = (...children: Node[]) => h("div", "ck-slide-frame ck-slide-body", null, ...children);
  switch (body.kind) {
    case "actions":
      return frame(...actions(body.primary), ...stats(body.stats));
    case "person":
      return frame(
        h(
          "div",
          "ck-person",
          null,
          h("span", "ck-avatar"),
          h("div", "", null, h("p", "ck-person-name", null, body.name), h("p", "ck-slide-label", null, body.role)),
        ),
      );
    case "breakdown": {
      const segments = h("div", "ck-segments");
      for (const segment of body.segments) {
        const part = h("div", "ck-segment" + (segment.emphasis ? " ck-emphasis" : ""), null, h("i"));
        part.style.flex = `${segment.share} 1 0`;
        if (segment.label) part.append(h("p", "ck-slide-label", null, segment.label));
        segments.append(part);
      }
      return frame(...stats(body.stats), segments);
    }
    case "comparison": {
      const head = h(
        "tr",
        "",
        null,
        h("th"),
        ...body.columns.map((c) => h("th", "", null, h("span", "ck-slide-label", null, c))),
      );
      const rows = body.rows.map((row) =>
        h(
          "tr",
          "",
          null,
          h("td", "ck-row-label", null, row.label),
          h("td", "ck-before", null, row.before),
          h("td", "ck-after", null, row.after),
        )
      );
      return frame(h("table", "ck-cmp", null, h("thead", "", null, head), h("tbody", "", null, ...rows)));
    }
    case "demo":
      return h(
        "div",
        "ck-slide-wide ck-slide-body",
        null,
        h("div", "ck-demo-panel", null, h("p", "ck-slide-label", null, body.caption)),
      );
    case "result":
      return frame(bars(body.bars), ...actions(body.primary));
    case "lines":
      return frame(renderLines(body));
    case "profile":
      return frame(renderProfile(body));
    case "uncertainty":
      return frame(renderUncertainty(body));
  }
}

function actions(primary: { label: string; href: string } | null): HTMLElement[] {
  return primary
    ? [h("div", "ck-slide-actions", null, h("a", "ck-button-primary", { href: primary.href }, primary.label))]
    : [];
}

function stats(list: DeckStat[]): HTMLElement[] {
  if (!list.length) return [];
  return [
    h(
      "dl",
      "ck-stats",
      null,
      ...list.map((s) =>
        h("div", "ck-stat", null, h("dt", "ck-stat-value", null, s.value), h("dd", "ck-stat-label", null, s.label))
      ),
    ),
  ];
}

function bars(list: DeckBar[]): HTMLElement {
  const grid = h("div", "ck-bars");
  for (const bar of list) {
    const fill = h("div", "ck-fill");
    fill.style.width = `${Math.max(2, Math.min(100, bar.share))}%`;
    const tone = bar.emphasis ? "ck-emphasis" : "";
    grid.append(
      h("div", tone, null, h("p", "ck-slide-label", null, bar.label)),
      h("div", "ck-track " + tone, null, fill),
      h("div", tone, null, h("p", "ck-bar-value", null, bar.value)),
    );
  }
  return grid;
}
