import { AVLTree } from "./avl-tree";
import { NumRangeLike } from "./range";
import { LiveData } from "./livedata";

/**
 * Generic layout manager for assigning items to non-overlapping rows.
 *
 * Uses interval trees for O(log n) conflict detection. Items are assigned
 * to the first row where their range doesn't overlap with existing items.
 *
 * Common use cases:
 * - All-day events in calendar (prevent visual overlap)
 * - Booking timelines with conflict prevention
 * - Gantt charts with task dependencies
 * - Resource allocation views
 *
 * @typeParam T - Item type (must have id and numeric range)
 * @typeParam ID - Identifier type (defaults to string)
 *
 * @example
 * ```typescript
 * interface Booking {
 *   id: string;
 *   range: { start: number; end: number };
 *   roomId: string;
 * }
 *
 * const layout = new RangeLayoutManager<Booking>(10);
 * for (const booking of bookings) {
 *   const row = layout.getRow(booking);
 *   if (row !== -1) {
 *     renderBooking(booking, row);
 *   } else {
 *     showOverflowIndicator(booking);
 *   }
 * }
 * ```
 */
/**
 * Canonical packing order for lane assignment.
 *
 * Lane assignment must be a function of the item SET, not of the order the
 * items happened to arrive — otherwise the same events pack one way on first
 * paint and another after a scroll, a provider sync, or a reload, and an event
 * displaced into a hidden lane never comes back when its blockers are deleted.
 * Sorting before placing makes the greedy first-fit walk deterministic.
 *
 * Earliest start first, then the longest span first, then by id as a stable
 * tiebreak. Longest-first is the calendar convention: a multi-day span takes
 * the top lane, so it stays a visible bar and the single-day events it covers
 * are the ones that collapse into the overflow indicator.
 */
function canonicalOrder<
  T extends Identifiable<ID> & AVLTree.HasNumRange,
  ID,
>(items: T[]): T[] {
  return items.slice().sort((a, b) => {
    if (a.range.start !== b.range.start) return a.range.start - b.range.start;
    const aLen = a.range.end - a.range.start;
    const bLen = b.range.end - b.range.start;
    if (aLen !== bLen) return bLen - aLen;
    return String(a.id).localeCompare(String(b.id));
  });
}

export class RangeLayoutManager<
  T extends Identifiable<ID> & AVLTree.HasNumRange,
  ID = string,
> {
  private rowIdxById: Map<ID, number> = new Map();
  private rows: AVLTree<AVLTree.Node.Many<ID, T>>[];
  private revealedIds: Set<ID> = new Set();
  private maxHeight: LiveData<number> = new LiveData(1);
  private expanded: boolean = false;
  private visibleRows: number = 1;
  // Items that couldn't fit in any row (getRow returned -1) — still show in overflow
  private unplacedById: Map<ID, T> = new Map();

  /**
   * Creates a new range layout manager.
   *
   * @param maxRows - Maximum number of rows before items overflow (default: 8)
   * @param defaultVisibleRows - Default number of visible rows (default: 1)
   */
  constructor(
    private maxRows: number = 8,
    private defaultVisibleRows: number = 1,
  ) {
    this.rows = Array.from({ length: maxRows }, () => new AVLTree());
    this.visibleRows = defaultVisibleRows;
  }

  /**
   * Replaces the laid-out set with `items`, repacking every lane from scratch.
   *
   * This is the entry point callers should use when they know the full current
   * set. Placement is cached per item id and `getRow` never revisits a cached
   * lane, so an incremental "remove what is gone, offer the rest" update leaves
   * survivors stranded in whatever lane the history put them in — an event
   * pushed to lane 1 by two neighbours stays there after both are deleted, and
   * with the strip collapsed to one lane it renders as overflow dots above an
   * empty lane. Repacking from the canonical order costs an O(n log n) sort on
   * a viewport's worth of items and makes the layout a function of the set.
   */
  update(items: T[]): void {
    this.clear();
    for (const item of canonicalOrder<T, ID>(items)) this.getRow(item);
  }

  /**
   * Assigns an item to the first available non-conflicting row.
   *
   * Algorithm:
   * 1. Check cache for existing assignment (O(1))
   * 2. For each row (up to maxRows):
   *    a. Query AVL tree for overlapping items (O(log n + k))
   *    b. If no overlaps, insert and cache assignment
   * 3. Return -1 if all rows are full
   *
   * @param item - Item to assign
   * @returns Row index (0 to maxRows-1), or -1 if overflow
   */
  getRow(item: T): number {
    // Check cache first
    const rowIdx = this.rowIdxById.get(item.id);
    if (rowIdx != null) return rowIdx;

    // Find first row without conflicts
    for (const [idx, row] of this.rows.entries()) {
      const existingItems = this.findOverlaps(row, item.range);
      if (existingItems.length > 0) continue;

      row.insert(new AVLTree.Node.Many([item]));
      this.rowIdxById.set(item.id, idx);
      this.unplacedById.delete(item.id);
      return idx;
    }

    // All rows full — track as unplaced so partition() includes it in overflow
    this.unplacedById.set(item.id, item);
    return -1;
  }

  /**
   * Calculates minimum rows needed to show all items in range.
   *
   * Useful for dynamic height calculation (expand/collapse UI).
   * Counts rows until finding an empty row, indicating all items are placed.
   *
   * @param range - Range to query
   * @returns Number of occupied rows (0 to maxRows)
   */
  minHeightForRange(range: NumRangeLike): number {
    let max = 0;
    for (const row of this.rows) {
      const existingItems = this.findOverlaps(row, range);
      if (existingItems.length === 0) return max;
      max += 1;
    }
    return max;
  }

  /**
   * Removes a specific item from layout.
   *
   * @param item - Item to remove
   */
  remove(item: T): void {
    this.unplacedById.delete(item.id);

    const rowIdx = this.rowIdxById.get(item.id);
    if (rowIdx == null) return;

    const row = this.rows[rowIdx];
    AVLTree.Node.Many.delete(row, item);
    this.rowIdxById.delete(item.id);
  }

  /**
   * Clears all items and resets cache.
   *
   * Call when data changes significantly (e.g., date range change).
   */
  clear(): void {
    this.rowIdxById.clear();
    this.rows.forEach((row) => row.clear());
    this.unplacedById.clear();
  }

  /**
   * Returns all items assigned to a specific row.
   *
   * @param rowIndex - Row to query (0 to maxRows-1)
   * @returns Items in that row, or empty array if invalid index
   */
  getItemsInRow(rowIndex: number): T[] {
    if (rowIndex < 0 || rowIndex >= this.maxRows) return [];
    const row = this.rows[rowIndex];
    if (!row.root) return [];

    const items: T[] = [];
    for (const node of row.dfs()) {
      items.push(...node.values);
    }
    return items;
  }

  /**
   * Partitions items into visible vs overflow based on available rows.
   *
   * This is the single source of truth for rendering - it tells you exactly
   * which items fit in the visible rows and which overflow and need indicators.
   *
   * Also updates the max height based on how many rows are actually occupied.
   *
   * @param visibleRows - Number of rows currently visible/expanded
   * @returns Object with visible items and overflow items grouped by range point
   */
  partition(visibleRows: number): RangeLayoutManager.PartitionResult<T> {
    const visible: Array<{ item: T; row: number }> = [];
    const overflow = new Map<number, T[]>();

    // Track the maximum row index that has items
    let maxOccupiedRow = 0;

    // Process items that got assigned to rows
    for (let rowIdx = 0; rowIdx < this.maxRows; rowIdx++) {
      const itemsInRow = this.getItemsInRow(rowIdx);

      if (itemsInRow.length > 0) {
        maxOccupiedRow = rowIdx + 1; // +1 because row index is 0-based
      }

      for (const item of itemsInRow) {
        if (rowIdx < visibleRows) {
          visible.push({ item, row: rowIdx });
        } else {
          // Group overflow items by each point in their range
          for (let point = item.range.start; point <= item.range.end; point++) {
            let items = overflow.get(point);
            if (!items) {
              items = [];
              overflow.set(point, items);
            }
            items.push(item);
          }
        }
      }
    }

    // Update max height based on occupied rows
    this.maxHeight.update(Math.max(1, maxOccupiedRow));

    // Include items that couldn't fit in any row — still show in overflow ("more dots")
    for (const item of this.unplacedById.values()) {
      for (let point = item.range.start; point <= item.range.end; point++) {
        let items = overflow.get(point);
        if (!items) {
          items = [];
          overflow.set(point, items);
        }
        items.push(item);
      }
    }

    return { visible, overflow };
  }

  /**
   * Gets all overflow items at a specific point in the range.
   *
   * Useful for querying overflow at a single date without computing full partition.
   *
   * @param point - The point in the range to query
   * @param visibleRows - Number of rows currently visible
   * @returns Items that overflow at this point
   */
  getOverflowAt(point: number, visibleRows: number): T[] {
    const result: T[] = [];

    for (let rowIdx = visibleRows; rowIdx < this.maxRows; rowIdx++) {
      const itemsInRow = this.getItemsInRow(rowIdx);
      for (const item of itemsInRow) {
        if (point >= item.range.start && point <= item.range.end) {
          result.push(item);
        }
      }
    }

    return result;
  }

  /**
   * Returns items that couldn't be placed in any row (getRow returned -1).
   * Used by updateLayoutState to ensure stale unplaced items are cleaned up
   * when they scroll out of the rendered range.
   */
  getUnplacedItems(): T[] {
    return [...this.unplacedById.values()];
  }

  /**
   * Marks a fixed child ID as revealed (rendered in the UI).
   *
   * Call this after successfully calling fixedChild.reveal() to track
   * which elements are currently visible.
   *
   * @param id - The ID of the revealed element
   */
  markRevealed(id: ID): void {
    this.revealedIds.add(id);
  }

  /**
   * Returns IDs that should be dismissed based on current partition.
   *
   * These are IDs that were previously revealed but are no longer
   * in the current visible or overflow sets.
   *
   * @param currentIds - Set of IDs that should currently be revealed
   * @returns Set of IDs to dismiss
   */
  getIdsToDismiss(currentIds: Set<ID>): Set<ID> {
    const toDismiss = new Set<ID>();

    for (const id of this.revealedIds) {
      if (!currentIds.has(id)) {
        toDismiss.add(id);
      }
    }

    return toDismiss;
  }

  /**
   * Removes an ID from the revealed tracking after dismissing.
   *
   * Call this after successfully dismissing a fixed child.
   *
   * @param id - The ID that was dismissed
   */
  markDismissed(id: ID): void {
    this.revealedIds.delete(id);
  }

  /**
   * Returns the LiveData for max height.
   *
   * This is automatically updated during partition() based on how many
   * rows are actually occupied by items.
   *
   * @returns LiveData that tracks the maximum number of rows needed
   */
  getMaxHeight(): LiveData<number> {
    return this.maxHeight;
  }

  /**
   * Sets the expanded state and updates visible rows accordingly.
   *
   * When expanded, visible rows is set to max height (all rows shown).
   * When collapsed, visible rows is set to default (typically 1).
   *
   * @param expanded - Whether the layout should be expanded
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    if (expanded) {
      // Show all occupied rows when expanded
      this.visibleRows = Math.max(this.defaultVisibleRows, this.maxHeight.get());
    } else {
      // Show only default rows when collapsed
      this.visibleRows = this.defaultVisibleRows;
    }
  }

  /**
   * Returns whether the layout is currently expanded.
   *
   * @returns True if expanded, false if collapsed
   */
  isExpanded(): boolean {
    return this.expanded;
  }

  /**
   * Returns the current number of visible rows.
   *
   * This is used for partition and layout calculations.
   *
   * @returns Number of visible rows
   */
  getVisibleRows(): number {
    return this.visibleRows;
  }

  /**
   * Finds the first available row for a range without inserting.
   *
   * This is a query-only method useful for ghost preview during gestures.
   * It tells you which row an item would be assigned to without modifying
   * the layout state.
   *
   * @param range - The range to check for conflicts
   * @returns Row index (0 to maxRows-1), or -1 if all rows are occupied
   */
  findAvailableRow(range: NumRangeLike): number {
    for (let rowIdx = 0; rowIdx < this.maxRows; rowIdx++) {
      const row = this.rows[rowIdx];
      const conflicts = this.findOverlaps(row, range);
      if (conflicts.length === 0) {
        return rowIdx;
      }
    }
    return -1;
  }

  private findOverlaps(
    row: AVLTree<AVLTree.Node.Many<ID, T>>,
    range: NumRangeLike,
  ): T[] {
    return row.root?.findAllOverlapsInclusiveEnd(range) ?? [];
  }
}

export namespace RangeLayoutManager {
  export interface PartitionResult<T> {
    visible: Array<{ item: T; row: number }>;
    overflow: Map<number, T[]>;
  }
}

// ── New declarative API ──────────────────────────────────────────────────────

export namespace RangeLayout {
  export interface Config<
    T extends Identifiable<ID> & AVLTree.HasNumRange,
    ID = string,
  > {
    maxRows: number;
    defaultVisibleRows: number;
    /** Returns the height in row units for an item. Default: 1. */
    getHeightUnits?(item: T): number;
  }

  export interface PartitionResult<T> {
    visible: Array<{ item: T; row: number; heightUnits: number }>;
    overflow: Map<number, T[]>;
  }

  /**
   * Pure data layer: AVL trees per row + assignment cache.
   * Supports multi-row height units: an item with heightUnits=2 occupies
   * two consecutive rows, preventing other items from conflicting in either.
   */
  export class State<
    T extends Identifiable<ID> & AVLTree.HasNumRange,
    ID = string,
  > {
    private rows: AVLTree<AVLTree.Node.Many<ID, T>>[];
    // Stores each item once keyed by ID; contains the placed item itself
    private assignmentById: Map<
      ID,
      { rowIdx: number; heightUnits: number; item: T }
    > = new Map();
    private unplacedById: Map<ID, T> = new Map();

    constructor(private readonly maxRows: number) {
      this.rows = Array.from({ length: maxRows }, () => new AVLTree());
    }

    /**
     * Places an item into the first block of `heightUnits` consecutive rows
     * that have no range conflicts. Inserts into all occupied rows so later
     * items see the full footprint.
     * Returns the starting row index, or -1 if no block fits.
     */
    place(item: T, heightUnits: number = 1): number {
      const existing = this.assignmentById.get(item.id);
      if (existing != null) return existing.rowIdx;

      const h = Math.max(1, heightUnits);
      outer: for (let startRow = 0; startRow <= this.maxRows - h; startRow++) {
        for (let offset = 0; offset < h; offset++) {
          if (this.findOverlaps(this.rows[startRow + offset], item.range).length > 0) {
            continue outer;
          }
        }
        for (let offset = 0; offset < h; offset++) {
          this.rows[startRow + offset].insert(new AVLTree.Node.Many([item]));
        }
        this.assignmentById.set(item.id, { rowIdx: startRow, heightUnits: h, item });
        this.unplacedById.delete(item.id);
        return startRow;
      }

      this.unplacedById.set(item.id, item);
      return -1;
    }

    remove(item: T): void {
      this.unplacedById.delete(item.id);
      const assignment = this.assignmentById.get(item.id);
      if (assignment == null) return;

      for (let offset = 0; offset < assignment.heightUnits; offset++) {
        AVLTree.Node.Many.delete(this.rows[assignment.rowIdx + offset], item);
      }
      this.assignmentById.delete(item.id);
    }

    /**
     * Finds the first available starting row for a range without modifying state.
     */
    findAvailableRow(range: NumRangeLike, heightUnits: number = 1): number {
      const h = Math.max(1, heightUnits);
      outer: for (let startRow = 0; startRow <= this.maxRows - h; startRow++) {
        for (let offset = 0; offset < h; offset++) {
          if (this.findOverlaps(this.rows[startRow + offset], range).length > 0) {
            continue outer;
          }
        }
        return startRow;
      }
      return -1;
    }

    getAllAssignments(): Array<{ item: T; rowIdx: number; heightUnits: number }> {
      const result: Array<{ item: T; rowIdx: number; heightUnits: number }> = [];
      for (const { item, rowIdx, heightUnits } of this.assignmentById.values()) {
        result.push({ item, rowIdx, heightUnits });
      }
      return result;
    }

    getUnplacedItems(): T[] {
      return [...this.unplacedById.values()];
    }

    clear(): void {
      this.assignmentById.clear();
      this.rows.forEach((row) => row.clear());
      this.unplacedById.clear();
    }

    private findOverlaps(
      row: AVLTree<AVLTree.Node.Many<ID, T>>,
      range: NumRangeLike,
    ): T[] {
      return row.root?.findAllOverlapsInclusiveEnd(range) ?? [];
    }
  }

  /**
   * Declarative layout manager: takes a list of items, drives diffing and
   * placement internally, and returns a partition of visible vs overflow items.
   *
   * Unlike the imperative `RangeLayoutManager`, callers just call `update(items)`
   * whenever the item set changes and then `partition()` to get the current layout.
   */
  export class Manager<
    T extends Identifiable<ID> & AVLTree.HasNumRange,
    ID = string,
  > {
    private readonly state: State<T, ID>;
    private readonly config: Config<T, ID>;
    private _expanded: boolean = false;
    private _visibleRows: number;
    private readonly _maxOccupiedRows: LiveData<number> = new LiveData(1);

    constructor(config: Config<T, ID>) {
      this.config = config;
      this.state = new State(config.maxRows);
      this._visibleRows = config.defaultVisibleRows;
    }

    /**
     * Declarative update: repacks every lane from the incoming list.
     *
     * Deliberately NOT an incremental diff. `State.place` caches a lane per
     * item id and returns the cached lane forever, so removing only what
     * vanished or moved leaves the survivors wherever the arrival history put
     * them: an item displaced into a hidden lane stays hidden after its
     * blockers are deleted, and the same set packs differently depending on
     * the order it arrived. Clearing and re-placing in `canonicalOrder` makes
     * the layout a function of the set, at the cost of an O(n log n) sort over
     * a viewport's worth of items.
     */
    update(items: T[]): void {
      this.state.clear();
      for (const item of canonicalOrder<T, ID>(items)) {
        const heightUnits = this.config.getHeightUnits?.(item) ?? 1;
        this.state.place(item, heightUnits);
      }
    }

    /**
     * Returns the current partition of visible vs overflow items.
     * Also updates `maxOccupiedRows` based on the current layout.
     * If expanded, updates `visibleRows` to match the occupied row count.
     */
    partition(visibleRows?: number): RangeLayout.PartitionResult<T> {
      const rows = visibleRows ?? this._visibleRows;
      const visible: Array<{ item: T; row: number; heightUnits: number }> = [];
      const overflow = new Map<number, T[]>();

      let maxOccupiedRow = 0;

      for (const { item, rowIdx, heightUnits } of this.state.getAllAssignments()) {
        const lastRow = rowIdx + heightUnits - 1;
        maxOccupiedRow = Math.max(maxOccupiedRow, lastRow + 1);

        if (lastRow < rows) {
          visible.push({ item, row: rowIdx, heightUnits });
        } else {
          for (let point = item.range.start; point <= item.range.end; point++) {
            let bucket = overflow.get(point);
            if (!bucket) {
              bucket = [];
              overflow.set(point, bucket);
            }
            bucket.push(item);
          }
        }
      }

      for (const item of this.state.getUnplacedItems()) {
        for (let point = item.range.start; point <= item.range.end; point++) {
          let bucket = overflow.get(point);
          if (!bucket) {
            bucket = [];
            overflow.set(point, bucket);
          }
          bucket.push(item);
        }
      }

      this._maxOccupiedRows.update(Math.max(1, maxOccupiedRow));
      if (this._expanded) {
        this._visibleRows = Math.max(
          this.config.defaultVisibleRows,
          this._maxOccupiedRows.get(),
        );
      }

      return { visible, overflow };
    }

    setExpanded(expanded: boolean): void {
      this._expanded = expanded;
      if (expanded) {
        this._visibleRows = Math.max(
          this.config.defaultVisibleRows,
          this._maxOccupiedRows.get(),
        );
      } else {
        this._visibleRows = this.config.defaultVisibleRows;
      }
    }

    /**
     * Finds the first available row block for a range without modifying state.
     * Useful for ghost preview positioning.
     */
    findAvailableRow(range: NumRangeLike, heightUnits: number = 1): number {
      return this.state.findAvailableRow(range, heightUnits);
    }

    clear(): void {
      this.state.clear();
    }

    get expanded(): boolean {
      return this._expanded;
    }

    get visibleRows(): number {
      return this._visibleRows;
    }

    get maxOccupiedRows(): LiveData.Readable<number> {
      return this._maxOccupiedRows;
    }
  }
}
