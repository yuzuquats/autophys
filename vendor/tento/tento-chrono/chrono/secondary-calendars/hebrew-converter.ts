import { NaiveDate } from "../naive-date.ts";
import type { CalendarCellData } from "./calendar-cell-data.ts";
import type { Option } from "../option.ts";

export type HebrewDate = {
  year: number;
  month: number; // 1-indexed from Tishrei
  day: number;
  isLeap: boolean;
};

/**
 * Hebrew (Jewish) lunisolar calendar.
 *
 * Algorithm: Calendrical Calculations (Reingold & Dershowitz), verified against
 * published Rosh Hashanah dates for 5760–5801 (1999–2040).
 *
 * Epoch: 1 Tishrei year 1 AM = JDN 347998.
 * Month 1 = Tishrei (civil new year). Leap years add Adar I before Adar II.
 */

const EPOCH_JDN = 347998;
const DSE_TO_JDN = 2440588; // JDN of January 1, 1970

function isLeap(year: number): boolean {
  return ((7 * year + 1) % 19) < 7;
}

function delay1(year: number): number {
  const m = Math.floor((235 * year - 234) / 19);
  const p = 12084 + 13753 * m;
  let d = 29 * m + Math.floor(p / 25920);
  if ((3 * (d + 1)) % 7 < 3) d++;
  return d;
}

function delay2(year: number): number {
  const last = delay1(year - 1);
  const present = delay1(year);
  const next = delay1(year + 1);
  if (next - present === 356) return 2;
  if (present - last === 382) return 1;
  return 0;
}

function newYearJDN(year: number): number {
  return EPOCH_JDN + delay1(year) + delay2(year);
}

/**
 * Month lengths for a given Hebrew year (1-indexed from Tishrei).
 * 12 entries for regular years, 13 for leap years.
 */
function monthLengths(year: number): number[] {
  const yearLen = newYearJDN(year + 1) - newYearJDN(year);
  const cheshvan = yearLen % 10 === 5 ? 30 : 29; // complete year
  const kislev = yearLen % 10 === 3 ? 29 : 30;   // deficient year
  const months = [30, cheshvan, kislev, 29, 30];  // Tishrei–Shevat
  if (isLeap(year)) {
    months.push(30, 29); // Adar I, Adar II
  } else {
    months.push(29);     // Adar
  }
  months.push(30, 29, 30, 29, 30, 29); // Nisan–Elul
  return months;
}

// Month names (1-indexed from Tishrei)
const REGULAR_MONTHS = [
  "", "תשרי", "חשוון", "כסלו", "טבת", "שבט",
  "אדר", "ניסן", "אייר", "סיון", "תמוז", "אב", "אלול",
];
const LEAP_MONTHS = [
  "", "תשרי", "חשוון", "כסלו", "טבת", "שבט",
  "אדר א׳", "אדר ב׳", "ניסן", "אייר", "סיון", "תמוז", "אב", "אלול",
];

// Hebrew day numerals (Gematria), with special-cased 15 (טו) and 16 (טז)
const GEMATRIA = [
  "", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט",
  "י", "יא", "יב", "יג", "יד", "טו", "טז",
  "יז", "יח", "יט", "כ",
  "כא", "כב", "כג", "כד", "כה", "כו", "כז", "כח", "כט", "ל",
];

export namespace HebrewConverter {
  export function toHebrewDate(date: NaiveDate): Option<HebrewDate> {
    const jdn = Number(date.dse) + DSE_TO_JDN;

    // Estimate then clamp to the correct Hebrew year
    let year = Math.floor((jdn - EPOCH_JDN) / 365.25) + 1;
    for (let i = 0; i < 3 && newYearJDN(year + 1) <= jdn; i++) year++;
    for (let i = 0; i < 3 && newYearJDN(year) > jdn; i++) year--;

    const yearStart = newYearJDN(year);
    if (jdn < yearStart) return null;

    const dayOfYear = jdn - yearStart;
    const lengths = monthLengths(year);
    let cursor = 0;
    for (let m = 0; m < lengths.length; m++) {
      if (dayOfYear < cursor + lengths[m]) {
        return { year, month: m + 1, day: dayOfYear - cursor + 1, isLeap: isLeap(year) };
      }
      cursor += lengths[m];
    }
    return null;
  }

  export function formatDay(day: number): string {
    return GEMATRIA[day] ?? String(day);
  }

  export function formatMonth(month: number, leap: boolean): string {
    return (leap ? LEAP_MONTHS : REGULAR_MONTHS)[month] ?? String(month);
  }

  /**
   * Display label for a date: month name on day 1, Gematria ordinal otherwise.
   * Returns null when outside the supported range.
   */
  export function labelFor(date: NaiveDate): Option<string> {
    const h = toHebrewDate(date);
    if (!h) return null;
    if (h.day === 1) return formatMonth(h.month, h.isLeap);
    return formatDay(h.day);
  }

  export function toCellData(date: NaiveDate): Option<CalendarCellData> {
    const h = toHebrewDate(date);
    if (!h) return null;
    return { calYear: h.year, calMonth: h.month, calDay: h.day, label: labelFor(date) ?? "" };
  }
}
