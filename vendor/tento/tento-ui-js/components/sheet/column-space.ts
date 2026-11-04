import { NaiveDate, PartialDate } from "@tento-chrono";

import { ColumnIndex } from "./column-index";
import { ViewportRange } from "./viewport-range";
import { ScrollEngine } from "@tento-scroll/engine/scroll-engine";
import { ScrollWindow } from "@tento-scroll/engine/scroll-window";

/**
 * # A column mapper, as an index space
 *
 * A column index is a bare `number`, and what it MEANS is a property of the
 * mapper it is read through: index −2422 is 2422 days ago under a day mapper
 * and the year −396 under a year mapper. `ScrollEngine` needs that meaning
 * whenever a rebind might change it — the anchor column under the viewport's
 * left edge has to survive a flip — but it must not learn about dates to get
 * it. {@link ScrollEngine.IndexSpace} is the seam: an identity to compare, and
 * a way to carry one column's CONTENT from one space into another. This file
 * is the adapter that presents a `ColumnIndex.Mapper` as one.
 *
 * The space's `key` IS the mapper object, because that is exactly the identity
 * the engine has to track: a sheet flip, a timescale change, and the Personal
 * Timezones toggle each hand the layout a new mapper, and each is a change of
 * index meaning; anything that reuses a mapper is not. Reference identity is
 * therefore the whole comparison, and the adapters are memoized per mapper so
 * `of(m) === of(m)` — a fresh adapter for the same mapper must not read as a
 * new space.
 *
 * ## What R21 retired
 *
 * This file used to hold a `ColumnSpace` CLASS with three mapper fields, a
 * mirror of engine state the caller kept so it could tell the engine how to
 * carry the anchor across:
 *
 * ```text
 *   CURRENT   what an index emitted RIGHT NOW means
 *   WINDOW    the space the engine's live offset map was built in
 *   BOUND     what the last full `bind` installed
 * ```
 *
 * WINDOW existed only because `ScrollEngine.bindLayout` took a TRANSITION —
 * "relative to whatever window you had, here is how to reach the incoming
 * space" — and only a caller that knew the engine's previous state could phrase
 * one. It is now the engine's own field, updated by every layout bind, so the
 * mirror and the `boolean` return that kept it in step are both gone. BOUND
 * asked "does this pass need a width reflow?", which is "did the space change
 * at unchanged geometry?" — also a question the engine can now answer, and it
 * reflows on its own account. CURRENT never belonged here at all: it is
 * `SheetLayout`'s own mapper field, assigned before the engine call so that
 * every index in the synchronous `layout-changed` emit resolves in the incoming
 * space (R19 — the ordering survives R21 unchanged, only its owner is plainer).
 *
 * What remains is the translation itself, which was always the interesting
 * part: the date the outgoing column renders, looked up in the incoming mapper.
 */
export namespace ColumnSpace {
  /**
   * One adapter per mapper, so the engine's reference comparison means what it
   * reads as. Weak because a mapper outlives nothing here — when the viewmodel
   * drops it, its adapter goes with it.
   */
  const ADAPTERS = new WeakMap<ColumnIndex.Mapper, Adapter>();

  /**
   * One space per mapper plus the clock it answers `reach()` against.
   *
   * The space object has to be stable — the engine compares spaces by reference
   * — but the reach is a function of TODAY, and a mapper can outlive a day. So
   * the identity is fixed and the clock is a field: {@link of} refreshes it on
   * every call (each bind hands one in), and `reach()` reads it live.
   * `cached` memoizes the two `indexOfKey` walks per calendar year, because the
   * band is asked for on every scroll event and changes 200 years at a time.
   */
  interface Adapter {
    today: NaiveDate;
    cached: Option<{ yr: number; reach: ScrollWindow.Reach }>;
    readonly space: ScrollEngine.IndexSpace<ColumnIndex.Key.Resolved.Default>;
  }

  /**
   * The index band that resolves to a real calendar year, per
   * {@link ViewportRange.YEARS_TOLERANCE} — the SAME constant the
   * `witness/viewport-range` tripwire judges a rendered strip against, read
   * here so the two can never disagree about where the axis ends. The witness
   * stays: after this rung it is unreachable by scrolling, and still reachable
   * by a bind that mints indices in one space and resolves them in another,
   * which is the case it was built for (R19/F3).
   *
   * The ends start as the column containing `today − N`'s first day and the one
   * containing `today + N`'s last, resolved THROUGH the mapper rather than
   * divided out of a column width — a month's columns are not a constant number
   * of days, and the arithmetic that assumes they are is what R19 was about.
   *
   * Then each end is pulled inward until the column it names is itself on the
   * axis, judged by {@link ViewportRange.onAxis} over that column's own span
   * — the same call, on the same span shape, that `Sheet.rendered()` makes on
   * the rendered strip. Containing an on-axis day is not the same as BEING an
   * on-axis column, and it fails at BOTH ends, for different reasons. At the
   * low end a week column is dated by the day it STARTS, and the week holding
   * 1 January of `today − 200` starts in December of the year before. At the
   * high end the culprit is `pd.end`, the EXCLUSIVE boundary one unit past the
   * column: the last day, week, month and year of `today + 200` all end on
   * 1 January of `today + 201`, so EVERY granularity — not just week — carried
   * one column of overhang there. Asking the witness's own predicate is what
   * makes the two ends symmetric; re-deriving it from `pd.start.yr` alone is
   * what made them not (F6).
   *
   * The result is the WIDEST on-axis band, not a conservative interior: the
   * step only ever runs while the current end is off the axis, so it stops on
   * the first column that is on it. {@link REACH_ALIGN_STEPS} bounds the walk;
   * a mapper whose columns are so coarse that it does not converge has no
   * enforceable band and says so, which is the same answer as a sheet anchored
   * off the calendar and is handled the same way downstream.
   */
  function reachOf(
    mapper: ColumnIndex.Mapper,
    today: NaiveDate,
  ): ScrollWindow.Reach {
    const at0 = mapper.resolveKeyToDefault(ColumnIndex.Key.fromIndex(0), "lower");
    const pd = at0.pd;
    const indexOn = (date: NaiveDate): number =>
      mapper.indexOfKey(
        ColumnIndex.Key.fromPartialTz(
          PartialDate.fromDateAndType(pd.type, date, pd.weekStart),
          at0.tz,
        ),
      ).index;
    const years = ViewportRange.YEARS_TOLERANCE;
    // The SAME predicate the witness runs, over the SAME span shape
    // (`Range.toDatesInclusive()` is `[start.pd.start, end.pd.end]`), rather
    // than a re-derivation of it. A hand-rolled `|pd.start.yr - today.yr|`
    // reads only the day a column BEGINS, and `pd.end` is the exclusive
    // boundary one unit later — so the band's last column ended in
    // `today + years + 1` at EVERY granularity, and a strip parked on it
    // tripped the very witness this reach exists to make unreachable
    // (F6 / `strip-edge-stays-on-axis`: week 2226-12-31..2227-01-07).
    const onAxis = (index: number): boolean => {
      const column = mapper
        .resolveKeyToDefault(ColumnIndex.Key.fromIndex(index), "lower").pd;
      return ViewportRange.onAxis(
        { start: column.start, end: column.end },
        today,
        years,
      );
    };
    const alignInward = (from: number, step: number): Option<number> => {
      let index = from;
      for (let i = 0; i <= REACH_ALIGN_STEPS; i++) {
        if (onAxis(index)) return index;
        index += step;
      }
      return null;
    };
    const min = alignInward(indexOn(NaiveDate.fromYmd1Exp(today.yr - years, 1, 1)), 1);
    const max = alignInward(indexOn(NaiveDate.fromYmd1Exp(today.yr + years, 12, 31)), -1);
    if (min == null || max == null) return ScrollWindow.Reach.UNBOUNDED;
    return ScrollWindow.Reach.bounded(min, max);
  }

  /**
   * How far {@link reachOf} may pull an end inward before giving up.
   *
   * One column of slop is all any granularity should need — the misalignment is
   * "this column started in the previous year", which is one column's width.
   * The week case needs three, because a week `PartialDate` is carried as
   * (isoYear, isoWno) and reconstructing a start date from that near a year
   * boundary can land a fortnight early. Fifty-two is a year of weeks: past it
   * the mapper is not misaligned, it is answering about a different calendar.
   */
  const REACH_ALIGN_STEPS = 52;

  /**
   * The index space `mapper` defines. Stable per mapper: two calls with the
   * same mapper return the same space, and the engine compares spaces by
   * reference.
   */
  export function of(
    mapper: ColumnIndex.Mapper,
    today: NaiveDate,
  ): ScrollEngine.IndexSpace<ColumnIndex.Key.Resolved.Default> {
    const memoized = ADAPTERS.get(mapper);
    if (memoized != null) {
      memoized.today = today;
      return memoized.space;
    }
    // The space closes over its own adapter, so `reach()` reads the clock the
    // LAST bind handed in rather than the one this call happened to see. Legal
    // by ordering, not by trick: the arrow bodies run long after the literal
    // finishes initializing.
    const adapter: Adapter = {
      today,
      cached: null,
      space: {
        key: mapper,
        // A column's content is the DATE it renders — the one thing two mappers
        // can both talk about. Index meaning is per-mapper (each sheet's index 0
        // is its own anchor date, and sub-day sheets step in hours where day
        // sheets step in days), so an index-preserving re-anchor lands arbitrarily
        // far from the content on screen: hour-index −109 ⇒ day-index −109, 109
        // days into the past. Going through the date is what makes the flip land
        // on the column the user was looking at.
        keyAt: (index) =>
          mapper.resolveKeyToDefault(ColumnIndex.Key.fromIndex(index), "lower"),
        indexOf: (resolved) =>
          mapper.indexOfKey(
            ColumnIndex.Key.fromPartialTz(resolved.pd, resolved.tz),
          ).index,
        reach: () => {
          const yr = adapter.today.yr;
          if (adapter.cached?.yr === yr) return adapter.cached.reach;
          const reach = reachOf(mapper, adapter.today);
          adapter.cached = { yr, reach };
          return reach;
        },
      },
    };
    ADAPTERS.set(mapper, adapter);
    return adapter.space;
  }
}
