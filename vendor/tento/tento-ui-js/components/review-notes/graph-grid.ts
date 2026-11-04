import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Div } from "../../component-builtin";
import { Typography } from "../../ui/typography";
import { GraphLayout } from "../../review-dsl/graph-layout";
import { GraphRenderer } from "./graph-renderer";
import { ReviewSvg } from "./review-svg";

// DOM-first diagram rendering: nodes are real elements placed in a CSS grid
// (the DOM sizes them — no text measurement anywhere), and the only SVG is a
// connector overlay drawn AFTER layout from the boxes' measured offsets.
// Long edges route through the empty grid cells the layout reserved (each
// holds an invisible waypoint element so routing reads real geometry, never
// guessed pixels).
//
// The layout is container-adaptive in two stages: an LR diagram whose
// natural width does not fit the available column re-lays itself out
// top-down (and flips back when the column grows), and a top-down diagram
// gets the container's measured column budget, so a rank too wide to fit
// tiles onto extra lines rather than overflowing. Collision avoidance is
// therefore a function of the parent's width, not of the graph alone. The
// wire overlay paints UNDER the node boxes, and edge labels are bare haloed
// text placed on the longest collision-free wire segment — never a filled
// box pasted over neighbors.
//
// `std-graph-grid` IS the engine: the diagram lives in its shadow root, it
// owns its wire/label stylesheet, and it drives its own re-layout off the
// framework's size hook. It is also the default GraphRenderer engine (see
// GraphGrid.renderer); swap in another via GraphRenderer.use().
//
// The one thing it cannot own is how the caller's boxes look — nodes are
// caller-built elements, and the wire classes (`dashed`, `tr-removed`, …)
// are the caller's vocabulary. Moving them into this shadow root puts them
// out of reach of the caller's own stylesheet, so the spec carries a theme
// sheet and the component adopts it. Callers keep their diagram CSS; the
// component just hosts it.

const COL_GAP = 40;
const ROW_GAP = 18;

@component({ name: "std-graph-grid" })
export class GraphGrid extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");
  private $grid: HTMLElement = this.$("grid");
  private $labels: HTMLElement = this.$("labels");
  private $wires: SVGSVGElement = this.hydrate<SVGSVGElement>("wires");

  private nodes: GraphRenderer.Node[] = [];
  /** Edges the layout kept, index-aligned with `layout.edges`. */
  private edges: GraphRenderer.Edge[] = [];
  /** The authored direction (`dir` itself is HTMLElement's). */
  private preferredDir: "LR" | "TD" = "LR";
  private layout: Option<GraphLayout.Out> = null;
  private activeDir: "LR" | "TD" = "LR";
  private activeCross: Option<number> = null;
  private waypoints: HTMLElement[][] = [];
  private byId = new Map<string, HTMLElement>();
  /** Natural LR width, measured once — the flip-back threshold. */
  private lrWidth: Option<number> = null;
  /** Natural (unbudgeted) TD width — the threshold for spending the column
   * budget at all. Without it a container that merely hugs its content reads
   * as "too narrow" and tiles a diagram that already fits. */
  private tdWidth: Option<number> = null;
  private contentObserver: Option<ResizeObserver> = null;

  bind(spec: GraphRenderer.Spec): this {
    if (spec.theme != null) this.addStyle("theme", spec.theme);
    const ids = new Set(spec.nodes.map((n) => n.id));
    this.nodes = spec.nodes;
    // Mirrors the layout's own edge filter so layout.edges[i] ↔ edges[i]
    // (parallel edges included — no lossy pair-keyed lookup).
    this.edges = spec.edges.filter(
      (e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to,
    );
    this.preferredDir = spec.dir;
    this.activeDir = spec.dir;
    this.activeCross = null;
    this.lrWidth = null;
    this.tdWidth = null;
    this.byId.clear();

    this.$grid.style.gap = `${ROW_GAP}px ${COL_GAP}px`;
    if (this.$wires.childNodes.length === 0) {
      this.$wires.appendChild(ReviewSvg.$arrowDefs("gg-arrow"));
    }
    this.place(spec.dir, null);
    this.observeContent();
    return this;
  }

  /** The container's width is the input the layout adapts to, and the
   * framework's size hook already reports it. The grid gets an observer of
   * its own for the other direction — content that grows after a font load
   * or a note reflow moves the boxes the wires were measured from. */
  connectedCallback(): void {
    this.onSizeChange = () => requestAnimationFrame(() => this.fit());
    super.connectedCallback();
    this.observeContent();
  }

  disconnectedCallback(): void {
    this.contentObserver?.disconnect();
    this.contentObserver = null;
    super.disconnectedCallback();
  }

  private observeContent(): void {
    if (!this.isConnected) return;
    this.contentObserver ??= new ResizeObserver(() =>
      requestAnimationFrame(() => this.fit())
    );
    this.contentObserver.disconnect();
    this.contentObserver.observe(this.$grid);
  }

  private place(d: "LR" | "TD", cross: Option<number>): void {
    this.activeDir = d;
    this.activeCross = cross;
    const layout = GraphLayout.layout(
      this.nodes.map((n) => n.id),
      this.edges.map((e) => ({ from: e.from, to: e.to })),
      d,
      cross,
    );
    this.layout = layout;
    this.$grid.style.gridTemplateColumns = `repeat(${layout.cols}, max-content)`;
    for (const n of this.nodes) {
      const cell = layout.cells.get(n.id);
      if (cell == null) continue;
      n.$el.style.gridColumn = String(cell.col + 1);
      n.$el.style.gridRow = String(cell.row + 1);
      n.$el.style.alignSelf = "center";
      n.$el.style.justifySelf = "center";
      if (n.$el.parentElement !== this.$grid) this.$grid.appendChild(n.$el);
      this.byId.set(n.id, n.$el);
    }
    // Waypoint markers occupy the cells long edges route through, so wire
    // geometry comes from the same measured layout as everything else.
    for (const ws of this.waypoints) for (const $w of ws) $w.remove();
    this.waypoints = layout.edges.map((e) =>
      e.via.map((cell) => {
        const $w = Div.make();
        $w.className = "waypoint";
        $w.style.gridColumn = String(cell.col + 1);
        $w.style.gridRow = String(cell.row + 1);
        $w.style.alignSelf = "center";
        $w.style.justifySelf = "center";
        this.$grid.appendChild($w);
        return $w;
      })
    );
  }

  /** Route and label every wire in FOUR phases — measure, append, measure,
   * position — never one edge at a time.
   *
   * Every phase boundary here is a forced synchronous layout: reading geometry
   * after a DOM write makes the engine flush styles + layout for the whole
   * document before it can answer. Per-edge (append the path, append the label,
   * then read that label's `offsetWidth`) that flush happened once PER EDGE, and
   * the document being flushed is the entire review pane — thousands of diff
   * rows. A profile of one node selection put ~38ms in `placeLabel`'s two
   * `offset*` reads alone, on a diagram of a handful of edges. Batched, the
   * whole pass costs two flushes no matter how many edges there are. */
  private draw(): void {
    const layout = this.layout;
    if (layout == null) return;
    while (this.$wires.childNodes.length > 1) this.$wires.lastChild!.remove();
    this.$labels.replaceChildren();
    const origin = this.$root.getBoundingClientRect();
    if (origin.width === 0) return;
    const rect = (el: Element): DOMRect => {
      const r = el.getBoundingClientRect();
      return new DOMRect(r.x - origin.x, r.y - origin.y, r.width, r.height);
    };
    // ── read: all geometry, before a single append ──
    const nodeRects = [...this.byId.values()].map(rect);
    const routed: { pts: ReviewSvg.Pt[]; spec: Option<GraphRenderer.Edge> }[] = [];
    layout.edges.forEach((edge, i) => {
      const $a = this.byId.get(edge.from);
      const $b = this.byId.get(edge.to);
      if ($a == null || $b == null) return;
      const vias = this.waypoints[i].map((w) => {
        const r = rect(w);
        return { x: r.x, y: r.y };
      });
      routed.push({
        pts: GraphGrid.route(rect($a), rect($b), vias, this.activeDir),
        spec: this.edges[i] ?? null,
      });
    });
    // ── write: wires and labels into the DOM ──
    const labelled: { $label: HTMLElement; pts: ReviewSvg.Pt[] }[] = [];
    for (const { pts, spec } of routed) {
      const cls = spec?.cls != null && spec.cls !== "" ? spec.cls : null;
      const $path = ReviewSvg.$path(
        ReviewSvg.polyPath(pts),
        cls != null ? `wire ${cls}` : "wire",
      );
      $path.setAttribute("marker-end", "url(#gg-arrow)");
      this.$wires.appendChild($path);
      const label = spec?.label;
      if (label == null || label === "") continue;
      const $label = Typography.p(label, "small");
      $label.classList.add("wire-label");
      if (cls != null) for (const c of cls.split(" ")) $label.classList.add(c);
      this.$labels.appendChild($label);
      labelled.push({ $label, pts });
    }
    // ── read: every label's box in one pass (ONE flush for all of them) ──
    const sizes = labelled.map(({ $label }) => ({
      width: $label.offsetWidth,
      height: $label.offsetHeight,
    }));
    // ── write: the chosen positions, no reads left to force another flush ──
    labelled.forEach(({ $label, pts }, i) => {
      const size = sizes[i];
      if (size == null) return;
      GraphGrid.positionLabel($label, pts, nodeRects, size);
    });
  }

  /** How many node boxes the container can hold side by side, off the widest
   * *placed* box — measured geometry, never measured text, so the budget
   * already accounts for fonts, padding, and the box max-width. */
  private columnBudget(avail: number): Option<number> {
    let widest = 0;
    for (const n of this.nodes) widest = Math.max(widest, n.$el.offsetWidth);
    if (avail <= 0 || widest <= 0) return null;
    return Math.max(1, Math.floor((avail + COL_GAP) / (widest + COL_GAP)));
  }

  /** Fit-then-draw. Two levers, in order: flip LR→TD when the column is too
   * narrow for the diagram's natural width (and back when it fits again),
   * then hand TD the container's column budget so a rank wider than the
   * container tiles downward instead of overflowing it. */
  private fit(): void {
    if (!this.isConnected || this.layout == null) return;
    const avail = this.$root.clientWidth;
    let want: "LR" | "TD" = this.activeDir;
    if (this.preferredDir === "LR") {
      if (
        this.activeDir === "LR" && this.lrWidth == null &&
        this.$grid.offsetWidth > 0
      ) {
        this.lrWidth = this.$grid.offsetWidth;
      }
      if (avail > 0 && this.lrWidth != null) {
        want = this.lrWidth <= avail ? "LR" : "TD";
      }
    }
    if (
      want === "TD" && this.activeDir === "TD" && this.activeCross == null &&
      this.$grid.offsetWidth > 0
    ) {
      this.tdWidth = this.$grid.offsetWidth;
    }
    const overflows = want === "TD" && avail > 0 && this.tdWidth != null &&
      this.tdWidth > avail;
    const cross = overflows ? this.columnBudget(avail) : null;
    // Re-place only on a real change: place() resizes the grid, which wakes
    // the observer again, and an unconditional call would never settle.
    if (want !== this.activeDir || cross !== this.activeCross) {
      this.place(want, cross);
    }
    this.draw();
  }

  static $styles = [
    // The wire labels are Typography.p()s, so the engine has to carry the
    // typography rules — its own shadow root is the only place they reach.
    Typography.$style,
    css`
      :host {
        display: block;
        /* Take the column instead of hugging the diagram: under a
         * shrink-to-fit parent (the storybook card's centered flex slot) an
         * auto width reports a container as wide as the content, so the
         * layout never learns it has to adapt and the diagram spills past
         * the card's padding. Any residual overflow stays inside, which is
         * also what lets a placer make the frame resizable. */
        width: 100%;
        box-sizing: border-box;
        overflow: auto;
      }

      /* The measurement origin. Absolutely-positioned wires and labels are
       * placed against it, so it must be the element that scrolls WITH them
       * — not the scroll container itself. */
      #root {
        position: relative;
        width: 100%;
        margin-inline: auto;
      }

      #grid {
        display: grid;
        position: relative;
        width: max-content;
        margin-inline: auto;
      }

      #wires {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        overflow: visible;
      }

      .waypoint {
        width: 1px;
        height: 1px;
      }

      .wire {
        fill: none;
        stroke: var(--fg-icon-ter, var(--text-ter));
        stroke-width: 1.2;
      }

      .wire.dashed {
        stroke-dasharray: 4 3;
      }

      .arrow {
        fill: var(--fg-icon-ter, var(--text-ter));
        stroke: none;
      }

      .wire-label {
        position: absolute;
        --font-size: var(--text-7px);
        color: var(--text-sec);
        max-width: 22ch;
        width: max-content;
        margin: 0;
        /* Bare text with a halo in the surface colour — legible over a wire,
         * never a filled box pasted over neighboring nodes. */
        text-shadow:
          0 1px 2px var(--graph-surface, var(--bg)),
          0 -1px 2px var(--graph-surface, var(--bg)),
          1px 0 2px var(--graph-surface, var(--bg)),
          -1px 0 2px var(--graph-surface, var(--bg));
      }
    `,
  ];

  // Wires first: the overlay paints UNDER the boxes, so a wire can never
  // occlude a node. Labels ride above everything but carry no fill.
  static $html = html`
    <div id="root">
      <svg id="wires"></svg>
      <div id="grid"></div>
      <div id="labels"></div>
    </div>
  `;
}

export namespace GraphGrid {
  export type NodeSpec = GraphRenderer.Node;
  export type EdgeSpec = GraphRenderer.Edge;

  /** The default engine, for `GraphRenderer.current() ?? GraphGrid.renderer`. */
  export const renderer: GraphRenderer.Renderer = {
    $render: (spec) => GraphGrid.make().bind(spec),
  };

  /** Orthogonal-ish route between two boxes through the layout's waypoint
   * cells. Forward edges leave the flow side; back edges detour through the
   * gap beyond both boxes. */
  export function route(
    a: DOMRect,
    b: DOMRect,
    via: ReviewSvg.Pt[],
    dir: "LR" | "TD",
  ): ReviewSvg.Pt[] {
    if (dir === "LR") {
      const forward = b.left >= a.right - 1;
      if (forward) {
        const start = { x: a.right, y: a.top + a.height / 2 };
        const end = { x: b.left, y: b.top + b.height / 2 };
        if (via.length > 0) return [start, ...via, end];
        if (Math.abs(start.y - end.y) < 2) return [start, end];
        const midX = (start.x + end.x) / 2;
        return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
      }
      const start = { x: a.left, y: a.top + a.height / 2 };
      const end = { x: b.right, y: b.top + b.height / 2 };
      const detourX = Math.min(a.left, b.right) - COL_GAP / 2;
      return [start, { x: detourX, y: start.y }, { x: detourX, y: end.y }, end];
    }
    const forward = b.top >= a.bottom - 1;
    if (forward) {
      const start = { x: a.left + a.width / 2, y: a.bottom };
      const end = { x: b.left + b.width / 2, y: b.top };
      if (via.length > 0) return [start, ...via, end];
      if (Math.abs(start.x - end.x) < 2) return [start, end];
      const midY = (start.y + end.y) / 2;
      return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
    }
    const start = { x: a.left + a.width / 2, y: a.top };
    const end = { x: b.left + b.width / 2, y: b.bottom };
    const detourY = Math.min(a.top, b.bottom) - ROW_GAP;
    return [start, { x: start.x, y: detourY }, { x: end.x, y: detourY }, end];
  }

  /** Place a label from an ALREADY-MEASURED box. The size is a parameter
   * rather than an `offsetWidth` read inside here on purpose: the caller
   * measures every label in one batch, so this function does writes only and
   * cannot force a layout mid-loop (see `draw`). */
  export function positionLabel(
    $label: HTMLElement,
    pts: ReviewSvg.Pt[],
    nodeRects: DOMRect[],
    size: { width: number; height: number },
  ): void {
    const { width, height } = size;
    const clearance = 6;
    const segments = pts.slice(0, -1).map((a, i) => ({ a, b: pts[i + 1] }))
      .sort(
        (a, b) => segmentLength(b) - segmentLength(a),
      );
    type Candidate = { left: number; top: number; centered: boolean };
    const candidates: Candidate[] = [];
    for (const segment of segments) {
      const midX = (segment.a.x + segment.b.x) / 2;
      const midY = (segment.a.y + segment.b.y) / 2;
      const horizontal = Math.abs(segment.a.y - segment.b.y) <= 1;
      if (horizontal) {
        candidates.push(
          {
            left: midX - width / 2,
            top: midY - height - clearance,
            centered: true,
          },
          { left: midX - width / 2, top: midY + clearance, centered: true },
        );
      } else {
        candidates.push(
          { left: midX + clearance, top: midY - height / 2, centered: false },
          {
            left: midX - width - clearance,
            top: midY - height / 2,
            centered: false,
          },
        );
      }
    }
    const chosen =
      candidates.find((candidate) =>
        !nodeRects.some((node) =>
          intersects(candidate, width, height, node, clearance)
        )
      ) ?? fallbackLabelPosition(pts, nodeRects, width, height, clearance);
    if (chosen == null) return;
    $label.style.left = `${chosen.left}px`;
    $label.style.top = `${chosen.top}px`;
    $label.style.transform = "none";
    $label.style.textAlign = chosen.centered ? "center" : "left";
  }

  function segmentLength(
    segment: { a: ReviewSvg.Pt; b: ReviewSvg.Pt },
  ): number {
    return Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
  }

  /** A congested route can exhaust both sides of every segment. Keep the
   * label out of node boxes even then by moving it into a lane immediately
   * above the measured diagram. The wire still points to its relationship,
   * and the SVG/root both allow visible overflow. */
  function fallbackLabelPosition(
    pts: ReviewSvg.Pt[],
    nodeRects: DOMRect[],
    width: number,
    height: number,
    clearance: number,
  ): { left: number; top: number; centered: boolean } | undefined {
    const start = pts[0];
    const end = pts[pts.length - 1];
    if (start == null || end == null) return undefined;
    const top = nodeRects.length === 0
      ? Math.min(start.y, end.y) - height - clearance
      : Math.min(...nodeRects.map((node) => node.top)) - height - clearance;
    return {
      left: Math.max(0, (start.x + end.x - width) / 2),
      top,
      centered: true,
    };
  }

  function intersects(
    candidate: { left: number; top: number },
    width: number,
    height: number,
    node: DOMRect,
    clearance: number,
  ): boolean {
    return !(
      candidate.left + width + clearance <= node.left ||
      candidate.left - clearance >= node.right ||
      candidate.top + height + clearance <= node.top ||
      candidate.top - clearance >= node.bottom
    );
  }
}
