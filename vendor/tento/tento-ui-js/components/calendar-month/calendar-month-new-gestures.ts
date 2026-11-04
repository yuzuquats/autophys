import { NaiveDate } from "@tento-chrono";
import { Point } from "@tento-core/point";
import { CalendarMonth } from "./calendar-month";
import { CalendarMonthGesture } from "./calendar-month-gesture";

export namespace CalendarMonthNewGestures {
  export interface PendingEvent {
    date: NaiveDate;
    title: Option<string>;
    isAllDay: boolean;
  }

  export interface Actions {
    /**
     * Called when a create gesture starts (click or drag).
     * Returns false to cancel the gesture.
     */
    onCreateStart(date: NaiveDate): boolean;

    /**
     * Called during drag to update the pending span range.
     * Only called after onCreateStart returns true.
     */
    onCreateDrag(dateRange: NaiveDate.Range): void;

    /**
     * Called when drag completes to show the form.
     */
    onCreateDragEnd(dateRange: NaiveDate.Range): void;

    /**
     * Called to get the pending span to display on the calendar.
     */
    getPendingSpan(): Option<CalendarMonth.Span>;

    /**
     * Check if a create is currently in progress.
     */
    isCreateInProgress(): boolean;

    /**
     * Called to hide the create form (during move/resize).
     * Should keep the pending span visible.
     */
    hideDetails(): void;

    /**
     * Called to reshow the create form after move/resize completes.
     */
    reshowDetails(dateRange: NaiveDate.Range): void;

    /**
     * Check if a cross-system dismissal should block this gesture.
     * Called by gestures in canHandle() to coordinate with other systems
     * (e.g., timeline view, all-day events plugin).
     *
     * @param isPointerDown - true if this is a pointer down event
     * @returns true if the gesture should be blocked (other system was dismissed)
     */
    shouldBlockForCrossSystemDismissal?(isPointerDown: boolean): boolean;

    /** True when a context menu is currently open. */
    isContextMenuActive?(): boolean;

    /** Dismiss the currently open context menu. */
    dismissContextMenu?(): void;
  }

  export class ClickToCreate<
    TInfo extends CalendarMonthGesture.Info = CalendarMonthGesture.Info,
  > extends CalendarMonthGesture.Default<TInfo> {
    identifier = "click-to-create";

    private pointerDownInfo: Option<TInfo> = null;

    constructor(private actions: Actions) {
      super();
    }

    canHandle(event: CalendarMonthGesture.Event<TInfo>): boolean {
      const pointerDown = event.internal.pointerDown;
      const isPointerDown = !!pointerDown;

      // Check cross-system state FIRST - dismiss other systems if needed
      if (
        this.actions.shouldBlockForCrossSystemDismissal?.(isPointerDown)
      ) {
        return false;
      }

      // Dismiss context menu on click but don't create
      if (this.actions.isContextMenuActive?.()) {
        this.actions.dismissContextMenu?.();
        return false;
      }

      // If a create is already in progress, don't start another via click
      // (user must drag to start a new one, or click to dismiss)
      if (this.actions.isCreateInProgress()) {
        return false;
      }

      if (!pointerDown) {
        return false;
      }

      // Don't handle if clicking on a span (existing all-day event)
      if (pointerDown.onSpan) {
        return false;
      }

      // Don't handle if this is an event list row drag
      if (event.internal.entryRowPointerDown) {
        return false;
      }

      return true;
    }

    allowsConcurrentGestures(): boolean {
      return true;
    }

    onPointerDown(e: CalendarMonthGesture.Event.PointerDown<TInfo>) {
      this.pointerDownInfo = e.info;
      return { finished: false };
    }

    onPointerUp(e: CalendarMonthGesture.Event.PointerUp<TInfo>) {
      // Only trigger if pointer up is on the same cell as pointer down
      // This distinguishes a click from a drag
      if (!this.pointerDownInfo) return { finished: true };

      const date = this.pointerDownInfo.date;
      const sameCell = date.equals(e.info.date);
      this.pointerDownInfo = null;

      if (!sameCell) return { finished: true };
      if (!this.actions.onCreateStart(date)) return { finished: true };

      // Initialize state and show form for single-day event
      const singleDayRange = new NaiveDate.Range(date, date);
      this.actions.onCreateDragEnd(singleDayRange);
      return { finished: true };
    }

    onFinished(_: Option<CalendarMonthGesture<TInfo>>): void {
      this.pointerDownInfo = null;
    }
  }

  /**
   * Gesture that handles dragging across multiple cells to create a multi-day event.
   * Starts as a weak gesture (concurrent with ClickToCreate), becomes strong when
   * the pointer moves to a different cell.
   */
  export class DragToCreate<
    TInfo extends CalendarMonthGesture.Info = CalendarMonthGesture.Info,
  > extends CalendarMonthGesture.Default<TInfo> {
    identifier = "drag-to-create";

    private state: Option<{
      startDate: NaiveDate;
      currentDate: NaiveDate;
      holdingWeakly: boolean;
      startOffset: Point;
    }> = null;

    constructor(private actions: Actions) {
      super();
    }

    canHandle(event: CalendarMonthGesture.Event<TInfo>): boolean {
      const pointerDown = event.internal.pointerDown;

      // Drag-to-create is NOT blocked by cross-system dismissal guard.
      // Event details will be dismissed when the drag produces a new event.
      // Only click-to-create should be blocked.

      const onSpan = pointerDown?.onSpan ?? false;
      const entryRowPointerDown = event.internal.entryRowPointerDown;

      // Allow drag-to-create even when a pending event exists - it will
      // dismiss the old one and start a new one
      return !!pointerDown && !onSpan && !entryRowPointerDown;
    }

    allowsConcurrentGestures(): boolean {
      return this.state?.holdingWeakly ?? true;
    }

    private static JITTER_THRESHOLD_PX = 8;

    onPointerDown(e: CalendarMonthGesture.Event.PointerDown<TInfo>) {
      this.state = {
        startDate: e.info.date,
        currentDate: e.info.date,
        holdingWeakly: true,
        startOffset: e.offset,
      };
      return { finished: false };
    }

    onPointerMove(e: CalendarMonthGesture.Event.PointerMove<TInfo>) {
      const currentDate = e.info.date;
      if (!this.state) return { shouldCapturePointer: false };

      // Transition from weak to strong on cell change OR jitter threshold
      if (this.state.holdingWeakly) {
        const cellChanged = !currentDate.equals(this.state.startDate);
        const dx = e.offset.x - this.state.startOffset.x;
        const dy = e.offset.y - this.state.startOffset.y;
        const jitterExceeded = Math.sqrt(dx * dx + dy * dy) > DragToCreate.JITTER_THRESHOLD_PX;

        if (cellChanged || jitterExceeded) {
          this.state.holdingWeakly = false;
          if (!this.actions.onCreateStart(this.state.startDate)) {
            this.state = null;
            return { shouldCapturePointer: false };
          }
          this.state.currentDate = currentDate;
          this.actions.onCreateDrag(this.buildDateRange());
          return { shouldCapturePointer: false };
        }

        return { shouldCapturePointer: false };
      }

      // Update the date range (diff-based rendering handles efficiency)
      this.state.currentDate = currentDate;
      this.actions.onCreateDrag(this.buildDateRange());

      return { shouldCapturePointer: false };
    }

    onPointerUp(_e: CalendarMonthGesture.Event.PointerUp<TInfo>) {
      if (!this.state || this.state.holdingWeakly) {
        this.state = null;
        return { finished: true };
      }

      const dateRange = this.buildDateRange();
      this.actions.onCreateDrag(dateRange);
      this.actions.onCreateDragEnd(dateRange);

      this.state = null;
      return { finished: true };
    }

    onFinished(_cancelledBy: Option<CalendarMonthGesture<TInfo>>): void {
      this.state = null;
    }

    private buildDateRange(): NaiveDate.Range {
      const { startDate, currentDate } = this.state!;
      if (startDate.dse <= currentDate.dse) {
        return new NaiveDate.Range(startDate, currentDate);
      } else {
        return new NaiveDate.Range(currentDate, startDate);
      }
    }
  }

  /**
   * Gesture that dismisses an in-progress create when clicking anywhere on the calendar.
   * This gesture only activates when actions.isCreateInProgress() is true.
   */
  export class DismissCreate<
    TInfo extends CalendarMonthGesture.Info = CalendarMonthGesture.Info,
  > extends CalendarMonthGesture.Default<TInfo> {
    identifier = "dismiss-create";

    private pointerDownInfo: Option<TInfo> = null;

    constructor(
      private actions: Actions,
      private onDismiss: () => void,
    ) {
      super();
    }

    canHandle(event: CalendarMonthGesture.Event<TInfo>): boolean {
      const pointerDown = event.internal.pointerDown;
      const isPointerDown = !!pointerDown;

      // Check cross-system state FIRST - dismiss other systems if needed
      if (
        this.actions.shouldBlockForCrossSystemDismissal?.(isPointerDown)
      ) {
        return false;
      }

      if (!this.actions.isCreateInProgress()) return false;

      if (!pointerDown) return false;
      // Don't dismiss when clicking on spans or event list rows -
      // those clicks should show the event details instead
      if (pointerDown.onSpan) return false;
      if (event.internal.entryRowPointerDown) return false;

      return true;
    }

    allowsConcurrentGestures(): boolean {
      // Allow concurrent so DragToCreate can take over if user drags
      return true;
    }

    onPointerDown(e: CalendarMonthGesture.Event.PointerDown<TInfo>) {
      this.pointerDownInfo = e.info;
      return { finished: false };
    }

    onPointerUp(e: CalendarMonthGesture.Event.PointerUp<TInfo>) {
      if (!this.pointerDownInfo) return { finished: true };

      const sameCell = this.pointerDownInfo.date.equals(e.info.date);
      this.pointerDownInfo = null;

      // Dismiss on same-cell click (if user dragged, DragToCreate handles it)
      if (sameCell) this.onDismiss();
      return { finished: true };
    }

    onFinished(_: Option<CalendarMonthGesture<TInfo>>): void {
      this.pointerDownInfo = null;
    }
  }

  /**
   * Gesture that handles moving the pending span to a new position.
   * Hides the create form during drag and reshows it after pointer up.
   */
  export class Move<
    TInfo extends CalendarMonthGesture.Info = CalendarMonthGesture.Info,
  > extends CalendarMonthGesture.Default<TInfo> {
    identifier = "move";

    private state: Option<{
      holdingWeakly: boolean;
      startDate: NaiveDate;
      originalDateRange: NaiveDate.Range;
      finishedDate: Option<NaiveDate>;
    }> = null;

    constructor(private actions: Actions) {
      super();
    }

    canHandle(event: CalendarMonthGesture.Event<TInfo>): boolean {
      const pointerDown = event.internal.pointerDown;
      const isPointerDown = !!pointerDown;

      // Check cross-system state FIRST - dismiss other systems if needed
      if (
        this.actions.shouldBlockForCrossSystemDismissal?.(isPointerDown)
      ) {
        return false;
      }

      if (!this.actions.isCreateInProgress()) return false;

      if (!pointerDown?.onSpan) return false;

      const pendingSpan = this.actions.getPendingSpan();
      if (!pendingSpan) return false;

      const span = pointerDown.span;
      if (!span) return false;

      // Verify it's the pending span by matching date range
      if (!span.range.start.equals(pendingSpan.range.start)) return false;
      if (!span.range.end.equals(pendingSpan.range.end)) return false;

      return true;
    }

    allowsConcurrentGestures(): boolean {
      return this.state?.holdingWeakly ?? true;
    }

    onPointerDown(e: CalendarMonthGesture.Event.PointerDown<TInfo>) {
      const pendingSpan = this.actions.getPendingSpan();
      if (!pendingSpan) {
        return { finished: true };
      }

      this.state = {
        holdingWeakly: true,
        startDate: e.info.date,
        originalDateRange: pendingSpan.range,
        finishedDate: null,
      };
      return { finished: false };
    }

    onPointerMove(e: CalendarMonthGesture.Event.PointerMove<TInfo>) {
      if (!this.state) return { shouldCapturePointer: false };

      const currentDate = e.info.date;
      const daysDelta = currentDate.differenceInDays(this.state.startDate);

      // Become strong when moved to different cell
      if (this.state.holdingWeakly && daysDelta !== 0) {
        this.state.holdingWeakly = false;
        this.actions.hideDetails();
      }

      if (this.state.holdingWeakly) return { shouldCapturePointer: false };

      // Update the span position (diff-based rendering handles efficiency)
      const newStart = this.state.originalDateRange.start.addDays(daysDelta);
      const newEnd = this.state.originalDateRange.end.addDays(daysDelta);
      const newRange = new NaiveDate.Range(newStart, newEnd);
      this.actions.onCreateDrag(newRange);

      return { shouldCapturePointer: false };
    }

    onPointerUp(e: CalendarMonthGesture.Event.PointerUp<TInfo>) {
      if (this.state) {
        this.state.finishedDate = e.info.date;
      }
      return { finished: true };
    }

    onFinished(cancelledBy: Option<CalendarMonthGesture<TInfo>>): void {
      if (!this.state || cancelledBy) {
        this.state = null;
        return;
      }

      // If we moved (wasn't just a click), update to final position
      if (!this.state.holdingWeakly && this.state.finishedDate) {
        const daysDelta = this.state.finishedDate.differenceInDays(
          this.state.startDate,
        );
        const newStart = this.state.originalDateRange.start.addDays(daysDelta);
        const newEnd = this.state.originalDateRange.end.addDays(daysDelta);
        const newRange = new NaiveDate.Range(newStart, newEnd);
        this.actions.onCreateDrag(newRange);
        this.actions.reshowDetails(newRange);
      }

      this.state = null;
    }
  }

  /**
   * Gesture that handles resizing the pending span by dragging its edges.
   * Only available for multi-day spans. Hides the form during resize.
   */
  export class Resize<
    TInfo extends CalendarMonthGesture.Info = CalendarMonthGesture.Info,
  > extends CalendarMonthGesture.Default<TInfo> {
    identifier = "resize";

    private state: Option<{
      holdingWeakly: boolean;
      startDate: NaiveDate;
      originalDateRange: NaiveDate.Range;
      resizeEdge: "start" | "end";
      finishedDate: Option<NaiveDate>;
    }> = null;

    constructor(private actions: Actions) {
      super();
    }

    canHandle(event: CalendarMonthGesture.Event<TInfo>): boolean {
      const pointerDown = event.internal.pointerDown;
      const isPointerDown = !!pointerDown;

      // Check cross-system state FIRST - dismiss other systems if needed
      if (
        this.actions.shouldBlockForCrossSystemDismissal?.(isPointerDown)
      ) {
        return false;
      }

      if (!this.actions.isCreateInProgress()) return false;

      if (!pointerDown?.onSpan) return false;
      if (!pointerDown.resizeEdge) return false;

      const pendingSpan = this.actions.getPendingSpan();
      if (!pendingSpan) return false;

      const span = pointerDown.span;
      if (!span?.range.start.equals(pendingSpan.range.start)) return false;

      return true;
    }

    allowsConcurrentGestures(): boolean {
      return this.state?.holdingWeakly ?? true;
    }

    onPointerDown(e: CalendarMonthGesture.Event.PointerDown<TInfo>) {
      if (!e.resizeEdge) {
        return { finished: true };
      }

      const pendingSpan = this.actions.getPendingSpan();
      if (!pendingSpan) {
        return { finished: true };
      }

      this.state = {
        holdingWeakly: true,
        startDate: e.info.date,
        originalDateRange: pendingSpan.range,
        resizeEdge: e.resizeEdge,
        finishedDate: null,
      };
      return { finished: false };
    }

    onPointerMove(e: CalendarMonthGesture.Event.PointerMove<TInfo>) {
      if (!this.state) return { shouldCapturePointer: false };

      const currentDate = e.info.date;
      const daysDelta = currentDate.differenceInDays(this.state.startDate);

      if (this.state.holdingWeakly && daysDelta !== 0) {
        this.state.holdingWeakly = false;
        this.actions.hideDetails();
      }

      if (this.state.holdingWeakly) return { shouldCapturePointer: false };

      // Calculate new range based on which edge we're dragging
      let newStart = this.state.originalDateRange.start;
      let newEnd = this.state.originalDateRange.end;

      if (this.state.resizeEdge === "start") {
        newStart = this.state.originalDateRange.start.addDays(daysDelta);
        // If start goes past end, swap edges
        // e.g., span 3→7, drag start to 10 → new span is 8→10
        if (newStart.dse > newEnd.dse) {
          const draggedPosition = newStart;
          newStart = newEnd.addDays(1);
          newEnd = draggedPosition;
          // Swap the edge we're dragging so subsequent moves work correctly
          this.state.resizeEdge = "end";
          this.state.originalDateRange = new NaiveDate.Range(newStart, newEnd);
          this.state.startDate = currentDate;
        }
      } else {
        newEnd = this.state.originalDateRange.end.addDays(daysDelta);
        // If end goes before start, swap edges
        // e.g., span 3→7, drag end to 1 → new span is 1→2
        if (newEnd.dse < newStart.dse) {
          const draggedPosition = newEnd;
          newEnd = newStart.addDays(-1);
          newStart = draggedPosition;
          // Swap the edge we're dragging so subsequent moves work correctly
          this.state.resizeEdge = "start";
          this.state.originalDateRange = new NaiveDate.Range(newStart, newEnd);
          this.state.startDate = currentDate;
        }
      }

      const newRange = new NaiveDate.Range(newStart, newEnd);
      this.actions.onCreateDrag(newRange);

      return { shouldCapturePointer: false };
    }

    onPointerUp(e: CalendarMonthGesture.Event.PointerUp<TInfo>) {
      if (this.state) {
        this.state.finishedDate = e.info.date;
      }
      return { finished: true };
    }

    onFinished(cancelledBy: Option<CalendarMonthGesture<TInfo>>): void {
      if (!this.state || cancelledBy) {
        this.state = null;
        return;
      }

      if (!this.state.holdingWeakly) {
        const pendingSpan = this.actions.getPendingSpan();
        if (pendingSpan) {
          this.actions.reshowDetails(pendingSpan.range);
        }
      }

      this.state = null;
    }
  }
}
