import { Table } from "./table";

export const MIN_COLUMN_WIDTH = 20;

export interface WidthDistributionResult {
  widths: Map<string, number>;
  positions: Map<string, number>;
  viewportWidth: number;
}

export interface ColumnWidthInput {
  id: string;
  minWidth?: number;
  width?: number;
  flexGrow?: number;
  primary?: boolean;
}

export namespace TableUtils {
  /**
   * Resolves a single column's width based on priority:
   * 1. Resize request (user-dragged width)
   * 2. Explicit spec width
   * 3. Natural (measured) width
   */
  export function resolveColumnWidth(
    columnId: string,
    resizeRequests: Map<string, Table.ResizeRequest>,
    specWidth: Option<number>,
    naturalWidth: number,
    minWidth: Option<number>,
  ): number {
    let width: number;

    const resizeRequest = resizeRequests.get(columnId);
    if (resizeRequest) {
      width = resizeRequest.targetWidth;
    } else if (specWidth != null) {
      width = specWidth;
    } else {
      width = naturalWidth;
    }

    if (minWidth != null) {
      width = Math.max(minWidth, width);
    }

    return width;
  }

  /**
   * Calculates x positions for each column based on accumulated widths.
   */
  export function calculatePositionsFromWidths(
    orderedColumnIds: string[],
    widths: Map<string, number>,
  ): Map<string, number> {
    const positions = new Map<string, number>();
    let xPos = 0;

    for (const columnId of orderedColumnIds) {
      positions.set(columnId, xPos);
      xPos += widths.get(columnId) ?? 0;
    }

    return positions;
  }

  /**
   * Calculates how much each column can shrink (current width - min width).
   */
  export function calculateShrinkableSpace(
    columnIds: string[],
    currentWidths: Map<string, number>,
    minColumnWidth: number = MIN_COLUMN_WIDTH,
  ): { shrinkableByCol: Map<string, number>; totalShrinkable: number } {
    const shrinkableByCol = new Map<string, number>();
    let totalShrinkable = 0;

    for (const columnId of columnIds) {
      const currentWidth = currentWidths.get(columnId) ?? 0;
      const shrinkable = Math.max(0, currentWidth - minColumnWidth);
      shrinkableByCol.set(columnId, shrinkable);
      totalShrinkable += shrinkable;
    }

    return { shrinkableByCol, totalShrinkable };
  }

  /**
   * Distributes remaining space to flex-grow columns proportionally.
   */
  export function distributeFlexGrow(
    columns: ColumnWidthInput[],
    widths: Map<string, number>,
    resizeRequests: Map<string, Table.ResizeRequest>,
    remaining: number,
    totalFlexGrow: number,
  ): void {
    if (remaining <= 0 || totalFlexGrow <= 0) return;

    for (const col of columns) {
      const hasResizeRequest = resizeRequests.has(col.id);
      const hasExplicitWidth = col.width != null;
      const isFlexible = col.flexGrow != null || col.primary;

      if (!hasResizeRequest && !hasExplicitWidth && isFlexible) {
        const currentWidth = widths.get(col.id) ?? 0;
        const flexGrowValue = col.flexGrow ?? 1;
        const extraWidth = (remaining * flexGrowValue) / totalFlexGrow;
        const rounded = Math.round((currentWidth + extraWidth) * 10) / 10;
        widths.set(col.id, rounded);
      }
    }
  }

  /**
   * Calculates column widths for inline layout mode.
   * In inline mode, columns use their natural/specified widths without flex distribution.
   */
  export function calculateWidthDistributionInline(
    columns: ColumnWidthInput[],
    resizeRequests: Map<string, Table.ResizeRequest>,
    minViewportWidth: number,
    availableWidth: number,
    naturalWidths: Map<string, number>,
  ): WidthDistributionResult {
    const widths = new Map<string, number>();

    for (const col of columns) {
      const width = resolveColumnWidth(
        col.id,
        resizeRequests,
        col.width,
        naturalWidths.get(col.id) ?? 0,
        col.minWidth,
      );
      widths.set(col.id, width);
    }

    const columnIds = columns.map((c) => c.id);
    const positions = calculatePositionsFromWidths(columnIds, widths);

    return {
      widths,
      positions,
      viewportWidth: Math.max(availableWidth, minViewportWidth),
    };
  }

  /**
   * Calculates column widths for default layout mode.
   * In default mode, remaining space is distributed to flex-grow columns.
   */
  export function calculateWidthDistributionDefault(
    columns: ColumnWidthInput[],
    resizeRequests: Map<string, Table.ResizeRequest>,
    minViewportWidth: number,
    availableWidth: number,
    naturalWidths: Map<string, number>,
    cellPadding: number,
  ): WidthDistributionResult {
    const widths = new Map<string, number>();
    let totalFixedWidth = 0;
    let totalFlexGrow = 0;

    // First pass: resolve base widths and calculate flex totals
    for (const col of columns) {
      const width = resolveColumnWidth(
        col.id,
        resizeRequests,
        col.width ? col.width + cellPadding * 2 : null,
        naturalWidths.get(col.id) ?? 0,
        col.minWidth,
      );
      widths.set(col.id, width);
      totalFixedWidth += width;

      // Track flex-grow for columns without explicit width or resize request
      const hasResizeRequest = resizeRequests.has(col.id);
      const hasExplicitWidth = col.width != null;
      if (!hasResizeRequest && !hasExplicitWidth) {
        if (col.flexGrow != null || col.primary) {
          totalFlexGrow += col.flexGrow ?? 1;
        }
      }
    }

    // Distribute remaining space to flex-grow columns
    const targetWidth = Math.max(availableWidth, minViewportWidth);
    const remaining = targetWidth - totalFixedWidth;

    if (availableWidth > 0) {
      distributeFlexGrow(
        columns,
        widths,
        resizeRequests,
        remaining,
        totalFlexGrow,
      );
    }

    // Calculate positions
    const columnIds = columns.map((c) => c.id);
    const positions = calculatePositionsFromWidths(columnIds, widths);

    // viewportWidth is sum of column widths
    let viewportWidth = 0;
    for (const w of widths.values()) {
      viewportWidth += w;
    }

    return {
      widths,
      positions,
      viewportWidth,
    };
  }

  /**
   * Builds resize requests to shrink columns proportionally based on their shrinkable space.
   */
  export function buildResizeRequestsToShrink(
    columnIds: string[],
    currentWidths: Map<string, number>,
    delta: number,
  ): Table.ResizeRequest[] {
    const { shrinkableByCol, totalShrinkable } = calculateShrinkableSpace(
      columnIds,
      currentWidths,
    );

    if (totalShrinkable <= 0) return [];

    const resizeRequests: Table.ResizeRequest[] = [];
    const shrinkAmount = Math.min(Math.abs(delta), totalShrinkable);

    for (const columnId of columnIds) {
      const shrinkable = shrinkableByCol.get(columnId) ?? 0;
      const proportion = shrinkable / totalShrinkable;
      const colShrink = Math.min(shrinkable, proportion * shrinkAmount);
      const currentWidth = currentWidths.get(columnId) ?? 0;
      const newWidth = currentWidth - colShrink;

      resizeRequests.push({
        columnId,
        delta: -colShrink,
        targetWidth: newWidth,
        source: "auto",
      });
    }

    return resizeRequests;
  }

  /**
   * Scales all resize request target widths by a factor.
   * Used when growing the table to maintain column proportions.
   */
  export function scaleResizeRequests(
    requests: Table.ResizeRequest[],
    scale: number,
  ): void {
    for (const req of requests) {
      req.targetWidth = req.targetWidth * scale;
    }
  }
}
