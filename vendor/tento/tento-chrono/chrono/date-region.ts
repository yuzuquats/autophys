import { DateFragment } from "./date-fragment.ts";
import { DateTime } from "./datetime.ts";
import { NaiveDate } from "./naive-date.ts";
import { NaiveDateTime } from "./naive-datetime.ts";
import { NaiveTime } from "./naive-time.ts";
import { Time } from "./time.ts";
import { FixedOffset } from "./timezone.ts";
import { TimezoneRegion } from "./timezone-region.ts";
import { MsSinceEpoch } from "./units/units.ts";
import type { Option, Optional } from "./option.ts";

/**
 * Represents a time range using milliseconds since epoch.
 * @interface TimeRange
 * @property {MsSinceEpoch} start - Start time in milliseconds since epoch
 * @property {MsSinceEpoch} end - End time in milliseconds since epoch
 */
export interface TimeRange {
  start: MsSinceEpoch;
  end: MsSinceEpoch;
}

/**
 * Represents a date range with timezone information.
 * @interface DateRange
 * @property {DateTime<FixedOffset>} start - Start datetime with timezone offset
 * @property {DateTime<FixedOffset>} end - End datetime with timezone offset
 */
export interface DateRange {
  start: DateTime<FixedOffset>;
  end: DateTime<FixedOffset>;
}

/**
 * Represents a date in a specific timezone region, handling complexities like DST transitions.
 *
 * DateRegion is responsible for mapping a naive date (without timezone information) to
 * actual datetime ranges with proper timezone handling. It's particularly important for
 * dealing with edge cases like DST transitions where a logical day might span multiple
 * timezone offsets.
 */
export class DateRegion {
  /** The naive date this region represents */
  readonly nd: NaiveDate;

  /** The timezone region for contextualizing the date */
  readonly tz: TimezoneRegion;

  /** Cached calculations to improve performance */
  readonly cache: Optional<{
    dateFragments: DateFragment[];
    date: DateTime.Range<FixedOffset>;
  }> = {};

  /**
   * Creates a new DateRegion instance.
   * @param {NaiveDate} nd - The naive date (without timezone information)
   * @param {TimezoneRegion} tz - The timezone region to contextualize the date
   */
  constructor(nd: NaiveDate, tz: TimezoneRegion) {
    this.nd = nd;
    this.tz = tz;
  }

  /**
   * Returns all DateFragments that represent this logical date.
   *
   * Most days have just one fragment (00:00-23:59 in the same timezone offset),
   * but days with timezone transitions (like DST changes) will have multiple fragments
   * with different timezone offsets.
   *
   * @returns {DateFragment[]} Array of fragments representing this date
   */
  dateFragments(): DateFragment[] {
    if (this.cache.dateFragments) return this.cache.dateFragments;
    return (this.cache.dateFragments = this.#uncachedDateFragments());
  }

  /**
   * Calculates the time shift between fragments if this date has a timezone transition.
   * Returns null if the date has only one fragment (no transitions).
   *
   * @returns {Option<DateFragment.Shift>} Information about the shift between fragments, or null
   */
  shift(): Option<DateFragment.Shift> {
    const df = this.dateFragments();
    if (df.length === 1) return null;
    return df[0].comparison(df[1]);
  }

  /**
   * Calculates the DateFragments for this region without using the cache.
   *
   * Given a naive date (2024-11-03), produces the appropriate fragments.
   * For example, during a "fall back" DST transition:
   *
   *   2024-11-03T00:00:00-07:00 to 2024-11-03T02:00:00-07:00
   *   2024-11-03T01:00:00-08:00 to 2024-11-04T00:00:00-08:00
   *
   * These represent all datetime ranges for the logical date, accounting for
   * the timezone transition. Most days have just one fragment covering the
   * entire day in a single timezone offset.
   *
   * @private
   * @returns {DateFragment[]} Array of fragments representing this date
   */
  #uncachedDateFragments(): DateFragment[] {
    const transitions = this.#transitions();

    const dateStart = this.date.start;
    if (transitions.length === 0) {
      return [
        new DateFragment(
          new DateTime.Range(dateStart, dateStart.add({ hrs: 24 })),
          this.tz,
        ),
      ];
    }

    const transition = transitions[0];
    const result = [
      new DateFragment(
        new DateTime.Range(dateStart, transition.after.time.toTz(dateStart.tz)),
        this.tz,
      ),
      new DateFragment(
        new DateTime.Range(
          transition.after.time,
          transition.after.time.add({ days: 1 }).withTime(NaiveTime.ZERO),
        ),
        this.tz,
      ),
    ];

    return result;
  }

  /**
   * Gets the DateTime range spanning this date in its timezone.
   * This range goes from 00:00 to 23:59:59.999 in the local timezone.
   *
   * @returns {DateTime.Range<FixedOffset>} The datetime range for the whole day
   */
  get date(): DateTime.Range<FixedOffset> {
    if (this.cache.date) return this.cache.date;
    return (this.cache.date = new DateTime.Range(
      this.tz.toWallClock(new NaiveDateTime(NaiveDate.fromMse(this.nd.mse))),
      this.tz.toWallClock(
        new NaiveDateTime(
          // TODO: i dont think this is actually right
          NaiveDate.fromMse((this.nd.mse + Time.MS_PER_DAY) as MsSinceEpoch),
        ),
      ),
    ));
  }

  /**
   * Returns a string representation of this DateRegion.
   * @returns {string} String with the date and timezone name
   */
  toString(): string {
    return `${this.nd.rfc3339()} ${this.tz.fullname}`;
  }

  /**
   * Finds timezone transitions occurring on this date.
   * Looks for transitions where the "after" time falls on this date.
   *
   * @private
   * @returns {TimezoneRegion.Transition[]} Array of timezone transitions
   */
  #transitions(): TimezoneRegion.Transition[] {
    return this.tz
      .transitionsBetween({
        start: (this.nd.mse - Time.MS_PER_DAY) as MsSinceEpoch,
        end: (this.nd.mse + Time.MS_PER_DAY) as MsSinceEpoch,
      })
      .filter((t) => {
        return t.after.time.ndt.date.equals(this.nd);
      });
  }

  /**
   * Returns transitions occurring strictly within this date's 24-hour period.
   * Unlike #transitions, this doesn't look at surrounding days.
   *
   * @returns {TimezoneRegion.Transition[]} Array of timezone transitions
   */
  currentTransitions(): TimezoneRegion.Transition[] {
    return this.tz.transitionsBetween({
      start: this.nd.mse as MsSinceEpoch,
      end: (this.nd.mse + Time.MS_PER_DAY) as MsSinceEpoch,
    });
  }
}
