import { assertEquals } from "jsr:@std/assert";
import { NaiveDate } from "@tento-chrono";
import {
  GhostOverlay,
  type GhostOps,
  type Promotable,
} from "./ghost-overlay.ts";

// A DOM-less fake span — no `render`/HTMLElement. Proves the overlay (and
// thus the CLI) needs nothing from the DOM.
type Span = Promotable<NaiveDate.Range> & {
  title: string;
  preferredLane?: number;
};

const d = (iso: string): NaiveDate => {
  const [y, m, day] = iso.split("-").map(Number);
  return NaiveDate.fromYmd1(y, m, day).exp();
};
const range = (a: string, b: string) => new NaiveDate.Range(d(a), d(b));
const span = (key: string, a: string, b: string): Span => ({
  key,
  title: key,
  range: range(a, b),
});

// Trivial pure ops — lane is just the span's index in `base`, so capture is
// deterministic and the test is independent of real lane layout.
const ops: GhostOps<Span, NaiveDate.Range, { lane: number }> = {
  shiftRange: (r, days) =>
    new NaiveDate.Range(r.start.addDays(days), r.end.addDays(days)),
  capture: (key, base) => ({ lane: base.findIndex((s) => s.key === key) }),
  promote: (s, r, c) => ({ ...s, range: r, preferredLane: c.lane, isDragging: true }),
};

const overlay = () =>
  new GhostOverlay<Span, NaiveDate.Range, { lane: number }>(ops);

Deno.test("apply with no active gesture is identity", () => {
  const base = [span("a", "2026-04-15", "2026-04-15"), span("b", "2026-04-16", "2026-04-17")];
  const o = overlay();
  assertEquals(o.active, false);
  assertEquals(o.apply(base), base);
});

Deno.test("setShift moves only the keyed span; stamps lane + isDragging", () => {
  const base = [span("a", "2026-04-15", "2026-04-15"), span("b", "2026-04-16", "2026-04-17")];
  const o = overlay();
  o.setShift("a", 2, base); // move 'a' +2 days; capture lane = 0 (its index)
  assertEquals(o.active, true);

  const out = o.apply(base);
  assertEquals(out[0].range.start.toString(), "2026-04-17");
  assertEquals(out[0].range.end.toString(), "2026-04-17");
  assertEquals(out[0].isDragging, true);
  assertEquals(out[0].preferredLane, 0);
  // non-target passes through by reference
  assertEquals(out[1], base[1]);
});

Deno.test("idempotency: a canonical update to base mid-gesture doesn't double-apply the shift", () => {
  const base = [span("a", "2026-04-15", "2026-04-15")];
  const o = overlay();
  o.setShift("a", 1, base); // captures originalRange = 04-15
  o.setShift("a", 3, base); // same key → update amount to 3, keep the capture

  // Simulate a canonical update: `base` now already reflects a partial move.
  const base2 = [span("a", "2026-04-16", "2026-04-16")];
  const out = o.apply(base2);
  // shift is originalRange(04-15) + 3 = 04-18 — NOT base2's 04-16 + 3.
  assertEquals(out[0].range.start.toString(), "2026-04-18");
});

Deno.test("setReplace applies an absolute range", () => {
  const base = [span("a", "2026-04-15", "2026-04-16")];
  const o = overlay();
  o.setReplace("a", range("2026-04-15", "2026-04-20"), base);
  const out = o.apply(base);
  assertEquals(out[0].range.start.toString(), "2026-04-15");
  assertEquals(out[0].range.end.toString(), "2026-04-20");
  assertEquals(out[0].isDragging, true);
});

Deno.test("clearShift restores identity", () => {
  const base = [span("a", "2026-04-15", "2026-04-15")];
  const o = overlay();
  o.setShift("a", 5, base);
  o.clearShift();
  assertEquals(o.active, false);
  assertEquals(o.apply(base), base);
});

Deno.test("an unknown key clears the slot", () => {
  const base = [span("a", "2026-04-15", "2026-04-15")];
  const o = overlay();
  o.setShift("nope", 2, base);
  assertEquals(o.active, false);
  assertEquals(o.apply(base), base);
});
