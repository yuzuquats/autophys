import { GenericRange } from "../range.ts";
import { Time } from "../time.ts";
import { Duration } from "./duration.ts";
import { DurationTime } from "./duration-time.ts";
import { Ms } from "./ms.ts";
import { TimeOfDay } from "./time-of-day.ts";

/**
 * TimePoint represents a time since an epoch, which contains a TimeOfDay and a number of days.
 * This is useful for calculations involving time arithmetic that goes beyond a single day.
 */
export class TimePoint {
  /**
   * Creates a new TimePoint from days and time of day
   * @param days - Number of days (can be positive or negative)
   * @param time - Time of day component
   */
  constructor(
    public readonly days: number,
    public readonly time: TimeOfDay,
  ) {}

  /**
   * Creates a TimePoint from milliseconds
   * @param ms - Milliseconds (can be positive or negative)
   * @returns A new TimePoint
   */
  static ms(ms: number): TimePoint {
    if (ms >= 0) {
      const div = Math.floor(ms / Time.MS_PER_DAY);
      const rem = ((ms % Time.MS_PER_DAY) + Time.MS_PER_DAY) % Time.MS_PER_DAY;
      return new TimePoint(div, new TimeOfDay(rem));
    }

    // Handle negative values differently to get the right day
    const absMs = Math.abs(ms);
    const wholeDays = Math.floor(absMs / Time.MS_PER_DAY);
    const remainder = absMs % Time.MS_PER_DAY;
    if (remainder === 0) {
      // Simple case: exact day boundary
      return new TimePoint(-wholeDays, new TimeOfDay(0));
    }

    // For negative time that's not on a day boundary, we need to handle the time portion differently
    // We need to move to the previous day and compute time from the end of that day
    return new TimePoint(
      -(wholeDays + 1),
      new TimeOfDay(Time.MS_PER_DAY - remainder),
    );
  }

  static hrs(hrs: number): TimePoint {
    return TimePoint.ms(hrs * Time.MS_PER_HR);
  }

  /**
   * Returns the total milliseconds represented by this TimePoint
   */
  get toMs(): number {
    return this.days * Time.MS_PER_DAY + this.time.toMs;
  }

  /**
   * Adds a duration to this TimePoint
   * @param duration - Duration to add
   * @returns A new TimePoint
   */
  add(duration: DurationTime.Parts.Opt): TimePoint {
    return TimePoint.ms(this.toMs + Ms.resolve(duration));
  }

  /**
   * Subtracts a duration from this TimePoint
   * @param duration - Duration to subtract
   * @returns A new TimePoint
   */
  subtract(duration: DurationTime.Parts.Opt): TimePoint {
    return TimePoint.ms(this.toMs - Ms.resolve(duration));
  }

  /**
   * Alias for subtract
   */
  sub(duration: DurationTime.Parts.Opt): TimePoint {
    return this.subtract(duration);
  }

  /**
   * Multiplies this TimePoint by a scalar
   * @param scalar - Multiplier
   * @returns A new TimePoint
   */
  mult(scalar: number): TimePoint {
    return TimePoint.ms(this.toMs * scalar);
  }

  /**
   * Calculates the duration between this TimePoint and another
   * @param other - Another TimePoint
   * @returns Duration between the two TimePoints
   */
  durationUntil(other: TimePoint): Duration.Time {
    return Duration.Time.ms((other.toMs - this.toMs) as Ms);
  }

  /**
   * Compares this TimePoint to another
   * @param other - Another TimePoint
   * @returns Negative if this is earlier, positive if later, 0 if equal
   */
  compareTo(other: TimePoint): number {
    return this.toMs - other.toMs;
  }

  /**
   * Alias for compareTo
   */
  cmp(other: TimePoint): number {
    return this.compareTo(other);
  }

  /**
   * Checks if this TimePoint is before another
   * @param other - Another TimePoint
   * @returns True if this is before other
   */
  isBefore(other: TimePoint): boolean {
    return this.compareTo(other) < 0;
  }

  /**
   * Checks if this TimePoint is after another
   * @param other - Another TimePoint
   * @returns True if this is after other
   */
  isAfter(other: TimePoint): boolean {
    return this.compareTo(other) > 0;
  }

  /**
   * Checks if this TimePoint equals another
   * @param other - Another TimePoint
   * @returns True if TimePoints are equal
   */
  equals(other: TimePoint): boolean {
    return this.toMs === other.toMs;
  }

  /**
   * Returns a string representation of this TimePoint
   * @returns String representation (e.g., "2d 14:30:00" or "-1d 20:15:30")
   */
  toString(): string {
    if (this.days === 0) {
      return this.time.toString();
    } else if (this.days < 0) {
      return `${this.days}d ${this.time.toString()}`;
    } else {
      return `${this.days}d ${this.time.toString()}`;
    }
  }

  toDuration(): Duration.Time {
    return Duration.Time.from({ toMs: this.toMs as Ms });
  }
}

export namespace TimePoint {
  export class Range extends GenericRange<TimePoint> {
    get duration(): Duration.Time {
      return Duration.Time.from({
        toMs: (this.end.toMs - this.start.toMs) as Ms,
      });
    }

    toTodRange(): TimeOfDay.Range {
      return new TimeOfDay.Range(
        this.start.time,
        this.end.time,
        this.start.days !== this.end.days,
      );
    }

    static fromTodRange(tod: TimeOfDay.Range): Range {
      return new Range(
        new TimePoint(0, tod.start),
        new TimePoint(tod.endsOnNextDay ? 1 : 0, tod.end),
      );
    }
  }
}
