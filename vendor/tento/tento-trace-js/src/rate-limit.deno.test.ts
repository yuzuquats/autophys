/**
 * `Tracing.Witness.RateLimit` keeps a per-id queue of the times still in its
 * window. These tests pin that it trips exactly where the single shared list
 * it replaced did: the same verdict for every observation of a long mixed
 * sequence (bursts, gaps longer than the window, many ids), under a scripted
 * clock.
 */
import { assertEquals } from "jsr:@std/assert";
import { Tracing } from "./tracing.ts";

/** The replaced algorithm: one list for every id, drained from the front. */
class ReferenceRateLimit {
  readonly #recent: Array<{ time: number; id: string }> = [];
  constructor(readonly windowMs: number, readonly threshold: number) {}
  observe(id: string, now: number): "ok" | "tripped" {
    while (this.#recent.length > 0 && (this.#recent[0]?.time ?? 0) < now - this.windowMs) this.#recent.shift();
    this.#recent.push({ time: now, id });
    let count = 0;
    for (const e of this.#recent) if (e.id === id) count++;
    return count <= this.threshold ? "ok" : "tripped";
  }
}

/** Run `fn` with `performance.now()` answering `clock.t`. */
function withClock<T>(clock: { t: number }, fn: () => T): T {
  const original = performance.now;
  Object.defineProperty(performance, "now", { value: () => clock.t, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(performance, "now", { value: original, configurable: true, writable: true });
  }
}

/** A deterministic pseudo-random sequence (LCG), so the run is reproducible. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

Deno.test("RateLimit trips exactly where the shared-list witness did, over a mixed sequence", () => {
  const clock = { t: 1_000 };
  const next = lcg(7);
  const witness = new Tracing.Witness.RateLimit({ name: "test/rate-limit", windowMs: 1000, threshold: 30 });
  const reference = new ReferenceRateLimit(1000, 30);
  const verdicts = withClock(clock, () => {
    const out: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const r = next();
      // Mostly sub-millisecond steps (bursts), sometimes a gap past the window.
      clock.t += r < 0.002 ? 1500 : r < 0.05 ? 40 : r * 0.5;
      const id = `row-${Math.floor(next() * (r < 0.5 ? 3 : 200))}`;
      const got = witness.observe(id, null);
      const want = reference.observe(id, clock.t);
      out.push(got === want ? "same" : `diff@${i}:${id}:${got}/${want}`);
    }
    return out;
  });
  const diffs = verdicts.filter((v) => v !== "same");
  assertEquals(diffs, []);
});

Deno.test("RateLimit: the threshold-th observation in the window is ok, the next trips, and it decays", () => {
  const clock = { t: 0 };
  const witness = new Tracing.Witness.RateLimit({ name: "test/rate-limit-edge", windowMs: 100, threshold: 3 });
  withClock(clock, () => {
    const seen = [1, 2, 3, 4].map((ms) => {
      clock.t = ms;
      return witness.observe("a", null);
    });
    assertEquals(seen, ["ok", "ok", "ok", "tripped"]);
    // Another id is counted apart.
    assertEquals(witness.observe("b", null), "ok");
    // At t = 101 the entry at t = 1 is still inside (101 - 100 = 1 is not < 1)…
    clock.t = 101;
    assertEquals(witness.observe("a", null), "tripped");
    // …at t = 104 the entries at 1, 2 and 3 have aged out: 4, 101, 104 remain.
    clock.t = 104;
    assertEquals(witness.observe("a", null), "ok");
    witness.reset();
    clock.t = 105;
    assertEquals(witness.observe("a", null), "ok");
  });
});
