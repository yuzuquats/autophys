import { PartialDate } from "@tento-chrono";
import { Tracing } from "@tento-core/tracing";
import { Point } from "@tento-core/point";
import { TaggedEnum } from "@tento-core/tagged-enum";

export type GestureChangedContext =
  | "pointer-down"
  | "pointer-down-context-menu"
  | "pointer-up"
  | "pointer-move"
  | "pointer-up-empty";

export interface TimelineGesture<Context> {
  identifier: string;
  canHandle: (event: TimelineGesture.Event<Context>) => boolean;
  allowsConcurrentGestures: () => boolean;
  onFinished: (cancelledBy: Option<TimelineGesture<Context>>) => void;

  onPointerDown: (e: TimelineGesture.Event.PointerDown<Context>) => {
    finished: boolean;
  };
  onPointerUp: (e: TimelineGesture.Event.PointerUp<Context>) => {
    finished: boolean;
  };
  onPointerUpOutside: (e: TimelineGesture.Event.PointerUpOutside<Context>) => {
    finished: boolean;
  };
  onPointerMove: (e: TimelineGesture.Event.PointerMove<Context>) => {
    shouldCapturePointer: boolean;
  };
  onPointerDownContextMenu(
    e: TimelineGesture.Event.PointerDownContextMenu<Context>,
  ): { finished: boolean };
}

export namespace TimelineGesture {
  export class Default<Info = any> implements TimelineGesture<Info> {
    identifier = "default";
    canHandle(_event: TimelineGesture.Event<Info>) {
      return false;
    }
    allowsConcurrentGestures() {
      return true;
    }
    onFinished(_: Option<TimelineGesture<Info>>) {}

    onPointerDown(_e: TimelineGesture.Event.PointerDown<Info>) {
      return {
        finished: false,
      };
    }
    onPointerUp(_e: TimelineGesture.Event.PointerUp<Info>) {
      return {
        finished: true,
      };
    }
    onPointerUpOutside(_e: TimelineGesture.Event.PointerUpOutside<Info>) {
      return {
        finished: true,
      };
    }
    onPointerMove(_e: TimelineGesture.Event.PointerMove<Info>) {
      return { shouldCapturePointer: false };
    }
    onPointerDownContextMenu(
      _e: TimelineGesture.Event.PointerDownContextMenu<Info>,
    ) {
      return {
        finished: true,
      };
    }
  }

  export namespace Event {
    export type PointerDown<Info> = {
      info: Info;
      handle: Option<"left" | "right">;
      position: TimelineCell.PointerPosition;
      onItem: boolean;
    };
    export type PointerDownContextMenu<Info> = {
      info: Info;
      offset: Point;
    };
    export type PointerUp<Info> = {
      info: Info;
      position: TimelineCell.PointerPosition;
    };
    export type PointerUpOutside<Info> = {
      info: Info;
    };
    export type PointerMove<Info> = {
      info: Info;
      position: TimelineCell.PointerPosition;
      deltaDates: number;
    };

    export type Enum<Info> = {
      pointerDown: PointerDown<Info>;
      pointerDownContextMenu: PointerDownContextMenu<Info>;
      pointerUp: PointerUp<Info>;
      pointerUpOutside: PointerUpOutside<Info>;
      pointerMove: PointerMove<Info>;
    };
    export type Serialized<Context> = TaggedEnum<Enum<Context>>;
  }

  export class Event<Info> extends TaggedEnum.Base<Event.Enum<Info>> {
    static from<Info>(ser: Event.Serialized<Info>): Event<Info> {
      return new Event(ser);
    }

    static pointerDown<Info>(o: Event.PointerDown<Info>) {
      return new Event({
        type: "pointerDown",
        pointerDown: o,
      });
    }

    static pointerUp<Info>(o: Event.PointerUp<Info>) {
      return new Event({
        type: "pointerUp",
        pointerUp: o,
      });
    }

    static pointerUpOutside<Info>(o: Event.PointerUpOutside<Info>) {
      return new Event({
        type: "pointerUpOutside",
        pointerUpOutside: o,
      });
    }

    static pointerDownContextMenu<Info>(o: Event.PointerDownContextMenu<Info>) {
      return new Event({
        type: "pointerDownContextMenu",
        pointerDownContextMenu: o,
      });
    }

    static pointerMove<Info>(o: Event.PointerMove<Info>) {
      return new Event({
        type: "pointerMove",
        pointerMove: o,
      });
    }
  }

  export class Manager<
    Info extends {
      toString: () => string;
    },
  > {
    private currentGestures: Set<TimelineGesture<Info>> = new Set();
    private pointerDownStart: Option<{
      date: PartialDate;
      info: Option<Info>;
    }>;

    private gestures: TimelineGesture<Info>[] = [];
    private gesturesChangedCallbacks: Map<
      any,
      (gs: Set<TimelineGesture<Info>>, context: GestureChangedContext) => void
    > = new Map();

    // Hover callback for tracking pointer position
    private hoverCallback: Option<
      (position: Option<TimelineCell.PointerPosition>) => void
    >;

    /**
     * Sets a callback that's invoked whenever the pointer moves over the timeline.
     * Used by TimelineLayoutManager to track hovered date for highlight rendering.
     */
    setHoverCallback(
      cb: Option<(position: Option<TimelineCell.PointerPosition>) => void>,
    ): void {
      this.hoverCallback = cb;
    }

    addGestureChangeCallback(
      target: any,
      gestureChanged: (
        gs: Set<TimelineGesture<Info>>,
        context: GestureChangedContext,
      ) => void,
    ): Manager<Info> {
      this.gesturesChangedCallbacks.set(target, gestureChanged);
      return this;
    }

    addGesture(gesture: TimelineGesture<Info>): Manager<Info> {
      this.gestures.push(gesture);
      return this;
    }

    private dispatchContextMenu(
      info: Info,
      position: TimelineCell.PointerPosition,
      offset: Point,
    ) {
      this.pointerDownStart = undefined;
      const e: Event.PointerDownContextMenu<Info> = {
        offset,
        info,
      };
      this.updateCurrentGesture(
        Event.pointerDownContextMenu(e),
        "pointer-down-context-menu",
      );
      Tracing.admin(
        "timeline",
        {
          event: "pointer-down-context-menu",
          date: position.date.toString(),
          info: info.toString(),
        },
        true,
      );
      for (const g of [...this.currentGestures.values()]) {
        if (!g.onPointerDownContextMenu(e).finished) continue;
        g.onFinished(null);
        this.currentGestures.delete(g);
        this.currentGesturesDidChange("pointer-down-context-menu");
      }
    }

    private dispatchPointerDown(
      info: Info,
      position: TimelineCell.PointerPosition,
      handle: Option<"left" | "right">,
      onItem: boolean,
    ) {
      this.pointerDownStart = {
        info,
        date: position.date,
      };

      const e: Event.PointerDown<Info> = {
        info,
        handle,
        position,
        onItem,
      };
      this.updateCurrentGesture(Event.pointerDown(e), "pointer-down");
      Tracing.admin(
        "timeline",
        {
          event: "pointer-down",
          date: position.date.toString(),
          info: info.toString(),
        },
        true,
      );
      for (const g of [...this.currentGestures.values()]) {
        if (!g.onPointerDown(e).finished) continue;
        g.onFinished(null);
        this.currentGestures.delete(g);
        this.currentGesturesDidChange("pointer-down");
      }
    }

    private dispatchPointerMove(
      info: Info,
      position: TimelineCell.PointerPosition,
    ): {
      shouldCapturePointer: boolean;
    } {
      // Always notify hover callback for highlight rendering
      this.hoverCallback?.(position);

      const deltaDates = this.pointerDownStart
        ? position.date.index - this.pointerDownStart.date.index
        : 0;

      const e: Event.PointerMove<Info> = {
        info,
        deltaDates,
        position,
      };
      Tracing.admin("timeline-move", {
        date: position.date.toString(),
        info: info.toString(),
        delta: deltaDates,
      });

      if (!this.pointerDownStart || this.currentGestures.size === 0) {
        return {
          shouldCapturePointer: false,
        };
      }

      const gestures = [...this.currentGestures];
      const shouldCapturePointer = gestures.reduce(
        (b, g) => b || g.onPointerMove(e).shouldCapturePointer,
        false,
      );

      const strongGesture = gestures.find((g) => !g.allowsConcurrentGestures());
      if (strongGesture) {
        this.currentGestures.delete(strongGesture);
        for (const g of this.currentGestures) g.onFinished(strongGesture);
        this.currentGestures.clear();
        this.currentGestures.add(strongGesture);
        this.currentGesturesDidChange("pointer-move");
      }

      return {
        shouldCapturePointer,
      };
    }

    dispatchPointerUp(info: Info, position: TimelineCell.PointerPosition) {
      const e: Event.PointerUp<Info> = {
        info,
        position,
      };
      Tracing.admin(
        "timeline",
        {
          event: "pointer-up",
          date: position.date.toString(),
          info: info.toString(),
        },
        true,
      );

      this.updateCurrentGesture(Event.pointerUp(e), "pointer-up");
      for (const g of [...this.currentGestures.values()]) {
        if (!g.onPointerUp(e).finished) continue;
        g.onFinished(null);
        this.currentGestures.delete(g);
        this.currentGesturesDidChange("pointer-up");
      }
    }

    dispatchPointerUpOutside(info: Info) {
      const e: Event.PointerUpOutside<Info> = {
        info,
      };
      Tracing.admin(
        "timeline",
        {
          event: "pointer-up-outside",
          info: info.toString(),
        },
        true,
      );

      this.updateCurrentGesture(Event.pointerUpOutside(e), "pointer-up-empty");
      for (const g of [...this.currentGestures.values()]) {
        if (!g.onPointerUpOutside(e).finished) continue;
        g.onFinished(null);
        this.currentGestures.delete(g);
        this.currentGesturesDidChange("pointer-up-empty");
      }
    }

    private currentGesturesDidChange(context: GestureChangedContext) {
      Tracing.admin("timeline-gestures", {
        gestures: [...this.currentGestures.values()].map((g) => ({
          id: g.identifier,
          weak: g.allowsConcurrentGestures(),
        })),
      });
      for (const [_t, l] of this.gesturesChangedCallbacks.entries()) {
        l(this.currentGestures, context);
      }
    }

    private updateCurrentGesture(
      ev: Event<Info>,
      context: GestureChangedContext,
    ) {
      const currentStrongGesture = [...this.currentGestures].findIndex(
        (g) => !g.allowsConcurrentGestures(),
      );
      if (currentStrongGesture !== -1) return;

      for (const gesture of this.gestures) {
        if (this.currentGestures.has(gesture)) continue;
        if (!gesture.canHandle(ev)) continue;

        if (gesture.allowsConcurrentGestures()) {
          this.currentGestures.add(gesture);
          this.currentGesturesDidChange(context);
          continue;
        }

        for (const prevGesture of [...this.currentGestures.values()]) {
          prevGesture.onFinished(gesture);
        }
        this.currentGestures.clear();
        this.currentGestures.add(gesture);
        this.currentGesturesDidChange(context);
        break;
      }
    }

    asTimelineCellDelegate(info: Info): TimelineCell.Callbacks {
      return {
        onContextMenu: (event: {
          position: TimelineCell.PointerPosition;
          offset: Point;
        }) => this.dispatchContextMenu(info, event.position, event.offset),
        onPointerDown: (event: {
          position: TimelineCell.PointerPosition;
          handle: Option<"left" | "right">;
        }) =>
          this.dispatchPointerDown(info, event.position, event.handle, true),
        onPointerMove: (event: { position: TimelineCell.PointerPosition }) =>
          this.dispatchPointerMove(info, event.position),
        onPointerUp: (event: { position: TimelineCell.PointerPosition }) =>
          this.dispatchPointerUp(info, event.position),
        onPointerUpOutside: () => this.dispatchPointerUpOutside(info),
      };
    }

    /**
     * Returns cell callbacks without info embedded (for cells that track their own item).
     * Compatible with TimelineColumn.CellCallbacks.
     */
    asCellDelegate(info: Info): TimelineCell.CellCallbacks {
      return {
        onContextMenu: (event: {
          position: TimelineCell.PointerPosition;
          offset: Point;
        }) => this.dispatchContextMenu(info, event.position, event.offset),
        onPointerDown: (event: {
          position: TimelineCell.PointerPosition;
          handle: Option<"left" | "right">;
        }) => this.dispatchPointerDown(info, event.position, event.handle, true),
        onPointerMove: (event: { position: TimelineCell.PointerPosition }) =>
          this.dispatchPointerMove(info, event.position),
        onPointerUp: (event: { position: TimelineCell.PointerPosition }) =>
          this.dispatchPointerUp(info, event.position),
      };
    }

    asEmptyTimelineCellDelegate(info: Info): TimelineCell.Callbacks {
      return {
        onContextMenu: (event: {
          position: TimelineCell.PointerPosition;
          offset: Point;
        }) => this.dispatchContextMenu(info, event.position, event.offset),
        onPointerDown: (event: {
          position: TimelineCell.PointerPosition;
          handle: Option<"left" | "right">;
        }) => this.dispatchPointerDown(info, event.position, null, false),
        onPointerMove: (event: { position: TimelineCell.PointerPosition }) =>
          this.dispatchPointerMove(info, event.position),
        onPointerUp: (event: { position: TimelineCell.PointerPosition }) =>
          this.dispatchPointerUp(info, event.position),
        onPointerUpOutside: () => this.dispatchPointerUpOutside(info),
      };
    }

    /**
     * Returns column-level callbacks with info included in events.
     * Compatible with TimelineColumn.Callbacks<Info>.
     */
    get asColumnDelegate(): TimelineCell.ColumnCallbacks<Info> {
      return {
        onContextMenu: (event: {
          info: Info;
          position: TimelineCell.PointerPosition;
          offset: Point;
        }) => this.dispatchContextMenu(event.info, event.position, event.offset),
        onPointerDown: (event: {
          info: Info;
          position: TimelineCell.PointerPosition;
        }) => this.dispatchPointerDown(event.info, event.position, null, false),
        onPointerMove: (event: {
          info: Info;
          position: TimelineCell.PointerPosition;
        }) => this.dispatchPointerMove(event.info, event.position),
        onPointerUp: (event: {
          info: Info;
          position: TimelineCell.PointerPosition;
        }) => this.dispatchPointerUp(event.info, event.position),
        onPointerLeave: () => {
          this.hoverCallback?.(null);
        },
      };
    }
  }
}

export namespace TimelineCell {
  export interface PointerPosition {
    date: PartialDate; // The date at this position
    relativeOffset: number; // 0.0 to 1.0 within the cell
    absoluteX: number; // Pixel position for rendering
    cellWidthPx: number; // Pixels per day cell, for calculating deltas
  }

  /**
   * Full callbacks with all position info and handle support.
   * Used internally by the gesture manager.
   */
  export interface Callbacks {
    onContextMenu: (event: {
      position: PointerPosition;
      offset: Point;
    }) => void;
    onPointerDown: (event: {
      position: PointerPosition;
      handle: Option<"left" | "right">;
    }) => void;
    onPointerMove: (event: { position: PointerPosition }) => {
      shouldCapturePointer: boolean;
    };
    onPointerUp: (event: { position: PointerPosition }) => void;
    onPointerUpOutside: () => void;
  }

  /**
   * Cell-level callbacks without info (cell tracks its own item).
   * Compatible with TimelineColumn.CellCallbacks.
   */
  export interface CellCallbacks {
    onContextMenu: (event: {
      position: PointerPosition;
      offset: Point;
    }) => void;
    onPointerDown: (event: {
      position: PointerPosition;
      handle: Option<"left" | "right">;
    }) => void;
    onPointerMove: (event: { position: PointerPosition }) => {
      shouldCapturePointer: boolean;
    };
    onPointerUp: (event: { position: PointerPosition }) => void;
  }

  /**
   * Column-level callbacks with info included in events.
   * Compatible with TimelineColumn.Callbacks<Info>.
   */
  export interface ColumnCallbacks<Info> {
    onContextMenu: (event: {
      info: Info;
      position: PointerPosition;
      offset: Point;
    }) => void;
    onPointerDown: (event: {
      info: Info;
      position: PointerPosition;
    }) => void;
    onPointerMove: (event: { info: Info; position: PointerPosition }) => {
      shouldCapturePointer: boolean;
    };
    onPointerUp: (event: {
      info: Info;
      position: PointerPosition;
    }) => void;
    onPointerLeave?: () => void;
  }
}
