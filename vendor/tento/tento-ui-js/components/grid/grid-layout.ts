import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { $$ } from "../../fastdom";
import { NumRangeLike } from "@tento-core/range";
import { ViewportObserver } from "../../ui/viewport-observer";

type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ColumnState = {
  numColumns: number;
  columnWidth: number;
  columnOffsets: number[];
  columnHeights: number[];
  expandedColumnOffsets: number[];
};

export namespace GridLayout {
  export type Config = {
    blockSpacingPx: number;
    inlineSpacingPx: number;
    minWidthPx: number;
  };
}

@component({
  name: "std-grid-layout",
})
export class GridLayout extends LonaWebComponent {
  private _ids: string[] = [];
  get ids(): string[] {
    return this._ids;
  }

  private viewport: Option<NumRangeLike>;
  private pinRects: {
    $e: HTMLElement;
    rect: Rectangle;
    colIdx: number;
    belowFold: boolean;
  }[] = [];
  private columnState: Option<ColumnState>;

  private expandedHeight: Option<number>;
  private $expandedElement: Option<HTMLElement>;

  private preloadId: Option<number>;
  private childResizeObservers: Map<HTMLElement, ResizeObserver> = new Map();
  private childResizeTasks: Map<HTMLElement, EmptyFunction> = new Map();
  private layoutRevision = 0;
  private layoutTask: Option<EmptyFunction>;
  // Automatic resize work must converge. Keep a bounded history, never a
  // retry timer: after a repeating cycle, only a new input can restart it.
  private feedbackHistory: string[] = [];
  private feedbackBlocked: Set<string> | null = null;
  private feedbackChildren: Element[] = [];
  private feedbackViewport = "";
  private feedbackTime = 0;
  private appliedWidth = 0;

  /** During a rapid feedback cycle columns and height decreases pause, but
   * height increases still keep every child contained. Fresh observer input
   * after quiet or an explicit layout/bind/reconnect resumes normal layout. */
  get layoutSuspended(): boolean { return this.feedbackBlocked !== null; }

  private resetLayoutFeedback(): void {
    this.feedbackHistory = [];
    this.feedbackBlocked = null;
    this.feedbackChildren = [];
    this.feedbackViewport = "";
    this.feedbackTime = 0;
  }

  private allowResizeLayout(width: number): boolean {
    const children = [...this.children];
    const viewport = `${window.innerWidth},${window.innerHeight}`;
    const now = performance.now();
    if (viewport !== this.feedbackViewport ||
      children.length !== this.feedbackChildren.length ||
      children.some((child, i) => child !== this.feedbackChildren[i]) ||
      now - this.feedbackTime > 50) {
      this.resetLayoutFeedback();
    }
    // Feedback advances on consecutive frames. Slower independent changes,
    // including known inputs after a pause, begin a fresh sequence.
    this.feedbackViewport = viewport;
    this.feedbackChildren = children;
    this.feedbackTime = now;
    // Border-box heights match layoutGridSync/onChildResize. Content-box
    // measurements make padding/borders look like perpetual height changes.
    const key = [width, ...children.map(child => (child as HTMLElement).offsetHeight)].join(",");
    if (this.feedbackBlocked) {
      if (this.feedbackBlocked.has(key)) return false;
      this.feedbackBlocked = null;
      this.feedbackHistory = [];
    }
    // Several child observers can report the same DOM snapshot in one batch.
    // They must all update their pins; only transitions count toward a cycle.
    if (this.feedbackHistory[this.feedbackHistory.length - 1] === key) return true;
    this.feedbackHistory.push(key);
    if (this.feedbackHistory.length > 24) this.feedbackHistory.shift();
    // Three repetitions distinguish a cycle from an ordinary settle (A-B-A).
    // Delay suspension until the retained columns fit the current width.
    const history = this.feedbackHistory;
    for (let period = 2; period <= Math.floor(history.length / 3); period++) {
      const end = history.length;
      if (history.slice(end - period).every((state, i) =>
        state === history[end - 2 * period + i] && state === history[end - 3 * period + i]) &&
        width >= this.appliedWidth) {
        this.feedbackBlocked = new Set(history.slice(end - period));
        console.warn("GridLayout paused repeating resize geometry; new constraints or layoutGrid() will resume it", this);
        return false;
      }
    }
    return true;
  }
  /** Cleared once the first layout has painted; until then transitions are
      suppressed so the grid snaps into place instead of animating on open. */
  private initialTransitionCleared = false;

  static readonly DEFAULT_CONFIG: GridLayout.Config = {
    blockSpacingPx: 4,
    inlineSpacingPx: 4,
    minWidthPx: 400,
  };

  private _config: GridLayout.Config = GridLayout.DEFAULT_CONFIG;
  get config(): GridLayout.Config {
    return this._config;
  }

  private _height: number = 0;
  private _previousHeight: number = 0;
  private lastWidth: number = 0;
  get height(): number {
    return this._height;
  }

  onSizeChange: Option<(s: Size) => void> = (s: Size) => {
    if (Math.abs(s.width - this.lastWidth) >= 1) {
      this.lastWidth = s.width;
      this.queueLayout();
    }
  };

  onHeightChange: Option<(height: number) => void> = undefined;

  connectedCallback(): void {
    super.connectedCallback();
    this.layoutGrid();
  }

  private retireLayout(): void {
    this.layoutRevision++;
    if (this.layoutTask != null) $$.clear(this.layoutTask);
    this.layoutTask = null;
    this.layoutQueued = false;
    if (this.preloadId != null) cancelIdleCallback(this.preloadId);
    this.preloadId = null;
    this.cleanupChildResizeObservers();
    this.lastWidth = 0;
    this.resetLayoutFeedback();
  }

  disconnectedCallback(): void {
    this.retireLayout();
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.retireLayout();
    this.pinRects = [];
    this.columnState = null;
    this.viewport = null;
    this.$expandedElement = null;
    this.expandedHeight = null;
    this._height = 0;
    this._previousHeight = 0;
    this.onHeightChange = null;
    super.onRecycle();
  }

  private cleanupChildResizeObservers() {
    for (const task of this.childResizeTasks.values()) $$.clear(task);
    this.childResizeTasks.clear();
    for (const [element, observer] of this.childResizeObservers) {
      observer.disconnect();
    }
    this.childResizeObservers.clear();
  }

  private onChildResize = (element: HTMLElement, newHeight: number) => {
    if (!this.columnState) return;

    // Find the element in pinRects
    const pinRectIndex = this.pinRects.findIndex((pr) => pr.$e === element);
    if (pinRectIndex === -1) return;

    const pinRect = this.pinRects[pinRectIndex];
    const oldHeight = pinRect.rect.height;
    const heightDelta = newHeight - oldHeight;

    // If height hasn't changed, no need to update
    if (Math.abs(heightDelta) < 1) return;

    const wasSuspended = this.layoutSuspended;
    const canRelayout = this.allowResizeLayout(this.layoutWidth());
    // Stopping writes must not strand a larger child over the next card.
    // Within the blocked cycle keep the largest height seen for each pin;
    // growth converges while retaining enough space for every cycle state.
    if (!canRelayout && heightDelta <= 0) return;
    if (canRelayout && wasSuspended) {
      // Content has changed since the pause. Recompute columns as well as
      // heights instead of keeping the retained cycle's narrower columns.
      this.queueLayout();
      return;
    }

    // Update the element's stored height
    pinRect.rect.height = newHeight;

    // Find which column this element is in
    const elementX = pinRect.rect.x;
    const columnIndex = this.columnState.columnOffsets.findIndex(
      (offset, index) => {
        const adjustedOffset = offset + this._config.inlineSpacingPx * index;
        return Math.abs(adjustedOffset - elementX) < 1;
      },
    );

    if (columnIndex === -1) return;

    // Update column height
    this.columnState.columnHeights[columnIndex] += heightDelta;

    // Update y-positions of elements that come after this one in the same column
    this.updateSubsequentElementsInColumn(
      columnIndex,
      pinRectIndex,
      heightDelta,
    );

    // Re-render to apply position changes
    this.render();
  };

  private updateSubsequentElementsInColumn(
    columnIndex: number,
    changedElementIndex: number,
    heightDelta: number,
  ) {
    if (!this.columnState) return;

    // const columnOffset =
    //   this.columnState.columnOffsets[columnIndex] +
    //   this._config.inlineSpacingPx * columnIndex;
    const changedElementY = this.pinRects[changedElementIndex].rect.y;

    // Find all elements in the same column that come after the changed element
    this.pinRects.forEach((pinRect, index) => {
      if (index === changedElementIndex) return;

      const adjustedOffset = this.columnState!.columnOffsets.findIndex(
        (offset, colIndex) => {
          const adjustedColOffset =
            offset + this._config.inlineSpacingPx * colIndex;
          return Math.abs(adjustedColOffset - pinRect.rect.x) < 1;
        },
      );

      // If element is in the same column and positioned below the changed element
      if (adjustedOffset === columnIndex && pinRect.rect.y > changedElementY) {
        pinRect.rect.y += heightDelta;
      }
    });
  }

  watchViewport(observer: ViewportObserver) {
    observer.addViewportListener(this.onViewportChange);
  }

  onViewportChange = (viewport: NumRangeLike) => {
    // Padding so we can preload things faster
    this.viewport = {
      start: viewport.start - 1000,
      end: viewport.end + 1000,
    };
    if (this.columnState) {
      this.render();
    }
  };

  calculatePinRanges(): NumRangeLike {
    const ranges = this.pinRects.map((r) => ({
      start: r.rect.y,
      end: r.rect.y + r.rect.height,
    }));

    const findLastIndex = <T>(arr: T[], pred: (t: T) => boolean) => {
      let k = arr.length - 1;
      while (k >= 0) {
        const kValue = arr[k];
        if (pred(kValue)) {
          return k;
        }
        k -= 1;
      }
      return -1;
    };

    if (this.viewport) {
      return {
        start: ranges.findIndex((r) => r.end > this.viewport!.start) - 20,
        end: findLastIndex(ranges, (r) => r.start < this.viewport!.end) + 20,
      };
    } else {
      return {
        start: 0,
        end: Number.MAX_SAFE_INTEGER,
      };
    }
  }

  private setupChildResizeObserver(element: HTMLElement) {
    const revision = this.layoutRevision;
    const observer = new ResizeObserver(() => {
      if (!this.isConnected || revision !== this.layoutRevision || this.childResizeObservers.get(element) !== observer) return;
      const newHeight = element.offsetHeight;
      const previous = this.childResizeTasks.get(element);
      if (previous) $$.clear(previous);
      // Updating the grid's height resizes its ancestors. Never write that
      // geometry during ResizeObserver delivery; consume the latest child
      // measurement in the next write phase, while it still belongs to us.
      const task = $$.mutate(() => {
        this.childResizeTasks.delete(element);
        if (!this.isConnected || revision !== this.layoutRevision || this.childResizeObservers.get(element) !== observer) return;
        this.onChildResize(element, newHeight);
      });
      this.childResizeTasks.set(element, task);
    });

    observer.observe(element, { box: "border-box" });
    this.childResizeObservers.set(element, observer);
  }

  bind(config: GridLayout.Config) {
    if (!Number.isFinite(config.minWidthPx) || config.minWidthPx <= 0 ||
      !Number.isFinite(1 / config.minWidthPx) ||
      !Number.isFinite(config.inlineSpacingPx) || config.inlineSpacingPx < 0 ||
      !Number.isFinite(config.blockSpacingPx) || config.blockSpacingPx < 0) {
      throw new RangeError("GridLayout requires finite positive minWidthPx and nonnegative spacing");
    }
    // Reject unsupported density before replacing a valid binding. Detached
    // construction has no box yet; one pixel still detects overflow/subnormal input.
    GridLayout.generateColumnState(Math.max(1, Math.floor(Math.max(1, this.offsetWidth) / config.minWidthPx)),
      Math.max(1, this.offsetWidth), config.inlineSpacingPx);
    this._config = { ...config };
    this.layoutGrid();
  }

  private makeColumnState(width: number): ColumnState {
    const numColumns = Math.max(1, Math.floor(width / this._config.minWidthPx));
    return GridLayout.generateColumnState(
      numColumns,
      width,
      this._config.inlineSpacingPx,
    );
  }

  private layoutQueued = false;
  layoutGrid() {
    this.resetLayoutFeedback();
    this.queueLayout();
  }

  private queueLayout() {
    if (!this.isConnected || this.layoutQueued) return;
    this.layoutQueued = true;
    const revision = this.layoutRevision;
    // dev("grid/layout", this.id);
    // console.trace();
    this.layoutTask = $$.measure(() => {
      if (!this.isConnected || revision !== this.layoutRevision) return;
      this.layoutTask = null;
      this.layoutQueued = false;
      this.performLayout();
    });
  }

  /** The root's laid-out width. Unlike getBoundingClientRect it ignores
   * ancestor transforms, so a grid inside a scaled or moving container (a
   * carousel page mid-swipe) lays out at its real width instead of shifting
   * once the transform settles. */
  private layoutWidth(): number {
    const root = this.$("root");
    const used = parseFloat(getComputedStyle(root).width);
    return Number.isFinite(used) ? used : root.getBoundingClientRect().width;
  }

  layoutGridSync(): number {
    this.resetLayoutFeedback();
    return this.performLayout();
  }

  private performLayout(): number {
    if (!this.isConnected) return 0;
    const width = this.layoutWidth();
    if (!this.allowResizeLayout(width)) {
      const expanded = this.pinRects.find(pin => pin.$e === this.$expandedElement);
      return expanded ? expanded.rect.y + expanded.rect.height : 0;
    }
    this.appliedWidth = width;
    const columnState = (this.columnState = this.makeColumnState(width));

    this.$("root").style.setProperty(
      "--p-column-width",
      columnState.columnWidth + "px",
    );

    this.cleanupChildResizeObservers();

    const $children = [...this.children] as HTMLElement[];
    let expandedBottom = 0;

    let yAboveTheFold = 0;
    let yBelowTheFold = 0;

    const rects = $children.map(($child) => {
      const height = $child.offsetHeight;
      const minHeight = Math.min(...columnState.columnHeights);
      const colIdx = columnState.columnHeights.indexOf(minHeight);

      columnState.columnHeights[colIdx] += height + this._config.blockSpacingPx;

      const x =
        columnState.columnOffsets[colIdx] +
        this._config.inlineSpacingPx * colIdx;
      const y = minHeight;

      const bottom = y + height;

      this.setupChildResizeObserver($child);

      if ($child === this.$expandedElement) {
        expandedBottom = bottom;
        yAboveTheFold = bottom;
        yBelowTheFold = bottom + this.expandedHeight!;
        // dev({ yAboveTheFold, yBelowTheFold });
      }

      $child.setAttribute("dbg-height", String(height));

      return {
        $e: $child,
        rect: {
          x,
          y,
          width,
          height,
        },
        colIdx,
      };
    });

    this.pinRects = rects.map((rect) => {
      const isExpandedElement = rect.$e === this.$expandedElement;

      const top = rect.rect.y;
      const bottom = top + rect.rect.height;
      const belowFold = !isExpandedElement && bottom > yAboveTheFold;

      if (columnState.expandedColumnOffsets[rect.colIdx] === -1 && belowFold) {
        columnState.expandedColumnOffsets[rect.colIdx] =
          yBelowTheFold - top + this._config.blockSpacingPx;
      }

      return {
        ...rect,
        belowFold,
      };
    });

    this.render();
    return expandedBottom;
  }

  private render() {
    if (this.preloadId) cancelIdleCallback(this.preloadId);

    // Suppress transitions for the first layout so cards snap into their grid
    // positions instead of animating in from the stacked (0,0) start.
    const suppressInitial = !this.initialTransitionCleared;
    if (suppressInitial) this.setAttribute("initializing", "");

    let maxHeight = 0;
    const pinRange = this.calculatePinRanges();
    this.pinRects.map((r, index) => {
      if (index < pinRange.start || index > pinRange.end) {
        r.$e.parentElement?.removeChild(r.$e);
      } else {
        const {
          $e,
          rect: { x, y, height },
          colIdx,
          belowFold,
        } = r;
        const expandedColumnOffset =
          this.columnState!.expandedColumnOffsets[colIdx];
        if (belowFold) {
          maxHeight = Math.max(maxHeight, y + expandedColumnOffset + height);
        } else {
          maxHeight = Math.max(maxHeight, y + height);
        }

        $e.style.removeProperty("display");
        $e.style.removeProperty("visibility");
        if (belowFold) {
          $e.style.transform = `translate(${x}px, ${y + expandedColumnOffset}px)`;
        } else {
          $e.style.transform = `translate(${x}px, ${y}px)`;
        }
      }
    });

    if (suppressInitial) {
      this.initialTransitionCleared = true;
      // Re-enable transitions once the first layout has painted, so later
      // relayouts (resize, column reflow, expand) still animate.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => this.removeAttribute("initializing")),
      );
    }

    // Ensure grid height includes expanded content when expanded element is at the bottom
    if (this.$expandedElement && this.expandedHeight) {
      const expandedRect = this.pinRects.find(
        (r) => r.$e === this.$expandedElement,
      );
      if (expandedRect) {
        const expandedBottom =
          expandedRect.rect.y +
          expandedRect.rect.height +
          this.expandedHeight;
        maxHeight = Math.max(maxHeight, expandedBottom);
      }
    }

    this._height = maxHeight;
    this.style.height = `calc(${maxHeight + 0}px)`;

    if (Math.abs(this._height - this._previousHeight) >= 1) {
      if (this.onHeightChange) {
        this.onHeightChange(this._height);
      }
      this._previousHeight = this._height;
    }

    this.rebindSpacer();
  }

  rebindSpacer() {
    // const $spacer = DomUtils.assignStyles(
    //   this.$_maybe("spacer") ?? Div.make(),
    //   {
    //     height: "24px",
    //     pointerEvents: "none",
    //     transform: `translate(0px, calc(${Math.max(...this.columnState!.columnHeights)}px + var(--expanded-height, 0px)))`,
    //   },
    // );
    // $spacer.id = "spacer";
    // this.$("root").append($spacer);
  }

  toggleCellExpanded(
    $c: HTMLElement,
    expanded: boolean,
    expandedHeight: number,
  ): Option<number> {
    if (!expanded) {
      this.style.setProperty("--expanded-height", 0 + "px");
      this.$expandedElement = null;
      this.expandedHeight = 0;
      this.layoutGrid();
      return null;
    } else {
      this.style.setProperty("--expanded-height", expandedHeight + "px");
      this.$expandedElement = $c;
      this.expandedHeight = expandedHeight;
      const expandedBottom = this.layoutGridSync();
      return expandedBottom;
    }
  }

  static generateColumnState(
    numColumns: number,
    width: number,
    horizontalSpacing: number = 4,
  ): ColumnState {
    // Bound all public callers before any arrays or loops are allocated.
    if (!Number.isSafeInteger(numColumns) || numColumns < 1 || numColumns > 1024 ||
      !Number.isFinite(width) || width < 0 ||
      !Number.isFinite(horizontalSpacing) || horizontalSpacing < 0) {
      throw new RangeError("GridLayout supports 1..1024 columns with finite nonnegative geometry");
    }
    const columnWidth =
      (width - horizontalSpacing * (numColumns - 1)) / numColumns;
    if (!Number.isFinite(columnWidth) || columnWidth < 0) throw new RangeError("GridLayout spacing exceeds available width");
    const expandedColumnOffset: number[] = [];
    const columnOffsets: number[] = [];
    for (let i = 0; i < numColumns; ++i) {
      columnOffsets.push(columnWidth * i);
      expandedColumnOffset.push(-1);
    }
    const columnHeights = Array(numColumns).fill(4);
    return {
      columnWidth,
      columnOffsets,
      columnHeights,
      numColumns,
      expandedColumnOffsets: expandedColumnOffset,
    };
  }

  static $styles = [
    css`
      #root {
        position: relative;
        --p-column-width: 100%;
        --p-transition: transform var(--transition-duration, 0.3s) ease;
      }

      slot::slotted(*) {
        position: absolute;
        top: 0;
        left: 0;
        width: var(--p-column-width);
        transition: var(--p-transition);
      }

      /* no-transition is the consumer-facing "never animate" switch;
         initializing is set internally so the FIRST layout snaps into place
         instead of animating in from the stacked (0,0) start position. */
      :host([no-transition]) slot::slotted(*),
      :host([initializing]) slot::slotted(*) {
        transition: none !important;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <slot></slot>
    </div>
  `;
}
