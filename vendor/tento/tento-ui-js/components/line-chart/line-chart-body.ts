import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { $$ } from "../../fastdom";
import { client } from "../../gesture-manager";
import { Point } from "@tento-core/point";
import { NumRangeLike } from "@tento-core/range";
import { Tracing } from "@tento-core/tracing";
import { LonaCanvasContext } from "../../ui/extended-canvas-context";
import { GraphData } from "@tento-core/chart/graph-data";
import { iterateSparseRange } from "@tento-core/sparse-array";
import { ChartViewModel } from "./chart-view-model";
import { LineChartLegend } from "./line-chart-legend";

@component({
  name: "std-line-chart-body",
})
export class LineChartBody extends LonaWebComponent {
  private $canvas: HTMLCanvasElement = this.$<HTMLCanvasElement>("canvas");
  private ctx = new LonaCanvasContext(this.$canvas);

  private isMouseTracking = false;
  private hoveredPoint: Option<{
    point: Point;
    canvas: Point;
  }> = null;
  private readonly HOVER_EPSILON = 5; // Pixels

  private chartId: string =
    `chart-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  private props: Option<LineChartBody.Props>;

  constructor() {
    super();
    this.onpointerenter = () => {
      this.isMouseTracking = true;
    };
    this.onpointermove = (e) => {
      if (!this.isMouseTracking) return;
      this.updateCrosshairs(client(e));
    };
    this.onpointerleave = () => {
      this.isMouseTracking = false;
      if (!this.props) return;
      this.props.vm.pointer.clearPointer(this.chartId);
    };
  }

  private updateCrosshairs(client: Point): void {
    if (!this.props) return;

    const defaultPoints = this.props.vm.graphData.defaultData;
    if (!defaultPoints) return;

    client.x -= 1;

    const rect = this.getBoundingClientRect();
    const x = client.x - rect.left;
    const y = client.y - rect.top; // y-range.min ... y-range.max

    // Calculate data value using inverse of chart rendering formula
    const dataY = defaultPoints.yScaler.c2d(
      y as ChartViewModel.CanvasValue,
      this.ctx.domSize.height,
      this.props.yPadding,
    );

    const xPercent = x / rect.width;
    const range = this.props.xRange;
    const dataX = range.start + xPercent * (range.end - range.start);

    // Find the nearest point
    const hoveredPoint = this.findNearestPoint(x, y);

    // Report to pointer store instead of updating local crosshairs
    this.props.vm.pointer.updatePointer({
      chartId: this.chartId,
      global: client,
      data: {
        x: dataX,
        y: dataY,
      },
      chartBounds: rect,
      hovered: hoveredPoint,
      xDisplay: this.props.vm.xDisplay,
    });
  }

  private findNearestPoint(
    mouseX: number,
    mouseY: number,
  ): Option<{ point: Point; canvas: Point }> {
    if (!this.props) return null;

    const defaultPoints = this.props.vm.graphData.defaultData;
    if (!defaultPoints) return;

    const { width, height } = this.ctx.domSize;
    const xScale = width / (this.props.xRange.end - this.props.xRange.start);

    // When axes are swapped, data y-values map to horizontal (width)
    // When normal, data y-values map to vertical (height)
    const yAxisDimension = this.ctx.swapAxes
      ? this.ctx.domSize.width
      : this.ctx.domSize.height;

    let nearestPoint: Option<{ point: Point; canvas: Point }> = null;
    let minDistance = this.HOVER_EPSILON;

    for (const [time, value] of iterateSparseRange<number>(
      defaultPoints.data.data,
      this.props.xRange.start,
      this.props.xRange.end,
    )) {
      const canvasX = (time - this.props.xRange.start) * xScale;
      const canvasY =
        height -
        defaultPoints.yScaler.d2c(
          value as ChartViewModel.DataValue,
          yAxisDimension,
          this.props.yPadding,
        );

      const distance = Math.hypot(canvasX - mouseX, canvasY - mouseY);

      if (distance < minDistance) {
        minDistance = distance;
        nearestPoint = {
          point: { x: time, y: value },
          canvas: { x: canvasX, y: canvasY },
        };
      }
    }

    return nearestPoint;
  }

  rebindSize(domSize: Size) {
    this.bindSize(domSize);
  }

  private bindSize(domSize: Size): boolean {
    const oldWidth = this.ctx.domSize.width;
    const oldHeight = this.ctx.domSize.height;
    const sizeChanged =
      oldWidth !== domSize.width || oldHeight !== domSize.height;
    if (!sizeChanged) return false;

    this.ctx.setDomSize(domSize, 3);
    return true;
  }

  bind(props: LineChartBody.Props) {
    // NOTE: we may need to queue to put this on the animation thread
    // $$.assertFlushType("writes");

    this.props = props;

    const vm = props.vm;

    this.$("debug").style.setProperty(
      "display",
      props.options?.renderDebug && !props.vm.swapAxes ? "block" : "none",
    );
    if (props.options?.renderDebug) {
      this.$("debug").textContent =
        `${props.xRange.start} .. ${props.xRange.end}`;
    }

    const domSize = vm.domSize;
    if (!domSize) return;
    this.bindSize(domSize);

    this.queueRender();
  }

  private renderQueued = false;
  private queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    $$.mutate(() => {
      this.render();
      this.renderQueued = false;
    });
  }

  private render() {
    const props = this.props;
    if (!props) return;

    const vm = props.vm;
    const styles = getComputedStyle(this);
    this.ctx.canvasSpace.init(vm.swapAxes);
    this.ctx.clear();
    props.options?.renderCrossHairs &&
      this.ctx.canvasSpace.renderCornerCrosshairs();
    for (const renderer of props.renderer) {
      renderer.render(
        this.ctx,
        props.xRange,
        props.vm.graphData,
        props.vm,
        styles,
        props.options?.seriesWidth,
        props.yPadding,
      );
    }
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        height: 100%;
        width: 100%;
        cursor: crosshair;
      }

      #root {
        position: relative;
        height: 100%;
        width: 100%;
        cursor: crosshair;
        overflow: hidden;
      }

      #root::before {
        content: "";
        inset: 0px;
        border: 1px solid var(--bg-surface-light);
        position: absolute;
        pointer-events: none;
        opacity: 0;
      }

      #canvas {
        height: 100%;
        width: 100%;
        cursor: crosshair;
      }

      #debug {
        position: absolute;
        top: 24px;
        right: 24px;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <div id=root>
      <p id=debug></p>
      <canvas id=canvas></canvas>
      <slot></slot>
    </div>
  `;
}

export namespace LineChartBody {
  export type Props = {
    xRange: NumRangeLike;
    vm: ChartViewModel;
    renderer: LineChartBody.Renderer[];
    yPadding: number;
    options?: Options;
  };

  export type Options = Optional<{
    renderCrossHairs: boolean;
    renderDebug: boolean;
    seriesWidth: number;
  }>;

  export type Legend = LineChartLegend;
  export const Legend = LineChartLegend;

  @component({ name: "std-line-chart-legend-info" })
  export class LegendInfo extends LonaWebComponent {
    static makeWith(color: string, label: string): LegendInfo {
      return LegendInfo.make().bind(color, label);
    }

    bind(color: string, label: string): this {
      this.clearChildren();
      this.$("icon").style.background = color;
      this.$("label").textContent = label;
      return this;
    }

    static $styles: Style.Compat[] = [
      css`
        #root {
          align-items: center;
        }

        #icon {
          height: 12px;
          width: 12px;
          border-radius: 2px;
          margin-right: 6px;
          border: 1px solid var(--divider);
        }
      `,
    ];
    static $html: Option<HTMLTemplateElement> = html`
      <std-row id=root>
        <std-center id=icon></std-center>
        <p class=small id=label></p>
      </std-row>
    `;
  }

  export interface Renderer {
    render(
      ctx: LonaCanvasContext,
      xRange: NumRangeLike,
      data: GraphData.Collection,
      vm: ChartViewModel,
      styles: CSSStyleDeclaration,
      seriesWidth: Option<number>,
      yPadding: number,
    ): void;

    legendInfo(styles: CSSStyleDeclaration): HTMLElement | HTMLElement[];
  }

  export namespace Renderer {
    /**
     * Helper function to canonicalize an offset value based on type.
     * For "pct" type, multiplies the offset by the y-axis range.
     * For "abs" type, returns the offset as-is.
     */
    function canonicalizeOffset(
      offset: number,
      type: "pct" | "abs",
      yConfig: ChartViewModel.YConfig,
    ): ChartViewModel.DataValue {
      if (type === "pct") {
        const range = yConfig.range.max - yConfig.range.min;
        return (offset * range) as ChartViewModel.DataValue;
      }
      return offset as ChartViewModel.DataValue;
    }

    function resolveColor(
      styles: CSSStyleDeclaration,
      color: string,
      defaultColor: string,
    ) {
      return color.startsWith("var(")
        ? styles.getPropertyValue(color.slice(4, -1)) || defaultColor
        : color;
    }

    export class Points implements Renderer {
      constructor(
        readonly key: string = "default",
        readonly radius: number = 2,
        readonly color: string = "#ddd",
      ) {}

      render(
        ctx: LonaCanvasContext,
        xRange: NumRangeLike,
        data: GraphData.Collection,
        _vm: ChartViewModel,
        _styles: CSSStyleDeclaration,
        _seriesWidth: Option<number>,
        yPadding: number,
      ) {
        const dd = data.get(this.key);
        if (!dd) return;

        ctx.canvasSpace.renderPoints(
          xRange,
          dd.data.data,
          dd.yScaler,
          ctx.canvasSize,
          yPadding,
          {
            pointColor: this.color,
            pointRadius: this.radius,
          },
        );
      }

      legendInfo(): HTMLElement {
        return LegendInfo.makeWith(this.color, "Points");
      }
    }

    export class Buckets implements Renderer {
      constructor(
        readonly key: string,
        readonly barColor: string = "var(--blue)",
      ) {}

      render(
        ctx: LonaCanvasContext,
        xRange: NumRangeLike,
        data: GraphData.Collection,
        _vm: ChartViewModel,
        styles: CSSStyleDeclaration,
        seriesWidth: Option<number>,
        yPadding: number,
      ) {
        const row = data.get(this.key);
        if (!row) return;

        const yScaler = row.yScaler;
        const c = ctx.c;
        const { width } = ctx.canvasSize;
        const rangeWidth = xRange.end - xRange.start;

        // When axes are swapped, data y-values map to horizontal (width)
        // When normal, data y-values map to vertical (height)
        const yAxisDimension = ctx.swapAxes
          ? ctx.domSize.width
          : ctx.domSize.height;

        const MAX_BUCKETS = 48;
        const effectiveWidth = seriesWidth ?? width;
        const bucketWidth = effectiveWidth / MAX_BUCKETS;
        const bucketRange = rangeWidth / MAX_BUCKETS;

        c.fillStyle = resolveColor(styles, this.barColor, "#2563eb");

        const zeroY =
          yScaler.d2c(0 as ChartViewModel.DataValue, yAxisDimension, yPadding) *
          ctx.scale;

        let currentBucketIndex = 0;
        let numerator = 0;
        let denominator = 0;

        const renderBucket = (bucketIndex: number) => {
          if (denominator === 0) return;

          const fraction = numerator / denominator;
          const barHeight =
            yScaler.d2c(
              fraction as ChartViewModel.DataValue,
              yAxisDimension,
              yPadding,
            ) *
              ctx.scale -
            zeroY;
          const bucketStart = xRange.start + bucketIndex * bucketRange;
          const barX = (bucketStart - xRange.start) * (width / rangeWidth);
          const barY = zeroY;
          const scaledWidth = Math.max(bucketWidth * ctx.scale - 2, 1);

          Tracing.dev("dbg/data", effectiveWidth, scaledWidth, 8 * ctx.scale);
          ctx.drawRoundedRect(
            barX,
            barY,
            scaledWidth,
            barHeight,
            Math.min(8 * ctx.scale, scaledWidth / 2),
          );
          ctx.c.fill();
        };

        for (const [x, value] of iterateSparseRange(
          row.data.data,
          xRange.start,
          xRange.end,
        )) {
          const bucketIndex = Math.floor((x - xRange.start) / bucketRange);
          if (bucketIndex !== currentBucketIndex) {
            renderBucket(currentBucketIndex);
            currentBucketIndex = bucketIndex;
            numerator = 0;
            denominator = 0;
          }
          if (value > 0) numerator++;
          denominator++;
        }
        renderBucket(currentBucketIndex);
      }

      legendInfo(styles: CSSStyleDeclaration): HTMLElement {
        return LegendInfo.makeWith(
          resolveColor(styles, this.barColor, "#2563eb"),
          "Buckets",
        );
      }
    }

    export class HRule implements Renderer {
      constructor(
        readonly offsetFromCenter: number = 0,
        readonly type: "pct" | "abs" = "pct",
      ) {}

      render(
        ctx: LonaCanvasContext,
        _xRange: NumRangeLike,
        data: GraphData.Collection,
        _vm: ChartViewModel,
        styles: CSSStyleDeclaration,
        _seriesWidth: Option<number>,
        yPadding: number,
      ) {
        const yScaler = data.defaultYScaler;
        const canonicalOffset = canonicalizeOffset(
          this.offsetFromCenter,
          this.type,
          yScaler.yConfig,
        );

        // When axes are swapped, data y-values map to horizontal (width)
        // When normal, data y-values map to vertical (height)
        const yAxisDimension = ctx.swapAxes
          ? ctx.domSize.width
          : ctx.domSize.height;

        const topRuleY = yScaler.yConfig.range.center + canonicalOffset;
        ctx.canvasSpace.hr(
          yScaler.d2c(
            topRuleY as ChartViewModel.DataValue,
            yAxisDimension,
            yPadding,
          ) * ctx.scale,
          1,
          resolveColor(styles, "var(--divider)", "#ddd"),
          ctx.canvasSize.width,
        );
      }

      legendInfo(styles: CSSStyleDeclaration): HTMLElement {
        return LegendInfo.makeWith(
          resolveColor(styles, "var(--divider)", "#ddd"),
          "HRule",
        );
      }
    }

    export class HRuleAll implements Renderer {
      constructor(
        readonly offsetFromCenter: number,
        readonly type: "pct" | "abs" = "pct",
        readonly center: Option<number> = null,
        readonly color: string = "var(--divider)",
      ) {}

      render(
        ctx: LonaCanvasContext,
        _xRange: NumRangeLike,
        data: GraphData.Collection,
        _vm: ChartViewModel,
        styles: CSSStyleDeclaration,
        _seriesWidth: Option<number>,
        yPadding: number,
      ) {
        const yScaler = data.defaultYScaler;
        const yConfig = yScaler.yConfig;

        const width = ctx.canvasSize.width;

        // When axes are swapped, data y-values map to horizontal (width)
        // When normal, data y-values map to vertical (height)
        const yAxisDimension = ctx.swapAxes
          ? ctx.domSize.width
          : ctx.domSize.height;

        const rcolor = resolveColor(styles, this.color, "#ddd");
        const canonicalOffset = canonicalizeOffset(
          this.offsetFromCenter,
          this.type,
          yConfig,
        );

        const center = this.center ?? yConfig.range.center;

        const topRuleY = center + canonicalOffset;
        const centerRuleY = center;
        const bottomRuleY = center - canonicalOffset;

        ctx.canvasSpace.hr(
          yScaler.d2c(
            topRuleY as ChartViewModel.DataValue,
            yAxisDimension,
            yPadding,
          ) * ctx.scale,
          1,
          rcolor,
          width,
        );
        ctx.canvasSpace.hr(
          yScaler.d2c(
            centerRuleY as ChartViewModel.DataValue,
            yAxisDimension,
            yPadding,
          ) * ctx.scale,
          1,
          rcolor,
          width,
        );
        ctx.canvasSpace.hr(
          yScaler.d2c(
            bottomRuleY as ChartViewModel.DataValue,
            yAxisDimension,
            yPadding,
          ) * ctx.scale,
          1,
          rcolor,
          width,
        );
      }

      legendInfo(styles: CSSStyleDeclaration): HTMLElement {
        const rcolor = resolveColor(styles, this.color, "#ddd");
        return LegendInfo.makeWith(rcolor, "HRule All");
      }
    }

    export class RegressionPoints implements Renderer {
      constructor(
        readonly key: string = "default",
        readonly color: string = "rgb(255, 0, 0)",
      ) {}

      render(
        ctx: LonaCanvasContext,
        xRange: NumRangeLike,
        data: GraphData.Collection,
        _vm: ChartViewModel,
        styles: CSSStyleDeclaration,
        _seriesWidth: Option<number>,
        yPadding: number,
      ) {
        const regression = data.getRegression(this.key);
        if (!regression) return;

        ctx.canvasSpace.renderPoints(
          xRange,
          regression.conv.data,
          regression.yScaler,
          ctx.canvasSize,
          yPadding,
          {
            pointColor: resolveColor(styles, this.color, "rgb(255, 0, 0)"),
            pointRadius: 2,
          },
        );
      }

      legendInfo(styles: CSSStyleDeclaration): HTMLElement {
        return LegendInfo.makeWith(
          resolveColor(styles, this.color, "rgb(255, 0, 0)"),
          "Regression Points",
        );
      }
    }

    export class RegressionFill implements Renderer {
      constructor(
        readonly key: string = "default",
        readonly offsetFromCenter: number,
        readonly type: "pct" | "abs" = "pct",
        readonly center: Option<number> = null,
        readonly topColor: string = "rgba(239, 68, 68, 0.3)",
        readonly bottomColor: string = "rgba(59, 130, 246, 0.3)",
      ) {}

      render(
        ctx: LonaCanvasContext,
        xRange: NumRangeLike,
        data: GraphData.Collection,
        _vm: ChartViewModel,
        _styles: CSSStyleDeclaration,
        _seriesWidth: Option<number>,
        yPadding: number,
      ) {
        const regression = data.getRegression(this.key);
        if (!regression) return;

        const canonicalOffset = canonicalizeOffset(
          this.offsetFromCenter,
          this.type,
          regression.yScaler.yConfig,
        );

        const center = this.center ?? regression.yScaler.yConfig.range.center;
        const topRule = center + canonicalOffset;
        const bottomRule = center - canonicalOffset;

        // Fill area below top rule (red zone)
        ctx.canvasSpace.fillAreaToHorizontalRule(
          xRange,
          regression.conv.data,
          regression.yScaler,
          topRule as ChartViewModel.DataValue,
          this.topColor,
          "below",
          ctx.canvasSize,
          yPadding,
        );

        // Fill area above bottom rule (blue zone)
        ctx.canvasSpace.fillAreaToHorizontalRule(
          xRange,
          regression.conv.data,
          regression.yScaler,
          bottomRule as ChartViewModel.DataValue,
          this.bottomColor,
          "above",
          ctx.canvasSize,
          yPadding,
        );
      }

      legendInfo(): HTMLElement[] {
        return [
          LegendInfo.makeWith(this.topColor, "Regression Fill (Top)"),
          LegendInfo.makeWith(this.bottomColor, "Regression Fill (Bottom)"),
        ];
      }
    }

    export class RegressionBand implements Renderer {
      constructor(
        readonly key: string = "default",
        readonly color: string = "rgba(245, 158, 11, 0.1)",
      ) {}

      render(
        ctx: LonaCanvasContext,
        xRange: NumRangeLike,
        data: GraphData.Collection,
        _vm: ChartViewModel,
        _styles: CSSStyleDeclaration,
        _seriesWidth: Option<number>,
        yPadding: number,
      ) {
        const regression = data.getRegression(this.key);
        if (!regression) return;

        ctx.canvasSpace.renderConfidenceBand(
          xRange,
          regression.conv,
          regression.yScaler,
          yPadding,
          {
            renderBand: true,
            renderConfidencePoints: false,
            renderBoundaryPoints: false,
            bandColor: this.color,
          },
        );
      }

      legendInfo(): HTMLElement {
        return LegendInfo.makeWith(this.color, "Regression Band");
      }
    }

    export class RegressionCurve implements Renderer {
      constructor(
        readonly key: string = "default",
        readonly color: string = "#666",
      ) {}

      render(
        ctx: LonaCanvasContext,
        xRange: NumRangeLike,
        data: GraphData.Collection,
        _vm: ChartViewModel,
        styles: CSSStyleDeclaration,
        _seriesWidth: Option<number>,
        yPadding: number,
      ) {
        const regression = data.getRegression(this.key);
        if (!regression) return;

        const rpoints = ctx.canvasSpace.collectRegressionPoints(
          regression.conv,
          xRange,
        );

        ctx.canvasSpace.drawRegressionCurve(
          xRange,
          regression.yScaler,
          rpoints,
          yPadding,
          {
            curveColor: this.color.startsWith("--")
              ? styles.getPropertyValue(this.color)
              : this.color,
            curveWidth: 2,
          },
        );
      }

      legendInfo(): HTMLElement {
        return LegendInfo.makeWith(this.color, "Regression Curve");
      }
    }

    export class BarChartWithWidth implements Renderer {
      constructor(
        readonly rowKey: string,
        readonly barColor: string = "var(--blue)",
      ) {}

      render(
        ctx: LonaCanvasContext,
        xRange: NumRangeLike,
        data: GraphData.Collection,
        _vm: ChartViewModel,
        styles: CSSStyleDeclaration,
        _seriesWidth: Option<number>,
        yPadding: number,
      ) {
        const row = data.get<[number /* y-height */, number /* width */]>(
          this.rowKey,
        );
        if (!row) return;

        const yScaler = row.yScaler;
        const c = ctx.c;
        const { width } = ctx.canvasSize;
        const rangeWidth = xRange.end - xRange.start;
        const xScale = width / rangeWidth;

        // When axes are swapped, data y-values map to horizontal (width)
        // When normal, data y-values map to vertical (height)
        const yAxisDimension = ctx.swapAxes
          ? ctx.domSize.width
          : ctx.domSize.height;

        // Get the y position of the zero line
        const zeroY =
          yScaler.d2c(0 as ChartViewModel.DataValue, yAxisDimension, yPadding) *
          ctx.scale;

        // Set bar color with opacity
        const color = this.barColor.startsWith("var(")
          ? styles.getPropertyValue(this.barColor.slice(4, -1)) || "#2563eb"
          : this.barColor;
        c.fillStyle = color;

        // Draw each bar
        row.data.data.iter(xRange, ([x, [yHeight, barWidth]]) => {
          if (barWidth === 0 || yHeight === 0) return;

          // Calculate bar position and dimensions
          const barX = (x - xRange.start) * xScale;
          const barY =
            yScaler.d2c(
              yHeight as ChartViewModel.DataValue,
              yAxisDimension,
              yPadding,
            ) * ctx.scale;

          // Calculate bar dimensions
          const scaledBarWidth = Math.ceil(barWidth * xScale + 1);
          const barHeight = Math.abs(barY - zeroY);

          // Draw the bar from zero line to the height
          c.fillRect(
            barX, // Start the bar at the x position
            Math.min(barY, zeroY), // Top of the bar (handle negative values)
            Math.max(scaledBarWidth, 4),
            barHeight,
          );
        });
      }

      legendInfo(): HTMLElement {
        return LegendInfo.makeWith(this.barColor, "Bar Chart");
      }
    }

    export const DEFAULT: Renderer[] = [
      new LineChartBody.Renderer.Points(),
      new LineChartBody.Renderer.HRuleAll(0.1),
      new LineChartBody.Renderer.RegressionFill("default", 0.1),
      new LineChartBody.Renderer.RegressionBand(),
      new LineChartBody.Renderer.RegressionCurve(),
    ];
  }
}
