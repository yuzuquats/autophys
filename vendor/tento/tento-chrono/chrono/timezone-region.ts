import { DateRegion } from "./date-region.ts";
import { DateTimeRegion } from "./date-time-region.ts";
import { DateTime } from "./datetime.ts";
import { NaiveDate } from "./naive-date.ts";
import { NaiveDateTime } from "./naive-datetime.ts";
import {
  FixedOffset,
  FixedTimezone,
  LogicalTimezone,
  TimezoneInfo,
  Tzabbr,
  Tzname,
  Utc,
} from "./timezone.ts";
import { PlatformZone } from "./timezone-platform.ts";
import { Epoch } from "./units/epoch.ts";
import { TimeOfDay } from "./units/time-of-day.ts";
import { MsSinceEpoch } from "./units/units.ts";
import type { Option } from "./option.ts";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Chrono runs under a standalone Deno import map, so this fallback loader cannot
// import @tento-core/resource-client. UI/app code should use ResourceClient for
// static-domain resources when package boundaries allow it.
//
// Detect static subdomain from current hostname for instance-aware URLs.
// dev--calendar.lona.so -> dev--static.lona.so
function getStaticSubdomain(): string {
  const hostname =
    typeof globalThis !== "undefined" && globalThis.location?.hostname
      ? globalThis.location.hostname
      : "";
  const parts = hostname.split(".");
  if (parts.length < 3) return "static";
  const subdomain = parts[0];
  if (subdomain.includes("--")) {
    return subdomain.split("--")[0] + "--static";
  }
  return "static";
}

// App shells already define this helper for private wrappers and explicit ports.
// Standalone Chrono callers keep their instance-aware static-domain fallback.
function getStaticResourceOrigin(): string {
  const getOrigin = Reflect.get(globalThis, "getStaticOrigin");
  if (typeof getOrigin === "function") {
    const origin = getOrigin();
    if (typeof origin === "string" && origin) return origin.replace(/\/$/, "");
  }
  return `https://${getStaticSubdomain()}.lona.so`;
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class TimezoneRegion {
  readonly fullname: Tzname;
  readonly transitions: TimezoneRegion.Transition[];
  /**
   * Where the zone service's transitions for this zone disagreed with the
   * platform's offset, when this region was built from the platform's
   * instead (`getOpt`); null for a region taken as served.
   */
  readonly mismatch: Option<TimezoneRegion.OffsetMismatch>;
  /**
   * The zone this name's file says it links to (a tzdata `backward` name's
   * file carries `linkOf`, its resolved canonical zone; requests/tz-to-sdk-1),
   * kept as provenance; null for a zone's own file or a file without the field.
   */
  readonly linkOf: Option<Tzname>;
  /**
   * Why the zone service had no data for this zone (`TimezoneRegion.Unserved`),
   * or `no-answer` when its fetch got none, when this region was built from
   * the platform's offsets instead (`getOpt`); null for a region the service
   * served.
   */
  readonly unserved: Option<TimezoneRegion.FromPlatformReason>;
  private tzs: Map<Tzabbr, FixedTimezone> = new Map();

  constructor(
    fullname: Tzname,
    transitions: TimezoneRegion.Transition[],
    mismatch: Option<TimezoneRegion.OffsetMismatch> = null,
    linkOf: Option<Tzname> = transitions[0]?.linkOf ?? null,
    unserved: Option<TimezoneRegion.FromPlatformReason> = null,
  ) {
    this.fullname = fullname;
    this.transitions = transitions.sort((a, b) => a.before.mse - b.before.mse);
    this.mismatch = mismatch;
    this.linkOf = linkOf;
    this.unserved = unserved;
  }

  static async local(): Promise<TimezoneRegion> {
    let info = TimezoneInfo.local();
    return await TimezoneRegion.get(info.tzname!, undefined, "runtime");
  }

  static UTC: TimezoneRegion = new TimezoneRegion("UTC" as Tzname, [
    {
      before: {
        mse: 0 as MsSinceEpoch,
        time: DateTime.fromMse(0 as MsSinceEpoch, Utc),
        tzabbr: "utc",
      },
      after: {
        time: DateTime.fromMse(0 as MsSinceEpoch, Utc),
        tzabbr: "utc",
      },
    },
  ]);

  activeTransition(mse: MsSinceEpoch): Option<TimezoneRegion.Transition> {
    const found = this.bst(mse);
    if (found < 0) return null;

    const transition = this.transitions[found];
    return transition;
  }

  transitionsBetween({
    start,
    end,
  }: {
    start: MsSinceEpoch;
    end: MsSinceEpoch;
  }): TimezoneRegion.Transition[] {
    const startIdx = this.bst(start);
    const endIdx = this.bst(end);
    return this.transitions.slice(
      startIdx > 0 ? startIdx : undefined,
      endIdx > 0 ? endIdx + 1 : undefined,
    );
  }

  private bst(target: MsSinceEpoch): number {
    let left = 0;
    let right = this.transitions.length - 1;
    let result = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const cmp = this.transitions[mid].before.mse - target;
      if (cmp === 0) {
        return mid;
      } else if (cmp > 0) {
        right = mid - 1;
      } else {
        result = mid;
        left = mid + 1;
      }
    }

    return result;
  }

  today(): DateRegion {
    return new DateRegion(NaiveDate.today(), this);
  }

  now(): DateTimeRegion {
    // Convert current UTC time to local wall-clock time
    const utcNow = DateTime.fromMse(Epoch.currentMse(), Utc);
    const localNow = this.toTz(utcNow);
    return new DateTimeRegion(localNow.ndt, this);
  }

  date(nd: NaiveDate): DateRegion {
    return new DateRegion(nd, this);
  }

  datetime(ndt: NaiveDateTime): DateTimeRegion {
    return new DateTimeRegion(ndt, this);
  }

  /**
   * Google Calendar-specific datetime resolution that handles DST transitions
   * by preserving local time but using appropriate timezone rules for each date.
   *
   * ## Key Findings from DST Testing
   *
   * Google Calendar uses a unique approach to DST transition handling in recurring events:
   *
   * ### Spring Forward Transitions (e.g., PST -> PDT)
   * - When clocks "spring forward" (e.g., 2:00 AM becomes 3:00 AM), there's a gap in local time
   * - Google Calendar uses a universal 1-hour boundary rule regardless of actual DST gap size
   * - If recurrence time is >=60 minutes after the transition time, use post-transition timezone
   * - If recurrence time is <60 minutes after the transition time, use pre-transition timezone
   * - This rule applies universally: Australia/Lord_Howe (30min gap) still uses 60min boundary
   *
   * ### Fall Back Transitions (e.g., PDT -> PST)
   * - When clocks "fall back" (e.g., 2:00 AM becomes 1:00 AM), local time repeats
   * - Google Calendar uses post-transition timezone if recurrence time >= transition time
   * - This creates consistent UTC times across the transition
   *
   * ### Test Case Validation
   * - Validated across multiple timezones: America/Los_Angeles, Europe/London, Australia/Adelaide, Australia/Lord_Howe
   * - Tested boundary conditions: 59min vs 60min gaps
   * - Achieved 100% test success rate (53/53 tests) with this implementation
   *
   * @param ndt The naive datetime to resolve
   * @param originalDateTime The original datetime from the recurring event start (used to determine timezone context)
   * @returns DateTime with appropriate timezone for Google Calendar compatibility
   */
  googleDatetimeResolved(
    ndt: NaiveDateTime,
    originalDateTime?: DateTime<any>,
  ): DateTime<FixedOffset> {
    // If no original datetime context, fall back to standard resolution
    if (!originalDateTime) {
      return this.toWallClock(ndt);
    }

    const originalDate = originalDateTime.ndt.date;
    const currentDate = ndt.date;

    // Find any DST transitions between the original date and current date
    const transitionStart = new NaiveDateTime(originalDate);
    const transitionEnd = new NaiveDateTime(currentDate).add({
      hrs: 23,
      mins: 59,
      secs: 59,
    });

    const transitions = this.transitionsBetween({
      start: transitionStart.mse,
      end: transitionEnd.mse,
    });

    // No DST transitions found - use original timezone
    if (transitions.length === 0) {
      return new DateTime(ndt, originalDateTime.tz);
    }

    const lastTransition = transitions[transitions.length - 1];
    const transitionDate = lastTransition.after.time.ndt.date;

    // Current date is after transition date - use post-transition timezone
    if (currentDate.dse > transitionDate.dse) {
      return new DateTime(ndt, lastTransition.after.time.tz);
    }

    // Current date is before transition date - use original timezone
    if (currentDate.dse < transitionDate.dse) {
      return new DateTime(ndt, originalDateTime.tz);
    }

    // Current date equals transition date - check time-specific rules
    const transitionTime = lastTransition.before.time.ndt.time;
    const currentTime = ndt.time;

    const beforeOffset = lastTransition.before.time.tz.info.offset.toHrsF;
    const afterOffset = lastTransition.after.time.tz.info.offset.toHrsF;
    const isFallBack = afterOffset < beforeOffset;
    const isSpringForward = afterOffset > beforeOffset;

    if (isFallBack) {
      // Fall back: use post-transition timezone if at or after transition time
      if (currentTime.toMs >= transitionTime.toMs) {
        return new DateTime(ndt, lastTransition.after.time.tz);
      }
      return new DateTime(ndt, originalDateTime.tz);
    }

    if (isSpringForward) {
      // Spring forward: use post-transition timezone if >=60 minutes after transition
      const timeGapMs = currentTime.toMs - transitionTime.toMs;
      const hourInMs = 60 * 60 * 1000;

      if (timeGapMs >= hourInMs) {
        return new DateTime(ndt, lastTransition.after.time.tz);
      }
      return new DateTime(ndt, originalDateTime.tz);
    }

    // Default case - use original timezone
    return new DateTime(ndt, originalDateTime.tz);
  }

  /**
   * Convert a wall-clock NaiveDateTime to DateTime, properly handling DST edge cases.
   *
   * This function correctly resolves ambiguous or invalid wall-clock times:
   * - For times in spring-forward gap (e.g., 2:30 AM on DST day): uses post-transition (later) offset
   * - For times in fall-back overlap (e.g., 1:30 AM occurs twice): uses post-transition (later) offset
   *
   * This finds DST transitions by checking the actual day of the NaiveDateTime,
   * rather than comparing `ndt.mse` (which is a naive "wall-clock MSE") against
   * UTC-based transition timestamps.
   */
  // Cache the "no transition" timezone per DSE to avoid repeated bst lookups.
  // Most dates have no transitions — this skips transitionsBetween entirely.
  private _wallClockTzCache = new Map<number, LogicalTimezone<any>>();

  toWallClock(ndt: NaiveDateTime): DateTime<FixedOffset> {
    const dse = ndt.date.dse;

    // Fast path: if we've already determined this date has no transitions,
    // reuse the cached timezone directly.
    const cachedTz = this._wallClockTzCache.get(dse);
    if (cachedTz) return ndt.withTz(cachedTz);

    const dayStartMse = ndt.date.withTime(TimeOfDay.fromHms({ hrs: 0 })).mse;
    const dayEndMse = dayStartMse + 24 * 60 * 60 * 1000;

    const transitions = this.transitionsBetween({
      start: (dayStartMse - 24 * 60 * 60 * 1000) as MsSinceEpoch,
      end: (dayEndMse + 24 * 60 * 60 * 1000) as MsSinceEpoch,
    });

    if (transitions.length === 0) {
      const tz = this.tzAtMse(ndt.mse);
      this._wallClockTzCache.set(dse, tz);
      return ndt.withTz(tz);
    }

    for (const transition of transitions) {
      const transitionDate = transition.after.time.ndt.date;

      if (!ndt.date.equals(transitionDate)) {
        continue;
      }

      const beforeOffset = transition.before.time.tz.info.offset;
      const afterOffset = transition.after.time.tz.info.offset;
      const beforeOffsetHrs = beforeOffset.toHrsF;
      const afterOffsetHrs = afterOffset.toHrsF;

      const isSpringForward = afterOffsetHrs > beforeOffsetHrs;
      const isFallBack = afterOffsetHrs < beforeOffsetHrs;

      const transitionWallTime = transition.before.time.ndt.time;

      if (isSpringForward) {
        const gapSizeMs =
          (afterOffsetHrs - beforeOffsetHrs) * 60 * 60 * 1000;
        const gapStartMs = transitionWallTime.toMs;
        const gapEndMs = gapStartMs + gapSizeMs;
        const currentTimeMs = ndt.time.toMs;

        if (currentTimeMs >= gapStartMs && currentTimeMs < gapEndMs) {
          return ndt.withTz(this.asAsked(transition.after.time.tz));
        }

        if (currentTimeMs >= gapEndMs) {
          return ndt.withTz(this.asAsked(transition.after.time.tz));
        }

        return ndt.withTz(this.asAsked(transition.before.time.tz));
      }

      if (isFallBack) {
        const overlapSizeMs =
          (beforeOffsetHrs - afterOffsetHrs) * 60 * 60 * 1000;
        const overlapStartMs = transitionWallTime.toMs - overlapSizeMs;
        const overlapEndMs = transitionWallTime.toMs;
        const currentTimeMs = ndt.time.toMs;

        if (currentTimeMs >= overlapStartMs && currentTimeMs < overlapEndMs) {
          return ndt.withTz(this.asAsked(transition.after.time.tz));
        }

        if (currentTimeMs >= overlapEndMs) {
          return ndt.withTz(this.asAsked(transition.after.time.tz));
        }

        return ndt.withTz(this.asAsked(transition.before.time.tz));
      }
    }

    const tz = this.tzAtMse(ndt.mse);
    return ndt.withTz(tz);
  }

  /**
   * A transition's own timezone under the name this region was asked by. A merged city that shares a platform-built
   * target's transitions (operator Q23) keeps its own name on a transition day, as tzAtMse does on every other day
   * (review I I-4); the offset and abbreviation stay the transition's.
   */
  private asAsked(tz: LogicalTimezone<any>): LogicalTimezone<any> {
    if (!(tz instanceof FixedTimezone) || tz.info.tzname === this.fullname) return tz;
    return new FixedTimezone(tz.id, { ...tz.info, tzname: this.fullname });
  }

  toTz(dt: DateTime<any>): DateTime<FixedOffset> {
    const tz = this.tzAtMse(dt.mse);
    return dt.asUtc().toTz(tz);
  }

  tzAtMse(mse: MsSinceEpoch): LogicalTimezone<any> {
    const transition = this.activeTransition(mse);
    if (!transition) return Utc;
    const tzabbr = transition.after.tzabbr;

    // Remove all caching to avoid issues with GMT/BST sharing the same tzabbr
    const tz = new FixedTimezone(tzabbr, {
      offset: transition.after.time.tz.info.offset,
      tzabbr,
      tzname: this.fullname,
    });
    return tz;
  }

  print() {
    for (const [idx, transition] of this.transitions.entries()) {
      TimezoneRegion.Transition.print(transition, idx);
    }
  }

  toString(): string {
    return `[${this.fullname}]`;
  }
}

export namespace TimezoneRegion {
  /**
   * Loader
   */
  export interface Loader {
    load: (tzname: Tzname) => Promise<Transition[]>;
    /** Forget what the loader decided for this process (`setLoader` calls it when the loader is installed). */
    restart?: () => void;
    /** The data version it loads in place of the one asked for, once it decided so (`dataVersionFallback`); `null` while it has not. */
    versionFallback?: () => Option<VersionFallback>;
  }

  /**
   * The tzdata version of the zone data `DYNAMIC_LOADER` asks the zone
   * service for: the regenerated tento-tz 2025a files (every zone's current
   * offset, a base offset for constant zones, a file per backward name). The
   * service still answers the earlier `2024b` label for older clients.
   */
  export const DATA_VERSION = "2025a";

  /** The label the zone service answered before `DATA_VERSION`, served to older clients: `servedLoader`'s fallback. */
  export const LEGACY_DATA_VERSION = "2024b";

  /** A zone every data version the service has served carries: its 404 means the version itself is not served. */
  const VERSION_PROBE_ZONE = "America/New_York" as Tzname;

  /** A data version the zone service did not serve, and the one `servedLoader` loads instead (`takeVersionFallbacks`). */
  export interface VersionFallback {
    readonly asked: string;
    readonly used: string;
  }

  const versionFallbacksUnreported: VersionFallback[] = [];

  /**
   * The data version fallbacks loaders took since the last call, each once:
   * for a host to report that the service does not serve the configured
   * data (the SDK's `ZoneLoad.report` traces each as `tz/data-version-fallback`).
   */
  export function takeVersionFallbacks(): VersionFallback[] {
    return versionFallbacksUnreported.splice(0);
  }

  /**
   * The data version fallback the installed loader took (`servedLoader`:
   * the service does not serve the version asked for, so it loads the
   * legacy one), for as long as that loader stands; `null` when it took
   * none, or keeps no such record. A standing condition every reader can
   * ask, unlike `takeVersionFallbacks`, which hands each fallback out once.
   */
  export function dataVersionFallback(): Option<VersionFallback> {
    return loader.versionFallback?.() ?? null;
  }

  /**
   * The zone service's `1900_2050` files of `version`. A 404 can mean the
   * zone has no data or that `version` is not deployed (a frontend shipped
   * before the service): on the first 404 the loader asks once whether
   * `version` is served at all (one fetch of `VERSION_PROBE_ZONE`). When it
   * is not, the loader records the fallback (`takeVersionFallbacks`) and
   * loads this and every later zone from `legacy`, so served data (checked
   * against the platform as any served zone is) replaces an Intl build per
   * zone; only a zone `legacy` has no data for either is `Unserved`. A probe
   * that gets no answer decides nothing: the zone is `Unserved` and the
   * next 404 asks again. Every fetch, its body included, ends after
   * `timeoutMs` (`FETCH_TIMEOUT_MS`): a fetch that does not answer by then
   * rejects as no answer (`getOpt`), so a stalled network never stalls a
   * zone read past it. The loader throws `NoAnswer` for a fetch or body read
   * that `fetch` rejected (a network failure, the deadline) and for a status
   * that says "not now" (5xx, 429, 408); a 404 is `Unserved`, and any other
   * failure (another status, a malformed file) is a plain error.
   */
  export function servedLoader(
    version: string = DATA_VERSION,
    legacy: string = LEGACY_DATA_VERSION,
    timeoutMs: number = FETCH_TIMEOUT_MS,
  ): Loader {
    const fileUrl = (v: string, tzname: Tzname) =>
      `${getStaticResourceOrigin()}/timezones/${v}/1900_2050/${tzname.replaceAll("/", "~")}.json`;
    const fetchFile = (v: string, tzname: Tzname) =>
      fetch(fileUrl(v, tzname), { signal: AbortSignal.timeout(timeoutMs) }).catch((e) => {
        throw noAnswerOf(tzname, e);
      });
    let decided: Option<string> = null;
    let probing: Option<Promise<Option<string>>> = null;
    const servedVersion = (): Promise<Option<string>> => {
      probing ??= fetchFile(version, VERSION_PROBE_ZONE).then(async (probe) => {
        await probe.body?.cancel();
        if (probe.ok) return decided = version;
        if (probe.status !== 404) return null;
        versionFallbacksUnreported.push({ asked: version, used: legacy });
        announce({ kind: "data-version-fallback", asked: version, used: legacy });
        return decided = legacy;
      }, () => null).finally(() => probing = null);
      return probing;
    };
    return {
      load: async (tzname: Tzname) => {
        let response = await fetchFile(decided ?? version, tzname);
        if (response.status === 404 && decided == null && await servedVersion() === legacy) {
          await response.body?.cancel();
          response = await fetchFile(legacy, tzname);
        }
        if (response.status === 404) throw new Unserved(tzname, "not-found");
        if (!response.ok) {
          await response.body?.cancel();
          const failed = new Error(`Failed to fetch timezone ${tzname}: ${response.status}`);
          if (NOT_NOW.has(response.status) || response.status >= 500) {
            throw new NoAnswer(tzname, `HTTP ${response.status}`, failed);
          }
          throw failed;
        }

        // A body `fetch` stops reading (the deadline, a dropped connection) is no answer; a body that is not JSON is a malformed file.
        const raw: JsonValue = await response.json().catch((e) => {
          throw noAnswerOf(tzname, e);
        });
        const transitions = parseTimezoneTransitions(raw);
        return transitions.map((transition) => Transition.parse(transition, tzname));
      },
      restart: () => {
        decided = null;
      },
      versionFallback: () => decided === legacy && legacy !== version ? { asked: version, used: legacy } : null,
    };
  }

  /**
   * How long `servedLoader` waits for one zone file (its body included)
   * before it takes the fetch as unanswered: well past a healthy fetch (tens
   * of milliseconds), well short of an OS connect timeout.
   */
  export const FETCH_TIMEOUT_MS = 10_000;

  /** The statuses besides 5xx that say "not now" rather than "no such file": too many requests, request timeout. */
  const NOT_NOW: ReadonlySet<number> = new Set([429, 408]);

  /** `e` as `NoAnswer` when `fetch` rejected with it (`TypeError`, or an abort: the loader's deadline); anything else unchanged. */
  function noAnswerOf(tzname: Tzname, e: unknown): unknown {
    const unanswered = e instanceof TypeError ||
      (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"));
    return unanswered ? new NoAnswer(tzname, e instanceof Error ? e.message : String(e), e) : e;
  }

  /**
   * Lona's zone service's `DATA_VERSION` files, falling back to
   * `LEGACY_DATA_VERSION` when it is not served (`servedLoader`). Opt in with
   * `setLoader(DYNAMIC_LOADER)`; the default is `PLATFORM_LOADER`.
   */
  export const DYNAMIC_LOADER: Loader = servedLoader();

  function parseTimezoneTransitions(
    raw: JsonValue,
  ): TimezoneRegion.Transition.Serialized[] {
    if (!Array.isArray(raw)) {
      throw new Error("expected timezone transition list");
    }
    return raw.map(parseTimezoneTransition);
  }

  function parseTimezoneTransition(
    raw: JsonValue,
  ): TimezoneRegion.Transition.Serialized {
    if (!isJsonRecord(raw)) {
      throw new Error("expected timezone transition");
    }

    if (
      typeof raw.before !== "string" ||
      typeof raw.before_tz_abbr !== "string" ||
      typeof raw.after !== "string" ||
      typeof raw.after_tz_abbr !== "string"
    ) {
      throw new Error("expected timezone transition");
    }
    // Optional (tz-to-sdk-1), read when present: the first entry's standing
    // offset, and a backward name's canonical zone. A wrong type rejects the file.
    const base = raw.baseOffsetSeconds;
    const linkOf = raw.linkOf;
    if ((base !== undefined && (typeof base !== "number" || !Number.isInteger(base))) ||
      (linkOf !== undefined && typeof linkOf !== "string")) {
      throw new Error("expected timezone transition");
    }

    return {
      before: raw.before,
      before_tz_abbr: raw.before_tz_abbr,
      after: raw.after,
      after_tz_abbr: raw.after_tz_abbr,
      ...(base !== undefined ? { baseOffsetSeconds: base } : {}),
      ...(linkOf !== undefined ? { linkOf } : {}),
    };
  }

  /** Why the zone service had no data for a zone: no file (a 404), or a file with no transitions. */
  export type UnservedReason = "not-found" | "no-transitions";

  /**
   * Why a region was built from the platform's offsets for want of served
   * data: the service had none (`UnservedReason`), or its fetch got no answer
   * (`no-answer`: a network failure or the loader's deadline).
   */
  export type FromPlatformReason = UnservedReason | "no-answer";

  /**
   * The zone service answered that it has no data for a zone (`reason`), as
   * opposed to not answering: `getOpt` builds such a zone from the
   * platform's offsets when the platform knows the name (`unserved`). A
   * loader throws it for a name the service does not serve.
   */
  export class Unserved extends Error {
    readonly tzname: Tzname;
    readonly reason: UnservedReason;

    constructor(tzname: Tzname, reason: UnservedReason) {
      super(`zone ${tzname}: the zone service has no data for it (${reason})`);
      this.name = "TimezoneRegion.Unserved";
      this.tzname = tzname;
      this.reason = reason;
    }
  }

  /**
   * The zone service gave no answer for a zone: its fetch was rejected (a
   * network failure, the loader's deadline) or it answered "not now" (5xx,
   * 429, 408). `servedLoader` throws it, wrapping the failure as `cause`;
   * `getOpt` builds such a zone from the platform's offsets
   * (`unserved: "no-answer"`) and asks again after `UNLOADABLE_RETRY_MS`.
   * A custom loader throws it to say the same; any other error it throws
   * (its own `TypeError` included) means the zone does not load.
   */
  export class NoAnswer extends Error {
    readonly tzname: Tzname;

    constructor(tzname: Tzname, detail: string, cause?: unknown) {
      super(`zone ${tzname}: the zone service gave no answer (${detail})`, { cause });
      this.name = "TimezoneRegion.NoAnswer";
      this.tzname = tzname;
    }
  }

  /**
   * Every zone built from the platform's own timezone data (`Intl`), with no
   * network: the default loader. A name the platform does not know is
   * `Unserved`. Its abbreviations are the platform's (`GMT-5`, not `EST`).
   */
  export const PLATFORM_LOADER: Loader = {
    load: (tzname: Tzname) => {
      const transitions = PlatformZone.transitions(tzname);
      if (transitions == null) return Promise.reject(new Unserved(tzname, "not-found"));
      return Promise.resolve(transitions.map((t) => Transition.parse(t, tzname)));
    },
  };

  let loader: Loader = PLATFORM_LOADER;

  /**
   * Api
   */
  const defaultCache = new Map([
    ["UTC", new TimezoneRegion("UTC" as Tzname, [])],
  ]);
  /**
   * `tzname`'s zone, or `defaultTz`'s when it does not load. `source` names
   * the read that asked (an iCal line's `TZID`, a recurrence rule's zone, the
   * runtime's zone), carried by the fallback it records.
   */
  export async function get(
    tzname: Tzname = TimezoneInfo.local().tzname!,
    defaultTz: Tzname = "UTC" as Tzname,
    source: FallbackSource = "other",
  ): Promise<TimezoneRegion> {
    // A link name loads as its canonical zone, exactly as `getOpt` loads it.
    const region = await getOpt(tzname);
    if (region != null) return region;
    // Never silently: the fallback is recorded for a host to report (`takeFallbacks`), and every listener hears it (`onOutcome`).
    if (!fallbacksUnreported.some((f) => f.requested === tzname && f.used === defaultTz)) {
      fallbacksUnreported.push({ requested: tzname, used: defaultTz, source });
    }
    announce({ kind: "fallback", requested: tzname, used: defaultTz, source });
    return defaultCache.get(defaultTz)!;
  }

  /** Which of chrono's reads took a fallback (`get`): an iCal line's `TZID`, a recurrence rule's zone, the runtime's zone, or another caller. */
  export type FallbackSource = "ical-tzid" | "rrule" | "runtime" | "other";

  /** A zone `get` could not load (`requested`), the zone it answered instead (`used`), and the read that asked (`source`). */
  export interface Fallback {
    readonly requested: Tzname;
    readonly used: Tzname;
    readonly source: FallbackSource;
  }

  /**
   * A zone outcome as it happens (`onOutcome`): a fallback a zone read took
   * (`source`: chrono's own `FallbackSource`, or what a loader above chrono
   * names its reads, `reportFallback`); a zone whose times come from the
   * platform's offsets (`region.unserved`: the service has no data for it;
   * `region.mismatch`: its served data disagreed with the platform); a data
   * version the service does not serve (`servedLoader`).
   */
  export type Outcome =
    | { readonly kind: "fallback"; readonly requested: string; readonly used: Tzname; readonly source: string }
    | { readonly kind: "from-platform"; readonly region: TimezoneRegion }
    | { readonly kind: "data-version-fallback"; readonly asked: string; readonly used: string };

  const outcomeListeners = new Set<(outcome: Outcome) => void>();

  /**
   * Tell `listener` every zone outcome from now on, as it happens, until the
   * returned function removes it. Unlike the take-queues (`takeRebuilt`,
   * `takeFallbacks`, `takeVersionFallbacks`), which hand each outcome out
   * once to whichever caller drains first, every listener hears every
   * outcome; and a zone built from the platform is told again each time a
   * load answers it (`getOpt`, a cache hit too), so a reader that started
   * listening after the zone was built hears it when it uses the zone. A
   * listener that throws is logged and the others still hear the outcome.
   */
  export function onOutcome(listener: (outcome: Outcome) => void): () => void {
    outcomeListeners.add(listener);
    return () => outcomeListeners.delete(listener);
  }

  /**
   * A fallback a zone loader above chrono took (the SDK's: an event's zone,
   * a ground index with none), told to every outcome listener with the
   * caller's `source`. It joins no take-queue: the reporter traces its own.
   */
  export function reportFallback(fallback: { readonly requested: string; readonly used: Tzname; readonly source: string }): void {
    announce({ kind: "fallback", ...fallback });
  }

  function announce(outcome: Outcome): void {
    for (const listener of outcomeListeners) {
      try {
        listener(outcome);
      } catch (e) {
        console.error("TimezoneRegion.onOutcome: a listener threw", e);
      }
    }
  }

  /** Tell the listeners `region` when its times come from the platform's offsets (`unserved`, or a `mismatch` rebuild). */
  function announceFromPlatform(region: TimezoneRegion): void {
    if (outcomeListeners.size > 0 && (region.unserved != null || region.mismatch != null)) {
      announce({ kind: "from-platform", region });
    }
  }

  const fallbacksUnreported: Fallback[] = [];

  /**
   * The fallbacks `get` took since the last call (an iCal line's TZID, a
   * recurrence rule's zone, a runtime zone that does not load, read in the
   * default zone instead), each pending (requested, used) pair once: for a
   * host to report every fallback, whichever chrono read took it (the SDK's
   * `ZoneLoad.report` traces each as `tz/zone-fallback`).
   */
  export function takeFallbacks(): Fallback[] {
    return fallbacksUnreported.splice(0);
  }

  /**
   * Synchronously return an ALREADY-LOADED region, or null if it hasn't been
   * loaded yet. For hot sync paths that can tolerate a miss (the async `get`
   * warms `defaultCache`, so a region in active use — e.g. an expanded
   * recurrence series — is present here). UTC is always available. A zone
   * `getOpt` holds from the platform for want of an answer is answered here
   * too, so a synchronous reader reads the zone the async readers got.
   */
  export function getLoaded(tzname: Tzname): TimezoneRegion | null {
    return defaultCache.get(tzname) ?? provisional.get(tzname)?.region ?? null;
  }

  /**
   * Gets a timezone region or returns null if the timezone is invalid.
   * Unlike get(), this does not fall back to a default timezone.
   * A zone the service serves with no transitions (Pacific/Port_Moresby) is
   * not loaded. A loaded zone is checked against the platform's offset for
   * the same name now, half a year either side and at its last transition
   * (from 1970);
   * when they disagree (a service file that dropped the zone's last offset
   * change), the region is built from the platform's offsets instead and
   * carries the disagreement (`mismatch`).
   * A backward link name (US/Pacific) loads as the zone the platform
   * canonicalizes it to (America/Los_Angeles) and is cached under both names.
   * When the platform's canonical name does not load (V8 resolves
   * Asia/Kolkata to Asia/Calcutta, Europe/Kyiv to Europe/Kiev), the name
   * itself is loaded; when neither loads, the current IANA name of a legacy
   * spelling (`legacyNames`: V8 reports an India runtime as Asia/Calcutta,
   * which the zone service does not serve) loads, cached under the name too.
   * When nothing loads because the service has no data for the name (a 404,
   * or no transitions: `Unserved`) and the platform knows it, the zone is
   * built from the platform's offsets (`unserved`; America/Coyhaique,
   * Pacific/Port_Moresby). A zone the service gave no answer for (`NoAnswer`:
   * `fetch` rejected, the loader's deadline, a 5xx, 429 or 408) is built
   * from the platform's offsets too (`unserved: "no-answer"`) and held
   * provisionally: reads inside `UNLOADABLE_RETRY_MS` answer it at once with
   * no fetch, `getLoaded` answers it (so the synchronous readers read the
   * same zone), and it is queued once (`takeRebuilt`). A read after the
   * window still answers it at once and asks the service again in the
   * background; served data replaces it once the service answers. A name
   * that does not load (the service has no data for it and the platform
   * does not know it, a malformed file, a loader's own error, no answer for
   * a name the platform does not know) is remembered as not loading for
   * `UNLOADABLE_RETRY_MS` (at most `UNLOADABLE_MAX` names, the oldest
   * forgotten first), so asking again inside that window answers null at
   * once, with no fetch and no error line, and asking after it loads afresh.
   * `setLoader` forgets both, and a load still in flight under the loader it
   * replaced is neither joined by a later ask nor cached nor remembered.
   * Concurrent first loads of one name share one load: one
   * fetch, one build, one region (the platform build, about 1 ms from the
   * platform's transition list and 10-20 ms of Intl scanning where the
   * platform has none, runs at most once per zone per process, inside this async load
   * and never on a synchronous read path such as `getLoaded`).
   */
  export function getOpt(tzname: Tzname): Promise<TimezoneRegion | null> {
    const existing = defaultCache.get(tzname);
    if (existing != null) {
      announceFromPlatform(existing);
      return Promise.resolve(existing);
    }
    const held = provisional.get(tzname);
    if (held != null) {
      // Answered at once; after the window the service is asked again in the background.
      if (Epoch.currentMse() >= held.retryAt && !resolving.has(tzname)) void startLoad(tzname).catch(() => null);
      announceFromPlatform(held.region);
      return Promise.resolve(held.region);
    }
    const retryAt = unloadable.get(tzname);
    if (retryAt != null) {
      if (Epoch.currentMse() < retryAt) return Promise.resolve(null);
      unloadable.delete(tzname);
    }
    return (resolving.get(tzname) ?? startLoad(tzname)).then((region) => {
      if (region != null) announceFromPlatform(region);
      return region;
    });
  }

  /** Load `tzname` under the loader installed now, shared by every ask until it settles (`resolving`). */
  function startLoad(tzname: Tzname): Promise<TimezoneRegion | null> {
    const generation = loaderGeneration;
    const pending: Promise<TimezoneRegion | null> = resolve(tzname, generation).then((region) => {
      if (generation !== loaderGeneration) return region;
      const held = provisional.get(tzname);
      if (region?.unserved === "no-answer") {
        if (held == null) rebuiltUnreported.push(region);
        provisional.set(tzname, { region: held?.region ?? region, retryAt: Epoch.currentMse() + UNLOADABLE_RETRY_MS });
        return held?.region ?? region;
      }
      if (region != null) return region;
      // Nothing loaded: a held platform build stays the answer until the next window; otherwise the name is remembered.
      if (held != null) provisional.set(tzname, { region: held.region, retryAt: Epoch.currentMse() + UNLOADABLE_RETRY_MS });
      else rememberUnloadable(tzname);
      return held?.region ?? null;
    }).finally(() => {
      if (resolving.get(tzname) === pending) resolving.delete(tzname);
    });
    resolving.set(tzname, pending);
    return pending;
  }

  /** Each name's `getOpt` load still in flight under the installed loader, shared by every concurrent caller. */
  const resolving = new Map<Tzname, Promise<TimezoneRegion | null>>();

  /** A zone built from the platform because the service gave no answer, and when to ask the service again. */
  interface Provisional {
    readonly region: TimezoneRegion;
    readonly retryAt: number;
  }

  /** The zones held provisionally (`getOpt`): answered by `getOpt` and `getLoaded` until served data replaces them. */
  const provisional = new Map<Tzname, Provisional>();

  /**
   * How long a name that did not load answers `getOpt` with null, and a zone
   * held from the platform for want of an answer is answered without asking
   * the service, before it is loaded again.
   */
  export const UNLOADABLE_RETRY_MS = 30_000;
  /** How many names that did not load are remembered at most; the oldest is forgotten first. */
  export const UNLOADABLE_MAX = 64;
  /** Names that did not load, in the order they failed, each with when it may be loaded again. */
  const unloadable = new Map<Tzname, number>();

  function rememberUnloadable(tzname: Tzname): void {
    unloadable.delete(tzname);
    unloadable.set(tzname, Epoch.currentMse() + UNLOADABLE_RETRY_MS);
    if (unloadable.size <= UNLOADABLE_MAX) return;
    const oldest = unloadable.keys().next();
    if (!oldest.done) unloadable.delete(oldest.value);
  }

  /** Bumped by `setLoader`: a load that started under an earlier loader caches and remembers nothing (`getOpt`). */
  let loaderGeneration = 0;

  /** Cache `region` under `tzname` when the load that found it started under the loader installed now (`generation`). */
  function cacheServed(tzname: Tzname, region: TimezoneRegion, generation: number): void {
    if (generation !== loaderGeneration) return;
    defaultCache.set(tzname, region);
    provisional.delete(tzname);
  }

  async function resolve(tzname: Tzname, generation: number): Promise<TimezoneRegion | null> {
    const canonical = canonicalTzname(tzname);
    if (canonical !== tzname) {
      const region = defaultCache.get(canonical) ?? await loadOpt(canonical, generation);
      if (region != null) {
        cacheServed(tzname, region, generation);
        return region;
      }
    }

    try {
      return await load(tzname, generation);
    } catch (e) {
      const links = await legacyNames();
      const current = links.get(tzname) ?? links.get(canonical);
      const target = current == null ? null : defaultCache.get(current) ?? await loadOpt(current, generation);
      const region = target == null ? null : sharedPlatformBuild(target, tzname, canonical, e instanceof Unserved ? e.reason : null);
      if (region != null) {
        cacheServed(tzname, region, generation);
        return region;
      }
      const reason = e instanceof Unserved ? e.reason : e instanceof NoAnswer ? "no-answer" : null;
      // Built from the platform's offsets under the current IANA name of a legacy spelling (`current`), so a zone is
      // named the same whichever spelling asked first: V8 reports an India host as Asia/Calcutta, and an explicit
      // Asia/Kolkata resolves through that canonical name to the region cached for it. Only when the platform treats
      // both names as one zone: TIMEZONE_LINKS also maps cities merged into another zone (Europe/Amsterdam ->
      // Europe/Brussels), which the platform keeps as zones of their own, with their own history.
      // The build is cached under the asked name only, never under `current`: the service gave no answer for
      // `current`, so a later name linked to it must not take this build as that zone's own (CET builds
      // Europe/Brussels; Europe/Amsterdam, linked to Brussels but its own zone to the platform, would take it).
      const named = current != null && canonicalTzname(current) === canonical ? current : tzname;
      const built = reason == null ? null : fromPlatform(named, reason, generation, tzname);
      if (built != null) return built;
      console.error("couldn't find tz: ", tzname, e);
      return null;
    }
  }

  /**
   * The zone a link name answers with when its link target (`target`) loaded:
   * the target itself, unless the target was built from the platform for want
   * of served data (`unserved`) and the platform keeps `tzname` as a zone of
   * its own (a merged city: Europe/Amsterdam after Europe/Brussels; a backward
   * link: Antarctica/DumontDUrville after Pacific/Port_Moresby). Then it is
   * the target's rules under the asked name (operator Q23): the same
   * transitions, no second platform build and no second report
   * (`takeRebuilt`), named as asked whichever name asked first, and
   * marked with the reason the asked name's own load gave (`ownReason`,
   * review I I-2: Europe/Amsterdam not-found, not Europe/Brussels'
   * no-transitions; the target's when the asked name's load gave none). A
   * spelling of the same zone (Asia/Calcutta and Asia/Kolkata) still takes
   * the target as it is (Q9).
   */
  function sharedPlatformBuild(
    target: TimezoneRegion,
    tzname: Tzname,
    canonical: Tzname,
    ownReason: Option<UnservedReason>,
  ): TimezoneRegion {
    if (target.unserved == null || target.fullname === tzname) return target;
    if (canonicalTzname(target.fullname) === canonical) return target;
    return new TimezoneRegion(tzname, target.transitions, target.mismatch, target.linkOf, ownReason ?? target.unserved);
  }

  /**
   * `tzname` built from the platform's offsets for want of served data
   * (`unserved`); null when the platform does not know the name. A zone the
   * service has no data for is cached and queued for its one report
   * (`takeRebuilt`); one the service gave no answer for is held
   * provisionally by `getOpt` (the region it already holds, when it does).
   */
  function fromPlatform(
    tzname: Tzname,
    reason: FromPlatformReason,
    generation: number,
    cacheAs: Tzname = tzname,
  ): TimezoneRegion | null {
    const held = reason === "no-answer" ? provisional.get(cacheAs) : null;
    if (held != null) return held.region;
    const built = reason === "no-answer" ? null : platformBuilt.get(tzname);
    if (built != null) {
      cacheServed(cacheAs, built, generation);
      return built;
    }
    const transitions = PlatformZone.transitions(tzname);
    if (transitions == null) return null;
    const region = new TimezoneRegion(tzname, transitions.map((t) => Transition.parse(t, tzname)), null, null, reason);
    if (reason === "no-answer" || generation !== loaderGeneration) return region;
    rebuiltUnreported.push(region);
    platformBuilt.set(tzname, region);
    cacheServed(cacheAs, region, generation);
    return region;
  }

  /**
   * Each zone `fromPlatform` built for want of served data under the loader
   * installed now, by the name it was built under (not the asked name it is
   * cached under): a later name that builds the same zone takes this build,
   * so the zone is built and reported (`takeRebuilt`) once whichever of its
   * names asked first (CET, then Europe/Brussels). It never answers a
   * different zone's name: a merged city builds under its own name.
   */
  const platformBuilt = new Map<Tzname, TimezoneRegion>();

  /**
   * Every tzdata `backward` link name (a legacy spelling CLDR, and so V8's
   * Intl, still reports as canonical — Asia/Calcutta; a 2022+ merge —
   * Europe/Amsterdam -> Europe/Brussels; a rename — America/Buenos_Aires)
   * mapped to the zone the zone service serves for it, its link chain
   * resolved (Pacific/Truk -> Pacific/Port_Moresby). The client fallback of
   * `getOpt` for a zone service that serves current zone names only;
   * generated from tzdata 2024b (`chrono/timezone-links.ts`, by
   * `tests/timezones/generate-links.deno.ts`), and it can go once the
   * service serves every `backward` link name. Loaded on first use (a
   * name the service did not serve), so the 241-entry table stays off every
   * entry's cold import.
   */
  export async function legacyNames(): Promise<ReadonlyMap<Tzname, Tzname>> {
    return (await import("./timezone-links.ts")).TIMEZONE_LINKS;
  }

  /** Each name's service load still in flight (`load`), shared by every caller that reaches it. */
  const loading = new Map<Tzname, Promise<TimezoneRegion>>();

  function load(tzname: Tzname, generation: number): Promise<TimezoneRegion> {
    let pending = loading.get(tzname);
    if (pending == null) {
      const started: Promise<TimezoneRegion> = loadServed(tzname, generation).finally(() => {
        if (loading.get(tzname) === started) loading.delete(tzname);
      });
      loading.set(tzname, started);
      pending = started;
    }
    return pending;
  }

  async function loadServed(tzname: Tzname, generation: number): Promise<TimezoneRegion> {
    const transitions = await loader.load(tzname);
    if (transitions.length === 0) {
      // Every zone has an offset in force; an empty list is a zone the service has no data for.
      throw new Unserved(tzname, "no-transitions");
    }
    const served = new TimezoneRegion(tzname, transitions);
    const mismatch = offsetMismatch(served);
    const rebuilt = mismatch == null ? null : PlatformZone.transitions(tzname);
    const region = mismatch == null || rebuilt == null
      ? served
      : new TimezoneRegion(tzname, rebuilt.map((t) => Transition.parse(t, tzname)), mismatch, served.linkOf);
    if (generation !== loaderGeneration) return region;
    if (region.mismatch != null) rebuiltUnreported.push(region);
    cacheServed(tzname, region, generation);
    return region;
  }

  const rebuiltUnreported: TimezoneRegion[] = [];

  /**
   * The zones loaded rebuilt from the platform's offsets (`mismatch`), or
   * built from them for want of served data (`unserved`), since the last
   * call, each answered once: for a host to report every rebuild once,
   * whichever caller loaded the zone.
   */
  export function takeRebuilt(): TimezoneRegion[] {
    return rebuiltUnreported.splice(0);
  }

  /**
   * Where a served region and the platform's offsets disagree (in whole
   * minutes, as offsets are served): the first of now, half a year either
   * side, and the region's last transition when it falls in 1970-2049.
   */
  export interface OffsetMismatch {
    readonly at: MsSinceEpoch;
    readonly servedMins: number;
    readonly platformMins: number;
  }

  const HALF_YEAR_MS = 182 * 86_400_000;

  /**
   * The last transition is checked from 1970 on only: before 1968,
   * `DateTime.fromRfc3339` puts a served transition a day early, so a check
   * there would rebuild most zones for a parse defect no 2026 viewer sees
   * (found 2026-10-07, not fixed here).
   */
  const LAST_TRANSITION_CHECKED_FROM_MS = Date.UTC(1970, 0, 1);

  function offsetMismatch(region: TimezoneRegion): Option<OffsetMismatch> {
    const platform = PlatformZone.offsets(region.fullname);
    if (platform == null) return null;
    const now = Epoch.currentMse();
    const last = region.transitions[region.transitions.length - 1].before.mse;
    const instants = [now, now - HALF_YEAR_MS, now + HALF_YEAR_MS];
    if (last >= LAST_TRANSITION_CHECKED_FROM_MS) instants.push(last);
    for (const at of instants) {
      if (at < PlatformZone.WINDOW_START_MS || at >= PlatformZone.WINDOW_END_MS) continue;
      const servedMins = Math.round(region.tzAtMse(at as MsSinceEpoch).info.offset.toHrsF * 60);
      const platformMins = Math.round(platform(at) / 60);
      if (servedMins !== platformMins) return { at: at as MsSinceEpoch, servedMins, platformMins };
    }
    return null;
  }

  async function loadOpt(tzname: Tzname, generation: number): Promise<TimezoneRegion | null> {
    try {
      return await load(tzname, generation);
    } catch {
      return null;
    }
  }

  /** `tzname` as the platform's Intl resolves it (a link to its canonical zone); `tzname` itself when Intl refuses it. */
  function canonicalTzname(tzname: Tzname): Tzname {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tzname }).resolvedOptions().timeZone as Tzname;
    } catch {
      return tzname;
    }
  }

  /**
   * Install `l` as the zone loader for this process; `l.restart` runs first,
   * so it decides afresh (`servedLoader`'s data version), and the names that
   * did not load and the zones held for want of an answer are forgotten (the
   * new loader may serve them). A load still in flight under the old loader
   * is not joined by a later ask, and its answer is neither cached nor
   * remembered: only the caller that started it gets it.
   */
  export function setLoader(l: Loader) {
    l.restart?.();
    unloadable.clear();
    provisional.clear();
    platformBuilt.clear();
    resolving.clear();
    loading.clear();
    loaderGeneration++;
    loader = l;
  }

  /**
   * The zone loader installed now (`setLoader`; `PLATFORM_LOADER` until one
   * is): a caller that installs its own for a while reads this first and
   * puts back the loader it found, not `PLATFORM_LOADER`. Putting it back
   * with `setLoader` restarts it.
   */
  export function getLoader(): Loader {
    return loader;
  }

  /**
   * Transitions
   */
  export interface Transition {
    before: {
      mse: MsSinceEpoch;
      time: DateTime<FixedOffset>;
      tzabbr: string;
    };
    after: {
      time: DateTime<FixedOffset>;
      tzabbr: string;
    };
    /** The file's `linkOf` (requests/tz-to-sdk-1): the canonical zone a backward name's file was copied from. */
    linkOf?: Tzname;
  }

  export namespace Transition {
    export type Serialized = {
      before: string;
      before_tz_abbr: string;
      after: string;
      after_tz_abbr: string;
      /** The standing UTC offset at the range start, seconds east of UTC (the first entry; tz-to-sdk-1). */
      baseOffsetSeconds?: number;
      /** A backward name's resolved canonical zone (tz-to-sdk-1). */
      linkOf?: string;
    };

    export function parse(
      t: Transition.Serialized,
      tzname: Tzname,
    ): Transition {
      const before = DateTime.fromRfc3339(
        t.before,
        tzname,
        t.before_tz_abbr,
      ).exp();
      const after = DateTime.fromRfc3339(
        t.after,
        tzname,
        t.after_tz_abbr,
      ).exp();
      if (t.baseOffsetSeconds !== undefined && Math.round(after.tz.info.offset.toHrsF * 3600) !== t.baseOffsetSeconds) {
        throw new Error(`zone ${tzname}: baseOffsetSeconds ${t.baseOffsetSeconds} contradicts the entry's offset (${t.after})`);
      }
      return {
        ...(t.linkOf !== undefined ? { linkOf: t.linkOf as Tzname } : {}),
        before: {
          mse: before.mse,
          time: before,
          tzabbr: t.before_tz_abbr,
        },
        after: {
          time: after,
          tzabbr: t.after_tz_abbr,
        },
      };
    }

    export function print(transition: Transition, idx?: Option<number>) {
      console.log(idx, debug(transition));
    }

    export function debug(transition: Transition): string {
      return `${
        transition.before.mse
      } ${transition.before.time.rfc3339()} ${transition.after.time.rfc3339()}`;
    }
  }
}
