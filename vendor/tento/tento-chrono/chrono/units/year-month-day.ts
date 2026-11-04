import { Gecko } from "../impl.ts";
import { GenericRange } from "../range.ts";
import { Result, erm, ok } from "../result.ts";

import { err } from "../result.ts";
import { DateUnit } from "./date-unit.ts";
import { Month } from "./month.ts";
import {
  DayOfMonth,
  DayOfMonth0,
  DayOfMonth1,
  DayOfWeek1,
  DayOfYear1,
  DaysSinceEpoch,
  Month0,
  Month1,
  MonthOfYear,
  MsSinceEpoch,
  SecsSinceEpoch,
  WeekOfYear1,
  WeeksSinceEpoch1,
} from "./units.ts";
import { Weekday } from "./weekday.ts";
import { Year } from "./year.ts";

import { NaiveDate } from "../naive-date.ts";
import { NaiveDateTime } from "../naive-datetime.ts";
import { Time } from "../time.ts";
import { PartialDate } from "./partial-date.ts";
import { TimeOfDay } from "./time-of-day.ts";
import { Week, Yw1Like } from "./week.ts";
import { YearMonth, YmLike } from "./year-month.ts";
import { YearMonthDayFilter } from "./year-month-day-filter.ts";
import type { Option, Optional } from "../option.ts";

export interface YmdLike<Index> extends YmLike<Index> {
  readonly yr: number;
  readonly mth: MonthOfYear<Index>;
  readonly day: DayOfMonth<Index>;
}

export type YmdPartialLike<Index> = Optional<YmdLike<Index>>;
export type Ymd1Like = YmdLike<1>;
export type Ymd0Like = YmdLike<0>;

export type Ymd1LikeOpt = Optional<Ymd1Like>;

export namespace Ymd1Like {
  export const fromDse = Gecko.makeYmd;

  export function daysSinceEpoch(ymd: Ymd1Like): DaysSinceEpoch {
    return (Year.dseFromYear(ymd.yr) +
      YearMonth.doyForMonthStart(ymd) +
      ymd.day -
      1) as DaysSinceEpoch;
  }
  export const dse = daysSinceEpoch;

  export function dayOfWeek(ymd: Ymd1Like): DayOfWeek1 {
    return Weekday.fromDse(Ymd1Like.dse(ymd));
  }

  export function dayOfYear(ymd: Ymd1Like): DayOfYear1 {
    return (Month.MONTH_START_OF_YEAR[Year.isLeapYear(ymd.yr) ? 1 : 0][
      ymd.mth - 1
    ] + ymd.day) as DayOfYear1;
  }
}

export type CachedYmdInfo = {
  dayOfWeek: Weekday;
  dse: DaysSinceEpoch;
  isValid: boolean;
  validationError: Error;
  isoYw1: Yw1Like;
  rfc3339: string;
};

class _YearMonthDay implements Ymd1Like {
  constructor(
    public readonly ymd1: Ymd1Like,
    public readonly cached: Optional<CachedYmdInfo> = {},
  ) {}

  #validationError(): Option<Error> {
    if (this.month1 < 1 || this.month1 > 12) return Error("month/bounds");
    if (!YearMonth.isDayValid(this, this.day)) return Error("day/bounds");
    return null;
  }

  toResult(): Result<YearMonthDay.Valid> {
    if (this.cached.isValid != null && !this.cached.isValid) {
      return err(this.cached.validationError!);
    }
    const verr = this.#validationError();
    if (verr) {
      this.cached.isValid = false;
      return err((this.cached.validationError = verr));
    }

    this.cached.isValid = true;
    return ok(this as unknown as YearMonthDay.Valid);
  }

  assertValid(): YearMonthDay.Valid {
    return this.toResult().exp();
  }

  isValid(): boolean {
    return this.toResult().isOk;
  }

  castValid(): YearMonthDay.Valid {
    return this as unknown as YearMonthDay.Valid;
  }

  castMaybeInValid(): YearMonthDay.MaybeValid {
    return this as unknown as YearMonthDay.MaybeValid;
  }

  /**
   * [Interface] Ymd1
   */
  get yr(): number {
    return this.ymd1.yr;
  }
  get mth(): Month1 {
    return this.ymd1.mth;
  }
  get day(): DayOfMonth1 {
    return this.ymd1.day;
  }

  /**
   * [Getters] Month
   */
  get month(): Month {
    return Month.MONTHS0[this.month0];
  }

  get month0(): Month0 {
    return (this.ymd1.mth - 1) as Month0;
  }

  get month1(): Month1 {
    return this.ymd1.mth;
  }

  /**
   * [Getters] Week-Day
   */
  get dayOfWeek(): Weekday {
    if (this.cached.dayOfWeek) return this.cached.dayOfWeek;
    return (this.cached.dayOfWeek =
      Weekday.DOW1[Weekday.fromDse(this.dse) - 1]);
  }

  /**
   * [Getters] Month-Day
   */
  get day0(): DayOfMonth0 {
    return (this.ymd1.day - 1) as DayOfMonth0;
  }

  get day1(): DayOfMonth1 {
    return this.ymd1.day;
  }

  get dayOfMonth(): DayOfMonth1 {
    return this.ymd1.day;
  }

  /**
   * [Getters] Year-Day
   */
  get dayOfYear(): DayOfYear1 {
    return Ymd1Like.dayOfYear(this);
  }

  get daysSinceEpoch(): DaysSinceEpoch {
    return this.dse;
  }

  get dse(): DaysSinceEpoch {
    if (this.cached.dse != null) return this.cached.dse;
    return (this.cached.dse = Ymd1Like.daysSinceEpoch(this.ymd1));
  }

  get mse(): MsSinceEpoch {
    return (this.dse * Time.MS_PER_DAY) as MsSinceEpoch;
  }

  get sse(): SecsSinceEpoch {
    return ((this.dse * Time.MS_PER_DAY) / 1000) as SecsSinceEpoch;
  }

  _isoYw1(): Yw1Like {
    // 1) Find the Monday of this year's ISO week #1
    //    (the week containing Jan 4)
    const jan4 = YearMonthDay.fromYmd1Exp(this.yr, 1, 4);
    const jan4dowIso = jan4.dayOfWeek.isoDow1;

    const thisYearFirstIsoMon = jan4.addDays(-(jan4dowIso - 1));

    const diffDays = this.differenceInDays(thisYearFirstIsoMon);
    let weekNumber = Math.floor(diffDays / 7) + 1;

    // 2) If <1, spill into previous year's last ISO week
    if (weekNumber < 1) {
      const prevYear = this.yr - 1;
      const prevJan4 = YearMonthDay.fromYmd1Exp(prevYear, 1, 4);
      const pj4dowIso = prevJan4.dayOfWeek.isoDow1;
      const prevYearFirstIsoMon = prevJan4.addDays(-(pj4dowIso - 1));
      const diffDaysPrev = this.differenceInDays(prevYearFirstIsoMon);
      return {
        yr: prevYear,
        wno: (Math.floor(diffDaysPrev / 7) + 1) as WeekOfYear1,
      };
    }

    // 3) Possibly spill into next year's first ISO week
    //    e.g. 2024-12-30 is the Monday of 2025's week #1
    const nextYear = this.yr + 1;
    const nextJan4 = YearMonthDay.fromYmd1Exp(nextYear, 1, 4);
    const nj4dowIso = nextJan4.dayOfWeek.isoDow1;
    const nextYearFirstIsoMon = nextJan4.addDays(-(nj4dowIso - 1));
    const diffDaysNext = this.differenceInDays(nextYearFirstIsoMon);
    if (diffDaysNext >= 0) {
      return {
        yr: nextYear,
        wno: 1 as WeekOfYear1,
      };
    }

    return {
      yr: this.yr,
      wno: weekNumber as WeekOfYear1,
    };
  }

  get isoYw1(): Yw1Like {
    if (this.cached.isoYw1) return this.cached.isoYw1;
    return (this.cached.isoYw1 = this._isoYw1());
  }

  get isoYear(): number {
    return this.isoYw1.yr;
  }

  get isoWno(): WeekOfYear1 {
    return this.isoYw1.wno;
  }

  get wse(): WeeksSinceEpoch1 {
    return Week.weeksSinceEpoch(this.isoYw1);
  }

  /**
   * Ops
   */
  addYears(yrs: number): YearMonthDay.MaybeValid {
    if (yrs === 0) return this.castMaybeInValid();
    return YearMonthDay.fromYmd1Unchecked(this.yr + yrs, this.month1, this.day);
  }

  addMonths(mths: number): YearMonthDay.MaybeValid {
    if (mths === 0) return this.castMaybeInValid();
    const { yr, mth } = YearMonth.add(this, { mth: mths as Option<Month0> });
    return YearMonthDay.fromYmd1Unchecked(yr, mth, this.day);
  }

  // static addDays<Valid>(
  //   nd: YearMonthDay<Valid>,
  //   days: number
  // ): YearMonthDay<Valid> {
  //   /**
  //    * If the original date is
  //    *    ...invalid, it will become MaybeValid
  //    *    ...valid, it will stay valid
  //    *    ...maybeInvalid, it will stay maybeInvalid
  //    *
  //    * If the caller wants to promote an invalid day to an valid day by adding
  //    * days, they must call .check(). This function (and the typesystem) will
  //    * not be able to do it automatically.
  //    */
  //   if (days === 0) return nd;
  //   return YearMonthDay.fromDse(
  //     (nd.dse + days) as DaysSinceEpoch
  //   ) as YearMonthDay<Valid>;
  // }

  addDaysOpt(days: number): YearMonthDay.MaybeValid {
    if (days === 0) return this.castMaybeInValid();
    // O(1) path via DSE arithmetic for large offsets (scroll engine hot path)
    if (days > 365 || days < -365) {
      const ymd = Ymd1Like.fromDse((this.dse + days) as DaysSinceEpoch);
      return YearMonthDay.fromYmd1Unchecked(ymd.yr, ymd.mth, ymd.day);
    }
    // O(days) path for small offsets — handles edge cases (3-digit years etc.)
    let d = this.day + days;
    let yr = this.ymd1.yr;
    let mth = this.ymd1.mth;
    let daysInMonth = YearMonth.daysInMonth({ yr, mth });
    while (d > daysInMonth) {
      d -= daysInMonth;
      mth = (mth + 1) as Month1;
      if (mth > 12) {
        mth = 1 as Month1;
        yr += 1;
      }
      daysInMonth = YearMonth.daysInMonth({ yr, mth });
    }
    while (d <= 0) {
      mth = (mth - 1) as Month1;
      if (mth <= 0) {
        mth = 12 as Month1;
        yr -= 1;
      }
      daysInMonth = YearMonth.daysInMonth({ yr, mth });
      d += daysInMonth;
    }
    return YearMonthDay.fromYmd1Unchecked(yr, mth, d);
  }

  addDays(days: number): YearMonthDay.Valid {
    return this.addDaysOpt(days).assertValid();
  }

  addWeeks(weeks: number): YearMonthDay.Valid {
    return this.addDays(weeks * 7);
  }

  addOpt(delta: DateUnit.Parts.Opt, sign: number = 1): YearMonthDay.MaybeValid {
    let dt = this.castMaybeInValid();
    if (delta.yrs) {
      dt = dt.addYears(delta.yrs * sign);
    }
    if (delta.mths) {
      dt = dt.addMonths(delta.mths * sign);
    }
    if (delta.wks) {
      dt = dt.addWeeks(delta.wks * sign);
    }
    if (delta.days) {
      dt = dt.addDaysOpt(delta.days * sign);
    }
    return dt;
  }

  add(delta: DateUnit.Parts.Opt): YearMonthDay.Valid {
    return this.addOpt(delta).assertValid();
  }

  sub(delta: DateUnit.Parts.Opt): YearMonthDay.Valid {
    return this.addOpt(delta, -1).assertValid();
  }

  differenceInDays(other: YearMonthDay): number {
    return this.dse - other.dse;
  }

  differenceInMonths(other: YearMonthDay.MaybeValid): number {
    return (this.yr - other.yr) * 12 + (this.month1 - other.month1);
  }

  toStartOfMonth(iso: boolean = false): YearMonthDay {
    return iso
      ? YearMonth.isoStartMon(this)
      : YearMonthDay.fromYmd1Exp(this.yr, this.mth, 1);
  }

  toStartOfWeekSun(): YearMonthDay {
    return this.addDays(-this.dayOfWeek.dow + 1).assertValid();
  }

  toStartOfWeekMon(): YearMonthDay {
    return this.addDays(-this.dayOfWeek.dow + 2).assertValid();
  }

  mthIsoStart(): YearMonthDay {
    return YearMonth.isoStartMon(this);
  }

  mthStart(): YearMonthDay {
    return YearMonthDay.fromYmd1Exp(this.yr, this.mth, 1);
  }

  withTime(timeOfDay: TimeOfDay = TimeOfDay.ZERO): NaiveDateTime {
    return new NaiveDateTime(this.assertValid(), timeOfDay);
  }

  toPartialExp(): YearMonthDay.Partial {
    return YearMonthDay.Partial.fromDate(this.assertValid());
  }

  /**
   * Eq/Cmp
   */
  cmpInvalid(other: YearMonthDay.MaybeValid): number {
    if (this.yr !== other.yr) return this.yr - other.yr;
    if (this.mth !== other.mth) return this.mth - other.mth;
    return this.day - other.day;
  }

  isBefore(other: YearMonthDay.MaybeValid): boolean {
    return this.cmpInvalid(other) < 0;
  }

  equals(other: YearMonthDay.MaybeValid): boolean {
    return this.cmpInvalid(other) === 0;
  }

  /**
   * For a given startdate: 2024-11-25
   *
   * Generates:
   *   Years: 2024, 2025, 2026, ...
   *   Months: 2024/11, 2024/12, 2025/1, ...
   *   Days: 2024/11/25, 2024/11/26, ...
   *   Weeks: 2024/11/25, 2024/12/2, ...
   */
  succ(
    step: DateUnit,
    recurLimit: number = 10_000,
  ): Generator<YearMonthDay.MaybeValid> {
    return YearMonthDay.ndsucc(this.castMaybeInValid(), step, recurLimit);
  }

  rangeProps(props: YearMonthDay.FilterProps): Generator<YearMonthDay> {
    return this.range(props.step, props.options);
  }

  range(
    step: DateUnit = DateUnit.days(1),
    options: Option<
      Optional<{
        end: YearMonthDay; // inclusive
        limit: number;
        recurLimit: number;
        onExhausted: () => void;
        filter: YearMonthDay.Filter | YearMonthDay.Filter[];
        weekStart: Weekday;
      }>
    > = null,
  ): Generator<YearMonthDay> {
    const recurLimit = options?.recurLimit ?? 5_000;
    const start = this.castMaybeInValid();
    const filterr = options?.filter ?? YearMonthDay.Filter.identity();
    const filter = Array.isArray(filterr)
      ? YearMonthDay.Filter.compose(filterr)
      : filterr;
    return YearMonthDay.ndrange({
      start,
      step,
      filter,
      recurLimit,
      onExhausted: options?.onExhausted,
      end: options?.end,
      limit: options?.limit,
      weekStart: options?.weekStart ?? start.dayOfWeek,
    });
  }

  /**
   * toString
   */
  toString(): string {
    return this.rfc3339();
  }

  toJSON(): string {
    return this.rfc3339();
  }

  rfc3339(): string {
    if (this.cached.rfc3339 != null) return this.cached.rfc3339;
    // `YYYY-MM-DD`: the year is always four digits (RFC 3339 §5.6
    // `date-fullyear = 4DIGIT`), formatted directly because every occurrence
    // id formats a fresh date.
    const y = this.yr;
    const m = this.month1;
    const d = this.day1;
    const year = y >= 1000 ? String(y) : y >= 0 ? String(y).padStart(4, "0") : String(y);
    return (this.cached.rfc3339 = `${year}-${m >= 0 && m < 10 ? "0" + m : String(m).padStart(2, "0")}-${
      d >= 0 && d < 10 ? "0" + d : String(d).padStart(2, "0")
    }`);
  }

  ical(): string {
    return [
      String(this.yr),
      String(this.mth).padStart(2, "0"),
      String(this.day).padStart(2, "0"),
    ].join("");
  }

  format(): string {
    return `${this.month.shortName} ${this.dayOfMonth}, ${this.yr}`;
  }
}

export type YearMonthDay<isValid = "valid"> = _YearMonthDay & {
  readonly __is_valid: isValid;
};

export namespace YearMonthDay {
  export const Class = _YearMonthDay;
  export type Serialized = string;

  export type Valid = YearMonthDay<"valid">;
  export type MaybeValid = YearMonthDay<"valid" | "invalid">;
  export type Invalid = YearMonthDay<"invalid">;

  export type FilterPropsOptions = Optional<{
    end: YearMonthDay; // inclusive
    limit: number;
    recurLimit: number;
    onExhausted: () => void;
    filter: YearMonthDay.Filter | YearMonthDay.Filter[];
    weekStart: Weekday;
  }>;

  export type FilterProps = {
    step: DateUnit;
    options?: Option<FilterPropsOptions>;
  };

  /*
   * [Constructors]
   */
  export function fromYmd1Unchecked(
    year: number,
    month1: number,
    day1: number,
  ): YearMonthDay.MaybeValid {
    return new _YearMonthDay({
      yr: year,
      mth: month1 as Month1,
      day: day1 as DayOfMonth1,
    }) as YearMonthDay.MaybeValid;
  }

  export function fromYmd1Exp(
    year: number,
    month1: number,
    day1: number,
  ): YearMonthDay {
    return YearMonthDay.fromYmd1Unchecked(year, month1, day1).toResult().exp();
  }

  export function fromYmd1(
    year: number,
    month1: number,
    day1: number,
  ): Result<YearMonthDay> {
    return YearMonthDay.fromYmd1Unchecked(year, month1, day1).toResult();
  }

  export function fromRfc3339(s: string): Result<YearMonthDay> {
    const [yr, mth, day] = s.split("-");
    return YearMonthDay.fromYmd1Str(yr, mth, day);
  }

  export function parse(s: string): YearMonthDay {
    return YearMonthDay.fromRfc3339(s).exp();
  }

  export function parseOpt(s: Option<string>): Option<YearMonthDay> {
    if (!s) return null;
    return YearMonthDay.parse(s);
  }

  /**
   * Parses a date string in various formats:
   * - ISO/RFC3339 format: YYYY-MM-DD
   * - US format: MM/DD/YYYY or MM-DD-YYYY
   * - European format: DD.MM.YYYY or DD/MM/YYYY
   * - Compact format: YYYYMMDD
   *
   * Returns a Result with either the parsed date or an error
   */
  export function parseFlexible(value: string): Result<YearMonthDay> {
    if (!value) return erm("empty input");

    // Remove any extra whitespace
    value = value.trim();

    // Try ISO format first (YYYY-MM-DD)
    const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
      const [, year, month, day] = isoMatch;
      return YearMonthDay.fromYmd1(
        Number.parseInt(year, 10),
        Number.parseInt(month, 10),
        Number.parseInt(day, 10),
      );
    }

    // Try US format (MM/DD/YYYY or MM-DD-YYYY)
    const usMatch = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (usMatch) {
      const [, month, day, year] = usMatch;
      return YearMonthDay.fromYmd1(
        Number.parseInt(year, 10),
        Number.parseInt(month, 10),
        Number.parseInt(day, 10),
      );
    }

    // Try European format (DD.MM.YYYY or DD/MM/YYYY)
    const euMatch = value.match(/^(\d{1,2})[\.\/](\d{1,2})[\.\/](\d{4})$/);
    if (euMatch) {
      const [, day, month, year] = euMatch;
      return YearMonthDay.fromYmd1(
        Number.parseInt(year, 10),
        Number.parseInt(month, 10),
        Number.parseInt(day, 10),
      );
    }

    // Try compact format (YYYYMMDD)
    const compactMatch = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compactMatch) {
      const [, year, month, day] = compactMatch;
      return YearMonthDay.fromYmd1(
        Number.parseInt(year, 10),
        Number.parseInt(month, 10),
        Number.parseInt(day, 10),
      );
    }

    // Try parsing with fromRfc3339 as fallback
    return YearMonthDay.fromRfc3339(value);
  }

  /**
   * Parses a date string in various formats, returning null if parsing fails
   */
  export function parseFlexibleOpt(
    value: Option<string>,
  ): Option<YearMonthDay> {
    if (!value) return null;
    const result = YearMonthDay.parseFlexible(value);
    if (!result.isOk) return null;
    return result.exp();
  }

  export function fromYmd1Str(
    year: string,
    month1: string,
    day1: string,
  ): Result<YearMonthDay> {
    const yr = Number.parseInt(year);
    if (Number.isNaN(yr)) return erm(`parse/yr: ${year}`);

    const mth = Number.parseInt(month1);
    if (Number.isNaN(mth)) return erm(`parse/mth: ${month1}`);

    const day = Number.parseInt(day1);
    if (Number.isNaN(day)) return erm(`parse/day: ${day}`);

    return YearMonthDay.fromYmd1(yr, mth, day);
  }

  export function fromYmd0(
    year: number,
    month0: number,
    day0: number,
  ): YearMonthDay.MaybeValid {
    return new _YearMonthDay({
      yr: year,
      mth: (month0 + 1) as Month1,
      day: (day0 + 1) as DayOfMonth1,
    }) as YearMonthDay.MaybeValid;
  }

  export function fromDse(dse: DaysSinceEpoch): YearMonthDay {
    return new _YearMonthDay(Ymd1Like.fromDse(dse)) as YearMonthDay;
  }

  export function fromMse(mse: MsSinceEpoch): YearMonthDay {
    return YearMonthDay.fromDse(
      Math.floor(mse * Time.MS_PER_DAY_INV) as DaysSinceEpoch,
    );
  }

  export let _today: Option<Valid>;
  export function today(): Valid {
    if (_today) return _today;
    const date = new Date();
    return (_today = YearMonthDay.fromYmd1Exp(
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
    ));
  }

  /**
   * Filters
   */
  export function* ndsucc(
    curr: YearMonthDay.MaybeValid,
    step: DateUnit,
    recurLimit: number,
  ): Generator<YearMonthDay.MaybeValid> {
    for (let i = 0; i < recurLimit; ++i) {
      const next = curr.addOpt(step);
      yield curr;
      curr = next;
    }
  }

  export function* ndrange({
    start,
    step,
    recurLimit,
    onExhausted,
    filter,
    end,
    limit,
    weekStart,
  }: {
    start: YearMonthDay.MaybeValid;
    step: DateUnit;
    recurLimit: number;
    onExhausted?: Option<() => void>;
    filter: YearMonthDay.Filter;
    end: Option<YearMonthDay>;
    limit: Option<number>;
    weekStart: Weekday;
  }): Generator<YearMonthDay> {
    let recurCnt = 0;
    let cnt = 0;

    let iterStart = start;
    if (step.type === "week") {
      let diff = start.dayOfWeek.dow - weekStart.dow;
      if (diff < 0) diff += 7;
      if (diff !== 0) iterStart = start.addDays(-diff);
    }

    // At most `recurLimit` dates, and the series ends after `IDLE_PERIODS`
    // periods in a row with none: a rule that rarely matches
    // (BYMONTH=7;BYMONTHDAY=1 on a DAILY;INTERVAL=3 step) still reaches its
    // COUNT, and one that never matches (BYMONTH=2;BYMONTHDAY=30) ends.
    let idle = 0;
    for (const i of YearMonthDay.ndsucc(iterStart, step, Number.MAX_SAFE_INTEGER)) {
      let yielded = false;
      for (const [ndu, _] of filter([i, step.type])) {
        const nd = ndu.toResult().asOk();
        if (!nd) continue;
        if (nd.cmpInvalid(start) < 0) continue;
        if (end && nd.cmpInvalid(end) > 0) continue;
        yield nd;
        yielded = true;
        cnt += 1;
        recurCnt += 1;
        if (limit && cnt >= limit) return;
        if (recurCnt >= recurLimit) { onExhausted?.(); return; }
      }
      if (yielded) idle = 0;
      else if (++idle >= IDLE_PERIODS) { onExhausted?.(); return; }
      // A period whose first day is over a week past `end` (and every later
      // one) holds no date to yield. The week of slack covers BYWEEKNO,
      // whose week 1 can start in the previous year's last days.
      if (end && firstDayOf(i, step.type).castValid().addDays(-7).cmpInvalid(end) > 0) return;
    }
  }

  /** The first day of the period `i` marks (a year's Jan 1, a month's 1st; a week or day starts at `i`). */
  function firstDayOf(i: YearMonthDay.MaybeValid, unit: DateUnit.Type): YearMonthDay.MaybeValid {
    switch (unit) {
      case "year":
        return YearMonthDay.fromYmd1Unchecked(i.yr, 1, 1);
      case "month":
        return YearMonthDay.fromYmd1Unchecked(i.yr, i.mth, 1);
      default:
        return i;
    }
  }

  /** How many periods in a row without a date end a series (`ndrange`). */
  export const IDLE_PERIODS = 100_000;

  export type Filter = YearMonthDayFilter;
  export const Filter: typeof YearMonthDayFilter = YearMonthDayFilter;

  export import Partial = PartialDate;

  export class PartialRange extends GenericRange<Partial> {
    toRange(): NaiveDate.Range {
      return new NaiveDate.Range(this.start.start, this.end.end);
    }
  }

  export namespace Formatter {
    export type Options = {
      dateFormat?: "month-day" | "day-month";
      includeYear?: boolean;
      includeWeekday?: boolean;
      shortMonth?: boolean;
    };

    export function render(s: YearMonthDay, options: Options = {}): string {
      const {
        dateFormat = "month-day",
        includeYear = false,
        includeWeekday = false,
        shortMonth = false,
      } = options;
      const month = shortMonth ? s.month.shortName : s.month.name;
      const dayMonth = dateFormat === "day-month"
        ? `${s.day1} ${month}`
        : `${month} ${s.day1}`;
      const parts: string[] = [];
      if (includeWeekday) parts.push(`${s.dayOfWeek.label},`);
      parts.push(dayMonth);
      if (includeYear) parts.push(String(s.yr));
      return parts.join(" ");
    }
  }

  export class Span {
    private readonly cache: Optional<{
      resolved: Range;
    }> = {};

    constructor(
      public readonly d: YearMonthDay,
      public readonly span: DateUnit,
    ) {}

    next(): Span {
      return new Span(this.d.add(this.span), this.span);
    }

    get index(): number {
      return this.d.dse;
    }

    resolve(): Range {
      if (this.cache.resolved) return this.cache.resolved;
      return (this.cache.resolved = new Range(this.d, this.d.add(this.span)));
    }
  }

  export class SpanRange extends GenericRange<Span> {}

  export class Range extends GenericRange<YearMonthDay> {
    private readonly cached: Optional<{
      rangeIncl: Readonly<YearMonthDay[]>;
      rangeExcl: Readonly<YearMonthDay[]>;
    }> = {};

    withTime(): NaiveDateTime.Range {
      return new NaiveDateTime.Range(
        this.start.withTime(),
        this.end.withTime(),
      );
    }

    containsExclusiveEnd(d: YearMonthDay): boolean {
      const n = d.dse;
      return n >= this.start.dse && n <= this.end.dse;
    }

    contains(d: YearMonthDay): boolean {
      const n = d.dse;
      return n >= this.start.dse && n < this.end.dse;
    }

    numDays(): number {
      return this.end.dse - this.start.dse;
    }

    iter(): Readonly<YearMonthDay[]> {
      if (this.cached.rangeExcl) return this.cached.rangeExcl;
      return (this.cached.rangeExcl = Object.freeze(
        Array.from({ length: this.numDays() }, (_, i) => this.start.addDays(i)),
      ));
    }

    rangeInclusive(): Readonly<YearMonthDay[]> {
      if (this.cached.rangeIncl) return this.cached.rangeIncl;
      return (this.cached.rangeIncl = Object.freeze(
        Array.from({ length: this.numDays() + 1 }, (_, i) =>
          this.start.addDays(i),
        ),
      ));
    }

    override toString(): string {
      return `${this.start.toString()}..${this.end.toString()}`;
    }
  }
}
