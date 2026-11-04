import {
  DateTime,
  GenericRange,
  NaiveDate,
  NaiveDateTime,
  PartialDate,
  TimeOfDay,
  TimezoneRegion,
  Utc,
} from "@tento-chrono";
import { Tracing } from "@tento-core/tracing";
import { NumRangeLike } from "@tento-core/range";
import { Rational } from "@tento-core/rational";

type ResolutionStrategy = "offset" | "pd" | "pd-tz";

export namespace ColumnIndex {
  /**
   * The slice of a scroll engine that column-range geometry reads:
   * per-index cell width and the window's cumulative offsets.
   * `ScrollEngine` satisfies it structurally, so this module does not
   * depend on `@tento-scroll`.
   */
  export interface OffsetSource {
    readonly cellWidth: { get(index: number): number };
    readonly window: { getOffset(index: number): Option<number> };
  }

  const indexCache: ColumnIndex.Key[] = [];

  /**
   * Stable string fingerprint for `(key, resolution)` — used as a cache
   * key by mappers that memoize `resolveKeyToDefault`.
   */
  export function resolveCacheKey(
    key: ColumnIndex.Key,
    resolution: "lower" | "upper",
  ): string {
    switch (key.strategy) {
      case "offset":
        return `o:${key.inner.index}:${resolution}`;
      case "pd":
        return `p:${key.inner.pd!.start.dse}:${key.inner.pd!.type}:${resolution}`;
      case "pd-tz":
        return `t:${key.inner.pd!.start.dse}:${key.inner.pd!.type}:${key.inner.tz!.fullname}:${resolution}`;
    }
  }

  export class Key {
    private constructor(
      readonly strategy: ResolutionStrategy,
      readonly inner: Optional<{
        readonly pd: PartialDate;
        readonly tz: TimezoneRegion;
        readonly index: number;
        readonly resolution: "lower" | "upper";
      }>,
    ) {}

    static fromIndex(index: number): Key {
      const k = indexCache[index];
      if (k != null) return k;
      return (indexCache[index] = new Key("offset", { index }));
    }

    static fromDate(date: NaiveDate, resolution: "lower" | "upper"): Key {
      return new Key("pd", {
        pd: PartialDate.fromDate(date),
        resolution,
      });
    }

    static fromDateTz(date: NaiveDate, tz: TimezoneRegion): Key {
      return new Key("pd-tz", {
        pd: PartialDate.fromDate(date),
        tz,
      });
    }

    static fromPartial(
      pd: NaiveDate.Partial,
      resolution: "lower" | "upper",
    ): Key {
      return new Key("pd", {
        pd,
        resolution,
      });
    }

    static fromPartialTz(pd: NaiveDate.Partial, tz: TimezoneRegion): Key {
      return new Key("pd-tz", {
        pd,
        tz,
      });
    }
  }

  export namespace Key {
    export class Range extends GenericRange<Key> {
      resolveToDefault(mapper: Mapper): Resolved.Default.Range {
        return new Resolved.Default.Range(
          mapper.resolveKeyToDefault(this.start, "lower"),
          mapper.resolveKeyToDefault(this.end, "upper"),
        );
      }

      width(
        scrollEngine: OffsetSource,
        mapper: ColumnIndex.Mapper<any>,
      ): number {
        const { index: startIdx } = mapper.indexOfKey(this.start);
        const { index: endIdx } = mapper.indexOfKey(this.end);
        if (startIdx === endIdx) {
          return scrollEngine.cellWidth.get(startIdx);
        }

        const startOffset = scrollEngine.window.getOffset(startIdx);
        const endOffset = scrollEngine.window.getOffset(endIdx);
        if (startOffset == null || endOffset == null) {
          Tracing.warn("ui")(
            "no offsets ready for index when calculating key range",
          );
          return 0;
        }
        return endOffset - startOffset;
      }
    }

    export type Resolved<
      Info extends {
        startDate: Option<NaiveDate>;
      } = any,
    > = Resolved.Default | Resolved.Custom<Info>;
    export namespace Resolved {
      export class WithSubindex {
        constructor(
          readonly key: Resolved,
          readonly subindex: Rational = new Rational(0, 1),
        ) {}

        subindexOffsetPx(scrollEngine: OffsetSource): number {
          const width = scrollEngine.cellWidth.get(this.key.offset);
          return width * this.subindex.fraction();
        }

        startOffsetPx(scrollEngine: OffsetSource): Option<number> {
          const base = scrollEngine.window.getOffset(this.key.offset);
          if (base == null) return null;
          const subindexOffset = this.subindexOffsetPx(scrollEngine);
          // Tracing.dev("  fixed-child-node/base", base);
          // Tracing.dev("  fixed-child-node/subind", subindexOffset);
          return base + subindexOffset;
        }

        toString(): string {
          return `${this.key.toString()} (${this.subindex.toString()})`;
        }
      }

      export namespace WithSubindex {
        export class Range extends GenericRange<WithSubindex> {
          subindexOffsetPx(se: OffsetSource): Option<number> {
            return this.start.subindexOffsetPx(se);
          }

          width(scrollEngine: OffsetSource): Option<number> {
            const end = this.end.startOffsetPx(scrollEngine);
            const start = this.start.startOffsetPx(scrollEngine);
            // Tracing.dev("  fixed-child-node/start", start);
            // Tracing.dev("  fixed-child-node/end", end);
            if (end == null || start == null) return null;
            return end - start;
          }
        }

        export class RangeOpen {
          constructor(
            readonly start: WithSubindex,
            readonly end: Option<WithSubindex>,
          ) {}

          subindexOffsetPx(se: OffsetSource): Option<number> {
            return this.start.subindexOffsetPx(se);
          }

          width(scrollEngine: OffsetSource): Option<number> {
            if (this.end) {
              return new WithSubindex.Range(this.start, this.end).width(
                scrollEngine,
              );
            }
            return scrollEngine.cellWidth.get(this.start.key.offset);
          }
        }
      }

      export class Default {
        type = "default" as const;

        private _range: Option<DateTime.Range<Utc>> = null;
        get range(): DateTime.Range<Utc> {
          if (this._range == null) {
            const start =
              this.partialLocalTop ?? this.pd.start.withTime(TimeOfDay.ZERO);
            const end =
              this.partialLocalBottom ?? this.pd.end.withTime(TimeOfDay.ZERO);
            this._range = new DateTime.Range(
              this.tz.toWallClock(start),
              this.tz.toWallClock(end),
            ).toUtc();
          }
          return this._range;
        }

        constructor(
          readonly pd: PartialDate,
          readonly tz: TimezoneRegion,
          readonly offset: number,
          readonly partialLocalTop: Option<NaiveDateTime>,
          readonly partialLocalBottom: Option<NaiveDateTime>,
        ) {}

        id(): string {
          return this.pd.toString();
        }

        castToDefault(): Default {
          return this;
        }

        castToCustom(): Option<Custom<any>> {
          return null;
        }

        discrete(): NaiveDate.Partial.WithTz {
          return [this.pd, this.tz];
        }

        private serialized: Option<string> = null;

        toString(): string {
          // The partial date and timezone identity are immutable for this key.
          return this.serialized ??= `${this.pd.toString()}_${this.tz.fullname}`;
        }

        withSubindex(subindex: Rational): WithSubindex {
          return new WithSubindex(this, subindex);
        }
      }

      export namespace Default {
        export class Range extends GenericRange<Default> {
          static fromIndexSinceAnchorRange(
            r: NumRangeLike,
            mapper: Mapper,
          ): Range {
            return new ColumnIndex.Key.Resolved.Default.Range(
              mapper.resolveKeyToDefault(
                ColumnIndex.Key.fromIndex(r.start),
                "lower",
              ),
              mapper.resolveKeyToDefault(
                ColumnIndex.Key.fromIndex(r.end),
                "upper",
              ),
            );
          }

          toDatesInclusive(): NaiveDate.Range {
            return new NaiveDate.Range(this.start.pd.start, this.end.pd.end);
          }

          discrete(): NaiveDate.Partial.WithTz.Range {
            return new NaiveDate.Partial.WithTz.Range(
              this.start.discrete(),
              this.end.discrete(),
            );
          }

          toString(): string {
            return `${this.start.toString()}..${this.end.toString()}`;
          }
        }
      }

      export class Custom<
        Info extends {
          startDate: Option<NaiveDate>;
        },
      > {
        type = "custom" as const;

        constructor(
          readonly inner: Info,
          readonly offset: number,
        ) {}

        castToDefault(): Option<Default> {
          return null;
        }

        castToCustom(): Option<Custom<Info>> {
          return this;
        }

        start(): Option<NaiveDate> {
          return this.inner.startDate;
        }
      }
    }
  }

  export interface Mapper<
    Info extends {
      startDate: Option<NaiveDate>;
    } = any,
  > {
    get startDate(): Option<NaiveDate>;

    resolveKey(key: Key): Key.Resolved<Info>;
    resolveKeyToDefault(
      key: Key,
      resolution: "lower" | "upper",
    ): Key.Resolved.Default;

    indexOfKey(key: Key): {
      index: number;
      subindex: Rational;
    };
  }

  export namespace Mapper {
    export class Default<
      Info extends {
        startDate: Option<NaiveDate>;
      } = any,
    > implements Mapper<Info>
    {
      anchor: PartialDate.WithTz;
      private _resolveDefaultCache = new Map<string, Key.Resolved.Default>();

      get startDate(): Option<NaiveDate> {
        return this.anchor[0].start;
      }

      constructor(
        readonly anchorUnresolved: PartialDate,
        readonly localTz: TimezoneRegion,
      ) {
        this.anchor = [anchorUnresolved, localTz];
      }

      resolveKey(key: Key): Key.Resolved {
        return this.resolveKeyToDefault(key, "lower");
      }

      resolveKeyToDefault(
        key: Key,
        resolution: "lower" | "upper",
      ): Key.Resolved.Default {
        const cacheKey = resolveCacheKey(key, resolution);
        const cached = this._resolveDefaultCache.get(cacheKey);
        if (cached) return cached;
        const result = this._resolveKeyToDefaultInner(key, resolution);
        this._resolveDefaultCache.set(cacheKey, result);
        return result;
      }

      private _resolveKeyToDefaultInner(
        key: Key,
        _resolution: "lower" | "upper",
      ): Key.Resolved.Default {
        switch (key.strategy) {
          case "offset": {
            return new Key.Resolved.Default(
              this.anchorUnresolved.add(key.inner.index!),
              this.localTz,
              key.inner.index!,
              null,
              null,
            );
          }
          case "pd": {
            const pd = key.inner.pd!;
            const { index } = this.anchorUnresolved.offsetFrom(pd.start);
            return new Key.Resolved.Default(
              key.inner.pd!,
              this.localTz,
              index,
              null,
              null,
            );
          }
          case "pd-tz": {
            const pd = key.inner.pd!;
            const { index } = this.anchorUnresolved.offsetFrom(pd.start);
            return new Key.Resolved.Default(
              key.inner.pd!,
              key.inner.tz!,
              index,
              null,
              null,
            );
          }
        }
      }

      indexOfKey(key: Key): { index: number; subindex: Rational } {
        // `resolveKeyToDefault` can fall through to `undefined` for a malformed
        // key (e.g. a bare date string dispatched where a `Key` object is
        // expected), so guard before `castToDefault` — otherwise the
        // "invalid key" fallback below is unreachable and we crash instead.
        const resolved = this.resolveKeyToDefault(key, "lower")?.castToDefault();
        if (!resolved) {
          Tracing.err("ui")("invalid key");
          return { index: 0, subindex: new Rational(0, 1) };
        }

        const { index, days, maxDays } = this.anchorUnresolved.offsetFrom(
          resolved.pd.start,
        );
        return {
          index,
          subindex: new Rational(days, maxDays),
        };
      }
    }
  }
}
