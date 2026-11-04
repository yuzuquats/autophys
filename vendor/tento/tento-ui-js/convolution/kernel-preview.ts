import "../components/round";

import { component } from "../component-decorators";
import { css } from "../component-styles";
import { html, LonaWebComponent } from "../component";
import { LonaCanvasContext } from "../ui/extended-canvas-context";
import { KernelFunction } from "./kernels";
import { Round } from "../components/round";

@component({
  name: "std-kernel-preview",
})
export class KernelPreview extends LonaWebComponent {
  private $round: Round = this.hydrate<Round>("round").bind({
    ...Round.Props.FLAT_CARD,
    bg: "var(--bg)",
  });
  private $canvas: HTMLCanvasElement = this.hydrate("canvas");
  private canvasContext: Option<LonaCanvasContext> = new LonaCanvasContext(
    this.$canvas,
  );

  private kernelFn: Option<KernelFunction>;
  private halfWidth: number = 100;
  private debug: boolean = false;
  private color: string = "var(--blue)";
  private dirty: boolean = false;

  onSizeChange = (size: Size) => {
    if (this.canvasContext && size.width > 0 && size.height > 0) {
      this.canvasContext.setDomSize(size);
      this.render();
    }
  };

  bind(props: KernelPreview.Props) {
    this.kernelFn = props.kernelFn;
    this.halfWidth = props.halfWidth ?? 100;
    this.debug = props.debug ?? false;
    this.color = props.color ?? "var(--blue)";
    this.bindTitle(this.debug ? props.title : undefined);
    this.dirty = true;
    if (this.isConnected) {
      this.render();
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.dirty) return;
    this.render();
  }

  bindTitle(title: Option<string>) {
    const $title = this.$("title");
    $title.textContent = title ?? "";
    $title.style.display = title ? "block" : "none";
  }

  private render(): void {
    this.dirty = false;
    if (!this.canvasContext || !this.kernelFn) return;

    const ctx = this.canvasContext;
    ctx.canvasSpace.init(false);
    ctx.clear();

    const padding = 50 * ctx.scale;
    const xRange = { start: -this.halfWidth, end: this.halfWidth };

    const points: { x: number; y: number }[] = [];
    const samples = 200;
    let maxY = 0;

    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const x = xRange.start + t * (xRange.end - xRange.start);
      const y = this.kernelFn(x);
      points.push({ x, y });
      maxY = Math.max(maxY, y);
    }

    const plotWidth = ctx.size.width - 2 * padding;
    const plotHeight = ctx.size.height - 2 * padding;
    const yScale = plotHeight / maxY;
    const xScale = plotWidth / (xRange.end - xRange.start);

    const canvasPoints = points.map((p) => ({
      x: padding + (p.x - xRange.start) * xScale,
      y: padding + p.y * yScale,
    }));

    const plotParams = { ctx, padding, xRange, xScale, yScale, maxY };

    if (this.debug) {
      this.renderAxes(plotParams);
    }
    this.renderGraph(ctx, canvasPoints);
    if (this.debug) {
      this.renderDataPoints(ctx, canvasPoints);
      this.renderLabels(plotParams);
    }
  }

  private renderAxes(params: {
    ctx: LonaCanvasContext;
    padding: number;
    xRange: { start: number; end: number };
    xScale: number;
  }): void {
    const { ctx, padding, xRange, xScale } = params;
    const canvasWidth = ctx.size.width;
    const canvasHeight = ctx.size.height;

    ctx.c.strokeStyle = "rgba(0, 0, 0, 0.3)";
    ctx.c.lineWidth = 1 * ctx.scale;

    const zeroX = padding + (0 - xRange.start) * xScale;
    ctx.c.beginPath();
    ctx.c.moveTo(zeroX, padding);
    ctx.c.lineTo(zeroX, canvasHeight - padding);
    ctx.c.stroke();

    ctx.c.beginPath();
    ctx.c.moveTo(padding, padding);
    ctx.c.lineTo(canvasWidth - padding, padding);
    ctx.c.stroke();
  }

  private resolveColor(color: string): string {
    this.$canvas.style.color = color;
    return getComputedStyle(this.$canvas).color;
  }

  private colorToRgba(color: string, alpha: number): string {
    const resolved = this.resolveColor(color);
    const match = resolved.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (match) {
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
    }
    const rgbaMatch = resolved.match(
      /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)$/,
    );
    if (rgbaMatch) {
      return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${alpha})`;
    }
    return resolved;
  }

  private renderGraph(
    ctx: LonaCanvasContext,
    canvasPoints: { x: number; y: number }[],
  ): void {
    if (canvasPoints.length === 0) return;

    const firstPoint = canvasPoints[0];
    const lastPoint = canvasPoints[canvasPoints.length - 1];

    const maxY = Math.max(...canvasPoints.map((p) => p.y));
    const minY = Math.min(firstPoint.y, lastPoint.y);

    const gradient = ctx.c.createLinearGradient(0, maxY, 0, minY);
    gradient.addColorStop(0, this.colorToRgba(this.color, 0.3));
    gradient.addColorStop(1, this.colorToRgba(this.color, 0));

    ctx.c.beginPath();
    ctx.c.moveTo(firstPoint.x, firstPoint.y);
    for (let i = 1; i < canvasPoints.length; i++) {
      ctx.c.lineTo(canvasPoints[i].x, canvasPoints[i].y);
    }
    ctx.c.lineTo(lastPoint.x, minY);
    ctx.c.lineTo(firstPoint.x, minY);
    ctx.c.closePath();
    ctx.c.fillStyle = gradient;
    ctx.c.fill();

    ctx.c.strokeStyle = this.resolveColor(this.color);
    ctx.c.lineWidth = 2 * ctx.scale;
    ctx.c.beginPath();
    for (const [i, point] of canvasPoints.entries()) {
      if (i === 0) {
        ctx.c.moveTo(point.x, point.y);
      } else {
        ctx.c.lineTo(point.x, point.y);
      }
    }
    ctx.c.stroke();
  }

  private renderDataPoints(
    ctx: LonaCanvasContext,
    canvasPoints: { x: number; y: number }[],
  ): void {
    const savedTransform = ctx.c.getTransform();
    ctx.c.setTransform(1, 0, 0, 1, 0, 0);

    ctx.c.fillStyle = "#ff6b35";
    for (let i = 0; i < canvasPoints.length; i += 10) {
      const point = canvasPoints[i];
      const screenY = ctx.size.height - point.y;
      ctx.c.beginPath();
      ctx.c.arc(point.x, screenY, 3 * ctx.scale, 0, 2 * Math.PI);
      ctx.c.fill();
    }

    ctx.c.setTransform(savedTransform);
  }

  private renderLabels(params: {
    ctx: LonaCanvasContext;
    padding: number;
    xRange: { start: number; end: number };
    xScale: number;
    yScale: number;
    maxY: number;
  }): void {
    const { ctx, padding, xRange, xScale, yScale, maxY } = params;

    const savedTransform = ctx.c.getTransform();
    ctx.c.setTransform(1, 0, 0, 1, 0, 0);

    ctx.c.fillStyle = "var(--text-sec)";
    ctx.c.font = `${10 * ctx.scale}px sans-serif`;

    const xLabels = [
      { x: -this.halfWidth, label: `-${this.halfWidth}` },
      { x: 0, label: "0" },
      { x: this.halfWidth, label: `${this.halfWidth}` },
    ];

    ctx.c.textAlign = "center";
    ctx.c.textBaseline = "top";
    for (const { x, label } of xLabels) {
      const canvasX = padding + (x - xRange.start) * xScale;
      ctx.c.fillText(label, canvasX, ctx.size.height - padding + 5 * ctx.scale);
    }

    const yLabels = [
      { y: 0, label: "0" },
      { y: maxY * 0.5, label: (maxY * 0.5).toFixed(2) },
      { y: maxY, label: maxY.toFixed(2) },
    ];

    ctx.c.textAlign = "right";
    ctx.c.textBaseline = "middle";
    for (const { y, label } of yLabels) {
      const canvasY = ctx.size.height - (padding + y * yScale);
      ctx.c.fillText(label, padding - 5 * ctx.scale, canvasY);
    }

    ctx.c.setTransform(savedTransform);
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
        min-height: 200px;
      }

      #round {
        width: 100%;
        height: 100%;
        position: relative;
      }

      #title {
        position: absolute;
        top: 10px;
        left: 0;
        right: 0;
        text-align: center;
        font-size: var(--text-12px);
        color: var(--text-pri);
        pointer-events: none;
        z-index: 1;
      }

      #canvas {
        width: 100%;
        height: 100%;
      }
    `,
  ];

  static $html = html`
    <std-round id="round">
      <p id="title"></p>
      <canvas id="canvas"></canvas>
    </std-round>
  `;
}

export namespace KernelPreview {
  export type Props = {
    kernelFn: KernelFunction;
    halfWidth?: number;
    title?: string;
    // Consumed by KernelPicker's description panel (not by the preview itself).
    description?: string;
    debug?: boolean;
    color?: string;
  };
}
