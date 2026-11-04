import "../../deno-noop.ts";

import { assert, assertEquals } from "jsr:@std/assert";
import { Tracing } from "@tento-core/tracing";
import { $$ } from "../../fastdom.ts";
import { ScrollHorizontal } from "./scroll-horizontal.ts";
import { BindGeneration, ScrollEngine } from "@tento-scroll/engine/scroll-engine.ts";
import type { Scrollable } from "@tento-scroll/engine/scrollable.ts";

class Clock {
  readonly reads: (() => void)[] = [];
  readonly writes: (() => void)[] = [];
  readonly timers = new Map<number, () => void>();
  private next = 0;
  private readonly measure = $$.measure;
  private readonly mutateEnd = $$.mutateEnd;
  private readonly timeout = globalThis.setTimeout;
  private readonly clear = globalThis.clearTimeout;
  private readonly width = Object.getOwnPropertyDescriptor(window, "innerWidth");
  private readonly cookie = Object.getOwnPropertyDescriptor(document, "cookie");

  constructor() {
    $$.measure = (fn) => { this.reads.push(fn); return fn; };
    $$.mutateEnd = (fn) => { this.writes.push(fn); return fn; };
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true,
      value: (callback: () => void, _delay: number) => {
        const id = ++this.next; this.timers.set(id, callback); return id;
      } });
    globalThis.clearTimeout = (id) => { if (id != null) this.timers.delete(id); };
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(document, "cookie", { configurable: true, value: "" });
  }

  restore(): void {
    $$.measure = this.measure;
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

/** Actual scheduling, DOM inspection, persistence classification and heal
 * dispatch run on the production prototype. The fixture supplies just one
 * measured marked header, rather than pretending to hydrate a browser sheet. */
class Harness {
  readonly host: ScrollHorizontal<HTMLElement, HTMLElement> = Object.create(ScrollHorizontal.prototype);
  readonly header: HTMLElement = Object.create(HTMLElement.prototype);
  readonly attrs = new Map<string, string>([["cid", "test"], ["pending-layout", ""]]);
  readonly heals: number[] = [];
  readonly logs: { label: string; data: Parameters<typeof Tracing.log>[1] }[] = [];
  private readonly log = Tracing.log;

  constructor() {
    Object.defineProperties(this.header, {
      children: { value: [] },
      style: { value: { display: "", getPropertyValue: () => "-1" } },
    });
    this.header.hasAttribute = (name) => this.attrs.has(name);
    this.header.getAttribute = (name) => this.attrs.get(name) ?? null;
    this.header.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20,
      toJSON: () => ({}),
    });
    Object.defineProperties(this.host, {
      children: { value: [] }, dataset: { value: {} },
    });
    this.host["headerSweepScheduled"] = false;
    this.host["headerSweepEpoch"] = 0;
    this.host["headerSweepTrailingTimer"] = null;
    this.host["prevHeaderViolations"] = new Set();
    this.host["lastPendingLayoutMarkMs"] = performance.now();
    this.host["headerHealAttemptedGen"] = -1;
    this.host._scrollEngine = new ScrollEngine(new Scroller(), {
      onCreate: () => ({ $header: this.header, $body: this.header }),
      onBind: () => {}, onRecycle: () => {},
    });
    this.host.scrollEngine.setBindGeneration(BindGeneration.of(3));
    this.host.scrollEngine.entries._all.set(-1, { $header: this.header, $body: this.header });
    this.host.scrollEngine.emit.index = (index) => { this.heals.push(index); };
    Tracing.log = (label, data) => { this.logs.push({ label, data }); };
  }

  sweep(context: string): void { this.host["sweepHeaderInvariants"](context); }
  queue(index: number): void {
    this.host.scrollEngine["bindBatcher"].enqueue(
      index, { $header: this.header, $body: this.header }, false,
      this.host.scrollEngine.currentBindGeneration,
    );
  }
  schedule(context: string): void { this.host["scheduleHeaderInvariantSweep"](context); }
  violations(): number { return this.logs.filter((l) => l.label === "scroll/header-violation").length; }
  restore(): void { this.host["resetHeaderSweeps"](); Tracing.log = this.log; }
}

Deno.test("header-sweep ownership: old marks with a queued bind are debt, not a persistent strand", () => {
  const clock = new Clock(), h = new Harness();
  try {
    h.host["lastPendingLayoutMarkMs"] = performance.now() - 10000;
    h.queue(-1);
    h.sweep("trailing");
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 0);
    assertEquals(h.heals, []);
    // The sighting is recorded and HELD (scroll-horizontal.ts `bindComing`),
    // not skipped: the history is what lets a mark that outlives its bind
    // escalate on the very next sweep, and what the held-barrier excuse ages.
    assertEquals(h.host["prevHeaderViolations"].size, 1);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header-sweep ownership: unrelated queued work does not hide a real header strand", () => {
  const clock = new Clock(), h = new Harness();
  try {
    h.host["lastPendingLayoutMarkMs"] = performance.now() - 10000;
    h.queue(8);
    h.sweep("trailing");
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 1);
    assertEquals(h.heals, [-1]);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header-sweep ownership: a header still marked after its queued bind retires is reported", () => {
  const clock = new Clock(), h = new Harness();
  try {
    h.queue(-1);
    h.sweep("trailing");
    assertEquals(h.violations(), 0, "a queued live bind holds the sighting");
    h.host.scrollEngine["bindBatcher"].drain(() => null);
    // The held sighting was the first strike: once the bind has landed and the
    // mark is still there, the next sweep is the second, and it escalates.
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 1);
    assertEquals(h.heals, [-1]);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header-sweep ownership: old exhausted measure cannot inherit a strike or clear successor scheduling", () => {
  const clock = new Clock(), h = new Harness();
  try {
    h.sweep("batch-complete");
    assertEquals(h.violations(), 0);
    h.schedule("settled-fallback-exhausted");
    clock.writes.shift()?.();
    const obsoleteMeasure = clock.reads.shift();
    const obsoleteTimer = [...clock.timers.values()][0];
    assert(obsoleteMeasure && obsoleteTimer);

    h.host.setBindGeneration(BindGeneration.of(4));
    const successorTimer = h.host["headerSweepTrailingTimer"];
    obsoleteMeasure();
    obsoleteTimer();
    assertEquals(h.violations(), 0);
    assertEquals(h.heals, []);
    assertEquals(h.host["headerSweepScheduled"], true);
    assertEquals(h.host["headerSweepTrailingTimer"], successorTimer);

    clock.writes.shift()?.();
    clock.reads.shift()?.();
    assertEquals(h.violations(), 0, "generation4 first observation is not generation3 second strike");
    h.host.setBindGeneration(BindGeneration.of(4));
    h.host.setBindGeneration(BindGeneration.of(2));
    assertEquals(h.host.scrollEngine.currentBindGeneration, BindGeneration.of(4));
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 1, "same-generation persistence must still emit the forbidden verdict");
    const verdict = h.logs.find((l) => l.label === "scroll/header-violation");
    assertEquals(verdict?.data, { kind: "pending-layout", indices: [-1], gen: 4, ctx: "trailing-confirm" });
    assertEquals(h.heals, [-1]);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header-sweep ownership: first-strike history cannot cross even a direct engine generation advance", () => {
  const clock = new Clock(), h = new Harness();
  try {
    h.sweep("batch-complete");
    h.host.scrollEngine.setBindGeneration(BindGeneration.of(4));
    h.sweep("settled-drain");
    assertEquals(h.violations(), 0);
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 1);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header-sweep ownership: healthy successor clears suspicion and retired callbacks remain inert", () => {
  const clock = new Clock(), h = new Harness();
  try {
    h.sweep("batch-complete");
    h.host.setBindGeneration(BindGeneration.of(4));
    clock.writes.shift()?.(); clock.reads.shift()?.();
    h.attrs.delete("pending-layout");
    h.sweep("settled-drain");
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 0);
    h.schedule("settled-fallback-exhausted");
    clock.writes.shift()?.();
    const measure = clock.reads.shift();
    const timers = [...clock.timers.values()];
    h.host["resetHeaderSweeps"]();
    const before = h.logs.length;
    measure?.(); for (const timer of timers) timer();
    assertEquals(h.logs.length, before);
    assertEquals(clock.timers.size, 0);
    assertEquals(h.host["headerSweepScheduled"], false);
  } finally { h.restore(); clock.restore(); }
});
