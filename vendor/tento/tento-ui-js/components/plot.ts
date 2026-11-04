import { nonnull } from "@tento-core/assert";
import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { Style, css } from "../component-styles";
import { $$, mutate } from "../fastdom";
import { client, offset } from "../gesture-manager";
import { LazySync } from "../lazy";
import { Point } from "@tento-core/point";
import { NumRangeLike } from "@tento-core/range";
import {
  DataFactory,
  LonaCanvasContext,
  Rect,
} from "../ui/extended-canvas-context";

@component({
  name: "std-plot",
})
export class Plot extends LonaWebComponent {
  static dataRange: NumRangeLike = {
    start: -100,
    end: 500,
  };

  private $canvas: HTMLCanvasElement = this.$<HTMLCanvasElement>("canvas");
  private ctx = new LonaCanvasContext(this.$canvas);
  #resizeQueued: boolean = false;
  onSizeChange = (s: Size) => {
    this.#contentSize = s;
    if (this.#resizeQueued) return;
    this.#resizeQueued = true;
    const lifetime = this.lifetime;
    $$.mutate(() => {
      if (lifetime !== this.lifetime) return;
      this.#resize();
      this.#resizeQueued = false;
    });
  };

  // config
  private baseColor = "#dbacff";
  private hoverColor = "#c581f8";
  private data: Option<DataFactory>;
  private yRange: NumRangeLike = Plot.dataRange;
  private tooltipsProvider: Option<(idx: number) => PlotTooltip.Props>;

  // state
  private barChartElements: {
    index: number;
    r: Rect;
  }[] = [];
  private static tooltipOwner: Option<Plot>;
  private lifetime = 0;
  private pendingTooltipTimeout: Option<ReturnType<typeof setTimeout>>;
  private lastIntersected: Option<{
    index: number;
    r: Rect;
  }>;

  constructor() {
    super();
    this.onpointermove = this.#onPointerMove.bind(this);
    this.$canvas.onpointerleave = this.#onPointerLeave.bind(this);
  }

  #onPointerMove(e: PointerEvent) {
    const tooltipProvider = this.tooltipsProvider;
    if (!tooltipProvider) return;

    const rangeHeight = this.yRange.end - this.yRange.start;
    const heightRatio = rangeHeight / this.ctx.domSize.height;

    const p = offset(e);

    // in the range of [this.yRange.start...this.yRange.end]
    const normalizedY = this.yRange.end - p.y * heightRatio;

    const canvasRelativeY =
      ((this.yRange.end - normalizedY) / heightRatio) * this.ctx.scale;

    p.y = canvasRelativeY;
    let intersected: Option<{
      index: number;
      r: Rect;
    }>;
    for (const e of this.barChartElements) {
      if (this.intersectsRect(e.r, p)) {
        intersected = e;
        break;
      }
    }

    let $tooltip = PlotTooltip.instance.maybeGet();
    if (Plot.tooltipOwner === this) $tooltip?.setPosition(client(e));

    /**
     * 1) Nothing is hovered
     */
    if (!this.lastIntersected && !intersected) return;

    /**
     * 2) Same thing is hovered
     */
    if (this.lastIntersected?.index === intersected?.index) return;

    /**
     * 3) Something different is hovered
     */
    if (this.lastIntersected) {
      this.drawRect(this.lastIntersected.r);
      this.ctx.renderFill(this.baseColor);
    }

    if (intersected) {
      const $tooltip = PlotTooltip.instance.get();
      Plot.tooltipOwner = this;
      $tooltip.toggleAttribute("shown", true);
      $tooltip.bind(tooltipProvider(intersected.index));
      $tooltip.setPosition(client(e));

      this.pendingTooltipTimeout && clearTimeout(this.pendingTooltipTimeout);
      this.pendingTooltipTimeout = null;

      this.drawRect(intersected.r);
      this.ctx.renderFill(this.hoverColor);
      this.lastIntersected = intersected;
    } else {
      this.lastIntersected = null;
      this.dismissTooltip();
    }
  }

  #onPointerLeave() {
    const $tooltip = PlotTooltip.instance.maybeGet();
    if (Plot.tooltipOwner === this) {
      $tooltip?.toggleAttribute("shown", false);
      Plot.tooltipOwner = null;
    }
    this.pendingTooltipTimeout && clearTimeout(this.pendingTooltipTimeout);
    this.pendingTooltipTimeout = null;
    if (this.lastIntersected) {
      this.drawRect(this.lastIntersected.r);
      this.ctx.renderFill(this.baseColor);
    }
    this.lastIntersected = null;
  }

  #contentSize: Option<Size>;

  #resize() {
    if (!this.#contentSize) return;
    this.ctx.setDomSize(this.#contentSize);
    this.buildPoints();
    this.render();
  }

  dismissTooltip() {
    const $tooltip = PlotTooltip.instance.maybeGet();
    if (Plot.tooltipOwner !== this || !$tooltip?.hasAttribute("shown") || this.pendingTooltipTimeout) {
      return;
    }
    this.pendingTooltipTimeout = setTimeout(() => {
      if (Plot.tooltipOwner === this) {
        $tooltip.toggleAttribute("shown", false);
        Plot.tooltipOwner = null;
      }
      this.pendingTooltipTimeout = null;
    }, 300);
  }

  intersectsRect(r: Rect, p: Point): boolean {
    const isWithinY = p.y >= r.y && p.y <= r.y + r.height;
    const isWithinX = p.x >= r.x && p.x <= r.x + r.width;
    return isWithinX && isWithinY;
  }

  static visitGridOffsets(
    yRange: NumRangeLike,
    canvasHeight: number,
    visitGridOffsets: (canvasOffset: number, offset: number) => void,
  ) {
    const yHeight = yRange.end - yRange.start;
    const gridHeight = yHeight / 4;
    if (!Number.isFinite(yRange.start) || !Number.isFinite(yRange.end) ||
      !Number.isFinite(yHeight) || gridHeight <= 0 ||
      yRange.start + gridHeight === yRange.start || yRange.end - gridHeight === yRange.end ||
      !Number.isFinite(canvasHeight) || canvasHeight < 0) {
      throw new RangeError("Plot requires finite increasing, representable y bounds and a nonnegative finite canvas height");
    }
    // Keep the zero-aligned axes, but enumerate only the visible span. Four
    // intervals have at most five distinct ticks, independent of endpoint magnitude.
    const first = Math.ceil(yRange.start / gridHeight) * gridHeight;
    let previous = -Infinity;
    for (let index = 0; index <= 4; index++) {
      const value = first + index * gridHeight;
      if (value < yRange.start || value > yRange.end || value <= previous) continue;
      visitGridOffsets(canvasHeight * (1 - (value - yRange.start) / yHeight), value);
      previous = value;
    }
  }

  @mutate
  private render() {
    const ctx = this.ctx;
    const yRange = nonnull(this.yRange);

    ctx.background();
    ctx.c.clearRect(0, 0, this.ctx.size.width, this.ctx.size.height);

    Plot.visitGridOffsets(yRange, ctx.size.height, (offset) => {
      ctx.pathHorizontalLine(offset);
      ctx.renderStroke(2, "#dadce0");
    });

    // ctx.pathCellBoundaries();
    // ctx.renderStroke(1, "blue");

    // ctx.pathHorizontalLine(ctx.size.height);
    // ctx.renderStroke(4, "#dadce0");

    // ctx.pathBestFitLine(cellWidth, points);
    // ctx.renderStroke(2, "red");

    // ctx.pathSmoothBestFitLine(cellWidth, points);
    // ctx.renderStroke(4, "#9a9cff");

    for (const r of this.barChartElements) {
      this.drawRect(r.r);
      if (r.index === this.lastIntersected?.index) {
        ctx.renderFill(this.hoverColor);
      } else {
        ctx.renderFill(this.baseColor);
      }
    }

    // ctx.pathScatterPlot(cellWidth, points, () => ctx.renderFill("black"));
  }

  private drawRect(r: Rect) {
    this.ctx.drawRoundedRect(
      r.x * this.ctx.scale,
      r.y,
      r.width * this.ctx.scale,
      Math.min(this.ctx.size.height, r.height),
      8,
    );
  }

  /*
   Bind
   =============================================================================
  */

  bind({ f, yRange, tooltipsProvider }: Plot.Props) {
    const range = yRange ?? Plot.dataRange;
    Plot.visitGridOffsets(range, 0, () => {});
    this.retireTooltip();
    this.data = f;
    this.yRange = { start: range.start, end: range.end };
    this.tooltipsProvider = tooltipsProvider;
    this.buildPoints();
    this.#resize();
  }

  buildPoints() {
    if (!this.data || !this.yRange || this.ctx.domSize.height === 0) {
      this.barChartElements = [];
      return;
    }
    const numElements = this.data.r.end - this.data.r.start;
    this.barChartElements = this.ctx.barChart(
      this.data!,
      () => {
        return this.ctx.domSize.width / numElements;
      },
      {
        paddingHorizontalPx: 8,
        yRange: this.yRange!,
      },
    );
  }

  private retireTooltip(): void {
    if (this.pendingTooltipTimeout != null) clearTimeout(this.pendingTooltipTimeout);
    this.pendingTooltipTimeout = null;
    if (Plot.tooltipOwner === this) {
      PlotTooltip.instance.maybeGet()?.toggleAttribute("shown", false);
      Plot.tooltipOwner = null;
    }
    this.lastIntersected = null;
  }

  disconnectedCallback(): void {
    this.lifetime++;
    this.#resizeQueued = false;
    this.retireTooltip();
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.lifetime++;
    this.#resizeQueued = false;
    this.retireTooltip();
    this.data = null;
    this.tooltipsProvider = null;
    this.barChartElements = [];
    this.#contentSize = null;
    super.onRecycle();
  }

  bindHeight(height: number) {
    this.ctx.setDomSize({
      width: this.ctx.domSize.width,
      height,
    });
    if (!this.data || !this.yRange || this.ctx.domSize.width === 0) return;
    this.buildPoints();
    this.render();
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        height: 200px;
      }
    `,
  ];

  static $html = html` <canvas id="canvas"></canvas> `;
}

export namespace Plot {
  export type Props = {
    f: DataFactory;
    /** Finite increasing bounds with a representable quarter-span; invalid
     * ranges synchronously throw RangeError before replacing the binding. */
    yRange?: Option<NumRangeLike>;
    tooltipsProvider: (idx: number) => PlotTooltip.Props;
  };
}

@component({
  name: "std-plot-tooltip",
})
export class PlotTooltip extends LonaWebComponent {
  static instance = new LazySync(() => PlotTooltip.make());
  private cachedSize: Option<Size>;

  setPosition(client: Point) {
    const actual = {
      x: client.x,
      y: client.y,
    };
    if (this.cachedSize) {
      this.setBounds({
        point: actual,
        size: this.cachedSize,
      });
      return;
    }
    $$.measure(() => {
      const rect = this.getBoundingClientRect();
      this.setBounds({
        point: actual,
        size: (this.cachedSize = {
          width: rect.width,
          height: rect.height,
        }),
      });
    });
  }

  private setBounds(bounds: { point: Point; size: Size }) {
    const x = Math.min(
      bounds.point.x,
      window.innerWidth - bounds.size.width - 8,
    );
    const y = Math.max(bounds.point.y - bounds.size.height - 8, 8);
    $$.mutate(() => {
      this.style.transform = `translate(${x}px, ${y}px)`;
    });
  }

  bind(props: PlotTooltip.Props) {
    this.$("label").textContent = props.title;
    this.$("date").textContent = props.date;
    this.$("value").textContent = props.value;
    this.$("change").textContent = props.change;
    $$.measure(() => {
      const rect = this.getBoundingClientRect();
      this.cachedSize = {
        width: rect.width,
        height: rect.height,
      };
      $$.mutate(() => {
        document.body.appendChild(this);
      });
    });
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        position: absolute;
        top: 0px;
        left: 0px;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
      }

      :host([shown]) {
        opacity: 1;
      }

      #tooltip {
        width: 220px;
        padding: 12px;
        background: var(--bg-elevated);
        border-radius: 16px;
        box-shadow: var(--box-shadow);
        pointer-events: none;
        top: 0;
        left: 0;
        font-size: 0.85rem;
      }

      #tooltip::after {
        content: "";
        position: absolute;
        top: 8px;
        left: 8px;
        width: 4px;
        height: calc(100% - 16px);
        border-radius: 2px;
        background-color: var(--light-purple);
        display: none;
      }

      #label {
        --margin-top: 4px;
        --margin-bottom: 8px;
        margin-left: 4px;
      }

      #date {
        --margin-bottom: 12px;
        margin-left: 4px;
        color: var(--text-ter);
      }

      #value-container {
        display: flex;
        align-items: center;
        width: 100%;
        border-radius: 8px;
        background: var(--bg-surface-light);
        padding: 16px 12px;
        height: 24px;
      }

      #change {
        color: var(--text-ter);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="tooltip">
      <h1 class="h5" id="label">Weight</h1>
      <p id="date"></p>
      <std-row id="value-container">
        <std-block style="flex-grow:1;">
          <p id="value"></p>
        </std-block>
        <std-block>
          <p id="change"></p>
        </std-block>
      </std-row>
    </div>
  `;
}

export namespace PlotTooltip {
  export type Props = {
    title: string;
    date: string;
    value: string;
    change: string;
  };
}
