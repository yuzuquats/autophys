import { NaiveDate } from "@tento-chrono";

/**
 * Pure utility functions for calendar month gesture calculations.
 * These functions are stateless and can be tested without DOM or component dependencies.
 */

// --- Types ---

export type Point = { x: number; y: number };

export type ThresholdResult = {
  met: boolean;
  distance: number;
};

export type EdgeSwapResult = {
  newEdge: "start" | "end";
  swapped: boolean;
};

export type ResizedRangeResult = {
  range: NaiveDate.Range;
  finalEdge: "start" | "end";
  swapped: boolean;
};

// --- Pure Functions ---

/**
 * Check if movement exceeds drag threshold using Euclidean distance.
 *
 * @param start - Starting pointer position
 * @param current - Current pointer position
 * @param threshold - Distance threshold in pixels (typically 5)
 * @returns ThresholdResult with met flag and actual distance
 */
export function checkThreshold(
  start: Point,
  current: Point,
  threshold: number,
): ThresholdResult {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return {
    met: distance >= threshold,
    distance,
  };
}

/**
 * Determine if edges should swap during resize.
 * Swap occurs when dragging start edge past end, or end edge past start.
 *
 * @param originalRange - The original range before resize started
 * @param draggedEdge - Which edge is being dragged ("start" or "end")
 * @param currentDate - The date currently under the pointer
 * @returns EdgeSwapResult indicating if swap occurred and the new edge
 */
export function computeEdgeSwap(
  originalRange: NaiveDate.Range,
  draggedEdge: "start" | "end",
  currentDate: NaiveDate,
): EdgeSwapResult {
  if (draggedEdge === "start") {
    // Dragging start edge - swap if it goes past the end
    if (currentDate.dse > originalRange.end.dse) {
      return { newEdge: "end", swapped: true };
    }
  } else {
    // Dragging end edge - swap if it goes before the start
    if (currentDate.dse < originalRange.start.dse) {
      return { newEdge: "start", swapped: true };
    }
  }
  return { newEdge: draggedEdge, swapped: false };
}

/**
 * Compute new range after resize, handling edge swap.
 * When the dragged edge crosses the opposite edge, the edges swap
 * and the range is recalculated.
 *
 * @param originalRange - The original range before resize started
 * @param edge - Which edge is being dragged ("start" or "end")
 * @param daysDelta - Number of days the edge has moved (positive = forward)
 * @returns ResizedRangeResult with new range, final edge, and swap flag
 */
export function computeResizedRange(
  originalRange: NaiveDate.Range,
  edge: "start" | "end",
  daysDelta: number,
): ResizedRangeResult {
  let newStart = originalRange.start;
  let newEnd = originalRange.end;
  let finalEdge = edge;
  let swapped = false;

  if (edge === "start") {
    newStart = originalRange.start.addDays(daysDelta);
    // If start goes past end, swap edges
    if (newStart.dse > newEnd.dse) {
      const draggedPosition = newStart;
      newStart = newEnd.addDays(1);
      newEnd = draggedPosition;
      finalEdge = "end";
      swapped = true;
    }
  } else {
    newEnd = originalRange.end.addDays(daysDelta);
    // If end goes before start, swap edges
    if (newEnd.dse < newStart.dse) {
      const draggedPosition = newEnd;
      newEnd = newStart.addDays(-1);
      newStart = draggedPosition;
      finalEdge = "start";
      swapped = true;
    }
  }

  return {
    range: new NaiveDate.Range(newStart, newEnd),
    finalEdge,
    swapped,
  };
}

/**
 * Compute offset in days between two dates.
 *
 * @param from - Starting date
 * @param to - Ending date
 * @returns Number of days (positive if to > from, negative if to < from)
 */
export function computeOffsetDays(from: NaiveDate, to: NaiveDate): number {
  return to.differenceInDays(from);
}

/**
 * Apply day offset to a range, shifting both start and end.
 *
 * @param range - Original range
 * @param offsetDays - Number of days to shift (positive = forward)
 * @returns New range shifted by offsetDays
 */
export function offsetRange(
  range: NaiveDate.Range,
  offsetDays: number,
): NaiveDate.Range {
  return new NaiveDate.Range(
    range.start.addDays(offsetDays),
    range.end.addDays(offsetDays),
  );
}

/**
 * Normalize range so start <= end.
 * If end comes before start, swaps them.
 *
 * @param start - First date
 * @param end - Second date
 * @returns Range with dates in correct order
 */
export function normalizeRange(
  start: NaiveDate,
  end: NaiveDate,
): NaiveDate.Range {
  if (start.dse <= end.dse) {
    return new NaiveDate.Range(start, end);
  }
  return new NaiveDate.Range(end, start);
}

/**
 * Check if two dates are the same day.
 *
 * @param a - First date
 * @param b - Second date
 * @returns True if same day
 */
export function isSameDate(a: NaiveDate, b: NaiveDate): boolean {
  return a.dse === b.dse;
}

/**
 * Check if a range has changed (either start or end differs).
 *
 * @param original - Original range
 * @param updated - Updated range
 * @returns True if ranges differ
 */
export function rangeHasChanged(
  original: NaiveDate.Range,
  updated: NaiveDate.Range,
): boolean {
  return !isSameDate(original.start, updated.start) ||
    !isSameDate(original.end, updated.end);
}
