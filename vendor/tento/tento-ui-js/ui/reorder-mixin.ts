import { nonnull } from "@tento-core/assert";
import { Constants } from "@tento-core/constants";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Tracing } from "@tento-core/tracing";
import { Point } from "@tento-core/point";

type PointerUpOverride = (e: PointerEvent) => boolean;
type DragStartCallback<T extends HTMLElement> = (
  mixin: HTMLElementReorderMixin<T>,
  $e: T,
  offsetX: number,
  offsetY: number,
) => void;
type DragOverCallback<T extends HTMLElement> = (
  $draggedElement: T,
  $draggedOverElement: T,
  draggedOverTopHalf: boolean,
  $previousDraggedOverElement: T | null,
  draggedOverMiddle: boolean,
) => void;
type DragCompleteCallback<T extends HTMLElement> = (
  $draggedElement: T,
  $draggedOverElement: T,
  draggedOverTopHalf: boolean,
  draggedOverMiddle: boolean,
) => Option<{ canHandle: boolean }> | void;
type DragFailCallback<T extends HTMLElement> = (
  $draggedElement: T,
  $draggedOverElement: T,
) => void;

const JITTER_DIST_2 = 50;

export class HTMLElementReorderMixin<T extends HTMLElement> {
  private pointerUpOverride: PointerUpOverride;
  private onDragStart: DragStartCallback<T>;
  private onDragOver: DragOverCallback<T>;
  private onDragComplete: DragCompleteCallback<T>;
  private onDragFail: DragFailCallback<T>;
  private releaseIdentifier: (s: string) => void = Constants.EMPTY_FUNCTION;
  private canReceivePointerIdentifier: (s: string) => boolean = () => true;
  private setPointerCapture: (capture: () => void, identifier: string) => void =
    Constants.EMPTY_FUNCTION;

  // State
  private pressed: boolean = false;
  private $selectedTarget: T | null = null;
  private $mousedOverTarget: T | null = null;
  private mousedOverUpperHalf: boolean = false;
  private mousedOverMiddle: boolean = false;
  private identifier: string;
  private startMousePosition: Point | null = null;
  private dragging: boolean = false;

  private resetState() {
    this.pressed = false;
    this.mousedOverUpperHalf = false;
    this.mousedOverMiddle = false;
    this.$mousedOverTarget = null;
    this.$selectedTarget = null;
    this.startMousePosition = null;
    this.dragging = false;
  }

  static default<T extends HTMLElement>(
    config: {
      onDragStart?: Option<($e: T) => void>;
      onDraggedStateChanged?(
        $draggedOverElement: T,
        force: boolean,
        upperHalf: boolean,
      ): Option<{ canHandle: boolean }>;
      willDragComplete?: DragCompleteCallback<T>;
      didDragComplete?: () => void;
      bindGhostImage?: ($reference: T, $ghost: T) => void;
      identifier: string;
      setGhostImage: <T extends HTMLElement = HTMLElement>(
        ghostImageContent: Option<T | Node>,
        size?: {
          width?: number;
          height?: number;
        },
        offset?: {
          x?: number;
          y?: number;
        },
      ) => Option<T>;
    },
    controlledComponent: boolean = true,
  ): HTMLElementReorderMixin<T> {
    let $previousDraggedElement: T | null = null;
    let previousDraggedOverTopHalf: boolean = false;
    let previousDraggedOverMiddle: boolean = false;
    return HTMLElementReorderMixin.create({
      async onDragStart(
        mixin: HTMLElementReorderMixin<T>,
        $e: T,
        offsetX: number,
        offsetY: number,
      ) {
        if (config.onDragStart) config.onDragStart($e);
        GESTURE_MANAGER.setPointerCapture($e);
        GESTURE_MANAGER.toggleCleanUpOnClickOutside(
          $e,
          ($pointerUpElement: Option<HTMLElement>) => {
            this.onDragComplete(
              $e,
              $previousDraggedElement ?? $e,
              previousDraggedOverTopHalf,
              previousDraggedOverMiddle,
            );
            mixin.resetState();
            GESTURE_MANAGER.clearPointerCapture($e);
          },
        );
        const $ghost = config.setGhostImage<T>(
          $e.cloneNode(true),
          {
            width: $e.offsetWidth,
          },
          {
            x: -offsetX,
            y: -offsetY,
          },
        )!;
        config?.bindGhostImage && config.bindGhostImage($e, $ghost);
        $ghost.toggleAttribute("is-being-dragged", true);
      },
      onDragOver(
        $draggedElement: T,
        $draggedOverElement: T,
        draggedOverTopHalf: boolean,
        $previousDraggedOverElement: T | null,
        draggedOverMiddle: boolean,
      ) {
        if ($previousDraggedOverElement) {
          const r = (config.onDraggedStateChanged &&
            config.onDraggedStateChanged(
              $previousDraggedOverElement,
              false,
              false,
            )) ?? { canHandle: true };
          r.canHandle &&
            $previousDraggedOverElement.removeAttribute(
              "is-being-dragged-over",
            );
        }
        const r = (config.onDraggedStateChanged &&
          config.onDraggedStateChanged(
            $draggedOverElement,
            true,
            draggedOverTopHalf,
          )) ?? { canHandle: true };
        r.canHandle &&
          $draggedOverElement?.setAttribute(
            "is-being-dragged-over",
            draggedOverTopHalf ? "top" : "bottom",
          );
        $previousDraggedElement = $draggedOverElement;
        previousDraggedOverMiddle = draggedOverMiddle;
        previousDraggedOverTopHalf = draggedOverTopHalf;
      },
      onDragComplete(
        $draggedElement: T,
        $draggedOverElement: T,
        draggedOverTopHalf: boolean,
        draggedOverMiddle: boolean,
      ) {
        config.setGhostImage(null);
        $draggedElement.toggleAttribute("is-being-dragged", false);
        if ($draggedOverElement) {
          $draggedOverElement.removeAttribute("is-being-dragged-over");
        }
        if ($previousDraggedElement) {
          $previousDraggedElement.removeAttribute("is-being-dragged-over");
        }
        const r = (config.willDragComplete &&
          config.willDragComplete(
            $draggedElement,
            $draggedOverElement,
            draggedOverTopHalf,
            draggedOverMiddle,
          )) ?? {
          canHandle: true,
        };
        Tracing.dev("drag complete", r, controlledComponent);
        if (r.canHandle && controlledComponent) {
          // NOTE: https://stackoverflow.com/questions/21926083/failed-to-execute-removechild-on-node
          // We can't drag a focused element
          $draggedElement.blur();
          if (draggedOverTopHalf) {
            $draggedOverElement.before($draggedElement);
          } else {
            $draggedOverElement.after($draggedElement);
          }
        }
        config.didDragComplete && config.didDragComplete();
        GESTURE_MANAGER.clearPointerCapture($draggedElement);
      },
      onDragFail($draggedElement: T, $draggedOverElement: T) {
        config.setGhostImage(null);
        if ($draggedOverElement) {
          $draggedOverElement.removeAttribute("is-being-dragged-over");
        }
        GESTURE_MANAGER.clearPointerCapture($draggedElement);
      },
      identifier: config.identifier,
    });
  }

  static create<T extends HTMLElement>(config: {
    onDragStart: DragStartCallback<T>;
    onDragOver: DragOverCallback<T>;
    onDragComplete: DragCompleteCallback<T>;
    onDragFail: DragFailCallback<T>;
    identifier: string;
  }): HTMLElementReorderMixin<T> {
    return new HTMLElementReorderMixin(
      () => false,
      config.onDragStart,
      config.onDragOver,
      config.onDragComplete,
      config.onDragFail,
      config.identifier,
      () => true,
      () => {},
      () => {},
    );
  }

  constructor(
    pointerUpOverride: PointerUpOverride,
    onDragStart: (
      mixin: HTMLElementReorderMixin<T>,
      $e: T,
      offsetX: number,
      offsetY: number,
    ) => void,
    onDragOver: DragOverCallback<T>,
    onDragComplete: DragCompleteCallback<T>,
    onDragFail: DragFailCallback<T>,
    identifier: string,
    canReceivePointerIdentifier: (s: string) => boolean,
    releaseIdentifier: (s: string) => void,
    setPointerCapture: (capture: () => void, identifier: string) => void,
  ) {
    this.pointerUpOverride = pointerUpOverride;
    this.onDragStart = onDragStart;
    this.onDragOver = onDragOver;
    this.onDragComplete = onDragComplete;
    this.onDragFail = onDragFail;
    this.releaseIdentifier = releaseIdentifier;
    this.canReceivePointerIdentifier = canReceivePointerIdentifier;
    this.setPointerCapture = setPointerCapture;
    this.identifier = identifier;
  }

  bind($e: T) {
    $e.addEventListener("pointerdown", (e) => this.onPointerDown(e, $e));
    $e.addEventListener("pointermove", (e) => this.onPointerMove(e, $e));
    $e.addEventListener("pointerup", (e) => this.onPointerUp(e, $e));
  }

  unbind($e: T) {
    // todo
    // $e.onpointerdown = null;
    // $e.onpointermove = null;
    // $e.onpointerup = null;
  }

  private onPointerDown(e: PointerEvent, $e: T) {
    if (!this.canReceivePointerIdentifier(this.identifier)) return;
    if (e.button != 0) return;
    e.stopPropagation();
    this.pressed = true;
    this.startMousePosition = {
      x: e.clientX,
      y: e.clientY,
    };
  }

  private onPointerMove(e: PointerEvent, $e: T) {
    if (!this.pressed) return;
    // e.stopImmediatePropagation();
    // e.stopPropagation();
    if (!this.dragging) {
      const newMousePosition: Point = { x: e.clientX, y: e.clientY };
      const dist2 = Point.d2(
        nonnull(this.startMousePosition),
        newMousePosition,
      );
      if (dist2 < JITTER_DIST_2) {
        return;
      }
      this.setPointerCapture(() => {
        this.onPointerUp(null, this.$mousedOverTarget);
      }, this.identifier);

      this.dragging = true;
      // @ts-ignore
      const rect = e.currentTarget.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      this.$selectedTarget = $e;
      this.onDragStart(
        this,
        this.$selectedTarget,
        offsetX,
        e.clientY - rect.top,
      );
    }

    const $previousMousedOverTarget = this.$mousedOverTarget;
    this.$mousedOverTarget = $e;
    // TODO: i dont understand this: https://stackoverflow.com/questions/35360704/wrong-offsetx-and-offsety-on-mousedown-event-of-parent-element
    // Because these elements can be recursively nested, we need to manually calculate the offset?
    // @ts-ignore
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    const offsetHeight = $e.offsetHeight;
    this.mousedOverUpperHalf = offsetY < offsetHeight / 2;
    const oneThirdHeight = offsetHeight / 3;
    this.mousedOverMiddle =
      offsetY > oneThirdHeight && offsetY < 2 * oneThirdHeight;
    this.onDragOver(
      nonnull(this.$selectedTarget),
      this.$mousedOverTarget,
      this.mousedOverUpperHalf,
      $previousMousedOverTarget,
      this.mousedOverMiddle,
    );
  }

  private onPointerUp(e: PointerEvent | null, $e: T | null) {
    if (e && this.pointerUpOverride(e)) return;
    if (!this.pressed) return;
    if (!this.$selectedTarget) {
      this.resetState();
      return;
    }
    if (this.$selectedTarget === $e) {
      Tracing.info("ui")("reorder/drag-up/ignore", {
        reason: "let go on same target",
        target: this.$selectedTarget,
      });
      this.onDragFail(this.$selectedTarget, nonnull(this.$mousedOverTarget));
      this.releaseIdentifier(this.identifier);
      this.resetState();
      return;
    }
    if (this.$mousedOverTarget == null) {
      Tracing.info("ui")("reorder/drag-up/ignore", {
        reason: "no moused over target",
      });
      this.onDragFail(
        nonnull(this.$selectedTarget),
        nonnull<T>(this.$mousedOverTarget),
      );
      this.releaseIdentifier(this.identifier);
      this.resetState();
      return;
    }
    e && e.stopImmediatePropagation();
    e && e.stopPropagation();
    Tracing.info("ui")("reorder/drag-up/complete");
    this.onDragComplete(
      this.$selectedTarget,
      this.$mousedOverTarget,
      this.mousedOverUpperHalf,
      this.mousedOverMiddle,
    );
    this.releaseIdentifier(this.identifier);
    this.resetState();
  }
}
