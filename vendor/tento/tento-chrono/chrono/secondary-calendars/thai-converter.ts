import { NaiveDate } from "../naive-date.ts";
import type { CalendarCellData } from "./calendar-cell-data.ts";

/**
 * Thai Buddhist calendar.
 *
 * Identical structure to the Gregorian calendar; the only differences are:
 *   - Buddhist Era year = Gregorian year + 543
 *   - Month names are in Thai
 *   - Day numerals are Thai digits (๐–๙)
 *
 * No calendar conversion is required — month and day map 1:1 to Gregorian.
 */

// Thai month names, 1-indexed (index 0 unused)
const MONTH_NAMES = [
  "",
  "มกราคม",    // January
  "กุมภาพันธ์", // February
  "มีนาคม",    // March
  "เมษายน",    // April
  "พฤษภาคม",   // May
  "มิถุนายน",  // June
  "กรกฎาคม",   // July
  "สิงหาคม",   // August
  "กันยายน",   // September
  "ตุลาคม",    // October
  "พฤศจิกายน", // November
  "ธันวาคม",   // December
];

// Thai digit characters (U+0E50–U+0E59)
const THAI_DIGITS = ["๐", "๑", "๒", "๓", "๔", "๕", "๖", "๗", "๘", "๙"];

function toThaiDigits(n: number): string {
  return String(n)
    .split("")
    .map((d) => THAI_DIGITS[Number(d)])
    .join("");
}

export namespace ThaiConverter {
  export function buddhistYear(gregorianYear: number): number {
    return gregorianYear + 543;
  }

  export function formatMonth(month: number): string {
    return MONTH_NAMES[month] ?? String(month);
  }

  export function formatDay(day: number): string {
    return toThaiDigits(day);
  }

  /**
   * Display label: Thai month name on day 1, Thai digit otherwise.
   */
  export function labelFor(date: NaiveDate): string {
    if (date.day === 1) return formatMonth(date.month1);
    return formatDay(date.day);
  }

  export function toCellData(date: NaiveDate): CalendarCellData {
    return {
      calYear: buddhistYear(date.yr),
      calMonth: date.month1,
      calDay: date.day,
      label: labelFor(date),
    };
  }
}
