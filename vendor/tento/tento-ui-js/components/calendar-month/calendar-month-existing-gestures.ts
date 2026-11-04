import { NaiveDate } from "@tento-chrono";
import { Point } from "@tento-core/point";
import type { ListItem } from "../entry-list/list-item";
import { Toast } from "../toast/toast";
import { CalendarMonth } from "./calendar-month";
import { CalendarMonthGesture } from "./calendar-month-gesture";

export namespace CalendarMonthExistingGestures {
  export type MoveSpanCallback<TInfo extends CalendarMonthGesture.Info> =
    (event: {
      span: CalendarMonth.Span;
      segment: CalendarMonth.SpanSegmentInfo;
      fromDate: NaiveDate;
      toDate: NaiveDate;
      info: TInfo;
    }) => void;

  export type ResizeSpanCallback<TInfo extends CalendarMonthGesture.Info> =
    (event: {
      span: CalendarMonth.Span;
      originalRange: NaiveDate.Range;
      newRange: NaiveDate.Range;
      info: TInfo;
    }) => void;

  export type GhostUpdateCallback = (
    span: Option<CalendarMonth.Span>,
    offsetDays: number,
  ) => void;

  export type ResizeGhostUpdateCallback = (
    span: Option<CalendarMonth.Span>,
    newRange: Option<NaiveDate.Range>,
  ) => void;

  export type ClickSpanCallback<TInfo extends CalendarMonthGesture.Info> =
    (event: {
      span: CalendarMonth.Span;
      segment: CalendarMonth.SpanSegmentInfo;
      info: TInfo;
      $span: HTMLElement;
    }) => void;

  export class MoveSpan<
    TInfo extends CalendarMonthGesture.Info = CalendarMonthGesture.Info,
  > extends CalendarMonthGesture.Default<TInfo> {
    identifier = "move-span";

    private startSpan: Option<CalendarMonth.Span> = null;
    private startSegment: Option<CalendarMonth.SpanSegmentInfo> = null;
    private startDate: Option<NaiveDate> = null;
    private currentDate: Option<NaiveDate> = null;
    private $startSpan: Option<HTMLElement> = null;
    private hasMoved: boolean = false;

    constructor(
      private onMoved?: Option<MoveSpanCallback<TInfo>>,
      private onGhostUpdate?: Option<GhostUpdateCallback>,
      private onClick?: Option<ClickSpanCallback<TInfo>>,
    ) {
      super();
    }

    canHandle(event: CalendarMonthGesture.Event<TInfo>) {
      const pointerDown = event.internal.pointerDown;
      if (!pointerDown) return false;
      if (!pointerDown.onSpan || !pointerDown.span) return false;
      // Don't handle pending spans - let CalendarMonthNewGestures.Move handle those
      if (pointerDown.span.isPending) return false;
      // A pointer-down on a resize handle is a resize, not a move. The
      // gesture manager runs concurrent gestures simultaneously until
      // one flips `hasMoved`, so without this gate MoveSpan and
      // ResizeSpan both fire their ghost callbacks on every move and
      // step on each other (`setDragOffset` vs `setResizeOverride`).
      if (pointerDown.resizeEdge) return false;
      // Handle all other spans - we'll check editability only for moves
      return true;
    }

    allowsConcurrentGestures() {
      return !this.hasMoved;
    }

    onPointerDown(e: CalendarMonthGesture.Event.PointerDown<TInfo>) {
      if (!e.onSpan || !e.span || !e.segment) {
        return { finished: true };
      }
      // Mirror of `canHandle`'s resizeEdge guard — defends against the
      // direct-dispatch path that doesn't re-check `canHandle`.
      if (e.resizeEdge) {
        return { finished: true };
      }

      this.startSpan = e.span;
      this.startSegment = e.segment;
      this.startDate = e.info.date;
      this.currentDate = e.info.date;
      this.$startSpan = e.$span;
      this.hasMoved = false;

      return { finished: false };
    }

    onPointerMove(e: CalendarMonthGesture.Event.PointerMove<TInfo>) {
      if (!this.startDate || !this.startSpan)
        return { shouldCapturePointer: false };
      // A non-editable span never starts a drag: no ghost, and the gesture
      // never claims the pointer (a release still clicks or explains).
      if (this.startSpan.isEditable === false)
        return { shouldCapturePointer: false };

      const prevDate = this.currentDate;
      this.currentDate = e.info.date;

      if (prevDate && !prevDate.equals(e.info.date)) {
        this.hasMoved = true;
      }

      if (this.hasMoved) {
        const offsetDays = this.currentDate.differenceInDays(this.startDate);
        this.onGhostUpdate?.(this.startSpan, offsetDays);
      }

      return { shouldCapturePointer: false };
    }

    onPointerUp(e: CalendarMonthGesture.Event.PointerUp<TInfo>) {
      if (!this.startSpan || !this.startSegment || !this.startDate) {
        this.reset();
        return { finished: true };
      }

      const toDate = e.info.date;
      const fromDate = this.startDate;
      const span = this.startSpan;
      const segment = this.startSegment;

      // Click without drag - show event details
      if (fromDate.equals(toDate)) {
        if (!this.hasMoved && this.$startSpan != null) {
          this.onClick?.({
            span,
            segment,
            info: e.info,
            $span: this.$startSpan,
          });
        }
        this.reset();
        return { finished: true };
      }

      // Moved to different cell
      if (span.isEditable === false) {
        Toast.info("This event cannot be moved");
      } else {
        this.onMoved?.({ span, segment, fromDate, toDate, info: e.info });
      }

      this.reset();
      return { finished: true };
    }

    onContextMenu(_: CalendarMonthGesture.Event.ContextMenu<TInfo>) {
      this.reset();
      return { finished: true };
    }

    onFinished(_: Option<CalendarMonthGesture<TInfo>>) {
      this.reset();
    }

    private reset() {
      // Clear ghost when drag ends
      this.onGhostUpdate?.(null, 0);

      this.startSpan = null;
      this.startSegment = null;
      this.startDate = null;
      this.currentDate = null;
      this.$startSpan = null;
      this.hasMoved = false;
    }
  }

  export class ResizeSpan<
    TInfo extends CalendarMonthGesture.Info = CalendarMonthGesture.Info,
  > extends CalendarMonthGesture.Default<TInfo> {
    identifier = "resize-span";

    private state: Option<{
      span: CalendarMonth.Span;
      originalRange: NaiveDate.Range;
      startDate: NaiveDate;
      resizeEdge: "start" | "end";
      hasMoved: boolean;
    }> = null;

    constructor(
      private onResized?: Option<ResizeSpanCallback<TInfo>>,
      private onGhostUpdate?: Option<ResizeGhostUpdateCallback>,
    ) {
      super();
    }

    canHandle(event: CalendarMonthGesture.Event<TInfo>) {
      const pointerDown = event.internal.pointerDown;
      if (!pointerDown) return false;
      if (!pointerDown.onSpan || !pointerDown.span) return false;
      // Don't handle pending spans - let CalendarMonthNewGestures.Resize handle those
      if (pointerDown.span.isPending) return false;
      // Only handle if a resize edge was clicked
      if (!pointerDown.resizeEdge) return false;
      // Only handle editable spans
      if (pointerDown.span.isEditable === false) return false;
      return true;
    }

    allowsConcurrentGestures() {
      return !this.state?.hasMoved;
    }

    onPointerDown(e: CalendarMonthGesture.Event.PointerDown<TInfo>) {
      if (!e.onSpan || !e.span || !e.resizeEdge) {
        return { finished: true };
      }

      this.state = {
        span: e.span,
        originalRange: e.span.range,
        startDate: e.info.date,
        resizeEdge: e.resizeEdge,
        hasMoved: false,
      };

      return { finished: false };
    }

    onPointerMove(e: CalendarMonthGesture.Event.PointerMove<TInfo>) {
      if (!this.state) return { shouldCapturePointer: false };

      const currentDate = e.info.date;
      const daysDelta = currentDate.differenceInDays(this.state.startDate);

      if (!this.state.hasMoved && daysDelta !== 0) {
        this.state.hasMoved = true;
      }

      if (!this.state.hasMoved) return { shouldCapturePointer: false };

      // Calculate new range based on which edge we're dragging
      let newStart = this.state.originalRange.start;
      let newEnd = this.state.originalRange.end;

      if (this.state.resizeEdge === "start") {
        newStart = this.state.originalRange.start.addDays(daysDelta);
        // If start goes past end, swap edges
        if (newStart.dse > newEnd.dse) {
          const draggedPosition = newStart;
          newStart = newEnd.addDays(1);
          newEnd = draggedPosition;
          // Swap the edge we're dragging
          this.state.resizeEdge = "end";
          this.state.originalRange = new NaiveDate.Range(newStart, newEnd);
          this.state.startDate = currentDate;
        }
      } else {
        newEnd = this.state.originalRange.end.addDays(daysDelta);
        // If end goes before start, swap edges
        if (newEnd.dse < newStart.dse) {
          const draggedPosition = newEnd;
          newEnd = newStart.addDays(-1);
          newStart = draggedPosition;
          // Swap the edge we're dragging
          this.state.resizeEdge = "start";
          this.state.originalRange = new NaiveDate.Range(newStart, newEnd);
          this.state.startDate = currentDate;
        }
      }

      const newRange = new NaiveDate.Range(newStart, newEnd);
      this.onGhostUpdate?.(this.state.span, newRange);

      return { shouldCapturePointer: false };
    }

    onPointerUp(e: CalendarMonthGesture.Event.PointerUp<TInfo>) {
      if (!this.state) {
        this.reset();
        return { finished: true };
      }

      const { span, hasMoved, originalRange, resizeEdge, startDate } =
        this.state;

      if (!hasMoved) {
        this.reset();
        return { finished: true };
      }

      // Calculate final range
      const daysDelta = e.info.date.differenceInDays(startDate);
      let newStart = originalRange.start;
      let newEnd = originalRange.end;

      if (resizeEdge === "start") {
        newStart = originalRange.start.addDays(daysDelta);
        if (newStart.dse > newEnd.dse) {
          const draggedPosition = newStart;
          newStart = newEnd.addDays(1);
          newEnd = draggedPosition;
        }
      } else {
        newEnd = originalRange.end.addDays(daysDelta);
        if (newEnd.dse < newStart.dse) {
          const draggedPosition = newEnd;
          newEnd = newStart.addDays(-1);
          newStart = draggedPosition;
        }
      }

      const newRange = new NaiveDate.Range(newStart, newEnd);

      // Check if range actually changed
      const rangeChanged =
        !originalRange.start.equals(newRange.start) ||
        !originalRange.end.equals(newRange.end);

      if (rangeChanged) {
        if (span.isEditable === false) {
          Toast.info("This event cannot be resized");
        } else {
          this.onResized?.({ span, originalRange, newRange, info: e.info });
        }
      }

      this.reset();
      return { finished: true };
    }

    onContextMenu(_: CalendarMonthGesture.Event.ContextMenu<TInfo>) {
      this.reset();
      return { finished: true };
    }

    onFinished(_: Option<CalendarMonthGesture<TInfo>>) {
      this.reset();
    }

    private reset() {
      this.onGhostUpdate?.(null, null);
      this.state = null;
    }
  }

  export type MoveEntryRowCallback<
    TInfo extends CalendarMonthGesture.Info,
  > = (event: {
    eventData: ListItem;
    fromCell: TInfo;
    toCell: TInfo;
  }) => void | Promise<void>;

  export type ClickEntryRowCallback<
    TInfo extends CalendarMonthGesture.Info,
  > = (event: { eventData: ListItem; cell: TInfo; $row: HTMLElement }) => void;

  export class MoveEntryRow<
    TInfo extends CalendarMonthGesture.Info = CalendarMonthGesture.Info,
  > extends CalendarMonthGesture.Default<TInfo> {
    identifier = "move-event-list-row";

    private draggedEventData: Option<ListItem> = null;
    private ghostSpan: Option<CalendarMonth.Span> = null;
    private $clickedRow: Option<HTMLElement> = null;
    private startInfo: Option<TInfo> = null;
    private currentInfo: Option<TInfo> = null;
    private hasMoved: boolean = false;
    private isActive: boolean = false;

    constructor(
      private onMoved?: Option<MoveEntryRowCallback<TInfo>>,
      private onGhostUpdate?: Option<GhostUpdateCallback>,
      private onClick?: Option<ClickEntryRowCallback<TInfo>>,
    ) {
      super();
    }

    canHandle(event: CalendarMonthGesture.Event<TInfo>): boolean {
      // Handle entryRowPointerDown events
      return event.internal.entryRowPointerDown != null;
    }

    allowsConcurrentGestures(): boolean {
      return !this.hasMoved;
    }

    onPointerDown(e: CalendarMonthGesture.Event.PointerDown<TInfo>) {
      // Initialize from entryRow data if present
      if (e.entryRow) {
        this.draggedEventData = e.entryRow.rowProps;
        this.ghostSpan = e.entryRow.ghostSpan;
        this.$clickedRow = e.entryRow.$row;
        this.startInfo = e.info;
        this.currentInfo = e.info;
        this.hasMoved = false;
        this.isActive = true;
      }
      return { finished: false };
    }

    onPointerMove(e: CalendarMonthGesture.Event.PointerMove<TInfo>) {
      if (!this.startInfo || !this.draggedEventData || !this.isActive) {
        return { shouldCapturePointer: false };
      }
      // A non-editable row never starts a drag: no ghost, no claim.
      if (this.draggedEventData.isEditable === false) {
        return { shouldCapturePointer: false };
      }

      const prevInfo = this.currentInfo;
      this.currentInfo = e.info;

      if (prevInfo && !prevInfo.date.equals(e.info.date)) {
        this.hasMoved = true;
      }

      if (!this.hasMoved || !this.ghostSpan)
        return { shouldCapturePointer: false };

      // Update ghost span position - only show if on a different cell
      const offsetDays = this.currentInfo.date.differenceInDays(
        this.startInfo.date,
      );
      if (offsetDays !== 0) {
        this.onGhostUpdate?.(this.ghostSpan, offsetDays);
      } else {
        this.onGhostUpdate?.(null, 0);
      }

      return { shouldCapturePointer: false };
    }

    onPointerUp(e: CalendarMonthGesture.Event.PointerUp<TInfo>) {
      if (!this.draggedEventData || !this.startInfo || !this.isActive) {
        this.reset();
        return { finished: true };
      }

      const toInfo = e.info;
      const fromInfo = this.startInfo;
      const eventData = this.draggedEventData;

      // Click without drag - show event details
      if (fromInfo.date.equals(toInfo.date)) {
        if (!this.hasMoved && this.$clickedRow) {
          this.onClick?.({ eventData, cell: fromInfo, $row: this.$clickedRow });
        }
        this.reset();
        return { finished: true };
      }

      // Moved to different cell. Fire `onMoved` un-awaited so `reset()`
      // clears the ghost immediately (matching `MoveSpan.onPointerUp`).
      // The optimistic data update runs synchronously inside
      // `EventsClient.update` before any await, so the cell re-binds at
      // the new position in the same frame as the ghost clear — awaiting
      // here would hold the ghost for the full network round-trip.
      if (eventData.isEditable === false) {
        Toast.info("This event cannot be moved");
      } else {
        void this.onMoved?.({ eventData, fromCell: fromInfo, toCell: toInfo });
      }

      this.reset();
      return { finished: true };
    }

    onContextMenu(_: CalendarMonthGesture.Event.ContextMenu<TInfo>) {
      this.reset();
      return { finished: true };
    }

    onFinished(_: Option<CalendarMonthGesture<TInfo>>) {
      this.reset();
    }

    private reset(): void {
      // Clear ghost when drag ends
      if (this.ghostSpan) {
        this.onGhostUpdate?.(null, 0);
      }

      this.draggedEventData = null;
      this.ghostSpan = null;
      this.startInfo = null;
      this.currentInfo = null;
      this.hasMoved = false;
      this.isActive = false;
    }
  }

  export type ContextMenuSpanCallback<TInfo extends CalendarMonthGesture.Info> =
    (event: {
      span: CalendarMonth.Span;
      segment: CalendarMonth.SpanSegmentInfo;
      info: TInfo;
      offset: Point;
      $span: HTMLElement;
    }) => void;

  export class ContextMenu<
    TInfo extends CalendarMonthGesture.Info = CalendarMonthGesture.Info,
  > extends CalendarMonthGesture.Default<TInfo> {
    identifier = "context-menu";

    constructor(
      private onContextMenuCb?: Option<ContextMenuSpanCallback<TInfo>>,
    ) {
      super();
    }

    canHandle(event: CalendarMonthGesture.Event<TInfo>): boolean {
      const contextMenu = event.internal.contextMenu;
      if (!contextMenu) return false;
      // Handle context menu on non-pending spans only
      if (!contextMenu.span) return false;
      if (contextMenu.span.isPending) return false;
      return true;
    }

    onContextMenu(e: CalendarMonthGesture.Event.ContextMenu<TInfo>) {
      if (e.span && e.segment && e.$span) {
        this.onContextMenuCb?.({
          span: e.span,
          segment: e.segment,
          info: e.info,
          offset: e.offset,
          $span: e.$span,
        });
      }
      return { finished: true };
    }
  }
}
