import "../../deno-noop.ts";

import { assert, assertEquals } from "jsr:@std/assert";
import { DomFlags } from "../../dom-flags.ts";
import { ScrollHorizontal } from "./scroll-horizontal.ts";
import type { Scrollable } from "@tento-scroll/engine/scrollable.ts";

/**
 * Park marks restyle the column host, not its subtree (dom-perf 33,
 * `scroll-park-host-only`). A column's `[recycled]` / `[pooled]` marks toggle
 * on every recycle and every reattach. A rule keyed on them that sets an
 * INHERITED property (`pointer-events`, `visibility`, a custom property...)
 * changes the computed style of every element in the column, so Blink
 * restyles the whole subtree on each toggle; under column retention the
 * reattached columns carry their full content, and that restyle was the
 * return fling's UpdateLayoutTree (4.5-6.0 ms/frame in W46/W47 against 1.2
 * without retention). Under the flag, what the marks change on a column that
 * shows no placeholder must be non-inherited only; `pointer-events: inherit`
 * is the unmarked column's own value, so it changes nothing.
 *
 * The cascade cases read the component source: the stylesheet is inert under
 * deno, and the property under test is which declarations the stylesheet
 * makes. The flag cases run the real readers and the real `initialize`.
 */
const source = await Deno.readTextFile(new URL("./scroll-horizontal.ts", import.meta.url));

/** CSS properties that inherit (the ones a column's content could carry). */
const INHERITED = new Set([
  "pointer-events", "visibility", "color", "cursor", "direction", "font", "font-family", "font-size",
  "font-style", "font-weight", "letter-spacing", "line-height", "text-align", "text-indent", "text-transform",
  "white-space", "word-spacing", "writing-mode", "user-select", "-webkit-user-select", "list-style", "quotes",
  "caret-color", "color-scheme", "tab-size", "hyphens", "word-break", "overflow-wrap", "text-shadow",
]);

type Rule = { selectors: string[]; declarations: [string, string][] };

/** The rules of the component's css templates (comments removed). */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const block of source.matchAll(/css`([\s\S]*?)`/g)) {
    const text = block[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({
        selectors: rule[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0),
        declarations: rule[2].split(";").map((d) => d.trim()).filter((d) => d.includes(":"))
          .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
      });
    }
  }
  return out;
}

/**
 * What a marked body column (`marks`, no placeholder, no other state) gets
 * beyond an unmarked one, on a host carrying `hostAttrs`: the rules that
 * select a mark, ungated ones first, host-gated ones after (they are more
 * specific), later ones over earlier ones.
 */
function markedDeclarations(marks: string[], hostAttrs: string[]): Map<string, string> {
  const applies = (selector: string): 0 | 1 | 2 => {
    const m = selector.match(/^(?::host\(\[([a-z-]+)\]\)\s+)?slot\[name="body"\]::slotted\(((?:\[[a-z-]+\])+)\)$/);
    if (m == null) return 0;
    const wanted = [...m[2].matchAll(/\[([a-z-]+)\]/g)].map((a) => a[1]);
    if (!wanted.every((a) => marks.includes(a))) return 0;
    if (m[1] == null) return 1;
    return hostAttrs.includes(m[1]) ? 2 : 0;
  };
  const effective = new Map<string, string>();
  for (const tier of [1, 2]) {
    for (const rule of rules()) {
      if (!rule.selectors.some((s) => applies(s) === tier)) continue;
      for (const [property, value] of rule.declarations) effective.set(property, value);
    }
  }
  return effective;
}

function inheritedChanges(declared: Map<string, string>): string[] {
  return [...declared].filter(([p, v]) => (INHERITED.has(p) || p.startsWith("--")) && v !== "inherit")
    .map(([p, v]) => `${p}: ${v}`);
}

Deno.test("park marks: under scroll-park-host-only a recycled or parked column changes no inherited property", () => {
  const host = ["park-host-only"];
  for (const marks of [["recycled"], ["pooled"], ["recycled", "pooled"]]) {
    const declared = markedDeclarations(marks, host);
    assert(declared.size > 0, `no rule selects ${marks.join("+")}`);
    assertEquals(inheritedChanges(declared), [], `[${marks.join("][")}] restyles the subtree`);
  }
  const recycled = markedDeclarations(["recycled"], host);
  assertEquals(recycled.get("opacity"), "0", "still invisible");
  assertEquals(recycled.get("clip-path"), "inset(100%)", "and out of hit-testing");
});

Deno.test("park marks: without the flag the recycled mark keeps pointer-events: none (the default is unchanged)", () => {
  assertEquals(inheritedChanges(markedDeclarations(["recycled"], [])), ["pointer-events: none"]);
});

Deno.test("park marks: a recycled column showing a placeholder stays visible and non-interactive under the flag", () => {
  const declared = markedDeclarations(["recycled", "column-placeholder"], ["park-host-only"]);
  assertEquals([declared.get("opacity"), declared.get("clip-path"), declared.get("pointer-events")], ["1", "none", "none"]);
});

/** A fake that sets only what `initialize` reaches (the rest is never read on this path). */
function fake<T>(fields: object): T {
  return fields as T;
}

/** The scroller `initialize` hands its engine: position only, no DOM. */
class Scroller implements Scrollable {
  contentOffset = 0;
  baseOffset = 0;
  delegate: Option<Scrollable.Delegate> = null;
  scrollTo(offset: number): void {
    this.contentOffset = offset;
  }
  adjustContentOffset(delta: number): void {
    this.contentOffset += delta;
  }
  positionAt(): null {
    return null;
  }
}

const PARK_FLAGS = [ScrollHorizontal.COLUMN_RETENTION, ScrollHorizontal.PARK_HOST_ONLY];

/** The attributes the real `initialize` sets on a host, with `armed` flags overridden (the others at their defaults). */
function initializedHostAttributes(armed: Record<string, boolean>): string[] {
  for (const flag of PARK_FLAGS) DomFlags.armForHarness(flag, armed[flag] ?? null);
  try {
    const attributes = new Set<string>();
    const host: ScrollHorizontal<HTMLElement, HTMLElement> = Object.create(ScrollHorizontal.prototype);
    Object.defineProperty(host, "$scrollable", { value: new Scroller() });
    Object.defineProperty(host, "style", { value: { setProperty: () => {} } });
    Object.defineProperty(host, "$", { value: () => ({ addEventListener: () => {} }) });
    Object.defineProperty(host, "toggleAttribute", {
      value: (name: string, force?: boolean) => {
        if (force ?? !attributes.has(name)) attributes.add(name);
        else attributes.delete(name);
        return attributes.has(name);
      },
    });
    host.initialize(fake<ScrollHorizontal.Delegate<HTMLElement, HTMLElement>>({ onCreate: () => ({}), onBind: () => {} }));
    return [...attributes].sort();
  } finally {
    for (const flag of PARK_FLAGS) DomFlags.armForHarness(flag, null);
  }
}

Deno.test("park flags: the flipped set is the default (dom-perf 49): 20 retained spares, host-only marks", () => {
  assertEquals(
    [ScrollHorizontal.columnRetention(), ScrollHorizontal.parkHostOnly()],
    [20, true],
    "no flag set: retention with K = 20, host-only park marks",
  );
  assertEquals(initializedHostAttributes({}), ["park-host-only"], "the default host carries the host-only mark");
});

Deno.test("park flags: parked spares stay rendered: no host mark or rule skips their rendering (content-visibility park retired)", () => {
  assertEquals(Reflect.get(ScrollHorizontal, "parkContentVisibility"), undefined, "no content-visibility park reader");
  assert(!/content-visibility\s*:/.test(source), "no rule sets content-visibility");
  assert(!source.includes("[column-retention]"), "no rule keys on a column-retention host mark");
});

Deno.test("park flags: initialize marks the host with what the flags select", () => {
  const { COLUMN_RETENTION: retention, PARK_HOST_ONLY: hostOnly } = ScrollHorizontal;
  const off = { [retention]: false, [hostOnly]: false };
  assertEquals(initializedHostAttributes(off), [], "everything off: no mark (the pre-flip default)");
  assertEquals(initializedHostAttributes({ ...off, [retention]: true }), [], "retention alone marks nothing");
  assertEquals(initializedHostAttributes({ ...off, [hostOnly]: true }), ["park-host-only"]);
  assertEquals(initializedHostAttributes({ ...off, [retention]: true, [hostOnly]: true }), ["park-host-only"], "the flipped set");
});
