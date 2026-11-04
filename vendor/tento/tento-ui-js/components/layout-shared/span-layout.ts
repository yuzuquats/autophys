import { NaiveDate, Weekday, Ym1Like } from "@tento-chrono";

/**
 * Represents a positioned segment of an item in the monthly calendar grid.
 * Each item with a date range may span multiple week-rows, resulting in
 * multiple view model segments.
 */
export interface CalendarMonthRowViewModel<T> {
  /** Which week row (0-5) in the calendar grid */
  rowIndex: number;

  /** Start column (0-6, relative to startOfWeek) */
  startDayOfWeek: number;

  /** End column (0-6, inclusive, relative to startOfWeek) */
  endDayOfWeek: number;

  /** Reference to the source item */
  originalItem: T;

  /** True if this is the first segment of the event */
  isFirstSegment: boolean;

  /** True if this is the last segment of the event */
  isLastSegment: boolean;

  /** True if event starts before the month view */
  isClippedStart: boolean;

  /** True if event ends after the month view */
  isClippedEnd: boolean;
}

/**
 * Type constraint for items that can be converted to row view models.
 * Items must have a `range` property of type NaiveDate.Range.
 */
export type RangedItem = {
  range: NaiveDate.Range;
  /** Hint for layout algorithm - try to place in this lane if available */
  preferredLane?: number;
};

/**
 * A segment with its assigned lane from greedy stacking.
 */
export interface PositionedSegment<T extends RangedItem> {
  segment: CalendarMonthRowViewModel<T>;
  lane: number;
}

/**
 * Result of span layout computation containing both lane counts and positioned segments.
 */
export interface SpanLayoutResult<T extends RangedItem> {
  laneCounts: number[];
  positionedSegments: PositionedSegment<T>[];
}

/**
 * Converts a list of items with date ranges into positioned segments
 * for rendering in a monthly calendar grid.
 *
 * @param items - Array of items with NaiveDate.Range
 * @param month - The month to display (Ym1Like)
 * @param startOfWeek - First day of the week (default: Sunday)
 * @returns Array of view model segments, one per week-row per item
 */
export function convertToRowViewModels<T extends RangedItem>(
  items: T[],
  month: Ym1Like,
  startOfWeek: Weekday = Weekday.SUN,
): CalendarMonthRowViewModel<T>[] {
  const gridDates = calculateGridDates(month, startOfWeek);
  const results: CalendarMonthRowViewModel<T>[] = [];

  for (const item of items) {
    const segments = convertItemToSegments(item, gridDates);
    results.push(...segments);
  }

  return results;
}

/**
 * Converts a single item into one or more week-row segments.
 *
 * @param item - Item with NaiveDate.Range
 * @param gridDates - Array of dates in the calendar grid
 * @returns Array of view model segments for this item
 */
export function convertItemToSegments<T extends RangedItem>(
  item: T,
  gridDates: NaiveDate[],
): CalendarMonthRowViewModel<T>[] {
  // Step 1: Find start/end indices in grid using DSE for comparison
  const startIndex = findDateIndex(gridDates, item.range.start);
  const endIndex = findDateIndex(gridDates, item.range.end);

  // Step 2: Handle complete miss (event outside grid)
  if (endIndex < 0 || startIndex >= gridDates.length) {
    return []; // Event completely outside view
  }

  // Step 3: Clamp to grid bounds
  const clippedStart = startIndex < 0;
  const clippedEnd = endIndex >= gridDates.length;
  const actualStartIndex = Math.max(0, startIndex);
  const actualEndIndex = Math.min(gridDates.length - 1, endIndex);

  // Step 4: Split into week-row segments
  const segments: CalendarMonthRowViewModel<T>[] = [];
  let currentIndex = actualStartIndex;

  while (currentIndex <= actualEndIndex) {
    const rowIndex = Math.floor(currentIndex / 7);
    const startDayOfWeek = currentIndex % 7;

    // Find end of this segment (either end of week or end of event)
    const rowEndIndex = Math.min(
      (rowIndex + 1) * 7 - 1, // Last cell in this row
      actualEndIndex, // Or event end
    );
    const endDayOfWeek = rowEndIndex % 7;

    segments.push({
      rowIndex,
      startDayOfWeek,
      endDayOfWeek,
      originalItem: item,
      isFirstSegment: currentIndex === actualStartIndex,
      isLastSegment: rowEndIndex === actualEndIndex,
      isClippedStart: clippedStart && currentIndex === actualStartIndex,
      isClippedEnd: clippedEnd && rowEndIndex === actualEndIndex,
    });

    currentIndex = rowEndIndex + 1;
  }

  return segments;
}

/**
 * Finds the index of a target date within the grid dates array.
 * Grid dates are contiguous consecutive days, so index is calculated directly.
 *
 * @param gridDates - Array of dates in the calendar grid
 * @param targetDate - Date to find
 * @returns Index of the date, or -1 if before grid, or gridDates.length if after grid
 */
export function findDateIndex(
  gridDates: NaiveDate[],
  targetDate: NaiveDate,
): number {
  if (gridDates.length === 0) return -1;

  const offset = targetDate.dse - gridDates[0].dse;

  if (offset < 0) return -1;
  if (offset >= gridDates.length) return gridDates.length;

  return offset;
}

/**
 * Calculates the grid dates for a given month and start-of-week.
 * Returns 42 dates (6 weeks × 7 days), including padding days from
 * previous and next months.
 *
 * This duplicates the logic from CalendarMonth.calculateGridDates()
 * to allow standalone usage without a CalendarMonth instance.
 *
 * @param month - The month to display (Ym1Like)
 * @param startOfWeek - First day of the week (default: Sunday)
 * @returns Array of 42 NaiveDate objects representing the grid
 */
export function calculateGridDates(
  month: Ym1Like,
  startOfWeek: Weekday = Weekday.SUN,
): NaiveDate[] {
  const dates: NaiveDate[] = [];

  // Get first day of the month
  const firstDayResult = NaiveDate.fromYmd1(month.yr, month.mth, 1);
  if (firstDayResult.isErr) {
    console.error("Invalid month:", month);
    return [];
  }
  const firstDay = firstDayResult.asOk()!;

  // Calculate padding at start
  const firstDayWeekday = firstDay.dayOfWeek;
  const startPadding = calculateStartPadding(firstDayWeekday, startOfWeek);

  // Add padding days from previous month
  for (let i = startPadding; i > 0; i--) {
    dates.push(firstDay.addDays(-i));
  }

  // Add all days of current month
  for (let day = 1; day <= 31; ++day) {
    const dt = NaiveDate.fromYmd1(month.yr, month.mth, day);
    if (dt.isErr) continue;
    dates.push(dt.asOk()!);
  }

  // Calculate padding at end to complete the grid (6 weeks = 42 days)
  // This must match CalendarMonth.calculateGridDates() which always uses 42 cells
  const totalCells = 42;
  const endPadding = totalCells - dates.length;

  // Add padding days from next month
  if (endPadding > 0) {
    const lastDay = dates[dates.length - 1];
    for (let i = 1; i <= endPadding; i++) {
      dates.push(lastDay.addDays(i));
    }
  }

  return dates;
}

/**
 * Calculates how many padding days are needed at the start of the month
 * grid based on the start-of-week configuration.
 *
 * @param firstDayWeekday - The weekday of the first day of the month
 * @param startOfWeek - The configured start of week
 * @returns Number of padding days needed
 */
function calculateStartPadding(
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
 * Computes span layout including both lane counts and positioned segments.
 * Uses greedy stacking per week to assign each span segment to the lowest available lane.
 *
 * @param items - Array of items with NaiveDate.Range
 * @param month - The month to display (Ym1Like)
 * @param startOfWeek - First day of the week (default: Sunday)
 * @returns SpanLayoutResult containing lane counts and positioned segments
 */
export function computeSpanLayout<T extends RangedItem>(
  items: readonly T[],
  month: Ym1Like,
  startOfWeek: Weekday = Weekday.SUN,
): SpanLayoutResult<T> {
  const gridDates = calculateGridDates(month, startOfWeek);

  // Convert items to segments (inline to avoid duplicate calculateGridDates)
  const segments: CalendarMonthRowViewModel<T>[] = [];
  for (const item of items) {
    segments.push(...convertItemToSegments(item, gridDates));
  }

  // Group segments by row
  const segmentsByRow: Map<number, CalendarMonthRowViewModel<T>[]> = new Map();
  for (const seg of segments) {
    const existing = segmentsByRow.get(seg.rowIndex) ?? [];
    existing.push(seg);
    segmentsByRow.set(seg.rowIndex, existing);
  }

  // Initialize lane counts to 0
  const laneCounts = new Array(gridDates.length).fill(0);
  const positionedSegments: PositionedSegment<T>[] = [];

  // For each row, greedily assign lanes
  for (const [rowIndex, rowSegments] of segmentsByRow) {
    // Track rightmost end position per lane (-1 = empty)
    const laneEnds: number[] = [];

    // Sort by start position for consistent assignment
    rowSegments.sort((a, b) => a.startDayOfWeek - b.startDayOfWeek);

    for (const seg of rowSegments) {
      let assignedLane: number;

      // Check if this segment has a preferred lane and it's available
      const preferredLane = seg.originalItem.preferredLane;
      if (preferredLane != null) {
        const laneAvailable =
          preferredLane >= laneEnds.length ||
          seg.startDayOfWeek > laneEnds[preferredLane];

        if (laneAvailable) {
          assignedLane = preferredLane;
          // Ensure laneEnds array is long enough
          while (laneEnds.length <= preferredLane) {
            laneEnds.push(-1);
          }
        } else {
          // Fall back to first-fit
          assignedLane = laneEnds.findIndex(
            (end) => seg.startDayOfWeek > end,
          );
          if (assignedLane === -1) {
            assignedLane = laneEnds.length;
            laneEnds.push(-1);
          }
        }
      } else {
        // Normal first-fit assignment
        assignedLane = laneEnds.findIndex(
          (end) => seg.startDayOfWeek > end,
        );
        if (assignedLane === -1) {
          assignedLane = laneEnds.length;
          laneEnds.push(-1);
        }
      }

      laneEnds[assignedLane] = seg.endDayOfWeek;

      positionedSegments.push({
        segment: seg,
        lane: assignedLane,
      });

      // Update lane counts for each cell this segment covers
      for (let dow = seg.startDayOfWeek; dow <= seg.endDayOfWeek; dow++) {
        const cellIndex = rowIndex * 7 + dow;
        laneCounts[cellIndex] = Math.max(
          laneCounts[cellIndex],
          assignedLane + 1,
        );
      }
    }
  }

  return { laneCounts, positionedSegments };
}
