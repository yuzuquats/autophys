/**
 * Tests for `RangeBasedFetcher`'s gap-fill decision — the one place the fetcher
 * chooses between "this is a scroll, fill the gap and keep one contiguous
 * coverage claim" and "this is a jump, fetch the window that was asked for".
 *
 * Bug shape: `fetchRange` assumed every uncovered request was a continuation of
 * the cached window, so it always fetched from the cache edge to the request.
 * That is right for a scroll — the gap is a viewport — and catastrophic for a
 * jump, where the gap is the distance between two places on the calendar. The
 * scroll strip is 16,777,200px wide with the origin at its centre, so jamming
 * the horizontal scrollbar to either end lands ~200 years out; the fetcher
 * turned a request for three weeks of 1826 into `sheets/batch-fetch
 * 1825-10-04 -> 2026-05-25`, which the server answers inside the 5s
 * `row-events/load` watchdog only when its cache is warm. Hence
 * `sheets/strip-edge-stays-on-axis` reading red on the first (cold) run of a
 * session and green on the warm re-run, with nothing in between changing.
 *
 * What is asserted here is a pair, and it has to stay a pair: contiguous
 * scrolling still gap-fills exactly as before (the tail only, unioned into the
 * coverage claim), and a jump fetches the padded window ONLY and replaces the
 * claim rather than unioning across the gap. The replace half is not cosmetic:
 * `fetchedRange` is a single interval that `RowHandle.isCoveredAt` reads as
 * truth, so a union across a 200-year gap would answer "we know about 1900" for
 * a year nobody fetched.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { DateTime, DateUnit, NaiveDate, Utc } from "@tento-chrono";

import { RangeBasedFetcher } from "../../range-based-fetcher.ts";

const MS_PER_DAY = 86_400_000;

function day(iso: string): NaiveDate {
  const [yr, mth, dayOfMonth] = iso.split("-").map(Number);
  return NaiveDate.fromYmd1Exp(yr, mth, dayOfMonth);
}

/** The `DateTime.Range<Utc>` every caller builds: `naiveRange.withTime().withTz(Utc)`. */
function span(startIso: string, endIso: string): DateTime.Range<Utc> {
  return new NaiveDate.Range(day(startIso), day(endIso)).withTime().withTz(Utc);
}

function text(range: DateTime.Range<Utc>): string {
  return `${range.start.date.toString()}..${range.end.date.toString()}`;
}

function widthDays(range: DateTime.Range<Utc>): number {
  return Math.round((range.end.mse - range.start.mse) / MS_PER_DAY);
}

/** The fetcher's public coverage claim, asserted to exist. */
function coverage(fetcher: RangeBasedFetcher<Utc>): string {
  const range = fetcher.fetchedRange;
  assert(range != null, "expected the fetcher to hold a coverage range");
  return text(range);
}

/** A fetcher that records every range its callback is actually asked for. */
function recording(): {
  fetcher: RangeBasedFetcher<Utc>;
  asked: DateTime.Range<Utc>[];
} {
  const asked: DateTime.Range<Utc>[] = [];
  const fetcher = new RangeBasedFetcher<Utc>(async (range) => {
    asked.push(range);
  });
  return { fetcher, asked };
}

Deno.test("first fetch with no cache is the ask plus padding on both sides", async () => {
  const { fetcher, asked } = recording();

  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));

  assertEquals(asked.map(text), ["2026-05-04..2026-07-06"]);
  assertEquals(coverage(fetcher), "2026-05-04..2026-07-06");
});

Deno.test("a contiguous scroll forward still fetches only the tail and unions coverage", async () => {
  const { fetcher, asked } = recording();
  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));

  // Steps just past the padded edge: the classic scroll the gap-fill exists for.
  await fetcher.fetchRange(span("2026-07-01", "2026-07-08"));

  assertEquals(asked.map(text), [
    "2026-05-04..2026-07-06",
    // From the cache edge, not from the request — the tail only.
    "2026-07-06..2026-08-05",
  ]);
  assertEquals(coverage(fetcher), "2026-05-04..2026-08-05");
});

Deno.test("a scroll that overshoots the cache by weeks, still under budget, gap-fills", async () => {
  const { fetcher, asked } = recording();
  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));

  // Cache ends 2026-07-06; this asks 41 days past it. The budget for a 7-day
  // ask with 28-day padding is 2 x 63 = 126 days, so this is still a scroll.
  await fetcher.fetchRange(span("2026-08-16", "2026-08-23"));

  assertEquals(asked.map(text)[1], "2026-07-06..2026-09-20");
  assertEquals(coverage(fetcher), "2026-05-04..2026-09-20");
});

Deno.test("a contiguous scroll backward still fetches only the head", async () => {
  const { fetcher, asked } = recording();
  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));

  await fetcher.fetchRange(span("2026-04-20", "2026-04-27"));

  assertEquals(asked.map(text)[1], "2026-03-23..2026-05-04");
  assertEquals(coverage(fetcher), "2026-03-23..2026-07-06");
});

Deno.test("a request straddling the cache on both sides is not a jump", async () => {
  const { fetcher, asked } = recording();
  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));

  // Case 3: the ask contains the cached window. There is no gap either side.
  await fetcher.fetchRange(span("2026-04-01", "2026-09-01"));

  assertEquals(asked.map(text)[1], "2026-03-04..2026-09-29");
  assertEquals(coverage(fetcher), "2026-03-04..2026-09-29");
});

Deno.test("the right strip-edge jam fetches the window, not the two centuries to it", async () => {
  const { fetcher, asked } = recording();
  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));

  // What `scrollLeft = scrollWidth` produces: a week column ~200 years out.
  await fetcher.fetchRange(span("2227-01-04", "2227-01-11"));

  assertEquals(text(asked[1]), "2226-12-07..2227-02-08");
  assertEquals(widthDays(asked[1]), 63);
  // The coverage claim is the new window ALONE. Unioning would assert coverage
  // of every day from 2026 to 2227 without having asked for any of it.
  assertEquals(coverage(fetcher), "2226-12-07..2227-02-08");
});

Deno.test("the left strip-edge jam fetches the window, not the two centuries to it", async () => {
  const { fetcher, asked } = recording();
  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));

  // What `scrollLeft = 0` produces — the exact shape of the red run:
  // `row-events/load 1826-01-02 -> 1826-01-29` behind a 200-year batch fetch.
  await fetcher.fetchRange(span("1826-01-02", "1826-01-29"));

  assertEquals(text(asked[1]), "1825-12-05..1826-02-26");
  // A bound, not an equality: `mse` arithmetic on proleptic-Gregorian dates two
  // centuries before the epoch is a day off the calendar difference (82 vs 83),
  // which is a chrono question and not this one. The claim under test is
  // "weeks, not centuries", and the exact window is pinned above.
  assert(widthDays(asked[1]) < 100, "the jam fetched a window, not the axis");
  assertEquals(coverage(fetcher), "1825-12-05..1826-02-26");
});

Deno.test("after a jump the abandoned gap is not claimed as covered", async () => {
  const { fetcher, asked } = recording();
  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));
  await fetcher.fetchRange(span("2227-01-04", "2227-01-11"));

  // A date in the middle of the range the old code would have gap-filled. If
  // coverage had been unioned across the gap this resolves as cached and the
  // cells never arrive — the silent-empty-calendar half of the same defect.
  await fetcher.fetchRange(span("2120-03-01", "2120-03-08"));

  assertEquals(asked.length, 3);
  assertEquals(text(asked[2]), "2120-02-02..2120-04-05");
});

Deno.test("scrolling on from a jump gap-fills again from the new window", async () => {
  const { fetcher, asked } = recording();
  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));
  await fetcher.fetchRange(span("2227-01-04", "2227-01-11"));

  // Cache is now 2226-12-07..2227-02-08. A normal scroll on from there behaves
  // exactly as it does anywhere else — the jump is not a mode, it is one call.
  await fetcher.fetchRange(span("2227-02-15", "2227-02-22"));

  assertEquals(asked.length, 3);
  assertEquals(text(asked[2]), "2227-02-08..2227-03-22");
  assertEquals(coverage(fetcher), "2226-12-07..2227-03-22");
});

Deno.test("the budget is a boundary, not a slope: at it fills, one day past it jumps", async () => {
  // Zero padding makes the arithmetic exact: the fresh window is the 10-day ask
  // itself, so the budget is GAP_FILL_WINDOW_BUDGET x 10 = 20 days.
  assertEquals(RangeBasedFetcher.GAP_FILL_WINDOW_BUDGET, 2);
  const none = DateUnit.days(0);

  const atBudget = recording();
  await atBudget.fetcher.fetchRange(span("2026-06-01", "2026-06-11"), none);
  // Cache ends 2026-06-11; the ask starts 20 days later, exactly the budget.
  await atBudget.fetcher.fetchRange(span("2026-07-01", "2026-07-11"), none);
  assertEquals(atBudget.asked.map(text)[1], "2026-06-11..2026-07-11");

  const pastBudget = recording();
  await pastBudget.fetcher.fetchRange(span("2026-06-01", "2026-06-11"), none);
  // One day further out: 21 days of gap for a 10-day ask.
  await pastBudget.fetcher.fetchRange(span("2026-07-02", "2026-07-12"), none);
  assertEquals(pastBudget.asked.map(text)[1], "2026-07-02..2026-07-12");
});

Deno.test("a fully covered request still short-circuits", async () => {
  const { fetcher, asked } = recording();
  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));

  assertEquals(await fetcher.fetchRange(span("2026-06-10", "2026-06-17")), null);
  assertEquals(asked.length, 1);
});
