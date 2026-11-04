/**
 * A rule's instances as wall-clock date-times (RFC 5545 §3.3.10), for the
 * rules the date generator cannot place: an HOURLY, MINUTELY or SECONDLY
 * frequency, or BYHOUR / BYMINUTE / BYSECOND, with BYSETPOS over the
 * resulting set. Rules without time parts keep the date generator
 * (`RRule.toFilterProps`), which places one instance a day at DTSTART's time.
 *
 * The date parts (BYMONTH, BYWEEKNO, BYYEARDAY, BYMONTHDAY, BYDAY) select
 * days exactly as they do there. Each period's set (a year, month, week or
 * day of the frequency; an hour, minute or second for the sub-daily ones) is
 * built whole, sorted, narrowed by BYSETPOS, and only then cut at DTSTART,
 * UNTIL and COUNT, so a position counts from the period's start even when
 * DTSTART falls inside it.
 *
 * @module
 */
import { NaiveDate } from "../naive-date.ts";
import { NaiveDateTime } from "../naive-datetime.ts";
import { NaiveTime } from "../naive-time.ts";
import { Time } from "../time.ts";
import type { MsSinceEpoch } from "../units/units.ts";
import type { Option } from "../option.ts";
import type { RRule } from "./rrule.ts";
import { RecurrenceExpansionLimitError } from "./generation-limit.ts";

export namespace RRuleInstances {
  /**
   * How many periods (or, for the sub-daily frequencies, period steps) to
   * try without placing an instance before giving up: a rule whose parts
   * never meet (BYMONTH=2;BYMONTHDAY=31) ends instead of spinning.
   */
  export const IDLE_LIMIT = 100_000;

  /**
   * `rule`'s instances from `dtstart` (its wall-clock time), in order. A
   * date-only UNTIL ends the series before that day (this package's
   * convention, as the date generator reads it); a date-time UNTIL is
   * inclusive. `useGoogleCalendarBehavior` selects the same day filters the
   * date generator would (Google's BYWEEKNO reading).
   */
  export function* expand(
    rule: RRule,
    dtstart: NaiveDateTime,
    useGoogleCalendarBehavior: boolean = false,
    generationLimit?: number,
  ): Generator<NaiveDateTime> {
    const options = rule.inner.options;
    const count = options?.count ?? null;
    const until = options?.until ?? null;
    const untilWall = until?.nt != null ? until.extend() : null;
    const untilDay = until != null && until.nt == null ? until.trunc() : null;
    const ended = (at: NaiveDateTime) =>
      untilWall != null ? at.mse > untilWall.mse : untilDay != null && at.date.dse >= untilDay.dse;

    let emitted = 0;
    for (const at of candidates(rule, dtstart, useGoogleCalendarBehavior, generationLimit)) {
      if (at.mse < dtstart.mse) continue;
      if (ended(at)) return;
      yield at;
      emitted++;
      if (count != null && emitted >= count) return;
    }
  }

  /** The positions BYSETPOS names in `sorted` (1-based from the start, negative from the end), in order. */
  export function pickSetPos<T>(sorted: readonly T[], positions: readonly number[]): T[] {
    const picked = new Set<number>();
    for (const p of positions) {
      const i = p > 0 ? p - 1 : sorted.length + p;
      if (p !== 0 && i >= 0 && i < sorted.length) picked.add(i);
    }
    return [...picked].sort((a, b) => a - b).map((i) => sorted[i]);
  }

  /** Every period's set, from DTSTART's period on: not yet cut at DTSTART, UNTIL or COUNT. */
  function candidates(rule: RRule, dtstart: NaiveDateTime, google: boolean, generationLimit?: number): Generator<NaiveDateTime> {
    switch (rule.inner.freq) {
      case "hourly":
      case "minutely":
      case "secondly":
        return subDaily(rule, dtstart, google, generationLimit);
      default:
        return byDay(rule, dtstart, google, generationLimit);
    }
  }

  /** The times of day BYHOUR × BYMINUTE × BYSECOND name (DTSTART's for a part not given), sorted. */
  function timesOfDay(rule: RRule, dtstart: NaiveDateTime): NaiveTime[] {
    const options = rule.inner.options;
    const t = dtstart.time;
    const hours = [...new Set(nonEmpty(options?.byhour) ?? [t.hrs])];
    const minutes = [...new Set(nonEmpty(options?.byminute) ?? [t.mins])];
    const seconds = [...new Set(nonEmpty(options?.bysecond) ?? [t.secs])];
    const ms = new Set<number>();
    for (const h of hours) {
      for (const m of minutes) {
        for (const s of seconds) {
          if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) continue;
          ms.add(h * Time.MS_PER_HR + m * Time.MS_PER_MIN + s * Time.MS_PER_SEC + t.ms);
        }
      }
    }
    return [...ms].sort((a, b) => a - b).map((v) => new NaiveTime(v));
  }

  /** YEARLY, MONTHLY, WEEKLY or DAILY: each period's days (the date generator's filters) at each time of day. */
  function* byDay(rule: RRule, dtstart: NaiveDateTime, google: boolean, generationLimit?: number): Generator<NaiveDateTime> {
    const props = rule.toFilterProps(null, null, google);
    const step = props.step;
    const filter = filterOf(props);
    // Without time parts the day filter already applied BYSETPOS (`toFilterProps`).
    const setpos = rule.hasTimeParts() ? nonEmpty(rule.inner.options?.bysetpos) : null;
    const times = timesOfDay(rule, dtstart);
    if (times.length === 0) return;

    let start: NaiveDate.MaybeValid = dtstart.date;
    if (step.type === "week") {
      const weekStart = props.options?.weekStart ?? dtstart.date.dayOfWeek;
      let diff = start.dayOfWeek.dow - weekStart.dow;
      if (diff < 0) diff += 7;
      if (diff !== 0) start = dtstart.date.addDays(-diff);
    }

    let idle = 0;
    for (const period of NaiveDate.ndsucc(start, step, Number.MAX_SAFE_INTEGER)) {
      const days = new Map<number, NaiveDate>();
      for (const [day] of filter([period, step.type])) {
        const valid = day.toResult().asOk();
        if (valid != null) days.set(valid.dse, valid);
      }
      const sorted = [...days.values()].sort((a, b) => a.dse - b.dse);
      // Select positions by index, or yield the grid lazily. A yearly rule
      // can describe millions of candidates; COUNT and caller budgets must
      // stop iteration before that whole product is materialized.
      const size = sorted.length * times.length;
      const indices = setpos == null ? null : [...new Set(setpos.map((p) => p > 0 ? p - 1 : size + p)
        .filter((i) => i >= 0 && i < size))].sort((a,b) => a-b);
      const last = size === 0 ? null : new NaiveDateTime(sorted[sorted.length - 1], times[times.length - 1]);
      // Periods wholly before DTSTART (none: the first period holds it) and empty ones count toward the idle limit.
      if (last == null || (indices != null && indices.length === 0) || last.mse < dtstart.mse) {
        if (++idle >= (generationLimit ?? IDLE_LIMIT)) {
          if (generationLimit != null) throw new RecurrenceExpansionLimitError(generationLimit);
          return;
        }
        continue;
      }
      idle = 0;
      if (indices != null) {
        for (const i of indices) yield new NaiveDateTime(sorted[Math.floor(i / times.length)], times[i % times.length]);
      } else {
        for (const day of sorted) for (const time of times) yield new NaiveDateTime(day, time);
      }
    }
  }

  /**
   * HOURLY, MINUTELY or SECONDLY: periods of the frequency's unit, every
   * INTERVAL units from DTSTART's. The date parts and the time parts at or
   * above the unit limit which periods count (a day the date parts refuse
   * is skipped whole); the time parts below it expand each period.
   */
  function* subDaily(rule: RRule, dtstart: NaiveDateTime, google: boolean, generationLimit?: number): Generator<NaiveDateTime> {
    const options = rule.inner.options;
    const freq = rule.inner.freq;
    const unitMs = freq === "hourly" ? Time.MS_PER_HR : freq === "minutely" ? Time.MS_PER_MIN : Time.MS_PER_SEC;
    const stepMs = unitMs * Math.max(1, options?.interval ?? 1);
    const setpos = nonEmpty(options?.bysetpos);
    const byhour = nonEmpty(options?.byhour);
    const byminute = nonEmpty(options?.byminute);
    const bysecond = nonEmpty(options?.bysecond);
    const t = dtstart.time;

    // Offsets within one period: the parts below the unit (DTSTART's when not given).
    const minutes = freq === "hourly" ? byminute ?? [t.mins] : [0];
    const seconds = freq === "secondly" ? [0] : bysecond ?? [t.secs];
    const offsets = [...new Set(minutes.flatMap((m) =>
      seconds.map((s) => m * Time.MS_PER_MIN + s * Time.MS_PER_SEC + t.ms)
    ))].filter((o) => o >= 0 && o < unitMs).sort((a, b) => a - b);
    if (offsets.length === 0) return;

    const dayOk = dayFilter(rule, google);
    const first = Math.floor(dtstart.mse / unitMs) * unitMs;

    let k = 0;
    let idle = 0;
    while (true) {
      const periodMs = first + k * stepMs;
      const period = NaiveDateTime.fromMse(periodMs as MsSinceEpoch);
      // The first period, at or after `ms`, that the stepping reaches.
      const skipTo = (ms: number) => {
        k = Math.max(k + 1, Math.ceil((ms - first) / stepMs));
      };
      if (++idle > (generationLimit ?? IDLE_LIMIT)) {
        if (generationLimit != null) throw new RecurrenceExpansionLimitError(generationLimit);
        return;
      }

      if (!dayOk(period.date)) {
        skipTo((period.date.dse + 1) * Time.MS_PER_DAY);
        continue;
      }
      const time = period.time;
      if (byhour != null && !byhour.includes(time.hrs)) {
        skipTo(Math.floor(periodMs / Time.MS_PER_HR + 1) * Time.MS_PER_HR);
        continue;
      }
      if (freq !== "hourly" && byminute != null && !byminute.includes(time.mins)) {
        skipTo(Math.floor(periodMs / Time.MS_PER_MIN + 1) * Time.MS_PER_MIN);
        continue;
      }
      if (freq === "secondly" && bysecond != null && !bysecond.includes(time.secs)) {
        k++;
        continue;
      }

      let set = offsets.map((o) => NaiveDateTime.fromMse((periodMs + o) as MsSinceEpoch));
      if (setpos != null) set = pickSetPos(set, setpos);
      k++;
      if (set.length === 0 || set[set.length - 1].mse < dtstart.mse) continue;
      idle = 0;
      yield* set;
    }
  }

  /** Whether the rule's date parts keep `day`, read as a DAILY rule's would (each a limit on the day). */
  function dayFilter(rule: RRule, google: boolean): (day: NaiveDate) => boolean {
    const options = rule.inner.options;
    const daily = new (rule.constructor as typeof RRule)({
      freq: "daily",
      options: {
        wkst: options?.wkst,
        byday: options?.byday,
        bynthday: options?.bynthday,
        bymonth: options?.bymonth,
        bymonthday: options?.bymonthday,
        byweekno: options?.byweekno,
        byyearday: options?.byyearday,
      },
    });
    const filter = filterOf(daily.toFilterProps(null, null, google));
    const seen = new Map<number, boolean>();
    return (day) => {
      let ok = seen.get(day.dse);
      if (ok == null) {
        ok = false;
        for (const [kept] of filter([day, "day"])) {
          if (kept.toResult().asOk()?.dse === day.dse) {
            ok = true;
            break;
          }
        }
        seen.set(day.dse, ok);
      }
      return ok;
    };
  }

  /** The one filter `props` names (a list composes). */
  function filterOf(props: NaiveDate.FilterProps): NaiveDate.Filter {
    const f = props.options?.filter;
    if (f == null) return NaiveDate.Filter.identity();
    return Array.isArray(f) ? NaiveDate.Filter.compose(f) : f;
  }

  function nonEmpty<T>(xs: Option<readonly T[]>): Option<readonly T[]> {
    return xs != null && xs.length > 0 ? xs : null;
  }
}
