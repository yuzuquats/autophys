/**
 * A pooled day column that `bind` parks (its fragment falls outside the hours
 * window: no positioning) is hidden with `display: none`, and it must not keep
 * the partial edges of the fragment it showed before. Consumers read the
 * attribute without checking display: test selectors such as
 * `std-calendar-column[partial-top]` (ux-test calendar/tz-tooltip-shadow-no-backdrop
 * matched a hidden column first, review L30 F6), and the days strip's
 * occlusion, which suppresses moreAbove / moreBelow by it.
 *
 * A column is parked on two paths: `CalendarColumn.bind` when the fragment has
 * no positioning, and `CalendarDay.bindFragment` when the day has no fragment
 * for that slot (the `$after` column of every day without a zone split, review
 * L31 F1). Both go through `CalendarColumn.park`.
 *
 * Under Deno the element is a stub, so this binds a host double that records
 * attributes and styles, built on `CalendarColumn.prototype`.
 */
import "../../deno-noop.ts";

import { assert, assertEquals } from "jsr:@std/assert";
import { DateFragment } from "@tento-chrono";
import { CalendarColumn } from "./calendar-column.ts";
import { CalendarDay } from "./calendar-day.ts";

type Positioning = ReturnType<DateFragment.Windowed["getPositioning"]>;

function host() {
  const attrs = new Set<string>();
  const style: Record<string, string> = {};
  const parts = new Map<string, { textContent: string }>();
  return Object.assign(
    Object.create(CalendarColumn.prototype) as CalendarColumn,
    {
      attrs,
      style,
      $(id: string) {
        return parts.get(id) ?? parts.set(id, { textContent: "" }).get(id)!;
      },
      assignStyles(s: Record<string, string>) {
        Object.assign(style, s);
      },
      toggleAttribute(name: string, force?: boolean) {
        const on = force ?? !attrs.has(name);
        if (on) attrs.add(name);
        else attrs.delete(name);
        return on;
      },
    },
  );
}

function windowed(positioning: Positioning): DateFragment.Windowed {
  return {
    fragment: { tzabbr: "PDT" },
    windowedStartHrs: 0,
    getPositioning: () => positioning,
  } as unknown as DateFragment.Windowed;
}

function split(partialTop: boolean, partialBottom: boolean): Positioning {
  return {
    linesOffsetPx: 0,
    transformY: 0,
    height: 480,
    partialTop,
    partialBottom,
  } as unknown as Positioning;
}

const bind = (h: ReturnType<typeof host>, w: DateFragment.Windowed) =>
  h.bind(w);

Deno.test("calendar column bind: a shown split column carries its partial edges", () => {
  const h = host();
  assert(bind(h, windowed(split(true, true))));
  assertEquals(h.style.display, "");
  assertEquals([...h.attrs].sort(), ["partial-bottom", "partial-top"]);
});

Deno.test("calendar column bind: parking a pooled column clears the partial edges it showed", () => {
  const h = host();
  bind(h, windowed(split(true, true)));
  assertEquals(bind(h, windowed(null)), false);
  assertEquals(h.style.display, "none");
  assertEquals([...h.attrs], [], "a hidden column still carries partial edges");
});

Deno.test("calendar column bind: rebinding a parked column to a whole day keeps no edge", () => {
  const h = host();
  bind(h, windowed(split(true, false)));
  bind(h, windowed(null));
  assert(bind(h, windowed(split(false, false))));
  assertEquals([...h.attrs], []);
});

Deno.test("calendar day bindFragment: a slot with no fragment parks its column without partial edges", () => {
  const h = host();
  bind(h, windowed(split(true, false)));
  const day = {} as CalendarDay;
  assertEquals(CalendarDay.prototype.bindFragment.call(day, h, null), false);
  assertEquals(h.style.display, "none");
  assertEquals(
    [...h.attrs],
    [],
    "a hidden $after column still carries partial edges",
  );
});
