import { NaiveDate } from "../naive-date.ts";
import { GenericRange } from "../range.ts";
import { Result, erm, ok } from "../result.ts";
import { TimezoneRegion } from "../timezone-region.ts";
import { TentoMath } from "../utils.ts";
import { DateUnit } from "./date-unit.ts";
import { Month } from "./month.ts";
import { DayOfMonth1, Month0, Month1, WeekOfYear1 } from "./units.ts";
import { Week, Yw1Like } from "./week.ts";
import { Weekday } from "./weekday.ts";
import { Year } from "./year.ts";
import { YearMonth, Ym1Like } from "./year-month.ts";
import { YearMonthDay } from "./year-month-day.ts";
import type { Option, Optional } from "../option.ts";

export class PartialDate {
  /**
   * `start`, `end` and `index`, filled on first read. Private, so a partial
   * prints, enumerates and compares as its date fields and `weekStart`
   * alone, whatever was read from it before (`JSON.stringify`, `Object.keys`
   * and a formula's `json-keys` never see it).
   */
  readonly #cached: Optional<{
    start: NaiveDate;
    end: NaiveDate;
    index: number;
  }>;

  constructor(
    readonly type: DateUnit.Type,
    readonly yr: number,
    readonly mth: Option<Month1> = null,
    readonly day: Option<DayOfMonth1> = null,
    readonly wno: Option<WeekOfYear1> = null,
    cached: Optional<{
      start: NaiveDate;
      end: NaiveDate;
      index: number;
    }> = {},
    readonly weekStart: Weekday = Weekday.MON,
  ) {
    this.#cached = { ...cached };
  }

  // biome-ignore lint/suspicious/useGetterReturn: is correct
  get #index(): number {
    switch (this.type) {
      case "year":
        return this.yr;
      case "month":
        return this.yr * 12 + this.mth! - 1;
      case "day":
        return this.start.dse;
      case "week":
        return Week.weeksSinceEpoch(this as Yw1Like);
    }
  }
  get index(): number {
    if (this.#cached.index != null) return this.#cached.index;
    return (this.#cached.index = this.#index);
  }

  toType(type: DateUnit.Type): PartialDate {
    if (type === this.type) return this;

    const date = this.start;
    switch (type) {
      case "year":
        return new PartialDate("year", date.yr);
      case "month":
        return new PartialDate("month", date.yr, date.month1);
      case "week":
        return PartialDate.fromDateAndType("week", date, this.weekStart);
      case "day":
        return new PartialDate("day", date.yr, date.month1, date.day1);
    }
  }

  /** `toString()`'s answer, kept after its first call: the fields it spells never change. */
  #text: Option<string> = null;

  toString(): string {
    return this.#text ??= this.#spelled();
  }

  #spelled(): string {
    switch (this.type) {
      case "year":
        return `y-${this.yr}`;
      case "month":
        return `ym-${this.yr}-${this.mth!}`;
      case "day":
        return `ymd-${this.yr}-${this.mth!}-${this.day!}`;
      case "week":
        return `yw-${this.yr}-${this.wno!}`;
    }
  }

  toStringReadable(): string {
    switch (this.type) {
      case "year":
        return `${this.yr}`;
      case "month":
        return `${Month.MONTHS0[(this.mth as number) - 1].shortName}, ${
          this.yr
        }`;
      case "day":
        return `${Month.MONTHS0[(this.mth as number) - 1].shortName} ${
          this.day
        }, ${this.yr}`;
      case "week":
        return `Week ${this.wno!}, ${this.yr}`;
    }
  }

  private _start(): NaiveDate {
    switch (this.type) {
      case "year":
        return NaiveDate.fromYmd1Exp(this.yr, 1, 1);
      case "month":
        return NaiveDate.fromYmd1Exp(this.yr, this.mth!, 1);
      case "day":
        return NaiveDate.fromYmd1Exp(this.yr, this.mth!, this.day!);
      case "week":
        return Week.dateFromWeekno(this as Yw1Like, this.weekStart);
    }
  }

  get start(): NaiveDate {
    return this.#cached.start ?? (this.#cached.start = this._start());
  }

  get end(): NaiveDate {
    return this.#cached.end ?? (this.#cached.end = this.start.add(this.du));
  }

  equals(other: PartialDate): boolean {
    return (
      this.type === other.type &&
      this.yr === other.yr &&
      this.mth === other.mth &&
      this.day === other.day &&
      this.wno === other.wno
    );
  }

  get du(): DateUnit {
    return new DateUnit(1, this.type);
  }

  toRange(): NaiveDate.Range {
    return new NaiveDate.Range(this.start, this.end);
  }

  add(scalar: number): PartialDate {
    switch (this.type) {
      case "year": {
        return new PartialDate(this.type, this.yr + scalar);
      }
      case "month": {
        const { yr, mth } = YearMonth.add(this as Ym1Like, {
          mth: scalar as Option<Month0>,
        });
        return new PartialDate(this.type, yr, mth);
      }
      case "day": {
        return PartialDate.fromDate(this.start.addDays(scalar));
      }
      case "week": {
        const { yr, wno: week } = Week.addWeeks(
          { yr: this.yr, wno: this.wno! },
          scalar,
        );
        return new PartialDate(this.type, yr, null, null, week, {}, this.weekStart);
      }
    }
  }

  offsetFrom(date: NaiveDate): {
    index: number;
    days: number;
    maxDays: number;
  } {
    switch (this.type) {
      case "year": {
        return {
          index: date.yr - this.yr,
          days: date.dayOfYear,
          maxDays: Year.length(date.yr),
        };
      }
      case "month": {
        return {
          index: (date.yr - this.yr) * 12 + (date.mth - this.mth!),
          days: date.dayOfMonth,
          maxDays: YearMonth.daysInMonth(date),
        };
      }
      case "day": {
        return {
          index: date.differenceInDays(this.start),
          days: 0,
          maxDays: 1,
        };
      }
      case "week": {
        const daysDiff = date.differenceInDays(this.start);
        return {
          index: Math.floor(daysDiff / 7),
          days: ((daysDiff % 7) + 7) % 7,
          maxDays: 7,
        };
      }
    }
  }

  /**
   * Generate constituent sub-partials in a finer timescale.
   *
   * For example:
   * - A year PartialDate can generate its constituent months
   * - A month PartialDate can generate its constituent days
   * - A week PartialDate can generate its constituent days
   *
   * @param subType The finer timescale to generate (must be finer than this PartialDate's type)
   * @param count Optional limit on number of sub-partials to generate
   * @returns Array of PartialDates in the specified sub-timescale
   */
  generateSubPartials(subType: DateUnit.Type, count?: number): PartialDate[] {
    const subPartials: PartialDate[] = [];

    // Start with the first sub-partial at the beginning of this PartialDate's range
    let currentPd: PartialDate;

    switch (subType) {
      case "day": {
        currentPd = PartialDate.fromDate(this.start);
        break;
      }
      case "week": {
        // Find the first weekStart day on or after the start date
        // This ensures each week belongs to exactly one parent month
        let firstWeekday = this.start;
        while (firstWeekday.dayOfWeek !== this.weekStart) {
          firstWeekday = firstWeekday.addDays(1);
        }
        currentPd = new PartialDate(
          "week",
          firstWeekday.isoYear,
          null,
          null,
          firstWeekday.isoWno,
          {},
          this.weekStart,
        );
        break;
      }
      case "month": {
        const startDate = this.start;
        currentPd = PartialDate.fromMonth(startDate.yr, startDate.mth);
        break;
      }
      case "year": {
        currentPd = PartialDate.fromYear(this.start.yr);
        break;
      }
    }

    // Generate sub-partials until we reach the count or exceed this PartialDate's range
    const endDate = this.end;
    let generated = 0;
    const maxCount = count ?? 1000; // Safety limit

    while (generated < maxCount) {
      // Check if we're still within this PartialDate's range
      if (currentPd.start.isBefore(endDate)) {
        subPartials.push(currentPd);
        generated++;

        // If count is specified and we've reached it, stop
        if (count != null && generated >= count) {
          break;
        }

        currentPd = currentPd.add(1);
      } else {
        break;
      }
    }

    return subPartials;
  }
}

export namespace PartialDate {
  function startOfWeekFor(date: NaiveDate, weekStart: Weekday): NaiveDate {
    let diff = date.dayOfWeek.dow - weekStart.dow;
    if (diff < 0) diff += 7;
    return date.addDays(-diff);
  }

  export function fromDateAndType(
    type: DateUnit.Type,
    date: NaiveDate,
    weekStart: Weekday = Weekday.MON,
  ): PartialDate {
    switch (type) {
      case "year":
        return new NaiveDate.Partial("year", date.yr);
      case "month":
        return new NaiveDate.Partial("month", date.yr, date.month1);
      case "week": {
        const start = startOfWeekFor(date, weekStart);
        return new NaiveDate.Partial(
          "week",
          start.isoYear,
          null,
          null,
          start.isoWno,
          {},
          weekStart,
        );
      }
      case "day":
        return new NaiveDate.Partial("day", date.yr, date.month1, date.day1);
    }
  }

  export function parse(s: string): Result<PartialDate> {
    return parseRecognized(s) ?? erm("unknown ty");
  }

  /** Probe the same partial-date grammar without constructing an error for a
   * different format (for example RFC3339). Recognized malformed partials
   * still use the regular parser; validation and permissive parsing stay equal. */
  export function parseOptional(s: string): Option<PartialDate> {
    return parseRecognized(s)?.asOk() ?? null;
  }

  /**
   * Parsed partial dates by their text, at most `INTERN_LIMIT` (the oldest
   * entry leaves first). A sheet's cells repeat a few hundred day strings,
   * and an ingest parses each at every layer (wire decode, backend, store):
   * a hit is one Map lookup and a new PartialDate instead of a split and
   * four integer parses. Every caller gets its own PartialDate, never the
   * kept one, so what one caller reads from its partial (or does with it)
   * cannot show in another's. Only successful parses are kept.
   */
  const INTERN_LIMIT = 4096;
  const interned = new Map<string, PartialDate>();

  function parseRecognized(s: string): Option<Result<PartialDate>> {
    const hit = interned.get(s);
    if (hit !== undefined) return ok(copyOf(hit));
    const parsed = parseText(s);
    if (parsed == null || !parsed.isOk) return parsed;
    const kept = parsed.exp();
    if (interned.size >= INTERN_LIMIT) {
      const oldest = interned.keys().next();
      if (oldest.done !== true) interned.delete(oldest.value);
    }
    interned.set(s, kept);
    return ok(copyOf(kept));
  }

  /** A new PartialDate with `p`'s fields and nothing computed yet. */
  function copyOf(p: PartialDate): PartialDate {
    return new PartialDate(p.type, p.yr, p.mth, p.day, p.wno, {}, p.weekStart);
  }

  function parseText(s: string): Option<Result<PartialDate>> {
    const [ty, yr, mw, d] = s.split("-");
    switch (ty) {
      case "ymd":
        return PartialDate.fromStr("day", yr, mw, d, null);
      case "ym":
        return PartialDate.fromStr("month", yr, mw, null, null);
      case "y":
        return PartialDate.fromStr("year", yr, null, null, null);
      case "yw":
        return PartialDate.fromStr("week", yr, null, null, mw);
    }
    return null;
  }

  export function fromDate(d: NaiveDate): PartialDate {
    return new PartialDate("day", d.yr, d.month1, d.dayOfMonth, null, {
      start: d,
    });
  }

  export function fromWeek(yr: number, week1: number, weekStart: Weekday = Weekday.MON): PartialDate {
    return new PartialDate("week", yr, null, null, week1 as WeekOfYear1, {}, weekStart);
  }

  export function fromMonth(yr: number, mth: number): PartialDate {
    return new PartialDate("month", yr, mth as Month1, null, null);
  }

  export function fromYear(yr: number): PartialDate {
    return new PartialDate("year", yr, null, null, null);
  }

  export function fromYw1(yw1: Yw1Like, weekStart: Weekday = Weekday.MON): PartialDate {
    return new PartialDate("week", yw1.yr, null, null, yw1.wno, {}, weekStart);
  }

  export function fromStr(
    type: DateUnit.Type,
    yr: string,
    mth1: Option<string>,
    dom1: Option<string>,
    wk1: Option<string>,
  ): Result<PartialDate> {
    let _yr = parse1idx(yr);
    if (_yr.isErr) return _yr.expeCast();

    let _mth1 = parse1idx(mth1);
    if (_mth1.isErr) return _mth1.expeCast();

    let _dom1 = parse1idx(dom1);
    if (_dom1.isErr) return _dom1.expeCast();

    let _wk1 = parse1idx(wk1);
    if (_wk1.isErr) return _wk1.expeCast();

    return ok(
      new PartialDate(
        type,
        _yr.exp()!,
        _mth1.exp()! as Month1,
        _dom1.exp()! as DayOfMonth1,
        _wk1.exp()! as WeekOfYear1,
      ),
    );
  }

  function parse1idx(s: Option<string>): Result<Option<number>> {
    if (s == null) return ok(null);
    const num = TentoMath.int(s);
    if (Number.isNaN(num)) return erm("not a number");
    if (num < 1) return erm("<1");
    return ok(num);
  }
}

export namespace PartialDate {
  export type Tuple = [YearMonthDay.MaybeValid, DateUnit.Type];

  export type WithTz = [PartialDate, TimezoneRegion];
  export namespace WithTz {
    export class Range extends GenericRange<WithTz> {
      toRange(): NaiveDate.Range {
        return new NaiveDate.Range(this.start[0].start, this.end[0].end);
      }

      toRangeExl(): NaiveDate.Range {
        return new NaiveDate.Range(this.start[0].start, this.end[0].start);
      }

      override toString(): string {
        return `${this.start[0].toString()}..${this.end[0].toString()}`;
      }
    }
  }
}
