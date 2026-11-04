import { assertEquals } from "jsr:@std/assert";

// fastdom touches a few browser globals at flush time. Stub the minimum so the
// flush loop runs deterministically in Deno: capture rAF callbacks (we fire them
// by hand) and no-op the performance marks.
const rafQueue: Array<() => void> = [];
Object.defineProperty(globalThis, "window", {
  value: {
    requestAnimationFrame: (cb: () => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
  },
  configurable: true,
});
const noop = () => {};
Object.defineProperty(globalThis, "performance", {
  value: {
    now: () => 0,
    mark: noop,
    measure: noop,
    clearMarks: noop,
    clearMeasures: noop,
  },
  configurable: true,
});

const { Fastdom } = await import("./fastdom.ts");

/** Fire one queued rAF callback (one flush cycle). */
function flushOnce() {
  const cb = rafQueue.shift();
  if (cb) cb();
}

Deno.test("untagged tasks always run (backward-compat)", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.mutate(() => ran.push("a"));
  fd.mutate(() => ran.push("b"));
  fd.setLiveGeneration(99); // even with a high live gen, untagged is never skipped
  flushOnce();
  assertEquals(ran, ["a", "b"]);
  assertEquals(fd.droppedGenerationTasks, 0);
});

Deno.test("tagged task at/above liveGen runs; below is dropped", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.runWithGeneration(1, () => fd.mutate(() => ran.push("gen1")));
  fd.runWithGeneration(2, () => fd.mutate(() => ran.push("gen2")));
  fd.runWithGeneration(3, () => fd.mutate(() => ran.push("gen3")));
  // Live epoch advances to 2: gen1 is superseded (1 < 2) and dropped; gen2
  // (== live) and gen3 (> live) survive.
  fd.setLiveGeneration(2);
  flushOnce();
  assertEquals(ran, ["gen2", "gen3"]);
  assertEquals(fd.droppedGenerationTasks, 1);
});

Deno.test("setLiveGeneration is monotonic — a lower value can't resurrect work", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.runWithGeneration(1, () => fd.mutate(() => ran.push("gen1")));
  fd.setLiveGeneration(5);
  fd.setLiveGeneration(2); // ignored; live stays 5
  flushOnce();
  assertEquals(ran, []); // gen1 still dropped (1 < 5)
  assertEquals(fd.droppedGenerationTasks, 1);
});

Deno.test("runWithGeneration restores the previous ambient (nesting)", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.runWithGeneration(1, () => {
    fd.mutate(() => ran.push("outer-before"));
    fd.runWithGeneration(2, () => fd.mutate(() => ran.push("inner")));
    fd.mutate(() => ran.push("outer-after")); // back to gen 1
  });
  // Live = 2: gen-1 tasks (outer-before, outer-after) drop; gen-2 (inner) runs.
  fd.setLiveGeneration(2);
  flushOnce();
  assertEquals(ran, ["inner"]);
  assertEquals(fd.droppedGenerationTasks, 2);
});

Deno.test("tasks enqueued outside runWithGeneration are untagged even after a generation ran", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.runWithGeneration(1, () => fd.mutate(() => ran.push("tagged")));
  fd.mutate(() => ran.push("untagged")); // ambient restored to null
  fd.setLiveGeneration(2);
  flushOnce();
  assertEquals(ran, ["untagged"]); // tagged gen-1 dropped, untagged survives
  assertEquals(fd.droppedGenerationTasks, 1);
});

Deno.test("measure (reads) and mutateEnd honor generation too", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.runWithGeneration(1, () => {
    fd.measure(() => ran.push("read"));
    fd.mutateEnd(() => ran.push("writeEnd"));
  });
  fd.setLiveGeneration(2);
  flushOnce();
  assertEquals(ran, []);
  assertEquals(fd.droppedGenerationTasks, 2);
});
