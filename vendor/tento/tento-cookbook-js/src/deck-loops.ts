/**
 * Loop bodies for the deck. `loops` draws an outer ring of three steps around
 * one inner-loop card; `feedback` puts steps beside the same card, the last
 * feeding back into it. Cells, pills and the card are HTML on a fixed design
 * canvas, and one SVG layer draws every connector from the measured cell
 * sizes, so each arrow has the same stroke, head and gaps. The canvas scales
 * to fit the body; below 520 px it switches to a stacked layout. Sizes come
 * from offsetWidth/offsetHeight, which ignore the deck's page scale.
 */
import type {
  DeckCell,
  DeckFeedback,
  DeckLoopCard,
  DeckLoops,
} from "./deck-data.ts";
import { h } from "./dom.ts";

const SVG = "http://www.w3.org/2000/svg";
/** Space after the cell an arrow leaves, and before the cell it enters. */
const GAP_OUT = 5, GAP_IN = 6;
const CARD_W = 286, CARD_H = 172;
/** The inner ring, in card units; pills sit on its straight top and bottom edges. */
const RING_IN: Ring = { x: 14, y: 76, w: 258, h: 74, r: 24 };
const NARROW = 520;
/** Stacked layouts: the return arrow runs up this gutter at the left. */
const GUTTER = 16, TURN = 10, STACK_GAP = 24;

export type Box = {
  l: number;
  t: number;
  r: number;
  b: number;
  cx: number;
  cy: number;
};
export type Ring = { x: number; y: number; w: number; h: number; r: number };
/** Ring sides, clockwise: 0 top, 1 right, 2 bottom, 3 left. */
export type Side = 0 | 1 | 2 | 3;

const box = (l: number, t: number, w: number, hgt: number): Box => ({
  l,
  t,
  r: l + w,
  b: t + hgt,
  cx: l + w / 2,
  cy: t + hgt / 2,
});

/** The connector from the cell `a` (on side `sa`) to the cell `b` (on side
 * `sb`), travelling clockwise along a rounded rectangle and turning at its corners. */
export function ringPath(
  ring: Ring,
  a: Box,
  sa: Side,
  b: Box,
  sb: Side,
): string {
  const { x, y, w, h: ht, r } = ring;
  const exit: [number, number][] = [
    [a.r + GAP_OUT, y],
    [x + w, a.b + GAP_OUT],
    [a.l - GAP_OUT, y + ht],
    [x, a.t - GAP_OUT],
  ];
  const entry: [number, number][] = [[b.l - GAP_IN, y], [x + w, b.t - GAP_IN], [
    b.r + GAP_IN,
    y + ht,
  ], [x, b.b + GAP_IN]];
  const corners: [number, number, number, number][] = [
    [x + w - r, y, x + w, y + r],
    [x + w, y + ht - r, x + w - r, y + ht],
    [x + r, y + ht, x, y + ht - r],
    [x, y + r, x + r, y],
  ];
  let d = `M${exit[sa][0]} ${exit[sa][1]}`;
  for (let s = sa; s !== sb; s = ((s + 1) % 4) as Side) {
    const [lx, ly, ax, ay] = corners[s];
    d += ` L${lx} ${ly} A${r} ${r} 0 0 1 ${ax} ${ay}`;
  }
  return d + ` L${entry[sb][0]} ${entry[sb][1]}`;
}

/** Every connector of a ring whose cells are listed clockwise. */
export function ringPaths(ring: Ring, cells: [Box, Side][]): string[] {
  return cells.map(([a, sa], i) => {
    const [b, sb] = cells[(i + 1) % cells.length];
    return ringPath(ring, a, sa, b, sb);
  });
}

const down = (a: Box, b: Box, x = a.cx) =>
  `M${x} ${a.b + GAP_OUT} V${b.t - GAP_IN}`;

/** From the left of `from`, up the left gutter, into the left of `to`. */
function upGutter(from: Box, to: Box, toY = to.cy): string {
  const g = GUTTER;
  return `M${from.l - GAP_OUT} ${from.cy} H${g + TURN} Q${g} ${from.cy} ${g} ${
    from.cy - TURN
  } V${toY + TURN} ` +
    `Q${g} ${toY} ${g + TURN} ${toY} H${to.l - GAP_IN}`;
}

function glyph(markup: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  // Trusted app content: stroked 24 px line-icon markup (paths, rects, circles).
  svg.innerHTML = markup;
  return svg;
}

function avatar(url: string, name: string): HTMLElement {
  const el = h("span", "ck-loop-avatar", { role: "img", "aria-label": name });
  el.style.backgroundImage = `url("${url}")`;
  return el;
}

function cell(c: DeckCell, extra = ""): HTMLElement {
  const tone = c.emphasis ? " ck-emphasis" : c.planned ? " ck-planned" : "";
  const title = h("b", "", null, c.title);
  if (c.tag) title.append(h("span", "ck-loop-tag", null, c.tag));
  const el = h("div", "ck-loop-cell" + tone + extra);
  if (c.avatar) el.append(avatar(c.avatar, c.title));
  else if (c.icon) el.append(h("span", "ck-loop-glyph", null, glyph(c.icon)));
  el.append(
    h("div", "", null, title, h("span", "ck-loop-caption", null, c.caption)),
  );
  return el;
}

type Card = { el: HTMLElement; pills: HTMLElement[]; note: HTMLElement | null };

function card(c: DeckLoopCard): Card {
  const el = h("div", "ck-loop-card");
  el.append(
    cell(
      { title: c.title, caption: c.caption, avatar: c.avatar },
      " ck-loop-head",
    ),
  );
  if (c.badge) el.append(h("span", "ck-loop-badge", null, c.badge));
  const pills = c.steps.map((s) => h("span", "ck-loop-pill", null, s));
  el.append(...pills);
  const note = c.note ? h("p", "ck-loop-note", null, c.note) : null;
  if (note) el.append(note);
  return { el, pills, note };
}

const at = (el: HTMLElement, l: number, t: number): Box => {
  el.style.left = `${l}px`;
  el.style.top = `${t}px`;
  return box(l, t, el.offsetWidth, el.offsetHeight);
};
const centred = (el: HTMLElement, cx: number, cy: number) =>
  at(el, cx - el.offsetWidth / 2, cy - el.offsetHeight / 2);

/** Places the card at (l, t) and returns its box and the inner ring's connectors. */
function placeCard(
  c: Card,
  l: number,
  t: number,
): { box: Box; paths: string[] } {
  const R = RING_IN, inset = R.r + 14;
  const [tl, tr, br, bl] = c.pills;
  const top = R.y, bottom = R.y + R.h;
  const pill = (el: HTMLElement, left: boolean, y: number) =>
    at(
      el,
      left ? R.x + inset : R.x + R.w - inset - el.offsetWidth,
      y - el.offsetHeight / 2,
    );
  const boxes = [
    pill(tl, true, top),
    pill(tr, false, top),
    pill(br, false, bottom),
    pill(bl, true, bottom),
  ];
  if (c.note) {
    at(
      c.note,
      (CARD_W - c.note.offsetWidth) / 2,
      R.y + (R.h - c.note.offsetHeight) / 2,
    );
  }
  at(c.el, l, t);
  const shift = (b: Box) => box(b.l + l, b.t + t, b.r - b.l, b.b - b.t);
  const ring = { ...R, x: R.x + l, y: R.y + t };
  const sides: Side[] = [0, 0, 2, 2];
  return {
    box: box(l, t, CARD_W, CARD_H),
    paths: ringPaths(ring, boxes.map((b, i) => [shift(b), sides[i]])),
  };
}

type Layout = { width: number; height: number; paths: string[] };

/** Scales the stage into the body and redraws it whenever the body resizes. */
function mount(
  label: string,
  parts: HTMLElement[],
  layout: (narrow: boolean) => Layout,
): HTMLElement {
  const stage = h(
    "div",
    "ck-loop-stage",
    { role: "img", "aria-label": label },
    ...parts,
  );
  const wires = document.createElementNS(SVG, "svg");
  wires.setAttribute("class", "ck-loop-wires");
  wires.setAttribute("aria-hidden", "true");
  stage.append(wires);
  const wrap = h("div", "ck-loops", null, stage);
  const id = `ck-loop-head-${Math.random().toString(36).slice(2, 8)}`;
  const draw = () => {
    const w = wrap.clientWidth, ht = wrap.clientHeight;
    if (!w || !ht) return;
    const narrow = w < NARROW;
    stage.dataset.layout = narrow ? "narrow" : "wide";
    const { width, height, paths } = layout(narrow);
    const s = Math.min(1, w / width, ht / height);
    Object.assign(stage.style, {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${(w - width * s) / 2}px, ${
        (ht - height * s) / 2
      }px) scale(${s})`,
    });
    wires.setAttribute("viewBox", `0 0 ${width} ${height}`);
    wires.innerHTML =
      `<defs><marker id="${id}" viewBox="0 0 12 12" refX="9" refY="6" markerWidth="12" markerHeight="12" ` +
      `markerUnits="userSpaceOnUse" orient="auto"><path d="M3 1.5L9 6L3 10.5"/></marker></defs>` +
      paths.map((d) => `<path d="${d}" marker-end="url(#${id})"/>`).join("");
  };
  new ResizeObserver(draw).observe(wrap);
  void document.fonts?.ready.then(draw);
  return wrap;
}

/** An outer ring around the inner-loop card. Travel is clockwise: top → the
 * card (on the right edge) → bottom → left → top. */
export function renderLoops(body: DeckLoops): HTMLElement {
  const inner = card(body.inner);
  const top = cell(body.outer.top),
    bottom = cell(body.outer.bottom),
    left = cell(body.outer.left);
  const label = [body.outer.top, body.inner, body.outer.bottom, body.outer.left]
    .map((c) => c.title).join(", then ");
  return mount(`A loop: ${label}, and around again.`, [
    top,
    bottom,
    left,
    inner.el,
  ], (narrow) => {
    if (narrow) {
      const cx = GUTTER + 29 + CARD_W / 2;
      const t = centred(top, cx, top.offsetHeight / 2);
      const c = placeCard(inner, cx - CARD_W / 2, t.b + STACK_GAP);
      const b = centred(
        bottom,
        cx,
        c.box.b + STACK_GAP + bottom.offsetHeight / 2,
      );
      const l = centred(left, cx, b.b + STACK_GAP + left.offsetHeight / 2);
      return {
        width: cx + CARD_W / 2 + 4,
        height: l.b,
        paths: [
          ...c.paths,
          down(t, c.box),
          down(c.box, b, cx),
          down(b, l),
          upGutter(l, t),
        ],
      };
    }
    const c = placeCard(inner, 290, 58);
    const ring: Ring = {
      x: 92,
      y: 22,
      w: c.box.cx - 92,
      h: c.box.b + GAP_OUT + 28 - 22,
      r: 28,
    };
    const mid = (ring.x + ring.r + ring.x + ring.w - ring.r) / 2;
    const t = centred(top, mid, ring.y);
    const b = centred(bottom, mid, ring.y + ring.h);
    const l = centred(left, ring.x, ring.y + ring.h / 2);
    return {
      width: 576,
      height: b.b,
      paths: [
        ...c.paths,
        ...ringPaths(ring, [[t, 0], [c.box, 1], [b, 2], [l, 3]]),
      ],
    };
  });
}

/** Steps beside the inner-loop card, top to bottom; the card feeds the first,
 * and the last feeds back into the card, labelled `back`. */
export function renderFeedback(body: DeckFeedback): HTMLElement {
  const inner = card(body.inner);
  const steps = body.steps.map((s) => cell(s, " ck-loop-step"));
  const back = h("span", "ck-loop-label", null, body.back);
  const label = `${body.inner.title}, then ${
    body.steps.map((s) => s.title).join(", then ")
  }, then ${body.back} for ${body.inner.title}.`;
  return mount(label, [inner.el, ...steps, back], (narrow) => {
    if (narrow) {
      const cx = GUTTER + 29 + CARD_W / 2;
      const c = placeCard(inner, cx - CARD_W / 2, 0);
      let y = c.box.b + STACK_GAP;
      const boxes = steps.map((s) => {
        const b = at(s, cx - s.offsetWidth / 2, y);
        y = b.b + STACK_GAP;
        return b;
      });
      const last = boxes[boxes.length - 1];
      const paths = [
        ...c.paths,
        down(c.box, boxes[0], cx),
        ...boxes.slice(1).map((b, i) => down(boxes[i], b)),
        upGutter(last, c.box),
      ];
      // Turned to run up the gutter (CSS), centred between the gutter and the card.
      at(
        back,
        GUTTER + 14 - back.offsetWidth / 2,
        (c.box.cy + last.cy) / 2 - back.offsetHeight / 2,
      );
      return { width: cx + CARD_W / 2 + 4, height: last.b + 2, paths };
    }
    const c = placeCard(inner, 0, 0);
    let y = 8;
    const boxes = steps.map((s) => {
      const b = at(s, 319, y);
      y = b.b + 22;
      return b;
    });
    const first = boxes[0], last = boxes[boxes.length - 1];
    const yb = Math.max(c.box.b, last.b) + 22;
    const paths = [
      ...c.paths,
      `M${c.box.r + GAP_OUT} ${first.cy} H${first.l - GAP_IN}`,
      ...boxes.slice(1).map((b, i) => down(boxes[i], b)),
      `M${last.cx} ${last.b + GAP_OUT} V${yb - TURN} Q${last.cx} ${yb} ${
        last.cx - TURN
      } ${yb} ` +
      `H${c.box.cx + TURN} Q${c.box.cx} ${yb} ${c.box.cx} ${yb - TURN} V${
        c.box.b + GAP_IN
      }`,
    ];
    const lb = at(back, (last.cx + c.box.cx - back.offsetWidth) / 2, yb + 4);
    return { width: 576, height: lb.b + 2, paths };
  });
}
