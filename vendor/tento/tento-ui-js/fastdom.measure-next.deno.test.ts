import { assertEquals } from "jsr:@std/assert";

// Same minimal browser-global stubs as fastdom.generation.deno.test.ts: capture
// rAF callbacks to fire by hand, no-op the performance marks.
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

Deno.test("measure from inside the read phase joins the SAME flush", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.measure(() => {
    ran.push("outer");
    fd.measure(() => ran.push("inner"));
  });
  flushOnce();
  // The live `reads` array is drained with shift(), so the nested measure ran
  // in the same read phase — the measure-after-mutate chaining contract.
  assertEquals(ran, ["outer", "inner"]);
});

Deno.test("measureNext from inside the read phase yields to the NEXT flush", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.measure(() => {
    ran.push("outer");
    fd.measureNext(() => ran.push("deferred"));
  });
  flushOnce();
  assertEquals(ran, ["outer"], "deferred task must not run in the same flush");
  flushOnce();
  assertEquals(ran, ["outer", "deferred"]);
});

Deno.test("measureNext's mutates land in ITS frame's write phase (read→write pairing)", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.measure(() => {
    fd.measureNext(() => {
      ran.push("read2");
      fd.mutate(() => ran.push("write2"));
    });
    fd.mutate(() => ran.push("write1"));
  });
  flushOnce();
  assertEquals(ran, ["write1"], "frame 1: only the same-frame mutate ran");
  flushOnce();
  assertEquals(ran, ["write1", "read2", "write2"], "frame 2: deferred read, then its write");
});

Deno.test("measureNext outside a flush runs in the upcoming flush (equivalent to measure)", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.measureNext(() => ran.push("a"));
  fd.measure(() => ran.push("b"));
  flushOnce();
  // Promotion appends at flush start, so deferred tasks run in the same read
  // phase but after the directly-queued reads.
  assertEquals(ran, ["b", "a"]);
});

Deno.test("a chain of measureNext self-re-enqueues runs one link per flush", () => {
  const fd = new Fastdom();
  const ran: number[] = [];
  let n = 0;
  const drain = () => {
    ran.push(++n);
    if (n < 3) fd.measureNext(drain);
  };
  fd.measureNext(drain);
  flushOnce();
  assertEquals(ran, [1]);
  flushOnce();
  assertEquals(ran, [1, 2]);
  flushOnce();
  assertEquals(ran, [1, 2, 3]);
  // Nothing left: a fourth flush is a no-op.
  flushOnce();
  assertEquals(ran, [1, 2, 3]);
});
