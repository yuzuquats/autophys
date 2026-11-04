import { assert, assertEquals } from "jsr:@std/assert";
import { type Month1, NaiveDate, Weekday, type Ym1Like } from "@tento-chrono";
import { computeSpanLayout, type RangedItem } from "./span-layout.ts";

type Item = RangedItem & { id: string };

const d = (iso: string): NaiveDate => {
  const [y, m, day] = iso.split("-").map(Number);
  return NaiveDate.fromYmd1(y, m, day).exp();
};
const item = (id: string, a: string, b: string, preferredLane?: number): Item => ({
  id,
  range: new NaiveDate.Range(d(a), d(b)),
  preferredLane,
});

const APRIL_2026: Ym1Like = { yr: 2026, mth: 4 as Month1 };

Deno.test("single-week span → one segment on lane 0; 42-cell grid", () => {
  const { positionedSegments, laneCounts } = computeSpanLayout(
    [item("e1", "2026-04-15", "2026-04-16")],
    APRIL_2026,
    Weekday.SUN,
  );
  assertEquals(positionedSegments.length, 1);
  assertEquals(positionedSegments[0].lane, 0);
  assertEquals(laneCounts.length, 42); // 6 weeks × 7 days
});

Deno.test("a 10-day span crosses ≥1 week boundary → splits into multiple segments", () => {
  const { positionedSegments } = computeSpanLayout(
    [item("e1", "2026-04-10", "2026-04-19")],
    APRIL_2026,
    Weekday.SUN,
  );
  // A span longer than a week must split across at least two week-rows.
  assert(positionedSegments.length >= 2);
  // every segment points back at the same source item
  for (const { segment } of positionedSegments) {
    assertEquals((segment.originalItem as Item).id, "e1");
  }
});

Deno.test("overlapping spans stack on distinct lanes", () => {
  const { positionedSegments } = computeSpanLayout(
    [
      item("e1", "2026-04-15", "2026-04-17"),
      item("e2", "2026-04-16", "2026-04-18"), // overlaps e1
    ],
    APRIL_2026,
    Weekday.SUN,
  );
  assertEquals(positionedSegments.length, 2);
  const lanes = positionedSegments.map((p) => p.lane).sort();
  assertEquals(lanes, [0, 1]);
});

Deno.test("preferredLane is honored when free", () => {
  const { positionedSegments } = computeSpanLayout(
    [item("e1", "2026-04-15", "2026-04-15", 2)],
    APRIL_2026,
    Weekday.SUN,
  );
  assertEquals(positionedSegments[0].lane, 2);
});

Deno.test("an event entirely outside the grid yields no segments", () => {
  const { positionedSegments } = computeSpanLayout(
    [item("e1", "2026-08-01", "2026-08-03")],
    APRIL_2026,
    Weekday.SUN,
  );
  assertEquals(positionedSegments.length, 0);
});
