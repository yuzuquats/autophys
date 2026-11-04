import { NaiveDate, Weekday, Ym1Like } from "@tento-chrono";

/**
 * Pure utility functions for calendar month date calculations.
 * These functions are stateless and can be tested without DOM or component dependencies.
 */

/**
 * Calculate how many padding days are needed at the start of the month grid.
 *
 * @param firstDayWeekday - The weekday of the first day of the month
 * @param startOfWeek - The configured start of week
 * @returns Number of padding days needed (0-6)
 */
export function calculateStartPadding(
  firstDayWeekday: Weekday,
  startOfWeek: Weekday,
): number {
  const startOfWeekValue = startOfWeek.dow;
  const firstDayValue = firstDayWeekday.dow;

  let padding = firstDayValue - startOfWeekValue;
  if (padding < 0) {
    padding += 7;
  }

  return padding;
}

/**
 * Get the grid start date (first cell of the calendar view).
 * This is the first day of the week containing the first of the month.
 *
 * @param displayMonth - The month to display (Ym1Like)
 * @param startOfWeek - First day of the week (default: Sunday)
 * @returns The first date in the grid, or null if invalid month
 */
export function computeGridStart(
  displayMonth: Ym1Like,
  startOfWeek: Weekday = Weekday.SUN,
): Option<NaiveDate> {
  const firstDayResult = NaiveDate.fromYmd1(displayMonth.yr, displayMonth.mth, 1);
  if (firstDayResult.isErr) {
    return null;
  }
  const firstDay = firstDayResult.asOk()!;
  const padding = calculateStartPadding(firstDay.dayOfWeek, startOfWeek);
  return firstDay.addDays(-padding);
}

/**
 * Get all dates in a calendar month grid.
 *
 * @param gridStart - First date in the grid
 * @param numRows - Number of weeks to display (typically 5 or 6)
 * @returns Array of NaiveDate objects
 */
export function getGridDates(gridStart: NaiveDate, numRows: number): NaiveDate[] {
  const totalCells = numRows * 7;
  const dates: NaiveDate[] = [];
  for (let i = 0; i < totalCells; i++) {
    dates.push(gridStart.addDays(i));
  }
  return dates;
}

/**
 * Check if date falls within the display month.
 *
 * @param date - Date to check
 * @param displayMonth - The display month (Ym1Like)
 * @returns True if the date is in the display month
 */
export function isInDisplayMonth(
  date: NaiveDate,
  displayMonth: Ym1Like,
): boolean {
  return date.yr === displayMonth.yr && date.mth === displayMonth.mth;
}

/**
 * Get week row index for a date within the grid.
 *
 * @param date - Date to find row for
 * @param gridStart - First date in the grid
 * @returns Row index (0-based), or -1 if before grid
 */
export function getRowForDate(date: NaiveDate, gridStart: NaiveDate): number {
  const dayOffset = date.dse - gridStart.dse;
  if (dayOffset < 0) return -1;
  return Math.floor(dayOffset / 7);
}

/**
 * Get day-of-week column index for a date within the grid.
 *
 * @param date - Date to find column for
 * @param gridStart - First date in the grid
 * @returns Column index (0-6), or -1 if before grid
 */
export function getDayOfWeekForDate(date: NaiveDate, gridStart: NaiveDate): number {
  const dayOffset = date.dse - gridStart.dse;
  if (dayOffset < 0) return -1;
  return dayOffset % 7;
}

/**
 * Get the cell index for a date within the grid.
 *
 * @param date - Date to find index for
 * @param gridStart - First date in the grid
 * @returns Cell index (0-based), or -1 if before grid
 */
export function getCellIndexForDate(date: NaiveDate, gridStart: NaiveDate): number {
  const dayOffset = date.dse - gridStart.dse;
  if (dayOffset < 0) return -1;
  return dayOffset;
}

/**
 * Clamp a date range to visible grid bounds.
 *
 * @param range - Range to clamp
 * @param gridStart - First date in the grid
 * @param gridEnd - Last date in the grid
 * @returns Clamped range, or null if completely outside grid
 */
export function clampRangeToGrid(
  range: NaiveDate.Range,
  gridStart: NaiveDate,
  gridEnd: NaiveDate,
): Option<NaiveDate.Range> {
  // Check if completely outside
  if (range.end.dse < gridStart.dse || range.start.dse > gridEnd.dse) {
    return null;
  }

  const clampedStart = range.start.dse < gridStart.dse ? gridStart : range.start;
  const clampedEnd = range.end.dse > gridEnd.dse ? gridEnd : range.end;

  return new NaiveDate.Range(clampedStart, clampedEnd);
}

/**
 * Check if a date is today.
 *
 * @param date - Date to check
 * @param today - Today's date
 * @returns True if date equals today
 */
export function isToday(date: NaiveDate, today: NaiveDate): boolean {
  return date.dse === today.dse;
}

/**
 * Get the date at a specific cell position in the grid.
 *
 * @param gridStart - First date in the grid
 * @param row - Row index (0-based)
 * @param dayOfWeek - Day of week column (0-6)
 * @returns Date at that position
 */
export function getDateAtPosition(
  gridStart: NaiveDate,
  row: number,
  dayOfWeek: number,
): NaiveDate {
  const cellIndex = row * 7 + dayOfWeek;
  return gridStart.addDays(cellIndex);
}

/**
 * Calculate grid dates for a given month, including padding from adjacent months.
 * Returns 42 dates (6 weeks × 7 days) for standard month view.
 *
 * This is a convenience function combining computeGridStart and getGridDates.
 *
 * @param month - The month to display (Ym1Like)
 * @param startOfWeek - First day of the week (default: Sunday)
 * @param numRows - Number of weeks to display (default: 6)
 * @returns Array of NaiveDate objects, or empty array if invalid month
 */
export function calculateGridDatesForMonth(
  month: Ym1Like,
  startOfWeek: Weekday = Weekday.SUN,
  numRows: number = 6,
): NaiveDate[] {
  const gridStart = computeGridStart(month, startOfWeek);
  if (!gridStart) {
    return [];
  }
  return getGridDates(gridStart, numRows);
}

/**
 * Get the last date in the grid.
 *
 * @param gridStart - First date in the grid
 * @param numRows - Number of weeks in the grid
 * @returns Last date in the grid
 */
export function getGridEnd(gridStart: NaiveDate, numRows: number): NaiveDate {
  const totalCells = numRows * 7;
  return gridStart.addDays(totalCells - 1);
}

/**
 * Check if a range overlaps with the grid.
 *
 * @param range - Range to check
 * @param gridStart - First date in the grid
 * @param gridEnd - Last date in the grid
 * @returns True if range overlaps with grid
 */
export function rangeOverlapsGrid(
  range: NaiveDate.Range,
  gridStart: NaiveDate,
  gridEnd: NaiveDate,
): boolean {
  return range.start.dse <= gridEnd.dse && range.end.dse >= gridStart.dse;
}

/**
 * Get the number of days in a range (inclusive).
 *
 * @param range - The date range
 * @returns Number of days (minimum 1 for single-day range)
 */
export function getRangeDurationDays(range: NaiveDate.Range): number {
  return range.end.dse - range.start.dse + 1;
}
