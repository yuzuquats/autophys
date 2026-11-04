import "../../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { Tracing } from "@tento-core/tracing";
import { $$ } from "../../fastdom.ts";
import { ScrollHorizontal } from "./scroll-horizontal.ts";
import { BindGeneration, ScrollEngine } from "@tento-scroll/engine/scroll-engine";
import type { Scrollable } from "@tento-scroll/engine/scrollable";

/**
 * ux corpus lona/onboarding/returning-active-user, rc candidate c40
 * (2026-09-26): after the switch to `:daily-habits` the mark pass hid nine
 * columns (`scroll/pending-layout/mark gen=2`) and the engine queued their
 * binds. The tab was frame-throttled (~1 frame/s), so the budgeted drain
 * bound the visible range [0,7] first and reached the two leading overscan
 * columns -2/-1 (left of that range) last — 5.4 s after the mark. The
 * `trailing-confirm` sweep ran at 4.4 s: marks past the 3 s grace, queue not
 * idle, second sighting, so it escalated `scroll/header-violation
 * kind=pending-layout indices=[-2,-1]` while both binds were still queued and
 * landed on the next two frames. c39 logged the identical first sighting
 * (`ctx=trailing persistent=2`) and escaped only because its drain finished
 * 2.1 s after its mark.
 *
 * A `pending-layout` / `recycled` mark is cleared by ANY completed bind (the
 * `onBind` finally / `bindColumnComponent`). A tracked column whose bind is
 * queued at the live generation is therefore not a strand: that bind is the
 * promise the mark is waiting on. These tests pin the sweep to that, and pin
 * that the tripwire still fires when no bind is coming.
 */

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
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
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

type Column = { $header: HTMLElement; $body: HTMLElement };

/** One marked header column, measured inside the window (the c40 geometry of
 * index -1: left 250, width 254), on the production sweep. */
class Harness {
  readonly host: ScrollHorizontal<HTMLElement, HTMLElement> = Object.create(ScrollHorizontal.prototype);
  readonly header: HTMLElement = Object.create(HTMLElement.prototype);
  readonly column: Column = { $header: this.header, $body: this.header };
  readonly attrs = new Map<string, string>([["cid", "test"], ["pending-layout", ""]]);
  readonly heals: number[] = [];
  readonly logs: { label: string; data: Parameters<typeof Tracing.log>[1] }[] = [];
  private readonly log = Tracing.log;

  constructor(markAgeMs: number) {
    Object.defineProperties(this.header, {
      children: { value: [] },
      style: { value: { display: "", getPropertyValue: () => "-1" } },
    });
    this.header.hasAttribute = (name) => this.attrs.has(name);
    this.header.getAttribute = (name) => this.attrs.get(name) ?? null;
    this.header.getBoundingClientRect = () => ({
      x: 250, y: 0, width: 254, height: 0, left: 250, top: 0, right: 504, bottom: 0,
      toJSON: () => ({}),
    });
    Object.defineProperties(this.host, {
      children: { value: [] }, dataset: { value: {} },
    });
    this.host["headerSweepScheduled"] = false;
    this.host["headerSweepEpoch"] = 0;
    this.host["headerSweepTrailingTimer"] = null;
    this.host["prevHeaderViolations"] = new Set();
    this.host["lastPendingLayoutMarkMs"] = performance.now() - markAgeMs;
    this.host["headerHealAttemptedGen"] = -1;
    this.host._scrollEngine = new ScrollEngine(new Scroller(), {
      onCreate: () => this.column,
      onBind: () => {}, onRecycle: () => {},
    });
    this.engine.setBindGeneration(BindGeneration.of(2));
    this.engine.entries._all.set(-1, this.column);
    this.engine.emit.index = (index) => { this.heals.push(index); };
    Tracing.log = (label, data) => { this.logs.push({ label, data }); };
  }

  get engine(): ScrollEngine<Column> { return this.host.scrollEngine; }
  /** Put a bind in the engine's queue the way `queueOnBind` does, without
   * scheduling the drain (the test IS the frame clock). */
  queue(index: number, generation: BindGeneration): void {
    this.engine["bindBatcher"].enqueue(index, this.column, false, generation);
  }
  /** The queued bind lands: the drain empties the queue, `onBind` clears the mark. */
  land(): void {
    this.engine["bindBatcher"].drain(() => null);
    this.attrs.delete("pending-layout");
  }
  sweep(context: string): void { this.host["sweepHeaderInvariants"](context); }
  violations(): number { return this.logs.filter((l) => l.label === "scroll/header-violation").length; }
  restore(): void { this.host["resetHeaderSweeps"](); Tracing.log = this.log; }
}

Deno.test("header sweep: a marked column whose live bind is still queued is not escalated (c40 returning-active-user)", () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    h.queue(-1, BindGeneration.of(2));
    h.sweep("trailing");
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 0, "a queued live-generation bind is the mark's pending clear, not a strand");
    assertEquals(h.heals, []);
    h.land();
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 0);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header sweep: a marked column with NO bind coming still escalates while other binds drain", () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    h.queue(7, BindGeneration.of(2)); // queue not idle, but nothing for -1
    h.sweep("trailing");
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 1);
    assertEquals(h.heals, [-1]);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header sweep: a bind queued under a superseded generation does not excuse the mark", () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    h.queue(-1, BindGeneration.of(1)); // the drain drops it as stale
    h.sweep("trailing");
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 1);
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header sweep: the mark surviving its landed bind escalates on the next quiesce pair", () => {
  const clock = new Clock(), h = new Harness(4400);
  try {
    h.queue(-1, BindGeneration.of(2));
    h.sweep("trailing");
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 0);
    h.engine["bindBatcher"].drain(() => null); // bind ran, mark stayed (a lost clear)
    h.sweep("trailing-confirm");
    assertEquals(h.violations(), 1);
    assertEquals(h.heals, [-1]);
  } finally { h.restore(); clock.restore(); }
});

/**
 * review-C N4 (2026-09-27): a queued live bind is only a promise while the
 * drain can run it. `beginBindGeneration` holds every drain until the driver's
 * `commitBindGeneration`, and a bind pass that throws leaves that barrier held.
 * With the excuse unconditional, the confirm pass re-armed every 600 ms for as
 * long as the barrier stood — `header-suspect` forever, never
 * `scroll/header-violation`. These tests drive the re-arm branch itself on a
 * virtual `Tracing.Witness.WatchdogClock` (no wall time): the held barrier
 * escalates after a bounded number of confirm passes, and a drain that can
 * still make progress keeps its excuse however long it takes.
 */
class VirtualClock implements Tracing.Witness.WatchdogClock {
  private at = 100_000;
  private next = 0;
  private readonly due = new Map<number, { at: number; fn: () => void }>();
  now(): number { return this.at; }
  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.next;
    this.due.set(id, { at: this.at + ms, fn });
    return id;
  }
  clearTimeout(id: number): void { this.due.delete(id); }
  get pending(): number { return this.due.size; }
  /** Advance to the earliest timer and run it; false when none is armed. */
  fire(): boolean {
    let first: Option<[number, { at: number; fn: () => void }]> = null;
    for (const entry of this.due) if (first == null || entry[1].at < first[1].at) first = entry;
    if (first == null) return false;
    this.due.delete(first[0]);
    this.at = first[1].at;
    first[1].fn();
    return true;
  }
}

/** Run one armed sweep timer and the `$$.measure` read it queues (the confirm
 * pass); false when the ladder armed nothing. */
function confirmPass(clock: Clock, virtual: VirtualClock): boolean {
  if (!virtual.fire()) return false;
  const reads = clock.reads.splice(0);
  for (const read of reads) read();
  return true;
}

function onVirtualClock(h: Harness, markAgeMs: number): VirtualClock {
  const virtual = new VirtualClock();
  h.host["headerSweepClock"] = virtual;
  h.host["lastPendingLayoutMarkMs"] = virtual.now() - markAgeMs;
  return virtual;
}

function suspects(h: Harness): number {
  return h.logs.filter((l) => l.label === "scroll/header-suspect").length;
}

Deno.test("header sweep: a queued live bind behind a held installation barrier escalates after five confirm passes", () => {
  const clock = new Clock(), h = new Harness(4400);
  const virtual = onVirtualClock(h, 4400);
  try {
    h.queue(-1, BindGeneration.of(2));
    h.engine.beginBindGeneration(BindGeneration.of(2)); // the pass threw: never committed
    assertEquals(h.engine.bindInstallationPending, true);
    h.sweep("trailing"); // first sighting of the held barrier (t0)
    let passes = 0;
    while (h.violations() === 0 && passes < 50 && confirmPass(clock, virtual)) passes++;
    assertEquals(passes, 5, "t0+600..t0+3000: the fifth confirm pass is the first past the 3 s excuse budget");
    assertEquals(h.violations(), 1);
    assertEquals(suspects(h), 5, "the first sighting and four excused confirm passes each logged header-suspect");
    assertEquals(h.heals, [-1]);
    const held = h.logs.filter((l) => l.label === "scroll/header-installation-held");
    assertEquals(held.length, 1);
    assertEquals(held[0].data, { gen: 2, heldMs: 3000, ctx: "trailing-confirm" });
    assertEquals(virtual.pending, 0, "an escalating pass arms no further confirm: the loop is bounded");
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header sweep: a queued live bind the drain can still run keeps its excuse on every confirm pass", () => {
  const clock = new Clock(), h = new Harness(4400);
  const virtual = onVirtualClock(h, 4400);
  try {
    h.queue(-1, BindGeneration.of(2)); // no barrier: only the frame-starved drain is late
    h.sweep("trailing");
    for (let pass = 0; pass < 20; pass++) {
      assertEquals(confirmPass(clock, virtual), true, "the held sighting re-arms its confirm pass");
    }
    assertEquals(h.violations(), 0, "12 s of a late drain is not a strand");
    assertEquals(suspects(h), 21);
    assertEquals(h.heals, []);
    h.land();
    assertEquals(confirmPass(clock, virtual), true);
    assertEquals(h.violations(), 0);
    assertEquals(virtual.pending, 0, "a clean pass arms nothing");
  } finally { h.restore(); clock.restore(); }
});

Deno.test("header sweep: a barrier committed inside the budget ends the held clock; the queued bind keeps its excuse", () => {
  const clock = new Clock(), h = new Harness(4400);
  const virtual = onVirtualClock(h, 4400);
  const measureNext = $$.measureNext;
  $$.measureNext = (fn) => { clock.reads.push(fn); return fn; };
  try {
    h.queue(-1, BindGeneration.of(2));
    h.engine.beginBindGeneration(BindGeneration.of(2));
    h.sweep("trailing");
    for (let pass = 0; pass < 4; pass++) confirmPass(clock, virtual); // t0+2400, still excused
    assertEquals(h.violations(), 0);
    h.engine.commitBindGeneration(BindGeneration.of(2)); // the pass installed: the drain may run
    assertEquals(h.engine.bindInstallationPending, false);
    clock.reads.splice(0); // the frame-starved drain does not get its frame yet
    for (let pass = 0; pass < 10; pass++) {
      assertEquals(confirmPass(clock, virtual), true);
    }
    assertEquals(h.violations(), 0, "an installed generation's queued bind is still coming");
    assertEquals(h.logs.filter((l) => l.label === "scroll/header-installation-held").length, 0);
  } finally { $$.measureNext = measureNext; h.restore(); clock.restore(); }
});
