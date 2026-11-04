import { range } from "../range.ts";
import { Month } from "./month.ts";

import { NaiveDate } from "../naive-date.ts";
import {
  DayOfMonth0,
  DayOfMonth1,
  DayOfYear0,
  Month1,
  MonthOfYear,
} from "./units.ts";
import { Year } from "./year.ts";
import { YearMonthDay } from "./year-month-day.ts";
import type { Optional } from "../option.ts";

export interface YmLike<Index> {
  readonly yr: number;
  readonly mth: MonthOfYear<Index>;
}
export type Ym1Like = YmLike<1>;
export type Ym1LikeOpt = Optional<Ym1Like>;
export type Ym0Like = YmLike<0>;
export type Ym0LikeOpt = Optional<Ym0Like>;

export class YearMonth implements Ym1Like {
  get yr(): number {
    return this.ym.yr;
  }

  get mth(): Month1 {
    return this.ym.mth;
  }

  get mth1(): Month1 {
    return this.ym.mth;
  }

  constructor(public readonly ym: Ym1Like) {}

  date(): NaiveDate {
    return NaiveDate.fromYmd1Exp(this.yr, this.mth1, 1);
  }

  pred(): YearMonth {
    if (this.mth1 === 1) {
      return new YearMonth({
        yr: this.yr - 1,
        mth: 12 as Month1,
      });
    }

    return new YearMonth({
      yr: this.yr,
      mth: (this.mth1 - 1) as Month1,
    });
  }

  succ(): YearMonth {
    if (this.mth1 === 12) {
      return new YearMonth({
        yr: this.yr + 1,
        mth: 1 as Month1,
      });
    }

    return new YearMonth({
      yr: this.yr,
      mth: (this.mth1 + 1) as Month1,
    });
  }

  toJSON(): string {
    return `${this.ym.yr}-${String(this.ym.mth).padStart(2, "0")}`;
  }

  toString(): string {
    return `${this.ym.yr}-${String(this.ym.mth).padStart(2, "0")}`;
  }
}

export namespace YearMonth {
  export function add({ yr, mth }: Ym1Like, other: Ym0LikeOpt): Ym1Like {
    let newYr = yr + (other.yr ?? 0);
    let newMth = (mth + (other.mth ?? 0)) as Month1;
    if (newMth > 12 || newMth <= 0) {
      // Calculate total months from year 0, month 1
      const totalMonths = newYr * 12 + newMth - 1;

      // Calculate new year and month
      newYr = Math.floor(totalMonths / 12);
      newMth = ((totalMonths % 12) + 1) as Month1;

      // Handle negative month values
      if (newMth <= 0) {
        newMth = (newMth + 12) as Month1;
        newYr--;
      }
    }
    return {
      yr: newYr,
      mth: newMth as Month1,
    };
  }

  export function monthsSinceEpoch({ yr, mth }: Ym1Like): number {
    return yr * 12 + mth - 1;
  }

  export function isoStartMon({ yr, mth }: Ym1Like): YearMonthDay {
    const start = YearMonthDay.fromYmd1Exp(yr, mth, 1);
    const dow = start.dayOfWeek.isoDow;
    return start.addDays(dow <= 3 ? -dow : 7 - dow);
  }

  export function daysInMonth({ yr, mth }: Ym1Like): number {
    return Month.DAYS_IN_MONTH[Year.isLeapYear(yr) ? 1 : 0][mth - 1];
  }

  export function dom({ yr, mth }: Ym1Like): Generator<DayOfMonth0> {
    const leapYearIdx = Year.isLeapYear(yr) ? 1 : 0;
    const monthNumDays = Month.DAYS_IN_MONTH[leapYearIdx][mth - 1];
    return range(monthNumDays) as Generator<DayOfMonth0>;
  }

  export function doyForMonthStart({ yr, mth }: Ym1Like): DayOfYear0 {
    return Month.MONTH_START_OF_YEAR[Year.isLeapYear(yr) ? 1 : 0][
      mth - 1
    ] as DayOfYear0;
  }

  /**
   * generates (31..<=59)
   */
  export function doyForMonth({ yr, mth }: Ym1Like): Generator<DayOfYear0> {
    const leapYearIdx = Year.isLeapYear(yr) ? 1 : 0;
    return range(
      Month.MONTH_START_OF_YEAR[leapYearIdx][mth - 1],
      Month.MONTH_START_OF_YEAR[leapYearIdx][mth - 1],
    ) as Generator<DayOfYear0>;
  }

  export function isDayValid(ym1: Ym1Like, day: DayOfMonth1): boolean {
    return day > 0 && day <= daysInMonth(ym1);
  }

  // /**
  //  * generates (31..<=59)
  //  */
  // doyForMonth(month: Month0): Generator<DayOfYear0> {
  //   return YearMonth.doyForMonth({ yr: this.year, mth: (month + 1) as Month1 });
  // }

  // /**
  //  * generates (0..<=30)
  //  */
  // dom(month: Month0): Generator<DayOfMonth0> {
  //   return YearMonth.dom({ yr: this.year, mth: (month + 1) as Month1 });
  // }
}
