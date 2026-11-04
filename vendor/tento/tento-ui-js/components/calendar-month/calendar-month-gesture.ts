import { NaiveDate } from "@tento-chrono";
import { Point } from "@tento-core/point";
import { EntryList } from "../entry-list/entry-list";
import type { ListItem } from "../entry-list/list-item";
import { CalendarMonth } from "./calendar-month";
import { CalendarMonthCell } from "./calendar-month-cell";

export type CalendarMonthGestureChangedContext =
  | "pointer-down"
  | "pointer-down-context-menu"
  | "pointer-up"
  | "pointer-move"
  | "pointer-up-empty";

export type CalendarMonthGesture<Context> = {
  identifier: string;
  canHandle: (event: CalendarMonthGesture.Event<Context>) => boolean;
  allowsConcurrentGestures: () => boolean;
  onFinished: (cancelledBy: Option<CalendarMonthGesture<Context>>) => void;

  onPointerDown: (e: CalendarMonthGesture.Event.PointerDown<Context>) => {
    finished: boolean;
  };
  onPointerUp: (
    e: CalendarMonthGesture.Event.PointerUp<Context>,
  ) => { finished: boolean } | Promise<{ finished: boolean }>;
  onPointerMove: (e: CalendarMonthGesture.Event.PointerMove<Context>) => {
    shouldCapturePointer: boolean;
  };
  onContextMenu: (e: CalendarMonthGesture.Event.ContextMenu<Context>) => {
    finished: boolean;
  };
};

export namespace CalendarMonthGesture {
  export interface Info {
    date: NaiveDate;
    toString(): string;
  }

  export class Default<TInfo extends Info = Info>
    implements CalendarMonthGesture<TInfo>
  {
    identifier = "default";
    canHandle(_event: CalendarMonthGesture.Event<TInfo>) {
      return false;
    }
    allowsConcurrentGestures() {
      return true;
    }
    onFinished(_: Option<CalendarMonthGesture<TInfo>>) {}

    onPointerDown(_: CalendarMonthGesture.Event.PointerDown<TInfo>) {
      return { finished: false };
    }
    onPointerUp(
      _: CalendarMonthGesture.Event.PointerUp<TInfo>,
    ): { finished: boolean } | Promise<{ finished: boolean }> {
      return { finished: true };
    }
    onPointerMove(_: CalendarMonthGesture.Event.PointerMove<TInfo>) {
      return { shouldCapturePointer: false };
    }
    onContextMenu(_: CalendarMonthGesture.Event.ContextMenu<TInfo>) {
      return { finished: true };
    }
  }

  export namespace Event {
    export type PointerDown<TInfo> = {
      info: TInfo;
      offset: Point;
      onSpan: boolean;
      span: Option<CalendarMonth.Span>;
      segment: Option<CalendarMonth.SpanSegmentInfo>;
      $span: Option<HTMLElement>;
      /** Set when pointer down is on a resize handle */
      resizeEdge: Option<"start" | "end">;
      entryRow?: {
        rowProps: ListItem;
        ghostSpan: Option<CalendarMonth.Span>;
        $row: HTMLElement;
      };
    };

    export type PointerUp<TInfo> = {
      info: TInfo;
      pointerDownInfo: TInfo;
    };

    export type PointerMove<TInfo> = {
      info: TInfo;
      offset: Point;
    };

    export type ContextMenu<TInfo> = {
      info: TInfo;
      offset: Point;
      span: Option<CalendarMonth.Span>;
      segment: Option<CalendarMonth.SpanSegmentInfo>;
      $span: Option<HTMLElement>;
    };

    export type EntryRowPointerDown<TInfo> = {
      info: TInfo;
      rowProps: ListItem;
      ghostSpan: Option<CalendarMonth.Span>;
      $row: HTMLElement;
    };
  }

  export class Event<TInfo> {
    constructor(
      readonly internal: {
        pointerDown: Option<Event.PointerDown<TInfo>>;
        pointerUp: Option<Event.PointerUp<TInfo>>;
        pointerMove: Option<Event.PointerMove<TInfo>>;
        contextMenu: Option<Event.ContextMenu<TInfo>>;
        entryRowPointerDown: Option<Event.EntryRowPointerDown<TInfo>>;
      },
    ) {}

    static pointerDown<TInfo>(o: Event.PointerDown<TInfo>): Event<TInfo> {
      return new Event({
        pointerDown: o,
        pointerUp: null,
        pointerMove: null,
        contextMenu: null,
        entryRowPointerDown: null,
      });
    }

    static pointerUp<TInfo>(o: Event.PointerUp<TInfo>): Event<TInfo> {
      return new Event({
        pointerDown: null,
        pointerUp: o,
        pointerMove: null,
        contextMenu: null,
        entryRowPointerDown: null,
      });
    }

    static pointerMove<TInfo>(o: Event.PointerMove<TInfo>): Event<TInfo> {
      return new Event({
        pointerDown: null,
        pointerUp: null,
        pointerMove: o,
        contextMenu: null,
        entryRowPointerDown: null,
      });
    }

    static contextMenu<TInfo>(o: Event.ContextMenu<TInfo>): Event<TInfo> {
      return new Event({
        pointerDown: null,
        pointerUp: null,
        pointerMove: null,
        contextMenu: o,
        entryRowPointerDown: null,
      });
    }

    static entryRowPointerDown<TInfo>(
      o: Event.EntryRowPointerDown<TInfo>,
    ): Event<TInfo> {
      return new Event({
        pointerDown: null,
        pointerUp: null,
        pointerMove: null,
        contextMenu: null,
        entryRowPointerDown: o,
      });
    }
  }

  export class Manager<TInfo extends Info> {
    private currentGesture: Set<CalendarMonthGesture<TInfo>> = new Set();
    private pointerDownStart: Option<{ date: NaiveDate; info: TInfo }> = null;
    private gestures: CalendarMonthGesture<TInfo>[] = [];

    private gesturesChangedCallbacks: Map<
      any,
      (
        gs: Set<CalendarMonthGesture<TInfo>>,
        context: CalendarMonthGestureChangedContext,
      ) => void
    > = new Map();

    readonly pointerEnteredInfo: Set<TInfo> = new Set();
    private onPointerEnterLeaveCallback: Map<any, (infos: Set<TInfo>) => void> =
      new Map();
    private onPointerMoveCallback: Map<
      any,
      (info: TInfo, offset: Point) => void
    > = new Map();

    addGesture(gesture: CalendarMonthGesture<TInfo>): Manager<TInfo> {
      this.gestures.push(gesture);
      return this;
    }

    addGestureChangeCallback(
      target: any,
      callback: (
        gs: Set<CalendarMonthGesture<TInfo>>,
        context: CalendarMonthGestureChangedContext,
      ) => void,
    ): Manager<TInfo> {
      this.gesturesChangedCallbacks.set(target, callback);
      return this;
    }

    addPointerMoveCallback(
      target: any,
      callback: (info: TInfo, offset: Point) => void,
    ): Manager<TInfo> {
      this.onPointerMoveCallback.set(target, callback);
      return this;
    }

    addPointerEnterLeaveCallback(
      target: any,
      callback: (infos: Set<TInfo>) => void,
    ): Manager<TInfo> {
      this.onPointerEnterLeaveCallback.set(target, callback);
      return this;
    }

    asCalendarMonthDelegate(): CalendarMonth.Callbacks {
      return {
        cell: this.asCellDelegate(),
        span: this.asSpanDelegate(),
      };
    }

    asCellDelegate(): CalendarMonthCell.Callbacks {
      return {
        onPointerDown: (event) => {
          const info = {
            date: event.date,
            toString: () => event.date.toString(),
          } as TInfo;
          this.dispatchPointerDown(info, null, null, null, event.offset, null);
        },
        onPointerUp: (event) => {
          const info = {
            date: event.date,
            toString: () => event.date.toString(),
          } as TInfo;
          this.dispatchPointerUp(info);
        },
        onContextMenu: (event) => {
          const info = {
            date: event.date,
            toString: () => event.date.toString(),
          } as TInfo;
          this.dispatchContextMenu(info, event.offset, null, null, null);
        },
        onPointerMove: (event) => {
          const info = {
            date: event.date,
            toString: () => event.date.toString(),
          } as TInfo;
          return this.dispatchPointerMove(info, event.offset);
        },
        onPointerEnter: (event) => {
          const info = {
            date: event.date,
            toString: () => event.date.toString(),
          } as TInfo;
          this.pointerEnteredInfo.add(info);
          for (const fn of this.onPointerEnterLeaveCallback.values()) {
            fn(this.pointerEnteredInfo);
          }
        },
        onPointerLeave: (event) => {
          // Find and remove the matching info by date
          for (const info of this.pointerEnteredInfo) {
            if (info.date.equals(event.date)) {
              this.pointerEnteredInfo.delete(info);
              break;
            }
          }
          for (const fn of this.onPointerEnterLeaveCallback.values()) {
            fn(this.pointerEnteredInfo);
          }
        },
      };
    }

    asSpanDelegate(): CalendarMonth.SpanCallbacks {
      return {
        onPointerDown: (event) => {
          const date = event.date;
          const info = { date, toString: () => date.toString() } as TInfo;
          this.dispatchPointerDown(
            info,
            event.span,
            event.segment,
            event.resizeEdge ?? null,
            event.offset,
            event.$span,
          );
        },
        onPointerUp: (event) => {
          const date = event.date;
          const info = { date, toString: () => date.toString() } as TInfo;
          this.dispatchPointerUp(info);
        },
        onPointerMove: (event) => {
          const date = event.date;
          const info = { date, toString: () => date.toString() } as TInfo;
          return this.dispatchPointerMove(info, event.offset);
        },
        onContextMenu: (event) => {
          const date = event.date;
          const info = { date, toString: () => date.toString() } as TInfo;
          this.dispatchContextMenu(
            info,
            event.offset,
            event.span,
            event.segment,
            event.$span,
          );
        },
      };
    }

    private dispatchPointerDown(
      info: TInfo,
      span: Option<CalendarMonth.Span>,
      segment: Option<CalendarMonth.SpanSegmentInfo>,
      resizeEdge: Option<"start" | "end">,
      offset: Point,
      $span: Option<HTMLElement>,
    ) {
      this.pointerDownStart = { date: info.date, info };

      const event: Event.PointerDown<TInfo> = {
        info,
        offset: offset ?? { x: 0, y: 0 },
        onSpan: span != null,
        span,
        segment,
        $span,
        resizeEdge,
      };

      this.updateCurrentGesture(Event.pointerDown(event), "pointer-down");

      for (const g of [...this.currentGesture.values()]) {
        if (!g.onPointerDown(event).finished) continue;
        g.onFinished(null);
        this.currentGesture.delete(g);
        this.currentGesturesDidChange("pointer-down");
      }
    }

    private async dispatchPointerUp(info: TInfo) {
      if (!this.pointerDownStart) {
        // External drop (e.g. task dragged from sidebar) — no prior pointer-down on calendar.
        const event: Event.PointerUp<TInfo> = {
          info,
          pointerDownInfo: info,
        };
        this.updateCurrentGesture(Event.pointerUp(event), "pointer-up");
        for (const g of [...this.currentGesture.values()]) {
          const result = await Promise.resolve(g.onPointerUp(event));
          if (!result.finished) continue;
          g.onFinished(null);
          this.currentGesture.delete(g);
          this.currentGesturesDidChange("pointer-up");
        }
        return;
      }

      const event: Event.PointerUp<TInfo> = {
        info,
        pointerDownInfo: this.pointerDownStart.info,
      };

      this.updateCurrentGesture(Event.pointerUp(event), "pointer-up");

      for (const g of [...this.currentGesture.values()]) {
        const result = await Promise.resolve(g.onPointerUp(event));
        if (!result.finished) continue;
        g.onFinished(null);
        this.currentGesture.delete(g);
        this.currentGesturesDidChange("pointer-up");
      }

      this.pointerDownStart = null;
    }

    private dispatchEntryRowPointerDown(
      info: TInfo,
      rowProps: ListItem,
      ghostSpan: Option<CalendarMonth.Span>,
      $row: HTMLElement,
    ) {
      this.pointerDownStart = { date: info.date, info };

      const event: Event.PointerDown<TInfo> = {
        info,
        offset: { x: 0, y: 0 },
        onSpan: false,
        span: null,
        segment: null,
        $span: null,
        resizeEdge: null,
        entryRow: { rowProps, ghostSpan, $row },
      };

      // First dispatch for canHandle check (some gestures distinguish by event type)
      this.updateCurrentGesture(
        Event.entryRowPointerDown({ info, rowProps, ghostSpan, $row }),
        "pointer-down",
      );

      // Then call onPointerDown with the full event including entryRow data
      for (const g of [...this.currentGesture.values()]) {
        if (!g.onPointerDown(event).finished) continue;
        g.onFinished(null);
        this.currentGesture.delete(g);
        this.currentGesturesDidChange("pointer-down");
      }
    }

    private dispatchPointerMove(
      info: TInfo,
      offset: Point,
    ): { shouldCapturePointer: boolean } {
      for (const fn of this.onPointerMoveCallback.values()) {
        fn(info, offset);
      }

      if (!this.pointerDownStart || this.currentGesture.size === 0) {
        return { shouldCapturePointer: false };
      }

      const event: Event.PointerMove<TInfo> = { info, offset };

      const gestures = [...this.currentGesture];
      const shouldCapturePointer = gestures.reduce(
        (b, g) => b || g.onPointerMove(event).shouldCapturePointer,
        false,
      );

      // Check for strong gesture promotion
      const strongGesture = gestures.find((g) => !g.allowsConcurrentGestures());
      if (strongGesture) {
        this.currentGesture.delete(strongGesture);
        for (const g of this.currentGesture) g.onFinished(strongGesture);
        this.currentGesture.clear();
        this.currentGesture.add(strongGesture);
        this.currentGesturesDidChange("pointer-move");
      }

      return { shouldCapturePointer };
    }

    private dispatchContextMenu(
      info: TInfo,
      offset: Point,
      span: Option<CalendarMonth.Span>,
      segment: Option<CalendarMonth.SpanSegmentInfo>,
      $span: Option<HTMLElement>,
    ) {
      this.pointerDownStart = null;

      const event: Event.ContextMenu<TInfo> = {
        info,
        offset,
        span,
        segment,
        $span,
      };

      this.updateCurrentGesture(
        Event.contextMenu(event),
        "pointer-down-context-menu",
      );

      for (const g of [...this.currentGesture.values()]) {
        if (!g.onContextMenu(event).finished) continue;
        g.onFinished(null);
        this.currentGesture.delete(g);
        this.currentGesturesDidChange("pointer-down-context-menu");
      }
    }

    dispatchPointerUpEmpty() {
      for (const g of [...this.currentGesture.values()]) {
        g.onFinished(null);
        this.currentGesture.delete(g);
      }
      this.currentGesturesDidChange("pointer-up-empty");
    }

    private updateCurrentGesture(
      ev: Event<TInfo>,
      context: CalendarMonthGestureChangedContext,
    ) {
      const currentStrongGesture = [...this.currentGesture].findIndex(
        (g) => !g.allowsConcurrentGestures(),
      );
      if (currentStrongGesture !== -1) {
        return;
      }

      for (const gesture of this.gestures) {
        if (this.currentGesture.has(gesture)) {
          continue;
        }
        const canHandle = gesture.canHandle(ev);
        if (!canHandle) continue;

        if (gesture.allowsConcurrentGestures()) {
          this.currentGesture.add(gesture);
          this.currentGesturesDidChange(context);
          continue;
        }

        // Strong gesture cancels weak ones
        for (const prevGesture of [...this.currentGesture.values()]) {
          prevGesture.onFinished(gesture);
        }
        this.currentGesture.clear();
        this.currentGesture.add(gesture);
        this.currentGesturesDidChange(context);
        break;
      }
    }

    private currentGesturesDidChange(
      context: CalendarMonthGestureChangedContext,
    ) {
      for (const callback of this.gesturesChangedCallbacks.values()) {
        callback(this.currentGesture, context);
      }
    }

    /**
     * Returns an EntryList.RowCallbacks delegate that routes pointer events
     * to the gesture manager for handling EntryRow drag operations.
     *
     * @param info The cell info where the EntryList is located
     * @param rows The ListItem array to look up row data by index
     * @param createGhostSpan Optional function to create a ghost span for drag preview
     */
    asEntryListDelegate(
      info: TInfo,
      rows: ListItem[],
      createGhostSpan?: (
        props: ListItem,
        date: NaiveDate,
      ) => CalendarMonth.Span,
    ): EntryList.RowCallbacks {
      return {
        onPointerDown: (rowIndex, _offset, $row) => {
          const props = rows[rowIndex];
          const ghostSpan = createGhostSpan?.(props, info.date) ?? null;
          this.dispatchEntryRowPointerDown(info, props, ghostSpan, $row);
        },
        onPointerUp: (_rowIndex, _offset) => {
          this.dispatchPointerUp(info);
        },
        onPointerMove: () => {},
        onContextMenu: () => {},
      };
    }
  }
}
