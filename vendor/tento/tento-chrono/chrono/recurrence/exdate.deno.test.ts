import { assertEquals, assertThrows } from "@std/assert";
import { ExDate } from "./exdate.ts";
import { NaiveDate } from "../naive-date.ts";
import { IsoDate } from "./iso-date.ts";

Deno.test("ExDate: parse simple date-time", () => {
  const result = ExDate.parse("EXDATE:20250902T220000Z");
  assertEquals(result.isOk, true);
  
  const exdate = result.asOk()!;
  assertEquals(exdate.dates.length, 1);
  assertEquals(exdate.tzid, null);
  assertEquals(exdate.valueType, null);
  assertEquals(exdate.dates[0].toString(), "20250902T220000Z");
});

Deno.test("ExDate: parse with timezone", () => {
  const result = ExDate.parse("EXDATE;TZID=America/Los_Angeles:20250902T220000");
  assertEquals(result.isOk, true);
  
  const exdate = result.asOk()!;
  assertEquals(exdate.dates.length, 1);
  assertEquals(exdate.tzid, "America/Los_Angeles");
  assertEquals(exdate.valueType, null);
  assertEquals(exdate.dates[0].toString(), "20250902T220000");
});

Deno.test("ExDate: parse date-only format", () => {
  const result = ExDate.parse("EXDATE;VALUE=DATE:20250902");
  assertEquals(result.isOk, true);
  
  const exdate = result.asOk()!;
  assertEquals(exdate.dates.length, 1);
  assertEquals(exdate.tzid, null);
  assertEquals(exdate.valueType, "DATE");
  assertEquals(exdate.dates[0].toString(), "20250902");
});

Deno.test("ExDate: parse multiple dates", () => {
  const result = ExDate.parse("EXDATE:20250902T220000Z,20250910T143000Z,20250915T180000Z");
  assertEquals(result.isOk, true);
  
  const exdate = result.asOk()!;
  assertEquals(exdate.dates.length, 3);
  assertEquals(exdate.dates[0].toString(), "20250902T220000Z");
  assertEquals(exdate.dates[1].toString(), "20250910T143000Z");
  assertEquals(exdate.dates[2].toString(), "20250915T180000Z");
});

Deno.test("ExDate: parse multiple dates with timezone", () => {
  const result = ExDate.parse("EXDATE;TZID=Europe/London:20250902T220000,20250910T143000");
  assertEquals(result.isOk, true);
  
  const exdate = result.asOk()!;
  assertEquals(exdate.dates.length, 2);
  assertEquals(exdate.tzid, "Europe/London");
  assertEquals(exdate.dates[0].toString(), "20250902T220000");
  assertEquals(exdate.dates[1].toString(), "20250910T143000");
});

Deno.test("ExDate: parse with VALUE=DATE-TIME", () => {
  const result = ExDate.parse("EXDATE;VALUE=DATE-TIME:20250902T220000Z");
  assertEquals(result.isOk, true);
  
  const exdate = result.asOk()!;
  assertEquals(exdate.dates.length, 1);
  assertEquals(exdate.valueType, "DATE-TIME");
  assertEquals(exdate.dates[0].toString(), "20250902T220000Z");
});

Deno.test("ExDate: parse with both TZID and VALUE", () => {
  const result = ExDate.parse("EXDATE;TZID=America/New_York;VALUE=DATE-TIME:20250902T220000");
  assertEquals(result.isOk, true);
  
  const exdate = result.asOk()!;
  assertEquals(exdate.dates.length, 1);
  assertEquals(exdate.tzid, "America/New_York");
  assertEquals(exdate.valueType, "DATE-TIME");
  assertEquals(exdate.dates[0].toString(), "20250902T220000");
});

Deno.test("ExDate: toString() round-trip", () => {
  const testCases = [
    "EXDATE:20250902T220000Z",
    "EXDATE;TZID=America/Los_Angeles:20250902T220000",
    "EXDATE;VALUE=DATE:20250902",
    "EXDATE;TZID=Europe/London;VALUE=DATE-TIME:20250902T220000,20250910T143000",
  ];
  
  for (const testCase of testCases) {
    const result = ExDate.parse(testCase);
    assertEquals(result.isOk, true);
    
    const exdate = result.asOk()!;
    const stringified = exdate.toString();
    
    // Parse the stringified version
    const reparsed = ExDate.parse(stringified);
    assertEquals(reparsed.isOk, true);
    
    const reparsedExdate = reparsed.asOk()!;
    assertEquals(reparsedExdate.dates.length, exdate.dates.length);
    assertEquals(reparsedExdate.tzid, exdate.tzid);
    assertEquals(reparsedExdate.valueType, exdate.valueType);
  }
});

Deno.test("ExDate: isExceptionDate", () => {
  const result = ExDate.parse("EXDATE:20250902T220000Z,20250910T143000Z");
  assertEquals(result.isOk, true);
  
  const exdate = result.asOk()!;
  
  const date1 = NaiveDate.fromYmd1(2025, 9, 2).exp();
  const date2 = NaiveDate.fromYmd1(2025, 9, 10).exp();
  const date3 = NaiveDate.fromYmd1(2025, 9, 15).exp();
  
  assertEquals(exdate.isExceptionDate(date1), true);
  assertEquals(exdate.isExceptionDate(date2), true);
  assertEquals(exdate.isExceptionDate(date3), false);
});

Deno.test("ExDate: getNaiveDates", () => {
  const result = ExDate.parse("EXDATE:20250902T220000Z,20250910T143000Z");
  assertEquals(result.isOk, true);
  
  const exdate = result.asOk()!;
  const naiveDates = exdate.getNaiveDates();
  
  assertEquals(naiveDates.length, 2);
  assertEquals(naiveDates[0].toString(), "2025-09-02");
  assertEquals(naiveDates[1].toString(), "2025-09-10");
});

Deno.test("ExDate: merge multiple ExDates", () => {
  const exdate1 = ExDate.parse("EXDATE;TZID=America/Los_Angeles:20250902T220000").asOk()!;
  const exdate2 = ExDate.parse("EXDATE;TZID=America/Los_Angeles:20250910T143000,20250915T180000").asOk()!;
  const exdate3 = ExDate.parse("EXDATE;TZID=America/Los_Angeles:20250902T220000,20250920T100000").asOk()!; // Has duplicate
  
  const merged = ExDate.merge([exdate1, exdate2, exdate3]);
  
  assertEquals(merged.dates.length, 4); // Should remove duplicate 20250902T220000
  assertEquals(merged.tzid, "America/Los_Angeles");
  
  const dateStrings = merged.dates.map(d => d.toString()).sort();
  assertEquals(dateStrings, [
    "20250902T220000",
    "20250910T143000",
    "20250915T180000",
    "20250920T100000",
  ]);
});

Deno.test("ExDate: parseMultiple from recurrence array", () => {
  const recurrence = [
    "RRULE:FREQ=DAILY;COUNT=10",
    "EXDATE;TZID=America/Los_Angeles:20250902T220000",
    "EXDATE:20250910T143000Z,20250915T180000Z",
    "EXDATE;VALUE=DATE:20250920",
  ];
  
  const exdates = ExDate.parseMultiple(recurrence);
  assertEquals(exdates.length, 3);
  
  assertEquals(exdates[0].tzid, "America/Los_Angeles");
  assertEquals(exdates[0].dates.length, 1);
  
  assertEquals(exdates[1].tzid, null);
  assertEquals(exdates[1].dates.length, 2);
  
  assertEquals(exdates[2].valueType, "DATE");
  assertEquals(exdates[2].dates.length, 1);
});

Deno.test("ExDate: error on invalid format", () => {
  const badFormats = [
    "NOT_EXDATE:20250902T220000Z",
    "EXDATE",
    "EXDATE;",
    "EXDATE:",
    "EXDATE;INVALID",
    "EXDATE:not_a_date",
  ];
  
  for (const badFormat of badFormats) {
    const result = ExDate.parse(badFormat);
    assertEquals(result.isErr, true, `Should fail for: ${badFormat}`);
  }
});

Deno.test("RRule: parseWithRecurrence with ExDate", async () => {
  const { RRule } = await import("./rrule.ts");
  
  const recurrence = [
    "RRULE:FREQ=DAILY;COUNT=10",
    "EXDATE;TZID=America/Los_Angeles:20250902T220000",
    "EXDATE:20250910T143000Z,20250915T180000Z",
  ];
  
  const result = RRule.parseWithRecurrence(recurrence);
  assertEquals(result.isOk, true);
  
  const rrule = result.asOk()!;
  assertEquals(rrule.exdates.length, 3);
  
  // Check that all dates were parsed correctly
  const exdateStrings = rrule.exdates.map(d => d.toString()).sort();
  assertEquals(exdateStrings, [
    "20250902T220000",
    "20250910T143000Z",
    "20250915T180000Z",
  ]);
});