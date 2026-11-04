import { emptyMarkup } from "./state-markup.ts";
/**
 * Chart drawing: data coordinates to pixels, nothing else. Every series, tick, label and
 * opacity arrives computed; the only decisions here are layout (margins, where the legend
 * goes) and mapping a tone to its CSS class.
 */
import { escapeHtml as esc } from "./intent.ts";
import type { Axis, BarRow, BarsChart, Chart, HeatmapChart, Layer, LegendItem, RangesChart, XYChart } from "./view-model.ts";

const f = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "0");

/** A linear or log map from an axis onto [a, b] pixels. */
export function scale(axis: Axis, a: number, b: number): (v: number) => number {
  if (axis.log) {
    const l0 = Math.log10(axis.min), l1 = Math.log10(axis.max);
    return (v) => a + ((Math.log10(Math.max(v, 1e-300)) - l0) / (l1 - l0 || 1)) * (b - a);
  }
  return (v) => a + ((v - axis.min) / (axis.max - axis.min || 1)) * (b - a);
}

const M = { left: 44, right: 12 };

/** Markup for one chart at `width` pixels; `key` makes its clip-path id unique on the page. */
export function chartMarkup(chart: Chart, width: number, key: string): string {
  switch (chart.kind) {
    case "missing": return `<div class="ap-gap">${emptyMarkup(chart.title, chart.description)}</div>`;
    case "xy": return xyMarkup(chart, width, key);
    case "heatmap": return heatmapMarkup(chart, width);
    case "bars": return barsMarkup(chart.rows, chart.label);
    case "ranges": return rangesMarkup(chart);
  }
}

function frame(height: number, width: number, label: string | undefined, xTicks: boolean) {
  const top = label ? 20 : 8, bottom = xTicks ? 22 : 4;
  return { top, bottom, x0: M.left, x1: Math.max(M.left + 10, width - M.right), y0: top, y1: Math.max(top + 10, height - bottom) };
}

function axesMarkup(x: Axis, y: Axis, fr: ReturnType<typeof frame>, height: number, xTicks: boolean): string {
  const sx = scale(x, fr.x0, fr.x1), sy = scale(y, fr.y1, fr.y0);
  let out = "";
  for (const t of y.ticks) {
    out += `<line class="ap-grid" x1="${fr.x0}" x2="${fr.x1}" y1="${f(sy(t.value))}" y2="${f(sy(t.value))}"/>`;
    out += `<text class="ap-tick" x="${fr.x0 - 6}" y="${f(sy(t.value) + 3.5)}" text-anchor="end">${esc(t.label)}</text>`;
  }
  if (xTicks) {
    for (const t of x.ticks) out += `<text class="ap-tick" x="${f(sx(t.value))}" y="${height - 6}" text-anchor="middle">${esc(t.label)}</text>`;
    if (x.label) out += `<text class="ap-tick" x="${fr.x1}" y="${height - 6}" text-anchor="end">${esc(x.label)}</text>`;
  }
  if (y.label) out += `<text class="ap-tick" x="${fr.x0 - 6}" y="${fr.y0 - 8}" text-anchor="end">${esc(y.label)}</text>`;
  return out;
}

function layerMarkup(layer: Layer, sx: (v: number) => number, sy: (v: number) => number, fr: ReturnType<typeof frame>): string {
  switch (layer.kind) {
    case "dots": {
      const r = layer.r ?? 1.6;
      return `<g class="ap-dots ap-s-${layer.tone}">${layer.points.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
        .map(([a, b]) => `<circle cx="${f(sx(a))}" cy="${f(sy(b))}" r="${r}"/>`).join("")}</g>`;
    }
    case "line": {
      let d = "", pen = false;
      for (const [a, b] of layer.points) {
        if (!Number.isFinite(a) || !Number.isFinite(b)) { pen = false; continue; }
        d += `${pen ? "L" : "M"}${f(sx(a))},${f(sy(b))}`;
        pen = true;
      }
      return `<path class="ap-line ap-s-${layer.tone}${layer.dashed ? " ap-dashed" : ""}" d="${d}"/>`;
    }
    case "vband": {
      const a = sx(layer.from), b = sx(layer.to);
      return `<rect class="ap-band ap-s-${layer.tone}" x="${f(Math.min(a, b))}" y="${fr.y0}" width="${f(Math.abs(b - a))}" height="${f(fr.y1 - fr.y0)}"/>`;
    }
    case "hband": {
      const a = sy(layer.to), b = sy(layer.from);
      return `<rect class="ap-band ap-s-${layer.tone}" x="${fr.x0}" y="${f(Math.min(a, b))}" width="${f(fr.x1 - fr.x0)}" height="${f(Math.abs(b - a))}"/>`;
    }
    case "hline": return `<line class="ap-rule ap-s-${layer.tone}" x1="${fr.x0}" x2="${fr.x1}" y1="${f(sy(layer.y))}" y2="${f(sy(layer.y))}"/>`;
    case "vline": return `<line class="ap-rule ap-s-${layer.tone}" x1="${f(sx(layer.x))}" x2="${f(sx(layer.x))}" y1="${fr.y0}" y2="${fr.y1}"/>`;
  }
}

function legendMarkup(items: LegendItem[], right: number, y: number): string {
  // Laid out right to left so it ends on the plot's right edge.
  let x = right, out = "";
  for (const item of [...items].reverse()) {
    const text = item.label.length * 6 + 4;
    x -= text;
    out += `<text class="ap-legend" x="${f(x)}" y="${y + 4}">${esc(item.label)}</text>`;
    x -= 18;
    out += item.mark === "dot"
      ? `<circle class="ap-s-${item.tone}" cx="${f(x + 8)}" cy="${y}" r="2.5"/>`
      : `<line class="ap-line ap-s-${item.tone}${item.mark === "dashed" ? " ap-dashed" : ""}" x1="${f(x + 1)}" x2="${f(x + 15)}" y1="${y}" y2="${y}"/>`;
    x -= 10;
  }
  return out;
}

function xyMarkup(chart: XYChart, width: number, key: string): string {
  const xTicks = chart.xTicks !== false;
  const fr = frame(chart.height, width, chart.label || chart.legend?.length ? "x" : undefined, xTicks);
  fr.x0 = Math.min(Math.max(M.left, chart.left ?? M.left), Math.max(M.left, width - 80));
  const sx = scale(chart.x, fr.x0, fr.x1), sy = scale(chart.y, fr.y1, fr.y0);
  const clip = `ap-clip-${key}`;
  const label = chart.label ? `<text class="ap-label" x="${fr.x0}" y="12">${esc(chart.label)}</text>` : "";
  const legend = chart.legend?.length ? legendMarkup(chart.legend, fr.x1, 8) : "";
  return `<svg class="ap-svg" width="${width}" height="${chart.height}" viewBox="0 0 ${width} ${chart.height}" role="img"${chart.label ? ` aria-label="${esc(chart.label)}"` : ""}>`
    + `<defs><clipPath id="${clip}"><rect x="${fr.x0}" y="${fr.y0 - 2}" width="${f(fr.x1 - fr.x0)}" height="${f(fr.y1 - fr.y0 + 4)}"/></clipPath></defs>`
    + axesMarkup(chart.x, chart.y, fr, chart.height, xTicks)
    + `<g clip-path="url(#${clip})">${chart.layers.map((l) => layerMarkup(l, sx, sy, fr)).join("")}</g>`
    + label + legend + `</svg>`;
}

function heatmapMarkup(chart: HeatmapChart, width: number): string {
  const fr = frame(chart.height, width, chart.label, true);
  const pw = fr.x1 - fr.x0, ph = fr.y1 - fr.y0, cw = pw / chart.cols, rh = ph / chart.rows;
  let cells = "";
  for (let j = 0; j < chart.rows; j++) {
    for (let i = 0; i < chart.cols; i++) {
      const v = chart.values[j * chart.cols + i] ?? 0;
      cells += `<rect x="${f(fr.x0 + i * cw)}" y="${f(fr.y1 - (j + 1) * rh)}" width="${f(cw + 0.5)}" height="${f(rh + 0.5)}" fill-opacity="${Math.max(0, Math.min(1, v)).toFixed(3)}"/>`;
    }
  }
  const sx = scale(chart.x, fr.x0, fr.x1), sy = scale(chart.y, fr.y1, fr.y0);
  let trail = "";
  if (chart.trail?.points.length) {
    const pts = chart.trail.points;
    trail += `<polyline class="ap-trail" points="${pts.map(([a, b]) => `${f(sx(a))},${f(sy(b))}`).join(" ")}"/>`;
    pts.forEach(([a, b], n) => {
      const last = n === pts.length - 1;
      trail += `<circle class="ap-trail-dot${last ? " last" : ""}" cx="${f(sx(a))}" cy="${f(sy(b))}" r="${last ? 4.5 : 3}"/>`;
    });
    const [la, lb] = pts[pts.length - 1];
    if (chart.trail.label) trail += `<text class="ap-direct" x="${f(sx(la) + 8)}" y="${f(sy(lb) + 4)}">${esc(chart.trail.label)}</text>`;
  }
  const label = chart.label ? `<text class="ap-label" x="${fr.x0}" y="12">${esc(chart.label)}</text>` : "";
  return `<svg class="ap-svg" width="${width}" height="${chart.height}" viewBox="0 0 ${width} ${chart.height}" role="img"${chart.label ? ` aria-label="${esc(chart.label)}"` : ""}>`
    + `<g class="ap-cells">${cells}</g><rect class="ap-frame" x="${fr.x0 + 0.5}" y="${fr.y0 + 0.5}" width="${f(pw - 1)}" height="${f(ph - 1)}"/>`
    + axesMarkup(chart.x, chart.y, fr, chart.height, true).replace(/<line class="ap-grid"[^>]*\/>/g, "")
    + trail + label + `</svg>`;
}

/** Horizontal bars: label, a track filled to `fraction`, the value text. Shared with Details. */
export function barsMarkup(rows: BarRow[], label?: string): string {
  return `<div class="ap-bars">${label ? `<p class="ap-chart-label">${esc(label)}</p>` : ""}${rows.map((r) =>
    `<div class="ap-bar"><span class="ap-bar-label" title="${esc(r.label)}">${esc(r.label)}</span><span class="ap-bar-track"><span class="ap-bar-fill ap-t-${r.tone ?? "default"}" style="width:${(Math.max(0, Math.min(1, r.fraction)) * 100).toFixed(1)}%"></span></span><span class="ap-bar-value">${esc(r.value)}</span></div>`).join("")}</div>`;
}

function rangesMarkup(chart: RangesChart): string {
  return `<div class="ap-ranges">${chart.label ? `<p class="ap-chart-label">${esc(chart.label)}</p>` : ""}${chart.rows.map((r) =>
    `<div class="ap-range"><div class="ap-range-head"><b>${esc(r.label)}${r.unit ? ` <span class="ap-unit">${esc(r.unit)}</span>` : ""}</b><span class="ap-range-scale">${esc(r.scale ?? "")}</span>${r.tag ? `<span class="ap-tag ap-t-${r.tag.tone ?? "default"}">${esc(r.tag.text)}</span>` : ""}</div><div class="ap-range-track">${Number.isFinite(r.at) ? `<i style="left:${(Math.max(0, Math.min(1, r.at)) * 100).toFixed(1)}%"></i>` : ""}${r.initial ? `<span class="ap-range-initial" style="left:${(Math.max(.18, Math.min(.82, r.at)) * 100).toFixed(1)}%">${esc(r.initial)}</span>` : ""}</div><div class="ap-range-bounds"><span>${esc(r.lo)}</span><span>${esc(r.hi)}</span></div></div>`).join("")}</div>`;
}
