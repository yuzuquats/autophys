import { GenericRange } from "../range.ts";
import { Result, erm, ok } from "../result.ts";

import { Time } from "../time.ts";
import { TentoMath } from "../utils.ts";
import { Day } from "./day.ts";
import { Hms } from "./hour-mins-secs.ts";
import { Meridiem } from "./meridiem.ts";
import { Ms } from "./ms.ts";
import { TimeOfDay } from "./time-of-day.ts";
import { TimePoint } from "./time-point.ts";
import { Signed } from "./units.ts";
import type { Option, Optional } from "../option.ts";

/**
 * TimeUnit represents a duration or point in time in terms of days, hours, minutes, seconds, and milliseconds.
 * It can represent both absolute time points (like a time of day) and time spans/durations.
 * All time values are stored internally as milliseconds for precise calculations.
 */
export class DurationTime
  implements DurationTime.Parts, Day.To, Day.ToF, Hms.To, Hms.ToF
{
  readonly sign: 1 | -1;

  /**
   * Creates a new TimeUnit
   * @param toMs - Time value in milliseconds
   */
  constructor(public readonly toMs: number) {
    this.sign = toMs >= 0 ? 1 : -1;
  }

  static rounded(toMs: number): DurationTime {
    return new DurationTime(Math.round(toMs));
  }

  static ms(ms: number): DurationTime {
    return new DurationTime(ms);
  }

  static secs(secs: number): DurationTime {
    return new DurationTime(secs * Time.MS_PER_SEC);
  }

  static mins(mins: number): DurationTime {
    return new DurationTime(mins * Time.MS_PER_MIN);
  }

  static hrs(hrs: number): DurationTime {
    return new DurationTime(hrs * Time.MS_PER_HR);
  }

  static dys(days: number): DurationTime {
    return new DurationTime(days * Time.MS_PER_DAY);
  }

  static from(delta: DurationTime.Parts.Opt): DurationTime {
    if (delta instanceof DurationTime) return delta;
    return new DurationTime(Ms.resolve(delta));
  }

  static hms(hms: Hms.Parts.Opt, sign: number = 1): DurationTime {
    if (hms instanceof DurationTime && sign === 1) return hms;
    const ms = Hms.toMs(hms);
    return new DurationTime(ms * sign);
  }

  static hmsStr(
    hours: Option<string> = null,
    minutes: Option<string> = null,
    seconds: Option<string> = null,
    sign: number = 1,
  ): Result<DurationTime> {
    const hrs = hours ? TentoMath.int(hours) : 0;
    if (Number.isNaN(hrs)) return erm(`parse/hrs: ${hours}`);

    const mins = minutes ? TentoMath.int(minutes) : 0;
    if (Number.isNaN(mins)) return erm(`parse/mins: ${minutes}`);

    const secs = seconds ? TentoMath.int(seconds) : 0;
    if (Number.isNaN(secs)) return erm(`parse/secs: ${seconds}`);

    const hms = {
      hrs,
      mins,
      secs,
    };
    if (!Hms.isStrict(hms)) {
      return erm(`parse/strict: ${JSON.stringify(hms)}`);
    }

    return ok(DurationTime.hms(hms, sign));
  }

  static parse(s: string): Result<DurationTime> {
    let sign = 1;
    let str = s;
    if (s.startsWith("-")) {
      sign = -1;
      str = s.substring(1);
    }
    const parts = str.split(":");
    if (parts.length === 2 || parts.length === 3) {
      return DurationTime.hmsStr(parts[0], parts[1], parts[2], sign);
    } else {
      return erm(`Invalid duration format: ${s}`);
    }
  }

  /**
   * Time components relative to their larger time unit.
   *
   * For example:
   * - days: Days component of the time
   * - hrs: Hours component of the time (0-23)
   * - mins: Minutes component of the time (0-59)
   * - secs: Seconds component of the time (0-59)
   * - ms: Milliseconds component of the time (0-999)
   *
   * Note: A small epsilon (0.01) is added to handle floating point precision errors
   */

  /** Seconds component (0-59) */
  get secs(): number {
    return Math.floor(this.secsF);
  }

  /** Minutes component (0-59) */
  get mins(): number {
    return Math.floor(this.minsF);
  }

  /** Hours component (0-23) */
  get hrs(): number {
    const hrs = Math.floor(this.hrsF);
    if (hrs >= 24) return hrs % 24;
    if (hrs < 0) return (24 + (hrs % 24)) % 24;
    return hrs;
  }

  /** Days component of this time */
  get days(): Day {
    return Math.floor(this.daysF) as Day;
  }

  /** Milliseconds component (0-999) */
  get ms(): Ms {
    return (Math.abs(this.toMs) % Time.MS_PER_SEC) as Ms;
  }

  /** Days component as a float (can be fractional) */
  get daysF(): number {
    return this.toMs / Time.MS_PER_DAY;
  }

  /** Hours component as a float (can be fractional) */
  get hrsF(): number {
    return (Math.abs(this.toMs) % Time.MS_PER_DAY) / Time.MS_PER_HR;
  }

  /** Minutes component as a float (can be fractional) */
  get minsF(): number {
    return (Math.abs(this.toMs) % Time.MS_PER_HR) / Time.MS_PER_MIN;
  }

  /** Seconds component as a float (can be fractional) */
  get secsF(): number {
    return (Math.abs(this.toMs) % Time.MS_PER_MIN) / Time.MS_PER_SEC;
  }

  /**
   * Time values as absolute quantities from zero.
   *
   * These properties represent total amounts:
   * - asMs: Total milliseconds
   * - asDays: Total days (floored)
   * - asHrs: Total hours (floored)
   * - asMins: Total minutes (floored)
   * - asSecs: Total seconds (floored)
   *
   * And as floating point numbers:
   * - asDaysF: Total days as float
   * - asHrsF: Total hours as float
   * - asMinsF: Total minutes as float
   * - asSecsF: Total seconds as float
   */

  /** Total days (integer) */
  get toDays(): number {
    return Math.floor(this.toDaysF);
  }

  get toDaysF(): number {
    return this.toMs * Time.MS_PER_DAY_INV;
  }

  /**
   * implements Hms.To
   */
  get toHrs(): number {
    return Math.round(this.toHrsF);
  }

  /** Total minutes (integer) */
  get toMins(): number {
    return Math.floor(this.toMinsF);
  }

  /** Total seconds (integer) */
  get toSecs(): number {
    return Math.floor(this.toSecsF);
  }

  /**
   * implements Hms.ToF
   */
  get toHrsF(): number {
    // NOTE: multiplying with MS_PER_HR_INV introduces floating point precision errors
    return this.toMs / Time.MS_PER_HR;
  }

  get toMinsF(): number {
    return this.toMs / Time.MS_PER_MIN;
  }

  get toSecsF(): number {
    return this.toMs / Time.MS_PER_SEC;
  }

  /** Get the meridiem (am/pm) for this time */
  get meridiem(): Meridiem {
    return this.toMs >= Time.MS_PER_DAY / 2 ? "pm" : "am";
  }

  /**
   * Operators
   */

  /**
   * Adds a time unit to this one
   * @param delta - Time to add
   * @returns New TimeUnit with the sum
   */
  add(delta: DurationTime.Parts.Opt): DurationTime {
    return new DurationTime(this.toMs + DurationTime.from(delta).toMs);
  }

  /**
   * Subtracts a time unit from this one
   * @param delta - Time to subtract
   * @returns New TimeUnit with the difference
   */
  sub(delta: DurationTime.Parts.Opt): DurationTime {
    return new DurationTime(this.toMs - DurationTime.from(delta).toMs);
  }

  /**
   * Multiplies this time unit by a scalar
   * @param scalar - Multiplier
   * @returns New TimeUnit with scaled value
   */
  mult(scalar: number): DurationTime {
    return new DurationTime(this.toMs * scalar);
  }

  /**
   * Multiplies this time unit by a scalar
   * @param scalar - Multiplier
   * @returns New TimeUnit with scaled value
   */
  div(scalar: number): DurationTime {
    if (scalar === 0) throw new Error("div by 0");
    return new DurationTime(this.toMs / scalar);
  }

  /**
   * Returns the smaller of this TimeUnit and another
   * @param other - TimeUnit to compare with
   * @returns The smaller TimeUnit
   */
  min(other: DurationTime.Parts.Opt): DurationTime.Parts.Opt {
    if (other == null) return this;
    const otherMs = Ms.resolve(other);
    return this.toMs <= otherMs ? this : other;
  }

  /**
   * Returns the larger of this TimeUnit and another
   * @param other - TimeUnit to compare with
   * @returns The larger TimeUnit
   */
  max(other: DurationTime.Parts.Opt): DurationTime.Parts.Opt {
    if (other == null) return this;
    const otherMs = Ms.resolve(other);
    return this.toMs >= otherMs ? this : other;
  }

  /**
   * Compares this TimeUnit with another
   * @param other - TimeUnit to compare with
   * @returns Negative if this is smaller, positive if larger, 0 if equal
   */
  cmp(other: DurationTime.Parts.Opt): number {
    if (other == null) return 1;
    const otherMs = Ms.resolve(other);
    return this.toMs - otherMs;
  }

  nearest(
    nearest: DurationTime.Parts.Opt,
    op: (n: number) => number = Math.round,
  ): DurationTime {
    const nearestTu = DurationTime.from(nearest);
    const multiple = op(this.toMs / nearestTu.toMs);
    return new DurationTime(multiple * nearestTu.toMs * this.sign);
  }

  round(nearest: DurationTime.Parts.Opt): DurationTime {
    return this.nearest(nearest);
  }

  floor(floor: DurationTime.Parts.Opt): DurationTime {
    return this.nearest(floor, Math.floor);
  }

  ceil(ceil: DurationTime.Parts.Opt): DurationTime {
    return this.nearest(ceil, Math.ceil);
  }

  equals(other: DurationTime): boolean {
    // Compare the entire millisecond value, not just the ms component
    return this.toMs === other.toMs;
  }

  /**
   * Display
   * ===========================================================================
   */

  /**
   * Formats this duration as a string
   * @param options - Formatting options
   * @returns Formatted duration string
   */
  format(
    options: {
      showMilliseconds?: boolean;
      showSeconds?: boolean;
      compact?: boolean;
      padValues?: boolean;
    } = {},
  ): string {
    const {
      showMilliseconds = false,
      showSeconds = true,
      compact = false,
      padValues = true,
    } = options;

    const sign = this.sign < 0 ? "-" : "";

    const absHrs = Math.abs(this.hrs);
    const absMins = Math.abs(this.mins);
    const absSecs = Math.abs(this.secs);
    const absMs = Math.abs(this.ms);

    // Compact format (3h 15m 20s)
    if (compact) {
      const parts: string[] = [];
      if (absHrs > 0) parts.push(`${absHrs}h`);
      if (absMins > 0 || (parts.length === 0 && absSecs === 0 && absMs === 0))
        parts.push(`${absMins}m`);
      if (showSeconds && (absSecs > 0 || (parts.length === 0 && absMs === 0)))
        parts.push(`${absSecs}s`);
      if (showMilliseconds && absMs > 0) parts.push(`${absMs}ms`);
      return sign + parts.join(" ");
    }

    // Standard format (HH:MM:SS)
    const hoursStr = padValues
      ? absHrs.toString().padStart(2, "0")
      : absHrs.toString();
    const minsStr = padValues
      ? absMins.toString().padStart(2, "0")
      : absMins.toString();

    let formatted = `${hoursStr}:${minsStr}`;
    if (!showSeconds) return sign + formatted;

    const secsStr = padValues
      ? absSecs.toString().padStart(2, "0")
      : absSecs.toString();
    formatted += `:${secsStr}`;
    if (!showMilliseconds || absMs <= 0) return sign + formatted;

    const msStr = padValues
      ? absMs.toString().padStart(3, "0")
      : absMs.toString();
    formatted += `.${msStr}`;
    return sign + formatted;
  }

  formatReadable(): string {
    return DEFAULT_FORMATTER.format(this);
  }

  asSignedHm(elidMins: boolean = false): string {
    const totalMillis = Math.abs(this.toMs);
    const totalSeconds = Math.floor(totalMillis / Time.MS_PER_SEC);
    const offsetHours = Math.floor(totalSeconds / 3600);
    const offsetMinutes = Math.floor((totalSeconds % 3600) / 60);
    const offsetSeconds = totalSeconds % 60;
    const renderMins = offsetMinutes !== 0 || offsetSeconds !== 0 || !elidMins;
    const renderSecs = offsetSeconds !== 0;

    return [
      this.sign > 0 ? "+" : "-",
      offsetHours.toString().padStart(2, "0"),
      renderMins ? ":" : "",
      renderMins ? offsetMinutes.toString().padStart(2, "0") : "",
      renderSecs ? ":" : "",
      renderSecs ? offsetSeconds.toString().padStart(2, "0") : "",
    ].join("");
  }

  dbg(): string {
    return (
      (this.sign === -1 ? "-" : "") +
      [
        Math.floor(Math.abs(this.toHrsF)).toString().padStart(2, "0"),
        Math.abs(this.mins).toString().padStart(2, "0"),
        Math.abs(this.secs).toString().padStart(2, "0"),
      ].join(":")
    );
  }

  formatLatency(): string {
    const ms = Math.abs(this.toMs);
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    return `${Math.round(s)}s`;
  }

  toString(): string {
    return this.asSignedHm();
  }

  toTimeOfDayWrapping(): TimeOfDay {
    return TimePoint.ms(this.toMs).time;
  }
}

export namespace DurationTime {
  /**
   * Divides milliseconds by day, returning quotient and remainder
   * @param ms - Milliseconds from [-Inf..Inf]
   *    -5s represents 5s before midnight, ie. 23:59:55
   * @returns Object with days (div) and remaining milliseconds (rem)
   */
  export function divByDay(ms: number): { div: Day; rem: Ms } {
    const rem = TentoMath.mod(ms, Time.MS_PER_DAY) as Ms;
    return {
      div: Math.floor(ms / Time.MS_PER_DAY) as Day,
      rem,
    };
  }

  export const ZERO: DurationTime = DurationTime.rounded(0);
  export const HOUR: DurationTime = DurationTime.hrs(1);
  export const HOUR24: DurationTime = DurationTime.hrs(24);
  export const MIN15: DurationTime = DurationTime.mins(15);
  export const MIN5: DurationTime = DurationTime.mins(5);
  export const DAY1: DurationTime = DurationTime.dys(1);

  export function msToString(
    ms: number,
    formatter: TimeDeltaFormatter = DEFAULT_FORMATTER,
  ): string {
    return formatter.format(
      DurationTime.from({
        ms,
      }),
    );
  }

  /**
   * Interface representing time units with days, hours, minutes, seconds, and milliseconds
   */
  export type Parts = Hms.Parts & Ms.To & Ms.Parts & Day.Parts & Signed.Parts;

  export namespace Parts {
    export type Opt = Optional<Parts>;
  }

  export class Range extends GenericRange<DurationTime> {
    get length(): DurationTime {
      return this.end.sub(this.start);
    }

    overlapsWith(startHr: number, durationHr: number): boolean {
      if (startHr >= this.start.toHrsF && startHr <= this.end.toHrsF) {
        return true;
      }
      const endHr = startHr + durationHr;
      if (endHr >= this.start.toHrsF && endHr <= this.end.toHrsF) return true;
      return false;
    }

    contains(time: DurationTime): boolean {
      return time.toHrsF >= this.start.toHrsF && time.toHrsF <= this.end.toHrsF;
    }

    duration(): DurationTime {
      return this.end.sub(this.start);
    }
  }

  export namespace Range {
    export const DAY: DurationTime.Range = new DurationTime.Range(
      DurationTime.ZERO,
      DurationTime.HOUR24,
    );
  }

  export namespace Formatter {
    export type Options = Optional<{
      includeAmPm: boolean;
      allCaps: boolean;
      includeMinutes: boolean;
      use24Hours: boolean;
    }>;

    export function createReadableHourString(
      hour: number,
      min: number,
      options?: Options,
    ): string {
      const { allCaps, includeAmPm, includeMinutes, use24Hours } = {
        allCaps: options?.allCaps ?? true,
        includeAmPm: options?.includeAmPm ?? true,
        includeMinutes: options?.includeMinutes ?? true,
        use24Hours: options?.use24Hours ?? false,
      };
      const hoursMod = use24Hours ? 24 : 12;

      let amPm = hour >= 12 ? "pm" : "am";
      if (allCaps) {
        amPm = amPm.toUpperCase();
      }
      let displayHour = hour % hoursMod;
      displayHour = displayHour === 0 ? hoursMod : displayHour;
      min = Math.round(min);
      if (min === 0 && !includeMinutes) {
        return includeAmPm ? `${displayHour} ${amPm}` : String(displayHour);
      } else {
        const timeStr = `${displayHour}:${min.toString().padStart(2, "0")}`;
        return includeAmPm ? `${timeStr} ${amPm}` : timeStr;
      }
    }

    export function render(
      time: DurationTime,
      options?: {
        includeAmPm?: boolean;
        allCaps?: boolean;
        includeMinutes?: boolean;
      },
    ): string {
      return Formatter.createReadableHourString(time.hrs, time.mins, options);
    }
  }
}

export interface TimeDeltaFormatter {
  format(delta: DurationTime): string;
}

export class EnTimeDeltaFormatter implements TimeDeltaFormatter {
  static pluralize(s: string, n: number): string {
    if (n > 1) return s + "s";
    return s;
  }

  format(delta: DurationTime): string {
    const pluralize = EnTimeDeltaFormatter.pluralize;
    const sb: string[] = [];
    if (delta.days !== 0) {
      sb.push(`${delta.days} ${pluralize("day", delta.days)}`);
    }
    if (delta.hrs > 0) {
      sb.push(`${delta.hrs} ${pluralize("hour", delta.hrs)}`);
    }
    if (delta.mins > 0) {
      sb.push(`${delta.mins} ${pluralize("min", delta.mins)}`);
    }
    if (delta.secs > 0) {
      sb.push(`${delta.secs} ${pluralize("sec", delta.secs)}`);
    }
    return sb.join(", ");
  }
}

export const DEFAULT_FORMATTER = new EnTimeDeltaFormatter();
