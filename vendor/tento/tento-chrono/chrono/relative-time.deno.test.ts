import { assertEquals } from "jsr:@std/assert";
import { RelativeTime } from "../chrono/relative-time.ts";

// The clock is injected, so every boundary is reachable from a fixed pair of
// numbers. That is the whole reason this moved out of the review UI.

const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ago = (ms: number) => RelativeTime.compact(NOW - ms, NOW);

Deno.test("RelativeTime.compact - sub-minute reads as 'just now'", () => {
  assertEquals(ago(0), "just now");
  assertEquals(ago(44 * SEC), "just now");
});

Deno.test("RelativeTime.compact - minutes, and never '0m'", () => {
  // 45s is past the just-now cutoff but floors to zero minutes; the row must
  // still name a duration rather than counting down to nothing.
  assertEquals(ago(45 * SEC), "1m");
  assertEquals(ago(59 * MIN), "59m");
});

Deno.test("RelativeTime.compact - hours up to a day", () => {
  assertEquals(ago(60 * MIN), "1h");
  assertEquals(ago(23 * HOUR + 59 * MIN), "23h");
});

Deno.test("RelativeTime.compact - days up to a week", () => {
  assertEquals(ago(DAY), "1d");
  assertEquals(ago(6 * DAY + 23 * HOUR), "6d");
});

Deno.test("RelativeTime.compact - past a week it is a date, not a duration", () => {
  const out = ago(7 * DAY);
  assertEquals(out.endsWith("d"), false, `expected an absolute date, got ${out}`);
  assertEquals(out.length > 0, true);
});

Deno.test("RelativeTime.compact - a future stamp is clamped, not negated", () => {
  // Server stamps and browser clocks disagree by seconds all the time; "-2m"
  // would read as a bug rather than as skew.
  assertEquals(RelativeTime.compact(NOW + 5 * MIN, NOW), "just now");
});

const left = (ms: number) => RelativeTime.remaining(NOW + ms, NOW);

Deno.test("RelativeTime.remaining - under a minute is seconds alone", () => {
  assertEquals(left(58 * SEC), "58s");
  assertEquals(left(0), "0s");
});

Deno.test("RelativeTime.remaining - minutes carry their seconds", () => {
  assertEquals(left(14 * MIN + 32 * SEC), "14m 32s");
  assertEquals(left(MIN), "1m 0s");
  assertEquals(left(59 * MIN + 59 * SEC), "59m 59s");
});

Deno.test("RelativeTime.remaining - hours drop the seconds, never a third unit", () => {
  assertEquals(left(2 * HOUR + 5 * MIN + 44 * SEC), "2h 5m");
  assertEquals(left(HOUR), "1h 0m");
});

Deno.test("RelativeTime.remaining - a deadline already past reads 0s", () => {
  // The caller renders "closed"; this one never counts through zero into a
  // negative, which is the shape the add-host window's expiry needs.
  assertEquals(RelativeTime.remaining(NOW - 3 * SEC, NOW), "0s");
});
