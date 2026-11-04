import { NaiveDate } from "@tento-chrono";
import { AVLTree } from "@tento-core/avl-tree";
import { LiveData } from "@tento-core/livedata";
import { RangeLayoutManager } from "@tento-core/range-layout";
import { RowHeightCalculator } from "./row-height-calculator";
import {
  GestureChangedContext,
  TimelineCell,
  TimelineGesture,
} from "./timeline-gesture";

/**
 * Delegate interface for TimelineLayoutManager.
 *
 * The manager drives all rendering decisions. The delegate just executes
 * primitive render/dismiss operations.
 */
export interface TimelineLayoutManagerDelegate<
  Item extends Identifiable<string> & AVLTree.HasNumRange,
  Ghost,
  Context,
> {
  /**
   * Render a span for the given item at the specified row.
   * Manager calls this when an item should be visible.
   * Only needed for the imperative onViewportChanged path.
   * @param isActive - true if this item is currently being dragged
   */
  renderSpan?(item: Item, rowIdx: number, spanId: string, isActive: boolean): void;

  /**
   * Update the active state of a rendered span.
   * Manager calls this when dragging starts/stops.
   * Only needed for the imperative onViewportChanged path.
   */
  setSpanActive?(spanId: string, isActive: boolean): void;

  /**
   * Dismiss a previously rendered span.
   * Manager calls this when an item is no longer visible.
   * Only needed for the imperative onViewportChanged path.
   */
  dismissSpan?(spanId: string): void;

  /**
   * Render overflow indicator for items that don't fit.
   * Manager calls this when items overflow the visible rows.
   * Only needed for the imperative onViewportChanged path.
   */
  renderOverflowIndicator?(
    rangeKey: number,
    items: Item[],
    indicatorId: string,
  ): void;

  /**
   * Dismiss a previously rendered overflow indicator.
   * Only needed for the imperative onViewportChanged path.
   */
  dismissOverflowIndicator?(indicatorId: string): void;

  /**
   * Render ghost preview during drag.
   * Manager calls this when ghost state changes.
   */
  renderGhost(ghost: Ghost): void;

  /**
   * Hide ghost preview.
   * Manager calls this when drag ends or cancels.
   */
  dismissGhost(): void;

  /**
   * Creates gesture context info for a specific item.
   * Manager calls this when binding cell callbacks via asCellDelegate.
   * Only needed if asCellDelegate is used (vs asCellDelegateWithContext).
   */
  createGestureContext?(item: Item, rowIdx: number): Context;

  /**
   * Called when active gestures change (optional).
   * Consumer can update cursor, UI state, etc.
   */
  onGesturesChanged?(
    gestures: Set<TimelineGesture<Context>>,
    context: GestureChangedContext,
  ): void;

  /**
   * Called when visible rows change due to pending ghost (optional).
   * Consumer should invalidate layout and rebind viewports.
   */
  onVisibleRowsChanged?(visibleRows: number): void;

  /**
   * Enable or disable pointer events on the ghost element.
   * Called during active drag to prevent pointer event feedback loops.
   */
  setGhostPointerEvents?(enabled: boolean): void;
}

export namespace TimelineLayoutManager {
  export interface Config<Item extends Identifiable<string>> {
    /** Maximum rows before overflow (default: 8) */
    maxRows: number;
    /** Default visible rows when collapsed (default: 1) */
    defaultVisibleRows: number;
    /** Function to generate span IDs from items */
    spanIdForItem: (item: Item) => string;
    /** Function to generate overflow indicator IDs */
    overflowIdForRange: (rangeKey: number) => string;
    /** If true, ghost row index is capped at visibleRows so overflow events stay unexpanded. */
    keepGhostWithinVisibleRows?: boolean;
  }
}

/**
 * Manages layout and gestures for a SINGLE row of timeline items.
 *
 * Key design: One TimelineLayoutManager per row. The plugin maintains
 * a Map<rowId, TimelineLayoutManager> and gets/creates managers as needed.
 *
 * The manager DRIVES all rendering decisions for its row:
 * - Computes which items are visible vs overflow
 * - Tracks what's currently rendered
 * - Calls delegate.renderSpan() / delegate.dismissSpan() directly
 * - Handles gesture dispatch and ghost state
 *
 * The delegate just executes primitive render commands.
 */
export class TimelineLayoutManager<
  Item extends Identifiable<string> & AVLTree.HasNumRange,
  Ghost,
  Context extends { toString: () => string },
> {
  private readonly rangeLayout: RangeLayoutManager<Item>;
  readonly gestureManager: TimelineGesture.Manager<Context>;
  private readonly config: TimelineLayoutManager.Config<Item>;

  get keepGhostWithinVisibleRows(): boolean {
    return this.config.keepGhostWithinVisibleRows ?? false;
  }

  private delegate: Option<TimelineLayoutManagerDelegate<Item, Ghost, Context>>;
  private currentGhost: Option<Ghost>;
  private resolveCallback: Option<
    (position: TimelineCell.PointerPosition) => NaiveDate
  >;

  // Track what's currently rendered
  private renderedSpans: Set<string> = new Set();
  private renderedOverflows: Set<string> = new Set();

  // Lookup map for O(1) itemId → spanId conversion (populated during reconciliation)
  private itemIdToSpanId: Map<string, string> = new Map();

  // Track hovered date for highlight rendering
  private readonly _hoveredDate = new LiveData<Option<NaiveDate>>(null);

  // Track which item is currently being dragged
  private _activeDraggingItemId: Option<string> = null;

  // Track pending ghost row index for row height calculation
  private _pendingGhostRowIdx: Option<number> = null;

  // Row height calculator config
  private readonly _rowHeightConfig: RowHeightCalculator.Config;

  constructor(config: TimelineLayoutManager.Config<Item>) {
    this.config = config;
    this._rowHeightConfig = {
      collapsedRows: config.defaultVisibleRows,
      maxRows: config.maxRows,
    };
    this.rangeLayout = new RangeLayoutManager<Item>(
      config.maxRows,
      config.defaultVisibleRows,
    );
    this.gestureManager = new TimelineGesture.Manager<Context>();

    // Forward gesture changes to delegate
    this.gestureManager.addGestureChangeCallback(
      this,
      (
        gestures: Set<TimelineGesture<Context>>,
        context: GestureChangedContext,
      ) => {
        this.delegate?.onGesturesChanged?.(gestures, context);
      },
    );

    // Track hover state from gesture manager
    this.gestureManager.setHoverCallback((position) => {
      if (!position) {
        this._hoveredDate.update(null);
        return;
      }
      const date = this.resolvePointerPosition(position);
      this._hoveredDate.update(date);
    });
  }

  /**
   * Initialize manager with delegate. Must be called before other operations.
   */
  initialize(
    delegate: TimelineLayoutManagerDelegate<Item, Ghost, Context>,
  ): this {
    this.delegate = delegate;
    return this;
  }

  /**
   * Sets the callback for resolving pointer positions to precise dates.
   * Must be called with current sheet context before gesture handling.
   */
  setResolveCallback(
    callback: (position: TimelineCell.PointerPosition) => NaiveDate,
  ): void {
    this.resolveCallback = callback;
  }

  /**
   * Registers a gesture handler with the internal gesture manager.
   */
  addGesture(gesture: TimelineGesture<Context>): this {
    this.gestureManager.addGesture(gesture);
    return this;
  }

  /**
   * Update ghost state. Called by gesture handlers during drag operations.
   * Automatically calls delegate to render/dismiss ghost.
   * Also clears pending ghost row when ghost is dismissed.
   */
  updateGhost(ghost: Option<Ghost>): void {
    const hadGhost = this.currentGhost != null;
    const hasGhost = ghost != null;

    this.currentGhost = ghost;

    if (hasGhost) {
      this.delegate?.renderGhost(ghost);
    } else if (hadGhost) {
      this.setPendingGhostRowIdx(null);
      this.delegate?.dismissGhost();
    }
  }

  /**
   * Read current ghost state (for gesture handlers).
   */
  get ghost(): Option<Ghost> {
    return this.currentGhost;
  }

  /**
   * Clear ghost state without calling delegate.
   * Used when ghost is dismissed externally (e.g., via plugin's dismissGhost).
   */
  clearGhost(): void {
    this.currentGhost = null;
  }

  /**
   * Set the active (being dragged) item. Called by gesture handlers.
   * Automatically updates the visual state of affected spans.
   */
  setActiveItem(itemId: Option<string>): void {
    if (this._activeDraggingItemId === itemId) return;

    const oldId = this._activeDraggingItemId;
    this._activeDraggingItemId = itemId;
    this.updateSpanActiveState(oldId, itemId);
  }

  /**
   * Computes layout for the given items without rendering.
   * Useful when using declarative APIs where the caller handles rendering.
   *
   * @param items - All items that should be considered for this row's viewport
   * @returns Layout partition with visible spans and overflow items
   */
  computeLayout(items: Item[]): {
    visible: Array<{ item: Item; row: number }>;
    overflow: Map<number, Item[]>;
  } {
    // Update internal layout state
    this.updateLayoutState(items);

    // Compute what should be visible
    return this.rangeLayout.partition(this.rangeLayout.getVisibleRows());
  }

  /**
   * Called when viewport changes (scroll, resize) or data changes.
   * Manager computes layout and calls delegate to render/dismiss spans.
   *
   * @param items - All items that should be considered for this row's viewport
   */
  onViewportChanged(items: Item[]): void {
    // Step 1 & 2: Compute layout
    const partition = this.computeLayout(items);

    // Step 3: Render visible spans and dismiss stale ones
    this.reconcileSpans(partition.visible);

    // Step 4: Render overflow indicators and dismiss stale ones
    this.reconcileOverflows(partition.overflow);
  }

  /**
   * Toggle expanded state.
   * Note: Does NOT trigger re-render. Caller should trigger rebindViewports()
   * which will call onViewportChanged with correct context.
   */
  setExpanded(expanded: boolean): void {
    this.rangeLayout.setExpanded(expanded);
  }

  /**
   * Clears all layout state and dismisses all rendered elements.
   */
  clear(): void {
    // Dismiss all spans
    for (const spanId of this.renderedSpans) {
      this.delegate?.dismissSpan?.(spanId);
    }
    this.renderedSpans.clear();
    this.itemIdToSpanId.clear();

    // Dismiss all overflows
    for (const overflowId of this.renderedOverflows) {
      this.delegate?.dismissOverflowIndicator?.(overflowId);
    }
    this.renderedOverflows.clear();

    // Clear ghost
    this.updateGhost(undefined);

    // Clear layout
    this.rangeLayout.clear();
  }

  get expanded(): boolean {
    return this.rangeLayout.isExpanded();
  }

  get visibleRows(): number {
    return this.rangeLayout.getVisibleRows();
  }

  getUnplacedItems(): Item[] {
    return this.rangeLayout.getUnplacedItems();
  }

  /**
   * Returns the effective number of visible rows, accounting for pending ghost.
   * Use this for layout calculations when a ghost might need an extra row.
   */
  get effectiveVisibleRows(): number {
    const state: RowHeightCalculator.State = {
      expanded: this.rangeLayout.isExpanded(),
      occupiedRows: this.rangeLayout.getMaxHeight().get(),
      pendingGhostRowIdx: this._pendingGhostRowIdx,
    };
    return RowHeightCalculator.calculateVisibleRows(this._rowHeightConfig, state);
  }

  /**
   * Finds the first available row for a range without modifying layout.
   * Useful for determining where a new event ghost should be positioned.
   *
   * @param range - Range to check for conflicts
   * @returns Row index (0 to maxRows-1), or -1 if all rows are occupied
   */
  findAvailableRowForRange(range: { start: number; end: number }): number {
    return this.rangeLayout.findAvailableRow(range);
  }

  /**
   * Sets pending ghost row index for row height calculation.
   * Call with null when ghost is dismissed.
   * Triggers onVisibleRowsChanged callback if visible rows change.
   *
   * @param rowIdx - Row index where ghost will be placed, or null to clear
   */
  setPendingGhostRowIdx(rowIdx: Option<number>): void {
    const oldVisible = this.effectiveVisibleRows;
    this._pendingGhostRowIdx = rowIdx;
    const newVisible = this.effectiveVisibleRows;

    if (oldVisible !== newVisible) {
      this.delegate?.onVisibleRowsChanged?.(newVisible);
    }
  }

  /**
   * Gets current pending ghost row index.
   */
  get pendingGhostRowIdx(): Option<number> {
    return this._pendingGhostRowIdx;
  }

  /**
   * @deprecated Use setPendingGhostRowIdx instead
   */
  setGhostRowExpansion(expansion: Option<number>): void {
    // For backwards compatibility, convert expansion to row index
    // expansion is the total rows needed, so rowIdx = expansion - 1
    const rowIdx = expansion != null ? expansion - 1 : null;
    this.setPendingGhostRowIdx(rowIdx);
  }

  /**
   * @deprecated Use pendingGhostRowIdx instead
   */
  get ghostRowExpansion(): Option<number> {
    // For backwards compatibility, convert row index to expansion
    return this._pendingGhostRowIdx != null
      ? this._pendingGhostRowIdx + 1
      : null;
  }

  get maxHeight(): LiveData<number> {
    return this.rangeLayout.getMaxHeight();
  }

  /**
   * Read-only access to the currently hovered date.
   * TimelineColumn subscribes to this for rendering hover highlights.
   */
  get hoveredDate(): LiveData.Readable<Option<NaiveDate>> {
    return this._hoveredDate;
  }

  /**
   * Returns cell-level callbacks for a specific item.
   * Called internally when rendering spans - also exposed for manual binding.
   */
  asCellDelegate(item: Item, rowIdx: number): TimelineCell.CellCallbacks {
    const context = this.delegate?.createGestureContext?.(item, rowIdx);
    if (!context) {
      throw new Error("asCellDelegate requires delegate.createGestureContext");
    }
    return this.gestureManager.asCellDelegate(context);
  }

  /**
   * Returns cell-level callbacks for a pre-built context.
   * Useful for ghost cells where no Item exists.
   */
  asCellDelegateWithContext(context: Context): TimelineCell.CellCallbacks {
    return this.gestureManager.asCellDelegate(context);
  }

  /**
   * Returns column-level callbacks with info embedded in events.
   * Used for binding TimelineColumn cells.
   */
  get asColumnDelegate(): TimelineCell.ColumnCallbacks<Context> {
    return this.gestureManager.asColumnDelegate;
  }

  /**
   * Enable or disable pointer events on the ghost element.
   * Useful during active drag to prevent feedback loops where ghost pointer
   * events interfere with drag calculations.
   */
  setGhostPointerEvents(enabled: boolean): void {
    this.delegate?.setGhostPointerEvents?.(enabled);
  }

  /**
   * Resolves a pointer position to a precise NaiveDate.
   * Uses the callback set via setResolveCallback for precise resolution.
   *
   * @param position - Pointer position with date and relative offset
   * @returns Precise NaiveDate accounting for sub-cell position
   */
  resolvePointerPosition(position: TimelineCell.PointerPosition): NaiveDate {
    if (this.resolveCallback) {
      return this.resolveCallback(position);
    }
    // Fallback to naive resolution
    return position.date.toRange().start;
  }

  destroy(): void {
    this.clear();
    this.gestureManager.addGestureChangeCallback(this, () => {});
    this.delegate = undefined;
  }

  /**
   * Hands the full current item set to the layout, which repacks every lane
   * from it.
   *
   * This used to diff incrementally — remove what vanished or moved, then
   * offer the rest — but `RangeLayoutManager` caches a lane per item id and
   * never revisits it, so the survivors kept whatever lane the arrival history
   * gave them. An event displaced into a hidden lane by two neighbours stayed
   * hidden after both were deleted, rendering as "+N more" dots above an empty
   * visible lane, and the same events packed differently after a scroll or a
   * sync than on first paint. `update` is the repacking entry point.
   */
  private updateLayoutState(items: Item[]): void {
    this.rangeLayout.update(items);
  }

  private getAllItems(): Item[] {
    const items: Item[] = [];
    for (let i = 0; i < this.config.maxRows; i++) {
      items.push(...this.rangeLayout.getItemsInRow(i));
    }
    items.push(...this.rangeLayout.getUnplacedItems());
    return items;
  }

  private reconcileSpans(visible: Array<{ item: Item; row: number }>): void {
    const newSpanIds = new Set<string>();
    const newItemIdToSpanId = new Map<string, string>();

    // Render visible spans
    for (const { item, row: rowIdx } of visible) {
      const spanId = this.config.spanIdForItem(item);
      newSpanIds.add(spanId);
      newItemIdToSpanId.set(item.id, spanId);

      // Always call renderSpan - delegate can optimize if already rendered
      const isActive = item.id === this._activeDraggingItemId;
      this.delegate?.renderSpan?.(item, rowIdx, spanId, isActive);
    }

    // Dismiss stale spans
    for (const oldSpanId of this.renderedSpans) {
      if (!newSpanIds.has(oldSpanId)) {
        this.delegate?.dismissSpan?.(oldSpanId);
      }
    }

    this.renderedSpans = newSpanIds;
    this.itemIdToSpanId = newItemIdToSpanId;
  }

  /**
   * Updates the active state of spans when dragging starts/stops.
   * Uses itemIdToSpanId map for O(1) lookup instead of searching all items.
   */
  private updateSpanActiveState(
    oldActiveId: Option<string>,
    newActiveId: Option<string>,
  ): void {
    // Update old active item (now inactive)
    if (oldActiveId) {
      const spanId = this.itemIdToSpanId.get(oldActiveId);
      if (spanId) {
        this.delegate?.setSpanActive?.(spanId, false);
      }
    }

    // Update new active item
    if (newActiveId) {
      const spanId = this.itemIdToSpanId.get(newActiveId);
      if (spanId) {
        this.delegate?.setSpanActive?.(spanId, true);
      }
    }
  }

  private reconcileOverflows(overflow: Map<number, Item[]>): void {
    const newOverflowIds = new Set<string>();

    // Render overflow indicators
    for (const [rangeKey, items] of overflow.entries()) {
      const overflowId = this.config.overflowIdForRange(rangeKey);
      newOverflowIds.add(overflowId);

      // Always call render - delegate can optimize if already rendered
      this.delegate?.renderOverflowIndicator?.(rangeKey, items, overflowId);
    }

    // Dismiss stale overflow indicators
    for (const oldOverflowId of this.renderedOverflows) {
      if (!newOverflowIds.has(oldOverflowId)) {
        this.delegate?.dismissOverflowIndicator?.(oldOverflowId);
      }
    }

    this.renderedOverflows = newOverflowIds;
  }
}
