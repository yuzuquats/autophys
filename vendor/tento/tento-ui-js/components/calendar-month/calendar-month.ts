import { NaiveDate, Weekday, Ym1Like } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Point } from "@tento-core/point";
import { SizeGate } from "../../ui/size-gate";
import { CalendarMonthCell } from "./calendar-month-cell";
import {
  computeSpanLayout,
  PositionedSegment,
} from "../layout-shared/span-layout";
import { SpanReconciler, StyleBag } from "../layout-shared/span-reconciler";
import { GhostOverlay } from "../layout-shared/ghost-overlay";

/**
 * Per-segment render unit fed to the {@link SpanReconciler}. A span that
 * crosses week boundaries produces one unit per segment; `key` carries
 * the per-span segment ordinal so a span moving rows keeps its identity.
 * `contentSig` folds in the segment clipping flags — position is excluded,
 * so the reconciler applies `styles` as inline position on every pass.
 */
interface SpanRenderUnit {
  key: string;
  contentSig: string;
  isDragging: boolean;
  span: CalendarMonth.Span;
  segment: PositionedSegment<CalendarMonth.Span>["segment"];
  lane: number;
  styles: StyleBag;
}

@component({ name: "std-calendar-month" })
export class CalendarMonth extends LonaWebComponent {
  private props: CalendarMonth.Props = {
    month: NaiveDate.today(),
    bind: () => {},
    cellHeight: 100,
  };
  private cells: CalendarMonthCell[] = [];
  private callbacks: Option<CalendarMonth.Callbacks> = null;
  private cellDateMap: Map<CalendarMonthCell, NaiveDate> = new Map();
  private observedWidth: Option<number>;
  private $highlight: HTMLElement = this.$("highlight");
  private currentHighlightDate: Option<NaiveDate> = null;
  private ghostSpan: Option<{
    originalSpan: CalendarMonth.Span;
    offsetDays: number;
  }> = null;
  /**
   * Atomic drag/resize ghost-promotion — the DOM-less {@link GhostOverlay}.
   * `setDragOffset` (MoveSpan) drives `setShift`; `setResizeOverride`
   * (ResizeSpan) drives `setReplace`. Every render, `renderGrid` calls
   * `apply(baseSpans)` to get the effective spans (the dragged span moved
   * to its current position, kept on its captured lane, flagged
   * `isDragging`). Capture-at-gesture-start means a canonical update
   * arriving mid-gesture doesn't double-apply the shift.
   */
  private ghostOverlay = new GhostOverlay<
    CalendarMonth.Span,
    NaiveDate.Range,
    { lane: number }
  >({
    shiftRange: (range, days) =>
      new NaiveDate.Range(range.start.addDays(days), range.end.addDays(days)),
    capture: (key, base) => ({ lane: this.spanLane(key, base) }),
    promote: (span, range, capture) => ({
      ...span,
      range,
      preferredLane: capture.lane,
      isDragging: true,
    }),
  });

  // Keyed reconciliation for span DOM — see `SpanReconciler`. Atomic
  // element promotion: `contentSig` excludes position, so a span that
  // drags / drops / shifts lanes reuses the same DOM node instead of
  // tearing it down (that destroy/recreate churn was the "span flashes /
  // duplicates" regression). The `ref` cell — threaded through the
  // gesture closures built in `createSpanElement` — is bumped to the
  // fresh unit on every reuse, so the listeners read live span data
  // (no re-registration, no stale `range.end` after a resize / move).
  private spanReconciler = new SpanReconciler<SpanRenderUnit, HTMLElement>();

  // SizeGate for waiting on size availability
  private sizeGate = new SizeGate();

  // Use LonaWebComponent's built-in ResizeObserver via onSizeChange
  override onSizeChange = (size: Size) => {
    if (size.width <= 0) return;
    this.observedWidth = size.width;
    this.sizeGate.resolve(size);
    this.renderGrid();
    if (this.currentHighlightDate) {
      this.highlightCell(this.currentHighlightDate);
    }
  };

  static makeWith(props: CalendarMonth.Props): CalendarMonth {
    const component = CalendarMonth.make();
    component.bind(props);
    return component;
  }

  highlightCell(date: Option<NaiveDate>): void {
    this.currentHighlightDate = date;
    if (!date) {
      this.$highlight.style.display = "none";
      return;
    }

    // Find the cell for this date
    for (const [cell, cellDate] of this.cellDateMap) {
      if (cellDate.equals(date)) {
        const rect = cell.getBoundingClientRect();
        const parentRect = this.getBoundingClientRect();
        this.$highlight.assignStyles({
          display: "block",
          left: `${rect.left - parentRect.left + 1}px`,
          top: `${rect.top - parentRect.top + 1}px`,
          // left: `${rect.left - parentRect.left - 1.5}px`,
          // top: `${rect.top - parentRect.top - 1}px`,
          width: `${rect.width - 3}px`,
          height: `${rect.height - 3}px`,
          borderRadius: "8px",
        });
        return;
      }
    }

    // Date not found
    this.$highlight.style.display = "none";
  }

  setGhostSpan(span: Option<CalendarMonth.Span>, offsetDays: number): void {
    this.ghostSpan = span ? { originalSpan: span, offsetDays } : null;
    this.renderGrid();
  }

  /**
   * Atomic drag-promotion entry point (`MoveSpan`). Pass `null` to
   * clear. On a fresh drag (key changes), the widget captures the
   * span's current `range` and computed lane so subsequent renders
   * (including any canonical-update-driven one that lands while the
   * gesture is still holding state) compute a stable effective position
   * from the captured original — no double-shift on drop.
   */
  setDragOffset(spanKey: Option<string>, offsetDays: number): void {
    if (spanKey == null) {
      this.ghostOverlay.clearShift();
    } else {
      this.ghostOverlay.setShift(
        spanKey,
        offsetDays,
        this.props.options?.spans ?? [],
      );
    }
    this.renderGrid();
  }

  /**
   * Atomic resize-promotion entry point (`ResizeSpan`). Pass `null` for
   * `spanKey` or `newRange` to clear. The gesture provides the absolute
   * `newRange`; the overlay captures the span's lane once so a
   * canonical-update render mid-gesture keeps it on its original row.
   */
  setResizeOverride(
    spanKey: Option<string>,
    newRange: Option<NaiveDate.Range>,
  ): void {
    if (spanKey == null || newRange == null) {
      this.ghostOverlay.clearReplace();
    } else {
      this.ghostOverlay.setReplace(
        spanKey,
        newRange,
        this.props.options?.spans ?? [],
      );
    }
    this.renderGrid();
  }

  /**
   * The lane a span occupies in the base layout — the {@link GhostOverlay}
   * `capture` op, snapshotted at gesture start so the span stays on its
   * original row through drag/resize/reset.
   */
  private spanLane(
    key: string,
    base: readonly CalendarMonth.Span[],
  ): number {
    const startOfWeek = this.props.options?.startOfWeek ?? Weekday.SUN;
    const layout = computeSpanLayout(base, this.props.month, startOfWeek);
    for (const { segment, lane } of layout.positionedSegments) {
      if (segment.originalItem.key === key) return lane;
    }
    return 0;
  }

  /**
   * Get the cell element for a given date, or null if not found.
   */
  getCellForDate(date: NaiveDate): Option<CalendarMonthCell> {
    for (const [cell, cellDate] of this.cellDateMap) {
      if (cellDate.equals(date)) {
        return cell;
      }
    }
    return null;
  }

  /** Height of the day-number row within a cell (date label area above spans). */
  getDayNumberRowHeight($cell: CalendarMonthCell): number {
    return $cell.dayNumberRowHeight;
  }

  /**
   * Get the bottom Y position (relative to calendar) of a span containing the given date.
   * If expectedRange is provided, only matches spans that start at the expected start date.
   * Returns null if no span found.
   */
  getSpanBottomForDate(
    date: NaiveDate,
    expectedRange?: NaiveDate.Range,
  ): Option<number> {
    const $container = this.$("span-container");
    const calendarRect = this.getBoundingClientRect();
    const $cell = this.getCellForDate(date);
    if (!$cell) return null;

    const cellRect = $cell.getBoundingClientRect();

    // If we have an expected range, also get the start cell to match against
    const $startCell = expectedRange
      ? this.getCellForDate(expectedRange.start)
      : null;
    const startCellRect = $startCell?.getBoundingClientRect();

    for (const child of $container.children) {
      const $span = child as HTMLElement;
      const spanRect = $span.getBoundingClientRect();

      // Span contains the date if it overlaps horizontally with the cell
      // and is in the same row (span top is within the cell's vertical bounds)
      const spanContainsDate =
        spanRect.left <= cellRect.right &&
        spanRect.right >= cellRect.left &&
        spanRect.top >= cellRect.top &&
        spanRect.top < cellRect.top + this.props.cellHeight;

      if (!spanContainsDate) continue;

      // If we have an expected range, check that span starts at the expected start cell
      if (startCellRect) {
        const spanStartsAtExpected =
          spanRect.left >= startCellRect.left - 5 &&
          spanRect.left <= startCellRect.left + 10;
        if (!spanStartsAtExpected) continue;
      }

      return spanRect.bottom - calendarRect.top;
    }

    return null;
  }

  bind(props: CalendarMonth.Props): this {
    this.props = props;
    this.style.height = this.props.cellHeight * 6 + "px";
    this.scheduleRender();
    return this;
  }

  private renderVersion = 0;
  private async scheduleRender(): Promise<void> {
    const version = ++this.renderVersion;
    await this.sizeGate.waitForSize();
    // Only render if this is still the latest request
    if (version === this.renderVersion) {
      this.renderGrid();
    }
  }

  setCallbacks(callbacks: CalendarMonth.Callbacks): this {
    this.callbacks = callbacks;
    for (const $cell of this.cellDateMap.keys()) {
      $cell.setCallbacks(callbacks.cell);
    }
    return this;
  }

  rebindAll(): void {
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      const date = cell["date"] as NaiveDate;
      if (date) {
        const isCurrentMonth =
          date.mth === this.props.month.mth && date.yr === this.props.month.yr;
        DomUtils.clearChildren(cell);
        this.props.bind(cell, date, isCurrentMonth);
      }
    }
  }

  /**
   * Update only the spans without re-rendering cells.
   * Use this during drag operations when cell content hasn't changed.
   */
  updateSpans(spans: CalendarMonth.Span[]): void {
    // Persist as the new base spans so a subsequent `renderGrid` (e.g. the
    // `setDragOffset(null)` clear at drop) reads these, not a stale snapshot.
    // Without this, the two render paths diverge: `updateSpans` paints the
    // fresh spans while `renderGrid` re-reads the old `props.options.spans`,
    // repainting the dragged bar at its pre-move position for a frame
    // (the residual "snap-back" flicker).
    if (this.props.options) this.props.options.spans = spans;
    if (!this.observedWidth) return;

    const cellWidth = this.props.options?.cellWidth;
    let effectiveCellWidth: Option<number> = this.observedWidth / 7;
    if (cellWidth) {
      effectiveCellWidth = Math.min(effectiveCellWidth, cellWidth);
    }
    if (!effectiveCellWidth) return;

    const startOfWeek = this.props.options?.startOfWeek ?? Weekday.SUN;
    const dates = this.calculateGridDates();

    // Compute span layout
    const { laneCounts, positionedSegments } = computeSpanLayout(
      spans,
      this.props.month,
      startOfWeek,
    );

    // Update cell content offsets using transforms (no layout recalc)
    const spanLaneGap = this.props.options?.spanLaneGap ?? 0;
    for (let i = 0; i < this.cells.length; i++) {
      const $cell = this.cells[i];
      const laneCount = laneCounts[i] ?? 0;
      const gapContribution = laneCount > 0 ? (laneCount - 1) * spanLaneGap : 0;
      $cell.style.setProperty(
        "--content-margin-top",
        `calc(var(--span-lane-height, 24px) * ${laneCount} + ${gapContribution}px)`,
      );
    }

    // Render only the spans
    this.renderSpans(positionedSegments, effectiveCellWidth, dates);
  }

  private renderGrid(): void {
    const $grid = this.$("grid");
    const showLeftBorder = this.props.options?.showLeftBorder ?? true;
    const cellWidth = this.props.options?.cellWidth;
    const startOfWeek = this.props.options?.startOfWeek ?? Weekday.SUN;
    const baseSpans = this.props.options?.spans ?? [];

    this.classList.toggle("show-left-border", showLeftBorder);
    if (!this.observedWidth) return;

    let effectiveCellWidth: Option<number> = this.observedWidth / 7;
    if (cellWidth) {
      effectiveCellWidth = Math.min(effectiveCellWidth, cellWidth);
    }
    if (!effectiveCellWidth) return;

    const dates = this.calculateGridDates();
    const numCells = dates.length;

    // Effective spans for this render. The DOM-less `ghostOverlay` applies
    // the in-flight MoveSpan (`setShift`) / ResizeSpan (`setReplace`)
    // promotion — the dragged span moved to its current position, kept on
    // its captured lane, flagged `isDragging`; with no gesture active it
    // returns `baseSpans` unchanged. Capture-at-gesture-start means a
    // canonical update mid-gesture doesn't double-apply the shift.
    let spans: CalendarMonth.Span[] = this.ghostOverlay.apply(baseSpans);

    // Legacy move-ghost path — only `MoveEntryRow`'s cell-event-ghost
    // still routes here (no real span to promote into, since the source
    // rendering is a cell `EntryRow`, not a span). `MoveSpan` +
    // `ResizeSpan` use the atomic `ghostOverlay` above.
    if (this.ghostSpan) {
      const { originalSpan, offsetDays } = this.ghostSpan;

      // Two-pass approach: first compute layout without ghost to get original span's lane
      const baseLayout = computeSpanLayout(
        baseSpans,
        this.props.month,
        startOfWeek,
      );
      let originalLane = 0;
      for (const { segment, lane } of baseLayout.positionedSegments) {
        if (
          segment.originalItem.range.start.equals(originalSpan.range.start) &&
          segment.originalItem.range.end.equals(originalSpan.range.end)
        ) {
          originalLane = lane;
          break;
        }
      }

      // Remove the original span from layout (ghost will replace it visually)
      spans = spans.filter(
        (span) =>
          !span.range.start.equals(originalSpan.range.start) ||
          !span.range.end.equals(originalSpan.range.end),
      );

      const ghostRange = new NaiveDate.Range(
        originalSpan.range.start.addDays(offsetDays),
        originalSpan.range.end.addDays(offsetDays),
      );

      spans.push({
        key: "move-ghost",
        contentSig: `move-ghost|${originalSpan.key}|${ghostRange.start.toString()}|${ghostRange.end.toString()}`,
        range: ghostRange,
        preferredLane: originalLane,
        render: (info) => {
          const $el = originalSpan.render(info);
          $el.style.opacity = "0.5";
          $el.style.pointerEvents = "none";
          return $el;
        },
        isEditable: false,
      });
    }

    // Compute span layout (lane counts and positioned segments)
    const { laneCounts, positionedSegments } = computeSpanLayout(
      spans,
      this.props.month,
      startOfWeek,
    );

    // Ensure we have the right number of cells
    while (this.cells.length < numCells) {
      const $cell = CalendarMonthCell.make();
      $grid.appendChild($cell);
      this.cells.push($cell);
    }
    while (this.cells.length > numCells) {
      const $cell = this.cells.pop();
      if ($cell) {
        this.cellDateMap.delete($cell);
        $cell.remove();
      }
    }

    // Update existing cells instead of recreating them
    for (let i = 0; i < numCells; i++) {
      const date = dates[i];
      const $cell = this.cells[i];

      // Store date mapping and bind callbacks
      this.cellDateMap.set($cell, date);
      if (this.callbacks) {
        $cell.setCallbacks(this.callbacks.cell);
      }

      // Update date
      $cell.bindDate(date, this.props.options?.today);

      // Set cell size
      $cell.style.width = `${effectiveCellWidth}px`;
      $cell.style.height = `${this.props.cellHeight}px`;

      // Set content margin based on span lane count (including gaps between lanes)
      const laneCount = laneCounts[i] ?? 0;
      const spanLaneGap = this.props.options?.spanLaneGap ?? 0;
      const gapContribution = laneCount > 0 ? (laneCount - 1) * spanLaneGap : 0;
      $cell.style.setProperty(
        "--content-margin-top",
        `calc(var(--span-lane-height, 24px) * ${laneCount} + ${gapContribution}px)`,
      );

      // Determine if this date is in the current month
      const isCurrentMonth =
        date.mth === this.props.month.mth && date.yr === this.props.month.yr;
      $cell.bindCurrentMonth(isCurrentMonth);

      // Clear previous custom content and call bind function
      DomUtils.clearChildren($cell);
      this.props.bind($cell, date, isCurrentMonth);
    }

    // Render span elements
    this.renderSpans(positionedSegments, effectiveCellWidth, dates);
  }

  private renderSpans(
    segments: PositionedSegment<CalendarMonth.Span>[],
    cellWidth: number,
    gridDates: NaiveDate[],
  ): void {
    const $container = this.$("span-container");
    const laneHeight = this.props.options?.spanLaneHeight ?? 20;
    const dayNumberRowHeight = 30; // 8px padding + 18px container + 4px padding-bottom
    const spanLaneGap = this.props.options?.spanLaneGap ?? 0;

    // Build the per-segment render units, then hand them to the keyed
    // reconciler (`SpanReconciler`) for atomic DOM promotion.
    //
    // Key: `${span.key}#${segmentIdx}` where segmentIdx is the per-span
    // ordinal of this segment (0 for single-segment spans). Crucially
    // this does NOT include the grid `rowIndex` — so a span moving across
    // rows (e.g. a drag from week 1 to week 2) keeps the same key and its
    // DOM is reused, just repositioned.
    //
    // contentSig: only `span.contentSig + segment clipping flags`.
    // Position (top/left/width/lane) is NOT in the sig — it's carried in
    // `styles` and applied as inline styles on every pass (both reuse and
    // create) by the reconciler, so drag / drop / lane shift never causes
    // a recreate. The gesture and the canonical update both write into the
    // same element.
    const segmentIndexOf = new Map<string, number>();
    const units: SpanRenderUnit[] = [];

    for (const { segment, lane } of segments) {
      const span = segment.originalItem;

      const top =
        segment.rowIndex * this.props.cellHeight +
        dayNumberRowHeight +
        lane * (laneHeight + spanLaneGap);
      const left = segment.startDayOfWeek * cellWidth;
      const width =
        (segment.endDayOfWeek - segment.startDayOfWeek + 1) * cellWidth;
      const leftPx =
        segment.startDayOfWeek === 0 ? left + 1 + "px" : `${left + 1.5}px`;
      const widthPx =
        segment.startDayOfWeek === 0 ? `${width - 3}px` : `${width - 4}px`;

      // Per-span segmentIndex — stable across row shifts within the
      // span's segment list (first segment = 0, second = 1, …).
      const segmentIdx = segmentIndexOf.get(span.key) ?? 0;
      segmentIndexOf.set(span.key, segmentIdx + 1);

      units.push({
        key: `${span.key}#${segmentIdx}`,
        contentSig: [
          span.contentSig,
          segment.isFirstSegment ? 1 : 0,
          segment.isLastSegment ? 1 : 0,
          segment.isClippedStart ? 1 : 0,
          segment.isClippedEnd ? 1 : 0,
        ].join("|"),
        isDragging: span.isDragging === true,
        span,
        segment,
        lane,
        styles: { top: `${top}px`, left: leftPx, width: widthPx },
      });
    }

    this.spanReconciler.reconcile(units, {
      keyOf: (u) => u.key,
      position: (u) => u.styles,
      dim: (el, isDragging) => this.applyDraggingVisual(el, isDragging),
      create: (u, ref) =>
        this.createSpanElement(u, ref, {
          $container,
          cellWidth,
          gridDates,
          laneHeight,
        }),
    });
  }

  /**
   * Build the DOM for one span segment and wire its gesture listeners.
   * Called by the reconciler only on first sight / sig change; the
   * reconciler applies position + dragging visual afterward and on every
   * subsequent reuse. All listeners read `ref.current.span` (the fresh
   * span after a reuse-bump) but keep the create-time `segmentInfo`,
   * preserving the pre-extraction behavior where only the span was
   * refreshed across reuses.
   */
  private createSpanElement(
    unit: SpanRenderUnit,
    ref: { current: SpanRenderUnit },
    ctx: {
      $container: HTMLElement;
      cellWidth: number;
      gridDates: NaiveDate[];
      laneHeight: number;
    },
  ): HTMLElement {
    const { $container, cellWidth, gridDates, laneHeight } = ctx;
    const { span, segment, lane } = unit;

    const segmentInfo: CalendarMonth.SpanSegmentInfo = {
      span,
      lane,
      isFirstSegment: segment.isFirstSegment,
      isLastSegment: segment.isLastSegment,
      isClippedStart: segment.isClippedStart,
      isClippedEnd: segment.isClippedEnd,
    };

    // Live segment info / geometry, rebuilt from `ref.current` at gesture
    // time. Position (startDayOfWeek/rowIndex/lane) is deliberately OUT of
    // `contentSig`, so the reconciler reuses this element when the span
    // MOVES — which leaves the create-time `segment`/`segmentInfo` above
    // describing the OLD position. Gesture geometry (grab-cell math) must
    // read the current segment, or a drag after a move reads the grab cell
    // off by the prior move's offset (the repeated-drag "off by one").
    const liveSegmentInfo = (): CalendarMonth.SpanSegmentInfo => {
      const u = ref.current;
      return {
        span: u.span,
        lane: u.lane,
        isFirstSegment: u.segment.isFirstSegment,
        isLastSegment: u.segment.isLastSegment,
        isClippedStart: u.segment.isClippedStart,
        isClippedEnd: u.segment.isClippedEnd,
      };
    };

    // Build render callbacks for resize handles.
    const spanCallbacks = this.callbacks?.span;
    let $span: Option<HTMLElement> = null;
    const renderCallbacks: CalendarMonth.SpanRenderCallbacks | undefined =
      spanCallbacks
        ? {
            onHandlePointerDown: (edge) => {
              if ($span == null) return;
              const cur = ref.current.span;
              spanCallbacks.onPointerDown({
                span: cur,
                segment: liveSegmentInfo(),
                date: edge === "start" ? cur.range.start : cur.range.end,
                resizeEdge: edge,
                offset: { x: 0, y: 0 },
                $span,
              });
            },
          }
        : undefined;

    const $renderedSpan = span.render(segmentInfo, renderCallbacks);
    $span = $renderedSpan;

    // Create-once styles; the reconciler overlays top/left/width on
    // every pass (including this create).
    $renderedSpan.assignStyles({
      position: "absolute",
      "--lane-height": `${laneHeight}px`,
    });

    $container.appendChild($renderedSpan);

    if (!spanCallbacks) return $renderedSpan;

    const calculateDateFromOffset = (offset: Point): NaiveDate => {
      // Live segment — the reused element may sit at a new position than
      // the create-time `segment` describes (see `liveSegmentInfo`).
      const seg = ref.current.segment;
      const marginAdjust = seg.startDayOfWeek === 0 ? 0 : 1.5;
      const adjustedX = offset.x + marginAdjust;
      const columnWithinSpan = Math.floor(adjustedX / cellWidth);
      const dayOfWeek = Math.min(
        seg.endDayOfWeek,
        seg.startDayOfWeek + columnWithinSpan,
      );

      const gridIndex = seg.rowIndex * 7 + dayOfWeek;
      return gridDates[Math.min(gridIndex, gridDates.length - 1)];
    };

    GESTURE_MANAGER.addPointerEvent($renderedSpan, {
      onPointerDown: (offset) => {
        const date = calculateDateFromOffset(offset);
        spanCallbacks.onPointerDown({
          span: ref.current.span,
          segment: liveSegmentInfo(),
          date,
          offset,
          $span: $renderedSpan,
        });
      },
      onClick: (_, offset) => {
        const date = calculateDateFromOffset(offset);
        spanCallbacks.onPointerUp({
          span: ref.current.span,
          segment: liveSegmentInfo(),
          date,
          $span: $renderedSpan,
        });
      },
      onContextMenu: (_, offset) => {
        const date = calculateDateFromOffset(offset);
        // Convert span-relative offset to cell-relative offset.
        // The span starts at segment.startDayOfWeek within the row.
        const columnWithinSpan = Math.floor(offset.x / cellWidth);
        const cellOffsetX = offset.x - (columnWithinSpan * cellWidth);
        const cellOffsetY = offset.y;
        spanCallbacks.onContextMenu({
          span: ref.current.span,
          segment: liveSegmentInfo(),
          date,
          offset: { x: cellOffsetX, y: cellOffsetY },
          $span: $renderedSpan,
        });
      },
    });

    // Handle pointer move directly (not through GESTURE_MANAGER)
    $renderedSpan.onpointermove = (e) => {
      // Use client coordinates to calculate which grid cell the pointer is over
      // This works correctly even when the span has moved during drag
      const containerRect = $container.getBoundingClientRect();
      const relativeX = e.clientX - containerRect.left;
      const relativeY = e.clientY - containerRect.top;

      // Calculate grid position
      const numRows = Math.ceil(gridDates.length / 7);
      const col = Math.floor(relativeX / cellWidth);
      const row = Math.floor(relativeY / (containerRect.height / numRows));
      const gridIndex = Math.min(
        Math.max(0, row * 7 + col),
        gridDates.length - 1,
      );
      const date = gridDates[gridIndex];

      const offset = { x: e.offsetX, y: e.offsetY };
      spanCallbacks.onPointerMove({
        span: ref.current.span,
        segment: liveSegmentInfo(),
        date,
        offset,
        $span: $renderedSpan,
      });
    };

    return $renderedSpan;
  }

  /**
   * Toggle the decorative "dragging" visual on a span element via inline
   * styles. This is a **side-channel** — it sits outside the keyed
   * reconciliation's `contentSig`, so flipping the dragging state never
   * triggers a recreate. Called on both reused and freshly-created
   * elements so the visual always matches `span.isDragging`.
   */
  private applyDraggingVisual($el: HTMLElement, isDragging: boolean): void {
    if (isDragging) {
      $el.style.opacity = "0.5";
      $el.style.pointerEvents = "none";
    } else {
      $el.style.opacity = "";
      $el.style.pointerEvents = "";
    }
  }

  private calculateGridDates(): NaiveDate[] {
    const dates: NaiveDate[] = [];

    // Get first day of the month
    const firstDay = NaiveDate.fromYmd1(
      this.props.month.yr,
      this.props.month.mth,
      1,
    ).exp();

    // Calculate padding at start
    const firstDayWeekday = firstDay.dayOfWeek;
    const startPadding = this.calculateStartPadding(firstDayWeekday);

    // Add padding days from previous month
    for (let i = startPadding; i > 0; i--) {
      dates.push(firstDay.addDays(-i));
    }

    // Add all days of current month
    for (let day = 1; day <= 31; ++day) {
      const dt = NaiveDate.fromYmd1(
        this.props.month.yr,
        this.props.month.mth,
        day,
      );
      if (dt.isErr) continue;
      dates.push(dt.asOk()!);
    }

    // Calculate padding at end to complete the grid (6 weeks = 42 days)
    const totalCells = 42; // 6 weeks × 7 days
    const endPadding = totalCells - dates.length;

    // Add padding days from next month
    const lastDay = dates[dates.length - 1];
    for (let i = 1; i <= endPadding; i++) {
      dates.push(lastDay.addDays(i));
    }

    this.style.setProperty(
      "--num-rows",
      String(Math.ceil((dates.length + 1) / 7)),
    );
    return dates;
  }

  private calculateStartPadding(firstDayWeekday: Weekday): number {
    // Calculate how many days to pad at the start based on startOfWeek
    const startOfWeek = this.props.options?.startOfWeek ?? Weekday.SUN;
    const startOfWeekValue = startOfWeek.dow;
    const firstDayValue = firstDayWeekday.dow;

    let padding = firstDayValue - startOfWeekValue;
    if (padding < 0) {
      padding += 7;
    }

    return padding;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
      }

      #wrapper {
        position: relative;
      }

      #grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        grid-template-rows: repeat(6, 1fr);
      }

      #span-container {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        z-index: 1;
      }

      #span-container > * {
        pointer-events: auto;
      }

      #grid-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        grid-template-rows: repeat(6, 1fr);
      }

      /* Vertical dividers */
      #grid-overlay::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        right: 0;
        background-image: repeating-linear-gradient(
          to right,
          transparent,
          transparent calc(100% / 7 - 1px),
          var(--divider) calc(100% / 7 - 1px),
          var(--divider) calc(100% / 7)
        );
      }

      /* Horizontal dividers */
      #grid-overlay::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        right: 0;
        background-image: repeating-linear-gradient(
          to bottom,
          transparent,
          transparent calc(100% / 6 - 1px),
          var(--divider) calc(100% / 6 - 1px),
          var(--divider) calc(100% / 6)
        );
      }

      #wrapper::before {
        position: absolute;
        content: "";
        inset: 0px;
        width: 100%;
        height: 100%;
        border-top: 1px solid var(--divider);
        z-index: 1;
        pointer-events: none;
      }

      :host(.show-left-border) #wrapper::before {
        border-left: 1px solid var(--divider);
      }

      #highlight {
        position: absolute;
        display: none;
        pointer-events: none;
        z-index: 10;
        box-sizing: border-box;
        // border: 1px solid var(--blue, #0066cc);
        background: rgba(0, 102, 204, 0.05);
      }
    `,
  ];

  static $html = html`
    <div id="wrapper">
      <div id="grid"></div>
      <div id="span-container"></div>
      <div id="grid-overlay"></div>
      <div id="highlight"></div>
      <slot></slot>
    </div>
  `;
}

export namespace CalendarMonth {
  export type BindFunction = (
    cell: CalendarMonthCell,
    date: NaiveDate,
    isCurrentMonth: boolean,
  ) => void;

  export type Options = Optional<{
    cellWidth: number;
    startOfWeek: Weekday;
    showLeftBorder: boolean;
    today: NaiveDate;
    spans: Span[];
    spanLaneGap: number;
    spanLaneHeight: number;
  }>;

  export type Props = {
    month: Ym1Like;
    bind: BindFunction;
    cellHeight: number;
    options?: Optional<Options>;
  };

  export interface SpanRenderCallbacks {
    onHandlePointerDown?: (edge: "start" | "end") => void;
  }

  export interface Span {
    /**
     * Stable identity carried from the span's source (e.g. an event id).
     * Used as the reconciliation key in `renderSpans` — MUST be unique
     * per logical span and MUST NOT be derived from `range`/content, so
     * two spans that happen to share a date range never collide.
     */
    key: string;
    /**
     * Signature of the span's visible content (title, color, and any
     * other field its `render` reads). When this + the segment's
     * clipping flags are unchanged across a render, `renderSpans`
     * reuses the existing DOM node instead of recreating it; position
     * (top/left/width/lane) is then applied as inline styles so a
     * drag, drop, or lane shift moves the same DOM rather than
     * tearing it down. Producers MUST exclude position **and** the
     * `isDragging` decorative flag from this signature.
     */
    contentSig: string;
    range: NaiveDate.Range;
    render: (
      info: SpanSegmentInfo,
      callbacks?: SpanRenderCallbacks,
    ) => HTMLElement;
    isEditable?: boolean;
    /** Mark as pending to prevent existing span gestures from handling it */
    isPending?: boolean;
    /** Hint for layout algorithm - try to place in this lane if available */
    preferredLane?: number;
    /**
     * Decorative "currently being dragged" flag. **Excluded from
     * `contentSig` by all producers** — `renderSpans` toggles the
     * dragging visual on the existing DOM via a side-channel (inline
     * styles) instead of through reconciliation. Flipping this flag
     * therefore never triggers a recreate. Set by `renderGrid` when
     * applying a `dragOffset` in place; producers should not set it.
     */
    isDragging?: boolean;
  }

  export interface SpanSegmentInfo {
    span: Span;
    lane: number;
    isFirstSegment: boolean;
    isLastSegment: boolean;
    isClippedStart: boolean;
    isClippedEnd: boolean;
  }

  export type CellCallbacks = CalendarMonthCell.Callbacks;

  export type SpanCallbacks = {
    onPointerDown: (event: {
      span: Span;
      segment: SpanSegmentInfo;
      date: NaiveDate;
      offset: Point;
      $span: HTMLElement;
      /** Set when pointer down is on a resize handle */
      resizeEdge?: "start" | "end";
    }) => void;
    onPointerUp: (event: {
      span: Span;
      segment: SpanSegmentInfo;
      date: NaiveDate;
      $span: HTMLElement;
    }) => void;
    onPointerMove: (event: {
      span: Span;
      segment: SpanSegmentInfo;
      date: NaiveDate;
      offset: Point;
      $span: HTMLElement;
    }) => { shouldCapturePointer: boolean };
    onContextMenu: (event: {
      span: Span;
      segment: SpanSegmentInfo;
      date: NaiveDate;
      offset: Point;
      $span: HTMLElement;
    }) => void;
    onSpanMoved?: (event: {
      span: Span;
      segment: SpanSegmentInfo;
      fromDate: NaiveDate;
      toDate: NaiveDate;
    }) => void;
  };

  export type Callbacks = {
    cell: CellCallbacks;
    span: SpanCallbacks;
  };

  export namespace Callbacks {
    export const DEFAULT_CELL: CellCallbacks = {
      onPointerDown: Constants.EMPTY_FUNCTION,
      onPointerUp: Constants.EMPTY_FUNCTION,
      onContextMenu: Constants.EMPTY_FUNCTION,
      onPointerMove: () => ({ shouldCapturePointer: false }),
      onPointerEnter: Constants.EMPTY_FUNCTION,
      onPointerLeave: Constants.EMPTY_FUNCTION,
    };

    export const DEFAULT_SPAN: SpanCallbacks = {
      onPointerDown: Constants.EMPTY_FUNCTION,
      onPointerUp: Constants.EMPTY_FUNCTION,
      onPointerMove: () => ({ shouldCapturePointer: false }),
      onContextMenu: Constants.EMPTY_FUNCTION,
    };

    export const DEFAULT: Callbacks = {
      cell: DEFAULT_CELL,
      span: DEFAULT_SPAN,
    };
  }
}
