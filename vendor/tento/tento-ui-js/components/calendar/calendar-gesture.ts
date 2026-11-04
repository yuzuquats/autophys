import { Tracing } from "@tento-core/tracing";
import { DateFragment, Duration } from "@tento-chrono";
import { AdminControls } from "../../dev/admin-controls";
import { Point } from "@tento-core/point";
import { TaggedEnum } from "@tento-core/tagged-enum";
import { CalendarColumn } from "./calendar-column";
import { CalendarColumnCell } from "./calendar-column-cell";
import { CalendarDay } from "./calendar-day";
import { PIXELS_PER_HOUR } from "./calendar-hour";

/** Base class for items that participate in calendar gestures.
 *  Subclasses differentiate between content types (events, tasks, etc.).
 *  Gesture classes use `instanceof` to check eligibility and get typed data. */
export class GestureItem {}

export type GestureChangedContext =
  | "pointer-down"
  | "pointer-down-context-menu"
  | "pointer-up"
  | "pointer-up-column"
  | "pointer-move"
  | "pointer-up-empty";

export type CalendarGesture<Context> = {
  identifier: string;
  guard: (info: Context) => boolean;
  canHandle: (event: CalendarGesture.Event<Context>) => boolean;
  allowsConcurrentGestures: () => boolean;
  onFinished: (cancelledBy: Option<CalendarGesture<Context>>) => void;

  onPointerDown: (e: CalendarGesture.Event.PointerDown<Context>) => {
    finished: boolean;
  };
  onPointerUpCell: (e: CalendarGesture.Event.PointerUpCell<Context>) => {
    finished: boolean;
  };
  onPointerUpColumn: (e: CalendarGesture.Event.PointerUpColumn<Context>) => {
    finished: boolean;
  };
  onPointerMove: (e: CalendarGesture.Event.PointerMove<Context>) => {
    shouldCapturePointer: boolean;
  };
  onPointerDownContextMenu(
    e: CalendarGesture.Event.PointerDownContextMenu<any>,
  ): { finished: boolean };
};

export namespace CalendarGesture {
  export interface WindowedInfo {
    windowed: DateFragment.Windowed;
    toString(): string;
  }

  export class Default<Info extends WindowedInfo = WindowedInfo>
    implements CalendarGesture<Info>
  {
    identifier = "default";
    guard(_info: Info): boolean {
      return true;
    }
    canHandle(_event: CalendarGesture.Event<Info>) {
      return false;
    }
    allowsConcurrentGestures() {
      return true;
    }
    onFinished(_: Option<CalendarGesture<Info>>) {}

    onPointerDown(_: CalendarGesture.Event.PointerDown<Info>) {
      return {
        finished: false,
      };
    }
    onPointerUpCell(_: CalendarGesture.Event.PointerUpCell<Info>) {
      return {
        finished: true,
      };
    }
    onPointerUpColumn(_: CalendarGesture.Event.PointerUpColumn<Info>) {
      return {
        finished: true,
      };
    }
    onPointerMove(_: CalendarGesture.Event.PointerMove<Info>) {
      return { shouldCapturePointer: false };
    }
    onPointerDownContextMenu(
      _e: CalendarGesture.Event.PointerDownContextMenu<Info>,
    ) {
      return {
        finished: true,
      };
    }
  }

  export namespace Event {
    export type PointerDown<Info> = {
      info: Info;
      handle: Option<"top" | "bottom">;
      position: Duration.Time;
      onEvent: boolean;
    };
    export type PointerDownContextMenu<Info> = {
      info: Info;
      offset: {
        x: number;
        y: number;
      };
    };
    export type PointerUpCell<Info> = {
      pointerDownInfo: Info;
      info: Info;
      position: Duration.Time;
      /** Pointer's horizontal fraction (0..1) across the day column,
       *  or null when the source delegate doesn't supply it. */
      xFraction?: Option<number>;
    };
    export type PointerUpColumn<Info> = {
      pointerDownInfo: Info;
      info: Info;
      position: Duration.Time;
      xFraction?: Option<number>;
    };
    export type PointerMove<Info> = {
      info: Info;
      position: Duration.Time;
      delta: Duration.Time;
      xFraction?: Option<number>;
    };

    export type Enum<Info> = {
      pointerDown: PointerDown<Info>;
      pointerDownContextMenu: PointerDownContextMenu<Info>;
      pointerUpCell: PointerUpCell<Info>;
      pointerUpColumn: PointerUpColumn<Info>;
      pointerMove: PointerMove<Info>;
    };
    export type Serialized<Context> = TaggedEnum<Enum<Context>>;
  }

  export class Event<Info> extends TaggedEnum.Base<Event.Enum<Info>> {
    get info(): Info {
      return this.matchOpt({
        pointerDown: (e) => e.info,
        pointerDownContextMenu: (e) => e.info,
        pointerUpCell: (e) => e.info,
        pointerUpColumn: (e) => e.info,
        pointerMove: (e) => e.info,
      })!;
    }

    static from<Info>(ser: Event.Serialized<Info>): Event<Info> {
      return new Event(ser);
    }

    static pointerDown<Info>(o: Event.PointerDown<Info>) {
      return new Event({
        type: "pointerDown",
        pointerDown: o,
      });
    }

    static pointerUp<Info>(o: Event.PointerUpCell<Info>) {
      return new Event({
        type: "pointerUpCell",
        pointerUpCell: o,
      });
    }

    static pointerUpColumn<Info>(o: Event.PointerUpColumn<Info>) {
      return new Event({
        type: "pointerUpColumn",
        pointerUpColumn: o,
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

  export class Manager<Info extends WindowedInfo> {
    private currentGesture: Set<CalendarGesture<Info>> = new Set();
    private pointerDownStart: Option<{
      offset: Duration.Time;
      info: Option<Info>;
    }>;

    private gestures: CalendarGesture<Info>[] = [];
    private gesturesChangedCallbacks: Map<
      any,
      (gs: Set<CalendarGesture<Info>>, context: GestureChangedContext) => void
    > = new Map();
    private onPointerMoveCallback: Map<
      any,
      (info: Info, position: Duration.Time) => void
    > = new Map();
    readonly pointerEnteredInfo: Set<Info> = new Set();
    private onPointerEnterLeaveCallback: Map<any, (infos: Set<Info>) => void> =
      new Map();

    addGestureChangeCallback(
      target: any,
      gestureChanged: (
        gs: Set<CalendarGesture<Info>>,
        context: GestureChangedContext,
      ) => void,
    ): Manager<Info> {
      this.gesturesChangedCallbacks.set(target, gestureChanged);
      return this;
    }

    addPointerMoveCallback(
      target: any,
      gestureChanged: (info: Info, e: Duration.Time) => void,
    ): Manager<Info> {
      this.onPointerMoveCallback.set(target, gestureChanged);
      return this;
    }

    addPointerEnterLeaveCallback(
      target: any,
      gestureChanged: (infos: Set<Info>) => void,
    ): Manager<Info> {
      this.onPointerEnterLeaveCallback.set(target, gestureChanged);
      return this;
    }

    addGesture(gesture: CalendarGesture<Info>): Manager<Info> {
      this.gestures.push(gesture);
      return this;
    }

    private dispatchContextMenu(
      info: Info,
      position: CalendarColumnCell.PointerPosition,
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
        "calendar",
        {
          event: "pointer-down-context-menu",
          offset: position.offset.toString(),
          info: info.toString(),
        },
        true,
      );
      for (const g of [...this.currentGesture.values()]) {
        if (!g.onPointerDownContextMenu(e).finished) continue;
        g.onFinished(null);
        this.currentGesture.delete(g);
        this.currentGesturesDidChange("pointer-down-context-menu");
      }
    }

    private dispatchPointerDown(
      info: Info,
      position: CalendarColumnCell.PointerPosition,
      handle: Option<"top" | "bottom">,
      onEvent: boolean,
    ) {
      const offset = position.resolve(info.windowed, PIXELS_PER_HOUR);
      this.pointerDownStart = {
        info,
        offset,
      };

      const e: Event.PointerDown<Info> = {
        info,
        handle,
        position: offset,
        onEvent,
      };
      this.updateCurrentGesture(Event.pointerDown(e), "pointer-down");
      Tracing.admin(
        "calendar",
        {
          event: "pointer-down",
          offset: offset.toString(),
          info: info.toString(),
        },
        true,
      );
      for (const g of [...this.currentGesture.values()]) {
        if (!g.onPointerDown(e).finished) continue;
        g.onFinished(null);
        this.currentGesture.delete(g);
        this.currentGesturesDidChange("pointer-down");
      }
    }

    private dispatchPointerMove(
      info: Info,
      position: CalendarColumnCell.PointerPosition,
      context: "cell" | "column" | "empty-cell",
    ): {
      shouldCapturePointer: boolean;
    } {
      const currentOffset = position.resolve(info.windowed, PIXELS_PER_HOUR);
      for (const fn of this.onPointerMoveCallback.values())
        fn(info, currentOffset);

      if (!this.pointerDownStart || this.currentGesture.size === 0) {
        return {
          shouldCapturePointer: false,
        };
      }

      // Tracing.dev(
      //   "dbg/calendar/y",
      //   currentOffset.toString(),
      //   MathUtils.roundToDecimals(position.offset.y),
      //   MathUtils.roundToDecimals(position.offset.y / 48),
      //   context,
      //   info.windowed.windowedStartHrs,
      //   info.windowed.validHoursStartHrs,
      //   info.windowed.partialWindowStartHrs,
      // );

      const delta = this.pointerDownStart
        ? currentOffset.sub(this.pointerDownStart.offset)
        : Duration.Time.ZERO;
      const e: Event.PointerMove<Info> = {
        info,
        delta,
        position: currentOffset,
        xFraction: position.xFraction,
      };

      Tracing.admin("calendar-move", {
        offset: currentOffset.toString(),
        info: info.toString(),
        delta: delta.dbg(),
        context,
      });

      const gestures = [...this.currentGesture];
      const shouldCapturePointer = gestures.reduce(
        (b, g) => b || g.onPointerMove(e).shouldCapturePointer,
        false,
      );

      const strongGesture = gestures.find((g) => !g.allowsConcurrentGestures());
      if (strongGesture) {
        this.currentGesture.delete(strongGesture);
        for (const g of this.currentGesture) g.onFinished(strongGesture);
        this.currentGesture.clear();
        this.currentGesture.add(strongGesture);
        this.currentGesturesDidChange("pointer-move");
      }

      return {
        shouldCapturePointer,
      };
    }

    dispatchPointerUpCell(
      info: Info,
      position: CalendarColumnCell.PointerPosition,
    ) {
      const currentOffset = position.resolve(info.windowed, PIXELS_PER_HOUR);
      if (!this.pointerDownStart?.info) {
        // External drop (e.g. task dragged from sidebar) — no prior pointer-down on calendar.
        const e: Event.PointerUpCell<Info> = {
          pointerDownInfo: info,
          info,
          position: currentOffset,
          xFraction: position.xFraction,
        };
        this.updateCurrentGesture(Event.pointerUp(e), "pointer-up");
        for (const g of [...this.currentGesture.values()]) {
          if (!g.onPointerUpCell(e).finished) continue;
          g.onFinished(null);
          this.currentGesture.delete(g);
          this.currentGesturesDidChange("pointer-up");
        }
        return;
      }
      const e: Event.PointerUpCell<Info> = {
        pointerDownInfo: this.pointerDownStart.info,
        info,
        position: currentOffset,
        xFraction: position.xFraction,
      };
      Tracing.admin(
        "calendar",
        {
          event: "pointer-up",
          offset: position.offset.toString(),
          info: info.toString(),
        },
        true,
      );
      AdminControls.clearKey("calendar-move");

      this.updateCurrentGesture(Event.pointerUp(e), "pointer-up");
      Tracing.log("gesture-manager/dispatch-pointer-up-cell", {
        gestureCount: this.currentGesture.size,
        registeredGestures: this.gestures.length,
        info: info.toString(),
      });
      for (const g of [...this.currentGesture.values()]) {
        if (!g.onPointerUpCell(e).finished) continue;
        g.onFinished(null);
        this.currentGesture.delete(g);
        this.currentGesturesDidChange("pointer-up");
      }
    }

    dispatchPointerUpColumn(
      info: Info,
      position: CalendarColumnCell.PointerPosition,
    ) {
      const currentOffset = position.resolve(info.windowed, PIXELS_PER_HOUR);
      if (!this.pointerDownStart?.info) {
        // External drop (e.g. task dragged from sidebar) — no prior pointer-down on calendar.
        const e: Event.PointerUpColumn<Info> = {
          pointerDownInfo: info,
          info,
          position: currentOffset,
          xFraction: position.xFraction,
        };
        this.updateCurrentGesture(Event.pointerUpColumn(e), "pointer-up-column");
        for (const g of [...this.currentGesture.values()]) {
          if (!g.onPointerUpColumn(e).finished) continue;
          g.onFinished(null);
          this.currentGesture.delete(g);
          this.currentGesturesDidChange("pointer-up-column");
        }
        return;
      }
      const e: Event.PointerUpColumn<Info> = {
        pointerDownInfo: this.pointerDownStart.info,
        info,
        position: currentOffset,
        xFraction: position.xFraction,
      };
      Tracing.admin(
        "calendar",
        {
          event: "pointer-up-outside",
          info: info.toString(),
        },
        true,
      );
      AdminControls.clearKey("calendar-move");

      this.updateCurrentGesture(Event.pointerUpColumn(e), "pointer-up-column");
      for (const g of [...this.currentGesture.values()]) {
        if (!g.onPointerUpColumn(e).finished) continue;
        g.onFinished(null);
        this.currentGesture.delete(g);
        this.currentGesturesDidChange("pointer-up-column");
      }
    }

    dispatchPointerUpEmpty() {
      for (const g of [...this.currentGesture.values()]) {
        g.onFinished(null);
        this.currentGesture.delete(g);
      }
      this.currentGesturesDidChange("pointer-up-empty");
    }

    private currentGesturesDidChange(context: GestureChangedContext) {
      Tracing.admin("calendar-gestures", {
        gestures: [...this.currentGesture.values()].map((g) => ({
          id: g.identifier,
          weak: g.allowsConcurrentGestures(),
        })),
      });
      for (const [_t, l] of this.gesturesChangedCallbacks.entries()) {
        l(this.currentGesture, context);
      }
    }

    private updateCurrentGesture(
      ev: Event<Info>,
      context: GestureChangedContext,
    ) {
      const currentStrongGesture = [...this.currentGesture].findIndex(
        (g) => !g.allowsConcurrentGestures(),
      );
      if (currentStrongGesture !== -1) return;

      const info = ev.info;
      for (const gesture of this.gestures) {
        if (this.currentGesture.has(gesture)) continue;
        if (!gesture.guard(info)) continue;
        if (!gesture.canHandle(ev)) continue;

        if (gesture.allowsConcurrentGestures()) {
          this.currentGesture.add(gesture);
          this.currentGesturesDidChange(context);
          continue;
        }

        for (const prevGesture of [...this.currentGesture.values()]) {
          prevGesture.onFinished(gesture);
        }
        this.currentGesture.clear();
        this.currentGesture.add(gesture);
        this.currentGesturesDidChange(context);
        break;
      }
    }

    asColumnDelegate(info: Info): CalendarColumn.Callbacks {
      return {
        onContextMenu: (event: {
          position: CalendarColumnCell.PointerPosition;
          offset: { x: number; y: number };
        }) => this.dispatchContextMenu(info, event.position, event.offset),
        onPointerDown: (event: {
          position: CalendarColumnCell.PointerPosition;
        }) => this.dispatchPointerDown(info, event.position, null, false),
        onPointerMove: (event: {
          position: CalendarColumnCell.PointerPosition;
        }) => this.dispatchPointerMove(info, event.position, "column"),
        onPointerUpColumn: (event: {
          position: CalendarColumnCell.PointerPosition;
        }) => this.dispatchPointerUpColumn(info, event.position),
        onPointerEnter: () => {
          this.pointerEnteredInfo.add(info);
          for (const fn of this.onPointerEnterLeaveCallback.values())
            fn(this.pointerEnteredInfo);
        },
        onPointerLeave: () => {
          this.pointerEnteredInfo.delete(info);
          for (const fn of this.onPointerEnterLeaveCallback.values())
            fn(this.pointerEnteredInfo);
        },
      };
    }

    asCellDelegate(info: Info): CalendarColumnCell.Callbacks {
      return {
        onContextMenu: (event: {
          position: CalendarColumnCell.PointerPosition;
        }) =>
          this.dispatchContextMenu(info, event.position, event.position.offset),
        onPointerDown: (event: {
          position: CalendarColumnCell.PointerPosition;
          handle: Option<"top" | "bottom">;
        }) => {
          Tracing.log("gesture-manager/cell-pointer-down", { info: info.toString() });
          this.dispatchPointerDown(info, event.position, event.handle, true);
        },
        onPointerMove: (event: {
          position: CalendarColumnCell.PointerPosition;
        }) => this.dispatchPointerMove(info, event.position, "cell"),
        onPointerUpCell: (event: {
          position: CalendarColumnCell.PointerPosition;
        }) => {
          Tracing.log("gesture-manager/cell-pointer-up", { info: info.toString() });
          this.dispatchPointerUpCell(info, event.position);
        },
      };
    }

    asEmptyCellDelegate(info: Info): CalendarColumnCell.Callbacks {
      return {
        onContextMenu: (event: {
          position: CalendarColumnCell.PointerPosition;
        }) =>
          this.dispatchContextMenu(info, event.position, event.position.offset),
        onPointerDown: (event: {
          position: CalendarColumnCell.PointerPosition;
          handle: Option<"top" | "bottom">;
        }) => this.dispatchPointerDown(info, event.position, null, false),
        onPointerMove: (event: {
          position: CalendarColumnCell.PointerPosition;
        }) => this.dispatchPointerMove(info, event.position, "empty-cell"),
        onPointerUpCell: (event: {
          position: CalendarColumnCell.PointerPosition;
        }) => this.dispatchPointerUpColumn(info, event.position),
      };
    }

    asEmptyDelegate(): CalendarDay.Callbacks {
      return {
        onPointerDownEmpty: () => {},
        onPointerUpEmpty: () => this.dispatchPointerUpEmpty(),
      };
    }
  }
}
