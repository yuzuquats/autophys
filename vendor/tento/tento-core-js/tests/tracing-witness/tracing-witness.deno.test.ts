import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { Tracing } from "../../tracing.ts";

// Helper: capture llm entries emitted while `fn` runs by subscribing
// to Tracing.onEntry. The Tracing module accumulates entries even when
// no spans are active (Tracing.log wraps a synthetic root span), so
// each structured log call surfaces as one root entry.
function captureLlmLabels(fn: () => void | Promise<void>): {
  promise: Promise<string[]>;
} {
  const labels: string[] = [];
  const cb = (entry: Tracing.LjsonEntry) => {
    labels.push(entry.rootSpan.name);
  };
  Tracing.onEntry(cb);
  const promise = Promise.resolve(fn()).then(() => {
    Tracing.removeOnEntry(cb);
    return labels;
  });
  return { promise };
}

// ── RateLimit ────────────────────────────────────────────────────────

Deno.test("Witness.RateLimit — observe returns ok below threshold", () => {
  const w = new Tracing.Witness.RateLimit({
    name: "test/rate-limit",
    windowMs: 1000,
    threshold: 5,
  });
  for (let i = 0; i < 5; i++) {
    assertEquals(w.observe("id-a", null), "ok");
  }
});

Deno.test("Witness.RateLimit — trips past threshold and emits once per window", async () => {
  const w = new Tracing.Witness.RateLimit({
    name: "test/rate-limit-trip",
    windowMs: 1000,
    threshold: 3,
  });
  const cap = captureLlmLabels(() => {
    // 4th observe crosses the threshold (count=4 > threshold=3).
    assertEquals(w.observe("id-a", null), "ok");
    assertEquals(w.observe("id-a", null), "ok");
    assertEquals(w.observe("id-a", null), "ok");
    assertEquals(w.observe("id-a", null), "tripped");
    // Re-observe within same window: still tripped, but no new emit.
    assertEquals(w.observe("id-a", null), "tripped");
    assertEquals(w.observe("id-a", null), "tripped");
  });
  const labels = await cap.promise;
  const trips = labels.filter((l) => l === "witness/rate-limit");
  assertEquals(trips.length, 1, "exactly one emit per window");
});

Deno.test("Witness.RateLimit — independent ids count separately", () => {
  const w = new Tracing.Witness.RateLimit({
    name: "test/rate-limit-perid",
    windowMs: 1000,
    threshold: 3,
  });
  // 3 of each id, none should trip.
  for (let i = 0; i < 3; i++) {
    assertEquals(w.observe("id-a", null), "ok");
    assertEquals(w.observe("id-b", null), "ok");
  }
});

Deno.test("Witness.RateLimit — reset clears window state", () => {
  const w = new Tracing.Witness.RateLimit({
    name: "test/rate-limit-reset",
    windowMs: 1000,
    threshold: 2,
  });
  assertEquals(w.observe("id-a", null), "ok");
  assertEquals(w.observe("id-a", null), "ok");
  assertEquals(w.observe("id-a", null), "tripped");
  w.reset();
  assertEquals(w.observe("id-a", null), "ok");
  assertEquals(w.observe("id-a", null), "ok");
});

// ── Reentrancy ───────────────────────────────────────────────────────

Deno.test("Witness.Reentrancy — enter/exit balanced calls stay ok", () => {
  const w = new Tracing.Witness.Reentrancy({
    name: "test/reentry",
    onReentry: "log",
  });
  assertEquals(w.depth, 0);
  const exit1 = w.enter(null);
  assertEquals(w.depth, 1);
  exit1();
  assertEquals(w.depth, 0);
  const exit2 = w.enter(null);
  exit2();
  assertEquals(w.depth, 0);
});

Deno.test("Witness.Reentrancy — nested enter emits in 'log' mode", async () => {
  const w = new Tracing.Witness.Reentrancy({
    name: "test/reentry-log",
    onReentry: "log",
  });
  const cap = captureLlmLabels(() => {
    const exit1 = w.enter(null);
    const exit2 = w.enter(null); // reentry — emits but doesn't throw
    assertEquals(w.depth, 2);
    exit2();
    exit1();
  });
  const labels = await cap.promise;
  assert(
    labels.includes("witness/reentry"),
    `expected witness/reentry emit, got ${JSON.stringify(labels)}`,
  );
});

Deno.test("Witness.Reentrancy — nested enter throws in 'throw' mode", () => {
  const w = new Tracing.Witness.Reentrancy({
    name: "test/reentry-throw",
    onReentry: "throw",
  });
  const exit1 = w.enter(null);
  assertThrows(
    () => w.enter(null),
    Tracing.Witness.ReentrancyError,
  );
  exit1();
});

Deno.test("Witness.Reentrancy — double-exit is safe", () => {
  const w = new Tracing.Witness.Reentrancy({
    name: "test/reentry-double-exit",
    onReentry: "log",
  });
  const exit = w.enter(null);
  exit();
  exit(); // safe no-op
  assertEquals(w.depth, 0);
});

// ── Watchdog ─────────────────────────────────────────────────────────

// A synchronous, virtual-time clock for Witness.Watchdog. Deterministic
// stand-in for the two timeout-based tests below, which flaked under
// `deno test --parallel` load when real setTimeout delays raced the
// watchdog's own sweep timer. `advance` fires any due timers in deadline
// order without waiting on the wall clock.
class FakeWatchdogClock implements Tracing.Witness.WatchdogClock {
  private time = 0;
  private nextId = 1;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.push({ id, at: this.time + ms, fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.time = due.at;
      due.fn();
    }
    this.time = target;
  }
}

Deno.test("Witness.Watchdog — disarm before timeout suppresses emit", async () => {
  const clock = new FakeWatchdogClock();
  const w = new Tracing.Witness.Watchdog({
    name: "test/watchdog-disarm",
    clock,
  });
  const cap = captureLlmLabels(() => {
    const disarm = w.arm(50, null);
    clock.advance(10);
    disarm();
    clock.advance(100);
  });
  const labels = await cap.promise;
  const wd = labels.filter((l) => l === "witness/watchdog");
  assertEquals(wd.length, 0, "no watchdog emit when disarmed in time");
});

Deno.test("Witness.Watchdog — emits when timeout passes without disarm", async () => {
  const clock = new FakeWatchdogClock();
  const w = new Tracing.Witness.Watchdog({
    name: "test/watchdog-fire",
    clock,
  });
  const cap = captureLlmLabels(() => {
    w.arm(20, null);
    clock.advance(100);
  });
  const labels = await cap.promise;
  const wd = labels.filter((l) => l === "witness/watchdog");
  assertEquals(wd.length, 1);
});

Deno.test("Witness.Watchdog — disarm after fire is safe no-op", async () => {
  const w = new Tracing.Witness.Watchdog({ name: "test/watchdog-post-fire" });
  const disarm = w.arm(20, null);
  await new Promise((r) => setTimeout(r, 100));
  // Watchdog fired. Disarming after is safe.
  disarm();
  disarm();
});

// ── StuckState ───────────────────────────────────────────────────────

Deno.test("Witness.StuckState — progress=true resets counter", () => {
  const w = new Tracing.Witness.StuckState({
    name: "test/stuck-reset",
    maxIterations: 3,
  });
  assertEquals(w.iter(false, null), "ok");
  assertEquals(w.iter(false, null), "ok");
  assertEquals(w.iter(true, null), "ok"); // resets
  assertEquals(w.iter(false, null), "ok");
  assertEquals(w.iter(false, null), "ok");
});

Deno.test("Witness.StuckState — flips to stuck after maxIterations false in a row", async () => {
  const w = new Tracing.Witness.StuckState({
    name: "test/stuck-fire",
    maxIterations: 3,
  });
  const cap = captureLlmLabels(() => {
    assertEquals(w.iter(false, null), "ok");
    assertEquals(w.iter(false, null), "ok");
    assertEquals(w.iter(false, null), "stuck");
  });
  const labels = await cap.promise;
  const stuck = labels.filter((l) => l === "witness/stuck");
  assertEquals(stuck.length, 1);
});

Deno.test("Witness.StuckState — manual reset clears stuck count", () => {
  const w = new Tracing.Witness.StuckState({
    name: "test/stuck-manual-reset",
    maxIterations: 2,
  });
  assertEquals(w.iter(false, null), "ok");
  w.reset();
  assertEquals(w.iter(false, null), "ok");
  // Still ok because counter restarted from 1.
});
