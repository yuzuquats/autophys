import {
  clampSlide,
  type DeckBar,
  type DeckBody,
  type DeckSlide,
  type DeckStat,
  dragOffset,
  swipeTarget,
} from "./deck-data.ts";
import { ease, h, reducedMotion } from "./dom.ts";

export type Deck = {
  readonly el: HTMLElement;
  readonly index: number;
  go(index: number): void;
  step(delta: number): void;
};

/**
 * The deck carousel. Slides sit side by side on one track; a move slides the
 * track while every page recedes into a rounded card over the grey well, then
 * the arriving page grows back to fill the screen. Buttons, arrow keys (wired
 * by the drawer) and horizontal swipes all go through `go`.
 */
export function createDeck(slides: readonly DeckSlide[]): Deck {
  const count = slides.length;
  const el = h("section", "ck-deck", { "aria-label": "Pitch deck", "aria-roledescription": "carousel" });
  const viewport = h("div", "ck-deck-viewport");
  const track = h("div", "ck-deck-track");
  const pages = slides.map((slide, i) =>
    h("div", "ck-deck-page", {
      role: "group",
      "aria-roledescription": "slide",
      "aria-label": `${i + 1} of ${count}`,
    }, renderSlide(slide))
  );
  track.append(...pages);
  viewport.append(track);
  const counter = h("span", "ck-deck-counter", { "aria-hidden": "true" });
  const prev = h("button", "ck-deck-arrow", { type: "button", "aria-label": "Previous slide" }, "←");
  const next = h("button", "ck-deck-arrow", { type: "button", "aria-label": "Next slide" }, "→");
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
  let animation: Animation | null = null;
  const offset = (i: number, dx = 0) => `translateX(${-i * viewport.clientWidth + dx}px)`;
  const moving = (on: boolean) => el.toggleAttribute("data-moving", on);

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

  function go(target: number): void {
    const from = getComputedStyle(track).transform;
    animation?.cancel();
    index = clampSlide(target, count);
    update();
    const to = offset(index);
    track.style.transform = to;
    if (reducedMotion()) {
      moving(false);
      return;
    }
    moving(true);
    const own = animation = track.animate([{ transform: from === "none" ? offset(0) : from }, {
      transform: to,
    }], {
      duration: 560,
      easing: ease,
    });
    own.finished.then(() => {
      if (animation !== own) return;
      animation = null;
      moving(false);
    }, () => {});
  }

  prev.addEventListener("click", () => go(index - 1));
  next.addEventListener("click", () => go(index + 1));

  // Horizontal swipes follow the pointer; vertical drags stay page scrolls.
  let drag:
    | { id: number; x0: number; y0: number; lastX: number; lastT: number; v: number; active: boolean }
    | null = null;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as Element).closest("a, button")) return;
    drag = {
      id: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      lastX: event.clientX,
      lastT: event.timeStamp,
      v: 0,
      active: false,
    };
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x0, dy = event.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
        drag = null;
        return;
      }
      if (Math.abs(dx) <= 8) return;
      drag.active = true;
      viewport.setPointerCapture(event.pointerId);
      // A mouse drag would otherwise select slide text as it swipes.
      getSelection()?.removeAllRanges();
      el.toggleAttribute("data-dragging", true);
      const shown = getComputedStyle(track).transform;
      animation?.cancel();
      animation = null;
      if (shown !== "none") track.style.transform = shown;
      moving(true);
    }
    const dt = event.timeStamp - drag.lastT;
    if (dt > 0) drag.v = (event.clientX - drag.lastX) / dt;
    drag.lastX = event.clientX;
    drag.lastT = event.timeStamp;
    track.style.transform = offset(index, dragOffset(index, dx, count));
  });
  const release = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { active, x0, v } = drag;
    drag = null;
    el.toggleAttribute("data-dragging", false);
    if (active) go(swipeTarget(index, event.clientX - x0, viewport.clientWidth, v, count));
  };
  viewport.addEventListener("pointerup", release);
  viewport.addEventListener("pointercancel", release);
  new ResizeObserver(() => {
    if (!animation && !drag) track.style.transform = offset(index);
  }).observe(viewport);

  update();
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
