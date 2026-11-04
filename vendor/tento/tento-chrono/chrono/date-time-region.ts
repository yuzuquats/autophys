import { DateTime } from "./datetime.ts";
import { NaiveDateTime } from "./naive-datetime.ts";
import { GenericRange } from "./range.ts";
import { Utc } from "./timezone.ts";
import { TimezoneRegion } from "./timezone-region.ts";
import { Duration } from "./units/duration.ts";
import type { Optional } from "./option.ts";

/**
 * Represents a datetime in a specific timezone region.
 *
 * Similar to DateRegion, but works with a specific time point rather than
 * an entire day. Used for more precise timezone operations when an exact
 * time is needed.
 */
export class DateTimeRegion {
  /** The naive datetime this region represents */
  readonly ndt: NaiveDateTime;

  /** The timezone region for contextualizing the datetime */
  readonly tz: TimezoneRegion;

  readonly cache: Optional<{
    resolved: DateTime;
    wallclock: DateTime;
  }> = {};

  /**
   * Creates a new DateTimeRegion instance.
   * @param {NaiveDateTime} ndt - The naive datetime (without timezone information)
   * @param {TimezoneRegion} tz - The timezone region to contextualize the datetime
   */
  constructor(ndt: NaiveDateTime, tz: TimezoneRegion) {
    this.ndt = ndt;
    this.tz = tz;
  }

  /**
   * @deprecated Use `asWallClock()` instead. This method has confusing semantics -
   * it treats the NaiveDateTime as if it were UTC, which is almost never the correct
   * interpretation. The only valid use case was when the NaiveDateTime was explicitly
   * created from a UTC source (e.g., `dt.toUtc().ndt`), but in that case you should
   * use `tz.toTz(dt)` directly instead.
   */
  asUtcTp(): DateTime {
    if (this.cache.resolved) return this.cache.resolved;
    return (this.cache.resolved = this.tz.toTz(new DateTime(this.ndt, Utc)));
  }

  asWallClock(): DateTime {
    if (this.cache.wallclock) return this.cache.wallclock;
    return (this.cache.wallclock = this.tz.toWallClock(this.ndt));
  }

  toString(): string {
    return `${this.ndt.toString()} [${this.tz.fullname}]`;
  }
}

export namespace DateTimeRegion {
  export class Range extends GenericRange<DateTimeRegion> {
    static fromSingleTz(dtr: DateTime.Range<Utc>, tz: TimezoneRegion): DateTimeRegion.Range {
      return new DateTimeRegion.Range(
        new DateTimeRegion(tz.toTz(dtr.start).ndt, tz),
        new DateTimeRegion(tz.toTz(dtr.end).ndt, tz),
      );
    }

    duration(): Duration.Time {
      return this.end.asWallClock().durationSince(this.start.asWallClock());
    }

    asWallClock(): DateTime.Range {
      return new DateTime.Range(
        this.start.asWallClock(),
        this.end.asWallClock(),
      );
    }
  }
}
