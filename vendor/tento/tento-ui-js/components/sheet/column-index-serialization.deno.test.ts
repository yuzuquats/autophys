import "../../deno-noop.ts";

import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { PartialDate, TimeOfDay, TimezoneRegion } from "@tento-chrono";
import { ColumnIndex } from "./column-index.ts";

Deno.test("column-index serialization: date units retain their exact wire identity", () => {
  const cases: [PartialDate, string][] = [
    [new PartialDate("day", 2024, 2, 29), "ymd-2024-2-29_UTC"],
    [new PartialDate("day", 2026, 12, 31), "ymd-2026-12-31_UTC"],
    [new PartialDate("week", 2020, null, null, 53), "yw-2020-53_UTC"],
    [new PartialDate("week", 2021, null, null, 1), "yw-2021-1_UTC"],
    [new PartialDate("month", 2026, 9), "ym-2026-9_UTC"],
    [new PartialDate("year", 2026), "y-2026_UTC"],
  ];
  for (const [pd, expected] of cases) {
    const column = new ColumnIndex.Key.Resolved.Default(pd, TimezoneRegion.UTC, -7, null, null);
    assertEquals(column.toString(), expected);
    assertEquals(column.toString(), expected);
    assertEquals(column.id(), pd.toString(), "date-only id remains distinct from the timezone-qualified key");
  }
});

Deno.test("column-index serialization: timezone names remain distinct without loading timezone data", () => {
  const pd = new PartialDate("day", 2026, 9, 9);
  // Serialization requires only the actual region's name, not transition data.
  const east = new TimezoneRegion("America/New_York" as typeof TimezoneRegion.UTC.fullname, []);
  const west = new TimezoneRegion("America/Los_Angeles" as typeof TimezoneRegion.UTC.fullname, []);
  const a = new ColumnIndex.Key.Resolved.Default(pd, east, 0, null, null);
  const b = new ColumnIndex.Key.Resolved.Default(pd, west, 0, null, null);
  assertEquals(a.toString(), "ymd-2026-9-9_America/New_York");
  assertEquals(b.toString(), "ymd-2026-9-9_America/Los_Angeles");
  assertNotEquals(a.toString(), b.toString());
});

Deno.test("column-index serialization: offsets and partial boundaries do not change identity or range", () => {
  const pd = new PartialDate("day", 2026, 9, 9);
  const top = pd.start.withTime(TimeOfDay.fromHms({ hrs: 6 }));
  const bottom = pd.start.withTime(TimeOfDay.fromHms({ hrs: 18 }));
  const whole = new ColumnIndex.Key.Resolved.Default(pd, TimezoneRegion.UTC, 0, null, null);
  const partial = new ColumnIndex.Key.Resolved.Default(pd, TimezoneRegion.UTC, 99, top, bottom);
  const partialRange = partial.range;
  assertEquals(partial.toString(), whole.toString());
  assertEquals(partial.toString(), "ymd-2026-9-9_UTC");
  assertEquals(partial.range, partialRange);
  assertNotEquals(partial.range.start.mse, whole.range.start.mse);
  assertNotEquals(partial.range.end.mse, whole.range.end.mse);
  assertEquals(partial.discrete(), [pd, TimezoneRegion.UTC]);
});

Deno.test("column-index serialization: each actual resolved key serializes lazily once", () => {
  const pd = new PartialDate("day", 2026, 9, 9);
  let serializations = 0;
  pd.toString = () => { serializations++; return PartialDate.prototype.toString.call(pd); };
  const a = new ColumnIndex.Key.Resolved.Default(pd, TimezoneRegion.UTC, 0, null, null);
  const b = new ColumnIndex.Key.Resolved.Default(pd, TimezoneRegion.UTC, 1, null, null);
  assertEquals(serializations, 0, "unused keys incur no serialization");
  for (let i = 0; i < 100; i++) assertEquals(a.toString(), "ymd-2026-9-9_UTC");
  assertEquals(serializations, 1);
  assertEquals(b.toString(), a.toString());
  assertEquals(serializations, 2, "the cache belongs to each immutable resolved key");
});
