/**
 * # A viewport is somewhere on the calendar, or it is a witness
 *
 * ## Invariants tested
 * - The four ways off the axis, each a shape R19 actually produced: a
 *   non-finite year, a fractional year, a range that runs backwards, and a
 *   range further than the tolerance from today
 * - The tolerance is INCLUSIVE at both edges and symmetric about today — a
 *   deep-but-legitimate scroll (a year view 242 columns back really is 242
 *   years back) stays on the axis, so the guard cannot blank a real viewport
 * - **The defect itself**: a rendered strip of day-space indices resolved
 *   through a year anchor lands ~24 centuries out and is refused; the same
 *   strip resolved through the day anchor is accepted
 * - The tolerance is a parameter, not a constant read from inside — passing 0
 *   admits only today's year, and the shipped
 *   {@link ViewportRange.YEARS_TOLERANCE} is asserted separately
 *
 * ## Where the table lives
 * Every row is DATA, in `viewport-range.cases.json`, driven by the house
 * fixture runner: a case declares `today` + `tolerance` and a list of probes,
 * each probe a `[start, end]` pair of years and the verdict it must get. JSON
 * carries no `NaN` / `±Infinity`, so those ride the same string sentinels
 * `cell-height.cases.json` uses, decoded at the boundary by {@link yearOf}.
 *
 * ## Notes
 * - No DOM and no clock: `viewport-range.ts` is pure by construction, and
 *   `today` is a parameter precisely so the test owns the calendar.
 * - The call site (`sheet.ts` `rendered()`) passes `NaiveDate`s, which satisfy
 *   `HasYear` structurally; nothing here needs chrono to exercise the law.
 */
import { assert, assertEquals } from "jsr:@std/assert";

import { Fixtures } from "../../../tento-core-js/tests/fixture-runner.deno.ts";
import { ViewportRange } from "./viewport-range.ts";

/** JSON has no literal for these three, so the fixture spells them. */
type YearCell = number | "NaN" | "Infinity" | "-Infinity";

function yearOf(value: YearCell): number {
  switch (value) {
    case "NaN":
      return NaN;
    case "Infinity":
      return Number.POSITIVE_INFINITY;
    case "-Infinity":
      return Number.NEGATIVE_INFINITY;
    default:
      return value;
  }
}

interface Probe {
  start: YearCell;
  end: YearCell;
}

interface Input {
  today: number;
  tolerance: number;
  probes: Probe[];
}

interface Expected {
  answers: boolean[];
}

Deno.test("the shipped tolerance is 200 years — far past any real scroll, far short of a mis-resolution", () => {
  assertEquals(ViewportRange.YEARS_TOLERANCE, 200);
  // The characteristic mis-resolution multiplies the distance by the unit
  // ratio, so the smallest one that matters (day read as year, 365x) clears
  // the tolerance from a single column of scroll.
  assert(365 > ViewportRange.YEARS_TOLERANCE / 1);
});

Fixtures.load<Input, Expected>(
  new URL(".", import.meta.url).pathname,
  "viewport-range",
).run(
  (input) => ({
    answers: input.probes.map((probe) =>
      ViewportRange.onAxis(
        { start: { yr: yearOf(probe.start) }, end: { yr: yearOf(probe.end) } },
        { yr: input.today },
        input.tolerance,
      )
    ),
  }),
  (result, expected, caseName) => assertEquals(result, expected, caseName),
);
