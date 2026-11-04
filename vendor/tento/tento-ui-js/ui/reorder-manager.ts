import { $$ } from "../fastdom";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Point } from "@tento-core/point";
import { Tracing } from "@tento-core/tracing";
import { Utils } from "../utils";
import { ZIndex } from "../z-index";

export type ReorderManagerOnUpdatePosition<$Row> = (
  $draggedElement: $Row,
  $before: Option<$Row>,
  $after: Option<$Row>,
  $newRowOrder: $Row[],
) => boolean | Promise<boolean>;

const BASE_TRANSITION = "background 0.3s ease, box-shadow 0.3s ease";

let id = 0;
export class ReorderManager<$Row extends HTMLElement> {
  private rows: Set<$Row> = new Set();
  private originalRowOrder: $Row[] = [];
  private currentRowOrder: $Row[] = [];
  private offsets: Option<Map<$Row, DOMRect>>;
  private startPoint: Option<Point>;
  private $draggedElement: Option<$Row>;
  private draggedIndex: Option<number>;

  private $parent: Option<HTMLElement>;
  private originalParentSize: Option<{
    height: number;
    width: number;
  }>;

  private started: boolean = false;
  private gestureStart: Option<Point>;
  readonly reorderId: number = id++;

  constructor(
    $parent: HTMLElement,
    private readonly onUpdatePosition: ReorderManagerOnUpdatePosition<$Row>,
    public gap: number = 0,
    private readonly onDragActiveChange: Option<
      ($e: HTMLElement, active: boolean) => void
    > = null,
  ) {
    this.$parent = $parent;
    $$.mutate(() => {
      $parent.setAttribute("reorder-id", String(this.reorderId));
    });
    document.addEventListener("pointermove", (e) => {
      if (!this.started) {
        if (!this.gestureStart) return;
        if (
          !Utils.passesJitterThreshold({
            x: e.pageX - this.gestureStart!.x,
            y: e.pageY - this.gestureStart!.y,
          })
        ) {
          return;
        }
        this.startGesture();
      }
      e.stopPropagation();

      const delta = {
        x: e.pageX - this.gestureStart!.x,
        y: e.pageY - this.gestureStart!.y,
      };
      this.$draggedElement!.style.setProperty("transition", BASE_TRANSITION);
      this.$draggedElement!.style.setProperty("--cursor-x", delta.x + "px");
      this.$draggedElement!.style.setProperty("--cursor-y", delta.y + "px");
    });
    document.addEventListener("pointerup", (e) => {
      if (!this.started) {
        this.gestureStart = null;
        this.startPoint = null;
        return;
      }
      e.stopPropagation();
      this.completeGesture();
    });
  }

  reset() {
    this.rows = new Set();
    this.currentRowOrder = [];
    this.originalRowOrder = [];
  }

  getRowCount(): number {
    return this.rows.size;
  }

  registerRow($row: $Row) {
    this.rows.add($row);
    this.originalRowOrder.push($row);

    $row.style.transition = "transform 0.15s ease, " + BASE_TRANSITION;
    $row.style.transform =
      "translate(var(--cursor-x, 0px), calc(var(--cursor-y, 0px) + var(--offset-y, 0px)))";
    $row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.$draggedElement = $row;
      this.gestureStart = {
        x: e.pageX,
        y: e.pageY,
      };
      this.startPoint = {
        x: e.clientX,
        y: e.clientY,
      };
    });
    $row.addEventListener("pointermove", (e) => {
      if (!this.started) {
        if (!this.gestureStart) return;
        if (
          !Utils.passesJitterThreshold({
            x: e.pageX - this.gestureStart!.x,
            y: e.pageY - this.gestureStart!.y,
          })
        ) {
          return;
        }
        this.startGesture();
      }
      if (this.$draggedElement === $row) return;
      this.currentRowOrder = [];
      const r = this.offsets?.get($row);
      const draggedOverTopHalf = e.offsetY < r!.height / 2;
      for (const [ci, $child] of this.originalRowOrder.entries()) {
        if (ci === this.draggedIndex) continue;
        $child.style.transition = "transform 0.3s ease, " + BASE_TRANSITION;
        if ($child !== $row) {
          this.currentRowOrder.push($child);
        } else if (draggedOverTopHalf) {
          this.currentRowOrder.push(this.$draggedElement!);
          this.currentRowOrder.push($child);
        } else {
          this.currentRowOrder.push($child);
          this.currentRowOrder.push(this.$draggedElement!);
        }
      }
      this.updateRowTransforms(false, this.gap);
    });
    $row.addEventListener("pointerup", (e) => {
      if (e.button !== 0) return;
      if (!this.started) {
        this.gestureStart = null;
        this.startPoint = null;
        return;
      }
      this.completeGesture();
      e.stopPropagation();
    });
  }

  private startGesture() {
    this.started = true;

    GESTURE_MANAGER.setPointerCapture(this.$draggedElement!);
    const originalParentRect = this.$parent?.getBoundingClientRect();

    this.originalParentSize = {
      height: this.$parent!.offsetHeight,
      width: this.$parent!.offsetWidth,
    };
    this.$parent!.style.height = originalParentRect!.height + "px";
    this.$parent!.style.width = originalParentRect!.width + "px";

    this.currentRowOrder = [...this.originalRowOrder];
    this.offsets = this.getOffsetsForRows();

    this.$parent!.style.transform = "translateZ(0)";
    for (const [index, $child] of this.originalRowOrder.entries()) {
      const isDraggedElement = $child === this.$draggedElement;
      if (isDraggedElement) this.draggedIndex = index;

      const rect = this.offsets.get($child)!;

      const relativeLeft = rect.left - originalParentRect!.left;
      $child.assignStyles({
        position: "fixed",
        top: "0px",
        left: relativeLeft + "px",
        width: rect.width + "px",
        height: rect.height + "px",
        zIndex: String(ZIndex.DRAG_GHOST),
        pointerEvents: isDraggedElement ? "none" : "",
        transition: BASE_TRANSITION,
      });

      if (isDraggedElement) {
        document.body.appendChild($child);
        $child.assignStyles({
          position: "absolute",
          left: originalParentRect!.left + "px",
          top: originalParentRect!.top + "px",
          minWidth: "0px",
        });
        this.onDragActiveChange?.($child, true);
        Tracing.dev("dbg/reorder", $child, $child.offsetWidth);
      }
    }
    this.updateRowTransforms(true, this.gap);
  }

  async completeGesture() {
    Tracing.dev("dbg/reorder/complete-gesture");
    GESTURE_MANAGER.clearPointerCapture(this.$draggedElement!);

    this.startPoint = null;
    this.gestureStart = null;
    this.started = false;
    this.onDragActiveChange?.(this.$draggedElement!, false);

    const idx = this.currentRowOrder.indexOf(this.$draggedElement!);
    const $before = this.currentRowOrder[idx - 1];
    const $after = this.currentRowOrder[idx + 1];

    const shouldCommit = await this.onUpdatePosition(
      this.$draggedElement!,
      $before,
      $after,
      this.currentRowOrder,
    );

    if (shouldCommit) {
      $$.mutate(() => {
        this.updateRowTransforms(true, this.gap);
        for (const row of this.currentRowOrder) {
          this.$parent?.appendChild(row);
        }
      });
      this.originalRowOrder = [...this.currentRowOrder];
    } else {
      this.currentRowOrder = [...this.originalRowOrder];
    }

    $$.mutate(() => {
      this.$parent!.style.height = this.originalParentSize!.height + "px";
      this.$parent!.style.width = this.originalParentSize!.width + "px";
      $$.mutateEnd(() => {
        this.$parent!.style.height = "";
        this.$parent!.style.width = "";
      });
    });

    const baseStyles = {
      transition: shouldCommit
        ? "transform 0.3s ease, " + BASE_TRANSITION
        : BASE_TRANSITION,
      pointerEvents: "",
      "--cursor-x": "",
      "--cursor-y": "",
      "--offset-y": "",
      position: "",
      top: "",
      left: "",
      width: "",
      height: "",
      minWidth: "",
      zIndex: "",
    };

    $$.mutate(() => {
      for (const [_i, $child] of this.currentRowOrder.entries()) {
        $child.assignStyles(baseStyles);
      }
    });
  }

  private updateRowTransforms(transformDragged: boolean, gap: number) {
    let currentY = 0;
    for (const $child of this.currentRowOrder) {
      const rect = this.offsets!.get($child)!;
      const isDragged = $child === this.$draggedElement;

      if (!transformDragged && isDragged) {
        currentY += rect.height + gap;
        continue;
      }
      $child.style.setProperty("--offset-y", currentY + "px");
      currentY += rect.height + gap;
    }
  }

  private getOffsetsForRows(): Map<$Row, DOMRect> {
    const map = new Map();
    for (const $row of this.rows) map.set($row, $row.getBoundingClientRect());
    return map;
  }
}
