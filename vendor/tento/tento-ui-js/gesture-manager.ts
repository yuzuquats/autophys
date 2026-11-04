import { Epoch, MsSinceEpoch } from "@tento-chrono";
import { DomUtils } from "./dom";
import { DomEventUtils } from "./dom-event-utils";
import { Point } from "@tento-core/point";
import { Session } from "./session";

export class GestureManager {
  private gestureLockHandle: Option<string>;
  private pressed: boolean = false;
  private $pressedElement: Option<HTMLElement>;
  private $capturedElement: Option<HTMLElement>;

  private gestureDragStartOffset: Option<Point>;
  private gestureDragStart: Option<Point>;
  private gestureDragProgress: Option<Point>;

  private documentPointerDragMove: Option<
    (e: { progress: Point; page: Point; offset: Point }) => void
  >;
  private documentPointerDragUp: Option<
    (e: { progress: Point; page: Point; offset: Point }) => void
  >;
  /**
   * Ends the current drag gesture without a drop, when that gesture handles
   * it (`addDragGesture`'s `onCancel`): a release that never left the click
   * slop (`"tap"`), a `pointercancel`, or Escape.
   */
  private documentPointerDragCancel: Option<(why: "tap" | "cancel" | "escape") => void>;
  private gesturePointerId: Option<number>;
  private bodyUserSelectBeforeDrag: Option<string>;

  private onClickOutsideCallbacks: Map<
    HTMLElement,
    ($pointerUpElement: Option<HTMLElement>) => void
  > = new Map();

  constructor() {
    if (typeof document === "undefined") return;

    const handlePointerEnd = (e: PointerEvent) => {
      if (e.type === "pointerup" && e.button !== 0) return;

      const $target = e.target instanceof HTMLElement ? e.target : null;
      // if (this.$capturedElement && this.$capturedElement != $target) return;

      // A genuine pointer release/cancel ends any gesture, so an app-level
      // pointer capture (set by drag-to-reorder via `setPointerCapture`) MUST
      // NOT outlive it. Reorder clears its own capture on its `pointerup`, but
      // has no `pointercancel` path — an interrupted drag (touch cancel, scroll,
      // a detached row) otherwise leaves `$capturedElement` set, and the guards
      // in `onpointerdown`/`onpointerup` then silently dead-lock EVERY later
      // click app-wide. Clear it here, BEFORE the `!pressed` early return below
      // (reorder never sets `pressed`, so a clear placed after it would be
      // skipped on exactly the leak path that matters).
      this.$capturedElement = null;

      if (!this.pressed) {
        this.emitOnClickOutside($target, $target, e);
        this.$pressedElement = null;
        return;
      }

      this.pressed = false;
      this.gestureLockHandle = null;
      if (document.body.hasPointerCapture(e.pointerId)) {
        document.body.releasePointerCapture(e.pointerId);
      }
      this.restoreBodyTextSelection();

      const documentPointerDragUp = this.documentPointerDragUp;
      const documentPointerDragCancel = this.documentPointerDragCancel;
      this.documentPointerDragMove = null;
      this.documentPointerDragUp = null;
      this.documentPointerDragCancel = null;

      if (e.type === "pointercancel") {
        documentPointerDragCancel?.("cancel");
        this.clearDragState();
        return;
      }

      if (!documentPointerDragUp) {
        this.emitOnClickOutside($target, $target, e);
        this.clearDragState();
        return;
      }

      const gestureDragStart = this.gestureDragStart;
      const gestureDragStartOffset = this.gestureDragStartOffset;
      const route = GestureManager.releaseRoute(
        gestureDragStartOffset == null ? null : gestureDragStart,
        { x: e.pageX, y: e.pageY },
        { cancellable: documentPointerDragCancel != null },
      );
      if (!gestureDragStart || !gestureDragStartOffset || route === "click") {
        this.emitOnClickOutside($target, $target, e);
        this.clearDragState();
        return;
      }

      if (route === "tap") {
        documentPointerDragCancel?.("tap");
        this.clearDragState();
        return;
      }

      e.stopPropagation();
      documentPointerDragUp({
        progress: {
          x: gestureDragStart.x - e.pageX,
          y: gestureDragStart.y - e.pageY,
        },
        page: {
          x: e.pageX,
          y: e.pageY,
        },
        offset: gestureDragStartOffset,
      });
      this.clearDragState();
    };
    // Active drag gestures must settle before target-level pointer-up handlers.
    // Otherwise a drop over a calendar column can be interpreted as a background
    // create click before the drag/drop controller sees the release.
    window.addEventListener(
      "pointerup",
      (e) => {
        if (!this.pressed || !this.documentPointerDragUp) return;
        handlePointerEnd(e);
      },
      true,
    );
    window.addEventListener(
      "pointercancel",
      (e) => {
        if (!this.pressed || !this.documentPointerDragUp) return;
        handlePointerEnd(e);
      },
      true,
    );
    document.onpointerup = handlePointerEnd;
    document.onpointercancel = handlePointerEnd;
    // Escape ends a drag gesture that handles cancel (`addDragGesture`'s
    // `onCancel`) with no drop; the key goes no further. A gesture without
    // `onCancel` keeps running, as before.
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || !this.pressed) return;
        const cancel = this.documentPointerDragCancel;
        if (cancel == null) return;
        e.preventDefault();
        e.stopPropagation();
        this.endPressWithoutDrop();
        cancel("escape");
      },
      true,
    );

    document.onpointermove = (e) => {
      const $target = e.target instanceof HTMLElement ? e.target : null;
      if (this.$capturedElement && this.$capturedElement != $target) return;
      if (!this.pressed) return;

      this.gestureDragProgress = {
        x: this.gestureDragStart!.x - e.pageX,
        y: this.gestureDragStart!.y - e.pageY,
      };

      if (!this.documentPointerDragMove) return;
      e.stopPropagation();
      this.documentPointerDragMove({
        progress: {
          x: this.gestureDragProgress.x,
          y: this.gestureDragProgress.y,
        },
        page: {
          x: e.pageX,
          y: e.pageY,
        },
        offset: this.gestureDragStartOffset!,
      });
    };
  }

  private disableBodyTextSelection(): void {
    if (this.bodyUserSelectBeforeDrag != null) return;
    this.bodyUserSelectBeforeDrag = document.body.style.userSelect;
    document.body.style.userSelect = "none";
  }

  private restoreBodyTextSelection(): void {
    if (this.bodyUserSelectBeforeDrag == null) return;
    document.body.style.userSelect = this.bodyUserSelectBeforeDrag;
    this.bodyUserSelectBeforeDrag = null;
  }

  /** End the press a cancelled drag gesture held: lock, capture, text selection, drag state. */
  private endPressWithoutDrop(): void {
    this.pressed = false;
    this.gestureLockHandle = null;
    this.$capturedElement = null;
    const pointerId = this.gesturePointerId;
    if (pointerId != null && document.body.hasPointerCapture(pointerId)) {
      document.body.releasePointerCapture(pointerId);
    }
    this.gesturePointerId = null;
    this.restoreBodyTextSelection();
    this.documentPointerDragMove = null;
    this.documentPointerDragUp = null;
    this.documentPointerDragCancel = null;
    this.clearDragState();
  }

  private clearDragState(): void {
    this.gestureDragStart = null;
    this.gestureDragStartOffset = null;
    this.gestureDragProgress = null;
    this.$pressedElement = null;
  }

  private suppressNextNativeContextMenu(): void {
    if (typeof window === "undefined") return;

    // Non-Windows custom menus open from pointerdown, but the browser can still
    // dispatch a later native `contextmenu` event after our menu is inserted.
    // A local handler on the original row/button may miss that retargeted event,
    // so capture the next one at window scope and remove the suppressor.
    const suppress = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      window.clearTimeout(timeout);
      window.removeEventListener("contextmenu", suppress, true);
    };

    const timeout = window.setTimeout(() => {
      window.removeEventListener("contextmenu", suppress, true);
    }, 500);
    window.addEventListener("contextmenu", suppress, true);
  }

  disablePointers($e: HTMLElement) {
    $e.onpointerdown = DomEventUtils.STOP_PROPAGATION;
    $e.onpointerup = DomEventUtils.STOP_PROPAGATION;
  }

  setPointerCapture($e: HTMLElement) {
    this.$capturedElement = $e;
  }

  clearPointerCapture($e: HTMLElement) {
    if (this.$capturedElement === $e) {
      this.$capturedElement = null;
    }
  }

  private pointerEvents = ((self) => ({
    oncontextmenu: (
      e: MouseEvent,
      cb: (client: Point, offset: Point, e?: MouseEvent) => void,
    ): boolean => {
      if (Session.isWindows) {
        cb(client(e), offset(e), e);
      }
      e.stopPropagation();
      e.preventDefault();
      return false;
    },
    onpointerdown: (
      e: PointerEvent,
      $e: HTMLElement,
      onPointerDown: Option<(offset: Point, e?: PointerEvent) => void>,
      onContextMenu: Option<(client: Point, offset: Point, e?: MouseEvent) => void>,
      nestedInDrag: boolean,
      allowTextSelection: boolean,
    ) => {
      const $target = e.target instanceof HTMLElement ? e.target : null;
      if (self.$capturedElement && self.$capturedElement != $target) {
        // A captured element that has left the DOM can never receive the
        // pointerup that would clear it, so it must not block input forever —
        // drop the stale capture instead of dead-locking every click.
        if (!self.$capturedElement.isConnected) self.$capturedElement = null;
        else return;
      }

      // dev("(child) pointer-down", e.bubbles);
      self.$pressedElement = $e;
      !nestedInDrag && e.stopPropagation();
      // Cancelling pointer-down is what suppresses the browser's native
      // text selection; a content surface opts out and keeps it.
      !nestedInDrag && !allowTextSelection && e.preventDefault();
      if (e.button === 0) {
        onPointerDown?.(offset(e), e);
      } else {
        if (onContextMenu && !Session.isWindows) {
          e.stopPropagation();
          e.preventDefault();
          self.suppressNextNativeContextMenu();
        }
        self.emitOnClickOutside(self.$pressedElement, $e, e);
        if (!Session.isWindows) {
          onContextMenu?.(client(e), offset(e), e);
        }
      }
    },
    ondoubleclick: (e: MouseEvent, cb: EmptyFunction) => {
      e.stopPropagation();
      if (e.button === 0) cb();
      self.$pressedElement = null;
    },
    onpointerup: (
      e: PointerEvent,
      $e: HTMLElement,
      canHandleCapturedElement: Option<($e: HTMLElement) => boolean>,
      onClick: Option<
        (
          $currentlyCapturedElement: Option<HTMLElement>,
          offset: Point,
          e: PointerEvent,
        ) => void
      >,
      onContextMenu: Option<(client: Point, offset: Point, e?: MouseEvent) => void>,
      nestedInDrag: boolean,
    ) => {
      const $target = e.target instanceof HTMLElement ? e.target : null;
      if (self.$capturedElement && self.$capturedElement != $target) {
        // A captured element that has left the DOM can never receive the
        // pointerup that would clear it, so it must not block input forever —
        // drop the stale capture instead of dead-locking every click.
        if (!self.$capturedElement.isConnected) self.$capturedElement = null;
        else return;
      }

      // NOTE: this exits early so it doesn't interfere with onClick
      if (e.button === 2 && !Session.isWindows && onContextMenu) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      // dev("(child) pointer-up", this.$pressedElement, $e);
      if (self.$capturedElement) {
        if (canHandleCapturedElement && !canHandleCapturedElement($e)) {
          const cb = self.onClickOutsideCallbacks.get(self.$capturedElement);
          cb?.($e);
          self.clearOnClickOutside($e);
          return;
        }
      }
      self.emitOnClickOutside(self.$pressedElement, $e, e);
      if (e.button === 0) {
        !nestedInDrag && e.stopPropagation();
        onClick?.(self.$capturedElement, offset(e), e);
      }
      self.$pressedElement = null;
    },
  }))(this);

  addBarrier($e: HTMLElement) {
    $e.onpointerup = (e) => {
      e.stopPropagation();
    };
  }

  addPointerEvent(
    $e: HTMLElement,
    {
      onPointerDown,
      onClick,
      onContextMenu,
      onDoubleClick,
      canHandleCapturedElement,
      nestedInDrag,
      allowTextSelection,
    }: GestureManager.PointerEvents,
  ) {
    /**
     * Note: we separate out the functions here to reduce memory.
     * addPointerEvent is called *frequently* and generating a massive callback
     * function per instance is heavy.
     */
    $e.oncontextmenu = onContextMenu
      ? (e) => this.pointerEvents.oncontextmenu(e, onContextMenu)
      : null;
    $e.onpointerdown = (e) =>
      this.pointerEvents.onpointerdown(
        e,
        $e,
        onPointerDown,
        onContextMenu,
        nestedInDrag ?? false,
        allowTextSelection ?? false,
      );
    $e.ondblclick = onDoubleClick
      ? (e) => this.pointerEvents.ondoubleclick(e, onDoubleClick)
      : null;
    $e.onpointerup = (e) =>
      this.pointerEvents.onpointerup(
        e,
        $e,
        canHandleCapturedElement,
        onClick,
        onContextMenu,
        nestedInDrag ?? false,
      );
  }

  /**
   * Remove all pointer event handlers set by addPointerEvent or addDragGesture.
   * Call this in disconnectedCallback to prevent memory leaks.
   */
  unregister($e: HTMLElement) {
    $e.onpointerdown = null;
    $e.onpointerup = null;
    $e.ondblclick = null;
    $e.oncontextmenu = null;
    $e.onpointermove = null;
  }

  setOnClickOutside($e: HTMLElement, cb: ($e: Option<HTMLElement>) => void) {
    this.onClickOutsideCallbacks.set($e, cb);
  }

  clearOnClickOutside($e: HTMLElement) {
    this.onClickOutsideCallbacks.delete($e);
  }

  /**
   * Remove stale entries for elements no longer in the document.
   * Call periodically or when memory pressure is detected.
   */
  cleanupStaleCallbacks() {
    for (const $e of this.onClickOutsideCallbacks.keys()) {
      if (!$e.isConnected) {
        this.onClickOutsideCallbacks.delete($e);
      }
    }
  }

  toggleCleanUpOnClickOutside(
    $e: HTMLElement,
    cb: ($e: Option<HTMLElement>) => void,
    force: boolean = true,
  ) {
    if (force) {
      GESTURE_MANAGER.setOnClickOutside($e, ($pointerUpElement) => {
        cb($pointerUpElement);
        GESTURE_MANAGER.clearOnClickOutside($e);
      });
    } else {
      GESTURE_MANAGER.clearOnClickOutside($e);
    }
  }

  cleanupCallback($e: HTMLElement) {
    const maybeCb = this.onClickOutsideCallbacks.get($e);
    if (!maybeCb) return;
    maybeCb(undefined);
  }

  private emitOnClickOutside(
    $pointerDownElement: Option<HTMLElement>,
    $target: Option<HTMLElement>,
    e?: PointerEvent,
  ) {
    if ($pointerDownElement !== $target) return;
    const path = e?.composedPath();
    for (const [$e, cb] of this.onClickOutsideCallbacks.entries()) {
      if ($e === $target) continue;
      if (path?.includes($e)) continue;
      if (
        $pointerDownElement != null &&
        DomUtils.hasAncestor($pointerDownElement, $e)
      ) {
        continue;
      }
      cb($pointerDownElement ?? undefined);
    }
  }

  /**
   * Defer a detected double-click's action to the tap's pointer-UP and own the
   * tail of the gesture. The action (`fire`) typically reveals content under
   * the cursor; the synthesized click/dblclick that follow the pointerup would
   * otherwise land on it. Capture phase on window runs before any target, so
   * it's the only place to stop them in time.
   *
   * Matched to `pointerId` so a second touch-point mid-gesture can't fire it
   * early. One-shot; pointer cancellation, focus loss, or the next input clears
   * the guard without firing.
   */
  private fireDoubleClickOnPointerUp(fire: () => void, pointerId: number) {
    if (typeof window === "undefined") return;
    let fired = false;

    const cleanupPointerUpGuard = () => {
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("lostpointercapture", onCancel, true);
      window.removeEventListener("pointerdown", cleanupPointerUpGuard, true);
      window.removeEventListener("blur", cleanupPointerUpGuard, true);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanupPointerUpGuard();
    };
    const onUp = (ev: PointerEvent) => {
      if (fired || ev.pointerId !== pointerId) return;
      fired = true;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      // We bypass the document `pointerup` handler for this event, so mirror
      // its app-level capture clear (handlePointerEnd) — a stray capture left
      // set would dead-lock every later click.
      this.$capturedElement = null;
      cleanupPointerUpGuard();

      // Suppress the synthesized click + dblclick that follow, so the content
      // `fire()` reveals under the cursor can't be ghost-clicked. Keep the
      // guards until both tail events are swallowed; if the browser doesn't
      // synthesize one of them, the next real input clears the leftovers before
      // a later click can be affected.
      const pendingTailEvents = new Set(["click", "dblclick"]);
      const cleanupTailGuards = () => {
        window.removeEventListener("click", swallow, true);
        window.removeEventListener("dblclick", swallow, true);
        window.removeEventListener("pointerdown", cleanupTailGuards, true);
        window.removeEventListener("keydown", cleanupTailGuards, true);
        window.removeEventListener("blur", cleanupTailGuards, true);
      };
      const swallow = (te: Event) => {
        te.stopImmediatePropagation();
        te.preventDefault();
        pendingTailEvents.delete(te.type);
        if (pendingTailEvents.size === 0) cleanupTailGuards();
      };
      window.addEventListener("click", swallow, true);
      window.addEventListener("dblclick", swallow, true);
      window.addEventListener("pointerdown", cleanupTailGuards, true);
      window.addEventListener("keydown", cleanupTailGuards, true);
      window.addEventListener("blur", cleanupTailGuards, true);

      fire();
    };

    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("lostpointercapture", onCancel, true);
    window.addEventListener("pointerdown", cleanupPointerUpGuard, true);
    window.addEventListener("blur", cleanupPointerUpGuard, true);
  }

  addDragGesture(
    $e: HTMLElement,
    id: string,
    cbs: {
      onPointerDown?: (e: PointerEvent) => void;
      onPointerMove: (e: {
        progress: Point;
        page: Point;
        offset: Point;
      }) => void;
      onPointerUp?: Option<
        (e: { progress: Point; page: Point; offset: Point }) => void
      >;
      /**
       * The gesture ended without a drop: released inside the click slop,
       * `pointercancel`, or Escape. A gesture that passes it gets its
       * releases routed by movement (`GestureManager.releaseRoute`); one that
       * does not is handed every release through `onPointerUp`, as before.
       */
      onCancel?: Option<() => void>;
      onContextMenu?: Option<(e: PointerEvent, client: Point) => void>;
      onDoubleClick?: Option<
        (target: PointerEvent, client: Point, $target: HTMLElement) => void
      >;
    },
  ) {
    let clickTime: Option<MsSinceEpoch>;
    if (cbs.onContextMenu) {
      $e.oncontextmenu = (e) => {
        e.preventDefault();
      };
    }
    $e.onpointerdown = (e) => {
      const now = Epoch.currentMse();
      if (
        clickTime != null &&
        now - clickTime < 200 &&
        e.button === 0 &&
        cbs.onDoubleClick
      ) {
        // Second tap of a double-click. Consume this pointerdown so it doesn't
        // start a fresh drag (a 2nd row-lift), and defer the action to the
        // tap's pointer-UP so the gesture owns the whole second tap — then
        // swallow the synthesized click/dblclick so the content the handler
        // reveals under the cursor can't be ghost-clicked by the tail of this
        // gesture.
        //
        // Capture `e.target` NOW, synchronously, while the event is still
        // dispatching on this element: once dispatch ends, a shadow-crossing
        // event's `target` retargets to the outermost host (e.g. <std-drawer>),
        // so the deferred handler would resolve the wrong element. Pass the
        // captured inner target (and client point) through to the callback.
        e.preventDefault();
        clickTime = null; // consume; a 3rd rapid tap starts fresh
        const $target = e.target as HTMLElement;
        const pt = client(e);
        this.fireDoubleClickOnPointerUp(
          () => cbs.onDoubleClick?.(e, pt, $target),
          e.pointerId,
        );
        return;
      }

      if (e.button !== 0) {
        if (e.button === 2) {
          e.preventDefault();
          cbs.onContextMenu?.(e, client(e));
        }
        return;
      }
      if (this.gestureLockHandle != null) return;

      e.stopPropagation();
      this.gestureDragStart = {
        x: e.pageX,
        y: e.pageY,
      };
      this.gestureDragStartOffset = {
        x: e.offsetX,
        y: e.offsetY,
      };
      cbs.onPointerDown?.(e);

      // `onPointerDown` has started the gesture's own state (a reorder lifts
      // its row), so a capture that throws must not abandon the press here:
      // the release, `pointercancel` and Escape could then never reach
      // `onCancel`, and the gesture would stay half-started.
      GestureManager.capturePointer(document.body, e.pointerId);

      this.gestureLockHandle = id;
      this.pressed = true;

      this.documentPointerDragMove = cbs.onPointerMove;
      this.documentPointerDragUp = (e) => {
        clickTime = Epoch.currentMse();
        cbs.onPointerUp?.(e);
      };
      this.gesturePointerId = e.pointerId;
      const onCancel = cbs.onCancel;
      this.documentPointerDragCancel = onCancel == null ? null : (why) => {
        // A tap is still the first click of a double-click.
        if (why === "tap") clickTime = Epoch.currentMse();
        onCancel();
      };

      this.disableBodyTextSelection();
    };
  }
}

export const GESTURE_MANAGER = new GestureManager();

export namespace GestureManager {
  /**
   * Capture `pointerId` on `$body` for a drag press. A pointer the browser
   * cannot capture (`setPointerCapture` throws `NotFoundError` when the id is
   * not an active pointer: the press was already released, or the event was
   * dispatched by a script) leaves the press uncaptured. The gesture still
   * runs: its moves, release, `pointercancel` and Escape arrive through the
   * window and document listeners. Returns whether the pointer was captured.
   */
  export function capturePointer(
    $body: Pick<Element, "setPointerCapture">,
    pointerId: number,
  ): boolean {
    try {
      $body.setPointerCapture(pointerId);
      return true;
    } catch {
      return false;
    }
  }

  /** Pointer travel (px, on either axis) below which a press-and-release is not a drag. */
  export const CLICK_SLOP = 3;

  /**
   * What a drag gesture's release is: a `"drop"` handed to `onPointerUp`; a
   * `"tap"` (the pointer never left the click slop) that ends a gesture
   * handling cancel through `onCancel`; or a `"click"` (no press recorded).
   */
  export type ReleaseRoute = "click" | "drop" | "tap";

  /**
   * The route of a release at `release` for a press at `press` (page
   * coordinates; `null`: no press). Travel past `CLICK_SLOP` on either axis
   * is a drop. Inside the slop, a `cancellable` gesture (one with
   * `onCancel`) gets a tap; any other gesture is handed the release as a
   * drop, which is what every drag gesture got before the slop compared
   * travel.
   */
  export function releaseRoute(
    press: Option<Point>,
    release: Point,
    opts: { readonly cancellable: boolean },
  ): ReleaseRoute {
    if (press == null) return "click";
    const travelled = Math.abs(release.x - press.x) >= CLICK_SLOP ||
      Math.abs(release.y - press.y) >= CLICK_SLOP;
    if (travelled) return "drop";
    return opts.cancellable ? "tap" : "drop";
  }

  export type PointerEvents = Optional<{
    onPointerDown: (offset: Point, e?: PointerEvent) => void;
    onClick: (
      $currentlyCapturedElement: Option<HTMLElement>,
      offset: Point,
      e: PointerEvent,
    ) => void;
    /** `e`, when given, is the event `offset` is measured in (from its `target`). */
    onContextMenu: (client: Point, offset: Point, e?: MouseEvent) => void;
    onDoubleClick: EmptyFunction;
    canHandleCapturedElement: ($e: HTMLElement) => boolean;
    nestedInDrag?: Option<boolean>;
    /**
     * Pointer-down normally prevents the browser's default so a gesture
     * never fights native drag/selection. For CONTENT surfaces — a chat
     * transcript, a document — native text selection IS the feature: set
     * this and the click still fires, but pointer-down stays uncancelled
     * so a drag over the element selects text instead of being swallowed.
     */
    allowTextSelection?: Option<boolean>;
  }>;
}

export function offset(p: PointerEvent | MouseEvent): Point {
  return {
    x: p.offsetX,
    y: p.offsetY,
  };
}

export function client(p: PointerEvent | MouseEvent): Point {
  return {
    x: p.clientX,
    y: p.clientY,
  };
}

export function page(p: PointerEvent | MouseEvent): Point {
  return {
    x: p.pageX,
    y: p.pageY,
  };
}
