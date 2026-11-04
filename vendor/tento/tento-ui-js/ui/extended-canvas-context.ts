import { nonnull } from "@tento-core/assert";
import { ChartViewModel } from "../components/line-chart/chart-view-model";
import type { RegressionData } from "@tento-core/chart/graph-data";
import { SparseArray } from "@tento-core/sparse-array";
import { MathUtils } from "@tento-core/math";
import { Point } from "@tento-core/point";
import { NumRangeLike } from "@tento-core/range";

export type PointsProvider = (index: number) => Point;
export type WidthsProvider = (index: number) => number;
export type DataFactory = {
  r: NumRangeLike;
  data: PointsProvider;
};
export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AbstractCanvasContext = CanvasCompositing &
  CanvasDrawImage &
  CanvasDrawPath &
  CanvasFillStrokeStyles &
  CanvasFilters &
  CanvasImageData &
  CanvasImageSmoothing &
  CanvasPath &
  CanvasPathDrawingStyles &
  CanvasRect &
  CanvasShadowStyles &
  CanvasState &
  CanvasText &
  CanvasTextDrawingStyles &
  CanvasTransform;

export namespace CanvasContext {
  /**
   * Creates a rounded rectangle path on the canvas context.
   * Clamps the corner radius to half of width or height and ensures non-negative radius.
   *
   * @param c - The canvas context to draw on.
   * @param x - The x-coordinate of the rectangle.
   * @param y - The y-coordinate of the rectangle.
   * @param w - The width of the rectangle.
   * @param h - The height of the rectangle.
   * @param r - The corner radius.
   * @returns The canvas context for chaining.
   */
  export function roundedRect<C extends AbstractCanvasContext>(
    c: C,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): C {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    if (r < 0) {
      r = 0;
    }

    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
    return c;
  }
}

export class LonaCanvasContext {
  readonly c: CanvasRenderingContext2D;

  domSize: Size = { width: 0, height: 0 };
  size: Size = { width: 0, height: 0 };
  scale: number = 4;
  canvasSize: Size = { width: 0, height: 0 };
  swapAxes: boolean = false;

  constructor(private readonly $canvas: HTMLCanvasElement) {
    this.c = nonnull($canvas.getContext("2d"));
  }

  setDomSize(size: Size, scale: number = 4) {
    if (
      this.domSize.width === size.width &&
      this.domSize.height === size.height &&
      this.scale === scale
    ) {
      return;
    }
    this.domSize = size;
    this.size = { width: size.width * scale, height: size.height * scale };
    this.scale = scale;
    this.updateCanvasDimension();
  }

  private updateCanvasDimension() {
    // Note: Setting canvas.width or canvas.height clears the canvas content
    this.$canvas.width = this.size.width;
    this.$canvas.height = this.size.height;

    this.$canvas.style.width = this.domSize.width + "px";
    this.$canvas.style.height = this.domSize.height + "px";
  }

  clear() {
    this.c.clearRect(0, 0, this.canvasSize.width, this.canvasSize.height);
  }

  background(bg: string = "#f8f8f8") {
    this.c.fillStyle = bg;
    this.c.fillRect(0, 0, this.canvasSize.width, this.canvasSize.height);
  }

  drawRoundedRect(x: number, y: number, w: number, h: number, r: number) {
    CanvasContext.roundedRect(this.c, x, y, w, h, r);
  }

  static buildBarChart(
    data: DataFactory,
    widthProvider: WidthsProvider,
    config: {
      paddingHorizontalPx: number;
      yRange: NumRangeLike;
      canvasHeight: number;
      scale: number;
    },
  ): {
    index: number;
    r: Rect;
  }[] {
    const r: {
      index: number;
      r: Rect;
    }[] = [];
    const yHeight = config.yRange.end - config.yRange.start;
    const heightScale = config.canvasHeight / yHeight;
    const heightOffset = -config.yRange.start * heightScale;
    const hpadding = config.paddingHorizontalPx / config.scale;

    let offsetXSoFar = 0;
    for (let i = data.r.start; i < data.r.end; ++i) {
      const p = data.data(i);
      const y = MathUtils.clampInc(p.y, config.yRange.start, config.yRange.end);
      const scaledHeight = (y - config.yRange.start) * heightScale;
      const width = widthProvider(i);
      r.push({
        index: i,
        r: {
          x: offsetXSoFar + hpadding,
          y:
            scaledHeight > heightOffset
              ? config.canvasHeight - scaledHeight
              : heightOffset,
          width: Math.max(1, width - 2 * hpadding),
          height: Math.abs(scaledHeight - heightOffset),
        },
      });
      offsetXSoFar += width;
    }
    return r;
  }

  barChart(
    data: DataFactory,
    widthProvider: WidthsProvider,
    config: {
      paddingHorizontalPx: number;
      yRange: NumRangeLike;
    },
  ): {
    index: number;
    r: Rect;
  }[] {
    return LonaCanvasContext.buildBarChart(data, widthProvider, {
      paddingHorizontalPx: config.paddingHorizontalPx,
      yRange: config.yRange,
      canvasHeight: this.size.height,
      scale: this.scale,
    });
  }

  pathCellBoundaries() {
    this.drawRoundedRect(2, 2, this.size.width - 4, this.size.height - 4, 20);
  }

  pathHorizontalLine(y: number) {
    this.c.beginPath();
    this.c.lineTo(0, y);
    this.c.lineTo(this.size.width, y);
  }

  pathScatterPlot(xUnitWidth: number, data: Option<Point>[], fn: () => void) {
    const resolution = 2;
    const heightPerYUnit = 0.25;
    const marginBottom = 8;
    for (const p of data) {
      if (!p) continue;
      const { x, y } = p;
      this.c.beginPath();
      this.c.ellipse(
        (x + 0.5) * xUnitWidth * resolution,
        this.size.height - (y * heightPerYUnit + marginBottom),
        4,
        4,
        2 * Math.PI,
        0,
        2 * Math.PI,
      );
      fn();
    }
  }

  pathBestFitLine(xUnitWidth: number, data: Point[]) {
    const resolution = 2;
    const heightPerYUnit = 0.25;
    const marginBottom = 8;
    this.c.beginPath();
    for (const { x, y } of data) {
      this.c.lineTo(
        (x + 0.5) * xUnitWidth * resolution,
        this.size.height - (y * heightPerYUnit + marginBottom),
      );
    }
  }

  renderStroke(width: number, style: string) {
    this.c.lineWidth = width;
    this.c.strokeStyle = style;
    this.c.stroke();
  }

  renderFill(style: string) {
    this.c.fillStyle = style;
    this.c.fill();
  }

  canvasSpace = ((self) => ({
    init: (swapAxes: boolean): { canvasSize: Size } => {
      self.swapAxes = swapAxes;
      if (swapAxes) {
        self.canvasSize = self.canvasSpace.toCanvasSpaceRotated().canvasSize;
      } else {
        self.canvasSize = self.canvasSpace.toCanvasSpace().canvasSize;
      }
      return {
        canvasSize: self.canvasSize,
      };
    },
    toCanvasSpace(): { canvasSize: Size } {
      self.c.setTransform(1, 0, 0, -1, 0, self.size.height);
      return {
        canvasSize: self.size,
      };
    },
    toScreenSpace() {
      self.c.setTransform(1, 0, 0, 1, 0, 0);
    },
    /**
     * Transform coordinate system so that top-left is origin and data axes swapped:
     * data.x axis goes downward and data.y axis goes rightward.
     */
    toCanvasSpaceRotated(): { canvasSize: Size } {
      self.c.setTransform(0, 1, 1, 0, 0, 0);
      return {
        canvasSize: {
          width: self.size.height,
          height: self.size.width,
        },
      };
    },
    fillText: (text: string, x: number, y: number) => {
      const savedTransform = self.c.getTransform();
      self.c.setTransform(1, 0, 0, 1, 0, 0);
      self.c.fillText(text, x * this.scale, self.size.height - y * this.scale);
      self.c.setTransform(savedTransform);
    },
    renderDebugCorners() {
      self.c.font = `${24 * self.scale}px sans-serif`;
      self.c.fillStyle = "black";

      const textAlign = self.c.textAlign;
      const textBaseLine = self.c.textBaseline;
      const { height, width } = self.domSize;

      // Bottom Left (0, 0)
      self.c.textAlign = "left";
      self.c.textBaseline = "bottom";
      this.fillText("BL", 0, 0);

      // Top Left (0, canvas.height)
      self.c.textAlign = "left";
      self.c.textBaseline = "top";
      this.fillText("TL", 0, height);

      // Bottom Right (canvas.width, 0)
      self.c.textAlign = "right";
      self.c.textBaseline = "bottom";
      this.fillText("BR", width, 0);

      // Top Right (canvas.width, canvas.height)
      self.c.textAlign = "right";
      self.c.textBaseline = "top";
      this.fillText("TR", width, height);

      self.c.textAlign = textAlign;
      self.c.textBaseline = textBaseLine;
    },
    renderCornerCrosshairs(len = 10, lineWidth = 1, color = "rgba(0,0,0,0.2)") {
      const ctx = self.c;
      const { height, width } = self.canvasSize;
      len = len * self.scale;
      lineWidth = lineWidth * self.scale;
      const pad = 5 * self.scale;
      // const padLong = 10 * self.scale;

      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;

      ctx.beginPath();

      // Bottom-left corner
      ctx.moveTo(pad, len + pad);
      ctx.lineTo(pad, pad);
      ctx.lineTo(len + pad, pad);

      // Top-left corner
      ctx.moveTo(0 + pad, height - len - pad);
      ctx.lineTo(0 + pad, height - pad);
      ctx.lineTo(len + pad, height - pad);

      // Bottom-right corner
      ctx.moveTo(width - len - pad, pad);
      ctx.lineTo(width - pad, pad);
      ctx.lineTo(width - pad, len + pad);

      // Top-right corner
      ctx.moveTo(width - pad, height - len - pad);
      ctx.lineTo(width - pad, height - pad);
      ctx.lineTo(width - len - pad, height - pad);

      ctx.stroke();
    },
    hr(
      y: number,
      lineWidth = 1,
      color = "rgba(0,0,0,0.2)",
      width: number = self.size.width,
    ) {
      const ctx = self.c;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth * self.scale;
      // const ys = y * self.scale;
      const ys = y;

      ctx.beginPath();
      ctx.moveTo(0, ys);
      ctx.lineTo(width, ys);
      ctx.stroke();
    },
    sinWave(
      range: NumRangeLike,
      amplitude = 250,
      frequency = 0.02,
      size: Size = self.size,
    ) {
      const { height, width } = size;

      let globalRangeStart = 0;
      let yOffset = height / 2;
      yOffset = 0;

      // Draw sine wave portion corresponding to [startX, endX]
      self.c.beginPath();
      const step = 1; // pixel step
      for (let i = 0; i <= width; i += step) {
        const t = i / width; // local canvas % position
        const globalX = range.start + t * (range.end - range.start); // actual global X
        const sineY = Math.sin(
          (globalX - globalRangeStart) * frequency * Math.PI * 2,
        ); // continuous function
        const y = sineY * amplitude + height / 2 + yOffset;

        if (i === 0) self.c.moveTo(i, y);
        else self.c.lineTo(i, y);
      }

      self.c.strokeStyle = "black";
      self.c.lineWidth = 2;
      self.c.stroke();
    },
    renderPoints(
      range: NumRangeLike,
      data: SparseArray<number>,
      yScaler: ChartViewModel.YScaler,
      size: Size = self.size,
      yPadding: number = 20,
      options: {
        pointColor?: string;
        pointRadius?: number;
      } = {},
    ) {
      const { pointColor = "#2563eb", pointRadius = 3 } = options;

      const { width } = size;
      const rangeWidth = range.end - range.start;
      const xScale = width / rangeWidth;

      // When axes are swapped, data y-values map to horizontal (width)
      // When normal, data y-values map to vertical (height)
      const yAxisDimension = self.swapAxes
        ? self.domSize.width
        : self.domSize.height;

      self.c.fillStyle = pointColor;
      const scaledRadius = pointRadius * self.scale;
      data.iter(range, ([x, y]) => {
        const canvasX = (x - range.start) * xScale;
        const canvasY =
          yScaler.d2c(y as ChartViewModel.DataValue, yAxisDimension, yPadding) *
          self.scale;

        self.c.beginPath();
        self.c.arc(canvasX, canvasY, scaledRadius, 0, 2 * Math.PI);
        self.c.fill();
      });
    },
    fillAreaToHorizontalRule(
      range: NumRangeLike,
      data: SparseArray<number>,
      yScaler: ChartViewModel.YScaler,
      ruleY: ChartViewModel.DataValue,
      fillStyle = "rgba(37, 99, 235, 0.1)",
      fillDirection: "above" | "below" | "both" = "both",
      size: Size = self.size,
      yPadding: number = 20,
    ) {
      const { width } = size;
      const rangeWidth = range.end - range.start;
      const xScale = width / rangeWidth;

      // When axes are swapped, data y-values map to horizontal (width)
      // When normal, data y-values map to vertical (height)
      const yAxisDimension = self.swapAxes
        ? self.domSize.width
        : self.domSize.height;

      const ruleYCanvas = yScaler.d2c(ruleY, yAxisDimension, yPadding);
      const ruleYScaled = ruleYCanvas * self.scale;

      const createAreaPath = (fillAbove: boolean) => {
        const points: {
          x: number;
          y: number;
          canvasX: number;
          canvasY: number;
        }[] = [];

        data.iter(range, ([x, y]) => {
          const canvasX = (x - range.start) * xScale;
          const canvasY =
            yScaler.d2c(
              y as ChartViewModel.DataValue,
              yAxisDimension,
              yPadding,
            ) * self.scale;
          points.push({ x, y, canvasX, canvasY });
        });

        if (points.length === 0) return;

        // Group into continuous segments
        const segments: (typeof points)[] = [];
        let currentSegment: typeof points = [];

        for (const point of points) {
          if (
            currentSegment.length > 0 &&
            point.x !== currentSegment[currentSegment.length - 1].x + 1
          ) {
            // Gap in x values, start new segment
            if (currentSegment.length > 0) {
              segments.push(currentSegment);
            }
            currentSegment = [point];
          } else {
            currentSegment.push(point);
          }
        }

        if (currentSegment.length > 0) {
          segments.push(currentSegment);
        }

        // dev("FILL AREA RULES SEGmentS", segments);
        // Draw each segment
        for (const segment of segments) {
          if (segment.length === 0) continue;

          // Create clipped path for fill area
          self.c.save();

          // Set up clipping region
          self.c.beginPath();
          if (fillAbove) {
            // Clip to area above the rule
            self.c.rect(0, 0, width, ruleYScaled);
          } else {
            // Clip to area below the rule
            self.c.rect(0, ruleYScaled, width, size.height - ruleYScaled);
          }
          self.c.clip();

          // Draw the filled area with smooth curves
          self.c.beginPath();
          const firstPoint = segment[0];
          const lastPoint = segment[segment.length - 1];

          // Start from the rule at the first point's X position
          self.c.moveTo(firstPoint.canvasX, ruleYScaled);

          // Draw smooth curve through all points
          if (segment.length === 1) {
            // Single point - just draw straight lines
            self.c.lineTo(segment[0].canvasX, segment[0].canvasY);
          } else if (segment.length === 2) {
            // Two points - simple line
            self.c.lineTo(segment[0].canvasX, segment[0].canvasY);
            self.c.lineTo(segment[1].canvasX, segment[1].canvasY);
          } else {
            // Multiple points - use cubic Bezier curves
            // First point
            self.c.lineTo(segment[0].canvasX, segment[0].canvasY);

            // Use Catmull-Rom spline approach for smooth curves
            const tension = 0.5;
            for (let i = 0; i < segment.length - 1; i++) {
              const p0 = segment[Math.max(0, i - 1)];
              const p1 = segment[i];
              const p2 = segment[i + 1];
              const p3 = segment[Math.min(segment.length - 1, i + 2)];

              // Calculate tangent vectors
              const t1x = tension * (p2.canvasX - p0.canvasX);
              const t1y = tension * (p2.canvasY - p0.canvasY);
              const t2x = tension * (p3.canvasX - p1.canvasX);
              const t2y = tension * (p3.canvasY - p1.canvasY);

              // Control points
              const cp1x = p1.canvasX + t1x / 3;
              const cp1y = p1.canvasY + t1y / 3;
              const cp2x = p2.canvasX - t2x / 3;
              const cp2y = p2.canvasY - t2y / 3;

              self.c.bezierCurveTo(
                cp1x,
                cp1y,
                cp2x,
                cp2y,
                p2.canvasX,
                p2.canvasY,
              );
            }
          }

          // Return to the rule at the last point's X position
          self.c.lineTo(lastPoint.canvasX, ruleYScaled);

          self.c.closePath();
          self.c.fillStyle = fillStyle;
          self.c.fill();

          self.c.restore();
        }
      };

      // Determine which areas to fill based on direction and rule position
      if (fillDirection === "both") {
        createAreaPath(true);
        createAreaPath(false);
        return;
      }
      if (fillDirection === "above") {
        createAreaPath(true);
        return;
      }
      createAreaPath(false);
    },
    collectRegressionPoints(
      regression: RegressionData,
      range: NumRangeLike,
    ): (Point & { isInRange: boolean; density?: number; trust?: number })[] {
      const points: (Point & {
        isInRange: boolean;
        density?: number;
        trust?: number;
      })[] = [];

      // Collect points within the visible range
      const startX = Math.floor(range.start);
      const endX = Math.ceil(range.end);

      const hasDensity = "dataDensity" in regression && regression.dataDensity;
      const hasTrust = "trust" in regression && regression.trust;

      regression.data.iter({ start: startX, end: endX }, ([x, y]) => {
        const density = hasDensity
          ? (regression.dataDensity.get(x) ?? undefined)
          : undefined;
        const trust = hasTrust
          ? (regression.trust!.get(x) ?? undefined)
          : undefined;
        // Truncate at data boundaries — skip points with near-zero density
        if (density != null && density < 0.01) return;
        points.push({
          x,
          y,
          isInRange: true,
          ...(density !== undefined ? { density } : {}),
          ...(trust !== undefined ? { trust } : {}),
        });
      });

      // Add ONE previous point for smooth curve transition at the start —
      // but only if it's adjacent (within 2 units of the range start).
      // Otherwise the renderer draws a long line across an empty gap.
      const prevPoint = regression.data.getPreviousPoint(startX - 1);
      if (prevPoint) {
        const [x, y] = prevPoint;
        if (startX - x <= 2) {
          points.unshift({
            x,
            y,
            isInRange: false,
          });
        }
      }

      // Don't add a next point - just stop at the last visible point
      // This prevents arcing at the end of the curve

      return points;
    },
    drawRegressionCurve(
      range: NumRangeLike,
      yScaler: ChartViewModel.YScaler,
      regressionPoints: (Point & { isInRange: boolean; density?: number })[],
      yPadding: number,
      options: {
        curveColor?: string;
        curveWidth?: number;
      } = {},
    ) {
      if (regressionPoints.length === 0) return;

      const { width } = self.canvasSize;
      const rangeWidth = range.end - range.start;
      const xScale = width / rangeWidth;

      // When axes are swapped, data y-values map to horizontal (width)
      // When normal, data y-values map to vertical (height)
      const yAxisDimension = self.swapAxes
        ? self.domSize.width
        : self.domSize.height;

      // Include ALL points (including those outside the range) for smooth curves
      // that extend off-screen
      // Note: yScaler.d2c returns DOM coordinates, but we're in canvas space (inverted Y)
      // so we use it directly as the canvas Y coordinate
      const allCanvasPoints = regressionPoints.map((point) => ({
        x: (point.x - range.start) * xScale,
        y:
          yScaler.d2c(
            point.y as ChartViewModel.DataValue,
            yAxisDimension,
            yPadding,
          ) * self.scale, // Scale to canvas resolution
        isInRange: point.isInRange,
        density: point.density ?? 1, // Default to full density if not provided
      }));

      // Find start and end indices for the visible range
      const startIndex = allCanvasPoints.findIndex((p) => p.isInRange);
      const endIndex =
        allCanvasPoints.length -
        1 -
        [...allCanvasPoints].reverse().findIndex((p) => p.isInRange);

      if (startIndex === -1 || endIndex === -1) return;

      // Extend the indices to include adjacent off-screen points for smooth transitions
      const extendedStartIndex = Math.max(0, startIndex - 1);
      const extendedEndIndex = Math.min(
        allCanvasPoints.length - 1,
        endIndex + 1,
      );

      // Check if we have density information
      const hasDensityInfo = regressionPoints.some((p) => p.density != null);

      if (hasDensityInfo) {
        // Use density-aware rendering
        this.drawDensityAwareRegressionCurve(
          allCanvasPoints,
          extendedStartIndex,
          extendedEndIndex,
          options.curveColor ?? "#f59e0b",
          (options.curveWidth ?? 2) * self.scale,
        );
      } else {
        // Normal rendering without density information
        self.c.beginPath();
        this.drawSmoothCurveWithClipping(
          allCanvasPoints,
          extendedStartIndex,
          extendedEndIndex,
        );

        self.c.strokeStyle = options.curveColor ?? "#f59e0b";
        self.c.lineWidth = (options.curveWidth ?? 2) * self.scale;
        self.c.stroke();
      }
    },
    renderRegressionPoints(
      allCanvasPoints: (Point & { isInRange: boolean })[],
      startIndex: number,
      endIndex: number,
      options: {
        pointColor?: string;
        pointRadius?: number;
      } = {},
    ) {
      const pointRadius = (options.pointRadius ?? 3) * self.scale;
      self.c.fillStyle = options.pointColor ?? "#f59e0b";

      for (let i = startIndex; i <= endIndex; i++) {
        const point = allCanvasPoints[i];
        if (!point.isInRange) continue;

        self.c.beginPath();
        self.c.arc(point.x, point.y, pointRadius, 0, 2 * Math.PI);
        self.c.fill();
      }
    },
    drawSmoothCurve(points: Point[]) {
      if (points.length === 0) return;
      if (points.length === 1) {
        self.c.moveTo(points[0].x, points[0].y);
        return;
      }
      if (points.length === 2) {
        self.c.moveTo(points[0].x, points[0].y);
        self.c.lineTo(points[1].x, points[1].y);
        return;
      }

      self.c.moveTo(points[0].x, points[0].y);

      // Use cubic Bézier curves for smoother results
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        const { cp1, cp2 } = this.getCubicControlPoints(p0, p1, p2, p3, 0.25);

        self.c.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y);
      }
    },
    drawSmoothCurveWithClipping(
      allPoints: (Point & { isInRange: boolean; density?: number })[],
      startIndex: number,
      endIndex: number,
    ) {
      if (allPoints.length < 2) return;

      // Move to the first visible point
      self.c.moveTo(allPoints[startIndex].x, allPoints[startIndex].y);

      // Draw the curve segment by segment
      for (let i = startIndex; i < endIndex && i < allPoints.length - 1; i++) {
        const p0 = i > 0 ? allPoints[i - 1] : allPoints[i];
        const p1 = allPoints[i];
        const p2 = allPoints[i + 1];
        const p3 =
          i < allPoints.length - 2 ? allPoints[i + 2] : allPoints[i + 1];

        const { cp1, cp2 } = this.getCubicControlPoints(p0, p1, p2, p3, 0.2);

        self.c.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y);
      }
    },
    getControlPoint(
      prevPoint: { x: number; y: number },
      currentPoint: { x: number; y: number },
      nextPoint: { x: number; y: number },
      tension: number = 0.3,
    ): { x: number; y: number } {
      // Use Catmull-Rom inspired tangent calculation for smoother curves
      const dx = (nextPoint.x - prevPoint.x) * 0.5;
      const dy = (nextPoint.y - prevPoint.y) * 0.5;

      // Create control point that follows the natural curve direction
      return {
        x: currentPoint.x + dx * tension,
        y: currentPoint.y + dy * tension,
      };
    },
    getCubicControlPoints(
      p0: { x: number; y: number },
      p1: { x: number; y: number },
      p2: { x: number; y: number },
      p3: { x: number; y: number },
      tension: number = 0.25,
    ): {
      cp1: { x: number; y: number };
      cp2: { x: number; y: number };
    } {
      // Calculate tangent vectors using Catmull-Rom approach
      const t1x = (p2.x - p0.x) * tension;
      const t1y = (p2.y - p0.y) * tension;
      const t2x = (p3.x - p1.x) * tension;
      const t2y = (p3.y - p1.y) * tension;

      return {
        cp1: { x: p1.x + t1x, y: p1.y + t1y },
        cp2: { x: p2.x - t2x, y: p2.y - t2y },
      };
    },
    calculateAverageGap(points: Point[]): number {
      if (points.length < 2) return Number.POSITIVE_INFINITY;

      let totalGap = 0;
      for (let i = 1; i < points.length; i++) {
        totalGap += Math.abs(points[i].x - points[i - 1].x);
      }
      return totalGap / (points.length - 1);
    },
    drawFadedRegressionCurve(
      allPoints: (Point & { isInRange: boolean })[],
      startIndex: number,
      endIndex: number,
      color: string,
      lineWidth: number,
    ) {
      if (allPoints.length < 2) return;

      // Extract visible points
      const visiblePoints: (Point & { isInRange: boolean })[] = [];
      for (let i = startIndex; i <= endIndex; i++) {
        if (allPoints[i].isInRange) {
          visiblePoints.push(allPoints[i]);
        }
      }

      if (visiblePoints.length === 0) return;

      // Draw segments with fading at edges
      const segmentCount = Math.max(1, visiblePoints.length - 1);
      const fadeDistance = Math.min(3, Math.floor(segmentCount / 2));

      for (let i = 0; i < visiblePoints.length - 1; i++) {
        const p1 = visiblePoints[i];
        const p2 = visiblePoints[i + 1];

        // Calculate opacity based on distance from edges
        let opacity = 1.0;
        const distFromStart = i;
        const distFromEnd = visiblePoints.length - 2 - i;

        if (distFromStart < fadeDistance) {
          opacity = (distFromStart + 1) / (fadeDistance + 1);
        } else if (distFromEnd < fadeDistance) {
          opacity = (distFromEnd + 1) / (fadeDistance + 1);
        }

        // Parse color and apply opacity
        const rgbaColor = this.applyOpacityToColor(color, opacity);

        // Draw simple line segment (avoid bezier curves for sparse data)
        self.c.beginPath();
        self.c.moveTo(p1.x, p1.y);
        self.c.lineTo(p2.x, p2.y);
        self.c.strokeStyle = rgbaColor;
        self.c.lineWidth = lineWidth;
        self.c.stroke();
      }

      // Draw dots at data points for clarity
      const pointRadius = lineWidth * 0.8;
      for (const point of visiblePoints) {
        self.c.beginPath();
        self.c.arc(point.x, point.y, pointRadius, 0, 2 * Math.PI);
        self.c.fillStyle = color;
        self.c.fill();
      }
    },
    applyOpacityToColor(color: string, opacity: number): string {
      // Handle rgba format
      const rgbaMatch = color.match(
        /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/,
      );
      if (rgbaMatch) {
        const [, r, g, b, a] = rgbaMatch;
        const baseOpacity = a ? Number.parseFloat(a) : 1.0;
        return `rgba(${r}, ${g}, ${b}, ${baseOpacity * opacity})`;
      }

      // Handle hex format
      const hexMatch = color.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);
      if (hexMatch) {
        let hex = hexMatch[1];
        if (hex.length === 3) {
          hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        const r = Number.parseInt(hex.substr(0, 2), 16);
        const g = Number.parseInt(hex.substr(2, 2), 16);
        const b = Number.parseInt(hex.substr(4, 2), 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
      }

      // Fallback: return original color with reduced opacity via rgba
      return `rgba(245, 158, 11, ${opacity * 0.5})`;
    },
    drawDensityAwareRegressionCurve(
      allPoints: (Point & {
        isInRange: boolean;
        density?: number;
      })[],
      startIndex: number,
      endIndex: number,
      color: string,
      lineWidth: number,
    ) {
      if (allPoints.length < 2) return;

      // Cull first and last segments if they have extremely low density
      // This avoids wild shooting off at the edges of sparse data
      let effectiveStartIndex = startIndex;
      let effectiveEndIndex = endIndex;

      // Check if first segment has very low density
      if (startIndex < allPoints.length - 1) {
        const firstDensity = Math.min(
          allPoints[startIndex].density ?? 1,
          allPoints[startIndex + 1].density ?? 1,
        );
        if (firstDensity < 0.01) {
          effectiveStartIndex = Math.min(startIndex + 1, endIndex - 1);
        }
      }

      // Check if last segment has very low density
      if (endIndex > 0 && endIndex - 1 < allPoints.length - 1) {
        const lastDensity = Math.min(
          allPoints[endIndex - 1].density ?? 1,
          allPoints[endIndex].density ?? 1,
        );
        if (lastDensity < 0.01) {
          effectiveEndIndex = Math.max(endIndex - 1, effectiveStartIndex + 1);
        }
      }

      // Compute median x-spacing to detect gaps between segments
      let medianXGap = 0;
      if (effectiveEndIndex - effectiveStartIndex >= 2) {
        const xGaps: number[] = [];
        for (let i = effectiveStartIndex; i < effectiveEndIndex && i < allPoints.length - 1; i++) {
          xGaps.push(Math.abs(allPoints[i + 1].x - allPoints[i].x));
        }
        xGaps.sort((a, b) => a - b);
        medianXGap = xGaps[Math.floor(xGaps.length / 2)] || 0;
      }
      const gapThreshold = medianXGap * 5; // 5x median spacing = segment break

      // Draw curve in segments with opacity based on data density
      for (let i = effectiveStartIndex; i < effectiveEndIndex; i++) {
        if (i >= allPoints.length - 1) break;

        const p1 = allPoints[i];
        const p2 = allPoints[i + 1];

        // Skip segments that span a gap between regression segments
        const xGap = Math.abs(p2.x - p1.x);
        if (gapThreshold > 0 && xGap > gapThreshold) continue;

        // Calculate segment opacity based on minimum density of the two points
        const segmentDensity = Math.min(p1.density ?? 1, p2.density ?? 1);

        // Apply smoothstep function for better fading
        // Lower thresholds: fade from 0.01 (1% density) to 0.2 (20% density)
        const opacity = this.smoothstep(0.01, 0.2, segmentDensity);

        // Skip segments with extremely low density to avoid convergence artifacts
        if (opacity < 0.01) continue;

        // Get neighboring points for bezier curve — but don't reach across gaps.
        // If the neighbor is across a gap, substitute the current endpoint
        // so the curve approaches the segment boundary linearly.
        const prevGap = i > 0 ? Math.abs(p1.x - allPoints[i - 1].x) : Infinity;
        const nextGap = i < allPoints.length - 2 ? Math.abs(allPoints[i + 2].x - p2.x) : Infinity;
        const p0 = i > 0 && prevGap <= gapThreshold ? allPoints[i - 1] : p1;
        const p3 = i < allPoints.length - 2 && nextGap <= gapThreshold ? allPoints[i + 2] : p2;

        // Calculate control points with additional sanity checks
        const { cp1, cp2 } = this.getCubicControlPoints(p0, p1, p2, p3, 0.2);

        // Sanity check: if control points are too far from the actual points,
        // use linear interpolation instead to avoid wild curves
        const maxDistance = Math.abs(p2.x - p1.x) * 10; // Allow 10x the horizontal distance
        const cp1Distance = Math.sqrt(
          Math.pow(cp1.x - p1.x, 2) + Math.pow(cp1.y - p1.y, 2),
        );
        const cp2Distance = Math.sqrt(
          Math.pow(cp2.x - p2.x, 2) + Math.pow(cp2.y - p2.y, 2),
        );

        self.c.beginPath();
        self.c.moveTo(p1.x, p1.y);

        if (cp1Distance > maxDistance || cp2Distance > maxDistance) {
          // Use simple line instead of bezier for wild control points
          self.c.lineTo(p2.x, p2.y);
        } else {
          // Use bezier curve for smooth segments
          self.c.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y);
        }

        self.c.strokeStyle = this.applyOpacityToColor(color, opacity);
        self.c.lineWidth = lineWidth;
        self.c.stroke();
      }
    },
    smoothstep(edge0: number, edge1: number, x: number): number {
      // Clamp x to [0, 1]
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      // Smooth interpolation
      return t * t * (3 - 2 * t);
    },
    renderConfidenceBand(
      range: NumRangeLike,
      regression: RegressionData,
      yScaler: ChartViewModel.YScaler,
      yPadding: number,
      options: {
        renderBand?: boolean;
        renderConfidencePoints?: boolean;
        renderBoundaryPoints?: boolean;
        bandColor?: string;
        confidencePointColor?: string;
        boundaryPointColor?: string;
      } = {},
    ) {
      if (!regression.range) return;

      const validPoints = self.canvasSpace.collectConfidencePoints(
        regression,
        range,
      );
      if (validPoints.length === 0) return;

      self.canvasSpace.drawConfidenceBand(
        range,
        validPoints,
        yScaler,
        yPadding,
        options,
      );
    },
    collectConfidencePoints(
      regression: RegressionData,
      range: NumRangeLike,
    ): (Point & { conf: number; density: number; isInRange: boolean })[] {
      const points: (Point & {
        conf: number;
        density: number;
        isInRange: boolean;
      })[] = [];
      const paddedStart = Math.max(0, range.start - regression.padding);
      const validEnd = regression.range?.end ?? range.end;
      const paddedEnd = Math.min(validEnd, range.end + regression.padding);

      if (paddedEnd < paddedStart) {
        return points;
      }

      const hasDensity =
        "dataDensity" in regression && regression.dataDensity;

      // Collect data, confidence, and density values
      const dataMap = new Map<number, number>();
      const confMap = new Map<number, number>();
      const densityMap = new Map<number, number>();

      regression.data.iter({ start: paddedStart, end: paddedEnd }, ([x, y]) => {
        dataMap.set(x, y);
      });

      regression.confidence.iter(
        { start: paddedStart, end: paddedEnd },
        ([x, conf]) => {
          confMap.set(x, conf);
        },
      );

      if (hasDensity) {
        regression.dataDensity!.iter(
          { start: paddedStart, end: paddedEnd },
          ([x, d]) => {
            densityMap.set(x, d);
          },
        );
      }

      // Combine points — skip where density is near zero (truncation)
      for (const [x, y] of dataMap) {
        const conf = confMap.get(x);
        if (conf == null) continue;
        const density = hasDensity ? (densityMap.get(x) ?? 0) : 1;
        if (density < 0.01) continue; // truncate at data boundaries
        points.push({
          x,
          y,
          conf,
          density,
          isInRange: x >= range.start && x <= range.end,
        });
      }
      return points;
    },
    drawConfidenceBand(
      range: NumRangeLike,
      validPoints: (Point & {
        conf: number;
        density: number;
        isInRange: boolean;
      })[],
      yScaler: ChartViewModel.YScaler,
      yPadding: number,
      options: {
        renderBand?: boolean;
        renderConfidencePoints?: boolean;
        renderBoundaryPoints?: boolean;
        bandColor?: string;
        confidencePointColor?: string;
        boundaryPointColor?: string;
      } = {},
    ) {
      if (validPoints.length === 0) return;

      // Filter to only visible points, then split at large gaps
      const allVisible = validPoints.filter((p) => p.isInRange);
      if (allVisible.length === 0) return;

      // Detect gap threshold from median x-spacing
      let gapThreshold = Infinity;
      if (allVisible.length >= 3) {
        const xGaps: number[] = [];
        for (let i = 0; i < allVisible.length - 1; i++) {
          xGaps.push(allVisible[i + 1].x - allVisible[i].x);
        }
        xGaps.sort((a, b) => a - b);
        gapThreshold = (xGaps[Math.floor(xGaps.length / 2)] || 1) * 5;
      }

      // Split into gap-free segments
      const segments: typeof allVisible[] = [];
      let seg: typeof allVisible = [allVisible[0]];
      for (let i = 1; i < allVisible.length; i++) {
        if (allVisible[i].x - allVisible[i - 1].x > gapThreshold) {
          segments.push(seg);
          seg = [];
        }
        seg.push(allVisible[i]);
      }
      if (seg.length > 0) segments.push(seg);

      // Draw each segment's band independently
      for (const visiblePoints of segments) {
        if (visiblePoints.length < 2) continue;
        this._drawConfidenceBandSegment(range, visiblePoints, yScaler, yPadding, options);
      }

      // Render confidence/boundary points across all segments
      if (options.renderConfidencePoints === true) {
        this.renderConfidencePoints(allVisible, range, yScaler, yPadding, {
          ...(options.confidencePointColor !== undefined
            ? { pointColor: options.confidencePointColor }
            : {}),
        });
      }
      if (options.renderBoundaryPoints === true) {
        this.renderConfidenceBoundaryPoints(allVisible, range, yScaler, yPadding, {
          ...(options.boundaryPointColor !== undefined
            ? { pointColor: options.boundaryPointColor }
            : {}),
        });
      }
    },
    /** @internal Draw confidence band for a single gap-free segment. */
    _drawConfidenceBandSegment(
      range: NumRangeLike,
      visiblePoints: (Point & { conf: number; density: number; isInRange: boolean })[],
      yScaler: ChartViewModel.YScaler,
      yPadding: number,
      options: {
        renderBand?: boolean;
        renderConfidencePoints?: boolean;
        renderBoundaryPoints?: boolean;
        bandColor?: string;
        confidencePointColor?: string;
        boundaryPointColor?: string;
      },
    ) {
      if (visiblePoints.length < 2) return;

      const { width } = self.canvasSize;
      const rangeWidth = range.end - range.start;
      const xScale = width / rangeWidth;

      // When axes are swapped, data y-values map to horizontal (width)
      // When normal, data y-values map to vertical (height)
      const yAxisDimension = self.swapAxes
        ? self.domSize.width
        : self.domSize.height;

      // Scale confidence by inverse density — bands widen where data is sparse
      const upperPoints = visiblePoints.map((point) => {
        const scaledConf = point.conf / Math.max(point.density, 0.15);
        return {
          x: (point.x - range.start) * xScale,
          y:
            yScaler.d2c(
              (point.y + scaledConf) as ChartViewModel.DataValue,
              yAxisDimension,
              yPadding,
            ) * self.scale,
          isInRange: true,
        };
      });

      const lowerPoints = visiblePoints
        .map((point) => {
          const scaledConf = point.conf / Math.max(point.density, 0.15);
          return {
            x: (point.x - range.start) * xScale,
            y:
              yScaler.d2c(
                (point.y - scaledConf) as ChartViewModel.DataValue,
                yAxisDimension,
                yPadding,
              ) * self.scale,
            isInRange: true,
          };
        })
        .reverse();

      // Find visible range for clipping
      const upperStartIndex = upperPoints.findIndex((p) => p.isInRange);
      const upperEndIndex =
        upperPoints.length -
        1 -
        [...upperPoints].reverse().findIndex((p) => p.isInRange);
      const lowerStartIndex = lowerPoints.findIndex((p) => p.isInRange);
      const lowerEndIndex =
        lowerPoints.length -
        1 -
        [...lowerPoints].reverse().findIndex((p) => p.isInRange);

      if (
        upperStartIndex === -1 ||
        upperEndIndex === -1 ||
        lowerStartIndex === -1 ||
        lowerEndIndex === -1
      )
        return;

      // Render confidence band if requested
      if (options.renderBand !== false) {
        self.c.beginPath();

        // Draw smooth upper bound with clipping
        this.drawSmoothCurveWithClipping(
          upperPoints,
          upperStartIndex,
          upperEndIndex,
        );

        // Connect to lower bound
        if (lowerPoints.length > 0) {
          self.c.lineTo(
            lowerPoints[lowerStartIndex].x,
            lowerPoints[lowerStartIndex].y,
          );
          this.drawSmoothCurveFromCurrentPositionWithClipping(
            lowerPoints,
            lowerStartIndex + 1,
            lowerEndIndex,
          );
        }

        self.c.closePath();
        // Fade band opacity by average density of visible points
        const avgDensity =
          visiblePoints.reduce((s, p) => s + p.density, 0) /
          visiblePoints.length;
        const prevAlpha = self.c.globalAlpha;
        self.c.globalAlpha = self.canvasSpace.smoothstep(0.05, 0.5, avgDensity);
        self.c.fillStyle = options.bandColor ?? "rgba(245, 158, 11, 0.1)";
        self.c.fill();
        self.c.globalAlpha = prevAlpha;
      }

    },
    renderConfidencePoints(
      validPoints: (Point & { isInRange: boolean; conf: number })[],
      range: NumRangeLike,
      yScaler: ChartViewModel.YScaler,
      yPadding: number,
      options: {
        pointColor?: string;
        pointRadius?: number;
      } = {},
    ) {
      const { width } = self.canvasSize;
      const rangeWidth = range.end - range.start;
      const xScale = width / rangeWidth;
      const pointRadius = (options.pointRadius ?? 2) * self.scale;

      // When axes are swapped, data y-values map to horizontal (width)
      // When normal, data y-values map to vertical (height)
      const yAxisDimension = self.swapAxes
        ? self.domSize.width
        : self.domSize.height;

      // Render confidence band center points
      self.c.fillStyle = options.pointColor ?? "rgba(245, 158, 11, 0.8)";

      for (const point of validPoints) {
        if (!point.isInRange) continue;

        const canvasX = (point.x - range.start) * xScale;
        const canvasY =
          yScaler.d2c(
            point.y as ChartViewModel.DataValue,
            yAxisDimension,
            yPadding,
          ) * self.scale;

        self.c.beginPath();
        self.c.arc(canvasX, canvasY, pointRadius, 0, 2 * Math.PI);
        self.c.fill();
      }
    },
    renderConfidenceBoundaryPoints(
      validPoints: (Point & { isInRange: boolean; conf: number })[],
      range: NumRangeLike,
      yScaler: ChartViewModel.YScaler,
      yPadding: number,
      options: {
        pointColor?: string;
        pointRadius?: number;
      } = {},
    ) {
      const { width } = self.canvasSize;
      const rangeWidth = range.end - range.start;
      const xScale = width / rangeWidth;
      const pointRadius = (options.pointRadius ?? 1.5) * self.scale;

      // When axes are swapped, data y-values map to horizontal (width)
      // When normal, data y-values map to vertical (height)
      const yAxisDimension = self.swapAxes
        ? self.domSize.width
        : self.domSize.height;

      // Render upper confidence boundary points
      self.c.fillStyle = options.pointColor ?? "rgba(245, 158, 11, 0.6)";
      for (const point of validPoints) {
        if (!point.isInRange) continue;

        const canvasX = (point.x - range.start) * xScale;
        const upperY =
          yScaler.d2c(
            (point.y + point.conf) as ChartViewModel.DataValue,
            yAxisDimension,
            yPadding,
          ) * self.scale;

        self.c.beginPath();
        self.c.arc(canvasX, upperY, pointRadius, 0, 2 * Math.PI);
        self.c.fill();
      }

      // Render lower confidence boundary points
      self.c.fillStyle = options.pointColor ?? "rgba(245, 158, 11, 0.4)";
      for (const point of validPoints) {
        if (!point.isInRange) continue;

        const canvasX = (point.x - range.start) * xScale;
        const lowerY =
          yScaler.d2c(
            (point.y - point.conf) as ChartViewModel.DataValue,
            yAxisDimension,
            yPadding,
          ) * self.scale;

        self.c.beginPath();
        self.c.arc(canvasX, lowerY, pointRadius, 0, 2 * Math.PI);
        self.c.fill();
      }
    },
    drawSmoothCurveFromCurrentPositionWithClipping(
      points: (Point & { isInRange: boolean })[],
      startIndex: number,
      endIndex: number,
    ) {
      if (points.length === 0 || startIndex >= points.length) return;

      // Use cubic Bézier curves for better smoothness
      const actualStartIndex = Math.max(0, startIndex - 1);
      const actualEndIndex = Math.min(points.length - 1, endIndex + 1);

      for (let i = startIndex; i < Math.min(endIndex, points.length - 1); i++) {
        const p0 = points[Math.max(actualStartIndex, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(actualEndIndex, i + 2)];

        const { cp1, cp2 } = this.getCubicControlPoints(p0, p1, p2, p3, 0.15);

        self.c.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y);
      }
    },
    drawSmoothCurveFromCurrentPosition(points: Point[]) {
      if (points.length === 0) return;
      if (points.length === 1) {
        self.c.lineTo(points[0].x, points[0].y);
        return;
      }

      // Continue with smooth curve for remaining points
      for (let i = 0; i < points.length - 1; i++) {
        const currentPoint = points[i];
        const nextPoint = points[i + 1];
        const prevPoint = i > 0 ? points[i - 1] : currentPoint;
        const nextNextPoint = i < points.length - 2 ? points[i + 2] : nextPoint;

        const controlPoint = this.getControlPoint(
          prevPoint,
          currentPoint,
          nextNextPoint,
          0.2, // Lower tension for confidence bands
        );

        self.c.quadraticCurveTo(
          controlPoint.x,
          controlPoint.y,
          nextPoint.x,
          nextPoint.y,
        );
      }
    },
    interpolateRegressionValue(x: number, points: Point[]): number | null {
      if (points.length === 0) return null;

      const { leftPoint, rightPoint } = self.canvasSpace.findBoundingPoints(
        x,
        points,
      );

      // Exact match
      if (leftPoint?.x === x) return leftPoint.y;
      if (rightPoint?.x === x) return rightPoint.y;

      // Linear interpolation
      if (leftPoint && rightPoint && leftPoint.x !== rightPoint.x) {
        const t = (x - leftPoint.x) / (rightPoint.x - leftPoint.x);
        return leftPoint.y + t * (rightPoint.y - leftPoint.y);
      }

      // Extrapolation (use nearest point)
      return leftPoint?.y ?? rightPoint?.y ?? null;
    },
    findBoundingPoints(
      x: number,
      points: Point[],
    ): {
      leftPoint: Option<Point>;
      rightPoint: Option<Point>;
    } {
      let leftPoint: Option<Point>;
      let rightPoint: Option<Point>;

      for (const point of points) {
        if (point.x <= x && (!leftPoint || point.x > leftPoint.x)) {
          leftPoint = point;
        }
        if (point.x >= x && (!rightPoint || point.x < rightPoint.x)) {
          rightPoint = point;
        }
      }

      return { leftPoint, rightPoint };
    },
  }))(this);
}
