/**
 * Lazy editor mount (`calendar-lazy-editor-mount`, dom-perf 33): static text
 * cells get their live editor on the page's idle lane (dom-perf 34) once the
 * page is still, never while it moves, shown cells only, one mount per unit
 * within the lane's slice; parked cells wait without polling.
 */
import { assertEquals } from "jsr:@std/assert";
import { FrameBudget } from "../../frame-budget.ts";
import { IdleLane } from "../../idle-lane.ts";
import { LazyEditorMount } from "./lazy-editor-mount.ts";

type Fake = {
  mounts: LazyEditorMount;
  idle: ((timeRemaining: () => number) => void)[];
  later: { task: () => void; ms: number }[];
  page: { sinceInputMs: number; now: number; idleMs: number; mountMs: number };
  runIdle(): void;
  runLater(): void;
};

function fake(): Fake {
  const idle: Fake["idle"] = [];
  const later: Fake["later"] = [];
  const page = { sinceInputMs: 1_000, now: 0, idleMs: 50, mountMs: 2 };
  const lane = new IdleLane({
    idle: (task) => void idle.push(task),
    later: (task, ms) => void later.push({ task, ms }),
    now: () => page.now,
    sinceInputMs: () => page.sinceInputMs,
    sinceMoveMs: () => 1_000,
    frameWork: () => false,
  });
  const mounts = new LazyEditorMount(lane);
  return {
    mounts, idle, later, page,
    runIdle() {
      const task = idle.shift()!;
      const end = page.now + page.idleMs;
      task(() => end - page.now);
    },
    runLater() {
      later.shift()!.task();
    },
  };
}

function cell(f: Fake, state: "ready" | "hidden" | "gone" = "ready") {
  const target = {
    state,
    mounted: 0,
    mountState: () => target.state,
    mount() {
      target.mounted++;
      f.page.now += f.page.mountMs;
    },
  };
  return target;
}

Deno.test("lazy editor mount: nothing mounts while the timeline moves; the cells mount once it is still", () => {
  const f = fake();
  const a = cell(f), b = cell(f);
  f.page.sinceInputMs = 16;
  f.mounts.add(a);
  f.mounts.add(b);
  assertEquals(f.idle.length, 1, "one idle callback for any number of cells");
  f.runIdle();
  assertEquals([a.mounted, b.mounted], [0, 0], "a scroll event 16 ms ago: still moving");
  assertEquals(f.later.length, 1, "looked at again once the quiet interval can have passed");
  f.page.sinceInputMs = IdleLane.QUIET_MS;
  f.runLater();
  f.runIdle();
  assertEquals([a.mounted, b.mounted], [1, 1]);
  assertEquals(f.mounts.size, 0);
  assertEquals([f.idle.length, f.later.length], [0, 0], "nothing left: nothing armed");
});


Deno.test("lazy editor mount: parked cells wait without polling, gone cells are forgotten, shown cells mount", () => {
  const f = fake();
  const shown = cell(f), parked = cell(f, "hidden"), gone = cell(f, "gone");
  for (const target of [parked, gone, shown]) f.mounts.add(target);
  f.runIdle();
  assertEquals([shown.mounted, parked.mounted, gone.mounted], [1, 0, 0]);
  assertEquals(f.mounts.size, 1, "the parked cell still waits");
  assertEquals([f.idle.length, f.later.length], [0, 0], "no recheck timer while only a parked cell waits (judge P3)");
  parked.state = "ready";
  f.mounts.lane.wake(); // a visible-range move (the reattach) wakes the lane
  f.runIdle();
  assertEquals(parked.mounted, 1);
  assertEquals(f.mounts.size, 0);
});

Deno.test("lazy editor mount: an idle period spends at most the lane's slice plus one mount; the rest goes to the next one", () => {
  const f = fake();
  const cells = Array.from({ length: 10 }, () => cell(f));
  for (const target of cells) f.mounts.add(target);
  f.page.idleMs = 50;
  f.page.mountMs = 1;
  f.runIdle();
  // 1 ms mounts in a 4 ms slice: at 0, 1, 2, 3 ms elapsed; a fifth would end at 5 ms.
  assertEquals(cells.filter((c) => c.mounted === 1).length, IdleLane.SLICE_MS);
  assertEquals(f.page.now <= IdleLane.SLICE_MS + 1, true);
  assertEquals(f.idle.length, 1, "re-armed for the next idle period at once");
  while (f.idle.length > 0) f.runIdle();
  assertEquals(cells.every((c) => c.mounted === 1), true);
});

Deno.test("lazy editor mount: a cell reached for (or recycled) before the idle period is not mounted again", () => {
  const f = fake();
  const a = cell(f), b = cell(f);
  f.mounts.add(a);
  f.mounts.add(b);
  f.mounts.delete(a);
  f.runIdle();
  assertEquals([a.mounted, b.mounted], [0, 1]);
});

Deno.test("frame budget: sinceInputMs counts from the last scroll event", () => {
  const budget = new FrameBudget();
  assertEquals(budget.sinceInputMs(5), Number.POSITIVE_INFINITY, "no scroll event yet");
  budget.noteInput(10);
  budget.noteInput(30);
  assertEquals(budget.sinceInputMs(130), 100);
  budget.open(1, 31);
  assertEquals(budget.sinceInputMs(40), 10, "opening a frame does not forget the last input");
});
