import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Point } from "@tento-core/point";

export type Vec2 = [number, number];

@component({
  name: "std-cc",
})
export class CartesianCoordinate extends LonaWebComponent {
  private _props: Option<CartesianCoordinate.Props>;
  private offsetX = 0;
  private offsetY = 0;
  private viewportSize: Size = { width: 0, height: 0 };

  // Gridline state
  /** Each axis has at most 256 generated lines; intervals below one CSS pixel reject. */
  static MAX_GRID_LINES_PER_AXIS = 256;
  private originAxes: CartesianCoordinate.Axis[] = [];
  private gridInterval = 0;
  private gridXLines: Map<number, CartesianCoordinate.Axis> = new Map();
  private gridYLines: Map<number, CartesianCoordinate.Axis> = new Map();

  onSizeChange: Option<(s: Size) => void> = (s) => {
    this.viewportSize = s;
    this.assignStyles({
      "--cs-width": String(s.width),
      "--cs-height": String(s.height),
      "--cs-x0-base": String(s.width / 2),
      "--cs-y0-base": String(s.height / 2),
    });
    this.updateGridlines();
  };

  constructor() {
    super();

    let baseOffset: Point;
    GESTURE_MANAGER.addDragGesture(this.$("root"), "cartesian-pan", {
      onPointerDown: () => {
        baseOffset = { x: this.offsetX, y: this.offsetY };
      },
      onPointerMove: ({ progress }) => {
        this.offsetX = baseOffset.x - progress.x;
        this.offsetY = baseOffset.y - progress.y;
        this.assignStyles({
          "--vp-offset-x": `${this.offsetX}`,
          "--vp-offset-y": `${this.offsetY}`,
        });
        this.updateGridlines();
      },
    });
  }

  bind(props: CartesianCoordinate.Props): this {
    const interval = props.gridInterval ?? (props.showAxes ? 50 : 0);
    // Zero explicitly disables the grid. Reject invalid density before replacing Props/DOM.
    if (!Number.isFinite(interval) || interval < 0 || (interval > 0 && interval < 1) ||
        (interval > 0 && this.gridValues(interval) == null)) {
      throw new RangeError("CartesianCoordinate gridInterval must be zero (off) or >=1 CSS pixel, with at most 256 lines per axis");
    }
    this._props = props;
    for (const axis of this.originAxes) axis.recycle();
    this.originAxes = [];
    if (props.showAxes) {
      for (const direction of ["x", "y"] as const) {
        const axis = CartesianCoordinate.Axis.make();
        axis.id = `${direction}-axis`;
        axis.setAttribute("axis", direction);
        axis.bind({ k: 0 });
        this.appendChild(axis);
        this.originAxes.push(axis);
      }
    }
    this.gridInterval = interval;
    this.updateGridlines();
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.updateGridlines();
  }

  disconnectedCallback(): void {
    this.clearGridlines();
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.clearGridlines();
    for (const axis of this.originAxes) axis.recycle();
    this.originAxes = [];
    this._props = null;
    this.gridInterval = 0;
    this.offsetX = this.offsetY = 0;
    this.viewportSize = { width: 0, height: 0 };
    super.onRecycle();
  }

  private clearGridlines(): void {
    for (const lines of [this.gridXLines, this.gridYLines]) {
      for (const axis of lines.values()) axis.recycle();
      lines.clear();
    }
  }

  private gridValues(interval: number): Option<{ x: number[]; y: number[] }> {
    const { width, height } = this.viewportSize;
    if (![width, height, this.offsetX, this.offsetY].every(Number.isFinite) || width < 0 || height < 0) return null;
    const axis = (min: number, max: number): Option<number[]> => {
      const first = Math.floor(min / interval);
      const last = Math.ceil(max / interval);
      const count = last - first + 1;
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) ||
          count < 0 || count > CartesianCoordinate.MAX_GRID_LINES_PER_AXIS) return null;
      const values: number[] = [];
      for (let index = 0; index < count; index++) {
        const value = (first + index) * interval;
        if (!Number.isFinite(value) || (index > 0 && value <= values[index - 1])) return null;
        values.push(value);
      }
      return values;
    };
    const x = axis(-width / 2 - this.offsetX, width / 2 - this.offsetX);
    const y = axis(-height / 2 + this.offsetY, height / 2 + this.offsetY);
    return x == null || y == null ? null : { x, y };
  }

  private updateGridlines(): void {
    if (this.gridInterval === 0 || this.viewportSize.width === 0) {
      this.clearGridlines();
      return;
    }
    const values = this.gridValues(this.gridInterval);
    // A later resize/pan outside the density/precision envelope hides only the grid.
    if (values == null) { this.clearGridlines(); return; }
    this.updateGridlinesForAxis("x", values.x, this.gridXLines, this.$("gridlines-x"));
    this.updateGridlinesForAxis("y", values.y, this.gridYLines, this.$("gridlines-y"));
  }

  private updateGridlinesForAxis(
    direction: "x" | "y",
    values: number[],
    lines: Map<number, CartesianCoordinate.Axis>,
    container: HTMLElement,
  ): void {
    const wanted = new Set(values.filter(k => !this._props?.showAxes || k !== 0));
    for (const [k, axis] of lines) {
      if (wanted.has(k)) continue;
      axis.recycle();
      lines.delete(k);
    }
    for (const k of wanted) {
      if (lines.has(k)) continue;
      const axis = CartesianCoordinate.Axis.make();
      axis.setAttribute("axis", direction);
      axis.bind({ k });
      container.appendChild(axis);
      lines.set(k, axis);
    }
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        position: relative;

        --cs-x0: calc(var(--cs-x0-base) + var(--vp-offset-x, 0));
        --cs-y0: calc(var(--cs-y0-base) + var(--vp-offset-y, 0));
        --cc-line-width: 1px;
        --cc-point-radius: 6px;
        overflow: hidden;
      }

      #root::after {
        position: absolute;
        content: "";
        inset: 0;
        border: 1px solid var(--divider-pri);
        border-radius: var(--border-radius, 0px);
        z-index: 1;
        pointer-events: none;
      }

      #root {
        position: relative;
        height: 100%;
        width: 100%;
        cursor: grab;
      }

      #root:active {
        cursor: grabbing;
      }

      #gridlines-x,
      #gridlines-y {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 1;
      }

      #gridlines-x std-cc-axis,
      #gridlines-y std-cc-axis {
        --line-color: var(--divider);
        --cc-line-width: 1px;
        --hover-target-size: 4px;
        pointer-events: auto;
      }

      #gridlines-x std-cc-axis::part(tooltip),
      #gridlines-y std-cc-axis::part(tooltip) {
        opacity: 0;
      }

      #gridlines-x std-cc-axis:hover::part(tooltip),
      #gridlines-y std-cc-axis:hover::part(tooltip) {
        opacity: 1;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <div id=root>
      <slot></slot>
      <div id=gridlines-x></div>
      <div id=gridlines-y></div>
    </div>
  `;
}

export namespace CartesianCoordinate {
  export type Props = {
    showAxes: boolean;
    /** Zero disables grid lines. Otherwise >=1 CSS pixel and <=256 lines/axis.
     * A later oversized/nonprogressing viewport suppresses the grid until valid again. */
    gridInterval?: Option<number>;
  };

  export const $lineStyles = css`
    :host {
      --start-x: 0;
      --start-y: 0;
      --end-x: 0;
      --end-y: 0;
      --line-color: var(--divider);

      --dx: calc(var(--end-x) - var(--start-x));
      --dy: calc(var(--end-y) - var(--start-y));
      --length: calc(sqrt(var(--dx) * var(--dx) + var(--dy) * var(--dy)) * 1px);

      display: block;
      position: absolute;
      left: 0;
      top: 0;
      width: var(--length);
      height: 0;
      transform-origin: 0 0;
      transform: translate(
          calc(var(--start-x) * 1px),
          calc(var(--start-y) * 1px)
        )
        rotate(atan2(var(--dy), var(--dx)));
    }

    :host::before {
      content: "";
      position: absolute;
      left: 0;
      top: calc(-0.5 * var(--cc-line-width));
      width: 100%;
      height: var(--cc-line-width);
      background: var(--line-color);
    }
  `;

  export const $labelStyles = css`
    .cc-label {
      background: var(--bg-elevated);
      color: var(--text-pri);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
      font-weight: 500;
      white-space: nowrap;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      pointer-events: none;
    }
  `;

  export const $hoverTargetStyles = css`
    :host {
      --hover-target-size: 16px;
      --tooltip-anchor-x: 0%;
      --tooltip-anchor-y: 0%;
      --tooltip-perpendicular-offset: 0px;
      --tooltip-offset-x: 8px;
      --tooltip-offset-y: 8px;
    }

    #hover-target {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: var(--hover-target-size);
      transform: translateY(-50%);
      cursor: pointer;
      border-radius: calc(var(--hover-target-size) / 2);
    }

    #hover-target:hover {
      background: var(--bg-hover);
    }

    #tooltip {
      position: absolute;
      left: 0;
      top: var(--tooltip-perpendicular-offset);
      transform: rotate(calc(-1 * atan2(var(--dy), var(--dx))))
        translate(var(--tooltip-anchor-x), var(--tooltip-anchor-y))
        translate(var(--tooltip-offset-x), var(--tooltip-offset-y));
      transform-origin: 0 0;
      opacity: 1;
      transition: opacity 0.3s ease;
    }

    #hover-target:hover + #tooltip {
      opacity: 1;
    }
  `;

  // A line segment from start to end in cartesian space
  @component({
    name: "std-cc-segment",
  })
  export class Segment extends LonaWebComponent {
    bind(props: Segment.Props) {
      this.assignStyles({
        "--seg-start-x": String(props.start.x),
        "--seg-start-y": String(props.start.y),
        "--seg-end-x": String(props.end.x),
        "--seg-end-y": String(props.end.y),
      });

      this.$("tooltip").textContent =
        `(${props.start.x}, ${props.start.y}) → (${props.end.x}, ${props.end.y})`;

      this.toggleAttribute("start-arrow", props.options?.startArrow === true);
      this.toggleAttribute("end-arrow", props.options?.endArrow === true);
      this.toggleAttribute("no-tooltip", props.options?.showTooltip === false);

      const label = props.options?.label;
      if (label) {
        this.$("label").textContent = label;
        this.toggleAttribute("has-label", true);
      } else {
        this.toggleAttribute("has-label", false);
      }
    }

    static $styles: Style.Compat[] = [
      $lineStyles,
      $hoverTargetStyles,
      $labelStyles,
      css`
        :host {
          --start-x: calc(var(--cs-x0) + var(--seg-start-x, 0));
          --start-y: calc(var(--cs-y0) - var(--seg-start-y, 0));
          --end-x: calc(var(--cs-x0) + var(--seg-end-x, 0));
          --end-y: calc(var(--cs-y0) - var(--seg-end-y, 0));
          --arrow-length: 8px;
          --arrow-width: 4px;
          z-index: 4;
        }

        #start-arrow,
        #end-arrow {
          display: none;
          position: absolute;
          top: 0;
          width: 0;
          height: 0;
          border-style: solid;
          border-color: transparent;
          transform: translateY(-50%);
        }

        #start-arrow {
          left: 0;
          border-width: var(--arrow-width) var(--arrow-length) var(--arrow-width) 0;
          border-right-color: var(--line-color);
          transform: translateX(0) translateY(-50%);
        }

        #end-arrow {
          right: 0;
          border-width: var(--arrow-width) 0 var(--arrow-width) var(--arrow-length);
          border-left-color: var(--line-color);
          transform: translateX(0) translateY(-50%);
        }

        :host([start-arrow]) #start-arrow {
          display: block;
        }

        :host([end-arrow]) #end-arrow {
          display: block;
        }

        #label {
          display: none;
          position: absolute;
          left: calc(var(--length) / 2);
          top: 0;
          transform: rotate(calc(-1 * atan2(var(--dy), var(--dx)))) translate(-50%, -50%);
          transform-origin: 0 0;
        }

        :host([has-label]) #label {
          display: block;
        }

        :host([no-tooltip]) #hover-target,
        :host([no-tooltip]) #tooltip {
          display: none;
        }
      `,
    ];

    static $html: Option<HTMLTemplateElement> = html`
      <div id="start-arrow"></div>
      <div id="end-arrow"></div>
      <div id="hover-target"></div>
      <div id="tooltip" class="cc-label"></div>
      <div id="label" class="cc-label"></div>
    `;
  }

  export namespace Segment {
    export interface Props {
      start: Point;
      end: Point;
      options?: Option<Options>;
    }

    export type Options = Optional<{
      startArrow: boolean;
      endArrow: boolean;
      showTooltip: boolean;
      label: string;
    }>;

    export namespace Props {
      export function fromPV(point: Point, vec: Vec2, t: number = 1): Props {
        return {
          start: point,
          end: { x: point.x + vec[0] * t, y: point.y + vec[1] * t },
        };
      }
    }
  }

  // An axis-aligned line: x=k (vertical) or y=k (horizontal)
  @component({
    name: "std-cc-axis",
  })
  export class Axis extends LonaWebComponent {
    private axis: "x" | "y" = "x";

    bind(props: Axis.Props) {
      const axis = this.getAttribute("axis") as "x" | "y" | null;
      if (axis) this.axis = axis;

      this.assignStyles({
        "--k": String(props.k),
      });

      this.$("tooltip").textContent =
        this.axis === "x" ? `x = ${props.k}` : `y = ${props.k}`;
    }

    static $styles: Style.Compat[] = [
      $lineStyles,
      $hoverTargetStyles,
      $labelStyles,
      css`
        :host {
          --line-color: var(--divider-pri);
          z-index: 2;
        }

        :host([axis="y"]) {
          --cs-k: calc(var(--cs-y0) - var(--k, 0));
          --start-x: 0;
          --start-y: clamp(0, var(--cs-k), var(--cs-height));
          --end-x: var(--cs-width);
          --end-y: clamp(0, var(--cs-k), var(--cs-height));
        }

        :host([axis="x"]) {
          --cs-k: calc(var(--cs-x0) + var(--k, 0));
          --start-x: clamp(0, var(--cs-k), var(--cs-width));
          --start-y: 0;
          --end-x: clamp(0, var(--cs-k), var(--cs-width));
          --end-y: var(--cs-height);
        }
      `,
    ];

    static $html: Option<HTMLTemplateElement> = html`
      <div id="hover-target"></div>
      <div id="tooltip" part="tooltip" class="cc-label"></div>
    `;
  }

  export namespace Axis {
    export interface Props {
      k: number;
    }
  }

  // A line defined by y = mx + b, clipped to the coordinate space bounds
  @component({
    name: "std-cc-line",
  })
  export class Line extends LonaWebComponent {
    bind(props: Line.Props) {
      this.assignStyles({
        "--line-m": String(props.m),
        "--line-b": String(props.b),
      });

      let label = "y = ";
      if (props.m !== 0) {
        if (props.m === 1) label += "x";
        else if (props.m === -1) label += "-x";
        else label += `${props.m}x`;
      }
      if (props.b !== 0) {
        if (props.m === 0) label += String(props.b);
        else if (props.b > 0) label += ` + ${props.b}`;
        else label += ` - ${-props.b}`;
      }
      if (props.m === 0 && props.b === 0) label += "0";
      this.$("tooltip").textContent = label;
    }

    /**
     * Line clipping algorithm for y = mx + b within a rectangular viewport.
     *
     * The visible cartesian bounds shift when the viewport is panned:
     *   x ∈ [vp-x-min, vp-x-max], y ∈ [vp-y-min, vp-y-max]
     *
     * Algorithm:
     * 1. Calculate the visible cartesian bounds based on viewport offset.
     * 2. Find where the line intersects the left and right viewport edges.
     * 3. Clamp y values to the visible vertical bounds.
     * 4. Back-calculate x from clamped y using x = (y - b) / m.
     * 5. Convert to screen space.
     */
    static $styles: Style.Compat[] = [
      $lineStyles,
      $hoverTargetStyles,
      $labelStyles,
      css`
        :host {
          --half-w: calc(var(--cs-width) / 2);
          --half-h: calc(var(--cs-height) / 2);
          --ox: var(--vp-offset-x, 0);
          --oy: var(--vp-offset-y, 0);

          --vp-x-min: calc(0 - var(--half-w) - var(--ox));
          --vp-x-max: calc(var(--half-w) - var(--ox));
          --vp-y-min: calc(0 - var(--half-h) + var(--oy));
          --vp-y-max: calc(var(--half-h) + var(--oy));

          --y-at-left-raw: calc(var(--line-m) * var(--vp-x-min) + var(--line-b));
          --y-at-right-raw: calc(var(--line-m) * var(--vp-x-max) + var(--line-b));

          --y-at-left: clamp(var(--vp-y-min), var(--y-at-left-raw), var(--vp-y-max));
          --y-at-right: clamp(var(--vp-y-min), var(--y-at-right-raw), var(--vp-y-max));

          --x-at-left: calc((var(--y-at-left) - var(--line-b)) / var(--line-m));
          --x-at-right: calc((var(--y-at-right) - var(--line-b)) / var(--line-m));

          --start-cart-x: clamp(var(--vp-x-min), var(--x-at-left), var(--vp-x-max));
          --start-cart-y: var(--y-at-left);
          --end-cart-x: clamp(var(--vp-x-min), var(--x-at-right), var(--vp-x-max));
          --end-cart-y: var(--y-at-right);

          --start-x: calc(var(--cs-x0) + var(--start-cart-x));
          --start-y: calc(var(--cs-y0) - var(--start-cart-y));
          --end-x: calc(var(--cs-x0) + var(--end-cart-x));
          --end-y: calc(var(--cs-y0) - var(--end-cart-y));

          z-index: 4;
        }
      `,
    ];

    static $html: Option<HTMLTemplateElement> = html`
      <div id="hover-target"></div>
      <div id="tooltip" class="cc-label"></div>
    `;
  }

  export namespace Line {
    export interface Props {
      m: number; // slope
      b: number; // y-intercept
    }
  }

  // A point marker at cartesian coordinates
  @component({
    name: "std-cc-point",
  })
  export class CCPoint extends LonaWebComponent {
    bind(props: CCPoint.Props) {
      this.assignStyles({
        "--point-x": String(props.point.x),
        "--point-y": String(props.point.y),
      });

      this.$("tooltip").textContent = `(${props.point.x}, ${props.point.y})`;

      const $label = this.$("label");
      if (props.label) {
        $label.textContent = props.label;
        this.toggleAttribute("has-label", true);
      } else {
        this.toggleAttribute("has-label", false);
      }
    }

    static $styles: Style.Compat[] = [
      $labelStyles,
      css`
        :host {
          --point-x: 0;
          --point-y: 0;
          --point-color: var(--blue);
          --hover-target-size: 24px;

          display: block;
          position: absolute;
          left: calc(var(--cs-x0) * 1px + var(--point-x) * 1px);
          top: calc(var(--cs-y0) * 1px - var(--point-y) * 1px);
          z-index: 3;
        }

        #marker {
          width: calc(var(--cc-point-radius) * 2);
          height: calc(var(--cc-point-radius) * 2);
          border-radius: 50%;
          background: var(--point-color);
          border: 2px solid var(--bg);
          transform: translate(-50%, -50%);
          pointer-events: none;
        }

        #hover-target {
          position: absolute;
          left: 0;
          top: 0;
          width: var(--hover-target-size);
          height: var(--hover-target-size);
          transform: translate(-50%, -50%);
          border-radius: 50%;
          cursor: pointer;
        }

        #hover-target:hover {
          background: var(--bg-hover);
        }

        #tooltip {
          display: none;
          position: absolute;
          left: 0;
          top: calc(-1 * var(--cc-point-radius) - 8px);
          transform: translate(-50%, -100%);
        }

        #hover-target:hover ~ #tooltip {
          display: block;
        }

        #label {
          display: none;
          position: absolute;
          left: 0;
          top: calc(var(--cc-point-radius) + 8px);
          transform: translateX(-50%);
        }

        :host([has-label]) #label {
          display: block;
        }
      `,
    ];

    static $html: Option<HTMLTemplateElement> = html`
      <div id="hover-target"></div>
      <div id="marker"></div>
      <div id="tooltip" class="cc-label"></div>
      <div id="label" class="cc-label"></div>
    `;
  }

  export namespace CCPoint {
    export interface Props {
      point: Point;
      label?: Option<string>;
    }
  }
}
