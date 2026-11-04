/**
 * Tests for lane packing in `RangeLayoutManager` / `RangeLayout.Manager` — the
 * layer that decides which all-day calendar events get a visible bar and which
 * collapse into the "+N more" dots.
 *
 * Bug shape: both managers cache a lane per item id and never revisit it.
 * `getRow`/`place` return the cached lane on every subsequent call, and the
 * incremental update path only *removes* items that vanished or whose range
 * changed — it never re-places the survivors. So a lane assignment is a
 * function of the entire history of the row, not of the events currently in it:
 *
 *   - An event pushed to lane 1 by two neighbours stays in lane 1 forever,
 *     including after both neighbours are deleted and lane 0 is empty. The
 *     all-day strip is collapsed to one lane, so that event renders as
 *     "+N more" dots on every day it covers while the visible lane is blank.
 *     Multi-day spans hit this hardest: they overlap more neighbours, so they
 *     are the most likely to be displaced and the most visible when hidden.
 *   - The same set of events packs differently depending on the order they
 *     happened to arrive, so the strip renders differently after a scroll,
 *     a provider sync, or a reload than it did before.
 *
 * These assert the two properties that make the strip's rendering a function
 * of its contents: COMPACTNESS (no item sits in a lane when an earlier lane
 * has room for its whole range) and ORDER-INDEPENDENCE (the same item set
 * packs identically however it arrived). A test that only checked the
 * two-neighbours-deleted repro would pin one symptom and miss the class.
 *
 * Seeds are fixed so a failure is reproducible.
 */

import { assert, assertEquals } from "jsr:@std/assert";

import { RangeLayout, RangeLayoutManager } from "../../range-layout.ts";

interface Span {
  id: string;
  range: { start: number; end: number };
}

const span = (id: string, start: number, end: number): Span => ({
  id,
  range: { start, end },
});

/** Deterministic PRNG — mulberry32. Keeps failures reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const overlaps = (a: Span, b: Span): boolean =>
  a.range.start <= b.range.end && b.range.start <= a.range.end;

/**
 * The compactness invariant, stated over a finished layout: for every item,
 * every lane before its own already holds something it overlaps. If some
 * earlier lane is free across the item's whole range, the packer left a hole
 * and the UI hides an event that had somewhere to go.
 */
function assertCompact(
  lanes: Map<string, number>,
  items: Span[],
  context: string,
): void {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const [id, lane] of lanes) {
    const item = byId.get(id)!;
    for (let earlier = 0; earlier < lane; earlier++) {
      const blocker = [...lanes].find(
        ([otherId, otherLane]) =>
          otherLane === earlier &&
          otherId !== id &&
          overlaps(item, byId.get(otherId)!),
      );
      assert(
        blocker != null,
        `${context}: ${id} (${item.range.start}..${item.range.end}) sits in ` +
          `lane ${lane} but lane ${earlier} is free across its whole range`,
      );
    }
  }
}

/** Lane assignment for every currently-laid-out item, imperative API. */
function lanesOf(
  manager: RangeLayoutManager<Span>,
  maxRows: number,
): Map<string, number> {
  const lanes = new Map<string, number>();
  for (let lane = 0; lane < maxRows; lane++) {
    for (const item of manager.getItemsInRow(lane)) lanes.set(item.id, lane);
  }
  return lanes;
}

/**
 * Feeds the manager the way `TimelineLayoutManager.updateLayoutState` does:
 * hand it the full current set and let it repack.
 *
 * `_maxRows` is unused and kept only so the call sites read like the code they
 * model; the incremental version this replaced needed it to enumerate lanes.
 */
function update(manager: RangeLayoutManager<Span>, items: Span[], _maxRows: number): void {
  manager.update(items);
}

Deno.test("RangeLayoutManager: a multi-day span keeps the visible lane over single-day neighbours", () => {
  const maxRows = 8;
  const manager = new RangeLayoutManager<Span>(maxRows, 1);

  const trip = span("trip", 0, 4); // the multi-day all-day span
  update(manager, [span("mon", 0, 0), span("tue", 1, 1), trip], maxRows);

  assertEquals(
    lanesOf(manager, maxRows).get("trip"),
    0,
    "the longest span at a given start takes the top lane",
  );

  // The rendering consequence: with the strip collapsed to one lane, the
  // multi-day span is the bar and the single-day events are what collapse.
  const { visible, overflow } = manager.partition(1);
  assertEquals(visible.map((v) => v.item.id), ["trip"]);
  assert(overflow.size > 0, "the displaced single-day events become overflow");
});

Deno.test("RangeLayoutManager: a displaced span reclaims lane 0 once its blocker is deleted", () => {
  const maxRows = 8;
  const manager = new RangeLayoutManager<Span>(maxRows, 1);

  const trip = span("trip", 1, 4); // the multi-day all-day span
  const week = span("week", 0, 6); // starts earlier and runs longer — takes lane 0

  update(manager, [week, trip], maxRows);
  assertEquals(
    lanesOf(manager, maxRows).get("trip"),
    1,
    "precondition: the multi-day span is displaced to lane 1 by the longer span",
  );

  // The operator deletes the blocking event. Lane 0 is now empty for every day
  // the trip covers, so the trip belongs in it.
  update(manager, [trip], maxRows);

  assertEquals(
    lanesOf(manager, maxRows).get("trip"),
    0,
    "the multi-day span must move back to the visible lane once nothing blocks it",
  );

  const { visible, overflow } = manager.partition(1);
  assertEquals(visible.map((v) => v.item.id), ["trip"]);
  assertEquals(
    overflow.size,
    0,
    "nothing may collapse into the overflow indicator while the visible lane is free",
  );
});

Deno.test("RangeLayoutManager: packing does not depend on the order events arrived", () => {
  const items = [
    span("trip", 0, 4),
    span("mon", 0, 0),
    span("tue", 1, 1),
    span("weekend", 5, 6),
    span("thu", 3, 3),
    span("long", 2, 6),
  ];

  const canonical = (() => {
    const manager = new RangeLayoutManager<Span>(8, 1);
    update(manager, items, 8);
    return lanesOf(manager, 8);
  })();

  const rand = rng(0x5eed);
  for (let trial = 0; trial < 24; trial++) {
    const arrival = shuffle(items, rand);
    const manager = new RangeLayoutManager<Span>(8, 1);
    // Arrive one at a time, the way a provider sync or a scroll delivers them.
    for (let n = 1; n <= arrival.length; n++) {
      update(manager, arrival.slice(0, n), 8);
    }
    const lanes = lanesOf(manager, 8);
    assertCompact(lanes, items, `trial ${trial}`);
    assertEquals(
      [...lanes].sort(),
      [...canonical].sort(),
      `trial ${trial}: arrival order ${arrival.map((i) => i.id).join(",")} ` +
        `packed differently from the canonical layout`,
    );
  }
});

Deno.test("RangeLayoutManager: stays compact across random add/remove churn", () => {
  const pool = Array.from({ length: 12 }, (_, i) =>
    span(`e${i}`, i % 7, (i % 7) + (i % 4)),
  );
  const rand = rng(0xc0ffee);

  for (let trial = 0; trial < 40; trial++) {
    const manager = new RangeLayoutManager<Span>(8, 1);
    let live: Span[] = [];
    for (let step = 0; step < 20; step++) {
      const candidate = pool[Math.floor(rand() * pool.length)];
      live = live.some((i) => i.id === candidate.id)
        ? live.filter((i) => i.id !== candidate.id)
        : [...live, candidate];
      update(manager, live, 8);
      assertCompact(lanesOf(manager, 8), live, `trial ${trial} step ${step}`);
    }
  }
});

Deno.test("RangeLayout.Manager: the declarative API is compact too", () => {
  const manager = new RangeLayout.Manager<Span>({
    maxRows: 8,
    defaultVisibleRows: 1,
  });

  const trip = span("trip", 0, 4);
  manager.update([span("mon", 0, 0), span("tue", 1, 1), trip]);
  manager.update([trip]);

  const { visible, overflow } = manager.partition(1);
  assertEquals(
    visible.map((v) => v.item.id),
    ["trip"],
    "the multi-day span must return to the visible lane once nothing blocks it",
  );
  assertEquals(overflow.size, 0);
});
