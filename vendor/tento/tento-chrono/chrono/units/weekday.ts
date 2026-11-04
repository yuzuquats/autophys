import { Epoch } from "./epoch.ts";
import {
  DayOfWeek,
  DayOfWeek1,
  DayOfYear1,
  DaysSinceEpoch,
  MsSinceEpoch,
} from "./units.ts";
import { YearMonthDay } from "./year-month-day.ts";
import type { Option } from "../option.ts";
// import { YearMonthDay } from "./year-month-day.ts";

export class Weekday {
  static WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  static WEEKDAY_FULL = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  static WEEKDAY_SHORT2 = ["su", "mo", "tu", "we", "th", "fr", "sa"];

  /** Returns Sunday=1 through Saturday=7 for a Unix epoch day count. */
  static fromDse(dse: DaysSinceEpoch): DayOfWeek1 {
    if (dse === (dse | 0)) {
      // Ben Joffe's full signed 32-bit shift variant.
      // https://www.benjoffe.com/fast-day-of-week#fn=32unix
      // MIT license: ../../.docs/content/weekday-performance.md
      // Math.imul keeps the low product bits; >>> wraps the sum to u32.
      return (((Math.imul(dse, 613566756) +
        0x95000000 +
        (dse >> 1) +
        (dse >> 4)) >>> 29) + 1) as DayOfWeek1;
    }

    // Reduce first so adding the epoch offset cannot round large integers.
    let result = (dse % 7 + 4) % 7;
    if (result < 0) result += 7;
    return (result + 1) as DayOfWeek1;
  }

  static fromMse(mse: MsSinceEpoch): DayOfWeek1 {
    return Weekday.fromDse(Epoch.mseToDse(mse));
  }

  static shortName(dow: DayOfWeek1): string {
    return Weekday.WEEKDAY_SHORT[dow - 1];
  }

  static fullName(dow: DayOfWeek1): string {
    return Weekday.WEEKDAY_FULL[dow - 1];
  }

  readonly dow: DayOfWeek<1, "sun">;
  readonly label: string;

  constructor(dow: DayOfWeek1) {
    this.dow = dow;
    this.label = Weekday.shortName(this.dow);
  }

  get isoDow(): DayOfWeek<0, "mon"> {
    return ((this.dow - 2 + 7) % 7) as DayOfWeek<0, "mon">;
  }

  get isoDow1(): DayOfWeek<1, "mon"> {
    const isoDow = this.dow;
    return (isoDow === 1 ? 7 : isoDow - 1) as DayOfWeek<1, "mon">;
  }

  get shortname(): string {
    return Weekday.shortName(this.dow);
  }

  get isWeekend(): boolean {
    return this === Weekday.SAT || this === Weekday.SUN;
  }

  nth(n: number): Weekday.Nth {
    return {
      weekday: this,
      n,
    };
  }

  get initialCaps(): string {
    return this.label[0];
  }

  static nthForYear(
    ndows: Weekday.Nth[],
    start: YearMonthDay,
    end: YearMonthDay,
    endDay: number,
  ): DayOfYear1[] {
    const startWkday = start.dayOfWeek;
    const endWkday = end.dayOfWeek;

    const ndowsByDay = ndows
      .map((dow) => {
        if (dow.n > 0) {
          let offset = dow.weekday.dow - startWkday.dow;
          if (offset < 0) offset += 7;
          offset += (dow.n - 1) * 7;
          return offset;
        } else {
          let offset = dow.weekday.dow - endWkday.dow;
          if (offset > 0) offset -= 7;
          offset += (dow.n + 1) * 7;
          return endDay + offset - 1;
        }
      })
      .filter((offset) => offset >= 0 && offset < endDay);

    ndowsByDay.sort((a, b) => a - b);
    return ndowsByDay as DayOfYear1[];
  }

  /**
   * NOTE: deno is very strict about ordering
   */
  static SUN = new Weekday(1 as DayOfWeek1);
  static MON = new Weekday(2 as DayOfWeek1);
  static TUE = new Weekday(3 as DayOfWeek1);
  static WED = new Weekday(4 as DayOfWeek1);
  static THU = new Weekday(5 as DayOfWeek1);
  static FRI = new Weekday(6 as DayOfWeek1);
  static SAT = new Weekday(7 as DayOfWeek1);

  static DOW1 = [
    Weekday.SUN,
    Weekday.MON,
    Weekday.TUE,
    Weekday.WED,
    Weekday.THU,
    Weekday.FRI,
    Weekday.SAT,
  ];

  static parseOpt(s: Option<string>): Option<Weekday> {
    if (!s) return null;
    const key = s.slice(0, 2).toLowerCase();
    const idx = Weekday.WEEKDAY_SHORT2.findIndex((s) => s === key);
    return idx !== -1 ? Weekday.DOW1[idx] : null;
  }

  static toString2cap(weekday: Weekday): string {
    return weekday.label.slice(0, 2).toUpperCase();
  }

  toString(): string {
    return this.label;
  }
}

export namespace Weekday {
  export type Nth = {
    weekday: Weekday;
    n: number;
  };

  export function parseNthOpt(s: Option<string>): Option<Nth> {
    if (!s) return null;

    // Handle patterns like "2TU", "-1FR" (only with explicit number)
    const match = s.match(/^([+-]?\d+)([A-Z]{2})$/i);
    if (!match) return null;

    const [, nStr, weekdayStr] = match;
    const weekday = Weekday.parseOpt(weekdayStr);
    if (!weekday) return null;

    const n = Number.parseInt(nStr, 10);
    return { weekday, n };
  }
}
