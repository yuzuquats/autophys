import { GenericRangeLike, range } from "../range.ts";

import { NaiveDate } from "../naive-date.ts";
import { DateUnit } from "./date-unit.ts";
import { Month } from "./month.ts";
import type { PartialDate } from "./partial-date.ts";
import { DayOfMonth1, DayOfYear1, Month1, WeekOfYear1 } from "./units.ts";
import { Weekday } from "./weekday.ts";
import { Year } from "./year.ts";
import { YearMonth, Ym1Like } from "./year-month.ts";
import { YearMonthDay } from "./year-month-day.ts";
import type { Option } from "../option.ts";

export type YearMonthDayFilter = (
  partialdate: PartialDate.Tuple,
) => Generator<PartialDate.Tuple>;

export namespace YearMonthDayFilter {
  type Filter = YearMonthDayFilter;

  export function identity(): Filter {
    return ([nd]) => _identity(nd);
  }

  function* _identity(
    nd: YearMonthDay.MaybeValid,
  ): Generator<PartialDate.Tuple> {
    yield [nd, "day"];
  }

  /**
   * `inner`'s days in each period, narrowed to the positions BYSETPOS names
   * (1-based from the period's first day, negative from its last), in order.
   * Days that do not exist (Feb 31) are not counted.
   */
  export function bySetPos(inner: Filter, positions: readonly number[]): Filter {
    return function* (partialdate: PartialDate.Tuple): Generator<PartialDate.Tuple> {
      const days = new Map<number, PartialDate.Tuple>();
      for (const [day, unit] of inner(partialdate)) {
        const valid = day.toResult().asOk();
        if (valid != null) days.set(valid.dse, [valid, unit]);
      }
      const sorted = [...days.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
      const picked = new Set<number>();
      for (const p of positions) {
        const i = p > 0 ? p - 1 : sorted.length + p;
        if (p !== 0 && i >= 0 && i < sorted.length) picked.add(i);
      }
      for (const i of [...picked].sort((a, b) => a - b)) yield sorted[i];
    };
  }

  export function compose(filters: Filter[]): Filter {
    // A month limit before another filter passes the weeks that straddle its
    // months; each date the chain yields is then held to them (`MonthLimit`).
    const last = filters.length - 1;
    const isLimit = (f: Filter, i: number): f is MonthLimit => i < last && "straddling" in f;
    const chain = filters.map((f, i) => isLimit(f, i) ? f.straddling : f);
    const keeps = filters.filter(isLimit).map((f) => f.keeps);
    return function* (
      partialdate: PartialDate.Tuple,
    ): Generator<PartialDate.Tuple> {
      for (const t of _compose(partialdate, chain)) {
        if (keeps.every((k) => k(t[0]))) yield t;
      }
    };
  }

  function* _compose(
    partialdate: PartialDate.Tuple,
    filters: Filter[],
  ): Generator<PartialDate.Tuple> {
    const generators: Generator<PartialDate.Tuple>[] = [];
    const uniqueDates = new Set<string>(); // To deduplicate final dates

    let curr: PartialDate.Tuple = partialdate;
    for (const [idx, f] of filters.entries()) {
      const gen = f(curr);
      const next = gen.next();
      if (next.done) break;
      generators.push(gen);
      curr = next.value;
      if (idx === filters.length - 1) {
        const dateKey = curr[0].toString();
        if (!uniqueDates.has(dateKey)) {
          uniqueDates.add(dateKey);
          yield curr;
        }
      }
    }

    while (true) {
      if (generators.length === filters.length) {
        const leaf = generators.pop();
        if (!leaf) return;
        for (const value of leaf) {
          const dateKey = value[0].toString();
          if (!uniqueDates.has(dateKey)) {
            uniqueDates.add(dateKey);
            yield value;
          }
        }
      }

      const top = generators.pop();
      if (!top) break;

      const next = top.next();
      if (next.done) continue;

      curr = next.value;
      generators.push(top);

      const gen = filters[generators.length]!(curr);
      generators.push(gen);
    }
  }

  export function byWeekday(dayOfWeeks: Weekday[]): Filter {
    const dow1: Option<boolean>[] = [];
    for (const dow of dayOfWeeks) {
      dow1[dow.dow] = true;
    }
    return (partialdate: PartialDate.Tuple) => _byWeekday(partialdate, dow1);
  }

  function* _byWeekday(
    [cand, unit]: PartialDate.Tuple,
    dow1: Option<boolean>[],
  ): Generator<PartialDate.Tuple> {
    switch (unit) {
      case "year": {
        // The calendar year holding `cand` (not a year-long window from it).
        const jan1 = YearMonthDay.fromYmd1Unchecked(cand.yr, 1, 1).castValid();
        for (const day of range(Year.length(cand.yr))) {
          const nd = jan1.addDays(day);
          if (dow1[nd.dayOfWeek.dow]) yield [nd, "day"];
        }
        break;
      }
      case "month":
        // `dom` counts days from 0.
        for (const day0 of YearMonth.dom(cand)) {
          const nd = YearMonthDay.fromYmd1Unchecked(cand.yr, cand.mth, day0 + 1);
          if (dow1[nd.dayOfWeek.dow]) yield [nd, "day"];
        }
        break;
      case "week":
        for (let i = 0; i < 7; ++i) {
          const day = cand.addDays(i);
          if (dow1[day.dayOfWeek.dow]) yield [day, "day"];
        }
        break;
      case "day":
        if (dow1[cand.dayOfWeek.dow]) yield [cand, "day"];
        break;
    }
  }

  /**
   * A filter that limits dates to a set of months (BYMONTH). On its own, a
   * week is kept when its own date is in the months. Inside `compose`,
   * before filters that expand the week into days, `straddling` keeps a
   * week holding any day of the months instead, and `compose` holds each
   * date the chain yields to the months (`keeps`).
   */
  export interface MonthLimit extends Filter {
    readonly straddling: Filter;
    readonly keeps: (date: YearMonthDay.MaybeValid) => boolean;
  }

  export function byMonthOfYear(months: Month[]): MonthLimit {
    const mths = new Set(months.map((mth) => mth.mth1));
    const filter = (partialdate: PartialDate.Tuple) => _byMonthOfYear(partialdate, mths, false);
    return Object.assign(filter, {
      straddling: (partialdate: PartialDate.Tuple) => _byMonthOfYear(partialdate, mths, true),
      keeps: (date: YearMonthDay.MaybeValid) => mths.has(date.mth),
    });
  }

  function* _byMonthOfYear(
    [partialdate, unit]: PartialDate.Tuple,
    mths: Set<Month1>,
    straddling: boolean,
  ): Generator<PartialDate.Tuple> {
    switch (unit) {
      case "year": {
        const start = YearMonthDay.fromYmd1Exp(
          partialdate.yr,
          1,
          partialdate.day,
        );
        for (const mth of start.succ(DateUnit.months(1), 12)) {
          if (mths.has(mth.mth)) yield [mth, "month"];
        }
        break;
      }
      case "month":
        if (mths.has(partialdate.mth)) yield [partialdate, "month"];
        break;
      case "week":
        if (!straddling) {
          if (mths.has(partialdate.mth)) yield [partialdate, "week"];
          break;
        }
        for (let i = 0; i < 7; ++i) {
          if (mths.has(partialdate.addDays(i).mth)) {
            yield [partialdate, "week"];
            break;
          }
        }
        break;
      case "day":
        if (mths.has(partialdate.mth)) yield [partialdate, "day"];
        break;
    }
  }


  export function byDayOfMonth(dayOfMonths: DayOfMonth1[] | number[]): Filter {
    const domsPos = dayOfMonths.filter((doy) => doy >= 0);
    domsPos.sort((a, b) => a - b);
    const domsNeg = dayOfMonths.filter((doy) => doy < 0);
    domsNeg.sort((a, b) => b - a);

    // todo: memo this
    // The month's days the values name, each once, in order (a negative
    // and a positive value can name the same day: -2 and 30 in a 31-day month).
    const makeDoms = (ym1: Ym1Like): DayOfMonth1[] => {
      const monthLen = YearMonth.daysInMonth(ym1);
      const doms = new Set([
        ...domsPos,
        ...domsNeg.map((dom) => monthLen + dom + 1),
      ]);
      return [...doms].sort((a, b) => a - b) as DayOfMonth1[];
    };
    return (partialdate: PartialDate.Tuple) =>
      _byDayOfMonth(partialdate, makeDoms);
  }

  function* _byDayOfMonth(
    [cand, unit]: PartialDate.Tuple,
    makeDoms: (ym1: Ym1Like) => DayOfMonth1[],
  ): Generator<PartialDate.Tuple> {
    switch (unit) {
      case "year":
        {
          const start = YearMonthDay.fromYmd1Exp(cand.yr, 1, 1);
          for (const mth of start.succ(DateUnit.months(1), 12)) {
            for (const day of makeDoms(mth)) {
              yield [
                YearMonthDay.fromYmd1Unchecked(mth.yr, mth.mth, day),
                "day",
              ];
            }
          }
        }
        break;
      case "month":
        for (const day of makeDoms(cand)) {
          yield [YearMonthDay.fromYmd1Unchecked(cand.yr, cand.mth, day), "day"];
        }
        break;
      case "week":
        for (let i = 0; i < 7; ++i) {
          const date = cand.add({ days: i });
          const doms = makeDoms(date);
          if (doms.includes(date.day)) yield [date, "day"];
        }
        break;
      case "day":
        if (makeDoms(cand).includes(cand.day)) yield [cand, "day"];
        break;
    }
  }

  export function byDayOfYear(dayOfYears: DayOfYear1[] | number[]): Filter {
    const doysPos = dayOfYears.filter((doy) => doy >= 0);
    const doysNeg = dayOfYears.filter((doy) => doy < 0);

    // The year's days the values name, each once, in order; a value past the
    // year's end (366 in a 365-day year) names none.
    const doysOf = (len: number) =>
      [...new Set([...doysPos, ...doysNeg.map((doy) => len + doy + 1)])]
        .filter((doy) => doy >= 1 && doy <= len)
        .sort((a, b) => a - b);
    const doys365 = doysOf(365);
    const doys366 = doysOf(366);

    return (partialdate: PartialDate.Tuple) =>
      _byDayOfYear(partialdate, doys365, doys366);
  }

  function* _byDayOfYear(
    [cand, unit]: PartialDate.Tuple,
    doys365: number[],
    doys366: number[],
  ): Generator<PartialDate.Tuple> {
    // Handle years, months, and days cases normally with current year
    if (unit !== "week") {
      const yr = cand.yr;
      const doys = Year.isLeapYear(yr) ? doys366 : doys365;
      for (const doy of doys) {
        const date = YearMonthDay.fromYmd1Exp(yr, 1, 1).addDays(doy - 1);
        switch (unit) {
          case "year":
            if (date.yr === cand.yr) yield [date, "day"];
            break;
          case "month":
            if (date.yr === cand.yr && date.mth === cand.mth) yield [date, "day"];
            break;
          case "day":
            if (date.cmpInvalid(cand) === 0) yield [date, "day"];
            break;
        }
      }
      return;
    }

    const yearsToCheck = [cand.yr];

    const weekStart = cand.toStartOfWeekMon();
    const weekEnd = weekStart.addDays(6);

    if (weekStart.yr !== weekEnd.yr) {
      yearsToCheck.push(weekEnd.yr);
    }

    if (cand.mth === 12 && cand.day >= 24) {
      yearsToCheck.push(cand.yr + 1);
    } else if (cand.mth === 1 && cand.day <= 7) {
      yearsToCheck.push(cand.yr - 1);
    }

    const uniqueYears = [...new Set(yearsToCheck)];
    for (const yr of uniqueYears) {
      const doys = Year.isLeapYear(yr) ? doys366 : doys365;

      for (const doy of doys) {
        const date = YearMonthDay.fromYmd1Exp(yr, 1, 1).addDays(doy - 1);
        const candWeekStart = cand.toStartOfWeekMon();
        const candWeekEnd = candWeekStart.addDays(6);
        const dateInRange =
          date.dse >= candWeekStart.dse && date.dse <= candWeekEnd.dse;

        if (dateInRange) {
          yield [date, "day"];
        }
      }
    }
  }

  export function byWeekNo(
    weekno1: number,
    useCalendarYear: boolean = false,
  ): Filter {
    if (weekno1 === 0) throw new Error("weekno1 cannot be 0");
    return (partialdate: PartialDate.Tuple) =>
      _byWeekNo(
        partialdate,
        weekno1 as WeekOfYear1,
        useCalendarYear,
      );
  }

  export function byWeekNoGoogle(
    weekno1: number,
    useCalendarYear: boolean = false,
  ): Filter {
    if (weekno1 === 0) throw new Error("weekno1 cannot be 0");
    return (partialdate: PartialDate.Tuple) =>
      _byWeekNoGoogle(
        partialdate,
        weekno1 as WeekOfYear1,
        useCalendarYear,
      );
  }

  function* _byWeekNo(
    [cand, unit]: PartialDate.Tuple,
    weekno1: WeekOfYear1,
    useCalendarYear: boolean = false,
  ): Generator<PartialDate.Tuple> {
    const weeknoCache = new Set<string>();
    let bounds: NaiveDate.Range;
    
    switch (unit) {
      case "year": {
        const start = NaiveDate.fromYmd1Exp(cand.yr, 1, 1);
        bounds = new NaiveDate.Range(start, start.add({ yrs: 1 }));
        break;
      }
      case "month": {
        const start = NaiveDate.fromYmd1Exp(cand.yr, cand.month1, 1);
        bounds = new NaiveDate.Range(start, start.add({ mths: 1 }));
        break;
      }
      case "day": {
        const maybeStart = NaiveDate.fromYmd1(cand.yr, cand.month1, cand.day1);
        if (maybeStart.isErr) return;
        const start = maybeStart.exp();
        bounds = new NaiveDate.Range(start, start.add({ days: 1 }));
        break;
      }
      case "week": {
        const maybeStart = NaiveDate.fromYmd1(cand.yr, cand.month1, cand.day1);
        if (maybeStart.isErr) return;
        const start = maybeStart.exp();
        bounds = new NaiveDate.Range(start, start.add({ days: 7 }));
        break;
      }
    }

    if (useCalendarYear) {
      // Calendar year mode
      const targetYear = cand.yr;

      if (weekno1 < 0) {
        // For negative week numbers, use ISO week numbering
        const numWeeks = Year.numWeeks(targetYear);
        const positiveWeekNo = numWeeks + weekno1 + 1;
        
        if (positiveWeekNo > 0 && positiveWeekNo <= numWeeks) {
          const isoWeek1Monday = Year.isoWeekMon(targetYear, 1 as WeekOfYear1);
          const targetMonday = isoWeek1Monday.addDays((positiveWeekNo - 1) * 7);
          
          for (let i = 0; i < 7; ++i) {
            const d = targetMonday.addDays(i);
            if (!bounds.contains(d)) continue;
            
            const cacheKey = `${targetYear}_${d.toString()}`;
            if (!weeknoCache.has(cacheKey)) {
              weeknoCache.add(cacheKey);
              yield [d, "day"];
            }
          }
        }
      } else {
        // Positive weekno in calendar year mode - use regular ISO week logic
        const yearsToCheck = [targetYear - 1, targetYear, targetYear + 1];

        for (const year of yearsToCheck) {
          const jan4 = YearMonthDay.fromYmd1Exp(year, 1, 4);
          let week1Monday = jan4;
          while (week1Monday.dayOfWeek.dow !== 2) {
            week1Monday = week1Monday.addDays(-1);
          }

          const targetMonday = week1Monday.addDays((weekno1 - 1) * 7);

          for (let i = 0; i < 7; ++i) {
            const d = targetMonday.addDays(i);
            if (!bounds.contains(d)) continue;
            
            const cacheKey = `${targetYear}_${d.toString()}`;
            if (!weeknoCache.has(cacheKey)) {
              weeknoCache.add(cacheKey);
              yield [d, "day"];
            }
          }
        }
      }
    } else {
      // ISO week mode (default behavior)
      const yearsToCheck = [
        Year.isoWeekMon(cand.yr - 1, 1 as WeekOfYear1),
        Year.isoWeekMon(cand.yr, 1 as WeekOfYear1),
        Year.isoWeekMon(cand.yr + 1, 1 as WeekOfYear1),
      ].filter((year) => {
        const numWeeks = Year.numWeeks(year.isoYw1.yr);
        return weekno1 > 0
          ? numWeeks >= weekno1
          : Math.abs(weekno1) <= numWeeks;
      });

      const seenDates = new Set<string>();
      for (const year of yearsToCheck) {
        for (let i = 0; i < 7; ++i) {
          if (weekno1 > 0) {
            const d = year.addDays((weekno1 - 1) * 7 + i);
            if (!bounds.contains(d)) continue;
            const dateKey = d.toString();
            if (!seenDates.has(dateKey)) {
              seenDates.add(dateKey);
              yield [d, "day"];
            }
          } else {
            // For negative week numbers, calculate from the end of the year
            const isoYear = year.isoYw1.yr;
            const numWeeks = Year.numWeeks(isoYear);
            const targetWeekFromStart = numWeeks + weekno1 + 1; // Convert negative to positive
            const d = year.addDays((targetWeekFromStart - 1) * 7 + i);
            if (!bounds.contains(d)) continue;
            const dateKey = d.toString();
            if (!seenDates.has(dateKey)) {
              seenDates.add(dateKey);
              yield [d, "day"];
            }
          }
        }
      }
    }
  }

  export function byNthWeekday(
    dayOfWeeks: Weekday.Nth[],
    simpleEqForDays: boolean = true,
  ): Filter {
    return (partialdate: PartialDate.Tuple) =>
      _byNthWeekday(partialdate, dayOfWeeks, simpleEqForDays);
  }

  function* _byNthWeekday(
    [cand, unit]: PartialDate.Tuple,
    dayOfWeeks: Weekday.Nth[],
    simpleEqForDays: boolean = true,
  ): Generator<PartialDate.Tuple> {
    switch (unit) {
      case "year":
        {
          const wrap = Year.length(cand.yr);
          const start = YearMonthDay.fromYmd1Exp(cand.yr, 1, 1);
          const end = YearMonthDay.fromYmd1Exp(cand.yr, 12, 31);
          const days = Weekday.nthForYear(dayOfWeeks, start, end, wrap);

          for (const ndow of days) {
            yield [start.add({ days: ndow }), "day"];
          }
        }
        break;
      case "month":
        {
          const wrap = YearMonth.daysInMonth(cand);
          const start = YearMonthDay.fromYmd1Exp(cand.yr, cand.mth, 1);
          const end = YearMonthDay.fromYmd1Exp(cand.yr, cand.mth, wrap);
          const days = Weekday.nthForYear(dayOfWeeks, start, end, wrap);

          for (const ndow of days) {
            const resultDate = start.add({ days: ndow });
            yield [resultDate, "day"];
          }
        }
        break;
      case "week": {
        for (let i = 0; i < 7; ++i) {
          const date = cand.addDays(i);
          for (const ndow of dayOfWeeks) {
            if (ndow.weekday.dow === date.dayOfWeek.dow) {
              yield [date, "day"];
              break;
            }
          }
        }
        return;
      }
      case "day":
        {
          if (simpleEqForDays) {
            for (const ndow of dayOfWeeks) {
              if (ndow.weekday === cand.dayOfWeek) yield [cand, "day"];
            }
            return;
          }

          // NOTE: represents Nth of every month
          //
          const wrap = YearMonth.daysInMonth(cand);
          const start = YearMonthDay.fromYmd1Exp(cand.yr, cand.mth, 1);
          const end = YearMonthDay.fromYmd1Exp(cand.yr, cand.mth, wrap);
          const days = Weekday.nthForYear(dayOfWeeks, start, end, wrap);

          const ndowDays = days.map((days) => start.add({ days }));
          for (const ndow of ndowDays) {
            if (ndow.cmpInvalid(cand) === 0) yield [ndow, "day"];
          }
        }
        break;
    }
  }

  function* _byWeekNoGoogle(
    [cand, unit]: PartialDate.Tuple,
    weekno1: WeekOfYear1,
    useCalendarYear: boolean = false,
  ): Generator<PartialDate.Tuple> {
    const weeknoCache = new Set<string>();
    let bounds: NaiveDate.Range;
    
    // Google Calendar behavior: BYWEEKNO with monthly frequency spans entire year
    if (unit === "month") {
      const start = NaiveDate.fromYmd1Exp(cand.yr, 1, 1);
      bounds = new NaiveDate.Range(start, start.add({ yrs: 1 }));
    } else {
      switch (unit) {
        case "year": {
          const start = NaiveDate.fromYmd1Exp(cand.yr, 1, 1);
          bounds = new NaiveDate.Range(start, start.add({ yrs: 1 }));
          break;
        }
        case "day": {
          const maybeStart = NaiveDate.fromYmd1(cand.yr, cand.month1, cand.day1);
          if (maybeStart.isErr) return;
          const start = maybeStart.exp();
          bounds = new NaiveDate.Range(start, start.add({ days: 1 }));
          break;
        }
        case "week": {
          const maybeStart = NaiveDate.fromYmd1(cand.yr, cand.month1, cand.day1);
          if (maybeStart.isErr) return;
          const start = maybeStart.exp();
          bounds = new NaiveDate.Range(start, start.add({ days: 7 }));
          break;
        }
      }
    }

    if (useCalendarYear) {
      const targetYear = cand.yr;

      if (weekno1 < 0) {
        // For negative week numbers, Google Calendar uses ISO week numbering
        const numWeeks = Year.numWeeks(targetYear);
        const positiveWeekNo = numWeeks + weekno1 + 1;
        
        if (positiveWeekNo > 0 && positiveWeekNo <= numWeeks) {
          const isoWeek1Monday = Year.isoWeekMon(targetYear, 1 as WeekOfYear1);
          const targetMonday = isoWeek1Monday.addDays((positiveWeekNo - 1) * 7);
          
          for (let i = 0; i < 7; ++i) {
            const d = targetMonday.addDays(i);
            // For Google Calendar behavior, only yield dates that are in the target year
            // This prevents cross-year date generation that interferes with yearly generator
            if (d.yr !== targetYear) {
              continue;
            }
            if (!bounds.contains(d)) continue;
            
            const cacheKey = `${targetYear}_${d.toString()}`;
            if (!weeknoCache.has(cacheKey)) {
              weeknoCache.add(cacheKey);
              yield [d, "day"];
            }
          }
        }
      } else {
        // Google Calendar logic: week 1 is the first week containing January 4th (ISO week 1)
        const jan4 = YearMonthDay.fromYmd1Exp(targetYear, 1, 4);

        // Find the Monday of the week containing January 4th
        let week1Monday = jan4;
        while (week1Monday.dayOfWeek.dow !== 2) {
          week1Monday = week1Monday.addDays(-1);
        }

        const targetMonday = week1Monday.addDays((weekno1 - 1) * 7);

        // For yearly frequency, yield all days of the week regardless of year boundary
        // For other frequencies, only yield if Monday is in the target year
        const shouldYieldWeek = unit === "year" || targetMonday.yr === targetYear;
        
        if (shouldYieldWeek) {
          for (let i = 0; i < 7; ++i) {
            const d = targetMonday.addDays(i);
            // For Google Calendar behavior, only yield dates that are in the target year
            // This prevents cross-year date generation that interferes with yearly generator
            if (d.yr !== targetYear) {
              continue;
            }
            if (!bounds.contains(d)) continue;
            
            const cacheKey = `${targetYear}_${d.toString()}`;
            if (!weeknoCache.has(cacheKey)) {
              weeknoCache.add(cacheKey);
              yield [d, "day"];
            }
          }
        }
      }
    } else {
      // ISO week mode (default behavior)
      const yearsToCheck = [
        Year.isoWeekMon(cand.yr - 1, 1 as WeekOfYear1),
        Year.isoWeekMon(cand.yr, 1 as WeekOfYear1),
        Year.isoWeekMon(cand.yr + 1, 1 as WeekOfYear1),
      ].filter((year) => {
        const numWeeks = Year.numWeeks(year.isoYw1.yr);
        return weekno1 > 0
          ? numWeeks >= weekno1
          : Math.abs(weekno1) <= numWeeks;
      });

      const seenDates = new Set<string>();
      for (const year of yearsToCheck) {
        for (let i = 0; i < 7; ++i) {
          if (weekno1 > 0) {
            const d = year.addDays((weekno1 - 1) * 7 + i);
            if (!bounds.contains(d)) continue;
            const dateKey = d.toString();
            if (!seenDates.has(dateKey)) {
              seenDates.add(dateKey);
              yield [d, "day"];
            }
          } else {
            // For negative week numbers, calculate from the end of the year
            const isoYear = year.isoYw1.yr;
            const numWeeks = Year.numWeeks(isoYear);
            const targetWeekFromStart = numWeeks + weekno1 + 1;
            const d = year.addDays((targetWeekFromStart - 1) * 7 + i);
            if (!bounds.contains(d)) continue;
            const dateKey = d.toString();
            if (!seenDates.has(dateKey)) {
              seenDates.add(dateKey);
              yield [d, "day"];
            }
          }
        }
      }
    }
  }
}
