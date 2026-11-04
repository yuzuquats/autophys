import { NaiveDate } from "../naive-date.ts";
import type { CalendarCellData } from "./calendar-cell-data.ts";
import type { Option } from "../option.ts";

export type SakaDate = {
  year: number;
  month: number; // 1 = Chaitra
  day: number;
};

/**
 * Indian National Calendar (Saka era).
 *
 * Solar calendar adopted in 1957 as India's official civil calendar.
 * 12 months: Chaitra (30/31) + Vaisakha–Bhadra (31 each) + Asvina–Phalguna (30 each).
 * Leap year: Saka year Y is leap when Gregorian year Y+78 is a Gregorian leap year.
 * New year (Chaitra 1): March 22 in ordinary Gregorian years, March 21 in Gregorian leap years.
 *
 * Epoch: 1 Chaitra 1 Saka = JDN 1749995, calibrated to
 * 1 Chaitra 1945 Saka = 22 March 2023 CE and verified for 1946–1947 Saka.
 */

const EPOCH_JDN = 1749995;
const DSE_TO_JDN = 2440588;

function isSakaLeap(year: number): boolean {
  const gy = year + 78;
  return gy % 4 === 0 && (gy % 100 !== 0 || gy % 400 === 0);
}

/**
 * Count of Gregorian leap years in 79..(sakaYear + 77), which equals
 * the count of Saka leap years in 1..(sakaYear - 1).
 */
function leapCountBefore(sakaYear: number): number {
  const b = sakaYear + 77;
  return Math.floor(b / 4) - Math.floor(b / 100) + Math.floor(b / 400) - 19;
}

function yearStartJDN(year: number): number {
  return EPOCH_JDN + (year - 1) * 365 + leapCountBefore(year);
}

function monthLength(month: number, leap: boolean): number {
  if (month === 1) return leap ? 31 : 30; // Chaitra
  if (month <= 6) return 31;              // Vaisakha–Bhadra
  return 30;                              // Asvina–Phalguna
}

// Sanskrit/Hindi month names (1-indexed, index 0 unused)
const MONTH_NAMES = [
  "",
  "चैत्र",       // Chaitra
  "वैशाख",       // Vaisakha
  "ज्येष्ठ",     // Jyaistha
  "आषाढ़",       // Asadha
  "श्रावण",      // Sravana
  "भाद्रपद",     // Bhadra
  "आश्विन",      // Asvina
  "कार्तिक",     // Kartika
  "अग्रहायण",    // Agrahayana
  "पौष",         // Pausa
  "माघ",         // Magha
  "फाल्गुन",     // Phalguna
];

// Devanagari digit characters (U+0966–U+096F)
const DEVANAGARI = ["०", "१", "२", "३", "४", "५", "६", "७", "८", "९"];

function toDevanagari(n: number): string {
  return String(n)
    .split("")
    .map((d) => DEVANAGARI[Number(d)])
    .join("");
}

export namespace IndianConverter {
  export function toSakaDate(date: NaiveDate): Option<SakaDate> {
    const jdn = Number(date.dse) + DSE_TO_JDN;

    let year = Math.floor((jdn - EPOCH_JDN) / 365.25) + 1;
    if (year < 1) return null;
    for (let i = 0; i < 3 && yearStartJDN(year + 1) <= jdn; i++) year++;
    for (let i = 0; i < 3 && yearStartJDN(year) > jdn; i++) year--;
    if (year < 1) return null;

    const yearStart = yearStartJDN(year);
    if (jdn < yearStart) return null;

    const dayOfYear = jdn - yearStart;
    const leap = isSakaLeap(year);
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
    return toDevanagari(day);
  }

  /**
   * Display label: Sanskrit month name on day 1, Devanagari numeral otherwise.
   * Returns null when outside the supported range.
   */
  export function labelFor(date: NaiveDate): Option<string> {
    const s = toSakaDate(date);
    if (!s) return null;
    if (s.day === 1) return formatMonth(s.month);
    return formatDay(s.day);
  }

  export function toCellData(date: NaiveDate): Option<CalendarCellData> {
    const s = toSakaDate(date);
    if (!s) return null;
    return { calYear: s.year, calMonth: s.month, calDay: s.day, label: labelFor(date) ?? "" };
  }
}
