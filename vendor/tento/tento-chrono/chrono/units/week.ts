import { Weekday } from "./weekday.ts";
import { NaiveDate } from "../naive-date.ts";
import { Time } from "../time.ts";
import {
  MsSinceEpoch,
  WeekOfYear,
  WeekOfYear1,
  WeeksSinceEpoch1,
} from "./units.ts";
import { Year } from "./year.ts";
import { TentoMath } from "../utils.ts";

export interface YwLike<Index> {
  yr: number;
  wno: WeekOfYear<Index>;
}
export type Yw1Like = YwLike<1>;

export function yw1(yr: number, wno: number): Yw1Like {
  return { yr, wno: wno as WeekOfYear1 };
}

export namespace Week {
  export function differenceInWeeks(from: Yw1Like, to: Yw1Like): number {
    // Special case: if both dates are in epoch week
    if (
      (from.yr === 1969 && from.wno === 52) ||
      (from.yr === 1970 && from.wno === 0)
    ) {
      if (
        (to.yr === 1969 && to.wno === 52) ||
        (to.yr === 1970 && to.wno === 0)
      ) {
        return 0;
      }
    }

    let totalWeeks = 0;

    // Convert week 0 of a year to week 52/53 of previous year for calculation
    const normalizeYearWeek = (yw: Yw1Like): Yw1Like => {
      if (yw.wno === 0) {
        return {
          yr: yw.yr - 1,
          wno: Year.numWeeks(yw.yr - 1) as WeekOfYear1,
        };
      }
      return yw;
    };

    const t = normalizeYearWeek(from);
    const o = normalizeYearWeek(to);

    if (o.yr > t.yr) {
      for (let year = t.yr; year < o.yr; year++) {
        totalWeeks += Year.numWeeks(year);
      }
      totalWeeks += o.wno - t.wno;
    } else if (o.yr < t.yr) {
      for (let year = o.yr; year < t.yr; year++) {
        totalWeeks -= Year.numWeeks(year);
      }
      totalWeeks += o.wno - t.wno;
    } else {
      totalWeeks = o.wno - t.wno;
    }

    return totalWeeks;
  }

  export const sub = differenceInWeeks;

  export function addWeeks(
    { yr, wno: week }: Yw1Like,
    numWeeks: number
  ): Yw1Like {
    let currWeek = week + numWeeks;

    while (currWeek > Year.numWeeks(yr)) {
      currWeek -= Year.numWeeks(yr);
      yr += 1;
    }
    while (currWeek < 1) {
      yr -= 1;
      currWeek += Year.numWeeks(yr);
    }

    return { yr, wno: currWeek as WeekOfYear1 };
  }

  export const add = addWeeks;

  /**
   * ISO week `wno` of `yr` counted from the epoch's week: 1970-W01, which
   * starts on Monday 1969-12-29, is 1, 1969-W52 is 0, and every week before
   * it counts on down (1969-W51 is -1). Week 0 of a year is the last week of
   * the year before. Computed from the Monday of `yr`'s first ISO week, so
   * it takes the same time at any year and is exact below 2^53 days.
   *
   * ```ts
   * import { assertEquals } from "@std/assert";
   * import { Week, yw1 } from "./week.ts";
   * assertEquals(Week.weeksSinceEpoch(yw1(1970, 1)), 1);
   * assertEquals(Week.weeksSinceEpoch(yw1(1969, 52)), 0);
   * assertEquals(Week.weeksSinceEpoch(yw1(1969, 51)), -1);
   * assertEquals(Week.weeksSinceEpoch(yw1(1971, 0)), 53);
   * ```
   */
  export function weeksSinceEpoch({ yr, wno }: Yw1Like): WeeksSinceEpoch1 {
    // ISO week 1 holds January 4; its Monday is the Monday on or before it.
    // Day 0 (1970-01-01) is a Thursday, so day `d` is `(d + 3) mod 7` days
    // after a Monday.
    const jan4 = Year.dseFromYear(yr) + 3;
    const week1Monday = jan4 - TentoMath.mod(jan4 + 3, 7);
    // The epoch week's Monday is day -3; `week1Monday + 3` is a multiple of 7.
    return ((week1Monday + 3) / 7 + wno) as WeeksSinceEpoch1;
  }

  // Helper function: calculate the day of the week for Jan 1
  // Returns 0 for Sunday, 1 for Monday, ..., 6 for Saturday
  function getDayOfWeek(year: number, month: number, day: number): number {
    const a = Math.floor((14 - month) / 12);
    const y = year - a;
    const m = month + 12 * a - 2;
    return (
      (day +
        y +
        Math.floor(y / 4) -
        Math.floor(y / 100) +
        Math.floor(y / 400) +
        Math.floor((31 * m) / 12)) %
      7
    );
  }

  export function dateFromWeekno(
    { yr, wno }: Yw1Like,
    weekday: Weekday
  ): NaiveDate {
    // Day of the week for January 1 (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
    const jan1Day = getDayOfWeek(yr, 1, 1);

    // Determine the ISO week start date (Monday of week 1)
    // If Jan 1 is:
    // - Monday (1): week starts on Jan 1
    // - Tuesday (2) to Thursday (4): week starts on the previous Monday
    // - Friday (5), Saturday (6) or Sunday (0): week starts on the next Monday
    //   (week 1 is the week that holds January 4)
    const isoWeekStartOffset = jan1Day <= 4 ? jan1Day - 1 : jan1Day - 8;
    const firstWeekStart = NaiveDate.fromYmd1Exp(yr, 1, 1).addDays(
      -isoWeekStartOffset
    );

    // Calculate the target date
    // (weekNo - 1) * 7 gives the offset in days to the start of the week
    // (weekday - 1) gives the offset within the week (Monday = 1)
    return NaiveDate.fromMse(
      (firstWeekStart.mse +
        (wno - 1) * 7 * Time.MS_PER_DAY +
        weekday.isoDow * Time.MS_PER_DAY) as MsSinceEpoch
    );
  }
}
