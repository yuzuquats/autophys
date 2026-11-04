import { assertEquals } from "jsr:@std/assert";
import { PartialDate, NaiveDate } from "../mod.ts";

// Tests for toType() with ISO week year boundaries
// Bug fix: toType("week") was using date.yr instead of date.isoYear,
// causing incorrect week year assignment at year boundaries.

Deno.test("PartialDate.toType - day to week at year boundary (Dec 29, 2025)", () => {
  // Dec 29, 2025 is a Monday, the start of ISO week 1 of 2026
  const dec29 = PartialDate.fromDate(NaiveDate.fromYmd1Exp(2025, 12, 29));
  const asWeek = dec29.toType("week");

  assertEquals(asWeek.type, "week");
  assertEquals(asWeek.yr, 2026, "Should be ISO year 2026, not calendar year 2025");
  assertEquals(asWeek.wno, 1, "Should be week 1");
});

Deno.test("PartialDate.toType - day to week at year boundary (Dec 31, 2025)", () => {
  // Dec 31, 2025 is also in ISO week 1 of 2026
  const dec31 = PartialDate.fromDate(NaiveDate.fromYmd1Exp(2025, 12, 31));
  const asWeek = dec31.toType("week");

  assertEquals(asWeek.type, "week");
  assertEquals(asWeek.yr, 2026, "Should be ISO year 2026");
  assertEquals(asWeek.wno, 1, "Should be week 1");
});

Deno.test("PartialDate.toType - day to week at year boundary (Jan 1, 2026)", () => {
  // Jan 1, 2026 is in ISO week 1 of 2026
  const jan1 = PartialDate.fromDate(NaiveDate.fromYmd1Exp(2026, 1, 1));
  const asWeek = jan1.toType("week");

  assertEquals(asWeek.type, "week");
  assertEquals(asWeek.yr, 2026);
  assertEquals(asWeek.wno, 1);
});

Deno.test("PartialDate.toType - day to week (mid-year, no boundary issue)", () => {
  // A date in the middle of the year where yr == isoYear
  const june15 = PartialDate.fromDate(NaiveDate.fromYmd1Exp(2025, 6, 15));
  const asWeek = june15.toType("week");

  assertEquals(asWeek.type, "week");
  assertEquals(asWeek.yr, 2025);
});

Deno.test("PartialDate.toType - day to week at start of year (Jan 1, 2025)", () => {
  // Jan 1, 2025 is a Wednesday, in ISO week 1 of 2025
  const jan1 = PartialDate.fromDate(NaiveDate.fromYmd1Exp(2025, 1, 1));
  const asWeek = jan1.toType("week");

  assertEquals(asWeek.type, "week");
  assertEquals(asWeek.yr, 2025);
  assertEquals(asWeek.wno, 1);
});

Deno.test("PartialDate.toType - identity returns same instance", () => {
  const day = PartialDate.fromDate(NaiveDate.fromYmd1Exp(2025, 6, 15));
  const sameDay = day.toType("day");

  assertEquals(day, sameDay, "toType with same type should return same instance");
});

Deno.test("PartialDate.toType - week index calculation at year boundary", () => {
  // This tests that the index property is correct after toType conversion
  // Dec 29, 2025 and Jan 1, 2026 should have the same week index (both week 1 of 2026)
  const dec29 = PartialDate.fromDate(NaiveDate.fromYmd1Exp(2025, 12, 29));
  const jan1 = PartialDate.fromDate(NaiveDate.fromYmd1Exp(2026, 1, 1));

  const dec29Week = dec29.toType("week");
  const jan1Week = jan1.toType("week");

  assertEquals(dec29Week.index, jan1Week.index, "Both dates are in the same week");
});

Deno.test("PartialDate.generateSubPartials - Year to Months", () => {
  const year2024 = PartialDate.fromYear(2024);
  const months = year2024.generateSubPartials("month");

  assertEquals(months.length, 12, "Year should generate 12 months");
  assertEquals(months[0].type, "month");
  assertEquals(months[0].yr, 2024);
  assertEquals(months[0].mth, 1);
  assertEquals(months[11].yr, 2024);
  assertEquals(months[11].mth, 12);
});

Deno.test("PartialDate.generateSubPartials - Year to Months with count limit", () => {
  const year2024 = PartialDate.fromYear(2024);
  const months = year2024.generateSubPartials("month", 3);

  assertEquals(months.length, 3, "Should only generate 3 months");
  assertEquals(months[0].mth, 1);
  assertEquals(months[1].mth, 2);
  assertEquals(months[2].mth, 3);
});

Deno.test("PartialDate.generateSubPartials - Year to Weeks", () => {
  const year2024 = PartialDate.fromYear(2024);
  const weeks = year2024.generateSubPartials("week");

  // 2024 is a leap year, should have 52 or 53 ISO weeks
  assertEquals(
    weeks.length >= 52 && weeks.length <= 53,
    true,
    "Year should generate 52-53 weeks",
  );
  assertEquals(weeks[0].type, "week");
});

Deno.test("PartialDate.generateSubPartials - Year to Days", () => {
  const year2024 = PartialDate.fromYear(2024);
  const days = year2024.generateSubPartials("day");

  // 2024 is a leap year, should have 366 days
  assertEquals(days.length, 366, "Leap year should generate 366 days");
  assertEquals(days[0].type, "day");
  assertEquals(days[0].yr, 2024);
  assertEquals(days[0].mth, 1);
  assertEquals(days[0].day, 1);
});

Deno.test("PartialDate.generateSubPartials - Month to Days", () => {
  const jan2024 = PartialDate.fromMonth(2024, 1);
  const days = jan2024.generateSubPartials("day");

  assertEquals(days.length, 31, "January should generate 31 days");
  assertEquals(days[0].type, "day");
  assertEquals(days[0].day, 1);
  assertEquals(days[30].day, 31);

  // Test February (leap year)
  const feb2024 = PartialDate.fromMonth(2024, 2);
  const febDays = feb2024.generateSubPartials("day");
  assertEquals(
    febDays.length,
    29,
    "February 2024 (leap) should generate 29 days",
  );

  // Test February (non-leap year)
  const feb2023 = PartialDate.fromMonth(2023, 2);
  const feb2023Days = feb2023.generateSubPartials("day");
  assertEquals(
    feb2023Days.length,
    28,
    "February 2023 (non-leap) should generate 28 days",
  );
});

Deno.test("PartialDate.generateSubPartials - Month to Days with count limit", () => {
  const jan2024 = PartialDate.fromMonth(2024, 1);
  const days = jan2024.generateSubPartials("day", 7);

  assertEquals(days.length, 7, "Should only generate 7 days");
  assertEquals(days[0].day, 1);
  assertEquals(days[6].day, 7);
});

Deno.test("PartialDate.generateSubPartials - Month to Weeks", () => {
  const jan2024 = PartialDate.fromMonth(2024, 1);
  const weeks = jan2024.generateSubPartials("week");

  // January 2024 spans parts of multiple ISO weeks
  assertEquals(
    weeks.length >= 4 && weeks.length <= 6,
    true,
    "Month should span 4-6 weeks",
  );
  assertEquals(weeks[0].type, "week");
});

Deno.test("PartialDate.generateSubPartials - Week to Days", () => {
  // Create a week in January 2024
  const startDate = NaiveDate.fromYmd1Exp(2024, 1, 8); // Monday, Jan 8, 2024
  const weekPd = new PartialDate(
    "week",
    startDate.isoYear,
    null,
    null,
    startDate.isoWno,
  );

  const days = weekPd.generateSubPartials("day");

  assertEquals(days.length, 7, "Week should generate 7 days");
  assertEquals(days[0].type, "day");
});

Deno.test("PartialDate.generateSubPartials - Week to Days with count limit", () => {
  const startDate = NaiveDate.fromYmd1Exp(2024, 1, 8);
  const weekPd = new PartialDate(
    "week",
    startDate.isoYear,
    null,
    null,
    startDate.isoWno,
  );

  const days = weekPd.generateSubPartials("day", 3);

  assertEquals(days.length, 3, "Should only generate 3 days");
});

Deno.test("PartialDate.generateSubPartials - Day to Days (identity)", () => {
  const date = NaiveDate.fromYmd1Exp(2024, 6, 15);
  const dayPd = PartialDate.fromDate(date);

  const days = dayPd.generateSubPartials("day");

  assertEquals(days.length, 1, "Day should generate only itself");
  assertEquals(days[0].yr, 2024);
  assertEquals(days[0].mth, 6);
  assertEquals(days[0].day, 15);
});

Deno.test("PartialDate.generateSubPartials - Empty result with count=0", () => {
  const year2024 = PartialDate.fromYear(2024);
  const months = year2024.generateSubPartials("month", 0);

  assertEquals(months.length, 0, "Count of 0 should generate empty array");
});

Deno.test("PartialDate.generateSubPartials - Respects parent range boundaries", () => {
  // Create a year partial and generate more months than exist
  const year2024 = PartialDate.fromYear(2024);
  const months = year2024.generateSubPartials("month", 100);

  // Should stop at 12 months (year boundary) even though we requested 100
  assertEquals(
    months.length,
    12,
    "Should respect year boundary and stop at 12 months",
  );
});

Deno.test("PartialDate.generateSubPartials - Week spanning year boundary", () => {
  // Week 52 of 2024 might span into 2025
  const lateDecDate = NaiveDate.fromYmd1Exp(2024, 12, 30);
  const weekPd = new PartialDate(
    "week",
    lateDecDate.isoYear,
    null,
    null,
    lateDecDate.isoWno,
  );

  const days = weekPd.generateSubPartials("day");

  assertEquals(
    days.length,
    7,
    "Week should still generate 7 days even across year boundary",
  );
  assertEquals(days[0].type, "day");
});

Deno.test("PartialDate.generateSubPartials - Consistent with PartialDate.add()", () => {
  const jan2024 = PartialDate.fromMonth(2024, 1);
  const days = jan2024.generateSubPartials("day", 5);

  // Verify that each day matches what we'd get from manual .add() calls
  let currentDay = PartialDate.fromDate(jan2024.start);
  for (let i = 0; i < 5; i++) {
    assertEquals(days[i].yr, currentDay.yr);
    assertEquals(days[i].mth, currentDay.mth);
    assertEquals(days[i].day, currentDay.day);
    currentDay = currentDay.add(1);
  }
});

Deno.test("PartialDate.generateSubPartials - Year to Days count limit respects boundary", () => {
  const year2024 = PartialDate.fromYear(2024);

  // Request more days than exist in the year
  const days = year2024.generateSubPartials("day", 400);

  // Should stop at 366 (leap year) even though we requested 400
  assertEquals(days.length, 366, "Should respect year boundary");
});

Deno.test("PartialDate.generateSubPartials - Month to Weeks limited by month range", () => {
  const feb2024 = PartialDate.fromMonth(2024, 2);

  // Request more weeks than could possibly fit in February
  const weeks = feb2024.generateSubPartials("week", 10);

  // February can only span a limited number of weeks
  assertEquals(weeks.length < 10, true, "Should stop at month boundary");
});
