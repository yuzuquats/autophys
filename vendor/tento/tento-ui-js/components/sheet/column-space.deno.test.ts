/**
 * # A column mapper, as an index space — and where its axis ends
 *
 * ## Invariants tested
 * - **The reach is on the axis at both ends, for every mapper type.** The band
 *   `ColumnSpace.of(mapper, today).reach()` reports is resolved BACK through
 *   the same mapper, into the same span shape `Sheet.rendered()` builds
 *   (`toDatesInclusive()` — see {@link strip}), and judged by
 *   {@link ViewportRange.onAxis} against the same
 *   {@link ViewportRange.YEARS_TOLERANCE} the `witness/viewport-range` tripwire
 *   uses. Two readers of one constant that must never disagree about where the
 *   calendar ends: if they could, R20's clamp would either strand the viewport
 *   short of a legal column or leave a witness reachable by scrolling — and
 *   until F6 they did, because both this table and `reachOf` asked about the
 *   day a column STARTS on while the witness asks about `pd.end`.
 * - **One index past the band is OFF the axis** — the band is the widest one
 *   that stays on, not a conservative interior.
 * - **The band contains the anchor** (index 0) for a mapper anchored anywhere
 *   near today, which is the precondition `ScrollWindow` enforces before it
 *   will apply the band at all.
 * - **A week's band is ~52× narrower than a day's, a year's ~365×** — the
 *   reach is derived through the mapper, not divided out of a column width, so
 *   granularity is reflected exactly rather than approximately.
 * - The space is stable per mapper (`of(m) === of(m)`, R21's reference
 *   identity) even though `of` now takes a clock, and the clock the LAST call
 *   handed in is the one `reach()` answers against.
 *
 * ## Where the table lives
 * Every row is DATA, in `column-space.cases.json`: a case fixes an anchor date,
 * a mapper type and `today`, and declares the band's two indices plus the dates
 * they resolve to. The identity and clock-refresh laws are inline below —
 * they are about object lifetime, which a table cannot say.
 *
 * ## Notes
 * - No DOM and no scroller: `ColumnSpace` is a pure adapter over
 *   `ColumnIndex.Mapper`, and `today` is a parameter precisely so the test owns
 *   the calendar.
 */
import { assert, assertEquals } from "jsr:@std/assert";

import { NaiveDate, PartialDate, TimezoneRegion } from "@tento-chrono";

import { Fixtures } from "../../../tento-core-js/tests/fixture-runner.deno.ts";
import { ColumnIndex } from "./column-index.ts";
import { ColumnSpace } from "./column-space.ts";
import { ViewportRange } from "./viewport-range.ts";
import { ScrollWindow } from "@tento-scroll/engine/scroll-window";

const TZ = TimezoneRegion.UTC;

Deno.test("week edge re-anchor padding cannot paint outside the date-axis reach", () => {
  const today = NaiveDate.parse("2026-09-09");
  const mapper = new ColumnIndex.Mapper.Default(
    PartialDate.fromDate(today).toType("week"),
    TZ,
  );
  const reach = ColumnSpace.of(mapper, today).reach();
  assert(reach.kind === "bounded");
  const width = 300;
  const window = new ScrollWindow({
    widthForIndex: () => width,
    onOffsetChanged: () => {},
    reachableIndices: () => reach,
  });
  window.extendToIdxRange({ start: reach.min - 2, end: reach.max + 2 });
  for (const edge of [reach.min, reach.max]) {
    const rendered = window.findIndiciesFromOffsetRange({
      start: (edge - 2) * width,
      end: (edge + 2) * width,
    });
    assert(rendered.start >= reach.min && rendered.end <= reach.max);
    assert(ViewportRange.onAxis(
      strip(mapper, rendered.start, rendered.end),
      today,
      ViewportRange.YEARS_TOLERANCE,
    ));
  }
  assertEquals([window.minIndex, window.maxIndex], [reach.min - 2, reach.max + 2]);
});

type MapperType = "day" | "week" | "month" | "year";

interface Scenario {
  /** The mapper's anchor — index 0 resolves to the column containing it. */
  anchor: string;
  type: MapperType;
  today: string;
}

interface Summary {
  kind: "unbounded" | "bounded";
  min: number;
  max: number;
  /** The dates the band's two indices resolve to, through the same mapper. */
  minDate: string;
  maxDate: string;
  /** {@link ViewportRange.onAxis} over those two dates. Always true. */
  onAxis: boolean;
  /**
   * The column one further out, each end, judged on its own. Both always
   * false — together with `onAxis` that is what makes the band MAXIMAL rather
   * than merely safe: one column wider at either end is off the calendar.
   */
  onAxisBelow: boolean;
  onAxisAbove: boolean;
  /** The band contains index 0, so `ScrollWindow` will enforce it. */
  containsAnchor: boolean;
  /** `max - min` — how many columns the axis is, at this granularity. */
  span: number;
}

function mapperOf(scenario: Scenario): ColumnIndex.Mapper {
  return new ColumnIndex.Mapper.Default(
    PartialDate.fromDate(NaiveDate.parse(scenario.anchor)).toType(scenario.type),
    TZ,
  );
}

/** The date index `i` renders, through `mapper` — the sheet's own resolution. */
function dateAt(mapper: ColumnIndex.Mapper, index: number): NaiveDate {
  return mapper
    .resolveKeyToDefault(ColumnIndex.Key.fromIndex(index), "lower")
    .pd.start;
}

/**
 * The span a strip of columns `[lo, hi]` covers, built the way `Sheet.rendered()`
 * builds it — `Range.toDatesInclusive()`, which is `[lo.pd.start, hi.pd.end]`.
 *
 * The `end` half is what this file used to get wrong: it judged the band by the
 * date its last column STARTS on, and the witness judges it by `pd.end`, the
 * exclusive boundary one unit later. Two readers of one constant that agreed
 * about `YEARS_TOLERANCE` and disagreed about the span it applies to, which is
 * how a band whose max column ends on 1 January of `today + 201` passed here
 * and fired `witness/viewport-range` in the browser (F6).
 */
function strip(
  mapper: ColumnIndex.Mapper,
  lo: number,
  hi: number,
): NaiveDate.Range {
  return ColumnIndex.Key.Resolved.Default.Range
    .fromIndexSinceAnchorRange({ start: lo, end: hi }, mapper)
    .toDatesInclusive();
}

function summarize(scenario: Scenario): Summary {
  const mapper = mapperOf(scenario);
  const today = NaiveDate.parse(scenario.today);
  const reach = ColumnSpace.of(mapper, today).reach();
  if (reach.kind === "unbounded") {
    return {
      kind: "unbounded",
      min: 0,
      max: 0,
      minDate: "",
      maxDate: "",
      onAxis: false,
      onAxisBelow: false,
      onAxisAbove: false,
      containsAnchor: false,
      span: 0,
    };
  }
  const at = (i: number) => dateAt(mapper, i);
  const onAxis = (lo: number, hi: number) =>
    ViewportRange.onAxis(
      strip(mapper, lo, hi),
      today,
      ViewportRange.YEARS_TOLERANCE,
    );
  return {
    kind: "bounded",
    min: reach.min,
    max: reach.max,
    minDate: at(reach.min).toString(),
    maxDate: at(reach.max).toString(),
    onAxis: onAxis(reach.min, reach.max),
    onAxisBelow: onAxis(reach.min - 1, reach.min - 1),
    onAxisAbove: onAxis(reach.max + 1, reach.max + 1),
    containsAnchor: reach.min <= 0 && reach.max >= 0,
    span: reach.max - reach.min,
  };
}

Fixtures.load<Scenario, Partial<Summary>>(
  new URL(".", import.meta.url).pathname,
  "column-space",
).run(summarize, (result, expected, caseName) => {
  // Cases assert only the fields they declare, so a row can pin the span
  // ratio between granularities without transcribing every date.
  const filtered: Partial<Summary> = {};
  for (const key of Object.keys(expected) as (keyof Summary)[]) {
    (filtered as Record<string, unknown>)[key] = result[key];
  }
  assertEquals(filtered, expected, caseName);
});

Deno.test("the space is one object per mapper, clock or no clock", () => {
  const mapper = mapperOf({ anchor: "2026-09-03", type: "day", today: "2026-09-03" });
  const a = ColumnSpace.of(mapper, NaiveDate.parse("2026-09-03"));
  const b = ColumnSpace.of(mapper, NaiveDate.parse("2027-09-03"));
  // R21's whole comparison is `space.key` by reference, and the engine reads a
  // rebind that returns a NEW space as a change of index meaning. Taking a
  // clock must not make one.
  assert(a === b, "of() minted a second space for the same mapper");
  assertEquals(a.key, mapper);
});

Deno.test("reach() answers against the clock the LAST bind handed in", () => {
  const mapper = mapperOf({ anchor: "2026-09-03", type: "year", today: "2026-09-03" });
  const first = ColumnSpace.of(mapper, NaiveDate.parse("2026-09-03")).reach();
  // A year mapper anchored on 2026 puts index 0 at 2026, so the band is
  // [−200, +199] — 200 back, and 199 forward because the year `today + 200`
  // ENDS on 1 January of `today + 201`. What matters here is that a 1000-year
  // jump in `today` moves BOTH ends by exactly 1000: nothing subtler would
  // prove the refresh reached the closure.
  const later = ColumnSpace.of(mapper, NaiveDate.parse("3026-09-03")).reach();
  assert(first.kind === "bounded" && later.kind === "bounded");
  assertEquals(later.min - first.min, 1000);
  assertEquals(later.max - first.max, 1000);
});

Deno.test("a band far from the anchor is stated, and ScrollWindow is the one that refuses it", () => {
  // The adapter's job is to say where the calendar is, not to decide what a
  // scroller can do about it — that split is why the anchor-containment guard
  // lives in `ScrollWindow.reachBand` and not here. A sheet anchored a
  // millennium from today produces a band entirely on one side of index 0.
  const mapper = mapperOf({ anchor: "3026-09-03", type: "year", today: "3026-09-03" });
  const reach = ColumnSpace.of(mapper, NaiveDate.parse("2026-09-03")).reach();
  assert(reach.kind === "bounded");
  assert(reach.max < 0, `expected a band left of the anchor, got ${JSON.stringify(reach)}`);
  // 3026 − 2226 = 800 columns left of the anchor, less the one the exclusive
  // `pd.end` costs at the high end (the year 2226 ends in 2227).
  assertEquals(reach.max, -801);
});

Deno.test("a backwards or non-finite band is no band at all", () => {
  // `Reach.bounded` is the one place that decision is made, and it answers
  // UNBOUNDED rather than a band the window would strand itself inside.
  assertEquals(ScrollWindow.Reach.bounded(10, 3), ScrollWindow.Reach.UNBOUNDED);
  assertEquals(ScrollWindow.Reach.bounded(NaN, 3), ScrollWindow.Reach.UNBOUNDED);
  assertEquals(ScrollWindow.Reach.bounded(-Infinity, Infinity), ScrollWindow.Reach.UNBOUNDED);
  assertEquals(ScrollWindow.Reach.bounded(-2, 5), { kind: "bounded", min: -2, max: 5 });
});
