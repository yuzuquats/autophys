import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { BranchLayout } from "./branch-graph-layout";

// std-branch-graph: a list of steps drawn as a git tree. Rows run top to
// bottom; each sits on a LANE, carries a MARK on it, and is joined to the
// rows it leads to by lines — straight down its lane, or curving across to
// another lane where the path forks or merges. A step list that branches (an
// onboarding funnel, a review stack forked off master, a fleet of hosts'
// stacks) reads as one picture instead of a numbered list that cannot say
// where the paths part.
//
// WHERE IT COMES FROM. commit-review's rail (`commit-review/ui/components/
// commit-review/stack-log.ts`, in NODES mode) is the reference drawing, and
// the `rail` register here is that rail number for number: 40px rows 1px
// apart, the medallion centred on the row, lane 0 at x=9 and lane 1 at x=23
// in a 36px graph column, 1.5px lane strokes in --divider, 12px medallions
// in a 12-unit box (circle r4.4, square 8 rx1.5, diamond, triangle, hexagon)
// with a 1.4 hollow stroke, dotted = 2 3, an 18px fork row whose bezier has
// vertical tangents at both ends, a 9px-cap subject over a 7px-cap tertiary
// sub, container rows with a strip of 7px state pips and a trailing 14px
// chevron, "⋯ N commits" collapsed runs and an "older history" tail on
// dotted segments. The other registers (`default`, `compact`, `dense`) are
// std-stepper's: the mark holds the top of the row so a wrapping title keeps
// its first line beside it.
//
// From std-stepper it also takes the two rules that make this a list rather
// than a picture of one: rows are real DOM that size themselves from their
// text, and the line never crosses a mark — it stops at the mark's edge,
// with a gap around a hollow one (the rail's percent-gap rule, in px).
//
// HOW IT DRAWS. Each row carries its own graph column: the lane segments
// that cross it as thin absolutely positioned boxes (full height, or from the
// row's top to the mark and from the mark to the bottom), overdrawn past the
// row's edges by half the row gap so they meet seamlessly (the rail's
// svg.lines trick), and the mark over them in a small SVG. A gap between two
// rows that holds a fork or a merge becomes a short strip of its own with the
// curves in it (the rail's fork row, generalised). A gap with no curve is not
// drawn. Which lines cross which row is decided by `branch-graph-layout.ts` —
// pure, and pinned by its deno test.
//
// LANES. Pass lanes on the rows yourself (and `via` on an edge when the
// default routing is not what you mean), or hand a DAG to
// `BranchGraph.fromDag` and take its rows: topological order, the first edge
// out of a row continues that row's lane, other edges open lanes, lanes free
// on merge and at terminals. The onboarding canvas uses `fromDag`; a
// two-lane log that already knows its lanes passes them.
//
// MOVING THE STACK LOG ONTO THIS. stack-log.ts is mid-edit by its owner and
// is NOT migrated here; its rows map onto this model as follows, for when it
// moves (also written up in commit-review's docs/branch-graph.md):
//
//   flat/nodes mode rows                  density "rail"
//   mainline (public diamonds, x=9)       lane 0, mark diamond, muted title,
//                                         `body` = the handle line (D-177)
//   branch lane (drafts, x=23)            lane 1
//   fork curve row (`$forkCurve`)         automatic: the strip in the gap
//                                         under the last draft (an edge
//                                         draft → origin/master, 1 → 0)
//   fleet passThrough trunk               automatic: a lane with an edge
//                                         across a row is drawn through it
//   dotted pre-commit connectors          edges with style "dotted"
//   `node hollow dashed` (@ unstaged)     mark { fill: "hollow", dashed }
//   project container row                 mark hexagon hollow, `pips`,
//                                         accessory "chevron", `expanded`
//   `$collapsed` "⋯ N commits"            kind "run", no mark, dotted edges
//   `$tail` "older history"               kind "tail", no mark, dotted edge
//   verdict palette (.node.pending …)     mark.tone / pip tone (var(--yellow))
//   `.row.active`                         current
//   host badge / compact chip             not modelled — row content
//
// SELECTION. A row with a `key` is selectable: click or Enter/Space reports
// it through `onSelect`, arrow keys move between selectable rows (one tab
// stop for the whole list). A row with a chevron reports the chevron (and
// ArrowRight / ArrowLeft) through `onToggle` instead. A row without a key is
// inert. The owner decides what is current and what is expanded and rebinds;
// nothing here holds that state.

/** Pixel geometry per register. JS-owned because the drawing needs numbers;
 * the row CSS reads the same numbers back through custom properties set on
 * the host, so a row's box and the lines drawn over it cannot disagree. */
type Geometry = {
  /** Mark box, px. The 12-unit medallion paths scale to it. */
  mark: number;
  /** Lane centre to lane centre. */
  pitch: number;
  /** Graph edge to the first lane's centre. */
  inset: number;
  /** Last lane's centre to the graph's right edge. */
  trail: number;
  /** The graph column is never narrower than this many lanes (the rail's
   * column is 36px whether or not a branch is on screen). */
  minLanes: number;
  /** Row padding above and below the mark (top-aligned registers). */
  padY: number;
  /** Marks centre on the row (the rail) rather than hold its top. */
  center: boolean;
  /** Space between rows; the lines are overdrawn across it. */
  rowGap: number;
  /** Height of a gap strip that holds a curve. */
  strip: number;
  /** Lane stroke, and the walked path's stroke. */
  line: number;
  walked: number;
  /** Space between the graph column and the text. */
  textGap: number;
};

const GEOMETRY: Record<BranchGraph.Density, Geometry> = {
  rail: { mark: 12, pitch: 14, inset: 9, trail: 13, minLanes: 2, padY: 14, center: true, rowGap: 1, strip: 18, line: 1.5, walked: 2, textGap: 0 },
  default: { mark: 12, pitch: 14, inset: 9, trail: 9, minLanes: 1, padY: 8, center: false, rowGap: 0, strip: 16, line: 1.5, walked: 2, textGap: 4 },
  compact: { mark: 12, pitch: 14, inset: 9, trail: 9, minLanes: 1, padY: 6, center: false, rowGap: 0, strip: 14, line: 1.5, walked: 2, textGap: 4 },
  dense: { mark: 12, pitch: 14, inset: 9, trail: 9, minLanes: 1, padY: 6, center: false, rowGap: 1, strip: 14, line: 1.5, walked: 2, textGap: 6 },
};

/** Half-heights of each medallion above and below its centre, in its
 * 12-unit box — where a line has to stop so it meets the shape's edge. */
const EXTENT: Record<BranchGraph.Shape, { up: number; down: number }> = {
  circle: { up: 4.4, down: 4.4 },
  square: { up: 4, down: 4 },
  diamond: { up: 4.8, down: 4.8 },
  triangle: { up: 4.4, down: 4 },
  hexagon: { up: 5, down: 5 },
};

/** Dash patterns as [on, off] px — the rail's `2 3` dotted. */
const DASH: Record<BranchLayout.LineStyle, Option<[number, number]>> = {
  solid: null,
  dashed: [4, 3],
  dotted: [2, 3],
};

const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const $e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) $e.setAttribute(k, String(v));
  return $e;
}

/** The accordion / dropdown chevron the rail's container rows use. */
const CHEVRON = "M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z";

@component({ name: "std-branch-graph" })
export class BranchGraph extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");
  private model: BranchGraph.Model = { rows: [] };

  /** Set by the owner: a row carrying a key was chosen (click, Enter or
   * Space). Rows without a key are inert. */
  onSelect: Option<(key: string) => void> = null;

  /** Set by the owner: a row's chevron was clicked, or ArrowRight /
   * ArrowLeft pressed on it. Reports the row's id; the owner flips
   * `expanded` and rebinds. */
  onToggle: Option<(id: string) => void> = null;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$root, {
      onClick: (_captured, _offset, event) => {
        const $target = event.target as Element;
        // Trailing content may be a link of its own; let it navigate.
        if ($target.closest("a[href]") != null) return;
        const $row = $target.closest<HTMLElement>(".row");
        if ($row == null) return;
        if ($target.closest(".accessory") != null && $row.dataset.toggle != null) {
          this.onToggle?.($row.dataset.id!);
          return;
        }
        const key = $row.dataset.key;
        if (key == null) return;
        this.focusRow($row, false);
        this.onSelect?.(key);
      },
    });
    this.$root.addEventListener("keydown", (e) => this.onKey(e));
  }

  bind(model: BranchGraph.Model): void {
    this.model = model;
    const density = model.density ?? "default";
    const geo = GEOMETRY[density];
    const layout = BranchLayout.route(model.rows);
    const lanes = Math.max(geo.minLanes, layout.lanes);
    const width = geo.inset + Math.max(0, lanes - 1) * geo.pitch + geo.trail;
    this.style.setProperty("--bg-graph", `${width}px`);
    this.style.setProperty("--bg-pad-y", `${geo.padY}px`);
    this.style.setProperty("--bg-mark", `${geo.mark}px`);
    this.style.setProperty("--bg-row-gap", `${geo.rowGap}px`);
    this.style.setProperty("--bg-text-gap", `${geo.textGap}px`);
    this.setAttribute("density", density);

    const selectable = model.rows.some((r) => r.key != null);
    this.$root.setAttribute("role", selectable ? "listbox" : "list");
    if (model.label) this.$root.setAttribute("aria-label", model.label);
    else this.$root.removeAttribute("aria-label");

    const slotted: Element[] = [];
    const $items: HTMLElement[] = [];
    model.rows.forEach((row, i) => {
      $items.push(this.$row(row, i, layout.rows[i]!, geo, selectable, slotted));
      const gap = layout.gaps[i];
      if (gap?.curved) $items.push(this.$strip(gap, geo, width));
    });
    // The roving tab stop: the current row, else the first selectable one.
    const $stop = $items.find((r) => r.classList.contains("current") && r.dataset.key != null) ??
      $items.find((r) => r.dataset.key != null);
    if ($stop) $stop.tabIndex = 0;
    this.replaceChildren(...slotted);
    this.$root.replaceChildren(...$items);
  }

  /** Scroll the current row into view in whatever scrolls this graph,
   * only as far as needed. For a panel that follows something else's state
   * (the canvas's Preview); a list the reader is scrolling should not call
   * it. */
  revealCurrent(): void {
    this.$root.querySelector<HTMLElement>(".row.current")?.scrollIntoView({ block: "nearest" });
  }

  static makeWith(model: BranchGraph.Model): BranchGraph {
    const $g = BranchGraph.make();
    $g.bind(model);
    return $g;
  }

  // --- rows ------------------------------------------------------------------

  private laneColor(lane: number): string {
    return this.model.lanes?.[lane]?.color ?? "var(--branch-line-color, var(--divider))";
  }

  private $row(
    row: BranchGraph.Row,
    index: number,
    lay: BranchLayout.RowLayout,
    geo: Geometry,
    selectable: boolean,
    slotted: Element[],
  ): HTMLElement {
    const $li = document.createElement("li");
    $li.className = `row ${row.kind ?? "step"}`;
    $li.dataset.id = row.id;
    if (row.current) $li.classList.add("current");
    if (row.visited) $li.classList.add("visited");
    if (row.muted) $li.classList.add("muted");
    if (row.proposed) $li.classList.add("proposed");
    if (selectable) {
      $li.setAttribute("role", "option");
      $li.setAttribute("aria-selected", String(row.current));
      if (row.key == null) $li.setAttribute("aria-disabled", "true");
    }
    if (row.current) $li.setAttribute("aria-current", "step");
    if (row.key != null) {
      $li.dataset.key = row.key;
      $li.tabIndex = -1;
    }

    $li.appendChild(this.$graphCell(row, lay, geo));

    const $content = document.createElement("div");
    $content.className = "content";
    const $head = document.createElement("div");
    $head.className = "head";
    $head.appendChild(this.$content(row.title, "title", `title-${index}`, slotted));
    if (row.meta != null) $head.appendChild(this.$content(row.meta, "meta", `meta-${index}`, slotted));
    $content.appendChild($head);
    if (row.body != null) $content.appendChild(this.$content(row.body, "body", `body-${index}`, slotted));
    if (row.pips != null && row.pips.length > 0) $content.appendChild($pips(row.pips));
    $li.appendChild($content);

    if (row.accessory === "chevron") {
      $li.dataset.toggle = "";
      $li.classList.toggle("expanded", row.expanded === true);
      if (selectable || row.key != null) $li.setAttribute("aria-expanded", String(row.expanded === true));
      const $acc = document.createElement("div");
      $acc.className = "accessory";
      const $chev = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
      $chev.appendChild(svg("path", { d: CHEVRON }));
      $acc.appendChild($chev);
      $li.appendChild($acc);
    }
    return $li;
  }

  /** The row's slice of the graph: lanes passing by, the halves into and
   * out of its mark, and the mark on top. Lines are boxes positioned in CSS
   * so the mark's height can be `50%` (the rail) as readily as a px offset
   * (the stepper registers) without anything measuring the row. */
  private $graphCell(row: BranchGraph.Row, lay: BranchLayout.RowLayout, geo: Geometry): HTMLElement {
    const $g = document.createElement("div");
    $g.className = "graph";
    $g.setAttribute("aria-hidden", "true");
    const x = (lane: number) => geo.inset + lane * geo.pitch;
    const cy = geo.center ? "50%" : `${geo.padY + geo.mark / 2}px`;
    const scale = geo.mark / 12;
    const mark = row.mark;
    const hollow = mark != null && (mark.fill === "hollow" || row.proposed);
    const halo = row.current && mark != null && !geo.center;
    // Where a line stops: the shape's own edge, a gap clear of a hollow one,
    // clear of the current row's halo. No mark: the line runs to the centre
    // (a tail ends there; a collapsed run passes straight through).
    let up = 0;
    let down = 0;
    if (mark != null) {
      const ext = EXTENT[mark.shape];
      const gap = hollow ? 2 : -0.25;
      up = ext.up * scale + gap;
      down = ext.down * scale + gap;
      if (halo) {
        up = Math.max(up, geo.mark / 2 + 3);
        down = Math.max(down, geo.mark / 2 + 3);
      }
    }
    const over = `var(--bg-overdraw)`;
    const lines: { lane: number; line: BranchLayout.Line; top: string; bottom: string }[] = [];
    for (const t of lay.through) lines.push({ lane: t.lane, line: t, top: `calc(-1 * ${over})`, bottom: `calc(-1 * ${over})` });
    if (lay.above) {
      lines.push({ lane: lay.lane, line: lay.above, top: `calc(-1 * ${over})`, bottom: `calc(100% - ${cy} + ${up}px)` });
    }
    if (lay.below) {
      lines.push({ lane: lay.lane, line: lay.below, top: `calc(${cy} + ${down}px)`, bottom: `calc(-1 * ${over})` });
    }
    lines.sort((a, b) => Number(a.line.walked) - Number(b.line.walked));
    for (const l of lines) {
      const w = l.line.walked ? geo.walked : geo.line;
      const $l = document.createElement("div");
      $l.className = l.line.walked ? "lane walked" : "lane";
      const color = l.line.walked ? "var(--branch-walked-color, var(--text-sec))" : this.laneColor(l.lane);
      const dash = DASH[l.line.style];
      $l.style.cssText = `left:${x(l.lane) - w / 2}px;width:${w}px;top:${l.top};bottom:${l.bottom};` +
        (dash
          ? `background:repeating-linear-gradient(to bottom, ${color} 0px ${dash[0]}px, transparent ${dash[0]}px ${dash[0] + dash[1]}px)`
          : `background:${color}`);
      $g.appendChild($l);
    }

    if (mark != null) {
      const box = geo.mark + 8;
      const tone = mark.tone ??
        (row.current
          ? "var(--branch-current, var(--blue))"
          : row.visited
          ? "var(--branch-visited, var(--text-sec))"
          : "var(--branch-mark, var(--text-ter))");
      const $s = svg("svg", {
        class: hollow ? "mark hollow" : "mark",
        width: box,
        height: box,
        viewBox: `0 0 ${box} ${box}`,
      });
      $s.style.cssText = `left:${x(row.lane) - box / 2}px;top:calc(${cy} - ${box / 2}px)`;
      if (halo) {
        $s.appendChild(svg("circle", {
          class: "halo",
          cx: box / 2,
          cy: box / 2,
          r: geo.mark / 2 + 3,
          style: `fill: color-mix(in srgb, ${tone} 22%, transparent)`,
        }));
      }
      const $shape = medallion(mark.shape);
      $shape.setAttribute(
        "style",
        hollow
          ? `fill: none; stroke: ${tone}; stroke-width: ${1.4 / Math.min(1, scale)}`
          : `fill: ${tone}; stroke: none`,
      );
      if (hollow && (mark.dashed || row.proposed)) $shape.setAttribute("stroke-dasharray", "2 2");
      const $m = svg("g", { transform: `translate(4 4) scale(${scale})` });
      $m.appendChild($shape);
      $s.appendChild($m);
      $g.appendChild($s);
    }
    return $g;
  }

  /** A gap that holds a curve: every link across it, straight ones first,
   * and the labels of the branches that open here. */
  private $strip(gap: BranchLayout.Gap, geo: Geometry, width: number): HTMLElement {
    const $li = document.createElement("li");
    $li.className = "strip";
    $li.setAttribute("role", "presentation");
    $li.setAttribute("aria-hidden", "true");
    const labels = gap.labels.map((l) => ({ lane: l.lane, text: l.text }));
    for (const lane of gap.opens) {
      const named = this.model.lanes?.[lane]?.label;
      if (named && !labels.some((l) => l.lane === lane)) labels.push({ lane, text: named });
    }
    const h = labels.length > 0 ? Math.max(geo.strip, 18) : geo.strip;
    $li.style.height = `${h}px`;
    const over = geo.rowGap / 2 + 0.5;
    const total = h + 2 * over;
    const $s = svg("svg", { class: "curves", width, height: total, viewBox: `0 0 ${width} ${total}` });
    $s.style.top = `${-over}px`;
    const x = (lane: number) => geo.inset + lane * geo.pitch;
    for (const link of gap.links) {
      const lane = Math.max(link.from, link.to);
      const $e = link.from === link.to
        ? svg("line", { x1: x(link.from), x2: x(link.to), y1: 0, y2: total })
        // Vertical tangents at both ends: the curve leaves one lane and
        // lands on the other running parallel to it, so it reads as the lane
        // bending — the rail's `M23 0 C23 11, 9 7, 9 18`.
        : svg("path", {
          d: `M${x(link.from)} 0 C${x(link.from)} ${total * 0.61}, ${x(link.to)} ${total * 0.39}, ${x(link.to)} ${total}`,
          fill: "none",
        });
      $e.setAttribute(
        "style",
        link.walked
          ? `stroke: var(--branch-walked-color, var(--text-sec)); stroke-width: ${geo.walked}`
          : `stroke: ${this.laneColor(lane)}; stroke-width: ${geo.line}`,
      );
      const dash = DASH[link.style];
      if (dash) $e.setAttribute("stroke-dasharray", dash.join(" "));
      $s.appendChild($e);
    }
    $li.appendChild($s);
    if (labels.length > 0) {
      const $label = document.createElement("span");
      $label.className = "strip-label";
      $label.textContent = labels.map((l) => l.text).join(" · ");
      const color = this.model.lanes?.[labels[0]!.lane]?.color;
      if (color) $label.style.color = color;
      $li.appendChild($label);
    }
    return $li;
  }

  /** A string gets this component's typography. An element stays the
   * caller's: it is SLOTTED, not adopted, so it keeps the caller's own
   * stylesheet (std-stepper's rule, for the same reason — a commit-review
   * handle's hover and size live in commit-review's sheet). */
  private $content(
    content: BranchGraph.Content,
    cls: string,
    slot: string,
    slotted: Element[],
  ): HTMLElement {
    if (typeof content === "string") {
      const $t = Typography.p(content);
      $t.className = cls;
      return $t;
    }
    content.slot = slot;
    slotted.push(content);
    const $slot = document.createElement("slot");
    $slot.name = slot;
    $slot.className = cls;
    return $slot;
  }

  // --- keyboard --------------------------------------------------------------

  private rows(): HTMLElement[] {
    return [...this.$root.querySelectorAll<HTMLElement>(".row[data-key]")];
  }

  private focusRow($row: HTMLElement, focus = true): void {
    for (const $r of this.rows()) $r.tabIndex = $r === $row ? 0 : -1;
    if (focus) $row.focus();
  }

  private onKey(e: KeyboardEvent): void {
    const $row = (e.target as Element).closest?.<HTMLElement>(".row[data-key]");
    if ($row == null) return;
    const rows = this.rows();
    const i = rows.indexOf($row);
    let $next: Option<HTMLElement> = null;
    if (e.key === "ArrowDown") $next = rows[i + 1];
    else if (e.key === "ArrowUp") $next = rows[i - 1];
    else if (e.key === "Home") $next = rows[0];
    else if (e.key === "End") $next = rows[rows.length - 1];
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && $row.dataset.toggle != null) {
      const open = $row.classList.contains("expanded");
      if (open === (e.key === "ArrowLeft")) {
        e.preventDefault();
        this.onToggle?.($row.dataset.id!);
      }
      return;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const key = $row.dataset.key;
      if (key != null) this.onSelect?.(key);
      return;
    } else return;
    e.preventDefault();
    if ($next) this.focusRow($next);
  }

  static $styles = [
    css`
      :host {
        display: block;
        --bg-graph: 36px;
        --bg-pad-y: 8px;
        --bg-mark: 12px;
        --bg-row-gap: 0px;
        --bg-text-gap: 4px;
        --bg-overdraw: calc(var(--bg-row-gap) / 2 + 0.5px);
      }

      /* An ordered list, reset the way std-stepper resets one: the
         typography ramp matches a bare OL and would trim it like prose. */
      #root {
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-height: unset;
        list-style: none;
        margin: 0px;
        padding: 0px;
        display: flex;
        flex-direction: column;
        gap: var(--bg-row-gap);
      }

      .row,
      .strip {
        position: relative;
        margin: 0px;
        padding: 0px;
      }

      /* The graph column: the row's full height. Its lines overdraw the row
         by half the row gap (plus half a pixel), so one row's segment meets
         the next row's with no seam. */
      .graph {
        position: absolute;
        left: 0px;
        top: 0px;
        bottom: 0px;
        width: var(--bg-graph);
        pointer-events: none;
      }
      .graph .lane,
      .graph svg.mark {
        position: absolute;
      }
      .graph svg.mark,
      svg.curves {
        overflow: visible;
        display: block;
      }
      svg.curves {
        position: absolute;
        left: 0px;
        pointer-events: none;
      }

      .row {
        display: flex;
        align-items: stretch;
        padding-left: calc(var(--bg-graph) + var(--bg-text-gap));
        border-radius: var(--branch-row-radius, 6px);
      }
      .content {
        flex: 1;
        min-width: 0px;
        display: flex;
        flex-direction: column;
        padding-right: var(--branch-pad-right, 8px);
      }

      /* The head is at least the mark's height plus its padding, so a
         one-line title centres on the mark; a wrapping title keeps its first
         line beside it (std-stepper's rule). */
      .head {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        min-height: calc(var(--bg-mark) + 2 * var(--bg-pad-y));
        padding: var(--bg-pad-y) 0px;
        box-sizing: border-box;
      }

      .title {
        --font-size: var(--branch-title-size, var(--p-size));
        --line-height-ratio: var(--branch-title-leading, 1.3);
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-height: unset;
        min-width: 0px;
        flex: 1;
        align-self: center;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: var(--branch-title-wrap, normal);
        color: var(--branch-title-color, var(--text-pri));
      }
      slot.title,
      slot.meta {
        display: inline-flex;
        align-items: center;
      }

      .meta {
        --font-size: var(--branch-meta-size, var(--small-size));
        --line-height-ratio: 1.1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-height: unset;
        flex: none;
        margin-left: auto;
        align-self: center;
        color: var(--branch-meta-color, var(--text-ter));
      }

      .body {
        display: block;
        --font-size: var(--branch-body-size, var(--small-size));
        --line-height-ratio: 1.45;
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-height: unset;
        margin-top: calc(-1 * var(--bg-pad-y) + 2px);
        padding-bottom: var(--bg-pad-y);
        color: var(--branch-body-color, var(--text-sec));
      }

      /* The state pips: one dot per member, the rail's container roll-up. */
      .pips {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 5px;
        margin-top: calc(-1 * var(--bg-pad-y) + 4px);
        padding-bottom: var(--bg-pad-y);
      }
      .pips svg {
        width: 7px;
        height: 7px;
        flex-shrink: 0;
        display: block;
        overflow: visible;
      }

      /* The trailing chevron: the rail's container accessory. Rotation is
         the open/close feedback. */
      .accessory {
        position: relative;
        display: flex;
        align-self: center;
        flex-shrink: 0;
        width: 14px;
        height: 14px;
        margin-right: 8px;
        cursor: pointer;
      }
      .accessory svg {
        width: 14px;
        height: 14px;
        fill: var(--text-ter);
        transition: transform 0.3s ease;
      }
      .row.expanded .accessory svg {
        transform: rotate(90deg);
      }
      .accessory::after {
        content: "";
        position: absolute;
        inset: -11px -8px;
      }
      @media (prefers-reduced-motion: reduce) {
        .accessory svg {
          transition: none;
        }
      }

      /* Selection chrome, opt-in: a row with no key is inert. */
      .row[data-key] {
        cursor: pointer;
      }
      /* Hover only where there is one: a tap must not leave a band behind. */
      @media (hover: hover) {
        .row[data-key]:hover {
          background: var(--branch-row-hover-bg, var(--bg-hover-light));
        }
      }
      .row.current {
        background: var(--branch-row-current-bg, var(--bg-hover));
      }
      .row.current .title {
        font-weight: 600;
      }
      .row[data-key]:focus-visible {
        outline: 2px solid var(--branch-focus, var(--blue));
        outline-offset: -2px;
      }

      /* Off the path (no screen, history): the title quiets and so does the
         mark — opacity, so a toned mark keeps its hue. The lane lines do NOT
         fade: the path still runs through this row. */
      .row.muted .title {
        color: var(--branch-title-muted-color, var(--text-ter));
      }
      .row.muted svg.mark {
        opacity: var(--branch-mark-muted-opacity, 0.45);
      }

      /* Proposed: not real yet. The mark goes hollow and dashed (set in the
         drawing); the title drops to secondary ink. */
      .row.proposed:not(.current) .title {
        color: var(--branch-title-proposed-color, var(--text-sec));
      }

      .strip {
        flex: none;
      }
      .strip-label {
        position: absolute;
        left: calc(var(--bg-graph) + var(--bg-text-gap));
        right: 0px;
        top: 50%;
        transform: translateY(-50%);
        font-size: var(--branch-label-font-size, 10px);
        line-height: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--branch-label-color, var(--text-ter));
        letter-spacing: 0.01em;
      }

      /* Summary rows: a collapsed run ("⋯ N steps") and a history tail. */
      .row.run .title,
      .row.tail .title {
        --font-size: var(--text-7px);
        color: var(--text-ter);
        font-weight: 400;
      }

      /* ── compact and dense ── */
      :host([density="compact"]) .title {
        --font-size: var(--branch-title-size, var(--small-size));
      }
      :host([density="dense"]) .title {
        --font-size: var(--branch-title-size, var(--text-8px));
        --line-height-ratio: var(--branch-title-leading, 1.1);
        white-space: var(--branch-title-wrap, nowrap);
      }
      :host([density="dense"]) .meta {
        --font-size: var(--branch-meta-size, var(--text-7px));
      }

      /* ── rail: commit-review's rail in nodes mode ──
         40px rows, the medallion centred on the row, a 9px-cap subject on
         one line over a 7px-cap tertiary sub (margin cap to cap, 7px), the
         content padded 5px 8px 5px 0. Current is the rail's active band and
         nothing else; history titles go tertiary with their medallion at
         full strength, as the rail's public diamonds do. */
      :host([density="rail"]) .row {
        min-height: 40px;
      }
      :host([density="rail"]) .row.run {
        min-height: 24px;
      }
      :host([density="rail"]) .row.tail {
        min-height: 22px;
      }
      :host([density="rail"]) .content {
        justify-content: center;
        padding: 5px 8px 5px 0px;
      }
      :host([density="rail"]) .head {
        min-height: 0px;
        padding: 0px;
        align-items: baseline;
        gap: 5px;
      }
      :host([density="rail"]) .title {
        --font-size: var(--branch-title-size, var(--text-9px));
        --line-height-ratio: 1.2;
        white-space: nowrap;
        align-self: auto;
      }
      :host([density="rail"]) .row.current .title {
        font-weight: 400;
      }
      :host([density="rail"]) .meta {
        --font-size: var(--branch-meta-size, var(--text-7px));
        align-self: auto;
      }
      :host([density="rail"]) .body {
        --font-size: var(--text-7px);
        --line-height-ratio: 1.2;
        --margin-top: 7px;
        margin-top: var(--rmargin-top);
        padding-bottom: 0px;
        color: var(--branch-body-color, var(--text-ter));
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      :host([density="rail"]) .pips {
        margin-top: 6px;
        padding-bottom: 0px;
        position: relative;
        top: 0.5px;
      }
      :host([density="rail"]) .row.run .title,
      :host([density="rail"]) .row.tail .title {
        --font-size: var(--text-7px);
      }
      :host([density="rail"]) .row.muted svg.mark {
        opacity: var(--branch-mark-muted-opacity, 1);
      }
      :host([density="rail"]) .row.expanded .title {
        color: var(--text-ter);
      }
      :host([density="rail"]) .row.expanded .pips {
        opacity: 0.45;
      }
    `,
  ];

  // `role` is set on bind: a list, or a listbox when any row is selectable.
  static $html: Option<HTMLTemplateElement> = html`
    <ol id="root" role="list"></ol>
  `;
}

/** A medallion path in its 12×12 box — the rail's shapes, verbatim. */
function medallion(shape: BranchGraph.Shape): SVGElement {
  switch (shape) {
    case "circle":
      return svg("circle", { cx: 6, cy: 6, r: 4.4 });
    case "square":
      return svg("rect", { x: 2, y: 2, width: 8, height: 8, rx: 1.5 });
    case "hexagon":
      return svg("path", { d: "M6 1 L10.6 3.6 L10.6 8.4 L6 11 L1.4 8.4 L1.4 3.6 Z" });
    case "triangle":
      return svg("path", { d: "M6 1.6 L10.7 10 L1.3 10 Z", "stroke-linejoin": "round" });
    case "diamond":
      return svg("path", { d: "M6 1.2 L10.8 6 L6 10.8 L1.2 6 Z" });
  }
}

/** The rail's state roll-up: one 7px dot per member, filled or hollow, in
 * the member's tone. The hollow ring is inset by its own stroke so both
 * kinds occupy the same optical diameter; a `current` pip gets a ring. */
function $pips(pips: BranchGraph.Pip[]): HTMLElement {
  const $p = document.createElement("div");
  $p.className = "pips";
  for (const pip of pips) {
    const tone = pip.tone ?? "var(--text-ter)";
    const $s = svg("svg", { viewBox: "0 0 12 12", "aria-hidden": "true" });
    const hollow = pip.fill === "hollow";
    $s.appendChild(svg("circle", {
      cx: 6,
      cy: 6,
      r: hollow ? 3.8 : 4.4,
      style: hollow ? `fill: none; stroke: ${tone}; stroke-width: 2` : `fill: ${tone}`,
    }));
    if (pip.current) {
      $s.appendChild(svg("circle", {
        cx: 6,
        cy: 6,
        r: 7.6,
        style: `fill: none; stroke: ${tone}; stroke-width: 1.6`,
      }));
    }
    if (pip.title) {
      const $t = svg("title", {});
      $t.textContent = pip.title;
      $s.appendChild($t);
    }
    $p.appendChild($s);
  }
  return $p;
}

export namespace BranchGraph {
  /** A string gets the graph's own typography; an element is the caller's,
   * slotted so it keeps the caller's stylesheet. */
  export type Content = string | HTMLElement;

  /** The rail's medallion vocabulary. What each shape MEANS is the
   * caller's (commit-review: circle = draft, diamond = landed, square =
   * queued, triangle = planning, hexagon = project). */
  export type Shape = "circle" | "diamond" | "square" | "triangle" | "hexagon";
  export type Fill = "solid" | "hollow";

  export type Mark = {
    shape: Shape;
    fill: Fill;
    /** Any CSS colour. Null: the state's ink — blue when current, secondary
     * when visited, tertiary otherwise. */
    tone: Option<string>;
    /** A dashed outline (hollow only): the rail's `@ unstaged`. */
    dashed?: boolean;
  };

  /** One dot of a container row's roll-up. */
  export type Pip = {
    tone: Option<string>;
    fill: Fill;
    /** The member the reader is on: ringed. */
    current?: boolean;
    /** Tooltip. */
    title?: string;
  };

  export type LineStyle = BranchLayout.LineStyle;
  export type Edge = BranchLayout.Edge;

  export type Lane = {
    /** Shown in the strip where a curve first opens the lane. */
    label?: Option<string>;
    /** Tints the lane's lines and the curves into it. */
    color?: Option<string>;
  };

  /** `step` is an ordinary row; `run` a collapsed run of rows ("⋯ 16
   * commits"); `tail` the end of what is loaded ("older history"). Summary
   * kinds take small tertiary type and the rail's shorter pitch. */
  export type Kind = "step" | "run" | "tail";

  export type Row = {
    /** Identity for edges. Unique within the model. */
    id: string;
    /** Selectable; the id handed back through `onSelect`. Null is inert. */
    key: Option<string>;
    lane: number;
    /** Null draws no mark; the line runs to the row's centre (or through,
     * when an edge also leaves). */
    mark: Option<Mark>;
    title: Content;
    /** Under the title: a caption in the rail, prose in the others. */
    body: Option<Content>;
    /** Trailing content at the row's far end. */
    meta: Option<Content>;
    /** A container's roll-up under its title. */
    pips?: Option<Pip[]>;
    /** A trailing chevron: the row opens and closes (`onToggle`). */
    accessory?: Option<"chevron">;
    /** The chevron's state: rotated, title and pips quietened. */
    expanded?: boolean;
    kind?: Kind;
    /** The row the reader is on. */
    current: boolean;
    /** On the path the reader has walked: the mark takes secondary ink
     * (pair it with `walked` edges for the line). */
    visited: boolean;
    /** Off the path: title quiet (and the mark, outside the rail). */
    muted: boolean;
    /** Not real yet: the mark draws hollow and dashed whatever its fill. */
    proposed: boolean;
    /** Edges to rows further down, by id. */
    next: Edge[];
    /** The lane arrives from above the list. */
    enter?: Option<LineStyle>;
    /** The lane carries on below the list. */
    exit?: Option<LineStyle>;
  };

  /** `rail` is commit-review's rail; `default` a panel list; `compact` a
   * narrow one; `dense` a review pane's one-line rows (the minitree). */
  export type Density = "rail" | "default" | "compact" | "dense";

  export type Model = {
    rows: Row[];
    lanes?: Lane[];
    density?: Density;
    /** The list's accessible name. */
    label?: string;
  };

  /** A row that is only its title, on lane 0, with no edges — spread over it
   * what differs. */
  export function row(
    id: string,
    title: Content,
    mark: Option<Mark> = { shape: "circle", fill: "solid", tone: null },
  ): Row {
    return {
      id,
      key: null,
      lane: 0,
      mark,
      title,
      body: null,
      meta: null,
      current: false,
      visited: false,
      muted: false,
      proposed: false,
      next: [],
    };
  }

  /** Lanes for a DAG — see `BranchLayout.fromDag`. Returns `{ id, lane,
   * next }` per row in display order; merge each into a `Row`. */
  export const fromDag = BranchLayout.fromDag;
  export const route = BranchLayout.route;
}
