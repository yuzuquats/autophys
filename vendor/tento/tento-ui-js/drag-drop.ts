import { nonnull } from "@tento-core/assert";
import { Point } from "@tento-core/point";

import { GESTURE_MANAGER } from "./gesture-manager";

/**
 * Drag-and-drop seam, agnostic to both the drag-source and the drag-target.
 *
 * Sources publish a typed payload (`DragDrop.Payload`, keyed by a
 * `DragDrop.Kind<T>` token) and render their own lift/settle visuals.
 * Targets declare which payloads they accept and receive drops by geometry —
 * a target can be any element, including the document root. Neither side
 * ever sees the other's concrete type; the payload token is the only
 * shared vocabulary.
 *
 * Pointer plumbing rides `GESTURE_MANAGER.addDragGesture`, which takes the
 * global gesture lock for the duration of a drag. That single mechanism is
 * what makes this seam coexist with sheet-layout gestures: while a drag is
 * active no sheet gesture can start (and vice versa), without this module
 * knowing sheets exist.
 */
export namespace DragDrop {
  /**
   * Typed token naming a payload shape. Sources and targets that want to
   * exchange data share a Kind; everyone else stays blind to it.
   */
  export class Kind<T extends object> {
    // Phantom marker so Kind<A> is not assignable to Kind<B>.
    declare private phantom: T;

    constructor(readonly id: string) {}

    payload(value: T): Payload {
      return Payload.make(this, value);
    }
  }

  export class Payload {
    private constructor(
      private readonly kindId: string,
      private readonly value: object,
    ) {}

    static make<T extends object>(kind: Kind<T>, value: T): Payload {
      return new Payload(kind.id, value);
    }

    is<T extends object>(kind: Kind<T>): boolean {
      return this.kindId === kind.id;
    }

    get<T extends object>(kind: Kind<T>): Option<T> {
      if (this.kindId !== kind.id) return null;
      // Safe: a Payload can only be constructed through make(), which ties
      // the stored value's type to the kind id at the call site.
      return this.value as T;
    }
  }

  export interface Lift {
    payload: Payload;
    /** Pointer position within the source element at grab time. */
    grabOffset: Point;
  }

  export interface Move {
    payload: Payload;
    /** Pointer position in page coordinates. */
    page: Point;
    /** Pointer displacement since pointer-down. */
    delta: Point;
    /** The accepting target currently under the pointer, if any. */
    over: Option<Target>;
  }

  export interface Settle {
    /** True iff a target consumed the payload via onDrop. */
    dropped: boolean;
  }

  export interface ContextMenu {
    /** Pointer position in viewport coordinates. */
    client: Point;
  }

  export interface Drop {
    payload: Payload;
    /** Pointer position in page coordinates. */
    page: Point;
    /** Pointer position relative to the target's bounding rect. */
    local: Point;
    /** Pointer position within the source element at grab time. */
    grabOffset: Point;
  }

  export interface TargetMove {
    payload: Payload;
    /** Pointer position in page coordinates. */
    page: Point;
    /** Pointer position relative to the target's bounding rect. */
    local: Point;
    /** Pointer position within the source element at grab time. */
    grabOffset: Point;
  }

  export interface Source {
    /** Built once per drag, the moment the drag crosses the lift threshold. */
    payload(): Payload;
    /** Drag activated — deepen shadows, raise z-index, etc. */
    onLift?: Option<(e: Lift) => void>;
    /** Continuous tracking — move the dragged visual here. */
    onMove?: Option<(e: Move) => void>;
    /** Drag ended, whether or not a target consumed it. */
    onSettle?: Option<(e: Settle) => void>;
    /** Pointer released without ever crossing the lift threshold — i.e. a
     *  tap on the source, not a drag. A source that is both draggable and
     *  clickable (the sticker overlay: drag to move, tap to open details)
     *  handles the click here, since it captured the pointer and no
     *  underlying element will see it. */
    onTap?: Option<() => void>;
    /** Right-click/context-menu activation while preserving the drag source. */
    onContextMenu?: Option<(e: ContextMenu) => void>;
  }

  export interface Target {
    canAccept(payload: Payload): boolean;
    /** An accepted payload entered this target's bounds. */
    onEnter?: Option<(payload: Payload) => void>;
    /** Continuous tracking while an accepted payload is inside this target. */
    onMove?: Option<(e: TargetMove) => void>;
    /** The payload left this target's bounds. A drop does NOT also fire onLeave. */
    onLeave?: Option<(payload: Payload) => void>;
    onDrop(e: Drop): void;
  }

  /** Movement below this threshold stays a click; at or above it, a drag lifts. */
  const LIFT_THRESHOLD_PX = 4;

  interface Hit {
    $e: HTMLElement;
    target: Target;
  }

  class Session {
    payload: Option<Payload>;
    over: Option<Hit>;
    lastPage: Point;

    constructor(
      readonly source: Source,
      readonly grabOffset: Point,
      downPage: Point,
    ) {
      this.lastPage = downPage;
    }

    get lifted(): boolean {
      return this.payload != null;
    }
  }

  /**
   * Owns source/target registries and the active drag session. Each
   * interaction surface (a board, a sheet, a page) owns one Controller and
   * resets it on teardown, so registrations stay scoped to that surface's
   * lifecycle rather than accumulating in a shared global registry.
   */
  export class Controller {
    private static nextGestureId = 0;

    private targets: Map<HTMLElement, Target> = new Map();
    private sources: Set<HTMLElement> = new Set();
    private session: Option<Session>;

    registerSource($e: HTMLElement, source: Source): void {
      this.sources.add($e);
      const gestureId = `drag-drop/${Controller.nextGestureId++}`;
      GESTURE_MANAGER.addDragGesture($e, gestureId, {
        onPointerDown: (e) => {
          this.session = new Session(
            source,
            { x: e.offsetX, y: e.offsetY },
            { x: e.pageX, y: e.pageY },
          );
        },
        onPointerMove: (e) => {
          if (!this.session) return;
          this.handleMove(this.session, e.page, e.progress);
        },
        onPointerUp: (e) => {
          if (!this.session) return;
          this.handleUp(this.session, e.page);
          this.session = null;
        },
        onContextMenu: source.onContextMenu
          ? (_e, client) => source.onContextMenu?.({ client })
          : null,
      });
    }

    /** Call when a source element is discarded (not on every reparent). */
    unregisterSource($e: HTMLElement): void {
      this.sources.delete($e);
      GESTURE_MANAGER.unregister($e);
    }

    registerTarget($e: HTMLElement, target: Target): void {
      this.targets.set($e, target);
    }

    unregisterTarget($e: HTMLElement): void {
      this.targets.delete($e);
    }

    /** Drop all registrations and any in-flight session. */
    reset(): void {
      for (const $e of this.sources) {
        GESTURE_MANAGER.unregister($e);
      }
      this.sources.clear();
      this.targets.clear();
      this.session = null;
    }

    private handleMove(session: Session, page: Point, progress: Point): void {
      // GestureManager progress is start-minus-current; flip to displacement.
      const delta = { x: -progress.x, y: -progress.y };
      if (!session.lifted) {
        if (Math.hypot(delta.x, delta.y) < LIFT_THRESHOLD_PX) return;
        session.payload = session.source.payload();
        session.source.onLift?.({
          payload: session.payload,
          grabOffset: session.grabOffset,
        });
      }

      const payload = nonnull(session.payload, "lifted session has payload");
      const hit = this.hitTest(toClient(page), payload);
      if (hit?.target !== session.over?.target) {
        session.over?.target.onLeave?.(payload);
        hit?.target.onEnter?.(payload);
      }
      if (hit) {
        const rect = hit.$e.getBoundingClientRect();
        const client = toClient(page);
        hit.target.onMove?.({
          payload,
          page,
          local: { x: client.x - rect.left, y: client.y - rect.top },
          grabOffset: session.grabOffset,
        });
      }
      session.over = hit;
      session.lastPage = page;
      session.source.onMove?.({
        payload,
        page,
        delta,
        over: hit?.target,
      });
    }

    private handleUp(session: Session, page: Point): void {
      // Never lifted — the gesture stays a click; surface it as a tap so
      // a clickable source (the sticker overlay) can act on it.
      if (!session.lifted) {
        session.source.onTap?.();
        return;
      }
      const payload = nonnull(session.payload, "lifted session has payload");

      const over = this.hitTest(toClient(page), payload);
      if (session.over?.target !== over?.target) {
        session.over?.target.onLeave?.(payload);
      }
      if (over) {
        const rect = over.$e.getBoundingClientRect();
        const client = toClient(page);
        over.target.onDrop({
          payload,
          page,
          local: { x: client.x - rect.left, y: client.y - rect.top },
          grabOffset: session.grabOffset,
        });
      }
      session.source.onSettle?.({ dropped: over != null });
    }

    /**
     * Geometry hit-test over registered targets. When accepting targets
     * nest or overlap, the smallest bounding rect wins — a deeper, more
     * specific target beats the surface that contains it. Z-order is not
     * consulted in this first pass.
     */
    private hitTest(client: Point, payload: Payload): Option<Hit> {
      let best: Option<Hit & { area: number }>;
      for (const [$e, target] of this.targets) {
        if (!$e.isConnected) continue;
        const rect = $e.getBoundingClientRect();
        const contains =
          client.x >= rect.left &&
          client.x <= rect.right &&
          client.y >= rect.top &&
          client.y <= rect.bottom;
        if (!contains) continue;
        if (!target.canAccept(payload)) continue;
        const area = rect.width * rect.height;
        if (!best || area < best.area) {
          best = { $e, target, area };
        }
      }
      return best;
    }
  }

  function toClient(page: Point): Point {
    return { x: page.x - window.scrollX, y: page.y - window.scrollY };
  }
}
