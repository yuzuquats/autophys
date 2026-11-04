import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";

// The drag bar stack-review and the sidebar each hand-roll — neither reachable
// by keyboard. `role=separator` with `tabindex=0`, `aria-orientation` and
// `aria-valuenow/min/max`; a drag through `GESTURE_MANAGER.addDragGesture`
// reports pixel values through `onResize` and the final one through
// `onResizeEnd`; arrows step, Shift steps ten times further. A `dragging`
// attribute widens the hover band while a drag is live. The component owns
// no size itself: the caller applies the value to whatever it is resizing.
@component({ name: "std-resize-handle" })
export class ResizeHandle extends LonaWebComponent {
  private $bar: HTMLElement = this.$("bar");
  private props: Option<ResizeHandle.Props>;
  private value = 0;

  constructor() {
    super();
    let start = 0;
    GESTURE_MANAGER.addDragGesture(this.$bar, "std-resize-handle", {
      onPointerDown: () => {
        start = this.value;
        this.toggleAttribute("dragging", true);
      },
      onPointerMove: (e) => {
        const props = this.props;
        if (props == null) return;
        const delta = props.orientation === "vertical" ? e.offset.x : e.offset.y;
        this.set(start + delta, false);
      },
      onPointerUp: () => {
        this.toggleAttribute("dragging", false);
        this.props?.onResizeEnd?.(this.value);
      },
    });
    this.$bar.addEventListener("keydown", this.onKeydown);
  }

  bind(props: ResizeHandle.Props): this {
    this.props = props;
    this.value = props.value;
    this.toggleAttribute("vertical", props.orientation === "vertical");
    this.$bar.setAttribute("role", "separator");
    this.$bar.setAttribute("aria-orientation", props.orientation);
    this.$bar.setAttribute("aria-label", props.ariaLabel);
    this.$bar.setAttribute("aria-valuemin", String(props.min));
    this.$bar.setAttribute("aria-valuemax", String(props.max));
    this.$bar.tabIndex = 0;
    this.reflect();
    return this;
  }

  private reflect(): void {
    this.$bar.setAttribute("aria-valuenow", String(Math.round(this.value)));
  }

  private set(px: number, end: boolean): void {
    const props = this.props;
    if (props == null) return;
    const clamped = Math.round(Math.min(props.max, Math.max(props.min, px)));
    if (clamped === this.value && !end) return;
    this.value = clamped;
    this.reflect();
    props.onResize(clamped);
    if (end) props.onResizeEnd?.(clamped);
  }

  private onKeydown = (e: KeyboardEvent): void => {
    const props = this.props;
    if (props == null) return;
    const step = (props.stepPx ?? 8) * (e.shiftKey ? 10 : 1);
    const grow = props.orientation === "vertical" ? "ArrowRight" : "ArrowDown";
    const shrink = props.orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
    let next: Option<number> = null;
    if (e.key === grow) next = this.value + step;
    else if (e.key === shrink) next = this.value - step;
    else if (e.key === "Home") next = props.min;
    else if (e.key === "End") next = props.max;
    if (next == null) return;
    e.preventDefault();
    this.set(next, true);
  };

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.value = 0;
    this.removeAttribute("vertical");
    this.removeAttribute("dragging");
    for (const a of ["role", "aria-orientation", "aria-label", "aria-valuemin", "aria-valuemax", "aria-valuenow"]) this.$bar.removeAttribute(a);
  }

  static makeWith(props: ResizeHandle.Props): ResizeHandle {
    return ResizeHandle.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --resize-handle-size: var(--resize-handle-size-preset, 8px);
        --resize-handle-color: var(--resize-handle-color-preset, var(--divider));
        --resize-handle-active: var(--resize-handle-active-preset, var(--blue));

        display: block;
        flex: none;
        width: 100%;
        height: var(--resize-handle-size);
      }

      :host([vertical]) {
        width: var(--resize-handle-size);
        height: 100%;
      }

      #bar {
        position: relative;
        width: 100%;
        height: 100%;
        cursor: row-resize;
        touch-action: none;
        outline: none;
      }

      :host([vertical]) #bar {
        cursor: col-resize;
      }

      /* The visible rule: one pixel, centred in the hit band. */
      #bar::before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        top: 50%;
        height: 1px;
        transform: translateY(-50%);
        background: var(--resize-handle-color);
        transition: background 0.12s ease, height 0.12s ease;
      }

      :host([vertical]) #bar::before {
        top: 0;
        bottom: 0;
        left: 50%;
        right: auto;
        width: 1px;
        height: auto;
        transform: translateX(-50%);
      }

      #bar:hover::before,
      :host([dragging]) #bar::before,
      #bar:focus-visible::before {
        background: var(--resize-handle-active);
        height: 3px;
      }

      :host([vertical]) #bar:hover::before,
      :host([vertical][dragging]) #bar::before,
      :host([vertical]) #bar:focus-visible::before {
        height: auto;
        width: 3px;
      }

      @media (prefers-reduced-motion: reduce) {
        #bar::before {
          transition: none;
        }
      }
    `,
  ];

  static $html = html`<div id="bar"></div>`;
}

export namespace ResizeHandle {
  export type Props = {
    /** `vertical` separates side-by-side panes (drag left/right). */
    orientation: "horizontal" | "vertical";
    ariaLabel: string;
    value: number;
    min: number;
    max: number;
    onResize: (px: number) => void;
    onResizeEnd: Option<(px: number) => void>;
    /** Arrow-key step; default 8. Shift multiplies by ten. */
    stepPx: Option<number>;
  };
}
