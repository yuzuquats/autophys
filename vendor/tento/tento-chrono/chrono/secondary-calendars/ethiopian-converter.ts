import { NaiveDate } from "../naive-date.ts";
import type { CalendarCellData } from "./calendar-cell-data.ts";
import type { Option } from "../option.ts";

export type EthiopianDate = {
  year: number;
  month: number; // 1 = Mäskäräm, 13 = Ṗaguméʿ
  day: number;
};

/**
 * Ethiopian (Ge'ez) calendar.
 *
 * 13-month solar calendar: 12 months of 30 days + Ṗaguméʿ (5 or 6 days).
 * Leap year: Y % 4 == 0 (years whose corresponding Gregorian year contains Feb 29).
 *
 * Epoch: 1 Mäskäräm 1 AM = JDN 1724221, calibrated to
 * 1 Mäskäräm 2016 EC = 11 September 2023 CE.
 * Verified for 2010–2017 EC.
 */

const EPOCH_JDN = 1724221;
const DSE_TO_JDN = 2440588;

function isLeap(year: number): boolean {
  return year % 4 === 0;
}

function yearStartJDN(year: number): number {
  const y = year - 1;
  return EPOCH_JDN + y * 365 + Math.floor(y / 4);
}

function monthLength(month: number, leap: boolean): number {
  if (month <= 12) return 30;
  return leap ? 6 : 5; // Ṗaguméʿ
}

// Amharic month names (1-indexed, index 0 unused)
const MONTH_NAMES = [
  "",
  "መስከረም",  // Mäskäräm  (September)
  "ጥቅምት",   // Ṭəqəmt     (October)
  "ኅዳር",    // Ḫədar      (November)
  "ታኅሳስ",   // Taḫśaś     (December)
  "ጥር",     // Ṭərr       (January)
  "የካቲት",  // Yäkatit    (February)
  "መጋቢት",  // Mägabit    (March)
  "ሚያዝያ",  // Miyazya    (April)
  "ግንቦት",  // Gənbot     (May)
  "ሰኔ",    // Säné       (June)
  "ሐምሌ",   // Ḥamlé      (July)
  "ነሐሴ",   // Nähase     (August)
  "ጳጉሜ",   // Ṗaguméʿ    (intercalary)
];

// Ge'ez numeral symbols
const GEEZ_ONES = ["", "፩", "፪", "፫", "፬", "፭", "፮", "፯", "፰", "፱"];
const GEEZ_TENS = ["", "፲", "፳", "፴", "፵", "፶", "፷", "፸", "፹", "፺"];

function toGeezNumber(n: number): string {
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return (tens > 0 ? GEEZ_TENS[tens] : "") + (ones > 0 ? GEEZ_ONES[ones] : "");
}

export namespace EthiopianConverter {
  export function toEthiopianDate(date: NaiveDate): Option<EthiopianDate> {
    const jdn = Number(date.dse) + DSE_TO_JDN;

    let year = Math.floor((jdn - EPOCH_JDN) / 365.25) + 1;
    if (year < 1) return null;
    for (let i = 0; i < 3 && yearStartJDN(year + 1) <= jdn; i++) year++;
    for (let i = 0; i < 3 && yearStartJDN(year) > jdn; i++) year--;
    if (year < 1) return null;

    const yearStart = yearStartJDN(year);
    if (jdn < yearStart) return null;

    const dayOfYear = jdn - yearStart;
    const leap = isLeap(year);
    let cursor = 0;
    for (let m = 1; m <= 13; m++) {
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
    return toGeezNumber(day) || String(day);
  }

  /**
   * Display label: Amharic month name on day 1, Ge'ez numeral otherwise.
   * Returns null when outside the supported range.
   */
  export function labelFor(date: NaiveDate): Option<string> {
    const e = toEthiopianDate(date);
    if (!e) return null;
    if (e.day === 1) return formatMonth(e.month);
    return formatDay(e.day);
  }

  export function toCellData(date: NaiveDate): Option<CalendarCellData> {
    const e = toEthiopianDate(date);
    if (!e) return null;
    return { calYear: e.year, calMonth: e.month, calDay: e.day, label: labelFor(date) ?? "" };
  }
}
