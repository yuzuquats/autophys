import { NaiveDate } from "../naive-date.ts";
import type { CalendarCellData } from "./calendar-cell-data.ts";
import type { Option } from "../option.ts";

export type JalaliDate = {
  year: number;
  month: number; // 1 = Farvardin
  day: number;
};

/**
 * Solar Hijri (Persian/Jalali) calendar.
 *
 * Algorithm: 33-year arithmetic cycle (8 leap years per cycle).
 * Leap year test: (8*Y + 29) % 33 < 8.
 * Leap positions within each cycle: 1, 5, 9, 13, 17, 22, 26, 30.
 *
 * Epoch: 1 Farvardin 1 SH = JDN 1948320, calibrated to
 * 1 Farvardin 1400 SH = 20 March 2021 CE.
 *
 * Note: The official Iranian calendar is astronomical (equinox-based);
 * this arithmetic approximation may differ by ±1 day near leap boundaries.
 */

const EPOCH_JDN = 1948320;
const DSE_TO_JDN = 2440588;

function isLeap(year: number): boolean {
  return (8 * year + 29) % 33 < 8;
}

/**
 * JDN of 1 Farvardin for the given Solar Hijri year.
 * Uses 33-year cycle: 12053 days (= 33×365 + 8).
 * Leap count in years 1..r within a cycle: floor((8*r + 29) / 33).
 */
function yearStartJDN(year: number): number {
  const y = year - 1;
  const cycles = Math.floor(y / 33);
  const r = y % 33;
  return EPOCH_JDN + cycles * 12053 + r * 365 + Math.floor((r * 8 + 29) / 33);
}

function monthLength(month: number, leap: boolean): number {
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  return leap ? 30 : 29; // Esfand
}

// Farsi month names (1-indexed, index 0 unused)
const MONTH_NAMES = [
  "",
  "فروردین",   // Farvardin
  "اردیبهشت",  // Ordibehesht
  "خرداد",     // Khordad
  "تیر",       // Tir
  "مرداد",     // Mordad
  "شهریور",    // Shahrivar
  "مهر",       // Mehr
  "آبان",      // Aban
  "آذر",       // Azar
  "دی",        // Dey
  "بهمن",      // Bahman
  "اسفند",     // Esfand
];

// Extended Arabic-Indic (Farsi) digit characters
const FARSI_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

function toFarsiDigits(n: number): string {
  return String(n)
    .split("")
    .map((d) => FARSI_DIGITS[Number(d)])
    .join("");
}

export namespace PersianConverter {
  export function toJalaliDate(date: NaiveDate): Option<JalaliDate> {
    const jdn = Number(date.dse) + DSE_TO_JDN;

    // Estimate year from average year length (12053/33 ≈ 365.242 days)
    let year = Math.floor((jdn - EPOCH_JDN) / 365.242) + 1;
    if (year < 1) return null;
    for (let i = 0; i < 3 && yearStartJDN(year + 1) <= jdn; i++) year++;
    for (let i = 0; i < 3 && yearStartJDN(year) > jdn; i++) year--;
    if (year < 1) return null;

    const yearStart = yearStartJDN(year);
    if (jdn < yearStart) return null;

    const dayOfYear = jdn - yearStart;
    const leap = isLeap(year);
    let cursor = 0;
    for (let m = 1; m <= 12; m++) {
      const len = monthLength(m, leap);
      if (dayOfYear < cursor + len) {
        return { year, month: m, day: dayOfYear - cursor + 1 };
      }
      cursor += len;
    }
    return null;
  }

  export function formatMonth(month: number): string {
    return MONTH_NAMES[month] ?? String(month);
  }

  export function formatDay(day: number): string {
    return toFarsiDigits(day);
  }

  /**
   * Display label: month name on day 1, Farsi numeral otherwise.
   * Returns null when outside the supported range.
   */
  export function labelFor(date: NaiveDate): Option<string> {
    const j = toJalaliDate(date);
    if (!j) return null;
    if (j.day === 1) return formatMonth(j.month);
    return formatDay(j.day);
  }

  export function toCellData(date: NaiveDate): Option<CalendarCellData> {
    const j = toJalaliDate(date);
    if (!j) return null;
    return { calYear: j.year, calMonth: j.month, calDay: j.day, label: labelFor(date) ?? "" };
  }
}
