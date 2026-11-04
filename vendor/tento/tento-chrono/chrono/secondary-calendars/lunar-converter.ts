import { NaiveDate } from "../naive-date.ts";
import type { CalendarCellData } from "./calendar-cell-data.ts";
import type { Option } from "../option.ts";

export type LunarDate = {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
};

/**
 * Chinese lunisolar calendar lookup table.
 *
 * Data source: Hong Kong Observatory official Gregorian-Lunar Calendar Conversion
 * Tables (hko.gov.hk), cross-checked against published Chinese government calendars.
 *
 * Each entry: [cnyMonth, cnyDay, leapAfter, monthsString]
 *   cnyMonth:    Gregorian month of Chinese New Year (1 or 2)
 *   cnyDay:      Gregorian day of Chinese New Year (1–31)
 *   leapAfter:   0 = no leap month; N = leap month occurs after month N
 *   monthsString: '1' = 30-day (big) month, '0' = 29-day (small) month.
 *                 12 or 13 characters in chronological order (leap month
 *                 is inserted at position leapAfter, 0-indexed).
 */
const START_YEAR = 2000;
// prettier-ignore
const TABLE: [number, number, number, string][] = [
  [2,  5, 0,  "110010010110"],   // 2000
  [1, 24, 4,  "1101010010101"],  // 2001
  [2, 12, 0,  "110101001010"],   // 2002
  [2,  1, 0,  "110110100101"],   // 2003
  [1, 22, 2,  "0101101010101"],  // 2004
  [2,  9, 0,  "010101101010"],   // 2005
  [1, 29, 7,  "1010101011011"],  // 2006
  [2, 18, 0,  "001001011101"],   // 2007
  [2,  7, 0,  "100100101101"],   // 2008
  [1, 26, 5,  "1100100101011"],  // 2009
  [2, 14, 0,  "101010010101"],   // 2010
  [2,  3, 0,  "101101001010"],   // 2011
  [1, 23, 4,  "1011010101010"],  // 2012
  [2, 10, 0,  "101011010101"],   // 2013
  [1, 31, 9,  "0101010110101"],  // 2014
  [2, 19, 0,  "010010111010"],   // 2015
  [2,  8, 0,  "101001011011"],   // 2016
  [1, 28, 6,  "0101001010111"],  // 2017
  [2, 16, 0,  "010100101011"],   // 2018
  [2,  5, 0,  "101010010011"],   // 2019
  [1, 25, 4,  "0111010010101"],  // 2020
  [2, 12, 0,  "011010101010"],   // 2021
  [2,  1, 0,  "101011010101"],   // 2022
  [1, 22, 2,  "0100110110101"],  // 2023
  [2, 10, 0,  "010010110110"],   // 2024
  [1, 29, 6,  "1010010101110"],  // 2025
  [2, 17, 0,  "101001001110"],   // 2026
  [2,  6, 0,  "110100100110"],   // 2027
  [1, 26, 5,  "1110100100110"],  // 2028
  [2, 13, 0,  "110101010011"],   // 2029
  [2,  3, 0,  "010110101010"],   // 2030
  [1, 23, 3,  "0110101101010"],  // 2031
  [2, 11, 0,  "100101101101"],   // 2032
  [1, 31, 11, "0100101011101"],  // 2033
  [2, 19, 0,  "010010101101"],   // 2034
  [2,  8, 0,  "101001001101"],   // 2035
  [1, 28, 6,  "1101001001011"],  // 2036
  [2, 15, 0,  "110100100101"],   // 2037
  [2,  4, 0,  "110101010010"],   // 2038
  [1, 24, 5,  "1101101010100"],  // 2039
  [2, 12, 0,  "101101011010"],   // 2040
];

const DAY_NAMES = [
  "",
  "初一",
  "初二",
  "初三",
  "初四",
  "初五",
  "初六",
  "初七",
  "初八",
  "初九",
  "初十",
  "十一",
  "十二",
  "十三",
  "十四",
  "十五",
  "十六",
  "十七",
  "十八",
  "十九",
  "二十",
  "廿一",
  "廿二",
  "廿三",
  "廿四",
  "廿五",
  "廿六",
  "廿七",
  "廿八",
  "廿九",
  "三十",
];
const MONTH_NAMES = [
  "", "正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月",
];
const LEAP_MONTH_PREFIX = "闰";

export namespace LunarConverter {
  /**
   * Convert a Gregorian NaiveDate to a Chinese lunar date.
   * Returns null when the date is outside the table range (before 2000 or after 2040).
   */
  export function toLunarDate(date: NaiveDate): Option<LunarDate> {
    for (const gregYear of [date.yr, date.yr - 1]) {
      const result = decodeYear(gregYear, date);
      if (result) return result;
    }
    return null;
  }

  function decodeYear(gregYear: number, date: NaiveDate): Option<LunarDate> {
    const idx = gregYear - START_YEAR;
    if (idx < 0 || idx >= TABLE.length) return null;

    const [cnyMonth, cnyDay, leapAfter, bits] = TABLE[idx];
    const cny = NaiveDate.fromYmd1Exp(gregYear, cnyMonth, cnyDay);

    const dateDse = Number(date.dse);
    const cnyDse = Number(cny.dse);

    if (dateDse < cnyDse) return null;

    let cursor = cnyDse;
    const numMonths = bits.length;

    for (let i = 0; i < numMonths; i++) {
      const monthLen = bits[i] === "1" ? 30 : 29;

      if (dateDse < cursor + monthLen) {
        const day = dateDse - cursor + 1;
        let month: number;
        let isLeap: boolean;

        if (leapAfter === 0 || i < leapAfter) {
          month = i + 1;
          isLeap = false;
        } else if (i === leapAfter) {
          month = leapAfter;
          isLeap = true;
        } else {
          month = i;
          isLeap = false;
        }

        return { year: gregYear, month, day, isLeap };
      }

      cursor += monthLen;
    }

    return null;
  }

  /**
   * Format a lunar day as a Chinese ordinal string.
   * Uses canonical Chinese lunar day labels:
   * 初一…初十, 十一…十九, 二十, 廿一…廿九, 三十.
   */
  export function formatDay(day: number): string {
    return DAY_NAMES[day] ?? String(day);
  }

  /**
   * Format a lunar month as its Chinese name.
   * Month 1 → 正月, months 2–12 → 二月…十二月, leap months → 闰X月.
   */
  export function formatMonth(month: number, isLeap: boolean): string {
    const base = MONTH_NAMES[month] ?? String(month);
    return isLeap ? LEAP_MONTH_PREFIX + base : base;
  }

  /**
   * Get the display label for a date.
   * Returns the month name on day 1 of a lunar month, ordinal otherwise.
   * Returns null when the date is outside the table range.
   */
  export function labelFor(date: NaiveDate): Option<string> {
    const lunar = toLunarDate(date);
    if (!lunar) return null;
    if (lunar.day === 1) return formatMonth(lunar.month, lunar.isLeap);
    return formatDay(lunar.day);
  }

  export function toCellData(date: NaiveDate): Option<CalendarCellData> {
    const lunar = toLunarDate(date);
    if (!lunar) return null;
    return { calYear: lunar.year, calMonth: lunar.month, calDay: lunar.day, label: labelFor(date) ?? "" };
  }
}
