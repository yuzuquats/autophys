/**
 * Greedy column assignment for overlapping time ranges.
 *
 * Given N items with start/end times, assigns each to the leftmost column
 * where it doesn't overlap with existing items. Max 8 columns.
 *
 * Used by calendar day columns to position overlapping events.
 */

export namespace ColumnLayout {
  export type Input = {
    id: string;
    startMs: number;
    endMs: number;
  };

  export type Result = {
    numColumns: number;
    columnIndex: number;
    canExpand: boolean;
  };

  const MAX_COLUMNS = 8;

  function compareInputs(a: Input, b: Input): number {
    let result = a.startMs - b.startMs;
    if (result !== 0) return result;
    // End ascending (matches DurationTime.Range comparator)
    result = a.endMs - b.endMs;
    if (result !== 0) return result;
    return a.id.localeCompare(b.id);
  }

  /**
   * Assigns column indices to overlapping time ranges.
   *
   * Returns results in the same order as the sorted input (by start time,
   * then end ascending, then id). The caller can correlate via the
   * sorted order or by matching ids.
   *
   * @param events - Items with start/end times in milliseconds
   * @param expandThresholdMs - Minimum gap (ms) from previous column's start
   *   for an event to be "expandable" (visually wider). Default 15 minutes.
   * @returns Parallel array of column assignments, one per sorted event.
   *   Also returns the sorted input array for correlation.
   */
  export function compute(
    events: Input[],
    expandThresholdMs: number = 15 * 60_000,
  ): { sorted: Input[]; layouts: Result[] } {
    const sorted = [...events].sort(compareInputs);
    const layouts: Result[] = sorted.map(() => ({
      numColumns: 1,
      columnIndex: 0,
      canExpand: false,
    }));

    const columnIndices: number[] = Array(MAX_COLUMNS).fill(0);
    const columnEndTimes: Option<number>[] = Array(MAX_COLUMNS).fill(null);

    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i];
      const layout = layouts[i];

      for (let colIndex = 0; colIndex < MAX_COLUMNS; colIndex++) {
        // Skip column if it's occupied and overlaps with current event
        if (
          columnEndTimes[colIndex] != null &&
          ev.startMs < columnEndTimes[colIndex]!
        )
          continue;

        // Column is available, place event here
        const wasOccupied = columnEndTimes[colIndex] != null;
        columnEndTimes[colIndex] = ev.endMs;
        columnIndices[colIndex] = i;

        if (colIndex === 0 && wasOccupied) {
          // Special case: replacing first column event — reset all columns
          columnIndices.fill(0);
          columnIndices[0] = i;
          columnEndTimes.fill(null);
          columnEndTimes[0] = ev.endMs;
        } else {
          layout.columnIndex = colIndex;
          layout.numColumns = colIndex + 1;

          if (!wasOccupied) {
            // Update numColumns for all events in current group
            for (let j = colIndex; j >= 0; j--) {
              layouts[columnIndices[j]].numColumns = colIndex + 1;
            }
          }

          // Expand logic for non-first columns
          if (colIndex > 0) {
            const prevStart = sorted[columnIndices[colIndex - 1]].startMs;
            layout.canExpand = (ev.startMs - prevStart) > expandThresholdMs;
          }
        }

        break;
      }
    }

    return { sorted, layouts };
  }

  /**
   * Pixel rect for a cell given its layout result and time range.
   *
   * Matches the exact CSS from CalendarColumnCell + CalendarColumnLayoutGroup:
   * - left = x-offset
   * - width = containerWidth - x-offset + additionalWidth
   * - height = pxPerHour * durationMins/60 + additionalHeight
   * - y = pxPerHour * startTimeHrs
   */
  export type CellRect = {
    x: number;
    y: number;
    width: number;
    height: number;
    /** 1px solid border for overlapping cells (col > 0) */
    border: boolean;
    /** -1px margin-top for non-expandable overlapping cells */
    marginTop: number;
    /** 1px margin-right for non-expandable overlapping cells */
    marginRight: number;
  };

  export function cellRect(
    layout: Result,
    startTimeHrs: number,
    durationMins: number,
    containerWidthPx: number,
    pxPerHour: number = 48,
  ): CellRect {
    // Matches calendar-column-layout-group.ts lines 39-67
    if (layout.columnIndex === 0) {
      const xOffset = 3.5;
      const additionalHeight = -2;
      return {
        x: xOffset,
        y: pxPerHour * startTimeHrs,
        width: containerWidthPx - xOffset,
        height: pxPerHour * durationMins / 60 + additionalHeight,
        border: false,
        marginTop: 0,
        marginRight: 0,
      };
    }

    if (layout.canExpand) {
      const xOffset = 2.5 + layout.columnIndex * 5;
      const additionalHeight = -1;
      return {
        x: xOffset,
        y: pxPerHour * startTimeHrs,
        width: containerWidthPx - xOffset,
        height: pxPerHour * durationMins / 60 + additionalHeight,
        border: true,
        marginTop: 0,
        marginRight: 0,
      };
    }

    // Non-expandable: equal-width columns
    // CSS: calc((100% - 20px) / numColumns * columnIndex)
    const slotWidth = (containerWidthPx - 20) / layout.numColumns;
    const xOffset = slotWidth * layout.columnIndex;
    return {
      x: xOffset,
      y: pxPerHour * startTimeHrs - 1, // margin-top: -1px
      width: containerWidthPx - xOffset - 1, // margin-right: 1px
      height: pxPerHour * durationMins / 60,
      border: true,
      marginTop: -1,
      marginRight: 1,
    };
  }
}
