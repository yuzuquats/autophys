// Thin SVG builders for the std-review-* connector overlays. Since the
// DOM-first rewrite, diagrams draw ONLY wires here (lines, paths, arrow
// markers) — every label and box is a real DOM element sized by typography,
// never SVG text.

export namespace ReviewSvg {
  export const NS = "http://www.w3.org/2000/svg";

  export type Pt = { x: number; y: number };

  export function $path(d: string, cls: string): SVGPathElement {
    const $el = document.createElementNS(NS, "path");
    $el.setAttribute("d", d);
    if (cls !== "") $el.setAttribute("class", cls);
    return $el;
  }

  export function $line(a: Pt, b: Pt, cls: string): SVGLineElement {
    const $el = document.createElementNS(NS, "line");
    $el.setAttribute("x1", fmt(a.x));
    $el.setAttribute("y1", fmt(a.y));
    $el.setAttribute("x2", fmt(b.x));
    $el.setAttribute("y2", fmt(b.y));
    if (cls !== "") $el.setAttribute("class", cls);
    return $el;
  }

  /** One shared arrowhead `<marker>`; reference as `url(#<id>)`. */
  export function $arrowDefs(id: string): SVGDefsElement {
    const $defs = document.createElementNS(NS, "defs");
    const $marker = document.createElementNS(NS, "marker");
    $marker.setAttribute("id", id);
    $marker.setAttribute("viewBox", "0 0 8 8");
    $marker.setAttribute("refX", "7");
    $marker.setAttribute("refY", "4");
    $marker.setAttribute("markerWidth", "7");
    $marker.setAttribute("markerHeight", "7");
    $marker.setAttribute("orient", "auto-start-reverse");
    $marker.appendChild($path("M 0.5 0.5 L 7.5 4 L 0.5 7.5 z", "arrow"));
    $defs.appendChild($marker);
    return $defs;
  }

  /** Polyline path with slightly rounded bends. */
  export function polyPath(points: Pt[]): string {
    if (points.length === 0) return "";
    const r = 6;
    let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      if (i < points.length - 1) {
        const n = points[i + 1];
        const inPt = toward(p, points[i - 1], r);
        const outPt = toward(p, n, r);
        d += ` L ${fmt(inPt.x)} ${fmt(inPt.y)} Q ${fmt(p.x)} ${fmt(p.y)} ${fmt(outPt.x)} ${fmt(outPt.y)}`;
      } else {
        d += ` L ${fmt(p.x)} ${fmt(p.y)}`;
      }
    }
    return d;
  }

  export function midpoint(points: Pt[]): Pt {
    if (points.length % 2 === 1) return points[(points.length - 1) / 2];
    const a = points[points.length / 2 - 1];
    const b = points[points.length / 2];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function toward(from: Pt, to: Pt, dist: number): Pt {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < dist * 2) return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    return { x: from.x + (dx / len) * dist, y: from.y + (dy / len) * dist };
  }

  function fmt(n: number): string {
    return String(Math.round(n * 10) / 10);
  }
}
