import { NaiveDateTime, Result, TimezoneRegion, Tzname, erm } from "../mod.ts";
import { ICalAttributes } from "./ical-attributes.ts";
import { IsoDate } from "./iso-date.ts";
import type { Option, Optional } from "../option.ts";

export class ICalDateLine implements ICalDateLine.Like {
  constructor(
    readonly label: string,
    readonly dates: NaiveDateTime[],
    readonly region?: Option<TimezoneRegion>,
    readonly value?: Option<"DATE" | "DATE-TIME">,
    readonly determinism?: Option<ICalDateLine.TestDeterminism>,
    /**
     * Each value's form as written: `timed` (it carried a time; a date-only
     * value is a whole local day) and `utc` (it ended in `Z`). Absent: as
     * `dates` were built by hand (every value timed, none UTC).
     */
    readonly forms?: Option<readonly ICalDateLine.Form[]>,
  ) {}

  // Examples:
  //
  // EXDATE;TZID=America/Los_Angeles:20240411T150000,20240418T150000,20241024T150000,20241219T150000,20250213T150000,20250501T150000
  // EXDATE:19980401T133000Z,19980402T133000Z
  // EXDATE;VALUE=DATE:20231225,20231226,20231227
  // EXDATE:20231225T090000,20231226T090000
  // EXDATE;VALUE=DATE-TIME:20231225T090000,20231226T090000
  // EXDATE;VALUE=DATE-TIME;TZID=Europe/Brussels:20231225T090000,20231226T090000
  //
  static async parse(
    s: string,
    deterministic: boolean = false,
  ): Promise<Result<ICalDateLine>> {
    return await ICalDateLine.Raw.parse(s).asyncMap((r) =>
      r.resolve(deterministic),
    );
  }

  toString(): string {
    const attributes = [this.label];

    const attributeOrder = this.determinism?.attributeOrder;
    if (attributeOrder) {
      for (const order of attributeOrder) {
        if (order === "TZID" && this.region)
          attributes.push(`TZID=${this.region.fullname}`);
        if (order === "VALUE" && this.value)
          attributes.push(`VALUE=${this.value}`);
      }
    } else {
      if (this.region) attributes.push(`TZID=${this.region.fullname}`);
      if (this.value) attributes.push(`VALUE=${this.value}`);
    }

    const dates = this.dates.map((d, index) => {
      const form = this.forms?.[index];
      if (this.value === "DATE" || form?.timed === false) return d.date.ical();
      const utc = form?.utc ?? this.determinism?.includeZ ?? false;
      return d.ical() + (utc ? "Z" : "");
    });

    return `${attributes.join(";")}:${dates.join(",")}`;
  }
}

export namespace ICalDateLine {
  export class Raw {
    constructor(
      readonly tag: string,
      readonly attributes: ICalAttributes,
      readonly nd: IsoDate[],
    ) {}

    static parse(s: string, requiresTag: boolean = true): Result<Raw> {
      const lines = s.split(/\r?\n/);
      const line = lines.join("");

      const m = line.match(/^([^:]+):(.*)$/);
      if (!m) return erm("invalid");

      const [_, rawParams, rawTimestamps] = m;

      const attributes = ICalAttributes.fromRawAttributes(rawParams.split(";"));
      const timestamps = rawTimestamps
        .split(",")
        // A PERIOD value (RDATE;VALUE=PERIOD:start/end or start/duration)
        // is read as its start: the instance it adds.
        .map((value) => IsoDate.parse(value.split("/")[0] ?? value))
        .map((ts) => ts.exp());

      const tagCandidate = attributes.order[0];
      if (requiresTag) {
        if (tagCandidate !== "EXDATE" && tagCandidate !== "DTSTART" && tagCandidate !== "RDATE") {
          return erm(`tag required but got '${tagCandidate}'`);
        }
      }

      return Result.ok(new Raw(tagCandidate, attributes, timestamps));
    }

    async resolve(deterministic: boolean = false): Promise<ICalDateLine> {
      let region: Option<TimezoneRegion>;
      const tzname = this.attributes.get("tzid");
      if (tzname != null && typeof tzname === "string") {
        region = await TimezoneRegion.get(tzname as Tzname, Tzname.UTC, "ical-tzid");
      }

      let exdateValue: Option<"DATE" | "DATE-TIME">;
      const value = this.attributes.get("value");
      if (value != null && typeof value === "string") {
        const v = value.toUpperCase();
        if (v === "DATE-TIME" || v === "DATE") {
          exdateValue = v;
        }
      }

      return new ICalDateLine(
        this.tag,
        this.nd.map((d) => d.extend()),
        region,
        exdateValue,
        deterministic
          ? {
              attributeOrder: this.attributes.order,
              includeZ: this.nd[0]?.z != null,
            }
          : null,
        this.nd.map((d) => ({ timed: d.nt != null, utc: d.z != null })),
      );
    }
  }
}

export namespace ICalDateLine {
  export type Options = Optional<{
    tzid: Tzname;
    value: "DATE" | "DATE-TIME";
  }>;

  /** How one value of the line was written (see `ICalDateLine.forms`). */
  export type Form = { readonly timed: boolean; readonly utc: boolean };

  export type TestDeterminism = Optional<{
    attributeOrder: string[];
    includeZ: boolean;
  }>;

  export type Like = {
    dates: NaiveDateTime[];
  } & Options;
}
