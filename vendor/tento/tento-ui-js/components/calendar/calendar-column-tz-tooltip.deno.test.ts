/**
 * The zone tooltip of a zone-split day is one rounded surface. A day column
 * split by a zone change (a DST day, or a flight in the personal-timezone
 * view) shows, past its rounded partial edge, a tab naming the fragment's
 * zone: std-calendar-column's #tzabbr-top / #tzabbr-bottom
 * (toggleTzAbbrTooltipAction). Operator 2026-10-09: "the tz tooltip is close
 * but there's a rectangular background that clashes with the round one".
 *
 * Under Deno `css` and `html` yield nothing, so this reads the component's
 * own style sheet and template as text (`CalendarColumn.SHADOW_CSS`,
 * `SHADOW_HTML`) and models what paints beyond the partial
 * edge, where the tooltip sits: an element paints when it is shown (opacity
 * and display) and has a background or an outer box-shadow; it paints beyond
 * the edge when it is placed past it (a negative top / bottom) or its shadow
 * reaches past it (offset, spread and blur against its distance from the
 * edge). Beyond the edge exactly one element may paint, the tooltip, and it
 * carries the radius: the same single surface std-tooltip's #bubble is. The
 * browser spec calendar/tz-tooltip-single-surface judges the computed paint
 * on dev.
 *
 * Operator 2026-10-10: "the tz tooltip issue is worse. we should have the
 * shadow. the problem is that there's a white square behind it". The shadow
 * belongs to the one surface: the tooltip casts its own drop shadow, away from
 * the column, and nothing else in the column (host included) paints a
 * background, a shadow or a filter there. The white square was the sheet's
 * skeleton span, square behind the column's rounded partial edge; it now rounds
 * at the same `PARTIAL_EDGE_RADIUS_PX` (calendar-column-skeleton.deno.test.ts).
 * The browser spec calendar/tz-tooltip-shadow-no-backdrop judges both on dev.
 */
import "../../deno-noop.ts";

import { assert, assertEquals } from "jsr:@std/assert";
import { CalendarColumn, PARTIAL_EDGE_RADIUS_PX } from "./calendar-column.ts";

type Edge = "top" | "bottom";
type Decls = Map<string, string>;
type Node = { readonly id: string; readonly ancestors: readonly string[] };

const EDGES: readonly Edge[] = ["top", "bottom"];

/** The component's own rules, in order: selector -> declarations. */
function rules(): { readonly selector: string; readonly decls: Decls }[] {
  const sheet = CalendarColumn.SHADOW_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; decls: Decls }[] = [];
  for (const m of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls: Decls = new Map();
    for (const d of m[2].split(";")) {
      const at = d.indexOf(":");
      if (at > 0) decls.set(d.slice(0, at).trim(), d.slice(at + 1).trim());
    }
    for (const selector of m[1].split(",")) out.push({ selector: selector.trim(), decls });
  }
  return out;
}

/** The shadow template's elements that carry an id, with their ancestors' ids. */
function template(): Node[] {
  const markup = CalendarColumn.SHADOW_HTML;
  const stack: string[] = [];
  const out: Node[] = [];
  for (const m of markup.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/g)) {
    if (m[1]) {
      stack.pop();
      continue;
    }
    const id = /\bid=(?:"([^"]+)"|([^\s>]+))/.exec(m[3]);
    const name = id ? (id[1] ?? id[2]) : "";
    if (name) out.push({ id: name, ancestors: stack.filter(Boolean) });
    stack.push(name);
  }
  return out;
}

/** The declarations that apply to `#id` while the host carries `partial-<edge>`. */
function style(id: string, edge: Edge): Decls {
  const own = new Set([`#${id}`, `:host([partial-${edge}]) #${id}`]);
  const out: Decls = new Map();
  for (const rule of rules()) {
    if (!own.has(rule.selector)) continue;
    for (const [k, v] of rule.decls) out.set(k, v);
  }
  return out;
}

const px = (v: string | undefined): number => parseFloat(v ?? "") || 0;
const NONE = new Set([undefined, "", "none", "transparent"]);

function background(s: Decls): boolean {
  return !NONE.has(s.get("background")) || !NONE.has(s.get("background-color"));
}

/** Outer box-shadow lengths: x, y, blur, spread (a unitless 0 counts). */
function shadow(s: Decls): readonly number[] | null {
  const v = s.get("box-shadow");
  if (NONE.has(v) || /\binset\b/.test(v!)) return null;
  const lengths = v!.replace(/(rgba?|hsla?|color-mix|var)\([^)]*\)/g, " ");
  return (lengths.match(/(?<![\w.-])-?[\d.]+(px)?(?![\w%])/g) ?? []).map(parseFloat);
}

function filtered(s: Decls): boolean {
  return !NONE.has(s.get("filter")) || !NONE.has(s.get("backdrop-filter"));
}

/** The declarations the host itself takes while it carries `partial-<edge>`. */
function hostStyle(edge: Edge): Decls {
  const own = new Set([":host", `:host([partial-${edge}])`]);
  const out: Decls = new Map();
  for (const rule of rules()) {
    if (!own.has(rule.selector)) continue;
    for (const [k, v] of rule.decls) out.set(k, v);
  }
  return out;
}

function shown(s: Decls): boolean {
  return s.get("opacity") !== "0" && s.get("display") !== "none";
}

/** True when `#id` paints past the column's `edge` while it is partial there. */
function paintsBeyond(id: string, edge: Edge): boolean {
  const s = style(id, edge);
  if (!shown(s)) return false;
  const placed = s.get("position") === "absolute" ? px(s.get(edge) ?? s.get("inset")) : 0;
  if (background(s) && placed < 0) return true;
  const sh = shadow(s);
  if (sh == null) return false;
  const [, y = 0, blur = 0, spread = 0] = sh;
  const outward = (edge === "top" ? -y : y) + spread + blur;
  return outward > placed;
}

function cornerRadii(s: Decls, edge: Edge): number[] {
  const all = s.get("border-radius");
  return ["left", "right"].map((side) => {
    const own = s.get(`border-${edge}-${side}-radius`);
    return own != null ? px(own) : px(all);
  });
}

Deno.test("zone tooltip: the template and sheet still hold the tooltips this models", () => {
  const ids = template().map((n) => n.id);
  for (const id of ["root", "tzabbr-top", "tzabbr-bottom", "tzabbr-top-label", "tzabbr-bottom-label"]) {
    assert(ids.includes(id), `#${id} is gone from the template`);
  }
  for (const edge of EDGES) {
    const s = style(`tzabbr-${edge}`, edge);
    assert(shown(s) && background(s), `the ${edge} tooltip is shown with a background while partial-${edge}`);
    assert(!shown(style(`tzabbr-${edge === "top" ? "bottom" : "top"}`, edge)), "the other edge's tooltip stays hidden");
  }
});

for (const edge of EDGES) {
  Deno.test(`zone tooltip: past a partial-${edge} edge only the tooltip paints`, () => {
    const beyond = template().map((n) => n.id).filter((id) => paintsBeyond(id, edge));
    assertEquals(beyond, [`tzabbr-${edge}`], "a second surface behind or around the tooltip");
  });

  Deno.test(`zone tooltip: the partial-${edge} tooltip is one rounded surface`, () => {
    const id = `tzabbr-${edge}`;
    const s = style(id, edge);
    for (const r of cornerRadii(s, edge)) assert(r >= 3, `#${id}'s outer corners are round (${r}px)`);
    const inside = template().filter((n) => n.ancestors.includes(id)).map((n) => n.id);
    assert(inside.length > 0, `#${id} holds its label`);
    for (const child of inside) {
      const c = style(child, edge);
      assert(!background(c) && shadow(c) == null, `#${child} paints inside the tooltip: two surfaces`);
    }
  });
}

for (const edge of EDGES) {
  Deno.test(`zone tooltip: the partial-${edge} tooltip casts the one drop shadow, away from the column`, () => {
    const id = `tzabbr-${edge}`;
    const sh = shadow(style(id, edge));
    assert(sh != null, `#${id} has no drop shadow`);
    const [x = 0, y = 0, blur = 0, spread = 0] = sh;
    assert(edge === "top" ? y < 0 : y > 0, `#${id}'s shadow falls toward the column (y ${y}px), under #root`);
    const sideways = Math.abs(x) + blur + spread;
    assert(sideways <= 2, `#${id}'s shadow reaches ${sideways}px past its sides: a band, not a drop shadow`);
    for (const n of template()) {
      if (n.id === id) continue;
      const s = style(n.id, edge);
      assert(shadow(s) == null, `#${n.id} casts a second shadow: ${s.get("box-shadow")}`);
      assert(!filtered(s), `#${n.id} filters what is behind the tooltip`);
    }
  });

  Deno.test(`zone tooltip: the host paints nothing behind the partial-${edge} tooltip`, () => {
    const s = hostStyle(edge);
    assert(!background(s), `the host paints ${s.get("background") ?? s.get("background-color")}`);
    assert(shadow(s) == null, `the host casts ${s.get("box-shadow")}`);
    assert(!filtered(s), "the host carries a filter");
  });
}

Deno.test("zone tooltip: the partial edge rounds at PARTIAL_EDGE_RADIUS_PX, the radius the skeleton reads", () => {
  for (const edge of EDGES) {
    for (const r of cornerRadii(style("root", edge), edge)) assertEquals(r, PARTIAL_EDGE_RADIUS_PX);
  }
});
