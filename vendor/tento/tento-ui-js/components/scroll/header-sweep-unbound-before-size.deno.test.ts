import "../../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { Tracing } from "@tento-core/tracing";
import { $$ } from "../../fastdom.ts";
import { ScrollHorizontal } from "./scroll-horizontal.ts";
import { SizeGate } from "../../ui/size-gate.ts";
import { BindGeneration, ScrollEngine } from "@tento-scroll/engine/scroll-engine";
import type { Scrollable } from "@tento-scroll/engine/scrollable";

/**
 * ux corpus, frame-starved hidden page: the sheet's page was 0x0 when it
 * bound, so `ScrollHorizontal`'s size gate stayed shut. `bindIndex` recorded
 * the collection only AFTER that gate, but the engine drained the columns'
 * binds meanwhile (`bindLayout` → layout-changed), and every one of them ran
 * `BoundCollection.set($c, undefined)` — which REMOVED the `cid`. The columns
 * were painted (rid cells present) yet read `unbound` to the header sweep,
 * which escalated `scroll/header-violation kind=unbound` + `Tracing.err
 * scroll/header-invariant … unbound=N` once the mark was 3 s old, while
 * `assertChildren` (null against null) saw nothing and the heal re-bound with
 * the same missing id.
 *
 * These tests pin the order (the collection is recorded at `bindIndex`, before
 * the gate), that a bind never strips a marker, that the sweep only counts
 * `unbound` once the host has a collection, and that it still escalates a
 * column that genuinely lost its `cid` with no bind coming.
 */

class Clock {
  private next = 0;
  readonly timers = new Map<number, () => void>();
  private readonly measure = $$.measure;
  private readonly mutate = $$.mutate;
  private readonly mutateEnd = $$.mutateEnd;
  private readonly timeout = globalThis.setTimeout;
  private readonly clear = globalThis.clearTimeout;
  private readonly width = Object.getOwnPropertyDescriptor(window, "innerWidth");
  private readonly cookie = Object.getOwnPropertyDescriptor(document, "cookie");

  constructor() {
    // The test IS the frame clock: nothing scheduled here ever runs.
    $$.measure = (fn) => fn;
    $$.mutate = (fn) => fn;
    $$.mutateEnd = (fn) => fn;
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true,
      value: (callback: () => void, _delay: number) => {
        const id = ++this.next; this.timers.set(id, callback); return id;
      } });
    globalThis.clearTimeout = (id) => { if (id != null) this.timers.delete(id); };
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(document, "cookie", { configurable: true, value: "" });
  }

  restore(): void {
    $$.measure = this.measure;
    $$.mutate = this.mutate;
    $$.mutateEnd = this.mutateEnd;
    globalThis.setTimeout = this.timeout;
    globalThis.clearTimeout = this.clear;
    if (this.width) Object.defineProperty(window, "innerWidth", this.width);
    else Reflect.deleteProperty(window, "innerWidth");
    if (this.cookie) Object.defineProperty(document, "cookie", this.cookie);
    else Reflect.deleteProperty(document, "cookie");
  }
}

class Scroller implements Scrollable {
  contentOffset = 0;
  delegate: Option<Scrollable.Delegate> = null;
  scrollTo(offset: number): void { this.contentOffset = offset; }
  adjustContentOffset(delta: number): void { this.contentOffset += delta; }
}

/** A painted column element, inside the window, with a real attribute map. */
function column(): { $e: HTMLElement; attrs: Map<string, string> } {
  const $e: HTMLElement = Object.create(HTMLElement.prototype);
  const attrs = new Map<string, string>();
  Object.defineProperties($e, {
    children: { value: [] },
    style: { value: { display: "", getPropertyValue: () => "0" } },
  });
  $e.hasAttribute = (name) => attrs.has(name);
  $e.getAttribute = (name) => attrs.get(name) ?? null;
  $e.setAttribute = (name, value) => { attrs.set(name, value); };
  $e.removeAttribute = (name) => { attrs.delete(name); };
  $e.toggleAttribute = (name, force) => {
    const on = force ?? !attrs.has(name);
    if (on) attrs.set(name, ""); else attrs.delete(name);
    return on;
  };
  $e.assignStyles = function <T extends HTMLElement>(this: T): T { return this; };
  $e.getBoundingClientRect = () => ({
    x: 250, y: 0, width: 254, height: 0, left: 250, top: 0, right: 504, bottom: 0,
    toJSON: () => ({}),
  });
  return { $e, attrs };
}

type Column = { $header: HTMLElement; $body: HTMLElement };

/** One tracked column at index 0 on the production sweep, bound through the
 * component's REAL engine delegate (`bindColumnComponent`), with a size gate
 * that stays shut until the test opens it. */
class Harness {
  readonly host: ScrollHorizontal<HTMLElement, HTMLElement> = Object.create(ScrollHorizontal.prototype);
  readonly header = column();
  readonly body = column();
  readonly column: Column = { $header: this.header.$e, $body: this.body.$e };
  readonly gate = new SizeGate();
  readonly delegate: ScrollEngine.Delegate<Column>;
  readonly heals: number[] = [];
  readonly engineBinds: string[] = [];
  binds = 0;
  readonly logs: { label: string; data: Parameters<typeof Tracing.log>[1] }[] = [];
  private readonly log = Tracing.log;

  constructor(markAgeMs: number) {
    Object.defineProperties(this.host, {
      children: { value: [] }, dataset: { value: {} },
    });
    this.host["sizeGate"] = this.gate;
    this.host["healAttempted"] = new Set();
    this.host["headerSweepScheduled"] = false;
    this.host["headerSweepEpoch"] = 0;
    this.host["headerSweepTrailingTimer"] = null;
    this.host["prevHeaderViolations"] = new Set();
    this.host["lastPendingLayoutMarkMs"] = performance.now() - markAgeMs;
    this.host["headerHealAttemptedGen"] = -1;
    this.delegate = this.host["scrollEngineDelegate"]({
      onCreate: () => this.column,
      onBind: () => { this.binds++; },
    });
    this.host._scrollEngine = new ScrollEngine(new Scroller(), this.delegate);
    this.engine.setBindGeneration(BindGeneration.of(2));
    this.engine.entries._all.set(0, this.column);
    this.engine.emit.index = (index) => { this.heals.push(index); };
    // The gated tail of `bindIndex` reaches the engine only once the size
    // arrives; record it rather than drive a viewport this harness lacks.
    this.engine.bindIndex = (index, bind) => {
      this.engineBinds.push(`${index}:${bind.kind}`);
      return { reanchored: false, moved: false, emitted: false };
    };
    Tracing.log = (label, data) => { this.logs.push({ label, data }); };
  }

  /** Put the host in a document with a measurable viewport, and route the
   * size notification to the gate (the constructor-installed `onSizeChange`
   * does not exist on a prototype-built host). Returns the sizes delivered. */
  connect(width: number, height: number): { width: number; height: number }[] {
    const delivered: { width: number; height: number }[] = [];
    Object.defineProperty(this.host, "isConnected", { value: true });
    this.host["$contentViewport"] = Object.assign(Object.create(HTMLElement.prototype), {
      offsetWidth: width, offsetHeight: height,
    });
    this.host.onSizeChange = (size) => { delivered.push(size); this.gate.resolve(size); };
    return delivered;
  }
  get engine(): ScrollEngine<Column> { return this.host.scrollEngine; }
  /** Queue a live-generation bind for index 0 the way `queueOnBind` does. */
  queue(): void {
    this.engine["bindBatcher"].enqueue(0, this.column, false, BindGeneration.of(2));
  }
  /** The engine's drain: empty the queue and run the component's `onBind`. */
  drain(): void {
    const instructions = this.engine["bindBatcher"].drain(
      (index) => this.engine.entries._all.get(index) ?? null,
    );
    for (const { t, index } of instructions) {
      this.delegate.onBind(t, index, 250, 254, false, false);
    }
  }
  sweep(context: string): void { this.host["sweepHeaderInvariants"](context); }
  violations(kind?: string): number {
    return this.logs.filter((l) =>
      l.label === "scroll/header-violation" &&
      (kind == null || (l.data as { kind?: string } | undefined)?.kind === kind)
    ).length;
  }
  restore(): void { this.host["resetHeaderSweeps"](); Tracing.log = this.log; }
}

Deno.test("header sweep: columns bound while the size gate is shut carry the bindIndex collection, no unbound escalation", () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    // Hidden page: the gate never opens. The bind is issued anyway…
    void h.host.bindIndex(0, "abcdef-collection", false, true);
    // …and the engine drains the layout-changed binds regardless.
    h.queue();
    h.drain();
    assertEquals(h.binds, 1);
    assertEquals(h.engineBinds, [], "the engine half of bindIndex still waits for the size");
    h.sweep("trailing");
    h.sweep("trailing-confirm"); // mark 4.4 s old: past the grace
    assertEquals(h.violations("unbound"), 0, "a painted, bound column is not unbound");
    assertEquals(h.violations(), 0);
    assertEquals(h.heals, []);
    assertEquals(h.header.attrs.get("cid"), "abcd", "the drained bind stamps the collection named at bindIndex");
    assertEquals(h.body.attrs.get("cid"), "abcd");
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header sweep: when the size arrives late the columns already hold their cid — no re-bind", async () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    const bound = h.host.bindIndex(0, "abcdef-collection", false, true);
    h.queue();
    h.drain();
    assertEquals(h.header.attrs.get("cid"), "abcd");
    h.gate.resolve({ width: 1280, height: 800 });
    await bound;
    assertEquals(h.engineBinds, ["0:reanchor"]);
    assertEquals(h.binds, 1, "no column re-bind was needed to repair the marker");
    assertEquals(h.header.attrs.get("cid"), "abcd");
    h.sweep("trailing");
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 0);
    assertEquals(h.heals, []);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header sweep: a bind that runs before the host knows its collection strips nothing and is not unbound", () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    h.header.attrs.set("cid", "prev");
    h.queue();
    h.drain(); // no bindIndex yet: `collectionId` is unset
    assertEquals(h.header.attrs.get("cid"), "prev", "a bind with no id must not remove the marker");
    h.header.attrs.delete("cid");
    h.sweep("trailing");
    h.sweep("trailing-confirm");
    assertEquals(h.violations("unbound"), 0, "no collection yet: a missing cid is expected, not a strand");
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header sweep: a column that lost its cid with no bind coming still escalates unbound", () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    void h.host.bindIndex(0, "abcdef-collection", false, true);
    h.queue();
    h.drain();
    h.header.attrs.delete("cid"); // a recycle cleared it; the rebind was lost
    h.sweep("trailing");
    h.sweep("trailing-confirm");
    assertEquals(h.violations("unbound"), 1);
    assertEquals(h.heals, [0]);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header sweep: an unbound column whose live bind is queued is held, then clears when it lands", () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    void h.host.bindIndex(0, "abcdef-collection", false, true);
    h.queue();
    h.sweep("trailing");
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 0, "the queued bind is the cid's pending stamp");
    assertEquals(h.heals, []);
    h.drain();
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 0);
    assertEquals(h.header.attrs.get("cid"), "abcd");
  } finally { h.restore(); clock.restore(); }
});

Deno.test("size gate: bindIndex seeds the size from a measurement when no ResizeObserver delivery came", async () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    const delivered = h.connect(1280, 800);
    await h.host.bindIndex(0, "abcdef-collection", false, true);
    assertEquals(delivered, [{ width: 1280, height: 800 }]);
    assertEquals(h.engineBinds, ["0:reanchor"]);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("size gate: a connected 0x0 viewport (display:none) is not a size — the gate stays shut", async () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    const delivered = h.connect(1280, 0);
    void h.host.bindIndex(0, "abcdef-collection", false, true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assertEquals(delivered, []);
    assertEquals(h.engineBinds, []);
    assertEquals(h.host["collectionId"], "abcd", "the collection is recorded regardless");
  } finally { h.restore(); clock.restore(); }
});
