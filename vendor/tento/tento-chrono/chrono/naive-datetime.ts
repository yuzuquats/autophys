import { DateTimeRegion } from "./date-time-region.ts";
import { DateTime } from "./datetime.ts";
import { NaiveDate } from "./naive-date.ts";
import { NaiveTime } from "./naive-time.ts";
import { GenericRange } from "./range.ts";
import { Time } from "./time.ts";
import { LogicalTimezone, Utc } from "./timezone.ts";
import { TimezoneRegion } from "./timezone-region.ts";
import { DateUnit } from "./units/date-unit.ts";
import { Duration } from "./units/duration.ts";
import { DurationTime } from "./units/duration-time.ts";
import { Month } from "./units/month.ts";
import { YearMonth } from "./units/year-month.ts";
import { Ms } from "./units/ms.ts";
import { TimePoint } from "./units/time-point.ts";
import { DaysSinceEpoch, MsSinceEpoch, Sign } from "./units/units.ts";
import type { Option, Optional } from "./option.ts";

/**
 * Represents a date and time without any associated timezone information.
 * It combines a `NaiveDate` (year, month, day) and a `NaiveTime` (hour, minute, second, millisecond).
 * Operations on `NaiveDateTime` do not consider timezone offsets or daylight saving time rules.
 */
export class NaiveDateTime {
  private _mse: Option<MsSinceEpoch> = null;

  /**
   * Creates a new NaiveDateTime instance.
   * @param date The date component.
   * @param time The time component. Defaults to midnight (00:00:00.000).
   */
  constructor(
    public readonly date: NaiveDate,
    public readonly time: NaiveTime = new NaiveTime(0),
  ) {
    if (Number.isNaN(time.toMs)) {
      throw new Error("invalid time");
    }
  }

  /**
   * Adds a duration to this datetime, largest units first: years and months
   * (a day past the new month's end, as Jan 31 + 1 month, is that month's
   * last day: Feb 29 in 2024), then weeks, days and the time of day, which
   * carries over into the date.
   * @param delta An object specifying the duration components (years, months, weeks, days, hours, minutes, seconds, milliseconds) to add.
   * @returns A new NaiveDateTime instance representing the result of the addition.
   */
  add(delta: NaiveDateTime.Parts.Opt, sign: Sign = 1): NaiveDateTime {
    let ym: NaiveDate.MaybeValid = this.date;
    if (delta.yrs) {
      ym = ym.addYears(delta.yrs * sign);
    }
    if (delta.mths) {
      ym = ym.addMonths(delta.mths * sign);
    }
    let newDate: NaiveDate = ym.isValid()
      ? ym.castValid()
      : NaiveDate.fromYmd1Exp(ym.yr, ym.mth, YearMonth.daysInMonth(ym));
    if (delta.wks) {
      newDate = newDate.addWeeks(delta.wks * sign);
    }
    const timeDeltaMs = Ms.resolve(delta) * sign;
    const tp = TimePoint.ms(this.time.toMs + timeDeltaMs);
    if (tp.days !== 0) {
      newDate = newDate.addDays(tp.days);
    }
    return new NaiveDateTime(newDate, tp.time);
  }

  /**
   * Subtracts a duration from this datetime.
   * This is implemented by negating the components of the duration and calling `add`.
   * @param delta An object specifying the duration components to subtract.
   * @returns A new NaiveDateTime instance representing the result of the subtraction.
   */
  sub(delta: NaiveDateTime.Parts.Opt): NaiveDateTime {
    return this.add(delta, -1);
  }

  /**
   * Rounds this datetime to the nearest specified time unit.
   * @param unit An object specifying the time unit to round to (e.g., { mins: 15 } to round to the nearest 15 minutes).
   * @param op The rounding function to use (Math.round, Math.floor, Math.ceil). Defaults to Math.round.
   * @returns A new NaiveDateTime instance rounded to the specified unit. Returns the original instance if the duration unit is zero or negative.
   */
  nearest(
    unit: DurationTime.Parts.Opt,
    op: (n: number) => number = Math.round,
  ): NaiveDateTime {
    const duration = Duration.Time.from(unit);
    if (duration.toMs <= 0) return this;

    // Only round the time portion within the day
    const dayStart = this.date.daysSinceEpoch * Time.MS_PER_DAY;
    const timeMs = this.time.toMs;

    // Round only the time portion
    const roundedTimeMs = op(timeMs / duration.toMs) * duration.toMs;

    // Calculate the new total milliseconds with rounded time
    const roundedMs = dayStart + roundedTimeMs;

    return NaiveDateTime.fromMse(roundedMs as MsSinceEpoch);
  }

  /**
   * Gets the total number of milliseconds since the Unix epoch (1970-01-01T00:00:00Z),
   * calculated based on the naive date and time without considering any timezone.
   */
  get mse(): MsSinceEpoch {
    if (this._mse != null) return this._mse;
    return (this._mse = (this.date.daysSinceEpoch * Time.MS_PER_DAY +
      this.time.toMs) as MsSinceEpoch);
  }

  /**
   * Gets the number of days since the Unix epoch (1970-01-01).
   */
  get dse(): DaysSinceEpoch {
    return this.date.daysSinceEpoch;
  }

  /**
   * Creates a timezone-aware `DateTime` instance by associating this `NaiveDateTime` with the UTC timezone.
   * The date and time values remain the same, but they are now interpreted as being in UTC.
   * @returns A new `DateTime` instance in UTC.
   */
  asUtc(): DateTime<Utc> {
    return new DateTime(this, Utc);
  }

  /**
   * Creates a timezone-aware `DateTime` instance by associating this `NaiveDateTime` with the UTC timezone.
   * The date and time values remain the same, but they are now interpreted as being in UTC.
   * @returns A new `DateTime` instance in UTC.
   */
  withUtcTz(): DateTime<Utc> {
    return new DateTime(this, Utc);
  }

  /**
   * Creates a timezone-aware `DateTime` instance by associating this `NaiveDateTime` with the specified logical timezone.
   * The date and time values remain the same, but they are now interpreted as being in the given timezone.
   * This does *not* convert the time from one timezone to another.
   * @param offset The logical timezone (e.g., `America/New_York`) to associate with this datetime.
   * @returns A new `DateTime` instance in the specified timezone.
   */
  withTz<Tz extends string>(offset: LogicalTimezone<Tz>): DateTime<Tz> {
    return new DateTime(this, offset);
  }

  withTzRegion(tz: TimezoneRegion): DateTimeRegion {
    return new DateTimeRegion(this, tz);
  }

  toString(): string {
    return `${this.date.toString()}T${this.time.toString()}`;
  }

  ical(includeZ: boolean = false): string {
    return `${this.date.ical()}T${this.time.ical()}` + (includeZ ? "Z" : "");
  }

  toRelativeString(now: NaiveDateTime): string {
    const relative = NaiveDateTime.Formatter.relativeDate(now, this);
    let ndtComponent =
      relative ??
      `${Month.MONTHS_OF_YEAR_SHORT[this.date.month0]} ${this.date.dayOfMonth}, ${this.date.yr}`;
    return `${ndtComponent} ${this.time.format({ includeSeconds: false, includeMins: false, padHours: false, includeAmPm: true })}`;
  }
}

/**
 * Namespace containing static methods and nested types related to NaiveDateTime.
 */
export namespace NaiveDateTime {
  export function parse(s: string): Option<NaiveDateTime> {
    const [d, t] = s.split("T");
    const date = NaiveDate.parseOpt(d);
    if (date == null) return null;

    const time = Duration.Time.parse(t);
    if (time.isErr) return null;

    const tt = time.asOk()!;
    return new NaiveDateTime(date, tt.toTimeOfDayWrapping());
  }

  /**
   * Creates a NaiveDateTime from a total number of milliseconds since the Unix epoch.
   * This calculation assumes a linear timeline without timezone considerations.
   * @param mse The total milliseconds since 1970-01-01T00:00:00Z.
   * @returns A new NaiveDateTime instance corresponding to the given milliseconds.
   */
  export function fromMse(mse: MsSinceEpoch): NaiveDateTime {
    // Calculate whole days and remaining milliseconds within the last day
    const days = Math.floor(mse / Time.MS_PER_DAY);

    // For positive or zero mse, this is straightforward
    if (mse >= 0) {
      const remMs = mse % Time.MS_PER_DAY;
      return new NaiveDateTime(
        NaiveDate.fromDse(days as DaysSinceEpoch),
        new NaiveTime(remMs),
      );
    }

    // For negative mse, we need to handle the remainder differently
    if (mse % Time.MS_PER_DAY === 0) {
      // Cleanly divisible by day (e.g., -86400000)
      return new NaiveDateTime(
        NaiveDate.fromDse(days as DaysSinceEpoch),
        new NaiveTime(0),
      );
    } else {
      // For negative timestamps that don't divide evenly by day length,
      // we need to adjust days and compute the positive offset from that day's start
      // Math.floor for negative numbers gives us one more negative day than we want
      // e.g., for -1ms, Math.floor(-1 / 86400000) = -1, but we want day 0 with
      // 23:59:59.999 time
      const adjustedDays = days;
      const remMs = Time.MS_PER_DAY + (mse % Time.MS_PER_DAY);
      return new NaiveDateTime(
        NaiveDate.fromDse(adjustedDays as DaysSinceEpoch),
        new NaiveTime(remMs),
      );
    }
  }

  /**
   * Namespace containing utility functions for formatting NaiveDateTime instances.
   */
  export namespace Formatter {
    /**
     * Renders a NaiveDateTime into a human-readable string format.
     * Example: "January 1, 12:00:00"
     * @param s The NaiveDateTime instance to format.
     * @returns A string representation of the date and time.
     */
    export function render(s: NaiveDateTime, options: { dateFormat?: "month-day" | "day-month" } = {}): string {
      const dateStr = NaiveDate.Formatter.render(
        s.date,
        options.dateFormat !== undefined ? { dateFormat: options.dateFormat } : {},
      );
      return `${dateStr}, ${s.time.toString()}`;
    }

    /**
     * Renders the difference between two NaiveDateTime instances in a simple, human-readable format (e.g., "today", "tomorrow", "yesterday", "X days ago", "X days from now").
     * Note: This currently only considers the date component difference.
     * @param s The starting NaiveDateTime.
     * @param o The ending NaiveDateTime.
     * @returns A string describing the difference in days.
     */
    export function renderDateDiff(s: NaiveDateTime, o: NaiveDateTime): string {
      // Calculate the difference in days based on days since epoch.
      const daysDiff = o.date.daysSinceEpoch - s.date.daysSinceEpoch;

      // Return specific strings for common differences.
      if (daysDiff > 1) {
        // Future difference
        return `${daysDiff} days from now`;
      } else if (daysDiff < -1) {
        // Past difference
        return `${-daysDiff} days ago`;
      } else {
        return relativeDate(s, o)!;
      }
    }

    export function relativeDate(
      s: NaiveDateTime,
      o: NaiveDateTime,
    ): Option<string> {
      // Calculate the difference in days based on days since epoch.
      const daysDiff = o.date.daysSinceEpoch - s.date.daysSinceEpoch;

      // Return specific strings for common differences.
      if (daysDiff === 0) {
        return "today";
      } else if (daysDiff === 1) {
        return "tomorrow";
      } else if (daysDiff === -1) {
        return "yesterday";
      } else {
        return null;
      }
    }
  }

  /**
   * Represents a continuous range between two NaiveDateTime instances (start and end).
   * Inherits generic range functionality from `GenericRange`.
   */
  export class Range extends GenericRange<NaiveDateTime> {
    /**
     * Converts this `NaiveDateTime.Range` into a timezone-aware `DateTime.Range`
     * by associating both the start and end points with the specified logical timezone.
     * @param offset The logical timezone to associate with the range boundaries.
     * @returns A new `DateTime.Range` instance.
     */
    withTz<Tz extends string>(offset: LogicalTimezone<Tz>): DateTime.Range<Tz> {
      return new DateTime.Range(
        this.start.withTz(offset),
        this.end.withTz(offset),
      );
    }
  }
}

export namespace NaiveDateTime {
  export type Parts = DurationTime.Parts & DateUnit.Parts;

  export namespace Parts {
    export type Opt = Optional<Parts>;
  }
}
