/**
 * Chart bodies for the pitch deck: lines, profile, uncertainty and cases. Like the
 * other body kinds they carry no content of their own, use the deck greys
 * with one near-black emphasis, and fit the shared body height.
 *
 * Geometry is drawn in a unit SVG (preserveAspectRatio="none", non-scaling
 * strokes) so it fills any width; every label, value and marker is HTML
 * placed by percentage, so text never scales with the chart.
 */
import type { DeckCases, DeckLines, DeckProfile, DeckUncertainty } from "./deck-data.ts";
import { h } from "./dom.ts";

const NS = "http://www.w3.org/2000/svg";
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const pct = (v: number) => `${(clamp01(v) * 100).toFixed(3)}%`;

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A unit canvas: x and y in 0..1, y down. */
function plot(className: string): { root: HTMLElement; area: HTMLElement; canvas: SVGElement } {
  const canvas = svg("svg", { viewBox: "0 0 1 1", preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" });
  const area = h("div", "ck-plot-area", null, canvas);
  return { root: h("div", "ck-plot " + className, null, area), area, canvas };
}

/** An HTML label pinned to a unit-space point. */
function pin(area: HTMLElement, x: number, y: number, className: string, text = ""): HTMLElement {
  const el = h("span", className, null, text);
  el.style.left = pct(x);
  el.style.top = pct(y);
  area.append(el);
  return el;
}

const emphasisLast = <T extends { emphasis?: boolean }>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => Number(!!a.emphasis) - Number(!!b.emphasis));

type LegendItem = { label: string; emphasis?: boolean; dashed?: boolean };
function legend(items: LegendItem[]): HTMLElement {
  const tone = (s: LegendItem) => [s.emphasis && "ck-emphasis", s.dashed && "ck-dashed"].filter(Boolean).join(" ");
  return h("ul", "ck-legend", null, ...items.map((s) => h("li", tone(s), null, h("i"), s.label)));
}

export function renderLines(body: DeckLines): HTMLElement {
  const { root, area, canvas } = plot("ck-lines");
  const sx = (v: number) => (v - body.x.min) / (body.x.max - body.x.min || 1);
  const sy = (v: number) => 1 - (v - body.y.min) / (body.y.max - body.y.min || 1);
  const ticks = h("div", "ck-ticks");
  for (const t of body.x.ticks ?? []) {
    canvas.append(svg("line", { x1: sx(t), x2: sx(t), y1: 0, y2: 1, class: "ck-grid" }));
    pin(ticks, sx(t), 0, "ck-tick", `${t}${body.x.unit ?? ""}`);
  }
  area.append(ticks);
  if (body.threshold) {
    const y = sy(body.threshold.value);
    canvas.append(svg("line", { x1: 0, x2: 1, y1: y, y2: y, class: "ck-threshold" }));
  }
  for (const s of emphasisLast(body.series)) {
    const d = s.points.map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(4)},${clamp01(sy(y)).toFixed(4)}`).join("");
    canvas.append(svg("path", { d, class: "ck-series" + (s.emphasis ? " ck-emphasis" : "") }));
    if (s.marker) {
      const [mx, my] = s.marker.at, tone = s.emphasis ? " ck-emphasis" : "";
      pin(area, sx(mx), sy(my), "ck-dot" + tone);
      pin(area, sx(mx), sy(my), "ck-dot-label" + tone + (sx(mx) > 0.85 ? " ck-end" : ""), s.marker.label);
    }
  }
  pin(area, 0, 0, "ck-axis-label", body.y.label);
  const threshold = body.threshold ? [{ label: body.threshold.label, dashed: true }] : [];
  return h("div", "", null, root, legend([...body.series, ...threshold]));
}

export function renderProfile(body: DeckProfile): HTMLElement {
  const { root, area, canvas } = plot("ck-profile");
  const values = body.curve.values, n = values.length;
  const rail = 0.06, top = 0.36; // the fixed row sits on the rail, the curve below `top`
  const at = (i: number) => (n > 1 ? i / (n - 1) : 0.5);
  const valueAt = (x: number) => {
    if (n < 2) return values[0] ?? 0;
    const f = clamp01(x) * (n - 1), i = Math.min(n - 2, Math.floor(f));
    return values[i] + (values[i + 1] - values[i]) * (f - i);
  };
  const cy = (v: number) => 1 - clamp01(v) * (1 - top);
  const line = values.map((v, i) => `${i ? "L" : "M"}${at(i).toFixed(4)},${cy(v).toFixed(4)}`).join("");
  canvas.append(svg("path", { d: `${line}L1,1L0,1Z`, class: "ck-area" }));
  canvas.append(svg("path", { d: line, class: "ck-series ck-emphasis" }));
  canvas.append(svg("line", { x1: 0, x2: 1, y1: rail, y2: rail, class: "ck-rail" }));
  canvas.append(svg("line", { x1: 0, x2: 1, y1: 1, y2: 1, class: "ck-rail" }));
  for (const x of body.fixed.at) pin(area, x, rail, "ck-dot");
  pin(area, 1, rail, "ck-row-tag ck-end", body.fixed.label);
  body.picks.at.forEach((x, i) => {
    const y = cy(valueAt(x));
    canvas.append(svg("line", { x1: x, x2: x, y1: y, y2: 1, class: "ck-drop" }));
    pin(area, x, y, "ck-dot ck-emphasis ck-numbered", String(i + 1));
  });
  pin(area, 1, top, "ck-row-tag ck-end ck-emphasis", body.picks.label);
  const ticks = h("div", "ck-ticks");
  body.axis.forEach((label, i) => pin(ticks, body.axis.length > 1 ? i / (body.axis.length - 1) : 0.5, 0, "ck-tick", label));
  area.append(ticks);
  return h("div", "", null, root, legend([{ label: body.curve.label, emphasis: true }]));
}

export function renderUncertainty(body: DeckUncertainty): HTMLElement {
  const { root, area, canvas } = plot("ck-uncertainty");
  canvas.append(svg("line", { x1: 0, x2: 1, y1: 0.5, y2: 0.5, class: "ck-grid" }));
  canvas.append(svg("line", { x1: 0.5, x2: 0.5, y1: 0, y2: 1, class: "ck-grid" }));
  const half = clamp01(body.target.size) / 2;
  canvas.append(svg("rect", { x: 0.5 - half, y: 0.5 - half, width: 2 * half, height: 2 * half, class: "ck-target" }));
  pin(area, 0.5 - half, 0.5 - half, "ck-target-label", body.target.label);
  for (const r of emphasisLast(body.regions)) {
    canvas.append(svg("ellipse", {
      cx: 0.5,
      cy: 0.5,
      rx: clamp01(r.rx) / 2,
      ry: clamp01(r.ry) / 2,
      transform: `rotate(${-r.angle} 0.5 0.5)`,
      class: "ck-region" + (r.emphasis ? " ck-emphasis" : ""),
    }));
  }
  pin(area, 0.5, 0.5, "ck-dot ck-emphasis ck-center");
  pin(area, 1, 0.5, "ck-axis-x", body.axes[0]);
  pin(area, 0.5, 0, "ck-axis-y", body.axes[1]);
  return h("div", "ck-uncertainty-wrap", null, root, legend(body.regions));
}

/** The plot band of a cases chart, as fractions of the width: case names sit
 * to its left, and outcomes start at CASE_OUTCOME_X. */
const CASE_PLOT: [number, number] = [0.19, 0.62];
const CASE_OUTCOME_X = 0.66;

export function renderCases(body: DeckCases): HTMLElement {
  const { root, area, canvas } = plot("ck-cases");
  const [x0, x1] = CASE_PLOT, axis = body.axis;
  const f = (v: number) => (axis.log ? Math.log10(Math.max(v, Number.MIN_VALUE)) : v);
  const lo = f(axis.min), hi = f(axis.max);
  const sx = (v: number) => x0 + (x1 - x0) * clamp01((f(v) - lo) / (hi - lo || 1));
  const sy = (i: number) => (i + 0.5) / Math.max(1, body.rows.length);
  const ticks = h("div", "ck-ticks");
  ticks.style.left = pct(x0);
  ticks.style.right = pct(1 - x1);
  for (const t of axis.ticks ?? []) {
    canvas.append(svg("line", { x1: sx(t), x2: sx(t), y1: 0, y2: 1, class: "ck-grid" }));
    pin(ticks, (sx(t) - x0) / (x1 - x0), 0, "ck-tick", `${t}${axis.unit ?? ""}`);
  }
  area.append(ticks);
  pin(area, x0, 0, "ck-axis-label", axis.label);
  body.rows.forEach((row, i) => {
    const y = sy(i), bx = sx(row.base), vx = sx(row.value);
    canvas.append(svg("line", { x1: bx, x2: vx, y1: y, y2: y, class: "ck-rail" }));
    pin(area, 0, y, "ck-case-label", row.label);
    pin(area, bx, y, "ck-dot");
    if (row.caveat) {
      pin(area, vx, y, "ck-dot ck-hollow");
      pin(area, vx, y, "ck-dot-label ck-end", row.caveat);
    } else {
      pin(area, vx, y, "ck-dot ck-emphasis");
    }
    pin(area, CASE_OUTCOME_X, y, "ck-case-outcome" + (row.emphasis ? " ck-emphasis" : ""), row.outcome);
    if (row.baseOutcome) {
      pin(area, CASE_OUTCOME_X, y, "ck-case-base" + (row.baseEmphasis ? " ck-emphasis" : ""), row.baseOutcome);
    }
  });
  const parts: HTMLElement[] = [root, legend([{ label: body.legend[0] }, { label: body.legend[1], emphasis: true }])];
  if (body.note) parts.push(h("p", "ck-chart-note", null, body.note));
  return h("div", "", null, ...parts);
}
