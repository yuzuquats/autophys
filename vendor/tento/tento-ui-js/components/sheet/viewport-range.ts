/**
 * # A viewport is somewhere on the calendar, or it is a witness
 *
 * Everything downstream of `Sheet.rendered()` — the cell fetcher, the rows
 * prefetch, the header — takes the rendered column range on trust and asks the
 * server for it. That trust is only warranted while the indices behind the
 * range were resolved through the mapper they were minted in. When they were
 * not (R19: a `layout-changed` emitted before the incoming mapper was
 * installed), the range is not wrong by a column, it is wrong by centuries: a
 * rendered end of −2422 read through a YEAR anchor resolved to −396, the
 * fetcher's ±28 days made that `end=-395-01-29`, the server answered 500, and
 * the client could not re-read its own date string (`year-month-day.ts`
 * `parse/yr` splits on `-` and threw — 50–100 unhandled rejections per storm
 * program).
 *
 * The root fix is upstream: `SheetLayout.bindLayout` installs the incoming
 * mapper before the engine emits (R19), and since R21 the engine owns the
 * index space its window was built in. This is the tripwire
 * that makes a recurrence loud instead of expensive: a pure predicate over the
 * range and today, asked immediately after `toDatesInclusive()` and before any
 * fetch. Off the axis, the sheet emits a `witness/` line and does not fetch —
 * the storm fuzzer's battery-wide `witness/*` forbid turns that into a named,
 * shrinkable failing program instead of an HTTP 500 census.
 *
 * ## Why a year tolerance and not an exact bound
 * A sheet legitimately renders anywhere a user can scroll to, and they scroll
 * far — a year view 242 columns back really is 242 years back, and refusing it
 * would blank a legitimate viewport. What no legitimate viewport does is land
 * millennia out: the defect's characteristic signature is the OUTGOING
 * granularity applied to an index minted in the INCOMING one, which multiplies
 * the distance by the unit ratio (365 for year↔day, 24 for day↔hour). ±200
 * years is far past any real scroll and far short of any mis-resolution.
 *
 * The predicate is total and pure: no DOM, no clock, no mapper. `today` is
 * passed in so the call site owns the clock and the test owns the calendar.
 */
export namespace ViewportRange {
  /**
   * How far from today, in years, a rendered viewport may sit before it is
   * treated as evidence of a two-index-space bug rather than a deep scroll.
   * Not a default parameter — {@link ViewportRange.onAxis} makes every caller
   * name the tolerance it is judging against.
   */
  export const YEARS_TOLERANCE = 200;

  /** Anything carrying a calendar year. `NaiveDate` satisfies it structurally. */
  export interface HasYear {
    readonly yr: number;
  }

  /** Anything with two dated ends. `NaiveDate.Range` satisfies it structurally. */
  export interface Span {
    readonly start: HasYear;
    readonly end: HasYear;
  }

  /**
   * Whether `range` is a viewport onto the calendar `today` belongs to.
   *
   * Four ways to be off the axis, and each one is a real shape the defect
   * produces rather than a hypothetical:
   *
   * - either end's year is not a finite number (a mapper that resolved through
   *   `NaN` — arithmetic on an unbound index),
   * - either end's year is not an integer (a year is a count, and a fractional
   *   one means the number came out of pixel arithmetic, not a calendar),
   * - the range runs backwards (`end` before `start`), which a viewport never
   *   does but two mappers disagreeing about a unit readily produce,
   * - either end is further than `yearsTolerance` from `today`.
   */
  export function onAxis(
    range: Span,
    today: HasYear,
    yearsTolerance: number,
  ): boolean {
    const start = range.start.yr;
    const end = range.end.yr;
    const now = today.yr;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (!Number.isInteger(now)) return false;
    if (end < start) return false;
    return Math.abs(start - now) <= yearsTolerance &&
      Math.abs(end - now) <= yearsTolerance;
  }
}
