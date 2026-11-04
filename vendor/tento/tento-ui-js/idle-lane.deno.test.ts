/**
 * The page's idle lane (`IdleLane`, dom-perf 34): one stillness rule, one
 * slice per idle period, workers in registration order, no polling while nothing
 * is runnable, and a timer period where `requestIdleCallback` is missing
 * (judge R10-2, R10-3, R10-5).
 */
import { assertEquals } from "jsr:@std/assert";
import { FrameBudget, UnitCost } from "./frame-budget.ts";
import { IdleLane } from "./idle-lane.ts";

type Page = { now: number; sinceInputMs: number; sinceMoveMs: number; frameWork: boolean };

function fakeLane() {
  const page: Page = { now: 0, sinceInputMs: 1_000, sinceMoveMs: 1_000, frameWork: false };
  const idle: ((timeRemaining: () => number) => void)[] = [];
  const later: { task: () => void; ms: number }[] = [];
  const lane = new IdleLane({
    idle: (task) => void idle.push(task),
    later: (task, ms) => void later.push({ task, ms }),
    now: () => page.now,
    sinceInputMs: () => page.sinceInputMs,
    sinceMoveMs: () => page.sinceMoveMs,
    frameWork: () => page.frameWork,
  });
  return {
    lane, page, idle, later,
    /** One idle period reporting `ms` (an idle period with no frame pending reports up to 50). */
    period(ms = 50) {
      const task = idle.shift();
      const end = page.now + ms;
      task?.(() => end - page.now);
    },
  };
}

/** A worker of `count` units costing `costs[i]` ms each (the last cost repeats). */
function worker(page: Page, name: string, count: number, costs: number[], log: string[]) {
  let next = 0;
  let hidden = false;
  return {
    cost: new UnitCost(),
    hide: (h: boolean) => {
      hidden = h;
    },
    pending: () => next < count,
    take: () => {
      if (hidden || next >= count) return null;
      const i = next++;
      return () => {
        page.now += costs[Math.min(i, costs.length - 1)] ?? 0;
        log.push(`${name}${i}`);
      };
    },
  };
}

Deno.test("idle lane: one 50 ms idle period spends at most the slice plus one unit (judge P4: 28 units, 42 ms)", () => {
  const t = fakeLane();
  const log: string[] = [];
  t.lane.register(worker(t.page, "s", 28, [1.5], log));
  t.lane.wake();
  t.period(50);
  // 1.5 ms units: 0 -> 1.5 -> 3.0; a third would end at 4.5 > 4 ms.
  assertEquals(log, ["s0", "s1"]);
  assertEquals(t.page.now <= IdleLane.SLICE_MS + 1.5, true, `spent ${t.page.now} ms`);
  assertEquals(t.idle.length, 1, "work left: the next idle period at once");
  while (t.idle.length > 0) t.period(50);
  assertEquals(log.length, 28);
});

Deno.test("idle lane: an expensive unit runs alone, and its peak keeps later periods to one unit (judge P2: 11.8 ms)", () => {
  const t = fakeLane();
  const log: string[] = [];
  // Seven cheap mounts, then one of 8 ms, then cheap again.
  t.lane.register(worker(t.page, "m", 12, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 8, 0.5], log));
  t.lane.wake();
  t.period(50);
  assertEquals(log.length, 7, "0.5 ms units, each admitted at its 1 ms floor while the 4 ms slice has room");
  assertEquals(t.page.now, 3.5);
  const before = t.page.now;
  t.period(50);
  assertEquals(log.length, 8, "the 8 ms unit is the period's first: it runs, and nothing after it");
  assertEquals(t.page.now - before, 8, "spend = one unit's overrun, not 11.8 ms of mounts");
  t.period(50);
  assertEquals(log.length, 9, "a cheap unit again, but the decaying 8 ms peak admits no second one");
});

Deno.test("idle lane: nothing runs while input or a visible range moved within the quiet interval, or with frame work queued", () => {
  const t = fakeLane();
  const log: string[] = [];
  t.lane.register(worker(t.page, "w", 1, [1], log));
  for (const [key, value] of [["sinceInputMs", 16], ["sinceMoveMs", 40], ["frameWork", true]] as const) {
    const saved = { ...t.page };
    Object.assign(t.page, { [key]: value });
    t.lane.wake();
    t.period(50);
    assertEquals(log, [], `${key}=${value}: not still`);
    assertEquals(t.later.length, 1, "looked at again once the quiet interval can have passed");
    Object.assign(t.page, saved);
    t.later.shift()?.task();
  }
  t.period(50);
  assertEquals(log, ["w0"]);
  assertEquals(t.lane.still(), true);
});

Deno.test("idle lane: workers run in registration order; a waiting (hidden) worker is not polled (judge P3)", () => {
  const t = fakeLane();
  const log: string[] = [];
  const strips = worker(t.page, "s", 1, [1], log);
  const mounts = worker(t.page, "m", 2, [1], log);
  t.lane.register(strips);
  t.lane.register(mounts);
  mounts.hide(true);
  t.lane.wake();
  t.period(50);
  assertEquals(log, ["s0"]);
  assertEquals([t.idle.length, t.later.length], [0, 0], "only hidden work waits: nothing armed");
  mounts.hide(false);
  t.lane.wake(); // a visible-range move (a reattach) wakes the lane
  t.period(50);
  assertEquals(log, ["s0", "m0", "m1"]);
});

Deno.test("idle lane: a unit whose usual cost does not fit what the idle period has left waits for a longer period", () => {
  const t = fakeLane();
  const log: string[] = [];
  const big = worker(t.page, "b", 2, [6], log);
  t.lane.register(big);
  t.lane.wake();
  t.period(50);
  assertEquals(log, ["b0"], "cost unknown: the floor fits");
  t.period(3);
  assertEquals(log, ["b0"], "a 3 ms period cannot hold a 6 ms unit: it would run into the next frame");
  t.period(10);
  assertEquals(log, ["b0", "b1"]);
});

Deno.test("idle lane: without requestIdleCallback a timer period runs the work", async () => {
  const saved = globalThis.requestIdleCallback;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).requestIdleCallback = undefined;
  try {
    const lane = IdleLane.forDocument();
    const log: string[] = [];
    lane.register({ cost: new UnitCost(), pending: () => log.length === 0, take: () => () => void log.push("ran") });
    lane.wake();
    await new Promise((resolve) => setTimeout(resolve, IdleLane.FALLBACK_DELAY_MS + 20));
    assertEquals(log, ["ran"]);
  } finally {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).requestIdleCallback = saved;
  }
});

Deno.test("frame budget: visible-range moves notify listeners; a frame-work mark goes stale without a renewal", () => {
  const budget = new FrameBudget();
  let moves = 0;
  const off = budget.whenViewportMoves(() => moves++);
  budget.noteViewportMoved(100);
  assertEquals([moves, budget.sinceViewportMoveMs(150)], [1, 50]);
  off();
  budget.noteViewportMoved(200);
  assertEquals(moves, 1);
  const engine = {};
  budget.noteFrameWork(engine, true, 0);
  assertEquals(budget.hasFrameWork(100), true);
  assertEquals(budget.hasFrameWork(FrameBudget.FRAME_WORK_STALE_MS), false, "a mark no drain renewed stops blocking idle work");
  budget.noteFrameWork(engine, false);
  budget.addDebt(engine);
  assertEquals(budget.hasFrameWork(0), true, "background debt is frame work");
});

Deno.test("IdleLane: unregister releases a worker before an already scheduled period", () => {
  const { lane, period } = fakeLane();
  let calls = 0;
  const unregister = lane.register({
    cost: new UnitCost(),
    pending: () => { calls++; return true; },
    take: () => () => { calls++; },
    periodEnded: () => { calls++; },
  });
  lane.wake();
  unregister();
  unregister();
  period();
  assertEquals(calls, 0);
});

Deno.test("idle lane: every {@link IdleLane.<member>} in its source names a member that exists", () => {
  const text = Deno.readTextFileSync(new URL("./idle-lane.ts", import.meta.url));
  const dangling = [...text.matchAll(/\{@link IdleLane\.(\w+)\}/g)]
    .map((match) => match[1])
    .filter((name) => !Reflect.has(IdleLane, name) && !Reflect.has(IdleLane.prototype, name));
  assertEquals(dangling, []);
});
