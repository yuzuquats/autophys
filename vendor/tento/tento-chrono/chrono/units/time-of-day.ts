// Use console.log instead of @lona/log in tento-chrono
import { GenericRange } from "../range.ts";
import { Result, erm, ok } from "../result.ts";
import { Time } from "../time.ts";
import { Duration } from "./duration.ts";
import { DurationTime } from "./duration-time.ts";
import { Hms } from "./hour-mins-secs.ts";
import { Meridiem } from "./meridiem.ts";
import { Ms } from "./ms.ts";
import { TimePoint } from "./time-point.ts";
import type { Option, Optional } from "../option.ts";

/**
 * TimeOfDay represents a specific time of day on a 24-hour clock (00:00:00 to 23:59:59.999)
 * without any days component.
 */
export class TimeOfDay {
  /**
   * Creates a new TimeOfDay from milliseconds since midnight
   * @param ms - Milliseconds since midnight (0-86,399,999)
   */
  constructor(readonly toMs: number) {
    if (toMs < 0 || toMs >= Time.MS_PER_DAY) throw new Error("ms out of range");
  }

  static clamp(toMs: number): TimeOfDay {
    return new TimeOfDay(Math.min(Time.MS_PER_DAY - 1, Math.max(0, toMs)));
  }

  /**
   * Creates a TimeOfDay from hours, minutes, seconds, and milliseconds
   * @param components - Object with hrs, mins, secs, ms properties
   * @returns A new TimeOfDay
   */
  static wrap(components: TimeOfDay.Like.Opt): TimeOfDay {
    const ms = Ms.resolve(components);
    const normalizedMs =
      ((ms % Time.MS_PER_DAY) + Time.MS_PER_DAY) % Time.MS_PER_DAY;
    return new TimeOfDay(normalizedMs);
  }

  static tryFrom(f: TimeOfDay.Like.Opt): Result<TimeOfDay> {
    const toMs = Ms.resolve(f);
    if (toMs < 0 || toMs >= Time.MS_PER_DAY) return erm("ms out of range");
    return ok(new TimeOfDay(toMs));
  }

  static fromHms(f: TimeOfDay.Like.Opt): TimeOfDay {
    const t = TimeOfDay.tryFrom(f);
    const tt = t.asOk();
    if (!tt) throw new Error("hms couldn't be parsed");
    return tt;
  }

  /**
   * Creates a TimeOfDay from a string in format "HH:MM" or "HH:MM:SS"
   * @param s - Time string
   * @returns Result containing TimeOfDay or error
   */
  static parse(s: string): Result<TimeOfDay> {
    const ms = Ms.parse(s);
    if (ms.isErr) return ms.expeCast();
    return ok(new TimeOfDay(ms.exp()));
  }

  /**
   * Attempts to parse a partial time string, useful for progressive input validation
   * @param s - Partial or complete time string
   * @returns Result<Option<TimeOfDay>> where:
   *   - Ok(TimeOfDay) means a complete valid time was parsed
   *   - Ok(null) means the input is incomplete but could become valid (e.g., "1", "23:", "12:3")
   *   - Err means the input cannot become a valid time (e.g., "25", "12:60", "abc")
   */
  static tryParseSofar(s: string): Result<Option<TimeOfDay>> {
    // Empty string is incomplete but valid
    const trimmed = s.trim();
    if (!trimmed) return ok(null);

    // Split by colon
    // Check for too many parts

    const parts = trimmed.split(":");
    if (parts.length > 3) return erm("Too many time components");

    // Validate each part
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // Check if part contains only digits
      if (!/^\d*$/.test(part))
        return erm("Invalid characters in time component");
    }

    // Parse the hours (first part)
    if (parts[0] === "") {
      // Just a colon at the start is invalid
      if (parts.length > 1) return erm("Missing hours");
      return ok(null); // Empty string case (already handled above but for clarity)
    }

    const hrs = Number.parseInt(parts[0], 10);

    // If only one part (no colon yet)
    if (parts.length === 1) {
      // Single digit is always incomplete
      if (trimmed.length === 1) return ok(null);

      // Two digits without colon - interpret as minutes (00:XX format)
      if (trimmed.length === 2 && !trimmed.endsWith(":")) {
        // Can't be valid minutes
        if (hrs > 59) return erm("Minutes must be less than 60");
        // Interpret as 00:XX (XX minutes)
        return ok(TimeOfDay.wrap({ hrs: 0, mins: hrs }));
      }

      // If it ends with colon, check if hours are valid
      if (trimmed.endsWith(":")) {
        if (hrs > 23) return erm("Hours must be less than 24");
        return ok(null); // Need minutes
      }

      // Three or more digits without colon - likely invalid
      if (trimmed.length >= 3) return erm("Invalid time format");
    }

    // We have a colon, so first part is definitely hours
    if (hrs > 23) return erm("Hours must be less than 24");

    // Parse minutes (second part)
    if (parts.length >= 2) {
      // Has colon but no minutes yet (e.g., "12:")
      if (parts[1] === "") return ok(null);

      // Check minute validity
      const mins = Number.parseInt(parts[1], 10);
      if (mins > 59) return erm("Minutes must be less than 60");

      // If minutes are incomplete (single digit), it's still potentially valid
      if (parts[1].length === 1 && parts.length === 2 && !trimmed.endsWith(":"))
        return ok(null);

      // If we have complete hours and minutes with no seconds
      // This is a complete HH:MM format
      if (parts.length === 2 && parts[1].length === 2)
        return ok(TimeOfDay.wrap({ hrs, mins }));

      // If there's a trailing colon, expecting seconds
      if (parts.length === 2 && trimmed.endsWith(":")) return ok(null);

      // Parse seconds (third part) - only if we have 3 parts
      if (parts.length === 3) {
        // Has second colon but no seconds yet (e.g., "12:34:")
        if (parts[2] === "") return ok(null);
        // Check second validity
        const secs = Number.parseInt(parts[2], 10);
        if (secs > 59) return erm("Seconds must be less than 60");

        // If seconds are incomplete (single digit)
        if (parts[2].length === 1) return ok(null);
        // Complete HH:MM:SS format
        if (parts[2].length === 2)
          return ok(TimeOfDay.wrap({ hrs, mins, secs }));
      }
    }

    // Default to incomplete
    return ok(null);
  }

  /**
   * Creates a TimeOfDay for midnight (00:00:00)
   */
  static midnight(): TimeOfDay {
    return new TimeOfDay(0);
  }

  /**
   * Creates a TimeOfDay for noon (12:00:00)
   */

  static noon(): TimeOfDay {
    return new TimeOfDay(12 * Time.MS_PER_HR);
  }

  duration(): DurationTime {
    return DurationTime.ms(this.toMs as Ms);
  }

  /**
   * Gets the hour component
   */
  get hrs(): number {
    return Math.floor(this.toMs / Time.MS_PER_HR);
  }

  /**
   * Gets the minute component (0-59)
   */
  get mins(): number {
    return Math.floor((this.toMs % Time.MS_PER_HR) / Time.MS_PER_MIN);
  }

  /**
   * Gets the second component (0-59)
   */
  get secs(): number {
    return Math.floor((this.toMs % Time.MS_PER_MIN) / Time.MS_PER_SEC);
  }

  /**
   * Gets the millisecond component (0-999)
   */
  get ms(): number {
    // Floor like the `hrs`/`mins`/`secs` getters: `toMs` may carry a
    // sub-millisecond fraction (e.g. a pixel-derived event time), and a
    // non-integer here makes `toRfc3339` emit a double-decimal fraction
    // (`:11.425.78125`) that breaks RFC3339 round-trips.
    return Math.floor(this.toMs % Time.MS_PER_SEC);
  }

  /**
   * Gets the meridiem (am/pm) for this time
   */
  get meridiem(): Meridiem {
    return Meridiem.fromHours(this.hrs);
  }

  /**
   * Calculates the duration between this time and another time point
   * @param other - Another time point
   * @param assumeSameDay - If true, assumes both times are on the same day
   *                        If false, returns the shortest duration (always <= 12 hours)
   * @returns Duration between the two time points
   */
  durationUntil(
    other: TimeOfDay,
    assumeSameDay: boolean = true,
  ): Duration.Time {
    if (assumeSameDay) {
      // For same day, simply subtract milliseconds
      const diff = other.toMs - this.toMs;
      return Duration.Time.ms(diff as Ms);
    } else {
      // For shortest duration, consider both directions around the 24-hour clock
      const diff1 = other.toMs - this.toMs;
      const diff2 =
        diff1 > 0 ? diff1 - Time.MS_PER_DAY : diff1 + Time.MS_PER_DAY;

      // Return the one with smaller absolute value
      return Math.abs(diff1) <= Math.abs(diff2)
        ? Duration.Time.ms(diff1 as Ms)
        : Duration.Time.ms(diff2 as Ms);
    }
  }

  /**
   * Compares this time point to another
   * @param other - Another time point
   * @returns Negative if this is earlier, positive if later, 0 if equal
   */
  compareTo(other: TimeOfDay): number {
    return this.toMs - other.toMs;
  }

  /**
   * Alias for compareTo (for backward compatibility)
   * @param other - Another time point
   * @returns Negative if this is earlier, positive if later, 0 if equal
   */
  cmp(other: TimeOfDay): number {
    return this.compareTo(other);
  }

  /**
   * Returns the minimum of this time and another
   * @param other - Another time point
   * @returns The earlier time point
   */
  min(other: TimeOfDay): TimeOfDay {
    return this.isBefore(other) ? this : other;
  }

  /**
   * Returns the maximum of this time and another
   * @param other - Another time point
   * @returns The later time point
   */
  max(other: TimeOfDay): TimeOfDay {
    return this.isAfter(other) ? this : other;
  }

  /**
   * Checks if this time is before another time
   * @param other - Another time point
   * @returns True if this time is before other
   */
  isBefore(other: TimeOfDay): boolean {
    return this.compareTo(other) < 0;
  }

  /**
   * Checks if this time is after another time
   * @param other - Another time point
   * @returns True if this time is after other
   */
  isAfter(other: TimeOfDay): boolean {
    return this.compareTo(other) > 0;
  }

  /**
   * Checks if this time is equal to another time
   * @param other - Another time point
   * @returns True if times are equal
   */
  equals(other: TimeOfDay): boolean {
    return this.toMs === other.toMs;
  }

  /**
   * Rounds this time to the nearest multiple of the specified duration
   * @param nearest - Duration to round to (e.g., 15 minutes)
   * @returns A new TimeOfDay rounded to the nearest interval
   */
  roundToNearest(nearest: Duration.Time): TimeOfDay {
    const unitMs = nearest.toMs;
    if (unitMs <= 0) return this;

    const rounded = Math.round(this.toMs / unitMs) * unitMs;
    return TimeOfDay.wrap({ toMs: rounded as Ms });
  }

  /**
   * Rounds this time to the nearest multiple of the specified unit
   * Compatibility method for TimeUnit
   * @param unit - Time unit to round to
   * @param op - Rounding operation (default: Math.round)
   * @returns A new TimeOfDay
   */
  nearest(
    unit: DurationTime.Parts.Opt,
    op: (n: number) => number = Math.round,
  ): TimeOfDay {
    const unitMs = Ms.resolve(unit);
    if (unitMs <= 0) return this;
    const rounded = op(this.toMs / unitMs) * unitMs;
    return TimeOfDay.wrap({ toMs: rounded as Ms });
  }

  /**
   * Rounds this time to the nearest multiple of the specified unit
   * Alias for nearest
   * @param unit - Time unit to round to
   * @returns A new TimeOfDay
   */
  round(unit: DurationTime.Parts.Opt): TimeOfDay {
    return this.nearest(unit, Math.round);
  }

  /**
   * Rounds this time up to the nearest multiple of the specified unit
   * @param unit - Time unit to round to
   * @returns A new TimeOfDay
   */
  ceil(unit: DurationTime.Parts.Opt): TimeOfDay {
    return this.nearest(unit, Math.ceil);
  }

  /**
   * Rounds this time down to the nearest multiple of the specified unit
   * @param unit - Time unit to round to
   * @returns A new TimeOfDay
   */
  floor(unit: DurationTime.Parts.Opt): TimeOfDay {
    return this.nearest(unit, Math.floor);
  }

  /**
   * Formats this time as HH:MM:SS
   * @returns Time string in RFC3339 format (HH:MM:SS or HH:MM:SS.sss)
   */
  toRfc3339(): string {
    // Each field read once (each getter divides `toMs`); same text as padStart.
    const base = `${pad2(this.hrs)}:${pad2(this.mins)}:${pad2(this.secs)}`;
    const ms = this.ms;
    if (ms > 0) {
      // Append milliseconds if non-zero
      return `${base}.${ms >= 0 && ms < 100 ? (ms < 10 ? "00" : "0") + ms : ms.toString().padStart(3, "0")}`;
    } else {
      return base;
    }
  }

  /**
   * Formats this time as a string
   * @returns HH:MM:SS
   */
  toString(): string {
    return this.toRfc3339();
  }

  ical(): string {
    return [
      String(this.hrs).padStart(2, "0"),
      String(this.mins).padStart(2, "0"),
      String(this.secs).padStart(2, "0"),
    ].join("");
  }

  /**
   * Gets the total milliseconds as a property for compatibility
   */
  get asMs(): number {
    return this.toMs;
  }

  /**
   * Adds a duration to this TimeOfDay and returns a new TimeOfDay
   * @param duration - Duration to add
   * @returns A new TimeOfDay
   */
  add(duration: DurationTime.Parts.Opt): TimeOfDay {
    const durationMs = Ms.resolve(duration);
    const newMs = this.toMs + durationMs;
    const normalizedMs =
      ((newMs % Time.MS_PER_DAY) + Time.MS_PER_DAY) % Time.MS_PER_DAY;
    return new TimeOfDay(normalizedMs);
  }

  /**
   * Subtracts a duration from this TimeOfDay and returns a new TimeOfDay
   * @param duration - Duration to subtract
   * @returns A new TimeOfDay
   */
  sub(duration: DurationTime.Parts.Opt): TimeOfDay {
    const durationMs = Ms.resolve(duration);
    const newMs = this.toMs - durationMs;
    const normalizedMs =
      ((newMs % Time.MS_PER_DAY) + Time.MS_PER_DAY) % Time.MS_PER_DAY;
    return new TimeOfDay(normalizedMs);
  }

  /**
   * Multiplies this TimeOfDay by a scalar and returns a new TimeOfDay
   * @param scalar - Multiplier
   * @returns A new TimeOfDay
   */
  mult(scalar: number): TimeOfDay {
    const newMs = this.toMs * scalar;
    const normalizedMs =
      ((newMs % Time.MS_PER_DAY) + Time.MS_PER_DAY) % Time.MS_PER_DAY;
    return new TimeOfDay(normalizedMs);
  }

  /**
   * Formats this time with customizable options
   * @param options - Formatting options
   * @returns Formatted time string
   */
  format(options: TimeOfDay.Formatter.Options = {}): string {
    const {
      includeAmPm = false,
      // If includeAmPm is true, automatically use 12-hour format
      use24Hour = !includeAmPm,
      includeMins = true,
      includeSeconds = true,
      padHours = true,
      padMins = true,
      allCaps = false,
    } = options;

    // Determine hour format
    let hour = this.hrs;
    if (!use24Hour) {
      hour = hour % 12;
      if (hour === 0) hour = 12; // 12-hour clock: 0 becomes 12
    }

    const builder: string[] = [];
    builder.push(padHours ? hour.toString().padStart(2, "0") : hour.toString());

    const renderMins = includeMins || this.mins !== 0;
    if (renderMins) {
      builder.push(
        padMins ? this.mins.toString().padStart(2, "0") : this.mins.toString(),
      );
    }

    if (renderMins && includeSeconds) {
      builder.push(`${this.secs.toString().padStart(2, "0")}`);
    }

    let result = builder.join(":");
    // Add AM/PM indicator
    if (includeAmPm && !use24Hour) {
      const ampm = this.meridiem;
      if (allCaps) {
        result += ` ${ampm.toUpperCase()}`;
      } else {
        result += ` ${ampm}`;
      }
    }

    return result;
  }
}

export namespace TimeOfDay {
  export type Like = Hms.Parts & Ms.Parts & Ms.To.Opt;

  export namespace Like {
    export type Opt = Optional<Like>;
  }

  export namespace Formatter {
    export type Options = Optional<{
      includeAmPm: boolean;
      use24Hour: boolean;
      includeMins: boolean;
      includeSeconds: boolean;
      padHours: boolean;
      padMins: boolean;
      allCaps: boolean;
    }>;

    /**
     * Renders a TimeOfDay as a string
     * @param time - TimeOfDay to render
     * @param options - Formatting options
     * @returns Formatted time string
     */
    export function render(time: TimeOfDay, options?: Options): string {
      return time.format(options);
    }
  }

  /**
   * Represents a range between two time points
   */
  export class Range extends GenericRange<TimeOfDay> {
    endsOnNextDay: boolean;

    constructor(start: TimeOfDay, end: TimeOfDay, endsOnNextDay: boolean) {
      super(start, end);
      this.endsOnNextDay = endsOnNextDay;
    }

    /**
     * Gets the duration of this range
     */
    get duration(): Duration.Time {
      const end = this.endsOnNextDay
        ? this.end.duration().add(Duration.Time.DAY1)
        : this.end.duration();
      return end.sub(this.start.duration());
    }

    /**
     * Checks if a time point falls within this range (inclusive start, exclusive end)
     * @param time - Time point to check
     * @returns True if the time falls within the range
     */
    contains(time: TimeOfDay): boolean {
      const startMs = this.start.toMs;
      const endMs = this.end.toMs + (this.endsOnNextDay ? Time.MS_PER_DAY : 0);
      const pointMs = time.toMs;
      const nextPointMs = time.toMs + Time.MS_PER_DAY;

      return (
        (pointMs >= startMs && pointMs < endMs) ||
        (nextPointMs >= startMs && nextPointMs < endMs)
      );
    }

    containsInc(time: TimeOfDay): boolean {
      const startMs = this.start.toMs;
      const endMs = this.end.toMs + (this.endsOnNextDay ? Time.MS_PER_DAY : 0);
      const pointMs = time.toMs;
      const nextPointMs = time.toMs + Time.MS_PER_DAY;

      return (
        (pointMs >= startMs && pointMs <= endMs) ||
        (nextPointMs >= startMs && nextPointMs <= endMs)
      );
    }

    /**
     * Shifts this range by a duration
     * @param duration - Duration to shift by
     * @returns A new TimeOfDay.Range shifted by the duration
     */
    shift(duration: Duration.Time): Range {
      const startPoint = TimePoint.ms(this.start.toMs).add(duration);
      const endPoint = TimePoint.ms(this.end.toMs).add(duration);
      return new Range(
        startPoint.time,
        endPoint.time,
        startPoint.days !== endPoint.days,
      );
    }

    clamp(window: TimeOfDay.Range): TimeOfDay.Range {
      let start = this.start.max(window.start);
      let endDur = this.end
        .duration()
        .add(this.endsOnNextDay ? Duration.Time.DAY1 : Duration.Time.ZERO);
      let windowEndDur = window.end
        .duration()
        .add(window.endsOnNextDay ? Duration.Time.DAY1 : Duration.Time.ZERO);
      let end = endDur.min(windowEndDur) as Duration.Time;
      return new TimeOfDay.Range(
        start,
        new TimeOfDay(end.toMs % Time.MS_PER_DAY),
        Math.floor(end.toMs / Time.MS_PER_DAY) >= 1,
      );
    }

    endTp(): TimePoint {
      return new TimePoint(this.endsOnNextDay ? 1 : 0, this.end);
    }
  }

  /** Midnight time point (00:00:00) */
  export const ZERO = new TimeOfDay(0);

  /** Noon time point (12:00:00) */
  export const NOON = new TimeOfDay(12 * Time.MS_PER_HR);

  /** Common time for end of workday (17:00:00) */
  export const END_OF_WORKDAY = new TimeOfDay(17 * Time.MS_PER_HR);

  /** Common time for start of workday (09:00:00) */
  export const START_OF_WORKDAY = new TimeOfDay(9 * Time.MS_PER_HR);

  /** End of day (23:59:59.999) */
  export const END_OF_DAY = new TimeOfDay(Time.MS_PER_DAY - 1);

  export namespace Range {
    export const DAY = new Range(TimeOfDay.ZERO, TimeOfDay.ZERO, true);
  }
}

/** `n.toString().padStart(2, "0")`, without the call for the common single digit. */
function pad2(n: number): string {
  return n >= 0 && n < 10 ? "0" + n : n.toString().padStart(2, "0");
}
