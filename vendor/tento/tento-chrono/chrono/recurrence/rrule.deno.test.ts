import { assertEquals } from "@std/assert";
import { RRule } from "./rrule.ts";

Deno.test("RRule toReadableDisplay - Daily frequencies", () => {
  // Daily, once per day
  const daily = RRule.parse("FREQ=DAILY;COUNT=5").exp();
  assertEquals(daily.toReadableDisplay(), "Daily, 5 times");

  // Daily, every 2 days
  const everyTwoDays = RRule.parse("FREQ=DAILY;INTERVAL=2;COUNT=10").exp();
  assertEquals(everyTwoDays.toReadableDisplay(), "Every 2 days, 10 times");
});

Deno.test("RRule toReadableDisplay - Weekly frequencies", () => {
  // Weekly, no specific days
  const weekly = RRule.parse("FREQ=WEEKLY;COUNT=4").exp();
  assertEquals(weekly.toReadableDisplay(), "Weekly, 4 times");

  // Weekly on specific days
  const weeklySpecific = RRule.parse(
    "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6",
  ).exp();
  assertEquals(
    weeklySpecific.toReadableDisplay(),
    "Weekly on Monday, Wednesday and Friday, 6 times",
  );

  // Weekly on one day
  const weeklyOneDay = RRule.parse("FREQ=WEEKLY;BYDAY=TU;COUNT=5").exp();
  assertEquals(weeklyOneDay.toReadableDisplay(), "Weekly on Tuesday, 5 times");

  // Every 2 weeks on multiple days
  const biweekly = RRule.parse("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR").exp();
  assertEquals(
    biweekly.toReadableDisplay(),
    "Every 2 weeks on Monday and Friday",
  );
});

Deno.test("RRule toReadableDisplay - Monthly frequencies", () => {
  // Monthly
  const monthly = RRule.parse("FREQ=MONTHLY;COUNT=12").exp();
  assertEquals(monthly.toReadableDisplay(), "Monthly, 12 times");

  // Monthly on nth weekday
  const monthlyNth = RRule.parse("FREQ=MONTHLY;BYDAY=2TU;COUNT=6").exp();
  assertEquals(
    monthlyNth.toReadableDisplay(),
    "Monthly on the 2nd Tuesday, 6 times",
  );

  // Monthly on last weekday
  const monthlyLast = RRule.parse("FREQ=MONTHLY;BYDAY=-1FR").exp();
  assertEquals(monthlyLast.toReadableDisplay(), "Monthly on the last Friday");

  // Monthly on specific day of month
  const monthlyDay = RRule.parse("FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12").exp();
  assertEquals(monthlyDay.toReadableDisplay(), "Monthly on day 15, 12 times");

  // Every 3 months
  const quarterly = RRule.parse("FREQ=MONTHLY;INTERVAL=3;COUNT=4").exp();
  assertEquals(quarterly.toReadableDisplay(), "Every 3 months, 4 times");
});

Deno.test("RRule toReadableDisplay - Yearly frequencies", () => {
  // Yearly
  const yearly = RRule.parse("FREQ=YEARLY;COUNT=5").exp();
  assertEquals(yearly.toReadableDisplay(), "Yearly, 5 times");

  // Yearly in specific months
  const yearlyMonths = RRule.parse("FREQ=YEARLY;BYMONTH=6,12;COUNT=10").exp();
  assertEquals(
    yearlyMonths.toReadableDisplay(),
    "Yearly in June and December, 10 times",
  );

  // Yearly in one month
  const yearlyOneMonth = RRule.parse("FREQ=YEARLY;BYMONTH=3").exp();
  assertEquals(yearlyOneMonth.toReadableDisplay(), "Yearly in March");

  // Every 2 years
  const biennial = RRule.parse("FREQ=YEARLY;INTERVAL=2;COUNT=3").exp();
  assertEquals(biennial.toReadableDisplay(), "Every 2 years, 3 times");
});

Deno.test("RRule toReadableDisplay - Other frequencies", () => {
  // Hourly
  const hourly = RRule.parse("FREQ=HOURLY;COUNT=24").exp();
  assertEquals(hourly.toReadableDisplay(), "Hourly, 24 times");

  // Every 3 hours
  const everyThreeHours = RRule.parse("FREQ=HOURLY;INTERVAL=3;COUNT=8").exp();
  assertEquals(everyThreeHours.toReadableDisplay(), "Every 3 hours, 8 times");

  // Every minute
  const minutely = RRule.parse("FREQ=MINUTELY;COUNT=60").exp();
  assertEquals(minutely.toReadableDisplay(), "Every minute, 60 times");

  // Every 30 minutes
  const halfHourly = RRule.parse("FREQ=MINUTELY;INTERVAL=30;COUNT=48").exp();
  assertEquals(halfHourly.toReadableDisplay(), "Every 30 minutes, 48 times");

  // Every second
  const secondly = RRule.parse("FREQ=SECONDLY;COUNT=3600").exp();
  assertEquals(secondly.toReadableDisplay(), "Every second, 3600 times");
});

Deno.test("RRule toReadableDisplay - No end conditions", () => {
  // No count, no until date
  const infinite = RRule.parse("FREQ=DAILY").exp();
  assertEquals(infinite.toReadableDisplay(), "Daily");

  const weeklyInfinite = RRule.parse("FREQ=WEEKLY;BYDAY=MO,WE,FR").exp();
  assertEquals(
    weeklyInfinite.toReadableDisplay(),
    "Weekly on Monday, Wednesday and Friday",
  );
});

Deno.test("RRule toReadableDisplay - Complex patterns", () => {
  // Monthly on multiple month days
  const multiDays = RRule.parse(
    "FREQ=MONTHLY;BYMONTHDAY=1,15,31;COUNT=36",
  ).exp();
  assertEquals(
    multiDays.toReadableDisplay(),
    "Monthly on days 1, 15 and 31, 36 times",
  );

  // Yearly in multiple months
  const multiMonths = RRule.parse(
    "FREQ=YEARLY;BYMONTH=3,6,9,12;COUNT=20",
  ).exp();
  assertEquals(
    multiMonths.toReadableDisplay(),
    "Yearly in March, June, September and December, 20 times",
  );
});
