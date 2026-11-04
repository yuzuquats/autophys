export * from "./result.ts";
export * from "./range.ts";

export * from "./units/mod.ts";
export * from "./secondary-calendars/mod.ts";

export * from "./time.ts";
export * from "./naive-time.ts";
export * from "./naive-date.ts";
export * from "./naive-datetime.ts";
export * from "./datetime.ts";
export * from "./date-fragment.ts";
export * from "./relative-time.ts";
export * from "./date-region.ts";
export * from "./date-time-region.ts";
export * from "./semantic-time.ts";
export * from "./timezone.ts";
export * from "./timezone-region.ts";

import { DateTime } from "./datetime.ts";
import { NaiveDate } from "./naive-date.ts";
import { NaiveDateTime } from "./naive-datetime.ts";
import { NaiveTime } from "./naive-time.ts";
import { Time } from "./time.ts";

export * from "./recurrence/rrule.ts";
export * from "./recurrence/ical.ts";
export * from "./recurrence/recurrence.ts";
export * from "./recurrence/iso-date.ts";
export * from "./recurrence/exdate.ts";
export * from "./recurrence/instances.ts";

export function naivedate(year: number, mth1: number, day1: number): NaiveDate {
  return NaiveDate.fromYmd1(year, mth1, day1).exp();
}

/**
 * Creates a NaiveDateTime from year, month, day, hours, minutes, seconds, and milliseconds
 * @param year Year
 * @param mth1 Month (1-12)
 * @param day1 Day (1-31)
 * @param hrs Hours (0-23)
 * @param mins Minutes (0-59)
 * @param secs Seconds (0-59)
 * @param ms Milliseconds (0-999)
 * @returns New NaiveDateTime
 */
export function naivedatetime(
  year: number = 0,
  mth1: number = 1,
  day1: number = 1,
  hrs: number = 0,
  mins: number = 0,
  secs: number = 0,
  ms: number = 0,
): NaiveDateTime {
  return new NaiveDateTime(
    naivedate(year, mth1, day1),
    new NaiveTime(
      hrs * Time.MS_PER_HR +
        mins * Time.MS_PER_MIN +
        secs * Time.MS_PER_SEC +
        ms,
    ),
  );
}

export function naivetime(
  hrs: number = 0,
  mins: number = 0,
  secs: number = 0,
  ms: number = 0,
): NaiveTime {
  return new NaiveTime(
    hrs * Time.MS_PER_HR + mins * Time.MS_PER_MIN + secs * Time.MS_PER_SEC + ms,
  );
}

export const rfc3339 = DateTime.fromRfc3339;
export const datetime = DateTime.fromRfc3339;
