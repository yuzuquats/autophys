/**
 * Utility for calculating visible row count in timeline layouts.
 *
 * Encapsulates the invariant:
 * - Collapsed: max(collapsedRows, pendingGhostRowIdx + 1) when ghost present
 * - Expanded: max(occupiedRows, pendingGhostRowIdx + 1) when ghost present
 */
export namespace RowHeightCalculator {
  export interface Config {
    /** Default rows when collapsed (typically 1) */
    collapsedRows: number;
    /** Maximum rows before hard limit */
    maxRows: number;
  }

  export interface State {
    /** Whether the row is expanded */
    expanded: boolean;
    /** Number of rows occupied by existing events */
    occupiedRows: number;
    /** Row index needed by pending ghost (null if no pending) */
    pendingGhostRowIdx: Option<number>;
  }

  /**
   * Calculate visible rows based on expansion state and pending ghost.
   *
   * @returns Number of rows to display
   */
  export function calculateVisibleRows(config: Config, state: State): number {
    if (state.expanded) {
      const expandedRows = Math.max(config.collapsedRows, state.occupiedRows);
      if (state.pendingGhostRowIdx != null && state.pendingGhostRowIdx >= expandedRows) {
        return Math.max(expandedRows + 1, state.pendingGhostRowIdx + 1);
      }
      return expandedRows;
    }

    // Collapsed: enough rows to show the ghost at its actual row index
    const baseRows = config.collapsedRows;
    if (state.pendingGhostRowIdx != null && state.pendingGhostRowIdx >= baseRows) {
      return Math.max(baseRows + 1, state.pendingGhostRowIdx + 1);
    }
    return baseRows;
  }

  /**
   * Check if pending ghost requires an extra row beyond collapsed rows.
   */
  export function pendingGhostNeedsExtraRow(
    config: Config,
    state: State,
  ): boolean {
    if (state.pendingGhostRowIdx == null) return false;
    return state.pendingGhostRowIdx >= config.collapsedRows;
  }

  /**
   * Check if there are overflow events (events beyond visible rows).
   */
  export function hasOverflow(config: Config, state: State): boolean {
    const visibleRows = calculateVisibleRows(config, state);
    return state.occupiedRows > visibleRows;
  }
}
