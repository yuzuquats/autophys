/**
 * Render-path tests for `TimelineLayoutManager.computeLayout`.
 *
 * `range-layout`'s own tests pin the packer. This pins the layer the calendar
 * all-day strip actually calls: `AllDayEventsSheetPlugin.fixedChildrenForRow`
 * hands `computeLayout` the full set of events in the viewport on every render
 * and paints `partition.visible` as bars and `partition.overflow` as the
 * "+N more" dots.
 *
 * That path used to diff incrementally — drop what vanished or moved, re-offer
 * the rest — on top of a packer that caches a lane per id and never revisits
 * it. So an event displaced below the visible lane stayed there after the
 * event that displaced it was deleted, and the strip drew overflow dots above
 * an empty lane. The bug was only reachable through this seam: the packer in
 * isolation looks fine if you only ever add.
 */

import { assert, assertEquals } from "jsr:@std/assert";

import { TimelineLayoutManager } from "./timeline-layout-manager.ts";

interface Span {
  id: string;
  range: { start: number; end: number };
}

const span = (id: string, start: number, end: number): Span => ({
  id,
  range: { start, end },
});

function makeManager(): TimelineLayoutManager<Span, unknown, string> {
  return new TimelineLayoutManager<Span, unknown, string>({
    maxRows: 8,
    // The all-day strip is collapsed to a single lane by default, which is
    // what makes a displaced event invisible rather than merely lower down.
    defaultVisibleRows: 1,
    spanIdForItem: (item) => `span_${item.id}`,
    overflowIdForRange: (key) => `more_${key}`,
  });
}

const drawn = (
  layout: { visible: Array<{ item: Span; row: number }> },
): string[] => layout.visible.map((v) => v.item.id);

Deno.test("computeLayout: the survivor reclaims the visible lane when its blocker is deleted", () => {
  const manager = makeManager();
  const blocker = span("blocker", 0, 0);
  const survivor = span("survivor", 0, 0);

  const before = manager.computeLayout([blocker, survivor]);
  assertEquals(
    before.visible.length,
    1,
    "precondition: one visible lane means exactly one of the two is drawn",
  );
  assert(before.overflow.size > 0, "precondition: the other collapses to overflow");

  const held = before.visible[0].item.id;
  const hidden = held === "blocker" ? survivor : blocker;
  const remaining = held === "blocker" ? [survivor] : [blocker];

  const after = manager.computeLayout(remaining);
  assertEquals(
    drawn(after),
    [hidden.id],
    "the remaining event must be drawn in the lane the delete freed",
  );
  assertEquals(
    after.overflow.size,
    0,
    "nothing may stay collapsed with a single event left in the row",
  );
});

Deno.test("computeLayout: a multi-day span is not displaced by a single-day event", () => {
  const manager = makeManager();
  // The single-day event is offered FIRST — under the defect it took the lane
  // by arriving first and the span covering it became overflow dots.
  const layout = manager.computeLayout([span("one-day", 2, 2), span("trip", 0, 4)]);

  assertEquals(
    drawn(layout),
    ["trip"],
    "the longer span takes the visible lane",
  );
  assert(
    layout.overflow.size > 0,
    "the single-day event it covers is what collapses",
  );
});

Deno.test("computeLayout: the same events lay out the same however they arrive", () => {
  const items = [
    span("trip", 0, 4),
    span("mon", 0, 0),
    span("weekend", 5, 6),
    span("long", 2, 6),
    span("thu", 3, 3),
  ];

  const canonical = (() => {
    const m = makeManager();
    const layout = m.computeLayout(items);
    return layout.visible.map((v) => `${v.item.id}@${v.row}`).sort();
  })();

  // Arrive one at a time, the way a provider sync or a scroll delivers them,
  // in a few different orders.
  for (let rotate = 0; rotate < items.length; rotate++) {
    const arrival = [...items.slice(rotate), ...items.slice(0, rotate)];
    const m = makeManager();
    for (let n = 1; n <= arrival.length; n++) m.computeLayout(arrival.slice(0, n));
    const layout = m.computeLayout(items);
    assertEquals(
      layout.visible.map((v) => `${v.item.id}@${v.row}`).sort(),
      canonical,
      `arrival order rotated by ${rotate} produced a different layout`,
    );
  }
});
