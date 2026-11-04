import { assertEquals, assertThrows } from "@std/assert";
import { DateTime, NaiveDate, Recurrence, RecurrenceExpansionLimitError, TimezoneRegion } from "../mod.ts";

const start = DateTime.fromRfc3339("2026-01-01T00:00:00Z").exp();
const end = NaiveDate.parse("2026-12-31");
Deno.test("required recurrence budget refuses before an unbounded buffer grows", async () => {
  const recurrence = (await Recurrence.parse(["RRULE:FREQ=SECONDLY"])).exp();
  const bounded = await recurrence.generateGoogleEvents(start, TimezoneRegion.UTC, 32);
  assertThrows(() => bounded.generateUpToDate(end), RecurrenceExpansionLimitError);
});
Deno.test("interactive recurrence keeps its existing unlimited default", async () => {
  const recurrence = (await Recurrence.parse(["RRULE:FREQ=DAILY;COUNT=40"])).exp();
  const generator = await recurrence.generateGoogleEvents(start, TimezoneRegion.UTC);
  assertEquals(generator.generateUpToDate(end).length, 40);
});
Deno.test("bounded recurrence counts excluded candidates and explicit additions", async () => {
  for (const lines of [
    ["RRULE:FREQ=DAILY;COUNT=40", "EXDATE:20260101T000000Z,20260102T000000Z,20260103T000000Z"],
    ["RRULE:FREQ=DAILY;COUNT=1", "RDATE:20260102T000000Z,20260103T000000Z,20260104T000000Z,20260105T000000Z"],
  ]) {
    const recurrence = (await Recurrence.parse(lines)).exp();
    const generator = await recurrence.generateGoogleEvents(start, TimezoneRegion.UTC, 3);
    assertThrows(() => generator.generateUpToDate(end), RecurrenceExpansionLimitError);
    assertThrows(() => generator.generateUpToDate(end), RecurrenceExpansionLimitError);
  }
});
Deno.test("dense yearly candidates are selected lazily before COUNT or BYSETPOS", async () => {
  const list = (n: number) => Array.from({length: n}, (_,i) => i).join(",");
  const dense = "RRULE:FREQ=YEARLY;BYHOUR=" + list(24) + ";BYMINUTE=" + list(60) + ";BYSECOND=" + list(60);
  for (const suffix of [";COUNT=2", ";BYSETPOS=1,-1;COUNT=2"]) {
    const recurrence = (await Recurrence.parse([dense + suffix])).exp();
    const generator = await recurrence.generateGoogleEvents(start, TimezoneRegion.UTC, 10);
    assertEquals(generator.generateUpToDate(end).length, 2);
  }
});

Deno.test("bounded date generator reaches old horizons and refuses its own exhaustion", async () => {
  const rule = (await Recurrence.parse(["RRULE:FREQ=DAILY"])).exp();
  const old = DateTime.fromRfc3339("2020-01-01T00:00:00Z").exp();
  const gen = await rule.generateGoogleEvents(old, TimezoneRegion.UTC, 65_535);
  const days = gen.generateUpToDate(NaiveDate.parse("2026-01-04"));
  assertEquals(days.filter((d) => d.date.yr === 2026).length, 4);
  const small = await rule.generateGoogleEvents(old, TimezoneRegion.UTC, 1001);
  assertThrows(() => small.generateUpToDate(end), RecurrenceExpansionLimitError);
});

Deno.test("bounded timed searches refuse both empty-period and sparse-step exhaustion", async () => {
  for (const rule of [
    "RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=31;BYHOUR=0",
    "RRULE:FREQ=SECONDLY;INTERVAL=65521;BYMONTH=1;BYMONTHDAY=1;BYHOUR=0;BYMINUTE=0;BYSECOND=0;COUNT=2",
  ]) {
    const recurrence = (await Recurrence.parse([rule])).exp();
    const generator = await recurrence.generateGoogleEvents(start, TimezoneRegion.UTC, 32);
    assertThrows(() => generator.generateUpToDate(end), RecurrenceExpansionLimitError);
    assertThrows(() => generator.generateUpToDate(end), RecurrenceExpansionLimitError);
  }
});
