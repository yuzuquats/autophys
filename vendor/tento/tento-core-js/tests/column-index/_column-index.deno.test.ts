import { assertEquals } from "jsr:@std/assert";
import { NaiveDate, PartialDate, TimezoneRegion, Weekday } from "@tento-chrono";
import { ColumnIndex } from "@tento-core/column-index.ts";
import { Fixtures } from "../fixture-runner.deno.ts";

type Input = {
  anchorDate: string;
  weekStart: "mon" | "sun";
  dates: string[];
};

function parseDate(iso: string): NaiveDate {
  const [yr, mth, day] = iso.split("-").map(Number);
  return NaiveDate.fromYmd1Exp(yr, mth, day);
}

function makeAnchor(anchorDate: string, weekStart: Weekday): PartialDate {
  const date = parseDate(anchorDate);
  return PartialDate.fromDateAndType("week", date, weekStart);
}

Fixtures.load<Input, number[]>(
  new URL(".", import.meta.url).pathname,
  "column-index",
).run(
  (input) => {
    const weekStart = input.weekStart === "sun" ? Weekday.SUN : Weekday.MON;
    const anchor = makeAnchor(input.anchorDate, weekStart);
    const mapper = new ColumnIndex.Mapper.Default(anchor, TimezoneRegion.UTC);
    return input.dates.map((d) => {
      const date = parseDate(d);
      const key = ColumnIndex.Key.fromDate(date, "lower");
      return mapper.resolveKeyToDefault(key, "lower").offset;
    });
  },
  (result, expected) => {
    assertEquals(result, expected);
  },
);
