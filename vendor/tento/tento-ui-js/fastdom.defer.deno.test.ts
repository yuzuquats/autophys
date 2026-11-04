import { assertEquals } from "jsr:@std/assert";

// Same minimal browser-global stubs as fastdom.generation.deno.test.ts: capture
// rAF callbacks to fire by hand, no-op the performance marks. setTimeout is
// stubbed so the shared-drain contract can be asserted synchronously.
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

// Deno.test bodies run after module evaluation, so the stub must stay
// installed for the file's lifetime — no restore at module scope.
const timerQueue: Array<() => void> = [];
let timerInstalls = 0;
// deno-lint-ignore no-explicit-any -- matching the ambient setTimeout surface in a stub.
(globalThis as any).setTimeout = (cb: () => void) => {
  timerInstalls++;
  timerQueue.push(cb);
  return timerInstalls;
};

const { Fastdom } = await import("./fastdom.ts");

function flushOnce() {
  const cb = rafQueue.shift();
  if (cb) cb();
}

function fireTimers() {
  while (timerQueue.length > 0) timerQueue.shift()!();
}

Deno.test("defer coalesces one flush's tasks into ONE timer, FIFO", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  const before = timerInstalls;
  fd.defer(() => ran.push("a"));
  fd.defer(() => ran.push("b"));
  fd.deferMutate(() => ran.push("m"));
  flushOnce(); // writesEnd enqueues into the shared drain
  assertEquals(timerInstalls - before, 1);
  assertEquals(ran, []);
  fireTimers(); // the drain runs a/b, and m's mutate schedules a new flush
  flushOnce();
  assertEquals(ran, ["a", "b", "m"]);
});

Deno.test("a throwing deferred task does not swallow the rest of the batch", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.defer(() => {
    throw new Error("boom");
  });
  fd.defer(() => ran.push("survivor"));
  flushOnce();
  // The rethrow lands on its own macrotask; drop it instead of running it.
  fireTimersDroppingThrows();
  assertEquals(ran, ["survivor"]);

  function fireTimersDroppingThrows() {
    while (timerQueue.length > 0) {
      const cb = timerQueue.shift()!;
      try {
        cb();
      } catch {
        // the isolated rethrow — expected
      }
    }
  }
});

Deno.test("defers from a later flush get their own timer", () => {
  const fd = new Fastdom();
  const ran: string[] = [];
  fd.defer(() => ran.push("first"));
  flushOnce();
  fireTimers();
  const before = timerInstalls;
  fd.defer(() => ran.push("second"));
  flushOnce();
  assertEquals(timerInstalls - before, 1);
  fireTimers();
  assertEquals(ran, ["first", "second"]);
});
