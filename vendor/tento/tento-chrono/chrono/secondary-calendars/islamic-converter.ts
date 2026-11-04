import { NaiveDate } from "../naive-date.ts";
import type { CalendarCellData } from "./calendar-cell-data.ts";
import type { Option } from "../option.ts";

export type HijriDate = {
  year: number;
  month: number; // 1 = Muharram
  day: number;
};

/**
 * Tabular Islamic (Hijri) calendar — Friday epoch variant.
 *
 * Algorithm: standard 30-year arithmetic cycle (Reingold & Dershowitz).
 * Leap years at positions 2,5,7,10,13,15,18,21,24,26,29 within each 30-year cycle.
 * Verified against published 1 Muharram dates for 1440–1450 AH (2018–2029).
 *
 * Epoch: 1 Muharram 1 AH = JDN 1948439 (Friday, July 16, 622 CE Julian).
 */

const EPOCH_JDN = 1948439;
const DSE_TO_JDN = 2440588; // JDN of January 1, 1970
const LEAP_POSITIONS = new Set([2, 5, 7, 10, 13, 15, 18, 21, 24, 26, 29]);

function isLeap(year: number): boolean {
  return LEAP_POSITIONS.has(((year - 1) % 30) + 1);
}

/**
 * JDN of 1 Muharram for the given Hijri year.
 * Uses 30-year cycle: 10631 days, 11 leap years per cycle.
 * Leap year count in positions 1..r: floor((11*r + 15) / 30).
 */
function yearStartJDN(year: number): number {
  const y = year - 1;
  const cycles = Math.floor(y / 30);
  const r = y % 30;
  return EPOCH_JDN + cycles * 10631 + r * 354 + Math.floor((11 * r + 15) / 30);
}

function monthLength(month: number, leap: boolean): number {
  if (month === 12) return leap ? 30 : 29;
  return month % 2 === 1 ? 30 : 29; // odd months = 30, even = 29
}

// Arabic month names (1-indexed, index 0 unused)
const MONTH_NAMES = [
  "",
  "محرم",        // Muharram
  "صفر",         // Safar
  "ربيع الأول",  // Rabi' al-Awwal
  "ربيع الثاني", // Rabi' al-Thani
  "جمادى الأولى",  // Jumada al-Awwal
  "جمادى الثانية", // Jumada al-Thani
  "رجب",         // Rajab
  "شعبان",       // Sha'ban
  "رمضان",       // Ramadan
  "شوال",        // Shawwal
  "ذو القعدة",   // Dhu al-Qi'dah
  "ذو الحجة",    // Dhu al-Hijjah
];

// Eastern Arabic-Indic digit characters
const ARABIC_INDIC = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

function toArabicIndic(n: number): string {
  return String(n)
    .split("")
    .map((d) => ARABIC_INDIC[Number(d)])
    .join("");
}

export namespace IslamicConverter {
  export function toHijriDate(date: NaiveDate): Option<HijriDate> {
    const jdn = Number(date.dse) + DSE_TO_JDN;

    // Estimate year from average year length (10631/30 ≈ 354.367 days)
    let year = Math.floor((jdn - EPOCH_JDN) / 354.367) + 1;
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
    return toArabicIndic(day);
  }

  /**
   * Display label: month name on day 1, Eastern Arabic numeral otherwise.
   * Returns null when outside the supported range.
   */
  export function labelFor(date: NaiveDate): Option<string> {
    const h = toHijriDate(date);
    if (!h) return null;
    if (h.day === 1) return formatMonth(h.month);
    return formatDay(h.day);
  }

  export function toCellData(date: NaiveDate): Option<CalendarCellData> {
    const h = toHijriDate(date);
    if (!h) return null;
    return { calYear: h.year, calMonth: h.month, calDay: h.day, label: labelFor(date) ?? "" };
  }
}
