import "@tento-ui/components/round";

import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { Style, css } from "../component-styles";
import { $$ } from "../fastdom";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Point } from "@tento-core/point";
import { LonaIcons, MinusIcon, XIcon } from "../ui/icons";
import { IconButton } from "./icon-button";
import { Round } from "./round";
import { Typography } from "../ui/typography";

/** How much of the window stays visible (above the bottom edge) when docked. */
const PEEK_PX = 8;

/**
 * Pointer travel (px) before a press on the nav becomes a real window drag.
 * Below this a press is a plain click and leaves the window where it is — so
 * clicking a pinned drawer's titlebar no longer detaches it.
 */
const DETACH_DRAG_THRESHOLD_PX = 25;

/**
 * Time constant (ms) of the docked->detached pop-out follow. Each frame the
 * window closes a fraction f = 1 - exp(-dt/TAU) of the remaining gap to the
 * cursor — a decelerating velocity curve. Lower = snappier / tighter to the
 * cursor, higher = floatier / longer catch-up. At ~90ms, 60fps, f ~= 0.17;
 * a ~150px fling settles to lock in roughly ~500ms.
 */
const DETACH_FOLLOW_TAU_MS = 90;

/**
 * Once the eased position is within this distance of the cursor target the
 * follow stops animating and the drag tracks the cursor 1:1 for the rest of the
 * gesture (compared via Point.d2, i.e. squared).
 */
const DETACH_LOCK_EPSILON_PX = 0.5;

/**
 * Corner snap activates when the nearest matching window/page corner is within
 * this distance. This is deliberately larger than the resting 16px margin but
 * small enough that pulling a window clearly out of a corner leaves it free.
 */
const HOT_CORNER_THRESHOLD_PX = 72;

@component({
  name: "std-mini-window",
})
export class MiniWindow extends LonaWebComponent {
  private $close: IconButton = this.hydrate("close");
  private $dock: IconButton = this.hydrate("dock");
  private $title: HTMLElement = this.hydrate("title");
  private $bg: Round = this.hydrate("bg");

  private props: MiniWindow.Props = {};
  private dragStart?: Point;
  private isDragging: boolean = false;
  private resizeStart: Option<{ width: number; height: number }>;
  private isResizing: boolean = false;
  private state: "hidden" | "docked" | "detached" = "hidden";
  private snapToCorners: boolean = false;
  private chromeless: boolean = false;
  private delegateRadius: boolean = false;
  private dockable: boolean = false;
  private currentCorner: Option<MiniWindow.Corner>;
  private savedCorner: Option<MiniWindow.Corner>;
  // Docked->detached pop-out follow state (see beginDrag / followDrag). The
  // window renders at `dragTarget` (the live 1:1 cursor position) plus a
  // decaying `dragOffset` (the decouple gap, seeded to the jitter distance).
  // While `dragFollowing`, a rAF loop shrinks `dragOffset` toward zero each
  // frame — independent of cursor motion, so the gap trends to zero even as the
  // cursor speeds up. Once it converges the flag flips false and the drag
  // tracks the cursor 1:1.
  private dragTarget: Option<Point>;
  private dragOffset: Option<Point>;
  private dragRaf: Option<number>;
  private dragFollowing: boolean = false;
  private dragLastTs: Option<number>;
  private viewportReconcileRaf: Option<number> = null;
  private viewportResizeHandler: Option<() => void> = null;
  private windowResizeObserver: Option<ResizeObserver> = null;
  onStateUpdate: Option<(state: "hidden" | "docked" | "detached") => void>;

  constructor() {
    super();

    this.$close.bind({
      content: LonaIcons.$svg(XIcon),
      ariaLabel: "Close",
    });

    GESTURE_MANAGER.addPointerEvent(this.$close, {
      onClick: () => this.props.onClose?.(),
    });

    this.$dock.bind({
      content: LonaIcons.$svg(MinusIcon),
      ariaLabel: "Minimize",
    });
    GESTURE_MANAGER.addPointerEvent(this.$dock, {
      onClick: () => this.toggleDock(),
    });

    this.$bg.bind({
      radius: 40,
      // Window chrome bg; overridable per-window via --mini-window-bg
      // (e.g. the pomodoro window uses --bg-elevated). Defaults to --bg.
      bg: "var(--mini-window-bg, var(--bg))",
      shadow: "0 1px 2px rgba(0,0,0,0.4)",
      transformTopLeft: true,
    });

    this.attachDragGesture(this.$("nav"));
    this.setupResizeGesture();
  }

  /**
   * Re-point the window-drag gesture to a different handle (default: the nav
   * titlebar). Used by chromeless windows that drive the drag from their own
   * content (e.g. a slotted sheet's header). Snap mechanics are unchanged.
   */
  setDragHandle($handle: HTMLElement): void {
    this.attachDragGesture($handle);
    $handle.style.cursor = "grab";
  }

  private attachDragGesture($handle: HTMLElement) {
    GESTURE_MANAGER.addDragGesture($handle, "drag-mini-window", {
      onPointerDown: (_: PointerEvent): void => {
        // Dockable peek: when minimized to the bottom sliver the nav is only
        // PEEK_PX tall — too small to drag — so a tap restores it. Only
        // `dockable` windows reach `docked` via the minimize button; the drawer
        // reuses `docked` for its right-edge pinned state, handled below.
        if (this.state === "docked" && this.dockable) {
          this.dragStart = undefined;
          this.undock();
          return;
        }
        // Otherwise: record the press origin but DON'T change state or touch the
        // transition. A plain click on the nav must leave the window exactly
        // where it is — detaching happens only once the pointer crosses the drag
        // threshold (onPointerMove -> beginDrag). Leaving the standing
        // transition intact means a non-drag click can't strip the slide-in
        // animation either.
        const rect = this.getBoundingClientRect();
        this.dragStart = {
          x: rect.x,
          y: rect.y,
        };
        this.isDragging = false;
        // Promote to a compositor layer NOW, during the quiet press — before the
        // pointer crosses the detach threshold — so the browser builds the layer
        // (and does the heavy first paint of the detached drawer contents) ahead
        // of motion. Without this, the first frame of a fast fling stalls the
        // main thread for hundreds of ms painting the freshly-detached window;
        // pre-warmed, the per-frame transform updates are cheap GPU composites.
        // Released when the gesture ends (alongside the standing-transition
        // restore).
        this.style.setProperty("will-change", "transform");
      },
      onPointerMove: ({ progress }): void => {
        if (!this.dragStart) return;

        const dragDistance = Math.sqrt(progress.x ** 2 + progress.y ** 2);
        const target = {
          x: this.dragStart.x - progress.x,
          y: this.dragStart.y - progress.y,
        };
        if (!this.isDragging) {
          // Still under the threshold: treat as a click-in-progress, don't move.
          if (dragDistance < DETACH_DRAG_THRESHOLD_PX) return;
          this.beginDrag(target);
        }

        this.dragTarget = target;
        // While the pop-out is still easing to the cursor, the rAF follow loop
        // owns the rendering; just hand it the new target. Once locked (or for
        // an already-detached window), track the cursor 1:1.
        if (!this.dragFollowing) this.setDetachedPosition(target);
      },
      onPointerUp: (): void => {
        const wasDragging = this.isDragging;
        this.isDragging = false;
        if (this.dragFollowing) {
          // Released mid-catch-up (rare fast flick): leave transition:none and
          // let the follow loop settle to the last target — it restores the
          // standing transition itself on convergence. The window glides to the
          // release point and stops (no snap, no freeze-short).
          return;
        }
        this.style.removeProperty("transition"); // restore standing transition
        this.style.removeProperty("will-change"); // gesture over → drop layer hint
        // Snap to a corner only when the consumer opts in (snapToCorners) — the
        // drawer doesn't, so it stays exactly where it was dropped. A plain
        // click (no drag) never snaps.
        if (wasDragging && this.snapToCorners && this.state === "detached") {
          this.snapAfterPointerSettle();
        }
      },
    });
  }

  /**
   * Promote a press on the nav into an actual drag once the pointer crosses the
   * threshold.
   *
   * - Already detached (a free-floating window): track the pointer 1:1 with no
   *   easing (transition off).
   * - Docked -> detached (the drawer popping off its pinned edge): start the
   *   offset-decay follow (followDrag). The window renders at the 1:1 cursor
   *   position (`target`) plus a `dragOffset` seeded to the current decouple gap
   *   (pinned - target, ≈ the jitter distance). `target + offset == pinned` right
   *   now, so the state flip doesn't move it; the loop then shrinks the offset to
   *   zero on its own clock, so the gap closes regardless of how fast the cursor
   *   moves.
   */
  private beginDrag(target: Point): void {
    this.isDragging = true;
    this.currentCorner = null;
    if (this.state === "detached") {
      this.style.transition = "none";
      return;
    }
    const rect = this.getBoundingClientRect();
    const start = { x: rect.left, y: rect.top }; // current (pinned) position
    this.style.setProperty(
      "--detached-transform",
      `translate(${start.x}px, ${start.y}px)`,
    );
    this.style.transition = "none";
    this.updateState("detached");

    // Deliberate pop-out "lift": a brief scale breath (1 → 1.03 → 1) the instant
    // the window decouples from its docked edge, so every detach reads as an
    // intentional "it popped off". Necessary because the catch-up gap is ≈ the
    // jitter threshold (you drag by the titlebar, so cursor and window stay
    // co-located) — far too small to perceive as motion on its own. `scale` is
    // its own CSS property, so it composes with the translate the follow loop
    // drives via --detached-transform without fighting it, and it rides the
    // already-promoted GPU layer (will-change:transform). WAAPI with no fill
    // auto-reverts to the resting scale on finish — nothing to clean up.
    this.animate(
      [
        { scale: "1", offset: 0 },
        { scale: "1.03", offset: 0.4 },
        { scale: "1", offset: 1 },
      ],
      { duration: 220, easing: "ease-out" },
    );

    this.cancelDragFollow();
    this.dragOffset = { x: start.x - target.x, y: start.y - target.y };
    this.dragTarget = target;
    this.dragFollowing = true;
    this.dragLastTs = null;
    this.dragRaf = requestAnimationFrame((ts) => this.followDrag(ts));
  }

  /**
   * One frame of the docked->detached pop-out follow. Decay the gap vector
   * (`dragOffset`) toward zero by a fraction f = 1 - exp(-dt/TAU) — a
   * decelerating velocity curve on the GAP itself, independent of cursor motion
   * — and render at `dragTarget + dragOffset`. Because the cursor's movement
   * lives entirely in `dragTarget` (1:1), the gap (|offset|) shrinks every frame
   * no matter how fast the cursor moves. On convergence, lock to 1:1 (drop the
   * follow + restore the standing transition for future reveal/hide); otherwise
   * schedule the next frame.
   */
  private followDrag(ts: number): void {
    this.dragRaf = null;
    const offset = this.dragOffset;
    const target = this.dragTarget;
    if (!this.dragFollowing || !offset || !target) return;

    const dtMs = this.dragLastTs == null ? 16 : ts - this.dragLastTs;
    this.dragLastTs = ts;

    const f = 1 - Math.exp(-Math.min(50, Math.max(8, dtMs)) / DETACH_FOLLOW_TAU_MS);
    const next = { x: offset.x * (1 - f), y: offset.y * (1 - f) };

    if (next.x ** 2 + next.y ** 2 <= DETACH_LOCK_EPSILON_PX ** 2) {
      // Arrived: zero the offset, snap exactly onto the cursor, hand off to 1:1.
      this.dragOffset = { x: 0, y: 0 };
      this.style.setProperty(
        "--detached-transform",
        `translate(${target.x}px, ${target.y}px)`,
      );
      this.dragFollowing = false;
      // Keep transition:none while the pointer is still down so post-lock
      // tracking is true 1:1 (it must STOP animating on arrival). Restore the
      // standing transition only if the gesture already ended (released
      // mid-catch-up) — otherwise onPointerUp restores it.
      if (!this.isDragging) {
        this.style.removeProperty("transition");
        this.style.removeProperty("will-change"); // gesture over → drop layer hint
      }
      return;
    }

    this.dragOffset = next;
    this.style.setProperty(
      "--detached-transform",
      `translate(${target.x + next.x}px, ${target.y + next.y}px)`,
    );
    this.dragRaf = requestAnimationFrame((t) => this.followDrag(t));
  }

  private cancelDragFollow(): void {
    if (this.dragRaf != null) {
      cancelAnimationFrame(this.dragRaf);
      this.dragRaf = null;
    }
    this.dragFollowing = false;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.ensureViewportReconciliation();
    this.scheduleViewportReconcile();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cancelDragFollow(); // a follow loop must not outlive the element
    this.teardownViewportReconciliation();
    this.style.removeProperty("will-change"); // never strand the drag layer hint
  }

  private ensureViewportReconciliation(): void {
    if (!this.viewportResizeHandler) {
      const handler = () => this.scheduleViewportReconcile();
      this.viewportResizeHandler = handler;
      window.addEventListener("resize", handler);
    }
    if (!this.windowResizeObserver) {
      this.windowResizeObserver = new ResizeObserver(() =>
        this.scheduleViewportReconcile()
      );
    }
    this.windowResizeObserver.observe(this);
  }

  private teardownViewportReconciliation(): void {
    if (this.viewportResizeHandler) {
      window.removeEventListener("resize", this.viewportResizeHandler);
      this.viewportResizeHandler = null;
    }
    this.windowResizeObserver?.disconnect();
    this.windowResizeObserver = null;
    if (this.viewportReconcileRaf != null) {
      cancelAnimationFrame(this.viewportReconcileRaf);
      this.viewportReconcileRaf = null;
    }
  }

  private scheduleViewportReconcile(): void {
    if (this.viewportReconcileRaf != null) return;
    this.viewportReconcileRaf = requestAnimationFrame(() => {
      this.viewportReconcileRaf = null;
      this.reconcileViewportPosition();
    });
  }

  private reconcileViewportPosition(): void {
    if (!this.snapToCorners || this.state !== "detached") return;
    if (this.isDragging || this.isResizing || this.dragFollowing) return;
    const corner = this.currentCorner;
    if (corner) {
      this.snapTo(corner);
      return;
    }
    if (this.isOutsideViewport()) this.snapToNearestCorner();
  }

  private setupResizeGesture() {
    GESTURE_MANAGER.addDragGesture(
      this.$("resize-handle"),
      "resize-mini-window",
      {
        onPointerDown: (_: PointerEvent): void => {
          this.resizeStart = {
            width: this.offsetWidth,
            height: this.offsetHeight,
          };
          this.isResizing = true;
          this.style.transition = "none";
          this.toggleAttribute("resizing", true);
        },
        onPointerMove: ({ progress }): void => {
          if (!this.resizeStart) return;

          const minWidth = this.props.minWidth ?? 200;
          const newWidth = Math.max(
            minWidth,
            this.resizeStart.width - progress.x,
          );
          const newHeight = Math.max(120, this.resizeStart.height - progress.y);

          $$.mutate(() => {
            this.style.width = newWidth + "px";
            this.style.height = newHeight + "px";
          });
        },
        onPointerUp: (): void => {
          this.isResizing = false;
          this.style.removeProperty("transition");
          this.toggleAttribute("resizing", false);

          if (this.state === "detached") {
            const width = this.offsetWidth;
            const height = this.offsetHeight;
            this.style.setProperty(
              "--mini-window-detached-width",
              width + "px",
            );
            this.style.setProperty(
              "--mini-window-detached-height",
              height + "px",
            );
            this.style.removeProperty("width");
            this.style.removeProperty("height");
          }

          if (this.snapToCorners && this.state === "detached") {
            this.snapAfterPointerSettle();
          }
        },
      },
    );
  }

  bind(props: MiniWindow.Props): void {
    this.props = props;
    this.snapToCorners = props.snapToCorners ?? false;
    this.chromeless = props.chromeless ?? false;
    this.toggleAttribute("chromeless", this.chromeless);
    this.delegateRadius = props.delegateRadius ?? false;
    this.toggleAttribute("delegate-radius", this.delegateRadius);
    this.dockable = props.dockable ?? false;
    this.toggleAttribute("dockable", this.dockable);
    if (props.title) {
      this.$title.textContent = props.title;
      this.$title.hidden = false;
    } else {
      this.$title.hidden = true;
    }
  }

  static makeWith(props: MiniWindow.Props): MiniWindow {
    const $miniWindow = MiniWindow.make();
    $miniWindow.bind(props);
    return $miniWindow;
  }

  isRevealed(): boolean {
    return this.state !== "hidden";
  }

  updateState(newState: "hidden" | "docked" | "detached"): this {
    const oldState = this.state;
    if (oldState === newState) return this;

    this.setAttribute("state", newState);
    this.state = newState;
    this.onStateUpdate?.(this.state);
    return this;
  }

  reveal(): void {
    if (this.state !== "hidden") return;
    this.updateState("detached");
    const initialPosition = this.props.initialPosition;
    if (initialPosition) {
      this.revealFromPosition(this.clampToViewport(initialPosition), null);
      return;
    }
    this.centerInViewport(true);
  }

  revealAt(corner: MiniWindow.Corner): void {
    if (this.state !== "hidden") {
      this.snapTo(corner);
      return;
    }
    this.updateState("detached");
    this.revealFromPosition(this.positionForCorner(corner), corner);
  }

  prepareRevealAt(corner: MiniWindow.Corner): void {
    if (this.state === "hidden") this.updateState("detached");
    this.removeAttribute("revealing");
    this.setAttribute("preparing-reveal", "");
    this.currentCorner = corner;
    this.style.transition = "none";
    const position = this.positionForCorner(corner);
    this.style.setProperty(
      "--detached-transform",
      `translate(${position.x}px, ${position.y}px)`,
    );
  }

  finishPreparedRevealAt(corner: MiniWindow.Corner): void {
    if (this.state === "hidden") {
      this.revealAt(corner);
      return;
    }
    this.revealFromPosition(this.positionForCorner(corner), corner);
  }

  private centerInViewport(revealing: boolean = false): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = this.offsetWidth || 400;
    const height = this.offsetHeight || 360;
    const position = this.clampToViewport({
      x: (vw - width) / 2,
      y: (vh - height) / 2,
    });
    this.currentCorner = null;

    if (revealing) {
      this.revealFromPosition(position, null);
    } else {
      this.style.setProperty(
        "--detached-transform",
        `translate(${position.x}px, ${position.y}px)`,
      );
    }
  }

  hide(): void {
    this.updateState("hidden");
    this.toggleAttribute("revealed", false);
    this.removeAttribute("preparing-reveal");
    this.removeAttribute("revealing");
    this.style.removeProperty("transition");
  }

  toggleReveal(force?: Option<boolean>): boolean {
    const shouldReveal = force ?? this.state === "hidden";
    if (shouldReveal) {
      this.reveal();
    } else {
      this.hide();
    }
    return shouldReveal;
  }

  setAnimates(animates: boolean) {
    this.style.transition = animates ? "" : "none";
    // this.$bg.setAnimates(animates);
  }

  private setDetachedPosition(position: Point): void {
    if (this.state !== "detached") return;
    this.currentCorner = null;

    $$.mutate(() => {
      this.style.setProperty(
        "--detached-transform",
        `translate(${position.x}px, ${position.y}px)`,
      );
    });
  }

  detach(): void {
    if (this.state === "detached") return;

    const wasHidden = this.state === "hidden";
    this.updateState("detached");

    if (wasHidden) {
      this.centerInViewport(true);
    } else {
      const rect = this.getBoundingClientRect();
      this.setDetachedPosition({ x: rect.left, y: rect.top });
    }
  }

  snapTo(corner: MiniWindow.Corner): void {
    this.currentCorner = corner;
    const position = this.positionForCorner(corner);
    this.style.setProperty(
      "--detached-transform",
      `translate(${position.x}px, ${position.y}px)`,
    );
  }

  private revealFromPosition(
    position: Point,
    corner: Option<MiniWindow.Corner>,
  ): void {
    this.currentCorner = corner;
    this.removeAttribute("preparing-reveal");
    this.style.transition = "none";
    this.style.setProperty(
      "--detached-transform",
      `translate(${position.x}px, ${position.y}px)`,
    );
    this.setAttribute("revealing", "");
    requestAnimationFrame(() => {
      this.style.removeProperty("transition");
    });
    this.addEventListener(
      "animationend",
      () => {
        this.removeAttribute("revealing");
      },
      { once: true },
    );
  }

  private positionForCorner(corner: MiniWindow.Corner): Point {
    const margin = 16;
    const rect = this.getBoundingClientRect();
    const width = rect.width || this.offsetWidth || 400;
    const height = rect.height || this.offsetHeight || 360;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    switch (corner) {
      case "top-left":
        return this.clampToViewport({ x: margin, y: margin });
      case "top-right":
        return this.clampToViewport({ x: vw - width - margin, y: margin });
      case "bottom-left":
        return this.clampToViewport({ x: margin, y: vh - height - margin });
      case "bottom-right":
        return this.clampToViewport({
          x: vw - width - margin,
          y: vh - height - margin,
        });
    }
  }

  private clampToViewport(position: Point): Point {
    const margin = 16;
    const rect = this.getBoundingClientRect();
    const width = rect.width || this.offsetWidth || 400;
    const height = rect.height || this.offsetHeight || 360;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minX = width + margin * 2 <= vw ? margin : 0;
    const minY = height + margin * 2 <= vh ? margin : 0;
    const maxX = width + margin * 2 <= vw
      ? vw - width - margin
      : Math.max(0, vw - width);
    const maxY = height + margin * 2 <= vh
      ? vh - height - margin
      : Math.max(0, vh - height);
    return {
      x: Math.min(Math.max(position.x, minX), maxX),
      y: Math.min(Math.max(position.y, minY), maxY),
    };
  }

  private isOutsideViewport(): boolean {
    const margin = 16;
    const rect = this.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minX = rect.width + margin * 2 <= vw ? margin : 0;
    const minY = rect.height + margin * 2 <= vh ? margin : 0;
    const maxX = rect.width + margin * 2 <= vw
      ? vw - rect.width - margin
      : Math.max(0, vw - rect.width);
    const maxY = rect.height + margin * 2 <= vh
      ? vh - rect.height - margin
      : Math.max(0, vh - rect.height);
    return rect.left < minX || rect.top < minY || rect.left > maxX ||
      rect.top > maxY;
  }

  private snapAfterPointerSettle(): void {
    const corner = this.currentCorner;
    if (corner) {
      this.snapTo(corner);
      return;
    }
    if (this.snapToHotCorner()) return;
    if (this.isOutsideViewport()) this.snapToNearestCorner();
  }

  private snapToHotCorner(): boolean {
    const corner = this.resolveHotCorner();
    if (!corner) return false;
    this.snapTo(corner);
    return true;
  }

  private resolveHotCorner(): Option<MiniWindow.Corner> {
    const rect = this.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const candidates: { corner: MiniWindow.Corner; distance2: number }[] = [
      {
        corner: "top-left",
        distance2: rect.left ** 2 + rect.top ** 2,
      },
      {
        corner: "top-right",
        distance2: (vw - rect.right) ** 2 + rect.top ** 2,
      },
      {
        corner: "bottom-left",
        distance2: rect.left ** 2 + (vh - rect.bottom) ** 2,
      },
      {
        corner: "bottom-right",
        distance2: (vw - rect.right) ** 2 + (vh - rect.bottom) ** 2,
      },
    ];
    const best = candidates.reduce((a, b) =>
      b.distance2 < a.distance2 ? b : a
    );
    return best.distance2 <= HOT_CORNER_THRESHOLD_PX ** 2
      ? best.corner
      : null;
  }

  private snapToNearestCorner(): void {
    const rect = this.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const corner: MiniWindow.Corner =
      centerX < vw / 2
        ? centerY < vh / 2
          ? "top-left"
          : "bottom-left"
        : centerY < vh / 2
          ? "top-right"
          : "bottom-right";

    this.snapTo(corner);
  }

  /**
   * Dock: slide the whole window straight down off the bottom of the screen,
   * leaving `PEEK_PX` visible above the bottom edge. The peeking sliver is
   * clickable to restore (see the host onClick in the constructor).
   */
  dock(): void {
    if (this.state !== "detached") return;
    this.savedCorner = this.currentCorner ?? "bottom-left";
    const x = this.getBoundingClientRect().left; // slide straight down, keep x
    const y = window.innerHeight - PEEK_PX;
    this.style.setProperty("--docked-transform", `translate(${x}px, ${y}px)`);
    this.updateState("docked"); // the :host transform transition animates the slide
    this.props.onDock?.();
  }

  undock(): void {
    if (this.state !== "docked") return;
    this.updateState("detached");
    this.snapTo(this.savedCorner ?? "bottom-left"); // also refreshes y for current viewport
    this.props.onUndock?.();
  }

  toggleDock(): void {
    if (this.state === "docked") {
      this.undock();
    } else {
      this.dock();
    }
  }

  static $styles: Style.Compat[] = [
    Typography.$maxLines,
    css`
      :host {
        position: relative;
        height: var(--mini-window-height, 360px);
        /* Opt-in cap: a grow-to-content consumer (e.g. the sheet-details drawer)
           sets --mini-window-height: auto + --mini-window-max-height so the
           window hugs its content up to this ceiling. Unset elsewhere → none. */
        max-height: var(--mini-window-max-height);
        width: var(--mini-window-width, 400px);
        display: none;
        transition: transform var(--mini-window-transition-duration, 0.3s) var(--mini-window-transition-easing, ease-out), height 0.3s ease, width 0.3s ease;
      }

      :host([state=docked]),
      :host([state=detached]) {
        display: block;
      }

      :host([state=docked]) {
        position: fixed;
        top: 0px;
        left: 0px;
        z-index: 2001; /* ZIndex.SIDEBAR + 1 */
        transform: var(--docked-transform);
        width: var(--mini-window-detached-width, var(--mini-window-width, 400px));
        height: var(--mini-window-detached-height, var(--mini-window-height, 360px));
      }

      :host([state=detached]) {
        position: fixed;
        top: 0px;
        left: 0px;
        z-index: 2002; /* ZIndex.SIDEBAR + 2 */

        transform: var(--detached-transform);
        width: var(--mini-window-detached-width, var(--mini-window-width, 400px));
        height: var(--mini-window-detached-height, var(--mini-window-height, 360px));
      }

      @keyframes mini-window-reveal {
        from {
          opacity: 0;
          transform: var(--detached-transform) translateY(12px);
        }
        to {
          opacity: 1;
          transform: var(--detached-transform);
        }
      }

      :host([revealing]) {
        animation: mini-window-reveal 0.3s ease-out forwards;
      }

      :host([preparing-reveal]) {
        opacity: 0;
        pointer-events: none;
      }

      #root {
        height: 100%;
      }

      #nav {
        height: var(--mini-window-nav-height, 52px);
        width: 100%;
        border-top-left-radius: var(--mini-window-border-radius, 12px);
        border-top-right-radius: var(--mini-window-border-radius, 12px);
        border-bottom: 1px solid var(--divider);
        cursor: grab;
        align-items: center;
        padding-inline: 8px;
        gap: 8px;
        background: var(--mini-window-nav-bg, transparent);
        color: var(--mini-window-nav-fg, inherit);
        /* Icon glyphs read --std-icon-button-color (not the inherited color), so
           bridge it to the nav foreground; falls back to the icon default. */
        --std-icon-button-color: var(--mini-window-nav-fg, var(--fg-icon-sec));
        z-index: 1;
      }

      #nav:active {
        cursor: grabbing;
      }

      /* .max-lines-2 (Typography.$maxLines) sets display:-webkit-box + the
         2-line clamp; [hidden] must win over it to hide an empty title. */
      #title {
        flex: 1;
        min-width: 0;
        color: var(--mini-window-nav-fg, var(--text-sec));
        padding-left: 4px;
        word-break: break-word;
      }

      #title[hidden] {
        display: none;
      }

      #content {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        /* Default: scroll content that exceeds the window. A window whose content
           fills exactly (e.g. the pomodoro app) sets this to hidden so no
           scrollbar appears (a scrollbar would also shave width off the content). */
        overflow-y: var(--mini-window-content-overflow-y, auto);
      }

      #close {
        --std-icon-button-dimension: 24px;
      }

      #dock {
        display: none;
        --std-icon-button-dimension: 24px;
      }

      :host([dockable]) #dock {
        display: grid;
      }

      #resize-handle {
        display: none;
        position: absolute;
        bottom: 0px;
        right: 0px;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
        z-index: 2;
      }

      :host([state=detached]) #resize-handle {
        display: block;
      }

      /* Chromeless: hide all window chrome; slotted content is the visible UI. */
      :host([chromeless]) #nav,
      :host([chromeless]) #dock,
      :host([chromeless]) #close,
      :host([chromeless]) #bg,
      :host([chromeless]) #resize-handle {
        display: none;
      }

      /* Radius delegation: yield the window silhouette (corner radius +
         drop-shadow) to the slotted content, which draws its own rounded surface
         (e.g. the sticker sheet's std-round). The content wrapper's default
         overflow:auto would otherwise shave the slotted surface's drop-shadow and
         square off its rounded corners; visible lets the content own the shape.
         Pair with chromeless (which hides this window's own bg/chrome). */
      :host([delegate-radius]) #content {
        overflow: visible;
      }

    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <std-round id=bg floating></std-round>
      <std-row id=nav>
        <p id=title class="max-lines-2" hidden></p>
        <std-icon-button id=dock></std-icon-button>
        <std-icon-button id=close></std-icon-button>
      </std-row>
      <div id=content>
        <slot></slot>
      </div>
      <div id=resize-handle></div>
    </std-col>
  `;
}

export namespace MiniWindow {
  export type Corner =
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right";

  export type Props = {
    // Initial position when revealed
    initialPosition?: { x: number; y: number };

    // Custom title/content for nav bar
    title?: string;

    // Enable hot-corner snapping and viewport rescue behavior.
    snapToCorners?: boolean;

    // Hide all window chrome (nav/title/close/bg/resize); the slotted content
    // provides the visible chrome and (via setDragHandle) the drag handle.
    chromeless?: boolean;

    // Yield the window silhouette (corner radius + drop-shadow) to the slotted
    // content: stop clipping the content wrapper so a slotted card's own rounded
    // surface and its drop-shadow render unclipped. Pair with `chromeless` when
    // the slotted content provides the whole visible card (e.g. the landing
    // sticker sheet, whose std-round surface owns the rounding).
    delegateRadius?: boolean;

    // Minimum width when resizing (default: 200)
    minWidth?: number;

    // Show a "_" dock button in the nav. When docked, the window slides down to
    // an 8px peek above the bottom edge; click the peek to restore.
    dockable?: boolean;

    // Callbacks
    onClose?: () => void;
    onDock?: () => void;
    onUndock?: () => void;
  };
}
