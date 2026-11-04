import { DateTime } from "./datetime.ts";
import { NaiveDate } from "./naive-date.ts";
import { Utc } from "./timezone.ts";
import { TentoMath } from "./utils.ts";
import type { Option } from "./option.ts";

declare const semanticTimeBrand: unique symbol;

export type SemanticTime = string & {
  readonly [semanticTimeBrand]: "SemanticTime";
};

export namespace SemanticTime {
  export function parse(raw: string): SemanticTime {
    const normalized = normalize(raw);
    const partial = NaiveDate.Partial.parseOptional(normalized);
    if (partial != null) return fromPartialDate(partial);

    const pointResult = DateTime.fromRfc3339(normalized);
    if (pointResult.isOk) {
      const point = pointResult.asOk();
      if (point != null) return fromDateTime(point.toUtc());
    }

    throw new Error(`SemanticTime.parse: invalid semantic time "${raw}"`);
  }

  export function normalize(raw: string): string {
    if (raw.startsWith("pt-")) return raw.slice(3);
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) return `ymd-${raw}`;
    return raw;
  }

  export function fromPartialDate(partial: NaiveDate.Partial): SemanticTime {
    const raw = partial.toString();
    // The fields `NaiveDate.Partial.parse` would read back from `raw`, checked
    // directly (each a number, at least 1 as an integer) instead of parsing
    // the text just built: the same values pass and fail.
    if (partialFieldsParse(partial)) return raw as SemanticTime;
    throw new Error(`SemanticTime.fromPartialDate: invalid partial date "${raw}"`);
  }

  /** Whether every field `partial.toString()` prints reads back as an integer ≥ 1 (`NaiveDate.Partial.parse`'s rule). */
  function partialFieldsParse(partial: NaiveDate.Partial): boolean {
    const atLeastOne = (v: Option<number>): boolean => {
      const n = TentoMath.int(String(v));
      return !Number.isNaN(n) && n >= 1;
    };
    switch (partial.type) {
      case "year":
        return atLeastOne(partial.yr);
      case "month":
        return atLeastOne(partial.yr) && atLeastOne(partial.mth);
      case "day":
        return atLeastOne(partial.yr) && atLeastOne(partial.mth) && atLeastOne(partial.day);
      case "week":
        return atLeastOne(partial.yr) && atLeastOne(partial.wno);
    }
  }

  export function fromDateTime(point: DateTime<Utc>): SemanticTime {
    return point.toString() as SemanticTime;
  }

  export function partialDate(time: SemanticTime): Option<NaiveDate.Partial> {
    const parsed = NaiveDate.Partial.parse(normalize(time));
    if (!parsed.isOk) return null;
    return parsed.asOk() ?? null;
  }

  export function dateTime(time: SemanticTime): Option<DateTime<Utc>> {
    const parsed = DateTime.fromRfc3339(normalize(time));
    if (!parsed.isOk) return null;
    const point = parsed.asOk();
    return point == null ? null : point.toUtc();
  }

  export function dateKey(time: SemanticTime): Option<NaiveDate.Partial> {
    const partial = partialDate(time);
    if (partial != null) return partial;
    const point = dateTime(time);
    return point == null ? null : NaiveDate.Partial.fromDate(point.date);
  }
}
