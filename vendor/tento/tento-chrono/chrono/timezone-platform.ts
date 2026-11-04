import type { TimezoneRegion } from "./timezone-region.ts";
import type { Option } from "./option.ts";

/**
 * The platform's own zone data (`Intl.DateTimeFormat`, which carries every
 * name `Intl.supportedValuesOf("timeZone")` reports): a zone's UTC offset at
 * an instant, and a zone's transitions rebuilt from those offsets.
 * `TimezoneRegion.getOpt` checks every zone it loads against the platform and
 * builds the zone from here when the zone service disagrees (the 2024b
 * `1900_2050` files drop some zones' last offset change: Pacific/Honolulu's
 * ends at -10:30, America/Regina's at -07:00).
 */
export namespace PlatformZone {
  /** The window the zone service's files cover, and the one a rebuilt zone covers. */
  export const WINDOW_START_MS = Date.UTC(1900, 0, 1);
  export const WINDOW_END_MS = Date.UTC(2050, 0, 1);

  /**
   * The scan step of `transitions` on a platform without `Temporal`: every
   * offset change is found to the second, but two changes less than a step
   * apart that cancel out are not seen (no zone in tzdata has one since 1970).
   */
  const STEP_MS = 7 * 86_400_000;

  /**
   * `tzname`'s UTC offset in seconds at an instant (ms since the epoch); null
   * when the platform does not know the name, or cannot format an offset.
   */
  export function offsets(tzname: string): Option<(ms: number) => number> {
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat("en-US", { timeZone: tzname, timeZoneName: "longOffset" });
    } catch {
      return null;
    }
    return (ms) => parseOffset(format.format(ms));
  }

  /**
   * `tzname`'s transitions over `[fromMs, toMs)` as the zone service
   * serializes them, first the offset in force at `fromMs` (a transition to
   * itself); null when the platform does not know the name. Each change is
   * read from the platform's own transition list (`Temporal`: a few Intl
   * reads per change, about 1 ms for a zone with 250 changes); a platform
   * without it scans the window in `STEP_MS` steps (about 7,800 Intl reads
   * for 1900-2050, 10-20 ms a zone).
   */
  export function transitions(
    tzname: string,
    fromMs: number = WINDOW_START_MS,
    toMs: number = WINDOW_END_MS,
  ): Option<TimezoneRegion.Transition.Serialized[]> {
    const at = offsets(tzname);
    if (at == null) return null;
    const abbr = abbreviations(tzname);
    const changeAfter = listedChanges(tzname) ?? scannedChanges(at, fromMs);
    let prev = at(fromMs);
    const out = [serialized(fromMs, prev, prev, abbr(fromMs), abbr(fromMs))];
    for (let t = changeAfter(fromMs, toMs, prev); t != null; t = changeAfter(t, toMs, prev)) {
      const after = at(t);
      if (after === prev) continue;
      out.push(serialized(t, prev, after, abbr(t - 1000), abbr(t)));
      prev = after;
    }
    return out;
  }

  /**
   * The first instant in `(t, toMs)` at which the offset is no longer
   * `prev` (the offset in force at `t`), to the second; null when there is
   * none.
   */
  type ChangeAfter = (t: number, toMs: number, prev: number) => Option<number>;

  /** The shape of `Temporal` read here; absent on a platform without it. */
  interface TemporalZones {
    readonly Instant: {
      fromEpochMilliseconds(ms: number): {
        toZonedDateTimeISO(tzname: string): {
          getTimeZoneTransition(direction: "next"): { readonly epochMilliseconds: number } | null;
        };
      };
    };
  }

  /** `tzname`'s next change from the platform's transition list; null when the platform has no `Temporal` or it refuses the name. */
  function listedChanges(tzname: string): Option<ChangeAfter> {
    const temporal: TemporalZones | undefined = Reflect.get(globalThis, "Temporal");
    if (temporal?.Instant == null) return null;
    const zoned = (ms: number) => temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tzname);
    try {
      zoned(WINDOW_START_MS);
    } catch {
      return null;
    }
    return (t, toMs) => {
      const next = zoned(t).getTimeZoneTransition("next")?.epochMilliseconds;
      return next == null || next >= toMs ? null : next;
    };
  }

  /**
   * The next change found by scanning in `STEP_MS` steps on a grid from
   * `gridMs` (a change found inside a step does not move the grid), then
   * bisecting a step to the second.
   */
  function scannedChanges(at: (ms: number) => number, gridMs: number): ChangeAfter {
    return (from, toMs, prev) => {
      for (let t = from; t < toMs; ) {
        const next = Math.min(gridMs + (Math.floor((t - gridMs) / STEP_MS) + 1) * STEP_MS, toMs);
        if (at(next) !== prev) {
          // The first second in (t, next] at another offset: at(lo) is prev, at(hi) is not.
          let lo = t;
          let hi = next;
          while (hi - lo > 1000) {
            const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
            if (at(mid) === prev) lo = mid;
            else hi = mid;
          }
          return hi;
        }
        t = next;
      }
      return null;
    };
  }

  function abbreviations(tzname: string): (ms: number) => string {
    const format = new Intl.DateTimeFormat("en-US", { timeZone: tzname, timeZoneName: "short" });
    return (ms) => format.formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  }

  /** "GMT", "GMT-10:00", "GMT+05:45", "GMT-07:52:58" (a local mean time) -> seconds east of UTC. */
  function parseOffset(formatted: string): number {
    const at = formatted.lastIndexOf("GMT");
    const m = /^([+\-−])(\d\d):(\d\d)(?::(\d\d))?/.exec(formatted.slice(at + 3));
    if (at < 0 || m == null) return 0;
    const secs = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0);
    return m[1] === "+" ? secs : -secs;
  }

  /** One transition at `ms`, from `before` to `after` (seconds, written to the minute as RFC 3339 offsets are). */
  function serialized(
    ms: number,
    before: number,
    after: number,
    beforeAbbr: string,
    afterAbbr: string,
  ): TimezoneRegion.Transition.Serialized {
    return { before: rfc3339(ms, before), before_tz_abbr: beforeAbbr, after: rfc3339(ms, after), after_tz_abbr: afterAbbr };
  }

  function rfc3339(ms: number, offsetSecs: number): string {
    const mins = Math.round(offsetSecs / 60);
    const abs = Math.abs(mins);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${new Date(ms + mins * 60_000).toISOString().slice(0, 19)}${mins < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }
}
